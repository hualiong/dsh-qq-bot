// The optional agent tool: push one message to the QQ chat this plugin last
// heard from, from any session, bound or not. Text is Markdown; `image` and
// `file` take an http(s) URL or an absolute path on this machine.
import { existsSync } from 'node:fs';

import { chunkMarkdownText } from './qq/reply.js';

// A plain definition (the same shape defineTool produces): the Tools service
// validates nothing by itself, so the JSON schema is spelled out here.
const DEFINITION = {
  name: 'send_qq_message',
  description: 'Push a message to the user’s chat through the bound QQ bot. `text` supports Markdown and is delivered immediately; `image` and `file` accept an http(s) URL or an absolute path on this machine, are uploaded and sent right away, and use `text` as their caption. Use it to report progress or deliver something the user should see on QQ.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Markdown text to push to QQ (also the caption when image/file is sent). Long text is split on line boundaries.',
      },
      image: {
        type: 'string',
        description: 'Image to send: an http(s) URL or an absolute local path.',
      },
      file: {
        type: 'string',
        description: 'File to send: an http(s) URL or an absolute local path.',
      },
    },
    additionalProperties: false,
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
};

// image and file are mutually exclusive; a local source must exist so the model
// gets a clear error instead of a failed upload.
function mediaSource(args) {
  const image = String(args?.image ?? '').trim();
  const file = String(args?.file ?? '').trim();
  if (image && file) throw new Error('image 和 file 只能提供其中一个');
  if (!image && !file) return null;
  const source = image || file;
  const remote = /^https?:\/\//iu.test(source);
  if (!remote && !existsSync(source)) throw new Error(`本地文件不存在：${source}`);
  return { kind: image ? 'image' : 'file', source, remote };
}

// The holder is mutable: runtime/state are filled after this registration runs,
// so they must be read on every call instead of destructured at install time.
export function installSendTool(ctx, holder) {
  return ctx.tools.register({
    ...DEFINITION,
    async execute(args) {
      const text = String(args?.text ?? '').trim();
      const media = mediaSource(args);
      if (!text && !media) throw new Error('text、image、file 至少提供一个');
      const target = holder.state?.target;
      if (!target) throw new Error('还没有可用的 QQ 目标：先让机器人在 QQ 私聊中收到一条消息。');
      if (!holder.runtime?.ready) throw new Error('QQ 机器人尚未连接，请稍后再试。');
      if (media) {
        try {
          await holder.runtime.sendMedia(target, {
            kind: media.kind,
            source: media.source,
            caption: text || undefined,
          });
        } catch (error) {
          throw new Error(`QQ 媒体发送失败：${error?.message ?? String(error)}`);
        }
        return `已通过 QQ 发送${media.kind === 'image' ? '图片' : '文件'}${text ? '（附说明文字）' : ''}。`;
      }
      await holder.runtime.sendMarkdown(target, text);
      return `已推送到 QQ（${chunkMarkdownText(text).length} 条）。`;
    },
  });
}
