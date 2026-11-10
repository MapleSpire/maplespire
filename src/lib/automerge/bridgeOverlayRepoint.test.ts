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
 * The CLIENT half of server-side writer-head rotation
 * (`server/src/readModel/ordinaryHeadRotator.ts`): the server repoints
 * `ModelMeta.editsObjectShardUrl` at a fresh head while a tab is editing an
 * ORDINARY workspace in boot-from-server mode (the mode that writes through
 * the overlay heads). The tab must follow the pointer — its next edit lands in
 * the NEW head, the old head is left as it was — without a reload.
 *
 * Driven through the REAL bridge with REAL Automerge handles on the module
 * repo (the `bridgeAbsentContainer.test.ts` pattern), and read back from the
 * DOCUMENTS, never the store.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { repo } from './repo'
import { OVERLAY_WRITE_HEAD_VERSION } from './overlayWriteHead'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import type { ModelMeta, RegistryShard, RootDoc } from './types'

const kv = new Map<string, unknown>()
vi.mock('../modelQuery/kvStore', () => ({
  workspaceKvStore: () => ({
    get: async (key: string) => kv.get(key),
    set: async (key: string, value: unknown) => { kv.set(key, value) },
    del: async (key: string) => { kv.delete(key) },
    update: async (key: string, fn: (value: unknown) => unknown) => {
      kv.set(key, fn(kv.get(key)))
    },
  }),
}))

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

const CLASSIC = 'dg-classic'
const BFS_FLAG = 'maplespire:bootFromServer'
const REF = { landscapeId: 'overlay-repoint', versionId: 'current' }

function diagramMeta(id: string, name: string, docUrl = '') {
  return { id, name, type: 'container', docUrl, objectIds: [], connectionIds: [], groupIds: [] }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The write scheduler's `normal` trailing edge is 150 ms of REAL time. */
async function settleWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await settle()
}

async function until(ok: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!ok() && Date.now() - start < ms) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

type Head = { objects: Record<string, any>; writeBatchIds: string[] }

