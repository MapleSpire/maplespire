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
import { accountDatabaseName } from '../auth/accountNamespace'

export const MODEL_READ_CACHE_DB = 'maplespire-model-read-cache'
export const MODEL_READ_CACHE_VERSION = 8
export const ROOT_PARENT_KEY = '\u0000root'

export const MODEL_CACHE_STORES = {
  workspaceMeta: 'workspaceMeta',
  objects: 'objects',
  connections: 'connections',
  diagramMembership: 'diagramMembership',
  diagramRenders: 'diagramRenders',
  searchPostings: 'searchPostings',
  localMutations: 'localMutations',
  syncState: 'syncState',
} as const

export type OfflineCoverage = 'working-set' | 'full'

export type OfflineDownloadPhase = 'objects' | 'connections' | 'diagrams' | 'verifying'
export type OfflineDownloadStatus = 'running' | 'paused' | 'blocked-quota' | 'interrupted' | 'failed'

/** Durable checkpoint for an explicit complete-version download. The checkpoint
 * lives beside the workspace metadata so a page write and its next cursor can be
 * committed in the same IndexedDB transaction. A browser restart may therefore
 * repeat at most an uncommitted network page, never the whole download. */
export interface ModelCacheOfflineDownload {
  generation: number
  serverGeneration: number
  status: OfflineDownloadStatus
  phase: OfflineDownloadPhase
  nextCursor: string | null
  objectCount: number
  connectionCount: number
  diagramCount: number
  objectTotal?: number
  connectionTotal?: number
  diagramTotal?: number
  pinned: boolean
  ownerId: string
  leaseExpiresAt: number
  startedAt: number
  updatedAt: number
  errorCode?: string
  errorMessage?: string
}

export interface ModelCacheOfflineDownloadCheckpoint {
  ownerId: string
  generation: number
  expectedPhase: OfflineDownloadPhase
  expectedCursor: string | null
  phase: OfflineDownloadPhase
  nextCursor: string | null
  objectCount: number
  connectionCount: number
  diagramCount: number
  objectTotal?: number
  connectionTotal?: number
  diagramTotal?: number
}

export interface ModelCacheGenerationStats {
  objectCount: number
  connectionCount: number
  accountedBytes: Record<string, number>
}

export interface ModelCacheWorkspaceMeta {
  workspaceKey: string
  activeGeneration: number
  serverGeneration: number
  coverage: OfflineCoverage
  pinned: boolean
  lastAccessAt: number
  objectCount: number
  connectionCount: number
  accountedBytes: Record<string, number>
  generationStats: Record<string, ModelCacheGenerationStats>
  offlineDownload?: ModelCacheOfflineDownload
}

export interface CachedModelEntityInput {
  id: string
  kind: 'object' | 'group'
  name: string
  type: string
  parentId?: string | null
  /** The server's `c4_parent_id`: the C4 parent when that object exists, else
   * null (a root); groups play no part. Absent from rows an older server or
   * the explorer working set sent — those fall back to the payload's parent. */
  c4ParentId?: string | null
  childCount: number
  appCount?: number
  storeCount?: number
  componentCount?: number
  connectionCount?: number
  diagramCount?: number
  inDiagram?: boolean
  breadcrumb?: Array<{ id: string; name: string }>
  searchText?: string
  payload: C4Object | Group
}

export interface CachedModelEntityRecord extends CachedModelEntityInput {
  workspaceKey: string
  generation: number
  parentKey: string
  /** The real C4 parent, independent from the tree parent used by the sidebar
   * (which may be a group). This keeps offline diagram roll-ups correct, and
   * it is the Model Viewer's level. The server's dangling-repaired
   * `c4ParentId` when the row carried one, else the payload's `parentId`. */
  modelParentKey: string
  normalizedName: string
  normalizedSearchText: string
  /** Scoped trigram + normalized-name keys. IndexedDB expands this array
   * internally, avoiding one JavaScript `put()` per posting. */
  searchTrigramKeys: string[]
  accountedBytes: number
}

