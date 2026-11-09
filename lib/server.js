/**
 * Remote-control server: owns the listeners, the pairing secret, peer sessions
 * and the RPC dispatch. One instance per Harness Host process.
 */
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Channel, clientHandshake, generateIdentity, identityFromRaw, serverHandshake } from './channel.js'
import { createTcpServer, dialTcp, TcpLink } from './link-tcp.js'
import { UdpLink, encodePunch } from './link-udp.js'
import { DEFAULT_STUN_SERVERS, createUdpSocket, probeStun, resolvePublicEndpoint } from './stun.js'
import { createRpcTable, RpcError } from './rpc.js'
import { b64u, fromB64u, hmac, randomBytes, sha256, shortId, utf8 } from './util.js'

const PUNCH_PREFIX = 'DSHR1PUNCH'
const MAX_PEERS = 8

export function hostIdOf(publicKey) {
  return sha256(publicKey).subarray(0, 8).toString('hex')
}

export function encodeOffer(offer) {
  return `dshr1.${Buffer.from(JSON.stringify(offer), 'utf8').toString('base64url')}`
}

export function decodeOffer(code) {
  const trimmed = String(code ?? '').trim()
  const body = trimmed.startsWith('dshr1.') ? trimmed.slice(6) : trimmed
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  if (parsed?.v !== 1) throw new Error('unsupported pairing offer version')
  return parsed
}

/** A paired client connection. */
class Peer {
  constructor({ link, channel, device, identity, rpc, logger, onGone }) {
    this.id = shortId(6)
    this.link = link
    this.channel = channel
    this.device = device
    this.identity = identity
    this.rpc = rpc
    this.logger = logger
    this.onGone = onGone
    this.connectedAt = Date.now()
    this.lastSeen = Date.now()
    this.pending = new Map()
    this.requests = 0
    this.closed = false
    this.closeHooks = []
  }

  onClose(hook) {
    if (this.closed) {
      try {
        hook()
      } catch {}
      return
    }
    this.closeHooks.push(hook)
  }

  emit(value) {
    if (this.closed) return
    try {
      this.channel.send(value)
    } catch (error) {
      this.logger?.warn?.(`peer ${this.id} emit failed: ${error.message}`)
    }
  }

  message(value) {
    if (this.closed) return
    this.lastSeen = Date.now()
    if (value?.ev) {
      if (value.ev === 'device' && value.d && typeof value.d === 'object') {
        this.device = { name: String(value.d.name ?? 'unknown'), os: String(value.d.os ?? '') }
      }
      return
    }
    if (value?.m) {
      this.dispatch(value)
      return
    }
    const pending = value?.i !== undefined ? this.pending.get(value.i) : undefined
    if (!pending) return
    this.pending.delete(value.i)
    if (value.e) pending.reject(new RpcError(value.e.code ?? 'remote-error', value.e.message ?? 'remote error'))
    else pending.resolve(value.r)
  }

  async dispatch(request) {
    this.requests += 1
    const handler = this.rpc.table.get(request.m)
    if (!handler) {
      this.emit({ i: request.i, e: { code: 'unknown-method', message: `unknown method ${request.m}` } })
      return
    }
    try {
      const result = await handler(request.p ?? {}, this)
      this.emit({ i: request.i, r: result ?? null })
    } catch (error) {
      const code = error instanceof RpcError ? error.code : 'internal'
      if (!(error instanceof RpcError)) this.logger?.warn?.(`rpc ${request.m} failed: ${error?.stack ?? error}`)
      this.emit({ i: request.i, e: { code, message: String(error?.message ?? error), details: error?.details } })
    }
  }

  close(reason = 'closed') {
    if (this.closed) return
    this.closed = true
    for (const hook of this.closeHooks) {
      try {
        hook()
      } catch {}
    }
    this.closeHooks.length = 0
    this.channel.close()
    this.onGone?.(this, reason)
  }

  describe() {
    return {
      id: this.id,
      device: this.device,
      transport: this.link.kind,
      remote: this.link.describe?.().remote ?? '',
      connectedAt: this.connectedAt,
      lastSeen: this.lastSeen,
      requests: this.requests,
    }
  }
}

