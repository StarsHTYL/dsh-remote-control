/**
 * Host half of dsh-remote-control.
 *
 * Starts a peer-to-peer remote access endpoint for this Harness: pairing offers,
 * UDP hole punching with a STUN-discovered endpoint, a TCP LAN path, and an
 * optional rendezvous relay fallback. Paired clients speak the RPC surface in
 * lib/rpc.js over an X25519 + AES-GCM channel.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RemoteServer } from './lib/server.js'

export const inject = ['tools', 'webServer']

const VERSION = '0.1.0'

function normalize(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const workingRoots = Array.isArray(raw.roots) ? raw.roots.filter((entry) => typeof entry === 'string' && entry) : []
  return {
    name: typeof raw.name === 'string' && raw.name ? raw.name : os.hostname(),
    bindHost: typeof raw.bindHost === 'string' && raw.bindHost ? raw.bindHost : '0.0.0.0',
    ipv6: raw.ipv6 !== false,
    tcpPort: Number.isInteger(raw.tcpPort) ? raw.tcpPort : 45871,
    udpPort: Number.isInteger(raw.udpPort) ? raw.udpPort : 45873,
    autoStart: raw.autoStart !== false,
    autoApprove: raw.autoApprove === true,
    roots: workingRoots,
    relay: {
      host: typeof raw.relay?.host === 'string' ? raw.relay.host : '',
      port: Number.isInteger(raw.relay?.port) ? raw.relay.port : 45880,
      token: typeof raw.relay?.token === 'string' ? raw.relay.token : '',
    },
    stunServers: Array.isArray(raw.stunServers) ? raw.stunServers.filter((entry) => typeof entry === 'string') : [],
    offerTtlMs: Number.isInteger(raw.offerTtlMs) && raw.offerTtlMs > 60000 ? raw.offerTtlMs : 30 * 60 * 1000,
    dataDir: typeof raw.dataDir === 'string' && raw.dataDir ? raw.dataDir : '',
  }
}

function resolveDataDir(settings) {
  if (settings.dataDir) return settings.dataDir
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'remote-control')
}

function resolveRoots(ctx, settings) {
  if (settings.roots.length) return settings.roots
  const candidates = []
  try {
    const working = ctx.get('workingDirectory')
    if (working?.defaultDirectory) candidates.push(working.defaultDirectory)
  } catch {}
  if (process.env.DSH_HOME) candidates.push(process.env.DSH_HOME)
  if (!candidates.length) candidates.push(process.cwd())
  return [...new Set(candidates)]
}

/** Roots a remote client may browse: configured, plus every live Session workspace. */
async function dynamicRoots(ctx, settings) {
  if (settings.roots.length) return settings.roots
  const found = new Set(resolveRoots(ctx, settings))
  try {
    const controller = ctx.get('sessionController')
    if (controller?.list) {
      const value = await controller.list({}, AbortSignal.timeout(4000))
      for (const item of value?.items ?? []) if (item.cwd) found.add(item.cwd)
    }
  } catch {}
  try {
    found.add(os.homedir())
  } catch {}
  return [...found]
}

function tool(name, description, parameters, handler) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    execute: async (args) => handler(args ?? {}),
  }
}

const EMPTY = { type: 'object', properties: {}, additionalProperties: false }

