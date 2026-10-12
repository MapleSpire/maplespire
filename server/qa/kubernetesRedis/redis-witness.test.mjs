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

import test from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { isIP } from 'node:net'
import { setImmediate as immediate } from 'node:timers/promises'
import { ConnectionTimeoutError, SimpleError, ErrorReply } from 'redis'
import { readRedisWitness } from './redis-witness.mjs'

const args = { namespace: 'maplespire-b516a-3176', backendPod: 'maplespire-backend-6b4c7cdbd8-zmphb',
  host: 'redis-critical.maplespire-b516a-3176-deps.svc.cluster.local', port: 6379, prefix: 'maplespire' }
const sha = text => crypto.createHash('sha256').update(text).digest('hex')
const runId = 'a'.repeat(40)
function envelope(stdout) {
  return { ok: true, code: 0, signal: null, error: null, timedOut: false, clockValid: true,
    nativeCloseConfirmed: true, backend: 'native-kubectl', context: 'docker-desktop', spawned: true, stdinFinished: true, stdout }
}
function validBody(program) {
  const episodeId = program.match(/,"([a-f0-9-]{36})"\)$/)?.[1]
  assert.ok(episodeId)
  return { schema: 'b516-redis-witness/v2', episodeId, host: args.host, port: args.port, key: 'maplespire:sync-cell:topology',
    state: 'available', reason: null, phase: 'done', ping: 'PONG', runId,
    topology: { value: 'v1|1', sha256: sha('v1|1') }, socketCreated: 1, socketClosed: 1,
    nativeClosed: true, settled: true, nativeErrorCode: null, errorKind: null, nativeErrorKind: null,
    globalDeadlineFired: false, tcpConnects: 1, socketTimeouts: 0, nativeTimeoutBudgetMs: null,
    lookupCount: 1, lookupSucceeded: true, lookupFailed: false,
    clockValid: true, clockDomain: 'pod-performance',
    marks: { started: 10, created: 20, lookup: 20.5, connected: 21, timeout: null, error: null, closed: 30, finished: 31 } }
}
async function resultFor(mutateBody = () => {}, mutateProcess = () => {}) {
  let fixtureError
  const observation = await readRedisWitness(async (argv, options) => {
    try {
    assert.deepEqual(argv.slice(0, -1), ['-n', args.namespace, 'exec', '-i', args.backendPod, '-c', 'backend', '--', 'node', '-e'])
    assert.equal(options.timeoutMs, 5000)
    assert.equal(argv.at(-1), 'eval(require("node:fs").readFileSync(0,"utf8"))')
    const program = options.input
    assert.ok(program.length <= 32 * 1024)
    assert.equal(/[\0\r]/.test(program), false)
    assert.equal(program.includes('synthetic-pod-password'), false)
    new vm.Script(program)
    const body = validBody(program)
    mutateBody(body)
    const result = envelope(JSON.stringify(body))
    mutateProcess(result)
      return result
    } catch (error) { fixtureError = error; throw error }
  }, args)
  if (fixtureError) throw fixtureError
  return observation
}

