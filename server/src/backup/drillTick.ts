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

import type { Pool, QueryConfig, QueryResultRow } from 'pg'
import {
  acquireSessionAdvisoryLock,
  checkAdvisoryLockOwnership,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_OWNERSHIP_CHECK_CEILING_MS,
} from '../db/sessionAdvisoryLock.js'
import type {
  AdvisoryLockOwnership,
  AdvisoryLockOwnershipCheck,
  AdvisoryLockQueryRunner,
  SessionAdvisoryLock,
  SessionAdvisoryLockLoss,
} from '../db/sessionAdvisoryLock.js'

/**
 * One drill tick: take the exclusion, run the drill under a wall clock, give
 * the exclusion back, and say what happened to it.
 *
 * Kept apart from `drillScheduler` (which runs `main()` at module scope) so the
 * code that decides whether two `pg_dump` runs may overlap can be imported and
 * tested. The property it guarantees: **for the whole duration of `drill`, no
 * other session can take `lockKey`.** `drillTick.integration.test.ts` asserts it
 * against a real cluster with a rival connection trying.
 *
 * ## The deadline
 *
 * The lock is held on a checked-out client for the drill's whole run, so a
 * wedged scheduler would block its rivals forever. Liveness comes from a wall
 * clock on the drill, never from weakening the lock.
 *
 * ## Why abandonment does NOT release the lock
 *
 * A promise cannot be cancelled: when the deadline expires, `drill` is aborted
 * and then waited for, and if it does not settle it is still running — still
 * dumping, writing the bundle root, holding an isolated restore database.
 * Releasing the key then would let a second scheduler do all of that
 * concurrently. So abandonment holds the key and **ends the process**: a
 * session advisory lock is released when its backend dies, and the
 * orchestrator's restart policy takes over.
 *
 * `sessionAdvisoryLock` also lowers the session's TCP keepalives, so the cluster
 * can reap the backend and return the key on its own — without stopping the
 * abandoned work. `DEFAULT_KEEPALIVES` is therefore sized to fire after the
 * abort grace, and `assertKeepaliveGraceFits` enforces it.
 *
 * Ending the process relies on the socket carrying a FIN, which fails when the
 * socket is what broke; `drillScheduler` therefore also has an independent
 * connection `pg_terminate_backend` the holder and confirm the release against
 * `pg_locks` (see `terminateAdvisoryLockHolder` in `db/sessionAdvisoryLock.ts`).
 *
 * ## Three stop reasons
 *
 * `deadline` and `caller` come from a clock and an operator. `lock-lost` means
 * the drill's justification for running — nothing else is dumping — has
 * expired, so continuing is the defect itself.
 *
 * It is triggered only by an answer. Of the lock's three loss reasons, only
 * `not-owner` is one (`pg_locks` says the key is not ours); the other two only
 * say the lock's connection broke, and stopping costs the night's backup. Those
 * two are put to a SECOND connection: a confirmed `not-ours` stops the drill, a
 * confirmed `ours` (the usual answer behind a black-holed socket — the backend
 * has not noticed its client is gone and still holds the key) lets it continue.
 *
 * ## The exclusion watch
 *
 * The lock's heartbeat stops for good once it declares a loss, so a single
 * independent check would leave the rest of a multi-hour run unwatched. The
 * check is therefore a WATCH: the same question, on the second connection, at
 * the heartbeat's cadence, from the loss until the run ends. It is serial — one
 * sample is awaited before the next is armed — so a slow cluster cannot pile
 * requests onto a pool of two. What it saw is carried into `DrillAbandonment`
 * and from there into the signed report.
 *
 * `abandon` is injected rather than a bare `process.exit` so tests can assert it
 * is called; its default ends the process, so a caller that forgets gets the
 * safe behaviour.
 *
 * Ending the process does not kill a `pg_dump` child when the scheduler runs
 * outside a container; that child is bounded only by `runCommand`'s own
 * `PG_COMMAND_TIMEOUT_MS`, which is why that ceiling exists in addition to this
 * deadline.
 */

/** Wall-clock ceiling on `drill`. A deployment arbitrage, and it cuts both
 *  ways: too short kills a legitimate dump on a large cluster and there is then
 *  no backup at all — strictly worse than the stall it prevents. Six hours is
 *  an order of magnitude beyond anything measured here and a quarter of the
 *  default daily cadence. */
export const DEFAULT_DRILL_DEADLINE_MS = 6 * 3_600_000

/** How long the drill has to SETTLE after the abort, before it is abandoned.
 *
 * Must exceed `drillRunner`'s teardown ceiling: an aborted drill spends that
 * window in its own `finally` dropping the isolated restore database and
 * sweeping its litter — cluster work the exclusion must still cover.
 * `drillTick.test.ts` asserts the inequality against `TEARDOWN_STEP_TIMEOUT_MS`,
 * so raising one and forgetting the other fails a test. */
export const DEFAULT_ABORT_GRACE_MS = 300_000

/** Cadence of the independent exclusion watch, when nothing else names one.
 *
 * Derived from `sessionAdvisoryLock`'s heartbeat because the watch IS that
 * heartbeat moved onto a working connection; keep the derivation rather than a
 * duplicated literal (`drillTick.test.ts` only asserts equality).
 *
 * Cost of one sample: `pg_locks` walks every lock-manager partition and
 * backend fast-path array, and `HOLDER_SQL` adds a `pg_stat_activity` subquery,
 * so it scales with the backend count. Measured with 29 backends and 21
 * advisory locks: ~0.92 ms median per sample (~0.64 ms beyond a `SELECT 1`
 * round trip), about 1.3 s of server time for 1 440 samples over six hours. */
export const DEFAULT_EXCLUSION_WATCH_MS = DEFAULT_HEARTBEAT_MS

