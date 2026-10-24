// Inbound QQ messages: owner claim, dedupe, the slash commands, and the
// request/response relay for ordinary text. One prompt at a time per chat, so
// answer order matches message order; /interject is the one escape hatch that
// reaches the running turn as a steer instead of waiting for it to end.
import { ALIASES, COMMANDS } from './commands.js';
import {
  agentStatus, askSession, createSession, listWorkspaceSessions, submitSteer, turnFailureText, userFacingError,
} from './dsh.js';
import { modelListText, switchModel } from './model-command.js';

const HELP = [
  '**QQ 机器人命令**',
  '',
  ...COMMANDS.map(({ command, desc }) => `- \`${command}\` ${desc}`),
  '',
  '在 QQ 输入 `/` 可打开指令面板；直接发送文字即可与绑定的 DSH 会话对话。',
].join('\n');

const NO_BINDING = '还没有绑定会话：在 DSH 侧栏会话菜单里点「绑定QQ会话」，或发送 `/bind new` 新建、`/bind` 查看并切换一个。';

const INTERJECT_USAGE = '用法：`/interject <要插入的消息>`——这条消息会在当前轮次的下一个步骤生效，不打断正在进行的模型输出或工具调用。';

const QUEUED_NOTICE = (position) => [
  `已收到，当前轮次还在进行：这条消息排在第 ${position} 位，本轮结束后会自动开始新的轮次。`,
  '想让它在这一轮的下一个步骤就生效，可以改用 `/interject <内容>` 插话。',
].join('\n');

