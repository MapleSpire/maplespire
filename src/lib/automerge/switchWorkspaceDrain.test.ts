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
 * T-DIAGDEF — a delete made just before a WORKSPACE SWITCH
 * reaches the server without waiting for the user to come back.
 *
 * As found by hand: ordinary workspace, a diagram deleted (not open), the workspace
 * switched within 0.24–2 s — the `ro_diagrams` row stayed for as long as the
 * user stayed away (70 s measured) and left 0.4–0.8 s after the return. The
 * not-open delete waits in the write debounce (150 ms); `stopBridge`'s
 * lifecycle flush writes it into the registry shard, and the switch removed
 * the workspace's socket in the same tick: the change never left the browser.
 *
 * The REAL bridge and REAL Automerge handles (the convergence suite's
 * pattern); the socket route and the durable-heads route are observed.
 */

// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getHeads } from '@automerge/automerge'
import * as repoModule from './repo'
import { repo } from './repo'
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
    update: async (key: string, fn: (value: unknown) => unknown) => { kv.set(key, fn(kv.get(key))) },
  }),
}))

const mocks = vi.hoisted(() => ({
  fetchDiagramListPage: vi.fn(),
  fetchDiagramMeta: vi.fn(),
  fetchDiagramRender: vi.fn(),
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
}))

/** One workspace per test: the entity-intent journal is per workspace, and a
 * delete journaled by one test must not be replayed into the next one's boot. */
let ORDINARY = { landscapeId: 'ordinary-bfs-0', versionId: 'current' }
let round = 0
const OTHER = { landscapeId: 'summary-elsewhere', versionId: 'current' }

async function settleWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 100))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const shardMeta = (id: string) => ({ id, name: id, type: 'container', docUrl: '', objectIds: [], connectionIds: [], groupIds: [] })

