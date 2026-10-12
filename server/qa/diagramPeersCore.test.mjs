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

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  bucketUpperBoundMs,
  collectChangeMetaSamples,
  collectDiagramMetas,
  collectLatencySamples,
  convergenceGroups,
  createLatencyHistogram,
  decodeEmitMarker,
  diagramWeight,
  EMIT_KIND_CONVERGE,
  EMIT_KIND_LOAD,
  emitsOwed,
  encodeEmitMarker,
  estimateClockOffset,
  evaluateClockCapture,
  evaluateFleetRunScope,
  evaluateOfferedRate,
  evaluateSchedule,
  buildLoadRequest,
  evaluatePeerLoadResult,
  exitCodeForOutcome,
  headsEqual,
  HISTOGRAM_QUANTILE_RELATIVE_ERROR,
  mergeLatencyHistograms,
  pickDiagram,
  poolWorkerLatency,
  recordLatency,
  redactVoidQuantiles,
  summarizeHistogram,
  summarizeLatencies,
  summarizeTier,
  evaluateTierTable,
} from './diagramPeersCore.mjs'

const meta = (id, objects = 0, connections = 0) => ({
  id,
  name: id,
  type: 'container',
  docUrl: `automerge:${id}`,
  objectIds: Array.from({ length: objects }, (_, i) => `o${i}`),
  connectionIds: Array.from({ length: connections }, (_, i) => `c${i}`),
})

test('collectDiagramMetas unions every shard', () => {
  const metas = collectDiagramMetas([
    { diagrams: { a: meta('a') } },
    { diagrams: { b: meta('b') } },
  ])
  assert.deepEqual(metas.map((m) => m.id).sort(), ['a', 'b'])
})

test('collectDiagramMetas skips an unresolved shard instead of throwing', () => {
  const metas = collectDiagramMetas([null, { diagrams: { a: meta('a') } }, undefined])
  assert.equal(metas.length, 1)
})

test('collectDiagramMetas rejects entries without a usable docUrl', () => {
  const metas = collectDiagramMetas([{
    diagrams: {
      good: meta('good'),
      missing: { id: 'missing', name: 'missing' },
      wrongScheme: { id: 'wrongScheme', docUrl: 'https://example.test/doc' },
    },
  }])
  assert.deepEqual(metas.map((m) => m.id), ['good'])
})

test('collectDiagramMetas falls back to the map key when the stub omits id', () => {
  const metas = collectDiagramMetas([{ diagrams: { keyed: { docUrl: 'automerge:keyed' } } }])
  assert.equal(metas[0].id, 'keyed')
})

test('diagramWeight counts objects and connections', () => {
  assert.equal(diagramWeight(meta('a', 500, 800)), 1300)
  assert.equal(diagramWeight({}), 0)
})

test('pickDiagram takes the heaviest diagram by default', () => {
  const chosen = pickDiagram([meta('small', 10, 5), meta('big', 500, 800), meta('mid', 100, 50)])
  assert.equal(chosen.id, 'big')
})

test('pickDiagram breaks ties deterministically on id', () => {
  const first = pickDiagram([meta('zeta', 10, 10), meta('alpha', 10, 10)])
  const second = pickDiagram([meta('alpha', 10, 10), meta('zeta', 10, 10)])
  assert.equal(first.id, 'alpha')
  assert.equal(second.id, 'alpha')
})

test('pickDiagram honours an explicit diagramId even when it is not the heaviest', () => {
  const chosen = pickDiagram([meta('small', 1, 1), meta('big', 500, 800)], { diagramId: 'small' })
  assert.equal(chosen.id, 'small')
})

test('pickDiagram fails loudly for an unknown diagramId', () => {
  assert.throws(
    () => pickDiagram([meta('a', 1, 1)], { diagramId: 'nope' }),
    (error) => error.code === 'QA_DIAGRAM_NOT_FOUND',
  )
})

test('pickDiagram refuses a registry whose heaviest diagram is below minWeight', () => {
  // A run against an empty diagram would pass while proving nothing about the goal.
  assert.throws(
    () => pickDiagram([meta('tiny', 2, 1)], { minWeight: 100 }),
    (error) => error.code === 'QA_NO_ELIGIBLE_DIAGRAM' && /heaviest is 3/.test(error.message),
  )
})

test('headsEqual compares heads as a set, not positionally', () => {
  assert.ok(headsEqual(['a', 'b'], ['b', 'a']))
  assert.ok(!headsEqual(['a'], ['a', 'b']))
  assert.ok(!headsEqual(['a', 'b'], ['a', 'c']))
  assert.ok(!headsEqual(null, ['a']))
})

test('headsEqual treats a duplicated head as a mismatch rather than an equal set', () => {
  assert.ok(!headsEqual(['a', 'a'], ['a', 'b']))
})

test('convergenceGroups reports one group when every peer agrees', () => {
  const groups = convergenceGroups([
    { peer: 0, heads: ['h1'] },
    { peer: 1, heads: ['h1'] },
    { peer: 2, heads: ['h1'] },
  ])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].peers, [0, 1, 2])
})

test('convergenceGroups names the dissenters, largest group first', () => {
  const groups = convergenceGroups([
    { peer: 0, heads: ['h1'] },
    { peer: 1, heads: ['h2'] },
    { peer: 2, heads: ['h1'] },
  ])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].peers, [0, 2])
  assert.deepEqual(groups[1].peers, [1])
})

test('evaluatePeerLoadResult passes a fully connected, converged run that declined the load', () => {
  // `requireLoad: false` is the convergence-only mode, and it has to be SAID.
  // At the default this fixture must NOT pass: a run with no load in it cannot
  // be told from a run whose load was silently dropped.
  const result = evaluatePeerLoadResult(
    { connectedPeers: 10, convergence: { groups: [{ heads: ['h1'], peers: [0] }] } },
    { expectedPeers: 10, requireLoad: false },
  )
  assert.equal(result.outcome, 'passed')
  assert.deepEqual(result.failures, [])
})

