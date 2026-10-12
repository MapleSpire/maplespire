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

/** Redis-pause observation instrument, also importable by the pause gate. Importing this
 * module does no work. startObservation is PASSIVE: its caller owns the only
 * pause/unpause. The standalone CLI keeps its default durations and internal
 * router probe. Neither mode blocks the sampler with a Docker command.
 * --router-ready-url http://127.0.0.1:<port>/api/ready reads a task-local router
 * port every tick. Without it the legacy docker-exec witness runs about once
 * per second (five ticks at the default 200 ms). --sample-ms is per collector;
 * --engine-host selects a local Engine pause/unpause transport explicitly.
 * No deployed port or Redis timeout is changed by these options. */
import { execFile, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { summarizeRedisPauseObservation } from './sync-cell-redis-pause-summary.mjs'
import { createLocalDockerPauseTransport, localDockerEngineEndpoint } from './sync-cell-redis-pause-engine.mjs'
import { analyzeRedisPauseBaseline, analyzeRedisPauseClock, classifyLeaseInterval } from './sync-cell-redis-pause-clock.mjs'
import { startRedisFreezeWitness, analyzeRedisFreezeWitness } from './sync-cell-redis-pause-witness.mjs'

const PERIOD_MS = 200
const ROUTER_PERIOD_MS = 1_000
const TCP_PROBE_AT_MS = 5_000
const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms))
const failure = (error) => ({ error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message ?? error) })

export function validateRouterReadinessUrl(value) {
  if (value === null || value === undefined) return null
  let url
  try { url = new URL(value) } catch { throw new Error('router readiness URL must be an absolute loopback HTTP URL') }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/api/ready' || url.search || url.hash) {
    throw new Error('router readiness URL must be loopback HTTP /api/ready without credentials, query or fragment')
  }
  return url.href
}

export function observationOptions(argv = [], env = process.env) {
  const arg = (name, fallback) => {
    const index = argv.indexOf(name)
    if (index < 0) return fallback
    const value = argv[index + 1]
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(`${name} requires a value`)
    return value
  }
  const duration = (name, fallback, min, max) => {
    const value = Number(arg(name, String(fallback)))
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max} ms`)
    return value
  }
  const project = env.SYNC_FAILOVER_PROJECT || 'maplespire-sync-failover'
  const label = arg('--label', 'baseline')
  const engineHost = arg('--engine-host', null)
  if (engineHost !== null) localDockerEngineEndpoint(engineHost)
  const clockCalibration = argv.includes('--clock-calibration')
  if (clockCalibration && !engineHost) throw new Error('--clock-calibration requires --engine-host')
  const redisWitnessNetwork = arg('--redis-witness-network', null)
  if (redisWitnessNetwork !== null && (!clockCalibration
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(redisWitnessNetwork))) {
    throw new Error('--redis-witness-network requires clock calibration and an explicit Docker network name')
  }
  return {
    label, project, redisName: `${project}-redis-1`, routerName: `${project}-sync-ws-router-1`,
    cells: [
      { service: 'sync-cell-a', name: `${project}-sync-cell-a-1`, base: `http://127.0.0.1:${env.SYNC_FAILOVER_CELL_A_PORT || '3311'}` },
      { service: 'sync-cell-b', name: `${project}-sync-cell-b-1`, base: `http://127.0.0.1:${env.SYNC_FAILOVER_CELL_B_PORT || '3312'}` },
    ],
    email: env.SYNC_FAILOVER_LOGIN_EMAIL || 'failover-admin@maplespire.local',
    out: resolve(arg('--out', `sync-cell-redis-pause-${label}.json`)),
    routerReadyUrl: validateRouterReadinessUrl(arg('--router-ready-url', null)),
    samplePeriodMs: duration('--sample-ms', PERIOD_MS, 50, 1_000),
    engineHost, clockCalibration, redisWitnessNetwork,
    beforeMs: duration('--before-ms', 2_000, 200, 60_000),
    pauseMs: duration('--pause-ms', 30_000, 1_000, 300_000),
    recoverMs: duration('--recover-ms', 25_000, 1_000, 300_000),
  }
}

