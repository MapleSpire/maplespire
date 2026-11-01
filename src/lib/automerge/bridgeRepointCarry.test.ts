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
 * Unsynced work on a `current` tab FOLLOWS the default version when it moves
 * (the product decision of 2026-10-31), through the REAL bridge under
 * boot-from-server — the mode whose capture journals a creation — with two
 * sessions on one Repo and one persisted namespace:
 *
 *  1. booted on V1, the tab creates a diagram while the server is unreachable:
 *     the meta lands in V1's (local) registry shard, the DiagramDoc in the Repo,
 *     both in the durable-heads ledger, nothing ever acknowledged;
 *  2. the default has moved to V2 (a value copy of V1, as `forkRoot` makes it)
 *     and the next session boots there.
 *
 * Before the fix, measured on the dev stack the same way
 * (repoint-offline-create.spec.ts test 2): the second session hydrated the
 * ledger, PINNED the V1 documents and re-presented them on V2's socket — V1's
 * server registry gained the diagram while its DiagramDoc was claimed by V2 —
 * and the creation intent had been forgotten at the V1 shard's local flush, so
 * V2 never got the diagram at all. Here: the V1 documents are withheld (never
 * pinned, never answered), dropped from the ledger and remembered for good, and
 * the creation is written into V2's registry with a NEW DiagramDoc.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentId, PeerId } from '@automerge/automerge-repo'
import * as repoModule from './repo'
import { repo } from './repo'
import { OVERLAY_WRITE_HEAD_VERSION } from './overlayWriteHead'
import type { ModelMeta, RegistryShard, RootDoc } from './types'
import { setActiveWorkspaceRef, type WorkspaceRef } from './workspace'
import { __resetResolvedWorkspacesForTest, rememberResolvedWorkspace } from './workspaceBinding'
import { createMemoryKvStore, workspaceKvStore, __setWorkspaceKvBaseForTest } from '../modelQuery/kvStore'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { apiFetch } from '../api/http'

// The server is unreachable unless a test says otherwise: nothing is
// acknowledged, no id is minted, no render arrives. (A network-level failure,
// as `fetch` raises it.) So by default the carry cannot ask the old version —
// the "unknown" branch: carried, conflict-averse.
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
const LEDGER_KEY = 'pending-durable-heads:v1'
const peer = 'server-peer' as PeerId

/** One version's documents on an ordinary boot-from-server workspace (the
 * bridgeBfsDocUrl.test.ts fixture). V2 is built the way `forkRoot` builds a
 * fork: the same VALUES under fresh documents, no shared history. */
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
  return { root, meta, shard }
}
type Graph = ReturnType<typeof versionGraph>

const read = (handle: { doc(): unknown }) => handle.doc() as any

/** Boot the real bridge on `graph`, whose root fetch names `versionId` — the
 * `root-fetch` basis `documentsWorkspaceFor` trusts. */
