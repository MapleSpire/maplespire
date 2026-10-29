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
 * A boot-from-server client whose server is unreachable — measured on a real
 * stack 2026-10-16 (e2e/boot/offline.spec.ts), each a separate defect:
 *
 *  1. The badge said "Synced" offline. The render-fetch failure set the STATUS
 *     to offline but left the transport flag up, and the end of boot asserted
 *     the transport connected with no evidence; the next durable-ack tick or
 *     write then re-claimed ready/saving.
 *  2. An edit made offline looked reverted after an offline reload. It was
 *     durable in the entity-intent journal, but the journal was put back on
 *     screen only once the overlay head resolve gave up (9 min 33 s) — and a
 *     head this browser never fetched cannot resolve while offline.
 *
 * Fixture: the summary workspace of bridgeSummaryViewWrite.test.ts (a summary
 * root forces boot-from-server whatever the build flags say).
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import * as handleRetry from './handleRetry'
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
    update: async (key: string, fn: (value: unknown) => unknown) => {
      kv.set(key, fn(kv.get(key)))
    },
  }),
}))

const mocks = vi.hoisted(() => ({
  fetchDiagramListPage: vi.fn(),
  fetchDiagramMeta: vi.fn(),
  fetchDiagramRender: vi.fn(),
  readCachedDiagramRender: vi.fn(),
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
  readCachedDiagramRender: mocks.readCachedDiagramRender,
}))

const DIAGRAM = 'dg-landscape'
const SHAPE = 'o-existing'

function shape(name: string) {
  return {
    id: SHAPE, type: 'system', name,
    position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
    tagAssignments: {}, tagOrder: [], properties: {},
    scope: 'internal', status: 'live',
  }
}

/** The render a previous online visit left in the Worker cache. */
function render(name = 'Server name') {
  return { projectionGeneration: 1, objects: [shape(name)], connections: [], groups: [] }
}

function diagramMeta() {
  return { id: DIAGRAM, name: 'Landscape', type: 'landscape', docUrl: '', objectIds: [SHAPE], connectionIds: [], groupIds: [] }
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
  return { meta }
}

/** The overlay heads were never fetched into this browser: offline, their
 *  resolve cannot finish (the real one retries for 9 min 33 s). */
function headsUnresolvable(): void {
  vi.spyOn(handleRetry, 'resolveReadyHandleWithRetry').mockImplementation(() => new Promise(() => {}))
}

async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const status = () => useAutomergeStatus.getState().status
const shapeName = () => useModelStore.getState().objects.find((o) => o.id === SHAPE)?.name

function resetStores(): void {
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
}

