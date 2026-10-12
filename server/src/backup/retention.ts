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

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Queryable } from './backupRestore.js'
import {
  bundleOwnerLiveness,
  readBundleOwner,
  type BundleOwner,
  type BundleOwnerLiveness,
} from './bundleOwner.js'

/**
 * Autoclean for `backup_drill_runs`, budgeted in BYTES.
 *
 * The table carries a whole drill report inline as JSONB, and reports are not a
 * uniform size: a passing run is a few kilobytes, while a run that failed with
 * sixty named unopenable workspaces, or one configured with 1,000 document
 * probes, is orders of magnitude larger. So a count-based policy ("keep the
 * last 90 runs") is not a disk budget at all — it is a disk budget multiplied by
 * an unknown, and the day it matters is the day something is going wrong and the
 * reports are at their largest. A time-based policy has the same defect.
 * Budgeting the thing that actually runs out is the point.
 *
 * Two rows are protected from the budget, both for the same reason: retention
 * must never manufacture an alert.
 *
 *  - **The most recent PASSING run.** Deleting it makes
 *    `maplespire_backup_drill_last_success_age_seconds` read NaN, which is the
 *    signal for "no drill has ever passed" — an alert, produced by housekeeping,
 *    about a backup that is fine.
 *  - **The most recent `minimumRows` runs**, so a failure streak stays legible.
 *    `failures_since_success` is computed from these rows; pruning them would
 *    quietly walk the count back toward zero while the failures continue.
 *
 * If the protected rows alone exceed the budget, they are kept and the result
 * reports `bytesAfter` above `budgetBytes`. Overflowing honestly beats deleting
 * the evidence the budget exists to preserve.
 */

const DEFAULT_BUDGET_BYTES = 64 * 1024 * 1024
const MINIMUM_BUDGET_BYTES = 64 * 1024
const DEFAULT_MINIMUM_ROWS = 10
/** Bundles are the big consumer — a dump plus the icon archive, every run. */
const DEFAULT_BUNDLE_BUDGET_BYTES = 20 * 1024 * 1024 * 1024

export type DrillRetentionResult = {
  budgetBytes: number
  bytesBefore: number
  bytesAfter: number
  rowsBefore: number
  deleted: number
  /** True when the protected rows alone do not fit — the budget is too small
   * for this installation's report size, and that is worth surfacing. */
  overBudget: boolean
}

/**
 * `BACKUP_DRILL_HISTORY_MAX_BYTES`, accepting a plain byte count or a `KB`/`MB`/
 * `GB` suffix, because an operator writing a disk budget writes `256MB`.
 * Anything unparseable falls back to the default rather than to zero: a typo
 * must not empty the history.
 */
export function parseByteBudget(raw: string | undefined, fallback: number): number {
  const value = raw?.trim()
  if (!value) return fallback
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i.exec(value)
  if (!match) return fallback
  const multiplier = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[
    (match[2] ?? 'b').toLowerCase() as 'b' | 'kb' | 'mb' | 'gb' | 'tb'
  ]
  const bytes = Math.floor(Number(match[1]) * multiplier)
  if (!Number.isFinite(bytes) || bytes < MINIMUM_BUDGET_BYTES) return fallback
  return bytes
}

export function drillHistoryBudgetBytes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return parseByteBudget(env.BACKUP_DRILL_HISTORY_MAX_BYTES, DEFAULT_BUDGET_BYTES)
}

export function bundleBudgetBytes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return parseByteBudget(env.BACKUP_BUNDLE_MAX_BYTES, DEFAULT_BUNDLE_BUDGET_BYTES)
}

