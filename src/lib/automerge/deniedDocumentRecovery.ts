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

import { initSyncState } from '@automerge/automerge'
import type { DocumentId, PeerId, Repo } from '@automerge/automerge-repo'

/**
 * Recovery for a document the sync gate REFUSED and whose refusal can no longer
 * be lifted from the server side.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * The route gate denies a document it cannot place. automerge-repo caches that
 * verdict per (document, peer) and discards the peer's changes, so the only lift
 * is `Repo.shareConfigChanged()` -> `reevaluateDocumentShare()`. That iterates
 * `Object.values(#docSynchronizers)` and then each one's `#peers` — and the
 * read-model projector, *because the deny made the document unresolvable*,
 * retries it and on every attempt calls `releaseUnavailableDocument` ->
 * `repo.removeFromCache` -> `CollectionSynchronizer.detach`, which strips every
 * peer and deletes the synchronizer. The lift then fires into a hole: the index
 * is repaired and the lift fires, yet the document's wire history stays
 * `out:sync` then `in:doc-unavailable`, with no server->client sync frames on a
 * live socket.
 *
 * ── Why the fix is on the CLIENT, and why it is THIS ─────────────────────────
 * Nothing server-side rescues a detached document: the lift alone delivers in
 * ~30 ms, but after a detach it never delivers — not after re-attach, nor with
 * `announce: true`. What does work is the client RESETTING ITS SYNC STATE for
 * that (document, peer) — ~30 ms — and it keeps working when both sides persist
 * sync state (note the server's `loadSyncState` returns early with no
 * storageSubsystem, so only a storage-backed setup exercises that hazard).
 *
 * `syncAllPeers()` alone does NOT work, and that is the counter-intuitive part:
 * `#sendSyncMessage` calls `A.generateSyncMessage(doc, syncState)` and returns
 * on a null message, while the client's sync state still believes its first
 * frame is awaiting a reply. It therefore generates nothing. A page RELOAD heals
 * precisely because a new `Repo` means a new peer id and a fresh sync state;
 * this module does that one thing deliberately, per document.
 *
 * ── Why it cannot force the gate ────────────────────────────────────────────
 * `addPeer` mutates only the LOCAL `#peers` record. No field in a sync frame
 * sets a remote `sharePolicyState`; admission stays entirely receiver-side in
 * the server's `shareConfig`: with the deny left standing, the document stays
 * absent. Pinned by `server/src/rbac/shareConfigLift.seam.test.ts`.
 *
 * ── Why the trigger is a COUNT, not a single answer ──────────────────────────
 * `durable:false` is ambiguous: it also means "your heads have not reached the
 * server's Repo yet", which is the ordinary state one round after a write. Only
 * a run of consecutive refusals for the SAME document distinguishes a document
 * the server is refusing from one still in flight.
 */

/** A reset is not free — it costs a share-policy resolution and a sync frame on
 *  the server — and the server may be refusing forever. Every bound here exists
 *  so that a permanent refusal costs a bounded amount of traffic, not one
 *  request per round for the life of the tab. */
export interface DeniedRecoveryLimits {
  /** Consecutive `durable:false` answers for one document before the first
   *  re-presentation. Below this, the ordinary in-flight case would trigger it. */
  readonly failuresBeforeFirstRetry: number
  /** Re-presentations per document, ever. */
  readonly maxAttemptsPerDocument: number
  /** Backoff after the first attempt, doubling to `maxBackoffMs`. */
  readonly firstBackoffMs: number
  readonly maxBackoffMs: number
  /** Across every document, for the life of the session. A landscape whose
   *  server refuses everything must not turn into an unbounded frame source. */
  readonly maxAttemptsPerSession: number
}

export const DEFAULT_DENIED_RECOVERY_LIMITS: DeniedRecoveryLimits = {
  failuresBeforeFirstRetry: 3,
  maxAttemptsPerDocument: 6,
  firstBackoffMs: 2_000,
  maxBackoffMs: 60_000,
  maxAttemptsPerSession: 200,
}

interface DocumentRecoveryState {
  consecutiveFailures: number
  attempts: number
  nextEligibleAt: number
  exhaustedReported: boolean
}

export interface DeniedRecoverySnapshot {
  tracked: number
  attemptsThisSession: number
  exhausted: number
}

/**
 * Bookkeeping only — it performs no I/O and touches no repo. Kept separate from
 * the reset itself so the decision rules are testable without a socket.
 */
export class DeniedDocumentRecovery {
  private readonly states = new Map<DocumentId, DocumentRecoveryState>()
  private attemptsThisSession = 0
  // Declared, not a constructor parameter property: `erasableSyntaxOnly` is on
  // in tsconfig.app.json and rejects those (TS1294).
  private readonly limits: DeniedRecoveryLimits

  constructor(limits: DeniedRecoveryLimits = DEFAULT_DENIED_RECOVERY_LIMITS) {
    this.limits = limits
  }

  /** The server answered, and this document is STILL pending. */
  noteUnacknowledged(documentId: DocumentId): void {
    const state = this.states.get(documentId) ?? {
      consecutiveFailures: 0,
      attempts: 0,
      nextEligibleAt: 0,
      exhaustedReported: false,
    }
    state.consecutiveFailures += 1
    this.states.set(documentId, state)
  }

