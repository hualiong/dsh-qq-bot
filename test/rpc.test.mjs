import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deriveBotIdentity } from '../src/config.js';
import { installRpc } from '../src/rpc.js';

const APP_ID = '1905390910';

function fakeProvision() {
  const state = { attemptId: 'attempt-1', status: 'pending', qrCodeDataUrl: 'data:image/png;base64,AAAA' };
  return {
    state,
    async begin() { return { ...state }; },
    poll(attemptId) { return attemptId === state.attemptId ? { ...state } : null; },
    cancel(attemptId) {
      if (attemptId !== state.attemptId) return null;
      state.status = 'cancelled';
      return { ...state };
    },
  };
}

async function fixture(t, { sessionId = null, withState = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-qq-lite-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });

  const identity = deriveBotIdentity(APP_ID);
  const credentials = {
    values: new Map([[identity.secretRef, 'secret-1']]),
    async resolve(ref) { return this.values.has(ref) ? { value: this.values.get(ref), source: 'test' } : undefined; },
    async describe(ref) { return { configured: this.values.has(ref), source: 'test', writable: true }; },
    async set(ref, value) { this.values.set(ref, value); },
    async unset(ref) { this.values.delete(ref); },
  };

  const state = withState ? {
    sessionId,
    ownerOpenId: null,
    async setSession(next) { state.sessionId = next; },
    async setOwner(next) { state.ownerOpenId = next; },
  } : null;

  const holder = {
    config: { dataDir: join(root, 'integrations', 'dsh-qq-lite') },
    logger: { info() {}, warn() {} },
    state,
    own: null,
    settings: { workspace: 'C:\\workspace', appId: APP_ID, secretRef: identity.secretRef },
    runtime: { status: { ready: true, state: 'connected', lastError: null } },
    events: { count: 5, lastType: 'turn/end' },
    remounts: 0,
    async remount() { holder.remounts += 1; },
    async stopBot() {},
  };
  holder.provision = fakeProvision();

  const ctx = {
    credentials,
    get: (key) => (key === 'sessionController' ? ctx.sessionController : undefined),
    sessionController: {
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

  return { ctx, holder, credentials, identity, call };
}

test('status reports connection, configuration, binding, and the event counter', async (t) => {
  const { call } = await fixture(t, { sessionId: 'session-1' });
  const result = await call('connection.status', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.version, '0.2.1');
  assert.equal(result.value.connected, true);
  assert.equal(result.value.configured, true);
  assert.equal(result.value.appId, APP_ID);
  assert.equal(result.value.appIdMasked, '190•••');
  assert.equal(result.value.secretConfigured, true);
  assert.equal(result.value.sessionId, 'session-1');
  assert.equal(result.value.workspace, 'C:\\workspace');
  assert.equal(result.value.events, 5);
  assert.equal(result.value.lastEvent, 'turn/end');
  assert.equal('ownerOpenId' in result.value, false, 'the owner openid is not exposed');
  assert.equal('secretRef' in result.value, false);
});

test('bind validates the session and stores it; unbind clears it', async (t) => {
  const { holder, call } = await fixture(t);
  const missing = await call('session.bind', { sessionId: 'missing' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'session-not-found');

  const bound = await call('session.bind', { sessionId: 'session-2' });
  assert.deepEqual(bound, { ok: true, value: { sessionId: 'session-2' } });
  assert.equal(holder.state.sessionId, 'session-2');

  const unbound = await call('session.unbind', {});
  assert.deepEqual(unbound, { ok: true, value: { sessionId: null } });
  assert.equal(holder.state.sessionId, null);
});

test('bot.save stores the secret, writes config, and remounts', async (t) => {
  const { holder, credentials, identity, call } = await fixture(t);
  const result = await call('bot.save', { appId: APP_ID, appSecret: 'secret-2', workspace: 'C:\\ws2' });
  assert.equal(result.ok, true);
  assert.equal(credentials.values.get(identity.secretRef), 'secret-2');
  assert.equal(holder.remounts, 1);
  assert.equal(holder.own.appId, APP_ID);
  assert.equal(holder.own.workspace, 'C:\\ws2');
  const stored = JSON.parse(await readFile(join(holder.config.dataDir, 'config.json'), 'utf8'));
  assert.equal(stored.appId, APP_ID);
  assert.equal(stored.secretRef, identity.secretRef);
});

test('bot.save keeps the stored secret when the field is blank', async (t) => {
  const { credentials, identity, call } = await fixture(t);
  const result = await call('bot.save', { appId: APP_ID, workspace: 'C:\\ws3' });
  assert.equal(result.ok, true);
  assert.equal(credentials.values.get(identity.secretRef), 'secret-1');
});

test('bot.save refuses a first-time empty secret and reports a not-ready state', async (t) => {
  const { call } = await fixture(t, { withState: false });
  const first = await call('bot.save', { appId: '1234567' });
  assert.equal(first.ok, false);
  assert.match(first.error.message, /AppSecret/u);

  const bound = await call('session.bind', { sessionId: 'session-2' });
  assert.equal(bound.ok, false);
  assert.equal(bound.error.code, 'not-ready');
});

test('bot.delete removes config and credential and clears the binding', async (t) => {
  const { holder, credentials, identity, call } = await fixture(t, { sessionId: 'session-1' });
  await call('bot.save', { appId: APP_ID, appSecret: 'secret-2', workspace: 'C:\\ws2' });
  const result = await call('bot.delete', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.configured, false);
  assert.equal(credentials.values.has(identity.secretRef), false);
  await assert.rejects(readFile(join(holder.config.dataDir, 'config.json'), 'utf8'));
  assert.equal(holder.state.sessionId, null);
});

test('provision endpoints forward the single attempt', async (t) => {
  const { call } = await fixture(t);
  const begun = await call('provision.begin', {});
  assert.equal(begun.ok, true);
  assert.equal(begun.value.attemptId, 'attempt-1');

  const polled = await call('provision.poll', { attemptId: 'attempt-1' });
  assert.equal(polled.value.status, 'pending');

  const missing = await call('provision.poll', { attemptId: 'nope' });
  assert.equal(missing.ok, false);

  const cancelled = await call('provision.cancel', { attemptId: 'attempt-1' });
  assert.equal(cancelled.value.status, 'cancelled');
});
