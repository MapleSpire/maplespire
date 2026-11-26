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
 * THE SEALED-PRODUCT EXTRACT CACHE (G4-16f). A derived, rebuildable copy of
 * each sealed fold product's entity map, keyed by the EXACT durable row
 * versions it was decoded from.
 *
 * Why: a cold build on an aged corpus spends most of its time loading sealed
 * fold products through Automerge — 426 products x ~250 ms on the high
 * corpus at 3 years (G4-16f measurement, `read_model.cold_build_phases`
 * sealedProductsMs). A sealed product never changes once written (a change
 * degrades it), so the map read once can be read back from SQL.
 *
 * The documents stay the source. Every row of these tables may be deleted at
 * any moment (the cold build keeps them; GC, prune and a rebuild may drop
 * them); a missing or stale row costs a document load, never a wrong row.
 *
 * Tables (`schema.ts`): `read_model_sealed_product_extracts` (one header per
 * product: `rows_digest`, `heads`, `max_arrival_seq`, `extraction_version`,
 * `entity_count`, `refused_reason`) and `read_model_sealed_product_entities`
 * (one row per entity, ON DELETE CASCADE from its header).
 *
 * WHAT A HIT TRUSTS, and what nothing here checks:
 *  - `rows_digest` has NO scope. It is the sha256 of the (key, arrival_seq,
 *    octet length) triples of S (`sealedRowsDigest(rowVersionSet(...))`),
 *    unlike the durable-heads memo's row versions, which carry the table's
 *    `<database oid>:<tableoid>` (`durableHeadsMemo.ts`, THE SCOPE). So an
 *    `automerge_storage` dropped and recreated with a restarted sequence
 *    while these tables survive could show a header the same triples over
 *    other bytes. What still separates them is that the keys are content
 *    addressed: an incremental chunk's key is the sha256 of its bytes and a
 *    snapshot's the sha256 of its heads (automerge-repo
 *    `dist/storage/StorageSubsystem.js`, the `[documentId, "incremental",
 *    keyHash(binary)]` and `[documentId, "snapshot", headsHash(heads)]` keys;
 *    `keyHash.js`), so an equal key names equal content. Nothing else does;
 *  - a hit's HEADS are the header's (`readSealedProductCacheHits` returns
 *    `heads` as stored) and are trusted, not re-derived: the one writer
 *    wrote them from its own strict decode of S, header and entities in ONE
 *    transaction (`SealedProductCacheWriter.write`, `withAtomicStatements`),
 *    and the cold build hands them to the memo against S
 *    (`projectorService.ts`, `readCachedShard`), so its proof certifies the
 *    product without decoding it;
 *  - an entity row edited IN PLACE, its count unchanged, is served as it now
 *    reads: `readSealedProductEntities` checks the digest, the version and
 *    the count, never the values (`sealedProductCache.integration.test.ts`,
 *    R8). By design: a derived cache with one writer, which a cold build or
 *    a rewrite replaces whole (W4). The same holds for the cold build's
 *    winners statement (digest, version, count) and the on-demand value
 *    read (digest, version; `sealedWinners.ts`, G4-16f C5): never the values.
 */

import { createHash } from 'node:crypto'
import { envNumber } from '../envNumber.js'
import type { Queryable } from './types.js'
import type { WorkspaceKey } from './projector.js'
import { headsEqual } from './arrivalWatermark.js'
import { DecodeWaitAbandoned, DurableDecodeError, durableHeadsDecoder, type DecodeWait } from './durableHeadsDecoder.js'
import { durableHeadsScopeSql, rowVersionSet, type DurableRowVersion, type ScopedRowVersion } from './durableHeadsMemo.js'
import { PROJECTION_FORMAT_VERSION } from './adoptState.js'
import { withAtomicStatements } from './queryableShape.js'

/** `READ_MODEL_SEALED_CACHE_INTERVAL_MS`: the writer's pause between two
 * products (its rate limit); 0 is refused (falls back), so the writer can
 * never run unpaused. A sizing choice, NOT measured: 250 ms puts the 426
 * products of the aged high corpus at 3 years at ~2 minutes of pauses. */
export function sealedProductCacheIntervalMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return envNumber('READ_MODEL_SEALED_CACHE_INTERVAL_MS', {
    fallback: 250, minimum: 10, maximum: 600_000, integer: true,
  }, env)
}

