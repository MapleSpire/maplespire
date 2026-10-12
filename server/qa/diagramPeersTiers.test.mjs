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

// The rules that make a TIER SWEEP readable: interleaving, the run (not the
// sample) as the statistical unit, an A/A floor, and the global witnesses the
// per-worker checks structurally cannot provide.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeMinimumDetectableRatio,
  evaluateAaCalibration,
  evaluateGlobalHeadConvergence,
  evaluateMachineSaturation,
  evaluatePeerLoadResult,
  evaluateRunSeedRotation,
  evaluateSeedFreshness,
  evaluateServerWindowCoverage,
  evaluateServerWindowOwnership,
  evaluateTargetCoverage,
  evaluateTierTable,
  planInterleavedRuns,
  redactVoidQuantiles,
  summarizeTier,
} from './diagramPeersCore.mjs'

// ── Interleaving: a tier must not also be "elapsed time" ──

test('planInterleavedRuns runs every tier once per round, never a tier back to back', () => {
  const plan = planInterleavedRuns([25, 50, 100], 3)
  assert.equal(plan.length, 9)
  for (const tier of [25, 50, 100]) {
    assert.equal(plan.filter((entry) => entry.tier === tier).length, 3, `tier ${tier} runs 3 times`)
  }
  for (let i = 1; i < plan.length; i += 1) {
    assert.notEqual(plan[i].tier, plan[i - 1].tier, `position ${i} repeats tier ${plan[i].tier}`)
  }
})

test('planInterleavedRuns balances each tier across the sweep, so drift is not billed to one tier', () => {
  const plan = planInterleavedRuns([25, 50, 100], 3)
  const meanPosition = (tier) => {
    const positions = plan.filter((entry) => entry.tier === tier).map((entry) => entry.position)
    return positions.reduce((sum, p) => sum + p, 0) / positions.length
  }
  const means = [25, 50, 100].map(meanPosition)
  // Sequential execution gives means 1, 4, 7 — a spread of 6 over 9 slots.
  // Interleaving with rotation must keep every tier near the middle.
  assert.ok(Math.max(...means) - Math.min(...means) <= 1.5,
    `tier mean positions ${means.join(', ')} are not balanced`)
})

test('planInterleavedRuns rotates the round order so no tier is always first', () => {
  const plan = planInterleavedRuns([25, 50, 100], 3)
  const firstOfEachRound = [0, 1, 2].map((round) => plan.find((entry) => entry.round === round).tier)
  assert.equal(new Set(firstOfEachRound).size, 3, 'the same tier opened every round')
})

test('planInterleavedRuns with one tier still produces the requested runs', () => {
  const plan = planInterleavedRuns([50], 3)
  assert.deepEqual(plan.map((entry) => entry.tier), [50, 50, 50])
})

test('planInterleavedRuns carries the A/A arms, which share a peer count but not a label', () => {
  // The calibration arms have to be interleaved WITH the sweep. Run them before
  // or after and the floor describes a different stretch of the machine's day
  // than the curve it is supposed to bound.
  const plan = planInterleavedRuns([
    { tier: 25, label: 'tier-25' },
    { tier: 100, label: 'tier-100' },
    { tier: 25, label: 'aa-A' },
    { tier: 25, label: 'aa-B' },
  ], 2)
  assert.equal(plan.length, 8)
  assert.equal(plan.filter((entry) => entry.label === 'aa-A').length, 2)
  assert.equal(plan.filter((entry) => entry.label === 'aa-B').length, 2)
  assert.ok(plan.every((entry) => typeof entry.label === 'string'))
})

// ── The run is the statistical unit, and a tier publishes median + RANGE ──

const passedRun = (p99, p50 = p99 / 2, extra = {}) => ({
  outcome: 'passed',
  convergenceLatencyMs: { p50, p99, count: 1000 },
  harnessEventLoopMs: { p99: 10 },
  ...extra,
})

test('summarizeTier publishes the RANGE beside the median, never a lone value', () => {
  const row = summarizeTier(25, [passedRun(100), passedRun(140), passedRun(120)])
  assert.equal(row.latencyP99Median, 120)
  assert.deepEqual(row.latencyP99Range, { min: 100, max: 140 })
  assert.deepEqual(row.latencyP50Range, { min: 50, max: 70 })
  assert.equal(row.latencyP50Median, 60)
})

test('summarizeTier reports a null range rather than a fake one from a single run', () => {
  const row = summarizeTier(25, [passedRun(100)])
  assert.deepEqual(row.latencyP99Range, { min: 100, max: 100 })
  assert.equal(row.latencyP99SpreadRatio, null, 'one run agrees with itself vacuously')
})

