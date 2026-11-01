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
 * QA lens, 2026-10-31: the cases bridgeRepointCarry.test.ts does not reach —
 * each one kills mutants that survive that file (see the QA report). Same
 * fixture: the REAL bridge under boot-from-server, two or three sessions on
 * one Repo and one persisted namespace.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getHeads } from '@automerge/automerge'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomergeUrl, DocumentId, PeerId } from '@automerge/automerge-repo'
import * as repoModule from './repo'
import { repo } from './repo'
import * as durableSync from './durableSync'
import * as switchModule from './switchWorkspace'
import { pendingEntityIntents } from './entityIntents'
import { OVERLAY_WRITE_HEAD_VERSION } from './overlayWriteHead'
import type { ModelMeta, RegistryShard, RootDoc } from './types'
import { setActiveWorkspaceRef, workspaceRefKey, type WorkspaceRef } from './workspace'
import {
  __resetResolvedWorkspacesForTest,
  __resetWorkspaceBindingFramesForTest,
  holdWorkspaceOn,
  noteWorkspaceBinding,
  rememberResolvedWorkspace,
} from './workspaceBinding'
import { createMemoryKvStore, workspaceKvStore, __setWorkspaceKvBaseForTest } from '../modelQuery/kvStore'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'

vi.mock('../api/http', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/http')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch') }),
}))
const reads = vi.hoisted(() => ({
  fetchDiagramListPage: vi.fn(),
  fetchDiagramMeta: vi.fn(),
  fetchDiagramRender: vi.fn(),
}))
vi.mock('../modelQuery/diagrams', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modelQuery/diagrams')>(),
  fetchDiagramListPage: reads.fetchDiagramListPage,
}))
vi.mock('../modelQuery/diagramMeta', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modelQuery/diagramMeta')>(),
  fetchDiagramMeta: reads.fetchDiagramMeta,
}))
vi.mock('../modelQuery/diagramRender', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modelQuery/diagramRender')>(),
  fetchDiagramRender: reads.fetchDiagramRender,
}))

const REF: WorkspaceRef = { landscapeId: 'default', versionId: 'current' }
const KEY = workspaceRefKey(REF)
const LEDGER_KEY = 'pending-durable-heads:v1'
const peer = 'server-peer' as PeerId

function versionGraph() {
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
  const shard = repo.create<RegistryShard>({ diagrams: {} } as RegistryShard)
  const root = repo.create<RootDoc>({
    modelUrl: '',
    modelMetaUrl: meta.url,
    shardUrls: [shard.url],
  } as unknown as RootDoc)
  return { root, meta, shard, objectHead }
}
type Graph = ReturnType<typeof versionGraph>

const read = (handle: { doc(): unknown }) => handle.doc() as any

async function boot(graph: Graph, versionId: string, rootDelayMs = 0) {
  vi.spyOn(repoModule, 'getRootHandle').mockImplementation(async () => {
    if (rootDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, rootDelayMs))
    rememberResolvedWorkspace(REF, { landscapeId: 'default', versionId }, { from: 'root-fetch', rootUrl: graph.root.url })
    return graph.root as any
  })
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(graph.meta as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([graph.shard] as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
  const { startBridge, isBootFromServerActive } = await import('./bridge')
  await startBridge(REF)
  expect(isBootFromServerActive()).toBe(true)
}

async function settleWrites(): Promise<void> {
  for (const ms of [300, 0, 0, 100, 0, 0]) await new Promise((resolve) => setTimeout(resolve, ms))
}

function resetStores() {
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
    projectedWorkspace: null, error: null, bootFallbackActive: false, workspaceRepointNotice: null,
  })
}

function addDiagram(name: string): string {
  return useModelStore.getState().addDiagram({
    name, type: 'context', objectIds: [], connectionIds: [], groupIds: [], layouts: {},
  } as any)
}

const intentOf = (kind: string, id: string) =>
  pendingEntityIntents.serialize(KEY).find((intent) => intent.kind === kind && intent.id === id)

