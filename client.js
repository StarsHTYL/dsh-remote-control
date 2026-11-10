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
        'group.pending': 'Waiting for approval',
        'group.devices': 'Approved devices',
        'group.activity': 'Recent activity',
        'group.roots': 'Browsable folders',
        'group.security': 'Security',
        state: 'State',
        hostId: 'Host ID',
        listeners: 'Listeners',
        nat: 'NAT',
        ipv6: 'IPv6',
        natEndpoint: 'Public endpoint',
        relay: 'Relay',
        relayOff: 'Not configured',
        uptime: 'Uptime',
        candidates: 'Address candidates',
        devices: 'Devices',
        pairingHint: 'Send this code to the other device and paste it into the client app. Anyone holding it can connect until you revoke pairings.',
        pairingEmpty: 'No code yet. Create one once the other device is ready — codes stay valid for 30 minutes.',
        pairingSteps: '1. Copy the code   2. Paste it into the client app (or scan the QR)   3. The client picks the fastest path: LAN, hole punching, then relay',
        scanHint: 'Scan to pair',
        ipv6None: 'no global address — IPv6 direct connect unavailable',
        'action.approve': 'Approve',
        'action.block': 'Deny',
        'action.forget': 'Remove',
        pendingHint: 'These devices hold the pairing code but can do nothing until you approve them. Approving binds this exact device key.',
        pendingEmpty: 'No device is waiting.',
        devicesEmpty: 'No device is approved yet.',
        activityEmpty: 'No activity recorded yet.',
        lastSeen: 'last seen',
        denied: 'denied',
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
        'group.pending': '待审批设备',
        'group.devices': '已授权设备',
        'group.activity': '最近活动',
        'group.roots': '可访问目录',
        'group.security': '安全',
        state: '运行状态',
        hostId: '主机 ID',
        listeners: '监听端口',
        nat: 'NAT 类型',
        ipv6: 'IPv6',
        natEndpoint: '公网端点',
        relay: '中继',
        relayOff: '未配置',
        uptime: '运行时长',
        candidates: '地址候选',
        devices: '设备',
        pairingHint: '把这段配对码发到另一台设备，粘进客户端应用即可连接。拿到它的人在你撤销配对之前都能连上。',
        pairingEmpty: '还没有配对码。准备好另一台设备后再生成，配对码 30 分钟内有效。',
        pairingSteps: '1. 复制配对码　2. 粘贴进客户端应用（或直接扫码）　3. 客户端自动选择最快路径：局域网 → 打洞 → 中继',
        scanHint: '扫码配对',
        ipv6None: '本机没有公网 IPv6 地址，无法走 IPv6 直连',
        'action.approve': '批准',
        'action.block': '拒绝',
        'action.forget': '移除',
        pendingHint: '这些设备已经拿到配对码，但在你批准之前不能读写任何东西。批准绑定的正是这台设备的密钥。',
        pendingEmpty: '没有设备在等待审批。',
        devicesEmpty: '还没有授权任何设备。',
        activityEmpty: '还没有活动记录。',
        lastSeen: '最后活动',
        denied: '已拒绝',
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
      qrWrap: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: 8,
        borderRadius: 10,
        background: '#fff',
        border: `1px solid ${T('border-l1')}`,
        flex: 'none',
      },
      qrCanvas: { display: 'block', imageRendering: 'pixelated' },
      qrCaption: { fontSize: 11, color: '#4a4a4a', lineHeight: 1.4 },
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

    function QrCode({ text, caption }) {
      const [matrix, setMatrix] = React.useState(null)
      const canvasRef = React.useRef(null)

      React.useEffect(() => {
        try {
          setMatrix(qrEncode(text))
        } catch {
          setMatrix(null)
        }
      }, [text])

      React.useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !matrix) return undefined
        if (typeof canvas.getContext !== 'function') return undefined
        const context = canvas.getContext('2d')
        if (!context) return undefined
        const margin = 4
        const modules = matrix.size + margin * 2
        const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1
        const cssScale = Math.min(8, Math.max(1, Math.floor(340 / modules)))
        const deviceScale = Math.max(1, Math.round(cssScale * dpr))
        canvas.width = modules * deviceScale
        canvas.height = modules * deviceScale
        canvas.style.width = `${modules * cssScale}px`
        canvas.style.height = `${modules * cssScale}px`
        context.imageSmoothingEnabled = false
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.fillStyle = '#000000'
        for (let y = 0; y < matrix.size; y += 1) {
          for (let x = 0; x < matrix.size; x += 1) {
            if (!matrix.get(x, y)) continue
            context.fillRect((margin + x) * deviceScale, (margin + y) * deviceScale, deviceScale, deviceScale)
          }
        }
        return undefined
      }, [matrix])

      if (!matrix) return null
      return h(
        'div',
        { style: styles.qrWrap },
        h('canvas', { ref: canvasRef, role: 'img', 'aria-label': caption ?? 'QR', style: styles.qrCanvas }),
        caption ? h('span', { style: styles.qrCaption }, caption) : null,
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

    function formatClock(ms) {
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function shortTransport(t, kind) {
      const key = `transport.${kind}`
      const text = t(key)
      return text === key ? kind : text
    }

    // ------------------------------------------------------------ QR 编码
    //
    // Byte-mode QR symbol with error correction level L, versions 1..40, so the
    // pairing code can be scanned off the screen. Self-contained on purpose:
    // the browser half is served unpackaged and cannot require() a dependency.

    const QR_ECC_PER_BLOCK = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
    const QR_BLOCKS = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25]

    function qrGfMul(x, y) {
      let z = 0
      for (let i = 7; i >= 0; i -= 1) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d)
        z ^= ((y >>> i) & 1) * x
      }
      return z & 0xff
    }

    function qrRsDivisor(degree) {
      const result = new Uint8Array(degree)
      result[degree - 1] = 1
      let root = 1
      for (let i = 0; i < degree; i += 1) {
        for (let j = 0; j < degree; j += 1) {
          result[j] = qrGfMul(result[j], root)
          if (j + 1 < degree) result[j] ^= result[j + 1]
        }
        root = qrGfMul(root, 0x02)
      }
      return result
    }

    function qrRsRemainder(data, divisor) {
      const result = new Uint8Array(divisor.length)
      for (const byte of data) {
        const factor = byte ^ result[0]
        result.copyWithin(0, 1)
        result[result.length - 1] = 0
        for (let i = 0; i < divisor.length; i += 1) result[i] ^= qrGfMul(divisor[i], factor)
      }
      return result
    }

    function qrSizeOf(version) {
      return version * 4 + 17
    }

    function qrAlignPositions(version) {
      if (version === 1) return []
      const count = Math.floor(version / 7) + 2
      const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
      const positions = [6]
      for (let pos = qrSizeOf(version) - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos)
      return positions
    }

    function qrCreate(version) {
      const size = qrSizeOf(version)
      return {
        version,
        size,
        modules: new Uint8Array(size * size),
        func: new Uint8Array(size * size),
        setFunction(x, y, dark) {
          if (x < 0 || y < 0 || x >= size || y >= size) return
          this.func[y * size + x] = 1
          this.modules[y * size + x] = dark ? 1 : 0
        },
        setData(x, y, dark) {
          this.modules[y * size + x] = dark ? 1 : 0
        },
        get(x, y) {
          return this.modules[y * size + x] === 1
        },
        isFunction(x, y) {
          return this.func[y * size + x] === 1
        },
      }
    }

    function qrDrawFormatBits(qr, mask) {
      const data = (1 << 3) | mask
      let rem = data
      for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
      const bits = ((data << 10) | rem) ^ 0x5412
      const bit = (index) => ((bits >>> index) & 1) !== 0
      for (let i = 0; i <= 5; i += 1) qr.setFunction(8, i, bit(i))
      qr.setFunction(8, 7, bit(6))
      qr.setFunction(8, 8, bit(7))
      qr.setFunction(7, 8, bit(8))
      for (let i = 9; i < 15; i += 1) qr.setFunction(14 - i, 8, bit(i))
      for (let i = 0; i < 8; i += 1) qr.setFunction(qr.size - 1 - i, 8, bit(i))
      for (let i = 8; i < 15; i += 1) qr.setFunction(8, qr.size - 15 + i, bit(i))
      qr.setFunction(8, qr.size - 8, true)
    }

    function qrDrawFunctionPatterns(qr) {
      const { size } = qr
      for (let i = 0; i < size; i += 1) {
        qr.setFunction(6, i, i % 2 === 0)
        qr.setFunction(i, 6, i % 2 === 0)
      }
      const finder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy += 1) {
          for (let dx = -4; dx <= 4; dx += 1) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy))
            const xx = cx + dx
            const yy = cy + dy
            if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue
            qr.setFunction(xx, yy, dist !== 2 && dist !== 4)
          }
        }
      }
      finder(3, 3)
      finder(size - 4, 3)
      finder(3, size - 4)

      const positions = qrAlignPositions(qr.version)
      const last = positions.length - 1
      for (let i = 0; i < positions.length; i += 1) {
        for (let j = 0; j < positions.length; j += 1) {
          if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
          for (let dy = -2; dy <= 2; dy += 1) {
            for (let dx = -2; dx <= 2; dx += 1) {
              qr.setFunction(positions[i] + dx, positions[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
            }
          }
        }
      }

      qrDrawFormatBits(qr, 0)
      if (qr.version >= 7) {
        let rem = qr.version
        for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
        const bits = (qr.version << 12) | rem
        for (let i = 0; i < 18; i += 1) {
          const dark = ((bits >>> i) & 1) !== 0
          const a = size - 11 + (i % 3)
          const b = Math.floor(i / 3)
          qr.setFunction(a, b, dark)
          qr.setFunction(b, a, dark)
        }
      }
    }

    function qrFreeModules(version) {
      const qr = qrCreate(version)
      qrDrawFunctionPatterns(qr)
      let free = 0
      for (let i = 0; i < qr.func.length; i += 1) if (!qr.func[i]) free += 1
      return free
    }

    const QR_FREE_CACHE = new Map()

    function qrDataCodewords(version) {
      if (!QR_FREE_CACHE.has(version)) QR_FREE_CACHE.set(version, Math.floor(qrFreeModules(version) / 8))
      return QR_FREE_CACHE.get(version) - QR_ECC_PER_BLOCK[version - 1] * QR_BLOCKS[version - 1]
    }

    function qrEncodeText(text, version) {
      const bytes = new TextEncoder().encode(text)
      const capacity = qrDataCodewords(version) * 8
      const bits = []
      const push = (value, length) => {
        for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
      }
      push(4, 4)
      push(bytes.length, version <= 9 ? 8 : 16)
      for (const byte of bytes) push(byte, 8)
      for (let i = 0; i < 4 && bits.length < capacity; i += 1) bits.push(0)
      while (bits.length % 8 !== 0) bits.push(0)
      let pad = true
      while (bits.length < capacity) {
        push(pad ? 0xec : 0x11, 8)
        pad = !pad
      }
      const codewords = new Uint8Array(bits.length / 8)
      for (let i = 0; i < bits.length; i += 1) codewords[i >>> 3] |= bits[i] << (7 - (i & 7))
      return codewords
    }

    function qrInterleave(data, version) {
      const numBlocks = QR_BLOCKS[version - 1]
      const eccLen = QR_ECC_PER_BLOCK[version - 1]
      const total = Math.floor(qrFreeModules(version) / 8)
      const shortCount = numBlocks - (total % numBlocks)
      const shortLen = Math.floor(total / numBlocks)
      const divisor = qrRsDivisor(eccLen)
      const blocks = []
      let offset = 0
      for (let i = 0; i < numBlocks; i += 1) {
        const dataLen = shortLen - eccLen + (i < shortCount ? 0 : 1)
        const chunk = data.subarray(offset, offset + dataLen)
        offset += dataLen
        blocks.push({ data: chunk, ecc: qrRsRemainder(chunk, divisor) })
      }
      const maxData = Math.max(...blocks.map((block) => block.data.length))
      const out = []
      for (let i = 0; i < maxData; i += 1) {
        for (const block of blocks) if (i < block.data.length) out.push(block.data[i])
      }
      for (let i = 0; i < eccLen; i += 1) {
        for (const block of blocks) out.push(block.ecc[i])
      }
      return Uint8Array.from(out)
    }

    function qrMaskBit(mask, x, y) {
      switch (mask) {
        case 0: return (x + y) % 2 === 0
        case 1: return y % 2 === 0
        case 2: return x % 3 === 0
        case 3: return (x + y) % 3 === 0
        case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
        case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
        case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
        default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
      }
    }

    function qrDrawCodewords(qr, codewords) {
      const { size } = qr
      let i = 0
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5
        for (let vert = 0; vert < size; vert += 1) {
          for (let j = 0; j < 2; j += 1) {
            const x = right - j
            const upward = ((right + 1) & 2) === 0
            const y = upward ? size - 1 - vert : vert
            if (qr.isFunction(x, y) || i >= codewords.length * 8) continue
            qr.setData(x, y, ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0)
            i += 1
          }
        }
      }
    }

    function qrApplyMask(qr, mask) {
      for (let y = 0; y < qr.size; y += 1) {
        for (let x = 0; x < qr.size; x += 1) {
          if (qr.isFunction(x, y)) continue
          if (qrMaskBit(mask, x, y)) qr.modules[y * qr.size + x] ^= 1
        }
      }
    }

    function qrPenalty(qr) {
      const { size } = qr
      let score = 0
      const at = (x, y) => qr.get(x, y)
      for (let y = 0; y < size; y += 1) {
        let runColor = at(0, y)
        let runLen = 1
        for (let x = 1; x < size; x += 1) {
          const dark = at(x, y)
          if (dark === runColor) {
            runLen += 1
            if (runLen === 5) score += 3
            else if (runLen > 5) score += 1
          } else {
            runColor = dark
            runLen = 1
          }
        }
      }
      for (let x = 0; x < size; x += 1) {
        let runColor = at(x, 0)
        let runLen = 1
        for (let y = 1; y < size; y += 1) {
          const dark = at(x, y)
          if (dark === runColor) {
            runLen += 1
            if (runLen === 5) score += 3
            else if (runLen > 5) score += 1
          } else {
            runColor = dark
            runLen = 1
          }
        }
      }
      for (let y = 0; y < size - 1; y += 1) {
        for (let x = 0; x < size - 1; x += 1) {
          const color = at(x, y)
          if (color === at(x + 1, y) && color === at(x, y + 1) && color === at(x + 1, y + 1)) score += 3
        }
      }
      const finderLike = (get) => {
        for (let i = 0; i + 10 < size; i += 1) {
          if (
            get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6) &&
            !get(i + 7) && !get(i + 8) && !get(i + 9) && !get(i + 10)
          ) score += 40
          if (
            !get(i) && !get(i + 1) && !get(i + 2) && !get(i + 3) && get(i + 4) && !get(i + 5) &&
            get(i + 6) && get(i + 7) && get(i + 8) && !get(i + 9) && get(i + 10)
          ) score += 40
        }
      }
      for (let y = 0; y < size; y += 1) finderLike((i) => at(i, y))
      for (let x = 0; x < size; x += 1) finderLike((i) => at(x, i))
      let dark = 0
      for (let i = 0; i < qr.modules.length; i += 1) dark += qr.modules[i]
      const total = size * size
      const percent = (dark * 100) / total
      score += Math.floor(Math.abs(percent - 50) / 5) * 10
      return score
    }

    /** Encode `text` into a QR matrix: `{ version, size, get(x, y) }`. */
    function qrEncode(text) {
      const bytes = new TextEncoder().encode(text)
      let version = 0
      for (let candidate = 1; candidate <= 40; candidate += 1) {
        const capacity = qrDataCodewords(candidate) * 8
        const needed = 4 + (candidate <= 9 ? 8 : 16) + bytes.length * 8
        if (needed <= capacity) {
          version = candidate
          break
        }
      }
      if (!version) throw new Error('payload is too large for one QR symbol')
      const qr = qrCreate(version)
      qrDrawFunctionPatterns(qr)
      const codewords = qrEncodeText(text, version)
      qrDrawCodewords(qr, qrInterleave(codewords, version))
      let best = -1
      let bestScore = Infinity
      for (let mask = 0; mask < 8; mask += 1) {
        qrApplyMask(qr, mask)
        qrDrawFormatBits(qr, mask)
        const score = qrPenalty(qr)
        if (score < bestScore) {
          bestScore = score
          best = mask
        }
        qrApplyMask(qr, mask)
      }
      qrApplyMask(qr, best)
      qrDrawFormatBits(qr, best)
      return { version, size: qr.size, mask: best, get: (x, y) => qr.get(x, y) }
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
        async (action, label, extra) => {
          setBusy(label)
          try {
            const result = await request('/action', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action, ...(extra ?? {}) }),
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
      const devices = Array.isArray(status?.devices) ? status.devices : []
      const pendingDevices = devices.filter((device) => device.status === 'pending')
      const approvedDevices = devices.filter((device) => device.status === 'approved')
      const activity = Array.isArray(status?.audit) ? status.audit : []
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
          label: t('ipv6'),
          hint: status && !status.ipv6?.length ? t('ipv6None') : undefined,
          value: status?.ipv6?.length ? status.ipv6[0] : '—',
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
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 16, padding: '14px' } },
              h(QrCode, { text: pairing.code, caption: t('scanHint') }),
              h(
                'div',
                { style: { flex: '1 1 240px', minWidth: 220, display: 'flex', flexDirection: 'column', gap: 10 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } },
                  h('span', { style: styles.rowHint }, remaining > 0 ? `${t('expiresIn')} ${formatDuration(remaining)}` : t('expired')),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8 } },
                    h(CopyBtn, { t, value: pairing.code }),
                    h(Btn, { small: true, busy: busy === 'pair', onClick: () => act('pair', 'pair') }, t('action.pairAgain')),
                  ),
                ),
                h('pre', { style: styles.codeBox, onClick: (event) => event.currentTarget.select?.() }, pairing.code),
              ),
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

      const pendingCard =
        pendingDevices.length === 0
          ? null
          : h(
              Group,
              { title: t('group.pending'), note: t('pendingHint') },
              pendingDevices.map((device, index) =>
                h(
                  'div',
                  { key: device.id, style: { ...styles.row, ...(index === 0 ? styles.rowFirst : null) } },
                  h(
                    'div',
                    { style: styles.peerRow },
                    h('div', { style: styles.avatar }, String(device.name || '?').slice(0, 1).toUpperCase()),
                    h(
                      'div',
                      { style: styles.rowMain },
                      h('span', { style: styles.rowLabel }, device.name || device.id),
                      h(
                        'span',
                        { style: { ...styles.rowHint, ...styles.mono } },
                        `${device.id} · ${device.os || '—'} · ${device.lastRemote || ''}`,
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8 } },
                    h(
                      Btn,
                      {
                        small: true,
                        variant: 'primary',
                        busy: busy === `approve:${device.id}`,
                        onClick: () => act('approve', `approve:${device.id}`, { deviceId: device.id }),
                      },
                      t('action.approve'),
                    ),
                    h(
                      Btn,
                      {
                        small: true,
                        variant: 'danger',
                        busy: busy === `block:${device.id}`,
                        onClick: () => act('block', `block:${device.id}`, { deviceId: device.id }),
                      },
                      t('action.block'),
                    ),
                  ),
                ),
              ),
            )

      const devicesCard = h(
        Group,
        { title: t('group.devices') },
        approvedDevices.length === 0
          ? h('p', { style: { ...styles.empty, borderTop: 'none' } }, t('devicesEmpty'))
          : approvedDevices.map((device, index) =>
              h(
                'div',
                { key: device.id, style: { ...styles.row, ...(index === 0 ? styles.rowFirst : null) } },
                h(
                  'div',
                  { style: styles.peerRow },
                  h('div', { style: styles.avatar }, String(device.name || '?').slice(0, 1).toUpperCase()),
                  h(
                    'div',
                    { style: styles.rowMain },
                    h('span', { style: styles.rowLabel }, device.name || device.id),
                    h(
                      'span',
                      { style: styles.rowHint },
                      `${device.os || '—'} · ${t('lastSeen')} ${device.lastSeenAt ? formatDuration(now - device.lastSeenAt) : '—'} · ${device.connections ?? 0} ${t('requests')}`,
                    ),
                  ),
                ),
                h(
                  Btn,
                  {
                    small: true,
                    busy: busy === `forget:${device.id}`,
                    onClick: () => act('forget', `forget:${device.id}`, { deviceId: device.id }),
                  },
                  t('action.forget'),
                ),
              ),
            ),
      )

      const activityCard = h(
        Group,
        { title: t('group.activity') },
        activity.length === 0
          ? h('p', { style: { ...styles.empty, borderTop: 'none' } }, t('activityEmpty'))
          : activity.slice(0, 8).map((entry, index) =>
              h(
                'div',
                { key: entry.seq ?? index, style: { ...styles.row, ...(index === 0 ? styles.rowFirst : null) } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: 9, minWidth: 0, flex: '1 1 auto' } },
                  h('span', { style: { ...styles.rowHint, ...styles.mono, flex: 'none' } }, formatClock(entry.at)),
                  h('span', { style: { ...styles.rowLabel, fontSize: 12.5, flex: 'none' } }, entry.deviceName || '—'),
                  h('span', { style: styles.badge }, entry.method || entry.event),
                  entry.detail
                    ? h(
                        'span',
                        { style: { ...styles.rowHint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        entry.detail,
                      )
                    : null,
                ),
                h(
                  'span',
                  {
                    style: {
                      ...styles.rowHint,
                      flex: 'none',
                      color: entry.ok ? T('state-success-primary') : T('state-error-primary'),
                    },
                  },
                  entry.ok ? 'ok' : entry.code || 'fail',
                ),
              ),
            ),
      )

      const rootsCard = h(        Group,
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
        pendingCard,
        clientsCard,
        devicesCard,
        rootsCard,
        securityCard,
        activityCard,
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
      /** Exposed for tests: the pairing QR encoder (pure, no DOM). */
      qrEncode,
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