export interface CachedDiagramManifestInput {
  diagramId: string
  objectIds: string[]
  connectionIds: string[]
  groupIds: string[]
}

export interface CachedDiagramManifestRecord extends CachedDiagramManifestInput {
  workspaceKey: string
  generation: number
  /** `diagramMembership` historically used one row per entity. Version 4
   * stores one compact manifest per diagram; this sentinel keeps the existing
   * store name while making old rows impossible to mistake for manifests. */
  entityId: '__manifest__'
  accountedBytes: number
}

export interface CachedConnectionInput {
  connection: Connection
  fromName: string
  fromIcon?: string
  fromType?: string
  fromDomainId?: string
  toName: string
  toIcon?: string
  toType?: string
  toDomainId?: string
  diagramCount: number
  flowCount: number
}

export interface CachedConnectionRecord extends CachedConnectionInput {
  workspaceKey: string
  generation: number
  id: string
  fromId: string
  toId: string
  normalizedLabel: string
  normalizedFromName: string
  normalizedToName: string
  normalizedSearchText: string
  accountedBytes: number
}

export interface CachedSearchPosting {
  workspaceKey: string
  generation: number
  trigram: string
  normalizedName: string
  entityId: string
}

export interface CachedDiagramRenderRecord {
  workspaceKey: string
  diagramId: string
  generation: number
  payload: unknown
  accountedBytes: number
  cachedAt: number
}

export interface ModelCacheEvictedGeneration {
  workspaceKey: string
  generation: number
  wasActive: boolean
  accountedBytes: number
}

export interface ModelCacheEvictionResult {
  evictedBytes: number
  remainingAccountedBytes: number
  evictedGenerations: ModelCacheEvictedGeneration[]
  targetSatisfied: boolean
}

export interface ModelCacheLocalMutation {
  workspaceKey: string
  mutationId: string
  entityKind: 'object' | 'group' | 'connection' | 'diagram'
  entityId: string
  baseGeneration: number
  patch: unknown
  tombstone?: boolean
  createdAt: number
  state: 'pending' | 'sent' | 'projected' | 'conflict'
}

export interface ModelCacheSyncState {
  workspaceKey: string
  lastAppliedServerGeneration: number
  updatedAt: number
}

export function normalizeModelSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function searchTrigrams(value: string): string[] {
  const normalized = normalizeModelSearchText(value)
  if (normalized.length < 3) return []
  const result = new Set<string>()
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    result.add(normalized.slice(index, index + 3))
  }
  return [...result]
}

const CONNECTION_SEARCH_SCOPE_SEPARATOR = '\u0001'

export function objectSearchTrigramPrefix(
  workspaceKey: string,
  generation: number,
  trigram: string,
): string {
  return `${encodeURIComponent(workspaceKey)}${CONNECTION_SEARCH_SCOPE_SEPARATOR}${generation}${CONNECTION_SEARCH_SCOPE_SEPARATOR}${trigram}${CONNECTION_SEARCH_SCOPE_SEPARATOR}`
}

export function objectSearchTrigramKeys(
  workspaceKey: string,
  generation: number,
  normalizedName: string,
  normalizedSearchText: string,
): string[] {
  const safeName = normalizedName.replaceAll(CONNECTION_SEARCH_SCOPE_SEPARATOR, ' ')
  return searchTrigrams(normalizedSearchText).map(
    (trigram) => `${objectSearchTrigramPrefix(workspaceKey, generation, trigram)}${safeName}`,
  )
}

export function estimateStructuredBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return 0
  }
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  })
}

let databasePromise: Promise<IDBDatabase> | null = null

export function openModelReadCache(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    // Opened inside the read-cache Worker: the namespace arrives as the
    // Worker's name (workerClient.ts, accountWorkerName).
    const request = indexedDB.open(accountDatabaseName(MODEL_READ_CACHE_DB), MODEL_READ_CACHE_VERSION)
    request.onerror = () => {
      databasePromise = null
      reject(request.error ?? new Error('Unable to open model read cache'))
    }
    request.onblocked = () => {
      databasePromise = null
      reject(new Error('Model read cache upgrade is blocked by another tab'))
    }
    request.onupgradeneeded = (event) => createModelReadCacheSchema(
      request.result,
      request.transaction!,
      event.oldVersion,
    )
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
  })
  return databasePromise
}

