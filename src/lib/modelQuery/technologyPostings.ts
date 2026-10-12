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

import type { C4Object, Group } from '../../types'
import type { KvStore } from './kvStore'

/** Crash marker stored with the flat model index. Cross-database writes cannot be
 * one browser transaction, so a warm boot rebuilds postings if a delta stopped
 * between the model record and posting commits. Recovery may scan; filtering may not. */
export const TECHNOLOGY_POSTINGS_DIRTY_KEY = '__meta:technology-postings-dirty'

interface UsageLike {
  id?: string
  technologyId?: string
  catalogRevision?: number
  usedVersion?: string
  role?: string
  snapshot?: Record<string, unknown>
}

export interface TechnologyPosting {
  entityId: string
  entityKind: 'object' | 'group'
  usageId: string
  technologyId: string
  catalogRevision: number
  usedVersion?: string
  role?: string
  snapshot: Record<string, unknown>
}

export interface TechnologyPostingsStore {
  /** Whether this workspace has an atomically published postings generation. */
  isBuilt(): Promise<boolean>
  /** Build into an invisible generation, then switch it active atomically. */
  rebuild(entities: Array<C4Object | Group>): Promise<void>
  /** Atomically delete stale postings and write replacements for touched entities. */
  applyEntityDelta(
    upsertEntities: Array<C4Object | Group>,
    removeEntityIds: string[],
    entityCountDelta: number,
  ): Promise<void>
  /** OR semantics across technology IDs. Never scans unrelated postings. */
  entityIdsForTechnologies(technologyIds: string[]): Promise<string[]>
  entityCount(): Promise<number>
}

export function postingsForEntity(entity: C4Object | Group): TechnologyPosting[] {
  const usages = (entity as (C4Object | Group) & { technologyUsages?: Record<string, UsageLike> }).technologyUsages ?? {}
  const rows: TechnologyPosting[] = []
  for (const [mapKey, usage] of Object.entries(usages)) {
    const usageId = typeof usage?.id === 'string' && usage.id ? usage.id : mapKey
    if (!usageId || typeof usage?.technologyId !== 'string' || !usage.technologyId) continue
    if (!Number.isInteger(usage.catalogRevision) || Number(usage.catalogRevision) < 1) continue
    rows.push({
      entityId: entity.id,
      entityKind: 'type' in entity ? 'object' : 'group',
      usageId,
      technologyId: usage.technologyId,
      catalogRevision: Number(usage.catalogRevision),
      ...(typeof usage.usedVersion === 'string' ? { usedVersion: usage.usedVersion } : {}),
      ...(typeof usage.role === 'string' ? { role: usage.role } : {}),
      snapshot: usage.snapshot && typeof usage.snapshot === 'object' ? usage.snapshot : {},
    })
  }
  return rows
}

// ── IndexedDB implementation ─────────────────────────────────────────────────

const DB_NAME = 'maplespire-technology-postings-v2'
const DB_VERSION = 1
const POSTINGS = 'postings'
const META = 'meta'
const BY_TECHNOLOGY = 'byTechnology'
const BY_ENTITY = 'byEntity'
const MAX_KEY = '\uffff'

interface PostingRecord extends TechnologyPosting {
  workspaceId: string
  generation: string
}

interface WorkspaceMeta {
  workspaceId: string
  activeGeneration: string
  entityCount: number
}

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      const postings = db.createObjectStore(POSTINGS, {
        keyPath: ['workspaceId', 'generation', 'entityId', 'usageId'],
      })
      postings.createIndex(BY_TECHNOLOGY, [
        'workspaceId', 'generation', 'technologyId', 'entityId', 'usageId',
      ])
      postings.createIndex(BY_ENTITY, ['workspaceId', 'generation', 'entityId'])
      db.createObjectStore(META, { keyPath: 'workspaceId' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open technology postings database'))
  })
  return databasePromise
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  })
}

