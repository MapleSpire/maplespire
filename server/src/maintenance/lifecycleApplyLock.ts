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
 * THE WORKSPACE LIFECYCLE APPLY LOCK — one key, five doors ON IT.
 *
 * "Five doors on it", not "five doors exist": this is not a closed
 * enumeration of every writer.
 *
 *  1–3. promote / demote / repair-summary-flag, in `promoteSummaryWorkspace.ts`.
 *  4. `repairReferenceIntegrity`, which deletes registry entries, strips ids
 *     from every diagram and drops layout keys.
 *  5. `repairDegenerateRoots` (`degenerateRootRepair.ts`), which publishes a
 *     fresh root and compare-and-swaps `versions.root_url` — the ONLY writer of
 *     that column, and the witness the fourth door samples and re-reads. It is
 *     reached from an ORDINARY request through `ensureHealthyWorkspaceRoot`
 *     (`workspaceRootGuard.ts`), but the hot path is
 *     `isStructurallyHealthyRoot`, which returns before it on every healthy
 *     workspace; the lock wraps the rare rotation only.
 *
 * WHETHER A SIXTH EXISTS IS NOT KNOWN. `lifecycleApplyLockCallers.test.ts`
 * bounds who may take the key unsafely; nothing enumerates who WRITES this
 * workspace's state without it.
 *
 * WHY THE KEY IS SHARED AND NOT PER-DOOR. Two locks that cannot see each other
 * are strictly worse than one missing lock: each door would report success
 * while excluding only its own kind, which reads as mutual exclusion in the log
 * and is not. The class value and the key TEXT below are therefore the wire
 * format of an exclusion between PROCESSES, not an implementation detail — see
 * the block comment on `LIFECYCLE_LOCK_CLASS`.
 *
 * WHAT CALLERS MUST NOT DO, and it is the reason `withLifecycleApplyLock`
 * exists. `acquireLifecycleApplyLock` hands back a POOLED CLIENT that holds a
 * SESSION-scoped advisory lock, and a bare `client.release()` on it does NOT
 * drop the lock — measured, both directions, in the table on
 * `releaseLifecycleApplyLock`. A caller that writes its own `try/finally` and
 * reaches for `client.release()` reintroduces the exact leak that table
 * documents. New callers take the wrapper, which cannot be called wrong.
 *
 * The three summary doors still call the primitives directly. That is safe
 * because the wrapper carries no witness the primitives lack: the exit witness
 * is `releaseLifecycleApplyLock`'s own return value, which every door receives.
 * If the wrapper ever grows a check the primitives lack, this paragraph
 * expires with it.
 *
 * The exposure is a NEW caller writing its own `try/finally`, and that is
 * enforced by a test, not a paragraph: `lifecycleApplyLockCallers.test.ts`
 * fails when any file outside `promoteSummaryWorkspace.ts` imports the raw
 * primitives, and the three doors stay covered by a direct `pg_locks` witness
 * with a control that sees the key held
 * (`promoteSummaryWorkspace.integration.test.ts`, "every door RELEASES the lock").
 *
 * SCOPE. The general rule for code that BORROWS a pooled connection is
 * "transaction lock, never session lock". This lock is session-scoped but does
 * not borrow-and-return around the critical section: it PINS a dedicated
 * connection for the whole apply path and destroys it rather than return it
 * whenever the unlock cannot be proven. The pinning is what makes a session
 * lock defensible here, even though most doors are HTTP handlers.
 *
 * CAVEAT:
 *  - Behind a TRANSACTION-MODE POOLER the pinning is not a mechanism: pinning a
 *    node-postgres client pins it to the POOLER, and destroying that client
 *    does not end the server backend holding the session lock. The shipped
 *    deployment runs none; if one is introduced, this lock stops meaning what
 *    it says (the release detects it — see `acquiredOnBackend`).
 */

import type { Pool, PoolClient } from 'pg'
import type { WorkspaceKey } from '../readModel/projector.js'

