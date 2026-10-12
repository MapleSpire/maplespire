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

import type { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RedisRuntime } from '../runtime/redis.js'
import {
  FencedPartitionLeaseStore, SyncCellOwnershipCoordinator, SyncCellTopologyMismatchError,
  syncCellOwnershipConfig,
} from './ownership.js'

const ENV = {
  SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_ID: 'cell-a', SYNC_CELL_PARTITION_COUNT: '8',
  SYNC_CELL_MULTI_PARTITION: 'on', SYNC_CELL_PARTITION_WORKER: 'off',
  SYNC_CELL_PLACEMENT_MODE: 'shadow',
} as const
const PREFIX = 'reserved-unit'
const TOPOLOGY_KEY = `${PREFIX}:sync-cell:topology`

/** A command-boundary model of Redis, not an execution of its Lua scripts.
 * Every partition attempt refuses so the real coordinator must exhaust its
 * whole permitted order. The shared topology value is kept byte-for-byte. */
function redisFixture(shared: { topology: string | null } = { topology: null }) {
  const commands: string[][] = []
  const runtime = {
    configured: true, ready: true, prefix: PREFIX,
    async send<T>(args: string[]): Promise<T> {
      commands.push([...args])
      if (args[0] === 'GET' && args[1] === TOPOLOGY_KEY) return shared.topology as T
      if (args[0] === 'MGET') {
        expect(shared.topology).not.toBeNull()
        const generation = shared.topology!.split('|')[0]
        expect(args).toEqual(['MGET', ...Array.from({ length: 8 }, (_, partition) =>
          `${PREFIX}:sync-cell:partition:${generation}:${partition}:owner`)])
        // acquire() is explicitly mocked to refuse every slot in this suite;
        // no owner value exists in this command model for any sampled key.
        return args.slice(1).map(() => null) as T
      }
      if (args[0] === 'EVAL' && args[2] === '1' && args[3] === TOPOLOGY_KEY) {
        expect(args).toHaveLength(5)
        if (shared.topology !== null) return (shared.topology === args[4] ? 1 : 0) as T
        shared.topology = args[4]
        return 2 as T
      }
      throw new Error(`Unexpected unit Redis command: ${args[0]} ${args[2] ?? ''}`)
    },
  } as unknown as RedisRuntime
  return { runtime, commands, shared }
}

/** Empty durable workspace table and a single mirror value. This intentionally
 * models only the SQL boundary; `ownership.topologyMirror.integration.test.ts`
 * covers the database semantics against real Postgres. */
