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

/**
 * REMOTE LOAD: the load-soak gate's client processes on ANOTHER machine.
 *
 * WHY (G4-16, mechanism M1). On the Windows bench host the 200 native load
 * clients share the host with the Docker VM that runs the cells. A captured
 * 100 ms stall froze the whole VM, so the clients may be competing with the
 * VM's vCPUs. The intervention moves ONLY the client processes: the gate, its
 * criteria, its failover (`docker pause`), its stats sampling and the capture
 * stay on the stack host.
 *
 * THE SPLIT. The gate already treats a load cohort as a child process: argv,
 * QA_* environment, stdout (QARESULT / QAPHASE / QACLOSE), stderr, one IPC
 * channel for the start barrier, an exit code. This module carries exactly
 * that interface over one TCP control connection:
 *
 *   gate (stack host)                       agent (load host)
 *   RemoteLoadServer.listen(lanIp:port)  <- runRemoteLoadAgent(connect)
 *   session.spawn(argv, env)             -> spawn qa/load-users.mjs
 *   RemoteChild 'data'/'message'/'close' <- stdout, stderr, IPC, exit
 *   RemoteChild.send / kill              -> child.send / child.kill
 *
 * so `startLoadProcess` keeps its parsing, evidence checks and barrier logic
 * byte for byte, and every criterion is computed by the same code from the
 * same per-user records. The only cross-host timestamp comparison in the gate
 * (a partition-zero write inside the takeover interval) is corrected by the
 * measured clock offset; see `writeOverlapsTakeover` in the gate.
 *
 * SECURITY. LAN only: both the control listener and the router's extra
 * publication bind to ONE explicit private or loopback IPv4 address, never
 * 0.0.0.0, and the operator adds a Windows firewall rule restricted to the LAN
 * subnet. A connection proves knowledge of a shared secret by HMAC
 * challenge-response in both directions; the secret itself never crosses the
 * wire and is never printed. The agent runs ONE fixed script with validated
 * flags and a fixed QA_* allow-list whose API/WS URLs must name the host it
 * connected to — an authenticated gate can start load clients, nothing else.
 *
 * WIRE FORMAT: newline-delimited JSON frames, each an object with a `type`.
 * Child output travels as base64 so a chunk reaches the gate as the same bytes
 * the child wrote, and is decoded there by the same `chunk.toString()`.
 */

import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const SERVER_DIR = resolve(here, '..')
export const REMOTE_LOAD_PROTOCOL = 'maplespire-remote-load/1'
export const REMOTE_LOAD_SECRET_ENV = 'SYNC_REMOTE_LOAD_SECRET'
/** The gate's own variables, set by `sync-cell-bench.mjs --load-remote=listen`. */
export const REMOTE_LOAD_ENV = Object.freeze({
  mode: 'SYNC_LOAD_REMOTE',
  bind: 'SYNC_LOAD_REMOTE_BIND',
  controlPort: 'SYNC_LOAD_REMOTE_CONTROL_PORT',
  routerPort: 'SYNC_LOAD_REMOTE_ROUTER_PORT',
  connectTimeoutMs: 'SYNC_LOAD_REMOTE_CONNECT_TIMEOUT_MS',
})
/** Offsets from the leg's router port. Each leg owns ten ports (`base..base+9`)
 * and uses four, so these two can never collide with another leg. */
export const REMOTE_LOAD_PORT_OFFSETS = Object.freeze({ routerLan: 5, control: 6 })
export const MAX_FRAME_CHARS = 8 * 1024 * 1024
export const PRE_AUTH_MAX_FRAME_CHARS = 64 * 1024
export const HANDSHAKE_TIMEOUT_MS = 10_000

/** The client code both hosts must run identically. CRLF is normalised: a
 * Windows checkout with autocrlf is the same source. */
export const LOAD_CLIENT_SOURCES = Object.freeze([
  'qa/load-users.mjs', 'qa/load-user-worker.mjs', 'qa/lib.mjs', 'qa/loadUserCohort.mjs',
  'qa/loadUserSnapshots.mjs', 'qa/loadUsersCore.mjs', 'qa/loadBarrier.mjs',
  'qa/authenticatedWebSocketAdapter.mjs', 'qa/loadUserEvidence.mjs',
  'scripts/sync-cell-remote-load-core.mjs',
])
export const LOAD_CLIENT_PACKAGES = Object.freeze([
  '@automerge/automerge', '@automerge/automerge-repo', '@automerge/automerge-repo-network-websocket', 'ws',
])
/** The QA_* variables a load cohort reads (qa/lib.mjs, qa/load-users.mjs). The
 * gate forwards exactly these; the agent accepts nothing else. QA_PG is not
 * here on purpose: the clients never reach the database. */
export const FORWARDED_CLIENT_ENV = Object.freeze([
  'QA_API', 'QA_WS', 'QA_LANDSCAPE_ID', 'QA_VERSION_ID', 'QA_SESSION_COOKIE',
  'QA_LOAD_OBJECT_PREFIX', 'QA_LOAD_BASELINE_BARRIER_ID', 'QA_LOAD_EPISODE_ID', 'QA_REQUIRE_TRANSPORT',
])
const INTEGER_FLAGS = new Set(['--users', '--userOffset', '--totalUsers', '--rounds', '--objects',
  '--settle', '--stagger', '--startDelay', '--writers'])
const KILL_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT'])
const hex64 = /^[a-f0-9]{64}$/

// ── Addresses, ports, secret ────────────────────────────────────────────────

