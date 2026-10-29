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

import * as Automerge from '@automerge/automerge'
import { describe, expect, it } from 'vitest'
import type { Diagram } from '../../types'
import {
  DIAGRAM_VIEW_FIELDS,
  applyDiagramViewFields,
  classifyDiagramViewEdit,
  ScopeEditTracker,
  setObjectScopesForReconcile,
  withObjectScopesAtBirth,
  type ViewEditSlices,
} from './diagramViewWrite'
import { diagramToDiagramDoc } from './projection'
import { reconcile } from './reconcile'

function diagram(id: string, over: Partial<Diagram> = {}): Diagram {
  return {
    id,
    name: `Diagram ${id}`,
    type: 'container',
    objectIds: ['a', 'b'],
    connectionIds: ['c1'],
    groupIds: [],
    layouts: { a: { position: { x: 1, y: 2 }, size: { width: 10, height: 10 } } },
    ...over,
  }
}

function slices(diagrams: Diagram[]): ViewEditSlices {
  return {
    objects: [],
    connections: [],
    diagrams,
    flows: [],
    tags: [],
    groups: [],
    domains: [],
    comments: [],
    decisionRecords: [],
    currentDiagramId: diagrams[0]?.id ?? null,
  }
}

function edit(previous: ViewEditSlices, index: number, over: Partial<Diagram>): ViewEditSlices {
  const diagrams = [...previous.diagrams]
  diagrams[index] = { ...diagrams[index], ...over }
  return { ...previous, diagrams }
}

