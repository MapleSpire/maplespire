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

import type { TagSnapshot } from '../../types'
import { registerTagCanonicalIds } from './canonicalIds'
import { accountDatabaseName } from '../auth/accountNamespace'

export type CatalogTagLifecycle = 'active' | 'archived' | 'merged'
export type CatalogTagGroupLifecycle = 'active' | 'archived'

export interface CatalogTagGroup {
  id: string
  orgId: string
  name: string
  description: string | null
  iconKey: string | null
  lifecycleStatus: CatalogTagGroupLifecycle
  version: number
  createdAt: string
  updatedAt: string
  /** Active values in this Group, computed server-side by the paged list API. */
  tagCount?: number
  /** Local optimistic entry waiting for the governed server mutation. */
  pendingSync?: boolean
}

export interface CatalogTag {
  id: string
  orgId: string
  groupId: string
  groupName: string
  value: string
  color: string
  lifecycleStatus: CatalogTagLifecycle
  canonicalTagId: string | null
  version: number
  createdAt: string
  updatedAt: string
  /** Local optimistic entry waiting for the governed server mutation. */
  pendingSync?: boolean
}

export interface TagSettings {
  allowMemberTagCreation: boolean
  allowEditorTagGroupCreation: boolean
  version: number
  updatedAt: string | null
  updatedBy: string | null
}

export interface TagWorkspaceContext {
  landscapeId: string
  versionId: string
}

export type TagCatalogOutboxState = 'pending' | 'attention'

export interface TagCatalogOutboxError {
  code: string
  message: string
  status: number | null
}

/**
 * A device-local governed creation waiting to reach the server. The outbox is
 * intentionally bounded to creation commands; catalog updates remain
 * server-authoritative optimistic-concurrency mutations.
 */
export interface TagCatalogOutboxItem {
  id: string
  orgId: string
  kind: 'tag' | 'group'
  clientId: string
  label: string
  groupId: string | null
  groupName: string | null
  color: string | null
  description: string | null
  iconKey: string | null
  state: TagCatalogOutboxState
  createdAt: number
  attemptCount: number
  lastAttemptAt: number | null
  lastError: TagCatalogOutboxError | null
}

export type TagOperationEventType =
  | 'queued'
  | 'replay_succeeded'
  | 'attention'
  | 'discarded'
  | 'reconciled'
export type TagOperationWindow = '24h' | '7d' | '30d'

export interface TagOperationSummary {
  window: TagOperationWindow
  from: string
  to: string
  counts: Record<TagOperationEventType, number>
  p50ResolutionMs: number | null
  p95ResolutionMs: number | null
  topAttentionReasons: Array<{ code: string; count: number }>
  lastEventAt: string | null
}

interface KeysetPage<T> {
  items: T[]
  nextCursor: string | null
}

export interface CatalogPage<T> extends KeysetPage<T> {
  source: 'network' | 'cache'
}

export interface TagListFilters {
  query?: string
  groupIds?: readonly string[]
  status?: CatalogTagLifecycle | 'all'
  after?: string | null
  limit?: number
}

export interface TagGroupListFilters {
  query?: string
  status?: CatalogTagGroupLifecycle | 'all'
  after?: string | null
  limit?: number
}

export interface ResolvedCatalogTag {
  requestedId: string
  canonicalTagId: string
  redirected: boolean
  tag: CatalogTag
}

export interface ResolveCatalogTagsResult {
  resolved: ResolvedCatalogTag[]
  unresolvedIds: string[]
  source: 'network' | 'cache'
}

export type CatalogTagBatchAction = 'recolor' | 'move' | 'archive' | 'restore'

export interface CatalogTagUsageCount {
  tagId: string
  objectAssignments: number
  groupAssignments: number
  totalAssignments: number
}

export interface CatalogTagAuditEntry {
  id: string
  at: string
  actorUserId: string
  actorEmail: string | null
  impersonatorUserId: string | null
  impersonatorEmail: string | null
  action: string
  targetKind: string
  targetId: string
  detail: unknown
}

export type CatalogTagAssignmentKind = 'object' | 'group'

export interface CatalogTagAssignment {
  kind: CatalogTagAssignmentKind
  landscapeId: string
  landscapeName: string
  versionId: string
  versionName: string
  entityId: string
  entityName: string
  entityType: string | null
}

export class TagCatalogApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message)
    this.name = 'TagCatalogApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export const TAG_SELECTOR_PAGE_SIZE = 50

import { API_BASE } from '../api/base'
const DB_NAME = 'maplespire-tag-catalog-v1'
const STORE_NAME = 'catalogs'
const OUTBOX_STORE_NAME = 'outbox'
const OPERATION_STORE_NAME = 'operations'
const DB_VERSION = 3
const MAX_TAG_CACHE_ENTRIES = 1_000
const MAX_GROUP_CACHE_ENTRIES = 500

interface CatalogCache {
  orgId: string
  tags: CatalogTag[]
  groups: CatalogTagGroup[]
  updatedAt: number
}

