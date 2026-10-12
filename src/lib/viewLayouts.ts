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

import type { C4Object, Connection, Diagram, Group } from '../types'

/**
 * Resolving a diagram's VISUAL layer for the canvas: the model is shared between
 * the flat canvas and the 3D board, but placement (diagram.layouts vs
 * diagram.layouts3d) and connection routing (`*3d` twins) are per-mode.
 * Read rule everywhere: 3D value ?? 2D value.
 *
 * Dependency-light on purpose — the editor (CanvasView), the share viewer and
 * the image exporters all feed engines through these same helpers, and the
 * modelStore tests exercise them directly in the node environment.
 */

/** Resolve a connection's per-view routing for the 3D board: any `*3d` field
 * shadows its 2D twin. `waypoints3d: []` means "no bends in 3D" and deliberately
 * masks the 2D bends. The returned object still carries the `*3d` fields —
 * harmless to the engine, which reads the base names. */
export function resolveConnectionFor3d(c: Connection): Connection {
  if (
    c.waypoints3d === undefined &&
    c.fromAnchor3d === undefined &&
    c.toAnchor3d === undefined &&
    c.lockedToAnchors3d === undefined &&
    c.labelPosition3d === undefined &&
    c.labelOffset3d === undefined &&
    c.shape3d === undefined
  ) {
    return c
  }
  return {
    ...c,
    waypoints: c.waypoints3d ?? c.waypoints,
    fromAnchor: c.fromAnchor3d ?? c.fromAnchor,
    toAnchor: c.toAnchor3d ?? c.toAnchor,
    lockedToAnchors: c.lockedToAnchors3d ?? c.lockedToAnchors,
    labelPosition: c.labelPosition3d ?? c.labelPosition,
    labelOffset: c.labelOffset3d ?? c.labelOffset,
    shape: c.shape3d ?? c.shape,
  }
}

/** The composition+layout fields the merge needs — satisfied by both the store
 * `Diagram` and the share viewer's `ShareDiagram`. */
export type DiagramLayoutSource = Pick<
  Diagram,
  'objectIds' | 'connectionIds' | 'groupIds' | 'layouts' | 'layouts3d'
>

/** A diagram's composition with per-item layout merged onto positions/sizes —
 * exactly what the canvas engine consumes. `space: '3d'` resolves through the
 * 3D layer (3D ?? 2D) for shapes, groups AND connection routing. */
export function filterAndMergeDiagramData(
  diagram: DiagramLayoutSource | undefined,
  objects: C4Object[],
  connections: Connection[],
  groups: Group[],
  space: '2d' | '3d' = '2d'
) {
  const use3d = space === '3d'
  const layoutOf = (id: string) => (use3d ? diagram?.layouts3d?.[id] : undefined) ?? diagram?.layouts?.[id]
  const diagramObjectIds = new Set(diagram?.objectIds ?? [])
  const diagramConnectionIds = new Set(diagram?.connectionIds ?? [])
  const diagramGroupIds = new Set(diagram?.groupIds ?? [])
  const filteredObjects = objects
    .filter((o) => diagramObjectIds.has(o.id))
    .map((o) => {
      const layout = layoutOf(o.id)
      return layout ? { ...o, position: layout.position, size: layout.size } : o
    })
  const filteredConnections = connections
    .filter((c) => diagramConnectionIds.has(c.id))
    .map((c) => (use3d ? resolveConnectionFor3d(c) : c))
  const filteredGroups = groups
    .filter((g) => diagramGroupIds.has(g.id))
    .map((g) => {
      const layout = layoutOf(g.id)
      return layout ? { ...g, position: layout.position, size: layout.size } : g
    })
  return { filteredObjects, filteredConnections, filteredGroups }
}
