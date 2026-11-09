import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { connectToHost, RemoteClient } from '../lib/client.js'
import { RemoteServer, decodeOffer } from '../lib/server.js'
import { generateIdentity } from '../lib/channel.js'

const log = { info: (...a) => console.log('[srv]', ...a), warn: (...a) => console.log('[warn]', ...a), debug: () => {} }
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-debug-'))
const server = new RemoteServer({
  ctx: { get: () => undefined },
  config: { name: 'debug', bindHost: '127.0.0.1', tcpPort: 0, udpPort: 0, roots: [dataDir], relay: { host: '', port: 0, token: '' }, stunServers: [], offerTtlMs: 600000, autoStart: false },
  logger: log,
  dataDir,
  version: 'debug',
})
await server.start()
console.log('status', JSON.stringify(server.status(), null, 2).slice(0, 800))
const { code } = await server.createOffer({ refresh: false })
const offer = decodeOffer(code)
console.log('cands', JSON.stringify(offer.cands))
const identity = generateIdentity()
try {
  const connection = await connectToHost({ offer, identity, onStatus: (e) => console.log('[cli]', JSON.stringify(e)) })
  console.log('connected via', connection.transport)
  const client = new RemoteClient({ channel: connection.channel, device: { name: 'debug', os: 'x' } })
  console.log(await client.call('sys.info'))
} catch (error) {
  console.error('FAILED', error)
}
await server.stop()
