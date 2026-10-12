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

// Diagram peer tier sweep — sweep the peer tiers HONESTLY.
//
//   DIAGRAM_TIERS=25,50,100 DIAGRAM_TIER_RUNS=3 DIAGRAM_TIER_WORKERS=10 \
//   DIAGRAM_PEER_ID=t1-bench DIAGRAM_PEER_RATE=1 DIAGRAM_PEER_DURATION_MS=30000 \
//   node scripts/verify-diagram-peer-tiers.mjs
//
// Each rule below closes a way a sweep could publish a curve that is not one.
//
// 1. IT DRIVES THE FLEET, NOT THE RUNNER. The single-process runner costs about
//    26 ms per emit burst at 10 peers, 512 ms at 50 and 3 653 ms at 100, so past
//    ~25 peers it measures its own event loop and the harness gate would
//    (correctly) void the top tiers.
// 2. THE WORKER COUNT IS CONSTANT ACROSS TIERS. Comparing "25 peers in one
//    process" with "100 peers in ten" moves two variables at once, which is the
//    control that settles nothing. Only the peer count varies.
// 3. THE ARMS ARE INTERLEAVED AND THE ORDER IS PUBLISHED. Sequential tiers make
//    "tier" a synonym for "elapsed time": warm-up, PostgreSQL growth and any
//    other worktree's activity all get billed to the last tier, which is the one
//    the goal is about.
// 4. AN A/A CALIBRATION RUNS INSIDE THE SAME INTERLEAVING. Two arms of the
//    IDENTICAL configuration, and the sweep is void unless the bench answers
//    "no difference" between them. That measurement is the noise floor, and
//    every spread verdict is judged against it rather than against a constant
//    that happened to sit at the level of the noise. `minimumDetectableRatio` is
//    published in the report so a reader can see what this bench can and cannot
//    support (a small gain inside the noise floor is inconclusive by
//    construction).
// 5. A FRESH DIAGRAM PER *RUN*, NOT PER CAMPAIGN. Otherwise the subject GROWS
//    WHILE IT IS MEASURED: every run leaves N x rate x seconds changes in the
//    document's journal and the next run pays for them (an identical 25-peer
//    configuration has been seen to go from p99 = 42 ms to over 650 ms this
//    way). Interleaving balances a drift ACROSS arms; it does nothing
//    about an accumulation INSIDE the subject. So each run is handed a diagram
//    minted for it, and the witness (`seedFreshness`) makes that an assertion —
//    a document id per run, a journal length at attach, both published.
//
// Exit codes: 0 = passed, 1 = failed, 2 = void.

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, hostname, tmpdir, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  evaluateAaCalibration,
  evaluateRunSeedRotation,
  evaluateTierTable,
  exitCodeForOutcome,
  planInterleavedRuns,
  summarizeTier,
} from '../qa/diagramPeersCore.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FLEET = join(HERE, 'verify-diagram-peer-fleet.mjs')
const RUNNER = join(HERE, 'verify-diagram-peer-load.mjs')

const TIERS = (process.env.DIAGRAM_TIERS ?? '25,50,100')
  .split(',').map((t) => Number(t.trim())).filter((t) => Number.isInteger(t) && t > 0)
