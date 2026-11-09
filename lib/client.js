/**
 * Client-side connection logic: try every path the pairing offer advertises,
 * cheapest first, and hand back an authenticated Channel.
 *
 * Hosts implementing their own client (for example the HarmonyOS app) mirror the
 * steps described in docs/PROTOCOL.md; this module is the reference behaviour.
 */
import dgram from 'node:dgram'
import net from 'node:net'
import { Channel, clientHandshake, generateIdentity, identityFromRaw } from './channel.js'
import { dialTcp, TcpLink } from './link-tcp.js'
import { UdpLink, encodePunch } from './link-udp.js'
import { sleep } from './util.js'

const PUNCH_PREFIX = 'DSHR1PUNCH'

export function parseOffer(code) {
  const trimmed = String(code ?? '').trim()
  const body = trimmed.startsWith('dshr1.') ? trimmed.slice(6) : trimmed
  const offer = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  if (offer?.v !== 1) throw new Error('unsupported offer version')
  if (!offer.pk || !offer.psk) throw new Error('offer is missing keys')
  return offer
}

function punchToken(hostId) {
  return `${PUNCH_PREFIX}:${hostId}`
}

function openUdpSocket(type = 'udp4') {
  const socket = dgram.createSocket({ type })
  const host = type === 'udp6' ? '::' : '0.0.0.0'
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, host, () => {
      socket.removeListener('error', reject)
      resolve(socket)
    })
  })
}

/**
 * Punch toward one UDP candidate. Resolves with the endpoint that answered, or
 * null. The host learns our reflexive endpoint from these packets and starts
 * punching back, which is what opens our own NAT mapping.
 */
function punchCandidate(socket, { host, port }, token, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearInterval(sender)
      clearTimeout(timer)
      socket.removeListener('message', onMessage)
      resolve(value)
    }
    const onMessage = (message, rinfo) => {
      if (message.length > 6 && message[0] === 1 && message[1] & 0x04) {
        finish({ address: rinfo.address, port: rinfo.port })
      }
    }
    const packet = encodePunch(token)
    socket.on('message', onMessage)
    try {
      socket.send(packet, port, host)
    } catch {}
    const sender = setInterval(() => {
      try {
        socket.send(packet, port, host)
      } catch {}
    }, 250)
    if (sender.unref) sender.unref()
    const timer = setTimeout(() => finish(null), timeoutMs)
    if (timer.unref) timer.unref()
  })
}

