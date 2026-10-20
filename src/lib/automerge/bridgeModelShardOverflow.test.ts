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
 * A model shard created on overflow is not pointed at by ModelMeta until the
 * server has acknowledged it — when its id is minted. Driven through the REAL
 * bridge on a sharded classic workspace (the bridgeConnectWrite.test.ts
 * pattern): store action → flushWrite → writeModelShards overflow →
 * publishModelShardReference → durability round → ModelMeta.
 *
 * The server is the spied `acknowledgeDurableDocumentHeads`: it answers
 * `durable` only for documents the test has put in `serverHolds`.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocHandle, DocumentId } from '@automerge/automerge-repo'
import * as repoModule from './repo'
import * as durableSyncModule from './durableSync'
import { DEFAULT_WORKSPACE_REF } from './workspace'
import { DEFERRED_REFERENCES_KEY } from './deferredReferences'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import type { KvStore } from '../modelQuery/kvStore'

// Three objects fill a shard, so the fourth overflows. Read by bridge.ts at
// import, which every test below does dynamically, after this line.
vi.stubEnv('VITE_MODEL_SHARD_SIZE', '3')

vi.mock('../modelQuery/kvStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modelQuery/kvStore')>()
  let store = actual.createMemoryKvStore()
  return {
    ...actual,
    workspaceKvStore: () => store,
    __resetMemoryStore: () => { store = actual.createMemoryKvStore() },
    __memoryStore: () => store,
  }
})

async function memoryStore(): Promise<KvStore> {
  return ((await import('../modelQuery/kvStore')) as any).__memoryStore()
}

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