/** How many `backup.drill_exclusion_changed` lines one run may spend.
 *
 *  The watch logs on a change of answer, and a connection alternating between
 *  answering and not answering changes on every sample — exactly the state the
 *  watch exists to observe. Everything past the cap is counted in `changes` and
 *  `changesSuppressed` on the summary, never silently dropped. */
const MAX_WATCH_CHANGE_LINES = 20

export interface DrillTickOptions {
  /** A pool the drill itself must not share, with room for **at least two**
   *  clients.
   *
   *  One is checked out and held for the tick's whole duration — that is the
   *  exclusion. The second is borrowed, briefly, to put an inconclusive lock
   *  loss to an INDEPENDENT session — and then borrowed again once per
   *  `watchOwnershipMs` for the rest of the run, which is up to 1 440 times at
   *  the default. Never more than ONE at a time: an unanswered question is
   *  reported, never queued behind. On a pool of one the question waits
   *  `connectionTimeoutMillis` and then answers `unknown`, which silently means
   *  "carry on" — so `runDrillTick` logs a warning for a pool smaller than two. */
  readonly pool: Pool
  readonly lockKey: number
  readonly log: (event: string, fields?: Record<string, unknown>) => void
  /** The work being protected. Its rejection is re-thrown, but only AFTER the
   *  lock has been released and reported on — a failing drill must not also
   *  leave the key held for the next scheduler to trip over.
   *
   *  It receives a signal that aborts on the deadline and on the caller's own
   *  stop. Honouring it is what turns an expensive process restart into an
   *  ordinary failed run. */
  readonly drill: (signal: AbortSignal) => Promise<void>
  /** Forwarded to the lock. Tests set it low, or to 0 to prove the held client
   *  is by itself sufficient. */
  readonly heartbeatMs?: number
  /** Ceiling on `drill`, measured from the moment it starts rather than from
   *  acquisition. `0` disables it, which is only correct in a test that is
   *  measuring something else. */
  readonly deadlineMs?: number
  /** Grace between the abort and abandonment. See `DEFAULT_ABORT_GRACE_MS`. */
  readonly abortGraceMs?: number
  /** Ceiling on the INDEPENDENT ownership check that follows an inconclusive
   *  loss — both on getting a second connection and on the question itself.
   *  It runs while the drill is still working, so waiting costs a drill that
   *  keeps dumping without a verified exclusion for exactly that long. */
  readonly confirmOwnershipMs?: number
  /** Cadence of the independent exclusion WATCH that takes over once the lock's
   *  own heartbeat has given up.
   *
   *  Defaults to `heartbeatMs`, then to `DEFAULT_EXCLUSION_WATCH_MS` — the watch
   *  is the heartbeat continued on a working connection, so it inherits the
   *  heartbeat's period rather than inventing a second knob nobody tunes.
   *
   *  `0` — which `heartbeatMs: 0` also produces — takes exactly ONE sample and
   *  stops: `heartbeatMs: 0` means "generate no traffic on this key", and a
   *  watch is traffic. */
  readonly watchOwnershipMs?: number
  /** The caller's own stop — SIGTERM reaching the scheduler. Handled exactly
   *  like the deadline except in what the report calls it, because the two are
   *  the same request ("stop this drill") arriving from different places, and
   *  an operator reading the log needs to know which. */
  readonly signal?: AbortSignal
  /** Called when the drill would not stop and the key is therefore still held.
   *  Defaults to ending the process, which is the only thing that releases a
   *  session lock whose holder will not stop. See the header. */
  readonly abandon?: (report: DrillAbandonment) => void
}

/** What asked a run to stop.
 *
 * `lock-lost` consumes the lock's `AbortSignal`, which fires when the key may no
 * longer belong to this backend. Without it, a drill whose exclusion had gone
 * would keep dumping alongside whichever scheduler now holds the key, and
 * report it only afterwards through `exclusive: false`. */
export type StopReason = 'deadline' | 'caller' | 'lock-lost'

/** Why a run was cut short. `null` on a run that finished on its own. */
export type DrillCutShortBy = StopReason | null

export interface DrillAbandonment {
  readonly reason: StopReason
  /** How long the lock had been held when the drill was given up on. */
  readonly heldMs: number
  readonly deadlineMs: number
  readonly graceMs: number
  readonly backendPid: number
  /** The fencing token for `backendPid`. Carried alongside it and never apart
   *  from it: the abandonment path terminates that backend, and a pid recorded
   *  hours earlier is a number the OS may have reissued to the rightful
   *  successor drill. `null` where the cluster would not supply one. */
  readonly backendStart: string | null
  readonly lockKey: number
  /** What the lock's heartbeat had observed by the time the drill was given up
   *  on, or `null` if ownership never stopped looking healthy.
   *
   *  Carried because the signed report states who held the key, and `reason`
   *  alone gets it wrong both ways: a `deadline` abandonment can follow a loss
   *  during the grace. This is the observation; `reason` is the decision. */
  readonly lockLoss: SessionAdvisoryLockLoss['reason'] | null
  /** What an INDEPENDENT connection established about the key, sampled once
   *  more at the moment the drill was given up on.
   *
   *  `lockLoss` is what the broken connection observed; this lets the report
   *  distinguish "a working connection confirmed the key was gone" from
   *  "nothing could be established". One non-nullable object rather than
   *  parallel nullable fields, so consumers need no fallbacks. */
  readonly lockWatch: AdvisoryLockWatchEvidence
  /** How long the CLUSTER will leave this key with a backend whose client has
   *  gone silent, as the kernel accepted it — `null` where the keepalive
   *  settings did not apply, or the caller disabled them.
   *
   *  Distinguishes "the key comes back on its own within minutes" from "within
   *  two hours", which both read as `released: false` otherwise. */
  readonly keepaliveDetectsWithinSeconds: number | null
}

