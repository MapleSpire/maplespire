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
 * Defect 2026-10-16: creating a Draft from "FoodDash - Containers" landed the
 * canvas on "Order Service - Components" — the switch into the Draft parked no
 * diagram, so the boot took its default pick. Merging back did the same.
 *
 * The fix parks the diagram being viewed as a PREFERENCE. These tests pin the
 * boot's side of that contract on the resident path (the bridgeBootFallback
 * pattern: repo-module seams spied, the rest of startBridge real):
 *  - a preferred diagram the version has is opened;
 *  - a preferred diagram the version lacks (made in the Draft, never merged)
 *    falls back to the default pick instead of stranding the user on
 *    not-found;
 *  - a REQUESTED diagram (a deep link) the version lacks still stays parked —
 *    not-found is the honest answer to "open this diagram".
 */

// @vitest-environment jsdom
// jsdom: the success path runs wireConnectionStatus(), which needs `window`.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { DEFAULT_WORKSPACE_REF } from './workspace'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'

const { fetchRegistryHasDiagramMock } = vi.hoisted(() => ({
  // Undefined: the server cannot tell — the loaded registry decides.
  fetchRegistryHasDiagramMock: vi.fn(async (_id: string): Promise<unknown> => undefined),
}))
vi.mock('../modelQuery/diagramRender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modelQuery/diagramRender')>()),
  fetchRegistryHasDiagram: fetchRegistryHasDiagramMock,
}))

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

/** Two diagrams: `d1` has content, so it is the default pick; `d2` is blank.
 * docUrl is empty so the open takes the doc-less classic branch. */
