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

import { documentContentChunkFilter } from '../documentContent.js'
import { STORAGE_WRITE_APPLICATION_PREFIX } from '../dbConfig.js'
import { envNumber } from '../envNumber.js'
import type { OverlayCollection } from './overlayHistoryProtocol.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

/**
 * LATE WRITES TO A FOLDED HEAD (G4-16b phase 4, step 4).
 *
 * A folded head is no longer listed, so the projector does not watch it
 * (`ordinaryChainFold.ts` detaches it) and a cold build never attaches it. A
 * client that still holds it — offline across the fold, say — can still sync
 * a write into it. Its `folded` row keeps forwarding (step 2), but nothing
 * would notice the write: this is what does, from STORAGE, not from a watcher.
 *
 * A write that reaches the server becomes a content chunk in
 * `automerge_storage` with a fresh `arrival_seq` (`automergeStorage.ts`; sync
 * state is NULL, never an arrival). Each folded row keeps `arrival_watermark`,
 * the highest arrival the projector has already forwarded past. The poll asks
 * one indexed question per folded head (`idx_automerge_storage_doc_arrival`):
 * any arrival above the watermark? For each, the projector loads the head,
 * forwards from `forwarded_heads` to its live heads (the ordinary forward,
 * `forwardRetiredHead`), and only then — and only if the forward HAPPENED
 * (`forwarded`, `superseded`, `nothing`), fenced — advances the watermark to
 * the arrival it read BEFORE loading. A NULL watermark (a head just folded) is
 * "anything": the first poll loads it once and compares heads.
 *
 * WHY THAT ADVANCE SKIPS NOTHING: not because the sequence is a floor — a
 * lower one can commit after a higher one is read (`arrivalWatermark.ts`
 * says so) — but because ONE process writes the workspace's documents: the
 * projector runs on the workspace's sync-owner cell and shares its Repo, and
 * a change is in that Repo's handle before its chunk is saved. So the head
 * loaded (or already resident) holds every arrival up to the one read.
 *
 * THE HANDOVER RESIDUAL (G4-16d) and its re-check. During an ownership
 * handover the OLD owner's fenced save is a second writer: its statement
 * snapshot can predate the new fence (`automergeStorage.ts` deliberately does
 * not lock the ownership row), so it draws its sequence x, and COMMITS, after
 * the new owner read a higher arrival y of the same head (its own client's
 * write), forwarded it and moved the watermark to y. x then sits below the
 * watermark, and no poll asks about it again. Its content is in storage only:
 * a handle the new owner already holds never sees it either (a Repo does not
 * re-read storage). The same holds WITHOUT any inversion: an old save that
 * commits after the new owner loaded the head but before its poll read makes
 * that poll see max_seq = x, find `nothing` on the stale handle, and advance
 * past x. Pinned by `ordinaryFoldedArrivals.handover.integration.test.ts`, for
 * a folded head, a parked one (evicted, and kept resident by another lease)
 * and a watched one.
 *
 * The fix: once per attach, the projector re-checks EVERY retired head of the
 * workspace (folded, parked, or still watched — plus the two current write
 * heads, and any head an `admitted` row names: merged on purpose, it costs
 * one read each) from STORAGE, not from its Repo. A head resident BEFORE the
 * re-check loads it gets the head's content chunks, read in one statement
 * (`documentContentChunks`), merged into its handle (a no-op when nothing is
 * missing); a head the re-check loads fresh already reflects storage. Then it
 * forwards as the poll does, and only then advances the watermark (never
 * lowers it). WHEN: `ordinaryHandoverRecheckMs` after attach (plus jitter),
 * and not before THE BARRIER: no STORAGE-WRITE backend of another process
 * (`application_name` tagged by `storageWritePoolConfig`, `dbConfig.ts`)
 * still runs a transaction that started before the attach
 * (`handoverBarrierBlockers`).
 * What it relies on:
 *   1. every old-owner save that can still commit is IN that set. A fenced save
 *      passes the fence only on a statement snapshot taken before the new fence
 *      committed (`automergeStorage.ts`, one autocommit statement), so its
 *      transaction started before the fence, which committed before this
 *      projector's attach ended (it attaches as owner); while it runs —
 *      waiting on a row lock, or for a cell that was SIGKILLed mid-statement,
 *      whose backend goes on — `pg_stat_activity` shows it with that `xact_start`, on a
 *      connection of the old process's storage-write pool. Exact on two
 *      conditions: the old owner runs a version that tags that pool (a cell
 *      from before G4-16d writes untagged, and for that one handover only the
 *      delay guards), and it connects as the SAME role (or this role holds
 *      `pg_read_all_stats`): another role's `xact_start` reads NULL and is not
 *      counted. A save starting after the fence is refused (2);
 *   2. a stale owner's save that starts after the new fence is visible is
 *      refused (the fence), so nothing else ever writes below the watermark;
 *   3. after the re-check the new owner is the single writer again, and the
 *      argument above holds for every later arrival;
 *   4. merging a chunk is idempotent (`loadIncremental` skips changes it
 *      holds), so the re-check cannot write anything the head did not already
 *      hold in storage.
 * THE BARRIER CANNOT STAY BLOCKED. What it waits for is bounded at the
 * source: a storage-write statement by `statement_timeout` (120 s), its lock
 * waits by `lock_timeout` (10 s), a transaction left open by a paused client
 * by `idle_in_transaction_session_timeout` (30 s) — all three on the write
 * pool's startup packet. Not by them: the commit's WAL flush and a
 * synchronous-replication wait, which PostgreSQL never cancels; a backend
 * blocked sending to a dead client (only the server's TCP keepalives end it);
 * and a cell of
 * an older version, or one whose operator set a ceiling to 0. So the wait has
 * its own ceiling too, `ordinaryHandoverBarrierMaxWaitMs` (5 min): reached,
 * it is logged (`read_model.ordinary_handover_recheck_barrier_timeout`) and
 * counted (`maplespire_read_model_handover_recheck_barrier_timeouts_total`),
 * the re-check RUNS, and ONE follow-up re-check is scheduled for when the
 * barrier clears, or after one more maximum wait — so a save that commits
 * after the timeout is still caught, unless it commits later than that. It
 * never terminates a backend: an `application_name` names a process, not the
 * workspace a statement writes, so `pg_terminate_backend` could cancel a live
 * cell's save of another workspace; and a backend waiting on its commit
 * record has committed as far as anyone can stop it. While it waits it says
 * so every `HANDOVER_BARRIER_WARN_MS` (`read_model.ordinary_handover_recheck_barrier_waiting`).
 * The fold's row sweep must not take a re-checked head's row first: the
 * leftover is below the watermark, out of `foldedArrivalPendingSql`'s sight,
 * so the sweep is held until this attach's last re-check ran, then keeps
 * the rows of the heads still owed (`sweepKeep`, `projectorService.ts`;
 * `sweepOrdinaryChainFoldRows`'s `keep`).
 * NOT covered: the other documents this Repo holds — the base shards,
 * ModelMeta, the fold products, diagrams — have the same "content in storage
 * only" residual after a handover; nothing here re-reads them. What heals
 * them is the client that wrote the change: it still holds it and re-sends it
 * when it syncs with the new owner.
 * Rejected:
 *   - a LAGGING watermark (capped at the sequence read before the handover,
 *     or re-scanning a sequence range): the old save's x can be drawn AFTER
 *     any capture the new owner makes (its statement only had to START before
 *     the fence), and a re-scan finds x but the resident handle still lacks
 *     its content — it needs the storage merge anyway, plus a bound on x it
 *     cannot have;
 *   - commit-ordered information: row `xmin` against a saved
 *     `pg_current_snapshot()` is exact, but it scans every chunk of every head
 *     on every poll and leans on 32-bit xid internals; commit timestamps need
 *     `track_commit_timestamp`, off by default; a `SHARE` lock on
 *     `automerge_storage` as a barrier stalls every workspace's writes;
 *   - a re-check AT attach: the old save can still be in flight then;
 *   - a fixed delay alone (the first version of this fix): nothing bounds the
 *     old save's statement (the storage pool carries no `statement_timeout`
 *     nor `lock_timeout`), so a delay is an assumption the barrier replaces;
 *     the delay stays, as a floor;
 *   - a per-poll storage fingerprint (key set) in place of the sequence: exact
 *     without a delay, but a heap visit per chunk of every head on every poll
 *     for the life of the projector, to fix a handover-only residual.
 * Cost: once per attach, per retired head of the workspace, ONE storage read
 * and decode (the merge for a resident head, the Repo's load for another),
 * then a forward that usually finds `nothing`. O(retired heads), bounded by
 * the chain (fold on) or by the rotations (fold off, as parking already is),
 * drained `HANDOVER_RECHECK_PER_POLL` heads per poll, at most
 * `HANDOVER_RECHECK_PERMITS` merges at once per process (a mass takeover
 * re-checks many workspaces together), the timer jittered by up to half the
 * delay (at most 60 s). Plus the barrier: one `pg_stat_activity` query per
 * poll period while it waits. A head whose re-check fails
 * `HANDOVER_RECHECK_MAX_ATTEMPTS` times is given up, and logged. Steady-state
 * poll query is unchanged (what else changes: read-model-projector-health.md,
 * "What this changes even where no handover ever happens"); a workspace that neither rotates nor holds a
 * retirement row arms nothing.
 *
 * A storage compaction (snapshot over incrementals) mints an arrival with no
 * new content: the head is loaded, has nothing to forward, and the watermark
 * moves.
 *
 * PAST `retain_until` the row is still polled while it holds an arrival above
 * its watermark (G4-16c). A write that lands shortly before the retention
 * ends, while its forward is on its backoff or no projector is attached, is
 * otherwise never carried — and GC, which keeps exactly such a head
 * (`foldedArrivalPendingSql`), would keep it for ever. Once carried, the
 * watermark moves and GC owns the head. An expired row with nothing pending
 * costs one indexed probe per poll and returns nothing.
 */