const memoryCache = new Map<string, CatalogCache>()
type OutboxEntry = {
  id: string
  orgId: string
  kind: 'tag' | 'group'
  clientId: string
  input: Record<string, unknown>
  optimistic: CatalogTag | CatalogTagGroup
  createdAt: number
  state?: TagCatalogOutboxState
  attemptCount?: number
  lastAttemptAt?: number | null
  lastError?: TagCatalogOutboxError | null
}
const memoryOutbox = new Map<string, OutboxEntry>()
type OperationEvent = {
  id: string
  orgId: string
  eventType: TagOperationEventType
  itemKind: 'tag' | 'group'
  reasonCode: string | null
  ageMs: number
  attemptCount: number
  occurredAt: string
}
const memoryOperationEvents = new Map<string, OperationEvent>()
const outboxListeners = new Set<(orgId: string) => void>()
const outboxFlushes = new Map<string, Promise<{ flushed: number; pending: number }>>()
const operationFlushes = new Map<string, Promise<{ flushed: number; pending: number }>>()
let onlineListenerInstalled = false

function notifyOutboxChanged(orgId: string): void {
  for (const listener of outboxListeners) listener(orgId)
}

function publicOutboxItem(entry: OutboxEntry): TagCatalogOutboxItem {
  const optimistic = entry.optimistic
  const tag = entry.kind === 'tag' ? optimistic as CatalogTag : null
  const group = entry.kind === 'group' ? optimistic as CatalogTagGroup : null
  return {
    id: entry.id,
    orgId: entry.orgId,
    kind: entry.kind,
    clientId: entry.clientId,
    label: tag?.value ?? group?.name ?? entry.clientId,
    groupId: tag?.groupId ?? null,
    groupName: tag?.groupName ?? null,
    color: tag?.color ?? null,
    description: group?.description ?? null,
    iconKey: group?.iconKey ?? null,
    state: entry.state ?? 'pending',
    createdAt: entry.createdAt,
    attemptCount: entry.attemptCount ?? 0,
    lastAttemptAt: entry.lastAttemptAt ?? null,
    lastError: entry.lastError ?? null,
  }
}

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(accountDatabaseName(DB_NAME), DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'orgId' })
      }
      if (!request.result.objectStoreNames.contains(OUTBOX_STORE_NAME)) {
        const store = request.result.createObjectStore(OUTBOX_STORE_NAME, { keyPath: 'id' })
        store.createIndex('orgId', 'orgId', { unique: false })
      }
      if (!request.result.objectStoreNames.contains(OPERATION_STORE_NAME)) {
        const store = request.result.createObjectStore(OPERATION_STORE_NAME, { keyPath: 'id' })
        store.createIndex('orgId', 'orgId', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readOutbox(orgId?: string): Promise<OutboxEntry[]> {
  if (typeof indexedDB === 'undefined') {
    return [...memoryOutbox.values()].filter((entry) => !orgId || entry.orgId === orgId)
  }
  try {
    const db = await openCache()
    const entries = await new Promise<OutboxEntry[]>((resolve, reject) => {
      const transaction = db.transaction(OUTBOX_STORE_NAME, 'readonly')
      const store = transaction.objectStore(OUTBOX_STORE_NAME)
      const request = orgId ? store.index('orgId').getAll(orgId) : store.getAll()
      request.onsuccess = () => resolve(request.result as OutboxEntry[])
      request.onerror = () => reject(request.error)
    })
    db.close()
    for (const entry of entries) memoryOutbox.set(entry.id, entry)
    return entries
  } catch {
    return [...memoryOutbox.values()].filter((entry) => !orgId || entry.orgId === orgId)
  }
}

async function putOutbox(entry: OutboxEntry): Promise<void> {
  memoryOutbox.set(entry.id, entry)
  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openCache()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(OUTBOX_STORE_NAME, 'readwrite')
        transaction.objectStore(OUTBOX_STORE_NAME).put(entry)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
      db.close()
    } catch {
      // Memory fallback keeps creation usable in private/restricted browsers.
    }
  }
  notifyOutboxChanged(entry.orgId)
}

async function deleteOutbox(id: string, orgId: string): Promise<void> {
  memoryOutbox.delete(id)
  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openCache()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(OUTBOX_STORE_NAME, 'readwrite')
        transaction.objectStore(OUTBOX_STORE_NAME).delete(id)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
      db.close()
    } catch {
      // Memory state still prevents a second replay in this session.
    }
  }
  notifyOutboxChanged(orgId)
}

async function readOperationEvents(orgId?: string): Promise<OperationEvent[]> {
  if (typeof indexedDB === 'undefined') {
    return [...memoryOperationEvents.values()].filter((event) => !orgId || event.orgId === orgId)
  }
  try {
    const db = await openCache()
    const events = await new Promise<OperationEvent[]>((resolve, reject) => {
      const transaction = db.transaction(OPERATION_STORE_NAME, 'readonly')
      const store = transaction.objectStore(OPERATION_STORE_NAME)
      const request = orgId ? store.index('orgId').getAll(orgId) : store.getAll()
      request.onsuccess = () => resolve(request.result as OperationEvent[])
      request.onerror = () => reject(request.error)
    })
    db.close()
    for (const event of events) memoryOperationEvents.set(event.id, event)
    return events
  } catch {
    return [...memoryOperationEvents.values()].filter((event) => !orgId || event.orgId === orgId)
  }
}