test('evaluatePeerLoadResult VOIDs a run where peers are missing, and does not call it a failure', () => {
  // 7 of 10 peers is not "the server did badly at 10 peers": it is a 7-peer run
  // wearing a 10-peer header. Reporting it as `failed` invites the first reading.
  const result = evaluatePeerLoadResult(
    { connectedPeers: 7, convergence: { groups: [{ heads: ['h1'], peers: [0] }] } },
    { expectedPeers: 10 },
  )
  assert.equal(result.outcome, 'void')
  assert.equal(result.failures.length, 0)
  assert.match(result.voids[0], /only 7\/10 peers connected/)
})

test('evaluatePeerLoadResult VOIDs a run that never observed convergence', () => {
  // "No observation" must not read as success — this repo documents ten ways to
  // get a false PASS and an unobserved run is the cheapest of them.
  const result = evaluatePeerLoadResult({ connectedPeers: 10 }, { expectedPeers: 10 })
  assert.equal(result.outcome, 'void')
  assert.match(result.voids[0], /VOID/)
})

test('evaluatePeerLoadResult reports which head sets disagreed', () => {
  const result = evaluatePeerLoadResult(
    {
      connectedPeers: 3,
      convergence: { groups: [{ heads: ['h1'], peers: [0, 2] }, { heads: ['h2'], peers: [1] }] },
    },
    // `requireLoad: false` on purpose: this case is about the evaluator still
    // being able to say `failed`. At the default the load void would fire, and
    // `void` outranks `failed` — the disagreement would stop being reportable.
    { expectedPeers: 3, requireLoad: false },
  )
  assert.equal(result.outcome, 'failed')
  assert.match(result.failures[0], /2 head sets/)
  assert.match(result.failures[0], /2 peer\(s\) @ h1/)
})

test('evaluatePeerLoadResult rejects a nonsensical expectedPeers', () => {
  const result = evaluatePeerLoadResult({ connectedPeers: 0 }, { expectedPeers: 0 })
  assert.equal(result.outcome, 'void')
  assert.match(result.voids[0], /positive integer/)
})

// ── Load generation and convergence latency ──

test('collectLatencySamples ignores the receiving peer own marker', () => {
  const bench = { 0: { seq: 1, emittedAt: 100 }, 1: { seq: 1, emittedAt: 100 } }
  const { samples } = collectLatencySamples(bench, {}, 1, 150)
  assert.equal(samples.length, 1)
  assert.equal(samples[0].from, 0)
  assert.equal(samples[0].latencyMs, 50)
})

test('collectLatencySamples counts each sequence once, so a duplicate change event cannot inflate the sample', () => {
  const bench = { 0: { seq: 7, emittedAt: 100 } }
  const first = collectLatencySamples(bench, {}, 1, 140)
  assert.equal(first.samples.length, 1)
  const second = collectLatencySamples(bench, first.seen, 1, 900)
  assert.equal(second.samples.length, 0, 'the same seq must not be counted twice')
})

test('collectLatencySamples advances the watermark and accepts the next sequence', () => {
  const first = collectLatencySamples({ 0: { seq: 1, emittedAt: 0 } }, {}, 1, 10)
  const second = collectLatencySamples({ 0: { seq: 2, emittedAt: 20 } }, first.seen, 1, 35)
  assert.equal(second.samples.length, 1)
  assert.equal(second.samples[0].latencyMs, 15)
})

test('collectLatencySamples skips malformed markers rather than emitting NaN latencies', () => {
  const bench = { 0: { seq: 'x', emittedAt: 1 }, 1: { seq: 1 }, 2: null, notANumber: { seq: 1, emittedAt: 1 } }
  const { samples } = collectLatencySamples(bench, {}, 9, 100)
  assert.deepEqual(samples, [])
})

test('collectLatencySamples clamps a negative latency to zero', () => {
  // All peers share one process, so a negative value is a harness bug, not data.
  const { samples } = collectLatencySamples({ 0: { seq: 1, emittedAt: 500 } }, {}, 1, 100)
  assert.equal(samples[0].latencyMs, 0)
})

