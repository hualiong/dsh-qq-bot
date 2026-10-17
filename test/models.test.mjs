import assert from 'node:assert/strict';
import test from 'node:test';

import { modelListText, switchModel } from '../src/model-command.js';

const CATALOG = {
  default: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
  routableProviders: ['deepseek-account', 'zai'],
  groups: [
    {
      id: 'deepseek-account',
      name: 'DeepSeek Account',
      models: [{
        id: 'deepseek-flash',
        name: 'DeepSeek Flash',
        reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
      }],
    },
    { id: 'zai', name: 'zai', models: [{ id: 'glm-4-flash-250414', name: 'GLM-4-Flash' }] },
  ],
  failures: [],
};

function fakeCtx({ selection = { next: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } } } = {}) {
  const calls = [];
  const ctx = {
    calls,
    get: (key) => (key === 'sessionController' ? ctx.sessionController : undefined),
    sessionController: {
      async modelCatalog() { return CATALOG; },
      async projections(_request, signal) {
        assert.ok(signal instanceof AbortSignal, 'projections receives an AbortSignal');
        return { values: { modelSelection: selection } };
      },
      async selectModel(request) {
        calls.push(request);
        const group = CATALOG.groups.find((candidate) => candidate.id === request.provider);
        const model = group?.models?.find((candidate) => candidate.id === request.model);
        const selected = { provider: request.provider, model: request.model };
        const effort = request.reasoningEffort ?? model?.reasoning?.defaultEffort;
        if (effort) selected.reasoningEffort = effort;
        return { selected };
      },
    },
  };
  return ctx;
}

test('modelListText shows provider key, model key, and effort names', async () => {
  const text = await modelListText(fakeCtx(), 'session-1');
  assert.match(text, /当前模型：deepseek-account\/deepseek-flash（DeepSeek Flash） · High/u);
  assert.match(text, /1\. deepseek-account\/deepseek-flash（DeepSeek Flash） · 挡位 Off \/ High {2}← 当前/u);
  assert.match(text, /2\. zai\/glm-4-flash-250414（GLM-4-Flash） · 无思考挡位/u);
  assert.match(text, /用法：\/model <供应商>\/<模型> \[挡位\]/u);
});

test('modelListText marks the catalog default when the session has no selection', async () => {
  const ctx = fakeCtx({ selection: null });
  const text = await modelListText(ctx, 'session-1');
  assert.match(text, /当前模型：deepseek-account\/deepseek-flash（DeepSeek Flash） · High/u);
});

test('switchModel sends the exact selection request', async () => {
  const ctx = fakeCtx();
  const result = await switchModel(ctx, 'session-1', 'deepseek-account/deepseek-flash high');
  assert.equal(result, '已切换：deepseek-account/deepseek-flash · High');
  assert.deepEqual(ctx.calls, [{ sessionId: 'session-1', provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }]);
});

test('switchModel reports the effort the Host materialized', async () => {
  const ctx = fakeCtx();
  const result = await switchModel(ctx, 'session-1', 'deepseek-account/deepseek-flash');
  assert.equal(result, '已切换：deepseek-account/deepseek-flash · High');
  assert.deepEqual(ctx.calls, [{ sessionId: 'session-1', provider: 'deepseek-account', model: 'deepseek-flash' }]);
});

test('switchModel accepts effort names case-insensitively and rejects the rest', async () => {
  const ctx = fakeCtx();
  assert.equal(await switchModel(ctx, 'session-1', 'deepseek-account/deepseek-flash Off'), '已切换：deepseek-account/deepseek-flash · Off');
  assert.match(await switchModel(ctx, 'session-1', 'deepseek-account/deepseek-flash turbo'), /没有挡位「turbo」.*Off \/ High/u);
  assert.match(await switchModel(ctx, 'session-1', 'zai/glm-4-flash-250414 high'), /不提供思考挡位/u);
  assert.match(await switchModel(ctx, 'session-1', 'nope/model'), /没有找到模型/u);
  assert.match(await switchModel(ctx, 'session-1', 'deepseek-flash'), /格式/u);
});