describe('classifyDiagramViewEdit', () => {
  const base = slices([diagram('d1'), diagram('d2')])

  it('recognises a decor pick on one diagram as a view-only edit', () => {
    const next = edit(base, 1, { sceneDecor: { packId: 'canadiana', boardStyle: 'wood', background: 'city' } })
    expect(classifyDiagramViewEdit(next, base)).toBe('d2')
  })

  it('recognises removing a view field (decor cleared) as view-only', () => {
    const decorated = edit(base, 0, { sceneDecor: { background: 'city' } })
    const { sceneDecor: _drop, ...rest } = decorated.diagrams[0]
    const cleared = { ...decorated, diagrams: [rest as Diagram, decorated.diagrams[1]] }
    expect(classifyDiagramViewEdit(cleared, decorated)).toBe('d1')
  })

  it('recognises a skin change as view-only', () => {
    expect(classifyDiagramViewEdit(edit(base, 0, { skinId: 'studio' }), base)).toBe('d1')
  })

  it.each([
    ['a rename (registry meta)', { name: 'Renamed' }],
    ['a composition change', { objectIds: ['a'] }],
    ['a layout change (placement owns it)', { layouts: {} }],
    ['a 3D layout change', { layouts3d: {} }],
    ['a parent change (registry meta)', { parentObjectId: 'x' }],
    ['a description change (not whitelisted)', { description: 'hi' }],
  ] as const)('refuses %s', (_label, over) => {
    expect(classifyDiagramViewEdit(edit(base, 0, over as Partial<Diagram>), base)).toBeNull()
  })

  it('refuses a view edit mixed with a structural edit on the same diagram', () => {
    expect(classifyDiagramViewEdit(edit(base, 0, { skinId: 'studio', name: 'x' }), base)).toBeNull()
  })

  it('refuses view edits on two diagrams at once', () => {
    const one = edit(base, 0, { skinId: 'studio' })
    expect(classifyDiagramViewEdit(edit(one, 1, { skinId: 'studio' }), base)).toBeNull()
  })

  it('refuses when any other durable slice changed in the same tick', () => {
    const next = { ...edit(base, 0, { skinId: 'studio' }), objects: [{}] }
    expect(classifyDiagramViewEdit(next, base)).toBeNull()
  })

  // Every durable slice persistentSlicesChanged watches, not just `objects`:
  // a view edit coalesced with ANY other durable change in one store tick must
  // take the full write, or that other change is never persisted.
  it.each([
    'objects', 'connections', 'flows', 'tags', 'groups', 'domains', 'comments', 'decisionRecords',
  ] as const)('refuses a view edit coalesced with a change to %s', (slice) => {
    const next = { ...edit(base, 0, { skinId: 'studio' }), [slice]: [{}] }
    expect(classifyDiagramViewEdit(next, base)).toBeNull()
  })

  it('refuses a view edit that also REMOVES a non-view key', () => {
    const described = edit(base, 0, { description: 'kept?' })
    const { description: _drop, ...rest } = { ...described.diagrams[0], skinId: 'studio' }
    const next = { ...described, diagrams: [rest as Diagram, described.diagrams[1]] }
    expect(classifyDiagramViewEdit(next, described)).toBeNull()
  })

  it.each([
    ['connectionHighlightStyle', { connectionHighlightStyle: 'pulse' }],
    ['connectionAnimationsEnabled', { connectionAnimationsEnabled: false }],
    ['defaultConnectionShape', { defaultConnectionShape: 'straight' }],
  ] as const)('recognises a %s change as view-only', (_label, over) => {
    expect(classifyDiagramViewEdit(edit(base, 0, over as Partial<Diagram>), base)).toBe('d1')
  })

  it('sends a scope-override edit down the FULL write (it is registry meta too)', () => {
    // The targeted path writes only the DiagramDoc; the registry meta's copy
    // feeds "external in N of M diagrams" on the model-wide pages.
    expect(classifyDiagramViewEdit(edit(base, 0, { objectScopes: { a: 'external' } }), base)).toBeNull()
  })

  it('pins the whitelist exactly (adding a field is a reviewed decision, not a drive-by)', () => {
    expect([...DIAGRAM_VIEW_FIELDS].sort()).toEqual([
      'connectionAnimationsEnabled',
      'connectionHighlightStyle',
      'defaultConnectionShape',
      'sceneDecor',
      'skinId',
    ])
  })

  it('refuses a created or deleted diagram', () => {
    expect(classifyDiagramViewEdit({ ...base, diagrams: [...base.diagrams, diagram('d3')] }, base)).toBeNull()
    expect(classifyDiagramViewEdit({ ...base, diagrams: [base.diagrams[0]] }, base)).toBeNull()
  })

  it('refuses a rebuilt diagrams array whose entries all kept their identity', () => {
    expect(classifyDiagramViewEdit({ ...base, diagrams: [...base.diagrams] }, base)).toBeNull()
  })

  it('refuses a diagram switch', () => {
    const next = { ...edit(base, 0, { skinId: 'studio' }), currentDiagramId: 'd2' }
    expect(classifyDiagramViewEdit(next, base)).toBeNull()
  })
})

