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
