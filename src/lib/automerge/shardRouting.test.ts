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
import { planShardAssignment, partitionByShard, routeFromShardContents } from './shardRouting'

// Risk rules under test:
//  (1) STABLE routing — a placed id never migrates shards across re-plans.
//  (2) sequential fill — new ids fill the first shard with room, then a new shard.
//  (3) deletions free room that later inserts reuse (like the registry).

const ids = (n: number, prefix = 'o') => Array.from({ length: n }, (_, i) => prefix + i)

describe('planShardAssignment', () => {
  it('places new ids into one shard until full, then overflows into a new shard', () => {
    const plan = planShardAssignment(ids(5), new Map(), 1, 2)
    // shardSize 2 → shards [o0,o1] [o2,o3] [o4]; count grows 1 → 3.
    expect(plan.shardCount).toBe(3)
    expect(plan.route.get('o0')).toBe(0)
    expect(plan.route.get('o1')).toBe(0)
    expect(plan.route.get('o2')).toBe(1)
    expect(plan.route.get('o3')).toBe(1)
    expect(plan.route.get('o4')).toBe(2)
  })

  it('keeps every already-placed id in its shard (stable routing across a re-plan)', () => {
    const prev = new Map<string, number>([
      ['o0', 0],
      ['o1', 0],
      ['o2', 1],
    ])
    // Re-plan the same ids + a new one; existing ids must not move.
    const plan = planShardAssignment(['o0', 'o1', 'o2', 'oNew'], prev, 2, 2)
    expect(plan.route.get('o0')).toBe(0)
    expect(plan.route.get('o1')).toBe(0)
    expect(plan.route.get('o2')).toBe(1)
    // shard 0 is full (2/2), shard 1 has room (1/2) → new id lands in shard 1.
    expect(plan.route.get('oNew')).toBe(1)
    expect(plan.shardCount).toBe(2)
  })

  it('reuses room freed by a deletion before creating a new shard', () => {
    // Shard 0 had [o0,o1]; o1 deleted (not in the new id set) → room reopens.
    const prev = new Map<string, number>([
      ['o0', 0],
      ['o1', 0],
    ])
    const plan = planShardAssignment(['o0', 'oNew'], prev, 1, 2)
    expect(plan.route.get('o0')).toBe(0)
    expect(plan.route.get('oNew')).toBe(0) // reused freed slot, no new shard
    expect(plan.shardCount).toBe(1)
  })

  it('drops a stale route pointing past the current shard count and re-places the id', () => {
    // prevRoute claims shard 5 but only 1 shard exists → treat as unplaced.
    const prev = new Map<string, number>([['o0', 5]])
    const plan = planShardAssignment(['o0'], prev, 1, 2)
    expect(plan.route.get('o0')).toBe(0)
    expect(plan.shardCount).toBe(1)
  })

  it('is deterministic — same inputs yield the same assignment', () => {
    const a = planShardAssignment(ids(57), new Map(), 1, 10)
    const b = planShardAssignment(ids(57), new Map(), 1, 10)
    expect([...a.route.entries()]).toEqual([...b.route.entries()])
    expect(a.shardCount).toBe(b.shardCount)
    expect(a.shardCount).toBe(6) // ceil(57/10)
  })

  it('every id is routed exactly once with no shard exceeding shardSize', () => {
    const all = ids(250)
    const plan = planShardAssignment(all, new Map(), 1, 32)
    expect(plan.route.size).toBe(250)
    const counts = new Array(plan.shardCount).fill(0)
    for (const idx of plan.route.values()) counts[idx]++
    for (const c of counts) expect(c).toBeLessThanOrEqual(32)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(250)
  })

  it('rejects an invalid shardSize or shardCount', () => {
    expect(() => planShardAssignment(['a'], new Map(), 1, 0)).toThrow()
    expect(() => planShardAssignment(['a'], new Map(), 1, -2)).toThrow()
    expect(() => planShardAssignment(['a'], new Map(), -1, 2)).toThrow()
  })

  it('handles an empty id set (no shards needed beyond the existing ones)', () => {
    const plan = planShardAssignment([], new Map(), 1, 8)
    expect(plan.route.size).toBe(0)
    expect(plan.shardCount).toBe(1)
  })
})

describe('partitionByShard', () => {
  it('buckets entities by their route, one bucket per shard (empty buckets kept)', () => {
    const entities = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const route = new Map<string, number>([
      ['a', 0],
      ['b', 2],
      ['c', 0],
    ])
    const buckets = partitionByShard(entities, route, 3)
    expect(buckets.length).toBe(3)
    expect(buckets[0].map((e) => e.id)).toEqual(['a', 'c'])
    expect(buckets[1]).toEqual([]) // shard 1 has no members
    expect(buckets[2].map((e) => e.id)).toEqual(['b'])
  })

  it('drops entities with no route or an out-of-range route', () => {
    const entities = [{ id: 'a' }, { id: 'ghost' }, { id: 'far' }]
    const route = new Map<string, number>([
      ['a', 0],
      ['far', 9],
    ])
    const buckets = partitionByShard(entities, route, 1)
    expect(buckets[0].map((e) => e.id)).toEqual(['a'])
  })

  it('round-trips with planShardAssignment: plan → partition covers every entity once', () => {
    const entities = ids(100).map((id) => ({ id }))
    const plan = planShardAssignment(
      entities.map((e) => e.id),
      new Map(),
      1,
      16
    )
    const buckets = partitionByShard(entities, plan.route, plan.shardCount)
    const flat = buckets.flat().map((e) => e.id)
    expect(flat.length).toBe(100)
    expect(new Set(flat).size).toBe(100)
    for (const b of buckets) expect(b.length).toBeLessThanOrEqual(16)
  })
})

describe('routeFromShardContents', () => {
  it('builds id → shard index from per-shard id lists', () => {
    const route = routeFromShardContents([['a', 'b'], [], ['c']])
    expect(route.get('a')).toBe(0)
    expect(route.get('b')).toBe(0)
    expect(route.get('c')).toBe(2)
    expect(route.has('missing')).toBe(false)
  })

  it('feeds planShardAssignment so a reload keeps placement stable', () => {
    // Simulate: shards loaded from docs, then re-plan the same ids — no migration.
    const loaded = routeFromShardContents([['o0', 'o1'], ['o2']])
    const plan = planShardAssignment(['o0', 'o1', 'o2'], loaded, 2, 2)
    expect(plan.route.get('o0')).toBe(0)
    expect(plan.route.get('o1')).toBe(0)
    expect(plan.route.get('o2')).toBe(1)
    expect(plan.shardCount).toBe(2)
  })
})
