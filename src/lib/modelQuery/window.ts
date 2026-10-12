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

import type { C4Object } from '../../types'

/**
 * The resident WINDOW: the slice of the model the Zustand store
 * keeps resident when windowing is enabled, so heap is O(window) not O(model).
 *
 * Window = the active diagram's composition (objects/connections/groups) + the C4
 * ANCESTOR chain of those objects (parent → grandparent …, so breadcrumbs / the
 * lower-connection roll-up have their context) + INCIDENT edges of every window
 * object (so the roll-up can see edges that cross levels). Everything cross-diagram
 * routes through `getModelQuery()` (the IndexedDB index) instead of the store.
 *
 * `computeWindow` is pure over a small async {@link WindowReader} so it is unit-
 * testable with an in-memory reader; the bridge backs the reader with the index.
 */

/** The id sets that make up a window. */
export interface WindowIds {
  objectIds: Set<string>
  connectionIds: Set<string>
  groupIds: Set<string>
}

/** Minimal async reads `computeWindow` needs — backed by the IndexedDB index. */
export interface WindowReader {
  /** The diagram's denormalised composition (from the registry/DiagramMeta), or
   * undefined if the diagram isn't known. */
  diagramComposition(
    diagramId: string
  ): Promise<{ objectIds: string[]; connectionIds: string[]; groupIds: string[] } | undefined>
  /** An object record by id (for walking the `parentId` ancestor chain). */
  object(id: string): Promise<C4Object | undefined>
  /** Connection ids incident to an object (out + in), deduped. */
  incidentConnectionIds(objectId: string): Promise<string[]>
}

export interface ComputeWindowOptions {
  /** Include the C4 ancestor chain of the diagram's objects. Default true. */
  includeAncestors?: boolean
  /** Include connections incident to window objects (for the roll-up). Default true. */
  includeIncident?: boolean
}

/**
 * Compute the resident window for a diagram. O(window) reads — composition +
 * one ancestor walk per seed object + one incident read per window object — never
 * O(model). Cycle-guarded on the parent chain. Resolves to empty sets for an
 * unknown diagram.
 */
export async function computeWindow(
  reader: WindowReader,
  diagramId: string,
  opts: ComputeWindowOptions = {}
): Promise<WindowIds> {
  const { includeAncestors = true, includeIncident = true } = opts
  const objectIds = new Set<string>()
  const connectionIds = new Set<string>()
  const groupIds = new Set<string>()

  const comp = await reader.diagramComposition(diagramId)
  if (!comp) return { objectIds, connectionIds, groupIds }

  for (const id of comp.objectIds) objectIds.add(id)
  for (const id of comp.connectionIds) connectionIds.add(id)
  for (const id of comp.groupIds) groupIds.add(id)

  // Ancestors: walk parentId up from each diagram object (cycle-guarded).
  if (includeAncestors) {
    for (const seed of comp.objectIds) {
      let cur: string | undefined = seed
      const guard = new Set<string>()
      while (cur && !guard.has(cur)) {
        guard.add(cur)
        const obj = await reader.object(cur)
        const parent = obj?.parentId
        if (!parent) break
        objectIds.add(parent)
        cur = parent
      }
    }
  }

  // Incident edges of every window object (composition objects + ancestors), so the
  // resident roll-up can see cross-level edges. Peer objects are NOT pulled in —
  // global lookups route through the index; the canvas renders only the diagram's
  // own composition.
  if (includeIncident) {
    for (const oid of objectIds) {
      for (const cid of await reader.incidentConnectionIds(oid)) connectionIds.add(cid)
    }
  }

  return { objectIds, connectionIds, groupIds }
}
