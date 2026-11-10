/**
 * dsh-remote-control — HarmonyOS (ArkTS) 客户端参考实现
 *
 * 目标 API：HarmonyOS NEXT / API 12+。用到的系统能力：
 *   @kit.NetworkKit            socket（TCPSocket / UDPSocket）
 *   @kit.CryptoArchitectureKit cryptoFramework（X25519、AES-GCM、HMAC、随机数）
 *   @kit.ArkTS                 util.Base64Helper / buffer
 *
 * 注意：这份文件没有在本机构建验证过（没有 DevEco 环境），它是按
 * docs/PROTOCOL.md 写成的**接线参考**：协议逻辑是完整的，个别系统 API 的
 * 签名可能随 SDK 版本微调，接进工程后请以编译器提示为准。
 *
 * 用法：
 *   const tunnel = new RemoteTunnel()
 *   await tunnel.connect(pairingCode)            // "dshr1.…"
 *   const info = await tunnel.call('sys.info')
 *   const list = await tunnel.call('fs.list', { path: info.roots[0].path })
 *   await tunnel.upload('/sdcard/photo.jpg', 'E:\\Uploads\\photo.jpg')
 */

import { socket } from '@kit.NetworkKit'
import { cryptoFramework } from '@kit.CryptoArchitectureKit'
import { util } from '@kit.ArkTS'

// ---------------------------------------------------------------- 编码工具

const B64 = new util.Base64Helper()

function toB64u(bytes: Uint8Array): string {
  return B64.encodeToStringSync(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64u(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  return B64.decodeSync(padded)
}

function utf8(text: string): Uint8Array {
  return new util.TextEncoder().encodeInto(text)
}

function utf8Decode(bytes: Uint8Array): string {
  return util.TextDecoder.create('utf-8').decodeToString(bytes)
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function u16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff])
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function randomBytes(length: number): Uint8Array {
  const random = cryptoFramework.createRandom()
  return random.generateRandomSync(length).data
}

// ---------------------------------------------------------------- 密码学

function createMac(key: Uint8Array): cryptoFramework.Mac {
  const generator = cryptoFramework.createSymKeyGenerator('HMAC')
  const symKey = generator.convertKeySync({ data: key })
  const mac = cryptoFramework.createMac('SHA256')
  mac.initSync(symKey)
  return mac
}

function hmacSha256(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const mac = createMac(key)
  for (const part of parts) mac.updateSync({ data: part })
  return mac.doFinalSync().data
}

function sha256(data: Uint8Array): Uint8Array {
  const md = cryptoFramework.createMd('SHA256')
  md.updateSync({ data })
  return md.digestSync().data
}

/** HKDF-SHA256（extract + 单块 expand，输出 32 字节足够本协议）。 */
function hkdf32(ikm: Uint8Array, salt: Uint8Array, info: string): Uint8Array {
  const prk = hmacSha256(salt, ikm)
  return hmacSha256(prk, utf8(info), new Uint8Array([1]))
}

/** 32 字节裸公钥 → SPKI PEM（cryptoFramework 只接受 PEM/DER 形式）。 */
const SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
])

function publicKeyPem(raw: Uint8Array): string {
  const der = concat([SPKI_PREFIX, raw])
  const body = B64.encodeToStringSync(der)
  return '-----BEGIN PUBLIC KEY-----\n' + body + '\n-----END PUBLIC KEY-----\n'
}

async function x25519(ownPrivate: cryptoFramework.PriKey, peerPublicRaw: Uint8Array): Promise<Uint8Array> {
  const generator = cryptoFramework.createAsyKeyGenerator('X25519')
  const pair = await generator.convertPemKeySync(publicKeyPem(peerPublicRaw), '')
  const agreement = cryptoFramework.createKeyAgreement('X25519')
  await agreement.init(ownPrivate)
  const secret = await agreement.generateSecret(pair.priKey)
  return secret.data
}

