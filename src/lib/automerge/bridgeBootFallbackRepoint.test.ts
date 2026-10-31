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
 * A binding frame that arrives DURING a boot, through the REAL startBridge.
 *
 * The bridge installs its repoint detector (`onWorkspaceBound`) only at the end
 * of a successful boot (`wireConnectionStatus`), and a boot's own socket
 * usually binds long before that. A boot that FALLS BACK to the cached root
 * re-enters without reconnecting, so the frame its socket sent is the only one
 * there will be until some later reconnect. `workspaceBinding.ts` keeps it and
 * replays it on install; these tests check that the bridge then does what its
 * policy says, in the three situations where it matters:
 *
 *  1. a fallback session whose socket is bound to the new default HOLDS on the
 *     cached root's version (and says why);
 *  2. a session that did not fall back still FOLLOWS when nothing is unsaved —
 *     the fallback rule is not a blanket "always hold";
 *  3. a FOLLOW whose own boot falls back: that boot's frame is replayed while
 *     the follow is still in flight, handed back, and re-offered once it ends.
 *
 * The bridgeBootFallback.test.ts harness: repo seams spied, everything else
 * real. The frame is noted from inside the mocked root resolution, which is
 * where a socket's frame lands in production (the socket is routed before the
 * root is fetched); `switchWorkspace` is mocked so a FOLLOW is observable.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { DocumentTemporarilyUnavailableError } from './documentResolution'
import { OVERLAY_WRITE_HEAD_VERSION } from './overlayWriteHead'
import { setActiveWorkspaceRef, type WorkspaceRef } from './workspace'
import {
  __resetResolvedWorkspacesForTest,
  __resetWorkspaceBindingFramesForTest,
  forgetWorkspaceBindingFrom,
  heldWorkspace,
  holdWorkspaceOn,
  noteWorkspaceBinding,
  rememberResolvedWorkspace,
  resolvedWorkspaceFor,
} from './workspaceBinding'
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

vi.mock('./switchWorkspace', () => ({ reloadWorkspace: vi.fn(async () => undefined) }))

// Unsaved work, on demand: `pendingDurabilityCount()` sums these debts, and the
// policy reads it when the frame is delivered. Pass-through by default.
const debts = vi.hoisted(() => ({ extra: 0 }))
vi.mock('./durableSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./durableSync')>()
  return {
    ...actual,
    pendingDurabilityDebts: (input: Parameters<typeof actual.pendingDurabilityDebts>[0]) =>
      actual.pendingDurabilityDebts(input) + debts.extra,
  }
})

// Boot-from-server reads, for the prefetch case at the bottom (the
// bridgeBfsDocUrl.test.ts mocks). The classic cases never reach them.
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

const REF: WorkspaceRef = { landscapeId: 'L1', versionId: 'current' }
const V1 = { landscapeId: 'L1', versionId: 'V1' }
const V2 = { landscapeId: 'L1', versionId: 'V2' }

function fakeHandle<T>(documentId: string, doc: T) {
  return {
    documentId,
    url: `automerge:${documentId}`,
    doc: () => doc,
    on: vi.fn(),
    off: vi.fn(),
    whenReady: vi.fn(async () => undefined),
  } as any
}

/** The cached V1 graph a fallback boot resolves from IndexedDB (see
 * bridgeBootFallback.test.ts for why the docUrl is empty). */
