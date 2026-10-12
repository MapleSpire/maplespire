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

import { newDrillId, recordDrillRun, signDrillReport, type DrillReport } from './drillReport.js'
import {
  terminateAdvisoryLockHolder,
  type AdvisoryLockQueryRunner,
  type AdvisoryLockTermination,
} from '../db/sessionAdvisoryLock.js'
import type { Queryable } from './backupRestore.js'
import type { DrillAbandonment } from './drillTick.js'

/**
 * Leave a DURABLE witness that a drill was abandoned, before the process ends.
 *
 * Abandonment is a terminal state: the drill would not stop, the advisory lock
 * is still held, and the only way to return the key is for this backend to
 * die. With only a stdout line:
 *
 *  - `BackupDrillFailing` watches for a **recorded** failed run, so it would
 *    never fire;
 *  - the last-success-age gauge just keeps rising, so the first signal would
 *    be `BackupDrillStale` at **36 hours**;
 *  - with `restart: always` and the scheduler's run-once-at-boot property, a
 *    deterministic wedge becomes a quiet crash loop for a day and a half.
 *
 * So the abandonment is recorded as a FAILED RUN in the table the alerting
 * already watches. No new metric, no new alert rule, no new thing for an
 * operator to know about: the run that could not finish shows up where a run
 * that finished badly shows up.
 */

/** What the stored `error` says about the key.
 *
 *  Branches on what was OBSERVED (`lockLoss`, `lockVerdict`), not on what was
 *  DECIDED (`reason`), and the difference is not academic — deriving it from the
 *  stop reason is wrong in both directions:
 *
 *   - a `deadline` or `caller` abandonment can follow a loss that happened
 *     during the five-minute grace, after which "was held by backend pid N" is
 *     false;
 *   - and a `lock-lost` stop is raised only on `not-owner`, so the
 *     no-longer-attributed sentence is true by construction there.
 *
 *  ## Strongest evidence first
 *
 *  `lockLoss` is only what the BROKEN connection managed to observe. A run where
 *  an INDEPENDENT connection established, repeatedly, that the key was gone must
 *  not be signed with the same "may have been running without an exclusion" as
 *  a run where nothing could be established at all.
 *
 *  The ORDER of the branches below is therefore the whole design. Strongest
 *  first:
 *
 *  | evidence | why it ranks there |
 *  | --- | --- |
 *  | `lockLoss === 'not-owner'` | the backend asked `pg_locks` about ITSELF (`pid = pg_backend_pid()`); no pid reuse and no token can confuse it |
 *  | `lockWatch.verdict` | an independent connection, about ANOTHER backend — fenced by the session token when the cluster supplies one, and reported as UNFENCED when it does not |
 *  | neither | say so, and say how many times it asked |
 *
 *  `not-owner` never starts a watch — it is conclusive on its own, so the drill
 *  stops immediately — so it must be checked before the watch branches or it
 *  would fall through to the hedge.
 *
 *  Every branch carries the verdict's AGE, because the watch is stopped when the
 *  run stops; a final sample is taken as the abandonment is declared so the age
 *  is normally single-digit milliseconds, and printing it is what makes that a
 *  fact rather than an assumption.
 *
 *  This text is HMAC-signed, stored, and read months later during a DR review.
 *  It is the last place a plausible wrong sentence should live. */
function lockSentence(abandonment: DrillAbandonment): string {
  const on = `advisory lock ${abandonment.lockKey}`
  const pid = `backend pid ${abandonment.backendPid}`
  const watch = abandonment.lockWatch
  // "before the abandonment was DECLARED", not "before the process ended", and
  // the difference is up to twenty-five seconds: `settleAbandonment` runs a
  // bounded record (≤15 s) and a bounded terminate (≤10 s) after this text is
  // built. "Before the process ended" would under-report the age of the
  // evidence — the one direction a report about staleness must not err in.
  const ago = `${watch.ageMs} ms before the abandonment was declared`
  const checks = `${watch.checks} independent check(s)`
  const strength = watch.fenced ? 'fenced by the session token' : 'identified by pid alone, UNFENCED'
  // FIRST, and above the independent watch, because it is the STRONGEST
  // evidence this system can hold.
  //
  // `not-owner` comes from `advisoryLockHeldByThisSession`, which asks
  // `pid = pg_backend_pid()` — the session asking about ITSELF. There is no pid
  // to recycle and no token to fence, so it cannot be confused the way an
  // answer about an arbitrary backend can. The watch's `not-ours` is second-hand
  // by comparison and may even be unfenced.
  if (abandonment.lockLoss === 'not-owner') {
    return `${on} was CONFIRMED no longer held by ${pid} — established by that backend's own `
      + 'session, which asked pg_locks about itself, so no pid reuse can explain it — and this '
      + 'drill WAS running without an exclusion; the process was ended to stop the unprotected '
      + `work. A later independent check said ${watch.verdict} (${strength}), ${ago}.`
  }
  if (watch.verdict === 'not-ours') {
    return `${on} was CONFIRMED no longer held by ${pid} — established by an independent `
      + `connection ${strength}, ${ago}, after ${checks} — so this drill WAS running without an `
      + 'exclusion; the process was ended to stop the unprotected work.'
  }
  if (watch.verdict === 'ours') {
    return `an independent connection confirmed ${on} was still held by ${pid} as of ${ago} `
      + `(${strength}), after ${checks}; nothing establishes what happened to the key after that `
      + `sample. The lock's own connection had reported ${abandonment.lockLoss ?? 'nothing wrong'}.`
  }
  return `${checks} from an independent connection could not establish whether ${on} was still `
    + `held by ${pid} — the last of them ${ago} — so this drill may have been running without an `
    + `exclusion; the process was ended to stop the possibly unprotected work. The lock's own `
    + `connection had reported ${abandonment.lockLoss ?? 'nothing wrong'}.`
}