export async function pruneDrillHistory(
  db: Queryable,
  options: { budgetBytes?: number; minimumRows?: number } = {},
): Promise<DrillRetentionResult> {
  const budgetBytes = options.budgetBytes ?? drillHistoryBudgetBytes()
  const minimumRows = Math.max(1, options.minimumRows ?? DEFAULT_MINIMUM_ROWS)

  // `pg_column_size(t.*)` is the row's size after TOAST compression, which is
  // what the JSONB report actually occupies. It excludes per-page and index
  // overhead, so the budget is a floor on the table's footprint rather than an
  // exact figure — documented rather than fudged with a multiplier.
  const { rows: before } = await db.query<{ bytes: string; rows: string }>(
    `SELECT COALESCE(sum(pg_column_size(t.*)), 0)::text AS bytes, count(*)::text AS rows
     FROM backup_drill_runs t`,
  )
  const bytesBefore = Number(before[0]?.bytes ?? 0)
  const rowsBefore = Number(before[0]?.rows ?? 0)

  const { rows: deleted } = await db.query<{ id: string }>(
    // `finished_at DESC, id DESC` throughout: two runs can share a timestamp,
    // and a non-deterministic order would make the cumulative sum — and so the
    // cut — differ between the measuring pass and the deleting pass.
    `WITH sized AS (
       SELECT id, outcome, finished_at,
              pg_column_size(t.*)::bigint AS bytes,
              row_number() OVER (ORDER BY finished_at DESC, id DESC) AS recency,
              row_number() OVER (
                PARTITION BY outcome ORDER BY finished_at DESC, id DESC
              ) AS outcome_recency
       FROM backup_drill_runs t
     ), cumulative AS (
       SELECT id, recency, outcome, outcome_recency,
              sum(bytes) OVER (
                ORDER BY finished_at DESC, id DESC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              ) AS running_bytes
       FROM sized
     )
     DELETE FROM backup_drill_runs
     WHERE id IN (
       SELECT id FROM cumulative
       WHERE running_bytes > $1
         AND recency > $2
         AND NOT (outcome = 'passed' AND outcome_recency = 1)
     )
     RETURNING id`,
    [budgetBytes, minimumRows],
  )

  const { rows: after } = await db.query<{ bytes: string }>(
    `SELECT COALESCE(sum(pg_column_size(t.*)), 0)::text AS bytes FROM backup_drill_runs t`,
  )
  const bytesAfter = Number(after[0]?.bytes ?? 0)
  return {
    budgetBytes,
    bytesBefore,
    bytesAfter,
    rowsBefore,
    deleted: deleted.length,
    overBudget: bytesAfter > budgetBytes,
  }
}

export type PartialBundle = {
  name: string
  bytes: number
  /**
   * The most CONSERVATIVE age of the two independent clocks below — the smaller
   * number, so a directory is only old when both agree it is. `null` when
   * neither could be read, which is the one case the sweep refuses to act on.
   */
  ageMs: number | null
  /**
   * Milliseconds since the run that owns this directory started, from the
   * timestamp in the name. Written by `bundleName` in the SCHEDULER, not by
   * `createDatabaseBackup` — which simply appends `.partial-<pid>-<hex>` to
   * whatever path it is handed. So a bundle taken by the one-shot CLI, whose
   * name the operator chooses, has no timestamp here at all.
   */
  nameAgeMs: number | null
  /**
   * Milliseconds since the newest write ANYWHERE inside the directory. This is
   * the signal that does not need a rival to share our configuration: a live
   * `pg_dump` advances it continuously, so a directory nobody has touched in
   * hours is dead however it was named.
   *
   * Safe as an age gate even though it is unsafe for ORDERING: `cp -a`/
   * `rsync -a`/a volume move preserve mtime, and plain `cp`/`tar -x` set it to
   * now — younger, therefore on the keep side. `null` when the walk could not
   * read it.
   */
  mtimeAgeMs: number | null
  /**
   * The claim the writer left on the directory (`.owner.json`), or `null` when
   * there is none — an older build's partial, or a write that failed. Carried as
   * a FACT rather than folded into the verdict below, because "no claim" and "a
   * claim from a host I cannot ask about" are different situations that happen
   * to share an outcome today.
   */
  owner: BundleOwner | null
  /**
   * Whether that claim still answers: `live`, `dead`, or `unknown`.
   *
   * THREE values, and the third is the point. Both age clocks above are proxies
   * for "is someone still writing this", and a `pg_dump` blocked on a lock
   * advances neither while being very much alive. This asks the process
   * directly. `unknown` covers a claim from another host, an absent claim, and
   * a probe that could not be performed; none of those is `dead`.
   */
  ownerLiveness: BundleOwnerLiveness
}

