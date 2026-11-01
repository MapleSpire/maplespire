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
 * `transactionDone` settles on the transaction's OUTCOME, on a real IndexedDB
 * (fake-indexeddb). It used to reject on the first `error` event as well,
 * which reported the wrong thing twice: a failed request's cause was lost
 * (`transaction.error` is still null during that dispatch), and an explicit
 * `abort()` with a request pending reported that request's AbortError, which
 * `stopsFallback` in paged.ts reads as a caller's cancellation.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { transactionDone } from './idbSchema'

let db: IDBDatabase

beforeEach(async () => {
  const factory = new IDBFactory()
  db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('transaction-done-test', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('rows') }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
})

async function outcome(promise: Promise<void>): Promise<{ ok: true } | { ok: false; error: any }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('transactionDone did not settle within 1000 ms')), 1_000)
      }),
    ])
    return { ok: true }
  } catch (error) {
    if (error instanceof Error && /did not settle/.test(error.message)) throw error
    return { ok: false, error }
  } finally {
    clearTimeout(timer)
  }
}

async function stored(key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('rows', 'readonly').objectStore('rows').get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** A put whose operation throws `name` when it runs, as a full disk fails it. */
function failingPut(store: any, key: string, name: string): IDBRequest {
  const raw = store._rawObjectStore
  const storeRecord = raw.storeRecord
  raw.storeRecord = () => { throw new DOMException('injected', name) }
  try {
    return store.put('value', key)
  } finally {
    raw.storeRecord = storeRecord
  }
}

describe('transactionDone', () => {
  it('control: resolves once the transaction commits', async () => {
    const tx = db.transaction('rows', 'readwrite')
    tx.objectStore('rows').put('value', 'k')
    expect(await outcome(transactionDone(tx))).toEqual({ ok: true })
    expect(await stored('k')).toBe('value')
  })

  it("rejects with the failed request's own error, not a generic one", async () => {
    const tx = db.transaction('rows', 'readwrite')
    failingPut(tx.objectStore('rows'), 'k', 'QuotaExceededError')
    expect(await outcome(transactionDone(tx))).toMatchObject({ ok: false, error: { name: 'QuotaExceededError' } })
  })

  it('rejects with the abort reason when the transaction aborts at commit, nothing pending', async () => {
    const tx = db.transaction('rows', 'readwrite') as any
    const request = tx.objectStore('rows').put('value', 'k')
    request.addEventListener('success', () => tx._abort('QuotaExceededError'))
    expect(await outcome(transactionDone(tx))).toMatchObject({ ok: false, error: { name: 'QuotaExceededError' } })
    expect(await stored('k')).toBeUndefined()
  })

  it('rejects with the abort reason, not the AbortError of a request it left pending', async () => {
    const tx = db.transaction('rows', 'readwrite') as any
    const store = tx.objectStore('rows')
    const first = store.put('first', 'a')
    store.put('second', 'b')
    first.addEventListener('success', () => tx._abort('QuotaExceededError'))
    expect(await outcome(transactionDone(tx))).toMatchObject({ ok: false, error: { name: 'QuotaExceededError' } })
  })

  it('an explicit abort() with a request still pending rejects with an Error that is not an AbortError', async () => {
    const tx = db.transaction('rows', 'readwrite')
    const store = tx.objectStore('rows')
    const first = store.put('first', 'a')
    store.put('second', 'b')
    // Aborting from the first success leaves the second pending: IndexedDB
    // fires an AbortError at it, which bubbles to the transaction.
    first.addEventListener('success', () => tx.abort())
    const settled = await outcome(transactionDone(tx))
    expect(settled.ok).toBe(false)
    if (settled.ok) return
    expect(settled.error).toBeInstanceOf(Error)
    expect(settled.error.name).not.toBe('AbortError')
    expect(await stored('a')).toBeUndefined()
  })

  it('resolves when a failed request is handled and the transaction goes on to commit', async () => {
    const tx = db.transaction('rows', 'readwrite')
    const store = tx.objectStore('rows')
    const failed = failingPut(store, 'bad', 'ConstraintError')
    failed.addEventListener('error', (event) => event.preventDefault())
    store.put('kept', 'good')
    expect(await outcome(transactionDone(tx))).toEqual({ ok: true })
    expect(await stored('good')).toBe('kept')
  })
})
