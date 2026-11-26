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

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createProcessExclusion } from '../maintenance/processExclusion.js'
import { createForwardTrigger } from './modelEpochForwardTrigger.js'
import { createEpochCapabilityMemo, createEpochTraceSink, createMaintenanceFollowUp, createSweepYieldWatch, createUnyieldingHolds, E2E_COMPACTION_HOLD_MAX_MS, e2eCompactionHoldFromEnv, epochRolledOrRecovered, forwardPassForwarded, forwardPassProgressed, forwardPassRefused, LATCH_EXCLUSION_WAIT_MS, maintenanceFollowUpSweepOptions, maintenanceRanToEnd, MAINTENANCE_FOLLOW_UP_ATTEMPTS, MAINTENANCE_FOLLOW_UP_MS, periodicSweepWorkspaces, SWEEP_YIELD_ALERT_STREAK, TRIGGERED_SWEEP, triggeredSweepOptions, wireEpochForwardPasses } from './modelEpochForwardWiring.js'
import { timedQueryable, emptyTimings } from './modelEpochTraceDeps.js'

const W = { landscapeId: 'L', versionId: 'V' }
const swept = (sources: Array<{ outcome: string }>, extra: Record<string, unknown> = {}) =>
  ({ outcome: 'swept', forwarded: { outcome: 'ran', sources, ...extra }, retired: { outcome: 'skipped_forward_only' } })

describe('forwardPassProgressed', () => {
  it('a pass that forwarded, advanced or routed a source progressed', () => {
    expect(forwardPassProgressed(swept([{ outcome: 'forwarded' }]))).toBe(true)
    expect(forwardPassProgressed(swept([{ outcome: 'failed' }, { outcome: 'advanced' }]))).toBe(true)
    expect(forwardPassProgressed(swept([{ outcome: 'nothing-routed' }]))).toBe(true)
    expect(forwardPassProgressed(swept([], { dedupe: [{}] }))).toBe(true)
    expect(forwardPassProgressed(swept([], { mirrorAdopted: ['u'] }))).toBe(true)
  })
  it('busy, contended, not resident, failing, quarantined or leased elsewhere did not', () => {
    for (const r of [
      { outcome: 'busy' }, { outcome: 'not_resident' }, { outcome: 'no_epoch_rows' },
      { outcome: 'swept', forwarded: { outcome: 'overlay_rotation_lock_contended' } },
      { outcome: 'swept', forwarded: { outcome: 'model_epoch_lock_contended' } },
      swept([{ outcome: 'failed' }, { outcome: 'quarantined' }, { outcome: 'leased-elsewhere' }, { outcome: 'missing-cursor-heads' }]),
      swept([]), undefined, null,
    ]) expect(forwardPassProgressed(r)).toBe(false)
  })
})

describe('periodicSweepWorkspaces', () => {
  it('the meta-only workspaces are swept too, each workspace once', () => {
    const d = { landscapeId: 'default', versionId: 'main' }
    const m = { landscapeId: 'L', versionId: 'meta-only' }
    expect(periodicSweepWorkspaces([d, W], [m, W])).toEqual([d, W, m])
  })
})

describe('TRIGGERED_SWEEP', () => {
  it('the event-driven pass is FORWARD ONLY, with a short budget', () => {
    expect(TRIGGERED_SWEEP).toEqual({ budgetMs: 10_000, forwardOnly: true })
  })
})

describe('forwardPassRefused', () => {
  it('a pass refused the pool-heavy slot, or preempted with nothing moved, is REFUSED (no backoff)', () => {
    expect(forwardPassRefused({ outcome: 'busy', heldForMs: 4_800 })).toBe(true)
    expect(forwardPassRefused(swept([], { yielded: 'preempted' }))).toBe(true)
  })
  it('a pass that moved something, ran out of budget, or found nothing to do is not', () => {
    expect(forwardPassRefused(swept([{ outcome: 'forwarded' }], { yielded: 'preempted' }))).toBe(false)
    expect(forwardPassRefused(swept([], { yielded: 'budget' }))).toBe(false)
    expect(forwardPassRefused(swept([{ outcome: 'failed' }]))).toBe(false)
    expect(forwardPassRefused({ outcome: 'not_resident' })).toBe(false)
    expect(forwardPassRefused(undefined)).toBe(false)
  })
})