// ── The A/A calibration: the floor under every comparison ──

test('computeMinimumDetectableRatio is never below what the instrument alone can invent', () => {
  const mdr = computeMinimumDetectableRatio({
    armSpreads: [1.0, 1.0],
    runsPerArm: 3,
    quantileRelativeError: 0.022,
  })
  // Two bucketed quantiles can differ by (1+e)/(1-e) with no real difference.
  assert.ok(mdr.ratio >= 1.04, `instrument floor ${mdr.ratio} is below the bucketing error`)
  assert.equal(mdr.basis, 'instrument')
})

test('computeMinimumDetectableRatio takes the within-arm noise when it dominates', () => {
  const mdr = computeMinimumDetectableRatio({
    armSpreads: [1.5, 1.2],
    runsPerArm: 3,
    quantileRelativeError: 0.022,
  })
  assert.equal(mdr.ratio, 1.5)
  assert.equal(mdr.basis, 'within-arm noise')
})

test('computeMinimumDetectableRatio publishes the permutation floor: 3v3 cannot reach p<0.05', () => {
  const mdr = computeMinimumDetectableRatio({ armSpreads: [1.1, 1.1], runsPerArm: 3, quantileRelativeError: 0.022 })
  // Two-sided exact permutation on 3 vs 3: 2/C(6,3) = 0.1.
  assert.equal(mdr.permutationFloorP, 0.1)
  assert.equal(mdr.separationRequired, true)
})

test('evaluateAaCalibration reports NO DIFFERENCE when the same config runs twice', () => {
  const verdict = evaluateAaCalibration({
    armA: [100, 108, 104],
    armB: [102, 99, 110],
    quantileRelativeError: 0.022,
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.verdict, 'no-difference')
  assert.ok(verdict.observedRatio <= verdict.minimumDetectableRatio)
})

test('evaluateAaCalibration FAILS — and voids the campaign — when A/A finds a difference', () => {
  const verdict = evaluateAaCalibration({
    armA: [100, 101, 102],
    armB: [400, 401, 402],
    quantileRelativeError: 0.022,
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.verdict, 'difference-detected')
  assert.match(verdict.reason, /VOID/)
})

test('evaluateAaCalibration is INSUFFICIENT, not passing, with fewer than two runs an arm', () => {
  const verdict = evaluateAaCalibration({ armA: [100], armB: [102], quantileRelativeError: 0.022 })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.verdict, 'insufficient')
  // A permutation floor with no run count beside it cannot be read: the first
  // live sweep printed "p=1 at undefined run(s) an arm".
  assert.equal(verdict.runsPerArm, 1)
  assert.equal(verdict.permutationFloorP, 1)
})

test('evaluateTierTable voids a sweep that carries no A/A calibration for this commit', () => {
  const rows = [summarizeTier(25, [passedRun(100), passedRun(110)])]
  const evaluation = evaluateTierTable(rows, { calibration: null })
  assert.equal(evaluation.outcome, 'void')
  assert.ok(evaluation.voids.some((reason) => /calibration/i.test(reason)))
})

test('evaluateTierTable judges the spread against the CALIBRATED floor, not a constant', () => {
  // Two runs 1.45x apart. The constant 1.5 would pass it; an A/A floor measured
  // at 1.1 says the runs really do disagree.
  const rows = [summarizeTier(25, [passedRun(100), passedRun(145)])]
  const tight = evaluateTierTable(rows, {
    calibration: { ok: true, verdict: 'no-difference', minimumDetectableRatio: 1.1, commitSha: 'abc' },
  })
  assert.equal(tight.outcome, 'failed')
  const loose = evaluateTierTable(rows, {
    calibration: { ok: true, verdict: 'no-difference', minimumDetectableRatio: 1.8, commitSha: 'abc' },
  })
  assert.equal(loose.outcome, 'passed')
})

test('evaluateTierTable voids every tier when the A/A calibration itself failed', () => {
  const rows = [summarizeTier(25, [passedRun(100), passedRun(101)])]
  const evaluation = evaluateTierTable(rows, {
    calibration: { ok: false, verdict: 'difference-detected', minimumDetectableRatio: 1.1, reason: 'VOID: A/A found a difference' },
  })
  assert.equal(evaluation.outcome, 'void')
})

// ── The global witnesses ──

test('evaluateGlobalHeadConvergence passes when every worker ended on ONE head set', () => {
  const verdict = evaluateGlobalHeadConvergence([
    { workerIndex: 0, convergence: { headSet: ['h1', 'h2'] } },
    { workerIndex: 1, convergence: { headSet: ['h2', 'h1'] } },
  ])
  assert.equal(verdict.ok, true)
  assert.equal(verdict.distinctHeadSets, 1)
})

test('evaluateGlobalHeadConvergence FAILS across processes even when each worker converged locally', () => {
  // The defect the per-worker check structurally cannot see: worker 0 and
  // worker 1 each agree with themselves, on different documents states.
  const verdict = evaluateGlobalHeadConvergence([
    { workerIndex: 0, convergence: { headSet: ['h1'] } },
    { workerIndex: 1, convergence: { headSet: ['h9'] } },
  ])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.verdict, 'diverged')
  assert.equal(verdict.distinctHeadSets, 2)
  assert.match(verdict.reason, /worker/)
})

