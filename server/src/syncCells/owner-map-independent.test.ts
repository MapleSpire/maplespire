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

// Independent owner-route-map lifetime and expiry controls.
// The first two controls keep the actual default 3000 ms age and the production
// monotonic clock.
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OwnerRouteMap, ownerRouteMapConfig } from './ownerRouteMap.js'
import type { SyncCellOwnerRoute } from './ownership.js'

const route: SyncCellOwnerRoute = { cellId: 'qa-A', token: '1', partition: 0, advertiseUrl: 'http://qa-a.invalid:3001' }
function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(() => vi.useRealTimers())

describe('independent T-12b map controls', () => {
  it('the real default monotonic age includes 3050 ms awaiting the initial response', async () => {
    const reply = held<ReadonlyMap<number, SyncCellOwnerRoute>>(), entered = held<void>()
    const config = ownerRouteMapConfig({})
    expect(config.maxAgeMs).toBe(3000)
    const map = new OwnerRouteMap(() => { entered.resolve(); return reply.promise }, config, error => { throw error })
    const starting = map.start()
    try {
      await entered.promise
      await delay(config.maxAgeMs + 50)
      reply.resolve(new Map([[0, route]])); await starting
      expect(map.readSnapshot().sampleSequence).toBe(1)
      expect(map.readSnapshot().sampleAgeMs).toBeGreaterThanOrEqual(3000)
      expect(map.readSnapshot().usable).toBe(false)
      expect(map.resolve(0)).toBeNull()
    } finally { reply.resolve(new Map()); await starting; await map.stop() }
  })

  it('a fresh real sample expires while background refreshes fail without rewriting the sample stamp', async () => {
    const config = ownerRouteMapConfig({})
    const errors = vi.fn()
    const load = vi.fn().mockResolvedValueOnce(new Map([[0, route]])).mockRejectedValue(new Error('synthetic refresh failure'))
    const map = new OwnerRouteMap(load, config, errors)
    try {
      await map.start()
      expect(map.resolve(0)).toEqual(route)
      const stamp = map.readSnapshot().sampledAt
      await delay(config.maxAgeMs + 50)
      expect(load.mock.calls.length).toBeGreaterThan(1)
      expect(errors.mock.calls.length).toBeGreaterThan(0)
      const count = load.mock.calls.length
      for (let index = 0; index < 100; index++) {
        expect(map.resolve(0)).toBeNull()
        expect(map.readSnapshot()).toMatchObject({ usable: false, sampledAt: stamp, sampleSequence: 1 })
        expect(map.readSnapshot().sampleAgeMs).toBeGreaterThanOrEqual(3000)
      }
      expect(load).toHaveBeenCalledTimes(count)
    } finally { await map.stop() }
  })

  it('two stop callers join a periodic refresh; its late result cannot publish or leave a timer', async () => {
    vi.useFakeTimers()
    const reply = held<ReadonlyMap<number, SyncCellOwnerRoute>>()
    const load = vi.fn().mockResolvedValueOnce(new Map([[0, route]])).mockReturnValue(reply.promise)
    const map = new OwnerRouteMap(load, { enabled: true, refreshMs: 50, maxAgeMs: 100 }, vi.fn(), () => 0)
    await map.start()
    await vi.advanceTimersByTimeAsync(50)
    const stopped = vi.fn()
    const stopping = [map.stop().then(stopped), map.stop().then(stopped)]
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(load).toHaveBeenCalledTimes(2)
      expect(stopped).not.toHaveBeenCalled()
      reply.resolve(new Map([[0, { ...route, cellId: 'qa-B', token: '2' }]]))
      await Promise.all(stopping)
      expect(stopped).toHaveBeenCalledTimes(2)
      expect(map.readSnapshot()).toMatchObject({ sampleSequence: 1, entries: 0, usable: false })
      await vi.advanceTimersByTimeAsync(1000)
      expect(load).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally { reply.resolve(new Map()); await Promise.all(stopping); await map.stop() }
  })
})
