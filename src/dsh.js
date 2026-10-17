// DSH side of the bridge: create a session in a workspace, submit a prompt, and
// resolve the turn's final answer. Uses the Host services directly, so no RPC
// hop is involved; turn ownership comes from the prompt request id recorded on
// the user message, and completion from that same turn's turn/end.
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { ReplyTracker } from './qq/tracker.js';

const REQUEST_PREFIX = 'qq-lite';

// This plugin's fiber does not inject the session services, so they are read
// through ctx.get (property access would throw "without inject").
function sessions(ctx) {
  const controller = ctx.get?.('sessionController');
  if (!controller) throw new Error('sessionController 服务不可用（需要 DSH 会话功能）。');
  return controller;
}

export async function createSession(ctx, cwd) {
  await mkdir(cwd, { recursive: true });
  const registry = ctx.get('workspaceRegistry');
  // resolveByPath only looks up; register the configured directory when it is
  // not a workspace yet, so the new row lands in the workspace the user sees.
  let workspace;
  if (registry?.resolveByPath) {
    workspace = await registry.resolveByPath(cwd).catch(() => undefined);
    if (!workspace && typeof registry.create === 'function') {
      workspace = await registry.create(cwd).catch(() => undefined);
    }
  }
  const created = await sessions(ctx).create(workspace ? { workspaceId: workspace.id } : { cwd });
  return created.sessionId;
}

function isSessionMissing(error) {
  return error?.code === 'session/not-found'
    || error?.name === 'ApiSessionNotFound'
    || /not found/iu.test(error?.message ?? '');
}

export async function sessionExists(ctx, sessionId) {
  try {
    await sessions(ctx).inspect(sessionId);
    return true;
  } catch (error) {
    if (isSessionMissing(error)) return false;
    if (/sessionController 服务不可用/u.test(error?.message ?? '')) return true; // cannot verify: let the prompt decide
    throw error;
  }
}

/**
 * Submit `text` to `sessionId` and wait for the turn it starts to end.
 * The timeout is a stall window: every event of the tracked turn renews it.
 */
export async function askSession(ctx, sessionId, text, { timeoutMs } = {}) {
  const requestId = `${REQUEST_PREFIX}-${randomUUID()}`;
  const tracker = new ReplyTracker({ requestId });
  let timer = null;
  let settle;
  const finished = new Promise((resolve) => { settle = resolve; });
  const onEvent = (session, event) => {
    if (session?.id !== sessionId || tracker.finished) return;
    if (tracker.consume(event)) arm();
    if (tracker.finished) settle();
  };
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(settle, timeoutMs);
    timer.unref?.();
  };
  const off = ctx.on('session/event', onEvent, { global: true });
  // `sessionController.prompt(request, signal)` insists on an AbortSignal even
  // when called in-process; it only gates admission.
  const admission = new AbortController();
  try {
    await sessions(ctx).prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, admission.signal);
    arm();
    await finished;
    if (!tracker.finished) {
      const error = new Error('等待 Harness 回复超时');
      error.code = 'reply-timeout';
      throw error;
    }
    return { turn: tracker.turn, reason: tracker.reason, text: tracker.finalAnswer };
  } finally {
    if (timer) clearTimeout(timer);
    admission.abort();
    off?.();
  }
}

export function userFacingError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'reply-timeout') return '等待回复超时：任务可能仍在后台运行，稍后可在 DSH 界面查看结果。';
  if (code === 'session/not-found') return '绑定的会话已不存在或已归档。请在侧栏会话菜单重新绑定，或发送 /new 新建一个会话。';
  if (code === 'session/agent-busy') return '绑定的会话正忙，请稍后再试。';
  return `处理失败：${error?.message ?? String(error)}`;
}

export function turnFailureText(reason) {
  switch (reason?.kind) {
    case 'aborted': return '本轮已被停止。';
    case 'max-tokens': return '本轮达到输出上限，没有完整结果。';
    case 'error': return `本轮处理失败：${reason.error?.message ?? '未知错误'}`;
    default: return '本轮未正常完成，没有文本回复。';
  }
}
