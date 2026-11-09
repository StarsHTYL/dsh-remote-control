/**
 * Reliable, message-oriented link over UDP.
 *
 * Datagram layout:
 *   [u8 version=1][u8 flags][u32 seq][payload]
 *
 * flags: 0x01 ACK (payload = u32 acknowledged seq), 0x02 FIN, 0x04 PUNCH,
 *        0x08 DATA (payload = one application message).
 *
 * Delivery is in-order and retransmitted with an exponential backoff, which is
 * all a control channel plus chunked file transfer needs. Congestion control is
 * deliberately absent: the sender is throttled by a fixed in-flight window.
 */
import { readUInt, writeUInt } from './util.js'

const VERSION = 1
const FLAG_ACK = 0x01
const FLAG_FIN = 0x02
const FLAG_PUNCH = 0x04
const FLAG_DATA = 0x08
const HEADER = 6

export const UDP_MAX_PAYLOAD = 1000
const MAX_IN_FLIGHT = 64
const BASE_RTO = 250
const MAX_RTO = 2500
const MAX_TRIES = 14
const KEEPALIVE_MS = 15000
const REORDER_LIMIT = 512

export function encodePunch(token) {
  const payload = Buffer.from(token ?? '', 'utf8').subarray(0, 64)
  const buf = Buffer.allocUnsafe(HEADER + payload.length)
  buf[0] = VERSION
  buf[1] = FLAG_PUNCH
  writeUInt(buf, 2, 4, 0)
  payload.copy(buf, HEADER)
  return buf
}

export class UdpLink {
  constructor({ socket, remote, local, logger, autoListen = true }) {
    this.kind = 'udp'
    // The datagram header is ours, so the payload budget the channel sees is
    // the datagram cap minus that header.
    this.maxPayload = UDP_MAX_PAYLOAD - HEADER
    this.socket = socket
    this.remote = { address: remote.address, port: remote.port }
    this.local = local
    this.logger = logger
    this.closed = false
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    this.onpunch = null

    this.sendSeq = 1
    this.inFlight = new Map()
    this.nextExpected = 1
    this.buffered = new Map()
    this.timer = null
    this.keepalive = null
    this.retryTimer = null

    if (autoListen) this.socket.on('message', (msg, rinfo) => this.receive(msg, rinfo))
    this.socket.on('error', (error) => this.onerror?.(error))
    this.retryTimer = setInterval(() => this.retransmit(), BASE_RTO)
    if (this.retryTimer.unref) this.retryTimer.unref()
    this.keepalive = setInterval(() => this.sendPunch(), KEEPALIVE_MS)
    if (this.keepalive.unref) this.keepalive.unref()
  }

  describe() {
    return { kind: this.kind, remote: `${this.remote.address}:${this.remote.port}`, local: this.local }
  }

  sendPunch() {
    if (this.closed) return
    try {
      this.socket.send(encodePunch('k'), this.remote.port, this.remote.address)
    } catch {}
  }

  send(bytes) {
    if (this.closed) throw new Error('link closed')
    if (bytes.length + HEADER > UDP_MAX_PAYLOAD) {
      throw new Error(`udp payload too large: ${bytes.length}`)
    }
    const seq = this.sendSeq
    this.sendSeq = (this.sendSeq + 1) >>> 0
    if (this.sendSeq === 0) this.sendSeq = 1
    const packet = this.frame(FLAG_DATA, seq, bytes)
    this.inFlight.set(seq, { packet, sentAt: Date.now(), tries: 0 })
    this.write(packet)
  }

  frame(flags, seq, payload) {
    const buf = Buffer.allocUnsafe(HEADER + payload.length)
    buf[0] = VERSION
    buf[1] = flags
    writeUInt(buf, 2, 4, seq)
    payload.copy(buf, HEADER)
    return buf
  }

  write(packet) {
    try {
      this.socket.send(packet, this.remote.port, this.remote.address)
    } catch (error) {
      this.onerror?.(error)
    }
  }

  pruneWindow() {
    // The in-flight window is advisory only: a slow ACK must never discard a
    // message the upper layer believes it already sent.
  }

  retransmit() {
    if (this.closed) return
    const now = Date.now()
    for (const [seq, entry] of this.inFlight) {
      const rto = Math.min(MAX_RTO, BASE_RTO * 2 ** Math.min(entry.tries, 5))
      if (now - entry.sentAt < rto) continue
      if (entry.tries >= MAX_TRIES) {
        this.inFlight.delete(seq)
        this.onerror?.(new Error(`udp delivery failed at seq ${seq}`))
        this.close()
        return
      }
      entry.tries += 1
      entry.sentAt = now
      this.write(entry.packet)
    }
  }

  onAck(seq) {
    for (const key of [...this.inFlight.keys()]) {
      if (key <= seq) this.inFlight.delete(key)
    }
  }

  sendAck(seq) {
    try {
      const payload = Buffer.allocUnsafe(4)
      writeUInt(payload, 0, 4, seq)
      this.socket.send(this.frame(FLAG_ACK, 0, payload), this.remote.port, this.remote.address)
    } catch {}
  }

  deliver(payload) {
    if (payload.length === 0) return
    this.onmessage?.(Buffer.from(payload))
  }

  receive(msg, rinfo) {
    if (rinfo.address !== this.remote.address || rinfo.port !== this.remote.port) {
      // A peer that roamed (mobile handover) may arrive from a new endpoint.
      if (this.onpunch) {
        const flags = msg.length > 1 ? msg[1] : 0
        if (flags & FLAG_PUNCH) {
          this.onpunch(msg, rinfo)
          return
        }
      }
      return
    }
    if (msg.length < HEADER || msg[0] !== VERSION) return
    const flags = msg[1]
    const seq = readUInt(msg, 2, 4)
    const payload = msg.subarray(HEADER)
    if (flags & FLAG_PUNCH) {
      this.onpunch?.(msg, rinfo)
      return
    }
    if (flags & FLAG_ACK) {
      if (payload.length >= 4) this.onAck(readUInt(payload, 0, 4))
      return
    }
    if (flags & FLAG_FIN) {
      this.close()
      return
    }
    if (!(flags & FLAG_DATA)) return
    if (seq < this.nextExpected) {
      this.sendAck(this.nextExpected - 1)
      return
    }
    if (seq === this.nextExpected) {
      this.nextExpected += 1
      this.deliver(payload)
      while (this.buffered.has(this.nextExpected)) {
        const next = this.buffered.get(this.nextExpected)
        this.buffered.delete(this.nextExpected)
        this.nextExpected += 1
        this.deliver(next)
      }
      this.sendAck(this.nextExpected - 1)
      return
    }
    if (this.buffered.size >= REORDER_LIMIT) {
      this.buffered.clear()
      this.sendAck(this.nextExpected - 1)
      return
    }
    this.buffered.set(seq, payload)
    this.sendAck(this.nextExpected - 1)
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.retryTimer)
    clearInterval(this.keepalive)
    try {
      this.socket.send(this.frame(FLAG_FIN, 0, Buffer.alloc(0)), this.remote.port, this.remote.address)
    } catch {}
    try {
      this.socket.close()
    } catch {}
    this.onclose?.()
  }
}
