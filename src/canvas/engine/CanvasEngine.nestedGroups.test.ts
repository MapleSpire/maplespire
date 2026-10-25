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
import type { C4Object, Group } from '../../types'

type CanvasCallbacks = ConstructorParameters<typeof CanvasEngine>[1]

/**
 * Auto-sized standard groups nested by membership (review lens, 2026-10-22):
 * drawn around their own shapes only, an outer group and a group nested in it
 * shared the border nearest their top shape, and both titles were painted on it.
 */

function object(id: string, x: number, y: number): C4Object {
  return {
    id, type: 'app', name: id, position: { x, y }, size: { width: 100, height: 60 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  } as C4Object
}

function group(id: string, objectIds: string[], over: Partial<Group> = {}): Group {
  return { id, name: id, color: '#EFEDE9', objectIds, tagAssignments: {}, tagOrder: [], ...over } as Group
}

function engineWith(objects: C4Object[], groups: Group[], extra: Partial<CanvasCallbacks> = {}) {
  const canvas = document.createElement('canvas')
  const noop = () => undefined
  const engine = new CanvasEngine(canvas, {
    onObjectSelect: noop, onPlacementsCommit: noop, onObjectDoubleClick: noop, onGroupDoubleClick: noop,
    onConnectionSelect: noop, onConnectionDoubleClick: noop, onConnectionLabelMove: noop,
    onConnectionWaypointsChange: noop, onConnectionStart: noop, onConnectionEnd: noop,
    onConnectionAnchorMove: noop, onZoom: noop, onCommentClick: noop, onCommentMove: noop,
    onContextMenu: noop, onGroupSelect: noop, onCopyApply: noop, onExpandClick: noop,
    ...extra,
  })
  engine.setData(objects, [], groups)
  return engine
}

function mouse(type: string, x: number, y: number): MouseEvent {
  const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y })
  Object.defineProperty(event, 'offsetX', { value: x })
  Object.defineProperty(event, 'offsetY', { value: y })
  return event
}

/** A real press-move-release through the engine's own mouse handlers. */
function drag(engine: CanvasEngine, from: { x: number; y: number }, to: { x: number; y: number }) {
  const internals = engine as unknown as Record<'onMouseDown' | 'onMouseMove' | 'onMouseUp', (e?: MouseEvent) => void>
  internals.onMouseDown(mouse('mousedown', from.x, from.y))
  internals.onMouseMove(mouse('mousemove', to.x, to.y))
  internals.onMouseUp(mouse('mouseup', to.x, to.y))
}

const inside = (inner: { x: number; y: number; width: number; height: number }, outer: typeof inner) =>
  outer.x < inner.x && outer.y < inner.y
  && outer.x + outer.width > inner.x + inner.width && outer.y + outer.height > inner.y + inner.height

let contextSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  contextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '',
    measureText: (text: string) => ({ width: text.length }),
  } as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  contextSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('CanvasEngine — auto-sized groups nested by membership', () => {
  const shapes = [object('a', 0, 200), object('b', 0, 320), object('c', 200, 200)]

  it('draws an auto-sized group around the group nested in it, header band included', () => {
    const engine = engineWith(shapes, [group('outer', ['a', 'b', 'c']), group('inner', ['a', 'b'])])
    expect(inside(engine.getGroupBoundsById('inner')!, engine.getGroupBoundsById('outer')!)).toBe(true)
  })

  it('nests equal member sets by id, the smaller id outside, whatever the order given', () => {
    for (const order of [['g1', 'g2'], ['g2', 'g1']]) {
      const engine = engineWith(shapes, order.map((id) => group(id, ['a', 'b'])))
      expect(inside(engine.getGroupBoundsById('g2')!, engine.getGroupBoundsById('g1')!), order.join()).toBe(true)
    }
  })

  it('keeps a stored (autoSize:false) group box exactly as stored', () => {
    const stored = group('outer', ['a', 'b', 'c'], { autoSize: false, position: { x: -10, y: 150 }, size: { width: 400, height: 300 } })
    const engine = engineWith(shapes, [stored, group('inner', ['a', 'b'])])
    expect(engine.getGroupBoundsById('outer')).toEqual({ x: -10, y: 150, width: 400, height: 300 })
  })

  it('moves an auto-sized group with a stored group nested in it', () => {
    const inner = group('inner', ['a', 'b'], { autoSize: false, position: { x: -30, y: 150 }, size: { width: 160, height: 260 } })
    const engine = engineWith(shapes, [group('outer', ['a', 'b', 'c']), inner])
    const before = engine.getGroupBoundsById('outer')!
    engine.updatePlacements({ groups: [{ id: 'inner', position: { x: -130, y: 150 } }] })
    const after = engine.getGroupBoundsById('outer')!
    expect(after.x).toBe(before.x - 100)
    expect(inside(engine.getGroupBoundsById('inner')!, after)).toBe(true)
  })

  // Review lens, 2026-10-25: the drag moved the outer group's shapes and left the
  // stored inner box behind; the outer box, drawn around it, then stretched from
  // its new place back to the old one (width 390 → 890 for a 500 px drag).
  it('carries a stored group nested in a dragged group, so the dragged box keeps its size', () => {
    const inner = group('inner', ['a', 'b'], { autoSize: false, position: { x: -30, y: 150 }, size: { width: 160, height: 260 } })
    const commits: Array<{ groups?: Array<{ id: string; position?: { x: number; y: number } }> }> = []
    const engine = engineWith(shapes, [group('outer', ['a', 'b', 'c']), inner], { onPlacementsCommit: (u) => { commits.push(u) } })
    const before = engine.getGroupBoundsById('outer')!
    // (250, 330): inside the outer box, below `c`, right of the inner box.
    drag(engine, { x: 250, y: 330 }, { x: 750, y: 330 })
    expect(engine.getGroupBoundsById('outer')).toEqual({ ...before, x: before.x + 500 })
    expect(engine.getGroupBoundsById('inner')).toEqual({ x: 470, y: 150, width: 160, height: 260 })
    expect(commits.at(-1)?.groups).toContainEqual({ id: 'inner', position: { x: 470, y: 150 } })
  })

  // Review lens, 2026-10-25: the drop rounded each member and each nested box to
  // the grid on its own, so pieces off the grid moved by different amounts and
  // drifted apart by up to half a grid step on every drop.
  it('snaps a dropped group by one correction, so off-grid pieces keep their offsets', () => {
    const offGrid = [object('a', 3, 207), object('b', 3, 327), object('c', 203, 207)]
    const inner = group('inner', ['a', 'b'], { autoSize: false, position: { x: -26, y: 156 }, size: { width: 160, height: 260 } })
    const engine = engineWith(offGrid, [group('outer', ['a', 'b', 'c']), inner])
    const offsets = () => {
      const box = engine.getGroupBoundsById('inner')!
      const shapes = (engine as unknown as { objectMap: Map<string, C4Object> }).objectMap
      const pa = shapes.get('a')!.position
      return { box: { x: box.x - pa.x, y: box.y - pa.y }, b: shapes.get('b')!.position.y - pa.y, c: shapes.get('c')!.position.x - pa.x, a: pa }
    }
    const before = offsets()
    drag(engine, { x: 253, y: 337 }, { x: 753, y: 337 })
    const after = offsets()
    expect(after.a.x % 10).toBe(0)
    expect(after.a.y % 10).toBe(0)
    expect({ box: after.box, b: after.b, c: after.c }).toEqual({ box: before.box, b: before.b, c: before.c })
  })

  it('keeps members that sit on the grid on it, whatever the group\'s own stored position', () => {
    // A group's position sits a header band above its members (46 px): anchoring
    // the snap on it put on-grid members 4 px off the grid (seen live, 2026-10-25).
    const engine = engineWith(shapes, [group('outer', ['a', 'b', 'c'], { position: { x: -30, y: 154 } })])
    drag(engine, { x: 250, y: 330 }, { x: 783, y: 347 })
    const objects = (engine as unknown as { objectMap: Map<string, C4Object> }).objectMap
    for (const id of ['a', 'b', 'c']) {
      const p = objects.get(id)!.position
      expect([p.x % 10, p.y % 10], id).toEqual([0, 0])
    }
  })
})
