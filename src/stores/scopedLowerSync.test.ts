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

/**
 * USER REPORT 2026-10-11: connecting two shapes froze the page for seconds
 * while the save badge showed. Measured on a 739-diagram landscape: the
 * debounced lower roll-up re-derived EVERY diagram after each connect — one
 * 4 030-4 280 ms task. It is now scoped to the diagrams the touched
 * connections' endpoints can reach, and a re-derivation that changes nothing
 * no longer commits.
 *
 * The arms below pin both halves: the SCOPE (an unreachable diagram is not
 * re-derived — RED on the unscoped pass) and the CORRECTNESS of what is still
 * re-derived (a reachable non-active diagram gets, keeps or loses its lower
 * edge exactly as the full pass would give it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __lowerSyncForTest, diagramsReachingEndpoints, useModelStore } from './modelStore'
import type { C4Object, Connection, Diagram, Group } from '../types'

function obj(id: string, over: Partial<C4Object> = {}): C4Object {
  return {
    id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...over,
  }
}
function conn(id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection {
  return { id, fromId, toId, type: 'solid', ...over }
}
function diagram(id: string, over: Partial<Diagram> = {}): Diagram {
  return { id, name: id, type: 'container', objectIds: [], connectionIds: [], groupIds: [], ...over }
}
function group(id: string, objectIds: string[]): Group {
  return { id, name: id, objectIds } as unknown as Group
}

/*
 * S, S2: systems.  A1 ⊂ S, A2 ⊂ S2, B1 ⊂ S, B2 ⊂ S2: containers.
 * X, Y: an unrelated system pair, and G a group on dGroup holding A1.
 *  - dActive  shows A1, A2, B1, B2   (the canvas the user connects on)
 *  - dSystems shows S, S2            (reachable through the ANCESTORS)
 *  - dGroup   shows S2, group G ∋ A1 (reachable through a GROUP)
 *  - dOther   shows X, Y             (unreachable from A1/A2/B1/B2)
 */
function seed() {
  useModelStore.setState({
    objects: [
      obj('S', { type: 'system' }), obj('S2', { type: 'system' }),
      obj('A1', { parentId: 'S' }), obj('A2', { parentId: 'S2' }),
      obj('B1', { parentId: 'S' }), obj('B2', { parentId: 'S2' }),
      obj('X', { type: 'system' }), obj('Y', { type: 'system' }),
    ],
    // Y→X, not X→Y: a direct edge suppresses the roll-up of its own pair, and
    // the arms below want dOther to owe one (X1→Y1 rolls up to X→Y).
    connections: [conn('yx', 'Y', 'X')],
    groups: [group('G', ['A1'])],
    diagrams: [
      diagram('dActive', { objectIds: ['A1', 'A2', 'B1', 'B2'] }),
      diagram('dSystems', { objectIds: ['S', 'S2'] }),
      diagram('dGroup', { objectIds: ['S2'], groupIds: ['G'] }),
      diagram('dOther', { objectIds: ['X', 'Y'], connectionIds: ['yx'] }),
    ],
    domains: [],
    currentDiagramId: 'dActive',
    selectedItems: [],
  })
}

const lowersOn = (diagramId: string) => {
  const s = useModelStore.getState()
  const d = s.diagrams.find((x) => x.id === diagramId)!
  return s.connections
    .filter((c) => c.kind === 'lower' && d.connectionIds.includes(c.id))
    .map((c) => `${c.fromId}->${c.toId}`)
}

/** Record which diagrams the debounced pass re-derives (the idle heal that
 * follows a scoped pass is excluded — it re-derives everything by design). */
function spySync() {
  const synced: string[] = []
  __lowerSyncForTest.trace((id, kind) => {
    if (kind !== 'heal') synced.push(id)
  })
  return synced
}

// The scope arms below judge the scoped pass ALONE: with the idle heal on, a
// diagram the scope missed would be repaired a tick later and every arm would
// pass against a broken scope.
function scopeOnly() {
  beforeEach(() => __lowerSyncForTest.setHealEnabled(false))
  afterEach(() => {
    __lowerSyncForTest.reset()
    __lowerSyncForTest.trace(null)
    __lowerSyncForTest.setHealEnabled(true)
  })
}

