#!/usr/bin/env node
/**
 * Standalone rendezvous relay for dsh-remote-control.
 *
 * Run it on any host both sides can reach (a VPS, a NAS, a home server):
 *
 *   node relay/relay.js --port 45880 [--token <shared token>]
 *
 * It matches one host and one guest in the same room and then becomes a dumb
 * byte pipe. It never sees plaintext: the tunnel is end-to-end encrypted with
 * the pairing secret, so the relay only forwards ciphertext.
 */
import net from 'node:net'

function parseArgs(argv) {
  const args = { port: 45880, token: '', host: '0.0.0.0', idleMs: 120000 }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--port') {
      args.port = Number(value)
      i += 1
    } else if (key === '--token') {
      args.token = String(value)
      i += 1
    } else if (key === '--host') {
      args.host = String(value)
      i += 1
    } else if (key === '--verbose') {
      args.verbose = true
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const rooms = new Map()

function log(...parts) {
  console.log(new Date().toISOString(), ...parts)
}

function send(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`)
}

function pair(host, guest) {
  send(host.socket, { t: 'paired' })
  send(guest.socket, { t: 'paired' })
  const connect = (from, to) => {
    from.socket.pipe(to.socket)
    from.socket.on('close', () => {
      try {
        to.socket.destroy()
      } catch {}
    })
    from.socket.on('error', () => {})
  }
  connect(host, guest)
  connect(guest, host)
}

const server = net.createServer((socket) => {
  socket.setNoDelay(true)
  let buffered = ''
  let joined = null
  const timer = setTimeout(() => {
    if (!joined) socket.destroy()
  }, 20000)
  if (timer.unref) timer.unref()

  const onData = (chunk) => {
    buffered += chunk.toString('utf8')
    const index = buffered.indexOf('\n')
    if (index < 0) {
      if (buffered.length > 8192) socket.destroy()
      return
    }
    const line = buffered.slice(0, index)
    buffered = buffered.slice(index + 1)
    socket.removeListener('data', onData)
    clearTimeout(timer)
    let join
    try {
      join = JSON.parse(line)
    } catch {
      send(socket, { t: 'error', message: 'malformed join' })
      socket.destroy()
      return
    }
    if (join.t !== 'join') {
      send(socket, { t: 'error', message: 'expected join' })
      socket.destroy()
      return
    }
    if (args.token && join.token !== args.token) {
      send(socket, { t: 'error', message: 'bad token' })
      socket.destroy()
      return
    }
    const room = String(join.room ?? '')
    const role = join.role === 'host' ? 'host' : 'guest'
    if (!room) {
      send(socket, { t: 'error', message: 'missing room' })
      socket.destroy()
      return
    }
    const entry = rooms.get(room) ?? {}
    if (entry[role]) {
      send(socket, { t: 'error', message: `${role} already waiting in room` })
      socket.destroy()
      return
    }
    entry[role] = { socket, at: Date.now() }
    rooms.set(room, entry)
    joined = { room, role }
    send(socket, { t: 'ok', room, role })
    log(`join room=${room} role=${role} from ${socket.remoteAddress}`)
    if (entry.host && entry.guest) {
      rooms.delete(room)
      pair(entry.host, entry.guest)
      log(`paired room=${room}`)
    }
    socket.on('close', () => {
      const current = rooms.get(room)
      if (current && current[role]?.socket === socket) {
        delete current[role]
        if (!current.host && !current.guest) rooms.delete(room)
      }
    })
  }
  socket.on('data', onData)
  socket.on('error', () => {})
})

server.listen(args.port, args.host, () => {
  log(`relay listening on ${args.host}:${args.port}${args.token ? ' (token required)' : ''}`)
})