/** What the independent connection had to say, and how far it can be trusted. */
export interface AdvisoryLockWatchEvidence {
  readonly verdict: AdvisoryLockOwnership
  /** How stale the verdict was when the drill was given up on.
   *
   *  `ours` from four seconds ago and from five hours ago mean different things.
   *  A final sample is taken as the abandonment is declared, so this is normally
   *  a few milliseconds; it grows when the cluster has stopped answering
   *  conclusively, since only a conclusive answer dates the evidence. */
  readonly ageMs: number
  /** How many independent samples were taken across the whole run.
   *
   *  Separate from the verdict: "the watch ran" and "the watch agreed" are
   *  different facts. `1` with `unknown` is a question asked once and
   *  unanswered; `240` with `unknown` is a cluster that has refused to answer
   *  for an hour. */
  readonly checks: number
  /** Whether the verdict was fenced by the session token, or rests on a pid the
   *  OS reissues. An unfenced `not-ours` is the weaker evidence, and it is the
   *  evidence on which a six-hour dump gets killed. */
  readonly fenced: boolean
}

export type DrillTickOutcome =
  | { readonly status: 'skipped_lock_held' }
  /** The CALLER had already asked to stop before the drill could start.
   *
   *  No `reason` field: only `caller` can reach here, since the deadline was
   *  just armed and `lock.signal` cannot have fired yet (see the note beside
   *  `onCallerStop`). */
  | { readonly status: 'skipped_stopping' }
  | {
    readonly status: 'ran'
    /** False when the drill did NOT provably have the cluster to itself: the
     *  heartbeat saw ownership end, or `pg_advisory_unlock` answered `false`,
     *  or it could not answer. Each of those means another scheduler may have
     *  been dumping, writing `latest-report.json`, and sweeping the same bundle
     *  root at the same time. */
    readonly exclusive: boolean
    /** Non-null when the run was aborted and then settled inside the grace.
     *
     *  Needed because `runBackupDrill` RETURNS its failure instead of throwing,
     *  so without this field a run killed at the deadline would look healthy. */
    readonly cutShortBy: DrillCutShortBy
  }
  | {
    /** The drill did not stop, so the key is STILL HELD and `abandon` has been
     *  called. Callers do not get to treat this as a bad tick and carry on. */
    readonly status: 'abandoned'
    readonly abandonment: DrillAbandonment
  }

/** End the process. The default `abandon`: it both releases a session advisory
 *  lock whose holder will not stop and prevents the abandoned work from being
 *  duplicated by a rival. */
function endProcess(): void {
  // `exit`, not `exitCode`: the abandoned drill still has timers, sockets and a
  // child process registered, so setting a code and returning would leave the
  // loop alive and the key held.
  //
  // Write-then-exit: on POSIX, stdout to a pipe (every container) is
  // asynchronous and `process.exit()` can truncate pending writes — here the
  // `backup.drill_abandoned` line that explains the restart. (Untested on POSIX;
  // on win32 pipe stdio is synchronous.)
  process.exitCode = 1
  process.stdout.write('', () => { process.exit(1) })
  // …and a floor under that callback, in case stdout is a full pipe nobody is
  // draining. Unref'd so it cannot itself delay a healthy exit.
  const floor = setTimeout(() => { process.exit(1) }, 2_000)
  floor.unref?.()
}

/** What the independent check established, in a sentence rather than a code.
 *
 *  Verdict times run state, and the combinations differ: `not-ours` while
 *  running is a stop and never reaches here, `not-ours` after the run is
 *  evidence arriving too late, and `ours` means the exclusion was intact. */
function describeConfirmation(
  verdict: AdvisoryLockOwnership,
  stillRunning: boolean,
  /** Whether more samples are coming (the watch is enabled). */
  watching: boolean,
): string {
  if (verdict === 'ours') {
    // Past tense: this is what ONE sample saw, not a claim about the rest of
    // the run, so the sentence says whether a watch keeps asking.
    //
    // `!stillRunning` is tested first: a sample landing after the run ended
    // takes no successor whatever `watching` says, and the line carries
    // `runEnded: true`.
    const after = !stillRunning
      ? 'the run had already ended when this answer arrived, so no later sample was taken'
      : watching
        ? 'an independent watch keeps asking on that connection until the run ends, and a later '
          + 'sample that says otherwise will stop the drill'
        : 'the watch is disabled, so nothing asks again for the rest of the run'
    return 'the lock connection failed but an INDEPENDENT one confirmed the exclusion was intact '
      + `AT THAT MOMENT — one sample; ${after}`
      + '. The run still reports exclusive: false, because the release cannot prove what a mid-run '
      + 'check saw'
  }
  if (verdict === 'not-ours') {
    return 'an independent connection confirms the exclusion was GONE, but the answer arrived '
      + 'after the run had already ended or stopped, so nothing was cut short by it'
  }
  if (!stillRunning) {
    return 'the drill may no longer have held the exclusion, and a second connection could not '
      + 'establish that it did not either; the run had already ended'
  }
  return 'the drill may no longer hold the exclusion, and a second connection could not establish '
    + 'that it does not either; the run continues and will report exclusive: false'
    + (watching ? ', and the watch keeps asking' : ', and nothing asks again')
}

/**
 * The abandonment path holds the key for the whole grace so the delay opens no
 * window a rival can dump inside. That also requires the CLUSTER not to reap the
 * backend sooner: with the session's lowered TCP keepalives, a black-holed
 * connection whose keepalive window is shorter than the grace would return the
 * key while the abandoned run is still writing the bundle root.
 *
 * Throws (before the drill starts) rather than logging, because this is a static
 * property of the configuration, like `drillSchedule` refusing a deadline that
 * does not fit its cadence.
 *
 * Silent when the keepalives did not apply or were disabled (`null`): the
 * cluster then falls back to `tcp_keepalive_time`, typically 7 200 s.
 */
