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

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useModelStore } from '../../stores/modelStore'
import {
  connectionRowsFromStore, pickerEntriesFromStore, modelObjectRowsFromStore,
  connectionRowsFromIndex, pickerEntriesFromIndex, modelObjectRowsFromIndex,
} from './heavyViews'
import { buildModelIndex } from './modelIndex'
import { createMemoryKvStore } from './kvStore'
import type { C4Object, Connection, Group, Diagram, Flow } from '../../types'

const obj = (id: string, over: Partial<C4Object> = {}): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...over,
})
const conn = (id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection =>
  ({ id, fromId, toId, type: 'solid', ...over })
const grp = (id: string, name = id): Group => ({ id, name, color: '#888', objectIds: [], tagAssignments: {}, tagOrder: [] })

beforeEach(() => {
  const objects = [
    obj('a', { name: 'Alpha', domainId: 'd1' }),
    obj('b', { name: 'Bravo', domainId: 'd2' }),
    obj('c', { name: 'Charlie', domainId: 'd1' }),
  ]
  const connections = [
    conn('c1', 'a', 'b', { label: 'sends' }),
    conn('c2', 'b', 'c', { label: 'reads' }),
    conn('c3', 'a', 'c', { label: 'writes' }),
  ]
  const diagrams: Diagram[] = [
    { id: 'dg1', name: 'D1', type: 'context', objectIds: ['a', 'b'], connectionIds: ['c1', 'c2'], groupIds: [] },
  ]
  const flows: Flow[] = [
    { id: 'f1', name: 'F1', diagramId: 'dg1', steps: [{ id: 's', order: 1, type: 'message', title: 't', fromObjectId: 'a', toObjectId: 'b', connectionId: 'c1' }] },
  ]
  const groups = [grp('g1', 'Group One')]
  useModelStore.setState({ objects, connections, diagrams, flows, groups })
})

describe('connectionRowsFromStore', () => {
  it('enriches names + diagram/flow counts and reports the total', () => {
    const { rows, total } = connectionRowsFromStore({ sortBy: 'name', sortAsc: true })
    expect(total).toBe(3)
    const c1 = rows.find((r) => r.connection.id === 'c1')!
    expect(c1.fromName).toBe('Alpha')
    expect(c1.toName).toBe('Bravo')
    expect(c1.diagramCount).toBe(1) // in dg1
    expect(c1.flowCount).toBe(1) // f1 messages a→b
    expect(rows.find((r) => r.connection.id === 'c3')!.diagramCount).toBe(0)
  })

  it('sorts (by sender name) and pages with offset/limit', () => {
    const sorted = connectionRowsFromStore({ sortBy: 'sender', sortAsc: true })
    expect(sorted.rows.map((r) => r.fromName)).toEqual(['Alpha', 'Alpha', 'Bravo'])
    const page = connectionRowsFromStore({ sortBy: 'sender', sortAsc: true, offset: 1, limit: 1 })
    expect(page.rows.length).toBe(1)
    expect(page.total).toBe(3)
  })

  it('filters by search (label or endpoint name) and by domain', () => {
    expect(connectionRowsFromStore({ search: 'sends' }).total).toBe(1)
    expect(connectionRowsFromStore({ search: 'charlie' }).total).toBe(2) // c2 (→c), c3 (→c)
    // domain d2 only touches b → c1 (a→b) + c2 (b→c)
    expect(connectionRowsFromStore({ domainId: 'd2' }).total).toBe(2)
  })
})

describe('pickerEntriesFromStore', () => {
  it('lists objects + groups, searchable + paged', () => {
    const all = pickerEntriesFromStore({})
    expect(all.total).toBe(4) // 3 objects + 1 group
    expect(all.entries.map((e) => e.name)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Group One']) // sorted
    expect(all.entries.find((e) => e.kind === 'group')?.name).toBe('Group One')
    expect(pickerEntriesFromStore({ search: 'al' }).total).toBe(1) // Alpha
    const page = pickerEntriesFromStore({ offset: 1, limit: 2 })
    expect(page.entries.map((e) => e.name)).toEqual(['Bravo', 'Charlie'])
    expect(page.total).toBe(4)
  })
})

describe('modelObjectRowsFromStore', () => {
  // A small C4 hierarchy: system → {app → component, store}, plus a root actor.
  beforeEach(() => {
    const objects = [
      obj('sys', { type: 'system', name: 'Sys' }),
      obj('app1', { type: 'app', name: 'App1', parentId: 'sys' }),
      obj('st1', { type: 'store', name: 'St1', parentId: 'sys' }),
      obj('cmp1', { type: 'component', name: 'Cmp1', parentId: 'app1' }),
      obj('act', { type: 'actor', name: 'Act', domainId: 'd1' }),
    ]
    const connections = [conn('x1', 'act', 'sys')]
    const diagrams: Diagram[] = [
      { id: 'dg', name: 'D', type: 'context', objectIds: ['sys', 'act'], connectionIds: ['x1'], groupIds: [] },
    ]
    useModelStore.setState({ objects, connections, diagrams, flows: [], groups: [] })
  })

  it('collapsed: only root objects (sorted system→actor) with subtree + edge counts', () => {
    const { rows } = modelObjectRowsFromStore({ expandedIds: [] })
    expect(rows.map((r) => r.id)).toEqual(['sys', 'act'])
    const sys = rows.find((r) => r.id === 'sys')!
    expect(sys.isExpandable).toBe(true)
    expect(sys.childCount).toBe(2)
    expect(sys.appCount).toBe(1) // app1
    expect(sys.storeCount).toBe(1) // st1
    expect(sys.componentCount).toBe(1) // cmp1 (under app1)
    expect(sys.connectionCount).toBe(1) // x1 touches sys
    expect(sys.diagramCount).toBe(1) // in dg
    expect(rows.find((r) => r.id === 'act')).toMatchObject({ isExpandable: false, childCount: 0 })
  })

  it('expanding a system inserts an inline-add slot then its children (not grandchildren)', () => {
    const ids = modelObjectRowsFromStore({ expandedIds: ['sys'] }).rows.map((r) => r.id)
    expect(ids).toContain('inline-add-sys')
    expect(ids).toContain('app1')
    expect(ids).toContain('st1')
    expect(ids).not.toContain('cmp1') // app1 still collapsed
    const add = modelObjectRowsFromStore({ expandedIds: ['sys'] }).rows.find((r) => r.id === 'inline-add-sys')!
    expect(add.isInlineAdd).toBe(true)
    expect(add.addTypes).toEqual(['app', 'store'])
    expect(add.level).toBe(1)
  })

  it('expanding deeper reveals component children (level 2) under an app', () => {
    const { rows } = modelObjectRowsFromStore({ expandedIds: ['sys', 'app1'] })
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('inline-add-component-app1')
    expect(ids).toContain('cmp1')
    expect(rows.find((r) => r.id === 'cmp1')!.level).toBe(2)
  })

  it('filters roots by search (name), type and domain', () => {
    expect(modelObjectRowsFromStore({ expandedIds: [], search: 'act' }).rows.map((r) => r.id)).toEqual(['act'])
    expect(modelObjectRowsFromStore({ expandedIds: [], filter: { types: ['actor'] } }).rows.map((r) => r.id)).toEqual(['act'])
    expect(modelObjectRowsFromStore({ expandedIds: [], domainId: 'd1' }).rows.map((r) => r.id)).toEqual(['act'])
  })

  it('search surfaces a NESTED match with its ancestors (a component inside a System)', () => {
    // Regression: searching a term that matches only a deeply-nested component (Cmp1, under App1,
    // under Sys) must surface that component WITH its System → App ancestor chain — not return
    // empty. The
    // non-matching sibling store is NOT pulled in, and a pure search injects no inline-add rows.
    const { rows } = modelObjectRowsFromStore({ expandedIds: [], search: 'Cmp' })
    expect(rows.map((r) => r.id)).toEqual(['sys', 'app1', 'cmp1'])
    expect(rows.some((r) => r.id === 'st1')).toBe(false)
    expect(rows.some((r) => r.isInlineAdd)).toBe(false)
  })

  it('a manually-expanded node still reveals ALL its children while searching its own name', () => {
    // The construction flow (search a System to pin it, expand, then add/select its children)
    // must keep working: expansion overrides the filter for that node's direct children, and the
    // inline-add slots stay present even while a search is active.
    const ids = modelObjectRowsFromStore({ expandedIds: ['sys'], search: 'Sys' }).rows.map((r) => r.id)
    expect(ids).toContain('sys')
    expect(ids).toContain('inline-add-sys') // inline-add present while searching + expanded
    expect(ids).toContain('app1')           // non-matching children revealed by expansion
    expect(ids).toContain('st1')
  })

  it('never weakens a structured facet when an ancestor is manually expanded', () => {
    const rows = modelObjectRowsFromStore({
      expandedIds: ['sys'],
      filter: { types: ['app'] },
    }).rows

    expect(rows.map((row) => row.id)).toEqual(['sys', 'app1'])
    expect(rows.some((row) => row.id === 'st1' || row.id === 'cmp1' || row.isInlineAdd)).toBe(false)
  })

  it('lists groups (name-sorted) ahead of root objects', () => {
    useModelStore.setState({ groups: [grp('g1', 'Zeta'), grp('g0', 'Alpha')] })
    const { rows } = modelObjectRowsFromStore({ expandedIds: [] })
    expect(rows.slice(0, 2).map((r) => r.id)).toEqual(['g0', 'g1']) // Alpha, Zeta
    expect(rows.slice(0, 2).every((r) => r.isGroup)).toBe(true)
    expect(rows.map((r) => r.id)).toEqual(['g0', 'g1', 'sys', 'act'])
  })

  it('reuses cached count maps across calls but reflects the live group list', () => {
    // First call populates the cache (keyed by the object/connection/diagram refs).
    expect(modelObjectRowsFromStore({ expandedIds: [] }).rows.map((r) => r.id)).toEqual(['sys', 'act'])
    // Adding a group changes only `groups` (not the cached refs) — must still appear.
    useModelStore.setState({ groups: [grp('g0', 'Alpha')] })
    expect(modelObjectRowsFromStore({ expandedIds: [] }).rows.map((r) => r.id)).toEqual(['g0', 'sys', 'act'])
  })
})

// The windowing safety net: when the store is windowed, the global tables read the
// COMPLETE index instead of the partial store. *FromIndex must return byte-identical
// rows to *FromStore over the same model (objects + connections from the index;
// groups + diagrams + flows from the resident store).
describe('heavy views — index-backed == store-backed (windowing agreement)', () => {
  it('connectionRows: index == store across search / domain / sort / paging', async () => {
    const s = useModelStore.getState()
    const store = createMemoryKvStore()
    await buildModelIndex(store, { objects: s.objects, connections: s.connections, groups: s.groups, diagrams: s.diagrams })
    const cases: Parameters<typeof connectionRowsFromStore>[0][] = [
      { sortBy: 'name', sortAsc: true },
      { sortBy: 'sender', sortAsc: false },
      { sortBy: 'diagrams', sortAsc: true },
      { sortBy: 'flows', sortAsc: true },
      { search: 'charlie' },
      { domainId: 'd2' },
      { sortBy: 'name', sortAsc: true, offset: 1, limit: 1 },
    ]
    for (const opts of cases) {
      const fromStore = connectionRowsFromStore(opts)
      const fromIndex = await connectionRowsFromIndex(store, opts)
      expect(fromIndex.total).toBe(fromStore.total)
      expect(fromIndex.rows).toEqual(fromStore.rows)
    }
  })

  it('modelObjectRows: index == store (tree, counts, expansion, filters)', async () => {
    // A small hierarchy so the tree + counts exercise the index path.
    const objects = [
      obj('sys', { type: 'system', name: 'Sys' }),
      obj('app1', { type: 'app', name: 'App1', parentId: 'sys' }),
      obj('cmp1', { type: 'component', name: 'Cmp1', parentId: 'app1' }),
      obj('act', { type: 'actor', name: 'Act' }),
    ]
    const connections = [conn('x1', 'act', 'sys')]
    const diagrams: Diagram[] = [{ id: 'dg', name: 'D', type: 'context', objectIds: ['sys'], connectionIds: ['x1'], groupIds: [] }]
    useModelStore.setState({ objects, connections, diagrams, flows: [], groups: [grp('g', 'Grp')] })
    const s = useModelStore.getState()
    const store = createMemoryKvStore()
    await buildModelIndex(store, { objects: s.objects, connections: s.connections, groups: s.groups, diagrams: s.diagrams })
    // Includes a NESTED-match search (`Cmp` matches only the deep component) so BOTH backends are
    // pinned to surface the ancestor chain identically — not equal-but-empty.
    for (const opts of [{ expandedIds: [] }, { expandedIds: ['sys'] }, { expandedIds: ['sys', 'app1'] }, { expandedIds: [], search: 'sys' }, { expandedIds: [], search: 'Cmp' }]) {
      const fromStore = modelObjectRowsFromStore(opts)
      const fromIndex = await modelObjectRowsFromIndex(store, opts)
      expect(fromIndex.rows).toEqual(fromStore.rows)
    }
  })

  it('expands group members once and keeps their object hierarchy', async () => {
    useModelStore.setState({
      objects: [
        obj('sys', { type: 'system', name: 'Sys' }),
        obj('app1', { type: 'app', name: 'App1', parentId: 'sys' }),
      ],
      groups: [{ ...grp('g0', 'Group'), objectIds: ['sys'] }],
    })
    const opts = { expandedIds: ['g0'] }
    const rows = modelObjectRowsFromStore(opts).rows
    const state = useModelStore.getState()
    const store = createMemoryKvStore()
    await buildModelIndex(store, {
      objects: state.objects, connections: state.connections, groups: state.groups, diagrams: state.diagrams,
    })
    expect((await modelObjectRowsFromIndex(store, opts)).rows).toEqual(rows)
    expect(rows.filter((row) => row.id === 'sys')).toHaveLength(1)
    expect(rows.find((row) => row.id === 'g0')).toMatchObject({ isGroup: true, isExpandable: true })
    expect(rows.find((row) => row.id === 'sys')?.level).toBe(1)
  })

  it('technology filter uses postings, keeps ancestors, and never scans all objects', async () => {
    const withTechnology = (base: C4Object, technologyId?: string): C4Object => ({
      ...base,
      ...(technologyId ? {
        technologyUsages: {
          u1: { id: 'u1', technologyId, catalogRevision: 1, snapshot: { name: technologyId } },
        },
      } : {}),
    } as unknown as C4Object)
    const objects = [
      withTechnology(obj('sys', { type: 'system', name: 'System' })),
      withTechnology(obj('app', { type: 'app', name: 'App', parentId: 'sys' })),
      withTechnology(obj('db', { type: 'store', name: 'DB', parentId: 'sys' }), 'postgres'),
      withTechnology(obj('cmp', { type: 'component', name: 'Angular UI', parentId: 'app' }), 'angular'),
      withTechnology(obj('actor', { type: 'actor', name: 'User' })),
    ]
    const connections = [conn('uses', 'actor', 'sys')]
    useModelStore.setState({ objects, connections, diagrams: [], flows: [], groups: [] })
    const store = createMemoryKvStore()
    await buildModelIndex(store, { objects, connections, groups: [], diagrams: [] })
    store.scanPrefix = vi.fn(async () => { throw new Error('technology filtering must not scan the model') })

    const opts = { expandedIds: [], filter: { technologyIds: ['angular'] } }
    const resident = modelObjectRowsFromStore(opts)
    const indexed = await modelObjectRowsFromIndex(store, opts)

    expect(indexed).toEqual(resident)
    expect(indexed.rows.map((row) => row.id)).toEqual(['sys', 'app', 'cmp'])
    expect(indexed.rows.some((row) => row.id === 'db')).toBe(false)
    expect(store.scanPrefix).not.toHaveBeenCalled()

    // Expanding retained ancestors is a presentation choice only: it must not
    // weaken the active Technology predicate or reveal unrelated siblings.
    const expandedOpts = { expandedIds: ['sys', 'app'], filter: { technologyIds: ['angular'] } }
    const expandedResident = modelObjectRowsFromStore(expandedOpts)
    const expandedIndexed = await modelObjectRowsFromIndex(store, expandedOpts)
    expect(expandedIndexed).toEqual(expandedResident)
    expect(expandedIndexed.rows.map((row) => row.id)).toEqual(['sys', 'app', 'cmp'])
    expect(expandedIndexed.rows.some((row) => row.id === 'db' || row.isInlineAdd)).toBe(false)
  })

  it('technology filter matches a group in both resident and offline-index modes', async () => {
    const objects = [obj('app', { name: 'Application' })]
    const groups: Group[] = [{
      ...grp('platform', 'Platform group'),
      technologyUsages: {
        terraform: {
          id: 'terraform', technologyId: 'terraform', catalogRevision: 2,
          snapshot: { schemaVersion: 1, name: 'Terraform', recommendedShapeTypes: ['group'] },
        },
      },
    }]
    useModelStore.setState({ objects, connections: [], diagrams: [], flows: [], groups })
    const store = createMemoryKvStore()
    await buildModelIndex(store, { objects, connections: [], groups, diagrams: [] })
    store.scanPrefix = vi.fn(async () => { throw new Error('technology filtering must not scan entities') })

    const opts = { expandedIds: [], filter: { technologyIds: ['terraform'] } }
    const resident = modelObjectRowsFromStore(opts)
    const indexed = await modelObjectRowsFromIndex(store, opts)

    expect(indexed).toEqual(resident)
    expect(indexed.rows.map((row) => row.id)).toEqual(['platform'])
    expect(indexed.total).toBe(2)
    expect(store.scanPrefix).not.toHaveBeenCalled()
  })

  it('pickerEntries: index == store (objects + groups, searched + paged)', async () => {
    const s = useModelStore.getState()
    const store = createMemoryKvStore()
    await buildModelIndex(store, { objects: s.objects, connections: s.connections, groups: s.groups, diagrams: s.diagrams })
    for (const opts of [{}, { search: 'al' }, { offset: 1, limit: 2 }]) {
      const fromStore = pickerEntriesFromStore(opts)
      const fromIndex = await pickerEntriesFromIndex(store, opts)
      expect(fromIndex.total).toBe(fromStore.total)
      expect(fromIndex.entries).toEqual(fromStore.entries)
    }
  })
})
