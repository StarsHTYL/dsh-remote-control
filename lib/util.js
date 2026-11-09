/** Small shared helpers: encoding, hashing, KDF and timing. */
import crypto from 'node:crypto'

export function randomBytes(n) {
  return crypto.randomBytes(n)
}

export function sha256(...parts) {
  const h = crypto.createHash('sha256')
  for (const part of parts) h.update(part)
  return h.digest()
}

export function hmac(key, ...parts) {
  const h = crypto.createHmac('sha256', key)
  for (const part of parts) h.update(part)
  return h.digest()
}

/** HKDF-SHA256; `ikm`/`salt` accept Buffers, `info` a string. */
export function hkdf(ikm, salt, info, length = 32) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), length))
}

export function safeEqual(a, b) {
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function b64u(buf) {
  return Buffer.from(buf).toString('base64url')
}

export function fromB64u(str) {
  return Buffer.from(String(str), 'base64url')
}

export function hex(buf) {
  return Buffer.from(buf).toString('hex')
}

export function utf8(str) {
  return Buffer.from(str, 'utf8')
}

/** Read a big-endian unsigned integer of `size` bytes. */
export function readUInt(buf, offset, size) {
  let value = 0
  for (let i = 0; i < size; i += 1) value = value * 256 + buf[offset + i]
  return value
}

export function writeUInt(buf, offset, size, value) {
  let rest = value
  for (let i = size - 1; i >= 0; i -= 1) {
    buf[offset + i] = rest % 256
    rest = Math.floor(rest / 256)
  }
}

/** Monotonic-ish wall clock in ms. */
export function now() {
  return Date.now()
}

export function shortId(bytes = 8) {
  return b64u(randomBytes(bytes)).slice(0, 11)
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** Run `fn` with a timeout; rejects with `code` when exceeded. */
export async function withTimeout(promise, ms, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message ?? 'timeout')), ms)
        if (timer.unref) timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