/** No shell or blocking child call: Docker acknowledgements must not prevent
 * the same process from receiving and timestamping HTTP responses. */
export function observationDocker(...args) {
  return new Promise((settle, reject) => {
    execFile('docker', args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else settle(String(stdout))
    })
  })
}

export async function createObservationPauseTransport(options, docker = observationDocker) {
  if (!options.engineHost) return {
    evidence: { kind: 'docker-cli' },
    change: (operation) => docker(operation, options.redisName),
  }
  const containerId = (await docker('inspect', '-f', '{{.Id}}', options.redisName)).trim()
  return createLocalDockerPauseTransport({ engineHost: options.engineHost, containerName: options.redisName, containerId,
    witnessNetwork: options.redisWitnessNetwork ?? null, project: options.project })
}

/** Keep the audited historical clock result intact. Only a confirmed PING's
 * departure can improve its pause origin; a PONG arrival cannot. Invalid
 * identity, instrument or clock data never falls back to a passing model. */
export function refineRedisPauseClock({ clock, witness, pauseBegin, identity }) {
  const analysis = witness ? analyzeRedisFreezeWitness(witness) : null
  const issues = [...(analysis?.issues ?? ['Redis witness result is missing'])]
  if (!analysis?.instrumentValid) issues.push('Redis witness instrument is invalid')
  const identityKeys = ['containerId', 'imageId', 'startedAt', 'restartCount', 'project', 'service', 'networkName', 'networkId', 'ip', 'port']
  if (identity?.valid !== true || identityKeys.some(key => witness?.target?.[key] === undefined
    || identity.initial?.[key] !== witness.target[key] || identity.final?.[key] !== witness.target[key])) {
    issues.push('Redis witness final identity is unverified')
  }
  if (!clock?.valid || !Number.isFinite(pauseBegin)) issues.push('historical clock model or pause origin is invalid')
  let gainMs = null, transition = null, verdict = 'INVALID'
  if (!issues.length) {
    if (analysis.pauseLowerMs !== null && !Number.isFinite(analysis.pauseLowerMs)) issues.push('Redis witness pause bound is invalid')
    else {
      gainMs = Math.max(0, (analysis.pauseLowerMs ?? pauseBegin) - pauseBegin)
      transition = { lowerMs: clock.transition?.lowerMs, upperMs: clock.transition?.upperMs - gainMs }
      verdict = classifyLeaseInterval(transition.lowerMs, transition.upperMs)
      if (verdict === 'INVALID') issues.push('refined transition bounds contradict each other')
    }
  }
  return { model: 'redis-ping-freeze-lower-v1', valid: issues.length === 0,
    verdict: issues.length ? 'INVALID' : verdict, limitMs: 475, issues,
    qualifiedRecordIds: analysis?.qualifiedRecordIds ?? [], pauseLowerMs: analysis?.pauseLowerMs ?? null,
    historicalPauseBeginMs: pauseBegin, gainMs, transition, identity,
  }
}

export async function identifyObservationCells(cells, docker = observationDocker) {
  const identified = await Promise.all(cells.map(async (cell) => {
    const id = (await docker('inspect', '-f', '{{.Id}}', cell.name)).trim()
    if (!/^[a-f0-9]{64}$/i.test(id)) throw new Error('observation needs a full cell container ID')
    return { ...cell, id }
  }))
  if (new Set(identified.map(cell => cell.id)).size !== identified.length) throw new Error('observation cell IDs must be distinct')
  return identified
}

