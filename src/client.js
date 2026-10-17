// dsh-qq-lite: CLIENT half.
//
//   sidebar.session.row.leading           — QQ mark on the bound session row
//   sidebar.workspaces.session.menu.item  — bind / unbind that session
//   plugins.row.config                    — the send_qq_message switch
//
// Binding is one global slot: the row already bound turns the menu item into
// unbind and keeps the mark. These surfaces share one polling store fed by the
// Host's authenticated /api carrier (a QQ-side /new changes the binding without
// this client acting).
window.__ModuleLoader__.load({
  id: '@hualiong/dsh-qq-lite',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useSyncExternalStore } = React
    const { MenuItemButton, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'dsh-qq-lite'
    const MODULE_NAME = '@hualiong/dsh-qq-lite'
    const MEMBER_ROW_ID = 'hualiong-dsh-qq-lite'
    const LEADING_SLOT = 'sidebar.session.row.leading'
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const ROW_CONFIG_SLOT = 'plugins.row.config'
    const RPC_CHANNEL = 'dsh-qq-lite'
    const STATUS_POLL_MS = 10_000

    const zh = {
      'menu.bind': '绑定为 QQ 会话',
      'menu.unbind': '取消 QQ 绑定',
      'row.bound': 'QQ 会话',
      'config.title': '允许 Agent 推送 QQ 消息',
      'config.description': '开启后，任意会话的 Agent 都可以调用 send_qq_message，向已绑定的 QQ 聊天推送消息。',
    }
    const en = {
      'menu.bind': 'Bind as QQ session',
      'menu.unbind': 'Unbind QQ session',
      'row.bound': 'QQ session',
      'config.title': 'Let Agents push to QQ',
      'config.description': 'When on, any session may call send_qq_message to push a message to the bound QQ chat.',
    }

    async function callRpc(connection, method, payload = {}, signal) {
      if (!connection?.rpc?.call) throw new Error('DSH 连接不可用')
      const result = await connection.rpc.call('/api', RPC_CHANNEL, { method, payload }, signal)
      if (result?.ok !== true) throw new Error(result?.error?.message ?? 'QQ 操作失败')
      return result.value
    }

    // --- bound-session store ------------------------------------------------------

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

    // --- bound-session row mark ---------------------------------------------------

    const markStyle = { display: 'inline-flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }
    const QQ_BLUE = '#12b7f5'

    function QqMark({ title }) {
      return React.createElement('span', { style: markStyle, title, 'aria-label': title, role: 'img' },
        React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16' },
          React.createElement('circle', { cx: 8, cy: 6.8, r: 4.4, fill: 'none', stroke: QQ_BLUE, strokeWidth: 2 }),
          React.createElement('path', { d: 'M10.5 9.7 12.8 12', fill: 'none', stroke: QQ_BLUE, strokeWidth: 2, strokeLinecap: 'round' })))
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
      return React.createElement(MenuItemButton, { onSelect }, t(isBound ? 'menu.unbind' : 'menu.bind'))
    }

    // --- plugin row configuration -------------------------------------------------

    const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
    const textStyle = { display: 'flex', flexDirection: 'column', gap: 2 }
    const labelStyle = { fontSize: 13, lineHeight: '20px' }
    const descriptionStyle = { color: 'var(--dsw-alias-label-secondary, #8a8a8e)', fontSize: 12, lineHeight: '16px', margin: 0 }

    function ToolSwitchForm({ t, view, form }) {
      const snapshot = form?.state
      if (view === 'summary') return null
      const enabled = snapshot?.value?.toolEnabled !== false
      const ready = snapshot?.status === 'ready' && snapshot?.writable === true
      return React.createElement('div', { style: rowStyle }, [
        React.createElement('div', { key: 'text', style: textStyle }, [
          React.createElement('span', { key: 'label', style: labelStyle }, t('config.title')),
          React.createElement('p', { key: 'hint', style: descriptionStyle }, t('config.description')),
        ]),
        React.createElement(Switch, {
          key: 'switch',
          checked: enabled,
          disabled: !ready,
          label: t('config.title'),
          onChange: (next) => {
            form.mutate([{ op: 'set', path: ['toolEnabled'], value: next }], snapshot.revision)
              .catch(() => { /* a refused write leaves the switch where it was */ })
          },
        }),
      ])
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
      }, ToolSwitchForm))
    }

    return { apply, inject: ['slots', 'connection', 'locale'] }
  },
})