const RUNS = Math.max(1, Number(process.env.DIAGRAM_TIER_RUNS ?? 3))
// Constant across every tier — see (2) above. Defaults to the largest tier / 10,
// i.e. ten peers a worker, the ratio the fleet's own measurements were taken at.
const WORKERS = Math.max(1, Number(process.env.DIAGRAM_TIER_WORKERS ?? Math.max(1, Math.ceil(Math.max(...TIERS, 1) / 10))))
const MAX_SPREAD = Number(process.env.DIAGRAM_TIER_MAX_SPREAD ?? 1.5)
const REPORT_PATH = process.env.DIAGRAM_TIER_REPORT || undefined
// The A/A runs at ONE tier, and by default the smallest: the floor has to be
// measurable, and a calibration that itself saturates the machine measures the
// machine. Its two arms are identical by construction — that is the point.
const CALIBRATION_TIER = Number(process.env.DIAGRAM_TIER_CALIBRATION_PEERS ?? Math.min(...TIERS))
const CALIBRATION = process.env.DIAGRAM_TIER_CALIBRATION !== 'off'
// A run's own budget. A tier that cannot finish inside it is reported as VOID
// rather than left to hang the sweep.
const RUN_TIMEOUT_MS = Number(process.env.DIAGRAM_TIER_RUN_TIMEOUT_MS ?? 600_000)
// One freshly minted diagram per RUN. Off is allowed, and then the sweep
// says so in its report and in its verdict: the numbers it would publish are
// contaminated by whatever the previous runs left in the journal.
const FRESH_SEED = process.env.DIAGRAM_TIER_FRESH_SEED !== 'off'
const SEED_SHAPES = Number(process.env.DIAGRAM_PEER_SEED_SHAPES ?? 500)
const SEED_CONNECTIONS = Number(process.env.DIAGRAM_PEER_SEED_CONNECTIONS ?? 800)
const SEED_TIMEOUT_MS = Number(process.env.DIAGRAM_TIER_SEED_TIMEOUT_MS ?? 180_000)
// The CONTROL for the freshness protocol itself: an arm whose runs all share ONE
// document, so the journal it accumulates is the independent variable. It shows
// that per-run seeding still matters on this commit. It runs at the
// calibration tier and inside the same interleaving.
const REUSED_ARM = process.env.DIAGRAM_TIER_REUSED_ARM === '1'
// Which tier the control runs at. It defaults to the calibration tier, but the
// effect it exists to expose is journal LENGTH, and a small tier accumulates
// slowly (5 peers x 30 s leave ~150 changes a run where 25 peers leave ~750), so
// a control placed too low can come back inconclusive for want of signal rather
// than for want of an effect.
const REUSED_TIER = Number(process.env.DIAGRAM_TIER_REUSED_PEERS ?? CALIBRATION_TIER)

const commitSha = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dirname(HERE), encoding: 'utf8' }).trim()
  } catch {
    // A sweep with no commit id is still a sweep; it just cannot be compared
    // with another one, and saying so is better than inventing a sha.
    return null
  }
})()

/** Mint a diagram for ONE run and return what it minted.
 *
 * The freshness of the subject is the single most consequential thing about this
 * campaign (see (5) above), and "a unique name each time" is only an
 * intention. What comes back here — a document id and the journal length its own
 * creator observed — is what turns it into an assertion, because the sweep can
 * then refuse two runs that shared a document and the fleet can refuse a document
 * that already carried changes.
 */
