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

// Diagram peer fleet — spread the peers across PROCESSES.
//
// The single-process harness costs about 26 ms per emit burst at 10 peers,
// 512 ms at 50 and 3,653 ms at 100: above roughly 25 peers it measures its own
// event loop rather than the server. No number at the 100-editor goal is
// obtainable from one process.
//
//   DIAGRAM_FLEET_PEERS=100 DIAGRAM_FLEET_WORKERS=10 DIAGRAM_PEER_ID=t1-bench \
//   DIAGRAM_PEER_RATE=1 DIAGRAM_PEER_DURATION_MS=30000 \
//   node scripts/verify-diagram-peer-fleet.mjs
//
// Every worker owns a disjoint slice of the GLOBAL peer index space (so the
// per-peer markers never collide) and every worker starts its load at the same
// absolute instant, so the fleet offers one campaign rather than W staggered
// ones. Each worker reports its own event-loop delay; the fleet VOIDS if any
// worker saturated, because a saturated worker is measuring itself.
//
// Two silent failure modes this file guards against:
//
//  - Pooling: workers publish a latency HISTOGRAM and the fleet merges those;
//    when it cannot, it says VOID instead of publishing `null`.
//  - Campaign identity: the coordinator mints ONE campaign id and asserts that
//    every worker ran it. With one id per process, a peer in worker 0 would
//    discard every marker from worker 1, and 100 peers over 10 workers would
//    measure ten benches of 10.

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluateHybridCampaign } from '../qa/diagramBrowserCore.mjs'
import {
  evaluateFleetRunScope,
  evaluateGlobalHeadConvergence,
  evaluateMachineSaturation,
  evaluateSeedFreshness,
  evaluateServerWindowCoverage,
  evaluateServerWindowOwnership,
  exitCodeForOutcome,
  mergeLatencyHistograms,
  poolWorkerLatency,
  redactVoidQuantiles,
  summarizeHistogram,
} from '../qa/diagramPeersCore.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(HERE, 'verify-diagram-peer-load.mjs')
const BROWSER_ARM = join(HERE, 'verify-diagram-peer-browser.mjs')

const API = (process.env.DIAGRAM_PEER_API ?? 'http://localhost:3021').replace(/\/$/, '')
const LOGIN_EMAIL = process.env.DIAGRAM_PEER_LOGIN_EMAIL ?? 'admin@example.com'
const TOTAL = Math.max(1, Number(process.env.DIAGRAM_FLEET_PEERS ?? 50))
const WORKERS = Math.max(1, Number(process.env.DIAGRAM_FLEET_WORKERS ?? 5))
const REPORT_PATH = process.env.DIAGRAM_FLEET_REPORT || undefined
const MAX_LOOP_P99_MS = Number(process.env.DIAGRAM_FLEET_MAX_LOOP_P99_MS ?? 100)
// Time for every worker to connect its peers before the barrier opens. Too short
// and the fleet starts with workers still resolving; the run reports how much
// slack was left so the value is checkable rather than assumed.
const WARMUP_MS = Number(process.env.DIAGRAM_FLEET_WARMUP_MS ?? 20_000)
const RUN_TIMEOUT_MS = Number(process.env.DIAGRAM_FLEET_RUN_TIMEOUT_MS ?? 600_000)
// ONE campaign id for the whole fleet. Without it every cross-worker sample is
// discarded by the receiver's run filter.
const RUN_ID = process.env.DIAGRAM_PEER_RUN_ID
  || `fleet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const RATE = Number(process.env.DIAGRAM_PEER_RATE ?? 0)
const DURATION_MS = Number(process.env.DIAGRAM_PEER_DURATION_MS ?? 0)
// Settle margin between the last emit of the campaign and the instant a worker
// is allowed to finalise its head set. Below this the fleet compares snapshots
// taken at different moments and calls ordinary progress a divergence.
const CONVERGE_SETTLE_MS = Number(process.env.DIAGRAM_FLEET_CONVERGE_SETTLE_MS ?? 3_000)
// Aggregate machine CPU. 32 logical cores, a single-threaded server and every
// worker on the same box: a bench saturated by its own harness measures the
// harness, so this has to be KNOWN rather than hoped. 70 % is the ceiling the
// capacity certificate already imposes.
const CPU_SAMPLE_MS = Number(process.env.DIAGRAM_FLEET_CPU_SAMPLE_MS ?? 1_000)
const MAX_CPU_RATIO = Number(process.env.DIAGRAM_FLEET_MAX_CPU_RATIO ?? 0.7)
// K real browser contexts joined to this campaign. They hold the document
// and receive the fan-out, so they COUNT toward `DIAGRAM_FLEET_PEERS`; the Node
// slice shrinks by K. What they do not do is generate load, and the report keeps
// the two numbers apart (`peersOnDocument` vs `loadGeneratingPeers`) precisely so
// "100 peers" can never quietly become "100 browsers".
const BROWSER_OBSERVERS = Math.max(0, Number(process.env.DIAGRAM_FLEET_BROWSER_OBSERVERS ?? 0))

/** Aggregate busy ratio across every logical CPU since the previous call. */
function makeCpuSampler() {
  const read = () => cpus().reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
    return { total: acc.total + total, idle: acc.idle + cpu.times.idle }
  }, { total: 0, idle: 0 })
  let previous = read()
  return () => {
    const current = read()
    const total = current.total - previous.total
    const idle = current.idle - previous.idle
    previous = current
    if (!(total > 0)) return null
    return { at: new Date().toISOString(), busyRatio: Number((1 - idle / total).toFixed(4)) }
  }
}

/** The fleet owns the server's event-loop window, and the workers must not touch
 *  it: `?eventLoopWindow=consume` RESETS the window, so W workers consuming at
 *  both edges would each zero what the others are measuring and every one of
 *  them would report a window of unrelated length. */
async function login() {
  const response = await fetch(`${API}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`dev login returned HTTP ${response.status}`)
  const cookie = (response.headers.get('set-cookie') || '').match(/maplespire_session=[^;]+/)?.[0]
  if (!cookie) throw new Error('dev login did not return the HttpOnly session cookie')
  return cookie
}

