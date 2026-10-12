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
 * THE WIRE BETWEEN THE CONFIG AND THE POOL.
 *
 * `dbConfig.test.ts` pins that `lifecycleApplyDatabasePoolConfig()` returns
 * `{max: 4, connectionTimeoutMillis: 2000}`, and
 * `lifecycleApplyLockCallers.test.ts` pins that all six production doors pass
 * the IDENTIFIER `lifecycleApplyPool`. This suite pins that the identifier
 * names a DISTINCT pool built from that config.
 *
 *     export const lifecycleApplyPool = pool
 *
 * would leave both of those green while the bulkhead did not exist and the
 * advisory-lock pin landed back on the primary pool.
 *
 * These assertions cost nothing at runtime: constructing a `pg.Pool` opens no
 * socket, so importing `db.ts` here is inert. No `TEST_DATABASE_URL` is needed
 * and this suite therefore cannot self-skip — which matters, because a suite
 * that skips is indistinguishable from one that passes in the summary line.
 */
import { describe, expect, it } from 'vitest'
import { lifecycleApplyPool, pool, readModelPool, syncCellPool } from './db.js'

describe('the four module-scope pools are four different pools', () => {
  const pools = { pool, readModelPool, syncCellPool, lifecycleApplyPool }

  it('is not an alias of any other pool', () => {
    // Pairwise, not just against `pool`: aliasing the lifecycle pool onto the
    // read-model or sync-cell pool would be just as wrong and just as invisible.
    const entries = Object.entries(pools)
    for (const [nameA, a] of entries) {
      for (const [nameB, b] of entries) {
        if (nameA === nameB) continue
        expect(a, `${nameA} and ${nameB} are the same object`).not.toBe(b)
      }
    }
  })

  it('carries the bulkhead\'s OWN numbers, not the primary pool\'s', () => {
    // `pg.Pool` exposes the resolved config as `options`. This is the assertion
    // that would fail on `export const lifecycleApplyPool = pool`.
    const options = (lifecycleApplyPool as unknown as { options: { max?: number; connectionTimeoutMillis?: number } }).options
    expect(options.max).toBe(4)
    expect(options.connectionTimeoutMillis).toBe(2_000)
  })

  it('is bounded BELOW the primary pool on both axes', () => {
    // Stated as a relation rather than two literals, so it keeps meaning if the
    // primary pool is retuned. A lifecycle pool as large as the primary one
    // would not be a bulkhead, and one that waited as long would not fail fast.
    const of = (p: unknown) => (p as { options: { max?: number; connectionTimeoutMillis?: number } }).options
    expect(of(lifecycleApplyPool).max!).toBeLessThan(of(pool).max!)
    expect(of(lifecycleApplyPool).connectionTimeoutMillis!)
      .toBeLessThan(of(pool).connectionTimeoutMillis!)
  })

  it('reaches the SAME database as the primary pool', () => {
    // Load-bearing, and it is the assumption that makes the split safe at all:
    // `pg_try_advisory_lock` is DATABASE-scoped, so a token taken on this pool
    // excludes a door holding one on the primary pool. A future
    // `LIFECYCLE_APPLY_DATABASE_URL` would silently evaporate that exclusion —
    // both doors would succeed at once on the same workspace — and this arm is
    // what would refuse it.
    const of = (p: unknown) => (p as {
      options: { connectionString?: string; host?: string; port?: number; database?: string }
    }).options
    const lifecycle = of(lifecycleApplyPool)
    const primary = of(pool)
    expect(lifecycle.connectionString).toBe(primary.connectionString)
    expect(lifecycle.host).toBe(primary.host)
    expect(lifecycle.port).toBe(primary.port)
    expect(lifecycle.database).toBe(primary.database)
  })
})
