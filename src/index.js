// dsh-qq-lite: HOST half. QQ-only bridge for DeepSeek Harness:
//   - one DSH session bound to one QQ private chat (sidebar row menu);
//   - /new creates a session in the configured default workspace and binds it;
//   - a QQ message is relayed as the prompt and only the final answer comes back;
//   - send_qq_message lets any session push text to the bound QQ chat.
// See README.md for the trimmed scope and THIRD_PARTY_NOTICES.md for the code
// ported from @xmanrui/dsh-im.
import { join } from 'node:path';

import z from '@deepseek-ai/schemastery';

import { createBridge } from './bridge.js';
import { resolveSettings } from './config.js';
import { createQqRuntime } from './qq/runtime.js';
import { installRpc } from './rpc.js';
import { createStateStore } from './state.js';
import { installSendTool } from './tools.js';

export const name = 'dsh-qq-lite';
export const inject = ['credentials'];

const Config = z.object({
  appId: z.string().description('QQ 机器人 AppID。留空则复用 dsh-im 的 QQ 集成配置。'),
  secretRef: z.string().description('AppSecret 在 DSH 凭据库中的名称。留空则复用 dsh-im 的 QQ 集成配置。'),
  workspace: z.string().description('新建 QQ 会话使用的默认工作区绝对路径。留空则复用 dsh-im 的机器人工作区，否则为 $DSH_HOME/im。'),
  dataDir: z.string().description('插件状态目录。默认 $DSH_HOME/integrations/dsh-qq-lite。'),
  ownerOpenId: z.string().description('允许使用机器人的 QQ 用户 openid。留空则第一个发私信的用户自动认领。'),
  replyTimeoutMs: z.number().default(600_000).description('等待单轮回复的最长静默时间（毫秒）。'),
  toolEnabled: z.boolean().default(true).volatile().description('向 Agent 暴露 send_qq_message 工具。'),
});

function readRef(value) {
  return typeof value?.get === 'function' ? value.get() : value;
}

export function apply(ctx, config = {}) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : (ctx.logger ?? console);
  const holder = {
    runtime: null,
    state: null,
    settings: null,
    // Diagnostic counters for /status: proves the global session event feed
    // reaches this plugin without waiting for a turn timeout.
    events: { count: 0, lastType: null },
  };
  let disposed = false;

  // Count every session event this fiber sees; the tracker filters per turn.
  ctx.effect(() => ctx.on('session/event', (_session, event) => {
    holder.events.count += 1;
    holder.events.lastType = typeof event?.type === 'string' ? event.type : null;
  }, { global: true }));

  const startup = (async () => {
    const settings = await resolveSettings({
      appId: config.appId,
      secretRef: config.secretRef,
      workspace: config.workspace,
      dataDir: config.dataDir,
      ownerOpenId: config.ownerOpenId,
      replyTimeoutMs: config.replyTimeoutMs,
    });
    if (!settings.appId || !settings.secretRef) {
      throw new Error('缺少 QQ 机器人凭据：请在 dsh-im 的 QQ 集成中配置，或在插件行配置里填写 appId 与 secretRef。');
    }
    const secret = await ctx.credentials.resolve(settings.secretRef);
    if (!secret?.value) throw new Error(`凭据 ${settings.secretRef} 不存在。`);
    const state = await createStateStore(join(settings.dataDir, 'state.json')).load();
    if (!state.ownerOpenId && settings.ownerOpenId) await state.setOwner(settings.ownerOpenId);
    holder.settings = settings;
    holder.state = state;
    if (disposed) return;

    const runtime = createQqRuntime({
      appId: settings.appId,
      appSecret: secret.value,
      logger,
      onMessage: (message) => bridge.accept(message),
    });
    const bridge = createBridge({ runtime, state, ctx, settings, logger, stats: holder.events });
    holder.runtime = runtime;
    try {
      await runtime.start();
      logger.info?.(`[dsh-qq-lite] QQ 已连接（${settings.appId}），默认工作区 ${settings.workspace}，绑定会话 ${state.sessionId ?? '无'}`);
    } catch (error) {
      logger.error?.('[dsh-qq-lite] QQ 首次连接失败，后台会继续重试：', error?.message ?? error);
    }
    if (disposed) await runtime.stop();
  })().catch((error) => {
    logger.error?.('[dsh-qq-lite] 启动失败：', error?.message ?? error);
  });

  ctx.effect(() => () => {
    disposed = true;
    void holder.runtime?.stop();
  });
  void startup;

  ctx.inject(['connection'], (sub) => {
    if (typeof sub.connection?.fetch?.register !== 'function') return;
    sub.effect(() => installRpc(sub, holder));
  });

  ctx.inject(['tools'], (sub) => {
    let dispose = null;
    const sync = () => {
      const enabled = readRef(config.toolEnabled) !== false;
      if (enabled && !dispose) dispose = installSendTool(sub, holder);
      else if (!enabled && dispose) { dispose(); dispose = null; }
    };
    sync();
    sub.effect(() => () => { dispose?.(); dispose = null; });
    // The volatile switch commits into the running config reference; this
    // notification is what makes the tool appear/disappear without a remount.
    ctx.effect(() => ctx.on('loader/volatile-update', sync));
  });
}

export { Config };
