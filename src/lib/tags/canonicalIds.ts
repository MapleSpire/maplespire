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

export interface CanonicalTagDescriptor {
  id: string
  canonicalTagId?: string | null
  redirectedFromIds?: readonly string[]
}

const canonicalById = new Map<string, string>()
const idsByCanonical = new Map<string, Set<string>>()

/** Register only bounded catalog/resolve results already loaded for the active org. */
export function registerTagCanonicalIds(tags: readonly CanonicalTagDescriptor[]): void {
  for (const tag of tags) {
    const canonicalId = tag.canonicalTagId || tag.id
    canonicalById.set(tag.id, canonicalId)
    canonicalById.set(canonicalId, canonicalId)
    const equivalents = idsByCanonical.get(canonicalId) ?? new Set<string>()
    equivalents.add(canonicalId)
    equivalents.add(tag.id)
    for (const sourceId of tag.redirectedFromIds ?? []) {
      canonicalById.set(sourceId, canonicalId)
      equivalents.add(sourceId)
    }
    idsByCanonical.set(canonicalId, equivalents)
  }
}

export function canonicalTagId(tagId: string): string {
  let current = tagId
  const visited = new Set<string>()
  while (canonicalById.has(current) && !visited.has(current)) {
    visited.add(current)
    const next = canonicalById.get(current)!
    if (next === current) return current
    current = next
  }
  return current
}

export function equivalentTagIds(tagIds: readonly string[]): string[] {
  const result = new Set<string>()
  for (const tagId of tagIds.filter(Boolean)) {
    const canonicalId = canonicalTagId(tagId)
    result.add(canonicalId)
    for (const equivalent of idsByCanonical.get(canonicalId) ?? []) result.add(equivalent)
  }
  return [...result]
}

export function __resetTagCanonicalIdsForTest(): void {
  canonicalById.clear()
  idsByCanonical.clear()
}
