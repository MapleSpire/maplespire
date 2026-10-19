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
})
