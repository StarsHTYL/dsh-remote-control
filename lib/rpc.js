/**
 * Remote procedure surface exposed to paired clients.
 *
 * Every handler receives `(params, peer)` and returns a JSON-serializable value.
 * Handlers throw `RpcError` for anything the client should see as a typed error.
 */
import fs from 'node:fs/promises'
import fssync from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export class RpcError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

const READ_CHUNK = 64 * 1024

/** Resolve a client-supplied path inside one of the allowed roots. */
export function resolveInRoots(roots, input) {
  if (typeof input !== 'string' || input.length === 0) throw new RpcError('bad-path', 'path is required')
  const normalized = path.resolve(input)
  for (const root of roots) {
    const base = path.resolve(root)
    if (normalized === base) return { path: normalized, root: base }
    const prefix = base.endsWith(path.sep) ? base : base + path.sep
    if (normalized.startsWith(prefix)) return { path: normalized, root: base }
  }
  throw new RpcError('forbidden-path', `path is outside the allowed roots: ${input}`)
}

function toEntry(dirent, fullPath) {
  let stat = null
  try {
    stat = fssync.statSync(fullPath)
  } catch {}
  return {
    name: dirent.name,
    type: dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : 'other',
    size: stat?.size ?? 0,
    mtime: stat?.mtimeMs ?? 0,
  }
}

