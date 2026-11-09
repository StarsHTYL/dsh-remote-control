/**
 * Pairing handshake and authenticated framing.
 *
 * Handshake (role: client initiates):
 *   C -> S  {"t":"hello","v":1,"pk":<b64u X25519 32B>,"n1":<b64u 24B>,"proof":<b64u 32B>}
 *   S -> C  {"t":"welcome","v":1,"pk":...,"n2":...,"proof":<b64u 32B>}
 *
 *   proof_C = HMAC-SHA256(psk, "dshr1/c" || pk_C || n1)
 *   proof_S = HMAC-SHA256(psk, "dshr1/s" || pk_S || n1 || n2 || pk_C)
 *
 *   Z   = X25519(priv, peerPk)
 *   key = HKDF-SHA256(ikm = Z || psk, salt = n1 || n2, info = "dshr1/tunnel")
 *
 * Every later frame is AES-256-GCM: [12B nonce][ciphertext][16B tag], where the
 * plaintext of one message is split into fragments and each fragment is
 * independently sealed, so a lossy datagram link can retransmit per fragment.
 */
import crypto from 'node:crypto'
import { b64u, fromB64u, hkdf, hmac, safeEqual, utf8 } from './util.js'

const PROTOCOL = 'dshr1'
const MAX_MESSAGE = 8 * 1024 * 1024

// Raw 32-byte X25519 keys travel on the wire; these DER prefixes turn them back
// into KeyObjects because Node has no raw-key ECDH entry point.
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

export function publicKeyObject(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

export function privateKeyObject(raw) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' })
}

export function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)
  return { pub, priv }
}

export function identityFromRaw(privB64u) {
  const priv = fromB64u(privB64u)
  return { pub: publicFromPrivate(priv), priv }
}

/** Derive the raw 32-byte X25519 public key for a private key. */
export function publicFromPrivate(priv) {
  return crypto.createPublicKey(privateKeyObject(priv)).export({ type: 'spki', format: 'der' }).subarray(-32)
}

function agree(priv, peerPub) {
  return crypto.diffieHellman({
    privateKey: privateKeyObject(priv),
    publicKey: publicKeyObject(peerPub),
  })
}

function sendJson(link, value) {
  link.send(Buffer.from(JSON.stringify(value), 'utf8'))
}

function waitMessage(link, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`handshake timeout waiting for ${what}`))
    }, timeoutMs)
    if (timer.unref) timer.unref()
    const cleanup = () => {
      clearTimeout(timer)
      if (link.onmessage === onMessage) link.onmessage = null
    }
    const onMessage = (bytes) => {
      let value
      try {
        value = JSON.parse(bytes.toString('utf8'))
      } catch {
        return
      }
      cleanup()
      resolve(value)
    }
    link.onmessage = onMessage
    link.onerror = (error) => {
      cleanup()
      reject(error)
    }
  })
}

function tunnelKey(shared, psk, n1, n2) {
  return hkdf(Buffer.concat([shared, psk]), Buffer.concat([n1, n2]), `${PROTOCOL}/tunnel`, 32)
}

/** Client side of the pairing handshake. */
export async function clientHandshake(link, { psk, identity, timeoutMs = 8000 }) {
  const n1 = crypto.randomBytes(24)
  const proof = hmac(psk, utf8(`${PROTOCOL}/c`), identity.pub, n1)
  sendJson(link, { t: 'hello', v: 1, pk: b64u(identity.pub), n1: b64u(n1), proof: b64u(proof) })
  const welcome = await waitMessage(link, timeoutMs, 'welcome')
  if (welcome.t !== 'welcome' || welcome.v !== 1) throw new Error('unexpected handshake reply')
  const serverPub = fromB64u(welcome.pk)
  const n2 = fromB64u(welcome.n2)
  const expected = hmac(psk, utf8(`${PROTOCOL}/s`), serverPub, n1, n2, identity.pub)
  if (!safeEqual(expected, fromB64u(welcome.proof))) throw new Error('host proof mismatch: wrong pairing code')
  const key = tunnelKey(agree(identity.priv, serverPub), psk, n1, n2)
  return { key, peerPub: serverPub }
}

