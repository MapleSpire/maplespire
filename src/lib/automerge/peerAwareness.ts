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

import type { Repo } from '@automerge/automerge-repo'
import type { TransportPhase } from './adaptiveWebSocketClientAdapter'

/**
 * "Is anyone there, and is anyone coming?" — the two questions a document
 * resolution has to ask before it treats a rejection as an answer.
 *
 * A deliberately tiny interface, and injected rather than reached for. The
 * retry helper is a pure scheduling decision tested against fake repos; giving
 * it a direct dependency on `repo.peers` and on the network subsystem's
 * adapter list would turn every one of those unit tests into an integration
 * test against automerge-repo's internals.
 */
export interface PeerAwareness {
  /** How many peers the repo is synchronising with right now. */
  connectedPeerCount(): number
  /**
   * Is a peer still ON ITS WAY — a transport with a handshake in flight?
   *
   * This is NOT "am I online" and NOT "is a transport attached". Both stay
   * true when the server is down, and answering yes there would trade the
   * product's instant offline boot for up to twenty seconds of hourglass on
   * every start-up without a server.
   */
  peerExpected(): boolean
  /**
   * What the transport is doing, and why it last stopped — for the retry mark
   * only. Nothing decides on it.
   *
   * OPTIONAL because a test double that models no transport has nothing
   * honest to say here, and a stub returning `'idle'` would put a fabricated
   * state into an incident's timeline. `undefined` omits the fields.
   */
  transportState?(): { phase: TransportPhase; closeCode: number | null } | null
  /**
   * Bytes this browser has received over the sync transport, monotone.
   *
   * The question it answers is NOT "did my document arrive" — automerge-repo
   * 2.6.0-alpha.2 exposes no per-document byte counter, so that question
   * cannot be asked at all. It answers "is the server still serving THIS
   * client", which is what separates a document waiting its turn on a serial
   * server from a server that has gone quiet. `progressBudget.ts` carries the
   * derivation and the limits.
   *
   * OPTIONAL for the same reason `transportState` is: a double that models no
   * transport has nothing honest to say, and a stub returning 0 would assert
   * "the server is quiet" — the one answer that ends a boot early.
   */
  inboundBytes?(): number
}

/** The adapter surface consulted below. `AdaptiveWebSocketClientAdapter` is the
 * only transport this app attaches; anything else is treated as "cannot say",
 * which means "do not wait". */
interface HandshakeAwareAdapter {
  handshakePending?: () => boolean
  transportPhase?: () => TransportPhase
  lastCloseCode?: () => number | null
  inboundBytes?: () => number
}

/** The adapters attached to a repo, or `[]` for anything that cannot say. */
function attachedAdapters(repo: Repo): HandshakeAwareAdapter[] {
  const adapters = repo.networkSubsystem?.adapters as HandshakeAwareAdapter[] | undefined
  return Array.isArray(adapters) ? adapters : []
}

/**
 * Bind the two questions to a live repo.
 *
 * `peerExpected` is deliberately conjunctive:
 *
 *  - `navigator.onLine === false` ends it immediately. Nothing is coming, and
 *    a browser that says it is offline is the one signal available before any
 *    socket has had time to fail.
 *  - otherwise, SOME attached adapter must report a handshake in flight. That
 *    is a strictly narrower claim than "an adapter exists": the router always
 *    keeps exactly one adapter attached, including with the server down, so
 *    existence would be permanently true and the waiver permanently armed.
 */
export function repoPeerAwareness(repo: Repo): PeerAwareness {
  return {
    connectedPeerCount: () => {
      try {
        return repo.peers.length
      } catch {
        return 0
      }
    },
    peerExpected: () => {
      try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
        return attachedAdapters(repo).some((adapter) => adapter.handshakePending?.() === true)
      } catch {
        return false
      }
    },
    // SUMMED over the attached adapters, and the caller compares two readings
    // rather than trusting the absolute value — the router keeps exactly one
    // adapter attached, but a swap would make a sum jump DOWN, and a decrease
    // must read as "no progress", never as a negative delta.
    inboundBytes: () => {
      try {
        return attachedAdapters(repo).reduce(
          (total, adapter) => total + (adapter.inboundBytes?.() ?? 0),
          0,
        )
      } catch {
        return 0
      }
    },
    transportState: () => {
      try {
        // The FIRST adapter that can answer. The router keeps exactly one
        // attached, so "first" and "the one" coincide; reporting a
        // merged phase across several would invent a state no socket is in.
        const adapter = attachedAdapters(repo).find((candidate) => typeof candidate.transportPhase === 'function')
        if (!adapter) return null
        return { phase: adapter.transportPhase!(), closeCode: adapter.lastCloseCode?.() ?? null }
      } catch {
        return null
      }
    },
  }
}