test('evaluateGlobalHeadConvergence is UNOBSERVED (void), not converged, when a worker published no head set', () => {
  const verdict = evaluateGlobalHeadConvergence([
    { workerIndex: 0, convergence: { headSet: ['h1'] } },
    { workerIndex: 1, convergence: {} },
  ])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.verdict, 'unobserved')
  assert.match(verdict.reason, /VOID/)
})

test('evaluateGlobalHeadConvergence rejects an empty head set — no peer was inspected', () => {
  const verdict = evaluateGlobalHeadConvergence([{ workerIndex: 0, convergence: { headSet: [] } }])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.verdict, 'unobserved')
})

test('evaluateServerWindowOwnership voids when a worker consumed the window too', () => {
  const verdict = evaluateServerWindowOwnership(
    [
      { workerIndex: 0, serverEventLoop: { delegated: true, captured: false } },
      { workerIndex: 1, serverEventLoop: { delegated: false, captured: true } },
    ],
    { coordinatorCaptured: true },
  )
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /consume/i)
  assert.deepEqual(verdict.extraConsumers, [1])
})

test('evaluateServerWindowOwnership passes with exactly one consumer, the coordinator', () => {
  const verdict = evaluateServerWindowOwnership(
    [
      { workerIndex: 0, serverEventLoop: { delegated: true, captured: false } },
      { workerIndex: 1, serverEventLoop: { delegated: true, captured: false } },
    ],
    { coordinatorCaptured: true },
  )
  assert.equal(verdict.ok, true)
  assert.equal(verdict.consumers, 1)
})

test('evaluateServerWindowOwnership voids when NOBODY captured the window', () => {
  const verdict = evaluateServerWindowOwnership(
    [{ workerIndex: 0, serverEventLoop: { delegated: true, captured: false } }],
    { coordinatorCaptured: false },
  )
  assert.equal(verdict.ok, false)
  assert.equal(verdict.consumers, 0)
})

test('evaluateServerWindowCoverage voids a window the server reset mid-campaign', () => {
  // Another explicit consumer can reset the qualification histogram. A
  // 30 s campaign whose window starts AFTER it opened measured a truncated
  // interval, and nothing in the numbers says so.
  const verdict = evaluateServerWindowCoverage({
    openedAtMs: 1_000_000,
    closedAtMs: 1_030_000,
    windowStartedAtMs: 1_020_000,
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /VOID/)
  assert.equal(verdict.truncatedMs, 20_000)
})

test('evaluateServerWindowCoverage accepts a window that starts at the open edge', () => {
  const verdict = evaluateServerWindowCoverage({
    openedAtMs: 1_000_000,
    closedAtMs: 1_030_000,
    windowStartedAtMs: 1_000_050,
  })
  assert.equal(verdict.ok, true)
})

test('evaluateServerWindowCoverage is UNKNOWN, not ok, when the server publishes no window start', () => {
  const verdict = evaluateServerWindowCoverage({ openedAtMs: 1_000_000, closedAtMs: 1_030_000, windowStartedAtMs: null })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.verdict, 'unknown')
})

test('evaluateMachineSaturation voids above the 70% the capacity certificate already imposes', () => {
  const verdict = evaluateMachineSaturation([{ busyRatio: 0.4 }, { busyRatio: 0.82 }, { busyRatio: 0.5 }])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.peakRatio, 0.82)
  assert.match(verdict.reason, /VOID/)
})

test('evaluateMachineSaturation passes a quiet machine and publishes both statistics', () => {
  const verdict = evaluateMachineSaturation([{ busyRatio: 0.1 }, { busyRatio: 0.2 }])
  assert.equal(verdict.ok, true)
  assert.equal(verdict.peakRatio, 0.2)
  assert.ok(Math.abs(verdict.meanRatio - 0.15) < 1e-9)
})

test('evaluateMachineSaturation with no sample is void, not quiet', () => {
  const verdict = evaluateMachineSaturation([])
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /VOID/)
})

