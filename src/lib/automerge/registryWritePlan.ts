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

export interface RegistryShardSnapshot {
  diagramIds: readonly string[]
}

export interface RegistryWritePlan {
  reconcile: Array<{
    shardIndex: number
    removeIds: string[]
    updateIds: string[]
  }>
  placeIds: string[]
}

/**
 * Plan client-side registry mutations from the diagrams currently resident in
 * the store.
 *
 * A summary-only workspace deliberately keeps only a small, active window in
 * Zustand. Treating that window as the complete registry would delete every
 * off-window diagram or publish client-only registry shards. The server owns
 * registry membership for that mode, so the only safe client plan is empty.
 */
export function planRegistryWrites(input: {
  registrySummaryOnly: boolean
  storeDiagramIds: readonly string[]
  shards: readonly RegistryShardSnapshot[]
}): RegistryWritePlan {
  if (input.registrySummaryOnly) return { reconcile: [], placeIds: [] }

  const storeIds = new Set(input.storeDiagramIds)
  const placedIds = new Set<string>()
  const reconcile = input.shards.map((shard, shardIndex) => {
    const removeIds: string[] = []
    const updateIds: string[] = []
    for (const id of shard.diagramIds) {
      placedIds.add(id)
      if (storeIds.has(id)) updateIds.push(id)
      else removeIds.push(id)
    }
    return { shardIndex, removeIds, updateIds }
  })

  return {
    reconcile,
    placeIds: input.storeDiagramIds.filter((id) => !placedIds.has(id)),
  }
}
