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

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  stableJson,
  type DocumentCensus,
  type ProbeCoverage,
  type Queryable,
  type RestoreVerification,
} from './backupRestore.js'
import type { RetiredWorkspace } from './workspaceRetirement.js'

/**
 * The evidence half of the drill: what ran, what it proved, and how long ago.
 *
 * Two failure modes this is built around, both of which a plain log line has.
 *
 *  - **A drill report is a compliance artifact, so it is worth forging.** "We
 *    restore-test nightly" is only worth something if the record cannot be
 *    written by anything that can append to a log. The report is HMAC-signed
 *    with a key the drill runner holds and the reviewer holds; an unsigned run
 *    is stored and clearly labelled unsigned rather than rejected, because a
 *    drill that refuses to record itself when a key is missing is worse than an
 *    unsigned record of a real restore.
 *  - **"The last drill passed" is not the question.** The question is how long
 *    ago, which is why the exported health is an AGE and why a never-run
 *    installation reports `null` rather than a comfortable zero. A gauge that
 *    reads 0 for "no drill has ever run" and 0 for "a drill just succeeded" is
 *    the same alert for opposite situations.
 */

export type DrillReport = {
  reportVersion: 1
  drillId: string
  startedAt: string
  finishedAt: string
  rtoMs: number
  outcome: 'passed' | 'failed'
  applicationRevision: string | null
  source: { database: string; postgresVersion: string; snapshotAt: string }
  /** `written` is separate from every byte count because "the drill failed
   * and a bundle exists" and "there is no backup at all" are different
   * situations: `directory` is always populated and `dumpBytes` can be 0 in
   * both. */
  bundle: {
    directory: string
    written: boolean
    dumpBytes: number
    dumpSha256: string
    manifestSha256: string
  }
  /** What the backup found out about the SOURCE, as opposed to about itself.
   *
   * Carried separately from `verification` because they fail for opposite
   * reasons and want opposite responses: a verification failure means the copy
   * cannot be trusted, a source-integrity finding means the copy is faithful to
   * a database that has something wrong with it. Folding them together would
   * let one finding delete the other's artifact. Null on older bundles written
   * without a census. */
  sourceIntegrity: SourceIntegrity | null
  verification: RestoreVerification | null
  coldApi: ColdApiOutcome | null
  retiredWorkspaces: RetiredWorkspace[]
  error: string | null
  /**
   * The run was ABANDONED: it would not stop when asked, so the process ended
   * with the drill possibly still running.
   *
   * Its consequence is entirely about `finished_at`, which for such a run is
   * the moment the scheduler gave up — **not** the moment the work stopped,
   * because nobody knows that. So the recorded window UNDERSTATES the real one,
   * and the overlap detector below cannot see an overlap that happened after
   * this timestamp. Recorded as a field so that a zero overlap count over
   * known-truncated windows reads as incomplete, not clean.
   *
   * Optional: older rows have no such key, and a missing key correctly reads
   * as "not abandoned" rather than as unknown.
   */
  abandoned?: boolean
}

export type SourceIntegrity = {
  /** `incomplete` is NOT `clean`: a census that could not be taken has not
   * cleared anything, and must not read as if it had. */
  verdict: 'clean' | 'violations' | 'incomplete'
  census: DocumentCensus | null
  probeFailures: number
  coverage: ProbeCoverage | null
  detail: string | null
}

export type ColdApiSelection = {
  projectionGroups: number
  projectionObjects: number
  eligibleProjectionGroups: number
  eligibleProjectionObjects: number
  candidateWorkspaces: number
  excludedProjectionGroups: number
  excludedProjectionObjects: number
  /** At most 25 groups, including exclusions on FAILED runs. Totals above are
   * exhaustive; excluding a group from HTTP does not exclude it from the dump. */
  excluded: Array<{
    landscapeId: string
    versionId: string
    objects: number
    status: string | null
    reason: 'missing_landscape' | 'missing_version' | 'inactive_version' | 'redirected_projection'
  }>
  exclusionsTruncated: boolean
  selected: { landscapeId: string; versionId: string; queryVersionId: string; objects: number } | null
}

