// QQ Bot lifecycle: one WebSocket gateway, and the two send paths the bridge
// needs (markdown answer delivery, short plain notices).
import { QQBot, contentSanitizer, typingIndicator } from '@tencent-connect/qqbot-nodejs';

import { ensureCommandPanel } from './panels.js';
import { sendMarkdownReply } from './reply.js';
import { chunks } from './text.js';

const CONNECT_TIMEOUT_MS = 20_000;
const RETRY_MS = 15_000;
// QQ media upload file_type. A sent image and a sent file use the same
// msg_type 7 path; only this number differs.
const MEDIA_FILE_TYPES = Object.freeze({ image: 1, file: 4 });

export function createQqRuntime({ appId, appSecret, onMessage, onInteraction, logger = console, createBot }) {
  const makeBot = createBot ?? ((options) => new QQBot(options));
  let bot = null;
  let stopping = false;
  let retryTimer = null;
  let profile = null;
  const status = { ready: false, state: 'idle', lastError: null };

  // Public bot profile for the settings page (/users/@me): nickname, avatar,
  // and the share link that carries the bot's QQ number. Decoration only — a
  // failure leaves the page without the avatar, never blocks the connection.
  const readProfile = (instance) => {
    if (typeof instance.api?.get !== 'function') return;
    instance.api.get('/users/@me').then((me) => {
      if (bot !== instance) return;
      profile = {
        id: me?.id ?? null,
        name: me?.username ?? null,
        avatar: me?.avatar ?? null,
        uin: /robot_uin=(\d+)/.exec(me?.share_url ?? '')?.[1] ?? null,
        shareUrl: me?.share_url ?? null,
      };
    }).catch((error) => {
      logger.warn?.('[dsh-qq-bot] 读取机器人资料失败：', error?.message ?? error);
    });
  };

  const scheduleRetry = (error) => {
    if (stopping || retryTimer) return;
    status.state = 'failed';
    status.lastError = error?.message ?? String(error);
    logger.warn?.(`[dsh-qq-bot] QQ 连接失败，${RETRY_MS / 1000} 秒后重试：${status.lastError}`);
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
      status.lastError = null;
      readProfile(instance);
      settle.resolve();
    });
    instance.on('resumed', () => {
      status.ready = true; status.state = 'connected';
      readProfile(instance);
      settle.resolve();
    });
    instance.on('error', (error) => {
      status.lastError = error?.message ?? String(error);
      logger.warn?.('[dsh-qq-bot] QQ 连接错误：', status.lastError);
      if (!status.ready) settle.reject(error);
    });
    // 1.0.5 reports why the socket dropped and whether it will recover; /status
    // shows the reason instead of silently staying "connected".
    instance.on('disconnected', ({ code, reason, willReconnect } = {}) => {
      status.ready = false;
      status.state = willReconnect ? 'connecting' : 'failed';
      status.lastError = `连接断开（${code ?? '?'}${reason ? `：${reason}` : ''}）`;
      logger.warn?.('[dsh-qq-bot] QQ 连接断开：', status.lastError);
    });
    instance.on('message', async (_ctx, message) => { await onMessage(message); });
    // Button taps (see sendKeyboard). Errors inside the bridge must not escape:
    // the SDK event loop is not a place to surface them.
    instance.on('interaction', async (_ctx, event) => {
      try {
        await onInteraction?.(event);
      } catch (error) {
        logger.warn?.('[dsh-qq-bot] 处理按钮点击失败：', error?.message ?? error);
      }
    });
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
    // A dispose during the first connect must not leave a live gateway behind.
    if (stopping) {
      try { instance.stop(); } catch { /* already down */ }
      return;
    }
    // Publish the command panel the QQ client shows after typing "/". It is
    // decoration: a bot without panel permission still answers commands.
    ensureCommandPanel(instance, { logger }).catch((error) => {
      logger.warn?.('[dsh-qq-bot] QQ 指令面板配置失败：', error?.message ?? error);
    });
  };

  const requireBot = () => {
    if (!bot) throw new Error('QQ 机器人未连接');
    return bot;
  };

  return {
    get status() { return { ...status }; },
    get ready() { return status.ready; },
    get profile() { return profile === null ? null : { ...profile }; },
    async start() { stopping = false; await connect(); },
    async stop() {
      stopping = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      const current = bot;
      bot = null;
      profile = null;
      status.ready = false;
      status.state = 'stopped';
      try { current?.stop(); } catch { /* already down */ }
    },
    // async so a disconnected bot rejects instead of throwing past the bridge's
    // .catch (a synchronous throw would become an unhandled rejection).
    async sendMarkdown(target, text) {
      return sendMarkdownReply(requireBot(), target, text, { logger });
    },
    async sendText(target, text) {
      const instance = requireBot();
      for (const part of chunks(text)) await instance.sendText(target, part);
    },
    // One media message: the SDK uploads the source (URL, local path, buffer or
    // data) and sends the resulting file_info as msg_type 7. `caption` becomes
    // the message's text content.
    async sendMedia(target, { kind = 'file', source, caption } = {}) {
      const instance = requireBot();
      if (!source) throw new Error('媒体来源不能为空');
      if (typeof instance.sendMedia !== 'function') throw new Error('当前 QQ SDK 不支持发送图片或文件');
      const location = /^https?:\/\//iu.test(source) ? { url: source } : { localPath: source };
      return instance.sendMedia({
        target,
        fileType: MEDIA_FILE_TYPES[kind] ?? MEDIA_FILE_TYPES.file,
        ...location,
        content: caption,
      });
    },
    // QQ only renders keyboards on markdown messages (msg_type 2): a text body
    // with a keyboard field is rejected, which is why this is not sendTextWithKeyboard.
    async sendKeyboard(target, text, keyboard) {
      return requireBot().sendMarkdown(target, text, { keyboard });
    },
    async acknowledgeInteraction(id, code) {
      await requireBot().acknowledgeInteraction(id, code).catch((error) => {
        logger.warn?.('[dsh-qq-bot] 按钮回执失败：', error?.message ?? error);
      });
    },
    // The only way to retire a button message: QQ has no message-edit API.
    async recallMessage(target, messageId) {
      return requireBot().recallMessage(target, messageId);
    },
    // C2C-only progressive reply: each update() replaces the message body, so
    // the last frame is the answer the user keeps.
    openStream(target, { throttleMs } = {}) {
      return requireBot().openStream({ target, throttleMs });
    },
  };
}
