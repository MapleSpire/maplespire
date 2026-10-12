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
  resolve: (heads: readonly string[]) => void
  reject: (error: Error) => void
}

/** One isolate and one transferred document at a time per server process.
 * SQL reads stay outside this queue: a suspended query in one workspace must
 * not prevent another workspace from using a free decoder. Waiting callers
 * retain their SQL chunks; neither those callers nor the size of a single
 * document is bounded by this queue.
 * No overload rejection: a quiet document must not lose its final projection.
 */
export class DurableHeadsDecoder {
  private tail: Promise<void> = Promise.resolve()
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
    if (this.closed) throw new Error('durable heads decoder closed')
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      if (this.closed) throw new Error('durable heads decoder closed')
      return await this.request(documentId, chunks)
    } finally {
      release()
    }
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

  private async request(documentId: string, chunks: readonly Uint8Array[]): Promise<readonly string[]> {
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
            ? heads !== undefined
            : result.error !== undefined || !Array.isArray(heads) || !heads.every(h => typeof h === 'string'))) {
          this.retire(worker, new Error('invalid durable heads worker response'))
          return
        }
        this.pending = null
        worker.unref()
        if (typeof result.error === 'string') pending.reject(new Error(result.error))
        else pending.resolve([...(heads as string[])])
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
    return new Promise<readonly string[]>((resolve, reject) => {
      this.pending = { id, documentId, resolve, reject }
      worker.ref()
      try { worker.postMessage({ id, documentId, bytes }, [bytes.buffer]) }
      catch (error) { this.retire(worker, error instanceof Error ? error : new Error(String(error))) }
    })
  }
}

export const durableHeadsDecoder = new DurableHeadsDecoder()
