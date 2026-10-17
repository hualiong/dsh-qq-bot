// dsh-qq-lite: CLIENT half.
//
//   sidebar.session.row.leading           — QQ mark on the bound session row
//   sidebar.workspaces.session.menu.item  — bind / unbind that session
//   plugins.row.config                    — bot configuration page
//
// Binding is one global slot: the row already bound turns the menu item into
// unbind and keeps the mark. The configuration page reads and writes the bot
// through the Host's authenticated /api carrier, using the official settings
// field primitives so the layout matches the shipped plugin pages.
window.__ModuleLoader__.load({
  id: '@hualiong/dsh-qq-lite',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState, useSyncExternalStore } = React
    const {
      Button,
      IconLinkOutlineRegular,
      MenuItemButton,
      SettingsForm,
      SettingsSecretField,
      SettingsValueField,
      Switch,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'dsh-qq-lite'
    const MODULE_NAME = '@hualiong/dsh-qq-lite'
    const MEMBER_ROW_ID = 'hualiong-dsh-qq-lite'
    const LEADING_SLOT = 'sidebar.session.row.leading'
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const ROW_CONFIG_SLOT = 'plugins.row.config'
    const RPC_CHANNEL = 'dsh-qq-lite'
    const STATUS_POLL_MS = 10_000
    const QR_POLL_MS = 1_000
    const QR_SOURCE = /^data:image\/(?:png|webp);base64,[a-z\d+/]+={0,2}$/i

    const zh = {
      'menu.bind': '绑定QQ会话',
      'menu.unbind': '取消QQ会话绑定',
      'row.bound': 'QQ 会话',
      'config.title': '允许 Agent 推送 QQ 消息',
      'config.description': '开启后，任意会话的 Agent 都可以调用 send_qq_message，向已绑定的 QQ 聊天推送消息。',
      'status.connected': '已连接',
      'status.disconnected': '未连接',
      'status.account': '机器人',
      'status.binding': '绑定会话',
      'status.unbound': '未绑定',
      'qr.title': '扫码接入',
      'qr.description': '用手机 QQ 扫码，自动创建并接入机器人，无需手动填写 AppID。',
      'qr.start': '扫码接入',
      'qr.pending': '请用手机 QQ 扫码；二维码过期会自动刷新。',
      'qr.cancel': '取消',
      'qr.connected': 'QQ 机器人已接入。',
      'qr.failed': '扫码接入失败',
      'manual.title': '手动接入',
      'manual.description': '已有 QQ 机器人时填写凭据；AppSecret 只保存在 DSH 凭据库中，留空表示保持当前密钥。',
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
      'manual.save': '保存',
      'manual.saving': '保存中…',
      'manual.saved': '已保存。',
      'manual.failed': '保存失败',
      'remove.button': '移除接入',
      'remove.confirm': '确认移除？',
      'remove.cancel': '取消',
    }
    const en = {
      'menu.bind': 'Bind QQ session',
      'menu.unbind': 'Unbind QQ session',
      'row.bound': 'QQ session',
      'config.title': 'Let Agents push to QQ',
      'config.description': 'When on, any session may call send_qq_message to push a message to the bound QQ chat.',
      'status.connected': 'Connected',
      'status.disconnected': 'Disconnected',
      'status.account': 'Bot',
      'status.binding': 'Session',
      'status.unbound': 'Not bound',
      'qr.title': 'Connect with QR',
      'qr.description': 'Scan with mobile QQ to create and connect a bot without typing an AppID.',
      'qr.start': 'Scan to connect',
      'qr.pending': 'Scan with mobile QQ. The code refreshes itself when it expires.',
      'qr.cancel': 'Cancel',
      'qr.connected': 'QQ bot connected.',
      'qr.failed': 'QR connect failed',
      'manual.title': 'Manual setup',
      'manual.description': 'Enter existing bot credentials. The AppSecret is stored only in the DSH credential store; leave it blank to keep the current one.',
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
      'manual.save': 'Save',
      'manual.saving': 'Saving…',
      'manual.saved': 'Saved.',
      'manual.failed': 'Save failed',
      'remove.button': 'Remove bot',
      'remove.confirm': 'Confirm removal?',
      'remove.cancel': 'Cancel',
    }

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

    // --- QQ penguin glyph ---------------------------------------------------------

    const markStyle = { display: 'inline-flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }
    const QQ_BLUE = '#12b7f5'

    function QqPenguin({ size = 14 }) {
      return React.createElement('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, [
        React.createElement('g', { key: 'body', fill: QQ_BLUE }, [
          React.createElement('ellipse', { key: 'b', cx: 8, cy: 9.7, rx: 4.7, ry: 5.1 }),
          React.createElement('circle', { key: 'h', cx: 8, cy: 4.7, r: 3.6 }),
          React.createElement('ellipse', { key: 'f1', cx: 5.1, cy: 14.1, rx: 1.7, ry: 0.85 }),
          React.createElement('ellipse', { key: 'f2', cx: 10.9, cy: 14.1, rx: 1.7, ry: 0.85 }),
        ]),
        React.createElement('g', { key: 'eyes', fill: '#ffffff' }, [
          React.createElement('ellipse', { key: 'e1', cx: 6.5, cy: 4.6, rx: 0.95, ry: 1.2 }),
          React.createElement('ellipse', { key: 'e2', cx: 9.5, cy: 4.6, rx: 0.95, ry: 1.2 }),
        ]),
      ])
    }

    function QqMark({ title }) {
      return React.createElement('span', { style: markStyle, title, 'aria-label': title, role: 'img' },
        React.createElement(QqPenguin, { size: 14 }))
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

    // --- configuration page styles ------------------------------------------------

    const styles = {
      hint: {
        margin: 0,
        fontSize: 12,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      },
      toolSection: { display: 'grid', gap: 6, paddingBottom: 14 },
      toggleRow: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 16,
        fontSize: 13,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
      },
      section: {
        display: 'grid',
        gap: 6,
        padding: '14px 0',
        borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18))',
      },
      sectionHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
      sectionTitle: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary, #e6e6e6)' },
      botRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
      botInfo: { display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
      infoRows: { display: 'grid', gap: 2, flex: 1, minWidth: 0 },
      infoRow: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 16,
        fontSize: 13,
        lineHeight: '20px',
      },
      infoLabel: { color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', flex: 'none' },
      infoValue: {
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
        textAlign: 'right',
        wordBreak: 'break-all',
      },
      actions: { display: 'flex', alignItems: 'center', gap: 8 },
      dot: (on) => ({
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 4,
        background: on ? 'var(--dsw-alias-state-success-primary, #21a67a)' : 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      }),
      qr: {
        width: 220,
        height: 220,
        borderRadius: 12,
        background: '#ffffff',
        padding: 8,
        boxSizing: 'border-box',
        alignSelf: 'start',
      },
      notice: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-success-primary, #21a67a)' },
      error: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
    }

    // --- plugin row configuration -------------------------------------------------

    function BotConfigPage({ t, view, form, connection }) {
      const [status, setStatus] = useState(null)
      const [appId, setAppId] = useState('')
      const [secret, setSecret] = useState('')
      const [workspace, setWorkspace] = useState('')
      const [base, setBase] = useState({ appId: '', workspace: '' })
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [error, setError] = useState(null)
      const [qr, setQr] = useState(null)
      const [qrError, setQrError] = useState(null)
      const [confirmRemove, setConfirmRemove] = useState(false)

      const refresh = useCallback(() => callRpc(connection, 'connection.status')
        .then((value) => {
          setStatus(value)
          const next = { appId: value.appId ?? '', workspace: value.workspace ?? '' }
          setBase(next)
          setAppId((current) => current || next.appId)
          setWorkspace((current) => current || next.workspace)
        })
        .catch((failure) => setError(failure.message)), [connection])

      useEffect(() => { if (view === 'page') refresh() }, [view, refresh])

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
              setNotice(t('qr.connected'))
              refresh()
            } else if (['failed', 'cancelled', 'expired'].includes(next.status)) {
              clearInterval(timer)
              setQr(null)
              if (next.status === 'failed') setQrError(`${t('qr.failed')}：${next.error ?? ''}`)
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

      if (view !== 'page') return null

      const run = (operation) => {
        setBusy(true)
        setError(null)
        setNotice(null)
        return Promise.resolve()
          .then(operation)
          .catch((failure) => setError(failure.message))
          .finally(() => setBusy(false))
      }

      const startQr = () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        setQrError(null)
        setConfirmRemove(false)
        callRpc(connection, 'provision.begin', {})
          .then((next) => {
            if (next.status === 'failed') setQrError(`${t('qr.failed')}：${next.error ?? ''}`)
            else setQr(next)
          })
          .catch((failure) => setQrError(failure.message))
          .finally(() => setBusy(false))
      }

      const cancelQr = () => {
        if (qr?.attemptId) callRpc(connection, 'provision.cancel', { attemptId: qr.attemptId }).catch(() => undefined)
        setQr(null)
        setQrError(null)
      }

      const save = () => run(async () => {
        setConfirmRemove(false)
        const payload = { appId: appId.trim(), workspace: workspace.trim() }
        if (secret.trim()) payload.appSecret = secret.trim()
        const next = await callRpc(connection, 'bot.save', payload)
        setStatus(next)
        const nextBase = { appId: next.appId ?? '', workspace: next.workspace ?? '' }
        setBase(nextBase)
        setAppId(nextBase.appId)
        setWorkspace(nextBase.workspace)
        setSecret('')
        setNotice(t('manual.saved'))
      })

      const discard = () => {
        setAppId(base.appId)
        setWorkspace(base.workspace)
        setSecret('')
        setError(null)
        setNotice(null)
      }

      const remove = () => run(async () => {
        const next = await callRpc(connection, 'bot.delete', {})
        setStatus(next)
        setBase({ appId: '', workspace: '' })
        setAppId('')
        setWorkspace('')
        setSecret('')
        setConfirmRemove(false)
        setNotice(null)
      })

      const connected = status?.connected === true
      const configured = status?.configured === true
      const qrSource = typeof qr?.qrCodeDataUrl === 'string'
        && qr.qrCodeDataUrl.length < 2 * 1024 * 1024
        && QR_SOURCE.test(qr.qrCodeDataUrl) ? qr.qrCodeDataUrl : null
      const snapshot = form?.state
      const toolEnabled = snapshot?.value?.toolEnabled !== false
      const switchReady = snapshot?.status === 'ready' && snapshot?.writable === true

      const dirty = appId.trim() !== base.appId || workspace.trim() !== base.workspace || secret.trim() !== ''
      const formState = {
        available: true,
        writable: true,
        dirty,
        invalid: false,
        saving: busy,
        failed: Boolean(error),
      }
      const labels = {
        unavailable: '',
        readOnly: '',
        saveFailed: `${t('manual.failed')}：${error ?? ''}`,
        save: t('manual.save'),
        saving: t('manual.saving'),
      }

      const toolSection = React.createElement('div', { key: 'tool', style: styles.toolSection }, [
        React.createElement('label', { key: 'row', style: styles.toggleRow }, [
          React.createElement('span', { key: 'label' }, t('config.title')),
          React.createElement(Switch, {
            key: 'switch',
            checked: toolEnabled,
            disabled: !switchReady,
            label: t('config.title'),
            onChange: (next) => {
              const write = form?.mutate?.([{ op: 'set', path: ['toolEnabled'], value: next }], snapshot?.revision)
              if (write?.catch) write.catch(() => { /* a refused write leaves the switch where it was */ })
            },
          }),
        ]),
        React.createElement('p', { key: 'hint', style: styles.hint }, t('config.description')),
      ])

      const toolStatus = React.createElement('div', { key: 'status', style: styles.section }, [
        React.createElement('div', { key: 'bot', style: styles.botRow }, [
          React.createElement('div', { key: 'info', style: styles.botInfo }, [
            React.createElement('span', {
              key: 'dot',
              style: styles.dot(connected),
              title: connected ? t('status.connected') : t('status.disconnected'),
              'aria-label': connected ? t('status.connected') : t('status.disconnected'),
            }),
            React.createElement('div', { key: 'rows', style: styles.infoRows }, [
              React.createElement('div', { key: 'account', style: styles.infoRow }, [
                React.createElement('span', { key: 'label', style: styles.infoLabel }, t('status.account')),
                React.createElement('span', { key: 'value', style: styles.infoValue }, status?.appIdMasked ?? ''),
              ]),
              React.createElement('div', { key: 'binding', style: styles.infoRow }, [
                React.createElement('span', { key: 'label', style: styles.infoLabel }, t('status.binding')),
                React.createElement('span', { key: 'value', style: styles.infoValue }, status?.sessionId ?? t('status.unbound')),
              ]),
            ]),
          ]),
          React.createElement('div', { key: 'actions', style: styles.actions },
            confirmRemove
              ? [
                React.createElement(Button, { key: 'confirm', variant: 'primary', onClick: remove, disabled: busy }, t('remove.confirm')),
                React.createElement(Button, { key: 'cancel', onClick: () => setConfirmRemove(false), disabled: busy }, t('remove.cancel')),
              ]
              : React.createElement(Button, { key: 'remove', onClick: () => setConfirmRemove(true), disabled: busy }, t('remove.button'))),
        ]),
        status?.lastError ? React.createElement('p', { key: 'last', style: styles.error }, status.lastError) : null,
        error ? React.createElement('p', { key: 'error', style: styles.error }, error) : null,
        notice ? React.createElement('p', { key: 'notice', style: styles.notice }, notice) : null,
      ])

      const addPage = React.createElement('div', { key: 'page', style: { display: 'grid', gap: 0 } }, [
        toolSection,

        React.createElement('div', { key: 'qr', style: styles.section }, [
          React.createElement('div', { key: 'head', style: styles.sectionHead }, [
            React.createElement('span', { key: 'title', style: styles.sectionTitle }, t('qr.title')),
            qr ? React.createElement(Button, { key: 'cancel', onClick: cancelQr }, t('qr.cancel'))
              : React.createElement(Button, { key: 'start', variant: 'primary', onClick: startQr, disabled: busy }, t('qr.start')),
          ]),
          React.createElement('p', { key: 'desc', style: styles.hint }, t('qr.description')),
          qrSource ? React.createElement('img', { key: 'img', src: qrSource, alt: t('qr.title'), style: styles.qr }) : null,
          qrError ? React.createElement('p', { key: 'error', style: styles.error }, qrError)
            : qr ? React.createElement('p', { key: 'pending', style: styles.hint }, t('qr.pending')) : null,
        ]),

        React.createElement('div', { key: 'manual', style: styles.section }, [
          React.createElement('span', { key: 'title', style: styles.sectionTitle }, t('manual.title')),
          React.createElement('p', { key: 'desc', style: styles.hint }, t('manual.description')),
          React.createElement(SettingsForm, {
            labels,
            state: formState,
            onSave: save,
            onDiscard: discard,
          }, [
            React.createElement(SettingsValueField, {
              key: 'appId',
              id: 'dsh-qq-lite-app-id',
              label: t('manual.appId'),
              hint: t('manual.appIdHint'),
              placeholder: t('manual.appIdPlaceholder'),
              disabled: busy,
              text: appId,
              onEdit: (text) => { setAppId(text); setNotice(null) },
            }),
            React.createElement(SettingsSecretField, {
              key: 'secret',
              id: 'dsh-qq-lite-app-secret',
              label: t('manual.secret'),
              hint: t('manual.secretHint'),
              disabled: busy,
              text: secret,
              configured: status?.secretConfigured === true,
              stateLabel: status?.secretConfigured ? t('manual.secretConfigured') : t('manual.secretUnconfigured'),
              onEdit: (text) => { setSecret(text); setNotice(null) },
            }),
            React.createElement(SettingsValueField, {
              key: 'workspace',
              id: 'dsh-qq-lite-workspace',
              label: t('manual.workspace'),
              hint: t('manual.workspaceHint'),
              placeholder: t('manual.workspacePlaceholder'),
              disabled: busy,
              text: workspace,
              onEdit: (text) => { setWorkspace(text); setNotice(null) },
            }),
          ]),
        ]),
      ])

      return configured
        ? React.createElement('div', { style: { display: 'grid', gap: 0 } }, [toolSection, toolStatus])
        : addPage
    }

    // --- plugin -------------------------------------------------------------------

    function apply(ctx) {
      const connection = ctx.get('connection')
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

      ctx.slots.inject(ROW_CONFIG_SLOT, () => ctx.slots.register({
        name: ROW_CONFIG_SLOT,
        key: `${MODULE_NAME}#${MEMBER_ROW_ID}`,
        locale: NS,
        inject: () => ({ connection }),
      }, BotConfigPage))
    }

    return { apply, inject: ['slots', 'connection', 'locale'] }
  },
})
