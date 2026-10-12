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

import type { CanvasEngine, CanvasViewportInsets } from '../../canvas/engine/CanvasEngine'
import type { Scene3D } from '../../canvas3d'

const EDITOR_PANEL_INSET = 340

export function editorCanvasInsets(
  leftSidebarOpen: boolean,
  rightSidebarOpen: boolean,
): CanvasViewportInsets {
  return {
    left: leftSidebarOpen ? EDITOR_PANEL_INSET : 0,
    right: rightSidebarOpen ? EDITOR_PANEL_INSET : 0,
  }
}

export function zoomActiveCanvas(
  view: '2d' | '3d',
  direction: 'in' | 'out',
  engine: CanvasEngine | null,
  scene: Scene3D | null,
  on2dZoom: (zoom: number) => void,
) {
  if (view === '3d') {
    if (!scene) return
    const pose = scene.getCameraPose()
    const factor = direction === 'in' ? 1 / 1.2 : 1.2
    scene.flyTo(
      pose.targetX,
      pose.targetZ,
      Math.max(120, Math.min(80_000, pose.distance * factor)),
      220,
    )
    return
  }

  if (!engine) return
  const delta = direction === 'in' ? 0.1 : -0.1
  const next = Math.max(0.1, Math.min(4, engine.getZoom() + delta))
  engine.setZoom(next)
  on2dZoom(next)
}

export function fitActiveCanvas(
  view: '2d' | '3d',
  engine: CanvasEngine | null,
  scene: Scene3D | null,
  insets: CanvasViewportInsets,
  on2dZoom: (zoom: number) => void,
) {
  if (view === '3d') {
    scene?.frame(false, insets)
    return
  }
  if (!engine) return
  engine.zoomToFit(insets)
  on2dZoom(engine.getZoom())
}
