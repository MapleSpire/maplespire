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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncCellPartitionConfig, workspacePartition } from './assignment.js'
import { RouterPlacementRefresh } from './routerPlacement.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const workspace = { landscapeId: 'L1', versionId: 'V1' }
const row = (partition: number) => ({ landscape_id: 'L1', version_id: 'V1', partition })
const config = (mode = 'placed') => syncCellPartitionConfig({
  SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on', SYNC_CELL_PLACEMENT_MODE: mode,
  SYNC_CELL_TOPOLOGY_GENERATION: 'router-test',
})

afterEach(() => vi.useRealTimers())

describe('T-10h3 router placement refresh', () => {
  it('keeps shadow interval sampling without reserving a LISTEN checkout from a max=1 pool', async () => {
    vi.useFakeTimers()
    const query = vi.fn(async () => ({ rows: [row(1 - workspacePartition(workspace, 2))] }))
    const connect = vi.fn(async () => { throw new Error('Unexpected LISTEN checkout') })
    const errors = vi.fn(), published = vi.fn(async () => {})
    const refresh = new RouterPlacementRefresh({
      db: { options: { max: 1 }, connect, query } as never, partition: config('shadow'),
      onPublished: published, onError: errors,
    })
    try {
      await refresh.start()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(query).toHaveBeenCalledTimes(2)
      expect(query).toHaveBeenLastCalledWith(expect.stringContaining('FROM workspace_placement'), [config('shadow').topologyGeneration])
      expect(published).toHaveBeenCalledTimes(2)
      expect(refresh.resolver.loaded).toBe(true)
      expect(refresh.resolver.partitionOf(workspace, 2)).toBe(workspacePartition(workspace, 2))
      expect(connect).not.toHaveBeenCalled()
      expect(errors).not.toHaveBeenCalled()
    } finally { await refresh.stop() }
    expect(connect).not.toHaveBeenCalled()
  })

  it('rejects a placed max=1 pool before a LISTEN checkout or snapshot query', () => {
    const connect = vi.fn(), query = vi.fn()
    expect(() => new RouterPlacementRefresh({
      db: { options: { max: 1 }, connect, query } as never, partition: config(),
      onPublished: vi.fn(), onError: vi.fn(),
    })).toThrow('pool max of at least 2')
    expect(connect).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('awaits LISTEN and initial SELECT, shares the effective generation, and refreshes on its interval', async () => {
    vi.useFakeTimers()
    const listening = deferred<void>(), connecting = deferred<void>()
    const selected = 1 - workspacePartition(workspace, 2)
    const query = vi.fn(async () => ({ rows: [row(selected)] }))
    const published = vi.fn(async () => {})
    const errors = vi.fn()
    let invalidation!: () => void
    let connected = false
    const refresh = new RouterPlacementRefresh({
      db: { query } as never, partition: config(), onPublished: published, onError: errors,
      listenerFactory: (invalidate) => {
        invalidation = invalidate
        return {
          connect: async () => {
            if (connected) return
            connecting.resolve()
            await listening.promise
            connected = true
            invalidate()
          },
          stop: async () => {},
        }
      },
    })
    try {
      const starting = refresh.start()
      await connecting.promise
      expect(query).not.toHaveBeenCalled()
      expect(refresh.resolver.loaded).toBe(false)
      listening.resolve()
      await starting
      expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('FROM workspace_placement'), [config().topologyGeneration])
      expect(refresh.resolver.partitionOf(workspace, 2)).toBe(selected)
      expect(published).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(query).toHaveBeenCalledTimes(2)
      invalidation()
      await refresh.refresh()
      expect(query).toHaveBeenCalledTimes(3)
      expect(errors).not.toHaveBeenCalled()
    } finally { await refresh.stop() }
  })

  it('coalesces a burst during SELECT into one additional fresh read, never overlapping queries', async () => {
    const blocked = deferred<void>(), entered = deferred<void>()
    let invalidate!: () => void
    let active = 0, maximum = 0, calls = 0
    const query = vi.fn(async () => {
      active += 1; maximum = Math.max(maximum, active)
      const call = ++calls
      try {
        if (call === 1) { entered.resolve(); await blocked.promise }
        return { rows: [row(call === 1 ? 0 : 1)] }
      } finally { active -= 1 }
    })
    const published = vi.fn(async () => {})
    const refresh = new RouterPlacementRefresh({
      db: { query } as never, partition: config(), onPublished: published, onError: vi.fn(),
      listenerFactory: (callback) => { invalidate = callback; return { connect: async () => {}, stop: async () => {} } },
    })
    try {
      const starting = refresh.start()
      await entered.promise
      for (let n = 0; n < 5; n++) invalidate()
      const joined = refresh.refresh()
      blocked.resolve()
      await Promise.all([starting, joined])
      expect(query).toHaveBeenCalledTimes(2)
      expect(maximum).toBe(1)
      expect(published).toHaveBeenCalledTimes(2)
      expect(refresh.resolver.partitionOf(workspace, 2)).toBe(1)
    } finally { await refresh.stop() }
  })

  it('rejects an unreadable initial placed snapshot, while shadow still uses its hash', async () => {
    const boom = new Error('placement SELECT failed')
    for (const mode of ['placed', 'shadow']) {
      const error = vi.fn()
      const refresh = new RouterPlacementRefresh({
        db: { query: vi.fn(async () => { throw boom }) } as never,
        partition: config(mode), onPublished: vi.fn(), onError: error,
        listenerFactory: () => ({ connect: async () => {}, stop: async () => {} }),
      })
      try {
        if (mode === 'placed') {
          await expect(refresh.start()).rejects.toBe(boom)
          expect(() => refresh.resolver.partitionOf(workspace, 2)).toThrow('has not loaded')
        } else {
          await refresh.start()
          expect(refresh.resolver.partitionOf(workspace, 2)).toBe(workspacePartition(workspace, 2))
          expect(error).toHaveBeenCalledWith(boom)
        }
        expect(refresh.resolver.loaded).toBe(false)
      } finally { await refresh.stop() }
    }
  })

  it('preserves its last complete snapshot on SQL error and retries instead of publishing an empty map', async () => {
    const selected = 1 - workspacePartition(workspace, 2)
    const boom = new Error('transport lost')
    const query = vi.fn().mockResolvedValueOnce({ rows: [row(selected)] })
      .mockRejectedValueOnce(boom).mockResolvedValueOnce({ rows: [] })
    const published = vi.fn(async () => {})
    const refresh = new RouterPlacementRefresh({
      db: { query } as never, partition: config(), onPublished: published, onError: vi.fn(),
      listenerFactory: () => ({ connect: async () => {}, stop: async () => {} }),
    })
    try {
      await refresh.start()
      await expect(refresh.refresh()).rejects.toBe(boom)
      expect(refresh.resolver.partitionOf(workspace, 2)).toBe(selected)
      expect(published).toHaveBeenCalledTimes(1)
      await refresh.refresh()
      expect(refresh.resolver.partitionOf(workspace, 2)).toBe(workspacePartition(workspace, 2))
      expect(published).toHaveBeenCalledTimes(2)
    } finally { await refresh.stop() }
  })

  it('keeps the SELECT fallback when LISTEN fails and reports that subscription failure', async () => {
    const boom = new Error('LISTEN failed')
    const error = vi.fn(), query = vi.fn(async () => ({ rows: [] }))
    const connect = vi.fn(async () => { throw boom })
    const refresh = new RouterPlacementRefresh({
      db: { query } as never, partition: config(), onPublished: vi.fn(), onError: error,
      listenerFactory: () => ({ connect, stop: async () => {} }),
    })
    try {
      await refresh.start()
      expect(error).toHaveBeenCalledExactlyOnceWith(boom)
      expect(refresh.resolver.loaded).toBe(true)
      await refresh.refresh()
      expect(connect).toHaveBeenCalledTimes(2)
      expect(query).toHaveBeenCalledTimes(2)
    } finally { await refresh.stop() }
  })

  it.each(['connect', 'select', 'publish'] as const)('joins stop during %s and ignores later notifications', async (stage) => {
    vi.useFakeTimers()
    const entered = deferred<void>(), gate = deferred<void>()
    const wait = async (current: string) => { if (current === stage) { entered.resolve(); await gate.promise } }
    let invalidate!: () => void
    const query = vi.fn(async () => { await wait('select'); return { rows: [row(1)] } })
    const published = vi.fn(async () => { await wait('publish') })
    const listenerStop = vi.fn(async () => {})
    const refresh = new RouterPlacementRefresh({
      db: { query } as never, partition: config(), onPublished: published, onError: vi.fn(),
      listenerFactory: (callback) => {
        invalidate = callback
        return { connect: async () => { await wait('connect') }, stop: listenerStop }
      },
    })
    const starting = refresh.start()
    await entered.promise
    const stopping = refresh.stop()
    expect(refresh.stop()).toBe(stopping)
    let joined = false
    void stopping.then(() => { joined = true })
    await Promise.resolve()
    expect(joined).toBe(false)
    invalidate()
    gate.resolve()
    await Promise.all([starting, stopping])
    expect(listenerStop).toHaveBeenCalledTimes(1)
    expect(refresh.resolver.loaded).toBe(stage === 'publish')
    expect(published).toHaveBeenCalledTimes(stage === 'publish' ? 1 : 0)
    const reads = query.mock.calls.length
    invalidate()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(query).toHaveBeenCalledTimes(reads)
  })

  it('preserves cleanup failure while still joining the actual SELECT', async () => {
    const gate = deferred<void>(), entered = deferred<void>()
    const cleanupError = new Error('listener cleanup failed')
    const refresh = new RouterPlacementRefresh({
      db: { query: async () => { entered.resolve(); await gate.promise; return { rows: [] } } } as never,
      partition: config(), onPublished: vi.fn(), onError: vi.fn(),
      listenerFactory: () => ({ connect: async () => {}, stop: () => { throw cleanupError } }),
    })
    const starting = refresh.start()
    await entered.promise
    const stopping = refresh.stop()
    const rejected = expect(stopping).rejects.toMatchObject({ errors: [cleanupError] })
    let joined = false
    void stopping.then(() => { joined = true }, () => { joined = true })
    await Promise.resolve()
    expect(joined).toBe(false)
    gate.resolve()
    await Promise.all([starting, rejected])
    expect(refresh.resolver.loaded).toBe(false)
  })

  it('joins slow interval reads without queuing another read for every elapsed tick', async () => {
    vi.useFakeTimers()
    const gate = deferred<void>()
    const query = vi.fn(async () => {
      if (query.mock.calls.length === 2) await gate.promise
      return { rows: [] }
    })
    const refresh = new RouterPlacementRefresh({
      db: { query } as never, partition: config(), intervalMs: 1_000,
      onPublished: vi.fn(async () => {}), onError: vi.fn(),
      listenerFactory: () => ({ connect: async () => {}, stop: async () => {} }),
    })
    try {
      await refresh.start()
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(query).toHaveBeenCalledTimes(2)
      gate.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(query).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(query).toHaveBeenCalledTimes(3)
    } finally { await refresh.stop() }
  })
})
