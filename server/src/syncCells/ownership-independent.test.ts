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

// Independent ownership lifetime and read-purity controls.
// These seams model already-admitted local leases. No Redis Lua or SQL
// transport semantics are qualified by this file.
import { setImmediate as nextTurn } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { SyncCellOwnershipCoordinator, syncCellOwnershipConfig, syncCellOwnershipMetricSamples } from './ownership.js'

function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
type Workspace = { landscapeId: string; versionId: string }
type Lease = { token: string; ownerValue: string; validUntil: number; workspace: Workspace }
type Partition = { token: string; ownerValue: string; validUntil: number; partition: number }

function fixture() {
  const clock = { value: 100 }
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  const send = vi.fn(async () => { throw new Error('Unexpected Redis transport in a pure lifetime control') })
  const config = syncCellOwnershipConfig({ SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_ID: 'qa-A',
    SYNC_CELL_ADVERTISE_URL: 'http://qa-a.invalid:3001', SYNC_CELL_PARTITION_COUNT: '1', SYNC_CELL_MULTI_PARTITION: 'on' })
  config.routeMap = { enabled: false, refreshMs: 1000, maxAgeMs: 3000 }
  const coordinator = new SyncCellOwnershipCoordinator({ query } as never,
    { configured: true, ready: true, prefix: 'qa-only', send } as never, config, () => clock.value)
  const internals = coordinator as unknown as {
    partitionLease: Partition | null
    partitionWorker: unknown
    topologyConfirmed: boolean
    leases: Map<string, Lease>
    releaseFlights: Set<Promise<void>>
    partitionLossCount: number
    renewalCount: number
    store: { renew: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
    partitionStore: { renew: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; acquire: ReturnType<typeof vi.fn> }
    renewPartition(): Promise<void>
    renewWorkspaceLeases(): Promise<void>
    pruneExpired(): Promise<void>
    acquirePartitionIfMissing(): Promise<void>
  }
  const workspace = { landscapeId: 'qa-landscape', versionId: 'qa-version' }
  const key = [workspace.landscapeId, workspace.versionId].join(String.fromCharCode(0))
  const lease = { workspace, token: '1', ownerValue: 'qa-A|1|qa-generation', validUntil: 200 }
  const partition = { partition: 0, token: '1', ownerValue: 'qa-A|1|http://qa-a.invalid:3001', validUntil: 10000 }
  internals.partitionLease = partition
  internals.topologyConfirmed = true
  internals.leases.set(key, lease)
  internals.store.renew = vi.fn(async () => true)
  internals.store.release = vi.fn(async () => true)
  internals.partitionStore.renew = vi.fn(async () => true)
  internals.partitionStore.release = vi.fn(async () => true)
  internals.partitionStore.acquire = vi.fn(async () => null)
  return { coordinator, internals, clock, workspace, key, lease, partition, query, send }
}

describe('independent T-12b ownership lifetime controls', () => {
  it('D26 reads keep frozen Worker-backed leases byte-equivalent before and after expiry', async () => {
    const f = fixture()
    f.clock.value = 500
    Object.freeze(f.lease); Object.freeze(f.partition)
    const worker = { lastRenewStartedAt: () => 400, release: vi.fn(async () => true), stop: vi.fn(async () => {}) }
    f.internals.partitionWorker = worker
    const lost = vi.fn(), unsubscribe = f.coordinator.onOwnershipLost(lost)
    const physical = () => JSON.stringify({ partition: f.internals.partitionLease,
      leases: [...f.internals.leases], releaseCount: f.internals.releaseFlights.size,
      partitionLossCount: f.internals.partitionLossCount, renewalCount: f.internals.renewalCount })
    try {
      for (const [now, owns] of [[500, true], [10000, false]] as const) {
        f.clock.value = now
        const before = physical()
        for (let count = 0; count < 100; count++) {
          expect(f.coordinator.owns(f.workspace)).toBe(owns)
          expect(f.coordinator.fencingToken(f.workspace)).toBe(owns ? '1' : null)
          const snapshot = f.coordinator.readSnapshot()
          expect(snapshot.ownedWorkspaceCount).toBe(owns ? 1 : 0)
          syncCellOwnershipMetricSamples(f.coordinator)
          expect(f.coordinator.snapshot()).toEqual(snapshot)
        }
        expect(physical()).toBe(before)
      }
      expect(lost).not.toHaveBeenCalled()
      expect(f.query).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
      expect(f.internals.store.release).not.toHaveBeenCalled()
    } finally { unsubscribe(); await f.coordinator.stop() }
  })

  it('a partition renew completing after its old deadline cannot rejuvenate the old lease', async () => {
    const f = fixture(), reply = held<boolean>(), entered = held<void>()
    f.partition.validUntil = 200
    f.internals.partitionStore.renew.mockImplementation(() => { entered.resolve(); return reply.promise })
    const renewal = f.internals.renewPartition()
    try {
      await entered.promise
      f.clock.value = 201
      reply.resolve(true); await renewal
      expect(f.partition.validUntil).toBe(200)
      expect(f.coordinator.owns(f.workspace)).toBe(false)
    } finally { reply.resolve(true); await renewal; await f.coordinator.stop() }
  })

  it('a failed old partition renew does not erase the replacement lease identity', async () => {
    const f = fixture(), reply = held<boolean>(), entered = held<void>()
    f.internals.partitionStore.renew.mockImplementation(() => { entered.resolve(); return reply.promise })
    const renewal = f.internals.renewPartition()
    try {
      await entered.promise
      const successor = { ...f.partition, token: '2', ownerValue: 'qa-A|2|http://qa-a.invalid:3001' }
      f.internals.partitionLease = successor
      reply.resolve(false); await renewal
      expect(f.internals.partitionLease).toBe(successor)
      expect(f.internals.partitionLossCount).toBe(0)
    } finally { reply.resolve(false); await renewal; await f.coordinator.stop() }
  })

  it('stop joins the actual partition renewal before returning the old partition', async () => {
    const f = fixture(), reply = held<boolean>(), entered = held<void>()
    f.internals.partitionStore.renew.mockImplementation(() => { entered.resolve(); return reply.promise })
    const renewal = f.internals.renewPartition()
    let stopping: Promise<void> | undefined
    try {
      await entered.promise
      let closed = false
      stopping = f.coordinator.stop().then(() => { closed = true })
      await nextTurn()
      expect(closed).toBe(false)
      expect(f.internals.partitionStore.release).not.toHaveBeenCalled()
      reply.resolve(true); await Promise.all([renewal, stopping])
      expect(f.partition.validUntil).toBe(10000)
      expect(f.internals.partitionStore.release).toHaveBeenCalledTimes(1)
      expect(f.internals.partitionLease).toBeNull()
    } finally { reply.resolve(true); await renewal; await stopping; await f.coordinator.stop() }
  })

  it.each(['workspace-expired', 'partition-expired', 'identity-replaced'] as const)(
    'a late successful workspace renewal refuses %s', async reason => {
      const f = fixture(), reply = held<boolean>(), entered = held<void>()
      f.internals.store.renew.mockImplementation(() => { entered.resolve(); return reply.promise })
      const renewal = f.internals.renewWorkspaceLeases()
      try {
        await entered.promise
        if (reason === 'workspace-expired') f.clock.value = 201
        if (reason === 'partition-expired') f.partition.validUntil = 100
        if (reason === 'identity-replaced') f.internals.leases.set(f.key, { ...f.lease, token: '2' })
        reply.resolve(true); await renewal
        expect(f.lease.validUntil).toBe(200)
        expect(f.internals.renewalCount).toBe(0)
        if (reason === 'identity-replaced') expect(f.internals.leases.get(f.key)?.token).toBe('2')
      } finally { reply.resolve(true); await renewal; await f.coordinator.stop() }
    })

  it('stop waits for a workspace renew before releasing its exact old lease', async () => {
    const f = fixture(), reply = held<boolean>(), entered = held<void>()
    f.internals.store.renew.mockImplementation(() => { entered.resolve(); return reply.promise })
    const renewal = f.internals.renewWorkspaceLeases()
    let stopping: Promise<void> | undefined
    try {
      await entered.promise
      let closed = false
      stopping = f.coordinator.stop().then(() => { closed = true })
      await nextTurn()
      expect(closed).toBe(false)
      expect(f.internals.store.release).not.toHaveBeenCalled()
      reply.resolve(true); await Promise.all([renewal, stopping])
      expect(f.lease.validUntil).toBe(200)
      expect(f.internals.renewalCount).toBe(0)
      expect(f.internals.store.release).toHaveBeenCalledExactlyOnceWith(f.workspace, f.lease)
    } finally { reply.resolve(true); await renewal; await stopping; await f.coordinator.stop() }
  })

  it('prune joins release and acquisition refuses the gap after the local map was emptied', async () => {
    const f = fixture(), reply = held<boolean>(), entered = held<void>()
    f.clock.value = 10001
    f.internals.store.release.mockImplementation(() => { entered.resolve(); return reply.promise })
    let pruned = false
    const pruning = f.internals.pruneExpired().then(() => { pruned = true })
    try {
      await entered.promise; await nextTurn()
      expect(f.internals.leases.size).toBe(0)
      expect(f.internals.releaseFlights.size).toBe(1)
      expect(pruned).toBe(false)
      await f.internals.acquirePartitionIfMissing()
      expect(f.internals.partitionStore.acquire).not.toHaveBeenCalled()
      reply.resolve(true); await pruning
      expect(f.internals.releaseFlights.size).toBe(0)
      await f.internals.acquirePartitionIfMissing()
      expect(f.internals.partitionStore.acquire).toHaveBeenCalledTimes(1)
    } finally { reply.resolve(true); await pruning; await f.coordinator.stop() }
  })
})