describe('diagramsReachingEndpoints', () => {
  beforeEach(seed)

  it('reaches a diagram through the endpoint itself, an ancestor, or a group holding it — in store order', () => {
    expect(diagramsReachingEndpoints(useModelStore.getState(), ['A1'])).toEqual(['dActive', 'dSystems', 'dGroup'])
    expect(diagramsReachingEndpoints(useModelStore.getState(), ['A2'])).toEqual(['dActive', 'dSystems', 'dGroup'])
    expect(diagramsReachingEndpoints(useModelStore.getState(), ['B1'])).toEqual(['dActive', 'dSystems'])
  })

  it('reaches nothing for an endpoint no diagram shows', () => {
    expect(diagramsReachingEndpoints(useModelStore.getState(), ['nowhere'])).toEqual([])
  })

  it('survives a parent cycle', () => {
    useModelStore.setState({ objects: [obj('P', { parentId: 'Q' }), obj('Q', { parentId: 'P' })] })
    expect(diagramsReachingEndpoints(useModelStore.getState(), ['P'])).toEqual([])
  })
})

describe('the debounced roll-up after a connection mutation is scoped to reachable diagrams', () => {
  scopeOnly()
  beforeEach(() => {
    vi.useFakeTimers()
    seed()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('connect: re-derives the reachable diagrams only, never an unreachable one (RED on the unscoped pass)', () => {
    const synced = spySync()
    useModelStore.getState().addConnection({ fromId: 'B1', toId: 'B2', type: 'solid' })
    vi.advanceTimersByTime(150)
    // dGroup is reached through B2's ancestor S2; dOther shows neither side.
    expect(synced).toEqual(['dActive', 'dSystems', 'dGroup'])
  })

  it('connect: a reachable NON-active diagram gets its lower edge (ancestor roll-up)', () => {
    useModelStore.getState().addConnection({ fromId: 'A1', toId: 'A2', type: 'solid' })
    vi.advanceTimersByTime(150)
    expect(lowersOn('dSystems')).toEqual(['S->S2'])
    // …and through the group: A1 is shown as G there, A2 as S2.
    expect(lowersOn('dGroup')).toEqual(['G->S2'])
    expect(lowersOn('dActive')).toEqual([])
    expect(lowersOn('dOther')).toEqual([])
  })

  it('delete: the lower edge is pruned from the reachable diagram once its direct edge is gone', () => {
    const id = useModelStore.getState().addConnection({ fromId: 'A1', toId: 'A2', type: 'solid' })
    vi.advanceTimersByTime(150)
    expect(lowersOn('dSystems')).toEqual(['S->S2'])
    useModelStore.getState().deleteConnection(id)
    vi.advanceTimersByTime(150)
    expect(lowersOn('dSystems')).toEqual([])
    expect(useModelStore.getState().connections.filter((c) => c.kind === 'lower')).toEqual([])
  })

  it('reconnect: a diagram where the NEW source has no representative loses its lower edge', () => {
    // A1 -> A2 rolls up onto dGroup as G -> S2. Moving the source to B1 (not in
    // G, and S is not on dGroup) must prune it there. This arm does NOT pin
    // the old-endpoint scope: dGroup is still reached through the endpoint the
    // reconnect KEPT (A2, via its ancestor S2) — see the "BOTH endpoints" arms
    // below for the case that depends on the old endpoints.
    const id = useModelStore.getState().addConnection({ fromId: 'A1', toId: 'A2', type: 'solid' })
    vi.advanceTimersByTime(150)
    expect(lowersOn('dGroup')).toEqual(['G->S2'])
    useModelStore.getState().updateConnection(id, { fromId: 'B1' })
    vi.advanceTimersByTime(150)
    expect(lowersOn('dGroup')).toEqual([])
    expect(lowersOn('dSystems')).toEqual(['S->S2'])
  })

  it('a caller that names no endpoints keeps the full pass', () => {
    const synced = spySync()
    useModelStore.getState().syncAllLowerConnections()
    vi.advanceTimersByTime(150)
    expect(synced).toEqual(['dActive', 'dSystems', 'dGroup', 'dOther'])
  })

  it('a full request in the same burst wins over a scoped one', () => {
    const synced = spySync()
    useModelStore.getState().addConnection({ fromId: 'B1', toId: 'B2', type: 'solid' })
    useModelStore.getState().syncAllLowerConnections()
    vi.advanceTimersByTime(150)
    expect(synced).toEqual(['dActive', 'dSystems', 'dGroup', 'dOther'])
  })
})

describe('syncLowerConnections commits nothing when nothing changes', () => {
  beforeEach(seed)

  it('an unchanged diagram does not notify subscribers (RED when every re-derivation commits)', () => {
    useModelStore.getState().syncLowerConnections('dOther')
    const before = useModelStore.getState().diagrams
    const listener = vi.fn()
    const unsubscribe = useModelStore.subscribe(listener)
    useModelStore.getState().syncLowerConnections('dOther')
    unsubscribe()
    expect(listener).not.toHaveBeenCalled()
    expect(useModelStore.getState().diagrams).toBe(before)
  })

  it('a changed diagram still commits', () => {
    useModelStore.setState({ connections: [conn('yx', 'Y', 'X'), conn('aa', 'A1', 'A2')] })
    const listener = vi.fn()
    const unsubscribe = useModelStore.subscribe(listener)
    useModelStore.getState().syncLowerConnections('dSystems')
    unsubscribe()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(lowersOn('dSystems')).toEqual(['S->S2'])
  })
})

/*
 * QA lens (2026-10-11). The arms above could not fail against seven mutants
 * of the scoping and the skip-commit; each arm below was seen RED on its
 * mutant and GREEN on the shipped code.
 *
 * Note on the existing "reconnect" arm: a lower edge on a diagram needs BOTH
 * endpoints visible there, so a reconnect that keeps one endpoint is always
 * re-reached through the endpoint it kept. Only a reconnect that moves BOTH
 * endpoints out of a diagram's reach depends on the OLD endpoints being read
 * before the commit — hence the two "both endpoints" arms.
 */
describe('QA lens: a burst, a full request and a two-sided reconnect cannot leave a stale roll-up', () => {
  scopeOnly()
  beforeEach(() => {
    vi.useFakeTimers()
    seed()
    // X1 ⊂ X, Y1 ⊂ Y: endpoints that reach dOther only.
    useModelStore.setState((s) => ({
      objects: [...s.objects, obj('X1', { parentId: 'X' }), obj('Y1', { parentId: 'Y' })],
    }))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('two connects in ONE burst re-derive the union of both scopes (RED when the scope keeps only the last call)', () => {
    useModelStore.getState().addConnection({ fromId: 'A1', toId: 'A2', type: 'solid' })
    useModelStore.getState().addConnection({ fromId: 'X1', toId: 'Y1', type: 'solid' })
    vi.advanceTimersByTime(150)
    expect(lowersOn('dSystems')).toEqual(['S->S2'])
    expect(lowersOn('dGroup')).toEqual(['G->S2'])
    expect(lowersOn('dOther')).toEqual(['X->Y'])
  })

  it('a full request FOLLOWED by a scoped one in the same burst stays full', () => {
    const synced = spySync()
    useModelStore.getState().syncAllLowerConnections()
    useModelStore.getState().addConnection({ fromId: 'B1', toId: 'B2', type: 'solid' })
    vi.advanceTimersByTime(150)
    expect(synced).toEqual(['dActive', 'dSystems', 'dGroup', 'dOther'])
  })

  it('updateConnection moving BOTH endpoints prunes the lower edges the old pair produced (RED when the delta is read after the commit)', () => {
    const id = useModelStore.getState().addConnection({ fromId: 'A1', toId: 'A2', type: 'solid' })
    vi.advanceTimersByTime(150)
    expect(lowersOn('dSystems')).toEqual(['S->S2'])
    expect(lowersOn('dGroup')).toEqual(['G->S2'])
    useModelStore.getState().updateConnection(id, { fromId: 'X1', toId: 'Y1' })
    vi.advanceTimersByTime(150)
    expect(lowersOn('dSystems')).toEqual([])
    expect(lowersOn('dGroup')).toEqual([])
    expect(lowersOn('dOther')).toEqual(['X->Y'])
  })

  it('updatePlacementsBatch moving BOTH endpoints prunes the lower edges the old pair produced (RED when the delta is read after the commit)', () => {
    const id = useModelStore.getState().addConnection({ fromId: 'A1', toId: 'A2', type: 'solid' })
    vi.advanceTimersByTime(150)
    expect(lowersOn('dSystems')).toEqual(['S->S2'])
    useModelStore.getState().updatePlacementsBatch({ connections: [{ id, data: { fromId: 'X1', toId: 'Y1' } }] })
    vi.advanceTimersByTime(150)
    expect(useModelStore.getState().connections.find((c) => c.id === id)).toMatchObject({ fromId: 'X1', toId: 'Y1' })
    expect(lowersOn('dSystems')).toEqual([])
    expect(lowersOn('dGroup')).toEqual([])
    expect(lowersOn('dOther')).toEqual(['X->Y'])
  })
})

describe('QA lens: skip-commit only when the derived membership is IDENTICAL', () => {
  /*
   * Lowers are shared by endpoint PAIR across diagrams. dKeep references both
   * L12 (S→S2) and L13 (S→S3), so neither is ever pruned; dSys must swap the
   * one it shows. The only direct edge is A1→A3, i.e. S→S3.
   */
  function seedShared(dSysConnectionIds: string[]) {
    useModelStore.setState({
      objects: [
        obj('S', { type: 'system' }), obj('S2', { type: 'system' }), obj('S3', { type: 'system' }),
        obj('A1', { parentId: 'S' }), obj('A3', { parentId: 'S3' }),
      ],
      connections: [
        conn('L12', 'S', 'S2', { kind: 'lower', type: 'dashed' }),
        conn('L13', 'S', 'S3', { kind: 'lower', type: 'dashed' }),
        conn('c13', 'A1', 'A3'),
      ],
      groups: [],
      diagrams: [
        diagram('dSys', { objectIds: ['S', 'S2', 'S3'], connectionIds: dSysConnectionIds }),
        diagram('dKeep', { objectIds: ['S', 'S2', 'S3'], connectionIds: ['L12', 'L13'] }),
      ],
      domains: [],
      currentDiagramId: 'dSys',
      selectedItems: [],
    })
  }
  const idsOn = (diagramId: string) => useModelStore.getState().diagrams.find((d) => d.id === diagramId)!.connectionIds

  it('same LENGTH, different lower: the swap is committed (RED on a length-only comparison)', () => {
    seedShared(['L12'])
    useModelStore.getState().syncLowerConnections('dSys')
    expect(idsOn('dSys')).toEqual(['L13'])
    expect(idsOn('dKeep')).toEqual(['L12', 'L13'])
  })

  it('a stale lower AFTER an equal prefix is dropped (RED on a prefix-only comparison)', () => {
    seedShared(['L13', 'L12'])
    useModelStore.getState().syncLowerConnections('dSys')
    expect(idsOn('dSys')).toEqual(['L13'])
  })
})

/*
 * Review follow-ups (2026-10-11), judged on the scoped pass ALONE (heal off).
 */
describe('review: the scope is resolved before the endpoints can disappear, and through groups', () => {
  scopeOnly()
  beforeEach(() => {
    vi.useFakeTimers()
    seed()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delete A1→A2 then delete A1 and A2 in the SAME burst: the non-active parent diagram loses its stale lower (RED when the reach is resolved only at fire time)', () => {
    const id = useModelStore.getState().addConnection({ fromId: 'A1', toId: 'A2', type: 'solid' })
    vi.advanceTimersByTime(150)
    expect(lowersOn('dSystems')).toEqual(['S->S2'])
    expect(lowersOn('dGroup')).toEqual(['G->S2'])
    // One burst: by the time the debounce fires, neither endpoint exists, so
    // neither its own diagrams nor its ancestors' can be found from its id.
    useModelStore.getState().deleteConnection(id)
    useModelStore.getState().deleteObject('A1')
    useModelStore.getState().deleteObject('A2')
    vi.advanceTimersByTime(150)
    expect(lowersOn('dSystems')).toEqual([])
    expect(lowersOn('dGroup')).toEqual([])
    expect(useModelStore.getState().connections.filter((c) => c.kind === 'lower')).toEqual([])
  })

  it('reaches the diagrams showing a GROUP endpoint (RED without the group-id lookup)', () => {
    expect(diagramsReachingEndpoints(useModelStore.getState(), ['G'])).toEqual(['dGroup'])
  })

  it('deleting a G1→G2 lower through the store re-derives the diagram that shows both groups (RED when group endpoints and holders are not reached)', () => {
    // dGroups shows only the two groups; A1 ∈ G1 and A2 ∈ G2 are not on it,
    // so the direct A1→A2 rolls up to G1→G2 there and nowhere else.
    useModelStore.setState((s) => ({
      groups: [...s.groups, group('G1', ['A1']), group('G2', ['A2'])],
      diagrams: [...s.diagrams, diagram('dGroups', { groupIds: ['G1', 'G2'] })],
      connections: [...s.connections, conn('a12', 'A1', 'A2')],
    }))
    useModelStore.getState().syncLowerConnections('dGroups')
    const lower = useModelStore.getState().connections.find((c) => c.kind === 'lower' && c.fromId === 'G1')!
    expect(lowersOn('dGroups')).toEqual(['G1->G2'])
    const synced = spySync()
    useModelStore.getState().deleteConnection(lower.id)
    expect(lowersOn('dGroups')).toEqual([])
    vi.advanceTimersByTime(150)
    // Still needed (A1→A2 is still there): the diagram is re-derived and the
    // roll-up comes back under a fresh id.
    expect(synced).toContain('dGroups')
    expect(lowersOn('dGroups')).toEqual(['G1->G2'])
  })
})
