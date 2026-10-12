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
  acquireSessionAdvisoryLock,
  advisoryLockHeldByThisSession,
  checkAdvisoryLockOwnership,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_KEEPALIVES,
  DEFAULT_TERMINATION_CEILING_MS,
  DEFAULT_TERMINATION_POLL_MS,
  terminateAdvisoryLockHolder,
  type AdvisoryLockKeepalives,
  type AdvisoryLockQueryRunner,
} from './sessionAdvisoryLock.js'
import { advisoryLockResponder, fakePgPool } from '../testing/fakePgPool.js'

/**
 * The state machine and the resource discipline. Everything that is a claim
 * about POSTGRES — the lock-tag decode, a session lock dying with its backend,
 * `pg_advisory_unlock` answering `false` instead of raising — lives in
 * `sessionAdvisoryLock.integration.test.ts` against a real cluster, because a
 * fake would agree with any implementation of those.
 *
 * The fake (`src/testing/fakePgPool.ts`) is deliberately STRICTER than the real
 * pool where the real pool is strict: it is identity-sensitive on
 * `on`/`off`, it throws on a double release and on a query after release, and
 * it refuses to emit `'error'` with nobody listening.
 */

const KEY = 1234

/** A plausible fencing token — sixteen digits, like real epoch microseconds. */
const TOKEN = '1787454350107573'

/** A cheap deadline so a broken expectation fails as an assertion rather than
 *  as a suite timeout that names nothing. */
const settle = async (predicate: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface Collected {
  readonly events: Array<[string, Record<string, unknown>]>
  readonly sink: (event: string, fields: Record<string, unknown>) => void
}

function collect(): Collected {
  const events: Array<[string, Record<string, unknown>]> = []
  return { events, sink: (event, fields) => { events.push([event, fields]) } }
}

describe('session advisory lock — the client is never lost and never unguarded', () => {
  it('asks for the lock and the backend pid in ONE statement', async () => {
    // Not a micro-optimisation. Two statements would open a window in which
    // the lock is taken but no handle exists yet: a connection dying there
    // leaks the client FOREVER, and a leaked checked-out client makes
    // `pool.end()` never resolve — a scheduler that stops running with a live
    // process and a calm log.
    const fake = fakePgPool(advisoryLockResponder({}))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0 })
    const beforeHandle = fake.only.statements.filter((s) => !s.sql.includes('pg_advisory_unlock'))
    expect(beforeHandle).toHaveLength(1)
    expect(beforeHandle[0]!.sql).toContain('pg_try_advisory_lock')
    expect(beforeHandle[0]!.sql).toContain('pg_backend_pid')
    expect(lock!.backendPid).toBe(4242)
    await lock!.release()
  })

  it('never runs a statement on a client with no error listener', async () => {
    // ZERO listeners is a process death, not a warning: pg-pool removes its own
    // at checkout and `Client._handleErrorEvent` emits unconditionally, so a
    // socket reset during an unguarded statement is an uncaught
    // ERR_UNHANDLED_ERROR — and the drill scheduler is a standalone entrypoint
    // with no `uncaughtException` handler.
    const fake = fakePgPool(advisoryLockResponder({}))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 5 })
    await settle(() => fake.only.statements.some((s) => s.sql.includes('pg_locks')))
    await lock!.release()

    expect(fake.only.statements.length).toBeGreaterThanOrEqual(3)
    for (const statement of fake.only.statements) {
      expect(statement.errorListeners).toBeGreaterThanOrEqual(1)
    }
    // And the listener was still attached AT release: pg-pool reinstalls its
    // own as the first act of `release()`, so removing ours before that is what
    // opens the gap the unlock statement runs in.
    expect(fake.only.releaseErrorListeners).toEqual([1])
  })

  it('hands the client back when the lock is not acquired', async () => {
    // A pool of one whose single client is retained on the "somebody else has
    // it" path makes the NEXT tick wait `connectionTimeoutMillis` and fail, on
    // a scheduler that was working perfectly.
    const fake = fakePgPool(advisoryLockResponder({ locked: false }))
    expect(await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0 })).toBeNull()
    expect(fake.only.releases).toHaveLength(1)
  })

  it('hands the client back — DESTROYED — when the acquiring statement fails', async () => {
    const fake = fakePgPool(advisoryLockResponder({ acquireError: new Error('connection terminated') }))
    await expect(acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0 }))
      .rejects.toThrow('connection terminated')
    expect(fake.only.releases).toHaveLength(1)
    // Whether the lock was taken went with the connection. Destroying the
    // client ends the session, which is the only way to release a lock that no
    // handle will ever exist to release.
    expect(fake.only.releases[0]).toBeInstanceOf(Error)
  })

  it('refuses a backend pid it could not read rather than reporting zero', async () => {
    // `backendPid: 0` would travel into `db.advisory_lock_acquired` and
    // `backup.drill_ran_without_exclusion` as a fact, sending an operator to
    // grep `pg_stat_activity` for a backend that cannot exist.
    const fake = fakePgPool((sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true, pid: null }] }
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] }
      return undefined
    })
    await expect(acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0 }))
      .rejects.toThrow(/pg_backend_pid\(\) answered/)
    expect(fake.only.releases).toHaveLength(1)
  })

  it('refuses a key it cannot decode, on BOTH exported entry points', async () => {
    const fake = fakePgPool(advisoryLockResponder({}))
    await expect(acquireSessionAdvisoryLock(fake.pool, 2 ** 60, { heartbeatMs: 0 }))
      .rejects.toThrow(/safe integer/)
    expect(fake.clients).toHaveLength(0)
    // The ownership question is exported for callers that hold a lock some
    // other way; without the guard they get Postgres's `invalid input syntax
    // for type bigint` instead of a message naming what is wrong.
    await expect(advisoryLockHeldByThisSession({ query: async () => ({ rows: [] }) } as never, 2 ** 60))
      .rejects.toThrow(/safe integer/)
  })
})

