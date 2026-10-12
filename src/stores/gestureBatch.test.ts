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
import { currentWorkspaceRef, workspaceRefKey } from '../lib/automerge/workspace'

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

beforeEach(() => {
  pendingPlacementIntents.clearWorkspace(workspaceRefKey(currentWorkspaceRef()))
  useUIStore.setState({ canvasViewMode: '2d' })
  useModelStore.setState({
    objects: [object('A', 0), object('B', 400)],
    connections: [{ id: 'c1', fromId: 'A', toId: 'B', type: 'solid', lockedToAnchors: true } as Connection],
    groups: [{
      id: 'g1',
      name: 'Group',
      color: '#888888',
      objectIds: ['A'],
      position: { x: -20, y: -20 },
      size: { width: 220, height: 140 },
      autoSize: true,
      tagAssignments: {},
      tagOrder: [],
    } as Group],
    diagrams: [{
      id: 'd1',
      name: 'Diagram',
      type: 'container',
      objectIds: ['A', 'B'],
      connectionIds: ['c1'],
      groupIds: ['g1'],
      layouts: {
        A: { position: { x: 0, y: 0 }, size: { width: 160, height: 90 } },
        B: { position: { x: 400, y: 0 }, size: { width: 160, height: 90 } },
        g1: { position: { x: -20, y: -20 }, size: { width: 220, height: 140 } },
      },
    } as Diagram],
    currentDiagramId: 'd1',
    selectedItems: [],
  })
})

describe('gesture placement batches', () => {
  it('commits objects, a group and derived anchors in one store notification', () => {
    let notifications = 0
    const unsubscribe = useModelStore.subscribe(() => { notifications += 1 })

    useModelStore.getState().updatePlacementsBatch({
      objects: [
        { id: 'A', position: { x: 35, y: 45 } },
        { id: 'B', position: { x: 450, y: 50 }, size: { width: 180, height: 100 } },
      ],
      groups: [{
        id: 'g1',
        position: { x: 10, y: 20 },
        size: { width: 250, height: 160 },
        autoSize: false,
      }],
      connections: [{ id: 'c1', data: { fromAnchor: 3, toAnchor: 7 } }],
    })

    unsubscribe()
    const state = useModelStore.getState()
    const diagram = state.diagrams[0]
    expect(notifications).toBe(1)
    expect(diagram.layouts?.A.position).toEqual({ x: 35, y: 45 })
    expect(diagram.layouts?.B).toEqual({
      position: { x: 450, y: 50 },
      size: { width: 180, height: 100 },
    })
    expect(diagram.layouts?.g1).toEqual({
      position: { x: 10, y: 20 },
      size: { width: 250, height: 160 },
    })
    expect(state.groups[0].autoSize).toBe(false)
    expect(state.connections[0]).toMatchObject({ fromAnchor: 3, toAnchor: 7 })
    expect(state.placementRevision).toBeGreaterThan(0)
    expect(pendingPlacementIntents.snapshot(workspaceRefKey(currentWorkspaceRef()), 'd1')).toMatchObject({
      objects: [
        { id: 'A', position: { x: 35, y: 45 } },
        { id: 'B', position: { x: 450, y: 50 } },
      ],
      groups: [{ id: 'g1', position: { x: 10, y: 20 }, autoSize: false }],
      connections: [{ id: 'c1', data: { fromAnchor: 3, toAnchor: 7 } }],
    })
  })

  it('keeps the public object and connection batch operations atomic', () => {
    let notifications = 0
    const unsubscribe = useModelStore.subscribe(() => { notifications += 1 })

    useModelStore.getState().moveObjectsBatch([
      { id: 'A', position: { x: 10, y: 20 } },
      { id: 'B', position: { x: 420, y: 20 } },
    ])
    useModelStore.getState().updateConnectionsBatch([
      { id: 'c1', data: { labelPosition: 0.75, labelOffset: 18 } },
    ])

    unsubscribe()
    expect(notifications).toBe(2)
    expect(useModelStore.getState().diagrams[0].layouts?.A.position).toEqual({ x: 10, y: 20 })
    expect(useModelStore.getState().connections[0]).toMatchObject({
      labelPosition: 0.75,
      labelOffset: 18,
    })
  })
})