/**
 * SQL: the `folded` row aliased `alias` has a CONTENT arrival above its
 * `arrival_watermark` — a late write the poll has not carried yet. A NULL
 * watermark is -1, as the poll reads it: a head no poll has looked at yet.
 * One probe on `idx_automerge_storage_doc_arrival` per row it is asked of;
 * a NULL `arrival_seq` (a chunk older than the clock) is never pending.
 *
 * Shared by the GC root (`gc.ts`) and the fold-row sweep
 * (`sweepOrdinaryChainFoldRows`): neither may let a head holding an uncarried
 * write go, whatever its `retain_until`.
 */
export const foldedArrivalPendingSql = (alias: string): string => `EXISTS (
  SELECT 1 FROM automerge_storage pending_chunk
   WHERE split_part(pending_chunk.key, '/', 1) = ${alias}.document_id
     AND ${documentContentChunkFilter('pending_chunk.key')}
     AND pending_chunk.arrival_seq > coalesce(${alias}.arrival_watermark, -1))`

/** Poll period, `AM_ORDINARY_FOLD_ARRIVAL_POLL_MS`; 0 disables the poll. */
export function ordinaryFoldArrivalPollMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return envNumber('AM_ORDINARY_FOLD_ARRIVAL_POLL_MS', {
    fallback: 5_000, minimum: 0, maximum: 600_000, integer: true,
  }, env)
}

