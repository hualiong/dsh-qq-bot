# dsh-qq-lite · QQ机器人

**只做 QQ 的 DeepSeek Harness 机器人桥（插件显示名：QQ机器人）。** 从 [@xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)（MIT）里只留下 QQ 私聊这一条链路，去掉其余 13 个渠道与大量管理功能。

## 功能

- **一个会话绑定一个 QQ 私聊**：侧栏会话 `...` 菜单里的「绑定QQ会话」（位于「删除会话」上方），该会话即成为 QQ 会话；同一时间只有一个绑定，换绑会顶替旧的。
- **QQ 侧 `/new [首轮消息]`**：在默认工作区立即创建并绑定会话；附带消息时第一轮直接开始，会话行会立刻出现在侧栏。
- **QQ 指令面板**：机器人连上后在 QQ 平台维护单聊指令面板，输入 `/` 可见 `/new`、`/status`、`/model`、`/unbind`、`/help`，点击填入输入框。
- **`/model`**：列出可用模型（供应商 key、模型 key、思考挡位 id），当前模型行加粗；`/model <供应商>/<模型> [挡位]` 切换当前会话模型，例如 `/model deepseek-account/deepseek-flash high`。
- **会话行 QQ 标记**：被绑定的会话在侧栏标题前显示蓝色的 QQ 机器人图标。
- **只回传最终答案**：QQ 消息作为 prompt 进入绑定会话；只把该轮「最后一个工具调用之后的最终文本」推回 QQ，不推思考链和中间步骤。
- **`send_qq_message` 工具**：任意会话的 Agent 都可调用，向最近说话的 QQ 聊天主动推送纯文本；可在插件详细页关闭。
- **插件详细页配置机器人**：未接入时显示扫码接入 / 手动填写 AppID+AppSecret；已接入后只显示两行机器人信息与「移除接入」，开关和按钮两端对齐；界面复用官方设置字段组件。指令回复统一使用 Markdown（平台拒绝时自动回退纯文本）。

## 安装

```shell
dsh plugin --profile <profile> add @hualiong/dsh-qq-lite
```

也可以从仓库安装：`dsh plugin --profile <profile> add github:hualiong/dsh-qq-lite`，或在插件页面「添加插件」里填包名／仓库地址。

安装后插件行是 `hualiong-dsh-qq-lite`，默认启用；在插件详细页（Configure）里接入 QQ 机器人。

## 配置

首次使用推荐在「插件 → QQ机器人 → 配置」里**扫码接入**；也可以手动填写已有机器人的 AppID/AppSecret。插件自己保存的配置在 `$DSH_HOME/integrations/dsh-qq-lite/config.json`，AppSecret 只写进 DSH 凭据库（`DSH_QQBOT_APP_SECRET_<sha256(appId) 前 24 位大写>`，与 dsh-im 的命名一致）。

未配置时会退回 dsh-im 的 QQ 集成（`$DSH_HOME/integrations/dsh-qq/config.json`）作为零配置来源。行配置里的字段仅作为可选覆盖：

| 字段 | 说明 |
| --- | --- |
| `appId` / `secretRef` | 覆盖插件页保存的 AppID 与凭据名 |
| `workspace` | `/new` 使用的默认工作区绝对路径 |
| `dataDir` | 插件状态目录，默认 `$DSH_HOME/integrations/dsh-qq-lite` |
| `ownerOpenId` | 允许使用机器人的 QQ 用户 openid；留空则第一个发私信的人自动认领（扫码接入会记录扫码人） |
| `replyTimeoutMs` | 单轮回复的最长静默时间，默认 10 分钟 |
| `toolEnabled` | 是否向 Agent 暴露 `send_qq_message`，可在插件页随时开关 |

## QQ 命令

| 命令 | 说明 |
| --- | --- |
| `/new [消息]` | 在默认工作区新建会话并绑定；带消息时立即开始第一轮 |
| `/status` | 查看 QQ 连接、绑定会话、默认工作区、事件流计数 |
| `/model` | 列出可用模型与思考挡位 id，加粗当前模型行 |
| `/model <供应商>/<模型> [挡位]` | 切换当前会话模型；挡位填小写 id（如 `off` / `high`） |
| `/unbind` | 解除 QQ 绑定 |
| `/help` | 显示帮助 |

指令面板项名为 `new` / `status` / `model` / `unbind` / `help`（QQ 客户端自动显示成 `/new` 等），点击后填入输入框；直接输入 `/new` 等同样有效。普通文字直接进入绑定会话。

## 运行方式

- 单聊 C2C；群聊、频道、图片、文件、审批、提问、排队插话、会话同步都不在范围内。
- 同一时间只连接一个 QQ 机器人；不要同时启用 dsh-im 的 QQ 渠道（会互踢）。
- 只回复「最近说过话的私聊」：`send_qq_message` 在用户先给机器人发过消息之前没有目标。
- 被动回复有效期 60 分钟；超时后的长任务改用主动消息（用户可关闭主动消息，且受每日额度限制）。
- 长答案按 4500 字符分段，平台拒绝 Markdown 时回退纯文本；Markdown 完全失败时再回退纯文本重发一次（移植自 dsh-im）。
- 宿主侧（`src/*.js`）改动后需要重启一次 DSH：Host 只在启动时导入插件模块（`plugin_manager` 安装/重装会触发重载）。

## 依赖

`@tencent-connect/qqbot-nodejs`、`@tencent-connect/qqbot-connector`（npm，扫码接入，`UNLICENSED`，仅作为依赖引用、不打包进本仓库）、`qrcode`、`@deepseek-ai/schemastery`。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 开发

```shell
node --test test/
```

`test/` 覆盖最终答案提取、Markdown 分段与回退、状态持久化、配置发现与保存、扫码状态机、管理接口、模型列表/切换、以及 `askSession`/`bridge` 的回合归属与命令路由。

## 许可

MIT。`src/qq/reply.js`、`src/qq/tracker.js`、身份推导等移植自 dsh-im，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