function databaseFixture(initialMirror: string | null = null) {
  let mirror = initialMirror
  const published: string[] = []
  const db = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('SELECT value FROM sync_topology_contract')) {
        return { rows: mirror === null ? [] : [{ value: mirror }], rowCount: mirror === null ? 0 : 1 }
      }
      if (sql.includes('INSERT INTO sync_topology_contract')) {
        const value = String(params?.[0])
        if (mirror !== null && mirror !== value) return { rows: [], rowCount: 0 }
        mirror = value
        published.push(value)
        return { rows: [{ value }], rowCount: 1 }
      }
      if (sql.includes('FROM sync_workspace_ownership')) {
        if (sql.includes('count(*)')) return { rows: [{ count: '0' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes("current_setting('statement_timeout')")) {
        return { rows: [{ statement_timeout: '30s', lock_timeout: '5s' }], rowCount: 1 }
      }
      throw new Error('Unexpected unit SQL query')
    },
  } as unknown as Pool
  return { db, published, mirror: () => mirror }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('T-13d ownership configuration and its acquisition consumer', () => {
  it('keeps the absent role as pool and reads both env variables through the real ownership factory', () => {
    expect(syncCellOwnershipConfig({})).toMatchObject({ role: 'pool', reservedPartitions: [] })
    const config = syncCellOwnershipConfig({
      ...ENV, SYNC_CELL_RESERVED_PARTITIONS: ' 7, 3, 1 ', SYNC_CELL_ROLE: 'reserved:3',
    })
    expect(config).toMatchObject({ role: 'reserved:3', reservedPartitions: [1, 3, 7] })
    expect(config.topologyGeneration).toBe(syncCellOwnershipConfig(ENV).topologyGeneration)
  })

  it.each(['', ' ', 'POOL', ' pool', 'pool ', 'reserved', 'reserved:', 'reserved:01', 'reserved:+1',
    'reserved:-1', 'reserved:1.0', 'reserved:1e0', 'reserved:8', 'reserved:0', 'reserved:1,3'])(
    'rejects an invalid or non-member cell role %j instead of becoming pool', role => {
    expect(() => syncCellOwnershipConfig({
      ...ENV, SYNC_CELL_RESERVED_PARTITIONS: '1,3', SYNC_CELL_ROLE: role,
    })).toThrow(/SYNC_CELL_ROLE/)
    },
  )

  it('refuses a reserved role against the empty default fleet reservation', () => {
    expect(() => syncCellOwnershipConfig({ ...ENV, SYNC_CELL_ROLE: 'reserved:1' })).toThrow(/SYNC_CELL_ROLE/)
  })

  it('isolates manual config and returned snapshot arrays from the contract and subsequent pool probes', async () => {
    const redis = redisFixture(), db = databaseFixture()
    const acquire = vi.spyOn(FencedPartitionLeaseStore.prototype, 'acquire').mockResolvedValue(null)
    // Deliberately bypass the factory's frozen array: callers can construct
    // config objects themselves, so constructor admission must own its copy.
    const supplied = [7, 1, 3]
    const config = { ...syncCellOwnershipConfig(ENV), reservedPartitions: supplied, role: 'pool' as const }
    const coordinator = new SyncCellOwnershipCoordinator(db.db, redis.runtime, config, () => 1_000)
    const value = 'v1.ce1461953e2b8ac2|8|v1|mode=shadow|reserved=1,3,7'
    try {
      supplied.splice(0, supplied.length, 0, 2, 4, 6)
      expect(config.reservedPartitions).toEqual([0, 2, 4, 6])
      await coordinator.start()
      expect(coordinator.snapshot()).toMatchObject({
        reservedPartitions: [1, 3, 7], role: 'pool', partitionIndex: null,
        errorCount: 0, bootReconcileFailed: false,
        ownerRouteMap: { enabled: true, usable: true, entries: 0, refreshErrorCount: 0 },
      })
      expect(acquire.mock.calls.map(args => args[0])).toEqual([4, 5, 6, 0, 2])
      expect(redis.shared.topology).toBe(value)
      expect(db.published).toEqual([value])

      const returned = coordinator.snapshot()
      // The cast only permits this hostile caller action on a readonly API;
      // no compile-time assertion or deep-readonly guarantee is claimed here.
      const borrowed = returned.reservedPartitions as number[]
      borrowed.splice(0, borrowed.length, 0, 2, 4, 6)
      expect(returned.reservedPartitions).toEqual([0, 2, 4, 6])
      acquire.mockClear()
      await coordinator.reconcileNow()
      expect(coordinator.snapshot()).toMatchObject({
        reservedPartitions: [1, 3, 7], role: 'pool', partitionIndex: null,
        errorCount: 0, bootReconcileFailed: false,
      })
      // A snapshot-only fix cannot pass if acquisition follows either array
      // the caller modified. These are actual calls from start/reconcile.
      expect(acquire.mock.calls.map(args => args[0])).toEqual([4, 5, 6, 0, 2])
      expect(redis.shared.topology).toBe(value)
      expect(db.mirror()).toBe(value)
      expect(redis.commands.filter(args => args[0] === 'EVAL').map(args => args[4])).toEqual([value])
    } finally { await coordinator.stop() }
  })

  it.each([
    { role: 'reserved:3', reserved: '1,3,7', expected: [3] },
    { role: 'pool', reserved: '1,3,7', expected: [4, 5, 6, 0, 2] },
    { role: 'pool', reserved: '0,1,2,3,4,5,6,7', expected: [] },
    { role: 'pool', reserved: '', expected: [4, 3, 7, 5, 6, 0, 2, 1] },
  ])('the real coordinator consumes env role=$role with reserved=$reserved', async ({ role, reserved, expected }) => {
    const redis = redisFixture(), db = databaseFixture()
    const acquire = vi.spyOn(FencedPartitionLeaseStore.prototype, 'acquire').mockResolvedValue(null)
    const config = syncCellOwnershipConfig({ ...ENV, SYNC_CELL_ROLE: role, SYNC_CELL_RESERVED_PARTITIONS: reserved })
    const coordinator = new SyncCellOwnershipCoordinator(db.db, redis.runtime, config, () => 1_000)
    try {
      await coordinator.start()
      expect(coordinator.snapshot()).toMatchObject({ partitionIndex: null, errorCount: 0, bootReconcileFailed: false,
        ownerRouteMap: { enabled: true, usable: true, entries: 0, refreshErrorCount: 0 } })
      expect(acquire.mock.calls.map(args => args[0])).toEqual(expected)
      const expectedValue = reserved === ''
        ? 'v1.ce1461953e2b8ac2|8'
        : `v1.ce1461953e2b8ac2|8|v1|mode=shadow|reserved=${reserved}`
      expect(redis.shared.topology).toBe(expectedValue)
      expect(db.published).toEqual([expectedValue])
      acquire.mockClear()
      await coordinator.reconcileNow()
      expect(acquire.mock.calls.map(args => args[0])).toEqual(expected)
      expect(coordinator.snapshot().errorCount).toBe(0)
    } finally { await coordinator.stop() }
  })

  it('two real coordinators refuse different fleet sets through Redis before the second can probe', async () => {
    const shared = { topology: null as string | null }
    const firstRedis = redisFixture(shared), secondRedis = redisFixture(shared)
    const firstDb = databaseFixture(), secondDb = databaseFixture()
    const acquire = vi.spyOn(FencedPartitionLeaseStore.prototype, 'acquire').mockResolvedValue(null)
    const first = new SyncCellOwnershipCoordinator(firstDb.db, firstRedis.runtime,
      syncCellOwnershipConfig({ ...ENV, SYNC_CELL_RESERVED_PARTITIONS: '1', SYNC_CELL_ROLE: 'reserved:1' }))
    const second = new SyncCellOwnershipCoordinator(secondDb.db, secondRedis.runtime,
      syncCellOwnershipConfig({ ...ENV, SYNC_CELL_ID: 'cell-b', SYNC_CELL_RESERVED_PARTITIONS: '3' }))
    try {
      await first.start()
      expect(acquire.mock.calls.map(args => args[0])).toEqual([1])
      acquire.mockClear()
      await expect(second.start()).rejects.toBeInstanceOf(SyncCellTopologyMismatchError)
      expect(acquire).not.toHaveBeenCalled()
      expect(second.snapshot()).toMatchObject({ partitionIndex: null, topologyConfirmed: false })
      expect(shared.topology).toBe('v1.ce1461953e2b8ac2|8|v1|mode=shadow|reserved=1')
      expect(secondRedis.commands.filter(args => args[0] === 'EVAL')).toHaveLength(1)
      expect(secondDb.published).toEqual([])
    } finally { await Promise.all([first.stop(), second.stop()]) }
  })

  it('the durable mirror refuses a reservation mismatch before any Redis command', async () => {
    const mirror = 'v1.ce1461953e2b8ac2|8|v1|mode=shadow|reserved=1'
    const db = databaseFixture(mirror), redis = redisFixture()
    const acquire = vi.spyOn(FencedPartitionLeaseStore.prototype, 'acquire').mockResolvedValue(null)
    const coordinator = new SyncCellOwnershipCoordinator(db.db, redis.runtime,
      syncCellOwnershipConfig({ ...ENV, SYNC_CELL_RESERVED_PARTITIONS: '3' }))
    try {
      await expect(coordinator.start()).rejects.toBeInstanceOf(SyncCellTopologyMismatchError)
      expect(redis.commands).toEqual([])
      expect(acquire).not.toHaveBeenCalled()
      expect(db.mirror()).toBe(mirror)
      expect(db.published).toEqual([])
    } finally { await coordinator.stop() }
  })

  it('different local roles agree on one fleet set, and the router store reads the same full value', async () => {
    const shared = { topology: null as string | null }
    const firstRedis = redisFixture(shared), secondRedis = redisFixture(shared)
    const db = databaseFixture()
    const acquire = vi.spyOn(FencedPartitionLeaseStore.prototype, 'acquire').mockResolvedValue(null)
    const firstConfig = syncCellOwnershipConfig({ ...ENV, SYNC_CELL_RESERVED_PARTITIONS: '7, 1, 3', SYNC_CELL_ROLE: 'reserved:3' })
    const secondConfig = syncCellOwnershipConfig({ ...ENV, SYNC_CELL_ID: 'cell-b', SYNC_CELL_RESERVED_PARTITIONS: '3,7,1', SYNC_CELL_ROLE: 'pool' })
    const first = new SyncCellOwnershipCoordinator(db.db, firstRedis.runtime, firstConfig)
    const second = new SyncCellOwnershipCoordinator(db.db, secondRedis.runtime, secondConfig)
    try {
      await first.start()
      expect(acquire.mock.calls.map(args => args[0])).toEqual([3])
      acquire.mockClear()
      await second.start()
      expect(acquire.mock.calls.map(args => args[0])).toEqual([0, 2, 5, 4, 6])
      expect(first.snapshot().errorCount).toBe(0)
      expect(second.snapshot().errorCount).toBe(0)
      const value = 'v1.ce1461953e2b8ac2|8|v1|mode=shadow|reserved=1,3,7'
      expect(shared.topology).toBe(value)
      expect(db.published).toEqual([value])
      const routerRedis = redisFixture(shared)
      const router = new FencedPartitionLeaseStore(routerRedis.runtime, secondConfig.topologyGeneration,
        secondConfig.placementMode, secondConfig.reservedPartitions)
      expect(await router.verifyTopology(8)).toEqual({ known: true, agreed: true, expected: value, found: value })
      expect(routerRedis.commands).toEqual([['GET', TOPOLOGY_KEY]])
      const wrongRouter = new FencedPartitionLeaseStore(routerRedis.runtime, secondConfig.topologyGeneration, 'shadow', [1])
      expect(await wrongRouter.verifyTopology(8)).toMatchObject({ known: true, agreed: false, found: value })
      expect(shared.topology).toBe(value)
    } finally { await Promise.all([first.stop(), second.stop()]) }
  })
})
