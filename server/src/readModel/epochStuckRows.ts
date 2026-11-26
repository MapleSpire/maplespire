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

import type { PoolClient } from 'pg'
import type { MetricSample } from '../runtime/metrics.js'

/**
 * G4-16j, owner decision of 19/11/2026 (option b): the DIRECT witness of a
 * roll stopped between S6b and S7 — its `read_model_model_epochs` row still
 * `repointing` — read from the database on a cadence, whether or not a tab
 * is open. The hop-cycle gauge (`epochHopTelemetry.ts`) needs three hop
 * cycles, which one current tab never makes (it gives up after one and only
 * probes); this one is up after ONE stuck roll and stays up for as long as
 * the row stays `repointing`.
 *
 * WHICH STATE. Only `repointing`: it is the one in-flight state AFTER S6b
 * (`setState(prepared → repointing)` precedes the root's repoint), so the
 * root names the new meta, tabs hop, and their S7 proof cannot come until
 * S7. A row stuck `preparing` or `prepared` blocks the next roll, not a tab:
 * the root still names the old meta, nobody hops, and the next roll's
 * recovery abandons it (`model_epoch.roll.abandoned`).
 *
 * ORPHANS. Deleting a version or a landscape (`landscapes.ts`) does not
 * delete its `read_model_model_epochs` rows, and it does not check for a
 * roll in flight. A `repointing` row of a deleted workspace would read
 * stuck for ever, with no compaction and no operator door to clear it, so
 * the query counts only rows whose version still exists in `versions`.
 *
 * THE AGE is `now() - updated_at`: `setState` stamps `updated_at` when the
 * row enters `repointing`, and nothing writes the row again before S7
 * publishes it (`modelEpochStore.ts`: `recordSlots` and `recordMeta` only
 * touch `preparing` rows; `recordServerChangeHashes` runs at S8). The
 * operator's `epoch:resolve-repointing` door records its resolution
 * (`recordResolution`) and so restarts the age once, right before its own
 * S7.
 *
 * SEVERAL CELLS. The table is fleet-wide and every cell reads it, so every
 * cell reports the SAME rows: the gauge is a fleet fact, emitted per cell,
 * and the alert aggregates it with `max()`, never `sum()` (the convention of
 * `maplespire_read_model_workspaces`). Counting only owned workspaces was
 * rejected: a stuck workspace whose tabs all closed is owned by no cell, and
 * would vanish from the gauge while the roll is still stuck. The LOG line
 * naming the workspace and the meta is written once per row by the cell
 * that owns the workspace (every cell when ownership is off), so it is not
 * repeated per cell.
 *
 * COST AND BOUNDS (G4-16j). One query per sample on the partial
 * unique index `idx_read_model_model_epochs_in_flight` (`state IN
 * ('preparing', 'prepared', 'repointing')`, at most one row per workspace),
 * pinned by the PostgreSQL integration test, plus the `versions` primary
 * key per row found. Sampled on the cadence of the document-growth sampler
 * (`DOCUMENT_GROWTH_SAMPLE_MS`, default 60 s), in the same `index.ts`
 * block, never at scrape time. The primary pool has no statement_timeout,
 * and a sample waiting on a lock (an ALTER queued behind a long
 * transaction, a VACUUM FULL) used to pin one client per tick until the
 * pool was empty (measured on a pool of 4). Now:
 *  - at most ONE sample in flight; a tick that finds one running is
 *    skipped and counted;
 *  - the query runs in its own transaction under
 *    {@link EPOCH_STUCK_SAMPLE_TIMEOUT_MS} (enforced by the SERVER: a lock
 *    wait ends in 57014), and under a CLIENT deadline 2 s above it (a
 *    server that does not answer — failover, half-open socket,
 *    frozen storage — would otherwise hold the sample until TCP keepalive);
 *    past it the client is destroyed and the sample counts as a failure;
 *  - a sample still in flight past that deadline reads NaN on /metrics, and
 *    one older than {@link epochStuckSampleStaleMs} (the pool's own
 *    `connectionTimeoutMillis` + the client deadline + 3 s; 20 s with the
 *    default pool) is abandoned by the next tick (the client deadline does
 *    not cover `connect()`, which the pool bounds).
 * So once the pool has handed it a client, a sample holds it at most ~7 s;
 * NOT guaranteed: when `connect()` itself waits (pool exhausted), the
 * sampler waits with it, the gauge reading NaN meanwhile.
 */

