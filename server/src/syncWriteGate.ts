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

import { decodeSyncMessage } from '@automerge/automerge'

/**
 * WRITE enforcement at the Automerge sync boundary.
 *
 * automerge-repo has exactly ONE per-doc gate — `shareConfig.access` — and its
 * `CollectionSynchronizer` treats it as a READ/serve decision: once `access`
 * returns true, `docSynchronizer.receiveMessage(message)` applies whatever
 * changes the message's sync payload carries, persists them through the storage
 * adapter, and relays them to every other connected peer. There is no
 * read/write distinction anywhere in the library, so without this gate a
 * session whose only RBAC grant is a read-only ("View") team grant could edit
 * any diagram it could see: the sync path would never consult `can_write`.
 *
 * We can't refuse ALL sync traffic from read-only peers — the Automerge sync
 * protocol is symmetric, and a purely-reading client still SENDS `sync`
 * messages (bloom filter + heads exchanges) to receive the doc. The only
 * reliable write signal is inside the payload: a sync message that carries
 * `changes` is a mutation attempt; one that doesn't is read-path handshake.
 * So the gate:
 *
 *   1. passes every non-doc message through untouched (join/leave/ephemeral);
 *   2. for `sync`/`request` messages, asks the raw RBAC write check
 *      (`buildWriteCheck` in rbac/docScope.ts) — writable peers pass without
 *      their payload ever being decoded (hot-path cost: one cached set lookup);
 *   3. for NON-writable peers only, decodes the Automerge sync payload:
 *      change-free messages pass (reads stay alive), change-carrying messages
 *      are DROPPED at stage 'on' (never applied, never persisted, never
 *      relayed) and logged-but-allowed at stage 'dual'. A payload that fails
 *      to decode from a peer under scrutiny counts as a write attempt (fail
 *      closed).
 *
 * Dropping (vs closing the socket) is deliberate: the read side of the
 * connection stays fully functional, and an honest client never hits this
 * path at all — the client UI locks itself read-only from
 * `/api/me/workspace-access`. Only a tampered/stale client keeps re-offering
 * the same changes, and each offer dies here. Messages are processed through
 * a per-socket FIFO so the async permission lookup can never reorder one
 * connection's doc messages.
 */

/** Structural subset of automerge-repo's decoded wire messages this gate
 * inspects — declared locally so this module needs no type import from the
 * network package (its message unions aren't exported in a convenient shape). */
export interface GateMessage {
  type: string
  senderId: string
  documentId?: string
  data?: Uint8Array
}

/** `(peerId, documentId) -> may WRITE?` — the raw RBAC verdict
 * (`buildWriteCheck`); unknown peer / unindexed doc must answer false. */
export type WriteCheck = (peerId: string, documentId: string) => Promise<boolean>

/**
 * True when a `sync`/`request` message's Automerge payload carries changes —
 * i.e. it would MUTATE the server's doc if applied. Change-free sync messages
 * (bloom/heads handshakes, requests for the doc) return false. A payload that
 * cannot be decoded returns true: this function is only consulted for peers
 * that already failed the write check, and an undecodable payload from such a
 * peer must not reach the synchronizer (fail closed).
 */
export function messageCarriesChanges(message: GateMessage): boolean {
  if (message.type !== 'sync' && message.type !== 'request') return false
  const data = message.data
  if (!data || data.byteLength === 0) return false
  try {
    return decodeSyncMessage(data).changes.length > 0
  } catch {
    return true
  }
}

/**
 * The denial/fault log throttle: at most one `true` per (key, window). Both
 * failure directions matter and are pinned by test: always-true spams one
 * line per message from a stale client re-offering the same change every sync
 * round (noise burying signal); always-false silences the only visible trace
 * of a refused write. The map is bounded by wholesale clear — it is only a throttle,
 * losing it costs one extra log line, never a verdict.
 */
export function throttledOnce(
  seenAt: Map<string, number>,
  key: string,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  if (now - (seenAt.get(key) ?? 0) < windowMs) return false
  if (seenAt.size > 1_000) seenAt.clear()
  seenAt.set(key, now)
  return true
}

export interface SyncWriteGateOptions {
  /** Live AUTH stage — read per message so a runtime flip takes effect immediately. */
  stage: () => 'off' | 'dual' | 'on'
  canWrite: WriteCheck
  /** Called once per denied (or dual would-deny) write attempt — caller owns
   * throttling/audit. `enforced` is false under 'dual' (message still passed). */
  onDenied?: (info: { peerId: string; documentId: string; enforced: boolean }) => void
}

export interface SyncWriteGate {
  /**
   * Run one decoded message through the gate. `deliver` forwards it to the
   * repo (the caller's `super.emit`); it is invoked for every allowed message,
   * in arrival order per `socketKey`, and never invoked for a dropped one.
   * Non-doc messages deliver synchronously (no queue hop).
   */
  process(message: GateMessage, socketKey: object, deliver: () => void): void
}

export function createSyncWriteGate(opts: SyncWriteGateOptions): SyncWriteGate {
  // Per-socket FIFO: chain each doc message onto the socket's tail promise so
  // the async write check preserves one connection's message order. Keyed by
  // the socket object itself (WeakMap — entries die with the connection).
  const tails = new WeakMap<object, Promise<void>>()

  const decide = async (message: GateMessage, deliver: () => void): Promise<void> => {
    const stage = opts.stage()
    if (stage === 'off') {
      deliver()
      return
    }
    const documentId = String(message.documentId)
    let allowed: boolean
    try {
      allowed = await opts.canWrite(message.senderId, documentId)
    } catch (err) {
      // A broken permission lookup must not let writes through — treat as
      // not-writable and let the payload inspection decide (reads survive).
      console.warn('[syncWriteGate] write check failed (treating as not writable):', err)
      allowed = false
    }
    if (allowed) {
      deliver()
      return
    }
    if (!messageCarriesChanges(message)) {
      // Read-path handshake from a read-only peer — exactly what View means.
      deliver()
      return
    }
    // A change-carrying message from a peer with no write grant.
    if (stage === 'dual') {
      opts.onDenied?.({ peerId: message.senderId, documentId, enforced: false })
      deliver()
      return
    }
    opts.onDenied?.({ peerId: message.senderId, documentId, enforced: true })
    // stage 'on': dropped — never reaches the synchronizer.
  }

  return {
    process(message, socketKey, deliver) {
      if ((message.type !== 'sync' && message.type !== 'request') || message.documentId == null) {
        deliver()
        return
      }
      const tail = tails.get(socketKey) ?? Promise.resolve()
      const next = tail
        .then(() => decide(message, deliver))
        .catch((err) => {
          // decide() already contains its own failure handling; this is the
          // last-resort guard so one poisoned message can't wedge the queue.
          console.error('[syncWriteGate] unexpected gate failure (message dropped):', err)
        })
      tails.set(socketKey, next)
    },
  }
}
