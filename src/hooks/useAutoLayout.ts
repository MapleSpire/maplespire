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

import { useState } from 'react'
import { useModelStore } from '../stores/modelStore'
import { useUIStore } from '../stores/uiStore'
import { CAMERA_PRESETS } from '../canvas3d/presets'

/**
 * Re-optimize the current diagram's placement with the same engine the import
 * uses. ELK is lazy-imported so it stays out of the main bundle. A hook so the
 * floating editor chrome (vertical toolbar) can drive it.
 *
 * Space-aware: run while the 3D board is active and the result lands in the
 * diagram's SEPARATE 3D layer (layouts3d + `*3d` connection routing), vertically
 * stretched for the active camera tilt — the 2D arrangement is not touched.
 */
export function useAutoLayout() {
  const requestFit = useUIStore((s) => s.requestFit)
  const [autoLaying, setAutoLaying] = useState(false)

  const autoLayout = async () => {
    const ms = useModelStore.getState()
    const diagram = ms.getCurrentDiagram()
    if (!diagram || diagram.objectIds.length === 0) return
    setAutoLaying(true)
    try {
      const { optimizeDiagram } = await import('../lib/layout')
      const ui = useUIStore.getState()
      const space = ui.canvasViewMode
      const compositionAtStart = [
        ...diagram.objectIds.map((id) => `o:${id}`),
        ...diagram.connectionIds.map((id) => `c:${id}`),
        ...diagram.groupIds.map((id) => `g:${id}`),
      ].sort().join('|')
      const ctx = { objects: ms.objects, connections: ms.connections, groups: ms.groups }
      const { layouts, connPatches } = await optimizeDiagram(diagram, ctx, undefined, {
        space,
        cameraRx: CAMERA_PRESETS[ui.cameraPreset].rx,
      })
      // The optimizer is asynchronous. Never apply its stale result after the
      // user navigated or a collaborative projection changed the composition.
      const latest = useModelStore.getState()
      const latestDiagram = latest.getCurrentDiagram()
      const latestComposition = latestDiagram ? [
        ...latestDiagram.objectIds.map((id) => `o:${id}`),
        ...latestDiagram.connectionIds.map((id) => `c:${id}`),
        ...latestDiagram.groupIds.map((id) => `g:${id}`),
      ].sort().join('|') : ''
      if (!latestDiagram || latestDiagram.id !== diagram.id || latestComposition !== compositionAtStart) return
      latest.applyDiagramLayout(
        diagram.id,
        layouts,
        Object.entries(connPatches).map(([id, p]) => ({ id, ...p })),
        space,
      )
      if (useUIStore.getState().canvasViewMode === space) requestFit()
    } finally {
      setAutoLaying(false)
    }
  }

  return { autoLaying, autoLayout }
}
