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

import { describe, expect, it, vi } from 'vitest'
import type { CanvasEngine } from '../../canvas/engine/CanvasEngine'
import type { Scene3D } from '../../canvas3d'
import { editorCanvasInsets, fitActiveCanvas, zoomActiveCanvas } from './canvasViewportControls'

describe('canvas viewport controls', () => {
  it('reserves the floating sidebars when fitting the 2D canvas', () => {
    const onZoom = vi.fn()
    const engine = {
      zoomToFit: vi.fn(),
      getZoom: vi.fn(() => 0.72),
    } as unknown as CanvasEngine
    const insets = editorCanvasInsets(true, true)

    fitActiveCanvas('2d', engine, null, insets, onZoom)

    expect(insets).toEqual({ left: 340, right: 340 })
    expect(engine.zoomToFit).toHaveBeenCalledWith(insets)
    expect(onZoom).toHaveBeenCalledWith(0.72)
  })

  it('routes zoom and fit controls to the live 3D camera', () => {
    const scene = {
      getCameraPose: vi.fn(() => ({ targetX: 120, targetZ: 240, distance: 1200 })),
      flyTo: vi.fn(),
      frame: vi.fn(),
    } as unknown as Scene3D
    const onZoom = vi.fn()
    const insets = editorCanvasInsets(true, false)

    zoomActiveCanvas('3d', 'in', null, scene, onZoom)
    expect(scene.flyTo).toHaveBeenCalledWith(120, 240, 1000, 220)

    zoomActiveCanvas('3d', 'out', null, scene, onZoom)
    expect(scene.flyTo).toHaveBeenLastCalledWith(120, 240, 1440, 220)

    fitActiveCanvas('3d', null, scene, insets, onZoom)
    expect(scene.frame).toHaveBeenCalledWith(false, insets)
    expect(onZoom).not.toHaveBeenCalled()
  })
})
