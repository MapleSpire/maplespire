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
 * Lifecycle of `unpublishedDiagramDocUrls` (bridge.ts), beside the window test
 * in bridgeCreatedDocUrl.test.ts. Written by the QA review lens on 2026-10-18,
 * each case against a mutant the window test left alive: a locally deleted
 * diagram, a peer delete after publication, a peer meta for the same id, and a
 * session teardown must each leave the index saying what the registry says.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { DEFAULT_WORKSPACE_REF } from './workspace'
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

function objectEntity(id: string) {
  return {
    id, type: 'container', name: `Container ${id}`,
    position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
    tagAssignments: {}, tagOrder: [], properties: {},
    scope: 'internal', status: 'live',
  }
}

const LAYOUTS = {
  o1: { position: { x: 40, y: 60 }, size: { width: 200, height: 100 } },
  o2: { position: { x: 400, y: 60 }, size: { width: 200, height: 100 } },
}

function workspace() {
  const repo = repoModule.repo
  const d1 = repo.create<any>({
    name: 'Diagram d1', type: 'container', objectIds: ['o1'], connectionIds: [], groupIds: [],
    layouts: { o1: LAYOUTS.o1 }, comments: {}, flows: {}, checkpoints: [],
  })
  const d2 = repo.create<any>({
    name: 'Diagram d2', type: 'container', objectIds: ['o2'], connectionIds: [], groupIds: [],
    layouts: { o2: LAYOUTS.o2 }, comments: {}, flows: {}, checkpoints: [],
  })
  const meta = (id: string, docUrl: string, objectIds: string[]) =>
    ({ id, name: `Diagram ${id}`, type: 'container', docUrl, objectIds, connectionIds: [], groupIds: [] })
  const shard = repo.create<any>({ diagrams: { d1: meta('d1', d1.url, ['o1']), d2: meta('d2', d2.url, ['o2']) } })
  const objectShard = repo.create<any>({ objects: { o1: objectEntity('o1'), o2: objectEntity('o2') } })
  const connectionShard = repo.create<any>({ connections: {} })
  const modelMeta = repo.create<any>({
    objectShardUrls: [objectShard.url],
    connectionShardUrls: [connectionShard.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const root = repo.create<any>({ shardUrls: [shard.url], modelMetaUrl: modelMeta.url })
  return { root, shard, objectShard, connectionShard, modelMeta, docs: { d1, d2 } as Record<string, any>, meta }
}

const read = (handle: { doc(): unknown }) => handle.doc() as any
const probe = (id: string) => ((window as any).__diagramDocUrl as (id: string) => string | undefined)(id)

async function boot(ws: ReturnType<typeof workspace>) {
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(ws.root as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([ws.shard] as any)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(ws.modelMeta as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockImplementation(async (urls: readonly string[]) =>
    urls.map((url) => (url === ws.objectShard.url ? ws.objectShard : ws.connectionShard)) as any)
  vi.spyOn(repoModule, 'findDiagramHandle').mockImplementation(async (url: string) => {
    for (const handle of Object.values(ws.docs)) if (handle.url === url) return handle
    throw new Error(`unexpected diagram url ${url}`)
  })
  vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
  vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
  const { startBridge } = await import('./bridge')
  await startBridge(DEFAULT_WORKSPACE_REF)
  expect(useModelStore.getState().currentDiagramId).toBe('d1')
}

/** Create dNew while every flush is held; returns the doc and the release list. */
async function createGated(ws: ReturnType<typeof workspace>) {
  const releases: Array<() => void> = []
  const flush = vi.spyOn(repoModule.repo, 'flush').mockImplementation(() =>
    new Promise<void>((resolve) => { releases.push(resolve) }))
  const created = vi.spyOn(repoModule, 'createDiagramHandle')
  useModelStore.getState().importModel({
    objects: [], connections: [], groups: [],
    diagrams: [{
      id: 'dNew', name: 'Imported view', type: 'container',
      objectIds: ['o1', 'o2'], connectionIds: [], groupIds: [], layouts: LAYOUTS,
    }],
  })
  await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1))
  expect(read(ws.shard).diagrams.dNew).toBeUndefined()
  return { newDoc: created.mock.results[0]!.value as any, releases, flush, created }
}

async function peerRename(ws: ReturnType<typeof workspace>, name: string) {
  ws.shard.change((doc: any) => { doc.diagrams.d2.name = name })
  await vi.waitFor(() =>
    expect(useModelStore.getState().diagrams.find((d) => d.id === 'd2')?.name).toBe(name))
}

describe('QA: unpublished diagram doc url lifecycle', () => {
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
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
  })

  it('a gated diagram deleted locally stays unresolvable across a rebuild (RED without the delete-time retire)', async () => {
    const ws = workspace()
    await boot(ws)
    const { newDoc } = await createGated(ws)
    expect(probe('dNew')).toBe(newDoc.url)
    useModelStore.getState().deleteDiagram('dNew')
    await new Promise((r) => setTimeout(r, 1500))
    await peerRename(ws, 'Peer 1')
    expect(probe('dNew'), 'a tombstoned diagram came back resolvable').toBeUndefined()
  })

  // QA lens, 2026-10-21 (mutants B13 / X1): `forgetDiagramDocUrl` retiring the
  // UNPUBLISHED url too was dead to every test. Its one resident path: a shard
  // meta with an EMPTY docUrl (the shape the original defect persisted, still in
  // real databases) keeps our entry alive, and the diagram then leaves the store
  // with no explicit-delete intent (an undone import), so only the flush's
  // removal of that meta can retire it. The tombstone guard in
  // `restoreUnpublishedDiagramDocUrls` has no such path: tombstones exist only
  // under `registrySummaryOnly`, which implies `bfsActive`, and `projectAll`
  // returns before the rebuild in that mode.
  it('a diagram whose empty-url meta the flush removes is not made resolvable again (RED when forget skips the unpublished url)', async () => {
    const ws = workspace()
    await boot(ws)
    const { newDoc } = await createGated(ws)
    ws.shard.change((doc: any) => { doc.diagrams.dNew = ws.meta('dNew', '', ['o1', 'o2']) })
    await peerRename(ws, 'Peer 1')
    expect(probe('dNew'), 'the empty meta must not retire our url').toBe(newDoc.url)

    // No explicit-delete intent: the diagram simply leaves the store.
    useModelStore.setState({ diagrams: useModelStore.getState().diagrams.filter((d) => d.id !== 'dNew') })
    await vi.waitFor(() => expect(read(ws.shard).diagrams.dNew).toBeUndefined(), { timeout: 5000 })
    await peerRename(ws, 'Peer 2')
    expect(probe('dNew'), 'a removed diagram came back resolvable').toBeUndefined()
  })

  it('a published-then-remotely-deleted diagram is not resurrected by a later rebuild (RED when entries never retire)', async () => {
    const ws = workspace()
    await boot(ws)
    const { newDoc, releases } = await createGated(ws)
    for (const release of releases.splice(0)) release()
    await vi.waitFor(() => expect(read(ws.shard).diagrams.dNew?.docUrl).toBe(newDoc.url))
    for (const release of releases.splice(0)) release()
    await peerRename(ws, 'Peer 1') // a rebuild that sees the meta: entry retires
    ws.shard.change((doc: any) => { delete doc.diagrams.dNew })
    await vi.waitFor(() =>
      expect(useModelStore.getState().diagrams.some((d) => d.id === 'dNew')).toBe(false))
    await peerRename(ws, 'Peer 2')
    expect(probe('dNew'), 'a peer-deleted diagram came back resolvable').toBeUndefined()
  })

  it('the shard wins over the unpublished url (RED when the unpublished url wins)', async () => {
    const ws = workspace()
    await boot(ws)
    const { newDoc } = await createGated(ws)
    const other = ws.docs.d2.url
    expect(other).not.toBe(newDoc.url)
    ws.shard.change((doc: any) => { doc.diagrams.dNew = ws.meta('dNew', other, ['o2']) })
    await vi.waitFor(() => expect(probe('dNew')).toBe(other))
    await peerRename(ws, 'Peer 1')
    expect(probe('dNew')).toBe(other)
  })

  it('a stopped session does not leak its unpublished url into the next one (RED without the clear in stopBridge)', async () => {
    const ws = workspace()
    await boot(ws)
    const { newDoc } = await createGated(ws)
    expect(probe('dNew')).toBe(newDoc.url)
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    useModelStore.setState({
      objects: [], connections: [], groups: [], diagrams: [],
      comments: [], flows: [], currentDiagramId: null,
    })
    const ws2 = workspace()
    await boot(ws2)
    expect(probe('dNew'), 'previous session url leaked').toBeUndefined()
  })
})
