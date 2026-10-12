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

import type { DocumentId, Repo } from '@automerge/automerge-repo'
import type { MetricSample } from './runtime/metrics.js'
import { envNumber } from './envNumber.js'
import { isMintedDocumentId } from './rbac/documentIdMint.js'
import { StaleSyncCellWriteError } from './automergeStorageErrors.js'

/**
 * A FAILED FORK'S ROLLBACK, AND WHAT IT CAN AND CANNOT GUARANTEE.
 *
 * ## Why not `repo.delete`
 *
 * `Repo.delete(id)` returns `void`. Its durable half is
 * `storageSubsystem.removeDoc(documentId).catch(err => log.error(...))` — a
 * promise nothing awaits, whose rejection is swallowed INSIDE the library. A
 * rollback built on it can only observe a SYNCHRONOUS throw and unwinds the
 * caller while removals are still in flight; under pool exhaustion those
 * removals fail and the documents stay durable forever. This module awaits the
 * removals, tells the caller the outcome, and reports any residue it could not
 * clear.
 *
 * ## What this module does NOT do, and cannot: the armed save
 *
 * Every document `forkRoot` creates has a save ARMED the instant it exists:
 * `StorageSource.attach` (`dist/StorageSource.js`) registers a throttled
 * `heads-changed` listener and calls it immediately whenever the handle has
 * heads, which `repo.create` and `repo.import` both produce. That save cannot
 * be cancelled: `StorageSource.detach` only deletes the map entry, and
 * `asyncThrottle` exposes no cancel for the timer it has already armed, whose
 * closure holds the subsystem and the handle. So a document created inside
 * the debounce window before the fork failed may be WRITTEN BACK after this
 * function removed it, and nothing this function can observe says whether
 * that will happen. (Flushing first does not "disarm" it either: a save
 * already in flight lands after the flush resolves, and a `change()` in the
 * window re-arms it.)
 *
 * So the outcome below has NO field about resurrection, on purpose: a boolean
 * this function cannot compute would be read as a guarantee. What reclaims a
 * written-back document depends on its NAME, and the log line below says
 * which, per id: when the process could mint (a mint key and the
 * documents-registration hook — `bootstrapMint.ts`), the document carries a
 * workspace-bound id, the publisher claims it in the same step as the
 * `versions` row, and a minted id with no claim and no existing version is
 * reaped by `mintedOrphanReaper.ts` about an hour after its birth; when it
 * could not (an AUTH=off process), the id is a legacy random one and the only
 * net is `gcOrphanedDocs`, 24 h best and ~47 h worst, computed.
 *
 * ## `removeFromCache`, not `delete`
 *
 * `Repo.removeFromCache` detaches every source, drops the query and clears sync
 * state. `delete` does that PLUS the un-awaited `removeDoc`, plus
 * `handle.delete()`, `query.fail(...)` and an emitted `delete-document` — none
 * of which this path wants. Using `delete` here would issue a SECOND,
 * fire-and-forget removal per document, doubling the load on the very
 * resource whose exhaustion caused the rollback.
 *
 * ## Chunked, because the fan-out is its own cause of failure
 *
 * Every `removeRange` goes through `withFencedMutation` -> `withBoundedClient`
 * (`automergeStorage.ts`) and takes a permit from a gate whose bound is
 * `min(4, poolMax - 1)` with a 2 000 ms wait. A fork of a large workspace is
 * hundreds of documents, and one `Promise.allSettled` over all of them refuses
 * nearly all on a permit timeout (and starves the sync write path, which shares
 * that gate).
 *
 * So the fan-out is chunked to the gate's bound, and the whole rollback carries
 * a wall-clock budget: this runs inside a request that is ALREADY failing, and
 * the primary pool sets neither `statement_timeout` nor `lock_timeout` (only
 * the sync-cell pool does, see `dbConfig.ts`), so a DELETE parked behind a row
 * lock would otherwise hang the fork forever.
 */