class IndexedDbTechnologyPostingsStore implements TechnologyPostingsStore {
  private readonly workspaceId: string

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId
  }

  private async meta(): Promise<WorkspaceMeta | undefined> {
    const db = await openDatabase()
    const tx = db.transaction(META, 'readonly')
    return requestResult(tx.objectStore(META).get(this.workspaceId)) as Promise<WorkspaceMeta | undefined>
  }

  async isBuilt(): Promise<boolean> {
    return !!(await this.meta())
  }

  async rebuild(entities: Array<C4Object | Group>): Promise<void> {
    const db = await openDatabase()
    const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const rows = entities.flatMap(postingsForEntity)
    const CHUNK = 2000
    for (let i = 0; i < rows.length; i += CHUNK) {
      const tx = db.transaction(POSTINGS, 'readwrite')
      const store = tx.objectStore(POSTINGS)
      for (const row of rows.slice(i, i + CHUNK)) {
        store.put({ ...row, workspaceId: this.workspaceId, generation } satisfies PostingRecord)
      }
      await transactionDone(tx)
    }

    // Only this tiny metadata write publishes the completely-written generation.
    const activate = db.transaction(META, 'readwrite')
    activate.objectStore(META).put({
      workspaceId: this.workspaceId,
      activeGeneration: generation,
      entityCount: entities.length,
    } satisfies WorkspaceMeta)
    await transactionDone(activate)

    // Stale/incomplete generations are invisible. Cleanup is rebuild-only work;
    // filtering never traverses them and does not wait for this scan.
    void this.cleanupInactiveGenerations(generation).catch((error) => {
      console.warn('[technologyPostings] stale generation cleanup failed', error)
    })
  }

  async applyEntityDelta(
    upsertEntities: Array<C4Object | Group>,
    removeEntityIds: string[],
    entityCountDelta: number
  ): Promise<void> {
    const db = await openDatabase()
    const tx = db.transaction([POSTINGS, META], 'readwrite')
    const postingStore = tx.objectStore(POSTINGS)
    const metaStore = tx.objectStore(META)
    const current = await requestResult(metaStore.get(this.workspaceId)) as WorkspaceMeta | undefined
    if (!current) {
      tx.abort()
      throw new Error(`Technology postings are not built for workspace ${this.workspaceId}`)
    }

    const touched = new Set([...upsertEntities.map((entity) => entity.id), ...removeEntityIds])
    const byEntity = postingStore.index(BY_ENTITY)
    for (const entityId of touched) {
      const range = IDBKeyRange.only([this.workspaceId, current.activeGeneration, entityId])
      const keys = await requestResult(byEntity.getAllKeys(range))
      for (const key of keys) postingStore.delete(key)
    }
    for (const entity of upsertEntities) {
      for (const row of postingsForEntity(entity)) {
        postingStore.put({
          ...row,
          workspaceId: this.workspaceId,
          generation: current.activeGeneration,
        } satisfies PostingRecord)
      }
    }
    metaStore.put({
      ...current,
      entityCount: Math.max(0, current.entityCount + entityCountDelta),
    } satisfies WorkspaceMeta)
    await transactionDone(tx)
  }

  async entityIdsForTechnologies(technologyIds: string[]): Promise<string[]> {
    const ids = [...new Set(technologyIds.filter(Boolean))]
    if (!ids.length) return []
    const current = await this.meta()
    if (!current) return []
    const db = await openDatabase()
    const tx = db.transaction(POSTINGS, 'readonly')
    const index = tx.objectStore(POSTINGS).index(BY_TECHNOLOGY)
    const entityIds = new Set<string>()
    for (const technologyId of ids) {
      const range = IDBKeyRange.bound(
        [this.workspaceId, current.activeGeneration, technologyId, '', ''],
        [this.workspaceId, current.activeGeneration, technologyId, MAX_KEY, MAX_KEY]
      )
      const rows = await requestResult(index.getAll(range)) as PostingRecord[]
      for (const row of rows) entityIds.add(row.entityId)
    }
    await transactionDone(tx)
    return [...entityIds]
  }

  async entityCount(): Promise<number> {
    return (await this.meta())?.entityCount ?? 0
  }

  private async cleanupInactiveGenerations(activeGeneration: string): Promise<void> {
    const db = await openDatabase()
    const tx = db.transaction(POSTINGS, 'readwrite')
    const store = tx.objectStore(POSTINGS)
    const range = IDBKeyRange.bound(
      [this.workspaceId, ''],
      [this.workspaceId, MAX_KEY, MAX_KEY, MAX_KEY]
    )
    await new Promise<void>((resolve, reject) => {
      const cursor = store.openCursor(range)
      cursor.onerror = () => reject(cursor.error ?? new Error('Unable to clean technology postings'))
      cursor.onsuccess = () => {
        const current = cursor.result
        if (!current) { resolve(); return }
        const row = current.value as PostingRecord
        if (row.generation !== activeGeneration) current.delete()
        current.continue()
      }
    })
    await transactionDone(tx)
  }
}