function cachedV1Graph() {
  const rootHandle = fakeHandle('v1-root', { modelUrl: 'automerge:v1-model', shardUrls: ['automerge:v1-shard'] })
  const modelHandle = fakeHandle('v1-model', {
    objects: {
      o1: {
        id: 'o1', type: 'system', name: 'Local system',
        position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
        tagAssignments: {}, tagOrder: [], properties: {}, scope: 'internal', status: 'live',
      },
    },
    connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const shardHandle = fakeHandle('v1-shard', {
    diagrams: {
      d1: { id: 'd1', name: 'Local diagram', type: 'context', docUrl: '', objectIds: ['o1'], connectionIds: [], groupIds: [] },
    },
  })
  return { rootHandle, modelHandle, shardHandle }
}

const unanswered = () => new DocumentTemporarilyUnavailableError('automerge:v2-root', 3)

function handlerInstalled(): boolean {
  return Boolean((window as any).__workspaceBinding?.handlerInstalled?.())
}

/**
 * Root resolutions, in order, for one boot that FALLS BACK: the new default's
 * root never arrives (its socket bound to V2 meanwhile, from `socket`), then
 * the cached V1 root resolves with the record kept beside it — what
 * `fetchRootUrl`'s two paths do (`root-fetch`, then `root-cache`).
 */
function fallbackBoot(getRoot: ReturnType<typeof vi.spyOn>, rootHandle: unknown, socket: object, seen: string[]) {
  getRoot
    .mockImplementationOnce(async () => {
      rememberResolvedWorkspace(REF, V2, { from: 'root-fetch', rootUrl: 'automerge:v2-root' })
      seen.push(`frame noted, handler installed: ${handlerInstalled()}`)
      noteWorkspaceBinding(V2, socket)
      throw unanswered()
    })
    .mockImplementationOnce(async () => {
      rememberResolvedWorkspace(REF, V1, { from: 'root-cache', rootUrl: 'automerge:v1-root' })
      return rootHandle
    })
}

describe('a binding frame that arrived during the boot', () => {
  beforeEach(async () => {
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    setActiveWorkspaceRef(REF)
    useModelStore.setState({
      objects: [], connections: [], groups: [], diagrams: [],
      comments: [], flows: [], currentDiagramId: null,
    })
    useAutomergeStatus.setState({
      status: 'connecting', ready: false, visualReady: false, editReady: false,
      projectedWorkspace: null, error: null, bootFallbackActive: false, workspaceRepointNotice: null,
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { modelHandle, shardHandle } = cachedV1Graph()
    vi.spyOn(repoModule, 'getModelHandle').mockResolvedValue(modelHandle)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([shardHandle])
    vi.spyOn(repoModule, 'preferCachedRootForNextResolve').mockReturnValue(undefined)
    vi.spyOn(repoModule, 'forgetWorkspaceHandles').mockReturnValue(undefined)
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue('automerge:v1-root')
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue('automerge:v2-root')
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    holdWorkspaceOn(null)
    __resetResolvedWorkspacesForTest()
    __resetWorkspaceBindingFramesForTest()
    const { reloadWorkspace } = await import('./switchWorkspace')
    vi.mocked(reloadWorkspace).mockReset()
    debts.extra = 0
    vi.restoreAllMocks()
  })

  it('outside a fallback, a disagreeing frame with UNSAVED work HOLDS, and says unsaved work', async () => {
    const route = vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    const { rootHandle } = cachedV1Graph()
    vi.spyOn(repoModule, 'getRootHandle').mockImplementationOnce(async () => {
      rememberResolvedWorkspace(REF, V1, { from: 'root-fetch', rootUrl: 'automerge:v1-root' })
      noteWorkspaceBinding(V2, { name: 'boot socket' })
      return rootHandle
    })
    const { reloadWorkspace } = await import('./switchWorkspace')
    debts.extra = 1
    const { startBridge } = await import('./bridge')
    await startBridge(REF)

    expect(useAutomergeStatus.getState().bootFallbackActive).toBe(false)
    await vi.waitFor(() => expect(heldWorkspace()).toEqual(V1))
    expect(route).toHaveBeenCalledWith(V1, true)
    expect(reloadWorkspace).not.toHaveBeenCalled()
    expect(useAutomergeStatus.getState().workspaceRepointNotice).toEqual({
      landscapeId: 'L1', pinnedVersionId: 'V1', reason: 'unsaved-work',
    })
  })

  it('a fallback session that ALSO has unsaved work names the fallback', async () => {
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    fallbackBoot(vi.spyOn(repoModule, 'getRootHandle'), cachedV1Graph().rootHandle, { name: 'boot socket' }, [])
    debts.extra = 1
    const { startBridge } = await import('./bridge')
    await startBridge(REF)

    expect(useAutomergeStatus.getState().bootFallbackActive).toBe(true)
    expect(heldWorkspace()).toEqual(V1)
    expect(useAutomergeStatus.getState().workspaceRepointNotice?.reason).toBe('boot-fallback')
  })

  it('is delivered once the fallback session is up, and HOLDS it on the cached root\'s version', async () => {
    const route = vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    const getRoot = vi.spyOn(repoModule, 'getRootHandle')
    const seen: string[] = []
    fallbackBoot(getRoot, cachedV1Graph().rootHandle, { name: 'boot socket' }, seen)
    const { reloadWorkspace } = await import('./switchWorkspace')

    const { startBridge } = await import('./bridge')
    await startBridge(REF)

    // The precondition this whole test is about: the frame met no handler.
    expect(seen).toEqual(['frame noted, handler installed: false'])
    expect(getRoot).toHaveBeenCalledTimes(2)
    expect(useAutomergeStatus.getState().bootFallbackActive).toBe(true)

    // HELD on V1, the version of the root this session actually holds — not
    // followed: following re-asks the server for the root that just failed.
    expect(heldWorkspace()).toEqual(V1)
    expect(route).toHaveBeenCalledWith(V1, true)
    expect(reloadWorkspace).not.toHaveBeenCalled()
    expect(useAutomergeStatus.getState().workspaceRepointNotice).toEqual({
      landscapeId: 'L1', pinnedVersionId: 'V1', reason: 'boot-fallback',
    })
  })

  it('a fallback session holds only for the version that failed: a LATER repoint elsewhere follows', async () => {
    // Reviewer lens, 2026-10-29: `bootFallbackActive` lasts the whole session.
    // Here the fallback was a slow server, not a repoint — the root that failed
    // is V1's own — and an admin later repoints to V2. Holding would keep the
    // tab off the new default under a banner saying V2 "could not be loaded",
    // though nobody tried.
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    const { rootHandle } = cachedV1Graph()
    const socket = { name: 'boot socket' }
    vi.spyOn(repoModule, 'getRootHandle')
      .mockImplementationOnce(async () => {
        rememberResolvedWorkspace(REF, V1, { from: 'root-fetch', rootUrl: 'automerge:v2-root' })
        noteWorkspaceBinding(V1, socket)
        throw unanswered()
      })
      .mockImplementationOnce(async () => {
        rememberResolvedWorkspace(REF, V1, { from: 'root-cache', rootUrl: 'automerge:v1-root' })
        return rootHandle
      })
    const { reloadWorkspace } = await import('./switchWorkspace')
    const { startBridge } = await import('./bridge')
    await startBridge(REF)
    expect(useAutomergeStatus.getState().bootFallbackActive).toBe(true)
    expect(heldWorkspace(), 'the boot\'s own frame agreed').toBeNull()

    noteWorkspaceBinding(V2, socket)

    await vi.waitFor(() => expect(reloadWorkspace).toHaveBeenCalledTimes(1))
    expect(heldWorkspace()).toBeNull()
    expect(useAutomergeStatus.getState().workspaceRepointNotice).toBeNull()
  })

  it('a fallback whose failed version is UNKNOWN (no key from the server) holds — the side that cannot loop', async () => {
    const route = vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    const { rootHandle } = cachedV1Graph()
    vi.spyOn(repoModule, 'getRootHandle')
      .mockImplementationOnce(async () => {
        // The root fetch reported no canonical key: no basis names the root
        // that is about to fail.
        noteWorkspaceBinding(V2, { name: 'boot socket' })
        throw unanswered()
      })
      .mockImplementationOnce(async () => {
        rememberResolvedWorkspace(REF, V1, { from: 'root-cache', rootUrl: 'automerge:v1-root' })
        return rootHandle
      })
    const { reloadWorkspace } = await import('./switchWorkspace')
    const { startBridge } = await import('./bridge')
    await startBridge(REF)

    expect(heldWorkspace()).toEqual(V1)
    expect(route).toHaveBeenCalledWith(V1, true)
    expect(reloadWorkspace).not.toHaveBeenCalled()
    expect(useAutomergeStatus.getState().workspaceRepointNotice?.reason).toBe('boot-fallback')
  })

  it('outside a fallback, a disagreeing frame from the boot still FOLLOWS when nothing is unsaved', async () => {
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    const { rootHandle } = cachedV1Graph()
    const seen: string[] = []
    // The repoint landed between the root fetch (V1) and the socket's bind (V2).
    vi.spyOn(repoModule, 'getRootHandle').mockImplementationOnce(async () => {
      rememberResolvedWorkspace(REF, V1, { from: 'root-fetch', rootUrl: 'automerge:v1-root' })
      seen.push(`frame noted, handler installed: ${handlerInstalled()}`)
      noteWorkspaceBinding(V2, { name: 'boot socket' })
      return rootHandle
    })
    const { reloadWorkspace } = await import('./switchWorkspace')

    const { startBridge } = await import('./bridge')
    await startBridge(REF)

    expect(seen).toEqual(['frame noted, handler installed: false'])
    expect(useAutomergeStatus.getState().bootFallbackActive).toBe(false)
    await vi.waitFor(() => expect(reloadWorkspace).toHaveBeenCalledTimes(1))
    expect(heldWorkspace()).toBeNull()
    // The follow cleared the basis first (`forgetResolvedWorkspace`).
    expect(resolvedWorkspaceFor(REF)).toBeNull()
  })

  it('a FOLLOW whose own boot falls back: that boot\'s frame waits out the follow, then HOLDS', async () => {
    const route = vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    const { rootHandle } = cachedV1Graph()
    const getRoot = vi.spyOn(repoModule, 'getRootHandle')
    const seen: string[] = []
    const liveSocket = { name: 'live socket' }
    // Session 1: a live tab on V1, whose socket reconnects bound to V2.
    getRoot.mockImplementationOnce(async () => {
      rememberResolvedWorkspace(REF, V1, { from: 'root-fetch', rootUrl: 'automerge:v1-root' })
      noteWorkspaceBinding(V2, liveSocket)
      return rootHandle
    })
    const { reloadWorkspace } = await import('./switchWorkspace')
    const { startBridge, stopBridge } = await import('./bridge')
    // The follow: what `loadWorkspace` does, minus the store reset — the hold
    // ends, the bridge stops, a forced route supersedes the live socket, and
    // the bridge boots again. That boot falls back.
    vi.mocked(reloadWorkspace).mockImplementationOnce(async () => {
      holdWorkspaceOn(null)
      stopBridge()
      forgetWorkspaceBindingFrom(liveSocket)
      fallbackBoot(getRoot, rootHandle, { name: 'follow socket' }, seen)
      await startBridge(REF)
      seen.push(`follow's boot done, held: ${JSON.stringify(heldWorkspace())}`)
    })

    await startBridge(REF)
    await vi.waitFor(() => expect(heldWorkspace()).toEqual(V1))

    expect(reloadWorkspace).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([
      'frame noted, handler installed: false',
      // Replayed inside the follow, and handed back rather than acted on —
      // the follow was still in flight.
      'follow\'s boot done, held: null',
    ])
    expect(route).toHaveBeenLastCalledWith(V1, true)
    expect(useAutomergeStatus.getState().workspaceRepointNotice?.reason).toBe('boot-fallback')
  })

  it('the fallback re-entry asks for no render before its root: before the root, a read asks the alias', async () => {
    // Boot-from-server, deep-linked onto a diagram: the first boot prefetches
    // its render beside the root. The re-entry must not — on that path the
    // alias is the new default whose graph just failed to arrive (N3).
    localStorage.setItem('maplespire:bootFromServer', 'true')
    try {
      vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
      const { root } = bfsGraph()
      const events: string[] = []
      reads.fetchDiagramRender.mockImplementation(async () => {
        events.push('render')
        throw new Error('offline in this test')
      })
      reads.fetchDiagramMeta.mockImplementation(async () => {
        events.push('meta')
        return undefined
      })
      reads.fetchDiagramListPage.mockResolvedValue({ items: [], nextCursor: null, total: 0 })
      vi.spyOn(repoModule, 'getRootHandle')
        .mockImplementationOnce(async () => {
          events.push('root (new default)')
          throw unanswered()
        })
        .mockImplementationOnce(async () => {
          events.push('root (cached)')
          return root
        })
      useModelStore.setState({ currentDiagramId: 'd1' })

      const { startBridge } = await import('./bridge')
      await startBridge(REF)

      const fellBack = events.indexOf('root (cached)')
      expect(fellBack, `events: ${events.join(' > ')}`).toBeGreaterThan(0)
      // THE CONTROL: the first boot did prefetch, so the rule below is not
      // satisfied by a boot that never prefetches at all.
      expect(events.slice(0, events.indexOf('root (new default)'))).toEqual(['render', 'meta'])
      expect(events.slice(events.indexOf('root (new default)') + 1, fellBack), `events: ${events.join(' > ')}`)
        .toEqual([])
    } finally {
      localStorage.removeItem('maplespire:bootFromServer')
    }
  })

  it('two OVERLAPPING boots that fail: only the live one falls back, and its re-entry is a working session', async () => {
    // React StrictMode's dev double-mount (and any re-run of AutomergeBridge's
    // effect): boot A starts, is stopped, boot B starts, and both await the
    // same root. Measured 2026-10-29 on the dev stack: A's catch fell back and
    // re-entered, then B's catch — refused as "already fell back" — set
    // `started = false` under that re-entry, whose boot-from-server
    // projections then all returned early: the canvas read "No diagrams yet".
    localStorage.setItem('maplespire:bootFromServer', 'true')
    try {
      vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
      const { root } = bfsGraph({ withDiagram: true })
      reads.fetchDiagramRender.mockResolvedValue({
        projectionGeneration: 1, objects: [LOCAL_OBJECT], connections: [], groups: [],
      })
      reads.fetchDiagramMeta.mockResolvedValue(undefined)
      reads.fetchDiagramListPage.mockResolvedValue({ items: [], nextCursor: null, total: 0 })
      let failRoot: (error: unknown) => void = () => undefined
      const sharedRoot = new Promise<never>((_, reject) => { failRoot = reject })
      sharedRoot.catch(() => undefined)
      const getRoot = vi.spyOn(repoModule, 'getRootHandle')
        .mockReturnValueOnce(sharedRoot)
        .mockReturnValueOnce(sharedRoot)
        .mockResolvedValue(root)
      useModelStore.setState({ currentDiagramId: 'd1' })

      const { startBridge, stopBridge } = await import('./bridge')
      const bootA = startBridge(REF)
      stopBridge()
      const bootB = startBridge(REF)
      await vi.waitFor(() => expect(getRoot).toHaveBeenCalledTimes(2))
      failRoot(unanswered())
      await Promise.all([bootA, bootB])

      // ONE fallback, by the live boot; the stopped one recovered nothing.
      expect(repoModule.preferCachedRootForNextResolve).toHaveBeenCalledTimes(1)
      expect(getRoot).toHaveBeenCalledTimes(3)
      // And the re-entry's session is whole: projected, the detour shown.
      await vi.waitFor(() => expect(
        useModelStore.getState().objects.map((o) => o.id),
        JSON.stringify({
          current: useModelStore.getState().currentDiagramId,
          diagrams: useModelStore.getState().diagrams.map((d) => d.id),
          renders: reads.fetchDiagramRender.mock.calls.map((c) => c[0]),
          status: useAutomergeStatus.getState().status,
          error: useAutomergeStatus.getState().error,
          warns: vi.mocked(console.warn).mock.calls.map((c) => String(c[0]).slice(0, 120)),
          errors: vi.mocked(console.error).mock.calls.map((c) => String(c[0]).slice(0, 120) + ' ' + String(c[1]).slice(0, 160)),
        }),
      ).toEqual(['o1']))
      expect(useModelStore.getState().diagrams.map((d) => d.id)).toEqual(['d1'])
      const status = useAutomergeStatus.getState()
      expect(status.status).not.toBe('error')
      expect(status.bootFallbackActive).toBe(true)
    } finally {
      localStorage.removeItem('maplespire:bootFromServer')
    }
  })

  it('a superseded boot that fails AFTER the live boot re-entered does not clear that re-entry', async () => {
    // The ordering the shared-promise test above cannot produce: the live boot
    // (B) fails first and re-enters, THEN the stopped boot (A) fails. If A's
    // catch cleared `started` before asking whether it was superseded, the
    // re-entry would boot with every projection returning early (QA lens).
    localStorage.setItem('maplespire:bootFromServer', 'true')
    try {
      vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
      const { root } = bfsGraph({ withDiagram: true })
      reads.fetchDiagramRender.mockResolvedValue({
        projectionGeneration: 1, objects: [LOCAL_OBJECT], connections: [], groups: [],
      })
      reads.fetchDiagramMeta.mockResolvedValue(undefined)
      reads.fetchDiagramListPage.mockResolvedValue({ items: [], nextCursor: null, total: 0 })
      const rootA = deferred<never>()
      const rootB = deferred<never>()
      const rootReentry = deferred<unknown>()
      const getRoot = vi.spyOn(repoModule, 'getRootHandle')
        .mockReturnValueOnce(rootA.promise)
        .mockReturnValueOnce(rootB.promise)
        .mockReturnValueOnce(rootReentry.promise as any)
        .mockResolvedValue(root)
      useModelStore.setState({ currentDiagramId: 'd1' })

      const { startBridge, stopBridge } = await import('./bridge')
      const bootA = startBridge(REF)
      stopBridge()
      const bootB = startBridge(REF)
      await vi.waitFor(() => expect(getRoot).toHaveBeenCalledTimes(2))
      rootB.reject(unanswered())
      await vi.waitFor(() => expect(getRoot).toHaveBeenCalledTimes(3))
      rootA.reject(unanswered())
      await bootA
      rootReentry.resolve(root)
      await bootB

      expect(repoModule.preferCachedRootForNextResolve).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(useModelStore.getState().objects.map((o) => o.id)).toEqual(['o1']))
      expect(useAutomergeStatus.getState().status).not.toBe('error')
      expect(useAutomergeStatus.getState().bootFallbackActive).toBe(true)
    } finally {
      localStorage.removeItem('maplespire:bootFromServer')
    }
  })
})

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  promise.catch(() => undefined)
  return { promise, resolve, reject }
}

describe('a boot that fails after its session was stopped', () => {
  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
  })

  it('recovers nothing: no fallback, no re-entry, no error over whatever comes next', async () => {
    // AutomergeBridge's cleanup stops the bridge on unmount (sign-out, leaving
    // the app) with no new start. A boot still awaiting its root then fails:
    // re-entering from the cached root would boot a bridge nobody owns.
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    useAutomergeStatus.setState({ status: 'connecting', error: null, bootFallbackActive: false })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    const preferCached = vi.spyOn(repoModule, 'preferCachedRootForNextResolve').mockReturnValue(undefined)
    vi.spyOn(repoModule, 'forgetWorkspaceHandles').mockReturnValue(undefined)
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue('automerge:v1-root')
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue('automerge:v2-root')
    let failRoot: (error: unknown) => void = () => undefined
    const pendingRoot = new Promise<never>((_, reject) => { failRoot = reject })
    pendingRoot.catch(() => undefined)
    const getRoot = vi.spyOn(repoModule, 'getRootHandle').mockReturnValueOnce(pendingRoot)
      .mockResolvedValue(cachedV1Graph().rootHandle)

    const { startBridge, stopBridge } = await import('./bridge')
    const boot = startBridge(REF)
    await vi.waitFor(() => expect(getRoot).toHaveBeenCalledTimes(1))
    stopBridge()
    failRoot(unanswered())
    await boot

    expect(preferCached).not.toHaveBeenCalled()
    expect(getRoot).toHaveBeenCalledTimes(1)
    expect(useAutomergeStatus.getState().status).not.toBe('error')
  })

  function armFailingBoot() {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    const preferCached = vi.spyOn(repoModule, 'preferCachedRootForNextResolve').mockReturnValue(undefined)
    vi.spyOn(repoModule, 'forgetWorkspaceHandles').mockReturnValue(undefined)
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue('automerge:v1-root')
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue('automerge:v2-root')
    const { rootHandle, modelHandle, shardHandle } = cachedV1Graph()
    vi.spyOn(repoModule, 'getModelHandle').mockResolvedValue(modelHandle)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([shardHandle])
    const pendingRoot = deferred<never>()
    const getRoot = vi.spyOn(repoModule, 'getRootHandle').mockReturnValueOnce(pendingRoot.promise)
      .mockResolvedValue(rootHandle)
    return { preferCached, getRoot, failRoot: pendingRoot.reject }
  }

  it('a stop issued before the boot\'s FIRST await still supersedes it', async () => {
    // The epoch is taken before the boot's first await, so an unmount that
    // lands while the boot routes its socket already counts (QA lens).
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    useAutomergeStatus.setState({ status: 'connecting', error: null, bootFallbackActive: false })
    const { preferCached, getRoot, failRoot } = armFailingBoot()
    const { startBridge, stopBridge } = await import('./bridge')
    const boot = startBridge(REF)
    stopBridge()
    await vi.waitFor(() => expect(getRoot).toHaveBeenCalledTimes(1))
    failRoot(unanswered())
    await boot

    expect(preferCached).not.toHaveBeenCalled()
    expect(getRoot).toHaveBeenCalledTimes(1)
  })

  it('a REFUSED start (already started) does not supersede the live boot', async () => {
    // `startBridge` returns at once while a session is started; the epoch must
    // move only for a start that actually begins one.
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    useAutomergeStatus.setState({ status: 'connecting', error: null, bootFallbackActive: false })
    const { preferCached, getRoot, failRoot } = armFailingBoot()
    const { startBridge } = await import('./bridge')
    const boot = startBridge(REF)
    await vi.waitFor(() => expect(getRoot).toHaveBeenCalledTimes(1))
    await startBridge(REF)
    failRoot(unanswered())
    await boot

    expect(preferCached).toHaveBeenCalledTimes(1)
    expect(getRoot).toHaveBeenCalledTimes(2)
  })

  it('a superseded boot that SUCCEEDS wires nothing: the live boot alone installs the listeners', async () => {
    // Its tail would wire a second set of connection listeners (overwriting
    // the live session's cleanups) and install the repoint handler, which
    // takes the kept binding frame against whatever basis that moment holds.
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    const { rootHandle, modelHandle, shardHandle } = cachedV1Graph()
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(rootHandle)
    vi.spyOn(repoModule, 'getModelHandle').mockResolvedValue(modelHandle)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([shardHandle])
    const added = vi.spyOn(window, 'addEventListener')

    const { startBridge, stopBridge } = await import('./bridge')
    const bootA = startBridge(REF)
    stopBridge()
    const bootB = startBridge(REF)
    await Promise.all([bootA, bootB])

    expect(added.mock.calls.filter(([type]) => type === 'online')).toHaveLength(1)
    expect(useModelStore.getState().objects.map((o) => o.id)).toEqual(['o1'])
  })
})