async function captureServerLoop(cookie, edge) {
  try {
    const response = await fetch(`${API}/api/automerge/stats?eventLoopWindow=consume`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    return {
      captured: true,
      edge,
      at: new Date().toISOString(),
      eventLoopDelayMs: body?.transport?.eventLoopDelayMs ?? null,
      eventLoopWindow: body?.transport?.eventLoopWindow ?? null,
      // The periodic logger still resets fan-out windows. Qualification loop
      // windows use a separate histogram.
      telemetryIntervalMs: body?.transport?.config?.telemetryIntervalMs ?? null,
      fanoutWindow: body?.transport?.fanoutWindow ?? null,
      syncCpu: body?.transport?.syncCpu ?? null,
      joinedConnections: body?.joinedConnections ?? null,
    }
  } catch (error) {
    return { captured: false, edge, reason: `GET /api/automerge/stats failed: ${error.message}` }
  }
}

function startWorker(index, peers, indexBase, startAt, convergeAt, nodePeers, reportPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER], {
      cwd: dirname(HERE),
      env: {
        ...process.env,
        DIAGRAM_PEERS: String(peers),
        DIAGRAM_PEER_INDEX_BASE: String(indexBase),
        DIAGRAM_PEER_START_AT: String(startAt),
        // No worker may finalise its head set before this instant. Without the
        // barrier the fleet compares snapshots taken at different moments.
        DIAGRAM_PEER_CONVERGE_AT: String(convergeAt),
        // The NODE peer count, not the document's. The runner uses this for the
        // emit phase spread, the global target-pool index space and the expected
        // sample count — and a browser observer contributes to NONE of them: it
        // emits nothing and runs no change-metadata instrument. Passing the
        // document total instead inflated the expected sample count by the
        // browsers and voided a healthy hybrid run at 22.2 % "sample loss"
        // (532/684, i.e. 7 instrumented receivers where 9 were expected).
        DIAGRAM_PEER_TOTAL: String(nodePeers),
        DIAGRAM_PEER_REPORT: reportPath,
        DIAGRAM_PEER_RUN_ID: RUN_ID,
        // The coordinator owns the server window; see captureServerLoop above.
        DIAGRAM_PEER_SERVER_LOOP: 'delegated',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.stdout.resume()
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        resolve({ index, exitCode: code, report: { workerIndex: index, ...JSON.parse(readFileSync(reportPath, 'utf8')) } })
      } catch {
        // No report at all: the worker did not run, which is void, not failed.
        resolve({
          index,
          exitCode: code,
          report: {
            workerIndex: index,
            outcome: 'void',
            voids: [`VOID: worker ${index} produced no report (exit ${code}) ${stderr.trim().slice(0, 240)}`],
            failures: [],
          },
        })
      }
    })
  })
}