async function login(options) {
  const response = await fetch(`${options.cells[0].base}/api/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: options.email }), signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`dev login HTTP ${response.status}`)
  const cookie = (response.headers.get('set-cookie') || '').match(/maplespire_session=[^;]+/)?.[0]
  if (!cookie) throw new Error('dev login did not return the session cookie')
  const body = await response.json()
  if (!body.user?.isPlatformAdmin) throw new Error('login is not platform admin')
  return cookie
}

function execInside(containerName, code, timeoutMs) {
  return new Promise((settle) => {
    execFile('docker', ['exec', containerName, 'node', '-e', code], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
      settle({ error: error ? String(error.message).slice(0, 200) : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

async function tcpProbeFromCell(cell) {
  const code = [
    "const t=Date.now();const s=require('net').connect(6379,'redis');s.setTimeout(3000);",
    "s.on('connect',()=>{console.log(JSON.stringify({connect:true,afterMs:Date.now()-t}));s.write('PING\\r\\n')});",
    "s.on('data',(d)=>{console.log(JSON.stringify({reply:String(d).trim(),afterMs:Date.now()-t}));process.exit(0)});",
    "s.on('timeout',()=>{console.log(JSON.stringify({timeout:true,afterMs:Date.now()-t}));process.exit(0)});",
    "s.on('error',(e)=>{console.log(JSON.stringify({error:e.code,afterMs:Date.now()-t}));process.exit(0)});",
  ].join('')
  const out = await execInside(cell.name, code, 10_000)
  const parse = (line) => { try { return JSON.parse(line) } catch { return line } }
  return { stdout: out.stdout.trim().split('\n').filter(Boolean).map(parse), stderr: out.stderr.trim(), error: out.error }
}

async function readRouterFromInside(name) {
  const startedAt = Date.now()
  const code = "fetch('http://127.0.0.1:3010/api/ready',{signal:AbortSignal.timeout(1500)}).then(async(r)=>console.log(JSON.stringify({status:r.status,body:await r.json()}))).catch((e)=>console.log(JSON.stringify({error:e.name})))"
  const out = await execInside(name, code, 10_000)
  const last = out.stdout.trim().split('\n').filter(Boolean).pop()
  let parsed
  try { parsed = JSON.parse(last) } catch { parsed = { error: (out.error || out.stderr || out.stdout).trim().slice(0, 200) || 'no output' } }
  return { ...parsed, execMs: Date.now() - startedAt }
}

function logsSince(cell, sinceIso) {
  const out = spawnSync('docker', ['logs', '-t', '--since', sinceIso, cell.id ?? cell.name], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024,
  })
  if (out.error || out.status !== 0) throw new Error(`could not read ${cell.service} logs: ${out.error?.message ?? out.stderr}`)
  const rawLines = `${out.stdout}\n${out.stderr}`.split('\n').filter(Boolean)
  const lossLines = rawLines.filter(line => line.includes('partition-worker-redis-unavailable'))
  const lines = rawLines.map(line => line.replaceAll(String.fromCharCode(0), ''))
  const kept = []
  let admissionLines = 0
  for (const line of lines) {
    if (line.includes('workspace_admission')) { admissionLines += 1; continue }
    if (line.includes('"event":"sync.cell.ownership"')) {
      const at = line.slice(0, 30).trim()
      try {
        const s = JSON.parse(line.slice(line.indexOf('{')))
        kept.push(`${at} ownership partitionIndex=${s.partitionIndex} partitionReady=${s.partitionReady} ready=${s.ready} canServe=${s.canServe} partitionLoss=${s.partitionLossCount} partitionAcq=${s.partitionAcquisitionCount} owned=${s.ownedWorkspaceCount} loss=${s.lossCount} errors=${s.errorCount}`)
      } catch { kept.push(line.slice(0, 300)) }
    } else if (/\[sync-cell\]|\[redis:|partition|redis|Redis|lease|Unavailable/.test(line)) kept.push(line.slice(0, 400))
  }
  return { kept, lossLines, admissionLines, totalLines: lines.length, containerId: cell.id ?? null,
    ...(cell.id ? { rawStdout: out.stdout, rawStderr: out.stderr } : {}),
  }
}

/** Starts immediately and transfers the sampler BEFORE any await. A caller
 * can always stop it if the next operation fails. The seams permit real HTTP
 * tests without Docker and make an output failure reject stop, not print PASS. */
export function startObservation(options, seams = {}) {
  const { cells, cookie, routerName, label = 'gate', out, includeLogs = true, includeTcpProbe = true } = options
  if (!Array.isArray(cells) || cells.length !== 2) throw new Error('observation needs exactly two cells')
  if (typeof cookie !== 'string' || !cookie) throw new Error('observation needs the authenticated gate session')
  const routerReadyUrl = validateRouterReadinessUrl(options.routerReadyUrl)
  const samplePeriodMs = options.samplePeriodMs ?? PERIOD_MS
  if (!Number.isInteger(samplePeriodMs) || samplePeriodMs < 50 || samplePeriodMs > 1_000) throw new Error('samplePeriodMs must be an integer between 50 and 1000 ms')
  const routerEvery = Math.ceil(ROUTER_PERIOD_MS / samplePeriodMs)
  const fetch = seams.fetch ?? globalThis.fetch
  const now = seams.now ?? Date.now
  const monotonicNow = seams.monotonicNow ?? (() => performance.now())
  const clockCalibration = options.clockCalibration === true
  const witnessRequested = options.redisWitnessNetwork !== null && options.redisWitnessNetwork !== undefined
  if (clockCalibration && (typeof options.readEngineClock !== 'function' || !includeLogs
    || cells.some(cell => !/^[a-f0-9]{64}$/i.test(cell.id ?? '')))) {
    throw new Error('clock calibration needs an Engine clock reader, identified cells and logs')
  }
  if (witnessRequested && (!clockCalibration || !options.redisWitnessTarget
    || typeof options.verifyWitnessIdentity !== 'function'
    || options.redisWitnessTarget.networkName !== options.redisWitnessNetwork)) {
    throw new Error('Redis witness requires clock calibration and a verified Engine target on the explicit network')
  }
  const internalRouter = seams.readRouterFromInside ?? readRouterFromInside
  const writeReport = seams.writeReport ?? ((path, report) => writeFileSync(path, JSON.stringify(report, null, 2) + '\n'))
  const readLogs = seams.logsSince ?? logsSince
  const t0 = now()
  const monotonicT0 = monotonicNow()
  const marks = { pauseStartedAt: null, pausedAt: null, unpauseStartedAt: null, unpausedAt: null }
  const samples = []
  const pending = new Set()
  const faults = []
  let tcpProbe = null
  let tcpProbeStarted = false
  let tickIndex = 0
  let stopped = false
  let stopPromise = null
  let baseline = null
  let pauseAdmission = null
  let witness = null
  let witnessOrdinal = 0
  const witnessFaults = []
  if (witnessRequested) {
    try {
      witness = (seams.startRedisFreezeWitness ?? startRedisFreezeWitness)({
        target: options.redisWitnessTarget,
        clock: () => ({ at: now() - t0, monoAt: monotonicNow() - monotonicT0, ordinal: ++witnessOrdinal }),
      })
    } catch { witnessFaults.push('Redis witness construction failed') }
  }
  const stamp = (value) => ({ ...value, at: now() - t0, ...(clockCalibration ? { monoAt: monotonicNow() - monotonicT0 } : {}) })
  const phase = () => marks.unpausedAt !== null ? 'unpaused' : marks.pausedAt !== null ? 'paused' : 'before'
  const track = (promise) => {
    const guarded = promise.catch((error) => { faults.push(String(error?.message ?? error)) })
      .finally(() => pending.delete(guarded))
    pending.add(guarded)
  }
  const readCell = (cell, sample, key) => {
    const startedAt = now()
    sample[key] = { ready: { pending: true }, state: { pending: true }, latencyMs: null }
    const ready = Promise.resolve().then(() => fetch(`${cell.base}/api/ready`, { signal: AbortSignal.timeout(1_500) }))
      .then(async (response) => ({ status: response.status, checks: (await response.json()).checks }))
      .catch(failure).then((value) => { sample[key].ready = stamp(value) })
    let stateRequestedAt, stateRequestedMonoAt
    const state = Promise.resolve().then(() => {
      stateRequestedAt = now() - t0
      stateRequestedMonoAt = monotonicNow() - monotonicT0
      return fetch(`${cell.base}/api/platform/sync-cell`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(1_500) })
    })
      .then(async (response) => {
        if (!response.ok) { await response.body?.cancel(); return { status: response.status } }
        const s = await response.json()
        return {
          status: response.status, generatedAt: s.generatedAt, partitionIndex: s.partitionIndex, partitionReady: s.partitionReady,
          ready: s.ready, canServe: s.canServe, partitionLossCount: s.partitionLossCount,
          partitionAcquisitionCount: s.partitionAcquisitionCount, ownedWorkspaceCount: s.ownedWorkspaceCount,
          lossCount: s.lossCount, errorCount: s.errorCount, conflictCount: s.conflictCount,
          minimumRemainingLeaseMs: s.minimumRemainingLeaseMs,
        }
      }).catch(failure).then((value) => { sample[key].state = stamp({ ...value,
        ...(clockCalibration ? { requestedAt: stateRequestedAt, requestedMonoAt: stateRequestedMonoAt } : {}),
      }) })
    return Promise.all([ready, state]).then(() => { sample[key].latencyMs = now() - startedAt })
  }
  const tick = () => {
    if (stopped) return
    const sample = { t: now() - t0, phase: phase(), a: null, b: null, router: null }
    samples.push(sample)
    track(readCell(cells[0], sample, 'a'))
    track(readCell(cells[1], sample, 'b'))
    if (clockCalibration && tickIndex % Math.ceil(200 / samplePeriodMs) === 0) {
      sample.engineClock = { pending: true }
      let requestedAt, requestedMonoAt
      track(Promise.resolve().then(() => {
        requestedAt = now() - t0
        requestedMonoAt = monotonicNow() - monotonicT0
        return options.readEngineClock()
      }).catch(failure).then(value => { sample.engineClock = stamp({ ...value, requestedAt, requestedMonoAt }) }))
    }
    if (routerReadyUrl || tickIndex % routerEvery === 0) {
      const request = routerReadyUrl
        ? Promise.resolve().then(() => fetch(routerReadyUrl, { signal: AbortSignal.timeout(1_500) }))
          .then(async (response) => ({ status: response.status, body: await response.json() }))
        : Promise.resolve().then(() => internalRouter(routerName))
      track(request.catch(failure).then((value) => { sample.router = stamp(value) }))
    }
    tickIndex += 1
    if (includeTcpProbe && marks.pausedAt !== null && marks.unpauseStartedAt === null
      && now() - marks.pausedAt >= TCP_PROBE_AT_MS && !tcpProbeStarted) {
      tcpProbeStarted = true
      track(tcpProbeFromCell(cells[0]).then((value) => { tcpProbe = { atMs: now() - t0, ...value } }))
    }
  }
  tick()
  const timer = setInterval(tick, samplePeriodMs)
  const mark = (key, at) => {
    if (stopped) throw new Error('cannot mark a stopped observation')
    const index = Object.keys(marks).indexOf(key)
    const previous = index === 0 ? t0 : marks[Object.keys(marks)[index - 1]]
    if (!Number.isFinite(at) || previous === null || at < previous || marks[key] !== null) throw new Error(`invalid ${key} transition`)
    marks[key] = at
  }
  return {
    t0,
    pauseStarted: (at = now()) => {
      if (clockCalibration && !stopped && marks.pauseStartedAt === null) {
        // Both injectors call this synchronously BEFORE taking responsibility
        // for a pause. Do not reset either clock origin or wait for pending
        // requests: final validation still owns those original promises.
        const checkedAt = now() - t0
        const checkedMonoAt = monotonicNow() - monotonicT0
        if (!baseline || baseline.valid) {
          baseline = analyzeRedisPauseBaseline({ t0, samples, checkedAt, checkedMonoAt, samplePeriodMs })
          baseline.issues.push(...faults.map(fault => `collector: ${fault}`))
          baseline.valid = baseline.issues.length === 0
        }
        if (!baseline.valid && !witnessRequested) {
          const message = `baseline refused before Redis pause: ${baseline.issues.join('; ')}`
          if (!faults.includes(message)) faults.push(message)
          throw new Error(message)
        }
      }
      if (witnessRequested) {
        let admitted
        try { admitted = witness?.admissionBeforePause() }
        catch { admitted = { valid: false, issues: ['Redis witness admission failed'] } }
        pauseAdmission = { valid: baseline?.valid === true && admitted?.valid === true,
          clockValid: baseline?.valid === true, witnessValid: admitted?.valid === true,
          issues: [...(baseline?.issues ?? ['clock admission is missing']), ...witnessFaults,
            ...(admitted?.issues ?? ['Redis witness admission is missing'])] }
        if (!pauseAdmission.valid) {
          const message = `pause admission refused before Redis pause: ${pauseAdmission.issues.join('; ')}`
          if (!faults.includes(message)) faults.push(message)
          throw new Error(message)
        }
        // This can refuse a newly invalid stamp without granting ownership of
        // an injection. The caller acquires that responsibility only on return.
        try {
          witness.pauseAttempted()
          mark('pauseStartedAt', at)
        } catch (error) {
          pauseAdmission.valid = false
          pauseAdmission.issues.push('pause stamp refused before injection')
          throw error
        }
        return
      }
      mark('pauseStartedAt', at)
    },
    pauseCompleted: (at) => {
      // Stop emissions before any clock read that could fail after the ACK.
      witness?.pauseAcknowledged()
      const acknowledgedAt = at ?? now()
      mark('pausedAt', acknowledgedAt)
      return acknowledgedAt
    },
    sealBeforeUnpause: () => witness?.sealBeforeUnpause(),
    unpauseStarted: (at = now()) => mark('unpauseStartedAt', at),
    unpauseCompleted: (at = now()) => mark('unpausedAt', at),
    stop({ error = null } = {}) {
      if (stopPromise) return stopPromise
      stopped = true
      clearInterval(timer)
      stopPromise = (async () => {
        const witnessStopped = witness ? witness.stop(error) : Promise.resolve(null)
        const [freezeWitness] = await Promise.all([witnessStopped, Promise.all([...pending])])
        let witnessIdentity = null
        if (witnessRequested) {
          try { witnessIdentity = await options.verifyWitnessIdentity() }
          catch { witnessIdentity = { valid: false, issue: 'Redis witness final identity verification failed' } }
        }
        // The sampler is stopped and its requests settled BEFORE synchronous
        // logs and file writes: neither can alter the measured arrival times.
        let logs = {}
        if (includeLogs) {
          try { logs = Object.fromEntries(cells.map((cell) => [cell.service, readLogs(cell, new Date(t0 - 1_000).toISOString())])) }
          catch (failure) { faults.push(String(failure?.message ?? failure)) }
        }
        const summary = summarizeRedisPauseObservation({
          label, t0, ...marks, samples, samplePeriodMs,
          routerSamplePeriodMs: routerReadyUrl ? samplePeriodMs : samplePeriodMs * routerEvery,
          error: [error && String(error?.message ?? error), ...faults].filter(Boolean).join('; ') || null,
        })
        summary.tcpProbeFromCellADuringPause = tcpProbe
        summary.pauseTransport = options.pauseTransport ?? { kind: 'docker-cli' }
        if (clockCalibration) {
          summary.baseline = baseline
          summary.clock = analyzeRedisPauseClock({ t0, ...marks, samples, logs, cells })
          if (!summary.clock.valid) {
            summary.measurementValid = false
            summary.measurementIssues.push(...summary.clock.issues.map(issue => `clock: ${issue}`))
          }
        }
        if (witnessRequested) {
          summary.pauseAdmission = pauseAdmission
          summary.freezeWitness = refineRedisPauseClock({ clock: summary.clock, witness: freezeWitness,
            pauseBegin: marks.pauseStartedAt === null ? null : marks.pauseStartedAt - t0, identity: witnessIdentity })
          if (!summary.freezeWitness.valid) {
            summary.measurementValid = false
            summary.measurementIssues.push(...summary.freezeWitness.issues.map(issue => `Redis witness: ${issue}`))
          }
        }
        summary.logs = Object.fromEntries(Object.entries(logs).map(([key, value]) => [key, {
          admissionLines: value.admissionLines, totalLines: value.totalLines, keptCount: value.kept.length,
        }]))
        const report = { summary, samples, logs, ...(witnessRequested ? { freezeWitness } : {}) }
        if (out) await writeReport(out, report)
        return report
      })()
      return stopPromise
    },
  }
}

/** The only injector in standalone mode. Refusing an existing pause happens
 * BEFORE acquiring cleanup responsibility. Optional gate mode never calls it. */
export async function runStandaloneObservation(options, seams = {}) {
  if (/demo/i.test(options.redisName) || options.cells.some((cell) => /demo/i.test(cell.name))) throw new Error('refusing to touch a container named demo')
  const docker = seams.docker ?? observationDocker
  let inspectionTarget = options.redisName
  const isPaused = async () => (await docker('inspect', '-f', '{{.State.Paused}}', inspectionTarget)).trim() === 'true'
  if (await isPaused()) throw new Error(`${options.redisName} is already paused; refusing to start`)
  const cookie = options.cookie ?? await (seams.login ?? login)(options)
  const pauseTransport = await (seams.createPauseTransport ?? createObservationPauseTransport)(options, docker)
  // Cleanup must inspect the same object it will unpause. A replacement that
  // inherits this name cannot report false on behalf of the acquired Id.
  inspectionTarget = pauseTransport.evidence.engineContainerId ?? options.redisName
  const cells = options.clockCalibration ? await identifyObservationCells(options.cells, docker) : options.cells
  const observation = (seams.startObservation ?? startObservation)({ ...options, cells, cookie,
    pauseTransport: pauseTransport.evidence, readEngineClock: pauseTransport.readClock,
    redisWitnessTarget: pauseTransport.witnessTarget, verifyWitnessIdentity: pauseTransport.verifyWitnessIdentity })
  let attemptedPause = false
  let pauseCompleted = false
  let error = null
  try {
    await sleep(options.beforeMs)
    observation.pauseStarted()
    attemptedPause = true
    await pauseTransport.change('pause')
    observation.pauseCompleted()
    pauseCompleted = true
    if (!await isPaused()) throw new Error('pause did not take')
    await sleep(options.pauseMs)
  } catch (failure) { error = failure }
  finally {
    if (attemptedPause) {
      let shouldUnpause = true
      try { shouldUnpause = await isPaused() }
      catch (failure) {
        // A failed inspection cannot cancel cleanup responsibility acquired
        // by our pause attempt. Preserve the error and still try to release.
        error = new AggregateError([error, failure].filter(Boolean), 'Redis pause cleanup inspection failed')
      }
      try {
        if (shouldUnpause) {
          // Cut off witness responses even if the pause ACK never arrived.
          // A telemetry failure must not take authority over the owned release.
          try { observation.sealBeforeUnpause?.() }
          catch (failure) { error = new AggregateError([error, failure].filter(Boolean), 'Redis witness cutoff failed') }
          // Marking is evidence, not authority over cleanup. A bad timestamp
          // must not leave Redis paused by preventing the actual unpause.
          let marked = false
          if (pauseCompleted) {
            try { observation.unpauseStarted(); marked = true }
            catch (failure) { error = new AggregateError([error, failure].filter(Boolean), 'unpause timestamp failed') }
          }
          await pauseTransport.change('unpause')
          if (marked) observation.unpauseCompleted()
        } else throw new Error('the owned pause disappeared before cleanup')
      } catch (failure) { error = new AggregateError([error, failure].filter(Boolean), 'Redis pause cleanup failed') }
    }
  }
  if (!error) await sleep(options.recoverMs)
  const report = await observation.stop({ error })
  if (error) throw error
  return report
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = observationOptions(process.argv.slice(2))
    const report = await runStandaloneObservation(options)
    console.log(JSON.stringify(report.summary, null, 2))
    console.log(`written ${options.out}`)
    if (!report.summary.measurementValid) process.exitCode = 1
  } catch (error) {
    console.error(`Redis observation failed (not a production verdict): ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
