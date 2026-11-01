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
 * The Tag catalog's IndexedDB writes on a real IndexedDB (fake-indexeddb).
 *
 * Reported 2026-10-31 (architect lens, from the spec), reproduced here: every
 * readwrite transaction in api.ts was wrapped in a promise listening for
 * `complete` and `error` only. A transaction that aborts with no request
 * pending (a commit that runs out of quota, the browser closing the
 * connection) fires `abort` alone, so that promise never settled. The outbox
 * flush awaits these writes and is memoized, so one hung write left every
 * later flush, and with it every Tag page load, waiting for ever.
 *
 * The failures are injected once every request of the transaction has
 * succeeded, so nothing is pending when the transaction fails:
 * - 'abort': `transaction.abort()`, which leaves `transaction.error` null;
 * - 'commit-quota': the transaction aborts with QuotaExceededError, as a
 *   commit that runs out of quota does;
 * - 'request-error': the write itself throws QuotaExceededError, so the request
 *   fires `error` and the transaction aborts by default.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  IDBDatabase as FakeIDBDatabase,
  IDBFactory,
  IDBKeyRange as FakeIDBKeyRange,
  IDBObjectStore as FakeIDBObjectStore,
} from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  __resetTagCatalogCacheForTest,
  createCatalogTag,
  createCatalogTagGroup,
  discardTagCatalogOutboxEntry,
  flushTagCatalogOutbox,
  flushTagOperationEvents,
  listTagPage,
  reconcileTagGroupOutboxEntry,
  type CatalogTag,
  type CatalogTagGroup,
} from './api'
import { accountDatabaseName } from '../auth/accountNamespace'

type Failure = 'abort' | 'commit-quota' | 'request-error'
const FAILURES: readonly Failure[] = ['abort', 'commit-quota', 'request-error']

/** The next readwrite transaction that writes to `store` fails this way. */
let armed: { store: string; failure: Failure } | null = null
/** The `remaining`-th `put` into `store` from now throws synchronously, as an
 *  uncloneable value does. */
let throwingPut: { store: string; remaining: number } | null = null

function arm(store: string, failure: Failure): void {
  armed = { store, failure }
}

function injected(objectStore: any, raw: 'storeRecord' | 'deleteRecord', call: () => any): any {
  const target = armed
  if (!target || objectStore.name !== target.store || objectStore.transaction.mode !== 'readwrite') return call()
  if (target.failure === 'request-error') {
    armed = null
    // `put`/`delete` bind the raw store's operation when called; swap it for
    // that one call so the queued operation throws when it runs.
    const rawStore = objectStore._rawObjectStore
    const operation = rawStore[raw]
    rawStore[raw] = () => { throw new DOMException('the disk is full', 'QuotaExceededError') }
    try {
      return call()
    } finally {
      rawStore[raw] = operation
    }
  }
  const request = call()
  const transaction = objectStore.transaction
  request.addEventListener('success', () => {
    // Only once the transaction has nothing left pending: then IndexedDB
    // fires `abort` and no request `error` at all.
    if (armed !== target || transaction._requests.some(({ request: queued }: any) => queued.readyState !== 'done')) return
    armed = null
    if (target.failure === 'abort') transaction.abort()
    else transaction._abort('QuotaExceededError')
  })
  return request
}

const originalPut = FakeIDBObjectStore.prototype.put
FakeIDBObjectStore.prototype.put = function (this: any, value: any, key?: any) {
  if (throwingPut && this.name === throwingPut.store && --throwingPut.remaining === 0) {
    throwingPut = null
    throw new DOMException('the value could not be cloned', 'DataCloneError')
  }
  return injected(this, 'storeRecord', () => originalPut.call(this, value, key))
}
const originalDelete = FakeIDBObjectStore.prototype.delete
FakeIDBObjectStore.prototype.delete = function (this: any, key: any) {
  return injected(this, 'deleteRecord', () => originalDelete.call(this, key))
}

/** Settle within `ms`, or fail naming what hung. A literal bound: the
 *  failures under test are reported by IndexedDB within a few tasks. */
