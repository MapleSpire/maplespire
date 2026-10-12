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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useModelStore } from './modelStore'
import type { C4Object, Connection, Diagram } from '../types'

// Regression guard for the perf fix: updateConnection must roll up "lower" connections
// ONLY when an endpoint (fromId/toId) changes — never for a visual edit (shape/type/
// label/status/anchor-lock), which cannot change the derived lower set. Previously it
// called syncAllLowerConnections() on EVERY edit → an O(diagrams×connections) recompute
// per keystroke when toggling curved/dashed.

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

let realSyncAll: () => void
beforeEach(() => {
  useModelStore.setState({
    objects: [obj('A'), obj('B'), obj('C')],
    connections: [conn('c1', 'A', 'B')],
    groups: [],
    diagrams: [diagram({ objectIds: ['A', 'B', 'C'], connectionIds: ['c1'] })],
    domains: [],
    currentDiagramId: 'd1',
    selectedItems: [],
  })
  realSyncAll = useModelStore.getState().syncAllLowerConnections
})
afterEach(() => {
  // restore the action we spy-replaced so other suites aren't affected
  useModelStore.setState({ syncAllLowerConnections: realSyncAll })
})

describe('updateConnection — lower roll-up gated on endpoint change', () => {
  it('does NOT roll up lowers for visual-only edits, but still applies them', () => {
    const spy = vi.fn()
    useModelStore.setState({ syncAllLowerConnections: spy })
    const update = useModelStore.getState().updateConnection
    update('c1', { shape: 'straight' })
    update('c1', { type: 'dashed' })
    update('c1', { label: 'calls' })
    update('c1', { status: 'down' })
    update('c1', { lockedToAnchors: true })

    expect(spy).not.toHaveBeenCalled()
    const c = useModelStore.getState().connections.find((x) => x.id === 'c1')!
    expect(c).toMatchObject({ shape: 'straight', type: 'dashed', label: 'calls', status: 'down', lockedToAnchors: true })
  })

  it('DOES roll up lowers when an endpoint (fromId/toId) changes', () => {
    const spy = vi.fn()
    useModelStore.setState({ syncAllLowerConnections: spy })
    useModelStore.getState().updateConnection('c1', { toId: 'C' })
    expect(spy).toHaveBeenCalledTimes(1)
    useModelStore.getState().updateConnection('c1', { fromId: 'B' })
    expect(spy).toHaveBeenCalledTimes(2)
    // both endpoint edits applied
    expect(useModelStore.getState().connections.find((x) => x.id === 'c1')).toMatchObject({ fromId: 'B', toId: 'C' })
  })
})
