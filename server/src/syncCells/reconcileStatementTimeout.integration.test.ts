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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createClient } from 'redis'
import pg from 'pg'
import { createIsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { syncCellDatabasePoolConfig } from '../dbConfig.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import {
  SyncCellOwnershipCoordinator,
  ensureSyncCellOwnershipSchema,
  type SyncCellOwnershipConfig,
} from './ownership.js'
import { ceilingIsUnbounded, isLockTimeout, isServerImposedCeiling } from '../db/statementTimeout.js'
import type { RedisRuntime } from '../runtime/redis.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_REDIS_URL = process.env.TEST_REDIS_URL

/**
 * Reconcile statements are bounded by server-side ceilings.
 *
 * THE FAILURE: `performReconcile` chains several queries, and `reconcileNow`
 * hands every later caller the same `reconcileFlight` promise whose `.finally`
 * cannot run while it is pending. Without a ceiling, one blocked statement
 * freezes every later pass forever, while `ready` stays true and `errorCount`
 * stays 0.
 *
 * THE REMEDY IS ON THE CONNECTION, so this file builds its pool the way
 * production does — `syncCellDatabasePoolConfig`, which puts `statement_timeout`
 * and `lock_timeout` in the startup packet — with the ceilings turned down so
 * they fire inside a test's patience instead of in 30 s.
 *
 * WHICH CEILING FIRES IS PART OF THE CLAIM. The block is `LOCK TABLE … ACCESS
 * EXCLUSIVE`, which is a LOCK WAIT: PostgreSQL ends it with `55P03`
 * (`lock_not_available`), not `57014`. Without `lock_timeout`,
 * `statement_timeout` would sweep the lock wait up with everything else and
 * report `57014`; asserting the specific code is what keeps `lock_timeout`
 * from being quietly removed.
 *
 * WHY IT MUST BE AN INTEGRATION TEST. The bound is applied by the server. A fake
 * can raise `55P03` on a schedule of its own choosing and would stay green
 * against a pool built with no ceilings at all.
 */
