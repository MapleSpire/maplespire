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

/**
 * Double-clicking a GROUP's title opens the same inline editor a shape's does.
 *
 * The rule that separates it from the shape case, and the one every test here
 * circles: a group's box is mostly its MEMBERS' space. A double-click in it is
 * an edit only when it landed on painted text — otherwise it has to fall through
 * to whatever is underneath, which is usually a connection routed across the
 * group.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasEngine } from './CanvasEngine'
import type { ObjectTextBand } from './CanvasEngine'
import type { C4Object, Connection, Group } from '../../types'

function object(id: string, x: number, over: Partial<C4Object> = {}): C4Object {
  return {
    id, type: 'app', name: id, position: { x, y: 0 }, size: { width: 200, height: 140 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
    ...over,
  } as C4Object
}

function group(id: string, over: Partial<Group> = {}): Group {
  return {
    id, name: id, objectIds: [], color: '#dddddd',
    position: { x: 0, y: 0 }, size: { width: 400, height: 300 }, autoSize: false,
    tagAssignments: {}, tagOrder: [],
    ...over,
  } as Group
}

/**
 * A measuring context — band resolution needs real-ish text widths. Pass a sink
 * to also record every string handed to `fillText`, which is how suppression is
 * observed: a suppressed run is one the renderer did not draw.
 */
interface Painted { text: string; x: number; y: number }

function context(painted?: Painted[]): CanvasRenderingContext2D {
  const functions = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  return new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'measureText') return (text: string) => ({ width: String(text).length * 6 })
      if (key === 'createLinearGradient') return () => ({ addColorStop: vi.fn() })
      if (key === 'fillText' && painted) {
        return (text: string, x: number, y: number) => { painted.push({ text: String(text), x, y }) }
      }
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

type Opened = { id: string; band: ObjectTextBand }

