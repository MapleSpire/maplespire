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

import {
  MODEL_CACHE_STORES,
  ROOT_PARENT_KEY,
  estimateStructuredBytes,
  normalizeModelSearchText,
  objectSearchTrigramKeys,
  objectSearchTrigramPrefix,
  openModelReadCache,
  requestResult,
  searchTrigrams,
  transactionDone,
  type CachedConnectionRecord,
  type CachedDiagramManifestInput,
  type CachedDiagramManifestRecord,
  type CachedDiagramRenderRecord,
  type CachedModelEntityInput,
  type CachedModelEntityRecord,
  type ModelCacheEvictionResult,
  type ModelCacheGenerationStats,
  type ModelCacheOfflineDownloadCheckpoint,
  type ModelCacheSyncState,
  type ModelCacheWorkspaceMeta,
} from '../lib/modelQuery/idbSchema'
import { computeLowerConnections } from '../lib/modelQuery/diagramRenderLocal'
import { reconciledCachedChildCount } from '../lib/modelQuery/cachedHierarchy'
import { modelCacheSearchMode } from '../lib/modelQuery/modelCacheSearchMode'
import type {
  ModelCacheConnectionPage,
  ModelCacheDependencyPage,
  ModelCacheViewerLevel,
  ModelCachePage,
  ModelCacheSearchItem,
  ModelReadCacheRequest,
  ModelReadCacheResponse,
} from '../lib/modelQuery/modelReadCacheProtocol'

interface WorkerScope {
  onmessage: ((event: MessageEvent<ModelReadCacheRequest>) => void) | null
  postMessage(message: ModelReadCacheResponse): void
}

interface OperationResult<T> {
  result: T
  rowsRead?: number
}

interface PageCursor {
  phase?: 'prefix' | 'contains'
  normalizedName: string
  id: string
}

interface ConnectionPageCursor {
  value: string | number
  id: string
  mode?: 'search'
  query?: string
  phase?: 'label' | 'endpoint'
  direction?: 'from' | 'to'
  objectNextCursor?: string | null
}

interface DependencyPageCursor {
  connectionCount: number
  name: string
  id: string
}

const scope = globalThis as unknown as WorkerScope
const cancelled = new Set<number>()
const OFFLINE_DOWNLOAD_LEASE_MS = 30_000

class WorkerOperationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkerOperationError'
    this.code = code
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function generationStats(): ModelCacheGenerationStats {
  return { objectCount: 0, connectionCount: 0, accountedBytes: {} }
}

function defaultMeta(workspaceKey: string): ModelCacheWorkspaceMeta {
  return {
    workspaceKey,
    activeGeneration: 0,
    serverGeneration: 0,
    coverage: 'working-set',
    pinned: false,
    lastAccessAt: Date.now(),
    objectCount: 0,
    connectionCount: 0,
    accountedBytes: {},
    generationStats: {},
  }
}

function statsFor(meta: ModelCacheWorkspaceMeta, generation: number): ModelCacheGenerationStats {
  const key = String(generation)
  const existing = meta.generationStats[key]
  if (existing) return existing
  const created = generationStats()
  meta.generationStats[key] = created
  return created
}

function addBytes(target: Record<string, number>, store: string, delta: number): void {
  target[store] = Math.max(0, (target[store] ?? 0) + delta)
}

function applyOfflineDownloadCheckpoint(
  meta: ModelCacheWorkspaceMeta,
  checkpoint: ModelCacheOfflineDownloadCheckpoint | undefined,
): void {
  if (!checkpoint) return
  const job = meta.offlineDownload
  if (!job
    || job.generation !== checkpoint.generation
    || job.ownerId !== checkpoint.ownerId
    || job.status !== 'running'
    || job.phase !== checkpoint.expectedPhase
    || job.nextCursor !== checkpoint.expectedCursor) {
    throw new WorkerOperationError(
      'offline_download_stale_checkpoint',
      'Offline download checkpoint no longer owns the current page',
    )
  }
  const updatedAt = Date.now()
  meta.offlineDownload = {
    ...job,
    phase: checkpoint.phase,
    nextCursor: checkpoint.nextCursor,
    objectCount: checkpoint.objectCount,
    connectionCount: checkpoint.connectionCount,
    diagramCount: checkpoint.diagramCount,
    ...(checkpoint.objectTotal !== undefined ? { objectTotal: checkpoint.objectTotal } : {}),
    ...(checkpoint.connectionTotal !== undefined ? { connectionTotal: checkpoint.connectionTotal } : {}),
    ...(checkpoint.diagramTotal !== undefined ? { diagramTotal: checkpoint.diagramTotal } : {}),
    updatedAt,
    leaseExpiresAt: updatedAt + OFFLINE_DOWNLOAD_LEASE_MS,
  }
}

function encodeCursor(cursor: PageCursor): string {
  return encodeURIComponent(JSON.stringify(cursor))
}

function decodeCursor(value: string | null | undefined): PageCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<PageCursor>
    if (typeof parsed.normalizedName !== 'string' || typeof parsed.id !== 'string') return null
    if (parsed.phase !== undefined && parsed.phase !== 'prefix' && parsed.phase !== 'contains') return null
    return { normalizedName: parsed.normalizedName, id: parsed.id, ...(parsed.phase ? { phase: parsed.phase } : {}) }
  } catch {
    return null
  }
}

function encodeConnectionCursor(cursor: ConnectionPageCursor): string {
  return encodeURIComponent(JSON.stringify(cursor))
}

function decodeConnectionCursor(value: string | null | undefined): ConnectionPageCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<ConnectionPageCursor>
    if (typeof parsed.id !== 'string' || (typeof parsed.value !== 'string' && typeof parsed.value !== 'number')) return null
    if (parsed.mode !== undefined && parsed.mode !== 'search') return null
    if (parsed.query !== undefined && typeof parsed.query !== 'string') return null
    if (parsed.phase !== undefined && parsed.phase !== 'label' && parsed.phase !== 'endpoint') return null
    if (parsed.direction !== undefined && parsed.direction !== 'from' && parsed.direction !== 'to') return null
    if (parsed.objectNextCursor !== undefined && parsed.objectNextCursor !== null
      && typeof parsed.objectNextCursor !== 'string') return null
    return {
      id: parsed.id,
      value: parsed.value,
      ...(parsed.mode ? { mode: parsed.mode } : {}),
      ...(parsed.query !== undefined ? { query: parsed.query } : {}),
      ...(parsed.phase ? { phase: parsed.phase } : {}),
      ...(parsed.direction ? { direction: parsed.direction } : {}),
      ...(parsed.objectNextCursor !== undefined ? { objectNextCursor: parsed.objectNextCursor } : {}),
    }
  } catch {
    return null
  }
}

function encodeDependencyCursor(cursor: DependencyPageCursor): string {
  return encodeURIComponent(JSON.stringify(cursor))
}

function decodeDependencyCursor(value: string | null | undefined): DependencyPageCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<DependencyPageCursor>
    if (typeof parsed.connectionCount !== 'number' || typeof parsed.name !== 'string' || typeof parsed.id !== 'string') return null
    return { connectionCount: parsed.connectionCount, name: parsed.name, id: parsed.id }
  } catch {
    return null
  }
}

function entityRecord(
  workspaceKey: string,
  generation: number,
  input: CachedModelEntityInput,
): CachedModelEntityRecord {
  const normalizedName = normalizeModelSearchText(input.name)
  const normalizedSearchText = normalizeModelSearchText(input.searchText ?? input.name)
  const payloadParentId = input.kind === 'object'
    && typeof (input.payload as { parentId?: unknown }).parentId === 'string'
    ? (input.payload as { parentId: string }).parentId
    : ROOT_PARENT_KEY
  const base = {
    ...input,
    workspaceKey,
    generation,
    parentKey: input.parentId ?? ROOT_PARENT_KEY,
    modelParentKey: payloadParentId,
    normalizedName,
    normalizedSearchText,
    searchTrigramKeys: objectSearchTrigramKeys(workspaceKey, generation, normalizedName, normalizedSearchText),
  }
  return { ...base, accountedBytes: estimateStructuredBytes(base) }
}

async function getMeta(workspaceKey: string): Promise<ModelCacheWorkspaceMeta> {
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.workspaceMeta, 'readonly')
  const meta = await requestResult(
    tx.objectStore(MODEL_CACHE_STORES.workspaceMeta).get(workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>
  )
  await transactionDone(tx)
  return meta ?? defaultMeta(workspaceKey)
}

async function activateGeneration(request: Extract<ModelReadCacheRequest, { op: 'activateGeneration' }>): Promise<OperationResult<ModelCacheWorkspaceMeta>> {
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.workspaceMeta, 'readwrite')
  const store = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const meta = (await requestResult(store.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>))
    ?? defaultMeta(request.workspaceKey)
  const stats = statsFor(meta, request.generation)
  meta.serverGeneration = Math.max(meta.serverGeneration, request.serverGeneration)
  meta.pinned = request.pinned ?? meta.pinned
  meta.lastAccessAt = Date.now()
  const keepCompleteGeneration = request.preserveFull
    && meta.activeGeneration === request.generation
    && meta.coverage === 'full'
  if (!keepCompleteGeneration) {
    meta.activeGeneration = request.generation
    meta.coverage = request.coverage
    meta.objectCount = stats.objectCount
    meta.connectionCount = stats.connectionCount
    meta.accountedBytes = { ...stats.accountedBytes }
  }
  store.put(meta)
  await transactionDone(tx)
  return { result: meta, rowsRead: 1 }
}

async function beginOfflineDownload(
  request: Extract<ModelReadCacheRequest, { op: 'beginOfflineDownload' }>,
): Promise<OperationResult<ModelCacheWorkspaceMeta>> {
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.workspaceMeta, 'readwrite')
  const store = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const meta = (await requestResult(
    store.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>,
  )) ?? defaultMeta(request.workspaceKey)
  const nowAt = Date.now()
  const existing = meta.offlineDownload
  statsFor(meta, request.generation)
  meta.lastAccessAt = nowAt
  if (existing?.generation === request.generation) {
    meta.offlineDownload = {
      ...existing,
      status: 'running',
      pinned: existing.pinned || request.pinned,
      ownerId: request.ownerId,
      leaseExpiresAt: nowAt + OFFLINE_DOWNLOAD_LEASE_MS,
      updatedAt: nowAt,
      errorCode: undefined,
      errorMessage: undefined,
    }
  } else {
    meta.offlineDownload = {
      generation: request.generation,
      serverGeneration: request.serverGeneration,
      status: 'running',
      phase: 'objects',
      nextCursor: null,
      objectCount: 0,
      connectionCount: 0,
      diagramCount: 0,
      pinned: request.pinned,
      ownerId: request.ownerId,
      leaseExpiresAt: nowAt + OFFLINE_DOWNLOAD_LEASE_MS,
      startedAt: nowAt,
      updatedAt: nowAt,
    }
  }

  // A brand-new browser has no useful active generation. Expose the target as a
  // disclosed working set while it grows; an existing complete/partial active
  // generation remains untouched until the final atomic promotion.
  const activeStats = meta.generationStats[String(meta.activeGeneration)]
  if (meta.activeGeneration === 0 && !activeStats) {
    const targetStats = statsFor(meta, request.generation)
    meta.activeGeneration = request.generation
    meta.coverage = 'working-set'
    meta.objectCount = targetStats.objectCount
    meta.connectionCount = targetStats.connectionCount
    meta.accountedBytes = { ...targetStats.accountedBytes }
  }
  store.put(meta)
  await transactionDone(tx)
  return { result: meta, rowsRead: 1 }
}

