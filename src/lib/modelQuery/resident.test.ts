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
import { useModelStore, getDiagramIndex } from '../../stores/modelStore'
import { residentModelQuery } from './resident'
import { getModelQuery, __setModelQueryForTest } from './index'
import { __resetIndexReady } from './offlineIndex'
import { setActiveWorkspaceRef, DEFAULT_WORKSPACE_REF } from '../automerge/workspace'
import type { C4Object, Connection, Group, Diagram } from '../../types'

function obj(id: string, over: Partial<C4Object> = {}): C4Object {
  return {
    id, type: 'app', name: id,
    position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
    ...over,
  }
}
function conn(id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection {
  return { id, fromId, toId, type: 'solid', ...over }
}
function grp(id: string, over: Partial<Group> = {}): Group {
  return { id, name: id, color: '#888888', objectIds: [], tagAssignments: {}, tagOrder: [], ...over }
}

function seed(opts: { objects?: C4Object[]; connections?: Connection[]; groups?: Group[]; diagrams?: Diagram[] }) {
  useModelStore.setState({
    objects: opts.objects ?? [], connections: opts.connections ?? [],
    groups: opts.groups ?? [], diagrams: opts.diagrams ?? [],
  })
}

// B → A, G1 → A (incoming); A → C ×2 (outgoing); A → A (self-loop); D child of A.
function smallGraph() {
  return {
    objects: [obj('A'), obj('B'), obj('C'), obj('D', { parentId: 'A', domainId: 'dom1' })],
    groups: [grp('G1', { domainId: 'dom2' })],
    connections: [
      conn('c1', 'B', 'A'),
      conn('c2', 'A', 'C', { kind: 'direct' }),
      conn('c3', 'A', 'A'),
      conn('c4', 'G1', 'A'),
      conn('c5', 'A', 'C', { kind: 'lower' }),
    ],
  }
}

beforeEach(() => {
  // The validation worktree intentionally enables the server-backed read model
  // through Vite env flags. Keep this seam test deterministic: it verifies the
  // flag-OFF fallback, independent of the environment running the suite.
  vi.stubEnv('VITE_MODEL_PAGING', 'false')
  vi.stubEnv('VITE_SERVER_READ_MODEL', 'false')
  __resetIndexReady()
  seed(smallGraph())
})
afterEach(() => {
  __setModelQueryForTest(null)
  vi.unstubAllEnvs()
})

describe('residentModelQuery — no regression vs direct store/index', () => {
  it('incoming(): toId===focus edges, self-loops excluded, peer=fromId', async () => {
    const edges = await residentModelQuery.incoming('A')
    const expected = useModelStore.getState().connections.filter((c) => c.toId === 'A' && c.fromId !== 'A')
    expect(edges.map((e) => e.connection.id).sort()).toEqual(expected.map((c) => c.id).sort())
    expect(edges.map((e) => e.peerId).sort()).toEqual(['B', 'G1'])
    expect(edges.every((e) => e.peerId === e.connection.fromId)).toBe(true)
  })

  it('outgoing(): fromId===focus edges, self-loops excluded, peer=toId', async () => {
    const edges = await residentModelQuery.outgoing('A')
    const expected = useModelStore.getState().connections.filter((c) => c.fromId === 'A' && c.toId !== 'A')
    expect(edges.map((e) => e.connection.id).sort()).toEqual(expected.map((c) => c.id).sort())
    expect(edges.map((e) => e.peerId)).toEqual(['C', 'C'])
  })

  it('self-loop is excluded from both fans', async () => {
    expect((await residentModelQuery.incoming('A')).some((e) => e.connection.id === 'c3')).toBe(false)
    expect((await residentModelQuery.outgoing('A')).some((e) => e.connection.id === 'c3')).toBe(false)
  })

  it('object()/group() match the index', async () => {
    expect(await residentModelQuery.object('A')).toBe(getDiagramIndex().objectById.get('A'))
    expect((await residentModelQuery.object('A'))?.name).toBe('A')
    expect(await residentModelQuery.group('G1')).toBe(getDiagramIndex().groupById.get('G1'))
    expect(await residentModelQuery.object('missing')).toBeUndefined()
    expect(await residentModelQuery.group('missing')).toBeUndefined()
  })

  it('lookupMany() batch-resolves objects and groups', async () => {
    const m = await residentModelQuery.lookupMany(['A', 'G1', 'missing'])
    expect(m.get('A')?.name).toBe('A')
    expect(m.get('G1')?.name).toBe('G1')
    expect(m.has('missing')).toBe(false)
  })

  it('connectionCount() (self-loop once)', async () => {
    expect(await residentModelQuery.connectionCount('A')).toBe(5)
    expect(await residentModelQuery.connectionCount('G1')).toBe(1)
    expect(await residentModelQuery.connectionCount('missing')).toBe(0)
  })

  it('descendants() matches getDescendantObjects', async () => {
    expect(await residentModelQuery.descendants('A')).toEqual(useModelStore.getState().getDescendantObjects('A'))
    expect(await residentModelQuery.descendants('A')).toEqual(['D'])
    expect(await residentModelQuery.descendants('D')).toEqual([])
  })

  it('relatedDiagrams() preserves the store result behind the bounded contract', async () => {
    const result = await residentModelQuery.relatedDiagrams('A')
    expect(result).toMatchObject({
      detail: [], reference: [], parent: [],
      totals: { detail: 0, reference: 0, parent: 0 },
      limit: 50,
      truncated: false,
    })
  })

  it('unknown focus yields no edges', async () => {
    expect(await residentModelQuery.incoming('nope')).toEqual([])
    expect(await residentModelQuery.outgoing('nope')).toEqual([])
  })
})

describe('getModelQuery() seam', () => {
  it('defaults to the resident implementation', () => {
    expect(getModelQuery()).toBe(residentModelQuery)
  })

  it('test override swaps the implementation and resets', () => {
    const fake = { ...residentModelQuery }
    __setModelQueryForTest(fake)
    expect(getModelQuery()).toBe(fake)
    __setModelQueryForTest(null)
    expect(getModelQuery()).toBe(residentModelQuery)
  })

  // The paging index + server tier are namespaced/keyed per workspace, so selection
  // must be identical no matter which workspace is active (flags off here, so both
  // land on resident — the point is that the workspace switch alone changes nothing).
  describe('selection is workspace-independent (flags off ⇒ resident either way)', () => {
    afterEach(() => setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF))

    it('default workspace', () => {
      setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
      expect(getModelQuery()).toBe(residentModelQuery)
    })

    it('a non-default workspace (previously force-resident via isDefaultWorkspaceActive)', () => {
      setActiveWorkspaceRef({ landscapeId: 'ls-1', versionId: 'v-1' })
      expect(getModelQuery()).toBe(residentModelQuery)
    })
  })
})
