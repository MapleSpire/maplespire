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

/**
 * Pure routing for the sharded model. No Automerge/store imports — just
 * id → shard-index bookkeeping — so the riskiest part of sharding (stable routing +
 * per-shard dirty detection) is unit-testable in isolation.
 *
 * Mirrors the diagram registry's `findOrCreateShardForNew` (bridge.ts): an entity
 * already in a shard STAYS there (stable routing — rebuilt from shard CONTENTS each
 * projection, never id-hash bucketed); a new entity fills the first shard with room
 * (in order), creating a new shard only when all are full. Deletions free room that
 * later inserts reuse, exactly like the registry.
 */

/** The outcome of routing a set of entity ids over the current shards. */
export interface ShardPlan {
  /** id → shard index for every input id (placed ids keep their shard). */
  route: Map<string, number>
  /** Total shard count after planning (≥ the input `shardCount`; grows on overflow). */
  shardCount: number
}

/**
 * Assign `ids` to shards with stable, sequential fill.
 *
 *  - An id present in `prevRoute` (and whose shard index is still in range) keeps
 *    that shard — so an edit never migrates an entity between shards.
 *  - A new id fills the first shard with `< shardSize` members (scanning in order),
 *    or a freshly appended shard when every existing shard is full.
 *
 * `shardCount` is the number of shard DOCS that currently exist (empty shards are
 * kept and reused, like the registry). Returns a fresh route map + the possibly-
 * grown shard count; never mutates its inputs. O(ids) — cheap (no Automerge proxy).
 */
export function planShardAssignment(
  ids: readonly string[],
  prevRoute: ReadonlyMap<string, number>,
  shardCount: number,
  shardSize: number
): ShardPlan {
  if (!Number.isInteger(shardSize) || shardSize < 1) {
    throw new Error(`shardSize must be a positive integer, got ${shardSize}`)
  }
  if (!Number.isInteger(shardCount) || shardCount < 0) {
    throw new Error(`shardCount must be a non-negative integer, got ${shardCount}`)
  }

  const route = new Map<string, number>()
  // Per-shard occupancy. Starts at the existing shard count; grows on overflow.
  const fill: number[] = new Array(shardCount).fill(0)

  // Pass 1 — keep every already-placed id in its shard (stable routing).
  for (const id of ids) {
    const idx = prevRoute.get(id)
    if (idx !== undefined && idx >= 0 && idx < shardCount) {
      route.set(id, idx)
      fill[idx]++
    }
  }

  // Pass 2 — place new ids into the first shard with room, else a new shard.
  for (const id of ids) {
    if (route.has(id)) continue
    let target = -1
    for (let i = 0; i < fill.length; i++) {
      if (fill[i] < shardSize) {
        target = i
        break
      }
    }
    if (target === -1) {
      target = fill.length
      fill.push(0)
    }
    route.set(id, target)
    fill[target]++
  }

  return { route, shardCount: fill.length }
}

/**
 * Partition entities into per-shard buckets using a route map. Returns an array of
 * length `shardCount` (a bucket per shard, empty buckets included so shard i always
 * maps to result[i]). Entities whose id has no route, or routes out of range, are
 * dropped — the caller assigns routes first via {@link planShardAssignment}.
 */
export function partitionByShard<T extends { id: string }>(
  entities: readonly T[],
  route: ReadonlyMap<string, number>,
  shardCount: number
): T[][] {
  const buckets: T[][] = Array.from({ length: shardCount }, () => [])
  for (const e of entities) {
    const i = route.get(e.id)
    if (i !== undefined && i >= 0 && i < shardCount) buckets[i].push(e)
  }
  return buckets
}

/** Build a route map (id → shard index) from already-loaded shard contents — the
 * authoritative source rebuilt each projection. `shardIds[i]` = ids in shard i. */
export function routeFromShardContents(shardIds: readonly (readonly string[])[]): Map<string, number> {
  const route = new Map<string, number>()
  for (let i = 0; i < shardIds.length; i++) {
    for (const id of shardIds[i]) route.set(id, i)
  }
  return route
}
