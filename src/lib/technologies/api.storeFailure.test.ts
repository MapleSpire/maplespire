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
 * The technology catalog's offline-cache write on a real IndexedDB
 * (fake-indexeddb). Same defect as src/lib/tags/api.storeFailure.test.ts,
 * which explains the three injected failures: the write listened for
 * `complete` and `error` only, so a transaction aborting with nothing pending
 * left the catalog page that awaited it waiting for ever.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  IDBDatabase as FakeIDBDatabase,
  IDBFactory,
  IDBObjectStore as FakeIDBObjectStore,
} from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  listSelectableTechnologyPage,
  resolveSelectableTechnologies,
  type CatalogTechnology,
} from './api'
import { accountDatabaseName } from '../auth/accountNamespace'

type Failure = 'abort' | 'commit-quota' | 'request-error'
const FAILURES: readonly Failure[] = ['abort', 'commit-quota', 'request-error']
const CAUSE: Record<Failure, string | null> = {
  abort: null,
  'commit-quota': 'QuotaExceededError',
  'request-error': 'QuotaExceededError',
}

/** The next readwrite `put` fails this way. */
let armed: Failure | null = null

const originalPut = FakeIDBObjectStore.prototype.put
FakeIDBObjectStore.prototype.put = function (this: any, value: any, key?: any) {
  const failure = armed
  if (!failure || this.transaction.mode !== 'readwrite') return originalPut.call(this, value, key)
  armed = null
  if (failure === 'request-error') {
    const rawStore = this._rawObjectStore
    const storeRecord = rawStore.storeRecord
    rawStore.storeRecord = () => { throw new DOMException('the disk is full', 'QuotaExceededError') }
    try {
      return originalPut.call(this, value, key)
    } finally {
      rawStore.storeRecord = storeRecord
    }
  }
  const request = originalPut.call(this, value, key)
  const transaction = this.transaction
  // The cache write is the transaction's only request: once it has succeeded,
  // nothing is pending, so IndexedDB fires `abort` and no request `error`.
  request.addEventListener('success', () => {
    if (failure === 'abort') transaction.abort()
    else transaction._abort('QuotaExceededError')
  })
  return request
}

let opened = 0
let closed = 0
const originalClose = FakeIDBDatabase.prototype.close
FakeIDBDatabase.prototype.close = function (this: any) {
  closed += 1
  return originalClose.call(this)
}

function within<T>(promise: Promise<T>, what: string, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function cachedRows(): Promise<Array<{ orgId: string; technologies: CatalogTechnology[] }>> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(accountDatabaseName('maplespire-technology-catalog-v2'))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('catalogs', 'readonly').objectStore('catalogs').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

const technology = (id: string): CatalogTechnology => ({
  id,
  scope: 'public',
  lifecycleStatus: 'active',
  revision: {
    revision: 1,
    status: 'approved',
    privateApproved: false,
    name: id,
    description: null,
    aliases: [],
    iconLightPath: null,
    iconDarkPath: null,
    recommendedShapeTypes: [],
    defaultRole: 'service' as CatalogTechnology['revision']['defaultRole'],
  },
  orgState: 'enabled',
  orgOverride: null,
})

function serve(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(String(url), 'http://maplespire.test').pathname
    const body = path.endsWith('/technologies')
      ? { technologies: [technology('tech-postgres')], nextCursor: null, policy: 'all' }
      : { technology: technology(path.split('/').pop() ?? ''), resolution: {} }
    return { ok: true, status: 200, json: async () => body }
  }))
}

let warn: MockInstance<typeof console.warn>

beforeEach(async () => {
  ;(globalThis as any).indexedDB = new IDBFactory()
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

// The module keeps a per-org memory cache for its whole life, so each test
// takes an org of its own: its first read then goes to IndexedDB.
let orgSequence = 0
const freshOrg = () => `org-tech-${++orgSequence}`

afterEach(() => {
  armed = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function expectWarned(cause: string | null): void {
  const reports = warn.mock.calls.filter(([message]) => /technology catalog results for offline use/.test(String(message)))
  expect(reports).toHaveLength(1)
  expect(reports[0][1]).toBeInstanceOf(Error)
  if (cause) expect(reports[0][1]).toMatchObject({ name: cause })
}

describe('technology catalog cache write settles when its transaction fails', () => {
  it('control: with nothing injected, a served page lands in the offline cache', async () => {
    serve()
    const page = await within(listSelectableTechnologyPage(freshOrg()), 'listSelectableTechnologyPage')
    expect(page.source).toBe('network')
    expect((await cachedRows()).map((row) => row.technologies.map((entry) => entry.id))).toEqual([['tech-postgres']])
    expect(warn).not.toHaveBeenCalled()
    expect(closed).toBe(opened)
  })

  it.each(FAILURES)('a served page whose cache write fails (%s) is still served, and says so', async (failure) => {
    serve()
    armed = failure
    const page = await within(listSelectableTechnologyPage(freshOrg()), 'listSelectableTechnologyPage')
    expect(page).toMatchObject({ source: 'network', technologies: [expect.objectContaining({ id: 'tech-postgres' })] })
    expect(await cachedRows()).toEqual([])
    expectWarned(CAUSE[failure])
    expect(closed).toBe(opened)
  })

  it.each(FAILURES)('resolving selected ids whose cache write fails (%s) still resolves them', async (failure) => {
    serve()
    armed = failure
    const result = await within(resolveSelectableTechnologies(freshOrg(), ['tech-redis']), 'resolveSelectableTechnologies')
    expect(result).toMatchObject({ source: 'network', technologies: [expect.objectContaining({ id: 'tech-redis' })] })
    expect(await cachedRows()).toEqual([])
    expectWarned(CAUSE[failure])
    expect(closed).toBe(opened)
  })
})
