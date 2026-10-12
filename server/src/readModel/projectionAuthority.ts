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

import { ReadModelWriteFenceError } from './health.js'
// Not `isStaticReadModelWorkspace`: `assertReadModelPlane` issues its own
// `FOR KEY SHARE` query, while that shared reader stays unlocked for its other
// call sites (routing it through here would put a row lock into every fleet
// attach check). Its `SELECT EXISTS(...)` also always returns exactly one row,
// so there would be nothing for `FOR KEY SHARE` to hold.
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

/**
 * WHICH WRITER a projection transaction belongs to.
 *
 * The `ro_*` row plane has exactly two live writer classes — the ordinary
 * projector (`projectorService.runTracked`) and the static delta projector
 * (`StaticDeltaProjector.publish` / `.transactionOnly`) — and a workspace
 * belongs to exactly one of them at any instant; two writers on one
 * workspace's `ro_*` rows would advance generations independently.
 * `ProjectorFleet.start` refuses an ordinary projector on a static workspace at
 * attach time, but that is not enough on its own: `StaticDeltaProjector.release()`
 * is only called on ownership loss, which is never emitted when
 * `SYNC_CELL_OWNERSHIP` is unset, and `reloadDescriptors` never drops a
 * descriptor whose row disappeared. A demoted workspace can therefore keep a
 * live static projector. Every projection transaction declares its plane so
 * `assertReadModelPlane` can refuse the writer that no longer owns it.
 */
export type ReadModelPlane = 'ordinary' | 'static'

/**
 * This transaction's writer no longer owns the workspace's `ro_*` plane.
 *
 * Deliberately NOT persisted by `failReadModelProjection`, for the same reason
 * `ReadModelWriteFenceError` is not: the health row now describes the OTHER
 * writer, and stamping `consecutive_failures` / `last_error_*` onto it is the
 * same forgery as writing its rows, one table over. It can walk a healthy
 * workspace's ladder to `failed` from outside.
 */
export class ReadModelPlaneError extends Error {
  readonly code = 'read_model_plane_lost'
  constructor(key: WorkspaceKey, readonly plane: ReadModelPlane) {
    super(
      `read-model plane lost for ${key.landscapeId}/${key.versionId}: this is the ` +
        `${plane} projector and the workspace is now ${plane === 'static' ? 'ordinary' : 'static'}`,
    )
    this.name = 'ReadModelPlaneError'
  }
}

/**
 * Did this projection lose its AUTHORITY over the workspace, as opposed to
 * failing at its job?
 *
 * One predicate, so every site in `projectorService.ts` that decides whether
 * to degrade, retry or persist telemetry (`runTracked`, the diagram
 * degradation guard, the retry-budget guard, the fleet's ownership mapping,
 * `onDiagramRetryAbandoned`) agrees on every authority-loss class — never an
 * ad-hoc `instanceof` per site. When adding a site, search for the QUESTION,
 * not for one error class: some losses arrive through
 * `classifyDocumentResolutionError` without naming the class at all.
 *
 * The degradation guard matters most: a sticky degradation published after a
 * lost plane lands on the NEW owner's row, and nothing retracts it (the only
 * `clearReadModelWorkspaceDegraded` call site is inside the ordinary
 * projector, which never attaches to a static workspace).
 *
 * `DiagramFlowProjectionError` wraps the cause rather than replacing it, so the
 * cause is unwrapped here — and {@link isProjectionMutexTimeout} does the same,
 * or the two predicates would disagree at the sites that see a wrapped error.
 */
export function isReadModelAuthorityLoss(error: unknown): boolean {
  if (error instanceof ReadModelWriteFenceError || error instanceof ReadModelPlaneError) return true
  const cause = (error as { cause?: unknown } | null | undefined)?.cause
  return cause instanceof ReadModelWriteFenceError || cause instanceof ReadModelPlaneError
}

/** Postgres `lock_not_available` — what `lock_timeout` raises. */
export const LOCK_NOT_AVAILABLE = '55P03'