describe('session advisory lock — losing it is an event with a reason', () => {
  it('a heartbeat that sees another owner loses it at once', async () => {
    // A NEGATIVE answer is acted on immediately: pg_locks was asked and said no.
    let answers = 0
    const { events, sink } = collect()
    const fake = fakePgPool(advisoryLockResponder({ held: () => (answers++ > 0 ? false : true) }))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 5, onEvent: sink })
    await settle(() => lock!.signal.aborted)

    expect(lock!.loss()).toMatchObject({ reason: 'not-owner' })
    expect(events.map(([name]) => name)).toEqual(['db.advisory_lock_acquired', 'db.advisory_lock_lost'])
    await lock!.release()
  })

  it('ONE unanswered probe is not a loss, and TWO are', async () => {
    // The policy this pins, because it is a judgement rather than a mechanism:
    // a probe that could not be answered is not evidence somebody took the key,
    // it is evidence nothing was learned. Declaring a loss on the first one
    // makes every database hiccup print "this run may not have been exclusive",
    // and an alarm that cries on healthy runs hides the real event.
    let probes = 0
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { probes += 1; throw new Error('canceling statement due to user request') },
    }))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 5 })

    await settle(() => probes >= 1)
    expect(lock!.loss()).toBeNull()

    await settle(() => lock!.signal.aborted)
    expect(lock!.loss()).toMatchObject({ reason: 'heartbeat-failed' })
    expect(lock!.loss()!.detail).toMatch(/2 consecutive unanswered probes/)
    await lock!.release()
  })

  it('a probe that answers again clears the count', async () => {
    const outcomes = [false, true, false, true, false, true]
    let index = 0
    const fake = fakePgPool(advisoryLockResponder({
      held: () => {
        const ok = outcomes[index % outcomes.length]
        index += 1
        if (!ok) throw new Error('transient')
        return true
      },
    }))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 5 })
    await settle(() => index >= 6)
    // Alternating fail/succeed never reaches two CONSECUTIVE failures.
    expect(lock!.loss()).toBeNull()
    expect(lock!.signal.aborted).toBe(false)
    await lock!.release()
  })

  it('a probe that never answers is unanswered, not awaited forever', async () => {
    // Without a ceiling the claimed detection window is fiction on the failure
    // it exists for: a connection black-holed by a stateful firewall produces
    // neither error nor answer, and the kernel retransmits until
    // `tcp_retries2` — about FIFTEEN MINUTES on Linux by default.
    const fake = fakePgPool(advisoryLockResponder({ held: () => new Promise<boolean>(() => {}) }))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 20 })
    await settle(() => lock!.signal.aborted, 4_000)

    expect(lock!.loss()).toMatchObject({ reason: 'heartbeat-failed' })
    expect(lock!.loss()!.detail).toMatch(/unanswered after 20 ms/)
    await lock!.release()
  })

  it('a dead socket is reported as a CONNECTION error, distinguishably', async () => {
    // Deterministic on purpose. The integration test that kills a backend has
    // to accept either `connection-error` or `heartbeat-failed` because the
    // socket error and the next probe race — so without this case the two
    // values would be interchangeable everywhere in the tree.
    const fake = fakePgPool(advisoryLockResponder({}))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0 })
    fake.only.emit('error', new Error('read ECONNRESET'))

    expect(lock!.loss()).toMatchObject({ reason: 'connection-error', detail: 'read ECONNRESET' })
    expect(lock!.signal.aborted).toBe(true)
    await lock!.release()
  })

  it('keeps the FIRST observation when a second arrives', async () => {
    // Otherwise a socket dying a second after pg_locks already said somebody
    // else owns the key rewrites the reason with a downstream symptom, moves
    // the timing, and emits `db.advisory_lock_lost` twice for one loss.
    const { events, sink } = collect()
    const fake = fakePgPool(advisoryLockResponder({ held: () => false }))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 5, onEvent: sink })
    await settle(() => lock!.signal.aborted)
    fake.only.emit('error', new Error('read ECONNRESET'))

    expect(lock!.loss()).toMatchObject({ reason: 'not-owner' })
    expect(events.filter(([name]) => name === 'db.advisory_lock_lost')).toHaveLength(1)
    await lock!.release()
  })

  it('names the key and the reason in the abort, and times the observation', async () => {
    // `toBeInstanceOf(Error)` alone would be satisfied by a bare `abort()`:
    // Node's AbortError is a DOMException and `DOMException instanceof Error` is
    // true. And `observedAfterMs >= 0` would be satisfied by a hard-coded 0 or
    // by `Date.now()` itself, hence the range.
    const { events, sink } = collect()
    const fake = fakePgPool(advisoryLockResponder({ held: () => false }))
    const lock = await acquireSessionAdvisoryLock(fake.pool, 987_654, { heartbeatMs: 5, onEvent: sink })
    await settle(() => lock!.signal.aborted)

    expect(String((lock!.signal.reason as Error).message)).toMatch(/987654.*not-owner/)
    const loss = lock!.loss()!
    expect(loss.observedAfterMs).toBeGreaterThan(0)
    expect(loss.observedAfterMs).toBeLessThan(60_000)

    const [, fields] = events.find(([name]) => name === 'db.advisory_lock_lost')!
    expect(fields).toMatchObject({ key: 987_654, backendPid: 4242, reason: 'not-owner' })
    expect(fields.detail).toEqual(expect.any(String))
    await lock!.release()
  })
})

describe('session advisory lock — the heartbeat is wired, and 0 really means none', () => {
  it('polls nothing at all when the heartbeat is disabled', async () => {
    // The integration suite's control arm rests on this: it proves the held
    // client ALONE keeps the lock, which is only true if `heartbeatMs: 0`
    // generates no traffic. A `||` instead of `??` would silently turn 0 into
    // the 15 s default and the control would be measuring the wrong thing
    // without any test noticing.
    const { events, sink } = collect()
    const fake = fakePgPool(advisoryLockResponder({}))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0, onEvent: sink })
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(fake.only.statements.filter((s) => s.sql.includes('pg_locks'))).toHaveLength(0)
    // The statement count ALONE cannot see the `||` mistake: 0 silently becomes
    // 15 000, the interval never fires inside a 120 ms test, and the assertion
    // above passes. The value the module actually resolved has to be asserted.
    expect(events.find(([name]) => name === 'db.advisory_lock_acquired')![1])
      .toMatchObject({ heartbeatMs: 0 })
    await lock!.release()
  })

  it('uses the 15 s default when the caller says nothing, and reports which', async () => {
    // The only production caller relies on the default, and `drillScheduler`
    // has no test of its own — so this is the one place the default is pinned.
    const { events, sink } = collect()
    const fake = fakePgPool(advisoryLockResponder({}))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { onEvent: sink })
    const [, fields] = events.find(([name]) => name === 'db.advisory_lock_acquired')!
    expect(fields).toMatchObject({ key: KEY, backendPid: 4242, heartbeatMs: 15_000 })
    await lock!.release()
  })
})

