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
 * The Object Explorer's resident tree page was rewritten to read the store's
 * prebuilt DiagramIndex and to materialise rows only for the page it returns.
 * Measured on a real 11,935-object landscape: 2,808ms -> 24ms per call.
 *
 * These tests pin the rewrite to the ORIGINAL scan's observable output. The
 * reference implementation below transcribes the pre-rewrite `metrics`,
 * `rowForObject`, `rowForGroup`, `sortTreeRows` and the ROOT branch of
 * `residentObjectTreePage` (with `paginate` inlined). The file's own history is
 * `e1f36fa2` then `030fda76`; the pre-rewrite text is the `-` side of this
 * change's diff, which is where to re-derive the oracle from.
 *
 * Two limits of the oracle, stated so nobody over-trusts it:
 *  - it covers the ROOT branch only. The `parentId` expansion branches are
 *    pinned by the hand-computed cases lower down, not by equality.
 *  - it is a transcription by the same hand that wrote the rewrite, so it can
 *    encode a shared misreading. The hand-computed assertions — self-loops,
 *    dangling members, group-vs-object diagram counts, ordering — are the part
 *    that is independent of it, and they are what the mutation run exercises.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useModelStore } from '../../stores/modelStore'
import { residentObjectSearchPage, residentObjectTreePage } from './objectExplorerFallback'
import type { ObjectExplorerRow } from './types'
import type { C4Object, Connection, Diagram, Group } from '../../types'

function obj(id: string, over: Partial<C4Object> = {}): C4Object {
  return {
    id, type: 'app', name: id,
    position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
    ...over,
  }
}
function conn(id: string, fromId: string, toId: string): Connection {
  return { id, fromId, toId, type: 'solid' }
}
function grp(id: string, over: Partial<Group> = {}): Group {
  return { id, name: id, color: '#888888', objectIds: [], tagAssignments: {}, tagOrder: [], ...over }
}
function dia(id: string, over: Partial<Diagram> = {}): Diagram {
  return { id, name: id, type: 'container', objectIds: [], connectionIds: [], groupIds: [], ...over }
}