/** Documents removed concurrently. Matched to `DEFAULT_STORAGE_DB_CONCURRENCY`
 *  (`automergeStorage.ts`), the storage gate's own bound: queueing wider than
 *  the gate cannot go faster and gets refused on permit timeouts. */
const CHUNK = 4

/** How many times to re-attempt a document whose removal rejected.
 *
 *  Read at CALL time, not module load, so a test that sets the variable after
 *  importing actually exercises it (see `envNumber`). */
function attempts(): number {
  return envNumber('FORK_ROLLBACK_ATTEMPTS', {
    fallback: 3, minimum: 1, maximum: 16, integer: true,
  })
}

/** Total wall clock this rollback may spend, across every attempt.
 *
 *  It bounds the DELETEs, which are otherwise unbounded: the primary pool sets
 *  no `statement_timeout` (`dbConfig.ts`), so one blocked on a row lock
 *  waits for ever. The gate wait (2 000 ms) and the borrow
 *  (`connectionTimeoutMillis` 10 000 ms) are each bounded; their PRODUCT over
 *  attempts and chunks is not. The deadline is checked BEFORE each chunk, never
 *  inside one, so the first chunk runs at any budget the in-memory teardown
 *  loop has not already consumed; the floor of 100 ms is there so that loop
 *  fits and the knob cannot be turned into a silent off switch for every
 *  chunk after the first. */
function budgetMs(): number {
  return envNumber('FORK_ROLLBACK_BUDGET_MS', {
    fallback: 5_000, minimum: 100, maximum: 120_000, integer: true,
  })
}

export interface ForkRollbackOutcome {
  /** Distinct documents the fork had created when it failed. */
  attempted: number
  /** Documents whose storage rows were removed by an AWAITED call that resolved. */
  removed: number
  /** Document ids still durable after every attempt. Empty is the good case —
   *  for the removals this function issued. It says nothing about a save that
   *  was armed before the failure; see the module docblock. */
  undeleted: string[]
  /**
   * Document ids whose removal the STORAGE FENCE refused, or was never asked
   * for because the fork itself failed on a fence refusal. NOT
   * `undeleted`, and the difference is the whole point: a refused removal
   * says this cell holds no lease for the write, which is the same reason
   * every save of these documents was refused — nothing this process wrote
   * under that lease state is durable, and what an EARLIER lease let through
   * is fenced under a lease this cell no longer holds. The minted-orphan
   * reaper, running on a leased cell, owns whatever is there. Counting them
   * as "remain DURABLE" would fire the cleanup-failed alert on every retry of
   * a request the fence is refusing correctly.
   */
  fenceRefused: string[]
  /** True when the deadline passed before this function returned — whether
   *  chunks were skipped or an in-flight chunk overran it. `undeleted` says
   *  what is left; this says the caller waited longer than it was promised,
   *  which on an already-failing request is its own finding. */
  budgetExhausted: boolean
}

let undeletedTotal = 0

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Roll a failed fork's documents back, and RETURN what could not be rolled back.
 *
 * Never throws: it is called from a `catch` whose job is to re-throw the
 * original error, and an exception raised here would replace the cause of the
 * failure with a symptom of the cleanup, losing the first error. The whole body is wrapped, rather than
 * relying on the callee being `async`: `pending.map(id => subsystem.removeDoc(id))`
 * is SYNCHRONOUS, so a callee that throws synchronously escapes before
 * `Promise.allSettled` exists to catch it. And that outer `catch` is not a
 * swallow: it counts every document as undeleted and logs the error it caught.
 */
