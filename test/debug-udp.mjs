import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { connectToHost, RemoteClient } from '../lib/client.js'
import { RemoteServer, decodeOffer } from '../lib/server.js'
import { generateIdentity } from '../lib/channel.js'

const log = { info: (...a) => console.log('[srv]', ...a), warn: (...a) => console.log('[warn]', ...a), debug: (...a) => console.log('[dbg]', ...a) }
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-udp-'))
const server = new RemoteServer({
  ctx: { get: () => undefined },
  config: { name: 'debug', bindHost: '127.0.0.1', tcpPort: 0, udpPort: 0, roots: [dataDir], relay: { host: '', port: 0, token: '' }, stunServers: [], offerTtlMs: 600000, autoStart: false },
  logger: log,
  dataDir,
  version: 'debug',
})
await server.start()
const { code } = await server.createOffer({ refresh: false })
const offer = decodeOffer(code)
const udpOnly = { ...offer, cands: offer.cands.filter((c) => c.kind === 'udp') }
console.log('cands', JSON.stringify(udpOnly.cands))
const identity = generateIdentity()
try {
  const connection = await connectToHost({ offer: udpOnly, identity, onStatus: (e) => console.log('[cli]', JSON.stringify(e)) })
  console.log('connected via', connection.transport)
  const client = new RemoteClient({ channel: connection.channel, device: { name: 'debug-udp', os: 'x' } })
  console.log(JSON.stringify(await client.call('sys.info')))
  const big = Buffer.alloc(256 * 1024, 3)
  let offset = 0
  const target = path.join(dataDir, 'big.bin')
  const started = Date.now()
  while (offset < big.length) {
    const chunk = big.subarray(offset, offset + 32 * 1024)
    await client.call('fs.write', { path: target, offset, data: chunk.toString('base64'), truncate: offset === 0 }, 30000)
    offset += chunk.length
  }
  const stat = await client.call('fs.stat', { path: target })
  console.log('uploaded', stat.size, 'in', Date.now() - started, 'ms')
  client.close()
} catch (error) {
  console.error('FAILED', error)
}
await server.stop()
process.exit(0)
