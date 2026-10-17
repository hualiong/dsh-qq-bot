// QQ 指令面板: the platform-owned list the QQ client shows when the user types
// "/" in the chat box. The bot keeps one c2c global panel, marked with our
// remark so a re-start updates it instead of adding duplicates.
//
// Item names cannot carry a leading "/" (the platform strips it), and a command
// item fills the chat box with its name, so the names are the Chinese aliases
// the bridge also accepts. Failures (for example an account without panel
// permission) are the caller's to log.
const REMARK = 'dsh-qq-lite';

export const COMMAND_ITEMS = Object.freeze([
  { type: 'command', name: '新建会话', desc: '新建会话并绑定到本聊天' },
  { type: 'command', name: '连接状态', desc: '查看连接与绑定状态' },
  { type: 'command', name: '解除绑定', desc: '解除 QQ 绑定' },
  { type: 'command', name: '显示帮助', desc: '显示可用命令' },
]);

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