async function stop(): Promise<void> {
  const { stopBridge } = await import('./bridge')
  stopBridge()
  await settleWrites()
  resetStores()
}

describe('repoint carry — the cases the first battery could not reach (QA lens)', () => {
  beforeEach(async () => {
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    localStorage.clear()
    localStorage.setItem('maplespire:bootFromServer', 'true')
    __setWorkspaceKvBaseForTest(createMemoryKvStore())
    setActiveWorkspaceRef(REF)
    reads.fetchDiagramRender.mockRejectedValue(new TypeError('Failed to fetch'))
    reads.fetchDiagramListPage.mockResolvedValue({ items: [], nextCursor: null, total: 0 })
    reads.fetchDiagramMeta.mockResolvedValue(undefined)
    resetStores()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    // Another session beginning clears any withhold (a fresh page load).
    repoModule.activeDocumentShare.beginSession('qa: next test')
    repoModule.activeDocumentShare.endSession()
    holdWorkspaceOn(null)
    __resetWorkspaceBindingFramesForTest()
    __resetResolvedWorkspacesForTest()
    __setWorkspaceKvBaseForTest(null)
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('an UNTAGGED or null-tagged ledger entry is this session\'s own: activated, pinned, answered', async () => {
    // Persisted before the tag existed, or by a session that could not name
    // its workspace: neither says "elsewhere".
    const v1 = versionGraph()
    const legacy = repo.create<{ value: string }>({ value: 'persisted before the tag' })
    const unnamed = repo.create<{ value: string }>({ value: 'marked by an unnamed session' })
    await workspaceKvStore().set(LEDGER_KEY, [
      { documentId: legacy.documentId, heads: [...getHeads(legacy.doc() as never)] },
      { documentId: unnamed.documentId, heads: [...getHeads(unnamed.doc() as never)], workspace: null },
    ])
    const find = vi.spyOn(repo, 'find')
    await boot(v1, 'V1')
    const { __bridgeDurableHeadDocumentIdsForTest } = await import('./bridge')
    expect(__bridgeDurableHeadDocumentIdsForTest()).toEqual(expect.arrayContaining([legacy.documentId, unnamed.documentId]))
    await expect(repoModule.activeDocumentShare.shareConfig.access(peer, legacy.documentId as DocumentId)).resolves.toBe(true)
    await expect(repoModule.activeDocumentShare.shareConfig.access(peer, unnamed.documentId as DocumentId)).resolves.toBe(true)
    expect(repoModule.activeDocumentShare.isPinned(legacy.documentId)).toBe(true)
    // Re-presented: the Repo is asked for it (after a reload nothing else loads it).
    expect(find).toHaveBeenCalledWith(legacy.url as AutomergeUrl)
  })

  it('a SENT creation is released by a POSITIVE server answer for its carriers, never by a negative one', async () => {
    const server = { holds: false }
    const ask = vi.spyOn(durableSync, 'acknowledgeDurableDocumentHeads').mockImplementation(async (documents) =>
      documents.map(({ documentId }) => ({ documentId, durable: server.holds })))
    const v1 = versionGraph()
    await boot(v1, 'V1')
    const diagramId = addDiagram('Sent')
    await settleWrites()
    await vi.waitFor(() => expect(intentOf('diagram', diagramId)?.sent?.workspace).toBe('default/V1'), { timeout: 5_000 })
    const calls = ask.mock.calls.length
    await vi.waitFor(() => expect(ask.mock.calls.length).toBeGreaterThan(calls + 3), { timeout: 8_000 })
    expect(intentOf('diagram', diagramId)?.sent, 'released on a negative answer').toBeDefined()
    server.holds = true
    await vi.waitFor(() => expect(intentOf('diagram', diagramId), 'never released on a positive answer').toBeUndefined(), { timeout: 8_000 })
  })

  it('a binding frame naming a new default withholds the unconfirmed documents synchronously, before the handshake', async () => {
    const v1 = versionGraph()
    await boot(v1, 'V1')
    addDiagram('Unsynced when the default moved')
    await settleWrites()
    const { __bridgeDurableHeadDocumentIdsForTest } = await import('./bridge')
    await vi.waitFor(() => expect(__bridgeDurableHeadDocumentIdsForTest()).toContain(v1.shard.documentId), { timeout: 5_000 })
    expect(repoModule.activeDocumentShare.isWithheld(v1.shard.documentId), 'void-run guard').toBe(false)
    const reload = vi.spyOn(switchModule, 'reloadWorkspace').mockResolvedValue(undefined as never)
    noteWorkspaceBinding({ landscapeId: 'default', versionId: 'V2' }, {})
    // No await between the frame and this read: the handshake follows the frame.
    expect(repoModule.activeDocumentShare.isWithheld(v1.shard.documentId), 'the old version\'s shard stayed on the socket').toBe(true)
    await vi.waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('an OBJECT created offline in V1 is carried into V2\'s overlay', async () => {
    const v1 = versionGraph()
    await boot(v1, 'V1')
    const objectId = useModelStore.getState().addObject({
      type: 'system', name: 'Made offline', position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
    } as any)
    await settleWrites()
    await vi.waitFor(() => expect(read(v1.objectHead).objects[objectId]).toBeTruthy(), { timeout: 5_000 })
    await vi.waitFor(() => expect(intentOf('object', objectId)?.sent?.workspace).toBe('default/V1'), { timeout: 5_000 })
    await stop()

    const v2 = versionGraph()
    await boot(v2, 'V2')
    await settleWrites()
    await vi.waitFor(() => expect(read(v2.objectHead).objects[objectId]?.name).toBe('Made offline'), { timeout: 10_000 })
  })

  it('a creation the replay finds SATISFIED in V1\'s local shard goes SENT, so a later repoint still carries it', async () => {
    // Session 1 wrote the meta into V1's shard, and the journal still holds
    // the creation PENDING — what a crash between the shard write and its
    // mark leaves (constructed: the mark is replaced by a newer pending copy).
    const v1 = versionGraph()
    await boot(v1, 'V1')
    const diagramId = addDiagram('Satisfied locally')
    await settleWrites()
    await vi.waitFor(() => expect(intentOf('diagram', diagramId)?.sent?.workspace).toBe('default/V1'), { timeout: 5_000 })
    await stop()
    const { sent: _sent, ...unmarked } = intentOf('diagram', diagramId)!
    pendingEntityIntents.hydrate(KEY, [{ ...unmarked, recordedAt: unmarked.recordedAt + 1 } as any])
    expect(read(v1.shard).diagrams[diagramId], 'void-run guard: the meta is in V1\'s shard').toBeTruthy()
    expect(intentOf('diagram', diagramId), 'void-run guard: pending again').toBeDefined()
    expect(intentOf('diagram', diagramId)?.sent).toBeUndefined()

    // Session 2 reopens V1 (a reload, offline): the replay finds the meta there.
    await boot(v1, 'V1')
    await settleWrites()
    await vi.waitFor(() => expect(intentOf('diagram', diagramId)?.sent?.workspace, 'the satisfied creation was forgotten on a local fact').toBe('default/V1'), { timeout: 5_000 })
    await stop()

    // The default moved: V2 gets it.
    const v2 = versionGraph()
    await boot(v2, 'V2')
    await settleWrites()
    await vi.waitFor(() => expect(read(v2.shard).diagrams[diagramId]?.docUrl).toBeTruthy(), { timeout: 10_000 })
  })

  it('the carry happens when the journal hydrates BEFORE the root resolves (the partition is the last one in)', async () => {
    const v1 = versionGraph()
    await boot(v1, 'V1')
    const diagramId = addDiagram('Carried, root slow')
    await settleWrites()
    await vi.waitFor(() => expect(intentOf('diagram', diagramId)?.sent?.workspace).toBe('default/V1'), { timeout: 5_000 })
    await stop()

    const v2 = versionGraph()
    await boot(v2, 'V2', 300)
    await settleWrites()
    await vi.waitFor(() => expect(read(v2.shard).diagrams[diagramId]?.docUrl).toBeTruthy(), { timeout: 10_000 })
  })
})
