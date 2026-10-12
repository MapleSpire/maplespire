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
import { accountDatabaseName } from '../auth/accountNamespace'

export const TAG_POSTINGS_DIRTY_KEY = '__meta:tag-postings-dirty'

export interface TagPosting {
  entityId: string
  entityKind: 'object' | 'group'
  tagId: string
  ordinal: number
}

export interface TagPostingsStore {
  isBuilt(): Promise<boolean>
  rebuild(entities: Array<C4Object | Group>): Promise<void>
  applyEntityDelta(
    upsertEntities: Array<C4Object | Group>,
    removeEntityIds: string[],
    entityCountDelta: number,
  ): Promise<void>
  /** OR semantics across stable Tag IDs; never scans unrelated entities. */
  entityIdsForTags(tagIds: string[]): Promise<string[]>
  entityCount(): Promise<number>
}

export function tagPostingsForEntity(entity: C4Object | Group): TagPosting[] {
  const assignments = entity.tagAssignments ?? {}
  const assigned = new Set(Object.entries(assignments)
    .filter(([mapKey, assignment]) => !!mapKey && assignment?.tagId === mapKey)
    .map(([mapKey]) => mapKey))
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const tagId of entity.tagOrder ?? []) {
    if (assigned.has(tagId) && !seen.has(tagId)) {
      ordered.push(tagId)
      seen.add(tagId)
    }
  }
  for (const tagId of [...assigned].sort()) if (!seen.has(tagId)) ordered.push(tagId)
  const entityKind = 'type' in entity ? 'object' : 'group'
  return ordered.map((tagId, ordinal) => ({ entityId: entity.id, entityKind, tagId, ordinal }))
}

const DB_NAME = 'maplespire-tag-postings-v1'
const DB_VERSION = 1
const POSTINGS = 'postings'
const META = 'meta'
const BY_TAG = 'byTag'
const BY_ENTITY = 'byEntity'
const MAX_KEY = '\uffff'

interface PostingRecord extends TagPosting {
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
    const request = indexedDB.open(accountDatabaseName(DB_NAME), DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      const postings = db.createObjectStore(POSTINGS, {
        keyPath: ['workspaceId', 'generation', 'entityId', 'tagId'],
      })
      postings.createIndex(BY_TAG, ['workspaceId', 'generation', 'tagId', 'entityId'])
      postings.createIndex(BY_ENTITY, ['workspaceId', 'generation', 'entityId'])
      db.createObjectStore(META, { keyPath: 'workspaceId' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open Tag postings database'))
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

class IndexedDbTagPostingsStore implements TagPostingsStore {
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
    const rows = entities.flatMap(tagPostingsForEntity)
    const chunkSize = 2000
    for (let i = 0; i < rows.length; i += chunkSize) {
      const tx = db.transaction(POSTINGS, 'readwrite')
      const store = tx.objectStore(POSTINGS)
      for (const row of rows.slice(i, i + chunkSize)) {
        store.put({ ...row, workspaceId: this.workspaceId, generation } satisfies PostingRecord)
      }
      await transactionDone(tx)
    }
    const activate = db.transaction(META, 'readwrite')
    activate.objectStore(META).put({
      workspaceId: this.workspaceId,
      activeGeneration: generation,
      entityCount: entities.length,
    } satisfies WorkspaceMeta)
    await transactionDone(activate)
    void this.cleanupInactiveGenerations(generation).catch((error) => {
      console.warn('[tagPostings] stale generation cleanup failed', error)
    })
  }

  async applyEntityDelta(
    upsertEntities: Array<C4Object | Group>,
    removeEntityIds: string[],
    entityCountDelta: number,
  ): Promise<void> {
    const db = await openDatabase()
    const tx = db.transaction([POSTINGS, META], 'readwrite')
    const postingStore = tx.objectStore(POSTINGS)
    const metaStore = tx.objectStore(META)
    const current = await requestResult(metaStore.get(this.workspaceId)) as WorkspaceMeta | undefined
    if (!current) {
      tx.abort()
      throw new Error(`Tag postings are not built for workspace ${this.workspaceId}`)
    }
    const touched = new Set([...upsertEntities.map((entity) => entity.id), ...removeEntityIds])
    const byEntity = postingStore.index(BY_ENTITY)
    for (const entityId of touched) {
      const keys = await requestResult(byEntity.getAllKeys(
        IDBKeyRange.only([this.workspaceId, current.activeGeneration, entityId])
      ))
      for (const key of keys) postingStore.delete(key)
    }
    for (const entity of upsertEntities) {
      for (const row of tagPostingsForEntity(entity)) {
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

  async entityIdsForTags(tagIds: string[]): Promise<string[]> {
    const ids = [...new Set(tagIds.filter(Boolean))]
    if (!ids.length) return []
    const current = await this.meta()
    if (!current) return []
    const db = await openDatabase()
    const tx = db.transaction(POSTINGS, 'readonly')
    const index = tx.objectStore(POSTINGS).index(BY_TAG)
    const entityIds = new Set<string>()
    for (const tagId of ids) {
      const rows = await requestResult(index.getAll(IDBKeyRange.bound(
        [this.workspaceId, current.activeGeneration, tagId, ''],
        [this.workspaceId, current.activeGeneration, tagId, MAX_KEY]
      ))) as PostingRecord[]
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
      cursor.onerror = () => reject(cursor.error ?? new Error('Unable to clean Tag postings'))
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

export function createMemoryTagPostingsStore(): TagPostingsStore {
  let rows: TagPosting[] = []
  let count = 0
  let built = false
  return {
    isBuilt: async () => built,
    rebuild: async (entities) => {
      rows = entities.flatMap(tagPostingsForEntity)
      count = entities.length
      built = true
    },
    applyEntityDelta: async (upsertEntities, removeEntityIds, delta) => {
      const touched = new Set([...upsertEntities.map((entity) => entity.id), ...removeEntityIds])
      rows = rows.filter((row) => !touched.has(row.entityId))
      for (const entity of upsertEntities) rows.push(...tagPostingsForEntity(entity))
      count = Math.max(0, count + delta)
    },
    entityIdsForTags: async (tagIds) => {
      const selected = new Set(tagIds)
      return [...new Set(rows.filter((row) => selected.has(row.tagId)).map((row) => row.entityId))]
    },
    entityCount: async () => count,
  }
}

let stores = new WeakMap<KvStore, TagPostingsStore>()

export function tagPostingsFor(store: KvStore): TagPostingsStore {
  let postings = stores.get(store)
  if (!postings) {
    postings = typeof indexedDB === 'undefined'
      ? createMemoryTagPostingsStore()
      : new IndexedDbTagPostingsStore(store.namespace ?? 'default::current')
    stores.set(store, postings)
  }
  return postings
}

export async function recoverTagPostingsIfNeeded(store: KvStore): Promise<boolean> {
  const postings = tagPostingsFor(store)
  const dirty = await store.get<boolean>(TAG_POSTINGS_DIRTY_KEY)
  if (!dirty && await postings.isBuilt()) return false
  const [objects, groups] = await Promise.all([
    store.scanPrefix<C4Object>('o:'),
    store.scanPrefix<Group>('g:'),
  ])
  await postings.rebuild([
    ...objects.map(([, object]) => object),
    ...groups.map(([, group]) => group),
  ])
  await store.del(TAG_POSTINGS_DIRTY_KEY)
  return true
}

export function __setTagPostingsForTest(store: KvStore, postings: TagPostingsStore | null): void {
  if (postings) stores.set(store, postings)
  else stores.delete(store)
}

export function __resetTagPostingsForTest(): void {
  stores = new WeakMap()
}