/**
 * One explicit IPv4 address of THIS machine on the LAN, or loopback for a
 * single-host rehearsal. Never 0.0.0.0, never a public address: what is
 * published must be reachable from the local network only.
 */
export function assertLanAddress(raw, label = '--bind') {
  const text = String(raw ?? '').trim()
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  const octets = match ? match.slice(1).map(Number) : null
  if (!octets || octets.some((value, index) => value > 255 || String(value) !== match[index + 1])) {
    throw new Error(`${label} must be one IPv4 address of this machine on the LAN (e.g. 192.168.1.20), got ${JSON.stringify(text)}`)
  }
  const [a, b] = octets
  const loopback = a === 127
  const lan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  if (!loopback && !lan) {
    throw new Error(`${label} must be a private (10/8, 172.16/12, 192.168/16) or loopback IPv4 address; ${text} is not — never 0.0.0.0 or a public address`)
  }
  return text
}

export function remoteLoadPorts(routerPort) {
  const port = Number(routerPort)
  if (!Number.isSafeInteger(port) || port < 1 || port + REMOTE_LOAD_PORT_OFFSETS.control > 65_535) {
    throw new Error(`router port ${routerPort} leaves no room for the remote-load ports`)
  }
  return { routerLanPort: port + REMOTE_LOAD_PORT_OFFSETS.routerLan, controlPort: port + REMOTE_LOAD_PORT_OFFSETS.control }
}

/** The shared secret, validated without ever echoing it. */
export function readRemoteLoadSecret(env = process.env) {
  const secret = env[REMOTE_LOAD_SECRET_ENV]
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(`${REMOTE_LOAD_SECRET_ENV} is not set: generate one (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") and give the same value to both hosts`)
  }
  if (secret.length < 32 || secret.length > 1024 || /\s/.test(secret)) {
    throw new Error(`${REMOTE_LOAD_SECRET_ENV} must be 32 to 1024 non-space characters (its value is not printed)`)
  }
  return secret
}

export function proof(secret, role, first, second) {
  return createHmac('sha256', secret).update(`${REMOTE_LOAD_PROTOCOL}|${role}|${first}|${second}`).digest('hex')
}

