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

import type { Diagram } from '../../types'

/**
 * Where "up" goes from a detail diagram.
 *
 * The canvas draws the affordance in the parent-wrapper group's top-left
 * corner, mirroring the expand indicator in a shape's top-right. It was already
 * drawn there — but gated on `previousDiagramId`, in-memory session history set
 * ONLY by ExpandMenu's drill-down, cleared the first time you used it, and
 * `null` after any reload. So the way back existed exactly once, and only if you
 * had arrived by drilling in. Open a detail diagram from a URL, the diagrams
 * list, or after a refresh and there was no way up at all, even though
 * `diagram.parentObjectId` was sitting right there.
 *
 * This derives the target from the MODEL instead, which is what makes the glyph
 * appear whenever there is somewhere to go. Session history is still consulted
 * first, because returning the user to the diagram they actually came from
 * beats an equally valid diagram they have never seen.
 */
export interface ParentNavigationTarget {
  /** The object this diagram details. */
  objectId: string
  /** The diagram to open. Never null: no destination, no affordance — a glyph
   *  the user can click that goes nowhere is worse than no glyph. */
  diagramId: string
  diagramName: string
}

export interface ParentNavigationInput {
  currentDiagram: Diagram | null | undefined
  /** The shared `diagramById` index. Taking the MAP rather than the array
   *  avoids building a fresh Map of every diagram in the landscape for a
   *  handful of lookups on every memo invalidation. */
  diagramById: ReadonlyMap<string, Diagram>
  /** The `od:` index: object id → ids of diagrams that show it as a shape. */
  objectToDiagramIds: ReadonlyMap<string, ReadonlySet<string>>
  previousDiagramId: string | null
}

/** Context is "higher" than Container is "higher" than Component. Going up
 *  should land on the broadest view that shows the parent, not an arbitrary one. */
const TYPE_RANK: Record<Diagram['type'], number> = { context: 0, container: 1, component: 2 }

function compareCandidates(a: Diagram, b: Diagram): number {
  // A diagram that is itself a drill-down is further from the top than one that
  // is not, whatever their C4 levels say.
  const aDrill = a.parentObjectId ? 1 : 0
  const bDrill = b.parentObjectId ? 1 : 0
  if (aDrill !== bDrill) return aDrill - bDrill
  const rank = TYPE_RANK[a.type] - TYPE_RANK[b.type]
  if (rank !== 0) return rank
  // Stable last resort so the affordance does not point somewhere different on
  // each render.
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}

export function resolveParentNavigation(input: ParentNavigationInput): ParentNavigationTarget | null {
  const { currentDiagram, previousDiagramId } = input
  const objectId = currentDiagram?.parentObjectId
  if (!currentDiagram || !objectId) return null

  const candidates: Diagram[] = []
  for (const diagramId of input.objectToDiagramIds.get(objectId) ?? []) {
    if (diagramId === currentDiagram.id) continue
    const diagram = input.diagramById.get(diagramId)
    if (diagram) candidates.push(diagram)
  }

  // History wins when it agrees with the model — the user knows that diagram.
  const historical = previousDiagramId && previousDiagramId !== currentDiagram.id
    ? candidates.find((diagram) => diagram.id === previousDiagramId)
    : undefined
  const target = historical ?? [...candidates].sort(compareCandidates)[0]
  if (!target) return null

  return { objectId, diagramId: target.id, diagramName: target.name }
}
