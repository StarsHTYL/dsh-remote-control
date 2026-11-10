/**
 * Paired device registry.
 *
 * Knowing the pairing code is no longer enough: every client key is recorded and
 * must be approved (once) before the tunnel answers anything beyond `sys.info`.
 * Records live in `devices.json` inside the plugin data directory.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { b64u } from './util.js'

export function deviceIdOf(publicKey) {
  return crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16)
}

export class DeviceStore {
  constructor({ dataDir, autoApprove = false, logger }) {
    this.file = path.join(dataDir, 'devices.json')
    this.autoApprove = autoApprove
    this.logger = logger
    this.devices = new Map()
    this.writing = null
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'))
      for (const device of raw?.devices ?? []) {
        if (device?.id) this.devices.set(device.id, device)
      }
    } catch {}
    return this.devices
  }

  list() {
    return [...this.devices.values()].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
  }

  get(id) {
    return this.devices.get(id)
  }

  pending() {
    return this.list().filter((device) => device.status === 'pending')
  }

  save() {
    // Serialize writes: approval clicks can arrive faster than the disk.
    this.writing = (this.writing ?? Promise.resolve()).then(async () => {
      const payload = { version: 1, devices: [...this.devices.values()] }
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.writeFile(this.file, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    })
    return this.writing.catch((error) => this.logger?.warn?.(`device store write failed: ${error.message}`))
  }

  /** Record a connection attempt and return the device's current record. */
  touch({ pub, name, os, remote }) {
    const id = deviceIdOf(pub)
    const now = Date.now()
    let device = this.devices.get(id)
    if (!device) {
      device = {
        id,
        pub: b64u(pub),
        name: String(name ?? 'unknown device').slice(0, 64),
        os: String(os ?? '').slice(0, 64),
        status: this.autoApprove ? 'approved' : 'pending',
        firstSeenAt: now,
        lastSeenAt: now,
        lastRemote: remote ?? '',
        connections: 0,
        approvedAt: this.autoApprove ? now : null,
      }
      this.devices.set(id, device)
    } else {
      if (name) device.name = String(name).slice(0, 64)
      if (os) device.os = String(os).slice(0, 64)
      device.lastSeenAt = now
      device.lastRemote = remote ?? device.lastRemote ?? ''
    }
    device.connections = (device.connections ?? 0) + 1
    // Persist in the background: the caller must stay synchronous so no frame is
    // dropped between the handshake and the channel taking over the link.
    this.save()
    return device
  }

  resync(id) {
    const device = this.devices.get(id)
    if (!device) return null
    device.status = 'approved'
    device.approvedAt = Date.now()
    device.lastSeenAt = Date.now()
    delete device.blockedAt
    this.save()
    return device
  }

  async remove(id) {
    const had = this.devices.delete(id)
    if (had) await this.save()
    return had
  }

  describe() {
    return this.list().map((device) => ({
      id: device.id,
      name: device.name,
      os: device.os,
      status: device.status,
      firstSeenAt: device.firstSeenAt,
      lastSeenAt: device.lastSeenAt,
      lastRemote: device.lastRemote ?? '',
      connections: device.connections ?? 0,
    }))
  }
}

/** Compact, human-sized detail for an audit row. */
export function summarizeParams(method, params) {
  if (!params || typeof params !== 'object') return ''
  if (typeof params.path === 'string') return params.path
  if (typeof params.text === 'string') return params.text.slice(0, 80)
  if (typeof params.sessionId === 'string') return params.sessionId
  if (typeof params.method === 'string') return params.method
  if (typeof params.provider === 'string' && typeof params.model === 'string') return `${params.provider}/${params.model}`
  return ''
}
