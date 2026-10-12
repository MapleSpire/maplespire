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
 * ONE answer for "a dependency this server needs is transiently unavailable",
 * consulted by BOTH doors that turn a thrown error into an HTTP response.
 *
 * WHY IT IS ITS OWN MODULE AND NOT A BRANCH IN EACH OF THEM. There are two such
 * doors and they cover disjoint routes: `route()` in `routeErrors.ts` catches
 * the rejection itself and does not call `next(err)`, so a wrapped handler's
 * rejection does not reach `terminalErrorHandler`; and `terminalErrorHandler` is
 * what stands behind a route that neither wraps itself in `route()` nor catches
 * its own errors. So the mapping is defined once here, and each door supplies
 * only its own FALLBACK, which is the part that genuinely differs: `route()`
 * answers `read model query failed`, where the terminal handler must stay
 * `internal_error` because it also catches unauthenticated endpoints that have
 * nothing to do with the read model.
 *
 * Two caveats. A handler that throws SYNCHRONOUSLY never gets `route()`'s
 * `.catch` attached and escapes to Express, reaching the terminal handler —
 * benign, since both doors answer from this module. And many routes in
 * `index.ts` catch and terminate on their own with `res.status(500)`; those are
 * a third set of doors, and the ones that can see a fence refusal use
 * `sendDependencyOutage` below.
 *
 * Without this mapping, a sync-cell fence refusal during a Redis outage is
 * answered `500 {"error":"read model query failed"}`: a 500 for a transient
 * condition, naming a subsystem that had not failed.
 *
 * Untyped `pg` errors (e.g. pool `timeout exceeded when trying to connect`) are
 * deliberately NOT string-matched here. The pattern is to catch them AT THE
 * ACQUISITION SITE, where their meaning is known, and convert them to a typed
 * refusal (`acquireLifecycleApplyLock`, the storage adapter's
 * `StoragePoolExhaustedError`), which this module then maps.
 */

import { StaleSyncCellWriteError, StoragePoolExhaustedError } from '../automergeStorageErrors.js'
import type { StorageFenceRejectionReason, UnstatedFenceReason } from '../automergeStorageErrors.js'
import { RedisUnavailableError } from './redisErrors.js'
import { WriteAuthorityLostError, WriteAuthorityUnavailableError } from '../syncCells/writeAuthority.js'

export interface DependencyOutageResponse {
  status: number
  headers: Record<string, string>
  body: Record<string, unknown>
  /**
   * WHICH dependency is unavailable, for the log line. It is a field rather than
   * a string each caller writes by hand so that the log and the body cannot come
   * to name different subsystems. Both doors are required to use it; `routeErrors.test.ts` and
   * `errorMiddleware.test.ts` each pin their own.
   */
  subsystem: string
}

/**
 * HOW LONG TO TELL A CLIENT TO WAIT, and it is a CHOSEN POLICY FLOOR — not a
 * measured recovery time. No run has been timed from a fence refusal to the
 * first success after it.
 *
 * It is anchored on two numbers in `syncCells/ownership.ts`: `leaseTtlMs`
 * defaults to 15 000 ms, so after a runtime outage a stale workspace lease alone
 * can take 15 s to expire before any cell can reacquire it; and the worst
 * legitimate reconcile PASS recorded there is ~15.4 s at 10 000 versions.
 * `reconcileIntervalMs` (5 s) is only the TICK and is not a floor on
 * reconvergence, because a pass is not instantaneous.
 *
 * It does NOT jitter: `Retry-After` cannot express a range, so every client
 * refused in the same second is told to return in the same second. A
 * per-response random value would make the contract non-deterministic.
 */
const FENCE_RETRY_AFTER_SECONDS = '15'

interface FenceRefusalWording {
  code: string
  error: string
}

/**
 * The two reasons are NOT the same event and a client cannot act on them the
 * same way, so they do not share a `code` — `code` is the field a client
 * switches on, and `reason` is an extension member most clients drop.
 *
 * An exhaustive switch on purpose: a third reason added to the union is a
 * compile error here rather than a silent fall-through to whichever wording
 * happens to be last.
 */
function fenceRefusalWording(
  reason: StorageFenceRejectionReason | UnstatedFenceReason,
): FenceRefusalWording {
  switch (reason) {
    case 'ownership-unavailable':
      // NOT "does not own the workspace": the cell cannot establish ownership at
      // all, so it can prove nothing about who owns it — including that it does
      // not. This is the reason a Redis outage produces.
      return { code: 'sync-cell-ownership-unavailable', error: 'sync-cell ownership cannot be established' }
    case 'fence-mismatch':
      // Ownership IS established, and it belongs to a neighbour. Coming back to
      // THIS cell will not help until the write is routed to the owner.
      return { code: 'sync-cell-not-owner', error: 'this sync cell does not own the workspace' }
    case 'stale-fence':
      // The class default. No production throw site produces it, but a bare
      // construction can, so it gets wording that asserts only what is certain.
      return { code: 'sync-cell-write-refused', error: 'the sync-cell write fence refused this write' }
  }
}