// ── the LIFECYCLE apply lock ────────────────────────────────────────────────
// A fixed namespace for `pg_advisory_lock(classid, objid)` so this lock can
// never collide with another subsystem's advisory lock on the same objid. The
// objid is a 32-bit hash of the workspace key computed HERE rather than by
// Postgres' `hashtext`: hashtext is an internal function with no compatibility
// promise, and a lock key that changes with a server version is a lock that
// silently stops excluding anything.
//
// Every door takes it because a promotion and a demotion must not interleave.
// The window is not narrow: the promotion commits the static row at step 3 and only flips the
// root at step 6, ≥ BASELINE_FENCE_ARMING_BOUND_MS (15 000 ms) later, and in
// between `evaluateDemotionPreconditions` admits a demotion — `not-summary`
// needs a NULL source and the source is set; `not-promoted` needs a DIFFERENT
// source and it is exactly PROMOTED_STATIC_SOURCE. The demotion would then
// delete the static row and the whole allow-list, the promotion flip the root
// anyway, and the workspace end as a summary-only root with no static row: the
// `data-loss` finding at workspaceFsck.ts's `summary-static-coherence`.
//
// The KEY TEXT (still `promote-summary:…`) and the CLASS VALUE below must never
// change. Both are the wire format of an exclusion: edit either and a door running the
// old build stops excluding a door running the new one, silently, which is the
// one failure this lock exists to prevent.
export const LIFECYCLE_LOCK_CLASS = 0x5359

export function lifecycleLockKey(key: WorkspaceKey): number {
  const text = `promote-summary:${key.landscapeId}:${key.versionId}`
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  // `| 0` — pg_advisory_lock takes a SIGNED int4; an unsigned value overflows
  // the parameter and Postgres rejects it.
  return hash | 0
}

/**
 * Take the workspace's apply lock, or return `null` when someone else holds it.
 *
 * A DEDICATED connection, held for the whole apply path: a session-level
 * advisory lock belongs to the session that took it, so taking it on a pooled
 * client that is then released would hand the lock to whatever query borrows
 * that connection next (and leak it forever if nothing does).
 *
 * `pg_try_advisory_lock`, never `pg_advisory_lock`: the blocking form has no
 * timeout and would park an HTTP request behind a neighbour's 33 s of registry
 * materialisation, which is a hang the caller cannot distinguish from a wedged
 * pool. Refusing with a named blocker is the honest answer.
 */
/**
 * Which server backend each pinned client took its key on.
 *
 * THIS IS THE TRANSACTION-POOLER DETECTOR for the caveat in this file's header:
 * behind a transaction-mode pooler, pinning a node-postgres client pins it to
 * the POOLER, so "the session that took the lock" and "the session running the
 * next statement" are different backends, and destroying the client does not
 * end the one holding the key.
 *
 * `pg_backend_pid()` answers it directly: recorded at acquire, compared at
 * release. Under a session-mode pool the two are equal by construction; under a
 * transaction pooler they drift, and the drift IS the defect — reported rather
 * than inferred from a deployment diagram.
 *
 * A `WeakMap` so a client that is destroyed rather than returned takes its
 * entry with it: nothing here can pin a connection alive.
 */
const acquiredOnBackend = new WeakMap<PoolClient, number>()

/**
 * `db` IS THE POOL THE PINNED CLIENT COMES FROM, a choice callers must make.
 *
 * The client returned here is pinned for the whole apply — tens of seconds at
 * worst — and it is a pure exclusion token for the three summary doors: they
 * never run a statement on it, only `releaseLifecycleApplyLock`. Passing the
 * general-purpose pool would spend general-purpose connections on it;
 * production passes `lifecycleApplyPool` (see `dbConfig.ts`'s
 * `lifecycleApplyDatabasePoolConfig`).
 *
 * Advisory locks are DATABASE-scoped, not schema-scoped, so a token taken on a
 * different pool of the same database excludes exactly as before. That is what
 * makes this safe for the three doors. `withLifecycleApplyLock`'s callers DO run
 * statements on the session, so for them the pool must also carry the caller's
 * schema — which is why the choice is threaded from the caller instead of being
 * hardcoded here, and why every test keeps its injected pool by default.
 */
