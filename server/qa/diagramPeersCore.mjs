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

// Core of the diagram peer-load harness: N authenticated peers on ONE DiagramDoc.
//
// Why this exists: `verify-sync-cell-load-soak.mjs` requires two workspaces and
// drives the workspace OVERLAY write head. This harness puts N peers on a single
// diagram document, which is the shape the 5-100 concurrent editors goal is
// about; bare Automerge microbenchmarks are no substitute (their constants can
// disagree by more than an order of magnitude).
//
// Everything here is pure so it can be unit-tested without a stack. The runner
// (`server/scripts/verify-diagram-peer-load.mjs`) supplies the I/O.

/** Flatten the registry shards into one `DiagramMeta` list.
 *
 * The registry is the union of every shard's `diagrams` map (`RegistryShard`,
 * src/lib/automerge/types.ts). A shard that failed to resolve arrives as
 * null and is skipped rather than throwing: a partial registry still lets the
 * harness run against the diagrams it CAN see, and the caller reports the gap.
 */
export function collectDiagramMetas(shards) {
  const metas = []
  for (const shard of shards ?? []) {
    const diagrams = shard?.diagrams
    if (!diagrams || typeof diagrams !== 'object') continue
    for (const [id, meta] of Object.entries(diagrams)) {
      if (!meta || typeof meta !== 'object') continue
      if (typeof meta.docUrl !== 'string' || !meta.docUrl.startsWith('automerge:')) continue
      metas.push({ ...meta, id: meta.id ?? id })
    }
  }
  return metas
}

/** Score a diagram by how much of the goal shape it carries.
 *
 * `objectIds` on the stub is the denormalised composition (types.ts), so it
 * is available WITHOUT loading the DiagramDoc — which matters, because loading
 * 10 000 diagram documents to choose one would itself be the thing under test.
 */
export function diagramWeight(meta) {
  const objects = Array.isArray(meta?.objectIds) ? meta.objectIds.length : 0
  const connections = Array.isArray(meta?.connectionIds) ? meta.connectionIds.length : 0
  return objects + connections
}

/** Choose the diagram to load-test.
 *
 * `diagramId` pins an exact target (repeatable runs across days). Otherwise the
 * heaviest diagram wins, because the goal's hard case is 500 shapes and 1 000
 * connections, and a run against an empty diagram would pass while proving
 * nothing. Ties break on id so the choice is deterministic.
 */
export function pickDiagram(metas, { diagramId, minWeight = 0 } = {}) {
  const list = collectDiagramMetas([{ diagrams: Object.fromEntries((metas ?? []).map((m) => [m.id, m])) }])
  if (diagramId) {
    const exact = list.find((m) => m.id === diagramId)
    if (!exact) {
      const error = new Error(`diagram ${diagramId} is not in the registry`)
      error.code = 'QA_DIAGRAM_NOT_FOUND'
      throw error
    }
    return exact
  }
  const eligible = list.filter((m) => diagramWeight(m) >= minWeight)
  if (eligible.length === 0) {
    const error = new Error(
      `no diagram in the registry reaches minWeight=${minWeight} (heaviest is ${
        list.length ? Math.max(...list.map(diagramWeight)) : 0
      })`,
    )
    error.code = 'QA_NO_ELIGIBLE_DIAGRAM'
    throw error
  }
  return eligible.sort((a, b) => {
    const delta = diagramWeight(b) - diagramWeight(a)
    return delta !== 0 ? delta : String(a.id).localeCompare(String(b.id))
  })[0]
}

/** Automerge heads are unordered; compare them as sets.
 *
 * Comparing the arrays positionally would report divergence between peers that
 * are in fact identical, which is exactly the false negative that makes a
 * convergence harness worthless.
 */
export function headsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  const left = new Set(a)
  if (left.size !== a.length) return false
  return b.every((head) => left.has(head))
}

/** Group peers by the head set they currently hold.
 *
 * Returns the distinct groups largest-first. One group means converged; more
 * than one names exactly who disagrees, which is what a failing run has to
 * report to be actionable at 3am.
 */
export function convergenceGroups(peerHeads) {
  const groups = []
  for (const { peer, heads } of peerHeads) {
    const existing = groups.find((group) => headsEqual(group.heads, heads))
    if (existing) existing.peers.push(peer)
    else groups.push({ heads: [...(heads ?? [])], peers: [peer] })
  }
  return groups.sort((a, b) => b.peers.length - a.peers.length)
}

// ── Load generation and end-to-end convergence latency ──

/** Per-peer emit markers — RETIRED, kept only as the control instrument.
 *
 * `collectLatencySamples` and `BENCH_KEY` below are the original DOC-STATE
 * instrument. No runner writes `__bench` any more: document state
 * converges, so several emits arriving in one sync frame leave only the newest
 * marker, and the ones discarded are the SLOWEST — the instrument flattered the
 * very p99 it existed to publish (measured 1 recovered emit of 5).
 *
 * They stay here because `diagramPeersInstrument.test.mjs` runs BOTH instruments
 * over the SAME real sync exchange and asserts 1 against 5. Delete them and the
 * replacement's acceptance criterion becomes an assertion about itself.
 */
export const BENCH_KEY = '__bench'

/** Latency samples a receiving peer can claim from one observed document state.
 *
 * `seen` maps peerIndex -> highest sequence already counted, so a re-render or a
 * duplicate change event cannot inflate the sample count. Returns the new
 * samples AND the updated watermarks; the caller owns the state.
 */
export function collectLatencySamples(benchMap, seen, selfIndex, nowMs, runId = null) {
  const samples = []
  const next = { ...seen }
  for (const [key, marker] of Object.entries(benchMap ?? {})) {
    const peer = Number(key)
    if (!Number.isInteger(peer) || peer === selfIndex) continue
    // Markers persist in the document between campaigns, and sequence numbers
    // restart at 1 each run. Without a run scope the PREVIOUS run's markers seed
    // the watermark far ahead, a fresh run's samples are all discarded, and the
    // only samples taken are stale ones whose latency is the age of the last
    // campaign (a confident but meaningless p50).
    if (runId !== null && marker?.run !== runId) continue
    const seq = Number(marker?.seq)
    const emittedAt = Number(marker?.emittedAt)
    if (!Number.isFinite(seq) || !Number.isFinite(emittedAt)) continue
    if (next[peer] !== undefined && seq <= next[peer]) continue
    next[peer] = seq
    // A negative latency means the clocks disagree; the harness runs every peer
    // in ONE process, so that is a bug in the harness rather than a datum.
    samples.push({ from: peer, to: selfIndex, seq, latencyMs: Math.max(0, nowMs - emittedAt) })
  }
  return { samples, seen: next }
}

// ── The instrument lives in CHANGE METADATA, not in the document ──
//
// `handle.change(fn, { message })` puts the emit timestamp on the change itself.
// A receiver reads `A.getChangesMetaSince(doc, watermark)`, which returns EVERY
// change carried by the frame — coalescing costs nothing, so the slow samples
// survive — and each entry already carries `actor` and `seq`, so the emitter's
// identity and a per-emitter watermark come from Automerge rather than from a
// marker we would have to write into the document and then defend.
//
// The document therefore does not carry the bench: at 100 peers x 30 emits a
// document marker would add ~3 000 operations to the journal of the same document whose
// journal growth is the thing under study.

/** Tag identifying a change emitted by THIS bench. */
export const EMIT_MARKER_PREFIX = 't11:'

/** Encode one emit marker for `A.ChangeOptions.message`.
 *
 * Deliberately tiny — the message rides on every change, in the document's
 * history, forever. It carries the campaign id (so a concurrent or previous
 * campaign on the same diagram cannot contribute samples) and the emit instant.
 * It does NOT carry a peer identifier: `meta.actor` already is one.
 */
export function encodeEmitMarker({ runId, emittedAt, kind = 'e' }) {
  return `${EMIT_MARKER_PREFIX}${JSON.stringify({ r: runId ?? null, t: emittedAt, k: kind })}`
}

