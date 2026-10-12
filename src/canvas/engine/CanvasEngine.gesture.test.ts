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

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasEngine } from './CanvasEngine'
import type { C4Object, Connection } from '../../types'
import type { SmartGuide } from '../../lib/layout/alignmentGuides'

function object(id: string, x: number): C4Object {
  return {
    id,
    type: 'app',
    name: id,
    position: { x, y: 0 },
    size: { width: 160, height: 90 },
    tagAssignments: {},
    tagOrder: [],
    scope: 'internal',
    status: 'live',
    properties: {},
  } as C4Object
}

function mouse(x: number, y: number): MouseEvent {
  const event = new MouseEvent('mousemove', { button: 0, clientX: x, clientY: y })
  Object.defineProperty(event, 'offsetX', { value: x })
  Object.defineProperty(event, 'offsetY', { value: y })
  return event
}

interface GestureInternals {
  onMouseDown: (event: MouseEvent) => void
  onMouseMove: (event: MouseEvent) => void
  onMouseUp: () => void
  objectMap: Map<string, C4Object>
  connectionGeometryCache: Map<string, unknown>
  smartGuides: SmartGuide[]
  smartGuideSnap: { x: boolean; y: boolean }
}

let contextSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  contextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({} as CanvasRenderingContext2D)
})

afterEach(() => {
  contextSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('CanvasEngine placement gesture', () => {
  it('keeps pointer previews local and commits one final batch on mouse-up', () => {
    const commits: Array<{
      objects: Array<{ id: string; position: { x: number; y: number } }>
      groups: unknown[]
    }> = []
    const canvas = document.createElement('canvas')
    const engine = new CanvasEngine(canvas, {
      onObjectSelect: () => undefined,
      onPlacementsCommit: (updates) => commits.push(updates),
      onObjectDoubleClick: () => undefined,
      onGroupDoubleClick: () => undefined,
      onConnectionSelect: () => undefined,
      onConnectionDoubleClick: () => undefined,
      onConnectionLabelMove: () => undefined,
      onConnectionWaypointsChange: () => undefined,
      onConnectionStart: () => undefined,
      onConnectionEnd: () => undefined,
      onConnectionAnchorMove: () => undefined,
      onZoom: () => undefined,
      onCommentClick: () => undefined,
      onCommentMove: () => undefined,
      onContextMenu: () => undefined,
      onGroupSelect: () => undefined,
      onCopyApply: () => undefined,
      onExpandClick: () => undefined,
    })
    engine.setData(
      [object('A', 0), object('B', 400)],
      [{ id: 'c1', fromId: 'A', toId: 'B', type: 'solid' } as Connection],
    )
    const internals = engine as unknown as GestureInternals
    internals.connectionGeometryCache.set('c1', {})

    internals.onMouseDown(mouse(10, 10))
    internals.onMouseMove(mouse(70, 40))

    expect(commits).toHaveLength(0)
    expect(internals.objectMap.get('A')?.position).toEqual({ x: 60, y: 30 })
    expect(internals.connectionGeometryCache.has('c1')).toBe(false)

    internals.onMouseUp()

    expect(commits).toHaveLength(1)
    expect(commits[0].objects).toEqual([{ id: 'A', position: { x: 60, y: 30 } }])
    engine.destroy()
  })

  it('does not let a stale setData refresh move a shape during a later drag', () => {
    const commits: Array<{
      objects: Array<{ id: string; position: { x: number; y: number } }>
      groups: unknown[]
    }> = []
    const canvas = document.createElement('canvas')
    const connection = { id: 'c1', fromId: 'A', toId: 'B', type: 'solid' } as Connection
    const engine = new CanvasEngine(canvas, {
      onObjectSelect: () => undefined,
      onPlacementsCommit: (updates) => commits.push(updates),
      onObjectDoubleClick: () => undefined,
      onGroupDoubleClick: () => undefined,
      onConnectionSelect: () => undefined,
      onConnectionDoubleClick: () => undefined,
      onConnectionLabelMove: () => undefined,
      onConnectionWaypointsChange: () => undefined,
      onConnectionStart: () => undefined,
      onConnectionEnd: () => undefined,
      onConnectionAnchorMove: () => undefined,
      onZoom: () => undefined,
      onCommentClick: () => undefined,
      onCommentMove: () => undefined,
      onContextMenu: () => undefined,
      onGroupSelect: () => undefined,
      onCopyApply: () => undefined,
      onExpandClick: () => undefined,
    })
    engine.setData([object('A', 0), object('B', 400)], [connection])
    const internals = engine as unknown as GestureInternals

    // Three completed moves establish multiple persistence/render cycles.
    for (let i = 0; i < 3; i++) {
      const x = internals.objectMap.get('A')!.position.x
      internals.onMouseDown(mouse(x + 10, 10))
      internals.onMouseMove(mouse(x + 50, 10))
      internals.onMouseUp()
    }
    expect(internals.objectMap.get('A')?.position).toEqual({ x: 120, y: 0 })

    // During the fourth drag, a delayed refresh still carries the first move.
    internals.onMouseDown(mouse(130, 10))
    internals.onMouseMove(mouse(170, 40))
    expect(internals.objectMap.get('A')?.position).toEqual({ x: 160, y: 30 })
    engine.setData([object('A', 40), object('B', 400)], [connection])

    // The pointer-owned preview and final commit must remain at the fourth move.
    expect(internals.objectMap.get('A')?.position).toEqual({ x: 160, y: 30 })
    internals.onMouseUp()
    expect(commits.at(-1)?.objects).toEqual([{ id: 'A', position: { x: 160, y: 30 } }])
    engine.destroy()
  })

  it('shows an alignment guide and preserves its snap instead of re-snapping to the grid', () => {
    const commits: Array<{
      objects: Array<{ id: string; position: { x: number; y: number } }>
      groups: unknown[]
    }> = []
    const canvas = document.createElement('canvas')
    const engine = new CanvasEngine(canvas, {
      onObjectSelect: () => undefined,
      onPlacementsCommit: (updates) => commits.push(updates),
      onObjectDoubleClick: () => undefined,
      onGroupDoubleClick: () => undefined,
      onConnectionSelect: () => undefined,
      onConnectionDoubleClick: () => undefined,
      onConnectionLabelMove: () => undefined,
      onConnectionWaypointsChange: () => undefined,
      onConnectionStart: () => undefined,
      onConnectionEnd: () => undefined,
      onConnectionAnchorMove: () => undefined,
      onZoom: () => undefined,
      onCommentClick: () => undefined,
      onCommentMove: () => undefined,
      onContextMenu: () => undefined,
      onGroupSelect: () => undefined,
      onCopyApply: () => undefined,
      onExpandClick: () => undefined,
    })
    engine.setData([object('A', 0), object('B', 403)], [])
    const internals = engine as unknown as GestureInternals

    internals.onMouseDown(mouse(10, 10))
    internals.onMouseMove(mouse(410, 10)) // raw x=400, within 3px of B

    expect(internals.objectMap.get('A')?.position).toEqual({ x: 403, y: 0 })
    expect(internals.smartGuideSnap).toEqual({ x: true, y: true })
    expect(internals.smartGuides).toContainEqual(expect.objectContaining({
      kind: 'alignment', axis: 'x', value: 483,
    }))

    internals.onMouseUp()
    expect(commits.at(-1)?.objects).toEqual([{ id: 'A', position: { x: 403, y: 0 } }])
    expect(internals.smartGuides).toEqual([])
    engine.destroy()
  })
})
