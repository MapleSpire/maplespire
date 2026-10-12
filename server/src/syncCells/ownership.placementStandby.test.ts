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

import { EventEmitter } from 'node:events'
import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { RedisRuntime } from '../runtime/redis.js'
import { workspacePartition } from './assignment.js'
import { OWNABLE_WORKSPACES_SQL, SyncCellOwnershipCoordinator, syncCellOwnershipConfig } from './ownership.js'
import { formatTopologyContract } from './topologyContract.js'
import { WORKSPACE_PLACEMENT_CHANNEL } from './workspacePlacement.js'

const workspace = { landscapeId: 'standby-landscape', versionId: 'standby-version' }
const hash = workspacePartition(workspace, 2)
const placed = 1 - hash

/** The real public reconciliation, default resolver, store decoding and LISTEN
 * callback run here. Only the PG/Redis transports are simulated: both partition
 * acquisitions are refused. This is not a PostgreSQL NOTIFY or runtime test. */
function fixture() {
  const config = syncCellOwnershipConfig({
    SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_ID: 'placed-standby',
    SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on',
    SYNC_CELL_PLACEMENT_MODE: 'placed', SYNC_CELL_PARTITION_WORKER: 'off',
    SYNC_CELL_TOPOLOGY_GENERATION: 'standby-test',
  })
  const prefix = 'test:placed-standby'
  const topologyKey = `${prefix}:sync-cell:topology`
  const contract = formatTopologyContract({ generation: config.topologyGeneration, partitionCount: 2, placementMode: 'placed' })
  const ownerKey = (partition: number) => `${prefix}:sync-cell:partition:${config.topologyGeneration}:${partition}:owner`
  const owners = new Map([0, 1].map(partition => [ownerKey(partition),
    `peer-${partition}|${11 + partition}|http://peer-${partition}:3000`]))
  let selected = placed
  let selectFailure: Error | null = null
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === 'SELECT value FROM sync_topology_contract WHERE singleton = TRUE') {
      return { rows: [{ value: contract }], rowCount: 1 }
    }
    if (sql === OWNABLE_WORKSPACES_SQL) {
      return { rows: [{ landscape_id: workspace.landscapeId, id: workspace.versionId }], rowCount: 1 }
    }
    // The public start lifecycle also reads its durable-fence baseline and
    // server ceilings before starting the timer-refreshed owner-route map.
    if (sql.includes('FROM sync_workspace_ownership')) return { rows: [], rowCount: 0 }
    if (sql.includes("current_setting('statement_timeout')")) {
      return { rows: [{ statement_timeout: '30s', lock_timeout: '5s' }], rowCount: 1 }
    }
    if (sql.includes('FROM workspace_placement')) {
      expect(params).toEqual([config.topologyGeneration])
      if (selectFailure) throw selectFailure
      return { rows: [{ landscape_id: workspace.landscapeId, version_id: workspace.versionId, partition: selected }], rowCount: 1 }
    }
    throw new Error(`Unexpected standby SQL: ${sql}`)
  })
  const listenerClient = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      expect(sql).toBe(`LISTEN ${WORKSPACE_PLACEMENT_CHANNEL}`)
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  })
  const connect = vi.fn(async () => listenerClient)
  const send = vi.fn(async (args: string[]): Promise<unknown> => {
    if (args[0] === 'EVAL' && args[2] === '1' && args[3] === topologyKey) {
      expect(args[4]).toBe(contract)
      return 1 // Existing matching topology; no mirror publication is needed.
    }
    if (args[0] === 'GET' && args[1] === topologyKey) return contract
    if (args[0] === 'MGET') {
      expect(args).toEqual(['MGET', ownerKey(0), ownerKey(1)])
      return args.slice(1).map(key => owners.get(key) ?? null)
    }
    for (const partition of [0, 1]) {
      if (args[0] === 'GET' && args[1] === ownerKey(partition)) {
        return owners.get(ownerKey(partition))
      }
      if (args[0] === 'EVAL' && args[2] === '2' && args[3] === ownerKey(partition)) {
        expect(args[4]).toBe(ownerKey(partition).replace(/:owner$/, ':fence'))
        return [0, ''] // Both partitions are already held by their peers.
      }
    }
    throw new Error(`Unexpected standby Redis command: ${args[0]} ${args[3] ?? args[1]}`)
  })
  const coordinator = new SyncCellOwnershipCoordinator(
    { options: { max: 2 }, query, connect } as unknown as Pool,
    { ready: true, configured: true, prefix, send } as unknown as RedisRuntime,
    config,
  )
  const reconcile = vi.spyOn(coordinator, 'reconcileNow')
  const acquired = vi.fn()
  coordinator.onOwnershipAcquired(acquired)
  const notify = () => {
    const before = reconcile.mock.calls.length
    listenerClient.emit('notification', { channel: WORKSPACE_PLACEMENT_CHANNEL, payload: 'untrusted hint' })
    // Do not call reconcile to wait: doing that would hide missing wiring.
    expect(reconcile).toHaveBeenCalledTimes(before + 1)
    const result = reconcile.mock.results.at(-1)!
    expect(result.type).toBe('return')
    return result.value as Promise<void>
  }
  const assertEmptyFence = (errors = 0) => {
    expect(coordinator.snapshot()).toMatchObject({
      topologyConfirmed: true, canServe: true, ready: false,
      partitionIndex: null, partitionReady: false, partitionAcquisitionCount: 0,
      discoveredWorkspaceCount: 1, expectedWorkspaceCount: 0, ownedWorkspaceCount: 0,
      acquisitionCount: 0, lossCount: 0, errorCount: errors,
      ownerRouteMap: { enabled: true, usable: true, entries: 2, refreshErrorCount: 0 },
      fenceReadingCurrent: true, fenceDivergencesSeen: 0,
      fenceDivergenceByCause: { belowLive: 0, aboveLive: 0, released: 0, absent: 0, foreignCellAtSameToken: 0 },
    })
    const observedAt = coordinator.snapshot().fenceReadingObservedAt
    expect(observedAt).toEqual(expect.any(String))
    expect(new Date(observedAt!).toISOString()).toBe(observedAt)
    expect(coordinator.owns(workspace)).toBe(false)
    expect(acquired).not.toHaveBeenCalled()
    expect(send.mock.calls.filter(([args]) => args[0] === 'EVAL'
      && ![topologyKey, ownerKey(0), ownerKey(1)].includes(args[3]!))).toEqual([])
  }
  return {
    coordinator, query, send, connect, listenerClient, ownerKey, config, notify, assertEmptyFence,
    setPartition(value: number) { selected = value },
    setFailure(error: Error | null) { selectFailure = error },
  }
}