/**
 * A row `repointing` longer than this counts as stuck: 10 minutes.
 *
 * Why this value. A healthy roll leaves `repointing` within its own
 * compaction pass: on a test stack the WHOLE pass
 * that carried the roll held the compaction slot 2.6 s and 2.4 s in two
 * runs, S1 to S8 included (the time in `repointing` alone was not
 * measured; it is a part of that).
 * The other bound is the tab's own patience, read from the code and NOT
 * measured: a hopping tab gives up after 10 latches in a row without the
 * S7 proof (`EPOCH_HOP_S7_PROOF_MAX_ATTEMPTS`), separated by its backoff
 * (`EPOCH_HOP_BACKOFF_MS`: 10, 30, then 60 s), about 8 min 20 s in all. A
 * row still `repointing` after 10 minutes has therefore outlived the full
 * hop of any tab that was open when the root moved: every one of them has
 * already paid its ten freezes and given up.
 */
export const EPOCH_STUCK_REPOINTING_AFTER_MS = 10 * 60_000

/**
 * The sample query's statement_timeout: 5 s. The query itself executes in
 * 0.04 ms (EXPLAIN ANALYZE, measured on a test stack); anything near this
 * ceiling is a lock wait, which statement_timeout bounds too. Well under
 * the 60 s cadence, so a timed-out sample never overlaps the next tick.
 */
export const EPOCH_STUCK_SAMPLE_TIMEOUT_MS = 5_000

/**
 * How long past its statement_timeout a query may go unanswered before the
 * CLIENT gives up on it: 2 s. statement_timeout is
 * enforced by the backend; a backend that does not run or a reply that does
 * not come back (primary failover, half-open socket, frozen storage) is
 * bounded by nothing but TCP keepalive — `dbConfig.ts` sets `keepAlive`
 * with the OS default delay, about 2 h 11 on Linux. The margin covers the
 * four round trips of {@link queryWithStatementTimeout} on a live server.
 */
export const CLIENT_DEADLINE_MARGIN_MS = 2_000
/** The error code of a query the client gave up on (not a SQLSTATE). */
export const CLIENT_DEADLINE_CODE = 'CLIENT_DEADLINE'

interface Connectable {
  connect(): Promise<Pick<PoolClient, 'query' | 'release'>>
}

/** Best effort: close the socket of a client given up on, so its pending
 * query rejects now instead of when the OS notices the peer is gone.
 *
 * PRIVATE pg API: `client.connection.stream` is not part
 * of node-postgres' public interface (pg 8). If a pg upgrade renames it,
 * this becomes a no-op, silently: the deadline still rejects and pg-pool
 * still removes the client (`release(err)`), only the socket lingers until
 * the OS closes it. Removing it was measured as equivalent under
 * `docker pause` (same removals, pool serving again, `pool.end()` settling). */
function destroySocket(client: unknown): void {
  const stream = (client as { connection?: { stream?: { destroy?: (error?: Error) => void } } }).connection?.stream
  try { stream?.destroy?.() } catch { /* already closed */ }
}

