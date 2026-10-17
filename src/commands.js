// One table for the four commands. `name` is the QQ command-panel item name:
// the platform fills it into the chat box when clicked (a leading "/" is not
// allowed there), so it doubles as the alias the bridge accepts.
export const COMMANDS = Object.freeze([
  { command: '/new', name: '新建会话', desc: '新建会话并绑定到本聊天' },
  { command: '/status', name: '连接状态', desc: '查看连接与绑定状态' },
  { command: '/unbind', name: '解除绑定', desc: '解除 QQ 绑定' },
  { command: '/help', name: '显示帮助', desc: '显示可用命令' },
]);

export const ALIASES = new Map(COMMANDS.map((item) => [item.name, item.command]));
