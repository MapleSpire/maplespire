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

import type { C4Object, Connection, Diagram, Group, Position } from '../../types'

/**
 * Expanding a shape IN PLACE: its linked diagram's shapes are drawn inside it,
 * under the parent-wrapper style, without leaving the diagram you are on.
 *
 * ## Why this is a view transform and not a model write
 *
 * Until now "expand" only ever navigated — `ExpandMenu` swaps
 * `currentDiagramId` and the whole canvas changes. The thing that LOOKS like an
 * expanded shape, a `Group` with `parentObjectId`, is a persisted row created
 * once when a detail diagram is created; there is no expanded/collapsed state
 * anywhere in the app.
 *
 * Writing the other diagram's shapes into this one would be the other obvious
 * design and it is the wrong one: it copies composition between diagrams, which
 * is precisely what diagram duplication avoids (see `duplicate.ts`), and it
 * would sync that copy to every peer. So this runs on the way to the ENGINE, after
 * `filterAndMergeDiagramData` and before `setData`, and nothing it produces is
 * persisted. Collapsing is dropping the entry.
 *
 * ## The four rules that make the result renderable
 *
 * 1. **The expanded shape is REPLACED by its wrapper.** A wrapper is the
 *    expanded form of an object, so drawing both would show the same thing
 *    twice. Connections in this diagram that pointed at the object are rewritten
 *    to point at the wrapper, which the engine resolves as an endpoint just as
 *    happily (`getConnectionEndpoint` reads the group map too). Without the
 *    rewrite every line into the shape would vanish.
 * 2. **External-scope shapes are left behind.** An expanded boundary is about
 *    what is INSIDE it; the outside world is already on the diagram you are
 *    looking at.
 * 3. **Shapes already on this diagram are left behind.** Two entries with one id
 *    would collide in the engine's `objectMap`/`objectIndex`, and the second
 *    would silently win.
 * 4. **The pulled shapes are translated** so their bounding box lands where the
 *    expanded shape was. They carry the OTHER diagram's coordinates, which have
 *    no relationship to this one's — untranslated, an expansion lands on top of
 *    whatever happens to occupy those coordinates here.
 */

export interface InlineExpansion {
  /** The shape being expanded, on the diagram currently being drawn. */
  objectId: string
  /** The diagram whose shapes are pulled in. */
  diagramId: string
}

export interface DiagramContents {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
}

export type SkippedReason =
  /** The target is the diagram we are drawing, or one already expanded here. */
  | 'cycle'
  /** No such diagram, or the shape is not on this diagram. */
  | 'missing'
  /** Nothing left to show once external and already-present shapes are dropped. */
  | 'empty'

export interface InlineExpansionResult extends DiagramContents {
  /** Every expansion that produced nothing, and why. Never silent. */
  skipped: Array<{ objectId: string; reason: SkippedReason }>
}

export interface ExpansionLookup {
  diagram: (id: string) => Diagram | undefined
  object: (id: string) => C4Object | undefined
  connection: (id: string) => Connection | undefined
}

/** Stable and derived, so the same expansion yields the same group id twice. */
export function inlineWrapperId(objectId: string): string {
  return `inline-expand:${objectId}`
}

function boundingTopLeft(objects: readonly C4Object[]): Position {
  let x = Infinity
  let y = Infinity
  for (const object of objects) {
    x = Math.min(x, object.position.x)
    y = Math.min(y, object.position.y)
  }
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 }
}

/**
 * Apply `expansions` to a diagram's already-filtered contents.
 *
 * ONE LEVEL ONLY, and that is the cycle protection rather than a limitation
 * papered over: only shapes present in `base` are expanded, so a shape pulled in
 * from B carrying its own expansion back to A is never consulted and A→B→A
 * cannot recurse. `visited` still tracks the chain explicitly, so a future
 * recursive version inherits the guard instead of rediscovering the need for it.
 */
