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
import { useUIStore } from './uiStore'
import type { C4Object, Connection, Diagram, Group } from '../types'
import { pendingPlacementIntents } from '../lib/automerge/placementIntents'
import { currentWorkspaceRef, setActiveWorkspaceRef, workspaceRefKey } from '../lib/automerge/workspace'
import { projectDecisionRecordPage } from '../lib/automerge/bridge'
import { IDLE_MS, MAX_ENTRIES, undoHistory } from '../lib/history/undoHistory'

// Store-level behaviour of canvas undo/redo: the real actions, the real
// recorder installed by modelStore, the real apply path (`applyHistoryDiff`).

const workspaceKey = (): string => workspaceRefKey(currentWorkspaceRef())
const scope = (diagramId = 'd1'): string => `${workspaceKey()}::${diagramId}`

function object(id: string, x: number): C4Object {
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
  } as C4Object
}

const layout = (x: number, y = 0) => ({ position: { x, y }, size: { width: 160, height: 90 } })

/** What one separate user gesture looks like to the recorder: a new task, and
 * the canvas sealed the previous entry (pointerdown / keydown / focusout). */
function nextGesture(): void {
  undoHistory.seal()
  undoHistory.endTask()
}

const store = () => useModelStore.getState()
const obj = (id: string) => store().objects.find((o) => o.id === id)
const diagram = (id = 'd1') => store().diagrams.find((d) => d.id === id)!

beforeEach(() => {
  pendingPlacementIntents.clearWorkspace(workspaceKey())
  useUIStore.setState({ canvasViewMode: '2d', currentView: 'diagram' })
  useModelStore.setState({
    objects: [object('A', 0), object('B', 400)],
    connections: [{ id: 'c1', fromId: 'A', toId: 'B', type: 'solid' } as Connection],
    groups: [{
      id: 'g1', name: 'Group', color: '#888888', objectIds: ['A'],
      autoSize: true, tagAssignments: {}, tagOrder: [],
    } as Group],
    diagrams: [
      {
        id: 'd1', name: 'One', type: 'context',
        objectIds: ['A', 'B'], connectionIds: ['c1'], groupIds: ['g1'],
        layouts: { A: layout(0), B: layout(400), g1: layout(-20, -20) },
      } as Diagram,
      {
        id: 'd2', name: 'Two', type: 'context',
        objectIds: ['A'], connectionIds: [], groupIds: [],
        layouts: { A: layout(50) },
      } as Diagram,
    ],
    currentDiagramId: 'd1',
    selectedItems: [],
    workspaceReadOnly: false,
    pendingDeletedObjectIds: [],
    pendingDeletedConnectionIds: [],
    pendingDeletedGroupIds: [],
  })
  undoHistory.clear()
  undoHistory.pointerHeld = false
  undoHistory.now = () => Date.now()
  nextGesture()
})

/** A peer's write: the bridge applies it with setState, never through an action. */
function peerMovesA(x: number): void {
  useModelStore.setState({
    diagrams: store().diagrams.map((d) => (d.id === 'd1' ? { ...d, layouts: { ...d.layouts, A: layout(x) } } : d)),
  })
}
function peerRenamesA(name: string): void {
  useModelStore.setState({ objects: store().objects.map((o) => (o.id === 'A' ? { ...o, name } : o)) })
}

