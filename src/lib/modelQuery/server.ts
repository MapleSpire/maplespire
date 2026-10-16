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

import { useModelStore } from '../../stores/modelStore'
import { connectionRowsFromStore, pickerEntriesFromStore, modelObjectRowsFromStore } from './heavyViews'
import { withWorkspaceParams } from './workspaceParams'
import { workspaceApiFetch } from '../api/http'
import type {
  ConnectionPageResult,
  DependencyPageResult,
  ModelObjectFacets,
  ModelQuery,
  ObjectExplorerPage,
  ObjectSearchPageOpts,
  ObjectTreePageOpts,
  PeerEdge,
  SearchHit,
  RelatedDiagramsResult,
  EntityFlowsResult,
  ViewerLevelResult,
} from './types'
import type { C4Object, Group, Connection, Diagram } from '../../types'
import { warnWholeModelRead } from './wholeModelGuard'
import { currentWorkspaceRef, workspaceRefKey } from '../automerge/workspace'
import { getModelReadCacheWorker } from './workerClient'
import { scheduleDerivedCacheMaintenance } from '../offline/cacheRetention'
import { pinnedCacheNeedsRefresh, shouldCacheBoundedServerPage } from './cacheGenerationPolicy'
import { API_BASE } from '../api/base'

/**
 * The premium server-backed ModelQuery: cross-diagram reads are
 * served by the server's Postgres read model over `/api/model/*`, so the client
 * answers them without the full model resident. `relatedDiagrams` is delegated to
 * the IndexedDB index (the diagram registry stays client-side); everything else is
 * a thin fetch + map onto the same ModelQuery return types the resident/paged
 * backends produce, so `resident == paged == server` holds.
 *
 * Every request carries the active workspace (`landscapeId`/`versionId`, via
 * `withWorkspaceParams`) so the server's per-workspace `ro_*` tables answer for the
 * landscape/version the user actually has open.
 */

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>
let fetcher: Fetcher = (url, init) => workspaceApiFetch(url, init)

/** Test hook: back the server query with a fake fetch. */
export function __setServerFetchForTest(f: Fetcher | null): void {
  fetcher = f ?? ((url, init) => workspaceApiFetch(url, init))
}

/** A read-model request the server ANSWERED with a non-2xx status. Distinct from
 * a transport failure (fetch rejects) so callers can tell "the server said no"
 * from "the server is unreachable" — see `isAuthoritativeReadModelRefusal`. */
export class ReadModelHttpError extends Error {
  readonly status: number

  constructor(path: string, status: number) {
    super(`read-model API ${path} → HTTP ${status}`)
    this.name = 'ReadModelHttpError'
    this.status = status
  }
}

/**
 * 401/403 are ACCESS decisions, not outages, and an outage fallback must not
 * answer them. Reproduced 2026-10-11 (live, then on a local AUTH=on stack): a
 * new account booted with the previous account's persisted landscape, the
 * server answered 403, and the explorer filled with the previous account's
 * objects from the local caches under the "offline results" banner. Those
 * caches are per user since (src/lib/auth/accountNamespace.ts); this check
 * remains so a refused workspace renders as refused, not as offline.
 */
