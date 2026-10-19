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
 * The view-settings fast path, driven through the REAL bridge: store edit →
 * onStoreChange → classifyDiagramViewEdit → scheduleViewWrite → flushWrite →
 * DiagramDoc. `diagramViewWrite.test.ts` covers the pure halves; this file is
 * the WIRE — deleting the scheduleViewWrite call site, the view branch inside
 * flushWrite, or the drain of `pendingViewDiagramIds` must go red here.
 *
 * Classic boot on REAL Automerge handles created on the module repo (no
 * network; no IndexedDB under jsdom), with the repo-module resolvers spied —
 * the bridgeBootFallback.test.ts pattern.
 *
 * "Targeted" is witnessed by the `diagramView.flush` timeline mark. The
 * registry shard and model handles receiving NO `change` call is asserted too,
 * but since 2026-10-11 it no longer separates the two paths on its own: the
 * full write pre-diffs the registry against the materialized shard
 * (bridgeConnectWrite.test.ts) and opens no change on it when no meta differs
 * — which a view-field edit never makes. The mark is the discriminating
 * witness; deleting the view branch drops it.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Automerge from '@automerge/automerge'
import * as repoModule from './repo'
import { DEFAULT_WORKSPACE_REF } from './workspace'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import {
  __setClientTimelineEnabledForTest,
  readClientTimeline,
  resetClientTimeline,
} from '../observability/clientTimeline'

vi.mock('../modelQuery/kvStore', () => ({
  workspaceKvStore: () => ({
    get: async () => undefined,
    set: async () => undefined,
    del: async () => undefined,
    update: async () => undefined,
  }),
}))

function objectEntity(id: string) {
  return {
    id, type: 'system', name: `System ${id}`,
    position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
    tagAssignments: {}, tagOrder: [], properties: {},
    scope: 'internal', status: 'live',
  }
}

function diagramDoc(name: string, extra: Record<string, unknown> = {}) {
  return {
    name, type: 'context',
    objectIds: ['o1'], connectionIds: [], groupIds: [],
    layouts: { o1: { position: { x: 1, y: 2 }, size: { width: 200, height: 100 } } },
    comments: {}, flows: {}, checkpoints: [],
    ...extra,
  }
}