export type ColdApiOutcome = {
  outcome: 'passed' | 'failed' | 'skipped'
  checks: Array<{ name: string; ok: boolean; detail: string }>
  /** Absent in older reports; null when ro_objects itself was absent. */
  selection?: ColdApiSelection | null
}

export type SignedDrillReport = {
  report: DrillReport
  reportSha256: string
  signature: string | null
  signingKeyId: string | null
}

export type DrillHealth = {
  lastSuccessAt: string | null
  lastSuccessAgeSeconds: number | null
  lastRunAt: string | null
  lastOutcome: 'passed' | 'failed' | null
  lastSuccessRtoMs: number | null
  failuresSinceLastSuccess: number
}

/**
 * Did two drills ever actually run at the same time?
 *
 * The consequence check, and the only one in this subsystem that does not
 * derive from the thing it is trying to prove. The other witnesses — did the
 * lock hold, did the deadline fire, did the unlock answer — live inside the
 * exclusion mechanism. This one reads two durable columns that no code on the
 * lock path writes, and answers the question operations actually has: **did
 * two `pg_dump` runs overlap.**
 *
 * It can be wrong in BOTH directions:
 *
 *  - **under**, because `abandonedRuns` counts rows whose `finished_at` is when
 *    the scheduler gave up rather than when the work stopped, so an overlap
 *    beginning after that timestamp is invisible. A zero with a non-zero
 *    `abandonedRuns` is `incomplete`, not `clean`.
 *  - **over**, because the two timestamps are stamped by `new Date()` in the
 *    drill PROCESS while the exclusion is a Postgres advisory lock. Two
 *    schedulers on two hosts stamp from two clocks, so an incoming host whose
 *    clock trails the outgoing one records an overlap that did not happen.
 *    `OVERLAP_TOLERANCE_SECONDS` answers that, and `marginalRuns` counts what
 *    the tolerance absorbs so it is written off in the open.
 */
export type DrillOverlap = {
  /** Runs that started more than `OVERLAP_TOLERANCE_SECONDS` before an
   *  earlier-starting run was recorded as finishing. Counts RUNS, not pairs:
   *  three piled-up runs report 2. */
  readonly overlappingRuns: number
  /** Seconds since the most recent such run started. `null` when there is none
   *  — rendered as NaN so a PromQL threshold cannot fire on an installation
   *  where the exclusion has never failed. */
  readonly lastOverlapAgeSeconds: number | null
  /** Runs that overlap by LESS than the tolerance. Almost certainly clock skew
   *  between two hosts rather than two drills co-running; counted rather than
   *  discarded, because narrowing a predicate without counting what falls in
   *  the gap is how a detector starts reporting clean. */
  readonly marginalRuns: number
  /** Rows whose window is known to understate the real one. See `abandoned` on
   *  `DrillReport`. */
  readonly abandonedRuns: number
  /** `finished_at < started_at`. Impossible for a healthy writer and not
   *  excluded by any CHECK constraint. EXCLUDED from the scan and counted:
   *  see the note on `implausibleRuns`. */
  readonly backwardsRuns: number
  /** A window longer than any permitted configuration can produce. Excluded
   *  from the scan, because one such row raises the running maximum above every
   *  later start and marks the whole history as overlapping. Counted, because
   *  excluding without counting would hide it. */
  readonly implausibleRuns: number
  /** Seconds since the most recent row of any unreliable kind. Feeds an
   *  age-scoped alert, so one bad row does not hold a ticket open until
   *  retention prunes it. */
  readonly lastUnreliableAgeSeconds: number | null
  /** How many rows the overlap was computed OVER — excluded rows are not among
   *  them. A zero overlap against a zero here is an empty scan, not a clean
   *  bill of health, and the `/metrics` panel shows the two side by side. */
  readonly consideredRuns: number
}