export async function acquireLifecycleApplyLock(db: Pool, key: WorkspaceKey): Promise<PoolClient | null> {
  // `db.connect()` OWNS ITS OWN REFUSAL. A pool timeout here is a transient
  // "come back later" exactly like a refused lock, so it must reach the 503
  // contract this module establishes rather than leave as a plain `Error` (an
  // opaque 500).
  //
  // Nothing is written and nothing is held: the throw happens before any query,
  // so there is no client to release and no lock to give back.
  let client: PoolClient
  try {
    client = await db.connect()
  } catch (error) {
    throw new LifecycleApplyRefusedError(
      'pool-exhausted',
      // THE MESSAGE IS NOT THE `pg` ERROR, and that is deliberate. This one is
      // passed through to an HTTP client by `routeErrors`, and a connect failure
      // carries the host, the port and the role in its text — a DNS or auth
      // failure would publish the connection string's shape to whoever asked.
      // The cause keeps the detail for the server log, where it belongs.
      `could not borrow a connection to take the apply lock for ${key.landscapeId}/${key.versionId}. `
      + 'NOTHING was written — the lock was never asked for. This is the connection pool being '
      + 'saturated or unreachable, not a neighbour holding the key.',
      { cause: error },
    )
  }
  try {
    const { rows } = await client.query<{ locked: boolean; pid: number }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked, pg_backend_pid() AS pid',
      [LIFECYCLE_LOCK_CLASS, lifecycleLockKey(key)],
    )
    if (rows[0]?.locked === true) {
      // THE BACKEND THAT NOW HOLDS THE KEY. Recorded so the release can prove
      // it is talking to the SAME one — see `acquiredOnBackend`.
      acquiredOnBackend.set(client, rows[0].pid)
      return client
    }
  } catch (error) {
    // WITH the error, not bare: a throw here does not mean the server refused
    // the lock, only that this process did not learn the answer. If it was
    // granted and the reply was lost, a bare release hands a lock-holding
    // connection back to the pool. Destroying it ends the session, which is the
    // only thing that returns an advisory lock we no longer have a handle on.
    client.release(error instanceof Error ? error : true)
    throw error
  }
  // Bare on purpose: `locked === false` is a definite answer from the server
  // that nothing was taken, so the connection is clean.
  client.release()
  return null
}

/**
 * Give the lock back — and if that cannot be proven, DESTROY the connection.
 *
 * A plain `client.release()` does NOT drop the session or the lock: in pg-pool
 * 3.x, `_release(client, listener, err)` removes the client only when `err` is
 * truthy — otherwise it re-arms the idle listener and returns the SAME backend
 * to the pool. Measured, controls both ways:
 *
 *   | arm                          | key held before → after |
 *   |------------------------------|-------------------------|
 *   | `release()` bare             | 1 → **1**               |
 *   | CONTROL `release(err)`        | 1 → 0                   |
 *
 * and a fresh borrow of that leaked connection then took the same key with
 * `pg_try_advisory_lock` → **true**, because an advisory lock is COUNTED per
 * session. So a leaked lock fails both directions at once: the next door served
 * by that connection is ADMITTED while another holds the key, and every door on
 * any other connection is refused for as long as the leak lives.
 *
 * The boolean is the detector. `pg_advisory_unlock` returns FALSE when the
 * session did not hold the key — the one direct signal for "this process
 * thinks it released and did not".
 */