async function putOperationEvent(event: OperationEvent): Promise<void> {
  memoryOperationEvents.set(event.id, event)
  if (typeof indexedDB === 'undefined') return
  try {
    const db = await openCache()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(OPERATION_STORE_NAME, 'readwrite')
      transaction.objectStore(OPERATION_STORE_NAME).put(event)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // Telemetry is best-effort and must never block governed catalog work.
  }
}

async function deleteOperationEvents(ids: readonly string[]): Promise<void> {
  for (const id of ids) memoryOperationEvents.delete(id)
  if (typeof indexedDB === 'undefined' || ids.length === 0) return
  try {
    const db = await openCache()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(OPERATION_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(OPERATION_STORE_NAME)
      for (const id of ids) store.delete(id)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // A duplicate resend is safe because the server event ID is idempotent.
  }
}

async function readCache(orgId: string): Promise<CatalogCache | null> {
  const resident = memoryCache.get(orgId)
  if (resident) return resident
  if (typeof indexedDB === 'undefined') return null
  try {
    const db = await openCache()
    const cached = await new Promise<CatalogCache | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(orgId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    if (!cached) return null
    const bounded = {
      ...cached,
      tags: cached.tags.slice(-MAX_TAG_CACHE_ENTRIES),
      groups: cached.groups.slice(-MAX_GROUP_CACHE_ENTRIES),
    }
    registerTagCanonicalIds(bounded.tags)
    memoryCache.set(orgId, bounded)
    return bounded
  } catch {
    return null
  }
}

async function mergeCache(
  orgId: string,
  update: { tags?: readonly CatalogTag[]; groups?: readonly CatalogTagGroup[] },
): Promise<void> {
  const current = await readCache(orgId) ?? { orgId, tags: [], groups: [], updatedAt: 0 }
  const tags = new Map(current.tags.map((tag) => [tag.id, tag]))
  const groups = new Map(current.groups.map((group) => [group.id, group]))
  for (const tag of update.tags ?? []) {
    tags.delete(tag.id)
    tags.set(tag.id, tag)
  }
  for (const group of update.groups ?? []) {
    groups.delete(group.id)
    groups.set(group.id, group)
  }
  const next: CatalogCache = {
    orgId,
    tags: [...tags.values()].slice(-MAX_TAG_CACHE_ENTRIES),
    groups: [...groups.values()].slice(-MAX_GROUP_CACHE_ENTRIES),
    updatedAt: Date.now(),
  }
  registerTagCanonicalIds(next.tags)
  memoryCache.set(orgId, next)
  if (typeof indexedDB === 'undefined') return
  try {
    const db = await openCache()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(next)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // A best-effort offline cache never turns a successful request into a failure.
  }
}

async function removeOptimisticCacheEntry(entry: OutboxEntry): Promise<void> {
  const current = await readCache(entry.orgId)
  if (!current) return
  const next: CatalogCache = {
    ...current,
    tags: entry.kind === 'tag' ? current.tags.filter((tag) => tag.id !== entry.clientId) : current.tags,
    groups: entry.kind === 'group' ? current.groups.filter((group) => group.id !== entry.clientId) : current.groups,
    updatedAt: Date.now(),
  }
  memoryCache.set(entry.orgId, next)
  if (typeof indexedDB === 'undefined') return
  try {
    const db = await openCache()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(next)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // Removing a local optimistic row remains effective for this session.
  }
}

async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new TagCatalogApiError(
      response.status,
      typeof body.error === 'string' ? body.error : 'tag_catalog_request_failed',
      typeof body.message === 'string' ? body.message : `Tag catalog request failed (${response.status})`,
      body.details,
    )
  }
  return body as T
}

function cachedTags(cache: CatalogCache, filters: TagListFilters): CatalogTag[] {
  const needle = (filters.query ?? '').trim().toLocaleLowerCase()
  const groupIds = new Set(filters.groupIds ?? [])
  return cache.tags
    .filter((tag) => !filters.status || filters.status === 'all' || tag.lifecycleStatus === filters.status)
    .filter((tag) => groupIds.size === 0 || groupIds.has(tag.groupId))
    .filter((tag) => !needle || `${tag.groupName} ${tag.value}`.toLocaleLowerCase().includes(needle))
    .slice(0, filters.limit ?? TAG_SELECTOR_PAGE_SIZE)
}

export async function listTagPage(
  orgId: string,
  filters: TagListFilters = {},
  signal?: AbortSignal,
): Promise<CatalogPage<CatalogTag>> {
  if (typeof navigator === 'undefined' || navigator.onLine) {
    await flushTagCatalogOutbox(orgId)
    await flushTagOperationEvents(orgId).catch(() => undefined)
  }
  const params = new URLSearchParams({
    q: filters.query ?? '',
    limit: String(filters.limit ?? TAG_SELECTOR_PAGE_SIZE),
  })
  if (filters.status && filters.status !== 'all') params.set('status', filters.status)
  if (filters.after) params.set('after', filters.after)
  if (filters.groupIds?.length) params.set('groupIds', [...new Set(filters.groupIds)].join(','))
  try {
    const page = await json<KeysetPage<CatalogTag>>(
      `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tags?${params}`,
      { signal },
    )
    await mergeCache(orgId, { tags: page.items })
    return { ...page, source: 'network' }
  } catch (error) {
    if (signal?.aborted) throw error
    const cache = await readCache(orgId)
    if (!cache) throw error
    return { items: cachedTags(cache, filters), nextCursor: null, source: 'cache' }
  }
}