describe('undo/redo of shape creation and deletion', () => {
  it('undoes an add with an EXPLICIT delete intent, and redo restores a fresh reference', () => {
    const id = store().addObject({ ...object('x', 0), name: 'New' })
    expect(undoHistory.sizes(scope())).toEqual({ undo: 1, redo: 0 })
    const created = obj(id)!

    expect(undoHistory.undo()).toBe(true)
    expect(obj(id)).toBeUndefined()
    expect(diagram().objectIds).not.toContain(id)
    expect(diagram().layouts?.[id]).toBeUndefined()
    // Without the intent the bridge would treat the absence as a projection gap
    // and the shape would come back on the next reload.
    expect(store().pendingDeletedObjectIds).toContain(id)

    expect(undoHistory.redo()).toBe(true)
    const restored = obj(id)!
    expect(restored).toEqual(created)
    // A fresh reference is what makes the bridge write it (and lift the tombstone).
    expect(restored).not.toBe(created)
    expect(store().pendingDeletedObjectIds).not.toContain(id)
    expect(diagram().objectIds).toContain(id)
  })

  it('undoes a model delete: entity, incident connection, membership and layout on THIS diagram, group membership', () => {
    const original = obj('A')!
    store().deleteObject('A')
    expect(obj('A')).toBeUndefined()
    expect(store().connections.find((c) => c.id === 'c1')).toBeUndefined()

    undoHistory.undo()
    expect(obj('A')).toEqual(original)
    expect(obj('A')).not.toBe(original)
    expect(store().connections.find((c) => c.id === 'c1')).toBeDefined()
    expect(diagram('d1').objectIds).toContain('A')
    expect(diagram('d1').connectionIds).toContain('c1')
    expect(diagram('d1').layouts?.A).toEqual(layout(0))
    expect(store().groups[0].objectIds).toContain('A')
  })

  it('does not put an element back on ANOTHER diagram (its composition would not persist): a partial undo', () => {
    // Under a sharded registry a non-active diagram's composition is rebuilt
    // from its registry meta, which the delete already stripped; growing it in
    // the store alone would show until the next reload and then vanish.
    let partial = 0
    const host = { ...(undoHistory as unknown as { host: Parameters<typeof undoHistory.configure>[0] }).host! }
    undoHistory.configure({ ...host, onPartial: (skipped) => { partial += skipped } })
    try {
      store().deleteObject('A')
      undoHistory.undo()
      expect(diagram('d2').objectIds).not.toContain('A')
      expect(partial).toBeGreaterThan(0)
    } finally {
      undoHistory.configure(host)
    }
  })

  it('undoes a multi-selection delete as ONE entry', () => {
    useModelStore.setState({ selectedItems: [{ id: 'A', type: 'object' }, { id: 'B', type: 'object' }] })
    store().deleteSelectedItems()
    expect(store().objects).toHaveLength(0)
    expect(undoHistory.sizes(scope()).undo).toBe(1)
    undoHistory.undo()
    expect(store().objects.map((o) => o.id).sort()).toEqual(['A', 'B'])
    expect(store().connections.map((c) => c.id)).toEqual(['c1'])
    // Selection comes back with the shapes.
    expect(store().selectedItems.map((s) => s.id).sort()).toEqual(['A', 'B'])
  })

  it('undoes "remove from diagram" without touching the model', () => {
    store().removeObjectsFromDiagram(['B'])
    expect(diagram().objectIds).not.toContain('B')
    expect(diagram().connectionIds).not.toContain('c1')
    undoHistory.undo()
    expect(diagram().objectIds).toContain('B')
    expect(diagram().connectionIds).toContain('c1')
    expect(store().pendingDeletedObjectIds).toEqual([])
  })
})