// ── The scalar that lied in multi-process: per-peer target pools ──

test('evaluateTargetCoverage catches a pool built for the LOCAL count and indexed GLOBALLY', () => {
  // Worker 1 of a fleet owns global peer indices 10..19 while `assignTargets`
  // was called with the LOCAL peer count (10), so every lookup misses and every
  // peer of that worker writes to one shared key.
  const targets = Array.from({ length: 10 }, () => ['o1', 'o2'])
  const verdict = evaluateTargetCoverage(targets, [10, 11, 12])
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.uncovered, [10, 11, 12])
  assert.match(verdict.reason, /VOID/)
})

test('evaluateTargetCoverage passes when the pool spans the GLOBAL index space', () => {
  const targets = Array.from({ length: 20 }, () => ['o1'])
  const verdict = evaluateTargetCoverage(targets, [10, 11, 12])
  assert.equal(verdict.ok, true)
})

test('evaluateTargetCoverage rejects an empty pool, which silently degrades to one key', () => {
  const targets = Array.from({ length: 20 }, (_, i) => (i === 11 ? [] : ['o1']))
  const verdict = evaluateTargetCoverage(targets, [10, 11, 12])
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.uncovered, [11])
})

// ── The truncated server window is a VOID, and the emit leg is a quantile ──

const healthyRun = (overrides = {}) => ({
  connectedPeers: 2,
  load: { ratePerSecondPerPeer: 1, durationMs: 1000 },
  convergenceLatencyMs: { count: 100, p50: 10, p99: 40 },
  serverEventLoop: { captured: true, delegated: false },
  convergence: { groups: [{ heads: ['h1'], peers: [0, 1] }], markerVisibleOnEveryPeer: true },
  ...overrides,
})

test('evaluatePeerLoadResult VOIDs a run whose server window was consumed mid-campaign', () => {
  const result = healthyRun({
    serverEventLoop: {
      captured: true,
      delegated: false,
      windowCoverage: { ok: false, verdict: 'truncated', truncatedMs: 18_000, reason: 'VOID: the window began 18000 ms late' },
    },
  })
  const evaluation = evaluatePeerLoadResult(result, { expectedPeers: 2 })
  assert.equal(evaluation.outcome, 'void')
  assert.ok(evaluation.voids.some((reason) => /18000 ms late|truncat/i.test(reason)))
})

test('evaluatePeerLoadResult accepts a delegated window, which the coordinator answers for', () => {
  const result = healthyRun({
    serverEventLoop: { captured: false, delegated: true, windowCoverage: { ok: null, verdict: 'delegated' } },
  })
  assert.equal(evaluatePeerLoadResult(result, { expectedPeers: 2 }).outcome, 'passed')
})

test('redactVoidQuantiles blanks the EMIT leg too — it is a quantile like any other', () => {
  const redacted = redactVoidQuantiles({
    outcome: 'void',
    convergenceLatencyMs: { p99: 40 },
    emitMs: { p99: 1.2 },
    latencyHistogram: { count: 1 },
  })
  assert.equal(redacted.emitMs, null)
  assert.equal(redacted.convergenceLatencyMs, null)
})

// ── The subject must be FRESH for every RUN ──
//
// The confound these rules exist for is measured, not hypothetical: 25 peers
// measured p99 = 42 ms on a newly seeded diagram and 650 then 724 ms on the same
// configuration once campaigns had accumulated in the journal — with the two A/A
// arms of the later sweep agreeing with each other to within 1.11x. Two arms that
// agree perfectly while both being 15x wrong is exactly what a shared, growing
// subject produces, and it is invisible to interleaving.

test('evaluateSeedFreshness accepts a document carrying nothing but its seed change', () => {
  const verdict = evaluateSeedFreshness([
    { worker: 0, documentId: 'doc-a', changesAtAttach: 1, opsAtAttach: 18455 },
    { worker: 1, documentId: 'doc-a', changesAtAttach: 1, opsAtAttach: 18455 },
  ], { expectedChanges: 1 })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.verdict, 'fresh')
  assert.equal(verdict.documentId, 'doc-a')
  assert.deepEqual(verdict.changesAtAttach, { min: 1, max: 1 })
})

test('evaluateSeedFreshness VOIDs a document a previous campaign already grew', () => {
  const verdict = evaluateSeedFreshness([
    { worker: 0, documentId: 'doc-a', changesAtAttach: 751, opsAtAttach: 19_206 },
  ], { expectedChanges: 1 })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.verdict, 'grown')
  assert.match(verdict.reason, /VOID/)
  assert.match(verdict.reason, /750 more/)
})

