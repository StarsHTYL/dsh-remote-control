/**
 * Render the settings panel with a minimal React stand-in.
 *
 * The browser half cannot be opened from here, but a single-pass render still
 * catches the failures that would blank the section: undefined data reaching
 * `.map`, a bad hook call, a component that throws on first paint. It also lets
 * the test assert the text the page is supposed to show.
 */
import assert from 'node:assert/strict'

// ---------------------------------------------------------------- 迷你 React

class Component {
  constructor(props) {
    this.props = props
    this.state = this.state ?? {}
  }

  setState(patch) {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) }
  }
}
Component.prototype.isMiniComponent = true

let hookOwner = null
const stores = new Map()
let pendingEffects = []
let collectEffects = true

function useHook(seed) {
  const owner = hookOwner
  if (!owner) throw new Error('hook called outside a component')
  const index = owner.index++
  if (owner.hooks.length <= index) owner.hooks.push(seed())
  return owner.hooks[index]
}

const React = {
  Component,
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) }
    const flat = children.length === 1 ? children[0] : children.length ? children : undefined
    if (flat !== undefined) merged.children = flat
    return { type, props: merged }
  },
  useState(initial) {
    const cell = useHook(() => ({ value: typeof initial === 'function' ? initial() : initial, set: null }))
    if (!cell.set) {
      cell.set = (next) => {
        cell.value = typeof next === 'function' ? next(cell.value) : next
      }
    }
    return [cell.value, cell.set]
  },
  useCallback(fn) {
    return useHook(() => fn)
  },
  useMemo(fn) {
    return useHook(() => fn())
  },
  useEffect(fn) {
    const cell = useHook(() => fn)
    if (collectEffects) pendingEffects.push(cell)
  },
  useRef(value) {
    return useHook(() => ({ current: value }))
  },
  useSyncExternalStore(subscribe, read) {
    useHook(() => subscribe)
    return read()
  },
}

function renderNode(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return escape(String(node))
  if (Array.isArray(node)) return node.map(renderNode).join('')
  const { type, props } = node
  if (typeof type === 'function') {
    if (type.prototype?.isMiniComponent) {
      return renderNode(new type(props).render())
    }
    let store = stores.get(type)
    if (!store) {
      store = { hooks: [], index: 0 }
      stores.set(type, store)
    }
    const previous = hookOwner
    hookOwner = store
    store.index = 0
    let out
    try {
      out = type(props)
    } finally {
      hookOwner = previous
    }
    return renderNode(out)
  }
  if (type === 'style') return ''
  return `<${type}>${renderNode(props.children)}</${type}>`
}

function escape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------- 宿主模拟

const now = Date.now()
const status = {
  version: '0.1.0',
  state: 'listening',
  error: null,
  hostId: 'a89a819e596d7832',
  name: 'YAOSHI-16-Ultra',
  startedAt: now - 3_725_000,
  tcpPort: 45871,
  udpPort: 45873,
  bindHost: '0.0.0.0',
  origin: 'http://127.0.0.1:22215',
  candidates: [
    { kind: 'tcp', host: '192.168.3.6', port: 45871, label: 'lan:WLAN' },
    { kind: 'udp', host: '192.168.3.6', port: 45873, label: 'lan:WLAN' },
    { kind: 'udp', host: '138.246.3.135', port: 45873, label: 'wan' },
    { kind: 'tcp', host: '138.246.3.135', port: 45871, label: 'wan' },
  ],
  nat: { behavior: 'cone', mapped: [{ address: '138.246.3.135', port: 45873 }], at: now },
  ipv6: ['2001:4ca0:205:66a8:6cee:7c7b:d86c:a111'],
  relay: { configured: false, state: 'off' },
  peers: [
    {
      id: 'p1',
      device: { name: 'Mate 60', os: 'HarmonyOS 5' },
      transport: 'udp',
      remote: '192.168.3.9:51234',
      connectedAt: now - 90_000,
      lastSeen: now,
      requests: 7,
    },
  ],
  autoStart: true,
  settings: {
    name: 'YAOSHI-16-Ultra',
    bindHost: '0.0.0.0',
    tcpPort: 45871,
    udpPort: 45873,
    autoStart: true,
    relay: null,
    roots: [
      { path: 'E:\\HarmonyOS\\HLib', label: 'HLib' },
      { path: 'E:\\Windows Projects\\L-Mechrevo-Next', label: 'L-Mechrevo-Next' },
      { path: 'E:\\HarmonyOS\\HuntekFIle', label: 'HuntekFIle' },
      { path: 'E:\\TUM\\EI', label: 'EI' },
      { path: 'C:\\Users\\MECHREVO', label: 'MECHREVO' },
      { path: 'D:\\本地动漫', label: '本地动漫' },
    ],
  },
}