/** Delay of the handover re-check after attach,
 * `AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS`; 0 disables it (the G4-16d residual
 * is then open again). See THE HANDOVER RESIDUAL above. */
export function ordinaryHandoverRecheckMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return envNumber('AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS', {
    fallback: 120_000, minimum: 0, maximum: 3_600_000, integer: true,
  }, env)
}

export interface FoldedArrival {
  collection: OverlayCollection
  documentId: string
  /** The highest content arrival of the head, as text (a BIGINT). */
  arrivalSeq: string
  /** The row's watermark when read, as text, or null. */
  watermark: string | null
  /** Past its `retain_until`: GC keeps it only for this arrival. */
  expired: boolean
}

/** Folded heads of the workspace with a content arrival above their
 * watermark, retained or not (see PAST `retain_until` above) — and those
 * named in `recheck` (the handover re-check) with any content arrival at
 * all, retained or not too: an owed head past `retain_until` is still owed. */
export async function foldedHeadsWithArrivals(
  db: Queryable,
  key: WorkspaceKey,
  recheck: readonly string[] = [],
): Promise<FoldedArrival[]> {
  const { rows } = await db.query<{
    collection: OverlayCollection; document_id: string; max_seq: string; watermark: string | null; expired: boolean
  }>(
    `SELECT r.collection, r.document_id, s.max_seq::text AS max_seq, r.arrival_watermark::text AS watermark,
            (r.retain_until <= now()) AS expired
       FROM read_model_ordinary_head_retirements r
       CROSS JOIN LATERAL (
         SELECT max(arrival_seq) AS max_seq FROM automerge_storage
          WHERE split_part(key, '/', 1) = r.document_id AND ${documentContentChunkFilter()}
       ) s
      WHERE r.landscape_id = $1 AND r.version_id = $2
        AND r.status = 'folded'
        AND s.max_seq IS NOT NULL
        AND (s.max_seq > coalesce(r.arrival_watermark, -1) OR r.document_id = ANY($3::text[]))
      ORDER BY s.max_seq`,
    [key.landscapeId, key.versionId, [...recheck]],
  )
  return rows.map((row) => ({
    collection: row.collection, documentId: row.document_id, arrivalSeq: row.max_seq, watermark: row.watermark,
    expired: row.expired === true,
  }))
}