function workspaceFakes() {
  const rootHandle = fakeHandle('root', {
    modelUrl: 'automerge:model',
    shardUrls: ['automerge:shard'],
  })
  const modelHandle = fakeHandle('model', {
    objects: {
      o1: {
        id: 'o1', type: 'system', name: 'System',
        position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
        tagAssignments: {}, tagOrder: [], properties: {},
        scope: 'internal', status: 'live',
      },
    },
    connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const shardHandle = fakeHandle('shard', {
    diagrams: {
      d1: {
        id: 'd1', name: 'Default diagram', type: 'context', docUrl: '',
        objectIds: ['o1'], connectionIds: [], groupIds: [],
      },
      d2: {
        id: 'd2', name: 'The one being viewed', type: 'container', docUrl: '',
        objectIds: [], connectionIds: [], groupIds: [],
      },
    },
  })
  return { rootHandle, modelHandle, shardHandle }
}

async function bootParked(parked: string, prefer: boolean): Promise<string | null> {
  const { preferInitialDiagram, startBridge } = await import('./bridge')
  // What switchWorkspace's loadWorkspace does: park, then mark it a preference
  // (or not), then boot.
  useModelStore.setState({ currentDiagramId: parked })
  preferInitialDiagram(prefer ? parked : null)
  await startBridge(DEFAULT_WORKSPACE_REF)
  return useModelStore.getState().currentDiagramId
}

describe('the boot honours a preferred diagram only when the version has it', () => {
  beforeEach(async () => {
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
    const { rootHandle, modelHandle, shardHandle } = workspaceFakes()
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(rootHandle)
    vi.spyOn(repoModule, 'getModelHandle').mockResolvedValue(modelHandle)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([shardHandle])
  })

  afterEach(async () => {
    const { stopBridge, preferInitialDiagram } = await import('./bridge')
    stopBridge()
    preferInitialDiagram(null)
    vi.restoreAllMocks()
  })

  it('control: with nothing parked the boot opens the default diagram', async () => {
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(useModelStore.getState().currentDiagramId).toBe('d1')
  })

  it('a preferred diagram the version has is the one opened, not the default', async () => {
    expect(await bootParked('d2', true)).toBe('d2')
    expect(useAutomergeStatus.getState().status).not.toBe('error')
  })

  it('a preferred diagram the version lacks falls back to the default pick', async () => {
    // Decided once the registry heads probe answers, not by the boot itself.
    await bootParked('made-in-the-draft', true)
    await vi.waitFor(() => expect(useModelStore.getState().currentDiagramId).toBe('d1'), { timeout: 1_000 })
  })

  it('a REQUESTED (deep-linked) diagram the version lacks stays parked — not-found is honest there', async () => {
    expect(await bootParked('made-in-the-draft', false)).toBe('made-in-the-draft')
  })

  it('the preference is consumed by one boot and does not leak into the next', async () => {
    const { stopBridge, startBridge, preferInitialDiagram } = await import('./bridge')
    await bootParked('made-in-the-draft', true)
    await vi.waitFor(() => expect(useModelStore.getState().currentDiagramId).toBe('d1'), { timeout: 1_000 })
    stopBridge()
    // A later deep link to the same missing id is a request, not a preference.
    useModelStore.setState({ currentDiagramId: 'made-in-the-draft' })
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(useModelStore.getState().currentDiagramId).toBe('made-in-the-draft')
    preferInitialDiagram(null)
  })
})

/**
 * Defect 2026-10-17 (after the fix above): the preference was judged against
 * the STORE's diagram list, which boot-from-server has not projected yet at the
 * boot's choice — so a Draft that HAS the diagram read as one that lacks it,
 * and the canvas stayed empty. It is now judged against the loaded REGISTRY.
 *
 * When the loaded registry lacks it, the SERVER answers for the version's own
 * registry: a merge lands in live in place, and a warm tab's cached live shard
 * can miss the diagram just merged. Rejected on the way: a 3 s grace (lost the
 * user's place on a slow registry), the read model's 404 (it answers a sparse
 * Draft from its parent), and a wait on registry heads with no deadline (a
 * sync that never delivers left the canvas blank for good).
 */
describe('a preference missing from the loaded registry is decided by the server', () => {
  let shardDoc: { diagrams: Record<string, unknown> }
  let shardListeners: Array<() => void>
  let all: Record<string, unknown>

  /** The tab's copy syncs: d2 (merged in on the server) reaches it. */
  function arrive(): void {
    shardDoc = { diagrams: { ...shardDoc.diagrams, d2: all.d2 } }
    for (const fn of shardListeners) fn()
  }

  beforeEach(async () => {
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
    const { rootHandle, modelHandle, shardHandle } = workspaceFakes()
    all = (shardHandle.doc() as { diagrams: Record<string, unknown> }).diagrams
    // The tab's cached copy: d1 only.
    shardDoc = { diagrams: { d1: all.d1 } }
    shardListeners = []
    const shard = {
      ...shardHandle,
      doc: () => shardDoc,
      on: vi.fn((event: string, fn: () => void) => { if (event === 'change') shardListeners.push(fn) }),
      off: vi.fn((event: string, fn: () => void) => {
        if (event === 'change') shardListeners = shardListeners.filter((listener) => listener !== fn)
      }),
    }
    vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(rootHandle)
    vi.spyOn(repoModule, 'getModelHandle').mockResolvedValue(modelHandle)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([shard as any])
    fetchRegistryHasDiagramMock.mockReset()
    fetchRegistryHasDiagramMock.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    vi.useRealTimers()
    const { stopBridge, preferInitialDiagram } = await import('./bridge')
    stopBridge()
    preferInitialDiagram(null)
    vi.restoreAllMocks()
  })

  const current = () => useModelStore.getState().currentDiagramId
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('control: a preference the loaded registry lists is opened by the boot itself, no probe', async () => {
    expect(await bootParked('d1', true)).toBe('d1')
    expect(fetchRegistryHasDiagramMock).not.toHaveBeenCalled()
  })

  it('the server says ABSENT: the default pick, at once', async () => {
    fetchRegistryHasDiagramMock.mockResolvedValue(false)
    await bootParked('made-in-the-draft', true)
    await vi.waitFor(() => expect(current()).toBe('d1'), { timeout: 1_000 })
    expect(fetchRegistryHasDiagramMock).toHaveBeenCalledWith('made-in-the-draft')
  })

  it('the server says PRESENT: waits — past any short grace — and opens it when the registry brings it', async () => {
    fetchRegistryHasDiagramMock.mockResolvedValue(true)
    expect(await bootParked('d2', true)).toBeNull()
    await vi.waitFor(() => expect(fetchRegistryHasDiagramMock).toHaveBeenCalled())
    await sleep(3_500) // longer than the 3 s grace the first fix guessed with
    expect(current()).toBeNull()
    arrive()
    await vi.waitFor(() => expect(current()).toBe('d2'), { timeout: 1_000 })
  }, 10_000)

  it('PRESENT but never delivered: past the boot document budget, the default pick — never blank for good', async () => {
    const { BOOT_DOCUMENT_RESOLUTION } = await import('./repo')
    let answer: (present: boolean) => void = () => undefined
    fetchRegistryHasDiagramMock.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    await bootParked('d2', true)
    await vi.waitFor(() => expect(fetchRegistryHasDiagramMock).toHaveBeenCalled())
    vi.useFakeTimers()
    answer(true)
    await vi.advanceTimersByTimeAsync(BOOT_DOCUMENT_RESOLUTION.budgetMs - 1)
    expect(current()).toBeNull() // still within the delivery budget
    await vi.advanceTimersByTimeAsync(2)
    expect(current()).toBe('d1')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('did not receive it'))
  })

  it('the registry bringing it opens it even before the server answers', async () => {
    fetchRegistryHasDiagramMock.mockReturnValue(new Promise(() => undefined)) // never answers
    await bootParked('d2', true)
    arrive()
    await vi.waitFor(() => expect(current()).toBe('d2'), { timeout: 1_000 })
  })

  it('a server that cannot tell (offline) leaves the loaded registry to decide — no blank canvas', async () => {
    fetchRegistryHasDiagramMock.mockResolvedValue(undefined)
    await bootParked('made-in-the-draft', true)
    await vi.waitFor(() => expect(current()).toBe('d1'), { timeout: 1_000 })
  })

  it('a diagram the user picks while the probe is out is kept', async () => {
    let answer: (present: boolean) => void = () => undefined
    fetchRegistryHasDiagramMock.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    await bootParked('made-in-the-draft', true)
    useModelStore.setState({ currentDiagramId: 'd1' })
    answer(false)
    await sleep(300)
    expect(current()).toBe('d1')
  })

  it("a previous session's late answer cannot decide the next session's pick", async () => {
    const { stopBridge } = await import('./bridge')
    let answerFirst: (present: boolean) => void = () => undefined
    fetchRegistryHasDiagramMock
      .mockReturnValueOnce(new Promise((resolve) => { answerFirst = resolve }))
      .mockResolvedValueOnce(true) // the next session's diagram exists: it waits for delivery
    await bootParked('made-in-the-draft', true)
    stopBridge()
    useModelStore.setState({ currentDiagramId: null })
    expect(await bootParked('d2', true)).toBeNull()
    await vi.waitFor(() => expect(fetchRegistryHasDiagramMock).toHaveBeenCalledTimes(2))
    // Session one's "absent" would open the default pick over session two,
    // which is waiting for d2.
    answerFirst(false)
    await sleep(300)
    expect(current()).toBeNull()
    arrive()
    await vi.waitFor(() => expect(current()).toBe('d2'), { timeout: 1_000 })
  })

  it('a stopped session stops listening to its shards, and its delivery timer is inert', async () => {
    const { stopBridge } = await import('./bridge')
    const { BOOT_DOCUMENT_RESOLUTION } = await import('./repo')
    let answer: (present: boolean) => void = () => undefined
    fetchRegistryHasDiagramMock.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    await bootParked('d2', true)
    await vi.waitFor(() => expect(fetchRegistryHasDiagramMock).toHaveBeenCalled())
    vi.useFakeTimers()
    answer(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(shardListeners.length).toBeGreaterThan(1) // the bridge's own + the pick's
    stopBridge()
    // Detached, not merely inert: the session guard would also stop a leaked
    // listener from acting, so only the count shows the leak.
    expect(shardListeners).toHaveLength(0)
    // The delivery timer, if it fired, finds a dead session: no fallback, no warning.
    useModelStore.setState({ currentDiagramId: null })
    await vi.advanceTimersByTimeAsync(BOOT_DOCUMENT_RESOLUTION.budgetMs + 1)
    expect(current()).toBeNull()
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('did not receive it'))
  })
})
