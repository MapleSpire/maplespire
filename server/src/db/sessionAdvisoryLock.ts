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

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'

/**
 * A Postgres session advisory lock that survives the job it is protecting.
 *
 * ## Why a held client
 *
 * `pg_try_advisory_lock` is SESSION-scoped: it lives and dies with the backend
 * that took it. Taken through `pool.query`, the client goes straight back to the
 * pool as idle, and `pg-pool` destroys an idle client after
 * `idleTimeoutMillis` — which defaults to **10 000 ms** with `min: 0`. The lock
 * dies with it, roughly ten seconds into a job that may run for minutes, and a
 * rival can then take the same key (two schedulers running `pg_dump`
 * concurrently, racing on one report, sweeping one bundle root twice).
 *
 * `pg_advisory_unlock` also returns **`false`** — it does not raise — when the
 * calling session does not hold the lock, so a release whose value is discarded
 * cannot distinguish a lock that already evaporated from a clean release.
 *
 * ## What this module guarantees, and what it cannot
 *
 *  1. **The lock is held for as long as the handle is held.** The client is
 *     checked out for the lock's whole life, so no idle timeout can reach it.
 *  2. **Release is answered, not assumed.** `release()` returns what
 *     `pg_advisory_unlock` actually said. `confirmed: false` is the signature of
 *     a lock that was already gone, and the caller is handed it rather than a
 *     swallowed promise.
 *  3. **Loss is observable while it still matters — ONCE.** A heartbeat asks
 *     `pg_locks` — an authority independent of "our connection object still
 *     exists" — whether THIS backend still holds THIS key, and aborts `signal`
 *     when the answer stops being yes.
 *
 *     `markLost` clears the interval and **never re-arms**, and `signal` is a
 *     single-shot `AbortSignal` that deliberately keeps the FIRST loss. So
 *     after one loss this module observes nothing further, and a caller must
 *     not read the guarantee as continuous. `drillTick` continues watching from
 *     outside, on a second connection, because only the caller knows whether a
 *     lost key should stop the work.
 *
 * It cannot make the lock unlosable. A killed backend, `pg_terminate_backend`,
 * or `pg_advisory_unlock_all` all release it, and that is by design: the header
 * of `drillScheduler` wants a dead holder to stop blocking its successor. What
 * changes here is that losing it is now an event with a timestamp instead of
 * silence.
 *
 *  4. **A holder that will not let go can be made to.** `terminateAdvisoryLockHolder`
 *     turns the third paragraph above from a hazard into a tool: it ends the
 *     holding session from an independent connection and confirms against
 *     `pg_locks`. The module therefore both takes the key and — for a caller
 *     that has given up on the work it protects — gives it back without the
 *     holder's cooperation.
 *
 *  5. **A holder whose NETWORK died stops holding in minutes, not hours — and
 *     nobody has to ask.** Guarantees 3 and 4 both need somebody still running
 *     to notice and to act. This one does not: the acquiring statement lowers
 *     this session's `tcp_keepalives_*`, so the cluster reaps the backend on
 *     its own and the key comes back. See `DEFAULT_KEEPALIVES` for the measured
 *     numbers, for why this is a per-session `SET` and not an ops task, and for
 *     the one case it does not cover.
 *
 *     `keepalives.detectsWithinSeconds` on the handle is the effective window
 *     as the KERNEL took it, `null` when the belt did not land. It is never
 *     inferred from what was requested, because the case worth reporting is
 *     exactly the case where the two differ.
 */

/** Advisory-lock ownership, asked of `pg_locks` rather than inferred.
 *
 * `pg_try_advisory_lock(bigint)` splits its key across the lock tag exactly as
 * `SET_LOCKTAG_INT64` does — `classid` is the high word, `objid` the low word,
 * `objsubid` is 1 (the two-argument form uses 2, which is why `objsubid` is
 * part of the predicate rather than assumed).
 *
 * `database` is in the predicate for the DESTRUCTIVE reader below rather than
 * for this one. Advisory locks are per-database, and the drill's key is a
 * constant every scheduler in the fleet shares — so two MapleSpire databases in
 * one cluster hold the same `classid`/`objid` legitimately. Asking about our own
 * backend cannot confuse them (a backend is attached to exactly one database),
 * but asking about an ARBITRARY pid can, and there the answer authorises a kill.
 *
 * The decode is checked against a live cluster by the integration test, for
 * more than one key.
 *
 * `pid = pg_backend_pid()` is the load-bearing clause. Without it this asks
 * "does anybody hold the key", which is true when a RIVAL has taken it over —
 * the precise moment ownership must read as lost. */
const ADVISORY_TAG_MATCH = `locktype = 'advisory'
     AND granted
     AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND classid = (($1::bigint >> 32) & 4294967295)::bigint
     AND objid = ($1::bigint & 4294967295)::bigint
     AND objsubid = 1`

