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
import type { C4Object, Connection, Diagram, Group } from '../../types'
import { composeDiffs, deepEqual, diffModel, isContinuation, subtractKeys, type DiffableState } from './modelDiff'
import { executePlan, planApply, type ApplyDraft } from './applyDiff'

const obj = (id: string, extra: Partial<C4Object> = {}): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 10, height: 10 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...extra,
}) as C4Object
const p = (x: number) => ({ position: { x, y: 0 }, size: { width: 10, height: 10 } })

function state(over: Partial<DiffableState> = {}): DiffableState {
  return {
    objects: [obj('A'), obj('B')],
    connections: [{ id: 'c', fromId: 'A', toId: 'B', type: 'solid' } as Connection],
    groups: [{ id: 'g', name: 'g', color: '#000', objectIds: ['A'], tagAssignments: {}, tagOrder: [] } as Group],
    diagrams: [{ id: 'd', name: 'd', type: 'context', objectIds: ['A', 'B'], connectionIds: ['c'], groupIds: ['g'], layouts: { A: p(0), B: p(100) } } as Diagram],
    ...over,
  }
}

describe('diffModel', () => {
  it('is empty for the same state', () => {
    const s = state()
    expect(diffModel(s, s).size).toBe(0)
    expect(diffModel(s, { ...s, objects: [...s.objects] }).size).toBe(0)
  })

  it('keys changes by id, not by index — a removal earlier in the list shifts nothing', () => {
    const before = state()
    const after = state({ objects: [{ ...before.objects[1], name: 'B2' }] }) // A removed, B renamed
    const diff = diffModel(before, after)
    expect([...diff.keys()].sort()).toEqual(['o:A', 'o:B'])
    const b = diff.get('o:B')
    expect(b?.type === 'entity' && b.after && (b.after as C4Object).name).toBe('B2')
  })

  it('never records derived lower connections, in the list or in a diagram', () => {
    const before = state()
    const lower = { id: 'low', fromId: 'A', toId: 'B', type: 'solid', kind: 'lower' } as Connection
    const after = state({
      connections: [...before.connections, lower],
      diagrams: [{ ...before.diagrams[0], connectionIds: ['c', 'low'] }],
    })
    expect(diffModel(before, after).size).toBe(0)
  })

  it('the fork of the 2D layout into the 3D layer is not a change; a 3D move is', () => {
    const before = state()
    const d = before.diagrams[0]
    const forked = { ...d, layouts3d: { A: p(0), B: p(100) } }
    expect(diffModel(before, state({ diagrams: [forked] })).size).toBe(0)
    const moved = { ...d, layouts3d: { A: p(500), B: p(100) } }
    const diff = diffModel(before, state({ diagrams: [moved] }))
    expect([...diff.keys()]).toEqual(['l:d:3d:A'])
  })

  it('connection 3D routing stamped from 2D by the fork is not a change', () => {
    const c = { id: 'c', fromId: 'A', toId: 'B', type: 'solid', waypoints: [{ x: 1, y: 1 }], shape: 'curved' } as Connection
    const before = state({ connections: [c] })
    const stamped = { ...c, waypoints3d: [{ x: 1, y: 1 }], shape3d: 'curved' as const }
    expect(diffModel(before, state({ connections: [stamped] })).size).toBe(0)
  })

  it('records group and diagram membership as per-id sets', () => {
    const before = state()
    const after = state({
      groups: [{ ...before.groups[0], objectIds: ['B'] }],
      diagrams: [{ ...before.diagrams[0], objectIds: ['B'] }],
    })
    expect([...diffModel(before, after).keys()].sort()).toEqual(['gm:g:A', 'gm:g:B', 'm:d:objectIds:A'])
  })
})

describe('composeDiffs', () => {
  it('collapses a drag back to the start into nothing', () => {
    const a = state()
    const b = state({ diagrams: [{ ...a.diagrams[0], layouts: { ...a.diagrams[0].layouts, A: p(50) } }] })
    const c = state({ diagrams: [{ ...a.diagrams[0], layouts: { ...a.diagrams[0].layouts, A: p(0) } }] })
    expect(composeDiffs(diffModel(a, b), diffModel(b, c)).size).toBe(0)
  })

  it('keeps the first before and the last after', () => {
    const a = state()
    const b = state({ objects: [obj('A', { name: 'one' }), obj('B')] })
    const c = state({ objects: [obj('A', { name: 'two' }), obj('B')] })
    const change = composeDiffs(diffModel(a, b), diffModel(b, c)).get('o:A')
    expect(change?.type === 'entity' && [(change.before as C4Object).name, (change.after as C4Object).name]).toEqual(['A', 'two'])
  })
})

