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
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import type { C4Object, Connection, Diagram } from '../../types'
import { undoHistory } from '../../lib/history/undoHistory'
import { readClipboardPayload, CANVAS_CLIPBOARD_MIME } from '../../lib/clipboard/canvasClipboard'
import {
  copySelection,
  cutSelection,
  duplicateSelection,
  pastePayload,
  PASTE_STEP,
  rememberedClipboard,
  removeSelectionFromDiagram,
  resetCanvasClipboard,
  selectAllOnDiagram,
} from './canvasCommands'

// The commands behind Ctrl+C/X/V/D/A and Delete, against the real store and
// the real undo history.

const object = (id: string, x: number): C4Object => ({
  id, type: 'app', name: id, position: { x, y: 0 }, size: { width: 100, height: 50 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
}) as C4Object
const place = (x: number, y = 0) => ({ position: { x, y }, size: { width: 100, height: 50 } })

const store = () => useModelStore.getState()
const diagram = (id: string) => store().diagrams.find((d) => d.id === id)!
const nextGesture = () => { undoHistory.seal(); undoHistory.endTask() }

beforeEach(() => {
  resetCanvasClipboard()
  useUIStore.setState({ canvasViewMode: '2d', currentView: 'diagram' })
  useModelStore.setState({
    objects: [object('A', 0), object('B', 300)],
    connections: [{ id: 'ab', fromId: 'A', toId: 'B', type: 'solid', label: 'calls' } as Connection],
    groups: [],
    tags: [],
    diagrams: [
      { id: 'd1', name: 'one', type: 'context', objectIds: ['A', 'B'], connectionIds: ['ab'], groupIds: [], layouts: { A: place(0), B: place(300) } } as Diagram,
      { id: 'd2', name: 'two', type: 'context', objectIds: [], connectionIds: [], groupIds: [], layouts: {} } as Diagram,
    ],
    currentDiagramId: 'd1',
    selectedItems: [{ id: 'A', type: 'object' }, { id: 'B', type: 'object' }],
    workspaceReadOnly: false,
    pendingDeletedObjectIds: [],
    pendingDeletedConnectionIds: [],
    pendingDeletedGroupIds: [],
  })
  undoHistory.clear()
  nextGesture()
})

describe('copy + paste', () => {
  it('pastes COPIES onto the same diagram, offset, selected, as ONE undo step', async () => {
    const encoded = copySelection()!
    expect(readClipboardPayload((t) => (t === CANVAS_CLIPBOARD_MIME ? encoded.json : null))?.objects).toHaveLength(2)
    nextGesture()
    const plan = (await pastePayload(rememberedClipboard()!))!
    expect(plan.mode).toBe('copy')
    expect(store().objects).toHaveLength(4)
    expect(store().connections.filter((c) => c.kind !== 'lower')).toHaveLength(2)
    // Payload order is selection order, so the first copy is A's. The name
    // suffix is localized ("(copy)" / "(copie)").
    const copyOfA = plan.newObjects[0]
    expect(copyOfA.id).not.toBe('A')
    expect(copyOfA.name).toMatch(/^A \(cop/)
    expect(diagram('d1').layouts?.[copyOfA.id].position).toEqual({ x: PASTE_STEP, y: PASTE_STEP })
    expect(store().selectedItems.map((s) => s.id).sort()).toEqual(plan.selection.map((s) => s.id).sort())

    // A second paste of the same copy cascades one step further.
    nextGesture()
    const second = (await pastePayload(rememberedClipboard()!))!
    expect(second.placements[second.newObjects[0].id].position)
      .toEqual({ x: 2 * PASTE_STEP, y: 2 * PASTE_STEP })

    nextGesture()
    undoHistory.undo()
    undoHistory.undo()
    expect(store().objects.map((o) => o.id).sort()).toEqual(['A', 'B'])
    expect(store().pendingDeletedObjectIds).toContain(copyOfA.id)
  })

  it('pastes the SAME elements into another diagram (a view of one model), connection included', async () => {
    copySelection()
    useModelStore.setState({ currentDiagramId: 'd2' })
    nextGesture()
    const plan = (await pastePayload(rememberedClipboard()!))!
    expect(plan.mode).toBe('reference')
    expect(store().objects).toHaveLength(2)
    expect([...diagram('d2').objectIds].sort()).toEqual(['A', 'B'])
    expect(diagram('d2').connectionIds).toEqual(['ab'])
    expect(diagram('d2').layouts?.A).toEqual(place(0))

    nextGesture()
    undoHistory.undo()
    expect(diagram('d2').objectIds).toEqual([])
    // The model is untouched by undoing a reference paste.
    expect(store().objects).toHaveLength(2)
    expect(store().pendingDeletedObjectIds).toEqual([])
  })

  it('Paste as copy forces copies even into another view', async () => {
    copySelection()
    useModelStore.setState({ currentDiagramId: 'd2' })
    const plan = (await pastePayload(rememberedClipboard()!, { forceCopy: true }))!
    expect(plan.mode).toBe('copy')
    expect(store().objects).toHaveLength(4)
  })

  it('a paste that would land off screen is centred in the visible rectangle', async () => {
    copySelection()
    useModelStore.setState({ currentDiagramId: 'd2' })
    const plan = (await pastePayload(rememberedClipboard()!, { visibleRect: { x: 5000, y: 5000, width: 1000, height: 1000 } }))!
    const a = plan.placements.A
    expect(a.position.x).toBeGreaterThan(5000)
    expect(a.position.y).toBeGreaterThan(5000)
  })
})

describe('cut', () => {
  it('removes from THIS diagram only (never a model delete), and cut-then-paste elsewhere moves the elements', async () => {
    useModelStore.setState({ selectedItems: [{ id: 'A', type: 'object' }] })
    expect(cutSelection()).not.toBeNull()
    expect(diagram('d1').objectIds).toEqual(['B'])
    expect(store().objects.map((o) => o.id).sort()).toEqual(['A', 'B'])
    expect(store().pendingDeletedObjectIds).toEqual([])

    useModelStore.setState({ currentDiagramId: 'd2' })
    nextGesture()
    const plan = (await pastePayload(rememberedClipboard()!))!
    expect(plan.mode).toBe('reference')
    expect(diagram('d2').objectIds).toEqual(['A'])
  })

  it('cut back into the same diagram restores the original element, not a copy', async () => {
    useModelStore.setState({ selectedItems: [{ id: 'A', type: 'object' }] })
    cutSelection()
    nextGesture()
    const plan = (await pastePayload(rememberedClipboard()!))!
    expect(plan.mode).toBe('reference')
    expect([...diagram('d1').objectIds].sort()).toEqual(['A', 'B'])
    expect(diagram('d1').layouts?.A).toEqual(place(0))
  })

  it('is one undo step', () => {
    cutSelection()
    expect(diagram('d1').objectIds).toEqual([])
    undoHistory.undo()
    expect([...diagram('d1').objectIds].sort()).toEqual(['A', 'B'])
    expect(diagram('d1').connectionIds).toEqual(['ab'])
  })
})

describe('duplicate, select all, remove', () => {
  it('Ctrl+D duplicates next to the selection without touching the clipboard', async () => {
    const plan = (await duplicateSelection())!
    expect(plan.mode).toBe('copy')
    expect(rememberedClipboard()).toBeNull()
    // `x % PASTE_STEP === 0` also held for a duplicate stacked exactly ON the
    // original (x = 0): assert the actual step. Payload order is selection order.
    expect(plan.placements[plan.newObjects[0].id].position).toEqual({ x: PASTE_STEP, y: PASTE_STEP })
    expect(plan.placements[plan.newObjects[1].id].position).toEqual({ x: 300 + PASTE_STEP, y: PASTE_STEP })
    expect(diagram('d1').layouts?.[plan.newObjects[0].id].position).toEqual({ x: PASTE_STEP, y: PASTE_STEP })
    expect(store().objects).toHaveLength(4)
  })

  it('Ctrl+A selects every shape and group on the diagram', () => {
    useModelStore.setState({ selectedItems: [] })
    selectAllOnDiagram()
    expect(store().selectedItems.map((s) => s.id).sort()).toEqual(['A', 'B'])
  })

  it('Delete removes the selection from the diagram, undoable', () => {
    expect(removeSelectionFromDiagram()).toBe(true)
    expect(diagram('d1').objectIds).toEqual([])
    expect(store().objects).toHaveLength(2)
    undoHistory.undo()
    expect([...diagram('d1').objectIds].sort()).toEqual(['A', 'B'])
  })

  it('nothing selected: nothing to copy, cut or remove', () => {
    useModelStore.setState({ selectedItems: [] })
    expect(copySelection()).toBeNull()
    expect(cutSelection()).toBeNull()
    expect(removeSelectionFromDiagram()).toBe(false)
  })
})

describe('read-only', () => {
  it('a read-only workspace refuses a paste', async () => {
    copySelection()
    useModelStore.setState({ workspaceReadOnly: true })
    expect(await pastePayload(rememberedClipboard()!)).toBeNull()
    expect(store().objects).toHaveLength(2)
  })
})
