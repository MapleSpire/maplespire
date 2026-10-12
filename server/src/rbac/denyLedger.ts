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
 * THE SECOND INVARIANT OF THE SYNC AUTHORIZATION BOUNDARY
 *
 *   Every deny that could later become an allow must be paired with an eventual
 *   `Repo.shareConfigChanged()`.
 *
 * automerge-repo resolves the share policy ONCE per (document, peer), at
 * `DocSynchronizer.#activatePeer`, and stores the answer in
 * `peer.sharePolicyState`. A peer recorded as `denied` is skipped thereafter and
 * its subsequent changes are DISCARDED. The only thing that recomputes it is
 * `reevaluateSharePolicy`, reachable solely from `Repo.shareConfigChanged()`.
 *
 * So a deny is not a moment, it is a state — and one that outlives whatever
 * caused it. If the index was merely lagging, the user's document stops syncing
 * for the life of the socket and nothing in the logs says so: the write looks
 * accepted client-side, the server discards it, and a page reload "fixes" it.
 *
 * Any `return false` on the sync path is a candidate for this failure: eviction
 * paths, re-walks that admit silently, walks that bail after admitting, gates
 * that reject rather than deny. The ledger enforces the invariant structurally:
 * a recoverable deny is RECORDED, and while anything is outstanding a
 * re-evaluation keeps being requested until the entry drains or is written
 * off, so correctness does not depend on each deny site remembering.
 *
 * WHAT THIS DOES NOT DO. The ledger guarantees a repair is not WASTED. It does
 * not guarantee a repair HAPPENS. Re-running the share policy against a
 * still-broken index just denies again, which is why the index's own repair
 * paths (`scheduleWorkspaceRouteBackfill`, the stale-repair pass, the walk-level
 * announcement) still have to be correct. This is the safety net, not the fix.
 */

import type { WorkspaceKey } from './docScope.js'

/**
 * Why a document was denied — and, decisively, whether that denial could ever
 * be reversed by a later re-evaluation.
 *
 * Classifying is not a nicety. Recording a PERMANENT denial would leave an entry
 * that can never drain, and the reconciliation loop would then re-run the share
 * policy across every document and peer, forever, for a document that is
 * correctly refused. The rule is: record only what a repair could change.
 */
export type DenyReason =
  /** The document is not in the index yet. A repair, or the peer uploading its
   * parent, can change this — the single most common recoverable case. */
  | 'unindexed-document'
  /** Denied on a stale read, then indexed before the log line resolved. Already
   * recoverable by definition: the index now agrees the peer may have it. */
  | 'indexed-after-denial'
  /** The gate itself failed (a database fault). Says nothing about the peer's
   * rights, so it must not be allowed to harden into a refusal. */
  | 'gate-fault'
  /** The document belongs to a different workspace. Correct, and permanent. */
  | 'workspace-mismatch'
  /** No route bound for the peer. Binding happens before the socket emits any
   * document message, so reaching this means something is wrong that a
   * re-evaluation cannot fix. */
  | 'missing-peer-route'
  /** No RBAC grant. Changing it changes the session's epoch, which forces a
   * reconnect and a fresh share-policy resolution anyway. */
  | 'rbac'
  /** A server-owned manifest the browser may never write. Permanent by design. */
  | 'server-managed-root'

const RECOVERABLE: ReadonlySet<DenyReason> = new Set<DenyReason>([
  'unindexed-document',
  'indexed-after-denial',
  'gate-fault',
])

export function isRecoverableDeny(reason: DenyReason): boolean {
  return RECOVERABLE.has(reason)
}

/**
 * Denies the SERVER cannot retry but a CLIENT can still lift.
 *
 * `isRecoverableDeny` answers "should the reconciliation loop keep fanning out
 * for this?"; the release guard needs "is a peer still waiting on this
 * document?". For every reason but `workspace-mismatch` the two coincide. For
 * that one they do not, and the gap is a data-loss path:
 *
 *  - the deny is permanent SERVER-side, so nothing is recorded, so
 *    `mayReleaseDocument` would return true, and the projector may call
 *    `releaseUnavailableDocument` → `removeFromCache` → `CollectionSynchronizer.detach`,
 *    which is terminal;
 *  - but it is liftable CLIENT-side: a tab canonicalised onto the wrong version
 *    pins itself back to the concrete one and re-presents the same documents on
 *    a socket the gate accepts. Detaching first destroys that recovery.
 *
 * So this set feeds the guard ONLY. It deliberately does not make the reason
 * recoverable: fanning `shareConfigChanged()` out for it would retry into a
 * hole the server cannot fill.
 */
