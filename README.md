# dsh-qq-lite

**只做 QQ 的 DeepSeek Harness 机器人桥。** 从 [@xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)（MIT）里只留下 QQ 私聊这一条链路，去掉其余 13 个渠道、全部机器人管理界面、审批/同步/附件/命令体系，约 2.5k 行。

## 功能

- **一个会话绑定一个 QQ 私聊**：在侧栏任意会话的 `...` 菜单里点「绑定为 QQ 会话」（位于「删除会话」上方），该会话即成为 QQ 会话；同一时间只有一个绑定，换绑会顶替旧的。
- **QQ 侧 `/new` 新建会话**：在配置的默认工作区里立即创建一个 DSH 会话并绑定，回复新会话 ID。
- **只回传最终答案**：QQ 发来的文字会作为 prompt 进入绑定会话；只把该轮「最后一个工具调用之后的最终文本」推回 QQ，不推思考链、不推中间步骤。其他入口（Web 界面、其他会话）的对话不会推到 QQ。
- **`send_qq_message` 工具**：任意会话（无论是否绑定）的 Agent 都可以调用它，向机器人最近说话的 QQ 聊天主动推送纯文本。可在「插件 → QQ 精简版 → 配置」里用开关关闭。

## 安装

```shell
dsh plugin --profile <profile> add @hualiong/dsh-qq-lite
```

也可以从仓库安装：`dsh plugin --profile <profile> add github:hualiong/dsh-qq-lite`，或在插件页面「添加插件」里填包名／仓库地址。

安装后插件行是 `hualiong-dsh-qq-lite`，默认启用；QQ 机器人连上后日志会打印 `[dsh-qq-lite] QQ 已连接`。

## 配置

默认**零配置**：直接复用本机已安装 dsh-im 的 QQ 集成——`$DSH_HOME/integrations/dsh-qq/config.json` 里的 `appId` 与 `secretRef`，密钥本身仍在 DSH 凭据库里；默认工作区取该机器人 `workspaces.json` 里的路径，没有则用 `$DSH_HOME/im`。

需要覆盖时，在插件行配置里填（都是可选的）：

| 字段 | 说明 |
| --- | --- |
| `appId` / `secretRef` | QQ 机器人 AppID 与 AppSecret 的凭据名 |
| `workspace` | `/new` 使用的默认工作区绝对路径 |
| `dataDir` | 插件状态目录，默认 `$DSH_HOME/integrations/dsh-qq-lite` |
| `ownerOpenId` | 允许使用机器人的 QQ 用户 openid；留空则第一个发私信的人自动认领 |
| `replyTimeoutMs` | 单轮回复的最长静默时间，默认 10 分钟 |
| `toolEnabled` | 是否向 Agent 暴露 `send_qq_message`，可在插件页随时开关 |

## QQ 命令

| 命令 | 作用 |
| --- | --- |
| `/new` | 在默认工作区新建会话并绑定到本聊天 |
| `/status` | 查看 QQ 连接、绑定会话、默认工作区 |
| `/unbind` | 解除 QQ 绑定 |
| `/help` | 显示帮助 |

普通文字直接进入绑定会话。

## 限制

- 仅支持 QQ **私聊（C2C）**；群聊、频道、图片、文件、审批、提问、排队插话、会话同步都不在范围内。
- 同一个 QQ 机器人只能被一个插件实例连接：同时启用 dsh-im 的 QQ 渠道会互踢，请只保留一个。
- 机器人只能回复「最近说过话的私聊」：`send_qq_message` 在用户先给机器人发过消息之前没有目标，会明确报错。QQ 对主动消息有频率与额度限制。
- 长答案按 4500 字符分段，被动回复次数用尽后自动转为主动发送；平台拒绝 Markdown 时逐条回退纯文本（这两段逻辑移植自 dsh-im，行为未改）。

## 开发

```shell
node --test test/
```

`test/` 覆盖最终答案提取、Markdown 分段与回退、状态持久化、凭据发现、以及 `askSession` 的回合归属/超时。

## 许可

MIT。`src/qq/reply.js`、`src/qq/tracker.js` 及其测试移植自 dsh-im，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
