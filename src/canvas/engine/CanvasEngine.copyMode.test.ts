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
import type { CopyTarget } from './CanvasEngine'
import type { C4Object, Group } from '../../types'

/**
 * The half of Copy style/size that lives in the ENGINE rather than in
 * `copyStyle.ts`: which shape a paste lands on, and whether the cursor
 * disarms. `copyStyle.test.ts` covers what gets written; none of that is
 * reachable if the engine hands over the wrong target or drops the payload.
 */

function object(id: string, x: number, over: Partial<C4Object> = {}): C4Object {
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
    ...over,
  } as C4Object
}

function down(x: number, y: number, shiftKey = false): MouseEvent {
  const event = new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, shiftKey })
  Object.defineProperty(event, 'offsetX', { value: x })
  Object.defineProperty(event, 'offsetY', { value: y })
  return event
}

function move(x: number, y: number): MouseEvent {
  const event = new MouseEvent('mousemove', { button: 0, clientX: x, clientY: y })
  Object.defineProperty(event, 'offsetX', { value: x })
  Object.defineProperty(event, 'offsetY', { value: y })
  return event
}

interface Internals {
  onMouseDown: (event: MouseEvent) => void
}

type Applied = CopyTarget

function engineWith(
  objects: C4Object[],
  groups: Group[],
  onCopyApply: (targets: readonly CopyTarget[]) => boolean | void,
) {
  const canvas = document.createElement('canvas')
  const engine = new CanvasEngine(canvas, {
    onObjectSelect: () => undefined,
    onPlacementsCommit: () => undefined,
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
    onCopyApply: (targets) => onCopyApply(targets),
    onExpandClick: () => undefined,
  })
  engine.setData(objects, [], groups)
  return engine
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

describe('CanvasEngine copy mode', () => {
  it('applies to the shape under the cursor and then disarms', () => {
    const applied: Applied[] = []
    const engine = engineWith([object('A', 0)], [], (targets) => { applied.push(...targets); return true })
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onMouseDown(down(10, 10))

    expect(applied).toEqual([{ id: 'A', type: 'object' }])
    expect(engine.getCopyMode().mode).toBeNull()
  })

  it('SHIFT chains: stays armed so the next shape can take the same style', () => {
    // Stamp a style onto shape after shape without re-opening the menu each
    // time. Without this the mode disarms on the first paste and the whole
    // right-click → Copy style dance repeats per shape.
    const applied: Applied[] = []
    const engine = engineWith([object('A', 0), object('B', 400)], [], (targets) => {
      applied.push(...targets)
      return true
    })
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onMouseDown(down(10, 10, true))
    expect(engine.getCopyMode().mode).toBe('style')

    ;(engine as unknown as Internals).onMouseDown(down(410, 10, true))
    expect(applied).toEqual([{ id: 'A', type: 'object' }, { id: 'B', type: 'object' }])
    expect(engine.getCopyMode().mode).toBe('style')

    // Releasing Shift ends the chain — an exit that does not require having
    // noticed the modifier in the first place.
    ;(engine as unknown as Internals).onMouseDown(down(10, 10, false))
    expect(engine.getCopyMode().mode).toBeNull()
  })

  it('keeps the copied PAYLOAD across a chained paste', () => {
    // Re-arming per shape would be pointless if the data were dropped.
    const engine = engineWith([object('A', 0), object('B', 400)], [], () => true)
    engine.setCopyMode('style', { kind: 'object', icon: 'Redis' })

    ;(engine as unknown as Internals).onMouseDown(down(10, 10, true))

    expect(engine.getCopyMode().data).toEqual({ kind: 'object', icon: 'Redis' })
  })

  it('Shift on EMPTY space still cancels, so there is always a way out', () => {
    const engine = engineWith([object('A', 0)], [], () => true)
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onMouseDown(down(900, 900, true))

    expect(engine.getCopyMode().mode).toBeNull()
  })

  it('STAYS ARMED when the target refuses the paste', () => {
    // A refusal (a parent wrapper) must not look like a successful paste.
    // Disarming on a write that never happened is exactly the "the command did
    // nothing" symptom this feature was reported for.
    const engine = engineWith([object('A', 0)], [], () => false)
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onMouseDown(down(10, 10))

    expect(engine.getCopyMode().mode).toBe('style')
  })

  it('disarms on a callback that returns nothing, so a plain handler still works', () => {
    // `boolean | void`: only an explicit `false` refuses. This pins that the
    // widening did not turn every existing void handler into a refusal.
    const engine = engineWith([object('A', 0)], [], () => undefined)
    engine.setCopyMode('size', { width: 1, height: 1 })

    ;(engine as unknown as Internals).onMouseDown(down(10, 10))

    expect(engine.getCopyMode().mode).toBeNull()
  })

  it('cancels when the click lands on empty space', () => {
    const applied: Applied[] = []
    const engine = engineWith([object('A', 0)], [], (targets) => { applied.push(...targets); return true })
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onMouseDown(down(900, 900))

    expect(applied).toEqual([])
    expect(engine.getCopyMode().mode).toBeNull()
  })

  it('never pastes onto a shape hidden by a perspective', () => {
    // A hidden shape is not drawn, so pasting onto it writes a change the user
    // cannot see, onto a shape they did not know was there. `hitTest` has no
    // visibility filter of its own — copy mode asks for one.
    //
    // Asserting on `getCopyMode()` alone would be a TAUTOLOGY here: a hit
    // clears the mode via a successful apply, and a miss clears it as an
    // empty-space click. Both end at null. The observable difference is whether
    // the callback fired at all — hence the control below.
    const tagged = { tagAssignments: { t1: { tagId: 't1' } }, tagOrder: ['t1'] } as unknown as Partial<C4Object>
    const applied: Applied[] = []
    const engine = engineWith([object('H', 0, tagged)], [], (targets) => { applied.push(...targets); return true })
    engine.setBottomTab('tags')
    engine.setTagInteractions(null, [], null, ['t1'])   // hide everything carrying t1
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onMouseDown(down(10, 10))

    expect(applied).toEqual([])
    expect(engine.getCopyMode().mode).toBeNull()   // cancelled as if empty space
  })

  it('CONTROL: the same click DOES paste once the shape is not hidden', () => {
    // Without this, the test above passes even if `setTagInteractions` hid
    // nothing and the click simply missed the shape.
    const tagged = { tagAssignments: { t1: { tagId: 't1' } }, tagOrder: ['t1'] } as unknown as Partial<C4Object>
    const applied: Applied[] = []
    const engine = engineWith([object('H', 0, tagged)], [], (targets) => { applied.push(...targets); return true })
    engine.setBottomTab('tags')
    engine.setTagInteractions(null, [], null, [])     // nothing hidden
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onMouseDown(down(10, 10))

    expect(applied).toEqual([{ id: 'H', type: 'object' }])
  })

  it('applies to the WHOLE selection when the click lands inside it', () => {
    // F8. Select N, arm the copy from a source, click any selected shape.
    const applied: Applied[] = []
    const engine = engineWith(
      [object('A', 0), object('B', 400), object('C', 800)], [],
      (targets) => { applied.push(...targets); return true },
    )
    engine.setSelectedItems([{ id: 'A', type: 'object' }, { id: 'C', type: 'object' }])
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onMouseDown(down(10, 10))   // click A, which IS selected

    expect(applied).toEqual([{ id: 'A', type: 'object' }, { id: 'C', type: 'object' }])
  })

  it('applies to ONE shape when the click lands outside the selection', () => {
    // The counterpart, and the reason membership is tested rather than the
    // count: a click must never be redirected onto shapes the user is not
    // pointing at. Same rule that stopped right-click deleting the wrong shapes.
    const applied: Applied[] = []
    const engine = engineWith(
      [object('A', 0), object('B', 400), object('C', 800)], [],
      (targets) => { applied.push(...targets); return true },
    )
    engine.setSelectedItems([{ id: 'A', type: 'object' }, { id: 'C', type: 'object' }])
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onMouseDown(down(410, 10))  // click B, NOT selected

    expect(applied).toEqual([{ id: 'B', type: 'object' }])
  })

  it('carries selected GROUPS as well as objects', () => {
    // Unlike the multi-selection context menu, which counts objects only
    // because it is an object-shape menu, a style applies to both kinds.
    const g: Group = {
      id: 'g1', name: 'G', color: '#fff', objectIds: [],
      position: { x: 900, y: 300 }, size: { width: 200, height: 120 },
      tagAssignments: {}, tagOrder: [],
    }
    const applied: Applied[] = []
    const engine = engineWith([object('A', 0)], [g], (targets) => { applied.push(...targets); return true })
    engine.setSelectedItems([{ id: 'A', type: 'object' }, { id: 'g1', type: 'group' }])
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onMouseDown(down(10, 10))

    expect(applied).toEqual([{ id: 'A', type: 'object' }, { id: 'g1', type: 'group' }])
  })

  it('THE BUG: a hidden shape inside the selection is NOT restyled', () => {
    // Expanding the selection without the visibility filter the HIT uses
    // would show "→ 2 shapes" while the user sees one, and rewrite the
    // invisible one anyway — in an app with no undo, and in direct
    // contradiction of the rule the function states for the hit.
    //
    // Reachable two ways: the selection hit test has no `skipHidden`, so a
    // hidden shape can be selected by clicking where it used to be; and hiding
    // a tag AFTER selecting prunes nothing.
    const tagged = { tagAssignments: { t1: { tagId: 't1' } }, tagOrder: ['t1'] } as unknown as Partial<C4Object>
    const applied: Applied[] = []
    const engine = engineWith(
      [object('VISIBLE', 0), object('HIDDEN', 400, tagged)], [],
      (targets) => { applied.push(...targets); return true },
    )
    engine.setSelectedItems([{ id: 'VISIBLE', type: 'object' }, { id: 'HIDDEN', type: 'object' }])
    engine.setBottomTab('tags')
    engine.setTagInteractions(null, [], null, ['t1'])
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onMouseDown(down(10, 10))   // click the VISIBLE one

    expect(applied).toEqual([{ id: 'VISIBLE', type: 'object' }])
  })

  it('a parent wrapper in the selection is skipped, so the count is honest', () => {
    // A wrapper refuses both commands. Dropping it here rather than letting the
    // apply refuse it keeps the tooltip's promise equal to what happens. A
    // DIRECT click on a wrapper still reaches the apply and still refuses —
    // that is what leaves the cursor armed, and it means something different.
    const wrapper: Group = {
      id: 'w1', name: 'W', color: '#fff', objectIds: [], parentObjectId: 'X',
      position: { x: 900, y: 300 }, size: { width: 200, height: 120 },
      tagAssignments: {}, tagOrder: [],
    }
    const applied: Applied[] = []
    const engine = engineWith(
      [object('A', 0), object('B', 400)], [wrapper],
      (targets) => { applied.push(...targets); return true },
    )
    engine.setSelectedItems([
      { id: 'A', type: 'object' }, { id: 'B', type: 'object' }, { id: 'w1', type: 'group' },
    ])
    engine.setCopyMode('style', { kind: 'object' })
    ;(engine as unknown as { onMouseMove: (e: MouseEvent) => void }).onMouseMove(move(10, 10))

    expect((engine as unknown as { copyTargetCount: number }).copyTargetCount).toBe(2)

    ;(engine as unknown as Internals).onMouseDown(down(10, 10))

    expect(applied).toEqual([{ id: 'A', type: 'object' }, { id: 'B', type: 'object' }])
  })

  it('membership is matched on KIND as well as id', () => {
    // Not hypothetical: `generateId()` is
    // `Math.random().toString(36).substring(2, 9)` — a 7-character id drawn
    // from ONE space shared by objects, groups and connections. Two entities
    // of different kinds can therefore carry the same id (by collision, or by
    // an import that reuses ids). Matching on id alone would let a selected
    // GROUP make an unselected OBJECT look "inside the selection" and swallow
    // a click meant for that one shape.
    const g: Group = {
      id: 'dup', name: 'G', color: '#fff', objectIds: [],
      position: { x: 900, y: 300 }, size: { width: 200, height: 120 },
      tagAssignments: {}, tagOrder: [],
    }
    const applied: Applied[] = []
    const engine = engineWith([object('dup', 0), object('B', 400)], [g], (targets) => { applied.push(...targets); return true })
    // Two GROUPS-and-objects selected, but NOT the object named 'dup'.
    engine.setSelectedItems([{ id: 'dup', type: 'group' }, { id: 'B', type: 'object' }])
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onMouseDown(down(10, 10))   // click the OBJECT 'dup'

    expect(applied).toEqual([{ id: 'dup', type: 'object' }])
  })

  it('a single-shape selection stays single, even clicking that very shape', () => {
    const applied: Applied[] = []
    const engine = engineWith([object('A', 0)], [], (targets) => { applied.push(...targets); return true })
    engine.setSelectedItems([{ id: 'A', type: 'object' }])
    engine.setCopyMode('style', { kind: 'object' })

    ;(engine as unknown as Internals).onMouseDown(down(10, 10))

    expect(applied).toEqual([{ id: 'A', type: 'object' }])
  })

  it('the tooltip count does not survive into the next arming', () => {
    // Arm over a multi-selection, hover it (count becomes 2), paste, then arm
    // again with nothing selected. Until the mouse first moves, the tooltip
    // would otherwise still promise the OLD count — a bulk-mutation warning
    // that no longer matches what the click will do.
    const engine = engineWith([object('A', 0), object('B', 400)], [], () => true)
    engine.setSelectedItems([{ id: 'A', type: 'object' }, { id: 'B', type: 'object' }])
    engine.setCopyMode('style', { kind: 'object' })
    ;(engine as unknown as { onMouseMove: (e: MouseEvent) => void }).onMouseMove(move(10, 10))

    expect((engine as unknown as { copyTargetCount: number }).copyTargetCount).toBe(2)

    engine.setSelectedItems([])
    engine.setCopyMode('style', { kind: 'object' })

    expect((engine as unknown as { copyTargetCount: number }).copyTargetCount).toBe(0)
  })

  it('getGroupBoundsById resolves from the ENGINE copy, not a caller-supplied group', () => {
    // The guard against shapes teleporting: callers outside the engine
    // hold the STORE's group, whose position/size are create-time values. This
    // accessor exists so they cannot compute bounds from it (which would also
    // poison the engine's bounds cache under that id).
    const engineGroup: Group = {
      id: 'g1', name: 'G', color: '#fff', objectIds: [],
      position: { x: 900, y: 560 }, size: { width: 300, height: 200 },
      tagAssignments: {}, tagOrder: [],
    }
    const engine = engineWith([], [engineGroup], () => true)

    expect(engine.getGroupBoundsById('g1')).toMatchObject({ x: 900, y: 560 })
    expect(engine.getGroupBoundsById('nope')).toBeNull()
  })
})
