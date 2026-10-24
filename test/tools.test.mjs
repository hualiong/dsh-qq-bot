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
    async sendMarkdown(target, text) { sent.push([target, text]); },
  };
  const result = await definition.execute({ text: 'hi' });
  assert.deepEqual(sent, [[{ scope: 'c2c', targetId: 'openid-a' }, 'hi']]);
  assert.match(result, /已推送到 QQ/u);
});

test('the push tool sends markdown and counts the chunks', async () => {
  let definition;
  const ctx = { tools: { register: (registered) => { definition = registered; return () => {}; } } };
  const holder = {
    state: { target: { scope: 'c2c', targetId: 'openid-a' } },
    runtime: { ready: true, async sendMarkdown() { /* delivered */ } },
  };
  installSendTool(ctx, holder);
  const result = await definition.execute({ text: '**hi**' });
  assert.match(result, /（1 条）/u);
  assert.match(definition.description, /Markdown/u);
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

test('the push tool sends an image or file through the media API', async () => {
  let definition;
  const ctx = { tools: { register: (registered) => { definition = registered; return () => {}; } } };
  const media = [];
  const holder = {
    state: { target: { scope: 'c2c', targetId: 'openid-a' } },
    runtime: { ready: true, async sendMedia(target, options) { media.push([target, options]); } },
  };
  installSendTool(ctx, holder);

  const image = await definition.execute({ image: 'https://example.com/a.png', text: '**看这个**' });
  assert.match(image, /已通过 QQ 发送图片（附说明文字）/u);
  const file = await definition.execute({ file: 'https://example.com/report.pdf' });
  assert.match(file, /已通过 QQ 发送文件/u);
  assert.deepEqual(media, [
    [{ scope: 'c2c', targetId: 'openid-a' }, { kind: 'image', source: 'https://example.com/a.png', caption: '**看这个**' }],
    [{ scope: 'c2c', targetId: 'openid-a' }, { kind: 'file', source: 'https://example.com/report.pdf', caption: undefined }],
  ]);
});

test('the push tool validates media arguments before sending', async () => {
  let definition;
  const ctx = { tools: { register: (registered) => { definition = registered; return () => {}; } } };
  const holder = {
    state: { target: { scope: 'c2c', targetId: 'openid-a' } },
    runtime: { ready: true, async sendMedia() { throw new Error('must not send'); } },
  };
  installSendTool(ctx, holder);

  await assert.rejects(definition.execute({}), /至少提供一个/u);
  await assert.rejects(definition.execute({ image: 'a.png', file: 'b.pdf' }), /只能提供其中一个/u);
  await assert.rejects(definition.execute({ file: 'Z:\\definitely-missing\\report.pdf' }), /本地文件不存在/u);
  assert.match(definition.description, /image/u);
  assert.deepEqual(Object.keys(definition.parameters.properties), ['text', 'image', 'file']);
});
