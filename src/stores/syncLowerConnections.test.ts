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

import { describe, it, expect, beforeEach } from 'vitest'
import { useModelStore } from './modelStore'
import type { C4Object, Connection, Diagram } from '../types'

// Guards the immer-free refactor of syncLowerConnections: the derivation must
// stay identical — roll deeper-level edges onto the nearest visible ancestor,
// reuse lower-connection ids across re-syncs (live-selection stability), and
// prune lower edges no longer needed and unreferenced by other diagrams.

function obj(id: string, over: Partial<C4Object> = {}): C4Object {
  return {
    id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...over,
  }
}
function conn(id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection {
  return { id, fromId, toId, type: 'solid', ...over }
}
function diagram(over: Partial<Diagram> = {}): Diagram {
  return { id: 'd1', name: 'D1', type: 'container', objectIds: [], connectionIds: [], groupIds: [], ...over }
}

// S and S2 are systems shown on the diagram; A1/A2 are their (off-diagram)
// children; the direct A1→A2 edge should roll up to a lower S→S2 edge.
function seed() {
  useModelStore.setState({
    objects: [
      obj('S', { type: 'system' }),
      obj('S2', { type: 'system' }),
      obj('A1', { type: 'app', parentId: 'S' }),
      obj('A2', { type: 'app', parentId: 'S2' }),
    ],
    connections: [conn('c1', 'A1', 'A2', { kind: 'direct' })],
    groups: [],
    diagrams: [diagram({ objectIds: ['S', 'S2'], connectionIds: [] })],
    domains: [],
    currentDiagramId: 'd1',
    selectedItems: [],
  })
}

const lowerEdges = () => useModelStore.getState().connections.filter((c) => c.kind === 'lower')

describe('syncLowerConnections (immer-free refactor)', () => {
  beforeEach(seed)

  it('rolls a deeper edge up onto the nearest visible ancestors', () => {
    useModelStore.getState().syncLowerConnections('d1')
    const lowers = lowerEdges()
    expect(lowers).toHaveLength(1)
    expect(lowers[0]).toMatchObject({ fromId: 'S', toId: 'S2', kind: 'lower', type: 'dashed' })
    const d = useModelStore.getState().diagrams.find((x) => x.id === 'd1')!
    expect(d.connectionIds).toContain(lowers[0].id)
  })

  it('reuses the same lower id across re-syncs (selection stability)', () => {
    useModelStore.getState().syncLowerConnections('d1')
    const id1 = lowerEdges()[0].id
    useModelStore.getState().syncLowerConnections('d1')
    const lowers = lowerEdges()
    expect(lowers).toHaveLength(1)
    expect(lowers[0].id).toBe(id1)
  })

  it('does not roll up when both endpoints are already visible', () => {
    useModelStore.setState({ connections: [conn('c1', 'S', 'S2', { kind: 'direct' })] })
    useModelStore.getState().syncLowerConnections('d1')
    expect(lowerEdges()).toHaveLength(0)
  })

  it('prunes a lower edge once the underlying direct edge is gone', () => {
    useModelStore.getState().syncLowerConnections('d1')
    expect(lowerEdges()).toHaveLength(1)
    // remove the direct edge that justified the roll-up, then re-sync
    useModelStore.setState({ connections: useModelStore.getState().connections.filter((c) => c.id !== 'c1') })
    useModelStore.getState().syncLowerConnections('d1')
    expect(lowerEdges()).toHaveLength(0)
    const d = useModelStore.getState().diagrams.find((x) => x.id === 'd1')!
    expect(d.connectionIds.filter((cid) => cid.length)).toEqual([])
  })
})
