// Inbound QQ messages: owner claim, dedupe, the four commands, and the
// request/response relay for ordinary text. One prompt at a time per chat, so
// answer order matches message order.
import { ALIASES, COMMANDS } from './commands.js';
import { askSession, createSession, turnFailureText, userFacingError } from './dsh.js';
import { modelListText, switchModel } from './model-command.js';

const HELP = [
  '**QQ 机器人命令**',
  '',
  ...COMMANDS.map(({ command, desc }) => `- \`${command}\` ${desc}`),
  '',
  '在 QQ 输入 `/` 可打开指令面板；直接发送文字即可与绑定的 DSH 会话对话。',
].join('\n');

const NO_BINDING = '还没有绑定会话：在 DSH 侧栏会话菜单里点「绑定QQ会话」，或发送 /new 新建一个。';

// QQ c2c passive replies stay valid for 60 minutes (4 replies per msg_id);
// after that a reply must be proactive (no msgId). 55 minutes keeps a margin.
export const PASSIVE_WINDOW_MS = 55 * 60_000;

export function replyTargetFor(replyTarget, elapsedMs) {
  if (elapsedMs <= PASSIVE_WINDOW_MS) return replyTarget;
  return { scope: replyTarget.scope, targetId: replyTarget.targetId };
}

// A panel item's name is filled into the chat box with the "/" the QQ client
// shows for command items, so "/new" and "new" are the same command, and only
// the slash form may carry arguments ("/new 你好"). A bare alias followed by
// text ("new 你好") stays a prompt: the user's sentence must not be eaten.
function commandOf(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const [word, ...rest] = trimmed.split(/\s+/u);
  if (trimmed.startsWith('/')) {
    const bare = word.replace(/^\/+/u, '').toLowerCase();
    return { name: ALIASES.get(bare) ?? word.toLowerCase(), args: rest.join(' ') };
  }
  const name = ALIASES.get(trimmed.toLowerCase());
  return name ? { name, args: '' } : null;
}