export type BundleRetentionResult = {
  budgetBytes: number
  bytesBefore: number
  bytesAfter: number
  bundlesBefore: number
  deleted: string[]
  /** Subdirectories that are not bundles. Reported rather than ignored: a
   * non-empty list means the sweep is pointed somewhere unexpected. */
  skipped: string[]
  /** Unfinished bundles that SURVIVED this sweep — either young enough that a
   * live run may still own them, or unnameable. Never a deletion candidate for
   * the byte budget. */
  partials: PartialBundle[]
  /** Bytes held by `partials`. Deliberately NOT folded into `bytesBefore`:
   * that number drives CANDIDACY, and counting corpses against it would make
   * the sweep delete finished, restorable bundles to make room for them. It IS
   * counted by `overBudget`, which answers a different question — see there. */
  partialBytes: number
  /** Unfinished bundles this sweep removed because no live run could still own
   * them. Separate from `deleted`, which is the byte budget's work. */
  deletedPartials: string[]
  /** Bytes `deletedPartials` reclaimed. Without it a night that freed 40 GB and
   * a night that freed nothing both print `partialBundleBytes: 0`, because that
   * figure counts SURVIVORS. */
  deletedPartialBytes: number
  /**
   * Partials the AGE GATE would have removed and a live owner saved.
   *
   * Counted separately from `partials` because it is the one outcome that can
   * grow without bound: liveness overrides age, so a claim that reads `live`
   * forever keeps its directory forever. Nothing portable in Node exposes a
   * process's start time, so a RECYCLED pid reads `live` for a writer that is
   * long gone — the keep-side failure direction this function chooses
   * everywhere, but not a free one: a full volume makes the next backup fail.
   *
   * So it is loud rather than silent: these names are reported, their bytes are
   * inside `partialBytes` and therefore inside `overBudget`, and an operator
   * seeing the same name held night after night has the pid and host to check.
   */
  heldPartials: string[]
  /**
   * Is the volume at risk — which is not the same question as which
   * directories were candidates, so partial bytes are counted HERE even though
   * they are exempt above. A root full of abandoned partials must not report
   * `overBudget: false`.
   */
  overBudget: boolean
}

/**
 * `createDatabaseBackup` writes into `<bundleName>.partial-<pid>-<hex>` and
 * `rename`s only once the manifest has landed. So the marker of a FINISHED
 * bundle is the rename, and the name is the only thing that records it.
 *
 * Do not ask `manifest.json` instead: a partial killed between the manifest
 * write and the rename sorts ABOVE the bundle it was about to become
 * (`Z.partial-…` > `Z` descending), would take the `keepNewest` slot, and the
 * sweep would delete the real, restorable bundle and keep the dead partial. A
 * SIGKILL in that window is what the orchestrator does when the abort grace
 * runs out.
 */
const PARTIAL_DIRECTORY = /^(?<bundle>.+)\.partial-\d+-[0-9a-f]+$/

/**
 * `2026-08-09T02-31-07Z` — the sortable name `bundleName` (drillSchedule.ts)
 * writes.
 *
 * Producer and parser are linked by a round-trip test. A format drift would be
 * silent and total: every age `null`, every partial immortal, and the sweep a
 * permanent no-op that reports success.
 */
export const BUNDLE_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/

export function bundleStartedAt(name: string): number | null {
  const match = BUNDLE_NAME.exec(name)
  if (!match) return null
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`)
  if (!Number.isFinite(parsed)) return null
  // `Date.parse` is lenient — `2026-02-30T00-00-00Z` rolls to March 2 rather
  // than failing — and the whole "unknown falls on the KEEP side" argument
  // rests on unparseable meaning unparseable. Round-trip it.
  return new Date(parsed).toISOString().startsWith(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`)
    ? parsed
    : null
}

/** A bundle is identified by its manifest, the same file `readBackupManifest`
 * requires. Nothing without one is ever a deletion candidate. */
async function isBundleDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(join(path, 'manifest.json'))).isFile()
  } catch {
    return false
  }
}

/** One bundle directory: the dump, the manifest and the icon archive. */
async function directorySize(path: string): Promise<number> {
  return (await walkDirectory(path)).bytes
}

/**
 * Size and newest write time, in ONE walk.
 *
 * Every read is guarded: this walk runs over UNFINISHED bundles, directories
 * whose owner renames them away on success and `rm`s them on failure. Without
 * the guards, one partial vanishing mid-walk throws `ENOENT` out of
 * `pruneBackupBundles` and the byte budget does not run at all — a `stat`
 * failure on one unfinished bundle vetoing the pruning of every finished one.
 *
 * **Neither `.catch` is covered by a test.** Producing the failure needs a
 * vanish scheduled BETWEEN the root listing and this walk, which no portable
 * fixture can arrange without a seam in production code. Be suspicious of an
 * edit that removes them.
 */
