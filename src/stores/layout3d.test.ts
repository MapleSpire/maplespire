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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useModelStore } from './modelStore'
import { useUIStore } from './uiStore'
import { filterAndMergeDiagramData, resolveConnectionFor3d } from '../lib/viewLayouts'
import type { C4Object, Connection, Diagram, Group } from '../types'

// The 2D/3D placement contract (user requirement): the MODEL is shared, the
// VISUAL layer is per-mode. Edits made on the 3D board write ONLY the 3D layer
// (diagram.layouts3d + Connection `*3d` twins) — after fork-on-first-3D-edit
// snapshots the whole diagram — and 2D edits never rearrange a forked 3D scene.
// "Align 3D with 2D" (resetDiagram3dLayout) drops the fork entirely.

function obj(id: string, x = 0, y = 0): C4Object {
  return {
    id, type: 'app', name: id, position: { x, y }, size: { width: 160, height: 90 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  } as C4Object
}
function conn(id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection {
  return { id, fromId, toId, type: 'solid', ...over }
}
function group(id: string, objectIds: string[]): Group {
  return { id, name: id, color: '#888', objectIds, position: { x: 10, y: 10 }, size: { width: 400, height: 300 }, tagAssignments: {}, tagOrder: [] }
}

function currentDiagram(): Diagram {
  return useModelStore.getState().diagrams.find((d) => d.id === 'd1')!
}
function connection(id: string): Connection {
  return useModelStore.getState().connections.find((c) => c.id === id)!
}

beforeEach(() => {
  useUIStore.setState({ canvasViewMode: '2d' })
  useModelStore.setState({
    objects: [obj('A', 0, 0), obj('B', 400, 0)],
    connections: [conn('c1', 'A', 'B', { waypoints: [{ x: 5, y: 5 }], labelPosition: 0.4 })],
    groups: [group('g1', ['A'])],
    diagrams: [{
      id: 'd1', name: 'D1', type: 'container',
      objectIds: ['A', 'B'], connectionIds: ['c1'], groupIds: ['g1'],
      layouts: {
        A: { position: { x: 0, y: 0 }, size: { width: 160, height: 90 } },
        B: { position: { x: 400, y: 0 }, size: { width: 160, height: 90 } },
        g1: { position: { x: 10, y: 10 }, size: { width: 400, height: 300 } },
      },
    } as Diagram],
    domains: [],
    currentDiagramId: 'd1',
    selectedItems: [],
  })
})

afterEach(() => {
  useUIStore.setState({ canvasViewMode: '2d' })
})

describe('fork-on-first-3D-edit', () => {
  it('a 3D move snapshots the WHOLE diagram into layouts3d and writes only there', () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().moveObject('A', { x: 111, y: 222 })

    const d = currentDiagram()
    // 2D layer untouched
    expect(d.layouts!.A.position).toEqual({ x: 0, y: 0 })
    expect(d.layouts!.B.position).toEqual({ x: 400, y: 0 })
    // 3D layer exists, carries the moved object AND the untouched rest (full fork)
    expect(d.layouts3d).toBeDefined()
    expect(d.layouts3d!.A.position).toEqual({ x: 111, y: 222 })
    expect(d.layouts3d!.B.position).toEqual({ x: 400, y: 0 })
    expect(d.layouts3d!.g1.position).toEqual({ x: 10, y: 10 })
    // The fork also stamped the connection's routing into the 3D twins
    expect(connection('c1').waypoints3d).toEqual([{ x: 5, y: 5 }])
    expect(connection('c1').labelPosition3d).toBe(0.4)
  })

  it('post-fork 2D edits do not move the 3D arrangement (and vice versa)', () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().moveObject('A', { x: 111, y: 222 })

    useUIStore.setState({ canvasViewMode: '2d' })
    useModelStore.getState().moveObject('B', { x: 999, y: 999 })

    const d = currentDiagram()
    expect(d.layouts!.B.position).toEqual({ x: 999, y: 999 })
    expect(d.layouts3d!.B.position).toEqual({ x: 400, y: 0 }) // fork holds
    expect(d.layouts3d!.A.position).toEqual({ x: 111, y: 222 })
    expect(d.layouts!.A.position).toEqual({ x: 0, y: 0 })
  })

  it('before any 3D edit the 3D view live-mirrors 2D (no fork on toggle alone)', () => {
    // Just being in 3D mode does not fork; only an edit does.
    useUIStore.setState({ canvasViewMode: '3d' })
    expect(currentDiagram().layouts3d).toBeUndefined()
    const { filteredObjects } = filterAndMergeDiagramData(
      currentDiagram(),
      useModelStore.getState().objects,
      useModelStore.getState().connections,
      useModelStore.getState().groups,
      '3d',
    )
    expect(filteredObjects.find((o) => o.id === 'B')!.position).toEqual({ x: 400, y: 0 })
  })

  it('elements added after the fork resolve per-element (3D ?? 2D) until adjusted', () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().moveObject('A', { x: 111, y: 222 })

    // New object lands in 2D layouts only (added while in 3D or 2D — same rule)
    useUIStore.setState({ canvasViewMode: '2d' })
    useModelStore.setState((s) => ({
      objects: [...s.objects, obj('C', 50, 60)],
      diagrams: s.diagrams.map((d) =>
        d.id === 'd1'
          ? { ...d, objectIds: [...d.objectIds, 'C'], layouts: { ...d.layouts, C: { position: { x: 50, y: 60 }, size: { width: 160, height: 90 } } } }
          : d,
      ),
    }))
    const { filteredObjects } = filterAndMergeDiagramData(
      currentDiagram(),
      useModelStore.getState().objects,
      useModelStore.getState().connections,
      useModelStore.getState().groups,
      '3d',
    )
    expect(filteredObjects.find((o) => o.id === 'C')!.position).toEqual({ x: 50, y: 60 })
  })

  it('a second forked diagram does not restamp a connection that already has 3D routing', () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().moveObject('A', { x: 1, y: 1 }) // forks d1, stamps c1
    useModelStore.getState().updateConnection('c1', { waypoints: [{ x: 77, y: 77 }] }) // 3D-only bend

    // Second diagram shares c1; fork it via a 3D edit there.
    useModelStore.setState((s) => ({
      diagrams: [
        ...s.diagrams,
        { id: 'd2', name: 'D2', type: 'container', objectIds: ['A', 'B'], connectionIds: ['c1'], groupIds: [] } as Diagram,
      ],
      currentDiagramId: 'd2',
    }))
    useModelStore.getState().moveObject('B', { x: 2, y: 2 })

    expect(connection('c1').waypoints3d).toEqual([{ x: 77, y: 77 }]) // survives d2's fork
    expect(connection('c1').waypoints).toEqual([{ x: 5, y: 5 }]) // 2D untouched
  })
})

