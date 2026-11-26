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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMPACTION_REATTACH_BACKOFF_MS,
  COMPACTION_REATTACH_DELAYS_MS,
  COMPACTION_REATTACH_DORMANT_CHECK_MS,
  COMPACTION_REATTACH_JITTER,
  COMPACTION_REATTACH_MAX_SATURATED_SKIPS,
  COMPACTION_REATTACH_NO_ROOT_LIMIT,
  COMPACTION_REATTACH_NOT_OWNED_EXPIRY_MS,
  COMPACTION_REATTACH_NO_ROOT_PERIOD_MS,
  COMPACTION_REATTACH_REST_FACTOR,
  COMPACTION_REATTACH_REST_MAX_MS,
  COMPACTION_REATTACH_SLOW_LOG_MS,
  CompactionReattachSupervisor,
  compactionReattachMetricSamples,
  type CompactionReattachDeps,
} from './compactionReattach.js'
import { ProjectorOwnershipError, ProjectorStaticWorkspaceError } from './projectorService.js'
import { ColdBuildAdmissionStoppedError } from './coldBuildAdmission.js'
import { StoragePoolExhaustedError } from '../automergeStorageErrors.js'
import type { WorkspaceKey } from './projector.js'

const KEY: WorkspaceKey = { landscapeId: 'l-1', versionId: 'v-1' }
const exhausted = () => new StoragePoolExhaustedError('unfenced-mutation', 'queue-timeout', new Error('waited 2000 ms for one of 4 pool permits'))

type Step = 'throw' | true | false | Error | { holdMs: number; then: 'throw' | true | Error }
const depthViolations: number[] = []

/** A fleet whose `ensure` answers from `script`, one entry per call. */
function harness(script: Step[], over: Partial<CompactionReattachDeps> = {}) {
  /** Residency per workspace, so two workspaces' builds stay distinct. */
  const resident = new Set<string>()
  const keyText = (key: WorkspaceKey) => `${key.landscapeId}/${key.versionId}`
  const calls: Array<{ at: number; options: unknown; key: string }> = []
  const events: Array<Record<string, unknown>> = []
  const traces: Array<Record<string, unknown>> = []
  const lifted: string[] = []
  let exclusiveDepth = 0
  let exclusiveCalls = 0
  // A test's own exclusion (a FIFO, a gate) is WRAPPED, never replaced:
  // the call count and the depth check hold for it too.
  const inner = over.exclusive ?? (<T>(work: () => Promise<T>) => work())
  const deps: CompactionReattachDeps = {
    ...over,
    fleet: over.fleet ?? {
      isResident: (key) => resident.has(keyText(key)),
      ensure: async (key, options) => {
        calls.push({ at: Date.now(), options, key: keyText(key) })
        // Every build runs INSIDE the exclusion. Recorded, and asserted in
        // `afterEach`: an `expect` thrown here would only look like
        // an ordinary failed build to the supervisor.
        if (exclusiveDepth !== 1) depthViolations.push(exclusiveDepth)
        let next = script.shift() ?? 'throw'
        if (typeof next === 'object' && !(next instanceof Error)) {
          await new Promise((resolve) => setTimeout(resolve, (next as { holdMs: number }).holdMs))
          next = (next as { then: 'throw' | true | Error }).then
        }
        if (next === 'throw') throw exhausted()
        if (next instanceof Error) throw next
        if (next) resident.add(keyText(key))
        return next
      },
      liftCompactionDetached: (key) => { lifted.push(key.versionId) },
    },
    owns: over.owns ?? (() => true),
    isShuttingDown: over.isShuttingDown ?? (() => false),
    exclusive: async (work) => {
      exclusiveCalls += 1
      return inner(async () => {
        exclusiveDepth += 1
        try { return await work() } finally { exclusiveDepth -= 1 }
      })
    },
    random: over.random ?? (() => 0.5),
    log: over.log ?? ((event) => { events.push({ ...event, at: Date.now() }) }),
    warn: over.warn ?? ((event) => { events.push({ ...event, at: Date.now() }) }),
    trace: over.trace ?? ((event) => { traces.push(event) }),
  }
  const supervisor = new CompactionReattachSupervisor(deps)
  return {
    supervisor, calls, events, traces, lifted,
    exclusiveCalls: () => exclusiveCalls,
    setResident: (value: boolean) => { if (value) resident.add(keyText(KEY)); else resident.delete(keyText(KEY)) },
    named: (event: string) => events.filter((e) => e.event === event),
  }
}

const sample = (supervisor: CompactionReattachSupervisor, name: string) =>
  compactionReattachMetricSamples(supervisor).find((s) => s.name === name)!.values

