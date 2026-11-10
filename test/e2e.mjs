/** End-to-end smoke test: TCP path, UDP punch path and relay path. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectToHost, RemoteClient } from '../lib/client.js'
import { RemoteServer, decodeOffer } from '../lib/server.js'
import { generateIdentity } from '../lib/channel.js'
import { sleep } from '../lib/util.js'

const quiet = { info: () => {}, warn: () => {}, debug: () => {}, error: console.error }

async function startRelay(port) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'relay', 'relay.js'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start')), 5000)
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('relay listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  })
  await ready
  return child
}

async function makeServer({ relayPort = 0, tag = 'test', bindHost = '127.0.0.1', autoApprove = true } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `dshr-${tag}-`))
  const server = new RemoteServer({
    ctx: { get: () => undefined },
    config: {
      name: `host-${tag}`,
      bindHost: bindHost,
      ipv6: true,
      autoApprove: autoApprove,
      tcpPort: 0,
      udpPort: 0,
      roots: [dataDir],
      relay: relayPort ? { host: '127.0.0.1', port: relayPort, token: '' } : { host: '', port: 0, token: '' },
      stunServers: [],
      offerTtlMs: 600000,
      autoStart: false,
    },
    logger: quiet,
    dataDir,
    version: 'test',
  })
  return { server, dataDir }
}

async function exercise(client, dataDir, label) {
  const info = await client.call('sys.info')
  assert.equal(info.hostId.length, 16, `${label}: hostId`)
  assert.ok(info.roots.length >= 1, `${label}: roots`)

  const written = await client.call('fs.write', { path: path.join(dataDir, 'a.txt'), offset: 0, data: Buffer.from('hello ').toString('base64'), truncate: true })
  assert.equal(written.size, 6, `${label}: write size`)
  const appended = await client.call('fs.write', { path: path.join(dataDir, 'a.txt'), offset: 6, data: Buffer.from('world').toString('base64') })
  assert.equal(appended.size, 11, `${label}: append size`)

  const listing = await client.call('fs.list', { path: dataDir })
  assert.ok(listing.entries.some((entry) => entry.name === 'a.txt'), `${label}: list`)

  const read = await client.call('fs.read', { path: path.join(dataDir, 'a.txt'), offset: 0 })
  assert.equal(Buffer.from(read.data, 'base64').toString(), 'hello world', `${label}: read`)

  const pong = await client.call('sys.ping')
  assert.ok(pong.time > 0, `${label}: ping`)

  let denied = false
  try {
    await client.call('fs.list', { path: path.join(os.tmpdir(), '..') })
  } catch (error) {
    denied = error.code === 'forbidden-path'
  }
  assert.ok(denied, `${label}: path escape must be refused`)
}

async function tcpPath() {
  const { server, dataDir } = await makeServer({ tag: 'tcp' })
  await server.start()
  const status = server.status()
  assert.equal(status.state, 'listening')
  const { code } = await server.createOffer({ refresh: false })
  const offer = decodeOffer(code)
  assert.ok(offer.cands.length >= 2, 'offer carries tcp+udp candidates')

  const identity = generateIdentity()
  const connection = await connectToHost({ offer, identity, onStatus: () => {} })
  assert.equal(connection.transport, 'tcp')
  const client = new RemoteClient({ channel: connection.channel, device: { name: 'test-tcp', os: 'test' } })
  await exercise(client, dataDir, 'tcp')
  assert.equal(server.status().peers.length, 1)
  client.close()
  await sleep(200)
  await server.stop()
  console.log('ok: tcp path')
}

async function udpPath() {
  const { server, dataDir } = await makeServer({ tag: 'udp' })
  await server.start()
  const { code } = await server.createOffer({ refresh: false })
  const offer = decodeOffer(code)
  const udpOnly = { ...offer, cands: (offer.cands ?? []).filter((entry) => entry.kind === 'udp') }
  const identity = generateIdentity()
  const connection = await connectToHost({ offer: udpOnly, identity, onStatus: () => {} })
  assert.equal(connection.transport, 'udp')
  const client = new RemoteClient({ channel: connection.channel, device: { name: 'test-udp', os: 'test' } })
  await exercise(client, dataDir, 'udp')

  // A 512 KiB transfer crosses many fragments and exercises reassembly.
  const payload = Buffer.alloc(512 * 1024, 7)
  const target = path.join(dataDir, 'big.bin')
  let offset = 0
  while (offset < payload.length) {
    const chunk = payload.subarray(offset, offset + 48 * 1024)
    await client.call('fs.write', { path: target, offset, data: chunk.toString('base64'), truncate: offset === 0 }, 30000)
    offset += chunk.length
  }
  const stat = await client.call('fs.stat', { path: target })
  assert.equal(stat.size, payload.length, 'udp: large upload size')
  client.close()
  await sleep(200)
  await server.stop()
  console.log('ok: udp punch path + 512 KiB upload')
}

async function v6Path() {
  const { server, dataDir } = await makeServer({ tag: 'v6', bindHost: '0.0.0.0' })
  await server.start()
  const status = server.status()
  if (!status.ipv6?.length) {
    console.log('skip: no global IPv6 address on this machine')
    await server.stop()
    return
  }
  const { code } = await server.createOffer({ refresh: false })
  const offer = decodeOffer(code)
  const v6Only = { ...offer, cands: (offer.cands ?? []).filter((entry) => entry.kind === 'tcp' && entry.label === 'v6') }
  assert.ok(v6Only.cands.length > 0, 'a v6 tcp candidate is advertised')
  const identity = generateIdentity()
  const connection = await connectToHost({ offer: v6Only, identity, onStatus: () => {} })
  assert.equal(connection.transport, 'tcp')
  const client = new RemoteClient({ channel: connection.channel, device: { name: 'test-v6', os: 'test' } })
  await exercise(client, dataDir, 'v6')
  client.close()
  await sleep(200)
  await server.stop()
  console.log('ok: ipv6 path')
}

async function approvalPath() {
  const { server, dataDir } = await makeServer({ tag: 'approval', autoApprove: false })
  await server.start()
  const { code } = await server.createOffer({ refresh: false })
  const offer = decodeOffer(code)
  const identity = generateIdentity()
  const connection = await connectToHost({ offer, identity, onStatus: () => {} })
  const client = new RemoteClient({ channel: connection.channel, device: { name: 'approval-test', os: 'win32' } })

  const info = await client.call('sys.info')
  assert.equal(info.approved, false, 'a fresh device is not approved')
  assert.equal(info.device?.status, 'pending')

  let deniedCode = null
  try {
    await client.call('fs.list', { path: dataDir })
  } catch (error) {
    deniedCode = error.code
  }
  assert.equal(deniedCode, 'device-pending', 'unapproved devices cannot read files')

  const pending = server.devices.pending()
  assert.equal(pending.length, 1, 'the device is listed as pending')

  await server.approveDevice(pending[0].id)
  const approved = await client.waitForApproval({ timeoutMs: 6000, intervalMs: 150 })
  assert.ok(approved, 'approval reaches the live peer')

  await exercise(client, dataDir, 'approved')

  const tail = server.audit.tail(50)
  assert.ok(tail.some((entry) => entry.method === 'fs.list' && entry.ok === false && entry.code === 'device-pending'), 'the denial is logged')
  assert.ok(tail.some((entry) => entry.event === 'approve'), 'the approval is logged')
  assert.ok(tail.some((entry) => entry.method === 'fs.write' && entry.ok === true), 'successful calls are logged')

  client.close()
  await sleep(200)

  // A blocked device is refused at the handshake, not just at the RPC layer.
  await server.blockDevice(pending[0].id)
  const second = await connectToHost({ offer, identity, onStatus: () => {} })
  const client2 = new RemoteClient({ channel: second.channel, device: { name: 'blocked-test', os: 'win32' } })
  await assert.rejects(client2.call('sys.info'), /connection closed|channel closed|timeout/i, 'a blocked device never gets a channel')
  client2.close()
  await server.stop()
  console.log('ok: device approval + audit trail')
}

async function relayPath() {  const relayPort = 45991
  const relay = await startRelay(relayPort)
  try {
    const { server, dataDir } = await makeServer({ relayPort, tag: 'relay' })
    await server.start()
    for (let i = 0; i < 40 && server.relayState !== 'waiting'; i += 1) await sleep(100)
    assert.equal(server.relayState, 'waiting', `relay should be waiting, saw ${server.relayState}`)

    const { code } = await server.createOffer({ refresh: false })
    const offer = decodeOffer(code)
    const relayOnly = { ...offer, cands: [] }
    const identity = generateIdentity()
    const connection = await connectToHost({ offer: relayOnly, identity, onStatus: () => {} })
    assert.equal(connection.transport, 'relay')
    const client = new RemoteClient({ channel: connection.channel, device: { name: 'test-relay', os: 'test' } })
    await exercise(client, dataDir, 'relay')
    client.close()
    await sleep(200)
    await server.stop()
    console.log('ok: relay path')
  } finally {
    relay.kill()
  }
}

await tcpPath()
await udpPath()
await v6Path()
await approvalPath()
await relayPath()
console.log('all transport paths passed')