export function proofMatches(expected, actual) {
  if (typeof actual !== 'string' || !hex64.test(actual) || !hex64.test(expected)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
}

const nonce = () => randomBytes(32).toString('hex')

// ── The bench side: flags, environment, compose overlay, exposure check ─────

/** `--load-remote=listen --bind=<lanIp>`, or null. Refusals are thrown. */
export function remoteLoadOptions(argv) {
  const value = (flag) => argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
  const mode = value('--load-remote')
  const bind = value('--bind')
  if (mode === undefined) {
    if (bind !== undefined) throw new Error('--bind is the remote-load listen address; it needs --load-remote=listen')
    return null
  }
  if (mode !== 'listen') throw new Error('--load-remote must be listen (the load agent connects to this host)')
  if (bind === undefined) throw new Error('--load-remote=listen needs --bind=<this host\'s LAN IPv4 address>')
  return { mode: 'listen', bind: assertLanAddress(bind) }
}

/**
 * The gate's environment for this arm. Without the arm it is EMPTY unless the
 * operator's shell already carries one of the names — then those are blanked,
 * so an inherited value cannot move the clients of a run that did not ask.
 */
export function remoteLoadEnvironment(options, routerPort, inherited = process.env) {
  if (!options) {
    return Object.fromEntries(Object.values(REMOTE_LOAD_ENV)
      .filter((name) => name !== REMOTE_LOAD_ENV.connectTimeoutMs && Object.hasOwn(inherited, name))
      .map((name) => [name, '']))
  }
  const ports = remoteLoadPorts(routerPort)
  return {
    [REMOTE_LOAD_ENV.mode]: 'listen',
    [REMOTE_LOAD_ENV.bind]: options.bind,
    [REMOTE_LOAD_ENV.controlPort]: String(ports.controlPort),
    [REMOTE_LOAD_ENV.routerPort]: String(ports.routerLanPort),
  }
}

/** The ONE extra publication: the router, on the LAN address, on its own port.
 * Written to a temporary file per run, never to the tree (it is not a
 * deployment manifest), and passed as a second `-f`. */
export function remoteLoadComposeOverlay(bind, routerLanPort) {
  return [
    '# Generated by sync-cell-bench.mjs --load-remote=listen for one run, then deleted.',
    '# The router is the only service the remote load clients reach (HTTP and /automerge).',
    'services:',
    '  router:',
    '    ports:',
    `      - "${assertLanAddress(bind)}:${Number(routerLanPort)}:8080"`,
    '',
  ].join('\n')
}

/**
 * The resolved compose file publishes the LAN port on the router ONLY, and
 * nothing on a wildcard address. Run against `docker compose config` output,
 * so it checks what the daemon will do, overlay included.
 */
export function assertRemoteLoadExposure(config, bind, routerLanPort) {
  const published = []
  for (const [service, definition] of Object.entries(config?.services ?? {})) {
    for (const port of definition?.ports ?? []) {
      const hostIp = typeof port === 'object' ? String(port.host_ip ?? '') : ''
      if (typeof port !== 'object') throw new Error(`${service} publishes ${JSON.stringify(port)} in a form this check cannot read`)
      published.push({ service, hostIp, published: String(port.published ?? ''), target: Number(port.target) })
    }
  }
  const wildcard = published.filter((entry) => ['', '0.0.0.0', '::', '[::]'].includes(entry.hostIp))
  if (wildcard.length) {
    throw new Error(`remote load refuses a wildcard publication: ${wildcard.map((entry) => `${entry.service}:${entry.published}`).join(', ')}`)
  }
  const lan = published.filter((entry) => entry.published === String(routerLanPort))
  if (lan.length !== 1 || lan[0].service !== 'router' || lan[0].target !== 8080 || lan[0].hostIp !== bind) {
    throw new Error(`the router must publish exactly ${bind}:${routerLanPort}->8080 for the remote load clients; resolved ${JSON.stringify(lan)}`)
  }
  if (!bind.startsWith('127.')) {
    const others = published.filter((entry) => entry.hostIp === bind && entry !== lan[0])
    if (others.length) {
      throw new Error(`only the router may listen on ${bind}; also published there: ${others.map((entry) => `${entry.service}:${entry.published}`).join(', ')}`)
    }
  }
  return lan[0]
}

/** The rule the OPERATOR runs once on the Windows stack host (the bench never
 * changes the firewall). /24 is the LAN the address sits in. */
export function firewallRuleCommand(bind, ports) {
  const subnet = `${bind.split('.').slice(0, 3).join('.')}.0/24`
  return `New-NetFirewallRule -DisplayName "MapleSpire remote load (LAN only)" -Direction Inbound -Action Allow`
    + ` -Protocol TCP -LocalAddress ${bind} -LocalPort ${ports.routerLanPort},${ports.controlPort}`
    + ` -RemoteAddress ${subnet} -Profile Private`
}

/** The suffix of the bench's one-line run description; empty without the arm. */
export function describeRemoteLoad(options, ports) {
  if (!options) return ''
  return ` · load remote listen ${options.bind}:${ports.controlPort} router-lan ${options.bind}:${ports.routerLanPort}`
}

// ── Client identity ─────────────────────────────────────────────────────────

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export function loadClientIdentity(serverDir = SERVER_DIR) {
  const sources = Object.fromEntries(LOAD_CLIENT_SOURCES.map((name) => [name,
    sha256(readFileSync(resolve(serverDir, name), 'utf8').replace(/\r\n/g, '\n'))]))
  const packages = Object.fromEntries(LOAD_CLIENT_PACKAGES.map((name) => {
    const file = resolve(serverDir, 'node_modules', name, 'package.json')
    return [name, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version ?? null : null]
  }))
  return { sources, packages }
}

/** Names whose content or version differ; empty when the two hosts agree. */
export function identityDifferences(expected, actual) {
  const differences = []
  for (const section of ['sources', 'packages']) {
    const names = new Set([...Object.keys(expected?.[section] ?? {}), ...Object.keys(actual?.[section] ?? {})])
    for (const name of [...names].sort()) {
      if (expected?.[section]?.[name] !== actual?.[section]?.[name]) differences.push(`${section}:${name}`)
    }
  }
  return differences
}

function hostDescription() {
  return { hostname: os.hostname(), platform: process.platform, release: os.release(), arch: process.arch,
    cpus: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version, pid: process.pid }
}

// ── Framing ─────────────────────────────────────────────────────────────────

export function encodeFrame(frame) {
  return `${JSON.stringify(frame)}\n`
}

/** Splits a byte stream into frames. Throws on an oversized or malformed
 * frame; the caller closes the connection. */
export function createFrameReader(onFrame, { maxChars = MAX_FRAME_CHARS } = {}) {
  const decoder = new StringDecoder('utf8')
  let buffered = ''
  let limit = maxChars
  return {
    setLimit(value) { limit = value },
    push(chunk) {
      buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      let index
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index)
        buffered = buffered.slice(index + 1)
        if (line.length > limit) throw new Error('frame too large')
        if (!line.trim()) continue
        let frame
        try { frame = JSON.parse(line) } catch { throw new Error('frame is not JSON') }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.type !== 'string') {
          throw new Error('frame has no type')
        }
        onFrame(frame)
      }
      if (buffered.length > limit) throw new Error('frame too large')
    },
  }
}

// ── Clock ───────────────────────────────────────────────────────────────────

/**
 * NTP-style estimate from one burst of pings: offset = agent clock minus gate
 * clock at the sample with the smallest round trip. The true offset lies
 * within ± (rtt / 2 + 1 ms) of it (1 ms for Date.now() quantisation on each
 * side). An agent timestamp reads on the gate's clock as `t - offsetMs`.
 */
export function estimateClock(samples) {
  const valid = samples.filter((sample) => Number.isFinite(sample?.rttMs) && sample.rttMs >= 0 && Number.isFinite(sample.offsetMs))
  if (!valid.length) return null
  const best = valid.reduce((left, right) => (right.rttMs < left.rttMs ? right : left))
  return {
    offsetMs: Math.round(best.offsetMs * 10) / 10,
    uncertaintyMs: Math.round((best.rttMs / 2 + 1) * 10) / 10,
    rttMs: best.rttMs,
    samples: valid.length,
    measuredAt: best.gateAt,
  }
}

// ── Agent side: spawn validation ────────────────────────────────────────────

/**
 * What the agent will run for one spawn frame, or a thrown refusal. Only the
 * fixed client script, only its known flags with bounded values, only the
 * QA_* allow-list, and the API/WS URLs must be the router the agent was told
 * at welcome (itself the host the agent connected to).
 */
