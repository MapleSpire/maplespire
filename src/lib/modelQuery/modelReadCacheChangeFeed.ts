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

import type { C4Object, Connection, Group } from '../../types'
import { workspaceApiFetch } from '../api/http'
import {
  currentWorkspaceRef,
  subscribeWorkspaceRef,
  workspaceRefKey,
  type WorkspaceRef,
} from '../automerge/workspace'
import type { CachedConnectionInput, CachedModelEntityInput, ModelCacheWorkspaceMeta } from './idbSchema'
import { downloadWorkspaceForOffline } from './modelReadCacheBootstrap'
import { isServerReadModelEnabled } from './tierFlag'
import { getModelReadCacheWorker } from './workerClient'
import { subscribeCurrentWorkspaceInvalidations } from './workspaceInvalidation'
import { notifyModelIndexChanged } from './indexSync'

import { API_BASE } from '../api/base'
const FEED_LIMIT = 100
const ID_BATCH = 100
const UPSERT_BATCH = 500
const POLL_INTERVAL_MS = 30_000

type EntityChange = {
  generation: number
  kind: 'objects' | 'connections'
  upsertIds: string[]
  deleteIds: string[]
}
type ResetChange = {
  generation: number
  kind: 'reset'
  scope: 'all' | 'groups' | 'diagrams' | 'connection_metrics'
}
type ReadModelChange = EntityChange | ResetChange

interface ChangeFeedPage {
  projectionGeneration: number
  events: ReadModelChange[]
  nextGeneration: number
  hasMore: boolean
  resetRequired: boolean
}

interface ObjectByIdsPage {
  projectionGeneration: number
  items: Array<Omit<CachedModelEntityInput, 'payload'> & { payload: Record<string, unknown> }>
}

interface ConnectionByIdsPage {
  projectionGeneration: number
  items: Array<Omit<CachedConnectionInput, 'connection'> & { connection: Record<string, unknown> }>
  nextCursor?: string | null
}

type ChangeAction = 'upsert' | 'delete'

const inFlight = new Map<string, Promise<void>>()

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size))
  return result
}

function workspaceParams(workspace: WorkspaceRef): URLSearchParams {
  return new URLSearchParams({ landscapeId: workspace.landscapeId, versionId: workspace.versionId })
}

