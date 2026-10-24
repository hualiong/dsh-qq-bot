import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMAND_ITEMS, ensureCommandPanel, MAX_PANEL_ITEMS } from '../src/qq/panels.js';

function fakeBot(records) {
  const calls = [];
  return {
    calls,
    api: {
      async get(path, query) { calls.push(['get', path, query]); return { records }; },
      async post(path, body) { calls.push(['post', path, body]); return { panel_id: 'p_new' }; },
      async put(path, body) { calls.push(['put', path, body]); return { version: 2 }; },
      async delete(path) { calls.push(['delete', path]); return { ok: true }; },
    },
  };
}

const ours = (panelId) => ({ panel_id: panelId, scope: 'c2c', target_type: 'all', panel: { remark: 'dsh-qq-bot' } });

test('creates one c2c global panel when the bot has none', async () => {
  const bot = fakeBot([]);
  await ensureCommandPanel(bot);
  assert.deepEqual(bot.calls.map(([method]) => method), ['get', 'post']);
  const body = bot.calls[1][2];
  assert.equal(body.scope, 'c2c');
  assert.equal(body.target_type, 'all');
  assert.equal(body.panel.remark, 'dsh-qq-bot');
  assert.deepEqual(body.panel.items, COMMAND_ITEMS);
});

test('updates the existing panel instead of creating a duplicate', async () => {
  const bot = fakeBot([{ panel_id: 'p_other', scope: 'c2c', target_type: 'all', panel: { remark: 'someone-else' } }, ours('p_ours')]);
  await ensureCommandPanel(bot);
  assert.deepEqual(bot.calls.map(([method]) => method), ['get', 'put']);
  assert.equal(bot.calls[1][1], '/v2/panels/p_ours');
  assert.equal(bot.calls[1][2].panel.remark, 'dsh-qq-bot');
});

test('removes the panel registered under the pre-rename plugin name', async () => {
  const legacy = { panel_id: 'p_old', scope: 'c2c', target_type: 'all', panel: { remark: 'dsh-qq-lite' } };
  const bot = fakeBot([legacy, ours('p_ours')]);
  await ensureCommandPanel(bot);
  assert.deepEqual(bot.calls.map(([method, path]) => [method, path]), [
    ['get', '/v2/panels'],
    ['delete', '/v2/panels/p_old'],
    ['put', '/v2/panels/p_ours'],
  ]);
});

test('does nothing for a bot without the raw API', async () => {
  await ensureCommandPanel({});
  await ensureCommandPanel(null);
});

// The platform counts a CJK character as two of its "characters", so the
// documented 30 (desc) / 14 (name) are really 15 / 7 Chinese characters. Go
// over and the whole panel update is rejected with 40030013.
const symbolWidth = (value) => [...value].reduce((sum, char) => sum + (char.codePointAt(0) > 0x7f ? 2 : 1), 0);

test('symbols fit the platform limits', () => {
  assert.ok(COMMAND_ITEMS.length <= MAX_PANEL_ITEMS, 'the platform rejects more than five items');
  assert.ok(COMMAND_ITEMS.some((item) => item.name === 'interject'), 'interject is discoverable in the panel');
  for (const item of COMMAND_ITEMS) {
    assert.ok(symbolWidth(item.name) <= 14, `${item.name} name width`);
    assert.ok(symbolWidth(item.desc) <= 30, `${item.name} desc width`);
  }
});