export async function listTagGroupPage(
  orgId: string,
  filters: TagGroupListFilters = {},
  signal?: AbortSignal,
): Promise<CatalogPage<CatalogTagGroup>> {
  if (typeof navigator === 'undefined' || navigator.onLine) {
    await flushTagCatalogOutbox(orgId)
    await flushTagOperationEvents(orgId).catch(() => undefined)
  }
  const params = new URLSearchParams({
    q: filters.query ?? '',
    limit: String(filters.limit ?? TAG_SELECTOR_PAGE_SIZE),
  })
  if (filters.status && filters.status !== 'all') params.set('status', filters.status)
  if (filters.after) params.set('after', filters.after)
  try {
    const page = await json<KeysetPage<CatalogTagGroup>>(
      `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tag-groups?${params}`,
      { signal },
    )
    await mergeCache(orgId, { groups: page.items })
    return { ...page, source: 'network' }
  } catch (error) {
    if (signal?.aborted) throw error
    const cache = await readCache(orgId)
    if (!cache) throw error
    const needle = (filters.query ?? '').trim().toLocaleLowerCase()
    const items = cache.groups
      .filter((group) => !filters.status || filters.status === 'all' || group.lifecycleStatus === filters.status)
      .filter((group) => !needle || group.name.toLocaleLowerCase().includes(needle))
      .slice(0, filters.limit ?? TAG_SELECTOR_PAGE_SIZE)
    return { items, nextCursor: null, source: 'cache' }
  }
}

export async function resolveCatalogTags(
  orgId: string,
  tagIds: readonly string[],
  signal?: AbortSignal,
): Promise<ResolveCatalogTagsResult> {
  const ids = [...new Set(tagIds.filter(Boolean))].slice(0, 100)
  if (ids.length === 0) return { resolved: [], unresolvedIds: [], source: 'network' }
  try {
    const result = await json<Omit<ResolveCatalogTagsResult, 'source'>>(
      `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tags/resolve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tagIds: ids }),
        signal,
      },
    )
    await mergeCache(orgId, { tags: result.resolved.map((entry) => entry.tag) })
    registerTagCanonicalIds(result.resolved.map((entry) => ({
      id: entry.tag.id,
      canonicalTagId: entry.canonicalTagId,
      redirectedFromIds: entry.redirected ? [entry.requestedId] : [],
    })))
    return { ...result, source: 'network' }
  } catch (error) {
    if (signal?.aborted) throw error
    const cache = await readCache(orgId)
    if (!cache) throw error
    const byId = new Map(cache.tags.map((tag) => [tag.id, tag]))
    const resolved = ids.flatMap((id): ResolvedCatalogTag[] => {
      const tag = byId.get(id)
      return tag ? [{ requestedId: id, canonicalTagId: tag.canonicalTagId || tag.id, redirected: false, tag }] : []
    })
    const found = new Set(resolved.map((entry) => entry.requestedId))
    return { resolved, unresolvedIds: ids.filter((id) => !found.has(id)), source: 'cache' }
  }
}

export function tagSnapshotFromCatalog(tag: CatalogTag): TagSnapshot {
  return {
    tagId: tag.canonicalTagId || tag.id,
    value: tag.value,
    color: tag.color,
    groupId: tag.groupId,
    groupName: tag.groupName,
    catalogRevision: tag.version,
  }
}

export async function getTagSettings(orgId: string, signal?: AbortSignal): Promise<TagSettings> {
  const result = await json<{ settings: TagSettings }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tag-settings`,
    { signal },
  )
  return result.settings
}

export async function updateTagSettings(
  orgId: string,
  settings: Pick<TagSettings, 'allowMemberTagCreation' | 'allowEditorTagGroupCreation'>,
  expectedVersion: number,
): Promise<TagSettings> {
  const result = await json<{ settings: TagSettings }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tag-settings`,
    {
      method: 'PATCH',
      headers: mutationHeaders(),
      body: JSON.stringify({ ...settings, expectedVersion }),
    },
  )
  return result.settings
}

function randomToken(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, '0').slice(0, 32)
}

function mutationHeaders(idempotencyKey = `tag-${randomToken()}`): HeadersInit {
  return {
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
  }
}

function operationReasonCode(raw: string | null | undefined): string | null {
  if (!raw) return null
  const normalized = raw.trim().toLocaleLowerCase().replace(/[^a-z0-9_:-]+/g, '_').slice(0, 80)
  return /^[a-z0-9_:-]{1,80}$/.test(normalized) ? normalized : 'other'
}

function operationAgeMs(createdAt: number): number {
  return Math.min(Math.max(Date.now() - createdAt, 0), 3_024_000_000)
}

async function recordOutboxOperation(
  entry: Pick<OutboxEntry, 'orgId' | 'kind' | 'createdAt' | 'attemptCount'>,
  eventType: TagOperationEventType,
  reasonCode?: string | null,
): Promise<void> {
  await putOperationEvent({
    id: `tagop_client_${randomToken()}`,
    orgId: entry.orgId,
    eventType,
    itemKind: entry.kind,
    reasonCode: operationReasonCode(reasonCode),
    ageMs: eventType === 'queued' ? 0 : operationAgeMs(entry.createdAt),
    attemptCount: Math.min(Math.max(entry.attemptCount ?? 0, 0), 1_000),
    occurredAt: new Date().toISOString(),
  })
}

export function flushTagOperationEvents(orgId?: string): Promise<{ flushed: number; pending: number }> {
  const key = orgId ?? '*'
  const inFlight = operationFlushes.get(key) ?? (orgId ? operationFlushes.get('*') : undefined)
  if (inFlight) {
    return inFlight.then(async (result) => ({
      flushed: result.flushed,
      pending: orgId ? (await readOperationEvents(orgId)).length : result.pending,
    }))
  }
  const task = (async () => {
    const events = (await readOperationEvents(orgId)).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    let flushed = 0
    const byOrg = new Map<string, OperationEvent[]>()
    for (const event of events) byOrg.set(event.orgId, [...(byOrg.get(event.orgId) ?? []), event])
    for (const [batchOrgId, orgEvents] of byOrg) {
      for (let offset = 0; offset < orgEvents.length; offset += 100) {
        const batch = orgEvents.slice(offset, offset + 100)
        await json<{ received: number; inserted: number }>(
          `${API_BASE}/api/orgs/${encodeURIComponent(batchOrgId)}/tag-operations/events`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              events: batch.map(({ orgId: _orgId, ...event }) => event),
            }),
          },
        )
        await deleteOperationEvents(batch.map((event) => event.id))
        flushed += batch.length
      }
    }
    return { flushed, pending: (await readOperationEvents(orgId)).length }
  })()
  operationFlushes.set(key, task)
  const release = () => {
    if (operationFlushes.get(key) === task) operationFlushes.delete(key)
  }
  void task.then(release, release)
  return task
}

export async function getTagOperationSummary(
  orgId: string,
  window: TagOperationWindow = '7d',
  signal?: AbortSignal,
): Promise<TagOperationSummary> {
  if (typeof navigator === 'undefined' || navigator.onLine) {
    await flushTagOperationEvents(orgId).catch(() => undefined)
  }
  const result = await json<{ summary: TagOperationSummary }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tag-operations/summary?window=${window}`,
    { signal },
  )
  return result.summary
}