async function joinRelay(relay, name) {
  const socket = net.connect({ host: relay.host, port: relay.port })
  socket.setNoDelay(true)
  const link = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay timeout')), 8000)
    let buffered = ''
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
    }
    const onError = (error) => {
      cleanup()
      socket.destroy()
      reject(error)
    }
    const onData = (chunk) => {
      buffered += chunk.toString('utf8')
      let index
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index)
        buffered = buffered.slice(index + 1)
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.t === 'paired') {
          cleanup()
          resolve(new TcpLink(socket, { remote: `${relay.host}:${relay.port}` }))
          return
        }
        if (message.t === 'error') onError(new Error(message.message ?? 'relay error'))
      }
    }
    socket.once('error', onError)
    socket.on('data', onData)
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ t: 'join', room: relay.room, role: 'guest', token: relay.token, name })}\n`)
    })
  })
  return link
}

async function establish(link, offer, identity, device, onStatus) {
  onStatus?.({ phase: 'handshake', transport: link.kind, remote: link.describe?.().remote })
  const { key, peerPub } = await clientHandshake(link, { psk: Buffer.from(offer.psk, 'base64url'), identity })
  const channel = new Channel(link, {
    key,
    onMessage: () => {},
    onError: () => {},
    onClose: () => {},
  })
  return { link, channel, key, peerPub }
}

/**
 * Connect to a host described by a pairing offer.
 * `onStatus({phase, transport, remote, error})` reports progress.
 */
export async function connectToHost({ offer, identity, device = { name: 'node-client', os: process.platform }, onStatus, timeoutMs = 20000 }) {
  const phases = []
  const report = (event) => {
    phases.push(event)
    onStatus?.(event)
  }

  const tcpCandidates = (offer.cands ?? []).filter((entry) => entry.kind === 'tcp')
  const udpCandidates = (offer.cands ?? []).filter((entry) => entry.kind === 'udp')
  const lan = (entry) => typeof entry.label === 'string' && entry.label.startsWith('lan')
  const ordered = [...tcpCandidates.filter(lan), ...tcpCandidates.filter((entry) => !lan(entry))]

  for (const candidate of ordered) {
    try {
      report({ phase: 'tcp', remote: `${candidate.host}:${candidate.port}` })
      const link = await dialTcp({ host: candidate.host, port: candidate.port, timeoutMs: 3000 })
      const result = await establish(link, offer, identity, device, report)
      report({ phase: 'connected', transport: 'tcp' })
      return { ...result, transport: 'tcp', remote: `${candidate.host}:${candidate.port}` }
    } catch (error) {
      report({ phase: 'tcp-failed', remote: `${candidate.host}:${candidate.port}`, error: String(error?.message ?? error) })
    }
  }

  if (udpCandidates.length) {
    const sockets = new Map()
    const socketFor = async (host) => {
      const type = String(host).includes(':') ? 'udp6' : 'udp4'
      if (!sockets.has(type)) sockets.set(type, await openUdpSocket(type))
      return sockets.get(type)
    }
    const token = punchToken(offer.id)
    try {
      for (const candidate of udpCandidates) {
        const socket = await socketFor(candidate.host)
        report({ phase: 'punch', remote: `${candidate.host}:${candidate.port}` })
        const answered = await punchCandidate(socket, candidate, token, 2500)
        if (!answered) {
          report({ phase: 'punch-failed', remote: `${candidate.host}:${candidate.port}` })
          continue
        }
        report({ phase: 'punch-opened', remote: `${answered.address}:${answered.port}` })
        const link = new UdpLink({ socket, remote: answered, local: 'client' })
        try {
          const result = await establish(link, offer, identity, device, report)
          report({ phase: 'connected', transport: 'udp' })
          return { ...result, transport: 'udp', remote: `${answered.address}:${answered.port}`, socket }
        } catch (error) {
          report({ phase: 'udp-handshake-failed', error: String(error?.message ?? error) })
          link.close()
        }
      }
    } finally {
      if (!phases.some((entry) => entry.phase === 'connected')) {
        for (const socket of sockets.values()) {
          try {
            socket.close()
          } catch {}
        }
      }
    }
  }

  if (offer.relay?.host) {
    try {
      report({ phase: 'relay', remote: `${offer.relay.host}:${offer.relay.port}` })
      const link = await joinRelay(offer.relay, device.name)
      const result = await establish(link, offer, identity, device, report)
      report({ phase: 'connected', transport: 'relay' })
      return { ...result, transport: 'relay', remote: `${offer.relay.host}:${offer.relay.port}` }
    } catch (error) {
      report({ phase: 'relay-failed', error: String(error?.message ?? error) })
    }
  }

  throw new Error('no path to host: every candidate and relay failed')
}

/** Convenience wrapper: an RPC client over an established channel. */
export class RemoteClient {
  constructor({ channel, device }) {
    this.channel = channel
    this.device = device
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Map()
    this.ready = null
    channel.onMessage = (value) => this.onMessage(value)
    channel.onClose = () => {
      for (const { reject } of this.pending.values()) reject(new Error('connection closed'))
      this.pending.clear()
    }
  }

  onMessage(value) {
    if (value?.i !== undefined) {
      const entry = this.pending.get(value.i)
      if (!entry) return
      this.pending.delete(value.i)
      if (value.e) entry.reject(Object.assign(new Error(value.e.message), { code: value.e.code, details: value.e.details }))
      else entry.resolve(value.r)
      return
    }
    if (value?.ev === 'ready') {
      this.ready = value.d
      try {
        this.channel.send({ ev: 'device', d: this.device ?? { name: 'node-client', os: process.platform } })
      } catch {}
    }
    for (const handler of this.handlers.get(value.ev) ?? []) handler(value.d)
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event).add(handler)
    return () => this.handlers.get(event)?.delete(handler)
  }

  call(method, params, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rpc timeout: ${method}`))
      }, timeoutMs)
      if (timer.unref) timer.unref()
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.channel.send({ i: id, m: method, p: params ?? {} })
    })
  }

  close() {
    this.channel.close()
  }
}

export { generateIdentity, identityFromRaw, sleep }
