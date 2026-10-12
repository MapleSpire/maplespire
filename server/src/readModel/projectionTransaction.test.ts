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

import { describe, expect, it, vi } from 'vitest'
import type { Queryable } from './types.js'
import { withReadModelProjectionTransaction } from './projectionTransaction.js'
import {
  PROJECTION_MUTEX_WAIT_MS,
  ReadModelPlaneError,
  projectionMutexKey,
} from './projectionAuthority.js'

const WS = { landscapeId: 'land', versionId: 'version' }

/** A client whose EXISTS answer decides which plane owns the workspace, and
 * which records every statement in order. `isStatic` is the ONLY thing that
 * varies between the two planes' tests, so a test that passes for both is
 * testing the predicate rather than the fixture. */
function fakeClient(isStatic: boolean) {
  const order: string[] = []
  // Bound parameters are read back through `.mock.calls` rather than a parallel
  // array: `order` also carries synthetic 'ACTION' markers the fake never saw,
  // so the two would desync exactly where a test looks.
  const answer = async (sql: string) => {
    order.push(String(sql))
    if (String(sql).includes('read_model_static_workspaces')) {
      return { rows: [{ present: isStatic }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
  const client = { query: vi.fn(answer), release: vi.fn() }
  // A DISTINCT spy for the POOL, and it is load-bearing: sharing one spy would
  // make "issued on the transaction" and "issued on the pool" record
  // identically, hiding a mutex, authority check or timeout moved off `tx` and
  // onto `db`. Each is a silent
  // production defect: `pg_advisory_xact_lock` outside an explicit transaction
  // is released by its own implicit commit and therefore serializes NOTHING;
  // the authority check off `tx` becomes a TOCTOU against the other writer,
  // which is the single thing its placement exists to buy; and `SET LOCAL`
  // outside a transaction applies to nothing, leaving the wait unbounded.
  const poolQuery = vi.fn(answer)
  const pool = { query: poolQuery, connect: vi.fn(async () => client) } as unknown as Queryable
  return { client, pool, poolQuery, order }
}

/** The recorded statements, collapsed to the four things this function is FOR.
 * Compared as a whole array rather than by `toContain`, so a step that moves —
 * the authority check drifting ahead of the mutex, say — fails instead of
 * passing on presence alone. */
const shape = (order: readonly string[]): string[] => order.map((sql) => {
  if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) return sql
  // The two `lock_timeout` statements are DISTINCT symbols on purpose. Folding
  // them together would let the disarm move, or vanish, unnoticed — and the
  // disarm is what keeps the ceiling on the mutex acquisition instead of on
  // every lock the projection takes afterwards.
  if (sql.includes('lock_timeout = 0')) return 'TIMEOUT_OFF'
  if (sql.includes('lock_timeout')) return 'TIMEOUT'
  if (sql.includes('pg_advisory_xact_lock')) return 'MUTEX'
  if (sql.includes('read_model_static_workspaces')) return 'AUTHORITY'
  return sql
})

describe('withReadModelProjectionTransaction', () => {
  it('opens every transaction with the timeout, the mutex, then the authority check — in that order', async () => {
    const { client, pool, poolQuery, order } = fakeClient(false)
    await expect(withReadModelProjectionTransaction(pool, WS, 'ordinary', async (tx) => {
      expect(tx).toBe(client)
      order.push('ACTION')
      return 42
    })).resolves.toBe(42)

    // The mutex is FIRST of the two locks-or-checks and the authority check is
    // second: a writer that has lost the plane must hold the mutex for one
    // primary-key lookup, never for a whole cold build, and the check must be
    // under the mutex or two writers can both pass it.
    //
    // AND THE DISARM COMES AFTER THE AUTHORITY CHECK, not before it.
    // `assertReadModelPlane` takes `FOR KEY SHARE` on the authority row — the
    // SECOND blocking wait of this transaction, and the one a demotion's
    // `DELETE` contends. Disarming earlier would leave that wait unbounded
    // while this transaction holds the projection mutex. The disarm still
    // precedes the ACTION, so the action's own locks (the session-scoped
    // `overlay-rotation` key) may be waited on without the ceiling.
    expect(shape(order)).toEqual(['BEGIN', 'TIMEOUT', 'MUTEX', 'AUTHORITY', 'TIMEOUT_OFF', 'ACTION', 'COMMIT'])
    expect(client.release).toHaveBeenCalledOnce()

    // EVERY one of them on the transaction's client, and NOTHING on the pool.
    // `toEqual([...])` above only proves the statements were issued somewhere;
    // this is what proves they were issued where they mean something.
    expect(poolQuery).not.toHaveBeenCalled()
    // Four: arm the ceiling, take the mutex, disarm the ceiling, check the plane.
    expect(client.query.mock.calls.filter(([sql]) =>
      String(sql).includes('lock_timeout')
      || String(sql).includes('pg_advisory_xact_lock')
      || String(sql).includes('read_model_static_workspaces'))).toHaveLength(4)
    // The disarm is a real statement on the transaction's client, not a symbol
    // this test's `shape()` invented: pinned literally, because the whole point
    // is that it is `0` (disabled) and not some other number.
    expect(order).toContain('SET LOCAL lock_timeout = 0')

    // The mutex key comes from the shared builder, not from a string written
    // out here. Two writers formatting the same key by hand is a mutex that
    // one typo silently disables, with a phantom row as the only symptom.
    const mutexArgs = client.query.mock.calls
      .find(([sql]) => String(sql).includes('pg_advisory_xact_lock'))?.[1]
    expect(mutexArgs).toEqual([projectionMutexKey(WS)])
    // Spelled out as well as derived: the line above alone would agree with any
    // key the builder happened to return, including a constant one.
    expect(mutexArgs).toEqual(['read-model-projection:land:version'])
    // A LITERAL, not `PROJECTION_MUTEX_WAIT_MS` — a bound derived from the
    // constant under test agrees with any value that constant is given.
    expect(order.find((sql) => sql.includes('lock_timeout'))).toBe("SET LOCAL lock_timeout = '5000ms'")
    expect(PROJECTION_MUTEX_WAIT_MS).toBeLessThan(30_000)
  })

  it('refuses the ORDINARY plane on a static workspace, before the action runs', async () => {
    const { client, pool, order } = fakeClient(true)
    const action = vi.fn(async () => { order.push('ACTION'); return 1 })
    await expect(withReadModelProjectionTransaction(pool, WS, 'ordinary', action))
      .rejects.toBeInstanceOf(ReadModelPlaneError)
    // Never ran, and rolled back: the refusal has to happen before any row is
    // touched, or the phantom it exists to prevent is already written.
    expect(action).not.toHaveBeenCalled()
    // NO `TIMEOUT_OFF`, because the disarm sits below the authority check: a
    // refused transaction throws AT the check, so it rolls
    // back with the ceiling still armed. Nothing runs under it afterwards.
    expect(shape(order)).toEqual(['BEGIN', 'TIMEOUT', 'MUTEX', 'AUTHORITY', 'ROLLBACK'])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('refuses the STATIC plane on an ordinary workspace, before the action runs', async () => {
    const { client, pool, order } = fakeClient(false)
    const action = vi.fn(async () => { order.push('ACTION'); return 1 })
    await expect(withReadModelProjectionTransaction(pool, WS, 'static', action))
      .rejects.toBeInstanceOf(ReadModelPlaneError)
    expect(action).not.toHaveBeenCalled()
    expect(shape(order)).toEqual(['BEGIN', 'TIMEOUT', 'MUTEX', 'AUTHORITY', 'ROLLBACK'])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('admits the STATIC plane on a static workspace — the two planes are complementary, not both-deny', async () => {
    // The liveness witness for the two refusals above. Without it, a predicate
    // that denied EVERYTHING would pass both of them.
    const { pool, order } = fakeClient(true)
    await expect(withReadModelProjectionTransaction(pool, WS, 'static', async () => {
      order.push('ACTION')
      return 7
    })).resolves.toBe(7)
    expect(shape(order)).toEqual(['BEGIN', 'TIMEOUT', 'MUTEX', 'AUTHORITY', 'TIMEOUT_OFF', 'ACTION', 'COMMIT'])
  })

  it('rolls back when the publication fails, and still releases', async () => {
    const { client, pool, order } = fakeClient(false)
    await expect(withReadModelProjectionTransaction(pool, WS, 'ordinary', async () => {
      order.push('ACTION')
      throw new Error('feed failed')
    })).rejects.toThrow('feed failed')
    expect(shape(order)).toEqual(['BEGIN', 'TIMEOUT', 'MUTEX', 'AUTHORITY', 'TIMEOUT_OFF', 'ACTION', 'ROLLBACK'])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('still issues all four on a caller-scoped client, which is what lets a fake assert them', async () => {
    // The non-connectable path issues the same opening statements without
    // opening a transaction of its own.
    //
    // What this pins, precisely: the STATEMENTS are issued on whatever client
    // it is handed — not that the protocol HOLDS on such a client. Outside a
    // transaction these statements are inert (`SET LOCAL` only warns and
    // leaves `lock_timeout` at 0, and `pg_advisory_xact_lock` is released by
    // its own implicit commit), so the protocol holds only if the caller is
    // itself inside a transaction — its obligation, not something proved here.
    const order: string[] = []
    const scoped = {
      query: vi.fn(async (sql: string) => {
        order.push(String(sql))
        if (String(sql).includes('read_model_static_workspaces')) return { rows: [{ present: true }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
    } as unknown as Queryable
    await withReadModelProjectionTransaction(scoped, WS, 'static', async () => { order.push('ACTION') })
    expect(shape(order)).toEqual(['TIMEOUT', 'MUTEX', 'AUTHORITY', 'TIMEOUT_OFF', 'ACTION'])
  })

  it('a FAILED rollback destroys the connection instead of returning it holding the mutex', async () => {
    // The wedge this forbids: a client returned to the pool still inside its
    // transaction still holds `pg_advisory_xact_lock` for the workspace, so
    // every later projection AND every lifecycle transition for it waits on a
    // lock with no visible holder. `release(err)` makes the pool destroy the
    // connection, and ending the session is the only thing that returns an
    // advisory lock.
    //
    // Both halves are asserted: that the ORIGINAL error still propagates (a
    // rollback failure must not replace the one that explains the failure), and
    // that release() was told to destroy.
    const release = vi.fn()
    const client = {
      release,
      query: vi.fn(async (sql: string) => {
        if (String(sql).startsWith('ROLLBACK')) throw new Error('connection terminated')
        if (String(sql).includes('read_model_static_workspaces')) return { rows: [{ present: false }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
    }
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Queryable

    await expect(withReadModelProjectionTransaction(pool, WS, 'ordinary', async () => {
      throw new Error('the publication failed')
    })).rejects.toThrow('the publication failed')

    expect(release).toHaveBeenCalledOnce()
    const [destroyArg] = release.mock.calls[0] as [unknown]
    expect(destroyArg).toBeTruthy()
  })

  it('a SUCCESSFUL rollback returns the connection to the pool intact', async () => {
    // The control for the test above. Without it, "release was called with
    // something truthy" could be satisfied by always destroying — which would
    // throw away a healthy connection on every failed publication, and no
    // assertion here would notice.
    const { client, pool } = fakeClient(false)
    await expect(withReadModelProjectionTransaction(pool, WS, 'ordinary', async () => {
      throw new Error('the publication failed')
    })).rejects.toThrow('the publication failed')
    expect(client.release).toHaveBeenCalledOnce()
    const [destroyArg] = client.release.mock.calls[0] as [unknown]
    expect(destroyArg).toBeUndefined()
  })

  it('a REAL PoolClient takes the caller-scoped path — it has connect(), and calling it throws', async () => {
    // The test above cannot see this, because its fake has no `connect` at
    // all. A real `PoolClient` is a `Client` with `release` monkey-patched on
    // by pg-pool, so it INHERITS `Client.prototype.connect` — a predicate of
    // `typeof db.connect === 'function'` would send every caller-scoped client
    // down the pool branch to die on
    // `Client has already been connected. You cannot reuse a client.`
    //
    // The fake below reproduces both halves of the real object as of pg 8.21
    // (an inherited `connect` that throws, an own `release`) so the predicate
    // is exercised on the shape that actually exists.
    const connect = vi.fn(async () => {
      throw new Error('Client has already been connected. You cannot reuse a client.')
    })
    const order: string[] = []
    const poolClientLike = Object.assign(
      Object.create({ connect }) as { connect: typeof connect },
      {
        release: vi.fn(),
        query: vi.fn(async (sql: string) => {
          order.push(String(sql))
          if (String(sql).includes('read_model_static_workspaces')) return { rows: [{ present: false }], rowCount: 1 }
          return { rows: [], rowCount: 0 }
        }),
      },
    ) as unknown as Queryable

    await withReadModelProjectionTransaction(poolClientLike, WS, 'ordinary', async (tx) => {
      expect(tx).toBe(poolClientLike)
      order.push('ACTION')
    })

    // No BEGIN and no COMMIT: this client's transaction is the caller's.
    expect(shape(order)).toEqual(['TIMEOUT', 'MUTEX', 'AUTHORITY', 'TIMEOUT_OFF', 'ACTION'])
    expect(connect).not.toHaveBeenCalled()
    // And it is NOT released here either — the caller owns its lifetime.
    expect((poolClientLike as unknown as { release: ReturnType<typeof vi.fn> }).release).not.toHaveBeenCalled()
  })
})