/**
 * One read-only statement in its own transaction under
 * `SET LOCAL statement_timeout` (`ms`, an integer), and a CLIENT deadline
 * `ms + CLIENT_DEADLINE_MARGIN_MS` over BEGIN … COMMIT.
 *
 * What it guarantees, once `connect()` has handed a client (the pool bounds
 * `connect()` itself: `connectionTimeoutMillis`, 10 s by default):
 *  - it settles by the client deadline at the latest; past it, it rejects
 *    with {@link CLIENT_DEADLINE_CODE}, the client is released WITH an error
 *    (pg-pool removes it from its accounting at once and ends it) and its
 *    socket destroyed;
 *  - the client is released exactly once: the abandoned work's own
 *    ROLLBACK and release are skipped, and whatever it later settles with
 *    is dropped, never returned;
 *  - otherwise as before: given back after COMMIT or a successful
 *    ROLLBACK (a 57014 included), destroyed when the ROLLBACK failed.
 */
export async function queryWithStatementTimeout<T>(
  db: Connectable, sql: string, values: unknown[], ms: number,
  deadlineMs: number = ms + CLIENT_DEADLINE_MARGIN_MS,
): Promise<{ rows: T[] }> {
  const client = await db.connect()
  let released = false
  const release = (error?: Error) => {
    if (released) return
    released = true
    client.release(error)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error(`query abandoned by the client after ${deadlineMs} ms`), { code: CLIENT_DEADLINE_CODE })
      release(error)
      destroySocket(client)
      reject(error)
    }, deadlineMs)
  })
  const work = (async () => {
    let broken: Error | undefined
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(ms))}ms'`)
      const result = await client.query(sql, values) as unknown as { rows: T[] }
      await client.query('COMMIT')
      return result
    } catch (error) {
      if (!released) await client.query('ROLLBACK').catch((rollbackError: Error) => { broken = rollbackError })
      throw error
    } finally {
      release(broken)
    }
  })()
  // Abandoned at the deadline, `work` may still reject later: dropped.
  work.catch(() => undefined)
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

export interface StuckRepointingRow {
  landscapeId: string
  versionId: string
  epochNo: number
  metaUrl: string | null
  stuckSeconds: number
}

/** The sample's query, exported so its plan is pinned on the real text
 * `$1`: the threshold in seconds. */
export const STUCK_REPOINTING_SQL = `SELECT e.landscape_id, e.version_id, e.epoch_no, e.meta_url,
              EXTRACT(EPOCH FROM (now() - e.updated_at)) AS stuck_seconds
         FROM read_model_model_epochs e
        WHERE e.state = 'repointing'
          AND e.updated_at < now() - make_interval(secs => $1::double precision)
          AND EXISTS (SELECT 1 FROM versions v WHERE v.landscape_id = e.landscape_id AND v.id = e.version_id)`

/**
 * After how long the next tick abandons a sample in flight: the pool's own
 * patience for a client (`connectionTimeoutMillis`,
 * `DB_CONNECTION_TIMEOUT_MS`, 10 s by default) plus the client deadline
 * (5 + 2 s) plus 3 s of slack — never shorter than what the pool may
 * legitimately make it wait. 20 s with the default pool.
 */
export function epochStuckSampleStaleMs(connectionTimeoutMs: number): number {
  return connectionTimeoutMs + EPOCH_STUCK_SAMPLE_TIMEOUT_MS + CLIENT_DEADLINE_MARGIN_MS + 3_000
}
/** The pool default (`dbConfig.ts`), when the pool does not say. */
export const DEFAULT_POOL_CONNECTION_TIMEOUT_MS = 10_000
/** {@link epochStuckSampleStaleMs} for the default pool: 20 s. */
export const EPOCH_STUCK_SAMPLE_STALE_MS = epochStuckSampleStaleMs(DEFAULT_POOL_CONNECTION_TIMEOUT_MS)

/** The `connectionTimeoutMillis` a pg Pool was built with, or the default
 * (0 in pg means "wait for ever": the default is taken then too, and the
 * client deadline still bounds everything after connect()). */
export function poolConnectionTimeoutMs(db: unknown): number {
  const value = (db as { options?: { connectionTimeoutMillis?: unknown } }).options?.connectionTimeoutMillis
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_POOL_CONNECTION_TIMEOUT_MS
}

