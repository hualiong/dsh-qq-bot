import assert from 'node:assert/strict';
import test from 'node:test';

import { createProvisioner } from '../src/qq/provision.js';

const PNG = 'data:image/png;base64,AAAA';

function fakeStart() {
  const created = [];
  const factory = (callbacks, options) => {
    created.push({ callbacks, options });
    queueMicrotask(() => callbacks.onQrDisplayed('https://q.qq.com/connect?task=1'));
    return () => undefined;
  };
  factory.created = created;
  return factory;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('begin exposes the QR image and poll follows expiry to a fresh code', async (t) => {
  const start = fakeStart();
  const provisioner = createProvisioner({ start, encode: async () => PNG });
  t.after(() => provisioner.close());

  const begunPromise = provisioner.begin({ source: 'test-source' });
  const first = await begunPromise;
  assert.equal(first.status, 'pending');
  assert.equal(first.qrCodeDataUrl, PNG);
  assert.equal(first.pollIntervalMs, 1000);
  assert.equal(start.created.length, 1);
  assert.equal(start.created[0].options.source, 'test-source');
  assert.equal(start.created[0].options.displayQrCodeToConsole, false);

  start.created[0].callbacks.onQrExpired();
  assert.equal(provisioner.poll(first.attemptId).status, 'refreshing');
  assert.equal(provisioner.poll(first.attemptId).qrCodeDataUrl, null);
});

test('a successful scan saves the credentials then reports connected', async (t) => {
  const start = fakeStart();
  const saved = [];
  const provisioner = createProvisioner({
    start,
    encode: async () => PNG,
    onCredentials: async (credentials) => { saved.push(credentials); },
  });
  t.after(() => provisioner.close());

  const begun = await provisioner.begin();
  await start.created[0].callbacks.onSuccess([{ appId: 'app-1', appSecret: 'secret-1', userOpenid: 'openid-1' }]);
  const state = provisioner.poll(begun.attemptId);
  assert.equal(state.status, 'connected');
  assert.equal(state.appId, 'app-1');
  assert.deepEqual(saved, [{ appId: 'app-1', appSecret: 'secret-1', ownerOpenId: 'openid-1' }]);
});

test('a failing credential save surfaces as a failed attempt', async (t) => {
  const start = fakeStart();
  const provisioner = createProvisioner({
    start,
    encode: async () => PNG,
    onCredentials: async () => { throw new Error('disk full'); },
  });
  t.after(() => provisioner.close());

  const begun = await provisioner.begin();
  await start.created[0].callbacks.onSuccess([{ appId: 'app-1', appSecret: 'secret-1' }]);
  const state = provisioner.poll(begun.attemptId);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /disk full/u);
});

test('cancel stops the attempt, and a second begin replaces the first', async (t) => {
  const start = fakeStart();
  const provisioner = createProvisioner({ start, encode: async () => PNG });
  t.after(() => provisioner.close());

  const first = await provisioner.begin();
  assert.equal(provisioner.cancel(first.attemptId).status, 'cancelled');
  assert.equal(provisioner.poll(first.attemptId).status, 'cancelled');

  const second = await provisioner.begin();
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(start.created.length, 2);

  start.created[1].callbacks.onFailure(new Error('expired by platform'));
  await tick();
  assert.equal(provisioner.poll(second.attemptId).status, 'failed');
  assert.equal(provisioner.poll('unknown'), null);
});
