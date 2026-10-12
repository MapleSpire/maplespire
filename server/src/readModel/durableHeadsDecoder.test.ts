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

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { setImmediate as turn } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import * as A from '@automerge/automerge'
import { DurableHeadsDecoder, durableHeadsDecoder } from './durableHeadsDecoder.js'
import { prepareDocumentWatermarkProofs } from './arrivalWatermark.js'
import type { Queryable } from './types.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

type Request = { id: number; documentId: string; bytes: Uint8Array }
class ControlledWorker extends EventEmitter {
  requests: { request: Request; transfer: readonly ArrayBuffer[] }[] = []
  referenced = false
  terminations = 0
  termination = deferred<number>()
  postError: Error | null = null
  ref() { this.referenced = true; return this }
  unref() { this.referenced = false; return this }
  postMessage(request: Request, transfer: readonly ArrayBuffer[]) {
    if (this.postError) throw this.postError
    this.requests.push({ request, transfer })
  }
  terminate() { this.terminations++; return this.termination.promise }
  answer(heads: string[] = ['head']) {
    const { id, documentId } = this.requests.at(-1)!.request
    this.emit('message', { id, documentId, heads })
  }
}

const decoders = new Set<DurableHeadsDecoder>()
const controlled = new Set<ControlledWorker>()
function decoder(factory?: () => Worker) {
  const value = new DurableHeadsDecoder(factory)
  decoders.add(value)
  return value
}
function fake() {
  const worker = new ControlledWorker()
  controlled.add(worker)
  return worker
}
function asWorker(worker: ControlledWorker) { return worker as unknown as Worker }
function observe<T>(promise: Promise<T>) {
  let settled = false
  const result = promise.then(value => { settled = true; return { ok: true as const, value } }, error => {
    settled = true
    return { ok: false as const, error: error as Error }
  })
  return { result, settled: () => settled }
}
afterEach(async () => {
  for (const worker of controlled) worker.termination.resolve(1)
  await Promise.allSettled([...decoders].map(value => value.close()))
  decoders.clear()
  controlled.clear()
  vi.restoreAllMocks()
})
afterAll(async () => { await durableHeadsDecoder.close() })

function revisions() {
  const h0 = A.from({ value: 0 })
  // Save before admitting any later change. A.save(old view) on a shared WASM
  // document can already include a future revision; that fixture hides bugs.
  const snapshot = A.save(h0)
  const heads0 = [...A.getHeads(h0)]
  const h1 = A.change(A.clone(h0), doc => { doc.value = 1 })
  const increment1 = A.saveSince(h1, heads0)
  const heads1 = [...A.getHeads(h1)]
  const h2 = A.change(A.clone(h1), doc => { doc.value = 2 })
  const increment2 = A.saveSince(h2, heads1)
  const heads2 = [...A.getHeads(h2)]
  A.free(h0); A.free(h1); A.free(h2)
  return { snapshot, increment1, increment2, heads0, heads1, heads2 }
}

