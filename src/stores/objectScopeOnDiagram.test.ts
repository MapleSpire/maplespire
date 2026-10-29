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

import { beforeEach, describe, expect, it } from 'vitest'
import { useModelStore } from './modelStore'
import { filterAndMergeDiagramData } from '../lib/viewLayouts'
import { classifyDiagramViewEdit } from '../lib/automerge/diagramViewWrite'
import type { C4Object, Diagram } from '../types'

// User-reported defect (2026-10-21): scope lived on the model object, so an
// object could not be internal on one diagram and external on another.

function obj(id: string, parentId?: string): C4Object {
  return {
    id, type: 'system', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
    ...(parentId ? { parentId } : {}),
  } as C4Object
}
const diagram = (id: string): Diagram => useModelStore.getState().diagrams.find((d) => d.id === id)!
const shownScope = (diagramId: string, objectId: string) => {
  const s = useModelStore.getState()
  return filterAndMergeDiagramData(diagram(diagramId), s.objects, [], [])
    .filteredObjects.find((o) => o.id === objectId)?.scope
}

beforeEach(() => {
  useModelStore.setState({
    objects: [obj('shop'), obj('bank'), obj('web', 'shop')],
    connections: [],
    groups: [],
    diagrams: [
      { id: 'landscape', name: 'Landscape', type: 'context', objectIds: ['shop', 'bank'], connectionIds: [], groupIds: [] },
      { id: 'other', name: 'Other', type: 'context', objectIds: ['shop', 'bank'], connectionIds: [], groupIds: [] },
      { id: 'shop-c', name: 'Shop', type: 'container', parentObjectId: 'shop', objectIds: ['web', 'bank'], connectionIds: [], groupIds: [] },
    ],
    currentDiagramId: 'landscape',
    selectedItems: [],
  })
})

describe('per-diagram object scope', () => {
  it('marks an object external on ONE diagram without touching the model object or other diagrams', () => {
    const before = useModelStore.getState()
    useModelStore.getState().setObjectScopeOnDiagram(['bank'], 'external')
    const after = useModelStore.getState()

    expect(shownScope('landscape', 'bank')).toBe('external')
    expect(shownScope('other', 'bank')).toBe('internal')
    expect(after.objects.find((o) => o.id === 'bank')!.scope).toBe('internal')
    // Only the diagram changed — but the overrides are registry meta too
    // (model-wide "external in N of M diagrams"), so the edit takes the full
    // write, never the DiagramDoc-only view-field path.
    expect(after.objects).toBe(before.objects)
    expect(classifyDiagramViewEdit(after, before)).toBeNull()
  })

  it('reset clears the override so the boundary rule and the default apply again', () => {
    useModelStore.setState({ currentDiagramId: 'shop-c' })
    const { setObjectScopeOnDiagram } = useModelStore.getState()
    setObjectScopeOnDiagram(['bank'], 'internal')
    expect(shownScope('shop-c', 'bank')).toBe('internal')
    setObjectScopeOnDiagram(['bank'], null)
    // Emptied, not deleted (a deleted Automerge map drops a peer's concurrent write).
    expect(diagram('shop-c').objectScopes).toEqual({})
    // bank is outside shop's boundary on shop's container view.
    expect(shownScope('shop-c', 'bank')).toBe('external')
    expect(shownScope('shop-c', 'web')).toBe('internal')
  })

  it('the default scope follows the object to diagrams that do not override it', () => {
    useModelStore.setState({ currentDiagramId: 'other' })
    useModelStore.getState().setObjectScopeOnDiagram(['bank'], 'internal')
    useModelStore.getState().updateObject('bank', { scope: 'external' })
    expect(shownScope('landscape', 'bank')).toBe('external')
    expect(shownScope('other', 'bank')).toBe('internal')
  })

  it('deleting the object drops its override, so a re-created id does not inherit it', () => {
    useModelStore.getState().setObjectScopeOnDiagram(['bank'], 'external')
    useModelStore.getState().deleteObject('bank')
    expect(diagram('landscape').objectScopes?.bank).toBeUndefined()
  })
})

describe('per-diagram object scope — other write paths', () => {
  it('deleting the selection drops its overrides on every diagram', () => {
    const { setObjectScopeOnDiagram } = useModelStore.getState()
    setObjectScopeOnDiagram(['bank'], 'external')
    useModelStore.setState({ currentDiagramId: 'shop-c' })
    setObjectScopeOnDiagram(['bank'], 'internal')
    useModelStore.setState({ selectedItems: [{ id: 'bank', type: 'object' }] })
    useModelStore.getState().deleteSelectedItems()
    expect(diagram('landscape').objectScopes).toEqual({})
    expect(diagram('shop-c').objectScopes).toEqual({})
  })

  it('sets every id it is given, and clearing on a diagram with no overrides is a no-op', () => {
    useModelStore.setState({ currentDiagramId: 'other' })
    useModelStore.getState().setObjectScopeOnDiagram(['shop', 'bank'], 'external')
    expect(diagram('other').objectScopes).toEqual({ shop: 'external', bank: 'external' })
    useModelStore.setState({ currentDiagramId: 'landscape' })
    expect(() => useModelStore.getState().setObjectScopeOnDiagram(['bank'], null)).not.toThrow()
    expect(diagram('landscape').objectScopes).toBeUndefined()
  })
})
