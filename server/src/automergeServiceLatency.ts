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
 * How long the server takes to bring ONE peer up to date on ONE document —
 * measured where every client is already observable.
 *
 * ── Why it is measured HERE ──────────────────────────────────────────────────
 * The client-side walls (`progressBudget.ts`, `waiverBudget.ts`) each carry an
 * early warning, but both are readable only from the tab they happened in:
 * there is no client→server telemetry channel (and building one would need
 * consent, retention and privacy handling). The quantity a boot dies on is
 * "how long until this peer has this document", and the server, doing the
 * serving, knows both ends of it — for every client, with no new channel.
 *
 * ── The definition, and what makes it honest ────────────────────────────────
 * A document is IN SERVICE for a peer from the first sync exchange in which
 * the peer is NOT yet caught up, until the first exchange in which it is. That
 * is deliberately not "from the client's request": the server cannot see a
 * request that never arrived, and counting only what it can see is the
 * difference between a measurement and a story.
 *
 * `pendingOldestMs` is the reading that MOVES FIRST, and it is the server-side
 * twin of the client's `maxExtendedMs`: a document outstanding for a peer for
 * longer than the client's own wall (120 000 ms by default) is a boot that is
 * about to fail, observed before the user sees it. Percentiles describe the
 * healthy population; the maximum and the oldest pending describe the tail,
 * and the tail is what fails.
 *
 * ── Bounded, and privacy-minimized like its neighbours ──────────────────────
 * Peer and document identifiers never leave this process: `snapshot()` exposes
 * cardinalities and durations only, exactly as `synchronizerPeerSnapshot`
 * does. The pending map is capped, and the cap is REPORTED (`overflow`) rather
 * than silently truncating — a limit nobody can see is a limit that turns a
 * measurement into a guess.
 */

/** Latency samples retained for the quantiles. The tail is what matters and
 * 1 024 resolves a p95 comfortably; unbounded retention on a hot path would be
 * an instrument that grows with the thing it measures. */
const SAMPLE_LIMIT = 1_024

/** Documents-in-service tracked at once. A peer that legitimately syncs
 * thousands of documents is a real shape here (a projector attaches to a whole
 * workspace), so the cap is generous — and exceeding it increments `overflow`
 * rather than dropping silently. */
const PENDING_LIMIT = 8_192

/**
 * Past this, an entry is not "in service" — it is STUCK, and it must stop
 * dominating `pendingOldestMs`.
 *
 * On an IDLE stack a peer (e.g. an in-process subscriber, not a boot) can enter
 * service on a document and never catch up, so without this cut-off
 * `pending_oldest` would only ever rise and stop meaning anything.
 *
 * 10 minutes is five times the longest client wall (`BOOT_RESOLVE_MAX_MS`,
 * 120 000 ms), so nothing above it is a boot anyone is still waiting for.
 * Those entries are COUNTED (`abandoned`), never silently dropped: a peer that
 * attaches and never catches up is a finding, just not this one.
 */
const ABANDONED_AFTER_MS = 600_000

export interface ServiceLatencySnapshot {
  /** Completed services since process start. */
  completed: number
  /** Documents currently in service for some peer. */
  pending: number
  /** Age of the OLDEST in-service document, ms. The early warning: compare it
   * against the client's own wall. 0 with nothing pending. */
  pendingOldestMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  /** Services that could not be tracked because `PENDING_LIMIT` was reached.
   * Non-zero means the percentiles below describe a SUBSET. */
  overflow: number
  /** Entries that passed `ABANDONED_AFTER_MS` without ever catching up. Not a
   * latency — a peer that attached and never converged. Counted so it cannot
   * masquerade as a slow service. */
  abandoned: number
}

interface PendingEntry {
  startedAt: number
}

export class ServiceLatencyTracker {
  readonly #pending = new Map<string, PendingEntry>()
  #samples: number[] = []
  #completed = 0
  #overflow = 0
  #maxMs = 0
  #abandoned = 0
  readonly #now: () => number

  /** `now` is injected so the tests own the clock — a latency tracker verified
   * against the wall clock verifies the test runner's scheduling, not itself. */
  constructor(now: () => number = () => Date.now()) {
    this.#now = now
  }