describe('session advisory lock — release answers rather than assumes', () => {
  it('surfaces an unlock that answers false', async () => {
    // A `false` return is not a rejection, so a `.catch(() => undefined)` on
    // the unlock would never see it; it must be surfaced as a value.
    const fake = fakePgPool(advisoryLockResponder({ unlock: false }))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0 })
    expect(await lock!.release()).toEqual({ confirmed: false, loss: null, error: null })
  })

  it('reports an unlock that raises as an error, and destroys the client', async () => {
    const fake = fakePgPool(advisoryLockResponder({
      unlock: new Error('terminating connection due to administrator command'),
    }))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0 })
    const released = await lock!.release()

    expect(released.confirmed).toBe(false)
    expect(released.error).toMatch(/administrator command/)
    // Postgres NOT ANSWERING and Postgres answering "no" are different facts
    // and call for different next steps; one boolean would erase one of them.
    expect(released.loss).toBeNull()
    expect(fake.only.releases[0]).toBeInstanceOf(Error)
  })

  it('reports what it did, with the hold time', async () => {
    const { events, sink } = collect()
    const fake = fakePgPool(advisoryLockResponder({}))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0, onEvent: sink })
    await lock!.release()

    const [, fields] = events.find(([name]) => name === 'db.advisory_lock_released')!
    expect(fields).toMatchObject({ key: KEY, backendPid: 4242, confirmed: true, loss: null, error: null })
    expect(fields.heldMs).toEqual(expect.any(Number))
  })

  it('a heartbeat already in flight when release runs does not invent a loss', async () => {
    // A test for a race has to ESTABLISH the race: wait until the heartbeat's
    // probe is actually in flight before releasing, or the guard is never
    // reached.
    let answerOwnership!: (held: boolean) => void
    const inFlight = new Promise<boolean>((resolve) => { answerOwnership = resolve })
    let asked = false
    const fake = fakePgPool(advisoryLockResponder({
      held: () => { asked = true; return inFlight },
    }))

    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 5 })
    await settle(() => asked)
    expect(asked).toBe(true)

    const releasing = lock!.release()
    answerOwnership(false)
    const released = await releasing
    await settle(() => false, 60)

    expect(released.loss).toBeNull()
    expect(lock!.loss()).toBeNull()
    expect(lock!.signal.aborted).toBe(false)
  })

  it('is answered once and the answer is kept', async () => {
    const fake = fakePgPool(advisoryLockResponder({}))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0 })
    const [a, b] = await Promise.all([lock!.release(), lock!.release()])

    expect(a).toBe(b)
    // The fake throws on a double release exactly as pg-pool does, so a second
    // `client.release()` would be a rejection rather than a silent miscount.
    expect(fake.only.releases).toHaveLength(1)
    expect(fake.only.statements.filter((s) => s.sql.includes('pg_advisory_unlock'))).toHaveLength(1)
  })

  it('does not abort the signal — an ordinary release is not an emergency', async () => {
    const fake = fakePgPool(advisoryLockResponder({}))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0 })
    await lock!.release()
    expect(lock!.signal.aborted).toBe(false)
  })

  it('a log sink that throws does not cost the caller its lock', async () => {
    // `onEvent` fires between "the key is taken" and "the caller holds
    // something that can give it back". A throw there would leak the client
    // AND leave the key held with nothing able to release it — reachable by a
    // logger with a full disk.
    const fake = fakePgPool(advisoryLockResponder({}))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, {
      heartbeatMs: 0,
      onEvent: () => { throw new Error('ENOSPC') },
    })
    expect(lock).not.toBeNull()
    expect(await lock!.release()).toMatchObject({ confirmed: true })
    expect(fake.only.releases).toHaveLength(1)
  })
})

/**
 * Returning the key by killing its holder.
 *
 * Everything here that is a claim about POSTGRES — that the `pg_locks`
 * predicate really refuses a pid which does not hold the key, that the `CASE`
 * really declines to signal our own backend, that a terminated session really
 * releases its advisory lock — is proved against a live cluster in
 * `sessionAdvisoryLock.integration.test.ts`. What a fake CAN decide is whether
 * the verdict is read from the witness (`pg_locks`) or from the intent (the
 * kill's return value).
 */

interface ScriptedRunner {
  readonly runner: AdvisoryLockQueryRunner
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>
  readonly terminates: () => number
  readonly rechecks: () => number
}

/** The row shape the terminate statement really returns, so a fixture cannot
 *  quietly omit a column the code branches on. */
const TERMINATED = { is_self: false, token_readable: true, token_matches: true, signalled: true }

/** `terminate` answers the kill statement; `held` answers each re-check, in
 *  order, and the last entry repeats forever. Either may be an Error, which the
 *  runner throws exactly as a statement would reject. */
function scripted(script: {
  terminate?: readonly Record<string, unknown>[] | Error
  held?: readonly (boolean | 'unreadable' | Error)[]
}): ScriptedRunner {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = []
  let recheck = 0
  const runner = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      statements.push({ sql, values })
      if (sql.includes('pg_terminate_backend')) {
        if (script.terminate instanceof Error) throw script.terminate
        return { rows: script.terminate ?? [TERMINATED] }
      }
      const answers = script.held ?? [false]
      const answer = answers[Math.min(recheck, answers.length - 1)]!
      recheck += 1
      if (answer instanceof Error) throw answer
      // TWO facts, matching the statement: whether that pid holds the lock, and
      // whether the asker could read its session token. `'unreadable'` is the
      // third production state — the pid holds it and `pg_stat_activity` would
      // not say whose session it is — which must read as `unknown`.
      // `pid_holds: false` comes with `token: null`, because that is what a
      // TERMINATED backend leaves behind: no row in `pg_locks` and none in
      // `pg_stat_activity` either. Returning a token for a pid holding nothing
      // (a state production cannot produce) would hide the branch ORDER.
      return answer === 'unreadable'
        ? { rows: [{ pid_holds: true, token: null }] }
        : { rows: [{ pid_holds: answer, token: answer ? TOKEN : null }] }
    },
  } as unknown as AdvisoryLockQueryRunner
  return {
    runner,
    statements,
    terminates: () => statements.filter((s) => s.sql.includes('pg_terminate_backend')).length,
    rechecks: () => statements.filter((s) => !s.sql.includes('pg_terminate_backend')).length,
  }
}