/** Everything about a run that a report needs and an abandonment does not
 *  otherwise know. */
export interface AbandonmentContext {
  readonly startedAt: Date
  readonly bundleDirectory: string
  readonly applicationRevision?: string
  /** Wall clock, injected so a test does not have to race one. */
  readonly now?: () => Date
}

/** Build the failed-run report for an abandonment.
 *
 * Exported separately from the write so the SHAPE can be asserted without a
 * database — the half that decides whether the alert fires is
 * `outcome: 'failed'`, and that must not be reachable only through a
 * DB-gated suite that a run without Postgres skips silently. */
export function abandonmentReport(
  abandonment: DrillAbandonment,
  context: AbandonmentContext,
): DrillReport {
  const finishedAt = (context.now?.() ?? new Date())
  return {
    reportVersion: 1,
    drillId: newDrillId(),
    startedAt: context.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    rtoMs: finishedAt.getTime() - context.startedAt.getTime(),
    outcome: 'failed',
    applicationRevision: context.applicationRevision ?? null,
    source: { database: '', postgresVersion: '', snapshotAt: '' },
    // `written: false` is a claim this function is NOT entitled to make either
    // way — the dump may well be half-written on disk. It is the safe half of
    // the pair: "a bundle exists" and "there is no backup at all" must not be
    // confused, and the direction that under-claims is the one that cannot
    // produce a clean bill of health nobody earned.
    bundle: { directory: context.bundleDirectory, written: false, dumpBytes: 0, dumpSha256: '', manifestSha256: '' },
    // `incomplete`, never `clean`: nothing was censused. A zeroed census here
    // would be a signed statement that no document is empty — a forgery.
    sourceIntegrity: {
      verdict: 'incomplete',
      census: null,
      probeFailures: 0,
      coverage: null,
      detail: 'the drill was abandoned before its source census could be taken',
    },
    verification: null,
    coldApi: null,
    retiredWorkspaces: [],
    // The marker the overlap detector reads. `finished_at` on this row is when
    // the scheduler GAVE UP, not when the work stopped — nobody knows that — so
    // the window understates the real one and any overlap starting after it is
    // invisible. Recording the fact keeps a `0` from the detector honest.
    abandoned: true,
    error: `the drill was abandoned after ${abandonment.heldMs} ms (${abandonment.reason}: `
      + `deadline ${abandonment.deadlineMs} ms, grace ${abandonment.graceMs} ms). It did not stop when `
      + `asked, so it may still have been running; ${lockSentence(abandonment)}`,
  }
}

/**
 * Record the abandonment, under a wall clock of its own.
 *
 * Bounded because it runs on the path that exists to bound things: a write that
 * hangs here would hold the advisory lock for exactly as long as it hung, which
 * is the defect one layer up. Best-effort by design — an abandonment whose
 * RECORD fails must still end the process, so the caller gets `false` rather
 * than a rejection and proceeds either way.
 */
