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

import type { C4Object, Connection, Group, Diagram } from '../../types'
import type { KvStore } from './kvStore'
import { buildModelIndexChunked, diffModelChanges, applyModelChanges, type ModelIndexInput } from './modelIndex'

/**
 * Maintain the IndexedDB model index FROM THE SHARDS, so the
 * index stays the complete read model even when the resident store is windowed.
 *
 * The store-fed `syncModelIndex` (indexSync.ts) diffs the WHOLE store arrays — once
 * the store holds only the active-diagram window, feeding it would delete every
 * off-window object/connection from the index. So under windowing:
 *
 *  - objects/connections are maintained PER SHARD: on a shard's change, diff that
 *    shard's old vs new slice and apply (an object never moves shards → stable).
 *  - groups + diagrams stay fully resident in the store, so they are maintained
 *    from the store via {@link applyRegistryDelta} (objects/connections empty).
 *
 * All three reuse the proven `diffModelChanges`/`applyModelChanges` primitives by
 * passing only the relevant collections (the rest empty on both sides), so a delta
 * for one collection never disturbs another. domains/tags/decisionRecords are not
 * indexed (small, always resident).
 */

/** Cold-build the whole index from a model assembled out of the shards (one-time,
 * when the index is empty): merged shard objects/connections + resident groups +
 * diagram registry. Time-sliced so a main-thread build never freezes the UI.
 * Thereafter maintenance is incremental. */
export function coldBuildIndexFromShards(
  store: KvStore,
  model: ModelIndexInput,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  return buildModelIndexChunked(store, model, onProgress)
}

/** Apply one OBJECT shard's old→new delta (objects + the ch: parent index only). */
export function applyObjectShardDelta(
  store: KvStore,
  oldObjects: C4Object[],
  newObjects: C4Object[]
): Promise<void> {
  const changes = diffModelChanges(
    { objects: oldObjects, connections: [], groups: [] },
    { objects: newObjects, connections: [], groups: [] }
  )
  return applyModelChanges(store, changes)
}

/** Apply one CONNECTION shard's old→new delta (connection records + out:/in: only). */
export function applyConnectionShardDelta(
  store: KvStore,
  oldConnections: Connection[],
  newConnections: Connection[]
): Promise<void> {
  const changes = diffModelChanges(
    { objects: [], connections: oldConnections, groups: [] },
    { objects: [], connections: newConnections, groups: [] }
  )
  return applyModelChanges(store, changes)
}

/** Apply the resident registry (groups + diagrams) delta — objects/connections are
 * NOT diffed here (they come from the shards), so the partial windowed store never
 * deletes off-window entities from the index. */
export function applyRegistryDelta(
  store: KvStore,
  prev: { groups: Group[]; diagrams: Diagram[] },
  next: { groups: Group[]; diagrams: Diagram[] }
): Promise<void> {
  const changes = diffModelChanges(
    { objects: [], connections: [], groups: prev.groups, diagrams: prev.diagrams },
    { objects: [], connections: [], groups: next.groups, diagrams: next.diagrams }
  )
  return applyModelChanges(store, changes)
}