describe('connection routing per mode', () => {
  it('updateConnection in 3D writes the *3d twins and leaves 2D routing alone', () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().updateConnection('c1', {
      waypoints: [{ x: 9, y: 9 }],
      labelPosition: 0.8,
      labelOffset: 20,
      shape: 'straight',
      fromAnchor: 3,
      lockedToAnchors: true,
    })
    const c = connection('c1')
    expect(c.waypoints).toEqual([{ x: 5, y: 5 }])
    expect(c.labelPosition).toBe(0.4)
    expect(c.shape).toBeUndefined()
    expect(c.waypoints3d).toEqual([{ x: 9, y: 9 }])
    expect(c.labelPosition3d).toBe(0.8)
    expect(c.labelOffset3d).toBe(20)
    expect(c.shape3d).toBe('straight')
    expect(c.fromAnchor3d).toBe(3)
    expect(c.lockedToAnchors3d).toBe(true)
  })

  it('clearing waypoints in 3D pins the empty-sentinel (no fallback to 2D bends)', () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().updateConnection('c1', { waypoints: undefined })
    const c = connection('c1')
    expect(c.waypoints3d).toEqual([])
    expect(resolveConnectionFor3d(c).waypoints).toEqual([]) // masks the 2D bends
  })

  it('model-level fields pass through in 3D mode (shared, not per-mode)', () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().updateConnection('c1', { label: 'renamed', type: 'dashed' })
    const c = connection('c1')
    expect(c.label).toBe('renamed')
    expect(c.type).toBe('dashed')
  })

  it('resolveConnectionFor3d applies per-field 3D ?? 2D', () => {
    const c = conn('x', 'A', 'B', {
      waypoints: [{ x: 1, y: 1 }],
      labelPosition: 0.3,
      labelOffset3d: 33,
      shape3d: 'straight',
    })
    const r = resolveConnectionFor3d(c)
    expect(r.waypoints).toEqual([{ x: 1, y: 1 }]) // no 3D override → 2D value
    expect(r.labelPosition).toBe(0.3)
    expect(r.labelOffset).toBe(33)
    expect(r.shape).toBe('straight')
  })
})

