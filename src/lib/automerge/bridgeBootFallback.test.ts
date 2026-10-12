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
 * Boot fallback: after a set-default repoint, the server answers the root-url
 * fetch instantly with the NEW root while its sync layer — still warming up,
 * the same window in which the read model answers 503 — leaves every document
 * request for the new graph unanswered. Without a fallback the boot would
 * freeze on `{objects:0, diagrams:0, currentDiagramId:null}` with the canvas on
 * "Loading…". Instead the bounded resolution surfaces a RETRYABLE failure and
 * startBridge re-enters ONCE from the last locally materialized root — the
 * same resident/IndexedDB path a connection-failure boot takes — so the store
 * carries the local content.
 *
 * These tests drive the REAL startBridge (the bridgeNetworkRoute.test.ts
 * pattern: repo-module seams spied, everything else real).
 */

// @vitest-environment jsdom
// jsdom, not node: the SUCCESS path under test runs wireConnectionStatus(),
// which wires real window/document listeners — under node the bare `window`
// access throws inside startBridge's try and reads as a phantom boot failure.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { DocumentTemporarilyUnavailableError } from './documentResolution'
import { DEFAULT_WORKSPACE_REF, type WorkspaceRef } from './workspace'
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

/** The last locally materialized workspace graph — what IndexedDB would answer
 * on the resident fallback boot: a monolith model with one object and a
 * registry with one diagram (docUrl deliberately empty so the open takes the
 * doc-less classic branch — the diagram doc is not what this regression is
 * about). */
