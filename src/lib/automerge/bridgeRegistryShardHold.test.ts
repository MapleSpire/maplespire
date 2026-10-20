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
 * A REGISTRY shard created by this browser (overflow, or a summary
 * workspace's write head) is not pointed at by the root until the server has
 * acknowledged it — when its id is minted. A root naming a shard the server
 * never received breaks every other client's registry boot and makes the GC
 * census incomplete (server/src/gc.ts).
 *
 * Driven through the REAL bridge (bridgeModelShardOverflow.test.ts's pattern):
 * store action → flushWrite → findOrCreateShardForNew / findOrCreateSummaryWriteShard
 * → publishNewRegistryShard → durability round → root. The server is the
 * spied `acknowledgeDurableDocumentHeads`: it answers `durable` only for
 * documents the test has put in `serverHolds`.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocHandle, DocumentId } from '@automerge/automerge-repo'
import * as repoModule from './repo'
import * as durableSyncModule from './durableSync'
import { DEFAULT_WORKSPACE_REF } from './workspace'
import { DEFERRED_REFERENCES_KEY } from './deferredReferences'
import { OVERLAY_WRITE_HEAD_VERSION } from './overlayWriteHead'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import type { KvStore } from '../modelQuery/kvStore'
import type { ModelMeta, RegistryShard, RootDoc } from './types'

// One diagram fills a registry shard, so the second overflows. Read at import
// by shardSizes.ts, which every test below reaches dynamically, after this line.
vi.stubEnv('VITE_SHARD_SIZE', '1')

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

const mocks = vi.hoisted(() => ({
  fetchDiagramListPage: vi.fn(),
  fetchDiagramMeta: vi.fn(),
  fetchDiagramRender: vi.fn(),
}))
vi.mock('../modelQuery/diagrams', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modelQuery/diagrams')>(),
  fetchDiagramListPage: mocks.fetchDiagramListPage,
}))
vi.mock('../modelQuery/diagramMeta', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modelQuery/diagramMeta')>(),
  fetchDiagramMeta: mocks.fetchDiagramMeta,
}))
vi.mock('../modelQuery/diagramRender', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modelQuery/diagramRender')>(),
  fetchDiagramRender: mocks.fetchDiagramRender,
}))

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

function diagramMeta(id: string, docUrl: string) {
  return { id, name: `Diagram ${id}`, type: 'container', docUrl, objectIds: ['o1'], connectionIds: [], groupIds: [] }
}