/**
 * How much apparent overlap is written off as clock skew.
 *
 * `started_at` and `finished_at` are stamped by
 * `new Date()` in the DRILL PROCESS while the exclusion is enforced by a
 * Postgres advisory lock, so two schedulers on two hosts stamp from two clocks.
 * If the incoming host's clock trails the outgoing one, the recorded windows
 * overlap by the skew and nothing was wrong.
 *
 * Sixty seconds because a genuine exclusion failure means two drills DUMPING at once, and a drill runs for
 * minutes. An apparent overlap measured in seconds is therefore far likelier to
 * be two clocks than two dumps. Anything under the tolerance is still counted,
 * as `marginalRuns` — the point is to route it to a ticket about clocks rather
 * than a page about backups, not to make it disappear.
 */
export const OVERLAP_TOLERANCE_SECONDS = 60

/**
 * Longest window any permitted configuration can produce.
 *
 * Derived, not invented: `intervalMs` caps the cadence at `24 * 30` hours and
 * `deadlineMs` refuses `deadline + grace > interval`, so no legitimate drill
 * can span more than the maximum interval. A row beyond it is a clock that
 * jumped mid-run, and leaving it in the scan is not a small error — the running
 * maximum carries it forward over every subsequent row.
 */
const IMPLAUSIBLE_WINDOW = '30 days'

const EMPTY_OVERLAP: DrillOverlap = Object.freeze({
  overlappingRuns: 0,
  lastOverlapAgeSeconds: null,
  marginalRuns: 0,
  abandonedRuns: 0,
  backwardsRuns: 0,
  implausibleRuns: 0,
  lastUnreliableAgeSeconds: null,
  consideredRuns: 0,
})

/**
 * One pass, ordered by start, carrying the running maximum finish time.
 *
 * A run overlaps something earlier **iff** the greatest finish time among all
 * earlier-starting runs is strictly after its own start. That is O(n log n) for
 * the sort and nothing else; the obvious self-join is O(n²) on a table the
 * retention sweep lets grow to a byte budget rather than a row count.
 *
 * `>` and not `>=`: **back-to-back runs must not read as an overlap.** The
 * scheduler starts its next tick immediately when a drill overruns its
 * interval, so `b.started_at == a.finished_at` is the ordinary healthy shape,
 * and an alarm that fires on it would be noise from the first slow night.
 */
export async function readDrillOverlap(db: Queryable): Promise<DrillOverlap> {
  let rows: OverlapRow[]
  try {
    // ONE round trip, not a `to_regclass` probe followed by the real query.
    // `/metrics` is scraped every 15 s and each query is a separate pool
    // acquisition with a 10 s connect ceiling. The missing table is caught by
    // its SQLSTATE instead, which costs nothing on the path taken every time.
    ;({ rows } = await db.query<OverlapRow>(OVERLAP_SQL, [OVERLAP_TOLERANCE_SECONDS]))
  } catch (error) {
    // 42P01 = undefined_table. An installation whose schema has not been
    // bootstrapped reports empty rather than failing the whole scrape — and
    // `consideredRuns: 0` is what tells the reader the difference.
    if ((error as { code?: string }).code === '42P01') return EMPTY_OVERLAP
    throw error
  }
  // No `if (!rows[0])` guard: the statement is a bare aggregate with no GROUP
  // BY, so it returns exactly one row for any table including an empty one.
  const row = rows[0]!
  return {
    overlappingRuns: Number(row.overlapping_runs),
    lastOverlapAgeSeconds: age(row.last_overlap_age_seconds),
    marginalRuns: Number(row.marginal_runs),
    abandonedRuns: Number(row.abandoned_runs),
    backwardsRuns: Number(row.backwards_runs),
    implausibleRuns: Number(row.implausible_runs),
    lastUnreliableAgeSeconds: age(row.last_unreliable_age_seconds),
    consideredRuns: Number(row.considered_runs),
  }
}

