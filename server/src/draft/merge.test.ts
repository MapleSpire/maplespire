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

import { describe, it, expect } from 'vitest'
import { diffModels, resolveConflicts, conflictKey, type DiffResult, type ChangeCollection, type ChangeKind, type DraftChange, type DraftConflict } from './merge.js'
import { withoutEmptyObjectScopes, type FullModel, type FullDiagram, type DiagramDetail } from './materialize.js'

// --- builders ---------------------------------------------------------------

function fm(p: Partial<FullModel> = {}): FullModel {
  return { objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {}, diagrams: {}, missing: [], ...p }
}
function detail(p: Partial<DiagramDetail> = {}): DiagramDetail {
  return { settings: {}, objectIds: [], connectionIds: [], groupIds: [], layouts: {}, flows: {}, ...p }
}
function diag(id: string, d?: DiagramDetail, name?: string): FullDiagram {
  return { id, meta: { id, name: name ?? id, docUrl: `automerge:doc-${id}` }, detail: d }
}
const obj = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'system', name, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  position: { x: 0, y: 0 }, size: { width: 100, height: 60 }, ...extra,
})

// --- assertions -------------------------------------------------------------

function has(r: DiffResult, kind: ChangeKind, collection: ChangeCollection, id: string): boolean {
  return r.changes.some((c) => c.kind === kind && c.collection === collection && c.id === id)
}
function conflict(r: DiffResult, collection: ChangeCollection, id: string): string | undefined {
  return r.conflicts.find((c) => c.collection === collection && c.id === id)?.kind
}

describe('diffModels — model collections', () => {
  it('object created / updated / deleted', () => {
    const base = fm({ objects: { a: obj('a', 'A'), c: obj('c', 'C') } })
    const ours = base
    const theirs = fm({ objects: { a: obj('a', 'A-renamed'), b: obj('b', 'B') } }) // a updated, b created, c deleted
    const r = diffModels(base, ours, theirs)
    expect(has(r, 'updated', 'object', 'a')).toBe(true)
    expect(has(r, 'created', 'object', 'b')).toBe(true)
    expect(has(r, 'deleted', 'object', 'c')).toBe(true)
    expect(r.conflicts).toHaveLength(0)
    expect(r.counts.model).toBe(3)
  })

  it('ignores object position/size-only changes (a move is not a model change)', () => {
    const base = fm({ objects: { a: obj('a', 'A', { position: { x: 0, y: 0 } }) } })
    const theirs = fm({ objects: { a: obj('a', 'A', { position: { x: 500, y: 300 }, size: { width: 9, height: 9 } }) } })
    const r = diffModels(base, base, theirs)
    expect(r.changes).toHaveLength(0)
  })

  it('keeps connection waypoint/anchor-only changes in the reviewed merge', () => {
    const conn = (extra: Record<string, unknown> = {}) => ({ id: 'x', fromId: 'a', toId: 'b', type: 'solid', ...extra })
    const base = fm({ connections: { x: conn() } })
    const theirs = fm({ connections: { x: conn({ waypoints: [{ x: 1, y: 2 }], fromAnchor: 3, toAnchor: 1 }) } })
    const r = diffModels(base, base, theirs)
    expect(r.changes).toEqual([
      expect.objectContaining({ collection: 'connection', id: 'x', kind: 'updated' }),
    ])
  })

  it('connection content change (label) is updated', () => {
    const conn = (label?: string) => ({ id: 'x', fromId: 'a', toId: 'b', type: 'solid', label })
    const base = fm({ connections: { x: conn('old') } })
    const theirs = fm({ connections: { x: conn('new') } })
    const r = diffModels(base, base, theirs)
    expect(has(r, 'updated', 'connection', 'x')).toBe(true)
  })

  it('group created; domain + Tag snapshot updated', () => {
    const base = fm({
      domains: { d: { id: 'd', name: 'D' } },
      tagSnapshots: { t: { tagId: 't', value: 'T', color: '#FFFFFF', groupId: 'g', groupName: 'Risk', catalogRevision: 1 } },
    })
    const theirs = fm({
      groups: { g: { id: 'g', name: 'G', color: '#000', objectIds: [], tagAssignments: {}, tagOrder: [] } },
      domains: { d: { id: 'd', name: 'D2' } },
      tagSnapshots: { t: { tagId: 't', value: 'T', color: '#EF4444', groupId: 'g', groupName: 'Risk', catalogRevision: 2 } },
    })
    const r = diffModels(base, base, theirs)
    expect(has(r, 'created', 'group', 'g')).toBe(true)
    expect(has(r, 'updated', 'domain', 'd')).toBe(true)
    expect(has(r, 'updated', 'tag', 't')).toBe(true)
  })

  it('ignores decisionRecord.updatedAt churn but catches content change', () => {
    const dr = (content: string, updatedAt: string) => ({
      id: 'r', number: 1, title: 'R', summary: '', status: 'approved', author: 'x',
      createdAt: '2020', updatedAt, content, related: [],
    })
    const base = fm({ decisionRecords: { r: dr('body', '2020') } })
    const churn = fm({ decisionRecords: { r: dr('body', '2099') } })
    expect(diffModels(base, base, churn).changes).toHaveLength(0)
    const edited = fm({ decisionRecords: { r: dr('body!', '2099') } })
    expect(has(diffModels(base, base, edited), 'updated', 'decisionRecord', 'r')).toBe(true)
  })
})