export async function rollbackForkedDocuments(
  repo: Repo,
  documentIds: readonly DocumentId[],
  options: {
    /**
     * WHY the fork failed. When it is the storage fence's own refusal, the
     * durable pass is not run at all: every `removeRange` would meet the same
     * fence — `removeDoc` is three `removeRange` calls, times `attempts()`, one
     * borrow each on a pool the outage is already starving — and be refused
     * for the same reason. Nothing this process wrote under that lease state
     * landed, so the documents are reported as `fenceRefused`, not as
     * `undeleted`.
     */
    cause?: unknown
  } = {},
): Promise<ForkRollbackOutcome> {
  // Inside the `try` from the first statement, so "never throws" is enforced
  // from entry rather than true by inspection of what precedes the block.
  let ids: string[] = []
  let deadline = Number.POSITIVE_INFINITY
  try {
    // DISTINCT ids. A duplicate would be removed twice, reported twice, and
    // would double-count the operator metric.
    ids = [...new Set(documentIds.map((id) => String(id)))]
    deadline = Date.now() + budgetMs()
    const subsystem = repo.storageSubsystem

    // 1. Teardown WITHOUT a second removal. `removeFromCache`, not `delete`.
    //    This frees the handle and stops a FUTURE change from arming a save; it
    //    does not, and cannot, cancel the one already armed.
    for (const id of ids) {
      try {
        await repo.removeFromCache(id as DocumentId)
      } catch {
        // A document the repo no longer tracks is already torn down. The
        // durable pass below is what decides the outcome, not this.
      }
    }

    if (!subsystem) {
      // No storage adapter: nothing was ever durable and nothing can resurrect.
      // The budget field keeps its definition even here — the teardown loop
      // above is the only thing that can have overrun it.
      return { attempted: ids.length, removed: 0, undeleted: [], fenceRefused: [], budgetExhausted: Date.now() >= deadline }
    }

    if (options.cause instanceof StaleSyncCellWriteError) {
      // The fork was refused by the fence. Not an error worth an alert, and
      // not a durable pass worth 9N borrows: say which documents were fenced
      // and hand them to the reaper, which runs on a cell that holds a lease.
      console.warn(
        `forkRoot rollback: the fork was refused by the storage fence (${options.cause.reason}); `
        + `${ids.length} document(s) torn down, removal not attempted — nothing written under this `
        + `cell's lease state is durable. ${reclaimPaths(ids)}: ${ids.join(', ')}`,
      )
      return { attempted: ids.length, removed: 0, undeleted: [], fenceRefused: ids, budgetExhausted: Date.now() >= deadline }
    }

    // 2. Awaited removal, chunked to the storage gate's bound.
    let pending = ids
    let skipped = false
    const fenceRefused: string[] = []
    for (let attempt = 0; attempt < attempts() && pending.length > 0; attempt += 1) {
      const failed: string[] = []
      for (const group of chunk(pending, CHUNK)) {
        if (Date.now() >= deadline) {
          skipped = true
          failed.push(...group)
          continue
        }
        const results = await Promise.allSettled(
          // `removeDoc` is three sequential `removeRange` calls that stop at the
          // first rejection; each is idempotent, so re-attempting the whole
          // document is what closes a partial pass.
          group.map((id) => subsystem.removeDoc(id as DocumentId)),
        )
        group.forEach((id, index) => {
          const result = results[index]!
          if (result.status !== 'rejected') return
          // A FENCE refusal is classified, not retried: the lease state that
          // refused it is the same on the next attempt, and the document is
          // not this cell's to remove. Anything else (a pool timeout, a
          // connection error) stays `failed` and gets its remaining attempts.
          if (result.reason instanceof StaleSyncCellWriteError) fenceRefused.push(id)
          else failed.push(id)
        })
      }
      pending = failed
      if (skipped) break
    }
    // An in-flight chunk can overrun the deadline without any chunk being
    // skipped — the primary pool has no statement timeout — and the caller
    // must learn that too.
    const budgetExhausted = skipped || Date.now() >= deadline

    if (fenceRefused.length > 0) {
      console.warn(
        `forkRoot rollback: ${fenceRefused.length} of ${ids.length} document(s) had their removal REFUSED by the `
        + `storage fence — this cell holds no lease for them; the reaper on a leased cell owns them. `
        + `${reclaimPaths(fenceRefused)}: ${fenceRefused.join(', ')}`,
      )
    }

    if (pending.length > 0) {
      undeletedTotal += pending.length
      // Named, at error level, while the failed fork is still on screen. The
      // counter is for an alert; this line is for the person reading the log,
      // who otherwise cannot tell a clean rollback from one that left half a
      // landscape behind — and which net each document is on, because that
      // depends on its name and not on this process (see the docblock).
      console.error(
        `forkRoot rollback: ${pending.length} of ${ids.length} document(s) remain DURABLE`
        + `${budgetExhausted ? ' (wall-clock budget exhausted)' : ''}`
        + `. ${reclaimPaths(pending)}: ${pending.join(', ')}`,
      )
    }

    return {
      attempted: ids.length,
      removed: ids.length - pending.length - fenceRefused.length,
      undeleted: pending,
      fenceRefused,
      budgetExhausted,
    }
  } catch (error) {
    // The contract above, enforced rather than asserted — and COUNTED: a
    // rollback that aborted before its durable pass has, for the operator,
    // left every document behind, whatever a partial pass happened to remove.
    // A synchronous throw from the middle of a `group.map` leaves the promises
    // created for the earlier ids of that chunk in flight and un-awaited —
    // which is why the counter here is a ceiling and the log says "may".
    undeletedTotal += ids.length
    console.error(
      `forkRoot rollback: aborted by an unexpected error; all ${ids.length} document(s) may remain DURABLE`
      + ` (${reclaimPaths(ids)}): ${ids.join(', ')}`,
      error,
    )
    return {
      attempted: ids.length,
      removed: 0,
      undeleted: ids,
      fenceRefused: [],
      budgetExhausted: Date.now() >= deadline,
    }
  }
}

