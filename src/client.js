// dsh-qq-lite: CLIENT half.
//
//   sidebar.workspaces.session.menu.item  — "绑定为 QQ 会话" / "取消 QQ 绑定"
//   plugins.row.config                    — the send_qq_message switch
//
// Binding is one global slot: the row whose session is already bound turns the
// item into unbind. Both controls talk to the Host through the authenticated
// /api carrier.
window.__ModuleLoader__.load({
  id: '@hualiong/dsh-qq-lite',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const { MenuItemButton, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'dsh-qq-lite'
    const MODULE_NAME = '@hualiong/dsh-qq-lite'
    const MEMBER_ROW_ID = 'hualiong-dsh-qq-lite'
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const ROW_CONFIG_SLOT = 'plugins.row.config'
    const RPC_CHANNEL = 'dsh-qq-lite'

    const zh = {
      'menu.bind': '绑定为 QQ 会话',
      'menu.unbind': '取消 QQ 绑定',
      'menu.failed': 'QQ 绑定操作失败',
      'config.title': '允许 Agent 推送 QQ 消息',
      'config.description': '开启后，任意会话的 Agent 都可以调用 send_qq_message，向已绑定的 QQ 聊天推送消息。',
    }
    const en = {
      'menu.bind': 'Bind as QQ session',
      'menu.unbind': 'Unbind QQ session',
      'menu.failed': 'QQ binding failed',
      'config.title': 'Let Agents push to QQ',
      'config.description': 'When on, any session may call send_qq_message to push a message to the bound QQ chat.',
    }

    async function callRpc(connection, method, payload = {}, signal) {
      if (!connection?.rpc?.call) throw new Error('DSH 连接不可用')
      const result = await connection.rpc.call('/api', RPC_CHANNEL, { method, payload }, signal)
      if (result?.ok !== true) throw new Error(result?.error?.message ?? 'QQ 操作失败')
      return result.value
    }

    // --- session row menu ---------------------------------------------------------

    function BindMenuItem({ sessionId, useMenuOpenState, connection, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      // null = not read yet: keep the bind label until the status says otherwise.
      const [bound, setBound] = useState(null)

      useEffect(() => {
        const controller = new AbortController()
        callRpc(connection, 'connection.status', {}, controller.signal)
          .then((value) => setBound(value.sessionId === sessionId))
          .catch(() => undefined) // status is decoration here; the action still works
        return () => controller.abort()
      }, [connection, sessionId])

      const onSelect = useCallback(() => {
        setMenuOpen(false)
        callRpc(connection, bound ? 'session.unbind' : 'session.bind', bound ? {} : { sessionId })
          .catch((error) => { console.warn(`[${NS}] ${t('menu.failed')}:`, error) })
      }, [bound, connection, sessionId, setMenuOpen, t])

      return React.createElement(MenuItemButton, { onSelect }, t(bound ? 'menu.unbind' : 'menu.bind'))
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
      ctx.effect(() => ctx.locale.register(NS, { zh, en }))

      // 890 keeps this row just above the shipped "Delete session" row (900).
      ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
        name: MENU_SLOT,
        id: 'dsh-qq-lite-bind',
        order: 890,
        locale: NS,
        inject: () => ({ connection }),
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