test('summarizeLatencies reports the three quantiles the exit criterion requires', () => {
  const summary = summarizeLatencies([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
  assert.equal(summary.count, 10)
  assert.equal(summary.min, 10)
  assert.equal(summary.max, 100)
  assert.equal(summary.p50, 50)
  assert.equal(summary.p95, 100)
  assert.equal(summary.p99, 100)
})

test('summarizeLatencies returns nulls, not zeros, for an empty sample', () => {
  // Zero would read as "instant convergence" — the worst possible false PASS.
  const summary = summarizeLatencies([])
  assert.equal(summary.count, 0)
  assert.equal(summary.p99, null)
})

test('summarizeLatencies drops non-finite values', () => {
  assert.equal(summarizeLatencies([1, NaN, 2, Infinity, 3]).count, 3)
})

test('emitsOwed derives the target from elapsed time, not from timer firings', () => {
  assert.equal(emitsOwed(1000, 1), 1)
  assert.equal(emitsOwed(2500, 2), 5)
  assert.equal(emitsOwed(999, 1), 0)
  assert.equal(emitsOwed(1000, 0), 0)
})

test('evaluateSchedule passes a generator that held its schedule', () => {
  const result = evaluateSchedule([0, 2, 1, 3, 0, 5])
  assert.ok(result.withinTolerance)
  assert.equal(result.reason, null)
})

test('evaluateSchedule fails a generator that fell behind, which a COUNT gate cannot see', () => {
  // After a stall the loop emits everything owed in one burst, so the count
  // always catches up; lateness is what actually shows the stall.
  const result = evaluateSchedule([0, 1, 4000, 4000, 4000])
  assert.ok(!result.withinTolerance)
  assert.match(result.reason, /lateness p99/)
})

test('evaluateSchedule VOIDs a run that scheduled nothing', () => {
  const result = evaluateSchedule([])
  assert.ok(!result.withinTolerance)
  assert.match(result.reason, /VOID/)
})

test('evaluateSchedule honours a custom lateness budget', () => {
  assert.ok(evaluateSchedule([900], { maxP99LatenessMs: 1000 }).withinTolerance)
  assert.ok(!evaluateSchedule([900], { maxP99LatenessMs: 100 }).withinTolerance)
})

// ── Tiers and repeated runs ──

const run = (p50, p99, count = 100, outcome = 'passed', loop = 10) => ({
  outcome,
  convergenceLatencyMs: { p50, p99, count },
  harnessEventLoopMs: { p99: loop },
})

test('summarizeTier medians the runs and records every p99', () => {
  const row = summarizeTier(25, [run(30, 100), run(35, 120), run(32, 110)])
  assert.equal(row.peers, 25)
  assert.equal(row.runs, 3)
  assert.equal(row.passed, 3)
  assert.equal(row.latencyP99Median, 110)
  assert.deepEqual(row.latencyP99Runs, [100, 120, 110])
})

test('summarizeTier exposes the spread so a median cannot hide a divergent run', () => {
  const row = summarizeTier(25, [run(30, 40), run(30, 4000)])
  assert.equal(row.latencyP99SpreadRatio, 100)
})

test('summarizeTier ignores runs that produced no outcome', () => {
  const row = summarizeTier(25, [run(30, 100), null, undefined, {}])
  assert.equal(row.runs, 1)
})

test('summarizeTier reports the WORST sample count, not the average', () => {
  const row = summarizeTier(25, [run(30, 100, 900), run(30, 100, 0)])
  assert.equal(row.sampleCountMin, 0)
})

// A sweep with no A/A calibration is VOID (see diagramPeersTiers.test.mjs).
// The tiers below are about the tier rules themselves, so they supply a floor
// explicitly rather than testing the calibration gate again.
const CALIBRATED = {
  ok: true,
  verdict: 'no-difference',
  minimumDetectableRatio: 1.5,
  minimumDetectableRatioBasis: 'within-arm noise',
  commitSha: 'test',
}

test('evaluateTierTable passes a consistent, fully green tier', () => {
  const rows = [summarizeTier(25, [run(30, 100), run(31, 105)])]
  assert.equal(evaluateTierTable(rows, { calibration: CALIBRATED }).outcome, 'passed')
})

test('evaluateTierTable fails a tier whose runs disagree', () => {
  const rows = [summarizeTier(25, [run(30, 40), run(30, 400)])]
  const result = evaluateTierTable(rows, { calibration: CALIBRATED })
  assert.equal(result.outcome, 'failed')
  assert.match(result.failures[0], /spread/)
})

test('evaluateTierTable VOIDs a tier where a run produced zero samples', () => {
  const rows = [summarizeTier(25, [run(30, 100, 0)])]
  const result = evaluateTierTable(rows)
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /ZERO latency samples/)
})

test('evaluateTierTable fails a tier with a failed run', () => {
  const rows = [summarizeTier(25, [run(30, 100), run(30, 100, 100, 'failed')])]
  assert.match(evaluateTierTable(rows).failures.join(' '), /only 1\/2 runs passed/)
})

test('evaluateTierTable VOIDs an empty table rather than passing it', () => {
  const result = evaluateTierTable([])
  assert.equal(result.outcome, 'void')
  assert.match(result.voids[0], /VOID/)
})

// ── Void gates for runs that did not measure what they claim ──

test('evaluatePeerLoadResult VOIDs a campaign that ran and collected ZERO samples', () => {
  // The bare invocation (rate defaults to 0) and a typo'd rate (Number('1s')
  // is NaN) must not exit 0 with p50: null.
  const result = evaluatePeerLoadResult(
    {
      connectedPeers: 10,
      load: { ratePerSecondPerPeer: 1 },
      convergenceLatencyMs: { count: 0, p50: null },
      convergence: { groups: [{ heads: ['h'], peers: [0] }] },
      serverEventLoop: { captured: true },
    },
    { expectedPeers: 10 },
  )
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /ZERO latency samples/)
})

test('evaluatePeerLoadResult VOIDs when the instrument lost samples', () => {
  const result = evaluatePeerLoadResult(
    {
      connectedPeers: 10,
      load: {},
      convergenceLatencyMs: { count: 430 },
      sampleLoss: { expected: 1000, observed: 430, ratio: 0.57 },
      convergence: { groups: [{ heads: ['h'], peers: [0] }] },
      serverEventLoop: { captured: true },
    },
    { expectedPeers: 10 },
  )
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /sample loss 57\.0%/)
})

test('the sample-loss floor is the 2% R1 made possible, not the 30% the lossy instrument needed', () => {
  // Under the doc-state instrument a third of the samples went missing BY
  // DESIGN, so the gate had to tolerate it and could not detect anything else.
  // With change metadata a 5% loss means something real is dropping data.
  const withLoss = (ratio) => evaluatePeerLoadResult(
    {
      connectedPeers: 2,
      load: {},
      convergenceLatencyMs: { count: 100 },
      sampleLoss: { expected: 100, observed: 100 - ratio * 100, ratio },
      convergence: { groups: [{ heads: ['h'], peers: [0, 1] }] },
      serverEventLoop: { captured: true },
    },
    { expectedPeers: 2 },
  )
  assert.equal(withLoss(0.05).outcome, 'void')
  assert.equal(withLoss(0.01).outcome, 'passed')
})

test('evaluatePeerLoadResult treats ZERO convergence groups as VOID, not as a pass', () => {
  // The rule was pinned only at groups.length in {1,2}; an empty array passed.
  const result = evaluatePeerLoadResult(
    { connectedPeers: 1, convergence: { groups: [] } },
    { expectedPeers: 1 },
  )
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /no head-set groups/)
})

test('evaluatePeerLoadResult fails when heads agree but the marker never arrived', () => {
  // Agreement on a state that predates the write is not delivery.
  const result = evaluatePeerLoadResult(
    {
      connectedPeers: 2,
      convergence: { groups: [{ heads: ['h'], peers: [0, 1] }], markerVisibleOnEveryPeer: false },
    },
    // Same reason as the head-set case above: keep the load void out of the way
    // so what is under test is the evaluator's ability to report a FAILURE.
    { expectedPeers: 2, requireLoad: false },
  )
  assert.equal(result.outcome, 'failed')
  assert.match(result.failures.join(' '), /marker never reached/)
})

// ── The two routes to `p50: null` with exit 0 ──

