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

import type { Diagram, Flow, Position, Size } from '../../types'
import { cloneLowerRoutingMap } from './lowerRouting'

/**
 * Duplicating a diagram copies the VIEW, never the model.
 *
 * `objectIds` / `connectionIds` / `groupIds` are carried over verbatim, so the
 * copy shows the very same C4 objects — one object, two views. This is the
 * opposite of every other copy path in the repo (duplicating a shape, importing
 * JSON, forking a version), all of which mint fresh entity ids. Getting it wrong
 * here would silently double the model behind the user's back.
 *
 * Only two fields are deliberately dropped:
 *
 * - `sourceViewKey` — the Structurizr view key. It is an identifier, and the
 *   exporter emits one `<type> <scope> "<key>"` block per diagram keyed on it
 *   (see `buildStructurizrDsl`). Two diagrams claiming the same key produce a
 *   DSL that does not parse, and break round-trip stability. The copy is a new
 *   view; it earns a key when it is exported.
 * - `readonly` — the per-diagram edit lock. It is an affordance the user set on
 *   *that* diagram, not an authorization boundary (`workspaceReadOnly` is, and
 *   it gates the menu that reaches this code). Someone duplicating a locked
 *   diagram is asking for a copy they can work in.
 *
 * Everything else describes how the view looks and is copied. Fields added to
 * `Diagram` later are carried by default, which is the right default for a view
 * duplicate — revisit this list if one of them is ever identity-bearing.
 */
export const DUPLICATE_DROPPED_FIELDS = ['id', 'sourceViewKey', 'readonly'] as const

/** Clone a placement layer so the copy shares no structure with the source.
 *  The source is frequently a live Automerge document proxy; handing its nested
 *  objects to another document is how you get a cross-document alias. */
function cloneLayouts(
  layouts: Record<string, { position: Position; size: Size }> | undefined,
): Record<string, { position: Position; size: Size }> | undefined {
  if (!layouts) return undefined
  const out: Record<string, { position: Position; size: Size }> = {}
  for (const [id, placement] of Object.entries(layouts)) {
    out[id] = { position: { ...placement.position }, size: { ...placement.size } }
  }
  return out
}

/** The body of the duplicate — everything but the id, which the store mints. */
export function buildDuplicateDiagram(source: Diagram, name: string): Omit<Diagram, 'id'> {
  const {
    id: _id,
    sourceViewKey: _sourceViewKey,
    readonly: _readonly,
    name: _name,
    objectIds,
    connectionIds,
    groupIds,
    layouts,
    layouts3d,
    lowerRouting,
    ...view
  } = source
  const copy: Omit<Diagram, 'id'> = {
    ...view,
    name,
    // Same model entities, by id. This IS the feature.
    objectIds: [...objectIds],
    connectionIds: [...connectionIds],
    groupIds: [...groupIds],
  }
  const clonedLayouts = cloneLayouts(layouts)
  if (clonedLayouts) copy.layouts = clonedLayouts
  // Only present once the diagram has been adjusted in 3D; copying an absent
  // layer would fork the copy's 3D placement away from its 2D one on creation.
  const cloned3d = cloneLayouts(layouts3d)
  if (cloned3d) copy.layouts3d = cloned3d
  // Same objects at the same positions, so the same derived lowers routed the
  // same way — and, like the layouts, never aliased into the copy's document.
  const clonedLowerRouting = cloneLowerRoutingMap(lowerRouting)
  if (clonedLowerRouting) copy.lowerRouting = clonedLowerRouting
  return copy
}

/**
 * Re-point the source's flows at the copy. Flows are diagram-scoped view
 * content (they narrate a path through the connections the diagram shows), so
 * they belong to the duplicate — but each flow and each step needs its own id,
 * or the two diagrams' flows collide in the store's flat `flows` array.
 *
 * The steps' `objectId` / `connectionId` references are NOT remapped, for the
 * same reason the composition isn't: they point at shared model entities.
 */
export function buildDuplicateFlows(
  flows: readonly Flow[],
  diagramId: string,
  newId: () => string,
): Flow[] {
  return flows.map((flow) => ({
    ...flow,
    id: newId(),
    diagramId,
    steps: flow.steps.map((step) => ({ ...step, id: newId() })),
  }))
}
