// The optional agent tool: push one markdown message to the QQ chat this
// plugin last heard from, from any session, bound or not.
import { chunkMarkdownText } from './qq/reply.js';

// A plain definition (the same shape defineTool produces): the Tools service
// validates nothing by itself, so the JSON schema is spelled out here.
const DEFINITION = {
  name: 'send_qq_message',
  description: 'Push a message to the user’s chat through the bound QQ bot. Markdown is supported and the message is delivered immediately. Use it to report progress or deliver something the user should see on QQ.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Markdown message text to push to QQ. Long text is split on line boundaries.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
};

// The holder is mutable: runtime/state are filled after this registration runs,
// so they must be read on every call instead of destructured at install time.
export function installSendTool(ctx, holder) {
  return ctx.tools.register({
    ...DEFINITION,
    async execute(args) {
      const text = String(args?.text ?? '').trim();
      if (!text) throw new Error('text 不能为空');
      const target = holder.state?.target;
      if (!target) throw new Error('还没有可用的 QQ 目标：先让机器人在 QQ 私聊中收到一条消息。');
      if (!holder.runtime?.ready) throw new Error('QQ 机器人尚未连接，请稍后再试。');
      await holder.runtime.sendMarkdown(target, text);
      return `已推送到 QQ（${chunkMarkdownText(text).length} 条）。`;
    },
  });
}