/**
 * PARKED RETIRED HEADS (chain fold OFF). With the fold off a retired head stays
 * listed in ModelMeta for good, and its projector watcher held a residency
 * lease on it until `stop()`: one resident document per rotation, for the life
 * of the projector (`ordinaryHeadResidency.integration.test.ts`). The projector
 * now PARKS a retired head once its late writes have all been forwarded and it
 * has stayed forwarded for at least this long (at most twice: the sweep runs
 * once per period, `sweepRetiredHeadsToPark`): it stops watching it, gives the lease
 * back. Its late writes are then found in storage by the same poll that serves
 * folded heads, against an in-memory watermark (the arrival read while the
 * head was still resident and watched: see `parkRetiredHead` and `pollParkedRetiredHeads` in `projectorService.ts`).
 *
 * `AM_ORDINARY_RETIRED_HEAD_PARK_MS`; 0 disables parking (every retired head
 * stays watched and leased, as before). Not the fold's `retainMs`: that is how
 * long a folded document must outlive its LISTING before GC, and the fold
 * itself gives the lease back as soon as its sources are settled.
 */
export function ordinaryRetiredHeadParkMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return envNumber('AM_ORDINARY_RETIRED_HEAD_PARK_MS', {
    fallback: 600_000, minimum: 0, maximum: 86_400_000, integer: true,
  }, env)
}

/** The highest content arrival of each document, as text (a BIGINT), or null
 * for a document with no content chunk. Same indexed question as
 * `foldedHeadsWithArrivals`, for documents named by the caller rather than by
 * `folded` rows: a parked retired head has a `retired` row and no watermark
 * column of its own. */
export async function documentContentArrivals(
  db: Queryable,
  documentIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (!documentIds.length) return new Map()
  const { rows } = await db.query<{ document_id: string; max_seq: string | null }>(
    `SELECT d.id AS document_id, s.max_seq::text AS max_seq
       FROM unnest($1::text[]) AS d(id)
       CROSS JOIN LATERAL (
         SELECT max(arrival_seq) AS max_seq FROM automerge_storage
          WHERE split_part(key, '/', 1) = d.id AND ${documentContentChunkFilter()}
       ) s`,
    [[...documentIds]],
  )
  return new Map(rows.map((row) => [row.document_id, row.max_seq]))
}

/** Every content chunk of one document (snapshots first), and the highest
 * arrival among THEM, from ONE statement: the handover re-check merges exactly
 * what it read, and advances a watermark to nothing it did not read. */
export async function documentContentChunks(
  db: Queryable,
  documentId: string,
): Promise<{ chunks: Uint8Array[]; maxSeq: string | null }> {
  const { rows } = await db.query<{ data: Uint8Array; seq: string | null }>(
    `SELECT data, arrival_seq::text AS seq FROM automerge_storage
      WHERE split_part(key, '/', 1) = $1 AND ${documentContentChunkFilter()}
      ORDER BY CASE split_part(key, '/', 2) WHEN 'snapshot' THEN 0 ELSE 1 END, key`,
    [documentId],
  )
  let maxSeq: string | null = null
  for (const row of rows) maxSeq = laterArrival(maxSeq, row.seq)
  return { chunks: rows.map((row) => row.data), maxSeq }
}

/** The later of two arrivals (text BIGINTs, or null for none). */
export function laterArrival(a: string | null, b: string | null): string | null {
  return arrivalAbove(b, a) ? b : a
}

/** Owed heads one poll re-checks at most; the rest wait for the next poll. */
export const HANDOVER_RECHECK_PER_POLL = 8
/** Failed re-checks of one head before it is given up (and logged). */
export const HANDOVER_RECHECK_MAX_ATTEMPTS = 5
/** Re-check merges (a storage read and a decode) running at once, per process. */
export const HANDOVER_RECHECK_PERMITS = 4
/** How long the barrier waits before saying so, and again after each period. */
export const HANDOVER_BARRIER_WARN_MS = 60_000