const LANG = process.env.PANEL_LANG === 'en' ? 'en' : 'zh'

const EXPECT = {
  zh: {
    lang: 'zh-CN',
    live: ['点对点隧道', '运行中', 'a89a819e596d7832', 'tcp 45871', 'cone', '2001:4ca0', '1h 2m', 'Mate 60', '直连 UDP', '生成配对码', '可访问目录', 'HLib', '配对密钥', '撤销全部配对'],
    more: '还有 2 个目录',
    stopped: '已停止',
    emptyClients: '当前没有设备连接',
    emptyPairing: '还没有配对码',
  },
  en: {
    lang: 'en-US',
    live: ['peer-to-peer tunnel', 'Running', 'a89a819e596d7832', 'tcp 45871', 'cone', '2001:4ca0', '1h 2m', 'Mate 60', 'direct UDP', 'Create pairing code', 'Browsable folders', 'HLib', 'Pairing secret', 'Revoke all pairings'],
    more: '2 more folders',
    stopped: 'Stopped',
    emptyClients: 'No device is connected',
    emptyPairing: 'No code yet',
  },
}[LANG]

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { language: EXPECT.lang, clipboard: { writeText: async () => {} } },
})
globalThis.document = {
  createElement: () => ({ style: {}, select() {}, setAttribute() {} }),
  body: { appendChild() {}, removeChild() {} },
  execCommand: () => true,
}
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () => (String(url).includes('/status') ? status : { ok: true, status }),
})

// ---------------------------------------------------------------- 渲染

await import('../client.js')

assert.ok(loaded, 'the module was registered with the loader')
assert.equal(loaded.id, '@local/dsh-remote-control')

const module_ = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})

let panel = null
let panelOptions = null
const ctx = {
  get(name) {
    if (name === 'locale') {
      return { getLocale: () => ({ active: LANG, locales: [], revision: 1 }), subscribe: () => () => {}, register: () => () => {} }
    }
    return undefined
  },
  slots: {
    inject(_slot, make) {
      const registered = make()
      return () => registered
    },
    register(options, component) {
      if (options.id === 'dsh-remote-control') {
        panel = component
        panelOptions = options
      }
      return () => {}
    },
  },
  locale: {
    register: () => () => {},
  },
}

module_.apply(ctx)
assert.ok(panel, 'the settings section component was registered')
assert.equal(panelOptions.name, 'settings.section')
assert.equal(panelOptions.order, 62)
assert.equal(panelOptions.label(), LANG === 'zh' ? '远程访问' : 'Remote Access', 'nav label follows the active locale')

const element = React.createElement(panel, {})
renderNode(element) // first pass: mounts, records effects
for (const effect of pendingEffects) effect()
await new Promise((resolve) => setTimeout(resolve, 100)) // let the status fetch land
collectEffects = false
const html = renderNode(element) // second pass: real state

for (const expected of EXPECT.live) {
  assert.ok(html.includes(expected), `rendered panel is missing: ${expected}`)
}
assert.ok(html.includes(EXPECT.more), `rendered panel is missing the folder overflow row (${EXPECT.more})`)

assert.ok(!html.includes('undefined'), 'no undefined leaked into the markup')
assert.ok(!html.includes('NaN'), 'no NaN leaked into the markup')
assert.ok(html.length > 1200, `the panel renders real content (${html.length} bytes)`)

// A stopped endpoint must still render (the empty/error posture).
status.state = 'idle'
status.peers = []
status.nat = { behavior: 'unknown', mapped: [] }
const stopped = renderNode(element)
assert.ok(stopped.includes(EXPECT.stopped), 'stopped state renders')
assert.ok(stopped.includes(EXPECT.emptyClients), 'empty client list renders')
assert.ok(stopped.includes(EXPECT.emptyPairing), 'empty pairing state renders')

console.log(`ok: settings panel renders (${LANG})`)
console.log(`markup: ${html.length} bytes`)
await (await import('node:fs/promises')).writeFile(new URL(`./.panel.${LANG}.html`, import.meta.url), html)
process.exit(0)
