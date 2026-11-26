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
 * T-VANISH: the window a compaction's fold opens in `ProjectorFleet`
 * (`release(key, 'compaction')` → `endCompactionWindow`), and what each
 * caller of `ensure` does with its refusal. DB-free: the fleet's build is a
 * double (`startProjector`), so what is counted is which starts RAN.
 * The end-to-end consequences (rows deleted under a base shard that holds
 * them) are in `vanishedObjects.integration.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import {
  ProjectorCompactionInProgressError,
  ProjectorFleet,
  ProjectorOwnershipError,
  type startReadModelProjector,
} from './projectorService.js'
import { COMPACTION_WINDOW_RETRY_MS, LiveWorkspaceResidency } from './liveWorkspaceResidency.js'
import { classifyWarmupFailure, createWarmupOutcomeLog, isWarmupReasonRetryable } from './warmupOutcome.js'

const WS = { landscapeId: 'L', versionId: 'V' }
/** Answers the static check `false`; nothing else is asked of it. */
const db = { query: async () => ({ rows: [], rowCount: 0 }) } as never

type StartDouble = ReturnType<typeof vi.fn>

/** A build double; `hold()` makes the NEXT build wait until released. */
function builds() {
  let held: Promise<void> | null = null
  const startProjector = vi.fn(async () => {
    const wait = held
    held = null
    if (wait) await wait
    return vi.fn()
  }) as StartDouble
  return {
    startProjector,
    hold: () => {
      let release!: () => void
      held = new Promise<void>((resolve) => { release = resolve })
      return release
    },
  }
}

function fleetWith(startProjector: StartDouble, extra: { compactionWindowMaxMs?: number; now?: () => number } = {}) {
  return new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
    fallbackRootUrl: 'automerge:fallback',
    db,
    maxProjectors: 8,
    startProjector: startProjector as unknown as typeof startReadModelProjector,
    ...extra,
  })
}

describe('ProjectorFleet — the compaction window (T-VANISH)', () => {
  it('refuses every start but the compaction\'s own { adopt: false } while the fold\'s window is open, and admits them again once it closes', async () => {
    const { startProjector } = builds()
    const fleet = fleetWith(startProjector)
    try {
      expect(await fleet.ensure(WS)).toBe(true)
      expect(startProjector).toHaveBeenCalledTimes(1)
      fleet.release(WS, 'compaction')
      expect(fleet.isCompactionWindowOpen(WS)).toBe(true)
      // The read route's and the live residency's plain ensure, both modes.
      await expect(fleet.ensure(WS)).rejects.toBeInstanceOf(ProjectorCompactionInProgressError)
      await expect(fleet.ensure(WS, { until: 'attached' })).rejects.toBeInstanceOf(ProjectorCompactionInProgressError)
      expect(startProjector).toHaveBeenCalledTimes(1)
      expect(fleet.compactionWindowRefusalCount()).toBe(2)
      expect(fleet.isResident(WS)).toBe(false)
      // The compaction's own re-attach builds.
      expect(await fleet.ensure(WS, { adopt: false })).toBe(true)
      expect(startProjector).toHaveBeenCalledTimes(2)
      expect(fleet.isResident(WS)).toBe(true)
      fleet.endCompactionWindow(WS)
      expect(fleet.isCompactionWindowOpen(WS)).toBe(false)
      // Closed: a plain start runs again (after a release that opens no window).
      fleet.release(WS, 'released')
      expect(await fleet.ensure(WS)).toBe(true)
      expect(startProjector).toHaveBeenCalledTimes(3)
    } finally {
      fleet.stopAll()
    }
  })

  it('the instance refresh (compaction-instance-refresh) rewrites no document and opens no window', async () => {
    const { startProjector } = builds()
    const fleet = fleetWith(startProjector)
    try {
      expect(await fleet.ensure(WS)).toBe(true)
      fleet.release(WS, 'compaction-instance-refresh')
      expect(fleet.isCompactionWindowOpen(WS)).toBe(false)
      expect(await fleet.ensure(WS)).toBe(true)
    } finally {
      fleet.stopAll()
    }
  })

  it('the compaction\'s re-attach never JOINS a start begun before its window: it waits for it to settle and builds its own', async () => {
    const { startProjector, hold } = builds()
    const fleet = fleetWith(startProjector)
    try {
      const release = hold()
      // A read's start, in flight when the compaction detaches — it read the
      // documents before the fold.
      const before = fleet.ensure(WS).catch((error: unknown) => error)
      await vi.waitFor(() => expect(startProjector).toHaveBeenCalledTimes(1))
      fleet.release(WS, 'compaction')
      let settled = false
      const reattach = fleet.ensure(WS, { adopt: false }).then((value) => { settled = true; return value })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled, 'the re-attach must not answer before the earlier start has settled').toBe(false)
      release()
      // The earlier start is of a released generation: it never becomes resident.
      expect(await before).toBeInstanceOf(ProjectorOwnershipError)
      expect(await reattach).toBe(true)
      expect(startProjector, 'the re-attach built its own projector after the earlier start').toHaveBeenCalledTimes(2)
      expect(fleet.isResident(WS)).toBe(true)
    } finally {
      fleet.stopAll()
    }
  })

  it('a read during the compaction\'s OWN re-attach joins it (that build reads the compacted documents) instead of being refused', async () => {
    const { startProjector, hold } = builds()
    const fleet = fleetWith(startProjector)
    try {
      expect(await fleet.ensure(WS)).toBe(true)
      fleet.release(WS, 'compaction')
      const release = hold()
      const reattach = fleet.ensure(WS, { adopt: false })
      await vi.waitFor(() => expect(startProjector).toHaveBeenCalledTimes(2))
      const read = fleet.ensure(WS)
      const readAttached = fleet.ensure(WS, { until: 'attached' })
      release()
      expect(await reattach).toBe(true)
      expect(await read).toBe(true)
      expect(await readAttached).toBe(true)
      expect(startProjector, 'the reads joined the re-attach; nothing else built').toHaveBeenCalledTimes(2)
      expect(fleet.compactionWindowRefusalCount()).toBe(0)
    } finally {
      fleet.stopAll()
    }
  })

  it('a window left open past its ceiling (a stalled fold) closes itself with one warning, and starts are admitted again', async () => {
    const { startProjector } = builds()
    let now = 0
    const fleet = fleetWith(startProjector, { compactionWindowMaxMs: 1_000, now: () => now })
    const warned: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { warned.push(String(line)) })
    try {
      expect(await fleet.ensure(WS)).toBe(true)
      fleet.release(WS, 'compaction')
      now = 1_000
      await expect(fleet.ensure(WS)).rejects.toBeInstanceOf(ProjectorCompactionInProgressError)
      now = 1_001
      expect(await fleet.ensure(WS)).toBe(true)
      expect(fleet.isCompactionWindowOpen(WS)).toBe(false)
      const overdue = warned.filter((line) => line.includes('read_model.compaction_window_overdue'))
      expect(overdue).toHaveLength(1)
      expect(JSON.parse(overdue[0]!)).toMatchObject({ workspace: 'L/V', ageMs: 1_001, maxMs: 1_000, refused: 1 })
      // The stalled pass closing it later is a no-op.
      fleet.endCompactionWindow(WS)
      expect(fleet.isResident(WS)).toBe(true)
    } finally {
      warn.mockRestore()
      fleet.stopAll()
    }
  })

  it('the refusal is an EXPECTED, retryable warm-up reason: the read route answers its retryable 503 and logs no stack', () => {
    const error = new ProjectorCompactionInProgressError(WS)
    const verdict = classifyWarmupFailure(error)
    expect(verdict).toEqual({ reason: 'read_model_compaction_in_progress', expected: true })
    expect(isWarmupReasonRetryable(verdict.reason)).toBe(true)
    expect(error.retryable).toBe(true)
    const lines: string[] = []
    const log = createWarmupOutcomeLog({ log: (line) => lines.push(line) })
    expect(log.noteFailed(WS, error).expected).toBe(true)
    expect(log.verdictFor(WS)).toMatchObject({ reason: 'read_model_compaction_in_progress', retryable: true })
  })
})

describe('LiveWorkspaceResidency — a frame inside the compaction window (T-VANISH)', () => {
  it('counts the refusal, does not throttle the next frame, and makes the workspace resident on the first frame after the window', async () => {
    const { startProjector } = builds()
    const fleet = fleetWith(startProjector)
    let now = 1_000
    const logged: unknown[] = []
    const residency = new LiveWorkspaceResidency({
      fleet: () => fleet,
      isExpectedRefusal: (error) => classifyWarmupFailure(error).expected,
      log: (_message, error) => { logged.push(error) },
      now: () => now,
    })
    try {
      fleet.release(WS, 'compaction')
      residency.noteOwnedActivity(WS)
      await residency.pending(WS)
      expect(residency.snapshot()).toMatchObject({ ensuresRequested: 1, refused: 1, failed: 0 })
      // 10 ms later: throttled (no ensure per frame for the whole window)…
      now += 10
      residency.noteOwnedActivity(WS)
      expect(residency.snapshot()).toMatchObject({ ensuresRequested: 1, throttled: 1 })
      // …but COMPACTION_WINDOW_RETRY_MS after the refusal — far inside the
      // 5 s throttle — the next frame asks again.
      now += COMPACTION_WINDOW_RETRY_MS
      residency.noteOwnedActivity(WS)
      await residency.pending(WS)
      expect(residency.snapshot()).toMatchObject({ ensuresRequested: 2, refused: 2, throttled: 1 })
      expect(startProjector).not.toHaveBeenCalled()
      fleet.endCompactionWindow(WS)
      now += COMPACTION_WINDOW_RETRY_MS
      residency.noteOwnedActivity(WS)
      await residency.pending(WS)
      expect(residency.snapshot()).toMatchObject({ ensuresRequested: 3, ensured: 1 })
      expect(fleet.isResident(WS)).toBe(true)
      expect(logged).toEqual([])
    } finally {
      fleet.stopAll()
    }
  })

  it('CONTROL: any other refusal keeps the throttle (the window is the only un-throttled one)', async () => {
    const fleet = fleetWith(builds().startProjector)
    let now = 1_000
    const residency = new LiveWorkspaceResidency({
      fleet: () => ({
        isResident: () => false,
        ensure: async () => { throw new ProjectorOwnershipError() },
        size: () => 0,
        capacity: () => 8,
        touch: () => false,
      }),
      isExpectedRefusal: (error) => classifyWarmupFailure(error).expected,
      now: () => now,
    })
    try {
      residency.noteOwnedActivity(WS)
      await residency.pending(WS)
      now += 10
      residency.noteOwnedActivity(WS)
      expect(residency.snapshot()).toMatchObject({ ensuresRequested: 1, refused: 1, throttled: 1 })
    } finally {
      fleet.stopAll()
    }
  })
})