describe('applyDiagramViewFields', () => {
  // The targeted write must leave the document exactly where the full
  // whole-doc reconcile would — on a REAL Automerge doc, view fields only.
  function fullWrite(doc: Automerge.Doc<Record<string, unknown>>, d: Diagram, checkpoints: unknown[] = []) {
    return Automerge.change(doc, (draft) => {
      reconcile(draft, diagramToDiagramDoc(d, [], [], checkpoints as never))
    })
  }

  it.each([
    ['set a decor', {}, { sceneDecor: { packId: 'canadiana', boardStyle: 'wood', background: 'city' } }],
    ['change one decor key', { sceneDecor: { packId: 'canadiana', background: 'city' } }, { sceneDecor: { packId: 'canadiana', background: 'workbench' } }],
    ['drop a decor key (undefined member)', { sceneDecor: { packId: 'canadiana', seed: 7 } }, { sceneDecor: { packId: 'canadiana', seed: undefined } }],
    ['clear the decor', { sceneDecor: { background: 'city' } }, { sceneDecor: undefined }],
    ['switch skin and animation', { skinId: 'a' }, { skinId: 'studio', connectionAnimationsEnabled: false }],
  ] as const)('%s: same document as the full reconcile', (_label, before, after) => {
    const start = diagram('d1', before as Partial<Diagram>)
    const end = { ...start, ...(after as Partial<Diagram>) }
    const seeded = fullWrite(Automerge.from({} as Record<string, unknown>), start, [{ id: 'cp' }])

    const viaFull = fullWrite(Automerge.clone(seeded), end, [{ id: 'cp' }])
    const viaTargeted = Automerge.change(Automerge.clone(seeded), (draft) => applyDiagramViewFields(draft, end))

    expect(JSON.parse(JSON.stringify(viaTargeted))).toEqual(JSON.parse(JSON.stringify(viaFull)))
  })

  it('touches no field outside the view whitelist', () => {
    const start = diagram('d1')
    const seeded = fullWrite(Automerge.from({} as Record<string, unknown>), start)
    // a store diagram whose structural fields drifted must NOT leak through
    const drifted = { ...start, name: 'drift', objectIds: [], layouts: {}, skinId: 'studio' }
    const next = Automerge.change(Automerge.clone(seeded), (draft) => applyDiagramViewFields(draft, drifted))
    const plain = JSON.parse(JSON.stringify(next)) as Record<string, unknown>
    expect(plain.name).toBe('Diagram d1')
    expect(plain.objectIds).toEqual(['a', 'b'])
    expect(plain.layouts).toEqual(start.layouts)
    expect(plain.skinId).toBe('studio')
    expect(DIAGRAM_VIEW_FIELDS).not.toContain('name')
  })

  it('merges two peers overriding DIFFERENT objects concurrently on the full write (per-key, not last-writer-wins on the map)', () => {
    const start = diagram('d1', { objectScopes: { a: 'external' } })
    const seeded = fullWrite(Automerge.from({} as Record<string, unknown>), start)
    const peerA = fullWrite(Automerge.clone(seeded), { ...start, objectScopes: { a: 'external', b: 'external' } })
    const peerB = fullWrite(Automerge.clone(seeded), { ...start, objectScopes: { a: 'internal' } })
    const merged = JSON.parse(JSON.stringify(Automerge.merge(peerA, peerB))) as Record<string, unknown>
    expect(merged.objectScopes).toEqual({ a: 'internal', b: 'external' })
  })
})