test('buildLoadRequest separates the two routes the parsed numbers cannot', () => {
  // The real environment shapes, through the real function. Both rows below make
  // `Number(rate) > 0` false; only the raw values say which one happened.
  const bare = buildLoadRequest({})
  assert.deepEqual(bare, { required: true, rate: null, durationMs: null, usable: false })

  const typo = buildLoadRequest({ DIAGRAM_PEER_RATE: '1s', DIAGRAM_PEER_DURATION_MS: '30000' })
  assert.equal(typo.usable, false)
  assert.equal(typo.rate, '1s', 'the raw value is the only evidence a rate was ever asked for')
  assert.equal(typo.required, true)
})

test('buildLoadRequest marks a real campaign usable, and honours the explicit decline', () => {
  const real = buildLoadRequest({ DIAGRAM_PEER_RATE: '1', DIAGRAM_PEER_DURATION_MS: '30000' })
  assert.equal(real.usable, true)
  assert.equal(real.required, true)

  // The opt-out is a WORD, not a missing variable, so it cannot be reached by
  // forgetting something.
  const declined = buildLoadRequest({ DIAGRAM_PEER_LOAD: 'off' })
  assert.equal(declined.required, false)
  // Any other value is not the opt-out — including the ones an operator would
  // plausibly reach for.
  for (const value of ['0', 'false', 'no', 'OFF', '']) {
    assert.equal(buildLoadRequest({ DIAGRAM_PEER_LOAD: value }).required, true, `DIAGRAM_PEER_LOAD=${JSON.stringify(value)} must not decline the load`)
  }
})

test('buildLoadRequest treats a duration without a rate as unusable, and the reverse', () => {
  // Half an ask is not an ask: the load block needs both, so both are reported.
  assert.equal(buildLoadRequest({ DIAGRAM_PEER_DURATION_MS: '30000' }).usable, false)
  assert.equal(buildLoadRequest({ DIAGRAM_PEER_RATE: '1' }).usable, false)
  // …and a zero rate is a value the operator supplied, so it is still an ask
  // that failed rather than an ask that was never made.
  const zero = buildLoadRequest({ DIAGRAM_PEER_RATE: '0', DIAGRAM_PEER_DURATION_MS: '30000' })
  assert.equal(zero.usable, false)
  assert.equal(zero.rate, '0')
})

test('evaluatePeerLoadResult VOIDs the bare invocation, where no rate was given at all', () => {
  // Route 1. `DIAGRAM_PEER_RATE` unset means `Number(undefined ?? 0)` is 0, the
  // load block never runs, and `load` is null, so the voids inside
  // `if (result.load)` cannot catch it.
  const result = evaluatePeerLoadResult(
    {
      connectedPeers: 2,
      convergence: { groups: [{ heads: ['h'], peers: [0, 1] }], markerVisibleOnEveryPeer: true },
      loadRequest: { required: true, rate: null, durationMs: null, usable: false },
      convergenceLatencyMs: { count: 0, p50: null },
    },
    { expectedPeers: 2 },
  )
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /a load campaign was required but none ran/)
  // The reason has to carry what was offered, or the operator learns only that
  // something is wrong and not which of the two routes they took.
  assert.match(result.voids.join(' '), /rate=null/)
  assert.equal(result.failures.length, 0)
})

test('evaluatePeerLoadResult VOIDs a typo rate, and names the value it could not use', () => {
  // Route 2. `Number('1s')` is NaN, `NaN > 0` is false, so this is byte-identical
  // to route 1 at the point of decision — but not to the operator, who asked for
  // a campaign and must be told the ask was dropped rather than that none existed.
  const result = evaluatePeerLoadResult(
    {
      connectedPeers: 2,
      convergence: { groups: [{ heads: ['h'], peers: [0, 1] }], markerVisibleOnEveryPeer: true },
      loadRequest: { required: true, rate: '1s', durationMs: '30000', usable: false },
    },
    { expectedPeers: 2 },
  )
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /rate="1s"/)
})

test('evaluatePeerLoadResult reads the requirement from the REPORT, not from its caller', () => {
  // There is no `requireLoad` line at the production call site: the evaluator
  // defaults it from `result.loadRequest.required`, which the runner already
  // publishes, so there is no per-site line that could be forgotten.
  const bare = { connectedPeers: 1, convergence: { groups: [{ heads: ['h'], peers: [0] }], markerVisibleOnEveryPeer: true } }

  // A report predating the gate carries no `loadRequest`, and `?? true` makes
  // that VOID loudly rather than pass quietly.
  assert.equal(evaluatePeerLoadResult(bare, { expectedPeers: 1 }).outcome, 'void')

  // The declined run says so in the report, so re-grading the STORED report
  // reproduces the verdict the run produced: `DIAGRAM_PEER_REPORT` is a
  // durable artifact the fleet reads back.
  const declined = { ...bare, loadRequest: { required: false, rate: null, durationMs: null, usable: false } }
  assert.equal(evaluatePeerLoadResult(declined, { expectedPeers: 1 }).outcome, 'passed')

  // The explicit option still overrides, for a caller grading someone else's
  // report — but nothing in production passes it.
  assert.equal(evaluatePeerLoadResult(bare, { expectedPeers: 1, requireLoad: false }).outcome, 'passed')
})

