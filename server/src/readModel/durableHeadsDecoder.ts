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

import { Worker } from 'node:worker_threads'

type Pending = {
  id: number
  documentId: string
  /** The top-level field asked for (`decodeField`), or undefined. */
  field: string | undefined
  resolve: (result: DecodedDocument) => void
  reject: (error: Error) => void
}

/** A strict decode: its heads, and — when a field was asked for — that
 * field's value as JSON text (`"null"` when the document has none). */
export interface DecodedDocument {
  heads: readonly string[]
  json?: string
}

/** The worker ANSWERED with a failure: `refused` — the strict load or its
 * dependency check rejected the bytes; `serialize` — the bytes decoded but
 * the asked field has no JSON form (a BigInt). Any other rejection of a
 * decode (a crashed or closed worker, an invalid response, a `transient`
 * answer — out of memory, `durableDecodeFailure.mjs` — or a
 * wait given up, {@link DecodeWaitAbandoned}) is never this class. */
export class DurableDecodeError extends Error {
  constructor(message: string, readonly kind: 'refused' | 'serialize') {
    super(message)
    this.name = 'DurableDecodeError'
  }
}

/** The worker answered `transient` (out of memory, `durableDecodeFailure.mjs`):
 * nothing is known about the bytes. Deliberately NOT a
 * {@link DurableDecodeError}, so no caller remembers it as a refusal; its own
 * class so the foreground proof can count it (`arrivalWatermark.ts`,
 * TRANSIENT_DECODE_LIMIT). */
export class DurableDecodeTransientError extends Error {
  constructor(message: string) {
    super(`durable heads worker failed transiently: ${message}`)
    this.name = 'DurableDecodeTransientError'
  }
}

/** A caller gave up WAITING for the decoder (`DecodeWait`): it never held a
 * reservation, its bytes were never sent, nothing about them is known. */
export class DecodeWaitAbandoned extends Error {
  constructor(readonly reason: 'aborted' | 'timeout') {
    super(reason === 'aborted' ? 'durable heads decode wait aborted' : 'durable heads decode wait timed out')
    this.name = 'DecodeWaitAbandoned'
  }
}

/** The longest delay a Node timer honours: 2^31 - 1 ms. A larger one is
 * replaced by 1 ms, with a `TimeoutOverflowWarning` (measured: without the
 * clamp, `durableHeadsDecoder.test.ts`'s `maxWaitMs = 2^31 + 10` waiter gives
 * up within its first 100 ms), so a `maxWaitMs` beyond it is
 * clamped to it — about 24.8 days, i.e. "no deadline" in practice. */
export const MAX_TIMER_MS = 2 ** 31 - 1

/** Bounds on the wait for a reservation (not on the decode itself, which is
 * never interrupted): `signal` aborts it, `maxWaitMs` gives it up (clamped
 * to [0, {@link MAX_TIMER_MS}]; NaN and ±Infinity are refused with a
 * `RangeError` before anything is reserved — omit it for no deadline). */
export interface DecodeWait {
  signal?: AbortSignal
  maxWaitMs?: number
}

/** Who is waiting for the decoder. `background` (the sealed-product cache
 * writer, G4-16f) is served only when no `foreground` caller (a projection's
 * durable proof) is waiting: it yields at every reservation, never in the
 * middle of a decode. */
export type DecodePriority = 'foreground' | 'background'

/** One isolate and one transferred document at a time per server process.
 * SQL reads stay outside this queue: a suspended query in one workspace must
 * not prevent another workspace from using a free decoder. Waiting callers
 * retain their SQL chunks; neither those callers nor the size of a single
 * document is bounded by this queue — except a caller that passes a
 * {@link DecodeWait} (the sealed-product cache writer does), whose wait its
 * abort signal or deadline ends, dropping its chunks with it.
 * No overload rejection: a quiet document must not lose its final projection.
 */
export class DurableHeadsDecoder {
  /** A reservation is held (one decode at a time). */
  private busy = false
  /** Waiting reservations, FIFO within each priority. */
  private readonly waiting: Record<DecodePriority, Array<() => void>> = { foreground: [], background: [] }
  private worker: Worker | null = null
  private retirement: Promise<void> = Promise.resolve()
  private pending: Pending | null = null
  private nextId = 0
  private closed = false

  constructor(private readonly createWorker: () => Worker = () =>
    new Worker(new URL('./durableHeadsWorker.mjs', import.meta.url))) {}

