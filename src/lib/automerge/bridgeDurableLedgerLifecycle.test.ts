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
 * The persisted pending-durability ledger across bridge sessions.
 *
 * Measured 2026-10-31 (e2e/boot/repoint-offline-create.spec.ts test 1, 5 runs
 * of 5): a diagram created OFFLINE had its DiagramDoc in the persisted ledger
 * right up to the offline reload, and the ledger was EMPTY right after it.
 * React StrictMode mounts, unmounts and remounts `AutomergeBridge`, so the first
 * `startBridge` was stopped while its ledger read was still in flight; the
 * stop persisted the session's just-cleared ledger, i.e. deleted the key, and
 * the second boot read nothing. Nothing re-presented the DiagramDoc (selective
 * sync shares only the active diagram's), the server never received it, and
 * the badge said ready over it.
 *
 * Each case below puts a session boundary where production can: StrictMode's
 * remount, a second stop, a workspace switch during boot, the auth-on rebound
 * in startBridge's catch, a write made while the read is in flight, a read
 * that fails.
 *
 * The store is the REAL one — `workspaceKvStore()` over idb-keyval over
 * fake-indexeddb — because both defects the review lenses found after the
 * first fix lived below a hand-written fake: the namespace is derived from the
 * active workspace (the rebound moves it before it stops), and idb-keyval's
 * `update` never settles when its read fails (the mock's did).
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getHeads } from '@automerge/automerge'
import { IDBFactory, IDBKeyRange as FakeIDBKeyRange, IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { repo } from './repo'
import { DEFAULT_WORKSPACE_REF, setActiveWorkspaceRef, type WorkspaceRef } from './workspace'
import { OVERLAY_WRITE_HEAD_VERSION } from './overlayWriteHead'
import { idbKvStore } from '../modelQuery/kvStore'
import { useModelStore } from '../../stores/modelStore'
import { useAuthStore } from '../../stores/authStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import type { ModelMeta, RegistryShard, RootDoc } from './types'

// Installed after the imports above have run: repo.ts picks its storage
// adapter when it is evaluated, so the Automerge repo stays in memory and only
// the key/value store sees IndexedDB.
;(globalThis as any).indexedDB = new IDBFactory()
;(globalThis as any).IDBKeyRange = FakeIDBKeyRange

const LEDGER = 'pending-durable-heads:v1'

/** Fail every read of the ledger key while set, the way a browser fails one:
 *  the request's transaction aborts and the request fires `error`. */
const injection = { failLedgerReads: false }
const originalGet = FakeIDBObjectStore.prototype.get
FakeIDBObjectStore.prototype.get = function (this: any, key: unknown) {
  const request = originalGet.call(this, key as never)
  if (injection.failLedgerReads && typeof key === 'string' && key.endsWith(`::${LEDGER}`)) {
    this.transaction.abort()
  }
  return request
}

const mocks = vi.hoisted(() => ({
  fetchDiagramListPage: vi.fn(),
  fetchDiagramMeta: vi.fn(),
  fetchDiagramRender: vi.fn(),
  readCachedDiagramRender: vi.fn(),
  resolveBootWorkspaceRef: vi.fn(),
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
vi.mock('./bootRef', async (importOriginal) => ({
  ...await importOriginal<typeof import('./bootRef')>(),
  resolveBootWorkspaceRef: mocks.resolveBootWorkspaceRef,
}))

const OTHER_REF: WorkspaceRef = { landscapeId: 'other', versionId: 'current' }
const DRAFT_REF: WorkspaceRef = { landscapeId: 'draftland', versionId: 'd1' }
const DIAGRAM = 'dg-landscape'
const SHAPE = 'o-existing'
const initialAuth = useAuthStore.getState()

function render() {
  return {
    projectionGeneration: 1,
    objects: [{
      id: SHAPE, type: 'system', name: 'Server name',
      position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
      tagAssignments: {}, tagOrder: [], properties: {},
      scope: 'internal', status: 'live',
    }],
    connections: [],
    groups: [],
  }
}

function diagramMeta() {
  return { id: DIAGRAM, name: 'Landscape', type: 'landscape', docUrl: '', objectIds: [SHAPE], connectionIds: [], groupIds: [] }
}

/** A summary workspace (the bridgeOfflineBoot.test.ts fixture): it boots from
 *  the server whatever the build flags say. */
function summaryRoot(): unknown {
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
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([] as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
  return root
}

/** A document an earlier session authored and the server never acknowledged —
 *  what the offline-created DiagramDoc was. */
function pendingDocument(value: string): { documentId: string; entry: { documentId: string; heads: string[] } } {
  const handle = repo.create<{ value: string }>({ value })
  return {
    documentId: handle.documentId,
    entry: { documentId: handle.documentId, heads: [...getHeads(handle.doc() as never)] },
  }
}

function seed(ref: WorkspaceRef, entries: Array<{ documentId: string; heads: string[] }>): Promise<void> {
  return idbKvStore.set(`${ref.landscapeId}/${ref.versionId}::${LEDGER}`, entries)
}

async function persisted(ref: WorkspaceRef): Promise<string[]> {
  const entries = await idbKvStore.get<Array<{ documentId: string }>>(`${ref.landscapeId}/${ref.versionId}::${LEDGER}`)
  return (entries ?? []).map(({ documentId }) => documentId).sort()
}

async function ledger(): Promise<string[]> {
  const { __bridgeDurableHeadDocumentIdsForTest } = await import('./bridge')
  return __bridgeDurableHeadDocumentIdsForTest().slice().sort()
}

const status = () => useAutomergeStatus.getState().status

async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms)),
  ])
}

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

describe('the persisted durability ledger across bridge sessions', () => {
  beforeEach(async () => {
    injection.failLedgerReads = false
    await idbKvStore.clear()
    setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    localStorage.clear()
    vi.clearAllMocks()
    mocks.fetchDiagramRender.mockResolvedValue(render())
    mocks.readCachedDiagramRender.mockResolvedValue(render())
    mocks.fetchDiagramListPage.mockResolvedValue({ items: [diagramMeta()], nextCursor: null, total: 1 })
    mocks.fetchDiagramMeta.mockResolvedValue({
      meta: diagramMeta(),
      diagram: { id: DIAGRAM, name: 'Landscape', type: 'landscape', objectIds: [SHAPE], connectionIds: [], groupIds: [], layouts: {} },
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
    // The server has none of these documents: every answer is "not durable".
    const durableSync = await import('./durableSync')
    vi.spyOn(durableSync, 'acknowledgeDurableDocumentHeads').mockImplementation(async (documents) =>
      documents.map(({ documentId }) => ({ documentId, durable: false })))
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(summaryRoot() as any)
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    await settle(50)
    injection.failLedgerReads = false
    vi.restoreAllMocks()
    useAuthStore.setState(initialAuth, true)
    localStorage.clear()
    setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
  })

  it('a session stopped while it reads the ledger leaves it for the next one (StrictMode remount)', async () => {
    const offlineDoc = pendingDocument('created offline')
    await seed(DEFAULT_WORKSPACE_REF, [offlineDoc.entry])
    const { startBridge, stopBridge } = await import('./bridge')

    // Exactly AutomergeBridge under StrictMode: mount, unmount, mount — the
    // first boot is still awaiting its ledger read when it is stopped.
    const first = startBridge(DEFAULT_WORKSPACE_REF)
    stopBridge()
    await startBridge(DEFAULT_WORKSPACE_REF)
    await first.catch(() => undefined)
    await settle()

    expect(await persisted(DEFAULT_WORKSPACE_REF), 'the stop deleted the persisted entry').toEqual([offlineDoc.documentId])
    expect(await ledger(), 'the remounted session does not track the earlier session\'s document').toContain(offlineDoc.documentId)
    // The badge is derived from the ledger: it must not claim Synced over it.
    expect(status()).not.toBe('ready')
  })

  it('a stop with no session running leaves the ledger alone (a switch then an unmount, a cleanup before any start)', async () => {
    const pending = pendingDocument('authored in a session already stopped')
    await seed(DEFAULT_WORKSPACE_REF, [pending.entry])
    const { startBridge, stopBridge } = await import('./bridge')

    await startBridge(DEFAULT_WORKSPACE_REF)
    await settle()
    expect(await ledger(), 'void-run guard: the session hydrated the entry').toEqual([pending.documentId])
    stopBridge()
    stopBridge()
    await settle(50)

    expect(await persisted(DEFAULT_WORKSPACE_REF), 'the second stop deleted the entry the first one wrote').toEqual([pending.documentId])
  })

  it('a workspace switched away from during its ledger read keeps its entry, and the next workspace gets none of it', async () => {
    const left = pendingDocument('authored in the workspace left')
    const next = pendingDocument('authored in the next workspace')
    await seed(DEFAULT_WORKSPACE_REF, [left.entry])
    await seed(OTHER_REF, [next.entry])
    const { startBridge, stopBridge } = await import('./bridge')

    const first = startBridge(DEFAULT_WORKSPACE_REF)
    // switchWorkspace's order: stop, THEN point the active workspace elsewhere.
    stopBridge()
    setActiveWorkspaceRef(OTHER_REF)
    await startBridge(OTHER_REF)
    await first.catch(() => undefined)
    await settle()

    expect(await persisted(DEFAULT_WORKSPACE_REF), 'switching away deleted the left workspace\'s entry').toEqual([left.documentId])
    expect(await ledger(), 'the next session tracks exactly its own workspace\'s documents').toEqual([next.documentId])
    expect(await persisted(OTHER_REF)).toEqual([next.documentId])
  })

  it('the auth-on rebound writes the failed workspace\'s ledger into its own namespace, not the fallback\'s', async () => {
    // Reviewer lens, 2026-10-31: the rebound resolves — and ACTIVATES — its
    // fallback before it stops the failed session, and the stop wrote that
    // session's ledger into whatever workspace was active by then.
    const draft = pendingDocument('authored in the dangling draft')
    const fallback = pendingDocument('authored in the fallback workspace')
    await seed(DRAFT_REF, [draft.entry])
    await seed(OTHER_REF, [fallback.entry])
    useAuthStore.setState({
      config: { stage: 'on', devLogin: false, passwordLogin: false } as any,
      user: { id: 'u', email: 'u@example.test', isPlatformAdmin: false } as any,
      orgId: 'org',
    } as any)
    mocks.resolveBootWorkspaceRef.mockImplementation(async () => {
      setActiveWorkspaceRef(OTHER_REF)
      return OTHER_REF
    })
    vi.spyOn(repoModule, 'getRootHandle')
      .mockRejectedValueOnce(new Error('root document gone'))
      .mockResolvedValue(summaryRoot() as any)
    const { startBridge } = await import('./bridge')

    setActiveWorkspaceRef(DRAFT_REF)
    await startBridge(DRAFT_REF)
    await settle()

    expect(mocks.resolveBootWorkspaceRef, 'void-run guard: the rebound ran').toHaveBeenCalledTimes(1)
    expect(await persisted(DRAFT_REF)).toEqual([draft.documentId])
    expect(await persisted(OTHER_REF), 'the failed draft\'s ledger replaced the fallback\'s').toEqual([fallback.documentId])
    expect(await ledger()).toEqual([fallback.documentId])
  })

  it('a write made while the ledger is being read joins it instead of replacing it', async () => {
    const earlier = pendingDocument('an earlier session')
    await seed(DEFAULT_WORKSPACE_REF, [earlier.entry])
    const editedDuringBoot = repo.create<{ value: string }>({ value: 'before' })
    const { startBridge } = await import('./bridge')
    const { changeWithDurabilityTracking } = await import('./durableSync')

    const boot = startBridge(DEFAULT_WORKSPACE_REF)
    // startBridge installed the change listener before its first await, so this
    // write is tracked while the ledger read is still in flight.
    changeWithDurabilityTracking(editedDuringBoot, (doc) => { doc.value = 'during boot' })
    await boot
    await settle()

    const both = [earlier.documentId, editedDuringBoot.documentId].sort()
    expect(await ledger()).toEqual(both)
    expect(await persisted(DEFAULT_WORKSPACE_REF)).toEqual(both)
  })

  it('a write made by a session stopped before its read finishes is ADDED to the persisted ledger', async () => {
    // QA lens: the add-only write had no test of its own. Overwriting with the
    // snapshot instead of merging is the original defect's shape, and skipping
    // the write loses the edit; the case above stays green on both, because
    // the replace after hydration repairs it.
    const earlier = pendingDocument('an earlier session')
    await seed(DEFAULT_WORKSPACE_REF, [earlier.entry])
    const edited = repo.create<{ value: string }>({ value: 'before' })
    const { startBridge, stopBridge } = await import('./bridge')
    const { changeWithDurabilityTracking } = await import('./durableSync')

    const first = startBridge(DEFAULT_WORKSPACE_REF)
    changeWithDurabilityTracking(edited, (doc) => { doc.value = 'during the read' })
    stopBridge()
    await first.catch(() => undefined)
    await settle()

    expect(await persisted(DEFAULT_WORKSPACE_REF)).toEqual([earlier.documentId, edited.documentId].sort())
  })

  it('once hydrated and acknowledged, the entry leaves the persisted ledger and the badge reaches ready', async () => {
    // QA lens: nothing booted, hydrated and expected the steady state, so a
    // session that never counted itself hydrated — badge 'saving' for ever,
    // acknowledged documents re-fetched on every boot — was green everywhere.
    const earlier = pendingDocument('an earlier session')
    await seed(DEFAULT_WORKSPACE_REF, [earlier.entry])
    const durableSync = await import('./durableSync')
    vi.spyOn(durableSync, 'acknowledgeDurableDocumentHeads').mockImplementation(async (documents) =>
      documents.map(({ documentId }) => ({ documentId, durable: true })))
    const { startBridge } = await import('./bridge')

    await startBridge(DEFAULT_WORKSPACE_REF)
    await vi.waitFor(() => expect(useModelStore.getState().objects.some((o) => o.id === SHAPE)).toBe(true), { timeout: 3_000 })
    await settle()

    expect(durableSync.acknowledgeDurableDocumentHeads, 'void-run guard: the entry was sent').toHaveBeenCalled()
    expect(await ledger()).toEqual([])
    expect(await idbKvStore.get(`default/current::${LEDGER}`), 'the acknowledged entry is still persisted').toBeUndefined()
    expect(status()).toBe('ready')
  })

  it('a browser with no persisted ledger boots to ready', async () => {
    const durableSync = await import('./durableSync')
    vi.spyOn(durableSync, 'acknowledgeDurableDocumentHeads').mockImplementation(async (documents) =>
      documents.map(({ documentId }) => ({ documentId, durable: true })))
    const { startBridge } = await import('./bridge')

    await startBridge(DEFAULT_WORKSPACE_REF)
    await vi.waitFor(() => expect(useModelStore.getState().objects.some((o) => o.id === SHAPE)).toBe(true), { timeout: 3_000 })
    await settle()

    expect(status()).toBe('ready')
  })

  it('a ledger write whose read fails does not wedge the next boot', async () => {
    const earlier = pendingDocument('an earlier session')
    await seed(DEFAULT_WORKSPACE_REF, [earlier.entry])
    const editedDuringBoot = repo.create<{ value: string }>({ value: 'before' })
    const { startBridge, stopBridge } = await import('./bridge')
    const { changeWithDurabilityTracking } = await import('./durableSync')

    // Every ledger read fails for the first session: its hydration, and the
    // read behind the add-only write its in-flight edit queues.
    injection.failLedgerReads = true
    const first = startBridge(DEFAULT_WORKSPACE_REF)
    changeWithDurabilityTracking(editedDuringBoot, (doc) => { doc.value = 'during boot' })
    stopBridge()
    await settle(100)
    injection.failLedgerReads = false

    await within(startBridge(DEFAULT_WORKSPACE_REF), 5_000, 'the next boot')
    await first.catch(() => undefined)
    await settle()

    expect(await ledger(), 'the next session reads what the failed writes left').toContain(earlier.documentId)
  })

  it('a ledger that could not be read is a durability debt, not an empty ledger', async () => {
    injection.failLedgerReads = true
    // Everything this session sends is durable: only the unread ledger can
    // hold the badge.
    const durableSync = await import('./durableSync')
    vi.spyOn(durableSync, 'acknowledgeDurableDocumentHeads').mockImplementation(async (documents) =>
      documents.map(({ documentId }) => ({ documentId, durable: true })))
    const { startBridge } = await import('./bridge')

    await startBridge(DEFAULT_WORKSPACE_REF)
    await vi.waitFor(() => expect(useModelStore.getState().objects.some((o) => o.id === SHAPE)).toBe(true), { timeout: 3_000 })
    await settle()

    expect(status()).toBe('saving')
  })
})