export function createBridge({ runtime, state, ctx, settings, logger = console, stats }) {
  const accepted = new Set();
  let queue = Promise.resolve();

  const send = (message, text) => runtime.sendText(message.replyTarget, text).catch((error) => {
    logger.warn?.('[dsh-qq-bot] QQ 回复发送失败：', error?.message ?? error);
  });

  // sendMarkdownReply already retries plain text after a markdown rejection and
  // refuses retries when delivery is uncertain, so never resend here.
  const sendMarkdown = (message, text) => runtime.sendMarkdown(message.replyTarget, text).catch((error) => {
    logger.warn?.('[dsh-qq-bot] Markdown 回复发送失败：', error?.message ?? error);
  });

  const deliverTarget = (message, startedAt) => replyTargetFor(message.replyTarget, Date.now() - startedAt);

  async function claimOwner(sender) {
    if (!state.ownerOpenId) {
      await state.setOwner(sender);
      return true;
    }
    return state.ownerOpenId === sender;
  }

  async function answer(message, sessionId, text, startedAt) {
    try {
      const result = await askSession(ctx, sessionId, text, { timeoutMs: settings.replyTimeoutMs });
      const target = deliverTarget(message, startedAt);
      if (result.text) {
        try {
          await runtime.sendMarkdown(target, result.text);
        } catch (error) {
          // sendMarkdownReply only throws when nothing was delivered, so a
          // plain-text retry cannot duplicate the answer.
          logger.warn?.('[dsh-qq-bot] Markdown 回复失败，改用纯文本：', error?.message ?? error);
          await runtime.sendText(target, result.text).catch((fallbackError) => {
            logger.warn?.('[dsh-qq-bot] QQ 回复发送失败：', fallbackError?.message ?? fallbackError);
          });
        }
        return;
      }
      return runtime.sendText(target, result.reason?.kind === 'completed'
        ? '本轮处理已结束，没有文本回复。'
        : turnFailureText(result.reason)).catch((error) => {
        logger.warn?.('[dsh-qq-bot] QQ 回复发送失败：', error?.message ?? error);
      });
    } catch (error) {
      logger.warn?.('[dsh-qq-bot] 处理消息失败：', error?.message ?? error);
      return runtime.sendText(deliverTarget(message, startedAt), userFacingError(error)).catch((sendError) => {
        logger.warn?.('[dsh-qq-bot] QQ 回复发送失败：', sendError?.message ?? sendError);
      });
    }
  }

  async function command(message, name, args, startedAt) {
    if (name === '/help') return sendMarkdown(message, HELP);
    if (name === '/status') {
      const status = runtime.status;
      return sendMarkdown(message, [
        '**QQ 机器人状态**',
        '',
        `- 连接：${status.ready ? '**已连接**' : `未连接（\`${status.state}\`）`}`,
        `- 绑定会话：\`${state.sessionId ?? '无'}\``,
        `- 默认工作区：\`${settings.workspace}\``,
        stats ? `- 事件流：${stats.count}${stats.lastType ? `（最近 \`${stats.lastType}\`）` : ''}` : null,
        status.lastError ? `- 最近错误：${status.lastError}` : null,
      ].filter(Boolean).join('\n'));
    }
    if (name === '/new') {
      if (!runtime.ready) return sendMarkdown(message, 'QQ 机器人尚未连接，暂时无法新建会话。');
      let sessionId;
      try {
        sessionId = await createSession(ctx, settings.workspace);
        await state.setSession(sessionId);
      } catch (error) {
        logger.warn?.('[dsh-qq-bot] 新建会话失败：', error?.message ?? error);
        return sendMarkdown(message, userFacingError(error));
      }
      // `/new <message>` starts the first turn immediately, which also makes the
      // row appear in DSH's sidebar (a blank row stays hidden).
      if (args) return answer(message, sessionId, args, startedAt);
      return sendMarkdown(message, [
        '已新建会话并绑定到本聊天。',
        '',
        `- 会话：\`${sessionId}\``,
        `- 工作区：\`${settings.workspace}\``,
        '',
        '侧栏会在本会话第一条消息开始后显示这一行。',
      ].join('\n'));
    }
    if (name === '/model') {
      const sessionId = state.sessionId;
      if (!sessionId) return sendMarkdown(message, NO_BINDING);
      try {
        return sendMarkdown(message, await (args ? switchModel(ctx, sessionId, args) : modelListText(ctx, sessionId)));
      } catch (error) {
        logger.warn?.('[dsh-qq-bot] 切换模型失败：', error?.message ?? error);
        return sendMarkdown(message, userFacingError(error));
      }
    }
    if (name === '/unbind') {
      await state.setSession(null);
      return sendMarkdown(message, '已解除 QQ 绑定。');
    }
    return sendMarkdown(message, `未知命令：\`${name}\`\n\n${HELP}`);
  }

  return {
    async accept(message) {
      if (!message || message.senderIsBot === true || message.kind !== 'c2c') return;
      const messageId = message.messageId;
      const sender = message.senderId;
      if (!messageId || !sender || accepted.has(messageId) || state.hasSeen(messageId)) return;
      accepted.add(messageId);
      // The passive-reply clock starts when the message arrives, not when the
      // queue reaches it.
      const startedAt = Date.now();
      try {
        if (!(await claimOwner(sender))) return send(message, '这个 QQ 机器人已绑定其他用户，无法使用。');
        await state.setTarget({ scope: 'c2c', targetId: sender });
        const text = typeof message.content === 'string' ? message.content.trim() : '';
        if (!text) return send(message, '目前只支持文字消息。');
        // Persist consumption before the prompt reaches the Harness: QQ may
        // redeliver a message, and a redelivered prompt must not run twice.
        await state.markSeen(messageId);
        const cmd = commandOf(text);
        if (cmd) return command(message, cmd.name, cmd.args, startedAt);
        // Capture the binding now: /new or a rebind while this message waits
        // in the queue must not retarget a message the user already sent.
        const sessionId = state.sessionId;
        if (!sessionId) return send(message, NO_BINDING);
        const task = queue.then(() => answer(message, sessionId, text, startedAt));
        queue = task.catch(() => undefined);
        await task;
      } finally {
        accepted.delete(messageId);
      }
    },
  };
}