describe('isContinuation / subtractKeys', () => {
  it('only updates of already-changed things continue an entry', () => {
    const a = state()
    const rename = diffModel(a, state({ objects: [obj('A', { name: 'x' }), obj('B')] }))
    const renameAgain = diffModel(a, state({ objects: [obj('A', { name: 'xy' }), obj('B')] }))
    const other = diffModel(a, state({ objects: [obj('A'), obj('B', { name: 'q' })] }))
    const remove = diffModel(a, state({ objects: [obj('B')] }))
    expect(isContinuation(rename, renameAgain)).toBe(true)
    expect(isContinuation(rename, other)).toBe(false)
    expect(isContinuation(remove, remove)).toBe(false)
  })

  it('a membership or group-membership change never continues an entry, even on the same key', () => {
    const a = state()
    const offDiagram = diffModel(a, state({ diagrams: [{ ...a.diagrams[0], objectIds: ['A'] }] }))
    expect([...offDiagram.keys()]).toEqual(['m:d:objectIds:B'])
    expect(isContinuation(offDiagram, offDiagram)).toBe(false)
    const outOfGroup = diffModel(a, state({ groups: [{ ...a.groups[0], objectIds: [] }] }))
    expect([...outOfGroup.keys()]).toEqual(['gm:g:A'])
    expect(isContinuation(outOfGroup, outOfGroup)).toBe(false)
  })

  it('subtracts a remote write', () => {
    const a = state()
    const both = diffModel(a, state({ objects: [obj('A', { name: 'x' }), obj('B', { name: 'y' })] }))
    expect([...subtractKeys(both, ['o:B']).keys()]).toEqual(['o:A'])
  })
})

describe('planApply + executePlan (pure)', () => {
  function draftOf(s: DiffableState): ApplyDraft {
    return {
      objects: s.objects.map((o) => ({ ...o })),
      connections: s.connections.map((c) => ({ ...c })),
      groups: s.groups.map((g) => ({ ...g, objectIds: [...g.objectIds] })),
      diagrams: s.diagrams.map((d) => ({ ...d, objectIds: [...d.objectIds], connectionIds: [...d.connectionIds], groupIds: [...d.groupIds], layouts: { ...d.layouts } })),
      selectedItems: [],
      pendingDeletedObjectIds: [],
      pendingDeletedConnectionIds: [],
      pendingDeletedGroupIds: [],
    }
  }

  it('undo then redo of a delete round-trips the state', () => {
    const before = state()
    const after: DiffableState = {
      objects: [obj('B')],
      connections: [],
      groups: [{ ...before.groups[0], objectIds: [] }],
      diagrams: [{ ...before.diagrams[0], objectIds: ['B'], connectionIds: [], layouts: { B: p(100) } }],
    }
    const diff = diffModel(before, after)
    const draft = draftOf(after)
    const undo = planApply(diff, 'undo', draft)
    expect(undo.skipped).toBe(0)
    executePlan(draft, undo)
    expect(deepEqual(draft.objects.map((o) => o.id).sort(), ['A', 'B'])).toBe(true)
    expect(draft.diagrams[0].layouts?.A).toEqual(p(0))
    expect(draft.groups[0].objectIds).toEqual(['A'])
    expect(draft.diagrams[0].connectionIds).toEqual(['c'])

    const redo = planApply(undo.applied, 'redo', draft)
    executePlan(draft, redo)
    expect(draft.objects.map((o) => o.id)).toEqual(['B'])
    expect(draft.pendingDeletedObjectIds).toEqual(['A'])
    expect(draft.pendingDeletedConnectionIds).toEqual(['c'])
  })

  it('does not re-add a connection id whose connection is gone', () => {
    const before = state()
    const after = state({ diagrams: [{ ...before.diagrams[0], connectionIds: [] }] })
    const diff = diffModel(before, after)
    const current = draftOf(state({ connections: [], diagrams: after.diagrams }))
    const plan = planApply(diff, 'undo', current)
    expect(plan.membership).toEqual([])
    expect(plan.skipped).toBe(1)
  })

  it('does not restore over an entity that exists again (a peer re-created the id)', () => {
    const before = state()
    const after = state({ objects: [obj('B')] })
    const diff = diffModel(before, after)
    const current = draftOf(state({ objects: [obj('A', { name: 'peer' }), obj('B')] }))
    const plan = planApply(diff, 'undo', current)
    expect(plan.restore).toEqual([])
    expect(plan.skipped).toBe(1)
    executePlan(current, plan)
    expect(current.objects.filter((o) => o.id === 'A').map((o) => o.name)).toEqual(['peer'])
  })

  it('does not delete a created shape a peer placed on another diagram', () => {
    const before = state()
    const after = state({
      objects: [...before.objects, obj('N')],
      diagrams: [{ ...before.diagrams[0], objectIds: ['A', 'B', 'N'] }],
    })
    const diff = diffModel(before, after)
    const current = draftOf(state({
      objects: after.objects,
      diagrams: [after.diagrams[0], { id: 'peer', name: 'p', type: 'context', objectIds: ['N'], connectionIds: [], groupIds: [] } as Diagram],
    }))
    const plan = planApply(diff, 'undo', current)
    expect(plan.remove).toEqual([])
  })
})
