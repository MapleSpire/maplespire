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
import { OwnerRouteMap, ownerRouteMapConfig } from './ownerRouteMap.js'
import { FencedPartitionLeaseStore, type SyncCellOwnerRoute } from './ownership.js'

const A: SyncCellOwnerRoute = { cellId: 'A', token: '1', advertiseUrl: 'http://a:3001', partition: 0 }
const B: SyncCellOwnerRoute = { cellId: 'B', token: '2', advertiseUrl: 'http://b:3001', partition: 0 }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
afterEach(() => { vi.useRealTimers() })

describe('T-12b owner routing from a timer sample', () => {
  it('defaults to one second refresh and three second maximum age; only off rolls back', () => {
    expect(ownerRouteMapConfig({})).toEqual({ enabled: true, refreshMs: 1000, maxAgeMs: 3000 })
    expect(ownerRouteMapConfig({ SYNC_CELL_ROUTE_MAP: 'off' }).enabled).toBe(false)
    expect(ownerRouteMapConfig({ SYNC_CELL_ROUTE_MAP: 'false' }).enabled).toBe(true)
    expect(ownerRouteMapConfig({ SYNC_CELL_ROUTE_MAP_REFRESH_MS: '0', SYNC_CELL_ROUTE_MAP_MAX_AGE_MS: 'NaN' }))
      .toEqual({ enabled: true, refreshMs: 1000, maxAgeMs: 3000 })
  })

  it('reads the map 100 times without starting or awaiting another load', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => new Map([[0, A]]))
    const map = new OwnerRouteMap(load, ownerRouteMapConfig({}), vi.fn(), () => 0)
    try {
      expect(map.resolve(0)).toBeNull()
      expect(load).not.toHaveBeenCalled()
      await map.start()
      expect(load).toHaveBeenCalledTimes(1)
      for (let i = 0; i < 100; i += 1) expect(map.resolve(0)).toEqual(A)
      expect(load).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(load).toHaveBeenCalledTimes(2)
    } finally { await map.stop() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('joins a refresh in flight and publishes the replacement atomically', async () => {
    vi.useFakeTimers()
    const next = deferred<ReadonlyMap<number, SyncCellOwnerRoute>>()
    const load = vi.fn().mockResolvedValueOnce(new Map([[0, A]])).mockReturnValue(next.promise)
    let clock = 0
    const map = new OwnerRouteMap(load, ownerRouteMapConfig({}), vi.fn(), () => clock)
    try {
      await map.start()
      clock = 1000
      await vi.advanceTimersByTimeAsync(1000)
      expect(load).toHaveBeenCalledTimes(2)
      expect(map.readSnapshot().refreshInFlight).toBe(true)
      await vi.advanceTimersByTimeAsync(2000)
      expect(load).toHaveBeenCalledTimes(2)
      expect(map.resolve(0)).toEqual(A)
      next.resolve(new Map([[0, B]]))
      await vi.advanceTimersByTimeAsync(0)
      expect(map.resolve(0)).toEqual(B)
      expect(map.readSnapshot().sampleSequence).toBe(2)
    } finally { next.resolve(new Map()); await map.stop() }
  })

  it('expires a prior sample even while all later refreshes fail', async () => {
    vi.useFakeTimers()
    let clock = 0
    const errors = vi.fn()
    const load = vi.fn().mockResolvedValueOnce(new Map([[0, A]])).mockRejectedValue(new Error('Redis down'))
    const map = new OwnerRouteMap(load, ownerRouteMapConfig({}), errors, () => clock)
    try {
      await map.start()
      await vi.advanceTimersByTimeAsync(1000)
      clock = 2999
      expect(map.resolve(0)).toEqual(A)
      clock = 3000
      expect(map.resolve(0)).toBeNull()
      expect(map.readSnapshot()).toMatchObject({ sampleSequence: 1, entries: 1, refreshErrorCount: 1, usable: false })
      expect(errors).toHaveBeenCalledTimes(1)
    } finally { await map.stop() }
  })

  it('ages a delayed initial reply from the start of its MGET, not receipt', async () => {
    vi.useFakeTimers()
    let clock = 0
    const pending = deferred<ReadonlyMap<number, SyncCellOwnerRoute>>()
    const map = new OwnerRouteMap(() => pending.promise, ownerRouteMapConfig({}), vi.fn(), () => clock)
    const started = map.start()
    await Promise.resolve()
    clock = 3001
    pending.resolve(new Map([[0, A]]))
    try {
      await started
      expect(map.readSnapshot()).toMatchObject({ sampleAgeMs: 3001, sampleSequence: 1, usable: false })
      expect(map.resolve(0)).toBeNull()
    } finally { await map.stop() }
  })

  it('distinguishes an empty successful sample from no successful sample', async () => {
    vi.useFakeTimers()
    const map = new OwnerRouteMap(async () => new Map(), ownerRouteMapConfig({}), vi.fn(), () => 0)
    try {
      expect(map.readSnapshot()).toMatchObject({ sampledAt: null, sampleSequence: 0, usable: false })
      await map.start()
      expect(map.readSnapshot()).toMatchObject({ sampleSequence: 1, entries: 0, sampleAgeMs: 0, usable: true })
      expect(map.readSnapshot().sampledAt).not.toBeNull()
      expect(map.resolve(0)).toBeNull()
    } finally { await map.stop() }
  })

  it('refuses a clock that moved behind the sampling point', async () => {
    vi.useFakeTimers()
    let clock = 10
    const map = new OwnerRouteMap(async () => new Map([[0, A]]), ownerRouteMapConfig({}), vi.fn(), () => clock)
    try {
      await map.start()
      clock = 9
      expect(map.resolve(0)).toBeNull()
    } finally { await map.stop() }
  })

  it('waits for a read during stop and never publishes its late result or arms a timer', async () => {
    vi.useFakeTimers()
    const pending = deferred<ReadonlyMap<number, SyncCellOwnerRoute>>()
    const load = vi.fn(() => pending.promise)
    const map = new OwnerRouteMap(load, ownerRouteMapConfig({}), vi.fn(), () => 0)
    const started = map.start()
    await Promise.resolve()
    const stopped = vi.fn()
    const stopping = map.stop().then(stopped)
    await Promise.resolve()
    expect(stopped).not.toHaveBeenCalled()
    pending.resolve(new Map([[0, A]]))
    await Promise.all([started, stopping])
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(map.readSnapshot()).toMatchObject({ usable: false, sampleSequence: 0, entries: 0 })
    expect(map.resolve(0)).toBeNull()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does no work when the map is disabled, including start and stop', async () => {
    vi.useFakeTimers()
    const load = vi.fn()
    const map = new OwnerRouteMap(load, ownerRouteMapConfig({ SYNC_CELL_ROUTE_MAP: 'off' }), vi.fn())
    await map.start()
    await vi.advanceTimersByTimeAsync(10_000)
    await map.stop()
    expect(load).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(map.resolve(0)).toBeNull()
  })

  it('copies input and returned routes so a consumer cannot corrupt another request', async () => {
    vi.useFakeTimers()
    const source = { ...A }
    const routes = new Map([[0, source]])
    const map = new OwnerRouteMap(async () => routes, ownerRouteMapConfig({}), vi.fn(), () => 0)
    try {
      await map.start()
      source.cellId = 'changed source'
      routes.clear()
      const read = map.resolve(0)!
      read.cellId = 'changed consumer'
      expect(map.resolve(0)).toEqual(A)
    } finally { await map.stop() }
  })

  it('a synchronous loader failure is reported and the next tick retries', async () => {
    vi.useFakeTimers()
    const errors = vi.fn()
    const load = vi.fn().mockImplementationOnce(() => { throw new Error('sync failure') }).mockResolvedValue(new Map([[0, A]]))
    const map = new OwnerRouteMap(load, ownerRouteMapConfig({}), errors, () => 0)
    try {
      await map.start()
      expect(map.resolve(0)).toBeNull()
      expect(errors).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(map.resolve(0)).toEqual(A)
    } finally { await map.stop() }
  })
})

describe('one MGET of the partition store', () => {
  it('samples every partition exactly once and uses the direct lookup codec', async () => {
    const send = vi.fn(async (args: string[]) => args[0] === 'MGET'
      ? ['A|1|http://a:3001', null, 'invalid'] : 'A|1|http://a:3001')
    const store = new FencedPartitionLeaseStore({ configured: true, ready: true, prefix: 't12b', send } as never, 'generation')
    expect(await store.resolveAll(3)).toEqual(new Map([[0, A]]))
    const mget = send.mock.calls[0][0]
    expect(mget[0]).toBe('MGET')
    expect(mget).toHaveLength(4)
    expect(new Set(mget.slice(1)).size).toBe(3)
    expect(await store.resolve(0)).toEqual(A)
    expect(send.mock.calls[1][0]).toEqual(['GET', mget[1]])
  })

  it('never accepts an incomplete response or requests more than 1024 partitions', async () => {
    const send = vi.fn(async () => [])
    const store = new FencedPartitionLeaseStore({ configured: true, ready: true, prefix: 't12b', send } as never, 'generation')
    await expect(store.resolveAll(2)).rejects.toThrow('Incomplete')
    send.mockClear()
    await expect(store.resolveAll(1025)).rejects.toThrow('Invalid')
    expect(send).not.toHaveBeenCalled()
  })
})