function assertKeepaliveGraceFits(
  detectsWithinSeconds: number | null,
  graceMs: number,
  watchMs: number,
  confirmCeilingMs: number,
): void {
  if (detectsWithinSeconds === null) return
  const needsMs = graceMs + watchMs + confirmCeilingMs
  if (detectsWithinSeconds * 1000 > needsMs) return
  throw new Error(
    `the cluster will reap this session's backend after ${detectsWithinSeconds} s, which is not `
    + `longer than the ${needsMs / 1000} s this tick may spend abandoning (grace ${graceMs / 1000} s `
    + `+ watch ${watchMs / 1000} s + confirm ${confirmCeilingMs / 1000} s); the key would go back `
    + 'while an abandoned run is still writing the bundle root. Raise the keepalives or lower the '
    + 'abort grace.',
  )
}

/** A settled-or-expired wait that does not itself keep the process alive. */
function expiresIn(ms: number): { readonly promise: Promise<'expired'>; readonly cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<'expired'>((settle) => {
    timer = setTimeout(() => settle('expired'), ms)
    timer.unref?.()
  })
  return { promise, cancel: () => { if (timer) clearTimeout(timer) } }
}

export async function runDrillTick(options: DrillTickOptions): Promise<DrillTickOutcome> {
  const { pool, lockKey, drill } = options
  const deadlineMs = options.deadlineMs ?? DEFAULT_DRILL_DEADLINE_MS
  const graceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS
  const abandon = options.abandon ?? endProcess
  // A throwing logger must not decide whether the lock is released, nor replace
  // the drill's own error (one log call sits between the release and the
  // re-throw).
  const log = (event: string, fields: Record<string, unknown> = {}): void => {
    try {
      options.log(event, fields)
    } catch {
      // Nothing to escalate to: the only channel is the one that just failed.
    }
  }

  // A pool without a second client silently switches the independent
  // confirmation off (it degrades to `unknown`, i.e. "carry on"). Reported
  // rather than thrown — a drill that refuses to run is worse than one whose
  // confirmation is unavailable — and reported up front rather than only when
  // a failure needs it.
  const configuredMax = (pool as { options?: { max?: unknown } }).options?.max
  if (typeof configuredMax === 'number' && configuredMax < 2) {
    log('backup.drill_pool_too_small_to_confirm', {
      detail: 'the lock pool has room for one client, so an inconclusive lock loss cannot be put '
        + 'to an independent connection and will always answer unknown',
      max: configuredMax,
    })
  }

  if (options.signal?.aborted) {
    log('backup.drill_skipped_stopping', {
      detail: 'the scheduler was already stopping; the lock was not taken',
    })
    return { status: 'skipped_stopping' }
  }

  const lock = await acquireSessionAdvisoryLock(pool, lockKey, {
    heartbeatMs: options.heartbeatMs,
    onEvent: log,
  })
  if (!lock) {
    log('backup.drill_skipped_lock_held', {
      detail: 'another scheduler holds the drill lock; skipping this tick',
    })
    return { status: 'skipped_lock_held' }
  }

  const confirmCeilingMs = options.confirmOwnershipMs ?? DEFAULT_OWNERSHIP_CHECK_CEILING_MS
  // The watch is the heartbeat continued elsewhere, so it inherits
  // `heartbeatMs`; `heartbeatMs: 0` yields one sample (see `watchOwnershipMs`).
  const watchMs = options.watchOwnershipMs ?? options.heartbeatMs ?? DEFAULT_EXCLUSION_WATCH_MS

  // Checked AFTER acquiring because the keepalive window is what the cluster
  // actually applied to this session, which may differ from what was asked.
  // The handle is held here, so the lock is released before the error escapes.
  try {
    assertKeepaliveGraceFits(lock.keepalives.detectsWithinSeconds, graceMs, watchMs, confirmCeilingMs)
  } catch (error) {
    log('backup.drill_keepalive_grace_conflict', {
      detectsWithinSeconds: lock.keepalives.detectsWithinSeconds,
      graceMs,
      detail: error instanceof Error ? error.message : String(error),
    })
    await lock.release()
    throw error
  }

  return runUnderDeadline({
    pool, lock, drill, log, deadlineMs, graceMs, abandon, confirmCeilingMs, watchMs,
    callerSignal: options.signal,
  })
}

