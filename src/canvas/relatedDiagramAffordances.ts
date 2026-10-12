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

import type { C4Object, Diagram } from '../types'

/**
 * Resolve the canvas objects that have at least one diagram associated with
 * them. This mirrors getRelatedDiagrams' detail/reference/parent semantics,
 * while staying synchronous and offline-first for the canvas render path.
 */
export function collectRelatedDiagramObjectIds(
  objects: readonly C4Object[],
  diagrams: readonly Diagram[],
  currentDiagramId: string | null,
  objectToDiagramIds: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const relatedObjectIds = new Set<string>()
  const relatedParentObjectIds = new Set<string>()

  for (const diagram of diagrams) {
    if (diagram.id !== currentDiagramId && diagram.parentObjectId) {
      relatedParentObjectIds.add(diagram.parentObjectId)
    }
  }

  for (const object of objects) {
    const referenceDiagramIds = objectToDiagramIds.get(object.id)
    if (referenceDiagramIds) {
      for (const diagramId of referenceDiagramIds) {
        if (diagramId !== currentDiagramId) {
          relatedObjectIds.add(object.id)
          break
        }
      }
    }

    if (
      relatedParentObjectIds.has(object.id)
      || (object.parentId ? relatedParentObjectIds.has(object.parentId) : false)
    ) {
      relatedObjectIds.add(object.id)
    }
  }

  return relatedObjectIds
}
