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
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { RedisRuntime } from '../runtime/redis.js'
import {
  FencedPartitionLeaseStore,
  FencedWorkspaceLeaseStore,
  SyncCellOwnershipCoordinator,
  syncCellOwnershipConfig,
  type SyncCellOwnershipConfig,
} from './ownership.js'

const TEST_REDIS_URL = process.env.TEST_REDIS_URL

describe.skipIf(!TEST_REDIS_URL)('sync-cell partition ownership (live Redis)', () => {
  const prefix = `test:sync-cell:${randomBytes(8).toString('hex')}`
  const client = createClient({ url: TEST_REDIS_URL })
  const workspaces = Array.from({ length: 32 }, (_, index) => ({
    landscape_id: `landscape-${index}`,
    id: `version-${index}`,
  }))
  /**
   * This suite is about REDIS — partition leases and Lua transactions — and its
   * Postgres side is a stub. It must answer as a table would: `persistLease`
   * reads `rowCount` to decide whether the durable row was written, so an empty
   * answer reads as "no row" and a coordinator holding 32 workspaces would log
   * 32 phantom repair failures on every pass. The `persisted` map returns what
   * the stub was told to write.
   */
  const persisted = new Map<string, { token: string; cellId: string }>()
  let topologyValue: string | null = null
  beforeEach(() => { topologyValue = null })
  const db = {
    async query(text: string, values?: unknown[]) {
      // Each Redis scenario has its own stubbed durable topology witness.
      if (text.includes('SELECT value FROM sync_topology_contract')) {
        return { rows: topologyValue === null ? [] : [{ value: topologyValue }], rowCount: topologyValue === null ? 0 : 1 }
      }
      if (text.includes('INSERT INTO sync_topology_contract')) {
        const value = String(values?.[0])
        if (topologyValue !== null && topologyValue !== value) return { rows: [], rowCount: 0 }
        topologyValue = value
        return { rows: [{ value }], rowCount: 1 }
      }
      if (text.includes('SELECT landscape_id, id FROM versions')) return { rows: workspaces, rowCount: workspaces.length }
      if (text.includes('INSERT INTO sync_workspace_ownership')) {
        persisted.set(`${String(values?.[0])}/${String(values?.[1])}`, {
          token: String(values?.[3]),
          cellId: String(values?.[2]),
        })
        return { rows: [{ fencing_token: String(values?.[3]), released: false }], rowCount: 1 }
      }
      // R1's reassertion survey, recognised by its two array parameters.
      if (Array.isArray(values?.[0]) && Array.isArray(values?.[1])) {
        const landscapes = values[0] as string[]
        const versions = values[1] as string[]
        const rows = landscapes.flatMap((landscapeId, index) => {
          const row = persisted.get(`${landscapeId}/${versions[index]}`)
          return row === undefined ? [] : [{
            landscape_id: landscapeId,
            version_id: versions[index]!,
            fencing_token: row.token,
            cell_id: row.cellId,
            released: false,
          }]
        })
        return { rows, rowCount: rows.length }
      }
      return { rows: [], rowCount: 0 }
    },
  } as unknown as Pool
  const runtime = {
    configured: true,
    get ready() { return client.isReady },
    prefix,
    send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
  } as unknown as RedisRuntime

  const config = (
    cellId: string,
    overrides: Partial<SyncCellOwnershipConfig> = {},
  ): SyncCellOwnershipConfig => ({
    ...syncCellOwnershipConfig({ SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_ID: cellId,
      SYNC_CELL_PARTITION_COUNT: String(overrides.partitionCount ?? 2), SYNC_CELL_MULTI_PARTITION: 'on',
      SYNC_CELL_TOPOLOGY_GENERATION: overrides.configuredGeneration ?? 'integration-v1' }),
    enabled: true,
    cellId,
    advertiseUrl: null,
    leaseTtlMs: 15_000,
    renewIntervalMs: 5_000,
    partitionLeaseTtlMs: 1_500,
    partitionRenewIntervalMs: 400,
    partitionProbeIntervalMs: 100,
    partitionWorker: false,
    reconcileIntervalMs: 300_000,
    telemetryIntervalMs: 300_000,
    reconcilePassDeadlineMs: 300_000,
    concurrency: 8,
    partitionCount: 2,
    ...overrides,
  })

  beforeAll(async () => {
    await client.connect()
  })

  afterAll(async () => {
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
      if (Array.isArray(batch)) keys.push(...batch)
      else keys.push(batch)
    }
    if (keys.length > 0) await client.sendCommand(['DEL', ...keys])
    await client.close()
  })

  it.each(['mode=placed|reserved=', 'mode=shadow|reserved=0'])(
    'B3d2 Lua compares the complete value when only %s differs', async fields => {
      const effective = config('cell-fixture').effectiveGeneration
      expect(effective).toBe('integration-v1.ce1461953e2b8ac2')
      const scoped = { ...runtime, prefix: `${prefix}:full-contract:${fields}` } as RedisRuntime
      const store = new FencedPartitionLeaseStore(scoped, effective)
      const key = `${scoped.prefix}:sync-cell:topology`
      const short = 'integration-v1.ce1461953e2b8ac2|2'
      await expect(store.ensureTopology(2)).resolves.toEqual({ agreed: true, created: true })
      await expect(store.ensureTopology(2)).resolves.toEqual({ agreed: true, created: false })
      expect(await client.sendCommand(['GET', key])).toBe(short)
      const extended = `${short}|v1|${fields}`
      await client.sendCommand(['SET', key, extended])
      await expect(store.ensureTopology(2)).resolves.toEqual({ agreed: false, created: false })
      expect(await client.sendCommand(['GET', key])).toBe(extended)
      await expect(store.verifyTopology(2)).resolves.toEqual({ known: true, agreed: false, expected: short, found: extended })
    },
  )

  it('leases disjoint slots and workspace fences through real Lua transactions', async () => {
    const first = new SyncCellOwnershipCoordinator(db, runtime, config('cell-a'))
    const second = new SyncCellOwnershipCoordinator(db, runtime, config('cell-b'))
    await first.start()
    await second.start()

    expect(first.snapshot().partitionIndex).not.toBe(second.snapshot().partitionIndex)
    expect(first.snapshot().expectedWorkspaceCount + second.snapshot().expectedWorkspaceCount).toBe(32)
    for (const row of workspaces) {
      const workspace = { landscapeId: row.landscape_id, versionId: row.id }
      expect(Number(first.owns(workspace)) + Number(second.owns(workspace))).toBe(1)
    }

    await first.stop()
    await second.stop()
  })

  it('moves a released active partition to a standby with a new advertised route', async () => {
    const failoverRuntime = {
      configured: true,
      get ready() { return client.isReady },
      prefix: `${prefix}:failover`,
      send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
    } as unknown as RedisRuntime
    const active = new SyncCellOwnershipCoordinator(db, failoverRuntime, config('cell-active', {
      advertiseUrl: 'http://cell-active.internal:3001',
      partitionCount: 1,
      configuredGeneration: 'failover-v1',
    }))
    const standby = new SyncCellOwnershipCoordinator(db, failoverRuntime, config('cell-standby', {
      advertiseUrl: 'http://cell-standby.internal:3001',
      partitionCount: 1,
      configuredGeneration: 'failover-v1',
    }))
    const observer = new SyncCellOwnershipCoordinator(db, failoverRuntime, config('cell-observer', {
      partitionCount: 1,
      partitionEligible: false,
      configuredGeneration: 'failover-v1',
    }))
    const failures: unknown[] = []

    try {
      await active.start()
      await standby.start()
      await observer.start()
      expect(active.snapshot()).toMatchObject({ partitionIndex: 0, ready: true })
      expect(standby.snapshot()).toMatchObject({ partitionIndex: null, ready: false })
      const workspace = { landscapeId: workspaces[0].landscape_id, versionId: workspaces[0].id }
      await expect(observer.resolveOwner(workspace)).resolves.toMatchObject({ cellId: 'cell-active' })
      const sequenceBeforeMove = observer.readSnapshot().ownerRouteMap.sampleSequence

      await active.stop()
      await standby.reconcileNow()
      expect(standby.snapshot()).toMatchObject({ partitionIndex: 0, ready: true })
      expect(active.snapshot()).toMatchObject({ partitionIndex: null, ready: false })

      // A stopped map must not keep resolving. A live routing-only coordinator
      // observes the successor on its actual refresh timer, never on a request.
      await expect(active.resolveOwner(workspace)).resolves.toBeNull()
      await expect.poll(() => observer.resolveOwner(workspace), { timeout: 5_000, interval: 20 }).toMatchObject({
        cellId: 'cell-standby',
        advertiseUrl: 'http://cell-standby.internal:3001',
        partition: 0,
      })
      expect(observer.readSnapshot().ownerRouteMap.sampleSequence).toBeGreaterThan(sequenceBeforeMove)
      expect(observer.readSnapshot().partitionIndex).toBeNull()
      expect(active.owns(workspace)).toBe(false)
      expect(standby.owns(workspace)).toBe(true)
    } catch (error) {
      failures.push(error)
    } finally {
      const closed = await Promise.allSettled([active, standby, observer].map(async cell => { await cell.stop() }))
      failures.push(...closed.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
    }
    if (failures.length) throw new AggregateError(failures, 'Failover scenario or coordinator cleanup failed')
  })

  // ─────────────────────────────────────────────────────────────────────
  // Losing the whole Redis dataset
  //
  // `compose.maplespire.yml` runs this Redis with NO persistence — no AOF and
  // no RDB — so every restart starts from an empty keyspace. That is only safe
  // because of the three properties below, and they are asserted here rather
  // than argued in a comment (persistence is off to avoid a torn AOF blocking
  // startup, and that choice is only as safe as these tests).
  //
  // Of the seven key shapes this Redis holds, four carry a TTL (the workspace
  // owner key at 15s, the partition owner key at 1.5s, `rate:v1:*`, `lease:v1:*`)
  // and are gone within seconds of a restart whatever the persistence setting.
  // The remaining three never expire, and each is covered below.
  //
  // The wipe is scoped by key prefix rather than FLUSHALL on purpose: this may
  // be a shared developer Redis, and a test that can erase somebody else's
  // keyspace is a worse defect than the one it is checking for.
  const wipe = async (scopePrefix: string): Promise<number> => {
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${scopePrefix}:*`, COUNT: 100 })) {
      if (Array.isArray(batch)) keys.push(...batch)
      else keys.push(batch)
    }
    if (keys.length > 0) await client.sendCommand(['DEL', ...keys])
    return keys.length
  }

  const runtimeFor = (scopePrefix: string) => ({
    configured: true,
    get ready() { return client.isReady },
    prefix: scopePrefix,
    send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
  } as unknown as RedisRuntime)

  it('rebuilds a workspace fence from the durable Postgres token after a total wipe', async () => {
    const scope = `${prefix}:wipe-floor`
    const store = new FencedWorkspaceLeaseStore(runtimeFor(scope))
    const workspace = { landscapeId: 'land-wipe', versionId: 'version-wipe' }

    // Three ordinary acquire/release cycles. The last token is the one
    // `persistLease` would have committed to `sync_workspace_ownership`.
    let durableToken = 0
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const lease = await store.acquire(workspace, 'cell-a', 5_000)
      expect(lease).not.toBeNull()
      durableToken = Number(lease?.token)
      await store.release(workspace, lease!)
    }
    expect(durableToken).toBe(3)

    // The restart. Asserting the wipe REMOVED something is the difference
    // between this test and one that silently stops exercising anything the
    // day the key names change.
    expect(await wipe(scope)).toBeGreaterThan(0)

    // What `acquireMissing` and `recoverWorkspaceLease` both do first.
    await store.ensureMinimumToken(workspace, durableToken)
    const afterWipe = await store.acquire(workspace, 'cell-b', 5_000)
    expect(afterWipe).not.toBeNull()
    expect(Number(afterWipe?.token)).toBeGreaterThan(durableToken)
  })

  it('...and WITHOUT that floor the identical wipe regresses the token', async () => {
    // The control. Without it the test above cannot tell a fence that was
    // rebuilt from one that never needed rebuilding, and would stay green if
    // `ensureMinimumToken` became a no-op — which is precisely the regression
    // that matters, because the compose flag is justified by that call and
    // nothing else.
    const scope = `${prefix}:wipe-control`
    const store = new FencedWorkspaceLeaseStore(runtimeFor(scope))
    const workspace = { landscapeId: 'land-control', versionId: 'version-control' }

    let durableToken = 0
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const lease = await store.acquire(workspace, 'cell-a', 5_000)
      durableToken = Number(lease?.token)
      await store.release(workspace, lease!)
    }
    expect(durableToken).toBe(3)
    expect(await wipe(scope)).toBeGreaterThan(0)

    const afterWipe = await store.acquire(workspace, 'cell-b', 5_000)
    expect(Number(afterWipe?.token)).toBe(1)
    expect(Number(afterWipe?.token)).toBeLessThanOrEqual(durableToken)
  })

  it('re-establishes the partition topology contract after a wipe, still failing closed', async () => {
    const scope = `${prefix}:wipe-topology`
    const store = new FencedPartitionLeaseStore(runtimeFor(scope), 'wipe-v1')

    // Asserting the WHOLE `{ agreed, created }` outcome rather than `agreed`
    // alone: after a wipe the contract is CREATED again, and a rebuild that
    // reported `matched` instead would mean the wipe left the key behind —
    // which is the failure this test exists for, and which `agreed` alone
    // cannot see.
    expect(await store.ensureTopology(1)).toEqual({ agreed: true, created: true })
    expect(await store.ensureTopology(2)).toEqual({ agreed: false, created: false })

    expect(await wipe(scope)).toBeGreaterThan(0)

    // Absent, so it is re-set rather than treated as a mismatch: losing this
    // key is recoverable, and only DISAGREEING about it is fatal.
    expect(await store.ensureTopology(1)).toEqual({ agreed: true, created: true })
    // And the wipe did not disarm the guard on the way through.
    expect(await store.ensureTopology(2)).toEqual({ agreed: false, created: false })
  })
})