export function validateSpawnRequest(frame, router) {
  if (!Number.isSafeInteger(frame?.id) || frame.id <= 0) throw new Error('spawn id must be a positive integer')
  const args = frame.args
  if (!Array.isArray(args) || args.length % 2 !== 0 || args.length > 40) throw new Error('spawn args must be flag/value pairs')
  const seen = new Set()
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]]
    if (typeof flag !== 'string' || typeof value !== 'string') throw new Error('spawn args must be strings')
    if (seen.has(flag)) throw new Error(`spawn flag ${flag} is repeated`)
    seen.add(flag)
    if (INTEGER_FLAGS.has(flag)) {
      if (!/^(0|[1-9][0-9]{0,8})$/.test(value)) throw new Error(`spawn flag ${flag} needs a non-negative integer`)
    } else if (flag === '--root') {
      if (!/^automerge:[A-Za-z0-9]{1,128}$/.test(value)) throw new Error('spawn --root must be an automerge URL')
    } else if (flag === '--objectAssignment') {
      if (!['shared', 'per-writer'].includes(value)) throw new Error('spawn --objectAssignment must be shared or per-writer')
    } else if (flag === '--writerActors') {
      // D61: `startLoadProcess` passes the profile's writer-actor mode to every cohort.
      if (!['fresh', 'persistent'].includes(value)) throw new Error('spawn --writerActors must be fresh or persistent')
    } else {
      throw new Error(`spawn flag ${JSON.stringify(flag).slice(0, 40)} is not a load-users flag`)
    }
  }
  if (!seen.has('--root')) throw new Error('spawn needs --root')
  const env = frame.env
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('spawn env must be an object')
  for (const [name, value] of Object.entries(env)) {
    if (!FORWARDED_CLIENT_ENV.includes(name)) throw new Error(`spawn env ${JSON.stringify(name).slice(0, 60)} is not a load client variable`)
    if (typeof value !== 'string' || value.length > 16 * 1024 || value.includes('\0')) throw new Error(`spawn env ${name} must be a short string`)
  }
  const api = `http://${router.host}:${router.port}`
  if (env.QA_API !== api || env.QA_WS !== `${api.replace(/^http/, 'ws')}/automerge`) {
    throw new Error(`spawn QA_API/QA_WS must be the router this agent was connected to (${api})`)
  }
  return { id: frame.id, args: [...args], env: { ...env }, ipc: frame.ipc === true }
}

// ── Gate side ───────────────────────────────────────────────────────────────

class RemoteStream extends EventEmitter {
  destroy() { this.removeAllListeners('data') }
}

/**
 * A cohort process on the load host, shaped like the `ChildProcess` subset
 * `startLoadProcess` and `runLoadPair` use: `pid`, `stdout`/`stderr` 'data',
 * `connected`, `send(message, callback)`, `kill(signal)`, `exitCode`,
 * `signalCode`, and the 'message' / 'disconnect' / 'exit' / 'close' / 'error'
 * events in the order Node emits them. Every event is emitted synchronously
 * from the frame that carries it, so stdout always precedes 'close'.
 */
export class RemoteChild extends EventEmitter {
  constructor(session, id, ipc) {
    super()
    this.id = id
    this.pid = undefined
    this.stdout = new RemoteStream()
    this.stderr = new RemoteStream()
    this.connected = ipc
    this.exitCode = null
    this.signalCode = null
    this.killed = false
    this.remoteLost = false
    this.closed = false
    this.session = session
    this.sendSeq = 0
    this.sendCallbacks = new Map()
    this.errors = []
  }

  /** The stamp `startLoadProcess` adds to `childProcess`: which host and
   * clock produced this result's timestamps. */
  remoteLoad() {
    const clock = this.session.currentClock()
    return {
      sessionId: this.session.sessionId,
      agentHost: this.session.agent?.host?.hostname ?? null,
      pid: this.pid ?? null,
      clockOffsetMs: clock?.offsetMs ?? null,
      clockUncertaintyMs: clock?.uncertaintyMs ?? null,
      clockMeasuredAt: clock?.measuredAt ?? null,
    }
  }

  send(message, callback) {
    if (!this.connected) {
      const error = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' })
      if (typeof callback === 'function') process.nextTick(callback, error)
      else process.nextTick(() => this.emitError(error))
      return false
    }
    const seq = ++this.sendSeq
    if (typeof callback === 'function') this.sendCallbacks.set(seq, callback)
    this.session.write({ type: 'send', id: this.id, seq, message })
    return true
  }

  kill(signal = 'SIGTERM') {
    if (this.closed || this.exitCode !== null || this.signalCode !== null || this.remoteLost) return false
    this.killed = true
    this.session.write({ type: 'kill', id: this.id, signal: KILL_SIGNALS.has(signal) ? signal : 'SIGTERM' })
    return true
  }

  emitError(error) {
    this.errors.push(error.message)
    if (this.listenerCount('error') > 0) this.emit('error', error)
  }

  handle(frame) {
    switch (frame.type) {
      case 'spawned': this.pid = Number.isSafeInteger(frame.pid) ? frame.pid : undefined; break
      case 'stdout': this.stdout.emit('data', Buffer.from(String(frame.data ?? ''), 'base64')); break
      case 'stderr': this.stderr.emit('data', Buffer.from(String(frame.data ?? ''), 'base64')); break
      case 'message': this.emit('message', frame.message); break
      case 'sent': {
        const callback = this.sendCallbacks.get(frame.seq)
        this.sendCallbacks.delete(frame.seq)
        callback?.(frame.error ? new Error(String(frame.error)) : null)
        break
      }
      case 'disconnect': this.markDisconnected(); break
      case 'exit':
        this.exitCode = frame.code ?? null
        this.signalCode = frame.signal ?? null
        this.emit('exit', this.exitCode, this.signalCode)
        break
      case 'close':
        if (this.exitCode === null && this.signalCode === null) {
          this.exitCode = frame.code ?? null
          this.signalCode = frame.signal ?? null
        }
        this.finish(this.exitCode, this.signalCode)
        break
      case 'child-error': this.emitError(new Error(`remote load agent: ${String(frame.message ?? 'spawn failed')}`)); break
      default: break
    }
  }

