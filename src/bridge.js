// Inbound QQ messages: owner claim, dedupe, the four commands, and the
// request/response relay for ordinary text. One prompt at a time per chat, so
// answer order matches message order.
import { askSession, createSession, turnFailureText, userFacingError } from './dsh.js';

const HELP = [
  'QQ机器人命令：',
  '/new      在默认工作区新建会话并绑定到本聊天',
  '/status   查看连接与绑定状态',
  '/unbind   解除 QQ 绑定',
  '/help     显示本帮助',
  '在 QQ 输入 / 可打开指令面板；直接发送文字即可与绑定的 DSH 会话对话。',
].join('\n');

const NO_BINDING = '还没有绑定会话：在 DSH 侧栏会话菜单里点「绑定为 QQ 会话」，或发送 /new 新建一个。';

// The QQ command panel fills an item's name into the chat box (a leading "/" is
// stripped by the platform), so the panel names double as command aliases.
const ALIASES = new Map([
  ['新建会话', '/new'],
  ['连接状态', '/status'],
  ['解除绑定', '/unbind'],
  ['显示帮助', '/help'],
]);

function commandOf(text) {
  const trimmed = text.trim();
  const word = trimmed.split(/\s+/u, 1)[0];
  const bare = word.replace(/^\/+/u, '');
  if (ALIASES.has(word)) return ALIASES.get(word);
  if (ALIASES.has(bare)) return ALIASES.get(bare);
  return trimmed.startsWith('/') ? word.toLowerCase() : null;
}

export function createBridge({ runtime, state, ctx, settings, logger = console }) {
  const accepted = new Set();
  let queue = Promise.resolve();

  const send = (message, text) => runtime.sendText(message.replyTarget, text).catch((error) => {
    logger.warn?.('[dsh-qq-lite] QQ 回复发送失败：', error?.message ?? error);
  });

  const sendAnswer = (message, text) => runtime.sendMarkdown(message.replyTarget, text).catch((error) => {
    logger.warn?.('[dsh-qq-lite] QQ 答案发送失败：', error?.message ?? error);
  });

  async function claimOwner(sender) {
    if (!state.ownerOpenId) {
      await state.setOwner(sender);
      return true;
    }
    return state.ownerOpenId === sender;
  }

  async function answer(message, sessionId, text) {
    try {
      const result = await askSession(ctx, sessionId, text, { timeoutMs: settings.replyTimeoutMs });
      if (result.text) {
        await sendAnswer(message, result.text);
        return;
      }
      return send(message, result.reason?.kind === 'completed'
        ? '本轮处理已结束，没有文本回复。'
        : turnFailureText(result.reason));
    } catch (error) {
      logger.warn?.('[dsh-qq-lite] 处理消息失败：', error?.message ?? error);
      return send(message, userFacingError(error));
    }
  }

  async function command(message, name) {
    if (name === '/help') return send(message, HELP);
    if (name === '/status') {
      const status = runtime.status;
      return send(message, [
        `QQ 连接：${status.ready ? '已连接' : `未连接（${status.state}）`}`,
        `绑定会话：${state.sessionId ?? '无'}`,
        `默认工作区：${settings.workspace}`,
        status.lastError ? `最近错误：${status.lastError}` : null,
      ].filter(Boolean).join('\n'));
    }
    if (name === '/new') {
      if (!runtime.ready) return send(message, 'QQ 机器人尚未连接，暂时无法新建会话。');
      try {
        const sessionId = await createSession(ctx, settings.workspace);
        await state.setSession(sessionId);
        return send(message, `已新建会话并绑定到本聊天。\n会话：${sessionId}\n工作区：${settings.workspace}`);
      } catch (error) {
        logger.warn?.('[dsh-qq-lite] 新建会话失败：', error?.message ?? error);
        return send(message, userFacingError(error));
      }
    }
    if (name === '/unbind') {
      await state.setSession(null);
      return send(message, '已解除 QQ 绑定。');
    }
    return send(message, `未知命令：${name}\n\n${HELP}`);
  }

  return {
    async accept(message) {
      if (!message || message.senderIsBot === true || message.kind !== 'c2c') return;
      const messageId = message.messageId;
      const sender = message.senderId;
      if (!messageId || !sender || accepted.has(messageId) || state.hasSeen(messageId)) return;
      accepted.add(messageId);
      try {
        if (!(await claimOwner(sender))) return send(message, '这个 QQ 机器人已绑定其他用户，无法使用。');
        await state.setTarget({ scope: 'c2c', targetId: sender });
        const text = typeof message.content === 'string' ? message.content.trim() : '';
        if (!text) return send(message, '目前只支持文字消息。');
        // Persist consumption before the prompt reaches the Harness: QQ may
        // redeliver a message, and a redelivered prompt must not run twice.
        await state.markSeen(messageId);
        const cmd = commandOf(text);
        if (cmd) return command(message, cmd);
        // Capture the binding now: /new or a rebind while this message waits
        // in the queue must not retarget a message the user already sent.
        const sessionId = state.sessionId;
        if (!sessionId) return send(message, NO_BINDING);
        const task = queue.then(() => answer(message, sessionId, text));
        queue = task.catch(() => undefined);
        await task;
      } finally {
        accepted.delete(messageId);
      }
    },
  };
}