/**
 * Did this pass fail because ANOTHER writer holds the projection mutex?
 *
 * Deliberately NOT folded into {@link isReadModelAuthorityLoss}, even though
 * both mean "this failure belongs to somebody else's write, not to this
 * workspace's read model being broken". They differ on the one axis the callers
 * act on: an authority loss is PERMANENT — only a takeover or a demotion undoes
 * it, so retrying is waste and the latch is correct — while a busy mutex clears
 * the moment the holder commits, so retrying is exactly right. Merging them
 * would make `handleDiagramAttachFailure` abandon a document over transient
 * contention.
 *
 * What they share is the telemetry rule, and it is the reason this exists:
 * without it `runTracked` would fall through to `failReadModelProjection`,
 * stamping `consecutive_failures + 1` and `last_error_code = '55P03'` on the
 * health row of the projector that WON — once per read-route retry for as long
 * as the winner builds.
 *
 * WHAT THIS PREDICATE ACTUALLY MEANS, which is narrower than its name.
 * `55P03` is `lock_not_available` — "a lock
 * wait hit `lock_timeout`" — and nothing in the code tells you WHICH lock. The
 * name is honest only where the caller has arranged for there to be exactly
 * one, and there are now two kinds of caller:
 *
 *  - inside `withReadModelProjectionTransaction`, the helper DISARMS
 *    `lock_timeout` the instant the mutex is held, so after that statement
 *    nothing else in the transaction can raise 55P03 and the code does mean the
 *    mutex and nothing else. That property is the helper's, not this
 *    function's;
 *  - the demotion's row transaction (`promoteSummaryWorkspace.ts`) has NO mutex
 *    and never disarms its ceiling, so its 55P03 is scoped to the whole
 *    transaction. It is attributable only because that transaction has
 *    exactly two waiting statements and both are static-plane contention; a
 *    third statement added later would silently inherit the predicate.
 *
 * So: before using this at a new site, say what else in that transaction can
 * raise 55P03. If the answer is "several things", the site needs its own
 * narrowing, not this predicate.
 */
export function isProjectionMutexTimeout(error: unknown): boolean {
  const code = (value: unknown) => (value as { code?: unknown } | null | undefined)?.code
  // Unwraps one level of `cause`, exactly as `isReadModelAuthorityLoss` does.
  // Without it the two predicates disagree at the sites that see a wrapped
  // error — `attachDiagramDoc` rethrows into `DiagramFlowProjectionError` — and
  // a caller asking both questions would get "not an authority loss, not a
  // mutex timeout" for something that is plainly the second.
  return code(error) === LOCK_NOT_AVAILABLE || code((error as { cause?: unknown })?.cause) === LOCK_NOT_AVAILABLE
}

/** Postgres `deadlock_detected`. */
export const DEADLOCK_DETECTED = '40P01'

/**
 * Was this transaction chosen as a DEADLOCK VICTIM?
 *
 * A SEPARATE predicate rather than a widening of
 * {@link isProjectionMutexTimeout}, and deliberately: that one's docstring
 * spends a paragraph on how narrowly its 55P03 is attributable at each site, and
 * folding a second SQLSTATE into it would change what it means everywhere it is
 * already used. Two questions, two predicates.
 *
 * `read_model_static_documents_workspace_fk` makes an allow-list write take key
 * share on the workspace row through an AFTER-ROW RI trigger — i.e. at END of
 * statement, after the allow-list rows are already locked — so a writer that
 * does not take the workspace row up front goes D → S, against a demotion going
 * S → D, and deadlocks reliably on a mixed insert/update batch.
 * `registerStaticReadModelDocumentsInTransaction` therefore takes the workspace
 * row first.
 *
 * So the ordering fix is what removes the edge and this is the backstop, not the
 * remedy. It is kept because of WHERE the victim lands: the demotion reaches its
 * row transaction having already reverted and flushed the root, and an
 * unclassified throw there escapes to the route's generic handler — a bare 500,
 * no `SummaryDemotionReport`, and no audit row, because `appendAudit` is gated
 * on `report.applied`. Deadlock detection also fires FIRST when both are possible:
 * `deadlock_timeout` defaults to 1 000 ms and that transaction's `lock_timeout`
 * is 5 000 ms, so the 55P03 path cannot mask it.
 */
export function isDeadlockVictim(error: unknown): boolean {
  const code = (value: unknown) => (value as { code?: unknown } | null | undefined)?.code
  return code(error) === DEADLOCK_DETECTED || code((error as { cause?: unknown })?.cause) === DEADLOCK_DETECTED
}

