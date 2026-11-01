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
 * `idbKvStore.update` on a real IndexedDB (fake-indexeddb).
 *
 * Measured 2026-10-31 (reviewer lens, fake-indexeddb): idb-keyval 6.2.2's
 * `update` listens only for its read's `success`. When the read fails — the
 * transaction aborted, or the request itself erroring — the promise it returns
 * NEVER settles, while a plain `get` failing the same way rejects. Callers
 * await it on the boot path (held-pointer resume, placement-journal adoption)
 * and inside the minted-id reserve's serialized chain, so one failed read
 * wedged them for the rest of the page's life.
 *
 * The failures are injected the way a browser produces them: the transaction
 * is aborted while the read is pending, or the read's own operation throws
 * (the request fires `error`, and the transaction aborts by default).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { IDBFactory, IDBKeyRange as FakeIDBKeyRange, IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb'
import { afterEach, describe, expect, it } from 'vitest'
import { __setWorkspaceKvBaseForTest, idbKvStore, workspaceKvStore } from './kvStore'
import { DEFAULT_WORKSPACE_REF, setActiveWorkspaceRef } from '../automerge/workspace'

;(globalThis as any).indexedDB = new IDBFactory()
;(globalThis as any).IDBKeyRange = FakeIDBKeyRange

/** Keys whose next read fails, and how. Matched on the PHYSICAL key, so a
 *  namespaced key matches by suffix. */
const failingReads = new Map<string, 'abort' | 'request-error'>()
/** Keys whose transaction is aborted right after the write SUCCEEDED, i.e.
 *  the write is rolled back after its request reported success. */
const abortAfterWrite = new Set<string>()
/** Keys whose next write fails the way a full disk fails it: the put request
 *  errors, and the transaction aborts with that error. */
const failingWrites = new Set<string>()

function injected<V>(table: Map<string, V> | Set<string>, key: unknown): V | boolean | undefined {
  if (typeof key !== 'string') return undefined
  for (const entry of table instanceof Map ? table.keys() : table) {
    if (key === entry || key.endsWith(`::${entry}`)) return table instanceof Map ? table.get(entry) : true
  }
  return undefined
}

const originalGet = FakeIDBObjectStore.prototype.get
FakeIDBObjectStore.prototype.get = function (this: any, key: unknown) {
  const mode = injected(failingReads, key)
  if (mode === 'request-error') {
    // `get` binds the raw store's read when it is called; swap it for that
    // one call so the queued operation throws when it runs.
    const raw = this._rawObjectStore
    const read = raw.getValue
    raw.getValue = () => { throw new DOMException('the backing store could not be read', 'UnknownError') }
    try {
      return originalGet.call(this, key as never)
    } finally {
      raw.getValue = read
    }
  }
  const request = originalGet.call(this, key as never)
  if (mode === 'abort') this.transaction.abort()
  return request
}

const originalPut = FakeIDBObjectStore.prototype.put
FakeIDBObjectStore.prototype.put = function (this: any, value: unknown, key?: unknown) {
  if (injected(failingWrites, key)) {
    // Same one-call swap as the read's: `put` binds the raw write when called.
    const raw = this._rawObjectStore
    const write = raw.storeRecord
    raw.storeRecord = () => { throw new DOMException('the disk is full', 'QuotaExceededError') }
    try {
      return originalPut.call(this, value, key as never)
    } finally {
      raw.storeRecord = write
    }
  }
  const request = originalPut.call(this, value, key as never)
  if (injected(abortAfterWrite, key)) {
    const transaction = this.transaction
    request.addEventListener('success', () => transaction.abort())
  }
  return request
}

/** Settle within `ms`, or fail naming what hung. A literal bound: the
 *  failures under test are reported by IndexedDB within a few tasks. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function settled(promise: Promise<unknown>, what: string): Promise<{ ok: true } | { ok: false; error: any }> {
  try {
    await within(promise, 1_000, what)
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

let keySequence = 0
const freshKey = (label: string) => `update-test:${label}:${++keySequence}`

afterEach(() => {
  failingReads.clear()
  abortAfterWrite.clear()
  failingWrites.clear()
  __setWorkspaceKvBaseForTest(null)
  setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
})

describe('idbKvStore.update — a failed read settles', () => {
  it('rejects with AbortError, without running the updater, when its transaction aborts during the read', async () => {
    const key = freshKey('abort')
    await idbKvStore.set(key, ['before'])
    // Control: a plain get failing the same way rejects (the asymmetry this
    // file exists for).
    failingReads.set(key, 'abort')
    const plain = await settled(idbKvStore.get(key), 'get')
    expect(plain).toMatchObject({ ok: false, error: { name: 'AbortError' } })

    let updaterRan = false
    const outcome = await settled(idbKvStore.update<string[]>(key, (old) => {
      updaterRan = true
      return [...(old ?? []), 'after']
    }), 'update')
    expect(outcome).toMatchObject({ ok: false, error: { name: 'AbortError' } })
    expect(updaterRan).toBe(false)

    failingReads.clear()
    expect(await idbKvStore.get(key)).toEqual(['before'])
  })

  it("rejects with the read's own error when the read request fails", async () => {
    const key = freshKey('request-error')
    await idbKvStore.set(key, 1)
    failingReads.set(key, 'request-error')
    let updaterRan = false
    const outcome = await settled(idbKvStore.update<number>(key, (old) => {
      updaterRan = true
      return (old ?? 0) + 1
    }), 'update')
    expect(outcome).toMatchObject({ ok: false, error: { name: 'UnknownError' } })
    expect(updaterRan).toBe(false)

    failingReads.clear()
    expect(await idbKvStore.get(key)).toBe(1)
  })

  it('settles through the per-workspace store every caller uses', async () => {
    __setWorkspaceKvBaseForTest(null)
    setActiveWorkspaceRef({ landscapeId: 'ls-update', versionId: 'v-update' })
    const store = workspaceKvStore()
    await store.set('registry', ['tab-a'])
    failingReads.set('registry', 'abort')
    const outcome = await settled(store.update<string[]>('registry', (tabs) => [...(tabs ?? []), 'tab-b']), 'update')
    expect(outcome).toMatchObject({ ok: false, error: { name: 'AbortError' } })
    failingReads.clear()
    expect(await store.get('registry')).toEqual(['tab-a'])
    // The injection matches by suffix, so the failure alone cannot tell a
    // namespaced write from a raw one; a successful update can.
    await within(store.update<string[]>('registry', (tabs) => [...(tabs ?? []), 'tab-b']), 1_000, 'update')
    expect(await store.get('registry')).toEqual(['tab-a', 'tab-b'])
    expect(await idbKvStore.get('registry')).toBeUndefined()
  })

  it('leaves the store usable: the next update of the same key lands', async () => {
    const key = freshKey('recover')
    await idbKvStore.set(key, 1)
    failingReads.set(key, 'abort')
    await settled(idbKvStore.update<number>(key, (old) => (old ?? 0) + 1), 'failed update')
    failingReads.clear()
    await within(idbKvStore.update<number>(key, (old) => (old ?? 0) + 10), 1_000, 'next update')
    expect(await idbKvStore.get(key)).toBe(11)
  })
})

describe('idbKvStore.update — the rest of the contract', () => {
  it('resolves only once the write COMMITS: a write rolled back after its request succeeded rejects', async () => {
    // The minted-id reserve draws ids by removing them in the updater; an
    // update that resolved on the write request's success would hand out ids
    // a rolled-back transaction left in the pool.
    const key = freshKey('commit')
    await idbKvStore.set(key, { ids: ['a', 'b'] })
    abortAfterWrite.add(key)
    const outcome = await settled(idbKvStore.update<{ ids: string[] }>(key, (old) => ({ ids: (old?.ids ?? []).slice(1) })), 'update')
    expect(outcome).toMatchObject({ ok: false, error: { name: 'AbortError' } })
    abortAfterWrite.clear()
    expect(await idbKvStore.get(key)).toEqual({ ids: ['a', 'b'] })
  })

  it("rejects with the write's own error when the write fails", async () => {
    const key = freshKey('write-error')
    await idbKvStore.set(key, 'kept')
    failingWrites.add(key)
    const outcome = await settled(idbKvStore.update<string>(key, () => 'replaced'), 'update')
    expect(outcome).toMatchObject({ ok: false, error: { name: 'QuotaExceededError' } })
    failingWrites.clear()
    expect(await idbKvStore.get(key)).toBe('kept')
  })

  it("rejects with the updater's error and writes nothing when the updater throws", async () => {
    const key = freshKey('updater-throws')
    await idbKvStore.set(key, 'kept')
    const boom = new Error('updater refused')
    const outcome = await settled(idbKvStore.update<string>(key, () => { throw boom }), 'update')
    expect(outcome).toEqual({ ok: false, error: boom })
    expect(await idbKvStore.get(key)).toBe('kept')
  })

  it('is atomic: concurrent read-modify-writes of one key all land', async () => {
    // A get and a set in two transactions lets every read see the same old
    // value; one readwrite transaction serializes them.
    const key = freshKey('atomic')
    const writers = 25
    await Promise.all(Array.from({ length: writers }, () =>
      within(idbKvStore.update<number>(key, (old) => (old ?? 0) + 1), 2_000, 'concurrent update')))
    expect(await idbKvStore.get(key)).toBe(writers)
  })

  it('creates the key when it is absent', async () => {
    const key = freshKey('absent')
    await within(idbKvStore.update<string[]>(key, (old) => [...(old ?? []), 'first']), 1_000, 'update')
    expect(await idbKvStore.get(key)).toEqual(['first'])
  })
})
