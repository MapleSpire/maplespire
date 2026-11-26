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

import { randomBytes } from 'node:crypto'
import { createClient } from 'redis'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import type { RedisRuntime } from '../runtime/redis.js'
import { ensureReadModelSchema } from '../readModel/schema.js'
import { EPOCH_RESOLVE_DONE_PREFIX, EPOCH_RESOLVE_FENCE_PREFIX } from '../readModel/epochResolveFence.js'
import { claimEpochResolveWriteFence, epochResolveOnlineHolders } from '../readModel/modelEpochResolveGuard.js'
import {
  EpochResolveFenceHeldError,
  SyncCellOwnershipCoordinator,
  ensureSyncCellOwnershipSchema,
  type SyncCellOwnershipConfig,
} from './ownership.js'

/**
 * G4-16f — `persistLease` refuses every lease write while
 * `epoch:resolve-repointing` holds the workspace's fence, for EVERY intent:
 * acquisition, the in-place recovery (`recoverWorkspaceLease` calls
 * `persistLease(recovered, 'acquire')` and runs no acquisition listener) and
 * the fence repair — and against a claim committing CONCURRENTLY. And a
 * healthy cell refreshes its lease's observed expiry on renewal, so a
 * long-held live lease is never honoured as stale.
 *
 * Real PostgreSQL and Redis; skips without both.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_REDIS_URL = process.env.TEST_REDIS_URL
const LANDSCAPE = 'landscape-epoch-fence'
const WS = { landscapeId: LANDSCAPE, versionId: 'version-epoch-fence' }

interface Lease { workspace: typeof WS; token: string; ownerValue: string; validUntil: number; observedAt?: number }
interface Internals {
  leases: Map<string, Lease>
  persistLease(lease: Lease, intent: 'acquire' | 'repair'): Promise<void>
}

describe.skipIf(!TEST_DATABASE_URL || !TEST_REDIS_URL)('persistLease under the epoch-resolve fence (live PostgreSQL + Redis)', () => {
  const prefix = `test:epoch-fence:${randomBytes(8).toString('hex')}`
  const client = createClient({ url: TEST_REDIS_URL })
  let db: IsolatedSchemaDb
  let coordinator: SyncCellOwnershipCoordinator | null = null

  const config: SyncCellOwnershipConfig = {
    enabled: true,
    cellId: 'cell-epoch-fence',
    advertiseUrl: null,
    leaseTtlMs: 60_000,
    renewIntervalMs: 25_000,
    partitionLeaseTtlMs: 30_000,
    partitionRenewIntervalMs: 10_000,
    leaseCommandTimeoutMs: 5_000,
    partitionProbeIntervalMs: 1_000,
    partitionWorker: false,
    versionCreationNotify: false,
    reconcileIntervalMs: 600_000,
    telemetryIntervalMs: 600_000,
    reconcilePassDeadlineMs: 300_000,
    concurrency: 4,
    admissionConcurrency: 4,
    partitionCount: 1,
    topologyGeneration: 'epoch-fence-v1',
  } as SyncCellOwnershipConfig
  const runtime = {
    configured: true,
    get ready() { return client.isReady },
    prefix,
    send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
  } as unknown as RedisRuntime

  const setFence = (fence: string) => db.pool.query(
    'UPDATE read_model_projection_state SET write_fence = $3 WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId, fence])
  const durable = async () => (await db.pool.query<{ fencing_token: string; released: boolean; observed_future: boolean }>(
    `SELECT fencing_token::text AS fencing_token, released_at IS NOT NULL AS released, lease_observed_expires_at > now() AS observed_future
       FROM sync_workspace_ownership WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])).rows[0] ?? null
  const internals = () => coordinator as unknown as Internals
  const heldLease = () => internals().leases.values().next().value as Lease

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'sync_cell_epoch_fence')
    await client.connect()
    await db.pool.query(`
      CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT);
      CREATE TABLE versions (
        id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL, root_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
    `)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [LANDSCAPE, 'Fence'])
    await db.pool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', 'automerge:root')`,
      [WS.versionId, WS.landscapeId])
    await ensureSyncCellOwnershipSchema(db.pool)
    await ensureReadModelSchema(db.pool)
  }, 120_000)
  beforeEach(async () => {
    await db.pool.query('DELETE FROM read_model_projection_state')
    await db.pool.query(`INSERT INTO read_model_projection_state (landscape_id, version_id, write_fence) VALUES ($1, $2, 'projector-1')`,
      [WS.landscapeId, WS.versionId])
  })
  afterEach(async () => { await coordinator?.stop(); coordinator = null })
  afterAll(async () => {
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 })) {
      if (Array.isArray(batch)) keys.push(...batch)
      else keys.push(batch)
    }
    if (keys.length > 0) await client.sendCommand(['DEL', ...keys])
    await client.close()
    await db?.teardown()
  })

  async function started(): Promise<SyncCellOwnershipCoordinator> {
    coordinator = new SyncCellOwnershipCoordinator(db.pool, runtime, config)
    await coordinator.start()
    return coordinator
  }

  it('ACQUIRE: refused while the fence is active, admitted once the run released it', async () => {
    await setFence(`${EPOCH_RESOLVE_FENCE_PREFIX}run-1`)
    const before = await durable()
    const c = await started()
    expect(c.owns(WS)).toBe(false)
    expect(await durable()).toEqual(before) // nothing persisted under the fence
    await setFence(`${EPOCH_RESOLVE_DONE_PREFIX}run-1`)
    await c.reconcileNow()
    expect(c.owns(WS)).toBe(true)
    expect(await durable()).toMatchObject({ released: false, fencing_token: c.fencingToken(WS) })
  }, 60_000)

  it('RECOVER (persistLease(recovered, \'acquire\'), no listener on that path) and REPAIR: refused while the fence is active', async () => {
    const c = await started()
    expect(c.owns(WS)).toBe(true)
    await setFence(`${EPOCH_RESOLVE_FENCE_PREFIX}run-2`)
    // The recovery call, exactly as `recoverWorkspaceLease` issues it, on a
    // row an operator's override released.
    await db.pool.query('UPDATE sync_workspace_ownership SET released_at = now() WHERE landscape_id = $1', [WS.landscapeId])
    await expect(internals().persistLease(heldLease(), 'acquire')).rejects.toThrow(EpochResolveFenceHeldError)
    expect(await durable()).toMatchObject({ released: true })
    // The repair: the durable row deleted (a restore) — the reassertion pass
    // would re-persist it; under the fence it must not.
    await db.pool.query('DELETE FROM sync_workspace_ownership WHERE landscape_id = $1', [WS.landscapeId])
    const failures = c.snapshot().fenceRepairFailureCount
    await c.reconcileNow()
    expect(c.snapshot().fenceRepairFailureCount).toBe(failures + 1)
    expect(await durable()).toBeNull()
    // CONTROL: the fence released, the same repair restores the row.
    await setFence(`${EPOCH_RESOLVE_DONE_PREFIX}run-2`)
    await c.reconcileNow()
    expect(await durable()).toMatchObject({ released: false, fencing_token: c.fencingToken(WS) })
  }, 60_000)

  it('a CLAIM committing concurrently: the lease write waits on the state row, then reads the NEW fence and is refused', async () => {
    const c = await started()
    expect(c.owns(WS)).toBe(true)
    // The operator named this cell stale; the claim will release its row.
    await db.pool.query(`UPDATE sync_workspace_ownership SET lease_observed_expires_at = now() - interval '2 hours' WHERE landscape_id = $1`, [WS.landscapeId])
    const real = await db.pool.connect()
    let paused!: () => void
    const pausedAt = new Promise<void>((resolve) => { paused = resolve })
    let resume!: () => void
    const gate = new Promise<void>((resolve) => { resume = resolve })
    const pausing = {
      query: async (sql: string, params?: unknown[]) => {
        const result = await real.query(sql, params)
        // After the claim WROTE its fence, before it commits.
        if (sql.includes('SET write_fence')) { paused(); await gate }
        return result
      },
    }
    try {
      const lease = heldLease()
      const claiming = claimEpochResolveWriteFence(pausing as never, WS, {
        override: { leases: [{ cellId: config.cellId, fencingToken: String(lease.token) }] },
      })
      await pausedAt
      let settled = false
      const recovering = internals().persistLease(lease, 'acquire').then(() => 'persisted', (error: unknown) => error)
        .finally(() => { settled = true })
      await new Promise((r) => setTimeout(r, 300))
      expect(settled).toBe(false) // waiting on the claim's locks
      resume()
      expect(await claiming).toMatchObject({ claimed: true, releasedLeases: [{ cellId: config.cellId }] })
      expect(await recovering).toBeInstanceOf(EpochResolveFenceHeldError)
      expect(await durable()).toMatchObject({ released: true }) // the claim's release stands
    } finally { resume(); real.release() }
  }, 60_000)

  it('RENEWAL refreshes the observed expiry: a healthy lease held for hours is NOT stale, and naming it overrides nothing', async () => {
    const c = await started()
    // Held for three hours: the acquisition's observation is long past…
    await db.pool.query(`UPDATE sync_workspace_ownership
                            SET lease_observed_expires_at = now() - interval '3 hours', acquired_at = now() - interval '3 hours'
                          WHERE landscape_id = $1`, [WS.landscapeId])
    expect((await epochResolveOnlineHolders(db.pool, WS))[0]).toMatchObject({ kind: 'ownership_lease', stale: true })
    // …and the cell last refreshed it more than the refresh interval ago.
    heldLease().observedAt = Date.now() - 6 * 60_000
    await c.renewNow()
    expect(await durable()).toMatchObject({ released: false, observed_future: true })
    expect((await epochResolveOnlineHolders(db.pool, WS))[0]).toMatchObject({ kind: 'ownership_lease', stale: false })
    const claimClient = await db.pool.connect()
    try {
      expect(await claimEpochResolveWriteFence(claimClient, WS, {
        override: { leases: [{ cellId: config.cellId, fencingToken: String(heldLease().token) }] },
      })).toMatchObject({ claimed: false, reason: 'online' })
    } finally { claimClient.release() }
    expect(await durable()).toMatchObject({ released: false })
  }, 60_000)
})