test('buildLoadRequest.usable is what the runner branches on, so the two cannot drift', () => {
  // The runner must branch on `usable` rather than recompute
  // `RATE > 0 && DURATION_MS > 0`: two spellings of one predicate drift.
  //
  // What is deliberately NOT gated: `usable && !load`, "orderable and still did
  // not run". With the runner deriving `load` from `usable`, no run can produce
  // that state, so a void for it would be dead code.
  //
  // A SOURCE-TEXT gate: nothing boots this runner, so the wire from
  // `buildLoadRequest` to the two branches below is out of a unit test's reach.
  // The COUNT is asserted, not mere presence, so rewording one branch into a
  // hand-written comparison goes red.
  // Comments stripped first, or prose explaining the rule would be counted.
  // `[^\r\n]*` and not `.*$`: `.` excludes carriage return, so on a CRLF
  // checkout the `.*$` form strips nothing at all.
  const source = readFileSync(new URL('../scripts/verify-diagram-peer-load.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1')
  assert.equal(
    (source.match(/LOAD_REQUEST\.usable/g) ?? []).length,
    2,
    'both the load block and the `load:` field must read the published verdict',
  )
  assert.equal(
    (source.match(/RATE > 0 && DURATION_MS > 0/g) ?? []).length,
    0,
    'the runner recomputes the predicate `buildLoadRequest` already answers',
  )
  // And the request must actually reach the report, or the evaluator's default
  // silently falls back to `true` for every run.
  assert.ok(source.includes('buildLoadRequest(process.env)'), 'the runner must build the request from the real environment')
  assert.ok(source.includes('loadRequest: LOAD_REQUEST'), 'the runner must publish the request it built')
})

test('evaluatePeerLoadResult says so when the runner published no loadRequest at all', () => {
  // The runner is the only thing that can publish the request, so a report
  // without one is a report from a runner that does not know about this gate.
  // Naming that is the difference between "your rate was bad" and "your harness
  // is older than this check".
  const result = evaluatePeerLoadResult(
    { connectedPeers: 1, convergence: { groups: [{ heads: ['h'], peers: [0] }], markerVisibleOnEveryPeer: true } },
    { expectedPeers: 1 },
  )
  assert.match(result.voids.join(' '), /published no loadRequest/)
})

test('evaluatePeerLoadResult still reaches its load voids once a campaign really ran', () => {
  // The liveness half: the new gate must not become the only thing that fires.
  // A campaign that ran and collected nothing is still the zero-sample void, and
  // this is what proves the new branch did not swallow the old ones.
  const result = evaluatePeerLoadResult(
    {
      connectedPeers: 2,
      convergence: { groups: [{ heads: ['h'], peers: [0, 1] }], markerVisibleOnEveryPeer: true },
      loadRequest: { required: true, rate: '1', durationMs: '30000', usable: true },
      load: { ratePerSecondPerPeer: 1 },
      convergenceLatencyMs: { count: 0 },
      serverEventLoop: { captured: true },
    },
    { expectedPeers: 2 },
  )
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /collected ZERO latency samples/)
  assert.doesNotMatch(result.voids.join(' '), /none ran/)
})

test('collectLatencySamples CONTINUES past a skipped entry instead of stopping', () => {
  // Peer 0 is skipped as self; a `break` instead of `continue` would also drop
  // peers 1 and 2.
  const bench = { 0: { seq: 9, emittedAt: 10 }, 1: { seq: 1, emittedAt: 10 }, 2: { seq: 1, emittedAt: 10 } }
  const { samples } = collectLatencySamples(bench, {}, 0, 50)
  assert.equal(samples.length, 2, 'both non-self peers must be sampled')
  assert.deepEqual(samples.map((s) => s.from).sort(), [1, 2])
})

test('evaluateTierTable VOIDS a tier whose harness event loop saturated', () => {
  // A p99 of 10,818 ms with the harness's own loop at 481 ms describes the
  // instrument, not the server.
  const rows = [{
    peers: 50, runs: 2, passed: 2, sampleCountMin: 10,
    latencyP99Runs: [10818, 14343], latencyP99SpreadRatio: 1.33,
    harnessEventLoopP99Ms: 481,
  }]
  const result = evaluateTierTable(rows)
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /measures the harness, not the server/)
})

test('evaluateTierTable accepts a tier whose harness stayed responsive', () => {
  const rows = [{
    peers: 10, runs: 2, passed: 2, sampleCountMin: 800,
    latencyP99Runs: [290, 293], latencyP99SpreadRatio: 1.01,
    harnessEventLoopP99Ms: 27,
  }]
  assert.equal(evaluateTierTable(rows, { calibration: CALIBRATED }).outcome, 'passed')
})

test('evaluateTierTable rejects a single-run tier, which agrees with itself vacuously', () => {
  const rows = [summarizeTier(10, [run(30, 100)])]
  const result = evaluateTierTable(rows)
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /single run agrees with itself|run\(s\)/)
})

test('summarizeTier medians only PASSING runs', () => {
  // Folding a failed run into the headline lets a broken run flatter it.
  const row = summarizeTier(10, [run(30, 100), run(999, 9999, 100, 'failed')])
  assert.deepEqual(row.latencyP99Runs, [100])
  assert.equal(row.latencyP99Median, 100)
})

test('summarizeTier gates on the WORST loop delay, not the median', () => {
  const row = summarizeTier(10, [run(30, 100, 100, 'passed', 20), run(30, 100, 100, 'passed', 480)])
  assert.equal(row.harnessEventLoopP99Ms, 480)
  assert.equal(row.harnessEventLoopP99Median, 20)
})

// ── The change-metadata instrument, its codec and its bounded accumulator ──

test('the emit marker round-trips, and rejects anything that is not this campaign', () => {
  const encoded = encodeEmitMarker({ runId: 'run-a', emittedAt: 1234.5 })
  assert.deepEqual(decodeEmitMarker(encoded, 'run-a'), { emittedAt: 1234.5, runId: 'run-a', kind: 'e' })
  // A marker from another campaign on the same document is not a sample:
  // leftovers would produce a confident but meaningless p50.
  assert.equal(decodeEmitMarker(encoded, 'run-b'), null)
  assert.equal(decodeEmitMarker('a human commit message', 'run-a'), null)
  assert.equal(decodeEmitMarker(undefined, 'run-a'), null)
  assert.equal(decodeEmitMarker('t11:{not json', 'run-a'), null)
})

test('the convergence probe is a distinct KIND so it cannot enter the distribution', () => {
  // It proves delivery at the end of the run; counting it as load would drift
  // the sample-loss ratio, which is derived from the emit count, by one emit
  // per worker — enough to trip a 2% floor on a short campaign.
  const probe = encodeEmitMarker({ runId: 'r', emittedAt: 5, kind: EMIT_KIND_CONVERGE })
  assert.equal(decodeEmitMarker(probe, 'r').kind, EMIT_KIND_CONVERGE)
  const { samples } = collectChangeMetaSamples(
    [
      { actor: 'x', seq: 1, message: encodeEmitMarker({ runId: 'r', emittedAt: 5 }) },
      { actor: 'x', seq: 2, message: probe },
    ],
    {}, new Set(['self']), 10, 'r',
  )
  assert.deepEqual(samples.map((s) => s.kind), [EMIT_KIND_LOAD, EMIT_KIND_CONVERGE])
  // Both advance the watermark: delivery of the probe is what convergence reads.
  assert.equal(samples[1].seq, 2)
})