test('evaluateSeedFreshness judges the EARLIEST attach, so a late peer is not a stale document', () => {
  // Peers attach over seconds and a fleet's workers attach concurrently, so a
  // peer arriving after the start barrier legitimately observes the campaign's
  // OWN changes. Gating on the maximum would make that ordinary race a void on
  // every run. Growth that predates the
  // campaign is visible to every peer, so the minimum is the discriminating one.
  const verdict = evaluateSeedFreshness([
    { worker: 0, documentId: 'doc-a', changesAtAttach: 1, opsAtAttach: 18_455 },
    { worker: 1, documentId: 'doc-a', changesAtAttach: 37, opsAtAttach: 18_491 },
  ], { expectedChanges: 1 })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.verdict, 'fresh')
  // Both bounds are published: the reader can still see the late arrival.
  assert.deepEqual(verdict.changesAtAttach, { min: 1, max: 37 })
})

test('evaluateSeedFreshness VOIDs a fleet split across two documents — N benches, not N peers', () => {
  const verdict = evaluateSeedFreshness([
    { worker: 0, documentId: 'doc-a', changesAtAttach: 1 },
    { worker: 1, documentId: 'doc-b', changesAtAttach: 1 },
  ], { expectedChanges: 1 })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.verdict, 'split')
  assert.equal(verdict.documentId, null)
})

test('evaluateSeedFreshness VOIDs when nobody looked — unobserved is never fresh', () => {
  const verdict = evaluateSeedFreshness([], { expectedChanges: 1 })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.verdict, 'unobserved')
  assert.match(verdict.reason, /VOID/)
})

test('evaluateSeedFreshness publishes the witness but gates nothing when no expectation is given', () => {
  // The right default for a run aimed at a REAL diagram, which legitimately
  // carries history. A campaign supplies the expectation; this is what makes the
  // absence of one visible rather than silently permissive.
  const verdict = evaluateSeedFreshness([{ worker: 0, documentId: 'doc-a', changesAtAttach: 4_112 }])
  assert.equal(verdict.ok, true)
  assert.equal(verdict.changesAtAttach.max, 4_112)
  assert.equal(verdict.expectedChanges, null)
})

test('evaluateRunSeedRotation VOIDs a sweep where two runs shared a document', () => {
  const verdict = evaluateRunSeedRotation([
    { label: 'tier-25', run: 1, documentId: 'doc-a' },
    { label: 'tier-50', run: 1, documentId: 'doc-b' },
    { label: 'tier-25', run: 2, documentId: 'doc-a' },
  ])
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /VOID/)
  assert.equal(verdict.reused.length, 1)
  assert.deepEqual(verdict.reused[0].runs, ['tier-25#1', 'tier-25#2'])
})

test('evaluateRunSeedRotation accepts one document per run', () => {
  const verdict = evaluateRunSeedRotation([
    { label: 'tier-25', run: 1, documentId: 'doc-a' },
    { label: 'tier-50', run: 1, documentId: 'doc-b' },
    { label: 'tier-25', run: 2, documentId: 'doc-c' },
  ])
  assert.equal(verdict.ok, true)
  assert.equal(verdict.documentIds.length, 3)
})

test('evaluateRunSeedRotation exempts a DECLARED reused control arm, and only that one', () => {
  // The control for the freshness protocol itself deliberately reuses one
  // document. An exemption nobody declared is indistinguishable from the defect,
  // so it is a label passed in, never an inference from the data.
  const runs = [
    { label: 'reused-5', run: 1, documentId: 'doc-ctl' },
    { label: 'reused-5', run: 2, documentId: 'doc-ctl' },
    { label: 'tier-25', run: 1, documentId: 'doc-a' },
  ]
  assert.equal(evaluateRunSeedRotation(runs, { reusedLabels: ['reused-5'] }).ok, true)
  assert.equal(evaluateRunSeedRotation(runs).ok, false)
})

test('evaluateRunSeedRotation VOIDs a run that recorded no document at all', () => {
  const verdict = evaluateRunSeedRotation([
    { label: 'tier-25', run: 1, documentId: 'doc-a' },
    { label: 'tier-50', run: 1, documentId: null },
  ])
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /tier-50#1/)
})

test('evaluatePeerLoadResult VOIDs a run whose subject was not fresh', () => {
  const result = healthyRun({
    seedFreshness: { ok: false, verdict: 'grown', reason: 'VOID: the document already carried 751 change(s)' },
  })
  const evaluation = evaluatePeerLoadResult(result, { expectedPeers: 2 })
  assert.equal(evaluation.outcome, 'void')
  assert.ok(evaluation.voids.some((reason) => /751/.test(reason)))
})