export async function recordAbandonment(
  db: Queryable,
  abandonment: DrillAbandonment,
  context: AbandonmentContext,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`recording the abandonment took longer than ${timeoutMs} ms`)), timeoutMs)
    timer.unref?.()
  })
  const write = recordDrillRun(db, signDrillReport(abandonmentReport(abandonment, context)))
  // The race may abandon it; an unhandled rejection here would be attributed to
  // whatever file happens to be running as the process dies.
  write.catch(() => undefined)
  try {
    await Promise.race([write, expired])
    return true
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface AbandonmentSettlement {
  readonly termination: AdvisoryLockTermination
  readonly recorded: boolean
}

export interface SettleAbandonmentOptions {
  readonly log: (event: string, fields?: Record<string, unknown>) => void
  readonly terminationCeilingMs?: number
  readonly recordTimeoutMs?: number
  /** Seams, and only so the ORDER and the best-effort contract can be asserted
   *  without a cluster. Both defaults are the production functions; the pair is
   *  also exercised for real in `drillTick.integration.test.ts`. */
  readonly terminate?: typeof terminateAdvisoryLockHolder
  readonly record?: typeof recordAbandonment
}

/**
 * Everything an abandoned drill owes the world, in the order it owes it.
 *
 * Lives here rather than in `drillScheduler`'s `abandonAndExit` because that
 * module calls `main()` at module scope, so nothing can import it and no test
 * could reach this sequence (same reason as `drillTick` and `drillSchedule`).
 *
 * ## The evidence first, the key LAST
 *
 * Terminating first is tempting — a key still held means every tick in every
 * scheduler skips — but it prices the wrong thing.
 *
 * An abandonment means the drill **would not stop**. It is still dumping, still
 * writing the bundle root, still able to run a retention sweep. Between the
 * moment the key comes back and the moment this process dies, that work is
 * running with **no exclusion at all** — and a rival scheduler wakes at least
 * every sixty seconds. Terminating first opens that window for as long as the
 * record takes (up to 15 s) plus the exit; terminating last closes it to
 * roughly the stdout flush. What can happen inside it is two `pg_dump` runs and
 * two retention sweeps against one bundle root — the only thing in this path
 * that can DELETE a backup.
 *
 * The cost of the other order is that the key comes back ~15 s later. That is
 * paid only in the case where the socket would not have carried a FIN anyway —
 * where the alternative is fifteen MINUTES — so it is fifteen seconds against a
 * hazard that deletes bundles. Not close.
 *
 * What this order gives up, said plainly: the stored report cannot carry the
 * termination outcome, because it is written before there is one. The outcome
 * goes to `backup.drill_lock_return`, and the recorded failed run — which is
 * what `BackupDrillFailing` watches, within ten minutes — is unaffected.
 *
 * **Neither step may stop the other.** A record that fails must not skip the
 * termination, and a termination that fails must not lose the record: they
 * answer different questions and an operator reading the aftermath needs both.
 * So each is caught on its own, never in one `try` — and `db` must be a pool of
 * at least TWO, because `withCeiling` bounds a statement without cancelling it,
 * so an abandoned query keeps its client for good. On `max: 1` the second step
 * would then be guaranteed to fail on a connection timeout, in exactly the
 * failure this path exists for.
 */
export async function settleAbandonment(
  db: Queryable & AdvisoryLockQueryRunner,
  abandonment: DrillAbandonment,
  context: AbandonmentContext,
  options: SettleAbandonmentOptions,
): Promise<AbandonmentSettlement> {
  const terminate = options.terminate ?? terminateAdvisoryLockHolder
  const record = options.record ?? recordAbandonment
  // Guarded for the reason `sessionAdvisoryLock` guards its own sink: a log
  // sink may not decide whether a lock gets released. This one sits BETWEEN the
  // two steps, so a throwing sink would decide whether the key comes back.
  const log = (event: string, fields: Record<string, unknown>): void => {
    try {
      options.log(event, fields)
    } catch {
      // Nothing to escalate to: the only channel is the one that just failed.
    }
  }

  let recorded = false
  try {
    recorded = await record(db, abandonment, context, { timeoutMs: options.recordTimeoutMs })
  } catch (error) {
    log('backup.drill_abandonment_record_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  log('backup.drill_abandonment_recorded', { recorded })

  let termination: AdvisoryLockTermination
  try {
    termination = await terminate(db, abandonment.lockKey, abandonment.backendPid, {
      ceilingMs: options.terminationCeilingMs,
      // The fencing token travels with the pid, always. A kill authorised by a
      // recyclable number could take the rightful successor drill.
      backendStart: abandonment.backendStart,
    })
  } catch (error) {
    // `terminateAdvisoryLockHolder` already returns its failures rather than
    // throwing, so this is the guard for a future where it stops doing that —
    // and for the key validation, which DOES throw. Reported as an unreleased
    // key, never as a released one: the direction that under-claims is the only
    // one that cannot produce a clean bill of health nobody earned.
    termination = {
      signalled: false,
      released: false,
      refusedSelf: false,
      fenced: abandonment.backendStart !== null,
      error: error instanceof Error ? error.message : String(error),
      waitedMs: 0,
    }
  }
  // Named for the ATTEMPT, not the action: it is emitted when no row matched and
  // when the request was refused, neither of which terminated anything.
  log('backup.drill_lock_return', {
    detail: termination.released
      ? 'the advisory lock is confirmed no longer attributed to that backend'
      : 'the advisory lock may STILL be held; every scheduler will skip until that session dies',
    lockKey: abandonment.lockKey,
    backendPid: abandonment.backendPid,
    ...termination,
  })
  return { termination, recorded }
}