test('collectChangeMetaSamples keys the watermark on the ACTOR, not on a re-invented peer id', () => {
  const metas = [
    { actor: 'aaa', seq: 1, message: encodeEmitMarker({ runId: 'r', emittedAt: 10 }) },
    { actor: 'bbb', seq: 1, message: encodeEmitMarker({ runId: 'r', emittedAt: 20 }) },
  ]
  const first = collectChangeMetaSamples(metas, {}, new Set(['self']), 100, 'r')
  assert.deepEqual(first.samples.map((s) => s.latencyMs).sort((a, b) => a - b), [80, 90])
  assert.deepEqual(first.seen, { aaa: 1, bbb: 1 })
  // Two actors at the same seq must not collide; a shared counter would drop one.
  const second = collectChangeMetaSamples(metas, first.seen, new Set(['self']), 200, 'r')
  assert.equal(second.samples.length, 0)
  assert.equal(second.skipped.duplicate, 2)
})

test('collectChangeMetaSamples CONTINUES past a skipped entry instead of stopping', () => {
  // Same guard against `break` instead of `continue` as for the doc-state collector.
  const metas = [
    { actor: 'self', seq: 9, message: encodeEmitMarker({ runId: 'r', emittedAt: 1 }) },
    { actor: 'x', seq: 1, message: encodeEmitMarker({ runId: 'r', emittedAt: 1 }) },
    { actor: 'y', seq: 1, message: encodeEmitMarker({ runId: 'r', emittedAt: 1 }) },
  ]
  const { samples } = collectChangeMetaSamples(metas, {}, new Set(['self']), 50, 'r')
  assert.deepEqual(samples.map((s) => s.from).sort(), ['x', 'y'])
})

test('collectChangeMetaSamples counts why it skipped, so "no samples" has a diagnosis', () => {
  const result = collectChangeMetaSamples(
    [
      { actor: 'self', seq: 1, message: encodeEmitMarker({ runId: 'r', emittedAt: 1 }) },
      { actor: 'x', seq: 1, message: 'someone else' },
      { seq: 1, message: encodeEmitMarker({ runId: 'r', emittedAt: 1 }) },
    ],
    {}, new Set(['self']), 10, 'r',
  )
  assert.deepEqual(result.samples, [])
  assert.equal(result.skipped.self, 1)
  assert.equal(result.skipped.foreign, 1)
  assert.equal(result.skipped.malformed, 1)
})

test('the histogram agrees with exact quantiles to within its PUBLISHED error', () => {
  const values = Array.from({ length: 1000 }, (_, i) => 1 + i * 0.7)
  const histogram = createLatencyHistogram()
  for (const value of values) recordLatency(histogram, value)
  const bucketed = summarizeHistogram(histogram)
  const exact = summarizeLatencies(values)

  assert.equal(bucketed.count, exact.count)
  assert.equal(bucketed.min, exact.min)
  assert.equal(bucketed.max, exact.max)
  for (const q of ['p50', 'p95', 'p99']) {
    // The bucketed value may only OVERSTATE: an approximation that can flatter a
    // p99 would reintroduce, by rounding, the bias the instrument avoids.
    assert.ok(bucketed[q] >= exact[q], `${q}: ${bucketed[q]} must not undercut the exact ${exact[q]}`)
    assert.ok(
      bucketed[q] / exact[q] - 1 <= HISTOGRAM_QUANTILE_RELATIVE_ERROR + 1e-9,
      `${q}: ${bucketed[q]} exceeds the published ${HISTOGRAM_QUANTILE_RELATIVE_ERROR} error over ${exact[q]}`,
    )
  }
})

test('merging histograms equals recording every value into one', () => {
  const left = createLatencyHistogram()
  const right = createLatencyHistogram()
  const all = createLatencyHistogram()
  for (let i = 1; i <= 200; i += 1) {
    recordLatency(i % 2 ? left : right, i)
    recordLatency(all, i)
  }
  assert.deepEqual(summarizeHistogram(mergeLatencyHistograms([left, right])), summarizeHistogram(all))
})

test('an empty histogram reports nulls, never zeros', () => {
  // Zero would read as instant convergence — the worst possible false PASS.
  const summary = summarizeHistogram(createLatencyHistogram())
  assert.equal(summary.count, 0)
  assert.equal(summary.p99, null)
  assert.equal(summary.mean, null)
})

test('a histogram quantile is never outside the observed range', () => {
  const histogram = createLatencyHistogram()
  recordLatency(histogram, 0)
  recordLatency(histogram, 0)
  assert.equal(summarizeHistogram(histogram).p99, 0, 'bucket 0 must not publish its 1 ms upper bound as a latency')
  assert.equal(bucketUpperBoundMs(0), 1)
})

// ── The fleet pools what the workers actually publish ──

test('poolWorkerLatency VOIDs on the legacy field instead of silently publishing null', () => {
  // A report carrying only the legacy `latencySamples` field (which no worker
  // writes) must void, not pool to a silent null.
  const result = poolWorkerLatency([
    { workerIndex: 0, latencySamples: [10, 20, 30] },
    { workerIndex: 1, latencySamples: [10, 20, 30] },
  ])
  assert.equal(result.pooled, null)
  assert.match(result.reason, /VOID/)
  assert.deepEqual(result.workersMissing, [0, 1])
})

test('poolWorkerLatency pools every worker histogram into one distribution', () => {
  const worker = (from, to) => {
    const histogram = createLatencyHistogram()
    for (let i = from; i <= to; i += 1) recordLatency(histogram, i)
    return { latencyHistogram: histogram }
  }
  const result = poolWorkerLatency([worker(1, 50), worker(51, 100), worker(101, 150)])
  assert.equal(result.workersPooled, 3)
  assert.equal(result.pooled.count, 150)
  assert.ok(result.pooled.p99 > 0, 'pooledLatency must be a number, which it never was')
  assert.equal(result.pooled.max, 150)
  assert.equal(result.reason, null)
})

test('poolWorkerLatency VOIDs when only SOME workers contributed', () => {
  const histogram = createLatencyHistogram()
  recordLatency(histogram, 5)
  const result = poolWorkerLatency([{ workerIndex: 0, latencyHistogram: histogram }, { workerIndex: 1 }])
  assert.match(result.reason, /VOID: 1 of 2 workers published no histogram/)
})