async function runUnderDeadline(context: {
  pool: Pool
  lock: SessionAdvisoryLock
  drill: (signal: AbortSignal) => Promise<void>
  log: (event: string, fields?: Record<string, unknown>) => void
  deadlineMs: number
  graceMs: number
  abandon: (report: DrillAbandonment) => void
  callerSignal: AbortSignal | undefined
  confirmCeilingMs: number
  watchMs: number
}): Promise<DrillTickOutcome> {
  const { pool, lock, log, deadlineMs, graceMs, abandon, callerSignal, confirmCeilingMs, watchMs } = context
  const startedAt = Date.now()
  const stopper = new AbortController()
  let cutShortBy: DrillCutShortBy = null

  // The stop reason is carried BY THE PROMISE rather than re-derived from the
  // nullable `cutShortBy` at the abandonment site: reaching that block means
  // this promise resolved, and it only resolves with a real reason.
  let announceStop!: (reason: StopReason) => void
  const stopRequested = new Promise<StopReason>((resolve) => { announceStop = resolve })

  const stop = (reason: StopReason, detail: string): void => {
    if (cutShortBy !== null) return
    cutShortBy = reason
    log('backup.drill_stop_requested', { reason, detail, afterMs: Date.now() - startedAt, graceMs })
    stopper.abort(new Error(detail))
    announceStop(reason)
  }

  // Timers and listeners rather than racing the drill against a timer: they must
  // fire while the drill runs without discarding the settlement this function
  // needs to tell "aborted, then stopped" from "aborted, still running".
  const deadline = deadlineMs > 0
    ? setTimeout(() => stop('deadline', `the drill exceeded its ${deadlineMs} ms deadline`), deadlineMs)
    : undefined
  deadline?.unref?.()
  const onCallerStop = (): void => stop('caller', 'the scheduler was asked to stop')
  callerSignal?.addEventListener('abort', onCallerStop, { once: true })
  // The lock's own stop. **Only `not-owner` is evidence** that the key is gone;
  // the other two loss reasons say only that the lock's connection misbehaved:
  //
  //  - `heartbeat-failed`: `pg.Client` is serial and the probe ceiling bounds
  //    without cancelling, so when the first probe hangs the second never
  //    reaches the wire — one stall counted twice. (When the first probe is
  //    rejected instead, the second does get a real answer.)
  //  - `connection-error`: the lock's connection is the one a stateful firewall
  //    or NAT drops silently; one rebind would otherwise cost the night's backup.
  //
  // Killing a legitimate dump leaves no backup at all, so inconclusive losses do
  // not stop the drill directly. Instead `startWatch` asks `pg_locks` from an
  // INDEPENDENT connection, and keeps asking; only a confirmed `not-ours` stops.
  // Otherwise the run finishes and reports `exclusive: false`.
  const onLockLost = (): void => {
    const loss = lock.loss()
    if (loss?.reason === 'not-owner') {
      stop('lock-lost', `the advisory lock was lost (${loss.reason}: ${loss.detail})`)
      return
    }
    // Inconclusive: ask another connection, and keep asking. Not awaited — this
    // runs inside an abort dispatch while the drill keeps working.
    startWatch(loss)
  }
  lock.signal.addEventListener('abort', onLockLost, { once: true })
  // **`addEventListener` on an already-aborted signal never fires.** Between
  // `runDrillTick`'s entry check and here sits the lock acquisition (up to
  // `connectionTimeoutMillis`), so a SIGTERM landing in that window must be
  // re-checked or the drill would run unaborted to its deadline.
  //
  // `lock.signal` needs no such re-check: there is no `await` between the lock
  // handle being returned and its listener being registered above, so no timer
  // or socket event can abort it in between. Inserting an `await` between
  // `acquireSessionAdvisoryLock` and here would reopen that window.
  if (callerSignal?.aborted) onCallerStop()

  /** The outstanding independent question, or `null` when none is in flight —
   *  a claim on the pool's second client, not a cache. */
  let inFlight: Promise<AdvisoryLockOwnershipCheck> | null = null

  /**
   * Get a connection that is NOT the lock's, and ask it who holds the key.
   *
   * The pool must therefore have room for a second client. `drillScheduler`
   * gives it `max: 2` for exactly this; a pool of one would make this question
   * wait `connectionTimeoutMillis` and then answer `unknown` — correct, and
   * useless.
   */
  const askIndependently = (): Promise<AdvisoryLockOwnershipCheck> =>
    // **Through `pool.query`, never `pool.connect()`.** A checked-out client
    // carries no `'error'` listener (pg-pool removes its own at checkout and
    // reinstalls it in `release()`), so a socket reset during the statement is
    // an uncaught `ERR_UNHANDLED_ERROR` — and `drillScheduler` has no
    // `uncaughtException` handler, so the container would die mid-`pg_dump`.
    // This path is only entered after the database connection has already
    // misbehaved, so that failure is likely. `pool.query` attaches an error
    // listener for the statement's duration and owns the release.
    //
    // SINGLE-FLIGHT: the wait ceiling does not stop the statement, so a second
    // question issued while the first is unanswered would queue a connect
    // request that can later grab the lock's own client as it is released and
    // keep `pool.end()` pending. An unanswered question is instead REPORTED as
    // unanswered, and the next sample asks again once the first has settled.
    inFlight === null ? askFresh() : Promise.resolve(stillWaiting())

  /** The answer when a previous question has not come back. `unknown` is the
   *  truth of it — nothing was established — and the error says WHY, so an
   *  operator can tell "the cluster said nothing" from "we did not ask". */
  const stillWaiting = (): AdvisoryLockOwnershipCheck => ({
    verdict: 'unknown',
    fenced: lock.backendStart !== null,
    error: 'the previous independent check has not answered yet, so a second was not queued '
      + 'behind it; that connection is still holding a pool client',
  })

  /**
   * The pool, with the STATEMENT bounded rather than only the wait.
   *
   * The race in `askFresh` abandons the wait, but `pool.query` keeps running,
   * and pg-pool returns a client only when the statement answers or its socket
   * errors. A question that never answers would hold a client until
   * `tcp_retries2` (about fifteen minutes), and one un-returned client makes
   * `pool.end()` never resolve. pg reads `query_timeout` per query and rejects
   * it, which is the path on which pg-pool releases the client.
   *
   * Bounded here and NOT on the pool: the same pool carries the lock's own
   * session, so a pool-wide `query_timeout` would also bound the heartbeat and
   * `pg_advisory_unlock` and could hand the key back mid-drill.
   */
  // Strictly longer than the wait ceiling: the wait bounds how long the watch
  // holds out for an answer, the statement bounds how long a client may be
  // held. If they were equal, `inFlight` would always clear before the next
  // sample and single-flight would never engage. ×4 turns the default 5 s wait
  // into a 20 s statement bound — under `drillScheduler`'s 30 s
  // `lockPool.end()` race.
  const statementCeilingMs = confirmCeilingMs * 4

  const boundedPool: AdvisoryLockQueryRunner = {
    query: <R extends QueryResultRow>(text: string, values?: unknown[]) => pool.query<R>({
      text,
      values,
      // Not on `QueryConfig` in `@types/pg` (only on `ClientConfig`), though
      // `pg` reads it per query; hence the cast.
      query_timeout: statementCeilingMs,
    } as QueryConfig & { query_timeout: number }),
  }

  const askFresh = (): Promise<AdvisoryLockOwnershipCheck> => {
    // `ceilingMs: 0` — the wait is bounded below so the raw promise stays
    // visible to `inFlight`; the statement is bounded by `boundedPool`.
    const asked = checkAdvisoryLockOwnership(boundedPool, lock.key, lock.backendPid, {
      backendStart: lock.backendStart,
      ceilingMs: 0,
    })
    inFlight = asked
    // Cleared for THIS question only, so a slow answer cannot release a newer
    // question's claim. (Defensive: while single-flight holds, questions never
    // overlap, and `checkAdvisoryLockOwnership` does not reject — so no test
    // can distinguish this guard or the rejection handler.)
    const clear = (): void => { if (inFlight === asked) inFlight = null }
    void asked.then(clear, clear)
    const ceiling = expiresIn(confirmCeilingMs)
    const expired: AdvisoryLockOwnershipCheck = {
      verdict: 'unknown',
      fenced: lock.backendStart !== null,
      error: `the independent ownership check did not answer within ${confirmCeilingMs} ms`,
    }
    return Promise.race([asked, ceiling.promise.then(() => expired)])
      .finally(() => { ceiling.cancel() })
  }

  /** What the independent samples have established so far.
   *
   *  Counts per verdict, not only the last one: `ours: 1439, unknown: 1` and
   *  `ours: 1, unknown: 1439` have the same `last` and describe opposite runs. */
  const watch = {
    samples: 0,
    ours: 0,
    notOurs: 0,
    unknown: 0,
    /** Transitions between verdicts, counted whether or not a line was spent on
     *  them — so the cap below can never make a flapping night look calm. */
    changes: 0,
    changesLogged: 0,
    last: null as AdvisoryLockOwnership | null,
    /** The last sample's error, carried into the summary so it says why. */
    lastError: null as string | null,
    /** Wall clock of the last CONCLUSIVE sample, so its age can be reported
     *  later. `null` until one exists — never `0`, which would read as
     *  "sampled at the very start". */
    lastAt: null as number | null,
  }
  let watchStopped = false
  /** Ends the nap the watch is CURRENTLY in; `null` when it is not in one. */
  let wakeNap: (() => void) | null = null
  const stopWatch = (): void => {
    watchStopped = true
    // Wakes the nap immediately, so no further sample is armed against a pool
    // the caller may already be ending.
    wakeNap?.()
  }

  /** How the watch's findings are LOGGED.
   *
   *  Deliberately not the shape of `DrillAbandonment.lockWatch`: `lastAtMs` here
   *  is relative to the tick's start (a log line is read against the run's
   *  timeline); `ageMs` there is relative to now (a report is read against the
   *  moment it was written). */
  const watchFields = (): Record<string, unknown> => ({
    samples: watch.samples,
    ours: watch.ours,
    notOurs: watch.notOurs,
    unknown: watch.unknown,
    changes: watch.changes,
    // What the line cap dropped; `0` is the common case.
    changesSuppressed: watch.changes - watch.changesLogged,
    last: watch.last,
    lastError: watch.lastError,
    lastAtMs: watch.lastAt === null ? null : watch.lastAt - startedAt,
  })

  /** Fold one answer into the tally. Separate from `takeSample` because the
   *  abandonment path takes a final sample of its own that must be counted the
   *  same way. Returns whether this was the first sample and whether it changed
   *  the answer. */
  const recordSample = (check: AdvisoryLockOwnershipCheck): { first: boolean; changed: boolean } => {
    const first = watch.samples === 0
    const changed = !first && check.verdict !== watch.last
    watch.samples += 1
    if (changed) watch.changes += 1
    watch.last = check.verdict
    watch.lastError = check.error
    // **Only a CONCLUSIVE verdict dates the evidence.** `unknown` means nothing
    // was learned (ceiling expiry, failed query, unreadable token, or the
    // single-flight placeholder); stamping the clock on it would make stale
    // evidence look fresh.
    if (check.verdict !== 'unknown') watch.lastAt = Date.now()
    if (check.verdict === 'ours') watch.ours += 1
    else if (check.verdict === 'not-ours') watch.notOurs += 1
    else watch.unknown += 1
    return { first, changed }
  }

  /** How old the newest CONCLUSIVE independent answer is, right now.
   *
   *  `?? startedAt` is a live branch: a cluster that never answers conclusively
   *  leaves `lastAt` null, and "as old as the run" is the truthful age. */
  const evidenceAgeMs = (): number => Date.now() - (watch.lastAt ?? startedAt)

  /**
   * One independent sample. Returns whether the watch should take another.
   *
   * Three outcomes, and only one of them stops the drill:
   *
   *  - `not-ours` — somebody else holds the key, or nobody does. Continuing is
   *    the concurrency the lock exists to prevent, so this is a real
   *    `lock-lost`, established rather than assumed.
   *  - `ours` — the key is intact and the loss was about the CONNECTION, the
   *    usual answer behind a black-holed socket: the backend has not noticed
   *    its client is gone and still holds the key.
   *  - `unknown` — the second connection could not answer either; the run
   *    continues.
   *
   * The verdict does NOT feed `exclusive`, which reports what the RELEASE
   * proved; a mid-run `pg_locks` answer cannot vouch for a broken client.
   */
  const takeSample = async (loss: SessionAdvisoryLockLoss | null): Promise<boolean> => {
    const check = await askIndependently()
    const { first, changed } = recordSample(check)

    // The tick may have ended, or stopped for another reason, while the question
    // was in flight. That forbids ACTING on the answer, but it is still
    // REPORTED, so late evidence is not lost.
    const stillRunning = !settled && cutShortBy === null
    if (check.verdict === 'not-ours' && stillRunning) {
      stop(
        'lock-lost',
        `an independent connection confirms advisory lock ${lock.key} is no longer held by backend `
        + `${lock.backendPid} (the heartbeat reported ${loss?.reason ?? 'a loss'}; `
        + `established on independent check ${watch.samples})`,
      )
      return false
    }
    if (first || check.verdict === 'not-ours') {
      // The first sample that reaches here gets a line: it shows the watch
      // started. (A first `not-ours` on a live run stops instead, and the stop
      // line carries the same information.) A `not-ours` reaching here means the
      // run had already ended — evidence arriving too late, which would
      // otherwise be silent.
      log('backup.drill_exclusion_unverified', {
        detail: describeConfirmation(check.verdict, stillRunning, watchMs > 0),
        reason: loss?.reason ?? null,
        lossDetail: loss?.detail ?? null,
        confirmed: check.verdict,
        fenced: check.fenced,
        checkError: check.error,
        // With `confirmed: 'not-ours'`, this means the exclusion had gone and the
        // answer came back too late to act on.
        actedOn: false,
        runEnded: !stillRunning,
        afterMs: Date.now() - startedAt,
        ...watchFields(),
      })
    } else if (changed && watch.changesLogged < MAX_WATCH_CHANGE_LINES) {
      // Only on a change of answer, and capped (see `MAX_WATCH_CHANGE_LINES`):
      // a line per sample would be 1 440 lines on a six-hour run, and a
      // flapping cluster changes on every sample. `changes` and
      // `changesSuppressed` in the summary carry what was dropped.
      watch.changesLogged += 1
      log('backup.drill_exclusion_changed', {
        detail: 'the independent exclusion watch changed its answer',
        confirmed: check.verdict,
        checkError: check.error,
        afterMs: Date.now() - startedAt,
        ...watchFields(),
      })
    }
    return stillRunning
  }

  /**
   * Keep asking until the run ends.
   *
   * Serial — the next sample is armed only after the previous one returned, so
   * a slow cluster cannot pile requests onto a pool of two. Hence a nap after
   * each sample rather than a `setInterval`.
   */
  const runWatch = async (loss: SessionAdvisoryLockLoss | null): Promise<void> => {
    for (;;) {
      const keepGoing = await takeSample(loss)
      // `watchMs <= 0` means one sample and stop.
      //
      // No `watchStopped` check is needed here: `stopWatch()` is only called
      // from `detach()`, whose triggers already make `keepGoing` false.
      // `keepGoing` itself is defensive — the post-nap `watchStopped` check
      // also stops the loop — but it still stops it should a future exit path
      // forget `detach()`.
      if (!keepGoing || watchMs <= 0) return
      // A FRESH promise per nap, never one long-lived promise raced every
      // iteration: each `Promise.race` attaches a reaction that lives until the
      // shared promise settles, so memory grows with run length (measured
      // ~0.47 MB over 1 440 iterations, ~6 MB over 20 000, versus ~0.02–0.05 MB
      // with a promise per nap).
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, watchMs)
        timer.unref?.()
        wakeNap = () => { clearTimeout(timer); resolve() }
      })
      wakeNap = null
      // Load-bearing: the nap is where the tick can end underneath the loop, and
      // without this check the next iteration would sample a pool the caller
      // has already started closing. (`wakeNap = null` above is only hygiene: a
      // stale handle's calls would be no-ops.)
      if (watchStopped) return
    }
  }

  const startWatch = (loss: SessionAdvisoryLockLoss | null): void => {
    void runWatch(loss)
      // `.catch` even though `runWatch` is written not to reject: an unhandled
      // rejection would crash the standalone scheduler process.
      .catch((error: unknown) => {
        log('backup.drill_exclusion_watch_failed', {
          detail: 'the independent exclusion watch threw; nothing is watching the key any more',
          error: error instanceof Error ? error.message : String(error),
          ...watchFields(),
        })
      })
      // Emitted after the loop ends, not from inside it, so the summary covers
      // the whole watch.
      .finally(() => {
        log('backup.drill_exclusion_watch_ended', {
          detail: watch.notOurs > 0
            ? 'the independent watch had established the exclusion was gone'
            : 'the independent watch stopped with the run; what it last saw is below',
          reason: loss?.reason ?? null,
          ...watchFields(),
        })
      })
  }

  // Everything armed above, taken back down in ONE place, so every exit
  // disarms the same set. (On the early return below, the caller signal was
  // already aborted when its `{ once: true }` listener was attached, so the
  // listener never fires and must be removed explicitly.)
  const detach = (): void => {
    if (deadline) clearTimeout(deadline)
    callerSignal?.removeEventListener('abort', onCallerStop)
    // For symmetry rather than leak prevention: `lock.signal` dies with this
    // tick's lock handle, unlike `callerSignal`, which outlives every tick.
    lock.signal.removeEventListener('abort', onLockLost)
    // The watch is stopped here too, so there is one teardown. On the
    // abandonment path its last sample is then up to `graceMs` old by the time
    // the report is written, which is why the abandonment takes a final sample
    // of its own.
    stopWatch()
  }

  if (cutShortBy !== null) {
    // The stop landed during the acquisition. Starting the drill now would
    // hand it an already-aborted signal and then wait a five-minute grace for
    // work that should never have begun — and a drill is not obliged to check
    // `signal.aborted` before its first await, so it may not stop at all. Give
    // the key back and say so. (The deadline cannot have fired yet: it was
    // armed three statements ago.)
    detach()
    log('backup.drill_skipped_stopping', {
      detail: 'the scheduler stopped while the lock was being acquired; the key was taken and '
        + 'given straight back without running a drill',
      lockTaken: true,
      backendPid: lock.backendPid,
    })
    await lock.release()
    return { status: 'skipped_stopping' }
  }

  // Never rejects: a rejection arriving after the grace expired would otherwise
  // be an unhandled rejection.
  //
  // `Promise.resolve().then(...)` rather than a bare call: a non-`async` `drill`
  // that throws synchronously would otherwise escape before the `try`, leaking
  // the deadline timer, the listeners, the checked-out client and the lock.
  let settled = false
  const drilling: Promise<{ failed: boolean; failure: unknown }> = Promise.resolve()
    .then(() => context.drill(stopper.signal))
    .then(
      () => { settled = true; return { failed: false, failure: undefined } },
      (failure: unknown) => { settled = true; return { failed: true, failure } },
    )
  try {
    // The drill against the STOP REQUEST, not a bare timer: a stop has already
    // sent the abort, and a bare `await drilling` could wait forever.
    await Promise.race([drilling, stopRequested])
  } finally {
    detach()
  }

  if (!settled) {
    // A stop was requested and the drill has not answered yet. The grace is the
    // window in which it is expected to: `pgTools` kills its child, the
    // rejection unwinds, and `runBackupDrill`'s own `finally` tears down. The
    // key stays held throughout, because that teardown still touches the
    // cluster (`assertKeepaliveGraceFits` ensures the cluster does not reap the
    // session first).
    const grace = expiresIn(graceMs)
    try {
      await Promise.race([drilling, grace.promise])
    } finally {
      grace.cancel()
    }
  }

  if (!settled) {
    // Already resolved — `stopRequested` won the race above — so this awaits
    // nothing.
    const reason = await stopRequested
    // ONE LAST INDEPENDENT SAMPLE for the signed report: the watch stopped when
    // the stop was requested (so its last sample is up to `graceMs` old), and on
    // a plain `deadline` abandonment it never ran at all — without this, the
    // report would carry no independent evidence on the path where the process
    // is being killed. It is bounded by `confirmCeilingMs`, and the key is
    // still held, so the delay opens no window for a rival.
    //
    // `.catch` because this is the path where the key is deliberately still
    // held: a throw here would leave the lock held AND `abandon` uncalled.
    //
    // `detach()` stops the loop but not an outstanding query, so a watch sample
    // may still be in flight and single-flight will answer `unknown` without
    // asking — hence the age below dates the last CONCLUSIVE answer.
    const finalCheck = await askIndependently().catch((error: unknown) => ({
      verdict: 'unknown' as const,
      fenced: lock.backendStart !== null,
      error: `the final independent check threw: ${error instanceof Error ? error.message : String(error)}`,
    }))
    recordSample(finalCheck)
    const abandonment: DrillAbandonment = {
      reason,
      heldMs: Date.now() - startedAt,
      deadlineMs,
      graceMs,
      backendPid: lock.backendPid,
      backendStart: lock.backendStart,
      lockKey: lock.key,
      lockLoss: lock.loss()?.reason ?? null,
      keepaliveDetectsWithinSeconds: lock.keepalives.detectsWithinSeconds,
      lockWatch: {
        verdict: finalCheck.verdict,
        // Age of the newest conclusive ANSWER, not of the newest attempt: large
        // exactly when the cluster has stopped answering.
        ageMs: evidenceAgeMs(),
        checks: watch.samples,
        fenced: finalCheck.fenced,
      },
    }
    log('backup.drill_abandoned', {
      // Reason-dependent: the deadline wording ("the key is held on purpose")
      // would be false for a lost lock, where a rival may already hold it.
      detail: reason === 'lock-lost'
        ? 'the exclusion was lost and the drill did not stop within the grace, so it may still be '
          + 'dumping WITHOUT one; this session may no longer hold the key at all, and ending it is '
          + 'the only thing that stops the unprotected work'
        : 'the drill did not stop within the grace, so it may still be dumping; '
          + 'the advisory lock is deliberately NOT released — only ending this session can '
          + 'return the key without letting a rival dump concurrently',
      ...abandonment,
    })
    // Guarded: the key is deliberately still held here, so a throw from
    // caller-supplied code would leave the lock held AND the caller believing
    // the tick merely errored.
    try {
      abandon(abandonment)
    } catch (error) {
      log('backup.drill_abandon_handler_failed', {
        detail: 'the abandonment handler threw; the advisory lock is still held by this session '
          + 'and only ending the process can return it',
        error: error instanceof Error ? error.message : String(error),
        ...abandonment,
      })
    }
    return { status: 'abandoned', abandonment }
  }

  // Already settled: this reads the outcome, it does not wait.
  const settledOutcome = await drilling

  // Not `try { … } finally { release() }`: the release OUTCOME has to be part of
  // what this function reports, and a `finally` cannot contribute to a return
  // value without discarding the drill's own error. Catch, release, report,
  // re-throw — in that order.
  const released = await lock.release()
  // No `released.error === null` clause: `confirmed` is only set from a
  // statement that returned, so an error already implies `confirmed === false`.
  const exclusive = released.confirmed && released.loss === null
  if (!exclusive) {
    // Covers `pg_advisory_unlock` returning `false` (the lock had already gone)
    // as well as a loss seen during the run.
    log('backup.drill_ran_without_exclusion', {
      detail: 'the drill did not provably hold the exclusion for its whole run; '
        + 'a second scheduler may have dumped, reported and swept concurrently',
      unlockConfirmed: released.confirmed,
      unlockError: released.error,
      lossReason: released.loss?.reason ?? null,
      lossDetail: released.loss?.detail ?? null,
      lossObservedAfterMs: released.loss?.observedAfterMs ?? null,
      backendPid: lock.backendPid,
    })
  }

  if (settledOutcome.failed) throw settledOutcome.failure
  return { status: 'ran', exclusive, cutShortBy }
}
