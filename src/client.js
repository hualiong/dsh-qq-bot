// dsh-qq-lite: CLIENT half.
//
//   sidebar.session.row.leading           — QQ mark on the bound session row
//   sidebar.workspaces.session.menu.item  — bind / unbind that session
//   settings.section (id "dsh-qq-lite")   — bot status, connect flow, push toggle, workspace
//
// Binding is one global slot: the row already bound turns the menu item into
// unbind and keeps the mark. The settings page reads and writes the bot through
// the Host's authenticated /api carrier and reuses the official primitives so it
// sits next to the shipped settings pages.
window.__ModuleLoader__.load({
  id: '@hualiong/dsh-qq-lite',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState, useSyncExternalStore } = React
    const h = React.createElement
    const {
      Button,
      IconLinkOutlineRegular,
      MenuItemButton,
      Modal,
      SegmentedControl,
      SettingsForm,
      SettingsSecretField,
      SettingsValueField,
      Switch,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'dsh-qq-lite'
    const MEMBER_ROW_ID = 'hualiong-dsh-qq-lite'
    const LEADING_SLOT = 'sidebar.session.row.leading'
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const SETTINGS_SLOT = 'settings.section'
    const RPC_CHANNEL = 'dsh-qq-lite'
    const STATUS_POLL_MS = 10_000
    const QR_POLL_MS = 1_000
    const QR_SOURCE = /^data:image\/(?:png|webp);base64,[a-z\d+/]+={0,2}$/i

    const zh = {
      'nav': 'QQ 机器人',
      'title': 'QQ 机器人',
      'intro': '把 DeepSeek Harness 的会话接到 QQ 私聊：绑定一个会话后，Agent 的最终回答会推送到 QQ；也可以在 QQ 里用 /new 新建会话。',
      'loading': '正在读取接入状态…',
      'menu.bind': '绑定 QQ 会话',
      'menu.unbind': '解绑 QQ 会话',
      'row.bound': 'QQ 会话',
      'status.title': '当前接入',
      'status.on': '已连接',
      'status.off': '未连接',
      'status.bot': '机器人',
      'status.error': '最近错误',
      'status.pending': '已保存 AppID，还缺 AppSecret：在下方「手动填写」里补上即可完成接入。',
      'connect.title': '接入机器人',
      'connect.description': '扫码会自动创建并接入机器人；已经有机器人时，可以手动填写凭据。',
      'connect.saved': '已保存，正在接入 QQ 机器人。',
      'connect.mode': '接入方式',
      'connect.qr': '扫码接入',
      'connect.manual': '手动填写',
      'connect.qrDesc': '用手机 QQ 扫码，确认后自动创建并接入机器人；二维码过期会自动刷新。',
      'connect.qrStart': '生成二维码',
      'connect.qrStarting': '正在生成二维码…',
      'connect.qrPending': '请用手机 QQ 扫码。',
      'connect.qrCancel': '取消',
      'connect.qrFailed': '扫码接入失败',
      'connect.qrConnected': 'QQ 机器人已接入。',
      'connect.manualDesc': '已有 QQ 机器人时填写凭据。AppSecret 只保存在 DSH 凭据库，不会写入设置文件；已配置时留空表示不修改。',
      'manual.appId': 'AppID',
      'manual.appIdHint': 'QQ 开放平台的机器人 AppID。',
      'manual.appIdPlaceholder': '例如 1905390910',
      'manual.secret': 'AppSecret',
      'manual.secretHint': '不写入设置文件；首次接入必须填写。',
      'manual.secretConfigured': '已配置密钥',
      'manual.secretUnconfigured': '未配置密钥',
      'manual.workspace': '默认工作区',
      'manual.workspaceHint': '/new 新建会话使用的绝对路径；留空使用 $DSH_HOME/im。',
      'manual.workspacePlaceholder': 'C:\\path\\to\\workspace',
      'push.title': '消息推送',
      'push.label': '允许 Agent 推送 QQ 消息',
      'push.description': '关闭后 send_qq_message 会从工具列表中移除；QQ 对话与命令不受影响。',
      'bind.title': '绑定会话',
      'bind.description': '在会话列表的「⋯」菜单中选择「绑定 QQ 会话」，该会话的最终回答就会回到 QQ。',
      'bind.action': '解绑',
      'bind.current': '当前绑定',
      'bind.none': '尚未绑定',
      'workspace.title': '默认工作区',
      'workspace.description': '/new 新建的 QQ 会话会创建在这个目录；留空使用 $DSH_HOME/im。',
      'workspace.placeholder': 'C:\\path\\to\\workspace',
      'commands.title': 'QQ 命令',
      'commands.description': '在 QQ 私聊里直接发送这些命令：',
      'cmd.new': '在默认工作区新建会话并绑定，可附上第一条消息',
      'cmd.status': '查看机器人、绑定会话与连接状态',
      'cmd.model': '查看或切换当前会话的模型与推理强度',
      'cmd.unbind': '解除当前的 QQ 绑定',
      'cmd.help': '显示命令帮助',
      'save': '保存',
      'saving': '保存中…',
      'saveFailed': '保存失败',
      'remove.button': '移除接入',
      'remove.title': '移除 QQ 机器人？',
      'remove.description': '将删除本地保存的凭据并断开 QQ 连接，当前绑定的会话会被解除。',
      'remove.confirm': '移除',
      'remove.cancel': '取消',
    }
    const en = {
      'nav': 'QQ bot',
      'title': 'QQ bot',
      'intro': 'Push DeepSeek Harness sessions to a QQ private chat. Bind one session and the Agent’s final answers land in QQ; /new starts a new session from QQ.',
      'loading': 'Reading the connection state…',
      'menu.bind': 'Bind QQ session',
      'menu.unbind': 'Unbind QQ session',
      'row.bound': 'QQ session',
      'status.title': 'Connection',
      'status.on': 'Connected',
      'status.off': 'Disconnected',
      'status.bot': 'Bot',
      'status.error': 'Last error',
      'status.pending': 'The AppID is saved but the AppSecret is missing. Add it under “Manual setup” to finish connecting.',
      'connect.title': 'Connect a bot',
      'connect.description': 'Scanning creates and connects a bot for you; for an existing bot, enter its credentials manually.',
      'connect.saved': 'Saved. Connecting the QQ bot.',
      'connect.mode': 'Setup method',
      'connect.qr': 'Scan to connect',
      'connect.manual': 'Manual setup',
      'connect.qrDesc': 'Scan with mobile QQ to create and connect the bot; the code refreshes itself when it expires.',
      'connect.qrStart': 'Show QR code',
      'connect.qrStarting': 'Creating the QR code…',
      'connect.qrPending': 'Scan with mobile QQ.',
      'connect.qrCancel': 'Cancel',
      'connect.qrFailed': 'QR connect failed',
      'connect.qrConnected': 'QQ bot connected.',
      'connect.manualDesc': 'Enter existing bot credentials. The AppSecret is stored only in the DSH credential store, never in the settings file; leave it blank to keep the current one.',
      'manual.appId': 'AppID',
      'manual.appIdHint': 'The QQ Open Platform bot AppID.',
      'manual.appIdPlaceholder': 'e.g. 1905390910',
      'manual.secret': 'AppSecret',
      'manual.secretHint': 'Never written to settings; required for the first setup.',
      'manual.secretConfigured': 'Configured',
      'manual.secretUnconfigured': 'Not configured',
      'manual.workspace': 'Default workspace',
      'manual.workspaceHint': 'Absolute path used by /new; blank falls back to $DSH_HOME/im.',
      'manual.workspacePlaceholder': 'C:\\path\\to\\workspace',
      'push.title': 'Message push',
      'push.label': 'Let Agents push to QQ',
      'push.description': 'When off, send_qq_message is removed from the tool list; QQ chats and commands are unaffected.',
      'bind.title': 'Bound session',
      'bind.description': 'Pick “Bind QQ session” in a session’s “⋯” menu; that session’s final answers come back to QQ.',
      'bind.action': 'Unbind',
      'bind.current': 'Current binding',
      'bind.none': 'Not bound',
      'workspace.title': 'Default workspace',
      'workspace.description': 'Sessions started with /new are created in this directory; blank falls back to $DSH_HOME/im.',
      'workspace.placeholder': 'C:\\path\\to\\workspace',
      'commands.title': 'QQ commands',
      'commands.description': 'Send these in the QQ private chat:',
      'cmd.new': 'Create and bind a session in the default workspace, with an optional first message',
      'cmd.status': 'Show the bot, bound session, and connection state',
      'cmd.model': 'Show or switch the bound session’s model and reasoning effort',
      'cmd.unbind': 'Drop the current QQ binding',
      'cmd.help': 'Show command help',
      'save': 'Save',
      'saving': 'Saving…',
      'saveFailed': 'Save failed',
      'remove.button': 'Remove bot',
      'remove.title': 'Remove the QQ bot?',
      'remove.description': 'This deletes the saved credentials and disconnects QQ. The bound session is released.',
      'remove.confirm': 'Remove',
      'remove.cancel': 'Cancel',
    }

    const COMMANDS = [
      ['/new [消息]', 'cmd.new'],
      ['/status', 'cmd.status'],
      ['/model [provider/model [effort]]', 'cmd.model'],
      ['/unbind', 'cmd.unbind'],
      ['/help', 'cmd.help'],
    ]

    async function callRpc(connection, method, payload = {}, signal) {
      if (!connection?.rpc?.call) throw new Error('DSH 连接不可用')
      const result = await connection.rpc.call('/api', RPC_CHANNEL, { method, payload }, signal)
      if (result?.ok !== true) throw new Error(result?.error?.message ?? 'QQ 操作失败')
      return result.value
    }

    // --- shared bound-session store -----------------------------------------------

    function createBoundStore() {
      let value = null
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (next === value) return
          value = next
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    // --- QQ mark ------------------------------------------------------------------

    // The session row reserves a 16x20 leading seat. Native glyphs are drawn
    // inset from that 16px width, so keep the 19:21 artwork at 14px wide
    // (15.47px tall) and let the 16x20 seat centre it: 1px of air on each side
    // matches the gap native icons leave before the title.
    const markStyle = { display: 'inline-flex', width: 16, height: 20, alignItems: 'center', justifyContent: 'center' }
    const QQ_BLUE = '#0099FF'
    const QQ_GLYPH_WIDTH = 14
    const QQ_GLYPH_HEIGHT = 15.47

    function QqGlyph() {
      return React.createElement('svg', {
        width: QQ_GLYPH_WIDTH,
        height: QQ_GLYPH_HEIGHT,
        viewBox: '0 0 19 21',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      }, [
        React.createElement('path', {
          key: 'eye-left',
          d: 'M6.85 9.65039C7.31944 9.65039 7.7 10.0309 7.7 10.5004V12.5004C7.7 12.9698 7.31944 13.3504 6.85 13.3504C6.38056 13.3504 6 12.9698 6 12.5004V10.5004C6 10.0309 6.38056 9.65039 6.85 9.65039Z',
          fill: QQ_BLUE,
        }),
        React.createElement('path', {
          key: 'eye-right',
          d: 'M11.85 9.65039C12.3194 9.65039 12.7 10.0309 12.7 10.5004V12.5004C12.7 12.9698 12.3194 13.3504 11.85 13.3504C11.3806 13.3504 11 12.9698 11 12.5004V10.5004C11 10.0309 11.3806 9.65039 11.85 9.65039Z',
          fill: QQ_BLUE,
        }),
        React.createElement('path', {
          key: 'body',
          d: 'M10.2 3.8109C10.8795 3.49137 11.35 2.80063 11.35 2C11.35 0.895431 10.4545 0 9.34998 0C8.24541 0 7.34998 0.895431 7.34998 2C7.34998 2.80065 7.82044 3.49141 8.5 3.81092V4.68851C3.73448 5.11795 0 9.12306 0 14.0004V15.5004C0 18.179 2.17142 20.3504 4.85 20.3504H13.85C16.5286 20.3504 18.7 18.179 18.7 15.5004V14.0004C18.7 9.12305 14.9655 5.11795 10.2 4.68851V3.8109ZM9.35 6.35039C5.12502 6.35039 1.7 9.77541 1.7 14.0004V15.5004C1.7 17.2401 3.1103 18.6504 4.85 18.6504H13.85C15.5897 18.6504 17 17.2401 17 15.5004V14.0004C17 9.77541 13.575 6.35039 9.35 6.35039Z',
          fill: QQ_BLUE,
          fillRule: 'evenodd',
          clipRule: 'evenodd',
        }),
      ])
    }

    function QqMark({ title }) {
      return React.createElement('span', { style: markStyle, title, 'aria-label': title, role: 'img' },
        React.createElement(QqGlyph))
    }

    function BoundRowMark({ sessionId, store, t }) {
      const bound = useSyncExternalStore(store.subscribe, store.get)
      if (!bound || bound !== sessionId) return null
      return React.createElement(QqMark, { title: t('row.bound') })
    }

    // --- session row menu ---------------------------------------------------------

    function BindMenuItem({ sessionId, useMenuOpenState, connection, store, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      const bound = useSyncExternalStore(store.subscribe, store.get)
      const isBound = bound === sessionId
      const onSelect = useCallback(() => {
        setMenuOpen(false)
        callRpc(connection, isBound ? 'session.unbind' : 'session.bind', isBound ? {} : { sessionId })
          .then(() => store.refresh())
          .catch((error) => { console.warn(`[${NS}] ${t(isBound ? 'menu.unbind' : 'menu.bind')}:`, error) })
      }, [connection, isBound, sessionId, setMenuOpen, store, t])
      return React.createElement(MenuItemButton, {
        onSelect,
        icon: React.createElement(IconLinkOutlineRegular, { size: 14 }),
      }, t(isBound ? 'menu.unbind' : 'menu.bind'))
    }

    // --- settings page styles -----------------------------------------------------

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        maxWidth: 760,
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
      },
      heading: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' },
      intro: {
        margin: 0,
        fontSize: 13,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '14px 16px',
        borderRadius: 'var(--dsw-alias-radius-lg, 12px)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
      },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
      cardTitle: { margin: 0, fontSize: 13, fontWeight: 600, lineHeight: '20px' },
      cardDesc: {
        margin: 0,
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      },
      stateLine: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, lineHeight: '20px' },
      dot: (on) => ({
        display: 'inline-block',
        flex: 'none',
        width: 8,
        height: 8,
        borderRadius: 4,
        background: on
          ? 'var(--dsw-alias-state-success-primary, #21a67a)'
          : 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      }),
      rows: { display: 'grid', gap: 6 },
      row: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 16,
        fontSize: 13,
        lineHeight: '20px',
      },
      rowLabel: { color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', flex: 'none' },
      rowValue: {
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
        textAlign: 'right',
        wordBreak: 'break-all',
      },
      toggleRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        fontSize: 13,
        lineHeight: 1.5,
      },
      toggleLabel: { flex: 1, minWidth: 0 },
      actions: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      qrPanel: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        paddingTop: 2,
      },
      qr: {
        width: 200,
        height: 200,
        borderRadius: 12,
        background: '#ffffff',
        padding: 8,
        boxSizing: 'border-box',
      },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        height: 32,
        padding: '0 10px',
        borderRadius: 'var(--dsw-alias-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
        font: 'inherit',
        fontSize: 13,
        outline: 'none',
      },
      commands: { display: 'grid', gap: 8 },
      command: { display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 13, lineHeight: '20px' },
      code: {
        flex: 'none',
        fontFamily: 'var(--dsw-alias-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 12,
        padding: '1px 6px',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.14))',
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
      },
      commandDesc: { color: 'var(--dsw-alias-label-secondary, #b4b4b4)', minWidth: 0 },
      notice: {
        margin: 0,
        fontSize: 12,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-state-success-primary, #21a67a)',
      },
      error: {
        margin: 0,
        fontSize: 12,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-state-error-primary, #e5484d)',
      },
      danger: { color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
    }

    // --- shared building blocks ---------------------------------------------------

    function Card({ title, description, action, children }) {
      const body = children == null ? [] : (Array.isArray(children) ? children : [children])
      const head = title == null && action == null ? null : h('div', { style: styles.cardHead },
        title == null ? h('span') : h('p', { style: styles.cardTitle }, title),
        action ?? null)
      return h('section', { style: styles.card },
        head,
        description == null ? null : h('p', { style: styles.cardDesc }, description),
        ...body)
    }

    function InfoRow({ label, value, title }) {
      return h('div', { style: styles.row },
        h('span', { style: styles.rowLabel }, label),
        h('span', { style: styles.rowValue, title }, value))
    }

    function shortSession(id) {
      return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id
    }

    // --- settings page ------------------------------------------------------------

    function QqSettingsPage({ t, connection }) {
      const [status, setStatus] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [mode, setMode] = useState('qr')
      const [appId, setAppId] = useState(null)
      const [secret, setSecret] = useState('')
      const [workspace, setWorkspace] = useState(null)
      const [wsText, setWsText] = useState(null)
      const [busy, setBusy] = useState(false)
      const [qrBusy, setQrBusy] = useState(false)
      const [wsBusy, setWsBusy] = useState(false)
      const [bindBusy, setBindBusy] = useState(false)
      const [toolBusy, setToolBusy] = useState(false)
      const [removeBusy, setRemoveBusy] = useState(false)
      const [error, setError] = useState(null)
      const [wsError, setWsError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [wsNotice, setWsNotice] = useState(null)
      const [qr, setQr] = useState(null)
      const [qrError, setQrError] = useState(null)
      const [confirmRemove, setConfirmRemove] = useState(false)

      const refresh = useCallback(() => callRpc(connection, 'connection.status')
        .then((value) => { setStatus(value); setLoadError(null) })
        .catch((failure) => setLoadError(failure.message)), [connection])

      useEffect(() => { refresh() }, [refresh])

      // A saved AppID without a secret can only be finished by typing the secret in.
      useEffect(() => {
        if (status?.appId && status.configured === false) setMode('manual')
      }, [status?.appId, status?.configured])

      // The page shows the live connection dot, so re-read it while it is open.
      useEffect(() => {
        const timer = setInterval(() => { refresh() }, STATUS_POLL_MS)
        return () => clearInterval(timer)
      }, [refresh])

      useEffect(() => {
        if (!qr?.attemptId) return undefined
        let stopped = false
        const timer = setInterval(async () => {
          try {
            const next = await callRpc(connection, 'provision.poll', { attemptId: qr.attemptId })
            if (stopped) return
            if (next.status === 'connected') {
              clearInterval(timer)
              setQr(null)
              setQrError(null)
              setNotice(t('connect.qrConnected'))
              refresh()
            } else if (['failed', 'cancelled', 'expired'].includes(next.status)) {
              clearInterval(timer)
              setQr(null)
              if (next.status === 'failed') setQrError(`${t('connect.qrFailed')}：${next.error ?? ''}`)
            } else {
              setQr(next)
            }
          } catch (failure) {
            clearInterval(timer)
            if (!stopped) {
              setQr(null)
              setQrError(failure.message)
            }
          }
        }, QR_POLL_MS)
        return () => { stopped = true; clearInterval(timer) }
      }, [connection, qr?.attemptId, refresh, t])

      const startQr = () => {
        setQrBusy(true)
        setQrError(null)
        setNotice(null)
        callRpc(connection, 'provision.begin', {})
          .then((next) => {
            if (next.status === 'failed') setQrError(`${t('connect.qrFailed')}：${next.error ?? ''}`)
            else setQr(next)
          })
          .catch((failure) => setQrError(failure.message))
          .finally(() => setQrBusy(false))
      }

      const cancelQr = () => {
        if (qr?.attemptId) callRpc(connection, 'provision.cancel', { attemptId: qr.attemptId }).catch(() => undefined)
        setQr(null)
        setQrError(null)
      }

      const appValue = appId === null ? (status?.appId ?? '') : appId
      const wsValue = workspace === null ? (status?.workspace ?? '') : workspace
      const workspaceText = wsText === null ? (status?.workspace ?? '') : wsText
      const dirty = appValue.trim() !== (status?.appId ?? '')
        || wsValue.trim() !== (status?.workspace ?? '')
        || secret.trim() !== ''
      const workspaceDirty = workspaceText.trim() !== (status?.workspace ?? '')
      const configured = status?.configured === true
      const hasBot = Boolean(status?.appId)
      const toolEnabled = status?.toolEnabled !== false

      const saveManual = async () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const payload = { appId: appValue.trim(), workspace: wsValue.trim() }
          if (secret.trim()) payload.appSecret = secret.trim()
          const next = await callRpc(connection, 'bot.save', payload)
          setStatus(next)
          setAppId(null)
          setWorkspace(null)
          setWsText(null)
          setSecret('')
          setNotice(t('connect.saved'))
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      const discardManual = () => {
        setAppId(null)
        setWorkspace(null)
        setSecret('')
        setError(null)
        setNotice(null)
      }

      const saveWorkspace = async () => {
        setWsBusy(true)
        setWsError(null)
        setWsNotice(null)
        try {
          const next = await callRpc(connection, 'bot.save', {
            appId: status?.appId ?? '',
            workspace: workspaceText.trim(),
          })
          setStatus(next)
          setWsText(null)
          setWsNotice(t('manual.saved'))
        } catch (failure) {
          setWsError(failure.message)
        } finally {
          setWsBusy(false)
        }
      }

      const unbind = async () => {
        setBindBusy(true)
        setError(null)
        try {
          await callRpc(connection, 'session.unbind', {})
          await refresh()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBindBusy(false)
        }
      }

      const toggleTools = async (next) => {
        setToolBusy(true)
        setError(null)
        try {
          setStatus(await callRpc(connection, 'tools.set', { enabled: next }))
        } catch (failure) {
          setError(failure.message)
        } finally {
          setToolBusy(false)
        }
      }

      const remove = async () => {
        setRemoveBusy(true)
        setError(null)
        try {
          const next = await callRpc(connection, 'bot.delete', {})
          setStatus(next)
          setAppId(null)
          setWorkspace(null)
          setWsText(null)
          setSecret('')
          setNotice(null)
          setConfirmRemove(false)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setRemoveBusy(false)
        }
      }

      const qrSource = typeof qr?.qrCodeDataUrl === 'string'
        && qr.qrCodeDataUrl.length < 2 * 1024 * 1024
        && QR_SOURCE.test(qr.qrCodeDataUrl) ? qr.qrCodeDataUrl : null

      const statusCard = !hasBot ? null : h(Card, {
        title: t('status.title'),
        action: h(Button, {
          onClick: () => setConfirmRemove(true),
          disabled: removeBusy,
          style: styles.danger,
        }, t('remove.button')),
      },
        h('div', { style: styles.stateLine },
          h('span', { style: styles.dot(status.connected === true) }),
          h('span', null, status.connected ? t('status.on') : t('status.off'))),
        h('div', { style: styles.rows },
          h(InfoRow, { label: t('status.bot'), value: status.appIdMasked ?? '—' })),
        status.lastError ? h('p', { style: styles.error }, `${t('status.error')}：${status.lastError}`) : null,
        hasBot && !configured ? h('p', { style: styles.cardDesc }, t('status.pending')) : null,
        configured && error ? h('p', { style: styles.error }, error) : null,
        configured && notice ? h('p', { style: styles.notice }, notice) : null)

      const qrPane = h(React.Fragment, null,
        h('p', { style: styles.cardDesc }, t('connect.qrDesc')),
        qrSource ? h('div', { style: styles.qrPanel },
          h('img', { src: qrSource, alt: t('connect.qr'), style: styles.qr }),
          h('p', { style: styles.cardDesc }, t('connect.qrPending')),
          h(Button, { onClick: cancelQr }, t('connect.qrCancel')))
          : h('div', { style: styles.actions },
            h(Button, { variant: 'primary', onClick: startQr, disabled: qrBusy },
              qrBusy || qr ? t('connect.qrStarting') : t('connect.qrStart'))),
        qrError ? h('p', { style: styles.error }, qrError) : null)

      const manualForm = h(SettingsForm, {
        labels: {
          unavailable: '',
          readOnly: '',
          saveFailed: `${t('saveFailed')}：${error ?? ''}`,
          save: t('save'),
          saving: t('saving'),
        },
        state: {
          available: true,
          writable: true,
          dirty,
          invalid: appValue.trim() === '',
          saving: busy,
          failed: Boolean(error),
        },
        onSave: saveManual,
        onDiscard: discardManual,
      },
        h(SettingsValueField, {
          id: 'dsh-qq-lite-app-id',
          label: t('manual.appId'),
          hint: t('manual.appIdHint'),
          placeholder: t('manual.appIdPlaceholder'),
          disabled: busy,
          text: appValue,
          onEdit: (text) => { setAppId(text); setNotice(null) },
        }),
        h(SettingsSecretField, {
          id: 'dsh-qq-lite-app-secret',
          label: t('manual.secret'),
          hint: t('manual.secretHint'),
          disabled: busy,
          text: secret,
          configured: status?.secretConfigured === true,
          stateLabel: status?.secretConfigured ? t('manual.secretConfigured') : t('manual.secretUnconfigured'),
          onEdit: (text) => { setSecret(text); setNotice(null) },
        }),
        h(SettingsValueField, {
          id: 'dsh-qq-lite-setup-workspace',
          label: t('manual.workspace'),
          hint: t('manual.workspaceHint'),
          placeholder: t('manual.workspacePlaceholder'),
          disabled: busy,
          text: wsValue,
          onEdit: (text) => { setWorkspace(text); setNotice(null) },
        }))

      const connectArea = configured ? null : h(Card, {
        title: t('connect.title'),
        description: t('connect.description'),
      },
        h(SegmentedControl, {
          id: 'dsh-qq-lite-connect-mode',
          label: t('connect.mode'),
          value: mode,
          options: [
            { value: 'qr', label: t('connect.qr') },
            { value: 'manual', label: t('connect.manual') },
          ],
          onChange: (next) => { setMode(next); setError(null); setQrError(null) },
        }),
        mode === 'qr'
          ? qrPane
          : h(React.Fragment, null,
            h('p', { style: styles.cardDesc }, t('connect.manualDesc')),
            manualForm),
        error ? h('p', { style: styles.error }, error) : null,
        notice ? h('p', { style: styles.notice }, notice) : null)

      const pushCard = !configured ? null : h(Card, {
        title: t('push.title'),
        description: t('push.description'),
      },
        h('div', { style: styles.toggleRow },
          h('span', { style: styles.toggleLabel }, t('push.label')),
          h(Switch, {
            checked: toolEnabled,
            disabled: toolBusy,
            label: t('push.label'),
            onChange: toggleTools,
          })))

      const bindCard = !configured ? null : h(Card, {
        title: t('bind.title'),
        description: t('bind.description'),
        action: h(Button, { onClick: unbind, disabled: bindBusy || !status.sessionId }, t('bind.action')),
      },
        h('div', { style: styles.rows },
          h(InfoRow, {
            label: t('bind.current'),
            value: status.sessionId ? shortSession(status.sessionId) : t('bind.none'),
            title: status.sessionId ?? undefined,
          })))

      const workspaceCard = !configured ? null : h(Card, {
        title: t('workspace.title'),
        description: t('workspace.description'),
      },
        h('input', {
          type: 'text',
          style: styles.input,
          value: workspaceText,
          placeholder: t('workspace.placeholder'),
          disabled: wsBusy,
          'aria-label': t('workspace.title'),
          onChange: (event) => {
            setWsText(event.target.value)
            setWsError(null)
            setWsNotice(null)
          },
        }),
        h('div', { style: styles.actions },
          h(Button, {
            variant: 'primary',
            onClick: saveWorkspace,
            disabled: wsBusy || !workspaceDirty,
          }, wsBusy ? t('saving') : t('save'))),
        wsError ? h('p', { style: styles.error }, `${t('saveFailed')}：${wsError}`) : null,
        wsNotice ? h('p', { style: styles.notice }, wsNotice) : null)

      const commandsCard = h(Card, {
        title: t('commands.title'),
        description: t('commands.description'),
      },
        h('div', { style: styles.commands },
          ...COMMANDS.map(([command, key]) => h('div', { key: command, style: styles.command },
            h('code', { style: styles.code }, command),
            h('span', { style: styles.commandDesc }, t(key))))))

      const removeModal = h(Modal, {
        open: confirmRemove,
        onClose: () => setConfirmRemove(false),
        title: t('remove.title'),
        closeLabel: t('remove.cancel'),
        description: t('remove.description'),
        footer: h(React.Fragment, null,
          h(Button, { variant: 'outline', onClick: () => setConfirmRemove(false), disabled: removeBusy }, t('remove.cancel')),
          h(Button, {
            variant: 'outline',
            onClick: remove,
            disabled: removeBusy,
            style: styles.danger,
          }, removeBusy ? t('saving') : t('remove.confirm'))),
      })

      const body = status === null
        ? [h('p', { style: styles.cardDesc }, loadError ?? t('loading'))]
        : [
          statusCard,
          connectArea,
          pushCard,
          bindCard,
          workspaceCard,
          commandsCard,
        ]

      return h('div', { style: styles.page },
        h('h2', { style: styles.heading }, t('title')),
        h('p', { style: styles.intro }, t('intro')),
        ...body,
        removeModal)
    }

    // --- plugin -------------------------------------------------------------------

    function apply(ctx) {
      const connection = ctx.get('connection')
      const t = ctx.locale.bind(NS)
      const store = createBoundStore()
      store.refresh = () => callRpc(connection, 'connection.status')
        .then((value) => store.set(value.sessionId ?? null))
        .catch(() => undefined)
      store.refresh()
      ctx.effect(() => {
        const timer = setInterval(() => { store.refresh() }, STATUS_POLL_MS)
        return () => clearInterval(timer)
      })
      ctx.effect(() => ctx.locale.register(NS, { zh, en }))

      // Idle-row cell before the title; a status dot takes the seat when busy.
      ctx.slots.inject(LEADING_SLOT, () => ctx.slots.register({
        name: LEADING_SLOT,
        id: 'dsh-qq-lite-badge',
        order: 20,
        locale: NS,
        inject: () => ({ store }),
      }, BoundRowMark))

      // 890 keeps this row just above the shipped "Delete session" row (900).
      ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
        name: MENU_SLOT,
        id: 'dsh-qq-lite-bind',
        order: 890,
        locale: NS,
        inject: () => ({ connection, store }),
      }, BindMenuItem))

      // 22 sits right after the shipped IM bot page (21).
      ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({
        name: SETTINGS_SLOT,
        id: 'dsh-qq-lite',
        order: 22,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ connection }),
      }, QqSettingsPage))
    }

    return { apply, inject: ['slots', 'connection', 'locale'] }
  },
})