async function walkDirectory(path: string): Promise<{ bytes: number; newestMtimeMs: number | null }> {
  let bytes = 0
  let newestMtimeMs: number | null = null
  const note = (value: number): void => {
    newestMtimeMs = newestMtimeMs === null ? value : Math.max(newestMtimeMs, value)
  }
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      const nested = await walkDirectory(child)
      bytes += nested.bytes
      if (nested.newestMtimeMs !== null) note(nested.newestMtimeMs)
      continue
    }
    if (!entry.isFile()) continue
    const info = await stat(child).catch(() => null)
    if (info === null) continue
    bytes += info.size
    note(info.mtimeMs)
  }
  return { bytes, newestMtimeMs }
}

/**
 * Keep the newest bundles that fit in a byte budget; delete the rest.
 *
 * The same reasoning as the drill history, one order of magnitude up: a bundle
 * is a full dump plus the icon archive, written on every run, and a daily
 * schedule with no ceiling fills the volume — at which point the next backup
 * fails, and the failure is caused by the backups. The most recent bundle is
 * never deleted, however large: a retention sweep that leaves an installation
 * with no restorable bundle has inverted its own purpose.
 *
 * Ordering is by directory NAME, descending. The scheduler names bundles with a
 * sortable UTC timestamp, so this is chronological without trusting mtime —
 * which a copy, a restore rehearsal or a filesystem move would rewrite.
 *
 * Unfinished bundles (`<name>.partial-<pid>-<hex>`) are classified by NAME and
 * are never candidates for the byte budget. They have their own sweep, gated on
 * two independent clocks plus an owner-liveness veto, and disabled unless the
 * caller passes `partialMaxAgeMs` — see `PARTIAL_DIRECTORY` and
 * `PartialBundle`. Their bytes are exempt from CANDIDACY and counted by
 * `overBudget`.
 *
 * **A FINISHED directory is only a deletion candidate if it contains
 * `manifest.json`.**
 * This function recursively deletes, and its root (`BACKUP_BUNDLE_ROOT`) is
 * operator-configured. `BACKUP_DIRECTORY` means ONE bundle to the CLI scripts,
 * so an operator pointing the sweep at the wrong directory must be harmless:
 * anything that is not identifiably ours is left alone and counted in
 * `skipped`.
 */
