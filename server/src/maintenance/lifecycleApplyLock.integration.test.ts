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
 * The lifecycle apply lock's OWN properties, against a real Postgres.
 *
 * WHY A SEPARATE FILE. The four doors' suites test what the lock does FOR THEM
 * — refused applies, released keys, re-reads that catch a moved workspace. The
 * three properties below belong to the wrapper itself and are unreachable from
 * a door: a door has no way to make its own session stop holding the key, and
 * no way to hand the re-read somebody else's connection. So they get a harness
 * that can actually produce those failure modes.
 *
 * EVERY ARM CARRIES ITS OWN CONTROL. Asserting `exclusionProven === false` and
 * nothing else is satisfied by a witness that can only answer false. Each arm
 * therefore runs the same code path twice, once with the fault and once
 * without, and asserts that the answer FLIPS.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import {
  LifecycleApplyRefusedError,
  sessionHoldsLifecycleLock,
  withLifecycleApplyLock,
  type LockedSession,
} from './lifecycleApplyLock.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('the lifecycle apply lock (live Postgres)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'lifecycle_apply_lock')
  })

  afterAll(async () => { await db?.teardown() })

  const WS = { landscapeId: 'L-lifecycle-lock', versionId: 'V1' }
  const CLASS = 0x5359

  /**
   * The key, recomputed from its TEXT rather than imported.
   *
   * `lifecycleLockKey` is the wire format of an exclusion between processes: a
   * door running the old build must keep excluding a door running the new one.
   * A test that calls the function under test cannot notice that function
   * changing, so this suite states the arithmetic independently and would go
   * red on a silent change to either.
   */
  const keyOf = (landscapeId: string, versionId: string): number => {
    const text = `promote-summary:${landscapeId}:${versionId}`
    let hash = 0x811c9dc5
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    return hash | 0
  }
  const KEY = keyOf(WS.landscapeId, WS.versionId)

  /** Live sessions in this database holding THIS workspace's key. */
  const heldForKey = async (): Promise<number> => {
    const { rows } = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_locks lock
        WHERE lock.locktype = 'advisory' AND lock.classid = $1 AND lock.objid::bigint = $2
          AND lock.objsubid = 2 AND lock.granted
          AND lock.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          -- LIVE only. A pg_locks row whose backend has no pg_stat_activity row
          -- is a connection pg-pool has destroyed and Postgres has not yet
          -- reaped; it can serve nobody, so it is not the leak these assertions
          -- exist to catch. Measured: without this clause the sibling suite
          -- reported one held key at an instant when no holder existed.
          AND EXISTS (SELECT 1 FROM pg_stat_activity backend WHERE backend.pid = lock.pid)`,
      [CLASS, KEY >>> 0],
    )
    return Number(rows[0].n)
  }

  it('reports the exclusion PROVEN on a normal run, and NOT proven when it evaporates', async () => {
    // If the pinned backend dies mid-apply, Postgres returns the lock
    // immediately and the repair keeps writing without exclusion; the outcome
    // must say the exclusion evaporated in flight.
    //
    // `pg_advisory_unlock_all()` is that event, produced from the one place it
    // can be produced from: inside the session. It leaves the connection ALIVE
    // and the key GONE, which is precisely the state a killed backend leaves
    // for anyone still holding a reference to it — and unlike
    // `pg_terminate_backend`, it does not also break the very query the witness
    // has to run to notice.
    expect(await heldForKey()).toBe(0)

    // CONTROL FIRST. Without this arm, `exclusionProven: false` below is
    // satisfied by a witness wired to a constant.
    let heldInside = -1
    const healthy = await withLifecycleApplyLock(db.pool, WS, async () => {
      heldInside = await heldForKey()
      return 'ok'
    })
    expect(heldInside).toBe(1)
    expect(healthy).toEqual({ granted: true, value: 'ok', exclusionProven: true })
    expect(await heldForKey()).toBe(0)

    // THE FAULT, same call, same key, one statement different.
    const evaporated = await withLifecycleApplyLock(db.pool, WS, async (session) => {
      await session.query('SELECT pg_advisory_unlock_all()')
      return 'ok'
    })
    expect(evaporated).toEqual({ granted: true, value: 'ok', exclusionProven: false })
    // AND THE KEY IS STILL NOT LEAKED. `releaseLifecycleApplyLock` sees its
    // `pg_advisory_unlock` answer false and DESTROYS the connection rather than
    // returning a session of unknown lock state to the pool — the 1 -> 1
    // measurement in its own docstring is what that branch exists for.
    expect(await heldForKey()).toBe(0)
    // The lock is takeable again, which is the property a leak would break.
    expect((await withLifecycleApplyLock(db.pool, WS, async () => 'again')).granted).toBe(true)
  })

  it('the possession witness answers for THIS backend, not for the key in general', async () => {
    // THE RUNTIME HALF of the residue that said substituting a different
    // connection into the under-the-lock re-read "compiles and is caught by no
    // test, because the reads would return the same values". The compile-time
    // half is the brand, pinned by a `@ts-expect-error` arm in
    // `lifecycleApplyLockCallers.test.ts`; this is the half that still answers
    // correctly if someone widens the parameter back to `Queryable`.
    //
    // A witness without `pid = pg_backend_pid()` would answer TRUE for the
    // foreign connection below — the key IS held, just not by it — and that is
    // the whole difference between "somebody is excluding" and "the session
    // about to write is excluding".
    let mine = false
    let foreign = false
    let foreignSawTheKey = -1
    const outcome = await withLifecycleApplyLock(db.pool, WS, async (session) => {
      mine = await sessionHoldsLifecycleLock(session, WS)
      const other: PoolClient = await db.pool.connect()
      try {
        // The cast is the point: this is exactly the value the type system
        // refuses, so the runtime check is what remains if the type is ever
        // loosened. CONTROL — the foreign connection can see the key exists
        // from `pg_locks`, so `foreign === false` is not "it can see nothing".
        foreign = await sessionHoldsLifecycleLock(other as LockedSession, WS)
        const { rows } = await other.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_locks
            WHERE locktype = 'advisory' AND classid = $1 AND objid::bigint = $2 AND objsubid = 2
              AND granted`,
          [CLASS, KEY >>> 0],
        )
        foreignSawTheKey = Number(rows[0].n)
      } finally {
        other.release()
      }
      return null
    })

    expect(outcome.granted).toBe(true)
    expect(mine).toBe(true)
    expect(foreign).toBe(false)
    expect(foreignSawTheKey).toBeGreaterThan(0)
  })

  it('a pool that cannot lend a connection REFUSES with a typed code, not an opaque error', async () => {
    // THE RESIDUE: "a pool-exhaustion error refuses with a 500, outside the new
    // 503 contract — `acquireLifecycleApplyLock` starts with `db.connect()`,
    // whose timeout raises an ordinary Error. It is the only transient refusal
    // reason that does not get the 503."
    //
    // Transient in exactly the sense the other codes are: nothing was written,
    // nothing is held, and coming back later is the fix.
    const exhausted = new Proxy(db.pool, {
      get(target, property, receiver) {
        if (property === 'connect') {
          return () => Promise.reject(new Error('timeout exceeded when trying to connect'))
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as Pool

    let ran = false
    const error = await withLifecycleApplyLock(exhausted, WS, async () => { ran = true; return 'x' })
      .then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(LifecycleApplyRefusedError)
    expect((error as LifecycleApplyRefusedError).code).toBe('pool-exhausted')
    // The critical section never ran, so "nothing was written" is a property of
    // the code path and not of the fixture.
    expect(ran).toBe(false)
    expect(await heldForKey()).toBe(0)

    // CONTROL: the identical call through the real pool is granted and runs.
    const granted = await withLifecycleApplyLock(db.pool, WS, async () => { ran = true; return 'x' })
    expect(granted).toEqual({ granted: true, value: 'x', exclusionProven: true })
    expect(ran).toBe(true)
  })

  it('releases the key when the critical section THROWS — the path a hand-written finally loses', async () => {
    expect(await heldForKey()).toBe(0)
    const boom = new Error('critical section failed')
    await expect(withLifecycleApplyLock(db.pool, WS, async () => { throw boom }))
      .rejects.toBe(boom)
    expect(await heldForKey()).toBe(0)
    // CONTROL: the key really was taken on that run — otherwise the zero above
    // is a zero about nothing. Proven by taking it again and watching the count
    // rise from inside.
    let inside = -1
    await withLifecycleApplyLock(db.pool, WS, async () => { inside = await heldForKey() })
    expect(inside).toBe(1)
  })

  it('DETECTS a connection that changed backends under it — the transaction-pooler caveat', async () => {
    // THE RESIDUE: "behind a transaction-mode pooler the pinning is not a
    // mechanism — pinning a node-postgres client pins it to the POOLER, and
    // destroying that client does not end the server backend holding the
    // session lock. Nothing in this deployment runs one today."
    //
    // That was prose asserting a property, which is the exact shape to
    // distrust. `pg_backend_pid()` decides it instead: recorded when
    // the key is taken, compared when it is given back. Equal under a
    // session-mode pool by construction; under a transaction pooler they drift,
    // and the drift is the defect.
    //
    // DRIVEN BY MOVING THE PID, not by standing up PgBouncer — the property
    // under test is "does this module notice", and a pooler is one way to
    // produce the input, not the input itself.
    const moved = new Proxy(db.pool, {
      get(target, property, receiver) {
        if (property !== 'connect') {
          const value = Reflect.get(target, property, receiver) as unknown
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        }
        return async () => {
          const client = await target.connect()
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty !== 'query') {
                const value = Reflect.get(clientTarget, clientProperty, clientReceiver) as unknown
                return typeof value === 'function'
                  ? (value as (...a: unknown[]) => unknown).bind(clientTarget) : value
              }
              return async (text: string, params?: unknown[]) => {
                const result = await clientTarget.query(text, params) as { rows: { pid?: number }[] }
                // Only the RELEASE round trip lies, so the acquire records a
                // truthful pid and the comparison has something real to fail on.
                if (text.includes('pg_advisory_unlock') && result.rows[0]) {
                  result.rows[0].pid = (result.rows[0].pid ?? 0) + 1
                }
                return result
              }
            },
          })
        }
      },
    }) as Pool

    const errors: string[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
    let outcome: Awaited<ReturnType<typeof withLifecycleApplyLock<string>>>
    try {
      outcome = await withLifecycleApplyLock(moved, WS, async () => 'wrote something')
    } finally {
      console.error = realError
    }

    // The critical section RAN and returned — this is not a refusal. What the
    // door must not do is report the exclusion as sound.
    expect(outcome).toEqual({ granted: true, value: 'wrote something', exclusionProven: false })
    expect(errors.join('\n')).toMatch(/moved backends .* while holding the apply key/)
    expect(errors.join('\n')).toMatch(/transaction-mode pooler/)

    // CONTROL: the identical call on the unproxied pool reports it PROVEN, so
    // the false above is the detector firing and not a constant.
    expect(await withLifecycleApplyLock(db.pool, WS, async () => 'wrote something')).toEqual(
      { granted: true, value: 'wrote something', exclusionProven: true },
    )
    // And the key is not leaked by either path — a connection destroyed because
    // its backend moved must still leave nothing held here.
    expect(await heldForKey()).toBe(0)
  })

  it('DESTROYS the connection when the acquire reply is lost after the key was taken', async () => {
    // `acquireLifecycleApplyLock`'s catch releases WITH the error — and its own
    // comment says why: "if it was granted and the reply was lost, a bare
    // release hands a lock-holding connection back to the pool". Without this
    // arm that branch has no driver at all.
    //
    // Driven exactly as the comment describes: the lock really is taken, and
    // only then does the reply fail. A bare release would return that
    // lock-holding session to the pool, where an advisory lock is COUNTED — so
    // the next borrower is admitted while everyone else is refused.
    let taken = 0
    const replyLost = new Proxy(db.pool, {
      get(target, property, receiver) {
        if (property !== 'connect') {
          const value = Reflect.get(target, property, receiver) as unknown
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        }
        return async () => {
          const client = await target.connect()
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty !== 'query') {
                const value = Reflect.get(clientTarget, clientProperty, clientReceiver) as unknown
                return typeof value === 'function'
                  ? (value as (...a: unknown[]) => unknown).bind(clientTarget) : value
              }
              return async (text: string, params?: unknown[]) => {
                if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                  await clientTarget.query(text, params) // the key IS taken
                  taken += 1
                  throw new Error('connection terminated while reading the reply')
                }
                return clientTarget.query(text, params)
              }
            },
          })
        }
      },
    }) as Pool

    let ran = false
    const error = await withLifecycleApplyLock(replyLost, WS, async () => { ran = true; return 'x' })
      .then(() => null, (thrown: unknown) => thrown)

    // LIVENESS: the key really was taken before the failure, so this is the
    // hazard the branch describes and not merely "connect failed".
    expect(taken).toBe(1)
    expect((error as Error).message).toMatch(/terminated while reading the reply/)
    expect(ran).toBe(false)
    // THE PROPERTY: the session was destroyed, so the key it held is gone. A
    // bare release leaves it held by an idle pooled connection — measured
    // 1 -> 1 in `releaseLifecycleApplyLock`'s own table.
    expect(await heldForKey()).toBe(0)
    // And the door is takeable again, which is what a leak would break.
    expect((await withLifecycleApplyLock(db.pool, WS, async () => 'after')).granted).toBe(true)
  })

  it('names the POOLER when the pid drifts AND the unlock fails — the state a real pooler produces', async () => {
    // THE SURVIVOR: swapping the two branches in `releaseLifecycleApplyLock`
    // left every arm green, because no test produced BOTH conditions at once.
    // Under an actual transaction-mode pooler both always hold — the unlock
    // runs on a backend that never held the key, so it answers false AND the
    // pid drifted — and the branch order is the only thing deciding whether the
    // operator is told "a pooler is breaking this lock" or the generic "this
    // session did not hold the key it thought it held".
    //
    // The first is the root cause and the second is its symptom, so the pooler
    // branch must win. This arm is what makes that ordering a property.
    const bothFail = new Proxy(db.pool, {
      get(target, property, receiver) {
        if (property !== 'connect') {
          const value = Reflect.get(target, property, receiver) as unknown
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        }
        return async () => {
          const client = await target.connect()
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty !== 'query') {
                const value = Reflect.get(clientTarget, clientProperty, clientReceiver) as unknown
                return typeof value === 'function'
                  ? (value as (...a: unknown[]) => unknown).bind(clientTarget) : value
              }
              return async (text: string, params?: unknown[]) => {
                const result = await clientTarget.query(text, params) as { rows: Record<string, unknown>[] }
                if (text.includes('pg_advisory_unlock') && result.rows[0]) {
                  // Exactly what a transaction pooler produces: a different
                  // backend, which therefore also did not hold the key.
                  result.rows[0].pid = (result.rows[0].pid as number) + 1
                  result.rows[0].unlocked = false
                }
                return result
              }
            },
          })
        }
      },
    }) as Pool

    const errors: string[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
    try {
      expect((await withLifecycleApplyLock(bothFail, WS, async () => 'x')).exclusionProven).toBe(false)
    } finally {
      console.error = realError
    }
    const log = errors.join('\n')
    expect(log).toMatch(/transaction-mode pooler/)
    // The symptom must NOT be the message: it is true, and it sends an operator
    // to the wrong place.
    expect(log).not.toMatch(/did not hold the key it thought it held/)
    expect(await heldForKey()).toBe(0)
  })

  it('a SECOND door is refused while the first holds the key, and admitted after', async () => {
    // The property the whole module exists for, stated once here without a
    // workspace fixture in the way: two callers, one key, on real connections.
    let secondWhileHeld: unknown = null
    await withLifecycleApplyLock(db.pool, WS, async () => {
      secondWhileHeld = await withLifecycleApplyLock(db.pool, WS, async () => 'should not run')
    })
    expect(secondWhileHeld).toEqual({ granted: false })
    // CONTROL: the same second call succeeds once the first has finished, which
    // rules out "it was refused for some other reason".
    expect(await withLifecycleApplyLock(db.pool, WS, async () => 'now')).toEqual(
      { granted: true, value: 'now', exclusionProven: true },
    )
  })
})
