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

import type { TagAssignment, TagSnapshot } from '../../types'

export interface TagAssignable {
  /** May be absent while a CRDT shard is only partially hydrated. */
  tagAssignments?: Record<string, TagAssignment>
  tagOrder?: string[]
}

/** Deterministic ordered canonical ids, including CRDT-map entries missing from the order. */
export function orderedTagIds(entity: Pick<TagAssignable, 'tagAssignments' | 'tagOrder'>): string[] {
  const assigned = Object.keys(entity.tagAssignments ?? {})
  const assignedSet = new Set(assigned)
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const tagId of entity.tagOrder ?? []) {
    if (assignedSet.has(tagId) && !seen.has(tagId)) {
      ordered.push(tagId)
      seen.add(tagId)
    }
  }
  for (const tagId of assigned.sort()) {
    if (!seen.has(tagId)) ordered.push(tagId)
  }
  return ordered
}

export function assignTag(entity: TagAssignable, tagId: string): void {
  entity.tagAssignments ??= {}
  entity.tagOrder ??= []
  if (!entity.tagAssignments[tagId]) entity.tagAssignments[tagId] = { tagId }
  if (!entity.tagOrder.includes(tagId)) entity.tagOrder.push(tagId)
}

export function unassignTag(entity: TagAssignable, tagId: string): void {
  entity.tagAssignments ??= {}
  entity.tagOrder ??= []
  delete entity.tagAssignments[tagId]
  entity.tagOrder = entity.tagOrder.filter((id) => id !== tagId)
}

export function tagSnapshotMap(snapshots: readonly TagSnapshot[]): Map<string, TagSnapshot> {
  return new Map(snapshots.map((snapshot) => [snapshot.tagId, snapshot]))
}

export function referencedTagSnapshots(
  entities: readonly Pick<TagAssignable, 'tagAssignments' | 'tagOrder'>[],
  snapshots: readonly TagSnapshot[],
): TagSnapshot[] {
  const referenced = new Set<string>()
  for (const entity of entities) {
    for (const tagId of Object.keys(entity.tagAssignments ?? {})) referenced.add(tagId)
  }
  return snapshots.filter((snapshot) => referenced.has(snapshot.tagId))
}