test('only the exact lab namespace, Pod, critical endpoint, port and prefix can reach the runner', async () => {
  let called = false
  for (const key of Object.keys(args)) {
    await assert.rejects(readRedisWitness(() => { called = true }, { ...args, [key]: key === 'port' ? 6380 : 'foreign' }), /LAB_ENDPOINT/)
    const missing = { ...args }; delete missing[key]
    await assert.rejects(readRedisWitness(() => { called = true }, missing), /LAB_ENDPOINT/)
  }
  await assert.rejects(readRedisWitness(null, args), /RUNNER/)
  assert.equal(called, false)
})
test('available reply pins identity, exact topology hash and actual child/sockets closure', async () => {
  const result = await resultFor()
  assert.equal(result.state, 'available')
  assert.equal(result.reason, null)
  assert.equal(result.observation.runId, runId)
  assert.deepEqual(result.observation.topology, { value: 'v1|1', sha256: sha('v1|1') })
  assert.ok(result.ended >= result.began)
})
test('missing topology is an explicit successful GET null, not a fabricated contract', async () => {
  const result = await resultFor(body => { body.topology = { value: null, sha256: null } })
  assert.equal(result.state, 'available')
  assert.deepEqual(result.observation.topology, { value: null, sha256: null })
})
test('native refused socket can witness unavailable only when its settled child and native close agree', async () => {
  const result = await resultFor(body => Object.assign(body, { state: 'unavailable', phase: 'connect', reason: 'ECONNREFUSED',
    nativeErrorCode: 'ECONNREFUSED', errorKind: 'NETWORK', nativeErrorKind: 'NETWORK', ping: null, runId: null, topology: null,
    marks: { ...body.marks, connected: null, error: 22 }, tcpConnects: 0 }))
  assert.equal(result.state, 'unavailable')
  assert.equal(result.reason, 'ECONNREFUSED')
  assert.equal(result.observation.nativeClosed, true)
})

for (const [label, mutate] of [
  ['nonzero exit with apparently valid JSON', p => { p.code = 1 }],
  ['signal', p => { p.signal = 'SIGTERM' }],
  ['missing code', p => { delete p.code }],
  ['missing signal', p => { delete p.signal }],
  ['timeout', p => { p.timedOut = true }],
  ['error', p => { p.error = 'sensitive-native-error' }],
  ['not closed', p => { p.nativeCloseConfirmed = false }],
  ['clock invalid', p => { p.clockValid = false }],
  ['foreign context', p => { p.context = 'foreign' }],
  ['injected runner backend', p => { p.backend = 'injected-local-process' }],
  ['not spawned', p => { p.spawned = false }],
  ['stdin incomplete', p => { p.stdinFinished = false }],
  ['runner not okay', p => { p.ok = false }],
]) test('kubectl failure stays UNKNOWN: ' + label, async () => {
  const result = await resultFor(() => {}, mutate)
  assert.equal(result.state, 'unknown')
  assert.equal(result.observation, null)
  assert.equal(JSON.stringify(result).includes('sensitive-native-error'), false)
})

for (const [label, mutate] of [
  ['wrong episode', b => { b.episodeId = crypto.randomUUID() }],
  ['wrong host', b => { b.host = 'cache' }],
  ['wrong key', b => { b.key = 'maplespire:cache:sync-cell:topology' }],
  ['socket not closed', b => { b.nativeClosed = false }],
  ['close missing', b => { b.socketClosed = 0 }],
  ['extra connection', b => { b.socketCreated = 2 }],
  ['no socket', b => { b.socketCreated = 0; b.socketClosed = 0 }],
  ['pending work', b => { b.settled = false }],
  ['wrong PING', b => { b.ping = 'OK' }],
  ['wrong INFO identity', b => { b.runId = 'invalid' }],
  ['unread topology', b => { b.topology = null }],
  ['hash mismatch', b => { b.topology.sha256 = 'b'.repeat(64) }],
  ['arbitrary topology', b => { b.topology = { value: 'sensitive-invalid', sha256: sha('sensitive-invalid') } }],
  ['wrong phase', b => { b.phase = 'connect' }],
  ['auth failure is not a network outage', b => { b.state = 'unavailable'; b.reason = 'WRONGPASS'; b.phase = 'connect' }],
  ['global deadline is not a network outage', b => { b.state = 'unavailable'; b.reason = 'DEADLINE'; b.phase = 'connect' }],
  ['no native network error', b => { b.state = 'unavailable'; b.reason = 'ECONNREFUSED'; b.phase = 'connect' }],
]) test('invalid reply stays UNKNOWN: ' + label, async () => {
  const result = await resultFor(mutate)
  assert.equal(result.state, 'unknown')
  assert.equal(result.observation, null)
  assert.equal(JSON.stringify(result).includes('sensitive-invalid'), false)
})
test('runner throw, malformed output and raw stderr are never published', async () => {
  const rejected = await readRedisWitness(async () => { throw Error('private-password') }, args)
  assert.equal(rejected.reason, 'KUBECTL_REJECTED')
  for (const stdout of ['{', 'x'.repeat(4097), null]) {
    const result = await resultFor(() => {}, p => { p.stdout = stdout; p.stderr = 'private-password' })
    assert.equal(result.state, 'unknown')
    assert.equal(JSON.stringify(result).includes('private-password'), false)
  }
  assert.equal(JSON.stringify(rejected).includes('private-password'), false)
})
test('unknown extra stdout fields cannot forward credentials into evidence', async () => {
  const result = await resultFor(body => { body.password = 'private-password'; body.errorMessage = 'private-password' })
  assert.equal(result.state, 'available')
  assert.equal(JSON.stringify(result).includes('private-password'), false)
})