function installOnlineOutboxFlush(): void {
  if (onlineListenerInstalled || typeof window === 'undefined') return
  onlineListenerInstalled = true
  window.addEventListener('online', () => {
    void flushTagCatalogOutbox().then(() => flushTagOperationEvents()).catch(() => undefined)
  })
}

function outboxFailure(error: unknown): {
  state: TagCatalogOutboxState
  error: TagCatalogOutboxError
} {
  if (error instanceof TagCatalogApiError) {
    const retryable = error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
    return {
      state: retryable ? 'pending' : 'attention',
      error: { code: error.code, message: error.message, status: error.status },
    }
  }
  return {
    state: 'pending',
    error: {
      code: 'network_unavailable',
      message: error instanceof Error ? error.message : 'The Tag catalog server is unavailable.',
      status: null,
    },
  }
}

async function replayOutboxEntry(entry: OutboxEntry): Promise<boolean> {
  try {
    if (entry.kind === 'group') {
      const result = await json<{ group: CatalogTagGroup }>(
        `${API_BASE}/api/orgs/${encodeURIComponent(entry.orgId)}/tag-groups`,
        { method: 'POST', headers: mutationHeaders(entry.id), body: JSON.stringify(entry.input) },
      )
      await mergeCache(entry.orgId, { groups: [{ ...result.group, pendingSync: false }] })
    } else {
      const result = await json<{ tag: CatalogTag }>(
        `${API_BASE}/api/orgs/${encodeURIComponent(entry.orgId)}/tags`,
        { method: 'POST', headers: mutationHeaders(entry.id), body: JSON.stringify(entry.input) },
      )
      await mergeCache(entry.orgId, { tags: [{ ...result.tag, pendingSync: false }] })
    }
    await deleteOutbox(entry.id, entry.orgId)
    await recordOutboxOperation(
      { ...entry, attemptCount: (entry.attemptCount ?? 0) + 1 },
      'replay_succeeded',
    )
    return true
  } catch (error) {
    const failure = outboxFailure(error)
    const failedEntry: OutboxEntry = {
      ...entry,
      state: failure.state,
      attemptCount: (entry.attemptCount ?? 0) + 1,
      lastAttemptAt: Date.now(),
      lastError: failure.error,
    }
    await putOutbox(failedEntry)
    if (failure.state === 'attention' && (
      (entry.state ?? 'pending') !== 'attention' || entry.lastError?.code !== failure.error.code
    )) {
      await recordOutboxOperation(failedEntry, 'attention', failure.error.code)
    }
    return false
  }
}

export async function listTagCatalogOutbox(orgId: string): Promise<TagCatalogOutboxItem[]> {
  return (await readOutbox(orgId))
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(publicOutboxItem)
}