/** A sharded classic workspace whose ONE registry shard is full (SHARD_SIZE=1). */
function workspace() {
  const repo = repoModule.repo
  const d1 = repo.create<any>({
    name: 'Diagram d1', type: 'container', objectIds: ['o1'], connectionIds: [], groupIds: [],
    layouts: {}, comments: {}, flows: {}, checkpoints: [],
  })
  const shard = repo.create<any>({ diagrams: { d1: diagramMeta('d1', d1.url) } })
  const objectShard = repo.create<any>({ objects: { o1: objectEntity('o1') } })
  const connectionShard = repo.create<any>({ connections: {} })
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
let createdRegistryShards: DocHandle<any>[]
let minted: boolean
/** Registry shards a "previous session" of this browser created. */
let heldInBrowser: DocHandle<any>[]
let heldFindDelayMs: number
let heldFindsInFlight: number
let heldFindsMaxInFlight: number

async function boot(ws: Workspace, heldModelShards: DocHandle<any>[] = []): Promise<void> {
  wire(ws, heldModelShards)
  const { startBridge } = await import('./bridge')
  await startBridge(DEFAULT_WORKSPACE_REF)
  // Guard against a void run: a sharded RESIDENT boot with d1 projected.
  expect(useAutomergeStatus.getState().status, String(useAutomergeStatus.getState().error)).not.toBe('error')
  expect(useModelStore.getState().currentDiagramId).toBe('d1')
}

function wire(ws: Workspace, heldModelShards: DocHandle<any>[] = []): void {
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(ws.root as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([ws.shard] as any)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(ws.modelMeta as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockImplementation(async (urls: readonly string[]) =>
    urls.map((url) => {
      const handle = [ws.objectShard, ws.connectionShard].find((h) => h.url === url)
      if (!handle) throw new Error(`unexpected model shard url ${url}`)
      return handle
    }) as any)
  vi.spyOn(repoModule, 'findHeldModelShardHandle').mockImplementation(async (url: string) => {
    const handle = heldModelShards.find((h) => h.url === url)
    if (!handle) throw new Error(`held model shard ${url} is not in this browser`)
    return handle as any
  })
  vi.spyOn(repoModule, 'findDiagramHandle').mockImplementation(async (url: string) => {
    if (url === ws.d1.url) return ws.d1 as any
    return repoModule.repo.find<any>(url as any) as any
  })
  vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
  vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
}

function addDiagram(): string {
  return useModelStore.getState().addDiagram({
    name: 'Overflow', type: 'container', objectIds: [], connectionIds: [], groupIds: [],
  } as any)
}

const POLL = { timeout: 5_000, interval: 20 }

/** True once an acknowledgement round has sent this document to the server. */
function askedAbout(documentId: string): boolean {
  return vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls
    .some(([documents]) => documents.some((d) => d.documentId === documentId))
}

function storeDiagramIds(): string[] {
  return useModelStore.getState().diagrams.map((d) => d.id).sort()
}

describe('a new registry shard is pointed at by the root only after the server holds it', () => {
  beforeEach(async () => {
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    ;((await import('../modelQuery/kvStore')) as any).__resetMemoryStore()
    useModelStore.setState({
      objects: [], connections: [], groups: [], domains: [], tags: [], diagrams: [],
      comments: [], flows: [], decisionRecords: [], currentDiagramId: null,
      pendingDeletedObjectIds: [], pendingDeletedConnectionIds: [],
      pendingDeletedGroupIds: [], pendingDeletedDiagramIds: [], deletedDiagramIds: [],
    } as any)
    useAutomergeStatus.setState({
      status: 'connecting', ready: false, visualReady: false, editReady: false,
      projectedWorkspace: null, error: null, bootFallbackActive: false,
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    serverHolds = new Set()
    createdRegistryShards = []
    heldInBrowser = []
    heldFindDelayMs = 0
    heldFindsInFlight = 0
    heldFindsMaxInFlight = 0
    minted = true
    const createRegistryShard = repoModule.createRegistryShardHandle
    vi.spyOn(repoModule, 'createRegistryShardHandle').mockImplementation((initial) => {
      const handle = createRegistryShard(initial)
      createdRegistryShards.push(handle)
      return handle
    })
    vi.spyOn(repoModule, 'findHeldRegistryShardHandle').mockImplementation(async (url: string) => {
      heldFindsInFlight += 1
      heldFindsMaxInFlight = Math.max(heldFindsMaxInFlight, heldFindsInFlight)
      try {
        if (heldFindDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, heldFindDelayMs))
        const handle = heldInBrowser.find((h) => h.url === url)
        if (!handle) throw new Error(`held registry shard ${url} is not in this browser`)
        return handle as any
      } finally {
        heldFindsInFlight -= 1
      }
    })
    // The repo names these test shards with random ids; the spy decides which
    // count as minted (the real format check is pinned in repoMintedIdFormat.test.ts).
    vi.spyOn(repoModule, 'isMintedDocumentId').mockImplementation(
      (id: DocumentId) => minted && createdRegistryShards.some((h) => h.documentId === id),
    )
    vi.spyOn(durableSyncModule, 'acknowledgeDurableDocumentHeads').mockImplementation(async (documents) =>
      documents.map(({ documentId }) => ({ documentId, durable: serverHolds.has(documentId) })))
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
  })

  it('a MINTED overflow shard is used at once, held out of the root, and published when the server acknowledges it', async () => {
    const ws = workspace()
    await boot(ws)
    const id = addDiagram()

    await expect.poll(() => createdRegistryShards.length, POLL).toBe(1)
    const [created] = createdRegistryShards
    await expect.poll(() => Object.keys(read(created).diagrams ?? {}), POLL).toEqual([id])
    // Held: the root does not point at a shard the server does not have …
    expect(read(ws.root).shardUrls).toEqual([ws.shard.url])
    // … the pointer is owed, persisted, with no write-head flag on a classic overflow …
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([
      { holderDocumentId: ws.root.documentId, field: 'shardUrls', url: created.url },
    ])
    // … and the author still sees the diagram.
    expect(storeDiagramIds()).toEqual(['d1', id].sort())
    // A round has ASKED about the shard and been answered "not durable": the
    // pointer must survive that answer.
    await expect.poll(() => askedAbout(created.documentId), POLL).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(read(ws.root).shardUrls).toEqual([ws.shard.url])

    serverHolds.add(created.documentId)

    await expect.poll(() => [...read(ws.root).shardUrls], POLL).toEqual([ws.shard.url, created.url])
    expect(read(ws.root).registryWriteUrl).toBeUndefined()
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
  })

  it('a RANDOM-id shard is published after the local flush, as before (the server can only claim it through the pointer)', async () => {
    minted = false
    const ws = workspace()
    await boot(ws)
    addDiagram()

    await expect.poll(() => createdRegistryShards.length, POLL).toBe(1)
    await expect.poll(() => [...read(ws.root).shardUrls], POLL).toEqual([ws.shard.url, createdRegistryShards[0].url])
    expect(serverHolds.size).toBe(0)
    expect(await (await memoryStore()).get(DEFERRED_REFERENCES_KEY)).toBeUndefined()
  })

  it('after a reload, a held registry shard is loaded from the queue (the author sees its diagram) and published once acknowledged', async () => {
    const ws = workspace()
    const d2 = repoModule.repo.create<any>({
      name: 'Diagram d2', type: 'container', objectIds: [], connectionIds: [], groupIds: [],
      layouts: {}, comments: {}, flows: {}, checkpoints: [],
    })
    const held = repoModule.repo.create<any>({ diagrams: { d2: diagramMeta('d2', d2.url) } })
    heldInBrowser.push(held)
    const reference = { holderDocumentId: ws.root.documentId, field: 'shardUrls', url: held.url }
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])

    await boot(ws)

    expect(storeDiagramIds()).toEqual(['d1', 'd2'])
    expect(read(ws.root).shardUrls).toEqual([ws.shard.url])
    // Re-entered in the durability ledger, so the round asks about it again.
    await expect.poll(() => askedAbout(held.documentId), POLL).toBe(true)
    // The flush routes an edit to d2 into the HELD shard, not a fresh one.
    useModelStore.getState().updateDiagram('d2', { name: 'Renamed d2' })
    await expect.poll(() => read(held).diagrams.d2.name, POLL).toBe('Renamed d2')
    expect(createdRegistryShards).toEqual([])

    serverHolds.add(held.documentId)

    await expect.poll(() => [...read(ws.root).shardUrls], POLL).toEqual([ws.shard.url, held.url])
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
  })

  it('a held WRITE-HEAD entry publishes both root fields in one write', async () => {
    const ws = workspace()
    const held = repoModule.repo.create<any>({ diagrams: {} })
    heldInBrowser.push(held)
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [
      { holderDocumentId: ws.root.documentId, field: 'shardUrls', url: held.url, writeHead: true },
    ])
    await boot(ws)
    expect(read(ws.root).registryWriteUrl).toBeUndefined()

    serverHolds.add(held.documentId)

    await expect.poll(() => read(ws.root).registryWriteUrl, POLL).toBe(held.url)
    expect([...read(ws.root).shardUrls]).toEqual([ws.shard.url, held.url])
  })

  it('a registry entry and a model entry share the queue; neither resume counts a failure against the other', async () => {
    // The queue is one per workspace. A model resume that took every entry
    // would see the root's id as "not this ModelMeta" and give the registry
    // pointer up; the registry resume must likewise leave model entries alone.
    // Both entries are HELD (unpublished, loadable), so a failure counted by
    // the wrong resume stays visible as `resumeFailures` on the entry.
    const ws = workspace()
    const held = repoModule.repo.create<any>({ diagrams: {} })
    heldInBrowser.push(held)
    const heldObjects = repoModule.repo.create<any>({ objects: { o9: objectEntity('o9') } })

    const registryRef = { holderDocumentId: ws.root.documentId, field: 'shardUrls', url: held.url }
    const modelRef = { holderDocumentId: ws.modelMeta.documentId, field: 'objectShardUrls', url: heldObjects.url }
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [registryRef, modelRef])

    await boot(ws, [heldObjects])

    expect(useModelStore.getState().objects.map((o) => o.id).sort()).toEqual(['o1', 'o9'])
    await expect.poll(() => askedAbout(held.documentId) && askedAbout(heldObjects.documentId), POLL).toBe(true)
    expect(await (await memoryStore()).get(DEFERRED_REFERENCES_KEY)).toEqual([registryRef, modelRef])
  })

  it('a held registry shard this browser cannot load is retried on later boots and given up at the third', async () => {
    const ws = workspace()
    const reference = { holderDocumentId: ws.root.documentId, field: 'shardUrls', url: 'automerge:2j9Fq5ZQfRrR1CbGCJm5qUxZHfVh' }
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
    expect(read(ws.root).shardUrls).toEqual([ws.shard.url])
  })

  it('held shards are resolved concurrently, so the resume costs the boot one bound, not one per entry', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await store.set(DEFERRED_REFERENCES_KEY, [
      { holderDocumentId: ws.root.documentId, field: 'shardUrls', url: 'automerge:2j9Fq5ZQfRrR1CbGCJm5qUxZHfVh' },
      { holderDocumentId: ws.root.documentId, field: 'shardUrls', url: 'automerge:3Kx7Ux1tYxqf1hcLgCUuBUdmXjWi' },
      { holderDocumentId: ws.root.documentId, field: 'shardUrls', url: 'automerge:4LsZgbsPPgQ4fdr7NSs1aczR4Lxq' },
    ])
    heldFindDelayMs = 100

    await boot(ws)

    expect(vi.mocked(repoModule.findHeldRegistryShardHandle)).toHaveBeenCalledTimes(3)
    expect(heldFindsMaxInFlight).toBe(3)
  })

  it('when the held pointer cannot be queued, it is written after the local flush rather than lost with the session', async () => {
    const ws = workspace()
    const store = await memoryStore()
    await boot(ws)
    vi.spyOn(store, 'update').mockRejectedValue(new Error('IndexedDB is gone'))
    addDiagram()

    await expect.poll(() => createdRegistryShards.length, POLL).toBe(1)
    await expect.poll(() => [...read(ws.root).shardUrls], POLL)
      .toEqual([ws.shard.url, createdRegistryShards[0].url])
    expect(serverHolds.size).toBe(0) // written although the server never acknowledged it
  })

  it('a session that ends while a held shard is being found neither tracks nor holds it', async () => {
    // The find can take seconds; a workspace switch in between bumps the
    // epoch. Without the epoch read at resume ENTRY, the late find would put
    // this workspace's shard in the next session's ledger and hold.
    const ws = workspace()
    const held = repoModule.repo.create<any>({ diagrams: {} })
    heldInBrowser.push(held)
    const reference = { holderDocumentId: ws.root.documentId, field: 'shardUrls', url: held.url }
    const store = await memoryStore()
    await store.set(DEFERRED_REFERENCES_KEY, [reference])
    heldFindDelayMs = 300
    wire(ws)
    const { startBridge, stopBridge } = await import('./bridge')
    const booting = startBridge(DEFAULT_WORKSPACE_REF).catch(() => undefined)
    await expect.poll(() => heldFindsInFlight, POLL).toBe(1)
    stopBridge()
    serverHolds.add(held.documentId)
    await booting
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    expect(askedAbout(held.documentId)).toBe(false)
    expect(read(ws.root).shardUrls).toEqual([ws.shard.url])
    // Still owed, for that workspace's next boot.
    expect(await store.get(DEFERRED_REFERENCES_KEY)).toEqual([reference])
  })

  it('an entry held for ANOTHER root is given up, never written into this root', async () => {
    const ws = workspace()
    const held = repoModule.repo.create<any>({ diagrams: {} })
    heldInBrowser.push(held)
    serverHolds.add(held.documentId)
    const reference = { holderDocumentId: 'a-root-this-workspace-replaced', field: 'shardUrls', url: held.url }
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [reference])

    await boot(ws)

    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL)
      .toEqual([{ ...reference, resumeFailures: 1 }])
    expect(vi.mocked(repoModule.findHeldRegistryShardHandle)).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(read(ws.root).shardUrls).toEqual([ws.shard.url])
  })

  it("a pointer acknowledged in one session is never written into the NEXT session's root", async () => {
    // The ack lands while the queue add is still pending; the session ends,
    // another workspace boots, then the add completes and the hold resumes.
    const wsA = workspace()
    const store = await memoryStore()
    await boot(wsA)
    let releaseAdd!: () => void
    const gate = new Promise<void>((resolve) => { releaseAdd = resolve })
    const update = store.update.bind(store)
    vi.spyOn(store, 'update').mockImplementation(async (key: string, fn: any) => {
      if (key === DEFERRED_REFERENCES_KEY) await gate
      return update(key, fn)
    })
    addDiagram()
    await expect.poll(() => createdRegistryShards.length, POLL).toBe(1)
    const [created] = createdRegistryShards
    const before = vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls.length
    serverHolds.add(created.documentId)
    await expect.poll(() => vi.mocked(durableSyncModule.acknowledgeDurableDocumentHeads).mock.calls.slice(before)
      .some(([documents]) => documents.some((d) => d.documentId === created.documentId)), POLL).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    ;(await import('./bridge')).stopBridge()
    const wsB = workspace()
    await boot(wsB)
    releaseAdd()
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(read(wsB.root).shardUrls).toEqual([wsB.shard.url])
  })

  it('when the queue add fails, the fallback pointer still waits for the LOCAL flush', async () => {
    const durableReferencesModule = await import('./durableReferences')
    const ws = workspace()
    const store = await memoryStore()
    await boot(ws)
    let flushed!: () => void
    vi.spyOn(durableReferencesModule, 'publishAfterDurableFlush').mockImplementation(async (_repo: any, publish: any) => {
      await new Promise<void>((resolve) => { flushed = resolve })
      publish()
    })
    vi.spyOn(store, 'update').mockRejectedValue(new Error('IndexedDB is gone'))
    addDiagram()

    await expect.poll(() => typeof flushed, POLL).toBe('function')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(read(ws.root).shardUrls).toEqual([ws.shard.url])
    flushed()
    await expect.poll(() => [...read(ws.root).shardUrls], POLL).toEqual([ws.shard.url, createdRegistryShards[0].url])
  })

  it('a url the root gains twice (two tabs published one held shard) is loaded ONCE, live', async () => {
    const ws = workspace()
    await boot(ws)
    const d2 = repoModule.repo.create<any>({
      name: 'Diagram d2', type: 'container', objectIds: [], connectionIds: [], groupIds: [],
      layouts: {}, comments: {}, flows: {}, checkpoints: [],
    })
    const other = repoModule.repo.create<any>({ diagrams: { d2: diagramMeta('d2', d2.url) } })

    ws.root.change((root: any) => {
      root.shardUrls.push(other.url)
      root.shardUrls.push(other.url)
    })

    await expect.poll(() => storeDiagramIds(), POLL).toContain('d2')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(useModelStore.getState().diagrams.map((d) => d.id).sort()).toEqual(['d1', 'd2'])
  })

  it('a queued pointer the root already carries is dropped at boot, not published twice', async () => {
    const ws = workspace()
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [
      { holderDocumentId: ws.root.documentId, field: 'shardUrls', url: ws.shard.url },
    ])

    await boot(ws)

    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([])
    expect(read(ws.root).shardUrls).toEqual([ws.shard.url])
    expect(vi.mocked(repoModule.findHeldRegistryShardHandle)).not.toHaveBeenCalled()
  })
})