describe('a boot-from-server client with its server unreachable', () => {
  beforeEach(async () => {
    kv.clear()
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    const { __resetIndexReady } = await import('../modelQuery/offlineIndex')
    __resetIndexReady()
    localStorage.clear()
    vi.clearAllMocks()
    mocks.fetchDiagramRender.mockRejectedValue(new TypeError('Failed to fetch'))
    mocks.readCachedDiagramRender.mockResolvedValue(render())
    mocks.fetchDiagramListPage.mockResolvedValue({ items: [diagramMeta()], nextCursor: null, total: 1 })
    mocks.fetchDiagramMeta.mockResolvedValue({
      meta: diagramMeta(),
      diagram: {
        id: DIAGRAM, name: 'Landscape', type: 'landscape',
        objectIds: [SHAPE], connectionIds: [], groupIds: [], layouts: {},
      },
      comments: [],
      flows: [],
    })
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
    vi.restoreAllMocks()
    localStorage.clear()
    kv.clear()
  })

  it('boots showing Offline, and keeps showing it while the user edits', async () => {
    summaryFixture()
    headsUnresolvable()
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    await vi.waitFor(() => expect(shapeName()).toBe('Server name'), { timeout: 3_000 })
    // Void-run guard: the render really came from the offline fallback.
    expect(mocks.fetchDiagramRender).toHaveBeenCalled()
    expect(mocks.readCachedDiagramRender).toHaveBeenCalled()

    await settle()
    expect(status()).toBe('offline')
    // A write is where a raised transport flag re-claimed 'saving'.
    useModelStore.getState().updateObject(SHAPE, { name: 'Edited offline' })
    await settle()
    expect(shapeName()).toBe('Edited offline')
    expect(status()).toBe('offline')
  })

  it('an online session whose render fetch starts failing turns Offline and stays there', async () => {
    summaryFixture()
    mocks.fetchDiagramRender.mockResolvedValue(render())
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    await vi.waitFor(() => expect(shapeName()).toBe('Server name'), { timeout: 3_000 })
    expect(status()).not.toBe('offline') // void-run guard: this one booted ONLINE

    mocks.fetchDiagramRender.mockRejectedValue(new TypeError('Failed to fetch'))
    await (window as any).__projectActive()
    expect(status()).toBe('offline')
    useModelStore.getState().updateObject(SHAPE, { name: 'Edited after the outage' })
    await settle()
    expect(status()).toBe('offline')

    // The server is back: a render answers again. The evidence must clear with it,
    // or every later ack hiccup from a LIVE server would read as Offline.
    mocks.fetchDiagramRender.mockResolvedValue(render('Edited after the outage'))
    await (window as any).__projectActive()
    expect(status()).not.toBe('offline')
    useModelStore.getState().updateObject(SHAPE, { name: 'Edited after the recovery' })
    await settle()
    expect(status()).not.toBe('offline')
  })

  it('a boot-from-server session still publishes a model-shard pointer an earlier resident session held back', async () => {
    // 2026-10-19: resume used to run only on the resident
    // path, so a session that booted from the server left the pointer held
    // for ever and the shard's objects invisible to everyone.
    const { meta } = summaryFixture()
    mocks.fetchDiagramRender.mockResolvedValue(render())
    const held = repo.create<Record<string, unknown>>({ objects: { o9: shape('Held') } })
    kv.set('deferred-references:v1', [{ holderDocumentId: meta.documentId, field: 'objectShardUrls', url: held.url }])
    const findHeld = vi.spyOn(repoModule, 'findHeldModelShardHandle').mockResolvedValue(held as any)
    const durableSync = await import('./durableSync')
    vi.spyOn(durableSync, 'acknowledgeDurableDocumentHeads').mockImplementation(async (documents) =>
      documents.map(({ documentId }) => ({ documentId, durable: documentId === held.documentId })))

    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    await vi.waitFor(() => expect(shapeName()).toBe('Server name'), { timeout: 3_000 })
    expect((window as any).__bridgeDebug().bfsActive).toBe(true) // void-run guard: booted from the server

    expect(findHeld).toHaveBeenCalledWith(held.url)
    await vi.waitFor(() => expect([...(meta.doc()?.objectShardUrls ?? [])]).toContain(held.url), { timeout: 3_000 })
    await vi.waitFor(() => expect(kv.get('deferred-references:v1')).toEqual([]), { timeout: 3_000 })
  })

  it('a render answered with an HTTP error is NOT "unreachable": the badge does not stay Offline', async () => {
    // Reviewer lens, 2026-10-16: a 500/403 comes from a LIVE server. Counting it
    // as transport evidence would pin the badge on Offline for a reachable server.
    summaryFixture()
    headsUnresolvable()
    const bridge = await import('./bridge')
    // A previous session in this tab really was offline: its evidence must not
    // outlive it (startBridge resets it).
    await bridge.startBridge(DEFAULT_WORKSPACE_REF)
    await vi.waitFor(() => expect(status()).toBe('offline'), { timeout: 3_000 })
    bridge.stopBridge()
    resetStores()

    mocks.fetchDiagramRender.mockRejectedValue(new Error('diagram-render API → HTTP 500'))
    await bridge.startBridge(DEFAULT_WORKSPACE_REF)
    await vi.waitFor(() => expect(shapeName()).toBe('Server name'), { timeout: 3_000 })
    expect(mocks.fetchDiagramRender).toHaveBeenCalled() // void-run guard: the error path ran
    // A failed render still raises the status-only 'offline' signal it always had,
    // and an ack tick may or may not have lifted it yet — so read the TRANSPORT
    // belief through its user-visible effect instead: a write against a server
    // believed reachable reads "Saving…" at once (scheduleWrite), never Offline.
    useModelStore.getState().updateObject(SHAPE, { name: 'Edited against a 500' })
    expect(status()).toBe('saving')
  })

  it('an edit made offline is on screen again after an offline reload', async () => {
    summaryFixture()
    headsUnresolvable()
    const bridge = await import('./bridge')
    await bridge.startBridge(DEFAULT_WORKSPACE_REF)
    await vi.waitFor(() => expect(shapeName()).toBe('Server name'), { timeout: 3_000 })
    useModelStore.getState().updateObject(SHAPE, { name: 'Edited offline' })
    await settle()
    // Void-run guard: with no resolvable head the edit lives only in the journal.
    const debug = (window as any).__bridgeDebug()
    expect(debug.resolvedObjectOverlayHeads).toBe(0)
    expect(debug.pendingIntentsByKind.object).toBeGreaterThan(0)

    // Reload: a new session, the store emptied, the same (cached) render.
    bridge.stopBridge()
    resetStores()
    await bridge.startBridge(DEFAULT_WORKSPACE_REF)
    await vi.waitFor(() => expect(shapeName()).toBe('Edited offline'), { timeout: 3_000 })
  })
})