function engineWith(
  groups: Group[],
  objects: C4Object[] = [],
  connections: Connection[] = [],
  sink: { groups: Opened[]; objects: string[]; connections: string[] } = { groups: [], objects: [], connections: [] },
) {
  const canvas = document.createElement('canvas')
  const engine = new CanvasEngine(canvas, {
    onObjectSelect: () => undefined,
    onPlacementsCommit: () => undefined,
    onObjectDoubleClick: (id) => { sink.objects.push(id) },
    onGroupDoubleClick: (id, band) => { sink.groups.push({ id, band }) },
    onConnectionSelect: () => undefined,
    onConnectionDoubleClick: (id) => { sink.connections.push(id) },
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
  engine.setData(objects, connections, groups)
  return { engine, sink }
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

describe('CanvasEngine group double-click', () => {
  it('records where a standard group painted its title', () => {
    // Recorded by the renderer, never recomputed — so a render must happen
    // first, which is also true in the app: you can only double-click a group
    // you can see.
    const { engine } = engineWith([group('Payments')])
    ;(engine as unknown as Internals).render()

    const bounds = engine.getGroupTextBounds('Payments')
    expect(bounds).not.toBeNull()
    expect(bounds!.title.width).toBeGreaterThan(0)
    // A standard group paints no description; only a parent wrapper does.
    expect(bounds!.description).toBeNull()
  })

  it('opens the title editor on a double-click in the painted band', () => {
    const { engine, sink } = engineWith([group('Payments')])
    ;(engine as unknown as Internals).render()
    const bounds = engine.getGroupTextBounds('Payments')!

    ;(engine as unknown as Internals).onDoubleClick(dbl(bounds.title.x + 4, bounds.title.y + 4))

    expect(sink.groups).toEqual([{ id: 'Payments', band: 'title' }])
  })

  // The rule this whole feature turns on. A group's body is its members' space.
  it('opens NOTHING on a double-click in the group body, away from the title', () => {
    const { engine, sink } = engineWith([group('Payments')])
    ;(engine as unknown as Internals).render()
    const bounds = engine.getGroupTextBounds('Payments')!

    ;(engine as unknown as Internals).onDoubleClick(dbl(bounds.title.x + 4, bounds.title.y + 200))

    expect(sink.groups).toEqual([])
    expect(sink.objects).toEqual([])
  })

  it('lets a connection routed across the group keep its own double-click', () => {
    // The line has to CROSS the group for this to test anything: A sits left of
    // it, B to the right, so the route runs straight through the group's body.
    const objects = [object('A', -400, { position: { x: -400, y: 200 } }), object('B', 600, { position: { x: 600, y: 200 } })]
    const connection: Connection = { id: 'link', fromId: 'A', toId: 'B', type: 'solid' }
    const { engine, sink } = engineWith([group('Payments')], objects, [connection])
    ;(engine as unknown as Internals).render()

    // Aim at a point on the line that is inside the group's box and far from
    // its title, so only the routing decision is under test.
    ;(engine as unknown as Internals).onDoubleClick(dbl(200, 270))

    expect(sink.groups).toEqual([])
    // The point of the test: the connection still gets the gesture.
    expect(sink.connections).toEqual(['link'])
  })

  it('lets a shape drawn over the group win, because shapes render on top', () => {
    const { engine, sink } = engineWith([group('Payments')], [object('A', 0)])
    ;(engine as unknown as Internals).render()
    const bounds = engine.getGroupTextBounds('Payments')!

    // The shape sits at 0,0 with a 200x140 box, which covers the group's title.
    ;(engine as unknown as Internals).onDoubleClick(dbl(bounds.title.x + 4, bounds.title.y + 4))

    expect(sink.objects).toEqual(['A'])
    expect(sink.groups).toEqual([])
  })

  it('gives an unnamed group a band anyway — it is the one that most needs naming', () => {
    const { engine, sink } = engineWith([group('empty', { name: '' })])
    ;(engine as unknown as Internals).render()
    const bounds = engine.getGroupTextBounds('empty')!
    expect(bounds.title.width).toBeGreaterThan(0)

    ;(engine as unknown as Internals).onDoubleClick(dbl(bounds.title.x + 4, bounds.title.y + 4))
    expect(sink.groups).toEqual([{ id: 'empty', band: 'title' }])
  })

  it('keeps recording the rect while the run is suppressed, so the overlay can track it', () => {
    const { engine } = engineWith([group('Payments')])
    ;(engine as unknown as Internals).render()
    const before = engine.getGroupTextBounds('Payments')

    engine.setInlineEditTarget({ kind: 'group', id: 'Payments', band: 'title' })
    ;(engine as unknown as Internals).render()

    expect(engine.getGroupTextBounds('Payments')?.title).toEqual(before?.title)
  })

  // Object ids and group ids come from the same 7-char `generateId()` pool, and
  // a parent wrapper deliberately mirrors its object's name, so an id-only match
  // would blank BOTH runs — the shape's title would vanish behind an editor that
  // is not over it.
  it('suppresses by kind as well as id', () => {
    const painted: Painted[] = []
    contextSpy.mockReturnValue(context(painted))
    const canvas = document.createElement('canvas')
    const { engine } = engineWith([group('same')], [object('same', 0)])
    void canvas

    const drawnTwice = () => {
      painted.length = 0
      ;(engine as unknown as Internals).render()
      return painted.filter((p) => p.text === 'same').length
    }

    // Both the group's label and the shape's title read 'same'.
    expect(drawnTwice()).toBe(2)

    engine.setInlineEditTarget({ kind: 'group', id: 'same', band: 'title' })
    // Only the GROUP's run is suppressed; the shape keeps its title.
    expect(drawnTwice()).toBe(1)

    engine.setInlineEditTarget({ kind: 'object', id: 'same', band: 'title' })
    expect(drawnTwice()).toBe(1)

    engine.setInlineEditTarget(null)
    expect(drawnTwice()).toBe(2)
  })

  it('resolves no band outside the painted rect', () => {
    const { engine } = engineWith([group('Payments')])
    ;(engine as unknown as Internals).render()
    const bounds = engine.getGroupTextBounds('Payments')!

    expect(engine.groupTextBandAt('Payments', bounds.title.x + 4, bounds.title.y + 4)).toBe('title')
    expect(
      engine.groupTextBandAt('Payments', bounds.title.x + bounds.title.width + 40, bounds.title.y + 4),
    ).toBeNull()
    expect(engine.groupTextBandAt('Payments', bounds.title.x + 4, bounds.title.y + 100)).toBeNull()
  })

  it('resolves no band for a group that has never been drawn', () => {
    const { engine } = engineWith([group('Payments')])
    expect(engine.getGroupTextBounds('Payments')).toBeNull()
    expect(engine.groupTextBandAt('Payments', 0, 0)).toBeNull()
  })
})

describe('the low-zoom LOD', () => {
  it('drops the recorded rect, because that frame painted no text', () => {
    const { engine, sink } = engineWith([group('Payments')])
    ;(engine as unknown as Internals).render()
    const bounds = engine.getGroupTextBounds('Payments')!
    expect(bounds).not.toBeNull()

    // Below the LOD threshold the group is drawn as a plain box with no label.
    engine.setZoom(0.2)
    ;(engine as unknown as Internals).render()

    expect(engine.getGroupTextBounds('Payments')).toBeNull()
    // …and the stale rect cannot open a rename over text that is not on screen.
    ;(engine as unknown as Internals).onDoubleClick(dbl(bounds.title.x + 4, bounds.title.y + 4))
    expect(sink.groups).toEqual([])
  })
})

/**
 * Every positional assertion above reads its coordinates back out of the value
 * under test, so displacing the recorded rect keeps them all green while the
 * editor overlay lands somewhere the text is not. These tie the rect to the
 * `fillText` call that painted it, and to the group's box.
 */
describe('the recorded rect agrees with what was painted', () => {
  const paintOf = (painted: Painted[], text: string) => painted.find((p) => p.text === text)!

  it('brackets the draw point of the standard label', () => {
    const painted: Painted[] = []
    contextSpy.mockReturnValue(context(painted))
    const { engine } = engineWith([group('Payments')])
    ;(engine as unknown as Internals).render()

    const rect = engine.getGroupTextBounds('Payments')!.title
    const draw = paintOf(painted, 'Payments')
    // Drawn left-aligned from the rect's left edge…
    expect(Math.abs(rect.x - draw.x)).toBeLessThan(1)
    // …and on a 'middle' baseline inside the rect's vertical span.
    expect(draw.y).toBeGreaterThanOrEqual(rect.y)
    expect(draw.y).toBeLessThanOrEqual(rect.y + rect.height)
  })

  it('keeps the standard band inside the group box and its header row', () => {
    const { engine } = engineWith([group('Payments')])
    ;(engine as unknown as Internals).render()
    const rect = engine.getGroupTextBounds('Payments')!.title

    // The group is (0,0) 400x300 with a 32px reserved header row.
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(400)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.y + rect.height).toBeLessThanOrEqual(32)
  })

  it('never widens the band to the whole header row', () => {
    // 'Payments' measures 48 in this fixture; the band adds slack for the
    // textarea's own font, and no more. A band spanning the box would turn a
    // double-click anywhere along the header into a rename.
    const { engine } = engineWith([group('Payments')])
    ;(engine as unknown as Internals).render()
    const rect = engine.getGroupTextBounds('Payments')!.title
    expect(rect.width).toBeLessThan(120)
    expect(rect.width).toBeGreaterThanOrEqual(60)
  })

  it('keeps the band a single line tall', () => {
    const { engine } = engineWith([group('Payments')])
    ;(engine as unknown as Internals).render()
    const rect = engine.getGroupTextBounds('Payments')!.title
    expect(rect.height).toBeLessThanOrEqual(rect.lineHeight)
    expect(rect.height).toBeGreaterThan(0)
  })

  it('clamps the band to a group too narrow to hold the floor width', () => {
    const { engine } = engineWith([group('N', { size: { width: 40, height: 200 } })])
    ;(engine as unknown as Internals).render()
    const rect = engine.getGroupTextBounds('N')!.title
    expect(rect.x + rect.width).toBeLessThanOrEqual(40)
  })
})

/**
 * `hitTestGroup` picks ONE winner by box — the last group in paint order whose
 * rectangle contains the point. Wrapping an existing group in a bigger one is
 * ordinary authoring, and it makes the outer group that winner, so asking only
 * it for a band left the inner group's plainly-painted title unclickable.
 */
describe('overlapping groups', () => {
  const inner = () => group('Inner', { position: { x: 100, y: 100 }, size: { width: 200, height: 150 } })
  const outer = () => group('Outer', { position: { x: 0, y: 0 }, size: { width: 600, height: 500 } })

  it('opens the INNER group when its title is the one under the cursor', () => {
    // Outer is created last, so it wins `hitTestGroup` at every point.
    const { engine, sink } = engineWith([inner(), outer()])
    ;(engine as unknown as Internals).render()
    const rect = engine.getGroupTextBounds('Inner')!.title

    ;(engine as unknown as Internals).onDoubleClick(dbl(rect.x + 4, rect.y + 4))

    expect(sink.groups).toEqual([{ id: 'Inner', band: 'title' }])
  })

  it('still opens the OUTER group on its own title', () => {
    const { engine, sink } = engineWith([inner(), outer()])
    ;(engine as unknown as Internals).render()
    const rect = engine.getGroupTextBounds('Outer')!.title

    ;(engine as unknown as Internals).onDoubleClick(dbl(rect.x + 4, rect.y + 4))

    expect(sink.groups).toEqual([{ id: 'Outer', band: 'title' }])
  })

  it('opens nothing where the two overlap away from both titles', () => {
    const { engine, sink } = engineWith([inner(), outer()])
    ;(engine as unknown as Internals).render()

    ;(engine as unknown as Internals).onDoubleClick(dbl(200, 200))

    expect(sink.groups).toEqual([])
  })
})

/** The expanded form of an object: a centred header stack, not a label row. */
describe('a parent wrapper', () => {
  const wrapper = (over: Partial<Group> = {}) => group('W', {
    parentObjectId: 'o1', name: 'Billing', type: 'App', description: 'Takes money',
    size: { width: 720, height: 480 }, ...over,
  })

  it('records both of its bands', () => {
    const { engine } = engineWith([wrapper()])
    ;(engine as unknown as Internals).render()
    const bounds = engine.getGroupTextBounds('W')!

    expect(bounds.title.width).toBeGreaterThan(0)
    expect(bounds.description).not.toBeNull()
    // The description sits BELOW the title in the stack.
    expect(bounds.description!.y).toBeGreaterThan(bounds.title.y)
  })

  it('resolves the description band separately from the title', () => {
    const { engine, sink } = engineWith([wrapper()])
    ;(engine as unknown as Internals).render()
    const bounds = engine.getGroupTextBounds('W')!

    ;(engine as unknown as Internals).onDoubleClick(dbl(bounds.description!.x + 4, bounds.description!.y + 2))
    expect(sink.groups).toEqual([{ id: 'W', band: 'description' }])
  })

  it('resolves the title band on the title', () => {
    const { engine, sink } = engineWith([wrapper()])
    ;(engine as unknown as Internals).render()
    const bounds = engine.getGroupTextBounds('W')!

    ;(engine as unknown as Internals).onDoubleClick(dbl(bounds.title.x + 4, bounds.title.y + 2))
    expect(sink.groups).toEqual([{ id: 'W', band: 'title' }])
  })

  it('suppresses each run independently', () => {
    const painted: Painted[] = []
    contextSpy.mockReturnValue(context(painted))
    const { engine } = engineWith([wrapper()])
    const drawn = () => {
      painted.length = 0
      ;(engine as unknown as Internals).render()
      return painted.map((p) => p.text)
    }

    expect(drawn()).toContain('Billing')
    expect(drawn()).toContain('Takes money')

    engine.setInlineEditTarget({ kind: 'group', id: 'W', band: 'title' })
    expect(drawn()).not.toContain('Billing')
    expect(drawn()).toContain('Takes money')

    engine.setInlineEditTarget({ kind: 'group', id: 'W', band: 'description' })
    expect(drawn()).toContain('Billing')
    expect(drawn()).not.toContain('Takes money')
  })

  // The header stack reserves height only for the lines it has, so a band for
  // an absent title would land on the type line.
  it('records no title band when there is no title to paint', () => {
    const { engine, sink } = engineWith([wrapper({ name: '' })])
    ;(engine as unknown as Internals).render()
    const bounds = engine.getGroupTextBounds('W')!

    expect(bounds.title.width).toBe(0)
    // Its description is still reachable.
    expect(bounds.description).not.toBeNull()
    ;(engine as unknown as Internals).onDoubleClick(dbl(bounds.description!.x + 4, bounds.description!.y + 2))
    expect(sink.groups).toEqual([{ id: 'W', band: 'description' }])
  })

  // The bands must be rebuilt each frame, not amended in the map: amending
  // would let a wrapper that LOST its name keep the previous frame's title
  // rect with this frame's description merged into it.
  it('drops the title band when the name goes away', () => {
    const { engine, sink } = engineWith([wrapper()])
    ;(engine as unknown as Internals).render()
    expect(engine.getGroupTextBounds('W')!.title.width).toBeGreaterThan(0)

    engine.setData([], [], [wrapper({ name: '' })])
    ;(engine as unknown as Internals).render()
    const after = engine.getGroupTextBounds('W')!

    expect(after.title.width).toBe(0)
    ;(engine as unknown as Internals).onDoubleClick(dbl(after.description!.x + 4, after.description!.y - 20))
    expect(sink.groups).toEqual([])
  })
})

describe('bounds do not outlive their entity', () => {
  it('forgets a group that is no longer in the data', () => {
    const { engine } = engineWith([group('Payments')])
    ;(engine as unknown as Internals).render()
    expect(engine.getGroupTextBounds('Payments')).not.toBeNull()

    engine.setData([], [], [])

    expect(engine.getGroupTextBounds('Payments')).toBeNull()
  })

  it('forgets a shape that is no longer in the data', () => {
    const { engine } = engineWith([], [object('A', 0)])
    ;(engine as unknown as Internals).render()
    expect(engine.getObjectTextBounds('A')).not.toBeNull()

    engine.setData([], [], [])

    expect(engine.getObjectTextBounds('A')).toBeNull()
  })

  it('keeps the rect of an entity that is still there', () => {
    const { engine } = engineWith([group('Payments')])
    ;(engine as unknown as Internals).render()
    const before = engine.getGroupTextBounds('Payments')

    engine.setData([], [], [group('Payments')])

    expect(engine.getGroupTextBounds('Payments')).toEqual(before)
  })
})

/**
 * The two bands' 4px tolerances overlap where the gap between the lines is
 * smaller than twice the padding — `HDR_GAP_DESC` is 6, so with no type line
 * between them there is a 2px strip claimed by both. `groupTextBandAt` checks
 * the description FIRST so that strip resolves downwards; checking the title
 * first would let it swallow the description's top edge.
 */
describe('where the wrapper bands touch', () => {
  const tight = () => group('W', {
    parentObjectId: 'o1', name: 'Billing', description: 'Takes money',
    size: { width: 720, height: 480 },
  })

  it('gives the shared strip to the description, not the title', () => {
    const { engine } = engineWith([tight()])
    ;(engine as unknown as Internals).render()
    const bounds = engine.getGroupTextBounds('W')!
    const titleBottom = bounds.title.y + bounds.title.height
    const gap = bounds.description!.y - titleBottom
    // Guard the premise: if the layout ever separates the lines by more than
    // the two paddings, this test stops proving anything and should be revised.
    expect(gap).toBeLessThan(8)

    // A y inside BOTH padded bands: below the title's rect but within its 4px
    // tolerance, and above the description's rect but within its own.
    const shared = titleBottom + 3
    expect(shared).toBeLessThanOrEqual(titleBottom + 4)
    expect(shared).toBeGreaterThanOrEqual(bounds.description!.y - 4)
    expect(engine.groupTextBandAt('W', bounds.description!.x + 4, shared)).toBe('description')
  })
})
