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

import { describe, expect, it, vi } from 'vitest'
import { BoundedResolveDeadlineError, resolveCooperatively, resolveInBatches, resolveWithBoundedConcurrency } from './batchedResolve.js'

describe('server shard resolution', () => {
  it('yields between complete resolutions even when every result is already ready', async () => {
    const order: string[] = []
    const result = await resolveCooperatively(['a', 'b', 'c'], async (id) => {
      order.push(`resolve-${id}`)
      setImmediate(() => order.push(`io-${id}`))
      return id.toUpperCase()
    })
    expect(result).toEqual(['A', 'B', 'C'])
    expect(order.slice(0, 5)).toEqual(['resolve-a', 'io-a', 'resolve-b', 'io-b', 'resolve-c'])
    await new Promise<void>(resolve => setImmediate(resolve))
  })

  it('propagates a failed resolution without starting later documents', async () => {
    const seen: number[] = []
    await expect(resolveCooperatively([1, 2, 3], async id => {
      seen.push(id)
      if (id === 2) throw new Error('storage failed')
      return id
    })).rejects.toThrow('storage failed')
    expect(seen).toEqual([1, 2])
  })

  it('leaves PostgreSQL pool headroom during a cold build', async () => {
    let active = 0
    let maximum = 0
    const values = await resolveInBatches(
      Array.from({ length: 600 }, (_, index) => `shard-${index}`),
      async (url) => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active -= 1
        return url
      },
    )
    expect(maximum).toBe(3)
    expect(values).toHaveLength(600)
  })
})

/** The diagnosis shape (G4-16f q1): every find has its OWN timeout, started
 * when the find is called, and the loads behind them run one at a time (a
 * synchronous `A.load` each, on the one event loop). */
function serialLoads(loadMs: number, timeoutMs: number) {
  let queue = Promise.resolve()
  return (item: number) => new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`find ${item} timed out`)), timeoutMs)
    queue = queue.then(() => new Promise<void>((done) => setTimeout(() => {
      clearTimeout(timer)
      resolve(item)
      done()
    }, loadMs)))
  })
}

describe('resolveWithBoundedConcurrency (G4-16f diagnosis q1)', () => {
  const items = Array.from({ length: 12 }, (_, index) => index)

  it('control: every find started at once times out on the SUM of the loads', async () => {
    const find = serialLoads(20, 100)
    await expect(Promise.all(items.map(find))).rejects.toThrow(/timed out/)
  })

  it('the same finds, three in flight, each measure their own load', async () => {
    const find = serialLoads(20, 100)
    let active = 0
    let maximum = 0
    const values = await resolveWithBoundedConcurrency(items, async (item) => {
      active += 1
      maximum = Math.max(maximum, active)
      try { return await find(item) } finally { active -= 1 }
    }, { concurrency: 3, deadlineMs: 10_000, label: 'base shards' })
    expect(values).toEqual(items)
    expect(maximum).toBe(3)
  })

  it('keeps the input order whatever the completion order', async () => {
    const values = await resolveWithBoundedConcurrency(items, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, (12 - item) % 4))
      return `v${item}`
    }, { concurrency: 4, deadlineMs: 10_000, label: 'order' })
    expect(values).toEqual(items.map((item) => `v${item}`))
  })

  it('the whole-resolution ceiling rejects with a clear error and starts nothing after it', async () => {
    const started: number[] = []
    const error = await resolveWithBoundedConcurrency(items, async (item) => {
      started.push(item)
      await new Promise((resolve) => setTimeout(resolve, 30))
      return item
    }, { concurrency: 2, deadlineMs: 70, label: 'compaction objects base shards' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BoundedResolveDeadlineError)
    expect((error as Error).message).toMatch(/^compaction objects base shards: \d+ of 12 resolved when the 70 ms ceiling/)
    // Nothing STARTS once the ceiling has passed — the count at
    // the rejection does not grow while the items in flight finish.
    const atRejection = started.length
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(started.length).toBe(atRejection)
    expect(atRejection).toBeLessThan(12)
  })

  it('the ceiling timer is cleared once the resolution settles, either way', async () => {
    vi.useFakeTimers()
    try {
      const before = vi.getTimerCount()
      await resolveWithBoundedConcurrency(items, async (item) => item, { concurrency: 3, deadlineMs: 60_000, label: 'ok' })
      expect(vi.getTimerCount()).toBe(before)
      await expect(resolveWithBoundedConcurrency(items, async () => { throw new Error('x') }, { concurrency: 3, deadlineMs: 60_000, label: 'ko' }))
        .rejects.toThrow('x')
      expect(vi.getTimerCount()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the first failure rejects and nothing new starts', async () => {
    const started: number[] = []
    await expect(resolveWithBoundedConcurrency(items, async (item) => {
      started.push(item)
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (item === 1) throw new Error('shard 1 unreadable')
      return item
    }, { concurrency: 2, deadlineMs: 10_000, label: 'x' })).rejects.toThrow('shard 1 unreadable')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started).toEqual([0, 1, 2])
  })

  it('an empty list resolves at once', async () => {
    expect(await resolveWithBoundedConcurrency([], async () => 1, { concurrency: 3, deadlineMs: 1, label: 'none' })).toEqual([])
  })
})