describe('createEpochTraceSink bytes', () => {
  it('the bound counts BYTES: a multi-byte name fills it faster than its UTF-16 length says', async () => {
    const lines: string[] = []
    // Each line: ~102 UTF-16 units, ~162 bytes. Two fit 250 units, not 250 bytes.
    const sink = createEpochTraceSink('f', { maxBytes: 250, append: async (_f, text) => { lines.push(text) } })
    sink.write({ event: 'x', name: 'é'.repeat(60) })
    sink.write({ event: 'x', name: 'é'.repeat(60) })
    await sink.flushed()
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('trace_truncated')
  })
})

describe('epochRolledOrRecovered (S9)', () => {
  it('a roll and a recovered roll trigger a pass; anything else does not', () => {
    expect(epochRolledOrRecovered({ outcome: 'rolled' })).toBe(true)
    expect(epochRolledOrRecovered({ outcome: 'recovered' })).toBe(true)
    for (const o of ['skipped', 'not_due', 'busy', undefined]) expect(epochRolledOrRecovered({ outcome: o })).toBe(false)
    expect(epochRolledOrRecovered(undefined)).toBe(false)
  })
})

describe('createEpochCapabilityMemo', () => {
  it('positive is sticky: one query, then none', async () => {
    const rowsExist = vi.fn(async () => true)
    const memo = createEpochCapabilityMemo(rowsExist)
    expect(await memo.get(W)).toBe(true)
    expect(await memo.get(W)).toBe(true)
    expect(rowsExist).toHaveBeenCalledTimes(1)
  })
  it('negative is re-read only after its TTL; a roll marks the workspace at once', async () => {
    let t = 0
    const rowsExist = vi.fn(async () => false)
    const memo = createEpochCapabilityMemo(rowsExist, { negativeTtlMs: 60_000, now: () => t })
    expect(await memo.get(W)).toBe(false)
    t = 30_000
    expect(await memo.get(W)).toBe(false)
    expect(rowsExist).toHaveBeenCalledTimes(1)
    t = 61_000
    expect(await memo.get(W)).toBe(false)
    expect(rowsExist).toHaveBeenCalledTimes(2)
    memo.markRolled(W)
    expect(await memo.get(W)).toBe(true)
    expect(rowsExist).toHaveBeenCalledTimes(2)
  })
  it('an ERROR answers undefined (the bit is omitted), never false, and is not cached', async () => {
    const rowsExist = vi.fn(async () => { throw new Error('db down') })
    const memo = createEpochCapabilityMemo(rowsExist)
    expect(await memo.get(W)).toBeUndefined()
    expect(await memo.get(W)).toBeUndefined()
    expect(rowsExist).toHaveBeenCalledTimes(2)
  })
})