async function upsertObjects(request: Extract<ModelReadCacheRequest, { op: 'upsertObjects' }>): Promise<OperationResult<{ count: number }>> {
  const records = request.items.map((item) => entityRecord(request.workspaceKey, request.generation, item))
  const db = await openModelReadCache()
  const tx = db.transaction(
    [MODEL_CACHE_STORES.objects, MODEL_CACHE_STORES.workspaceMeta],
    'readwrite',
    // These rows are a reconstructable projection. The generation is promoted
    // only after the snapshot verification pass, so a crash may force a clean
    // rebuild but can never expose a partially durable cache as complete.
    { durability: 'relaxed' },
  )
  const objects = tx.objectStore(MODEL_CACHE_STORES.objects)
  const metaStore = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)

  const [oldRecords, storedMeta] = await Promise.all([
    request.assumeAbsent && !request.downloadCheckpoint
      ? Promise.resolve(records.map(() => undefined))
      : Promise.all(records.map((record) => requestResult(
        objects.get([request.workspaceKey, request.generation, record.id]) as IDBRequest<CachedModelEntityRecord | undefined>
      ))),
    requestResult(metaStore.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>),
  ])

  const meta = storedMeta ?? defaultMeta(request.workspaceKey)
  applyOfflineDownloadCheckpoint(meta, request.downloadCheckpoint)
  const stats = statsFor(meta, request.generation)
  let objectBytesDelta = 0
  let added = 0

  records.forEach((record, index) => {
    const old = oldRecords[index]
    if (!old) added += 1
    objectBytesDelta += record.accountedBytes - (old?.accountedBytes ?? 0)
    objects.put(record)
  })

  stats.objectCount += added
  addBytes(stats.accountedBytes, MODEL_CACHE_STORES.objects, objectBytesDelta)
  meta.lastAccessAt = Date.now()
  if (meta.activeGeneration === request.generation) {
    meta.objectCount = stats.objectCount
    meta.accountedBytes = { ...stats.accountedBytes }
  }
  metaStore.put(meta)
  await transactionDone(tx)
  return { result: { count: records.length }, rowsRead: oldRecords.length }
}

async function upsertConnections(request: Extract<ModelReadCacheRequest, { op: 'upsertConnections' }>): Promise<OperationResult<{ count: number }>> {
  const records: CachedConnectionRecord[] = request.items.map((input) => {
    const connection = input.connection
    const base = {
      ...input,
      workspaceKey: request.workspaceKey,
      generation: request.generation,
      id: connection.id,
      fromId: connection.fromId,
      toId: connection.toId,
      normalizedLabel: normalizeModelSearchText(connection.label ?? ''),
      normalizedFromName: normalizeModelSearchText(input.fromName),
      normalizedToName: normalizeModelSearchText(input.toName),
      normalizedSearchText: normalizeModelSearchText(
        `${connection.label ?? ''} ${input.fromName} ${input.toName}`,
      ),
    }
    return { ...base, accountedBytes: estimateStructuredBytes(base) }
  })
  const db = await openModelReadCache()
  const tx = db.transaction(
    [MODEL_CACHE_STORES.connections, MODEL_CACHE_STORES.workspaceMeta],
    'readwrite',
    { durability: 'relaxed' },
  )
  const connections = tx.objectStore(MODEL_CACHE_STORES.connections)
  const metaStore = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const [oldRecords, storedMeta] = await Promise.all([
    request.assumeAbsent && !request.downloadCheckpoint
      ? Promise.resolve(records.map(() => undefined))
      : Promise.all(records.map((record) => requestResult(
        connections.get([request.workspaceKey, request.generation, record.id]) as IDBRequest<CachedConnectionRecord | undefined>
      ))),
    requestResult(metaStore.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>),
  ])
  const meta = storedMeta ?? defaultMeta(request.workspaceKey)
  applyOfflineDownloadCheckpoint(meta, request.downloadCheckpoint)
  const stats = statsFor(meta, request.generation)
  let bytesDelta = 0
  let added = 0
  records.forEach((record, index) => {
    const old = oldRecords[index]
    if (!old) added += 1
    bytesDelta += record.accountedBytes - (old?.accountedBytes ?? 0)
    connections.put(record)
  })
  stats.connectionCount += added
  addBytes(stats.accountedBytes, MODEL_CACHE_STORES.connections, bytesDelta)
  meta.lastAccessAt = Date.now()
  if (meta.activeGeneration === request.generation) {
    meta.connectionCount = stats.connectionCount
    meta.accountedBytes = { ...stats.accountedBytes }
  }
  metaStore.put(meta)
  await transactionDone(tx)
  return { result: { count: records.length }, rowsRead: oldRecords.length }
}

async function upsertDiagramManifests(
  request: Extract<ModelReadCacheRequest, { op: 'upsertDiagramManifests' }>,
): Promise<OperationResult<{ count: number }>> {
  const records: CachedDiagramManifestRecord[] = request.items.map((item: CachedDiagramManifestInput) => {
    const base = {
      ...item,
      workspaceKey: request.workspaceKey,
      generation: request.generation,
      entityId: '__manifest__' as const,
    }
    return { ...base, accountedBytes: estimateStructuredBytes(base) }
  })
  const db = await openModelReadCache()
  const tx = db.transaction(
    [MODEL_CACHE_STORES.diagramMembership, MODEL_CACHE_STORES.workspaceMeta],
    'readwrite',
  )
  const manifests = tx.objectStore(MODEL_CACHE_STORES.diagramMembership)
  const metaStore = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const [oldRecords, storedMeta] = await Promise.all([
    Promise.all(records.map((record) => requestResult(
      manifests.get([
        record.workspaceKey, record.generation, record.diagramId, record.entityId,
      ]) as IDBRequest<CachedDiagramManifestRecord | undefined>,
    ))),
    requestResult(metaStore.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>),
  ])
  const meta = storedMeta ?? defaultMeta(request.workspaceKey)
  applyOfflineDownloadCheckpoint(meta, request.downloadCheckpoint)
  const stats = statsFor(meta, request.generation)
  let bytesDelta = 0
  records.forEach((record, index) => {
    const old = oldRecords[index]
    bytesDelta += record.accountedBytes - (old?.accountedBytes ?? 0)
    manifests.put(record)
  })
  addBytes(stats.accountedBytes, MODEL_CACHE_STORES.diagramMembership, bytesDelta)
  if (meta.activeGeneration === request.generation) meta.accountedBytes = { ...stats.accountedBytes }
  meta.lastAccessAt = Date.now()
  metaStore.put(meta)
  await transactionDone(tx)
  return { result: { count: records.length }, rowsRead: oldRecords.length }
}

async function collectCursorPage<T>(
  source: IDBIndex,
  range: IDBKeyRange,
  limit: number,
): Promise<{ rows: T[]; hasMore: boolean }> {
  return new Promise((resolve, reject) => {
    const rows: T[] = []
    const cursorRequest = source.openCursor(range)
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB cursor failed'))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor || rows.length > limit) {
        resolve({ rows: rows.slice(0, limit), hasMore: rows.length > limit })
        return
      }
      rows.push(cursor.value as T)
      cursor.continue()
    }
  })
}

async function queryChildren(request: Extract<ModelReadCacheRequest, { op: 'queryChildren' }>): Promise<OperationResult<ModelCachePage<CachedModelEntityRecord>>> {
  const meta = await getMeta(request.workspaceKey)
  const after = decodeCursor(request.after)
  if (request.after && !after) throw new Error('Invalid model-cache cursor')
  const parentKey = request.parentId ?? ROOT_PARENT_KEY
  const limit = Math.min(100, Math.max(1, request.limit))
  const lower = after
    ? [request.workspaceKey, meta.activeGeneration, parentKey, after.normalizedName, after.id]
    : [request.workspaceKey, meta.activeGeneration, parentKey]
  const upper = [request.workspaceKey, meta.activeGeneration, parentKey, []]
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.objects, 'readonly')
  const page = await collectCursorPage<CachedModelEntityRecord>(
    tx.objectStore(MODEL_CACHE_STORES.objects).index('byParent'),
    IDBKeyRange.bound(lower, upper, Boolean(after), false),
    limit,
  )
  await transactionDone(tx)
  // Parent summaries arrive independently from child pages/change-feed rows.
  // Reconcile every visible row against the active generation's parent index,
  // otherwise a stale positive childCount renders a chevron that opens nothing.
  // At most `limit` (100, normally 50) indexed first-key probes are issued. A
  // full `count(range)` is deliberately avoided: on 50 expanded roots it would
  // walk tens of thousands of child keys merely to decide whether to draw a
  // chevron. No child payload is materialized on the worker or main thread.
  const countTx = db.transaction(MODEL_CACHE_STORES.objects, 'readonly')
  const childIndex = countTx.objectStore(MODEL_CACHE_STORES.objects).index('byParent')
  const indexedFirstChildKeys = await Promise.all(page.rows.map((row) => requestResult(
    childIndex.getKey(IDBKeyRange.bound(
      [request.workspaceKey, meta.activeGeneration, row.id],
      [request.workspaceKey, meta.activeGeneration, row.id, []],
    )),
  )))
  await transactionDone(countTx)
  const reconciledRows = page.rows.map((row, index) => ({
    ...row,
    childCount: reconciledCachedChildCount(row.childCount, indexedFirstChildKeys[index] !== undefined),
  }))
  const last = reconciledRows.at(-1)
  return {
    result: {
      items: reconciledRows,
      nextCursor: page.hasMore && last ? encodeCursor({ normalizedName: last.normalizedName, id: last.id }) : null,
      generation: meta.activeGeneration,
      coverage: meta.coverage,
      total: meta.objectCount,
    },
    rowsRead: page.rows.length + indexedFirstChildKeys.length + (page.hasMore ? 1 : 0),
  }
}