/** Decode an emit marker, or null when the change is not ours.
 *
 * The prefix check comes first so ordinary application changes (and any human
 * commit message) are rejected without paying for a JSON parse.
 */
export function decodeEmitMarker(message, runId = null) {
  if (typeof message !== 'string' || !message.startsWith(EMIT_MARKER_PREFIX)) return null
  let parsed
  try {
    parsed = JSON.parse(message.slice(EMIT_MARKER_PREFIX.length))
  } catch {
    return null
  }
  const emittedAt = Number(parsed?.t)
  if (!Number.isFinite(emittedAt)) return null
  if (runId !== null && parsed?.r !== runId) return null
  // `kind` separates load emits ('e') from the single end-of-run convergence
  // probe ('c'). The probe must advance the delivery watermark but must NOT
  // enter the latency distribution, or the sample-loss accounting — which is
  // derived from the emit count — would drift by one emit per worker.
  return { emittedAt, runId: parsed?.r ?? null, kind: parsed?.k ?? 'e' }
}

export const EMIT_KIND_LOAD = 'e'
export const EMIT_KIND_CONVERGE = 'c'

/** Latency samples a receiving peer can claim from a batch of change metadata.
 *
 * `seen` maps actor -> highest change sequence already counted. `meta.seq` is
 * Automerge's own per-actor counter, so it is monotonic by construction and a
 * duplicate change event cannot inflate the count.
 *
 * `skipped` is reported rather than discarded: "no samples" and "every sample
 * was somebody else's" are different diagnoses, and a run that cannot tell them
 * apart cannot say whether its instrument or its subject is broken.
 */
export function collectChangeMetaSamples(metas, seen, selfActors, nowMs, runId = null) {
  const samples = []
  const next = { ...seen }
  const selves = selfActors instanceof Set
    ? selfActors
    : new Set(Array.isArray(selfActors) ? selfActors : (selfActors ? [selfActors] : []))
  const skipped = { self: 0, foreign: 0, malformed: 0, duplicate: 0 }

  for (const meta of metas ?? []) {
    const actor = meta?.actor
    if (typeof actor !== 'string' || actor.length === 0) { skipped.malformed += 1; continue }
    if (selves.has(actor)) { skipped.self += 1; continue }
    const marker = decodeEmitMarker(meta?.message, runId)
    if (!marker) { skipped.foreign += 1; continue }
    const seq = Number(meta?.seq)
    if (!Number.isFinite(seq)) { skipped.malformed += 1; continue }
    if (next[actor] !== undefined && seq <= next[actor]) { skipped.duplicate += 1; continue }
    next[actor] = seq
    // A negative latency means the emitting and receiving clocks disagree. It is
    // clamped so it cannot flatter a quantile, and the clock capture (see
    // `evaluateClockCapture`) is what decides whether the run is usable at all.
    samples.push({ from: actor, seq, kind: marker.kind, latencyMs: Math.max(0, nowMs - marker.emittedAt) })
  }
  return { samples, seen: next, skipped }
}

// ── A BOUNDED accumulator, because the instrument must not grow ──
//
// At 100 peers x 30 emits x 99 receivers a campaign produces ~297 000 samples.
// Holding them in a live array is a heap that grows underneath the thing being
// timed. So samples go into a fixed-bucket histogram, and it is the
// HISTOGRAM that workers publish and the fleet pools.

/** Buckets per octave. 32 bounds the quantile overstatement at 2^(1/32)-1. */
export const HISTOGRAM_BUCKETS_PER_OCTAVE = 32
export const HISTOGRAM_QUANTILE_RELATIVE_ERROR =
  Number((2 ** (1 / HISTOGRAM_BUCKETS_PER_OCTAVE) - 1).toFixed(6))

/** Bucket index for a latency. Everything at or below 1 ms lands in bucket 0. */
export function latencyBucket(ms) {
  if (!Number.isFinite(ms) || ms <= 1) return 0
  return Math.min(2047, 1 + Math.floor(Math.log2(ms) * HISTOGRAM_BUCKETS_PER_OCTAVE))
}

/** Upper bound of a bucket, in ms. Quantiles report this bound, never the
 *  midpoint: an approximation that can only OVERSTATE a latency cannot flatter
 *  a p99. */
export function bucketUpperBoundMs(index) {
  if (index <= 0) return 1
  return 2 ** (index / HISTOGRAM_BUCKETS_PER_OCTAVE)
}

export function createLatencyHistogram() {
  return { counts: {}, count: 0, sum: 0, min: null, max: null }
}

export function recordLatency(histogram, ms) {
  if (!histogram || !Number.isFinite(ms)) return histogram
  const index = latencyBucket(ms)
  histogram.counts[index] = (histogram.counts[index] ?? 0) + 1
  histogram.count += 1
  histogram.sum += ms
  histogram.min = histogram.min === null ? ms : Math.min(histogram.min, ms)
  histogram.max = histogram.max === null ? ms : Math.max(histogram.max, ms)
  return histogram
}

/** Fold several histograms into one. This is what makes the fleet's pooled
 *  quantiles possible without shipping 297 000 numbers between processes. */
export function mergeLatencyHistograms(histograms) {
  const merged = createLatencyHistogram()
  for (const histogram of histograms ?? []) {
    if (!histogram || typeof histogram !== 'object') continue
    for (const [index, count] of Object.entries(histogram.counts ?? {})) {
      if (!Number.isFinite(Number(count))) continue
      merged.counts[index] = (merged.counts[index] ?? 0) + Number(count)
    }
    merged.count += Number(histogram.count ?? 0)
    merged.sum += Number(histogram.sum ?? 0)
    if (Number.isFinite(histogram.min)) merged.min = merged.min === null ? histogram.min : Math.min(merged.min, histogram.min)
    if (Number.isFinite(histogram.max)) merged.max = merged.max === null ? histogram.max : Math.max(merged.max, histogram.max)
  }
  return merged
}

/** Quantiles from a histogram, in the same shape `summarizeLatencies` returns
 *  so a report reads identically whichever accumulator produced it.
 *
 * `count`, `min`, `max` and `mean` are EXACT; only the quantiles are bucketed,
 * and `quantileRelativeError` publishes by how much, so nobody has to guess
 * whether a 2 % difference between two runs is a measurement or a rounding.
 */