describe('createEpochTraceSink', () => {
  it('unset, or in production: disabled, nothing written', async () => {
    const append = vi.fn(async () => undefined)
    const warn = vi.fn()
    expect(createEpochTraceSink(undefined, { append }).enabled).toBe(false)
    const prod = createEpochTraceSink('/tmp/x', { nodeEnv: 'production', append, warn })
    expect(prod.enabled).toBe(false)
    prod.write({ event: 'e' })
    await prod.flushed()
    expect(append).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })
  it('appends in order, asynchronously, and stops with one truncation line past its bound', async () => {
    const lines: string[] = []
    const sink = createEpochTraceSink('/f', { maxBytes: 120, append: async (_f, text) => { lines.push(text) } })
    sink.write({ event: 'a' })
    expect(lines).toHaveLength(0) // not on the caller's turn
    sink.write({ event: 'b' })
    sink.write({ event: 'c', pad: 'x'.repeat(80) })
    sink.write({ event: 'd' })
    await sink.flushed()
    expect(lines.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual(['a', 'b', 'trace_truncated'])
  })
})

describe('timedQueryable', () => {
  it('a getter reading a #private field works through the proxy', async () => {
    // Not a pg Pool (the bare-construction guard scans for that name).
    class FakeQueryable {
      #secret = 'ok'
      get secret(): string { return this.#secret }
      async query(sql: string): Promise<string> { return `${sql}:${this.#secret}` }
    }
    const t = emptyTimings()
    const pool = timedQueryable(new FakeQueryable(), () => t)
    expect(pool.secret).toBe('ok')
    expect(await pool.query('SELECT 1')).toBe('SELECT 1:ok')
    expect(t.query.n).toBe(1)
  })
})

describe('e2eCompactionHoldFromEnv (the e2e\'s long compaction)', () => {
  it('nothing is built unless MODEL_EPOCH_E2E_COMPACTION_HOLD=on; ignored, with a warning, in production', () => {
    expect(e2eCompactionHoldFromEnv({})).toBeNull()
    expect(e2eCompactionHoldFromEnv({ MODEL_EPOCH_E2E_COMPACTION_HOLD: '1' })).toBeNull()
    const warn = vi.fn()
    expect(e2eCompactionHoldFromEnv({ MODEL_EPOCH_E2E_COMPACTION_HOLD: 'on', NODE_ENV: 'production' }, warn)).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('the query arms the NEXT compaction once; bounded; a query without the parameters arms nothing', () => {
    const hold = e2eCompactionHoldFromEnv({ MODEL_EPOCH_E2E_COMPACTION_HOLD: 'on', NODE_ENV: 'development' })!
    expect(hold.take()).toEqual({ holdMs: 0, afterMs: 0 })
    hold.arm({ e2eHoldMs: '4800', e2eHoldAfterMs: '33000' })
    hold.arm({ landscapeId: 'x' }) // another compact request: does not disarm
    expect(hold.take()).toEqual({ holdMs: 4_800, afterMs: 33_000 })
    expect(hold.take()).toEqual({ holdMs: 0, afterMs: 0 }) // consumed
    hold.arm({ e2eHoldMs: '9999999', e2eHoldAfterMs: '-5' })
    expect(hold.take()).toEqual({ holdMs: E2E_COMPACTION_HOLD_MAX_MS, afterMs: 0 })
    hold.arm({ e2eHoldMs: ['4800'], e2eHoldAfterMs: 'abc' })
    expect(hold.take()).toEqual({ holdMs: 0, afterMs: 0 })
  })
})

const flushed = () => new Promise<void>((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('createUnyieldingHolds', () => {
  it('a PERIODIC sweep holding the slot leaves a latch ready; a compaction or the meta-only job does not', async () => {
    const exclusion = createProcessExclusion()
    const holds = createUnyieldingHolds(exclusion)
    const trigger = createForwardTrigger(async () => ({ outcome: 'swept' }), { slotHeld: () => holds.held() })
    expect(trigger.latchReady(W)).toBe(true)
    // The periodic sweep: the exclusion itself, as a waiter (`index.ts`).
    const sweep = deferred()
    const sweeping = exclusion.runWithin(() => sweep.promise, 60_000)
    await flushed()
    expect(exclusion.hold()).not.toBeNull()
    expect(holds.held()).toBe(false)
    expect(trigger.latchReady(W)).toBe(true)
    // A compaction QUEUED behind
    // it is counted from the queue — the exclusion serves waiters in order,
    // so it gets the slot before a latch that asks after it.
    const compaction = deferred()
    const compacting = holds.run(() => compaction.promise)
    await flushed()
    expect(holds.held()).toBe(true)
    expect(trigger.latchReady(W)).toBe(false)
    sweep.resolve()
    await sweeping
    await flushed()
    // The slot passed to the compaction: marked.
    expect(holds.held()).toBe(true)
    expect(trigger.latchReady(W)).toBe(false)
    compaction.resolve()
    await compacting
    expect(holds.held()).toBe(false)
    expect(trigger.latchReady(W)).toBe(true)
    // The meta-only job (`runWithin`) is marked too.
    const job = deferred()
    const running = holds.runWithin(() => job.promise, 1_000)
    await flushed()
    expect(trigger.latchReady(W)).toBe(false)
    job.resolve()
    expect(await running).toEqual({ ran: true, value: undefined })
    expect(trigger.latchReady(W)).toBe(true)
    // A failing compaction clears its mark.
    await expect(holds.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(holds.held()).toBe(false)
  })

  it('`queued` is the waiters only — true while a compaction waits behind any holder, false once it holds or leaves', async () => {
    const exclusion = createProcessExclusion()
    const holds = createUnyieldingHolds(exclusion)
    // A trigger pass (not through the holds) holds the slot.
    const pass = deferred()
    const passing = exclusion.run(() => pass.promise)
    await flushed()
    expect(holds.queued()).toBe(false)
    const compaction = deferred()
    const compacting = holds.run(() => compaction.promise)
    await flushed()
    expect(holds.queued()).toBe(true)
    pass.resolve()
    await passing
    await flushed()
    // It holds now: held, no longer queued.
    expect(holds.queued()).toBe(false)
    expect(holds.held()).toBe(true)
    compaction.resolve()
    await compacting
    expect(holds.queued()).toBe(false)
  })

  it('the meta-only job REFUSED the slot (`runWithin` past its wait) leaves the queue count; a marked PHASE counts while it runs', async () => {
    const exclusion = createProcessExclusion()
    const holds = createUnyieldingHolds(exclusion)
    const sweep = deferred()
    const sweeping = exclusion.runWithin(() => sweep.promise, 60_000)
    await flushed()
    const refused = holds.runWithin(async () => 'never', 20)
    await flushed()
    expect(holds.held()).toBe(true) // queued
    expect(await refused).toEqual({ ran: false })
    expect(holds.held()).toBe(false)
    // The periodic sweep's retirement (no safe point): marked while it runs.
    const phase = deferred()
    const marking = holds.during(() => phase.promise)
    expect(holds.held()).toBe(true)
    phase.resolve()
    await marking
    expect(holds.held()).toBe(false)
    await expect(holds.during(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(holds.held()).toBe(false)
    sweep.resolve()
    await sweeping
  })

  it('`holding` is a pass HOLDING the slot only — not one queued for it, not a marked phase', async () => {
    const exclusion = createProcessExclusion()
    const holds = createUnyieldingHolds(exclusion)
    const sweep = deferred()
    const sweeping = exclusion.runWithin(() => sweep.promise, 60_000)
    await flushed()
    // Queued behind the sweep: held (the latch's readiness), not holding.
    const compaction = deferred()
    const compacting = holds.run(() => compaction.promise)
    await flushed()
    expect(holds.held()).toBe(true)
    expect(holds.holding()).toBe(false)
    // A marked phase: held, not holding.
    const phase = deferred()
    const marking = holds.during(() => phase.promise)
    expect(holds.holding()).toBe(false)
    phase.resolve()
    await marking
    sweep.resolve()
    await sweeping
    await flushed()
    // The compaction holds the slot now.
    expect(holds.holding()).toBe(true)
    compaction.resolve()
    await compacting
    expect(holds.holding()).toBe(false)
    expect(holds.held()).toBe(false)
  })
})

/** `index.ts` cannot be loaded: ONE assertion on its source — it composes
 * the epoch passes through `wireEpochForwardPasses` (tested in behaviour
 * below), and `slotHeld` is the wiring's. */
describe('index.ts uses wireEpochForwardPasses (source)', () => {
  it('wires the forward passes through wireEpochForwardPasses, with the pool-heavy exclusion and the maintenance stops', async () => {
    const source = (await readFile(path.resolve(import.meta.dirname, '..', 'index.ts'), 'utf8'))
      .split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n')
    expect(source).toMatch(/const epochPasses = wireEpochForwardPasses\(\{[\s\S]*?exclusion: poolHeavyPasses,[\s\S]*?stops: maintenanceScheduleStops,/)
    expect(source).toMatch(/slotHeld: epochPasses\.slotHeld/)
    expect(source).toMatch(/slotQueued: epochPasses\.slotQueued/)
    expect(source).not.toMatch(/createUnyieldingHolds|createMaintenanceFollowUp|createSweepYieldWatch|poolHeavyPasses\.run(Within)?\(/)
  })
})

describe('wireEpochForwardPasses', () => {
  const setup = (outcomes: { triggered?: unknown; sweep?: unknown } = {}) => {
    const exclusion = createProcessExclusion()
    const triggered: Array<Record<string, unknown>> = []
    const swept: Array<Record<string, unknown>> = []
    const log = vi.fn()
    const stops: Array<() => void> = []
    const due: Array<() => void> = []
    const wiring = wireEpochForwardPasses({
      exclusion,
      triggeredSweep: async (_key, options) => { triggered.push(options as never); return outcomes.triggered ?? forwardedOutcome },
      sweep: async (_key, options) => { swept.push(options as never); return outcomes.sweep ?? yieldedOutcome },
      isShuttingDown: () => false,
      log,
      stops,
      periodicWaitMs: 30_000,
      followUp: { setTimer: (fn) => { due.push(fn); return { cancel: () => { due.splice(due.indexOf(fn), 1) } } } },
    })
    return { exclusion, triggered, swept, log, stops, due, wiring }
  }
  const forwardedOutcome = swept([{ outcome: 'forwarded' }])
  const yieldedOutcome = { outcome: 'swept', forwarded: { outcome: 'ran', sources: [], yielded: 'preempted' }, retired: { outcome: 'yielded', reason: 'preempted' } }

  it('S7: every pass — the follow-up included — runs under the process exclusion, with the phases marked through the holds', async () => {
    const { exclusion, triggered, swept: sweeps, due, wiring } = setup({ sweep: swept([{ outcome: 'unchanged' }]) })
    await wiring.runRequestedOrS9(W, { priority: true }, () => undefined)
    expect(triggered[0]).toMatchObject({ exclusion, exclusionWaitMs: LATCH_EXCLUSION_WAIT_MS, maintenance: false })
    expect(typeof triggered[0]!.unyielding).toBe('function')
    // The follow-up armed by that forward, fired: its sweep has the exclusion and the maintenance.
    expect(due).toHaveLength(1)
    due.shift()!()
    await flushed()
    expect(sweeps[0]).toMatchObject({ exclusion, ...TRIGGERED_SWEEP })
    expect(sweeps[0]).not.toHaveProperty('maintenance')
    expect(typeof sweeps[0]!.unyielding).toBe('function')
    // The periodic sweep: the exclusion, as a waiter.
    await wiring.periodicSweep(W)
    expect(sweeps[1]).toMatchObject({ exclusion, exclusionWaitMs: 30_000 })
    // The phases' mark is the holds' (`slotHeld`).
    const phase = deferred()
    const marking = (sweeps[1]!.unyielding as (p: () => Promise<unknown>) => Promise<unknown>)(() => phase.promise)
    expect(wiring.slotHeld()).toBe(true)
    phase.resolve()
    await marking
    expect(wiring.slotHeld()).toBe(false)
  })

  it('the wiring\'s `slotQueued` is its holds\' queue — a compaction waiting behind a pass is queued, then holds', async () => {
    const { exclusion, wiring } = setup()
    const pass = deferred()
    const passing = exclusion.run(() => pass.promise)
    await flushed()
    expect(wiring.slotQueued()).toBe(false)
    const compaction = deferred()
    const compacting = wiring.holds.run(() => compaction.promise)
    await flushed()
    expect(wiring.slotQueued()).toBe(true)
    pass.resolve()
    await passing
    await flushed()
    expect(wiring.slotQueued()).toBe(false)
    expect(wiring.slotHeld()).toBe(true)
    compaction.resolve()
    await compacting
  })

  it('S8: the follow-up is stopped at shutdown — through the stops it was given', async () => {
    const { stops, due, wiring } = setup()
    await wiring.runRequestedOrS9(W, {}, () => undefined)
    expect(wiring.followUp.pending(W)).toBe(true)
    expect(stops).toHaveLength(1)
    for (const stop of stops) stop()
    expect(wiring.followUp.pending(W)).toBe(false)
    expect(due).toHaveLength(0)
    await wiring.runRequestedOrS9(W, {}, () => undefined)
    expect(wiring.followUp.pending(W)).toBe(false)
  })

  it('S9: ONE yield watch for the loop — six yielded periodic sweeps in a row alert once; S9 (reset) is not noted for the follow-up', async () => {
    const { log, due, wiring } = setup()
    for (let i = 0; i < SWEEP_YIELD_ALERT_STREAK; i++) await wiring.periodicSweep(W)
    expect(log.mock.calls.filter(([e]) => (e as { event: string }).event === 'model_epoch.sweep.yield_starved')).toHaveLength(1)
    expect(wiring.yieldWatch.streak(W)).toBe(SWEEP_YIELD_ALERT_STREAK)
    await wiring.runRequestedOrS9(W, { reset: true }, () => undefined)
    expect(due).toHaveLength(0)
    expect(wiring.followUp.pending(W)).toBe(false)
  })

  it('the compaction and the meta-only job run through the wiring\'s holds: queued or holding, `slotHeld` says so', async () => {
    const { exclusion, wiring } = setup()
    const sweep = deferred()
    const sweeping = exclusion.runWithin(() => sweep.promise, 60_000)
    await flushed()
    expect(wiring.slotHeld()).toBe(false)
    const compaction = deferred()
    const compacting = wiring.holds.run(() => compaction.promise)
    expect(wiring.slotHeld()).toBe(true)
    sweep.resolve()
    await sweeping
    compaction.resolve()
    await compacting
    expect(wiring.slotHeld()).toBe(false)
  })
})

describe('createMaintenanceFollowUp', () => {
  const manualTimers = () => {
    const due: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
    return {
      due,
      setTimer: (fn: () => void, ms: number) => {
        const t = { fn, ms, cancelled: false }
        due.push(t)
        // A cancelled timer leaves the list (a run's guard, cancelled when
        // the run settles, would otherwise sit in front of the retry).
        return { cancel: () => { t.cancelled = true; const at = due.indexOf(t); if (at >= 0) due.splice(at, 1) } }
      },
      fire: async () => {
        const next = due.shift()
        if (next && !next.cancelled) next.fn()
        await flushed()
      },
    }
  }
  const forwardedPass = swept([{ outcome: 'forwarded' }])

  it('the follow-up\'s options are the triggered pass\'s WITH the maintenance (a requested pass\'s are without)', () => {
    expect(maintenanceFollowUpSweepOptions()).toEqual({ ...TRIGGERED_SWEEP })
    expect(maintenanceFollowUpSweepOptions()).not.toHaveProperty('maintenance')
    expect(triggeredSweepOptions({})).toMatchObject({ maintenance: false })
  })

  it('a requested pass that FORWARDED schedules ONE maintenance pass after the delay; one that did not, none', async () => {
    expect(forwardPassForwarded(forwardedPass)).toBe(true)
    expect(forwardPassForwarded(swept([{ outcome: 'advanced' }, { outcome: 'unchanged' }]))).toBe(false)
    expect(forwardPassForwarded({ outcome: 'busy' })).toBe(false)
    const timers = manualTimers()
    const run = vi.fn(async () => swept([{ outcome: 'unchanged' }], { dedupe: [{}] }))
    const follow = createMaintenanceFollowUp({ run, delayMs: 30_000, setTimer: timers.setTimer })
    follow.noteRequested(W, swept([{ outcome: 'advanced' }]))
    expect(timers.due).toHaveLength(0)
    follow.noteRequested(W, forwardedPass)
    follow.noteRequested(W, forwardedPass) // a second one inside the delay: the same follow-up
    expect(timers.due.map((t) => t.ms)).toEqual([30_000])
    expect(follow.pending(W)).toBe(true)
    await timers.fire()
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(W)
    expect(follow.pending(W)).toBe(false)
    expect(timers.due).toHaveLength(0)
    follow.noteRequested(W, forwardedPass) // after it ran: a new one
    expect(timers.due).toHaveLength(1)
  })

  it('refused the slot: retried, at most MAINTENANCE_FOLLOW_UP_ATTEMPTS times; stop cancels', async () => {
    const timers = manualTimers()
    const run = vi.fn(async () => ({ outcome: 'busy' }))
    const follow = createMaintenanceFollowUp({ run, setTimer: timers.setTimer })
    follow.noteRequested(W, forwardedPass)
    for (let i = 0; i < MAINTENANCE_FOLLOW_UP_ATTEMPTS + 2; i++) await timers.fire()
    expect(run).toHaveBeenCalledTimes(MAINTENANCE_FOLLOW_UP_ATTEMPTS)
    expect(follow.pending(W)).toBe(false)
    follow.noteRequested(W, forwardedPass)
    follow.stop()
    expect(timers.due.every((t) => t.cancelled)).toBe(true)
    follow.noteRequested(W, forwardedPass)
    expect(follow.pending(W)).toBe(false)
  })

  it('retried until the MAINTENANCE ran to its end — preempted or out of budget AFTER forwarding, a rotation or `model-epoch:` key taken; not once it did', async () => {
    const unfinished = [
      swept([{ outcome: 'forwarded' }], { yielded: 'preempted' }),
      swept([{ outcome: 'forwarded' }], { yielded: 'budget' }),
      swept([{ outcome: 'unchanged' }], { yielded: 'preempted' }), // S4: preempted with nothing moved
      { outcome: 'swept', forwarded: { outcome: 'overlay_rotation_lock_contended' }, retired: { outcome: 'overlay_rotation_lock_contended' } },
      { outcome: 'busy' },
    ]
    for (const outcome of unfinished) {
      expect(maintenanceRanToEnd(outcome)).toBe(false)
      const timers = manualTimers()
      const run = vi.fn().mockResolvedValueOnce(outcome).mockResolvedValue(swept([{ outcome: 'unchanged' }]))
      const follow = createMaintenanceFollowUp({ run, setTimer: timers.setTimer })
      follow.noteRequested(W, forwardedPass)
      await timers.fire()
      expect(timers.due.filter((t) => t.ms === MAINTENANCE_FOLLOW_UP_MS)).toHaveLength(1) // retried
      await timers.fire()
      expect(run).toHaveBeenCalledTimes(2)
      expect(follow.pending(W)).toBe(false) // ran to its end: no more
    }
    expect(maintenanceRanToEnd(swept([{ outcome: 'unchanged' }], { dedupe: [{}] }))).toBe(true)
  })

  it('a run that FAILS frees its workspace — retried within the cap, then a new forward schedules again', async () => {
    const timers = manualTimers()
    const log = vi.fn()
    const run = vi.fn(async () => { throw new Error('pool exhausted') })
    const follow = createMaintenanceFollowUp({ run, log, setTimer: timers.setTimer })
    follow.noteRequested(W, forwardedPass)
    for (let i = 0; i < MAINTENANCE_FOLLOW_UP_ATTEMPTS + 2; i++) await timers.fire()
    expect(run).toHaveBeenCalledTimes(MAINTENANCE_FOLLOW_UP_ATTEMPTS)
    expect(log.mock.calls[0]![0]).toMatchObject({ event: 'model_epoch.forward.maintenance_follow_up_failed', error: 'pool exhausted' })
    expect(follow.pending(W)).toBe(false)
    follow.noteRequested(W, forwardedPass)
    expect(follow.pending(W)).toBe(true)
  })

  it('stopped WHILE a run is in flight — no retry after it', async () => {
    const timers = manualTimers()
    const running = deferred<unknown>()
    const run = vi.fn(() => running.promise)
    const follow = createMaintenanceFollowUp({ run, setTimer: timers.setTimer })
    follow.noteRequested(W, forwardedPass)
    await timers.fire()
    follow.stop()
    running.resolve({ outcome: 'busy' })
    await flushed()
    expect(timers.due.filter((t) => !t.cancelled && t.ms === MAINTENANCE_FOLLOW_UP_MS)).toHaveLength(0)
    expect(follow.pending(W)).toBe(false)
  })

  it('a real pass\'s MIXED sources (forwarded and unchanged) schedule the follow-up', () => {
    const timers = manualTimers()
    const follow = createMaintenanceFollowUp({ run: vi.fn(async () => ({})), setTimer: timers.setTimer })
    follow.noteRequested(W, swept([{ outcome: 'unchanged' }, { outcome: 'forwarded' }, { outcome: 'unchanged' }]))
    expect(follow.pending(W)).toBe(true)
  })

  it('a requested pass that forwards WHILE the follow-up RUNS gets one more after it; while it is only armed, the same one covers it', async () => {
    const timers = manualTimers()
    const running = deferred<unknown>()
    const run = vi.fn().mockReturnValueOnce(running.promise).mockResolvedValue(swept([{ outcome: 'unchanged' }]))
    const follow = createMaintenanceFollowUp({ run, setTimer: timers.setTimer })
    follow.noteRequested(W, forwardedPass)
    follow.noteRequested(W, forwardedPass) // armed: covered
    await timers.fire()
    follow.noteRequested(W, forwardedPass) // running: one more after it
    running.resolve(swept([{ outcome: 'unchanged' }]))
    await flushed()
    expect(follow.pending(W)).toBe(true)
    await timers.fire()
    expect(run).toHaveBeenCalledTimes(2)
    expect(follow.pending(W)).toBe(false)
  })

  it('a run that NEVER settles frees its workspace after the run timeout (logged)', async () => {
    const timers = manualTimers()
    const log = vi.fn()
    const follow = createMaintenanceFollowUp({ run: () => new Promise<never>(() => undefined), log, runTimeoutMs: 1_000, setTimer: timers.setTimer })
    follow.noteRequested(W, forwardedPass)
    await timers.fire() // the run starts, its guard is armed
    expect(timers.due.map((t) => t.ms)).toEqual([1_000])
    await timers.fire() // the guard
    expect(log.mock.calls[0]![0]).toMatchObject({ event: 'model_epoch.forward.maintenance_follow_up_stuck' })
    // Retried within the cap (it did not run to its end), the workspace free of the stuck run.
    expect(timers.due.map((t) => t.ms)).toEqual([MAINTENANCE_FOLLOW_UP_MS])
  })

  it('stop cancels a RUNNING follow-up\'s guard — a long shutdown logs no false "stuck"', async () => {
    const timers = manualTimers()
    const log = vi.fn()
    const follow = createMaintenanceFollowUp({ run: () => new Promise<never>(() => undefined), log, runTimeoutMs: 1_000, setTimer: timers.setTimer })
    follow.noteRequested(W, forwardedPass)
    await timers.fire() // the run starts, its guard is armed
    expect(timers.due.map((t) => t.ms)).toEqual([1_000])
    follow.stop()
    expect(timers.due).toEqual([])
    expect(log).not.toHaveBeenCalled()
  })
})

describe('createSweepYieldWatch', () => {
  const yielded = { outcome: 'swept', forwarded: { outcome: 'ran', sources: [], yielded: 'preempted' }, retired: { outcome: 'yielded', reason: 'preempted' } }
  // A retirement that RAN answers its report (no `outcome`).
  const ranToEnd = { outcome: 'swept', forwarded: { outcome: 'ran', sources: [] }, retired: { retiring: [], retired: [], pinned: [], unpinned: [], revived: [], deferred: [], epochsRetired: [] } }

  it('consecutive YIELDED periodic sweeps of a workspace alert once at the streak; a sweep run to its end clears it', () => {
    const log = vi.fn()
    const watch = createSweepYieldWatch({ log })
    const other = { landscapeId: 'L', versionId: 'other' }
    for (let i = 0; i < SWEEP_YIELD_ALERT_STREAK - 1; i++) watch.note(W, yielded)
    watch.note(W, { outcome: 'busy' }) // skipped behind a hold: not this signal's, the streak stands
    watch.note(other, yielded)
    expect(log).not.toHaveBeenCalled()
    watch.note(W, yielded)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toMatchObject({ event: 'model_epoch.sweep.yield_starved', alert: true, landscapeId: 'L', versionId: 'V', consecutiveYields: SWEEP_YIELD_ALERT_STREAK, reason: 'preempted' })
    watch.note(W, yielded)
    expect(log).toHaveBeenCalledOnce() // once per streak
    watch.note(W, ranToEnd)
    expect(watch.streak(W)).toBe(0)
    for (let i = 0; i < SWEEP_YIELD_ALERT_STREAK; i++) watch.note(W, yielded)
    expect(log).toHaveBeenCalledTimes(2)
    expect(watch.streak(other)).toBe(1)
  })

  it('a taken key (rotation or `model-epoch:`) retired nothing — it neither clears the streak nor adds to it; a BUDGET yield counts, its reason told apart', () => {
    const log = vi.fn()
    const watch = createSweepYieldWatch({ log })
    const rotation = { outcome: 'swept', forwarded: { outcome: 'overlay_rotation_lock_contended' }, retired: { outcome: 'overlay_rotation_lock_contended' } }
    const epochLock = { outcome: 'swept', forwarded: { outcome: 'ran', sources: [] }, retired: { outcome: 'model_epoch_lock_contended' } }
    const budget = { outcome: 'swept', forwarded: { outcome: 'ran', sources: [], yielded: 'budget' }, retired: { outcome: 'yielded', reason: 'budget' } }
    for (let i = 0; i < SWEEP_YIELD_ALERT_STREAK - 1; i++) {
      watch.note(W, yielded)
      watch.note(W, i % 2 ? rotation : epochLock)
    }
    expect(watch.streak(W)).toBe(SWEEP_YIELD_ALERT_STREAK - 1)
    watch.note(W, budget)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toMatchObject({ reason: 'budget' })
  })
})
