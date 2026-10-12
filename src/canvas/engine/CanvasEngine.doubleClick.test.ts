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
import type { ObjectTextBand } from './CanvasEngine'
import type { C4Object, Connection } from '../../types'

/**
 * Double-click opens an editor, so it is gated the way editing is. Every guard
 * below exists because the gesture would otherwise fire in a state where the
 * user is doing something else entirely.
 */

function object(id: string, x: number, over: Partial<C4Object> = {}): C4Object {
  return {
    id,
    type: 'app',
    name: id,
    position: { x, y: 0 },
    size: { width: 200, height: 140 },
    tagAssignments: {},
    tagOrder: [],
    scope: 'internal',
    status: 'live',
    properties: {},
    ...over,
  } as C4Object
}

/** A measuring context — band resolution needs real-ish text widths. */
function context(): CanvasRenderingContext2D {
  const functions = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  return new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'measureText') return (text: string) => ({ width: String(text).length * 6 })
      if (key === 'createLinearGradient') return () => ({ addColorStop: vi.fn() })
      let fn = functions.get(key)
      if (!fn) { fn = vi.fn(); functions.set(key, fn) }
      return fn
    },
    set() { return true },
  })
}

function dbl(x: number, y: number): MouseEvent {
  const event = new MouseEvent('dblclick', { button: 0, clientX: x, clientY: y })
  Object.defineProperty(event, 'offsetX', { value: x })
  Object.defineProperty(event, 'offsetY', { value: y })
  return event
}

interface Internals {
  onDoubleClick: (event: MouseEvent) => void
  render: () => void
}

type Opened = { id: string; band: ObjectTextBand | null }

function engineWith(objects: C4Object[], connections: Connection[], opened: Opened[], labels: string[] = []) {
  const canvas = document.createElement('canvas')
  const engine = new CanvasEngine(canvas, {
    onObjectSelect: () => undefined,
    onPlacementsCommit: () => undefined,
    onObjectDoubleClick: (id, band) => { opened.push({ id, band }) },
    onGroupDoubleClick: () => undefined,
    onConnectionSelect: () => undefined,
    onConnectionDoubleClick: (id) => { labels.push(id) },
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
    onCopyApply: () => true,
    onExpandClick: () => undefined,
  })
  engine.setData(objects, connections)
  return engine
}

let contextSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  contextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context())
})

