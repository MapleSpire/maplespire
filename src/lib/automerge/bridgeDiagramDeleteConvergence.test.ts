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
 * T-DIAGDEF (1) and (2) — a deleted diagram that does not LEAVE.
 *
 * (1) SUMMARY workspace, a diagram created in this session then deleted from
 *     its card. The removal is durable at once (`writeSummaryLocalRegistry`
 *     deletes the write-head entry; the server row goes in ~300 ms), but the
 *     Diagrams page is served by the SERVER and hides a card only behind the
 *     store's `deletedDiagramIds` — which never carried the id: a session-
 *     created diagram gets no ModelMeta tombstone (by design), and the bridge
 *     dropped the id from its tombstone set without publishing anything in its
 *     place. The card stayed until a reload (measured by hand: > 90 s).
 *
 * (2) ORDINARY workspace booted from the server (`bfsActive`, no summary
 *     contract), deleting the diagram that is OPEN. The delete changes
 *     `currentDiagramId`, the next diagram's first paint re-projects the store
 *     from the registry shards (`buildDiagramsArray`) BEFORE the debounced
 *     flush removed the entry — so the deleted diagram came back into the
 *     store, and the flush then reconciled the registry FROM that store: the
 *     entry was kept, durably. The read model (a full registry sync) was
 *     right to keep the row: the registry still listed it. Manual test: the row never
 *     left `ro_diagrams`, the card came back after a reload and a restart.
 *
 * Both drive the REAL bridge with REAL Automerge handles
 * (`bridgeSummaryDelete.test.ts`'s pattern).
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { repo } from './repo'
import { DEFAULT_WORKSPACE_REF } from './workspace'
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
    update: async (key: string, fn: (value: unknown) => unknown) => { kv.set(key, fn(kv.get(key))) },
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

const storeDiagram = (id: string, name: string) => ({
  id, name, type: 'container', objectIds: [], connectionIds: [], groupIds: [], layouts: {},
}) as any

function fixture(options: { summaryOnly: boolean }) {
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
  const writeHead = repo.create<RegistryShard>({ diagrams: {} } as RegistryShard)
  const registryBase = repo.create<RegistryShard>({ diagrams: {} } as RegistryShard)
  const root = repo.create<RootDoc>({
    modelUrl: '',
    modelMetaUrl: meta.url,
    shardUrls: [registryBase.url],
    registryWriteUrl: writeHead.url,
    ...(options.summaryOnly ? { registrySummaryOnly: true } : {}),
  } as unknown as RootDoc)
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root as any)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta as any)
  // An ordinary workspace boots with its registry RESIDENT (the shards the
  // root lists); a summary one never loads it.
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue((options.summaryOnly ? [] : [registryBase]) as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
  return { root, meta, writeHead, registryBase }
}

