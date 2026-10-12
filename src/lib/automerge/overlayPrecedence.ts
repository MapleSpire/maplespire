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

/** Merge bounded overlay segments oldest-to-newest. Later segments are the
 * authority even if an older segment emits a change afterward. */
export function mergeOverlaySegments<T>(segments: readonly Record<string, T>[]): Map<string, T> {
  const effective = new Map<string, T>()
  for (const segment of segments) {
    for (const [id, value] of Object.entries(segment)) effective.set(id, value)
  }
  return effective
}

/** Update one immutable Automerge segment snapshot and return only effective
 * winners that changed. Unchanged values retain object identity across an
 * Automerge snapshot, so the common path is proportional to touched IDs. */
export function updateOverlaySegment<T>(
  orderedDocumentIds: readonly string[],
  segments: Map<string, Record<string, T>>,
  effective: Map<string, T>,
  documentId: string,
  nextSegment: Record<string, T>,
): { upserts: Map<string, T>; deleteIds: Set<string> } {
  const previous = segments.get(documentId) ?? {}
  segments.set(documentId, nextSegment)
  const touched = new Set([...Object.keys(previous), ...Object.keys(nextSegment)])
  const upserts = new Map<string, T>()
  const deleteIds = new Set<string>()
  for (const id of touched) {
    if (previous[id] === nextSegment[id] && effective.has(id)) continue
    let winner: T | undefined
    for (let index = orderedDocumentIds.length - 1; index >= 0; index -= 1) {
      winner = segments.get(orderedDocumentIds[index])?.[id]
      if (winner !== undefined) break
    }
    const prior = effective.get(id)
    if (winner === undefined) {
      if (prior !== undefined) deleteIds.add(id)
      effective.delete(id)
    } else if (prior !== winner) {
      effective.set(id, winner)
      upserts.set(id, winner)
    }
  }
  return { upserts, deleteIds }
}