export async function pruneBackupBundles(
  root: string,
  options: {
    budgetBytes?: number
    keepNewest?: number
    /**
     * How old an unfinished bundle must be before this sweep removes it.
     * OMITTED MEANS NEVER: a caller that does not know how long a drill may run
     * — the one-shot CLI, for instance — must not be able to delete a directory
     * a live `pg_dump` is filling. Pass `partialSweepMinimumAgeMs(maxDrillHold)`.
     */
    partialMaxAgeMs?: number
    /** Injected so the age gate is testable without touching the clock. */
    now?: number
    /**
     * Injected for the same reason `now` is: a test must be able to produce all
     * three liveness answers without spawning a process it then has to reap, and
     * `unknown` (a claim from another host) has no local process to spawn at
     * all. Defaults to the real probe.
     */
    ownerLiveness?: (owner: BundleOwner | null) => BundleOwnerLiveness
  } = {},
): Promise<BundleRetentionResult> {
  const liveness = options.ownerLiveness ?? ((owner) => bundleOwnerLiveness(owner))
  const budgetBytes = options.budgetBytes ?? bundleBudgetBytes()
  const keepNewest = Math.max(1, options.keepNewest ?? 1)
  const now = options.now ?? Date.now()
  let entries: string[]
  const skipped: string[] = []
  const partialNames: string[] = []
  try {
    const candidates = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
      .reverse()
    entries = []
    for (const name of candidates) {
      // By NAME first, and before the manifest is consulted at all. A partial
      // that reached its manifest write is still not a bundle: what makes a
      // bundle is the rename, and asking the directory's own contents whether
      // it is finished asks the subject to certify itself.
      if (PARTIAL_DIRECTORY.test(name)) partialNames.push(name)
      else if (await isBundleDirectory(join(root, name))) entries.push(name)
      else skipped.push(name)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        budgetBytes, bytesBefore: 0, bytesAfter: 0, bundlesBefore: 0,
        deleted: [], skipped: [], partials: [], partialBytes: 0,
        deletedPartials: [], deletedPartialBytes: 0, heldPartials: [],
        overBudget: false,
      }
    }
    throw error
  }

  // Unfinished bundles, swept by the age of the run that owns them.
  //
  // Nothing else ever removes one. `createDatabaseBackup` cleans its own
  // partial from a `catch`, but the abandonment path ends the process instead
  // of throwing — so every abandoned drill leaves a whole database dump behind.
  const partials: PartialBundle[] = []
  const deletedPartials: string[] = []
  const heldPartials: string[] = []
  let deletedPartialBytes = 0
  for (const name of partialNames) {
    const walked = await walkDirectory(join(root, name))
    const startedAt = bundleStartedAt(PARTIAL_DIRECTORY.exec(name)?.groups?.bundle ?? '')
    const nameAgeMs = startedAt === null ? null : now - startedAt
    const mtimeAgeMs = walked.newestMtimeMs === null ? null : now - walked.newestMtimeMs
    // The SMALLER of the two, so a directory is only old when both clocks
    // agree. They fail in different places: the name carries no timestamp on
    // anything the one-shot CLI wrote (the operator picks that path), and mtime
    // is absent from a directory with no files in it yet (older builds, or
    // writers other than `createDatabaseBackup`, which writes its ownership
    // claim first). Either one alone leaves a class of partial immortal or a
    // class of live run exposed.
    const ages = [nameAgeMs, mtimeAgeMs].filter((age): age is number => age !== null)
    const ageMs = ages.length === 0 ? null : Math.min(...ages)
    const owner = await readBundleOwner(join(root, name))
    const ownerLiveness = liveness(owner)
    const entry = { name, bytes: walked.bytes, ageMs, nameAgeMs, mtimeAgeMs, owner, ownerLiveness }
    // No gate given, no clock at all, or young enough that a live run may still
    // own it: keep. Every unknown falls on the KEEP side deliberately — this is
    // a recursive delete against an operator-configured root.
    if (options.partialMaxAgeMs === undefined || ageMs === null || ageMs <= options.partialMaxAgeMs) {
      partials.push(entry)
      continue
    }
    // Old by both clocks — and the clocks are PROXIES. The exclusion this drill
    // runs under is a Postgres advisory lock, which serialises schedulers and
    // nothing else: the one-shot CLI, the boot sweep and an abandoned run still
    // dumping all reach this directory holding no lock at all. A `pg_dump`
    // blocked on a lock advances neither clock while being entirely alive.
    //
    // So ask the writer. A live claim vetoes the delete — one-directionally:
    // liveness may move a directory from delete to keep and may never
    // authorise a delete the age gate refused. `unknown` falls back to the age
    // gate alone (older builds, other hosts).
    if (ownerLiveness === 'live') {
      partials.push(entry)
      heldPartials.push(name)
      continue
    }
    await rm(join(root, name), { recursive: true, force: true, maxRetries: 3 })
    deletedPartials.push(name)
    deletedPartialBytes += walked.bytes
  }
  const partialBytes = partials.reduce((sum, partial) => sum + partial.bytes, 0)

  const sizes = new Map<string, number>()
  for (const name of entries) sizes.set(name, await directorySize(join(root, name)))
  const bytesBefore = [...sizes.values()].reduce((sum, value) => sum + value, 0)

  const deleted: string[] = []
  let running = 0
  for (const [index, name] of entries.entries()) {
    running += sizes.get(name) ?? 0
    if (index < keepNewest || running <= budgetBytes) continue
    await rm(join(root, name), { recursive: true, force: true })
    deleted.push(name)
  }
  const bytesAfter = entries
    .filter((name) => !deleted.includes(name))
    .reduce((sum, name) => sum + (sizes.get(name) ?? 0), 0)
  return {
    budgetBytes,
    bytesBefore,
    bytesAfter,
    bundlesBefore: entries.length,
    deleted,
    skipped,
    partials,
    partialBytes,
    deletedPartials,
    deletedPartialBytes,
    heldPartials,
    // Partial bytes count HERE and nowhere above. Candidacy and capacity are
    // different questions and only candidacy needs the exemption. Held partials
    // are inside `partialBytes`, so a directory an immortal claim is protecting
    // still pushes the volume over budget and still says so.
    overBudget: bytesAfter + partialBytes > budgetBytes,
  }
}
