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

import { describe, expect, it, vi, type Mock } from 'vitest'
import { LevelStore, type LevelLoader, type LevelStoreOptions } from './levelStore'

interface Loader {
  load: Mock<LevelLoader<number[]>>
  resolve: (value: number[]) => void
  reject: (error: unknown) => void
  signal: () => AbortSignal | undefined
}

/** A loader whose result the test controls; records the signal it was given. */
function loader(): Loader {
  let resolve!: (value: number[]) => void
  let reject!: (error: unknown) => void
  let signal: AbortSignal | undefined
  const promise = new Promise<number[]>((res, rej) => {
    resolve = res
    reject = rej
  })
  const load = vi.fn<LevelLoader<number[]>>((s) => {
    signal = s
    return promise
  })
  return { load, resolve, reject, signal: () => signal }
}

function makeStore(overrides: Partial<LevelStoreOptions<number[]>> = {}) {
  const clock = { t: 0 }
  const store = new LevelStore<number[]>({
    maxEntries: 8,
    maxWeight: 100,
    weigh: (value) => value.length,
    concurrency: 2,
    queueTtlMs: 1_000,
    budget: { count: 3, windowMs: 5_000 },
    now: () => clock.t,
    ...overrides,
  })
  return { store, clock }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('LevelStore warm-up', () => {
  it('remembers a loaded level and serves it', async () => {
    const { store } = makeStore()
    const a = loader()
    expect(store.prefetch('a', a.load)).toBe(true)
    a.resolve([1, 2])
    await settle()
    expect(store.get('a')).toEqual([1, 2])
    expect(store.stats).toMatchObject({ entries: 1, inflight: 0 })
  })

  it('does not request a level that is cached or already coming', async () => {
    const { store } = makeStore()
    const a = loader()
    expect(store.prefetch('a', a.load)).toBe(true)
    expect(store.prefetch('a', a.load)).toBe(false) // in flight
    a.resolve([1])
    await settle()
    expect(store.prefetch('a', a.load)).toBe(false) // cached
    expect(a.load).toHaveBeenCalledTimes(1)
  })

  it('lets a real request join the warm-up on its way', async () => {
    const { store } = makeStore()
    const a = loader()
    store.prefetch('a', a.load)
    const joined = store.inflight('a')
    expect(joined).toBeDefined()
    a.resolve([7])
    await expect(joined).resolves.toEqual([7])
    expect(store.inflight('a')).toBeUndefined()
  })
})

describe('LevelStore request bounds', () => {
  it('runs at most `concurrency` warm-ups and queues only the LATEST intent', async () => {
    const { store } = makeStore({ budget: { count: 99, windowMs: 1 } })
    const [a, b, c, d] = [loader(), loader(), loader(), loader()]
    store.prefetch('a', a.load)
    store.prefetch('b', b.load)
    store.prefetch('c', c.load) // queued
    store.prefetch('d', d.load) // replaces c
    expect(store.stats).toMatchObject({ inflight: 2, queued: 1 })
    expect(c.load).not.toHaveBeenCalled()
    expect(d.load).not.toHaveBeenCalled()

    a.resolve([1])
    await settle()
    expect(d.load).toHaveBeenCalledTimes(1) // the slot went to the latest intent
    expect(c.load).not.toHaveBeenCalled() // the superseded one never ran
  })

  it('drops a queued intent that waited past its time-to-live', async () => {
    const { store, clock } = makeStore({ budget: { count: 99, windowMs: 1 } })
    const [a, b, c] = [loader(), loader(), loader()]
    store.prefetch('a', a.load)
    store.prefetch('b', b.load)
    store.prefetch('c', c.load) // queued at t=0
    clock.t = 5_000
    a.resolve([1])
    await settle()
    expect(c.load).not.toHaveBeenCalled()
    expect(store.stats.queued).toBe(0)
  })

  it('spends a hover budget per window; a press is exempt; the window slides', async () => {
    const { store, clock } = makeStore({ concurrency: 99 })
    const loaders = Array.from({ length: 6 }, () => loader())
    const results = loaders.slice(0, 4).map((l, i) => store.prefetch(`k${i}`, l.load))
    expect(results).toEqual([true, true, true, false]) // budget of 3
    expect(store.prefetch('press', loaders[4].load, { force: true })).toBe(true)
    clock.t = 6_000 // the window moved on
    expect(store.prefetch('later', loaders[5].load)).toBe(true)
  })

  it('a failed warm-up frees its slot for the queued intent', async () => {
    const { store } = makeStore({ budget: { count: 99, windowMs: 1 } })
    const [a, b, c] = [loader(), loader(), loader()]
    store.prefetch('a', a.load)
    store.prefetch('b', b.load)
    store.prefetch('c', c.load)
    a.reject(new Error('boom'))
    await settle()
    expect(store.has('a')).toBe(false)
    expect(c.load).toHaveBeenCalledTimes(1)
  })

  it('treats a loader that throws synchronously as a failed warm-up', async () => {
    const { store } = makeStore()
    store.prefetch('a', () => {
      throw new Error('sync')
    })
    await settle()
    expect(store.stats).toMatchObject({ inflight: 0, entries: 0 })
  })
})

describe('LevelStore cancellation and validity', () => {
  it('cancelExcept aborts every warm-up but the kept level, and the queue', async () => {
    const { store } = makeStore({ budget: { count: 99, windowMs: 1 } })
    const [a, b, c] = [loader(), loader(), loader()]
    store.prefetch('a', a.load)
    store.prefetch('b', b.load)
    store.prefetch('c', c.load) // queued
    store.cancelExcept('a')
    expect(a.signal()?.aborted).toBe(false)
    expect(b.signal()?.aborted).toBe(true)
    expect(store.stats).toMatchObject({ inflight: 1, queued: 0 })
    // the aborted level's late result must not be remembered
    b.resolve([9])
    await settle()
    expect(store.has('b')).toBe(false)
  })

  it('clear forgets everything, aborts what is coming and discards late results', async () => {
    const { store } = makeStore()
    const a = loader()
    const b = loader()
    store.prefetch('a', a.load)
    a.resolve([1])
    await settle()
    store.prefetch('b', b.load)
    store.clear()
    expect(store.has('a')).toBe(false)
    expect(b.signal()?.aborted).toBe(true)
    b.resolve([2]) // left before the model changed
    await settle()
    expect(store.has('b')).toBe(false)
    expect(store.stats).toMatchObject({ entries: 0, weight: 0, inflight: 0 })
  })

  it('clear also drops the queued intent: a stale level must not start after the model changed', async () => {
    const { store } = makeStore({ concurrency: 1, budget: { count: 99, windowMs: 1 } })
    const [a, b] = [loader(), loader()]
    store.prefetch('a', a.load)
    store.prefetch('b', b.load) // queued behind a
    store.clear()
    a.resolve([1])
    await settle()
    expect(b.load).not.toHaveBeenCalled()
    expect(store.stats).toMatchObject({ queued: 0, inflight: 0, entries: 0 })
  })

  it('a warm-up that outlives a clear does not poison the next generation', async () => {
    const { store } = makeStore()
    const stale = loader()
    store.prefetch('k', stale.load)
    store.clear()
    const fresh = loader()
    store.prefetch('k', fresh.load)
    stale.resolve([1])
    await settle()
    expect(store.has('k')).toBe(false) // the stale answer was dropped
    fresh.resolve([2])
    await settle()
    expect(store.get('k')).toEqual([2])
  })
})

describe('LevelStore memory bounds', () => {
  it('evicts the least recently used level past the entry cap', () => {
    const { store } = makeStore({ maxEntries: 2, maxWeight: 1_000 })
    store.put('a', [1])
    store.put('b', [1])
    store.get('a') // a is now fresher than b
    store.put('c', [1])
    expect([store.has('a'), store.has('b'), store.has('c')]).toEqual([true, false, true])
  })

  it('evicts by weight, always keeping the newest level however heavy', () => {
    const { store } = makeStore({ maxEntries: 8, maxWeight: 10 })
    store.put('a', new Array(6).fill(0))
    store.put('b', new Array(6).fill(0)) // 12 > 10 → a goes
    expect([store.has('a'), store.has('b')]).toEqual([false, true])
    store.put('huge', new Array(50).fill(0)) // heavier than the cap on its own
    expect(store.has('huge')).toBe(true)
    expect(store.stats.entries).toBe(1)
    expect(store.stats.weight).toBe(50)
  })

  it('re-putting a level replaces its weight instead of adding to it', () => {
    const { store } = makeStore()
    store.put('a', new Array(10).fill(0))
    store.put('a', new Array(4).fill(0))
    expect(store.stats).toMatchObject({ entries: 1, weight: 4 })
  })

  it('re-putting a level makes it the most recently used', () => {
    const { store } = makeStore({ maxEntries: 3, maxWeight: 1_000 })
    store.put('a', [1])
    store.put('b', [1])
    store.put('c', [1])
    store.put('a', [2]) // refreshed: b is now the oldest
    store.put('d', [1])
    expect([store.has('a'), store.has('b'), store.has('c'), store.has('d')]).toEqual([true, false, true, true])
  })
})

describe('LevelStore edges', () => {
  it('a hover budget window is half-open: the spend leaves it exactly windowMs later', () => {
    const { store, clock } = makeStore({ concurrency: 99, budget: { count: 1, windowMs: 5_000 } })
    expect(store.prefetch('k1', loader().load)).toBe(true) // t=0
    clock.t = 4_999
    expect(store.prefetch('k2', loader().load)).toBe(false)
    clock.t = 5_000
    expect(store.prefetch('k3', loader().load)).toBe(true)
  })

  it('asking again for the queued level keeps its intent fresh', async () => {
    const { store, clock } = makeStore({ concurrency: 1, budget: { count: 99, windowMs: 1 } })
    const [a, c] = [loader(), loader()]
    store.prefetch('a', a.load)
    store.prefetch('c', c.load) // queued at t=0
    clock.t = 900
    store.prefetch('c', c.load) // re-expressed at t=900
    clock.t = 1_400 // 1 400 ms after the first ask (expired), 500 after the last
    a.resolve([1])
    await settle()
    expect(c.load).toHaveBeenCalledTimes(1)
  })

  it('a queued level that got cached meanwhile is not requested again', async () => {
    const { store } = makeStore({ concurrency: 1, budget: { count: 99, windowMs: 1 } })
    const [a, c] = [loader(), loader()]
    store.prefetch('a', a.load)
    store.prefetch('c', c.load)
    store.put('c', [1])
    a.resolve([1])
    await settle()
    expect(c.load).not.toHaveBeenCalled()
  })

  it('a stale warm-up finishing after a clear does not unregister its successor', async () => {
    const { store } = makeStore({ budget: { count: 99, windowMs: 1 } })
    const [stale, fresh] = [loader(), loader()]
    store.prefetch('k', stale.load)
    store.clear()
    store.prefetch('k', fresh.load)
    stale.resolve([1])
    await settle()
    expect(store.inflight('k')).toBeDefined() // still the fresh one
    expect(store.prefetch('k', loader().load)).toBe(false) // no duplicate request
  })

  it('clear advances the generation', () => {
    const { store } = makeStore()
    const before = store.generation
    store.clear()
    expect(store.generation).not.toBe(before)
  })
})