describe('diffModels — diagrams, layouts, flows', () => {
  it('an empty per-diagram scope map is no change (writers now create it eagerly)', () => {
    // materialize/sparse strip `objectScopes: {}` from settings, so a diagram
    // written once since the field appeared does not read as edited.
    const withEmpty = withoutEmptyObjectScopes({ name: 'D', objectScopes: {} })
    const base = fm({ diagrams: { D: diag('D', detail({ settings: { name: 'D' } })) } })
    const theirs = fm({ diagrams: { D: diag('D', detail({ settings: withEmpty })) } })
    expect(withEmpty).toEqual({ name: 'D' })
    expect(diffModels(base, base, theirs).changes).toEqual([])
    expect(withoutEmptyObjectScopes({ objectScopes: { a: 'external' } })).toEqual({ objectScopes: { a: 'external' } })
  })

  it('layout move surfaces as a per-diagram layout change (diagram counted)', () => {
    const base = fm({ diagrams: { D: diag('D', detail({ objectIds: ['a'], layouts: { a: { position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } } })) } })
    const theirs = fm({ diagrams: { D: diag('D', detail({ objectIds: ['a'], layouts: { a: { position: { x: 9, y: 9 }, size: { width: 1, height: 1 } } } })) } })
    const r = diffModels(base, base, theirs)
    expect(has(r, 'updated', 'layout', 'a')).toBe(true)
    expect(r.changes.find((c) => c.collection === 'layout')?.diagramId).toBe('D')
    expect(r.counts.model).toBe(0)
    expect(r.counts.diagrams).toBe(1)
  })

  it('flow added and flow edited', () => {
    const flow = (steps: unknown[]) => ({ id: 'f', name: 'F', diagramId: 'D', steps })
    const base = fm({ diagrams: { D: diag('D', detail({ flows: {} })) } })
    const added = fm({ diagrams: { D: diag('D', detail({ flows: { f: flow([]) } })) } })
    expect(has(diffModels(base, base, added), 'created', 'flow', 'f')).toBe(true)
    const baseF = fm({ diagrams: { D: diag('D', detail({ flows: { f: flow([]) } })) } })
    const editedF = fm({ diagrams: { D: diag('D', detail({ flows: { f: flow([{ id: 's', order: 0, type: 'process', title: 'x', objectId: 'a' }]) } })) } })
    expect(has(diffModels(baseF, baseF, editedF), 'updated', 'flow', 'f')).toBe(true)
  })

  it('diagram created / deleted / renamed / recomposed', () => {
    const created = diffModels(fm(), fm(), fm({ diagrams: { N: diag('N', detail(), 'New') } }))
    expect(has(created, 'created', 'diagram', 'N')).toBe(true)

    const baseD = fm({ diagrams: { D: diag('D', detail({ settings: { name: 'D' } }), 'D') } })
    const deleted = diffModels(baseD, baseD, fm())
    expect(has(deleted, 'deleted', 'diagram', 'D')).toBe(true)

    const renamed = fm({ diagrams: { D: diag('D', detail({ settings: { name: 'D2' } }), 'D2') } })
    expect(has(diffModels(baseD, baseD, renamed), 'updated', 'diagram', 'D')).toBe(true)

    const baseC = fm({ diagrams: { D: diag('D', detail({ objectIds: ['a'] })) } })
    const recomposed = fm({ diagrams: { D: diag('D', detail({ objectIds: ['a', 'b'] })) } })
    expect(has(diffModels(baseC, baseC, recomposed), 'updated', 'diagram', 'D')).toBe(true)
  })

  it('composition reorder is NOT a change', () => {
    const baseC = fm({ diagrams: { D: diag('D', detail({ objectIds: ['a', 'b', 'c'] })) } })
    const reordered = fm({ diagrams: { D: diag('D', detail({ objectIds: ['c', 'a', 'b'] })) } })
    expect(diffModels(baseC, baseC, reordered).changes).toHaveLength(0)
  })
})