async function prefixSearch(
  workspaceKey: string,
  generation: number,
  query: string,
  limit: number,
  after: PageCursor | null,
): Promise<{ rows: CachedModelEntityRecord[]; hasMore: boolean }> {
  const lower = after
    ? [workspaceKey, generation, after.normalizedName, after.id]
    : [workspaceKey, generation, query]
  const upper = [workspaceKey, generation, `${query}\uffff`, []]
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.objects, 'readonly')
  const page = await collectCursorPage<CachedModelEntityRecord>(
    tx.objectStore(MODEL_CACHE_STORES.objects).index('byName'),
    IDBKeyRange.bound(lower, upper, Boolean(after), false),
    limit,
  )
  await transactionDone(tx)
  return page
}

async function containsSearch(
  workspaceKey: string,
  generation: number,
  query: string,
  after: PageCursor | null,
  limit: number,
): Promise<{ rows: CachedModelEntityRecord[]; rowsRead: number; hasMore: boolean }> {
  const trigrams = searchTrigrams(query)
  if (!trigrams.length) return { rows: [], rowsRead: 0, hasMore: false }
  const db = await openModelReadCache()

  const countTx = db.transaction(MODEL_CACHE_STORES.objects, 'readonly')
  const trigramIndex = countTx.objectStore(MODEL_CACHE_STORES.objects).index('bySearchTrigram')
  const counts = trigrams.map((trigram) => ({
    trigram,
    prefix: objectSearchTrigramPrefix(workspaceKey, generation, trigram),
    count: 0,
  }))
  await Promise.all(counts.map(async (entry) => {
    entry.count = await requestResult(trigramIndex.count(IDBKeyRange.bound(
      entry.prefix,
      `${entry.prefix}\uffff`,
    )))
  }))
  await transactionDone(countTx)
  counts.sort((a, b) => a.count - b.count)
  const rarest = counts[0]
  if (!rarest || rarest.count === 0) return { rows: [], rowsRead: 0, hasMore: false }

  // Each multi-entry key is `<scope><trigram><normalized name>`, so IndexedDB
  // supplies candidates directly in the UI's final name order. No posting
  // records or follow-up object gets are required.
  const tx = db.transaction(MODEL_CACHE_STORES.objects, 'readonly')
  const source = tx.objectStore(MODEL_CACHE_STORES.objects).index('bySearchTrigram')
  const lower = after ? `${rarest.prefix}${after.normalizedName}` : rarest.prefix
  const upper = `${rarest.prefix}\uffff`
  const result = await new Promise<{ rows: CachedModelEntityRecord[]; rowsRead: number; hasMore: boolean }>((resolve, reject) => {
    const rows: CachedModelEntityRecord[] = []
    let rowsRead = 0
    let positionedAfter = !after
    const cursorRequest = source.openCursor(IDBKeyRange.bound(lower, upper))
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB object trigram cursor failed'))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        resolve({ rows, rowsRead, hasMore: false })
        return
      }
      const record = cursor.value as CachedModelEntityRecord
      const key = String(cursor.key)
      if (!positionedAfter && after) {
        positionedAfter = true
        if (key === `${rarest.prefix}${after.normalizedName}` && record.id <= after.id) {
          try {
            cursor.continuePrimaryKey(key, [workspaceKey, generation, `${after.id}\u0000`])
            return
          } catch {
            // Fall through to a bounded skip for browsers without the API.
          }
        }
      }
      if (after && key === `${rarest.prefix}${after.normalizedName}` && record.id <= after.id) {
        cursor.continue()
        return
      }
      rowsRead += 1
      if (record.normalizedSearchText.includes(query) && !record.normalizedName.startsWith(query)) rows.push(record)
      if (rows.length > limit) {
        resolve({ rows, rowsRead, hasMore: true })
        return
      }
      cursor.continue()
    }
  })
  await transactionDone(tx)
  return result
}

async function searchObjects(request: Extract<ModelReadCacheRequest, { op: 'searchObjects' }>): Promise<OperationResult<ModelCachePage<ModelCacheSearchItem>>> {
  const query = normalizeModelSearchText(request.query)
  const meta = await getMeta(request.workspaceKey)
  const limit = Math.min(100, Math.max(1, request.limit))
  const mode = modelCacheSearchMode(query)
  const after = decodeCursor(request.after)
  if (request.after && !after) throw new Error('Invalid model-cache search cursor')
  if (mode === 'too-short') {
    return { result: { items: [], nextCursor: null, generation: meta.activeGeneration, coverage: meta.coverage, total: meta.objectCount }, rowsRead: 0 }
  }
  if (mode === 'browse') {
    const browse = await prefixSearch(request.workspaceKey, meta.activeGeneration, '', limit, after)
    const last = browse.rows.at(-1)
    return {
      result: {
        items: browse.rows.map((row) => ({ ...row, matchKind: 'prefix' as const })),
        nextCursor: browse.hasMore && last
          ? encodeCursor({ phase: 'prefix', normalizedName: last.normalizedName, id: last.id })
          : null,
        generation: meta.activeGeneration,
        coverage: meta.coverage,
        total: meta.objectCount,
      },
      rowsRead: browse.rows.length + (browse.hasMore ? 1 : 0),
    }
  }
  const phase = after?.phase ?? 'prefix'
  let rowsRead = 0
  const items: ModelCacheSearchItem[] = []

  if (phase === 'prefix') {
    const prefix = await prefixSearch(request.workspaceKey, meta.activeGeneration, query, limit, after)
    rowsRead += prefix.rows.length + (prefix.hasMore ? 1 : 0)
    items.push(...prefix.rows.map((row) => ({
      ...row,
      matchKind: row.normalizedName === query ? 'exact' as const : 'prefix' as const,
    })))
    if (prefix.hasMore) {
      const last = prefix.rows.at(-1)!
      return {
        result: {
          items,
          nextCursor: encodeCursor({ phase: 'prefix', normalizedName: last.normalizedName, id: last.id }),
          generation: meta.activeGeneration,
          coverage: meta.coverage,
          total: meta.objectCount,
        },
        rowsRead,
      }
    }
  }

  if (query.length >= 3 && items.length < limit) {
    const containsAfter = phase === 'contains' ? after : null
    const remaining = limit - items.length
    const contains = await containsSearch(
      request.workspaceKey,
      meta.activeGeneration,
      query,
      containsAfter,
      remaining,
    )
    rowsRead += contains.rowsRead
    const selected = contains.rows.slice(0, remaining)
    items.push(...selected.map((row) => ({ ...row, matchKind: 'contains' as const })))
    const hasMore = contains.hasMore
    const last = selected.at(-1)
    return {
      result: {
        items,
        nextCursor: hasMore && last
          ? encodeCursor({ phase: 'contains', normalizedName: last.normalizedName, id: last.id })
          : null,
        generation: meta.activeGeneration,
        coverage: meta.coverage,
        total: meta.objectCount,
      },
      rowsRead,
    }
  }

  return {
    result: { items, nextCursor: null, generation: meta.activeGeneration, coverage: meta.coverage, total: meta.objectCount },
    rowsRead,
  }
}