// ── summary workspace: the write head ────────────────────────────────────────

/** A summary-only workspace with NO write head yet: the first creation
 *  provisions one (findOrCreateSummaryWriteShard). */
function summaryWorkspace() {
  const repo = repoModule.repo
  const objectBase = repo.create<Record<string, unknown>>({ objects: {} })
  const connectionBase = repo.create<Record<string, unknown>>({ connections: {} })
  const objectHead = repo.create<Record<string, unknown>>({ objects: {}, writeHeadVersion: 1 })
  const connectionHead = repo.create<Record<string, unknown>>({ connections: {}, writeHeadVersion: 1 })
  const meta = repo.create<ModelMeta>({
    objectShardUrls: [objectBase.url],
    connectionShardUrls: [connectionBase.url],
    editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
    editsObjectShardUrl: objectHead.url,
    editsConnectionShardUrl: connectionHead.url,
    editsObjectShardUrls: [objectHead.url],
    editsConnectionShardUrls: [connectionHead.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    deletedObjectIds: [], deletedConnectionIds: [],
  } as unknown as ModelMeta)
  const registryBase = repo.create<RegistryShard>({ diagrams: {} } as RegistryShard)
  const root = repo.create<RootDoc>({
    modelUrl: '',
    modelMetaUrl: meta.url,
    shardUrls: [registryBase.url],
    registrySummaryOnly: true,
  } as unknown as RootDoc)
  return { root, meta, registryBase }
}

describe('a summary workspace\'s new write head is published only after the server holds it', () => {
  beforeEach(async () => {
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    ;((await import('../modelQuery/kvStore')) as any).__resetMemoryStore()
    localStorage.clear()
    mocks.fetchDiagramRender.mockRejectedValue(new Error('offline in this suite'))
    mocks.fetchDiagramListPage.mockResolvedValue({ items: [], nextCursor: null, total: 0 })
    mocks.fetchDiagramMeta.mockResolvedValue(null)
    useModelStore.setState({
      objects: [], connections: [], groups: [], domains: [], tags: [],
      diagrams: [], comments: [], flows: [], decisionRecords: [],
      currentDiagramId: null, selectedItems: [], workspaceReadOnly: false,
      pendingDeletedObjectIds: [], pendingDeletedConnectionIds: [],
      pendingDeletedGroupIds: [], pendingDeletedDiagramIds: [], deletedDiagramIds: [],
    } as any)
    useAutomergeStatus.setState({
      status: 'connecting', ready: false, visualReady: false, editReady: false,
      projectedWorkspace: null, error: null, bootFallbackActive: false,
      workspaceContractStale: false,
    } as any)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
    serverHolds = new Set()
    createdRegistryShards = []
    const createRegistryShard = repoModule.createRegistryShardHandle
    vi.spyOn(repoModule, 'createRegistryShardHandle').mockImplementation((initial) => {
      const handle = createRegistryShard(initial)
      createdRegistryShards.push(handle)
      return handle
    })
    vi.spyOn(repoModule, 'isMintedDocumentId').mockImplementation(
      (id: DocumentId) => createdRegistryShards.some((h) => h.documentId === id),
    )
    vi.spyOn(durableSyncModule, 'acknowledgeDurableDocumentHeads').mockImplementation(async (documents) =>
      documents.map(({ documentId }) => ({ documentId, durable: serverHolds.has(documentId) })))
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('after a reload, new diagrams go into the HELD write head, not a second one', async () => {
    const ws = summaryWorkspace()
    const head = repoModule.repo.create<RegistryShard>({ diagrams: {} } as RegistryShard)
    await (await memoryStore()).set(DEFERRED_REFERENCES_KEY, [
      { holderDocumentId: ws.root.documentId, field: 'shardUrls', url: head.url, writeHead: true },
    ])
    vi.spyOn(repoModule, 'findHeldRegistryShardHandle').mockImplementation(async (url: string) => {
      if (url !== head.url) throw new Error('not in this browser')
      return head as any
    })
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(ws.root as any)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(ws.meta as any)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([] as any)
    vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    const id = addDiagram()

    await expect.poll(() => Object.keys(read(head).diagrams ?? {}), POLL).toEqual([id])
    expect(createdRegistryShards).toEqual([])
  })

  it('holds shardUrls AND registryWriteUrl until the acknowledgement, then writes both', async () => {
    const ws = summaryWorkspace()
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(ws.root as any)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(ws.meta as any)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([] as any)
    vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
    const { startBridge, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(isRegistrySummaryOnlyActive()).toBe(true)

    const id = addDiagram()

    await expect.poll(() => createdRegistryShards.length, POLL).toBe(1)
    const [head] = createdRegistryShards
    await expect.poll(() => Object.keys(read(head).diagrams ?? {}), POLL).toEqual([id])
    await expect.poll(async () => (await memoryStore()).get(DEFERRED_REFERENCES_KEY), POLL).toEqual([
      { holderDocumentId: ws.root.documentId, field: 'shardUrls', url: head.url, writeHead: true },
    ])
    await expect.poll(() => askedAbout(head.documentId), POLL).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(read(ws.root).registryWriteUrl).toBeUndefined()
    expect([...read(ws.root).shardUrls]).toEqual([ws.registryBase.url])

    serverHolds.add(head.documentId)

    await expect.poll(() => read(ws.root).registryWriteUrl, POLL).toBe(head.url)
    expect([...read(ws.root).shardUrls]).toEqual([ws.registryBase.url, head.url])
  })
})
