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
 * Boot-from-server on an ORDINARY workspace (`bfsActive ∧ ¬registrySummaryOnly`,
 * the VITE flag on a classic landscape): the doc-url index is rebuilt only at
 * boot (`rebuildRegistryIndex`; `projectAll` returns early under bfs). A
 * diagram a colleague adds afterwards reaches the store with a registry meta
 * that names its document, and no index entry.
 *
 * Found by the reviewer lens on the 2026-10-21 doc-url fix: `ensureDiagramDoc`
 * then minted an EMPTY document for it, and the registry reconcile —
 * `docUrlById.get(id) ?? existing.docUrl` — repointed the colleague's meta at
 * that stub once it was durable. The colleague's positions were gone for
 * everyone.
 *
 * Harness: the bridgeSummaryDelete.test.ts fixture with `summaryOnly: false`.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { repo } from './repo'
import { OVERLAY_WRITE_HEAD_VERSION } from './overlayWriteHead'
import type { ModelMeta, RegistryShard, RootDoc } from './types'
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

/** The write scheduler's `normal` trailing edge is 150 ms of REAL time. */
async function settleWrites(): Promise<void> {
  for (const ms of [300, 0, 0, 100, 0, 0]) await new Promise((resolve) => setTimeout(resolve, ms))
}

function ordinaryFixture() {
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
  const registry = repo.create<RegistryShard>({ diagrams: {} } as RegistryShard)
  const root = repo.create<RootDoc>({
    modelUrl: '',
    modelMetaUrl: meta.url,
    shardUrls: [registry.url],
  } as unknown as RootDoc)
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([registry] as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
  return { registry }
}

describe('a colleague\'s diagram under boot-from-server keeps its document', () => {
  beforeEach(async () => {
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
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
  })

  it('mints no stub for it and never repoints its meta', async () => {
    localStorage.setItem('maplespire:bootFromServer', 'true')
    const { registry } = ordinaryFixture()
    const { startBridge, isRegistrySummaryOnlyActive, isBootFromServerActive } = await import('./bridge')
    await startBridge({ landscapeId: 'ordinary-bfs-colleague', versionId: 'current' })
    // Anti-void: the reachable state really is bfs WITHOUT summary.
    expect(isBootFromServerActive()).toBe(true)
    expect(isRegistrySummaryOnlyActive()).toBe(false)

    // After boot, a colleague publishes a laid-out diagram.
    const colleagueDoc = repo.create<any>({
      name: 'Colleague diagram', type: 'container', objectIds: ['o1'], connectionIds: [], groupIds: [],
      layouts: { o1: { position: { x: 300, y: 400 }, size: { width: 200, height: 100 } } },
      comments: {}, flows: {}, checkpoints: [],
    })
    registry.change((shard: any) => {
      shard.diagrams['dg-colleague'] = {
        id: 'dg-colleague', name: 'Colleague diagram', type: 'container', docUrl: colleagueDoc.url,
        objectIds: ['o1'], connectionIds: [], groupIds: [],
      }
    })
    const minted: string[] = []
    const create = repoModule.createDiagramHandle
    vi.spyOn(repoModule, 'createDiagramHandle').mockImplementation((initial: any) => {
      minted.push(initial.name)
      return create(initial)
    })

    // It reaches the store as a stub (no layouts), and an ordinary edit flushes.
    useModelStore.setState({
      diagrams: [{
        id: 'dg-colleague', name: 'Colleague diagram', type: 'container',
        objectIds: ['o1'], connectionIds: [], groupIds: [], layouts: {},
      } as any],
    })
    await settleWrites()
    useModelStore.getState().updateDiagram('dg-colleague', { description: 'touched' } as any)
    await settleWrites()

    expect((registry.doc() as any).diagrams['dg-colleague'].docUrl, 'the colleague\'s meta').toBe(colleagueDoc.url)
    expect(minted, 'documents minted for the colleague\'s diagram').toEqual([])
  })
})
