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
import { createForwardTrigger, type ForwardTriggerOptions } from './modelEpochForwardTrigger.js'
import { yieldToRefusedRotation } from './modelEpochForwardWiring.js'

/** G4-16f: the event-driven forward pass —
 * single flight per workspace, one follow-up for every request made during a
 * pass or its rest, a rest at least as long as the pass, a backoff when a
 * pass moves nothing, never a throw. */
const A = { landscapeId: 'L', versionId: 'A' }
const B = { landscapeId: 'L', versionId: 'B' }

/** A controlled pass and a fake clock: `finish(ranMs, result)` ends the
 * oldest open pass after advancing the clock by `ranMs`. A pass holds the
 * pool-heavy slot from its start (`onAcquired()` at once) unless the helper
 * is told `waitForSlot`: it then holds it only after `acquire()`. */
function controlled(opts: { waitForSlot?: boolean } = {}) {
  let t = 1_000
  const sleeps: number[] = []
  const runs: Array<{ key: string; urgency?: { priority: boolean; reset: boolean }; acquire: () => void; finish: (ranMs?: number, result?: unknown) => void; fail: (e: Error) => void }> = []
  const run = (key: { versionId: string }, urgency?: { priority: boolean; reset: boolean }, onAcquired?: () => void) => new Promise<unknown>((resolve, reject) => {
    if (!opts.waitForSlot) onAcquired?.()
    runs.push({
      key: key.versionId,
      urgency,
      acquire: () => onAcquired?.(),
      finish: (ranMs = 0, result: unknown = 'moved') => { t += ranMs; resolve(result) },
      fail: reject,
    })
  })
  const options: ForwardTriggerOptions = {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms },
    progressed: (result) => result === 'moved',
    minGapMs: 750,
    backoffMs: 1_000,
    maxBackoffMs: 4_000,
  }
  return { runs, run, sleeps, options, advance: (ms: number) => { t += ms } }
}

const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }

describe('createForwardTrigger', () => {
  it('a request with nothing running starts a pass at once and resolves when it ends', async () => {
    const { runs, run, options } = controlled()
    const trigger = createForwardTrigger(run, options)
    let done = false
    void trigger.request(A).then(() => { done = true })
    await tick()
    expect(runs.map((r) => r.key)).toEqual(['A'])
    expect(done).toBe(false)
    runs[0]!.finish()
    await tick()
    expect(done).toBe(true)
    expect(trigger.busy(A)).toBe(false)
  })

  it('requests DURING a pass fold into ONE follow-up pass, run after the rest, answered only after it', async () => {
    const { runs, run, options, sleeps } = controlled()
    const trigger = createForwardTrigger(run, options)
    const first = trigger.request(A)
    await tick()
    let secondDone = false
    let thirdDone = false
    void trigger.request(A).then(() => { secondDone = true })
    void trigger.request(A).then(() => { thirdDone = true })
    await tick()
    expect(runs).toHaveLength(1)
    runs[0]!.finish(200)
    await first
    await tick()
    expect(runs).toHaveLength(2) // exactly one follow-up…
    expect(sleeps).toEqual([750]) // …after the minimal rest
    expect(secondDone || thirdDone).toBe(false)
    runs[1]!.finish()
    await tick()
    expect(secondDone && thirdDone).toBe(true)
    expect(runs).toHaveLength(2)
  })

  it('a request DURING the follow-up queues a third pass; the slot empties after it ', async () => {
    const { runs, run, options } = controlled()
    const trigger = createForwardTrigger(run, options)
    void trigger.request(A)
    await tick()
    void trigger.request(A) // queued follow-up
    runs[0]!.finish()
    await tick()
    expect(runs).toHaveLength(2) // the follow-up is RUNNING
    let thirdDone = false
    void trigger.request(A).then(() => { thirdDone = true })
    await tick()
    runs[1]!.finish()
    await tick()
    expect(runs).toHaveLength(3) // a third pass, not a join of the running one
    expect(thirdDone).toBe(false)
    runs[2]!.finish()
    await tick()
    expect(thirdDone).toBe(true)
    expect(trigger.busy(A)).toBe(false)
  })

  it('RATE CEILING: the rest after a pass is at least as long as the pass ran', async () => {
    const { runs, run, options, sleeps } = controlled()
    const trigger = createForwardTrigger(run, options)
    void trigger.request(A)
    await tick()
    void trigger.request(A)
    runs[0]!.finish(3_000) // a 3 s pass
    await tick()
    expect(sleeps).toEqual([3_000])
    expect(runs).toHaveLength(2)
  })

  it('a request right after a pass, nothing running, still waits for the rest', async () => {
    const { runs, run, options, sleeps, advance } = controlled()
    const trigger = createForwardTrigger(run, options)
    void trigger.request(A)
    await tick()
    runs[0]!.finish(100)
    await tick()
    advance(300) // 300 ms later: 450 ms of rest left
    void trigger.request(A)
    await tick()
    expect(sleeps).toEqual([450])
    expect(runs).toHaveLength(2)
  })

  it('NO PROGRESS backs off, doubling up to the ceiling; a pass that progresses resets it', async () => {
    const { runs, run, options, sleeps } = controlled()
    const trigger = createForwardTrigger(run, options)
    for (let i = 0; i < 4; i += 1) {
      void trigger.request(A)
      await tick()
      runs[i]!.finish(0, 'nothing')
      await tick()
    }
    // The first request ran at once; the next three each waited a rest.
    expect(sleeps).toEqual([1_000, 2_000, 4_000])
    void trigger.request(A)
    await tick()
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 4_000]) // capped
    runs[4]!.finish(0, 'moved')
    await tick()
    void trigger.request(A)
    await tick()
    expect(sleeps.at(-1)).toBe(750) // reset: the minimal rest only
  })

  it('workspaces are independent', async () => {
    const { runs, run, options } = controlled()
    const trigger = createForwardTrigger(run, options)
    void trigger.request(A)
    void trigger.request(B)
    await tick()
    expect(runs.map((r) => r.key).sort()).toEqual(['A', 'B'])
  })

  it('a failed pass is logged, answers the request, and counts as no progress', async () => {
    const { runs, run, options, sleeps } = controlled()
    const events: Array<Record<string, unknown>> = []
    const trigger = createForwardTrigger(run, { ...options, log: (e) => events.push(e) })
    const first = trigger.request(A)
    await tick()
    runs[0]!.fail(new Error('rotation key lost'))
    await expect(first).resolves.toBeUndefined()
    expect(events).toContainEqual(expect.objectContaining({ event: 'model_epoch.forward_trigger.failed', error: 'rotation key lost' }))
    void trigger.request(A)
    await tick()
    expect(sleeps).toEqual([1_000])
    expect(runs).toHaveLength(2)
  })

  it('no trace function: nothing is traced (the default)', async () => {
    const { runs, run, options } = controlled()
    const trigger = createForwardTrigger(run, options)
    void trigger.request(A)
    await tick()
    runs[0]!.finish()
    await tick()
    expect(runs).toHaveLength(1)
  })
})

