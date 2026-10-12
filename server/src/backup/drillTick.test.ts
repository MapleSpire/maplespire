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
import {
  DEFAULT_ABORT_GRACE_MS,
  DEFAULT_DRILL_DEADLINE_MS,
  DEFAULT_EXCLUSION_WATCH_MS,
  runDrillTick,
  type DrillAbandonment,
} from './drillTick.js'
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_KEEPALIVES,
  DEFAULT_OWNERSHIP_CHECK_CEILING_MS,
} from '../db/sessionAdvisoryLock.js'
import { TEARDOWN_STEP_TIMEOUT_MS } from './drillRunner.js'
import {
  advisoryLockResponder,
  DEFAULT_FAKE_TOKEN,
  fakePgPool,
  recordingAbortSignal,
  type FakePoolClient,
  type FakeQueryResult,
  type FakeResponder,
} from '../testing/fakePgPool.js'

/**
 * The verdict, isolated one clause at a time.
 *
 * `drillTick.integration.test.ts` proves the EXCLUSION — a rival connection
 * cannot take the key for the drill's whole run. It cannot prove the REPORT,
 * because the only case it produces with `exclusive: false` kills the backend,
 * which falsifies every input of
 *
 *     released.confirmed && released.loss === null
 *
 * at once (an unlock error also leaves `confirmed` false). A pool is an argument
 * to `runDrillTick`, so this file isolates each input with a fake pool.
 */

const KEY = 4242

const settle = async (predicate: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A drill that never settles. Deliberately does NOT listen to the signal: a
 *  drill that honours it is the easy case. */
const neverSettles = (): Promise<void> => new Promise<void>(() => {})

/** A drill that dies the moment it is asked to, which is what `pgTools` does
 *  once its child is killed. Resolves inside the abort dispatch, so no test
 *  built on it races a clock.
 *
 *  The `aborted` check is required: `addEventListener` on an already-aborted
 *  signal never fires, so without it this helper would hang on the
 *  interleavings the suites below reproduce. */
const stopsWhenAsked = (signal: AbortSignal): Promise<void> => new Promise<void>((done) => {
  if (signal.aborted) {
    done()
    return
  }
  signal.addEventListener('abort', () => done(), { once: true })
})

interface Recorder {
  readonly events: Array<[string, Record<string, unknown>]>
  readonly log: (event: string, fields?: Record<string, unknown>) => void
  readonly names: () => string[]
  readonly find: (event: string) => Record<string, unknown> | undefined
}

function recorder(): Recorder {
  const events: Array<[string, Record<string, unknown>]> = []
  return {
    events,
    log: (event, fields = {}) => { events.push([event, fields]) },
    names: () => events.map(([name]) => name),
    find: (event) => events.find(([name]) => name === event)?.[1],
  }
}

/** The client the LOCK is on — always the first the pool hands out, because
 *  acquiring the lock is the first thing `runDrillTick` does.
 *
 *  Not `fake.only`: every abandonment takes one final INDEPENDENT sample, which
 *  borrows a second client. */
const lockClient = (fake: ReturnType<typeof fakePgPool>): FakePoolClient => fake.clients[0]!

/** Collects `abandon` calls instead of ending the process. Every test that can
 *  reach abandonment MUST pass one: the production default ends the process,
 *  which would take the vitest worker with it. */
function abandonSpy(): { calls: DrillAbandonment[]; abandon: (report: DrillAbandonment) => void } {
  const calls: DrillAbandonment[] = []
  return { calls, abandon: (report) => { calls.push(report) } }
}

describe('drill tick — each clause of the verdict on its own', () => {
  it('an unlock that answers false alone makes the run non-exclusive', async () => {
    // `pg_advisory_unlock` returning `false` is the signature of a lock that
    // evaporated mid-run, and it is reachable with no loss and no error.
    const fake = fakePgPool(advisoryLockResponder({ unlock: false }))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool, lockKey: KEY, log: log.log, heartbeatMs: 0, drill: () => Promise.resolve(),
    })

    expect(outcome).toEqual({ status: 'ran', exclusive: false, cutShortBy: null })
    expect(log.find('backup.drill_ran_without_exclusion')).toMatchObject({
      unlockConfirmed: false,
      unlockError: null,
      lossReason: null,
    })
  })

  it('an unlock that raises alone makes the run non-exclusive', async () => {
    const fake = fakePgPool(advisoryLockResponder({ unlock: new Error('connection terminated') }))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool, lockKey: KEY, log: log.log, heartbeatMs: 0, drill: () => Promise.resolve(),
    })

    expect(outcome).toEqual({ status: 'ran', exclusive: false, cutShortBy: null })
    expect(log.find('backup.drill_ran_without_exclusion')).toMatchObject({
      unlockError: 'connection terminated',
    })
  })

  it('a loss observed mid-run alone makes the run non-exclusive', async () => {
    // Ownership ended and the unlock still answered `true` — Postgres is happy,
    // the key changed hands anyway. Without this clause the verdict would call
    // that exclusive.
    const fake = fakePgPool(advisoryLockResponder({ held: () => false, unlock: true }))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 5,
      drill: () => settle(() => log.names().includes('db.advisory_lock_lost')),
    })

    // `cutShortBy: 'lock-lost'`: a `not-owner` loss is a STOP, not merely a note
    // on the verdict.
    expect(outcome).toEqual({ status: 'ran', exclusive: false, cutShortBy: 'lock-lost' })
    const warned = log.find('backup.drill_ran_without_exclusion')!
    // The structured fields, so an operator can say WHY without reading the
    // source.
    expect(warned).toMatchObject({ unlockConfirmed: true, lossReason: 'not-owner', backendPid: 4242 })
    expect(warned.lossDetail).toEqual(expect.any(String))
    expect(warned.lossObservedAfterMs).toEqual(expect.any(Number))
  })

  it('a clean run is exclusive AND SILENT', async () => {
    // Negative control: an alarm that also fires on healthy runs hides the real
    // event.
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool, lockKey: KEY, log: log.log, heartbeatMs: 0, drill: () => Promise.resolve(),
    })

    expect(outcome).toEqual({ status: 'ran', exclusive: true, cutShortBy: null })
    expect(log.names()).not.toContain('backup.drill_ran_without_exclusion')
    expect(log.names()).not.toContain('backup.drill_stop_requested')
    expect(log.names()).not.toContain('backup.drill_abandoned')
  })
})

describe('drill tick — the drill outcome reaches the caller', () => {
  it('re-throws a rejection whose value is FALSY', async () => {
    // `failed` (a boolean) and `failure` (the value) are separate because
    // `Promise.reject(undefined)` is legal, and a truthiness check would report
    // that failed drill as `{status:'ran'}`.
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()
    await expect(runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      drill: () => Promise.reject(undefined),
    })).rejects.toBeUndefined()

    // And the key still went back: a failed drill must not wedge every future one.
    expect(fake.only.releases).toHaveLength(1)
  })

  it('releases before re-throwing, so the failure and the release both happen', async () => {
    const fake = fakePgPool(advisoryLockResponder({ unlock: false }))
    const log = recorder()
    const boom = new Error('pg_dump exploded')
    await expect(runDrillTick({
      pool: fake.pool, lockKey: KEY, log: log.log, heartbeatMs: 0, drill: () => Promise.reject(boom),
    })).rejects.toBe(boom)

    // All four survive one code path: the drill's error, the release, its
    // answer, and the report.
    expect(fake.only.statements.filter((s) => s.sql.includes('pg_advisory_unlock'))).toHaveLength(1)
    expect(log.find('backup.drill_ran_without_exclusion')).toMatchObject({ unlockConfirmed: false })
  })

  it('a log sink that throws does not swallow the drill failure', async () => {
    // One of these `log()` calls sits between the release and the re-throw. A
    // throw there would replace the failure the caller needs with the failure
    // of the thing reporting it.
    const fake = fakePgPool(advisoryLockResponder({ unlock: false }))
    const boom = new Error('pg_dump exploded')
    await expect(runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: () => { throw new Error('ENOSPC') },
      heartbeatMs: 0,
      drill: () => Promise.reject(boom),
    })).rejects.toBe(boom)
  })
})

describe('drill tick — what it hands the lock', () => {
  it('skips without running the drill when another scheduler holds the key', async () => {
    const fake = fakePgPool(advisoryLockResponder({ locked: false }))
    const log = recorder()
    let ran = false
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      drill: async () => { ran = true },
    })

    expect(outcome).toEqual({ status: 'skipped_lock_held' })
    expect(ran).toBe(false)
    expect(log.names()).toContain('backup.drill_skipped_lock_held')
  })

  it('routes the lock own events to the caller log, and forwards the heartbeat', async () => {
    // Without the first, nothing the lock says reaches the scheduler's stdout;
    // without the second, the scheduler would silently run with no heartbeat.
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()
    await runDrillTick({
      pool: fake.pool, lockKey: KEY, log: log.log, drill: () => Promise.resolve(),
    })

    expect(log.names()).toContain('db.advisory_lock_acquired')
    expect(log.names()).toContain('db.advisory_lock_released')
    // `heartbeatMs` unset here, so the module default must come through rather
    // than the tick pinning it to something of its own.
    expect(log.find('db.advisory_lock_acquired')).toMatchObject({ key: KEY, heartbeatMs: 15_000 })
  })
})

