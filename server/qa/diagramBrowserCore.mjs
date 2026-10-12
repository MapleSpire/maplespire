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

// The BROWSER arm of the diagram peer-load bench, as pure rules.
//
// The arm is HYBRID by design: 100 Chromium contexts do not fit on one machine,
// and they are the noisiest instrument in the repository, yet the goal is 100
// peers on one document with real browsers reporting felt cost.
//
// So the browsers do not GENERATE the regime, they OBSERVE it: N Node peers plus
// K browser contexts, on the SAME document, at the SAME instant, with
// N + K = the requested peer count. `evaluateHybridCampaign` is where that
// accounting is enforced, so it cannot drift into a claim of "100 browsers".
//
// What a browser measures that a Node peer cannot: store fill, canvas re-render,
// long tasks — the FELT cost. What it cannot measure: scale. Keeping the two
// arms separate in the report keeps client cost and server cost apart, and stops
// a saturated client and a saturated server from producing the same number.

/** Exact quantiles over a small sample. The browser arm produces hundreds of
 *  frames, not hundreds of thousands, so there is nothing to bucket. */
export function summarizeObserverFrames(values) {
  const sorted = (values ?? []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return { count: 0, p50: null, p95: null, p99: null, min: null, max: null, mean: null }
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(3)),
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
  }
}

/** The EXTERNAL witness, and the reason it exists.
 *
 * An in-page probe cannot observe itself being blocked. A wedged tab records
 * nothing, and "no long task recorded" reads exactly like "no long task", so the
 * healthiest possible report and the total failure of the instrument are the
 * same bytes. The Node harness therefore beats a heartbeat with the page and
 * keeps the GAPS; a gap wider than the budget that no `longtask` entry explains
 * means the CAPTURE failed, and that is VOID, never PASS.
 *
 * A gap that a long task DOES explain is a measurement: the page was busy, and
 * the entry says for how long.
 */
export function evaluateLivenessWitness(gaps, longTasks, { budgetMs = 250 } = {}) {
  if (!Array.isArray(gaps)) {
    return { ok: false, unexplainedGaps: [], reason: 'VOID: the external liveness witness never beat, so a blocked page is indistinguishable from a quiet one' }
  }
  const tasks = (longTasks ?? []).filter((task) => Number.isFinite(task?.startMs) && Number.isFinite(task?.durationMs))
  const unexplainedGaps = gaps.filter((gap) => {
    if (!Number.isFinite(gap?.durationMs) || gap.durationMs <= budgetMs) return false
    // "Explained" is deliberately generous — any long task overlapping the gap
    // will do. The claim being tested is that the capture was ALIVE, not that it
    // accounted for every millisecond.
    return !tasks.some((task) => task.startMs + task.durationMs >= gap.startMs && task.startMs <= gap.endMs)
  })
  if (unexplainedGaps.length > 0) {
    const worst = Math.max(...unexplainedGaps.map((gap) => gap.durationMs))
    return {
      ok: false,
      unexplainedGaps,
      reason: `VOID: the page went unreachable for ${worst.toFixed(0)} ms (${unexplainedGaps.length} gap(s) over ${budgetMs} ms) with no long task to account for it — the in-page capture was blocked, so its silence is not evidence of a quiet main thread`,
    }
  }
  return { ok: true, unexplainedGaps: [], reason: null }
}

/** Did this observer actually observe? Every clause is a way of producing an
 *  empty report that reads like a healthy one. */
export function evaluateObserverCapture(observer, { livenessBudgetMs = 250 } = {}) {
  const voids = []
  const index = observer?.index ?? '?'
  if (!observer) {
    return { ok: false, index, voids: [`VOID: observer ${index} produced no report at all`], liveness: null }
  }
  if (observer.connected === false || !(observer.inboundFrames > 0)) {
    voids.push(`VOID: observer ${index} never joined the document — no inbound sync frame arrived, so it observed a campaign it was not in`)
  }
  if (observer.longTaskCaptureEnabled === false) {
    voids.push(`VOID: observer ${index} ran with the long-task capture OFF — the felt cost the browser arm exists to measure was not recorded`)
  }
  if (Number.isFinite(observer.navigations) && observer.navigations > 1) {
    // An HMR reload mid-window resets the store, the canvas and every
    // in-page counter. Anything measured across it belongs to two runs.
    voids.push(`VOID: observer ${index} navigated ${observer.navigations} times inside the window — a reload mid-campaign invalidates every in-page number it reported`)
  }
  const liveness = evaluateLivenessWitness(observer.heartbeatGaps, observer.longTasks, { budgetMs: livenessBudgetMs })
  if (!liveness.ok) voids.push(`observer ${index}: ${liveness.reason}`)
  return { ok: voids.length === 0, index, voids, liveness }
}