/** The re-check's delay: the knob, plus jitter of up to half of it, at most
 * 60 s, so a mass takeover does not re-check every workspace at once. */
export function handoverRecheckDelay(recheckMs: number, random: number = Math.random()): number {
  return recheckMs + Math.floor(Math.min(1, Math.max(0, random)) * Math.min(60_000, recheckMs / 2))
}

/** The database's clock in microseconds since the epoch, as text (a BIGINT):
 * what the barrier compares `xact_start` with. */
export async function databaseNow(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ now: string }>(
    `SELECT (extract(epoch FROM now()) * 1000000)::bigint::text AS now`,
  )
  return rows[0]!.now
}

interface StorageWriteBackends {
  /** When the scan ran, database clock, µs since the epoch (text). */
  takenUs: string
  rows: ReadonlyArray<{ pid: number; xactUs: string; xactStart: string }>
}
/** How long one scan serves every projector of the process that asks. */
const BACKEND_SCAN_SHARE_MS = 250
const backendScans = new WeakMap<object, Map<string, { promise: Promise<StorageWriteBackends>; doneAt: number | null }>>()

/** One scan of the storage-write backends of OTHER processes in a
 * transaction, shared by every caller of the process with the same `db` and
 * `own` while in flight and for `BACKEND_SCAN_SHARE_MS` after (a mass
 * takeover attaches many workspaces at once). */
function scanStorageWriteBackends(db: Queryable, own: string): Promise<StorageWriteBackends> {
  let byOwn = backendScans.get(db)
  if (!byOwn) { byOwn = new Map(); backendScans.set(db, byOwn) }
  const cached = byOwn.get(own)
  if (cached && (cached.doneAt === null || Date.now() - cached.doneAt < BACKEND_SCAN_SHARE_MS)) return cached.promise
  const entry: { promise: Promise<StorageWriteBackends>; doneAt: number | null } = { promise: Promise.resolve({ takenUs: '0', rows: [] }), doneAt: null }
  entry.promise = (async () => {
    try {
      // The clock and the scan in ONE statement: `now()` is the statement's
      // start, so the time a scan claims is never later than what it saw —
      // an empty scan included (a separate clock read after it could be).
      const { rows } = await db.query<{ pid: number | null; xact_us: string | null; xact_start: string | null; taken_us: string }>(
        `SELECT (extract(epoch FROM now()) * 1000000)::bigint::text AS taken_us,
                a.pid, a.xact_us, a.xact_start
           FROM (SELECT 1) AS clock
           LEFT JOIN LATERAL (
             SELECT pid, (extract(epoch FROM xact_start) * 1000000)::bigint::text AS xact_us,
                    xact_start::text AS xact_start
               FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND backend_type = 'client backend' AND state IS DISTINCT FROM 'idle'
                AND starts_with(application_name, $1) AND application_name <> $2
                AND xact_start IS NOT NULL
           ) a ON true
          ORDER BY a.xact_start`,
        [STORAGE_WRITE_APPLICATION_PREFIX, own],
      )
      const takenUs = rows[0]!.taken_us
      const backends = rows.filter((row): row is { pid: number; xact_us: string; xact_start: string; taken_us: string } => row.pid !== null)
      return { takenUs, rows: backends.map((row) => ({ pid: row.pid, xactUs: row.xact_us, xactStart: row.xact_start })) }
    } catch (error) {
      if (byOwn!.get(own) === entry) byOwn!.delete(own)
      throw error
    } finally {
      entry.doneAt = Date.now()
    }
  })()
  byOwn.set(own, entry)
  return entry.promise
}

/**
 * THE BARRIER (see THE HANDOVER RESIDUAL): the STORAGE-WRITE backends of this
 * database (`application_name` starting `STORAGE_WRITE_APPLICATION_PREFIX`,
 * `storageWritePoolConfig`) of OTHER processes than this one (`own`, this
 * process's name: its own saves are covered by the in-process argument), that
 * run a transaction started before `since` (a `databaseNow` value). Empty
 * means every such transaction — any old-owner save among them — has ended.
 * Nothing else counts: not `pg_dump`, a migration, a `psql` session, another
 * service. `xact_start` is NULL for an idle session (never counted) and for
 * another role's session without `pg_read_all_stats` (NOT seen: the cells
 * must connect as the same role). One scan of the backend array,
 * `max_connections` rows, SHARED by the process's projectors
 * (`scanStorageWriteBackends`) — but never one taken before `since`: a scan
 * older than the caller's attach could miss a transaction that started in
 * between, so the caller then asks for a fresh one.
 */