/**
 * `null` means "this is not a dependency outage" — the caller applies its own
 * fallback. It is deliberately not "500", so neither door has to agree with the
 * other about what an unrecognised error should say.
 */
export function dependencyOutageResponse(err: unknown): DependencyOutageResponse | null {
  if (err instanceof RedisUnavailableError) {
    // The `error` token is a client-facing contract: clients parse
    // `rate_limit_unavailable`, so it must not change.
    //
    // Routes that handle a Redis outage inline (`passwordAuth.ts`, `orgs.ts`,
    // `adminTechnologyRoutes.ts`, `index.ts`) return route-specific bodies;
    // what they share with this one is 503 + `Retry-After: 1`, the part a
    // client acts on. Unifying the bodies would be a client-visible change.
    return {
      status: 503,
      headers: { 'Retry-After': '1' },
      body: {
        error: 'rate_limit_unavailable',
        // Added alongside `error` (which stays byte-identical): `code` is the
        // field every response from this module carries, so a client has ONE
        // field to switch on.
        code: 'rate_limit_unavailable',
        message: 'This operation is temporarily unavailable.',
      },
      subsystem: 'distributed runtime',
    }
  }

  if (err instanceof StaleSyncCellWriteError) {
    const { code, error } = fenceRefusalWording(err.reason)
    // WHY THERE IS NO `retryable: true` HERE, although every other 503 in
    // `routeErrors.ts` carries one. In this codebase `retryable` is the stronger
    // marker — "safe to repeat" — and every existing emitter earns it by being
    // ATOMIC: `LifecycleApplyRefusedError` refuses "BEFORE writing anything"
    // (see `routeErrorResponse`), and `workspaceHttpRoute.ts`'s refusals fire
    // before forwarding.
    //
    // A fence refusal on a write does not earn it. A mutating request
    // interrupted by this outage can leave durable documents behind, and
    // `forkRoot`'s best-effort rollback cannot run because it needs the pool
    // the failure has just exhausted. The refused mutation never reached
    // storage; EARLIER mutations of the same request may already have.
    //
    // 503 + `Retry-After` already says "come back". `src/lib/api/retryable.ts`
    // states the client half of the same doctrine and refuses to auto-retry a
    // non-GET on a 503 for exactly this reason.
    return {
      status: 503,
      headers: { 'Retry-After': FENCE_RETRY_AFTER_SECONDS },
      body: { error, code, reason: err.reason },
      subsystem: 'sync-cell ownership',
    }
  }

  if (err instanceof StoragePoolExhaustedError) {
    // The storage adapter converts the untyped `pg` pool timeout into this
    // typed refusal at the acquisition site (`automergeStorage.ts`'s
    // `withBoundedClient`), so there is a class to match on and no string
    // match on a `pg` message.
    //
    // NO `retryable: true`, for `StaleSyncCellWriteError`'s reason exactly:
    // `Repo.flush` fans `saveDoc` out with a `Promise.all` and `applyMerge`
    // flushes four times, so the operation that threw wrote nothing while its
    // siblings may already have committed. `retryable` means "safe to repeat".
    //
    // `Retry-After` is 2, not the fence's 15. The two waits are for different
    // events and it would be wrong to share a constant: a fence refusal waits
    // for a LEASE to expire and a reconcile pass to run (see
    // FENCE_RETRY_AFTER_SECONDS), while this one waits only
    // for the borrower ahead of it to give a client back — bounded by the
    // adapter's own bound, and milliseconds in the healthy case.
    return {
      status: 503,
      headers: { 'Retry-After': '2' },
      body: { error: err.message, code: err.code },
      subsystem: 'storage connection pool',
    }
  }

  // THE BOOTSTRAP SCOPE'S TWO REFUSALS, and both EARN `retryable: true` where
  // the two fence classes above do not. A scope refused at open has minted
  // nothing, and a scope that lost its authority mid-graph has had its fork
  // rolled back with every note kept, so nothing durable is claimed and a
  // repeat starts clean. A bootstrap tool called from the AI agent loops or
  // `/mcp` is what reaches these branches: the HTTP doors and the direct AI
  // tool doors are routed to the owner first, and the merge handler maps the
  // first class itself
  // (`syncCells/mergePlacement.ts`, `writeAuthorityRefusal`) before calling
  // here — the two bodies agree field for field and this one adds `code`, the
  // member every response from this module carries.
  //
  // `sync-cell-not-owner` is the SAME code the fence's `fence-mismatch` branch
  // answers, on purpose: to a client both mean "ownership is established and
  // belongs to a neighbour; come back through the load balancer", and a
  // second spelling for one action would be a second thing to switch on.
  // `warming-up` is its own code because its action differs — wait here.
  if (err instanceof WriteAuthorityUnavailableError) {
    const warming = err.reason === 'warming-up'
    return {
      status: 503,
      headers: { 'Retry-After': warming ? '2' : '1' },
      body: {
        error: err.message,
        code: warming ? 'sync-cell-ownership-warming-up' : 'sync-cell-not-owner',
        reason: err.reason,
        retryable: true,
        wrote: 'nothing',
      },
      subsystem: 'sync-cell ownership',
    }
  }

  // `wrote` must NOT claim the documents minted before the lease moved "were
  // rolled back": any whose debounced save landed while the lease was still
  // held are durable, their removal is refused by the fence (correctly: this
  // cell no longer speaks for them), and the minted-orphan reaper on a leased
  // cell owns them. What IS certain: no version row exists, and nothing
  // written AFTER the loss is durable.
  if (err instanceof WriteAuthorityLostError) {
    return {
      status: 503,
      headers: { 'Retry-After': '1' },
      body: {
        error: err.message,
        code: 'sync-cell-write-authority-lost',
        retryable: true,
        wrote: 'no version; nothing written after the lease moved is durable, and documents an earlier lease admitted are fenced under a lease this cell no longer holds',
      },
      subsystem: 'sync-cell ownership',
    }
  }

  return null
}

