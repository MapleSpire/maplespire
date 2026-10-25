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
 * USER REPORT 2026-10-21 (SAOE, FSSystemContext): after Auto-layout the
 * reciprocal pair Inspecteur ↔ Power Platform — two derived (`kind: 'lower'`)
 * connections — drew as one braided double line. Reproduced on an isolated
 * stack: the routing Auto-layout wrote to the lowers was gone within ~2 s, by
 * this path: the scheduled flush writes a model shard → its 'change' listener →
 * projectAll replaces `connections` from the shards (which hold no lowers) →
 * syncLowerConnections mints new lowers, new ids, no routing. A reload lost
 * every lower's routing, because nothing persisted it.
 *
 * Driven through the REAL bridge on a SHARDED classic workspace (real
 * Automerge handles on the module repo, resolvers spied — the
 * bridgeConnectWrite.test.ts pattern), with the bridge RUNNING while the
 * scheduled flush lands, so the re-projection happens exactly as in the app.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { DEFAULT_WORKSPACE_REF } from './workspace'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { filterAndMergeDiagramData } from '../viewLayouts'
import type { Connection } from '../../types'

vi.mock('../modelQuery/kvStore', () => ({
  workspaceKvStore: () => ({
    get: async () => undefined,
    set: async () => undefined,
    del: async () => undefined,
    update: async () => undefined,
  }),
}))

function objectEntity(id: string, parentId?: string) {
  return {
    id, type: parentId ? 'container' : 'system', name: id,
    position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
    tagAssignments: {}, tagOrder: [], properties: {},
    scope: 'internal', status: 'live',
    ...(parentId ? { parentId } : {}),
  }
}

function connectionEntity(id: string, fromId: string, toId: string) {
  return { id, fromId, toId, type: 'solid', shape: 'curved' }
}