describe('CompactionReattachSupervisor (G4-16f, a failed compaction re-attach)', () => {
  beforeEach(() => { vi.useFakeTimers({ now: 0 }); depthViolations.length = 0 })
  afterEach(() => {
    vi.useRealTimers()
    expect(depthViolations, 'a build ran outside the exclusion').toEqual([])
  })

  it('THE SCHEDULE: 1, 2, 5, 10, 30 s, then 60, 120, 300 s (the last repeated) — { adopt: false } every time', async () => {
    expect(COMPACTION_REATTACH_DELAYS_MS).toEqual([1_000, 2_000, 5_000, 10_000, 30_000])
    expect(COMPACTION_REATTACH_BACKOFF_MS).toEqual([60_000, 120_000, 300_000])
    const h = harness(['throw', 'throw', 'throw', 'throw', 'throw', 'throw', 'throw', 'throw', true])
    h.supervisor.noteDetached(KEY, exhausted())
    expect(h.supervisor.isPending(KEY)).toBe(true)
    await vi.advanceTimersByTimeAsync(828_000 + 300_000 + 10)
    expect(h.calls.map((c) => c.at)).toEqual([1_000, 3_000, 8_000, 18_000, 48_000, 108_000, 228_000, 528_000, 828_000])
    expect(h.calls.every((c) => (c.options as { adopt?: boolean }).adopt === false)).toBe(true)
    expect(h.supervisor.isPending(KEY)).toBe(false)
    expect(h.supervisor.snapshot().attempts).toMatchObject({ attached: 1, failed: 8 })
    expect(h.named('read_model.compaction_reattach_recovered')[0]).toMatchObject({ workspace: 'l-1/v-1', by: 'retry', attempts: 8 })
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(h.calls).toHaveLength(9)
  })

  it(`the backoff carries ±${COMPACTION_REATTACH_JITTER * 100} % of jitter; the fast phase none`, async () => {
    for (const [random, gap] of [[0, 48_000], [1, 72_000]] as const) {
      vi.setSystemTime(0)
      const h = harness(['throw', 'throw', 'throw', 'throw', 'throw', 'throw', true], { random: () => random })
      h.supervisor.noteDetached(KEY, exhausted())
      await vi.advanceTimersByTimeAsync(48_000 + gap + 10)
      expect(h.calls.map((c) => c.at)).toEqual([1_000, 3_000, 8_000, 18_000, 48_000, 48_000 + gap])
      h.supervisor.stop()
    }
  })

  it(`THE REST: never sooner than ${COMPACTION_REATTACH_REST_FACTOR} × the last attempt's hold of the slot`, async () => {
    const h = harness([{ holdMs: 10_000, then: 'throw' }, true])
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(11_000)
    // Held 10 s: the 2 s step is due at 13 s, the rest forbids a build until 41 s.
    expect(h.named('read_model.compaction_reattach_failed')[0]).toMatchObject({ nextAttemptMs: 2_000, heldMs: 10_000, buildMs: 10_000 })
    await vi.advanceTimersByTimeAsync(29_000)
    expect(h.calls).toHaveLength(1)
    expect(h.named('read_model.compaction_reattach_resting')[0]).toMatchObject({ waitMs: 28_000 })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(h.calls.map((c) => c.at)).toEqual([1_000, 41_000])
    expect(h.supervisor.snapshot().slotHeldMs).toBe(10_000)
  })

  it('THE REST IS SHARED: a second workspace waits for the first one\'s rest too, so N failing workspaces together hold the slot ≤ 1/(1+k)', async () => {
    const OTHER: WorkspaceKey = { landscapeId: 'l-2', versionId: 'v-2' }
    // A FIFO exclusion, as `createProcessExclusion`.
    let queue: Promise<unknown> = Promise.resolve()
    const h = harness([{ holdMs: 10_000, then: 'throw' }, true, true], {
      exclusive: (work) => {
        const run = queue.then(() => work())
        queue = run.catch(() => undefined)
        return run
      },
    })
    h.supervisor.noteDetached(KEY, exhausted())
    h.supervisor.noteDetached(OTHER, exhausted())
    await vi.advanceTimersByTimeAsync(11_000)
    // l-1 built 1 → 11 s; l-2, queued behind it, must not build before 41 s.
    expect(h.calls.map((c) => c.at)).toEqual([1_000])
    await vi.advanceTimersByTimeAsync(29_900)
    expect(h.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)
    // Both recovered, and nothing built inside the rest.
    expect(h.calls).toHaveLength(3)
    expect(h.calls.slice(1).every((c) => c.at >= 41_000)).toBe(true)
    expect(h.supervisor.isPending(KEY) || h.supervisor.isPending(OTHER)).toBe(false)
    // A postponement is NOT an attempt: one failure in all.
    expect(h.supervisor.snapshot().attempts.failed).toBe(1)
    expect(h.named('read_model.compaction_reattach_failed')).toHaveLength(1)
    // The hold that only found the rest is marked in the trace.
    // On EXACTLY the holds without a build — never on a build's.
    const released = h.traces.filter((t) => t.event === 'compaction_reattach.slot_released')
    expect(released.some((t) => t.resting === true && t.buildMs === undefined)).toBe(true)
    expect(released.filter((t) => t.buildMs !== undefined).every((t) => t.resting === undefined)).toBe(true)
    expect(released.filter((t) => t.buildMs !== undefined)).toHaveLength(3)
    expect(h.named('read_model.compaction_reattach_resting').length).toBeGreaterThanOrEqual(2)
    const held = h.supervisor.snapshot().slotHeldMs
    expect(held / 46_000).toBeLessThanOrEqual(1 / (1 + COMPACTION_REATTACH_REST_FACTOR))
  })

  it('the rest follows a SUCCESSFUL build too: the second workspace still waits 3 × H', async () => {
    const OTHER: WorkspaceKey = { landscapeId: 'l-2', versionId: 'v-2' }
    let queue: Promise<unknown> = Promise.resolve()
    const h = harness([{ holdMs: 10_000, then: true }, true], {
      exclusive: (work) => {
        const run = queue.then(() => work())
        queue = run.catch(() => undefined)
        return run
      },
    })
    h.supervisor.noteDetached(KEY, exhausted())
    h.supervisor.noteDetached(OTHER, exhausted())
    await vi.advanceTimersByTimeAsync(45_000)
    expect(h.calls.map((c) => [c.key, c.at])).toEqual([['l-1/v-1', 1_000], ['l-2/v-2', 41_000]])
  })

  it('a postponement by the rest takes NO slot and keeps the step', async () => {
    const h = harness([{ holdMs: 10_000, then: 'throw' }, 'throw', true])
    h.supervisor.noteDetached(KEY, exhausted())
    // Build 1 → 11 s fails; the 2 s step (13 s) finds the rest until 41 s.
    await vi.advanceTimersByTimeAsync(40_000)
    expect(h.exclusiveCalls(), 'the rest is asked before the slot').toBe(1)
    await vi.advanceTimersByTimeAsync(1_100)
    // Build 2 at 41 s fails at once: the NEXT step is the third (5 s), not the fourth.
    expect(h.named('read_model.compaction_reattach_failed').map((e) => e.nextAttemptMs)).toEqual([2_000, 5_000])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.calls.map((c) => c.at)).toEqual([1_000, 41_000, 46_000])
  })

  it('a SHORT build cannot shorten a longer rest: a 45 s retry build, then a 0 s pass — the rest still ends 135 s after the retry', async () => {
    const OTHER: WorkspaceKey = { landscapeId: 'l-2', versionId: 'v-2' }
    const h = harness([{ holdMs: 45_000, then: 'throw' }, true, true])
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(46_000)
    // The retry released at 46 s: the rest runs to 46 + 135 = 181 s. A pass
    // whose re-attach takes no time settles now.
    h.supervisor.watchReattach(OTHER, 'pass')()
    h.supervisor.noteDetached(OTHER, exhausted())
    await vi.advanceTimersByTimeAsync(134_000)
    expect(h.calls, 'nothing builds inside the 45 s build\'s rest').toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.calls.slice(1).every((c) => c.at >= 181_000)).toBe(true)
    expect(h.calls.length).toBeGreaterThanOrEqual(2)
  })

  it(`the rest is capped at ${COMPACTION_REATTACH_REST_MAX_MS / 60_000} min: after a pass held 20 min, the retry waits 15 min, not 60`, async () => {
    // Pin the cap's value: the test below reads the constant, so a changed cap would pass silently.
    expect(COMPACTION_REATTACH_REST_MAX_MS).toBe(15 * 60_000)
    const h = harness([true])
    const unwatch = h.supervisor.watchReattach(KEY, 'pass')
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    unwatch()
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(COMPACTION_REATTACH_REST_MAX_MS - 10)
    expect(h.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(20)
    expect(h.calls.map((c) => c.at)).toEqual([20 * 60_000 + COMPACTION_REATTACH_REST_MAX_MS])
  })

  it('unwatch is idempotent: a second call does not extend the rest', async () => {
    const h = harness([true])
    const unwatch = h.supervisor.watchReattach(KEY, 'pass')
    await vi.advanceTimersByTimeAsync(10_000)
    unwatch()
    await vi.advanceTimersByTimeAsync(100_000)
    unwatch()
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    // The rest ended at 10 + 30 = 40 s: the first fast step builds at once.
    expect(h.calls.map((c) => c.at)).toEqual([111_000])
  })

  it('the hold IN PROGRESS counts in slot_held_seconds, not only once it ends', async () => {
    const h = harness([{ holdMs: 600_000, then: true }])
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000 + 300_000)
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_reattach_slot_held_seconds_total')).toEqual([{ value: 300 }])
  })

  it('THE ALERTS\' SERIES: detached = 1 with a growing age while it is pending, back to 0 when it attaches; zeros without a supervisor', async () => {
    const h = harness(['throw', true])
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_detached_workspaces')).toEqual([{ value: 0 }])
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_500)
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_detached_workspaces')).toEqual([{ value: 1 }])
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_detached_oldest_seconds')).toEqual([{ value: 1.5 }])
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_reattach_attempts_total')).toContainEqual({ labels: { outcome: 'failed' }, value: 1 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_detached_workspaces')).toEqual([{ value: 0 }])
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_detached_oldest_seconds')).toEqual([{ value: 0 }])
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_reattach_attempts_total')).toContainEqual({ labels: { outcome: 'attached' }, value: 1 })
    expect(compactionReattachMetricSamples(null).flatMap((s) => s.values.map((v) => v.value)).every((v) => v === 0)).toBe(true)
  })

  it('a second failed pass keeps the outage\'s age and schedule (one timer per workspace)', async () => {
    const h = harness(['throw', true])
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(500)
    h.supervisor.noteDetached(KEY, new Error('again'))
    await vi.advanceTimersByTimeAsync(600)
    expect(h.calls.map((c) => c.at)).toEqual([1_000])
    expect(h.supervisor.snapshot().oldestDetachedMs).toBe(1_100)
  })

  it('an attempt WAITS for the exclusion and re-asks under it: a pass that re-attached meanwhile is a recovery, no second build, and the fleet\'s mark is lifted', async () => {
    let release!: () => void
    let queue: Promise<unknown> = new Promise<void>((resolve) => { release = resolve })
    const h = harness([true], {
      exclusive: (work) => {
        const run = queue.then(() => work())
        queue = run.catch(() => undefined)
        return run
      },
    })
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.calls, 'no attempt while the exclusion is held (a compaction pass)').toHaveLength(0)
    h.setResident(true)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls).toHaveLength(0)
    expect(h.supervisor.isPending(KEY)).toBe(false)
    expect(h.named('read_model.compaction_reattach_recovered')[0]).toMatchObject({ by: 'already_resident' })
    expect(h.lifted).toEqual(['v-1'])
    expect(h.supervisor.snapshot().attempts).toMatchObject({ attached: 0, alreadyResident: 1 })
  })

  it('asks OUTSIDE the slot first: an already resident workspace takes no slot', async () => {
    const h = harness([], { slotHeld: () => false })
    h.supervisor.noteDetached(KEY, exhausted())
    h.setResident(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.exclusiveCalls()).toBe(0)
    expect(h.supervisor.isPending(KEY)).toBe(false)
    expect(h.lifted).toEqual(['v-1'])
  })

  it('A RECOVERY BY ANYONE: noteAttached ends the outage at once, lifting the mark only when no pass can be running; ignored while an attempt runs', async () => {
    let slot = false
    const h = harness([{ holdMs: 5_000, then: true }], { slotHeld: () => slot })
    h.supervisor.noteDetached(KEY, exhausted())
    h.supervisor.noteAttached({ landscapeId: 'other', versionId: 'x' })
    expect(h.supervisor.isPending(KEY)).toBe(true)
    slot = true
    h.supervisor.noteAttached(KEY)
    expect(h.supervisor.isPending(KEY)).toBe(false)
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_detached_workspaces')).toEqual([{ value: 0 }])
    expect(h.lifted, 'not lifted while a pass may be rewriting the documents').toEqual([])
    expect(h.supervisor.snapshot().attempts.alreadyResident).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.calls).toHaveLength(0)

    slot = false
    h.supervisor.noteDetached(KEY, exhausted())
    h.supervisor.noteAttached(KEY)
    expect(h.lifted).toEqual(['v-1'])

    // While its own attempt runs, the attempt reports.
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_500)
    h.supervisor.noteAttached(KEY)
    expect(h.supervisor.isPending(KEY), 'the running attempt reports, not noteAttached').toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.named('read_model.compaction_reattach_recovered').at(-1)).toMatchObject({ by: 'retry' })
  })

  it('NOT OWNED is DORMANT, not abandoned: out of the paging gauge, owns() asked without the slot, retried when owned again', async () => {
    let owns = true
    const h = harness(['throw', true], { owns: () => owns })
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    owns = false
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.supervisor.dormantReason(KEY)).toBe('not_owned')
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_detached_workspaces')).toEqual([{ value: 0 }])
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_reattach_dormant')).toContainEqual({ labels: { reason: 'not_owned' }, value: 1 })
    const slotsBefore = h.exclusiveCalls()
    await vi.advanceTimersByTimeAsync(5 * COMPACTION_REATTACH_DORMANT_CHECK_MS)
    expect(h.exclusiveCalls(), 'a dormant check takes no slot').toBe(slotsBefore)
    expect(h.supervisor.snapshot().attempts.abandoned).toBe(0)
    owns = true
    await vi.advanceTimersByTimeAsync(COMPACTION_REATTACH_DORMANT_CHECK_MS)
    expect(h.calls).toHaveLength(2)
    expect(h.supervisor.dormantReason(KEY)).toBeNull()
    expect(h.supervisor.isPending(KEY)).toBe(false)
    expect(h.named('read_model.compaction_reattach_pending').at(-1)).toMatchObject({ reason: 'owned_again' })
  })

  it('NOT OWNED under the slot, or ProjectorOwnershipError from ensure, is dormant too; an ownership acquisition re-arms it at the first fast step', async () => {
    let owns = true
    let calls = 0
    const h = harness([new ProjectorOwnershipError(), true], {
      owns: () => { calls += 1; return owns },
    })
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.supervisor.dormantReason(KEY)).toBe('not_owned')
    h.supervisor.noteOwnershipAcquired(KEY)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.calls).toHaveLength(2)
    expect(h.supervisor.isPending(KEY)).toBe(false)
    expect(calls).toBeGreaterThan(0)

    // Under the slot: owns() turns false between the two questions.
    let asked = 0
    const under = harness([true], { owns: () => { asked += 1; return asked < 2 } })
    under.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(under.calls).toHaveLength(0)
    expect(under.supervisor.dormantReason(KEY)).toBe('not_owned')

    // Handed over as not_owned by the pass: dormant at once, no pending page.
    const handed = harness([])
    handed.supervisor.noteDetached(KEY, new Error('owns() false'), 'not_owned')
    expect(handed.supervisor.dormantReason(KEY)).toBe('not_owned')
    expect(handed.named('read_model.compaction_reattach_pending')).toHaveLength(0)
    // A later pass that owns it and fails again wakes it.
    handed.supervisor.noteDetached(KEY, exhausted(), 'reattach_failed')
    expect(handed.supervisor.isPending(KEY)).toBe(true)
    owns = false
  })

  it(`NO ROOT: ${COMPACTION_REATTACH_NO_ROOT_LIMIT} in a row → dormant no_root (the ticket gauge), retried every ${COMPACTION_REATTACH_NO_ROOT_PERIOD_MS / 60_000} min, recovered when the root comes back`, async () => {
    const h = harness([false, false, false, true])
    h.supervisor.noteDetached(KEY, new Error('the workspace root did not resolve'), 'no_root')
    await vi.advanceTimersByTimeAsync(1_000 + 2_000)
    expect(h.supervisor.dormantReason(KEY)).toBe('no_root')
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_detached_workspaces')).toEqual([{ value: 0 }])
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_reattach_dormant')).toContainEqual({ labels: { reason: 'no_root' }, value: 1 })
    expect(h.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(COMPACTION_REATTACH_NO_ROOT_PERIOD_MS - 10)
    expect(h.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(20)
    expect(h.calls).toHaveLength(3)
    expect(h.supervisor.dormantReason(KEY)).toBe('no_root')
    await vi.advanceTimersByTimeAsync(COMPACTION_REATTACH_NO_ROOT_PERIOD_MS)
    expect(h.calls).toHaveLength(4)
    expect(h.supervisor.isPending(KEY)).toBe(false)
    expect(h.supervisor.dormantReason(KEY)).toBeNull()
  })

  it('a no_root streak is broken by any other failure', async () => {
    const h = harness([false, 'throw', false, false, true])
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 5_000 + 10_000)
    expect(h.calls).toHaveLength(4)
    expect(h.supervisor.dormantReason(KEY)).toBeNull()
    expect(h.supervisor.isPending(KEY)).toBe(true)
  })

  it('STOPS without re-attaching on a promotion to summary, and on every form of shutdown', async () => {
    const promoted = harness([new ProjectorStaticWorkspaceError(KEY)])
    promoted.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(promoted.supervisor.isPending(KEY)).toBe(false)
    expect(promoted.named('read_model.compaction_reattach_abandoned')[0]).toMatchObject({ reason: 'static_workspace' })

    const stopped = harness([new ColdBuildAdmissionStoppedError()])
    stopped.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(stopped.named('read_model.compaction_reattach_abandoned')[0]).toMatchObject({ reason: 'shutting_down' })

    // A generic failure seen while the process stops: abandoned, not retried.
    let down = false
    const failingDuringStop = harness([new Error('connection terminated')], {
      exclusive: async (work) => { try { return await work() } finally { down = true } },
      isShuttingDown: () => down,
    })
    failingDuringStop.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(failingDuringStop.named('read_model.compaction_reattach_abandoned')[0]).toMatchObject({ reason: 'shutting_down' })
    expect(failingDuringStop.supervisor.snapshot().attempts.failed).toBe(0)

    // Shutting down between the check outside the slot and the one under it.
    let asked = 0
    const underSlot = harness([true], { isShuttingDown: () => { asked += 1; return asked > 1 } })
    underSlot.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(underSlot.calls).toHaveLength(0)
    expect(underSlot.named('read_model.compaction_reattach_abandoned')[0]).toMatchObject({ reason: 'shutting_down' })

    // The supervisor stopped while the attempt waited for the slot.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const waiting = harness([true], { exclusive: async (work) => { await gate; return work() } })
    waiting.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    waiting.supervisor.stop()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(waiting.calls, 'no build after stop()').toHaveLength(0)

    // Shutting down before the attempt.
    const before = harness([true], { isShuttingDown: () => true })
    before.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(before.exclusiveCalls()).toBe(0)
    expect(before.named('read_model.compaction_reattach_abandoned')[0]).toMatchObject({ reason: 'shutting_down' })
  })

  it('stop() clears every timer, ignores later hand-overs, and every timer is unref\'d', async () => {
    const refs: boolean[] = []
    const real = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const timer = real(fn, ms)
      queueMicrotask(() => { refs.push(timer.hasRef()) })
      return timer
    }) as typeof setTimeout)
    try {
      const h = harness([])
      h.supervisor.noteDetached(KEY, exhausted())
      const unwatch = h.supervisor.watchReattach(KEY)
      await Promise.resolve()
      expect(refs.length).toBeGreaterThanOrEqual(2)
      expect(refs.every((ref) => ref === false), 'a retry or watchdog timer holds the process open').toBe(true)
      unwatch()
      expect(vi.getTimerCount()).toBe(1)
      h.supervisor.stop()
      expect(vi.getTimerCount()).toBe(0)
      h.supervisor.noteDetached({ landscapeId: 'l-2', versionId: 'v' }, exhausted())
      expect(h.supervisor.isPending({ landscapeId: 'l-2', versionId: 'v' })).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it(`SKIPPED WHILE STORAGE REFUSES: a saturated write gate postpones the attempt without the slot, ${COMPACTION_REATTACH_MAX_SATURATED_SKIPS} times at most in a row`, async () => {
    const h = harness([true], { storageSaturated: () => true })
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 5_000 + 10_000 + 30_000)
    expect(h.exclusiveCalls()).toBe(0)
    expect(h.supervisor.snapshot().attempts.skippedSaturated).toBe(COMPACTION_REATTACH_MAX_SATURATED_SKIPS)
    expect(h.named('read_model.compaction_reattach_skipped')).toHaveLength(COMPACTION_REATTACH_MAX_SATURATED_SKIPS)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.calls, 'then one runs anyway').toHaveLength(1)
    expect(h.supervisor.isPending(KEY)).toBe(false)
  })

  it('TRACES: the slot\'s wait, acquisition and release with heldMs and buildMs; the failed line carries them', async () => {
    const h = harness([{ holdMs: 3_000, then: 'throw' }])
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(4_000)
    expect(h.traces.map((t) => t.event)).toEqual([
      'compaction_reattach.slot_wait', 'compaction_reattach.slot_acquired', 'compaction_reattach.slot_released',
    ])
    expect(h.traces[1]).toMatchObject({ workspace: 'l-1/v-1', waitedMs: 0 })
    expect(h.traces[2]).toMatchObject({ heldMs: 3_000, buildMs: 3_000 })
    expect(h.named('read_model.compaction_reattach_failed')[0]).toMatchObject({ heldMs: 3_000, buildMs: 3_000 })
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_reattach_slot_held_seconds_total')).toEqual([{ value: 3 }])
  })

  it('THE WATCHDOG: a re-attach in flight is a growing gauge, logged once past the slow threshold, 0 once settled — the pass\'s and a retry\'s', async () => {
    const h = harness([{ holdMs: COMPACTION_REATTACH_SLOW_LOG_MS + 5_000, then: true }])
    const unwatch = h.supervisor.watchReattach(KEY, 'pass')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_reattach_running_seconds')).toEqual([{ value: 30 }])
    await vi.advanceTimersByTimeAsync(COMPACTION_REATTACH_SLOW_LOG_MS)
    expect(h.named('read_model.compaction_reattach_slow')).toEqual([
      expect.objectContaining({ workspace: 'l-1/v-1', by: 'pass', runningMs: COMPACTION_REATTACH_SLOW_LOG_MS }),
    ])
    unwatch()
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_reattach_running_seconds')).toEqual([{ value: 0 }])

    // A retry's build, on a supervisor no pass has fed a rest to.
    const r = harness([{ holdMs: COMPACTION_REATTACH_SLOW_LOG_MS + 5_000, then: true }])
    r.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000 + COMPACTION_REATTACH_SLOW_LOG_MS + 1)
    expect(r.named('read_model.compaction_reattach_slow').at(-1)).toMatchObject({ by: 'retry' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sample(r.supervisor, 'maplespire_read_model_compaction_reattach_running_seconds')).toEqual([{ value: 0 }])
  })

  it('THE PASS\'S re-attach feeds the shared rest: after a pass whose build held the slot 45 s, the first retry waits 3 × 45 s', async () => {
    const h = harness([true])
    const unwatch = h.supervisor.watchReattach(KEY, 'pass')
    await vi.advanceTimersByTimeAsync(45_000)
    unwatch()
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(3 * 45_000 - 10)
    expect(h.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(20)
    expect(h.calls.map((c) => c.at)).toEqual([45_000 + 3 * 45_000])
  })

  it('an attempt that throws outside its own try (a broken owns()) is still rescheduled', async () => {
    let asked = 0
    const h = harness([true], { owns: () => { asked += 1; if (asked === 1) throw new Error('owns broke'); return true } })
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.named('read_model.compaction_reattach_failed')[0]).toMatchObject({ error: expect.stringContaining('owns broke') })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.supervisor.isPending(KEY)).toBe(false)
  })

  // ---- The watchdog, dormancy and the acquisition barrier ----------------

  it('THE WATCHDOG settles on FAILURE too: a failed build, and one that throws ProjectorOwnershipError, leave running_seconds at 0', async () => {
    const h = harness([{ holdMs: 30_000, then: 'throw' }, { holdMs: 30_000, then: new ProjectorOwnershipError() }])
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000 + 10_000)
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_reattach_running_seconds')).toEqual([{ value: 10 }])
    await vi.advanceTimersByTimeAsync(20_100)
    expect(h.named('read_model.compaction_reattach_failed')).toHaveLength(1)
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_reattach_running_seconds')).toEqual([{ value: 0 }])
    // The next build starts after the rest (31 s + 3 × 30 s) and throws at 151 s.
    await vi.advanceTimersByTimeAsync(121_000)
    expect(h.calls).toHaveLength(2)
    expect(h.supervisor.dormantReason(KEY)).toBe('not_owned')
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_reattach_running_seconds')).toEqual([{ value: 0 }])
  })

  it('THE WATCHDOG starts once the slot is held: a retry queued behind a long pass is waiting, not building — no running gauge, no slow line', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = harness([true], { exclusive: async (work) => { await gate; return work() } })
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000 + 2 * COMPACTION_REATTACH_SLOW_LOG_MS)
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_reattach_running_seconds')).toEqual([{ value: 0 }])
    expect(h.named('read_model.compaction_reattach_slow')).toHaveLength(0)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.supervisor.isPending(KEY)).toBe(false)
  })

  it('a dormant no_root workspace that FAILS OTHERWISE is an ordinary outage again: active, in the paging gauge, retried from the fast phase', async () => {
    // The pass's no_root is the first of three; two retries make it dormant.
    const h = harness([false, false, 'throw', true])
    h.supervisor.noteDetached(KEY, new Error('no root'), 'no_root')
    await vi.advanceTimersByTimeAsync(1_000 + 2_000)
    expect(h.supervisor.dormantReason(KEY)).toBe('no_root')
    await vi.advanceTimersByTimeAsync(COMPACTION_REATTACH_NO_ROOT_PERIOD_MS + 10)
    expect(h.calls).toHaveLength(3)
    expect(h.supervisor.dormantReason(KEY)).toBeNull()
    expect(h.supervisor.isPending(KEY)).toBe(true)
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_detached_workspaces')).toEqual([{ value: 1 }])
    expect(h.named('read_model.compaction_reattach_failed').at(-1)).toMatchObject({ nextAttemptMs: COMPACTION_REATTACH_DELAYS_MS[0] })
    await vi.advanceTimersByTimeAsync(COMPACTION_REATTACH_DELAYS_MS[0]!)
    expect(h.supervisor.isPending(KEY)).toBe(false)
  })

  it('"at most 5 in a row": the count restarts after an attempt — saturated ×5, a failed build, saturated ×5 again', async () => {
    const h = harness(['throw', true], { storageSaturated: () => true })
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(h.calls).toHaveLength(2)
    expect(h.supervisor.snapshot().attempts.skippedSaturated).toBe(2 * COMPACTION_REATTACH_MAX_SATURATED_SKIPS)
  })

  it('a woken workspace keeps the AGE of its outage, without its not_owned phase: a flapping lease neither restarts nor inflates it', async () => {
    let owns = true
    const h = harness(['throw', 'throw', 'throw'], { owns: () => owns })
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    owns = false
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.supervisor.dormantReason(KEY)).toBe('not_owned')
    owns = true
    await vi.advanceTimersByTimeAsync(COMPACTION_REATTACH_DORMANT_CHECK_MS)
    expect(h.supervisor.isPending(KEY)).toBe(true)
    // Active 0 → 3 s, dormant a minute, active again: 3 s — not 0 (restarted)
    // and not 63 s (the dormant minute counted).
    expect(h.supervisor.snapshot().oldestDetachedMs).toBe(3_000)
  })

  it('A WORKSPACE ANOTHER CELL SERVED FOR 10 H comes back without a page: a 70 s build that succeeds stays under the ticket\'s 300 s', async () => {
    let owns = true
    const h = harness(['throw', { holdMs: 70_000, then: true }], { owns: () => owns })
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    owns = false
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.supervisor.dormantReason(KEY)).toBe('not_owned')
    await vi.advanceTimersByTimeAsync(10 * 3_600_000)
    owns = true
    h.supervisor.noteOwnershipAcquired(KEY)
    // Through the whole build, the age the alerts read stays far below 300 s.
    let maxAge = 0
    for (let t = 0; t < 75; t += 5) {
      await vi.advanceTimersByTimeAsync(5_000)
      maxAge = Math.max(maxAge, h.supervisor.snapshot().oldestDetachedMs)
    }
    expect(h.supervisor.isPending(KEY)).toBe(false)
    expect(maxAge).toBeLessThan(300_000)
    expect(maxAge).toBeGreaterThan(70_000)
  })

  it('a dormant not_owned entry woken by a FAILING PASS drops its dormant time too', async () => {
    let owns = true
    const h = harness(['throw'], { owns: () => owns })
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    owns = false
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.supervisor.dormantReason(KEY)).toBe('not_owned')
    await vi.advanceTimersByTimeAsync(3_600_000 - 30_000)
    owns = true
    h.supervisor.noteDetached(KEY, exhausted(), 'reattach_failed')
    expect(h.supervisor.isPending(KEY)).toBe(true)
    expect(h.supervisor.snapshot().oldestDetachedMs).toBe(3_000)
  })

  it('no_root → not_owned restarts the dormant clock: only the not_owned time is dropped, the no_root time counts', async () => {
    let owns = true
    const h = harness([false, false], { owns: () => owns })
    h.supervisor.noteDetached(KEY, new Error('no root'), 'no_root')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.supervisor.dormantReason(KEY)).toBe('no_root')
    owns = false
    await vi.advanceTimersByTimeAsync(COMPACTION_REATTACH_NO_ROOT_PERIOD_MS)
    expect(h.supervisor.dormantReason(KEY)).toBe('not_owned')
    owns = true
    await vi.advanceTimersByTimeAsync(COMPACTION_REATTACH_DORMANT_CHECK_MS)
    // Active 3 s + no_root 900 s count; the not_owned minute does not.
    expect(h.supervisor.snapshot().oldestDetachedMs).toBe(3_000 + COMPACTION_REATTACH_NO_ROOT_PERIOD_MS)
  })

  it('a dormant no_root phase COUNTS in the age: the read plane was down on this cell all along', async () => {
    const h = harness([false, false, 'throw'])
    h.supervisor.noteDetached(KEY, new Error('no root'), 'no_root')
    await vi.advanceTimersByTimeAsync(3_000 + COMPACTION_REATTACH_NO_ROOT_PERIOD_MS + 10)
    expect(h.supervisor.isPending(KEY)).toBe(true)
    expect(h.supervisor.snapshot().oldestDetachedMs).toBeGreaterThanOrEqual(COMPACTION_REATTACH_NO_ROOT_PERIOD_MS)
  })

  it(`a dormant not_owned workspace is dropped after ${COMPACTION_REATTACH_NOT_OWNED_EXPIRY_MS / 3_600_000} h: it moved for good`, async () => {
    const h = harness([], { owns: () => false })
    h.supervisor.noteDetached(KEY, new Error('owns() false'), 'not_owned')
    await vi.advanceTimersByTimeAsync(COMPACTION_REATTACH_NOT_OWNED_EXPIRY_MS - COMPACTION_REATTACH_DORMANT_CHECK_MS)
    expect(h.supervisor.dormantReason(KEY)).toBe('not_owned')
    await vi.advanceTimersByTimeAsync(2 * COMPACTION_REATTACH_DORMANT_CHECK_MS)
    expect(h.supervisor.dormantReason(KEY)).toBeNull()
    expect(h.named('read_model.compaction_reattach_abandoned')[0]).toMatchObject({ reason: 'not_owned_expired' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('noteDetached wakes a dormant entry for a no_root hand-over too, never while its attempt runs', async () => {
    const asleep = harness([])
    asleep.supervisor.noteDetached(KEY, new Error('x'), 'not_owned')
    asleep.supervisor.noteDetached(KEY, new Error('no root'), 'no_root')
    expect(asleep.supervisor.isPending(KEY)).toBe(true)

    // A dormant no_root entry whose attempt waits for the slot while a pass fails.
    let release!: () => void
    let gate: Promise<void> = Promise.resolve()
    const h = harness([false, false, false, false], { exclusive: async (work) => { await gate; return work() } })
    h.supervisor.noteDetached(KEY, new Error('no root'), 'no_root')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.supervisor.dormantReason(KEY)).toBe('no_root')
    gate = new Promise<void>((resolve) => { release = resolve })
    await vi.advanceTimersByTimeAsync(COMPACTION_REATTACH_NO_ROOT_PERIOD_MS)
    h.supervisor.noteDetached(KEY, exhausted(), 'reattach_failed')
    release()
    await vi.advanceTimersByTimeAsync(0)
    // The running attempt reported (no_root again): still dormant, on its long period.
    expect(h.supervisor.dormantReason(KEY)).toBe('no_root')
  })

  it('THE ACQUISITION BARRIER: owns() is not asked at the acquisition, but at 1 s, 2 s and 5 s after it, then each minute', async () => {
    let owned = false
    const asked: number[] = []
    const h = harness([true], { owns: () => { asked.push(Date.now()); return owned } })
    h.supervisor.noteDetached(KEY, new Error('owns() false'), 'not_owned')
    await vi.advanceTimersByTimeAsync(10_000)
    asked.length = 0
    h.supervisor.noteOwnershipAcquired(KEY)
    // The listener runs before owns() turns true: it does so 1.5 s later.
    setTimeout(() => { owned = true }, 1_500)
    await vi.advanceTimersByTimeAsync(0)
    expect(asked, 'not asked during the acquisition itself').toEqual([])
    await vi.advanceTimersByTimeAsync(3_100)
    expect(asked.slice(0, 2)).toEqual([11_000, 13_000])
    expect(h.calls.map((c) => c.at)).toEqual([13_000])
  })

  it('after an acquisition that does not make owns() true, the checks are EXACTLY 1, 2, 5 s, then each minute, and do not survive a wake', async () => {
    const owned = false
    const asked: number[] = []
    const h = harness(['throw'], { owns: () => { asked.push(Date.now()); return owned } })
    h.supervisor.noteDetached(KEY, new Error('owns() false'), 'not_owned')
    await vi.advanceTimersByTimeAsync(10_000)
    asked.length = 0
    h.supervisor.noteOwnershipAcquired(KEY)
    await vi.advanceTimersByTimeAsync(70_000)
    expect(asked).toEqual([11_000, 13_000, 18_000, 78_000])

    // P10: acquired, owned at once, woken; its build fails, owns() turns
    // false: dormant again, the next checks are each minute, not the
    // leftover 2 s / 5 s.
    const asked2: number[] = []
    let owned2 = false
    const w = harness(['throw'], { owns: () => { asked2.push(Date.now()); return owned2 } })
    w.supervisor.noteDetached(KEY, new Error('owns() false'), 'not_owned')
    await vi.advanceTimersByTimeAsync(10_000)
    owned2 = true
    w.supervisor.noteOwnershipAcquired(KEY)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(w.calls).toHaveLength(1)
    owned2 = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.supervisor.dormantReason(KEY)).toBe('not_owned')
    asked2.length = 0
    await vi.advanceTimersByTimeAsync(130_000)
    expect(asked2.length, `asked at ${asked2.join(', ')}`).toBe(2)
  })

  it(`the ${COMPACTION_REATTACH_NOT_OWNED_EXPIRY_MS / 3_600_000} h expiry counts from ENTERING the dormant state, at exactly the bound`, async () => {
    let owns = true
    const h = harness([], { owns: () => owns })
    h.supervisor.noteDetached(KEY, exhausted())
    // Active, failing, for 2 h.
    await vi.advanceTimersByTimeAsync(2 * 3_600_000)
    owns = false
    await vi.advanceTimersByTimeAsync(400_000)
    const entered = h.named('read_model.compaction_reattach_dormant')[0]!.at as number
    expect(entered).toBeGreaterThan(2 * 3_600_000)
    await vi.advanceTimersByTimeAsync(entered + COMPACTION_REATTACH_NOT_OWNED_EXPIRY_MS - Date.now() - 1_000)
    expect(h.supervisor.dormantReason(KEY), '24 h after entering, not after the first detachment').toBe('not_owned')
    await vi.advanceTimersByTimeAsync(2_000)
    const dropped = h.named('read_model.compaction_reattach_abandoned')[0]
    expect(dropped).toMatchObject({ reason: 'not_owned_expired', at: entered + COMPACTION_REATTACH_NOT_OWNED_EXPIRY_MS })
  })

  it('a wake restarts the fast phase and the no_root streak', async () => {
    let owns = true
    const h = harness(['throw', 'throw', 'throw', 'throw', 'throw', 'throw', 'throw'], { owns: () => owns })
    h.supervisor.noteDetached(KEY, exhausted())
    // Six failures: into the backoff.
    await vi.advanceTimersByTimeAsync(108_000 + 10)
    expect(h.calls).toHaveLength(6)
    owns = false
    await vi.advanceTimersByTimeAsync(130_000)
    expect(h.supervisor.dormantReason(KEY)).toBe('not_owned')
    owns = true
    h.supervisor.noteOwnershipAcquired(KEY)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.named('read_model.compaction_reattach_failed').at(-1)).toMatchObject({ nextAttemptMs: COMPACTION_REATTACH_DELAYS_MS[0] })

    // P6: two no_root, dormant not_owned, woken, one no_root: NOT dormant no_root.
    let owns2 = true
    const n = harness([false, false, false], { owns: () => owns2 })
    n.supervisor.noteDetached(KEY, new Error('no root'), 'no_root')
    await vi.advanceTimersByTimeAsync(1_000)
    owns2 = false
    await vi.advanceTimersByTimeAsync(2_000)
    expect(n.supervisor.dormantReason(KEY)).toBe('not_owned')
    owns2 = true
    n.supervisor.noteOwnershipAcquired(KEY)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(n.calls).toHaveLength(2)
    expect(n.supervisor.dormantReason(KEY), 'one no_root after the wake is not three in a row').toBeNull()
  })

  it('a dormant entry made RESIDENT by another start is recovered at once', async () => {
    const h = harness([false, false, false])
    h.supervisor.noteDetached(KEY, new Error('no root'), 'no_root')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.supervisor.dormantReason(KEY)).toBe('no_root')
    h.supervisor.noteAttached(KEY)
    expect(h.supervisor.dormantReason(KEY)).toBeNull()
    expect(sample(h.supervisor, 'maplespire_read_model_compaction_reattach_dormant')).toContainEqual({ labels: { reason: 'no_root' }, value: 0 })
    expect(h.supervisor.snapshot().attempts.alreadyResident).toBe(1)
  })

  it('a build that FAILED while another start re-attached the workspace is a recovery, not a failure', async () => {
    const h = harness([])
    let resident = false
    const flaky = new CompactionReattachSupervisor({
      fleet: { isResident: () => resident, ensure: async () => { resident = true; throw exhausted() }, liftCompactionDetached: () => undefined },
      owns: () => true, isShuttingDown: () => false, exclusive: (work) => work(),
      log: () => {}, warn: (event) => { h.events.push(event) },
    })
    flaky.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(flaky.isPending(KEY)).toBe(false)
    expect(flaky.snapshot().attempts).toMatchObject({ failed: 0, alreadyResident: 1 })

    // Seen after the slot was given back, possibly to a pass —
    // the mark is lifted only if the slot is free.
    let resident2 = false
    const lifted: string[] = []
    const held = new CompactionReattachSupervisor({
      fleet: {
        isResident: () => resident2, ensure: async () => { resident2 = true; throw exhausted() },
        liftCompactionDetached: (key) => { lifted.push(key.versionId) },
      },
      owns: () => true, isShuttingDown: () => false, exclusive: (work) => work(), slotHeld: () => true,
      log: () => {}, warn: () => {},
    })
    held.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(held.isPending(KEY)).toBe(false)
    expect(lifted, 'a pass may hold the slot now').toEqual([])
  })

  // This pins the lift after ANY recovery by the retry, which
  // is what covers the case of an `ensure` that joined a read's start in
  // flight (the fleet lifts only for the start that passed `{ adopt: false }`);
  // the joining itself is the fleet's memo, not exercised here.
  it('a recovery by the retry lifts the fleet\'s mark itself (a no-op when the fleet already did)', async () => {
    const h = harness(['throw', true])
    h.supervisor.noteDetached(KEY, exhausted())
    await vi.advanceTimersByTimeAsync(1_000 + 2_000)
    expect(h.named('read_model.compaction_reattach_recovered')[0]).toMatchObject({ by: 'retry' })
    expect(h.lifted).toEqual(['v-1'])
  })

  it('ProjectorFleet.liftCompactionDetached is a no-op on a workspace that is not resident: the mark is what keeps its next start off', async () => {
    const { ProjectorFleet } = await import('./projectorService.js')
    const fleet = new ProjectorFleet({} as never, async () => null, { fallbackRootUrl: 'automerge:x', db: {} as never, maxProjectors: 1 })
    fleet.release(KEY, 'compaction')
    expect(fleet.isCompactionDetached(KEY)).toBe(true)
    fleet.liftCompactionDetached(KEY)
    expect(fleet.isCompactionDetached(KEY)).toBe(true)
  })
})
