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

import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const endpoint = Object.freeze({ namespace: 'maplespire-b516a-3176',
  host: 'redis-critical.maplespire-b516a-3176-deps.svc.cluster.local', port: 6379, prefix: 'maplespire' })
const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'])
const digest = value => createHash('sha256').update(value).digest('hex')
const schema = 'b516-redis-witness/v2'

// This public program is supplied on stdin to a fresh Pod Node process. The
// short -e bootstrap has no credentials; imports never execute this function.
async function podProbe(e, episodeId) {
  const net = require('node:net'), { createHash } = require('node:crypto')
  const { performance } = require('node:perf_hooks')
  const out = { schema: 'b516-redis-witness/v2', episodeId, host: e.host, port: e.port, key: e.prefix + ':sync-cell:topology',
    state: 'unknown', reason: 'SETUP', phase: 'setup', ping: null, runId: null, topology: null,
    socketCreated: 0, socketClosed: 0, nativeClosed: false, settled: false, nativeErrorCode: null,
    errorKind: null, nativeErrorKind: null, globalDeadlineFired: false, socketTimeouts: 0, tcpConnects: 0,
    lookupCount: 0, lookupSucceeded: false, lookupFailed: false,
    nativeTimeoutBudgetMs: null, clockValid: true, clockDomain: 'pod-performance',
    marks: { started: null, created: null, lookup: null, connected: null, timeout: null, error: null, closed: null, finished: null } }
  const sockets = new Map(), connect = net.createConnection
  let client, redis, flight, timer, cleanupTimer, cleanupFailed = false, lastAt = -Infinity
  const stamp = key => {
    const value = performance.now()
    if (!Number.isFinite(value) || value < lastAt) { out.clockValid = false; return }
    lastAt = value; out.marks[key] ??= value
  }
  const knownCodes = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']
  const kinds = ['ENVIRONMENT', 'ENDPOINT', 'INVALID_PING', 'INVALID_INFO', 'INVALID_TOPOLOGY', 'DEADLINE']
  const errorKind = error => {
    if (kinds.includes(error?.witnessKind)) return error.witnessKind
    if (redis?.ConnectionTimeoutError && error instanceof redis.ConnectionTimeoutError) return 'CONNECT_TIMEOUT'
    if ((redis?.SimpleError && error instanceof redis.SimpleError) || (redis?.ErrorReply && error instanceof redis.ErrorReply)) return 'REDIS_REPLY'
    if (knownCodes.includes(error?.code)) return 'NETWORK'
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) return 'DNS'
    return 'UNKNOWN_ERROR'
  }
  const problem = witnessKind => Object.assign(new Error(), { witnessKind })
  stamp('started')
  const stop = () => { if (client?.isOpen) { try { client.destroy() } catch { cleanupFailed = true } } for (const s of sockets.keys()) s.destroy() }
  net.createConnection = function (o) {
    if (o.host !== e.host || o.port !== e.port || o.path || o.tls || out.socketCreated) throw problem('ENDPOINT')
    const s = connect.call(net, o); out.socketCreated++; stamp('created')
    s.on('lookup', (error, address, family, host) => {
      out.lookupCount++; out.lookupFailed ||= Boolean(error)
      out.lookupSucceeded = error === null && host === e.host && [4, 6].includes(family) && net.isIP(address) === family
      stamp('lookup')
    })
    s.on('connect', () => { out.tcpConnects++; stamp('connected') })
    s.on('timeout', () => { out.socketTimeouts++; out.nativeTimeoutBudgetMs = s.timeout; stamp('timeout') })
    s.on('error', error => { out.nativeErrorKind = errorKind(error); if (knownCodes.includes(error?.code)) out.nativeErrorCode = error.code; stamp('error') })
    sockets.set(s, new Promise(r => s.once('close', () => { out.socketClosed++; sockets.delete(s); stamp('closed'); r() })))
    return s
  }
  try {
    if (process.env.REDIS_HOST !== e.host || process.env.REDIS_PORT !== String(e.port) || process.env.REDIS_KEY_PREFIX !== e.prefix
      || process.env.REDIS_TLS !== 'off' || process.env.REDIS_URL || !process.env.REDIS_PASSWORD) throw problem('ENVIRONMENT')
    redis = require('redis')
    client = redis.createClient({ password: process.env.REDIS_PASSWORD, disableOfflineQueue: true, disableClientInfo: true,
      socket: { host: e.host, port: e.port, connectTimeout: 1500, reconnectStrategy: false } })
    client.on('error', () => {})
    flight = (async () => {
      out.phase = 'connect'; await client.connect()
      out.phase = 'ping'; out.ping = await client.ping()
      if (out.ping !== 'PONG') throw problem('INVALID_PING')
      out.phase = 'info'; const info = await client.info('server')
      const matches = typeof info === 'string' ? [...info.matchAll(/^run_id:([a-f0-9]{40})\r?$/gm)] : []
      if (matches.length !== 1) throw problem('INVALID_INFO')
      out.runId = matches[0][1]
      out.phase = 'topology'; const value = await client.get(out.key)
      if (value !== null && (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}\|[1-9][0-9]{0,8}$/.test(value))) throw problem('INVALID_TOPOLOGY')
      out.topology = { value, sha256: value === null ? null : createHash('sha256').update(value).digest('hex') }
      out.phase = 'done'; out.state = 'available'; out.reason = null
    })().finally(() => { out.settled = true })
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { out.globalDeadlineFired = true; stop(); reject(problem('DEADLINE')) }, 2500) })
    await Promise.race([flight, deadline])
  } catch (error) {
    out.errorKind = errorKind(error)
    const nativeFailure = knownCodes.includes(error?.code) && out.nativeErrorCode === error.code
    const nativeTimeout = out.phase === 'connect' && out.errorKind === 'CONNECT_TIMEOUT' && out.nativeErrorKind === 'CONNECT_TIMEOUT'
      && out.socketTimeouts === 1 && out.tcpConnects === 0 && out.nativeTimeoutBudgetMs === 1500
      && out.lookupCount === 1 && out.lookupSucceeded && !out.lookupFailed
      && out.marks.lookup !== null && out.marks.timeout !== null && out.marks.lookup <= out.marks.timeout
    out.state = !out.globalDeadlineFired && (nativeFailure || nativeTimeout) ? 'unavailable' : 'unknown'
    out.reason = out.globalDeadlineFired ? 'DEADLINE' : nativeFailure ? error.code : out.errorKind
    if (out.ping !== 'PONG') out.ping = null
  } finally {
    clearTimeout(timer); stop()
    try {
      await Promise.race([Promise.all([flight?.catch(() => {}), ...sockets.values()]), new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(Error('CLOSE')), 750) })])
    } catch { cleanupFailed = true }
    clearTimeout(cleanupTimer); net.createConnection = connect
    out.nativeClosed = !cleanupFailed && out.socketCreated === out.socketClosed && sockets.size === 0 && !client?.isOpen
    if (!out.nativeClosed) { out.state = 'unknown'; out.reason = 'CLEANUP_FAILED' }
    stamp('finished')
    if (!out.clockValid) { out.state = 'unknown'; out.reason = 'CLOCK_INVALID' }
  }
  process.stdout.write(JSON.stringify(out), () => { if (!out.nativeClosed) process.exit(2) })
}