export function apply(ctx, config) {
  const settings = normalize(config)
  const logger = ctx.logger ?? { info: console.log, warn: console.warn, debug: () => {} }
  const dataDir = resolveDataDir(settings)
  const server = new RemoteServer({
    ctx,
    config: { ...settings, roots: resolveRoots(ctx, settings) },
    rootsProvider: () => dynamicRoots(ctx, settings),
    logger,
    dataDir,
    version: VERSION,
  })

  const disposers = []

  disposers.push(
    ctx.effect(() => {
      const registered = []

      registered.push(
        ctx.tools.register(
          tool(
            'remote_control_status',
            'Report the state of this machine\'s remote-access endpoint: listener state, pairing identity, NAT/STUN observations, relay fallback, and every connected remote client.',
            EMPTY,
            () => server.status(),
          ),
        ),
      )

      registered.push(
        ctx.tools.register(
          tool(
            'remote_control_start',
            'Start the peer-to-peer remote-access endpoint (TCP listener, UDP hole-punch socket, STUN endpoint discovery). Safe to call when already running.',
            EMPTY,
            async () => {
              await server.start()
              return server.status()
            },
          ),
        ),
      )

      registered.push(
        ctx.tools.register(
          tool(
            'remote_control_stop',
            'Stop the remote-access endpoint and disconnect every remote client.',
            EMPTY,
            async () => {
              await server.stop()
              return server.status()
            },
          ),
        ),
      )

      registered.push(
        ctx.tools.register(
          tool(
            'remote_control_pair',
            'Create a one-time pairing offer for a remote client (for example a phone app or another computer). Returns the offer code to scan or paste, plus the reachable paths. Start the endpoint first if it is stopped.',
            {
              type: 'object',
              properties: {
                refresh: { type: 'boolean', description: 'Re-probe STUN for a fresh public endpoint before building the offer. Default true.' },
              },
              additionalProperties: false,
            },
            async (args) => {
              const { code, offer } = await server.createOffer({ refresh: args.refresh !== false })
              return {
                code,
                hostId: server.status().hostId,
                hostName: settings.name,
                expiresAt: new Date(offer.exp).toISOString(),
                candidates: offer.cands,
                relay: offer.relay,
                webUrl: server.webUrl(),
                hint: 'Open the Remote Access panel in Settings to show this as a QR code, or paste the code into the client app.',
              }
            },
          ),
        ),
      )

      registered.push(
        ctx.tools.register(
          tool(
            'remote_control_devices',
            'List paired devices and their approval state, approve a pending device so it can use the tunnel, block it, or forget it entirely.',
            {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['list', 'approve', 'block', 'forget'], description: 'Default list.' },
                deviceId: { type: 'string', description: 'Target device id, required for approve/block/forget.' },
              },
              additionalProperties: false,
            },
            async (args) => {
              const action = args.action ?? 'list'
              if (action === 'list') {
                return {
                  pending: server.devices.pending().map((device) => device.id),
                  devices: server.devices.describe(),
                  connected: server.status().peers.map((peer) => ({ deviceId: peer.device?.id, approved: peer.approved })),
                }
              }
              if (!args.deviceId) throw new Error(`${action} needs deviceId`)
              if (action === 'approve') return server.approveDevice(args.deviceId)
              if (action === 'block') return server.blockDevice(args.deviceId)
              return server.forgetDevice(args.deviceId)
            },
          ),
        ),
      )

      registered.push(
        ctx.tools.register(
          tool(
            'remote_control_clients',
            'List remote clients currently connected over the remote-access tunnel, including their transport (tcp, udp, relay) and last activity.',
            EMPTY,
            () => ({ peers: server.status().peers }),
          ),
        ),
      )

      registered.push(
        ctx.tools.register(
          tool(
            'remote_control_disconnect',
            'Disconnect every remote client without invalidating the pairing secret, or revoke the secret so all existing pairings stop working and must be redone.',
            {
              type: 'object',
              properties: {
                revoke: { type: 'boolean', description: 'Also rotate the pairing secret (invalidates every existing pairing).' },
              },
              additionalProperties: false,
            },
            async (args) => {
              if (args.revoke === true) {
                await server.rotateSecret()
                return { revoked: true, ...server.status() }
              }
              server.disconnectAll()
              return { revoked: false, ...server.status() }
            },
          ),
        ),
      )

      return () => {
        for (const disposer of registered) {
          try {
            disposer()
          } catch {}
        }
      }
    }),
  )

  disposers.push(
    ctx.effect(() => {
      const webServer = ctx.get('webServer')
      if (!webServer?.register) return () => {}
      const dispose = webServer.register({
        kind: 'prefix',
        path: '/dsh-remote',
        handler: (req, res) => handleHttp(ctx, server, settings, req, res),
      })
      return () => dispose()
    }),
  )

  disposers.push(
    ctx.effect(() => {
      if (!settings.autoStart) return () => {}
      server.start().catch((error) => logger.warn?.(`remote control failed to start: ${error?.message ?? error}`))
      return () => {}
    }),
  )

  disposers.push(
    ctx.effect(() => () => {
      server.stop().catch(() => {})
    }),
  )

  return () => {
    for (const disposer of disposers) {
      try {
        disposer()
      } catch {}
    }
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req, limit = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/** Only the Harness itself (authenticated browser or loopback) may drive the endpoint. */
function authorized(ctx, req) {
  try {
    const connection = ctx.get('connection')
    if (!connection?.requestRejection) return true
    return connection.requestRejection({ headers: req.headers }) === undefined
  } catch {
    return false
  }
}

async function handleHttp(ctx, server, settings, req, res) {
  if (!authorized(ctx, req)) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = url.pathname.replace(/^\/dsh-remote/, '') || '/'

  try {
    if (req.method === 'GET' && route === '/status') {
      const paid = server.status()
      sendJson(res, 200, {
        version: VERSION,
        ...paid,
        settings: {
          name: settings.name,
          bindHost: settings.bindHost,
          tcpPort: settings.tcpPort,
          udpPort: settings.udpPort,
          autoStart: settings.autoStart,
          autoApprove: settings.autoApprove,
          relay: settings.relay.host ? settings.relay : null,
          roots: server.roots(),
        },
      })
      return
    }
    if (req.method === 'POST' && route === '/action') {
      const body = await readBody(req)
      const action = String(body.action ?? '')
      if (action === 'start') {
        await server.start()
        sendJson(res, 200, { ok: true, status: server.status() })
        return
      }
      if (action === 'stop') {
        await server.stop()
        sendJson(res, 200, { ok: true, status: server.status() })
        return
      }
      if (action === 'pair') {
        const { code, offer } = await server.createOffer({ refresh: body.refresh !== false })
        sendJson(res, 200, { ok: true, code, offer: { ...offer, psk: undefined }, status: server.status() })
        return
      }
      if (action === 'disconnect') {
        server.disconnectAll()
        sendJson(res, 200, { ok: true, status: server.status() })
        return
      }
      if (action === 'revoke') {
        await server.rotateSecret()
        sendJson(res, 200, { ok: true, status: server.status() })
        return
      }
      if (action === 'refresh-stun') {
        await server.refreshStun()
        sendJson(res, 200, { ok: true, status: server.status() })
        return
      }
      if (action === 'approve' || action === 'block' || action === 'forget') {
        const deviceId = String(body.deviceId ?? '')
        if (!deviceId) {
          sendJson(res, 400, { error: 'deviceId is required' })
          return
        }
        const result =
          action === 'approve'
            ? await server.approveDevice(deviceId)
            : action === 'block'
              ? await server.blockDevice(deviceId)
              : await server.forgetDevice(deviceId)
        sendJson(res, 200, { ok: result.ok !== false, result, status: server.status() })
        return
      }
      if (action === 'audit') {
        sendJson(res, 200, { ok: true, entries: server.audit.tail(Number(body.limit ?? 60)) })
        return
      }
      sendJson(res, 400, { error: `unknown action: ${action}` })
      return
    }
    if (req.method === 'GET' && route === '/data-dir') {
      sendJson(res, 200, { dataDir: await fs.realpath(server.dataDir).catch(() => server.dataDir) })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    sendJson(res, 500, { error: String(error?.message ?? error) })
  }
}
