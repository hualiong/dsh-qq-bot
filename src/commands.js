// One table for the QQ commands. `name` is the QQ command-panel item name: the
// platform strips a leading "/" there and the QQ client renders "/name" for
// command items, so the panel shows /new, /status, ... and fills the chat box
// with that same text. Keep the names in sync with the slash commands.
export const COMMANDS = Object.freeze([
  { command: '/new', name: 'new', desc: '新建会话，可附带首轮消息' },
  { command: '/status', name: 'status', desc: '查看连接与绑定状态' },
  { command: '/model', name: 'model', desc: '查看或切换当前会话模型' },
  { command: '/rebind', name: 'rebind', desc: '列出工作区会话，带参切换绑定' },
  { command: '/help', name: 'help', desc: '显示可用命令' },
]);

export const ALIASES = new Map(COMMANDS.map((item) => [item.name, item.command]));