/**
 * The deadline.
 *
 * Deadlines and graces here are tens of milliseconds, which is safe because
 * nothing below waits on a filesystem, socket or child process: the drills
 * either settle inside the abort dispatch (`stopsWhenAsked`) or never settle
 * (`neverSettles`), so a starved event loop can delay these assertions but not
 * change which branch they take.
 */
describe('drill tick — the deadline', () => {
  it('aborts the drill when the deadline expires, and says so in the outcome', async () => {
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()
    const spy = abandonSpy()
    let sawAbort = false

    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 20,
      abortGraceMs: 2_000,
      abandon: spy.abandon,
      drill: (signal) => {
        signal.addEventListener('abort', () => { sawAbort = true }, { once: true })
        return stopsWhenAsked(signal)
      },
    })

    expect(sawAbort).toBe(true)
    // `cutShortBy` is the load-bearing field: `runBackupDrill` RETURNS its
    // failure rather than throwing, so without it a drill killed at the deadline
    // would look healthy.
    expect(outcome).toEqual({ status: 'ran', exclusive: true, cutShortBy: 'deadline' })
    expect(spy.calls).toHaveLength(0)
    expect(log.find('backup.drill_stop_requested')).toMatchObject({ reason: 'deadline' })
    // It settled, so the exclusion was given back the ordinary way.
    expect(fake.only.statements.filter((s) => s.sql.includes('pg_advisory_unlock'))).toHaveLength(1)
  })

  it('does not fire for a drill that finishes in time', async () => {
    // Negative control: a deadline that fires on healthy runs kills legitimate
    // dumps.
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()
    const spy = abandonSpy()
    let abortedForNoReason = false

    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 5_000,
      abandon: spy.abandon,
      drill: (signal) => {
        signal.addEventListener('abort', () => { abortedForNoReason = true }, { once: true })
        return Promise.resolve()
      },
    })

    expect(outcome).toEqual({ status: 'ran', exclusive: true, cutShortBy: null })
    expect(abortedForNoReason).toBe(false)
    expect(log.names()).not.toContain('backup.drill_stop_requested')
  })

  it('names the CALLER when SIGTERM is what stopped it, not the deadline', async () => {
    // "This drill is stuck" and "somebody is deploying" are different facts for
    // an operator reading the log.
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()
    const spy = abandonSpy()
    const stopper = new AbortController()

    const running = runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 10_000,
      signal: stopper.signal,
      abandon: spy.abandon,
      drill: stopsWhenAsked,
    })
    await settle(() => log.names().includes('db.advisory_lock_acquired'))
    stopper.abort(new Error('received SIGTERM'))

    expect(await running).toEqual({ status: 'ran', exclusive: true, cutShortBy: 'caller' })
    expect(log.find('backup.drill_stop_requested')).toMatchObject({ reason: 'caller' })
  })

  it('takes no lock at all when the caller is already stopping', async () => {
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()
    let ran = false
    const stopper = new AbortController()
    stopper.abort(new Error('received SIGTERM'))

    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      signal: stopper.signal,
      drill: async () => { ran = true },
    })

    expect(outcome).toEqual({ status: 'skipped_stopping' })
    expect(ran).toBe(false)
    // It never connected: taking a lock only to hand it straight back could
    // make an incoming scheduler skip its first tick during a rolling deploy.
    expect(fake.clients).toHaveLength(0)
    expect(log.names()).toContain('backup.drill_skipped_stopping')
  })
})

/**
 * Abandonment.
 *
 * When the drill will not stop, the lock is NOT released: releasing it would
 * hand the key to a rival while this process is still dumping. These tests
 * assert the omission, because an omission is what a refactor "tidies up".
 */
describe('drill tick — abandonment holds the key on purpose', () => {
  it('gives up on a drill that ignores the abort, and calls abandon', async () => {
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()
    const spy = abandonSpy()

    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 20,
      abortGraceMs: 40,
      abandon: spy.abandon,
      drill: neverSettles,
    })

    expect(outcome.status).toBe('abandoned')
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]).toMatchObject({
      reason: 'deadline',
      deadlineMs: 20,
      graceMs: 40,
      backendPid: 4242,
      lockKey: KEY,
      // How long the CLUSTER will leave this key with a silent client, carried
      // into the signed report (`DEFAULT_KEEPALIVES` gives 360 s).
      keepaliveDetectsWithinSeconds: 360,
    })
    expect(spy.calls[0]!.heldMs).toEqual(expect.any(Number))
    expect(log.find('backup.drill_abandoned')).toMatchObject({ reason: 'deadline' })
  })

  it('does NOT unlock and does NOT return the client', async () => {
    // Unlocking here — or handing the client back for the pool to reuse or
    // reap — would let a second scheduler start dumping while this one is still
    // writing the same bundle root.
    const fake = fakePgPool(advisoryLockResponder({}))
    const spy = abandonSpy()

    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: recorder().log,
      heartbeatMs: 0,
      deadlineMs: 20,
      abortGraceMs: 40,
      abandon: spy.abandon,
      drill: neverSettles,
    })

    const held = lockClient(fake)
    expect(held.statements.filter((s) => s.sql.includes('pg_advisory_unlock'))).toHaveLength(0)
    expect(held.releases).toHaveLength(0)
    expect(held.isReleased).toBe(false)
    // …but the client the final independent sample borrowed IS handed back; a
    // pool client kept here would make `pool.end()` never resolve.
    expect(fake.clients.length).toBeGreaterThan(1)
    expect(fake.clients.slice(1).every((client) => client.isReleased)).toBe(true)
  })

  it('waits the WHOLE grace: a drill that stops late is not abandoned', async () => {
    // An aborted drill spends the grace in its own `finally`, dropping the
    // isolated restore database — cluster work the exclusion must still cover.
    const fake = fakePgPool(advisoryLockResponder({}))
    const spy = abandonSpy()
    const log = recorder()

    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 20,
      abortGraceMs: 3_000,
      abandon: spy.abandon,
      drill: (signal) => new Promise<void>((done) => {
        signal.addEventListener('abort', () => { setTimeout(done, 60) }, { once: true })
      }),
    })

    expect(outcome).toEqual({ status: 'ran', exclusive: true, cutShortBy: 'deadline' })
    expect(spy.calls).toHaveLength(0)
    expect(log.names()).not.toContain('backup.drill_abandoned')
    expect(fake.only.releases).toHaveLength(1)
  })

  it('an abandoned drill that fails LATER is not an unhandled rejection', async () => {
    // `runDrillTick` has already returned by then, so the rejection has no
    // caller left to reach; unhandled, it would crash whatever is running.
    const fake = fakePgPool(advisoryLockResponder({}))
    const spy = abandonSpy()
    let failLater: (error: Error) => void = () => {}

    const unhandled: unknown[] = []
    const capture = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', capture)
    try {
      await runDrillTick({
        pool: fake.pool,
        lockKey: KEY,
        log: recorder().log,
        heartbeatMs: 0,
        deadlineMs: 20,
        abortGraceMs: 40,
        abandon: spy.abandon,
        drill: () => new Promise<void>((_, reject) => { failLater = reject }),
      })
      expect(spy.calls).toHaveLength(1)
      failLater(new Error('pg_dump finally died, long after we gave up'))
      // Two macrotask turns: `unhandledRejection` is decided at the end of a
      // turn, so a single microtask flush would pass on broken code too.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', capture)
    }

    expect(unhandled).toEqual([])
  })
})

/**
 * Windows between acquiring something and being able to give it back — each
 * `await` between acquisition and hand-off, and what happens if a stop or a
 * throw lands there.
 */