function ordinaryFixture() {
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
  const registry = repo.create<RegistryShard>({
    diagrams: { 'dg-open': shardMeta('dg-open'), 'dg-not-open': shardMeta('dg-not-open') },
  } as unknown as RegistryShard)
  const root = repo.create<RootDoc>({
    modelUrl: '', modelMetaUrl: meta.url, shardUrls: [registry.url], registryWriteUrl: writeHead.url,
  } as unknown as RootDoc)
  // The OTHER workspace never boots here: what is judged ends at its route.
  vi.spyOn(repoModule, 'getRootHandle').mockImplementation(async (ref) => {
    if (ref?.landscapeId === OTHER.landscapeId) throw new Error('the other workspace is not part of this scenario')
    return root as any
  })
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(meta as any)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([registry] as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
  return { registry }
}

type Ask = { at: number; landscapeId: string | null; documents: Array<{ documentId: string; heads: string[] }> }

describe('T-DIAGDEF — a delete before a workspace switch leaves on the OUTGOING socket', () => {
  let events: Array<{ at: number; route?: string; ask?: Ask }>
  let durable: (documentId: string) => boolean
  let connectedPeer = true

  beforeEach(async () => {
    kv.clear()
    round += 1
    ORDINARY = { landscapeId: `ordinary-bfs-${round}`, versionId: 'current' }
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    const { __resetIndexReady } = await import('../modelQuery/offlineIndex')
    __resetIndexReady()
    localStorage.clear()
    vi.clearAllMocks()
    mocks.fetchDiagramRender.mockRejectedValue(new Error('offline in this suite'))
    mocks.fetchDiagramListPage.mockResolvedValue({ items: [], nextCursor: null, total: 0 })
    mocks.fetchDiagramMeta.mockResolvedValue(undefined)
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
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
    events = []
    durable = () => true
    // The suite's Repo has no network: the outgoing transport is SAID to have
    // its server peer, unless a test cuts it. Guarded so this
    // file still runs on a tree that predates the seam (the red run).
    connectedPeer = true
    if ('hasConnectedSyncPeer' in repoModule) {
      vi.spyOn(repoModule as any, 'hasConnectedSyncPeer').mockImplementation(() => connectedPeer)
    }
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockImplementation(async (ref) => {
      events.push({ at: Date.now(), route: `${ref.landscapeId}/${ref.versionId}` })
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (!url.pathname.endsWith('/api/automerge/durable-heads')) return new Response('{}', { status: 404 })
      const body = JSON.parse(String(init?.body ?? '{}')) as { documents: Ask['documents'] }
      events.push({ at: Date.now(), ask: { at: Date.now(), landscapeId: url.searchParams.get('landscapeId'), documents: body.documents } })
      return new Response(JSON.stringify({
        documents: body.documents.map((document) => ({ documentId: document.documentId, durable: durable(document.documentId) })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
    kv.clear()
  })

  async function bootAndDeleteNotOpen() {
    localStorage.setItem('maplespire:bootFromServer', 'true')
    const f = ordinaryFixture()
    const { startBridge, isBootFromServerActive } = await import('./bridge')
    const { setActiveWorkspaceRef } = await import('./workspace')
    setActiveWorkspaceRef(ORDINARY)
    await startBridge(ORDINARY)
    expect(isBootFromServerActive()).toBe(true)
    useModelStore.getState().setCurrentDiagram('dg-open')
    await settleWrites()
    expect(Object.keys(f.registry.doc()?.diagrams ?? {}).sort()).toEqual(['dg-not-open', 'dg-open'])
    events.length = 0
    // NOT the open diagram: its delete waits in the write debounce.
    useModelStore.getState().deleteDiagram('dg-not-open')
    return f
  }

  it('the route moves only after the OUTGOING server acknowledged the delete durable', async () => {
    const f = await bootAndDeleteNotOpen()
    const { switchWorkspace } = await import('./switchWorkspace')
    const switching = switchWorkspace(OTHER) // inside the debounce, as the 0.24 s found by hand
    await switching.catch(() => undefined)

    // The stop's lifecycle flush expressed the delete in the registry shard…
    expect(Object.keys(f.registry.doc()?.diagrams ?? {})).toEqual(['dg-open'])
    const afterDelete = [...getHeads(f.registry.doc() as never)].sort()
    const routeAway = events.findIndex((event) => event.route === `${OTHER.landscapeId}/${OTHER.versionId}`)
    expect(routeAway, JSON.stringify(events)).toBeGreaterThanOrEqual(0)
    // …and BEFORE the socket moved, the workspace it belongs to was asked —
    // and answered — that this very frontier is durable. Before: the route
    // came first and no ask named it (the change stayed in the browser).
    const drained = events.slice(0, routeAway).filter((event) => event.ask?.landscapeId === ORDINARY.landscapeId
      && event.ask.documents.some((document) => document.documentId === f.registry.documentId
        && [...document.heads].sort().join() === afterDelete.join()))
    expect(drained.length, JSON.stringify(events.map((event) => event.route ?? `ask:${event.ask?.landscapeId}`))).toBeGreaterThan(0)
  })

  it('it asks again until the frontier is durable, then routes at once', async () => {
    const f = await bootAndDeleteNotOpen()
    let asks = 0
    durable = (documentId) => documentId !== f.registry.documentId || ++asks >= 3
    const { switchWorkspace } = await import('./switchWorkspace')
    await switchWorkspace(OTHER).catch(() => undefined)
    const routeAway = events.findIndex((event) => event.route === `${OTHER.landscapeId}/${OTHER.versionId}`)
    const asked = events.slice(0, routeAway).filter((event) => event.ask?.documents.some((d) => d.documentId === f.registry.documentId))
    expect(asked.length).toBeGreaterThanOrEqual(3)
    expect(events[routeAway]!.at - asked.at(-1)!.at).toBeLessThan(500)
  })

  it('a write the server refuses for good (never durable, nothing moves) holds the switch well under 3 s, and the ledger still owes it', async () => {
    const f = await bootAndDeleteNotOpen()
    durable = () => false
    const { switchWorkspace } = await import('./switchWorkspace')
    const startedAt = Date.now()
    await switchWorkspace(OTHER).catch(() => undefined)
    const routed = events.find((event) => event.route === `${OTHER.landscapeId}/${OTHER.versionId}`)!
    // Before: the whole 3 s bound, every switch.
    expect(routed.at - startedAt).toBeLessThan(1_800)
    expect(events.filter((event) => event.ask?.landscapeId === ORDINARY.landscapeId).length).toBeGreaterThanOrEqual(2)
    // Nothing lost: the persisted ledger re-presents it when the workspace is opened again.
    const ledger = JSON.stringify([...kv.values()])
    expect(ledger).toContain(f.registry.documentId)
  }, 15_000)

  it('no peer on the outgoing transport (navigator still online) — no ask, the route moves at once', async () => {
    await bootAndDeleteNotOpen()
    durable = () => false
    connectedPeer = false
    const { switchWorkspace } = await import('./switchWorkspace')
    const startedAt = Date.now()
    await switchWorkspace(OTHER).catch(() => undefined)
    const routed = events.find((event) => event.route === `${OTHER.landscapeId}/${OTHER.versionId}`)!
    // Before: 3 s of asks no socket could ever satisfy.
    expect(routed.at - startedAt).toBeLessThan(300)
    expect(events.filter((event) => event.ask?.landscapeId === ORDINARY.landscapeId)).toEqual([])
  }, 15_000)

  it('control: a switch with nothing owed asks nothing and routes at once', async () => {
    localStorage.setItem('maplespire:bootFromServer', 'true')
    ordinaryFixture()
    const { startBridge } = await import('./bridge')
    const { setActiveWorkspaceRef } = await import('./workspace')
    setActiveWorkspaceRef(ORDINARY)
    await startBridge(ORDINARY)
    useModelStore.getState().setCurrentDiagram('dg-open')
    await settleWrites()
    durable = () => true
    // Whatever the boot owed is acknowledged by the session's own loop first.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    events.length = 0
    const { switchWorkspace } = await import('./switchWorkspace')
    const startedAt = Date.now()
    await switchWorkspace(OTHER).catch(() => undefined)
    const routed = events.find((event) => event.route === `${OTHER.landscapeId}/${OTHER.versionId}`)!
    expect(routed.at - startedAt).toBeLessThan(500)
  }, 15_000)
})
