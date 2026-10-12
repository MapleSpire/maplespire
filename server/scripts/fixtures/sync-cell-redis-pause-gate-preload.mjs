// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Olivier Albertini
//
// This file is part of MapleSpire.
// MapleSpire is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// MapleSpire is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

// Child-process fixture for the REAL gate entry point. All child-process calls
// are replaced before its imports; no unknown command falls through to Docker.
// HTTP, Engine HTTP framing and WebSocket handshakes use real loopback sockets.
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { writeFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'

const argument = name => process.argv[process.argv.indexOf(name) + 1]
const mode = argument('--qa-fixture-mode')
const reportPath = argument('--qa-fixture-report')
assert.ok(['healthy', 'clock-step', 'witness-refused', 'witness-uncertain', 'witness-marker-error',
  'witness-identity-error', 'witness-close-held'].includes(mode))
assert.ok(reportPath && reportPath !== process.argv[0])
const commands = [], requests = [], servers = [], sockets = new Set()
const peers = new Set()
const redisId = 'c'.repeat(64)
const redisIp = '127.0.0.77'
const witnessEnabled = mode.startsWith('witness-')
const events = []
const event = (kind, fields = {}) => events.push({ ordinal: events.length + 1, kind, ...fields })
const cellIds = ['a'.repeat(64), 'b'.repeat(64)]
const originalNow = Date.now
const originalRequest = http.request
const originalConnect = net.createConnection
const originalChildren = Object.fromEntries(['execFile', 'execFileSync', 'spawnSync', 'spawn', 'exec'].map(name => [name, childProcess[name]]))
const origin = originalNow(), monotonicOrigin = performance.now()
const cleanNow = () => origin + Math.floor(performance.now() - monotonicOrigin)
let observationBeganAt = null, paused = false, closing = false, markerThrew = false, sealSeen = false
let redisConnections = 0, redisRequests = 0, pendingReply = null, pauseReply = null
// The positive arm has a deterministic wall/mono relation. The negative arm
// changes that relation during its baseline, without changing its origin.
Date.now = () => {
  if (witnessEnabled && paused) {
    const stack = new Error().stack
    if (!sealSeen && stack.includes('sealBeforeUnpause')) { sealSeen = true; event('seal-clock') }
    if (mode === 'witness-marker-error' && !markerThrew && stack.includes('Object.unpauseStarted')) {
      markerThrew = true
      event('unpause-marker-throws')
      throw new Error('qa-unpause-marker-clock-failed')
    }
  }
  return cleanNow() + (mode === 'clock-step' && observationBeganAt !== null && cleanNow() - observationBeganAt >= 500 ? 10 : 0)
}
const generatedAt = () => new Date(cleanNow()).toISOString()
const reply = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
async function serve(handler) {
  const server = http.createServer(handler)
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return server
}
// A real RESP endpoint on a dedicated loopback address, with no DNS, port
// translation, Redis process or Docker. A collision fails instead of reusing
// an existing listener. Tests in the parent file execute sequentially.
if (witnessEnabled) {
  const redis = net.createServer(socket => {
    redisConnections++
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket); event('redis-server-close') })
    socket.on('error', () => undefined)
    let buffered = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk])
      assert.ok(buffered.length <= 256, 'fixture accepts only one bounded PING nonce')
      const header = /^\*2\r\n\$4\r\nPING\r\n\$(\d+)\r\n/.exec(buffered.toString('ascii'))
      if (!header) { assert.ok(buffered.length < 24, 'unexpected RESP command'); return }
      const length = Number(header[1]), end = header[0].length + length + 2
      if (buffered.length < end) return
      assert.equal(buffered.length, end, 'only one request may be in flight')
      const nonce = buffered.subarray(header[0].length, end - 2).toString('ascii')
      assert.match(nonce, /^g1b3:[a-f0-9]{32}:\d{4}$/)
      assert.equal(buffered.subarray(end - 2).toString(), '\r\n')
      buffered = Buffer.alloc(0)
      redisRequests++
      event('redis-request', { request: redisRequests })
      const echoed = mode === 'witness-refused' ? nonce.replace(/^g/, 'x') : nonce
      const send = () => {
        event('redis-reply', { request: redisRequests, afterUnpause: !paused && sealSeen })
        socket.write(`$${echoed.length}\r\n${echoed}\r\n`)
      }
      if (paused && mode !== 'witness-marker-error') {
        assert.equal(pendingReply, null)
        pendingReply = send
        // The pause response is deliberately held until a real request is in
        // flight. Cleanup must exclude this echo when it resumes the endpoint.
        if (pauseReply) { const finish = pauseReply; pauseReply = null; finish() }
      } else send()
    })
  })
  await new Promise((resolve, reject) => {
    redis.once('error', reject)
    // An ephemeral port, not 6379: anything already listening on 6379 (a CI
    // Redis service on 0.0.0.0, a parallel test) would make this bind fail.
    // The gate still has to ask for redisIp:6379; the connect hook below
    // asserts that and then routes the socket here.
    redis.listen({ host: redisIp, port: 0, exclusive: true }, resolve)
  })
  servers.push(redis)
  const redisPort = redis.address().port
  net.createConnection = (options, ...args) => {
    // Some Node releases use this export for HTTP agent sockets too. Keep
    // those real connections to this fixture's bound HTTP/WS listeners; only
    // the Redis witness socket receives the delayed-close instrumentation.
    if (options?.host === '127.0.0.1' && servers.some(server => {
      const address = server.address()
      return address?.address === '127.0.0.1' && String(address.port) === String(options.port)
    })) return originalConnect(options, ...args)
    assert.deepEqual(options, { host: redisIp, port: 6379, family: 4 }, 'witness must use the verified endpoint')
    const socket = originalConnect({ ...options, port: redisPort }, ...args)
    // The witness checks the peer is the endpoint it asked for; report that
    // port, since the fixture listens elsewhere. The peer check itself is
    // covered by sync-cell-redis-pause-witness.test.mjs.
    Object.defineProperty(socket, 'remotePort', { get: () => options.port })
    const emit = socket.emit
    socket.emit = function (name, ...args) {
      if (name === 'close') {
        const release = () => { event('witness-close-delivered'); emit.call(this, name, ...args) }
        if (mode === 'witness-close-held') { event('witness-close-held'); setTimeout(release, 60); return true }
        event('witness-close-delivered')
      }
      return emit.call(this, name, ...args)
    }
    return socket
  }
}
const cellServers = []
for (let index = 0; index < 2; index += 1) {
  cellServers.push(await serve((request, response) => {
    requests.push({ source: `cell-${index}`, path: request.url })
    if (request.url === '/api/health') return reply(response, 200, { status: 'ok' })
    if (request.url === '/api/auth/dev-login') {
      response.setHeader('set-cookie', 'maplespire_session=qa-synthetic; HttpOnly')
      return reply(response, 200, { user: { id: 'qa-user', isPlatformAdmin: true }, orgId: 'qa-org' })
    }
    if (request.url.startsWith('/api/platform/audit?')) return reply(response, 200, { entries: [{ targetId: 'qa-user' }] })
    if (request.url === '/api/landscapes') return reply(response, 200, { landscapes: [{ id: 'qa-land', defaultVersionId: 'qa-version' }] })
    if (request.url === '/api/ready') return reply(response, paused ? 503 : 200, { checks: { redis: !paused } })
    if (request.url === '/api/platform/sync-cell') return reply(response, 200, {
      generatedAt: generatedAt(), partitionIndex: index === 0 && !paused ? 0 : null, ready: index === 0 && !paused,
      partitionReady: index === 0 && !paused, partitionLossCount: index === 0 && paused ? 1 : 0,
    })
    reply(response, 404, { error: 'unexpected fixture route' })
  }))
}
const router = await serve((request, response) => {
  requests.push({ source: 'router', path: request.url })
  if (request.url.startsWith('/api/automerge/root?')) return reply(response, 200, {})
  if (request.url === '/api/ready') return reply(response, 200, { checks: { redis: true } })
  reply(response, 404, {})
})
const ws = new WebSocketServer({ noServer: true })
router.on('upgrade', (request, socket, head) => {
  requests.push({ source: 'websocket', authenticated: Boolean(request.headers.cookie) })
  if (!request.headers.cookie) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  if (paused) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  ws.handleUpgrade(request, socket, head, peer => {
    peers.add(peer)
    peer.once('close', () => peers.delete(peer))
    ws.emit('connection', peer, request)
  })
})
const engine = await serve((request, response) => {
  commands.push({ transport: 'engine', method: request.method, path: request.url })
  if (request.method === 'GET' && request.url.endsWith('/json')) {
    const final = request.url === `/v1.40/containers/${redisId}/json`
    event(final ? 'identity-final' : 'identity-initial')
    if (final && mode === 'witness-identity-error') return reply(response, 500, { error: 'qa-final-identity-unavailable' })
    return reply(response, 200, {
      Id: redisId, Name: '/qa-gate-local-redis-1', Image: `sha256:${'d'.repeat(64)}`, RestartCount: 0,
      State: { Running: true, Paused: paused, StartedAt: '2026-09-06T00:00:00.000Z' },
      Config: { Env: ['QA_SENTINEL=synthetic-do-not-publish'], Labels: {
        'com.docker.compose.project': 'qa-gate-local', 'com.docker.compose.service': 'redis',
      } },
      NetworkSettings: { Networks: { 'qa-gate-network': { NetworkID: 'e'.repeat(64), IPAddress: redisIp } } },
    })
  }
  if (request.method === 'GET' && request.url === '/v1.40/info') {
    observationBeganAt ??= cleanNow()
    return reply(response, 200, { SystemTime: generatedAt(), ServerVersion: '29.7.2' })
  }
  if (request.method === 'POST' && request.url === `/v1.40/containers/${redisId}/pause`) {
    paused = true
    event('pause-post')
    if (mode === 'witness-marker-error') {
      for (const peer of peers) peer.close(1012, 'qa-outage')
      response.writeHead(204); response.end(); return
    }
    // Stop at acquisition, so the control needs no invented outage behavior.
    // The true gate must still release this uncertain acquired pause in finally.
    const finish = () => reply(response, 500, { error: 'qa-stop-after-pause-acquisition' })
    if (witnessEnabled && redisConnections > 0) { pauseReply = finish; return }
    return finish()
  }
  if (request.method === 'POST' && request.url === `/v1.40/containers/${redisId}/unpause`) {
    paused = false
    event('unpause-post')
    if (pendingReply) { const send = pendingReply; pendingReply = null; send() }
    // Let the real client data handler observe the late echo before stop.
    setTimeout(() => { response.writeHead(204); response.end() }, witnessEnabled ? 20 : 0)
    return
  }
  reply(response, 500, { error: 'unexpected Engine fixture call' })
})
http.request = (options, callback) => {
  if (options.socketPath === undefined) {
    assert.equal(Number(options.port), router.address().port, 'only the fixture router may receive a WebSocket handshake')
    assert.equal(options.hostname ?? options.host, '127.0.0.1')
    return originalRequest(options, callback)
  }
  assert.equal(options.socketPath, '/qa-no-docker.sock')
  return originalRequest({ ...options, socketPath: undefined, hostname: '127.0.0.1', port: engine.address().port }, callback)
}
function dockerResult(file, args) {
  commands.push({ transport: 'cli', file, args })
  assert.equal(file, 'docker', 'no real subprocess is permitted')
  if (args[0] === 'inspect' && args[2] === '{{.State.Paused}}') return String(paused)
  if (args[0] === 'inspect' && args[2] === '{{.Id}}') {
    if (args.at(-1).endsWith('-sync-cell-a-1')) return cellIds[0]
    if (args.at(-1).endsWith('-sync-cell-b-1')) return cellIds[1]
    return redisId
  }
  if (args[0] === 'logs') { event('logs'); return '' }
  throw new Error(`unexpected subprocess ${file} ${args.join(' ')}`)
}
childProcess.execFile = (file, args, _options, callback) => {
  queueMicrotask(() => {
    try { callback(null, dockerResult(file, args), '') } catch (error) { callback(error, '', '') }
  })
  return { kill() { throw new Error('fixture subprocess cannot be killed') } }
}
childProcess.execFileSync = (file, args) => dockerResult(file, args)
childProcess.spawnSync = (file, args) => ({ status: 0, stdout: dockerResult(file, args), stderr: '' })
childProcess.spawn = childProcess.exec = () => { throw new Error('unmocked subprocess API refused') }
syncBuiltinESMExports()
Object.assign(process.env, {
  SYNC_FAILOVER_PROJECT: 'qa-gate-local',
  SYNC_FAILOVER_CELL_A_PORT: String(cellServers[0].address().port),
  SYNC_FAILOVER_CELL_B_PORT: String(cellServers[1].address().port),
  SYNC_FAILOVER_ROUTER_PORT: String(router.address().port),
})
process.argv.push('--observe-router-url', `http://127.0.0.1:${router.address().port}/api/ready`)

process.once('uncaughtException', async error => {
  if (closing) return
  closing = true
  const socketsClosed = Promise.all([...sockets].map(socket => new Promise(resolve => socket.once('close', resolve))))
  for (const peer of peers) peer.terminate()
  for (const socket of sockets) socket.destroy()
  await socketsClosed
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  await new Promise(resolve => ws.close(resolve))
  Date.now = originalNow
  http.request = originalRequest
  net.createConnection = originalConnect
  Object.assign(childProcess, originalChildren)
  syncBuiltinESMExports()
  writeFileSync(reportPath, JSON.stringify({ mode, error: String(error.stack ?? error), commands, requests,
    paused, events, redisConnections, redisRequests, markerThrew,
    serversClosed: servers.every(server => !server.listening), socketCount: sockets.size,
  }, null, 2) + '\n')
  process.exitCode = 1
})
