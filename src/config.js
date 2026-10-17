// Bot configuration: our own single-bot store first, the row config next, and
// the installed dsh-im QQ integration as a zero-config fallback.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const DEFAULT_REPLY_TIMEOUT_MS = 600_000;

export function dshHome() {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
}

export function dataDirFor(config = {}) {
  return resolve(config.dataDir ?? join(dshHome(), 'integrations', 'dsh-qq-lite'));
}

export function ownConfigPath(config = {}) {
  return join(dataDirFor(config), 'config.json');
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null; // absent or malformed files are simply not reused
  }
}

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** dsh-im's identity scheme, kept so its stored secret stays interchangeable. */
export function deriveBotIdentity(appId) {
  const digest = createHash('sha256').update(appId).digest('hex').slice(0, 24);
  return {
    botId: `qq_${digest}`,
    secretRef: `DSH_QQBOT_APP_SECRET_${digest.toUpperCase()}`,
  };
}

export function maskAppId(appId) {
  const value = clean(appId) ?? '';
  if (!value) return null;
  if (value.length <= 10) return `${value.slice(0, 3)}•••`;
  return `${value.slice(0, 6)}••••${value.slice(-4)}`;
}

/** Our own store, written by the plugin's configuration page or the QR flow. */
export async function loadOwnConfig(config = {}) {
  const doc = await readJson(ownConfigPath(config));
  if (!doc || doc.version !== 1) return null;
  const appId = clean(doc.appId);
  const secretRef = clean(doc.secretRef);
  if (!appId || !secretRef) return null;
  const expected = deriveBotIdentity(appId).secretRef;
  if (secretRef !== expected) return null; // stale/inconsistent identity
  return {
    appId,
    secretRef,
    workspace: clean(doc.workspace),
    ownerOpenId: clean(doc.ownerOpenId),
    createdAt: clean(doc.createdAt) ?? new Date().toISOString(),
  };
}

export async function saveOwnConfig(config = {}, doc) {
  const directory = dataDirFor(config);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = ownConfigPath(config);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

export async function removeOwnConfig(config = {}) {
  try {
    await unlink(ownConfigPath(config));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function resolveSettings(config = {}, own = null) {
  const home = dshHome();
  const im = join(home, 'integrations', 'dsh-qq');
  const needFallback = !own?.appId || !own?.secretRef;
  const imConfig = needFallback && !(config.appId && config.secretRef)
    ? await readJson(join(im, 'config.json')) : null;
  const bot = Array.isArray(imConfig?.bots) ? imConfig.bots[0] : null;

  const botId = bot?.botId ?? null;
  let workspace = own?.workspace ?? config.workspace;
  if (!workspace && botId) {
    const stored = await readJson(join(im, 'workspaces.json'));
    workspace = stored?.workspaces?.[botId];
  }

  const replyTimeoutMs = Number(config.replyTimeoutMs);
  return {
    appId: own?.appId ?? config.appId ?? bot?.appId ?? null,
    secretRef: own?.secretRef ?? config.secretRef ?? bot?.secretRef ?? null,
    workspace: resolve(workspace || join(home, 'im')),
    dataDir: dataDirFor(config),
    ownerOpenId: own?.ownerOpenId ?? (clean(config.ownerOpenId) ?? null),
    replyTimeoutMs: Number.isFinite(replyTimeoutMs) && replyTimeoutMs > 0
      ? replyTimeoutMs : DEFAULT_REPLY_TIMEOUT_MS,
  };
}
