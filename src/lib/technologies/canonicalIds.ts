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

export interface CanonicalTechnologyDescriptor {
  id: string
  canonicalTechnologyId?: string | null
  redirectedFromIds?: readonly string[]
}

const canonicalById = new Map<string, string>()
const idsByCanonical = new Map<string, Set<string>>()

/** Register only the bounded catalog pages already loaded by the client. */
export function registerTechnologyCanonicalIds(
  technologies: readonly CanonicalTechnologyDescriptor[],
): void {
  for (const technology of technologies) {
    const canonicalId = technology.canonicalTechnologyId || technology.id
    canonicalById.set(technology.id, canonicalId)
    canonicalById.set(canonicalId, canonicalId)
    const equivalents = idsByCanonical.get(canonicalId) ?? new Set<string>()
    equivalents.add(canonicalId)
    equivalents.add(technology.id)
    for (const legacyId of technology.redirectedFromIds ?? []) {
      canonicalById.set(legacyId, canonicalId)
      equivalents.add(legacyId)
    }
    idsByCanonical.set(canonicalId, equivalents)
  }
}

export function canonicalTechnologyId(technologyId: string): string {
  let current = technologyId
  const visited = new Set<string>()
  while (canonicalById.has(current) && !visited.has(current)) {
    visited.add(current)
    const next = canonicalById.get(current)!
    if (next === current) return current
    current = next
  }
  return current
}

export function equivalentTechnologyIds(technologyIds: readonly string[]): string[] {
  const result = new Set<string>()
  for (const technologyId of technologyIds.filter(Boolean)) {
    const canonicalId = canonicalTechnologyId(technologyId)
    result.add(canonicalId)
    for (const equivalent of idsByCanonical.get(canonicalId) ?? []) result.add(equivalent)
  }
  return [...result]
}

export function __resetTechnologyCanonicalIdsForTest(): void {
  canonicalById.clear()
  idsByCanonical.clear()
}
