import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createBridge, parseAnswer, PASSIVE_WINDOW_MS, QQ_ORIGIN_MARKER, questionKeyboard, questionText, questionWindowMs,
  replyTargetFor,
} from '../src/bridge.js';
import { createStateStore } from '../src/state.js';

const text = (value) => ({ type: 'text', text: value });

const settle = () => new Promise((resolve) => setTimeout(resolve, 2));

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error('condition never became true');
}

async function fixture(t, { workspace, failMarkdown = false, agentsRunning = false, holdPrompt = false, holdMarkdown = false, failKeyboard = false, stream = false, failStream = false, endReason = { kind: 'completed' }, noAnswer = false, sessions = [], answer = 'Answer' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-qq-bot-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await createStateStore(join(root, 'state.json')).load();
  const sent = [];
  const markdown = [];
  const keyboards = [];
  const acks = [];
  const recalls = [];
  const streams = [];
  const streamUpdates = [];
  const created = [];
  const prompts = [];
  const listeners = new Set();
  let releasePending = null;
  let releaseMarkdown = null;
  let markdownHeld = false;
  const agentStatus = () => (agentsRunning ? { status: 'running' } : null);
  const ctx = {
    get: (key) => (key === 'workspaceRegistry'
      ? { resolveByPath: async () => workspace, create: async () => workspace }
      : key === 'agents' ? { get: () => agentStatus() }
        : key === 'sessionController' ? ctx.sessionController : undefined),
    sessionController: {
      async create(request) { created.push(request); return { sessionId: 'session-new' }; },
      async list() { return { items: sessions }; },
      async prompt(request) {
        prompts.push(request);
        // Answer the way the Host would: the prompt's own request id owns a turn.
        const turn = Math.max(1, prompts.length);
        const emit = () => {
          queueMicrotask(() => {
            for (const listener of [...listeners]) {
              listener({ id: request.sessionId }, { seq: 1, type: 'user/message', data: { turn, source: { kind: 'user', rpcId: request.requestId } } });
              listener({ id: request.sessionId }, { seq: 2, type: 'assistant/message', data: { turn, step: 0, message: { content: [{ type: 'reasoning', text: 'secret' }, text('Checking'), { type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' }] } } });
              listener({ id: request.sessionId }, { seq: 3, type: 'tool/call', data: { turn, step: 0, callId: 'c', name: 'bash', arguments: '{}' } });
              if (!noAnswer) listener({ id: request.sessionId }, { seq: 4, type: 'assistant/message', data: { turn, step: 1, message: { content: [text(answer)] } } });
              listener({ id: request.sessionId }, { seq: 5, type: 'turn/end', data: { turn, reason: endReason } });
            }
          });
        };
        if (holdPrompt) {
          await new Promise((resolve) => { releasePending = () => { resolve(); emit(); }; });
          return;
        }
        emit();
      },
    },
    on(event, handler) {
      assert.equal(event, 'session/event');
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  // Both send paths render the question, so the hold covers either one.
  const gateMarkdown = async () => {
    if (holdMarkdown && !markdownHeld) {
      markdownHeld = true;
      await new Promise((resolve) => { releaseMarkdown = resolve; });
    }
  };
  const runtime = {
    ready: true,
    status: { ready: true, state: 'connected', lastError: null },
    async sendText(target, value) { sent.push(value); },
    async sendMarkdown(target, value) {
      if (failMarkdown) throw new Error('markdown rejected');
      await gateMarkdown();
      markdown.push(value);
    },
    // The button path still shows the question text; it is recorded in markdown
    // so the existing assertions keep describing what the user reads.
    async sendKeyboard(target, value, keyboard) {
      if (failKeyboard) throw new Error('keyboard rejected');
      await gateMarkdown();
      markdown.push(value);
      keyboards.push(keyboard);
      return { id: `kb-${keyboards.length}` };
    },
    async acknowledgeInteraction(id, code) { acks.push([id, code]); },
    async recallMessage(target, messageId) { recalls.push(messageId); },
  };
  if (stream) {
    runtime.openStream = (target) => {
      const session = {
        target,
        updates: [],
        async update(value) {
          if (failStream) throw new Error('stream rejected');
          this.updates.push(value);
          streamUpdates.push(value);
        },
        async complete() { this.done = true; return { id: 'stream-1' }; },
        cancel() { this.cancelled = true; },
      };
      streams.push(session);
      return session;
    };
  }
  const bridge = createBridge({
    runtime, state, ctx,
    settings: { workspace: 'C:\\workspace', replyTimeoutMs: 1_000 },
    logger: { warn: () => {} },
    streamReplies: () => stream,
  });
  const message = (overrides = {}) => ({
    kind: 'c2c', senderId: 'openid-a', senderIsBot: false, messageId: 'm-1',
    content: 'hello', replyTarget: { scope: 'c2c', targetId: 'openid-a', msgId: 'm-1' },
    ...overrides,
  });
  return {
    state, sent, markdown, keyboards, acks, recalls, streams, streamUpdates, created, prompts, bridge, message,
    release: () => releasePending?.(),
    releaseMarkdown: () => releaseMarkdown?.(),
  };
}

test('the first private message claims the owner and an unbound chat is told how to bind', async (t) => {
  const { state, sent, bridge, message } = await fixture(t);
  await bridge.accept(message());
  assert.equal(state.ownerOpenId, 'openid-a');
  assert.deepEqual(state.target, { scope: 'c2c', targetId: 'openid-a' });
  assert.equal(state.hasSeen('m-1'), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /还没有绑定会话/);
});

test('other users, group chats, bots, and redelivered ids are ignored', async (t) => {
  const { sent, bridge, message } = await fixture(t);
  await bridge.accept(message({ messageId: 'm-0' })); // claims the owner
  sent.length = 0;

  await bridge.accept(message({ messageId: 'm-2', senderId: 'openid-b' }));
  assert.equal(sent[0], '这个 QQ 机器人已绑定其他用户，无法使用。');

  await bridge.accept(message({ messageId: 'm-3', kind: 'group' }));
  await bridge.accept(message({ messageId: 'm-4', senderIsBot: true }));
  await bridge.accept(message({ messageId: 'm-0' })); // already handled
  assert.equal(sent.length, 1);
});

test('/help and /status answer as markdown without touching the bound session', async (t) => {
  const { markdown, bridge, message } = await fixture(t);
  await bridge.accept(message({ messageId: 'm-1', content: '/help' }));
  assert.match(markdown[0], /^(\*\*QQ 机器人命令\*\*)/u);
  assert.match(markdown[0], /`\/bind`/u);
  await bridge.accept(message({ messageId: 'm-2', content: '/status' }));
  assert.match(markdown[1], /连接：\*\*已连接\*\*/u);
  assert.match(markdown[1], /绑定会话：`无`/u);
});

test('/bind new creates a session in the default workspace and binds it', async (t) => {
  const { state, markdown, created, bridge, message } = await fixture(t);
  await bridge.accept(message({ messageId: 'm-1', content: '/bind new' }));
  assert.deepEqual(created, [{ cwd: 'C:\\workspace' }]);
  assert.equal(state.sessionId, 'session-new');
  assert.match(markdown[0], /会话：`session-new`/u);
});

test('/bind without an argument lists the workspace sessions and marks the bound one', async (t) => {
  const sessions = [
    { sessionId: 's-1', cwd: 'C:\\workspace', updatedAt: '2026-10-24T10:00:00Z', projections: { values: { title: '第一个' } } },
    { sessionId: 's-2', cwd: 'C:\\workspace', updatedAt: '2026-10-24T11:00:00Z', projections: { values: { title: '第二个' } } },
  ];
  const { markdown, state, bridge, message } = await fixture(t, { sessions });
  await state.setSession('s-1');
  await bridge.accept(message({ messageId: 'm-1', content: '/bind' }));
  assert.match(markdown[0], /可绑定会话/u);
  assert.match(markdown[0], /第一个/u);
  assert.match(markdown[0], /第二个/u);
  assert.match(markdown[0], /当前/u);
  assert.match(markdown[0], /\/bind <会话ID>/u);
});

test('/bind <id> switches the bound session and an unknown id explains the list', async (t) => {
  const sessions = [
    { sessionId: 's-1', cwd: 'C:\\workspace', updatedAt: '2026-10-24T10:00:00Z', projections: { values: { title: '第一个' } } },
    { sessionId: 's-2', cwd: 'C:\\workspace', updatedAt: '2026-10-24T11:00:00Z', projections: { values: { title: '第二个' } } },
  ];
  const { markdown, state, bridge, message } = await fixture(t, { sessions });
  await state.setSession('s-1');
  await bridge.accept(message({ messageId: 'm-1', content: '/bind s-2' }));
  assert.equal(state.sessionId, 's-2');
  assert.match(markdown[0], /已切换至 \*\*第二个\*\*/u);

  await bridge.accept(message({ messageId: 'm-2', content: '/bind s-nope' }));
  assert.match(markdown[1], /没有找到会话 `s-nope`/u);
  assert.match(markdown[1], /\/bind 查看列表/u);
});

test('command panel aliases work as the whole message', async (t) => {
  const sessions = [
    { sessionId: 's-1', cwd: 'C:\\workspace', updatedAt: '2026-10-24T10:00:00Z', projections: { values: { title: '第一个' } } },
  ];
  const { markdown, created, state, bridge, message } = await fixture(t, { sessions });
  await state.setSession('s-1');

  await bridge.accept(message({ messageId: 'm-1', content: '/bind new' }));
  assert.deepEqual(created, [{ cwd: 'C:\\workspace' }]);
  assert.match(markdown[0], /session-new/u);

  await bridge.accept(message({ messageId: 'm-2', content: '/bind new' }));
  assert.equal(created.length, 2, 'the slash form still works');

  // A bare alias runs its command; with arguments it stays a prompt.
  await bridge.accept(message({ messageId: 'm-3', content: 'bind' }));
  assert.match(markdown.at(-1), /可绑定会话/u);

  await bridge.accept(message({ messageId: 'm-4', content: 'bind new' }));
  assert.deepEqual(markdown.at(-1), 'Answer', 'the sentence reached the session');

  await bridge.accept(message({ messageId: 'm-5', content: 'status' }));
  assert.match(markdown.at(-1), /连接：\*\*已连接\*\*/u);

  // A word that merely starts with an alias is an ordinary prompt.
  await bridge.accept(message({ messageId: 'm-6', content: 'help me please' }));
  assert.deepEqual(markdown.at(-1), 'Answer');
});

test('an alias followed by text stays a prompt instead of running the command', async (t) => {
  const { state, markdown, bridge, message } = await fixture(t);
  await state.setSession('session-1');

  await bridge.accept(message({ messageId: 'm-1', content: '解除绑定 是什么意思' }));
  assert.equal(state.sessionId, 'session-1', 'the binding is untouched');
  assert.deepEqual(markdown, ['Answer'], 'the sentence reached the session');

  await bridge.accept(message({ messageId: 'm-2', content: '新建会话 帮我写个函数' }));
  assert.equal(state.sessionId, 'session-1', 'no new session was created');
});

test('/bind new uses the registered workspace when the directory is known', async (t) => {
  const workspace = { id: 'ws-1', path: 'C:\\workspace' };
  const { created, bridge, message } = await fixture(t, { workspace });
  await bridge.accept(message({ messageId: 'm-1', content: '/bind new' }));
  assert.deepEqual(created, [{ workspaceId: 'ws-1' }]);
});


test('/bind new with a first message starts the session turn immediately', async (t) => {
  const { created, markdown, state, bridge, message } = await fixture(t);
  await bridge.accept(message({ messageId: 'm-1', content: '/bind new 你好' }));
  assert.deepEqual(created, [{ cwd: 'C:\\workspace' }]);
  assert.equal(state.sessionId, 'session-new');
  assert.deepEqual(markdown, ['Answer']);
});

test('a failed markdown reply falls back to plain text once', async (t) => {
  const { sent, markdown, bridge, message, state } = await fixture(t, { failMarkdown: true });
  await state.setSession('session-1');
  await bridge.accept(message());
  assert.deepEqual(markdown, [], 'markdown delivery failed');
  assert.deepEqual(sent, ['Answer'], 'the answer went out as plain text');
});

test('a failed markdown command reply is logged, never resent', async (t) => {
  const { sent, markdown, bridge, message } = await fixture(t, { failMarkdown: true });
  await bridge.accept(message({ messageId: 'm-1', content: '/help' }));
  assert.deepEqual(markdown, [], 'markdown delivery failed');
  assert.deepEqual(sent, [], 'the reply is not sent twice');
});

test('a reply after the passive window becomes proactive', () => {
  const target = { scope: 'c2c', targetId: 'openid-a', msgId: 'msg-1' };
  assert.equal(replyTargetFor(target, 0), target);
  assert.equal(replyTargetFor(target, PASSIVE_WINDOW_MS), target);
  assert.deepEqual(replyTargetFor(target, PASSIVE_WINDOW_MS + 1), { scope: 'c2c', targetId: 'openid-a' });
});

test('a c2c answer is streamed when the SDK supports it, with markdown as fallback', async (t) => {
  const { markdown, streams, streamUpdates, bridge, message, state } = await fixture(t, { stream: true });
  await state.setSession('session-1');
  await bridge.accept(message());
  assert.equal(streams.length, 1, 'one stream per turn');
  assert.deepEqual(streamUpdates, ['Answer'], 'only the post-tool answer text is streamed');
  assert.equal(streams[0].done, true);
  assert.equal(markdown.length, 0, 'the stream replaces the plain send');
});

test('a failing stream falls back to a normal markdown answer', async (t) => {
  const { markdown, streams, bridge, message, state } = await fixture(t, { stream: true, failStream: true });
  await state.setSession('session-1');
  await bridge.accept(message());
  assert.equal(streams[0].cancelled, true);
  assert.deepEqual(markdown, ['Answer']);
});

test('a long answer skips the per-frame crawl and is sent once instead', async (t) => {
  const answer = 'x'.repeat(2_000);
  const { markdown, streams, bridge, message, state } = await fixture(t, { stream: true, answer });
  await state.setSession('session-1');
  await bridge.accept(message());
  assert.equal(streams.length, 0, 'nothing is streamed once the text is already long');
  assert.deepEqual(markdown, [answer]);
});

test('a bound chat relays only the final answer', async (t) => {
  const { markdown, prompts, bridge, message, state } = await fixture(t);
  await state.setSession('session-1');
  await bridge.accept(message());
  assert.deepEqual(markdown, ['Answer']);
  assert.deepEqual(prompts[0].content, [{ type: 'text', text: `${QQ_ORIGIN_MARKER} hello` }]);
});

test('a stopped turn without an answer is reported as a quoted notice', async (t) => {
  const { markdown, bridge, message, state } = await fixture(t, { noAnswer: true, endReason: { kind: 'aborted' } });
  await state.setSession('session-1');
  await bridge.accept(message());
  assert.equal(markdown.length, 1);
  assert.match(markdown[0], /^⚠️ \*\*本轮执行异常中断\*\*\n\n> 本轮已被停止。/u);
});

test('a failed prompt is reported as a quoted notice', async (t) => {
  const { markdown, bridge, message, state } = await fixture(t, { noAnswer: true, endReason: { kind: 'error', error: { message: '模型调用失败' } } });
  await state.setSession('session-1');
  await bridge.accept(message());
  assert.equal(markdown.length, 1);
  assert.match(markdown[0], /^⚠️ \*\*本轮执行异常中断\*\*\n\n> 本轮处理失败：模型调用失败/u);
});

test('a message sent while a turn is running is queued and announced', async (t) => {
  const { sent, markdown, prompts, bridge, message, state } = await fixture(t, { agentsRunning: true });
  await state.setSession('session-1');
  await bridge.accept(message());
  assert.match(sent[0], /排在第 1 位/u);
  assert.match(sent[0], /\/interject/u);
  assert.deepEqual(markdown, ['Answer'], 'the queued message still ran');
  assert.equal(prompts[0].mode, 'queue');
});

test('/interject sends a steer prompt instead of queueing a new turn', async (t) => {
  const { markdown, prompts, bridge, message, state } = await fixture(t, { agentsRunning: true });
  await state.setSession('session-1');
  await bridge.accept(message({ messageId: 'm-1', content: '/interject 先看日志' }));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].mode, 'steer');
  assert.deepEqual(prompts[0].content, [{ type: 'text', text: '先看日志' }]);
  assert.match(markdown[0], /已插话/u);
});

test('/interject on an idle agent behaves like a normal message', async (t) => {
  const { markdown, prompts, bridge, message, state } = await fixture(t);
  await state.setSession('session-1');
  await bridge.accept(message({ messageId: 'm-1', content: '/interject 你好' }));
  assert.equal(prompts[0].mode, 'queue');
  assert.deepEqual(markdown, ['Answer']);
});

test('an agent question is forwarded to QQ and answered with an option number', async (t) => {
  const { markdown, prompts, bridge, message, state, release } = await fixture(t, { holdPrompt: true });
  await state.setSession('session-1');
  const inflight = bridge.accept(message({ messageId: 'm-1' }));
  await until(() => prompts.length === 1);

  const request = {
    agent: { id: 'session-1' },
    questions: [{ id: 'q1', question: '用哪个方案？', options: [{ label: '甲' }, { label: '乙' }] }],
  };
  const answered = bridge.userQuestion(request);
  await until(() => markdown.some((line) => line.includes('2. 乙')));

  await bridge.accept(message({ messageId: 'm-2', content: '2' }));
  assert.deepEqual(await answered, { answers: [{ id: 'q1', selected: ['乙'] }] });
  assert.ok(markdown.some((line) => line.includes('收到，继续执行任务。')), 'the answer is acknowledged in QQ');

  release();
  await inflight;
});

test('replying 0 skips the question and is acknowledged', async (t) => {
  const { markdown, prompts, bridge, message, state, release } = await fixture(t, { holdPrompt: true });
  await state.setSession('session-1');
  const inflight = bridge.accept(message({ messageId: 'm-1' }));
  await until(() => prompts.length === 1);

  const answered = bridge.userQuestion({
    agent: { id: 'session-1' },
    questions: [{ id: 'q1', question: '用哪个方案？', options: [{ label: '甲' }, { label: '乙' }] }],
  });
  await until(() => markdown.some((line) => line.includes('1. 甲')));

  await bridge.accept(message({ messageId: 'm-2', content: '0' }));
  assert.deepEqual(await answered, { answers: [{ id: 'q1', selected: [] }] });
  assert.ok(markdown.some((line) => line.includes('收到，已跳过，继续执行任务。')));

  release();
  await inflight;
});

test('an aborted agent question falls back to the Web relay', async (t) => {
  const { markdown, prompts, bridge, message, state, release } = await fixture(t, { holdPrompt: true });
  await state.setSession('session-1');
  const inflight = bridge.accept(message({ messageId: 'm-1' }));
  await until(() => prompts.length === 1);

  const controller = new AbortController();
  const answered = bridge.userQuestion({
    agent: { id: 'session-1' },
    questions: [{ id: 'q1', question: '继续吗？' }],
    signal: controller.signal,
  });
  await until(() => markdown.some((line) => line.includes('继续吗？')));
  controller.abort();
  assert.equal(await answered, undefined);

  release();
  await inflight;
});

test('questions from other sessions fall through to the Web relay', async (t) => {
  const { bridge } = await fixture(t);
  const foreign = { agent: { id: 'other-session' }, questions: [{ id: 'q1', question: '继续吗？' }] };
  assert.equal(await bridge.userQuestion(foreign), undefined);
});

test('parseAnswer maps QQ replies to selected labels or custom text', () => {
  const single = { id: 'q1', options: [{ label: '甲' }, { label: '乙' }] };
  assert.deepEqual(parseAnswer(single, '2'), { id: 'q1', selected: ['乙'] });
  assert.deepEqual(parseAnswer(single, '乙'), { id: 'q1', selected: [], custom: '乙' });
  assert.deepEqual(parseAnswer(single, '0'), { id: 'q1', selected: [] }, '"0" skips the question');
  assert.deepEqual(parseAnswer(single, '跳过'), { id: 'q1', selected: [], custom: '跳过' });
  assert.equal(parseAnswer(single, '9'), undefined, 'out-of-range numbers re-prompt');
  assert.equal(parseAnswer(single, '2 9'), undefined, 'a stray number must not be dropped silently');

  const multi = { id: 'q2', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
  assert.deepEqual(parseAnswer(multi, '1, 3'), { id: 'q2', selected: ['A', 'C'] });
  assert.equal(parseAnswer(multi, '1 9'), undefined);
  assert.equal(parseAnswer({ ...multi, multiSelect: false }, '1,2'), undefined);

  assert.deepEqual(parseAnswer({ id: 'q4', options: [] }, '自由回答'), { id: 'q4', selected: [], custom: '自由回答' });
});

test('questionWindowMs stays between one and three minutes', () => {
  assert.equal(questionWindowMs(600_000), 180_000, 'the default reply timeout caps at three minutes');
  assert.equal(questionWindowMs(90_000), 60_000, 'a short timeout still leaves a minute');
  assert.equal(questionWindowMs(undefined), 180_000);
  assert.equal(questionWindowMs(30_000), 60_000, 'the floor wins over a tiny timeout');
});

test('questionKeyboard turns a short single-select question into buttons', () => {
  const keyboard = questionKeyboard({ id: 'q', options: [{ label: '甲' }, { label: '乙' }] });
  assert.equal(keyboard.content.rows.length, 2);
  assert.deepEqual(keyboard.content.rows[0].buttons[0], {
    id: 'qqbot-opt-1',
    render_data: { label: '甲', visited_label: '甲', style: 1 },
    action: {
      type: 1,
      permission: { type: 2 },
      data: '1',
      unsupport_tips: '请升级手机 QQ 后重试',
    },
  });
  assert.equal(questionKeyboard({ id: 'q', multiSelect: true, options: [{ label: 'A' }] }), null);
  assert.equal(questionKeyboard({ id: 'q', options: [] }), null);
  assert.equal(questionKeyboard({ id: 'q', options: Array.from({ length: 6 }, (_, i) => ({ label: `${i}` })) }), null);
});

test('a tapped question button answers it and is acknowledged', async (t) => {
  const { markdown, keyboards, acks, recalls, prompts, bridge, message, state, release } = await fixture(t, { holdPrompt: true });
  await state.setSession('session-1');
  const inflight = bridge.accept(message({ messageId: 'm-1' }));
  await until(() => prompts.length === 1);

  const answered = bridge.userQuestion({
    agent: { id: 'session-1' },
    questions: [{ id: 'q1', question: '用哪个？', options: [{ label: '甲' }, { label: '乙' }] }],
  });
  await until(() => keyboards.length === 1);
  assert.ok(markdown.some((line) => line.includes('1/1')), 'the question text still reaches QQ');
  assert.equal(keyboards[0].content.rows.length, 2);

  // A foreign user must not be able to answer the owner's question.
  await bridge.interaction({ id: 'i-1', user_openid: 'someone-else', data: { resolved: { button_id: 'qqbot-opt-2' } } });
  assert.deepEqual(acks.at(-1), ['i-1', 4]);

  await bridge.interaction({ id: 'i-2', user_openid: 'openid-a', data: { resolved: { button_id: 'qqbot-opt-2' } } });
  assert.deepEqual(acks.at(-1), ['i-2', 0]);
  assert.deepEqual(await answered, { answers: [{ id: 'q1', selected: ['乙'] }] });
  assert.ok(markdown.includes('收到，继续执行任务。'), 'a tap gets the same receipt as typing the number');
  assert.deepEqual(recalls, ['kb-1'], 'the answered question is taken away so its buttons stop working');

  // A second tap on the now-gone question is a duplicate, not a failure.
  await bridge.interaction({ id: 'i-3', user_openid: 'openid-a', data: { resolved: { button_id: 'qqbot-opt-1' } } });
  assert.deepEqual(acks.at(-1), ['i-3', 3]);

  release();
  await inflight;
});

test('a keyboard failure falls back to a plain question message', async (t) => {
  const { markdown, keyboards, prompts, bridge, message, state, release } = await fixture(t, { holdPrompt: true, failKeyboard: true });
  await state.setSession('session-1');
  const inflight = bridge.accept(message({ messageId: 'm-1' }));
  await until(() => prompts.length === 1);

  const answered = bridge.userQuestion({
    agent: { id: 'session-1' },
    questions: [{ id: 'q1', question: '用哪个？', options: [{ label: '甲' }] }],
  });
  await until(() => markdown.some((line) => line.includes('1/1')));
  assert.equal(keyboards.length, 0);
  await bridge.accept(message({ messageId: 'm-2', content: '1' }));
  assert.deepEqual(await answered, { answers: [{ id: 'q1', selected: ['甲'] }] });

  release();
  await inflight;
});

test('a question with no text still yields one answer per question', async (t) => {
  const { markdown, prompts, bridge, message, state, release } = await fixture(t, { holdPrompt: true });
  await state.setSession('session-1');
  const inflight = bridge.accept(message({ messageId: 'm-1' }));
  await until(() => prompts.length === 1);

  const answered = bridge.userQuestion({
    agent: { id: 'session-1' },
    questions: [{ id: 'q1', question: '   ' }],
  });
  await until(() => markdown.some((line) => line.includes('模型未提供问题文本')));
  await bridge.accept(message({ messageId: 'm-2', content: '自己的答案' }));
  assert.deepEqual(await answered, { answers: [{ id: 'q1', selected: [], custom: '自己的答案' }] });

  release();
  await inflight;
});

test('two questions are asked and answered in order', async (t) => {
  const { markdown, prompts, bridge, message, state, release } = await fixture(t, { holdPrompt: true });
  await state.setSession('session-1');
  const inflight = bridge.accept(message({ messageId: 'm-1' }));
  await until(() => prompts.length === 1);

  const answered = bridge.userQuestion({
    agent: { id: 'session-1' },
    questions: [
      { id: 'q1', question: '用哪个方案？', options: [{ label: '甲' }, { label: '乙' }] },
      { id: 'q2', question: '补充说明？' },
    ],
  });
  await until(() => markdown.some((line) => line.includes('1/2')));
  await bridge.accept(message({ messageId: 'm-2', content: '2' }));
  await until(() => markdown.some((line) => line.includes('2/2')));
  await bridge.accept(message({ messageId: 'm-3', content: '没有了' }));

  assert.deepEqual(await answered, {
    answers: [{ id: 'q1', selected: ['乙'] }, { id: 'q2', selected: [], custom: '没有了' }],
  });

  release();
  await inflight;
});

test('a reply that lands while a question prompt uploads is only told to wait', async (t) => {
  const { markdown, prompts, bridge, message, state, release, releaseMarkdown } = await fixture(t, {
    holdPrompt: true, holdMarkdown: true,
  });
  await state.setSession('session-1');
  const inflight = bridge.accept(message({ messageId: 'm-1' }));
  await until(() => prompts.length === 1);

  const answered = bridge.userQuestion({
    agent: { id: 'session-1' },
    questions: [{ id: 'q1', question: '选一个？', options: [{ label: 'A' }, { label: 'B' }] }],
  });
  await until(() => releaseMarkdown);
  // The question is not rendered in QQ yet, so this reply cannot be an answer.
  await bridge.accept(message({ messageId: 'm-2', content: '1' }));
  assert.match(markdown.at(-1), /正在发送题目/u);

  releaseMarkdown();
  await until(() => markdown.some((line) => line.includes('1/1')));
  await bridge.accept(message({ messageId: 'm-3', content: '1' }));
  assert.deepEqual(await answered, { answers: [{ id: 'q1', selected: ['A'] }] });

  release();
  await inflight;
});

test('an abort while the first question uploads stays handled', async (t) => {
  const { prompts, bridge, message, state, release, releaseMarkdown } = await fixture(t, {
    holdPrompt: true, holdMarkdown: true,
  });
  await state.setSession('session-1');
  const inflight = bridge.accept(message({ messageId: 'm-1' }));
  await until(() => prompts.length === 1);

  const controller = new AbortController();
  const answered = bridge.userQuestion({
    agent: { id: 'session-1' },
    questions: [{ id: 'q1', question: '继续吗？' }],
    signal: controller.signal,
  });
  await until(() => releaseMarkdown);
  // The rejection happens before `await answered` attaches: it must not surface
  // as an unhandled rejection. Yield a full tick so Node would report it.
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseMarkdown();

  assert.equal(await answered, undefined);
  release();
  await inflight;
});

test('a question nobody answers times out and hands control back', async (t) => {
  const { sent, markdown, prompts, bridge, message, state, release } = await fixture(t, { holdPrompt: true });
  await state.setSession('session-1');
  const inflight = bridge.accept(message({ messageId: 'm-1' }));
  await until(() => prompts.length === 1);

  // The timer is the only thing here that waits: mock it instead of sleeping a minute.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const answered = bridge.userQuestion({
      agent: { id: 'session-1' },
      questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] }],
    });
    // Let the prompt upload and the `await answered` settle first.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(markdown.some((line) => line.includes('1/1')));

    t.mock.timers.tick(questionWindowMs(1_000));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await answered, undefined, 'the official Web relay answers instead');
    assert.match(sent.at(-1), /提问等待超时/u);
  } finally {
    t.mock.timers.reset();
  }

  release();
  await inflight;
});

test('questionText uses the agent header as the title and documents skipping', () => {
  const rendered = questionText({
    id: 'q', header: '确认', question: '选一个', options: [{ label: 'A', description: 'aa' }, { label: 'B' }],
  }, 1, 2);
  assert.match(rendered, /^\*\*❓ 确认\*\*$/mu);
  assert.doesNotMatch(rendered, /Agent 提问/u);
  assert.match(rendered, /1\. A — aa/u);
  assert.match(rendered, /2\. B/u);
  assert.match(rendered, /^点按钮或回复序号或直接回复自定义内容；回复「0」跳过这个问题。$/mu);
  assert.doesNotMatch(rendered, /回复序号或直接回复自定义内容\n/u);

  const multi = questionText({
    id: 'q', question: '多选', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }],
  }, 1, 1);
  assert.match(multi, /\*\*❓ Agent 提问（1\/1）\*\*/u);
  assert.match(multi, /^点按钮或回复序号（多选）或直接回复自定义内容；回复「0」跳过这个问题。$/mu);
});
