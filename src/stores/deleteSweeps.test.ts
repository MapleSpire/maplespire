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
import type { C4Object, Connection, Diagram, Group } from '../types'

/**
 * Two eager sweeps that were incomplete, both invisible until the wrong thing
 * was already persisted:
 *
 *  - `deleteGroup` never touched `state.connections`, so a connection with a
 *    GROUP endpoint outlived its endpoint and rendered as `Unknown → Unknown` on
 *    Model Connections. `deleteSelectedItems` swept the same case correctly, so
 *    the outcome depended on how the user reached the delete.
 *  - `deleteSelectedItems` never dropped layout keys, which `deleteObject` and
 *    `deleteGroup` both do. A placement key is membership, not existence: the
 *    stale key resurrects the old position the moment the same id returns via
 *    undo, an import that keeps existing ids, or a draft merge.
 */

const obj = (id: string): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 10, height: 10 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
})
const grp = (id: string, objectIds: string[] = []): Group => ({
  id, name: id, objectIds, color: '#000000', position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
  tagAssignments: {}, tagOrder: [],
})
const conn = (id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection => ({
  id, fromId, toId, type: 'solid', ...over,
})
const dg = (id: string, over: Partial<Diagram> = {}): Diagram => ({
  id, name: id, type: 'container', objectIds: [], connectionIds: [], groupIds: [], ...over,
})

beforeEach(() => {
  useModelStore.setState({
    objects: [], connections: [], groups: [], diagrams: [], domains: [], flows: [],
    currentDiagramId: null, selectedItems: [],
    pendingDeletedObjectIds: [], pendingDeletedConnectionIds: [],
  })
})

describe('deleteGroup sweeps connections that end on the group', () => {
  beforeEach(() => {
    useModelStore.setState({
      objects: [obj('a')],
      groups: [grp('g1', ['a']), grp('g2')],
      connections: [
        conn('c-from', 'g1', 'a'),
        conn('c-to', 'a', 'g1'),
        conn('c-other', 'a', 'g2'),
      ],
      diagrams: [dg('d1', {
        objectIds: ['a'],
        groupIds: ['g1', 'g2'],
        connectionIds: ['c-from', 'c-to', 'c-other'],
        layouts: {
          g1: { position: { x: 5, y: 5 }, size: { width: 10, height: 10 } },
          'c-from': { position: { x: 1, y: 1 }, size: { width: 10, height: 10 } },
          'c-other': { position: { x: 2, y: 2 }, size: { width: 10, height: 10 } },
        },
      })],
      currentDiagramId: 'd1',
    })
  })

  it('deletes every connection with the group as an endpoint', () => {
    useModelStore.getState().deleteGroup('g1')
    expect(useModelStore.getState().connections.map((c) => c.id)).toEqual(['c-other'])
  })

  it('leaves connections between other endpoints alone', () => {
    useModelStore.getState().deleteGroup('g1')
    expect(useModelStore.getState().connections.find((c) => c.id === 'c-other')).toBeDefined()
  })

  it('removes the dead connections from every diagram composition', () => {
    useModelStore.getState().deleteGroup('g1')
    expect(useModelStore.getState().diagrams[0].connectionIds).toEqual(['c-other'])
  })

  it('tombstones them, so a diagram that was off-window learns they are gone', () => {
    useModelStore.getState().deleteGroup('g1')
    expect([...useModelStore.getState().pendingDeletedConnectionIds].sort()).toEqual(['c-from', 'c-to'])
  })

  it('does NOT tombstone derived lower connections, which regenerate', () => {
    useModelStore.setState({ connections: [conn('c-low', 'g1', 'a', { kind: 'lower' })] })
    useModelStore.getState().deleteGroup('g1')
    const state = useModelStore.getState()
    expect(state.connections).toEqual([])
    expect(state.pendingDeletedConnectionIds).toEqual([])
  })

  it('drops the layout key of the group AND of every connection it took with it', () => {
    useModelStore.getState().deleteGroup('g1')
    expect(Object.keys(useModelStore.getState().diagrams[0].layouts ?? {})).toEqual(['c-other'])
  })
})

describe('deleteSelectedItems drops layout keys', () => {
  beforeEach(() => {
    useModelStore.setState({
      objects: [obj('a'), obj('b')],
      groups: [grp('g1')],
      connections: [conn('c1', 'a', 'b'), conn('c2', 'b', 'g1')],
      diagrams: [dg('d1', {
        objectIds: ['a', 'b'],
        groupIds: ['g1'],
        connectionIds: ['c1', 'c2'],
        layouts: {
          a: { position: { x: 7, y: 7 }, size: { width: 10, height: 10 } },
          b: { position: { x: 8, y: 8 }, size: { width: 10, height: 10 } },
          g1: { position: { x: 9, y: 9 }, size: { width: 10, height: 10 } },
          c1: { position: { x: 1, y: 1 }, size: { width: 10, height: 10 } },
          c2: { position: { x: 2, y: 2 }, size: { width: 10, height: 10 } },
        },
        layouts3d: { a: { position: { x: 7, y: 7 }, size: { width: 10, height: 10 } }, b: { position: { x: 8, y: 8 }, size: { width: 10, height: 10 } } },
      })],
      currentDiagramId: 'd1',
      selectedItems: [{ id: 'a', type: 'object' }, { id: 'g1', type: 'group' }],
    })
  })

  it('removes the layout key of a deleted object, so a re-added id does not teleport', () => {
    useModelStore.getState().deleteSelectedItems()
    expect(useModelStore.getState().diagrams[0].layouts).not.toHaveProperty('a')
  })

  it('removes the layout key of a deleted group', () => {
    useModelStore.getState().deleteSelectedItems()
    expect(useModelStore.getState().diagrams[0].layouts).not.toHaveProperty('g1')
  })

  it('removes the layout keys of connections that died with their endpoints', () => {
    useModelStore.getState().deleteSelectedItems()
    const layouts = useModelStore.getState().diagrams[0].layouts ?? {}
    expect(Object.keys(layouts)).toEqual(['b'])
  })

  it('sweeps the 3D layer too, not only the 2D one', () => {
    useModelStore.getState().deleteSelectedItems()
    expect(Object.keys(useModelStore.getState().diagrams[0].layouts3d ?? {})).toEqual(['b'])
  })

  it('keeps the placement of everything that survived', () => {
    useModelStore.getState().deleteSelectedItems()
    expect(useModelStore.getState().diagrams[0].layouts?.b).toEqual({ position: { x: 8, y: 8 }, size: { width: 10, height: 10 } })
  })

  it('still deletes connections whose endpoint is a selected group', () => {
    useModelStore.getState().deleteSelectedItems()
    expect(useModelStore.getState().connections.map((c) => c.id)).toEqual([])
  })
})

/**
 * `removeGroupFromDiagram` pruned `groupIds` and nothing else, while every
 * sibling — `removeObjectFromDiagram`, `removeObjectsFromDiagram`, `deleteGroup`
 * — also pruned the connections incident on what left.
 *
 * A group is a real connection endpoint (`fromType: 'object' | 'group'`), so the
 * leftover id names a connection the canvas cannot resolve. `getConnectionGeometry`
 * returns null on an unresolvable endpoint, so it is not drawn — and, being
 * undrawn, cannot be right-clicked away either. It stays invisible and
 * unreachable while still counting toward the diagram's connection total.
 *
 * F16 promoted "Remove the group from this diagram" to the always-present first
 * row of the group menu, which is what made an old edge case easy to hit.
 */
describe('removing a group from a diagram sweeps its connections out of that diagram', () => {
  beforeEach(() => {
    useModelStore.setState({
      objects: [obj('a')],
      groups: [grp('g1', ['a'])],
      connections: [conn('c1', 'g1', 'a'), conn('c2', 'a', 'g1'), conn('c3', 'a', 'a')],
      diagrams: [
        dg('d1', { objectIds: ['a'], groupIds: ['g1'], connectionIds: ['c1', 'c2', 'c3'] }),
        dg('d2', { objectIds: ['a'], groupIds: ['g1'], connectionIds: ['c1'] }),
      ],
      currentDiagramId: 'd1',
      selectedItems: [{ id: 'g1', type: 'group' }],
    })
  })

  it('drops the connections that ended on the group', () => {
    useModelStore.getState().removeGroupFromDiagram('g1', 'd1')
    expect(useModelStore.getState().diagrams[0].connectionIds).toEqual(['c3'])
  })

  it('leaves the connections themselves in the model — this is not a delete', () => {
    useModelStore.getState().removeGroupFromDiagram('g1', 'd1')
    expect(useModelStore.getState().connections.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('touches no other diagram', () => {
    useModelStore.getState().removeGroupFromDiagram('g1', 'd1')
    expect(useModelStore.getState().diagrams[1].connectionIds).toEqual(['c1'])
    expect(useModelStore.getState().diagrams[1].groupIds).toEqual(['g1'])
  })

  it('clears the group from the selection', () => {
    useModelStore.getState().removeGroupFromDiagram('g1', 'd1')
    expect(useModelStore.getState().selectedItems).toEqual([])
  })

  it('sweeps the same way for the batch path', () => {
    useModelStore.getState().removeGroupsFromDiagram(['g1'], 'd1')
    expect(useModelStore.getState().diagrams[0].groupIds).toEqual([])
    expect(useModelStore.getState().diagrams[0].connectionIds).toEqual(['c3'])
  })
})
