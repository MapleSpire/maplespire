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

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import WebSocket from 'ws'
import { createObservationPauseTransport, identifyObservationCells, observationDocker, observationOptions, startObservation } from './sync-cell-redis-pause-observe.mjs'
import { kubernetesRedisOptions } from '../qa/kubernetesRedis/lab.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const composeFile = resolve(here, '../../infra/compose/sync-cell-failover.yml')
const project = process.env.SYNC_FAILOVER_PROJECT || 'maplespire-sync-failover'
const routerPort = process.env.SYNC_FAILOVER_ROUTER_PORT || '3310'
const cellAPort = process.env.SYNC_FAILOVER_CELL_A_PORT || '3311'
const cellBPort = process.env.SYNC_FAILOVER_CELL_B_PORT || '3312'
const loginEmail = process.env.SYNC_FAILOVER_LOGIN_EMAIL || 'failover-admin@maplespire.local'
const redisOutageScenario = process.argv.includes('--redis-outage')
const dedicatedScenario = process.argv.includes('--dedicated')
const kubernetesOptions = kubernetesRedisOptions(process.argv.slice(2))
if (dedicatedScenario && redisOutageScenario) throw new Error('--dedicated and --redis-outage are mutually exclusive')
const optionValue = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value?.trim() || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}
const observeOut = optionValue('--observe-out')
const observeRouterUrl = optionValue('--observe-router-url')
const observeSampleMs = optionValue('--observe-sample-ms')
const observeEngineHost = optionValue('--observe-engine-host')
const observeClockCalibration = process.argv.includes('--observe-clock-calibration')
const observeRedisWitnessNetwork = optionValue('--observe-redis-witness-network')
if ((observeOut || observeRouterUrl || observeSampleMs || observeEngineHost || observeClockCalibration || observeRedisWitnessNetwork) && !redisOutageScenario) throw new Error('observation is supported only with --redis-outage')
if ((observeRouterUrl || observeSampleMs || observeEngineHost || observeClockCalibration || observeRedisWitnessNetwork) && !observeOut) throw new Error('observation options require --observe-out')
const observeOptions = observeOut ? observationOptions([
  '--out', observeOut,
  ...(observeRouterUrl ? ['--router-ready-url', observeRouterUrl] : []),
  ...(observeSampleMs ? ['--sample-ms', observeSampleMs] : []),
  ...(observeEngineHost ? ['--engine-host', observeEngineHost] : []),
  ...(observeClockCalibration ? ['--clock-calibration'] : []),
  ...(observeRedisWitnessNetwork ? ['--redis-witness-network', observeRedisWitnessNetwork] : []),
]) : null
const cells = [
  { service: 'sync-cell-a', baseUrl: `http://127.0.0.1:${cellAPort}` },
  { service: 'sync-cell-b', baseUrl: `http://127.0.0.1:${cellBPort}` },
]

function compose(...args) {
  return execFileSync(
    'docker',
    ['compose', '-p', project, '-f', composeFile, ...args],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // `docker compose logs` on a container that has served a bench run
      // overflows Node's default 1 MB pipe buffer and `execFileSync` throws
      // ENOBUFS — which reaches the caller as a crash, not as a failed
      // assertion, so the gate reports nothing about the thing it was reading
      // the logs FOR (a cell can easily accumulate ~1 MB of admission lines).
      // See `logsFor` below, which also bounds what it asks for.
      maxBuffer: 64 * 1024 * 1024,
    },
  )
}

/** Recent log lines for one service, BOUNDED — the whole history is never the
 *  question, and asking for it is what overflowed the buffer above. */