afterEach(() => {
  contextSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('CanvasEngine double-click', () => {
  it('opens an editor on the shape under the cursor', () => {
    const opened: Opened[] = []
    const engine = engineWith([object('A', 0)], [], opened)

    ;(engine as unknown as Internals).onDoubleClick(dbl(20, 20))

    expect(opened).toEqual([{ id: 'A', band: null }])
  })

  it('resolves the TITLE band from what was actually painted', () => {
    // Bounds are recorded by the renderer, so a render must happen first —
    // which is also true in the app, where you can only double-click a shape
    // you can see.
    const opened: Opened[] = []
    const engine = engineWith([object('A', 0)], [], opened)
    ;(engine as unknown as Internals).render()

    const bounds = engine.getObjectTextBounds('A')
    expect(bounds).not.toBeNull()

    ;(engine as unknown as Internals).onDoubleClick(dbl(bounds!.title.x + 5, bounds!.title.y + 2))

    expect(opened).toEqual([{ id: 'A', band: 'title' }])
  })

  it('resolves the DESCRIPTION band separately from the title', () => {
    const opened: Opened[] = []
    const engine = engineWith([object('A', 0, { shortDescription: 'Some description text' })], [], opened)
    ;(engine as unknown as Internals).render()

    const bounds = engine.getObjectTextBounds('A')
    expect(bounds?.description).not.toBeNull()

    ;(engine as unknown as Internals).onDoubleClick(dbl(bounds!.description!.x + 5, bounds!.description!.y + 2))

    expect(opened).toEqual([{ id: 'A', band: 'description' }])
  })

  it('offers the description slot even when the shape has none yet', () => {
    // Adding a description is the commonest reason to double-click there.
    // Without a synthesized band the click resolves to the title, and a
    // description could only ever be added from the sidebar.
    const opened: Opened[] = []
    const engine = engineWith([object('A', 0)], [], opened)
    ;(engine as unknown as Internals).render()

    const bounds = engine.getObjectTextBounds('A')
    expect(bounds?.description).not.toBeNull()

    ;(engine as unknown as Internals).onDoubleClick(dbl(bounds!.description!.x + 5, bounds!.description!.y + 2))

    expect(opened).toEqual([{ id: 'A', band: 'description' }])
  })

  it('READONLY: opens nothing', () => {
    const opened: Opened[] = []
    const engine = engineWith([object('A', 0)], [], opened)
    engine.setReadonly(true)

    ;(engine as unknown as Internals).onDoubleClick(dbl(20, 20))

    expect(opened).toEqual([])
  })

  it('COPY MODE armed: opens nothing', () => {
    // Copy mode consumes click 1 and disarms, so click 2 arrives here as an
    // ordinary double-click the user never intended.
    const opened: Opened[] = []
    const engine = engineWith([object('A', 0)], [], opened)
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onDoubleClick(dbl(20, 20))

    expect(opened).toEqual([])
  })

  it('HIDDEN shape: opens nothing, and the control proves the click would otherwise land', () => {
    const tagged = { tagAssignments: { t1: { tagId: 't1' } }, tagOrder: ['t1'] } as unknown as Partial<C4Object>
    const opened: Opened[] = []
    const engine = engineWith([object('H', 0, tagged)], [], opened)
    engine.setBottomTab('tags')
    engine.setTagInteractions(null, [], null, ['t1'])

    ;(engine as unknown as Internals).onDoubleClick(dbl(20, 20))
    expect(opened).toEqual([])

    engine.setTagInteractions(null, [], null, [])
    ;(engine as unknown as Internals).onDoubleClick(dbl(20, 20))
    expect(opened).toEqual([{ id: 'H', band: null }])
  })

  it('A SHAPE WINS over a connection routed across it', () => {
    // hitTestConnection uses a tolerance band regardless of what is painted on
    // top, so dblclick must test shapes FIRST, like mousedown and the context
    // menu. Otherwise a shape with a line near its title is unreachable: the
    // user aims at the title and gets the label editor.
    const opened: Opened[] = []
    const labels: string[] = []
    const engine = engineWith(
      [object('A', 0), object('B', 600)],
      [{ id: 'c1', fromId: 'A', toId: 'B', type: 'solid' } as Connection],
      opened, labels,
    )

    ;(engine as unknown as Internals).onDoubleClick(dbl(100, 70))

    expect(opened).toEqual([{ id: 'A', band: null }])
    expect(labels).toEqual([])
  })

  it('a connection NOT under a shape still opens its label editor', () => {
    const opened: Opened[] = []
    const labels: string[] = []
    const engine = engineWith(
      [object('A', 0), object('B', 600)],
      [{ id: 'c1', fromId: 'A', toId: 'B', type: 'solid' } as Connection],
      opened, labels,
    )

    ;(engine as unknown as Internals).onDoubleClick(dbl(400, 70))

    expect(labels).toEqual(['c1'])
    expect(opened).toEqual([])
  })

  it('suppressing a run removes it from the recorded paint but keeps the rect', () => {
    // The editor sits on top of the text it replaces; without suppression the
    // stale, fitted, possibly differently-sized string shows around its edges.
    const engine = engineWith([object('A', 0, { shortDescription: 'Desc' })], [], [])
    ;(engine as unknown as Internals).render()
    const before = engine.getObjectTextBounds('A')

    engine.setInlineEditTarget({ kind: 'object', id: 'A', band: 'title' })
    ;(engine as unknown as Internals).render()

    // The rect must survive so the overlay can keep tracking it.
    expect(engine.getObjectTextBounds('A')?.title).toEqual(before?.title)
  })
})