function aesGcmEncrypt(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array): Uint8Array {
  const generator = cryptoFramework.createSymKeyGenerator('AES256')
  const symKey = generator.convertKeySync({ data: key })
  const cipher = cryptoFramework.createCipher('AES256|GCM|NoPadding')
  cipher.initSync({ algName: 'AES256|GCM|NoPadding', key: symKey, iv: { data: nonce } })
  const body = cipher.updateSync({ data: plain }).data
  const tag = cipher.doFinalSync().data
  return concat([nonce, body, tag])
}

function aesGcmDecrypt(key: Uint8Array, frame: Uint8Array): Uint8Array {
  const nonce = frame.subarray(0, 12)
  const tag = frame.subarray(frame.length - 16)
  const body = frame.subarray(12, frame.length - 16)
  const generator = cryptoFramework.createSymKeyGenerator('AES256')
  const symKey = generator.convertKeySync({ data: key })
  const cipher = cryptoFramework.createCipher('AES256|GCM|NoPadding')
  cipher.initSync({ algName: 'AES256|GCM|NoPadding', key: symKey, iv: { data: nonce } })
  cipher.setAuthTag({ data: tag })
  return cipher.doFinalSync({ data: body }).data
}

// ---------------------------------------------------------------- 链路

interface Candidate {
  kind: string
  host: string
  port: number
  label?: string
}

/** HarmonyOS socket family: 1 = IPv4, 2 = IPv6. */
function familyOf(host: string): number {
  return host.includes(':') ? 2 : 1
}

interface RelayInfo {
  host: string
  port: number
  room: string
  token: string
}

interface PairingOffer {
  v: number
  id: string
  name: string
  pk: string
  psk: string
  exp: number
  cands: Candidate[]
  relay: RelayInfo | null
}

/** 链路抽象：一条消息 = 一段字节。 */
interface Link {
  send(bytes: Uint8Array): void
  close(): void
  maxPayload: number
}

class TcpLink implements Link {
  maxPayload: number = 8 * 1024 * 1024
  private pending: Uint8Array = new Uint8Array(0)

  constructor(
    private tcp: socket.TCPSocket,
    private onMessage: (bytes: Uint8Array) => void,
    private onClose: () => void,
  ) {
    this.tcp.on('message', (value: socket.SocketMessageInfo) => {
      this.feed(new Uint8Array(value.message))
    })
    this.tcp.on('close', () => this.onClose())
    this.tcp.on('error', () => this.onClose())
  }

  private feed(chunk: Uint8Array): void {
    this.pending = concat([this.pending, chunk])
    for (;;) {
      if (this.pending.length < 4) return
      const length = readU32(this.pending, 0)
      if (this.pending.length < 4 + length) return
      const body = this.pending.slice(4, 4 + length)
      this.pending = this.pending.slice(4 + length)
      this.onMessage(body)
    }
  }

  send(bytes: Uint8Array): void {
    this.tcp.send({ data: concat([u32(bytes.length), bytes]).buffer as ArrayBuffer })
  }

  close(): void {
    this.tcp.off('message')
    this.tcp.close()
  }
}

/** 可靠 UDP：序号 + ACK + 重传 + 乱序缓存（与 lib/link-udp.js 等价）。 */
class UdpLink implements Link {
  maxPayload: number = 994
  private sendSeq = 1
  private inFlight: Map<number, Uint8Array> = new Map()
  private nextExpected = 1
  private buffered: Map<number, Uint8Array> = new Map()
  private timer: number = -1

  constructor(
    private udp: socket.UDPSocket,
    private remote: Candidate,
    private onMessage: (bytes: Uint8Array) => void,
  ) {
    this.udp.on('message', (value: socket.SocketMessageInfo) => {
      this.receive(new Uint8Array(value.message), value.remoteInfo.address, value.remoteInfo.port)
    })
    this.timer = setInterval(() => this.retransmit(), 400)
  }

  private frame(flags: number, seq: number, payload: Uint8Array): Uint8Array {
    return concat([new Uint8Array([1, flags]), u32(seq), payload])
  }