interface OverlapRow {
  overlapping_runs: string
  last_overlap_age_seconds: string | null
  marginal_runs: string
  abandoned_runs: string
  backwards_runs: string
  implausible_runs: string
  last_unreliable_age_seconds: string | null
  considered_runs: string
}

/** Clamped at zero because a future-dated row makes `now() - started_at`
 *  negative, and a negative age rendered into a `< threshold` alert is a
 *  permanent page. Clamping is the lesser evil of two wrong answers; the row
 *  that produced it is counted as implausible. */
function age(seconds: string | null): number | null {
  return seconds === null ? null : Math.max(0, Number(seconds))
}

/**
 * `usable` excludes the rows whose window is not a window, `scanned` carries
 * the running maximum over what is left, and the counters are taken over
 * `classified` so nothing excluded goes unreported.
 *
 * A forward-skewed row left in the scan would raise the running maximum above
 * every later start and report every later healthy run as overlapping.
 * Removing it alone would make it vanish, so it is removed AND counted, and
 * the tests assert both halves.
 */
const OVERLAP_SQL = `
WITH classified AS (
  SELECT id, started_at, finished_at, abandoned,
         finished_at < started_at                                AS backwards,
         finished_at - started_at > interval '${IMPLAUSIBLE_WINDOW}' AS implausible
    FROM backup_drill_runs
), usable AS (
  SELECT id, started_at, finished_at FROM classified
   WHERE NOT backwards AND NOT implausible
), scanned AS (
  SELECT started_at,
         max(finished_at) OVER (
           ORDER BY started_at, id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ) AS prior_end
    FROM usable
)
SELECT
  (SELECT count(*) FROM scanned
     WHERE prior_end > started_at + make_interval(secs => $1))::text  AS overlapping_runs,
  (SELECT extract(epoch FROM now() - max(started_at))::text FROM scanned
     WHERE prior_end > started_at + make_interval(secs => $1))        AS last_overlap_age_seconds,
  (SELECT count(*) FROM scanned
     WHERE prior_end > started_at
       AND prior_end <= started_at + make_interval(secs => $1))::text AS marginal_runs,
  (SELECT count(*) FROM scanned)::text                                AS considered_runs,
  (SELECT count(*) FROM classified WHERE abandoned)::text             AS abandoned_runs,
  (SELECT count(*) FROM classified WHERE backwards)::text             AS backwards_runs,
  (SELECT count(*) FROM classified WHERE implausible)::text           AS implausible_runs,
  (SELECT extract(epoch FROM now() - max(started_at))::text FROM classified
     WHERE abandoned OR backwards OR implausible)                     AS last_unreliable_age_seconds`

export function newDrillId(): string {
  return `drill_${randomBytes(12).toString('hex')}`
}

function canonicalBytes(report: DrillReport): Buffer {
  return Buffer.from(stableJson(report), 'utf8')
}

/**
 * `BACKUP_DRILL_SIGNING_KEY` is read here rather than passed in from every call
 * site so that a deployment which sets it cannot end up with one code path that
 * forgets to sign. `BACKUP_DRILL_SIGNING_KEY_ID` names the key so it can be
 * rotated without invalidating the archive of past reports.
 */
export function signDrillReport(
  report: DrillReport,
  key = process.env.BACKUP_DRILL_SIGNING_KEY,
  keyId = process.env.BACKUP_DRILL_SIGNING_KEY_ID ?? 'default',
): SignedDrillReport {
  const bytes = canonicalBytes(report)
  const reportSha256 = createHash('sha256').update(bytes).digest('hex')
  if (!key) return { report, reportSha256, signature: null, signingKeyId: null }
  return {
    report,
    reportSha256,
    signature: createHmac('sha256', key).update(bytes).digest('hex'),
    signingKeyId: keyId,
  }
}

