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

// applyDiagramLayout (the on-canvas Auto-layout button) OWNS connection anchor
// state: an end its patch leaves undefined must be CLEARED — never kept. Stale
// anchors that survived here got re-locked onto the wrong port, so the canvas drew
// a different (worse) line than the one the layout scored, and no amount of
// re-running Auto-layout could ever converge ("source connection doesn't use the
// right anchor" / "locks the connection when it shouldn't").

function obj(id: string): C4Object {
  return {
    id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  } as C4Object
}
function conn(id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection {
  return { id, fromId, toId, type: 'solid', ...over }
}
const layouts = {
  A: { position: { x: 0, y: 0 }, size: { width: 160, height: 90 } },
  B: { position: { x: 400, y: 0 }, size: { width: 160, height: 90 } },
}

beforeEach(() => {
  useModelStore.setState({
    objects: [obj('A'), obj('B')],
    // Stale state from an earlier layout run: both ends pinned + locked + a waypoint.
    connections: [conn('c1', 'A', 'B', { fromAnchor: 7, toAnchor: 0, lockedToAnchors: true, waypoints: [{ x: 5, y: 5 }] })],
    groups: [],
    diagrams: [{ id: 'd1', name: 'D1', type: 'container', objectIds: ['A', 'B'], connectionIds: ['c1'], groupIds: [] } as Diagram],
    domains: [],
    currentDiagramId: 'd1',
    selectedItems: [],
  })
})

describe('applyDiagramLayout — layout owns anchor state', () => {
  it('preserves a layout entry missing from a temporarily incomplete server window', () => {
    useModelStore.setState((state) => ({
      diagrams: state.diagrams.map((diagram) => diagram.id === 'd1'
        ? {
            ...diagram,
            objectIds: ['A', 'B', 'C'],
            layouts: {
              ...layouts,
              C: { position: { x: 800, y: 0 }, size: { width: 160, height: 90 } },
            },
          }
        : diagram),
    }))

    useModelStore.getState().applyDiagramLayout('d1', layouts, [])

    expect(useModelStore.getState().diagrams[0].layouts?.C).toEqual({
      position: { x: 800, y: 0 },
      size: { width: 160, height: 90 },
    })
  })

  it('journals the full auto-layout as one placement revision', () => {
    const beforeRevision = useModelStore.getState().placementRevision

    useModelStore.getState().applyDiagramLayout(
      'd1',
      layouts,
      [{ id: 'c1', waypoints: [{ x: 100, y: 50 }], lockedToAnchors: false }],
    )

    expect(useModelStore.getState().placementRevision).toBeGreaterThan(beforeRevision)
  })

  it('clears the un-patched end when the patch locks only one end', () => {
    useModelStore.getState().applyDiagramLayout('d1', layouts, [{ id: 'c1', toAnchor: 2, lockedToAnchors: true }])
    const c = useModelStore.getState().connections.find((x) => x.id === 'c1')!
    expect(c.lockedToAnchors).toBe(true)
    expect(c.toAnchor).toBe(2)
    expect(c.fromAnchor).toBeUndefined() // stale port cleared → raycast end
    expect(c.waypoints).toBeUndefined() // no waypoints in the patch → cleared
  })

  it('clears both anchors when the patch unlocks the connection', () => {
    useModelStore.getState().applyDiagramLayout('d1', layouts, [{ id: 'c1', lockedToAnchors: false }])
    const c = useModelStore.getState().connections.find((x) => x.id === 'c1')!
    expect(c.lockedToAnchors).toBe(false)
    expect(c.fromAnchor).toBeUndefined()
    expect(c.toAnchor).toBeUndefined()
  })

  it('leaves connections without a patch untouched', () => {
    useModelStore.getState().applyDiagramLayout('d1', layouts, [])
    const c = useModelStore.getState().connections.find((x) => x.id === 'c1')!
    expect(c).toMatchObject({ fromAnchor: 7, toAnchor: 0, lockedToAnchors: true })
  })
})
