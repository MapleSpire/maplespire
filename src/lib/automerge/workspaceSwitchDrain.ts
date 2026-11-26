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

import { acknowledgeDurableDocumentHeads, type DurableHeadAcknowledgement, type DurableHeadSnapshot } from './durableSync'
import type { WorkspaceRef } from './workspace'

/**
 * A WORKSPACE SWITCH DRAINS THE OUTGOING TRANSPORT FIRST (T-DIAGDEF).
 *
 * The socket is per workspace (`networkRoute.ts`): a switch removes the old
 * transport before the new one may announce anything. But the old session's
 * last writes are made by `stopBridge`'s lifecycle flush — a diagram deleted
 * while NOT open waits in the write debounce (150 ms), and a switch inside it
 * flushes the delete into the local registry shard in the same tick that
 * removed the socket. Automerge never got to send it: the change sat in the
 * browser, the server's `ro_diagrams` row stayed for as long as the user stayed
 * away (70 s in a manual test), and left 0.4–0.8 s after the return, when the
 * workspace's socket synced again. Measured on the stack: stuck 4/4 with the
 * switch ~190 ms after the delete, before and after the change that first
 * showed it — a PREEXISTING race that a slower manual timing happened to win.
 *
 * So before the route moves, the switch asks the OUTGOING workspace's server
 * whether the frontiers the stopped session still owed are durable
 * (`POST /api/automerge/durable-heads`, the badge's durability boundary), and
 * asks again — the old socket still routed, so the Repo's sync delivers them —
 * until they are, BOUNDED ({@link WORKSPACE_SWITCH_DRAIN_MS}). Past the bound,
 * or offline, nothing is lost: the persisted ledger re-presents the entries
 * the next time that workspace is opened (what happened before, for every
 * switch).
 */
export const WORKSPACE_SWITCH_DRAIN_MS = 3_000
export const WORKSPACE_SWITCH_DRAIN_POLL_MS = 100
/** A stall bound: answers AND server-known heads
 * unchanged this long — two answers at least — mean no progress is possible
 * (a write the server refuses for good). Longer than a sync round trip and a
 * server flush, so a drain still converging is never cut. */
export const WORKSPACE_SWITCH_DRAIN_STALL_MS = 1_000

export interface WorkspaceSwitchDrainOutcome {
  /** `unreachable`: offline, or the routed transport has no peer (nothing
   * can be sent); `stalled`: nothing moved for the stall window. */
  outcome: 'nothing-owed' | 'durable' | 'timeout' | 'unreachable' | 'stalled'
  documents: number
  pending: number
  asks: number
  elapsedMs: number
}

export async function drainOutgoingWorkspace(
  debt: { ref: WorkspaceRef; documents: readonly DurableHeadSnapshot[] } | null,
  options: {
    acknowledge?: (
      documents: readonly DurableHeadSnapshot[],
      options: { workspace: WorkspaceRef; signal?: AbortSignal },
    ) => Promise<DurableHeadAcknowledgement[]>
    timeoutMs?: number
    pollMs?: number
    stallMs?: number
    online?: () => boolean
    /** Whether the outgoing transport has a peer at all
     * (`hasConnectedSyncPeer`). Unknown: assumed connected. */
    connected?: () => boolean
    /** The heads the server is known to hold, per document
     * (`serverKnownHeads`); a change is progress. */
    serverHeads?: (documentIds: readonly string[]) => ReadonlyMap<string, readonly string[]>
  } = {},
): Promise<WorkspaceSwitchDrainOutcome> {
  const startedAt = Date.now()
  const documents = debt?.documents ?? []
  if (!debt || !documents.length) return { outcome: 'nothing-owed', documents: 0, pending: 0, asks: 0, elapsedMs: 0 }
  const acknowledge = options.acknowledge ?? acknowledgeDurableDocumentHeads
  const timeoutMs = options.timeoutMs ?? WORKSPACE_SWITCH_DRAIN_MS
  const pollMs = options.pollMs ?? WORKSPACE_SWITCH_DRAIN_POLL_MS
  const stallMs = options.stallMs ?? WORKSPACE_SWITCH_DRAIN_STALL_MS
  const online = options.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false)
  const connected = options.connected ?? (() => true)
  const deadline = startedAt + timeoutMs
  let pending = [...documents]
  let asks = 0
  // Progress: a document acknowledged, or the server's known heads moving.
  let lastProgressAt = startedAt
  let lastSignature: string | null = null
  const signature = () => {
    const heads = options.serverHeads?.(pending.map((item) => item.documentId))
    return JSON.stringify(pending.map((item) => [item.documentId, heads?.get(item.documentId) ?? null]))
  }
  const done = (outcome: WorkspaceSwitchDrainOutcome['outcome']): WorkspaceSwitchDrainOutcome => ({
    outcome, documents: documents.length, pending: pending.length, asks, elapsedMs: Date.now() - startedAt,
  })
  while (Date.now() < deadline) {
    // Offline, or a transport with no peer — nothing can leave.
    if (!online() || !connected()) return done('unreachable')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()))
    try {
      asks += 1
      const acknowledged = await acknowledge(pending, { workspace: debt.ref, signal: controller.signal })
      const durable = new Set(acknowledged.filter((item) => item.durable).map((item) => item.documentId))
      const before = pending.length
      pending = pending.filter((item) => !durable.has(item.documentId))
      if (!pending.length) return done('durable')
      if (pending.length < before) lastProgressAt = Date.now()
    } catch {
      // A refusal, a 503, an abort at the deadline: asked again until the bound.
    } finally {
      clearTimeout(timer)
    }
    const now = signature()
    if (now !== lastSignature) {
      if (lastSignature !== null) lastProgressAt = Date.now()
      lastSignature = now
    }
    if (asks >= 2 && Date.now() - lastProgressAt >= stallMs) return done('stalled')
    const wait = Math.min(pollMs, deadline - Date.now())
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }
  return done('timeout')
}