/**
 * Verify a stored report against the key.
 *
 * Recomputes the signature from the report's own canonical bytes, so editing
 * any field — including the outcome — invalidates it. An unsigned report is
 * `false`: "we could not check" and "it checks out" must not be the same answer.
 */
export function verifyDrillReport(
  signed: SignedDrillReport,
  key = process.env.BACKUP_DRILL_SIGNING_KEY,
): boolean {
  if (!key || !signed.signature) return false
  const expected = createHmac('sha256', key).update(canonicalBytes(signed.report)).digest('hex')
  const provided = Buffer.from(signed.signature)
  const target = Buffer.from(expected)
  if (provided.length !== target.length) return false
  return timingSafeEqual(provided, target)
}

export async function recordDrillRun(db: Queryable, signed: SignedDrillReport): Promise<void> {
  await db.query(
    `INSERT INTO backup_drill_runs
       (id, started_at, finished_at, outcome, rto_ms, report_sha256, signature, signing_key_id, report)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      signed.report.drillId,
      signed.report.startedAt,
      signed.report.finishedAt,
      signed.report.outcome,
      Math.max(0, Math.round(signed.report.rtoMs)),
      signed.reportSha256,
      signed.signature,
      signed.signingKeyId,
      JSON.stringify(signed.report),
    ],
  )
}

const EMPTY_HEALTH: DrillHealth = {
  lastSuccessAt: null,
  lastSuccessAgeSeconds: null,
  lastRunAt: null,
  lastOutcome: null,
  lastSuccessRtoMs: null,
  failuresSinceLastSuccess: 0,
}

/**
 * Scraped, so kept to an existence probe plus one aggregate query.
 *
 * `failuresSinceLastSuccess` is deliberately counted against the last SUCCESS
 * rather than over a time window: a nightly drill that has been failing for
 * four days reads as 4, and no window has to be chosen to make that visible.
 */
export async function readDrillHealth(db: Queryable): Promise<DrillHealth> {
  const { rows: exists } = await db.query<{ present: boolean }>(
    `SELECT to_regclass('public.backup_drill_runs') IS NOT NULL AS present`,
  )
  if (exists[0]?.present !== true) return EMPTY_HEALTH
  const { rows } = await db.query<{
    last_success_at: Date | null
    last_success_age_seconds: string | null
    last_run_at: Date | null
    last_outcome: 'passed' | 'failed' | null
    last_success_rto_ms: string | null
    failures_since_success: string
  }>(
    `WITH last_success AS (
       SELECT finished_at, rto_ms FROM backup_drill_runs
       WHERE outcome = 'passed' ORDER BY finished_at DESC LIMIT 1
     ), last_run AS (
       SELECT finished_at, outcome FROM backup_drill_runs
       ORDER BY finished_at DESC LIMIT 1
     )
     SELECT (SELECT finished_at FROM last_success) AS last_success_at,
            (SELECT extract(epoch FROM now() - finished_at)::text FROM last_success)
              AS last_success_age_seconds,
            (SELECT finished_at FROM last_run) AS last_run_at,
            (SELECT outcome FROM last_run) AS last_outcome,
            (SELECT rto_ms::text FROM last_success) AS last_success_rto_ms,
            (SELECT count(*)::text FROM backup_drill_runs
             WHERE outcome = 'failed'
               AND finished_at > COALESCE((SELECT finished_at FROM last_success), '-infinity'::timestamptz)
            ) AS failures_since_success`,
  )
  const row = rows[0]
  if (!row) return EMPTY_HEALTH
  return {
    lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
    lastSuccessAgeSeconds: row.last_success_age_seconds === null
      ? null
      : Math.max(0, Number(row.last_success_age_seconds)),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
    lastOutcome: row.last_outcome,
    lastSuccessRtoMs: row.last_success_rto_ms === null ? null : Number(row.last_success_rto_ms),
    failuresSinceLastSuccess: Number(row.failures_since_success ?? 0),
  }
}