const OWNERSHIP_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND ${ADVISORY_TAG_MATCH}
) AS held`

/**
 * The session's identity, as something the OS cannot recycle.
 *
 * A pid alone is a number Linux hands out again — `kernel.pid_max` is 4 194 304
 * with systemd but 32 768 on a classic default, and an abandonment fires hours
 * after the pid was recorded. `pg_stat_activity.backend_start` pins the pid to
 * ONE session, so `(pid, backendStart)` is a fencing token: a recycled pid is a
 * different backend with a different start time and simply does not match.
 *
 * **Epoch MICROSECONDS as a decimal string** — the obvious encodings are both
 * wrong in ways that fail silently:
 *
 * ```
 *   backend_start                       2026-08-23 03:05:50.107573+00
 *   node-postgres parses it to a JS Date        …50.107   (MILLISECONDS)
 *
 *   handed back as `= $3::timestamptz`  ->  matchesOwn: FALSE, refusesWrong: true
 *   compared as `backend_start::text`   ->  matchesOwn: true,  refusesWrong: true
 *   compared as epoch microseconds      ->  matchesOwn: true,  refusesWrong: true
 * ```
 *
 * The first row is the trap. A token that never matches makes the terminate
 * find no row, kill nothing, and report `released: true` — a confident, wrong
 * clean bill of health on the one path that exists to unblock the fleet. The
 * `::text` form works and is rejected anyway: its rendering depends on
 * `DateStyle`, which is a per-role setting, so two sessions could disagree.
 * Microseconds are an integer.
 *
 * `int8` arrives from node-postgres as a string, so the value never passes
 * through a JS number and cannot lose a digit on the way back.
 */
const BACKEND_START_TOKEN = `(SELECT (EXTRACT(epoch FROM backend_start) * 1000000)::bigint::text
     FROM pg_stat_activity WHERE pid = pg_backend_pid())`

/** The token AS SEEN BY THE ASKER, which is not always readable.
 *
 * `pg_stat_activity` masks `backend_start` for backends belonging to a role the
 * caller is not a member of, while `pg_locks` masks nothing. That asymmetry is
 * the whole reason the two facts below are returned SEPARATELY. */
const TOKEN_OF = (pid: string): string => `(SELECT (EXTRACT(epoch FROM backend_start) * 1000000)::bigint::text
     FROM pg_stat_activity WHERE pid = ${pid})`

/**
 * TWO FACTS, not one verdict.
 *
 * Putting the fence inside the WHERE clause would give an asker who cannot READ
 * the token (a different role) the same answer as an asker asking about a
 * backend that holds nothing:
 *
 * ```
 *                              pg_locks row   token readable   fenced predicate
 *   same role                       1            yes                true
 *   a DIFFERENT role                1            no                 false   <-
 *   a pid holding nothing           0            yes                false   <-
 * ```
 *
 * Downstream, `not-ours` stops a long dump, and on the destructive path a
 * missing row means `released: true` while a live backend may still hold the key.
 *
 * `AdvisoryLockOwnership` has three values; a boolean predicate can carry two.
 * So the SQL reports what it observed and the reconstruction happens in
 * TypeScript, where the third value exists. Same rule as `documentCensus`:
 * classify, never let an unrecognised case fall on the exempt side.
 */
const HOLDER_SQL = `SELECT
    EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = $2::int AND ${ADVISORY_TAG_MATCH}) AS pid_holds,
    ${TOKEN_OF('$2::int')} AS token`

/**
 * Kill the backend holding `$1` — but only if that backend is still `$2`, and
 * only if it is not the one asking.
 *
 * **One statement, and that is the whole safety argument.** Pids are recycled by
 * the OS, so `SELECT pid FROM pg_locks` followed by a separate
 * `pg_terminate_backend(pid)` is a check-then-act on a value that can go stale
 * between the two — and what it would kill is an unrelated backend chosen by a
 * coincidence of numbering. Here the `pg_locks` scan and the signal happen
 * inside one query execution, against one snapshot: the predicate that selects
 * the row IS the predicate that authorises the kill, so a pid that no longer
 * holds our key produces **no row** and no signal rather than a wrong victim.
 *
 * `CASE` and not `AND l.pid <> pg_backend_pid()` in the WHERE clause. Excluding
 * ourselves by predicate returns zero rows for a self-termination request, which
 * is indistinguishable from "that backend already died" — the caller would be
 * told the key was released when the truth is that nothing was even attempted.
 * `CASE` short-circuits (Postgres guarantees the untaken branch is not
 * evaluated, and a volatile function on a column reference is not folded), so
 * the row still comes back and carries `is_self` for the caller to report.
 */
const TERMINATE_HOLDER_SQL = `WITH holder AS (
  SELECT l.pid, ${TOKEN_OF('l.pid')} AS token
    FROM pg_locks l
   WHERE l.pid = $2::int AND ${ADVISORY_TAG_MATCH}
   LIMIT 1
)
SELECT
    h.pid = pg_backend_pid() AS is_self,
    h.token IS NOT NULL AS token_readable,
    h.token IS NOT DISTINCT FROM $3::text AS token_matches,
    CASE
      WHEN h.pid = pg_backend_pid() THEN false
      WHEN $3::text IS NOT NULL AND h.token IS DISTINCT FROM $3::text THEN false
      ELSE pg_terminate_backend(h.pid)
    END AS signalled
  FROM holder h`

/** The structural minimum both `Client` and `PoolClient` satisfy. */
export type AdvisoryLockQueryRunner = {
  query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>
}

/**
 * Does the backend behind `runner` hold `key` right now?
 *
 * Exported because its correctness is entirely Postgres semantics — the lock-tag
 * decode and the `pg_backend_pid()` clause — and that is the half a fake pool
 * cannot check. It has its own four-case table against a live cluster in
 * `sessionAdvisoryLock.integration.test.ts`, including the two cases that a
 * plausible-but-wrong predicate passes: asking about a key we do NOT hold while
 * holding another, and asking about a key a RIVAL holds.
 */
export async function advisoryLockHeldByThisSession(
  runner: AdvisoryLockQueryRunner,
  key: number,
): Promise<boolean> {
  assertSafeAdvisoryKey(key)
  const { rows } = await runner.query<{ held: boolean }>(OWNERSHIP_SQL, [key])
  return rows[0]?.held === true
}

/** What an INDEPENDENT connection could establish about a lock's ownership.
 *
 * Three values, not two, and the third is the point. `unknown` is not a polite
 * `not-ours`: it means the question could not be asked, and a caller that
 * collapses it into either answer is inventing evidence. */
export type AdvisoryLockOwnership = 'ours' | 'not-ours' | 'unknown'

export interface AdvisoryLockOwnershipCheck {
  readonly verdict: AdvisoryLockOwnership
  /** Whether the answer was fenced by the session token. An `ours` that is not
   *  fenced means "some backend with that pid holds it" — which a recycled pid
   *  satisfies. */
  readonly fenced: boolean
  readonly error: string | null
}

/**
 * Ask a connection that is NOT the lock's whether `backendPid` still holds `key`.
 *
 * ## The question this exists to make askable
 *
 * `sessionAdvisoryLock`'s heartbeat runs on the lock's own client and reports
 * three kinds of loss. Only one of them — `not-owner` — is an ANSWER; the other
 * two mean the question could not be reached, because the connection carrying
 * it is the connection that broke. `drillTick` therefore had to choose between
 * two bad options on an inconclusive loss: keep dumping with no exclusion, or
 * abort a six-hour dump on evidence of nothing.
 *
 * A second connection dissolves the choice. It is a different socket to the
 * same cluster, so the failure that silenced the first is usually not its
 * failure, and `pg_locks` answers the same question authoritatively:
 *
 *  - `ours` — the key is still attributed to that session. The drill's
 *    exclusion is intact and the loss was about the CONNECTION, not the lock.
 *    This is the common case behind a black-holed socket: the backend has not
 *    noticed the client is gone, so it is still sitting on the key, so nobody
 *    else can have it.
 *  - `not-ours` — somebody else has it, or nobody does. Continuing to dump is
 *    the defect the lock exists to prevent.
 *  - `unknown` — the cluster could not be reached from here either. Nothing was
 *    learned, and the caller must not pretend otherwise.
 *
 * Bounded, and it never throws: a check that hangs would be a new way to lose
 * the very liveness it is protecting.
 */
export async function checkAdvisoryLockOwnership(
  runner: AdvisoryLockQueryRunner,
  key: number,
  backendPid: number,
  options: {
    backendStart?: string | null
    /** Wall clock on the whole question. **`0` means the CALLER bounds it**, and
     *  there is exactly one caller that does.
     *
     *  A ceiling here bounds the WAIT and not the STATEMENT — `pg` takes no
     *  `AbortSignal` — so an expired check leaves its `pool.query` running,
     *  holding a client. For a one-shot question that is acceptable. For a
     *  REPEATING one, the abandoned queries pile up behind the pool, and even a
     *  single checked-out client keeps `pool.end()` from ever resolving
     *  (pg-pool settles only at `_clients.length === 0`).
     *
     *  A caller that repeats the question should therefore bound the STATEMENT
     *  itself with a runner that sets `query_timeout` (the driver rejects the
     *  query and pg-pool releases the client), ask single-flight, and pass `0`
     *  here. `drillTick` does exactly that. */
    ceilingMs?: number
  } = {},
): Promise<AdvisoryLockOwnershipCheck> {
  assertSafeAdvisoryKey(key)
  const backendStart = options.backendStart ?? null
  const fenced = backendStart !== null
  try {
    const ceilingMs = options.ceilingMs ?? DEFAULT_OWNERSHIP_CHECK_CEILING_MS
    const asked = runner.query<{ pid_holds: boolean; token: string | null }>(
      HOLDER_SQL, [key, backendPid],
    )
    const { rows } = ceilingMs <= 0
      ? await asked
      : await withCeiling(
        asked,
        ceilingMs,
        `the independent ownership check did not answer within ${ceilingMs} ms`,
      )
    // A bare `SELECT EXISTS (...)` with no `GROUP BY` returns exactly one row,
    // so no guard for a missing row.
    const row = rows[0]!
    // The three values, in the order they must be tested.
    //
    //  1. That backend holds no such lock. Whatever else is true, the key is
    //     not ours — and this is the ONE answer that does not need the token,
    //     because there is nothing to fence.
    if (!row.pid_holds) return { verdict: 'not-ours', fenced, error: null }
    //  2. It holds the lock, and we asked to fence but cannot read the token.
    //     NOTHING was established: the session behind that pid may or may not
    //     be ours. Folding this into `not-ours` would stop a healthy drill.
    if (fenced && row.token === null) {
      return {
        verdict: 'unknown',
        fenced,
        error: 'pg_stat_activity did not report backend_start for that backend, so the session '
          + 'behind the pid could not be identified',
      }
    }
    //  3. It holds the lock and the session either matches or was never fenced.
    return { verdict: row.token === backendStart || !fenced ? 'ours' : 'not-ours', fenced, error: null }
  } catch (error) {
    return { verdict: 'unknown', fenced, error: describe(error) }
  }
}

/** Ceiling on the independent ownership check.
 *
 * Shorter than the termination's, and for the opposite reason: this one runs
 * WHILE the drill is still working, so the cost of waiting is a drill that
 * keeps dumping without an exclusion for exactly as long as the wait. The
 * question is a single indexed lookup in a shared-memory view. */
export const DEFAULT_OWNERSHIP_CHECK_CEILING_MS = 5_000

/** Default ceiling on the whole terminate-and-confirm sequence. Generous
 *  against a SIGTERM that a Postgres backend normally answers in milliseconds,
 *  and finite because this runs on the path that exists to bound things. */
export const DEFAULT_TERMINATION_CEILING_MS = 10_000

/** How often the release is re-asked while waiting for the backend to die. */
export const DEFAULT_TERMINATION_POLL_MS = 250

export interface AdvisoryLockTermination {
  /** A SIGTERM was actually sent to `backendPid`. `false` alongside
   *  `released: true` is the ordinary "it was already gone" answer. */
  readonly signalled: boolean
  /** **The witness that matters**: `pg_locks` no longer attributes `key` to
   *  `backendPid`. Deliberately not derived from what `pg_terminate_backend`
   *  returned — that value says a signal was *sent*, not that the backend died. */
  readonly released: boolean
  /** The caller asked to terminate the very backend it was asking from. Refused
   *  rather than attempted, and reported rather than folded into `released`. */
  readonly refusedSelf: boolean
  /** A fencing token was supplied, so the kill was authorised by SESSION
   *  identity rather than by a pid the OS reissues.
   *
   *  Reported because `false` is two different situations that the caller
   *  cannot otherwise tell apart — a deployment whose `pg_stat_activity` would
   *  not say, and a call site that forgot to thread `lock.backendStart`
   *  through. Both are weaker; only one is anybody's fault. */
  readonly fenced: boolean
  /** The statement could not be run or could not be answered. Distinct from
   *  `released: false`: one is Postgres not answering, the other is Postgres
   *  saying the key is still held. */
  readonly error: string | null
  readonly waitedMs: number
}

/** A wait that cannot by itself keep the process alive. Every caller of this
 *  function is on an exit path, and a ref'd timer there is a delay nobody asked
 *  for; the connection the poll runs on is what holds the loop open. */
function pause(ms: number): Promise<void> {
  return new Promise<void>((settle) => {
    const timer = setTimeout(settle, ms)
    timer.unref?.()
  })
}

/**
 * Return `key` by killing the session that holds it, and CONFIRM that it worked.
 *
 * ## Why this exists rather than just exiting
 *
 * A session advisory lock is released when its backend dies, so ending the
 * process does return the key — eventually, and by a mechanism that is not the
 * process's to control. What actually tells Postgres the client is gone is the
 * FIN on that socket. If the socket is the broken thing — a proxy that dropped
 * the flow, a firewall state-table eviction, a NAT rebind — nothing arrives, and
 * the backend sits idle holding the key until the kernel gives up
 * retransmitting: `tcp_retries2`, roughly **fifteen minutes** on Linux, and
 * two hours if it falls through to `tcp_keepalive_time` instead. The whole
 * argument of `drillTick`'s abandonment path is that ending the session is what
 * returns the key; leaving that to the transport makes the argument true on
 * average and false exactly when the transport is what failed.
 *
 * So the key is returned by an independent connection issuing
 * `pg_terminate_backend`. With the holder's flow black-holed (no FIN, no RST),
 * an unterminated holder still held the key at 12 000 ms; a terminated one
 * released it on the first re-check.
 *
 * `DEFAULT_KEEPALIVES`, which `acquireSessionAdvisoryLock` applies to its own
 * session, makes the kernel tear such a flow down on its own. This function
 * still matters because keepalives need the holder's socket to be idle: a
 * backend inside a query never looks at its socket. It also covers a holder
 * that is perfectly reachable and simply will not let go.
 *
 * ## What `runner` must be
 *
 * **Not the connection holding the lock.** That would be asking a backend to
 * kill itself and then report on it. The statement refuses it structurally and
 * says so through `refusedSelf`, but a caller that hits that guard has passed
 * the wrong pool and gets no key back.
 *
 * ## What this cannot do
 *
 * It needs the cluster to be reachable from a NEW connection. When Postgres
 * itself is gone, `released` is `false` with an `error`, and the caller is back
 * to the transport — which is the honest answer rather than a better one.
 */
export async function terminateAdvisoryLockHolder(
  runner: AdvisoryLockQueryRunner,
  key: number,
  backendPid: number,
  options: {
    ceilingMs?: number
    pollMs?: number
    /** `lock.backendStart`. Omitting it is NOT the same as passing `null`:
     *  `null` is the measured "this deployment would not tell us", while
     *  forgetting to thread it through is a kill authorised by a recyclable
     *  number. There is no way for a type to tell those apart, which is why
     *  `AdvisoryLockTermination.fenced` reports which one happened. */
    backendStart?: string | null
  } = {},
): Promise<AdvisoryLockTermination> {
  assertSafeAdvisoryKey(key)
  const ceilingMs = options.ceilingMs ?? DEFAULT_TERMINATION_CEILING_MS
  const pollMs = options.pollMs ?? DEFAULT_TERMINATION_POLL_MS
  const backendStart = options.backendStart ?? null
  const fenced = backendStart !== null
  // `Date.now` directly, with no injectable clock, and the omission is
  // deliberate: the poll below terminates only because time passes, so a test
  // handing it a frozen `now` would spin forever rather than fail. Small real
  // ceilings (a hundred milliseconds) make the same cases reachable in a test
  // without inventing a second, weaker bound to protect against the first.
  const startedAt = Date.now()
  const elapsed = (): number => Date.now() - startedAt
  // Hoisted out of the `try`, so a verification that fails after a signal was
  // sent still reports the signal. Reporting `signalled: false` there would
  // describe a backend nobody touched.
  let signalled = false
  try {
    const { rows } = await withCeiling(
      runner.query<{
        is_self: boolean
        token_readable: boolean
        token_matches: boolean
        signalled: boolean
      }>(TERMINATE_HOLDER_SQL, [key, backendPid, backendStart]),
      ceilingMs,
      `pg_terminate_backend did not answer within ${ceilingMs} ms`,
    )
    const row = rows[0]
    if (!row) {
      // No row means `pg_locks` does not attribute this key to this backend, so
      // whatever else is true, THIS session is not what stands between the key
      // and its next holder. That covers both interesting cases: the backend
      // already died, and a rival took the key over.
      //
      // Pid reuse is bounded, not eliminated: our backend dies, the OS recycles
      // its pid, and the new owner is another drill holding the SAME key — the
      // rightful successor. The fencing token removes that case by matching on
      // SESSION; without one (a cluster that will not report `backend_start`)
      // the residue stands, which is why `fenced` is reported.
      return { signalled: false, released: true, refusedSelf: false, fenced, error: null, waitedMs: elapsed() }
    }
    if (row.is_self) {
      return {
        signalled: false,
        released: false,
        refusedSelf: true,
        fenced,
        error: 'refusing to terminate the backend this statement is running on; '
          + 'terminating the lock holder requires an independent connection',
        waitedMs: elapsed(),
      }
    }
    // The pid holds the key and we asked to fence, but the token could not be
    // read — so whether that backend is OUR session is unknown, and the
    // statement declined to signal. `released: false` with an error: a live
    // backend still holds the key.
    if (fenced && !row.token_readable) {
      return {
        signalled: false,
        released: false,
        refusedSelf: false,
        fenced,
        error: `backend ${backendPid} holds the key but pg_stat_activity did not report its `
          + 'backend_start, so the session could not be identified and no signal was sent',
        waitedMs: elapsed(),
      }
    }
    // Readable and DIFFERENT: that pid was recycled, or somebody else's session
    // took the key. Ours is gone either way, so the key is not ours to return —
    // and nothing was killed, which is the whole point of the fence.
    if (fenced && !row.token_matches) {
      return { signalled: false, released: true, refusedSelf: false, fenced, error: null, waitedMs: elapsed() }
    }
    signalled = row.signalled === true
    // Confirm rather than assume. `pg_terminate_backend` returns true when the
    // SIGNAL was delivered, not when the backend finished dying, and the key is
    // held until it does.
    // Confirmed through the SAME three-valued reader the caller would use, so
    // the two can never disagree about what "still held" means. An `unknown`
    // here does not end the wait: it is the question failing, not an answer,
    // and the loop keeps asking until the ceiling.
    let lastError: string | null = null
    for (;;) {
      const remaining = ceilingMs - elapsed()
      if (remaining <= 0) break
      const check = await checkAdvisoryLockOwnership(runner, key, backendPid, {
        // `remaining`, not `ceilingMs`: handing the FULL ceiling to every poll
        // would let the sequence overshoot the caller's bound by a multiple.
        backendStart,
        ceilingMs: remaining,
      })
      if (check.verdict === 'not-ours') {
        return { signalled, released: true, refusedSelf: false, fenced, error: null, waitedMs: elapsed() }
      }
      lastError = check.error
      // Re-derived rather than a fixed `pollMs`, so the sleep can never push the
      // total past the ceiling the caller asked for.
      await pause(Math.min(pollMs, Math.max(0, ceilingMs - elapsed())))
    }
    return { signalled, released: false, refusedSelf: false, fenced, error: lastError, waitedMs: elapsed() }
  } catch (error) {
    return { signalled, released: false, refusedSelf: false, fenced, error: describe(error), waitedMs: elapsed() }
  }
}

/** The decode in OWNERSHIP_SQL is bit arithmetic on the key, so a value that
 *  cannot survive a JS number round-trip would take one lock and then look for
 *  another — and the heartbeat would report a loss that never happened.
 *
 *  Checked in BOTH exported functions, not only in the acquire path: a caller
 *  that holds a lock some other way and only asks this module the ownership
 *  question would otherwise get Postgres's `invalid input syntax for type
 *  bigint` instead of a message that names what is actually wrong. */
function assertSafeAdvisoryKey(key: number): void {
  if (!Number.isSafeInteger(key)) {
    throw new Error(`session advisory lock key must be a safe integer, got ${String(key)}`)
  }
}

/** How ownership ended, when it ended before `release()` was called. */
export interface SessionAdvisoryLockLoss {
  /** `not-owner`: `pg_locks` no longer attributes the key to this backend.
   *  `heartbeat-failed`: the ownership query itself could not be answered.
   *  `connection-error`: the client emitted `error`; the session is gone. */
  readonly reason: 'not-owner' | 'heartbeat-failed' | 'connection-error'
  readonly detail: string
  /** Milliseconds between acquisition and the observation. Not the moment the
   *  lock was lost — only the moment it was noticed, which is at most one
   *  heartbeat later. Named `observedAfterMs` so no reader mistakes the two. */
  readonly observedAfterMs: number
}

export interface SessionAdvisoryLockRelease {
  /** What `pg_advisory_unlock` returned. `false` means this session did not
   *  hold the lock at release time — never a normal outcome. */
  readonly confirmed: boolean
  /** Set when the heartbeat had already seen ownership end. When this is
   *  non-null, `confirmed: false` is explained rather than mysterious. */
  readonly loss: SessionAdvisoryLockLoss | null
  /** The unlock statement itself failed. Distinct from `confirmed: false`:
   *  one is Postgres answering "no", the other is Postgres not answering. */
  readonly error: string | null
}

export interface SessionAdvisoryLock {
  readonly key: number
  /** The backend holding it. Worth logging: it is what an operator greps for in
   *  `pg_stat_activity` when they want to know who is sitting on the key. */
  readonly backendPid: number
  /** The fencing token for `backendPid` — epoch microseconds of that session's
   *  `backend_start`, as a decimal string. `null` when `pg_stat_activity` would
   *  not say, in which case every later check falls back to the pid alone and
   *  `db.advisory_lock_unfenced` was emitted at acquisition.
   *
   *  Carry it wherever the pid is carried. A pid on its own is a number the OS
   *  reissues, and the two places that consume it — the independent ownership
   *  check and the terminate — both act on the answer destructively. */
  readonly backendStart: string | null
  /** How fast the cluster will reap this session if its client stops answering,
   *  as the kernel actually accepted it rather than as it was requested.
   *
   *  Read by `drillTick`, which both bounds its abandonment grace against
   *  `detectsWithinSeconds` and puts it in the signed report — "the key comes
   *  back on its own in six minutes" and "in two hours" are different facts
   *  about the same abandoned night. */
  readonly keepalives: AdvisoryLockKeepaliveOutcome
  /** Aborted when ownership is observed lost, with the loss as `signal.reason`.
   *  NEVER aborted by `release()` — a caller may use it to cut a job short, and
   *  an ordinary release must not look like an emergency.
   *
   *  An AbortSignal rather than a promise on purpose: a rejected promise nobody
   *  awaited is an unhandled rejection attributed to whatever file happens to be
   *  running, and this one is created on a path that may legitimately ignore it. */
  readonly signal: AbortSignal
  /** Non-null once ownership has been observed lost. */
  loss(): SessionAdvisoryLockLoss | null
  /** Idempotent: repeated calls return the first outcome without re-querying. */
  release(): Promise<SessionAdvisoryLockRelease>
}

export interface SessionAdvisoryLockOptions {
  /** Ownership poll period. `0` disables the heartbeat, which is only correct
   *  when the caller is proving that holding the client is by itself sufficient
   *  — a heartbeat generates traffic, and traffic on the connection is exactly
   *  the confound in that measurement. Default 15 000 ms. */
  readonly heartbeatMs?: number
  /** How fast the CLUSTER should reap this session when its client stops
   *  answering. `DEFAULT_KEEPALIVES` unless given; `null` leaves the cluster's
   *  own settings alone, which is what a caller wants when it is MEASURING the
   *  unset behaviour — the same reason `heartbeatMs: 0` exists. */
  readonly keepalives?: AdvisoryLockKeepalives | null
  /** Structured log sink, same `(event, fields)` shape the schedulers use. */
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void
}

/** Exported because `drillTick`'s independent exclusion watch continues this
 *  heartbeat on a second connection and derives its default from this
 *  constant, so the two cannot drift. */
export const DEFAULT_HEARTBEAT_MS = 15_000

/** The three Postgres GUCs of the same names, in seconds (`count` is a count). */
export interface AdvisoryLockKeepalives {
  readonly idleSeconds: number
  readonly intervalSeconds: number
  readonly count: number
}

/**
 * Make the CLUSTER notice a dead client, so the key comes back without anyone
 * having to ask for it.
 *
 * This covers the failure every other mechanism in this file is a compensation
 * for: the holder's flow is black-holed — a firewall state-table eviction, a
 * NAT rebind — so no FIN and no RST ever arrive. The backend sits idle holding
 * the key, and the kernel waits `tcp_keepalive_time`, **7 200 s on Linux**,
 * before it sends the first probe.
 *
 * What makes these worth setting HERE rather than in a config file is that
 * their `pg_settings.context` is **`user`**: a session may set them on ITSELF,
 * with no superuser and no `postgresql.conf`, so a managed cluster nobody can
 * reconfigure is covered too. Measured against `postgres:16-alpine` (the pinned
 * image), reading the kernel's own per-socket timer out of `/proc/net/tcp` in
 * the server's namespace:
 *
 * ```
 *   nothing set (the control)          keepalive timer fires in 7 198.31 s
 *   tcp_keepalives_idle = 60           keepalive timer fires in    58.33 s
 *   ...set by a NON-superuser role     keepalive timer fires in    58.34 s
 * ```
 *
 * All three GUCs have show hooks that call `getsockopt`, and `set_config`
 * returns the same value `SHOW` does, so `set_config`'s answer is the
 * effective kernel value.
 *
 * End to end, with the black hole made by deleting the peer's veth
 * (`docker network disconnect`) so its packets simply stop. A proxy that stops
 * FORWARDING is not a black hole and cannot be used here: its kernel still ACKs
 * at the TCP layer, so every keepalive probe is answered and nothing is ever
 * torn down.
 *
 * ```
 *   idle holder, nothing set (control)               still held at 40 000 ms
 *   idle holder, idle=1 intvl=1 count=2              RELEASED after  3 162 ms
 *   BUSY holder (inside pg_sleep), same settings     still held at 40 000 ms
 *   BUSY holder, + client_connection_check_interval  RELEASED after  3 933 ms
 * ```
 *
 * Rows three and four are the caveat, and they are why this module does NOT
 * also set `client_connection_check_interval`: TCP keepalives kill the SOCKET,
 * but a backend inside a query never looks at its socket, so it keeps the key
 * until that query ends. A holder here is idle between heartbeats — row two —
 * so keepalives are sufficient. A caller that holds this lock across a long
 * server-side statement is in row three and needs the other setting too. (Row
 * four is a RIDER on row two, not an alternative to it: `POLLRDHUP` detects a
 * CLOSED socket, and what closes it is the keepalive.)
 *
 * ## Why 60 / 30 / 10 (a 360 s window) and not something shorter
 *
 *  - **`count × intervalSeconds` is how long a network brownout costs the
 *    night's backup.** At 60 s, a BGP reconvergence or a firewall failover
 *    kills the backend, frees the key, and stops a six-hour drill that would
 *    otherwise have finished — a REGRESSION against the unset behaviour, which
 *    survived it. At 300 s the outage has to be sustained.
 *  - **`drillTick` deliberately holds the key through its abandonment grace**
 *    so the delay opens no window a rival can dump inside. `graceMs` (300 000)
 *    + `watchMs` (15 000) + the confirm ceiling (5 000) is 320 s, so a belt
 *    that fires at 120 s yanks the key out from under that guarantee. 360 s
 *    clears it. `drillTick` asserts the relation rather than trusting this
 *    paragraph.
 *
 * What that does NOT fix, and no value of these constants can: where the black
 * hole is itself what stops the drill, the drill only learns the key is gone
 * BECAUSE it is gone, so `watchMs + graceMs` of overlap is inherent. Raising
 * the belt moves that window later; it does not shrink it. The remedy for that
 * one is a file lock on the bundle root, which is a separate residual.
 *
 * Cost on a genuinely dead host: the fleet waits 6 minutes instead of 2 —
 * against 120 minutes with no belt at all.
 *
 * `idleSeconds` is at least four heartbeats, so a healthy link never arms the
 * timer at all: every heartbeat resets the server's idle timer. That relation
 * is asserted in `sessionAdvisoryLock.test.ts` rather than restated here,
 * because a comment cannot notice an edit to either constant.
 */
export const DEFAULT_KEEPALIVES: AdvisoryLockKeepalives = Object.freeze({
  idleSeconds: 60,
  intervalSeconds: 30,
  count: 10,
})

/** What was asked for, and what the KERNEL actually took. */
export interface AdvisoryLockKeepaliveOutcome {
  /** `null` when the caller passed `keepalives: null` — the cluster's own
   *  settings are left alone and nothing below is claimed. */
  readonly requested: AdvisoryLockKeepalives | null
  /** What `set_config` returned, which IS the effective value — `0` on a
   *  Unix-socket session, and the PREVIOUS value when `setsockopt` refused. */
  readonly effective: AdvisoryLockKeepalives | null
  /** Whether the peer is reachable over TCP at all. A Unix-socket session
   *  (`pg_stat_activity.client_port = -1`, measured) reports `0` for all three
   *  and cannot apply them — and does not need to, because a local peer's death
   *  arrives as EOF immediately. Carried so the alarm below can stay silent
   *  there instead of firing on every acquire of an ordinary local deployment. */
  readonly transport: 'tcp' | 'local'
  /** `idleSeconds + count × intervalSeconds` of `effective`.
   *
   *  NOT the worst case, and the distinction is load-bearing: Linux's
   *  `tcp_keepalive_timer` declines to probe while the socket has unacknowledged
   *  data, handing the connection to retransmission and `tcp_retries2` (~15 min)
   *  instead. So this is the window when the peer goes silent while the socket
   *  is IDLE, which is the case this lock is in between heartbeats. Stated from
   *  the kernel source, not measured.
   *
   *  `null` when nothing was requested, and `null` when what came back is not
   *  what was asked for, so a reader can never mistake an inert belt for a fast
   *  one. */
  readonly detectsWithinSeconds: number | null
}

/** Measured on `postgres:16-alpine` by binary search, one GUC per session: the
 *  highest value that STICKS. Above these Postgres accepts the statement,
 *  `setsockopt` refuses, and `set_config` returns the PREVIOUS value — no error
 *  anywhere. Above int4 it does raise. These are Linux's `MAX_TCP_KEEP*`; they
 *  are not reported by `pg_settings`, whose `max_val` is 2147483647 for all
 *  three. */
const KEEPALIVE_CEILINGS: AdvisoryLockKeepalives = Object.freeze({
  idleSeconds: 32_767,
  intervalSeconds: 32_767,
  count: 127,
})

function assertKeepalives(keepalives: AdvisoryLockKeepalives): void {
  // Over the REQUIRED keys, never over the keys supplied: iterating the
  // supplied keys passes `{}` vacuously, which binds the missing parameter to
  // NULL, and `set_config(name, NULL, false)` is a RESET.
  for (const name of ['idleSeconds', 'intervalSeconds', 'count'] as const) {
    const value: unknown = keepalives[name]
    // Zero is not "off" here, it is Postgres for "use the system default" — a
    // caller that meant to disable this and passed zeros would get a belt armed
    // at 7 200 s with `effective` agreeing with `requested`. `null` disables.
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(
        `keepalives.${name} must be a positive integer, got ${String(value)}; pass `
        + 'keepalives: null to leave the cluster settings alone',
      )
    }
    // Bounded HERE so the throw lands before a client is checked out. Postgres
    // takes the lock and then raises on the out-of-int4 case, which recovers
    // only because the client is destroyed — correct, but it is a lock taken
    // and thrown away for a value that could have been rejected for free.
    if (value > KEEPALIVE_CEILINGS[name]) {
      throw new Error(
        `keepalives.${name} must not exceed ${KEEPALIVE_CEILINGS[name]}, got ${value}; above that `
        + 'the kernel silently refuses it and Postgres reports the previous value',
      )
    }
  }
}

interface AcquireRow {
  locked: boolean
  pid: number
  token: string | null
  /** `-1` for a Unix-socket session; a real port otherwise. Measured. */
  client_port: number | null
  ka_idle?: number
  ka_interval?: number
  ka_count?: number
}

const ACQUIRE_SQL = `SELECT pg_try_advisory_lock($1) AS locked,
       pg_backend_pid() AS pid,
       ${BACKEND_START_TOKEN} AS token,
       (SELECT client_port FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS client_port`

/** `::int` because `set_config` returns TEXT and the rest of this module treats
 *  a non-number as "the column was not asked for". Without the cast every
 *  acquire would report the belt inert — loud rather than silent, but wrong.
 *  Only the INTEGRATION suite can see that: a fake builds its row in JS and
 *  hands back numbers whatever the SQL says.
 *
 *  `::text` on the parameters is documentation only: node-postgres sends them
 *  untyped, so `$n` resolves to `text` from `set_config(text, text, bool)`
 *  anyway. */
const KEEPALIVE_COLUMNS = `,
       set_config('tcp_keepalives_idle', $2::text, false)::int AS ka_idle,
       set_config('tcp_keepalives_interval', $3::text, false)::int AS ka_interval,
       set_config('tcp_keepalives_count', $4::text, false)::int AS ka_count`

function keepaliveOutcome(
  requested: AdvisoryLockKeepalives | null,
  row: AcquireRow,
): AdvisoryLockKeepaliveOutcome {
  // `=== -1` and nothing else: `pg_stat_activity` always has a row for the
  // asking backend and reports `-1`, never NULL, for a Unix-socket client.
  const transport = row.client_port === -1 ? 'local' : 'tcp'
  // Runtime-equivalent to falling through (with `keepalives: null` there are
  // no `ka_*` columns); kept so `requested` is non-null for the type checker.
  if (requested === null) {
    return { requested: null, effective: null, transport, detectsWithinSeconds: null }
  }
  const effective = typeof row.ka_idle === 'number'
    && typeof row.ka_interval === 'number'
    && typeof row.ka_count === 'number'
    ? { idleSeconds: row.ka_idle, intervalSeconds: row.ka_interval, count: row.ka_count }
    : null
  // EQUALITY with what was asked, not "all three are positive": when
  // `setsockopt` refuses a value (e.g. count above Linux's MAX_TCP_KEEPCNT of
  // 127) Postgres returns the PREVIOUS value, which is still positive.
  const landed = effective !== null
    && effective.idleSeconds === requested.idleSeconds
    && effective.intervalSeconds === requested.intervalSeconds
    && effective.count === requested.count
  return {
    requested,
    effective,
    transport,
    // A belt that did not land must not report a window: this is the number a
    // report prints and an operator plans around.
    detectsWithinSeconds: landed
      ? effective.idleSeconds + effective.count * effective.intervalSeconds
      : null,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Take `key` on a connection held for the caller's whole job.
 *
 * Resolves `null` when another session holds it — the ordinary "somebody else is
 * already doing this" answer, not a failure. Rejects only when Postgres could
 * not be reached or could not answer, which is a different thing and the caller
 * should not conflate them.
 *
 * The pool must not be shared with the job being protected: this checks a client
 * out and keeps it, so a pool sized for one would make the job wait for a client
 * that is never coming back. `drillScheduler` gives the lock a pool of its own.
 */
export async function acquireSessionAdvisoryLock(
  pool: Pool,
  key: number,
  options: SessionAdvisoryLockOptions = {},
): Promise<SessionAdvisoryLock | null> {
  assertSafeAdvisoryKey(key)
  // A log sink may not decide whether a lock is held. `onEvent` is
  // caller-supplied and is called on the path between "the lock is taken" and
  // "the caller has a handle that can release it" — a throw there would leak the
  // client AND leave the key held with nothing able to give it back.
  const emit = (event: string, fields: Record<string, unknown>): void => {
    try {
      options.onEvent?.(event, fields)
    } catch {
      // Nothing to escalate to: the only channel is the one that just failed.
    }
  }
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  // `?? DEFAULT` would turn an explicit `null` into the default and quietly
  // remove the only way to ask for the cluster's own settings.
  const keepalives = options.keepalives === undefined ? DEFAULT_KEEPALIVES : options.keepalives
  if (keepalives !== null) assertKeepalives(keepalives)

  const checkout = await checkOut(pool)
  try {
    // ONE round trip, for correctness rather than speed. Taking the lock and
    // reading the pid in two statements leaves a window where the lock is held
    // but no handle exists; a connection dying there would leak the client
    // forever, and a leaked checked-out client makes `pool.end()` never
    // resolve, wedging the scheduler's `finally`. One statement deletes the
    // window rather than guarding it.
    //
    // The keepalive columns ride the SAME statement: `set_config` RETURNS the
    // effective value (`0` on a Unix-socket session), so the call that sets it
    // is also the evidence that it landed.
    const { rows } = await checkout.client.query<AcquireRow>(
      keepalives === null ? ACQUIRE_SQL : ACQUIRE_SQL + KEEPALIVE_COLUMNS,
      keepalives === null
        ? [key]
        : [key, keepalives.idleSeconds, keepalives.intervalSeconds, keepalives.count],
    )
    if (rows[0]?.locked !== true) {
      // The settings above have already been applied to a client that is going
      // straight back to the pool. Acceptable: `drillScheduler` builds the lock
      // pool per tick and ends it, and this module already requires a direct
      // connection or session pooling (a session advisory lock cannot survive
      // transaction pooling), where a tighter keepalive only tears down a
      // client that is genuinely unreachable.
      checkout.giveBack()
      return null
    }
    const backendPid = Number(rows[0].pid)
    if (!Number.isInteger(backendPid) || backendPid <= 0) {
      // A pid nobody can look up is not a pid. Defaulting to 0 would put a
      // backend that cannot exist into `db.advisory_lock_acquired` and send an
      // operator grepping `pg_stat_activity` for it during an incident.
      throw new Error(`pg_backend_pid() answered ${String(rows[0].pid)}`)
    }
    // A MISSING token is tolerated where a missing pid is not, and the
    // asymmetry is deliberate. The pid is what every later statement is built
    // on; the token only makes those statements stricter. A deployment whose
    // `pg_stat_activity` hides `backend_start` would otherwise be unable to
    // take the lock at all. Degrade to pid-only, and log it.
    const backendStart = typeof rows[0].token === 'string' ? rows[0].token : null
    if (backendStart === null) {
      emit('db.advisory_lock_unfenced', {
        key,
        backendPid,
        detail: 'pg_stat_activity did not report backend_start for this session, so the lock is '
          + 'identified by pid alone; a recycled pid could match it',
      })
    }
    const keepaliveResult = keepaliveOutcome(keepalives, rows[0])
    // `transport === 'local'` is EXCLUDED: a Unix socket returns 0 for all
    // three but cannot be black-holed (a local peer's death arrives as EOF
    // immediately), so alarming there would fire on every ordinary local acquire.
    if (keepalives !== null
      && keepaliveResult.transport === 'tcp'
      && keepaliveResult.detectsWithinSeconds === null) {
      emit('db.advisory_lock_keepalives_inert', {
        key,
        backendPid,
        requested: keepalives,
        effective: keepaliveResult.effective,
        // No consequence asserted: the actual window depends on which values
        // landed, so the log reports both sets and lets the reader compute it.
        detail: 'the cluster returned different TCP keepalive settings from the ones requested, '
          + 'so the window before a silent client loses this key is the effective values above '
          + 'and not the requested ones',
      })
    }
    return start(checkout, key, backendPid, backendStart, keepaliveResult, heartbeatMs, emit)
  } catch (error) {
    // Whether the lock was taken went with the connection, so DESTROY the
    // client instead of returning it: ending the session is the only way to
    // release a lock that no handle will ever exist to release.
    checkout.giveBack(error instanceof Error ? error : new Error(describe(error)))
    throw error
  }
}

/** The client, plus the two operations whose ORDER around it is load-bearing.
 *
 * `pg-pool` removes its own idle `'error'` listener at checkout and only
 * reinstalls it inside `release()`, on the pinned version:
 *
 * ```
 *   just after pool.connect() ........ 0 error listeners
 *   during our queries ............... 0
 *   after client.release() ........... 1  (pg-pool's, back again)
 * ```
 *
 * and `Client._handleErrorEvent` calls `this.emit('error', err)`
 * unconditionally. A socket reset while the client is ours is therefore
 * `ERR_UNHANDLED_ERROR` — a synchronous throw outside every `await`, which no
 * `try/catch` on the query can see, killing the drill container: a standalone
 * entrypoint with no `uncaughtException` handler. So the listener goes on
 * BEFORE the first statement and comes off only AFTER `client.release()`.
 */
interface Checkout {
  readonly client: PoolClient
  /** Idempotent. Pass the error that broke the session to have the pool DESTROY
   *  the client rather than hand it to the next borrower. */
  readonly giveBack: (broken?: Error) => void
  /** Route the client's `'error'` event to the handle, once one exists. */
  readonly routeErrors: (handler: (error: Error) => void) => void
}

async function checkOut(pool: Pool): Promise<Checkout> {
  const client: PoolClient = await pool.connect()
  // Until `start` routes them, an error here is absorbed on purpose: the
  // in-flight statement is about to reject with the same cause, and that
  // rejection is the one carrying a message worth reporting.
  let sink: (error: Error) => void = () => {}
  const onError = (error: Error): void => { sink(error) }
  client.on('error', onError)
  return {
    client,
    // NOT idempotent, on purpose: nothing here calls it twice, and pg-pool's
    // `Release called on client which has already been released` is a loud
    // detector for a future ordering mistake that a guard would swallow.
    giveBack: (broken?: Error): void => {
      client.release(broken)
      // AFTER, never before: `release()` reinstalls pg-pool's listener as its
      // first act, so removing ours here can never leave the client at zero.
      client.off('error', onError)
    },
    routeErrors: (handler: (error: Error) => void): void => { sink = handler },
  }
}

/** Consecutive unanswered ownership probes before the lock is declared lost.
 *
 * Not ONE: a probe that could not be answered — a statement timeout, a
 * cancelled query, a load spike — is not evidence that anybody else took the
 * key, and declaring a loss on every hiccup would make the alarm useless.
 *
 * A NEGATIVE answer is different and is acted on immediately: `pg_locks` was
 * asked and said no. Only the unanswered case is tolerated, and only twice. */
const UNANSWERED_PROBES_BEFORE_LOSS = 2

/** Ceiling on the unlock statement. Generous — an unlock that is merely slow
 *  should not be reported as failed — but finite, because the alternative is
 *  `tcp_retries2`.
 *
 *  EXPORTED so the second module that issues `pg_advisory_unlock` on a pooled
 *  client — `readModel/overlayRotationLock.ts` — derives its ceiling from this
 *  one instead of restating the number. */
export const ADVISORY_LOCK_RELEASE_CEILING_MS = 30_000
const RELEASE_CEILING_MS = ADVISORY_LOCK_RELEASE_CEILING_MS

/** Race a promise against a wall clock without letting the loser become an
 *  unhandled rejection.
 *
 *  A `Promise.race` rather than an `AbortSignal`, on purpose: a signal only
 *  bounds a callee that cooperates, and `pg`'s `query` does not take one. The
 *  race holds regardless of the callee — at the cost of not CANCELLING the
 *  work, which is why every caller here hands the client back broken instead of
 *  reusing it.
 *
 *  EXPORTED rather than copied. `readModel/overlayRotationLock.ts` needs the
 *  identical clock around the identical statement. The `work.catch` below is
 *  what keeps the loser from becoming an unhandled rejection. */
export async function withCeiling<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  work.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The ownership question, with a wall-clock ceiling.
 *
 * Without one, the heartbeat's claimed 15-second detection is fiction on the
 * failure it exists for. A connection black-holed by a stateful firewall
 * produces neither error nor answer: the kernel retransmits until
 * `tcp_retries2`, roughly FIFTEEN MINUTES on Linux by default. The probe would
 * simply never come back, `markLost` would never run, and the key could have
 * been taken over throughout. */
async function probeOwnership(
  client: PoolClient,
  key: number,
  ceilingMs: number,
): Promise<boolean> {
  return withCeiling(
    advisoryLockHeldByThisSession(client, key),
    ceilingMs,
    `ownership query unanswered after ${ceilingMs} ms`,
  )
}

function start(
  checkout: Checkout,
  key: number,
  backendPid: number,
  backendStart: string | null,
  keepalives: AdvisoryLockKeepaliveOutcome,
  heartbeatMs: number,
  emit: (event: string, fields: Record<string, unknown>) => void,
): SessionAdvisoryLock {
  const { client, giveBack, routeErrors } = checkout
  const acquiredAt = Date.now()
  const controller = new AbortController()
  let loss: SessionAdvisoryLockLoss | null = null
  let released: Promise<SessionAdvisoryLockRelease> | null = null
  let timer: ReturnType<typeof setInterval> | undefined

  emit('db.advisory_lock_acquired', {
    key,
    backendPid,
    backendStart,
    heartbeatMs,
    keepaliveDetectsWithinSeconds: keepalives.detectsWithinSeconds,
  })

  const markLost = (reason: SessionAdvisoryLockLoss['reason'], detail: string): void => {
    // Two guards, two different mistakes. `released` covers a heartbeat already
    // in flight when release() runs, which would otherwise report a takeover
    // that was our own unlock. `loss` keeps the FIRST observation: a later one
    // would overwrite the reason and the timing with a downstream symptom —
    // the socket dying a second after `pg_locks` already said somebody else
    // owns the key — and emit `db.advisory_lock_lost` twice for one loss.
    if (loss !== null || released !== null) return
    loss = { reason, detail, observedAfterMs: Date.now() - acquiredAt }
    if (timer) clearInterval(timer)
    emit('db.advisory_lock_lost', { key, backendPid, ...loss })
    controller.abort(new Error(`advisory lock ${key} lost: ${reason}: ${detail}`))
  }

  routeErrors((error: Error) => markLost('connection-error', describe(error)))

  if (heartbeatMs > 0) {
    let unanswered = 0
    timer = setInterval(() => {
      if (released !== null || loss !== null) return
      void probeOwnership(client, key, heartbeatMs).then(
        (held) => {
          unanswered = 0
          if (!held) markLost('not-owner', 'pg_locks no longer attributes this key to this backend')
        },
        (error: unknown) => {
          unanswered += 1
          if (unanswered >= UNANSWERED_PROBES_BEFORE_LOSS) {
            markLost('heartbeat-failed', `${describe(error)} (${unanswered} consecutive unanswered probes)`)
          }
        },
      )
    }, heartbeatMs)
    // Not a liveness claim: the checked-out client's own socket keeps the loop
    // alive for the lock's whole life, so this changes nothing about when the
    // process may exit. It is here so a forgotten handle in a test cannot hold
    // a worker open past its assertions.
    timer.unref?.()
  }

  const runRelease = async (): Promise<SessionAdvisoryLockRelease> => {
    if (timer) clearInterval(timer)
    // The `'error'` listener deliberately STAYS attached across the unlock
    // statement (see `Checkout`). `markLost` is already inert by now (`released` is set), so
    // an error absorbed here cannot invent a loss.
    let confirmed = false
    let error: string | null = null
    let broken: Error | undefined
    try {
      // Under a ceiling, for the reason `probeOwnership` gives: a black-holed
      // socket answers nothing for `tcp_retries2`, ~15 minutes on Linux. The
      // ceiling does not make the unlock succeed; it makes the failure a
      // reported `error`, and hands the client back BROKEN so the session dies
      // and Postgres releases the lock itself.
      const { rows } = await withCeiling(
        client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock($1) AS unlocked', [key]),
        RELEASE_CEILING_MS,
        `pg_advisory_unlock did not answer within ${RELEASE_CEILING_MS} ms`,
      )
      confirmed = rows[0]?.unlocked === true
    } catch (caught) {
      error = describe(caught)
      // Hand the error to the pool so a client whose session is gone is
      // DESTROYED rather than returned for the next borrower to inherit.
      broken = caught instanceof Error ? caught : new Error(error)
    }
    giveBack(broken)
    const outcome: SessionAdvisoryLockRelease = { confirmed, loss, error }
    emit('db.advisory_lock_released', { key, backendPid, ...outcome, heldMs: Date.now() - acquiredAt })
    return outcome
  }

  return {
    key,
    backendPid,
    backendStart,
    keepalives,
    signal: controller.signal,
    loss: () => loss,
    release: () => {
      released ??= runRelease()
      return released
    },
  }
}
