/**
 * Message-oriented link over a TCP socket.
 *
 * Wire format per message: `[u32 big-endian length][payload]`.
 * The link is intentionally dumb: ordering and reliability come from TCP,
 * confidentiality comes from the Channel layered on top.
 */
import net from 'node:net'
import { readUInt, writeUInt } from './util.js'

const MAX_MESSAGE = 8 * 1024 * 1024

/** Split an arbitrarily long byte stream into length-prefixed messages. */
function createSplitter(onMessage) {
  let pending = Buffer.alloc(0)
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= 4) {
      const length = readUInt(pending, 0, 4)
      if (length > MAX_MESSAGE) throw new Error(`frame too large: ${length}`)
      if (pending.length < 4 + length) return
      const body = pending.subarray(4, 4 + length)
      pending = pending.subarray(4 + length)
      onMessage(Buffer.from(body))
    }
  }
}

export class TcpLink {
  constructor(socket, meta) {
    this.kind = 'tcp'
    this.maxPayload = MAX_MESSAGE
    this.socket = socket
    this.meta = meta
    this.closed = false
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    const feed = createSplitter((body) => this.onmessage?.(body))
    socket.on('data', (chunk) => {
      try {
        feed(chunk)
      } catch (error) {
        this.onerror?.(error)
        this.close()
      }
    })
    socket.on('error', (error) => this.onerror?.(error))
    socket.on('close', () => {
      if (this.closed) return
      this.closed = true
      this.onclose?.()
    })
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 15000)
  }

  send(bytes) {
    if (this.closed) throw new Error('link closed')
    if (bytes.length > MAX_MESSAGE) throw new Error('message too large for link')
    const head = Buffer.allocUnsafe(4)
    writeUInt(head, 0, 4, bytes.length)
    this.socket.write(head)
    this.socket.write(bytes)
  }

  describe() {
    return { kind: this.kind, remote: this.meta?.remote, ...this.meta }
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.destroy()
    } catch {}
    this.onclose?.()
  }
}

/** Dial a TCP endpoint and resolve once the socket is writable. */
export function dialTcp({ host, port, timeoutMs = 4000, localAddress }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, localAddress })
    const meta = { remote: `${host}:${port}` }
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`tcp connect timeout ${host}:${port}`))
    }, timeoutMs)
    if (timer.unref) timer.unref()
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('error', onError)
    }
    const onError = (error) => {
      cleanup()
      socket.destroy()
      reject(error)
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      cleanup()
      resolve(new TcpLink(socket, meta))
    })
  })
}

export function createTcpServer({ host, port, onLink, ipv6Only = false }) {
  const server = net.createServer((socket) => {
    onLink(new TcpLink(socket, { remote: `${socket.remoteAddress}:${socket.remotePort}` }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    const options = ipv6Only ? { port, host, ipv6Only: true } : { port, host }
    server.listen(options, () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}