  markDisconnected() {
    if (!this.connected) return
    this.connected = false
    for (const callback of this.sendCallbacks.values()) callback(new Error('Channel closed'))
    this.sendCallbacks.clear()
    this.emit('disconnect')
  }

  finish(code, signal) {
    if (this.closed) return
    this.closed = true
    this.markDisconnected()
    this.session.children.delete(this.id)
    this.emit('close', code, signal)
  }

  /** The control connection is gone: the agent kills its children itself. */
  lose(error) {
    if (this.closed) return
    this.remoteLost = true
    this.stderr.emit('data', Buffer.from(`\n[remote load] ${error.message}\n`))
    this.markDisconnected()
    this.emitError(error)
    this.finish(null, null)
  }
}

class RemoteLoadSession {
  constructor({ socket, reader, agent, sessionId, router, log, clockIntervalMs }) {
    this.socket = socket
    this.reader = reader
    this.agent = agent
    this.sessionId = sessionId
    this.router = router
    this.log = log
    this.children = new Map()
    this.nextId = 1
    this.spawned = 0
    this.pings = new Map()
    this.pingSeq = 0
    this.clockBursts = []
    this.routerProbe = null
    this.pendingProbe = null
    this.closed = false
    this.lostError = null
    this.byeAck = null
    this.startedAt = Date.now()
    this.endedAt = null
    this.clockIntervalMs = clockIntervalMs
    this.clockTimer = null
  }

  write(frame) {
    if (this.closed || this.socket.destroyed) return false
    this.socket.write(encodeFrame(frame))
    return true
  }

  handle(frame) {
    if (frame.type === 'pong') {
      const pending = this.pings.get(frame.seq)
      if (pending) {
        this.pings.delete(frame.seq)
        const gateReceivedAt = Date.now()
        pending.resolve({ gateAt: pending.sentAt, rttMs: gateReceivedAt - pending.sentAt,
          offsetMs: Number(frame.agentAt) - (pending.sentAt + gateReceivedAt) / 2 })
      }
      return
    }
    if (frame.type === 'router-probe') { this.pendingProbe?.(frame); this.pendingProbe = null; return }
    if (frame.type === 'bye-ack') { this.byeAck?.(); return }
    if (frame.type === 'agent-log') { this.log(`[remote load agent] ${String(frame.message ?? '').slice(0, 2000)}`); return }
    const child = this.children.get(frame.id)
    if (child) child.handle(frame)
  }

  /** Same argv (without the script path, which the agent supplies from its own
   * checkout) and the QA_* allow-list, with the API/WS URLs pointing at the
   * router's LAN publication instead of loopback. */
  spawn(args, env, { ipc = false } = {}) {
    if (this.closed) throw this.lostError ?? new Error('remote load session is closed')
    const id = this.nextId++
    const child = new RemoteChild(this, id, ipc)
    this.children.set(id, child)
    this.spawned += 1
    const api = `http://${this.router.host}:${this.router.port}`
    const forwarded = Object.fromEntries(FORWARDED_CLIENT_ENV.filter((name) => typeof env[name] === 'string').map((name) => [name, env[name]]))
    forwarded.QA_API = api
    forwarded.QA_WS = `ws://${this.router.host}:${this.router.port}/automerge`
    this.write({ type: 'spawn', id, args: args.map(String), env: forwarded, ipc })
    return child
  }

  ping(timeoutMs = 5_000) {
    const seq = ++this.pingSeq
    return new Promise((resolvePing, reject) => {
      const sentAt = Date.now()
      const timer = setTimeout(() => { this.pings.delete(seq); reject(new Error('remote load clock ping timed out')) }, timeoutMs)
      this.pings.set(seq, { sentAt, resolve: (sample) => { clearTimeout(timer); resolvePing(sample) } })
      if (!this.write({ type: 'ping', seq })) { clearTimeout(timer); this.pings.delete(seq); reject(new Error('remote load session is closed')) }
    })
  }

  async measureClock(count = 8, label = 'periodic') {
    const samples = []
    for (let index = 0; index < count; index += 1) samples.push(await this.ping())
    const estimate = estimateClock(samples)
    if (estimate) {
      this.clockBursts.push({ label, ...estimate })
      if (this.clockBursts.length > 1_000) this.clockBursts.splice(1, 1)
    }
    return estimate
  }

  currentClock() {
    return this.clockBursts.at(-1) ?? null
  }

  probeRouter(timeoutMs = 15_000) {
    return new Promise((resolveProbe, reject) => {
      const timer = setTimeout(() => { this.pendingProbe = null; reject(new Error('the load agent did not report its router probe')) }, timeoutMs)
      this.pendingProbe = (frame) => { clearTimeout(timer); this.routerProbe = frame; resolveProbe(frame) }
      this.write({ type: 'probe-router' })
    })
  }

  startClockSampling() {
    if (!this.clockIntervalMs) return
    this.clockTimer = setInterval(() => {
      this.measureClock(4).catch(() => {})
    }, this.clockIntervalMs)
    this.clockTimer.unref()
  }

  lose(error) {
    if (this.closed) return
    this.closed = true
    this.lostError = error
    this.endedAt = Date.now()
    clearInterval(this.clockTimer)
    for (const pending of this.pings.values()) pending.resolve({ gateAt: pending.sentAt, rttMs: Number.NaN, offsetMs: Number.NaN })
    this.pings.clear()
    for (const child of [...this.children.values()]) child.lose(error)
  }