  /** Exercise the actual load/check/free path before accepting server work.
   * This creates no Repo document or SQL state. A replacement worker after a
   * crash is cold again; readiness is deliberately not cached separately.
   */
  async initialize(): Promise<void> {
    const heads = await this.decode('decoder-initialization', [])
    if (heads.length !== 0) throw new Error('durable heads decoder initialization returned nonempty heads')
  }

  async decode(documentId: string, chunks: readonly Uint8Array[]): Promise<readonly string[]> {
    return (await this.reserve(documentId, chunks, undefined)).heads
  }

  /** The same strict decode, plus `field`'s value as JSON text, copied in
   * the worker (G4-16f: a sealed product's entity map, `sealedProductCache`). */
  async decodeField(
    documentId: string,
    chunks: readonly Uint8Array[],
    field: string,
    priority: DecodePriority = 'foreground',
    wait?: DecodeWait,
  ): Promise<{ heads: readonly string[]; json: string }> {
    const result = await this.reserve(documentId, chunks, field, priority, wait)
    if (typeof result.json !== 'string') throw new Error('durable heads worker returned no field')
    return { heads: result.heads, json: result.json }
  }

  /** Foreground callers queued, background callers queued (tests, telemetry). */
  get queued(): { foreground: number; background: number } {
    return { foreground: this.waiting.foreground.length, background: this.waiting.background.length }
  }

  private async reserve(
    documentId: string,
    chunks: readonly Uint8Array[],
    field: string | undefined,
    priority: DecodePriority = 'foreground',
    wait?: DecodeWait,
  ): Promise<DecodedDocument> {
    if (this.closed) throw new Error('durable heads decoder closed')
    // Explicit, before anything is reserved: `Math.max(0, NaN)` is NaN, and
    // a NaN delay is a 1 ms timer — a waiter that gives up at once while
    // its caller believes it set a bound. ±Infinity is refused with it: "no
    // deadline" is spelled by leaving `maxWaitMs` out.
    if (wait?.maxWaitMs !== undefined && !Number.isFinite(wait.maxWaitMs)) {
      throw new RangeError(`DecodeWait.maxWaitMs must be a finite number of milliseconds (got ${String(wait.maxWaitMs)}); `
        + 'omit it for no deadline')
    }
    if (wait?.signal?.aborted) throw new DecodeWaitAbandoned('aborted')
    if (this.busy) await this.enqueue(priority, wait)
    else {
      this.busy = true
      // One turn even when free, as a queue does: a close() issued right
      // after this call is seen by the check below, before any worker wait.
      await Promise.resolve()
    }
    try {
      if (this.closed) throw new Error('durable heads decoder closed')
      return await this.request(documentId, chunks, field)
    } finally {
      // Handed straight to the next waiter (`busy` stays true), foreground
      // first: a background caller can never overtake a waiting projection.
      const next = this.waiting.foreground.shift() ?? this.waiting.background.shift()
      if (next) next()
      else this.busy = false
    }
  }

  /** Wait for the reservation the decode in flight hands over. With `wait`,
   * an abort or the deadline REMOVES the waiter from its queue and rejects
   * with {@link DecodeWaitAbandoned}: it never held the reservation, so the
   * hand-over in `reserve`'s `finally` can never reach it (it is no longer
   * in the queue). A waiter already handed the reservation ignores both. */
  private enqueue(priority: DecodePriority, wait: DecodeWait | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const queue = this.waiting[priority]
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        wait?.signal?.removeEventListener('abort', onAbort)
      }
      const entry = () => { cleanup(); resolve() }
      const abandon = (reason: 'aborted' | 'timeout') => {
        const at = queue.indexOf(entry)
        // Unreachable today: the hand-over (`entry`) and the first abandon
        // both run `cleanup`, which clears the timer and removes the
        // listener, so neither can call this a second time. Kept because
        // the cost of being wrong is `splice(-1, 1)` — removing ANOTHER
        // waiter, which then waits for ever.
        if (at < 0) return
        queue.splice(at, 1)
        cleanup()
        reject(new DecodeWaitAbandoned(reason))
      }
      const onAbort = () => abandon('aborted')
      queue.push(entry)
      if (wait?.maxWaitMs !== undefined) {
        timer = setTimeout(() => abandon('timeout'), Math.min(Math.max(0, wait.maxWaitMs), MAX_TIMER_MS))
        timer.unref?.()
      }
      // No re-check after registering: `reserve` refused an aborted signal
      // synchronously before calling this, and this executor runs in the
      // same synchronous turn, so no abort can land between the two
      // (that precondition is what makes the missing re-check safe).
      wait?.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Terminal and idempotent. Observe worker termination; this does not cancel
   * a caller's SQL query, which never holds a decoder reservation.
   */
  async close(): Promise<void> {
    this.closed = true
    if (this.worker) this.retire(this.worker, new Error('durable heads decoder closed'))
    await this.retirement
  }

