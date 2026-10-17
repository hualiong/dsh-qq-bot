import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBridge, PASSIVE_WINDOW_MS, replyTargetFor } from '../src/bridge.js';
import { createStateStore } from '../src/state.js';

const text = (value) => ({ type: 'text', text: value });

async function fixture(t, { workspace, failMarkdown = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-qq-lite-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await createStateStore(join(root, 'state.json')).load();
  const sent = [];
  const markdown = [];
  const created = [];
  const listeners = new Set();
  const ctx = {
    get: (key) => (key === 'workspaceRegistry'
      ? { resolveByPath: async () => workspace, create: async () => workspace }
      : key === 'sessionController' ? ctx.sessionController : undefined),
    sessionController: {
      async create(request) { created.push(request); return { sessionId: 'session-new' }; },
      async prompt(request) {
        // Answer the way the Host would: the prompt's own request id owns a turn.
        const turn = 1;
        queueMicrotask(() => {
          for (const listener of [...listeners]) {
            listener({ id: request.sessionId }, { seq: 1, type: 'user/message', data: { turn, source: { kind: 'user', rpcId: request.requestId } } });
            listener({ id: request.sessionId }, { seq: 2, type: 'assistant/message', data: { turn, step: 0, message: { content: [{ type: 'reasoning', text: 'secret' }, text('Checking'), { type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' }] } } });
            listener({ id: request.sessionId }, { seq: 3, type: 'tool/call', data: { turn, step: 0, callId: 'c', name: 'bash', arguments: '{}' } });
            listener({ id: request.sessionId }, { seq: 4, type: 'assistant/message', data: { turn, step: 1, message: { content: [text('Answer')] } } });
            listener({ id: request.sessionId }, { seq: 5, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
          }
        });
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
  return { state, sent, markdown, created, bridge, message };
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

test('/new creates a session in the default workspace, binds it, and unbind clears it', async (t) => {
  const { state, markdown, created, bridge, message } = await fixture(t);
  await bridge.accept(message({ messageId: 'm-1', content: '/new' }));
  assert.deepEqual(created, [{ cwd: 'C:\\workspace' }]);
  assert.equal(state.sessionId, 'session-new');
  assert.match(markdown[0], /会话：`session-new`/u);

  await bridge.accept(message({ messageId: 'm-2', content: '/unbind' }));
  assert.equal(state.sessionId, null);
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