// Per-diagram scope overrides travel on the FULL write (they are registry meta
// too) as a DELTA: the document's own map plus only the keys this client
// changed (ScopeEditTracker + setObjectScopesForReconcile, as bridge.ts does).
describe('objectScopes delta write', () => {
  type Doc = Automerge.Doc<Record<string, unknown>>
  const plain = (doc: Doc) => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>

  /** Create a document the way the client does (map at birth, or legacy without). */
  function born(store: Diagram): Doc {
    return Automerge.change(Automerge.from({} as Record<string, unknown>), (draft) => {
      reconcile(draft, diagramToDiagramDoc(store, [], [], []))
    })
  }

  /** The bridge's full write of the active diagram: every field from the store,
   * `objectScopes` as the delta of `dirty` onto the document's own map. */
  function write(doc: Doc, store: Diagram, dirty?: Iterable<string>): Doc {
    return Automerge.change(Automerge.clone(doc), (draft) => {
      const target = diagramToDiagramDoc(store, [], [], []) as Record<string, unknown>
      setObjectScopesForReconcile(target, store.objectScopes, draft, dirty ? new Set(dirty) : undefined)
      reconcile(draft, target)
    })
  }

  it('keeps an override a peer merged into the doc but the store has not shown yet (store lags the doc)', () => {
    // Re-review 2026-10-29, F2: writing the store's WHOLE map deleted X here.
    const start = withObjectScopesAtBirth(diagram('d1'))
    const base = born(start)
    const alice = write(Automerge.clone(base), { ...start, objectScopes: { X: 'external' } }, ['X'])
    const bobDoc = Automerge.merge(Automerge.clone(base), alice) // merged, not yet projected
    const bobStore: Diagram = { ...start, objectScopes: { Y: 'internal' } }
    expect(plain(write(bobDoc, bobStore, ['Y'])).objectScopes).toEqual({ X: 'external', Y: 'internal' })
    // …and an unrelated full write (a rename) with a lagging store keeps it too.
    expect(plain(write(bobDoc, { ...start, name: 'renamed', objectScopes: {} })).objectScopes).toEqual({ X: 'external' })
  })

  it('keeps BOTH first-ever overrides set concurrently on a NEW diagram (the map was created at birth)', () => {
    const start = withObjectScopesAtBirth(diagram('d1'))
    const seeded = born(start)
    expect(plain(seeded).objectScopes).toEqual({})
    const peerA = write(Automerge.clone(seeded), { ...start, objectScopes: { a: 'external' } }, ['a'])
    const peerB = write(Automerge.clone(seeded), { ...start, objectScopes: { b: 'internal' } }, ['b'])
    expect(plain(Automerge.merge(peerA, peerB)).objectScopes).toEqual({ a: 'external', b: 'internal' })
  })

  it("on an OLDER diagram, an unrelated write does not create the map, so it cannot race a peer's first override", () => {
    const start = diagram('d1') // legacy: no map
    const seeded = born(start)
    expect('objectScopes' in plain(seeded)).toBe(false)
    const renamer = write(Automerge.clone(seeded), { ...start, name: 'renamed', objectScopes: {} })
    expect('objectScopes' in plain(renamer)).toBe(false)
    const overrider = write(Automerge.clone(seeded), { ...start, objectScopes: { a: 'external' } }, ['a'])
    const merged = plain(Automerge.merge(renamer, overrider))
    expect(merged.objectScopes).toEqual({ a: 'external' })
    expect(merged.name).toBe('renamed')
  })

  it('a clear on an older diagram creates nothing; a clear never deletes the map', () => {
    expect('objectScopes' in plain(write(born(diagram('d1')), { ...diagram('d1'), objectScopes: {} }, ['a']))).toBe(false)
    const withMap = born(diagram('d1', { objectScopes: { a: 'external' } }))
    expect(plain(write(withMap, { ...diagram('d1'), objectScopes: {} }, ['a'])).objectScopes).toEqual({})
    // The store holding no map at all leaves the document's map untouched.
    expect(plain(write(withMap, diagram('d1'))).objectScopes).toEqual({ a: 'external' })
  })

  it('keeps a concurrent override when another peer clears the LAST one (the map is emptied, not deleted)', () => {
    const start = diagram('d1', { objectScopes: { a: 'external' } })
    const seeded = born(start)
    const clearer = write(Automerge.clone(seeded), { ...start, objectScopes: {} }, ['a'])
    const setter = write(Automerge.clone(seeded), { ...start, objectScopes: { a: 'external', b: 'external' } }, ['b'])
    expect(plain(Automerge.merge(clearer, setter)).objectScopes).toEqual({ b: 'external' })
  })

  it('ScopeEditTracker records only the keys that changed locally, per diagram, and take() forgets them', () => {
    const tracker = new ScopeEditTracker()
    const d1 = diagram('d1', { objectScopes: { a: 'external', b: 'internal' } })
    const d2 = diagram('d2')
    tracker.note([d1, d2], [{ ...d1, objectScopes: { a: 'internal', b: 'internal', c: 'external' } }, d2])
    tracker.note([d1], [{ ...d1, objectScopes: { b: 'internal' } }])
    expect([...(tracker.take('d1') ?? [])].sort()).toEqual(['a', 'c'])
    expect(tracker.take('d1')).toBeUndefined()
    expect(tracker.take('d2')).toBeUndefined()
  })
})
