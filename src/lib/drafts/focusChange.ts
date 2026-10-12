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

import { useModelStore, getDiagramIndex } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import type { DraftChange, DraftConflict } from './api'

/**
 * Reveal a draft change's entity on the canvas: navigate to a diagram that contains it
 * (preferring the current diagram if it does), switch to the diagram view, and select it
 * so the canvas highlights/pans to it. Returns false when the change has nothing to focus
 * (e.g. a domain/tag/decision-record, or an object on no diagram). Reuses the same
 * select + setCurrentDiagram machinery the search modal / expand menu use.
 */
export function focusChange(change: DraftChange | DraftConflict): boolean {
  const model = useModelStore.getState()
  const ui = useUIStore.getState()

  // Navigate to `diagramId` (if not already there) then run `select`. setCurrentDiagram
  // CLEARS the selection, so it must run before selecting.
  const go = (diagramId: string, select?: () => void) => {
    if (model.currentDiagramId !== diagramId) model.setCurrentDiagram(diagramId)
    select?.()
    ui.setCurrentView('diagram')
  }

  // Prefer the current diagram if it shows the entity, else the first that does.
  const pick = (ids: Set<string> | undefined): string | undefined => {
    if (!ids || ids.size === 0) return undefined
    if (model.currentDiagramId && ids.has(model.currentDiagramId)) return model.currentDiagramId
    return [...ids][0]
  }

  const idx = getDiagramIndex()
  switch (change.collection) {
    case 'object': {
      const d = pick(idx.objectToDiagramIds.get(change.id))
      if (!d) return false
      go(d, () => model.selectObjects([change.id]))
      return true
    }
    case 'connection': {
      const d = pick(idx.connectionToDiagramIds.get(change.id))
      if (!d) return false
      go(d, () => model.selectConnection(change.id))
      return true
    }
    case 'group': {
      const d = pick(idx.groupToDiagramIds.get(change.id))
      if (!d) return false
      go(d, () => model.selectGroup(change.id))
      return true
    }
    case 'diagram':
      go(change.id)
      return true
    case 'layout': {
      // change.id is the laid-out object OR group id; change.diagramId is the diagram.
      if (!change.diagramId) return false
      const isGroup = idx.groupToDiagramIds.has(change.id)
      go(change.diagramId, () => (isGroup ? model.selectGroup(change.id) : model.selectObjects([change.id])))
      return true
    }
    case 'flow':
      if (!change.diagramId) return false
      go(change.diagramId)
      return true
    default:
      return false // domain / tag / decisionRecord — not on the canvas
  }
}