  private write(bytes: Uint8Array): void {
    this.udp.send({
      data: bytes.buffer as ArrayBuffer,
      address: { address: this.remote.host, port: this.remote.port, family: familyOf(this.remote.host) },
    })
  }

  send(bytes: Uint8Array): void {
    const seq = this.sendSeq++
    if (this.sendSeq === 0) this.sendSeq = 1
    const packet = this.frame(0x08, seq, bytes)
    this.inFlight.set(seq, packet)
    this.write(packet)
  }

  private sendAck(seq: number): void {
    this.write(this.frame(0x01, 0, u32(seq)))
  }

  private retransmit(): void {
    for (const [seq, packet] of this.inFlight) {
      this.write(packet)
      if (seq < this.nextExpected) this.inFlight.delete(seq)
    }
  }

  private receive(message: Uint8Array, address: string, port: number): void {
    if (address !== this.remote.host || port !== this.remote.port) return
    if (message.length < 6 || message[0] !== 1) return
    const flags = message[1]
    const seq = readU32(message, 2)
    const payload = message.slice(6)
    if (flags === 0x01) {
      const acked = readU32(payload, 0)
      for (const key of Array.from(this.inFlight.keys())) if (key <= acked) this.inFlight.delete(key)
      return
    }
    if (flags !== 0x08) return
    if (seq < this.nextExpected) {
      this.sendAck(this.nextExpected - 1)
      return
    }
    if (seq === this.nextExpected) {
      this.nextExpected++
      this.onMessage(payload)
      while (this.buffered.has(this.nextExpected)) {
        const next = this.buffered.get(this.nextExpected)!
        this.buffered.delete(this.nextExpected)
        this.nextExpected++
        this.onMessage(next)
      }
      this.sendAck(this.nextExpected - 1)
      return
    }
    this.buffered.set(seq, payload)
    this.sendAck(this.nextExpected - 1)
  }

  close(): void {
    clearInterval(this.timer)
    this.udp.off('message')
    this.udp.close()
  }
}

// ---------------------------------------------------------------- 隧道

export class RemoteTunnel {
  private link: Link | null = null
  private key: Uint8Array = new Uint8Array(0)
  private nextId = 1
  private pending: Map<number, (value: unknown, error?: Error) => void> = new Map()
  private handlers: Map<string, (payload: Record<string, Object>) => void> = new Map()
  private receiveBuffer: Uint8Array = new Uint8Array(0)
  private partial: Map<number, Uint8Array[]> = new Map()
  private privateKey: cryptoFramework.PriKey | null = null
  private publicRaw: Uint8Array = new Uint8Array(0)
  private fragmentPayload = 900
  offer: PairingOffer | null = null
  transport: string = ''

  // ------------------------------------------------------------ 连接

  async connect(code: string): Promise<void> {
    const offer = RemoteTunnel.parseOffer(code)
    this.offer = offer
    await this.ensureIdentity()
    const psk = fromB64u(offer.psk)

    const tcp = offer.cands.filter((c) => c.kind === 'tcp')
    tcp.sort((a, b) => Number((b.label ?? '').startsWith('lan')) - Number((a.label ?? '').startsWith('lan')))
    for (const candidate of tcp) {
      try {
        this.link = await this.connectTcp(candidate)
        this.transport = 'tcp'
        await this.handshake(psk, offer.pk)
        return
      } catch {
        this.link = null
      }
    }

    const udp = offer.cands.filter((c) => c.kind === 'udp')
    for (const candidate of udp) {
      try {
        this.link = await this.punchUdp(candidate, offer.id)
        this.transport = 'udp'
        await this.handshake(psk, offer.pk)
        return
      } catch {
        this.link?.close()
        this.link = null
      }
    }

    if (offer.relay) {
      this.link = await this.connectRelay(offer.relay)
      this.transport = 'relay'
      await this.handshake(psk, offer.pk)
      return
    }
    throw new Error('no path to host')
  }