/** `READ_MODEL_SEALED_CACHE=off` stops both the writer and the reader (the
 * cold build then reads every product from its document, as before). */
export function sealedProductCacheEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.READ_MODEL_SEALED_CACHE !== 'off'
}

/** What a cached extract was written by; a header of another version is a
 * miss. The projection format: an extract is a projection input. */
export const SEALED_PRODUCT_EXTRACTION_VERSION = PROJECTION_FORMAT_VERSION

/** sha256 of the canonical row-version set (`rowVersionSet`), the identity of
 * the exact durable bytes an extract was decoded from. */
export function sealedRowsDigest(versions: readonly string[]): string {
  return createHash('sha256').update(versions.join('\n')).digest('hex')
}

/** The highest arrival of a row-version list (BIGINT text, compared as
 * BigInt, never as Number). Null on an empty list or a NULL arrival. */
export function maxArrivalOf(rows: readonly DurableRowVersion[]): string | null {
  let max: bigint | null = null
  for (const row of rows) {
    if (row.arrivalSeq === null) return null
    const value = BigInt(row.arrivalSeq)
    if (max === null || value > max) max = value
  }
  return max === null ? null : max.toString()
}

/** Document ids of the products ModelMeta lists, per collection. */
export interface ListedSealedProducts {
  object: readonly string[]
  connection: readonly string[]
}

/**
 * Delete the cached extracts of every product of `key` that the given lists
 * no longer name in its collection (an unlisted product is never read by a
 * cold build). Entities go by cascade. Returns the headers deleted. Always
 * safe: the cache is derived.
 */
export async function pruneSealedProductCache(
  db: Queryable,
  key: WorkspaceKey,
  listed: ListedSealedProducts,
): Promise<number> {
  const result = await db.query(
    `DELETE FROM read_model_sealed_product_extracts
     WHERE landscape_id = $1 AND version_id = $2
       AND NOT ((collection = 'object' AND product_document_id = ANY($3::text[]))
             OR (collection = 'connection' AND product_document_id = ANY($4::text[])))`,
    [key.landscapeId, key.versionId, [...listed.object], [...listed.connection]],
  )
  return result.rowCount ?? 0
}

/** One sealed product to cache: the heads its content was read at by the
 * projector (the cold build's stream, or a mid-session park). */
export interface SealedProductCacheTask {
  kind: 'object' | 'connection'
  documentId: string
  heads: readonly string[]
}

/** Why a task wrote nothing. Every one is safe: the next build reads the
 * document. The ones decided by the BYTES (`RememberedRefusal`) are stored
 * against those rows and never decoded again; the others are not. */
export type SealedProductCacheSkip =
  | 'no-rows' | 'no-arrival-seq' | 'heads-moved' | 'not-a-map' | 'decoder-failed' | 'refused-before' | 'decoder-busy'
  | RememberedRefusal

/** A refusal the same rows will always give: the strict decoder rejects the
 * bytes (`decode-refused`), the entity map has no JSON form — an integer
 * beyond 2^53, which Automerge hands back as a BigInt (`not-serializable`) —
 * or PostgreSQL refuses the JSONB (`insert-refused`: a NUL in a string, SQLSTATE
 * class 22). Kept as a header with `refused_reason` and no entities, keyed by
 * the rows' digest: never a hit, and the writer skips those rows unread
 * (`refused-before`). Rows that change are a new digest, and are tried. */
export type RememberedRefusal = 'decode-refused' | 'not-serializable' | 'insert-refused'