/**
 * The projection MUTEX key, defined ONCE.
 *
 * Both planes derive their key from this function rather than formatting the
 * string themselves. A mutex whose key is written out by hand at each call
 * site is not a mutex: a typo silently un-serializes the two writers and the
 * only symptom is a phantom row nothing reports. The `overlay-rotation:` key
 * follows the same rule: every taker calls `overlayRotationLockKey`
 * (`overlayRotationLock.ts`).
 */
export function projectionMutexKey(key: WorkspaceKey): string {
  return `read-model-projection:${key.landscapeId}:${key.versionId}`
}

/**
 * How long a projection transaction may WAIT for the mutex before giving up.
 *
 * Set with `SET LOCAL`, so the give-up happens SERVER-side: Postgres cancels
 * the waiting STATEMENT with `55P03` and leaves the transaction aborted — the
 * `ROLLBACK` and the client's return to the pool are this helper's own `catch`
 * and `finally`, not something the timeout does. (A `Promise.race` around
 * `pool.query` would instead abandon the caller's promise while the backend
 * keeps running the statement and keeps the client.)
 *
 * "For the mutex" is exact: `SET LOCAL lock_timeout` scopes to the whole
 * TRANSACTION, so the helper turns it back off as soon as the mutex is held —
 * see the disarm in `projectionTransaction.ts`.
 *
 * Short on purpose, and the reason is the authority check below rather than a
 * measurement: whoever holds the mutex either (a) belongs to this plane, in
 * which case it is one publish transaction, or (b) belongs to the other plane,
 * in which case its FIRST act inside the mutex is an authority check that
 * fails and rolls it straight back. A long cold build can only hold the mutex
 * on a workspace that is genuinely its own — where this plane has nothing to
 * write and no reason to wait. So a wait that reaches this ceiling is a wait
 * that was not going to be productive; both projectors retry on their own
 * cadence, and an expired wait costs one tick.
 */
export const PROJECTION_MUTEX_WAIT_MS = 5_000

/**
 * How long a BARE transaction in `staticDeltaProjector` waits for the authority
 * row before giving up.
 *
 * A separate constant from {@link PROJECTION_MUTEX_WAIT_MS} even though the two
 * numbers currently agree, because the argument above does NOT transfer and reusing
 * the constant silently inherits it. That argument is "whoever holds the mutex
 * either belongs to this plane or fails an authority check in one round trip".
 * The holder HERE is a lifecycle transition — a demotion deleting a whole
 * allow-list, or `performanceSeed`'s `clearWorkspace` deleting twenty `ro_*`
 * tables — and neither self-aborts in one round trip; both scale with the
 * workspace.
 *
 * The value is nonetheless short ON PURPOSE, and the reason is the opposite of
 * the mutex's: a rotation racing a lifecycle transition SHOULD lose. Expiring
 * here is the desired outcome, not a failure — the row is skipped, the pass is
 * idempotent, and the next tick re-derives it against a workspace that has by
 * then finished changing hands. What must never happen is holding one of four
 * pool connections for the length of a bulk delete.
 *
 * Pinned to a LITERAL in `projectionAuthority.test.ts`, not to a relation with
 * the constant above: a test that derives its bound from the constant under
 * test agrees with any value that constant is given.
 */
export const STATIC_PLANE_LOCK_WAIT_MS = 5_000

/**
 * Prove this plane owns the workspace, or throw.
 *
 * MUST be called INSIDE the projection transaction and UNDER the mutex, as the
 * first thing after it. Two properties come from that placement and neither
 * survives moving it:
 *
 *  - under the mutex, the check and the row writes are atomic with respect to
 *    the other writer. Without the mutex, two transactions that start either
 *    side of a promote/demote can BOTH pass their authority check, and under
 *    READ COMMITTED the loser's pure INSERTs survive the winner's blanket
 *    DELETE as phantoms — certified by the winner's own arrival watermark, so
 *    nothing downstream contradicts them. That interleaving is tested both
 *    ways against a real database in `writeFence.integration.test.ts`;
 *  - first, so a writer that has lost the plane holds the mutex for one
 *    primary-key lookup rather than for a whole cold build.
 *
 * The authority is `read_model_static_workspaces` — the same durable fact the
 * fleet already tests at attach time, and the one BOTH lifecycle transitions
 * commit atomically (`markStaticReadModelWorkspace` inside the promotion's
 * transaction; the demotion's paired DELETE). Testing the fact rather than a
 * lease is what makes this need no new column, no TTL, no renewal and no CAS:
 * it cannot go stale, because it is re-read per transaction.
 *
 * The fleet's check is a VERDICT with a timestamp,
 * taken once at attach. This is a GUARANTEE over an interval — it holds for
 * every transaction, including the ones that begin after the workspace has
 * changed hands underneath a projector that is still attached.
 */