async function queryConnectionsBySearch(
  request: Extract<ModelReadCacheRequest, { op: 'queryConnections' }>,
  meta: ModelCacheWorkspaceMeta,
  query: string,
  domainId: string | null,
  after: ConnectionPageCursor | null,
): Promise<OperationResult<ModelCacheConnectionPage>> {
  const limit = Math.min(100, Math.max(1, request.limit))
  if (after && (
    after.mode !== 'search'
    || after.query !== query
    || typeof after.value !== 'string'
    || (after.phase !== 'label' && after.phase !== 'endpoint')
  )) {
    throw new Error('Connection search cursor does not match the active query')
  }

  const db = await openModelReadCache()
  const rows: CachedConnectionRecord[] = []
  let rowsRead = 0
  let remainingScanBudget = 750
  let remainingObjectLookups = 100
  const matchesDomain = (record: CachedConnectionRecord) => (
    !domainId || record.fromDomainId === domainId || record.toDomainId === domainId
  )

  const scanIndex = async (options: {
    indexName: 'byName' | 'byFrom' | 'byTo'
    range: IDBKeyRange
    remaining: number
    maxRows: number
    accept: (record: CachedConnectionRecord) => boolean
  }): Promise<{
    items: CachedConnectionRecord[]
    rowsRead: number
    hasMore: boolean
    resumeValue: string
    resumeId: string
  }> => {
    const tx = db.transaction(MODEL_CACHE_STORES.connections, 'readonly')
    const source = tx.objectStore(MODEL_CACHE_STORES.connections).index(options.indexName)
    const result = await new Promise<{
      items: CachedConnectionRecord[]
      rowsRead: number
      hasMore: boolean
      resumeValue: string
      resumeId: string
    }>((resolve, reject) => {
      const items: CachedConnectionRecord[] = []
      let scanned = 0
      let lastScanned: CachedConnectionRecord | null = null
      const cursorRequest = source.openCursor(options.range)
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB connection search cursor failed'))
      cursorRequest.onsuccess = () => {
        if (cancelled.has(request.id)) {
          tx.abort()
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        const cursor = cursorRequest.result
        if (!cursor) {
          const resume = items.at(-1) ?? lastScanned
          resolve({
            items,
            rowsRead: scanned,
            hasMore: false,
            resumeValue: resume?.normalizedLabel ?? '',
            resumeId: resume?.id ?? '',
          })
          return
        }
        const record = cursor.value as CachedConnectionRecord
        scanned += 1
        lastScanned = record
        if (options.accept(record)) items.push(record)
        if (items.length > options.remaining) {
          const selected = items.slice(0, options.remaining)
          const resume = selected.at(-1)!
          resolve({
            items: selected,
            rowsRead: scanned,
            hasMore: true,
            resumeValue: options.indexName === 'byName' ? resume.normalizedLabel : resume.id,
            resumeId: resume.id,
          })
          return
        }
        if (scanned >= options.maxRows) {
          resolve({
            items,
            rowsRead: scanned,
            hasMore: true,
            resumeValue: options.indexName === 'byName' ? record.normalizedLabel : record.id,
            resumeId: record.id,
          })
          return
        }
        cursor.continue()
      }
    })
    await transactionDone(tx)
    return result
  }

  const connectionPage = (nextCursor: string | null): OperationResult<ModelCacheConnectionPage> => ({
    result: {
      items: rows,
      nextCursor,
      generation: meta.activeGeneration,
      coverage: meta.coverage,
      total: meta.connectionCount,
    },
    rowsRead,
  })

  // Labels are naturally prefix-searchable through the table's existing name
  // index. Endpoint names use the object trigram index below, so connection
  // records no longer duplicate every endpoint word in a multi-entry index.
  if (!after || after.phase === 'label') {
    const labelAfter = after?.phase === 'label' ? after : null
    const lower = labelAfter
      ? [request.workspaceKey, meta.activeGeneration, labelAfter.value, labelAfter.id]
      : [request.workspaceKey, meta.activeGeneration, query]
    const upper = [request.workspaceKey, meta.activeGeneration, `${query}\uffff`, []]
    const labelScan = await scanIndex({
      indexName: 'byName',
      range: IDBKeyRange.bound(lower, upper, Boolean(labelAfter), false),
      remaining: limit,
      maxRows: remainingScanBudget,
      accept: matchesDomain,
    })
    rows.push(...labelScan.items)
    rowsRead += labelScan.rowsRead
    remainingScanBudget -= labelScan.rowsRead
    if (labelScan.hasMore) {
      return connectionPage(encodeConnectionCursor({
        value: labelScan.resumeValue,
        id: labelScan.resumeId,
        mode: 'search',
        query,
        phase: 'label',
      }))
    }
    if (rows.length >= limit) {
      return connectionPage(encodeConnectionCursor({
        value: '', id: '', mode: 'search', query, phase: 'endpoint',
        direction: 'from', objectNextCursor: '',
      }))
    }
  }

  let objectId = after?.phase === 'endpoint' ? after.id : ''
  let objectNextCursor = after?.phase === 'endpoint' ? after.objectNextCursor : ''
  let direction: 'from' | 'to' = after?.phase === 'endpoint' ? (after.direction ?? 'from') : 'from'
  let connectionAfter = after?.phase === 'endpoint' ? String(after.value) : ''

  const loadNextMatchingObject = async (): Promise<'loaded' | 'done' | 'paused'> => {
    if (objectNextCursor === null) return 'done'
    if (remainingObjectLookups <= 0) return 'paused'
    remainingObjectLookups -= 1
    const objectPage = await searchObjects({
      id: request.id,
      op: 'searchObjects',
      workspaceKey: request.workspaceKey,
      query,
      limit: 1,
      after: objectNextCursor || null,
    })
    rowsRead += objectPage.rowsRead ?? 0
    const object = objectPage.result.items[0]
    if (!object) {
      objectNextCursor = null
      return 'done'
    }
    objectId = object.id
    objectNextCursor = objectPage.result.nextCursor
    direction = 'from'
    connectionAfter = ''
    return 'loaded'
  }

  if (!objectId) {
    const loaded = await loadNextMatchingObject()
    if (loaded === 'done') return connectionPage(null)
    if (loaded === 'paused') {
      return connectionPage(encodeConnectionCursor({
        value: '', id: '', mode: 'search', query, phase: 'endpoint',
        direction: 'from', objectNextCursor,
      }))
    }
  }

  while (objectId && rows.length < limit) {
    if (direction === 'from') {
      if (remainingScanBudget <= 0) {
        return connectionPage(encodeConnectionCursor({
          value: connectionAfter, id: objectId, mode: 'search', query,
          phase: 'endpoint', direction: 'from', objectNextCursor,
        }))
      }
      const lower = connectionAfter
        ? [request.workspaceKey, meta.activeGeneration, objectId, connectionAfter]
        : [request.workspaceKey, meta.activeGeneration, objectId]
      const upper = [request.workspaceKey, meta.activeGeneration, objectId, []]
      const fromScan = await scanIndex({
        indexName: 'byFrom',
        range: IDBKeyRange.bound(lower, upper, Boolean(connectionAfter), false),
        remaining: limit - rows.length,
        maxRows: Math.max(1, remainingScanBudget),
        accept: (record) => record.normalizedFromName.includes(query)
          && !record.normalizedLabel.startsWith(query)
          && matchesDomain(record),
      })
      rows.push(...fromScan.items)
      rowsRead += fromScan.rowsRead
      remainingScanBudget -= fromScan.rowsRead
      if (fromScan.hasMore) {
        return connectionPage(encodeConnectionCursor({
          value: fromScan.resumeId,
          id: objectId,
          mode: 'search', query, phase: 'endpoint', direction: 'from', objectNextCursor,
        }))
      }
      connectionAfter = ''
      if (rows.length >= limit) {
        return connectionPage(encodeConnectionCursor({
          value: '', id: objectId, mode: 'search', query,
          phase: 'endpoint', direction: 'to', objectNextCursor,
        }))
      }
    }

    if (remainingScanBudget <= 0) {
      return connectionPage(encodeConnectionCursor({
        value: connectionAfter, id: objectId, mode: 'search', query,
        phase: 'endpoint', direction: 'to', objectNextCursor,
      }))
    }
    const lower = connectionAfter
      ? [request.workspaceKey, meta.activeGeneration, objectId, connectionAfter]
      : [request.workspaceKey, meta.activeGeneration, objectId]
    const upper = [request.workspaceKey, meta.activeGeneration, objectId, []]
    const toScan = await scanIndex({
      indexName: 'byTo',
      range: IDBKeyRange.bound(lower, upper, Boolean(connectionAfter), false),
      remaining: limit - rows.length,
      maxRows: Math.max(1, remainingScanBudget),
      accept: (record) => record.normalizedToName.includes(query)
        && !record.normalizedFromName.includes(query)
        && !record.normalizedLabel.startsWith(query)
        && matchesDomain(record),
    })
    rows.push(...toScan.items)
    rowsRead += toScan.rowsRead
    remainingScanBudget -= toScan.rowsRead
    if (toScan.hasMore) {
      return connectionPage(encodeConnectionCursor({
        value: toScan.resumeId,
        id: objectId,
        mode: 'search', query, phase: 'endpoint', direction: 'to', objectNextCursor,
      }))
    }

    objectId = ''
    direction = 'from'
    connectionAfter = ''
    if (rows.length >= limit) {
      return connectionPage(objectNextCursor === null ? null : encodeConnectionCursor({
        value: '', id: '', mode: 'search', query, phase: 'endpoint',
        direction: 'from', objectNextCursor,
      }))
    }
    if (remainingScanBudget <= 0) {
      return connectionPage(encodeConnectionCursor({
        value: '', id: '', mode: 'search', query, phase: 'endpoint',
        direction: 'from', objectNextCursor,
      }))
    }
    const loaded = await loadNextMatchingObject()
    if (loaded === 'done') break
    if (loaded === 'paused') {
      return connectionPage(encodeConnectionCursor({
        value: '', id: '', mode: 'search', query, phase: 'endpoint',
        direction: 'from', objectNextCursor,
      }))
    }
  }

  return connectionPage(null)
}

async function queryConnections(request: Extract<ModelReadCacheRequest, { op: 'queryConnections' }>): Promise<OperationResult<ModelCacheConnectionPage>> {
  const meta = await getMeta(request.workspaceKey)
  const limit = Math.min(100, Math.max(1, request.limit))
  const sortBy = request.sortBy ?? 'name'
  const sortAsc = request.sortAsc !== false
  const query = normalizeModelSearchText(request.query ?? '')
  const domainId = request.domainId ?? null
  const after = decodeConnectionCursor(request.after)
  if (request.after && !after) throw new Error('Invalid model-cache connection cursor')
  if (query) return queryConnectionsBySearch(request, meta, query, domainId, after)
  if (after?.mode) throw new Error('Connection search cursor cannot be used without a query')
  const numericSort = sortBy === 'diagrams' || sortBy === 'flows'
  if (after && (numericSort ? typeof after.value !== 'number' : typeof after.value !== 'string')) {
    throw new Error('Invalid model-cache connection cursor value')
  }
  const indexName = {
    name: 'byName', sender: 'bySender', receiver: 'byReceiver', diagrams: 'byDiagrams', flows: 'byFlows',
  }[sortBy]
  const sortValue = (record: CachedConnectionRecord): string | number => {
    if (sortBy === 'sender') return record.normalizedFromName
    if (sortBy === 'receiver') return record.normalizedToName
    if (sortBy === 'diagrams') return record.diagramCount
    if (sortBy === 'flows') return record.flowCount
    return record.normalizedLabel
  }
  const lower = [request.workspaceKey, meta.activeGeneration]
  const upper = [request.workspaceKey, meta.activeGeneration, []]
  const range = sortAsc
    ? IDBKeyRange.bound(
      after ? [request.workspaceKey, meta.activeGeneration, after.value, after.id] : lower,
      upper,
      Boolean(after),
      false,
    )
    : IDBKeyRange.bound(
      lower,
      after ? [request.workspaceKey, meta.activeGeneration, after.value, after.id] : upper,
      false,
      Boolean(after),
    )
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.connections, 'readonly')
  const source = tx.objectStore(MODEL_CACHE_STORES.connections).index(indexName)
  const scan = await new Promise<{ rows: CachedConnectionRecord[]; rowsRead: number; hasMore: boolean }>((resolve, reject) => {
    const rows: CachedConnectionRecord[] = []
    let rowsRead = 0
    const cursorRequest = source.openCursor(range, sortAsc ? 'next' : 'prev')
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB connection cursor failed'))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        resolve({ rows, rowsRead, hasMore: false })
        return
      }
      rowsRead += 1
      const record = cursor.value as CachedConnectionRecord
      const matchesQuery = !query || record.normalizedSearchText.includes(query)
      const matchesDomain = !domainId || record.fromDomainId === domainId || record.toDomainId === domainId
      if (matchesQuery && matchesDomain) rows.push(record)
      if (rows.length > limit) {
        resolve({ rows, rowsRead, hasMore: true })
        return
      }
      cursor.continue()
    }
  })
  await transactionDone(tx)
  const items = scan.rows.slice(0, limit)
  const last = items.at(-1)
  return {
    result: {
      items,
      nextCursor: scan.hasMore && last
        ? encodeConnectionCursor({ value: sortValue(last), id: last.id })
        : null,
      generation: meta.activeGeneration,
      coverage: meta.coverage,
      // Exact filtered totals would require a full offline scan. Keep the stable
      // workspace total for the shell; rendered rows remain cursor-bounded.
      total: meta.connectionCount,
    },
    rowsRead: scan.rowsRead,
  }
}