describe('placements', () => {
  it('undoes a move and journals the restored placement', () => {
    store().updatePlacementsBatch({ objects: [{ id: 'A', position: { x: 300, y: 200 } }] })
    expect(diagram().layouts?.A.position).toEqual({ x: 300, y: 200 })
    pendingPlacementIntents.clearWorkspace(workspaceKey())
    const revision = store().placementRevision

    undoHistory.undo()
    expect(diagram().layouts?.A.position).toEqual({ x: 0, y: 0 })
    expect(store().placementRevision).toBeGreaterThan(revision)
    const journaled = pendingPlacementIntents.snapshot(workspaceKey(), 'd1')
    expect(journaled?.objects.find((o) => o.id === 'A')?.position).toEqual({ x: 0, y: 0 })

    undoHistory.redo()
    expect(diagram().layouts?.A.position).toEqual({ x: 300, y: 200 })
  })

  it('a 3D move undone from the 2D view restores only the 3D layer, and the fork is not part of the entry', () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    store().moveObject('A', { x: 999, y: 999 })
    expect(diagram().layouts3d?.A.position).toEqual({ x: 999, y: 999 })
    // The fork copied B too; it did not MOVE, so it is not something to undo.
    expect(diagram().layouts3d?.B).toEqual(layout(400))

    useUIStore.setState({ canvasViewMode: '2d' })
    undoHistory.undo()
    expect(diagram().layouts3d?.A.position).toEqual({ x: 0, y: 0 })
    expect(diagram().layouts?.A).toEqual(layout(0))
    expect(diagram().layouts?.B).toEqual(layout(400))
  })

  it('a 3D drag on a never-forked diagram undoes and REDOES on the board', () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    undoHistory.pointerHeld = true
    for (let x = 10; x <= 50; x += 10) {
      store().moveObject('A', { x, y: 5 })
      undoHistory.endTask()
    }
    undoHistory.pointerHeld = false
    expect(undoHistory.sizes(scope()).undo).toBe(1)
    expect(undoHistory.undo()).toBe(true)
    expect(diagram().layouts3d?.A.position).toEqual({ x: 0, y: 0 })
    nextGesture()
    expect(undoHistory.redo()).toBe(true)
    expect(diagram().layouts3d?.A.position).toEqual({ x: 50, y: 5 })
  })

  it('a live drag (many writes while the pointer is held) is ONE entry, even across tasks', () => {
    // Each frame lands LATER than IDLE_MS after the previous one (a slow drag,
    // or a drag paused mid-air): only the held pointer keeps it one entry. With
    // the real clock the frames are microseconds apart and the idle window alone
    // would join them, so this test could not tell whether `pointerHeld` works.
    let t = 1_000_000
    undoHistory.now = () => t
    undoHistory.pointerHeld = true
    for (let x = 10; x <= 100; x += 10) {
      store().moveObject('A', { x, y: 0 })
      undoHistory.endTask()
      t += IDLE_MS * 2
    }
    undoHistory.pointerHeld = false
    expect(undoHistory.sizes(scope()).undo).toBe(1)
    undoHistory.undo()
    expect(diagram().layouts?.A.position).toEqual({ x: 0, y: 0 })
  })

  it('a placement a peer moved since stays where the peer put it', () => {
    store().updatePlacementsBatch({ objects: [{ id: 'A', position: { x: 300, y: 200 } }] })
    peerMovesA(777)
    undoHistory.undo()
    expect(diagram().layouts?.A).toEqual(layout(777))
  })

  it('undoing "Align 3D with 2D" (the 3D layer deleted) brings the 3D placement back', () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    store().moveObject('A', { x: 999, y: 999 })
    nextGesture()
    store().resetDiagram3dLayout()
    expect(diagram().layouts3d).toBeUndefined()
    // With no 3D layer the board SHOWS the 2D placement: that is the value the
    // reset left, and what the undo must compare against.
    undoHistory.undo()
    expect(diagram().layouts3d?.A.position).toEqual({ x: 999, y: 999 })
    expect(diagram().layouts?.A).toEqual(layout(0))
  })

  it('an undone GROUP move is journaled as a group placement', () => {
    store().updatePlacementsBatch({ groups: [{ id: 'g1', position: { x: 500, y: 500 } }] })
    expect(diagram().layouts?.g1.position).toEqual({ x: 500, y: 500 })
    pendingPlacementIntents.clearWorkspace(workspaceKey())
    undoHistory.undo()
    expect(diagram().layouts?.g1).toEqual(layout(-20, -20))
    const journaled = pendingPlacementIntents.snapshot(workspaceKey(), 'd1')
    expect(journaled?.groups.map((g) => g.id)).toContain('g1')
    expect(journaled?.objects.map((o) => o.id)).not.toContain('g1')
  })

  it('a group restored by undoing its delete is journaled as a group placement', () => {
    store().deleteGroup('g1')
    expect(store().groups.find((g) => g.id === 'g1')).toBeUndefined()
    pendingPlacementIntents.clearWorkspace(workspaceKey())
    undoHistory.undo()
    expect(store().groups.find((g) => g.id === 'g1')).toBeDefined()
    const journaled = pendingPlacementIntents.snapshot(workspaceKey(), 'd1')
    expect(journaled?.groups.map((g) => g.id)).toContain('g1')
    expect(journaled?.objects.map((o) => o.id)).not.toContain('g1')
  })

  it('undoing a model delete journals the placements but does NOT take the placement-only write path', () => {
    // A placementRevision bump makes the bridge schedule a 'placement' write,
    // which does not arm the full model write: the restored ENTITY would then
    // not be persisted. Only a placement-only step may bump it.
    store().deleteObject('A')
    pendingPlacementIntents.clearWorkspace(workspaceKey())
    const revision = store().placementRevision
    undoHistory.undo()
    expect(obj('A')).toBeDefined()
    const journaled = pendingPlacementIntents.snapshot(workspaceKey(), 'd1')
    expect(journaled?.objects.find((o) => o.id === 'A')?.position).toEqual({ x: 0, y: 0 })
    expect(store().placementRevision).toBe(revision)
  })
})

