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

import { describe, expect, it } from 'vitest'
import { decodeHeads, encodeHeads } from '@automerge/automerge-repo'
import { isCaughtUp, ServiceLatencyTracker } from './automergeServiceLatency.js'

/** The clock the tracker measures against, owned by the test. A latency
 * tracker verified against the wall clock verifies the test runner. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let wall = 1_000
  return { now: () => wall, advance: (ms) => { wall += ms } }
}

describe('ServiceLatencyTracker', () => {
  it('measures from the FIRST not-caught-up exchange to the one that catches up', () => {
    const time = clock()
    const tracker = new ServiceLatencyTracker(time.now)

    tracker.observe('peer-a', 'doc-1', false)
    time.advance(4_000)
    tracker.observe('peer-a', 'doc-1', true)

    const snapshot = tracker.snapshot()
    expect(snapshot.completed).toBe(1)
    expect(snapshot.pending).toBe(0)
    expect(snapshot.maxMs).toBe(4_000)
    expect(snapshot.p50Ms).toBe(4_000)
  })

  it('THE mutant: a chatty exchange must not restart the clock', () => {
    // Otherwise this metric would report ~0 for ever. A sync exchange fires repeatedly while a large document streams; if each one
    // re-stamped the start, a 12 s service would be recorded as the gap
    // between the last two messages — a number that is always small and always
    // wrong, on precisely the documents that fail a boot.
    const time = clock()
    const tracker = new ServiceLatencyTracker(time.now)

    tracker.observe('peer-a', 'doc-1', false)
    time.advance(5_000)
    tracker.observe('peer-a', 'doc-1', false)
    time.advance(5_000)
    tracker.observe('peer-a', 'doc-1', false)
    time.advance(2_000)
    tracker.observe('peer-a', 'doc-1', true)

    expect(tracker.snapshot().maxMs).toBe(12_000)
  })

  it('a caught-up exchange for nothing pending completes nothing', () => {
    // The steady state of a healthy hub: peers stay caught up and exchange
    // sync messages that carry no work. Counting those as zero-length services
    // would flood the quantiles with zeros and hide the tail — the only part
    // of the distribution this metric exists for.
    const tracker = new ServiceLatencyTracker(clock().now)
    tracker.observe('peer-a', 'doc-1', true)
    tracker.observe('peer-a', 'doc-2', true)

    const snapshot = tracker.snapshot()
    expect(snapshot.completed).toBe(0)
    expect(snapshot.pending).toBe(0)
    expect(snapshot.p50Ms).toBe(0)
  })

  it('pendingOldestMs is the EARLY WARNING: it moves while nothing has completed', () => {
    // The reading an operator watches. Nothing has finished, so every
    // completion-based statistic is silent — and that silence is exactly the
    // situation where boots are about to fail.
    const time = clock()
    const tracker = new ServiceLatencyTracker(time.now)

    tracker.observe('peer-a', 'doc-slow', false)
    time.advance(30_000)
    tracker.observe('peer-b', 'doc-fast', false)
    time.advance(90_000)

    const snapshot = tracker.snapshot()
    expect(snapshot.completed).toBe(0)
    expect(snapshot.maxMs).toBe(0)
    expect(snapshot.pending).toBe(2)
    // 120 000 ms: past the client's own default wall, so this peer has already
    // given up by now — and the server could have said so 120 seconds ago.
    expect(snapshot.pendingOldestMs).toBe(120_000)
  })

  it('a disconnected peer leaves the pending set WITHOUT producing a sample', () => {
    // A disconnect is not a delivery. Counting it as one would report the
    // fastest possible service for the case that served nothing at all, and
    // socket drops are common enough to dominate the samples.
    const time = clock()
    const tracker = new ServiceLatencyTracker(time.now)

    tracker.observe('peer-a', 'doc-1', false)
    tracker.observe('peer-b', 'doc-1', false)
    time.advance(7_000)
    tracker.forgetPeer('peer-a')

    const snapshot = tracker.snapshot()
    expect(snapshot.completed).toBe(0)
    expect(snapshot.maxMs).toBe(0)
    expect(snapshot.pending).toBe(1)
  })

  it('forgetPeer matches on the WHOLE peer id, not a prefix of one', () => {
    // The key is `peer\u0000document`, and the separator is what makes this
    // safe: without it, forgetting `peer-a` would also forget `peer-ab`.
    const tracker = new ServiceLatencyTracker(clock().now)
    tracker.observe('peer-a', 'doc-1', false)
    tracker.observe('peer-ab', 'doc-1', false)

    tracker.forgetPeer('peer-a')
    expect(tracker.snapshot().pending).toBe(1)
  })

  it('the same document for two peers is two services', () => {
    const time = clock()
    const tracker = new ServiceLatencyTracker(time.now)

    tracker.observe('peer-a', 'doc-1', false)
    time.advance(1_000)
    tracker.observe('peer-b', 'doc-1', false)
    time.advance(2_000)
    tracker.observe('peer-a', 'doc-1', true)
    tracker.observe('peer-b', 'doc-1', true)

    const snapshot = tracker.snapshot()
    expect(snapshot.completed).toBe(2)
    expect(snapshot.maxMs).toBe(3_000)
    expect(snapshot.pending).toBe(0)
  })

  it('the pending cap is REPORTED, never a silent truncation', () => {
    // A limit nobody can see turns a measurement into a guess. `overflow > 0`
    // says the quantiles below it describe a subset — "no silent caps",
    // applied to the instrument itself.
    const tracker = new ServiceLatencyTracker(clock().now)
    for (let index = 0; index < 8_200; index += 1) {
      tracker.observe('peer-a', `doc-${index}`, false)
    }

    const snapshot = tracker.snapshot()
    expect(snapshot.pending).toBe(8_192)
    expect(snapshot.overflow).toBe(8_200 - 8_192)
  })

  it('keys a peer and a document with a separator neither can contain', () => {
    // Base58 ids cannot contain a NUL, so the join is unambiguous. Asserted
    // rather than assumed: a separator that CAN occur in an id makes
    // `forgetPeer` forget the wrong services, silently.
    const key = ServiceLatencyTracker.key('peer-a', 'doc-1')
    expect(key).toBe('peer-a' + String.fromCharCode(0) + 'doc-1')
    expect(key.includes(String.fromCharCode(0))).toBe(true)
  })
  it('a STUCK entry is retired into `abandoned`, so pendingOldestMs cannot only rise', () => {
    // On an idle stack a peer can enter service and never converge; a gauge
    // that can only rise is an alarm that stops meaning anything.
    const time = clock()
    const tracker = new ServiceLatencyTracker(time.now)

    tracker.observe('peer-stuck', 'doc-1', false)
    time.advance(599_000)
    expect(tracker.snapshot().pendingOldestMs).toBe(599_000)
    expect(tracker.snapshot().abandoned).toBe(0)

    time.advance(2_000)
    const after = tracker.snapshot()
    expect(after.pending).toBe(0)
    expect(after.pendingOldestMs).toBe(0)
    // Counted, never silently dropped: a peer that never converges is a
    // finding of its own, just not a latency.
    expect(after.abandoned).toBe(1)
    // …and it never becomes a latency sample.
    expect(after.completed).toBe(0)
    expect(after.maxMs).toBe(0)
  })

  it('a LIVE slow service is still reported, not retired with the stuck ones', () => {
    // The threshold is five times the longest client wall, so anything a boot
    // is genuinely still waiting for stays visible.
    const time = clock()
    const tracker = new ServiceLatencyTracker(time.now)
    tracker.observe('peer-a', 'doc-1', false)
    time.advance(130_000)

    const snapshot = tracker.snapshot()
    expect(snapshot.pending).toBe(1)
    expect(snapshot.pendingOldestMs).toBe(130_000)
    expect(snapshot.abandoned).toBe(0)
  })
})

describe('isCaughtUp', () => {
  // A real automerge head is 32 hex bytes. Fixed, not generated: the point of
  // these tests is the ENCODING, and a random value would only prove bs58
  // round-trips.
  const RAW_HEAD = 'a'.repeat(64)

  it('is true when the shared heads cover the document heads', () => {
    expect(isCaughtUp([RAW_HEAD], [RAW_HEAD, 'b'.repeat(64)])).toBe(true)
  })

  it('is false while one document head is missing', () => {
    expect(isCaughtUp([RAW_HEAD, 'b'.repeat(64)], [RAW_HEAD])).toBe(false)
  })

  it('is false for a document with NO heads — nothing to be caught up on', () => {
    // The server has nothing to give, so nobody is waiting: calling this
    // "caught up" would complete a service that never started, and the metric
    // would report a stream of zero-length services.
    expect(isCaughtUp([], [RAW_HEAD])).toBe(false)
  })

  it('THE defect: an ENCODED head never matches a RAW one', () => {
    // `DocHandle.heads()` is bs58check
    // (`encodeHeads`); `syncState.sharedHeads` is raw hex, which is what
    // `DocSynchronizer` compares against. Two spellings of the same head do
    // not intersect, and a predicate that can never be true is a metric that
    // reports a permanent emergency.
    const encoded = encodeHeads([RAW_HEAD] as unknown as Parameters<typeof encodeHeads>[0])
    expect([...encoded]).not.toEqual([RAW_HEAD])
    expect(isCaughtUp([...encoded], [RAW_HEAD])).toBe(false)
    // …and the decode is what makes the wiring correct.
    expect([...decodeHeads(encoded)]).toEqual([RAW_HEAD])
    expect(isCaughtUp([...decodeHeads(encoded)], [RAW_HEAD])).toBe(true)
  })
})