  static parseOffer(code: string): PairingOffer {
    const text = code.trim().startsWith('dshr1.') ? code.trim().slice(6) : code.trim()
    const offer = JSON.parse(utf8Decode(fromB64u(text))) as PairingOffer
    if (offer.v !== 1 || !offer.pk || !offer.psk) throw new Error('invalid pairing code')
    return offer
  }

  /**
   * 设备审批绑定的是**公钥**，所以这把密钥必须跨进程保存。
   * 不传 privateKeyPem 时每次连接都会生成新身份，主机那边每次都要重新批准；
   * 把 getIdentityPem() 的返回值存进 preferences 再传回来即可只批一次。
   */
  constructor(privateKeyPem: string = '') {
    this.privateKeyPem = privateKeyPem
  }

  private privateKeyPem: string

  getIdentityPem(): string {
    return this.privateKeyPem
  }

  private async ensureIdentity(): Promise<void> {
    const generator = cryptoFramework.createAsyKeyGenerator('X25519')
    let pair: cryptoFramework.KeyPair
    if (this.privateKeyPem) {
      pair = await generator.convertPemKeySync(this.privateKeyPem, '')
    } else {
      pair = await generator.generateKeyPair()
      this.privateKeyPem = pair.priKey.getEncoded()
    }
    this.privateKey = pair.priKey
    // 从 PEM 里取回 32 字节裸公钥，保证与协议里的 b64u(pk) 一致。
    const pem = pair.pubKey.getEncoded()
    const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
    const der = B64.decodeSync(body)
    this.publicRaw = der.slice(der.length - 32)
  }

  private connectTcp(candidate: Candidate): Promise<Link> {
    return new Promise<Link>((resolve, reject) => {
      const tcp = socket.constructTCPSocketInstance()
      const timer = setTimeout(() => {
        tcp.close()
        reject(new Error('tcp timeout'))
      }, 4000)
      tcp.connect({
        address: { address: candidate.host, port: candidate.port, family: familyOf(candidate.host) },
        timeout: 4000,
      }).then(() => {
        clearTimeout(timer)
        const link = new TcpLink(tcp, (bytes) => this.onLinkMessage(bytes), () => {})
        resolve(link)
      }).catch((error: Error) => {
        clearTimeout(timer)
        tcp.close()
        reject(error)
      })
    })
  }