describe('drill tick — windows between acquisition and hand-off', () => {
  it('a SIGTERM landing DURING the acquisition still cuts the drill short', () => testWithSlowConnect())

  async function testWithSlowConnect(): Promise<void> {
    // `addEventListener` on an already-aborted signal NEVER FIRES. The entry
    // check runs before `pool.connect()` and the registration after it, so a
    // stop landing in between must still be noticed.
    const stopper = new AbortController()
    const responder = advisoryLockResponder({})
    const inner = fakePgPool(responder)
    // A pool whose `connect` aborts the caller mid-await.
    const pool = {
      connect: async () => {
        stopper.abort(new Error('received SIGTERM'))
        return inner.pool.connect()
      },
    } as unknown as typeof inner.pool
    const log = recorder()
    const spy = abandonSpy()
    let drillStarted = false

    const outcome = await runDrillTick({
      pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 10_000,
      signal: stopper.signal,
      abandon: spy.abandon,
      drill: (signal) => { drillStarted = true; return stopsWhenAsked(signal) },
    })

    // The drill is never STARTED: a drill handed an already-aborted signal is
    // not obliged to check `aborted` before its first await, so it may not stop
    // at all.
    expect(drillStarted).toBe(false)
    expect(outcome).toEqual({ status: 'skipped_stopping' })
    expect(log.find('backup.drill_skipped_stopping')).toMatchObject({ lockTaken: true })
    // And the key went straight back, rather than being held until the process
    // happened to end.
    expect(inner.only.statements.filter((s) => s.sql.includes('pg_advisory_unlock'))).toHaveLength(1)
    expect(inner.only.releases).toHaveLength(1)
  }

  it('a drill that throws SYNCHRONOUSLY still gives the key back', async () => {
    // `drill` is typed `(signal) => Promise<void>`, which a non-async function
    // throwing synchronously satisfies. Such a throw must not skip `.then` and
    // escape before the `try`, leaking the deadline timer, the caller-signal
    // listener, the checked-out client and the LOCK — for the process lifetime.
    const fake = fakePgPool(advisoryLockResponder({}))
    const boom = new Error('pgToolsFromEnv threw before returning a promise')
    await expect(runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: recorder().log,
      heartbeatMs: 0,
      // Not `async`: an async function would turn the throw into a rejection.
      drill: (): Promise<void> => { throw boom },
    })).rejects.toBe(boom)

    expect(fake.only.statements.filter((s) => s.sql.includes('pg_advisory_unlock'))).toHaveLength(1)
    expect(fake.only.releases).toHaveLength(1)
  })

  it('removes its listener from the caller signal, which outlives every tick', async () => {
    // The scheduler builds ONE `AbortController` for the whole process, so a
    // listener left behind accumulates one per tick and warns at ten. No
    // behavioural assertion can see this.
    const recording = recordingAbortSignal()
    for (let tick = 0; tick < 3; tick += 1) {
      const fake = fakePgPool(advisoryLockResponder({}))
      await runDrillTick({
        pool: fake.pool,
        lockKey: KEY,
        log: recorder().log,
        heartbeatMs: 0,
        signal: recording.signal,
        drill: () => Promise.resolve(),
      })
    }
    expect(recording.listeners()).toBe(0)
  })

  it('removes it on the SKIPPED path too, which is where it actually leaked', async () => {
    // Here the caller signal is ALREADY aborted when the listener is attached,
    // so `{ once: true }` never triggers and only an explicit removal keeps the
    // listener off a signal that lives for the whole process.
    const recording = recordingAbortSignal()
    const inner = fakePgPool(advisoryLockResponder({}))
    const pool = {
      connect: async () => {
        recording.abort(new Error('received SIGTERM'))
        return inner.pool.connect()
      },
    } as unknown as typeof inner.pool

    const outcome = await runDrillTick({
      pool,
      lockKey: KEY,
      log: recorder().log,
      heartbeatMs: 0,
      deadlineMs: 10_000,
      signal: recording.signal,
      abandon: abandonSpy().abandon,
      drill: (signal) => stopsWhenAsked(signal),
    })

    expect(outcome).toEqual({ status: 'skipped_stopping' })
    expect(recording.listeners()).toBe(0)
  })

  it('keeps the FIRST cause when a deadline is followed by a SIGTERM', async () => {
    // Two stops, one run. Without the `if (cutShortBy !== null) return` guard
    // the second would overwrite the first and the report would blame the
    // deploy rather than the wedge that actually happened.
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()
    const spy = abandonSpy()
    const stopper = new AbortController()

    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 20,
      abortGraceMs: 3_000,
      signal: stopper.signal,
      abandon: spy.abandon,
      drill: (signal) => new Promise<void>((done) => {
        signal.addEventListener('abort', () => {
          stopper.abort(new Error('received SIGTERM'))
          setTimeout(done, 30)
        }, { once: true })
      }),
    })

    expect(outcome).toEqual({ status: 'ran', exclusive: true, cutShortBy: 'deadline' })
    expect(log.events.filter(([name]) => name === 'backup.drill_stop_requested')).toHaveLength(1)
  })

  it('reports a CALLER-caused abandonment as such', async () => {
    // The likelier abandonment in production: a deploy meeting a drill that
    // will not stop.
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()
    const spy = abandonSpy()
    const stopper = new AbortController()

    const running = runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 60_000,
      abortGraceMs: 40,
      signal: stopper.signal,
      abandon: spy.abandon,
      drill: neverSettles,
    })
    await settle(() => log.names().includes('db.advisory_lock_acquired'))
    stopper.abort(new Error('received SIGTERM'))

    const outcome = await running
    expect(outcome.status).toBe('abandoned')
    expect(spy.calls[0]).toMatchObject({ reason: 'caller' })
    expect(log.find('backup.drill_abandoned')).toMatchObject({ reason: 'caller' })
    // Still held, whichever cause: the drill may still be dumping.
    expect(lockClient(fake).releases).toHaveLength(0)
  })

  it('an abandon handler that THROWS does not hide the abandonment', async () => {
    // `abandon` is caller-supplied code on the ONE path where the key is
    // deliberately still held. A throw escaping here could let the scheduler
    // carry on into ticks that skip forever against its own live session.
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()

    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 20,
      abortGraceMs: 40,
      abandon: () => { throw new Error('the recorder exploded') },
      drill: neverSettles,
    })

    expect(outcome.status).toBe('abandoned')
    expect(log.find('backup.drill_abandon_handler_failed')).toMatchObject({
      error: 'the recorder exploded',
    })
  })
})

/**
 * Resource-lifetime and message-quality properties — the kind a behavioural
 * assertion does not see.
 */
describe('drill tick — resource lifetime and message quality', () => {
  it('disarms the deadline: a healthy tick fires no stop AFTER it has returned', async () => {
    // An undisarmed timer would log `backup.drill_stop_requested` after the
    // tick resolved, which a synchronous read of the log cannot see.
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 30,
      drill: () => Promise.resolve(),
    })
    expect(log.names()).not.toContain('backup.drill_stop_requested')

    await new Promise((resolve) => setTimeout(resolve, 120))
    // Read the log AGAIN, well past the deadline.
    expect(log.names()).not.toContain('backup.drill_stop_requested')
  })

  it('deadlineMs 0 disables the ceiling', async () => {
    // Documented on `DrillTickOptions.deadlineMs`; pins `> 0` against `>= 0`,
    // which would abort every tick configured with no ceiling immediately.
    const fake = fakePgPool(advisoryLockResponder({}))
    let aborted = false
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: recorder().log,
      heartbeatMs: 0,
      deadlineMs: 0,
      drill: (signal) => {
        signal.addEventListener('abort', () => { aborted = true }, { once: true })
        return new Promise<void>((done) => setTimeout(done, 60))
      },
    })
    expect(aborted).toBe(false)
    expect(outcome).toEqual({ status: 'ran', exclusive: true, cutShortBy: null })
  })

  it('reports a heldMs an operator can believe', async () => {
    // A range rather than `expect.any(Number)`, which a zeroed `startedAt`
    // (heldMs ≈ the epoch) would satisfy.
    const fake = fakePgPool(advisoryLockResponder({}))
    const spy = abandonSpy()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: recorder().log,
      heartbeatMs: 0,
      deadlineMs: 20,
      abortGraceMs: 40,
      abandon: spy.abandon,
      drill: neverSettles,
    })
    const held = spy.calls[0]!.heldMs
    expect(held).toBeGreaterThanOrEqual(20)
    expect(held).toBeLessThan(30_000)
  })

  it('tells the drill WHY it is being stopped', async () => {
    // `runCommand`'s `describeAbort` turns the abort reason into the
    // operator-facing message; a bare `abort()` would say only "This operation
    // was aborted".
    const fake = fakePgPool(advisoryLockResponder({}))
    let reason: unknown
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: recorder().log,
      heartbeatMs: 0,
      deadlineMs: 25,
      abortGraceMs: 2_000,
      abandon: abandonSpy().abandon,
      drill: (signal) => new Promise<void>((done) => {
        signal.addEventListener('abort', () => { reason = signal.reason; done() }, { once: true })
      }),
    })
    expect(reason).toBeInstanceOf(Error)
    expect((reason as Error).message).toContain('25 ms deadline')
  })
})

describe('drill tick — the defaults are the safe ones', () => {
  it('the abort grace exceeds the teardown ceiling it has to cover', () => {
    // An aborted drill unwinds through `runBackupDrill`'s teardown, whose steps
    // are ceilinged at `TEARDOWN_STEP_TIMEOUT_MS` each; a grace below that
    // would abandon the process while the run is still dropping databases.
    expect(DEFAULT_ABORT_GRACE_MS).toBeGreaterThan(TEARDOWN_STEP_TIMEOUT_MS)
  })

  it('the default deadline is a real bound, well inside the daily cadence', () => {
    expect(DEFAULT_DRILL_DEADLINE_MS).toBeGreaterThan(0)
    expect(DEFAULT_DRILL_DEADLINE_MS).toBeLessThan(24 * 3_600_000)
  })

  it('the cluster will not reap our backend before the abort grace is spent', () => {
    // The abandonment path holds the key for the whole grace so the delay opens
    // no window for a rival; that also requires the session's TCP keepalives
    // not to let the cluster reap the backend sooner.
    const window = DEFAULT_KEEPALIVES.idleSeconds
      + DEFAULT_KEEPALIVES.count * DEFAULT_KEEPALIVES.intervalSeconds
    expect(window * 1000).toBeGreaterThan(
      DEFAULT_ABORT_GRACE_MS + DEFAULT_EXCLUSION_WATCH_MS + DEFAULT_OWNERSHIP_CHECK_CEILING_MS,
    )
  })
})