test('evaluateFleetRunScope VOIDs a fleet whose workers each minted their own campaign', () => {
  // With per-worker run ids, 100 peers over 10 workers become ten benches of
  // 10: every cross-worker marker is discarded by the run filter, and the
  // header still says 100.
  const result = evaluateFleetRunScope([{ runId: 'a' }, { runId: 'b' }], null)
  assert.equal(result.ok, false)
  assert.match(result.reason, /N small benches, not one/)
})

test('evaluateFleetRunScope accepts one shared campaign and rejects a mismatched one', () => {
  assert.equal(evaluateFleetRunScope([{ runId: 'a' }, { runId: 'a' }], 'a').ok, true)
  assert.match(evaluateFleetRunScope([{ runId: 'a' }, { runId: 'a' }], 'z').reason, /coordinator minted/)
  assert.match(evaluateFleetRunScope([{ runId: 'a' }, {}], 'a').reason, /no campaign id/)
})

// ── The SERVER's event loop, distinguished from the harness's ──

test('a run without the server event-loop window is VOID, not a result', () => {
  const base = {
    connectedPeers: 2,
    load: {},
    convergenceLatencyMs: { count: 10 },
    convergence: { groups: [{ heads: ['h'], peers: [0, 1] }] },
  }
  const missing = evaluatePeerLoadResult(base, { expectedPeers: 2 })
  assert.equal(missing.outcome, 'void')
  assert.match(missing.voids.join(' '), /server event-loop window was not captured/)
  assert.match(missing.voids.join(' '), /server cost and client cost cannot be told apart/)

  const captured = evaluatePeerLoadResult(
    { ...base, serverEventLoop: { captured: true, eventLoopDelayMs: { p99: 3 } } },
    { expectedPeers: 2 },
  )
  assert.equal(captured.outcome, 'passed')
})

test('a fleet worker that DELEGATED the server window is not void for lacking it', () => {
  // `?eventLoopWindow=consume` RESETS the window: if every worker consumed, each
  // would zero what the others measure. Exactly one process captures — and the
  // live fleet caught this the hard way, voiding all four workers at once.
  const delegated = evaluatePeerLoadResult(
    {
      connectedPeers: 2,
      load: {},
      convergenceLatencyMs: { count: 10 },
      serverEventLoop: { captured: false, delegated: true, owner: 'fleet coordinator' },
      convergence: { groups: [{ heads: ['h'], peers: [0, 1] }] },
    },
    { expectedPeers: 2 },
  )
  assert.equal(delegated.outcome, 'passed')
})

// ── The void taxonomy ──

test('exit codes are 0 passed / 1 failed / 2 void, and an unknown outcome is never 0', () => {
  assert.equal(exitCodeForOutcome('passed'), 0)
  assert.equal(exitCodeForOutcome('failed'), 1)
  assert.equal(exitCodeForOutcome('void'), 2)
  assert.equal(exitCodeForOutcome('something-else'), 1)
  assert.equal(exitCodeForOutcome(undefined), 1)
})

test('void DOMINATES failed: an incomplete run is not a slow one', () => {
  const result = evaluatePeerLoadResult(
    {
      connectedPeers: 3,
      load: {},
      convergenceLatencyMs: { count: 10 },
      serverEventLoop: { captured: true },
      convergence: { groups: [{ heads: ['h1'], peers: [0] }, { heads: ['h2'], peers: [1] }] },
    },
    { expectedPeers: 10 },
  )
  assert.equal(result.outcome, 'void')
  assert.ok(result.failures.length > 0, 'the divergence is still reported')
  assert.match(result.voids.join(' '), /peers connected/)
})

test('a void report publishes NULL quantiles, so it cannot be quoted', () => {
  const voided = redactVoidQuantiles({
    outcome: 'void',
    convergenceLatencyMs: { p50: 12, p99: 900, count: 4 },
    latencyHistogram: { count: 4 },
  })
  assert.equal(voided.convergenceLatencyMs, null)
  assert.equal(voided.latencyHistogram, null)
  assert.match(voided.quantilesRedacted, /withheld/)

  const passed = { outcome: 'passed', convergenceLatencyMs: { p99: 42 } }
  assert.deepEqual(redactVoidQuantiles(passed), passed)
})

test('an offered rate outside the 10% band VOIDs the run', () => {
  const nominal = { peers: 10, ratePerSecond: 1, durationMs: 30_000 }
  assert.equal(evaluateOfferedRate({ ...nominal, emitted: 300 }).withinTolerance, true)
  assert.equal(evaluateOfferedRate({ ...nominal, emitted: 291 }).withinTolerance, true)
  const short = evaluateOfferedRate({ ...nominal, emitted: 180 })
  assert.equal(short.withinTolerance, false)
  assert.match(short.reason, /VOID: offered 180 of 300/)
  // No schedule at all is not a 100% success rate.
  assert.match(evaluateOfferedRate({ emitted: 0, peers: 0, ratePerSecond: 0, durationMs: 0 }).reason, /VOID/)
})

test('edge quantisation does not void an honest run, but a stall still does', () => {
  // Measured live: 4 peers, 1/s, 10 s offered 36 of a nominal 40 — exactly -10%,
  // on the tolerance boundary, purely because a phase-shifted peer cannot place
  // its last emit inside the window. The schedule's own achievable count is 37.
  const short = { peers: 4, ratePerSecond: 1, durationMs: 10_000 }
  assert.equal(evaluateOfferedRate({ ...short, emitted: 36 }).deviation, -0.1)
  const honest = evaluateOfferedRate({ ...short, emitted: 36, achievable: 37 })
  assert.equal(honest.withinTolerance, true)
  assert.equal(honest.target, 40, 'the nominal target is still published')
  assert.equal(honest.basis, 37)
  // A generator that actually fell behind is still caught.
  assert.equal(evaluateOfferedRate({ ...short, emitted: 20, achievable: 37 }).withinTolerance, false)
})