describe('diffModels — conflicts (3-way)', () => {
  it('update/update when both sides edit the same object differently (with mine/live details)', () => {
    const base = fm({ objects: { a: obj('a', 'A') } })
    const ours = fm({ objects: { a: obj('a', 'A-ours') } })
    const theirs = fm({ objects: { a: obj('a', 'A-theirs') } })
    const r = diffModels(base, ours, theirs)
    expect(conflict(r, 'object', 'a')).toBe('update/update')
    const c = r.conflicts.find((x) => x.collection === 'object' && x.id === 'a')
    expect(c?.details).toEqual([{ field: 'name', mine: 'A-theirs', live: 'A-ours' }])
  })

  it('NO conflict when both sides make the IDENTICAL edit (convergent)', () => {
    const base = fm({ objects: { a: obj('a', 'A') } })
    const same = fm({ objects: { a: obj('a', 'A-same') } })
    const r = diffModels(base, same, same)
    expect(has(r, 'updated', 'object', 'a')).toBe(true)
    expect(r.conflicts).toHaveLength(0)
  })

  it('update/delete: draft edits, live model deletes', () => {
    const base = fm({ objects: { a: obj('a', 'A') } })
    const ours = fm() // deleted in current
    const theirs = fm({ objects: { a: obj('a', 'A-edited') } })
    expect(conflict(diffModels(base, ours, theirs), 'object', 'a')).toBe('update/delete')
  })

  it('delete/update: draft deletes, live model edits', () => {
    const base = fm({ objects: { a: obj('a', 'A') } })
    const ours = fm({ objects: { a: obj('a', 'A-edited') } })
    const theirs = fm() // deleted in draft
    expect(conflict(diffModels(base, ours, theirs), 'object', 'a')).toBe('delete/update')
  })

  it('both delete the same object → NO conflict', () => {
    const base = fm({ objects: { a: obj('a', 'A') } })
    const r = diffModels(base, fm(), fm())
    expect(has(r, 'deleted', 'object', 'a')).toBe(true)
    expect(r.conflicts).toHaveLength(0)
  })

  it('current-only change is NOT reported as a draft change (and no conflict)', () => {
    const base = fm({ objects: { a: obj('a', 'A'), b: obj('b', 'B') } })
    const ours = fm({ objects: { a: obj('a', 'A-live'), b: obj('b', 'B') } }) // live edited a
    const theirs = fm({ objects: { a: obj('a', 'A'), b: obj('b', 'B-draft') } }) // draft edited b
    const r = diffModels(base, ours, theirs)
    expect(has(r, 'updated', 'object', 'b')).toBe(true)
    expect(r.changes.some((c) => c.id === 'a')).toBe(false) // a is current-only, not a draft change
    expect(r.conflicts).toHaveLength(0)
  })

  it('per-layout conflict when both move the same shape differently', () => {
    const L = (x: number) => ({ a: { position: { x, y: 0 }, size: { width: 1, height: 1 } } })
    const base = fm({ diagrams: { D: diag('D', detail({ layouts: L(0) })) } })
    const ours = fm({ diagrams: { D: diag('D', detail({ layouts: L(1) })) } })
    const theirs = fm({ diagrams: { D: diag('D', detail({ layouts: L(2) })) } })
    expect(conflict(diffModels(base, ours, theirs), 'layout', 'a')).toBe('update/update')
  })

  it('fail-safe conflict when the DRAFT diagram body cannot be materialized', () => {
    const base = fm({ diagrams: { D: diag('D', detail({ settings: { name: 'D' } })) } })
    const ours = base
    const theirs = fm({ diagrams: { D: diag('D', undefined, 'D') } }) // draft detail missing (heads-unknown)
    const r = diffModels(base, ours, theirs)
    expect(conflict(r, 'diagram', 'D')).toBe('unresolved')
  })

  it('NO conflict when only the LIVE diagram body is unreadable but the draft did not touch it', () => {
    // base & theirs identical detail (draft made no change); ours detail missing (transient live read fail).
    const d = () => detail({ settings: { name: 'D' }, objectIds: ['a'] })
    const base = fm({ diagrams: { D: diag('D', d()) } })
    const ours = fm({ diagrams: { D: diag('D', undefined, 'D') } })
    const theirs = fm({ diagrams: { D: diag('D', d()) } })
    const r = diffModels(base, ours, theirs)
    expect(r.conflicts).toHaveLength(0)
    expect(r.changes).toHaveLength(0)
  })

  it('still fail-safe when the draft DID change the diagram but the live body is unreadable', () => {
    const base = fm({ diagrams: { D: diag('D', detail({ settings: { name: 'D' } })) } })
    const ours = fm({ diagrams: { D: diag('D', undefined, 'D') } }) // live unreadable
    const theirs = fm({ diagrams: { D: diag('D', detail({ settings: { name: 'D-renamed' } })) } }) // draft changed
    const r = diffModels(base, ours, theirs)
    expect(conflict(r, 'diagram', 'D')).toBe('unresolved')
  })
})