describe('a boot superseded WHILE its catch awaits the rebound', () => {
  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
  })

  it('does not stop the session that superseded it, nor move the workspace', async () => {
    // The authenticated rebound awaits the stores and `resolveBootWorkspaceRef`
    // (a network call) before it stops the bridge and starts another ref. A
    // stop + start landing in that window belongs to someone else (QA lens,
    // 2026-10-29: RED with a single check at the top of the catch).
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { useAuthStore } = await import('../../stores/authStore')
    const authSnapshot = useAuthStore.getState()
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const bootRef = await import('./bootRef')
    const fallback = deferred<WorkspaceRef>()
    vi.spyOn(bootRef, 'resolveBootWorkspaceRef').mockReturnValue(fallback.promise)
    try {
      useAuthStore.setState({
        config: { stage: 'on', devLogin: false, passwordLogin: false } as any,
        user: { id: 'u1' } as any,
        orgId: 'org1',
      })
      useWorkspaceStore.setState({ ref: REF })
      vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
      const { modelHandle, shardHandle, rootHandle } = cachedV1Graph()
      vi.spyOn(repoModule, 'getModelHandle').mockResolvedValue(modelHandle)
      vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([shardHandle])
      const getRoot = vi.spyOn(repoModule, 'getRootHandle')
        .mockRejectedValueOnce(new Error('root document is gone'))
        .mockResolvedValue(rootHandle)

      const { startBridge, stopBridge } = await import('./bridge')
      const bootA = startBridge(REF)
      await vi.waitFor(() => expect(bootRef.resolveBootWorkspaceRef).toHaveBeenCalledTimes(1))
      stopBridge()
      await startBridge(REF)
      expect(getRoot).toHaveBeenCalledTimes(2)
      expect(useAutomergeStatus.getState().status).not.toBe('error')
      const objectsBefore = useModelStore.getState().objects.map((o) => o.id)
      fallback.resolve({ landscapeId: 'L2', versionId: 'current' })
      await bootA

      expect(useWorkspaceStore.getState().ref, 'the superseded boot moved the live session').toEqual(REF)
      expect(getRoot, 'the superseded boot started a session of its own').toHaveBeenCalledTimes(2)
      expect(useModelStore.getState().objects.map((o) => o.id)).toEqual(objectsBefore)
    } finally {
      useAuthStore.setState({ ...authSnapshot })
    }
  })
})

