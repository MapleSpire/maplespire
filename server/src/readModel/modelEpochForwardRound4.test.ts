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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessExclusion, type ProcessExclusion } from '../maintenance/processExclusion.js'
import { createForwardTrigger } from './modelEpochForwardTrigger.js'
import { awaitTriggeredForward, TRIGGERED_SWEEP, triggeredSweepOptions, yieldToRefusedRotation } from './modelEpochForwardWiring.js'
import { sweepModelEpochs } from './modelEpochSweep.js'

/** G4-16f: the event-driven forward's wiring decisions, each tested where
 * `index.ts` cannot be. */
const W = { landscapeId: 'L', versionId: 'V' }

/** Just enough database for the sweep's first probe: it has epoch rows. */
const probeDb = { query: async (sql: string) => ({ rows: [sql.includes('to_regclass') ? { present: true } : { any: true }] }) } as never
const sweepDeps = (exclusion: ProcessExclusion, extra: Record<string, unknown> = {}) => ({
  repo: {} as never, db: probeDb, connect: async (): Promise<never> => { throw new Error('not reached') },
  residentProjectorInstanceId: () => 'resident', owns: () => true, isShuttingDown: () => false,
  instanceId: 'cell', retire: { retain: 3, periodDays: 30 }, exclusion, ...extra,
})

describe('triggeredSweepOptions — what each urgency DOES against a compaction holding the pool-heavy slot', () => {
  afterEach(() => { vi.useRealTimers() })
  /** The REAL triggered sweep of this urgency (`sweepModelEpochs` with the
   * options spread as `index.ts` does), asked while a compaction holds the
   * slot `holdMs`: when it got the slot and when it answered, in ms after it
   * asked (granted null: refused). It stops right under the slot (the
   * projector is gone by then), so no database work is needed. */
  async function against(urgency: { priority?: boolean; reset?: boolean }, holdMs: number) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const exclusion = createProcessExclusion()
    const compaction = exclusion.run(() => new Promise<void>((resolve) => { setTimeout(resolve, holdMs) }))
    const askedAt = Date.now()
    let granted: number | null = null
    let answered: number | null = null
    const swept = sweepModelEpochs(W, sweepDeps(exclusion, {
      ...triggeredSweepOptions(urgency),
      residentProjectorInstanceId: () => (granted === null ? 'resident' : null),
      onAcquired: () => { granted = Date.now() - askedAt },
    })).then((outcome) => { answered = Date.now() - askedAt; return outcome })
    await vi.advanceTimersByTimeAsync(holdMs + 60_000)
    const outcome = await swept
    await compaction
    return { granted, answered: answered as number | null, outcome }
  }

  it('S9 waits out an F1-long compaction (4.8 s) and gets the slot at its release', async () => {
    const s9 = await against({ reset: true }, 4_800)
    expect(s9.granted).toBe(4_800)
    expect(s9.outcome).toEqual({ outcome: 'not_resident' })
  })

  it('a latch is refused by the same compaction INSIDE the route\'s 1.5 s wait, and gets a slot released within ~1 s', async () => {
    const refused = await against({ priority: true }, 4_800)
    expect(refused.granted).toBeNull()
    expect(refused.outcome).toMatchObject({ outcome: 'busy' })
    expect(refused.answered).toBeLessThan(1_500)
    expect((await against({ priority: true }, 900)).granted).toBe(900)
  })

  it('an ordinary pass only tries: refused at once by any hold', async () => {
    const ordinary = await against({}, 100)
    expect(ordinary.granted).toBeNull()
    expect(ordinary.answered).toBe(0)
    expect(triggeredSweepOptions()).toEqual({ ...TRIGGERED_SWEEP, maintenance: false })
  })

  it('D2: a REQUESTED pass (ordinary or latch) skips the maintenance; S9 keeps it', () => {
    expect(triggeredSweepOptions({}).maintenance).toBe(false)
    expect(triggeredSweepOptions({ priority: true }).maintenance).toBe(false)
    expect(triggeredSweepOptions({ reset: true }).maintenance).toBeUndefined()
  })
})

