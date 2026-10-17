import assert from 'node:assert/strict';
import test from 'node:test';

import { installRpc } from '../src/rpc.js';

function fixture({ sessionId = null, events } = {}) {
  const state = {
    sessionId,
    ownerOpenId: 'openid-a',
    setSession: async (next) => { state.sessionId = next; },
  };
  const holder = {
    state,
    settings: { workspace: 'C:\\workspace', appId: 'app-1' },
    runtime: { status: { ready: true, state: 'connected', lastError: null } },
    ...(events === undefined ? {} : { events }),
  };
  const ctx = {
    get: (key) => (key === 'sessionController' ? ctx.sessionController : undefined),
    sessionController: {
      // The in-process inspect throws a plain Error (no `code`) when missing.
      async inspect(id) {
        if (id === 'missing') throw new Error('session "missing" not found');
      },
    },
    connection: { fetch: { register: (route) => { ctx.route = route; return () => {}; } } },
  };
  installRpc(ctx, holder);
  const call = async (method, payload) => {
    const response = await ctx.route.fetch(new Request('http://127.0.0.1/api/dsh-qq-lite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'dsh-qq-lite', payload: { method, payload },
      }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.type, 'server-response');
    assert.equal(body.rpcId, 'rpc-1');
    return body.result;
  };
  return { ctx, state, call };
}

test('status reports connection, binding, and workspace', async () => {
  const { call } = fixture({ sessionId: 'session-1' });
  const result = await call('connection.status', {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    version: '0.1.0',
    connected: true,
    state: 'connected',
    lastError: null,
    sessionId: 'session-1',
    ownerOpenId: 'openid-a',
    workspace: 'C:\\workspace',
    appId: 'app-1',
    events: 0,
    lastEvent: null,
  });
});

test('bind validates the session and stores it; unbind clears it', async () => {
  const { state, call } = fixture();
  const bound = await call('session.bind', { sessionId: 'session-2' });
  assert.deepEqual(bound, { ok: true, value: { sessionId: 'session-2' } });
  assert.equal(state.sessionId, 'session-2');

  const unbound = await call('session.unbind', {});
  assert.deepEqual(unbound, { ok: true, value: { sessionId: null } });
  assert.equal(state.sessionId, null);
});

test('bind refuses an unknown session and malformed calls', async () => {
  const { call } = fixture();
  const missing = await call('session.bind', { sessionId: 'missing' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'session-not-found');
  assert.deepEqual(missing.error.details, {});

  const empty = await call('session.bind', {});
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'bad-request');

  const unknown = await call('no.such.method', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'bad-request');
});

test('a call arriving before startup reports not-ready', async () => {
  const { ctx, call } = fixture();
  ctx.route = null;
  installRpc(ctx, { state: null, runtime: null, settings: null });
  const result = await call('connection.status', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'not-ready');
});

test('status reports the session event feed counter', async () => {
  const { call } = fixture({ events: { count: 7, lastType: 'turn/end' } });
  const result = await call('connection.status', {});
  assert.equal(result.value.events, 7);
  assert.equal(result.value.lastEvent, 'turn/end');
});