const LOCAL_OBJECT = {
  id: 'o1', type: 'system', name: 'Local system',
  position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
  tagAssignments: {}, tagOrder: [], properties: {}, scope: 'internal', status: 'live',
}

/** A sharded workspace for the boot-from-server cases (the
 * bridgeBfsDocUrl.test.ts fixture): ModelMeta with its overlay write heads
 * (without them the boot is downgraded to resident), one registry shard —
 * empty, or holding `d1` with no DiagramDoc — and the root naming both. */
function bfsGraph(options: { withDiagram?: boolean } = {}) {
  const { repo } = repoModule
  const objectBase = repo.create<any>({ objects: {} })
  const connectionBase = repo.create<any>({ connections: {} })
  const objectHead = repo.create<any>({ objects: {}, writeHeadVersion: 1 })
  const connectionHead = repo.create<any>({ connections: {}, writeHeadVersion: 1 })
  const meta = repo.create<any>({
    objectShardUrls: [objectBase.url],
    connectionShardUrls: [connectionBase.url],
    editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
    editsObjectShardUrl: objectHead.url,
    editsConnectionShardUrl: connectionHead.url,
    editsObjectShardUrls: [objectHead.url],
    editsConnectionShardUrls: [connectionHead.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    deletedObjectIds: [], deletedConnectionIds: [],
  })
  const registry = repo.create<any>({
    diagrams: options.withDiagram
      ? { d1: { id: 'd1', name: 'Local diagram', type: 'context', docUrl: '', objectIds: ['o1'], connectionIds: [], groupIds: [] } }
      : {},
  })
  const root = repo.create<any>({ modelUrl: '', modelMetaUrl: meta.url, shardUrls: [registry.url] })
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([registry] as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
  return { root }
}