const CLIENT_LIFTABLE: ReadonlySet<DenyReason> = new Set<DenyReason>([
  'workspace-mismatch',
])

export function isClientLiftableDeny(reason: DenyReason): boolean {
  return CLIENT_LIFTABLE.has(reason)
}

export interface DenyLedgerSnapshot {
  outstanding: number
  /** Reconciliation passes that actually fanned out (an idle tick is not one). */
  reconciliations: number
  /** Entries written off after `maxReconciliations` without draining. */
  expired: number
  /** Entries refused because the ledger was at `maxOutstanding`. */
  dropped: number
  byReason: Record<string, number>
  oldestAgeMs: number | null
}

export interface DenyLedgerOptions {
  /** Request a share-policy re-evaluation. Expected to be debounced by the
   * caller — `shareConfigChanged()` re-runs the policy for every document and
   * peer, so a burst must collapse into one fan-out. */
  onReevaluate: () => void
  /** Optional: also nudge the index to repair a workspace that has outstanding
   * denials, since re-evaluating against an unrepaired index just re-denies. */
  scheduleRepair?: (key: WorkspaceKey) => void
  clock?: () => number
  /** How often to reconcile, in ms (default 30 s). Injectable so tests drive
   * reconciliation explicitly instead of out-running a fixed window. */
  reconcileMs?: number
  /** Hard bound. A peer can drive denials at will, so the ledger must not be a
   * memory amplifier for a hostile or broken client. */
  maxOutstanding?: number
  /** After this many fruitless reconciliations an entry is written off: the
   * deny is evidently not recoverable, whatever it claimed. Without this a
   * single stuck document would keep the fan-out running forever. */
  maxReconciliations?: number
  /** Injected so tests do not depend on real timers. */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void }
}

export interface DenyLedger {
  /**
   * Note a deny. Permanent reasons are not recorded — and any outstanding entry
   * for that pair is cleared, because the newer verdict supersedes it.
   */
  recordDeny(peerId: string, documentId: string, reason: DenyReason, workspace: WorkspaceKey | null | undefined): void
  /** The pair is allowed (or permanently refused): stop tracking it. */
  clear(peerId: string, documentId: string): void
  /** A disconnected peer's verdicts die with its socket. */
  forgetPeer(peerId: string): void
  /**
   * Is a peer still REFUSED on this document for a reason it can lift itself?
   *
   * Separate from `hasOutstandingDocument` on purpose — see `CLIENT_LIFTABLE`.
   * Both feed the projector's release guard; only the former drives retries.
   */
  hasClientLiftableDeny(documentId: string): boolean
  /**
   * Is ANY peer's recoverable deny for this document still outstanding?
   *
   * Exists for the projector's release guard. A document in this state is
   * unresolvable BECAUSE it was refused, so retrying its resolution is futile
   * until the deny is lifted — and the release that retry performs
   * (`removeFromCache` -> `CollectionSynchronizer.detach`) destroys the very
   * synchronizer `shareConfigChanged()` must traverse to lift it, after which
   * the lift delivers nothing.
   */
  hasOutstandingDocument(documentId: string): boolean
  /** Run a reconciliation now. Exposed for tests and for an operator endpoint;
   * the interval calls exactly this. */
  reconcile(): void
  snapshot(): DenyLedgerSnapshot
  stop(): void
}

interface Entry {
  peerId: string
  documentId: string
  reason: DenyReason
  workspace: WorkspaceKey | null
  recordedAt: number
  reconciliations: number
}

const DEFAULT_RECONCILE_MS = 30_000
const DEFAULT_MAX_OUTSTANDING = 10_000
const DEFAULT_MAX_RECONCILIATIONS = 5

function defaultSchedule(fn: () => void, ms: number): { cancel: () => void } {
  const timer = setInterval(fn, ms)
  timer.unref?.()
  return { cancel: () => clearInterval(timer) }
}