describe('T-DIAGDEF — a deleted diagram leaves the client', () => {
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
    mocks.fetchDiagramMeta.mockResolvedValue(undefined)
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

  it('(1) summary: a session-created diagram, once removed from the write head, is published as deleted', async () => {
    const MINE = 'dg-made-then-deleted'
    const f = fixture({ summaryOnly: true })
    const { startBridge, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(isRegistrySummaryOnlyActive()).toBe(true)

    useModelStore.setState({ diagrams: [...useModelStore.getState().diagrams, storeDiagram(MINE, 'Made here')] })
    await settleWrites()
    // Anti-void: it really is in the write head, i.e. session-local.
    expect(Object.keys(f.writeHead.doc()?.diagrams ?? {})).toContain(MINE)

    useModelStore.getState().deleteDiagram(MINE)
    await settleWrites()

    // The removal is durable (the write head) and carries no ModelMeta
    // tombstone — both by design, unchanged…
    expect(Object.keys(f.writeHead.doc()?.diagrams ?? {})).not.toContain(MINE)
    expect(f.meta.doc()?.deletedDiagramIds ?? []).not.toContain(MINE)
    // …and the server-paged list's ONE removal signal now carries it.
    expect(useModelStore.getState().deletedDiagramIds).toContain(MINE)

    // A later flush does not withdraw it (nor write a tombstone).
    useModelStore.setState({ objects: [{ id: 'obj-z', name: 'Later', type: 'system', description: '', tags: [] } as any] })
    await settleWrites()
    expect(useModelStore.getState().deletedDiagramIds).toContain(MINE)
    expect(f.meta.doc()?.deletedDiagramIds ?? []).not.toContain(MINE)
  })

  it('(1b) summary: the same id CREATED again (undo) is no longer published as deleted', async () => {
    const MINE = 'dg-undone'
    const f = fixture({ summaryOnly: true })
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    useModelStore.setState({ diagrams: [...useModelStore.getState().diagrams, storeDiagram(MINE, 'Undone')] })
    await settleWrites()
    useModelStore.getState().deleteDiagram(MINE)
    await settleWrites()

    useModelStore.setState({ diagrams: [...useModelStore.getState().diagrams, storeDiagram(MINE, 'Undone')] })
    await settleWrites()

    expect(Object.keys(f.writeHead.doc()?.diagrams ?? {})).toContain(MINE)
    expect(useModelStore.getState().deletedDiagramIds).not.toContain(MINE)
  })

  it('(2) ordinary bfs: deleting the OPEN diagram removes it from the registry shard, and it stays out of the store', async () => {
    localStorage.setItem('maplespire:bootFromServer', 'true')
    const f = fixture({ summaryOnly: false })
    f.registryBase.change((shard: any) => {
      for (const id of ['dg-open', 'dg-other']) {
        shard.diagrams[id] = { id, name: id, type: 'container', docUrl: '', objectIds: [], connectionIds: [], groupIds: [] }
      }
    })
    const { startBridge, isRegistrySummaryOnlyActive, isBootFromServerActive } = await import('./bridge')
    await startBridge({ landscapeId: 'ordinary-bfs', versionId: 'current' })
    expect(isBootFromServerActive()).toBe(true)
    expect(isRegistrySummaryOnlyActive()).toBe(false)
    useModelStore.getState().setCurrentDiagram('dg-open')
    await settleWrites()
    // Anti-void: the registry lists both, the store holds both, dg-open is open.
    expect(Object.keys(f.registryBase.doc()?.diagrams ?? {}).sort()).toEqual(['dg-open', 'dg-other'])
    expect(useModelStore.getState().diagrams.map((d) => d.id).sort()).toEqual(['dg-open', 'dg-other'])
    expect(useModelStore.getState().currentDiagramId).toBe('dg-open')

    useModelStore.getState().deleteDiagram('dg-open')
    await settleWrites()
    await settleWrites()

    expect(useModelStore.getState().currentDiagramId).not.toBe('dg-open')
    expect(useModelStore.getState().diagrams.map((d) => d.id)).toEqual(['dg-other'])
    expect(Object.keys(f.registryBase.doc()?.diagrams ?? {})).toEqual(['dg-other'])
    // An ordinary workspace still writes no tombstone.
    expect(f.meta.doc()?.deletedDiagramIds ?? []).toEqual([])
  })

  it('(2b) ordinary bfs: an UNDO of that delete brings the diagram back, registry included', async () => {
    localStorage.setItem('maplespire:bootFromServer', 'true')
    const f = fixture({ summaryOnly: false })
    f.registryBase.change((shard: any) => {
      for (const id of ['dg-open', 'dg-other']) {
        shard.diagrams[id] = { id, name: id, type: 'container', docUrl: '', objectIds: [], connectionIds: [], groupIds: [] }
      }
    })
    const { startBridge } = await import('./bridge')
    await startBridge({ landscapeId: 'ordinary-bfs', versionId: 'current' })
    useModelStore.getState().setCurrentDiagram('dg-open')
    await settleWrites()
    useModelStore.getState().deleteDiagram('dg-open')
    await settleWrites()
    await settleWrites()

    useModelStore.setState({ diagrams: [...useModelStore.getState().diagrams, storeDiagram('dg-open', 'dg-open')] })
    await settleWrites()
    await settleWrites()

    expect(useModelStore.getState().diagrams.map((d) => d.id).sort()).toEqual(['dg-open', 'dg-other'])
    expect(Object.keys(f.registryBase.doc()?.diagrams ?? {}).sort()).toEqual(['dg-open', 'dg-other'])
  })

  it('(2c) ordinary bfs: a shard UNRESOLVED at the flush keeps the deletion held, so its return cannot resurrect it', async () => {
    localStorage.setItem('maplespire:bootFromServer', 'true')
    const f = fixture({ summaryOnly: false })
    const meta = (id: string) => ({ id, name: id, type: 'container', docUrl: '', objectIds: [], connectionIds: [], groupIds: [] })
    f.registryBase.change((shard: any) => {
      shard.diagrams['dg-other'] = meta('dg-other')
      shard.diagrams['dg-third'] = meta('dg-third')
    })
    // The shard holding the open diagram, whose document can go unresolved
    // (`doc()` undefined: evicted, not yet loaded) — the state in which a
    // registry is INCOMPLETE and absence proves nothing.
    const real = repo.create<RegistryShard>({ diagrams: { 'dg-open': meta('dg-open') } } as unknown as RegistryShard)
    let loaded = true
    const realDoc = real.doc.bind(real)
    real.doc = (() => (loaded ? realDoc() : undefined)) as typeof real.doc
    f.root.change((root: any) => { root.shardUrls.push(real.url) })
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([f.registryBase, real] as any)
    const { startBridge, isRegistrySummaryOnlyActive, isBootFromServerActive } = await import('./bridge')
    await startBridge({ landscapeId: 'ordinary-bfs', versionId: 'current' })
    expect(isBootFromServerActive()).toBe(true)
    expect(isRegistrySummaryOnlyActive()).toBe(false)
    useModelStore.getState().setCurrentDiagram('dg-open')
    await settleWrites()
    expect(useModelStore.getState().diagrams.map((d) => d.id).sort()).toEqual(['dg-open', 'dg-other', 'dg-third'])

    useModelStore.getState().deleteDiagram('dg-open')
    loaded = false // the flush cannot write that shard, nor see it
    await settleWrites()
    await settleWrites()
    // Nothing could express the delete: the registry still lists it.
    expect(Object.keys(realDoc()?.diagrams ?? {})).toContain('dg-open')

    // The shard comes back; a projection lands (opening another diagram).
    loaded = true
    useModelStore.getState().setCurrentDiagram('dg-third')
    await settleWrites()
    expect(useModelStore.getState().diagrams.map((d) => d.id)).not.toContain('dg-open')

    // …and the next flush expresses the delete where it lives.
    useModelStore.setState({ objects: [{ id: 'obj-z', name: 'Later', type: 'system', description: '', tags: [] } as any] })
    await settleWrites()
    await settleWrites()
    expect(Object.keys(realDoc()?.diagrams ?? {})).not.toContain('dg-open')
    expect(useModelStore.getState().diagrams.map((d) => d.id)).not.toContain('dg-open')
  })
})