/** The five members `sendDependencyOutage` touches — see below for why. */
export interface OutageResponseLike {
  headersSent: boolean
  setHeader(name: string, value: string): unknown
  status(code: number): { json(body: unknown): unknown }
  /** Optional: an `http.ServerResponse` has both, a test double need not. */
  destroy?: (error?: Error) => unknown
  writableEnded?: boolean
}

/**
 * Send the outage response, or report that this error is not one.
 *
 * A third entry point, besides the two general doors: `index.ts` holds many
 * `res.status(500)` sites that catch and terminate themselves, and FIVE of them
 * can reach `StaleSyncCellWriteError`, each through a `repo.flush(...)` in its
 * own call graph:
 *
 *   POST /api/landscapes                              (createEmptyRoot)
 *   POST /api/landscapes/:id/versions                 (forkRoot | createEmptyRoot)
 *   POST /api/landscapes/:id/drafts                   (createSparseDraftRoot | forkRoot)
 *   GET  /api/landscapes/:id/drafts/:draftId/changes  (root rotation)
 *   POST /api/landscapes/:id/drafts/:draftId/merge    (root rotation + applyMerge)
 *
 * They are named by ROUTE, not by `index.ts` line number, because line numbers
 * drift.
 *
 * They cannot use `route()`: that would change each one's fallback body to
 * `read model query failed`, which is a lie on a landscape-creation endpoint.
 * And they must answer 503 like their neighbours `GET /api/automerge/root` and
 * `POST /api/automerge/durable-heads` do for this exact condition, so a
 * client's answer does not depend on which adjacent route it called.
 *
 * So the mapping stays single and this adds only the SENDING of it. The return
 * value is the point: `false` means "not mine", and the caller keeps its own
 * fallback, which is the same contract `dependencyOutageResponse` already has
 * with the two general doors.
 *
 * The parameter is structural rather than `express.Response` for the reason
 * `routeErrors.ts` gives for `RouteResponseLike`: these members are all this
 * touches, so a test can hand it a plain object and assert the status, the
 * headers AND the body that actually reach a client. `index.ts` boots a server
 * on import, so a test can never reach these five call sites directly — the
 * wiring is covered by the source-level gate in
 * `scripts/dependency-outage-doors.test.mjs` instead, and the BEHAVIOUR is
 * covered here.
 *
 * `headersSent` is handled the same way `route()` handles it, and that symmetry
 * is deliberate rather than incidental — see the branch itself.
 */
export function sendDependencyOutage(res: OutageResponseLike, err: unknown): boolean {
  const outage = dependencyOutageResponse(err)
  if (!outage) return false
  if (res.headersSent) {
    // TRUE, NOT FALSE. `false` would send the caller into its own
    // `res.status(500)`, which throws ERR_HTTP_HEADERS_SENT — a second error
    // raised inside the first one's handler, losing both. The error WAS
    // recognised; there is simply nowhere left to put it.
    //
    // AND THE CONNECTION IS DESTROYED, for the reason `route()` destroys.
    // These five callers are plain `app.post(async …)` with no `next(err)`, so
    // `finalhandler` never runs; returning silently would leave a half-written
    // response hanging until Node's default 300 s `requestTimeout`.
    //
    // `writableEnded` guards the completed-then-rejected case: destroying there
    // truncates a correct response.
    if (!res.writableEnded) res.destroy?.()
    return true
  }
  for (const [name, value] of Object.entries(outage.headers)) res.setHeader(name, value)
  res.status(outage.status).json(outage.body)
  return true
}