async function queryDependencyPeers(
  request: Extract<ModelReadCacheRequest, { op: 'queryDependencyPeers' }>,
): Promise<OperationResult<ModelCacheDependencyPage>> {
  const meta = await getMeta(request.workspaceKey)
  const limit = Math.min(50, Math.max(1, request.limit))
  const query = normalizeModelSearchText(request.search ?? '')
  const globalQuery = normalizeModelSearchText(request.globalSearch ?? '')
  const after = decodeDependencyCursor(request.after)
  if (request.after && !after) throw new Error('Invalid model-cache dependency cursor')
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.connections, 'readonly')
  const store = tx.objectStore(MODEL_CACHE_STORES.connections)
  const source = store.index(request.direction === 'incoming' ? 'byTo' : 'byFrom')
  const range = IDBKeyRange.bound(
    [request.workspaceKey, meta.activeGeneration, request.focusId],
    [request.workspaceKey, meta.activeGeneration, request.focusId, []],
  )
  interface Aggregate {
    peerId: string
    normalizedName: string
    representativeConnection: CachedConnectionRecord
    connectionCount: number
    directCount: number
    lowerCount: number
    matchesQuery: boolean
    matchesGlobal: boolean
  }
  const aggregates = new Map<string, Aggregate>()
  let rowsRead = 0
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = source.openCursor(range)
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB dependency cursor failed'))
    cursorRequest.onsuccess = () => {
      if (cancelled.has(request.id)) {
        tx.abort()
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const cursor = cursorRequest.result
      if (!cursor) { resolve(); return }
      rowsRead += 1
      const record = cursor.value as CachedConnectionRecord
      const peerId = request.direction === 'incoming' ? record.fromId : record.toId
      if (peerId !== request.focusId) {
        const peerDomainId = request.direction === 'incoming' ? record.fromDomainId : record.toDomainId
        if (!request.domainId || peerDomainId === request.domainId) {
          const normalizedName = request.direction === 'incoming' ? record.normalizedFromName : record.normalizedToName
          const label = record.normalizedLabel
          const existing = aggregates.get(peerId)
          if (existing) {
            existing.connectionCount += 1
            if (record.connection.kind === 'lower') existing.lowerCount += 1
            else {
              existing.directCount += 1
              if (existing.representativeConnection.connection.kind === 'lower') existing.representativeConnection = record
            }
            existing.matchesQuery ||= !query || normalizedName.includes(query) || label.includes(query)
            existing.matchesGlobal ||= !globalQuery || normalizedName.includes(globalQuery) || label.includes(globalQuery)
          } else {
            aggregates.set(peerId, {
              peerId,
              normalizedName,
              representativeConnection: record,
              connectionCount: 1,
              directCount: record.connection.kind === 'lower' ? 0 : 1,
              lowerCount: record.connection.kind === 'lower' ? 1 : 0,
              matchesQuery: !query || normalizedName.includes(query) || label.includes(query),
              matchesGlobal: !globalQuery || normalizedName.includes(globalQuery) || label.includes(globalQuery),
            })
          }
        }
      }
      cursor.continue()
    }
  })
  await transactionDone(tx)

  const compare = (a: Aggregate, b: Aggregate) => b.connectionCount - a.connectionCount
    || a.normalizedName.localeCompare(b.normalizedName)
    || a.peerId.localeCompare(b.peerId)
  const isAfter = (item: Aggregate) => !after
    || item.connectionCount < after.connectionCount
    || (item.connectionCount === after.connectionCount
      && (item.normalizedName > after.name || (item.normalizedName === after.name && item.peerId > after.id)))
  const selected: Aggregate[] = []
  let totalPeers = 0
  let totalConnections = 0
  for (const aggregate of aggregates.values()) {
    if (!aggregate.matchesQuery || !aggregate.matchesGlobal) continue
    totalPeers += 1
    totalConnections += aggregate.connectionCount
    if (!isAfter(aggregate)) continue
    selected.push(aggregate)
    selected.sort(compare)
    if (selected.length > limit + 1) selected.pop()
  }
  const page = selected.slice(0, limit)
  const objectTx = db.transaction(MODEL_CACHE_STORES.objects, 'readonly')
  const objectStore = objectTx.objectStore(MODEL_CACHE_STORES.objects)
  const peers = await Promise.all(page.map((item) => requestResult(
    objectStore.get([request.workspaceKey, meta.activeGeneration, item.peerId]) as IDBRequest<CachedModelEntityRecord | undefined>,
  )))
  await transactionDone(objectTx)
  rowsRead += peers.filter(Boolean).length
  const last = page.at(-1)
  return {
    result: {
      items: page.map((item, index) => ({
        peerId: item.peerId,
        peer: peers[index] ?? null,
        representativeConnection: item.representativeConnection,
        connectionCount: item.connectionCount,
        directCount: item.directCount,
        lowerCount: item.lowerCount,
      })),
      nextCursor: selected.length > limit && last
        ? encodeDependencyCursor({ connectionCount: last.connectionCount, name: last.normalizedName, id: last.peerId })
        : null,
      totalPeers,
      totalConnections,
      generation: meta.activeGeneration,
      coverage: meta.coverage,
    },
    rowsRead,
  }
}

async function readCachedEntity(
  db: IDBDatabase,
  workspaceKey: string,
  generation: number,
  id: string,
): Promise<CachedModelEntityRecord | undefined> {
  const tx = db.transaction(MODEL_CACHE_STORES.objects, 'readonly')
  const result = await requestResult(
    tx.objectStore(MODEL_CACHE_STORES.objects).get([workspaceKey, generation, id]) as IDBRequest<CachedModelEntityRecord | undefined>,
  )
  await transactionDone(tx)
  return result
}

async function queryViewerLevel(
  request: Extract<ModelReadCacheRequest, { op: 'queryViewerLevel' }>,
): Promise<OperationResult<ModelCacheViewerLevel>> {
  const meta = await getMeta(request.workspaceKey)
  const query = normalizeModelSearchText(request.query ?? '')
  const domainIds = new Set(request.domainIds ?? [])
  const limit = Math.min(250, Math.max(1, request.limit))
  const connectionLimit = Math.min(2_000, Math.max(1, request.connectionLimit))
  const after = decodeCursor(request.after)
  if (request.after && !after) throw new Error('Invalid model-cache viewer cursor')
  const parentKey = request.parentId ?? ROOT_PARENT_KEY
  const db = await openModelReadCache()
  const objectTx = db.transaction(MODEL_CACHE_STORES.objects, 'readonly')
  const source = objectTx.objectStore(MODEL_CACHE_STORES.objects).index('byParent')
  const range = IDBKeyRange.bound(
    [request.workspaceKey, meta.activeGeneration, parentKey],
    [request.workspaceKey, meta.activeGeneration, parentKey, []],
  )
  const objects: CachedModelEntityRecord[] = []
  let totalObjects = 0
  let rowsRead = 0
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = source.openCursor(range)
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB viewer-level cursor failed'))
    cursorRequest.onsuccess = () => {
      if (cancelled.has(request.id)) {
        objectTx.abort()
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const cursor = cursorRequest.result
      if (!cursor) { resolve(); return }
      rowsRead += 1
      const record = cursor.value as CachedModelEntityRecord
      const payload = record.payload as { domainId?: string }
      const matches = (!query || record.normalizedName.includes(query))
        && (!domainIds.size || Boolean(payload.domainId && domainIds.has(payload.domainId)))
      if (matches) {
        totalObjects += 1
        const afterCursor = !after
          || record.normalizedName > after.normalizedName
          || (record.normalizedName === after.normalizedName && record.id > after.id)
        if (afterCursor && objects.length <= limit) objects.push(record)
      }
      cursor.continue()
    }
  })
  await transactionDone(objectTx)
  const hasMore = objects.length > limit
  const pageObjects = objects.slice(0, limit)
  const visibleIds = new Set(pageObjects.map((record) => record.id))

  const connections = new Map<string, CachedConnectionRecord>()
  if (visibleIds.size) {
    const connectionTx = db.transaction(MODEL_CACHE_STORES.connections, 'readonly')
    const byFrom = connectionTx.objectStore(MODEL_CACHE_STORES.connections).index('byFrom')
    await Promise.all([...visibleIds].map((fromId) => new Promise<void>((resolve, reject) => {
      const cursorRequest = byFrom.openCursor(IDBKeyRange.bound(
        [request.workspaceKey, meta.activeGeneration, fromId],
        [request.workspaceKey, meta.activeGeneration, fromId, []],
      ))
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB viewer connection cursor failed'))
      cursorRequest.onsuccess = () => {
        if (cancelled.has(request.id)) {
          connectionTx.abort()
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        const cursor = cursorRequest.result
        if (!cursor || connections.size > connectionLimit) { resolve(); return }
        rowsRead += 1
        const record = cursor.value as CachedConnectionRecord
        if (record.fromId !== record.toId && record.connection.kind !== 'lower' && visibleIds.has(record.toId)) {
          connections.set(record.id, record)
        }
        cursor.continue()
      }
    })))
    await transactionDone(connectionTx)
  }

  const ancestors: CachedModelEntityRecord[] = []
  let ancestorId = request.parentId ?? null
  for (let depth = 0; ancestorId && depth < 64; depth += 1) {
    const record = await readCachedEntity(db, request.workspaceKey, meta.activeGeneration, ancestorId)
    rowsRead += record ? 1 : 0
    if (!record) break
    ancestors.unshift(record)
    ancestorId = record.parentId ?? null
  }
  const connectionRows = [...connections.values()]
  const last = pageObjects.at(-1)
  return {
    result: {
      ancestors,
      objects: pageObjects,
      connections: connectionRows.slice(0, connectionLimit),
      nextCursor: hasMore && last ? encodeCursor({ normalizedName: last.normalizedName, id: last.id }) : null,
      totalObjects,
      connectionsTruncated: connectionRows.length > connectionLimit,
      generation: meta.activeGeneration,
      coverage: meta.coverage,
    },
    rowsRead,
  }
}

