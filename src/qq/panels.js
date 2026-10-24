// QQ 指令面板: the platform-owned list the QQ client shows when the user types
// "/" in the chat box. The bot keeps one c2c global panel, marked with our
// remark so a re-start updates it instead of adding duplicates. Failures (for
// example an account without panel permission) are the caller's to log.
import { COMMANDS } from '../commands.js';

const REMARK = 'dsh-qq-bot';
// 0.3.x registered its panel under the old plugin name; delete it so the QQ
// client does not show two command panels after the rename.
const LEGACY_REMARK = 'dsh-qq-lite';
// The platform rejects a sixth command item with 40030013 (超出数量限制) even
// though its documentation advertises 20. It also counts a CJK character as two
// of its "characters", so the documented 14/30 caps mean 7/15 Chinese
// characters. The panel is discovery only: every command still works when
// typed, and /help lists the full set.
export const MAX_PANEL_ITEMS = 5;

export const COMMAND_ITEMS = Object.freeze(COMMANDS.slice(0, MAX_PANEL_ITEMS).map(({ name, desc }) => ({
  type: 'command',
  name,
  desc,
})));

export async function ensureCommandPanel(bot, { logger } = {}) {
  const api = bot?.api;
  if (typeof api?.get !== 'function' || typeof api?.post !== 'function' || typeof api?.put !== 'function') return;

  const listed = await api.get('/v2/panels', { scope: 'c2c', limit: 50 });
  const records = Array.isArray(listed?.records) ? listed.records : [];
  const stale = records.filter((record) => record?.scope === 'c2c'
    && record?.target_type === 'all'
    && record?.panel?.remark === LEGACY_REMARK);
  if (typeof api.delete === 'function') {
    for (const record of stale) {
      if (!record?.panel_id) continue;
      await api.delete(`/v2/panels/${encodeURIComponent(record.panel_id)}`).catch(() => undefined);
    }
  }
  const existing = records.find((record) => record?.scope === 'c2c'
    && record?.target_type === 'all'
    && record?.panel?.remark === REMARK);
  const panel = { items: COMMAND_ITEMS.map((item) => ({ ...item })), remark: REMARK };

  if (existing?.panel_id) {
    await api.put(`/v2/panels/${encodeURIComponent(existing.panel_id)}`, { panel });
  } else {
    await api.post('/v2/panels', { scope: 'c2c', target_type: 'all', panel });
  }
  logger?.info?.('[dsh-qq-bot] QQ 指令面板已更新');
}
