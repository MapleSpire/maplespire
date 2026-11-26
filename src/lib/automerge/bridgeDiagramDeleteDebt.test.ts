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
 * T-DIAGDEF-2 — on the WHOLE-MODEL plane (an ordinary workspace not
 * booted from the server: `bfsActive` false), a diagram delete that no
 * document holds yet is a debt the badge must show.
 *
 * There the delete has no journal of its own: `captureExplicitDeletes` runs
 * only under boot-from-server, and the whole-model branch clears the explicit
 * intent at once, counting on the registry write. When that write cannot
 * express it — the shard listing the diagram is not resolved at the flush,
 * the case `LocalDiagramHold` keeps the deletion held for — no document
 * changed, the durable ledger has nothing, the scheduler is idle: every term
 * of the badge's sum was 0, and it said Synced over a delete the server
 * would never see if the tab closed.
 *
 * The REAL bridge with REAL Automerge handles (`bridgeDiagramDeleteConvergence
 * .test.ts`'s fixture); the durability endpoint is spied to say every
 * document is durable, so the only debt left is the one under test.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { repo } from './repo'
import * as durableSyncModule from './durableSync'
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

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The write scheduler's trailing edge (150 ms) and the ack's debounce. */
async function settleWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 300))
  await settle()
}

const meta = (id: string) => ({ id, name: id, type: 'container', docUrl: '', objectIds: [], connectionIds: [], groupIds: [] })

function fixture() {
  const objectBase = repo.create<Record<string, unknown>>({ objects: {} })
  const connectionBase = repo.create<Record<string, unknown>>({ connections: {} })
  const objectHead = repo.create<Record<string, unknown>>({ objects: {}, writeHeadVersion: 1 })
  const connectionHead = repo.create<Record<string, unknown>>({ connections: {}, writeHeadVersion: 1 })
  const modelMeta = repo.create<ModelMeta>({
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
  const registryBase = repo.create<RegistryShard>({ diagrams: {
    'dg-other': meta('dg-other'), 'dg-third': meta('dg-third'),
  } } as unknown as RegistryShard)
  // The shard holding the diagram deleted, whose document can go unresolved
  // (`doc()` undefined: evicted, not yet loaded) — a registry INCOMPLETE at
  // the flush, so the write cannot express the delete.
  const flaky = repo.create<RegistryShard>({ diagrams: { 'dg-gone': meta('dg-gone') } } as unknown as RegistryShard)
  const state = { loaded: true }
  const flakyDoc = flaky.doc.bind(flaky)
  flaky.doc = (() => (state.loaded ? flakyDoc() : undefined)) as typeof flaky.doc
  const root = repo.create<RootDoc>({
    modelUrl: '',
    modelMetaUrl: modelMeta.url,
    shardUrls: [registryBase.url, flaky.url],
  } as unknown as RootDoc)
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root as any)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(modelMeta as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([registryBase, flaky] as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
  return { state, flakyDoc }
}

const status = () => useAutomergeStatus.getState().status

describe('T-DIAGDEF-2 — the badge over a whole-model diagram delete no document holds', () => {
  beforeEach(async () => {
    kv.clear()
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    const { __resetIndexReady } = await import('../modelQuery/offlineIndex')
    __resetIndexReady()
    localStorage.clear()
    vi.clearAllMocks()
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
    // The server holds every document it is asked about.
    vi.spyOn(durableSyncModule, 'acknowledgeDurableDocumentHeads').mockImplementation(async (documents) =>
      documents.map(({ documentId }) => ({ documentId, durable: true })))
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
    localStorage.clear()
    kv.clear()
  })

  it('says Saving, not Synced, while the delete is in no document — and Synced once it is', async () => {
    const f = fixture()
    const { startBridge, isBootFromServerActive } = await import('./bridge')
    await startBridge({ landscapeId: 'ordinary-whole', versionId: 'current' })
    expect(isBootFromServerActive(), 'the whole-model plane is what this case is about: VOID').toBe(false)
    await settleWrites()
    expect(useModelStore.getState().diagrams.map((d) => d.id).sort()).toEqual(['dg-gone', 'dg-other', 'dg-third'])
    // Anti-void: with nothing owed, the badge does reach Synced here.
    await expect.poll(status, { timeout: 3_000 }).toBe('ready')

    f.state.loaded = false // the flush cannot write that shard, nor see it
    useModelStore.getState().deleteDiagram('dg-gone')
    await settleWrites()
    // Nothing expressed it: the registry still lists it, the store does not.
    expect(Object.keys(f.flakyDoc()?.diagrams ?? {})).toContain('dg-gone')
    expect(useModelStore.getState().diagrams.map((d) => d.id)).not.toContain('dg-gone')
    // Another write runs an acknowledgement round (the ledger empties again).
    useModelStore.setState({ objects: [{ id: 'obj-z', name: 'Later', type: 'system', description: '', tags: [] } as any] })
    await settleWrites()
    expect(status(), 'the badge says Synced over a diagram delete no document holds').not.toBe('ready')

    // The shard comes back, with NO edit after it (the debt once had no
    // engine — Saving until some unrelated edit): the held delete's own retry
    // expresses it where it lives, and the badge settles.
    f.state.loaded = true
    await expect.poll(() => Object.keys(f.flakyDoc()?.diagrams ?? {}), { timeout: 10_000 }).not.toContain('dg-gone')
    await expect.poll(status, { timeout: 5_000 }).toBe('ready')
  }, 30_000)

  it('the retry backs off while the shard stays unresolved, and stopBridge ends it', async () => {
    const f = fixture()
    const { startBridge, stopBridge, __heldDeletionRetryForTest } = await import('./bridge')
    await startBridge({ landscapeId: 'ordinary-whole-2', versionId: 'current' })
    await settleWrites()
    f.state.loaded = false
    useModelStore.getState().deleteDiagram('dg-gone')
    await settleWrites()
    expect(__heldDeletionRetryForTest().armed, 'no retry armed for a held delete').toBe(true)
    // ~6.5 s unresolved: retries at +2 s and +4 s at most (2, 4, 8… s), not one per tick.
    await new Promise((resolve) => setTimeout(resolve, 6_500))
    const during = __heldDeletionRetryForTest()
    expect(during.fired).toBeGreaterThanOrEqual(1)
    expect(during.fired).toBeLessThanOrEqual(2)
    expect(during.nextDelayMs).toBeGreaterThanOrEqual(8_000)
    // The session ends: no timer, and no write armed by it afterwards.
    stopBridge()
    expect(__heldDeletionRetryForTest().armed).toBe(false)
    // …and stays so past the delay the next retry had (8 s would be too long
    // a test; 2.5 s covers the first retry's 2 s, which a stale timer would
    // have re-armed from).
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(__heldDeletionRetryForTest()).toMatchObject({ armed: false, fired: 0 })
    expect(Object.keys(f.flakyDoc()?.diagrams ?? {})).toContain('dg-gone')
  }, 30_000)
})
