/**
 * Access log: a bounded in-memory ring for the settings page plus a durable
 * JSONL file next to the plugin's identity (`access.log.jsonl`, rotated once at
 * 4 MiB). Entries are small, so the log answers "who did what when" without
 * turning into a second session store.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_BYTES = 4 * 1024 * 1024

export class AuditLog {
  constructor({ dataDir, logger, limit = 400 }) {
    this.file = path.join(dataDir, 'access.log.jsonl')
    this.logger = logger
    this.limit = limit
    this.entries = []
    this.queue = Promise.resolve()
    this.seq = 0
  }

  /** Fire-and-forget: never let logging break a request. */
  append(entry) {
    const record = {
      seq: ++this.seq,
      at: Date.now(),
      event: entry.event ?? 'rpc',
      deviceId: entry.deviceId ?? '',
      deviceName: entry.deviceName ?? '',
      method: entry.method ?? '',
      ok: entry.ok !== false,
      ms: entry.ms ?? 0,
      detail: String(entry.detail ?? '').slice(0, 160),
      code: entry.code ?? '',
      remote: entry.remote ?? '',
    }
    this.entries.push(record)
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
    this.queue = this.queue
      .then(() => this.write(record))
      .catch((error) => this.logger?.debug?.(`audit write failed: ${error.message}`))
    return record
  }

  async write(record) {
    try {
      const stat = await fs.stat(this.file).catch(() => null)
      if (stat && stat.size > MAX_BYTES) await fs.rename(this.file, `${this.file}.1`).catch(() => {})
      await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      this.logger?.debug?.(`audit append failed: ${error.message}`)
    }
  }

  tail(limit = 40) {
    const count = Math.max(1, Math.min(Number(limit) || 40, this.limit))
    return this.entries.slice(-count).reverse()
  }

  count() {
    return this.entries.length
  }
}
