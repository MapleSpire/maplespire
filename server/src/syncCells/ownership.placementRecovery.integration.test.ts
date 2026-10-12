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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { WorkspaceKey } from '../rbac/docScope.js'
import type { RedisRuntime } from '../runtime/redis.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { workspacePartition } from './assignment.js'
import {
  ensureSyncCellOwnershipSchema,
  FencedPartitionLeaseStore,
  FencedWorkspaceLeaseStore,
  SyncCellOwnershipCoordinator,
  syncCellOwnershipConfig,
  type FencedLease,
} from './ownership.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_REDIS_URL = process.env.TEST_REDIS_URL
type Lease = FencedLease & { workspace: WorkspaceKey; validUntil: number }
type Internals = {
  placementInvalidation: { stop(): Promise<void> } | null
  partitionWorker: { lastRenewStartedAt: () => number } | null
  partitionLease: FencedLease & { partition: number }
  leases: Map<string, Lease>
  renewWorkspaceLeases(): Promise<void>
  releaseLease(key: string, lease: Lease, reason: 'workspace-lease-lost'): Promise<void>
  markReleased(lease: Lease): Promise<void>
}
const internals = (coordinator: SyncCellOwnershipCoordinator) => coordinator as unknown as Internals

// Real coordinator/Lua/PG, with the Worker's shared-memory timestamp boundary
// simulated explicitly. This does not start or qualify a native Worker thread.
// Mutable injected resolvers deliberately model independently refreshed views;
// the production SELECT/NOTIFY trigger is covered by the move campaign.
describe.skipIf(!TEST_DATABASE_URL || !TEST_REDIS_URL)('placed Worker recovery boundaries (T-10h3)', () => {
  const prefix = `test:placement-recovery:${randomBytes(8).toString('hex')}`
  const client = createClient({ url: TEST_REDIS_URL })
  let failedReleaseToken: string | null = null
  let observedReleaseToken: string | null = null
  let releaseAttempts = 0
  let injectedReleaseFailures = 0
  const runtime = {
    configured: true,
    get ready() { return client.isReady },
    prefix,
    send<T>(args: string[]) {
      const release = args[0] === 'EVAL' && args[1]!.includes("redis.call('DEL', KEYS[2])")
      if (release && args[5] === observedReleaseToken) releaseAttempts += 1
      if (release && args[5] === failedReleaseToken) {
        failedReleaseToken = null
        injectedReleaseFailures += 1
        return Promise.reject(new Error('Injected one-shot Redis release transport failure'))
      }
      return client.sendCommand(args) as Promise<T>
    },
  } as unknown as RedisRuntime
  let db: IsolatedSchemaDb
  const cells: SyncCellOwnershipCoordinator[] = []
  const maps = new Map<SyncCellOwnershipCoordinator, Map<string, number>>()
  const key = (workspace: WorkspaceKey) => [workspace.landscapeId, workspace.versionId].join(String.fromCharCode(0))
  const workspace = Array.from({ length: 128 }, (_, index) => ({ landscapeId: 'land-recovery', versionId: `version-${index}` }))
    .find(value => workspacePartition(value, 2) === 0)!
  const digest = createHash('sha256').update(workspace.landscapeId).update(Buffer.from([0]))
    .update(workspace.versionId).digest('hex')
  const ownerKey = `${prefix}:sync-cell:owner:${digest}`
  const authorityKey = `${prefix}:sync-cell:authority:${digest}`
  const sequenceKey = `${prefix}:sync-cell:fence:${digest}`
  const settings = (cellId: string) => syncCellOwnershipConfig({
    SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_ID: cellId,
    SYNC_CELL_TOPOLOGY_GENERATION: 'placement-recovery', SYNC_CELL_PARTITION_COUNT: '2',
    SYNC_CELL_MULTI_PARTITION: 'on', SYNC_CELL_PLACEMENT_MODE: 'placed', SYNC_CELL_PARTITION_WORKER: 'off',
    SYNC_CELL_LEASE_TTL_MS: '60000', SYNC_CELL_RENEW_INTERVAL_MS: '25000',
    SYNC_CELL_PARTITION_LEASE_TTL_MS: '30000', SYNC_CELL_PARTITION_RENEW_INTERVAL_MS: '10000',
    SYNC_CELL_RECONCILE_INTERVAL_MS: '300000', SYNC_CELL_TELEMETRY_INTERVAL_MS: '300000',
  })
  const config = settings('cell-source')
  const store = new FencedWorkspaceLeaseStore(runtime, config.effectiveGeneration, config)
  const partitionStore = new FencedPartitionLeaseStore(runtime, config.effectiveGeneration, 'placed')
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
    const observedAt = Date.now()
    internals(source).partitionWorker = { lastRenewStartedAt: () => observedAt }
    return { source, destination }
  }
  async function until(predicate: () => boolean | Promise<boolean>, description: string) {
    const deadline = Date.now() + 5_000
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`No witness: ${description}`)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  async function durable(query: Pick<typeof db.pool, 'query'> = db.pool) {
    return (await query.query(
      'SELECT cell_id, fencing_token::text AS token, released_at IS NOT NULL AS released FROM sync_workspace_ownership WHERE landscape_id=$1 AND version_id=$2',
      [workspace.landscapeId, workspace.versionId],
    )).rows[0]
  }

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'placement_recovery')
    await client.connect()
    await db.pool.query(`
      CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT);
      CREATE TABLE versions (id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id),
        label TEXT NOT NULL, root_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
      INSERT INTO landscapes VALUES ('land-recovery', 'Recovery');
    `)
    await db.pool.query('INSERT INTO versions(id, landscape_id, label, root_url) VALUES ($1,$2,$3,$4)',
      [workspace.versionId, workspace.landscapeId, 'Main', 'unused-root'])
    await ensureSyncCellOwnershipSchema(db.pool)
  }, 120_000)
  afterEach(async () => {
    failedReleaseToken = null
    observedReleaseToken = null
    releaseAttempts = 0
    injectedReleaseFailures = 0
    while (cells.length) {
      const cell = cells.pop()!
      internals(cell).partitionWorker = null
      await cell.stop()
    }
    maps.clear()
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) keys.push(...batch)
    if (keys.length) await client.sendCommand(['DEL', ...keys])
    await db.pool.query('DELETE FROM sync_workspace_ownership; DELETE FROM sync_topology_contract')
  })
  afterAll(async () => {
    if (client.isOpen) await client.close()
    await db?.teardown()
  })

  it('refuses destination admission when the owner key is absent but Worker A still serves', async () => {
    const { source, destination } = await boot()
    const old = internals(source).leases.get(key(workspace))!
    expect(old).toBeDefined()
    expect(await client.get(ownerKey)).toBe(old.ownerValue)
    expect(JSON.parse((await client.get(authorityKey))!).ownerValue).toBe(old.ownerValue)
    await client.del(ownerKey)
    expect(await client.get(ownerKey)).toBeNull()
    expect(source.owns(workspace)).toBe(true)
    maps.get(destination)!.set(key(workspace), 1)
    await destination.reconcileNow()
    expect([source.owns(workspace), destination.owns(workspace)]).toEqual([true, false])
    expect(await client.get(sequenceKey)).toBe(old.token)
    expect(await durable()).toEqual({ cell_id: source.snapshot().cellId, token: old.token, released: false })
    await internals(source).renewWorkspaceLeases()
    const recovered = internals(source).leases.get(key(workspace))!
    expect(BigInt(recovered.token)).toBeGreaterThan(BigInt(old.token))
    expect(source.snapshot().workspaceLeaseRecoveryCount).toBe(1)
    expect(await client.get(ownerKey)).toBe(recovered.ownerValue)
    expect(JSON.parse((await client.get(authorityKey))!).ownerValue).toBe(recovered.ownerValue)
  })

  it.each(['renew-miss', 'workspace-expiry', 'partition-expiry'] as const)(
    'retires the authority index after local loss %s, with pure refusal before reconcile cleanup', async loss => {
      const { source, destination } = await boot()
      const local = internals(source)
      const old = local.leases.get(key(workspace))!
      const oldPartition = local.partitionLease
      const partitionKey = partitionStore.proof(0, oldPartition, 2).ownerKey
      expect(old).toBeDefined()
      expect(await client.get(ownerKey)).toBe(old.ownerValue)
      expect(JSON.parse((await client.get(authorityKey))!).ownerValue).toBe(old.ownerValue)
      expect(await client.get(partitionKey)).toBe(oldPartition.ownerValue)
      const losses: string[] = []
      const removeLossListener = source.onOwnershipLost(event => { losses.push(event.reason) })
      if (loss === 'renew-miss') {
        // A's changed view prevents recovery. The definitive renew miss must
        // retire its index even though its partition is still alive.
        maps.get(source)!.set(key(workspace), 1)
        await client.del(ownerKey)
        await local.renewWorkspaceLeases()
      } else {
        // Drain a notification pass that may already have passed pruneExpired.
        // No await follows until the local expiry and changed view are published.
        await source.reconcileNow()
        local.partitionWorker = null
        if (loss === 'workspace-expiry') old.validUntil = Date.now() - 1
        else (oldPartition as FencedLease & { validUntil: number }).validUntil = Date.now() - 1
        const priorLossCount = source.snapshot().lossCount
        expect(source.owns(workspace)).toBe(false)
        expect(source.fencingToken(workspace)).toBeNull()
        expect(local.leases.get(key(workspace))).toBe(old)
        expect(source.snapshot().lossCount).toBe(priorLossCount)
        expect(losses).toEqual([])
        // Move A's injected view before reconciliation so it cannot immediately
        // readmit the workspace after pruning it. The expected expiry reason
        // below distinguishes pruning from the later placement release path.
        maps.get(source)!.set(key(workspace), 1)
        await source.reconcileNow()
        expect(losses).toEqual([loss === 'workspace-expiry' ? 'workspace-lease-expired' : 'partition-expired'])
      }
      expect(local.leases.has(key(workspace))).toBe(false)
      expect(source.owns(workspace)).toBe(false)
      removeLossListener()
      // Check physical retirement before stop could finish it for this test.
      // The suspended-release tests in ownership.test.ts separately prove that
      // reconciliation waits; these assertions prove the real Lua outcome.
      expect(await client.get(ownerKey)).toBeNull()
      expect(await client.get(authorityKey)).toBeNull()
      local.partitionWorker = null
      await source.stop()
      expect(await client.get(ownerKey)).toBeNull()
      expect(await client.get(authorityKey)).toBeNull()
      maps.get(destination)!.set(key(workspace), 1)
      await destination.reconcileNow()
      expect(destination.owns(workspace)).toBe(true)
      expect(BigInt(destination.fencingToken(workspace)!)).toBeGreaterThan(BigInt(old.token))
      expect((await durable()).released).toBe(false)
    })

  it('retries an exact cleanup after a one-shot Redis release failure without forgetting local loss', async () => {
    const { source, destination } = await boot()
    // This scenario explicitly drives two separate cleanup passes. The real
    // shared PG channel can otherwise start the retry between any of the Redis
    // reads below, even though this fixture supplies its own placement views.
    // Close notifications, then join already requested passes before injection.
    // Notification-driven convergence is exercised by the move campaign.
    await internals(source).placementInvalidation?.stop()
    await internals(destination).placementInvalidation?.stop()
    await source.reconcileNow()
    await destination.reconcileNow()
    const local = internals(source)
    const old = local.leases.get(key(workspace))!
    const sourcePartition = local.partitionLease
    expect(old).toBeDefined()
    expect(JSON.parse((await client.get(authorityKey))!).ownerValue).toBe(old.ownerValue)
    maps.get(source)!.set(key(workspace), 1)
    maps.get(destination)!.set(key(workspace), 1)
    observedReleaseToken = old.ownerValue
    failedReleaseToken = old.ownerValue
    await source.reconcileNow()
    expect(injectedReleaseFailures).toBe(1)
    expect(releaseAttempts).toBe(1)
    expect(source.owns(workspace)).toBe(false)
    expect(local.leases.has(key(workspace))).toBe(false)
    expect(source.snapshot().errorCount).toBeGreaterThan(0)
    expect(await client.get(ownerKey)).toBe(old.ownerValue)
    expect(JSON.parse((await client.get(authorityKey))!).ownerValue).toBe(old.ownerValue)
    expect(await client.get(partitionStore.proof(0, sourcePartition, 2).ownerKey)).toBe(sourcePartition.ownerValue)
    await destination.reconcileNow()
    expect(destination.owns(workspace)).toBe(false)
    // Simulate the owner expiring while its pending authority cleanup survives.
    // The retry's successful CAS returns 0 for owner but must retire the debt.
    await client.del(ownerKey)
    await source.reconcileNow()
    expect(releaseAttempts).toBe(2)
    expect(await client.get(ownerKey)).toBeNull()
    expect(await client.get(authorityKey)).toBeNull()
    await destination.reconcileNow()
    expect(destination.owns(workspace)).toBe(true)
    expect(BigInt(destination.fencingToken(workspace)!)).toBeGreaterThan(BigInt(old.token))
    await source.reconcileNow()
    expect(releaseAttempts).toBe(2)
    expect((await durable()).released).toBe(false)
  })

  it('retries the exact unpublished T2 authority after recovery cleanup fails once', async () => {
    const { source, destination } = await boot()
    const local = internals(source)
    const old = local.leases.get(key(workspace))!
    const sourcePartition = local.partitionLease
    const partitionKey = partitionStore.proof(0, sourcePartition, 2).ownerKey
    const blocker = await db.pool.connect()
    let renewal: Promise<void> | undefined
    let committed = false
    try {
      await blocker.query('BEGIN')
      const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid')
      await blocker.query('SELECT fencing_token FROM sync_workspace_ownership WHERE landscape_id=$1 AND version_id=$2 FOR UPDATE',
        [workspace.landscapeId, workspace.versionId])
      await client.del(ownerKey)
      let settled = false
      renewal = local.renewWorkspaceLeases().finally(() => { settled = true })
      await until(async () => (await db.pool.query(
        'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))) AS blocked', [pid],
      )).rows[0].blocked, 'unpublished T2 persist is blocked by an independent PG transaction')
      expect(settled).toBe(false)
      const pendingOwner = await client.get(ownerKey)
      expect(pendingOwner).not.toBeNull()
      const pending: Lease = { ...old, token: pendingOwner!.split('|')[1]!, ownerValue: pendingOwner! }
      expect(BigInt(pending.token)).toBeGreaterThan(BigInt(old.token))
      expect(JSON.parse((await client.get(authorityKey))!).ownerValue).toBe(pending.ownerValue)
      expect(local.leases.get(key(workspace))).toBe(old)
      expect(await durable(blocker)).toEqual({ cell_id: source.snapshot().cellId, token: old.token, released: false })
      maps.get(source)!.set(key(workspace), 1)
      maps.get(destination)!.set(key(workspace), 1)
      // The injection targets T2 exactly. Retiring the old local T1 cannot
      // remove this newer index and must not satisfy the retry witness.
      observedReleaseToken = pending.ownerValue
      failedReleaseToken = pending.ownerValue
      await blocker.query('COMMIT')
      committed = true
      await renewal
      expect(injectedReleaseFailures).toBe(1)
      expect(releaseAttempts).toBe(1)
      expect(local.leases.has(key(workspace))).toBe(false)
      expect(source.owns(workspace)).toBe(false)
      expect(source.snapshot()).toMatchObject({ workspaceLeaseRecoveryCount: 0, ownedWorkspaceCount: 0 })
      expect(source.snapshot().errorCount).toBeGreaterThan(0)
      expect(await client.get(ownerKey)).toBe(pending.ownerValue)
      expect(JSON.parse((await client.get(authorityKey))!).ownerValue).toBe(pending.ownerValue)
      expect(await client.get(partitionKey)).toBe(sourcePartition.ownerValue)
      expect(await durable()).toEqual({ cell_id: source.snapshot().cellId, token: pending.token, released: true })
      await destination.reconcileNow()
      expect(destination.owns(workspace)).toBe(false)
      expect(await client.get(sequenceKey)).toBe(pending.token)
      // No local entry ever held T2. Only the pending exact authority cleanup
      // can cause this second RELEASE while A's partition is still alive.
      await source.reconcileNow()
      expect(releaseAttempts).toBe(2)
      expect(await client.get(ownerKey)).toBeNull()
      expect(await client.get(authorityKey)).toBeNull()
      expect(await client.get(partitionKey)).toBe(sourcePartition.ownerValue)
      await destination.reconcileNow()
      const successor = internals(destination).leases.get(key(workspace))!
      expect(successor).toBeDefined()
      expect(BigInt(successor.token)).toBeGreaterThan(BigInt(pending.token))
      expect([source.owns(workspace), destination.owns(workspace)]).toEqual([false, true])
      await source.reconcileNow()
      expect(releaseAttempts).toBe(2)
      await local.markReleased(pending)
      expect(await store.release(workspace, pending)).toBe(false)
      expect(await client.get(ownerKey)).toBe(successor.ownerValue)
      expect(JSON.parse((await client.get(authorityKey))!).ownerValue).toBe(successor.ownerValue)
      expect(await durable()).toEqual({ cell_id: destination.snapshot().cellId, token: successor.token, released: false })
    } finally {
      if (!committed) await blocker.query('ROLLBACK')
      blocker.release()
      await Promise.allSettled(renewal ? [renewal] : [])
    }
  }, 15_000)

  it('cleans a recovery blocked inside PG after placement changes and preserves the successor token', async () => {
    const { source, destination } = await boot()
    const local = internals(source)
    const old = local.leases.get(key(workspace))!
    expect(old).toBeDefined()
    const blocker = await db.pool.connect()
    let renewal: Promise<void> | undefined
    let release: Promise<void> | undefined
    let committed = false
    try {
      await blocker.query('BEGIN')
      const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid')
      await blocker.query('SELECT fencing_token FROM sync_workspace_ownership WHERE landscape_id=$1 AND version_id=$2 FOR UPDATE',
        [workspace.landscapeId, workspace.versionId])
      await client.del(ownerKey)
      let settled = false
      renewal = local.renewWorkspaceLeases().finally(() => { settled = true })
      await until(async () => (await db.pool.query(
        'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))) AS blocked', [pid],
      )).rows[0].blocked, 'recovery is genuinely blocked by the independent PG transaction')
      expect(settled).toBe(false)
      const pendingOwner = await client.get(ownerKey)
      const pending = { ...old, token: pendingOwner!.split('|')[1]!, ownerValue: pendingOwner! }
      expect(BigInt(pending.token)).toBeGreaterThan(BigInt(old.token))
      expect(local.leases.get(key(workspace))).toBe(old)
      expect(JSON.parse((await client.get(authorityKey))!).ownerValue).toBe(pendingOwner)
      maps.get(source)!.set(key(workspace), 1)
      expect(source.owns(workspace)).toBe(false)
      release = local.releaseLease(key(workspace), old, 'workspace-lease-lost')
      await until(() => !local.leases.has(key(workspace)), 'old local lease withdrawn')
      const proof = internals(destination).partitionLease
      await expect(store.acquireForPartition(workspace, destination.snapshot().cellId, 60_000,
        partitionStore.proof(1, proof, 2))).resolves.toEqual({
        acquired: null, refusal: 'placement-incumbent-live', incumbent: pending.ownerValue,
      })
      expect(await client.get(ownerKey)).toBe(pending.ownerValue)
      // Both LISTEN connections, blocker, recovery and release occupy the
      // fixture's five pool clients. Read through the already-owned blocker;
      // borrowing a sixth client here would deadlock the test before COMMIT.
      expect(await durable(blocker)).toEqual({ cell_id: source.snapshot().cellId, token: old.token, released: false })
      await blocker.query('COMMIT')
      committed = true
      await Promise.all([renewal, release])
      expect(source.snapshot().workspaceLeaseRecoveryCount).toBe(0)
      expect(local.leases.has(key(workspace))).toBe(false)
      expect(await client.get(ownerKey)).toBeNull()
      expect(await client.get(authorityKey)).toBeNull()
      maps.get(destination)!.set(key(workspace), 1)
      await destination.reconcileNow()
      const successor = internals(destination).leases.get(key(workspace))!
      expect(BigInt(successor.token)).toBeGreaterThan(BigInt(pending.token))
      expect([source.owns(workspace), destination.owns(workspace)]).toEqual([false, true])
      await local.markReleased(pending)
      expect(await store.release(workspace, pending)).toBe(false)
      expect(await client.get(ownerKey)).toBe(successor.ownerValue)
      expect(JSON.parse((await client.get(authorityKey))!).ownerValue).toBe(successor.ownerValue)
      expect(await durable()).toEqual({ cell_id: destination.snapshot().cellId, token: successor.token, released: false })
    } finally {
      if (!committed) await blocker.query('ROLLBACK')
      blocker.release()
      await Promise.allSettled([renewal, release].filter((value): value is Promise<void> => Boolean(value)))
    }
  }, 15_000)
})