// Execute the exact serialized program against an isolated VM with fake Redis
// and fake socket/timers. This checks its wiring, not a live Redis connection.
async function programFixture({ variant = 'healthy', holdClose = false } = {}) {
  let program
  await readRedisWitness(async (_, options) => { program = options.input; return {} }, args)
  const calls = [], sockets = [], pendingCloses = [], timers = new Map()
  let output = null, exitCode = null, options, rejectConnect, clock = 0
  const env = { REDIS_HOST: args.host, REDIS_PORT: String(args.port), REDIS_KEY_PREFIX: args.prefix,
    REDIS_TLS: 'off', REDIS_PASSWORD: 'synthetic-pod-password' }
  if (variant === 'foreign-env') env.REDIS_HOST = 'cache'
  const net = { isIP, createConnection(o) {
    calls.push(['socket', o.host, o.port])
    const socket = new EventEmitter()
    let closed = false
    socket.destroy = () => {
      if (closed) return
      closed = true
      const close = () => socket.emit('close')
      if (holdClose) pendingCloses.push(close); else queueMicrotask(close)
    }
    sockets.push(socket)
    return socket
  } }
  const originalConnect = net.createConnection
  const client = new EventEmitter()
  client.isOpen = false
  client.connect = async () => {
    client.isOpen = true
    const socket = net.createConnection(options.socket)
    calls.push(['connect'])
    if (variant !== 'dns-pending-timeout') socket.emit('lookup', variant === 'dns-error-timeout' ? Error('private-dns-error') : null,
      variant === 'dns-invalid-ip-timeout' ? 'invalid-address' : '10.0.0.10', variant === 'dns-wrong-family-timeout' ? 6 : 4,
      variant === 'dns-foreign-host-timeout' ? 'foreign' : args.host)
    if (variant === 'refused') {
      const error = Object.assign(Error('do-not-print'), { code: 'ECONNREFUSED' })
      socket.emit('error', error)
      throw error
    }
    if (variant.endsWith('-timeout')) {
      socket.timeout = 1500
      socket.once('timeout', () => {
        const error = new ConnectionTimeoutError()
        socket.emit('error', error); socket.destroy(); rejectConnect(error)
      })
      await new Promise((_, reject) => { rejectConnect = reject })
      return
    }
    socket.emit('connect')
    if (variant === 'stalled') await new Promise((_, reject) => { rejectConnect = reject })
  }
  client.destroy = () => { calls.push(['destroy']); client.isOpen = false; rejectConnect?.(Error('stopped')); for (const s of sockets) s.destroy() }
  client.ping = async () => { calls.push(['PING']); return 'PONG' }
  client.info = async section => { calls.push(['INFO', section]); return '# Server\r\nrun_id:' + runId + '\r\n' }
  client.get = async key => { calls.push(['GET', key]); return 'v1|1' }
  const task = vm.runInNewContext(program, {
    require(name) {
      if (name === 'node:net') return net
      if (name === 'node:crypto') return crypto
      if (name === 'node:perf_hooks') return { performance: { now: () => ++clock } }
      if (name === 'redis') return { ConnectionTimeoutError, SimpleError, ErrorReply, createClient(value) { options = value; return client } }
      throw Error('unexpected require')
    },
    process: { env, stdout: { write(text, callback) { output = JSON.parse(text); callback?.() } }, exit(code) { exitCode = code } },
    setTimeout(callback, ms) { const token = {}; timers.set(ms, { token, callback }); return token },
    clearTimeout(token) { for (const [ms, entry] of timers) if (entry.token === token) timers.delete(ms) },
  })
  return { task, calls, pendingCloses, timers, fireConnectTimeout() { clock += 1500; sockets[0].emit('timeout') }, get output() { return output }, get exitCode() { return exitCode },
    get options() { return options }, net, originalConnect }
}
test('serialized program reads only Pod env credential, sends PING/INFO/GET and waits for actual socket close', async () => {
  const fixture = await programFixture({ holdClose: true })
  await immediate()
  assert.equal(fixture.output, null, 'destroy alone is not proof of native close')
  assert.equal(fixture.pendingCloses.length, 1)
  fixture.pendingCloses[0]()
  await fixture.task
  assert.equal(fixture.output.state, 'available')
  assert.equal(fixture.output.nativeClosed, true)
  assert.equal(fixture.options.password, 'synthetic-pod-password')
  assert.equal(fixture.options.disableOfflineQueue, true)
  assert.equal(fixture.options.disableClientInfo, true)
  assert.equal(fixture.options.socket.connectTimeout, 1500)
  assert.equal(fixture.options.socket.reconnectStrategy, false)
  assert.deepEqual(fixture.calls.filter(row => ['PING', 'INFO', 'GET'].includes(row[0])), [['PING'], ['INFO', 'server'], ['GET', 'maplespire:sync-cell:topology']])
  assert.equal(JSON.stringify(fixture.output).includes('synthetic-pod-password'), false)
  assert.equal(fixture.net.createConnection, fixture.originalConnect)
  assert.equal(fixture.timers.size, 0)
})
test('serialized program distinguishes a native refused connection from wrong environment', async () => {
  for (const [variant, state] of [['refused', 'unavailable'], ['foreign-env', 'unknown']]) {
    const fixture = await programFixture({ variant })
    await fixture.task
    assert.equal(fixture.output.state, state)
    assert.equal(fixture.output.nativeClosed, true)
    assert.equal(fixture.timers.size, 0)
    if (variant === 'foreign-env') assert.equal(fixture.calls.length, 0)
  }
})
test('serialized deadline destroys work and joins closure while reporting UNKNOWN', async () => {
  const fixture = await programFixture({ variant: 'stalled' })
  fixture.timers.get(2500).callback()
  await fixture.task
  assert.equal(fixture.output.state, 'unknown')
  assert.equal(fixture.output.reason, 'DEADLINE')
  assert.equal(fixture.output.settled, true)
  assert.equal(fixture.output.nativeClosed, true)
  assert.equal(fixture.timers.size, 0)
})
test('serialized cleanup deadline cannot claim closed or unavailable', async () => {
  const fixture = await programFixture({ holdClose: true })
  await immediate()
  fixture.timers.get(750).callback()
  await fixture.task
  assert.equal(fixture.output.state, 'unknown')
  assert.equal(fixture.output.reason, 'CLEANUP_FAILED')
  assert.equal(fixture.output.nativeClosed, false)
  assert.equal(fixture.exitCode, 2)
  fixture.pendingCloses[0]()
})