export function expandDiagramsInline(
  base: DiagramContents,
  currentDiagramId: string | null,
  expansions: readonly InlineExpansion[],
  lookup: ExpansionLookup,
): InlineExpansionResult {
  if (expansions.length === 0) {
    return { ...base, skipped: [] }
  }

  const objects = [...base.objects]
  const connections = [...base.connections]
  const groups = [...base.groups]
  const skipped: InlineExpansionResult['skipped'] = []
  const visited = new Set<string>(currentDiagramId ? [currentDiagramId] : [])
  const presentObjectIds = new Set(base.objects.map((object) => object.id))
  /** objectId -> the wrapper that replaced it, for the connection rewrite. */
  const replacedBy = new Map<string, string>()

  for (const expansion of expansions) {
    const host = base.objects.find((object) => object.id === expansion.objectId)
    const target = lookup.diagram(expansion.diagramId)
    if (!host || !target) {
      skipped.push({ objectId: expansion.objectId, reason: 'missing' })
      continue
    }
    if (visited.has(expansion.diagramId)) {
      skipped.push({ objectId: expansion.objectId, reason: 'cycle' })
      continue
    }

    const pulled = target.objectIds
      .map((id) => lookup.object(id))
      .filter((object): object is C4Object => !!object)
      .filter((object) => object.scope !== 'external')
      .filter((object) => !presentObjectIds.has(object.id))
    if (pulled.length === 0) {
      skipped.push({ objectId: expansion.objectId, reason: 'empty' })
      continue
    }
    visited.add(expansion.diagramId)

    // Land the pulled block where the shape was, in the other diagram's own
    // relative arrangement. `layouts` is the per-diagram override, and it is the
    // position the user actually arranged over there.
    const placed = pulled.map((object) => {
      const layout = target.layouts?.[object.id]
      return layout ? { ...object, position: layout.position, size: layout.size } : object
    })
    const origin = boundingTopLeft(placed)
    const dx = host.position.x - origin.x
    const dy = host.position.y - origin.y
    for (const object of placed) {
      objects.push({
        ...object,
        position: { x: object.position.x + dx, y: object.position.y + dy },
      })
      presentObjectIds.add(object.id)
    }

    // The relationships BETWEEN the pulled shapes come too — an expanded
    // boundary showing its contents unconnected would be a worse picture than
    // the one it replaced. Only edges whose both ends survived the filters.
    const pulledIds = new Set(placed.map((object) => object.id))
    for (const connectionId of target.connectionIds) {
      const connection = lookup.connection(connectionId)
      if (!connection) continue
      if (!pulledIds.has(connection.fromId) || !pulledIds.has(connection.toId)) continue
      if (connections.some((existing) => existing.id === connection.id)) continue
      connections.push(connection)
    }

    const wrapperId = inlineWrapperId(host.id)
    groups.push({
      id: wrapperId,
      // What makes the renderer draw this in the expanded-shape style. See
      // `renderGroup`'s `isParentWrapper`.
      parentObjectId: host.id,
      name: host.name,
      description: host.shortDescription,
      type: host.type.charAt(0).toUpperCase() + host.type.slice(1),
      icon: host.icon,
      iconAssignment: host.iconAssignment,
      color: '#EFEDE9',
      objectIds: placed.map((object) => object.id),
      tagAssignments: {},
      tagOrder: [],
    } as Group)

    replacedBy.set(host.id, wrapperId)
  }

  if (replacedBy.size === 0) {
    return { objects, connections, groups, skipped }
  }
  return {
    // The host shapes are gone: their wrapper IS them, expanded.
    objects: objects.filter((object) => !replacedBy.has(object.id)),
    connections: connections.map((connection) => {
      const from = replacedBy.get(connection.fromId)
      const to = replacedBy.get(connection.toId)
      if (!from && !to) return connection
      return { ...connection, fromId: from ?? connection.fromId, toId: to ?? connection.toId }
    }),
    groups,
    skipped,
  }
}