describe('placed standby routing snapshot', () => {
  it('keeps cold routing closed after a failed first SELECT until a complete snapshot is published', async () => {
    const f = fixture()
    try {
      expect(f.coordinator.snapshot()).toMatchObject({ ready: false, canServe: false })
      f.setFailure(new Error('initial standby placement SELECT unavailable'))
      await expect(f.coordinator.reconcileNow()).rejects.toThrow('initial standby placement SELECT unavailable')
      expect(f.coordinator.snapshot()).toMatchObject({
        topologyConfirmed: true, ready: false, canServe: false,
        partitionIndex: null, acquisitionCount: 0, ownedWorkspaceCount: 0,
        placementRowsCompared: null, placementDivergenceCount: null,
      })
      expect(() => f.coordinator.partitionFor(workspace)).toThrow('has not loaded')
      await expect(f.coordinator.resolveOwner(workspace)).rejects.toThrow('has not loaded')
      f.setFailure(null)
      // Reconcile alone does not start the independent owner-route sampler.
      // Boot the public lifecycle before asserting that this cell can relay.
      await f.coordinator.start()
      expect(f.coordinator.partitionFor(workspace)).toBe(placed)
      f.assertEmptyFence(f.coordinator.snapshot().errorCount)
    } finally { await f.coordinator.stop() }
  })

  it('loads without a partition and follows its real invalidation callback without acquiring a workspace', async () => {
    const f = fixture()
    try {
      expect(placed).not.toBe(hash)
      expect(() => f.coordinator.partitionFor(workspace)).toThrow('has not loaded')
      await f.coordinator.start()
      expect(f.connect).toHaveBeenCalledTimes(1)
      expect(f.listenerClient.query).toHaveBeenCalledExactlyOnceWith(`LISTEN ${WORKSPACE_PLACEMENT_CHANNEL}`)
      expect(new Set(f.send.mock.calls.filter(([args]) => args[0] === 'EVAL' && args[2] === '2').map(([args]) => args[3])))
        .toEqual(new Set([f.ownerKey(0), f.ownerKey(1)]))
      f.assertEmptyFence()
      expect(f.coordinator.snapshot()).toMatchObject({ placementRowsCompared: 1, placementDivergenceCount: 1 })
      const reads = f.query.mock.calls.length
      for (let i = 0; i < 20; i++) expect(f.coordinator.partitionFor(workspace)).toBe(placed)
      await expect(f.coordinator.resolveOwner(workspace)).resolves.toEqual({
        partition: placed, cellId: `peer-${placed}`, token: String(11 + placed), advertiseUrl: `http://peer-${placed}:3000`,
      })
      expect(f.query).toHaveBeenCalledTimes(reads)
      const placementReads = () => f.query.mock.calls.filter(([sql]) => sql.includes('FROM workspace_placement')).length
      const discoveryReads = () => f.query.mock.calls.filter(([sql]) => sql === OWNABLE_WORKSPACES_SQL).length
      const before = { placement: placementReads(), discovery: discoveryReads() }
      f.setPartition(hash)
      await f.notify()
      expect(placementReads()).toBe(before.placement + 1)
      expect(discoveryReads()).toBe(before.discovery + 1)
      expect(f.coordinator.partitionFor(workspace)).toBe(hash)
      await expect(f.coordinator.resolveOwner(workspace)).resolves.toMatchObject({ partition: hash, cellId: `peer-${hash}` })
      expect(f.coordinator.snapshot()).toMatchObject({ placementRowsCompared: 1, placementDivergenceCount: 0 })
      f.assertEmptyFence()
    } finally { await f.coordinator.stop() }
    expect(f.listenerClient.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
    const readsAfterStop = f.query.mock.calls.length
    f.listenerClient.emit('notification', { channel: WORKSPACE_PLACEMENT_CHANNEL })
    await Promise.resolve()
    expect(f.query).toHaveBeenCalledTimes(readsAfterStop)
  })

  it('keeps the last route and divergence on a failed notified SELECT, then reads a fresh snapshot', async () => {
    const f = fixture()
    try {
      await f.coordinator.start()
      f.setPartition(hash)
      f.setFailure(new Error('standby placement SELECT unavailable'))
      await expect(f.notify()).rejects.toThrow('standby placement SELECT unavailable')
      expect(f.coordinator.partitionFor(workspace)).toBe(placed)
      expect(f.coordinator.snapshot()).toMatchObject({ placementRowsCompared: 1, placementDivergenceCount: 1 })
      f.assertEmptyFence(1)
      f.setFailure(null)
      await f.notify()
      expect(f.coordinator.partitionFor(workspace)).toBe(hash)
      f.assertEmptyFence(1)
    } finally { await f.coordinator.stop() }
  })
})
