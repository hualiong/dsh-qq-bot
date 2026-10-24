import assert from 'node:assert/strict';
import test from 'node:test';

import { createQqRuntime } from '../src/qq/runtime.js';

test('sendMarkdown rejects instead of throwing when no bot is connected', async () => {
  const runtime = createQqRuntime({
    appId: 'app-id',
    appSecret: 'app-secret',
    onMessage: () => undefined,
    createBot: () => { throw new Error('must not connect in this test'); },
    logger: { warn: () => undefined },
  });
  const result = runtime.sendMarkdown({ scope: 'c2c', targetId: 'openid' }, 'hello');
  assert.ok(result instanceof Promise, 'a synchronous throw would escape the caller catch');
  await assert.rejects(result, /未连接/u);
});

test('sendMedia forwards the media kind and source to the SDK', async () => {
  const handlers = new Map();
  const sent = [];
  const fake = {
    api: { async get() { return { id: '1', username: 'bot', avatar: '', share_url: '' }; } },
    use() { return this; },
    on(event, handler) { handlers.set(event, handler); return this; },
    async start() { handlers.get('ready')?.(); },
    stop() { /* nothing to tear down */ },
    async sendMedia(options) { sent.push(options); return { ok: true }; },
  };
  const runtime = createQqRuntime({
    appId: 'app-id',
    appSecret: 'app-secret',
    onMessage: () => undefined,
    createBot: () => fake,
    logger: { warn: () => undefined, info: () => undefined },
  });
  await runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const target = { scope: 'c2c', targetId: 'openid' };
  await runtime.sendMedia(target, { kind: 'image', source: 'https://example.com/a.png', caption: 'hi' });
  await runtime.sendMedia(target, { source: 'C:\\tmp\\report.pdf' });

  assert.deepEqual(sent, [
    { target, fileType: 1, url: 'https://example.com/a.png', content: 'hi' },
    { target, fileType: 4, localPath: 'C:\\tmp\\report.pdf', content: undefined },
  ]);

  await runtime.stop();
});

test('the ready handshake publishes the bot profile from /users/@me', async () => {
  const handlers = new Map();
  const fake = {
    api: {
      async get(path) {
        assert.equal(path, '/users/@me');
        return {
          id: '2589939449721853245',
          username: "Hualiang's bot",
          avatar: 'http://thirdqq.qlogo.cn/avatar.png',
          share_url: 'https://qun.qq.com/qunpro/robot/qunshare?robot_uin=4012894874&robot_appid=1905390910',
        };
      },
    },
    use() { return this; },
    on(event, handler) { handlers.set(event, handler); return this; },
    async start() { handlers.get('ready')?.(); },
    stop() { /* nothing to tear down */ },
  };
  const runtime = createQqRuntime({
    appId: 'app-id',
    appSecret: 'app-secret',
    onMessage: () => undefined,
    createBot: () => fake,
    logger: { warn: () => undefined, info: () => undefined },
  });

  assert.equal(runtime.profile, null, 'no profile before the gateway is ready');
  await runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(runtime.profile.name, "Hualiang's bot");
  assert.equal(runtime.profile.uin, '4012894874');
  assert.equal(runtime.profile.avatar, 'http://thirdqq.qlogo.cn/avatar.png');

  await runtime.stop();
  assert.equal(runtime.profile, null, 'stopping forgets the profile');
});