async function deleteEntities(request: Extract<ModelReadCacheRequest, { op: 'deleteEntities' }>): Promise<OperationResult<{ objectsDeleted: number; connectionsDeleted: number }>> {
  const db = await openModelReadCache()
  const tx = db.transaction([
    MODEL_CACHE_STORES.objects,
    MODEL_CACHE_STORES.connections,
    MODEL_CACHE_STORES.searchPostings,
    MODEL_CACHE_STORES.workspaceMeta,
  ], 'readwrite')
  const objectStore = tx.objectStore(MODEL_CACHE_STORES.objects)
  const connectionStore = tx.objectStore(MODEL_CACHE_STORES.connections)
  const postingStore = tx.objectStore(MODEL_CACHE_STORES.searchPostings)
  const postingByEntity = postingStore.index('byEntity')
  const metaStore = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const meta = (await requestResult(
    metaStore.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>
  )) ?? defaultMeta(request.workspaceKey)
  const generation = request.generation ?? meta.activeGeneration
  const objectIds = [...new Set(request.objectIds ?? [])]
  const connectionIds = [...new Set(request.connectionIds ?? [])]
  const [objects, postingKeys, connections] = await Promise.all([
    Promise.all(objectIds.map((id) => requestResult(
      objectStore.get([request.workspaceKey, generation, id]) as IDBRequest<CachedModelEntityRecord | undefined>
    ))),
    Promise.all(objectIds.map((id) => requestResult(postingByEntity.getAllKeys(IDBKeyRange.bound(
      [request.workspaceKey, generation, id],
      [request.workspaceKey, generation, id, []],
    ))))),
    Promise.all(connectionIds.map((id) => requestResult(
      connectionStore.get([request.workspaceKey, generation, id]) as IDBRequest<CachedConnectionRecord | undefined>
    ))),
  ])
  let objectBytes = 0
  let postingBytes = 0
  let connectionBytes = 0
  let objectsDeleted = 0
  let connectionsDeleted = 0
  objects.forEach((record, index) => {
    if (record) {
      objectStore.delete([request.workspaceKey, generation, record.id])
      objectBytes += record.accountedBytes
      objectsDeleted += 1
    }
    for (const key of postingKeys[index]) {
      postingStore.delete(key)
      postingBytes += estimateStructuredBytes(key)
    }
  })
  connections.forEach((record) => {
    if (!record) return
    connectionStore.delete([request.workspaceKey, generation, record.id])
    connectionBytes += record.accountedBytes
    connectionsDeleted += 1
  })
  const stats = statsFor(meta, generation)
  stats.objectCount = Math.max(0, stats.objectCount - objectsDeleted)
  stats.connectionCount = Math.max(0, stats.connectionCount - connectionsDeleted)
  addBytes(stats.accountedBytes, MODEL_CACHE_STORES.objects, -objectBytes)
  addBytes(stats.accountedBytes, MODEL_CACHE_STORES.searchPostings, -postingBytes)
  addBytes(stats.accountedBytes, MODEL_CACHE_STORES.connections, -connectionBytes)
  if (meta.activeGeneration === generation) {
    meta.objectCount = stats.objectCount
    meta.connectionCount = stats.connectionCount
    meta.accountedBytes = { ...stats.accountedBytes }
  }
  meta.lastAccessAt = Date.now()
  metaStore.put(meta)
  await transactionDone(tx)
  return {
    result: { objectsDeleted, connectionsDeleted },
    rowsRead: objects.length + connections.length + postingKeys.reduce((sum, keys) => sum + keys.length, 0),
  }
}

async function commitServerGeneration(request: Extract<ModelReadCacheRequest, { op: 'commitServerGeneration' }>): Promise<OperationResult<ModelCacheWorkspaceMeta>> {
  const db = await openModelReadCache()
  const tx = db.transaction([MODEL_CACHE_STORES.workspaceMeta, MODEL_CACHE_STORES.syncState], 'readwrite')
  const metaStore = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const meta = (await requestResult(
    metaStore.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>
  )) ?? defaultMeta(request.workspaceKey)
  meta.serverGeneration = Math.max(meta.serverGeneration, request.serverGeneration)
  meta.lastAccessAt = Date.now()
  metaStore.put(meta)
  const syncState: ModelCacheSyncState = {
    workspaceKey: request.workspaceKey,
    lastAppliedServerGeneration: meta.serverGeneration,
    updatedAt: Date.now(),
  }
  tx.objectStore(MODEL_CACHE_STORES.syncState).put(syncState)
  await transactionDone(tx)
  return { result: meta, rowsRead: 1 }
}

async function putDiagramRender(request: Extract<ModelReadCacheRequest, { op: 'putDiagramRender' }>): Promise<OperationResult<{ stored: true }>> {
  const db = await openModelReadCache()
  const tx = db.transaction([MODEL_CACHE_STORES.diagramRenders, MODEL_CACHE_STORES.workspaceMeta], 'readwrite')
  const renderStore = tx.objectStore(MODEL_CACHE_STORES.diagramRenders)
  const metaStore = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const record: CachedDiagramRenderRecord = {
    ...request.record,
    cachedAt: request.record.cachedAt || Date.now(),
    accountedBytes: request.record.accountedBytes || estimateStructuredBytes(request.record.payload),
  }
  const [old, storedMeta] = await Promise.all([
    requestResult(renderStore.get([record.workspaceKey, record.diagramId, record.generation]) as IDBRequest<CachedDiagramRenderRecord | undefined>),
    requestResult(metaStore.get(record.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>),
  ])
  renderStore.put(record)
  const meta = storedMeta ?? defaultMeta(record.workspaceKey)
  const stats = statsFor(meta, record.generation)
  addBytes(stats.accountedBytes, MODEL_CACHE_STORES.diagramRenders, record.accountedBytes - (old?.accountedBytes ?? 0))
  if (meta.activeGeneration === record.generation) meta.accountedBytes = { ...stats.accountedBytes }
  meta.lastAccessAt = Date.now()
  metaStore.put(meta)
  await transactionDone(tx)
  return { result: { stored: true }, rowsRead: old ? 1 : 0 }
}

async function getDiagramRender(request: Extract<ModelReadCacheRequest, { op: 'getDiagramRender' }>): Promise<OperationResult<CachedDiagramRenderRecord | null>> {
  const db = await openModelReadCache()
  const tx = db.transaction([MODEL_CACHE_STORES.diagramRenders, MODEL_CACHE_STORES.workspaceMeta], 'readwrite')
  const renderStore = tx.objectStore(MODEL_CACHE_STORES.diagramRenders)
  const metaStore = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const meta = (await requestResult(
    metaStore.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>
  )) ?? defaultMeta(request.workspaceKey)
  const generation = request.generation ?? meta.activeGeneration
  let record = await requestResult(
    renderStore.get([request.workspaceKey, request.diagramId, generation]) as IDBRequest<CachedDiagramRenderRecord | undefined>
  )
  let rowsRead = record ? 1 : 0
  if (!record && request.allowLatest) {
    record = await new Promise<CachedDiagramRenderRecord | undefined>((resolve, reject) => {
      const cursorRequest = renderStore.openCursor(
        IDBKeyRange.bound(
          [request.workspaceKey, request.diagramId],
          [request.workspaceKey, request.diagramId, []],
        ),
        'prev',
      )
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB render cursor failed'))
      cursorRequest.onsuccess = () => resolve(cursorRequest.result?.value as CachedDiagramRenderRecord | undefined)
    })
    if (record) rowsRead += 1
  }
  meta.lastAccessAt = Date.now()
  metaStore.put(meta)
  await transactionDone(tx)
  return { result: record ?? null, rowsRead }
}

async function readDiagramManifest(
  workspaceKey: string,
  generation: number,
  diagramId: string,
): Promise<CachedDiagramManifestRecord | null> {
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.diagramMembership, 'readonly')
  const record = await requestResult(
    tx.objectStore(MODEL_CACHE_STORES.diagramMembership).get([
      workspaceKey, generation, diagramId, '__manifest__',
    ]) as IDBRequest<CachedDiagramManifestRecord | undefined>,
  )
  await transactionDone(tx)
  return record ?? null
}

async function readCachedEntityRecords(
  workspaceKey: string,
  generation: number,
  ids: string[],
): Promise<Map<string, CachedModelEntityRecord>> {
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.objects, 'readonly')
  const store = tx.objectStore(MODEL_CACHE_STORES.objects)
  const rows = await Promise.all([...new Set(ids)].map((id) => requestResult(
    store.get([workspaceKey, generation, id]) as IDBRequest<CachedModelEntityRecord | undefined>,
  )))
  await transactionDone(tx)
  return new Map(rows.filter((row): row is CachedModelEntityRecord => Boolean(row)).map((row) => [row.id, row]))
}

async function readCachedConnectionRecords(
  workspaceKey: string,
  generation: number,
  ids: string[],
): Promise<Map<string, CachedConnectionRecord>> {
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.connections, 'readonly')
  const store = tx.objectStore(MODEL_CACHE_STORES.connections)
  const rows = await Promise.all([...new Set(ids)].map((id) => requestResult(
    store.get([workspaceKey, generation, id]) as IDBRequest<CachedConnectionRecord | undefined>,
  )))
  await transactionDone(tx)
  return new Map(rows.filter((row): row is CachedConnectionRecord => Boolean(row)).map((row) => [row.id, row]))
}

async function scanObjectHierarchy(
  workspaceKey: string,
  generation: number,
  requestId: number,
): Promise<{
  parentOf: Map<string, string | undefined>
  childrenByParent: Map<string, string[]>
  rowsRead: number
}> {
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.objects, 'readonly')
  const store = tx.objectStore(MODEL_CACHE_STORES.objects)
  const result = await new Promise<{
    parentOf: Map<string, string | undefined>
    childrenByParent: Map<string, string[]>
    rowsRead: number
  }>((resolve, reject) => {
    const parentOf = new Map<string, string | undefined>()
    const childrenByParent = new Map<string, string[]>()
    let rowsRead = 0
    const cursorRequest = store.openCursor(IDBKeyRange.bound(
      [workspaceKey, generation],
      [workspaceKey, generation, []],
    ))
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB object hierarchy scan failed'))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        resolve({ parentOf, childrenByParent, rowsRead })
        return
      }
      if (cancelled.has(requestId)) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const record = cursor.value as CachedModelEntityRecord
      rowsRead += 1
      if (record.kind === 'object') {
        const parentId = record.modelParentKey === ROOT_PARENT_KEY ? undefined : record.modelParentKey
        parentOf.set(record.id, parentId)
        if (parentId) {
          const children = childrenByParent.get(parentId) ?? []
          children.push(record.id)
          childrenByParent.set(parentId, children)
        }
      }
      cursor.continue()
    }
  })
  await transactionDone(tx)
  return result
}

