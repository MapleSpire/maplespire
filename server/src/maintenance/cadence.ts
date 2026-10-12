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
 * WHICH WORKSPACES ARE DUE.
 *
 * NEAR-UNIFORM cadence with a slight tilt, plus a hard staleness ceiling.
 * NEVER proportional to activity.
 *
 * The counter-intuitive part is the one worth stating, because "check the busy
 * ones more often" is what everybody writes first: revisiting in proportion to
 * change rate is provably WORSE than uniform revisiting (the classic web-crawler
 * freshness result). A workspace that changes constantly is never caught up
 * with no matter how often it is visited, so budget spent there buys almost
 * nothing, while the quiet workspace it was taken from drifts arbitrarily far.
 *
 * THREE RULES, IN PRIORITY ORDER:
 *   1. THE CEILING IS ABSOLUTE. Anything past `maxStalenessMs` is due, before
 *      anything else, whatever the tilt says. This is what makes the guarantee a
 *      guarantee rather than a tendency.
 *   2. UNIFORM BY DEFAULT. Otherwise a workspace is due once `intervalMs` has
 *      passed since it was last observed.
 *   3. TILT ONLY ORDERS, NEVER SELECTS, and is bounded. Among workspaces that
 *      are already due, the busier ones go first — but activity can never make
 *      something due that the clock has not, and can never postpone something the
 *      ceiling has claimed.
 */

export interface CadenceCandidate {
  landscapeId: string
  versionId: string
  /** When this workspace was last checked, or null if it never has been. */
  lastObservedAt: Date | null
  /** Any bounded activity signal. Used ONLY to order work that is already due. */
  activity?: number
}

export interface CadenceOptions {
  /** The near-uniform period: a workspace becomes due this long after its last
   *  observation. */
  intervalMs: number
  /** The HARD ceiling. No workspace may go longer than this unobserved, and
   *  anything past it pre-empts everything else. */
  maxStalenessMs: number
  /** How much activity may reorder already-due work, in [0, 1]. Bounded on
   *  purpose: at 1 it is still only a tiebreak among the due, never a
   *  proportional cadence. */
  tilt?: number
  now?: Date
}

export interface CadenceSelection extends CadenceCandidate {
  stalenessMs: number
  /** True when the ceiling forced this one in, rather than the interval. */
  overCeiling: boolean
}

/**
 * A workspace never checked is maximally stale.
 *
 * `Number.POSITIVE_INFINITY` and not "a very large number": a never-checked
 * workspace must sort ahead of every checked one and must always be over any
 * finite ceiling, and picking a sentinel that a real age could one day exceed is
 * how a fresh install quietly stops being prioritised.
 */
export function stalenessOf(candidate: CadenceCandidate, now: Date): number {
  if (candidate.lastObservedAt === null) return Number.POSITIVE_INFINITY
  return now.getTime() - candidate.lastObservedAt.getTime()
}

export function selectDueWorkspaces(
  candidates: readonly CadenceCandidate[],
  options: CadenceOptions,
): CadenceSelection[] {
  const { intervalMs, maxStalenessMs } = options
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`intervalMs must be a positive number, got ${intervalMs}`)
  }
  if (!Number.isFinite(maxStalenessMs) || maxStalenessMs <= 0) {
    throw new Error(`maxStalenessMs must be a positive number, got ${maxStalenessMs}`)
  }
  // A ceiling below the interval would mean every workspace is permanently over
  // the ceiling — the guarantee would be unmeetable rather than merely tight,
  // and it would look like the ceiling working rather than being misconfigured.
  if (maxStalenessMs < intervalMs) {
    throw new Error(
      `maxStalenessMs (${maxStalenessMs}) is below intervalMs (${intervalMs}): every workspace would be `
      + 'permanently over the ceiling, which reads as the ceiling firing rather than as a misconfiguration',
    )
  }
  const tilt = options.tilt ?? 0.25
  if (!Number.isFinite(tilt) || tilt < 0 || tilt > 1) {
    throw new Error(`tilt must be within [0, 1], got ${tilt} — activity may order due work, never select it`)
  }
  const now = options.now ?? new Date()

  const due: CadenceSelection[] = []
  for (const candidate of candidates) {
    const stalenessMs = stalenessOf(candidate, now)
    if (stalenessMs < intervalMs) continue
    due.push({ ...candidate, stalenessMs, overCeiling: stalenessMs >= maxStalenessMs })
  }

  // THE CEILING PRE-EMPTS. Everything over it comes first, oldest first, and no
  // amount of activity elsewhere can displace it. Only then does the tilt get to
  // reorder the rest.
  const overdue = due.filter((entry) => entry.overCeiling).sort((a, b) => b.stalenessMs - a.stalenessMs)
  const ordinary = due
    .filter((entry) => !entry.overCeiling)
    .sort((a, b) => score(b, tilt, intervalMs) - score(a, tilt, intervalMs))
  return [...overdue, ...ordinary]
}

/**
 * How urgent an already-due workspace is.
 *
 * Staleness normalised to the interval, plus a BOUNDED activity term. The
 * activity term is capped at `tilt`, so with `tilt = 0.25` a maximally busy
 * workspace gains at most a quarter of one interval of apparent age. It can
 * reorder neighbours; it cannot outrun a workspace that is genuinely older by a
 * whole cycle, which is what keeps this a tilt rather than a proportional
 * cadence.
 */
function score(entry: CadenceSelection, tilt: number, intervalMs: number): number {
  const activity = Math.max(0, Math.min(1, entry.activity ?? 0))
  // SCALED BY THE INTERVAL: staleness is in MILLISECONDS, so an unscaled
  // `tilt` (≤ 1) would be smaller than a rounding error and never tilt anything.
  return entry.stalenessMs + tilt * activity * intervalMs
}
