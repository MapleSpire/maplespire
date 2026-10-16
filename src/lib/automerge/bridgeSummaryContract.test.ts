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
 * The client switch is driven by the ROOT, not by the build flags.
 *
 * A client without `VITE_BOOT_FROM_SERVER` opening a workspace whose root says
 * `registrySummaryOnly` must not boot CLASSIC: that would re-materialize every
 * baseline registry shard (~78 s / ~22 MB at 10k diagrams) and then project a
 * resident store that does not contain the model — the baseline lives in the
 * server read model. On a sparse draft that shows as "only the entities someone
 * touched".
 *
 * These drive the REAL startBridge (the bridgeBootFallback.test.ts /
 * bridgeNetworkRoute.test.ts pattern: repo-module seams spied, everything else
 * real), because the thing under test IS the boot sequence.
 */

// @vitest-environment jsdom
// jsdom, not node: startBridge's success path runs wireConnectionStatus(),
// which wires real window/document listeners; under node the bare `window`
// access throws inside startBridge's try and reads as a phantom boot failure.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateAutomergeUrl } from '@automerge/automerge-repo'
import * as repoModule from './repo'
import * as durableSyncModule from './durableSync'
import * as serverQueryModule from '../modelQuery/server'
import * as diagramMetaModule from '../modelQuery/diagramMeta'
import { fetchDiagramListPage } from '../modelQuery/diagrams'
import { DEFAULT_WORKSPACE_REF, type WorkspaceRef } from './workspace'
import { OVERLAY_WRITE_HEAD_VERSION } from './overlayWriteHead'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { getModelQuery, residentModelQuery, pagedModelQuery } from '../modelQuery'
import { isBootFromServerEnabled } from '../modelQuery/flag'
import { isServerReadModelEnabled } from '../modelQuery/tierFlag'
import { isWorkspaceSummaryActive } from '../modelQuery/summaryTier'

vi.mock('../modelQuery/kvStore', () => ({
  workspaceKvStore: () => ({
    get: async () => undefined,
    set: async () => undefined,
    del: async () => undefined,
    update: async () => undefined,
  }),
}))

// The summary boot asks the server for its first diagram. Answer an empty page
// locally: this suite is about which CONTRACT the boot enters, and a real fetch
// would only add a rejected request to every case.
vi.mock('../modelQuery/diagrams', () => ({
  fetchDiagramListPage: vi.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
}))

/** `doc` may be a value or a getter — the projection caches skip re-reading a
 * shard whose doc is reference-identical, so a test that models a remote change
 * has to hand out a NEW object, exactly as Automerge does. */
function fakeHandle<T>(documentId: string, doc: T | (() => T)) {
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const read = typeof doc === 'function' ? (doc as () => T) : () => doc
  return {
    documentId,
    url: `automerge:${documentId}`,
    doc: read,
    on: vi.fn((event: string, fn: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
    }),
    off: vi.fn((event: string, fn: (...args: any[]) => void) => {
      listeners.get(event)?.delete(fn)
    }),
    whenReady: vi.fn(async () => undefined),
    /** Test hook: fire what the repo would fire on a remote change. */
    emit: (event: string) => {
      for (const fn of listeners.get(event) ?? []) fn()
    },
  } as any
}

const META_URL = generateAutomergeUrl()
const OBJECT_HEAD_URL = generateAutomergeUrl()
const CONNECTION_HEAD_URL = generateAutomergeUrl()
const OBJECT_BASE_URL = generateAutomergeUrl()
const CONNECTION_BASE_URL = generateAutomergeUrl()
const REGISTRY_BASE_URL = generateAutomergeUrl()