export function summarizeHistogram(histogram) {
  const total = Number(histogram?.count ?? 0)
  if (!(total > 0)) {
    return { count: 0, p50: null, p95: null, p99: null, min: null, max: null, mean: null, quantileRelativeError: HISTOGRAM_QUANTILE_RELATIVE_ERROR }
  }
  const indices = Object.keys(histogram.counts ?? {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  const quantile = (q) => {
    const rank = Math.min(total, Math.max(1, Math.ceil(q * total)))
    let cumulative = 0
    for (const index of indices) {
      cumulative += histogram.counts[index]
      if (cumulative >= rank) {
        const bound = bucketUpperBoundMs(index)
        // Never report above what was actually observed, nor below it.
        return Number(Math.min(Math.max(bound, histogram.min ?? bound), histogram.max ?? bound).toFixed(3))
      }
    }
    return histogram.max
  }
  return {
    count: total,
    min: histogram.min,
    max: histogram.max,
    mean: Number((histogram.sum / total).toFixed(3)),
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
    quantileRelativeError: HISTOGRAM_QUANTILE_RELATIVE_ERROR,
  }
}

/** Summarise latencies. `percentile` lives in loadUsersCore; re-implemented here
 * on sorted input so this module stays dependency-free and unit-testable. */
export function summarizeLatencies(latencies) {
  const values = (latencies ?? []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (values.length === 0) return { count: 0, p50: null, p95: null, p99: null, min: null, max: null, mean: null }
  const at = (q) => values[Math.min(values.length - 1, Math.max(0, Math.ceil(q * values.length) - 1))]
  return {
    count: values.length,
    min: values[0],
    max: values[values.length - 1],
    mean: Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(3)),
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
  }
}

/** How many emits each peer owes by `elapsedMs` at `ratePerSecond`.
 *
 * Deriving the target from elapsed time rather than counting timer firings
 * means a stalled event loop shows up as a DEFICIT in the report instead of
 * silently lowering the offered load — which would make an overloaded server
 * look fast. `verify-sync-cell-load-soak` learned the same lesson.
 */
export function emitsOwed(elapsedMs, ratePerSecond) {
  if (!(ratePerSecond > 0) || !(elapsedMs > 0)) return 0
  return Math.floor((elapsedMs / 1000) * ratePerSecond)
}

/** Did the generator hold its schedule?
 *
 * Counting emits cannot answer this: after a stall the loop emits everything
 * owed in one burst, so the COUNT always catches up and a stalled run looks
 * identical to a healthy one. What a stall actually does is make each emit
 * LATE, so lateness is the signal — measured per emit as
 * `actualEmitTime - scheduledTime`. (A count gate also misfires on
 * quantisation at the window edge rather than on missed load.)
 */
export function evaluateSchedule(latenessMs, { maxP99LatenessMs = 500 } = {}) {
  const summary = summarizeLatencies(latenessMs)
  if (summary.count === 0) {
    return { ...summary, withinTolerance: false, reason: 'VOID: no emit was scheduled' }
  }
  return {
    ...summary,
    withinTolerance: summary.p99 <= maxP99LatenessMs,
    reason: summary.p99 <= maxP99LatenessMs ? null : `emit lateness p99 ${summary.p99} ms exceeds ${maxP99LatenessMs} ms`,
  }
}

// ── `void` is a THIRD verdict, and it is not a kind of failure ──
//
// "The server did not converge" and "the harness never connected" are opposite
// statements for a reader: the first is a result, the second is the absence of
// one. Folding both into `failed` (and both into exit code 1) is how an
// instrument outage gets quoted as a system measurement.
//
// Void DOMINATES failed: if any part of the run did not happen, nothing observed
// during it can be read as a result about the server, whatever else went wrong.

export const OUTCOME_EXIT_CODES = { passed: 0, failed: 1, void: 2 }

/** 0 = passed, 1 = failed, 2 = void. Anything unrecognised is 1, never 0. */
export function exitCodeForOutcome(outcome) {
  return Object.prototype.hasOwnProperty.call(OUTCOME_EXIT_CODES, outcome) ? OUTCOME_EXIT_CODES[outcome] : 1
}

/** Cristian's algorithm: one offset estimate per probe, best round trip wins.
 *
 * With every worker on one machine the offset SHOULD be zero, but that stops
 * being true the moment a worker moves to a second host. Measuring it costs one
 * HTTP round trip per window edge.
 */
export function estimateClockOffset(probes) {
  const usable = (probes ?? []).filter((p) => Number.isFinite(p?.t0) && Number.isFinite(p?.t1)
    && Number.isFinite(p?.serverMs) && p.t1 >= p.t0)
  if (usable.length === 0) return null
  const best = usable.reduce((a, b) => ((b.t1 - b.t0) < (a.t1 - a.t0) ? b : a))
  return {
    offsetMs: Number((best.serverMs - (best.t0 + best.t1) / 2).toFixed(3)),
    uncertaintyMs: Number(((best.t1 - best.t0) / 2).toFixed(3)),
    roundTripMs: Number((best.t1 - best.t0).toFixed(3)),
    probes: usable.length,
  }
}

/** Is the clock trustworthy enough for the latency this run is about to publish?
 *
 * The budget is the LARGER of an absolute floor and a fraction of the published
 * p50: an offset of 3 ms is noise next to a 300 ms p50 and is the entire signal
 * next to a 5 ms one. Below the floor the estimate is dominated by the probe's
 * own round trip, so tightening past it would void healthy runs.
 *
 * THE ESTIMATE CARRIES AN ERROR BOUND, AND THE VERDICT MUST USE IT. Cristian's
 * algorithm assumes the request and the response take the same time; when they
 * do not, the true offset is only known to lie within ±roundTrip/2 of the point
 * estimate — which `estimateClockOffset` already publishes as `uncertaintyMs`.
 * Testing the POINT estimate against the budget while ignoring that interval is
 * a misuse of the estimator, and it fails in exactly one direction: it voids the
 * runs where the server is busiest, i.e. the ones the bench exists to produce.
 *
 * Measured: with thirteen workers and one server on ONE machine (one wall
 * clock), point estimates of 25-44 ms appeared under load while an external
 * prober saw ±1.2 ms. The workers fire their probes in the same instant at the
 * same window edge of a SINGLE-THREADED server: the response is queued behind
 * the others, the server stamps its timestamp late, and the asymmetry lands
 * whole in the offset; the estimates track the round trip.
 *
 * So the test is: the offset must exceed the budget by MORE than its own
 * uncertainty. A genuine cross-host skew (500 ms over a 1 ms round trip) still
 * voids, which is the case this guard was written for.
 */
export function evaluateClockCapture(capture, { referenceP50Ms = null, floorMs = 25, fraction = 0.25 } = {}) {
  const budget = Math.max(floorMs, Number.isFinite(referenceP50Ms) ? referenceP50Ms * fraction : 0)
  const open = capture?.open ?? null
  const close = capture?.close ?? null
  if (!open || !close) {
    return { ok: false, offsetMs: null, driftMs: null, uncertaintyMs: null, budgetMs: Number(budget.toFixed(3)), reason: 'VOID: the clock offset was not captured at both edges of the window' }
  }
  const driftMs = Number((close.offsetMs - open.offsetMs).toFixed(3))
  const worst = Math.max(Math.abs(open.offsetMs), Math.abs(close.offsetMs))
  // The widest error bound of the two edges: whichever probe was worse queued is
  // the one that can explain the offset away, and it is also the one that can
  // manufacture the apparent drift between the edges.
  const uncertaintyMs = Number(Math.max(
    Number.isFinite(open.uncertaintyMs) ? open.uncertaintyMs : 0,
    Number.isFinite(close.uncertaintyMs) ? close.uncertaintyMs : 0,
  ).toFixed(3))
  const base = { offsetMs: close.offsetMs, driftMs, uncertaintyMs, budgetMs: Number(budget.toFixed(3)) }
  if (worst - uncertaintyMs > budget) {
    return { ...base, ok: false, reason: `VOID: clock offset ${worst.toFixed(1)} ms exceeds the ${budget.toFixed(1)} ms budget by more than its own ±${uncertaintyMs.toFixed(1)} ms round-trip uncertainty — the latency would be partly fabricated` }
  }
  if (Math.abs(driftMs) - uncertaintyMs > budget) {
    return { ...base, ok: false, reason: `VOID: the clock drifted ${driftMs.toFixed(1)} ms across the window (±${uncertaintyMs.toFixed(1)} ms), budget ${budget.toFixed(1)} ms` }
  }
  return { ...base, ok: true, reason: null }
}

/** Was the load actually offered at the rate that was asked for?
 *
 * `evaluateSchedule` answers "was each emit on time"; this answers "were they
 * all there". A run that emitted 60 % of the intended load measured a different
 * regime from the one its own header claims, and its quantiles describe that
 * other regime — so it is void, not slow.
 */
export function evaluateOfferedRate({ emitted, peers, ratePerSecond, durationMs, achievable = null, tolerance = 0.1 } = {}) {
  const target = (peers ?? 0) * (ratePerSecond ?? 0) * ((durationMs ?? 0) / 1000)
  if (!(target > 0)) {
    return { target: 0, achievable, emitted: emitted ?? 0, deviation: null, withinTolerance: false, reason: 'VOID: no load was scheduled, so no rate can be verified' }
  }
  // The schedule itself cannot place a peer's last emit when that peer is phase
  // shifted into the window, so the NOMINAL target is unreachable by exactly one
  // emit per shifted peer — 1/(rate x seconds) of the total, which at a 10 s
  // window is the whole ±10 % band. `achievable` is that same schedule evaluated
  // by the runner with the SAME `emitsOwed`, so a stall still shows as a deficit
  // while edge quantisation does not void an honest run. Both are published.
  const basis = Number.isFinite(achievable) && achievable > 0 ? achievable : target
  const deviation = Number(((emitted ?? 0) / basis - 1).toFixed(4))
  const within = Math.abs(deviation) <= tolerance
  return {
    target,
    achievable: Number.isFinite(achievable) ? achievable : null,
    basis,
    emitted: emitted ?? 0,
    deviation,
    tolerance,
    withinTolerance: within,
    reason: within ? null : `VOID: offered ${emitted} of ${basis} intended emits (${(deviation * 100).toFixed(1)}%), outside ±${(tolerance * 100).toFixed(0)}%`,
  }
}

/** Read the load campaign the ENVIRONMENT ordered, before anything is parsed.
 *
 * This lives here rather than inline in the runner so the shapes below are
 * driven by tests through the real function; the runner, which no test boots,
 * keeps only one call.
 *
 * `required` is not derived from the values: that is the entire point. Both
 * `Number(undefined ?? 0)` and `Number('1s')` fail `> 0`, so by the time the
 * numbers exist the ask and the absence of an ask look the same.
 */
export function buildLoadRequest(env = {}) {
  const rate = env.DIAGRAM_PEER_RATE
  const durationMs = env.DIAGRAM_PEER_DURATION_MS
  return {
    // Declined explicitly, never by omission — a load campaign is what the
    // script is for, so forgetting to ask is a mistake and not a mode.
    required: env.DIAGRAM_PEER_LOAD !== 'off',
    rate: rate ?? null,
    durationMs: durationMs ?? null,
    usable: Number(rate ?? 0) > 0 && Number(durationMs ?? 0) > 0,
  }
}

/** Decide the run's outcome. Kept separate from the runner so the pass/fail
 * rule itself is unit-tested rather than only exercised by a live stack.
 *
 * Returns `{ outcome, failures, voids, reasons }`. `voids` are the ways the run
 * did not happen; `failures` are the ways the SYSTEM did not hold. Only the
 * second kind is a result about the server.
 */
export function evaluatePeerLoadResult(result, {
  expectedPeers,
  requireConvergence = true,
  // With the change-metadata instrument, coalescing does not eat samples, so a
  // loss above a couple of percent means something real is dropping data.
  maxSampleLossRatio = 0.02,
  requireServerEventLoop = true,
  rateTolerance = 0.1,
  // "Was a load campaign ASKED FOR" cannot be answered from the parsed numbers:
  // `load: null` is what BOTH "nobody asked" and "the ask was unusable"
  // produce. It IS answerable from the report, because the runner publishes
  // `loadRequest`.
  //
  // Defaulted from `result` rather than passed by each caller, so no call site
  // can forget it. A report without `loadRequest` VOIDs (`?? true`, fail
  // closed), and a stored `DIAGRAM_PEER_REPORT` artifact is SELF-GRADING:
  // re-reading it yields the verdict the run yielded.
  requireLoad = result?.loadRequest?.required ?? true,
} = {}) {
  const failures = []
  const voids = []
  const connected = result?.connectedPeers ?? 0

  if (!Number.isInteger(expectedPeers) || expectedPeers < 1) {
    voids.push('VOID: expectedPeers must be a positive integer')
  } else if (connected !== expectedPeers) {
    voids.push(`VOID: only ${connected}/${expectedPeers} peers connected — the requested regime was never offered`)
  }

  if (result?.captureEnabled === false) {
    voids.push('VOID: latency capture was disabled (instrument-cost run) — this run measures the harness, not the server')
  }

  // The subject must not have been grown by an earlier run. This is the
  // dominant confound the bench has: the same configuration measured 42 ms on a
  // fresh document and 650/724 ms once campaigns had piled up in its journal,
  // with two A/A arms agreeing with each other perfectly.
  if (result?.seedFreshness && result.seedFreshness.ok === false) {
    voids.push(result.seedFreshness.reason ?? 'VOID: the target document was not fresh for this run')
  }

  // A campaign that ran but collected NO latency is not a pass. The bare
  // invocation (rate defaults to 0) and a typo'd rate (`Number('1s')` is NaN,
  // so the load block is skipped) both produce `load: null`, which the voids
  // inside `if (result.load)` cannot see.
  //
  // Making those voids unconditional would be worse: a void wins the outcome,
  // so a genuine convergence failure on a load-less run would be reported as
  // `void` instead of `failed`. So the missing fact is supplied instead of
  // inferred: `requireLoad` says whether a campaign was asked for, and the
  // runner publishes `loadRequest` saying what the environment offered.
  if (requireLoad && !result?.load) {
    const request = result?.loadRequest
    const detail = request
      ? `rate=${JSON.stringify(request.rate ?? null)} durationMs=${JSON.stringify(request.durationMs ?? null)}`
      : 'the runner published no loadRequest'
    voids.push(`VOID: a load campaign was required but none ran (${detail}) — the quantiles would describe a run with no load in it`)
  }
  if (result?.load) {
    const count = result?.convergenceLatencyMs?.count ?? 0
    if (count === 0 && result?.captureEnabled !== false) {
      voids.push('VOID: the campaign ran but collected ZERO latency samples')
    }
    const loss = result?.sampleLoss
    if (loss && Number.isFinite(loss.ratio) && loss.ratio > maxSampleLossRatio) {
      voids.push(`VOID: sample loss ${(loss.ratio * 100).toFixed(1)}% exceeds ${(maxSampleLossRatio * 100).toFixed(1)}% (${loss.observed}/${loss.expected}) — the instrument did not observe the run it is reporting on`)
    }
    const rate = result?.load?.offeredRate
    if (rate && rate.withinTolerance === false) {
      voids.push(rate.reason ?? `VOID: the offered rate missed its target by more than ±${(rateTolerance * 100).toFixed(0)}%`)
    }
    // The server's event-loop window. Without it the report can only publish
    // the HARNESS's loop, which is a client cost presented as a server cost.
    //
    // `delegated` is the fleet case and NOT a hole: `?eventLoopWindow=consume`
    // resets the window, so W workers consuming would each destroy what the
    // others measure. Exactly one process captures, and the coordinator asserts
    // its own capture — a worker that delegated to nobody is caught there, not
    // here, because here it is indistinguishable from a correct delegation.
    const serverLoop = result?.serverEventLoop
    if (requireServerEventLoop && !serverLoop?.captured && !serverLoop?.delegated) {
      voids.push(`VOID: the server event-loop window was not captured (${serverLoop?.reason ?? 'no capture attempted'}) — server cost and client cost cannot be told apart`)
    }
    // Captured is not the same as COVERING. Another explicit consumer can reset
    // the qualification window, so a campaign can be handed a window that starts
    // halfway through itself — a truncated
    // interval quoted as the campaign's, with every other field looking healthy.
    // `ok: null` is the delegated case, where the coordinator answers instead.
    if (serverLoop?.windowCoverage && serverLoop.windowCoverage.ok === false) {
      voids.push(serverLoop.windowCoverage.reason ?? 'VOID: the server event-loop window does not cover this campaign')
    }
    if (result?.clock && result.clock.ok === false) {
      voids.push(result.clock.reason ?? 'VOID: the clock capture is out of budget')
    }
  }

  if (requireConvergence) {
    if (!result?.convergence) {
      voids.push('VOID: no convergence observation was recorded')
    } else if (!Array.isArray(result.convergence.groups) || result.convergence.groups.length === 0) {
      // Zero groups means no peer was inspected; only exactly one group is a pass.
      voids.push('VOID: convergence produced no head-set groups')
    } else if (result.convergence.groups.length !== 1) {
      const detail = result.convergence.groups
        .map((group) => `${group.peers.length} peer(s) @ ${group.heads.join(',') || '<none>'}`)
        .join(' | ')
      failures.push(`peers did not converge: ${result.convergence.groups.length} head sets — ${detail}`)
    } else if (result.convergence.markerVisibleOnEveryPeer === false) {
      // Equal heads with the marker missing means the peers agree on a state
      // that predates the write — agreement is not the same as delivery.
      failures.push('peers share one head set but the marker never reached every peer')
    }
  }

  const outcome = voids.length > 0 ? 'void' : (failures.length > 0 ? 'failed' : 'passed')
  return { outcome, failures, voids, reasons: [...voids, ...failures] }
}

/** Blank every quantile a void run would otherwise publish.
 *
 * A void run whose JSON still carries a p99 WILL be quoted — the number reads
 * exactly like a measurement, and nothing about it says the run did not happen.
 * `null` cannot be quoted.
 */
export function redactVoidQuantiles(report) {
  if (!report || report.outcome !== 'void') return report
  return {
    ...report,
    convergenceLatencyMs: null,
    // The emit leg is a published quantile like any other: a void run whose JSON
    // still carries `emitMs.p99` hands a reader a number from a run that did not
    // happen, and nothing about the field says so.
    emitMs: null,
    latencyHistogram: null,
    emitHistogram: null,
    pooledLatency: null,
    pooledEmitMs: null,
    quantilesRedacted: 'the run is void: its quantiles describe an incomplete execution and are withheld so they cannot be cited',
  }
}

// ── The tier sweep, made readable ──
//
// Three things a tier table needs to mean anything.
//
// 1. INTERLEAVING. Running 25,25,25 then 50,50,50 then 100,100,100 makes
//    "tier" also "elapsed time": machine warm-up, PostgreSQL growth and any
//    other activity are all billed to the LAST tier, which is the one the goal
//    is about. A control that moves two variables settles nothing.
// 2. THE RUN IS THE UNIT. A campaign yields ~297 000 samples, but they come from
//    one server in one state, so they are not independent. A confidence interval
//    over samples would be wrong by an order of magnitude. Replication happens at
//    the RUN, and three runs estimate a dispersion badly — which is a fact to
//    publish, not to hide behind a tidy median.
// 3. AN A/A FLOOR. Running the identical configuration twice under two arm
//    labels and REQUIRING the bench to answer "no difference" is the only thing
//    that makes "the p99 rose 30 %" interpretable: below the floor, the bench
//    refuses the comparison instead of publishing an inconclusive gain.

/** Interleave the tiers and rotate the order of each round.
 *
 * Round r runs every tier once, rotated by r so no tier is always first — the
 * position inside a round is itself a confound (the first run of a round pays
 * for whatever the previous round left warm). Returns the plan, which the report
 * publishes verbatim: an order that is not published cannot be checked.
 */
export function planInterleavedRuns(arms, runs, { rotate = true } = {}) {
  // An arm is a peer count, or `{ tier, label }` when two arms share a count —
  // which is exactly the A/A calibration, whose whole point is that both arms
  // ARE the same configuration. Folding the calibration into the same plan is
  // deliberate: run it before or after the sweep and it measures a different
  // stretch of the machine's day than the sweep it is the floor for.
  const list = (arms ?? [])
    .map((entry) => (typeof entry === 'object' && entry !== null ? entry : { tier: entry, label: `tier-${entry}` }))
    .filter((entry) => Number.isInteger(entry.tier) && entry.tier > 0)
  const total = Math.max(1, Number(runs) || 1)
  const plan = []
  for (let round = 0; round < total; round += 1) {
    const shift = rotate ? round % Math.max(1, list.length) : 0
    const ordered = [...list.slice(shift), ...list.slice(0, shift)]
    for (const arm of ordered) {
      plan.push({ tier: arm.tier, label: arm.label ?? `tier-${arm.tier}`, round, run: round + 1, position: plan.length })
    }
  }
  return plan
}

/** The smallest ratio this bench is entitled to call a difference.
 *
 * Two independent floors, and the larger wins:
 *
 *  - the INSTRUMENT floor: both quantiles come out of a bucketed histogram, so
 *    two identical distributions can already read (1+e)/(1-e) apart;
 *  - the NOISE floor: the worst within-arm spread actually observed. A bench
 *    cannot resolve a between-arm difference smaller than its own within-arm
 *    disagreement.
 *
 * `permutationFloorP` is published because it is the fact people most want not
 * to hear: with n runs per arm the smallest two-sided exact permutation p-value
 * is 2/C(2n, n) — 0.1 at n=3. So at three runs an arm, no amount of separation
 * reaches p<0.05, and the only honest claim is COMPLETE SEPARATION of the arms.
 */
export function computeMinimumDetectableRatio({ armSpreads = [], runsPerArm = 3, quantileRelativeError = HISTOGRAM_QUANTILE_RELATIVE_ERROR } = {}) {
  const error = Number.isFinite(quantileRelativeError) ? quantileRelativeError : 0
  const instrumentFloor = Number(((1 + error) / (1 - error)).toFixed(4))
  const spreads = (armSpreads ?? []).filter((value) => Number.isFinite(value) && value > 0)
  const noiseFloor = spreads.length > 0 ? Math.max(...spreads) : null
  const ratio = noiseFloor !== null && noiseFloor > instrumentFloor ? Number(noiseFloor.toFixed(4)) : instrumentFloor
  const n = Math.max(1, Math.floor(runsPerArm))
  // C(2n, n) without factorials, so n=20 does not overflow into nonsense.
  let choose = 1
  for (let i = 1; i <= n; i += 1) choose = (choose * (n + i)) / i
  return {
    ratio,
    basis: ratio === instrumentFloor ? 'instrument' : 'within-arm noise',
    instrumentFloor,
    noiseFloor,
    runsPerArm: n,
    permutationFloorP: Number((2 / Math.round(choose)).toFixed(4)),
    separationRequired: 2 / Math.round(choose) > 0.05,
  }
}

const medianOf = (values) => {
  if (!values || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

const spreadOf = (values) => {
  if (!values || values.length < 2) return null
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  return lo > 0 ? Number((hi / lo).toFixed(4)) : null
}

/** The A/A calibration: run the SAME configuration twice under two arm labels
 * and require the bench to answer "no difference".
 *
 * This is the noise floor, and without it every comparison the sweep publishes
 * is uninterpretable.
 *
 * A FAILING A/A is not a slow run: it is proof that the floor is higher than the
 * bench believes, so every comparison in the campaign is void.
 */
export function evaluateAaCalibration({ armA, armB, quantileRelativeError = HISTOGRAM_QUANTILE_RELATIVE_ERROR, label = 'A/A' } = {}) {
  const a = (armA ?? []).filter((value) => Number.isFinite(value) && value > 0)
  const b = (armB ?? []).filter((value) => Number.isFinite(value) && value > 0)
  const spreads = [spreadOf(a), spreadOf(b)].filter((value) => Number.isFinite(value))
  const mdr = computeMinimumDetectableRatio({
    armSpreads: spreads,
    runsPerArm: Math.min(a.length || 1, b.length || 1),
    quantileRelativeError,
  })
  const base = {
    label,
    armA: a,
    armB: b,
    armAMedian: medianOf(a),
    armBMedian: medianOf(b),
    armSpreads: spreads,
    minimumDetectableRatio: mdr.ratio,
    minimumDetectableRatioBasis: mdr.basis,
    permutationFloorP: mdr.permutationFloorP,
    // A permutation floor with no run count attached is unreadable: p=0.1 means
    // something only once you know it is 3 runs an arm.
    runsPerArm: mdr.runsPerArm,
    separationRequired: mdr.separationRequired,
  }
  if (a.length < 2 || b.length < 2) {
    return {
      ...base,
      ok: false,
      verdict: 'insufficient',
      observedRatio: null,
      reason: `VOID: the ${label} calibration needs at least two runs an arm to estimate a floor (${a.length} and ${b.length})`,
    }
  }
  const hi = Math.max(base.armAMedian, base.armBMedian)
  const lo = Math.min(base.armAMedian, base.armBMedian)
  const observedRatio = Number((hi / lo).toFixed(4))
  if (observedRatio > mdr.ratio) {
    return {
      ...base,
      ok: false,
      verdict: 'difference-detected',
      observedRatio,
      reason: `VOID: the ${label} calibration found a ${observedRatio}x difference between two runs of the IDENTICAL configuration, above the ${mdr.ratio}x floor — the noise floor is higher than this bench believes, so no comparison it publishes is interpretable`,
    }
  }
  return { ...base, ok: true, verdict: 'no-difference', observedRatio, reason: null }
}

/** Did every worker end the campaign on the SAME document state?
 *
 * The per-worker convergence check is structurally blind here: each worker only
 * inspects its own peers, so W workers can each agree with themselves on W
 * different states and every one of them reports success. That is precisely the
 * claim the bench exists to support — N peers on ONE document converge — so it
 * has to be asserted across processes, not inside one.
 *
 * A divergence is a FAILURE (a result about the system). A missing head set is
 * VOID (the observation was not made).
 */
export function evaluateGlobalHeadConvergence(reports) {
  const list = reports ?? []
  const missing = []
  const observed = []
  list.forEach((report, index) => {
    const heads = report?.convergence?.headSet
    if (!Array.isArray(heads) || heads.length === 0) missing.push(report?.workerIndex ?? index)
    else observed.push({ worker: report?.workerIndex ?? index, heads: [...heads].sort() })
  })
  if (list.length === 0 || missing.length > 0) {
    return {
      ok: false,
      verdict: 'unobserved',
      distinctHeadSets: 0,
      groups: [],
      reason: list.length === 0
        ? 'VOID: no worker reported a head set, so cross-process convergence was never observed'
        : `VOID: worker(s) ${missing.join(', ')} published no converged head set — cross-process convergence was not observed for them`,
    }
  }
  const groups = []
  for (const entry of observed) {
    const existing = groups.find((group) => headsEqual(group.heads, entry.heads))
    if (existing) existing.workers.push(entry.worker)
    else groups.push({ heads: entry.heads, workers: [entry.worker] })
  }
  groups.sort((a, b) => b.workers.length - a.workers.length)
  if (groups.length !== 1) {
    const detail = groups
      .map((group) => `worker(s) ${group.workers.join('/')} @ ${group.heads.join(',').slice(0, 60)}`)
      .join(' | ')
    return {
      ok: false,
      verdict: 'diverged',
      distinctHeadSets: groups.length,
      groups,
      reason: `the fleet did NOT converge across processes: ${groups.length} head sets — ${detail}`,
    }
  }
  return { ok: true, verdict: 'converged', distinctHeadSets: 1, groups, reason: null }
}

/** Exactly one process may CONSUME the server's event-loop window.
 *
 * `?eventLoopWindow=consume` resets the window, so two consumers destroy each
 * other's measurement and both publish an interval of unrelated length. The
 * runner delegates when told to; this asserts that it actually did, from the
 * coordinator, which is the only place that can see all the workers at once.
 */
export function evaluateServerWindowOwnership(reports, { coordinatorCaptured = false } = {}) {
  const extraConsumers = []
  ;(reports ?? []).forEach((report, index) => {
    const loop = report?.serverEventLoop
    if (!loop) return
    if (loop.delegated !== true) extraConsumers.push(report?.workerIndex ?? index)
  })
  const consumers = (coordinatorCaptured ? 1 : 0) + extraConsumers.length
  if (extraConsumers.length > 0) {
    return {
      ok: false,
      consumers,
      extraConsumers,
      reason: `VOID: worker(s) ${extraConsumers.join(', ')} also consumed the server event-loop window — every consume RESETS it, so the workers and the coordinator each measured a fragment of the campaign`,
    }
  }
  if (consumers !== 1) {
    return {
      ok: false,
      consumers,
      extraConsumers,
      reason: 'VOID: nobody consumed the server event-loop window — server cost and client cost cannot be told apart',
    }
  }
  return { ok: true, consumers: 1, extraConsumers: [], reason: null }
}

/** Does the window the server handed back actually COVER the campaign?
 *
 * Another explicit stats consumer can reset the qualification histogram (the
 * periodic logger uses a separate histogram; older servers shared it). A late
 * start reveals a truncated interval in either case.
 *
 * `windowStartedAtMs` is what the server publishes about its own window. Absent,
 * the answer is UNKNOWN, and unknown is not ok.
 */
export function evaluateServerWindowCoverage({ openedAtMs, closedAtMs, windowStartedAtMs, toleranceMs = 1_000 } = {}) {
  if (!Number.isFinite(windowStartedAtMs)) {
    return {
      ok: false,
      verdict: 'unknown',
      truncatedMs: null,
      reason: 'VOID: the server published no event-loop window start, so nothing says whether the window covers this campaign or a fragment of it',
    }
  }
  if (!Number.isFinite(openedAtMs) || !Number.isFinite(closedAtMs)) {
    return { ok: false, verdict: 'unknown', truncatedMs: null, reason: 'VOID: the campaign did not record both window edges' }
  }
  const truncatedMs = Math.round(windowStartedAtMs - openedAtMs)
  if (truncatedMs > toleranceMs) {
    return {
      ok: false,
      verdict: 'truncated',
      truncatedMs,
      reason: `VOID: the server's event-loop window began ${truncatedMs} ms after this campaign opened it — another consumer reset the window mid-run, so the server numbers describe ${closedAtMs - windowStartedAtMs} ms of a ${closedAtMs - openedAtMs} ms campaign`,
    }
  }
  return { ok: true, verdict: 'covers', truncatedMs, reason: null }
}

/** Is the MACHINE the bottleneck rather than the server?
 *
 * 32 logical CPUs, a single-threaded server, and everything — Vite, PostgreSQL,
 * W workers, K browsers — on one box. A bench saturated by its own harness
 * measures the harness. The 70 % ceiling is not invented here: it is the one the
 * capacity certificate already imposes (`certify-provider-capacity.mjs`).
 */
export function evaluateMachineSaturation(samples, { maxRatio = 0.7 } = {}) {
  const ratios = (samples ?? []).map((sample) => sample?.busyRatio).filter((value) => Number.isFinite(value))
  if (ratios.length === 0) {
    return { ok: false, peakRatio: null, meanRatio: null, samples: 0, maxRatio, reason: 'VOID: machine CPU was never sampled, so nothing says whether the bench or the server was the bottleneck' }
  }
  const peakRatio = Math.max(...ratios)
  const meanRatio = ratios.reduce((sum, value) => sum + value, 0) / ratios.length
  if (peakRatio > maxRatio) {
    return {
      ok: false,
      peakRatio,
      meanRatio,
      samples: ratios.length,
      maxRatio,
      reason: `VOID: aggregate machine CPU peaked at ${(peakRatio * 100).toFixed(1)}%, above ${(maxRatio * 100).toFixed(0)}% — at that point the bench is measuring the machine, not the server`,
    }
  }
  return { ok: true, peakRatio, meanRatio, samples: ratios.length, maxRatio, reason: null }
}

/** Does every peer that will emit actually own a non-empty target pool?
 *
 * Catches a multi-process mismatch: `assignTargets` called with the LOCAL peer
 * count while the lookup uses the GLOBAL peer index makes every worker but the
 * first miss. `pool[emitted % 0]` is `pool[NaN]` is `undefined`, so those peers
 * all write to `doc.layouts.undefined` — ONE shared key, in a run whose header
 * says the contention mode is `disjoint`. Nothing throws and nothing is null.
 */
export function evaluateTargetCoverage(targets, peerIndices) {
  const list = targets ?? []
  const uncovered = (peerIndices ?? []).filter((index) => {
    const pool = list[index]
    return !Array.isArray(pool) || pool.length === 0
  })
  if (uncovered.length > 0) {
    return {
      ok: false,
      uncovered,
      poolCount: list.length,
      reason: `VOID: peer(s) ${uncovered.slice(0, 8).join(', ')}${uncovered.length > 8 ? '…' : ''} have no target pool (${list.length} pools for peer indices up to ${Math.max(...(peerIndices ?? [0]))}) — those peers would all write to ONE shared key and the run's contention mode would be a fiction`,
    }
  }
  return { ok: true, uncovered: [], poolCount: list.length, reason: null }
}

// ── Tiers of peers, repeated runs, comparative report ──

/** Fold repeated runs of one tier into a comparison row.
 *
 * Reports the SPREAD across runs, not just a median: a cold first run and warm
 * later runs make a median hide the case users actually hit. A tier whose runs
 * disagree is a tier you have not measured yet, and `spreadRatio` says so.
 *
 * The RANGE is published beside every median: two consecutive runs of the same
 * code have differed by 41 %, and a median with no range is a claim with no
 * error bar.
 */
export function summarizeTier(peers, runs) {
  const withOutcome = (runs ?? []).filter((run) => run && run.outcome)
  // A VOID run is not a slow run: it is a run that did not happen. It may not
  // enter a median, a spread, or a sample-count minimum — a tier that folded one
  // in would publish a curve point derived from an execution nobody observed.
  const voided = withOutcome.filter((run) => run.outcome === 'void')
  const usable = withOutcome.filter((run) => run.outcome !== 'void')
  const passed = usable.filter((run) => run.outcome === 'passed')
  // Medians are taken over PASSING runs only: folding a failed run into the
  // published p99 lets a broken run drag or flatter the headline number.
  const p99s = passed.map((run) => run.convergenceLatencyMs?.p99).filter((n) => Number.isFinite(n))
  const p50s = passed.map((run) => run.convergenceLatencyMs?.p50).filter((n) => Number.isFinite(n))
  const loops = usable.map((run) => run.harnessEventLoopMs?.p99).filter((n) => Number.isFinite(n))
  const samples = usable.map((run) => run.convergenceLatencyMs?.count ?? 0)

  const median = medianOf
  const spread = spreadOf
  // The range is published even for a single run — as {min, max} of that one
  // value — so a reader never sees a median without an interval beside it. What
  // a single run does NOT get is a spread ratio: it agrees with itself vacuously.
  const range = (values) => (values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) })

  return {
    peers,
    runs: usable.length,
    voided: voided.length,
    passed: passed.length,
    latencyP50Median: median(p50s),
    latencyP50Range: range(p50s),
    latencyP99Median: median(p99s),
    latencyP99Range: range(p99s),
    latencyP99Runs: p99s,
    latencyP50Runs: p50s,
    // >1 means the runs disagree; how much is too much is decided by the A/A
    // floor, not by a constant — see `evaluateTierTable`.
    latencyP99SpreadRatio: spread(p99s),
    harnessEventLoopP99Median: median(loops),
    // Worst loop delay across runs — the gate uses this, not the median, because
    // one saturated run is enough to void the tier.
    harnessEventLoopP99Ms: loops.length ? Math.max(...loops) : null,
    sampleCountMin: samples.length ? Math.min(...samples) : 0,
  }
}

/** A tier is only reportable when every run passed AND the runs agree.
 *
 * Without the spread test a tier where one run converged in 40 ms and another in
 * 4 000 ms would publish a tidy median and hide the failure mode entirely.
 *
 * The spread is judged against the A/A floor when one exists:
 * `maxSpreadRatio = 1.5` sits at the level of the observed noise, so it is kept
 * only as a PUBLISHED fallback. The gate uses the A/A floor — a bench may not call a spread excessive
 * below the dispersion it has just measured on two identical runs. And a sweep
 * with NO calibration for this commit is void: a comparison without a floor is
 * not a weak result, it is not a result.
 */
export function evaluateTierTable(rows, { maxSpreadRatio = 1.5, maxHarnessLoopP99Ms = 100, minRuns = 2, calibration = undefined, requireCalibration = true } = {}) {
  const failures = []
  const voids = []
  const verdict = () => ({
    outcome: voids.length > 0 ? 'void' : (failures.length > 0 ? 'failed' : 'passed'),
    failures,
    voids,
    reasons: [...voids, ...failures],
    spreadGate,
    calibration: calibration ?? null,
  })
  // The floor actually applied, and where it came from — a gate whose threshold
  // is not in the report is a gate nobody can re-derive.
  let spreadGate = { ratio: maxSpreadRatio, source: 'constant (no calibration)' }
  if (requireCalibration && (calibration === null || calibration === undefined)) {
    voids.push('VOID: this sweep carries no A/A calibration, so it has no noise floor — every spread verdict below would be a comparison against a constant nobody measured')
  } else if (calibration && calibration.ok === false) {
    voids.push(calibration.reason ?? 'VOID: the A/A calibration failed, so every comparison in this sweep is uninterpretable')
  } else if (calibration && Number.isFinite(calibration.minimumDetectableRatio)) {
    spreadGate = { ratio: calibration.minimumDetectableRatio, source: `A/A calibration (${calibration.minimumDetectableRatioBasis ?? 'measured'})`, published: maxSpreadRatio }
  }
  if (!rows || rows.length === 0) {
    voids.push('VOID: no tier produced a run')
    return verdict()
  }
  for (const row of rows) {
    if (row.voided > 0) voids.push(`${row.peers} peers: ${row.voided} run(s) VOID — excluded from every published number`)
    if (row.runs === 0) { voids.push(`${row.peers} peers: VOID, no run completed`); continue }
    if (row.passed !== row.runs) failures.push(`${row.peers} peers: only ${row.passed}/${row.runs} runs passed`)
    if (row.sampleCountMin === 0) voids.push(`${row.peers} peers: a run produced ZERO latency samples`)
    if (row.runs < minRuns) {
      voids.push(`${row.peers} peers: ${row.runs} run(s) — a single run agrees with itself vacuously, ${minRuns} are required`)
    }
    // The decisive gate: a p99 measured while the HARNESS's own event loop is
    // saturated describes the instrument, not the server.
    if (Number.isFinite(row.harnessEventLoopP99Ms) && row.harnessEventLoopP99Ms > maxHarnessLoopP99Ms) {
      // VOID, not failed: `failed` would still invite reading it as "the
      // server is slow".
      voids.push(`VOID: ${row.peers} peers: harness event-loop p99 ${row.harnessEventLoopP99Ms} ms exceeds ${maxHarnessLoopP99Ms} ms — this tier measures the harness, not the server`)
    }
    if (row.latencyP99SpreadRatio !== null && row.latencyP99SpreadRatio > spreadGate.ratio) {
      failures.push(`${row.peers} peers: p99 spread ${row.latencyP99SpreadRatio}x across runs exceeds the ${spreadGate.ratio}x floor from ${spreadGate.source} — the median is hiding something`)
    }
  }
  return verdict()
}

// ── The fleet pools HISTOGRAMS, and says so when it cannot ──

/** Pool the per-worker latency histograms into one distribution.
 *
 * An aggregate with no data must say so (a VOID reason), because a `null`
 * beside a populated per-worker table reads as "not applicable" rather than
 * "broken".
 */
export function poolWorkerLatency(reports) {
  const histograms = []
  const missing = []
  ;(reports ?? []).forEach((report, index) => {
    const histogram = report?.latencyHistogram
    if (histogram && Number.isFinite(Number(histogram.count)) && Number(histogram.count) > 0) histograms.push(histogram)
    else missing.push(report?.workerIndex ?? index)
  })
  if (histograms.length === 0) {
    return {
      pooled: null,
      merged: null,
      workersPooled: 0,
      workersMissing: missing,
      reason: 'VOID: no worker published a latency histogram — a pooled quantile here would be invented, not measured',
    }
  }
  const merged = mergeLatencyHistograms(histograms)
  return {
    pooled: summarizeHistogram(merged),
    merged,
    workersPooled: histograms.length,
    workersMissing: missing,
    reason: missing.length > 0
      ? `VOID: ${missing.length} of ${histograms.length + missing.length} workers published no histogram — the pool is not the fleet`
      : null,
  }
}

// ── The document must be FRESH for every RUN, not for every campaign ──
//
// The dominant confound this bench has: THE SUBJECT GROWS WHILE IT IS MEASURED.
// The identical 25-peer configuration has measured p99 = 42 ms on a fresh
// document and 650-724 ms later, with two A/A arms agreeing within 1.11x while
// sitting 15x above the fresh run. Interleaving cannot remove that — it balances a drift across arms, and this is
// not a drift across arms, it is an accumulation inside the SUBJECT: every run
// leaves its ~N x rate x seconds changes in the document's operation journal, and
// the next run pays for them on every sync message the server generates.
//
// So a run's document has to be minted for THAT RUN. And "has to be" is worth
// nothing unless somebody looks: the witness below is what makes it an assertion.
// `A.stats(doc)` answers `{ numChanges, numOps }` in ~0.03 ms whatever the
// journal holds, where `getChangesMetaSince(doc, [])` costs 11.9 ms at 3 001
// changes — a witness that walks the journal would itself be part of the
// phenomenon.

/** Was this campaign offered a fresh document, and the SAME one, everywhere?
 *
 * `witnesses` are `{ worker, documentId, changesAtAttach, opsAtAttach }`, one per
 * process that attached peers. Three ways this answers no, and they are different
 * findings:
 *
 *  - `unobserved` — nobody published a witness, so the run cannot say WHAT it
 *    measured. Void, and never "fresh by default".
 *  - `split` — the workers attached to different documents, so the campaign was
 *    not one campaign at all. Void.
 *  - `grown` — the document already carried changes when the peers arrived, so
 *    the quantiles include the cost of somebody else's history. Void, with the
 *    surplus named, because "42 ms" and "724 ms" on this bench were the same
 *    configuration on a journal of different lengths.
 */
export function evaluateSeedFreshness(witnesses, { expectedChanges = null } = {}) {
  const list = (witnesses ?? []).filter((entry) => entry && typeof entry === 'object')
  const usable = list.filter((entry) => typeof entry.documentId === 'string' && entry.documentId.length > 0
    && Number.isFinite(Number(entry.changesAtAttach)))
  const base = {
    documentId: usable[0]?.documentId ?? null,
    expectedChanges,
    changesAtAttach: null,
    opsAtAttach: null,
    witnesses: usable.length,
  }
  if (usable.length === 0) {
    return { ...base, ok: false, verdict: 'unobserved', reason: 'VOID: no process reported which document it attached to, nor how long its journal already was — the run cannot say whether it measured a fresh diagram or the residue of every campaign before it' }
  }
  const changes = usable.map((entry) => Number(entry.changesAtAttach))
  const ops = usable.map((entry) => Number(entry.opsAtAttach)).filter(Number.isFinite)
  const documentIds = [...new Set(usable.map((entry) => entry.documentId))]
  const witness = {
    ...base,
    documentId: documentIds[0],
    changesAtAttach: { min: Math.min(...changes), max: Math.max(...changes) },
    opsAtAttach: ops.length > 0 ? { min: Math.min(...ops), max: Math.max(...ops) } : null,
  }
  if (documentIds.length !== 1) {
    return {
      ...witness,
      documentId: null,
      ok: false,
      verdict: 'split',
      reason: `VOID: the fleet attached to ${documentIds.length} different documents (${documentIds.join(', ').slice(0, 120)}) — this is N benches on N diagrams, not N peers on one`,
    }
  }
  // `Number(null)` is 0 and `Number.isFinite(0)` is true, so a laxer test here
  // turns "no expectation given" into "expect zero changes" and voids every
  // ungated run.
  const gate = expectedChanges === null || expectedChanges === undefined ? null : Number(expectedChanges)
  // The EARLIEST observation is the one that answers the question. Peers attach
  // over several seconds and a fleet's workers attach concurrently, so a peer
  // that arrives after the start barrier legitimately sees the campaign's own
  // changes — gating on the maximum turns that ordinary race into a void on
  // every run. Growth that predates
  // the campaign is visible to EVERY peer, including the first, so the minimum
  // catches a stale document while ignoring a late arrival. (A worker that
  // actually missed the barrier is caught by emit lateness, which is a different
  // fault with a different name.)
  if (gate !== null && Number.isFinite(gate) && witness.changesAtAttach.min > gate) {
    const surplus = witness.changesAtAttach.min - gate
    return {
      ...witness,
      ok: false,
      verdict: 'grown',
      reason: `VOID: the document already carried ${witness.changesAtAttach.min} change(s) when the FIRST peer attached, ${surplus} more than the ${gate} its seed wrote — the quantiles would include the journal a previous campaign left behind, which is how the identical configuration published 42 ms once and 724 ms later`,
    }
  }
  return { ...witness, ok: true, verdict: 'fresh', reason: null }
}

/** Did every run of a sweep get its OWN document?
 *
 * A per-CAMPAIGN seed is not enough: run 2 of a tier inherits run 1's journal,
 * and the last arm of the last round inherits everything. Reuse is only
 * legitimate when a run is deliberately the CONTROL for exactly this effect, so
 * those labels are declared rather than inferred — an exemption nobody declared
 * is indistinguishable from the defect.
 */
export function evaluateRunSeedRotation(runs, { reusedLabels = [] } = {}) {
  const exempt = new Set(reusedLabels ?? [])
  const list = (runs ?? []).filter((entry) => entry && typeof entry === 'object')
  const missing = list.filter((entry) => typeof entry.documentId !== 'string' || entry.documentId.length === 0)
  const rotating = list.filter((entry) => !exempt.has(entry.label) && typeof entry.documentId === 'string' && entry.documentId.length > 0)
  if (list.length === 0) {
    return { ok: false, documentIds: [], reused: [], reason: 'VOID: the sweep recorded no per-run document, so nothing says each run was offered a fresh one' }
  }
  if (missing.length > 0) {
    const named = missing.map((entry) => `${entry.label}#${entry.run}`).join(', ')
    return { ok: false, documentIds: [], reused: [], reason: `VOID: run(s) ${named} recorded no document id — freshness is unobserved for them, and unobserved is not fresh` }
  }
  const byDocument = new Map()
  for (const entry of rotating) {
    const seen = byDocument.get(entry.documentId) ?? []
    seen.push(`${entry.label}#${entry.run}`)
    byDocument.set(entry.documentId, seen)
  }
  const reused = [...byDocument.entries()].filter(([, seen]) => seen.length > 1)
  if (reused.length > 0) {
    const detail = reused.map(([documentId, seen]) => `${documentId.slice(0, 12)}… by ${seen.join(' + ')}`).join(' | ')
    return {
      ok: false,
      documentIds: [...byDocument.keys()],
      reused: reused.map(([documentId, seen]) => ({ documentId, runs: seen })),
      reason: `VOID: ${reused.length} document(s) served more than one run — ${detail}. The later run measured a journal the earlier one wrote, and no interleaving removes that from an absolute number`,
    }
  }
  return { ok: true, documentIds: [...byDocument.keys()], reused: [], reason: null }
}

/** Did the fleet actually share ONE campaign?
 *
 * If each PROCESS minted its own `RUN_ID`, a peer in worker 0 would discard
 * every marker from worker 1 as belonging to another run: 100 peers on 10
 * workers would measure ten benches of 10 peers while the header said 100, with
 * nothing failing. So the run id is asserted to be one value across the fleet.
 */
export function evaluateFleetRunScope(reports, expectedRunId) {
  const seen = new Set()
  const missing = []
  ;(reports ?? []).forEach((report, index) => {
    if (typeof report?.runId === 'string' && report.runId.length > 0) seen.add(report.runId)
    else missing.push(report?.workerIndex ?? index)
  })
  if (missing.length > 0) {
    return { ok: false, runIds: [...seen], reason: `VOID: ${missing.length} worker(s) published no campaign id — their samples cannot be attributed to this fleet` }
  }
  if (seen.size !== 1) {
    return { ok: false, runIds: [...seen], reason: `VOID: the fleet ran ${seen.size} campaign ids (${[...seen].join(', ')}) — cross-worker samples are discarded by the run filter, so this is N small benches, not one` }
  }
  const [only] = [...seen]
  if (expectedRunId && only !== expectedRunId) {
    return { ok: false, runIds: [only], reason: `VOID: workers ran campaign ${only} but the coordinator minted ${expectedRunId}` }
  }
  return { ok: true, runIds: [only], reason: null }
}