function logsFor(service, tail = 2_000) {
  return compose('logs', '--no-color', '--tail', String(tail), service)
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function json(url, options = {}) {
  const { cookie, headers: optionHeaders, ...requestOptions } = options
  const headers = { ...(optionHeaders || {}) }
  if (cookie) headers.Cookie = cookie
  const response = await fetch(url, {
    ...requestOptions,
    headers,
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.json()
}

async function httpStatus(url, options = {}) {
  const { cookie, headers: optionHeaders, ...requestOptions } = options
  const headers = { ...(optionHeaders || {}) }
  if (cookie) headers.Cookie = cookie
  const response = await fetch(url, {
    ...requestOptions,
    headers,
    signal: AbortSignal.timeout(2_000),
  })
  response.body?.cancel().catch(() => undefined)
  return response.status
}

async function waitFor(label, probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

async function ownership(cell, cookie) {
  return json(`${cell.baseUrl}/api/platform/sync-cell`, { cookie })
}

function workspaceSocketUrl(workspace) {
  const query = new URLSearchParams({
    landscapeId: workspace.landscapeId,
    versionId: workspace.versionId,
  })
  return `ws://127.0.0.1:${routerPort}/automerge?${query}`
}

function openWorkspaceSocket(workspace, cookie) {
  const socket = new WebSocket(
    workspaceSocketUrl(workspace),
    { headers: { Cookie: cookie } },
  )
  return new Promise((resolveSocket, reject) => {
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('public WebSocket open timed out'))
    }, 10_000)
    socket.once('open', () => {
      clearTimeout(timer)
      resolveSocket(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function expectRejectedWorkspace(workspace, { cookie, expectedStatus, label }) {
  const socket = new WebSocket(
    workspaceSocketUrl(workspace),
    cookie ? { headers: { Cookie: cookie } } : undefined,
  )
  socket.on('error', () => undefined)
  return new Promise((resolveRejection, reject) => {
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error(`${label} WebSocket rejection timed out`))
    }, 10_000)
    socket.once('open', () => {
      clearTimeout(timer)
      socket.terminate()
      reject(new Error(`${label} WebSocket unexpectedly opened`))
    })
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode
      response.once('error', (error) => {
        clearTimeout(timer)
        socket.terminate()
        reject(error)
      })
      response.resume()
      response.once('end', () => {
        clearTimeout(timer)
        socket.terminate()
        if (status !== expectedStatus) {
          reject(new Error(`${label} WebSocket returned HTTP ${status}, expected ${expectedStatus}`))
          return
        }
        resolveRejection(status)
      })
    })
  })
}

async function login(cell) {
  const response = await fetch(`${cell.baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: loginEmail }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`dev login returned HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json()
  const setCookie = response.headers.get('set-cookie') || ''
  const sessionCookie = setCookie.match(/maplespire_session=[^;]+/)?.[0]
  if (!sessionCookie) throw new Error('dev login did not return the HttpOnly session cookie')
  if (!body.user?.isPlatformAdmin) throw new Error('failover login was not bootstrapped as platform admin')
  if (!body.orgId) throw new Error('failover login did not provision an organization')
  return { cookie: sessionCookie, userId: body.user.id, orgId: body.orgId }
}

function waitForClose(socket) {
  return new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => reject(new Error('drained WebSocket did not close')), 12_000)
    socket.once('close', (code, reason) => {
      clearTimeout(timer)
      resolveClose({ code, reason: reason.toString() })
    })
  })
}

/**
 * The workspace was drained BY SOMEONE, and the cell said so.
 *
 * It does NOT require the cell's own line to read `"drainedSockets":1`: a
 * correctly behaving stack can emit the event with a count of ZERO while the
 * client's socket has closed with 1012, verified two assertions earlier.
 *
 * The reason is that TWO mechanisms close the same connection when ownership
 * moves — `ConnectionRegistry.drainWorkspace` on the owning cell, and
 * `OwnerAwareTunnelRegistry.reconcile` in the router — and the cell's drain
 * SKIPS a socket already at `readyState >= 2`. Whichever notices first makes
 * the other count zero. Demanding that the CELL win that race is demanding a
 * race outcome, not a safety property.
 *
 * With a client connected through the router, the OWNING cell's quiesce census reports
 * one peer bound to the workspace and the standby reports none. So the binding
 * `drainWorkspace` matches on does exist — the zero is a socket someone else
 * already closed, not a blind counter.
 *
 * So the property asserted is the one that matters: the cell noticed the
 * ownership change and drained the workspace, and BETWEEN the two mechanisms at
 * least one socket was actually closed. A stack where neither closed anything
 * still fails here.
 */
