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
 * The view-settings fast path must NOT be taken for a SESSION-LOCAL diagram of
 * a summary-only workspace: its in-memory bootstrap (`serverDiagramBootstraps`)
 * is refreshed only by `writeSummaryLocalRegistry` inside the full write, and
 * it is what projects the diagram once it is no longer active. Fixture: the
 * bridgeSummaryDelete.test.ts summary workspace.
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
import {
  __setClientTimelineEnabledForTest,
  readClientTimeline,
  resetClientTimeline,
} from '../observability/clientTimeline'

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

const SERVER_OWNED = 'dg-server-owned'
const MINE = 'dg-session-local'

function diagramMeta(id: string, name: string) {
  return { id, name, type: 'container', docUrl: '', objectIds: [], connectionIds: [], groupIds: [] }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function settleWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await settle()
}

function summaryFixture() {
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
    registrySummaryOnly: true,
  } as unknown as RootDoc)
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root as any)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([] as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
  return { root, meta, writeHead }
}

const viewFlushMarks = () => readClientTimeline().entries.filter((entry) => entry.name === 'diagramView.flush').length

describe('view-settings edit of a session-local diagram under a summary registry', () => {
  beforeEach(async () => {
    kv.clear()
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    const { __resetIndexReady } = await import('../modelQuery/offlineIndex')
    __resetIndexReady()
    localStorage.clear()
    vi.clearAllMocks()
    __setClientTimelineEnabledForTest(true)
    resetClientTimeline()
    mocks.fetchDiagramRender.mockRejectedValue(new Error('offline in this suite'))
    mocks.fetchDiagramListPage.mockResolvedValue({
      items: [diagramMeta(SERVER_OWNED, 'Owned by the server')],
      nextCursor: null,
      total: 10_000,
    })
    mocks.fetchDiagramMeta.mockResolvedValue({
      meta: diagramMeta(SERVER_OWNED, 'Owned by the server'),
      diagram: {
        id: SERVER_OWNED, name: 'Owned by the server', type: 'container',
        objectIds: [], connectionIds: [], groupIds: [], layouts: {},
      },
      comments: [],
      flows: [],
    })
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
    __setClientTimelineEnabledForTest(null)
    vi.restoreAllMocks()
    localStorage.clear()
    kv.clear()
  })

  it('takes the FULL write, so the bootstrap that projects it once inactive carries the new skin', async () => {
    summaryFixture()
    const { startBridge, getActiveDiagramHandle, isRegistrySummaryOnlyActive, sessionLocalDiagramIds } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(isRegistrySummaryOnlyActive()).toBe(true)

    useModelStore.setState({
      diagrams: [...useModelStore.getState().diagrams, {
        id: MINE, name: 'Made here', type: 'container',
        objectIds: [], connectionIds: [], groupIds: [], layouts: {},
      } as any],
    })
    await settleWrites()
    expect(sessionLocalDiagramIds().has(MINE)).toBe(true)

    useModelStore.getState().setCurrentDiagram(MINE)
    await vi.waitFor(() => expect(getActiveDiagramHandle()).not.toBeNull(), { timeout: 3_000 })
    await settleWrites()
    const mineDoc = getActiveDiagramHandle()!

    useModelStore.getState().updateDiagram(MINE, { skinId: 'studio' })
    await settleWrites()
    // The active doc has it either way…
    expect((mineDoc.doc() as any).skinId).toBe('studio')
    // …but the view fast path was refused for a session-local summary diagram.
    const marksAfterEdit = viewFlushMarks()

    // Leave it: it is now projected from its bootstrap, which must be fresh.
    useModelStore.getState().setCurrentDiagram(SERVER_OWNED)
    await vi.waitFor(() => expect(useModelStore.getState().currentDiagramId).toBe(SERVER_OWNED), { timeout: 3_000 })
    await settleWrites()
    const projected = useModelStore.getState().diagrams.find((d) => d.id === MINE)
    expect(projected?.skinId).toBe('studio')
    // Witness of the path itself (asserted LAST so a failure above names the
    // user-visible symptom first).
    expect(marksAfterEdit).toBe(0)
  })
})
