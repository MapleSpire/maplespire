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

import type { CanvasEngine } from '../canvas/engine/CanvasEngine'
import { filterAndMergeDiagramData } from '../lib/viewLayouts'
import type { ShareDiagram, ShareSnapshot } from '../lib/share/types'

/** Feed the bounded share snapshot into a presentation-only 2D renderer. */
export function feedViewerEngine(engine: CanvasEngine, sd: ShareDiagram, snap: ShareSnapshot) {
  const { filteredObjects, filteredConnections, filteredGroups } = filterAndMergeDiagramData(
    sd,
    snap.model.objects,
    snap.model.connections,
    snap.model.groups,
    '2d',
  )
  const flows = snap.flowsByDiagram[sd.id] ?? []

  engine.setData(filteredObjects, filteredConnections, filteredGroups, flows, snap.model.tags)
  engine.setReadonly(true)
  // Shared views are always presentation surfaces. Keep this explicit instead
  // of relying only on the renderer's readonly guard so a future engine change
  // cannot bring the editor grid back into a public link.
  engine.setShowGrid(false)
  engine.setConnectionAnimationsEnabled(sd.connectionAnimationsEnabled ?? true)
  engine.setConnectionHighlightStyle(sd.connectionHighlightStyle ?? 'traveling-dot')
}
