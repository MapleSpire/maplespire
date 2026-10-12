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

import type { C4Object, Connection, Group, Tag, Diagram } from '../../types'
import type { ShareDiagram, ShareSnapshot } from './types'

/** The model fields a share may reference. Deliberately NO comments / decision
 * records / domains — only what the canvas renders. */
export interface ShareModelInput {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  tags: Tag[]
}

/**
 * Project a store `Diagram` into the slim `ShareDiagram` the viewer renders.
 * Pure (no Automerge) so it's unit-testable. Copies only the safe display fields
 * — never the diagram's comments / flows / checkpoints — and omits optional fields
 * when absent so we don't emit `undefined`.
 */
export function toShareDiagram(dg: Diagram): ShareDiagram {
  const sd: ShareDiagram = {
    id: dg.id,
    name: dg.name,
    type: dg.type,
    objectIds: dg.objectIds,
    connectionIds: dg.connectionIds,
    groupIds: dg.groupIds,
    layouts: dg.layouts ?? {},
  }
  if (dg.parentObjectId !== undefined) sd.parentObjectId = dg.parentObjectId
  if (dg.skinId !== undefined) sd.skinId = dg.skinId
  if (dg.connectionHighlightStyle !== undefined) sd.connectionHighlightStyle = dg.connectionHighlightStyle
  if (dg.connectionAnimationsEnabled !== undefined) sd.connectionAnimationsEnabled = dg.connectionAnimationsEnabled
  if (dg.defaultConnectionShape !== undefined) sd.defaultConnectionShape = dg.defaultConnectionShape
  // The 3D board layer rides so the viewer's 3D toggle shows the author's
  // perfected arrangement (connection `*3d` routing rides on the connections).
  if (dg.layouts3d !== undefined) sd.layouts3d = dg.layouts3d
  // Scene decoration rides too — the shared link shows the dressed board.
  if (dg.sceneDecor !== undefined) sd.sceneDecor = dg.sceneDecor
  return sd
}

/**
 * Filter a full model down to only what the given diagrams reference: objects,
 * connections and groups in their composition, plus the tags those objects use.
 * Everything else (unreferenced entities, the whole model otherwise) is dropped —
 * this is the data-exposure boundary for a share.
 */
export function sliceModelForShare(diagrams: ShareDiagram[], model: ShareModelInput): ShareSnapshot['model'] {
  const objectIds = new Set<string>()
  const connectionIds = new Set<string>()
  const groupIds = new Set<string>()
  for (const d of diagrams) {
    d.objectIds.forEach((x) => objectIds.add(x))
    d.connectionIds.forEach((x) => connectionIds.add(x))
    d.groupIds.forEach((x) => groupIds.add(x))
  }

  const objects = model.objects.filter((o) => objectIds.has(o.id))
  const connections = model.connections.filter((c) => connectionIds.has(c.id))
  const groups = model.groups.filter((g) => groupIds.has(g.id))

  const tagNeeded = new Set<string>()
  for (const object of objects) for (const tagId of Object.keys(object.tagAssignments ?? {})) tagNeeded.add(tagId)
  for (const connection of connections) for (const tagId of Object.keys(connection.tagAssignments ?? {})) tagNeeded.add(tagId)
  for (const group of groups) for (const tagId of Object.keys(group.tagAssignments ?? {})) tagNeeded.add(tagId)
  const tags = model.tags.filter((snapshot) => tagNeeded.has(snapshot.tagId))

  return { objects, connections, groups, tags }
}