function seedForRun(label, run, reportPath) {
  const diagramId = `t1r8-${label}-r${run}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER], {
      cwd: dirname(HERE),
      env: {
        ...process.env,
        DIAGRAM_PEER_SEED: '1',
        DIAGRAM_PEER_SEED_NAME: diagramId,
        DIAGRAM_PEER_SEED_SHAPES: String(SEED_SHAPES),
        DIAGRAM_PEER_SEED_CONNECTIONS: String(SEED_CONNECTIONS),
        // A campaign may never be handed an existing diagram under this name.
        DIAGRAM_PEER_SEED_FRESH: '1',
        DIAGRAM_PEER_SEED_REPORT: reportPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.stdout.resume()
    const timer = setTimeout(() => child.kill('SIGKILL'), SEED_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        const seed = JSON.parse(readFileSync(reportPath, 'utf8'))
        if (!seed?.documentId || !seed?.minted) throw new Error('seed report carries no minted document')
        resolve({ ok: true, ...seed })
      } catch (error) {
        // A run whose subject could not be minted did not happen. VOID — and
        // emphatically not "the server was slow", which is what a failure here
        // would look like once it reached the tier table.
        resolve({
          ok: false,
          diagramId,
          reason: `VOID: could not mint a fresh diagram for ${label} run ${run} (exit ${code}): ${(stderr.trim() || error.message).slice(0, 300)}`,
        })
      }
    })
  })
}

/** One fleet campaign at `peers`, in its own process.
 *
 * A fresh process per run is not a detail: reusing one would make run 1 cold and
 * runs 2-3 warm, which invalidates the comparison.
 */
function runOnce(peers, label, reportPath, seed) {
  const env = {
    ...process.env,
    DIAGRAM_FLEET_PEERS: String(peers),
    DIAGRAM_FLEET_WORKERS: String(Math.min(WORKERS, peers)),
    DIAGRAM_FLEET_REPORT: reportPath,
    // One campaign id per RUN. Sharing it across runs would let a previous
    // run's markers seed this one's watermarks.
    DIAGRAM_PEER_RUN_ID: `${label}-${peers}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  }
  // The subject of THIS run, and the journal length it is allowed to carry.
  // The gate is only set for a run minted for itself; the deliberately-reused
  // control arm PUBLISHES its journal rather than being refused for it, which is
  // the whole point of having the arm. Deleting rather than omitting, because an
  // inherited value from the caller's shell would gate the control arm too.
  if (seed?.diagramId) env.DIAGRAM_PEER_ID = seed.diagramId
  if (Number.isFinite(seed?.seedChanges) && !seed?.reused) env.DIAGRAM_PEER_EXPECTED_JOURNAL = String(seed.seedChanges)
  else delete env.DIAGRAM_PEER_EXPECTED_JOURNAL
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FLEET], {
      cwd: dirname(HERE),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.stdout.resume()
    const timer = setTimeout(() => { child.kill('SIGKILL') }, RUN_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      let report = null
      try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'))
      } catch {
        // No report means the run died before it could answer. VOID, not failed:
        // the tier must not look green by having fewer runs, and must not look
        // SLOW either, which is what `failed` would suggest.
        report = { outcome: 'void', voids: [`VOID: no report (exit ${code}): ${stderr.trim().slice(0, 300)}`], failures: [] }
      }
      // The fleet publishes `pooledLatency`; the tier machinery reads
      // `convergenceLatencyMs`. Map it here rather than teaching every consumer
      // two names — and keep the fleet's own field so nothing is hidden.
      resolve({
        ...report,
        convergenceLatencyMs: report.pooledLatency ?? null,
        harnessEventLoopMs: {
          p99: Math.max(0, ...(report.workerEventLoopP99Ms ?? []).filter(Number.isFinite)),
        },
      })
    })
  })
}

