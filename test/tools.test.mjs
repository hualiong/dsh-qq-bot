import assert from 'node:assert/strict';
import test from 'node:test';

import { installSendTool } from '../src/tools.js';

test('the push tool reads runtime and state at call time', async () => {
  let definition;
  const ctx = { tools: { register: (registered) => { definition = registered; return () => {}; } } };
  // Installed before startup: the holder is still empty here.
  const holder = { runtime: null, state: null, settings: null };
  installSendTool(ctx, holder);

  await assert.rejects(definition.execute({ text: 'hi' }), /还没有可用的 QQ 目标/u);

  const sent = [];
  holder.state = { target: { scope: 'c2c', targetId: 'openid-a' } };
  holder.runtime = {
    ready: true,
    async sendText(target, text) { sent.push([target, text]); },
  };
  const result = await definition.execute({ text: 'hi' });
  assert.deepEqual(sent, [[{ scope: 'c2c', targetId: 'openid-a' }, 'hi']]);
  assert.match(result, /已推送到 QQ/u);
});

test('the push tool refuses while the bot is disconnected', async () => {
  let definition;
  const ctx = { tools: { register: (registered) => { definition = registered; return () => {}; } } };
  const holder = {
    state: { target: { scope: 'c2c', targetId: 'openid-a' } },
    runtime: { ready: false },
  };
  installSendTool(ctx, holder);
  await assert.rejects(definition.execute({ text: 'hi' }), /尚未连接/u);
});
