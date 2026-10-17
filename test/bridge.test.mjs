import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBridge } from '../src/bridge.js';
import { createStateStore } from '../src/state.js';

const text = (value) => ({ type: 'text', text: value });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-qq-lite-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await createStateStore(join(root, 'state.json')).load();
  const sent = [];
  const markdown = [];
  const created = [];
  const listeners = new Set();
  const ctx = {
    get: (key) => (key === 'workspaceRegistry' ? { resolveByPath: async () => undefined } : undefined),
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
    async sendMarkdown(target, value) { markdown.push(value); },
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

test('/help and /status answer without touching the bound session', async (t) => {
  const { sent, bridge, message } = await fixture(t);
  await bridge.accept(message({ messageId: 'm-1', content: '/help' }));
  assert.match(sent[0], /\/new/);
  await bridge.accept(message({ messageId: 'm-2', content: '/status' }));
  assert.match(sent[1], /QQ 连接：已连接/);
  assert.match(sent[1], /绑定会话：无/);
});

test('/new creates a session in the default workspace, binds it, and unbind clears it', async (t) => {
  const { state, sent, created, bridge, message } = await fixture(t);
  await bridge.accept(message({ messageId: 'm-1', content: '/new' }));
  assert.deepEqual(created, [{ cwd: 'C:\\workspace' }]);
  assert.equal(state.sessionId, 'session-new');
  assert.match(sent[0], /session-new/);

  await bridge.accept(message({ messageId: 'm-2', content: '/unbind' }));
  assert.equal(state.sessionId, null);
});

test('a bound chat relays only the final answer', async (t) => {
  const { markdown, bridge, message, state } = await fixture(t);
  await state.setSession('session-1');
  await bridge.accept(message());
  assert.deepEqual(markdown, ['Answer']);
});
