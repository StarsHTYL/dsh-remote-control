/**
 * QR encoder tests.
 *
 * The pairing code is long (~700 bytes), so it has to survive real scanning.
 * These cases pin the encoder's output and, when `JSQR_PATH` points at a copy
 * of jsQR, decode the generated bitmap back to the original text — the only
 * check that actually proves a phone will read it.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { encodeOffer } from '../lib/server.js'

const require = createRequire(import.meta.url)

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

await import('../client.js')
assert.ok(loaded, 'client module registered')

const stubReact = {
  createElement: () => null,
  Component: class {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}
const module_ = loaded.factory(() => stubReact)
assert.equal(typeof module_.qrEncode, 'function', 'qrEncode is exposed')

const { qrEncode } = module_

/** A realistic pairing offer, the exact thing the panel has to render. */
const pairingCode = encodeOffer({
  v: 1,
  id: 'a89a819e596d7832',
  name: 'YAOSHI-16-Ultra',
  pk: Buffer.alloc(32, 7).toString('base64url'),
  psk: Buffer.alloc(32, 11).toString('base64url'),
  exp: 1794261899138,
  cands: [
    { kind: 'tcp', host: '192.168.3.6', port: 45871, label: 'lan:WLAN' },
    { kind: 'udp', host: '192.168.3.6', port: 45873, label: 'lan:WLAN' },
    { kind: 'tcp', host: '172.29.80.1', port: 45871, label: 'lan:vEthernet (Default Switch)' },
    { kind: 'udp', host: '172.29.80.1', port: 45873, label: 'lan:vEthernet (Default Switch)' },
    { kind: 'udp', host: '138.246.3.135', port: 45873, label: 'wan' },
    { kind: 'tcp', host: '138.246.3.135', port: 45871, label: 'wan' },
  ],
  relay: null,
})

const cases = [
  { name: 'tiny', text: 'dshr1.hello' },
  { name: 'medium', text: 'x'.repeat(300) },
  { name: 'pairing code', text: pairingCode },
]

function bits(matrix) {
  const parts = []
  for (let y = 0; y < matrix.size; y += 1) {
    let row = ''
    for (let x = 0; x < matrix.size; x += 1) row += matrix.get(x, y) ? '1' : '0'
    parts.push(row)
  }
  return parts.join('\n')
}

function toRgba(matrix, scale = 4, margin = 4) {
  const side = (matrix.size + margin * 2) * scale
  const data = new Uint8ClampedArray(side * side * 4).fill(255)
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (!matrix.get(x, y)) continue
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = (margin + x) * scale + dx
          const py = (margin + y) * scale + dy
          const offset = (py * side + px) * 4
          data[offset] = 0
          data[offset + 1] = 0
          data[offset + 2] = 0
        }
      }
    }
  }
  return { data, side }
}

const jsqrPath = process.env.JSQR_PATH
const jsQR = jsqrPath ? require(jsqrPath) : null

const results = []
for (const testCase of cases) {
  const matrix = qrEncode(testCase.text)
  assert.equal(matrix.size, matrix.version * 4 + 17, `${testCase.name}: size matches version`)
  assert.ok(matrix.version >= 1 && matrix.version <= 40, `${testCase.name}: version in range`)

  // Structural spot checks: the three finder patterns, their separators and the
  // fixed dark module.
  for (const [x, y] of [[0, 0], [6, 0], [0, 6], [6, 6], [3, 3]]) {
    assert.ok(matrix.get(x, y), `${testCase.name}: finder module (${x},${y}) must be dark`)
  }
  for (const [x, y] of [[1, 1], [7, 7], [7, 0], [0, 7]]) {
    assert.ok(!matrix.get(x, y), `${testCase.name}: separator module (${x},${y}) must be light`)
  }
  assert.ok(matrix.get(matrix.size - 1, 0), `${testCase.name}: top-right finder`)
  assert.ok(matrix.get(0, matrix.size - 1), `${testCase.name}: bottom-left finder`)
  assert.ok(matrix.get(8, matrix.size - 8), `${testCase.name}: dark module`)

  const payload = bits(matrix)
  const digest = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)

  if (jsQR) {
    const { data, side } = toRgba(matrix)
    const decoded = jsQR(data, side, side)
    assert.ok(decoded, `${testCase.name}: jsQR could not locate the symbol`)
    assert.equal(decoded.data, testCase.text, `${testCase.name}: decoded payload differs`)
  }

  results.push({ name: testCase.name, version: matrix.version, size: matrix.size, digest })
}

for (const result of results) {
  console.log(`  ${result.name.padEnd(14)} v${String(result.version).padStart(2)} ${result.size}x${result.size}  ${result.digest}`)
}
console.log(`ok: QR encoder${jsQR ? ' (decoded back with jsQR)' : ' (structure only — set JSQR_PATH to decode)'}`)
process.exit(0)
