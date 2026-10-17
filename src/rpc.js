// Host half of the sidebar binding UI. The browser authenticates through the
// DSH connection carrier; this route only exposes three actions.
import { sessionExists } from './dsh.js';

const CHANNEL = 'dsh-qq-lite';
const PATH = `/api/${CHANNEL}`;

function reply(rpcId, result) {
  const value = result.ok === false
    ? { ...result, error: { ...result.error, details: result.error.details ?? {} } }
    : result;
  return Response.json({ type: 'server-response', rpcId, result: value });
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

export function installRpc(ctx, holder) {
  const handle = async (method, payload) => {
    const state = holder.state;
    if (!state) return fail('not-ready', '插件尚未就绪，请稍后再试。');
    if (method === 'connection.status') {
      const status = holder.runtime?.status ?? { ready: false, state: 'stopped', lastError: null };
      return {
        ok: true,
        value: {
          connected: status.ready === true,
          state: status.state ?? 'stopped',
          lastError: status.lastError ?? null,
          sessionId: state.sessionId,
          ownerOpenId: state.ownerOpenId,
          workspace: holder.settings?.workspace ?? null,
          appId: holder.settings?.appId ?? null,
        },
      };
    }
    if (method === 'session.bind') {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
      if (!sessionId) return fail('bad-request', 'sessionId 不能为空。');
      if (!(await sessionExists(ctx, sessionId))) return fail('session-not-found', '这个会话不存在或已归档。');
      await state.setSession(sessionId);
      return { ok: true, value: { sessionId } };
    }
    if (method === 'session.unbind') {
      await state.setSession(null);
      return { ok: true, value: { sessionId: null } };
    }
    return fail('bad-request', `未知操作：${String(method)}`);
  };

  return ctx.connection.fetch.register({
    path: PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      let message;
      try { message = await request.json(); } catch { return new Response('body is not JSON', { status: 400 }); }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
      const call = message?.payload;
      if (message?.type !== 'client-request' || message?.method !== CHANNEL
        || !call || typeof call.method !== 'string' || !('payload' in call)) {
        return reply(rpcId, fail('gateway/bad-request', '无效的请求。'));
      }
      try {
        return reply(rpcId, await handle(call.method, call.payload));
      } catch (error) {
        return reply(rpcId, fail('internal', error?.message ?? String(error)));
      }
    },
  });
}
