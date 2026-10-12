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
import type { C4Object, Connection, Diagram, Group } from '../types'
import { useModelStore } from './modelStore'

function object(id: string): C4Object {
  return {
    id,
    type: 'app',
    name: id,
    position: { x: 0, y: 0 },
    size: { width: 160, height: 90 },
    tagAssignments: {},
    tagOrder: [],
    scope: 'internal',
    status: 'live',
    properties: {},
  } as C4Object
}

function connection(id: string, fromId: string, toId: string): Connection {
  return { id, fromId, toId, type: 'solid' }
}

function group(id: string, objectIds: string[] = []): Group {
  return {
    id, name: id, objectIds, color: '#000000',
    position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
    tagAssignments: {}, tagOrder: [],
  } as Group
}

function diagram(): Diagram {
  return {
    id: 'd1',
    name: 'D1',
    type: 'container',
    objectIds: ['A', 'B'],
    connectionIds: ['c1'],
    groupIds: [],
  } as Diagram
}

beforeEach(() => {
  useModelStore.setState({
    objects: [object('A'), object('B')],
    connections: [connection('c1', 'A', 'B')],
    diagrams: [diagram()],
    groups: [],
    currentDiagramId: 'd1',
    selectedItems: [],
    pendingDeletedObjectIds: [],
    pendingDeletedConnectionIds: [],
    pendingDeletedGroupIds: [],
    pendingDeletedDiagramIds: [],
  })
})

describe('explicit model deletion intents', () => {
  it('does not infer a deletion when a selective projection omits an entity', () => {
    useModelStore.setState({
      objects: [object('A')],
      connections: [],
    })

    expect(useModelStore.getState().pendingDeletedObjectIds).toEqual([])
    expect(useModelStore.getState().pendingDeletedConnectionIds).toEqual([])
  })

  it('does not create deletion intents during auto-layout', () => {
    useModelStore.getState().applyDiagramLayout(
      'd1',
      {
        A: { position: { x: 10, y: 20 }, size: { width: 160, height: 90 } },
        B: { position: { x: 400, y: 20 }, size: { width: 160, height: 90 } },
      },
      [{ id: 'c1', waypoints: [{ x: 280, y: 65 }] }],
    )

    expect(useModelStore.getState().pendingDeletedObjectIds).toEqual([])
    expect(useModelStore.getState().pendingDeletedConnectionIds).toEqual([])
  })

  it('records an explicit connection deletion', () => {
    useModelStore.getState().deleteConnection('c1')

    expect(useModelStore.getState().pendingDeletedConnectionIds).toEqual(['c1'])
  })

  it('records an explicit object deletion and its incident model connections', () => {
    useModelStore.getState().deleteObject('A')

    expect(useModelStore.getState().pendingDeletedObjectIds).toEqual(['A'])
    expect(useModelStore.getState().pendingDeletedConnectionIds).toEqual(['c1'])
  })

  it('records every model entity removed by a bulk delete, but not a group as an object', () => {
    useModelStore.setState({ selectedItems: [
      { id: 'A', type: 'object' },
      { id: 'c1', type: 'connection' },
    ] })

    useModelStore.getState().deleteSelectedItems()

    expect(useModelStore.getState().pendingDeletedObjectIds).toEqual(['A'])
    expect(useModelStore.getState().pendingDeletedConnectionIds).toEqual(['c1'])
  })

  /**
   * A group delete has to be declared too, but for a narrower reason than an
   * object's. Groups live whole inside ModelMeta, so removing one is durable as
   * soon as it flushes — there is no base shard for a document tombstone to mark
   * (and nothing would ever clear such a list: compaction folds objects and
   * connections only). The intent exists so the SAME flush can strip the id from
   * the registry meta of diagrams whose composition flushWrite preserves verbatim
   * from the shard. Without it a deleted group survives a reload there, and the
   * canvas paints wrapper chrome for something that no longer exists.
   */
  it('records an explicit group deletion', () => {
    useModelStore.setState({ groups: [group('g1', ['A'])] })

    useModelStore.getState().deleteGroup('g1')

    expect(useModelStore.getState().pendingDeletedGroupIds).toEqual(['g1'])
  })

  it('records a group removed by a bulk delete, separately from objects', () => {
    useModelStore.setState({
      groups: [group('g1', ['A'])],
      selectedItems: [{ id: 'A', type: 'object' }, { id: 'g1', type: 'group' }],
    })

    useModelStore.getState().deleteSelectedItems()

    expect(useModelStore.getState().pendingDeletedGroupIds).toEqual(['g1'])
    expect(useModelStore.getState().pendingDeletedObjectIds).toEqual(['A'])
  })

  it('does not infer a group deletion from a projection that simply omits it', () => {
    // Same rule as objects: a selective projection is allowed to be partial, so
    // absence is never a delete.
    useModelStore.setState({ groups: [group('g1')] })
    useModelStore.setState({ groups: [] })

    expect(useModelStore.getState().pendingDeletedGroupIds).toEqual([])
  })

  it('does not repeat an id when the same group is deleted twice', () => {
    useModelStore.setState({ groups: [group('g1')] })
    useModelStore.getState().deleteGroup('g1')
    useModelStore.getState().deleteGroup('g1')

    expect(useModelStore.getState().pendingDeletedGroupIds).toEqual(['g1'])
  })

  /**
   * Deleting a diagram must record an explicit intent, not just filter
   * `state.diagrams`. Under a summary-only registry that array is a bounded
   * WINDOW, so for diagrams the client never opened, filtering rebuilds an
   * identical array and every downstream write path — the registry plan, the
   * meta loop, the crash journal — would see nothing happen.
   */
  it('records an explicit diagram deletion', () => {
    useModelStore.getState().deleteDiagram('d1')

    expect(useModelStore.getState().pendingDeletedDiagramIds).toEqual(['d1'])
  })

  it('records the deletion of a diagram that is NOT in the resident window', () => {
    // The case that matters, and the one the old code could not express: the id
    // is absent from `state.diagrams` (a summary window holds only what this
    // session touched), so nothing about the array changes. The intent is the
    // only trace, and without it the delete is unobservable.
    const before = useModelStore.getState().diagrams

    useModelStore.getState().deleteDiagram('dg-off-window')

    expect(useModelStore.getState().pendingDeletedDiagramIds).toEqual(['dg-off-window'])
    expect(useModelStore.getState().diagrams.map((d) => d.id)).toEqual(before.map((d) => d.id))
  })

  it('does not infer a diagram deletion from a projection that simply omits it', () => {
    // Same rule as objects, groups and connections. A summary projection is a
    // window by construction: a diagram leaving it is routine, not a delete.
    useModelStore.setState({ diagrams: [] })

    expect(useModelStore.getState().pendingDeletedDiagramIds).toEqual([])
  })

  it('does not repeat an id when the same diagram is deleted twice', () => {
    useModelStore.getState().deleteDiagram('d1')
    useModelStore.getState().deleteDiagram('d1')

    expect(useModelStore.getState().pendingDeletedDiagramIds).toEqual(['d1'])
  })
})