/** Which net each residue is on, by its NAME — the one thing about a document
 *  this process can still read after it has failed to remove it. */
function reclaimPaths(ids: readonly string[]): string {
  const minted = ids.filter((id) => isMintedDocumentId(id)).length
  const legacy = ids.length - minted
  return `${minted} minted -> the minted-orphan reaper (about an hour), `
    + `${legacy} legacy -> gcOrphanedDocs (24-48 h); not this process`
}

/** TEST SEAM. The counter is process-wide, so a suite asserting on it needs a
 *  known starting point — otherwise the first arm's residue decides the
 *  second's verdict. Same reasoning as `resetServerCreationPlacementForTest`. */
export function resetForkRollbackCountersForTest(): void {
  undeletedTotal = 0
}

/**
 * The residue reaches an operator.
 *
 * Read as a DELTA, never as an absolute: nothing resets it, so a value depends
 * on how long the process has been up. A COUNTER rather than a gauge because
 * it only ever rises and `increase()` is the question an alert asks — the same
 * distinction `serverCreationPlacementMetricSamples` documents.
 *
 * ONE counter, deliberately: there is no metric for "pending save could not
 * be disarmed", because this module cannot compute it (see the docblock), and
 * a metric that counts a guess is a number an alert will trust.
 */
export function forkRollbackMetricSamples(): MetricSample[] {
  return [
    {
      name: 'maplespire_fork_rollback_undeleted_documents_total',
      help: 'Documents a failed fork\'s rollback could not remove or did not reach (typically the pool exhaustion that failed the fork, its wall-clock budget, or an unexpected error in the rollback itself). They are unreachable from any version. Which net reclaims one depends on its id: a workspace-bound minted id (created while this process had a mint key and the documents-registration hook) is the minted-orphan reaper\'s, about an hour; a legacy random id (AUTH=off) is gcOrphanedDocs\', 24-48 h. The fork log names the ids and says which. Non-zero means a fork failed AND its cleanup failed. This counter says nothing about documents written back by an Automerge save armed before the failure — nothing can count those at rollback time.',
      type: 'counter',
      values: [{ value: undeletedTotal }],
    },
  ]
}