/** The rows `repointing` for longer than `olderThanMs`, of versions that
 * still exist. Empty when the epoch table does not exist. */
export async function stuckRepointingRows(db: Connectable, olderThanMs = EPOCH_STUCK_REPOINTING_AFTER_MS): Promise<StuckRepointingRow[]> {
  try {
    const { rows } = await queryWithStatementTimeout<{ landscape_id: string; version_id: string; epoch_no: number; meta_url: string | null; stuck_seconds: number | string }>(db,
      STUCK_REPOINTING_SQL, [olderThanMs / 1000], EPOCH_STUCK_SAMPLE_TIMEOUT_MS)
    return rows.map((r) => ({
      landscapeId: r.landscape_id, versionId: r.version_id, epochNo: Number(r.epoch_no),
      metaUrl: r.meta_url, stuckSeconds: Number(r.stuck_seconds),
    }))
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') return []
    throw error
  }
}

export interface EpochStuckRowsSnapshot {
  /** NaN before the first sample and after a failed one: unknown, not 0. */
  stuck: number
  oldestSeconds: number
  sampledAt: number | null
  failures: number
  /** Ticks skipped because the previous sample was still running. */
  skipped: number
}

export class EpochStuckRowsSampler {
  private snap: EpochStuckRowsSnapshot = { stuck: Number.NaN, oldestSeconds: Number.NaN, sampledAt: null, failures: 0, skipped: 0 }
  /** Rows already logged, by landscape/version/epoch; pruned to the rows
   * still stuck, so a row that leaves and comes back is logged again. */
  private readonly logged = new Set<string>()
  /** The sample in flight (its token and start), or null. A sample writes
   * the snapshot and clears this only while it is still the current one:
   * an abandoned sample that settles late changes nothing. */
  private inFlight: { since: number } | null = null

  constructor(
    private readonly db: Connectable,
    private readonly owns: (key: { landscapeId: string; versionId: string }) => boolean = () => true,
    private readonly log: (line: string) => void = (line) => console.warn(line),
    private readonly now: () => number = () => Date.now(),
    /** From the pool's own connect patience. */
    readonly staleMs: number = epochStuckSampleStaleMs(poolConnectionTimeoutMs(db)),
  ) {}

  /** One sample; never rejects. Skipped (and counted) while one runs —
   * unless that one is older than `staleMs` ({@link epochStuckSampleStaleMs}):
   * it is then abandoned, counted as a failure, and a new one starts. */
  async sample(): Promise<void> {
    const running = this.inFlight
    if (running) {
      if (this.now() - running.since < this.staleMs) {
        this.snap = { ...this.snap, skipped: this.snap.skipped + 1 }
        return
      }
      this.snap = { ...this.snap, stuck: Number.NaN, oldestSeconds: Number.NaN, failures: this.snap.failures + 1 }
      console.warn('[model-epoch] a stuck-repointing sample never settled; abandoned, the gauge reads NaN')
    }
    const token = { since: this.now() }
    this.inFlight = token
    try {
      await this.sampleOnce(token)
    } catch (error) {
      // Nothing may escape the `void sample()` of the timer.
      console.warn('[model-epoch] the stuck-repointing sampler failed', error)
    } finally {
      if (this.inFlight === token) this.inFlight = null
    }
  }