describe('createForwardTrigger: latches, the process budget, S9 and the rotation yield', () => {
  it('a LATCH request during a 1.2 s pass starts the next pass AT ONCE (no rest) — the latch converges inside 2 s', async () => {
    const { runs, run, options, sleeps, advance } = controlled()
    const trigger = createForwardTrigger(run, options)
    void trigger.request(A) // an ordinary ack started a 1.2 s pass
    await tick()
    advance(500) // the latch arrives 0.5 s into it
    const latchAt = 1_000 + 500
    expect(trigger.startsInMs(A, { priority: true })).toBe(0)
    let done = -1
    const now = options.now!
    void trigger.request(A, { priority: true }).then(() => { done = now() })
    await tick()
    runs[0]!.finish(700) // the running pass ends at 1.2 s
    await tick()
    expect(runs).toHaveLength(2) // …and the latch's pass started then, without a rest
    expect(sleeps).toEqual([])
    runs[1]!.finish(1_200)
    await tick()
    expect(done - latchAt).toBe(1_900) // 0.7 s left of the running pass + its own 1.2 s
    expect(done - latchAt).toBeLessThan(2_000)
  })

  it('the same latch WITHOUT priority waits the 1.2 s rest — past the 2 s window (the defect the priority closes)', async () => {
    const { runs, run, options, sleeps, advance } = controlled()
    const trigger = createForwardTrigger(run, options)
    void trigger.request(A)
    await tick()
    advance(500)
    void trigger.request(A)
    await tick()
    runs[0]!.finish(700)
    await tick()
    expect(sleeps).toEqual([1_200])
  })

  it('at most THREE priority passes per workspace in any 2 s (tabs latching on the same roll); the next one inside it is an ordinary request', async () => {
    const { runs, run, options, sleeps } = controlled()
    const trigger = createForwardTrigger(run, options)
    for (let i = 0; i < 3; i += 1) {
      // Each tab's latch: served at once, no rest between them.
      expect(trigger.startsInMs(A, { priority: true })).toBe(0)
      void trigger.request(A, { priority: true })
      await tick()
      runs[i]!.finish(300)
      await tick()
    }
    expect(sleeps).toEqual([])
    // 900 ms after the first priority pass started: a fourth is not one.
    expect(trigger.startsInMs(A, { priority: true })).toBe(750)
    void trigger.request(A, { priority: true })
    await tick()
    expect(sleeps).toEqual([750])
    expect(runs).toHaveLength(4)
    expect(runs[3]!.urgency).toEqual({ priority: false, reset: false })
  })

  it('with `priorityBurst: 1`: the earlier rule, ONE priority pass per workspace every 2 s', async () => {
    const { runs, run, options, sleeps } = controlled()
    const trigger = createForwardTrigger(run, { ...options, priorityBurst: 1 })
    void trigger.request(A, { priority: true })
    await tick()
    runs[0]!.finish(300)
    await tick()
    expect(trigger.startsInMs(A, { priority: true })).toBe(750)
    void trigger.request(A, { priority: true })
    await tick()
    expect(sleeps).toEqual([750])
    expect(runs).toHaveLength(2)
  })

  it('a latch pass REFUSED the slot (behind a compaction) does not spend the workspace\'s burst — the next latch of the same 2 s is served; one that ran does', async () => {
    const { runs, run, options } = controlled()
    const trigger = createForwardTrigger(run, { ...options, priorityBurst: 1, busy: (r) => r === 'busy' })
    void trigger.request(A, { priority: true })
    await tick()
    runs[0]!.finish(0, 'busy')
    await tick()
    expect(trigger.latchReady(A)).toBe(true)
    void trigger.request(A, { priority: true })
    await tick()
    expect(runs).toHaveLength(2)
    expect(runs[1]!.urgency).toEqual({ priority: true, reset: false })
    runs[1]!.finish(0, 'moved')
    await tick()
    expect(trigger.latchReady(A)).toBe(false)
  })

  it('the refused latch gives back ITS OWN share — the one that ran keeps its stamp, which expires on its own schedule', async () => {
    const { runs, run, options, advance } = controlled()
    const trigger = createForwardTrigger(run, { ...options, priorityBurst: 2, busy: (r) => r === 'busy' })
    // t = 1 000: a latch that RAN.
    void trigger.request(A, { priority: true })
    await tick()
    runs[0]!.finish(0, 'moved')
    await tick()
    // t = 2 000: a latch REFUSED the slot.
    advance(1_000)
    void trigger.request(A, { priority: true })
    await tick()
    expect(runs[1]!.urgency).toEqual({ priority: true, reset: false })
    runs[1]!.finish(0, 'busy')
    await tick()
    // t = 3 100: the first stamp (1 000) has left the 2 s window; a latch runs.
    advance(1_100)
    void trigger.request(A, { priority: true })
    await tick()
    expect(runs[2]!.urgency).toEqual({ priority: true, reset: false })
    runs[2]!.finish(0, 'moved')
    await tick()
    // One stamp in the window (3 100): a second latch is still allowed. Had
    // the refused pass given back the OLDEST stamp instead of its own, its
    // 2 000 would remain beside 3 100: the burst spent.
    advance(100)
    expect(trigger.latchReady(A)).toBe(true)
  })

  it('a pass REFUSED the pool-heavy slot rests the minimal gap and never arms the backoff', async () => {
    const { runs, run, options, sleeps } = controlled()
    const trigger = createForwardTrigger(run, { ...options, busy: (r) => r === 'busy' })
    for (let i = 0; i < 3; i += 1) {
      void trigger.request(A)
      await tick()
      runs[i]!.finish(0, 'busy')
      await tick()
    }
    expect(sleeps).toEqual([750, 750])
    // …and a pass that then moves nothing starts the backoff from its first step.
    void trigger.request(A)
    await tick()
    runs[3]!.finish(0, 'nothing')
    await tick()
    void trigger.request(A)
    await tick()
    expect(sleeps.at(-1)).toBe(1_000)
  })

  it('S9 (`reset`) clears the backoff and starts right after the running pass', async () => {
    const { runs, run, options, sleeps } = controlled()
    const trigger = createForwardTrigger(run, options)
    for (let i = 0; i < 3; i += 1) {
      void trigger.request(A)
      await tick()
      runs[i]!.finish(0, 'nothing')
      await tick()
    }
    expect(sleeps).toEqual([1_000, 2_000]) // backed off 4 s now
    expect(trigger.startsInMs(A)).toBe(4_000)
    expect(trigger.startsInMs(A, { reset: true })).toBe(0)
    void trigger.request(A, { reset: true })
    await tick()
    expect(runs).toHaveLength(4)
    expect(sleeps).toEqual([1_000, 2_000]) // no 4 s wait
    // The backoff was CLEARED: if S9's pass moves nothing, the next rest
    // starts the backoff again from its first step, not from 4 s.
    runs[3]!.finish(0, 'nothing')
    await tick()
    expect(trigger.startsInMs(A)).toBe(1_000)
    // During a pass, S9 joins the follow-up and makes it skip the rest.
    void trigger.request(A, { reset: true }) // starts at once (reset)
    await tick()
    expect(runs).toHaveLength(5)
    void trigger.request(A)
    await tick()
    void trigger.request(A, { reset: true })
    runs[4]!.finish(900)
    await tick()
    expect(runs).toHaveLength(6)
    expect(sleeps).toEqual([1_000, 2_000])
  })

  it('a latch joining an ordinary follow-up asleep in its rest WAKES it', async () => {
    let t = 0
    const pending: Array<() => void> = []
    const runs: Array<(r?: unknown) => void> = []
    const trigger = createForwardTrigger(() => new Promise((resolve) => { runs.push(resolve) }), {
      now: () => t,
      sleep: (ms) => new Promise<void>((resolve) => { pending.push(() => { t += ms; resolve() }) }),
      progressed: () => true,
    })
    void trigger.request(A)
    await tick()
    void trigger.request(A)
    t += 400
    runs[0]!('moved')
    await tick()
    expect(pending).toHaveLength(1) // the follow-up sleeps its 750 ms rest
    void trigger.request(A, { priority: true })
    await tick()
    expect(runs).toHaveLength(2) // woken: started without waiting the rest out
  })

  it('startsInMs — idle 0; resting the rest left; running, ordinary ≥ max(minGap, what it ran so far)', async () => {
    const { runs, run, options, advance } = controlled()
    const trigger = createForwardTrigger(run, options)
    expect(trigger.startsInMs(A)).toBe(0)
    void trigger.request(A)
    await tick()
    advance(1_600)
    expect(trigger.startsInMs(A)).toBe(1_600)
    expect(trigger.startsInMs(A, { priority: true })).toBe(0)
    runs[0]!.finish(0)
    await tick()
    advance(100)
    expect(trigger.startsInMs(A)).toBe(1_500)
  })

  it('the PROCESS budget — ordinary passes of all workspaces hold ≤ 30 % of 60 s; past it a request waits, a latch does not', async () => {
    const { runs, run, options, sleeps } = controlled()
    const trigger = createForwardTrigger(run, { ...options, budgetShare: 0.3, budgetWindowMs: 60_000, budgetRecheckMs: 1_000 })
    // B and C: 18 s of passes inside the window.
    void trigger.request(B)
    void trigger.request({ landscapeId: 'L', versionId: 'C' })
    await tick()
    runs[0]!.finish(9_000)
    runs[1]!.finish(9_000)
    await tick()
    expect(trigger.startsInMs(A)).toBe(1_000)
    expect(trigger.startsInMs(A, { priority: true })).toBe(0)
    void trigger.request(A, { priority: true })
    await tick()
    expect(runs.map((r) => r.key)).toEqual(['B', 'C', 'A']) // a latch is not held by the budget
    runs[2]!.finish(0)
    await tick()
    // An ordinary request of D, budget still spent: it waits (re-checked).
    const D = { landscapeId: 'L', versionId: 'D' }
    void trigger.request(D)
    await tick()
    expect(runs).toHaveLength(3)
    expect(sleeps.length).toBeGreaterThan(0)
    expect(sleeps.every((ms) => ms === 1_000)).toBe(true)
  })

  it('`yieldFor` holds every pass of the workspace, a latch included', async () => {
    const { runs, run, options, sleeps } = controlled()
    const trigger = createForwardTrigger(run, options)
    trigger.yieldFor(A, 5_000)
    expect(trigger.startsInMs(A, { priority: true })).toBe(5_000)
    void trigger.request(A, { priority: true })
    await tick()
    expect(sleeps).toEqual([5_000])
    expect(runs).toHaveLength(1)
    void trigger.request(B)
    await tick()
    expect(runs.map((r) => r.key)).toEqual(['A', 'B'])
  })

  it('an idle slot is purged once its rest is over; a quiet backoff decays', async () => {
    const { runs, run, options, advance, sleeps } = controlled()
    const trigger = createForwardTrigger(run, options)
    void trigger.request(A)
    await tick()
    runs[0]!.finish(0)
    await tick()
    expect(trigger.slotCount()).toBe(1)
    advance(800)
    void trigger.request(B)
    await tick()
    expect(trigger.slotCount()).toBe(1) // A's rest is over: forgotten
    runs[1]!.finish(0, 'nothing') // B backs off 1 s
    await tick()
    advance(1_000 + 4_000) // its rest, then a quiet max backoff
    void trigger.request(B)
    await tick()
    expect(runs).toHaveLength(3)
    expect(sleeps).toEqual([]) // decayed: no backoff left
  })
})