  /** 打洞：先狂发 PUNCH，收到回声后转成可靠 UDP 链路。IPv6 候选无需打洞，回声即直连。 */
  private async punchUdp(candidate: Candidate, hostId: string): Promise<Link> {
    const family = familyOf(candidate.host)
    const udp = socket.constructUDPSocketInstance()
    await udp.bind({ address: family === 2 ? '::' : '0.0.0.0', port: 0, family })
    const token = utf8('DSHR1PUNCH:' + hostId)

    const opened = await new Promise<Candidate | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 2500)
      udp.on('message', (value: socket.SocketMessageInfo) => {
        const bytes = new Uint8Array(value.message)
        if (bytes.length > 6 && bytes[0] === 1 && (bytes[1] & 0x04) !== 0) {
          clearTimeout(timer)
          resolve({
            kind: 'udp',
            host: value.remoteInfo.address,
            port: value.remoteInfo.port,
            label: 'punched',
          })
        }
      })
      const sender = setInterval(() => {
        udp.send({
          data: concat([new Uint8Array([1, 0x04]), new Uint8Array([0, 0, 0, 0]), token]).buffer as ArrayBuffer,
          address: { address: candidate.host, port: candidate.port, family },
        })
      }, 250)
      setTimeout(() => clearInterval(sender), 2600)
    })

    if (opened === null) {
      udp.off('message')
      udp.close()
      throw new Error('punch failed')
    }
    return new UdpLink(udp, opened, (bytes) => this.onLinkMessage(bytes))
  }

  private connectRelay(relay: RelayInfo): Promise<Link> {
    return new Promise<Link>((resolve, reject) => {
      const tcp = socket.constructTCPSocketInstance()
      let buffered = ''
      const timer = setTimeout(() => reject(new Error('relay timeout')), 8000)
      tcp.on('message', (value: socket.SocketMessageInfo) => {
        buffered += utf8Decode(new Uint8Array(value.message))
        const index = buffered.indexOf('\n')
        if (index < 0) return
        const line = buffered.slice(0, index)
        buffered = buffered.slice(index + 1)
        let message: Record<string, string>
        try {
          message = JSON.parse(line) as Record<string, string>
        } catch {
          return
        }
        if (message.t === 'paired') {
          clearTimeout(timer)
          tcp.off('message')
          resolve(new TcpLink(tcp, (bytes) => this.onLinkMessage(bytes), () => {}))
        } else if (message.t === 'error') {
          clearTimeout(timer)
          tcp.close()
          reject(new Error(message.message))
        }
      })
      tcp.connect({ address: { address: relay.host, port: relay.port, family: familyOf(relay.host) }, timeout: 5000 })
        .then(() => {
          const join = { t: 'join', room: relay.room, role: 'guest', token: relay.token, name: 'harmonyos' }
          tcp.send({ data: utf8(JSON.stringify(join) + '\n').buffer as ArrayBuffer })
        })
        .catch((error: Error) => {
          clearTimeout(timer)
          reject(error)
        })
    })
  }

  // ------------------------------------------------------------ 握手

  private async handshake(psk: Uint8Array, hostPubB64u: string): Promise<void> {
    const n1 = randomBytes(24)
    const proof = hmacSha256(psk, utf8('dshr1/c'), this.publicRaw, n1)
    this.link!.send(utf8(JSON.stringify({
      t: 'hello', v: 1, pk: toB64u(this.publicRaw), n1: toB64u(n1), proof: toB64u(proof),
    })))

    const welcome = await this.expectHandshakeFrame()
    if (welcome.t !== 'welcome') throw new Error('unexpected handshake reply')
    const hostPub = fromB64u(welcome.pk as string)
    const n2 = fromB64u(welcome.n2 as string)
    const expected = hmacSha256(psk, utf8('dshr1/s'), hostPub, n1, n2, this.publicRaw)
    if (toB64u(expected) !== welcome.proof) throw new Error('host proof mismatch: wrong pairing code')

    const shared = await x25519(this.privateKey!, hostPub)
    this.key = hkdf32(concat([shared, psk]), concat([n1, n2]), 'dshr1/tunnel')
    this.fragmentPayload = Math.max(256, (this.link!.maxPayload) - 35)
    this.handshakeHook = null
  }

  private expectHandshakeFrame(): Promise<Record<string, Object>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('handshake timeout')), 8000)
      const previous = this.handshakeHook
      this.handshakeHook = (bytes: Uint8Array) => {
        clearTimeout(timer)
        this.handshakeHook = previous
        resolve(JSON.parse(utf8Decode(bytes)) as Record<string, Object>)
      }
    })
  }

  private handshakeHook: ((bytes: Uint8Array) => void) | null = null

  /** 链路层回调：握手阶段交给 hook，之后走 AEAD。 */
  private onLinkMessage(bytes: Uint8Array): void {
    if (this.handshakeHook) {
      this.handshakeHook(bytes)
      return
    }
    let plain: Uint8Array
    try {
      plain = aesGcmDecrypt(this.key, bytes)
    } catch {
      return
    }
    if (plain.length < 7 || plain[0] !== 1) return
    const index = readU16(plain, 1)
    const count = readU16(plain, 3)
    const msgId = readU16(plain, 5)
    const body = plain.slice(7)
    const pieces = this.partial.get(msgId) ?? new Array<Uint8Array>(count)
    pieces[index] = body
    this.partial.set(msgId, pieces)
    for (let i = 0; i < count; i++) if (!pieces[i]) return
    this.partial.delete(msgId)
    this.dispatch(JSON.parse(utf8Decode(concat(pieces))))
  }

  // ------------------------------------------------------------ 消息

  private dispatch(message: Record<string, Object>): void {
    const id = message.i as number
    if (id !== undefined) {
      const settle = this.pending.get(id)
      if (!settle) return
      this.pending.delete(id)
      const error = message.e as Record<string, string> | undefined
      if (error) settle(null, new Error(error.message))
      else settle(message.r, undefined)
      return
    }
    const event = message.ev as string
    const handler = this.handlers.get(event)
    if (handler) handler(message.d as Record<string, Object>)
  }

  private send(value: Record<string, Object>): void {
    const payload = utf8(JSON.stringify(value))
    const count = Math.max(1, Math.ceil(payload.length / this.fragmentPayload))
    const msgId = this.nextId % 0xffff
    for (let index = 0; index < count; index++) {
      const piece = payload.slice(index * this.fragmentPayload, (index + 1) * this.fragmentPayload)
      const header = concat([new Uint8Array([1]), u16(index), u16(count), u16(msgId)])
      this.link!.send(aesGcmEncrypt(this.key, randomBytes(12), concat([header, piece])))
    }
  }

  on(event: string, handler: (payload: Record<string, Object>) => void): void {
    this.handlers.set(event, handler)
  }

  call(method: string, params?: Record<string, Object>, timeoutMs: number = 20000): Promise<Record<string, Object>> {
    return new Promise<Record<string, Object>>((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('rpc timeout: ' + method))
      }, timeoutMs)
      this.pending.set(id, (value, error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value as Record<string, Object>)
      })
      this.send({ i: id, m: method, p: params ?? {} })
    })
  }

  // ------------------------------------------------------------ 文件

  /** 上传：按 offset 追加，天然断点续传。 */
  async upload(localPath: string, remotePath: string): Promise<void> {
    const file = await import('@kit.CoreFileKit')
    const stat = await file.fs.stat(localPath)
    const handle = await file.fs.open(localPath, file.fs.OpenMode.READ_ONLY)
    try {
      let offset = 0
      const chunk = 128 * 1024
      const buffer = new ArrayBuffer(chunk)
      while (offset < stat.size) {
        const read = await file.fs.read(handle.fd, buffer, { offset, length: Math.min(chunk, stat.size - offset) })
        const bytes = new Uint8Array(buffer).slice(0, read)
        await this.call('fs.write', { path: remotePath, offset, data: toB64u(bytes), truncate: offset === 0 }, 60000)
        offset += read
      }
    } finally {
      await file.fs.close(handle)
    }
  }

  /** 下载：按 offset 拉取直到 eof。 */
  async download(remotePath: string, localPath: string): Promise<void> {
    const file = await import('@kit.CoreFileKit')
    const handle = await file.fs.open(localPath, file.fs.OpenMode.READ_WRITE | file.fs.OpenMode.CREATE)
    try {
      let offset = 0
      for (;;) {
        const chunk = await this.call('fs.read', { path: remotePath, offset, length: 256 * 1024 }, 60000)
        const data = fromB64u(chunk.data as string)
        if (data.length > 0) {
          await file.fs.write(handle.fd, data.buffer as ArrayBuffer, { offset, length: data.length })
          offset += data.length
        }
        if (chunk.eof === true) break
      }
    } finally {
      await file.fs.close(handle)
    }
  }

  close(): void {
    this.link?.close()
    this.link = null
  }

  /** 主机指纹，用于在界面上区分不同机器。 */
  get hostId(): string {
    return this.offer?.id ?? ''
  }
}

/** 把配对码画成二维码前的预览文本：客户端也可以直接把二维码里的字符串传进来。 */
export function hostSummary(code: string): string {
  const offer = RemoteTunnel.parseOffer(code)
  return offer.name + ' · ' + offer.id + ' · ' + offer.cands.length + ' 个候选地址'
}
