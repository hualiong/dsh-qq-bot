// QR provisioning: one active QR-login attempt at a time, polled by the plugin
// page. The SDK owns the wire protocol; this module only tracks state and turns
// the connect URL into a PNG data URL.
import { createRequire } from 'node:module';
import { dirname, sep } from 'node:path';
import { startQrConnect } from '@tencent-connect/qqbot-connector';

const POLL_MS = 1000;
const TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;
const QR_WIDTH = 320;

// qrcode is CommonJS. The Host's module replacement can leave its cache entries
// half-evicted (module.exports stays the empty placeholder object), and an ESM
// import of it cannot repair that. Evict the package once when the cached copy
// is empty, then load it through the plain CommonJS loader.
const requireCjs = createRequire(import.meta.url);

function loadQrCode() {
  const entry = requireCjs.resolve('qrcode');
  const cached = requireCjs.cache?.[entry];
  if (typeof cached?.exports?.toDataURL === 'function') return cached.exports;
  const root = `${dirname(dirname(entry))}${sep}`;
  for (const key of Object.keys(requireCjs.cache ?? {})) {
    if (key.startsWith(root)) delete requireCjs.cache[key];
  }
  return requireCjs('qrcode');
}

const QRCode = loadQrCode();

const encodeQr = (url) => QRCode.toDataURL(url, {
  type: 'image/png',
  errorCorrectionLevel: 'M',
  margin: 2,
  width: QR_WIDTH,
});

export function createProvisioner({
  logger = console,
  onCredentials,
  start = startQrConnect,
  encode = encodeQr,
  now = () => Date.now(),
} = {}) {
  const attempts = new Map();
  let current = null;

  const publicState = (attempt) => (attempt === null ? null : {
    attemptId: attempt.id,
    status: attempt.status,
    qrCodeDataUrl: attempt.qrCodeDataUrl,
    pollIntervalMs: POLL_MS,
    expiresAt: attempt.expiresAt,
    appId: attempt.appId,
    error: attempt.error,
  });

  const keep = (attempt) => {
    attempts.set(attempt.id, attempt);
    while (attempts.size > MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value);
  };

  const stop = (attempt) => {
    if (!attempt) return;
    try { attempt.dispose?.(); } catch { /* already stopped */ }
    try { attempt.controller?.abort(); } catch { /* already aborted */ }
    attempt.dispose = null;
  };

  const settle = (attempt) => {
    attempt.settled = true;
    attempt.resolveFirst?.();
  };

  async function begin({ source = 'dsh-qq-bot' } = {}) {
    if (current) stop(current);
    current = null;

    const attempt = {
      id: `qq-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'starting',
      qrCodeDataUrl: null,
      expiresAt: null,
      appId: null,
      error: null,
      settled: false,
    };
    current = attempt;
    keep(attempt);
    attempt.controller = new AbortController();
    const firstQr = new Promise((resolve) => { attempt.resolveFirst = resolve; });

    attempt.dispose = start({
      onQrDisplayed(url) {
        if (current !== attempt) return;
        attempt.status = 'pending';
        attempt.expiresAt = now() + TTL_MS;
        // The image lands a tick later; the first response may still be bare.
        Promise.resolve(encode(url)).then((dataUrl) => {
          if (current !== attempt) return;
          attempt.qrCodeDataUrl = dataUrl;
          settle(attempt);
        }).catch((error) => {
          if (current !== attempt) return;
          logger.warn?.('[dsh-qq-bot] 二维码生成失败：', error?.message ?? error);
          attempt.status = 'failed';
          attempt.error = '二维码生成失败';
          settle(attempt);
        });
      },
      onQrExpired() {
        if (current !== attempt) return;
        attempt.status = 'refreshing';
        attempt.qrCodeDataUrl = null;
        attempt.expiresAt = null;
      },
      async onSuccess(credentials) {
        if (current !== attempt) return;
        const credential = Array.isArray(credentials) ? credentials[0] : null;
        if (!credential?.appId || !credential?.appSecret) {
          attempt.status = 'failed';
          attempt.error = 'QQ 授权返回的凭据不完整';
          settle(attempt);
          return;
        }
        attempt.status = 'connecting';
        attempt.qrCodeDataUrl = null;
        attempt.expiresAt = null;
        try {
          await onCredentials?.({
            appId: credential.appId,
            appSecret: credential.appSecret,
            ownerOpenId: credential.userOpenid,
          });
          attempt.appId = credential.appId;
          attempt.status = 'connected';
        } catch (error) {
          attempt.status = 'failed';
          attempt.error = error?.message ?? String(error);
        }
        settle(attempt);
      },
      onFailure(error) {
        if (current !== attempt || attempt.status === 'connected') return;
        attempt.status = 'failed';
        attempt.error = error?.message ?? String(error);
        settle(attempt);
      },
    }, {
      displayQrCodeToConsole: false,
      source,
      signal: attempt.controller.signal,
    });

    const timeout = new Promise((resolve) => {
      const timer = setTimeout(resolve, 8_000);
      timer.unref?.();
    });
    await Promise.race([firstQr, timeout]);
    return publicState(attempt);
  }

  return {
    begin,
    poll(attemptId) {
      return publicState(attempts.get(attemptId) ?? null);
    },
    cancel(attemptId) {
      const attempt = attempts.get(attemptId);
      if (!attempt) return null;
      if (current === attempt) stop(current);
      if (current === attempt) current = null;
      if (attempt.status !== 'connected') attempt.status = 'cancelled';
      settle(attempt);
      return publicState(attempt);
    },
    close() {
      if (current) stop(current);
      current = null;
    },
  };
}