export function isAuthoritativeReadModelRefusal(error: unknown): boolean {
  return error instanceof ReadModelHttpError && (error.status === 401 || error.status === 403)
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetcher(`${API_BASE}${path}`, { signal })
  if (!res.ok) throw new ReadModelHttpError(path, res.status)
  return (await res.json()) as T
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetcher(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw new ReadModelHttpError(path, res.status)
  return (await res.json()) as T
}

/** Like getJson but maps a 404 to undefined (entity not found). */
async function getJsonOr404<T>(path: string): Promise<T | undefined> {
  const res = await fetcher(`${API_BASE}${path}`)
  if (res.status === 404) return undefined
  if (!res.ok) throw new ReadModelHttpError(path, res.status)
  return (await res.json()) as T
}

const enc = encodeURIComponent

function explorerParams(opts: ObjectTreePageOpts | ObjectSearchPageOpts): URLSearchParams {
  const params = new URLSearchParams(withWorkspaceParams(''))
  if (opts.diagramId) params.set('diagramId', opts.diagramId)
  if (opts.cursor) params.set('after', opts.cursor)
  params.set('limit', String(opts.limit ?? 50))
  return params
}

function cacheExplorerWorkingSet(workspaceKey: string, page: ObjectExplorerPage): void {
  void (async () => {
    const worker = getModelReadCacheWorker()
    const status = (await worker.storageStatus({ workspaceKey }))[0]
    if (!shouldCacheBoundedServerPage(status)) {
      if (pinnedCacheNeedsRefresh(status, page.projectionGeneration)) {
        void import('./modelReadCacheChangeFeed').then(({ pollCurrentWorkspaceChangeFeed }) => (
          pollCurrentWorkspaceChangeFeed()
        )).catch((error) => {
          if (import.meta.env.DEV) console.warn('[modelReadCache] unable to schedule pinned-cache refresh:', error)
        })
      }
      return
    }
    await worker.upsertObjects({
      workspaceKey,
      generation: page.projectionGeneration,
      items: page.items.map((row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        type: row.type,
        parentId: row.parentId,
        childCount: row.childCount,
        appCount: row.appCount,
        storeCount: row.storeCount,
        componentCount: row.componentCount,
        connectionCount: row.connectionCount,
        diagramCount: row.diagramCount,
        inDiagram: row.inDiagram,
        breadcrumb: row.breadcrumb,
        searchText: row.name,
        payload: row.kind === 'group'
          ? ({
            id: row.id, name: row.name, color: '#808080', objectIds: [],
            tagAssignments: {}, tagOrder: [],
            ...(row.icon ? { icon: row.icon } : {}),
            ...(row.iconAssignment ? { iconAssignment: row.iconAssignment } : {}),
          } as Group)
          : ({
            id: row.id, type: row.type, name: row.name,
            position: { x: 0, y: 0 }, size: { width: 0, height: 0 },
            tagAssignments: {}, tagOrder: [], properties: {},
            scope: row.scope ?? 'internal', status: row.status ?? 'live',
            ...(row.parentId ? { parentId: row.parentId } : {}),
            ...(row.domainId ? { domainId: row.domainId } : {}),
            ...(row.icon ? { icon: row.icon } : {}),
            ...(row.iconAssignment ? { iconAssignment: row.iconAssignment } : {}),
          } as C4Object),
      })),
    })
    // Never demote an already-complete cache for the same projection. A newer
    // projection starts a partial working set until an explicit full download.
    await worker.activateGeneration({
      workspaceKey,
      generation: page.projectionGeneration,
      serverGeneration: page.projectionGeneration,
      coverage: 'working-set',
      preserveFull: true,
    })
    scheduleDerivedCacheMaintenance()
  })().catch((error) => {
    console.warn('[modelReadCache] unable to cache explorer working set:', error)
  })
}

function cacheConnectionWorkingSet(workspaceKey: string, page: ConnectionPageResult): void {
  void (async () => {
    const worker = getModelReadCacheWorker()
    const status = (await worker.storageStatus({ workspaceKey }))[0]
    if (!shouldCacheBoundedServerPage(status)) {
      if (pinnedCacheNeedsRefresh(status, page.projectionGeneration)) {
        void import('./modelReadCacheChangeFeed').then(({ pollCurrentWorkspaceChangeFeed }) => (
          pollCurrentWorkspaceChangeFeed()
        )).catch((error) => {
          if (import.meta.env.DEV) console.warn('[modelReadCache] unable to schedule pinned-cache refresh:', error)
        })
      }
      return
    }
    await worker.upsertConnections({
      workspaceKey,
      generation: page.projectionGeneration,
      items: page.items.map((row) => ({
        connection: row.connection,
        fromName: row.fromName,
        ...(row.fromIcon ? { fromIcon: row.fromIcon } : {}),
        ...(row.fromType ? { fromType: row.fromType } : {}),
        ...(row.fromDomainId ? { fromDomainId: row.fromDomainId } : {}),
        toName: row.toName,
        ...(row.toIcon ? { toIcon: row.toIcon } : {}),
        ...(row.toType ? { toType: row.toType } : {}),
        ...(row.toDomainId ? { toDomainId: row.toDomainId } : {}),
        diagramCount: row.diagramCount,
        flowCount: row.flowCount,
      })),
    })
    await worker.activateGeneration({
      workspaceKey,
      generation: page.projectionGeneration,
      serverGeneration: page.projectionGeneration,
      coverage: 'working-set',
      preserveFull: true,
    })
    scheduleDerivedCacheMaintenance()
  })().catch((error) => {
    console.warn('[modelReadCache] unable to cache connection working set:', error)
  })
}