  /** Orderly end: the agent stops whatever still runs and acknowledges. */
  async close(reason = 'run finished', timeoutMs = 15_000) {
    if (this.closed) return
    clearInterval(this.clockTimer)
    try { await this.measureClock(8, 'final') } catch { /* the evidence says the session was lost */ }
    if (this.closed) return
    await new Promise((resolveBye) => {
      const timer = setTimeout(resolveBye, timeoutMs)
      this.byeAck = () => { clearTimeout(timer); resolveBye() }
      this.write({ type: 'bye', reason })
    })
    this.lose(new Error('remote load session closed by the gate'))
    this.lostError = null
    this.socket.end()
    this.socket.destroySoon?.()
  }

  evidence() {
    const offsets = this.clockBursts.map((entry) => entry.offsetMs)
    return {
      protocol: REMOTE_LOAD_PROTOCOL,
      sessionId: this.sessionId,
      router: this.router,
      agent: this.agent,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      lost: this.lostError ? this.lostError.message : null,
      spawned: this.spawned,
      routerProbe: this.routerProbe,
      clock: {
        definition: 'offsetMs = agent clock - gate clock at the minimum-RTT ping of a burst; true offset within +/- uncertaintyMs',
        initial: this.clockBursts[0] ?? null,
        final: this.clockBursts.find((entry) => entry.label === 'final') ?? null,
        minOffsetMs: offsets.length ? Math.min(...offsets) : null,
        maxOffsetMs: offsets.length ? Math.max(...offsets) : null,
        maxUncertaintyMs: this.clockBursts.length ? Math.max(...this.clockBursts.map((entry) => entry.uncertaintyMs)) : null,
        bursts: this.clockBursts,
      },
    }
  }
}

/**
 * The gate's listener. One authenticated agent session at a time; every other
 * connection is refused and closed. `waitForAgent` resolves once an agent has
 * authenticated, runs the same client code, reached the router's LAN port, and
 * its clock offset is measured.
 */
