// QQ 指令面板: the platform-owned list the QQ client shows when the user types
// "/" in the chat box. The bot keeps one c2c global panel, marked with our
// remark so a re-start updates it instead of adding duplicates. Failures (for
// example an account without panel permission) are the caller's to log.
import { COMMANDS } from '../commands.js';

const REMARK = 'dsh-qq-lite';

export const COMMAND_ITEMS = Object.freeze(COMMANDS.map(({ name, desc }) => ({
  type: 'command',
  name,
  desc,
})));

export async function ensureCommandPanel(bot, { logger } = {}) {
  const api = bot?.api;
  if (typeof api?.get !== 'function' || typeof api?.post !== 'function' || typeof api?.put !== 'function') return;

  const listed = await api.get('/v2/panels', { scope: 'c2c', limit: 50 });
  const records = Array.isArray(listed?.records) ? listed.records : [];
  const existing = records.find((record) => record?.scope === 'c2c'
    && record?.target_type === 'all'
    && record?.panel?.remark === REMARK);
  const panel = { items: COMMAND_ITEMS.map((item) => ({ ...item })), remark: REMARK };

  if (existing?.panel_id) {
    await api.put(`/v2/panels/${encodeURIComponent(existing.panel_id)}`, { panel });
  } else {
    await api.post('/v2/panels', { scope: 'c2c', target_type: 'all', panel });
  }
  logger?.info?.('[dsh-qq-lite] QQ 指令面板已更新');
}