describe('terminating the lock holder — the verdict comes from pg_locks, not from the kill', () => {
  it('sends the key AND the pid, so the statement can refuse the wrong backend', async () => {
    // The whole safety argument is that `pg_locks` authorises the kill. A
    // mutant that passes only the key leaves `$2` unbound, which Postgres would
    // reject and a fake would not — so this is asserted here rather than left
    // to the integration suite to notice as a confusing error.
    const fake = scripted({ held: [false] })
    await terminateAdvisoryLockHolder(fake.runner, KEY, 31_337)
    expect(fake.statements[0]!.values).toEqual([KEY, 31_337, null])
  })

  it('a backend that no longer holds the key is ALREADY released, and is not re-checked', async () => {
    // No row is the ordinary answer on the abandonment path when the drill lost
    // its lock: whatever else is true, this session is not what stands between
    // the key and its next holder. Verifying that would be asking a second
    // question nobody needs the answer to.
    const fake = scripted({ terminate: [] })
    const outcome = await terminateAdvisoryLockHolder(fake.runner, KEY, 31_337)

    expect(outcome).toMatchObject({ signalled: false, released: true, refusedSelf: false, error: null })
    expect(fake.terminates()).toBe(1)
    expect(fake.rechecks()).toBe(0)
  })

  it('a kill that reported SUCCESS is still not a release', async () => {
    // THE test. `pg_terminate_backend` returns true when the SIGNAL was
    // delivered, not when the backend finished dying — and the key is held
    // until it does. An implementation that returned `released: signalled`
    // passes every other case in this file and fails only this one.
    const fake = scripted({ terminate: [{ is_self: false, signalled: true }], held: [true] })
    const outcome = await terminateAdvisoryLockHolder(fake.runner, KEY, 31_337, {
      ceilingMs: 120, pollMs: 5,
    })

    expect(outcome).toMatchObject({ signalled: true, released: false, error: null })
    // It really waited rather than answering at once, and really stopped rather
    // than waiting for a backend that will not die.
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(100)
    expect(outcome.waitedMs).toBeLessThan(3_000)
  })

  it('keeps asking until the backend is gone, rather than deciding on the first answer', async () => {
    const fake = scripted({ held: [true, true, false] })
    const outcome = await terminateAdvisoryLockHolder(fake.runner, KEY, 31_337, {
      ceilingMs: 2_000, pollMs: 1,
    })

    expect(outcome).toMatchObject({ signalled: true, released: true, error: null })
    expect(fake.rechecks()).toBe(3)
  })

  it('a kill that reported FAILURE can still end in a release', async () => {
    // `pg_terminate_backend` answers false when the pid vanished between the
    // scan and the signal — which is a backend that is already gone, i.e. a key
    // that is already free. Deriving the verdict from the return value would
    // report this healthy case as a still-held key and send an operator
    // hunting a backend that does not exist.
    const fake = scripted({ terminate: [{ is_self: false, signalled: false }], held: [false] })
    expect(await terminateAdvisoryLockHolder(fake.runner, KEY, 31_337))
      .toMatchObject({ signalled: false, released: true, error: null })
  })

  it('refuses to terminate the connection it is asking from, and says so', async () => {
    // A caller that passes the LOCK'S own pool would be asking a backend to
    // kill itself and then report on it. Reported as `refusedSelf` rather than
    // folded into `released`, because zero rows and a refusal mean opposite
    // things — one is "already free", the other is "nothing was even tried".
    const fake = scripted({ terminate: [{ is_self: true, signalled: false }] })
    const outcome = await terminateAdvisoryLockHolder(fake.runner, KEY, 31_337)

    expect(outcome).toMatchObject({ refusedSelf: true, released: false, signalled: false })
    // Anchored at the START of the message as well as the tail.
    expect(outcome.error).toMatch(/^refusing to terminate the backend this statement is running on/)
    expect(outcome.error).toMatch(/independent connection/)
    expect(fake.rechecks()).toBe(0)
  })

  it('a statement that raises is an ERROR, never a release', async () => {
    const fake = scripted({ terminate: new Error('connection terminated unexpectedly') })
    expect(await terminateAdvisoryLockHolder(fake.runner, KEY, 31_337))
      .toMatchObject({ signalled: false, released: false, error: 'connection terminated unexpectedly' })
  })

  it('keeps the signal it sent when the CONFIRMATION is what failed', async () => {
    // The signal went out; only the witness broke. Reporting `signalled: false`
    // here would describe a backend nobody touched, and an operator would go
    // looking for a live session that has in fact already been asked to die.
    const fake = scripted({ held: [new Error('server closed the connection unexpectedly')] })
    expect(await terminateAdvisoryLockHolder(fake.runner, KEY, 31_337))
      .toMatchObject({ signalled: true, released: false, error: 'server closed the connection unexpectedly' })
  })

  it('bounds the KILL statement itself, not only the confirmation', async () => {
    // The statement runs on a connection to a cluster that is, by the time this
    // path is reached, already misbehaving. Without a ceiling here the caller
    // waits `tcp_retries2` — about fifteen minutes — while holding the very key
    // it is trying to return. No other case in this file reaches that ceiling:
    // every scripted answer resolves, and a real cluster answers instantly.
    const runner = {
      query: (sql: string) => (sql.includes('pg_terminate_backend')
        ? new Promise<never>(() => {})
        : Promise.resolve({ rows: [{ held: false }] })),
    } as unknown as AdvisoryLockQueryRunner
    const started = Date.now()
    const outcome = await terminateAdvisoryLockHolder(runner, KEY, 31_337, { ceilingMs: 80 })

    expect(outcome).toMatchObject({ signalled: false, released: false })
    expect(outcome.error).toMatch(/did not answer within 80 ms/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('the CEILING is spent down across polls, not re-armed on each one', async () => {
    // Each re-check's query must get only the REMAINING budget; giving it the
    // caller's full ceiling could overrun the bound by up to double. Invisible
    // to every other case here, whose re-checks answer instantly.
    //
    // Asserted on the MESSAGE rather than on a stopwatch: the loop's own
    // `remaining <= 0` break ends it either way, so the only difference is how
    // long ONE unanswered check is allowed to wait — and that number is in the
    // error, exactly.
    //
    // The first re-check answers slowly, spending most of the budget; the
    // second hangs. Clamped, it is given what is LEFT; unclamped, the whole
    // ceiling again.
    let recheck = 0
    const runner = {
      query: async (sql: string) => {
        if (sql.includes('pg_terminate_backend')) return { rows: [TERMINATED] }
        recheck += 1
        if (recheck === 1) {
          await new Promise((resolve) => setTimeout(resolve, 200))
          return { rows: [{ pid_holds: true, token: TOKEN }] }
        }
        return new Promise<never>(() => {})
      },
    } as unknown as AdvisoryLockQueryRunner
    const outcome = await terminateAdvisoryLockHolder(runner, KEY, 31_337, {
      backendStart: TOKEN, ceilingMs: 300, pollMs: 1,
    })

    expect(outcome.released).toBe(false)
    const waited = /within (\d+) ms/.exec(String(outcome.error))
    expect(waited).not.toBeNull()
    expect(Number(waited![1])).toBeLessThan(300)
  })

  it('the SLEEP cannot push the total past the ceiling', async () => {
    // Every other case here uses a poll period far smaller than the ceiling, so
    // `Math.min(pollMs, remaining)` collapsing to `pollMs` would change no
    // answer. With a poll period LONGER than the ceiling, the naive version
    // overshoots by the whole period.
    const fake = scripted({ held: [true] })
    const started = Date.now()
    const outcome = await terminateAdvisoryLockHolder(fake.runner, KEY, 31_337, {
      ceilingMs: 100, pollMs: 5_000,
    })

    expect(outcome.released).toBe(false)
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it('asks the first time IMMEDIATELY, rather than sleeping first', async () => {
    // A backend signalled while idle dies in milliseconds, so a poll that
    // sleeps before its first look adds a whole period to every key return on
    // the abandonment path — 250 ms at the default, paid on the one path that
    // exists to make the key come back promptly.
    const fake = scripted({ held: [false] })
    const outcome = await terminateAdvisoryLockHolder(fake.runner, KEY, 31_337, {
      ceilingMs: 5_000, pollMs: 400,
    })

    expect(outcome.released).toBe(true)
    expect(outcome.waitedMs).toBeLessThan(400)
  })

  it('reports how long it actually waited, not a placeholder', async () => {
    // `waitedMs` travels into `backup.drill_lock_return`, which is the only
    // account of how long the fleet was blocked. Asserted as a RANGE rather
    // than `expect.any(Number)`, which zero satisfies.
    const fake = scripted({ held: [true, true, false] })
    const outcome = await terminateAdvisoryLockHolder(fake.runner, KEY, 31_337, {
      ceilingMs: 5_000, pollMs: 40,
    })

    expect(outcome.released).toBe(true)
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(40)
    expect(outcome.waitedMs).toBeLessThan(5_000)
  })

  it('the defaults are a real bound and a poll that fits inside it', () => {
    // Without this, both constants could be raised to any value without a test
    // noticing — including a ceiling of an hour on a path whose entire purpose
    // is to be prompt.
    expect(DEFAULT_TERMINATION_CEILING_MS).toBeGreaterThan(1_000)
    expect(DEFAULT_TERMINATION_CEILING_MS).toBeLessThanOrEqual(30_000)
    // The relation, not two independent numbers: a poll period at or above the
    // ceiling means exactly one look and no waiting at all.
    expect(DEFAULT_TERMINATION_POLL_MS).toBeLessThan(DEFAULT_TERMINATION_CEILING_MS / 10)
  })

  it('a token it CANNOT READ is unknown, never a release', async () => {
    // A different ROLE sees the `pg_locks` row but `backend_start` as NULL. A
    // fence inside the WHERE clause would give that asker no row —
    // indistinguishable from "that backend holds nothing" — and report
    // `released: true` while a live backend sat on the key.
    const fake = scripted({
      terminate: [{ is_self: false, token_readable: false, token_matches: false, signalled: false }],
    })
    const outcome = await terminateAdvisoryLockHolder(fake.runner, KEY, 31_337, { backendStart: TOKEN })

    expect(outcome).toMatchObject({ signalled: false, released: false, fenced: true })
    expect(outcome.error).toMatch(/did not report its backend_start/)
    // Nothing was killed and nothing was re-checked: there was no verdict to
    // confirm.
    expect(fake.rechecks()).toBe(0)
  })

  it('a token that READS but does not match is a release, and kills nothing', async () => {
    // Pid reuse, or somebody else's session on our key. Either way OUR session
    // is gone, so the key is not ours to return — and the fence is what stops
    // the kill from taking the rightful successor.
    const fake = scripted({
      terminate: [{ is_self: false, token_readable: true, token_matches: false, signalled: false }],
    })
    expect(await terminateAdvisoryLockHolder(fake.runner, KEY, 31_337, { backendStart: TOKEN }))
      .toMatchObject({ signalled: false, released: true, fenced: true, error: null })
    expect(fake.rechecks()).toBe(0)
  })

  it('refuses a key it cannot decode', async () => {
    // Same guard as the other two entry points. The decode is bit arithmetic on
    // the key, so an unsafe integer would authorise the kill from a lock tag
    // that is not the one being reasoned about.
    const fake = scripted({})
    await expect(terminateAdvisoryLockHolder(fake.runner, Number.MAX_SAFE_INTEGER + 1, 1))
      .rejects.toThrow(/safe integer/)
    expect(fake.statements).toHaveLength(0)
  })
})

/**
 * The ownership question has THREE answers, and the third is the whole point.
 *
 * `unknown` is not a polite `not-ours`. It means the question could not be
 * asked, and the caller acts on the two in opposite ways: `not-ours` aborts a
 * long dump, `unknown` lets it run on. A fence inside the WHERE clause would
 * collapse them, since a boolean has no room for a third value.
 */
describe('checkAdvisoryLockOwnership — three answers, not two', () => {
  it('OURS when the pid holds it and the session matches', async () => {
    const fake = scripted({ held: [true] })
    expect(await checkAdvisoryLockOwnership(fake.runner, KEY, 31_337, { backendStart: TOKEN }))
      .toEqual({ verdict: 'ours', fenced: true, error: null })
  })

  it('NOT-OURS when that backend holds no such lock — the one answer needing no token', async () => {
    const fake = scripted({ held: [false] })
    expect(await checkAdvisoryLockOwnership(fake.runner, KEY, 31_337, { backendStart: TOKEN }))
      .toEqual({ verdict: 'not-ours', fenced: true, error: null })
  })

  it('NOT-OURS when the pid holds it under a DIFFERENT session', async () => {
    // Pid reuse as a verdict rather than as a hazard: the number is right, the
    // session is not, so the key belongs to somebody else.
    const fake = scripted({ held: [true] })
    expect(await checkAdvisoryLockOwnership(fake.runner, KEY, 31_337, { backendStart: 'a-different-session' }))
      .toEqual({ verdict: 'not-ours', fenced: true, error: null })
  })

  it('UNKNOWN when the pid holds it and the token cannot be read', async () => {
    // THE case, and the one a two-valued predicate cannot express. Reachable:
    // a role that is not a member of the holder's sees the
    // `pg_locks` row and a NULL `backend_start`. Reported as `not-ours` it
    // would stop a perfectly healthy drill; here nothing was established and
    // the caller is told so.
    const fake = scripted({ held: ['unreadable'] })
    const outcome = await checkAdvisoryLockOwnership(fake.runner, KEY, 31_337, { backendStart: TOKEN })

    expect(outcome.verdict).toBe('unknown')
    expect(outcome.fenced).toBe(true)
    expect(outcome.error).toMatch(/did not report backend_start/)
  })

  it('UNFENCED, it answers by pid alone and says which guarantee that is', async () => {
    // A caller with no token gets the weaker answer rather than none, and the
    // unreadable case stops being a problem it does not have.
    const fake = scripted({ held: ['unreadable'] })
    expect(await checkAdvisoryLockOwnership(fake.runner, KEY, 31_337))
      .toEqual({ verdict: 'ours', fenced: false, error: null })
  })

  it('UNFENCED with a READABLE token is still ours — the arm the case above misses', async () => {
    // With `held: ['unreadable']` the fixture's token is null and the caller's
    // is null too, so `row.token === backendStart` is ALREADY true and the
    // `|| !fenced` arm is never consulted. Here the token reads back fine and
    // the caller supplies none — the only combination that reaches the arm.
    const fake = scripted({ held: [true] })
    expect(await checkAdvisoryLockOwnership(fake.runner, KEY, 31_337))
      .toEqual({ verdict: 'ours', fenced: false, error: null })
  })

  it('tests pid_holds FIRST, so a dead backend is not-ours rather than unknown', async () => {
    // A terminated backend leaves NO row in `pg_locks` and none in
    // `pg_stat_activity` — so `pid_holds: false` arrives together with an
    // unreadable token, and the order of the two branches decides the verdict.
    // Tested first it is `not-ours`, which is the answer; tested second it
    // would be `unknown`, which would let a drill carry on next to a rival.
    const fake = scripted({ held: [false] })
    expect(await checkAdvisoryLockOwnership(fake.runner, KEY, 31_337, { backendStart: TOKEN }))
      .toEqual({ verdict: 'not-ours', fenced: true, error: null })
  })

  it('UNKNOWN, with the reason, when the question cannot be asked at all', async () => {
    const fake = scripted({ held: [new Error('terminating connection due to administrator command')] })
    expect(await checkAdvisoryLockOwnership(fake.runner, KEY, 31_337, { backendStart: TOKEN }))
      .toEqual({
        verdict: 'unknown',
        fenced: true,
        error: 'terminating connection due to administrator command',
      })
  })

  it('is bounded, so a check cannot outlive the run it is protecting', async () => {
    const runner = { query: () => new Promise<never>(() => {}) } as unknown as AdvisoryLockQueryRunner
    const started = Date.now()
    const outcome = await checkAdvisoryLockOwnership(runner, KEY, 31_337, { ceilingMs: 60 })

    expect(outcome.verdict).toBe('unknown')
    expect(outcome.error).toMatch(/did not answer within 60 ms/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('THROWS on a key it cannot decode rather than answering unknown', async () => {
    // A programming error must not become a verdict. `unknown` means "continue",
    // so swallowing it here would make a bad key an invisible no-op on the one
    // question that decides whether a drill keeps dumping.
    const fake = scripted({})
    await expect(checkAdvisoryLockOwnership(fake.runner, 2 ** 60, 31_337)).rejects.toThrow(/safe integer/)
    expect(fake.statements).toHaveLength(0)
  })
})

describe('session advisory lock — the cluster reaps a holder whose client went silent', () => {
  const acquireOf = (fake: ReturnType<typeof fakePgPool>) =>
    fake.only.statements.find((s) => s.sql.includes('pg_try_advisory_lock'))!

  it('carries the keepalives in the SAME statement as the lock, so there is no second round trip', async () => {
    // Both halves matter. The values must be PARAMETERS -- a statement that
    // interpolated them would be a different statement per configuration and
    // could not be prepared -- and there must be exactly one statement, because
    // an `await` between taking the lock and building the handle is a window
    // in which a throw leaks the lock.
    const fake = fakePgPool(advisoryLockResponder({}))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0 })
    const before = fake.only.statements.filter((s) => !s.sql.includes('pg_advisory_unlock'))
    expect(before).toHaveLength(1)
    expect(before[0]!.sql).toContain("set_config('tcp_keepalives_idle'")
    expect(before[0]!.sql).toContain("set_config('tcp_keepalives_interval'")
    expect(before[0]!.sql).toContain("set_config('tcp_keepalives_count'")
    expect(before[0]!.values).toEqual([KEY, 60, 30, 10])
    await lock!.release()
  })

  it('reports the window the KERNEL took, not the one that was asked for', async () => {
    const fake = fakePgPool(advisoryLockResponder({}))
    const { events, sink } = collect()
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0, onEvent: sink })
    expect(lock!.keepalives).toEqual({
      requested: { idleSeconds: 60, intervalSeconds: 30, count: 10 },
      effective: { idleSeconds: 60, intervalSeconds: 30, count: 10 },
      transport: 'tcp',
      // 60 + 10 x 30. Asserted as the NUMBER rather than recomputed from the
      // constants, so an edit to the arithmetic has to come here and be meant.
      detectsWithinSeconds: 360,
    })
    expect(events.map(([name]) => name)).toEqual(['db.advisory_lock_acquired'])
    expect(events[0]![1]).toMatchObject({ keepaliveDetectsWithinSeconds: 360 })
    await lock!.release()
  })

  it('clears the abandonment budget it has to outlive', async () => {
    // The relation, not the number. `drillTick` holds the key deliberately for
    // its whole abort grace so the delay opens no window a rival can dump
    // inside; a belt that fires inside that grace takes the key away
    // mid-teardown. `drillTick` asserts this at construction too; this pins
    // the DEFAULT so a
    // change to the constant fails here rather than only in a drill's tests.
    const window = DEFAULT_KEEPALIVES.idleSeconds
      + DEFAULT_KEEPALIVES.count * DEFAULT_KEEPALIVES.intervalSeconds
    expect(window * 1000).toBeGreaterThan(300_000 + 15_000 + 5_000)
  })

  it('is frozen, because it is handed out by reference as `requested`', async () => {
    const fake = fakePgPool(advisoryLockResponder({}))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0 })
    expect(Object.isFrozen(DEFAULT_KEEPALIVES)).toBe(true)
    expect(lock!.keepalives.requested).toBe(DEFAULT_KEEPALIVES)
    await lock!.release()
  })

  it('threads the CALLER\'s values through, rather than the defaults twice', async () => {
    const fake = fakePgPool(advisoryLockResponder({}))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, {
      heartbeatMs: 0,
      keepalives: { idleSeconds: 5, intervalSeconds: 2, count: 3 },
    })
    expect(acquireOf(fake).values).toEqual([KEY, 5, 2, 3])
    expect(lock!.keepalives.detectsWithinSeconds).toBe(11)
    await lock!.release()
  })

  it('says so when the cluster SILENTLY returned different settings', async () => {
    // The likeliest case in practice. `tcp_keepalives_count = 200` exceeds
    // Linux's MAX_TCP_KEEPCNT of 127, so `setsockopt` refuses and Postgres
    // returns the PREVIOUS value (9) with no error. Every number is positive and
    // plausible, so a positivity check would report a confident window.
    // Equality with what was asked is the only test that works.
    const fake = fakePgPool(advisoryLockResponder({ keepalives: 'clamped' }))
    const { events, sink } = collect()
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0, onEvent: sink })
    expect(lock!.keepalives.effective).toEqual({ idleSeconds: 7200, intervalSeconds: 75, count: 9 })
    expect(lock!.keepalives.detectsWithinSeconds).toBeNull()
    const inert = events.find(([name]) => name === 'db.advisory_lock_keepalives_inert')
    expect(inert).toBeDefined()
    // BOTH sides in the log. "It did not apply" without the two values sends an
    // operator to the wrong file.
    expect(inert![1]).toMatchObject({
      key: KEY,
      requested: { idleSeconds: 60 },
      effective: { idleSeconds: 7200 },
    })
    // And NO consequence asserted: "until the OS default expires" would be a
    // factor of ten out for a partial landing (735 s, not 7 200).
    expect(String(inert![1].detail)).not.toMatch(/OS default/)
    expect(String(inert![1].detail)).toMatch(/different TCP keepalive settings/)
    await lock!.release()
  })

  it('stays SILENT on a Unix socket, where the belt is neither possible nor needed', async () => {
    // `set_config` returns 0 for all three on a local session -- measured, and
    // `pg_stat_activity.client_port` is -1 there. Alarming on it would fire on
    // every acquire of an ordinary local deployment, and an alarm that fires on
    // the ordinary case gets muted and then protects nothing. It is also
    // pointless: a local peer's death arrives as EOF from the kernel at once,
    // so there is no black hole to compensate for.
    const fake = fakePgPool(advisoryLockResponder({ keepalives: 'inert', clientPort: -1 }))
    const { events, sink } = collect()
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0, onEvent: sink })
    expect(lock!.keepalives.transport).toBe('local')
    expect(lock!.keepalives.detectsWithinSeconds).toBeNull()
    expect(events.map(([name]) => name)).toEqual(['db.advisory_lock_acquired'])
    await lock!.release()
  })

  it('DOES alarm for the same inert values over TCP', async () => {
    // The converse of the test above, and the reason it is a separate case: if
    // the suppression keyed on the VALUES rather than on the transport it would
    // also silence a real TCP session whose kernel refused the option, which is
    // the one deployment that needs telling.
    const fake = fakePgPool(advisoryLockResponder({ keepalives: 'inert', clientPort: 44_444 }))
    const { events, sink } = collect()
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0, onEvent: sink })
    expect(lock!.keepalives.transport).toBe('tcp')
    expect(events.map(([name]) => name)).toContain('db.advisory_lock_keepalives_inert')
    await lock!.release()
  })

  it('refuses to report a window when only ONE field came back different', async () => {
    // Each term of the equality, pinned SEPARATELY, and each with a positive
    // plausible value rather than a zero: with all three diverging at once, a
    // weakened check on any ONE term would still fail on the other two. The
    // divergence a real cluster produces is exactly this -- one field refused by
    // the kernel, the rest applied.
    for (const partial of [
      { ka_idle: 7200, ka_interval: 30, ka_count: 10 },
      { ka_idle: 60, ka_interval: 75, ka_count: 10 },
      { ka_idle: 60, ka_interval: 30, ka_count: 9 },
    ]) {
      const fake = fakePgPool((sql) => (sql.includes('pg_try_advisory_lock')
        ? { rows: [{ locked: true, pid: 4242, token: TOKEN, ...partial }] }
        : { rows: [{ unlocked: true }] }))
      const { events, sink } = collect()
      const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0, onEvent: sink })
      expect(lock!.keepalives.detectsWithinSeconds).toBeNull()
      expect(events.map(([name]) => name)).toContain('db.advisory_lock_keepalives_inert')
      await lock!.release()
    }
  })

  it('leaves the cluster alone on `keepalives: null`, and claims nothing', async () => {
    // The option exists for the measurement that must NOT have a belt on: the
    // integration test whose control arm is "unset behaves like the OS default".
    const fake = fakePgPool(advisoryLockResponder({}))
    const { events, sink } = collect()
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, {
      heartbeatMs: 0,
      keepalives: null,
      onEvent: sink,
    })
    expect(acquireOf(fake).sql).not.toContain('set_config')
    expect(acquireOf(fake).values).toEqual([KEY])
    expect(lock!.keepalives).toEqual({
      requested: null,
      effective: null,
      transport: 'tcp',
      detectsWithinSeconds: null,
    })
    // Silence, not an alarm: nothing was asked for, so nothing failed.
    expect(events.map(([name]) => name)).toEqual(['db.advisory_lock_acquired'])
    await lock!.release()
  })

  it('rejects values the KERNEL would silently ignore, before taking the lock', async () => {
    // Measured ceilings on postgres:16-alpine, by binary search: idle and
    // interval stick up to 32767, count up to 127. Above those Postgres accepts
    // the statement, `setsockopt` refuses, and `set_config` returns the previous
    // value with no error anywhere -- so without this the caller gets the OS
    // default wearing their own number's name. Above int4 Postgres does raise,
    // but by then the lock is already taken and only the client destroy
    // recovers it: a lock taken and thrown away for a value that could have been
    // refused for free.
    const fake = fakePgPool(advisoryLockResponder({}))
    for (const [bad, field] of [
      [{ idleSeconds: 40_000, intervalSeconds: 30, count: 10 }, 'idleSeconds'],
      [{ idleSeconds: 60, intervalSeconds: 40_000, count: 10 }, 'intervalSeconds'],
      [{ idleSeconds: 60, intervalSeconds: 30, count: 200 }, 'count'],
    ] as const) {
      await expect(acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0, keepalives: bad }))
        .rejects.toThrow(new RegExp(`keepalives\\.${field} must not exceed`))
    }
    expect(fake.clients).toHaveLength(0)
  })

  it('rejects a MISSING field, which would otherwise reset the GUC', async () => {
    // Validating only the keys PRESENT would let `{}` pass vacuously.
    // node-postgres binds a missing parameter to NULL, and
    // `set_config(name, NULL, false)` is a RESET (measured: `count` went
    // 6 -> 9). Validate the REQUIRED keys, never the supplied ones.
    const fake = fakePgPool(advisoryLockResponder({}))
    for (const partial of [{}, { idleSeconds: 60 }, { idleSeconds: 60, intervalSeconds: 30 }]) {
      await expect(acquireSessionAdvisoryLock(fake.pool, KEY, {
        heartbeatMs: 0,
        keepalives: partial as unknown as AdvisoryLockKeepalives,
      })).rejects.toThrow(/must be a positive integer/)
    }
    expect(fake.clients).toHaveLength(0)
  })

  it('rejects zero, because zero is Postgres for "use the OS default"', async () => {
    // Zero does not mean "off" to Postgres, it means "use the OS default":
    // measured, `SET tcp_keepalives_idle = 0` reads back 7200. So a caller who
    // passed zeros meaning to disable the belt would get one armed at two
    // hours, `requested` would read `{0,0,0}`, and every check here would agree
    // with itself. `null` is the way to disable, and the message has to say so
    // or the next person tries zero again.
    const fake = fakePgPool(advisoryLockResponder({}))
    for (const bad of [
      { idleSeconds: 0, intervalSeconds: 10, count: 6 },
      { idleSeconds: 60, intervalSeconds: -1, count: 6 },
      { idleSeconds: 60, intervalSeconds: 10, count: 1.5 },
    ]) {
      await expect(acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0, keepalives: bad }))
        .rejects.toThrow(/positive integer.*keepalives: null/s)
    }
    // And it threw BEFORE checking a client out, so a bad option cannot leak one.
    expect(fake.clients).toHaveLength(0)
  })

  it('still applies them when the lock is NOT ours, and gives the client back', async () => {
    // Deliberate, and worth pinning because it looks like an oversight: the
    // settings have already been applied to a client that goes straight back to
    // the pool. Tighter dead-peer detection on a pooled connection is never
    // harmful, and the next borrower is very often this same caller retrying.
    const fake = fakePgPool(advisoryLockResponder({ locked: false }))
    const lock = await acquireSessionAdvisoryLock(fake.pool, KEY, { heartbeatMs: 0 })
    expect(lock).toBeNull()
    expect(acquireOf(fake).sql).toContain('tcp_keepalives_idle')
    // RETURNED, not destroyed, and the argument is the whole difference:
    // `client.release(broken)` with anything truthy makes the real pool throw
    // the connection away. `isReleased` is true either way, so it alone would
    // not catch churning a pool connection on every "somebody else holds the
    // key" tick.
    expect(fake.only.releases).toEqual([undefined])
    expect(fake.only.isReleased).toBe(true)
  })

  it('keeps the idle window clear of the heartbeat, so a HEALTHY link never arms it', async () => {
    // The relation, not the numbers: every heartbeat resets the server's idle
    // timer, so an idle window at or below the heartbeat period would have the
    // kernel probing a connection that is talking. Harmless, but it would make
    // the cost claim in DEFAULT_KEEPALIVES' comment false.
    //
    // FOUR heartbeats, not one: the heartbeat's own probe is ceilinged at
    // `heartbeatMs`, so two successive answers can legitimately be ~30 s apart
    // on a slow but healthy link, and a margin of one period is not real.
    expect(DEFAULT_KEEPALIVES.idleSeconds * 1000).toBeGreaterThanOrEqual(4 * DEFAULT_HEARTBEAT_MS)
  })
})