export interface SealedProductCacheWriterOptions {
  /** A POOL: the writer opens its own transactions. */
  db: Queryable
  key: WorkspaceKey
  /** The pause BEFORE each job (the rate limit): at most one product per
   * `intervalMs` plus its own cost, the first after an idle queue included. */
  intervalMs: number
  /** Entity rows per INSERT inside a product's transaction. */
  batchSize?: number
  /** The strict decode (default: the process-wide worker, at BACKGROUND
   * priority — `durableHeadsDecoder`, it yields to a waiting projection).
   * `wait` bounds the wait for the decoder (this writer's stop signal and
   * `maxDecodeWaitMs`); an implementation that gives up rejects with
   * `DecodeWaitAbandoned`. */
  decode?: (documentId: string, chunks: readonly Uint8Array[], field: string, wait: DecodeWait) => Promise<{ heads: readonly string[]; json: string }>
  /** The longest a job waits for the shared decoder (other workspaces'
   * projections and writers ahead of it) while holding its product's rows;
   * past it the job is skipped (`decoder-busy`) and retried like a
   * `heads-moved` one. Default 30 s. */
  maxDecodeWaitMs?: number
  /** True while this workspace's foreground work (a projection, a fold, a
   * rotation) is in flight: a job waits for it to end before taking the
   * decoder or a client, for at most `maxYieldMs`, so a projector that is
   * never idle cannot starve the cache forever. */
  foregroundBusy?: () => boolean
  maxYieldMs?: number
  /** Start HELD: jobs queue, nothing runs until `start()`. The projector
   * starts it when its attach has completed, so an attach that throws after
   * the writer exists leaves a writer that never ran (and holds nothing). */
  held?: boolean
  /** A `heads-moved` product (its durable rows behind the heads it was
   * parked at — a save not flushed yet) is tried again after this, at most
   * `HEADS_MOVED_ATTEMPTS` times in all. Default: max(4 x intervalMs, 1 s). */
  retryDelayMs?: number
  /** Where the structured lines go (default `console.log` / `console.warn`). */
  log?: (line: string) => void
  warn?: (line: string) => void
  /** Called once a task's extract is COMMITTED (after its transaction's
   * COMMIT resolved; never for a skip, a refusal or a rollback), with the
   * task as queued — its heads are the heads the decode of S equalled — and
   * the rows digest the header now carries (G4-16f C5: the projector drops a
   * product's values from memory only then). Synchronous; a throw is logged
   * and changes nothing about the write. */
  onWritten?: (task: SealedProductCacheTask, rowsDigest: string) => void
}

/** Attempts of one product whose decoded heads differ from its task's. */
export const HEADS_MOVED_ATTEMPTS = 3

type CacheJob =
  | { type: 'write'; task: SealedProductCacheTask; attempt: number }
  | { type: 'prune'; listed: ListedSealedProducts }

class CacheWriteAborted extends Error {
  constructor() { super('sealed product cache write aborted') }
}

/** SQLSTATE class 22 (data exception): the values cannot be stored as given
 * (22P05: a NUL in a JSONB string). Deterministic for the same values. */
const isDataException = (error: unknown): boolean =>
  typeof (error as { code?: unknown })?.code === 'string' && (error as { code: string }).code.startsWith('22')

type WriterStats = {
  written: number
  pruned: number
  failed: number
  yieldedMs: number
  skipped: Partial<Record<SealedProductCacheSkip, number>>
}

/**
 * THE CACHE WRITER (G4-16f). Background, one job at a time, a pause of
 * `intervalMs` before each job; never inside a projection transaction and
 * never holding the projection mutex: a cache row is a fact about durable
 * bytes, not about the read model, so it needs no fence.
 *
 * A write, and why each step is there:
 *  1. ONE statement reads the product's content rows (key, arrival_seq,
 *     bytes): the set S and its bytes come from a single snapshot;
 *  2. a refusal remembered against S's digest skips the product unread;
 *  3. the bytes are decoded STRICTLY in the worker (`decodeField`: the
 *     `Automerge.load` + no-missing-dependency predicate the durable-heads
 *     memo is fed by), which returns the heads of S and the entity map as
 *     the projector copies it (`JSON.stringify` of the field). Content,
 *     heads and digest all come from S, so the header states a fact about
 *     those exact row versions whatever happens to the document later;
 *  4. the decoded heads must EQUAL the heads the projector read the product
 *     at: the cache only ever records what the read model served. Unequal is
 *     retried (`retryDelayMs`, bounded): a park enqueues before its release
 *     flush, so S can still be behind;
 *  5. header and entities are replaced in ONE transaction (the header row
 *     is locked first, by its upsert, so two writers of one product
 *     serialize), the entities in batches of `batchSize`.
 *
 * Every drain ends with ONE `read_model.sealed_product_cache_drained` line
 * (written, pruned, failed and skipped by reason, during it and in all), so
 * a writer that never writes is visible.
 *
 * Memory: one product's rows and entity map at a time; a queued task holds
 * three fields.
 *
 * `stop()` aborts: the queue is dropped, a pause or a pending retry ends at
 * once, a write in flight stops at its next statement and rolls back — the
 * only client this writer ever holds is `withAtomicStatements`'s, released
 * in its `finally` on every path — and the promise resolves when the job has
 * unwound.
 */