describe('createForwardTrigger: urgency, the reserved priority share, S9 re-plans', () => {
  it('`run` is told the pass\'s urgency — a latch, S9, or ordinary', async () => {
    const { runs, run, options } = controlled()
    const trigger = createForwardTrigger(run, options)
    void trigger.request(A)
    void trigger.request(B, { priority: true })
    void trigger.request({ landscapeId: 'L', versionId: 'C' }, { reset: true })
    await tick()
    expect(runs.map((r) => [r.key, r.urgency])).toEqual([
      ['A', { priority: false, reset: false }],
      ['B', { priority: true, reset: false }],
      ['C', { priority: false, reset: true }],
    ])
  })

  it('10 latches/s on 3 workspaces hold the passes to ≤ 45 % of the window (+ one pass each) — `latch=1` is never trusted', async () => {
    let t = 0
    const sleepers: Array<{ until: number; resolve: () => void }> = []
    const open: Array<{ until: number; resolve: (r: unknown) => void }> = []
    const passes: Array<{ start: number; end: number }> = []
    const PASS_MS = 500
    const trigger = createForwardTrigger((_key, _urgency, onAcquired) => new Promise((resolve) => {
      onAcquired()
      const start = t
      open.push({ until: t + PASS_MS, resolve: (r) => { passes.push({ start, end: t }); resolve(r) } })
    }), {
      now: () => t,
      sleep: (ms) => new Promise<void>((resolve) => { sleepers.push({ until: t + ms, resolve }) }),
      progressed: () => true,
    })
    const keys = ['X', 'Y', 'Z'].map((versionId) => ({ landscapeId: 'L', versionId }))
    for (let step = 0; step < 1_800; step += 1) { // 180 s, every 100 ms
      t += 100
      for (const p of open.splice(0).filter((o) => { if (o.until <= t) return true; open.push(o); return false })) p.resolve('moved')
      for (const s of sleepers.splice(0).filter((o) => { if (o.until <= t) return true; sleepers.push(o); return false })) s.resolve()
      await tick()
      for (const key of keys) void trigger.request(key, { priority: true })
      await tick()
    }
    const from = t - 60_000
    const used = passes.reduce((sum, p) => sum + Math.max(0, Math.min(p.end, t) - Math.max(p.start, from)), 0)
      + open.reduce((sum) => sum + PASS_MS, 0)
    expect(used).toBeLessThanOrEqual(0.45 * 60_000 + 3 * PASS_MS)
    // …and the latches are not refused outright: they keep running, ordinary.
    expect(passes.filter((p) => p.start >= from).length).toBeGreaterThan(10)
  })

  it('a latch past the reserved priority share is an ORDINARY request (traced), the total budget then holds it', async () => {
    const { runs, run, options } = controlled()
    const traced: Array<Record<string, unknown>> = []
    const logged: Array<Record<string, unknown>> = []
    const trigger = createForwardTrigger(run, { ...options, trace: (e) => traced.push(e), log: (e) => logged.push(e),
      budgetShare: 0.3, priorityShare: 0.15, budgetWindowMs: 60_000 })
    // 9 s of PRIORITY passes (15 % of 60 s) on B…
    void trigger.request(B, { priority: true })
    await tick()
    runs[0]!.finish(9_000)
    await tick()
    // …and 9 s ordinary on C: the total is at 30 %.
    void trigger.request({ landscapeId: 'L', versionId: 'C' })
    await tick()
    runs[1]!.finish(9_000)
    await tick()
    expect(trigger.startsInMs(A, { priority: true })).toBe(1_000) // demoted: held like an ordinary one
    void trigger.request(A, { priority: true })
    await tick()
    expect(runs).toHaveLength(2)
    // A second demotion (another workspace): traced again, logged once per window.
    void trigger.request({ landscapeId: 'L', versionId: 'D' }, { priority: true })
    await tick()
    expect(traced.filter((e) => e.event === 'forward_trigger.latch_demoted')).toHaveLength(2)
    expect(logged.filter((e) => e.event === 'model_epoch.forward_trigger.latch_demoted')).toHaveLength(1)
  })

  it('the budget counts only the part of a pass INSIDE the window', async () => {
    const { runs, run, options, advance } = controlled()
    const trigger = createForwardTrigger(run, { ...options, budgetShare: 0.3, budgetWindowMs: 60_000 })
    void trigger.request(B)
    await tick()
    runs[0]!.finish(30_000) // 1 s → 31 s
    await tick()
    advance(44_000) // at 75 s the window starts at 15 s: 16 s of it inside (27 %)
    expect(trigger.startsInMs(A)).toBe(0)
  })

  it('S9 is NOT held by the rotation yield (a compaction-caused refusal); a latch still is', async () => {
    const { runs, run, options, sleeps } = controlled()
    const trigger = createForwardTrigger(run, options)
    trigger.yieldFor(A, 5_000)
    expect(trigger.startsInMs(A, { reset: true })).toBe(0)
    void trigger.request(A, { reset: true })
    await tick()
    expect(runs).toHaveLength(1)
    expect(sleeps).toEqual([])
    // During its pass: a follow-up S9 does not wait the yield either…
    expect(trigger.startsInMs(A, { reset: true })).toBe(0)
    void trigger.request(A, { reset: true })
    runs[0]!.finish(100)
    await tick()
    expect(runs).toHaveLength(2)
    expect(sleeps).toEqual([])
    // …while a latch does (A15: the RUNNING path of startsInMs too).
    expect(trigger.startsInMs(A, { priority: true })).toBeGreaterThan(4_000)
  })

  it('a REFUSED S9 is re-planned after the minimal rest, at most 3 times', async () => {
    const { runs, run, options, sleeps } = controlled()
    const trigger = createForwardTrigger(run, { ...options, busy: (r) => r === 'busy' })
    void trigger.request(A, { reset: true })
    for (let i = 0; i < 6; i += 1) {
      await tick()
      runs[i]?.finish(0, 'busy')
      await tick()
    }
    expect(runs).toHaveLength(4) // the first and three re-plans
    expect(runs.every((r) => r.urgency?.reset === true)).toBe(true)
    expect(sleeps).toEqual([750, 750, 750])
    // A refused ORDINARY pass is not re-planned.
    void trigger.request(B)
    await tick()
    runs[4]!.finish(0, 'busy')
    await tick(); await tick()
    expect(runs).toHaveLength(5)
  })

  it('an S9 that ran is not re-planned', async () => {
    const { runs, run, options } = controlled()
    const trigger = createForwardTrigger(run, { ...options, busy: (r) => r === 'busy' })
    void trigger.request(A, { reset: true })
    await tick()
    runs[0]!.finish(0, 'moved')
    await tick(); await tick()
    expect(runs).toHaveLength(1)
  })

  it('the lazy purge never forgets a slot whose pass is RUNNING — single flight holds across workspaces', async () => {
    const { runs, run, options } = controlled()
    const trigger = createForwardTrigger(run, options)
    void trigger.request(A)
    await tick()
    void trigger.request(B) // purges idle slots
    await tick()
    void trigger.request(A)
    await tick()
    expect(runs.filter((r) => r.key === 'A')).toHaveLength(1)
    expect(trigger.busy(A)).toBe(true)
  })

  it('a backoff decays only after a QUIET max backoff past the rest — a request right after the rest doubles it', async () => {
    const { runs, run, options, advance } = controlled()
    const trigger = createForwardTrigger(run, options)
    void trigger.request(A)
    await tick()
    runs[0]!.finish(0, 'nothing') // backoff 1 s
    await tick()
    advance(1_000) // the rest is over, not the quiet period
    void trigger.request(A)
    await tick()
    expect(runs).toHaveLength(2)
    runs[1]!.finish(0, 'nothing')
    await tick()
    expect(trigger.startsInMs(A)).toBe(2_000)
  })

  it('a slot whose latch is younger than the priority gap is not purged — no latch past the burst inside 2 s', async () => {
    const { runs, run, options, advance } = controlled()
    const traced: Array<Record<string, unknown>> = []
    const trigger = createForwardTrigger(run, { ...options, priorityBurst: 1, trace: (e) => traced.push(e) })
    void trigger.request(A, { priority: true })
    await tick()
    runs[0]!.finish(0)
    await tick()
    advance(800) // A's rest is over, its latch 800 ms old
    void trigger.request(B)
    await tick()
    void trigger.request(A, { priority: true })
    await tick()
    const last = traced.filter((e) => e.event === 'forward_trigger.request' && e.workspace === 'L/A').at(-1)
    expect(last?.priority).toBe(false)
  })

  it('`running` names a pass in flight only (not a queued follow-up)', async () => {
    const { runs, run, options } = controlled()
    const trigger = createForwardTrigger(run, { ...options, sleep: () => new Promise<void>(() => undefined) })
    expect(trigger.running(A)).toBe(false)
    void trigger.request(A)
    await tick()
    expect(trigger.running(A)).toBe(true)
    void trigger.request(A)
    runs[0]!.finish(0)
    await tick()
    expect(trigger.busy(A)).toBe(true) // the follow-up rests
    expect(trigger.running(A)).toBe(false)
  })
})

