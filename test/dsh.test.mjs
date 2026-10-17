import assert from 'node:assert/strict';
import test from 'node:test';

import { askSession } from '../src/dsh.js';

function fakeCtx() {
  const listeners = new Set();
  const prompts = [];
  const ctx = {
    prompts,
    listeners,
    get(key) {
      return key === 'sessionController' ? ctx.sessionController : undefined;
    },
    sessionController: {
      async prompt(request) { prompts.push(request); },
    },
    on(event, handler) {
      assert.equal(event, 'session/event');
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    emit(sessionId, event) {
      for (const listener of [...listeners]) listener({ id: sessionId }, event);
    },
  };
  return ctx;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (value) => ({ type: 'text', text: value });

test('askSession returns only the post-last-tool answer of its own turn', async () => {
  const ctx = fakeCtx();
  const task = askSession(ctx, 'session-1', 'hi', { timeoutMs: 1_000 });
  await settle();
  const { requestId } = ctx.prompts[0];
  assert.equal(ctx.prompts[0].mode, 'queue');
  assert.deepEqual(ctx.prompts[0].content, [text('hi')]);

  ctx.emit('session-1', { seq: 1, type: 'user/message', data: { turn: 1, source: { kind: 'user', rpcId: requestId } } });
  ctx.emit('session-1', { seq: 2, type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [text('Checking'), { type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' }] } } });
  ctx.emit('session-1', { seq: 3, type: 'tool/call', data: { turn: 1, step: 0, callId: 'c', name: 'bash', arguments: '{}' } });
  ctx.emit('session-1', { seq: 4, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'PRIVATE' }, text('Answer')] } } });
  ctx.emit('session-1', { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

  const result = await task;
  assert.equal(result.text, 'Answer');
  assert.equal(result.turn, 1);
  assert.equal(result.reason.kind, 'completed');
  assert.equal(ctx.listeners.size, 0, 'the session listener is removed');
});

test('askSession ignores other sessions and other turns', async () => {
  const ctx = fakeCtx();
  const task = askSession(ctx, 'session-1', 'hi', { timeoutMs: 1_000 });
  await settle();
  const { requestId } = ctx.prompts[0];

  ctx.emit('session-2', { seq: 1, type: 'user/message', data: { turn: 7, source: { kind: 'user', rpcId: requestId } } });
  ctx.emit('session-1', { seq: 2, type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } });
  ctx.emit('session-1', { seq: 3, type: 'user/message', data: { turn: 1, source: { kind: 'user', rpcId: requestId } } });
  ctx.emit('session-1', { seq: 4, type: 'assistant/message', data: { turn: 2, message: { content: [text('Other')] } } });
  ctx.emit('session-1', { seq: 5, type: 'assistant/message', data: { turn: 1, message: { content: [text('Mine')] } } });
  ctx.emit('session-1', { seq: 6, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

  assert.equal((await task).text, 'Mine');
});

test('askSession rejects with reply-timeout when the tracked turn never ends', async () => {
  const ctx = fakeCtx();
  await assert.rejects(
    askSession(ctx, 'session-1', 'hi', { timeoutMs: 20 }),
    (error) => error.code === 'reply-timeout',
  );
  assert.equal(ctx.listeners.size, 0);
});
