// The optional agent tool: push one plain-text message to the QQ chat this
// plugin last heard from, from any session, bound or not.
import { chunks } from './qq/text.js';

// A plain definition (the same shape defineTool produces): the Tools service
// validates nothing by itself, so the JSON schema is spelled out here.
const DEFINITION = {
  name: 'send_qq_message',
  description: 'Push a plain-text message to the QQ chat bound to the dsh-qq-lite plugin. Works from any session, whether or not it is the QQ-bound session. Use it to report progress or deliver something the user should see on QQ. The message is delivered immediately, before the current turn ends.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Message text to push to QQ. Plain text; long text is split on line boundaries.',
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

export function installSendTool(ctx, { runtime, state }) {
  return ctx.tools.register({
    ...DEFINITION,
    async execute(args) {
      const text = String(args?.text ?? '').trim();
      if (!text) throw new Error('text 不能为空');
      const target = state?.target;
      if (!target) throw new Error('还没有可用的 QQ 目标：先让机器人在 QQ 私聊中收到一条消息。');
      if (!runtime?.ready) throw new Error('QQ 机器人尚未连接，请稍后再试。');
      const parts = chunks(text);
      await runtime.sendText(target, text);
      return `已推送到 QQ（${parts.length} 条）。`;
    },
  });
}