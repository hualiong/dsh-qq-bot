import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  deriveBotIdentity, loadOwnConfig, maskAppId, migrateLegacyState, removeOwnConfig, resolveSettings, saveOwnConfig,
} from '../src/config.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-qq-bot-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
  return home;
}

async function writeIntegration(home, { config, workspaces }) {
  const dir = join(home, 'integrations', 'dsh-qq');
  await mkdir(dir, { recursive: true });
  if (config) await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  if (workspaces) await writeFile(join(dir, 'workspaces.json'), JSON.stringify(workspaces));
}

test('reuses the dsh-im QQ integration credentials and workspace', async (t) => {
  const home = await fixture(t);
  await writeIntegration(home, {
    config: { version: 1, bots: [{ botId: 'qq_abc', appId: 'app-test', secretRef: 'DSH_TEST_SECRET' }] },
    workspaces: { version: 2, workspaces: { qq_abc: home } },
  });

  const settings = await resolveSettings({});
  assert.equal(settings.appId, 'app-test');
  assert.equal(settings.secretRef, 'DSH_TEST_SECRET');
  assert.equal(settings.workspace, home);
  assert.equal(settings.dataDir, join(home, 'integrations', 'dsh-qq-bot'));
  assert.equal(settings.ownerOpenId, null);
  assert.ok(settings.replyTimeoutMs > 0);
});

test('overrides win and a missing integration falls back to $DSH_HOME/im', async (t) => {
  const home = await fixture(t);
  const settings = await resolveSettings({
    appId: 'app-manual',
    secretRef: 'MANUAL_SECRET',
    workspace: 'C:\\elsewhere',
    dataDir: 'C:\\data',
    ownerOpenId: ' openid-1 ',
    replyTimeoutMs: 1234,
  });
  assert.equal(settings.appId, 'app-manual');
  assert.equal(settings.secretRef, 'MANUAL_SECRET');
  assert.equal(settings.workspace, 'C:\\elsewhere');
  assert.equal(settings.dataDir, 'C:\\data');
  assert.equal(settings.ownerOpenId, 'openid-1');
  assert.equal(settings.replyTimeoutMs, 1234);

  const fallback = await resolveSettings({});
  assert.equal(fallback.appId, null);
  assert.equal(fallback.workspace, join(home, 'im'));
});

test('the plugin store wins over row config and the dsh-im fallback', async (t) => {
  const home = await fixture(t);
  const own = {
    version: 1,
    appId: '1111111111',
    secretRef: deriveBotIdentity('1111111111').secretRef,
    workspace: join(home, 'own-ws'),
    ownerOpenId: 'openid-own',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  await saveOwnConfig({}, own);
  const loaded = await loadOwnConfig({});
  const { version: _version, ...expected } = own;
  assert.deepEqual(loaded, expected);

  const settings = await resolveSettings({ workspace: 'C:\\row-ws', ownerOpenId: 'row-owner' }, loaded);
  assert.equal(settings.appId, '1111111111');
  assert.equal(settings.secretRef, own.secretRef);
  assert.equal(settings.workspace, join(home, 'own-ws'));
  assert.equal(settings.ownerOpenId, 'openid-own');

  await removeOwnConfig({});
  assert.equal(await loadOwnConfig({}), null);
});

test('the pre-rename state directory is copied once and never overwritten', async (t) => {
  const home = await fixture(t);
  const legacy = join(home, 'integrations', 'dsh-qq-lite');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'config.json'), JSON.stringify({ version: 1, appId: 'app-legacy' }));
  await writeFile(join(legacy, 'state.json'), JSON.stringify({ version: 1, sessionId: 'session-legacy' }));

  await migrateLegacyState({});
  const target = join(home, 'integrations', 'dsh-qq-bot');
  assert.equal(JSON.parse(await readFile(join(target, 'config.json'), 'utf8')).appId, 'app-legacy');
  assert.equal(JSON.parse(await readFile(join(target, 'state.json'), 'utf8')).sessionId, 'session-legacy');

  await writeFile(join(target, 'state.json'), JSON.stringify({ version: 1, sessionId: 'session-new' }));
  await migrateLegacyState({});
  assert.equal(JSON.parse(await readFile(join(target, 'state.json'), 'utf8')).sessionId, 'session-new');

  await migrateLegacyState({ dataDir: join(home, 'explicit') });
  assert.equal(await readFile(join(home, 'explicit', 'state.json'), 'utf8').catch(() => null), null);
});

test('the identity derivation matches dsh-im and masks the app id', () => {
  const identity = deriveBotIdentity('1905390910');
  assert.match(identity.botId, /^qq_[a-f0-9]{24}$/u);
  assert.equal(identity.secretRef, `DSH_QQBOT_APP_SECRET_${identity.botId.slice(3).toUpperCase()}`);
  assert.equal(maskAppId('1905390910'), '190•••');
  assert.equal(maskAppId('abc'), 'abc•••');
  assert.equal(maskAppId(null), null);
});