export function subscribeTagCatalogOutbox(listener: (orgId: string) => void): () => void {
  outboxListeners.add(listener)
  return () => outboxListeners.delete(listener)
}

export async function retryTagCatalogOutboxEntry(orgId: string, entryId: string): Promise<boolean> {
  const entry = (await readOutbox(orgId)).find((candidate) => candidate.id === entryId)
  if (!entry) return true
  return replayOutboxEntry(entry)
}

export async function discardTagCatalogOutboxEntry(orgId: string, entryId: string): Promise<boolean> {
  const entry = (await readOutbox(orgId)).find((candidate) => candidate.id === entryId)
  if (!entry) return false
  await removeOptimisticCacheEntry(entry)
  await deleteOutbox(entry.id, entry.orgId)
  await recordOutboxOperation(entry, 'discarded', entry.lastError?.code ?? 'user_discarded')
  return true
}

export async function reconcileTagCatalogOutboxEntry(
  orgId: string,
  entryId: string,
  target: CatalogTag,
): Promise<{ source: CatalogTag; canonical: CatalogTag }> {
  const entry = (await readOutbox(orgId)).find((candidate) => candidate.id === entryId)
  if (!entry || entry.kind !== 'tag') {
    throw new TagCatalogApiError(404, 'outbox_entry_not_found', 'The offline Tag draft is no longer available.')
  }
  const result = await json<{ source: CatalogTag; canonical: CatalogTag }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tags/reconcile-local`,
    {
      method: 'POST',
      headers: mutationHeaders(`tag-reconcile-${entry.clientId}`),
      body: JSON.stringify({ ...entry.input, targetTagId: target.id }),
    },
  )
  registerTagCanonicalIds([{
    id: result.source.id,
    canonicalTagId: result.canonical.id,
    redirectedFromIds: [result.source.id],
  }])
  await removeOptimisticCacheEntry(entry)
  await mergeCache(orgId, { tags: [result.source, result.canonical] })
  await deleteOutbox(entry.id, entry.orgId)
  await recordOutboxOperation(entry, 'reconciled', entry.lastError?.code ?? 'manual_mapping')
  return result
}

export async function reconcileTagGroupOutboxEntry(
  orgId: string,
  entryId: string,
  target: CatalogTagGroup,
): Promise<{ group: CatalogTagGroup; updatedDependentTags: number }> {
  const entries = await readOutbox(orgId)
  const entry = entries.find((candidate) => candidate.id === entryId)
  if (!entry || entry.kind !== 'group') {
    throw new TagCatalogApiError(404, 'outbox_entry_not_found', 'The offline Tag Group draft is no longer available.')
  }
  const result = await json<{ group: CatalogTagGroup }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tag-groups/reconcile-local`,
    {
      method: 'POST',
      headers: mutationHeaders(`tag-group-reconcile-${entry.clientId}`),
      body: JSON.stringify({ ...entry.input, targetGroupId: target.id }),
    },
  )
  const dependents = entries.filter((candidate) => candidate.kind === 'tag' && candidate.input.groupId === entry.clientId)
  const rewritten = dependents.map((candidate): OutboxEntry => ({
    ...candidate,
    input: { ...candidate.input, groupId: result.group.id },
    optimistic: {
      ...candidate.optimistic as CatalogTag,
      groupId: result.group.id,
      groupName: result.group.name,
    },
    state: 'pending',
    lastError: null,
  }))

  // Repoint dependent Tag commands and remove the local Group command in one
  // IndexedDB transaction so a browser restart cannot expose half a mapping.
  for (const candidate of rewritten) memoryOutbox.set(candidate.id, candidate)
  memoryOutbox.delete(entry.id)
  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openCache()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(OUTBOX_STORE_NAME, 'readwrite')
        const store = transaction.objectStore(OUTBOX_STORE_NAME)
        for (const candidate of rewritten) store.put(candidate)
        store.delete(entry.id)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
      db.close()
    } catch {
      // The server-side audit is durable; memory state keeps this session safe.
    }
  }
  await removeOptimisticCacheEntry(entry)
  if (rewritten.length > 0) {
    await mergeCache(orgId, { tags: rewritten.map((candidate) => candidate.optimistic as CatalogTag) })
  }
  await mergeCache(orgId, { groups: [result.group] })
  notifyOutboxChanged(orgId)
  await recordOutboxOperation(entry, 'reconciled', entry.lastError?.code ?? 'manual_mapping')
  return { group: result.group, updatedDependentTags: rewritten.length }
}

export function flushTagCatalogOutbox(orgId?: string): Promise<{
  flushed: number
  pending: number
}> {
  const key = orgId ?? '*'
  const inFlight = outboxFlushes.get(key) ?? (orgId ? outboxFlushes.get('*') : undefined)
  if (inFlight) {
    return inFlight.then(async (result) => ({
      flushed: result.flushed,
      pending: orgId ? (await readOutbox(orgId)).length : result.pending,
    }))
  }
  const task = (async () => {
    const entries = (await readOutbox(orgId))
      .filter((entry) => (entry.state ?? 'pending') !== 'attention')
      .sort((left, right) => left.createdAt - right.createdAt)
    let flushed = 0
    for (const entry of entries) {
      if (await replayOutboxEntry(entry)) flushed += 1
    }
    return { flushed, pending: (await readOutbox(orgId)).length }
  })()
  outboxFlushes.set(key, task)
  const release = () => {
    if (outboxFlushes.get(key) === task) outboxFlushes.delete(key)
  }
  void task.then(release, release)
  return task
}

