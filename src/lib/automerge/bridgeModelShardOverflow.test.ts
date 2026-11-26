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
import * as A from '@automerge/automerge'
import { ImmutableString, type DocHandle, type DocumentId } from '@automerge/automerge-repo'
import { adoptScalarMetaUrls, readMetaUrls } from './modelMetaUrls'
import * as repoModule from './repo'
import * as durableSyncModule from './durableSync'
import * as repoCompatModule from './repoCompat'
import * as workspaceBindingModule from './workspaceBinding'
import { DEFAULT_WORKSPACE_REF } from './workspace'
import { DEFERRED_REFERENCES_KEY } from './deferredReferences'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { useEpochHopStore } from '../../stores/epochHopStore'
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

async function boot(
  ws: Workspace, extraShards: DocHandle<any>[] = [], afterShardLoad?: () => void,
  /** A meta the "server" gives: undefined falls through. */
  findMeta?: (url: string) => Promise<DocHandle<any> | undefined>,
  /** Shards the boot loads from the meta but a HELD find cannot. */
  heldUnloadable: string[] = [],
): Promise<void> {
  const known = [ws.objectShard, ws.connectionShard, ...extraShards]
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(ws.root as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([ws.shard] as any)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockImplementation(async (url: string) =>
    ((await findMeta?.(url)) ?? known.find((h) => h.url === url) ?? ws.modelMeta) as any)
  let shardLoads = 0
  vi.spyOn(repoModule, 'getModelShardHandles').mockImplementation(async (urls: readonly string[]) => {
    const handles = urls.map((url) => {
      const handle = known.find((h) => h.url === url)
      if (!handle) throw new Error(`unexpected model shard url ${url}`)
      return handle
    })
    shardLoads += 1
    if (shardLoads === 2) afterShardLoad?.() // after the object AND connection lists
    return handles as any
  })
  vi.spyOn(repoModule, 'findHeldModelShardHandle').mockImplementation(async (url: string) => {
    const handle = heldUnloadable.includes(url) ? undefined : known.find((h) => h.url === url)
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
    // G4-16f: ALSO journaled, `unminted`, until the
    // server acknowledges the shard — then dequeued.
    const created = createdObjectShards[0]
    // With the hash of the shard's FIRST change,
    // which the resume asks about without reading the shard's history.
    const firstChange = A.decodeChange(A.getAllChanges(created.doc()!)[0]!).hash
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([
      { holderDocumentId: ws.modelMeta.documentId, field: 'objectShardUrls', url: created.url, unminted: true, firstChange },
    ])
    serverHolds.add(created.documentId)
    serverHolds.add(ws.modelMeta.documentId)
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
  })

  it('an UNMINTED pointer held on the OLD meta, after a roll and a reload, is written into the CURRENT meta AT ONCE and its shard loaded', async () => {
    const ws = workspace()
    // The roll: the meta booted on now is E1, whose predecessor is the meta
    // the pointer was written into (offline, before the roll).
    const oldMeta = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url], connectionShardUrls: [ws.connectionShard.url] })
    ws.modelMeta.change((m: any) => { m.modelEpoch = 1; m.epochPredecessorRef = new ImmutableString(oldMeta.url) })
    const held = repoModule.repo.create<any>({ objects: { o4: objectEntity('o4') } })
    const reference = { holderDocumentId: oldMeta.documentId, field: 'objectShardUrls', url: held.url, unminted: true }
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])

    await boot(ws, [held])

    // The author sees the objects, and the pointer is in the CURRENT meta
    // as soon as the server says it never received the shard (in the
    // background, after the first render).
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id).sort(), POLL).toEqual(['o1', 'o2', 'o3', 'o4'])
    await expect.poll(() => [...read(ws.modelMeta).objectShardUrls], POLL).toEqual([ws.objectShard.url, held.url])
    expect(serverHolds.size).toBe(0)
    // Re-entered in the durability ledger, dequeued once acknowledged.
    await expect.poll(() => askedAbout(held.documentId), POLL).toBe(true)
    expect(await (await memoryStore()).get(DEFERRED_REFERENCES_KEY)).toEqual([reference])
    serverHolds.add(held.documentId)
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
  })

  it('the server ADOPTS the shard into the current meta WHILE the tab boots — it is loaded all the same', async () => {
    const ws = workspace()
    const oldMeta = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url] })
    ws.modelMeta.change((m: any) => { m.modelEpoch = 1; m.epochPredecessorRef = new ImmutableString(oldMeta.url) })
    const held = repoModule.repo.create<any>({ objects: { o6: objectEntity('o6') } })
    const reference = { holderDocumentId: oldMeta.documentId, field: 'objectShardUrls', url: held.url, unminted: true }
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    await boot(ws, [held], () => {
      // The adoption lands after the boot read the meta's shard list.
      ws.modelMeta.change((m: any) => { m.objectShardUrls.push(held.url) })
    })
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id), POLL).toContain('o6')
    expect([...read(ws.modelMeta).objectShardUrls]).toEqual([ws.objectShard.url, held.url]) // once
  })

  it('the server HOLDS the shard the meta adopted while the tab booted — it is LOADED (in the background), never written twice', async () => {
    const ws = workspace()
    const oldMeta = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url] })
    ws.modelMeta.change((m: any) => { m.modelEpoch = 1; m.epochPredecessorRef = new ImmutableString(oldMeta.url) })
    const held = repoModule.repo.create<any>({ objects: { o6: objectEntity('o6') } })
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [{ holderDocumentId: oldMeta.documentId, field: 'objectShardUrls', url: held.url, unminted: true }])
    serverHolds.add(held.documentId)
    await boot(ws, [held], () => {
      ws.modelMeta.change((m: any) => { m.objectShardUrls.push(held.url) })
    })
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id), POLL).toContain('o6')
    const { epochHopProbe } = await import('./bridge')
    expect(epochHopProbe().objectShards.filter((id) => id === held.documentId)).toHaveLength(1)
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    expect([...read(ws.modelMeta).objectShardUrls]).toEqual([ws.objectShard.url, held.url])
  })

  it('TWO rolls the tab never saw — E2 → E1 is loaded once, the pointer held on E0 is resumed, and the lineage is persisted', async () => {
    const ws = workspace()
    const e0 = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url] })
    const e1 = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url], modelEpoch: 1, epochPredecessorRef: new ImmutableString(e0.url) })
    ws.modelMeta.change((m: any) => { m.modelEpoch = 2; m.epochPredecessorRef = new ImmutableString(e1.url) })
    const held = repoModule.repo.create<any>({ objects: { o5: objectEntity('o5') } })
    const reference = { holderDocumentId: e0.documentId, field: 'objectShardUrls', url: held.url }
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    // E1 was never booted in this browser: not in memory, only the server
    // (here `findModelMetaHandle`) has it.
    const realSynced = repoCompatModule.syncedHandle
    vi.spyOn(repoCompatModule, 'syncedHandle').mockImplementation((r: any, id: any) => (id === e1.documentId ? undefined : realSynced(r, id)) as any)
    await boot(ws, [held, e1 as any])
    const findHeld = repoModule.findModelMetaHandle

    // A MINTED pointer: held until the server acknowledges the shard. E1
    // is loaded AFTER the first render, in the background — the
    // shard then joins the projection.
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id), POLL).toContain('o5')
    serverHolds.add(held.documentId)
    await expect.poll(() => [...read(ws.modelMeta).objectShardUrls], POLL).toEqual([ws.objectShard.url, held.url])
    expect(vi.mocked(findHeld).mock.calls.map(([url]) => url)).toContain(e1.url)
    const store = await memoryStore()
    await expect.poll(async () => {
      const lineages = await store.scanPrefix<Record<string, string>>('epoch-lineage:v1')
      return lineages.length === 1 ? lineages[0]![1] : lineages.length
    }, POLL).toMatchObject({ [ws.modelMeta.documentId]: e1.documentId, [e1.documentId]: e0.documentId })
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

  it('G4-16f: on a SCALAR-ruled ModelMeta (an epoch meta) "already carried" is read from the ruling list, not the frozen mirror', async () => {
    // The pointer was published after the epoch's birth: it is in the scalar
    // list only. Read raw, the frozen text mirror would call it unpublished
    // and hold it again (`bridge.ts` isPublished).
    const ws = workspace()
    const held = repoModule.repo.create<any>({ objects: { o4: objectEntity('o4') } })
    ws.modelMeta.change((m: any) => {
      adoptScalarMetaUrls(m)
      m.objectShardRefs.push(new ImmutableString(held.url))
    })
    expect(read(ws.modelMeta).objectShardUrls).toEqual([ws.objectShard.url])
    const reference = { holderDocumentId: ws.modelMeta.documentId, field: 'objectShardUrls', url: held.url }
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])

    await boot(ws, [held])

    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, held.url])
  })

  /** E(n−1) listed `x` (the offline write); a FULL roll recreated it in place
   * as `xPrime` in E(n), the meta booted on. */
  function fullRollOf(ws: Workspace, objects: string[]) {
    const entities = Object.fromEntries(objects.map((id) => [id, objectEntity(id)]))
    const x = repoModule.repo.create<any>({ objects: entities })
    const oldMeta = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url, x.url], connectionShardUrls: [ws.connectionShard.url] })
    const xPrime = repoModule.repo.create<any>({ objects: structuredClone(entities) })
    ws.modelMeta.change((m: any) => {
      m.modelEpoch = 1
      m.epochPredecessorRef = new ImmutableString(oldMeta.url)
      m.objectShardUrls.push(xPrime.url)
    })
    const reference = { holderDocumentId: oldMeta.documentId, field: 'objectShardUrls', url: x.url, unminted: true }
    return { x, xPrime, oldMeta, reference }
  }

  it('an UNMINTED entry whose shard the server already HOLDS (a full roll recreated it, X → X′) is dequeued, never written into the current meta', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = fullRollOf(ws, ['o4'])
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    // The server received E0 and X before the roll: X is claimed.
    serverHolds.add(x.documentId)
    await boot(ws, [x, xPrime])
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    // X appended to E1 would win over X′ for every reader (list order is precedence).
    expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, xPrime.url])
    expect(useModelStore.getState().objects.map((o) => o.id).sort()).toEqual(['o1', 'o2', 'o3', 'o4'])
    const { epochHopProbe } = await import('./bridge')
    expect(epochHopProbe().objectShards).not.toContain(x.documentId)
  })

  it('no answer → X is shown PROVISIONALLY and nothing written; its ids stay routed to the LISTED copy, a flush empties neither, a new object never goes into X; once answered "unknown", it is written', async () => {
    const ws = workspace()
    // X′ is full (3); X, provisional, takes no new id.
    const { x, xPrime, reference } = fullRollOf(ws, ['o4', 'o5', 'o6'])
    x.change((d: any) => {
      d.objects.o4.name = 'Frozen at the cut'
      d.objects.o8 = objectEntity('o8') // only X has it: routed there
    })
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    let offline = true
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) => {
      if (offline) throw new TypeError('Failed to fetch')
      return documents.map(({ documentId }) => ({ documentId, durable: serverHolds.has(documentId) }))
    })
    const { epochHopProbe, __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [60] })
    try {
      await boot(ws, [x, xPrime])
      await expect.poll(() => epochHopProbe().objectShards, POLL).toContain(x.documentId)
      expect(epochHopProbe().provisionalShards).toEqual([x.url])
      expect(useModelStore.getState().objects.map((o) => o.id).sort()).toEqual(['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o8'])
      // The LISTED copy is what the tab shows (merge: listed last, later wins).
      expect(useModelStore.getState().objects.find((o) => o.id === 'o4')?.name).toBe('Container o4')
      expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, xPrime.url])

      useModelStore.getState().updateObject('o4', { name: 'Edited' })
      useModelStore.getState().updateObject('o8', { name: 'Edited in X' })
      const id = addObject()
      // The edit lands in the LISTED copy, o8's in X — whose flush keeps what
      // the listed copy holds (a delete there would be forwarded into X′);
      // the new object in a NEW shard, never in X (a late "held" would take
      // it off the screen, and X is never republished).
      await expect.poll(() => read(xPrime).objects.o4?.name, POLL).toBe('Edited')
      await expect.poll(() => read(x).objects.o8?.name, POLL).toBe('Edited in X')
      await expect.poll(() => createdObjectShards.length, POLL).toBe(1)
      await expect.poll(() => Object.keys(read(createdObjectShards[0]).objects ?? {}), POLL).toEqual([id])
      expect(Object.keys(read(x).objects).sort()).toEqual(['o4', 'o5', 'o6', 'o8'])
      expect(Object.keys(read(xPrime).objects).sort()).toEqual(['o4', 'o5', 'o6'])
      expect(read(x).objects.o4.name).toBe('Frozen at the cut')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(useModelStore.getState().objects.find((o) => o.id === 'o4')?.name).toBe('Edited')
      expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, xPrime.url])

      // Still offline past several retries: asked again, nothing written.
      const asks = () => vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls
        .filter(([documents]) => documents.length === 1 && documents[0]!.documentId === x.documentId).length
      await expect.poll(asks, POLL).toBeGreaterThan(2)
      expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, xPrime.url])
      // Back online, the server has never received X: it is written now, and
      // the tab's own from then on.
      offline = false
      await expect.poll(() => readMetaUrls(read(ws.modelMeta), 'objectShardUrls'), POLL)
        .toEqual([ws.objectShard.url, xPrime.url, x.url])
      expect(epochHopProbe().provisionalShards).toEqual([])
      expect(epochHopProbe().objectShards).toContain(x.documentId)
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('the question finds nobody, the retry answers RETIRED → X leaves the projection (what only it held too), its entry is dequeued, and no new object ever goes into it', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = fullRollOf(ws, ['o4', 'o5', 'o6'])
    // o7 was deleted from X′ in the new epoch by someone else: only X has it.
    x.change((d: any) => { d.objects.o7 = objectEntity('o7') })
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    let offline = true
    let asking = false
    let answer: () => void = () => undefined
    const answered = new Promise<void>((resolve) => { answer = resolve })
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) => {
      if (offline) throw new TypeError('Failed to fetch')
      if (documents.length === 1 && documents[0]!.documentId === x.documentId) { asking = true; await answered }
      return documents.map(({ documentId }) => (documentId === x.documentId
        ? { documentId, durable: false, forwarded: false, epochRetired: true }
        : { documentId, durable: serverHolds.has(documentId) })) as any
    })
    const { epochHopProbe, __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [300] })
    try {
      await boot(ws, [x, xPrime])
      await expect.poll(() => epochHopProbe().objectShards, POLL).toContain(x.documentId)
      expect(useModelStore.getState().objects.map((o) => o.id)).toContain('o7')
      // While it waits, a new object is not placed in X.
      const first = addObject()
      await expect.poll(() => createdObjectShards.length, POLL).toBe(1)
      await expect.poll(() => Object.keys(read(createdObjectShards[0]).objects ?? {}), POLL).toEqual([first])
      offline = false
      await expect.poll(() => asking, POLL).toBe(true)
      // Typed, not flushed yet, when the answer takes X off: written first.
      useModelStore.getState().updateObject('o1', { name: 'Typed before the unload' })
      answer()
      await expect.poll(() => epochHopProbe().objectShards, POLL).not.toContain(x.documentId)
      expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o7')
      expect(useModelStore.getState().objects.find((o) => o.id === 'o1')?.name).toBe('Typed before the unload')
      await expect.poll(() => read(ws.objectShard).objects.o1.name, POLL).toBe('Typed before the unload')
      expect(epochHopProbe().provisionalShards).toEqual([])
      // Answered: nothing written, the entry dequeued (a retired document is
      // never durable) — the new shard's minted pointer is still held.
      await expect.poll(async () => ((await (await memoryStore()).get<any[]>(DEFERRED_REFERENCES_KEY)) ?? []).map((r) => r.url), POLL)
        .toEqual([createdObjectShards[0].url])
      expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, xPrime.url])
      // And later objects never reach X either.
      addObject()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(Object.keys(read(x).objects).sort()).toEqual(['o4', 'o5', 'o6', 'o7'])
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  const retiredDifferences = () => (useEpochHopStore.getState().retired?.differences ?? [])
    .map((d) => [d.kind, d.id, (d.local as any)?.name ?? null, (d.current as any)?.name ?? null])
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))

  it('an unlisted X answered RETIRED AT ONCE — its offline edits are offered in the retired banner (what differs from the current epoch), never lost in silence; the entry leaves the queue after', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = fullRollOf(ws, ['o4', 'o5'])
    // Marie's last session, offline past the retention: o4 edited, o7 created —
    // changes the server never received. o5 is as the current epoch has it.
    x.change((d: any) => {
      d.objects.o4.name = 'Offline edit'
      d.objects.o7 = objectEntity('o7')
    })
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) =>
      documents.map(({ documentId }) => (documentId === x.documentId
        ? { documentId, durable: false, forwarded: false, epochRetired: true }
        : { documentId, durable: serverHolds.has(documentId) })) as any)
    // An export already shown (a hop's): merged, not replaced.
    useEpochHopStore.getState().showRetired({ version: 1, metaUrl: 'automerge:shown', collectedAt: 'then',
      differences: [{ kind: 'group', id: 'g1', local: { name: 'G' }, current: null }] })
    await boot(ws, [x, xPrime])
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    expect(retiredDifferences()).toEqual([
      ['group', 'g1', 'G', null],
      ['object', 'o4', 'Offline edit', 'Container o4'],
      ['object', 'o7', 'Container o7', null],
    ])
    expect(useEpochHopStore.getState().retired?.metaUrl).toBe('automerge:shown')
    // Never shown, never written.
    const { epochHopProbe } = await import('./bridge')
    expect(epochHopProbe().objectShards).not.toContain(x.documentId)
    expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o7')
    expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, xPrime.url])
  })

  it('RETIRED LATE, from the provisional state — what was typed into X meanwhile is in the export (flushed first); nothing differs → no banner', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = fullRollOf(ws, ['o4', 'o5', 'o6'])
    x.change((d: any) => { d.objects.o7 = objectEntity('o7') }) // only X has it
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    let offline = true
    let asking = false
    let answer: () => void = () => undefined
    const answered = new Promise<void>((resolve) => { answer = resolve })
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) => {
      if (offline) throw new TypeError('Failed to fetch')
      if (documents.length === 1 && documents[0]!.documentId === x.documentId) { asking = true; await answered }
      // Every other document is durable: only X could keep the badge saving.
      return documents.map(({ documentId }) => (documentId === x.documentId
        ? { documentId, durable: false, forwarded: false, epochRetired: true }
        : { documentId, durable: true })) as any
    })
    const { epochHopProbe, __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [200] })
    try {
      await boot(ws, [x, xPrime])
      await expect.poll(() => epochHopProbe().provisionalShards, POLL).toEqual([x.url])
      offline = false
      await expect.poll(() => asking, POLL).toBe(true)
      // Typed in X while provisional, the answer arriving before any flush.
      useModelStore.getState().updateObject('o7', { name: 'Typed in X' })
      answer()
      await expect.poll(() => epochHopProbe().objectShards, POLL).not.toContain(x.documentId)
      expect(read(x).objects.o7.name).toBe('Typed in X')
      await expect.poll(retiredDifferences, POLL).toEqual([['object', 'o7', 'Typed in X', null]])
      // RETIRED, X leaves the
      // durability ledger and its pin — the badge settles, and X is no
      // longer asked about every 750 ms.
      await expect.poll(() => useAutomergeStatus.getState().status, POLL).toBe('ready')
      expect(epochHopProbe().durablePending).not.toContain(x.documentId)
      // Its `durability-pending` pin is gone with it: X is shared no more.
      expect(repoModule.activeDocumentShare.isPinned(x.documentId as DocumentId)).toBe(false)
      const asked = () => vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls
        .filter(([documents]) => documents.some((d) => d.documentId === x.documentId)).length
      const before = asked()
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      expect(asked()).toBe(before)
      expect(useAutomergeStatus.getState().status).toBe('ready')
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
    // Nothing that differs (X == X′): nothing to offer.
    const { stopBridge } = await import('./bridge')
    stopBridge()
    useEpochHopStore.getState().reset()
    // The first half's export was persisted: this half is
    // another session that must not find it.
    await (await memoryStore()).del('epoch-retired-export:v1')
    const ws2 = workspace()
    const quiet = fullRollOf(ws2, ['o4'])
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [quiet.reference])
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) =>
      documents.map(({ documentId }) => (documentId === quiet.x.documentId
        ? { documentId, durable: false, forwarded: false, epochRetired: true }
        : { documentId, durable: serverHolds.has(documentId) })) as any)
    await boot(ws2, [quiet.x, quiet.xPrime])
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    expect(useEpochHopStore.getState().retired).toBeNull()
  }, 15_000)

  /** X answered RETIRED at once, with an offline edit (o4) and an object
   * only it has (o7). */
  function retiredAtOnce(ws: Workspace) {
    const rolled = fullRollOf(ws, ['o4', 'o5'])
    rolled.x.change((d: any) => {
      d.objects.o4.name = 'Offline edit'
      d.objects.o7 = objectEntity('o7')
    })
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) =>
      documents.map(({ documentId }) => (documentId === rolled.x.documentId
        ? { documentId, durable: false, forwarded: false, epochRetired: true }
        : { documentId, durable: serverHolds.has(documentId) })) as any)
    return rolled
  }

  it('the retired export SURVIVES a reload — persisted before the entry leaves the queue, the next boot raises the banner with the same lines; "Export" keeps the persisted copy, "×" then lets its lines go (pass 3)', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = retiredAtOnce(ws)
    const store = await memoryStore()
    await store.set(DEFERRED_REFERENCES_KEY, [reference])
    await boot(ws, [x, xPrime])
    await expect.poll(async () => store.get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    const lines = retiredDifferences()
    expect(lines).toEqual([['object', 'o4', 'Offline edit', 'Container o4'], ['object', 'o7', 'Container o7', null]])
    expect(((await store.get('epoch-retired-export:v1')) as any)?.differences).toHaveLength(2)
    // The tab is reloaded before "Export" (or crashes, or the window closes).
    const { stopBridge } = await import('./bridge')
    stopBridge()
    useEpochHopStore.getState().reset()
    expect(useEpochHopStore.getState().retired).toBeNull()
    await store.set('epoch-capability:v1', true)
    await boot(ws, [x, xPrime])
    await expect.poll(retiredDifferences, POLL).toEqual(lines)
    // Exported: the download cannot say it was saved — the
    // persisted copy stays; "×" then lets its lines go.
    useEpochHopStore.getState().markRetiredExported()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(((await store.get('epoch-retired-export:v1')) as any)?.differences).toHaveLength(2)
    expect(retiredDifferences()).toEqual(lines)
    useEpochHopStore.getState().dismissRetired()
    await expect.poll(async () => ((await store.get('epoch-retired-export:v1')) as any)?.differences, POLL).toEqual([])
  })

  it('the export could NOT be persisted — shown for the session, and the entry STAYS queued (the next boot asks again)', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = retiredAtOnce(ws)
    const store = await memoryStore()
    await store.set(DEFERRED_REFERENCES_KEY, [reference])
    const update = store.update.bind(store)
    vi.spyOn(store, 'update').mockImplementation(((key: string, updater: (old: unknown) => unknown) =>
      (key === 'epoch-retired-export:v1' ? Promise.reject(new Error('quota')) : update(key, updater as never))) as never)
    await boot(ws, [x, xPrime])
    await expect.poll(retiredDifferences, POLL).toEqual([['object', 'o4', 'Offline edit', 'Container o4'], ['object', 'o7', 'Container o7', null]])
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await store.get(DEFERRED_REFERENCES_KEY)).toEqual([reference])
  })

  it('an entity ALREADY in the shown export keeps its first line — once, as shown', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = retiredAtOnce(ws)
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    useEpochHopStore.getState().showRetired({ version: 1, metaUrl: 'automerge:shown', collectedAt: 'then',
      differences: [{ kind: 'object', id: 'o4', local: { name: 'Shown first' }, current: null }] })
    await boot(ws, [x, xPrime])
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    expect(retiredDifferences()).toEqual([['object', 'o4', 'Shown first', null], ['object', 'o7', 'Container o7', null]])
  })

  it('a retired unlisted CONNECTION shard offers its connections', async () => {
    const ws = workspace()
    const x = repoModule.repo.create<any>({ connections: { c8: connectionEntity('c8', 'o1', 'o3') } })
    const oldMeta = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url], connectionShardUrls: [ws.connectionShard.url, x.url] })
    ws.modelMeta.change((m: any) => { m.modelEpoch = 1; m.epochPredecessorRef = new ImmutableString(oldMeta.url) })
    const reference = { holderDocumentId: oldMeta.documentId, field: 'connectionShardUrls', url: x.url, unminted: true }
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) =>
      documents.map(({ documentId }) => (documentId === x.documentId
        ? { documentId, durable: false, forwarded: false, epochRetired: true }
        : { documentId, durable: serverHolds.has(documentId) })) as any)
    await boot(ws, [x])
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    expect((useEpochHopStore.getState().retired?.differences ?? []).map((d) => [d.kind, d.id])).toEqual([['connection', 'c8']])
  })

  it('provisional X EDITED, then a LATE "held" — flushed into X first, taken off the screen (what only X held too), X′ never written from X, its listener detached, no delete for its ids; queued until its current heads are durable', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = fullRollOf(ws, ['o4', 'o5', 'o6'])
    // o8: deleted from X′ by someone else in the new epoch — only X has it.
    x.change((d: any) => { d.objects.o8 = objectEntity('o8') })
    const firstHash = A.decodeChange(A.getAllChanges(x.doc()!)[0]!).hash
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    let offline = true
    let caughtUp = false
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) => {
      if (offline) throw new TypeError('Failed to fetch')
      return documents.map(({ documentId, heads }) => (documentId === x.documentId
        // The server's copy of X stops at its first change: HELD, not durable yet.
        ? { documentId, durable: caughtUp || (heads.length === 1 && heads[0] === firstHash) }
        : { documentId, durable: serverHolds.has(documentId) }))
    })
    const release = vi.spyOn(repoModule, 'releaseDocumentRequest')
    const { epochHopProbe, __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [200] })
    try {
      await boot(ws, [x, xPrime])
      await expect.poll(() => epochHopProbe().provisionalShards, POLL).toEqual([x.url])
      expect(useModelStore.getState().objects.map((o) => o.id)).toContain('o8')
      const listenersWhileShown = (x as any).listeners('change').length
      expect(listenersWhileShown).toBeGreaterThan(0)
      // Edited while provisional: o8 (X only), o4 (both copies — the listed wins).
      useModelStore.getState().updateObject('o8', { name: 'Edited, only in X' })
      useModelStore.getState().updateObject('o4', { name: 'Edited o4' })
      offline = false
      await expect.poll(() => epochHopProbe().objectShards, POLL).not.toContain(x.documentId)
      // Flushed into X before the unload (then forwarded by the server).
      expect(read(x).objects.o8.name).toBe('Edited, only in X')
      expect(read(xPrime).objects.o4.name).toBe('Edited o4')
      expect(read(xPrime).objects.o8).toBeUndefined()
      const xPrimeBefore = JSON.stringify(read(xPrime).objects)
      // What only X held left the screen; held is not retired: no export.
      expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o8')
      expect(epochHopProbe().provisionalShards).toEqual([])
      expect(useEpochHopStore.getState().retired).toBeNull()
      // X's listener is detached (not left to re-project every change of
      // X for the session, a hop's latch included) — and a change arriving in
      // X re-projects nothing.
      expect((x as any).listeners('change').length).toBe(listenersWhileShown - 1)
      let projections = 0
      const unsubscribe = useModelStore.subscribe((s, prev) => { if (s.objects !== prev.objects) projections += 1 })
      x.change((d: any) => { d.objects.o9 = objectEntity('o9') })
      await new Promise((resolve) => setTimeout(resolve, 100))
      unsubscribe()
      expect(projections).toBe(0)
      expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o9')
      // A later local write deletes nothing of X's ids, anywhere.
      useModelStore.getState().updateObject('o1', { name: 'After the unload' })
      await expect.poll(() => read(ws.objectShard).objects.o1.name, POLL).toBe('After the unload')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(Object.keys(read(x).objects).sort()).toEqual(['o4', 'o5', 'o6', 'o8', 'o9'])
      expect(JSON.parse(JSON.stringify(read(xPrime).objects))).toEqual({ ...JSON.parse(xPrimeBefore) })
      expect(read(ws.modelMeta).deletedObjectIds ?? []).toEqual([])
      // Queued until X's CURRENT heads are durable; then its lease is given back.
      expect(await (await memoryStore()).get(DEFERRED_REFERENCES_KEY)).toEqual([reference])
      expect(release.mock.calls).not.toContainEqual([x.url, 'model-shard'])
      expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, xPrime.url])
      caughtUp = true
      await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
      await expect.poll(() => release.mock.calls, POLL).toContainEqual([x.url, 'model-shard'])
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('X HELD — the server knows its FIRST change — with local edits past the server copy: never written nor projected, but QUEUED until its current heads are durable; then its lease is given back', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = fullRollOf(ws, ['o4'])
    x.change((d: any) => { d.objects.o4.name = 'Offline edit, after the cut' })
    const firstHash = A.decodeChange(A.getAllChanges(x.doc()!)[0]!).hash
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    let caughtUp = false
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) =>
      documents.map(({ documentId, heads }) => (documentId === x.documentId
        // The server's copy stops at the first change until the sync catches up.
        ? { documentId, durable: caughtUp || (heads.length === 1 && heads[0] === firstHash) }
        : { documentId, durable: serverHolds.has(documentId) })))
    const release = vi.spyOn(repoModule, 'releaseDocumentRequest')
    await boot(ws, [x, xPrime])
    const fullHeads = A.getHeads(x.doc()!)
    // The ledger asks about X's CURRENT heads: not durable yet.
    await expect.poll(() => vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls
      .some(([documents]) => documents.some((d) => d.documentId === x.documentId && d.heads.join() === fullHeads.join())), POLL).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await (await memoryStore()).get(DEFERRED_REFERENCES_KEY)).toEqual([reference])
    expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, xPrime.url])
    const { epochHopProbe } = await import('./bridge')
    expect(epochHopProbe().objectShards).not.toContain(x.documentId)
    expect(release.mock.calls).not.toContainEqual([x.url, 'model-shard'])
    caughtUp = true
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    await expect.poll(() => release.mock.calls, POLL).toContainEqual([x.url, 'model-shard'])
  })

  it('the question is about the entry\'s RECORDED first change', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = fullRollOf(ws, ['o4'])
    const recorded = 'f'.repeat(64)
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [{ ...reference, firstChange: recorded }])
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) =>
      documents.map(({ documentId, heads }) => ({ documentId, durable: documentId === x.documentId ? heads[0] === recorded : serverHolds.has(documentId) })))
    await boot(ws, [x, xPrime])
    await expect.poll(() => vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls
      .some(([documents]) => documents.some((d) => d.documentId === x.documentId && d.heads[0] === recorded)), POLL).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    // HELD (the recorded change is known): never written.
    expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, xPrime.url])
  })

  it.each([
    ['a live superseded document, not durable yet (`forwarded: false`)', { durable: false, forwarded: false }],
    ['a forward pending', { durable: false, forwardPending: true }],
  ])('an epoch answer for the shard — %s — is "held": never re-written', async (_name, answer) => {
    const ws = workspace()
    const { x, xPrime, reference } = fullRollOf(ws, ['o4'])
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) =>
      documents.map(({ documentId }) => (documentId === x.documentId ? { documentId, ...answer } : { documentId, durable: serverHolds.has(documentId) })) as any)
    await boot(ws, [x, xPrime])
    await expect.poll(() => askedAbout(x.documentId), POLL).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, xPrime.url])
  })

  it('an answer with NO line for the shard is no answer — X provisional, nothing written until a line says "unknown"', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = fullRollOf(ws, ['o4'])
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    let lines = false
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) =>
      documents.filter(({ documentId }) => lines || documentId !== x.documentId)
        .map(({ documentId }) => ({ documentId, durable: serverHolds.has(documentId) })))
    const { epochHopProbe, __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [60] })
    try {
      await boot(ws, [x, xPrime])
      await expect.poll(() => epochHopProbe().provisionalShards, POLL).toEqual([x.url])
      expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, xPrime.url])
      lines = true
      await expect.poll(() => readMetaUrls(read(ws.modelMeta), 'objectShardUrls'), POLL).toEqual([ws.objectShard.url, xPrime.url, x.url])
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('the question is off the boot\'s critical path — a server that NEVER answers does not hold the first render; X shows provisionally after the question\'s timeout', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = fullRollOf(ws, ['o4', 'o5', 'o6'])
    x.change((d: any) => { d.objects.o7 = objectEntity('o7') })
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    // The question about X hangs until it is aborted (lie-fi).
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents, options) => {
      if (documents.some(({ documentId }) => documentId === x.documentId)) {
        await new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      }
      return documents.map(({ documentId }) => ({ documentId, durable: serverHolds.has(documentId) }))
    })
    const { epochHopProbe, __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ timeoutMs: 1_500, retryDelaysMs: [60_000] })
    try {
      const started = Date.now()
      await boot(ws, [x, xPrime])
      expect(Date.now() - started).toBeLessThan(1_500)
      expect(useModelStore.getState().objects.map((o) => o.id).sort()).toEqual(['o1', 'o2', 'o3', 'o4', 'o5', 'o6'])
      expect(epochHopProbe().objectShards).not.toContain(x.documentId)
      await expect.poll(() => epochHopProbe().provisionalShards, POLL).toEqual([x.url])
      expect(useModelStore.getState().objects.map((o) => o.id)).toContain('o7')
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('a PUBLISHED entry (the booted meta lists the shard) does not hold the boot either — shown at once, its question in the background', async () => {
    const ws = workspace()
    const x = repoModule.repo.create<any>({ objects: { o4: objectEntity('o4') } })
    ws.modelMeta.change((m: any) => { m.objectShardUrls.push(x.url) })
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [{ holderDocumentId: ws.modelMeta.documentId, field: 'objectShardUrls', url: x.url, unminted: true }])
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents, options) => {
      if (documents.length === 1 && documents[0]!.documentId === x.documentId && documents[0]!.heads.length === 1) {
        await new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      }
      return documents.map(({ documentId }) => ({ documentId, durable: serverHolds.has(documentId) }))
    })
    const { __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ timeoutMs: 1_500, retryDelaysMs: [60_000] })
    try {
      const started = Date.now()
      await boot(ws, [x])
      expect(Date.now() - started).toBeLessThan(1_500)
      expect(useModelStore.getState().objects.map((o) => o.id)).toContain('o4')
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('a REFUSED question (4xx) is not asked again this session; the shard stays provisional, nothing written', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = fullRollOf(ws, ['o4'])
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    const isQuestion = (documents: readonly { documentId: string; heads: readonly string[] }[]) =>
      documents.length === 1 && documents[0]!.documentId === x.documentId
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) => {
      if (isQuestion(documents)) throw new Error('durable-heads API → HTTP 403')
      return documents.map(({ documentId }) => ({ documentId, durable: serverHolds.has(documentId) }))
    })
    const { epochHopProbe, __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [40] })
    try {
      await boot(ws, [x, xPrime])
      await expect.poll(() => epochHopProbe().provisionalShards, POLL).toEqual([x.url])
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls.filter(([documents]) => isQuestion(documents))).toHaveLength(1)
      expect(epochHopProbe().unmintedRetriesPending).toBe(0)
      expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, xPrime.url])
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('an unlisted random-id shard this browser cannot load is counted towards its give-up; one the booted meta lists is not', async () => {
    const ws = workspace()
    const missing = { holderDocumentId: ws.modelMeta.documentId, field: 'objectShardUrls', url: 'automerge:2j9Fq5ZQfRrR1CbGCJm5qUxZHfVh', unminted: true }
    const listedShard = repoModule.repo.create<any>({ objects: { o9: objectEntity('o9') } })
    ws.modelMeta.change((m: any) => { m.objectShardUrls.push(listedShard.url) })
    const listed = { holderDocumentId: ws.modelMeta.documentId, field: 'objectShardUrls', url: listedShard.url, unminted: true }
    const store = await memoryStore()
    await store.set(DEFERRED_REFERENCES_KEY, [missing, listed])
    await boot(ws, [listedShard], undefined, undefined, [listedShard.url])
    await expect.poll(async () => store.get(DEFERRED_REFERENCES_KEY), POLL).toEqual([{ ...missing, resumeFailures: 1 }, listed])
  })

  it('a stop cancels the armed question, and an answer in flight at the stop decides nothing', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = fullRollOf(ws, ['o4'])
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    let hold = true
    let answerLate: (() => void) | null = null
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) => {
      if (documents.some(({ documentId }) => documentId === x.documentId)) {
        if (hold) throw new TypeError('Failed to fetch')
        await new Promise<void>((resolve) => { answerLate = resolve })
      }
      return documents.map(({ documentId }) => ({ documentId, durable: false }))
    })
    const { epochHopProbe, stopBridge, __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [100_000] })
    try {
      await boot(ws, [x, xPrime])
      await expect.poll(() => epochHopProbe().unmintedRetriesPending, POLL).toBe(1)
      stopBridge()
      expect(epochHopProbe().unmintedRetriesPending).toBe(0)

      // A question in flight at the stop: its late "unknown" decides nothing.
      __setUnmintedQuestionTimingForTest({ retryDelaysMs: [100_000] })
      hold = false
      await boot(ws, [x, xPrime])
      await expect.poll(() => answerLate !== null, POLL).toBe(true)
      stopBridge()
      answerLate!()
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(epochHopProbe().objectShards).not.toContain(x.documentId)
      expect(epochHopProbe().durablePending).not.toContain(x.documentId)
      expect(epochHopProbe().unmintedRetriesPending).toBe(0)
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('the defence holds for CONNECTION shards — an unlisted copy is projected under the listed one, and a flush keeps its ids', async () => {
    const ws = workspace()
    const entities = { c4: connectionEntity('c4', 'o1', 'o2') }
    const x = repoModule.repo.create<any>({ connections: structuredClone(entities) })
    x.change((d: any) => {
      d.connections.c4.type = 'dashed' // frozen at the cut
      d.connections.c7 = connectionEntity('c7', 'o2', 'o1') // only X has it
    })
    const oldMeta = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url], connectionShardUrls: [ws.connectionShard.url, x.url] })
    const xPrime = repoModule.repo.create<any>({ connections: structuredClone(entities) })
    ws.modelMeta.change((m: any) => {
      m.modelEpoch = 1
      m.epochPredecessorRef = new ImmutableString(oldMeta.url)
      m.connectionShardUrls.push(xPrime.url)
    })
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [{ holderDocumentId: oldMeta.documentId, field: 'connectionShardUrls', url: x.url, unminted: true }])
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async () => { throw new TypeError('Failed to fetch') })
    const { epochHopProbe, __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [100_000] })
    try {
      await boot(ws, [x, xPrime])
      await expect.poll(() => epochHopProbe().connectionShards, POLL).toContain(x.documentId)
      // The LISTED copy is what the tab shows.
      expect(useModelStore.getState().connections.find((c) => c.id === 'c4')?.type).toBe('solid')
      // Edits in both copies' buckets: c4 lands in the LISTED copy, c7 in X —
      // whose flush keeps c4 (routed to X′), never deletes it.
      useModelStore.getState().updateConnection('c4', { label: 'Edited' } as any)
      useModelStore.getState().updateConnection('c7', { label: 'Edited in X' } as any)
      await expect.poll(() => read(xPrime).connections.c4?.label, POLL).toBe('Edited')
      await expect.poll(() => read(x).connections.c7?.label, POLL).toBe('Edited in X')
      expect(Object.keys(read(x).connections).sort()).toEqual(['c4', 'c7'])
      expect(read(x).connections.c4.type).toBe('dashed')
      expect(Object.keys(read(xPrime).connections)).toEqual(['c4'])
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('a PROVISIONAL connection shard is closed to new ids too — a new connection goes to a new shard, never into X', async () => {
    const ws = workspace()
    // X′ is full (3); X, provisional, has room for one more — it must not take it.
    const x = repoModule.repo.create<any>({ connections: { c4: connectionEntity('c4', 'o1', 'o2'), c7: connectionEntity('c7', 'o2', 'o1') } })
    const oldMeta = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url], connectionShardUrls: [ws.connectionShard.url, x.url] })
    const xPrime = repoModule.repo.create<any>({
      connections: { c4: connectionEntity('c4', 'o1', 'o2'), c5: connectionEntity('c5', 'o1', 'o3'), c6: connectionEntity('c6', 'o3', 'o2') },
    })
    ws.modelMeta.change((m: any) => {
      m.modelEpoch = 1
      m.epochPredecessorRef = new ImmutableString(oldMeta.url)
      m.connectionShardUrls.push(xPrime.url)
    })
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [{ holderDocumentId: oldMeta.documentId, field: 'connectionShardUrls', url: x.url, unminted: true }])
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async () => { throw new TypeError('Failed to fetch') })
    const { epochHopProbe, __setUnmintedQuestionTimingForTest } = await import('./bridge')
    __setUnmintedQuestionTimingForTest({ retryDelaysMs: [100_000] })
    try {
      await boot(ws, [x, xPrime])
      await expect.poll(() => epochHopProbe().provisionalShards, POLL).toEqual([x.url])
      const id = addConnection()
      await expect.poll(() => createdConnectionShards.length, POLL).toBe(1)
      await expect.poll(() => Object.keys(read(createdConnectionShards[0]).connections ?? {}), POLL).toEqual([id])
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(Object.keys(read(x).connections).sort()).toEqual(['c4', 'c7'])
      expect(useModelStore.getState().connections.map((c) => c.id)).toContain(id)
    } finally {
      __setUnmintedQuestionTimingForTest(null)
    }
  })

  it('an UNLISTED shard (a minted pointer still held) deletes an object that lives only there', async () => {
    const ws = workspace()
    await boot(ws)
    const id = addObject()
    await expect.poll(() => createdObjectShards.length, POLL).toBe(1)
    const [created] = createdObjectShards
    await expect.poll(() => Object.keys(read(created).objects ?? {}), POLL).toEqual([id])
    expect(read(ws.modelMeta).objectShardUrls).toEqual([ws.objectShard.url]) // unlisted
    useModelStore.getState().deleteObject(id)
    await expect.poll(() => Object.keys(read(created).objects ?? {}), POLL).toEqual([])
  })

  it('an EPOCH answer for the shard (retired: not durable, but the server knows it) is "held" too — never re-written', async () => {
    const ws = workspace()
    const { x, xPrime, reference } = fullRollOf(ws, ['o4'])
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) =>
      documents.map(({ documentId }) => (documentId === x.documentId
        ? { documentId, durable: false, forwarded: false, epochRetired: true }
        : { documentId, durable: serverHolds.has(documentId) })) as any)
    await boot(ws, [x, xPrime])
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    expect(readMetaUrls(read(ws.modelMeta), 'objectShardUrls')).toEqual([ws.objectShard.url, xPrime.url])
  })

  it('a pointer held on a meta only the NETWORK names does not hold the boot — resumed in the background once the walk reaches it', async () => {
    const ws = workspace()
    const e0 = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url] })
    const e1 = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url], modelEpoch: 1, epochPredecessorRef: new ImmutableString(e0.url) })
    ws.modelMeta.change((m: any) => { m.modelEpoch = 2; m.epochPredecessorRef = new ImmutableString(e1.url) })
    const held = repoModule.repo.create<any>({ objects: { o5: objectEntity('o5') } })
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [{ holderDocumentId: e0.documentId, field: 'objectShardUrls', url: held.url }])
    const realSynced = repoCompatModule.syncedHandle
    vi.spyOn(repoCompatModule, 'syncedHandle').mockImplementation((r: any, id: any) => (id === e1.documentId ? undefined : realSynced(r, id)) as any)
    let releaseE1: () => void = () => undefined
    const e1Arrives = new Promise<void>((resolve) => { releaseE1 = resolve })
    await boot(ws, [held], undefined, async (url) => {
      if (url === e1.url) { await e1Arrives; return e1 }
      return undefined
    })
    // The boot returned while E1 is still on its way: the first render did not wait.
    expect(useModelStore.getState().objects.map((o) => o.id).sort()).toEqual(['o1', 'o2', 'o3'])
    const release = vi.spyOn(repoModule, 'releaseDocumentRequest')
    releaseE1()
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id), POLL).toContain('o5')
    // The lease the walk's load of E1 took is given back.
    expect(release.mock.calls).toContainEqual([e1.url, 'model-shard'])
    serverHolds.add(held.documentId)
    await expect.poll(() => [...read(ws.modelMeta).objectShardUrls], POLL).toEqual([ws.objectShard.url, held.url])
  })

  /** E2 (booted) → E1 (only the network has it) → E0; `held` is a minted
   * shard whose pointer is held on `holders` (E0 and/or E1). */
  async function walkSetup(holders: (e: { e0: DocHandle<any>; e1: DocHandle<any> }) => DocHandle<any>[]) {
    const ws = workspace()
    const e0 = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url] })
    const e1 = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url], modelEpoch: 1, epochPredecessorRef: new ImmutableString(e0.url) })
    ws.modelMeta.change((m: any) => { m.modelEpoch = 2; m.epochPredecessorRef = new ImmutableString(e1.url) })
    const held = repoModule.repo.create<any>({ objects: { o5: objectEntity('o5') } })
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY,
      holders({ e0, e1 }).map((h) => ({ holderDocumentId: h.documentId, field: 'objectShardUrls', url: held.url })))
    const realSynced = repoCompatModule.syncedHandle
    vi.spyOn(repoCompatModule, 'syncedHandle').mockImplementation((r: any, id: any) => (id === e1.documentId ? undefined : realSynced(r, id)) as any)
    let releaseE1: () => void = () => undefined
    const e1Arrives = new Promise<void>((resolve) => { releaseE1 = resolve })
    await boot(ws, [held], undefined, async (url) => {
      if (url === e1.url) { await e1Arrives; return e1 }
      return undefined
    })
    return { ws, held, releaseE1: () => releaseE1() }
  }

  it('an edit typed but not flushed yet when the walk ends survives the adoption (written first, never projected over)', async () => {
    const { ws, releaseE1 } = await walkSetup(({ e0 }) => [e0])
    expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o5')
    useModelStore.getState().updateObject('o1', { name: 'Typed during the walk' })
    releaseE1()
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id), POLL).toContain('o5')
    expect(useModelStore.getState().objects.find((o) => o.id === 'o1')?.name).toBe('Typed during the walk')
    await expect.poll(() => read(ws.objectShard).objects.o1.name, POLL).toBe('Typed during the walk')
  })

  it('a shard two entries name (held on two metas of the lineage) is adopted ONCE', async () => {
    const { held, releaseE1 } = await walkSetup(({ e0, e1 }) => [e0, e1])
    releaseE1()
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id), POLL).toContain('o5')
    const { epochHopProbe } = await import('./bridge')
    expect(epochHopProbe().objectShards.filter((id) => id === held.documentId)).toHaveLength(1)
  })

  it('a walk that could not DECIDE (a link not loaded, or the budget spent) counts nothing against the entry', async () => {
    const ws = workspace()
    const e0 = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url] })
    const e1 = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url], modelEpoch: 1, epochPredecessorRef: new ImmutableString(e0.url) })
    const e2 = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url], modelEpoch: 2, epochPredecessorRef: new ImmutableString(e1.url) })
    ws.modelMeta.change((m: any) => { m.modelEpoch = 3; m.epochPredecessorRef = new ImmutableString(e2.url) })
    const held = repoModule.repo.create<any>({ objects: { o5: objectEntity('o5') } })
    const reference = { holderDocumentId: e0.documentId, field: 'objectShardUrls', url: held.url }
    const store = await memoryStore()
    await store.set(DEFERRED_REFERENCES_KEY, [reference])
    const remote = new Set([e1.documentId, e2.documentId])
    const realSynced = repoCompatModule.syncedHandle
    vi.spyOn(repoCompatModule, 'syncedHandle').mockImplementation((r: any, id: any) => (remote.has(id) ? undefined : realSynced(r, id)) as any)
    const { __setPredecessorWalkBudgetForTest } = await import('./bridge')
    // ONE budget for the whole walk: E2 arrives in 200 ms, E1 would arrive
    // 200 ms later — past what is left of 300 ms.
    __setPredecessorWalkBudgetForTest(300)
    try {
      const slow = (doc: DocHandle<any>) => new Promise<DocHandle<any>>((resolve) => setTimeout(() => resolve(doc), 200))
      await boot(ws, [held], undefined, async (url) => (url === e2.url ? slow(e2) : url === e1.url ? slow(e1) : undefined))
      await new Promise((resolve) => setTimeout(resolve, 900))
      expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o5')
      expect(await store.get(DEFERRED_REFERENCES_KEY)).toEqual([reference]) // not counted
    } finally {
      __setPredecessorWalkBudgetForTest(null)
    }
  })

  /** E2 (booted) → E1 (the network only, `e1Answer` decides how) → E0, the
   * entry held on E0; `retiredOnServer` is what durable-heads says of E1. */
  async function goneSetup() {
    const ws = workspace()
    const e0 = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url] })
    const e1 = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url], modelEpoch: 1, epochPredecessorRef: new ImmutableString(e0.url) })
    ws.modelMeta.change((m: any) => { m.modelEpoch = 2; m.epochPredecessorRef = new ImmutableString(e1.url) })
    const held = repoModule.repo.create<any>({ objects: { o5: objectEntity('o5') } })
    const reference = { holderDocumentId: e0.documentId, field: 'objectShardUrls', url: held.url }
    const store = await memoryStore()
    await store.set(DEFERRED_REFERENCES_KEY, [reference])
    const realSynced = repoCompatModule.syncedHandle
    vi.spyOn(repoCompatModule, 'syncedHandle').mockImplementation((r: any, id: any) => (id === e1.documentId ? undefined : realSynced(r, id)) as any)
    const state = { retiredOnServer: false, offline: false }
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) => {
      if (state.offline) throw new TypeError('Failed to fetch')
      return documents.map(({ documentId }) => (documentId === e1.documentId && state.retiredOnServer
        ? { documentId, durable: false, forwarded: false, epochRetired: true }
        : { documentId, durable: serverHolds.has(documentId) })) as any
    })
    const askedAboutE1 = () => vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls
      .some(([documents]) => documents.some((d) => d.documentId === e1.documentId))
    return { ws, e1, held, reference, store, state, askedAboutE1 }
  }

  it('a predecessor meta "temporarily unavailable" while the server is CONNECTED decides nothing — uncounted, and resumed at the next boot once it loads', async () => {
    const { ws, e1, held, reference, store, askedAboutE1 } = await goneSetup()
    const { DocumentTemporarilyUnavailableError } = await import('./documentResolution')
    vi.spyOn(repoModule.repo, 'peers', 'get').mockReturnValue(['sync-server'] as any)
    const slowServer = async (url: string) => { if (url === e1.url) throw new DocumentTemporarilyUnavailableError(url, 3); return undefined }
    for (let bootNo = 0; bootNo < 3; bootNo += 1) {
      vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockClear()
      await boot(ws, [held], undefined, slowServer)
      // The server was ASKED about E1 — it is not retired there: not gone.
      await expect.poll(askedAboutE1, POLL).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(await store.get(DEFERRED_REFERENCES_KEY)).toEqual([reference]) // never counted
      expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o5')
      const { stopBridge } = await import('./bridge')
      stopBridge()
    }
    // The fourth boot: E1 loads — the entry is resumed, its shard adopted.
    await boot(ws, [held], undefined, async (url) => (url === e1.url ? e1 : undefined))
    await expect.poll(() => useModelStore.getState().objects.map((o) => o.id), POLL).toContain('o5')
  })

  it('GONE only on an AUTHORITATIVE answer — the server says E1 `epochRetired`, or the repo says permanently unavailable — then the walk is decided and the entry counted; offline, nothing is', async () => {
    const { ws, e1, held, reference, store, state, askedAboutE1 } = await goneSetup()
    const { DocumentTemporarilyUnavailableError, DocumentPermanentlyUnavailableError } = await import('./documentResolution')
    const { stopBridge } = await import('./bridge')
    const temporarily = async (url: string) => { if (url === e1.url) throw new DocumentTemporarilyUnavailableError(url, 3); return undefined }
    // Offline (the question fails too): undecided, uncounted.
    state.offline = true
    await boot(ws, [held], undefined, temporarily)
    await expect.poll(() => vi.mocked(repoModule.findModelMetaHandle).mock.calls.some(([url]) => url === e1.url), POLL).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await store.get(DEFERRED_REFERENCES_KEY)).toEqual([reference])
    stopBridge()
    // The server answers E1 RETIRED: decided — counted once.
    state.offline = false
    state.retiredOnServer = true
    await boot(ws, [held], undefined, temporarily)
    await expect.poll(async () => store.get(DEFERRED_REFERENCES_KEY), POLL).toEqual([{ ...reference, resumeFailures: 1 }])
    expect(askedAboutE1()).toBe(true)
    expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o5')
    stopBridge()
    // Permanently unavailable (deleted): decided without asking.
    state.retiredOnServer = false
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockClear()
    await boot(ws, [held], undefined, async (url) => { if (url === e1.url) throw new DocumentPermanentlyUnavailableError(url); return undefined })
    await expect.poll(async () => store.get(DEFERRED_REFERENCES_KEY), POLL).toEqual([{ ...reference, resumeFailures: 2 }])
    expect(askedAboutE1()).toBe(false)
  })

  it('a predecessor the server stays SILENT about — the load never settles — is still asked about within the budget: retired there, the walk decides', async () => {
    const { ws, e1, held, reference, store, state, askedAboutE1 } = await goneSetup()
    const { __setPredecessorWalkBudgetForTest } = await import('./bridge')
    __setPredecessorWalkBudgetForTest(1_500)
    try {
      state.retiredOnServer = true
      await boot(ws, [held], undefined, async (url) => (url === e1.url ? new Promise<never>(() => undefined) : undefined))
      await expect.poll(async () => store.get(DEFERRED_REFERENCES_KEY), POLL).toEqual([{ ...reference, resumeFailures: 1 }])
      expect(askedAboutE1()).toBe(true)
    } finally {
      __setPredecessorWalkBudgetForTest(null)
    }
  })

  it('an entry no walk ever decides, the server reachable and naming no predecessor live, is given up after 10 boots — not walked for ever; offline boots never count', async () => {
    const { ws, e1, held, reference, store, state } = await goneSetup()
    const { __setPredecessorWalkBudgetForTest, stopBridge } = await import('./bridge')
    // The server answers every round, but never about E1 (no line for it).
    vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mockImplementation(async (documents) => {
      if (state.offline) throw new TypeError('Failed to fetch')
      return documents.filter(({ documentId }) => documentId !== e1.documentId)
        .map(({ documentId }) => ({ documentId, durable: true })) as any
    })
    const silent = async (url: string) => (url === e1.url ? new Promise<never>(() => undefined) : undefined)
    __setPredecessorWalkBudgetForTest(150)
    try {
      // Offline boots: never counted.
      state.offline = true
      for (let i = 0; i < 2; i += 1) {
        await boot(ws, [held], undefined, silent)
        await new Promise((resolve) => setTimeout(resolve, 400))
        stopBridge()
      }
      expect(await store.get('epoch-undecided-walks:v1')).toBeUndefined()
      state.offline = false
      for (let i = 1; i < 10; i += 1) {
        await boot(ws, [held], undefined, silent)
        await expect.poll(async () => ((await store.get('epoch-undecided-walks:v1')) as any)?.[held.url], POLL).toBe(i)
        stopBridge()
      }
      expect(await store.get(DEFERRED_REFERENCES_KEY)).toEqual([reference])
      await boot(ws, [held], undefined, silent)
      await expect.poll(async () => store.get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    } finally {
      __setPredecessorWalkBudgetForTest(null)
    }
  }, 30_000)

  it('the bound counts CONSECUTIVE undecided boots — a decided walk clears the count, the next undecided one starts again at 1', async () => {
    const store = await memoryStore()
    const { __noteUndecidedWalksForTest } = await import('./bridge')
    const reference = { holderDocumentId: 'h', field: 'objectShardUrls', url: 'automerge:2sUL5RrMpgjkhvhrvfwuBrUueMmL', unminted: true } as any
    await __noteUndecidedWalksForTest([reference], false)
    await __noteUndecidedWalksForTest([reference], false)
    expect(((await store.get('epoch-undecided-walks:v1')) as any)?.[reference.url]).toBe(2)
    await __noteUndecidedWalksForTest([reference], true)
    expect(((await store.get('epoch-undecided-walks:v1')) as any)?.[reference.url]).toBeUndefined()
    await __noteUndecidedWalksForTest([reference], false)
    expect(((await store.get('epoch-undecided-walks:v1')) as any)?.[reference.url]).toBe(1)
  })

  it('the PERSISTED lineage is walked without a load — E1, which the network cannot give, is not needed', async () => {
    const ws = workspace()
    const e0 = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url] })
    const e1 = repoModule.repo.create<any>({ objectShardUrls: [ws.objectShard.url], modelEpoch: 1, epochPredecessorRef: new ImmutableString(e0.url) })
    ws.modelMeta.change((m: any) => { m.modelEpoch = 2; m.epochPredecessorRef = new ImmutableString(e1.url) })
    const { stopBridge, epochHopProbe } = await import('./bridge')
    await boot(ws)
    const lineageKey = epochHopProbe().lineageKey
    stopBridge()
    const store = await memoryStore()
    await store.set(lineageKey, { [ws.modelMeta.documentId]: e1.documentId, [e1.documentId]: e0.documentId })
    const held = repoModule.repo.create<any>({ objects: { o5: objectEntity('o5') } })
    await store.set(DEFERRED_REFERENCES_KEY, [{ holderDocumentId: e0.documentId, field: 'objectShardUrls', url: held.url }])
    const realSynced = repoCompatModule.syncedHandle
    vi.spyOn(repoCompatModule, 'syncedHandle').mockImplementation((r: any, id: any) => (id === e1.documentId ? undefined : realSynced(r, id)) as any)
    await boot(ws, [held], undefined, async (url) => {
      if (url === e1.url) throw new Error('E1 cannot be resolved')
      return undefined
    })
    // Resumed AT the boot (the local walk reached E0 through the stored link).
    expect(useModelStore.getState().objects.map((o) => o.id)).toContain('o5')
    expect(vi.mocked(repoModule.findModelMetaHandle).mock.calls.map(([url]) => url)).not.toContain(e1.url)
  })

  it('an entry recorded in ANOTHER concrete workspace (a fork sharing the alias queue) is never published here, nor COUNTED towards its give-up; one of this workspace is', async () => {
    vi.spyOn(workspaceBindingModule, 'documentsWorkspaceFor').mockReturnValue({ landscapeId: 'default', versionId: 'fork-v2' })
    const ws = workspace()
    const mine = repoModule.repo.create<any>({ objects: { o4: objectEntity('o4') } })
    const theirs = repoModule.repo.create<any>({ objects: { o7: objectEntity('o7') } })
    const store = await memoryStore()
    const foreign = { holderDocumentId: ws.modelMeta.documentId, field: 'objectShardUrls', url: theirs.url, workspace: 'default/source-v1' }
    await store.set(DEFERRED_REFERENCES_KEY, [
      foreign,
      { holderDocumentId: ws.modelMeta.documentId, field: 'objectShardUrls', url: mine.url, workspace: 'default/fork-v2' },
    ])
    await boot(ws, [mine, theirs])
    expect(useModelStore.getState().objects.map((o) => o.id)).toContain('o4')
    expect(useModelStore.getState().objects.map((o) => o.id)).not.toContain('o7')
    serverHolds.add(mine.documentId)
    serverHolds.add(theirs.documentId)
    await expect.poll(() => [...read(ws.modelMeta).objectShardUrls], POLL).toEqual([ws.objectShard.url, mine.url])
    // Not this workspace's to give up: three boots of the fork would
    // otherwise drop the source's pointer (lost when the alias points back).
    await expect.poll(async () => store.get(DEFERRED_REFERENCES_KEY), POLL).toEqual([foreign])
  })

  it('a new held pointer records the CONCRETE workspace it was created in', async () => {
    vi.spyOn(workspaceBindingModule, 'documentsWorkspaceFor').mockReturnValue({ landscapeId: 'default', versionId: 'fork-v2' })
    const ws = workspace()
    await boot(ws)
    addObject()
    await expect.poll(() => createdObjectShards.length, POLL).toBe(1)
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([
      { holderDocumentId: ws.modelMeta.documentId, field: 'objectShardUrls', url: createdObjectShards[0].url, workspace: 'default/fork-v2' },
    ])
  })
})