function workspace() {
  const repo = repoModule.repo
  // Three of each: both shards are full (VITE_MODEL_SHARD_SIZE=3).
  const connectionIds = ['c1', 'c2', 'c3']
  const d1 = repo.create<any>({
    name: 'Diagram d1', type: 'container', objectIds: ['o1', 'o2', 'o3'], connectionIds, groupIds: [],
    layouts: {}, comments: {}, flows: {}, checkpoints: [],
  })
  const shard = repo.create<any>({
    diagrams: { d1: { id: 'd1', name: 'Diagram d1', type: 'container', docUrl: d1.url, objectIds: ['o1', 'o2', 'o3'], connectionIds, groupIds: [] } },
  })
  const objectShard = repo.create<any>({ objects: { o1: objectEntity('o1'), o2: objectEntity('o2'), o3: objectEntity('o3') } })
  const connectionShard = repo.create<any>({
    connections: {
      c1: connectionEntity('c1', 'o1', 'o2'),
      c2: connectionEntity('c2', 'o2', 'o3'),
      c3: connectionEntity('c3', 'o3', 'o1'),
    },
  })
  const modelMeta = repo.create<any>({
    objectShardUrls: [objectShard.url],
    connectionShardUrls: [connectionShard.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const root = repo.create<any>({ shardUrls: [shard.url], modelMetaUrl: modelMeta.url })
  return { root, shard, objectShard, connectionShard, modelMeta, d1 }
}

type Workspace = ReturnType<typeof workspace>
const read = (handle: { doc(): unknown }) => handle.doc() as any

/** Documents the fake server holds; everything else is answered not durable. */
let serverHolds: Set<string>
let createdObjectShards: DocHandle<any>[]
let createdConnectionShards: DocHandle<any>[]
let minted: boolean

async function boot(ws: Workspace, extraShards: DocHandle<any>[] = []): Promise<void> {
  const known = [ws.objectShard, ws.connectionShard, ...extraShards]
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(ws.root as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([ws.shard] as any)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(ws.modelMeta as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockImplementation(async (urls: readonly string[]) =>
    urls.map((url) => {
      const handle = known.find((h) => h.url === url)
      if (!handle) throw new Error(`unexpected model shard url ${url}`)
      return handle
    }) as any)
  vi.spyOn(repoModule, 'findHeldModelShardHandle').mockImplementation(async (url: string) => {
    const handle = known.find((h) => h.url === url)
    if (!handle) throw new Error(`held shard ${url} is not in this browser`)
    return handle as any
  })
  vi.spyOn(repoModule, 'findDiagramHandle').mockResolvedValue(ws.d1 as any)
  vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
  vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
  const { startBridge } = await import('./bridge')
  await startBridge(DEFAULT_WORKSPACE_REF)
  // Guard against a void run: a sharded RESIDENT boot, the whole model projected.
  expect(useAutomergeStatus.getState().status, String(useAutomergeStatus.getState().error)).not.toBe('error')
  expect(useModelStore.getState().currentDiagramId).toBe('d1')
}

function addObject(): string {
  return useModelStore.getState().addObject({
    type: 'container', name: 'Overflow', position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
  } as any)
}

const POLL = { timeout: 5_000, interval: 20 }

/** True once an acknowledgement round has sent this document to the server. */
function askedAbout(documentId: string): boolean {
  return vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls
    .some(([documents]) => documents.some((d) => d.documentId === documentId))
}

function addConnection(): string {
  return useModelStore.getState().addConnection({ fromId: 'o1', toId: 'o3', type: 'solid' } as any)
}

describe('model-shard overflow publishes its pointer only after the server holds the shard', () => {
  beforeEach(async () => {
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    ;((await import('../modelQuery/kvStore')) as any).__resetMemoryStore()
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
    serverHolds = new Set()
    createdObjectShards = []
    createdConnectionShards = []
    minted = true
    const createObjectShard = repoModule.createObjectShardHandle
    vi.spyOn(repoModule, 'createObjectShardHandle').mockImplementation((initial) => {
      const handle = createObjectShard(initial)
      createdObjectShards.push(handle)
      return handle
    })
    const createConnectionShard = repoModule.createConnectionShardHandle
    vi.spyOn(repoModule, 'createConnectionShardHandle').mockImplementation((initial) => {
      const handle = createConnectionShard(initial)
      createdConnectionShards.push(handle)
      return handle
    })
    // The repo names these test shards with random ids; the spy decides which
    // count as minted (the real format check is pinned in repoMintedIdFormat.test.ts).
    vi.spyOn(repoModule, 'isMintedDocumentId').mockImplementation(
      (id: DocumentId) => minted && [...createdObjectShards, ...createdConnectionShards].some((h) => h.documentId === id),
    )
    vi.spyOn(durableSyncModule, 'acknowledgeDurableDocumentHeads').mockImplementation(async (documents) =>
      documents.map(({ documentId }) => ({ documentId, durable: serverHolds.has(documentId) })))
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
  })

  it('a MINTED shard is used at once, held out of ModelMeta, and published when the server acknowledges it', async () => {
    const ws = workspace()
    await boot(ws)
    const id = addObject()

    await expect.poll(() => createdObjectShards.length, POLL).toBe(1)
    const [created] = createdObjectShards
    await expect.poll(() => Object.keys(read(created).objects ?? {}), POLL).toEqual([id])
    // Held: the meta does not point at a shard the server does not have …
    expect(read(ws.modelMeta).objectShardUrls).toEqual([ws.objectShard.url])
    // … the pointer is owed, persisted …
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([
      { holderDocumentId: ws.modelMeta.documentId, field: 'objectShardUrls', url: created.url },
    ])
    // … and the author still sees the object.
    expect(useModelStore.getState().objects.map((o) => o.id)).toContain(id)
    // Wait until a round has ASKED about the new shard and been answered "not
    // durable" (polled: rounds are debounced 180 ms and every write re-arms
    // that) — the pointer must still be held after that answer.
    await expect.poll(() => askedAbout(created.documentId), POLL).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(read(ws.modelMeta).objectShardUrls).toEqual([ws.objectShard.url])

    serverHolds.add(created.documentId)

    await expect.poll(() => [...read(ws.modelMeta).objectShardUrls], POLL).toEqual([ws.objectShard.url, created.url])
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
  })

  it('a RANDOM-id shard is pointed at in the same turn, as before (the server can only claim it through the pointer)', async () => {
    minted = false
    const ws = workspace()
    await boot(ws)
    addObject()

    await expect.poll(() => createdObjectShards.length, POLL).toBe(1)
    expect(read(ws.modelMeta).objectShardUrls).toEqual([ws.objectShard.url, createdObjectShards[0].url])
    expect(await (await memoryStore()).get(DEFERRED_REFERENCES_KEY)).toBeUndefined()
  })

  it('after a reload, a held shard is loaded from the queue (the author sees its objects) and published once acknowledged', async () => {
    const ws = workspace()
    const held = repoModule.repo.create<any>({ objects: { o4: objectEntity('o4') } })
    const reference = { holderDocumentId: ws.modelMeta.documentId, field: 'objectShardUrls', url: held.url }
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])

    await boot(ws, [held])

    expect(useModelStore.getState().objects.map((o) => o.id).sort()).toEqual(['o1', 'o2', 'o3', 'o4'])
    expect(read(ws.modelMeta).objectShardUrls).toEqual([ws.objectShard.url])
    // Re-entered in the durability ledger, so the round asks about it again.
    await expect.poll(() => askedAbout(held.documentId), POLL).toBe(true)

    serverHolds.add(held.documentId)

    await expect.poll(() => [...read(ws.modelMeta).objectShardUrls], POLL).toEqual([ws.objectShard.url, held.url])
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
  })

  it('a CONNECTION-shard overflow is held the same way, in connectionShardUrls', async () => {
    // 2026-10-19: no test overflowed a connection shard, so dropping
    // its pointer or writing it into the wrong field passed every suite.
    const ws = workspace()
    await boot(ws)
    const id = addConnection()

    await expect.poll(() => createdConnectionShards.length, POLL).toBe(1)
    const [created] = createdConnectionShards
    await expect.poll(() => Object.keys(read(created).connections ?? {}), POLL).toEqual([id])
    await expect.poll(() => askedAbout(created.documentId), POLL).toBe(true)
    expect(read(ws.modelMeta).connectionShardUrls).toEqual([ws.connectionShard.url])
    expect(read(ws.modelMeta).objectShardUrls).toEqual([ws.objectShard.url])
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([
      { holderDocumentId: ws.modelMeta.documentId, field: 'connectionShardUrls', url: created.url },
    ])

    serverHolds.add(created.documentId)

    await expect.poll(() => [...read(ws.modelMeta).connectionShardUrls], POLL)
      .toEqual([ws.connectionShard.url, created.url])
    expect(read(ws.modelMeta).objectShardUrls).toEqual([ws.objectShard.url])
  })

  it('after a reload, a held CONNECTION shard comes back as connections, not objects', async () => {
    const ws = workspace()
    const held = repoModule.repo.create<any>({ connections: { c9: connectionEntity('c9', 'o1', 'o3') } })
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [
      { holderDocumentId: ws.modelMeta.documentId, field: 'connectionShardUrls', url: held.url },
    ])

    await boot(ws, [held])

    expect(useModelStore.getState().connections.map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3', 'c9'])
    serverHolds.add(held.documentId)
    await expect.poll(() => [...read(ws.modelMeta).connectionShardUrls], POLL)
      .toEqual([ws.connectionShard.url, held.url])
  })

  it('a url ModelMeta lists twice (two tabs published one held shard) loads ONE handle, and routing stays whole', async () => {
    // 2026-10-19: concurrent list inserts both survive the
    // merge; a duplicate index split the shard's routing and its buckets
    // overwrote each other on the next flush.
    const ws = workspace()
    ws.modelMeta.change((m: any) => { m.objectShardUrls.push(ws.objectShard.url) })
    await boot(ws)
    const shardHandleCalls = vi.mocked(repoModule.getModelShardHandles).mock.calls
    expect(shardHandleCalls[0][0]).toEqual([ws.objectShard.url])

    // An edit that flushes the shard must keep its three objects.
    useModelStore.getState().updateObject('o1', { name: 'Renamed' })
    await expect.poll(() => read(ws.objectShard).objects.o1.name, POLL).toBe('Renamed')
    expect(Object.keys(read(ws.objectShard).objects).sort()).toEqual(['o1', 'o2', 'o3'])
  })

  it('a held shard this browser cannot load is retried on later boots and given up at the third', async () => {
    const ws = workspace()
    const reference = { holderDocumentId: ws.modelMeta.documentId, field: 'objectShardUrls', url: 'automerge:2j9Fq5ZQfRrR1CbGCJm5qUxZHfVh' }
    const store = await memoryStore()
    await store.set(DEFERRED_REFERENCES_KEY, [reference])
    const { stopBridge } = await import('./bridge')

    await boot(ws)
    await expect.poll(async () => store.get(DEFERRED_REFERENCES_KEY), POLL).toEqual([{ ...reference, resumeFailures: 1 }])
    stopBridge()
    await boot(ws)
    await expect.poll(async () => store.get(DEFERRED_REFERENCES_KEY), POLL).toEqual([{ ...reference, resumeFailures: 2 }])
    stopBridge()
    await boot(ws)
    await expect.poll(async () => store.get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    expect(read(ws.modelMeta).objectShardUrls).toEqual([ws.objectShard.url])
  })

  it('when the held pointer cannot be queued, it is written at once rather than lost with the session', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await boot(ws)
    vi.spyOn(store, 'update').mockRejectedValue(new Error('IndexedDB is gone'))
    addObject()

    await expect.poll(() => createdObjectShards.length, POLL).toBe(1)
    await expect.poll(() => [...read(ws.modelMeta).objectShardUrls], POLL)
      .toEqual([ws.objectShard.url, createdObjectShards[0].url])
    expect(serverHolds.size).toBe(0) // written although the server never acknowledged it
  })

  it('a queued pointer the meta already carries is dropped at boot, not published twice', async () => {
    const ws = workspace()
    const reference = { holderDocumentId: ws.modelMeta.documentId, field: 'objectShardUrls', url: ws.objectShard.url }
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])

    await boot(ws)

    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    expect(read(ws.modelMeta).objectShardUrls).toEqual([ws.objectShard.url])
    expect(useModelStore.getState().objects.map((o) => o.id).sort()).toEqual(['o1', 'o2', 'o3'])
  })
})