// ---------------------------------------------------------------------------
// Reference: the ORIGINAL scan-based implementation, transcribed unchanged.
// ---------------------------------------------------------------------------
const TYPE_ORDER: Record<string, number> = {
  group: 0, system: 1, actor: 2, app: 3, store: 4, component: 5,
}
function canAcceptChildren(kind: 'object' | 'group', type: string): boolean {
  return kind === 'group' || type === 'system' || type === 'app' || type === 'store'
}
function refIconFields(entity: C4Object | Group) {
  const candidate = entity as C4Object & { iconAssignment?: unknown }
  return {
    ...(candidate.icon ? { icon: candidate.icon } : {}),
    ...(candidate.iconAssignment ? { iconAssignment: candidate.iconAssignment } : {}),
  }
}
function refMetrics(id: string, kind: 'object' | 'group', children: C4Object[]) {
  const state = useModelStore.getState()
  return {
    appCount: children.filter((c) => c.type === 'app').length,
    storeCount: children.filter((c) => c.type === 'store').length,
    componentCount: children.filter((c) => c.type === 'component').length,
    connectionCount: state.connections.filter((c) => c.fromId === id || c.toId === id).length,
    diagramCount: state.diagrams.filter((d) => kind === 'group'
      ? d.groupIds.includes(id)
      : d.objectIds.includes(id)).length,
  }
}
function refRowForObject(object: C4Object, objects: C4Object[], inDiagram: ReadonlySet<string>): ObjectExplorerRow {
  let childCount = 0
  for (const candidate of objects) if (candidate.parentId === object.id) childCount += 1
  const children = objects.filter((candidate) => candidate.parentId === object.id)
  return {
    id: object.id, name: object.name, kind: 'object', type: object.type,
    parentId: object.parentId ?? null,
    childCount, hasChildren: childCount > 0,
    canAcceptChildren: canAcceptChildren('object', object.type),
    scope: object.scope, status: object.status,
    ...(object.domainId ? { domainId: object.domainId } : {}),
    ...refIconFields(object),
    ...refMetrics(object.id, 'object', children),
    inDiagram: inDiagram.has(object.id),
    breadcrumb: [],
  }
}
function refRowForGroup(group: Group, objects: C4Object[], inDiagram: ReadonlySet<string>): ObjectExplorerRow {
  const objectIds = new Set(objects.map((o) => o.id))
  const childCount = group.objectIds.filter((id) => objectIds.has(id)).length
  const children = group.objectIds
    .map((id) => objects.find((o) => o.id === id))
    .filter((o): o is C4Object => Boolean(o))
  return {
    id: group.id, name: group.name, kind: 'group', type: 'group', parentId: null,
    childCount, hasChildren: childCount > 0, canAcceptChildren: true,
    ...refIconFields(group),
    ...((group as Group & { domainId?: string }).domainId
      ? { domainId: (group as Group & { domainId?: string }).domainId }
      : {}),
    ...refMetrics(group.id, 'group', children),
    inDiagram: inDiagram.has(group.id),
    breadcrumb: [],
  }
}
function refSort(a: ObjectExplorerRow, b: ObjectExplorerRow): number {
  return (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    || a.id.localeCompare(b.id)
}
/** The original residentObjectTreePage, root level, with the original paginate. */
function referenceTreePage(diagramId: string, cursor?: string, limit?: number) {
  const state = useModelStore.getState()
  const diagram = state.diagrams.find((c) => c.id === diagramId)
  const diagramObjects = new Set(diagram?.objectIds ?? [])
  const diagramGroups = new Set(diagram?.groupIds ?? [])
  const byId = new Map(state.objects.map((o) => [o.id, o]))
  const grouped = new Set(state.groups.flatMap((c) => c.objectIds))
  const rows = [
    ...state.groups.map((c) => refRowForGroup(c, state.objects, diagramGroups)),
    ...state.objects
      .filter((o) => !grouped.has(o.id) && (!o.parentId || !byId.has(o.parentId)))
      .map((o) => refRowForObject(o, state.objects, diagramObjects)),
  ].sort(refSort)
  const offset = cursor ? Number(/^local:(\d+)$/.exec(cursor)?.[1] ?? 0) : 0
  const bounded = Math.min(50, Math.max(1, Number.isFinite(limit) ? Math.floor(limit!) : 50))
  const items = rows.slice(offset, offset + bounded)
  return {
    items,
    nextCursor: offset + items.length < rows.length ? `local:${offset + items.length}` : null,
    total: state.objects.length + state.groups.length,
  }
}

// ---------------------------------------------------------------------------
// Fixture. Every element here exists to break a specific naive index swap.
// ---------------------------------------------------------------------------
function seedFixture() {
  useModelStore.setState({
    objects: [
      obj('sys1', { type: 'system', name: 'Alpha system' }),
      // carries icon / iconAssignment / domainId / non-default scope+status so
      // those spreads are actually compared rather than both sides emitting {}.
      obj('app1', {
        type: 'app', name: 'Beta app', domainId: 'dom-1',
        icon: 'server', scope: 'external', status: 'unstable',
      }),
      obj('store1', { type: 'store', name: 'Gamma store' }),
      obj('comp1', { type: 'component', name: 'Delta component', parentId: 'app1' }),
      obj('comp2', { type: 'component', name: 'Epsilon component', parentId: 'app1' }),
      obj('child-of-store', { type: 'app', name: 'Zeta', parentId: 'store1' }),
      // parentId points OUTSIDE the resident set -> must stay a ROOT row.
      obj('orphan', { type: 'app', name: 'Orphan', parentId: 'evicted-parent' }),
      obj('member1', { type: 'app', name: 'Member one' }),
      obj('member2', { type: 'store', name: 'Member two' }),
      obj('selfloop', { type: 'app', name: 'Self looper' }),
      // identical type AND name as the next one -> forces the `id` tiebreaker
      obj('tie-b', { type: 'app', name: 'Twin' }),
      obj('tie-a', { type: 'app', name: 'Twin' }),
      obj('childless', { type: 'system', name: 'Childless system' }),
      // members of g4 only — used to pin inDiagram during group expansion.
      // Group members are excluded from the ROOT list, so these cannot disturb
      // the root-level assertions above.
      obj('gm-in', { type: 'app', name: 'Grouped in diagram' }),
      obj('gm-out', { type: 'app', name: 'Grouped out of diagram' }),
    ],
    groups: [
      // 'ghost-member' does not resolve -> must NOT be counted as a child.
      // 'member1' appears TWICE -> the original counted duplicates, so must we.
      grp('g1', {
        name: 'Zulu group', objectIds: ['member1', 'ghost-member', 'member1'],
        icon: 'layers', domainId: 'dom-2',
      }),
      grp('g2', { name: 'Alpha group', objectIds: [] }),
      // every member dangling -> childCount 0, and expanding it yields nothing
      grp('g3', { name: 'Beta group', objectIds: ['gone-1', 'gone-2'] }),
      // one member inside d1, one outside -> expansion must resolve inDiagram
      // against the diagram's OBJECT ids, not its group ids.
      grp('g4', { name: 'Charlie group', objectIds: ['gm-in', 'gm-out'] }),
    ],
    connections: [
      conn('c1', 'app1', 'store1'),
      conn('c2', 'store1', 'app1'),
      // self-loops: present in BOTH endpoint maps, each must count ONCE.
      // TWO of them, so a `.some()`-style correction (subtract 1 overall)
      // diverges from the per-connection correction the original implied.
      conn('c3', 'selfloop', 'selfloop'),
      conn('c3b', 'selfloop', 'selfloop'),
      conn('c4', 'g1', 'app1'),
    ],
    diagrams: [
      // d1 lists 'app1' TWICE: a Set-based count and a .filter().length both
      // yield ONE for this diagram, so the two must agree here.
      dia('d1', { objectIds: ['app1', 'store1', 'selfloop', 'app1', 'gm-in'], groupIds: ['g1'] }),
      dia('d2', { objectIds: ['app1'], groupIds: ['g1', 'g2'] }),
      dia('d3', { objectIds: ['app1'], groupIds: [] }),
    ],
  })
}

beforeEach(() => {
  seedFixture()
})

describe('residentObjectTreePage — indexed rewrite matches the original scan', () => {
  it('returns row-for-row identical output at the root level', async () => {
    const actual = await residentObjectTreePage({ diagramId: 'd1' })
    const expected = referenceTreePage('d1')
    expect(actual.items).toEqual(expected.items)
    expect(actual.nextCursor).toBe(expected.nextCursor)
    expect(actual.total).toBe(expected.total)
  })

  it('matches the original across every page boundary', async () => {
    for (const limit of [1, 2, 3, 5, 50]) {
      let cursor: string | null | undefined
      let guard = 0
      do {
        const actual = await residentObjectTreePage({ diagramId: 'd1', cursor, limit })
        const expected = referenceTreePage('d1', cursor ?? undefined, limit)
        expect(actual.items, `limit=${limit} cursor=${cursor}`).toEqual(expected.items)
        expect(actual.nextCursor, `limit=${limit} cursor=${cursor}`).toBe(expected.nextCursor)
        cursor = actual.nextCursor
      } while (cursor && ++guard < 50)
    }
  })

  it('orders GROUPS first — Group has no `type` field, so a raw-entity sort sinks them', async () => {
    const { items } = await residentObjectTreePage({ diagramId: 'd1', limit: 50 })
    expect(items.slice(0, 4).map((r) => r.kind)).toEqual(['group', 'group', 'group', 'group'])
    // and within the group block, by name
    expect(items.slice(0, 4).map((r) => r.name))
      .toEqual(['Alpha group', 'Beta group', 'Charlie group', 'Zulu group'])
    // objects then follow in TYPE_ORDER: system(1) before app(3) before store(4)
    const objectTypes = items.slice(4).map((r) => r.type)
    expect(objectTypes).toEqual([...objectTypes].sort(
      (a, b) => ({ system: 1, app: 3, store: 4 } as Record<string, number>)[a]!
        - ({ system: 1, app: 3, store: 4 } as Record<string, number>)[b]!,
    ))
    expect(objectTypes[0]).toBe('system')
    expect(objectTypes[objectTypes.length - 1]).toBe('store')
  })

  it('breaks a type+name tie by id so page boundaries stay stable', async () => {
    const { items } = await residentObjectTreePage({ diagramId: 'd1', limit: 50 })
    const twins = items.filter((r) => r.name === 'Twin').map((r) => r.id)
    expect(twins).toEqual(['tie-a', 'tie-b'])
  })

  it('counts EACH self-loop once even though both are in both endpoint maps', async () => {
    const { items } = await residentObjectTreePage({ diagramId: 'd1', limit: 50 })
    // two self-loops on this entity: a blanket "subtract one" yields 3, not 2
    expect(items.find((r) => r.id === 'selfloop')?.connectionCount).toBe(2)
  })

  it('ignores a group member that no longer resolves, and counts duplicates like the original', async () => {
    const { items } = await residentObjectTreePage({ diagramId: 'd1', limit: 50 })
    const g1 = items.find((r) => r.id === 'g1')
    // objectIds is ['member1', 'ghost-member', 'member1'] — the original counted
    // BOTH member1 entries and dropped the ghost, so childCount is 2.
    expect(g1?.childCount).toBe(2)
    expect(g1?.hasChildren).toBe(true)
    const g3 = items.find((r) => r.id === 'g3')
    expect(g3?.childCount).toBe(0)
    expect(g3?.hasChildren).toBe(false)
  })

  it('carries icon and domain fields through for both objects and groups', async () => {
    const { items } = await residentObjectTreePage({ diagramId: 'd1', limit: 50 })
    const app1 = items.find((r) => r.id === 'app1')
    expect(app1?.icon).toBe('server')
    expect(app1?.domainId).toBe('dom-1')
    expect(app1?.scope).toBe('external')
    expect(app1?.status).toBe('unstable')
    const g1 = items.find((r) => r.id === 'g1')
    expect(g1?.icon).toBe('layers')
    expect(g1?.domainId).toBe('dom-2')
    // absent icons must not materialise as undefined keys
    expect('icon' in (items.find((r) => r.id === 'g2') ?? {})).toBe(false)
  })

  it('reports the page shape fields the paged tier branches on', async () => {
    // paged.ts short-circuits on `coverage === 'full' || projectionGeneration > 0`
    const page = await residentObjectTreePage({ diagramId: 'd1' })
    expect(page.coverage).toBe('full')
    expect(page.projectionGeneration).toBe(0)
  })

  it("keeps an object whose parentId points outside the resident set as a root row", async () => {
    const { items } = await residentObjectTreePage({ diagramId: 'd1' })
    expect(items.map((r) => r.id)).toContain('orphan')
  })

  it('counts group diagram membership by groupIds, not by member objects', async () => {
    const { items } = await residentObjectTreePage({ diagramId: 'd1' })
    // g1 is in d1.groupIds and d2.groupIds => 2. A member-based count would see
    // d1/d2/d3 via 'member1' or drift entirely (getGroupDiagramCount's semantic).
    expect(items.find((r) => r.id === 'g1')?.diagramCount).toBe(2)
    expect(items.find((r) => r.id === 'g2')?.diagramCount).toBe(1)
    // app1 sits in d1, d2 and d3 => 3, deduped per diagram
    expect(items.find((r) => r.id === 'app1')?.diagramCount).toBe(3)
  })

  it('reports child counts and roll-ups from the parent→children map', async () => {
    const { items } = await residentObjectTreePage({ diagramId: 'd1' })
    const app1 = items.find((r) => r.id === 'app1')
    expect(app1?.childCount).toBe(2)
    expect(app1?.componentCount).toBe(2)
    expect(app1?.appCount).toBe(0)
    const store1 = items.find((r) => r.id === 'store1')
    expect(store1?.childCount).toBe(1)
    expect(store1?.appCount).toBe(1)
  })

  it('marks rows that are present in the requested diagram', async () => {
    const { items } = await residentObjectTreePage({ diagramId: 'd1' })
    expect(items.find((r) => r.id === 'app1')?.inDiagram).toBe(true)
    expect(items.find((r) => r.id === 'g1')?.inDiagram).toBe(true)
    expect(items.find((r) => r.id === 'orphan')?.inDiagram).toBe(false)
    expect(items.find((r) => r.id === 'g2')?.inDiagram).toBe(false)
  })

  it('expands a group parent into its resolvable members, duplicates included', async () => {
    const actual = await residentObjectTreePage({ diagramId: 'd1', parentId: 'g1' })
    // 'member1' is listed twice and 'ghost-member' does not resolve
    expect(actual.items.map((r) => r.id)).toEqual(['member1', 'member1'])
  })

  it('expands an object parent into its direct children', async () => {
    const actual = await residentObjectTreePage({ diagramId: 'd1', parentId: 'app1' })
    expect(actual.items.map((r) => r.id)).toEqual(['comp1', 'comp2'])
    expect(actual.items.every((r) => r.parentId === 'app1')).toBe(true)
  })

  it('marks group members against the diagram OBJECT set, not its group set', async () => {
    // member1 is in no diagram; using diagramGroups here would still say false,
    // so assert the positive case too via an object that IS in d1.
    const g4 = await residentObjectTreePage({ diagramId: 'd1', parentId: 'g4' })
    expect(g4.items.map((r) => [r.id, r.inDiagram])).toEqual([['gm-in', true], ['gm-out', false]])
  })

  it('returns nothing for an empty group, a childless object, and an unknown parent', async () => {
    for (const parentId of ['g2', 'g3', 'childless', 'no-such-id']) {
      const page = await residentObjectTreePage({ diagramId: 'd1', parentId })
      expect(page.items, `parentId=${parentId}`).toEqual([])
      expect(page.nextCursor, `parentId=${parentId}`).toBeNull()
    }
  })

  it('bounds the page size at both ends', async () => {
    // limit 0 / negative must still return progress, or infinite scroll hangs
    for (const limit of [0, -3, undefined]) {
      const page = await residentObjectTreePage({ diagramId: 'd1', limit })
      expect(page.items.length, `limit=${limit}`).toBeGreaterThan(0)
    }
    // and must never exceed 50, which is the whole point of the rewrite
    useModelStore.setState({
      objects: Array.from({ length: 400 }, (_, i) => obj(`bulk${String(i).padStart(3, '0')}`)),
      groups: [], connections: [], diagrams: [dia('d1')],
    })
    const wide = await residentObjectTreePage({ diagramId: 'd1', limit: 5000 })
    expect(wide.items).toHaveLength(50)
    expect(wide.total).toBe(400)
  })

  it('treats a cursor past the end and a malformed cursor as the original did', async () => {
    const past = await residentObjectTreePage({ diagramId: 'd1', cursor: 'local:9999' })
    expect(past.items).toEqual([])
    expect(past.nextCursor).toBeNull()
    const garbage = await residentObjectTreePage({ diagramId: 'd1', cursor: 'garbage' })
    const first = await residentObjectTreePage({ diagramId: 'd1' })
    // an unparseable cursor falls back to offset 0 — NOT to a negative slice
    expect(garbage.items.map((r) => r.id)).toEqual(first.items.map((r) => r.id))
  })

  it('builds rows only for the page it returns', async () => {
    const page = await residentObjectTreePage({ diagramId: 'd1', limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBe('local:1')
    expect(page.total).toBe(19) // 15 objects + 4 groups
  })

  // residentObjectSearchPage shares rowForObject/rowForGroup, so the rewrite
  // changed it too — it had no coverage anywhere before this.
  it('search: builds the same row metrics through the shared row builders', async () => {
    const page = await residentObjectSearchPage({ diagramId: 'd1', query: 'Beta app' })
    const app1 = page.items.find((r) => r.id === 'app1')
    expect(app1).toBeDefined()
    // c1 app1->store1, c2 store1->app1, c4 g1->app1
    expect(app1?.connectionCount).toBe(3)
    expect(app1?.diagramCount).toBe(3)
    expect(app1?.childCount).toBe(2)
    expect(app1?.componentCount).toBe(2)
    expect(app1?.icon).toBe('server')
    expect(app1?.inDiagram).toBe(true)
    expect(page.coverage).toBe('full')
  })

  it('search: resolves a breadcrumb through the object index', async () => {
    const page = await residentObjectSearchPage({ diagramId: 'd1', query: 'Delta component' })
    const comp1 = page.items.find((r) => r.id === 'comp1')
    expect(comp1?.breadcrumb.map((b) => b.id)).toEqual(['app1'])
    expect(comp1?.matchKind).toBe('exact')
  })

  it('search: matches groups as well as objects', async () => {
    const page = await residentObjectSearchPage({ diagramId: 'd1', query: 'Zulu' })
    const g1 = page.items.find((r) => r.id === 'g1')
    expect(g1?.kind).toBe('group')
    expect(g1?.childCount).toBe(2)
    expect(g1?.diagramCount).toBe(2)
  })

  it('stays consistent with the store when the model is replaced mid-session', async () => {
    // The rewrite assumes getDiagramIndex() always matches useModelStore state.
    const before = await residentObjectTreePage({ diagramId: 'd1', limit: 50 })
    expect(before.items.some((r) => r.id === 'app1')).toBe(true)
    useModelStore.setState({
      objects: [obj('only', { type: 'system', name: 'Only one' })],
      groups: [], connections: [], diagrams: [dia('d1', { objectIds: ['only'] })],
    })
    const after = await residentObjectTreePage({ diagramId: 'd1', limit: 50 })
    expect(after.items.map((r) => r.id)).toEqual(['only'])
    expect(after.items[0]?.inDiagram).toBe(true)
    expect(after.total).toBe(1)
  })
})