async function readConnectionsFromSources(
  workspaceKey: string,
  generation: number,
  sourceIds: Set<string>,
  requestId: number,
): Promise<{ rows: CachedConnectionRecord[]; rowsRead: number }> {
  if (!sourceIds.size) return { rows: [], rowsRead: 0 }
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.connections, 'readonly')
  const store = tx.objectStore(MODEL_CACHE_STORES.connections)
  const byFrom = store.index('byFrom')

  // A normal diagram covers a small subtree: use indexed adjacency and avoid a
  // 300k-edge scan. For a very broad root diagram, one sequential scan is less
  // expensive than thousands of B-tree range requests and still stays in the
  // Worker, away from the UI thread.
  if (sourceIds.size <= 1_000) {
    const requests = [...sourceIds].map((sourceId) => requestResult(
      byFrom.getAll(IDBKeyRange.bound(
        [workspaceKey, generation, sourceId],
        [workspaceKey, generation, sourceId, []],
      )) as IDBRequest<CachedConnectionRecord[]>,
    ))
    const pages = await Promise.all(requests)
    await transactionDone(tx)
    const rows = pages.flat()
    return { rows, rowsRead: rows.length }
  }

  const result = await new Promise<{ rows: CachedConnectionRecord[]; rowsRead: number }>((resolve, reject) => {
    const rows: CachedConnectionRecord[] = []
    let rowsRead = 0
    const cursorRequest = store.openCursor(IDBKeyRange.bound(
      [workspaceKey, generation],
      [workspaceKey, generation, []],
    ))
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB connection scan failed'))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        resolve({ rows, rowsRead })
        return
      }
      if (cancelled.has(requestId)) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const record = cursor.value as CachedConnectionRecord
      rowsRead += 1
      if (sourceIds.has(record.fromId)) rows.push(record)
      cursor.continue()
    }
  })
  await transactionDone(tx)
  return result
}

/** Build a generation-bound render for a diagram that was never visited while
 * online. Only manifests are duplicated per diagram; normalized entities stay
 * single-copy. The hierarchy/edge work runs inside this data Worker and the
 * result is cached, so the main thread never materializes a 100k/300k graph. */
async function buildDiagramRender(
  request: Extract<ModelReadCacheRequest, { op: 'buildDiagramRender' }>,
): Promise<OperationResult<CachedDiagramRenderRecord | null>> {
  const meta = await getMeta(request.workspaceKey)
  if (meta.coverage !== 'full') return { result: null, rowsRead: 1 }
  const generation = meta.activeGeneration
  const manifest = await readDiagramManifest(request.workspaceKey, generation, request.diagramId)
  if (!manifest) return { result: null, rowsRead: 2 }

  const entityRecords = await readCachedEntityRecords(
    request.workspaceKey,
    generation,
    [...manifest.objectIds, ...manifest.groupIds],
  )
  const directConnectionRecords = await readCachedConnectionRecords(
    request.workspaceKey,
    generation,
    manifest.connectionIds,
  )
  const hierarchy = await scanObjectHierarchy(request.workspaceKey, generation, request.id)

  const visible = new Set(manifest.objectIds)
  const groupObjectIds = new Map<string, string[]>()
  const sourceIds = new Set<string>(manifest.objectIds)
  for (const groupId of manifest.groupIds) {
    const payload = entityRecords.get(groupId)?.payload as { objectIds?: unknown } | undefined
    const objectIds = Array.isArray(payload?.objectIds)
      ? payload.objectIds.filter((id): id is string => typeof id === 'string')
      : []
    groupObjectIds.set(groupId, objectIds)
    for (const objectId of objectIds) sourceIds.add(objectId)
  }

  // Descendants of visible objects can roll up to their nearest visible
  // ancestor. Traverse the in-memory id graph (not payloads) built above.
  const queue = [...visible]
  for (let index = 0; index < queue.length; index += 1) {
    const parentId = queue[index]
    for (const childId of hierarchy.childrenByParent.get(parentId) ?? []) {
      if (sourceIds.has(childId)) continue
      sourceIds.add(childId)
      queue.push(childId)
    }
  }

  const candidateConnections = await readConnectionsFromSources(
    request.workspaceKey,
    generation,
    sourceIds,
    request.id,
  )
  const lower = computeLowerConnections(
    manifest,
    hierarchy.parentOf,
    groupObjectIds,
    candidateConnections.rows
      .filter((row) => row.connection.kind !== 'lower')
      .map((row) => ({ id: row.id, fromId: row.fromId, toId: row.toId })),
  )
  const payload = {
    projectionGeneration: generation,
    objects: manifest.objectIds
      .map((id) => entityRecords.get(id))
      .filter((row): row is CachedModelEntityRecord => Boolean(row))
      .map((row) => row.payload),
    connections: [
      ...manifest.connectionIds
        .map((id) => directConnectionRecords.get(id))
        .filter((row): row is CachedConnectionRecord => Boolean(row))
        .map((row) => row.connection),
      ...lower,
    ],
    groups: manifest.groupIds
      .map((id) => entityRecords.get(id))
      .filter((row): row is CachedModelEntityRecord => Boolean(row))
      .map((row) => row.payload),
  }
  const record: CachedDiagramRenderRecord = {
    workspaceKey: request.workspaceKey,
    diagramId: request.diagramId,
    generation,
    payload,
    accountedBytes: estimateStructuredBytes(payload),
    cachedAt: Date.now(),
  }
  await putDiagramRender({ id: request.id, op: 'putDiagramRender', record })
  return {
    result: record,
    rowsRead: 2 + entityRecords.size + directConnectionRecords.size
      + hierarchy.rowsRead + candidateConnections.rowsRead,
  }
}

async function storageStatus(request: Extract<ModelReadCacheRequest, { op: 'storageStatus' }>): Promise<OperationResult<ModelCacheWorkspaceMeta[]>> {
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.workspaceMeta, 'readonly')
  const store = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const rows = request.workspaceKey
    ? [await requestResult(store.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>)].filter(
      (row): row is ModelCacheWorkspaceMeta => Boolean(row)
    )
    : await requestResult(store.getAll() as IDBRequest<ModelCacheWorkspaceMeta[]>)
  await transactionDone(tx)
  return { result: rows, rowsRead: rows.length }
}

async function setOfflineDownloadState(
  request: Extract<ModelReadCacheRequest, { op: 'setOfflineDownloadState' }>,
): Promise<OperationResult<ModelCacheWorkspaceMeta>> {
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.workspaceMeta, 'readwrite')
  const store = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const meta = (await requestResult(
    store.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>,
  )) ?? defaultMeta(request.workspaceKey)
  const job = meta.offlineDownload
  if (job) {
    if (job.ownerId !== request.ownerId) {
      throw new WorkerOperationError('offline_download_not_owner', 'Offline download ownership changed')
    }
    const updatedAt = Date.now()
    meta.offlineDownload = {
      ...job,
      status: request.status,
      leaseExpiresAt: 0,
      updatedAt,
      ...(request.errorCode ? { errorCode: request.errorCode } : { errorCode: undefined }),
      ...(request.errorMessage ? { errorMessage: request.errorMessage } : { errorMessage: undefined }),
    }
    meta.lastAccessAt = updatedAt
    store.put(meta)
  }
  await transactionDone(tx)
  return { result: meta, rowsRead: job ? 1 : 0 }
}

async function completeOfflineDownload(
  request: Extract<ModelReadCacheRequest, { op: 'completeOfflineDownload' }>,
): Promise<OperationResult<ModelCacheWorkspaceMeta>> {
  const db = await openModelReadCache()
  const tx = db.transaction([MODEL_CACHE_STORES.workspaceMeta, MODEL_CACHE_STORES.syncState], 'readwrite')
  const metaStore = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const meta = (await requestResult(
    metaStore.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>,
  )) ?? defaultMeta(request.workspaceKey)
  const job = meta.offlineDownload
  if (!job
    || job.ownerId !== request.ownerId
    || job.generation !== request.generation
    || job.status !== 'running'
    || job.phase !== 'verifying') {
    throw new WorkerOperationError(
      'offline_download_stale_checkpoint',
      'Offline download cannot promote an incomplete generation',
    )
  }
  if (meta.serverGeneration > job.serverGeneration) {
    throw new WorkerOperationError(
      'offline_download_generation_stale',
      'The active cache advanced while the offline generation was downloading',
    )
  }
  const stats = statsFor(meta, request.generation)
  const updatedAt = Date.now()
  meta.activeGeneration = request.generation
  meta.serverGeneration = Math.max(meta.serverGeneration, job.serverGeneration)
  meta.coverage = 'full'
  meta.pinned = job.pinned
  meta.objectCount = stats.objectCount
  meta.connectionCount = stats.connectionCount
  meta.accountedBytes = { ...stats.accountedBytes }
  meta.lastAccessAt = updatedAt
  delete meta.offlineDownload
  metaStore.put(meta)
  tx.objectStore(MODEL_CACHE_STORES.syncState).put({
    workspaceKey: request.workspaceKey,
    lastAppliedServerGeneration: meta.serverGeneration,
    updatedAt,
  } satisfies ModelCacheSyncState)
  await transactionDone(tx)
  return { result: meta, rowsRead: 1 }
}

async function discardOfflineDownload(
  request: Extract<ModelReadCacheRequest, { op: 'discardOfflineDownload' }>,
): Promise<OperationResult<{ discarded: boolean }>> {
  const db = await openModelReadCache()
  const derivedStores = [
    MODEL_CACHE_STORES.objects,
    MODEL_CACHE_STORES.connections,
    MODEL_CACHE_STORES.diagramMembership,
    MODEL_CACHE_STORES.diagramRenders,
    MODEL_CACHE_STORES.searchPostings,
  ]
  const tx = db.transaction([MODEL_CACHE_STORES.workspaceMeta, ...derivedStores], 'readwrite')
  const metaStore = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const meta = (await requestResult(
    metaStore.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>,
  )) ?? defaultMeta(request.workspaceKey)
  const job = meta.offlineDownload
  if (!job) {
    await transactionDone(tx)
    return { result: { discarded: false }, rowsRead: 0 }
  }
  if (meta.activeGeneration === job.generation && meta.coverage === 'full') {
    delete meta.offlineDownload
    meta.lastAccessAt = Date.now()
    metaStore.put(meta)
    await transactionDone(tx)
    return { result: { discarded: true }, rowsRead: 1 }
  }
  const range = IDBKeyRange.bound(
    [request.workspaceKey, job.generation],
    [request.workspaceKey, job.generation, []],
  )
  const deleted = await Promise.all([
    deleteRange(tx.objectStore(MODEL_CACHE_STORES.objects), range),
    deleteRange(tx.objectStore(MODEL_CACHE_STORES.connections), range),
    deleteRange(tx.objectStore(MODEL_CACHE_STORES.diagramMembership), range),
    deleteRenderGeneration(tx.objectStore(MODEL_CACHE_STORES.diagramRenders), request.workspaceKey, job.generation),
    deleteRange(tx.objectStore(MODEL_CACHE_STORES.searchPostings), range),
  ])
  delete meta.generationStats[String(job.generation)]
  if (meta.activeGeneration === job.generation) {
    meta.activeGeneration = 0
    meta.coverage = 'working-set'
    meta.objectCount = 0
    meta.connectionCount = 0
    meta.accountedBytes = {}
  }
  delete meta.offlineDownload
  meta.lastAccessAt = Date.now()
  metaStore.put(meta)
  await transactionDone(tx)
  return {
    result: { discarded: true },
    rowsRead: 1 + deleted.reduce((sum, count) => sum + count, 0),
  }
}