/** Host side of the pairing handshake. */
export async function serverHandshake(link, { psk, identity, timeoutMs = 8000 }) {
  const hello = await waitMessage(link, timeoutMs, 'hello')
  if (hello.t !== 'hello' || hello.v !== 1) throw new Error('unexpected handshake request')
  const clientPub = fromB64u(hello.pk)
  const n1 = fromB64u(hello.n1)
  const expected = hmac(psk, utf8(`${PROTOCOL}/c`), clientPub, n1)
  if (!safeEqual(expected, fromB64u(hello.proof))) throw new Error('client proof mismatch: wrong pairing code')
  const n2 = crypto.randomBytes(24)
  const proof = hmac(psk, utf8(`${PROTOCOL}/s`), identity.pub, n1, n2, clientPub)
  sendJson(link, { t: 'welcome', v: 1, pk: b64u(identity.pub), n2: b64u(n2), proof: b64u(proof) })
  const key = tunnelKey(agree(identity.priv, clientPub), psk, n1, n2)
  return { key, peerPub: clientPub }
}

/**
 * Authenticated message channel. Splits messages into fragments whose size fits
 * the underlying link, seals each fragment independently and reassembles them.
 */
export class Channel {
  constructor(link, { key, onMessage, onError, onClose, logger }) {
    this.link = link
    this.key = key
    this.logger = logger
    this.onMessage = onMessage
    this.onError = onError
    this.onClose = onClose
    this.closed = false
    this.nextMsgId = 1
    this.pending = new Map()
    this.overhead = 12 + 16
    const headerBytes = 7
    this.fragmentPayload = Math.max(256, link.maxPayload - this.overhead - headerBytes)
    link.onmessage = (bytes) => this.receive(bytes)
    link.onerror = (error) => this.onError?.(error)
    link.onclose = () => {
      if (this.closed) return
      this.closed = true
      this.onClose?.()
    }
  }

  headerFor(msgId, index, count) {
    const header = Buffer.allocUnsafe(7)
    header[0] = 1
    header.writeUInt16BE(index, 1)
    header.writeUInt16BE(count, 3)
    header.writeUInt16BE(msgId & 0xffff, 5)
    return header
  }

  seal(plain) {
    const nonce = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce)
    const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
    return Buffer.concat([nonce, body])
  }

  open(frame) {
    if (frame.length < 28) throw new Error('short frame')
    const nonce = frame.subarray(0, 12)
    const tag = frame.subarray(frame.length - 16)
    const body = frame.subarray(12, frame.length - 16)
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  }

  send(value) {
    if (this.closed) throw new Error('channel closed')
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    if (payload.length > MAX_MESSAGE) throw new Error('message too large')
    const count = Math.max(1, Math.ceil(payload.length / this.fragmentPayload))
    if (count > 65535) throw new Error('message needs too many fragments')
    const msgId = this.nextMsgId
    this.nextMsgId = (this.nextMsgId + 1) & 0xffff || 1
    for (let index = 0; index < count; index += 1) {
      const start = index * this.fragmentPayload
      const piece = payload.subarray(start, start + this.fragmentPayload)
      const header = this.headerFor(msgId, index, count)
      this.link.send(this.seal(Buffer.concat([header, piece])))
    }
  }

  receive(frame) {
    let plain
    try {
      plain = this.open(frame)
    } catch {
      this.onError?.(new Error('frame authentication failed'))
      return
    }
    if (plain.length < 7 || plain[0] !== 1) return
    const index = plain.readUInt16BE(1)
    const count = plain.readUInt16BE(3)
    const msgId = plain.readUInt16BE(5)
    const body = plain.subarray(7)
    if (count < 1 || index >= count) return
    let entry = this.pending.get(msgId)
    if (!entry) {
      entry = { count, pieces: new Array(count), received: 0, at: Date.now() }
      this.pending.set(msgId, entry)
    }
    if (entry.pieces[index] === undefined) {
      entry.pieces[index] = body
      entry.received += 1
    }
    if (entry.received < entry.count) return
    this.pending.delete(msgId)
    const full = Buffer.concat(entry.pieces)
    let value
    try {
      value = JSON.parse(full.toString('utf8'))
    } catch (error) {
      this.onError?.(error)
      return
    }
    this.onMessage?.(value)
  }

  disposeStale(maxAgeMs = 60000) {
    const now = Date.now()
    for (const [id, entry] of this.pending) {
      if (now - entry.at > maxAgeMs) this.pending.delete(id)
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.link.close?.()
  }
}
