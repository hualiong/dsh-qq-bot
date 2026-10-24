# dsh-qq-bot · QQ机器人

[![npm](https://img.shields.io/npm/v/@hualiong/dsh-qq-bot.svg)](https://www.npmjs.com/package/@hualiong/dsh-qq-bot)
[![license](https://img.shields.io/npm/l/@hualiong/dsh-qq-bot.svg)](LICENSE)

把 **DeepSeek Harness** 的一个会话接到 **QQ 私聊**：QQ 里发消息就是给会话发 prompt，Agent 只把最终答案推回 QQ，也可以在任意会话里用 `send_qq_message` 主动推送。

> A minimal QQ-only bridge for DeepSeek Harness: bind one session to one QQ private chat, start sessions from QQ with `/bind new`, relay only the final answer, and push from any session with the `send_qq_message` tool.

从 [@xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)（MIT）里只留下 QQ 私聊这一条链路，去掉其余 13 个渠道与大量管理功能。

## 功能

- **一个会话绑定一个 QQ 私聊**：侧栏会话 `...` 菜单里的「绑定QQ会话」（位于「删除会话」上方），该会话即成为 QQ 会话；同一时间只有一个绑定，换绑会顶替旧的。
- **QQ 侧 `/bind`**：`/bind` 列出当前工作区可绑定会话，`/bind <会话ID>` 切换绑定，`/bind new [首轮消息]` 在默认工作区立即创建并绑定会话（附带消息时第一轮直接开始，会话行会立刻出现在侧栏）。
- **QQ 指令面板**：机器人连上后在 QQ 平台维护单聊指令面板，输入 `/` 可见 `/bind`、`/status`、`/model`、`/interject`、`/help`，点击填入输入框。
- **`/model`**：列出可用模型（供应商 key、模型 key、思考挡位 id），当前模型行加粗；`/model <供应商>/<模型> [挡位]` 切换当前会话模型，例如 `/model deepseek-account/deepseek-flash high`。
- **会话行 QQ 标记**：被绑定的会话在侧栏标题前显示蓝色的 QQ 机器人图标。
- **只回传最终答案**：QQ 消息作为 prompt 进入绑定会话（正文前带 `[QQ]` 来源标识，Agent 据此判断本轮从 QQ 发起）；只把该轮「最后一个工具调用之后的最终文本」推回 QQ，不推思考链和中间步骤。
- **`send_qq_message` 工具**：向最近说话的 QQ 聊天发送消息、图片或文件，用于用户**明确要求**的通知与交付（例如「有进展通知我」「把刚打包的文件发我」）。`[QQ]` 轮次的最终答复会自动回传，不要用它重复发送答复。支持 Markdown（平台拒绝时回退纯文本），图片/文件填本地路径或 http(s) 链接并可附 `text` 说明；可在「设置 → QQ机器人」里关闭。
- **排队与插话**：QQ 发起的轮次进行中再发消息会自动排队，并按「排在第 N 位」提示，本轮结束后依次开始新轮次；`/interject <消息>` 则把消息插入当前轮次的下一个步骤（不打断正在进行的模型输出或工具调用），与 DSH 的插话发送一致。
- **Agent 提问转发**：QQ 发起的轮次里 Agent 调用 `ask_user_question` 时，问题会转发到 QQ：带选项的选择题回复序号（多选可用逗号分隔，如 `1,3`），也可以直接回复自定义内容；回复「0」跳过该问题。超时或问题被取消时交回 DSH 界面（Web 端）继续处理。
- **设置页配置机器人**：「设置」中的独立「QQ机器人」页。未接入时用扫码接入（切到扫码 tab 即出二维码）/ 手动填写 AppID+AppSecret 两条路径；已接入后展示机器人头像、昵称、状态徽标，以及 `QQ <机器人 QQ 号>`、`AppID <完整 AppID>` 两枚标识徽标，并提供消息推送开关与默认工作区（可用系统目录选择器）。界面复用官方设置页组件与设计变量。
- **异常中断可读通知**：QQ 发起的轮次被停止、达到输出上限、报错或提交失败时，QQ 会收到一条 Markdown 引用块通知（`⚠️ **本轮执行异常中断**` + 引用原因），而不是静默结束。
- **指令回复统一 Markdown**（平台拒绝时自动回退纯文本），长答案自动分段。

## 安装

从 npm（推荐）：

```shell
dsh plugin --profile <profile> add @hualiong/dsh-qq-bot
```

从 GitHub 仓库：

```shell
dsh plugin --profile <profile> add github:hualiong/dsh-qq-bot
```

也可以在 DSH 的「插件」页面里点「添加插件」，填包名 `@hualiong/dsh-qq-bot` 或仓库地址 `github:hualiong/dsh-qq-bot`。

安装后插件行是 `hualiong-dsh-qq-bot`，默认启用；在「设置 → QQ机器人」里接入 QQ 机器人。

> 从 0.4.0 起插件由 `dsh-qq-lite` 更名为 `dsh-qq-bot`。旧的 `$DSH_HOME/integrations/dsh-qq-lite/` 下的配置与会话绑定会在首次启动时自动复制到新目录，QQ 侧旧的指令面板也会被自动删除，无需手工迁移。

## 配置

首次使用推荐在「设置 → QQ机器人」里**扫码接入**；也可以手动填写已有机器人的 AppID/AppSecret。插件自己保存的配置在 `$DSH_HOME/integrations/dsh-qq-bot/config.json`，AppSecret 只写进 DSH 凭据库（`DSH_QQBOT_APP_SECRET_<sha256(appId) 前 24 位大写>`，与 dsh-im 的命名一致）。

未配置时会退回 dsh-im 的 QQ 集成（`$DSH_HOME/integrations/dsh-qq/config.json`）作为零配置来源。行配置里的字段仅作为可选覆盖：

| 字段 | 说明 |
| --- | --- |
| `appId` / `secretRef` | 覆盖设置页保存的 AppID 与凭据名 |
| `workspace` | `/bind new` 使用的默认工作区绝对路径 |
| `dataDir` | 插件状态目录，默认 `$DSH_HOME/integrations/dsh-qq-bot` |
| `ownerOpenId` | 允许使用机器人的 QQ 用户 openid；留空则第一个发私信的人自动认领（扫码接入会记录扫码人） |
| `replyTimeoutMs` | 单轮回复的最长静默时间，默认 10 分钟 |
| `toolEnabled` | 是否向 Agent 暴露 `send_qq_message`；作为设置页开关的初始值，页面上的改动只在本次运行生效 |

## QQ 命令

| 命令 | 说明 |
| --- | --- |
| `/bind` | 列出当前工作区所有可绑定会话（标题、更新时间，标记当前） |
| `/bind <会话ID>` | 切换本聊天绑定的会话；ID 从空参 `/bind` 的列表里复制 |
| `/bind new [消息]` | 在默认工作区新建会话并绑定；带消息时立即开始第一轮 |
| `/status` | 查看 QQ 连接、绑定会话、默认工作区、事件流计数 |
| `/model` | 列出可用模型与思考挡位 id，加粗当前模型行 |
| `/model <供应商>/<模型> [挡位]` | 切换当前会话模型；挡位填小写 id（如 `off` / `high`） |
| `/interject <消息>` | 插话：把消息插入当前轮次的下一个步骤，不打断正在进行的模型输出或工具调用；空闲时等价于直接发消息 |
| `/help` | 显示帮助 |

指令面板项名为 `bind` / `status` / `model` / `interject` / `help`（QQ 客户端自动显示成 `/bind` 等），点击后填入输入框；直接输入 `/bind` 等同样有效。普通文字直接进入绑定会话。Agent 提问等待回答时，下一条文字会被当作答案（序号 / 逗号分隔的多选序号 / 自定义文本 / 「0」跳过）。解绑走 DSH 侧栏会话菜单。

## 运行方式

- 单聊 C2C。群聊、频道、审批、会话同步不在范围内；支持文字、内置图片/文件发送，以及 QQ 发起的轮次中的排队、插话与提问回答。
- 提问转发只在「QQ 发起的轮次」中认领：Agent 提问属于其它来源的会话（例如从 DSH 界面发起的轮次）时，仍由 DSH 界面弹出问题；QQ 侧最多等待约 3 分钟（由 `replyTimeoutMs` 推导，1–3 分钟）或问题被取消时同样交回 DSH 界面。
- 图片/文件按 QQ 平台限制：图片 20MB、文件 200MB，且需要机器人能访问该路径或链接；发送媒体前必须先有 QQ 目标（用户先给机器人发过消息）。本地路径会被原样读取并上传到 QQ，注意不要让 Agent 外带敏感文件。
- 同一时间只连接一个 QQ 机器人；不要同时启用 dsh-im 的 QQ 渠道（会互踢）。
- 只回复「最近说过话的私聊」：`send_qq_message` 在用户先给机器人发过消息之前没有目标。
- 被动回复有效期 60 分钟；超时后的长任务改用主动消息（用户可关闭主动消息，且受每日额度限制）。
- 长答案按 4500 字符分段，平台拒绝 Markdown 时回退纯文本；Markdown 完全失败时再回退纯文本重发一次（移植自 dsh-im）。
- 指令面板每次连接时按 `src/commands.js` 重建：平台对 c2c 面板限制 5 个元素，且中文按 2 个"字符"计算（名称 ≤14、描述 ≤30），超限会整次更新失败（40030013）；新增命令时注意这两条，`test/panels.test.mjs` 会断言。
- 宿主侧（`src/*.js`）改动后需要重启一次 DSH：Host 只在启动时导入插件模块（`plugin_manager` 安装/重装会触发重载）。

## 依赖

`@tencent-connect/qqbot-nodejs`、`@tencent-connect/qqbot-connector`（npm，扫码接入，`UNLICENSED`，仅作为依赖引用、不打包进本仓库）、`qrcode`、`@deepseek-ai/schemastery`。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 开发

```shell
node --test test/*.test.mjs
```

`test/` 覆盖最终答案提取、Markdown 分段与回退、状态持久化、配置发现与保存、旧目录迁移、扫码状态机、管理接口、模型列表/切换、指令面板维护（含元素数量与中文宽度上限），以及 `askSession`/`bridge` 的回合归属与命令路由、排队提示与插话、Agent 提问转发（多题作答、等待窗口、上传中回复）与作答解析、异常中断的引用块通知、图片/文件参数校验与本地文件上限。

## 发布

```shell
npm publish --access public
```

GitHub Actions 使用 `NPM_TOKEN` secret 发布（`npm publish --provenance --access public`）。

## 许可

MIT。`src/qq/reply.js`、`src/qq/tracker.js`、身份推导等移植自 dsh-im，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
