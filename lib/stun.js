/**
 * Minimal STUN (RFC 5389) binding client.
 *
 * It answers one question: "what public endpoint does the outside world see for
 * this exact UDP socket?" — because hole punching only works when the endpoint
 * we advertise is the mapping the NAT created for that socket.
 */
import crypto from 'node:crypto'
import dgram from 'node:dgram'

const MAGIC_COOKIE = 0x2112a442
const BINDING_REQUEST = 0x0001
const BINDING_SUCCESS = 0x0101
const XOR_MAPPED_ADDRESS = 0x0020
const MAPPED_ADDRESS = 0x0001

export const DEFAULT_STUN_SERVERS = [
  'stun.cloudflare.com:3478',
  'stun.l.google.com:19302',
  'stun1.l.google.com:19302',
]

function parseServer(entry) {
  const index = entry.lastIndexOf(':')
  if (index < 0) return { host: entry, port: 3478 }
  return { host: entry.slice(0, index), port: Number(entry.slice(index + 1)) || 3478 }
}

function buildRequest() {
  const transaction = crypto.randomBytes(12)
  const header = Buffer.allocUnsafe(20)
  header.writeUInt16BE(BINDING_REQUEST, 0)
  header.writeUInt16BE(0, 2)
  header.writeUInt32BE(MAGIC_COOKIE, 4)
  transaction.copy(header, 8)
  return { packet: header, transaction }
}

function decodeXorMapped(buffer) {
  let offset = 20
  while (offset + 4 <= buffer.length) {
    const type = buffer.readUInt16BE(offset)
    const length = buffer.readUInt16BE(offset + 2)
    const valueOffset = offset + 4
    if (valueOffset + length > buffer.length) return null
    if (type === XOR_MAPPED_ADDRESS) {
      const family = buffer[valueOffset + 1]
      const port = buffer.readUInt16BE(valueOffset + 2) ^ (MAGIC_COOKIE >>> 16)
      if (family === 0x01) {
        const address = Array.from(buffer.subarray(valueOffset + 4, valueOffset + 8))
          .map((byte, index) => byte ^ ((MAGIC_COOKIE >>> ((3 - index) * 8)) & 0xff))
          .join('.')
        return { address, port }
      }
      if (family === 0x02) return { address: 'ipv6', port }
    }
    if (type === MAPPED_ADDRESS) {
      const family = buffer[valueOffset + 1]
      const port = buffer.readUInt16BE(valueOffset + 2)
      if (family === 0x01) {
        const address = Array.from(buffer.subarray(valueOffset + 4, valueOffset + 8)).join('.')
        return { address, port }
      }
    }
    offset = valueOffset + length + ((4 - (length % 4)) % 4)
  }
  return null
}

/**
 * Probe every server from one existing UDP socket and report the observed
 * mappings plus a coarse NAT behaviour guess.
 */
export function probeStun(socket, { servers = DEFAULT_STUN_SERVERS, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const pending = new Map()
    const mapped = []
    let finished = false
    const timers = []

    const done = () => {
      if (finished) return
      finished = true
      socket.removeListener('message', onMessage)
      for (const timer of timers) clearTimeout(timer)
      const ports = new Set(mapped.map((entry) => entry.port))
      const addresses = new Set(mapped.map((entry) => entry.address))
      const behavior = mapped.length === 0
        ? 'unknown'
        : ports.size > 1 || addresses.size > 1
          ? 'symmetric'
          : 'cone'
      resolve({ mapped, behavior })
    }

    const onMessage = (message, rinfo) => {
      if (message.length < 20) return
      if (message.readUInt16BE(0) !== BINDING_SUCCESS) return
      const transaction = message.subarray(8, 20).toString('hex')
      if (!pending.has(transaction)) return
      pending.delete(transaction)
      const result = decodeXorMapped(message)
      if (result) mapped.push({ ...result, via: `${rinfo.address}:${rinfo.port}` })
      if (pending.size === 0) done()
    }

    socket.on('message', onMessage)
    for (const entry of servers) {
      const { host, port } = parseServer(entry)
      const { packet, transaction } = buildRequest()
      pending.set(transaction.toString('hex'), entry)
      try {
        socket.send(packet, port, host)
      } catch {
        pending.delete(transaction.toString('hex'))
      }
    }
    const timer = setTimeout(done, timeoutMs)
    if (timer.unref) timer.unref()
    timers.push(timer)
    if (pending.size === 0) done()
  })
}

export function resolvePublicEndpoint(probe) {
  const seen = new Map()
  for (const entry of probe.mapped) {
    if (!entry.address || entry.address === 'ipv6') continue
    const key = `${entry.address}:${entry.port}`
    seen.set(key, { address: entry.address, port: entry.port })
  }
  return [...seen.values()].slice(0, 3)
}

export function createUdpSocket({ port = 0, host = '0.0.0.0' } = {}) {
  const type = host.includes(':') ? 'udp6' : 'udp4'
  const socket = dgram.createSocket({ type, reuseAddr: true, ipv6Only: false })
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(port, host, () => {
      socket.removeListener('error', reject)
      resolve(socket)
    })
  })
}