describe('drill tick — a keepalive window inside the grace is refused at the door', () => {
  it('REFUSES the tick, and gives the key back before it does', async () => {
    // A throw, not a log: the combination is a static property of the
    // configuration, like `drillSchedule` refusing a deadline that will not fit
    // its cadence.
    //
    // The check can only run AFTER the lock is taken (the window is what the
    // cluster applied to this session), so the throw must be preceded by a
    // release.
    const fake = fakePgPool(advisoryLockResponder({}))
    let drillRan = false
    await expect(runDrillTick({
      pool: fake.pool,
      lockKey: 4242,
      heartbeatMs: 0,
      // 360 s keepalive window against a grace that leaves it no room.
      abortGraceMs: 360_000,
      drill: async () => { drillRan = true },
    })).rejects.toThrow(/would go back while an abandoned run is still writing/)
    expect(drillRan).toBe(false)
    const unlocks = fake.only.statements.filter((s) => s.sql.includes('pg_advisory_unlock'))
    expect(unlocks).toHaveLength(1)
    // The public getter, not the fake client's private `released` field.
    expect(fake.only.isReleased).toBe(true)
  })

  it('refuses the EXACTLY-equal case, because equal is not longer', async () => {
    // The boundary that pins `>` against `>=`: here the kernel would reap the
    // backend at the same instant the grace runs out.
    //
    // `heartbeatMs: 0` makes the watch period 0 as well, so the budget is
    // 355 s grace + 0 s watch + 5 s confirm = 360 s, exactly the keepalive
    // window.
    const fake = fakePgPool(advisoryLockResponder({}))
    await expect(runDrillTick({
      pool: fake.pool,
      lockKey: 4242,
      heartbeatMs: 0,
      abortGraceMs: 355_000,
      drill: async () => {},
    })).rejects.toThrow(/is not longer than/)
  })

  it('counts the WATCH period into the budget, not just the grace', async () => {
    // The other cases run with a watch period of 0, so this one needs the watch
    // to contribute: 350 s grace + 15 s watch + 5 s confirm = 370 s, which the
    // 360 s window does not clear; without the watch term it would (355 s).
    const fake = fakePgPool(advisoryLockResponder({}))
    await expect(runDrillTick({
      pool: fake.pool,
      lockKey: 4242,
      heartbeatMs: 0,
      watchOwnershipMs: 15_000,
      abortGraceMs: 350_000,
      drill: async () => {},
    })).rejects.toThrow(/watch 15 s/)
  })

  it('says nothing when the belt did not land, because then the OS default applies', async () => {
    // `null` means the cluster is back to `tcp_keepalive_time` (typically
    // 7 200 s), so refusing the tick there would turn inert keepalive settings
    // into an outage.
    const fake = fakePgPool(advisoryLockResponder({ keepalives: 'inert' }))
    let drillRan = false
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: 4242,
      heartbeatMs: 0,
      abortGraceMs: 360_000,
      drill: async () => { drillRan = true },
    })
    expect(outcome.status).toBe('ran')
    expect(drillRan).toBe(true)
  })
})

/**
 * Losing the exclusion is a STOP, not a footnote.
 *
 * A drill whose key has been taken over must not carry on dumping alongside
 * whichever scheduler now holds it. Everything below distinguishes "the loss
 * was noticed" from "the drill was stopped".
 */
