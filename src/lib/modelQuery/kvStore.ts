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

import { get, getMany, set, setMany, del, delMany, entries, clear, createStore, update, type UseStore } from 'idb-keyval'
import { currentWorkspaceRef, workspaceRefKey } from '../automerge/workspace'
import { accountDatabaseName } from '../auth/accountNamespace'
import { recordModelQueryOperation } from '../observability/modelQueryDiagnostics'

/**
 * Minimal async key/value store the model index is built on. Decoupling the index
 * logic from IndexedDB lets it be unit-tested against an in-memory store (the test
 * env is node, with no IndexedDB) and keeps the index backend swappable.
 */
export interface KvStore {
  /** Logical workspace namespace. Used by specialized compound IndexedDB stores
   * that cannot be represented efficiently as prefixed idb-keyval entries. */
  readonly namespace?: string
  get<T>(key: string): Promise<T | undefined>
  getMany<T>(keys: string[]): Promise<(T | undefined)[]>
  set(key: string, value: unknown): Promise<void>
  setMany(entries: [string, unknown][]): Promise<void>
  del(key: string): Promise<void>
  delMany(keys: string[]): Promise<void>
  /** ATOMIC read-modify-write of one key: get + set run inside a single
   * IndexedDB readwrite transaction, so concurrent updates from two TABS
   * serialize instead of losing one — a plain get-then-set cannot promise
   * that, and the entity-intent tab registry was strandable because of it. */
  update<T>(key: string, updater: (old: T | undefined) => T): Promise<void>
  /** All [key, value] pairs whose key starts with `prefix`. Used to enumerate a
   * whole entity family (o:/c:/g:/d:) so the index can back the global tables when
   * the resident store is windowed. O(all keys) — call only off the boot path. */
  scanPrefix<T>(prefix: string): Promise<[string, T][]>
  /** Wipe every key. Used before a full cold-build so a prior (possibly windowed)
   * index can't leave stale entries behind. */
  clear(): Promise<void>
}

let store: UseStore | undefined
function idb(): UseStore {
  if (!store) store = createStore(accountDatabaseName('maplespire-model-index'), 'idx')
  return store
}

/** Production KvStore backed by IndexedDB (idb-keyval). */
export const idbKvStore: KvStore = {
  get: <T>(k: string) => get<T>(k, idb()),
  getMany: <T>(ks: string[]) => getMany<T>(ks, idb()),
  set: (k, v) => set(k, v, idb()),
  setMany: (e) => setMany(e, idb()),
  del: (k) => del(k, idb()),
  delMany: (ks) => delMany(ks, idb()),
  update: <T>(k: string, updater: (old: T | undefined) => T) => update<T>(k, updater, idb()),
  scanPrefix: async <T>(prefix: string) => {
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
    try {
      const all = await entries(idb())
      const result = all.filter(([k]) => typeof k === 'string' && k.startsWith(prefix)) as [string, T][]
      recordModelQueryOperation({
        operation: 'idb-keyval.scanPrefix',
        durationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
        rowsRead: all.length,
        resultRows: result.length,
        fullScan: true,
      })
      return result
    } catch (error) {
      recordModelQueryOperation({
        operation: 'idb-keyval.scanPrefix',
        durationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
        fullScan: true,
        failed: true,
      })
      throw error
    }
  },
  clear: () => clear(idb()),
}

/** In-memory KvStore for tests (and a non-persistent fallback). */
export function createMemoryKvStore(): KvStore {
  const m = new Map<string, unknown>()
  return {
    get: async <T>(k: string) => m.get(k) as T | undefined,
    getMany: async <T>(ks: string[]) => ks.map((k) => m.get(k) as T | undefined),
    set: async (k, v) => { m.set(k, v) },
    setMany: async (e) => { for (const [k, v] of e) m.set(k, v) },
    del: async (k) => { m.delete(k) },
    delMany: async (ks) => { for (const k of ks) m.delete(k) },
    update: async <T>(k: string, updater: (old: T | undefined) => T) => {
      m.set(k, updater(m.get(k) as T | undefined))
    },
    scanPrefix: async <T>(prefix: string) => {
      const out: [string, T][] = []
      for (const [k, v] of m) if (k.startsWith(prefix)) out.push([k, v as T])
      return out
    },
    clear: async () => { m.clear() },
  }
}

