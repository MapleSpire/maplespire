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
 * DEFECT 2026-10-21 (isolated dev stack, classic monolith workspace): a
 * Structurizr import of 15 laid-out views, opened without a reload, showed
 * every shape of a non-first view with NO position. The registry meta of the
 * imported views carried `docUrl: ''`, and every later flush minted another
 * position-less DiagramDoc for each of them (14 documents every ~730 ms).
 *
 * The mechanism, traced with a store subscription + Map/repo probes in the
 * browser: `ensureDiagramDoc` records the new document in `docUrlById`, the
 * create→flush→publish gate holds the meta back, and `projectAll` — which runs
 * SYNCHRONOUSLY on the echo of flushWrite's own model write, and on any
 * colleague's registry edit — rebuilds `docUrlById` from the registry shards
 * alone, dropping every document whose meta is not placed yet.
 *
 * Driven through the REAL bridge on real Automerge handles (the
 * bridgeDiagramViewWrite.test.ts pattern): store action → onStoreChange →
 * flushWrite → documents.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { DEFAULT_WORKSPACE_REF } from './workspace'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import type { C4Object, Diagram } from '../../types'

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

function diagramDoc(name: string) {
  return {
    name, type: 'context',
    objectIds: ['o1'], connectionIds: [], groupIds: [],
    layouts: { o1: { position: { x: 1, y: 2 }, size: { width: 200, height: 100 } } },
    comments: {}, flows: {}, checkpoints: [],
  }
}

