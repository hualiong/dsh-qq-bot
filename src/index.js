// dsh-qq-lite: HOST half. QQ-only bridge for DeepSeek Harness:
//   - one DSH session bound to one QQ private chat (sidebar row menu);
//   - /new [message] creates a session in the configured workspace and binds it;
//   - a QQ message is relayed as the prompt and only the final answer comes back;
//   - send_qq_message lets any session push text to the bound QQ chat;
//   - the plugin page configures the bot (manual AppID/Secret or QR login).
import { join } from 'node:path';

import z from '@deepseek-ai/schemastery';

import { deleteBot, describeStatus, saveBot } from './bot-config.js';
import { createBridge } from './bridge.js';
import { loadOwnConfig, resolveSettings } from './config.js';
import { createProvisioner } from './qq/provision.js';
import { createQqRuntime } from './qq/runtime.js';
import { installRpc } from './rpc.js';
import { createStateStore } from './state.js';
import { installSendTool } from './tools.js';

export const name = 'dsh-qq-lite';
export const inject = ['credentials'];

const Config = z.object({
  appId: z.string().description('QQ 机器人 AppID。留空则使用插件页保存的配置或 dsh-im 的 QQ 集成配置。'),
  secretRef: z.string().description('AppSecret 在 DSH 凭据库中的名称。留空则自动推导。'),
  workspace: z.string().description('新建 QQ 会话使用的默认工作区绝对路径。留空则使用 $DSH_HOME/im。'),
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
    config,
    logger,
    own: null,
    settings: null,
    state: null,
    runtime: null,
    bridge: null,
    lastError: null,
    // Diagnostic counters for /status: proves the global session event feed
    // reaches this plugin without waiting for a turn timeout.
    events: { count: 0, lastType: null },
  };
  let disposed = false;
  let remounting = null;

  // Count every session event this fiber sees; the tracker filters per turn.
  ctx.effect(() => ctx.on('session/event', (_session, event) => {
    holder.events.count += 1;
    holder.events.lastType = typeof event?.type === 'string' ? event.type : null;
  }, { global: true }));

  async function stopBot() {
    const runtime = holder.runtime;
    holder.runtime = null;
    holder.bridge = null;
    try {
      await runtime?.stop();
    } catch (error) {
      logger.warn?.('[dsh-qq-lite] 停止 QQ 连接失败：', error?.message ?? error);
    }
  }

  // Re-resolve the configuration and (re)connect. The state store survives so
  // the bound session is kept across credential changes.
  async function remount() {
    if (remounting) return remounting;
    remounting = (async () => {
      await stopBot();
      holder.own = await loadOwnConfig(holder.config);
      const settings = await resolveSettings(holder.config, holder.own);
      holder.settings = settings;
      holder.lastError = null;
      if (!settings.appId || !settings.secretRef) {
        holder.lastError = '尚未配置 QQ 机器人。';
        return;
      }
      const secret = await ctx.credentials.resolve(settings.secretRef).catch(() => undefined);
      if (!secret?.value) {
        holder.lastError = `凭据 ${settings.secretRef} 不存在，请重新填写 AppSecret。`;
        return;
      }
      const state = holder.state ?? await createStateStore(join(settings.dataDir, 'state.json')).load();
      if (!state.ownerOpenId && settings.ownerOpenId) await state.setOwner(settings.ownerOpenId);
      holder.state = state;
      const runtime = createQqRuntime({
        appId: settings.appId,
        appSecret: secret.value,
        logger,
        onMessage: (message) => void holder.bridge?.accept(message),
      });
      holder.bridge = createBridge({ runtime, state, ctx, settings, logger, stats: holder.events });
      holder.runtime = runtime;
      if (disposed) {
        await runtime.stop();
        return;
      }
      try {
        await runtime.start();
        logger.info?.(`[dsh-qq-lite] QQ 已连接（${settings.appId}），默认工作区 ${settings.workspace}，绑定会话 ${state.sessionId ?? '无'}`);
      } catch (error) {
        holder.lastError = error?.message ?? String(error);
        logger.error?.('[dsh-qq-lite] QQ 首次连接失败，后台会继续重试：', holder.lastError);
      }
      if (disposed) await runtime.stop();
    })().finally(() => { remounting = null; });
    return remounting;
  }
  holder.remount = remount;
  holder.stopBot = stopBot;

  holder.provision = createProvisioner({
    logger,
    onCredentials: async (credentials) => {
      await saveBot(ctx, holder, {
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        ownerOpenId: credentials.ownerOpenId,
      }, logger);
    },
  });

  const startup = remount().catch((error) => {
    logger.error?.('[dsh-qq-lite] 启动失败：', error?.message ?? error);
  });
  void startup;

  ctx.effect(() => () => {
    disposed = true;
    holder.provision?.close();
    void holder.runtime?.stop();
  });

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