export async function createCatalogTagGroup(
  orgId: string,
  input: {
    name: string
    description?: string | null
    iconKey?: string | null
    workspace?: TagWorkspaceContext
  },
): Promise<CatalogTagGroup> {
  const clientId = `taggrp_client_${randomToken()}`
  const idempotencyKey = `tag-outbox-${clientId}`
  const body = { ...input, clientId }
  try {
    const result = await json<{ group: CatalogTagGroup }>(
      `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tag-groups`,
      { method: 'POST', headers: mutationHeaders(idempotencyKey), body: JSON.stringify(body) },
    )
    await mergeCache(orgId, { groups: [result.group] })
    return result.group
  } catch (error) {
    if (error instanceof TagCatalogApiError) throw error
    const now = new Date().toISOString()
    const optimistic: CatalogTagGroup = {
      id: clientId,
      orgId,
      name: input.name.trim(),
      description: input.description ?? null,
      iconKey: input.iconKey ?? null,
      lifecycleStatus: 'active',
      version: 1,
      createdAt: now,
      updatedAt: now,
      tagCount: 0,
      pendingSync: true,
    }
    const outboxEntry: OutboxEntry = {
      id: idempotencyKey, orgId, kind: 'group', clientId, input: body, optimistic, createdAt: Date.now(),
    }
    await putOutbox(outboxEntry)
    await recordOutboxOperation(outboxEntry, 'queued')
    await mergeCache(orgId, { groups: [optimistic] })
    installOnlineOutboxFlush()
    return optimistic
  }
}

export async function updateCatalogTagGroup(
  orgId: string,
  groupId: string,
  patch: { name?: string; description?: string | null; iconKey?: string | null },
  expectedVersion: number,
): Promise<CatalogTagGroup> {
  const result = await json<{ group: CatalogTagGroup }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tag-groups/${encodeURIComponent(groupId)}`,
    { method: 'PATCH', headers: mutationHeaders(), body: JSON.stringify({ ...patch, expectedVersion }) },
  )
  await mergeCache(orgId, { groups: [result.group] })
  return result.group
}

export async function reorderCatalogTagGroup(
  orgId: string,
  group: Pick<CatalogTagGroup, 'id' | 'version'>,
  move: { beforeId: string; afterId?: never } | { beforeId?: never; afterId: string },
): Promise<CatalogTagGroup> {
  const result = await json<{ group: CatalogTagGroup }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tag-groups/reorder`,
    {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({
        groupId: group.id,
        expectedVersion: group.version,
        beforeId: move.beforeId ?? null,
        afterId: move.afterId ?? null,
      }),
    },
  )
  await mergeCache(orgId, { groups: [result.group] })
  return result.group
}

export async function setCatalogTagGroupLifecycle(
  orgId: string,
  group: Pick<CatalogTagGroup, 'id' | 'version' | 'lifecycleStatus'>,
  lifecycle: CatalogTagGroupLifecycle,
): Promise<CatalogTagGroup> {
  const action = lifecycle === 'active' ? 'restore' : 'archive'
  const result = await json<{ group: CatalogTagGroup }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tag-groups/${encodeURIComponent(group.id)}/${action}`,
    { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ expectedVersion: group.version }) },
  )
  await mergeCache(orgId, { groups: [result.group] })
  return result.group
}

export async function createCatalogTag(
  orgId: string,
  input: { groupId: string; value: string; color: string; workspace?: TagWorkspaceContext },
): Promise<CatalogTag> {
  const clientId = `tag_client_${randomToken()}`
  const idempotencyKey = `tag-outbox-${clientId}`
  const body = { ...input, clientId }
  try {
    const result = await json<{ tag: CatalogTag }>(
      `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tags`,
      { method: 'POST', headers: mutationHeaders(idempotencyKey), body: JSON.stringify(body) },
    )
    await mergeCache(orgId, { tags: [result.tag] })
    return result.tag
  } catch (error) {
    if (error instanceof TagCatalogApiError) throw error
    const cache = await readCache(orgId)
    const groupName = cache?.groups.find((group) => group.id === input.groupId)?.name ?? input.groupId
    const now = new Date().toISOString()
    const optimistic: CatalogTag = {
      id: clientId,
      orgId,
      groupId: input.groupId,
      groupName,
      value: input.value.trim(),
      color: input.color.toUpperCase(),
      lifecycleStatus: 'active',
      canonicalTagId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      pendingSync: true,
    }
    const outboxEntry: OutboxEntry = {
      id: idempotencyKey, orgId, kind: 'tag', clientId, input: body, optimistic, createdAt: Date.now(),
    }
    await putOutbox(outboxEntry)
    await recordOutboxOperation(outboxEntry, 'queued')
    await mergeCache(orgId, { tags: [optimistic] })
    installOnlineOutboxFlush()
    return optimistic
  }
}

export async function updateCatalogTag(
  orgId: string,
  tagId: string,
  patch: { groupId?: string; value?: string; color?: string },
  expectedVersion: number,
): Promise<CatalogTag> {
  const result = await json<{ tag: CatalogTag }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tags/${encodeURIComponent(tagId)}`,
    { method: 'PATCH', headers: mutationHeaders(), body: JSON.stringify({ ...patch, expectedVersion }) },
  )
  await mergeCache(orgId, { tags: [result.tag] })
  return result.tag
}