// ── deterministic memory implementation (unit tests / non-IDB runtimes) ──────

export function createMemoryTechnologyPostingsStore(): TechnologyPostingsStore {
  let rows: TechnologyPosting[] = []
  let count = 0
  let built = false
  return {
    isBuilt: async () => built,
    rebuild: async (entities) => {
      const next = entities.flatMap(postingsForEntity)
      rows = next
      count = entities.length
      built = true
    },
    applyEntityDelta: async (upsertEntities, removeEntityIds, delta) => {
      const touched = new Set([...upsertEntities.map((entity) => entity.id), ...removeEntityIds])
      const next = rows.filter((row) => !touched.has(row.entityId))
      for (const entity of upsertEntities) next.push(...postingsForEntity(entity))
      rows = next
      count = Math.max(0, count + delta)
    },
    entityIdsForTechnologies: async (technologyIds) => {
      const selected = new Set(technologyIds)
      return [...new Set(rows.filter((row) => selected.has(row.technologyId)).map((row) => row.entityId))]
    },
    entityCount: async () => count,
  }
}

let stores = new WeakMap<KvStore, TechnologyPostingsStore>()

export function technologyPostingsFor(store: KvStore): TechnologyPostingsStore {
  let postings = stores.get(store)
  if (!postings) {
    postings = typeof indexedDB === 'undefined'
      ? createMemoryTechnologyPostingsStore()
      : new IndexedDbTechnologyPostingsStore(store.namespace ?? 'default::current')
    stores.set(store, postings)
  }
  return postings
}

export async function recoverTechnologyPostingsIfNeeded(store: KvStore): Promise<boolean> {
  const postings = technologyPostingsFor(store)
  const dirty = await store.get<boolean>(TECHNOLOGY_POSTINGS_DIRTY_KEY)
  // A warm index created before technology postings existed has no crash marker.
  // Treat the missing published generation as a one-time recovery condition too.
  if (!dirty && await postings.isBuilt()) return false
  const [objects, groups] = await Promise.all([
    store.scanPrefix<C4Object>('o:'),
    store.scanPrefix<Group>('g:'),
  ])
  await postings.rebuild([
    ...objects.map(([, object]) => object),
    ...groups.map(([, group]) => group),
  ])
  await store.del(TECHNOLOGY_POSTINGS_DIRTY_KEY)
  return true
}

/** Unit-test hook for deterministic posting stores and isolation. */
export function __setTechnologyPostingsForTest(
  store: KvStore,
  postings: TechnologyPostingsStore | null
): void {
  if (postings) stores.set(store, postings)
  else stores.delete(store)
}

export function __resetTechnologyPostingsForTest(): void {
  stores = new WeakMap()
}