/** A ModelMeta with USABLE overlay write heads → planBfsWriteMode 'bfs'. */
function usableMeta() {
  return {
    objectShardUrls: [OBJECT_BASE_URL],
    connectionShardUrls: [CONNECTION_BASE_URL],
    editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
    editsObjectShardUrl: OBJECT_HEAD_URL,
    editsConnectionShardUrl: CONNECTION_HEAD_URL,
    editsObjectShardUrls: [OBJECT_HEAD_URL],
    editsConnectionShardUrls: [CONNECTION_HEAD_URL],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    deletedObjectIds: [], deletedConnectionIds: [],
  }
}

/**
 * A ModelMeta with NO write heads AND a provably empty overlay — the shape
 * `planBfsWriteMode` answers `resident-fallback` for (fsck `model-write-head`,
 * the born-broken workspace).
 */
function headlessMeta() {
  return {
    objectShardUrls: [OBJECT_BASE_URL],
    connectionShardUrls: [CONNECTION_BASE_URL],
    editsObjectShardUrls: [],
    editsConnectionShardUrls: [],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    deletedObjectIds: [], deletedConnectionIds: [],
  }
}

function summaryRoot(meta: Record<string, unknown>) {
  return {
    root: fakeHandle('summary-root', {
      modelUrl: '',
      modelMetaUrl: META_URL,
      shardUrls: [REGISTRY_BASE_URL],
      registrySummaryOnly: true,
      diagramCount: 10_000,
    }),
    meta: fakeHandle('summary-meta', meta),
  }
}

function classicShardedRoot(meta: Record<string, unknown>) {
  return {
    root: fakeHandle('classic-root', {
      modelUrl: '',
      modelMetaUrl: META_URL,
      shardUrls: [REGISTRY_BASE_URL],
    }),
    meta: fakeHandle('classic-meta', meta),
  }
}

function registryShard(diagrams: Record<string, unknown>) {
  return fakeHandle(REGISTRY_BASE_URL.replace('automerge:', ''), { diagrams })
}

function diagramMeta(id: string, name: string) {
  return { id, name, type: 'context', docUrl: '', objectIds: [], connectionIds: [], groupIds: [] }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The write scheduler's `normal` trailing edge is 150 ms of REAL time. */
async function settleWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
  await settle()
}

