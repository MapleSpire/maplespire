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

import type { Pool } from 'pg'
import { MIGRATION_ADVISORY_LOCK_KEY } from '../db/migrations.js'
import type { MetricSample } from '../runtime/metrics.js'
import { dropRedundantObjectTrigramIndexes, REDUNDANT_OBJECT_TRIGRAM_INDEXES } from './schema.js'

/**
 * The trigram indexes the 0006 migration drops, retried IN THE BACKGROUND
 * (G4-16f). Not `idx_ro_objects_search_trgm`: it is kept.
 *
 * The migration bounds each lock wait of its `DROP INDEX CONCURRENTLY` and
 * defers on a timeout (`dropRedundantObjectTrigramIndexes`), so a boot that
 * meets a long transaction on `ro_objects` leaves the index for "the next
 * boot". A cell that is never restarted would keep it forever — and a drop
 * that failed part-way leaves it INVALID: still maintained by every write,
 * read by no plan, and (measured) absent from a pg_dump of the database. So:
 *
 *   - every `intervalMs` (one hour by default) this reads `pg_index` for
 *     those names — one catalog lookup, nothing else when none is left;
 *   - when one is present it takes the migration key WITHOUT WAITING
 *     (`pg_try_advisory_lock`: a migration or a backup in flight holds it,
 *     and the next tick retries) and runs the same bounded drop, ONE attempt
 *     per index, so a tick costs at most one lock wait per index;
 *   - `maplespire_read_model_redundant_trigram_index{index,state}` reports
 *     what the last look saw (1 = present, valid or invalid). All zero is the
 *     healthy value.
 */
export const REDUNDANT_INDEX_RETRY_INTERVAL_MS = 60 * 60 * 1000

export const RETRIED_TRIGRAM_INDEXES: readonly string[] = [...REDUNDANT_OBJECT_TRIGRAM_INDEXES]

export type RedundantIndexState = 'absent' | 'valid' | 'invalid'

export interface RedundantIndexRetrySnapshot {
  /** Per index, what the last look saw; `absent` before the first look. */
  states: Record<string, RedundantIndexState>
  attempts: { dropped: number; deferred: number; keyBusy: number; failed: number }
}

type Queryable = Pick<Pool, 'query'>

/** The state of each of `indexes` in the current schema (the one the
 *  unqualified `DROP INDEX` resolves to: `public` in a deployment). `invalid`
 *  is `NOT (indisvalid AND indisready)`: an unfinished CONCURRENTLY build or drop. */
export async function inspectRedundantTrigramIndexes(
  db: Queryable,
  indexes: readonly string[] = RETRIED_TRIGRAM_INDEXES,
): Promise<Record<string, RedundantIndexState>> {
  const { rows } = await db.query<{ name: string; valid: boolean }>(
    `SELECT c.relname AS name, (x.indisvalid AND x.indisready) AS valid
       FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
      WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ANY($1::text[])`,
    [[...indexes]],
  )
  const states: Record<string, RedundantIndexState> = {}
  for (const index of indexes) states[index] = 'absent'
  // Keys only from `indexes` (the gauge's label set stays closed).
  for (const row of rows) if (row.name in states) states[row.name] = row.valid ? 'valid' : 'invalid'
  return states
}

export class RedundantIndexDropRetry {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private snap: RedundantIndexRetrySnapshot = {
    states: Object.fromEntries(RETRIED_TRIGRAM_INDEXES.map((i) => [i, 'absent' as RedundantIndexState])),
    attempts: { dropped: 0, deferred: 0, keyBusy: 0, failed: 0 },
  }

  constructor(
    private readonly pool: Pool,
    private readonly options: { intervalMs?: number; log?: (line: string) => void } = {},
  ) {}