async function setWorkspacePolicy(request: Extract<ModelReadCacheRequest, { op: 'setWorkspacePolicy' }>): Promise<OperationResult<ModelCacheWorkspaceMeta>> {
  const db = await openModelReadCache()
  const tx = db.transaction(MODEL_CACHE_STORES.workspaceMeta, 'readwrite')
  const store = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const meta = (await requestResult(
    store.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>
  )) ?? defaultMeta(request.workspaceKey)
  meta.pinned = request.pinned
  meta.lastAccessAt = Date.now()
  store.put(meta)
  await transactionDone(tx)
  return { result: meta, rowsRead: 1 }
}

function accountedGenerationBytes(stats: ModelCacheGenerationStats | undefined): number {
  return Object.values(stats?.accountedBytes ?? {}).reduce((sum, value) => sum + Math.max(0, value), 0)
}

function deleteRange(store: IDBObjectStore, range: IDBKeyRange): Promise<number> {
  return new Promise((resolve, reject) => {
    let deleted = 0
    const cursorRequest = store.openCursor(range)
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB eviction cursor failed'))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        resolve(deleted)
        return
      }
      cursor.delete()
      deleted += 1
      cursor.continue()
    }
  })
}

function deleteRenderGeneration(store: IDBObjectStore, workspaceKey: string, generation: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let deleted = 0
    const cursorRequest = store.openCursor(IDBKeyRange.bound([workspaceKey], [workspaceKey, []]))
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB render eviction cursor failed'))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        resolve(deleted)
        return
      }
      const record = cursor.value as CachedDiagramRenderRecord
      if (record.generation === generation) {
        cursor.delete()
        deleted += 1
      }
      cursor.continue()
    }
  })
}

/** Evict only derived projection generations. Mutation outboxes, sync state and
 * Automerge's separate database are deliberately outside this transaction. */
async function evictDerived(request: Extract<ModelReadCacheRequest, { op: 'evictDerived' }>): Promise<OperationResult<ModelCacheEvictionResult>> {
  const bytesToFree = Math.max(0, Math.floor(request.bytesToFree))
  const maxGenerations = Math.min(100, Math.max(1, Math.floor(request.maxGenerations ?? 25)))
  const db = await openModelReadCache()
  const derivedStores = [
    MODEL_CACHE_STORES.objects,
    MODEL_CACHE_STORES.connections,
    MODEL_CACHE_STORES.diagramMembership,
    MODEL_CACHE_STORES.diagramRenders,
    MODEL_CACHE_STORES.searchPostings,
  ]
  const tx = db.transaction([MODEL_CACHE_STORES.workspaceMeta, ...derivedStores], 'readwrite')
  const metaStore = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const metas = await requestResult(metaStore.getAll() as IDBRequest<ModelCacheWorkspaceMeta[]>)
  const candidates = metas.flatMap((meta) => Object.keys(meta.generationStats).map((rawGeneration) => {
    const generation = Number(rawGeneration)
    const wasActive = generation === meta.activeGeneration
    return {
      meta,
      generation,
      wasActive,
      accountedBytes: accountedGenerationBytes(meta.generationStats[rawGeneration]),
      eligible: generation !== meta.offlineDownload?.generation
        && (!wasActive || (!meta.pinned && meta.workspaceKey !== request.protectWorkspaceKey)),
    }
  })).filter((candidate) => candidate.eligible && Number.isSafeInteger(candidate.generation))
    .sort((a, b) => Number(a.wasActive) - Number(b.wasActive)
      || a.meta.lastAccessAt - b.meta.lastAccessAt
      || a.generation - b.generation)

  const evictedGenerations: ModelCacheEvictionResult['evictedGenerations'] = []
  let evictedBytes = 0
  let rowsRead = metas.length
  for (const candidate of candidates) {
    if (evictedGenerations.length >= maxGenerations || (bytesToFree > 0 && evictedBytes >= bytesToFree)) break
    const range = IDBKeyRange.bound(
      [candidate.meta.workspaceKey, candidate.generation],
      [candidate.meta.workspaceKey, candidate.generation, []],
    )
    const deleted = await Promise.all([
      deleteRange(tx.objectStore(MODEL_CACHE_STORES.objects), range),
      deleteRange(tx.objectStore(MODEL_CACHE_STORES.connections), range),
      deleteRange(tx.objectStore(MODEL_CACHE_STORES.diagramMembership), range),
      deleteRange(tx.objectStore(MODEL_CACHE_STORES.searchPostings), range),
      deleteRenderGeneration(
        tx.objectStore(MODEL_CACHE_STORES.diagramRenders),
        candidate.meta.workspaceKey,
        candidate.generation,
      ),
    ])
    rowsRead += deleted.reduce((sum, count) => sum + count, 0)
    delete candidate.meta.generationStats[String(candidate.generation)]
    if (candidate.wasActive) {
      candidate.meta.coverage = 'working-set'
      candidate.meta.objectCount = 0
      candidate.meta.connectionCount = 0
      candidate.meta.accountedBytes = {}
    }
    candidate.meta.lastAccessAt = Date.now()
    metaStore.put(candidate.meta)
    evictedBytes += candidate.accountedBytes
    evictedGenerations.push({
      workspaceKey: candidate.meta.workspaceKey,
      generation: candidate.generation,
      wasActive: candidate.wasActive,
      accountedBytes: candidate.accountedBytes,
    })
  }

  const remainingAccountedBytes = metas.reduce((sum, meta) => sum + Object.values(meta.generationStats)
    .reduce((workspaceSum, stats) => workspaceSum + accountedGenerationBytes(stats), 0), 0)
  await transactionDone(tx)
  return {
    result: {
      evictedBytes,
      remainingAccountedBytes,
      evictedGenerations,
      targetSatisfied: evictedBytes >= bytesToFree,
    },
    rowsRead,
  }
}

function deleteWorkspaceRows(store: IDBObjectStore, workspaceKey: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let deleted = 0
    const cursorRequest = store.openCursor(IDBKeyRange.bound([workspaceKey], [workspaceKey, []]))
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB delete cursor failed'))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        resolve(deleted)
        return
      }
      cursor.delete()
      deleted += 1
      cursor.continue()
    }
  })
}

async function clearWorkspace(request: Extract<ModelReadCacheRequest, { op: 'clearWorkspace' }>): Promise<OperationResult<{ cleared: true }>> {
  const db = await openModelReadCache()
  // This command is used by snapshot rebuilds. It must never erase durable local
  // mutations or sync checkpoints; only server-reconstructable projection stores
  // are cleared. Preserve the pinned policy across the rebuild as well.
  const derivedStores = [
    MODEL_CACHE_STORES.objects,
    MODEL_CACHE_STORES.connections,
    MODEL_CACHE_STORES.diagramMembership,
    MODEL_CACHE_STORES.diagramRenders,
    MODEL_CACHE_STORES.searchPostings,
  ]
  const tx = db.transaction([MODEL_CACHE_STORES.workspaceMeta, ...derivedStores], 'readwrite')
  const metaStore = tx.objectStore(MODEL_CACHE_STORES.workspaceMeta)
  const previousMeta = await requestResult(
    metaStore.get(request.workspaceKey) as IDBRequest<ModelCacheWorkspaceMeta | undefined>
  )
  const deleted = await Promise.all(derivedStores.map((name) => deleteWorkspaceRows(tx.objectStore(name), request.workspaceKey)))
  const resetMeta = defaultMeta(request.workspaceKey)
  resetMeta.pinned = previousMeta?.pinned ?? false
  metaStore.put(resetMeta)
  await transactionDone(tx)
  return { result: { cleared: true }, rowsRead: deleted.reduce((sum, count) => sum + count, 0) }
}

async function execute(request: Exclude<ModelReadCacheRequest, { op: 'cancel' }>): Promise<OperationResult<unknown>> {
  switch (request.op) {
    case 'activateGeneration': return activateGeneration(request)
    case 'beginOfflineDownload': return beginOfflineDownload(request)
    case 'upsertObjects': return upsertObjects(request)
    case 'upsertConnections': return upsertConnections(request)
    case 'upsertDiagramManifests': return upsertDiagramManifests(request)
    case 'queryChildren': return queryChildren(request)
    case 'searchObjects': return searchObjects(request)
    case 'queryConnections': return queryConnections(request)
    case 'queryDependencyPeers': return queryDependencyPeers(request)
    case 'queryViewerLevel': return queryViewerLevel(request)
    case 'deleteEntities': return deleteEntities(request)
    case 'commitServerGeneration': return commitServerGeneration(request)
    case 'putDiagramRender': return putDiagramRender(request)
    case 'getDiagramRender': return getDiagramRender(request)
    case 'buildDiagramRender': return buildDiagramRender(request)
    case 'setOfflineDownloadState': return setOfflineDownloadState(request)
    case 'completeOfflineDownload': return completeOfflineDownload(request)
    case 'discardOfflineDownload': return discardOfflineDownload(request)
    case 'setWorkspacePolicy': return setWorkspacePolicy(request)
    case 'evictDerived': return evictDerived(request)
    case 'storageStatus': return storageStatus(request)
    case 'clearWorkspace': return clearWorkspace(request)
  }
}

scope.onmessage = (event) => {
  const request = event.data
  if (request.op === 'cancel') {
    cancelled.add(request.targetId)
    return
  }
  const started = now()
  void execute(request).then(
    ({ result, rowsRead = 0 }) => {
      if (!cancelled.delete(request.id)) {
        scope.postMessage({ id: request.id, ok: true, result, durationMs: now() - started, rowsRead })
      }
    },
    (error: unknown) => {
      if (!cancelled.delete(request.id)) {
        const errorCode = error instanceof WorkerOperationError
          ? error.code
          : error instanceof DOMException && error.name === 'QuotaExceededError'
            ? 'quota_exceeded'
            : error instanceof Error && error.name === 'QuotaExceededError'
              ? 'quota_exceeded'
              : undefined
        scope.postMessage({
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : 'Model cache operation failed',
          ...(errorCode ? { errorCode } : {}),
          durationMs: now() - started,
          rowsRead: 0,
        })
      }
    },
  )
}
