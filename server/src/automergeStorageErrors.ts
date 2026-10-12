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
 * The storage fence's refusal, and the vocabulary of its reasons, in a module
 * that imports nothing.
 *
 * WHY IT IS NOT BESIDE THE FENCE THAT THROWS IT, AND WHAT THAT IS A WORKAROUND
 * FOR. `automergeStorage.ts` imports `./db.js`, and `db.js` constructs three
 * `pg.Pool`s at import time. Any module that wants to ANSWER this error (e.g.
 * the HTTP mapping) would otherwise have to build connection pools merely to
 * name the class in an `instanceof`.
 *
 * The root cause is `db.ts` doing work at import time; extracting the class is
 * the bounded response. It is also the right home on its own terms: a refusal
 * that crosses an HTTP boundary IS a wire contract, and `reason` below is the
 * part a client branches on, so it belongs in a leaf both sides can see.
 */

/**
 * The two reasons the fence actually refuses, and they are NOT the same event:
 *
 * - `ownership-unavailable` — this cell cannot establish ownership AT ALL. The
 *   distributed runtime is gone, so the cell can prove nothing about who owns
 *   the workspace, including that it does not. Coming back is the fix.
 * - `fence-mismatch` — this cell holds a token the durable row has moved past.
 *   Ownership IS established and it belongs to a neighbour.
 *
 * Kept as a union rather than `string` so a third reason is a compile error at
 * every place that maps one, rather than a silent fall-through to whichever
 * branch happens to be last.
 */
export type StorageFenceRejectionReason = 'ownership-unavailable' | 'fence-mismatch'

/**
 * The constructor default. No throw site produces it — all four pass an explicit
 * reason (`automergeStorage.ts`, `staleWrite` and `coalesceStaleImmutableMutation`)
 * — but test doubles construct the error bare, so it is a real value that can
 * reach a client and it is typed rather than left implicit. It asserts LESS than
 * either real reason: "refused, cause not stated".
 */
export type UnstatedFenceReason = 'stale-fence'

export class StaleSyncCellWriteError extends Error {
  constructor(
    readonly mutationKind = 'unknown',
    readonly reason: StorageFenceRejectionReason | UnstatedFenceReason = 'stale-fence',
    /**
     * The document whose mutation was refused, when the adapter knows it. A
     * refusal logged without its document cannot say WHAT it refused (e.g.
     * whether a background save refused on a healthy cell belonged to a merged
     * draft, a new snapshot, or something unmapped). `null` where the caller
     * had no id.
     */
    readonly documentId: string | null = null,
  ) {
    super('Sync-cell fencing rejected a stale storage mutation')
    this.name = 'StaleSyncCellWriteError'
  }
}

/**
 * THE STORAGE ADAPTER COULD NOT BORROW A CONNECTION.
 *
 * `dependencyOutageResponse.ts` deliberately does not string-match the pg-pool
 * `timeout exceeded when trying to connect` message; the failure is converted
 * AT THE ACQUISITION SITE instead, where its meaning is known without
 * guessing. `acquireLifecycleApplyLock` is the precedent — it wraps
 * `db.connect()` and nothing else, so any rejection from it IS a borrow
 * failure. This class is that same shape for the storage adapter.
 *
 * WHY IT DOES NOT CARRY `retryable: true`, although it is a transient
 * condition and nothing was written by the operation that threw it. The
 * operation is not the request. `Repo.flush` fans `saveDoc` out over every
 * dirty document with a `Promise.all`, so the siblings of a refused save may
 * already have committed, and `applyMerge` flushes four times. In this codebase
 * `retryable` means "safe to repeat", and a merge interrupted here can leave
 * durable documents behind. `StaleSyncCellWriteError` above omits
 * it for exactly this reason; so does this.
 *
 * The pg error is the CAUSE and never the message: a connect failure's text
 * carries the host, the port and the role, and this message reaches an HTTP
 * client through the shared mapping.
 */
export class StoragePoolExhaustedError extends Error {
  readonly code = 'storage-pool-exhausted'

  constructor(
    readonly operation: string,
    /**
     * WHICH ceiling was hit, and they are not the same event to an operator.
     * `borrow-timeout` means the POOL had nothing to lend within
     * `connectionTimeoutMillis` — the database or its connection budget is the
     * problem. `queue-timeout` means this adapter was already at its own bound
     * and the caller waited out its deadline — the adapter is being asked for
     * more concurrent storage work than it is allowed to do, which is a
     * different fix (raise the bound, or shed load upstream).
     *
     * One `code` for both, because a client's action is identical; separate
     * `reason`s, because an operator's is not. Same division
     * `StaleSyncCellWriteError` above makes.
     */
    readonly reason: 'borrow-timeout' | 'queue-timeout',
    cause?: unknown,
  ) {
    // THE MESSAGE DOES NOT SAY "NOTHING WAS WRITTEN": `withDbRetry` runs the
    // operation up to TWICE, so a `borrow-timeout` can be the SECOND
    // attempt's, after the first attempt already ran statements. The claim is
    // true of a `queue-timeout` and of a first-attempt borrow, and this class
    // cannot tell which it is — so it asserts the thing it can prove, that this
    // attempt failed before running a statement, and leaves the stronger claim
    // to `lifecycleApplyLock`, which really does refuse before doing anything.
    super(
      `the Automerge storage adapter could not ${reason === 'queue-timeout' ? 'get a permit' : 'borrow a database connection'}`
      + ` for "${operation}". This attempt ran no statement.`
      + ' The connection pool is saturated or unreachable.',
      cause === undefined ? undefined : { cause },
    )
    this.name = 'StoragePoolExhaustedError'
  }
}
