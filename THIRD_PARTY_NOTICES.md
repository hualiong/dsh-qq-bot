# Third-party notices

`dsh-qq-bot` is a trimmed derivative of [@xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)
(MIT). Files that carry ported code say so in their header:

| File | Origin |
| --- | --- |
| `src/qq/reply.js` | `src/channels/qq/markdown-reply.mjs` and `src/channels/shared/markdown-chunks.mjs` (unchanged behaviour: chunking, passive reply caps, markdown-to-plain fallback). i18n and the `ApiError` import were replaced. |
| `src/qq/tracker.js` | `src/channels/shared/harness-client.mjs` — final-answer extraction and turn ownership. |
| `src/config.js` (identity helpers) | `src/channels/qq/config-store.mjs` — botId/secretRef derivation and AppID masking, so dsh-im-written secrets stay interchangeable. |
| `test/reply.test.mjs`, `test/tracker.test.mjs` | The matching upstream test suites. |

## Runtime dependencies (declared, not vendored)

- `@tencent-connect/qqbot-nodejs` (npm) — QQ Bot WebSocket/HTTP client.
- `@tencent-connect/qqbot-connector` (npm, license field: `UNLICENSED`) — QR-login ("扫码接入"). Used strictly as an installed npm dependency; its code is not copied into this package and it is not included in `files`.
- `qrcode` (MIT) — turns the QQ connect URL into the PNG shown on the plugin page.
- `@deepseek-ai/schemastery` (MIT, shipped with DSH) — the plugin Config schema.

## dsh-im license

MIT License

Copyright (c) 2025 xmanrui

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
