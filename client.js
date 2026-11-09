/**
 * Client half: the "Remote Access" settings page.
 *
 * It never touches the tunnel itself — it polls the Host route `/dsh-remote`
 * over the ordinary authenticated Harness connection and renders the endpoint
 * state, the pairing flow and the connected clients in the host's Settings
 * shell (slot `settings.section`).
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-remote-control',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-remote-control'

    const DICTS = {
      en: {
        'meta.title': 'Remote Access',
        'meta.description': 'Reach this Harness from another device over a hole-punched, encrypted peer-to-peer tunnel.',
        title: 'Remote Access',
        subtitle: 'Control this machine from a phone or another computer over an encrypted peer-to-peer tunnel.',
        'state.listening': 'Running',
        'state.idle': 'Stopped',
        'state.starting': 'Starting',
        'state.error': 'Error',
        'action.start': 'Start',
        'action.stop': 'Stop',
        'action.pair': 'Create pairing code',
        'action.pairAgain': 'New code',
        'action.copy': 'Copy',
        'action.copied': 'Copied',
        'action.disconnect': 'Disconnect',
        'action.revoke': 'Revoke all pairings',
        'action.revokeConfirm': 'Click again to confirm',
        'group.status': 'Status',
        'group.pairing': 'Pairing',
        'group.clients': 'Connected devices',
        'group.roots': 'Browsable folders',
        'group.security': 'Security',
        state: 'State',
        hostId: 'Host ID',
        listeners: 'Listeners',
        nat: 'NAT',
        natEndpoint: 'Public endpoint',
        relay: 'Relay',
        relayOff: 'Not configured',
        uptime: 'Uptime',
        candidates: 'Address candidates',
        devices: 'Devices',
        pairingHint: 'Send this code to the other device and paste it into the client app. Anyone holding it can connect until you revoke pairings.',
        pairingEmpty: 'No code yet. Create one once the other device is ready — codes stay valid for 30 minutes.',
        pairingSteps: '1. Copy the code   2. Paste it into the client app (or scan its QR)   3. The client picks the fastest path: LAN, hole punching, then relay',
        expiresIn: 'expires in',
        expired: 'expired',
        clientsEmpty: 'No device is connected right now.',
        connectedFor: 'connected for',
        requests: 'requests',
        'label.secret': 'Pairing secret',
        moreFolders: (n) => `${n} more folders`,
        rootsHint: 'Remote clients can only read and write inside these folders. Set `roots` in the plugin config to narrow them.',
        securityHint: 'Revoking rotates the pairing secret, disconnects every device and requires pairing again.',
        loading: 'Loading…',
        'error.prefix': 'Request failed: ',
        'transport.tcp': 'direct TCP',
        'transport.udp': 'direct UDP',
        'transport.relay': 'relay',
      },
      zh: {
        'meta.title': '远程访问',
        'meta.description': '通过打洞的加密点对点隧道，从其他设备访问这台电脑上的 Harness。',
        title: '远程访问',
        subtitle: '通过加密的点对点隧道，用手机或另一台电脑控制这台机器。',
        'state.listening': '运行中',
        'state.idle': '已停止',
        'state.starting': '启动中',
        'state.error': '出错',
        'action.start': '启动',
        'action.stop': '停止',
        'action.pair': '生成配对码',
        'action.pairAgain': '重新生成',
        'action.copy': '复制',
        'action.copied': '已复制',
        'action.disconnect': '断开',
        'action.revoke': '撤销全部配对',
        'action.revokeConfirm': '再点一次确认',
        'group.status': '状态',
        'group.pairing': '配对',
        'group.clients': '已连接设备',
        'group.roots': '可访问目录',
        'group.security': '安全',
        state: '运行状态',
        hostId: '主机 ID',
        listeners: '监听端口',
        nat: 'NAT 类型',
        natEndpoint: '公网端点',
        relay: '中继',
        relayOff: '未配置',
        uptime: '运行时长',
        candidates: '地址候选',
        devices: '设备',
        pairingHint: '把这段配对码发到另一台设备，粘进客户端应用即可连接。拿到它的人在你撤销配对之前都能连上。',
        pairingEmpty: '还没有配对码。准备好另一台设备后再生成，配对码 30 分钟内有效。',
        pairingSteps: '1. 复制配对码　2. 粘贴进客户端应用（或扫它的二维码）　3. 客户端自动选择最快路径：局域网 → 打洞 → 中继',
        expiresIn: '剩余',
        expired: '已过期',
        clientsEmpty: '当前没有设备连接。',
        connectedFor: '已连接',
        requests: '次请求',
        'label.secret': '配对密钥',
        moreFolders: (n) => `还有 ${n} 个目录`,
        rootsHint: '远程客户端只能在这些目录内读写；想收紧范围就在插件配置里设置 `roots`。',
        securityHint: '撤销会轮换配对密钥、断开所有设备，之后每台设备都需要重新配对。',
        loading: '加载中…',
        'error.prefix': '请求失败：',
        'transport.tcp': '直连 TCP',
        'transport.udp': '直连 UDP',
        'transport.relay': '中继',
      },
    }

    const zhLike = /^zh/i.test((typeof navigator !== 'undefined' && navigator.language) || '')
    const fallbackDict = zhLike ? DICTS.zh : DICTS.en

    function pick(lang) {
      if (!lang) return fallbackDict
      return DICTS[lang] ?? DICTS[String(lang).split('-')[0]] ?? fallbackDict
    }

    function makeT(getActive) {
      return (key) => {
        const dict = pick(getActive())
        return dict[key] ?? DICTS.en[key] ?? key
      }
    }

    /** Follows the Harness locale without depending on its compiled namespace map. */
    function useTranslate(ctx) {
      const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      const read = React.useCallback(() => {
        try {
          return locale?.getLocale?.().active ?? (zhLike ? 'zh' : 'en')
        } catch {
          return zhLike ? 'zh' : 'en'
        }
      }, [locale])
      const [active, setActive] = React.useState(read)
      React.useEffect(() => {
        if (!locale?.subscribe) return undefined
        setActive(read())
        return locale.subscribe(() => setActive(read()))
      }, [locale, read])
      return React.useMemo(() => makeT(() => active), [active])
    }

    async function copyText(value) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch {}
      try {
        const area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', 'true')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    // ------------------------------------------------------------ 样式

    const T = (name) => `var(--dsw-alias-${name})`

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: 22, padding: '4px 0 40px', maxWidth: 760, boxSizing: 'border-box' },
      pageHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 },
      title: { fontSize: 17, fontWeight: 600, lineHeight: 1.35, margin: 0, color: T('label-primary') },
      subtitle: { fontSize: 12.5, lineHeight: 1.55, margin: '4px 0 0', color: T('label-secondary') },
      group: { display: 'flex', flexDirection: 'column', gap: 8 },
      groupHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
      groupTitle: { fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', margin: 0, color: T('label-secondary') },
      groupNote: { fontSize: 11.5, color: T('label-secondary'), margin: 0, lineHeight: 1.5 },
      card: {
        border: `1px solid ${T('border-l1')}`,
        borderRadius: 12,
        background: T('bg-layer-1'),
        overflow: 'hidden',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '11px 14px',
        minHeight: 22,
        borderTop: `1px solid ${T('border-l1')}`,
      },
      rowFirst: { borderTop: 'none' },
      rowMain: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: '1 1 auto' },
      rowLabel: { fontSize: 13, color: T('label-primary'), lineHeight: 1.4 },
      rowHint: { fontSize: 11.5, color: T('label-secondary'), lineHeight: 1.5 },
      rowValue: {
        fontSize: 12.5,
        color: T('label-secondary'),
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: '58%',
        flex: '0 1 auto',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, letterSpacing: '.01em' },
      pill: (tone) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 9px',
        borderRadius: 999,
        fontSize: 11.5,
        lineHeight: 1.6,
        fontWeight: 500,
        color: tone,
        background: `color-mix(in srgb, ${tone} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tone} 32%, transparent)`,
        whiteSpace: 'nowrap',
      }),
      dot: (tone) => ({ width: 6, height: 6, borderRadius: 999, background: tone, flex: 'none' }),
      button: {
        appearance: 'none',
        border: `1px solid ${T('border-l2')}`,
        background: T('bg-layer-2'),
        color: T('label-primary'),
        borderRadius: 8,
        padding: '6px 13px',
        fontSize: 13,
        lineHeight: 1.4,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
      },
      buttonPrimary: { background: T('brand-primary'), borderColor: T('brand-primary'), color: '#fff' },
      buttonDanger: { color: T('state-error-primary'), borderColor: `color-mix(in srgb, ${T('state-error-primary')} 45%, transparent)`, background: 'transparent' },
      buttonDangerArmed: { color: '#fff', background: T('state-error-primary'), borderColor: T('state-error-primary') },
      buttonSmall: { padding: '3px 9px', fontSize: 12, borderRadius: 7 },
      codeBox: {
        margin: 0,
        padding: '12px 14px',
        border: `1px solid ${T('border-l1')}`,
        borderRadius: 10,
        background: T('bg-base'),
        color: T('label-primary'),
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
        lineHeight: 1.6,
        wordBreak: 'break-all',
        whiteSpace: 'pre-wrap',
        maxHeight: 132,
        overflow: 'auto',
        userSelect: 'all',
      },
      codeActions: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0 14px 13px' },
      empty: { margin: 0, padding: '14px', fontSize: 12.5, color: T('label-secondary'), lineHeight: 1.6 },
      banner: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '9px 12px',
        borderRadius: 9,
        border: `1px solid color-mix(in srgb, ${T('state-error-primary')} 35%, transparent)`,
        background: `color-mix(in srgb, ${T('state-error-primary')} 10%, transparent)`,
        fontSize: 12,
        lineHeight: 1.5,
        color: T('state-error-primary'),
        margin: 0,
      },
      steps: { margin: 0, padding: '11px 14px 13px', fontSize: 12, lineHeight: 1.7, color: T('label-secondary'), borderTop: `1px solid ${T('border-l1')}` },
      footer: { fontSize: 11.5, color: T('label-secondary'), display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      badge: {
        fontSize: 10.5,
        lineHeight: 1.5,
        padding: '1px 6px',
        borderRadius: 5,
        border: `1px solid ${T('border-l1')}`,
        color: T('label-secondary'),
        background: T('bg-layer-2'),
        whiteSpace: 'nowrap',
      },
      avatar: {
        width: 26,
        height: 26,
        borderRadius: 8,
        background: T('bg-layer-2'),
        border: `1px solid ${T('border-l1')}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        color: T('label-secondary'),
        flex: 'none',
      },
      peerRow: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 auto' },
    }

    // ------------------------------------------------------------ 小组件

    function Btn({ variant, small, busy, disabled, onClick, children }) {
      const base = { ...styles.button, ...(variant === 'primary' ? styles.buttonPrimary : null), ...(small ? styles.buttonSmall : null) }
      return h(
        'button',
        {
          type: 'button',
          className: 'drc-btn',
          style: { ...base, ...(variant === 'danger' ? styles.buttonDanger : null), ...(variant === 'danger-armed' ? styles.buttonDangerArmed : null) },
          disabled: Boolean(disabled || busy),
          onClick,
        },
        busy ? h('span', { style: { opacity: 0.7 } }, '…') : children,
      )
    }

    function Pill({ tone, children }) {
      return h('span', { style: styles.pill(tone) }, h('span', { style: styles.dot(tone) }), children)
    }

    function Row({ first, label, hint, value, mono, control }) {
      return h(
        'div',
        { style: { ...styles.row, ...(first ? styles.rowFirst : null) } },
        h(
          'div',
          { style: styles.rowMain },
          h('span', { style: styles.rowLabel }, label),
          hint ? h('span', { style: styles.rowHint }, hint) : null,
        ),
        control ?? (value !== undefined ? h('span', { style: { ...styles.rowValue, ...(mono ? styles.mono : null) } }, value) : null),
      )
    }

    function Group({ title, note, children }) {
      return h(
        'section',
        { style: styles.group },
        title ? h('div', { style: styles.groupHead }, h('h3', { style: styles.groupTitle }, title)) : null,
        h('div', { style: styles.card }, children),
        note ? h('p', { style: styles.groupNote }, note) : null,
      )
    }

    function CopyBtn({ t, value }) {
      const [copied, setCopied] = React.useState(false)
      React.useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(false), 1600)
        return () => clearTimeout(timer)
      }, [copied])
      return h(
        Btn,
        {
          small: true,
          onClick: async () => {
            const ok = await copyText(value)
            if (ok) setCopied(true)
          },
        },
        copied ? t('action.copied') : t('action.copy'),
      )
    }

    function formatDuration(ms) {
      const total = Math.max(0, Math.floor(ms / 1000))
      if (total < 60) return `${total}s`
      const minutes = Math.floor(total / 60)
      if (minutes < 60) return `${minutes}m ${total % 60}s`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h ${minutes % 60}m`
      return `${Math.floor(hours / 24)}d ${hours % 24}h`
    }

    function shortTransport(t, kind) {
      const key = `transport.${kind}`
      const text = t(key)
      return text === key ? kind : text
    }

    // ------------------------------------------------------------ 页面

    function RemoteAccessPanel() {
      const ctx = useRemoteContext()
      const t = useTranslate(ctx)
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState('')
      const [pairing, setPairing] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [armed, setArmed] = React.useState(false)
      const [now, setNow] = React.useState(Date.now())

      const request = React.useCallback(async (path, init) => {
        const response = await fetch(`/dsh-remote${path}`, {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          ...init,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          const next = await request('/status')
          setStatus(next)
          setError('')
        } catch (cause) {
          setError(`${t('error.prefix')}${cause.message}`)
        }
      }, [request, t])

      React.useEffect(() => {
        let alive = true
        refresh()
        const timer = setInterval(() => {
          if (!alive) return
          setNow(Date.now())
          refresh()
        }, 2500)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [refresh])

      React.useEffect(() => {
        if (!armed) return undefined
        const timer = setTimeout(() => setArmed(false), 5000)
        return () => clearTimeout(timer)
      }, [armed])

      const act = React.useCallback(
        async (action, label) => {
          setBusy(label)
          try {
            const result = await request('/action', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action }),
            })
            if (result.code) setPairing({ code: result.code, exp: result.offer?.exp ?? 0 })
            if (result.status) setStatus((current) => ({ ...(current ?? {}), ...result.status }))
            await refresh()
          } catch (cause) {
            setError(`${t('error.prefix')}${cause.message}`)
          } finally {
            setBusy('')
          }
        },
        [request, refresh, t],
      )

      const startedAt = status?.startedAt ?? 0
      const state = status?.state ?? 'idle'
      const tone =
        state === 'listening'
          ? T('state-success-primary')
          : state === 'error'
            ? T('state-error-primary')
            : state === 'starting'
              ? T('state-warn-primary')
              : T('state-idle-primary')
      const stateLabel = t(`state.${state}`)
      const peers = Array.isArray(status?.peers) ? status.peers : []
      const roots = Array.isArray(status?.settings?.roots) ? status.settings.roots : []
      const nat = status?.nat ?? {}
      const mapped = Array.isArray(nat.mapped) ? nat.mapped[0] : null
      const relayConf = status?.settings?.relay ?? null
      const relayState = status?.relay ?? {}
      const candidates = Array.isArray(status?.candidates) ? status.candidates : []
      const remaining = pairing?.exp ? pairing.exp - now : 0

      const head = h(
        'div',
        { style: { ...styles.pageHead, alignItems: 'center' } },
        h('p', { style: { ...styles.subtitle, margin: 0, flex: '1 1 auto', maxWidth: 520 } }, t('subtitle')),
        h(Btn, {
          variant: state === 'listening' ? undefined : 'primary',
          busy: busy === 'toggle',
          onClick: () => act(state === 'listening' ? 'stop' : 'start', 'toggle'),
        }, state === 'listening' ? t('action.stop') : t('action.start')),
      )

      const statusCard = h(
        Group,
        { title: t('group.status') },
        h(Row, { first: true, label: t('state'), control: h(Pill, { tone }, stateLabel) }),
        status?.error
          ? h(Row, { label: t('error.prefix'), control: h('span', { style: { ...styles.rowValue, color: T('state-error-primary') } }, status.error) })
          : null,
        h(Row, {
          label: t('hostId'),
          control: status?.hostId
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: { ...styles.rowValue, ...styles.mono } }, status.hostId),
                h(CopyBtn, { t, value: status.hostId }))
            : h('span', { style: styles.rowValue }, '—'),
        }),
        h(Row, {
          label: t('listeners'),
          value: status ? `tcp ${status.tcpPort ?? '—'} · udp ${status.udpPort ?? '—'}` : '—',
          mono: true,
        }),
        h(Row, {
          label: t('nat'),
          value: status ? (mapped ? `${nat.behavior ?? 'unknown'} · ${mapped.address}:${mapped.port}` : (nat.behavior ?? 'unknown')) : '—',
          mono: true,
        }),
        h(Row, {
          label: t('relay'),
          value: relayConf
            ? `${relayConf.host}:${relayConf.port} · ${relayState.state ?? 'off'}`
            : t('relayOff'),
          mono: Boolean(relayConf),
        }),
        h(Row, {
          label: t('candidates'),
          value: `${candidates.filter((c) => String(c.label ?? '').startsWith('lan')).length} lan · ${candidates.filter((c) => c.label === 'wan').length} wan`,
        }),
        status?.startedAt
          ? h(Row, { label: t('uptime'), value: formatDuration(now - startedAt) })
          : null,
        h(Row, {
          label: t('devices'),
          value: String(peers.length),
        }),
      )

      const pairingBody = pairing
        ? h(
            'div',
            null,
            h('div', { style: { padding: '12px 14px 10px' } }, h('pre', { style: styles.codeBox, tabIndex: 0, onClick: (event) => event.currentTarget.select?.() }, pairing.code)),
            h(
              'div',
              { style: styles.codeActions },
              h('span', { style: { ...styles.rowHint, ...styles.mono } },
                remaining > 0 ? `${t('expiresIn')} ${formatDuration(remaining)}` : t('expired')),
              h('div', { style: { display: 'flex', gap: 8 } },
                h(CopyBtn, { t, value: pairing.code }),
                h(Btn, { small: true, busy: busy === 'pair', onClick: () => act('pair', 'pair') }, t('action.pairAgain'))),
            ),
            h('p', { style: styles.steps }, t('pairingSteps')),
          )
        : h(
            'div',
            null,
            h('p', { style: styles.empty }, t('pairingEmpty')),
            h('div', { style: { padding: '0 14px 14px', display: 'flex', gap: 8 } },
              h(Btn, { variant: 'primary', busy: busy === 'pair', onClick: () => act('pair', 'pair') }, t('action.pair'))),
          )

      const pairingCard = h(Group, { title: t('group.pairing'), note: pairing ? t('pairingHint') : undefined }, pairingBody)

      const clientsCard = h(
        Group,
        { title: t('group.clients') },
        peers.length === 0
          ? h('p', { style: { ...styles.empty, borderTop: 'none' } }, t('clientsEmpty'))
          : peers.map((peer, index) =>
              h(
                'div',
                {
                  key: peer.id ?? index,
                  style: { ...styles.row, ...(index === 0 ? styles.rowFirst : null) },
                },
                h(
                  'div',
                  { style: styles.peerRow },
                  h('div', { style: styles.avatar }, String(peer.device?.name ?? '?').slice(0, 1).toUpperCase()),
                  h(
                    'div',
                    { style: styles.rowMain },
                    h('span', { style: { ...styles.rowLabel, display: 'flex', alignItems: 'center', gap: 8 } },
                      peer.device?.name || peer.id,
                      h('span', { style: styles.badge }, shortTransport(t, peer.transport))),
                    h('span', { style: { ...styles.rowHint, ...styles.mono } },
                      `${peer.remote || '—'} · ${t('connectedFor')} ${formatDuration(now - (peer.connectedAt ?? now))}` +
                        (peer.requests ? ` · ${peer.requests} ${t('requests')}` : '')),
                  ),
                ),
                h(Btn, { small: true, busy: busy === 'disconnect', onClick: () => act('disconnect', 'disconnect') }, t('action.disconnect')),
              ),
            ),
      )

      const rootsCard = h(
        Group,
        { title: t('group.roots'), note: t('rootsHint') },
        roots.length === 0
          ? h('p', { style: styles.empty }, '—')
          : roots.slice(0, 4).map((entry, index) =>
              h(
                'div',
                { key: entry.path ?? index, style: { ...styles.row, ...(index === 0 ? styles.rowFirst : null) } },
                h('div', { style: styles.rowMain },
                  h('span', { style: styles.rowLabel }, entry.label || entry.path),
                  h('span', { style: { ...styles.rowHint, ...styles.mono } }, entry.path)),
              ),
            ),
        roots.length > 4
          ? h(
              'div',
              { style: styles.row },
              h('div', { style: styles.rowMain },
                h('span', { style: styles.rowHint }, typeof t('moreFolders') === 'function' ? t('moreFolders')(roots.length - 4) : `+${roots.length - 4}`)),
            )
          : null,
      )

      const securityCard = h(
        Group,
        { title: t('group.security'), note: t('securityHint') },
        h(
          'div',
          { style: { ...styles.row, ...styles.rowFirst } },
          h('div', { style: styles.rowMain },
            h('span', { style: styles.rowLabel }, t('label.secret')),
            h('span', { style: styles.rowHint }, `${peers.length} ${t('devices')}`)),
          h(Btn, {
            small: true,
            variant: armed ? 'danger-armed' : 'danger',
            onClick: async () => {
              if (!armed) {
                setArmed(true)
                return
              }
              setArmed(false)
              await act('revoke', 'revoke')
              setPairing(null)
            },
          }, armed ? t('action.revokeConfirm') : t('action.revoke')),
        ),
      )

      return h(
        'div',
        { style: styles.page },
        h('style', null, `
          .drc-btn { transition: filter .12s ease; }
          .drc-btn:hover:not(:disabled) { filter: brightness(.96); }
          .drc-btn:disabled { opacity: .5; cursor: default; }
          .drc-btn:focus-visible { outline: 2px solid ${T('brand-primary')}; outline-offset: 2px; }
        `),
        head,
        error ? h('p', { style: styles.banner }, error) : null,
        statusCard,
        pairingCard,
        clientsCard,
        rootsCard,
        securityCard,
        h(
          'div',
          { style: styles.footer },
          h('span', null, `dsh-remote-control ${status?.version ?? ''}`.trim()),
          status?.state === 'listening' && status?.origin ? h('span', null, '·') : null,
          status?.state === 'listening' && status?.origin ? h('span', { style: styles.mono }, status.origin) : null,
        ),
      )
    }

    // ------------------------------------------------------------ 注册

    /** Keeps one bad render from blanking the whole settings section. */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        try {
          console.error('[dsh-remote-control]', error)
        } catch {}
      }

      render() {
        if (this.state.error) {
          return h(
            'p',
            { style: styles.banner },
            `${String(this.state.error?.message ?? this.state.error)}`,
          )
        }
        return this.props.children
      }
    }

    function Panel() {
      return h(Boundary, null, h(RemoteAccessPanel))
    }

    // The slot factory runs outside React, so the panel reaches the plugin
    // context through a module-scoped binding installed by `apply`.
    let remoteContext = null
    function useRemoteContext() {
      return remoteContext
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        remoteContext = ctx
        const disposers = []
        for (const [locale, dict] of Object.entries(DICTS)) {
          try {
            disposers.push(ctx.locale.register(NS, locale, dict))
          } catch {}
        }
        disposers.push(
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'dsh-remote-control',
                order: 62,
                label: () => pick(ctx.get('locale')?.getLocale?.().active).title,
              },
              Panel,
            ),
          ),
        )
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {}
          }
        }
      },
    }
  },
})
