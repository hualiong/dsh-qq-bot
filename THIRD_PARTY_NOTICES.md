# Third-party notices

`dsh-qq-lite` is a trimmed derivative of [@xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)
(version 4.39.0), which is MIT licensed. Files that carry ported code say so in
their header:

| File | Origin |
| --- | --- |
| `src/qq/reply.js` | `src/channels/qq/markdown-reply.mjs` and `src/channels/shared/markdown-chunks.mjs` (unchanged behaviour: chunking, passive reply caps, markdown-to-plain fallback). i18n and the `ApiError` import were replaced. |
| `src/qq/tracker.js` | `src/channels/shared/harness-client.mjs` — `textFromHarnessContent`, `AssistantTextAccumulator`, `accumulateFinalAssistantText`, and the turn-ownership/final-answer part of `HarnessReplyTracker`. |
| `test/reply.test.mjs` | `test/channels/qq/markdown-reply.test.mjs` |
| `test/tracker.test.mjs` | `test/qq-final-answer.test.mjs` and the transferable cases of `test/harness-reply-tracker.test.mjs` |

Everything else (Host wiring, state, bridge, runtime, RPC, tools, client) is
written for this plugin.

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