function createModelReadCacheSchema(database: IDBDatabase, transaction: IDBTransaction, oldVersion: number): void {
  if (oldVersion >= 1) {
    let clearDerived = false
    if (oldVersion < 2) {
      const postings = transaction.objectStore(MODEL_CACHE_STORES.searchPostings)
      if (!postings.indexNames.contains('byTrigramName')) {
        postings.createIndex('byTrigramName', [
          'workspaceKey', 'generation', 'trigram', 'normalizedName', 'entityId',
        ])
      }
      clearDerived = true
    }
    if (oldVersion < 3) {
      const connections = transaction.objectStore(MODEL_CACHE_STORES.connections)
      if (!connections.indexNames.contains('byName')) {
        connections.createIndex('byName', ['workspaceKey', 'generation', 'normalizedLabel', 'id'])
        connections.createIndex('bySender', ['workspaceKey', 'generation', 'normalizedFromName', 'id'])
        connections.createIndex('byReceiver', ['workspaceKey', 'generation', 'normalizedToName', 'id'])
        connections.createIndex('byDiagrams', ['workspaceKey', 'generation', 'diagramCount', 'id'])
        connections.createIndex('byFlows', ['workspaceKey', 'generation', 'flowCount', 'id'])
      }
      clearDerived = true
    }
    if (oldVersion < 4) {
      const objects = transaction.objectStore(MODEL_CACHE_STORES.objects)
      if (!objects.indexNames.contains('byModelParent')) {
        objects.createIndex('byModelParent', [
          'workspaceKey', 'generation', 'modelParentKey', 'id',
        ])
      }
      // Existing entity rows do not contain `modelParentKey`, so they cannot
      // populate the new index. They are derived and will be rebuilt cleanly.
      clearDerived = true
    }
    if (oldVersion < 5) {
      const connections = transaction.objectStore(MODEL_CACHE_STORES.connections)
      if (!connections.indexNames.contains('bySearchToken')) {
        connections.createIndex('bySearchToken', 'searchTokens', { multiEntry: true })
      }
      // Version-4 rows have no token array and therefore cannot populate the
      // index. Only derived projections are cleared below.
      clearDerived = true
    }
    if (oldVersion < 6) {
      const objects = transaction.objectStore(MODEL_CACHE_STORES.objects)
      if (!objects.indexNames.contains('bySearchTrigram')) {
        objects.createIndex('bySearchTrigram', 'searchTrigramKeys', { multiEntry: true })
      }
      // Prior rows relied on one posting record per trigram and do not contain
      // the multi-entry keys. Rebuild derived projections below.
      clearDerived = true
    }
    if (oldVersion < 7) {
      const connections = transaction.objectStore(MODEL_CACHE_STORES.connections)
      if (connections.indexNames.contains('bySearchToken')) connections.deleteIndex('bySearchToken')
      // Connection search now reuses the object trigram index plus the existing
      // endpoint indexes. Old rows contain duplicated scoped token arrays, so
      // rebuild the reconstructable projection to reclaim them deterministically.
      clearDerived = true
    }
    if (oldVersion < 8) {
      const objects = transaction.objectStore(MODEL_CACHE_STORES.objects)
      if (!objects.indexNames.contains('byModelParentName')) {
        objects.createIndex('byModelParentName', [
          'workspaceKey', 'generation', 'modelParentKey', 'normalizedName', 'id',
        ])
      }
      // Every row written since version 4 carries `modelParentKey` and
      // `normalizedName`, so `createIndex` populates the new index from the rows
      // already stored: an offline cache survives this upgrade intact.
    }
    if (clearDerived) {
      // Older derived records cannot populate the new compound indexes. Clear
      // only reconstructable projections; local mutations and sync checkpoints
      // deliberately survive schema upgrades.
      transaction.objectStore(MODEL_CACHE_STORES.workspaceMeta).clear()
      transaction.objectStore(MODEL_CACHE_STORES.objects).clear()
      transaction.objectStore(MODEL_CACHE_STORES.connections).clear()
      transaction.objectStore(MODEL_CACHE_STORES.diagramMembership).clear()
      transaction.objectStore(MODEL_CACHE_STORES.diagramRenders).clear()
      transaction.objectStore(MODEL_CACHE_STORES.searchPostings).clear()
    }
    return
  }
  const meta = database.createObjectStore(MODEL_CACHE_STORES.workspaceMeta, { keyPath: 'workspaceKey' })
  meta.createIndex('byLastAccess', 'lastAccessAt')
  meta.createIndex('byPinnedLastAccess', ['pinned', 'lastAccessAt'])

  const objects = database.createObjectStore(MODEL_CACHE_STORES.objects, {
    keyPath: ['workspaceKey', 'generation', 'id'],
  })
  objects.createIndex('byParent', ['workspaceKey', 'generation', 'parentKey', 'normalizedName', 'id'])
  objects.createIndex('byName', ['workspaceKey', 'generation', 'normalizedName', 'id'])
  objects.createIndex('byType', ['workspaceKey', 'generation', 'type', 'normalizedName', 'id'])
  objects.createIndex('byModelParent', ['workspaceKey', 'generation', 'modelParentKey', 'id'])
  // The Model Viewer's level: C4 children of one parent, in name order.
  objects.createIndex('byModelParentName', ['workspaceKey', 'generation', 'modelParentKey', 'normalizedName', 'id'])
  objects.createIndex('bySearchTrigram', 'searchTrigramKeys', { multiEntry: true })

  const connections = database.createObjectStore(MODEL_CACHE_STORES.connections, {
    keyPath: ['workspaceKey', 'generation', 'id'],
  })
  connections.createIndex('byFrom', ['workspaceKey', 'generation', 'fromId', 'id'])
  connections.createIndex('byTo', ['workspaceKey', 'generation', 'toId', 'id'])
  connections.createIndex('byLabel', ['workspaceKey', 'generation', 'normalizedLabel', 'id'])
  connections.createIndex('byName', ['workspaceKey', 'generation', 'normalizedLabel', 'id'])
  connections.createIndex('bySender', ['workspaceKey', 'generation', 'normalizedFromName', 'id'])
  connections.createIndex('byReceiver', ['workspaceKey', 'generation', 'normalizedToName', 'id'])
  connections.createIndex('byDiagrams', ['workspaceKey', 'generation', 'diagramCount', 'id'])
  connections.createIndex('byFlows', ['workspaceKey', 'generation', 'flowCount', 'id'])

  const membership = database.createObjectStore(MODEL_CACHE_STORES.diagramMembership, {
    keyPath: ['workspaceKey', 'generation', 'diagramId', 'entityId'],
  })
  membership.createIndex('byEntity', ['workspaceKey', 'generation', 'entityId', 'diagramId'])

  database.createObjectStore(MODEL_CACHE_STORES.diagramRenders, {
    keyPath: ['workspaceKey', 'diagramId', 'generation'],
  })

  const postings = database.createObjectStore(MODEL_CACHE_STORES.searchPostings, {
    keyPath: ['workspaceKey', 'generation', 'trigram', 'entityId'],
  })
  postings.createIndex('byEntity', ['workspaceKey', 'generation', 'entityId', 'trigram'])
  postings.createIndex('byTrigramName', [
    'workspaceKey', 'generation', 'trigram', 'normalizedName', 'entityId',
  ])

  const mutations = database.createObjectStore(MODEL_CACHE_STORES.localMutations, {
    keyPath: ['workspaceKey', 'mutationId'],
  })
  mutations.createIndex('byWorkspaceState', ['workspaceKey', 'state', 'createdAt'])

  database.createObjectStore(MODEL_CACHE_STORES.syncState, { keyPath: 'workspaceKey' })
}

export function resetModelReadCacheConnection(): void {
  databasePromise = null
}
