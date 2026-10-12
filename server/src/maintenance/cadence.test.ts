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

import { describe, expect, it } from 'vitest'
import { selectDueWorkspaces, stalenessOf, type CadenceCandidate } from './cadence.js'

/**
 * Near-uniform cadence, slight tilt, hard staleness ceiling (see cadence.ts for
 * why the cadence is never proportional to activity).
 *
 * THE KEY PROPERTY holds over a WINDOW, not over one call: no
 * workspace exceeds the ceiling, on a window where hot and cold workspaces
 * coexist. So the central test is a simulation, not an assertion about a single
 * selection.
 */
describe('maintenance cadence', () => {
  const HOUR = 3_600_000
  const at = (iso: string) => new Date(iso)

  it('is UNIFORM by default — activity does not make anything due', () => {
    // The core rule. A busy workspace checked five minutes ago
    // is NOT due; a quiet one checked two hours ago is. Proportional cadence
    // would invert exactly this.
    const now = at('2026-01-01T12:00:00Z')
    const due = selectDueWorkspaces([
      { landscapeId: 'hot', versionId: 'v1', lastObservedAt: at('2026-01-01T11:55:00Z'), activity: 1 },
      { landscapeId: 'cold', versionId: 'v1', lastObservedAt: at('2026-01-01T10:00:00Z'), activity: 0 },
    ], { intervalMs: HOUR, maxStalenessMs: 6 * HOUR, now })

    expect(due.map((entry) => entry.landscapeId)).toEqual(['cold'])
  })

  it('a never-observed workspace is maximally stale', () => {
    // `Infinity`, not a large sentinel: a fresh install must sort ahead of every
    // checked workspace and must always exceed any finite ceiling.
    expect(stalenessOf({ landscapeId: 'x', versionId: 'v', lastObservedAt: null }, new Date()))
      .toBe(Number.POSITIVE_INFINITY)
    const due = selectDueWorkspaces([
      { landscapeId: 'seen', versionId: 'v1', lastObservedAt: at('2026-01-01T06:00:00Z'), activity: 1 },
      { landscapeId: 'never', versionId: 'v1', lastObservedAt: null, activity: 0 },
    ], { intervalMs: HOUR, maxStalenessMs: 6 * HOUR, now: at('2026-01-01T12:00:00Z') })

    expect(due[0]!.landscapeId).toBe('never')
    expect(due[0]!.overCeiling).toBe(true)
  })

  it('the tilt ORDERS already-due work, and can actually reorder', () => {
    // Two workspaces due by a similar margin; the busier goes first. Guards the
    // interval scaling: an unscaled `tilt` (≤ 1) added to a staleness in
    // MILLISECONDS would be smaller than a rounding error.
    const now = at('2026-01-01T12:00:00Z')
    const due = selectDueWorkspaces([
      { landscapeId: 'quiet', versionId: 'v1', lastObservedAt: at('2026-01-01T10:50:00Z'), activity: 0 },
      { landscapeId: 'busy', versionId: 'v1', lastObservedAt: at('2026-01-01T10:45:00Z'), activity: 1 },
    ], { intervalMs: HOUR, maxStalenessMs: 6 * HOUR, tilt: 0.25, now })

    // `busy` is older anyway here, so make the discriminating case explicit:
    // equal-ish ages, opposite activity.
    const tie = selectDueWorkspaces([
      { landscapeId: 'quiet', versionId: 'v1', lastObservedAt: at('2026-01-01T10:44:00Z'), activity: 0 },
      { landscapeId: 'busy', versionId: 'v1', lastObservedAt: at('2026-01-01T10:45:00Z'), activity: 1 },
    ], { intervalMs: HOUR, maxStalenessMs: 6 * HOUR, tilt: 0.25, now })

    expect(due[0]!.landscapeId).toBe('busy')
    // `quiet` is one minute older, but `busy` gains a quarter of an hour of
    // apparent age — so the tilt wins here, which is what makes it a tilt.
    expect(tie[0]!.landscapeId, 'the tilt has no effect — it cannot reorder anything').toBe('busy')
  })

  it('the tilt can NEVER outrun a full interval of real age', () => {
    // The bound that keeps this from becoming proportional cadence. With
    // `tilt: 1` — the maximum — a maximally busy workspace gains one interval of
    // apparent age, so a workspace older by MORE than that still goes first.
    const now = at('2026-01-01T12:00:00Z')
    const due = selectDueWorkspaces([
      { landscapeId: 'older', versionId: 'v1', lastObservedAt: at('2026-01-01T09:30:00Z'), activity: 0 },
      { landscapeId: 'busiest', versionId: 'v1', lastObservedAt: at('2026-01-01T11:00:00Z'), activity: 1 },
    ], { intervalMs: HOUR, maxStalenessMs: 12 * HOUR, tilt: 1, now })

    expect(due[0]!.landscapeId, 'activity displaced a workspace older by more than one interval')
      .toBe('older')
  })

  it('the CEILING pre-empts everything, however busy the rest are', () => {
    const now = at('2026-01-01T12:00:00Z')
    const due = selectDueWorkspaces([
      { landscapeId: 'busy', versionId: 'v1', lastObservedAt: at('2026-01-01T10:00:00Z'), activity: 1 },
      { landscapeId: 'stale', versionId: 'v1', lastObservedAt: at('2026-01-01T05:00:00Z'), activity: 0 },
    ], { intervalMs: HOUR, maxStalenessMs: 6 * HOUR, tilt: 1, now })

    expect(due[0]!.landscapeId).toBe('stale')
    expect(due[0]!.overCeiling).toBe(true)
    expect(due[1]!.overCeiling).toBe(false)
  })

  it('refuses a ceiling below the interval', () => {
    // Every workspace would be permanently over the ceiling, which reads as the
    // ceiling firing constantly rather than as a misconfiguration.
    expect(() => selectDueWorkspaces([], { intervalMs: 2 * HOUR, maxStalenessMs: HOUR }))
      .toThrow('permanently over the ceiling')
    expect(() => selectDueWorkspaces([], { intervalMs: HOUR, maxStalenessMs: 6 * HOUR, tilt: 2 }))
      .toThrow('within [0, 1]')
  })

  it('NO WORKSPACE EXCEEDS THE CEILING over a window where hot and cold coexist', () => {
    // THE KEY PROPERTY, as a simulation rather than an assertion about one
    // call. Twenty workspaces, half of them constantly active, a bounded batch
    // per tick — exactly the situation where a proportional cadence starves the
    // quiet ones. The ceiling has to hold for every workspace on every tick.
    const HOT = 10
    const TOTAL = 20
    const BATCH = 3
    const TICK_MS = 15 * 60_000
    const INTERVAL = 4 * HOUR
    const CEILING = 8 * HOUR

    const state: CadenceCandidate[] = Array.from({ length: TOTAL }, (_unused, index) => ({
      landscapeId: `ws-${index}`,
      versionId: 'v1',
      // Everything starts never-observed: the worst case, and the one a fresh
      // deployment actually has.
      lastObservedAt: null,
      activity: index < HOT ? 1 : 0,
    }))

    let now = at('2026-01-01T00:00:00Z')
    let worstStaleness = 0
    let worstAfterWarmup = 0
    const WARMUP_MS = CEILING

    // Four days of ticks.
    for (let tick = 0; tick < (4 * 24 * 60 * 60_000) / TICK_MS; tick += 1) {
      const due = selectDueWorkspaces(state, {
        intervalMs: INTERVAL, maxStalenessMs: CEILING, tilt: 0.25, now,
      })
      for (const entry of due.slice(0, BATCH)) {
        const target = state.find((w) => w.landscapeId === entry.landscapeId)!
        target.lastObservedAt = now
      }

      now = new Date(now.getTime() + TICK_MS)
      for (const workspace of state) {
        const staleness = stalenessOf(workspace, now)
        if (!Number.isFinite(staleness)) continue
        worstStaleness = Math.max(worstStaleness, staleness)
        // The initial pass has to reach every workspace once before any bound
        // can hold; measured separately rather than excused by a fudge factor.
        if (now.getTime() - at('2026-01-01T00:00:00Z').getTime() > WARMUP_MS) {
          worstAfterWarmup = Math.max(worstAfterWarmup, staleness)
        }
      }
    }

    // Every workspace was reached at least once — without this the bound below
    // could hold vacuously by never having observed anybody.
    expect(state.every((w) => w.lastObservedAt !== null), 'a workspace was never checked at all')
      .toBe(true)
    expect(
      worstAfterWarmup,
      `a workspace reached ${Math.round(worstAfterWarmup / 60_000)} min of staleness, over the `
      + `${CEILING / 60_000} min ceiling — the hot workspaces starved the cold ones`,
    ).toBeLessThanOrEqual(CEILING)
    // And the hot ones did not simply take everything: the cold half is visited
    // on the same near-uniform footing.
    const coldWorst = Math.max(...state.slice(HOT).map((w) => now.getTime() - w.lastObservedAt!.getTime()))
    expect(coldWorst).toBeLessThanOrEqual(CEILING)
  })

  it('a PROPORTIONAL cadence breaks the same window — the control for D14', () => {
    // The measurement that makes the rule worth having, run as the same
    // simulation with selection by activity instead of by staleness. Without
    // this arm, "uniform is better" would be a claim never exercised here.
    const HOT = 10
    const TOTAL = 20
    const BATCH = 3
    const TICK_MS = 15 * 60_000
    // No ceiling here on purpose: this control arm exists to show the
    // PROPORTIONAL policy starving cold workspaces, and a ceiling would pre-empt
    // exactly the starvation it is trying to demonstrate.

    const state = Array.from({ length: TOTAL }, (_unused, index) => ({
      landscapeId: `ws-${index}`,
      lastObservedAt: null as Date | null,
      activity: index < HOT ? 1 : 0,
    }))

    let now = at('2026-01-01T00:00:00Z')
    for (let tick = 0; tick < (4 * 24 * 60 * 60_000) / TICK_MS; tick += 1) {
      // PROPORTIONAL: pick the busiest, ties by staleness — the forbidden policy.
      const ranked = [...state].sort((a, b) =>
        (b.activity - a.activity)
        || ((b.lastObservedAt?.getTime() ?? 0) - (a.lastObservedAt?.getTime() ?? 0)))
      for (const entry of ranked.slice(0, BATCH)) entry.lastObservedAt = now
      now = new Date(now.getTime() + TICK_MS)
    }

    const coldStarved = state.slice(HOT).filter((w) => w.lastObservedAt === null)
    expect(
      coldStarved.length,
      'the proportional policy did NOT starve the cold workspaces — this control proves nothing',
    ).toBeGreaterThan(0)
  })
})
