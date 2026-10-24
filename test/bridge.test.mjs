import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBridge, parseAnswer, PASSIVE_WINDOW_MS, questionText, replyTargetFor } from '../src/bridge.js';
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

async function fixture(t, { workspace, failMarkdown = false, agentsRunning = false, holdPrompt = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-qq-bot-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await createStateStore(join(root, 'state.json')).load();
  const sent = [];
  const markdown = [];
  const created = [];
  const prompts = [];
  const listeners = new Set();
  let releasePending = null;
  const agentStatus = () => (agentsRunning ? { status: 'running' } : null);
  const ctx = {
    get: (key) => (key === 'workspaceRegistry'
      ? { resolveByPath: async () => workspace, create: async () => workspace }
      : key === 'agents' ? { get: () => agentStatus() }
        : key === 'sessionController' ? ctx.sessionController : undefined),
    sessionController: {
      async create(request) { created.push(request); return { sessionId: 'session-new' }; },
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
              listener({ id: request.sessionId }, { seq: 4, type: 'assistant/message', data: { turn, step: 1, message: { content: [text('Answer')] } } });
              listener({ id: request.sessionId }, { seq: 5, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
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
  const runtime = {
    ready: true,
    status: { ready: true, state: 'connected', lastError: null },
    async sendText(target, value) { sent.push(value); },
    async sendMarkdown(target, value) {
      if (failMarkdown) throw new Error('markdown rejected');
      markdown.push(value);
    },
  };
  const bridge = createBridge({
    runtime, state, ctx,
    settings: { workspace: 'C:\\workspace', replyTimeoutMs: 1_000 },
    logger: { warn: () => {} },
  });
  const message = (overrides = {}) => ({
    kind: 'c2c', senderId: 'openid-a', senderIsBot: false, messageId: 'm-1',
    content: 'hello', replyTarget: { scope: 'c2c', targetId: 'openid-a', msgId: 'm-1' },
    ...overrides,
  });
  return { state, sent, markdown, created, prompts, bridge, message, release: () => releasePending?.() };
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
  assert.match(markdown[0], /`\/new`/u);
  await bridge.accept(message({ messageId: 'm-2', content: '/status' }));
  assert.match(markdown[1], /连接：\*\*已连接\*\*/u);
  assert.match(markdown[1], /绑定会话：`无`/u);
});

test('/new creates a session in the default workspace and binds it', async (t) => {
  const { state, markdown, created, bridge, message } = await fixture(t);
  await bridge.accept(message({ messageId: 'm-1', content: '/new' }));
  assert.deepEqual(created, [{ cwd: 'C:\\workspace' }]);
  assert.equal(state.sessionId, 'session-new');
  assert.match(markdown[0], /会话：`session-new`/u);
});

test('command panel aliases work as the whole message', async (t) => {
  const { markdown, created, bridge, message } = await fixture(t);

  await bridge.accept(message({ messageId: 'm-1', content: 'new' }));
  assert.deepEqual(created, [{ cwd: 'C:\\workspace' }]);
  assert.match(markdown[0], /session-new/u);

  await bridge.accept(message({ messageId: 'm-2', content: '/new' }));
  assert.equal(created.length, 2, 'the slash form still works');

  await bridge.accept(message({ messageId: 'm-3', content: 'status' }));
  assert.match(markdown.at(-1), /连接：\*\*已连接\*\*/u);

  // A word that merely starts with an alias is an ordinary prompt.
  await bridge.accept(message({ messageId: 'm-4', content: 'help me please' }));
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

test('/new uses the registered workspace when the directory is known', async (t) => {
  const workspace = { id: 'ws-1', path: 'C:\\workspace' };
  const { created, bridge, message } = await fixture(t, { workspace });
  await bridge.accept(message({ messageId: 'm-1', content: '/new' }));
  assert.deepEqual(created, [{ workspaceId: 'ws-1' }]);
});


test('/new with a first message starts the session turn immediately', async (t) => {
  const { created, markdown, state, bridge, message } = await fixture(t);
  await bridge.accept(message({ messageId: 'm-1', content: '/new 你好' }));
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

test('a bound chat relays only the final answer', async (t) => {
  const { markdown, bridge, message, state } = await fixture(t);
  await state.setSession('session-1');
  await bridge.accept(message());
  assert.deepEqual(markdown, ['Answer']);
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
  assert.deepEqual(parseAnswer(single, '跳过'), { id: 'q1', selected: [] });
  assert.equal(parseAnswer(single, '9'), undefined, 'out-of-range numbers re-prompt');

  const multi = { id: 'q2', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
  assert.deepEqual(parseAnswer(multi, '1, 3'), { id: 'q2', selected: ['A', 'C'] });
  assert.equal(parseAnswer({ ...multi, multiSelect: false }, '1,2'), undefined);

  assert.deepEqual(parseAnswer({ id: 'q4', options: [] }, '自由回答'), { id: 'q4', selected: [], custom: '自由回答' });
});

test('questionText numbers options and mentions skipping', () => {
  const rendered = questionText({
    id: 'q', header: '确认', question: '选一个', options: [{ label: 'A', description: 'aa' }, { label: 'B' }],
  }, 1, 2);
  assert.match(rendered, /1\. A — aa/u);
  assert.match(rendered, /2\. B/u);
  assert.match(rendered, /跳过/u);
});