function timeoutBody(body) {
  Object.assign(body, { state: 'unavailable', reason: 'CONNECT_TIMEOUT', phase: 'connect', errorKind: 'CONNECT_TIMEOUT',
    nativeErrorKind: 'CONNECT_TIMEOUT', nativeErrorCode: null, tcpConnects: 0, socketTimeouts: 1, nativeTimeoutBudgetMs: 1500,
    ping: null, runId: null, topology: null,
    marks: { started: 10, created: 20, lookup: 20.5, connected: null, timeout: 1521, error: 1522, closed: 1523, finished: 1524 } })
}
test('v2 qualifies observed preconnect timeout plus exact ConnectionTimeoutError and ordered close', async () => {
  const result = await resultFor(timeoutBody)
  assert.equal(result.state, 'unavailable')
  assert.equal(result.reason, 'CONNECT_TIMEOUT')
  assert.equal(result.diagnostic.nativeTimeoutBudgetMs, 1500)
  assert.equal(result.diagnostic.globalDeadlineFired, false)
  assert.equal(result.diagnostic.clockDomain, 'pod-performance')
})
for (const [label, mutate] of [
  ['no timeout event', b => { b.socketTimeouts = 0 }],
  ['more than one timeout', b => { b.socketTimeouts = 2 }],
  ['wrong socket timeout budget', b => { b.nativeTimeoutBudgetMs = 2500 }],
  ['native error class missing', b => { b.nativeErrorKind = null }],
  ['promise error class missing', b => { b.errorKind = null }],
  ['error before timeout', b => { b.marks.error = 1510 }],
  ['close before error', b => { b.marks.closed = 1520 }],
  ['connect event already happened', b => { b.tcpConnects = 1; b.marks.connected = 21 }],
  ['connect timestamp without counter', b => { b.marks.connected = 21 }],
  ['after connect phase', b => { b.phase = 'ping' }],
  ['global deadline also fired', b => { b.globalDeadlineFired = true }],
  ['deadline flag absent', b => { delete b.globalDeadlineFired }],
  ['clock invalid', b => { b.clockValid = false }],
  ['clock origin unknown', b => { b.clockDomain = 'parent' }],
  ['unclosed socket', b => { b.socketClosed = 0; b.nativeClosed = false }],
  ['DNS still pending', b => { b.lookupCount = 0; b.lookupSucceeded = false; b.marks.lookup = null }],
  ['DNS lookup failed', b => { b.lookupSucceeded = false; b.lookupFailed = true }],
  ['DNS success absent', b => { delete b.lookupSucceeded }],
  ['more than one lookup', b => { b.lookupCount = 2 }],
  ['lookup after timeout', b => { b.marks.lookup = 1522 }],
]) test('v2 timeout witness refuses ' + label, async () => {
  const result = await resultFor(b => { timeoutBody(b); mutate(b) })
  assert.equal(result.state, 'unknown')
  assert.ok(result.diagnostic)
  assert.equal(result.observation, null)
})
test('unknown phase and reason survive sanitization, without arbitrary strings', async () => {
  const result = await resultFor(b => Object.assign(b, { state: 'unknown', reason: 'REDIS_REPLY', phase: 'connect',
    errorKind: 'REDIS_REPLY', message: 'private-password', tcpConnects: 0, socketCreated: 0, socketClosed: 0, settled: false }))
  assert.equal(result.state, 'unknown')
  assert.equal(result.diagnostic.reason, 'REDIS_REPLY')
  assert.equal(result.diagnostic.phase, 'connect')
  assert.equal(JSON.stringify(result).includes('private-password'), false)
  const arbitrary = await resultFor(b => Object.assign(b, { state: 'unknown', reason: 'private-password', errorKind: 'private-password' }))
  assert.equal(arbitrary.diagnostic.reason, 'UNRECOGNIZED')
  assert.equal(JSON.stringify(arbitrary).includes('private-password'), false)
})
test('child cleanup exit2 preserves allowlisted diagnostic while staying unknown', async () => {
  const result = await resultFor(b => Object.assign(b, { state: 'unknown', reason: 'CLEANUP_FAILED', nativeClosed: false, socketClosed: 0 }),
    p => { p.ok = false; p.code = 2; p.error = 'CHILD_FAILED' })
  assert.equal(result.state, 'unknown')
  assert.equal(result.reason, 'KUBECTL_UNKNOWN')
  assert.equal(result.diagnostic.reason, 'CLEANUP_FAILED')
  assert.equal(result.diagnostic.nativeClosed, false)
})
test('serialized v2 observes real installed ConnectionTimeoutError class, not its generic Error name', async () => {
  assert.equal(new ConnectionTimeoutError().name, 'Error')
  const fixture = await programFixture({ variant: 'connect-timeout' })
  fixture.fireConnectTimeout()
  await fixture.task
  assert.equal(fixture.output.state, 'unavailable')
  assert.equal(fixture.output.reason, 'CONNECT_TIMEOUT')
  assert.equal(fixture.output.errorKind, 'CONNECT_TIMEOUT')
  assert.equal(fixture.output.nativeErrorKind, 'CONNECT_TIMEOUT')
  assert.equal(fixture.output.socketTimeouts, 1)
  assert.equal(fixture.output.tcpConnects, 0)
  assert.equal(fixture.output.globalDeadlineFired, false)
  assert.equal(fixture.output.nativeClosed, true)
  assert.equal(fixture.timers.size, 0)
})

