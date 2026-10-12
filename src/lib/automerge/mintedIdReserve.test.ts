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

import { describe, it, expect } from 'vitest'
import { createMemoryKvStore, type KvStore } from '../modelQuery/kvStore'
import {
  createMintedIdReserve, drainReserve, RESERVE_BLOCK_SIZE,
} from './mintedIdReserve'

/** Base64 of `[marker, 0, 0, ...]`, 24 bytes — the shape the mint endpoint returns. */
function fakeMintedId(marker: number): string {
  const bytes = new Uint8Array(24)
  bytes[0] = 1
  bytes[1] = marker
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
const markerOf = (id: Uint8Array): number => id[1]!

/**
 * A store whose writes actually land LATE, like IndexedDB's.
 *
 * `createMemoryKvStore` mutates its Map before its promise resolves, so an
 * unawaited `set` is indistinguishable from an awaited one and a crash test
 * built on it cannot fail. The whole safety property of this
 * module lives in that ordering, so the fixture has to be able to express it.
 *
 * `crash()` drops everything not yet flushed, which is what a tab closing does
 * to a write that was never awaited.
 */
function createDeferredKvStore(): KvStore & { crash: () => void } {
  const committed = new Map<string, unknown>()
  let pending: [string, unknown][] = []
  // A MACROtask, not a microtask. With `await Promise.resolve()` the commit
  // lands on the next microtask, and the test's own `await hydrate()` always
  // grants one — so an unawaited write would commit anyway and the crash
  // test could not fail.
  const flush = (): Promise<void> => new Promise((resolve) => {
    setTimeout(() => {
      for (const [k, v] of pending) committed.set(k, v)
      pending = []
      resolve()
    }, 0)
  })
  return {
    get: async <T>(k: string) => committed.get(k) as T | undefined,
    getMany: async <T>(ks: string[]) => ks.map((k) => committed.get(k) as T | undefined),
    set: async (k, v) => { pending.push([k, v]); await flush() },
    setMany: async (e) => { pending.push(...e); await flush() },
    del: async (k) => { committed.delete(k) },
    delMany: async (ks) => { for (const k of ks) committed.delete(k) },
    update: async <T>(k: string, updater: (old: T | undefined) => T) => {
      pending.push([k, updater(committed.get(k) as T | undefined)])
      await flush()
    },
    scanPrefix: async <T>(prefix: string) => [...committed.entries()]
      .filter(([k]) => k.startsWith(prefix)) as [string, T][],
    clear: async () => { committed.clear(); pending = [] },
    crash: () => { pending = [] },
  }
}

describe('minted id reserve', () => {
  it('takes ids synchronously and reports null when empty', async () => {
    const store = createMemoryKvStore()
    const reserve = createMintedIdReserve(store, 'L/V')
    expect(reserve.take()).toBeNull()

    await reserve.deposit([fakeMintedId(1), fakeMintedId(2)])
    expect(reserve.take(), 'a deposit alone must not make ids takeable — hydrate does').toBeNull()

    await reserve.hydrate()
    // No await anywhere in here: this is the contract that keeps every caller
    // in bridge.ts synchronous, including the pagehide flush.
    expect(markerOf(reserve.take()!)).toBe(1)
    expect(markerOf(reserve.take()!)).toBe(2)
    expect(reserve.take()).toBeNull()
  })

  // THE CORRUPTION PROPERTY. If the removal landed after the ids became
  // takeable, a crash between the two would let a reload hand out ids that were
  // already used — and `repo.import` under an id IndexedDB already holds merges
  // two unrelated diagrams into one document. So a crash must LOSE the block,
  // never repeat it.
  it('loses a hydrated block on a crash rather than handing it out twice', async () => {
    const store = createDeferredKvStore()
    const first = createMintedIdReserve(store, 'L/V')
    await first.deposit(Array.from({ length: 5 }, (_v, i) => fakeMintedId(i + 1)))
    await first.hydrate()
    expect(markerOf(first.take()!)).toBe(1)

    // The tab dies. Anything not yet committed is gone — which is precisely
    // the difference between removing before and after handing ids out.
    store.crash()
    const afterReload = createMintedIdReserve(store, 'L/V')
    await afterReload.hydrate()
    const seen: number[] = []
    for (let id = afterReload.take(); id; id = afterReload.take()) seen.push(markerOf(id))
    expect(seen, 'ids 1-5 were reserved before the crash and must not reappear').toEqual([])
  })

  it('reserves at most one block at a time and keeps the rest for later', async () => {
    const store = createMemoryKvStore()
    const reserve = createMintedIdReserve(store, 'L/V')
    const total = RESERVE_BLOCK_SIZE + 5
    await reserve.deposit(Array.from({ length: total }, (_v, i) => fakeMintedId(i + 1)))

    expect(await reserve.hydrate()).toBe(RESERVE_BLOCK_SIZE)
    expect(reserve.available()).toBe(RESERVE_BLOCK_SIZE)
    expect(await reserve.remaining()).toBe(5)

    drainReserve(reserve)
    expect(await reserve.hydrate()).toBe(5)
    expect(await reserve.remaining()).toBe(0)
  })

  // An id minted for A and used in B verifies as `foreign` on the gate — a hard
  // deny with no index fallback and no repair. So a pool left behind by another
  // workspace must be unspendable, not merely discouraged.
  it('refuses to spend a pool persisted by another workspace', async () => {
    const store = createMemoryKvStore()
    const a = createMintedIdReserve(store, 'landscape-A/v1')
    await a.deposit([fakeMintedId(7), fakeMintedId(8)])

    const b = createMintedIdReserve(store, 'landscape-B/v1')
    expect(await b.hydrate()).toBe(0)
    expect(b.take()).toBeNull()
    expect(await b.remaining()).toBe(0)
  })

  it('the persisted pool never retains a drawn block — the removal IS the compaction', async () => {
    const store = createMemoryKvStore()
    const reserve = createMintedIdReserve(store, 'L/V')
    await reserve.deposit(Array.from({ length: RESERVE_BLOCK_SIZE }, (_v, i) => fakeMintedId(i + 1)))
    await reserve.hydrate()
    drainReserve(reserve)

    await reserve.deposit([fakeMintedId(99)])
    const pool = await store.get<{ ids: string[] }>('mintedIds/reserve@2')
    expect(pool!.ids.length, 'the drawn block must be gone from storage, not accumulated').toBe(1)

    await reserve.hydrate()
    expect(markerOf(reserve.take()!)).toBe(99)
  })

  // THE TWO INTERLEAVINGS OF 79fb0dc5's still-open list, now structural
  // impossibilities: the draw removes its block inside ONE atomic update, so
  // there is no cursor for a rival to read stale.
  it('two tabs hydrating one pool draw DISJOINT blocks', async () => {
    const store = createMemoryKvStore()
    const tabA = createMintedIdReserve(store, 'L/V')
    const tabB = createMintedIdReserve(store, 'L/V')
    await tabA.deposit(Array.from({ length: RESERVE_BLOCK_SIZE * 2 }, (_v, i) => fakeMintedId(i + 1)))

    const [a, b] = await Promise.all([tabA.hydrate(), tabB.hydrate()])
    expect(a).toBe(RESERVE_BLOCK_SIZE)
    expect(b).toBe(RESERVE_BLOCK_SIZE)

    const seenA = new Set<number>()
    const seenB = new Set<number>()
    for (let id = tabA.take(); id; id = tabA.take()) seenA.add(markerOf(id))
    for (let id = tabB.take(); id; id = tabB.take()) seenB.add(markerOf(id))
    // Every id drawn exactly once, across both tabs — the old two-key layout
    // handed BOTH tabs the same block (both read cursor 0).
    expect(seenA.size + seenB.size).toBe(RESERVE_BLOCK_SIZE * 2)
    for (const m of seenA) expect(seenB.has(m), `id ${m} drawn by both tabs`).toBe(false)
  })

  it('a deposit racing a hydrate in one tab loses nothing and doubles nothing', async () => {
    const store = createMemoryKvStore()
    const reserve = createMintedIdReserve(store, 'L/V')
    await reserve.deposit([fakeMintedId(1), fakeMintedId(2)])

    await Promise.all([
      reserve.hydrate(),
      reserve.deposit([fakeMintedId(3), fakeMintedId(4)]),
    ])

    // The chain ran them in call order: the hydrate drew 1-2, the racing
    // deposit appended 3-4 — nothing interleaved, nothing lost.
    const inMemory: number[] = []
    for (let id = reserve.take(); id; id = reserve.take()) inMemory.push(markerOf(id))
    expect(inMemory).toEqual([1, 2])
    expect(await reserve.remaining()).toBe(2)
    await reserve.hydrate()
    const next: number[] = []
    for (let id = reserve.take(); id; id = reserve.take()) next.push(markerOf(id))
    expect(next).toEqual([3, 4])
  })

  it('decodes exactly the bytes the mint endpoint put on the wire', async () => {
    const store = createMemoryKvStore()
    const reserve = createMintedIdReserve(store, 'L/V')
    const bytes = new Uint8Array(24).map((_v, i) => (i * 7 + 3) & 0xff)
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    await reserve.deposit([btoa(s)])
    await reserve.hydrate()
    expect(Array.from(reserve.take()!)).toEqual(Array.from(bytes))
  })
})
