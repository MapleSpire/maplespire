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
 * Mirror a DiagramDoc's `objectScopes` onto its registry stub. The stub copy is
 * what the read model counts "external in N of M diagrams" from
 * (`ro_diagrams.data`), so it must follow clears as well as sets. Called by
 * every server writer of a DiagramDoc's overrides: `updateDiagramDoc` (AI
 * tools) and the draft merge (`draft/applyMerge.ts`).
 *
 * Writes per KEY into an existing map and never deletes the map itself once it
 * exists: in Automerge, deleting a parent key concurrently with a put inside it
 * loses the put, and two concurrent `= {}` creations conflict with one map
 * winning — so a whole-map delete or re-create would drop a peer's concurrent
 * override. An empty map is only left absent when there never was one.
 * Works on an Automerge change draft and on a plain object alike.
 */
export function syncStubObjectScopes(stub: Record<string, unknown>, source: unknown): void {
  const wanted = new Map<string, 'internal' | 'external'>()
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (value === 'internal' || value === 'external') wanted.set(key, value)
    }
  }
  const existing = stub.objectScopes
  const hasMap = !!existing && typeof existing === 'object' && !Array.isArray(existing)
  if (wanted.size === 0 && !hasMap) return
  // Assign THEN re-read: the value of `x.y = {}` is the plain object, not the
  // Automerge proxy, and writes into it are silently dropped.
  if (!hasMap) stub.objectScopes = {}
  const target = stub.objectScopes as Record<string, unknown>
  for (const key of Object.keys(target)) if (!wanted.has(key)) delete target[key]
  for (const [key, value] of wanted) if (target[key] !== value) target[key] = value
}