// The list rows carry the full session id, so a switch is always a copy-paste
// of the id the user just read; no positional references to a stale snapshot.
function bindListText(rows, currentId) {
  if (!rows.length) return '当前工作区没有可绑定的会话，发送 `/bind new` 新建一个。';
  const lines = ['**可绑定会话**', ''];
  for (const row of rows) {
    const title = row.projections?.values?.title || '（无标题）';
    const updated = new Date(row.updatedAt).toLocaleString('zh-CN',
      { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    lines.push(`- ${title}｜${updated}${row.sessionId === currentId ? '｜**当前**' : ''}`);
    lines.push(`  \`${row.sessionId}\``);
  }
  lines.push('', '切换：`/bind <会话ID>`；新建：`/bind new [首轮消息]`');
  return lines.join('\n');
}

// QQ c2c passive replies stay valid for 60 minutes (4 replies per msg_id);
// after that a reply must be proactive (no msgId). 55 minutes keeps a margin.
export const PASSIVE_WINDOW_MS = 55 * 60_000;

export const QUESTION_WINDOW_MS = 3 * 60_000;

// Marks the user text of a QQ-started turn so the agent can tell where the turn
// came from; send_qq_message's description keys off it. Kept terse on purpose:
// it is prepended to every prompt and shows up in the session history.
export const QQ_ORIGIN_MARKER = '[QQ]';

// How long QQ may hold an agent question before handing it back to the Web
// relay: a minute at least (typing an answer takes a while), three at most, so
// a desktop user is not left staring at a frozen turn for the reply timeout.
export function questionWindowMs(replyTimeoutMs = 600_000) {
  return Math.max(60_000, Math.min(QUESTION_WINDOW_MS, replyTimeoutMs - 60_000));
}

export function replyTargetFor(replyTarget, elapsedMs) {
  if (elapsedMs <= PASSIVE_WINDOW_MS) return replyTarget;
  return { scope: replyTarget.scope, targetId: replyTarget.targetId };
}

// A panel item's name is filled into the chat box with the "/" the QQ client
// shows for command items, so "/bind" and "bind" are the same command, and only
// the slash form may carry arguments ("/bind new"). A bare alias followed by
// text ("bind new") stays a prompt: the user's sentence must not be eaten.
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

// --- agent questions ---------------------------------------------------------

// The tool's `header` is the question's title, so it replaces the boilerplate
// heading instead of stacking a second one above it.
const SKIP_TEXT = '0';

const SKIPPED_LINE = '回复「0」跳过这个问题。';

// One question, rendered for QQ: numbered options when the tool supplied them,
// a free-text invitation otherwise.
export function questionText(question, position, total) {
  const title = question.header?.trim();
  const lines = [title ? `**❓ ${title}**` : `**❓ Agent 提问（${position}/${total}）**`, ''];
  lines.push(question.question?.trim() ? question.question : '（模型未提供问题文本）');
  if (question.detail) lines.push('', question.detail);
  const options = Array.isArray(question.options) ? question.options : [];
  if (options.length) {
    lines.push('');
    options.forEach((option, index) => {
      lines.push(`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`);
    });
    lines.push('', question.multiSelect
      ? '回复序号（多选）或直接回复自定义内容'
      : '回复序号或直接回复自定义内容');
    lines.push('', SKIPPED_LINE);
  } else {
    lines.push('', '直接回复你的答案即可。');
  }
  return lines.join('\n');
}

// A QQ reply to the pending question, in the AskUserQuestionAnswerItem shape.
// undefined means "not an answer": the caller re-prompts instead of consuming.
export function parseAnswer(question, text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return undefined;
  const options = Array.isArray(question.options) ? question.options : [];
  // Free-text questions treat every reply (including "0") as the answer.
  if (options.length === 0) return { id: question.id, selected: [], custom: trimmed };
  if (trimmed === SKIP_TEXT) return { id: question.id, selected: [] };
  const parts = trimmed.split(/[\s,，、]+/u).filter(Boolean);
  if (parts.every((part) => /^\d+$/u.test(part))) {
    const picked = [...new Set(parts.map((part) => Number(part) - 1))];
    // A number outside 1..N means the reply was not a clean choice. Re-prompt
    // instead of silently dropping the stray number and answering the rest.
    if (picked.some((index) => index < 0 || index >= options.length)) return undefined;
    if (!question.multiSelect && picked.length > 1) return undefined;
    return { id: question.id, selected: picked.map((index) => options[index].label) };
  }
  // Single-select: custom wins and selected must stay empty. Multi-select: both.
  return { id: question.id, selected: [], custom: trimmed };
}

export function createBridge({ runtime, state, ctx, settings, logger = console, stats }) {
  const accepted = new Set();
  const activeTurns = new Set(); // sessions with a QQ-started turn currently running
  let queue = Promise.resolve();
  let waiting = 0; // messages buffered behind a running turn
  let pendingQuestion = null;

  const send = (message, text) => runtime.sendText(message.replyTarget, text).catch((error) => {
    logger.warn?.('[dsh-qq-bot] QQ 回复发送失败：', error?.message ?? error);
  });

  // sendMarkdownReply already retries plain text after a markdown rejection and
  // refuses retries when delivery is uncertain, so never resend here.
  const sendMarkdown = (message, text) => runtime.sendMarkdown(message.replyTarget, text).catch((error) => {
    logger.warn?.('[dsh-qq-bot] Markdown 回复发送失败：', error?.message ?? error);
  });

  // A turn that ends without an answer is a report, not a reply: quote it so it
  // reads as a notification instead of blending into the conversation.
  const failureNotice = (title, detail) => `⚠️ **${title}**\n\n> ${String(detail).replace(/\n/gu, '\n> ')}`;

  const sendFailure = (target, title, detail) => runtime.sendMarkdown(target, failureNotice(title, detail))
    .catch(async (error) => {
      logger.warn?.('[dsh-qq-bot] Markdown 回复发送失败：', error?.message ?? error);
      await runtime.sendText(target, `${title}：${detail}`).catch((fallbackError) => {
        logger.warn?.('[dsh-qq-bot] QQ 回复发送失败：', fallbackError?.message ?? fallbackError);
      });
    });

  const deliverTarget = (message, startedAt) => replyTargetFor(message.replyTarget, Date.now() - startedAt);

  async function claimOwner(sender) {
    if (!state.ownerOpenId) {
      await state.setOwner(sender);
      return true;
    }
    return state.ownerOpenId === sender;
  }

  // A question arrives long after the last inbound message (the turn is still
  // running), so it must be delivered proactively: the stored c2c target has no
  // passive msg_id left to reply to.
  const questionTimeoutMs = () => questionWindowMs(settings.replyTimeoutMs);

  function settleQuestion(answer) {
    const current = pendingQuestion;
    pendingQuestion = null;
    if (current?.timer) clearTimeout(current.timer);
    current?.resolve(answer);
  }

  function abortQuestion(error) {
    const current = pendingQuestion;
    pendingQuestion = null;
    if (current?.timer) clearTimeout(current.timer);
    current?.reject(error);
  }

  // Each question gets a fresh window: filling in a multi-question form can take
  // a while, and the idle timer must not expire in the middle of it.
  function armQuestionTimer(current) {
    if (current.timer) clearTimeout(current.timer);
    current.timer = setTimeout(() => {
      void runtime.sendText(state.target, '提问等待超时，已交回 DSH 界面处理。').catch(() => undefined);
      abortQuestion(Object.assign(new Error('提问等待超时'), { code: 'timeout' }));
    }, questionTimeoutMs());
    current.timer.unref?.();
  }

  async function promptQuestion(current) {
    armQuestionTimer(current);
    current.sending = true;
    try {
      const question = current.questions[current.index];
      await runtime.sendMarkdown(state.target, questionText(question, current.index + 1, current.questions.length))
        .catch((error) => logger.warn?.('[dsh-qq-bot] 提问转发失败：', error?.message ?? error));
    } finally {
      current.sending = false;
    }
  }

  // waterfall listener: claim an agent question only when it comes from the
  // bound session and that session's turn started in QQ. Anything else returns
  // undefined so the official Web relay answers it.
  async function userQuestion(request) {
    const sessionId = request?.agent?.id ?? null;
    if (!sessionId || sessionId !== state.sessionId) return undefined;
    if (!activeTurns.has(sessionId) || !runtime.ready) return undefined;
    if (!state.target || pendingQuestion) return undefined;
    const questions = (Array.isArray(request.questions) ? request.questions : [])
      .filter((question) => question && typeof question === 'object' && !Array.isArray(question));
    if (questions.length === 0) return undefined;
    let settle;
    let fail;
    const answered = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
    // An abort can land while the first prompt is still uploading, before the
    // await below attaches: keep that rejection handled until then.
    answered.catch(() => undefined);
    const current = {
      sessionId,
      questions,
      index: 0,
      answers: [],
      timer: null,
      sending: false,
      resolve: settle,
      reject: fail,
    };
    const onAbort = () => abortQuestion(Object.assign(new Error('提问已被取消'), { code: 'aborted' }));
    request.signal?.addEventListener('abort', onAbort, { once: true });
    pendingQuestion = current;
    try {
      await promptQuestion(current);
      return { answers: await answered };
    } catch (error) {
      logger.warn?.('[dsh-qq-bot] 提问转发未完成：', error?.message ?? error);
      // Never leave the waterfall hanging: hand the question back to the Web relay.
      return undefined;
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      if (pendingQuestion === current) {
        pendingQuestion = null;
        if (current.timer) clearTimeout(current.timer);
      }
    }
  }

  // Consume one QQ reply for the pending question; true when it was an answer.
  async function answerQuestion(message, text) {
    const current = pendingQuestion;
    if (!current) return false;
    // A reply that lands while the next question is still uploading would be
    // read against a question the user has not seen yet.
    if (current.sending) {
      await sendMarkdown(message, '正在发送题目，请稍候再回复。');
      return true;
    }
    if (text.startsWith('/') && text.trim() !== SKIP_TEXT) {
      await sendMarkdown(message, '正在等待你回答上面的问题：直接回复选项序号或自定义内容，回复「0」跳过。');
      return true;
    }
    const question = current.questions[current.index];
    const parsed = parseAnswer(question, text);
    if (!parsed) {
      await sendMarkdown(message, `没看懂 \`${text}\`：请回复 1-${question.options.length} 之间的序号，或直接回复自定义内容（回复 0 跳过）。`);
      return true;
    }
    const skipped = parsed.selected.length === 0 && parsed.custom === undefined;
    current.answers.push(parsed);
    current.index += 1;
    if (current.index >= current.questions.length) {
      // A one-line receipt so the user knows the reply landed; the agent keeps
      // going in the background and its result arrives as the turn's answer.
      await sendMarkdown(message, skipped ? '收到，已跳过，继续执行任务。' : '收到，继续执行任务。');
      settleQuestion(current.answers);
      return true;
    }
    if (skipped) await sendMarkdown(message, '收到，已跳过。');
    await promptQuestion(current);
    return true;
  }

  async function answer(message, sessionId, text, startedAt) {
    activeTurns.add(sessionId);
    try {
      const result = await askSession(ctx, sessionId, `${QQ_ORIGIN_MARKER} ${text}`, { timeoutMs: settings.replyTimeoutMs });
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
      if (result.reason?.kind === 'completed') {
        return runtime.sendText(target, '本轮处理已结束，没有文本回复。').catch((error) => {
          logger.warn?.('[dsh-qq-bot] QQ 回复发送失败：', error?.message ?? error);
        });
      }
      return sendFailure(target, '本轮执行异常中断', turnFailureText(result.reason));
    } catch (error) {
      logger.warn?.('[dsh-qq-bot] 处理消息失败：', error?.message ?? error);
      return sendFailure(deliverTarget(message, startedAt), '处理消息失败', userFacingError(error));
    } finally {
      activeTurns.delete(sessionId);
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
    if (name === '/bind') {
      const rest = args.trim();
      // `/bind new [首轮消息]` creates the session: a brand-new one in the
      // configured workspace, bound at once so the next message lands there.
      const create = /^new(?:\s+([\s\S]*))?$/iu.exec(rest);
      if (create) {
        if (!runtime.ready) return sendMarkdown(message, 'QQ 机器人尚未连接，暂时无法新建会话。');
        let sessionId;
        try {
          sessionId = await createSession(ctx, settings.workspace);
          await state.setSession(sessionId);
        } catch (error) {
          logger.warn?.('[dsh-qq-bot] 新建会话失败：', error?.message ?? error);
          return sendMarkdown(message, userFacingError(error));
        }
        // A first message starts the first turn immediately, which also makes
        // the row appear in DSH's sidebar (a blank row stays hidden).
        const firstMessage = (create[1] ?? '').trim();
        if (firstMessage) return answer(message, sessionId, firstMessage, startedAt);
        return sendMarkdown(message, [
          '已新建会话并绑定到本聊天。',
          '',
          `- 会话：\`${sessionId}\``,
          `- 工作区：\`${settings.workspace}\``,
          '',
          '侧栏会在本会话第一条消息开始后显示这一行。',
        ].join('\n'));
      }
      // No argument lists the workspace's sessions; an id switches to that one.
      let rows;
      try {
        rows = await listWorkspaceSessions(ctx, settings.workspace);
      } catch (error) {
        logger.warn?.('[dsh-qq-bot] 读取会话列表失败：', error?.message ?? error);
        return sendMarkdown(message, userFacingError(error));
      }
      if (!rest) return sendMarkdown(message, bindListText(rows, state.sessionId));
      const picked = rows.find((row) => row.sessionId === rest) ?? null;
      if (!picked) return sendMarkdown(message, `没有找到会话 \`${rest}\`。发送 /bind 查看列表。`);
      if (picked.sessionId === state.sessionId) return sendMarkdown(message, '本聊天已经绑定在这个会话。');
      await state.setSession(picked.sessionId);
      return sendMarkdown(message, `已切换至 **${picked.projections?.values?.title || '（无标题）'}**`);
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
    if (name === '/interject') {
      const sessionId = state.sessionId;
      if (!sessionId) return sendMarkdown(message, NO_BINDING);
      const content = args.trim();
      if (!content) return sendMarkdown(message, INTERJECT_USAGE);
      // Nothing to steer on an idle agent: the same text is just a normal prompt.
      if (agentStatus(ctx, sessionId) !== 'running') return answer(message, sessionId, content, startedAt);
      try {
        await submitSteer(ctx, sessionId, content);
        return sendMarkdown(message, '已插话：这条消息会在当前轮次的下一个步骤生效（不会打断正在进行的模型输出或工具调用）。');
      } catch (error) {
        logger.warn?.('[dsh-qq-bot] 插话失败：', error?.message ?? error);
        return sendMarkdown(message, userFacingError(error));
      }
    }
    return sendMarkdown(message, `未知命令：\`${name}\`\n\n${HELP}`);
  }

  return {
    userQuestion,
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
        if (pendingQuestion) {
          await answerQuestion(message, text);
          return;
        }
        const cmd = commandOf(text);
        if (cmd) return command(message, cmd.name, cmd.args, startedAt);
        // Capture the binding now: /bind new or /bind <id> while this message
        // waits in the queue must not retarget a message the user already sent.
        const sessionId = state.sessionId;
        if (!sessionId) return send(message, NO_BINDING);
        // Tell the user when this message is waiting behind a running turn, so
        // a second message is not silently swallowed until the answer comes back.
        const busy = agentStatus(ctx, sessionId) === 'running';
        if (busy) {
          waiting += 1;
          await send(message, QUEUED_NOTICE(waiting));
        }
        const counted = busy;
        const task = queue.then(async () => {
          if (counted) waiting = Math.max(0, waiting - 1);
          return answer(message, sessionId, text, startedAt);
        });
        queue = task.catch(() => undefined);
        await task;
      } finally {
        accepted.delete(messageId);
      }
    },
  };
}
