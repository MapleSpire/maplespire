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

import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { startWorkspaceCacheInvalidation, WORKSPACE_ROUTE_CHANGED_CHANNEL, type WorkspaceCacheInvalidationHandle } from '../rbac/workspaceCacheInvalidation.js'
import { ensureSyncCellOwnershipSchema } from './ownership.js'
import { ensureWorkspaceRouteInvalidationSchema } from './workspaceRouteInvalidationSchema.js'
import { getSharedWorkspaceRouteResolver, type InvalidatableWorkspaceRouteResolver } from './workspaceRoute.js'

// Real PostgreSQL clients, one Node process. The independent two-cell bench is
// still required to qualify application-process wiring and HTTP routing cost.
describe.skipIf(!process.env.TEST_DATABASE_URL)('canonical routes invalidated by committed lifecycle SQL', () => {
  let db: IsolatedSchemaDb
  let foreign: IsolatedSchemaDb
  let writer: pg.Pool
  let notifier: pg.Pool
  let listener: WorkspaceCacheInvalidationHandle | undefined
  let resolver: InvalidatableWorkspaceRouteResolver
  const events: Array<string | null> = []
  let sequence = 0

  const payload = (landscapeId: string | null, schema = db.schema) => JSON.stringify({ schema, landscapeId })
  const resolveKey = (landscapeId: string, versionId: string) => resolver(db.pool, { landscapeId, versionId })
  const createTables = async (pool: pg.Pool) => {
    await pool.query(`
      CREATE TABLE landscapes (id TEXT PRIMARY KEY, default_version_id TEXT, name TEXT);
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active',
        base_manifest JSONB
      );
    `)
  }
  const releaseTransaction = async (transaction: pg.PoolClient, rollback: boolean) => {
    let failure: Error | undefined
    try {
      if (rollback) await transaction.query('ROLLBACK')
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    } finally { transaction.release(failure) }
    if (failure) throw failure
  }
  const barrier = async () => {
    const marker = `route-invalidation-barrier-${++sequence}`
    await notifier.query('SELECT pg_notify($1, $2)', [WORKSPACE_ROUTE_CHANGED_CHANNEL, payload(marker)])
    await vi.waitFor(() => expect(events).toContain(marker), { timeout: 5_000, interval: 10 })
  }
  const seed = async (landscapeId: string) => {
    const first = `${landscapeId}-v1`, second = `${landscapeId}-v2`
    await writer.query('INSERT INTO landscapes(id, default_version_id) VALUES ($1, $2)', [landscapeId, first])
    await writer.query('INSERT INTO versions(id, landscape_id) VALUES ($1, $3), ($2, $3)', [first, second, landscapeId])
    await barrier()
    events.length = 0
    resolver.invalidate(landscapeId)
    return { first, second }
  }
  const mutate = async (landscapeId: string, sql: string, values: unknown[]) => {
    events.length = 0
    await writer.query(sql, values)
    await barrier()
    expect(events, 'a manual barrier is not evidence that the table trigger ran').toContain(landscapeId)
  }

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(process.env.TEST_DATABASE_URL!, 'workspace_route_invalidation')
    foreign = await createIsolatedSchemaDb(process.env.TEST_DATABASE_URL!, 'workspace_route_invalidation_other')
    await createTables(db.pool)
    await createTables(foreign.pool)
    // Use the actual baseline entry point so deleting its helper call fails
    // the lifecycle arms. Run twice to exercise idempotent installation.
    await ensureSyncCellOwnershipSchema(db.pool)
    await ensureSyncCellOwnershipSchema(db.pool)
    await ensureWorkspaceRouteInvalidationSchema(foreign.pool)
    writer = guardIdleClientErrors(new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1,
      connectionTimeoutMillis: 3_000, options: `-c search_path=${db.schema}` }), 'route-invalidation-writer')
    notifier = guardIdleClientErrors(new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1,
      connectionTimeoutMillis: 3_000, options: `-c search_path=${db.schema}` }), 'route-invalidation-notifier')
    resolver = getSharedWorkspaceRouteResolver(db.pool)
    listener = startWorkspaceCacheInvalidation(db.pool, {
      onCoverageChanged: () => {}, onVersionCreated: () => {},
      onRouteChanged: landscapeId => {
        events.push(landscapeId)
        if (landscapeId === null) resolver.invalidateAll()
        else resolver.invalidate(landscapeId)
      },
    }, { reconnectMs: 20 })
    // Positive subscription witness: repeat a schema-scoped diagnostic until
    // it is actually received. This is calibration, not a lifecycle verdict.
    await vi.waitFor(async () => {
      await notifier.query('SELECT pg_notify($1, $2)', [WORKSPACE_ROUTE_CHANGED_CHANNEL, payload('route-listener-ready')])
      expect(events).toContain('route-listener-ready')
    }, { timeout: 5_000, interval: 20 })
  })

  afterAll(async () => {
    const closed = await Promise.allSettled([listener?.stop(), writer?.end(), notifier?.end()])
    const removed = await Promise.allSettled([foreign?.teardown(), db?.teardown()])
    const errors = [...closed, ...removed].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Route invalidation integration cleanup failed')
  })

  it('invalidates current and concrete entries after a sibling-connection default-version COMMIT', async () => {
    const landscapeId = 'L-route-repoint'
    const { first, second } = await seed(landscapeId)
    const sql = vi.spyOn(db.pool, 'query')
    try {
      await expect(resolveKey(landscapeId, 'current')).resolves.toEqual({ landscapeId, versionId: first })
      await expect(resolveKey(landscapeId, first)).resolves.toEqual({ landscapeId, versionId: first })
      expect(sql).toHaveBeenCalledTimes(2)
      await mutate(landscapeId, 'UPDATE landscapes SET default_version_id=$2 WHERE id=$1', [landscapeId, second])
      await expect(resolveKey(landscapeId, 'current')).resolves.toEqual({ landscapeId, versionId: second })
      await expect(resolveKey(landscapeId, first)).resolves.toEqual({ landscapeId, versionId: first })
      expect(sql).toHaveBeenCalledTimes(4)
    } finally { sql.mockRestore() }
  })

  it('invalidates active versions on retirement, reactivation, insert and deletion', async () => {
    const landscapeId = 'L-route-version'
    const { first, second } = await seed(landscapeId)
    await expect(resolveKey(landscapeId, first)).resolves.toEqual({ landscapeId, versionId: first })
    await mutate(landscapeId, 'UPDATE versions SET status=$2 WHERE id=$1', [first, 'archived'])
    await expect(resolveKey(landscapeId, first)).resolves.toBeNull()
    await mutate(landscapeId, 'UPDATE versions SET status=$2 WHERE id=$1', [first, 'active'])
    await expect(resolveKey(landscapeId, first)).resolves.toEqual({ landscapeId, versionId: first })
    await mutate(landscapeId, 'INSERT INTO versions(id,landscape_id) VALUES ($1,$2)', [`${landscapeId}-v3`, landscapeId])
    await expect(resolveKey(landscapeId, second)).resolves.toEqual({ landscapeId, versionId: second })
    await mutate(landscapeId, 'DELETE FROM versions WHERE id=$1', [second])
    await expect(resolveKey(landscapeId, second)).resolves.toBeNull()
  })

  it('ignores unrelated writes and unchanged routing values, with a real lifecycle control', async () => {
    const landscapeId = 'L-route-irrelevant'
    const { first } = await seed(landscapeId)
    await resolveKey(landscapeId, 'current')
    await resolveKey(landscapeId, first)
    events.length = 0
    await writer.query('UPDATE versions SET base_manifest=$2::jsonb WHERE id=$1', [first, JSON.stringify({ heads: ['unchanged-route'] })])
    await writer.query('UPDATE landscapes SET name=$2 WHERE id=$1', [landscapeId, 'rename only'])
    await writer.query('UPDATE versions SET status=status WHERE id=$1', [first])
    await writer.query('UPDATE landscapes SET default_version_id=default_version_id WHERE id=$1', [landscapeId])
    await barrier()
    expect(events).not.toContain(landscapeId)
    const sql = vi.spyOn(db.pool, 'query')
    try {
      await resolveKey(landscapeId, 'current')
      await resolveKey(landscapeId, first)
      expect(sql).not.toHaveBeenCalled()
    } finally { sql.mockRestore() }
    await mutate(landscapeId, 'UPDATE versions SET status=$2 WHERE id=$1', [first, 'archived'])
    await expect(resolveKey(landscapeId, first)).resolves.toBeNull()
  })

  it('invalidates the old and new landscape when a concrete version changes landscape', async () => {
    const oldLandscape = 'L-route-old', newLandscape = 'L-route-new'
    const { first } = await seed(oldLandscape)
    await seed(newLandscape)
    await expect(resolveKey(oldLandscape, first)).resolves.toEqual({ landscapeId: oldLandscape, versionId: first })
    await mutate(oldLandscape, 'UPDATE versions SET landscape_id=$2 WHERE id=$1', [first, newLandscape])
    expect(events).toContain(newLandscape)
    await expect(resolveKey(oldLandscape, first)).resolves.toBeNull()
    await expect(resolveKey(newLandscape, first)).resolves.toEqual({ landscapeId: newLandscape, versionId: first })
  })

  it('does not invalidate before COMMIT or on ROLLBACK, then detects the committed control', async () => {
    const landscapeId = 'L-route-rollback'
    const { first } = await seed(landscapeId)
    await expect(resolveKey(landscapeId, first)).resolves.toEqual({ landscapeId, versionId: first })
    events.length = 0
    const transaction = await writer.connect()
    let inTransaction = false
    try {
      await transaction.query('BEGIN')
      inTransaction = true
      await transaction.query('UPDATE versions SET status=$2 WHERE id=$1', [first, 'archived'])
      await barrier()
      expect(events).not.toContain(landscapeId)
      await expect(resolveKey(landscapeId, first)).resolves.toEqual({ landscapeId, versionId: first })
      await transaction.query('ROLLBACK')
      inTransaction = false
      await barrier()
      expect(events).not.toContain(landscapeId)
    } finally {
      await releaseTransaction(transaction, inTransaction)
    }
    await mutate(landscapeId, 'UPDATE versions SET status=$2 WHERE id=$1', [first, 'archived'])
    await expect(resolveKey(landscapeId, first)).resolves.toBeNull()
  })

  it('ignores actual lifecycle and whole-table notifications from another schema', async () => {
    const landscapeId = 'L-route-foreign'
    const { first, second } = await seed(landscapeId)
    await foreign.pool.query('INSERT INTO landscapes(id, default_version_id) VALUES ($1,$2)', [landscapeId, first])
    await foreign.pool.query('INSERT INTO versions(id, landscape_id) VALUES ($1,$2)', [first, landscapeId])
    await barrier()
    const sql = vi.spyOn(db.pool, 'query')
    try {
      await expect(resolveKey(landscapeId, first)).resolves.toEqual({ landscapeId, versionId: first })
      expect(sql).toHaveBeenCalledTimes(1)
      events.length = 0
      await foreign.pool.query('UPDATE landscapes SET default_version_id=$2 WHERE id=$1', [landscapeId, second])
      await foreign.pool.query('TRUNCATE versions')
      await barrier()
      expect(events).not.toContain(landscapeId)
      expect(events).not.toContain(null)
      await expect(resolveKey(landscapeId, first)).resolves.toEqual({ landscapeId, versionId: first })
      expect(sql).toHaveBeenCalledTimes(1)
    } finally { sql.mockRestore() }
  })

  it('invalidates landscape deletion and a same-schema TRUNCATE of the versions table', async () => {
    const landscapeId = 'L-route-delete'
    const { first } = await seed(landscapeId)
    await expect(resolveKey(landscapeId, first)).resolves.toEqual({ landscapeId, versionId: first })
    await mutate(landscapeId, 'DELETE FROM landscapes WHERE id=$1', [landscapeId])
    await expect(resolveKey(landscapeId, first)).resolves.toBeNull()
    const survivor = 'L-route-truncate'
    const seeded = await seed(survivor)
    await expect(resolveKey(survivor, seeded.first)).resolves.toEqual({ landscapeId: survivor, versionId: seeded.first })
    events.length = 0
    await writer.query('TRUNCATE versions CASCADE')
    await barrier()
    expect(events).toContain(null)
    await expect(resolveKey(survivor, seeded.first)).resolves.toBeNull()
  })
})