describe('DurableHeadsDecoder real source worker', () => {
  it('initializes with the real empty decode and reuses that worker for durable document proofs', async () => {
    const factory = vi.fn(() => new Worker(new URL('./durableHeadsWorker.mjs', import.meta.url)))
    const value = decoder(factory)
    await value.initialize()
    const f = revisions()
    expect(await value.decode('after-initialization', [f.snapshot, f.increment1, f.increment2])).toEqual(f.heads2)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('decodes a saved snapshot and complete incremental chain through one reusable worker', async () => {
    const value = decoder()
    const f = revisions()
    expect(await value.decode('snapshot', [f.snapshot])).toEqual(f.heads0)
    expect(await value.decode('incrementals', [f.snapshot, f.increment1, f.increment2])).toEqual(f.heads2)
    expect(await value.decode('earlier', [f.snapshot, f.increment1])).toEqual(f.heads1)
  })

  it('rejects missing dependencies and then accepts the repaired chain on the same worker', async () => {
    const value = decoder()
    const f = revisions()
    await expect(value.decode('incomplete', [f.snapshot, f.increment2])).rejects.toThrow('incomplete durable document dependencies: incomplete')
    expect(await value.decode('repaired', [f.snapshot, f.increment1, f.increment2])).toEqual(f.heads2)
  })

  it('rejects malformed bytes without returning an empty proof or poisoning later documents', async () => {
    const value = decoder()
    const f = revisions()
    await expect(value.decode('corrupt', [new Uint8Array([1, 2, 3, 4])])).rejects.toThrow()
    expect(await value.decode('good', [f.snapshot])).toEqual(f.heads0)
  })

  it('copies exact view slices without detaching SQL row buffers or leaking slab bytes', async () => {
    const value = decoder()
    const f = revisions()
    const chunks = [f.snapshot, f.increment1, f.increment2].map(bytes => {
      const slab = Buffer.alloc(bytes.length + 35, 0xa7)
      slab.set(bytes, 13)
      return { slab, before: Buffer.from(slab), view: slab.subarray(13, 13 + bytes.length) }
    })
    expect(await value.decode('slab', chunks.map(chunk => chunk.view))).toEqual(f.heads2)
    for (const chunk of chunks) {
      expect(chunk.slab.equals(chunk.before)).toBe(true)
      expect(chunk.view.byteLength).toBe(chunk.before.length - 35)
    }
  })

  it('does not transfer ownership of a caller single exact-size backing buffer', async () => {
    const value = decoder()
    const f = revisions()
    const source = Uint8Array.from(f.snapshot)
    const before = Uint8Array.from(source)
    expect(await value.decode('single-owned-buffer', [source])).toEqual(f.heads0)
    expect(source.byteLength).toBe(before.byteLength)
    expect(source).toEqual(before)
  })

  it('processes a concurrent mixed document queue without swapping results', async () => {
    const value = decoder()
    const f = revisions()
    const results = await Promise.all([
      value.decode('a', [f.snapshot]),
      value.decode('b', [f.snapshot, f.increment1]),
      value.decode('c', [f.snapshot, f.increment1, f.increment2]),
    ])
    expect(results).toEqual([f.heads0, f.heads1, f.heads2])
  })
})

describe('DurableHeadsDecoder ownership and transport', () => {
  it('waits for the actual empty decode response before initialization completes', async () => {
    const worker = fake()
    const value = decoder(() => asWorker(worker))
    const initialized = observe(value.initialize())
    await turn()
    expect(worker.requests).toHaveLength(1)
    expect(worker.requests[0].request.bytes.byteLength).toBe(0)
    worker.emit('online')
    await turn()
    expect(initialized.settled()).toBe(false)
    worker.answer([])
    expect(await initialized.result).toEqual({ ok: true, value: undefined })
    expect(worker.referenced).toBe(false)
  })

  it('refuses a nonempty initialization response', async () => {
    const worker = fake()
    const value = decoder(() => asWorker(worker))
    const initialized = observe(value.initialize())
    await turn()
    worker.answer(['unexpected-head'])
    const result = await initialized.result
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('initialization returned nonempty heads')
  })

  it('propagates the initialization decode failure', async () => {
    const worker = fake()
    const value = decoder(() => asWorker(worker))
    const initialized = observe(value.initialize())
    await turn()
    const { id, documentId } = worker.requests[0].request
    worker.emit('message', { id, documentId, error: 'initialization failed' })
    const result = await initialized.result
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe('initialization failed')
  })

  it('joins worker termination and rejects an initialization interrupted by close', async () => {
    const worker = fake()
    const value = decoder(() => asWorker(worker))
    const initialized = observe(value.initialize())
    await turn()
    const closed = observe(value.close())
    await turn()
    expect(worker.terminations).toBe(1)
    expect(initialized.settled()).toBe(false)
    expect(closed.settled()).toBe(false)
    worker.termination.resolve(1)
    const result = await initialized.result
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe('durable heads decoder closed')
    expect(await closed.result).toEqual({ ok: true, value: undefined })
  })

  it('admits only one decode, copies one dedicated transferable, and releases the queue after each response', async () => {
    const worker = fake()
    const value = decoder(() => asWorker(worker))
    const first = value.decode('a', [new Uint8Array([1, 2]), new Uint8Array([3])])
    const second = value.decode('b', [new Uint8Array([4])])
    await turn()
    expect(worker.requests).toHaveLength(1)
    const { request, transfer } = worker.requests[0]
    expect([...request.bytes]).toEqual([1, 2, 3])
    expect(request.bytes.byteOffset).toBe(0)
    expect(request.bytes.buffer.byteLength).toBe(3)
    expect(transfer).toEqual([request.bytes.buffer])
    expect(worker.referenced).toBe(true)
    worker.answer(['one'])
    expect(await first).toEqual(['one'])
    await turn()
    expect(worker.requests).toHaveLength(2)
    expect(worker.requests[1].request.id).not.toBe(request.id)
    worker.answer(['two'])
    expect(await second).toEqual(['two'])
    expect(worker.referenced).toBe(false)
  })

  it('releases the queue after a worker constructor throws', async () => {
    const worker = fake()
    let attempts = 0
    const value = decoder(() => { if (++attempts === 1) throw new Error('constructor failed'); return asWorker(worker) })
    await expect(value.decode('a', [])).rejects.toThrow('constructor failed')
    const second = value.decode('b', [])
    await turn()
    expect(attempts).toBe(2)
    worker.answer()
    expect(await second).toEqual(['head'])
  })

  it('returns worker decode errors without inventing successful heads and keeps that worker usable', async () => {
    const worker = fake()
    let spawned = 0
    const value = decoder(() => { spawned++; return asWorker(worker) })
    const first = observe(value.decode('a', []))
    await turn()
    const { id, documentId } = worker.requests[0].request
    worker.emit('message', { id, documentId, error: 'bad document' })
    expect(await first.result).toMatchObject({ ok: false, error: { message: 'bad document' } })
    const second = value.decode('b', [])
    await turn()
    worker.answer()
    expect(await second).toEqual(['head'])
    expect(spawned).toBe(1)
    expect(worker.terminations).toBe(0)
  })

  const invalidResponses: [string, (request: Request) => unknown][] = [
    ['wrong request id', request => ({ ...request, id: request.id + 1, heads: [] })],
    ['wrong document id', request => ({ ...request, documentId: 'foreign', heads: [] })],
    ['non-string head', request => ({ ...request, heads: [42] })],
    ['absent heads', request => ({ id: request.id, documentId: request.documentId })],
    ['heads plus error', request => ({ ...request, heads: [], error: 'bad' })],
    ['invalid error type', request => ({ ...request, heads: [], error: true })],
    ['null response', () => null],
  ]
  it.each(invalidResponses)('retires %s and waits for termination before replacement', async (_label, makeResponse) => {
    const old = fake()
    const fresh = fake()
    let spawned = 0
    const value = decoder(() => asWorker(++spawned === 1 ? old : fresh))
    const first = observe(value.decode('a', []))
    const second = observe(value.decode('b', []))
    await turn()
    old.emit('message', makeResponse(old.requests[0].request))
    await turn()
    expect(old.terminations).toBe(1)
    expect(first.settled()).toBe(false)
    expect(second.settled()).toBe(false)
    expect(spawned).toBe(1)
    old.termination.resolve(1)
    expect(await first.result).toMatchObject({ ok: false })
    await turn()
    expect(spawned).toBe(2)
    fresh.answer(['replacement'])
    expect(await second.result).toEqual({ ok: true, value: ['replacement'] })
  })

  it.each(['error', 'messageerror', 'exit'] as const)('rejects %s, joins retirement, and ignores stale events after replacement', async event => {
    const old = fake()
    const fresh = fake()
    let spawned = 0
    const value = decoder(() => asWorker(++spawned === 1 ? old : fresh))
    const first = observe(value.decode('a', []))
    const second = observe(value.decode('b', []))
    await turn()
    old.emit(event, event === 'exit' ? 0 : new Error(`${event} failure`))
    await turn()
    expect(first.settled()).toBe(false)
    expect(spawned).toBe(1)
    old.termination.resolve(0)
    expect(await first.result).toMatchObject({ ok: false })
    await turn()
    old.emit('error', new Error('late old error'))
    old.emit('exit', 9)
    old.emit('message', { id: 999, documentId: 'old', heads: [] })
    expect(fresh.terminations).toBe(0)
    fresh.answer(['fresh'])
    expect(await second.result).toEqual({ ok: true, value: ['fresh'] })
  })

  it('joins failed postMessage before rejecting and can create a replacement', async () => {
    const old = fake()
    old.postError = new Error('transport failed')
    const fresh = fake()
    let spawned = 0
    const value = decoder(() => asWorker(++spawned === 1 ? old : fresh))
    const first = observe(value.decode('a', []))
    const second = observe(value.decode('b', []))
    await turn()
    expect(old.terminations).toBe(1)
    expect(first.settled()).toBe(false)
    old.termination.resolve(1)
    expect(await first.result).toMatchObject({ ok: false, error: { message: 'transport failed' } })
    await turn()
    fresh.answer()
    expect(await second.result).toEqual({ ok: true, value: ['head'] })
  })

  it('blocks respawn when termination rejects, including later callers and close', async () => {
    const worker = fake()
    let spawned = 0
    const value = decoder(() => { spawned++; return asWorker(worker) })
    const first = observe(value.decode('a', []))
    const second = observe(value.decode('b', []))
    await turn()
    worker.emit('error', new Error('worker failed'))
    worker.termination.reject(new Error('cannot join worker'))
    expect(await first.result).toMatchObject({ ok: false, error: { message: 'durable heads worker termination failed' } })
    expect(await second.result).toMatchObject({ ok: false, error: { message: 'cannot join worker' } })
    await expect(value.decode('c', [])).rejects.toThrow('cannot join worker')
    await expect(value.close()).rejects.toThrow('cannot join worker')
    expect(spawned).toBe(1)
  })

  it('close is terminal, joins active work, rejects queued work, and terminates once', async () => {
    const worker = fake()
    const value = decoder(() => asWorker(worker))
    const active = observe(value.decode('a', []))
    const queued = observe(value.decode('b', []))
    await turn()
    const closing = observe(value.close())
    const duplicateClose = observe(value.close())
    await turn()
    expect(worker.terminations).toBe(1)
    expect(closing.settled()).toBe(false)
    await expect(value.decode('new', [])).rejects.toThrow('closed')
    worker.termination.resolve(1)
    expect(await active.result).toMatchObject({ ok: false, error: { message: 'durable heads decoder closed' } })
    expect(await queued.result).toMatchObject({ ok: false, error: { message: 'durable heads decoder closed' } })
    expect(await closing.result).toEqual({ ok: true, value: undefined })
    expect(await duplicateClose.result).toEqual({ ok: true, value: undefined })
    expect(worker.requests).toHaveLength(1)
  })

  it('close before the queue starts creates no worker', async () => {
    let spawned = 0
    const value = decoder(() => { spawned++; return asWorker(fake()) })
    const first = observe(value.decode('a', []))
    await value.close()
    expect(await first.result).toMatchObject({ ok: false })
    expect(spawned).toBe(0)
  })

  it('a queued decode observes close without waiting for an idle worker retirement', async () => {
    const worker = fake()
    const value = decoder(() => asWorker(worker))
    const warm = value.decode('warm', [])
    await turn()
    worker.answer()
    expect(await warm).toEqual(['head'])
    // The idle isolate produces an unsolicited response, so retirement starts
    // without owning any decode reservation. Its terminate is held below.
    worker.emit('message', { unsolicited: true })
    const waiting = observe(value.decode('not-yet-started', []))
    const closing = observe(value.close())
    try {
      await turn()
      expect(worker.terminations).toBe(1)
      expect(closing.settled()).toBe(false)
      expect(waiting.settled()).toBe(true)
      expect(await waiting.result).toMatchObject({ ok: false, error: { message: 'durable heads decoder closed' } })
      expect(worker.requests).toHaveLength(1)
    } finally {
      worker.termination.resolve(1)
      await closing.result
      await waiting.result
    }
  })
})

describe('prepareDocumentWatermarkProofs uses the real decoder', () => {
  function database(rows: { document_id: string; data: unknown }[], onRead: () => Promise<void> = async () => {}) {
    const statements: string[] = []
    const query = async (sql: string) => {
      statements.push(sql)
      if (sql.includes('nextval')) return { rows: [{ w: '9007199254740999' }] }
      await onRead()
      return { rows }
    }
    return { db: { query } as unknown as Queryable, statements }
  }
  const target = (documentId: string) => ({ documentId, drainPendingSaves: async () => {} })

  it('certifies actual reconstructed heads, retains bigint text, and omits absent documents', async () => {
    // Observe the real production transport. A synchronous inline replacement
    // returning the same heads must not silently erase this off-thread wire.
    const transported = vi.spyOn(Worker.prototype, 'postMessage')
    const f = revisions()
    const { db, statements } = database([
      { document_id: 'a', data: Buffer.from(f.snapshot) },
      { document_id: 'a', data: Buffer.from(f.increment1) },
    ])
    const result = await prepareDocumentWatermarkProofs(db, [target('a'), target('missing')])
    expect(result.watermarkPost).toBe('9007199254740999')
    expect([...result.durableHeadsById]).toEqual([['a', f.heads1]])
    expect(statements).toHaveLength(2)
    expect(transported.mock.calls.filter(([request]) => request.documentId === 'a')).toHaveLength(1)
  })

  it('propagates worker missing-dependency refusal and recovers on repaired SQL content', async () => {
    const f = revisions()
    const rows = [{ document_id: 'a', data: f.snapshot }, { document_id: 'a', data: f.increment2 }]
    const { db } = database(rows)
    await expect(prepareDocumentWatermarkProofs(db, [target('a')])).rejects.toThrow('incomplete durable document dependencies')
    rows.splice(1, 0, { document_id: 'a', data: f.increment1 })
    expect((await prepareDocumentWatermarkProofs(db, [target('a')])).durableHeadsById.get('a')).toEqual(f.heads2)
  })

  it('refuses a non-byte SQL chunk before it can become a successful proof', async () => {
    const { db } = database([{ document_id: 'a', data: 'not bytes' }])
    await expect(prepareDocumentWatermarkProofs(db, [target('a')])).rejects.toThrow('invalid durable chunk bytes: a')
  })

  it('does not hold the decoder while another workspace SQL read is suspended', async () => {
    const f = revisions()
    const entered = deferred()
    const release = deferred()
    const slowDb = database([{ document_id: 'slow', data: f.snapshot }], async () => { entered.resolve(); await release.promise })
    const fastDb = database([{ document_id: 'fast', data: f.snapshot }])
    const slow = prepareDocumentWatermarkProofs(slowDb.db, [target('slow')])
    await entered.promise
    try {
      const fast = await prepareDocumentWatermarkProofs(fastDb.db, [target('fast')])
      expect(fast.durableHeadsById.get('fast')).toEqual(f.heads0)
    } finally { release.resolve() }
    expect((await slow).durableHeadsById.get('slow')).toEqual(f.heads0)
  })
})
