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

type CanvasCallbacks = ConstructorParameters<typeof CanvasEngine>[1]
import { parentWrapperBox, parentWrapperHeaderBand } from '../parentWrapperBox'
import { defaultSkin } from '../../skins/defaultSkin'
import type { C4Object, Group } from '../../types'

/**
 * The engine half of the inline-expansion make-room step: the planner
 * (`expandInline.ts`) predicts each wrapper's box to make room for it, so the
 * box the engine actually draws must be the one predicted — including the outer
 * box of a NESTED expansion, which has to enclose the inner box, not just the
 * inner box's shapes.
 */

function object(id: string, x: number, y: number): C4Object {
  return {
    id, type: 'app', name: id, position: { x, y }, size: { width: 100, height: 60 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  } as C4Object
}

function wrapper(hostId: string, objectIds: string[], over: Partial<Group> = {}): Group {
  return {
    id: `inline-expand:${hostId}`, parentObjectId: hostId, name: hostId, type: 'App', color: '#EFEDE9',
    objectIds, tagAssignments: {}, tagOrder: [], ...over,
  } as Group
}

function mouse(type: string, x: number, y: number): MouseEvent {
  const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y })
  Object.defineProperty(event, 'offsetX', { value: x })
  Object.defineProperty(event, 'offsetY', { value: y })
  return event
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

let contextSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  // Every glyph 1px wide: header text stays far below the box widths here.
  contextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '',
    measureText: (text: string) => ({ width: text.length }),
  } as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  contextSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('CanvasEngine parent-wrapper box', () => {
  it('draws a wrapper exactly where the shared geometry says', () => {
    const outer = wrapper('sys', ['a', 'b'])
    const engine = engineWith([object('a', 0, 0), object('b', 300, 0)], [outer])
    expect(engine.getGroupBoundsById(outer.id)).toEqual(parentWrapperBox(
      [{ x: 0, y: 0, width: 100, height: 60 }, { x: 300, y: 0, width: 100, height: 60 }],
      parentWrapperHeaderBand(outer),
      engine.inlineWrapperMinWidth(outer),
    ))
  })

  it('draws an outer wrapper around the wrappers nested in it, not only their shapes', () => {
    // The outer block holds ONLY the nested one: same shapes in both, so
    // hugging the shapes would draw the two boxes on the same lines (the inner
    // header band poking through the outer border).
    const inner = wrapper('svc', ['c1', 'c2'])
    const outer = wrapper('sys', ['c1', 'c2'], { innerWrapperIds: [inner.id] })
    const engine = engineWith([object('c1', 100, 200), object('c2', 300, 200)], [outer, inner])
    const innerBox = engine.getGroupBoundsById(inner.id)!
    const outerBox = engine.getGroupBoundsById(outer.id)!
    expect(outerBox).toEqual(parentWrapperBox([innerBox], parentWrapperHeaderBand(outer), engine.inlineWrapperMinWidth(outer)))
    expect(outerBox.x).toBeLessThan(innerBox.x)
    expect(outerBox.y).toBeLessThan(innerBox.y)
    expect(outerBox.x + outerBox.width).toBeGreaterThan(innerBox.x + innerBox.width)
    expect(outerBox.y + outerBox.height).toBeGreaterThan(innerBox.y + innerBox.height)
  })

  // QA lens 2026-10-15: the member boxes above are always wider than the header
  // floor, so a box drawn WITHOUT the floor passed. A long name makes it bind.
  it('widens a narrow wrapper to the header floor the planner was told', () => {
    const outer = wrapper('sys', ['a'], { name: 'x'.repeat(300) })
    const engine = engineWith([object('a', 0, 0)], [outer])
    expect(engine.inlineWrapperMinWidth(outer)).toBe(300 + 32)
    expect(engine.getGroupBoundsById(outer.id)!.width).toBe(332)
  })

  // The planner measures BEFORE setData, while the engine may still hold the
  // host shape (with links) from the previous frame; once drawn, it does not.
  it('measures the floor as if the host were already gone', () => {
    const w = wrapper('host', ['a'])
    const host = { ...object('host', 500, 0), links: [{ id: 'l', url: 'https://x' }] } as unknown as C4Object
    const withHost = engineWith([host, object('a', 0, 0)], [w])
    const without = engineWith([object('a', 0, 0)], [w])
    expect(withHost.inlineWrapperMinWidth(w)).toBe(without.inlineWrapperMinWidth(w))
  })

  // The planner sized the room with the measurement of its moment; when the
  // measurement changes, the engine says so and redraws the box to the new one.
  it('redraws a wrapper and tells the caller when the back glyph changes its floor', () => {
    const outer = wrapper('sys', ['a'], { name: '' })
    const changed = vi.fn()
    // A member narrower than the corner-affordance floor, so the floor binds.
    const tiny = { ...object('a', 0, 0), size: { width: 4, height: 4 } }
    const engine = engineWith([tiny], [outer], { onWrapperMetricsChanged: changed })
    const narrow = engine.getGroupBoundsById(outer.id)!.width
    engine.setCanNavigateUp(true)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(engine.getGroupBoundsById(outer.id)!.width).toBe(engine.inlineWrapperMinWidth(outer))
    expect(engine.getGroupBoundsById(outer.id)!.width).toBeGreaterThan(narrow)
    engine.setCanNavigateUp(true)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('tells the caller when web fonts arrive', () => {
    // jsdom has no FontFaceSet; the engine listens on whatever document.fonts is.
    const fonts = new EventTarget()
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true })
    try {
      const changed = vi.fn()
      const engine = engineWith([object('a', 0, 0)], [], { onWrapperMetricsChanged: changed })
      fonts.dispatchEvent(new Event('loadingdone'))
      expect(changed).toHaveBeenCalledTimes(1)
      engine.destroy()
      fonts.dispatchEvent(new Event('loadingdone'))
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      delete (document as unknown as { fonts?: EventTarget }).fonts
    }
  })

  it('tells the caller when the skin changes', () => {
    const changed = vi.fn()
    const engine = engineWith([object('a', 0, 0)], [], { onWrapperMetricsChanged: changed })
    changed.mockClear()
    engine.setSkin(defaultSkin)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  // CanvasView matches a commit to the gesture that started under a given set
  // of cuts (`GestureCutsLatch`): the id must still be there DURING the commit,
  // and a new gesture must get a new one.
  it('names the drag under the pointer, still during its commit, and none at rest', () => {
    const seen: Array<number | null> = []
    let engine: CanvasEngine | null = null
    engine = engineWith([object('a', 0, 0)], [], {
      onPlacementsCommit: () => { seen.push(engine!.activePlacementGesture()) },
    })
    expect(engine.activePlacementGesture()).toBeNull()
    const drag = (from: number, to: number) => {
      const internals = engine as unknown as Record<'onMouseDown' | 'onMouseMove' | 'onMouseUp', (e?: MouseEvent) => void>
      internals.onMouseDown(mouse('mousedown', from, 20))
      internals.onMouseMove(mouse('mousemove', to, 20))
      internals.onMouseUp()
    }
    drag(20, 80)
    drag(80, 140)
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBeNull()
    expect(seen[1]).not.toBeNull()
    expect(seen[1]).not.toBe(seen[0])
    expect(engine.activePlacementGesture()).toBeNull()
  })

  it('ignores a nesting it cannot resolve rather than failing', () => {
    const outer = wrapper('sys', ['a'], { innerWrapperIds: ['inline-expand:gone', 'inline-expand:sys'] })
    const engine = engineWith([object('a', 0, 0)], [outer])
    expect(engine.getGroupBoundsById(outer.id)).toEqual(parentWrapperBox(
      [{ x: 0, y: 0, width: 100, height: 60 }], parentWrapperHeaderBand(outer), engine.inlineWrapperMinWidth(outer),
    ))
  })
})