export const serverModelQuery: ModelQuery = {
  objectTreePage: async (opts, signal) => {
    const workspaceKey = workspaceRefKey(currentWorkspaceRef())
    const params = explorerParams(opts)
    if (opts.parentId) params.set('parentId', opts.parentId)
    const page = await getJson<ObjectExplorerPage>(`/api/model/tree/children?${params.toString()}`, signal)
    cacheExplorerWorkingSet(workspaceKey, page)
    return page
  },
  objectSearchPage: async (opts, signal) => {
    const workspaceKey = workspaceRefKey(currentWorkspaceRef())
    const params = explorerParams(opts)
    if (opts.query) params.set('q', opts.query)
    if (opts.filter?.types?.length) params.set('types', opts.filter.types.join(','))
    if (opts.filter?.scope) params.set('scope', opts.filter.scope)
    if (opts.filter?.technologyIds?.length) params.set('technologyIds', opts.filter.technologyIds.join(','))
    if (opts.filter?.tagIds?.length) params.set('tagIds', opts.filter.tagIds.join(','))
    const statuses = opts.filter?.statuses ?? (opts.filter?.status ? [opts.filter.status] : [])
    if (statuses.length) params.set('statuses', statuses.join(','))
    if (opts.filter?.teamIds?.length) params.set('teamIds', opts.filter.teamIds.join(','))
    if (opts.filter?.hasDescription !== undefined) params.set('hasDescription', String(opts.filter.hasDescription))
    if (opts.filter?.inDiagram !== undefined) params.set('inDiagram', String(opts.filter.inDiagram))
    if (opts.domainId) params.set('domainId', opts.domainId)
    const page = await getJson<ObjectExplorerPage>(`/api/model/objects/search?${params.toString()}`, signal)
    cacheExplorerWorkingSet(workspaceKey, page)
    return page
  },
  connectionPage: async (opts, signal) => {
    const workspaceKey = workspaceRefKey(currentWorkspaceRef())
    const params = new URLSearchParams(withWorkspaceParams(''))
    if (opts.search) params.set('q', opts.search)
    if (opts.domainId) params.set('domainId', opts.domainId)
    if (opts.sortBy) params.set('sortBy', opts.sortBy)
    params.set('sortAsc', String(opts.sortAsc !== false))
    if (opts.cursor) params.set('after', opts.cursor)
    params.set('limit', String(opts.limit ?? 50))
    const page = await getJson<ConnectionPageResult>(`/api/model/connections/page?${params.toString()}`, signal)
    cacheConnectionWorkingSet(workspaceKey, page)
    return page
  },
  dependencyPage: async (opts, signal) => {
    const params = new URLSearchParams(withWorkspaceParams(''))
    params.set('focus', opts.focusId)
    params.set('direction', opts.direction)
    if (opts.search) params.set('q', opts.search)
    if (opts.globalSearch) params.set('globalQ', opts.globalSearch)
    if (opts.domainId) params.set('domainId', opts.domainId)
    if (opts.cursor) params.set('after', opts.cursor)
    params.set('limit', String(opts.limit ?? 10))
    return getJson<DependencyPageResult>(`/api/model/dependencies/page?${params.toString()}`, signal)
  },
  viewerLevel: async (opts, signal) => {
    const params = new URLSearchParams(withWorkspaceParams(''))
    if (opts.parentId) params.set('parentId', opts.parentId)
    if (opts.query) params.set('q', opts.query)
    if (opts.domainIds?.length) params.set('domainIds', opts.domainIds.join(','))
    if (opts.cursor) params.set('after', opts.cursor)
    params.set('limit', String(opts.limit ?? 200))
    params.set('connectionLimit', String(opts.connectionLimit ?? 1_000))
    return getJson<ViewerLevelResult>(`/api/model/viewer/level?${params.toString()}`, signal)
  },
  incoming: async (focusId) =>
    (await getJson<{ incoming: PeerEdge[] }>(`/api/model/dependencies?${withWorkspaceParams(`focus=${enc(focusId)}`)}`)).incoming,
  outgoing: async (focusId) =>
    (await getJson<{ outgoing: PeerEdge[] }>(`/api/model/dependencies?${withWorkspaceParams(`focus=${enc(focusId)}`)}`)).outgoing,
  object: async (id) =>
    (await getJsonOr404<{ object: C4Object }>(`/api/model/object/${enc(id)}?${withWorkspaceParams('')}`))?.object,
  group: async (id) =>
    (await getJsonOr404<{ group: Group }>(`/api/model/group/${enc(id)}?${withWorkspaceParams('')}`))?.group,
  // The single-connection endpoint EXISTS (server routes /api/model/connection/:id).
  // Note for the entity-intent replay: it witnesses through the BATCHED
  // `fetchDurabilityWitness` below, not through these single-entity methods —
  // their 404 carries no projection freshness, so it cannot prove absence.
  connection: async (id) =>
    (await getJsonOr404<{ connection: Connection }>(`/api/model/connection/${enc(id)}?${withWorkspaceParams('')}`))?.connection,
  lookupMany: async (ids) => {
    if (!ids.length) return new Map<string, C4Object | Group>()
    const { entities } = await getJson<{ entities: [string, C4Object | Group][] }>(
      `/api/model/lookup?${withWorkspaceParams(`ids=${enc(ids.join(','))}`)}`
    )
    return new Map(entities)
  },
  connectionCount: async (id) =>
    (await getJson<{ count: number }>(`/api/model/connection-count?${withWorkspaceParams(`id=${enc(id)}`)}`)).count,
  descendants: async (objectId) =>
    (await getJson<{ ids: string[] }>(`/api/model/descendants?${withWorkspaceParams(`object=${enc(objectId)}`)}`)).ids,
  // The whole-model object list is served by the local index once its background
  // build is ready (getModelQuery → paged); until then the resident store is the only
  // synchronous source. Under the pure server tier (no windowing) the store IS the
  // full model.
  allObjects: async () => {
    warnWholeModelRead('server.allObjects')
    return useModelStore.getState().objects
  },
  allConnections: async () => {
    warnWholeModelRead('server.allConnections')
    return useModelStore.getState().connections
  },
  relatedDiagrams: async (objectId, options) => {
    // No `current` parameter = the server excludes nothing (roRelatedDiagrams).
    const current = options?.includeCurrent ? null : useModelStore.getState().currentDiagramId
    const own = `object=${enc(objectId)}${current ? `&current=${enc(current)}` : ''}`
      + `${options?.query?.trim() ? `&q=${enc(options.query.trim())}` : ''}`
      + `&limit=${Math.min(100, Math.max(1, Math.floor(options?.limit ?? 50)))}`
    const path = `/api/model/related-diagrams?${withWorkspaceParams(own)}`
    return getJson<RelatedDiagramsResult>(path, options?.signal)
  },
  entityFlows: async (kind, id, options) => {
    const own = `kind=${kind}&id=${enc(id)}&limit=${Math.min(100, Math.max(1, Math.floor(options?.limit ?? 50)))}`
      + (options?.excludeDiagramId ? `&excludeDiagram=${enc(options.excludeDiagramId)}` : '')
    return getJson<EntityFlowsResult>(`/api/model/entity-flows?${withWorkspaceParams(own)}`, options?.signal)
  },
  entityDiagrams: async (kind, id, options) => {
    const own = `kind=${kind}&id=${enc(id)}&limit=${Math.min(100, Math.max(1, Math.floor(options?.limit ?? 50)))}`
    return getJson<{ diagrams: Diagram[]; total: number }>(`/api/model/entity-diagrams?${withWorkspaceParams(own)}`, options?.signal)
  },
  relatedDiagramObjectIds: async (objectIds, options) => {
    const current = useModelStore.getState().currentDiagramId
    const path = `/api/model/related-diagram-object-ids?${withWorkspaceParams(
      current ? `current=${enc(current)}` : '',
    )}`
    return (await postJson<{ ids: string[] }>(path, { objectIds }, options?.signal)).ids
  },
  search: async (query, limit) =>
    (await getJson<{ hits: SearchHit[] }>(`/api/model/search?${withWorkspaceParams(`q=${enc(query)}&limit=${limit ?? 12}`)}`)).hits,
  // The heavy-view tables read the (still-resident) store; the server SQL variants
  // are a future optimization for when the store is windowed.
  connectionRows: async (opts) => connectionRowsFromStore(opts),
  pickerEntries: async (opts) => pickerEntriesFromStore(opts),
  modelObjectRows: async (opts) => modelObjectRowsFromStore(opts),
  modelObjectFacets: () =>
    getJson<ModelObjectFacets>(`/api/model/object-facets?${withWorkspaceParams('')}`),
}