function verifyDrainLog(service) {
  const logs = logsFor(service)
  if (!logs.includes('sync.cell.workspace_drained')) {
    throw new Error(`${service} did not emit sync.cell.workspace_drained`)
  }
  const cellDrained = [...logs.matchAll(/"drainedSockets":(\d+)/g)]
    .reduce((total, match) => total + Number(match[1]), 0)
  const routerClosed = [...logsFor('sync-ws-router').matchAll(/"closedTunnels":(\d+)/g)]
    .reduce((total, match) => total + Number(match[1]), 0)
  if (cellDrained + routerClosed < 1) {
    throw new Error(
      `neither the cell nor the router closed a socket for the retired workspace `
      + `(cell drained ${cellDrained}, router closed ${routerClosed}) — the client's 1012 came from somewhere else`,
    )
  }
  return logs
}

let pausedService = null
let initialSocket = null
let recoveredSocket = null
let observation = null
let observationPauseTransport = null
let observationStopped = false
let observationPauseCompletedAt = null
let observationResumeStarted = false
let gateError = null
let result = null

async function unpauseObservedRedis() {
  let markError = null
  // The cutoff is unconditional: uncertain pause ACKs own cleanup too. Seal
  // synchronously before timestamping or sending any release request.
  try { observation.sealBeforeUnpause() }
  catch (error) { markError = error }
  if (observationPauseCompletedAt !== null && !observationResumeStarted) {
    try {
      observation.unpauseStarted()
      observationResumeStarted = true
    } catch (error) { markError ??= error }
  }
  // A failed timestamp (for example a wall-clock correction) invalidates the
  // measurement; it must NEVER prevent releasing the pause we own.
  await observationPauseTransport.change('unpause')
  pausedService = null
  if (observationPauseCompletedAt !== null && observationResumeStarted) {
    try { observation.unpauseCompleted() } catch (error) { markError ??= error }
  }
  if (markError) throw markError
}