export async function startRemoteLoadServer({ bind, port, secret, router, expectedIdentity = loadClientIdentity(),
  log = (line) => process.stderr.write(`${line}\n`), clockIntervalMs = 60_000 }) {
  assertLanAddress(bind, 'remote load bind')
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('remote load server needs the shared secret')
  let session = null
  let waiter = null
  let fatal = null
  const preAuth = new Set()
  const settleWaiter = (error, value) => {
    if (!waiter) return
    const current = waiter
    waiter = null
    if (error) current.reject(error)
    else current.resolve(value)
  }
  const server = createServer((socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`
    if (session || fatal || preAuth.size >= 4) {
      const reason = session?.closed ? 'this run\'s agent session has ended' : session ? 'busy: another agent is connected' : 'not accepting'
      socket.end(encodeFrame({ type: 'refused', reason }))
      setTimeout(() => socket.destroy(), 1_000).unref()
      log(`[remote load] refused ${peer}: ${reason}`)
      return
    }
    preAuth.add(socket)
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 10_000)
    const serverNonce = nonce()
    let established = null
    const refuse = (reason, publicReason = reason) => {
      preAuth.delete(socket)
      log(`[remote load] refused ${peer}: ${reason}`)
      if (!socket.destroyed) socket.end(encodeFrame({ type: 'refused', reason: publicReason }))
      setTimeout(() => socket.destroy(), 1_000).unref()
    }
    const timer = setTimeout(() => { if (!established) refuse('handshake timed out') }, HANDSHAKE_TIMEOUT_MS)
    const reader = createFrameReader((frame) => {
      if (established) { established.handle(frame); return }
      clearTimeout(timer)
      if (frame.type !== 'auth' || frame.protocol !== REMOTE_LOAD_PROTOCOL || typeof frame.clientNonce !== 'string' || !hex64.test(frame.clientNonce)) {
        refuse('malformed handshake', 'protocol error')
        return
      }
      if (!proofMatches(proof(secret, 'client', serverNonce, frame.clientNonce), frame.proof)) {
        refuse('authentication failed')
        return
      }
      const differences = identityDifferences(expectedIdentity, frame.identity)
      if (differences.length) {
        refuse(`the agent runs different load-client code: ${differences.join(', ')}`,
          `different load-client code: ${differences.join(', ')}`)
        fatal = new Error(`the remote load agent runs different load-client code than this gate: ${differences.join(', ')}; check out the same commit and run npm ci on the load host`)
        settleWaiter(fatal)
        return
      }
      preAuth.delete(socket)
      reader.setLimit(MAX_FRAME_CHARS)
      const sessionId = randomUUID()
      established = new RemoteLoadSession({ socket, reader, sessionId, router, log, clockIntervalMs,
        agent: { address: socket.remoteAddress, host: frame.host ?? null, identity: frame.identity } })
      session = established
      socket.write(encodeFrame({ type: 'welcome', proof: proof(secret, 'server', frame.clientNonce, serverNonce), sessionId, router }))
      log(`[remote load] agent ${frame.host?.hostname ?? '?'} (${socket.remoteAddress}) authenticated, session ${sessionId}`)
      settleWaiter(null, established)
    }, { maxChars: PRE_AUTH_MAX_FRAME_CHARS })
    socket.on('data', (chunk) => {
      try { reader.push(chunk) } catch (error) {
        if (established) {
          established.lose(new Error(`remote load protocol error: ${error.message}`))
          socket.destroy()
        } else refuse(error.message, 'protocol error')
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(timer)
      preAuth.delete(socket)
      if (established) {
        established.lose(new Error('remote load agent connection lost'))
        if (session === established) {
          if (established.lostError) log(`[remote load] session ${established.sessionId} lost: ${established.lostError.message}`)
        }
      }
    })
    socket.write(encodeFrame({ type: 'hello', protocol: REMOTE_LOAD_PROTOCOL, serverNonce }))
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen({ host: bind, port, exclusive: true }, () => { server.off('error', reject); resolveListen() })
  })
  const address = server.address()
  log(`[remote load] listening on ${address.address}:${address.port}; the load clients will use http://${router.host}:${router.port}`)
  return {
    address,
    get session() { return session },
    async waitForAgent(timeoutMs) {
      if (fatal) throw fatal
      let established = session
      if (!established) {
        established = await new Promise((resolveWait, reject) => {
          const timer = setTimeout(() => settleWaiter(new Error(`no remote load agent authenticated within ${timeoutMs} ms`)), timeoutMs)
          waiter = { resolve: (value) => { clearTimeout(timer); resolveWait(value) }, reject: (error) => { clearTimeout(timer); reject(error) } }
        })
      }
      const probe = await established.probeRouter()
      if (!probe.ok) {
        throw new Error(`the load host cannot reach the router at http://${router.host}:${router.port} (${probe.error ?? `HTTP ${probe.status}`}): check the firewall rule and --bind`)
      }
      await established.measureClock(16, 'initial')
      established.startClockSampling()
      return established
    },
    /** Synchronous teardown for the abandonment path: the agent kills its
     * children when the connection drops. */
    destroy() {
      fatal ??= new Error('remote load server destroyed')
      for (const socket of preAuth) socket.destroy()
      if (session) { session.lose(new Error('remote load server destroyed')); session.socket.destroy() }
      server.close()
    },
    async close(reason) {
      fatal ??= new Error('remote load server closed')
      settleWaiter(fatal)
      for (const socket of preAuth) socket.destroy()
      if (session) await session.close(reason)
      await new Promise((resolveClose) => server.close(() => resolveClose()))
      return session ? session.evidence() : null
    },
  }
}

// ── Agent side ──────────────────────────────────────────────────────────────

/**
 * One agent session: connect, authenticate both ways, then run what the gate
 * asks until it says bye or the connection drops. Resolves
 * `{ clean, refused, reason }`. Children never outlive the session.
 */
export function runRemoteLoadSession({ host, port, secret, serverDir = SERVER_DIR, log = () => {},
  spawnImpl = spawn, identity = loadClientIdentity(serverDir), handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS }) {
  const loadUsersScript = resolve(serverDir, 'qa/load-users.mjs')
  return new Promise((resolveSession) => {
    const socket = connect({ host, port })
    const clientNonce = nonce()
    const children = new Map()
    let serverNonce = null
    let state = 'hello'
    let router = null
    let outcome = null
    const write = (frame) => { if (!socket.destroyed) socket.write(encodeFrame(frame)) }
    const finish = (value) => {
      outcome ??= value
      socket.destroy()
    }
    const killAll = (signal) => {
      for (const child of children.values()) {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal)
      }
    }
    // The gate writes its hello the moment it accepts a connection, so no hello
    // within the handshake window means the gate has not (yet) answered: the
    // TCP connect never completed, something other than the gate accepted it,
    // or — rarely — a hello in flight or in fragments had not been parsed when
    // the timer fired. Retrying is right in every one of these cases, so this is
    // a connect error the agent retries (also under --once, bounded by
    // --wait-ms). Observed on the Windows bench host on 2026-11-06 (G4-17
    // passes 2 and 3, docs/plan-cellulaire/mesures/G4-17-native-x3.json): a
    // --once agent started during the bench's boot left on this timeout, and a
    // watcher outside the agent had to relaunch it up to four times before the
    // listener answered. WHICH case that was is not known: the reason was then
    // always 'handshake timed out'; it now tells the first two apart. A timeout
    // AFTER the hello is a gate that started the handshake and stopped: a
    // failed session, as before.
    let tcpConnected = false
    socket.once('connect', () => { tcpConnected = true })
    const handshakeTimer = setTimeout(() => finish(state === 'hello'
      ? { clean: false, refused: false, connectError: true,
          reason: tcpConnected ? 'connected, but no hello from the listener' : 'connect timed out' }
      : { clean: false, refused: false, reason: 'handshake timed out' }), handshakeTimeoutMs)
    const reader = createFrameReader((frame) => {
      if (frame.type === 'refused') {
        finish({ clean: false, refused: true, reason: String(frame.reason ?? 'refused') })
        return
      }
      if (state === 'hello') {
        if (frame.type !== 'hello' || frame.protocol !== REMOTE_LOAD_PROTOCOL || !hex64.test(String(frame.serverNonce))) {
          finish({ clean: false, refused: false, reason: 'the listener does not speak this protocol' })
          return
        }
        state = 'welcome'
        serverNonce = frame.serverNonce
        write({ type: 'auth', protocol: REMOTE_LOAD_PROTOCOL, clientNonce, proof: proof(secret, 'client', serverNonce, clientNonce),
          host: hostDescription(), identity })
        return
      }
      if (state === 'welcome') {
        clearTimeout(handshakeTimer)
        if (frame.type !== 'welcome' || !proofMatches(proof(secret, 'server', clientNonce, serverNonce), frame.proof)) {
          finish({ clean: false, refused: false, reason: 'the listener did not prove the shared secret' })
          return
        }
        if (frame.router?.host !== host || !Number.isSafeInteger(frame.router?.port)) {
          finish({ clean: false, refused: false, reason: `the gate asked for load on ${frame.router?.host}, not the host this agent connected to (${host})` })
          return
        }
        router = frame.router
        state = 'session'
        reader.setLimit(MAX_FRAME_CHARS)
        log(`connected to ${host}:${port}, session ${frame.sessionId}; load clients will use http://${router.host}:${router.port}`)
        return
      }
      handleSessionFrame(frame)
    }, { maxChars: PRE_AUTH_MAX_FRAME_CHARS })

    const handleSessionFrame = (frame) => {
      switch (frame.type) {
        case 'ping': write({ type: 'pong', seq: frame.seq, agentAt: Date.now() }); return
        case 'probe-router': {
          const startedAt = Date.now()
          fetch(`http://${router.host}:${router.port}/api/ready`, { signal: AbortSignal.timeout(5_000) })
            .then(async (response) => {
              await response.body?.cancel().catch(() => undefined)
              write({ type: 'router-probe', ok: response.ok, status: response.status, ms: Date.now() - startedAt })
            })
            .catch((error) => write({ type: 'router-probe', ok: false, status: null, error: error.cause?.code ?? error.message, ms: Date.now() - startedAt }))
          return
        }
        case 'spawn': {
          let request
          try { request = validateSpawnRequest(frame, router) } catch (error) {
            log(`refused a spawn: ${error.message}`)
            write({ type: 'child-error', id: frame.id, message: `refused: ${error.message}` })
            write({ type: 'close', id: frame.id, code: null, signal: null })
            return
          }
          if (children.has(request.id)) {
            write({ type: 'child-error', id: request.id, message: 'refused: duplicate spawn id' })
            return
          }
          const env = Object.fromEntries(Object.entries(process.env)
            .filter(([name]) => name !== REMOTE_LOAD_SECRET_ENV && !name.startsWith('QA_')))
          const child = spawnImpl(process.execPath, [loadUsersScript, ...request.args], {
            cwd: serverDir, env: { ...env, ...request.env }, shell: false, windowsHide: true,
            stdio: request.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
          })
          children.set(request.id, child)
          write({ type: 'spawned', id: request.id, pid: child.pid ?? null })
          child.stdout?.on('data', (chunk) => write({ type: 'stdout', id: request.id, data: Buffer.from(chunk).toString('base64') }))
          child.stderr?.on('data', (chunk) => write({ type: 'stderr', id: request.id, data: Buffer.from(chunk).toString('base64') }))
          child.on('message', (message) => write({ type: 'message', id: request.id, message }))
          child.on('disconnect', () => write({ type: 'disconnect', id: request.id }))
          child.on('error', (error) => write({ type: 'child-error', id: request.id, message: error.message }))
          child.on('exit', (code, signal) => write({ type: 'exit', id: request.id, code, signal }))
          child.on('close', (code, signal) => {
            children.delete(request.id)
            write({ type: 'close', id: request.id, code, signal })
            if (state === 'closing' && children.size === 0) byeDone?.()
          })
          return
        }
        case 'send': {
          const child = children.get(frame.id)
          const reply = (error) => write({ type: 'sent', id: frame.id, seq: frame.seq, error: error ? error.message : null })
          if (!child || !child.connected) { reply(new Error('Channel closed')); return }
          try { child.send(frame.message, reply) } catch (error) { reply(error) }
          return
        }
        case 'kill': {
          const child = children.get(frame.id)
          if (child && child.exitCode === null && child.signalCode === null) child.kill(KILL_SIGNALS.has(frame.signal) ? frame.signal : 'SIGTERM')
          return
        }
        case 'bye': {
          state = 'closing'
          log(`the gate ended the session: ${String(frame.reason ?? '').slice(0, 200)}`)
          const done = () => { write({ type: 'bye-ack' }); outcome ??= { clean: true, refused: false, reason: 'the gate ended the session' }; socket.end() }
          if (children.size === 0) { done(); return }
          killAll('SIGTERM')
          const force = setTimeout(() => killAll('SIGKILL'), 5_000)
          const giveUp = setTimeout(() => { byeDone = null; done() }, 10_000)
          byeDone = () => { clearTimeout(force); clearTimeout(giveUp); byeDone = null; done() }
          return
        }
        default: return
      }
    }
    let byeDone = null
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 10_000)
    socket.on('data', (chunk) => {
      try { reader.push(chunk) } catch (error) { finish({ clean: false, refused: false, reason: `protocol error: ${error.message}` }) }
    })
    socket.on('error', (error) => { outcome ??= { clean: false, refused: false, reason: error.code ?? error.message, connectError: state === 'hello' } })
    socket.on('close', () => {
      clearTimeout(handshakeTimer)
      const result = outcome ?? { clean: false, refused: false, reason: 'connection closed' }
      if (children.size === 0) { resolveSession(result); return }
      // A dropped gate must not leave 200 clients connected to the stack, and
      // the agent does not return before its children are gone.
      log(`stopping ${children.size} load cohort(s): ${result.reason}`)
      killAll('SIGTERM')
      const forced = setTimeout(() => killAll('SIGKILL'), 5_000)
      const giveUp = setTimeout(() => { clearInterval(poll); clearTimeout(forced); resolveSession({ ...result, orphaned: children.size }) }, 15_000)
      const poll = setInterval(() => {
        if (children.size > 0) return
        clearInterval(poll); clearTimeout(forced); clearTimeout(giveUp)
        resolveSession(result)
      }, 100)
    })
  })
}