export function createDenyLedger(options: DenyLedgerOptions): DenyLedger {
  const clock = options.clock ?? Date.now
  const reconcileMs = options.reconcileMs ?? DEFAULT_RECONCILE_MS
  const maxOutstanding = options.maxOutstanding ?? DEFAULT_MAX_OUTSTANDING
  const maxReconciliations = options.maxReconciliations ?? DEFAULT_MAX_RECONCILIATIONS
  const schedule = options.schedule ?? defaultSchedule

  const outstanding = new Map<string, Entry>()
  /**
   * documentId -> how many peers' denies are outstanding for it.
   *
   * Maintained alongside `outstanding` rather than derived by scanning it,
   * because the one caller is the projector's release guard on the
   * resolution-FAILURE path — which is exactly where a workspace under load
   * spends its time. Scanning a map bounded by `maxOutstanding` on every attempt
   * would be too costly there.
   *
   * Every mutation of `outstanding` goes through `addEntry`/`removeEntry` so the
   * two cannot drift; a bare `.set`/`.delete` on `outstanding` is a defect.
   */
  const byDocument = new Map<string, number>()
  /**
   * documentId -> the peers currently refused on it for a CLIENT-LIFTABLE
   * reason. Peers, not a count, because the same peer re-presenting the same
   * document must not inflate it — a count would never fall back to zero and
   * the guard would pin the document for the life of the process.
   *
   * Bounded by the same `maxOutstanding` knob and failing OPEN at the ceiling:
   * past it the guard stops protecting rather than wedging the projector.
   */
  const liftableByDocument = new Map<string, Set<string>>()
  let liftableCount = 0
  let reconciliations = 0
  let expired = 0
  let dropped = 0

  const keyFor = (peerId: string, documentId: string): string => `${peerId}\u0000${documentId}`

  const addEntry = (key: string, entry: Entry): void => {
    outstanding.set(key, entry)
    byDocument.set(entry.documentId, (byDocument.get(entry.documentId) ?? 0) + 1)
  }

  const noteLiftable = (peerId: string, documentId: string): void => {
    const peers = liftableByDocument.get(documentId)
    if (peers) {
      if (!peers.has(peerId)) { peers.add(peerId); liftableCount += 1 }
      return
    }
    if (liftableCount >= maxOutstanding) return
    liftableByDocument.set(documentId, new Set([peerId]))
    liftableCount += 1
  }

  const forgetLiftable = (peerId: string, documentId: string): void => {
    const peers = liftableByDocument.get(documentId)
    if (!peers?.delete(peerId)) return
    liftableCount -= 1
    if (peers.size === 0) liftableByDocument.delete(documentId)
  }

  const forgetLiftablePeer = (peerId: string): void => {
    for (const [documentId, peers] of liftableByDocument) {
      if (!peers.delete(peerId)) continue
      liftableCount -= 1
      if (peers.size === 0) liftableByDocument.delete(documentId)
    }
  }

  const removeEntry = (key: string): void => {
    const entry = outstanding.get(key)
    if (!entry) return
    outstanding.delete(key)
    const remaining = (byDocument.get(entry.documentId) ?? 1) - 1
    if (remaining <= 0) byDocument.delete(entry.documentId)
    else byDocument.set(entry.documentId, remaining)
  }

  const ledger: DenyLedger = {
    recordDeny(peerId, documentId, reason, workspace) {
      const key = keyFor(peerId, documentId)
      // Tracked BEFORE the recoverable branch returns: a client-liftable deny is
      // permanent by that branch's definition and would otherwise leave here
      // having recorded nothing at all (see CLIENT_LIFTABLE).
      if (isClientLiftableDeny(reason)) noteLiftable(peerId, documentId)
      else forgetLiftable(peerId, documentId)
      if (!isRecoverableDeny(reason)) {
        const superseded = outstanding.get(key)
        // ...with one exception. A gate that failed CLOSED returns a bare
        // `false`, and the caller then classifies that verdict — usually as
        // 'rbac', because the document is still perfectly well indexed and only
        // the grant lookup was unavailable. That classification is DERIVED from
        // the faulted decision, so it is not evidence about the peer's rights
        // and must not evict the fault that produced it; otherwise failing
        // closed would silently cancel the re-evaluation pairing.
        if (superseded?.reason === 'gate-fault') return
        // Otherwise a permanent verdict supersedes an earlier recoverable one:
        // the pair is now refused for a reason no repair addresses, and leaving
        // the old entry would keep the fan-out alive on its behalf.
        removeEntry(key)
        return
      }
      const existing = outstanding.get(key)
      if (existing) {
        // Keep `recordedAt` and the reconciliation count: a peer that retries
        // the same document every second must not be able to reset its own
        // write-off clock and pin the entry in the ledger indefinitely.
        existing.reason = reason
        if (workspace) existing.workspace = workspace
        return
      }
      if (outstanding.size >= maxOutstanding) {
        dropped += 1
        return
      }
      addEntry(key, {
        peerId,
        documentId,
        reason,
        workspace: workspace ?? null,
        recordedAt: clock(),
        reconciliations: 0,
      })
    },

    clear(peerId, documentId) {
      removeEntry(keyFor(peerId, documentId))
      // The pair is allowed now, so the refusal the guard was protecting is
      // over. Without this the document stays pinned until the peer leaves.
      forgetLiftable(peerId, documentId)
    },

    forgetPeer(peerId) {
      for (const [key, entry] of outstanding) {
        if (entry.peerId === peerId) removeEntry(key)
      }
      // A peer that is gone is not waiting on anything. Leaving its refusals
      // behind would pin their documents against release forever.
      forgetLiftablePeer(peerId)
    },

    hasOutstandingDocument(documentId) {
      return (byDocument.get(documentId) ?? 0) > 0
    },

    hasClientLiftableDeny(documentId) {
      return (liftableByDocument.get(documentId)?.size ?? 0) > 0
    },

    reconcile() {
      // An idle tick must be free. This is what makes a 30 s interval acceptable
      // in a process that is otherwise doing nothing.
      if (outstanding.size === 0) return

      const workspaces = new Map<string, WorkspaceKey>()
      for (const [key, entry] of outstanding) {
        entry.reconciliations += 1
        if (entry.reconciliations > maxReconciliations) {
          removeEntry(key)
          expired += 1
          continue
        }
        if (entry.workspace) {
          workspaces.set(`${entry.workspace.landscapeId}/${entry.workspace.versionId}`, entry.workspace)
        }
      }

      if (outstanding.size === 0 && workspaces.size === 0) return

      reconciliations += 1
      // Repair first, then re-evaluate: re-running the share policy against an
      // index that has not been repaired just reproduces the same denials.
      // Both are fire-and-forget — this runs on a timer, not on the sync path,
      // but the gate-liveness invariant still says never await a document here.
      if (options.scheduleRepair) {
        for (const workspace of workspaces.values()) {
          try {
            options.scheduleRepair(workspace)
          } catch (error) {
            console.warn('[denyLedger] repair scheduling failed for', workspace, error)
          }
        }
      }
      try {
        options.onReevaluate()
      } catch (error) {
        console.warn('[denyLedger] share-policy re-evaluation request failed:', error)
      }
    },

    snapshot() {
      const byReason: Record<string, number> = {}
      let oldest: number | null = null
      const now = clock()
      for (const entry of outstanding.values()) {
        byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1
        const age = now - entry.recordedAt
        if (oldest === null || age > oldest) oldest = age
      }
      return {
        outstanding: outstanding.size,
        reconciliations,
        expired,
        dropped,
        byReason,
        oldestAgeMs: oldest,
      }
    },

    stop() {
      handle.cancel()
      // Clear EVERY index, not just `outstanding`: this path bypasses
      // `removeEntry`, and the projector's release guard
      // (`documentReleaseGuard.ts`) reads both `byDocument` and
      // `liftableByDocument`. A stopped ledger must report no refusals. Any new
      // index added to this object must be cleared here too — `liftableCount`
      // included: left behind, it keeps counting peers that are no longer in the
      // map, and at the ceiling `noteLiftable` refuses every new document.
      outstanding.clear()
      byDocument.clear()
      liftableByDocument.clear()
      liftableCount = 0
    },
  }

  const handle = schedule(() => ledger.reconcile(), reconcileMs)
  return ledger
}
