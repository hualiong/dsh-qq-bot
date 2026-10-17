// QQ Bot lifecycle: one WebSocket gateway, and the two send paths the bridge
// needs (markdown answer delivery, short plain notices).
import { QQBot, contentSanitizer, typingIndicator } from '@tencent-connect/qqbot-nodejs';

import { sendMarkdownReply } from './reply.js';

const CONNECT_TIMEOUT_MS = 20_000;
const RETRY_MS = 15_000;

export function createQqRuntime({ appId, appSecret, onMessage, logger = console, createBot }) {
  const makeBot = createBot ?? ((options) => new QQBot(options));
  let bot = null;
  let stopping = false;
  let retryTimer = null;
  const status = { ready: false, state: 'idle', lastError: null, connectedAt: null };

  const scheduleRetry = (error) => {
    if (stopping || retryTimer) return;
    status.state = 'failed';
    status.lastError = error?.message ?? String(error);
    logger.warn?.(`[dsh-qq-lite] QQ 连接失败，${RETRY_MS / 1000} 秒后重试：${status.lastError}`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      // The retry owns its failure: an unhandled rejection here would take the
      // whole Host process down, and scheduleRetry already logged and re-armed.
      void connect().catch(() => undefined);
    }, RETRY_MS);
    retryTimer.unref?.();
  };

  const connect = async () => {
    status.state = 'connecting';
    const instance = makeBot({
      appId,
      appSecret,
      accountId: appId,
      logger,
      transport: 'websocket',
      tokenPrefetch: 'sync',
      markdownSupport: false,
    });
    instance.use(contentSanitizer({ parseFaceTags: true }));
    // Covers the whole await below, i.e. the entire Harness round trip.
    instance.use(typingIndicator({ keepAlive: true }));
    let settle;
    const ready = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    instance.on('ready', () => {
      status.ready = true; status.state = 'connected';
      status.connectedAt = Date.now(); status.lastError = null;
      settle.resolve();
    });
    instance.on('resumed', () => {
      status.ready = true; status.state = 'connected';
      settle.resolve();
    });
    instance.on('error', (error) => {
      status.lastError = error?.message ?? String(error);
      logger.warn?.('[dsh-qq-lite] QQ 连接错误：', status.lastError);
      if (!status.ready) settle.reject(error);
    });
    instance.on('message', async (_ctx, message) => { await onMessage(message); });
    bot = instance;
    instance.start().catch((error) => {
      status.ready = false;
      status.state = 'failed';
      status.lastError = error?.message ?? String(error);
      settle.reject(error);
      scheduleRetry(error);
    });
    let timeout;
    try {
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('QQ 网关连接超时')), CONNECT_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } catch (error) {
      status.ready = false;
      try { instance.stop(); } catch { /* already down */ }
      scheduleRetry(error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  const requireBot = () => {
    if (!bot) throw new Error('QQ 机器人未连接');
    return bot;
  };

  return {
    get status() { return { ...status }; },
    get ready() { return status.ready; },
    async start() { stopping = false; await connect(); },
    async stop() {
      stopping = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      const current = bot;
      bot = null;
      status.ready = false;
      status.state = 'stopped';
      try { current?.stop(); } catch { /* already down */ }
    },
    sendMarkdown(target, text) {
      return sendMarkdownReply(requireBot(), target, text, { logger });
    },
    sendText(target, text) {
      return requireBot().sendText(target, text);
    },
  };
}