export interface DurabilityWitnessResult {
  /** The write-checkpoint absence proof (an ORDER, not a status): true only
   * when every durable arrival for the workspace predates the last completed
   * projection AND the projection ladder is healthy with ≥1 admitted document.
   * Presence answers stay usable either way (a projected value WAS durable
   * when projected); ABSENCE is a proof only under this flag — a lagging
   * projector's last coherent snapshot may simply not contain a durably
   * written entity yet, and a status-only "caught up" check would miss a write
   * inside the stale grace window. */
  absenceProvable: boolean
  objects: Map<string, C4Object>
  connections: Map<string, Connection>
}

/**
 * Batched durability witness for the entity-intent replay: objects AND
 * connections in one round trip, WITH the projection-freshness signal.
 * Deliberately NOT part of the ModelQuery contract — a durability decision may
 * consult durability witnesses only, and the paged/resident implementations of
 * that contract serve the very records the replay feeds (the poisoned-witness
 * trap this endpoint exists to avoid). Throws on any transport or server
 * failure; the caller must read that as "witnesses unreachable", never as
 * absence.
 *
 * POST, not GET: 500 imported ids of 40+
 * characters push a GET request line past node's default 16 KB header ceiling
 * (HTTP 431) and past nginx's 8 KB default, and a failed witness call defers
 * EVERY stamped intent — the journal would never drain on exactly the large
 * post-crash journals the batching exists for. A JSON body has no such cliff.
 */