// On d1: systems S and P (their containers s1/p1 talk both ways, so d1 rolls up
// the reciprocal lowers S→P and P→S) and X, whose DIRECT edge to S is what
// makes an Auto-layout write a model shard — the trigger of the re-projection.
function workspace() {
  const repo = repoModule.repo
  const objectIds = ['S', 'P', 'X']
  const layouts: Record<string, unknown> = {}
  objectIds.forEach((id, i) => { layouts[id] = { position: { x: i * 400, y: 0 }, size: { width: 200, height: 100 } } })
  const d1 = repo.create<any>({
    name: 'FSSystemContext', type: 'context', objectIds, connectionIds: ['cX'], groupIds: [], layouts,
    comments: {}, flows: {}, checkpoints: [],
  })
  // A second view of S and P, never opened in these tests (non-active).
  const d2 = repo.create<any>({
    name: 'Other view', type: 'context', objectIds: ['S', 'P'], connectionIds: [], groupIds: [], layouts: {},
    comments: {}, flows: {}, checkpoints: [],
  })
  const shard = repo.create<any>({
    diagrams: {
      d1: { id: 'd1', name: 'FSSystemContext', type: 'context', docUrl: d1.url, objectIds, connectionIds: ['cX'], groupIds: [] },
      d2: { id: 'd2', name: 'Other view', type: 'context', docUrl: d2.url, objectIds: ['S', 'P'], connectionIds: [], groupIds: [] },
    },
  })
  const objectShard = repo.create<any>({
    objects: {
      S: objectEntity('S'), P: objectEntity('P'), X: objectEntity('X'),
      s1: objectEntity('s1', 'S'), p1: objectEntity('p1', 'P'),
    },
  })
  const connectionShard = repo.create<any>({
    connections: {
      c1: connectionEntity('c1', 's1', 'p1'),
      c2: connectionEntity('c2', 'p1', 's1'),
      cX: connectionEntity('cX', 'X', 'S'),
    },
  })
  const modelMeta = repo.create<any>({
    objectShardUrls: [objectShard.url],
    connectionShardUrls: [connectionShard.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const root = repo.create<any>({ shardUrls: [shard.url], modelMetaUrl: modelMeta.url })
  return { root, shard, objectShard, connectionShard, modelMeta, d1, d2 }
}

type Workspace = ReturnType<typeof workspace>

const read = (handle: { doc(): unknown }) => handle.doc() as any
const state = () => useModelStore.getState()
const lowers = () => state().connections.filter((c) => c.kind === 'lower')
const lowerFor = (fromId: string, toId: string) => lowers().find((c) => c.fromId === fromId && c.toId === toId)

/** The lines the canvas draws for d1 (the merge every engine is fed through). */
function drawn(): Map<string, Connection> {
  const s = state()
  const diagram = s.diagrams.find((d) => d.id === 'd1')
  const { filteredConnections } = filterAndMergeDiagramData(diagram, s.objects, s.connections, s.groups)
  return new Map(filteredConnections.map((c) => [`${c.fromId}→${c.toId}`, c]))
}

function spyResolvers(ws: Workspace): void {
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(ws.root as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([ws.shard] as any)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(ws.modelMeta as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockImplementation(async (urls: readonly string[]) =>
    urls.map((url) => {
      if (url === ws.objectShard.url) return ws.objectShard
      if (url === ws.connectionShard.url) return ws.connectionShard
      throw new Error(`unexpected model shard url ${url}`)
    }) as any)
  vi.spyOn(repoModule, 'findDiagramHandle').mockImplementation(async (url: string) => {
    if (url === ws.d1.url) return ws.d1
    if (url === ws.d2.url) return ws.d2
    throw new Error(`unexpected diagram url ${url}`)
  })
  vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
  vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
}

function resetStores(): void {
  useModelStore.setState({
    objects: [], connections: [], groups: [], diagrams: [],
    comments: [], flows: [], currentDiagramId: null,
  })
  useAutomergeStatus.setState({
    status: 'connecting', ready: false, visualReady: false, editReady: false,
    projectedWorkspace: null, error: null, bootFallbackActive: false,
  })
}

async function start(): Promise<void> {
  const { startBridge, getActiveDiagramHandle } = await import('./bridge')
  await startBridge(DEFAULT_WORKSPACE_REF)
  // Guard against a void run: a sharded, resident boot on d1's REAL doc, the
  // whole model projected, and the deferred roll-up landed.
  expect(useAutomergeStatus.getState().status).not.toBe('error')
  expect(state().currentDiagramId).toBe('d1')
  expect(getActiveDiagramHandle()?.documentId).toBeDefined()
  expect(state().objects.map((o) => o.id).sort()).toEqual(['P', 'S', 'X', 'p1', 's1'])
  await vi.waitFor(() => expect(lowers().map((c) => `${c.fromId}→${c.toId}`).sort()).toEqual(['P→S', 'S→P']))
}

/** Auto-layout's result: the reciprocal pair on DIFFERENT ports, and X's direct
 * edge re-routed (which is what makes the flush write a model shard). */
function autoLayout(): void {
  state().applyDiagramLayout(
    'd1',
    {
      S: { position: { x: 0, y: 0 }, size: { width: 200, height: 100 } },
      P: { position: { x: 600, y: 0 }, size: { width: 200, height: 100 } },
      X: { position: { x: 0, y: 400 }, size: { width: 200, height: 100 } },
    },
    [
      { id: lowerFor('S', 'P')!.id, fromAnchor: 4, toAnchor: 10, lockedToAnchors: true, waypoints: [{ x: 400, y: -60 }] },
      { id: lowerFor('P', 'S')!.id, fromAnchor: 8, toAnchor: 2, lockedToAnchors: true },
      { id: 'cX', fromAnchor: 0, toAnchor: 6, lockedToAnchors: true },
    ],
  )
}

describe('lower routing through the real bridge (sharded classic workspace)', () => {
  beforeEach(async () => {
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    resetStores()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
  })

  it('Auto-layout routing of a reciprocal pair survives the re-projection its own flush triggers, and is persisted on the DiagramDoc', async () => {
    const ws = workspace()
    spyResolvers(ws)
    await start()
    const objectBeforeFlush = lowerFor('S', 'P')
    const idsBeforeFlush = lowers().map((c) => c.id).sort()

    autoLayout()
    // The scheduled flush, with the bridge running: the model shard write
    // (cX's anchors) re-projects through the shard listener. The DiagramDoc is
    // written later in the SAME synchronous flush.
    await vi.waitFor(() => expect(read(ws.connectionShard).connections.cX.fromAnchor).toBe(0), { timeout: 3_000 })

    // Witness that the re-projection RAN: the shard merge dropped the lowers
    // and the roll-up minted new objects. Without it this test proves nothing.
    expect(lowerFor('S', 'P')).toBeDefined()
    expect(lowerFor('S', 'P')).not.toBe(objectBeforeFlush)
    // …and the two lines still on their own ports…
    const lines = drawn()
    expect(lines.get('S→P')).toMatchObject({ fromAnchor: 4, toAnchor: 10, lockedToAnchors: true, waypoints: [{ x: 400, y: -60 }] })
    expect(lines.get('P→S')).toMatchObject({ fromAnchor: 8, toAnchor: 2, lockedToAnchors: true })
    // …under the same ids (a selection or flow step naming one still resolves).
    expect(lowers().map((c) => c.id).sort()).toEqual(idsBeforeFlush)

    // Persisted by pair on the DiagramDoc; no lower anywhere in the model.
    expect(JSON.parse(JSON.stringify(read(ws.d1).lowerRouting))).toEqual({
      'S→P': { fromAnchor: 4, toAnchor: 10, lockedToAnchors: true, waypoints: [{ x: 400, y: -60 }] },
      'P→S': { fromAnchor: 8, toAnchor: 2, lockedToAnchors: true },
    })
    expect(Object.keys(read(ws.connectionShard).connections).sort()).toEqual(['c1', 'c2', 'cX'])
    expect([...read(ws.d1).connectionIds]).toEqual(['cX'])
    expect([...read(ws.shard).diagrams.d1.connectionIds]).toEqual(['cX'])
  })

  it('a reload draws the lowers with the routing the DiagramDoc carries', async () => {
    const ws = workspace()
    spyResolvers(ws)
    await start()
    autoLayout()
    await vi.waitFor(() => expect(read(ws.d1).lowerRouting?.['P→S']).toBeDefined(), { timeout: 3_000 })

    const { stopBridge } = await import('./bridge')
    stopBridge()
    resetStores()
    await start()

    const lines = drawn()
    expect(lines.get('S→P')).toMatchObject({ fromAnchor: 4, toAnchor: 10, lockedToAnchors: true, waypoints: [{ x: 400, y: -60 }] })
    expect(lines.get('P→S')).toMatchObject({ fromAnchor: 8, toAnchor: 2, lockedToAnchors: true })
  })

  // QA lens 2026-10-22 (mutants B1-B3 survived): the off-active drain's wiring
  // for lower routes had no witness — only its predicate did.
  it('lower routing recorded for a NON-active diagram is drained into THAT diagram\'s doc, then retired', async () => {
    const ws = workspace()
    spyResolvers(ws)
    await start()
    expect(state().currentDiagramId).toBe('d1')

    state().applyDiagramLayout('d2', {}, [{ id: 'lower:S→P', fromAnchor: 6, lockedToAnchors: true }])

    await vi.waitFor(() => expect(read(ws.d2).lowerRouting?.['S→P']?.fromAnchor).toBe(6), { timeout: 5_000 })
    const { pendingPlacementIntents } = await import('./placementIntents')
    const { workspaceRefKey } = await import('./workspace')
    await vi.waitFor(
      () => expect(pendingPlacementIntents.snapshot(workspaceRefKey(DEFAULT_WORKSPACE_REF), 'd2')).toBeUndefined(),
      { timeout: 5_000 },
    )
    expect(read(ws.d1).lowerRouting?.['S→P']).toBeUndefined()
  })

  // QA lens 2026-10-22 (mutant B4 survived): by kind alone, a `lower:` id whose
  // object a projection dropped was persisted.
  it('a lower id whose object is gone is never persisted — filtered by the id, not only by the kind', async () => {
    const ws = workspace()
    spyResolvers(ws)
    await start()
    // What a projection that dropped the lower objects leaves until the roll-up runs.
    useModelStore.setState({
      diagrams: state().diagrams.map((d) => (d.id === 'd1' ? { ...d, connectionIds: [...d.connectionIds, 'lower:X→Z'] } : d)),
    })
    state().updateConnection('cX', { label: 'reads' })

    await vi.waitFor(() => expect(read(ws.connectionShard).connections.cX.label).toBe('reads'), { timeout: 3_000 })
    expect([...read(ws.d1).connectionIds]).toEqual(['cX'])
    expect([...read(ws.shard).diagrams.d1.connectionIds]).toEqual(['cX'])
  })

  it('a new DiagramDoc (a duplicate of a diagram that lists its lowers) never persists a lower id', async () => {
    const ws = workspace()
    spyResolvers(ws)
    await start()
    const source = state().diagrams.find((d) => d.id === 'd1')!
    expect(source.connectionIds.filter((id) => id.startsWith('lower:'))).toHaveLength(2)

    const copyId = state().duplicateDiagram(source, [], 'Copy')
    // Create → local flush → publish: the meta lands once the new doc is durable.
    await vi.waitFor(() => expect(read(ws.shard).diagrams[copyId]).toBeDefined(), { timeout: 5_000 })

    const meta = read(ws.shard).diagrams[copyId]
    expect([...meta.connectionIds]).toEqual(['cX'])
    const copyDoc = read(await repoModule.repo.find<any>(meta.docUrl))
    expect([...copyDoc.connectionIds]).toEqual(['cX'])
    expect(JSON.parse(JSON.stringify(copyDoc.lowerRouting))).toEqual({})
  })

  it('a layout that routes only lowers takes the targeted DiagramDoc write — and still persists them', async () => {
    const ws = workspace()
    spyResolvers(ws)
    await start()
    const connectionShardChange = vi.spyOn(ws.connectionShard, 'change')

    state().applyDiagramLayout('d1', {}, [
      { id: lowerFor('S', 'P')!.id, fromAnchor: 3, lockedToAnchors: true },
    ])
    await vi.waitFor(() => expect(read(ws.d1).lowerRouting?.['S→P']?.fromAnchor).toBe(3), { timeout: 3_000 })

    expect(connectionShardChange).not.toHaveBeenCalled()
    expect(drawn().get('S→P')).toMatchObject({ fromAnchor: 3, lockedToAnchors: true })
  })
})