  /** The server acknowledged it durable. Forget everything: a later refusal for
   *  the same document is a NEW episode and deserves its own full budget. */
  noteAcknowledged(documentId: DocumentId): void {
    this.states.delete(documentId)
  }

  /** Documents whose refusal looks real and whose backoff has elapsed. */
  dueDocuments(now: number): DocumentId[] {
    // The remaining budget bounds the LIST, not just entry to the loop: testing
    // the cap once per round would let a single round return every due document
    // and overshoot (7 pending against a cap of 5 would spend 7).
    const budget = this.limits.maxAttemptsPerSession - this.attemptsThisSession
    if (budget <= 0) return []
    const due: DocumentId[] = []
    for (const [documentId, state] of this.states) {
      if (state.consecutiveFailures < this.limits.failuresBeforeFirstRetry) continue
      if (state.attempts >= this.limits.maxAttemptsPerDocument) continue
      if (now < state.nextEligibleAt) continue
      due.push(documentId)
      if (due.length >= budget) break
    }
    return due
  }

  /** Record that a re-presentation was performed, and arm the next backoff. */
  noteAttempt(documentId: DocumentId, now: number): void {
    const state = this.states.get(documentId)
    if (!state) return
    state.attempts += 1
    this.attemptsThisSession += 1
    const backoff = Math.min(
      this.limits.firstBackoffMs * 2 ** (state.attempts - 1),
      this.limits.maxBackoffMs,
    )
    state.nextEligibleAt = now + backoff
  }

  /**
   * Documents that have spent their whole budget and are still not durable,
   * reported ONCE each.
   *
   * This is the visibility half: giving up silently here would leave a badge
   * holding "Saving…" forever while nothing is being retried.
   */
  drainExhausted(): DocumentId[] {
    const out: DocumentId[] = []
    for (const [documentId, state] of this.states) {
      if (state.attempts < this.limits.maxAttemptsPerDocument) continue
      if (state.exhaustedReported) continue
      state.exhaustedReported = true
      out.push(documentId)
    }
    return out
  }

  snapshot(): DeniedRecoverySnapshot {
    let exhausted = 0
    for (const state of this.states.values()) {
      if (state.attempts >= this.limits.maxAttemptsPerDocument) exhausted += 1
    }
    return { tracked: this.states.size, attemptsThisSession: this.attemptsThisSession, exhausted }
  }

  clear(): void {
    this.states.clear()
    this.attemptsThisSession = 0
  }
}

export interface DurableVerdictOutcome {
  /** Documents re-presented on this round, in the order they were attempted. */
  represented: DocumentId[]
  /** Documents that have just spent their whole budget, reported once each. */
  exhausted: DocumentId[]
}

/**
 * Apply one round of server verdicts and decide what to re-present.
 *
 * Kept out of `bridge.ts` so it can be tested: inline in
 * `runDurableAcknowledgement`, deleting the call or inverting its two branches
 * would go unnoticed, because the bridge is a singleton behind a socket and an
 * HTTP round. This decision is neither, so it lives where a fake `represent`
 * can exercise it.
 *
 * `represent` is injected for the same reason: the caller supplies
 * `resetDocumentSyncState(repo, id)`, and a test supplies a spy.
 */
export function applyDurableVerdicts(input: {
  /** The documents this round asked the server about. */
  sent: readonly DocumentId[]
  /** Of those, the ones the server did NOT acknowledge durable. */
  stillPending: ReadonlySet<DocumentId>
  recovery: DeniedDocumentRecovery
  represent: (documentId: DocumentId) => void
  now: number
}): DurableVerdictOutcome {
  for (const documentId of input.sent) {
    // Polarity, and it is the whole feature: STILL PENDING after an answered
    // round is the refusal signal; acknowledged is the all-clear that wipes the
    // document's state so a later refusal gets a full budget.
    if (input.stillPending.has(documentId)) input.recovery.noteUnacknowledged(documentId)
    else input.recovery.noteAcknowledged(documentId)
  }
  const represented: DocumentId[] = []
  for (const documentId of input.recovery.dueDocuments(input.now)) {
    input.represent(documentId)
    input.recovery.noteAttempt(documentId, input.now)
    represented.push(documentId)
  }
  return { represented, exhausted: input.recovery.drainExhausted() }
}

/**
 * Re-present one document to every connected peer by replacing this client's
 * sync state for it.
 *
 * No `as unknown as` anywhere: every hop is declared upstream
 * (`Repo.synchronizer: CollectionSynchronizer` -> `get docSynchronizers():
 * Record<DocumentId, DocSynchronizer>` and `get peers(): PeerId[]` ->
 * `DocSynchronizer.addPeer(peerId, Promise<SyncState | undefined>)`), so a
 * rename upstream breaks the build rather than turning this into a silent no-op.
 *
 * Returns the number of peers re-presented to, which is 0 when the document has
 * no synchronizer — that is not an error, it is the ordinary state for a
 * document nobody is syncing.
 */
export function resetDocumentSyncState(repo: Repo, documentId: DocumentId): number {
  const docSynchronizer = repo.synchronizer.docSynchronizers[documentId]
  if (!docSynchronizer) return 0
  let count = 0
  for (const peerId of repo.synchronizer.peers as readonly PeerId[]) {
    docSynchronizer.addPeer(peerId, Promise.resolve(initSyncState()))
    count += 1
  }
  return count
}