  private retire(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    const pending = this.pending
    this.pending = null
    // Do not start a replacement while the former isolate can still run.
    // A failed termination keeps retirement rejected and prevents respawn.
    this.retirement = Promise.resolve().then(() => worker.terminate()).then(() => undefined)
    void this.retirement.then(
      () => pending?.reject(error),
      terminationError => pending?.reject(new Error('durable heads worker termination failed', { cause: terminationError })),
    )
  }

  private async request(documentId: string, chunks: readonly Uint8Array[], field: string | undefined): Promise<DecodedDocument> {
    await this.retirement
    if (this.closed) throw new Error('durable heads decoder closed')
    if (this.pending) throw new Error('concurrent decode inside one durable heads reservation')
    if (!this.worker) {
      const worker = this.createWorker()
      this.worker = worker
      worker.on('message', (message: unknown) => {
        if (this.worker !== worker) return
        const pending = this.pending
        if (!pending || typeof message !== 'object' || message === null) {
          this.retire(worker, new Error('unexpected durable heads worker response'))
          return
        }
        const result = message as Record<string, unknown>
        const heads = result.heads
        if (result.id !== pending.id || result.documentId !== pending.documentId
          || (typeof result.error === 'string'
            ? heads !== undefined || result.json !== undefined
              || (result.errorKind !== undefined && result.errorKind !== 'refused' && result.errorKind !== 'serialize'
                && result.errorKind !== 'transient')
              || (result.trapped !== undefined && typeof result.trapped !== 'boolean')
            : result.error !== undefined || !Array.isArray(heads) || !heads.every(h => typeof h === 'string')
              // A field asked for comes back as text; none asked, none back.
              || (pending.field === undefined ? result.json !== undefined : typeof result.json !== 'string'))) {
          this.retire(worker, new Error('invalid durable heads worker response'))
          return
        }
        if (result.errorKind === 'transient') {
          // Out of memory: nothing decided about the bytes (a plain Error,
          // never a DurableDecodeError, so no caller remembers it), and an
          // isolate that ran out is not reused.
          this.retire(worker, new DurableDecodeTransientError(String(result.error)))
          return
        }
        this.pending = null
        worker.unref()
        if (typeof result.error === 'string') {
          pending.reject(new DurableDecodeError(result.error, result.errorKind === 'serialize' ? 'serialize' : 'refused'))
          // A wasm trap on these bytes is their refusal (`durableDecodeFailure.mjs`),
          // but the module that trapped is not trusted with the next document:
          // the next decode starts a fresh isolate. `pending` is already
          // cleared, so the retirement rejects nothing.
          if (result.trapped === true) this.retire(worker, new Error('durable heads worker retired after a wasm trap'))
        }
        else pending.resolve(pending.field === undefined
          ? { heads: [...(heads as string[])] }
          : { heads: [...(heads as string[])], json: result.json as string })
      })
      worker.on('error', error => this.retire(worker, error))
      worker.on('messageerror', error => this.retire(worker, error))
      worker.on('exit', code => this.retire(worker, new Error(`durable heads worker exited with code ${code}`)))
      worker.unref()
    }
    const worker = this.worker
    // pg Buffers may be views into shared slabs. Transfer only this dedicated
    // exact-size copy; never detach or clone the backing slab of a SQL row.
    const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const id = ++this.nextId
    return new Promise<DecodedDocument>((resolve, reject) => {
      this.pending = { id, documentId, field, resolve, reject }
      worker.ref()
      try { worker.postMessage(field === undefined ? { id, documentId, bytes } : { id, documentId, bytes, field }, [bytes.buffer]) }
      catch (error) { this.retire(worker, error instanceof Error ? error : new Error(String(error))) }
    })
  }
}

export const durableHeadsDecoder = new DurableHeadsDecoder()