/**
 * Wrap a base KvStore so every key is namespaced with `${prefix}::` — used to
 * partition the ONE physical IndexedDB database into one logical store PER
 * WORKSPACE (`${landscapeId}::${versionId}`), so a workspace switch can never read
 * or wipe another workspace's paging index.
 *
 * `clear()` only removes keys under this namespace (a prefix scan + delete) — NOT
 * the whole physical store — so a cold-build for one workspace never wipes another's
 * already-built index. `scanPrefix` strips the namespace back off so callers see the
 * same unprefixed keys (`o:`, `c:`, …) they'd see against the un-namespaced store.
 */
export function namespacedKvStore(base: KvStore, namespace: string): KvStore {
  const ns = `${namespace}::`
  const wrap = (k: string) => ns + k
  return {
    namespace,
    get: <T>(k: string) => base.get<T>(wrap(k)),
    getMany: <T>(ks: string[]) => base.getMany<T>(ks.map(wrap)),
    set: (k, v) => base.set(wrap(k), v),
    setMany: (e) => base.setMany(e.map(([k, v]) => [wrap(k), v])),
    del: (k) => base.del(wrap(k)),
    delMany: (ks) => base.delMany(ks.map(wrap)),
    update: <T>(k: string, updater: (old: T | undefined) => T) => base.update<T>(wrap(k), updater),
    scanPrefix: async <T>(prefix: string) => {
      const rows = await base.scanPrefix<T>(wrap(prefix))
      return rows.map(([k, v]) => [k.slice(ns.length), v] as [string, T])
    },
    clear: async () => {
      const all = await base.scanPrefix<unknown>(ns)
      await base.delMany(all.map(([k]) => k))
    },
  }
}

/**
 * The paging index's KvStore for the ACTIVE workspace — one `namespacedKvStore`
 * instance per `workspaceRefKey`, memoized so repeated calls within the same
 * workspace return the SAME object (heavyViews' index-array memo keys its cache on
 * store identity; a fresh object every call would defeat it). A workspace switch
 * naturally gets a different instance, so callers never need to invalidate by hand.
 */
const perWorkspaceStore = new Map<string, KvStore>()

/** The physical store every `workspaceKvStore()` namespace wraps. Production default
 * is `idbKvStore`; tests swap it for an in-memory store (the test env is node, with
 * no IndexedDB) via `__setWorkspaceKvBaseForTest`. */
let baseStore: KvStore = idbKvStore

export function workspaceKvStore(): KvStore {
  const key = workspaceRefKey(currentWorkspaceRef())
  let s = perWorkspaceStore.get(key)
  if (!s) {
    s = namespacedKvStore(baseStore, key)
    perWorkspaceStore.set(key, s)
  }
  return s
}

/** Test hook: drop memoized per-workspace store instances (so a test's fresh
 * `setActiveWorkspaceRef` + `createMemoryKvStore` swap isn't shadowed by a stale one). */
export function __resetWorkspaceKvStores(): void {
  perWorkspaceStore.clear()
}

/** Test hook: back EVERY `workspaceKvStore()` namespace with a fresh in-memory store
 * instead of IndexedDB (pass null to restore the production `idbKvStore` base).
 * Implicitly resets the per-workspace memo, since the old instances wrapped the old
 * base. */
export function __setWorkspaceKvBaseForTest(base: KvStore | null): void {
  baseStore = base ?? idbKvStore
  perWorkspaceStore.clear()
}
