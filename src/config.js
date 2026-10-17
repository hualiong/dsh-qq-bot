// Credential + workspace discovery.
//
// The installed-but-disabled dsh-im already stores a working QQ bot in
// $DSH_HOME/integrations/dsh-qq: config.json holds the appId and the
// secretRef of a secret that lives in the DSH credential store, and
// workspaces.json holds that bot's workspace. Reading them keeps this plugin
// zero-config; every field can still be overridden from the row config.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_REPLY_TIMEOUT_MS = 600_000;

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null; // absent or malformed integration files are simply not reused
  }
}

export async function resolveSettings(config = {}) {
  const home = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const im = join(home, 'integrations', 'dsh-qq');
  const imConfig = config.appId && config.secretRef ? null : await readJson(join(im, 'config.json'));
  const bot = Array.isArray(imConfig?.bots) ? imConfig.bots[0] : null;

  const botId = bot?.botId ?? null;
  let workspace = config.workspace;
  if (!workspace && botId) {
    const stored = await readJson(join(im, 'workspaces.json'));
    workspace = stored?.workspaces?.[botId];
  }

  const replyTimeoutMs = Number(config.replyTimeoutMs);
  return {
    appId: config.appId ?? bot?.appId ?? null,
    secretRef: config.secretRef ?? bot?.secretRef ?? null,
    workspace: resolve(workspace || join(home, 'im')),
    dataDir: resolve(config.dataDir ?? join(home, 'integrations', 'dsh-qq-lite')),
    ownerOpenId: typeof config.ownerOpenId === 'string' && config.ownerOpenId.trim()
      ? config.ownerOpenId.trim() : null,
    replyTimeoutMs: Number.isFinite(replyTimeoutMs) && replyTimeoutMs > 0
      ? replyTimeoutMs : DEFAULT_REPLY_TIMEOUT_MS,
  };
}