  /** Peer/document pairs are joined with a NUL, which cannot occur in either
   * (both are base58). `\u0000` written as an escape on purpose: a raw NUL in
   * source makes the file binary to git and to every search tool — the repo
   * has an executable guard for exactly this (`scripts/source-nul.mjs`). */
  static key(peerId: string, documentId: string): string {
    return `${peerId}\u0000${documentId}`
  }

  /**
   * One sync exchange happened for this peer and document. `caughtUp` is the
   * server's own verdict — the peer's shared heads cover the document's heads.
   *
   * Idempotent on both edges: repeated `caughtUp: false` keeps the ORIGINAL
   * start (the service began at the first one, not the latest), and a
   * `caughtUp: true` with nothing pending is not a completion of anything and
   * is ignored. Without the first rule a chatty exchange would reset the clock
   * and the metric would report ~0 forever, which is the failure mode this
   * class exists to make impossible.
   */
  observe(peerId: string, documentId: string, caughtUp: boolean): void {
    const key = ServiceLatencyTracker.key(peerId, documentId)
    if (caughtUp) {
      const entry = this.#pending.get(key)
      if (!entry) return
      this.#pending.delete(key)
      this.#completed += 1
      const elapsed = Math.max(0, this.#now() - entry.startedAt)
      if (elapsed > this.#maxMs) this.#maxMs = elapsed
      this.#samples.push(elapsed)
      if (this.#samples.length > SAMPLE_LIMIT) this.#samples = this.#samples.slice(-SAMPLE_LIMIT)
      return
    }
    if (this.#pending.has(key)) return
    if (this.#pending.size >= PENDING_LIMIT) {
      this.#overflow += 1
      return
    }
    this.#pending.set(key, { startedAt: this.#now() })
  }

  /** A peer went away. Its in-service documents are neither complete nor still
   * being served, so they leave the pending set WITHOUT producing a sample: a
   * disconnect that counted as a completion would report the fastest possible
   * service for the case that served nothing at all. */
  forgetPeer(peerId: string): void {
    const prefix = `${peerId}\u0000`
    for (const key of this.#pending.keys()) {
      if (key.startsWith(prefix)) this.#pending.delete(key)
    }
  }

  snapshot(): ServiceLatencySnapshot {
    const sorted = [...this.#samples].sort((a, b) => a - b)
    const now = this.#now()
    let oldest = 0
    for (const [key, entry] of this.#pending) {
      const age = Math.max(0, now - entry.startedAt)
      // Retired, not forgotten. Leaving it in would make `pendingOldestMs` a
      // gauge that only ever rises; dropping it silently would lose the fact
      // that a peer never converged.
      if (age >= ABANDONED_AFTER_MS) {
        this.#pending.delete(key)
        this.#abandoned += 1
        continue
      }
      if (age > oldest) oldest = age
    }
    return {
      completed: this.#completed,
      pending: this.#pending.size,
      pendingOldestMs: oldest,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maxMs: this.#maxMs,
      overflow: this.#overflow,
      abandoned: this.#abandoned,
    }
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? 0
}

/**
 * Is this peer caught up on this document? Both arguments must be in the SAME
 * head space, and on this codebase that means the RAW one.
 *
 * Exported so the encoding is tested: `DocHandle.heads()` is bs58check
 * (`encodeHeads(...)`), while `syncState.sharedHeads` is raw hex (what
 * `DocSynchronizer` compares via `A.getHeads(fullDoc())`). Two representations
 * of the same heads never intersect, so mixing them makes this predicate false
 * for ever and the metric report a permanent emergency.
 */
export function isCaughtUp(
  documentHeads: readonly string[],
  sharedHeads: readonly string[],
): boolean {
  // No heads means the server has nothing to give; that is not a service
  // anybody is waiting on, and calling it "caught up" would complete a
  // service that never started.
  if (documentHeads.length === 0) return false
  const shared = new Set(sharedHeads)
  return documentHeads.every((head) => shared.has(head))
}

/** The process-wide tracker the sync server feeds and `/metrics` reads. */
export const serviceLatency = new ServiceLatencyTracker()