test('a run whose offered rate missed its target is VOID even though it converged', () => {
  const result = evaluatePeerLoadResult(
    {
      connectedPeers: 2,
      load: { offeredRate: { withinTolerance: false, reason: 'VOID: offered 180 of 300 intended emits' } },
      convergenceLatencyMs: { count: 100 },
      serverEventLoop: { captured: true },
      convergence: { groups: [{ heads: ['h'], peers: [0, 1] }] },
    },
    { expectedPeers: 2 },
  )
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /offered 180 of 300/)
})

test('estimateClockOffset takes the probe with the shortest round trip', () => {
  const estimate = estimateClockOffset([
    { t0: 0, t1: 200, serverMs: 100 },
    { t0: 1000, t1: 1010, serverMs: 1105 },
  ])
  assert.equal(estimate.offsetMs, 100, 'the 10 ms round trip must win over the 200 ms one')
  assert.equal(estimate.roundTripMs, 10)
  assert.equal(estimateClockOffset([]), null)
  assert.equal(estimateClockOffset([{ t0: 5, t1: 1 }]), null)
})

test('a missing or drifting clock capture VOIDs the run', () => {
  const missing = evaluateClockCapture({ open: { offsetMs: 1 }, close: null })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /not captured at both edges/)

  const drifted = evaluateClockCapture({ open: { offsetMs: 0 }, close: { offsetMs: 400 } }, { referenceP50Ms: 100 })
  assert.equal(drifted.ok, false)
  assert.match(drifted.reason, /clock offset 400\.0 ms exceeds/)

  // Below the floor the estimate is dominated by the probe's own round trip, so
  // a tighter budget would void healthy runs rather than catch anything.
  const fine = evaluateClockCapture({ open: { offsetMs: 2 }, close: { offsetMs: -3 } }, { referenceP50Ms: 4 })
  assert.equal(fine.ok, true)
  assert.equal(fine.driftMs, -5)
})

test('an offset the round trip can explain is NOT a clock finding', () => {
  // Point estimates of 25-44 ms have been seen with thirteen worker processes
  // and one server sharing ONE machine, where a real offset is impossible.
  // All thirteen probe the same window edge in the same
  // instant; the single-threaded server queues them and stamps its timestamp
  // late, and the whole asymmetry lands in the point estimate. Cristian's
  // estimate is only known to ±roundTrip/2, so an offset inside that interval is
  // the estimator's own error, not the clock's.
  const queued = evaluateClockCapture({
    open: { offsetMs: 3.7, uncertaintyMs: 2.2, roundTripMs: 4.5 },
    close: { offsetMs: 44, uncertaintyMs: 45, roundTripMs: 90 },
  }, { referenceP50Ms: 16 })
  assert.equal(queued.ok, true, 'a 44 ms offset over a 90 ms round trip establishes nothing')
  assert.equal(queued.uncertaintyMs, 45)
})

test('a real skew still VOIDs — the error bound does not excuse a fast round trip', () => {
  // The case the guard was written for: a worker on a second host. 500 ms of
  // offset over a 1 ms round trip cannot be the round trip.
  const skewed = evaluateClockCapture({
    open: { offsetMs: 500, uncertaintyMs: 0.5, roundTripMs: 1 },
    close: { offsetMs: 500, uncertaintyMs: 0.5, roundTripMs: 1 },
  }, { referenceP50Ms: 16 })
  assert.equal(skewed.ok, false)
  assert.match(skewed.reason, /500\.0 ms exceeds/)
  assert.match(skewed.reason, /round-trip uncertainty/)
})

test('drift is judged against the same error bound, and a real drift still VOIDs', () => {
  const noisy = evaluateClockCapture({
    open: { offsetMs: 0, uncertaintyMs: 40, roundTripMs: 80 },
    close: { offsetMs: 60, uncertaintyMs: 40, roundTripMs: 80 },
  }, { referenceP50Ms: 100 })
  assert.equal(noisy.ok, true, '60 ms of apparent drift under a ±40 ms bound with a 25 ms budget is not evidence')

  const real = evaluateClockCapture({
    open: { offsetMs: 0, uncertaintyMs: 0.5, roundTripMs: 1 },
    close: { offsetMs: 300, uncertaintyMs: 0.5, roundTripMs: 1 },
  }, { referenceP50Ms: 100 })
  assert.equal(real.ok, false)
  assert.match(real.reason, /exceeds/)
})

test('a clock capture out of budget VOIDs the whole run', () => {
  const result = evaluatePeerLoadResult(
    {
      connectedPeers: 2,
      load: {},
      convergenceLatencyMs: { count: 100 },
      serverEventLoop: { captured: true },
      clock: { ok: false, reason: 'VOID: the clock drifted 900.0 ms across the window, budget 25.0 ms' },
      convergence: { groups: [{ heads: ['h'], peers: [0, 1] }] },
    },
    { expectedPeers: 2 },
  )
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /clock drifted/)
})

test('an instrument-cost run (capture disabled) can never be published as a measurement', () => {
  const result = evaluatePeerLoadResult(
    {
      connectedPeers: 2,
      captureEnabled: false,
      load: {},
      convergenceLatencyMs: { count: 0 },
      serverEventLoop: { captured: true },
      convergence: { groups: [{ heads: ['h'], peers: [0, 1] }] },
    },
    { expectedPeers: 2 },
  )
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /latency capture was disabled/)
})

test('summarizeTier excludes VOID runs from every published number and counts them', () => {
  const voidRun = { outcome: 'void', convergenceLatencyMs: null, harnessEventLoopMs: { p99: 900 } }
  const row = summarizeTier(25, [run(30, 100), run(31, 102), voidRun])
  assert.equal(row.voided, 1)
  assert.equal(row.runs, 2, 'a void run is not a run of this tier')
  assert.deepEqual(row.latencyP99Runs, [100, 102])
  assert.equal(row.harnessEventLoopP99Ms, 10, 'the void run loop must not poison the tier gate either')
  assert.ok(row.sampleCountMin > 0)
})

test('a tier containing a VOID run is VOID, whatever its passing runs say', () => {
  const voidRun = { outcome: 'void', convergenceLatencyMs: null }
  const rows = [summarizeTier(25, [run(30, 100), run(31, 102), voidRun])]
  const result = evaluateTierTable(rows)
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /1 run\(s\) VOID/)
})