/** The three legs, kept apart.
 *
 * emission ──[A] emitter client──> wire ──[B] server──> wire ──[C] receiver client──> observed
 *
 * The report distinguishes client cost from server cost because a saturated
 * Node peer and a saturated server produce the SAME end-to-end number. So the
 * two are never summed and never
 * folded — `attribution` says so in the report itself, for the reader who only
 * reads the JSON.
 */
export function splitCostLegs({ emitMs = null, serverEventLoopMs = null, serverSyncCpuMs = null, observerReceiveMs = null, observerLongTaskMs = null } = {}) {
  return {
    client: {
      // [A] time the emitting peer spent inside `handle.change` — encode plus
      // local apply, before a byte reaches the socket.
      emitMs,
      // [C] time the RECEIVING client spent on the main thread between a sync
      // frame arriving and the task that processed it yielding.
      receiveMs: observerReceiveMs,
      longTaskMs: observerLongTaskMs,
    },
    server: {
      // [B] the single-threaded server's own loop over the same window, plus
      // what it spent generating and receiving sync messages.
      eventLoopMs: serverEventLoopMs,
      receiveTotalMs: serverSyncCpuMs?.receiveTotalMs ?? null,
      generateTotalMs: serverSyncCpuMs?.generateTotalMs ?? null,
      receiveCount: serverSyncCpuMs?.receiveCount ?? null,
      generateCount: serverSyncCpuMs?.generateCount ?? null,
    },
    serverCaptured: Boolean(serverEventLoopMs),
    attribution: 'client and server costs are reported separately and are NOT summed',
  }
}

/** The arm as a whole. `requestedObservers` is what makes "K browsers started,
 *  K-1 observed" a void rather than a smaller sample. */
export function evaluateBrowserArm(observers, { requestedObservers = 0, livenessBudgetMs = 250 } = {}) {
  const list = observers ?? []
  const voids = []
  const perObserver = list.map((observer) => evaluateObserverCapture(observer, { livenessBudgetMs }))
  for (const verdict of perObserver) voids.push(...verdict.voids)
  if (requestedObservers > 0 && list.length !== requestedObservers) {
    voids.push(`VOID: ${list.length}/${requestedObservers} browser observers reported — the browser arm did not run at the width it claims`)
  }
  const observed = perObserver.filter((verdict) => verdict.ok).length
  return {
    outcome: voids.length > 0 ? 'void' : 'passed',
    observers: list.length,
    observing: observed,
    requestedObservers,
    perObserver,
    voids,
    failures: [],
  }
}

/** The hybrid accounting: N Node peers + K browsers, one document, one instant.
 *
 * `peersOnDocument` is the number the capacity certificate cares about,
 * and it counts the browsers — they hold the document and receive the fan-out,
 * which is what the fan-out cost is a function of. `loadGeneratingPeers` is the
 * number that describes the OFFERED load, and it does not, because a browser
 * observer emits nothing. Publishing one without the other is how a bench ends
 * up claiming a regime it never ran.
 */
export function evaluateHybridCampaign({
  nodePeers = 0,
  observers = [],
  requestedPeersOnDocument = 0,
  requestedObservers = 0,
  livenessBudgetMs = 250,
} = {}) {
  const arm = evaluateBrowserArm(observers, { requestedObservers, livenessBudgetMs })
  const peersOnDocument = nodePeers + observers.length
  const voids = [...arm.voids]
  if (requestedPeersOnDocument > 0 && peersOnDocument !== requestedPeersOnDocument) {
    voids.push(`VOID: ${peersOnDocument}/${requestedPeersOnDocument} peers held the document (${nodePeers} Node + ${observers.length} browser) — the requested regime was never offered`)
  }
  return {
    outcome: voids.length > 0 ? 'void' : 'passed',
    peersOnDocument,
    loadGeneratingPeers: nodePeers,
    browserObservers: observers.length,
    requestedPeersOnDocument,
    browserArm: arm,
    voids,
    failures: [],
    // Written into the report so the hybrid accounting travels with the
    // number rather than living in a design document nobody re-reads.
    shape: 'hybrid: the browsers OBSERVE the regime, the Node peers GENERATE it',
  }
}