function within<T>(promise: Promise<T>, what: string, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Every row of `store`, read on a connection of the test's own. */
async function rows<T>(store: string): Promise<T[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(accountDatabaseName('maplespire-tag-catalog-v1'))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).getAll()
      request.onsuccess = () => resolve(request.result as T[])
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

type Reply = { status?: number; body: unknown } | Error
/** A server answering by method and path; anything unrouted is unreachable. */
function serve(route: (method: string, path: string) => Reply | undefined) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const reply = route(init.method ?? 'GET', new URL(String(url), 'http://maplespire.test').pathname)
    if (reply === undefined || reply instanceof Error) throw reply ?? new TypeError('offline')
    const status = reply.status ?? 200
    return { ok: status < 400, status, json: async () => reply.body }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const tag = (overrides: Partial<CatalogTag> = {}): CatalogTag => ({
  id: 'tag-risk-high',
  orgId: 'org-tags',
  groupId: 'taggrp-risk',
  groupName: 'Risk',
  value: 'High',
  color: '#E05252',
  lifecycleStatus: 'active',
  canonicalTagId: null,
  version: 3,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
  ...overrides,
})

const offlineTag = () => createCatalogTag('org-tags', { groupId: 'taggrp-risk', value: 'Critical', color: '#B42318' })

let warn: MockInstance<typeof console.warn>
let opened = 0
let closed = 0

beforeEach(() => {
  ;(globalThis as any).indexedDB = new IDBFactory()
  ;(globalThis as any).IDBKeyRange = FakeIDBKeyRange
  opened = 0
  closed = 0
  const factory = (globalThis as any).indexedDB
  const open = factory.open.bind(factory)
  factory.open = (...args: any[]) => {
    const request = open(...args)
    request.addEventListener('success', () => { opened += 1 })
    return request
  }
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

const originalClose = FakeIDBDatabase.prototype.close
FakeIDBDatabase.prototype.close = function (this: any) {
  closed += 1
  return originalClose.call(this)
}

afterEach(() => {
  armed = null
  throwingPut = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  __resetTagCatalogCacheForTest()
})

/** The cause each injected failure must be reported with. An explicit abort
 *  leaves `transaction.error` null, so only "an Error, not null" is owed. */
const CAUSE: Record<Failure, string | null> = {
  abort: null,
  'commit-quota': 'QuotaExceededError',
  'request-error': 'QuotaExceededError',
}

/** The failure was reported once, as `pattern`, with a real error naming `cause`. */
function expectWarned(pattern: RegExp, cause: string | null): void {
  const reports = warn.mock.calls.filter(([message]) => pattern.test(String(message)))
  expect(reports).toHaveLength(1)
  expect(reports[0][1]).toBeInstanceOf(Error)
  if (cause) expect(reports[0][1]).toMatchObject({ name: cause })
}

describe('Tag catalog IndexedDB writes settle when their transaction fails', () => {
  it('control: with nothing injected, an offline creation lands in the outbox, the cache and the telemetry', async () => {
    serve(() => undefined)
    const draft = await within(offlineTag(), 'createCatalogTag')
    expect(await rows<{ clientId: string }>('outbox')).toEqual([expect.objectContaining({ clientId: draft.id })])
    expect((await rows<{ tags: CatalogTag[] }>('catalogs'))[0].tags.map((entry) => entry.id)).toEqual([draft.id])
    expect(await rows('operations')).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
    expect(closed).toBe(opened)
  })

  it.each(FAILURES)('an offline creation whose outbox write fails (%s) still returns its draft, and says so', async (failure) => {
    serve(() => undefined)
    arm('outbox', failure)
    const draft = await within(offlineTag(), 'createCatalogTag')
    expect(draft.pendingSync).toBe(true)
    expect(await rows('outbox')).toEqual([])
    expectWarned(/could not save an offline Tag catalog command .* may never reach the server/, CAUSE[failure])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(closed).toBe(opened)
  })

  it('an offline Group creation whose outbox write fails says the same', async () => {
    serve(() => undefined)
    arm('outbox', 'commit-quota')
    const draft = await within(createCatalogTagGroup('org-tags', { name: 'Local Risk' }), 'createCatalogTagGroup')
    expect(draft.pendingSync).toBe(true)
    expect(await rows('outbox')).toEqual([])
    expectWarned(/could not save an offline Tag catalog command .* may never reach the server/, 'QuotaExceededError')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it.each(FAILURES)('a replay whose outbox update fails (%s) wedges neither the flush nor any later Tag page', async (failure) => {
    let tagCreate: Reply = new TypeError('offline')
    serve((method, path) => {
      if (path.endsWith('/tags') && method === 'POST') return tagCreate
      if (path.endsWith('/tags')) return { body: { items: [tag()], nextCursor: null } }
      if (path.endsWith('/tag-operations/events')) return { body: { received: 1, inserted: 1 } }
      return undefined
    })
    await within(offlineTag(), 'createCatalogTag')
    tagCreate = { status: 503, body: { error: 'unavailable', message: 'Try again later.' } }
    vi.stubGlobal('navigator', { onLine: true })

    arm('outbox', failure)
    const page = await within(listTagPage('org-tags'), 'listTagPage')
    expect(page.source).toBe('network')
    // Its earlier copy is still stored, so "held in memory only" would be false.
    expectWarned(/could not record a replay attempt .* stored copy keeps the state it had before/, CAUSE[failure])
    expect(warn).toHaveBeenCalledTimes(1)
    // The failed update was rolled back: the durable command is the one queued,
    // which has never been attempted.
    const durable = await rows<{ attemptCount?: number }>('outbox')
    expect(durable).toHaveLength(1)
    expect(durable[0].attemptCount).toBeUndefined()

    // The flush is memoized while in flight; the next page must run a flush of
    // its own, not join a hung one: its replay records the attempt.
    await within(listTagPage('org-tags'), 'the next listTagPage')
    expect((await rows<{ attemptCount?: number }>('outbox'))[0].attemptCount).toBe(1)
    expect(closed).toBe(opened)
  })

  it.each(FAILURES)('a replayed command whose outbox delete fails (%s) settles, and the command stays queued', async (failure) => {
    let tagCreate: Reply = new TypeError('offline')
    serve((method, path) => (path.endsWith('/tags') && method === 'POST' ? tagCreate : undefined))
    const draft = await within(offlineTag(), 'createCatalogTag')
    tagCreate = { body: { tag: tag({ id: draft.id, value: 'Critical' }) } }

    arm('outbox', failure)
    expect(await within(flushTagCatalogOutbox('org-tags'), 'flushTagCatalogOutbox')).toEqual({ flushed: 1, pending: 1 })
    expectWarned(/could not remove a Tag catalog command/, CAUSE[failure])
    expect(await rows('outbox')).toEqual([expect.objectContaining({ clientId: draft.id })])
    expect(closed).toBe(opened)
  })

  it.each(FAILURES)('an outbox telemetry write that fails (%s) never blocks the creation it describes', async (failure) => {
    serve(() => undefined)
    arm('operations', failure)
    const draft = await within(offlineTag(), 'createCatalogTag')
    expect(await rows('outbox')).toEqual([expect.objectContaining({ clientId: draft.id })])
    expect(await rows('operations')).toEqual([])
    expectWarned(/could not save an outbox telemetry event/, CAUSE[failure])
    expect(closed).toBe(opened)
  })

  it.each(FAILURES)('deleting sent telemetry events that fails (%s) settles the telemetry flush', async (failure) => {
    serve((_method, path) => (path.endsWith('/tag-operations/events') ? { body: { received: 1, inserted: 1 } } : undefined))
    await within(offlineTag(), 'createCatalogTag')
    await within(createCatalogTagGroup('org-tags', { name: 'Local Risk' }), 'createCatalogTagGroup')
    expect(await rows('operations')).toHaveLength(2)

    // Two deletes in one transaction: it fails after the second succeeded.
    arm('operations', failure)
    expect(await within(flushTagOperationEvents('org-tags'), 'flushTagOperationEvents')).toEqual({ flushed: 2, pending: 2 })
    expectWarned(/could not remove sent outbox telemetry events/, CAUSE[failure])
    expect(await rows('operations')).toHaveLength(2)
    expect(closed).toBe(opened)
  })

  it.each(FAILURES)('a catalog cache write that fails (%s) never turns a served page into a hang', async (failure) => {
    serve((_method, path) => (path.endsWith('/tags') ? { body: { items: [tag()], nextCursor: null } } : undefined))
    arm('catalogs', failure)
    const page = await within(listTagPage('org-tags'), 'listTagPage')
    expect(page).toMatchObject({ source: 'network', items: [expect.objectContaining({ id: 'tag-risk-high' })] })
    expect(await rows('catalogs')).toEqual([])
    expectWarned(/catalog results for offline use/, CAUSE[failure])
    expect(closed).toBe(opened)
  })

  it.each(FAILURES)('discarding a draft whose cache removal fails (%s) settles, and says the draft may come back', async (failure) => {
    serve(() => undefined)
    const draft = await within(offlineTag(), 'createCatalogTag')
    arm('catalogs', failure)
    expect(await within(discardTagCatalogOutboxEntry('org-tags', `tag-outbox-${draft.id}`), 'discard')).toBe(true)
    expect(await rows('outbox')).toEqual([])
    expect((await rows<{ tags: CatalogTag[] }>('catalogs'))[0].tags.map((entry) => entry.id)).toEqual([draft.id])
    expectWarned(/local draft from the offline cache/, CAUSE[failure])
    expect(closed).toBe(opened)
  })

  it.each(FAILURES)('a Group mapping whose outbox rewrite fails (%s) settles, and nothing of it is half-written', async (failure) => {
    const existingGroup: CatalogTagGroup = {
      id: 'taggrp-risk', orgId: 'org-tags', name: 'Risk', description: null, iconKey: null,
      lifecycleStatus: 'active', version: 2, createdAt: '', updatedAt: '',
    }
    serve((_method, path) => (path.endsWith('/tag-groups/reconcile-local') ? { body: { group: existingGroup } } : undefined))
    const localGroup = await within(createCatalogTagGroup('org-tags', { name: 'Local Risk' }), 'createCatalogTagGroup')
    await within(createCatalogTag('org-tags', { groupId: localGroup.id, value: 'Critical', color: '#B42318' }), 'createCatalogTag')
    const before = await rows('outbox')

    arm('outbox', failure)
    await expect(within(
      reconcileTagGroupOutboxEntry('org-tags', `tag-outbox-${localGroup.id}`, existingGroup),
      'reconcileTagGroupOutboxEntry',
    )).resolves.toEqual({ group: existingGroup, updatedDependentTags: 1 })
    expectWarned(/Tag Group mapping/, CAUSE[failure])
    expect(await rows('outbox')).toEqual(before)
    expect(closed).toBe(opened)
  })

  it('a Group mapping whose second rewrite throws commits none of the rewrites queued before it', async () => {
    const existingGroup: CatalogTagGroup = {
      id: 'taggrp-risk', orgId: 'org-tags', name: 'Risk', description: null, iconKey: null,
      lifecycleStatus: 'active', version: 2, createdAt: '', updatedAt: '',
    }
    serve((_method, path) => (path.endsWith('/tag-groups/reconcile-local') ? { body: { group: existingGroup } } : undefined))
    const localGroup = await within(createCatalogTagGroup('org-tags', { name: 'Local Risk' }), 'createCatalogTagGroup')
    await within(createCatalogTag('org-tags', { groupId: localGroup.id, value: 'Critical', color: '#B42318' }), 'first tag')
    await within(createCatalogTag('org-tags', { groupId: localGroup.id, value: 'Severe', color: '#B42318' }), 'second tag')
    const before = await rows('outbox')
    expect(before).toHaveLength(3)

    // The mapping's transaction is the only one that puts into the outbox, so
    // its first rewrite is already queued when the second throws.
    throwingPut = { store: 'outbox', remaining: 2 }
    await within(
      reconcileTagGroupOutboxEntry('org-tags', `tag-outbox-${localGroup.id}`, existingGroup),
      'reconcileTagGroupOutboxEntry',
    )
    expect(throwingPut).toBeNull()
    expectWarned(/Tag Group mapping/, 'DataCloneError')
    expect(await rows('outbox')).toEqual(before)
    expect(closed).toBe(opened)
  })
})
