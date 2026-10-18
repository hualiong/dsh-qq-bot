// Host half of the plugin page and the sidebar binding UI. The browser
// authenticates through the DSH connection carrier; every response is a plain
// value that never carries the AppSecret.
import { deleteBot, describeStatus, saveBot } from './bot-config.js';
import { sessionExists } from './dsh.js';

const CHANNEL = 'dsh-qq-lite';
const PATH = `/api/${CHANNEL}`;
const VERSION = '0.3.1'; // keep in step with package.json; shown in the status payload

function reply(rpcId, result) {
  const value = result.ok === false
    ? { ...result, error: { ...result.error, details: result.error.details ?? {} } }
    : result;
  return Response.json({ type: 'server-response', rpcId, result: value });
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

const ok = (value) => ({ ok: true, value });

export function installRpc(ctx, holder) {
  const logger = holder.logger ?? console;

  const status = async () => ok({ version: VERSION, ...(await describeStatus(ctx, holder)) });

  const handle = async (method, payload) => {
    if (method === 'connection.status') return status();

    if (method === 'bot.save') return ok(await saveBot(ctx, holder, payload, logger));
    if (method === 'bot.delete') return ok(await deleteBot(ctx, holder, logger));

    if (method === 'provision.begin') return ok(await holder.provision.begin({ source: CHANNEL }));
    if (method === 'provision.poll') {
      const value = holder.provision.poll(payload?.attemptId);
      return value ? ok(value) : fail('bad-request', '该扫码任务已失效，请重新发起。');
    }
    if (method === 'provision.cancel') {
      const value = holder.provision.cancel(payload?.attemptId);
      return value ? ok(value) : fail('bad-request', '该扫码任务已失效。');
    }

    if (method === 'tools.set') {
      if (typeof payload?.enabled !== 'boolean') return fail('bad-request', 'enabled 必须是布尔值。');
      holder.toolEnabled = payload.enabled;
      holder.syncTools?.();
      return status();
    }

    const state = holder.state;
    if (!state) return fail('not-ready', '插件尚未就绪，请稍后再试。');

    if (method === 'session.bind') {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
      if (!sessionId) return fail('bad-request', 'sessionId 不能为空。');
      if (!(await sessionExists(ctx, sessionId))) return fail('session-not-found', '这个会话不存在或已归档。');
      await state.setSession(sessionId);
      return ok({ sessionId });
    }
    if (method === 'session.unbind') {
      await state.setSession(null);
      return ok({ sessionId: null });
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