export async function releaseLifecycleApplyLock(
  client: PoolClient, key: WorkspaceKey,
): Promise<boolean> {
  let unproven: Error | true | undefined
  try {
    const { rows } = await client.query<{ unlocked: boolean; pid: number }>(
      'SELECT pg_advisory_unlock($1, $2) AS unlocked, pg_backend_pid() AS pid',
      [LIFECYCLE_LOCK_CLASS, lifecycleLockKey(key)],
    )
    const acquiredOn = acquiredOnBackend.get(client)
    const releasedOn = rows[0]?.pid
    // `releasedOn !== undefined` as well as `acquiredOn`: an empty result set
    // would otherwise report `(100 -> undefined)` as a POOLER drift, which is
    // the wrong diagnosis for "the query answered nothing". Missing rows fall
    // through to the unlock check below, which reads them as unproven anyway.
    if (acquiredOn !== undefined && releasedOn !== undefined && releasedOn !== acquiredOn) {
      // THE POOLER CAVEAT, CAUGHT RATHER THAN ASSUMED. The client we pinned is
      // not talking to the backend that took the key, so nothing this module
      // does to the client can reach the session holding it — and the unlock
      // above just ran somewhere else. Destroying the connection ends the wrong
      // session; the key stays held until the real backend goes away.
      unproven = true
      console.error(
        `[lifecycle-lock] the pinned connection moved backends (${acquiredOn} -> ${releasedOn}) `
        + `while holding the apply key for ${key.landscapeId}/${key.versionId}. A session-scoped `
        + 'advisory lock CANNOT be used through a transaction-mode pooler: pinning binds to the '
        + 'pooler, not to the backend. The exclusion this lock reports is not real in this '
        + 'deployment.',
      )
    } else if (rows[0]?.unlocked !== true) {
      unproven = true
      console.warn(
        `[promote-summary] pg_advisory_unlock answered ${String(rows[0]?.unlocked)} for `
        + `${key.landscapeId}/${key.versionId} — this session did not hold the key it thought it held. `
        + 'Destroying the connection so the session ends and anything it does hold is returned.',
      )
    }
  } catch (error) {
    unproven = error instanceof Error ? error : true
    console.warn('[promote-summary] advisory unlock failed; destroying the connection:', error)
  } finally {
    client.release(unproven)
  }
  // THE EXIT WITNESS, AND IT COSTS NOTHING. `pg_advisory_unlock` answering
  // false means this session did not hold the key it was about to give back:
  // "the exclusion evaporated somewhere between taking it and here" — a killed
  // backend, a failover, an `pg_advisory_unlock_all` from inside.
  //
  // Returned rather than only logged so every door — wrapper or primitives —
  // can put it in its report.
  return unproven === undefined
}

/**
 * Granted, with whatever the critical section returned — or refused, with
 * nothing.
 *
 * `exclusionProven` is NOT decoration and it is not `granted` said twice. It is
 * the answer to a question the grant cannot answer: did the exclusion survive
 * the whole critical section? Postgres releases a session's advisory locks the
 * instant the backend dies, so a failover or a `pg_terminate_backend()` mid-apply
 * ends the exclusion with no error, no rollback and no log line — the rest of
 * the apply then writes with nothing holding anyone off, and the only prior
 * signal was `releaseLifecycleApplyLock`'s warning AFTER the last write.
 *
 * False therefore means "these writes happened, and for some part of them this
 * process was not excluding anybody". It is not a retry hint; it is the reason
 * to run `fsck` on that workspace.
 */
export type LifecycleApplyLockOutcome<T> =
  | { granted: true; value: T; exclusionProven: boolean }
  | { granted: false }

declare const lifecycleLockHeld: unique symbol

/**
 * A pooled client that PROVABLY holds this workspace's apply lock.
 *
 * The brand is load-bearing. With a plain `PoolClient`, substituting the POOL
 * for the client still typechecks, and so does hoisting an under-the-lock
 * re-read out of the critical section. With the brand, only
 * `withLifecycleApplyLock` can produce a value of this type, so a re-read that
 * declares it cannot be handed the pool and cannot be moved anywhere the
 * wrapper has not put it.
 *
 * It is a COMPILE-TIME proof of position, not a runtime proof of possession: it
 * says this value came from the wrapper, not that the backend still holds the
 * key. A session killed mid-apply still ends the exclusion silently; see
 * `sessionHoldsLifecycleLock` for the runtime check.
 */