  private async sampleOnce(token: { since: number }): Promise<void> {
    let rows: StuckRepointingRow[]
    try {
      rows = await stuckRepointingRows(this.db)
    } catch (error) {
      if (this.inFlight !== token) return
      this.snap = { ...this.snap, stuck: Number.NaN, oldestSeconds: Number.NaN, sampledAt: this.now(), failures: this.snap.failures + 1 }
      console.warn('[model-epoch] the stuck-repointing sample failed; the gauge reads NaN until the next one', error)
      return
    }
    if (this.inFlight !== token) return // abandoned meanwhile: a newer sample owns the snapshot
    // The gauge first: a failing owns() or log() must not hide the rows.
    this.snap = {
      ...this.snap,
      stuck: rows.length,
      oldestSeconds: rows.reduce((max, row) => Math.max(max, row.stuckSeconds), 0),
      sampledAt: this.now(),
    }
    const current = new Set<string>()
    for (const row of rows) {
      const id = `${row.landscapeId}/${row.versionId}/${row.epochNo}`
      current.add(id)
      if (this.logged.has(id) || !this.owns(row)) continue
      this.logged.add(id)
      this.log(JSON.stringify({
        event: 'model_epoch.roll_stuck_repointing', landscapeId: row.landscapeId, versionId: row.versionId,
        epochNo: row.epochNo, metaUrl: row.metaUrl, stuckSeconds: Math.round(row.stuckSeconds),
        detail: 'the roll is stopped between S6b and S7; see https://github.com/MapleSpire/maplespire-sponsor-kit/blob/main/docs/operations/read-model-projector-health.md#runbook-epochhopstalled',
      }))
    }
    for (const id of this.logged) if (!current.has(id)) this.logged.delete(id)
  }

  snapshot(): EpochStuckRowsSnapshot {
    return { ...this.snap }
  }

  samples(): MetricSample[] {
    // A sample in flight past its client deadline means no
    // current answer — NaN, never the last value (EpochStuckRowsSamplerBlind
    // sees a NaN, not a frozen number).
    const late = this.inFlight !== null
      && this.now() - this.inFlight.since > EPOCH_STUCK_SAMPLE_TIMEOUT_MS + CLIENT_DEADLINE_MARGIN_MS
    const s = late ? { ...this.snap, stuck: Number.NaN, oldestSeconds: Number.NaN } : this.snap
    return [
      {
        name: 'maplespire_model_epoch_rows_stuck_repointing',
        help: 'Model epoch rows in repointing (the root repointed at S6b, S7 not done) for more than 10 minutes, of versions that still exist, fleet-wide: every cell reads the same table, aggregate with max(). NaN before the first sample and after a failed one.',
        type: 'gauge',
        values: [{ value: s.stuck }],
      },
      {
        name: 'maplespire_model_epoch_rows_stuck_repointing_oldest_seconds',
        help: 'How long the oldest stuck repointing row has been repointing, in seconds; 0 when none, NaN when unknown.',
        type: 'gauge',
        values: [{ value: s.oldestSeconds }],
      },
      {
        name: 'maplespire_model_epoch_stuck_rows_sample_failures_total',
        help: 'Samples of the stuck-repointing rows that failed, a 5 s statement timeout included (the gauge read NaN until the next one).',
        type: 'counter',
        values: [{ value: s.failures }],
      },
      {
        name: 'maplespire_model_epoch_stuck_rows_samples_skipped_total',
        help: 'Ticks of the stuck-repointing sampler skipped because the previous sample was still running.',
        type: 'counter',
        values: [{ value: s.skipped }],
      },
    ]
  }
}

let processSampler: EpochStuckRowsSampler | null = null

/** Start the process's sampler on `intervalMs` (index.ts, beside the
 * document-growth sampler): a first sample at once, then one per tick;
 * returns its stop. */
export function startEpochStuckRowsSampler(
  db: Connectable,
  intervalMs: number,
  owns?: (key: { landscapeId: string; versionId: string }) => boolean,
  sampler: EpochStuckRowsSampler = new EpochStuckRowsSampler(db, owns),
): () => void {
  processSampler = sampler
  let stopped = false
  const run = () => { if (!stopped) void sampler.sample() }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer) }
}

/** The /metrics samples; empty until the sampler started (index.ts starts
 * it at boot, before the routes serve). */
export function epochStuckRowsMetricSamples(sampler: EpochStuckRowsSampler | null = processSampler): MetricSample[] {
  return sampler ? sampler.samples() : []
}
