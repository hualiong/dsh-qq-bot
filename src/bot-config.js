// Bot configuration actions shared by the RPC page: read a public status,
// store manual credentials, and remove the bot. The runtime/bridge lifecycle
// belongs to the caller (holder.remount / holder.stopBot).
import {
  deriveBotIdentity,
  dshHome,
  maskAppId,
  removeOwnConfig,
  resolveSettings,
  saveOwnConfig,
} from './config.js';
import { join, resolve } from 'node:path';

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function describeStatus(ctx, holder) {
  const settings = holder.settings ?? await resolveSettings(holder.config ?? {}, holder.own ?? null);
  let secretConfigured = false;
  const secretRef = settings.secretRef ?? null;
  if (secretRef) {
    try {
      secretConfigured = (await ctx.credentials.describe?.(secretRef))?.configured === true;
    } catch {
      secretConfigured = false;
    }
  }
  const runtime = holder.runtime?.status ?? { ready: false, state: holder.own ? 'stopped' : 'unconfigured', lastError: null };
  const profile = holder.runtime?.profile ?? null;
  return {
    configured: Boolean(settings.appId && secretConfigured),
    appId: settings.appId ?? null,
    appIdMasked: maskAppId(settings.appId),
    secretConfigured,
    toolEnabled: holder.toolEnabled !== false,
    bot: profile === null ? null : {
      name: profile.name,
      avatar: profile.avatar,
        uin: profile.uin,
      shareUrl: profile.shareUrl,
    },
    workspace: settings.workspace,
    sessionId: holder.state?.sessionId ?? null,
    connected: runtime.ready === true,
    state: runtime.state ?? 'stopped',
    lastError: runtime.lastError ?? holder.lastError ?? null,
    events: holder.events?.count ?? 0,
    lastEvent: holder.events?.lastType ?? null,
  };
}

export async function saveBot(ctx, holder, payload = {}, logger = console) {
  const appId = clean(payload.appId);
  if (!appId) throw new Error('AppID 不能为空。');
  const supplied = typeof payload.appSecret === 'string' ? payload.appSecret.trim() : '';
  const identity = deriveBotIdentity(appId);
  const previous = holder.own ?? {};

  // A blank secret keeps the stored one; a first-time setup must provide it.
  const priorCredential = await ctx.credentials.resolve(identity.secretRef).catch(() => undefined);
  if (supplied) await ctx.credentials.set(identity.secretRef, supplied);
  else if (!priorCredential?.value) throw new Error('首次配置需要填写 AppSecret。');

  const directory = payload.workspace !== undefined ? clean(payload.workspace) : null;
  const doc = {
    version: 1,
    appId,
    secretRef: identity.secretRef,
    workspace: resolve(directory || previous.workspace || holder.settings?.workspace || join(dshHome(), 'im')),
    ownerOpenId: payload.ownerOpenId !== undefined ? clean(payload.ownerOpenId) : (previous.ownerOpenId ?? null),
    createdAt: previous.createdAt ?? new Date().toISOString(),
  };

  try {
    await saveOwnConfig(holder.config ?? {}, doc);
  } catch (error) {
    // Restore the credential so a failed config write leaves no split state.
    if (supplied) {
      if (priorCredential?.value) await ctx.credentials.set(identity.secretRef, priorCredential.value).catch(() => undefined);
      else await ctx.credentials.unset(identity.secretRef).catch(() => undefined);
    }
    throw error;
  }

  holder.own = doc;
  const identityChanged = previous.appId !== appId
    || previous.secretRef !== identity.secretRef
    || Boolean(supplied);
  if (identityChanged) await holder.remount();
  else if (holder.settings) holder.settings.workspace = doc.workspace;
  logger.info?.(`[dsh-qq-bot] 机器人已配置：${doc.appId}`);
  return describeStatus(ctx, holder);
}

export async function deleteBot(ctx, holder, logger = console) {
  await holder.stopBot();
  const secretRef = holder.own?.secretRef ?? holder.settings?.secretRef ?? null;
  await removeOwnConfig(holder.config ?? {});
  holder.own = null;
  holder.settings = null;
  if (secretRef) {
    await ctx.credentials.unset(secretRef).catch((error) => {
      logger.warn?.('[dsh-qq-bot] 删除凭据失败：', error?.message ?? error);
    });
  }
  if (holder.state) {
    await holder.state.setSession(null);
    await holder.state.setOwner(null);
  }
  return describeStatus(ctx, holder);
}