function localWorkspaceFakes() {
  const rootHandle = fakeHandle('v1-root', {
    modelUrl: 'automerge:v1-model',
    shardUrls: ['automerge:v1-shard'],
  })
  const modelHandle = fakeHandle('v1-model', {
    objects: {
      o1: {
        id: 'o1', type: 'system', name: 'Local system',
        position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
        tagAssignments: {}, tagOrder: [], properties: {},
        scope: 'internal', status: 'live',
      },
    },
    connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const shardHandle = fakeHandle('v1-shard', {
    diagrams: {
      d1: {
        id: 'd1', name: 'Local diagram', type: 'context', docUrl: '',
        objectIds: ['o1'], connectionIds: [], groupIds: [],
      },
    },
  })
  return { rootHandle, modelHandle, shardHandle }
}

const unanswered = () =>
  new DocumentTemporarilyUnavailableError('automerge:v2-root', 3)

describe('startBridge boot fallback to the last materialized root', () => {
  beforeEach(async () => {
    // The one-shot guard is bridge-module state that a FAILED fallback boot
    // legitimately leaves latched; reset it so no test inherits another
    // test's latch (ordering independence).
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    useModelStore.setState({
      objects: [], connections: [], groups: [], diagrams: [],
      comments: [], flows: [], currentDiagramId: null,
    })
    useAutomergeStatus.setState({
      status: 'connecting', ready: false, visualReady: false, editReady: false,
      projectedWorkspace: null, error: null, bootFallbackActive: false,
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
  })

  // What makes these slow on a loaded runner is the dynamic bridge/WASM import
  // below, not anything they assert. The timeout ceiling lives in
  // `vitest.config.ts`, for every file.
  it('a workspace whose documents never materialize boots the LOCAL content — never an empty store', async () => {
    // Test (ii): persistent unavailability at boot → resident/IndexedDB path.
    // Without the fallback catch branch the first
    // failure lands in the terminal error path, the store stays empty and
    // status reads 'error'.
    const { rootHandle, modelHandle, shardHandle } = localWorkspaceFakes()
    const getRoot = vi.spyOn(repoModule, 'getRootHandle')
      .mockRejectedValueOnce(unanswered()) // the repointed (v2) graph: silent server
      .mockResolvedValue(rootHandle) // the fallback resolve: cached v1 root from IndexedDB
    vi.spyOn(repoModule, 'getModelHandle').mockResolvedValue(modelHandle)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([shardHandle])
    const preferCached = vi.spyOn(repoModule, 'preferCachedRootForNextResolve').mockReturnValue(undefined)
    const forgetHandles = vi.spyOn(repoModule, 'forgetWorkspaceHandles').mockReturnValue(undefined)
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue('automerge:v1-root')
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue('automerge:v2-root')

    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    // Re-entered once, armed the cached-root preference, dropped the poisoned
    // in-memory promises (a rejected root promise would otherwise be returned
    // to the retry as-is).
    expect(getRoot).toHaveBeenCalledTimes(2)
    expect(preferCached).toHaveBeenCalledTimes(1)
    expect(forgetHandles).toHaveBeenCalledTimes(1)

    // The store carries the LOCAL workspace, not
    // {objects:0, diagrams:0, currentDiagramId:null} forever.
    const state = useModelStore.getState()
    expect(state.objects.map((o) => o.id)).toEqual(['o1'])
    expect(state.diagrams.map((d) => d.id)).toEqual(['d1'])
    expect(state.currentDiagramId).toBe('d1')

    // And the boot actually COMPLETED: the canvas gate lifts (visualReady
    // becomes true) and the badge never reads error.
    const status = useAutomergeStatus.getState()
    expect(status.editReady).toBe(true)
    expect(status.visualReady).toBe(true)
    expect(status.status).not.toBe('error')
    // The detour is visible — the badge can say "local content, server
    // unavailable" instead of a bare "Synced" over a fallback session.
    expect(status.bootFallbackActive).toBe(true)
  })

  it('the fallback is one-shot: a fallback boot that fails again surfaces the error instead of recursing', async () => {
    // The fallback is bounded: two resolutions exactly — the original and the
    // single fallback — then the terminal error state.
    const getRoot = vi.spyOn(repoModule, 'getRootHandle').mockRejectedValue(unanswered())
    vi.spyOn(repoModule, 'preferCachedRootForNextResolve').mockReturnValue(undefined)
    vi.spyOn(repoModule, 'forgetWorkspaceHandles').mockReturnValue(undefined)
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue('automerge:v1-root')
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue('automerge:v2-root')
    const abandon = vi.spyOn(repoModule, 'abandonPreferredCachedRoot').mockReturnValue(undefined)

    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    expect(getRoot).toHaveBeenCalledTimes(2)
    expect(useAutomergeStatus.getState().status).toBe('error')
    // The terminal error path drops any unconsumed one-shot cached-root
    // preference — a fallback re-entry that died before fetchRootUrl consumed
    // it must not leak the flag into a later, unrelated resolve.
    expect(abandon).toHaveBeenCalledWith(DEFAULT_WORKSPACE_REF)
  })

  it('a transient stall on a non-default ref never rebounds to the default workspace (and keeps its persisted root url)', async () => {
    // AUTH=off: a RETRYABLE failure that was refused the cached fallback must
    // NOT fall into the dangling-ref rebound — forgetWorkspace would destroy the
    // persisted offline root url and the boot would silently open the DEFAULT
    // landscape. A >21s server warm-up is not a dangling ref: the only correct
    // end is setStatus('error') on the REQUESTED workspace.
    const ref: WorkspaceRef = { landscapeId: 'atlas', versionId: 'current' }
    const getRoot = vi.spyOn(repoModule, 'getRootHandle').mockRejectedValue(unanswered())
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null) // cold here: no cached-root fallback either
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue('automerge:v2-root')
    const forget = vi.spyOn(repoModule, 'forgetWorkspace').mockReturnValue(undefined)
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const refBefore = useWorkspaceStore.getState().ref

    const { startBridge } = await import('./bridge')
    await startBridge(ref)

    // ONE boot, no rebound: no second startBridge on DEFAULT_WORKSPACE_REF and
    // no forgetWorkspace(ref), which would destroy the persisted url (the
    // offline cache's only pointer).
    expect(getRoot).toHaveBeenCalledTimes(1)
    expect(forget).not.toHaveBeenCalled()
    expect(useWorkspaceStore.getState().ref).toEqual(refBefore)
    expect(useAutomergeStatus.getState().status).toBe('error')
  })

  it('a genuinely dangling ref (non-retryable) still rebounds to the live model', async () => {
    // The legitimate rebound still works: a persisted ref whose root is
    // authoritatively gone (deleted draft, dev reseed) falls back to the
    // default workspace — and drops the dead root's persisted url so the
    // cached-root fallback can never resurrect it.
    const ref: WorkspaceRef = { landscapeId: 'ghost', versionId: 'current' }
    const { rootHandle, modelHandle, shardHandle } = localWorkspaceFakes()
    const getRoot = vi.spyOn(repoModule, 'getRootHandle')
      .mockRejectedValueOnce(new Error('Document ghost-root was deleted')) // authoritative, retryable: false
      .mockResolvedValue(rootHandle)
    vi.spyOn(repoModule, 'getModelHandle').mockResolvedValue(modelHandle)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([shardHandle])
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
    const forget = vi.spyOn(repoModule, 'forgetWorkspace').mockReturnValue(undefined)

    const { startBridge } = await import('./bridge')
    await startBridge(ref)

    expect(getRoot).toHaveBeenCalledTimes(2)
    expect(forget).toHaveBeenCalledWith(ref, { dropPersistedRootUrl: true })
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    expect(useWorkspaceStore.getState().ref).toEqual(DEFAULT_WORKSPACE_REF)
    const status = useAutomergeStatus.getState()
    expect(status.status).not.toBe('error')
    expect(status.editReady).toBe(true)
  })

  it('a retryable ModelMeta unavailability fails the WORKSPACE boot — never a silently empty resident boot', async () => {
    // Pins the isRetryableDocumentResolutionError rethrow around
    // ensureModelSharded (bridge.ts). Absorbed into
    // `sharded = false`, this boot "completes" as a resident projection whose
    // model documents were never loaded — an empty store that reports ready,
    // the silent-failure class.
    const rootHandle = fakeHandle('v1-root', {
      modelUrl: '',
      shardUrls: ['automerge:v1-shard'],
      // A REAL valid documentId: the sharded-workspace branch is gated on
      // isValidAutomergeUrl, and a fake like 'automerge:v1-meta' would
      // silently route this test around the guard under test.
      modelMetaUrl: 'automerge:2oqD6jdnyr3sv35Up38MapoQRMX7',
    })
    const shardHandle = localWorkspaceFakes().shardHandle
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(rootHandle)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([shardHandle])
    const findMeta = vi.spyOn(repoModule, 'findModelMetaHandle')
      .mockRejectedValue(new DocumentTemporarilyUnavailableError('automerge:2oqD6jdnyr3sv35Up38MapoQRMX7', 3))
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null) // nothing local: the failure must SURFACE
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)

    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    // Guard against a void run: the guard path must actually have executed.
    expect(findMeta).toHaveBeenCalled()
    const status = useAutomergeStatus.getState()
    expect(status.status).toBe('error')
    expect(status.editReady).toBe(false)
  })

  it('a successful boot re-arms the fallback for the next incident', async () => {
    // Pins `bootCachedRootFallbackKey = null` on the success path. Without
    // it the one-shot guard stays latched after the FIRST recovered incident,
    // and the second incident of the same session bricks with 'error' instead
    // of falling back. Deliberately self-contained — two full
    // incident→recovery cycles inside ONE test, on a ref no other test uses —
    // so no execution order can hand it a pre-latched or pre-cleared guard.
    const ref: WorkspaceRef = { landscapeId: 'rearm', versionId: 'current' }
    const { rootHandle, modelHandle, shardHandle } = localWorkspaceFakes()
    const getRoot = vi.spyOn(repoModule, 'getRootHandle')
      .mockRejectedValueOnce(unanswered())
      .mockResolvedValueOnce(rootHandle)
      .mockRejectedValueOnce(unanswered())
      .mockResolvedValue(rootHandle)
    vi.spyOn(repoModule, 'getModelHandle').mockResolvedValue(modelHandle)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([shardHandle])
    const preferCached = vi.spyOn(repoModule, 'preferCachedRootForNextResolve').mockReturnValue(undefined)
    vi.spyOn(repoModule, 'forgetWorkspaceHandles').mockReturnValue(undefined)
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue('automerge:v1-root')
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue('automerge:v2-root')

    const { startBridge, stopBridge } = await import('./bridge')
    await startBridge(ref)
    expect(preferCached).toHaveBeenCalledTimes(1)
    expect(useAutomergeStatus.getState().status).not.toBe('error')

    stopBridge()

    await startBridge(ref)
    // The second incident fell back AGAIN: the successful first boot re-armed
    // the guard. (If the guard were never cleared, alreadyFellBack would refuse
    // the fallback, the gated rebounds would refuse the retryable error, and
    // this second boot would end 'error' with preferCached still at 1.)
    expect(preferCached).toHaveBeenCalledTimes(2)
    expect(getRoot).toHaveBeenCalledTimes(4)
    expect(useAutomergeStatus.getState().status).not.toBe('error')
  })

  it('a refused (non-re-entry) boot failing terminally never disarms the cached-root preference', async () => {
    // Boots can overlap (StrictMode's dev double-mount leaves the first boot's
    // chain running beside the second). While the fallback re-entry sits in
    // its early awaits, the refused twin's terminal error must not call
    // abandonPreferredCachedRoot — that would disarm the preference the
    // re-entry is about to consume, make it re-fetch the very root that just
    // stalled, and let the one-shot guard brick the recovery. The refusal path
    // is identical whether the twin fails concurrently or afterwards, so it is
    // modeled sequentially: cycle 1 latches the guard (its re-entry fails and
    // cleans ITS OWN flag); the third boot is refused by the latched guard and
    // must leave the preference and the shared handle cache alone.
    const ref: WorkspaceRef = { landscapeId: 'twin', versionId: 'current' }
    const getRoot = vi.spyOn(repoModule, 'getRootHandle').mockRejectedValue(unanswered())
    vi.spyOn(repoModule, 'preferCachedRootForNextResolve').mockReturnValue(undefined)
    const forgetHandles = vi.spyOn(repoModule, 'forgetWorkspaceHandles').mockReturnValue(undefined)
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue('automerge:v1-root')
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue('automerge:v2-root')
    const abandon = vi.spyOn(repoModule, 'abandonPreferredCachedRoot').mockReturnValue(undefined)

    const { startBridge } = await import('./bridge')
    // Cycle 1: boot fails, falls back, the RE-ENTRY fails too. The re-entry's
    // own terminal cleanup is the one legitimate abandon (+ handle purge).
    await startBridge(ref)
    expect(abandon).toHaveBeenCalledTimes(1)
    const purgesAfterCycle1 = forgetHandles.mock.calls.length
    expect(useAutomergeStatus.getState().status).toBe('error')

    // The refused twin: guard latched, fallback refused, terminal error. It
    // must NOT touch the module state a concurrent re-entry depends on.
    await startBridge(ref)
    expect(getRoot).toHaveBeenCalledTimes(3)
    expect(useAutomergeStatus.getState().status).toBe('error')
    expect(abandon).toHaveBeenCalledTimes(1) // unchanged — the twin never disarms the preference
    expect(forgetHandles).toHaveBeenCalledTimes(purgesAfterCycle1) // nor purges the shared handle cache
  })
})