async function main() {
  if (TIERS.length === 0) throw new Error('DIAGRAM_TIERS produced no usable tier')
  const workDir = mkdtempSync(join(tmpdir(), 'ms-tiers-'))

  // The arms: every tier, the two A/A arms, and (optionally) the reused-document
  // control — all in ONE interleaving.
  const REUSED_LABEL = `reused-${REUSED_TIER}`
  const arms = [
    ...TIERS.map((tier) => ({ tier, label: `tier-${tier}` })),
    ...(CALIBRATION ? [{ tier: CALIBRATION_TIER, label: 'aa-A' }, { tier: CALIBRATION_TIER, label: 'aa-B' }] : []),
    ...(REUSED_ARM ? [{ tier: REUSED_TIER, label: REUSED_LABEL }] : []),
  ]
  const plan = planInterleavedRuns(arms, RUNS)
  console.log(`[tiers] ${TIERS.join(', ')} peers x ${RUNS} run(s), ${WORKERS} worker(s) at EVERY tier` +
    (CALIBRATION ? `, plus an A/A calibration at ${CALIBRATION_TIER}` : ', WITHOUT calibration') +
    (REUSED_ARM ? `, plus a REUSED-document control at ${REUSED_TIER}` : ''))
  console.log(`[tiers] subject: ${FRESH_SEED ? `a diagram minted per RUN (${SEED_SHAPES} shapes / ${SEED_CONNECTIONS} connections)` : 'NOT minted per run — DIAGRAM_TIER_FRESH_SEED=off'}`)
  console.log(`[tiers] executed order: ${plan.map((entry) => entry.label).join(' -> ')}`)

  const byLabel = new Map()
  const executed = []
  const runSeeds = []
  // The control arm's document is minted ONCE and then deliberately re-served, so
  // its journal is the variable under test.
  let reusedSeed = null
  try {
    for (const entry of plan) {
      const reportPath = join(workDir, `${entry.label}-r${entry.run}.json`)
      process.stdout.write(`[tiers] #${entry.position + 1}/${plan.length} ${entry.label} (${entry.tier} peers), run ${entry.run}/${RUNS} … `)
      const startedAt = new Date().toISOString()

      // ── the subject, minted for this run ──
      let seed = null
      if (FRESH_SEED) {
        const isReused = entry.label === REUSED_LABEL
        if (isReused && reusedSeed) {
          seed = { ...reusedSeed, reused: true }
        } else {
          seed = await seedForRun(entry.label, entry.run, join(workDir, `seed-${entry.label}-r${entry.run}.json`))
          if (isReused && seed.ok) reusedSeed = seed
          if (isReused) seed = { ...seed, reused: true }
        }
        if (!seed.ok) {
          console.log(`VOID — ${seed.reason}`)
          const voidReport = { outcome: 'void', voids: [seed.reason], failures: [] }
          if (!byLabel.has(entry.label)) byLabel.set(entry.label, [])
          byLabel.get(entry.label).push(voidReport)
          executed.push({ ...entry, startedAt, outcome: 'void', p99: null, documentId: null })
          runSeeds.push({ label: entry.label, run: entry.run, documentId: null })
          continue
        }
        runSeeds.push({ label: entry.label, run: entry.run, documentId: seed.documentId, diagramId: seed.diagramId, reused: Boolean(seed.reused) })
      }

      const report = await runOnce(entry.tier, entry.label, reportPath, seed)
      const latency = report?.convergenceLatencyMs
      if (report.outcome === 'passed') {
        console.log(`passed — p50 ${latency?.p50} ms, p99 ${latency?.p99} ms, ${latency?.count} samples` +
          `, journal at attach ${report.seedFreshness?.changesAtAttach?.min ?? '-'}`)
      } else if (report.outcome === 'void') {
        console.log(`VOID — ${(report.voids ?? []).join('; ').slice(0, 160)}`)
      } else {
        console.log(`FAILED — ${(report.failures ?? []).join('; ').slice(0, 160)}`)
      }
      if (!byLabel.has(entry.label)) byLabel.set(entry.label, [])
      byLabel.get(entry.label).push(report)
      // The order actually executed, published verbatim — an interleaving nobody
      // can check is an interleaving nobody should believe.
      executed.push({
        ...entry,
        startedAt,
        outcome: report.outcome,
        p99: latency?.p99 ?? null,
        documentId: seed?.documentId ?? null,
        journalAtAttach: report.seedFreshness?.changesAtAttach?.max ?? null,
        opsAtAttach: report.seedFreshness?.opsAtAttach?.max ?? null,
      })
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }

  // Every run got its OWN document, and the sweep says so from the record
  // rather than from the naming scheme that was supposed to guarantee it.
  const rotation = FRESH_SEED
    ? evaluateRunSeedRotation(runSeeds, { reusedLabels: REUSED_ARM ? [REUSED_LABEL] : [] })
    : {
      ok: false,
      documentIds: [],
      reused: [],
      reason: 'VOID: DIAGRAM_TIER_FRESH_SEED=off — every run after the first measured the journal its predecessors wrote, and no interleaving removes that from an absolute number',
    }

  // The A/A verdict, from the two arms that ran the identical configuration.
  const armP99 = (label) => (byLabel.get(label) ?? [])
    .filter((report) => report.outcome === 'passed')
    .map((report) => report.convergenceLatencyMs?.p99)
    .filter((value) => Number.isFinite(value))
  const calibration = CALIBRATION
    ? {
      ...evaluateAaCalibration({ armA: armP99('aa-A'), armB: armP99('aa-B') }),
      peers: CALIBRATION_TIER,
      commitSha,
      voidRuns: [...(byLabel.get('aa-A') ?? []), ...(byLabel.get('aa-B') ?? [])].filter((r) => r.outcome === 'void').length,
    }
    : null
  if (calibration && calibration.voidRuns > 0 && calibration.ok) {
    // A calibration whose arms are partly void has fewer runs than it claims,
    // so its floor is estimated from an execution nobody observed.
    calibration.ok = false
    calibration.verdict = 'insufficient'
    calibration.reason = `VOID: ${calibration.voidRuns} A/A calibration run(s) were void, so the noise floor rests on runs that did not happen`
  }

  const rows = TIERS.map((tier) => summarizeTier(tier, byLabel.get(`tier-${tier}`) ?? []))
  const evaluation = evaluateTierTable(rows, {
    maxSpreadRatio: MAX_SPREAD,
    calibration,
    requireCalibration: true,
  })
  // The freshness of the subject is a VOID condition of the whole sweep, not of
  // one tier: if two runs shared a document, the affected numbers are spread
  // across whichever arms happened to follow each other.
  if (!rotation.ok) {
    evaluation.voids = [...(evaluation.voids ?? []), rotation.reason]
    evaluation.reasons = [...evaluation.voids, ...evaluation.failures]
    evaluation.outcome = 'void'
  }
  // The reused-document control, when it ran: same tier, same interleaving, one
  // document across its runs. Its journal length per run IS the variable.
  const control = REUSED_ARM
    ? {
      label: REUSED_LABEL,
      peers: REUSED_TIER,
      ...summarizeTier(REUSED_TIER, byLabel.get(REUSED_LABEL) ?? []),
      journalAtAttach: executed.filter((e) => e.label === REUSED_LABEL).map((e) => e.journalAtAttach ?? null),
      opsAtAttach: executed.filter((e) => e.label === REUSED_LABEL).map((e) => e.opsAtAttach ?? null),
      documentId: reusedSeed?.documentId ?? null,
    }
    : null

  const fmtRange = (range) => (range ? `${range.min}-${range.max}` : '-')
  console.log('\npeers | runs | pass | void | p50 med [range]      | p99 med [range]      | spread | worst loop')
  console.log('------+------+------+------+----------------------+----------------------+--------+-----------')
  for (const row of rows) {
    console.log(
      `${String(row.peers).padStart(5)} | ${String(row.runs).padStart(4)} | ${String(row.passed).padStart(4)} | ` +
      `${String(row.voided ?? 0).padStart(4)} | ` +
      `${`${row.latencyP50Median ?? '-'} [${fmtRange(row.latencyP50Range)}]`.padEnd(20)} | ` +
      `${`${row.latencyP99Median ?? '-'} [${fmtRange(row.latencyP99Range)}]`.padEnd(20)} | ` +
      `${String(row.latencyP99SpreadRatio ?? '-').padStart(6)} | ` +
      `${String(row.harnessEventLoopP99Ms ?? '-').padStart(10)}`,
    )
  }
  if (calibration) {
    console.log(
      `\n[tiers] A/A at ${CALIBRATION_TIER} peers: ${calibration.verdict} — ` +
      `arm A median ${calibration.armAMedian ?? '-'} ms [${calibration.armA.join(', ') || '-'}], ` +
      `arm B median ${calibration.armBMedian ?? '-'} ms [${calibration.armB.join(', ') || '-'}], ` +
      `observed ratio ${calibration.observedRatio ?? '-'}x`,
    )
    console.log(
      `[tiers] minimumDetectableRatio = ${calibration.minimumDetectableRatio}x ` +
      `(${calibration.minimumDetectableRatioBasis}); exact permutation floor p=${calibration.permutationFloorP} ` +
      `at ${calibration.runsPerArm} run(s) an arm` +
      (calibration.separationRequired ? ' — so only COMPLETE SEPARATION of two arms is claimable, never a p-value' : ''),
    )
  }

  if (control) {
    console.log(
      `\n[tiers] REUSED-document control at ${REUSED_TIER} peers (${control.passed}/${control.runs} usable): ` +
      `p99 median ${control.latencyP99Median ?? '-'} ms [${fmtRange(control.latencyP99Range)}], ` +
      `journal at attach ${control.journalAtAttach.join(' -> ')} change(s)`,
    )
  }
  console.log(
    `[tiers] subject freshness: ${rotation.ok
      ? `${rotation.documentIds.length} distinct document(s) for ${runSeeds.filter((entry) => !entry.reused).length} rotating run(s)` +
        (REUSED_ARM ? `, plus ${runSeeds.filter((entry) => entry.reused).length} declared control run(s) on ONE document` : '')
      : rotation.reason}`,
  )

  const report = {
    startedAt: new Date().toISOString(),
    commitSha,
    tiers: TIERS,
    runsPerTier: RUNS,
    workersPerRun: WORKERS,
    // The fresh-seed protocol's own claim, with its witness attached.
    freshSeed: {
      enabled: FRESH_SEED,
      shapes: SEED_SHAPES,
      connections: SEED_CONNECTIONS,
      perRun: runSeeds,
      rotation,
      control,
    },
    // Published so a dev-stack sweep can never be quoted as a certified one.
    environment: {
      host: hostname(),
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      api: process.env.DIAGRAM_PEER_API ?? 'http://localhost:3021',
      // With per-run seeding there is no single diagram id, and printing the
      // caller's stale `DIAGRAM_PEER_ID` here would name a document no run used.
      diagramId: FRESH_SEED ? 'minted per run — see freshSeed.perRun' : (process.env.DIAGRAM_PEER_ID ?? null),
      contention: process.env.DIAGRAM_PEER_CONTENTION ?? 'shared',
      ratePerSecondPerPeer: Number(process.env.DIAGRAM_PEER_RATE ?? 0),
      durationMs: Number(process.env.DIAGRAM_PEER_DURATION_MS ?? 0),
    },
    executionOrder: executed,
    calibration,
    rows,
    ...evaluation,
  }
  if (REPORT_PATH) {
    writeFileSync(REPORT_PATH, JSON.stringify({ ...report, runsByLabel: Object.fromEntries(byLabel) }, null, 2), 'utf8')
    console.log(`\n[tiers] report written to ${REPORT_PATH}`)
  }

  if (evaluation.outcome === 'void') {
    console.error('')
    for (const reason of evaluation.voids ?? []) console.error(`[tiers] VOID ${reason}`)
    for (const failure of evaluation.failures) console.error(`[tiers] (also) FAIL ${failure}`)
    console.error('[tiers] VOID — the sweep is not a curve; the incomplete tiers are named above')
    return exitCodeForOutcome('void')
  }
  if (evaluation.outcome !== 'passed') {
    console.error('')
    for (const failure of evaluation.failures) console.error(`[tiers] FAIL ${failure}`)
    return exitCodeForOutcome('failed')
  }
  console.log('\n[tiers] PASS every tier ran clean, its runs agree above the calibrated floor, and the A/A found no difference')
  return exitCodeForOutcome('passed')
}

main()
  .catch((error) => {
    console.error(`[tiers] VOID harness error: ${error?.stack ?? error}`)
    return exitCodeForOutcome('void')
  })
  .then((code) => process.exit(code ?? 1))
