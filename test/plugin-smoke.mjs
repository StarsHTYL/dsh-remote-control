/** Exercise the plugin entry point with a stand-in Cordis context. */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { apply } from '../index.js'

const tools = new Map()
let route = null
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshr-plugin-'))

const ctx = {
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
  get(name) {
    if (name === 'webServer') {
      return {
        getOrigin: () => 'http://127.0.0.1:22215',
        register: ({ path: routePath, handler }) => {
          route = { path: routePath, handler }
          return () => {
            route = null
          }
        },
      }
    }
    if (name === 'connection') return { requestRejection: () => undefined, authenticatedUrl: (url) => `${url}?token=test` }
    if (name === 'workingDirectory') return { defaultDirectory: path.join(dataDir, 'workspace') }
    if (name === 'sessionController') return null
    return undefined
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  effect(callback) {
    const disposer = callback()
    return disposer ?? (() => {})
  },
}

apply(ctx, { autoStart: false, tcpPort: 0, udpPort: 0, dataDir })

assert.deepEqual(
  [...tools.keys()].sort(),
  [
    'remote_control_clients',
    'remote_control_devices',
    'remote_control_disconnect',
    'remote_control_pair',
    'remote_control_start',
    'remote_control_status',
    'remote_control_stop',
  ],
  'every management tool is registered',
)
assert.equal(route?.path, '/dsh-remote', 'HTTP route registered')

const status = await tools.get('remote_control_start').execute({})
assert.equal(status.state, 'listening', 'start brings the endpoint up')
assert.ok(status.tcpPort > 0 && status.udpPort > 0, 'ephemeral ports are reported')

const paired = await tools.get('remote_control_pair').execute({ refresh: false })
assert.ok(paired.code.startsWith('dshr1.'), 'pairing code is produced')
assert.ok(paired.webUrl.includes('token=test'), 'tokenized web URL is offered')

// A tool result must carry a schema and a render function for the UI card.
for (const definition of tools.values()) {
  assert.equal(typeof definition.output.render, 'function')
  assert.ok(definition.parameters.type === 'object')
  assert.ok(definition.description.length > 20)
}

// Route handler: GET status, then an action, then an unknown action.
function fakeRes() {
  const state = { status: 0, body: '' }
  return {
    state,
    writeHead(status) {
      state.status = status
    },
    end(body) {
      state.body = body ?? ''
    },
  }
}

const getRes = fakeRes()
await route.handler({ method: 'GET', url: '/dsh-remote/status', headers: {} }, getRes)
assert.equal(getRes.state.status, 200, 'GET status')
const payload = JSON.parse(getRes.state.body)
assert.equal(payload.state, 'listening')
assert.ok(Array.isArray(payload.peers))

const postRes = fakeRes()
await route.handler(
  {
    method: 'POST',
    url: '/dsh-remote/action',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ action: 'disconnect' }))
    },
  },
  postRes,
)
assert.equal(postRes.state.status, 200, 'POST action')

const badRes = fakeRes()
await route.handler(
  {
    method: 'POST',
    url: '/dsh-remote/action',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ action: 'nope' }))
    },
  },
  badRes,
)
assert.equal(badRes.state.status, 400, 'unknown action is rejected')

const stopped = await tools.get('remote_control_stop').execute({})
assert.equal(stopped.state, 'idle', 'stop tears the endpoint down')

console.log('ok: plugin entry point')
process.exit(0)
