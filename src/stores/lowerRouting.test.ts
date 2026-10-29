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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __lowerSyncForTest, useModelStore } from './modelStore'
import { useUIStore } from './uiStore'
import { filterAndMergeDiagramData } from '../lib/viewLayouts'
import { diagramDocToDiagram, diagramToDiagramDoc } from '../lib/automerge/projection'
import { pendingPlacementIntents } from '../lib/automerge/placementIntents'
import { currentWorkspaceRef, workspaceRefKey } from '../lib/automerge/workspace'
import { buildDuplicateDiagram } from '../lib/diagrams/duplicate'
import type { C4Object, Connection, Diagram } from '../types'

// Defect reported 2026-10-21 (SAOE import, FSSystemContext): after Auto-layout
// the reciprocal pair Inspecteur ↔ Power Platform — two derived (`kind:
// 'lower'`) connections A→B and B→A — drew as ONE braided double line, and
// lowers that needed an obstacle detour cut straight through shapes. The
// routing Auto-layout wrote was on the lower objects; within ~2 s the bridge's
// projectAll replaced `connections` from the model shards (which hold no
// lowers) and syncLowerConnections minted new lowers, with new ids and no
// routing. After a reload nothing was left at all.

function obj(id: string, over: Partial<C4Object> = {}): C4Object {
  return {
    id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...over,
  } as C4Object
}
function conn(id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection {
  return { id, fromId, toId, type: 'solid', kind: 'direct', ...over }
}
function diagram(over: Partial<Diagram> = {}): Diagram {
  return { id: 'd1', name: 'D1', type: 'context', objectIds: [], connectionIds: [], groupIds: [], ...over }
}

// Systems S and P on the diagram; their children talk both ways, so the diagram
// needs the reciprocal lowers S→P and P→S.
function seed(): void {
  useModelStore.setState({
    objects: [
      obj('S', { type: 'system' }),
      obj('P', { type: 'system' }),
      obj('s1', { parentId: 'S' }),
      obj('p1', { parentId: 'P' }),
    ],
    connections: [conn('c1', 's1', 'p1'), conn('c2', 'p1', 's1')],
    groups: [],
    diagrams: [diagram({ objectIds: ['S', 'P'] })],
    domains: [],
    currentDiagramId: 'd1',
    selectedItems: [],
  })
  useModelStore.getState().syncLowerConnections('d1')
}

const state = () => useModelStore.getState()
const lowers = () => state().connections.filter((c) => c.kind === 'lower')
const lowerFor = (fromId: string, toId: string) => lowers().find((c) => c.fromId === fromId && c.toId === toId)!
const d1 = () => state().diagrams.find((d) => d.id === 'd1')!

/** The connections the canvas draws for d1 (the same merge CanvasView, the 3D
 * view, the share viewer and the exporters feed their engines). */
function drawn(space: '2d' | '3d' = '2d'): Map<string, Connection> {
  const s = state()
  const { filteredConnections } = filterAndMergeDiagramData(d1(), s.objects, s.connections, s.groups, space)
  return new Map(filteredConnections.map((c) => [`${c.fromId}→${c.toId}`, c]))
}

/** Auto-layout's result for the pair: two ports per edge, so the two lines of
 * the reciprocal pair leave and arrive at different anchors. */
function autoLayout(space?: '2d' | '3d'): void {
  useModelStore.getState().applyDiagramLayout(
    'd1',
    {
      S: { position: { x: 0, y: 0 }, size: { width: 160, height: 90 } },
      P: { position: { x: 500, y: 0 }, size: { width: 160, height: 90 } },
    },
    [
      { id: lowerFor('S', 'P').id, fromAnchor: 4, toAnchor: 10, lockedToAnchors: true, waypoints: [{ x: 330, y: -40 }] },
      { id: lowerFor('P', 'S').id, fromAnchor: 8, toAnchor: 2, lockedToAnchors: true },
    ],
    space,
  )
}

/** What bridge.ts projectAll does to the store on ANY model-doc change: the
 * shard / model merge holds no lowers, and the diagram is rebuilt from its
 * DiagramDoc, whose connectionIds never list them. */
function projectFromDocs(): void {
  const doc = diagramToDiagramDoc(
    { ...d1(), connectionIds: d1().connectionIds.filter((id) => !lowers().some((l) => l.id === id)) },
    [],
    [],
  )
  useModelStore.setState({
    connections: state().connections.filter((c) => c.kind !== 'lower'),
    diagrams: [diagramDocToDiagram('d1', JSON.parse(JSON.stringify(doc)))],
  })
}

beforeEach(() => {
  useUIStore.setState({ canvasViewMode: '2d' })
  seed()
})

afterEach(() => {
  pendingPlacementIntents.clearWorkspace(workspaceRefKey(currentWorkspaceRef()))
  __lowerSyncForTest.reset()
  __lowerSyncForTest.setClock(null)
  useUIStore.setState({ canvasViewMode: '2d' })
})

describe('lower routing is the diagram\'s, and survives re-projection and reload', () => {
  it('keeps the two lines of a reciprocal pair on their own ports across the projection that re-mints the lowers', () => {
    autoLayout()
    const idsBefore = lowers().map((c) => c.id).sort()

    projectFromDocs()
    useModelStore.getState().syncLowerConnections('d1')

    expect(lowers().map((c) => c.id).sort()).toEqual(idsBefore)
    const lines = drawn()
    expect(lines.get('S→P')).toMatchObject({ fromAnchor: 4, toAnchor: 10, lockedToAnchors: true, waypoints: [{ x: 330, y: -40 }] })
    expect(lines.get('P→S')).toMatchObject({ fromAnchor: 8, toAnchor: 2, lockedToAnchors: true })
    expect(lines.get('P→S')?.waypoints).toBeUndefined()
  })

  it('survives a reload: the DiagramDoc carries the routing by pair, and freshly derived lowers draw with it', () => {
    autoLayout()
    const doc = diagramToDiagramDoc(
      { ...d1(), connectionIds: d1().connectionIds.filter((id) => !id.startsWith('lower:')) },
      [],
      [],
    )
    expect(Object.keys(doc.lowerRouting ?? {}).sort()).toEqual(['P→S', 'S→P'])

    // A new tab: the store holds only what the documents hold.
    useModelStore.setState({
      connections: [conn('c1', 's1', 'p1'), conn('c2', 'p1', 's1')],
      diagrams: [diagramDocToDiagram('d1', JSON.parse(JSON.stringify(doc)))],
    })
    useModelStore.getState().syncLowerConnections('d1')

    const lines = drawn()
    expect(lines.get('S→P')).toMatchObject({ fromAnchor: 4, toAnchor: 10, lockedToAnchors: true })
    expect(lines.get('P→S')).toMatchObject({ fromAnchor: 8, toAnchor: 2, lockedToAnchors: true })
  })

  it('a new DiagramDoc is created WITH an empty `lowerRouting` map (like `layouts`), so two peers never race to create it', () => {
    const doc = diagramToDiagramDoc(diagram({ id: 'd9' }), [], [])
    expect(doc.lowerRouting).toEqual({})
  })

  it('names a lower by its pair, the id the server render gives it', () => {
    expect(lowerFor('S', 'P').id).toBe('lower:S→P')
    expect(lowerFor('P', 'S').id).toBe('lower:P→S')
  })

  it('never writes the routing onto the shared lower object', () => {
    autoLayout()
    expect(lowerFor('S', 'P')).not.toHaveProperty('fromAnchor')
    expect(lowerFor('S', 'P')).not.toHaveProperty('waypoints')
  })

  it('journals the routing as diagram-scoped records, not model connection records', () => {
    autoLayout()
    const snapshot = pendingPlacementIntents.snapshot(workspaceRefKey(currentWorkspaceRef()), 'd1')!
    expect(snapshot.connections).toEqual([])
    expect(snapshot.lowerRoutes.map((route) => route.pair).sort()).toEqual(['P→S', 'S→P'])
    expect(snapshot.lowerRoutes.find((route) => route.pair === 'S→P')?.routing).toMatchObject({ fromAnchor: 4, toAnchor: 10 })
  })

  it('a 3D Auto-layout lands on the 3D twins of the entry and leaves the 2D routing alone', () => {
    autoLayout('2d')
    useModelStore.getState().applyDiagramLayout(
      'd1',
      {},
      [{ id: lowerFor('S', 'P').id, fromAnchor: 1, toAnchor: 7, lockedToAnchors: true }],
      '3d',
    )
    expect(d1().lowerRouting?.['S→P']).toMatchObject({ fromAnchor: 4, toAnchor: 10, fromAnchor3d: 1, toAnchor3d: 7, waypoints3d: [] })
    expect(drawn('3d').get('S→P')).toMatchObject({ fromAnchor: 1, toAnchor: 7, waypoints: [] })
    expect(drawn('2d').get('S→P')).toMatchObject({ fromAnchor: 4, toAnchor: 10 })
  })
})

describe('manual routing edits of a lower go to the diagram too', () => {
  it('updateConnection writes the entry, journals it, and — a batch of nothing but lower routing — selects the targeted write', () => {
    const revision = state().placementRevision
    useModelStore.getState().updateConnection(lowerFor('S', 'P').id, { fromAnchor: 6, lockedToAnchors: true })
    expect(d1().lowerRouting?.['S→P']).toEqual({ fromAnchor: 6, lockedToAnchors: true })
    expect(lowerFor('S', 'P')).not.toHaveProperty('fromAnchor')
    expect(pendingPlacementIntents.snapshot(workspaceRefKey(currentWorkspaceRef()), 'd1')?.lowerRoutes).toEqual([
      { pair: 'S→P', routing: { fromAnchor: 6, lockedToAnchors: true }, space: '2d' },
    ])
    expect(state().placementRevision).toBeGreaterThan(revision)
  })

  it('a batch that also edits a direct connection does NOT select the targeted write (it would skip that edit)', () => {
    useModelStore.setState({ connections: [...state().connections, conn('cSP', 'S', 'P')] })
    const revision = state().placementRevision
    useModelStore.getState().updateConnectionsBatch([
      { id: lowerFor('S', 'P').id, data: { fromAnchor: 6, lockedToAnchors: true } },
      { id: 'cSP', data: { label: 'calls' } },
    ])
    expect(d1().lowerRouting?.['S→P']).toEqual({ fromAnchor: 6, lockedToAnchors: true })
    expect(state().connections.find((c) => c.id === 'cSP')?.label).toBe('calls')
    expect(state().placementRevision).toBe(revision)
  })

  it('the canvas anchor drag — which names the shape the end is ALREADY on — re-routes the lower as drawn', () => {
    // CanvasView/Canvas3DView onConnectionAnchorMove send fromId/toId with the anchor.
    autoLayout()
    useModelStore.getState().updateConnection(lowerFor('S', 'P').id, { fromId: 'S', fromAnchor: 7, lockedToAnchors: true })
    expect(drawn().get('S→P')).toMatchObject({ fromAnchor: 7, toAnchor: 10, lockedToAnchors: true })
    expect(lowerFor('S', 'P')).not.toHaveProperty('fromAnchor')
    useModelStore.getState().updateConnection(lowerFor('S', 'P').id, { toId: 'P', toAnchor: 1, lockedToAnchors: true })
    expect(drawn().get('S→P')).toMatchObject({ fromAnchor: 7, toAnchor: 1 })
  })

  it('re-pointing a lower\'s end to another shape is refused (its endpoints are derived)', () => {
    autoLayout()
    const before = d1().lowerRouting?.['S→P']
    useModelStore.getState().updateConnection(lowerFor('S', 'P').id, { fromId: 'p1', fromAnchor: 3, lockedToAnchors: true })
    __lowerSyncForTest.drain()
    expect(state().connections.filter((c) => c.id === 'lower:S→P')).toHaveLength(1)
    expect(lowerFor('S', 'P')).toBeDefined()
    expect(state().connections.some((c) => c.kind === 'lower' && c.fromId === 'p1')).toBe(false)
    expect(d1().lowerRouting?.['S→P']).toEqual(before)
  })

  it('a first entry starts from what is drawn, so one edited field does not reset the others', () => {
    // A lower drawn with routing on its own object (no entry yet).
    useModelStore.setState({
      connections: state().connections.map((c) => (c.id === 'lower:S→P' ? { ...c, fromAnchor: 5, lockedToAnchors: true } : c)),
    })
    useModelStore.getState().updateConnection('lower:S→P', { waypoints: [{ x: 1, y: 1 }] })
    expect(drawn().get('S→P')).toMatchObject({ fromAnchor: 5, lockedToAnchors: true, waypoints: [{ x: 1, y: 1 }] })
  })

  it('a non-routing edit of a lower (its label) still lands on the object', () => {
    useModelStore.getState().updateConnection(lowerFor('S', 'P').id, { label: 'syncs', waypoints: [{ x: 1, y: 2 }] })
    expect(lowerFor('S', 'P').label).toBe('syncs')
    expect(lowerFor('S', 'P')).not.toHaveProperty('waypoints')
    expect(d1().lowerRouting?.['S→P']).toEqual({ waypoints: [{ x: 1, y: 2 }] })
  })

  it('clearing a field (waypoints: undefined) removes it from the entry', () => {
    autoLayout()
    useModelStore.getState().updateConnection(lowerFor('S', 'P').id, { waypoints: undefined })
    expect(d1().lowerRouting?.['S→P']).not.toHaveProperty('waypoints')
    expect(drawn().get('S→P')?.waypoints).toBeUndefined()
  })

  it('updatePlacementsBatch (a waypoint drag) writes the entry and journals it as a placement', () => {
    const revision = state().placementRevision
    useModelStore.getState().updatePlacementsBatch({
      connections: [{ id: lowerFor('P', 'S').id, data: { waypoints: [{ x: 250, y: 120 }] } }],
    })
    expect(d1().lowerRouting?.['P→S']).toEqual({ waypoints: [{ x: 250, y: 120 }] })
    expect(state().placementRevision).toBeGreaterThan(revision)
    const snapshot = pendingPlacementIntents.snapshot(workspaceRefKey(currentWorkspaceRef()), 'd1')!
    expect(snapshot.connections).toEqual([])
    expect(snapshot.lowerRoutes).toEqual([{ pair: 'P→S', routing: { waypoints: [{ x: 250, y: 120 }] }, space: '2d' }])
  })

  it('toggleConnectionLock flips the lock the lower is DRAWN with', () => {
    autoLayout()
    useModelStore.getState().toggleConnectionLock(lowerFor('S', 'P').id)
    expect(drawn().get('S→P')?.lockedToAnchors).toBe(false)
    useModelStore.getState().toggleConnectionLock(lowerFor('S', 'P').id)
    expect(drawn().get('S→P')?.lockedToAnchors).toBe(true)
  })

  it('a 3D edit forks the entry first, so a later 2D edit cannot move it on the board', () => {
    autoLayout()
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().updateConnection(lowerFor('S', 'P').id, { waypoints: [{ x: 9, y: 9 }] })
    expect(d1().lowerRouting?.['S→P']).toMatchObject({
      fromAnchor: 4, fromAnchor3d: 4, toAnchor3d: 10, lockedToAnchors3d: true, waypoints3d: [{ x: 9, y: 9 }],
      waypoints: [{ x: 330, y: -40 }],
    })
    useUIStore.setState({ canvasViewMode: '2d' })
    useModelStore.getState().updateConnection(lowerFor('S', 'P').id, { fromAnchor: 0 })
    expect(drawn('3d').get('S→P')?.fromAnchor).toBe(4)
  })

  // QA lens 2026-10-22: the next three killed mutants S2, S10/S11 and S8, which
  // the per-entry fork test above could not see.
  it('a first 3D edit of ONE lower forks the diagram and every OTHER lower entry', () => {
    autoLayout()
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().updateConnection(lowerFor('S', 'P').id, { waypoints: [{ x: 9, y: 9 }] })
    expect(d1().layouts3d).toBeDefined()
    expect(d1().lowerRouting?.['P→S']).toMatchObject({ fromAnchor3d: 8, toAnchor3d: 2, lockedToAnchors3d: true })
  })

  it('a first 3D waypoint drag of a lower (updatePlacementsBatch) forks the diagram', () => {
    autoLayout()
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().updatePlacementsBatch({ connections: [{ id: lowerFor('P', 'S').id, data: { waypoints: [{ x: 1, y: 1 }] } }] })
    expect(d1().layouts3d).toBeDefined()
  })

  it('toggling a lower\'s lock on the 3D board flips the 3D lock it is drawn with', () => {
    autoLayout()
    useModelStore.getState().applyDiagramLayout('d1', {}, [{ id: lowerFor('S', 'P').id }], '3d')
    expect(drawn('3d').get('S→P')?.lockedToAnchors).toBe(false)
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().toggleConnectionLock(lowerFor('S', 'P').id)
    expect(drawn('3d').get('S→P')?.lockedToAnchors).toBe(true)
    expect(drawn('2d').get('S→P')?.lockedToAnchors).toBe(true)
  })

  it('"Align 3D with 2D" strips the entries\' 3D twins', () => {
    useModelStore.getState().applyDiagramLayout('d1', {}, [{ id: lowerFor('S', 'P').id, fromAnchor: 1, lockedToAnchors: true }], '3d')
    useModelStore.getState().resetDiagram3dLayout('d1')
    expect(d1().lowerRouting?.['S→P']).toEqual({})
  })
})

describe('lower ids across a projection that dropped the objects', () => {
  it('re-mints a still-needed lower under its own id, never a second copy of it', () => {
    const before = [...d1().connectionIds]
    useModelStore.setState({ connections: state().connections.filter((c) => c.kind !== 'lower') })
    useModelStore.getState().syncLowerConnections('d1')
    expect(d1().connectionIds).toEqual(before)
    expect(lowers().map((c) => c.id).sort()).toEqual(['lower:P→S', 'lower:S→P'])
  })

  it('drops a dangling lower id the diagram no longer needs (it used to be kept and persisted)', () => {
    useModelStore.setState({
      connections: [conn('c1', 's1', 'p1')],
      diagrams: [diagram({ objectIds: ['S', 'P'], connectionIds: ['lower:S→P', 'lower:P→S'] })],
    })
    useModelStore.getState().syncLowerConnections('d1')
    expect(d1().connectionIds).toEqual(['lower:S→P'])
    expect(lowers().map((c) => c.id)).toEqual(['lower:S→P'])
  })

  it('one pass may prune a pair\'s lower on one diagram and mint it on the next: the new one is kept', () => {
    // d1 no longer needs S→P (its children are shown directly); d2 does, and has none yet.
    useModelStore.setState({
      connections: [conn('c1', 's1', 'p1'), { id: 'lower:S→P', fromId: 'S', toId: 'P', kind: 'lower', type: 'dashed', label: '' }],
      diagrams: [
        diagram({ id: 'd1', objectIds: ['s1', 'p1'], connectionIds: ['c1', 'lower:S→P'] }),
        diagram({ id: 'd2', objectIds: ['S', 'P'], connectionIds: [] }),
      ],
      currentDiagramId: 'd1',
    })
    __lowerSyncForTest.setClock(() => 0) // one slice: both diagrams derive against one context
    useModelStore.getState().syncAllLowerConnections()
    __lowerSyncForTest.drain()

    const d2 = state().diagrams.find((d) => d.id === 'd2')!
    expect(d2.connectionIds).toEqual(['lower:S→P'])
    expect(state().connections.filter((c) => c.id === 'lower:S→P')).toHaveLength(1)
    expect(d1().connectionIds).toEqual(['c1'])
  })
})

describe('copies of the routing never alias', () => {
  it('a duplicated diagram gets its own deep copy of the lower routing', () => {
    autoLayout()
    const copy = buildDuplicateDiagram(d1(), 'Copy')
    expect(copy.lowerRouting).toEqual(d1().lowerRouting)
    expect(copy.lowerRouting).not.toBe(d1().lowerRouting)
    expect(copy.lowerRouting?.['S→P']?.waypoints).not.toBe(d1().lowerRouting?.['S→P']?.waypoints)
  })
})