describe('resolveConflicts', () => {
  const mk = (changes: DraftChange[], conflicts: DraftConflict[]): DiffResult => ({
    changes, conflicts, counts: { model: 0, diagrams: 0, conflicts: conflicts.length },
  })
  const chg = (collection: ChangeCollection, id: string, kind: ChangeKind = 'updated'): DraftChange => ({ kind, collection, id, label: id })
  const cfl = (collection: ChangeCollection, id: string, kind: DraftConflict['kind'] = 'update/update'): DraftConflict => ({ kind, collection, id, label: id })

  it('blocks when a conflict is unresolved (no resolutions)', () => {
    const r = resolveConflicts(mk([chg('object', 'a')], [cfl('object', 'a')]), {})
    expect(r.blocked).toHaveLength(1)
    expect(r.appliedChanges).toHaveLength(0)
  })

  it("'draft' resolution keeps the draft's change", () => {
    const r = resolveConflicts(mk([chg('object', 'a')], [cfl('object', 'a')]), { [conflictKey({ collection: 'object', id: 'a' })]: 'draft' })
    expect(r.blocked).toBeNull()
    expect(r.appliedChanges.map((c) => c.id)).toEqual(['a'])
  })

  it("'live' resolution drops the draft's change but keeps non-conflicting ones", () => {
    const r = resolveConflicts(
      mk([chg('object', 'a'), chg('object', 'b')], [cfl('object', 'a')]),
      { [conflictKey({ collection: 'object', id: 'a' })]: 'live' }
    )
    expect(r.blocked).toBeNull()
    expect(r.appliedChanges.map((c) => c.id)).toEqual(['b'])
  })

  it("an 'unresolved'-kind conflict always blocks, even if 'resolved'", () => {
    const diff = mk([], [{ kind: 'unresolved', collection: 'diagram', id: 'D', label: 'D', diagramId: 'D' }])
    const r = resolveConflicts(diff, { [conflictKey({ collection: 'diagram', id: 'D', diagramId: 'D' })]: 'draft' })
    expect(r.blocked).toHaveLength(1)
  })

  it('a diagram-level conflict resolved live drops its layout/flow sub-changes (different keys)', () => {
    // The conflict is diagram-level (key diagram:D:D); the change is a layout (key layout:a:D).
    const layoutChange: DraftChange = { kind: 'updated', collection: 'layout', id: 'a', label: 'a', diagramId: 'D' }
    const objChange: DraftChange = { kind: 'updated', collection: 'object', id: 'x', label: 'x' }
    const diagConflict: DraftConflict = { kind: 'update/delete', collection: 'diagram', id: 'D', label: 'D', diagramId: 'D' }
    const diff = mk([layoutChange, objChange], [diagConflict])
    const r = resolveConflicts(diff, { [conflictKey(diagConflict)]: 'live' })
    expect(r.blocked).toBeNull()
    expect(r.appliedChanges.map((c) => `${c.collection}:${c.id}`)).toEqual(['object:x']) // layout for D dropped
  })

  it('blocks when a resolution value is not draft/live (garbage)', () => {
    const diff = mk([chg('object', 'a')], [cfl('object', 'a')])
    const r = resolveConflicts(diff, { [conflictKey({ collection: 'object', id: 'a' })]: 'nonsense' as never })
    expect(r.blocked).toHaveLength(1)
  })
})

describe('diffModels — counts', () => {
  it('separates model vs diagram counts and totals conflicts', () => {
    const base = fm({
      objects: { a: obj('a', 'A') },
      diagrams: { D: diag('D', detail({ layouts: { a: { position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } } })) },
    })
    const theirs = fm({
      objects: { a: obj('a', 'A2'), b: obj('b', 'B') }, // 1 update + 1 create = 2 model
      diagrams: { D: diag('D', detail({ layouts: { a: { position: { x: 9, y: 0 }, size: { width: 1, height: 1 } } } })) }, // 1 diagram
    })
    const r = diffModels(base, base, theirs)
    expect(r.counts.model).toBe(2)
    expect(r.counts.diagrams).toBe(1)
    expect(r.counts.conflicts).toBe(0)
  })
})