describe('drill tick — a lost exclusion stops the drill', () => {
  it('aborts the DRILL, not merely the verdict', async () => {
    // The discriminating assertion is `sawAbort`: `exclusive: false` alone would
    // also hold for a drill that kept running.
    let sawAbort = false
    const fake = fakePgPool(advisoryLockResponder({ held: () => false }))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 5,
      // Long enough that the deadline cannot be what stopped it.
      deadlineMs: 60_000,
      drill: (signal) => {
        signal.addEventListener('abort', () => { sawAbort = true }, { once: true })
        return stopsWhenAsked(signal)
      },
    })

    expect(sawAbort).toBe(true)
    expect(outcome).toEqual({ status: 'ran', exclusive: false, cutShortBy: 'lock-lost' })
    const requested = log.find('backup.drill_stop_requested')!
    expect(requested.reason).toBe('lock-lost')
    // Names WHICH loss. `not-owner` and `heartbeat-failed` mean different
    // incidents — somebody took the key, versus the cluster stopped answering —
    // and an operator cannot tell them apart from the stop alone.
    expect(requested.detail).toMatch(/not-owner/)
  })

  it('a drill that ignores the loss is abandoned, and the log does not blame the deadline', async () => {
    const spy = abandonSpy()
    const fake = fakePgPool(advisoryLockResponder({ held: () => false }))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 5,
      deadlineMs: 60_000,
      abortGraceMs: 40,
      drill: neverSettles,
      abandon: spy.abandon,
    })

    expect(outcome.status).toBe('abandoned')
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]!.reason).toBe('lock-lost')
    // The FENCING TOKEN travels with the report: `settleAbandonment` forwards it
    // to the kill, and without it the kill would rest on a recyclable pid.
    expect(spy.calls[0]!.backendStart).toBe('1787454350107573')
    expect(spy.calls[0]!.backendPid).toBe(4242)

    const abandoned = log.find('backup.drill_abandoned')!
    // The deadline wording would tell an operator the key is being held on
    // purpose — while a rival may already be dumping with it.
    expect(abandoned.detail).toMatch(/exclusion was lost/)
    expect(abandoned.detail).not.toMatch(/deliberately NOT released/)
    expect(abandoned.lockLoss).toBe('not-owner')
  })

  it('a deadline abandonment still says the key is held on purpose', async () => {
    // The other side of the same branch, so neither wording can be deleted
    // without a failure.
    const spy = abandonSpy()
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 20,
      abortGraceMs: 40,
      drill: neverSettles,
      abandon: spy.abandon,
    })

    expect(spy.calls[0]!.reason).toBe('deadline')
    const abandoned = log.find('backup.drill_abandoned')!
    expect(abandoned.detail).toMatch(/deliberately NOT released/)
    expect(abandoned.detail).not.toMatch(/exclusion was lost/)
    expect(abandoned.lockLoss).toBeNull()
  })

  it('a healthy heartbeat never aborts the drill', async () => {
    // Negative control: a stop wired to fire on every heartbeat would pass
    // every assertion above.
    let abortedForNoReason = false
    const fake = fakePgPool(advisoryLockResponder({}))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      deadlineMs: 60_000,
      drill: (signal) => {
        signal.addEventListener('abort', () => { abortedForNoReason = true }, { once: true })
        // Long enough for several heartbeats to have answered.
        return new Promise<void>((done) => { setTimeout(done, 40) })
      },
    })

    expect(abortedForNoReason).toBe(false)
    expect(outcome).toEqual({ status: 'ran', exclusive: true, cutShortBy: null })
    expect(log.names()).not.toContain('backup.drill_stop_requested')
  })

  it('waits the grace it REPORTS, not a multiple of it', async () => {
    // The report prints `graceMs` and the code waits `expiresIn(graceMs)`; the
    // other cases only check THAT abandonment happened, so this ties the two.
    const spy = abandonSpy()
    const fake = fakePgPool(advisoryLockResponder({}))
    const graceMs = 120
    const started = Date.now()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: recorder().log,
      heartbeatMs: 0,
      deadlineMs: 20,
      abortGraceMs: graceMs,
      drill: neverSettles,
      abandon: spy.abandon,
    })
    const elapsed = Date.now() - started

    expect(spy.calls[0]!.graceMs).toBe(graceMs)
    // Generous upper bound — this is a wall clock on a shared box — but far
    // below the 2 400 ms a 20x wait would take.
    expect(elapsed).toBeGreaterThanOrEqual(graceMs)
    expect(elapsed).toBeLessThan(graceMs * 8)
  })

  it('an inconclusive loss is ANSWERED by a second connection, and intact means carry on', async () => {
    // A failed heartbeat establishes nothing about who holds the key, so the
    // tick asks a DIFFERENT connection. Here it says the key is still ours — the
    // usual answer behind a broken socket, since a backend that has not noticed
    // its client is gone still holds the key.
    let toldToStop = false
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => true,
    }))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      deadlineMs: 60_000,
      drill: (signal) => {
        signal.addEventListener('abort', () => { toldToStop = true }, { once: true })
        return settle(() => log.names().includes('backup.drill_exclusion_unverified'))
      },
    })

    expect(log.find('db.advisory_lock_lost')).toMatchObject({ reason: 'heartbeat-failed' })
    expect(toldToStop).toBe(false)
    expect(outcome).toEqual({ status: 'ran', exclusive: false, cutShortBy: null })
    const line = log.find('backup.drill_exclusion_unverified')!
    expect(line).toMatchObject({
      reason: 'heartbeat-failed', confirmed: 'ours', fenced: true, runEnded: false,
    })
    // The SENTENCE, not only the code: it is what an operator reads, and each
    // verdict gets its own. Past tense — this is what ONE sample saw — and it
    // says the watch covers the rest of the run.
    expect(String(line.detail)).toMatch(/confirmed the exclusion was intact AT THAT MOMENT/)
    expect(String(line.detail)).toMatch(/one sample/)
    expect(String(line.detail)).toMatch(/watch keeps asking/)
    expect(log.names()).not.toContain('backup.drill_stop_requested')
    // A SECOND client: one is held by the lock for the run's duration.
    expect(fake.clients.length).toBeGreaterThanOrEqual(2)
    // The lock's own acquisition line carries the token an operator correlates
    // a later kill against.
    expect(log.find('db.advisory_lock_acquired')).toMatchObject({
      backendPid: 4242, backendStart: '1787454350107573',
    })
  })

  it('…and the same loss STOPS the drill when the second connection says the key is gone', async () => {
    // The other arm: the heartbeat established nothing, and an independent
    // connection establishes that the key is no longer ours.
    let toldToStop = false
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => false,
    }))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      deadlineMs: 60_000,
      drill: (signal) => {
        signal.addEventListener('abort', () => { toldToStop = true }, { once: true })
        return stopsWhenAsked(signal)
      },
    })

    expect(toldToStop).toBe(true)
    expect(outcome).toEqual({ status: 'ran', exclusive: false, cutShortBy: 'lock-lost' })
    const requested = log.find('backup.drill_stop_requested')!
    expect(requested.reason).toBe('lock-lost')
    // The message names WHO established it, because "the heartbeat said so" and
    // "a second connection checked" send an operator to different places.
    expect(requested.detail).toMatch(/an independent connection confirms/)
    expect(requested.detail).toMatch(/heartbeat reported heartbeat-failed/)
    // And it does NOT also log the too-late line (`confirmed: 'not-ours'`,
    // `actedOn: false`), which is reserved for answers that arrived after the
    // run ended.
    expect(log.names()).not.toContain('backup.drill_exclusion_unverified')
  })

  it('a second connection that can see the lock but not WHOSE it is stops nothing', async () => {
    // "I cannot read the session token" must not be read as "that is not the
    // holder" — that would stop and eventually abandon a healthy lock. Reachable
    // on a real cluster: a role that is not a member of the holder's sees the
    // `pg_locks` row and a NULL `backend_start`.
    let toldToStop = false
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => 'unreadable',
    }))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      deadlineMs: 60_000,
      drill: (signal) => {
        signal.addEventListener('abort', () => { toldToStop = true }, { once: true })
        return settle(() => log.names().includes('backup.drill_exclusion_unverified'))
      },
    })

    expect(toldToStop).toBe(false)
    expect(outcome).toEqual({ status: 'ran', exclusive: false, cutShortBy: null })
    const line = log.find('backup.drill_exclusion_unverified')!
    expect(line.confirmed).toBe('unknown')
    expect(String(line.checkError)).toMatch(/did not report backend_start/)
    // …and the sentence says the watch is STILL ASKING, which tells an operator
    // whether the rest of the run is being watched.
    expect(String(line.detail)).toMatch(/the watch keeps asking/)
    expect(log.names()).not.toContain('backup.drill_stop_requested')
  })

  it('asks on a client that carries an ERROR listener, which is a process death otherwise', async () => {
    // A client checked out by hand carries ZERO `'error'` listeners (pg-pool
    // removes its own at checkout and reinstalls it in `release()`), so a socket
    // reset during the statement would be an uncaught `ERR_UNHANDLED_ERROR` —
    // the container dying mid-`pg_dump`. `pool.query` attaches one for the
    // statement; `fakePgPool` models that `once('error', …)`, so the count drops
    // to 0 if the production code returns to a manual checkout.
    const fake = fakePgPool(advisoryLockResponder({ holder: () => true }))
    const log = recorder()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 60_000,
      drill: () => {
        fake.only.emit('error', new Error('read ECONNRESET'))
        return Promise.resolve()
      },
    })
    await settle(() => log.names().includes('backup.drill_exclusion_unverified'))

    // Client 0 is the lock's; client 1 is the one the question was asked on.
    expect(fake.clients.length).toBeGreaterThanOrEqual(2)
    const asked = fake.clients[1]!
    expect(asked.statements.length).toBeGreaterThanOrEqual(1)
    for (const statement of asked.statements) {
      expect(statement.errorListeners).toBeGreaterThanOrEqual(1)
    }
    // …and it went back to the pool.
    expect(asked.releases).toHaveLength(1)
  })

  it('says so at BOOT when the pool has no room to ask', async () => {
    // A pool without a second client silently switches the confirmation off
    // (it degrades to `unknown`, "carry on"), so the tick says so up front.
    const log = recorder()
    await runDrillTick({
      pool: fakePgPool(advisoryLockResponder({}), 1).pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      drill: () => Promise.resolve(),
    })

    expect(log.find('backup.drill_pool_too_small_to_confirm')).toMatchObject({ max: 1 })
  })

  it('and is SILENT about it on a pool that can', async () => {
    // Negative control: a warning that also fires on a correct configuration
    // is one an operator learns to skip.
    const log = recorder()
    await runDrillTick({
      pool: fakePgPool(advisoryLockResponder({}), 2).pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      drill: () => Promise.resolve(),
    })

    expect(log.names()).not.toContain('backup.drill_pool_too_small_to_confirm')
  })

  it('a second connection that cannot answer either changes nothing', async () => {
    // `unknown` is not a polite `not-ours`. Nothing was learned, so the run
    // continues — and says so.
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => new Error('terminating connection due to administrator command'),
    }))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      deadlineMs: 60_000,
      drill: () => settle(() => log.names().includes('backup.drill_exclusion_unverified')),
    })

    expect(outcome).toEqual({ status: 'ran', exclusive: false, cutShortBy: null })
    const line = log.find('backup.drill_exclusion_unverified')!
    expect(line).toMatchObject({
      confirmed: 'unknown',
      checkError: 'terminating connection due to administrator command',
      runEnded: false,
    })
    // The `unknown` sentence has two forms — still running, or already over.
    // This is the running one.
    expect(String(line.detail)).toMatch(/the run continues/)
    expect(String(line.detail)).not.toMatch(/had already ended/)
    expect(log.names()).not.toContain('backup.drill_stop_requested')
  })

  it('honours the confirmation ceiling it is given, and NAMES it', async () => {
    // `confirmOwnershipMs` is a public option; this proves it is not inert.
    // The ownership question never answers so the ceiling FIRES, and the number
    // ends up in the error message — discriminating without betting on
    // wall-clock timing.
    const responder = advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
    })
    const fake = fakePgPool((sql, values) => (sql.includes('pid_holds')
      ? new Promise<never>(() => {})
      : responder(sql, values)))
    const log = recorder()
    const started = Date.now()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      deadlineMs: 60_000,
      confirmOwnershipMs: 47,
      drill: () => settle(() => log.names().includes('backup.drill_exclusion_unverified')),
    })

    const line = log.find('backup.drill_exclusion_unverified')!
    expect(line.confirmed).toBe('unknown')
    expect(String(line.checkError)).toContain('within 47 ms')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('a DEAD SOCKET is confirmed the same way, and the answer still arrives', async () => {
    // `connection-error` has no tolerance at all — one `'error'` event — and the
    // lock's connection is the one a stateful firewall or NAT drops silently.
    //
    // This drill finishes IMMEDIATELY, before the answer can come back: the
    // answer must still be recorded once the run has ended.
    let toldToStop = false
    const fake = fakePgPool(advisoryLockResponder({ holder: () => true }))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 60_000,
      drill: (signal) => {
        signal.addEventListener('abort', () => { toldToStop = true }, { once: true })
        fake.only.emit('error', new Error('read ECONNRESET'))
        return Promise.resolve()
      },
    })

    expect(log.find('db.advisory_lock_lost')).toMatchObject({ reason: 'connection-error' })
    expect(toldToStop).toBe(false)
    expect(outcome).toEqual({ status: 'ran', exclusive: false, cutShortBy: null })
    await settle(() => log.names().includes('backup.drill_exclusion_unverified'))
    expect(log.find('backup.drill_exclusion_unverified')).toMatchObject({
      reason: 'connection-error', confirmed: 'ours', runEnded: true, actedOn: false,
    })
  })

  it('a loss confirmed too LATE is recorded rather than swallowed', async () => {
    // The exclusion HAD gone, and the answer came back after the run was over.
    // Acting is impossible; silence would make it look like a healthy run.
    const fake = fakePgPool(advisoryLockResponder({ holder: () => false }))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 60_000,
      drill: () => {
        fake.only.emit('error', new Error('read ECONNRESET'))
        return Promise.resolve()
      },
    })

    expect(outcome.status).toBe('ran')
    await settle(() => log.names().includes('backup.drill_exclusion_unverified'))
    expect(log.find('backup.drill_exclusion_unverified')).toMatchObject({
      confirmed: 'not-ours', runEnded: true, actedOn: false,
    })
    expect(log.find('backup.drill_exclusion_unverified')!.detail)
      .toMatch(/exclusion was GONE/)
  })

  it('an UNFENCED lock says so, rather than pretending the check was strict', async () => {
    // A cluster whose `pg_stat_activity` will not report `backend_start` gives
    // no session token, so every later question falls back to a pid the OS
    // reissues. Degrading is the right call — the alternative is a lock nobody
    // can take, i.e. no backups at all — but it must be VISIBLE, or the weaker
    // guarantee becomes an assumption.
    const fake = fakePgPool(advisoryLockResponder({ token: null, holder: () => true }))
    const log = recorder()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 0,
      deadlineMs: 60_000,
      drill: () => {
        fake.only.emit('error', new Error('read ECONNRESET'))
        return Promise.resolve()
      },
    })

    expect(log.find('db.advisory_lock_unfenced')).toMatchObject({ backendPid: 4242 })
    await settle(() => log.names().includes('backup.drill_exclusion_unverified'))
    expect(log.find('backup.drill_exclusion_unverified')).toMatchObject({ fenced: false })
  })

  it('the FIRST stop wins — a deadline after a loss does not rewrite the reason', async () => {
    // Both stops fire in this run: the loss at ~5 ms and the deadline at 25 ms,
    // while the drill refuses to settle. The reason an operator reads has to be
    // the one that actually cut the run short, and a `stop()` that overwrote it
    // would blame a clock for somebody else taking the key.
    const spy = abandonSpy()
    const fake = fakePgPool(advisoryLockResponder({ held: () => false }))
    const log = recorder()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 5,
      deadlineMs: 25,
      abortGraceMs: 60,
      drill: neverSettles,
      abandon: spy.abandon,
    })

    expect(spy.calls[0]!.reason).toBe('lock-lost')
    expect(log.events.filter(([name]) => name === 'backup.drill_stop_requested')).toHaveLength(1)
  })
})