function workspace(extraMetas: Record<string, unknown> = {}) {
  const repo = repoModule.repo
  const d1Doc = repo.create<any>(diagramDoc('Existing diagram'))
  const shard = repo.create<any>({
    diagrams: {
      d1: { id: 'd1', name: 'Existing diagram', type: 'context', docUrl: d1Doc.url, objectIds: ['o1'], connectionIds: [], groupIds: [] },
      ...extraMetas,
    },
  })
  const model = repo.create<any>({
    objects: { o1: objectEntity('o1') },
    connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const root = repo.create<any>({ modelUrl: model.url, shardUrls: [shard.url] })
  return { root, model, shard, d1Doc }
}

type Workspace = ReturnType<typeof workspace>

async function boot(extraMetas: Record<string, unknown> = {}): Promise<Workspace> {
  const ws = workspace(extraMetas)
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(ws.root as any)
  vi.spyOn(repoModule, 'getModelHandle').mockResolvedValue(ws.model as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([ws.shard] as any)
  vi.spyOn(repoModule, 'findDiagramHandle').mockImplementation(async (url: string) =>
    repoModule.repo.find<any>(url as any) as any)
  vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
  vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
  const { startBridge, getActiveDiagramHandle } = await import('./bridge')
  await startBridge(DEFAULT_WORKSPACE_REF)
  // Guard against a void run: a classic boot on d1's REAL doc.
  expect(useAutomergeStatus.getState().status).not.toBe('error')
  expect(useModelStore.getState().currentDiagramId).toBe('d1')
  expect(getActiveDiagramHandle()?.url).toBe(ws.d1Doc.url)
  return ws
}

const IMPORTED = ['n1', 'n2', 'n3'] as const

/** What ImportModal hands `importModel`: objects plus fully laid-out diagrams. */
function importPayload() {
  const objects = IMPORTED.map((id) => ({ ...objectEntity(`o-${id}`) }) as unknown as C4Object)
  const diagrams = IMPORTED.map((id, i) => ({
    id,
    name: `Imported ${id}`,
    type: 'context',
    objectIds: [`o-${id}`],
    connectionIds: [],
    groupIds: [],
    layouts: { [`o-${id}`]: { position: { x: 100 + i * 10, y: 200 + i * 10 }, size: { width: 200, height: 100 } } },
  }) as unknown as Diagram)
  return { objects, connections: [], groups: [], tags: [], diagrams }
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** The materialized doc as plain data (every handle here is created ready). */
const read = (handle: { doc(): unknown }) => handle.doc() as any

/** Hold the local durability flush of every document minted for `names` until
 *  released — the window in which the create→flush→publish gate holds a meta. */
function holdDurability(created: Map<string, string[]>, names: string[]): () => void {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const flush = repoModule.repo.flush.bind(repoModule.repo)
  vi.spyOn(repoModule.repo, 'flush').mockImplementation(((ids?: string[]) => {
    const urls = names.flatMap((name) => created.get(name) ?? [])
    const holds = ids?.some((id) => urls.some((url) => url.endsWith(id)))
    return holds ? held.then(() => flush(ids as any)) : flush(ids as any)
  }) as any)
  return release
}

/** Every DiagramDoc the bridge creates, by diagram name. */
function watchCreatedDocs() {
  const created = new Map<string, string[]>()
  const original = repoModule.createDiagramHandle
  vi.spyOn(repoModule, 'createDiagramHandle').mockImplementation((initial: any) => {
    const handle = original(initial)
    created.set(initial.name, [...(created.get(initial.name) ?? []), handle.url])
    return handle
  })
  return created
}

describe('a Structurizr import keeps every view\'s DiagramDoc (classic workspace)', () => {
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

  it('publishes each imported view once, with its positions — the import alone', async () => {
    const ws = await boot()
    const created = watchCreatedDocs()

    // ImportModal.applyResultIntoCurrentWorkspace: import, then land on the entry view.
    // The echo of our own write is the shard-changing projection here.
    useModelStore.getState().importModel(importPayload())
    useModelStore.getState().setCurrentDiagram('n1')
    await settle(1600)

    await expectImportedViewsPublished(ws, created)
  })

  it('publishes each imported view once, with its positions — a colleague edits the registry while they wait', async () => {
    const ws = await boot()
    const created = watchCreatedDocs()
    // Keep the imported metas behind the create→flush→publish gate (jsdom has no
    // storage adapter, so an unheld flush confirms at once and the window is gone).
    const release = holdDurability(created, IMPORTED.map((id) => `Imported ${id}`))

    useModelStore.getState().importModel(importPayload())
    useModelStore.getState().setCurrentDiagram('n1')
    await settle(400)
    expect(IMPORTED.filter((id) => read(ws.shard).diagrams[id]), 'metas held back').toEqual([])
    // A colleague's registry edit: projectAll rebuilds the doc-url index from
    // shards that name none of the imported documents yet.
    ws.shard.change((doc: any) => {
      doc.diagrams.d1.name = 'Renamed by a colleague'
    })
    await settle(400)
    release()
    await settle(1200)

    await expectImportedViewsPublished(ws, created)
  })

  async function expectImportedViewsPublished(ws: Workspace, created: Map<string, string[]>) {
    const { getActiveDiagramHandle } = await import('./bridge')
    const metas = read(ws.shard).diagrams
    for (const [i, id] of IMPORTED.entries()) {
      const name = `Imported ${id}`
      expect(created.get(name), `${name}: documents created`).toHaveLength(1)
      const meta = metas[id]
      expect(meta, `${name}: meta placed`).toBeDefined()
      expect(meta.docUrl, `${name}: published docUrl`).toBe(created.get(name)![0])
      const doc = read(await repoModule.repo.find<any>(meta.docUrl))
      expect(doc.layouts[`o-${id}`]?.position, `${name}: positions`).toEqual({ x: 100 + i * 10, y: 200 + i * 10 })
    }
    // The entry view opened on its own document, positions included.
    expect(getActiveDiagramHandle()?.url).toBe(metas.n1.docUrl)
    expect(useModelStore.getState().getCurrentDiagram()?.layouts?.['o-n1']?.position).toEqual({ x: 100, y: 200 })
  }

  it('heals a meta already published with an empty docUrl: one new document, then the meta names it', async () => {
    // What the defect left in real registries: a meta naming no document.
    const ws = await boot({
      z1: { id: 'z1', name: 'Damaged diagram', type: 'context', docUrl: '', objectIds: ['o1'], connectionIds: [], groupIds: [] },
    })
    const created = watchCreatedDocs()
    // Until the new document is locally durable, the meta must keep naming
    // nothing rather than a document that could die with the tab.
    const release = holdDurability(created, ['Damaged diagram'])

    // Several ordinary writes, each a full flush with its own echo.
    for (const name of ['first', 'second', 'third']) {
      useModelStore.getState().updateDiagram('d1', { name })
      await settle(400)
    }
    const minted = created.get('Damaged diagram') ?? []
    expect(minted, 'documents minted for the damaged diagram').toHaveLength(1)
    expect(read(ws.shard).diagrams.z1.docUrl, 'repointed before durable').toBe('')

    release()
    await settle(400)
    expect(created.get('Damaged diagram'), 'documents minted after durability').toHaveLength(1)
    expect(read(ws.shard).diagrams.z1.docUrl).toBe(minted[0])
  })

  // From the QA review lens: a view deleted while its meta is still held is in
  // no shard, so no registry removal can retire its record — only retainOnly
  // does. And the durability gate is keyed by diagram, so the dead document
  // confirming must not lift the gate of the same id's next document.
  it('a view deleted before its meta is placed leaves nothing resolvable, and a same-id re-creation gets its own document', async () => {
    const ws = await boot()
    const created = watchCreatedDocs()
    const release = holdEachDurability(created, ['Imported n1'])

    useModelStore.getState().importModel(importPayload())
    await settle(400)
    const [dead] = created.get('Imported n1') ?? []
    expect(dead, 'n1 got a document').toBeDefined()
    expect(read(ws.shard).diagrams.n1, 'n1 meta held back').toBeUndefined()

    useModelStore.getState().deleteDiagram('n1')
    await settle(400)
    // Any shard-changing projection rebuilds the index (here a colleague's edit).
    ws.shard.change((doc: any) => { doc.diagrams.d1.name = 'Renamed by a colleague' })
    await settle(400)
    const probe = (window as any).__diagramDocUrl as (id: string) => string | undefined
    expect(probe('n1'), 'deleted view still resolvable').toBeUndefined()

    // The same id comes back (an undo of the delete), with a moved shape.
    const [n1] = importPayload().diagrams
    useModelStore.getState().importModel({
      objects: [], connections: [], groups: [], tags: [],
      diagrams: [{ ...n1, layouts: { 'o-n1': { position: { x: 500, y: 600 }, size: { width: 200, height: 100 } } } } as Diagram],
    })
    await settle(400)
    const docs = created.get('Imported n1') ?? []
    expect(docs, 'the re-creation mints its own document').toHaveLength(2)

    // The dead document confirming first must not lift the new one's gate.
    release(dead)
    await settle(400)
    expect(read(ws.shard).diagrams.n1, 'meta placed before its document is durable').toBeUndefined()

    release(docs[1])
    await settle(800)
    const meta = read(ws.shard).diagrams.n1
    expect(meta?.docUrl).toBe(docs[1])
    expect(read(await repoModule.repo.find<any>(meta.docUrl)).layouts['o-n1'].position).toEqual({ x: 500, y: 600 })
  })
})

/** Hold each document minted for `names` separately; `release(url)` lets one
 *  confirm. The real flush starts at once and only its confirmation is held,
 *  one resolver per call — a document is flushed more than once (durable
 *  tracking too), and keeping only the last resolver would hang the others. */
function holdEachDurability(created: Map<string, string[]>, names: string[]): (url: string) => void {
  const gates = new Map<string, Array<() => void>>()
  const released = new Set<string>()
  const flush = repoModule.repo.flush.bind(repoModule.repo)
  vi.spyOn(repoModule.repo, 'flush').mockImplementation(((ids?: string[]) => {
    const url = names.flatMap((name) => created.get(name) ?? [])
      .find((candidate) => ids?.some((id) => candidate.endsWith(id)))
    if (!url || released.has(url)) return flush(ids as any)
    const inFlight = flush(ids as any)
    return new Promise<void>((resolve) => {
      gates.set(url, [...(gates.get(url) ?? []), resolve])
    }).then(() => inFlight)
  }) as any)
  return (url) => {
    released.add(url)
    for (const resolve of gates.get(url) ?? []) resolve()
    gates.delete(url)
  }
}