async function getJson<T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const response = await workspaceApiFetch(`${API_BASE}${path}?${params.toString()}`, { signal })
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`)
  return response.json() as Promise<T>
}

function coalesce(events: ReadModelChange[], kind: EntityChange['kind']): Map<string, ChangeAction> {
  const actions = new Map<string, ChangeAction>()
  for (const event of events) {
    if (event.kind !== kind) continue
    for (const id of event.upsertIds) if (id) actions.set(id, 'upsert')
    for (const id of event.deleteIds) if (id) actions.set(id, 'delete')
  }
  return actions
}

function requireGeneration(actual: number, expected: number): void {
  if (!Number.isFinite(actual) || actual < expected) {
    throw new Error(`read-model cache endpoint is behind the change feed (${actual} < ${expected})`)
  }
}

async function fetchChangedObjects(
  workspace: WorkspaceRef,
  ids: string[],
  expectedGeneration: number,
  signal?: AbortSignal,
): Promise<CachedModelEntityInput[]> {
  const result: CachedModelEntityInput[] = []
  for (const batch of chunks(ids, ID_BATCH)) {
    const params = workspaceParams(workspace)
    params.set('ids', batch.join(','))
    const page = await getJson<ObjectByIdsPage>('/api/model/cache/objects/by-ids', params, signal)
    requireGeneration(page.projectionGeneration, expectedGeneration)
    result.push(...page.items.map((item) => ({
      ...item,
      payload: item.payload as unknown as C4Object | Group,
    })))
  }
  return result
}

async function fetchChangedConnections(
  workspace: WorkspaceRef,
  ids: string[],
  expectedGeneration: number,
  signal?: AbortSignal,
): Promise<CachedConnectionInput[]> {
  const result: CachedConnectionInput[] = []
  for (const batch of chunks(ids, ID_BATCH)) {
    const params = workspaceParams(workspace)
    params.set('ids', batch.join(','))
    const page = await getJson<ConnectionByIdsPage>('/api/model/cache/connections/by-ids', params, signal)
    requireGeneration(page.projectionGeneration, expectedGeneration)
    result.push(...page.items.map((item) => ({
      ...item,
      connection: item.connection as unknown as Connection,
    })))
  }
  return result
}

async function fetchAdjacentConnections(
  workspace: WorkspaceRef,
  endpointIds: string[],
  expectedGeneration: number,
  signal?: AbortSignal,
): Promise<CachedConnectionInput[]> {
  const byId = new Map<string, CachedConnectionInput>()
  for (const batch of chunks(endpointIds, ID_BATCH)) {
    let after: string | null = null
    for (let pageIndex = 0; pageIndex < 100_000; pageIndex += 1) {
      const params = workspaceParams(workspace)
      params.set('ids', batch.join(','))
      params.set('limit', String(UPSERT_BATCH))
      if (after) params.set('after', after)
      const page = await getJson<ConnectionByIdsPage>('/api/model/cache/connections/by-endpoints', params, signal)
      requireGeneration(page.projectionGeneration, expectedGeneration)
      for (const item of page.items) {
        const connection = item.connection as unknown as Connection
        byId.set(connection.id, { ...item, connection })
      }
      after = page.nextCursor ?? null
      if (!after) break
    }
  }
  return [...byId.values()]
}

async function upsertObjectBatches(
  workspaceKey: string,
  generation: number,
  items: CachedModelEntityInput[],
  signal?: AbortSignal,
): Promise<void> {
  const worker = getModelReadCacheWorker()
  for (const batch of chunks(items, UPSERT_BATCH)) {
    await worker.upsertObjects({ workspaceKey, generation, items: batch }, signal)
  }
}

async function upsertConnectionBatches(
  workspaceKey: string,
  generation: number,
  items: CachedConnectionInput[],
  signal?: AbortSignal,
): Promise<void> {
  const worker = getModelReadCacheWorker()
  for (const batch of chunks(items, UPSERT_BATCH)) {
    await worker.upsertConnections({ workspaceKey, generation, items: batch }, signal)
  }
}

async function applyChangePage(
  workspace: WorkspaceRef,
  meta: ModelCacheWorkspaceMeta,
  page: ChangeFeedPage,
  signal?: AbortSignal,
): Promise<void> {
  const workspaceKey = workspaceRefKey(workspace)
  const objectActions = coalesce(page.events, 'objects')
  const connectionActions = coalesce(page.events, 'connections')
  const objectUpsertIds = [...objectActions].filter(([, action]) => action === 'upsert').map(([id]) => id)
  const connectionUpsertIds = [...connectionActions].filter(([, action]) => action === 'upsert').map(([id]) => id)

  const [objects, changedConnections, adjacentConnections] = await Promise.all([
    fetchChangedObjects(workspace, objectUpsertIds, page.nextGeneration, signal),
    fetchChangedConnections(workspace, connectionUpsertIds, page.nextGeneration, signal),
    fetchAdjacentConnections(workspace, [...objectActions.keys()], page.nextGeneration, signal),
  ])

  const returnedObjectIds = new Set(objects.map((item) => item.id))
  const returnedConnectionIds = new Set(changedConnections.map((item) => item.connection.id))
  const objectDeletes = new Set(
    [...objectActions].filter(([, action]) => action === 'delete').map(([id]) => id),
  )
  const connectionDeletes = new Set(
    [...connectionActions].filter(([, action]) => action === 'delete').map(([id]) => id),
  )
  // A requested upsert that is already absent was superseded by a newer server
  // deletion. Treat it as a tombstone; replaying the later event stays idempotent.
  for (const id of objectUpsertIds) if (!returnedObjectIds.has(id)) objectDeletes.add(id)
  for (const id of connectionUpsertIds) if (!returnedConnectionIds.has(id)) connectionDeletes.add(id)

  const connectionById = new Map<string, CachedConnectionInput>()
  for (const item of adjacentConnections) connectionById.set(item.connection.id, item)
  for (const item of changedConnections) connectionById.set(item.connection.id, item)
  await upsertObjectBatches(workspaceKey, meta.activeGeneration, objects, signal)
  await upsertConnectionBatches(workspaceKey, meta.activeGeneration, [...connectionById.values()], signal)
  await getModelReadCacheWorker().deleteEntities({
    workspaceKey,
    generation: meta.activeGeneration,
    objectIds: [...objectDeletes],
    connectionIds: [...connectionDeletes],
  }, signal)
  // Commit last. A crash before this line replays harmlessly; a committed
  // generation therefore always means every cache mutation is durable.
  await getModelReadCacheWorker().commitServerGeneration({
    workspaceKey,
    serverGeneration: page.nextGeneration,
  }, signal)
  notifyModelIndexChanged()
}

async function runPoll(workspace: WorkspaceRef, signal?: AbortSignal): Promise<void> {
  if (!isServerReadModelEnabled()) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  const workspaceKey = workspaceRefKey(workspace)
  const statuses = await getModelReadCacheWorker().storageStatus({ workspaceKey }, signal)
  let meta = statuses[0]
  // Partial working sets are refreshed opportunistically by their bounded API
  // reads. The durable feed is only promised for an explicit complete copy.
  if (!meta || !meta.pinned || meta.coverage !== 'full') return

  for (let pageIndex = 0; pageIndex < 100_000; pageIndex += 1) {
    const params = workspaceParams(workspace)
    params.set('afterGeneration', String(meta.serverGeneration))
    params.set('limit', String(FEED_LIMIT))
    const page = await getJson<ChangeFeedPage>('/api/model/cache/changes', params, signal)
    if (page.resetRequired || page.events.some((event) => event.kind === 'reset' && event.scope === 'all')) {
      await downloadWorkspaceForOffline({ signal, workspace })
      return
    }
    if (!page.events.length) return
    await applyChangePage(workspace, meta, page, signal)
    meta = { ...meta, serverGeneration: page.nextGeneration }
    if (!page.hasMore) return
  }
  throw new Error('read-model change feed exceeded its safety page limit')
}

export function pollCurrentWorkspaceChangeFeed(signal?: AbortSignal): Promise<void> {
  const workspace = currentWorkspaceRef()
  const key = workspaceRefKey(workspace)
  const existing = inFlight.get(key)
  if (existing) return existing
  const task = runPoll(workspace, signal).finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

/**
 * Keep complete offline copies current without syncing the whole Automerge
 * workspace. SSE is only a low-latency invalidation signal: the existing
 * durable, idempotent change-feed consumer remains authoritative, while a slow
 * poll catches missed notifications and environments without EventSource.
 *
 * The tier check is DYNAMIC, inside `runPoll` and `refreshEvents`. `main.tsx`
 * calls this once at module evaluation — before any bridge exists, so before any
 * workspace root has been read. Testing `isServerReadModelEnabled()` here would
 * return a no-op disposer for the entire page life of a client with NO Vite
 * flags, which is precisely the client the summary contract is built for: it
 * enters the server tier later, from its root.
 *
 * A dynamic guard rather than a `refreshModelReadCacheChangeFeed()` the bridge
 * calls: the bridge would need a new import edge into the read cache AND a call
 * on every path that enters or leaves the contract (boot, the meta-less refusal,
 * stopBridge, a workspace switch) — four sites that can drift from the one
 * predicate. Here there is one predicate and no edge. The cost of installing
 * unconditionally is one 30 s interval plus a few listeners whose handlers
 * return on the first line while the tier is off.
 */
export function installModelReadCacheChangeFeed(): () => void {
  if (typeof window === 'undefined') return () => undefined
  let disposed = false
  let invalidationUnsubscribe: (() => void) | null = null
  let invalidationWorkspaceKey: string | null = null
  let eventGateRequest = 0
  const controller = new AbortController()
  const poll = () => {
    if (disposed || document.visibilityState === 'hidden') return
    void pollCurrentWorkspaceChangeFeed(controller.signal).catch((error) => {
      if (!controller.signal.aborted && import.meta.env.DEV) {
        console.warn('[model-read-cache] incremental refresh failed; cached copy remains usable', error)
      }
    })
  }
  const closeEvents = () => {
    invalidationUnsubscribe?.()
    invalidationUnsubscribe = null
    invalidationWorkspaceKey = null
  }
  const refreshEvents = () => {
    const gateRequest = ++eventGateRequest
    if (
      disposed
      || !isServerReadModelEnabled()
      || document.visibilityState === 'hidden'
      || navigator.onLine === false
    ) {
      closeEvents()
      return
    }
    const workspace = currentWorkspaceRef()
    const workspaceKey = workspaceRefKey(workspace)
    void getModelReadCacheWorker().storageStatus({ workspaceKey }, controller.signal).then((statuses) => {
      if (disposed || controller.signal.aborted || gateRequest !== eventGateRequest) return
      const shouldStream = statuses.some((meta) => meta.pinned && meta.coverage === 'full')
      if (!shouldStream) {
        if (invalidationWorkspaceKey === workspaceKey) closeEvents()
        return
      }
      if (invalidationUnsubscribe && invalidationWorkspaceKey === workspaceKey) return
      closeEvents()
      invalidationWorkspaceKey = workspaceKey
      invalidationUnsubscribe = subscribeCurrentWorkspaceInvalidations(poll)
    }).catch((error) => {
      if (!controller.signal.aborted && import.meta.env.DEV) {
        console.warn('[model-read-cache] unable to evaluate SSE eligibility', error)
      }
    })
  }
  const initialTimer = window.setTimeout(() => {
    refreshEvents()
    poll()
  }, 1_000)
  const interval = window.setInterval(() => {
    refreshEvents()
    poll()
  }, POLL_INTERVAL_MS)
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      refreshEvents()
      poll()
    } else {
      eventGateRequest += 1
      closeEvents()
    }
  }
  const onOnline = () => {
    refreshEvents()
    poll()
  }
  const onOffline = () => {
    eventGateRequest += 1
    closeEvents()
  }
  const unsubscribeWorkspace = subscribeWorkspaceRef(() => {
    eventGateRequest += 1
    closeEvents()
    refreshEvents()
    poll()
  })
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  window.addEventListener('focus', poll)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    disposed = true
    eventGateRequest += 1
    controller.abort()
    closeEvents()
    unsubscribeWorkspace()
    window.clearTimeout(initialTimer)
    window.clearInterval(interval)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
    window.removeEventListener('focus', poll)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

export function __resetModelReadCacheChangeFeedForTests(): void {
  inFlight.clear()
}