describe('createForwardTrigger: runningPass', () => {
  it('names the pass running now — it settles when that pass ends — and null when none runs (a queued follow-up is not one)', async () => {
    const { runs, run, options } = controlled()
    const trigger = createForwardTrigger(run, { ...options, sleep: () => new Promise<void>(() => undefined) })
    expect(trigger.runningPass(A)).toBeNull()
    void trigger.request(A)
    await tick()
    const running = trigger.runningPass(A)
    expect(running).not.toBeNull()
    let ended = false
    void running!.then(() => { ended = true })
    void trigger.request(A) // queues the follow-up
    await tick()
    expect(ended).toBe(false)
    runs[0]!.finish(100)
    await tick()
    expect(ended).toBe(true)
    expect(trigger.runningPass(A)).toBeNull() // the follow-up rests
  })
})

describe('createForwardTrigger: latchReady', () => {
  it('not ready while S9 runs or is queued; ready again once it ended', async () => {
    const { runs, run, options } = controlled()
    const trigger = createForwardTrigger(run, options)
    expect(trigger.latchReady(A)).toBe(true)
    void trigger.request(A, { reset: true })
    await tick()
    expect(trigger.latchReady(A)).toBe(false) // S9 running
    expect(trigger.latchReady(B)).toBe(true) // another workspace
    runs[0]!.finish(100)
    await tick()
    expect(trigger.latchReady(A)).toBe(true)
    // An ordinary pass running, S9 queued behind it.
    void trigger.request(A)
    await tick()
    expect(trigger.latchReady(A)).toBe(true)
    void trigger.request(A, { reset: true })
    expect(trigger.latchReady(A)).toBe(false)
  })

  it('not ready inside the per-workspace latch gap, nor during a rotation yield', async () => {
    const { runs, run, options, advance } = controlled()
    const trigger = createForwardTrigger(run, { ...options, priorityGapMs: 2_000, priorityBurst: 1 })
    void trigger.request(A, { priority: true })
    await tick()
    runs[0]!.finish(300)
    await tick()
    expect(trigger.latchReady(A)).toBe(false)
    advance(2_000)
    expect(trigger.latchReady(A)).toBe(true)
    trigger.yieldFor(A, 500)
    expect(trigger.latchReady(A)).toBe(false)
    advance(500)
    expect(trigger.latchReady(A)).toBe(true)
  })

  it('not ready while the pool-heavy slot is held by something else (a compaction); a hold by one of its own passes is not that', async () => {
    const { runs, run, options } = controlled()
    let held = false
    const trigger = createForwardTrigger(run, { ...options, slotHeld: () => held })
    held = true // a compaction
    expect(trigger.latchReady(A)).toBe(false)
    held = false
    void trigger.request(B)
    await tick()
    held = true // B's own pass holds it
    expect(trigger.latchReady(A)).toBe(true)
    runs[0]!.finish(10)
    await tick()
    expect(trigger.latchReady(A)).toBe(false)
  })

  it('a compaction QUEUED for the slot makes a latch not ready even while one of the trigger\'s own passes holds it', async () => {
    const { runs, run, options } = controlled()
    let queued = false
    const trigger = createForwardTrigger(run, { ...options, slotHeld: () => true, slotQueued: () => queued })
    void trigger.request(B)
    await tick()
    // B's own pass holds the slot: the exemption applies.
    expect(trigger.latchReady(A)).toBe(true)
    // A compaction queues behind it: served before the latch's pass.
    queued = true
    expect(trigger.latchReady(A)).toBe(false)
    queued = false
    expect(trigger.latchReady(A)).toBe(true)
    runs[0]!.finish(10)
    await tick()
  })
})