describe('coalescing and stack rules', () => {
  it('a typing burst is one entry; a sealed burst starts a new one', () => {
    store().updateObject('A', { name: 'A1' })
    undoHistory.endTask()
    store().updateObject('A', { name: 'A12' })
    undoHistory.endTask()
    store().updateObject('A', { name: 'A123' })
    expect(undoHistory.sizes(scope()).undo).toBe(1)

    nextGesture()
    store().updateObject('A', { name: 'Other' })
    expect(undoHistory.sizes(scope()).undo).toBe(2)

    undoHistory.undo()
    expect(obj('A')!.name).toBe('A123')
    undoHistory.undo()
    expect(obj('A')!.name).toBe('A')
  })

  it('a field session is one entry however long the pauses; idle time alone splits outside a field', () => {
    let clock = 0
    undoHistory.now = () => clock
    try {
      undoHistory.editingField = () => true
      store().updateObject('A', { name: 'A1' })
      undoHistory.endTask()
      clock += 5000
      store().updateObject('A', { name: 'A12' })
      expect(undoHistory.sizes(scope()).undo).toBe(1)

      undoHistory.editingField = () => false
      undoHistory.endTask()
      clock += 5000
      store().updateObject('A', { name: 'A123' })
      expect(undoHistory.sizes(scope()).undo).toBe(2)
    } finally {
      undoHistory.editingField = () => false
      undoHistory.now = () => Date.now()
    }
  })

  it('a new action clears redo', () => {
    store().updateObject('A', { name: 'one' })
    undoHistory.undo()
    expect(undoHistory.sizes(scope()).redo).toBe(1)
    nextGesture()
    store().updateObject('B', { name: 'two' })
    expect(undoHistory.sizes(scope()).redo).toBe(0)
  })

  it('caps the stack', () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      store().updateObject('A', { name: `n${i}` })
      nextGesture()
    }
    expect(undoHistory.sizes(scope()).undo).toBe(MAX_ENTRIES)
  })

  it('the cap evicts the OLDEST entries, never recent ones', () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      store().updateObject('A', { name: `n${i}` })
      nextGesture()
    }
    expect(undoHistory.undo()).toBe(true)
    expect(obj('A')!.name).toBe(`n${MAX_ENTRIES + 3}`)
    expect(undoHistory.undo()).toBe(true)
    expect(obj('A')!.name).toBe(`n${MAX_ENTRIES + 2}`)
    while (undoHistory.undo()) { /* drain */ }
    // Entries 5..104 were kept; the oldest of them started from n4.
    expect(obj('A')!.name).toBe('n4')
  })

  it('an unsealed edit of the same thing joins the entry only within IDLE_MS', () => {
    let t = 1_000_000
    undoHistory.now = () => t
    store().updateObject('A', { name: 'A1' })
    undoHistory.endTask()
    t += IDLE_MS - 1
    store().updateObject('A', { name: 'A12' })
    undoHistory.endTask()
    expect(undoHistory.sizes(scope()).undo).toBe(1)
    t += IDLE_MS + 1
    store().updateObject('A', { name: 'A123' })
    expect(undoHistory.sizes(scope()).undo).toBe(2)
    undoHistory.undo()
    expect(obj('A')!.name).toBe('A12')
  })

  it('a workspace switch forgets the history, even after switching back', () => {
    store().updateObject('A', { name: 'x' })
    expect(undoHistory.sizes(scope()).undo).toBe(1)
    const ref = currentWorkspaceRef()
    try {
      setActiveWorkspaceRef({ landscapeId: 'qa-other-landscape', versionId: 'current' })
    } finally {
      setActiveWorkspaceRef(ref)
    }
    expect(undoHistory.sizes(scope()).undo).toBe(0)
    expect(undoHistory.undo()).toBe(false)
    expect(obj('A')!.name).toBe('x')
  })

  it('stacks are per diagram', () => {
    store().updateObject('A', { name: 'on d1' })
    nextGesture()
    useModelStore.setState({ currentDiagramId: 'd2' })
    expect(undoHistory.undo()).toBe(false)
    expect(obj('A')!.name).toBe('on d1')
    useModelStore.setState({ currentDiagramId: 'd1' })
    expect(undoHistory.undo()).toBe(true)
    expect(obj('A')!.name).toBe('A')
  })

  it('records nothing outside the diagram canvas or on a read-only workspace', () => {
    useUIStore.setState({ currentView: 'model-objects' })
    store().updateObject('A', { name: 'table edit' })
    useUIStore.setState({ currentView: 'diagram' })
    useModelStore.setState({ workspaceReadOnly: true })
    store().updateObject('A', { name: 'readonly' })
    useModelStore.setState({ workspaceReadOnly: false })
    expect(undoHistory.sizes(scope()).undo).toBe(0)
  })
})