async function boot(graph: Graph, versionId: string) {
  vi.spyOn(repoModule, 'getRootHandle').mockImplementation(async () => {
    rememberResolvedWorkspace(REF, { landscapeId: 'default', versionId }, { from: 'root-fetch', rootUrl: graph.root.url })
    return graph.root as any
  })
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(graph.meta as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([graph.shard] as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
  const { startBridge, isBootFromServerActive } = await import('./bridge')
  await startBridge(REF)
  // Anti-void: the creation is journaled by the BFS capture only.
  expect(isBootFromServerActive()).toBe(true)
}

async function settleWrites(): Promise<void> {
  for (const ms of [300, 0, 0, 100, 0, 0]) await new Promise((resolve) => setTimeout(resolve, ms))
}

async function persistedLedgerIds(): Promise<string[]> {
  const entries = await workspaceKvStore().get<Array<{ documentId: string }>>(LEDGER_KEY)
  return (entries ?? []).map((entry) => entry.documentId)
}

/** documentId → the workspace tag the persisted ledger carries for it. */
async function persistedLedgerTags(): Promise<Record<string, string | null | undefined>> {
  const entries = await workspaceKvStore().get<Array<{ documentId: string; workspace?: string | null }>>(LEDGER_KEY)
  return Object.fromEntries((entries ?? []).map((entry) => [entry.documentId, entry.workspace]))
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

/** Session 1: create a diagram on `graph` with the server unreachable and stop
 * once the ledger on disk owes the server both carriers. */
async function createOffline(graph: Graph): Promise<{ diagramId: string; oldDocUrl: string; oldDocId: string }> {
  await boot(graph, 'V1')
  const diagramId = useModelStore.getState().addDiagram({
    name: 'Made offline', type: 'context', objectIds: [], connectionIds: [], groupIds: [], layouts: {},
  } as any)
  await settleWrites()
  await vi.waitFor(() => expect(read(graph.shard).diagrams[diagramId]?.docUrl).toBeTruthy(), { timeout: 5_000 })
  const oldDocUrl: string = read(graph.shard).diagrams[diagramId].docUrl
  const oldDocId = oldDocUrl.slice('automerge:'.length)
  await vi.waitFor(async () => expect(await persistedLedgerIds()).toEqual(
    expect.arrayContaining([graph.shard.documentId, oldDocId]),
  ), { timeout: 5_000 })
  const { stopBridge } = await import('./bridge')
  stopBridge()
  await settleWrites()
  resetStores()
  return { diagramId, oldDocUrl, oldDocId }
}

describe('a repoint carries unsynced work into the version `current` now names', () => {
  beforeEach(async () => {
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    localStorage.clear()
    localStorage.setItem('maplespire:bootFromServer', 'true')
    __setWorkspaceKvBaseForTest(createMemoryKvStore())
    setActiveWorkspaceRef(REF)
    // Unreachable again (`answerOldVersion` replaces it for one test).
    vi.mocked(apiFetch).mockImplementation(async () => { throw new TypeError('Failed to fetch') })
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
    __resetResolvedWorkspacesForTest()
    __setWorkspaceKvBaseForTest(null)
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('withholds the old version\'s documents and re-creates the diagram in the new one', async () => {
    const v1 = versionGraph()
    const { diagramId, oldDocUrl, oldDocId } = await createOffline(v1)

    // The default moved to V2 while that was unsynced; the next session boots there.
    const v2 = versionGraph()
    const { activeDocumentShare } = repoModule
    const pin = vi.spyOn(activeDocumentShare, 'pin')
    await boot(v2, 'V2')

    // The old version's documents are never offered on this session's socket:
    // not pinned, not announced, not even answered.
    const pinned = pin.mock.calls.map(([documentId]) => documentId as string)
    expect(pinned, 'the V1 registry shard was re-presented to V2').not.toContain(v1.shard.documentId)
    expect(pinned, 'the V1-minted DiagramDoc was re-presented to V2').not.toContain(oldDocId)
    await expect(activeDocumentShare.shareConfig.access(peer, v1.shard.documentId as DocumentId)).resolves.toBe(false)
    await expect(activeDocumentShare.shareConfig.access(peer, oldDocId as DocumentId)).resolves.toBe(false)

    // The diagram is in the version the tab now writes into, under a NEW doc.
    await settleWrites()
    await vi.waitFor(() => expect(read(v2.shard).diagrams[diagramId]?.docUrl).toBeTruthy(), { timeout: 10_000 })
    const newDocUrl: string = read(v2.shard).diagrams[diagramId].docUrl
    expect(newDocUrl, 'the old version\'s document was reused').not.toBe(oldDocUrl)
    const newDocId = newDocUrl.slice('automerge:'.length) as DocumentId
    // The re-created document is a real one this session OFFERS (QA lens: a
    // url that merely differs passed with a document nobody could sync).
    expect(repo.handles[newDocId], 'the re-created DiagramDoc was never created').toBeDefined()
    expect(activeDocumentShare.isWithheld(newDocId), 'the re-created DiagramDoc is withheld').toBe(false)
    await expect(activeDocumentShare.shareConfig.access(peer, newDocId)).resolves.toBe(true)
    expect(useModelStore.getState().diagrams.map((diagram) => diagram.id)).toContain(diagramId)

    // They stay in the persisted ledger, DORMANT: tagged with V1, owed to no
    // server of this session (no permanent "saving" over documents nothing
    // here will present), and still there for V1 should it come back.
    const { __bridgeDurableHeadDocumentIdsForTest } = await import('./bridge')
    expect(__bridgeDurableHeadDocumentIdsForTest()).not.toContain(v1.shard.documentId)
    expect(__bridgeDurableHeadDocumentIdsForTest()).not.toContain(oldDocId)
    await vi.waitFor(async () => expect(await persistedLedgerTags()).toEqual(expect.objectContaining({
      [v1.shard.documentId]: 'default/V1',
      [oldDocId]: 'default/V1',
    })), { timeout: 5_000 })

    // A LATER page load still keeps them off the socket — the server
    // announces its root's registry shards to every peer. (A fresh page has no
    // in-memory withhold: another session beginning clears it, as a page load
    // does.)
    const { stopBridge } = await import('./bridge')
    stopBridge()
    activeDocumentShare.beginSession('a fresh page load')
    activeDocumentShare.endSession()
    await expect(activeDocumentShare.shareConfig.access(peer, v1.shard.documentId as DocumentId)).resolves.toBe(true)
    resetStores()
    await boot(v2, 'V2')
    await expect(activeDocumentShare.shareConfig.access(peer, v1.shard.documentId as DocumentId)).resolves.toBe(false)
    await expect(activeDocumentShare.shareConfig.access(peer, oldDocId as DocumentId)).resolves.toBe(false)
  })

  // The carry ASKS the old version first (bridge.ts `carryRepointedWork`): a
  // SENT record outlives its delivery, and one the old version already holds
  // may be in the fork — replayed, a creation a colleague deleted there would
  // come back (reviewer lens, 2026-10-31).
  function answerOldVersion(durable: boolean) {
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const href = String(url)
      if (href.includes('/api/automerge/durable-heads') && href.includes('versionId=V1')) {
        const { documents } = JSON.parse(String(init?.body)) as { documents: Array<{ documentId: string }> }
        return new Response(JSON.stringify({ documents: documents.map(({ documentId }) => ({ documentId, durable })) }), { status: 200 })
      }
      throw new TypeError('Failed to fetch')
    })
  }

  it('work the OLD version already holds is not carried: the new version is not re-asserted', async () => {
    const v1 = versionGraph()
    const { diagramId } = await createOffline(v1)
    answerOldVersion(true)
    const v2 = versionGraph()
    await boot(v2, 'V2')
    await settleWrites()
    await settleWrites()
    expect(read(v2.shard).diagrams[diagramId], 'a creation V1 already held was carried into V2').toBeUndefined()
    const { pendingEntityIntents } = await import('./entityIntents')
    expect(pendingEntityIntents.pending('default/current').map((intent) => intent.id)).not.toContain(diagramId)
    expect(pendingEntityIntents.sentCount('default/current'), 'the records V1 holds were released').toBe(0)
  })

  it('work the old version answers it does NOT hold is carried', async () => {
    const v1 = versionGraph()
    const { diagramId, oldDocUrl } = await createOffline(v1)
    answerOldVersion(false)
    const v2 = versionGraph()
    await boot(v2, 'V2')
    await settleWrites()
    await vi.waitFor(() => expect(read(v2.shard).diagrams[diagramId]?.docUrl).toBeTruthy(), { timeout: 10_000 })
    expect(read(v2.shard).diagrams[diagramId].docUrl).not.toBe(oldDocUrl)
  })

  it('if the default comes BACK to the old version, its documents are released and re-presented there', async () => {
    // Both lenses, 2026-10-31: a withhold-for-good list froze V1's own shards
    // after a move back — nothing synced, every new edit "saving" for ever.
    const v1 = versionGraph()
    const { oldDocId } = await createOffline(v1)
    const v2 = versionGraph()
    await boot(v2, 'V2')
    await expect(repoModule.activeDocumentShare.shareConfig.access(peer, v1.shard.documentId as DocumentId)).resolves.toBe(false)
    const { stopBridge, __bridgeDurableHeadDocumentIdsForTest } = await import('./bridge')
    stopBridge()
    await settleWrites()

    resetStores()
    const pin = vi.spyOn(repoModule.activeDocumentShare, 'pin')
    await boot(v1, 'V1')
    await vi.waitFor(() => expect(pin).toHaveBeenCalledWith(v1.shard.documentId, 'durability-pending'))
    expect(pin).toHaveBeenCalledWith(oldDocId, 'durability-pending')
    await expect(repoModule.activeDocumentShare.shareConfig.access(peer, v1.shard.documentId as DocumentId)).resolves.toBe(true)
    expect(__bridgeDurableHeadDocumentIdsForTest()).toEqual(expect.arrayContaining([v1.shard.documentId, oldDocId]))
  })

  it('a session that boots the SAME version keeps re-presenting its own documents (the control)', async () => {
    const v1 = versionGraph()
    const { oldDocId } = await createOffline(v1)

    const pin = vi.spyOn(repoModule.activeDocumentShare, 'pin')
    await boot(v1, 'V1')
    await vi.waitFor(() => expect(pin).toHaveBeenCalledWith(oldDocId, 'durability-pending'))
    await expect(repoModule.activeDocumentShare.shareConfig.access(peer, oldDocId as DocumentId)).resolves.toBe(true)
    expect(await persistedLedgerIds()).toContain(oldDocId)
    const { __bridgeDurableHeadDocumentIdsForTest } = await import('./bridge')
    expect(__bridgeDurableHeadDocumentIdsForTest()).toContain(oldDocId)
  })
})