export class SealedProductCacheWriter {
  private readonly queue: CacheJob[] = []
  private readonly queued = new Set<string>()
  private readonly controller = new AbortController()
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>()
  private running: Promise<void> | null = null
  private held: boolean
  private readonly batchSize: number
  private readonly decode: NonNullable<SealedProductCacheWriterOptions['decode']>
  private readonly log: (line: string) => void
  private readonly warn: (line: string) => void
  readonly stats: WriterStats = { written: 0, pruned: 0, failed: 0, yieldedMs: 0, skipped: {} }

  constructor(private readonly options: SealedProductCacheWriterOptions) {
    this.batchSize = Math.max(1, options.batchSize ?? 500)
    this.decode = options.decode
      ?? ((documentId, chunks, field, wait) => durableHeadsDecoder.decodeField(documentId, chunks, field, 'background', wait))
    this.held = options.held ?? false
    this.log = options.log ?? ((line) => console.log(line))
    this.warn = options.warn ?? ((line) => console.warn(line))
  }

  get stopped(): boolean { return this.controller.signal.aborted }

  private get workspace(): string { return `${this.options.key.landscapeId}/${this.options.key.versionId}` }

  /** Queue a product (once while queued). Ignored after `stop()`. */
  enqueue(task: SealedProductCacheTask): void {
    this.push({ type: 'write', task: { kind: task.kind, documentId: task.documentId, heads: [...task.heads] }, attempt: 1 })
  }

  private push(job: Extract<CacheJob, { type: 'write' }>): void {
    const id = `${job.task.kind}:${job.task.documentId}`
    if (this.stopped || this.queued.has(id)) return
    this.queued.add(id)
    this.queue.push(job)
    this.kick()
  }

  /** Queue a prune of the extracts of products `listed` no longer names. */
  prune(listed: ListedSealedProducts): void {
    if (this.stopped) return
    this.queue.push({ type: 'prune', listed: { object: [...listed.object], connection: [...listed.connection] } })
    this.kick()
  }

  /** Release a writer constructed `held`. */
  start(): void {
    this.held = false
    this.kick()
  }

  /** Resolves once nothing is running and no retry is pending. A HELD
   * writer with a queue is idle (nothing will run until `start()`). */
  async idle(): Promise<void> {
    for (;;) {
      if (this.running) await this.running
      else if (this.retryTimers.size && !this.stopped) await new Promise((resolve) => setTimeout(resolve, 20))
      else return
    }
  }