function workspace() {
  const repo = repoModule.repo
  const d1Doc = repo.create<any>(diagramDoc('Active diagram', {
    skinId: 'old-skin',
    sceneDecor: { packId: 'canadiana', background: 'city' },
  }))
  const d2Doc = repo.create<any>(diagramDoc('Other diagram'))
  const shard = repo.create<any>({
    diagrams: {
      d1: { id: 'd1', name: 'Active diagram', type: 'context', docUrl: d1Doc.url, objectIds: ['o1'], connectionIds: [], groupIds: [] },
      d2: { id: 'd2', name: 'Other diagram', type: 'context', docUrl: d2Doc.url, objectIds: ['o1'], connectionIds: [], groupIds: [] },
    },
  })
  const model = repo.create<any>({
    objects: { o1: objectEntity('o1') },
    connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const root = repo.create<any>({ modelUrl: model.url, shardUrls: [shard.url] })
  return { root, model, shard, d1Doc, d2Doc }
}

type Workspace = ReturnType<typeof workspace>

const heads = (handle: { doc(): any }) => Automerge.getHeads(handle.doc())
/** The materialized doc as plain data (every handle here is created ready). */
const read = (handle: { doc(): unknown }) => handle.doc() as any
const viewFlushMarks = () => readClientTimeline().entries.filter((entry) => entry.name === 'diagramView.flush').length

async function boot(): Promise<Workspace> {
  const ws = workspace()
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(ws.root as any)
  vi.spyOn(repoModule, 'getModelHandle').mockResolvedValue(ws.model as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([ws.shard] as any)
  vi.spyOn(repoModule, 'findDiagramHandle').mockImplementation(async (url: string) => {
    if (url === ws.d1Doc.url) return ws.d1Doc as any
    if (url === ws.d2Doc.url) return ws.d2Doc as any
    throw new Error(`unexpected diagram url ${url}`)
  })
  vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
  vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
  const { startBridge, getActiveDiagramHandle } = await import('./bridge')
  await startBridge(DEFAULT_WORKSPACE_REF)
  // Guard against a void run: the boot must have attached d1's REAL doc,
  // otherwise every assertion below is about a branch that never ran.
  expect(useAutomergeStatus.getState().status).not.toBe('error')
  expect(useModelStore.getState().currentDiagramId).toBe('d1')
  expect(getActiveDiagramHandle()?.url).toBe(ws.d1Doc.url)
  return ws
}

/** Spy AFTER boot, so only writes caused by the edit under test are counted. */
function watchFullWrite(ws: Workspace) {
  return {
    shard: vi.spyOn(ws.shard, 'change'),
    model: vi.spyOn(ws.model, 'change'),
  }
}

/** Drain the write scheduler synchronously, the way a page hide does. */
async function flushByTeardown() {
  const { stopBridge } = await import('./bridge')
  stopBridge()
}

describe('view-settings edit through the real bridge', () => {
  beforeEach(async () => {
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    __setClientTimelineEnabledForTest(true)
    resetClientTimeline()
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
    __setClientTimelineEnabledForTest(null)
    vi.restoreAllMocks()
  })

  it('control: an untouched session flushes nothing at teardown', async () => {
    const ws = await boot()
    const full = watchFullWrite(ws)
    const d1Before = heads(ws.d1Doc)
    await flushByTeardown()
    expect(full.shard).not.toHaveBeenCalled()
    expect(heads(ws.d1Doc)).toEqual(d1Before)
    expect(viewFlushMarks()).toBe(0)
  })

  it('a skin + animation + decor edit on the active diagram lands in its DiagramDoc through the TARGETED path', async () => {
    const ws = await boot()
    const full = watchFullWrite(ws)
    const d1Before = heads(ws.d1Doc)

    useModelStore.getState().updateDiagram('d1', { skinId: 'studio', connectionAnimationsEnabled: false })
    useModelStore.getState().setDiagramSceneDecor('d1', { packId: 'canadiana', background: 'workbench' })
    await flushByTeardown()

    const doc = read(ws.d1Doc)
    expect(doc.skinId).toBe('studio')
    expect(doc.connectionAnimationsEnabled).toBe(false)
    expect(doc.sceneDecor).toEqual({ packId: 'canadiana', background: 'workbench' })
    expect(heads(ws.d1Doc)).not.toEqual(d1Before)
    expect(doc.name).toBe('Active diagram')
    expect(doc.objectIds).toEqual(['o1'])
    // Targeted: the full write never ran.
    expect(full.shard).not.toHaveBeenCalled()
    expect(full.model).not.toHaveBeenCalled()
    expect(viewFlushMarks()).toBe(1)
  })

  it('clearing view fields (decor removed, skin set to undefined) deletes the keys in the DiagramDoc', async () => {
    const ws = await boot()
    const full = watchFullWrite(ws)
    useModelStore.getState().setDiagramSceneDecor('d1', null)
    useModelStore.getState().updateDiagram('d1', { skinId: undefined })
    await flushByTeardown()
    const doc = read(ws.d1Doc)
    expect('sceneDecor' in doc).toBe(false)
    expect('skinId' in doc).toBe(false)
    expect(full.shard).not.toHaveBeenCalled()
  })

  it('a view edit followed by a structural edit before the flush persists BOTH through the full write', async () => {
    const ws = await boot()
    useModelStore.getState().updateDiagram('d1', { skinId: 'studio' })
    useModelStore.getState().updateDiagram('d1', { name: 'Renamed' })
    await flushByTeardown()
    const doc = read(ws.d1Doc)
    expect(doc.skinId).toBe('studio')
    expect(doc.name).toBe('Renamed')
    expect(read(ws.shard).diagrams.d1.name).toBe('Renamed')
  })

  it('a rename alone is NOT taken by the view path (the registry meta carries the name)', async () => {
    const ws = await boot()
    const full = watchFullWrite(ws)
    useModelStore.getState().updateDiagram('d1', { name: 'Renamed only' })
    await flushByTeardown()
    // Witness control: the full write IS visible to the shard spy, so its
    // silence in the targeted tests above is a measurement, not a blind spot.
    expect(full.shard).toHaveBeenCalled()
    expect(read(ws.shard).diagrams.d1.name).toBe('Renamed only')
    expect(read(ws.d1Doc).name).toBe('Renamed only')
    expect(viewFlushMarks()).toBe(0)
  })

  it('a view edit of a NON-active diagram never writes into the active diagram document', async () => {
    const ws = await boot()
    useModelStore.getState().updateDiagram('d2', { skinId: 'studio' })
    await flushByTeardown()
    expect(read(ws.d1Doc).skinId).toBe('old-skin')
    expect(viewFlushMarks()).toBe(0)
  })

  it('the pending view set is DRAINED by each flush: after a switch, the next diagram view edit is still targeted', async () => {
    const ws = await boot()
    const { getActiveDiagramHandle } = await import('./bridge')

    // 1) view edit on d1, flushed by the ordinary debounce (no teardown).
    useModelStore.getState().updateDiagram('d1', { skinId: 'studio' })
    await vi.waitFor(() => expect(read(ws.d1Doc).skinId).toBe('studio'), { timeout: 3_000 })
    expect(viewFlushMarks()).toBe(1)

    // 2) switch to d2 and wait until its doc is the active one.
    useModelStore.getState().setCurrentDiagram('d2')
    await vi.waitFor(() => expect(getActiveDiagramHandle()?.url).toBe(ws.d2Doc.url), { timeout: 3_000 })
    await vi.waitFor(() => expect(useModelStore.getState().diagrams.find((d) => d.id === 'd2')?.layouts?.o1).toBeDefined(), { timeout: 3_000 })

    // 3) a view edit on d2 must take the targeted path. A set still holding
    //    the stale 'd1' entry would fail the every-id-is-active guard and fall
    //    back to the full write on every later view edit and every drag.
    const full = watchFullWrite(ws)
    useModelStore.getState().updateDiagram('d2', { skinId: 'studio' })
    await vi.waitFor(() => expect(read(ws.d2Doc).skinId).toBe('studio'), { timeout: 3_000 })
    expect(viewFlushMarks()).toBe(2)
    expect(full.shard).not.toHaveBeenCalled()
    expect(read(ws.d1Doc).skinId).toBe('studio')
  })
})