/** The browser arm, as a child process on the same window as the workers. */
function startBrowserArm(startAt, reportPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BROWSER_ARM], {
      cwd: dirname(HERE),
      env: {
        ...process.env,
        DIAGRAM_BROWSER_OBSERVERS: String(BROWSER_OBSERVERS),
        DIAGRAM_BROWSER_START_AT: String(startAt),
        DIAGRAM_BROWSER_WINDOW_MS: String(Math.max(1_000, DURATION_MS)),
        DIAGRAM_BROWSER_REPORT: reportPath,
      },
      stdio: ['ignore', 'inherit', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(readFileSync(reportPath, 'utf8')))
      } catch {
        resolve({
          outcome: 'void',
          observers: [],
          requestedObservers: BROWSER_OBSERVERS,
          voids: [`VOID: the browser arm produced no report (exit ${code}) ${stderr.trim().slice(0, 300)}`],
          failures: [],
        })
      }
    })
  })
}

async function main() {
  // The browsers are peers on the document, so they come OUT of the total.
  const nodePeers = TOTAL - BROWSER_OBSERVERS
  if (nodePeers < 1) throw new Error(`DIAGRAM_FLEET_BROWSER_OBSERVERS=${BROWSER_OBSERVERS} leaves no Node peer of DIAGRAM_FLEET_PEERS=${TOTAL}`)
  const workers = Math.min(WORKERS, nodePeers)
  const perWorker = Math.floor(nodePeers / workers)
  if (perWorker < 1) throw new Error(`DIAGRAM_FLEET_WORKERS=${WORKERS} exceeds the ${nodePeers} Node peer(s)`)
  const remainder = nodePeers - perWorker * workers
  const startAt = Date.now() + WARMUP_MS
  const workDir = mkdtempSync(join(tmpdir(), 'ms-fleet-'))

  console.log(`[fleet] ${TOTAL} peers on the document (${nodePeers} Node across ${workers} worker(s)` +
    (BROWSER_OBSERVERS > 0 ? ` + ${BROWSER_OBSERVERS} browser observer(s)` : '') +
    `), campaign ${RUN_ID}, barrier in ${WARMUP_MS} ms`)

  const cookie = await login().catch((error) => {
    console.error(`[fleet] server event-loop capture disabled: ${error.message}`)
    return null
  })

  // Every worker stops emitting at `startAt + DURATION_MS`; the settle margin is
  // what lets the last change reach every other process before anybody freezes
  // its head set.
  const convergeAt = startAt + Math.max(0, DURATION_MS) + CONVERGE_SETTLE_MS

  let results
  let browserReport = null
  let serverLoopOpen = null
  let serverLoopClose = null
  const cpuSamples = []
  let cpuTimer = null
  try {
    let base = 0
    const pending = []
    for (let w = 0; w < workers; w += 1) {
      const peers = perWorker + (w < remainder ? 1 : 0)
      pending.push(startWorker(w, peers, base, startAt, convergeAt, nodePeers, join(workDir, `w${w}.json`)))
      base += peers
    }
    // Launched in the same breath as the workers so its navigation happens
    // inside the same warm-up, and its measured window opens at the same barrier.
    const browserPending = BROWSER_OBSERVERS > 0
      ? startBrowserArm(startAt, join(workDir, 'browser.json'))
      : Promise.resolve(null)
    // Open the server's window AT the barrier, not at spawn: the interval before
    // it is peer connection, which is not the campaign.
    if (cookie) {
      const untilBarrier = startAt - Date.now()
      if (untilBarrier > 0) await new Promise((resolve) => setTimeout(resolve, untilBarrier))
      serverLoopOpen = await captureServerLoop(cookie, 'open')
    }
    // Machine CPU, sampled only across the campaign — sampling the connection
    // phase too would average the quiet warm-up into the busy window and hide
    // exactly the saturation this is here to catch.
    const sampleCpu = makeCpuSampler()
    cpuTimer = setInterval(() => {
      const sample = sampleCpu()
      if (sample) cpuSamples.push(sample)
    }, CPU_SAMPLE_MS)
    cpuTimer.unref?.()
    results = await Promise.all(pending)
    browserReport = await browserPending
    clearInterval(cpuTimer)
    cpuTimer = null
    if (cookie) serverLoopClose = await captureServerLoop(cookie, 'close')
  } finally {
    if (cpuTimer) clearInterval(cpuTimer)
    rmSync(workDir, { recursive: true, force: true })
  }

  const reports = results.map((r) => r.report)
  const failures = []
  const voids = []
  const connected = reports.reduce((sum, r) => sum + (r.connectedPeers ?? 0), 0)
  if (connected !== nodePeers) voids.push(`VOID: only ${connected}/${nodePeers} Node peers connected across the fleet`)

  // The hybrid accounting. `peersOnDocument` counts the browsers because
  // they hold the document and receive the fan-out; `loadGeneratingPeers` does
  // not, because an observer emits nothing. Publishing one without the other is
  // how a bench ends up claiming a regime it never ran.
  const hybrid = BROWSER_OBSERVERS > 0
    ? evaluateHybridCampaign({
      nodePeers: connected,
      observers: (browserReport?.observers ?? []).map((observer) => ({
        ...observer,
        // The arm already evaluated these; re-evaluating from the summary would
        // need the raw entries, so carry its own verdicts through instead.
        longTasks: observer.longTasks > 0 ? [{ startMs: 0, durationMs: observer.longTaskMs?.max ?? 0 }] : [],
        heartbeatGaps: observer.heartbeatGaps ?? [],
      })),
      requestedPeersOnDocument: TOTAL,
      requestedObservers: BROWSER_OBSERVERS,
      livenessBudgetMs: browserReport?.livenessBudgetMs ?? 1_000,
    })
    : null
  if (browserReport && browserReport.outcome === 'void') {
    for (const reason of browserReport.voids ?? []) voids.push(`browser arm: ${reason}`)
  }
  if (hybrid && hybrid.outcome === 'void') {
    for (const reason of hybrid.voids) if (!voids.includes(`browser arm: ${reason}`)) voids.push(reason)
  }

  for (const { index, exitCode, report } of results) {
    if (report.outcome === 'void') {
      voids.push(`worker ${index} (exit ${exitCode}): ${(report.voids ?? ['void']).join('; ').slice(0, 200)}`)
    } else if (report.outcome !== 'passed') {
      failures.push(`worker ${index} (exit ${exitCode}): ${(report.failures ?? ['failed']).join('; ').slice(0, 200)}`)
    }
    const loop = report.harnessEventLoopMs?.p99
    if (Number.isFinite(loop) && loop > MAX_LOOP_P99_MS) {
      voids.push(`VOID: worker ${index}: event-loop p99 ${loop} ms exceeds ${MAX_LOOP_P99_MS} ms — this worker measured itself`)
    }
  }

  // Did every worker attach to the SAME, FRESH document? A per-worker check
  // cannot answer the first half (a worker only sees its own target) and the
  // coordinator is the only place that sees all of them. The gate itself is the
  // expected journal length the campaign was told to require; unset means the
  // witness is published and nothing is refused, which is right for a run aimed
  // at a real diagram and wrong for a campaign — so the campaign sets it.
  const expectedJournal = process.env.DIAGRAM_PEER_EXPECTED_JOURNAL !== undefined
    ? Number(process.env.DIAGRAM_PEER_EXPECTED_JOURNAL)
    : null
  const seedFreshness = evaluateSeedFreshness(
    reports.map((r) => ({
      worker: r.workerIndex,
      documentId: r.seedFreshness?.documentId,
      // The worker's EARLIEST attach, for the reason spelled out in
      // `evaluateSeedFreshness`: a peer arriving after the barrier sees the
      // campaign's own changes, and that is not a stale document.
      changesAtAttach: r.seedFreshness?.changesAtAttach?.min,
      opsAtAttach: r.seedFreshness?.opsAtAttach?.min,
    })),
    { expectedChanges: expectedJournal },
  )
  if (!seedFreshness.ok) voids.push(seedFreshness.reason)

  // The pool is over HISTOGRAMS the workers actually publish. A sample from
  // a peer in worker A to a peer in worker B is cross-process by construction,
  // which is why one shared campaign id is what makes the number mean 100 peers.
  const scope = evaluateFleetRunScope(reports, RUN_ID)
  if (!scope.ok) voids.push(scope.reason)
  const pool = poolWorkerLatency(reports)
  if (pool.reason) voids.push(pool.reason)
  const perWorkerLatency = reports.map((r) => r.convergenceLatencyMs).filter(Boolean)

  // The CROSS-PROCESS convergence check. This is the claim the bench
  // exists to support and it is the one thing a per-worker check structurally
  // cannot make: W workers can each agree with themselves on W different states
  // and every one of them reports success.
  const headConvergence = evaluateGlobalHeadConvergence(reports)
  if (!headConvergence.ok) {
    if (headConvergence.verdict === 'diverged') failures.push(headConvergence.reason)
    else voids.push(headConvergence.reason)
  }

  // The SERVER's loop over the fleet window, published beside the workers'
  // own loops so a client cost is never read as a server cost.
  const serverCaptured = Boolean(serverLoopOpen?.captured && serverLoopClose?.captured)
  if (!serverCaptured) {
    voids.push(`VOID: the server event-loop window was not captured (${serverLoopClose?.reason ?? serverLoopOpen?.reason ?? 'no admin session'})`)
  }
  // Exactly one process may CONSUME the window — every consume resets it, so two
  // consumers destroy each other's measurement and both publish an interval of
  // unrelated length. The workers are told to delegate; this is where that is
  // asserted rather than assumed.
  const ownership = evaluateServerWindowOwnership(reports, { coordinatorCaptured: serverCaptured })
  if (!ownership.ok) voids.push(ownership.reason)
  // Captured is not COVERING: another explicit consumer can reset the
  // qualification window halfway through the campaign.
  const windowCoverage = serverCaptured
    ? evaluateServerWindowCoverage({
      openedAtMs: Date.parse(serverLoopOpen.at),
      closedAtMs: Date.parse(serverLoopClose.at),
      windowStartedAtMs: Date.parse(serverLoopClose?.eventLoopWindow?.startedAt ?? ''),
    })
    : { ok: false, verdict: 'uncaptured', truncatedMs: null, reason: null }
  if (serverCaptured && !windowCoverage.ok) voids.push(windowCoverage.reason)

  // Is the MACHINE the bottleneck rather than the server? A bench that has to
  // hope is a bench that will one day publish its own saturation as a result.
  const saturation = evaluateMachineSaturation(cpuSamples, { maxRatio: MAX_CPU_RATIO })
  if (!saturation.ok) voids.push(saturation.reason)

  // Leg [A] pooled across the fleet, from the same histograms — the emitting
  // clients' cost, never folded into the end-to-end number.
  const emitHistograms = reports.map((r) => r.emitHistogram).filter((h) => h && Number(h.count) > 0)
  const pooledEmit = emitHistograms.length > 0 ? summarizeHistogram(mergeLatencyHistograms(emitHistograms)) : null

  const report = {
    startedAt: new Date().toISOString(),
    runId: RUN_ID,
    totalPeers: TOTAL,
    workers,
    connectedPeers: connected,
    // The hybrid split, published even when the browser arm is off, so a
    // reader never has to infer which peers generated the load.
    hybrid: hybrid ?? {
      peersOnDocument: connected,
      loadGeneratingPeers: connected,
      browserObservers: 0,
      shape: 'node-only: no browser observer was requested',
    },
    browserArm: browserReport
      ? {
        outcome: browserReport.outcome,
        requestedObservers: browserReport.requestedObservers,
        // Leg [C] and the felt cost, per observer — the CLIENT side, kept out of
        // every server number in this report.
        observers: (browserReport.observers ?? []).map((observer) => ({
          index: observer.index,
          inboundFrames: observer.inboundFrames,
          inboundBytes: observer.inboundBytes,
          receiveMs: observer.receiveMs,
          longTaskMs: observer.longTaskMs,
          longTasks: observer.longTasks,
          livenessGaps: (observer.heartbeatGaps ?? []).length,
        })),
        voids: browserReport.voids ?? [],
      }
      : null,
    runScope: scope,
    // One document, and it carried nothing but its seed when the peers
    // arrived. Published on every run, void or not.
    seedFreshness,
    workerRegistryDiagrams: reports.map((r) => r.registryDiagrams ?? null),
    workerLatency: perWorkerLatency,
    // The sample-loss witness at fleet scale: with the change-metadata
    // instrument this is expected to be 0.
    workerSampleLoss: reports.map((r) => r.sampleLoss ?? null),
    // The workers' clock estimates, published rather than discarded. Without
    // them a fleet that voids on "clock offset" gives a reader the verdict and
    // withholds the evidence — and the evidence is what says whether the offset
    // is a clock (impossible here: one machine, one wall clock) or the round trip
    // of 13 processes probing a single-threaded server in the same instant.
    workerClock: reports.map((r) => (r.clock
      ? { worker: r.workerIndex, ok: r.clock.ok, offsetMs: r.clock.offsetMs, driftMs: r.clock.driftMs, open: r.clock.open, close: r.clock.close }
      : null)),
    workerInstrumentCost: reports.map((r) => r.instrumentCost ?? null),
    pooledLatency: pool.pooled,
    // Leg [A] — the emitting CLIENTS' own cost, pooled. Beside the end-to-end
    // number, never inside it: a slow emitter and a slow server are two
    // different findings and one of them is not about the server at all.
    pooledEmitMs: pooledEmit,
    pooledFrom: { workers: pool.workersPooled, missing: pool.workersMissing },
    // The check no worker can perform for itself.
    globalHeadConvergence: {
      ...headConvergence,
      workerHeadSets: reports.map((r) => ({
        worker: r.workerIndex,
        stable: r.convergence?.headStable ?? null,
        heads: r.convergence?.headSet ?? null,
      })),
      barrierAt: new Date(convergeAt).toISOString(),
    },
    machineCpu: { ...saturation, samples: cpuSamples.length, sampleIntervalMs: CPU_SAMPLE_MS, logicalCpus: cpus().length },
    // The two loops, side by side and never conflated.
    workerEventLoopP99Ms: reports.map((r) => r.harnessEventLoopMs?.p99 ?? null),
    serverEventLoop: {
      captured: serverCaptured,
      reason: serverCaptured ? null : (serverLoopClose?.reason ?? serverLoopOpen?.reason ?? 'no admin session'),
      windowOpenedAt: serverLoopOpen?.at ?? null,
      windowClosedAt: serverLoopClose?.at ?? null,
      // Who consumed, and whether the window the server handed back covers the
      // campaign or a fragment of it.
      ownership,
      windowCoverage,
      serverWindow: serverLoopClose?.eventLoopWindow ?? null,
      serverTelemetryIntervalMs: serverLoopClose?.telemetryIntervalMs ?? serverLoopOpen?.telemetryIntervalMs ?? null,
      eventLoopDelayMs: serverLoopClose?.eventLoopDelayMs ?? null,
      fanoutWindow: serverLoopClose?.fanoutWindow ?? null,
      syncCpuDelta: serverLoopOpen?.syncCpu && serverLoopClose?.syncCpu
        ? {
          receiveCount: serverLoopClose.syncCpu.receiveCount - serverLoopOpen.syncCpu.receiveCount,
          generateCount: serverLoopClose.syncCpu.generateCount - serverLoopOpen.syncCpu.generateCount,
          receiveTotalMs: Number((serverLoopClose.syncCpu.receiveTotalMs - serverLoopOpen.syncCpu.receiveTotalMs).toFixed(2)),
          generateTotalMs: Number((serverLoopClose.syncCpu.generateTotalMs - serverLoopOpen.syncCpu.generateTotalMs).toFixed(2)),
        }
        : null,
      joinedConnections: serverLoopClose?.joinedConnections ?? null,
    },
    outcome: voids.length > 0 ? 'void' : (failures.length > 0 ? 'failed' : 'passed'),
    failures,
    voids,
  }

  console.log('\nworker | peers | p50 | p95 | p99 | samples | loop p99')
  console.log('-------+-------+-----+-----+-----+---------+---------')
  for (const { index, report: r } of results) {
    const l = r.convergenceLatencyMs ?? {}
    console.log(
      `${String(index).padStart(6)} | ${String(r.connectedPeers ?? '-').padStart(5)} | ${String(l.p50 ?? '-').padStart(3)} | ` +
      `${String(l.p95 ?? '-').padStart(3)} | ${String(l.p99 ?? '-').padStart(3)} | ${String(l.count ?? 0).padStart(7)} | ` +
      `${String(r.harnessEventLoopMs?.p99 ?? '-').padStart(8)}`,
    )
  }
  // Print from the REDACTED report, not from the raw one: a void fleet that
  // shows quantiles on the terminal and withholds them in the file has still
  // published them, and the terminal is where they get copied from.
  const published = redactVoidQuantiles(report)
  const p = published.pooledLatency
  console.log(
    `\n[fleet] pooled over ${pool.workersPooled}/${workers} worker histogram(s): ` +
    (p
      ? `${p.count} samples, p50 ${p.p50} ms, p95 ${p.p95} ms, p99 ${p.p99} ms (±${(p.quantileRelativeError * 100).toFixed(1)}% bucketing)`
      : (report.outcome === 'void' ? 'WITHHELD (run is void)' : 'NONE')),
  )
  console.log(
    `[fleet] SERVER cost: loop p99 ${report.serverEventLoop.eventLoopDelayMs?.p99 ?? '-'} ms, ` +
    `generate ${report.serverEventLoop.syncCpuDelta?.generateTotalMs ?? '-'} ms over ` +
    `${report.serverEventLoop.syncCpuDelta?.generateCount ?? '-'} calls, ` +
    `fan-out max recipients ${report.serverEventLoop.fanoutWindow?.maxRecipientsPerDocument ?? '-'}`,
  )
  console.log(
    `[fleet] CLIENT cost: emit p99 ${published.pooledEmitMs?.p99 ?? '-'} ms | ` +
    `worst worker loop p99 ${Math.max(0, ...report.workerEventLoopP99Ms.filter(Number.isFinite))} ms` +
    (report.browserArm
      ? ` | browser receive p99 ${Math.max(0, ...report.browserArm.observers.map((o) => o.receiveMs?.p99 ?? 0))} ms, ` +
        `long task p99 ${Math.max(0, ...report.browserArm.observers.map((o) => o.longTaskMs?.p99 ?? 0))} ms`
      : ''),
  )
  if (report.browserArm) {
    console.log(
      `[fleet] hybrid: ${report.hybrid.peersOnDocument} peers ON the document = ` +
      `${report.hybrid.loadGeneratingPeers} Node (generating) + ${report.hybrid.browserObservers} browser (observing)`,
    )
  }
  console.log(
    `[fleet] subject: document ${seedFreshness.documentId ?? '-'} — ${seedFreshness.verdict}, ` +
    `journal at attach ${seedFreshness.changesAtAttach?.min ?? '-'} change(s) / ${seedFreshness.opsAtAttach?.min ?? '-'} op(s)` +
    (expectedJournal === null ? ' (ungated)' : ` (gate <= ${expectedJournal})`),
  )
  console.log(
    `[fleet] cross-process convergence: ${headConvergence.verdict} ` +
    `(${headConvergence.distinctHeadSets} head set(s) over ${workers} worker(s)) | ` +
    `machine CPU peak ${saturation.peakRatio === null ? '-' : `${(saturation.peakRatio * 100).toFixed(1)}%`} ` +
    `over ${cpuSamples.length} sample(s) of ${cpus().length} logical CPUs | ` +
    `server window ${report.serverEventLoop.windowCoverage.verdict}`,
  )

  if (REPORT_PATH) {
    writeFileSync(REPORT_PATH, JSON.stringify(published, null, 2), 'utf8')
    console.log(`\n[fleet] report written to ${REPORT_PATH}`)
  }

  if (voids.length > 0) {
    console.error('')
    for (const reason of voids) console.error(`[fleet] VOID ${reason}`)
    for (const failure of failures) console.error(`[fleet] (also) FAIL ${failure}`)
    console.error(`[fleet] VOID — no result about the server; quantiles withheld`)
    return exitCodeForOutcome('void')
  }
  if (failures.length > 0) {
    console.error('')
    for (const failure of failures) console.error(`[fleet] FAIL ${failure}`)
    return exitCodeForOutcome('failed')
  }
  console.log(`\n[fleet] PASS ${TOTAL} peers on the document (${nodePeers} Node across ${workers} worker(s)` +
    (BROWSER_OBSERVERS > 0 ? ` + ${BROWSER_OBSERVERS} browser observer(s)` : '') +
    '), one campaign, no worker saturated, one head set across processes')
  return exitCodeForOutcome('passed')
}

main()
  .catch((error) => {
    console.error(`[fleet] VOID harness error: ${error?.stack ?? error}`)
    return exitCodeForOutcome('void')
  })
  .then((code) => process.exit(code ?? 1))