describe('applyDiagramLayout space routing', () => {
  const layouts = {
    A: { position: { x: 700, y: 0 }, size: { width: 160, height: 90 } },
    B: { position: { x: 0, y: 700 }, size: { width: 160, height: 90 } },
  }

  it("space '3d' fills layouts3d + 3D connection twins, leaving the 2D layer intact", () => {
    useModelStore.getState().applyDiagramLayout('d1', layouts, [{ id: 'c1', lockedToAnchors: false }], '3d')
    const d = currentDiagram()
    expect(d.layouts3d).toEqual(layouts)
    expect(d.layouts!.A.position).toEqual({ x: 0, y: 0 })
    const c = connection('c1')
    expect(c.waypoints3d).toEqual([]) // cleared with the sentinel
    expect(c.lockedToAnchors3d).toBe(false)
    expect(c.waypoints).toEqual([{ x: 5, y: 5 }]) // 2D untouched
  })

  it("defaults the space to the active canvas view", () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().applyDiagramLayout('d1', layouts, [])
    const d = currentDiagram()
    expect(d.layouts3d).toEqual(layouts)
    expect(d.layouts!.A.position).toEqual({ x: 0, y: 0 })
  })
})

describe('moveSelectedItems in 3D', () => {
  it('nudges from the 3D-resolved position and writes the 3D layer only', () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().moveObject('A', { x: 100, y: 100 }) // fork + place A
    useModelStore.setState({ selectedItems: [{ id: 'A', type: 'object' }] })
    useModelStore.getState().moveSelectedItems({ x: 10, y: -5 })
    const d = currentDiagram()
    expect(d.layouts3d!.A.position).toEqual({ x: 110, y: 95 })
    expect(d.layouts!.A.position).toEqual({ x: 0, y: 0 })
  })
})

describe('resetDiagram3dLayout ("Align 3D with 2D")', () => {
  it('drops layouts3d and every *3d routing field of the diagram connections', () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().moveObject('A', { x: 111, y: 222 })
    useModelStore.getState().updateConnection('c1', { waypoints: [{ x: 9, y: 9 }], labelOffset: 30 })

    useModelStore.getState().resetDiagram3dLayout('d1')

    const d = currentDiagram()
    expect(d.layouts3d).toBeUndefined()
    const c = connection('c1')
    expect(c.waypoints3d).toBeUndefined()
    expect(c.labelOffset3d).toBeUndefined()
    expect(c.lockedToAnchors3d).toBeUndefined()
    // 2D untouched, and the 3D view mirrors it again
    expect(c.waypoints).toEqual([{ x: 5, y: 5 }])
    const { filteredObjects } = filterAndMergeDiagramData(
      d,
      useModelStore.getState().objects,
      useModelStore.getState().connections,
      useModelStore.getState().groups,
      '3d',
    )
    expect(filteredObjects.find((o) => o.id === 'A')!.position).toEqual({ x: 0, y: 0 })
  })
})

describe('deletion cleans both layers', () => {
  it('deleteObject removes the object from layouts3d too', () => {
    useUIStore.setState({ canvasViewMode: '3d' })
    useModelStore.getState().moveObject('A', { x: 111, y: 222 })
    useModelStore.getState().deleteObject('A')
    const d = currentDiagram()
    expect(d.layouts3d!.A).toBeUndefined()
    expect(d.layouts!.A).toBeUndefined()
  })
})