describe('the summary boot contract is read from the ROOT, never from the build flags', () => {
  beforeEach(async () => {
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    const { __resetIndexReady } = await import('../modelQuery/offlineIndex')
    __resetIndexReady()
    // The flags live in localStorage in jsdom. Every case in this suite is about
    // a client that has NONE of them; the two that need one set it explicitly.
    localStorage.clear()
    useModelStore.setState({
      objects: [], connections: [], groups: [], diagrams: [],
      comments: [], flows: [], currentDiagramId: null,
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
    // Base model shards are never loaded on the paths under test; a spy keeps a
    // regression from quietly resolving real (non-existent) documents.
    vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('a summary root boots boot-from-server WITHOUT the VITE flags', async () => {
    // Without the `|| summaryRootAtBoot` term in bfsActive, this boot
    // goes classic, getRegistryShardHandles resolves the baseline registry
    // (the expensive load) and isBootFromServerActive() reads false.
    const { root, meta } = summaryRoot(usableMeta())
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta)
    const registry = vi.spyOn(repoModule, 'getRegistryShardHandles')
      .mockResolvedValue([registryShard({ d1: diagramMeta('d1', 'Baseline diagram') })])
    const model = vi.spyOn(repoModule, 'getModelHandle')

    // Anti-void guard: the point of this test is a client with NO flags. If the
    // env ever turns them on, the assertions below would pass for the wrong
    // reason.
    expect(isBootFromServerEnabled()).toBe(false)

    const { startBridge, isBootFromServerActive, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    expect(isBootFromServerActive()).toBe(true)
    expect(isRegistrySummaryOnlyActive()).toBe(true)
    // The baseline registry is never resolved on a summary boot…
    expect(registry).not.toHaveBeenCalled()
    // …and neither is the monolith.
    expect(model).not.toHaveBeenCalled()
    expect(useAutomergeStatus.getState().status).not.toBe('error')
  })

  it('summary switches BOTH halves: getModelQuery serves the server tier', async () => {
    // bootFromServer WITHOUT serverReadModel truncates the global views (e.g.
    // Model Connections showing 4 rows of 25), because the store holds only
    // the active diagram while getModelQuery still reads that store. Without
    // the isWorkspaceSummaryActive() term in tierFlag, getModelQuery falls
    // back to residentModelQuery and connectionPage never reaches the server.
    const { root, meta } = summaryRoot(usableMeta())
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([])
    const serverPage = vi.spyOn(serverQueryModule.serverModelQuery, 'connectionPage')
      .mockResolvedValue({ items: [], nextCursor: null, total: 25, projectionGeneration: 7 })

    // Both halves start OFF — no flag, no index.
    expect(isServerReadModelEnabled()).toBe(false)
    expect(getModelQuery()).toBe(residentModelQuery)

    const { startBridge, stopBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    // Half 1: the read path is the paged/server tier, not the resident store.
    expect(isWorkspaceSummaryActive()).toBe(true)
    expect(isServerReadModelEnabled()).toBe(true)
    expect(getModelQuery()).toBe(pagedModelQuery)

    // Half 2, the one that matters: a global view really is
    // answered by the SERVER, with the server's total — not by a windowed local
    // rung reporting a smaller one.
    const page = await getModelQuery().connectionPage({ limit: 50 })
    expect(serverPage).toHaveBeenCalledTimes(1)
    expect(page.total).toBe(25)

    // …and the contract is per SESSION: stopBridge puts the tier back.
    stopBridge()
    expect(isWorkspaceSummaryActive()).toBe(false)
    expect(isServerReadModelEnabled()).toBe(false)
    expect(getModelQuery()).toBe(residentModelQuery)
  })

  it('L6 unusable heads on a summary root degrade to bfs-degraded, never resident', async () => {
    // The write-head guard downgrades an unusable-write-head workspace to the resident
    // path because "base shards are the whole model". On a SUMMARY root they are
    // not: the baseline is in the read model, the base shards are fenced for
    // writes server-side, and reaching them costs the full registry load. With
    // the downgrade applied to summary roots, bfsActive would flip false, the
    // boot would re-enter the full editable registry and call
    // getRegistryShardHandles.
    const { root, meta } = summaryRoot(headlessMeta())
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta)
    const registry = vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([])

    const { startBridge, isBootFromServerActive, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    // Asserted FIRST because it is the measurable half: a downgrade would put
    // the full editable registry load back on the boot path (~78 s at 10k
    // diagrams).
    expect(registry).not.toHaveBeenCalled()
    expect(isBootFromServerActive()).toBe(true)
    expect(isRegistrySummaryOnlyActive()).toBe(true)
  })

  it('the SAME headless meta still downgrades to resident on an ORDINARY root', async () => {
    // The control for the case above, and the guard against a void run: it
    // proves the fixture really does reach `resident-fallback`. If this ever
    // stops downgrading, the previous test is asserting nothing.
    localStorage.setItem('maplespire:bootFromServer', 'true')
    const ref: WorkspaceRef = { landscapeId: 'ordinary-headless', versionId: 'current' }
    const { root, meta } = classicShardedRoot(headlessMeta())
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([])

    const { startBridge, isBootFromServerActive } = await import('./bridge')
    await startBridge(ref)

    expect(isBootFromServerEnabled()).toBe(true) // the flag IS on here
    expect(isBootFromServerActive()).toBe(false) // …and the write-head guard still overrode it
  })

  it('a live promotion flips the classic tab to banner+reload, never a hot re-switch', async () => {
    // Two tabs, one promoted workspace: the classic tab's rootChangeHandler must
    // stop reconciling the moment `registrySummaryOnly` ARRIVES. Reconciling is
    // the dangerous verb — projectAll + the registry write pass would push a
    // WINDOWED store back into a baseline the server has just fenced. Without
    // the epoch guard the tab keeps reconciling (d3 lands in the store) and
    // nothing ever tells the user.
    const ref: WorkspaceRef = { landscapeId: 'promoted-live', versionId: 'current' }
    const rootDoc: Record<string, unknown> = {
      modelUrl: '',
      modelMetaUrl: META_URL,
      shardUrls: [REGISTRY_BASE_URL],
    }
    const root = fakeHandle('live-root', rootDoc)
    const meta = fakeHandle('live-meta', usableMeta())
    let shardDoc: { diagrams: Record<string, unknown> } = {
      diagrams: { d1: diagramMeta('d1', 'One') },
    }
    const publishDiagram = (id: string, name: string) => {
      shardDoc = { diagrams: { ...shardDoc.diagrams, [id]: diagramMeta(id, name) } }
    }
    const shard = fakeHandle(REGISTRY_BASE_URL.replace('automerge:', ''), () => shardDoc)
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([shard])

    const { startBridge, isBootFromServerActive } = await import('./bridge')
    await startBridge(ref)
    // A classic session: no flags, an ordinary root.
    expect(isBootFromServerActive()).toBe(false)
    expect(useModelStore.getState().diagrams.map((d) => d.id)).toEqual(['d1'])

    // Control — BEFORE the promotion the handler really does reconcile. Without
    // this the test could pass against a handler that was never attached.
    publishDiagram('d2', 'Two')
    root.emit('change')
    await settle()
    expect(useModelStore.getState().diagrams.map((d) => d.id)).toEqual(['d1', 'd2'])
    expect(useAutomergeStatus.getState().workspaceContractStale).toBe(false)

    // The promotion lands on the root while this session is live.
    rootDoc.registrySummaryOnly = true
    publishDiagram('d3', 'Three')
    root.emit('change')
    await settle()

    // Frozen: no hot re-switch, and no reconcile either.
    expect(useModelStore.getState().diagrams.map((d) => d.id)).toEqual(['d1', 'd2'])
    expect(isBootFromServerActive()).toBe(false)
    expect(isWorkspaceSummaryActive()).toBe(false)
    // And it is VISIBLE — a frozen session that says nothing is the
    // silent-failure class.
    expect(useAutomergeStatus.getState().workspaceContractStale).toBe(true)
  })

  it('the promotion freezes the verb that WRITES: no store edit reaches the baseline registry shards', async () => {
    // The epoch guard's own `return` only stops a PROJECTION. The verb that
    // writes is `flushWrite`, whose registry pass re-places every diagram meta
    // into the shards the server has just fenced — and a classic session
    // journals nothing (the entity-intent capture is gated `bfsActive`), so
    // those refused writes would be lost with no trace and no badge. Without
    // the `contractFrozen` reads in flushWrite, the post-promotion rename
    // reconciles the shard again and the last expectation fails.
    const ref: WorkspaceRef = { landscapeId: 'promoted-writes', versionId: 'current' }
    const rootDoc: Record<string, unknown> = {
      modelUrl: '',
      modelMetaUrl: META_URL,
      shardUrls: [REGISTRY_BASE_URL],
    }
    const root = fakeHandle('write-root', rootDoc)
    const meta = fakeHandle('write-meta', usableMeta())
    const shardDoc = { diagrams: { d1: diagramMeta('d1', 'One') } }
    const shard = fakeHandle(REGISTRY_BASE_URL.replace('automerge:', ''), () => shardDoc)
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([shard])
    // Intercept the ONE function every Automerge write in the bridge goes
    // through, so "did a change reach this document" is answerable by identity
    // and no fake handle has to pretend to be a real Automerge doc.
    const change = vi.spyOn(durableSyncModule, 'changeWithDurabilityTracking')
      .mockImplementation(() => undefined)
    const reachedRegistry = () => change.mock.calls.some(([handle]) => handle === shard)

    const { startBridge } = await import('./bridge')
    await startBridge(ref)

    const rename = (name: string) => {
      const diagrams = useModelStore.getState().diagrams
      useModelStore.setState({ diagrams: diagrams.map((d) => d.id === 'd1' ? { ...d, name } : d) })
    }

    // Control, and the anti-void guard: BEFORE the promotion this exact edit
    // really does reconcile the baseline shard. Without it the test could pass
    // against a flushWrite that never ran at all.
    change.mockClear()
    rename('One renamed')
    await settleWrites()
    expect(reachedRegistry()).toBe(true)

    // The promotion lands while the session is live.
    rootDoc.registrySummaryOnly = true
    root.emit('change')
    await settle()
    expect(useAutomergeStatus.getState().workspaceContractStale).toBe(true)

    change.mockClear()
    rename('One renamed again')
    await settleWrites()
    expect(reachedRegistry()).toBe(false)
  })

  it('a summary root whose ModelMeta never resolves fails the boot honestly, never downgrades to the resident registry', async () => {
    // Downgrading here would be three failures at once: the full registry load
    // back on the boot path, a resident tier over model documents that were
    // never loaded, and a `flushWrite` that bails at its `!modelHandle` guard —
    // so the durable ack would read "nothing tracked" and the badge would say
    // "Synced" over a session that can save nothing. A
    // `setRegistrySummaryOnly(false)` + getRegistryShardHandles downgrade fails
    // the registry expectation FIRST.
    const ref: WorkspaceRef = { landscapeId: 'summary-metaless', versionId: 'current' }
    const { root } = summaryRoot(usableMeta())
    // A meta handle that is ready but carries NO snapshot — `ensureModelSharded`
    // returns false for it, which is the live shape (the document exists in the
    // root's url but never materialized).
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(fakeHandle('empty-meta', undefined))
    const registry = vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([])

    const { startBridge, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge(ref)

    // Asserted FIRST: a downgrade re-materializes the full editable registry,
    // the cost the summary contract exists to remove.
    expect(registry).not.toHaveBeenCalled()
    expect(useAutomergeStatus.getState().status).toBe('error')
    expect(useAutomergeStatus.getState().error).toContain('registrySummaryOnly')
    // …and the tier is retracted with the failed boot — a dead session must not
    // leave getModelQuery() pointed at `ro_*`.
    expect(isRegistrySummaryOnlyActive()).toBe(false)
    expect(isWorkspaceSummaryActive()).toBe(false)
    expect(getModelQuery()).toBe(residentModelQuery)
  })

  it('a summary root with no modelMetaUrl fails the boot instead of silently booting classic', async () => {
    // The other door into the same hole. `bfsActive` is `(flag || root) &&
    // workspaceSharded`, so without an explicit refusal an unsharded summary
    // root would fall through to a classic boot with `registrySummaryOnly`
    // never set, beyond the reach of the guard above.
    //
    // Without the refusal the boot still fails in THIS fixture (`Failed to
    // fetch root url: HTTP 401`, from the rebound machinery), so
    // `status === 'error'` alone does NOT discriminate. The MESSAGE does: the
    // failure must name the contract rather than read as a bad reference,
    // because the rebounds an incidental failure goes through can silently
    // move the user to another landscape.
    const ref: WorkspaceRef = { landscapeId: 'summary-monolith', versionId: 'current' }
    const root = fakeHandle('summary-unsharded-root', {
      modelUrl: '',
      shardUrls: [REGISTRY_BASE_URL],
      registrySummaryOnly: true,
    })
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root)
    const registry = vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([])

    const { startBridge } = await import('./bridge')
    await startBridge(ref)

    expect(registry).not.toHaveBeenCalled()
    expect(useAutomergeStatus.getState().status).toBe('error')
    expect(useAutomergeStatus.getState().error).toContain('modelMetaUrl')
  })

  it('a re-boot does not inherit the banner, and a promotion on the SECOND workspace still announces itself', async () => {
    // Both directions. `AutomergeBridge` stops and re-boots the bridge on every
    // change of [config, loading, user, orgId] — an org switch, an auth refresh
    // — not only through `beginWorkspaceSwitch`. Without the store clear in
    // stopBridge the first expectation fails (phantom banner); without the
    // module-variable reset the second workspace's promotion is deduped away
    // and the last two fail (a freeze with no warn and no banner).
    const promotable = (label: string) => {
      const rootDoc: Record<string, unknown> = {
        modelUrl: '', modelMetaUrl: META_URL, shardUrls: [REGISTRY_BASE_URL],
      }
      return { rootDoc, root: fakeHandle(label, rootDoc) }
    }
    const first = promotable('ws-a-root')
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(first.root)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(fakeHandle('ws-meta', usableMeta()))
    vi.spyOn(repoModule, 'getRegistryShardHandles')
      .mockResolvedValue([registryShard({ d1: diagramMeta('d1', 'One') })])

    const { startBridge, stopBridge } = await import('./bridge')
    await startBridge({ landscapeId: 'ws-a', versionId: 'current' })
    first.rootDoc.registrySummaryOnly = true
    first.root.emit('change')
    await settle()
    expect(useAutomergeStatus.getState().workspaceContractStale).toBe(true)

    // Direction 1: the session that owned the marker is gone, so the marker goes.
    stopBridge()
    expect(useAutomergeStatus.getState().workspaceContractStale).toBe(false)

    // Direction 2: the NEXT workspace must still be able to announce its own
    // promotion — an inherited armed latch would silently swallow it.
    const second = promotable('ws-b-root')
    vi.mocked(repoModule.getRootHandle).mockResolvedValue(second.root)
    const warn = vi.mocked(console.warn)
    await startBridge({ landscapeId: 'ws-b', versionId: 'current' })
    expect(useAutomergeStatus.getState().workspaceContractStale).toBe(false)
    warn.mockClear()
    second.rootDoc.registrySummaryOnly = true
    second.root.emit('change')
    await settle()
    expect(useAutomergeStatus.getState().workspaceContractStale).toBe(true)
    expect(warn.mock.calls.some(([message]) => String(message).includes('promoted to a server-registry'))).toBe(true)
  })

  it('an ordinary workspace with no flags stays fully resident — zero new cost', async () => {
    // Non-regression: the root-driven term must add nothing for the workspaces
    // that are not summary. If bfsActive/summary were unconditional, the
    // ordinary boot would stop loading its registry and its global reads would
    // go to a server read model this deployment may not even run.
    const ref: WorkspaceRef = { landscapeId: 'ordinary-plain', versionId: 'current' }
    const { root, meta } = classicShardedRoot(usableMeta())
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta)
    const registry = vi.spyOn(repoModule, 'getRegistryShardHandles')
      .mockResolvedValue([registryShard({ d1: diagramMeta('d1', 'One') })])

    const { startBridge, isBootFromServerActive, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge(ref)

    expect(isBootFromServerActive()).toBe(false)
    expect(isRegistrySummaryOnlyActive()).toBe(false)
    expect(registry).toHaveBeenCalled()
    expect(isWorkspaceSummaryActive()).toBe(false)
    expect(isServerReadModelEnabled()).toBe(false)
    expect(getModelQuery()).toBe(residentModelQuery)
  })

  it('an ordinary workspace WITH the flag still boots from the server, and stays off the summary contract', async () => {
    // The other half of the non-regression: the flag path is untouched, and it
    // does NOT get the summary tier for free — pairing serverReadModel with
    // bootFromServer stays the operator's explicit choice for ordinary
    // workspaces.
    localStorage.setItem('maplespire:bootFromServer', 'true')
    const ref: WorkspaceRef = { landscapeId: 'ordinary-flagged', versionId: 'current' }
    const { root, meta } = classicShardedRoot(usableMeta())
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root)
    vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([])

    const { startBridge, isBootFromServerActive, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge(ref)

    expect(isBootFromServerActive()).toBe(true)
    expect(isRegistrySummaryOnlyActive()).toBe(false)
    expect(isWorkspaceSummaryActive()).toBe(false)
    expect(isServerReadModelEnabled()).toBe(false)
  })

  /**
   * Defect 2026-10-16 (draft create/merge left the viewed diagram), summary
   * half: a Draft switch parks the viewed diagram as a PREFERENCE. On a summary
   * root the registry is not resident, so existence is the server's answer
   * (`fetchDiagramMeta` → undefined). The resident half is in
   * bridgePreferredDiagram.test.ts.
   */
  describe('a preferred diagram on a summary root', () => {
    async function bootSummaryParked(parked: string, prefer: boolean, served: string[]) {
      const { root, meta } = summaryRoot(usableMeta())
      vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root)
      vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta)
      vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([])
      vi.mocked(fetchDiagramListPage).mockResolvedValue({
        items: [{ id: 'server-first' }], nextCursor: null, total: 1,
      } as any)
      vi.spyOn(diagramMetaModule, 'fetchDiagramMeta').mockImplementation(async (id: string) =>
        served.includes(id)
          ? { meta: diagramMeta(id, id), diagram: diagramMeta(id, id), comments: [], flows: [] } as any
          : undefined)
      const { startBridge, preferInitialDiagram } = await import('./bridge')
      useModelStore.setState({ currentDiagramId: parked })
      preferInitialDiagram(prefer ? parked : null)
      await startBridge(DEFAULT_WORKSPACE_REF)
      return useModelStore.getState().currentDiagramId
    }

    afterEach(async () => {
      const { preferInitialDiagram } = await import('./bridge')
      preferInitialDiagram(null)
      vi.mocked(fetchDiagramListPage).mockResolvedValue({ items: [], nextCursor: null, total: 0 } as any)
    })

    it('is opened when the server has it — and asked about once, not twice', async () => {
      expect(await bootSummaryParked('viewed', true, ['viewed', 'server-first'])).toBe('viewed')
      // The existence check and the open share one diagram-meta request.
      const asked = vi.mocked(diagramMetaModule.fetchDiagramMeta).mock.calls.filter(([id]) => id === 'viewed')
      expect(asked).toHaveLength(1)
    })

    it('falls back to the server first page when the version lacks it', async () => {
      expect(await bootSummaryParked('made-in-the-draft', true, ['server-first'])).toBe('server-first')
    })

    it('a diagram-meta FAILURE (offline, warming-up 503) falls back and the boot still completes', async () => {
      // Reviewer finding: keeping the park on an unknown answer made the open
      // await the rejected request outside any try, so exiting a Draft while
      // the server was down failed the whole boot.
      const { root, meta } = summaryRoot(usableMeta())
      vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(root)
      vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta)
      vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([])
      vi.mocked(fetchDiagramListPage).mockResolvedValue({
        items: [{ id: 'server-first' }], nextCursor: null, total: 1,
      } as any)
      vi.spyOn(diagramMetaModule, 'fetchDiagramMeta').mockImplementation(async (id: string) => {
        if (id === 'viewed') throw new Error('diagram-meta API -> HTTP 503')
        return { meta: diagramMeta(id, id), diagram: diagramMeta(id, id), comments: [], flows: [] } as any
      })
      const { startBridge, preferInitialDiagram } = await import('./bridge')
      useModelStore.setState({ currentDiagramId: 'viewed' })
      preferInitialDiagram('viewed')
      await startBridge(DEFAULT_WORKSPACE_REF)
      expect(useAutomergeStatus.getState().status).not.toBe('error')
      expect(useModelStore.getState().currentDiagramId).toBe('server-first')
    })

    it('control: a REQUESTED (deep-linked) missing diagram stays parked', async () => {
      expect(await bootSummaryParked('made-in-the-draft', false, ['server-first'])).toBe('made-in-the-draft')
    })
  })
})