try {
  if (kubernetesOptions) {
    const { runKubernetesRedisGate } = await import('./verify-sync-cell-redis-kubernetes.mjs')
    result = await runKubernetesRedisGate(kubernetesOptions)
  } else if (dedicatedScenario) {
    const { dedicatedOptions, runDedicatedGate } = await import('./verify-sync-cell-dedicated.mjs')
    result = await runDedicatedGate(dedicatedOptions(process.argv.slice(2), process.env))
  } else {
  await waitFor('both cell HTTP servers', async () => {
    const health = await Promise.all(cells.map((cell) => json(`${cell.baseUrl}/api/health`).catch(() => null)))
    return health.every((entry) => entry?.status === 'ok')
  })

  const session = await login(cells[0])
  const bootstrapAudit = await json(
    `${cells[0].baseUrl}/api/platform/audit?action=platform_admin.bootstrap_grant&limit=10`,
    { cookie: session.cookie },
  )
  if (!bootstrapAudit.entries?.some((entry) => entry.targetId === session.userId)) {
    throw new Error('platform-admin bootstrap grant is missing from the audit log')
  }
  const landscapesResponse = await json(`${cells[0].baseUrl}/api/landscapes`, { cookie: session.cookie })
  const landscape = landscapesResponse.landscapes?.find((entry) => entry.defaultVersionId)
  if (!landscape) throw new Error('authenticated user has no workspace with a default version')
  const workspace = {
    landscapeId: landscape.id,
    versionId: landscape.defaultVersionId,
  }
  await waitFor('authenticated workspace ownership', async () => {
    const response = await fetch(
      `http://127.0.0.1:${routerPort}/api/automerge/root?${new URLSearchParams(workspace)}`,
      { headers: { Cookie: session.cookie }, signal: AbortSignal.timeout(2_000) },
    )
    return response.ok
  })

  const anonymousStatus = await expectRejectedWorkspace(workspace, {
    expectedStatus: 401,
    label: 'anonymous',
  })
  const initial = await Promise.all(cells.map((cell) => ownership(cell, session.cookie)))
  const activeIndex = initial.findIndex((entry) => entry.partitionIndex === 0 && entry.ready === true)
  if (activeIndex < 0) throw new Error(`expected one ready partition owner, got ${JSON.stringify(initial)}`)
  const standbyIndex = 1 - activeIndex
  const active = cells[activeIndex]
  const standby = cells[standbyIndex]
  if (initial[standbyIndex].partitionIndex !== null) {
    throw new Error(`expected ${standby.service} to be standby, got partition ${initial[standbyIndex].partitionIndex}`)
  }

  if (observeOptions) {
    // Refuse BEFORE assuming ownership of any pause. The passive observer
    // cannot unpause a container another invocation already paused.
    const alreadyPaused = await observationDocker('inspect', '-f', '{{.State.Paused}}', observeOptions.redisName)
    if (alreadyPaused.trim() === 'true') throw new Error(`${observeOptions.redisName} is already paused; refusing to start`)
    observationPauseTransport = await createObservationPauseTransport(observeOptions)
    const observationCells = observeOptions.clockCalibration ? await identifyObservationCells(observeOptions.cells) : observeOptions.cells
    observation = startObservation({ ...observeOptions, cells: observationCells, cookie: session.cookie, label: 'redis-failover-gate',
      pauseTransport: observationPauseTransport.evidence, readEngineClock: observationPauseTransport.readClock,
      redisWitnessTarget: observationPauseTransport.witnessTarget, verifyWitnessIdentity: observationPauseTransport.verifyWitnessIdentity })
    // Baseline precedes waitForClose's 12 s timer, so diagnostic setup cannot
    // consume the socket's failure-detection allowance.
    await delay(2_000)
  }
  initialSocket = await openWorkspaceSocket(workspace, session.cookie)
  const drained = waitForClose(initialSocket)
  // The pause or its HTTP probes can fail before this promise is awaited.
  // Observe rejection now without replacing the promise subsequently checked.
  void drained.catch(() => undefined)
  if (redisOutageScenario) {
    if (observation) {
      observation.pauseStarted()
      pausedService = 'redis' // cleanup owns an attempted injection, even if its acknowledgement fails
      await observationPauseTransport.change('pause')
      observationPauseCompletedAt = observation.pauseCompleted()
    } else {
      compose('pause', 'redis')
      pausedService = 'redis'
    }

    const unavailable = await waitFor('both cells to fail closed during critical Redis outage', async () => {
      const [statuses, states] = await Promise.all([
        Promise.all(cells.map((cell) => httpStatus(`${cell.baseUrl}/api/ready`).catch(() => null))),
        Promise.all(cells.map((cell) => ownership(cell, session.cookie))),
      ])
      const bothUnready = statuses.every((status) => status === 503)
        && states.every((state) => state.partitionIndex === null && state.ready === false)
      return bothUnready ? { statuses, states } : null
    }, 20_000)

    const closed = await drained
    if (closed.code !== 1012) {
      throw new Error(`expected WebSocket close 1012 after Redis outage, got ${closed.code} (${closed.reason})`)
    }
    const outageUpgradeStatus = await expectRejectedWorkspace(workspace, {
      cookie: session.cookie,
      expectedStatus: 503,
      label: 'authenticated critical-Redis outage',
    })
    if (unavailable.states[activeIndex].partitionLossCount <= initial[activeIndex].partitionLossCount) {
      throw new Error(`${active.service} did not increment partitionLossCount during Redis outage`)
    }

    if (observation) {
      // A fixed observation window, not waiting until a desired answer appears.
      // The gate still asserts the same condition; the extra samples disclose
      // late/missing responses and never turn a timeout into a 503 witness.
      await delay(Math.max(0, 2_000 - (Date.now() - observationPauseCompletedAt)))
      await unpauseObservedRedis()
    } else {
      compose('unpause', 'redis')
      pausedService = null
    }
    const recovered = await waitFor('exactly one partition owner after critical Redis recovery', async () => {
      const states = await Promise.all(cells.map((cell) => ownership(cell, session.cookie)))
      const owners = states
        .map((state, index) => ({ state, index }))
        .filter(({ state }) => state.partitionIndex === 0 && state.ready === true)
      const standbys = states.filter((state) => state.partitionIndex === null && state.ready === false)
      return owners.length === 1 && standbys.length === 1
        ? { states, ownerIndex: owners[0].index }
        : null
    }, 30_000)

    recoveredSocket = await openWorkspaceSocket(workspace, session.cookie)
    const recoveredSession = await json(`http://127.0.0.1:${routerPort}/api/auth/me`, {
      cookie: session.cookie,
    })
    if (recoveredSession.user?.id !== session.userId) {
      throw new Error('authenticated session identity changed after Redis recovery')
    }
    let observed = null
    if (observation) {
      await delay(2_000)
      observationStopped = true
      observed = await observation.stop()
      if (!observed.summary.measurementValid) {
        throw new Error(`observation is invalid (not a production verdict): ${observed.summary.measurementIssues.join('; ')}`)
      }
    }
    // logsFor uses execFileSync. Stop the sampler before this call so log
    // collection cannot manufacture a gap in the measured HTTP arrivals.
    verifyDrainLog(active.service)

    result = {
      outcome: 'passed',
      scenario: 'critical-redis-outage',
      originalOwner: active.service,
      recoveredOwner: cells[recovered.ownerIndex].service,
      recoveredPartition: recovered.states[recovered.ownerIndex].partitionIndex,
      readinessDuringOutage: unavailable.statuses,
      originalOwnerPartitionLossCount: unavailable.states[activeIndex].partitionLossCount,
      drainedCloseCode: closed.code,
      anonymousUpgradeStatus: anonymousStatus,
      outageUpgradeStatus,
      authenticatedUserId: session.userId,
      authenticatedOrgId: session.orgId,
      bootstrapAuditVerified: true,
      reconnectedThrough: `http://127.0.0.1:${routerPort}`,
      ...(observed ? { observation: { path: observeOptions.out, measurementValid: true, summary: observed.summary } } : {}),
    }
  } else {
    compose('pause', active.service)
    pausedService = active.service

    const takeover = await waitFor('standby partition takeover', async () => {
      const state = await ownership(standby, session.cookie)
      return state.partitionIndex === 0 && state.ready === true ? state : null
    }, 20_000)

    compose('unpause', active.service)
    pausedService = null
    const closed = await drained
    if (closed.code !== 1012) {
      throw new Error(`expected WebSocket close 1012 after ownership loss, got ${closed.code} (${closed.reason})`)
    }

    await waitFor('former owner to become standby', async () => {
      const state = await ownership(active, session.cookie)
      return state.partitionIndex === null && state.ready === false ? state : null
    })
    recoveredSocket = await openWorkspaceSocket(workspace, session.cookie)
    const recoveredSession = await json(`http://127.0.0.1:${routerPort}/api/auth/me`, {
      cookie: session.cookie,
    })
    if (recoveredSession.user?.id !== session.userId) {
      throw new Error('authenticated session identity changed after failover')
    }

    verifyDrainLog(active.service)

    result = {
      outcome: 'passed',
      scenario: 'sync-cell-pause',
      originalOwner: active.service,
      replacementOwner: standby.service,
      replacementPartition: takeover.partitionIndex,
      drainedCloseCode: closed.code,
      anonymousUpgradeStatus: anonymousStatus,
      authenticatedUserId: session.userId,
      authenticatedOrgId: session.orgId,
      bootstrapAuditVerified: true,
      reconnectedThrough: `http://127.0.0.1:${routerPort}`,
    }
  }
  }
} catch (error) {
  gateError = error
  throw error
} finally {
  let cleanupError = null
  if (pausedService) {
    if (observation && pausedService === 'redis') {
      let shouldUnpause = true
      try {
        const inspectionTarget = observationPauseTransport.evidence.engineContainerId ?? observeOptions.redisName
        const paused = await observationDocker('inspect', '-f', '{{.State.Paused}}', inspectionTarget)
        shouldUnpause = paused.trim() === 'true'
      } catch (error) { cleanupError = error }
      try {
        // Inspection failure is evidence of an invalid cleanup record, not
        // permission to leave the pause we attempted in place.
        if (shouldUnpause) await unpauseObservedRedis()
        else pausedService = null
      } catch (error) { cleanupError = new AggregateError([cleanupError, error].filter(Boolean), 'Redis unpause failed') }
    } else {
      try { compose('unpause', pausedService) } catch { /* best-effort legacy recovery */ }
    }
  }
  initialSocket?.terminate()
  recoveredSocket?.terminate()
  if (observation && !observationStopped) {
    try { await observation.stop({ error: gateError ?? cleanupError ?? new Error('gate did not reach its observation result') }) }
    catch (error) { cleanupError = error }
  }
  if (cleanupError) throw new AggregateError([gateError, cleanupError].filter(Boolean), 'gate observation cleanup failed')
}
// A failed collector/write/cleanup cannot leave a PASS line behind it.
console.log(JSON.stringify(result))