export type LockedSession = PoolClient & { readonly [lifecycleLockHeld]: true }

/**
 * Does THIS BACKEND still hold the workspace's apply key, right now?
 *
 * THE GAP THIS FILLS: the brand is a compile-time proof of POSITION — this
 * value came out of the wrapper — and says nothing about POSSESSION. Two cases
 * fall in that gap: a session killed mid-apply ends the exclusion in silence,
 * and substituting a
 * different connection into an under-the-lock re-read type-checks the moment
 * the parameter is widened, because the reads return the same values either
 * way. Both are answered by asking Postgres rather than the type system.
 *
 * `pid = pg_backend_pid()` IS THE WHOLE POINT and not a redundant filter. A
 * witness without it answers "somebody holds this key", which is TRUE in
 * exactly the two cases this exists to catch — a neighbour that took the key
 * after ours evaporated, and a substituted connection asking about a key its
 * sibling holds. The question is not "is the key held" but "is it held BY THE
 * BACKEND ABOUT TO DO THE WRITING", and only the pid clause asks that one.
 *
 * The casts are load-bearing too: `pg_locks.classid` and `objid` are `oid`
 * (unsigned 32-bit), while `lifecycleLockKey` returns a SIGNED int4 because
 * that is what `pg_advisory_lock` takes. `>>> 0` converts to the unsigned
 * representation Postgres stored, and `::bigint` on both sides keeps the
 * comparison out of oid arithmetic.
 */