export async function assertReadModelPlane(
  tx: Queryable,
  key: WorkspaceKey,
  plane: ReadModelPlane,
): Promise<void> {
  // `FOR KEY SHARE`, and NOT via `isStaticReadModelWorkspace` — which stays an
  // unlocked reader for its other call sites — see the note on the import.
  //
  // The two planes are asymmetric, and that decides the whole design:
  //
  //  - STATIC authority is a row that EXISTS, and an existing row can be
  //    locked. Held in key-share for the length of this transaction, the
  //    demotion's `DELETE FROM read_model_static_workspaces` waits for this
  //    publish to finish, and a publish that BEGINS after the demotion commits
  //    sees no row and throws here, at statement four, having written nothing.
  //    That converts a verdict taken at the start of the transaction into a
  //    guarantee that holds to its commit.
  //
  //    SCOPE: the guarantee covers the writers that come THROUGH
  //    `withReadModelProjectionTransaction` (`StaticDeltaProjector`'s `publish`
  //    and `transactionOnly`) and the bare `BEGIN`s in `staticDeltaProjector.ts`,
  //    whose guard `assertPlaneAndOwnership` calls this function above its
  //    flag-gated early return. Other production writers of the static-plane
  //    and overlay tables:
  //
  //      1-2. `registerStaticReadModelDocuments` called on the POOL by
  //           `projectMeta` and `projectRoot` in `staticDeltaProjector.ts` — so
  //           `withAtomicStatements` opens a transaction of its own, outside
  //           any plane check. These CREATE the allow-list row, gated only by
  //           `holdsStaticPlane` at the dispatcher.
  //
  //           Covered by the schema, not by a guard at either site:
  //           `read_model_static_documents_workspace_fk` (`readModel/schema.ts`)
  //           makes the allow-list row a CHILD of the authority row, so a write
  //           for a workspace with no authority is refused by the database
  //           (`23503`) — there is no per-site line for a future call site to
  //           forget. The refusal also rolls back the
  //           `automerge_document_workspace` claim written just before it,
  //           because `registerStaticReadModelDocuments` wraps the pair in
  //           `withAtomicStatements`.
  //
  //           The foreign key CHANGES THE LOCK ORDER OF THAT FUNCTION, stated
  //           as S -> W -> D elsewhere. The foreign key makes the D
  //           insert take a row lock on S, and `registerStaticReadModelDocuments`
  //           writes W first and reaches S only through that implicit check — so
  //           its real order is W -> S -> D. It is safe for a reason narrower
  //           than the rule it breaks: the only other writer
  //           that holds S while wanting W is `markStaticReadModelWorkspace`,
  //           whose upsert on a non-key column takes FOR NO KEY UPDATE, and that
  //           is COMPATIBLE with the FK's key share — the child insert completes
  //           rather than waiting. A DELETE of S does block it, and a demotion
  //           takes S first anyway, so no cycle exists. The one arm that is
  //           neither: an UNCOMMITTED INSERT of a new S row makes the child
  //           insert fail 23503 rather than wait, because READ COMMITTED cannot
  //           see it.
  //
  //           What the constraint does NOT do is remove the rows that predate
  //           it — it is installed `NOT VALID`, because `ensureReadModelSchema`
  //           runs on every boot and the validated form REFUSES to install on a
  //           database holding one orphan, which would wedge the deploy. So
  //           `FSCK_CHECKS['static-allow-list-orphaned']` still owns that
  //           population — one that can only SHRINK, through: the demotion
  //           door's explicit allow-list sweep (which reaches rows the cascade
  //           cannot, on the half-state where there is no workspace row — do
  //           not remove it as redundant), a re-promotion's blanket
  //           delete-then-reinsert in `markStaticReadModelWorkspace`, and the
  //           cascade itself. The fsck half has a limit too: `fsckAllWorkspaces`
  //           enumerates from `versions`, so an orphan whose `versions` row is
  //           gone is invisible to it and has no detector at all;
  //        3. `draft/sparse.ts`, which opens a bare `BEGIN` and has NO guard of
  //           any kind — and writes for a sparse-draft workspace, which is
  //           itself demotable, since `not-summary` needs a null source and a
  //           sparse draft's source is not null;
  //        4. `closeInactiveAdmittedRotations`, which writes
  //           `read_model_overlay_segments` for EVERY workspace in the
  //           database, from every static-projector pod, with no plane check,
  //           no `ownsWorkspace` and no workspace filter at all. Bounded in
  //           damage (an idempotent retention stamp on rotations whose version
  //           is already inactive, which a later publish clears by setting
  //           `retain_until = NULL`), but "bounded" is not "covered".
  //
  //    When extending this list, enumerate by searching for writes to the
  //    TABLES, not for the function names you remember.
  //
  //    A demotion can still commit alongside any of these. It is not known
  //    to lose data (once `static_source` is null `resolveDurable`'s filter is
  //    off, and a re-promotion's `markStaticReadModelWorkspace` DELETEs the
  //    whole list first), but it is not covered;
  //  - ORDINARY authority is the ABSENCE of that row, and absence is not
  //    lockable. `SELECT … FOR KEY SHARE` returning zero rows locks nothing,
  //    and under READ COMMITTED a promotion's uncommitted INSERT is invisible
  //    rather than blocking — so this call CANNOT stop a cold build from
  //    committing over a plane that changed hands mid-build. Nothing here can.
  //    The ordinary direction is fenced instead, by the promotion writing a
  //    sentinel into `read_model_projection_state.write_fence` in the same
  //    transaction that publishes the static row; see
  //    {@link LIFECYCLE_WRITE_FENCE_PREFIX}.
  //
  // Do not "simplify" this by moving the check to the end of the transaction to
  // match the fence. For the static plane the lock is what matters and it must
  // be taken early; for the ordinary plane a later re-read still cannot block,
  // so it would buy a smaller window and the appearance of a fix.
  //
  // LOCK ORDER: this is the FIRST row lock in every projection transaction, and
  // that is deliberate. The global order in this subsystem is
  // `read_model_static_workspaces` → `automerge_document_workspace` →
  // `read_model_static_documents` → `read_model_projection_state`.
  //
  // Both projectors, the demotion and `performanceSeed`'s `clearWorkspace` take
  // it that way. The PROMOTION does not — it takes W → S → W → D → P, because
  // `claimWorkspaceDocuments` runs first — and that exception is argued at its
  // own call site rather than here, because it rests on properties of that door
  // (it cannot overlap a static publish, and its write head is freshly minted).
  //
  // `SELECT true AS present … FOR KEY SHARE`, and the projection is chosen to
  // keep the SAME answer shape as `isStaticReadModelWorkspace`'s
  // `SELECT EXISTS(...) AS present`: one row carrying a boolean when the
  // workspace is static, and — the part `EXISTS` cannot express — NO row when
  // it is not, which is what makes the lock possible. An `EXISTS` subquery
  // cannot be locked; it always returns exactly one row, so there is nothing
  // for `FOR KEY SHARE` to hold.
  //
  // Reading the COLUMN rather than `rows.length` is deliberate. Both are
  // correct against production, but every recording fake in this tree answers
  // this table with `{ present: <boolean> }`, and a length test would silently
  // read every one of them as STATIC — a fixture drift that reverses the
  // meaning of a dozen suites while they all stay green.
  const { rows } = await tx.query<{ present: boolean }>(
    `SELECT true AS present FROM read_model_static_workspaces
      WHERE landscape_id = $1 AND version_id = $2
      FOR KEY SHARE`,
    [key.landscapeId, key.versionId],
  )
  const isStatic = rows[0]?.present === true
  if (isStatic !== (plane === 'static')) throw new ReadModelPlaneError(key, plane)
}