export async function fetchDurabilityWitness(
  objectIds: readonly string[],
  connectionIds: readonly string[],
): Promise<DurabilityWitnessResult> {
  const requested = currentWorkspaceRef()
  const body = await postJson<{
    landscapeId?: string
    versionId?: string
    absenceProvable: boolean
    objects: Record<string, C4Object>
    connections: Record<string, Connection>
  }>(`/api/model/durability-witness?${withWorkspaceParams('')}`, {
    objects: objectIds,
    connections: connectionIds,
  })
  // The server echoes the workspace it RESOLVED. ensureWorkspace redirects
  // static/sparse-draft workspaces to their BASE version's read model, and a
  // witness answering for another workspace is unusable in BOTH directions:
  // the base's values could equality-acknowledge a draft's own intents
  // (presence poisoning — the losing direction), and its quiet healthy state
  // would "prove" absences that never could appear there. On any mismatch the
  // WHOLE payload is discarded — no proof, no values.
  if (body.landscapeId !== requested.landscapeId || body.versionId !== requested.versionId) {
    return { absenceProvable: false, objects: new Map(), connections: new Map() }
  }
  return {
    // Strict === true: an older server (no field) or a malformed payload must
    // read as "absence not provable", never as a proof.
    absenceProvable: body.absenceProvable === true,
    objects: new Map(Object.entries(body.objects ?? {})),
    connections: new Map(Object.entries(body.connections ?? {})),
  }
}