/** The parent window includes exec startup and actual child closure. The probe
 * does not export Pod monotonic timestamps or turn kubectl failure into Redis
 * downtime. No secret value enters argv, stdin, errors or returned evidence.
 */
export async function readRedisWitness(runKubectl, options = {}) {
  if (!/^maplespire-backend-[a-z0-9]+-[a-z0-9]+$/.test(options.backendPod ?? '')) throw new Error('REDIS_WITNESS_LAB_ENDPOINT_REQUIRED')
  const expected = { ...endpoint, backendPod: options.backendPod }
  if (typeof runKubectl !== 'function') throw new Error('REDIS_WITNESS_RUNNER_REQUIRED')
  for (const [key, value] of Object.entries(expected)) if (options[key] !== value) throw new Error('REDIS_WITNESS_LAB_ENDPOINT_REQUIRED')
  const episodeId = randomUUID(), began = performance.now()
  const program = '(' + podProbe.toString() + ')(' + JSON.stringify(expected) + ',' + JSON.stringify(episodeId) + ')'
  if (Buffer.byteLength(program) > 32 * 1024 || /[\r\0]/.test(program)) throw new Error('REDIS_WITNESS_PROGRAM_INVALID')
  const base = { schema, episodeId, began, ended: null, endpoint: { ...expected }, programSha256: digest(program),
    state: 'unknown', reason: null, observation: null, process: null }
  let result
  try {
    result = await runKubectl(['-n', expected.namespace, 'exec', '-i', expected.backendPod, '-c', 'backend', '--', 'node', '-e',
      'eval(require("node:fs").readFileSync(0,"utf8"))'], { input: program, timeoutMs: 5000 })
  } catch { return { ...base, ended: performance.now(), reason: 'KUBECTL_REJECTED' } }
  base.ended = performance.now()
  base.process = { code: Number.isInteger(result?.code) ? result.code : null, signal: result?.signal === null ? null : 'SIGNALLED_OR_MISSING',
    nativeCloseConfirmed: result?.nativeCloseConfirmed === true, ok: result?.ok === true,
    error: result?.error === null ? null : 'KUBECTL_ERROR', timedOut: result?.timedOut === true }
  const processValid = !(result?.ok !== true || result.nativeCloseConfirmed !== true || result.code !== 0 || result.signal !== null
    || result.error !== null || result.timedOut !== false || result.clockValid !== true || result.backend !== 'native-kubectl'
    || result.context !== 'docker-desktop' || result.spawned !== true || result.stdinFinished !== true)
  if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 4096) return { ...base, reason: 'PROBE_BODY_INVALID' }
  base.bodySha256 = digest(result.stdout)
  let body
  try { body = JSON.parse(result.stdout) } catch { return { ...base, reason: 'PROBE_BODY_INVALID' } }
  const validIdentity = body?.schema === schema && body.episodeId === episodeId && body.host === expected.host && body.port === expected.port
    && body.key === expected.prefix + ':sync-cell:topology'
  if (!validIdentity) return { ...base, reason: 'PROBE_IDENTITY_INVALID' }
  const phases = ['setup', 'connect', 'ping', 'info', 'topology', 'done']
  const reasons = ['SETUP', 'ENVIRONMENT', 'ENDPOINT', 'INVALID_PING', 'INVALID_INFO', 'INVALID_TOPOLOGY', 'DEADLINE',
    'CONNECT_TIMEOUT', 'REDIS_REPLY', 'NETWORK', 'DNS', 'UNKNOWN_ERROR', 'CLEANUP_FAILED', 'CLOCK_INVALID', ...networkCodes]
  const safe = value => value === null || (typeof value === 'string' && reasons.includes(value)) ? value : 'UNRECOGNIZED'
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 16 ? value : null
  const marks = Object.fromEntries(['started', 'created', 'lookup', 'connected', 'timeout', 'error', 'closed', 'finished'].map(key =>
    [key, Number.isFinite(body.marks?.[key]) && body.marks[key] >= 0 ? body.marks[key] : null]))
  base.diagnostic = { phase: phases.includes(body.phase) ? body.phase : 'UNRECOGNIZED', reason: safe(body.reason),
    errorKind: safe(body.errorKind), nativeErrorKind: safe(body.nativeErrorKind), nativeErrorCode: safe(body.nativeErrorCode),
    globalDeadlineFired: typeof body.globalDeadlineFired === 'boolean' ? body.globalDeadlineFired : null,
    socketCreated: count(body.socketCreated), socketClosed: count(body.socketClosed), tcpConnects: count(body.tcpConnects), socketTimeouts: count(body.socketTimeouts),
    lookupCount: count(body.lookupCount), lookupSucceeded: body.lookupSucceeded === true, lookupFailed: body.lookupFailed === true,
    nativeTimeoutBudgetMs: body.nativeTimeoutBudgetMs === 1500 ? 1500 : null,
    nativeClosed: body.nativeClosed === true, settled: body.settled === true, clockValid: body.clockValid === true,
    clockDomain: 'pod-performance', marks }
  if (!processValid) return { ...base, reason: 'KUBECTL_UNKNOWN' }
  const validClosure = body.nativeClosed === true && body.settled === true && body.socketCreated === 1 && body.socketClosed === 1
  const ordered = keys => keys.every(key => marks[key] !== null) && keys.every((key, index) => index === 0 || marks[key] >= marks[keys[index - 1]])
  if (!validClosure || body.clockValid !== true || body.clockDomain !== 'pod-performance'
    || !ordered(['started', 'created', 'closed', 'finished'])) return { ...base, reason: 'PROBE_CLOSURE_OR_CLOCK_INVALID' }
  if (body.globalDeadlineFired !== false) return { ...base, reason: 'PROBE_DEADLINE_OR_INVALID_FLAG' }
  if (body.state === 'available') {
    const value = body.topology?.value
    if (body.reason !== null || body.phase !== 'done' || body.ping !== 'PONG' || !/^[a-f0-9]{40}$/.test(body.runId ?? '')
      || body.tcpConnects !== 1 || !ordered(['created', 'connected', 'closed'])
      || !(value === null || (typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}\|[1-9][0-9]{0,8}$/.test(value)))
      || body.topology.sha256 !== (value === null ? null : digest(value))) return { ...base, reason: 'PROBE_REPLY_INVALID' }
  } else if (body.state === 'unavailable') {
    const nativeNetwork = networkCodes.has(body.reason) && body.nativeErrorCode === body.reason
      && body.nativeErrorKind === 'NETWORK' && body.errorKind === 'NETWORK'
      && ['connect', 'ping', 'info', 'topology'].includes(body.phase) && ordered(['created', 'error', 'closed'])
    const nativeTimeout = body.reason === 'CONNECT_TIMEOUT' && body.phase === 'connect' && body.errorKind === 'CONNECT_TIMEOUT'
      && body.nativeErrorKind === 'CONNECT_TIMEOUT' && body.tcpConnects === 0 && marks.connected === null
      && body.socketTimeouts === 1 && body.nativeTimeoutBudgetMs === 1500 && body.nativeErrorCode === null
      && body.lookupCount === 1 && body.lookupSucceeded === true && body.lookupFailed === false
      && ordered(['created', 'lookup', 'timeout', 'error', 'closed'])
    if (!nativeNetwork && !nativeTimeout) return { ...base, reason: 'PROBE_REPLY_INVALID' }
  } else return { ...base, reason: 'PROBE_UNKNOWN' }
  // Publish only an allowlist; even a compromised stdout fixture cannot forward
  // arbitrary fields or a raw Redis error message into the caller's report.
  base.observation = { phase: body.phase, ping: body.ping === 'PONG' ? 'PONG' : null,
    runId: /^[a-f0-9]{40}$/.test(body.runId ?? '') ? body.runId : null,
    topology: body.state === 'available' ? { value: body.topology.value, sha256: body.topology.sha256 } : null,
    nativeClosed: true, socketCreated: 1, socketClosed: 1, settled: true,
    nativeErrorCode: networkCodes.has(body.nativeErrorCode) ? body.nativeErrorCode : null }
  return { ...base, state: body.state, reason: body.reason }
}
