#!/usr/bin/env node
/**
 * Reference client for dsh-remote-control.
 *
 * Pair once with the code the Harness shows, then drive the host from any OS:
 *
 *   node tools/remote-client.mjs --pair "dshr1...." info
 *   node tools/remote-client.mjs --pair "dshr1...." sessions
 *   node tools/remote-client.mjs --pair "dshr1...." ls C:\work
 *   node tools/remote-client.mjs --pair "dshr1...." get /remote/file.txt ./file.txt
 *   node tools/remote-client.mjs --pair "dshr1...." put ./photo.jpg /remote/photo.jpg
 *   node tools/remote-client.mjs --pair "dshr1...." prompt <sessionId> "run the tests"
 *
 * It is also the executable specification the HarmonyOS client mirrors; see
 * docs/PROTOCOL.md.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { connectToHost, RemoteClient, parseOffer } from '../lib/client.js'
import { generateIdentity } from '../lib/channel.js'

function usage() {
  console.error(`usage: remote-client.mjs --pair <code> <command> [args]

commands:
  info                          host information and allowed roots
  status                        live endpoint status
  sessions                      list sessions
  prompt <sessionId> <text>     queue a prompt into a session
  cancel <sessionId>            cancel the running turn
  ls <path>                     list a directory
  get <remotePath> <localPath>  download a file
  put <localPath> <remotePath>  upload a file
  mkdir <path>                  create a directory
  rm <path>                     delete a file or directory
`)
}

function parseArgs(argv) {
  const args = { pair: process.env.DSH_REMOTE_PAIR ?? '', command: '', rest: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--pair') {
      args.pair = argv[i + 1] ?? ''
      i += 1
    } else if (key === '--verbose') {
      args.verbose = true
    } else if (!args.command) {
      args.command = key
    } else {
      args.rest.push(key)
    }
  }
  return args
}

async function download(client, remotePath, localPath) {
  const handle = await fs.open(localPath, 'w')
  let offset = 0
  let size = 0
  try {
    for (;;) {
      const chunk = await client.call('fs.read', { path: remotePath, offset, length: 256 * 1024 }, 60000)
      size = chunk.size
      if (chunk.eof && !chunk.data) break
      const data = Buffer.from(chunk.data, 'base64')
      await handle.write(data, 0, data.length, offset)
      offset += data.length
      if (chunk.eof) break
    }
  } finally {
    await handle.close()
  }
  return { size, path: localPath }
}

async function upload(client, localPath, remotePath) {
  const data = await fs.readFile(localPath)
  let offset = 0
  const started = Date.now()
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + 128 * 1024)
    await client.call(
      'fs.write',
      { path: remotePath, offset, data: chunk.toString('base64'), truncate: offset === 0 },
      60000,
    )
    offset += chunk.length
    if (process.stdout.isTTY) process.stdout.write(`\r${Math.round((offset / data.length) * 100)}%`)
  }
  if (process.stdout.isTTY) process.stdout.write('\n')
  return { size: offset, ms: Date.now() - started }
}

const args = parseArgs(process.argv.slice(2))
if (!args.command || !args.pair) {
  usage()
  process.exit(2)
}

const offer = parseOffer(args.pair)
const identity = generateIdentity()
const onStatus = (event) => {
  if (args.verbose) console.error(`[${event.phase}] ${event.remote ?? ''} ${event.error ?? ''}`)
}

let connection
try {
  connection = await connectToHost({
    offer,
    identity,
    device: { name: `${process.platform}-cli`, os: `${process.platform}/${process.arch}` },
    onStatus,
  })
} catch (error) {
  console.error(`connection failed: ${error.message}`)
  process.exit(1)
}
if (args.verbose) console.error(`connected via ${connection.transport} (${connection.remote})`)

const client = new RemoteClient({ channel: connection.channel, device: { name: 'dsh-remote-cli', os: process.platform } })
const [first, second] = args.rest

try {
  switch (args.command) {
    case 'info':
      console.log(JSON.stringify(await client.call('sys.info'), null, 2))
      break
    case 'status':
      console.log(JSON.stringify(await client.call('sys.info'), null, 2))
      break
    case 'sessions': {
      const { items } = await client.call('session.list')
      for (const item of items) {
        console.log(`${item.sessionId}\t${item.running ? 'running' : 'idle'}\t${item.title}\t${item.cwd}`)
      }
      break
    }
    case 'prompt': {
      if (!first || !second) throw new Error('prompt needs <sessionId> <text>')
      console.log(JSON.stringify(await client.call('session.prompt', { sessionId: first, text: second }), null, 2))
      break
    }
    case 'cancel': {
      if (!first) throw new Error('cancel needs <sessionId>')
      console.log(JSON.stringify(await client.call('session.cancel', { sessionId: first }), null, 2))
      break
    }
    case 'ls': {
      const listing = await client.call('fs.list', { path: first ?? '' })
      console.log(`${listing.path}`)
      for (const entry of listing.entries) {
        console.log(`${entry.type === 'dir' ? 'd' : '-'}\t${String(entry.size).padStart(12)}\t${entry.name}`)
      }
      break
    }
    case 'get': {
      if (!first || !second) throw new Error('get needs <remotePath> <localPath>')
      console.log(JSON.stringify(await download(client, first, path.resolve(second)), null, 2))
      break
    }
    case 'put': {
      if (!first || !second) throw new Error('put needs <localPath> <remotePath>')
      console.log(JSON.stringify(await upload(client, path.resolve(first), second), null, 2))
      break
    }
    case 'mkdir':
      console.log(JSON.stringify(await client.call('fs.mkdir', { path: first }), null, 2))
      break
    case 'rm':
      console.log(JSON.stringify(await client.call('fs.remove', { path: first, recursive: true }), null, 2))
      break
    default:
      usage()
      process.exitCode = 2
  }
} catch (error) {
  console.error(`error${error.code ? ` [${error.code}]` : ''}: ${error.message}`)
  process.exitCode = 1
} finally {
  client.close()
}