describe('sweepModelEpochs under the slot ("write fence lost")', () => {
  it('a sweep that WAITED behind a compaction reads the projector UNDER the slot — the one it saw before the wait is gone', async () => {
    const exclusion = createProcessExclusion()
    let resident: string | null = 'before-compaction'
    let release!: () => void
    const compaction = exclusion.run(() => new Promise<void>((resolve) => { release = resolve }))
    const swept = sweepModelEpochs(W, sweepDeps(exclusion, { exclusionWaitMs: 30_000, residentProjectorInstanceId: () => resident }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(exclusion.waiting()).toBe(1)
    resident = null // the compaction detached the projector (and has not re-attached it yet)
    release()
    await compaction
    expect(await swept).toEqual({ outcome: 'not_resident' })
  })

  it('NOT resident because a compaction holding the slot detached the projector — the latch\'s pass waits for the slot and runs under the NEW projector, instead of `not_resident` at once', async () => {
    const exclusion = createProcessExclusion()
    let resident: string | null = null // detached by the compaction
    let release!: () => void
    const compaction = exclusion.run(() => new Promise<void>((resolve) => { release = resolve }))
    let acquired = 0
    const swept = sweepModelEpochs(W, sweepDeps(exclusion, {
      ...triggeredSweepOptions({ priority: true }),
      residentProjectorInstanceId: () => resident,
      // Under the slot with a projector: stop there (no database below).
      onAcquired: () => { acquired += 1; resident = null },
    }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(exclusion.waiting()).toBe(1)
    resident = 'after-compaction'
    release()
    await compaction
    await swept
    expect(acquired).toBe(1)
    // Not resident and NO hold: still the cheap answer, without queueing.
    const idle = await sweepModelEpochs(W, sweepDeps(exclusion, { residentProjectorInstanceId: () => null, onAcquired: () => { acquired += 1 } }))
    expect(idle).toEqual({ outcome: 'not_resident' })
    expect(acquired).toBe(1)
  })

  it('…and the ownership too: a cell that lost the workspace during the wait answers not_owned', async () => {
    const exclusion = createProcessExclusion()
    let owns = true
    let release!: () => void
    const compaction = exclusion.run(() => new Promise<void>((resolve) => { release = resolve }))
    const swept = sweepModelEpochs(W, sweepDeps(exclusion, { exclusionWaitMs: 30_000, owns: () => owns }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    owns = false
    release()
    await compaction
    expect(await swept).toEqual({ outcome: 'not_owned' })
  })

  it('`onAcquired` is called once the slot is held — never for a sweep refused it', async () => {
    const exclusion = createProcessExclusion()
    let release!: () => void
    const compaction = exclusion.run(() => new Promise<void>((resolve) => { release = resolve }))
    let acquired = 0
    expect(await sweepModelEpochs(W, sweepDeps(exclusion, { onAcquired: () => { acquired += 1 } }))).toMatchObject({ outcome: 'busy' })
    expect(acquired).toBe(0)
    release()
    await compaction
    let resident: string | null = 'r'
    expect(await sweepModelEpochs(W, sweepDeps(exclusion, {
      onAcquired: () => { acquired += 1; resident = null }, residentProjectorInstanceId: () => resident,
    }))).toEqual({ outcome: 'not_resident' })
    expect(acquired).toBe(1)
  })
})

describe('yieldToRefusedRotation', () => {
  it('yields only when one of the workspace\'s triggered passes HOLDS the slot (it held the keys)', () => {
    const calls: Array<[string, number]> = []
    let holding = false
    const trigger = { holding: () => holding, yieldFor: (k: { versionId: string }, ms: number) => { calls.push([k.versionId, ms]) } }
    expect(yieldToRefusedRotation(trigger, W, 5_000)).toBe(false) // a compaction held them
    expect(calls).toEqual([])
    holding = true
    expect(yieldToRefusedRotation(trigger, W, 5_000)).toBe(true)
    expect(calls).toEqual([['V', 5_000]])
    expect(yieldToRefusedRotation(null, W, 5_000)).toBe(false)
  })

  it('end to end: a rotation refused BY THE COMPACTION does not delay S9', async () => {
    const runs: string[] = []
    const trigger = createForwardTrigger(async (_key, urgency) => { runs.push(urgency.reset ? 'reset' : 'other') }, { sleep: async () => undefined })
    yieldToRefusedRotation(trigger, W, 5_000) // nothing running: the compaction's refusal
    expect(trigger.startsInMs(W, { priority: true })).toBe(0)
    await trigger.request(W, { reset: true })
    expect(runs).toEqual(['reset'])
  })
})

describe('awaitTriggeredForward — the durable-heads route\'s forward wait', () => {
  type Ack = { documentId: string; forwardPending?: true; forwarded?: boolean }
  const fakeTrigger = (startsInMs: number, pass: Promise<void>) => {
    const asked: Array<{ priority?: boolean }> = []
    return { asked, trigger: { startsInMs: (_k: unknown, o?: { priority?: boolean }) => { asked.push(o ?? {}); return startsInMs }, request: (_k: unknown, o?: { priority?: boolean }) => { asked.push(o ?? {}); return pass } } }
  }
  const pending: Ack[] = [{ documentId: 'd', forwardPending: true }]
  const after: Ack[] = [{ documentId: 'd', forwarded: true }]

  it('`latch=1` is a PRIORITY request; anything else is ordinary', async () => {
    for (const [query, priority] of [[{ latch: '1' }, true], [{ latch: '0' }, false], [{}, false], [{ latch: ['1'] }, false]] as const) {
      const { asked, trigger } = fakeTrigger(0, Promise.resolve())
      const out = await awaitTriggeredForward({ trigger, key: W, query: query as Record<string, unknown>, acknowledged: pending, reacknowledge: async () => after, waitMs: 1_500 })
      expect(asked).toEqual([{ priority }, { priority }])
      expect(out.priority).toBe(priority)
    }
  })

  it('waits for a pass that can start inside the window, then answers AGAIN', async () => {
    const { trigger } = fakeTrigger(0, Promise.resolve())
    const out = await awaitTriggeredForward({ trigger, key: W, query: { latch: '1' }, acknowledged: pending, reacknowledge: async () => after, waitMs: 1_500 })
    expect(out.ended).toBe('pass')
    expect(out.acknowledged).toBe(after)
  })

  it('does not wait for a pass that cannot start inside the window; the answer is kept', async () => {
    let reasked = false
    const { trigger } = fakeTrigger(1_500, new Promise<void>(() => undefined))
    const out = await awaitTriggeredForward({ trigger, key: W, query: {}, acknowledged: pending, reacknowledge: async () => { reasked = true; return after }, waitMs: 1_500 })
    expect(out.ended).toBe('not-waited')
    expect(out.acknowledged).toBe(pending)
    expect(reasked).toBe(false)
  })

  it('a pass that does not end inside the window: timeout, the answer kept', async () => {
    const { trigger } = fakeTrigger(0, new Promise<void>(() => undefined))
    const out = await awaitTriggeredForward({ trigger, key: W, query: {}, acknowledged: pending, reacknowledge: async () => after, waitMs: 30 })
    expect(out.ended).toBe('timeout')
    expect(out.acknowledged).toBe(pending)
  })

  it('D2: a source still pending while a latch could not be served is marked `forwardBusy`; ready, or forwarded, it is not', async () => {
    const busyTrigger = { ...fakeTrigger(0, new Promise<void>(() => undefined)).trigger, latchReady: () => false }
    const busy = await awaitTriggeredForward({ trigger: busyTrigger, key: W, query: {}, acknowledged: pending, reacknowledge: async () => after, waitMs: 20 })
    expect(busy.acknowledged).toEqual([{ documentId: 'd', forwardPending: true, forwardBusy: true }])
    const readyTrigger = { ...fakeTrigger(0, new Promise<void>(() => undefined)).trigger, latchReady: () => true }
    const ready = await awaitTriggeredForward({ trigger: readyTrigger, key: W, query: {}, acknowledged: pending, reacknowledge: async () => after, waitMs: 20 })
    expect(ready.acknowledged).toEqual([{ documentId: 'd', forwardPending: true }])
    const servedTrigger = { ...fakeTrigger(0, Promise.resolve()).trigger, latchReady: () => false }
    const served = await awaitTriggeredForward({ trigger: servedTrigger, key: W, query: {}, acknowledged: pending, reacknowledge: async () => after, waitMs: 1_500 })
    expect(served.acknowledged).toEqual(after)
  })

  it('D2: the pass RUNNING when asked is enough when it carried the heads — answered at its end, the follow-up not waited for', async () => {
    let endRunning!: () => void
    const running = new Promise<void>((resolve) => { endRunning = resolve })
    const trigger = { ...fakeTrigger(0, new Promise<void>(() => undefined)).trigger, runningPass: () => running }
    let reasked = 0
    const out = awaitTriggeredForward({ trigger, key: W, query: { latch: '1' }, acknowledged: pending, reacknowledge: async () => { reasked += 1; return after }, waitMs: 1_500 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    endRunning()
    const result = await out
    expect(result.ended).toBe('running-pass')
    expect(result.acknowledged).toBe(after)
    expect(reasked).toBe(1)
  })

  it('D2: the running pass did NOT carry them — the follow-up is waited for, and answered again after it', async () => {
    let endFollow!: () => void
    const follow = new Promise<void>((resolve) => { endFollow = resolve })
    const trigger = { ...fakeTrigger(0, follow).trigger, runningPass: () => Promise.resolve() }
    const answers = [pending, after]
    const out = awaitTriggeredForward({ trigger, key: W, query: {}, acknowledged: pending, reacknowledge: async () => answers.shift()!, waitMs: 1_500 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    endFollow()
    const result = await out
    expect(result.ended).toBe('pass')
    expect(result.acknowledged).toBe(after)
  })

  it('nothing pending, or no trigger: nothing requested', async () => {
    const { asked, trigger } = fakeTrigger(0, Promise.resolve())
    expect((await awaitTriggeredForward({ trigger, key: W, query: { latch: '1' }, acknowledged: after, reacknowledge: async () => after, waitMs: 1_500 })).ended).toBe('not-triggered')
    expect(asked).toEqual([])
    expect((await awaitTriggeredForward({ trigger: null, key: W, query: {}, acknowledged: pending, reacknowledge: async () => after, waitMs: 1_500 })).ended).toBe('not-triggered')
  })
})

describe('sweepModelEpochs and the pool-heavy slot', () => {
  const deps = sweepDeps

  it('with `exclusionWaitMs`, the sweep WAITS for the slot as a waiter (a running pass sees it), then skips', async () => {
    const exclusion = createProcessExclusion()
    let release!: () => void
    const hold = exclusion.run(() => new Promise<void>((resolve) => { release = resolve }))
    const swept = sweepModelEpochs(W, deps(exclusion, { exclusionWaitMs: 60 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(exclusion.waiting()).toBe(1)
    expect(await swept).toMatchObject({ outcome: 'busy' })
    expect(exclusion.waiting()).toBe(0)
    release()
    await hold
  })

  it('without it, the sweep only tries: busy at once, never a waiter', async () => {
    const exclusion = createProcessExclusion()
    let release!: () => void
    const hold = exclusion.run(() => new Promise<void>((resolve) => { release = resolve }))
    const swept = sweepModelEpochs(W, deps(exclusion))
    expect(exclusion.waiting()).toBe(0)
    expect(await swept).toMatchObject({ outcome: 'busy' })
    release()
    await hold
  })
})

describe('a latch during the PERIODIC sweep loop', () => {
  /** A sweep as `sweepModelEpochs` takes the slot (`runWithin` with a wait,
   * `tryRun` without) whose work walks `steps` sources of `stepMs`, yielding
   * at each safe point to a waiter once its grace is over. */
  function fakeSweep(exclusion: ProcessExclusion, opts: { exclusionWaitMs?: number; yieldGraceMs?: number }, steps: number, stepMs: number,
    onStart?: () => void, onAcquired?: () => void) {
    const work = async () => {
      onStart?.()
      onAcquired?.()
      const startedAt = Date.now()
      for (let i = 0; i < steps; i += 1) {
        if (exclusion.waiting() > 0 && Date.now() - startedAt >= (opts.yieldGraceMs ?? 0)) return { outcome: 'swept', forwarded: { outcome: 'ran', sources: [], yielded: 'preempted' as const } }
        await new Promise((resolve) => setTimeout(resolve, stepMs))
      }
      return { outcome: 'swept', forwarded: { outcome: 'ran', sources: [{ outcome: 'forwarded' }] } }
    }
    return (opts.exclusionWaitMs ? exclusion.runWithin(work, opts.exclusionWaitMs) : exclusion.tryRun(work))
      .then((r) => (r.ran ? r.value : { outcome: 'busy' }))
  }

  it('the latch\'s pass starts in < 2 s and is not preempted by the loop\'s next waiter before its grace', async () => {
    const exclusion = createProcessExclusion()
    let latchStartedAt = 0
    let latchResult: unknown
    const trigger = createForwardTrigger(async (_key, urgency, onAcquired) => {
      const result = await fakeSweep(exclusion, triggeredSweepOptions(urgency), 8, 100, () => { latchStartedAt = Date.now() }, onAcquired)
      latchResult = result
      return result
    })
    // The loop: five workspaces, each a 1.5 s sweep, as waiters (30 s).
    let stop = false
    const loop = (async () => {
      for (let i = 0; i < 5 && !stop; i += 1) await fakeSweep(exclusion, { exclusionWaitMs: 30_000 }, 15, 100)
    })()
    await new Promise((resolve) => setTimeout(resolve, 700))
    const latchAt = Date.now()
    await trigger.request(W, { priority: true })
    stop = true
    await loop
    expect(latchStartedAt).toBeGreaterThan(0)
    expect(latchStartedAt - latchAt).toBeLessThan(2_000)
    expect((latchResult as { forwarded?: { yielded?: string } }).forwarded?.yielded).toBeUndefined()
  }, 20_000)
})
