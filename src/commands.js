// One table for the QQ commands. `name` is the QQ command-panel item name: the
// platform strips a leading "/" there and the QQ client renders "/name" for
// command items, so the panel shows /bind, /status, ... and fills the chat box
// with that same text. Keep the names in sync with the slash commands.
export const COMMANDS = Object.freeze([
  { command: '/bind', name: 'bind', desc: '绑定会话：new 新建 / ID 换绑' },
  { command: '/status', name: 'status', desc: '查看连接与绑定状态' },
  { command: '/model', name: 'model', desc: '查看或切换当前会话模型' },
  { command: '/interject', name: 'interject', desc: '插话：在下一步插入消息' },
  { command: '/help', name: 'help', desc: '显示可用命令' },
]);

export const ALIASES = new Map(COMMANDS.map((item) => [item.name, item.command]));