test('serialized connect timeout during pending DNS cannot qualify Redis unavailable', async () => {
  const fixture = await programFixture({ variant: 'dns-pending-timeout' })
  fixture.fireConnectTimeout()
  await fixture.task
  assert.equal(fixture.output.state, 'unknown')
  assert.equal(fixture.output.reason, 'CONNECT_TIMEOUT')
  assert.equal(fixture.output.lookupCount, 0)
  assert.equal(fixture.output.lookupSucceeded, false)
  assert.equal(fixture.output.nativeClosed, true)
})

for (const variant of ['dns-error-timeout', 'dns-invalid-ip-timeout', 'dns-wrong-family-timeout', 'dns-foreign-host-timeout']) {
  test('serialized lookup validation rejects ' + variant, async () => {
    const fixture = await programFixture({ variant })
    fixture.fireConnectTimeout()
    await fixture.task
    assert.equal(fixture.output.state, 'unknown')
    assert.equal(fixture.output.lookupCount, 1)
    assert.equal(fixture.output.lookupSucceeded, false)
    assert.equal(fixture.output.lookupFailed, variant === 'dns-error-timeout')
    assert.equal(fixture.output.nativeClosed, true)
    assert.equal(JSON.stringify(fixture.output).includes('private-dns-error'), false)
  })
}

test('native Node bootstrap consumes exact stdin and refuses missing Pod environment before any Redis socket', () => {
  return readRedisWitness(async (argv, options) => {
    const child = spawnSync(process.execPath, argv.slice(-2), { input: options.input, encoding: 'utf8',
      env: { SystemRoot: process.env.SystemRoot }, windowsHide: true, shell: false, timeout: 3000 })
    assert.equal(child.status, 0)
    assert.equal(child.signal, null)
    assert.equal(child.error, undefined)
    assert.equal(child.stderr, '')
    const output = JSON.parse(child.stdout)
    assert.equal(output.state, 'unknown')
    assert.equal(output.reason, 'ENVIRONMENT')
    assert.equal(output.errorKind, 'ENVIRONMENT')
    assert.equal(output.phase, 'setup')
    assert.equal(output.socketCreated, 0)
    assert.equal(output.socketClosed, 0)
    assert.equal(output.nativeClosed, true)
    return envelope(child.stdout)
  }, args).then(result => {
    assert.equal(result.reason, 'PROBE_CLOSURE_OR_CLOCK_INVALID')
    assert.equal(result.diagnostic.reason, 'ENVIRONMENT')
  })
})