export class RemoteServer {
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config
    this.logger = options.logger
    this.dataDir = options.dataDir
    this.rootsProvider = options.rootsProvider
    this.rootsCache = options.roots ?? options.config?.roots ?? []
    this.rootsTimer = null
    this.state = 'idle'
    this.error = null
    this.peers = new Map()
    this.startedAt = 0
    this.stun = { mapped: [], behavior: 'unknown', at: 0 }
    this.recentPunchers = new Map()
    this.relaySocket = null
    this.relayState = 'off'
    this.relayRetry = null
    this.identity = null
    this.secret = null
    this.tcpServer = null
    this.udpSocket = null
    this.udpLinks = new Map()
    this.rpc = createRpcTable({
      ctx: options.ctx,
      logger: options.logger,
      roots: () => this.roots(),
      hostInfo: () => ({
        app: 'dsh-remote-control',
        name: this.config.name,
        hostId: this.hostId,
        origin: this.origin,
        version: options.version,
      }),
      webrtcOrigin: () => this.origin,
      webUrl: () => this.webUrl(),
    })
  }

  get hostId() {
    return this.identity ? hostIdOf(this.identity.pub) : ''
  }

  get tcpPort() {
    return this.tcpServer ? this.tcpServer.address().port : this.config.tcpPort
  }

  get udpPort() {
    return this.udpSocket ? this.udpSocket.address().port : this.config.udpPort
  }

  roots() {
    return this.rootsCache
  }

  /** Re-read the roots a client may browse (session workspaces change over time). */
  async refreshRoots() {
    if (!this.rootsProvider) return this.rootsCache
    try {
      const next = await this.rootsProvider()
      if (Array.isArray(next) && next.length) this.rootsCache = next
    } catch (error) {
      this.logger?.debug?.(`root refresh failed: ${error?.message ?? error}`)
    }
    return this.rootsCache
  }

  /** A tokenized URL for the real Harness UI, usable from a remote WebView. */
  webUrl() {
    if (!this.origin) return null
    try {
      const connection = this.ctx.get('connection')
      return connection?.authenticatedUrl?.(this.origin) ?? this.origin
    } catch {
      return this.origin
    }
  }

  async load() {
    await fs.mkdir(this.dataDir, { recursive: true })
    const file = path.join(this.dataDir, 'identity.json')
    let stored = null
    try {
      stored = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {}
    if (stored?.priv && stored?.secret) {
      this.identity = identityFromRaw(stored.priv)
      this.secret = fromB64u(stored.secret)
    } else {
      this.identity = generateIdentity()
      this.secret = randomBytes(32)
      await this.persist()
    }
  }

  async persist() {
    const file = path.join(this.dataDir, 'identity.json')
    const payload = {
      priv: b64u(this.identity.priv),
      pub: b64u(this.identity.pub),
      secret: b64u(this.secret),
      createdAt: new Date().toISOString(),
    }
    await fs.writeFile(file, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
  }

  async start() {
    if (this.state === 'listening' || this.state === 'starting') return this.status()
    this.state = 'starting'
    this.error = null
    try {
      await this.load()
      await this.refreshRoots()
      this.rootsTimer = setInterval(() => this.refreshRoots(), 60000)
      if (this.rootsTimer.unref) this.rootsTimer.unref()
      this.origin = (() => {
        try {
          return this.ctx.get('webServer')?.getOrigin?.() ?? null
        } catch {
          return null
        }
      })()
      this.tcpServer = await createTcpServer({
        host: this.config.bindHost,
        port: this.tcpPort,
        onLink: (link) => this.acceptLink(link),
      })
      this.udpSocket = await createUdpSocket({ port: this.config.udpPort, host: this.config.bindHost })
      this.udpSocket.on('message', (message, rinfo) => this.onDatagram(message, rinfo))
      this.udpSocket.on('error', (error) => this.logger?.warn?.(`udp socket error: ${error.message}`))
      this.startedAt = Date.now()
      this.state = 'listening'
      this.refreshStun().catch(() => {})
      this.startRelay()
      this.logger?.info?.(`remote control listening on tcp ${this.tcpServer.address().port} / udp ${this.udpAddress()}`)
      return this.status()
    } catch (error) {
      this.state = 'error'
      this.error = String(error?.message ?? error)
      await this.stop()
      throw error
    }
  }

  udpAddress() {
    return this.udpSocket ? this.udpSocket.address().port : this.config.udpPort
  }

  async stop() {
    this.state = 'idle'
    if (this.rootsTimer) {
      clearInterval(this.rootsTimer)
      this.rootsTimer = null
    }
    for (const peer of this.peers.values()) peer.close('server stopped')
    this.peers.clear()
    this.rpc.dispose()
    for (const link of this.udpLinks.values()) {
      try {
        link.close()
      } catch {}
    }
    this.udpLinks.clear()
    if (this.relayRetry) {
      clearTimeout(this.relayRetry)
      this.relayRetry = null
    }
    if (this.relaySocket) {
      try {
        this.relaySocket.destroy()
      } catch {}
      this.relaySocket = null
    }
    this.relayState = 'off'
    if (this.tcpServer) {
      await new Promise((resolve) => this.tcpServer.close(resolve))
      this.tcpServer = null
    }
    if (this.udpSocket) {
      try {
        this.udpSocket.close()
      } catch {}
      this.udpSocket = null
    }
  }

  // ---- candidates --------------------------------------------------------

  localAddresses() {
    const found = []
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const entry of list ?? []) {
        if (entry.family !== 'IPv4' || entry.internal) continue
        found.push({ address: entry.address, name })
      }
    }
    return found
  }

  async refreshStun() {
    if (!this.udpSocket) return this.stun
    const probe = await probeStun(this.udpSocket, {
      servers: this.config.stunServers.length ? this.config.stunServers : DEFAULT_STUN_SERVERS,
      timeoutMs: 2500,
    })
    this.stun = {
      mapped: resolvePublicEndpoint(probe),
      behavior: probe.behavior,
      at: Date.now(),
    }
    return this.stun
  }

  candidates() {
    const list = []
    const bind = this.config.bindHost
    const hosts = bind && bind !== '0.0.0.0' && bind !== '::'
      ? [{ address: bind, name: 'bind' }]
      : this.localAddresses()
    for (const entry of hosts) {
      list.push({ kind: 'tcp', host: entry.address, port: this.tcpPort, label: `lan:${entry.name}` })
      list.push({ kind: 'udp', host: entry.address, port: this.udpAddress(), label: `lan:${entry.name}` })
    }
    for (const entry of this.stun.mapped) {
      list.push({ kind: 'udp', host: entry.address, port: entry.port, label: 'wan' })
      list.push({ kind: 'tcp', host: entry.address, port: this.tcpPort, label: 'wan' })
    }
    const dedup = new Map()
    for (const candidate of list) dedup.set(`${candidate.kind}|${candidate.host}|${candidate.port}`, candidate)
    return [...dedup.values()]
  }

  // ---- pairing -----------------------------------------------------------

  offer(ttlMs = this.config.offerTtlMs) {
    const relay = this.config.relay?.host
      ? { host: this.config.relay.host, port: this.config.relay.port, room: this.hostId, token: this.config.relay.token ?? '' }
      : null
    return {
      v: 1,
      id: this.hostId,
      name: this.config.name,
      pk: b64u(this.identity.pub),
      psk: b64u(this.secret),
      exp: Date.now() + ttlMs,
      cands: this.candidates(),
      relay,
    }
  }

  async createOffer({ refresh = true } = {}) {
    if (this.state !== 'listening') await this.start()
    if (refresh) await this.refreshStun().catch(() => {})
    const offer = this.offer()
    const payload = Buffer.from(JSON.stringify(offer), 'utf8')
    return {
      code: encodeOffer(offer),
      offer,
      fingerprint: hmac(this.secret, utf8('offer'), payload).subarray(0, 6).toString('hex'),
    }
  }

  async rotateSecret() {
    this.secret = randomBytes(32)
    await this.persist()
    for (const peer of [...this.peers.values()]) peer.close('pairing revoked')
    this.peers.clear()
    return { rotatedAt: Date.now() }
  }

  disconnectAll() {
    for (const peer of [...this.peers.values()]) peer.close('disconnected by host')
    this.peers.clear()
  }

  // ---- inbound transports ------------------------------------------------

  async acceptLink(link) {
    if (this.peers.size >= MAX_PEERS) {
      link.close()
      return
    }
    try {
      const { key, peerPub } = await serverHandshake(link, {
        psk: this.secret,
        identity: this.identity,
        timeoutMs: 8000,
      })
      this.adopt(link, key, peerPub, {})
    } catch (error) {
      this.logger?.debug?.(`handshake rejected (${link.kind}): ${error.message}`)
      link.close()
    }
  }

  adopt(link, key, peerPub, extra) {
    const channel = new Channel(link, {
      key,
      onMessage: (value) => peer.message(value),
      onError: (error) => this.logger?.debug?.(`channel error: ${error.message}`),
      onClose: () => peer.close('transport closed'),
      logger: this.logger,
    })
    const peer = new Peer({
      link,
      channel,
      identity: peerPub,
      device: null,
      rpc: this.rpc,
      logger: this.logger,
      onGone: (gone, reason) => {
        this.peers.delete(gone.id)
        this.logger?.info?.(`peer ${gone.id} gone (${reason})`)
      },
    })
    Object.assign(peer, extra)
    this.peers.set(peer.id, peer)
    peer.emit({
      ev: 'ready',
      d: {
        peerId: peer.id,
        host: this.status(),
      },
    })
    this.logger?.info?.(`peer ${peer.id} connected over ${link.kind}`)
    return peer
  }

  onDatagram(message, rinfo) {
    if (message.length > 6 && message[0] === 1) {
      // link-udp packet: route to its link, or open one for a fresh endpoint.
      const key = `${rinfo.address}:${rinfo.port}`
      const existing = this.udpLinks.get(key)
      if (existing) {
        existing.receive(message, rinfo)
        return
      }
      const flags = message[1]
      if (flags & 0x04) {
        this.handlePunch(message.subarray(6), rinfo)
        return
      }
      if (!(flags & 0x08)) return
      const payload = message.subarray(6)
      if (!payload.length || payload[0] !== 0x7b) return
      let hello
      try {
        hello = JSON.parse(payload.toString('utf8'))
      } catch {
        return
      }
      if (hello?.t !== 'hello') return
      this.openUdpPeer(key, rinfo, payload, message, hello)
    }
  }

  openUdpPeer(key, rinfo, payload, rawMessage, hello) {
    const marker = this.recentPunchers.get(key)
    if (!marker || Date.now() - marker > 90000) {
      this.logger?.debug?.(`udp hello from unpunched endpoint ${key}`)
      return
    }
    const link = new UdpLink({
      socket: this.udpSocket,
      remote: rinfo,
      local: this.udpAddress(),
      logger: this.logger,
      autoListen: false,
    })
    this.udpLinks.set(key, link)
    link.onclose = () => this.udpLinks.delete(key)
    // Start the handshake FIRST so its message handler is installed before the
    // datagram that announced this peer is replayed into the link.
    this.acceptLink(link)
    link.receive(rawMessage, rinfo)
  }

  handlePunch(payload, rinfo) {
    const token = payload.toString('utf8')
    if (!token.startsWith(`${PUNCH_PREFIX}:`)) return
    if (token.slice(PUNCH_PREFIX.length + 1) !== this.hostId) return
    const key = `${rinfo.address}:${rinfo.port}`
    this.recentPunchers.set(key, Date.now())
    if (this.recentPunchers.size > 64) {
      const cutoff = Date.now() - 90000
      for (const [entry, at] of this.recentPunchers) if (at < cutoff) this.recentPunchers.delete(entry)
    }
    try {
      this.udpSocket.send(encodePunch(token), rinfo.port, rinfo.address)
    } catch {}
  }

  // ---- relay -------------------------------------------------------------

  startRelay() {
    if (!this.config.relay?.host || !this.udpSocket) return
    this.connectRelay()
  }

  connectRelay() {
    const { host, port, token } = this.config.relay
    this.relayState = 'connecting'
    const socket = net.connect({ host, port })
    this.relaySocket = socket
    socket.setNoDelay(true)
    let buffered = ''
    let paired = false
    const fail = (reason) => {
      this.relayState = `retry: ${reason}`
      try {
        socket.destroy()
      } catch {}
      this.relaySocket = null
      if (this.relayRetry) return
      this.relayRetry = setTimeout(() => {
        this.relayRetry = null
        this.connectRelay()
      }, 15000)
      if (this.relayRetry.unref) this.relayRetry.unref()
    }
    socket.on('error', (error) => fail(error.message))
    socket.on('close', () => {
      if (paired) fail('relay closed')
    })
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
        if (message.t === 'ok') this.relayState = 'waiting'
        else if (message.t === 'error') fail(message.message ?? 'relay error')
        else if (message.t === 'paired') {
          paired = true
          this.relayState = 'paired'
          socket.removeListener('data', onData)
          const link = new TcpLink(socket, { remote: `${host}:${port}` })
          this.acceptLink(link)
        }
      }
    }
    socket.on('data', onData)
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ t: 'join', room: this.hostId, role: 'host', token, name: this.config.name })}\n`)
    })
  }

  // ---- status ------------------------------------------------------------

  status() {
    return {
      state: this.state,
      error: this.error,
      hostId: this.hostId,
      name: this.config.name,
      startedAt: this.startedAt,
      tcpPort: this.tcpServer ? this.tcpServer.address().port : this.tcpPort,
      udpPort: this.udpAddress(),
      bindHost: this.config.bindHost,
      origin: this.origin,
      candidates: this.state === 'listening' ? this.candidates() : [],
      nat: { behavior: this.stun.behavior, mapped: this.stun.mapped, at: this.stun.at },
      relay: { configured: Boolean(this.config.relay?.host), state: this.relayState },
      peers: [...this.peers.values()].map((peer) => peer.describe()),
      autoStart: this.config.autoStart,
    }
  }
}
