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
 * "Is a peer coming?", and every way of answering it wrong.
 *
 * The retry waiver rests entirely on this predicate, and the two failure modes
 * are not symmetric. Answering yes too easily costs up to twenty seconds of
 * waiting on every offline boot, invisibly. Answering no too easily charges
 * rejections that arrive mid-handshake as real failures. Both mistakes
 * are one careless conjunct away, so each conjunct gets a test.
 */

import type { Repo } from '@automerge/automerge-repo'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type PeerAwareness, repoPeerAwareness } from './peerAwareness'

/** "Nobody is here and nobody is coming" — the conservative shape a caller
 * with no transport would pass. A test constant, not an export: no production
 * site needs it. */
const NO_PEERS_EXPECTED: PeerAwareness = {
  connectedPeerCount: () => 0,
  peerExpected: () => false,
}

function repoWith(peers: string[], adapters: unknown[]): Repo {
  return {
    peers,
    networkSubsystem: { adapters },
  } as unknown as Repo
}

const pending = { handshakePending: () => true }
const settled = { handshakePending: () => false }

afterEach(() => { vi.unstubAllGlobals() })

describe('repoPeerAwareness', () => {
  it('counts the repo peers, and survives a repo that cannot answer', () => {
    expect(repoPeerAwareness(repoWith(['a', 'b'], [])).connectedPeerCount()).toBe(2)
    const exploding = { get peers(): string[] { throw new Error('boom') } } as unknown as Repo
    expect(repoPeerAwareness(exploding).connectedPeerCount()).toBe(0)
  })

  it('expects a peer while a transport has a handshake in flight', () => {
    expect(repoPeerAwareness(repoWith([], [pending])).peerExpected()).toBe(true)
    expect(repoPeerAwareness(repoWith([], [settled, pending])).peerExpected()).toBe(true)
  })

  it('expects NOBODY when every attached transport has stopped trying', () => {
    // THE offline case, and the reason this is not "is an adapter attached".
    // `WorkspaceNetworkRouter` keeps exactly one adapter attached at all times,
    // including with the server down — so an existence test would be
    // permanently true and the waiver permanently armed.
    expect(repoPeerAwareness(repoWith([], [settled])).peerExpected()).toBe(false)
    expect(repoPeerAwareness(repoWith([], [])).peerExpected()).toBe(false)
  })

  it('expects nobody when the browser says it is offline, whatever the transport claims', () => {
    vi.stubGlobal('navigator', { onLine: false })
    expect(repoPeerAwareness(repoWith([], [pending])).peerExpected()).toBe(false)
  })

  it('treats a transport that cannot answer the question as "not coming"', () => {
    // A foreign adapter (a test double, a future transport) has no
    // `handshakePending`. Unknown must read as "do not wait": the cost of a
    // wrong yes is paid by every offline boot, the cost of a wrong no is only
    // a charged attempt.
    expect(repoPeerAwareness(repoWith([], [{}])).peerExpected()).toBe(false)
    expect(repoPeerAwareness({ peers: [] } as unknown as Repo).peerExpected()).toBe(false)
  })
})

/**
 * The transport's state reaches the retry mark, or it does not
 * reach an incident at all.
 */
describe('repoPeerAwareness transportState', () => {
  const reconnecting = {
    handshakePending: () => false,
    transportPhase: () => 'reconnecting' as const,
    lastCloseCode: () => 1006,
  }

  it('reports the phase and the close code of the attached transport', () => {
    expect(repoPeerAwareness(repoWith([], [reconnecting])).transportState?.())
      .toEqual({ phase: 'reconnecting', closeCode: 1006 })
  })

  it('says NOTHING rather than inventing a phase for a transport that cannot answer', () => {
    // `null`, never `'idle'`. A fabricated phase in a timeline is worse than a
    // missing one: the reader cannot tell it from a measurement.
    expect(repoPeerAwareness(repoWith([], [pending])).transportState?.()).toBeNull()
    expect(repoPeerAwareness(repoWith([], [])).transportState?.()).toBeNull()
    expect(repoPeerAwareness({ peers: [] } as unknown as Repo).transportState?.()).toBeNull()
  })

  it('reports a phase even for a transport that has never closed', () => {
    const fresh = { handshakePending: () => true, transportPhase: () => 'handshaking' as const }
    expect(repoPeerAwareness(repoWith([], [fresh])).transportState?.())
      .toEqual({ phase: 'handshaking', closeCode: null })
  })
})

describe('NO_PEERS_EXPECTED', () => {
  it('waives nothing — the conservative default for a caller with no transport', () => {
    expect(NO_PEERS_EXPECTED.connectedPeerCount()).toBe(0)
    expect(NO_PEERS_EXPECTED.peerExpected()).toBe(false)
  })
})
