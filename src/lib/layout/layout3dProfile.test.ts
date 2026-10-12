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

import { describe, expect, it } from 'vitest'
import { iso3dVerticalStretch, optimizeDiagram, stretchSolutionVertically, type ConnPatch } from './index'
import type { C4Object, Connection, Diagram, Group } from '../../types'

// The 3D board profile POST-STRETCHES the winning 2D solution vertically —
// deliberately NOT touching the tuned ELK spacing cliff (see elkConfig.ts).
// Projected through the camera (Y × cos rx) the stretched layout reads exactly
// like the 2D one, plus headroom for lifted faces and standee drums.

describe('iso3dVerticalStretch', () => {
  it('restores the 2D rhythm plus headroom at each preset tilt', () => {
    expect(iso3dVerticalStretch(0)).toBeCloseTo(1.15, 6)
    expect(iso3dVerticalStretch(55)).toBeCloseTo(1.15 / Math.cos((55 * Math.PI) / 180), 6)
    expect(iso3dVerticalStretch(55) * Math.cos((55 * Math.PI) / 180)).toBeCloseTo(1.15, 6) // projected == 1.15×
  })

  it('stays finite at extreme tilts', () => {
    expect(iso3dVerticalStretch(89.9)).toBeLessThanOrEqual(1.15 / 0.05 + 1e-9)
  })
})

describe('stretchSolutionVertically', () => {
  const layouts = {
    a: { position: { x: 100, y: 200 }, size: { width: 160, height: 90 } },
    b: { position: { x: 100, y: 400 }, size: { width: 160, height: 90 } },
    g: { position: { x: 60, y: 160 }, size: { width: 300, height: 400 } },
  }
  const patches: Record<string, ConnPatch> = {
    c1: { waypoints: [{ x: 180, y: 350 }], labelPosition: 0.5, shape: 'curved' },
  }

  it('scales Y positions, group heights and waypoints; leaves X and node sizes', () => {
    const { layouts: out, connPatches } = stretchSolutionVertically(layouts, patches, 2, new Set(['g']))
    expect(out.a.position).toEqual({ x: 100, y: 400 })
    expect(out.a.size).toEqual({ width: 160, height: 90 }) // node size untouched
    expect(out.b.position.y).toBe(800)
    expect(out.g.position.y).toBe(320)
    expect(out.g.size).toEqual({ width: 300, height: 800 }) // group spans rows → scales
    expect(connPatches.c1.waypoints).toEqual([{ x: 180, y: 700 }])
    expect(connPatches.c1.labelPosition).toBe(0.5) // non-geometry fields ride through
  })

  it('grows the vertical gap between rows by exactly k', () => {
    const { layouts: out } = stretchSolutionVertically(layouts, {}, 2, new Set())
    const gapBefore = layouts.b.position.y - (layouts.a.position.y + layouts.a.size.height)
    const gapAfter = out.b.position.y - (out.a.position.y + out.a.size.height)
    expect(gapAfter).toBe(gapBefore * 2 + layouts.a.size.height) // tops spread ×2; card height fixed
    // Every pairwise top-to-top distance scales exactly ×k — no reordering possible.
    expect(out.b.position.y - out.a.position.y).toBe((layouts.b.position.y - layouts.a.position.y) * 2)
  })

  it('k = 1 is the identity (2D path untouched)', () => {
    const res = stretchSolutionVertically(layouts, patches, 1, new Set(['g']))
    expect(res.layouts).toBe(layouts)
    expect(res.connPatches).toBe(patches)
  })

  it('never shrinks a group below its members (slack grows with k ≥ 1)', () => {
    const { layouts: out } = stretchSolutionVertically(layouts, {}, 1.8, new Set(['g']))
    const memberBottom = Math.max(out.a.position.y + out.a.size.height, out.b.position.y + out.b.size.height)
    expect(out.g.position.y + out.g.size.height).toBeGreaterThanOrEqual(memberBottom)
    expect(out.g.position.y).toBeLessThanOrEqual(out.a.position.y)
  })
})

describe('optimizeDiagram 3D profile (real engine)', () => {
  function obj(id: string): C4Object {
    return {
      id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
      tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
    } as C4Object
  }
  const objects = [obj('A'), obj('B'), obj('C')]
  const connections: Connection[] = [
    { id: 'c1', fromId: 'A', toId: 'B', type: 'solid' },
    { id: 'c2', fromId: 'B', toId: 'C', type: 'solid' },
  ]
  const groups: Group[] = [{ id: 'g1', name: 'G', color: '#888', objectIds: ['B', 'C'], tagAssignments: {}, tagOrder: [] }]
  const diagram: Diagram = {
    id: 'd1', name: 'D', type: 'container',
    objectIds: ['A', 'B', 'C'], connectionIds: ['c1', 'c2'], groupIds: ['g1'],
  }
  const ctx = { objects, connections, groups }

  it('the 3D run is the 2D run stretched vertically — same X, same topology', async () => {
    const flat = await optimizeDiagram(diagram, ctx)
    const board = await optimizeDiagram(diagram, ctx, undefined, { space: '3d', cameraRx: 55 })
    const k = iso3dVerticalStretch(55)
    for (const id of ['A', 'B', 'C', 'g1']) {
      expect(board.layouts[id].position.x).toBe(flat.layouts[id].position.x)
      expect(board.layouts[id].position.y).toBe(Math.round(flat.layouts[id].position.y * k))
    }
    // Node sizes identical; the group's height stretched.
    expect(board.layouts.A.size).toEqual(flat.layouts.A.size)
    expect(board.layouts.g1.size.height).toBe(Math.round(flat.layouts.g1.size.height * k))
    // No overlaps in the projected view: projected Y-gaps equal 1.15× the flat
    // ones, X untouched — spot-check A vs B row separation.
    const cos = Math.cos((55 * Math.PI) / 180)
    const flatGap = Math.abs(flat.layouts.B.position.y - flat.layouts.A.position.y)
    const boardGapProjected = Math.abs(board.layouts.B.position.y - board.layouts.A.position.y) * cos
    if (flatGap > 0) {
      expect(boardGapProjected).toBeGreaterThanOrEqual(flatGap * 1.1)
    }
  }, 30000)
})
