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
import { createClient } from 'redis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RedisRuntime } from '../runtime/redis.js'
import type { WorkspaceKey } from '../rbac/docScope.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { workspacePartition } from './assignment.js'
import {
  ensureSyncCellOwnershipSchema,
  SyncCellOwnershipCoordinator,
  syncCellOwnershipConfig,
  type SyncCellOwnershipLoss,
} from './ownership.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_REDIS_URL = process.env.TEST_REDIS_URL

/** Two real coordinators and real PG/Redis, with no injected placement
 * resolver or target-cell stub. The normal reconciliation entry point is
 * driven in release/acquire order; this is not a latency, NOTIFY, Worker,
 * WebSocket or separate-process qualification. The loss event below is what
 * automergeServer consumes to emit workspace_drained; the transport log and
 * socket drain themselves are not covered here. */
describe.skipIf(!TEST_DATABASE_URL || !TEST_REDIS_URL)('placed workspace move (T-10h3)', () => {
  const prefix = `test:placement-move:${randomBytes(8).toString('hex')}`
  const clients = [createClient({ url: TEST_REDIS_URL }), createClient({ url: TEST_REDIS_URL })]
  const coordinators: SyncCellOwnershipCoordinator[] = []
  let db: IsolatedSchemaDb | undefined
  const settings = ['cell-placement-a', 'cell-placement-b'].map(cellId => syncCellOwnershipConfig({
    SYNC_CELL_OWNERSHIP: 'on',
    SYNC_CELL_ID: cellId,
    SYNC_CELL_PARTITION_COUNT: '2',
    SYNC_CELL_MULTI_PARTITION: 'on',
    SYNC_CELL_PLACEMENT_MODE: 'placed',
    SYNC_CELL_TOPOLOGY_GENERATION: 'placement-move',
    SYNC_CELL_PARTITION_WORKER: 'off',
    SYNC_CELL_LEASE_TTL_MS: '60000',
    SYNC_CELL_RENEW_INTERVAL_MS: '25000',
    SYNC_CELL_PARTITION_LEASE_TTL_MS: '30000',
    SYNC_CELL_PARTITION_RENEW_INTERVAL_MS: '10000',
    SYNC_CELL_RECONCILE_INTERVAL_MS: '300000',
    SYNC_CELL_TELEMETRY_INTERVAL_MS: '300000',
  }))
  const generation = settings[0]!.effectiveGeneration
  const byPartition = new Map<number, WorkspaceKey>()
  for (let index = 0; index < 128 && byPartition.size < 2; index += 1) {
    const workspace = { landscapeId: 'placement-move-landscape', versionId: `placement-move-version-${index}` }
    const partition = workspacePartition(workspace, 2)
    if (!byPartition.has(partition)) byPartition.set(partition, workspace)
  }
  const workspaces = [...byPartition.values()]
  const redisOwnerKey = (workspace: WorkspaceKey) => `${prefix}:sync-cell:owner:${createHash('sha256')
    .update(workspace.landscapeId).update(Buffer.from([0])).update(workspace.versionId).digest('hex')}`

  beforeAll(async () => {
    expect(byPartition.size, 'The fixture must populate both real hash buckets').toBe(2)
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'placement_move')
    for (const client of clients) await client.connect()
    await db.pool.query(`
      CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT);
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
    `)
    await db.pool.query('INSERT INTO landscapes(id, name) VALUES ($1, $2)', [workspaces[0]!.landscapeId, 'Placement move'])
    for (const workspace of workspaces) {
      await db.pool.query(
        'INSERT INTO versions(id, landscape_id, label, root_url) VALUES ($1, $2, $3, $4)',
        [workspace.versionId, workspace.landscapeId, 'Main', `unused-root-${workspace.versionId}`],
      )
    }
    await ensureSyncCellOwnershipSchema(db.pool)
    for (const workspace of workspaces) {
      await db.pool.query(
        'INSERT INTO workspace_placement(landscape_id, version_id, partition, topology_generation) VALUES ($1, $2, $3, $4)',
        [workspace.landscapeId, workspace.versionId, workspacePartition(workspace, 2), generation],
      )
    }
  }, 120_000)

  afterAll(async () => {
    const errors: unknown[] = []
    for (const coordinator of coordinators) {
      try { await coordinator.stop() } catch (error) { errors.push(error) }
    }
    try {
      const client = clients.find(value => value.isReady)
      if (client) {
        const keys: string[] = []
        for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
          if (Array.isArray(batch)) keys.push(...batch)
          else keys.push(batch)
        }
        if (keys.length) await client.sendCommand(['DEL', ...keys])
      }
    } catch (error) { errors.push(error) }
    for (const client of clients) {
      try { if (client.isOpen) await client.close() } catch (error) { errors.push(error) }
    }
    try { await db?.teardown() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Placement move fixture cleanup failed')
  })

  it('moves a live workspace from hash owner A to placed owner B with workspace-moved', async () => {
    const pool = db!.pool
    for (const [index, client] of clients.entries()) {
      const runtime = {
        configured: true,
        get ready() { return client.isReady },
        prefix,
        send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
      } as unknown as RedisRuntime
      const coordinator = new SyncCellOwnershipCoordinator(pool, runtime, settings[index]!)
      coordinators.push(coordinator)
      await coordinator.start()
    }
    const moved = byPartition.get(0)!
    const control = byPartition.get(1)!
    const h = workspacePartition(moved, 2)
    const k = 1 - h
    expect(h).not.toBe(k)
    expect(coordinators.map(cell => cell.snapshot().partitionIndex).sort()).toEqual([0, 1])
    for (const cell of coordinators) {
      expect(cell.snapshot()).toMatchObject({ ready: true, topologyConfirmed: true, placementMode: 'placed',
        partitionCount: 2, topologyGeneration: generation, placementRowsCompared: 2,
        placementDivergenceCount: 0, errorCount: 0, passAbandonedCount: 0 })
    }
    const source = coordinators.find(cell => cell.snapshot().partitionIndex === h)!
    const destination = coordinators.find(cell => cell.snapshot().partitionIndex === k)!
    const sourceId = source.snapshot().cellId
    const destinationId = destination.snapshot().cellId
    expect([source.owns(moved), destination.owns(moved)]).toEqual([true, false])
    expect([source.owns(control), destination.owns(control)]).toEqual([false, true])
    const oldToken = source.fencingToken(moved)
    const controlToken = destination.fencingToken(control)
    expect(oldToken).not.toBeNull()
    expect(controlToken).not.toBeNull()
    expect(await clients[0]!.get(redisOwnerKey(moved))).toBe(`${sourceId}|${oldToken}|${generation}`)
    const readDurable = async () => (await pool.query(
      'SELECT cell_id, fencing_token::text AS token, released_at IS NOT NULL AS released FROM sync_workspace_ownership WHERE landscape_id=$1 AND version_id=$2',
      [moved.landscapeId, moved.versionId],
    )).rows
    expect(await readDurable()).toEqual([{ cell_id: sourceId, token: oldToken, released: false }])
    const losses: SyncCellOwnershipLoss[] = []
    const unsubscribe = source.onOwnershipLost(event => losses.push(event))
    try {
      const changed = await pool.query(
        'UPDATE workspace_placement SET partition=$1, updated_at=NOW() WHERE landscape_id=$2 AND version_id=$3 AND topology_generation=$4 RETURNING partition',
        [k, moved.landscapeId, moved.versionId, generation],
      )
      expect(changed.rows).toEqual([{ partition: k }])
      await source.reconcileNow()
      await destination.reconcileNow()
      for (const cell of coordinators) {
        expect(cell.snapshot()).toMatchObject({ topologyConfirmed: true, partitionCount: 2,
          placementMode: 'placed', placementRowsCompared: 2, placementDivergenceCount: 1,
          errorCount: 0, passAbandonedCount: 0 })
      }
      const durable = await readDurable()
      const observation = {
        h, k,
        assignedPartitions: [source.partitionFor(moved), destination.partitionFor(moved)],
        owns: [source.owns(moved), destination.owns(moved)],
        durableOwner: durable[0]?.cell_id ?? null,
        losses: losses.map(event => ({ workspace: event.workspace, reason: event.reason })),
      }
      console.log(JSON.stringify({ event: 'test.placement_move.observed', ...observation }))
      expect(observation, 'Committed P differs from H: the actual owners and loss reason must follow P').toEqual({
        h, k, assignedPartitions: [k, k], owns: [false, true], durableOwner: destinationId,
        losses: [{ workspace: moved, reason: 'workspace-moved' }],
      })
      const newToken = destination.fencingToken(moved)
      expect(newToken).not.toBeNull()
      expect(BigInt(newToken!)).toBeGreaterThan(BigInt(oldToken!))
      expect(durable).toEqual([{ cell_id: destinationId, token: newToken, released: false }])
      expect(await clients[0]!.get(redisOwnerKey(moved))).toBe(`${destinationId}|${newToken}|${generation}`)
      expect(source.fencingToken(moved)).toBeNull()
      await expect(source.resolveOwner(moved)).resolves.toMatchObject({ cellId: destinationId, partition: k })
      expect([source.owns(control), destination.owns(control)]).toEqual([false, true])
      expect(destination.fencingToken(control)).toBe(controlToken)
    } finally { unsubscribe() }
  }, 60_000)
})