/** An ORDINARY sharded workspace with usable overlay write heads. */
function ordinaryFixture() {
  const objectShard = repo.create<Record<string, unknown>>({ objects: {} })
  const connectionShard = repo.create<Record<string, unknown>>({ connections: {} })
  const diagramDoc = repo.create<Record<string, unknown>>({
    name: 'Classic', type: 'container', objectIds: [], connectionIds: [], groupIds: [],
    layouts: {}, checkpoints: [], comments: {}, flows: {},
  })
  const objectHead = repo.create<Head>({ objects: {}, writeBatchIds: [] })
  const connectionHead = repo.create<Record<string, unknown>>({ connections: {}, writeBatchIds: [] })
  const meta = repo.create<ModelMeta>({
    objectShardUrls: [objectShard.url, objectHead.url],
    connectionShardUrls: [connectionShard.url, connectionHead.url],
    editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
    editsObjectShardUrl: objectHead.url,
    editsConnectionShardUrl: connectionHead.url,
    editsObjectShardUrls: [objectHead.url],
    editsConnectionShardUrls: [connectionHead.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    deletedObjectIds: [], deletedConnectionIds: [],
  } as unknown as ModelMeta)
  const registry = repo.create<RegistryShard>({
    diagrams: { [CLASSIC]: diagramMeta(CLASSIC, 'Classic', diagramDoc.url) },
  } as unknown as RegistryShard)
  const root = repo.create<RootDoc>({
    modelUrl: '',
    modelMetaUrl: meta.url,
    shardUrls: [registry.url],
  } as unknown as RootDoc)
  const known = new Map<string, unknown>([
    [objectShard.url, objectShard], [connectionShard.url, connectionShard],
    [objectHead.url, objectHead], [connectionHead.url, connectionHead],
  ])
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root as any)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([registry] as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockImplementation(async (urls: readonly string[]) =>
    urls.map((url) => {
      const handle = known.get(url)
      if (!handle) throw new Error(`unexpected model shard url ${url}`)
      return handle
    }) as any)
  return { meta, objectHead, known }
}

describe('a server-side write-head rotation, seen by an editing tab', () => {
  beforeEach(async () => {
    kv.clear()
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    const { __resetIndexReady } = await import('../modelQuery/offlineIndex')
    __resetIndexReady()
    localStorage.clear()
    vi.clearAllMocks()
    mocks.fetchDiagramRender.mockRejectedValue(new Error('offline in this suite'))
    mocks.fetchDiagramListPage.mockResolvedValue({ items: [], nextCursor: null, total: 0 })
    useModelStore.setState({
      objects: [], connections: [], groups: [], domains: [], tags: [],
      diagrams: [], comments: [], flows: [], decisionRecords: [],
      currentDiagramId: null, selectedItems: [], workspaceReadOnly: false,
      pendingDeletedObjectIds: [], pendingDeletedConnectionIds: [],
      pendingDeletedGroupIds: [], pendingDeletedDiagramIds: [],
      deletedDiagramIds: [],
    })
    useAutomergeStatus.setState({
      status: 'connecting', ready: false, visualReady: false, editReady: false,
      projectedWorkspace: null, error: null, bootFallbackActive: false,
      workspaceContractStale: false,
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
    localStorage.clear()
    kv.clear()
  })

  it('the next edit after the repoint lands in the NEW head, and the retired head is not written again', async () => {
    const { meta, objectHead, known } = ordinaryFixture()
    localStorage.setItem(BFS_FLAG, 'true')
    const bridge = await import('./bridge')
    await bridge.startBridge(REF)
    // Anti-void guard: the mode that writes through the overlay heads.
    expect(bridge.isBootFromServerActive()).toBe(true)
    const size = { width: 200, height: 100 }

    const before = useModelStore.getState().addObject({
      type: 'system', name: 'Billing', position: { x: 0, y: 0 }, size,
    } as any)
    await settleWrites()
    // Premise: an edit lands in the CURRENT head.
    expect(objectHead.doc()!.objects[before]).toMatchObject({ id: before, name: 'Billing' })
    const retiredState = JSON.stringify(objectHead.doc()!)

    // THE SERVER ROTATES: a fresh durable head, then ONE ModelMeta change —
    // the shape `publishOverlaySegment` writes.
    const fresh = repo.create<Head>({ objects: {}, writeBatchIds: [] })
    known.set(fresh.url, fresh)
    meta.change((m: any) => {
      m.editsObjectShardUrls.push(fresh.url)
      m.editsObjectShardUrl = fresh.url
      m.objectShardUrls.push(fresh.url)
    })
    await settle()

    const after = useModelStore.getState().addObject({
      type: 'system', name: 'Ledger', position: { x: 300, y: 0 }, size,
    } as any)
    await settleWrites()
    await until(() => Boolean(fresh.doc()?.objects?.[after]))

    // Followed, without a reload: the edit is in the new head with its own
    // batch id…
    expect(fresh.doc()!.objects[after]).toMatchObject({ id: after, name: 'Ledger' })
    expect([...fresh.doc()!.writeBatchIds]).toHaveLength(1)
    // …and the retired head is exactly as it was: not written, not re-copied.
    expect(JSON.stringify(objectHead.doc()!)).toBe(retiredState)
    expect(fresh.doc()!.objects[before]).toBeUndefined()
  })

  it('an edit made while the tab is still RELEASING the retired head never lands in it', async () => {
    // Ported from the phase-3 QA lens (mutant BR1, `staleHeads` forced false
    // in `writeEditsShards`). The test above settles BEFORE the next edit, so
    // `ensureOverlayHandles` has already swapped the handle and `staleHeads`
    // is never consulted. Here the swap is held inside its `repo.flush()`
    // while the next edit's write fires.
    const { meta, objectHead, known } = ordinaryFixture()
    localStorage.setItem(BFS_FLAG, 'true')
    const bridge = await import('./bridge')
    await bridge.startBridge(REF)
    expect(bridge.isBootFromServerActive()).toBe(true)
    const size = { width: 200, height: 100 }
    const before = useModelStore.getState().addObject({
      type: 'system', name: 'Billing', position: { x: 0, y: 0 }, size,
    } as any)
    await settleWrites()
    expect(objectHead.doc()!.objects[before]).toMatchObject({ id: before, name: 'Billing' })
    const retiredState = JSON.stringify(objectHead.doc()!)

    // Hold the release's whole-repo flush: the tab stays between "the pointer
    // moved" and "the handle is swapped" for as long as this is unresolved.
    const realFlush = repo.flush.bind(repo)
    let releaseFlush!: () => void
    const gate = new Promise<void>((resolve) => { releaseFlush = resolve })
    let heldFlushes = 0
    vi.spyOn(repo, 'flush').mockImplementation(async (ids?: any) => {
      if (ids === undefined) {
        heldFlushes += 1
        await gate
      }
      return realFlush(ids)
    })

    const fresh = repo.create<Head>({ objects: {}, writeBatchIds: [] })
    known.set(fresh.url, fresh)
    meta.change((m: any) => {
      m.editsObjectShardUrls.push(fresh.url)
      m.editsObjectShardUrl = fresh.url
      m.objectShardUrls.push(fresh.url)
    })
    const after = useModelStore.getState().addObject({
      type: 'system', name: 'Ledger', position: { x: 300, y: 0 }, size,
    } as any)
    // The write scheduler fires (150 ms) while the release is held.
    await settleWrites()
    expect(heldFlushes, 'witness: the release reached its flush and is held there').toBeGreaterThan(0)
    expect(JSON.stringify(objectHead.doc()!), 'the edit landed in the RETIRED head').toBe(retiredState)

    releaseFlush()
    await until(() => Boolean(fresh.doc()?.objects?.[after]))
    expect(fresh.doc()!.objects[after]).toMatchObject({ id: after, name: 'Ledger' })
    expect(JSON.stringify(objectHead.doc()!)).toBe(retiredState)
  })
})