export async function reorderCatalogTag(
  orgId: string,
  tag: Pick<CatalogTag, 'id' | 'version'>,
  move: { beforeId: string; afterId?: never } | { beforeId?: never; afterId: string },
): Promise<CatalogTag> {
  const result = await json<{ tag: CatalogTag }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tags/reorder`,
    {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({
        tagId: tag.id,
        expectedVersion: tag.version,
        beforeId: move.beforeId ?? null,
        afterId: move.afterId ?? null,
      }),
    },
  )
  await mergeCache(orgId, { tags: [result.tag] })
  return result.tag
}

export async function setCatalogTagLifecycle(
  orgId: string,
  tag: Pick<CatalogTag, 'id' | 'version'>,
  lifecycle: 'active' | 'archived',
): Promise<CatalogTag> {
  const action = lifecycle === 'active' ? 'restore' : 'archive'
  const result = await json<{ tag: CatalogTag }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tags/${encodeURIComponent(tag.id)}/${action}`,
    { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ expectedVersion: tag.version }) },
  )
  await mergeCache(orgId, { tags: [result.tag] })
  return result.tag
}

export async function getCatalogTagUsageSummary(
  orgId: string,
  tagIds: readonly string[],
  signal?: AbortSignal,
): Promise<CatalogTagUsageCount[]> {
  const ids = [...new Set(tagIds.filter(Boolean))].slice(0, 100)
  if (ids.length === 0) return []
  const result = await json<{ usage: CatalogTagUsageCount[] }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tags/usage-summary`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tagIds: ids }),
      signal,
    },
  )
  return result.usage
}

export async function listCatalogTagAudit(
  orgId: string,
  tagId: string,
  options: { action?: string; after?: string | null; limit?: number } = {},
  signal?: AbortSignal,
): Promise<KeysetPage<CatalogTagAuditEntry>> {
  const params = new URLSearchParams()
  if (options.action) params.set('action', options.action)
  if (options.after) params.set('after', options.after)
  if (options.limit) params.set('limit', String(options.limit))
  const query = params.toString()
  return json<KeysetPage<CatalogTagAuditEntry>>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tags/${encodeURIComponent(tagId)}/audit${query ? `?${query}` : ''}`,
    { signal },
  )
}

export async function listCatalogTagAssignments(
  orgId: string,
  tagId: string,
  options: { kind?: CatalogTagAssignmentKind | 'all'; after?: string | null; limit?: number } = {},
  signal?: AbortSignal,
): Promise<KeysetPage<CatalogTagAssignment>> {
  const params = new URLSearchParams()
  if (options.kind && options.kind !== 'all') params.set('kind', options.kind)
  if (options.after) params.set('after', options.after)
  if (options.limit) params.set('limit', String(options.limit))
  const query = params.toString()
  return json<KeysetPage<CatalogTagAssignment>>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tags/${encodeURIComponent(tagId)}/assignments${query ? `?${query}` : ''}`,
    { signal },
  )
}

export async function batchUpdateCatalogTags(
  orgId: string,
  items: readonly Pick<CatalogTag, 'id' | 'version'>[],
  action: CatalogTagBatchAction,
  options: { color?: string; groupId?: string } = {},
): Promise<CatalogTag[]> {
  const result = await json<{ tags: CatalogTag[] }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tags/batch`,
    {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({
        action,
        items: [...items].slice(0, 100).map((item) => ({ id: item.id, expectedVersion: item.version })),
        ...(action === 'recolor' ? { color: options.color } : {}),
        ...(action === 'move' ? { groupId: options.groupId } : {}),
      }),
    },
  )
  await mergeCache(orgId, { tags: result.tags })
  return result.tags
}

export async function mergeCatalogTags(
  orgId: string,
  source: Pick<CatalogTag, 'id' | 'version'>,
  target: Pick<CatalogTag, 'id' | 'version'>,
): Promise<{ source: CatalogTag; target: CatalogTag }> {
  const result = await json<{ source: CatalogTag; target: CatalogTag }>(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/tags/${encodeURIComponent(source.id)}/merge`,
    {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({
        targetTagId: target.id,
        expectedSourceVersion: source.version,
        expectedTargetVersion: target.version,
      }),
    },
  )
  await mergeCache(orgId, { tags: [result.source, result.target] })
  registerTagCanonicalIds([{
    id: result.source.id,
    canonicalTagId: result.target.id,
    redirectedFromIds: [result.source.id],
  }])
  return result
}

export function __resetTagCatalogCacheForTest(): void {
  memoryCache.clear()
  memoryOutbox.clear()
  memoryOperationEvents.clear()
  outboxFlushes.clear()
  operationFlushes.clear()
}
