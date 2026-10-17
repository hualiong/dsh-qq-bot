import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStateStore } from '../src/state.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-qq-lite-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { path: join(root, 'state.json') };
}

test('state persists the single binding, owner, target, and seen ids across reloads', async (t) => {
  const { path } = await fixture(t);
  const state = await createStateStore(path).load();
  assert.equal(state.sessionId, null);
  assert.equal(state.ownerOpenId, null);
  assert.equal(state.target, null);

  await state.setSession('session-1');
  await state.setOwner('openid-a');
  await state.setTarget({ scope: 'c2c', targetId: 'openid-a' });
  await state.markSeen('msg-1');

  const reloaded = await createStateStore(path).load();
  assert.equal(reloaded.sessionId, 'session-1');
  assert.equal(reloaded.ownerOpenId, 'openid-a');
  assert.deepEqual(reloaded.target, { scope: 'c2c', targetId: 'openid-a' });
  assert.equal(reloaded.hasSeen('msg-1'), true);
  assert.equal(reloaded.hasSeen('msg-2'), false);
});

test('unbind keeps the owner and the push target', async (t) => {
  const { path } = await fixture(t);
  const state = await createStateStore(path).load();
  await state.setSession('session-1');
  await state.setOwner('openid-a');
  await state.setTarget({ scope: 'c2c', targetId: 'openid-a' });
  await state.setSession(null);

  const reloaded = await createStateStore(path).load();
  assert.equal(reloaded.sessionId, null);
  assert.equal(reloaded.ownerOpenId, 'openid-a');
  assert.equal(reloaded.target.targetId, 'openid-a');
});

test('a failed write leaves memory unchanged and later writes still run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-qq-lite-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'data');
  await mkdir(dir);
  const state = await createStateStore(join(dir, 'state.json')).load();

  // Replace the directory with a file so mkdir/write fail.
  await rm(dir, { recursive: true, force: true });
  await writeFile(dir, 'blocked');
  await assert.rejects(state.setSession('session-broken'));
  assert.equal(state.sessionId, null, 'a failed write did not commit in memory');

  // Restore the directory: the queue must still work, not stay poisoned.
  await rm(dir, { force: true });
  await mkdir(dir);
  await state.setSession('session-ok');
  assert.equal(state.sessionId, 'session-ok');
  const reloaded = await createStateStore(join(dir, 'state.json')).load();
  assert.equal(reloaded.sessionId, 'session-ok');
});

test('the seen list is bounded and keeps the newest ids', async (t) => {
  const { path } = await fixture(t);
  const state = await createStateStore(path).load();
  for (let index = 0; index < 1005; index += 1) await state.markSeen(`msg-${index}`);

  const reloaded = await createStateStore(path).load();
  assert.equal(reloaded.hasSeen('msg-1004'), true);
  assert.equal(reloaded.hasSeen('msg-5'), true);
  assert.equal(reloaded.hasSeen('msg-4'), false, 'the oldest ids fall out of the window');
  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(document.seenMessageIds.length, 1000);
});