export async function handoverBarrierBlockers(
  db: Queryable,
  since: string,
  own: string,
): Promise<{ pids: number[]; oldest: string | null }> {
  const sinceUs = BigInt(since)
  let scan = await scanStorageWriteBackends(db, own)
  if (BigInt(scan.takenUs) < sinceUs) {
    backendScans.get(db)?.delete(own)
    scan = await scanStorageWriteBackends(db, own)
  }
  const blocking = scan.rows.filter((row) => BigInt(row.xactUs) < sinceUs)
  return { pids: blocking.map((row) => row.pid), oldest: blocking[0]?.xactStart ?? null }
}

/** The barrier's longest wait, `AM_ORDINARY_FOLD_HANDOVER_BARRIER_MAX_WAIT_MS`
 * (default 5 min, at least 1 s): past it the re-check runs anyway, and one
 * follow-up re-check is scheduled for when the barrier clears (or one more
 * maximum wait). */
export function ordinaryHandoverBarrierMaxWaitMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return envNumber('AM_ORDINARY_FOLD_HANDOVER_BARRIER_MAX_WAIT_MS', {
    fallback: 300_000, minimum: 1_000, maximum: 3_600_000, integer: true,
  }, env)
}

let handoverBarrierTimeouts = 0
/** Count one barrier that reached its maximum wait (process-wide). */
export function noteHandoverBarrierTimeout(): void { handoverBarrierTimeouts += 1 }
/** `maplespire_read_model_handover_recheck_barrier_timeouts_total`. */
export function handoverBarrierTimeoutCount(): number { return handoverBarrierTimeouts }

let handoverRechecksAbandoned = 0
/** Count one owed head given up after `HANDOVER_RECHECK_MAX_ATTEMPTS` (process-wide). */
export function noteHandoverRecheckAbandoned(): void { handoverRechecksAbandoned += 1 }
/** `maplespire_read_model_handover_recheck_abandoned_total`. */
export function handoverRecheckAbandonedCount(): number { return handoverRechecksAbandoned }

let recheckPermitsInUse = 0
const recheckPermitWaiters: Array<() => void> = []
/** Run `fn` under one of the process's `HANDOVER_RECHECK_PERMITS`. */
export async function withHandoverRecheckPermit<T>(fn: () => Promise<T>): Promise<T> {
  if (recheckPermitsInUse < HANDOVER_RECHECK_PERMITS) recheckPermitsInUse += 1
  else await new Promise<void>((resolve) => { recheckPermitWaiters.push(resolve) })
  try {
    return await fn()
  } finally {
    // Handed to the next waiter as is, or given back.
    const next = recheckPermitWaiters.shift()
    if (next) next()
    else recheckPermitsInUse -= 1
  }
}

/** How many times a park, or a parked head's release, waits on a stamp keyed
 * by that head before dropping it (`waitForStamp`, `projectorService.ts`). */
export const PARKED_STAMP_MAX_WAITS = 5

/** Wait for a pending stamp, or drop it? Wait only while its target is the
 * current write head (whose projection consumes stamps) and fewer than
 * `maxWaits` waits have passed. */
export function parkedStampWait(waits: number, targetProjects: boolean, maxWaits = PARKED_STAMP_MAX_WAITS): 'wait' | 'drop' {
  return targetProjects && waits < maxWaits ? 'wait' : 'drop'
}

/** Is arrival `seq` (text BIGINT, or null) above `watermark` (same)? */
export function arrivalAbove(seq: string | null, watermark: string | null): boolean {
  if (seq === null) return false
  if (watermark === null) return true
  return BigInt(seq) > BigInt(watermark)
}

/** Advance a folded head's watermark from the value the poll read (a CAS: a
 * concurrent poll that moved it wins). Returns whether it moved. */
export async function advanceFoldedArrivalWatermark(
  db: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  documentId: string,
  expected: string | null,
  next: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE read_model_ordinary_head_retirements
        SET arrival_watermark = $6::bigint, updated_at = now()
      WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND document_id = $4
        AND status = 'folded'
        AND arrival_watermark IS NOT DISTINCT FROM $5::bigint`,
    [key.landscapeId, key.versionId, collection, documentId, expected, next],
  )
  return (result.rowCount ?? 0) > 0
}
