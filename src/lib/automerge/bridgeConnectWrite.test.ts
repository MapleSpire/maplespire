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
 * USER REPORT 2026-10-11: connecting two shapes froze the page while the save
 * badge showed. Part of the freeze was flushWrite walking EVERY registry meta
 * (and every entity of the touched model shard) through an Automerge change
 * draft to persist one connection. The write now pre-diffs against the
 * materialized documents and drafts only what differs.
 *
 * Driven through the REAL bridge on a SHARDED classic workspace (real
 * Automerge handles on the module repo, resolvers spied — the
 * bridgeDiagramViewWrite.test.ts pattern): store action → onStoreChange →
 * flushWrite → documents.
 *
 * Two kinds of assertion, and both are needed:
 *  - DURABILITY: what each document holds afterwards (the edit landed, the
 *    rest is untouched, a delete still strips non-active compositions, a
 *    non-active rename still lands). These pass on the old full walk too; they
 *    are what the pre-diff must not break.
 *  - WHAT THE DRAFT WAS ASKED FOR: each document's `change` is wrapped so the
 *    keys read under `diagrams` / `connections` / `objects` inside the change
 *    callback are recorded. The old full walk reads every key (RED); the
 *    pre-diff reads only the keys it writes.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { DEFAULT_WORKSPACE_REF } from './workspace'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'

vi.mock('../modelQuery/kvStore', () => ({
  workspaceKvStore: () => ({
    get: async () => undefined,
    set: async () => undefined,
    del: async () => undefined,
    update: async () => undefined,
  }),
}))

const NON_ACTIVE = ['d2', 'd3', 'd4', 'd5', 'd6'] as const

function objectEntity(id: string) {
  return {
    id, type: 'container', name: `Container ${id}`,
    position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
    tagAssignments: {}, tagOrder: [], properties: {},
    scope: 'internal', status: 'live',
  }
}

function connectionEntity(id: string, fromId: string, toId: string) {
  return { id, fromId, toId, type: 'solid', shape: 'curved' }
}

function diagramDoc(name: string, objectIds: string[], connectionIds: string[]) {
  const layouts: Record<string, unknown> = {}
  objectIds.forEach((id, i) => { layouts[id] = { position: { x: i * 300, y: 0 }, size: { width: 200, height: 100 } } })
  return {
    name, type: 'container', objectIds, connectionIds, groupIds: [], layouts,
    comments: {}, flows: {}, checkpoints: [],
  }
}

function meta(id: string, docUrl: string, objectIds: string[], connectionIds: string[]) {
  return { id, name: `Diagram ${id}`, type: 'container', docUrl, objectIds, connectionIds, groupIds: [] }
}