describe('peers: the user only ever undoes their own edits', () => {
  it('a remote setState is never recorded', () => {
    useModelStore.setState({ objects: store().objects.map((o) => (o.id === 'A' ? { ...o, name: 'peer' } : o)) })
    expect(undoHistory.sizes(scope()).undo).toBe(0)
  })

  it('a field a peer changed since stays the peer\'s; the rest of the entry is undone', () => {
    store().updateObject('A', { name: 'mine', status: 'down' })
    useModelStore.setState({ objects: store().objects.map((o) => (o.id === 'A' ? { ...o, name: 'peer' } : o)) })
    expect(undoHistory.undo()).toBe(true)
    expect(obj('A')!.name).toBe('peer')
    expect(obj('A')!.status).toBe('live')
    // Redo replays only what the undo did.
    undoHistory.redo()
    expect(obj('A')!.name).toBe('peer')
    expect(obj('A')!.status).toBe('down')
  })

  it('an entry a peer fully overwrote is dropped and the previous one is undone instead', () => {
    store().updateObject('B', { name: 'first' })
    nextGesture()
    store().updateObject('A', { name: 'second' })
    useModelStore.setState({ objects: store().objects.map((o) => (o.id === 'A' ? { ...o, name: 'peer' } : o)) })
    expect(undoHistory.undo()).toBe(true)
    expect(obj('A')!.name).toBe('peer')
    expect(obj('B')!.name).toBe('B')
  })

  it('does not delete a shape it created once a peer connected something to it', () => {
    const id = store().addObject({ ...object('x', 0), name: 'Mine' })
    useModelStore.setState({
      connections: [...store().connections, { id: 'peer-c', fromId: 'B', toId: id, type: 'solid' } as Connection],
    })
    undoHistory.undo()
    expect(obj(id)).toBeDefined()
    expect(store().pendingDeletedObjectIds).not.toContain(id)
  })

  it('a peer edit landing BETWEEN two keystrokes of one typing burst is not reverted by undo', () => {
    store().updateObject('A', { shortDescription: 'd' })
    undoHistory.endTask()
    useModelStore.setState({ objects: store().objects.map((o) => (o.id === 'A' ? { ...o, name: 'peer' } : o)) })
    store().updateObject('A', { shortDescription: 'de' })
    expect(undoHistory.sizes(scope()).undo).toBe(1)
    undoHistory.undo()
    expect(obj('A')!.name).toBe('peer')
    expect(obj('A')!.shortDescription).toBeUndefined()
  })

  it('undoing a created connection keeps it when a peer drew it on another diagram', () => {
    const id = store().addConnection({ fromId: 'B', toId: 'A', type: 'solid' })
    useModelStore.setState({
      diagrams: store().diagrams.map((d) => (d.id === 'd2' ? { ...d, objectIds: ['A', 'B'], connectionIds: [id] } : d)),
    })
    undoHistory.undo()
    expect(store().connections.find((c) => c.id === id)).toBeDefined()
    expect(diagram('d2').connectionIds).toEqual([id])
  })

  it('undoing a created system keeps it once a peer gave it children or a detail diagram', () => {
    const id = store().addObject({ ...object('x', 0), type: 'system', name: 'Mine' })
    useModelStore.setState({ objects: [...store().objects, { ...object('kid', 0), parentId: id }] })
    undoHistory.undo()
    expect(obj(id)).toBeDefined()

    nextGesture()
    const id2 = store().addObject({ ...object('y', 0), type: 'system', name: 'Mine too' })
    useModelStore.setState({
      diagrams: [...store().diagrams, { id: 'detail', name: 'detail', type: 'container', parentObjectId: id2, objectIds: [], connectionIds: [], groupIds: [] } as Diagram],
    })
    undoHistory.undo()
    expect(obj(id2)).toBeDefined()
  })

  it('a remote write inside a recorded action is subtracted from it', () => {
    const unsubscribe = useModelStore.subscribe((next, previous) => {
      if (next.objects === previous.objects) return
      if (next.objects.some((o) => o.id === 'peer-obj')) return
      const before = useModelStore.getState()
      useModelStore.setState({ objects: [...next.objects, object('peer-obj', 900)] })
      undoHistory.noteRemote(before, useModelStore.getState())
    })
    store().updateObject('A', { name: 'mine' })
    unsubscribe()
    undoHistory.undo()
    expect(obj('A')!.name).toBe('A')
    expect(obj('peer-obj')).toBeDefined()
    expect(store().pendingDeletedObjectIds).not.toContain('peer-obj')
  })

  it('redo does not replay a field the undo left to a peer, even once the peer set it back to our "before"', () => {
    store().updateObject('A', { name: 'mine', status: 'down' })
    peerRenamesA('peer')
    undoHistory.undo()
    expect(obj('A')!.name).toBe('peer')
    expect(obj('A')!.status).toBe('live')
    // The peer reverts its own rename. `name` now matches what the redo would
    // expect to find, but the undo never wrote it: the redo must not either.
    peerRenamesA('A')
    undoHistory.redo()
    expect(obj('A')!.status).toBe('down')
    expect(obj('A')!.name).toBe('A')
  })

  it('a derived lower connection onto a created shape does not stop its undo, and is swept with it', () => {
    const id = store().addObject({ ...object('x', 0), name: 'Mine' })
    // The roll-up (not the user) later derives a lower connection onto it.
    useModelStore.setState({
      connections: [...store().connections, { id: 'low-x', fromId: id, toId: 'B', type: 'solid', kind: 'lower' } as Connection],
      diagrams: store().diagrams.map((d) => (d.id === 'd1' ? { ...d, connectionIds: [...d.connectionIds, 'low-x'] } : d)),
    })
    expect(undoHistory.undo()).toBe(true)
    expect(obj(id)).toBeUndefined()
    expect(store().pendingDeletedObjectIds).toContain(id)
    expect(store().connections.find((c) => c.id === 'low-x')).toBeUndefined()
    expect(diagram().connectionIds).not.toContain('low-x')
  })

  it('the sync bridge reports a remote apply landing inside a recorded action (withRemote -> noteRemote)', () => {
    // The real bridge path, not a hand-made noteRemote call: a store subscriber
    // reacts to the user's edit with a bridge projection (withRemote), and a
    // write it drags in lands under the same remote flag.
    let projected = false
    const offProject = useModelStore.subscribe((next, previous) => {
      if (projected || next.objects === previous.objects) return
      projected = true
      projectDecisionRecordPage([])
    })
    const offPeer = useModelStore.subscribe((next, previous) => {
      if (next.decisionRecords === previous.decisionRecords) return
      if (next.objects.some((o) => o.id === 'peer-obj')) return
      useModelStore.setState({ objects: [...next.objects, object('peer-obj', 900)] })
    })
    try {
      store().updateObject('A', { name: 'mine' })
    } finally {
      offProject()
      offPeer()
    }
    expect(projected).toBe(true)
    expect(obj('peer-obj')).toBeDefined()
    undoHistory.undo()
    expect(obj('A')!.name).toBe('A')
    expect(obj('peer-obj')).toBeDefined()
    expect(store().pendingDeletedObjectIds).not.toContain('peer-obj')
  })

  it('undoing a delete does not restore a connection whose other end a peer deleted since', () => {
    store().deleteObject('A') // takes c1 (A → B) with it
    // Peer deletes B (a remote projection: plain setState, membership included).
    useModelStore.setState({
      objects: store().objects.filter((o) => o.id !== 'B'),
      diagrams: store().diagrams.map((d) => ({ ...d, objectIds: d.objectIds.filter((id) => id !== 'B') })),
    })
    expect(undoHistory.undo()).toBe(true)
    expect(obj('A')).toBeDefined()
    // A dangling c1 would be written durably and listed as "Unknown → Unknown".
    expect(store().connections.find((c) => c.id === 'c1')).toBeUndefined()
    expect(diagram().connectionIds).not.toContain('c1')
  })

  it('undoing "remove from diagram" does not put back an element a peer deleted since', () => {
    store().removeObjectsFromDiagram(['B'])
    useModelStore.setState({ objects: store().objects.filter((o) => o.id !== 'B') })
    undoHistory.undo()
    expect(diagram().objectIds).not.toContain('B')
  })

  it('suppressed writes (crash replay) are not recorded', () => {
    undoHistory.suppress(() => store().deleteObject('B'))
    expect(undoHistory.sizes(scope()).undo).toBe(0)
  })
})

describe('groups and connections', () => {
  it('undoes a group created and placed in one gesture', () => {
    const gid = store().addGroup({ name: 'New', color: '#000', objectIds: [] })
    store().addGroupToDiagram(gid)
    expect(undoHistory.sizes(scope()).undo).toBe(1)
    undoHistory.undo()
    expect(store().groups.find((g) => g.id === gid)).toBeUndefined()
    expect(diagram().groupIds).not.toContain(gid)
    expect(store().pendingDeletedGroupIds).toContain(gid)
  })

  it('undoes group membership changes', () => {
    store().addObjectToGroup('B', 'g1')
    undoHistory.undo()
    expect(store().groups[0].objectIds).toEqual(['A'])
  })

  it('undoes a connection reroute and a connection delete', () => {
    store().updateConnection('c1', { waypoints: [{ x: 1, y: 2 }], label: 'calls' })
    nextGesture()
    store().deleteConnection('c1')
    undoHistory.undo()
    expect(diagram().connectionIds).toContain('c1')
    undoHistory.undo()
    const c = store().connections.find((x) => x.id === 'c1')!
    expect(c.waypoints).toBeUndefined()
    expect(c.label).toBeUndefined()
  })
})
