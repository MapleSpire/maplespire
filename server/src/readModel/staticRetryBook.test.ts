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
 * T-ZEROWM-3 (2): the capped backoff of the static recoveries, and the
 * bounded book of their per-document counts — dropping a document that backs
 * off must not let it restart with fast retries.
 */

import { describe, expect, it } from 'vitest'

import {
  StaticRetryBook, staticRetryBackoffMs, staticRetryDecision, staticRecoveryBackoffMetricSamples,
} from './staticDeltaProjector.js'

describe('T-ZEROWM-3 — staticRetryBackoffMs', () => {
  it('doubles from the first backoff and is capped', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((step) => staticRetryBackoffMs(step, 30_000, 300_000)))
      .toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000])
  })
  it('stays at the cap however far past it (no overflow), and 0 stays 0 (no NaN)', () => {
    expect(staticRetryBackoffMs(10_000, 30_000, 300_000)).toBe(300_000)
    expect(staticRetryBackoffMs(10_000, 0, 300_000)).toBe(0)
    expect(staticRetryBackoffMs(-3, 30_000, 300_000)).toBe(30_000)
  })
})

describe('T-ZEROWM-3 — staticRetryDecision', () => {
  // The projector's two policies (limits of 5: `withdrawnReopenLimit + 1`,
  // `zeroSweepMaxAttempts + 1`).
  const withdrawn = { backoffFrom: 6, loggedFrom: 6, firstMs: 30_000, capMs: 300_000 }
  const sweep = { backoffFrom: 1, loggedFrom: 6, firstMs: 30_000, capMs: 300_000 }

  it('withdrawn re-opening: failures 1–5 at the next tick, BEYOND 5 doubling and capped, backing off from the 6th', () => {
    let known: number | undefined
    const seen: [number, boolean][] = []
    for (let failure = 1; failure <= 10; failure += 1) {
      const decision = staticRetryDecision(known, false, withdrawn)
      seen.push([decision.backoffMs, decision.backingOff])
      known = decision.count
    }
    expect(seen).toEqual([
      [0, false], [0, false], [0, false], [0, false], [0, false],
      [30_000, true], [60_000, true], [120_000, true], [240_000, true], [300_000, true],
    ])
  })

  it('sweep: backoff from the first relaunch, backing off (logged per step) past the 5th', () => {
    const decisions = [undefined, 1, 2, 3, 4, 5, 6].map((known) => staticRetryDecision(known, false, sweep))
    expect(decisions.map((decision) => decision.backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000])
    expect(decisions.map((decision) => decision.backingOff)).toEqual([false, false, false, false, false, true, true])
  })

  it('an unknown document of a SATURATED book enters backing off at the cap, and its next failure stays there (both paths)', () => {
    for (const policy of [withdrawn, sweep]) {
      const entering = staticRetryDecision(undefined, true, policy)
      expect(entering, JSON.stringify(policy)).toMatchObject({ entering: true, backingOff: true, backoffMs: 300_000 })
      expect(staticRetryDecision(entering.count, true, policy), 'the next failure').toMatchObject({ entering: false, backingOff: true, backoffMs: 300_000 })
    }
    expect(staticRetryDecision(undefined, false, withdrawn), 'not saturated: a fresh count').toMatchObject({ entering: false, count: 1, backoffMs: 0 })
  })
})

describe('T-ZEROWM-3 — StaticRetryBook', () => {
  type Entry = { backingOff: boolean; n: number }

  it('is bounded, the oldest (least recently refreshed) dropped first', () => {
    const book = new StaticRetryBook<Entry>(2)
    book.set('a', { backingOff: false, n: 1 })
    book.set('b', { backingOff: false, n: 1 })
    book.set('a', { backingOff: false, n: 2 })
    book.set('c', { backingOff: false, n: 1 })
    expect([...book].map(([id]) => id)).toEqual(['a', 'c'])
    // Two documents in their fast retries would otherwise
    // drop each other for ever without counting up to the backoff.
    expect(book.saturated, 'any drop saturates').toBe(true)
  })

  it('past the bound, the oldest entry NOT backing off goes first — never the one just set', () => {
    const book = new StaticRetryBook<Entry>(3)
    book.set('a', { backingOff: true, n: 9 })
    book.set('b', { backingOff: false, n: 1 })
    book.set('c', { backingOff: true, n: 9 })
    book.set('d', { backingOff: false, n: 1 })
    expect([...book].map(([id]) => id), 'b (not backing off) went, a (older, backing off) stayed').toEqual(['a', 'c', 'd'])
  })

  it('dropping a document that BACKS OFF (every other one does) saturates the book; it clears at half the bound', () => {
    const book = new StaticRetryBook<Entry>(4)
    for (const id of ['a', 'b', 'c', 'd']) book.set(id, { backingOff: true, n: 9 })
    book.set('e', { backingOff: false, n: 1 })
    expect(book.get('a'), 'the oldest backing-off entry dropped').toBeUndefined()
    expect(book.get('e'), 'the new entry kept').toBeDefined()
    expect(book.saturated, 'a document that backed off was forgotten').toBe(true)
    book.delete('b')
    expect(book.saturated, '3 of 4: still saturated').toBe(true)
    book.delete('c')
    expect(book.saturated, 'half the bound: cleared').toBe(false)
  })
})

describe('T-ZEROWM-3 — staticRecoveryBackoffMetricSamples', () => {
  it('a counter per path and a gauge of the documents backing off, summed over projectors', () => {
    const [counter, gauge] = staticRecoveryBackoffMetricSamples([
      { withdrawnBackingOff: 1, zeroSweepBackingOff: 0 },
      { withdrawnBackingOff: 2, zeroSweepBackingOff: 3 },
    ])
    expect(counter!.type).toBe('counter')
    expect(counter!.values.map((value) => value.labels?.recovery)).toEqual(['withdrawn_reopen', 'zero_sweep'])
    expect(gauge!.values).toEqual([
      { labels: { recovery: 'withdrawn_reopen' }, value: 3 },
      { labels: { recovery: 'zero_sweep' }, value: 3 },
    ])
  })
})