  start(): void {
    if (this.timer) return
    // The first look right away: the gauge must not read "absent" for an hour
    // on a boot that just deferred.
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.options.intervalMs ?? REDUNDANT_INDEX_RETRY_INTERVAL_MS)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.running?.catch(() => undefined)
  }

  snapshot(): RedundantIndexRetrySnapshot {
    return { states: { ...this.snap.states }, attempts: { ...this.snap.attempts } }
  }

  /** One look, and one bounded drop if anything is left. Never throws. */
  tick(): Promise<void> {
    if (this.running) return this.running
    this.running = this.runOnce().finally(() => { this.running = null })
    return this.running
  }

  private async runOnce(): Promise<void> {
    const indexes = RETRIED_TRIGRAM_INDEXES
    const log = this.options.log ?? ((line: string) => console.warn(line))
    try {
      const states = await inspectRedundantTrigramIndexes(this.pool, indexes)
      this.snap.states = states
      const present = indexes.filter((i) => states[i] !== 'absent')
      if (present.length === 0) return
      const client = await this.pool.connect()
      let releaseError: Error | undefined
      try {
        const { rows } = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1) AS acquired', [MIGRATION_ADVISORY_LOCK_KEY])
        if (rows[0]?.acquired !== true) {
          this.snap.attempts.keyBusy++
          return
        }
        try {
          // The drop walks the whole 0006 list; an absent one is an IF EXISTS
          // no-op, so only the present ones are counted.
          const { deferred } = await dropRedundantObjectTrigramIndexes(client, { attempts: 1, log })
          const deferredPresent = deferred.filter((index) => present.includes(index))
          this.snap.attempts.dropped += present.length - deferredPresent.length
          this.snap.attempts.deferred += deferredPresent.length
        } finally {
          const released = await client
            .query<{ released: boolean }>('SELECT pg_advisory_unlock($1) AS released', [MIGRATION_ADVISORY_LOCK_KEY])
            .then((r) => r.rows[0]?.released === true, () => false)
          if (!released) releaseError = new Error('migration advisory lock was not released; discarding the connection')
        }
      } finally {
        client.release(releaseError)
      }
      this.snap.states = await inspectRedundantTrigramIndexes(this.pool, indexes)
    } catch (error) {
      this.snap.attempts.failed++
      log(JSON.stringify({ event: 'read_model.redundant_trigram_retry_failed', error: String((error as Error)?.message ?? error) }))
    }
  }
}

/** The retry as Prometheus samples; `null` (READ_MODEL off): zeros. */
export function redundantIndexRetryMetricSamples(retry: Pick<RedundantIndexDropRetry, 'snapshot'> | null): MetricSample[] {
  const snap = retry?.snapshot() ?? {
    states: Object.fromEntries(RETRIED_TRIGRAM_INDEXES.map((i) => [i, 'absent' as RedundantIndexState])),
    attempts: { dropped: 0, deferred: 0, keyBusy: 0, failed: 0 },
  }
  return [
    {
      name: 'maplespire_read_model_redundant_trigram_index',
      help: 'A trigram index the 0006 migration drops that is still on ro_objects, by state: valid (the drop was deferred) or invalid (a DROP INDEX CONCURRENTLY failed part-way: maintained by every write, used by no plan, absent from a pg_dump). 1 = present. All zero is the healthy value; retried hourly in the background.',
      type: 'gauge',
      values: Object.entries(snap.states).flatMap(([index, state]) => [
        { labels: { index, state: 'valid' }, value: state === 'valid' ? 1 : 0 },
        { labels: { index, state: 'invalid' }, value: state === 'invalid' ? 1 : 0 },
      ]),
    },
    {
      name: 'maplespire_read_model_redundant_trigram_retry_total',
      help: 'Background retries of that drop, by outcome: dropped, deferred (a lock wait hit its bound), key_busy (a migration or backup held the migration key), failed (any other error, logged).',
      type: 'counter',
      values: [
        { labels: { outcome: 'dropped' }, value: snap.attempts.dropped },
        { labels: { outcome: 'deferred' }, value: snap.attempts.deferred },
        { labels: { outcome: 'key_busy' }, value: snap.attempts.keyBusy },
        { labels: { outcome: 'failed' }, value: snap.attempts.failed },
      ],
    },
  ]
}
