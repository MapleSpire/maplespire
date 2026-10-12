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

import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createClient } from 'redis'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { WorkspaceKey } from '../rbac/docScope.js'
import type { RedisRuntime } from '../runtime/redis.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { workspacePartition } from './assignment.js'
import {
  ensureSyncCellOwnershipSchema,
  StaleDurableFenceError,
  SyncCellOwnershipCoordinator,
  syncCellOwnershipConfig,
  type FencedLease,
} from './ownership.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_REDIS_URL = process.env.TEST_REDIS_URL
type Lease = FencedLease & { workspace: WorkspaceKey; validUntil: number }
type Internals = {
  partitionWorker: { lastRenewStartedAt: () => number } | null
  leases: Map<string, Lease>
  renewWorkspaceLeases(): Promise<void>
  persistLease(lease: Lease, intent: 'acquire'): Promise<void>
}
const internals = (cell: SyncCellOwnershipCoordinator) => cell as unknown as Internals

// Real PostgreSQL, Redis Lua and coordinator acquisition. The injected mapping
// models the two cells observing a placement change; it does not qualify the
// SELECT/NOTIFY transport. Only the recovery test supplies a simulated Worker
// heartbeat, to enter the real workspace lease recovery path.
describe.skipIf(!TEST_DATABASE_URL || !TEST_REDIS_URL)('workspace move ledger (T-14a)', () => {
  const prefix = `test:move-ledger:${randomBytes(8).toString('hex')}`
  const redis = createClient({ url: TEST_REDIS_URL })
  const runtime = {
    configured: true,
    get ready() { return redis.isReady },
    prefix,
    send<T>(args: string[]) { return redis.sendCommand(args) as Promise<T> },
  } as unknown as RedisRuntime
  let db: IsolatedSchemaDb
  const cells: SyncCellOwnershipCoordinator[] = []
  const maps = new Map<SyncCellOwnershipCoordinator, Map<string, number>>()
  const key = (value: WorkspaceKey) => `${value.landscapeId}\u0000${value.versionId}`
  const workspace = Array.from({ length: 128 }, (_, index) => ({ landscapeId: 'land-ledger', versionId: `version-${index}` }))
    .find(value => workspacePartition(value, 2) === 0)!
  const digest = createHash('sha256').update(workspace.landscapeId).update(Buffer.from([0]))
    .update(workspace.versionId).digest('hex')
  const ownerKey = `${prefix}:sync-cell:owner:${digest}`
  const authorityKey = `${prefix}:sync-cell:authority:${digest}`
  const settings = (cellId: string) => syncCellOwnershipConfig({
    SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_ID: cellId,
    SYNC_CELL_TOPOLOGY_GENERATION: 'move-ledger', SYNC_CELL_PARTITION_COUNT: '2',
    SYNC_CELL_MULTI_PARTITION: 'on', SYNC_CELL_PLACEMENT_MODE: 'placed', SYNC_CELL_PARTITION_WORKER: 'off',
    SYNC_CELL_LEASE_TTL_MS: '60000', SYNC_CELL_RENEW_INTERVAL_MS: '25000',
    SYNC_CELL_PARTITION_LEASE_TTL_MS: '30000', SYNC_CELL_PARTITION_RENEW_INTERVAL_MS: '10000',
    SYNC_CELL_RECONCILE_INTERVAL_MS: '300000', SYNC_CELL_TELEMETRY_INTERVAL_MS: '300000',
  })
  async function boot() {
    for (const name of ['cell-source', 'cell-destination']) {
      const view = new Map<string, number>()
      const cell = new SyncCellOwnershipCoordinator(db.pool, runtime, settings(name), Date.now, {
        partitionOf: (value, count) => view.get(key(value)) ?? workspacePartition(value, count),
      })
      cells.push(cell)
      maps.set(cell, view)
      await cell.start()
    }
    expect(cells.map(cell => cell.snapshot().partitionIndex).sort()).toEqual([0, 1])
    const source = cells.find(cell => cell.snapshot().partitionIndex === 0)!
    const destination = cells.find(cell => cell.snapshot().partitionIndex === 1)!
    expect([source.owns(workspace), destination.owns(workspace)]).toEqual([true, false])
    return { source, destination }
  }
  async function durable(query: Pick<typeof db.pool, 'query'> = db.pool) {
    return (await query.query(
      'SELECT cell_id, fencing_token::text AS token, released_at IS NOT NULL AS released FROM sync_workspace_ownership WHERE landscape_id=$1 AND version_id=$2',
      [workspace.landscapeId, workspace.versionId],
    )).rows[0]
  }
  async function ledger(query: Pick<typeof db.pool, 'query'> = db.pool) {
    return (await query.query(`SELECT move_id::text, landscape_id, version_id, from_cell_id, to_cell_id,
      fencing_token::text AS token, moved_at FROM sync_workspace_placement_moves ORDER BY sync_workspace_placement_moves.move_id`)).rows
  }
  async function move(source: SyncCellOwnershipCoordinator, destination: SyncCellOwnershipCoordinator) {
    const before = await durable()
    maps.get(source)!.set(key(workspace), 1)
    maps.get(destination)!.set(key(workspace), 1)
    await source.reconcileNow()
    await destination.reconcileNow()
    expect([source.owns(workspace), destination.owns(workspace)]).toEqual([false, true])
    const after = await durable()
    expect(before.cell_id).toBe(source.snapshot().cellId)
    expect(after).toEqual({ cell_id: destination.snapshot().cellId, token: destination.fencingToken(workspace), released: false })
    expect(BigInt(after.token)).toBeGreaterThan(BigInt(before.token))
    return { before, after }
  }

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'move_ledger')
    await redis.connect()
    await db.pool.query(`
      CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT);
      CREATE TABLE versions (id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id),
        label TEXT NOT NULL, root_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
      INSERT INTO landscapes VALUES ('land-ledger', 'Ledger');
    `)
    await db.pool.query('INSERT INTO versions(id, landscape_id, label, root_url) VALUES ($1,$2,$3,$4)',
      [workspace.versionId, workspace.landscapeId, 'Main', 'unused-root'])
    await ensureSyncCellOwnershipSchema(db.pool)
  }, 120_000)
  afterEach(async () => {
    const errors: unknown[] = []
    while (cells.length) {
      const cell = cells.pop()!
      internals(cell).partitionWorker = null
      try { await cell.stop() } catch (error) { errors.push(error) }
    }
    maps.clear()
    try {
      const keys: string[] = []
      for await (const batch of redis.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) keys.push(...batch)
      if (keys.length) await redis.sendCommand(['DEL', ...keys])
    } catch (error) { errors.push(error) }
    try {
      await db.pool.query('DELETE FROM sync_workspace_ownership; DELETE FROM sync_topology_contract; DELETE FROM sync_workspace_placement_moves')
    } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Move ledger fixture cleanup failed')
  })
  afterAll(async () => {
    const errors: unknown[] = []
    try { if (redis.isOpen) await redis.close() } catch (error) { errors.push(error) }
    try { await db?.teardown() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Move ledger services cleanup failed')
  })

  it('records exactly one row after a real forced cell change, and none on initial acquisition', async () => {
    const { source, destination } = await boot()
    expect(await ledger()).toEqual([])
    const witness = await move(source, destination)
    // This positive PG witness precedes the ledger oracle: deleting the trigger
    // must fail for a missing row, not for a scenario that never moved anything.
    process.stdout.write(`[move-ledger] forced-cell-change ${JSON.stringify(witness)}\n`)
    const rows = await ledger()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ landscape_id: workspace.landscapeId, version_id: workspace.versionId,
      from_cell_id: source.snapshot().cellId, to_cell_id: destination.snapshot().cellId, token: witness.after.token })
    expect(rows[0]!.moved_at).toBeInstanceOf(Date)
    await destination.reconcileNow()
    expect(await ledger()).toEqual(rows)
  })

  it('records zero rows for a real same-cell lease recovery with a new fencing token', async () => {
    const { source, destination } = await boot()
    const old = internals(source).leases.get(key(workspace))!
    const observedAt = Date.now()
    internals(source).partitionWorker = { lastRenewStartedAt: () => observedAt }
    expect(await redis.get(ownerKey)).toBe(old.ownerValue)
    expect(JSON.parse((await redis.get(authorityKey))!).ownerValue).toBe(old.ownerValue)
    expect(await redis.del(ownerKey)).toBe(1)
    expect(source.owns(workspace)).toBe(true)
    await internals(source).renewWorkspaceLeases()
    const recovered = internals(source).leases.get(key(workspace))!
    expect(BigInt(recovered.token)).toBeGreaterThan(BigInt(old.token))
    expect(source.snapshot().workspaceLeaseRecoveryCount).toBe(1)
    expect([source.owns(workspace), destination.owns(workspace)]).toEqual([true, false])
    expect(await redis.get(ownerKey)).toBe(recovered.ownerValue)
    expect(JSON.parse((await redis.get(authorityKey))!).ownerValue).toBe(recovered.ownerValue)
    expect(await durable()).toEqual({ cell_id: source.snapshot().cellId, token: recovered.token, released: false })
    process.stdout.write(`[move-ledger] same-cell-recovery ${JSON.stringify({ before: old.token, after: recovered.token, recoveries: 1 })}\n`)
    expect(await ledger()).toEqual([])
  })

  it('admits through acquireMissing with 10,000 existing rows and appends the real move', async () => {
    const { source, destination } = await boot()
    await db.pool.query(`INSERT INTO sync_workspace_placement_moves
      (landscape_id, version_id, from_cell_id, to_cell_id, fencing_token)
      SELECT $1, $2, 'historical-a', 'historical-b', n FROM generate_series(1,10000) n`,
    [workspace.landscapeId, workspace.versionId])
    expect((await db.pool.query('SELECT count(*)::integer AS n FROM sync_workspace_placement_moves')).rows[0].n).toBe(10000)
    const started = performance.now()
    const witness = await move(source, destination)
    const elapsedMs = performance.now() - started
    const rows = await ledger()
    expect(rows).toHaveLength(10001)
    expect(rows.at(-1)).toMatchObject({ from_cell_id: source.snapshot().cellId, to_cell_id: destination.snapshot().cellId, token: witness.after.token })
    process.stdout.write(`[move-ledger] loaded-acquisition ${JSON.stringify({ existing: 10000, after: rows.length, elapsedMs })}\n`)
  })

  it('rolls the ledger back with ownership and exposes neither uncommitted change to a second connection', async () => {
    await boot()
    const before = await durable()
    const transaction = await db.pool.connect()
    try {
      await transaction.query('BEGIN')
      await transaction.query("UPDATE sync_workspace_ownership SET cell_id='transaction-cell', fencing_token=fencing_token+1")
      expect((await durable(transaction)).cell_id).toBe('transaction-cell')
      expect(await ledger(transaction)).toHaveLength(1)
      expect(await durable()).toEqual(before)
      expect(await ledger()).toEqual([])
    } finally {
      try { await transaction.query('ROLLBACK') } finally { transaction.release() }
    }
    expect(await durable()).toEqual(before)
    expect(await ledger()).toEqual([])
  })

  it('does not record a rejected stale fencing attempt after a real move', async () => {
    const { source, destination } = await boot()
    const old = internals(source).leases.get(key(workspace))!
    expect(old).toBeDefined()
    const { after } = await move(source, destination)
    expect(BigInt(old.token)).toBeLessThan(BigInt(after.token))
    const rows = await ledger()
    expect(rows).toHaveLength(1)
    await expect(internals(source).persistLease(old, 'acquire')).rejects.toBeInstanceOf(StaleDurableFenceError)
    expect(await durable()).toEqual(after)
    expect(await ledger()).toEqual(rows)
  })

  it('preserves history across repeated schema installation and version deletion', async () => {
    const { source, destination } = await boot()
    await move(source, destination)
    const rows = await ledger()
    expect(rows).toHaveLength(1)
    await ensureSyncCellOwnershipSchema(db.pool)
    await ensureSyncCellOwnershipSchema(db.pool)
    expect(await ledger()).toEqual(rows)
    maps.get(source)!.set(key(workspace), 0)
    maps.get(destination)!.set(key(workspace), 0)
    await destination.reconcileNow()
    await source.reconcileNow()
    expect([source.owns(workspace), destination.owns(workspace)]).toEqual([true, false])
    const returned = await durable()
    expect(returned.cell_id).toBe(source.snapshot().cellId)
    expect(BigInt(returned.token)).toBeGreaterThan(BigInt(rows[0]!.token))
    const reinstalledRows = await ledger()
    expect(reinstalledRows).toHaveLength(2)
    expect(reinstalledRows[0]).toEqual(rows[0])
    expect(reinstalledRows[1]).toMatchObject({ from_cell_id: destination.snapshot().cellId, to_cell_id: source.snapshot().cellId, token: returned.token })
    expect((await db.pool.query(`SELECT count(*)::integer AS n FROM pg_constraint
      WHERE conrelid='sync_workspace_placement_moves'::regclass AND contype='f'`)).rows[0].n).toBe(0)
    const transaction = await db.pool.connect()
    try {
      await transaction.query('BEGIN')
      await transaction.query('DELETE FROM versions WHERE id=$1', [workspace.versionId])
      expect(await durable(transaction)).toBeUndefined()
      expect(await ledger(transaction)).toEqual(reinstalledRows)
    } finally {
      try { await transaction.query('ROLLBACK') } finally { transaction.release() }
    }
  })

  it('aborts the ownership write if the database cannot append its ledger row', async () => {
    await boot()
    const before = await durable()
    await db.pool.query("ALTER TABLE sync_workspace_placement_moves ADD CONSTRAINT test_reject_move CHECK (to_cell_id <> 'rejected-cell')")
    try {
      await expect(db.pool.query("UPDATE sync_workspace_ownership SET cell_id='rejected-cell'")).rejects.toMatchObject({ code: '23514' })
      expect(await durable()).toEqual(before)
      expect(await ledger()).toEqual([])
    } finally {
      await db.pool.query('ALTER TABLE sync_workspace_placement_moves DROP CONSTRAINT test_reject_move')
    }
  })
})