  /** Abort, drop the queue and the pending retries, and wait for a job in
   * flight to unwind. */
  async stop(): Promise<void> {
    this.controller.abort()
    this.queue.length = 0
    this.queued.clear()
    for (const timer of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
    await this.idle()
  }

  private kick(): void {
    if (this.running || this.stopped || this.held || !this.queue.length) return
    // Re-kicked from the finally: a job queued between the drain's last
    // check and this settling would otherwise wait for the next enqueue.
    this.running = this.drain().finally(() => { this.running = null; this.kick() })
  }

  private async drain(): Promise<void> {
    const before = { ...this.stats, skipped: { ...this.stats.skipped } }
    try {
      while (this.queue.length && !this.stopped && !this.held) {
        // The rate limit BEFORE every job, the first after an idle queue
        // included: a park enqueues before its release flush, and a job run
        // at once would read rows that flush has not written yet.
        await this.pause(this.options.intervalMs)
        if (this.stopped) return
        await this.yieldToForeground()
        if (this.stopped || !this.queue.length) return
        const job = this.queue.shift()!
        if (job.type === 'write') this.queued.delete(`${job.task.kind}:${job.task.documentId}`)
        try {
          if (job.type === 'prune') this.stats.pruned += await pruneSealedProductCache(this.options.db, this.options.key, job.listed)
          else await this.write(job)
        } catch (error) {
          if (error instanceof CacheWriteAborted) return
          this.stats.failed += 1
          this.warn(JSON.stringify({
            event: 'read_model.sealed_product_cache_write_failed',
            workspace: this.workspace,
            job: job.type,
            documentId: job.type === 'write' ? job.task.documentId : null,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }
    } finally {
      this.logDrain(before)
    }
  }

  private logDrain(before: WriterStats): void {
    const skipped: Partial<Record<SealedProductCacheSkip, number>> = {}
    for (const [reason, count] of Object.entries(this.stats.skipped) as Array<[SealedProductCacheSkip, number]>) {
      const delta = count - (before.skipped[reason] ?? 0)
      if (delta) skipped[reason] = delta
    }
    this.log(JSON.stringify({
      event: 'read_model.sealed_product_cache_drained',
      workspace: this.workspace,
      written: this.stats.written - before.written,
      pruned: this.stats.pruned - before.pruned,
      failed: this.stats.failed - before.failed,
      skipped,
      yieldedMs: Math.round(this.stats.yieldedMs - before.yieldedMs),
      total: { written: this.stats.written, pruned: this.stats.pruned, failed: this.stats.failed, skipped: { ...this.stats.skipped } },
      stopped: this.stopped,
    }))
  }

  /** Wait while this workspace's foreground work is in flight, at most
   * `maxYieldMs` (default 30 s), polled every 50 ms; cut short by `stop()`. */
  private async yieldToForeground(): Promise<void> {
    const busy = this.options.foregroundBusy
    if (!busy) return
    const startedAt = performance.now()
    const limit = this.options.maxYieldMs ?? 30_000
    while (!this.stopped && busy() && performance.now() - startedAt < limit) await this.pause(50)
    this.stats.yieldedMs += performance.now() - startedAt
  }

  /** `ms`, cut short by `stop()`. */
  private pause(ms: number): Promise<void> {
    const signal = this.controller.signal
    return new Promise((resolve) => {
      if (signal.aborted) { resolve(); return }
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
      timer.unref?.()
      const onAbort = () => { clearTimeout(timer); resolve() }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private checkpoint(): void {
    if (this.stopped) throw new CacheWriteAborted()
  }

  private skip(reason: SealedProductCacheSkip): void {
    this.stats.skipped[reason] = (this.stats.skipped[reason] ?? 0) + 1
  }

  /** A `heads-moved` or `decoder-busy` product, again later (bounded: the
   * two share `HEADS_MOVED_ATTEMPTS`). */
  private retryLater(job: Extract<CacheJob, { type: 'write' }>): void {
    if (this.stopped || job.attempt >= HEADS_MOVED_ATTEMPTS) return
    const delay = this.options.retryDelayMs ?? Math.max(4 * this.options.intervalMs, 1_000)
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer)
      this.push({ ...job, attempt: job.attempt + 1 })
    }, delay)
    timer.unref?.()
    this.retryTimers.add(timer)
  }

  private async write(job: Extract<CacheJob, { type: 'write' }>): Promise<void> {
    const { task } = job
    const { db, key } = this.options
    const field = task.kind === 'object' ? 'objects' : 'connections'
    const { rows } = await db.query<{ key: string; arrival_seq: string | null; data: Uint8Array }>(
      `SELECT key, arrival_seq::text AS arrival_seq, data FROM automerge_storage
        WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) IN ('snapshot', 'incremental')
        ORDER BY CASE split_part(key, '/', 2) WHEN 'snapshot' THEN 0 ELSE 1 END, key`,
      [task.documentId],
    )
    this.checkpoint()
    if (!rows.length) return this.skip('no-rows')
    const versions: DurableRowVersion[] = rows.map((row) => ({
      key: row.key, arrivalSeq: row.arrival_seq ?? null, octets: row.data.byteLength,
    }))
    const set = rowVersionSet(versions)
    const maxArrival = maxArrivalOf(versions)
    if (!set || maxArrival === null) return this.skip('no-arrival-seq')
    const digest = sealedRowsDigest(set)
    const params = [key.landscapeId, key.versionId, task.kind, task.documentId]
    const remembered = await db.query(
      `SELECT 1 FROM read_model_sealed_product_extracts
        WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND product_document_id = $4
          AND rows_digest = $5 AND extraction_version = $6 AND refused_reason IS NOT NULL`,
      [...params, digest, SEALED_PRODUCT_EXTRACTION_VERSION],
    )
    this.checkpoint()
    if (remembered.rowCount) return this.skip('refused-before')
    let decoded: { heads: readonly string[]; json: string }
    try {
      decoded = await this.decode(task.documentId, rows.map((row) => row.data), field, {
        signal: this.controller.signal,
        maxWaitMs: this.options.maxDecodeWaitMs ?? 30_000,
      })
    } catch (error) {
      this.checkpoint()
      if (error instanceof DecodeWaitAbandoned) {
        // Never decoded (the abort is `stop()`, caught by the checkpoint
        // above): the rows go now, and the product is tried again later.
        this.retryLater(job)
        return this.skip('decoder-busy')
      }
      if (error instanceof DurableDecodeError) {
        const reason: RememberedRefusal = error.kind === 'serialize' ? 'not-serializable' : 'decode-refused'
        if (reason === 'not-serializable') this.warnRefusal(task, reason, error)
        await this.rememberRefusal(task, digest, maxArrival, reason)
        return this.skip(reason)
      }
      // The worker crashed, was closed or answered nonsense: nothing about
      // these bytes was decided, so nothing is remembered.
      this.warnRefusal(task, 'decoder-failed', error)
      return this.skip('decoder-failed')
    }
    this.checkpoint()
    if (!headsEqual(decoded.heads, task.heads)) {
      this.retryLater(job)
      return this.skip('heads-moved')
    }
    const entities = JSON.parse(decoded.json) as unknown
    if (!entities || typeof entities !== 'object' || Array.isArray(entities)) return this.skip('not-a-map')
    const ids = Object.keys(entities)
    try {
      await withAtomicStatements(db, async (tx) => {
        this.checkpoint()
        await tx.query(
          `INSERT INTO read_model_sealed_product_extracts (landscape_id, version_id, collection, product_document_id,
             rows_digest, heads, max_arrival_seq, extraction_version, entity_count, refused_reason)
           VALUES ($1, $2, $3, $4, $5, $6::text[], $7::bigint, $8, $9, NULL)
           ON CONFLICT (landscape_id, version_id, collection, product_document_id) DO UPDATE
           SET rows_digest = EXCLUDED.rows_digest, heads = EXCLUDED.heads, max_arrival_seq = EXCLUDED.max_arrival_seq,
               extraction_version = EXCLUDED.extraction_version, entity_count = EXCLUDED.entity_count,
               refused_reason = NULL, updated_at = now()`,
          [...params, digest, [...decoded.heads], maxArrival, SEALED_PRODUCT_EXTRACTION_VERSION, ids.length],
        )
        this.checkpoint()
        await tx.query(
          `DELETE FROM read_model_sealed_product_entities
            WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND product_document_id = $4`,
          params,
        )
        for (let at = 0; at < ids.length; at += this.batchSize) {
          this.checkpoint()
          const batch: Record<string, unknown> = {}
          for (const id of ids.slice(at, at + this.batchSize)) batch[id] = (entities as Record<string, unknown>)[id]
          await tx.query(
            `INSERT INTO read_model_sealed_product_entities (landscape_id, version_id, collection, product_document_id, entity_id, value)
             SELECT $1, $2, $3, $4, entity.key, entity.value FROM jsonb_each($5::jsonb) AS entity`,
            [...params, JSON.stringify(batch)],
          )
        }
        this.checkpoint()
      })
    } catch (error) {
      if (error instanceof CacheWriteAborted || !isDataException(error)) throw error
      this.warnRefusal(task, 'insert-refused', error)
      await this.rememberRefusal(task, digest, maxArrival, 'insert-refused', decoded.heads)
      return this.skip('insert-refused')
    }
    this.stats.written += 1
    // Committed: `withAtomicStatements` resolved after its COMMIT.
    try {
      this.options.onWritten?.(task, digest)
    } catch (error) {
      this.warn(JSON.stringify({
        event: 'read_model.sealed_product_cache_on_written_failed',
        workspace: this.workspace,
        documentId: task.documentId,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  private warnRefusal(task: SealedProductCacheTask, reason: SealedProductCacheSkip, error: unknown): void {
    this.warn(JSON.stringify({
      event: 'read_model.sealed_product_cache_refused',
      workspace: this.workspace,
      documentId: task.documentId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    }))
  }

  /** The refusal, against S's digest: a header with no entities. Its own
   * failure is logged and changes nothing (the product is only tried again). */
  private async rememberRefusal(
    task: SealedProductCacheTask,
    digest: string,
    maxArrival: string,
    reason: RememberedRefusal,
    heads: readonly string[] = task.heads,
  ): Promise<void> {
    const { db, key } = this.options
    const params = [key.landscapeId, key.versionId, task.kind, task.documentId]
    try {
      await withAtomicStatements(db, async (tx) => {
        this.checkpoint()
        await tx.query(
          `INSERT INTO read_model_sealed_product_extracts (landscape_id, version_id, collection, product_document_id,
             rows_digest, heads, max_arrival_seq, extraction_version, entity_count, refused_reason)
           VALUES ($1, $2, $3, $4, $5, $6::text[], $7::bigint, $8, 0, $9)
           ON CONFLICT (landscape_id, version_id, collection, product_document_id) DO UPDATE
           SET rows_digest = EXCLUDED.rows_digest, heads = EXCLUDED.heads, max_arrival_seq = EXCLUDED.max_arrival_seq,
               extraction_version = EXCLUDED.extraction_version, entity_count = 0,
               refused_reason = EXCLUDED.refused_reason, updated_at = now()`,
          [...params, digest, [...heads], maxArrival, SEALED_PRODUCT_EXTRACTION_VERSION, reason],
        )
        await tx.query(
          `DELETE FROM read_model_sealed_product_entities
            WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND product_document_id = $4`,
          params,
        )
      })
    } catch (error) {
      if (error instanceof CacheWriteAborted) throw error
      this.warnRefusal(task, reason, new Error(`the refusal could not be recorded: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
}

/** A cached extract whose header matches the product's CURRENT durable rows:
 * `rows` is that set S as one statement read it (`readSealedProductCacheHits`). */
export interface SealedProductCacheHit {
  kind: 'object' | 'connection'
  documentId: string
  rowsDigest: string
  heads: readonly string[]
  /** max(S), BIGINT text: the arrival the content was read at. */
  maxArrivalSeq: string
  entityCount: number
  /** With the scope of the table each row was read from, which is what lets
   * the cold build remember the hit's heads in the durable-heads memo. */
  rows: readonly ScopedRowVersion[]
}

/**
 * ONE statement: every cached header of the listed products with the
 * product's current content rows (key, arrival_seq, octet length — no data
 * detoast). A header HITS only when the digest of those rows equals its
 * `rows_digest` and its extraction version is this code's; anything else
 * (a write since, a compaction rewrite, another version) is a miss.
 */
export async function readSealedProductCacheHits(
  db: Queryable,
  key: WorkspaceKey,
  listed: ListedSealedProducts,
): Promise<{
  object: Map<string, SealedProductCacheHit>
  connection: Map<string, SealedProductCacheHit>
  headers: number
  /** Products whose CURRENT rows carry a remembered refusal: misses the
   * cold build does not hand to the writer again. */
  refused: { object: Set<string>; connection: Set<string> }
}> {
  const hits = {
    object: new Map<string, SealedProductCacheHit>(), connection: new Map<string, SealedProductCacheHit>(), headers: 0,
    refused: { object: new Set<string>(), connection: new Set<string>() },
  }
  if (!listed.object.length && !listed.connection.length) return hits
  const { rows } = await db.query<{
    collection: 'object' | 'connection'; product_document_id: string; rows_digest: string; heads: string[]
    extraction_version: number; entity_count: number; refused_reason: string | null
    key: string | null; arrival_seq: string | null; octets: number | null; durable_scope: string | null
  }>(
    `SELECT header.collection, header.product_document_id, header.rows_digest, header.heads,
            header.extraction_version, header.entity_count, header.refused_reason,
            storage.key, storage.arrival_seq::text AS arrival_seq, octet_length(storage.data) AS octets,
            ${durableHeadsScopeSql('storage')} AS durable_scope
       FROM read_model_sealed_product_extracts AS header
       LEFT JOIN automerge_storage AS storage
         ON split_part(storage.key, '/', 1) = header.product_document_id
        AND split_part(storage.key, '/', 2) IN ('snapshot', 'incremental')
      WHERE header.landscape_id = $1 AND header.version_id = $2
        AND ((header.collection = 'object' AND header.product_document_id = ANY($3::text[]))
          OR (header.collection = 'connection' AND header.product_document_id = ANY($4::text[])))`,
    [key.landscapeId, key.versionId, [...new Set(listed.object)], [...new Set(listed.connection)]],
  )
  const grouped = new Map<string, { first: (typeof rows)[number]; versions: ScopedRowVersion[] }>()
  for (const row of rows) {
    const id = `${row.collection}:${row.product_document_id}`
    const group = grouped.get(id) ?? { first: row, versions: [] }
    if (row.key !== null) {
      group.versions.push({ key: row.key, arrivalSeq: row.arrival_seq ?? null, octets: Number(row.octets), scope: row.durable_scope ?? null })
    }
    grouped.set(id, group)
  }
  hits.headers = grouped.size
  for (const { first, versions } of grouped.values()) {
    const set = rowVersionSet(versions)
    const maxArrival = maxArrivalOf(versions)
    if (!set || !set.length || maxArrival === null) continue
    if (sealedRowsDigest(set) !== first.rows_digest) continue
    if (first.extraction_version !== SEALED_PRODUCT_EXTRACTION_VERSION) continue
    if (first.refused_reason !== null) {
      hits.refused[first.collection].add(first.product_document_id)
      continue
    }
    hits[first.collection].set(first.product_document_id, {
      kind: first.collection,
      documentId: first.product_document_id,
      rowsDigest: first.rows_digest,
      heads: [...first.heads],
      maxArrivalSeq: maxArrival,
      entityCount: first.entity_count,
      rows: versions,
    })
  }
  return hits
}

/** Code-point order, i.e. the byte order of the keys' UTF-8 encodings — the
 * order `Automerge.load` materialises a map's keys in. NOT JS's default
 * sort, which compares UTF-16 code units and so puts an astral key (a
 * surrogate pair, 0xD800–0xDFFF) BEFORE a key in 0xE000–0xFFFF, where UTF-8
 * puts it after (`sealedProductCache.integration.test.ts`, "key order for
 * astral and high-BMP keys", against a real loaded document). Code units
 * equal outside the surrogates are compared as they are; inside, the two
 * ranges are swapped so that every surrogate sorts above 0xFFFF. */
export function codePointOrder(a: string, b: string): number {
  const length = Math.min(a.length, b.length)
  for (let at = 0; at < length; at += 1) {
    let x = a.charCodeAt(at)
    let y = b.charCodeAt(at)
    if (x === y) continue
    if (x >= 0xD800) x = x >= 0xE000 ? x - 0x800 : x + 0x2000
    if (y >= 0xD800) y = y >= 0xE000 ? y - 0x800 : y + 0x2000
    return x - y
  }
  return a.length - b.length
}

/** Object keys sorted, recursively, in `codePointOrder`: a JSONB value comes
 * back with its keys in JSONB's order (shorter first), the projector's copy
 * of a loaded document has them in Automerge's. Values are untouched.
 * (Integer-like keys are then enumerated first by JS itself, in both copies
 * alike.) */
export function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const name of Object.keys(value).sort(codePointOrder)) out[name] = sortedKeys((value as Record<string, unknown>)[name])
  return out
}

/** The entity map of a hit, in ONE statement joined to its header by the
 * digest the hit was decided on: a header rewritten since (another writer)
 * returns nothing, and a count that differs from `entity_count` is refused.
 * Null: read the document instead. */
export async function readSealedProductEntities(
  db: Queryable,
  key: WorkspaceKey,
  hit: SealedProductCacheHit,
): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query<{ entity_id: string; value: unknown }>(
    `SELECT entity.entity_id, entity.value
       FROM read_model_sealed_product_entities AS entity
       JOIN read_model_sealed_product_extracts AS header
         USING (landscape_id, version_id, collection, product_document_id)
      WHERE entity.landscape_id = $1 AND entity.version_id = $2 AND entity.collection = $3
        AND entity.product_document_id = $4 AND header.rows_digest = $5 AND header.extraction_version = $6
      ORDER BY entity.entity_id COLLATE "C"`,
    [key.landscapeId, key.versionId, hit.kind, hit.documentId, hit.rowsDigest, SEALED_PRODUCT_EXTRACTION_VERSION],
  )
  if (rows.length !== hit.entityCount) return null
  const entities: Record<string, unknown> = {}
  for (const row of rows) entities[row.entity_id] = sortedKeys(row.value)
  return entities
}
