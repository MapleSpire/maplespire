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
 * "How will we know 2 s stopped being enough?" — the instrument that answers
 * it.
 *
 * ── The alarm must PRECEDE the failure ───────────────────────────────────────
 * A count of failed boots is the wrong instrument: by the time it moves, users
 * have already seen the defect. What is wanted is the MARGIN, and the margin
 * has a name — a waiver that ran into the cap while the boot still succeeded.
 * `clipped` is exactly that reading. It should be 0 on a healthy stack, and
 * **any non-zero value is the signal**, not the incident.
 *
 * ── The three quantities, and why they are three ─────────────────────────────
 *  - `granted`     a rejection arrived with no peer and a handshake in flight,
 *                  so the attempt was not charged. Says the mechanism armed.
 *  - `peerArrived` the peer showed up INSIDE the cap. The healthy outcome, and
 *                  the only one that contributes a handshake-latency sample —
 *                  a clipped wait tells you nothing about the true latency
 *                  except that it exceeded the cap, so folding it into the
 *                  distribution would bias it toward the cap itself.
 *  - `clipped`     the cap ran out first. THE early warning.
 * plus `abandoned` (the transport gave up: no peer was coming after all) and
 * `budgetExhausted` (the whole resolution budget ended the wait, not the cap),
 * kept apart because they are not evidence about the cap at all. Collapsing
 * them into `clipped` would produce a false alarm every time a server goes
 * down, which is precisely when nobody can afford to be reading a false alarm.
 *
 * `clippedRatio` = clipped / granted is the environment-independent health
 * figure. On a slow deployment every absolute latency rises; if the cap is
 * sized correctly the ratio stays at zero regardless.
 *
 * ── Percentiles, not a mean ──────────────────────────────────────────────────
 * The cap is a MAJORANT, so the quantity that matters is the tail. A mean over
 * a bimodal population — and this one is bimodal, since the handshake often
 * lands BEFORE the first `find()` — describes nothing that exists.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 * It never feeds back into the cap. See the prohibition in `waiverBudget.ts`:
 * a cap that adapts to the latency it bounds erases this signal by
 * construction.
 *
 * ── Where it can be read ─────────────────────────────────────────────────────
 * There is NO client→server telemetry channel: nothing in
 * `src/lib/observability` performs a network call. `installClientDiagnostics`
 * only exposes `window.__maplespireDiagnostics` and mirrors a JSON snapshot
 * into the DOM, gated on DEV or `VITE_CLIENT_PERF_DIAGNOSTICS=true`. So these
 * counters are readable from a bench run, an e2e run, or a user's own
 * devtools — and from nowhere else. That is weaker than supervision and must
 * not be mistaken for it.
 */

/** Bounded sample ring. The tail is what matters and 256 samples resolve a p95
 * fine; unbounded retention on a boot path would be an instrument that grows
 * with the thing it measures. */
const SAMPLE_LIMIT = 256

/** Why a waived wait ended. */
export type WaiverOutcome =
  /** A peer connected inside the cap — the healthy path. */
  | 'peer'
  /** The waiver's own cap ran out. THE early warning. */
  | 'clipped'
  /** The transport stopped expecting a peer (socket closed, attempt failed). */
  | 'abandoned'
  /** The whole resolution budget ended the wait before the cap could. */
  | 'budget-exhausted'

export interface WaiverTelemetry {
  granted: number
  peerArrived: number
  clipped: number
  abandoned: number
  budgetExhausted: number
  /** clipped / granted, or null with nothing granted yet. Non-zero = the
   * margin is being consumed, whether or not any boot has failed. */
  clippedRatio: number | null
  /** Delay between the waiver arming and the peer landing, for the waits that
   * ENDED in a peer. Milliseconds. */
  handshakeMs: { count: number; p50: number | null; p95: number | null; max: number | null }
}

let granted = 0
let peerArrived = 0
let clipped = 0
let abandoned = 0
let budgetExhausted = 0
let samples: number[] = []

/** A rejection was waived: the mechanism armed. Counted before the wait, so a
 * wait that never returns is still visible as an unmatched grant. */
export function recordWaiverGranted(): void {
  granted += 1
}

/** A waived wait ended. `waitedMs` is wall time inside the wait. */
export function recordWaiverOutcome(outcome: WaiverOutcome, waitedMs: number): void {
  if (outcome === 'peer') {
    peerArrived += 1
    // ONLY this branch samples the latency: a clipped wait bounds the true
    // delay from below and nothing more, so counting it as an observation
    // would drag the distribution toward the cap and hide the very drift the
    // cap is watched for.
    samples.push(Math.max(0, waitedMs))
    if (samples.length > SAMPLE_LIMIT) samples = samples.slice(-SAMPLE_LIMIT)
    return
  }
  if (outcome === 'clipped') {
    clipped += 1
    // Loud on purpose, and only on the transition that matters. This is the
    // sentence an operator should be able to find in a console before any user
    // reports a failed boot.
    console.warn(
      `[waiverBudget] the peer waiver hit its cap after ${Math.round(waitedMs)}ms`
      + ` (clipped ${clipped}/${granted} waivers). The margin between handshake latency and the cap is`
      + ` being consumed; re-measure with the boot-load rush before boots start failing.`,
    )
    return
  }
  if (outcome === 'abandoned') abandoned += 1
  else budgetExhausted += 1
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

export function readWaiverTelemetry(): WaiverTelemetry {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    granted,
    peerArrived,
    clipped,
    abandoned,
    budgetExhausted,
    clippedRatio: granted === 0 ? null : clipped / granted,
    handshakeMs: {
      count: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted.length === 0 ? null : sorted[sorted.length - 1],
    },
  }
}

export function resetWaiverTelemetry(): void {
  granted = 0
  peerArrived = 0
  clipped = 0
  abandoned = 0
  budgetExhausted = 0
  samples = []
}