export function createRpcTable(options) {
  const { ctx, logger, roots, hostInfo, webrtcOrigin, webUrl } = options
  const watchers = new Set()
  const streams = new Map()

  const table = new Map()

  const define = (name, handler) => table.set(name, handler)

  define('sys.ping', async () => ({ time: Date.now() }))

  define('sys.info', async () => ({
    ...hostInfo(),
    roots: roots().map((entry) => ({ path: entry, label: path.basename(entry) })),
    capabilities: ['files', 'sessions', 'tunnel'],
    web: { origin: webrtcOrigin?.() ?? null, url: webUrl?.() ?? null },
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    node: process.versions.node,
  }))

  // ---- files -------------------------------------------------------------

  define('fs.roots', async () => roots().map((entry) => ({ path: entry, label: path.basename(entry) })))

  define('fs.list', async (params) => {
    const target = resolveInRoots(roots(), params?.path ?? roots()[0])
    const entries = await fs.readdir(target.path, { withFileTypes: true })
    const items = entries
      .filter((entry) => params?.all === true || !entry.name.startsWith('.'))
      .map((entry) => toEntry(entry, path.join(target.path, entry.name)))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    return { path: target.path, root: target.root, entries: items }
  })

  define('fs.stat', async (params) => {
    const target = resolveInRoots(roots(), params?.path)
    const stat = await fs.stat(target.path)
    return {
      path: target.path,
      type: stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other',
      size: stat.size,
      mtime: stat.mtimeMs,
      mode: stat.mode,
    }
  })

  define('fs.mkdir', async (params) => {
    const target = resolveInRoots(roots(), params?.path)
    await fs.mkdir(target.path, { recursive: true })
    return { path: target.path }
  })

  define('fs.remove', async (params) => {
    const target = resolveInRoots(roots(), params?.path)
    await fs.rm(target.path, { recursive: params?.recursive === true, force: false })
    return { path: target.path }
  })

  define('fs.rename', async (params) => {
    const from = resolveInRoots(roots(), params?.from)
    const to = resolveInRoots(roots(), params?.to)
    await fs.rename(from.path, to.path)
    return { path: to.path }
  })

  define('fs.read', async (params) => {
    const target = resolveInRoots(roots(), params?.path)
    const offset = Math.max(0, Number(params?.offset ?? 0) || 0)
    const length = Math.min(READ_CHUNK, Math.max(1, Number(params?.length ?? READ_CHUNK) || READ_CHUNK))
    const handle = await fs.open(target.path, 'r')
    try {
      const stat = await handle.stat()
      if (offset >= stat.size) return { path: target.path, offset, size: stat.size, eof: true, data: '' }
      const buffer = Buffer.allocUnsafe(Math.min(length, stat.size - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      const chunk = buffer.subarray(0, bytesRead)
      return {
        path: target.path,
        offset,
        size: stat.size,
        eof: offset + bytesRead >= stat.size,
        data: chunk.toString('base64'),
      }
    } finally {
      await handle.close()
    }
  })

  /** Append-only writes with an explicit offset give the client resumable uploads. */
  define('fs.write', async (params) => {
    const target = resolveInRoots(roots(), params?.path)
    const offset = Math.max(0, Number(params?.offset ?? 0) || 0)
    const data = Buffer.from(String(params?.data ?? ''), 'base64')
    await fs.mkdir(path.dirname(target.path), { recursive: true })
    let existing = 0
    try {
      existing = (await fs.stat(target.path)).size
    } catch {}
    if (offset === 0 && params?.truncate === true) existing = 0
    if (offset !== existing) {
      throw new RpcError('offset-mismatch', `expected offset ${existing}, received ${offset}`, { expected: existing })
    }
    const handle = await fs.open(target.path, offset === 0 && params?.truncate === true ? 'w' : 'a')
    try {
      await handle.write(data, 0, data.length, offset)
    } finally {
      await handle.close()
    }
    const size = (await fs.stat(target.path)).size
    return { path: target.path, size, offset: offset + data.length }
  })

  // ---- sessions ----------------------------------------------------------

  const controller = () => ctx.get('sessionController')

  define('session.list', async () => {
    const service = controller()
    if (!service) throw new RpcError('unavailable', 'session controller is not available in this profile')
    const signal = AbortSignal.timeout(8000)
    const value = await service.list({}, signal)
    return {
      items: (value?.items ?? []).map((item) => ({
        sessionId: item.sessionId,
        running: item.running === true,
        blank: item.blank === true,
        updatedAt: item.updatedAt ?? 0,
        cwd: item.cwd ?? '',
        title: item.projections?.values?.title ?? (item.cwd ? path.basename(item.cwd) : String(item.sessionId)),
      })),
    }
  })

  define('session.create', async (params) => {
    const service = controller()
    if (!service) throw new RpcError('unavailable', 'session controller is not available in this profile')
    const value = await service.create({
      cwd: typeof params?.cwd === 'string' ? resolveInRoots(roots(), params.cwd).path : undefined,
      agentPreset: typeof params?.agentPreset === 'string' ? params.agentPreset : undefined,
    })
    return { sessionId: value.sessionId }
  })

  define('session.prompt', async (params) => {
    const service = controller()
    if (!service) throw new RpcError('unavailable', 'session controller is not available in this profile')
    const text = String(params?.text ?? '')
    if (!text) throw new RpcError('bad-request', 'text is required')
    const value = await service.prompt(
      {
        requestId: `remote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: params.sessionId,
        mode: params.mode === 'steer' ? 'steer' : 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: params.timeZone,
      },
      AbortSignal.timeout(15000),
    )
    return { accepted: value?.accepted === true }
  })

  define('session.cancel', async (params) => {
    const service = controller()
    if (!service) throw new RpcError('unavailable', 'session controller is not available')
    const value = await service.cancel({ sessionId: params.sessionId })
    return { accepted: value?.accepted === true }
  })

  define('session.watch', async (params, peer) => {
    const service = controller()
    if (!service) throw new RpcError('unavailable', 'session controller is not available')
    const id = `w-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const abort = new AbortController()
    const watcher = { id, abort, sessionId: params.sessionId }
    watchers.add(watcher)
    peer.onClose(() => {
      watchers.delete(watcher)
      abort.abort()
    })
    const run = async () => {
      const iterator = service.follow(
        { address: { kind: 'session', sessionId: params.sessionId }, maxMessages: 40, assistantStream: true },
        abort.signal,
      )[Symbol.asyncIterator]()
      for (;;) {
        const { value, done } = await iterator.next()
        if (done) break
        peer.emit({ ev: 'session.frame', d: { watchId: id, frame: value } })
      }
    }
    run().catch((error) => {
      if (abort.signal.aborted) return
      peer.emit({ ev: 'session.error', d: { watchId: id, message: String(error?.message ?? error) } })
    })
    return { watchId: id }
  })

  define('session.unwatch', async (params) => {
    for (const watcher of watchers) {
      if (watcher.id !== params?.watchId) continue
      watcher.abort.abort()
      watchers.delete(watcher)
      return { closed: true }
    }
    return { closed: false }
  })

  // ---- raw TCP tunnel (lets a WebView drive the real Harness UI) ----------

  define('tunnel.open', async (params, peer) => {
    const origin = webrtcOrigin()
    if (!origin) throw new RpcError('unavailable', 'web origin is unavailable')
    const url = new URL(origin)
    const port = Number(params?.port ?? (url.port || 80))
    const host = String(params?.host ?? (url.hostname === '0.0.0.0' ? '127.0.0.1' : url.hostname))
    const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const socket = net.connect({ host, port })
    const stream = { id, socket }
    streams.set(id, stream)
    const finish = () => {
      streams.delete(id)
      peer.emit({ ev: 'tunnel.close', d: { streamId: id } })
    }
    socket.on('data', (chunk) => peer.emit({ ev: 'tunnel.data', d: { streamId: id, data: chunk.toString('base64') } }))
    socket.on('close', finish)
    socket.on('error', (error) => {
      peer.emit({ ev: 'tunnel.error', d: { streamId: id, message: String(error?.message ?? error) } })
      finish()
    })
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    peer.onClose(() => socket.destroy())
    logger?.debug?.(`tunnel opened to ${host}:${port}`)
    return { streamId: id, host, port }
  })

  define('tunnel.write', async (params) => {
    const stream = streams.get(params?.streamId)
    if (!stream) throw new RpcError('no-stream', 'unknown stream')
    const data = Buffer.from(String(params?.data ?? ''), 'base64')
    stream.socket.write(data)
    return { bytes: data.length }
  })

  define('tunnel.close', async (params) => {
    const stream = streams.get(params?.streamId)
    if (!stream) return { closed: false }
    streams.delete(params.streamId)
    stream.socket.destroy()
    return { closed: true }
  })

  /** Must be called when the server stops so no socket or iterator leaks. */
  function dispose() {
    for (const watcher of watchers) watcher.abort.abort()
    watchers.clear()
    for (const stream of streams.values()) stream.socket.destroy()
    streams.clear()
  }

  return { table, dispose, define }
}