describe('createForwardTrigger: the budget counts the hold of the slot, not the wait', () => {
  const C = { landscapeId: 'L', versionId: 'C' }

  it('the budget counts the HOLD of the slot, not the wait — a pass that waited 25 s and worked 100 ms is 100 ms', async () => {
    const { runs, run, options, advance, sleeps } = controlled({ waitForSlot: true })
    const trigger = createForwardTrigger(run, { ...options, budgetShare: 0.3, budgetWindowMs: 60_000 })
    void trigger.request(B, { reset: true }) // S9, behind a compaction as a waiter
    await tick()
    advance(25_000) // the wait: more than the whole 18 s budget
    runs[0]!.acquire()
    runs[0]!.finish(100)
    await tick()
    // An ordinary pass of ANOTHER workspace starts at once (the budget is not spent)…
    expect(trigger.startsInMs(A)).toBe(0)
    void trigger.request(A)
    await tick()
    expect(runs.map((r) => r.key)).toEqual(['B', 'A'])
    expect(sleeps).toEqual([])
    // …and B rests the minimal gap, not 25.1 s.
    expect(trigger.startsInMs(B)).toBe(750)
  })

  it('a latch that waited 10 s for the slot does not spend the 9 s priority share', async () => {
    const { runs, run, options, advance } = controlled({ waitForSlot: true })
    const traced: Array<Record<string, unknown>> = []
    const trigger = createForwardTrigger(run, { ...options, trace: (e) => traced.push(e), priorityShare: 0.15, budgetWindowMs: 60_000 })
    void trigger.request(B, { priority: true })
    await tick()
    advance(10_000)
    runs[0]!.acquire()
    runs[0]!.finish(100)
    await tick()
    void trigger.request(C, { priority: true })
    await tick()
    expect(traced.filter((e) => e.event === 'forward_trigger.latch_demoted')).toEqual([])
    expect(runs[1]?.urgency).toEqual({ priority: true, reset: false })
    expect(traced.find((e) => e.event === 'forward_trigger.pass_acquired')).toMatchObject({ waitedMs: 10_000, priority: true })
    expect(traced.find((e) => e.event === 'forward_trigger.pass_end')).toMatchObject({ waitedMs: 10_000, heldMs: 100, acquired: true })
  })

  it('a pass REFUSED the slot (it never held it) counts nothing, however long it waited', async () => {
    const { runs, run, options, advance } = controlled({ waitForSlot: true })
    const trigger = createForwardTrigger(run, { ...options, busy: (r) => r === 'busy', budgetShare: 0.3, budgetWindowMs: 60_000 })
    void trigger.request(B, { reset: true })
    await tick()
    advance(30_000)
    runs[0]!.finish(0, 'busy')
    await tick()
    expect(trigger.passLogSize()).toBe(0)
    expect(trigger.startsInMs(A)).toBe(0)
  })

  it('startsInMs — an ordinary request joining a pass still WAITING for the slot rests the minimal gap, not the wait; once it holds, what it held', async () => {
    const { runs, run, options, advance } = controlled({ waitForSlot: true })
    const trigger = createForwardTrigger(run, options)
    void trigger.request(A, { reset: true })
    await tick()
    advance(5_000)
    expect(trigger.startsInMs(A)).toBe(750)
    runs[0]!.acquire()
    advance(1_200)
    expect(trigger.startsInMs(A)).toBe(1_200)
  })

  it('`holding` is true only between the slot\'s acquisition and the pass\'s end', async () => {
    const { runs, run, options } = controlled({ waitForSlot: true })
    const trigger = createForwardTrigger(run, options)
    void trigger.request(A, { priority: true })
    await tick()
    expect(trigger.running(A)).toBe(true)
    expect(trigger.holding(A)).toBe(false) // waiting for the slot
    runs[0]!.acquire()
    expect(trigger.holding(A)).toBe(true)
    runs[0]!.finish(10)
    await tick()
    expect(trigger.holding(A)).toBe(false)
  })

  it('the pass log is pruned past the window, even behind a hold that never ends', async () => {
    const { runs, run, options, advance } = controlled()
    const trigger = createForwardTrigger(run, { ...options, budgetWindowMs: 60_000 })
    void trigger.request(A) // holds, never ends
    await tick()
    for (let i = 0; i < 5; i += 1) {
      void trigger.request({ landscapeId: 'L', versionId: `P${i}` })
      await tick()
      runs.at(-1)!.finish(10)
      await tick()
    }
    expect(trigger.passLogSize()).toBe(6)
    advance(61_000)
    expect(trigger.passLogSize()).toBe(1)
    expect(runs[0]!.key).toBe('A')
  })

  it('a REFUSED pass keeps the no-progress backoff where it was — the next unproductive pass doubles it', async () => {
    const { runs, run, options, advance } = controlled()
    const trigger = createForwardTrigger(run, { ...options, busy: (r) => r === 'busy' })
    void trigger.request(A)
    await tick()
    runs[0]!.finish(0, 'nothing') // backoff 1 s
    await tick()
    advance(1_000)
    void trigger.request(A)
    await tick()
    runs[1]!.finish(0, 'busy') // refused: only the minimal rest
    await tick()
    expect(trigger.startsInMs(A)).toBe(750)
    advance(750)
    void trigger.request(A)
    await tick()
    expect(runs).toHaveLength(3)
    runs[2]!.finish(0, 'nothing')
    await tick()
    expect(trigger.startsInMs(A)).toBe(2_000)
  })

  it('a re-planned S9 that JOINS a queued follow-up carries its attempt — still at most 3 re-plans', async () => {
    let t = 0
    const pending: Array<{ ms: number; resolve: () => void }> = []
    const runs: Array<{ urgency: { priority: boolean; reset: boolean }; done: boolean; finish: (r: unknown) => void }> = []
    const trigger = createForwardTrigger((_key, urgency, onAcquired) => new Promise((resolve) => {
      onAcquired()
      runs.push({ urgency, done: false, finish: resolve })
    }), {
      now: () => t,
      sleep: (ms) => new Promise<void>((resolve) => { pending.push({ ms, resolve: () => { t += ms; resolve() } }) }),
      busy: (r) => r === 'busy',
      progressed: () => false,
    })
    void trigger.request(A, { reset: true })
    await tick()
    void trigger.request(A) // an ordinary request: a queued follow-up, no S9 in it
    await tick()
    runs[0]!.done = true
    runs[0]!.finish('busy')
    await tick()
    // Two sleepers: the re-plan's (first) and the follow-up's rest.
    expect(pending.map((p) => p.ms)).toEqual([750, 750])
    pending.shift()!.resolve() // the re-plan lands while the follow-up is queued: it JOINS it
    await tick()
    expect(runs).toHaveLength(2)
    expect(runs[1]!.urgency.reset).toBe(true)
    // From here on every S9 pass is refused: count them all.
    for (let i = 0; i < 20; i += 1) {
      for (const r of runs.filter((o) => !o.done)) { r.done = true; r.finish('busy') }
      await tick()
      for (const p of pending.splice(0)) p.resolve()
      await tick()
    }
    expect(runs.filter((r) => r.urgency.reset)).toHaveLength(4) // the first and three re-plans
  })

  it('end to end: a latch WAITING for the slot behind a compaction does not make a refused rotation hold the next latch', async () => {
    const { runs, run, options, advance } = controlled({ waitForSlot: true })
    const trigger = createForwardTrigger(run, { ...options, busy: (r) => r === 'busy' })
    void trigger.request(A, { priority: true })
    await tick()
    // The compaction holds the keys and refuses the workspace's rotation.
    expect(yieldToRefusedRotation(trigger, A, 5_000)).toBe(false)
    advance(1_000)
    runs[0]!.finish(0, 'busy') // the latch's wait ran out
    await tick()
    advance(1_100) // past the priority gap and the minimal rest
    expect(trigger.startsInMs(A, { priority: true })).toBe(0)
    void trigger.request(A, { priority: true })
    await tick()
    expect(runs).toHaveLength(2)
    // A pass that HOLDS the slot (its own keys) does make it yield.
    runs[1]!.acquire()
    expect(yieldToRefusedRotation(trigger, A, 5_000)).toBe(true)
  })
})