function workspace() {
  const repo = repoModule.repo
  const docs: Record<string, any> = {
    d1: repo.create<any>(diagramDoc('Diagram d1', ['o1', 'o2', 'o3'], ['c0'])),
  }
  for (const id of NON_ACTIVE) docs[id] = repo.create<any>(diagramDoc(`Diagram ${id}`, ['o1', 'o2'], ['c0']))
  const diagrams: Record<string, unknown> = {
    d1: meta('d1', docs.d1.url, ['o1', 'o2', 'o3'], ['c0']),
  }
  for (const id of NON_ACTIVE) diagrams[id] = meta(id, docs[id].url, ['o1', 'o2'], ['c0'])
  const shard = repo.create<any>({ diagrams })
  const objectShard = repo.create<any>({
    objects: { o1: objectEntity('o1'), o2: objectEntity('o2'), o3: objectEntity('o3') },
  })
  const connectionShard = repo.create<any>({ connections: { c0: connectionEntity('c0', 'o1', 'o2') } })
  const modelMeta = repo.create<any>({
    objectShardUrls: [objectShard.url],
    connectionShardUrls: [connectionShard.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const root = repo.create<any>({ shardUrls: [shard.url], modelMetaUrl: modelMeta.url })
  return { root, shard, objectShard, connectionShard, modelMeta, docs }
}

type Workspace = ReturnType<typeof workspace>

const read = (handle: { doc(): unknown }) => handle.doc() as any
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

async function boot(): Promise<Workspace> {
  const ws = workspace()
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(ws.root as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([ws.shard] as any)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(ws.modelMeta as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockImplementation(async (urls: readonly string[]) =>
    urls.map((url) => {
      if (url === ws.objectShard.url) return ws.objectShard
      if (url === ws.connectionShard.url) return ws.connectionShard
      throw new Error(`unexpected model shard url ${url}`)
    }) as any)
  vi.spyOn(repoModule, 'findDiagramHandle').mockImplementation(async (url: string) => {
    for (const handle of Object.values(ws.docs)) if (handle.url === url) return handle
    throw new Error(`unexpected diagram url ${url}`)
  })
  vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
  vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
  const { startBridge, getActiveDiagramHandle } = await import('./bridge')
  await startBridge(DEFAULT_WORKSPACE_REF)
  // Guard against a void run: a sharded, resident boot on d1's REAL doc,
  // with the whole model projected — otherwise every assertion below is about
  // a branch that never ran.
  expect(useAutomergeStatus.getState().status).not.toBe('error')
  expect(useModelStore.getState().currentDiagramId).toBe('d1')
  expect(getActiveDiagramHandle()?.url).toBe(ws.docs.d1.url)
  expect(useModelStore.getState().objects.map((o) => o.id).sort()).toEqual(['o1', 'o2', 'o3'])
  expect(useModelStore.getState().connections.map((c) => c.id)).toEqual(['c0'])
  expect(useModelStore.getState().diagrams.map((d) => d.id).sort()).toEqual(['d1', ...NON_ACTIVE])
  return ws
}

/**
 * Record the keys read under `doc[key]` INSIDE each change callback on
 * `handle`. Wrapping the draft in a Proxy whose target is the Automerge
 * draft proxy itself: every trap but `get` falls through to Automerge's own.
 */
function watchDraftReads(handle: any, key: string) {
  const touched = new Set<string>()
  const original = handle.change.bind(handle)
  const spy = vi.spyOn(handle, 'change').mockImplementation(((callback: any, options?: any) =>
    original((doc: any) => {
      const inner = doc[key]
      const tracked = new Proxy(inner, {
        get(target, prop) {
          if (typeof prop === 'string') touched.add(prop)
          return Reflect.get(target, prop)
        },
      })
      const outer = new Proxy(doc, {
        get(target, prop) {
          return prop === key ? tracked : Reflect.get(target, prop)
        },
      })
      return callback(outer)
    }, options)) as any)
  return { touched, spy }
}

/** Drain the write scheduler synchronously, the way a page hide does. */
async function flushByTeardown() {
  const { stopBridge } = await import('./bridge')
  stopBridge()
}

describe('connecting two shapes through the real bridge (sharded classic workspace)', () => {
  beforeEach(async () => {
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    useModelStore.setState({
      objects: [], connections: [], groups: [], diagrams: [],
      comments: [], flows: [], currentDiagramId: null,
    })
    useAutomergeStatus.setState({
      status: 'connecting', ready: false, visualReady: false, editReady: false,
      projectedWorkspace: null, error: null, bootFallbackActive: false,
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
  })

  it('the new connection lands in its shard, the active meta and the active DiagramDoc — and nothing else moves', async () => {
    const ws = await boot()
    const nonActiveBefore = Object.fromEntries(NON_ACTIVE.map((id) => [id, plain(read(ws.shard).diagrams[id])]))
    const c0Before = plain(read(ws.connectionShard).connections.c0)

    const id = useModelStore.getState().addConnection({ fromId: 'o1', toId: 'o3', type: 'solid' })
    await flushByTeardown()

    expect(read(ws.connectionShard).connections[id]).toMatchObject({ id, fromId: 'o1', toId: 'o3', type: 'solid' })
    expect(plain(read(ws.connectionShard).connections.c0)).toEqual(c0Before)
    expect(read(ws.shard).diagrams.d1.connectionIds).toEqual(['c0', id])
    expect(read(ws.docs.d1).connectionIds).toEqual(['c0', id])
    for (const nid of NON_ACTIVE) expect(plain(read(ws.shard).diagrams[nid])).toEqual(nonActiveBefore[nid])
  })

  it('the flush drafts ONLY the active registry meta and ONLY the new connection (RED on the full walk)', async () => {
    const ws = await boot()
    const registry = watchDraftReads(ws.shard, 'diagrams')
    const connections = watchDraftReads(ws.connectionShard, 'connections')

    const id = useModelStore.getState().addConnection({ fromId: 'o1', toId: 'o3', type: 'solid' })
    await flushByTeardown()

    // Witness that each document WAS written through the wrapped change, so
    // the key sets below are a measurement and not a silence.
    expect(registry.spy).toHaveBeenCalled()
    expect(connections.spy).toHaveBeenCalled()
    expect(read(ws.shard).diagrams.d1.connectionIds).toContain(id)
    // The full walk reads d1..d6 and c0; the pre-diff only what it writes.
    expect([...registry.touched].filter((key) => key.startsWith('d'))).toEqual(['d1'])
    expect([...connections.touched].filter((key) => key === 'c0' || key === id)).toEqual([id])
  })

  it('an edit that changes no registry meta never opens a change on the registry shard (RED on the full walk)', async () => {
    const ws = await boot()
    const registry = watchDraftReads(ws.shard, 'diagrams')
    const connections = watchDraftReads(ws.connectionShard, 'connections')
    // A label edit: the connection shard moves, no diagram composition does.
    useModelStore.getState().updateConnection('c0', { label: 'reads' })
    await flushByTeardown()
    expect(read(ws.connectionShard).connections.c0.label).toBe('reads')
    expect(connections.spy).toHaveBeenCalled()
    expect(registry.spy).not.toHaveBeenCalled()
  })

  it('a registry meta carrying a newer client\'s field, and nothing edited about it, opens no registry change (V0-08 pre-diff)', async () => {
    const ws = await boot()
    // The stub projection drops the unknown field, so the store's desired meta
    // lacks it: under EXACT the pre-diff would flag d4 and draft the shard.
    ws.shard.change((doc: any) => { doc.diagrams.d4.thumbnailV2 = 'kept' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const registry = watchDraftReads(ws.shard, 'diagrams')
    useModelStore.getState().updateConnection('c0', { label: 'reads' })
    await flushByTeardown()
    // Anti-void guard: the flush ran.
    expect(read(ws.connectionShard).connections.c0.label).toBe('reads')
    expect(registry.spy).not.toHaveBeenCalled()
    expect((read(ws.shard).diagrams.d4 as any).thumbnailV2).toBe('kept')
  })

  it('a NON-active diagram rename is still written (the pre-diff sees scalar drift on any meta)', async () => {
    const ws = await boot()
    useModelStore.getState().updateDiagram('d4', { name: 'Renamed elsewhere' })
    await flushByTeardown()
    expect(read(ws.shard).diagrams.d4.name).toBe('Renamed elsewhere')
    expect(read(ws.shard).diagrams.d3.name).toBe('Diagram d3')
  })

  // This file used to pin "a key the desired meta lacks is removed from a
  // NON-active meta" with a peer-written `legacyField` — i.e. the N-1 data loss
  // V0-08 removes. The pre-diff's half of that (an extra KNOWN key in the
  // current meta reads as "would write") is pinned in reconcile.test.ts; a
  // known field written by a peer cannot exercise it here, because it is
  // projected into the store and becomes authoritative (measured: the store's
  // d5 read the peer's value after the flush).
  // V0-08 through the real flush. A newer client's field is written into a
  // document as a peer would; the projection hands it to the store (it
  // spreads entities), so the N-1 store is then made to REBUILD the entity
  // from its own type — what an N-1 editor that constructs a fresh object
  // does — and the next flush must still leave the field in the document.
  it('the active DiagramDoc write keeps a newer client\'s root and nested fields (V0-08)', async () => {
    const ws = await boot()
    ws.docs.d1.change((d: any) => {
      d.annotationsV2 = { a1: 'kept' }
      d.layouts.o1.rotationV2 = 90
    })
    await vi.waitFor(() => expect((useModelStore.getState().diagrams.find((d) => d.id === 'd1') as any)?.annotationsV2).toBeDefined())
    useModelStore.setState((state) => ({
      diagrams: state.diagrams.map((d) => {
        if (d.id !== 'd1') return d
        const { annotationsV2: _a, ...known } = d as any
        const layouts = Object.fromEntries(Object.entries(known.layouts ?? {}).map(([id, l]: [string, any]) => [id, { position: l.position, size: l.size }]))
        return { ...known, layouts }
      }),
    }))
    useModelStore.getState().updateDiagram('d1', { description: 'edited by N-1' })
    await flushByTeardown()
    expect(read(ws.docs.d1).description).toBe('edited by N-1')
    expect(plain(read(ws.docs.d1).annotationsV2)).toEqual({ a1: 'kept' })
    expect(read(ws.docs.d1).layouts.o1.rotationV2).toBe(90)
  })

  // The ModelMeta collections go through `reconcileMapField`: an absent id must
  // still be deleted (a map), and the surviving entity's unknown field kept (a
  // struct inside it). A peer writes x1 (carrying v2Field) and x2; the N-1
  // store rebuilds x1 without the field; x2 is deleted and x1 edited.
  const metaCollections = [
    {
      field: 'groups', slice: 'groups', key: 'id',
      entity: (id: string) => ({ id, name: id, color: '#123456', objectIds: [], tagAssignments: {}, tagOrder: [] }),
      act: () => { useModelStore.getState().deleteGroup('x2'); useModelStore.getState().updateGroup('x1', { name: 'edited' }) },
      edited: 'name',
    },
    {
      field: 'domains', slice: 'domains', key: 'id',
      entity: (id: string) => ({ id, name: id }),
      act: () => { useModelStore.getState().deleteDomain('x2'); useModelStore.getState().updateDomain('x1', { name: 'edited' }) },
      edited: 'name',
    },
    {
      field: 'decisionRecords', slice: 'decisionRecords', key: 'id',
      entity: (id: string) => ({
        id, number: id === 'x1' ? 1 : 2, title: id, summary: '', status: 'in-progress', author: 'a',
        createdAt: '2026-01-01', updatedAt: '2026-01-01', content: '', related: [],
      }),
      act: () => { useModelStore.getState().deleteDecisionRecord('x2'); useModelStore.getState().updateDecisionRecord('x1', { title: 'edited' }) },
      edited: 'title',
    },
    {
      field: 'tagSnapshots', slice: 'tags', key: 'tagId',
      entity: (id: string) => ({ tagId: id, value: id, color: '#000000', groupId: 'g', groupName: 'G', catalogRevision: 1 }),
      act: () => useModelStore.setState((s: any) => ({
        tags: s.tags.filter((t: any) => t.tagId !== 'x2').map((t: any) => (t.tagId === 'x1' ? { ...t, value: 'edited' } : t)),
      })),
      edited: 'value',
    },
  ] as const

  it.each(metaCollections)('ModelMeta $field: a deleted id goes, the edited entity keeps a newer client\'s field (V0-08)', async (c) => {
    const ws = await boot()
    ws.modelMeta.change((m: any) => {
      m[c.field].x1 = { ...c.entity('x1'), v2Field: 'kept' }
      m[c.field].x2 = c.entity('x2')
    })
    const slice = () => (useModelStore.getState() as any)[c.slice] as any[]
    await vi.waitFor(() => expect(slice().map((e) => e[c.key]).sort()).toEqual(['x1', 'x2']))
    useModelStore.setState(((s: any) => ({
      [c.slice]: s[c.slice].map((e: any) => {
        const { v2Field: _v, ...known } = e
        return known
      }),
    })) as any)
    c.act()
    await flushByTeardown()
    const stored = read(ws.modelMeta)[c.field]
    expect(Object.keys(stored).sort()).toEqual(['x1'])
    expect(stored.x1[c.edited]).toBe('edited')
    expect(stored.x1.v2Field).toBe('kept')
  })

  it('the model-shard write keeps a newer client\'s connection field (V0-08)', async () => {
    const ws = await boot()
    ws.connectionShard.change((d: any) => { d.connections.c0.criticalityV2 = 'high' })
    await vi.waitFor(() => expect((useModelStore.getState().connections[0] as any).criticalityV2).toBe('high'))
    useModelStore.setState((state) => ({
      connections: state.connections.map((c) => {
        const { criticalityV2: _c, ...known } = c as any
        return known
      }),
    }))
    useModelStore.getState().updateConnection('c0', { label: 'reads' })
    await flushByTeardown()
    expect(read(ws.connectionShard).connections.c0.label).toBe('reads')
    expect(read(ws.connectionShard).connections.c0.criticalityV2).toBe('high')
  })

  it('a field this build does not know is KEPT on a meta it rewrites (V0-08, N-1 compatibility)', async () => {
    const ws = await boot()
    // A newer client's field on d4's meta; this build's DiagramMeta lacks it.
    ws.shard.change((doc: any) => { doc.diagrams.d4.thumbnailV2 = 'kept' })
    useModelStore.getState().updateDiagram('d4', { name: 'Renamed by N-1' })
    await flushByTeardown()
    expect(read(ws.shard).diagrams.d4.name).toBe('Renamed by N-1')
    expect((read(ws.shard).diagrams.d4 as any).thumbnailV2).toBe('kept')
  })

  it('deleting a connection removes it from its shard (the pre-diff plans removals too)', async () => {
    const ws = await boot()
    useModelStore.getState().deleteConnection('c0')
    await flushByTeardown()
    expect('c0' in read(ws.connectionShard).connections).toBe(false)
    expect(read(ws.shard).diagrams.d1.connectionIds).toEqual([])
  })

  // QA lens 2026-10-11: a model shard whose doc holds no such collection
  // takes the original reconcile. That branch must not throw out of the
  // flush — the registry meta and the DiagramDoc are written after it
  // (RED when the fallback is never taken).
  it('a connection shard with no `connections` map does not abort the rest of the flush', async () => {
    const ws = await boot()
    ws.connectionShard.change((doc: any) => { delete doc.connections })
    const id = useModelStore.getState().addConnection({ fromId: 'o1', toId: 'o3', type: 'solid' })
    await flushByTeardown()
    expect(read(ws.shard).diagrams.d1.connectionIds).toEqual(['c0', id])
    expect(read(ws.docs.d1).connectionIds).toEqual(['c0', id])
  })

  // Review 2026-10-11 (kind guard): an ARRAY where the map should be is an
  // object too, and planning it key by key writes string keys into a list.
  it('a connection shard whose `connections` is an ARRAY takes the original call and does not abort the flush (RED without the Array.isArray guard)', async () => {
    const ws = await boot()
    ws.connectionShard.change((doc: any) => { doc.connections = [] })
    const id = useModelStore.getState().addConnection({ fromId: 'o1', toId: 'o3', type: 'solid' })
    await flushByTeardown()
    expect(Array.isArray(read(ws.connectionShard).connections)).toBe(true)
    expect(read(ws.shard).diagrams.d1.connectionIds).toEqual(['c0', id])
    expect(read(ws.docs.d1).connectionIds).toEqual(['c0', id])
  })

  it('editing one field of an existing connection writes that field', async () => {
    const ws = await boot()
    useModelStore.getState().updateConnection('c0', { label: 'reads', type: 'dashed' })
    await flushByTeardown()
    expect(read(ws.connectionShard).connections.c0).toMatchObject({ label: 'reads', type: 'dashed', fromId: 'o1', toId: 'o2' })
  })
})