describe.skipIf(!TEST_DATABASE_URL || !TEST_REDIS_URL)('reconcile survives a blocked statement', () => {
  let db: Awaited<ReturnType<typeof createIsolatedSchemaDb>>
  let bounded: pg.Pool
  let redis: ReturnType<typeof createClient>
  let blocker: pg.Client
  let coordinator: SyncCellOwnershipCoordinator

  /** Turned down from the 30 s / 2 s production defaults so both fire inside a
   *  test's patience. The RELATION is what matters and is preserved: the lock
   *  ceiling is well under the statement ceiling, so a lock wait is ended by
   *  `lock_timeout` and reported as such. */
  const STATEMENT_MS = 4_000
  const LOCK_MS = 800

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, `sync_cell_tb4q_gate_${randomBytes(4).toString('hex')}`)
    redis = createClient({ url: TEST_REDIS_URL })
    await redis.connect()

    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT);
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        kind TEXT NOT NULL DEFAULT 'version'
      );
    `)
    await ensureSyncCellOwnershipSchema(db.pool)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', ['tb4q', 'tb4q'])
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url, status, kind)
       VALUES ('v1', 'tb4q', 'v1', 'automerge:root-1', 'active', 'version')`,
    )

    // The coordinator's pool, built through the PRODUCTION factory rather than
    // by hand: a hand-built pool here would prove the ceilings work while saying
    // nothing about whether the factory sets them.
    bounded = guardIdleClientErrors(new pg.Pool({
      ...syncCellDatabasePoolConfig({
        DATABASE_URL: TEST_DATABASE_URL,
        SYNC_CELL_STATEMENT_TIMEOUT_MS: String(STATEMENT_MS),
        SYNC_CELL_LOCK_TIMEOUT_MS: String(LOCK_MS),
      }),
      options: `-c search_path=${db.schema}`,
    }), 'tb4qGate:bounded')

    // A SECOND connection for the lock, outside the pool under test: taking it
    // from `bounded` could starve that pool and would confound "blocked on a
    // lock" with "blocked waiting for a client" — two failures, one symptom.
    blocker = new pg.Client({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${db.schema}` })
    await blocker.connect()

    const config = {
      enabled: true,
      cellId: 'tb4q-gate',
      advertiseUrl: null,
      leaseTtlMs: 600_000,
      renewIntervalMs: 300_000,
      partitionLeaseTtlMs: 60_000,
      partitionRenewIntervalMs: 20_000,
      partitionProbeIntervalMs: 60_000,
      partitionWorker: false,
      reconcileIntervalMs: 3_600_000,
      telemetryIntervalMs: 3_600_000,
      concurrency: 4,
      admissionConcurrency: 4,
      partitionCount: 1,
      topologyGeneration: `tb4q-gate-${randomBytes(3).toString('hex')}`,
    } as SyncCellOwnershipConfig

    const runtime = {
      configured: true,
      get ready() { return redis.isReady },
      prefix: `tb4q-gate-${randomBytes(6).toString('hex')}`,
      send<T>(args: string[]) { return redis.sendCommand(args) as Promise<T> },
    } as unknown as RedisRuntime

    coordinator = new SyncCellOwnershipCoordinator(bounded, runtime, config)
    await coordinator.start()
  }, 120_000)

  afterAll(async () => {
    await coordinator?.stop().catch(() => undefined)
    await blocker?.query('ROLLBACK').catch(() => undefined)
    await blocker?.end().catch(() => undefined)
    await bounded?.end().catch(() => undefined)
    await redis?.quit().catch(() => undefined)
    await db?.teardown().catch(() => undefined)
  }, 120_000)

  it('the factory really put the ceilings on the connection', () => {
    // Read back from the SERVER at start, not from the config object. This is
    // the arm that fails if `syncCellDatabasePoolConfig` stops setting them, if
    // the pool is built from the wrong factory, or if an operator blanks the
    // variable — `0` being PostgreSQL's own word for "no ceiling".
    const snapshot = coordinator.snapshot()
    expect(snapshot.effectiveStatementTimeout).not.toBeNull()
    expect(ceilingIsUnbounded(snapshot.effectiveStatementTimeout!)).toBe(false)
    expect(ceilingIsUnbounded(snapshot.effectiveLockTimeout!)).toBe(false)
  })

  it('an unblocked pass settles, and nothing was cancelled to make it', async () => {
    // The CONTROL, and it is what makes the next arm mean something: without it,
    // "it rejected" cannot be told from a coordinator that rejects everything.
    // It asserts a COUNTER rather than the slowest-statement gauge, because that
    // gauge is a window max and an assertion on it would silently depend on
    // which arm ran first.
    const before = coordinator.snapshot().serverCeilingFiredCount
    await expect(coordinator.reconcileNow()).resolves.toBeUndefined()
    expect(coordinator.snapshot().serverCeilingFiredCount).toBe(before)
  }, 60_000)

  it('a blocked statement is ended by the SERVER, and the NEXT pass still runs', async () => {
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE versions IN ACCESS EXCLUSIVE MODE')
    try {
      const first = await coordinator.reconcileNow().then(() => null, (error: unknown) => error)
      // `55P03`, specifically: a lock wait ended by `lock_timeout`. Not a
      // client-side race — a race would have left the statement running and
      // orphaned the connection.
      expect(isLockTimeout(first)).toBe(true)

      // THE CORE PROPERTY. Without the ceilings this returns the same pending
      // promise and never settles, so the test would time out here rather than
      // fail an assertion.
      const second = await coordinator.reconcileNow().then(() => null, (error: unknown) => error)
      expect(isServerImposedCeiling(second)).toBe(true)

      expect(coordinator.snapshot().serverCeilingFiredCount).toBeGreaterThanOrEqual(2)
    } finally {
      await blocker.query('ROLLBACK')
    }
  }, 60_000)

  it('recovers on its own once the block clears — no restart, no manual step', async () => {
    // Takes and releases its OWN lock rather than leaning on the previous arm's
    // `finally`. A precondition supplied by a sibling is one that disappears the
    // day someone reorders or skips that sibling — and this file's subject is a
    // state that persists once entered, so an arm inheriting a cleared one would
    // prove nothing.
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE versions IN ACCESS EXCLUSIVE MODE')
    const blocked = await coordinator.reconcileNow().then(() => null, (error: unknown) => error)
    expect(isServerImposedCeiling(blocked)).toBe(true)
    await blocker.query('ROLLBACK')

    await expect(coordinator.reconcileNow()).resolves.toBeUndefined()
    expect(coordinator.snapshot().ownedWorkspaceCount).toBe(1)
  }, 60_000)
})