export async function sessionHoldsLifecycleLock(
  session: LockedSession,
  key: WorkspaceKey,
): Promise<boolean> {
  const { rows } = await session.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid::bigint = $1::bigint
          AND objid::bigint = $2::bigint
          AND objsubid = 2
          AND pid = pg_backend_pid()
          AND granted
     ) AS held`,
    [LIFECYCLE_LOCK_CLASS, lifecycleLockKey(key) >>> 0],
  )
  return rows[0]?.held === true
}

/**
 * Run `critical` under the workspace's lifecycle apply lock, or report refusal.
 *
 * THE ONLY SHAPE A NEW CALLER SHOULD USE. It exists because the release
 * contract above is not guessable from the primitives' signatures: the client
 * must be released WITH an error on a throw, and DESTROYED whenever
 * `pg_advisory_unlock` does not answer `true`. A hand-written `try/finally`
 * that ends in a bare `client.release()` type-checks and leaks the key — the
 * 1 → 1 row in the table above.
 *
 * AWAIT WALK (every `await` between acquisition and hand-off).
 * There is exactly one statement between `acquire` returning a lock-holding
 * client and the `try` that owns it — `if (!client) return` — and it contains
 * no `await`, so the window in which a throw could strand the client is empty
 * rather than guarded. Inside, `await critical()` is itself in the `try`, so a
 * synchronous throw from `critical` still reaches the `finally`.
 * `releaseLifecycleApplyLock` swallows its own QUERY failure by design (it
 * destroys the connection instead of rethrowing), so an unlock that fails
 * cannot replace the caller's error. The narrower claim is deliberate: its
 * `client.release(unproven)` sits in its own `finally`, OUTSIDE that `try`, and
 * pg-pool throws on a second release of the same client — so a caller that
 * released the client itself would still see that throw clobber the critical
 * section's error. Unreachable today (no door releases it), which is why this
 * is a bound on the claim rather than a guard in the code.
 *
 * REFUSAL IS A RETURN VALUE, NOT A THROW. The three summary doors answer a
 * refusal with a named `blockers[]` entry and a report; `repairReferenceIntegrity`
 * answers with `LifecycleApplyRefusedError`. Both are legitimate, and choosing
 * for them here would force one of the two to translate.
 *
 * WHY `critical` IS HANDED A BRANDED `LockedSession`. A caller's under-the-lock
 * re-read could otherwise be hoisted OUT of the callback — back to just before
 * this call — with every test green, because a seam fired before the lock
 * cannot witness whether the re-read ran inside it; and a plain client could be
 * swapped for the POOL with no type error.
 *
 * The brand closes both. Only this function mints a `LockedSession`, so a
 * re-read that declares one cannot be given the pool and cannot be called
 * outside the callback. See the type's own docstring for what it does NOT
 * prove.
 */
export async function withLifecycleApplyLock<T>(
  db: Pool,
  key: WorkspaceKey,
  critical: (session: LockedSession) => Promise<T>,
): Promise<LifecycleApplyLockOutcome<T>> {
  const client = await acquireLifecycleApplyLock(db, key)
  if (!client) return { granted: false }
  // The ONLY place this cast happens, and the only reason the brand means
  // anything. `client` holds the key on the line above. No `await` between
  // there and the `try` below, so the window in which a throw could strand it
  // is empty rather than guarded.
  const session = client as LockedSession
  let releasedOnce = false
  try {
    const value = await critical(session)
    // THE EXIT WITNESS IS THE UNLOCK'S OWN BOOLEAN, and only that. An extra
    // `sessionHoldsLifecycleLock` call here could never fail on its own: every
    // state it reports (a dead backend, `pg_advisory_unlock_all`, a moved
    // backend) already makes `pg_advisory_unlock` answer false or throw. It
    // also keeps every door on the identical witness, since the doors that call
    // the primitives directly get exactly this boolean. The possession witness
    // earns its place on the ENTRY side, in `assertWorkspaceHeldStill`, where it
    // runs BEFORE the writes and can still refuse.
    //
    // THE FLAG IS SET BEFORE THE AWAIT, not after: set afterwards, a throw from
    // inside the release would leave it false and the `finally` would release
    // the SAME client a second time — which pg-pool throws on, clobbering the
    // original error. Set first, the worst case is one missed release, and
    // there is no such case: `releaseLifecycleApplyLock` releases in its own
    // `finally`. (That case is unreachable today, so no test can pin the order.)
    releasedOnce = true
    const exclusionProven = await releaseLifecycleApplyLock(client, key)
    if (!exclusionProven) {
      console.error(
        `[lifecycle-lock] EXCLUSION NOT PROVEN on ${key.landscapeId}/${key.versionId}: this session `
        + 'could not prove it still held the apply key when its critical section finished. Some '
        + 'part of those writes may have run with nothing excluding the other doors. Run fsck on '
        + 'this workspace — this is not a retry hint.',
      )
    }
    return { granted: true, value, exclusionProven }
  } finally {
    if (!releasedOnce) await releaseLifecycleApplyLock(client, key)
  }
}

export type LifecycleApplyRefusalCode =
  /** Another lifecycle door holds the apply lock right now. */
  | 'lock-unavailable'
  /** The lock was granted, but the workspace moved while the evidence was gathered. */
  | 'workspace-moved'
  /** No connection could be borrowed to take the lock — the pool is saturated. */
  | 'pool-exhausted'
  /** The session about to write could not prove it holds the key. */
  | 'exclusion-unproven'

/**
 * A mutating lifecycle apply that refused to run, and NOTHING was written.
 *
 * Distinct from a plain `Error` so the HTTP layer can answer 503 + `retryable`
 * instead of 500. ALL of these codes describe a transient condition the caller
 * fixes by coming back, not a fault in the request — the same contract a
 * non-owning cell gets, and the same one `DocumentTemporarilyUnavailableError`
 * gets in `route()`.
 *
 * KEEPING THAT TRUE IS A CONSTRAINT ON WHAT MAY JOIN THIS UNION: a
 * non-transient refusal (e.g. an oversized apply) does not belong here. An
 * oversized apply instead takes a bounded slice and reports `truncated`.
 */
export class LifecycleApplyRefusedError extends Error {
  constructor(readonly code: LifecycleApplyRefusalCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LifecycleApplyRefusedError'
  }
}