/** Independent ownership questions actually put on the wire, across every
 *  client the pool handed out.
 *
 *  Counted from the STATEMENTS rather than the log, which is deliberately quiet
 *  after the first sample (a watch that stopped asking and one that kept asking
 *  silently log the same thing). `pid_holds` appears in no other statement the
 *  module issues. */
const independentChecks = (fake: ReturnType<typeof fakePgPool>): number =>
  fake.clients.reduce(
    (total, client) => total + client.statements.filter((s) => s.sql.includes('pid_holds')).length,
    0,
  )

describe('drill tick — the exclusion is watched for the WHOLE run', () => {
  it('a takeover the FIRST check could not see still stops the drill', async () => {
    // The first two samples say the key is intact and the third says it is
    // gone. A single-shot check would answer `ours` and let the drill dump
    // alongside whichever scheduler now holds the key until the deadline.
    let asked = 0
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => { asked += 1; return asked < 3 },
    }))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      watchOwnershipMs: 2,
      deadlineMs: 60_000,
      drill: stopsWhenAsked,
    })

    // The first sample was `ours` and did NOT stop anything — otherwise this
    // test would also pass for a build that stops on the first answer.
    expect(log.find('backup.drill_exclusion_unverified')).toMatchObject({
      confirmed: 'ours', runEnded: false, samples: 1,
    })
    expect(outcome).toEqual({ status: 'ran', exclusive: false, cutShortBy: 'lock-lost' })
    const requested = log.find('backup.drill_stop_requested')!
    expect(requested.reason).toBe('lock-lost')
    // WHICH sample established it, so an operator knows when in the run.
    expect(String(requested.detail)).toMatch(/established on independent check 3/)
    expect(independentChecks(fake)).toBe(3)
  })

  it('stops asking when the run ends, rather than outliving the pool', async () => {
    // The watch has to STOP: `drillScheduler` calls `lockPool.end()` the moment
    // the tick returns, and pg-pool's `end()` waits for every client with no
    // timer of its own, so a sample armed after the tick returned would hang the
    // scheduler's `finally`.
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => true,
    }))
    const log = recorder()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      watchOwnershipMs: 1,
      deadlineMs: 60_000,
      drill: () => settle(() => log.names().includes('backup.drill_exclusion_unverified')),
    })

    const atReturn = independentChecks(fake)
    expect(atReturn).toBeGreaterThanOrEqual(1)
    // A watch still running at 1 ms would add ~100 over this window.
    await new Promise((resolve) => setTimeout(resolve, 120))
    // `+ 1` and not `+ 0`: a sample already in flight when the tick returned is
    // allowed to finish — the wait ceiling does not cancel the statement.
    expect(independentChecks(fake)).toBeLessThanOrEqual(atReturn + 1)
  })

  it('an UNANSWERED exclusion question gives its client back', async () => {
    // The watch abandons the WAIT, but `pool.query` keeps running, and pg-pool
    // returns a client only when the statement answers or its socket errors. A
    // question that never answers would hold a client for `tcp_retries2`
    // (~15 min), and ONE un-returned client makes `pool.end()` never resolve
    // (the scheduler logs `backup.drill_lock_pool_end_timeout`). Single-flight
    // alone still leaves one client out; the statement is bounded with
    // `query_timeout`, which pg does enforce.
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      // The independent question never answers, as on a black-holed socket.
      holder: () => new Promise<boolean>(() => {}),
    }))
    const log = recorder()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      watchOwnershipMs: 3,
      confirmOwnershipMs: 20,
      deadlineMs: 60_000,
      drill: () => settle(() => log.names().includes('backup.drill_exclusion_unverified')),
    })

    // The question really was asked and really did go unanswered — without this
    // the assertion below passes vacuously against a build that never asks.
    expect(log.find('backup.drill_exclusion_unverified')).toBeDefined()
    expect(fake.clients.length, 'no client was ever checked out').toBeGreaterThan(0)
    // Every client back, so `lockPool.end()` can resolve.
    expect(
      fake.clients.filter((client) => !client.isReleased),
      'a client was not given back — pool.end() will never resolve',
    ).toEqual([])
  })

  it('a period of 0 takes exactly ONE sample, and the sentence says so', async () => {
    // `heartbeatMs: 0` means "generate no traffic on this key", and a watch is
    // traffic; a caller that asked for silence must not get 1 440 queries a run.
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => true,
    }))
    const log = recorder()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      watchOwnershipMs: 0,
      deadlineMs: 60_000,
      drill: async () => {
        await settle(() => log.names().includes('backup.drill_exclusion_unverified'))
        await new Promise((resolve) => setTimeout(resolve, 60))
      },
    })

    expect(independentChecks(fake)).toBe(1)
    // And the operator is told, in the same line, that nothing is watching.
    expect(String(log.find('backup.drill_exclusion_unverified')!.detail))
      .toMatch(/watch is disabled/)
  })

  it('inherits the heartbeat cadence, and lets a caller override it', async () => {
    // The watch IS the heartbeat, moved onto a connection that still works, so
    // it takes the heartbeat's period. Two runs, one variable.
    const build = (): ReturnType<typeof fakePgPool> => fakePgPool(advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => true,
    }))

    const inherited = build()
    const inheritedLog = recorder()
    await runDrillTick({
      pool: inherited.pool,
      lockKey: KEY,
      log: inheritedLog.log,
      heartbeatMs: 2,
      deadlineMs: 60_000,
      // Waits for the THIRD sample rather than for a duration: a machine that is
      // slow makes this wait longer, never makes it wrong.
      drill: () => settle(() => independentChecks(inherited) >= 3),
    })
    expect(independentChecks(inherited)).toBeGreaterThanOrEqual(3)

    const overridden = build()
    const overriddenLog = recorder()
    await runDrillTick({
      pool: overridden.pool,
      lockKey: KEY,
      log: overriddenLog.log,
      heartbeatMs: 2,
      // A second full of period against a run measured in tens of milliseconds.
      // The assertion is that the SECOND sample has not happened yet, which a
      // slow machine only makes more true.
      watchOwnershipMs: 1_000,
      deadlineMs: 60_000,
      drill: async () => {
        await settle(() => independentChecks(overridden) >= 1)
        await new Promise((resolve) => setTimeout(resolve, 80))
      },
    })
    expect(independentChecks(overridden)).toBe(1)
  })

  it('logs a CHANGE of answer once, not a line per sample', async () => {
    // A line per sample would be 1 440 lines on a six-hour run. The watch prints
    // the first sample, each change, and a summary whose counts carry what the
    // suppressed lines would have said.
    let asked = 0
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => { asked += 1; return asked === 1 ? true : 'unreadable' },
    }))
    const log = recorder()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      watchOwnershipMs: 1,
      deadlineMs: 60_000,
      drill: () => settle(() => independentChecks(fake) >= 4),
    })

    expect(log.find('backup.drill_exclusion_unverified')).toMatchObject({ confirmed: 'ours' })
    const changes = log.events.filter(([name]) => name === 'backup.drill_exclusion_changed')
    expect(changes).toHaveLength(1)
    expect(changes[0]![1]).toMatchObject({ confirmed: 'unknown', samples: 2 })

    // The summary is published by the watch's CALLER after the pass ends, so it
    // can land just after the tick returns.
    await settle(() => log.names().includes('backup.drill_exclusion_watch_ended'))
    const ended = log.find('backup.drill_exclusion_watch_ended')!
    expect(ended).toMatchObject({ ours: 1, notOurs: 0, last: 'unknown', reason: 'heartbeat-failed' })
    // The counts are what distinguish two runs with the same `last`.
    expect(Number(ended.unknown)).toBeGreaterThanOrEqual(3)
    expect(Number(ended.samples)).toBe(Number(ended.ours) + Number(ended.unknown))
    // EXACTLY one: neither the first sample nor every sample counts as a change.
    expect(ended.changes).toBe(1)
    expect(ended.changesSuppressed).toBe(0)
    // Relative to the run's start: neither null nor an absolute epoch.
    expect(ended.lastAtMs).not.toBeNull()
    expect(Number(ended.lastAtMs)).toBeLessThan(60_000)
  })

  it('carries what the watch saw, and HOW OLD it is, into the abandonment', async () => {
    // `lockWatch.verdict` is what the watch knew; `ageMs` keeps it from
    // over-claiming, because the watch stops when the run stops and its last
    // sample can be a whole grace period old by the time the report is written.
    const spy = abandonSpy()
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => true,
    }))
    const log = recorder()
    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      watchOwnershipMs: 2,
      deadlineMs: 40,
      abortGraceMs: 40,
      drill: neverSettles,
      abandon: spy.abandon,
    })

    expect(outcome.status).toBe('abandoned')
    const report = spy.calls[0]!
    expect(report.lockWatch.verdict).toBe('ours')
    expect(report.lockLoss).toBe('heartbeat-failed')
    expect(report.lockWatch.fenced).toBe(true)
    // More than one: the watch's samples PLUS the final one taken as the
    // abandonment is declared.
    expect(report.lockWatch.checks).toBeGreaterThan(1)
    // FRESH, not merely present: `detach()` stops the watch before the grace,
    // so without the final sample this would be at least a whole
    // `abortGraceMs` old.
    expect(report.lockWatch.ageMs).toBeLessThan(40)
  })

  it('publishes its summary when the run ends, not one period later', async () => {
    // Why `stopWatch()` wakes the nap instead of only setting a flag: otherwise
    // the summary lands a full period late, and on the abandonment path the
    // process exit can arrive first and lose it.
    //
    // Twenty seconds of period against a two-second wait: the summary did NOT
    // wait for the nap.
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => true,
    }))
    const log = recorder()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      watchOwnershipMs: 20_000,
      deadlineMs: 60_000,
      drill: () => settle(() => independentChecks(fake) >= 1),
    })

    await settle(() => log.names().includes('backup.drill_exclusion_watch_ended'), 2_000)
    expect(log.names()).toContain('backup.drill_exclusion_watch_ended')
    expect(log.find('backup.drill_exclusion_watch_ended')).toMatchObject({ samples: 1, ours: 1 })
  })

  it('never queues a second question behind one the cluster has not answered', async () => {
    // Overlapping samples would queue on the pool: the next sample's connect
    // request waits out `connectionTimeoutMillis`, and when `lock.release()`
    // hands the lock's own client back, that stale request takes it and issues
    // a fresh statement on the connection `pool.end()` was about to close.
    //
    // An unanswered question does end (the statement is bounded by
    // `query_timeout`) and the watch may then ask again, so the invariant is
    // "never two questions on the pool at once", asserted by concurrency rather
    // than by a total.
    let asked = 0
    let peakHeld = 0
    const base = advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
    })
    const responder: FakeResponder = (sql, values) => {
      if (sql.includes('pid_holds')) {
        asked += 1
        // Measured from the POOL (checked-out-and-unreleased), not from a
        // counter here: this responder's promise never settles even though the
        // query does, so a local counter would count totals. The lock's client
        // plus this question's makes 2 the healthy peak; 3 would mean a second
        // question opened while one was still outstanding.
        peakHeld = Math.max(peakHeld, fake.clients.filter((client) => !client.isReleased).length)
        // Never answers, like a statement on a black-holed socket. The statement
        // ceiling is what ends it; this responder never does.
        return new Promise<FakeQueryResult>(() => {})
      }
      return base(sql, values)
    }
    const fake = fakePgPool(responder)
    const log = recorder()

    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      watchOwnershipMs: 1,
      confirmOwnershipMs: 5,
      deadlineMs: 60_000,
      // Long enough for many samples to have been attempted.
      drill: () => settle(() => log.events.filter(([n]) => n === 'backup.drill_exclusion_unverified').length >= 1)
        .then(() => new Promise<void>((done) => { setTimeout(done, 120) })),
    })

    // NEVER TWO QUESTIONS ON THE POOL AT ONCE, however many times the watch
    // came round.
    expect(peakHeld, 'a second question was opened while one was still outstanding')
      .toBeLessThanOrEqual(2)
    expect(asked, 'the watch never asked at all — the assertion above is vacuous').toBeGreaterThan(0)
    // ...AND EVERY CLIENT CAME BACK: one un-returned client makes `pool.end()`
    // never resolve.
    //
    // AWAITED rather than instant: a question in flight when the tick returned
    // holds its client until the statement ceiling fires, and that bound is
    // what is being tested.
    await settle(() => fake.clients.every((client) => client.isReleased))
    expect(
      fake.clients.filter((client) => !client.isReleased),
      'a client was not given back — pool.end() will never resolve',
    ).toEqual([])
    // The first sample reports the ceiling; every later one reports that it did
    // not queue. Both are `unknown` — nothing was established — and the error
    // is what tells an operator which.
    const first = log.find('backup.drill_exclusion_unverified')!
    expect(first.confirmed).toBe('unknown')
    expect(String(first.checkError)).toMatch(/did not answer within 5 ms/)
    await settle(() => log.names().includes('backup.drill_exclusion_watch_ended'))
    const ended = log.find('backup.drill_exclusion_watch_ended')!
    expect(Number(ended.samples)).toBeGreaterThan(1)
    // SINGLE-FLIGHT STILL ENGAGES, counted rather than read off a message (which
    // sample lands last is timing-dependent). Every tick takes a sample; only a
    // tick that finds no question outstanding puts a STATEMENT on the wire, so
    // samples exceeding statements means some ticks were refused.
    //
    // This depends on the statement ceiling being strictly LONGER than the wait
    // ceiling: the wait expires at 5 ms while the question stays outstanding to
    // 20 ms, so the 1 ms ticks in between are refused.
    expect(
      Number(ended.samples),
      'every tick put a new statement on the wire — single-flight is not engaging',
    ).toBeGreaterThan(asked)
    // THE VERDICT: a question nobody answered must never read as "the
    // exclusion is confirmed intact". That value feeds `watch.ours`,
    // `watch.last` and `lockWatch.verdict`, which `lockSentence` renders into
    // the signed drill report.
    expect(ended.last).toBe('unknown')
    expect(Number(ended.ours)).toBe(0)
    expect(Number(ended.notOurs)).toBe(0)
    // NULL: no sample ever came back, so there is no instant to date the
    // evidence to. Zero would read as "answered at the very start".
    expect(ended.lastAtMs).toBeNull()
  })

  it('does not let an unanswered final question DATE itself as fresh evidence', async () => {
    // `recordSample` must stamp the evidence clock only on a conclusive answer,
    // not on every attempt (including the single-flight placeholder that never
    // reaches the database); otherwise an abandonment whose final question
    // could not be asked would report "unknown, 2 ms old" for stale evidence.
    const base = advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
    })
    const responder: FakeResponder = (sql, values) => {
      // Never answers — so the watch's first sample is still outstanding when
      // the abandonment declares, and single-flight answers without asking.
      if (sql.includes('pid_holds')) return new Promise<FakeQueryResult>(() => {})
      return base(sql, values)
    }
    const fake = fakePgPool(responder)
    const spy = abandonSpy()
    const log = recorder()

    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      watchOwnershipMs: 5,
      confirmOwnershipMs: 5,
      deadlineMs: 60,
      abortGraceMs: 60,
      drill: neverSettles,
      abandon: spy.abandon,
    })

    const report = spy.calls[0]!
    expect(report.lockWatch.verdict).toBe('unknown')
    // Nothing ever answered, so the evidence is as old as the RUN — not two
    // milliseconds old because a placeholder was just constructed.
    expect(report.lockWatch.ageMs).toBeGreaterThanOrEqual(60)
    // And it was still counted as an attempt: "we asked" and "we were told" are
    // separate facts, and this is the one where they differ.
    expect(report.lockWatch.checks).toBeGreaterThan(1)
    // The abandonment must not BYPASS single-flight to get a fresher answer:
    // its final sample has to reuse an outstanding question rather than opening
    // a second one beside it.
    //
    // A bound rather than `=== 1`: an unanswered statement ends and gives its
    // client back, so over a run the watch legitimately asks more than once.
    expect(independentChecks(fake)).toBeGreaterThan(0)
    // EXACTLY ONE client stays out on this path, and it is the LOCK's — held
    // deliberately, since an abandoned tick still holds the key until the
    // process ends (`drillScheduler`'s `abandonAndExit`). The QUESTION's client
    // must not be a second one beside it.
    //
    // AWAITED, because a question still in flight when the abandonment declared
    // holds its client until the statement ceiling fires.
    await settle(() => fake.clients.filter((client) => !client.isReleased).length <= 1)
    expect(
      fake.clients.filter((client) => !client.isReleased).length,
      'more than the lock client was left out — an exclusion question leaked one too',
    ).toBe(1)
  })

  it('reports an UNFENCED verdict as unfenced in the abandonment, not only in the log', async () => {
    // The renderings of fenced/unfenced are covered in `drillAbandonment`; this
    // pins the PRODUCER, so a verdict resting on a reissuable pid is never
    // reported as token-fenced.
    const spy = abandonSpy()
    const fake = fakePgPool(advisoryLockResponder({
      // The cluster would not report `backend_start`, so the lock degrades to
      // pid-only. Reachable: another role sees exactly that.
      token: null,
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => true,
    }))
    const log = recorder()

    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      watchOwnershipMs: 5,
      deadlineMs: 50,
      abortGraceMs: 50,
      drill: neverSettles,
      abandon: spy.abandon,
    })

    expect(log.names()).toContain('db.advisory_lock_unfenced')
    expect(spy.calls[0]!.lockWatch.fenced).toBe(false)
    expect(spy.calls[0]!.backendStart).toBeNull()
  })

  it('does not promise surveillance to a sample that lands after the run ended', async () => {
    // A first sample still in flight when the drill finishes answers `ours`;
    // the line must not claim "the watch keeps asking" beside `runEnded: true`.
    let asked = 0
    let answerFirst!: (answer: FakeQueryResult) => void
    const firstAnswer = new Promise<FakeQueryResult>((resolve) => { answerFirst = resolve })
    const base = advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
    })
    const responder: FakeResponder = (sql, values) => {
      if (sql.includes('pid_holds')) {
        asked += 1
        if (asked === 1) return firstAnswer
      }
      return base(sql, values)
    }
    const fake = fakePgPool(responder)
    const log = recorder()

    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      // Configured, but irrelevant once the run has ended.
      watchOwnershipMs: 5,
      deadlineMs: 60_000,
      drill: () => settle(() => asked >= 1),
    })
    expect(outcome).toEqual({ status: 'ran', exclusive: false, cutShortBy: null })

    answerFirst({ rows: [{ pid_holds: true, token: DEFAULT_FAKE_TOKEN }] })
    await settle(() => log.names().includes('backup.drill_exclusion_unverified'))

    const line = log.find('backup.drill_exclusion_unverified')!
    expect(line).toMatchObject({ confirmed: 'ours', runEnded: true, samples: 1 })
    expect(String(line.detail)).toMatch(/the run had already ended when this answer arrived/)
    // The two sentences it must NOT be: the surveillance promise, and the
    // "watch is disabled" one — the watch was configured, the run just ended.
    expect(String(line.detail)).not.toMatch(/keeps asking/)
    expect(String(line.detail)).not.toMatch(/watch is disabled/)
  })

  it('knows a run is over because it was STOPPED, not only because it settled', async () => {
    // `stillRunning` is `!settled && cutShortBy === null`; this pins the second
    // half. The deadline fires, the drill has not settled (that is what an
    // abandonment IS), and a sample answers afterwards: the line must read
    // `runEnded: true`, not promise that the watch keeps asking.
    const spy = abandonSpy()
    let answerFirst!: (answer: FakeQueryResult) => void
    const firstAnswer = new Promise<FakeQueryResult>((resolve) => { answerFirst = resolve })
    let asked = 0
    const base = advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
    })
    const responder: FakeResponder = (sql, values) => {
      if (sql.includes('pid_holds')) {
        asked += 1
        if (asked === 1) return firstAnswer
      }
      return base(sql, values)
    }
    const fake = fakePgPool(responder)
    const log = recorder()

    // Not awaited: the sample has to answer DURING the grace, while the drill
    // has been told to stop and has not settled. After the abandonment the
    // final check would already have taken the first-sample slot, and this test
    // is about the watch's own sample.
    const running = runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      watchOwnershipMs: 5,
      confirmOwnershipMs: 60_000,
      deadlineMs: 40,
      abortGraceMs: 2_000,
      drill: neverSettles,
      abandon: spy.abandon,
    })

    await settle(() => log.names().includes('backup.drill_stop_requested'))
    expect(log.find('backup.drill_stop_requested')).toMatchObject({ reason: 'deadline' })
    // Here `settled` is FALSE — the drill never settles — and `cutShortBy` is
    // 'deadline': only the second clause detects that the run is over.
    answerFirst({ rows: [{ pid_holds: true, token: DEFAULT_FAKE_TOKEN }] })
    await settle(() => log.names().includes('backup.drill_exclusion_unverified'))

    const line = log.find('backup.drill_exclusion_unverified')!
    expect(line).toMatchObject({ confirmed: 'ours', runEnded: true })
    expect(String(line.detail)).toMatch(/the run had already ended when this answer arrived/)
    expect(String(line.detail)).not.toMatch(/keeps asking/)
    // And it did not stop anything — a stop here would overwrite the reason an
    // operator is about to read.
    expect(log.events.filter(([n]) => n === 'backup.drill_stop_requested')).toHaveLength(1)

    expect((await running).status).toBe('abandoned')
  })

  it('keeps its default cadence tied to the heartbeat it continues', () => {
    // The watch continues the heartbeat, so their default periods must match.
    expect(DEFAULT_EXCLUSION_WATCH_MS).toBe(DEFAULT_HEARTBEAT_MS)
  })

  it('caps its change lines, and says how many it swallowed', async () => {
    // A connection alternating between answering and not answering changes on
    // every sample, so logging on change alone would emit a line per sample.
    let asked = 0
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => { asked += 1; return asked % 2 === 0 ? true : 'unreadable' },
    }))
    const log = recorder()

    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      watchOwnershipMs: 1,
      deadlineMs: 60_000,
      drill: () => settle(() => independentChecks(fake) >= 30),
    })

    const changes = log.events.filter(([name]) => name === 'backup.drill_exclusion_changed')
    expect(changes.length).toBeLessThanOrEqual(20)
    await settle(() => log.names().includes('backup.drill_exclusion_watch_ended'))
    const ended = log.find('backup.drill_exclusion_watch_ended')!
    // NOT silently truncated: the total and the shortfall are both reported.
    expect(Number(ended.changes)).toBeGreaterThan(changes.length)
    expect(Number(ended.changesSuppressed)).toBe(Number(ended.changes) - changes.length)
  })

  it('records a LATER sample that answers after the run has ended', async () => {
    // The "confirmed too late" case above has the late answer on sample ONE, so
    // `first` alone logs it. This pins the `|| verdict === 'not-ours'` clause:
    // with a watch, the sample in flight when the drill finishes is usually not
    // the first, and silencing it loses the only evidence the exclusion had gone.
    let asked = 0
    let answerSecond!: (answer: FakeQueryResult) => void
    const secondAnswer = new Promise<FakeQueryResult>((resolve) => { answerSecond = resolve })
    const base = advisoryLockResponder({
      held: () => { throw new Error('canceling statement due to statement timeout') },
      holder: () => true,
    })
    const responder: FakeResponder = (sql, values) => {
      if (sql.includes('pid_holds')) {
        asked += 1
        // Sample 2 is held open until the run is over, which is how a real one
        // ends up answering into a tick that has already returned.
        if (asked === 2) return secondAnswer
      }
      return base(sql, values)
    }
    const fake = fakePgPool(responder)
    const log = recorder()

    const outcome = await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      watchOwnershipMs: 1,
      deadlineMs: 60_000,
      drill: () => settle(() => asked >= 2),
    })
    // The run finished normally: nothing had been established against it yet.
    expect(outcome).toEqual({ status: 'ran', exclusive: false, cutShortBy: null })
    expect(log.events.filter(([name]) => name === 'backup.drill_exclusion_unverified'))
      .toHaveLength(1)

    // …and now the answer arrives.
    answerSecond({ rows: [{ pid_holds: false, token: DEFAULT_FAKE_TOKEN }] })
    await settle(() => log.events.filter(([n]) => n === 'backup.drill_exclusion_unverified').length >= 2)

    const lines = log.events.filter(([name]) => name === 'backup.drill_exclusion_unverified')
    expect(lines).toHaveLength(2)
    expect(lines[1]![1]).toMatchObject({
      confirmed: 'not-ours',
      // The exclusion HAD gone and nothing could act.
      actedOn: false,
      runEnded: true,
      samples: 2,
    })
    expect(String(lines[1]![1].detail)).toMatch(/arrived after the run had already ended/)
    // And it did NOT stop a run that was already over.
    expect(log.names()).not.toContain('backup.drill_stop_requested')
  })

  it('starts no watch for a loss that was already an answer, and still samples once at the end', async () => {
    // `not-owner` is an ANSWER on the lock's own connection — `pg_locks` asked
    // about `pg_backend_pid()`, so no pid reuse can explain it — and it stops
    // the drill immediately. No watch is started, and none should be: the
    // question is settled.
    //
    // The abandonment still takes its ONE final sample, so the signed report
    // carries independent evidence on this path too.
    const spy = abandonSpy()
    const fake = fakePgPool(advisoryLockResponder({ held: () => false, holder: () => false }))
    const log = recorder()
    await runDrillTick({
      pool: fake.pool,
      lockKey: KEY,
      log: log.log,
      heartbeatMs: 3,
      deadlineMs: 60_000,
      abortGraceMs: 40,
      drill: neverSettles,
      abandon: spy.abandon,
    })

    const report = spy.calls[0]!
    expect(report.reason).toBe('lock-lost')
    expect(report.lockLoss).toBe('not-owner')
    // EXACTLY one, and that is two assertions in one number: the watch never
    // ran (it would have taken several at this cadence), and the abandonment
    // did sample.
    expect(report.lockWatch.checks).toBe(1)
    expect(independentChecks(fake)).toBe(1)
    expect(report.lockWatch.verdict).toBe('not-ours')
    // No watch means no watch lines — the loop never started.
    expect(log.names()).not.toContain('backup.drill_exclusion_unverified')
    expect(log.names()).not.toContain('backup.drill_exclusion_watch_ended')
  })
})
