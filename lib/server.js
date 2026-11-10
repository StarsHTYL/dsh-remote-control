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
import { AuditLog } from './audit.js'
import { DeviceStore, deviceIdOf, summarizeParams } from './devices.js'
import { b64u, fromB64u, hmac, randomBytes, sha256, shortId, utf8 } from './util.js'

const PUNCH_PREFIX = 'DSHR1PUNCH'
const MAX_PEERS = 8
/** Methods an unapproved device may still call: enough to learn it is pending. */
const OPEN_METHODS = new Set(['sys.info', 'sys.ping'])

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
  constructor({ link, channel, device, identity, rpc, logger, onGone, onDevice, audit, approved = false }) {
    this.id = shortId(6)
    this.link = link
    this.channel = channel
    this.device = device
    this.identity = identity
    this.rpc = rpc
    this.logger = logger
    this.onGone = onGone
    this.onDevice = onDevice
    this.audit = audit
    this.approved = approved
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
        this.device = {
          ...(this.device ?? {}),
          name: String(value.d.name ?? this.device?.name ?? 'unknown'),
          os: String(value.d.os ?? this.device?.os ?? ''),
        }
        this.onDevice?.({ name: this.device.name, os: this.device.os })
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
    const started = Date.now()
    const handler = this.rpc.table.get(request.m)
    if (!handler) {
      this.emit({ i: request.i, e: { code: 'unknown-method', message: `unknown method ${request.m}` } })
      return
    }
    if (!this.approved && !OPEN_METHODS.has(request.m)) {
      this.audit?.append({
        event: 'denied',
        deviceId: this.device?.id ?? '',
        deviceName: this.device?.name ?? this.id,
        method: request.m,
        ok: false,
        code: 'device-pending',
        detail: summarizeParams(request.m, request.p),
      })
      this.emit({
        i: request.i,
        e: { code: 'device-pending', message: 'this device is waiting for approval on the host' },
      })
      return
    }
    try {
      const result = await handler(request.p ?? {}, this)
      this.emit({ i: request.i, r: result ?? null })
      this.audit?.append({
        event: 'rpc',
        deviceId: this.device?.id ?? '',
        deviceName: this.device?.name ?? this.id,
        method: request.m,
        ok: true,
        ms: Date.now() - started,
        detail: summarizeParams(request.m, request.p),
      })
    } catch (error) {
      const code = error instanceof RpcError ? error.code : 'internal'
      if (!(error instanceof RpcError)) this.logger?.warn?.(`rpc ${request.m} failed: ${error?.stack ?? error}`)
      this.audit?.append({
        event: 'rpc',
        deviceId: this.device?.id ?? '',
        deviceName: this.device?.name ?? this.id,
        method: request.m,
        ok: false,
        ms: Date.now() - started,
        code,
        detail: summarizeParams(request.m, request.p),
      })
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
      approved: this.approved,
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
    this.udp6Socket = null
    this.tcpServer6 = null
    this.udpLinks = new Map()
    this.devices = new DeviceStore({
      dataDir: options.dataDir,
      autoApprove: options.config?.autoApprove === true,
      logger: options.logger,
    })
    this.audit = new AuditLog({ dataDir: options.dataDir, logger: options.logger })
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
      audit: () => this.audit,
      device: (peer) => peer?.device ?? null,
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
      await this.devices.load()
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
      this.udpSocket.on('message', (message, rinfo) => this.onDatagram(this.udpSocket, message, rinfo))
      this.udpSocket.on('error', (error) => this.logger?.warn?.(`udp socket error: ${error.message}`))
      await this.startIpv6()
      this.startedAt = Date.now()
      this.state = 'listening'
      this.refreshStun().catch(() => {})
      this.startRelay()
      this.logger?.info?.(
        `remote control listening on tcp ${this.tcpServer.address().port} / udp ${this.udpAddress()}` +
          (this.tcpServer6 ? ` / v6 tcp ${this.tcpPort} udp ${this.udp6Port}` : ''),
      )
      return this.status()
    } catch (error) {
      this.state = 'error'
      this.error = String(error?.message ?? error)
      await this.stop()
      throw error
    }
  }

  /**
   * Second listener stack for IPv6. A global IPv6 address needs no NAT traversal
   * at all, which is the only path left when both peers sit behind carrier NAT.
   */
  async startIpv6() {
    if (!this.config.ipv6) return
    // An explicit bind address means "only this interface"; adding a wildcard
    // IPv6 listener would silently widen it back to every interface.
    const bind = this.config.bindHost
    if (bind !== '0.0.0.0' && bind !== '::') return
    try {
      this.tcpServer6 = await createTcpServer({
        host: '::',
        port: this.tcpPort,
        ipv6Only: true,
        onLink: (link) => this.acceptLink(link),
      })
    } catch (error) {
      this.logger?.debug?.(`ipv6 tcp listener unavailable: ${error.message}`)
    }
    try {
      this.udp6Socket = await createUdpSocket({ port: this.udp6Port, host: '::' })
      this.udp6Socket.on('message', (message, rinfo) => this.onDatagram(this.udp6Socket, message, rinfo))
      this.udp6Socket.on('error', (error) => this.logger?.warn?.(`udp6 socket error: ${error.message}`))
    } catch (error) {
      this.logger?.debug?.(`ipv6 udp socket unavailable: ${error.message}`)
      this.udp6Socket = null
    }
  }

  udpAddress() {
    return this.udpSocket ? this.udpSocket.address().port : this.config.udpPort
  }

  get udp6Port() {
    return this.udp6Socket ? this.udp6Socket.address().port : this.config.udpPort
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
    if (this.tcpServer6) {
      await new Promise((resolve) => this.tcpServer6.close(resolve))
      this.tcpServer6 = null
    }
    if (this.tcpServer) {
      await new Promise((resolve) => this.tcpServer.close(resolve))
      this.tcpServer = null
    }
    if (this.udp6Socket) {
      try {
        this.udp6Socket.close()
      } catch {}
      this.udp6Socket = null
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

  /** Global (routable) IPv6 addresses; link-local and loopback are useless remotely. */
  globalAddressesV6() {
    const found = []
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const entry of list ?? []) {
        const family = entry.family === 'IPv6' || entry.family === 6
        if (!family || entry.internal) continue
        const address = entry.address.split('%')[0]
        if (address === '::1' || /^fe[89ab][0-9a-f]:/i.test(address)) continue
        found.push({ address, name })
      }
    }
    const seen = new Set()
    return found.filter((entry) => {
      if (seen.has(entry.address)) return false
      seen.add(entry.address)
      return true
    })
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
    if (this.tcpServer6 || this.udp6Socket) {
      for (const entry of this.globalAddressesV6()) {
        if (this.tcpServer6) list.push({ kind: 'tcp', host: entry.address, port: this.tcpPort, label: 'v6' })
        if (this.udp6Socket) list.push({ kind: 'udp', host: entry.address, port: this.udp6Port, label: 'v6' })
      }
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
      this.audit.append({ event: 'reject', ok: false, code: 'handshake', detail: `${link.kind} ${link.describe?.().remote ?? ''}` })
      link.close()
    }
  }

  adopt(link, key, peerPub, extra) {
    const deviceId = deviceIdOf(peerPub)
    const known = this.devices.get(deviceId)
    if (known?.status === 'blocked') {
      this.audit.append({
        event: 'blocked',
        deviceId,
        deviceName: known.name,
        ok: false,
        code: 'device-blocked',
        remote: link.describe?.().remote ?? '',
      })
      link.close()
      return null
    }
    const record = this.devices.touch({
      pub: peerPub,
      name: extra?.deviceName,
      os: extra?.deviceOs,
      remote: link.describe?.().remote ?? '',
    })
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
      device: { id: record.id, name: record.name, os: record.os, status: record.status },
      approved: record.status === 'approved',
      rpc: this.rpc,
      logger: this.logger,
      audit: this.audit,
      onGone: (gone, reason) => {
        this.peers.delete(gone.id)
        this.audit.append({
          event: 'disconnect',
          deviceId: gone.device?.id ?? '',
          deviceName: gone.device?.name ?? gone.id,
          detail: reason,
        })
        this.logger?.info?.(`peer ${gone.id} gone (${reason})`)
      },
      onDevice: ({ name, os }) => {
        const stored = this.devices.get(deviceId)
        if (!stored) return
        stored.name = String(name).slice(0, 64)
        stored.os = String(os).slice(0, 64)
        this.devices.save()
      },
    })
    this.peers.set(peer.id, peer)
    peer.emit({
      ev: 'ready',
      d: {
        peerId: peer.id,
        approved: peer.approved,
        device: peer.device,
        host: this.status(),
      },
    })
    this.audit.append({
      event: peer.approved ? 'connect' : 'pending',
      deviceId: record.id,
      deviceName: record.name,
      detail: `${link.kind} ${link.describe?.().remote ?? ''}`,
      remote: link.describe?.().remote ?? '',
    })
    this.logger?.info?.(`peer ${peer.id} connected over ${link.kind} (${record.status})`)
    return peer
  }

  /** Approve a device: applies to its live peers immediately. */
  async approveDevice(deviceId) {
    const record = this.devices.resync(deviceId)
    if (!record) return { ok: false, error: 'unknown-device' }
    for (const peer of this.peers.values()) {
      if (peer.device?.id !== deviceId || peer.approved) continue
      peer.approved = true
      peer.device.status = 'approved'
      peer.emit({ ev: 'device.approved', d: { deviceId } })
    }
    this.audit.append({ event: 'approve', deviceId, deviceName: record.name })
    return { ok: true, device: this.devices.get(deviceId) }
  }

  async blockDevice(deviceId) {
    const record = this.devices.get(deviceId)
    if (!record) return { ok: false, error: 'unknown-device' }
    record.status = 'blocked'
    record.blockedAt = Date.now()
    await this.devices.save()
    for (const peer of this.peers.values()) {
      if (peer.device?.id === deviceId) peer.close('device blocked')
    }
    this.audit.append({ event: 'block', deviceId, deviceName: record.name })
    return { ok: true, device: record }
  }

  async forgetDevice(deviceId) {
    for (const peer of [...this.peers.values()]) {
      if (peer.device?.id === deviceId) peer.close('device forgotten')
    }
    const removed = await this.devices.remove(deviceId)
    if (removed) this.audit.append({ event: 'forget', deviceId })
    return { ok: removed }
  }

  onDatagram(socket, message, rinfo) {
    if (message.length > 6 && message[0] === 1) {
      // link-udp packet: route to its link, or open one for a fresh endpoint.
      const key = `${socket === this.udp6Socket ? 'v6' : 'v4'}|${rinfo.address}|${rinfo.port}`
      const existing = this.udpLinks.get(key)
      if (existing) {
        existing.receive(message, rinfo)
        return
      }
      const flags = message[1]
      if (flags & 0x04) {
        this.handlePunch(socket, message.subarray(6), rinfo)
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
      this.openUdpPeer(socket, key, rinfo, payload, message)
    }
  }

  openUdpPeer(socket, key, rinfo, payload, rawMessage) {
    const marker = this.recentPunchers.get(key)
    if (!marker || Date.now() - marker > 90000) {
      this.logger?.debug?.(`udp hello from unpunched endpoint ${key}`)
      return
    }
    const link = new UdpLink({
      socket,
      remote: rinfo,
      local: socket === this.udp6Socket ? this.udp6Port : this.udpAddress(),
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

  handlePunch(socket, payload, rinfo) {
    const token = payload.toString('utf8')
    if (!token.startsWith(`${PUNCH_PREFIX}:`)) return
    if (token.slice(PUNCH_PREFIX.length + 1) !== this.hostId) return
    const key = `${socket === this.udp6Socket ? 'v6' : 'v4'}|${rinfo.address}|${rinfo.port}`
    this.recentPunchers.set(key, Date.now())
    if (this.recentPunchers.size > 64) {
      const cutoff = Date.now() - 90000
      for (const [entry, at] of this.recentPunchers) if (at < cutoff) this.recentPunchers.delete(entry)
    }
    try {
      socket.send(encodePunch(token), rinfo.port, rinfo.address)
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
      udp6Port: this.udp6Socket ? this.udp6Port : null,
      ipv6: this.globalAddressesV6().map((entry) => entry.address),
      bindHost: this.config.bindHost,
      origin: this.origin,
      candidates: this.state === 'listening' ? this.candidates() : [],
      nat: { behavior: this.stun.behavior, mapped: this.stun.mapped, at: this.stun.at },
      relay: { configured: Boolean(this.config.relay?.host), state: this.relayState },
      peers: [...this.peers.values()].map((peer) => peer.describe()),
      devices: this.devices.describe(),
      pending: this.devices.pending().length,
      audit: this.audit.tail(12),
      autoStart: this.config.autoStart,
    }
  }
}
