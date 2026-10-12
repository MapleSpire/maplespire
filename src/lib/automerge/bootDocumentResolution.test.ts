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
 * The boot budget is a CONSEQUENCE, not a preference.
 *
 * `budgetMs` clamps the last escalating window (`handleRetry.ts`, the
 * `Math.min(escalatedMs, remainingMs())`), so a budget shorter than the
 * schedule it is meant to contain silently shortens a window that a large
 * queued document already depends on (e.g. `budgetMs: 20_000` against a
 * 22 000 ms schedule made most joiners fail on a ~2.4 MB registry shard).
 *
 * Raising `findTimeoutMs` from 3 s to 5 s — the reflex fix for a slow link —
 * moves the schedule to 36 000; a literal budget would then clip it silently.
 * So these tests pin the RELATION between budget and schedule, not a number.
 */

// @vitest-environment jsdom
// jsdom for localStorage/indexedDB probing inside repo.ts's module scope; the
// same environment `repo.rootUrlCache.test.ts` uses. Nothing here resolves a
// document, so no adapter is attached and nothing can hang (with an adapter
// attached and no peer connected, `repo.find()` never settles).

import { describe, expect, it } from 'vitest'
import { ceilingScheduleMs, WAIVER_BUDGET_MS } from './handleRetry'
import { BOOT_RESOLVE_MAX_MS, MIN_PROGRESS_BYTES } from './progressBudget'
import { BOOT_DOCUMENT_RESOLUTION, resetBootWaiverAllocation } from './repo'

describe('BOOT_DOCUMENT_RESOLUTION', () => {
  it('never clips its own ceiling schedule, whatever the schedule fields say', () => {
    const { budgetMs, tries, delayMs, findTimeoutMs } = BOOT_DOCUMENT_RESOLUTION
    const schedule = ceilingScheduleMs(tries, findTimeoutMs, delayMs)

    // THE invariant. Fails if `budgetMs` is pinned to a literal while a
    // schedule field moves underneath it — e.g. `budgetMs: 25_000` with
    // `findTimeoutMs: 5_000` (schedule 36 000).
    expect(budgetMs).toBeGreaterThanOrEqual(schedule)
  })

  it('leaves the waiver its own allowance ON TOP of that schedule', () => {
    const { budgetMs, tries, delayMs, findTimeoutMs } = BOOT_DOCUMENT_RESOLUTION
    const schedule = ceilingScheduleMs(tries, findTimeoutMs, delayMs)

    // The waiver runs INSIDE this budget and spends before the ceiling
    // schedule starts, so a budget equal to the schedule would hand the
    // ceilings a wall the waiver had already eaten. Its allowance is capped
    // per call (WAIVER_BUDGET_MS), which is what makes this expressible at
    // all — an un-capped waiver could spend the whole budget.
    expect(budgetMs).toBeGreaterThanOrEqual(schedule + WAIVER_BUDGET_MS)
  })

  it('is the schedule plus the allowance, and today that is 24 000 ms', () => {
    // The concrete numbers, so a reader can check the arithmetic by eye and a
    // deliberate change has to say so here. 3 000 + 500 + 6 000 + 500 + 12 000
    // = 22 000, plus 2 000 of waiver.
    expect(ceilingScheduleMs(3, 3_000, 500)).toBe(22_000)
    expect(BOOT_DOCUMENT_RESOLUTION.budgetMs).toBe(24_000)
    expect(BOOT_DOCUMENT_RESOLUTION.tries).toBe(3)
  })

  it('carries the peer oracle the waiver needs, on every boot-critical document', () => {
    // `canWaive` requires BOTH `peers` and `budgetMs`; passing one without the
    // other is silently inert.
    expect(BOOT_DOCUMENT_RESOLUTION.peers).toBeDefined()
    expect(typeof BOOT_DOCUMENT_RESOLUTION.peers.connectedPeerCount).toBe('function')
    expect(typeof BOOT_DOCUMENT_RESOLUTION.peers.peerExpected).toBe('function')
  })

  it('shares ONE waiver allowance across every document of a boot (#37bis, R1b)', () => {
    // Without this the allowance is per CALL and `resolveInBatches` makes one
    // call per document (e.g. 18 x 2 000 = 36 s of hourglass on an
    // unreachable server). `handleRetry.test.ts` prices it; this pins that the
    // shipped options actually carry the allowance.
    const { waiver } = BOOT_DOCUMENT_RESOLUTION
    expect(typeof waiver.remainingMs).toBe('function')
    expect(typeof waiver.spend).toBe('function')
    expect(waiver.remainingMs()).toBe(WAIVER_BUDGET_MS)
  })

  it('refills that allowance when a boot starts, so a Réessayer is not born spent', () => {
    // The allowance is a facade over a swappable epoch precisely so it CAN be
    // refilled: a module const holding the allocation itself would be spent
    // once for the lifetime of the tab, and the second boot of a session — the
    // one the failure panel's button asks for — would have nothing left.
    const { waiver } = BOOT_DOCUMENT_RESOLUTION
    waiver.spend(WAIVER_BUDGET_MS)
    expect(waiver.remainingMs()).toBe(0)

    resetBootWaiverAllocation()
    expect(waiver.remainingMs()).toBe(WAIVER_BUDGET_MS)
  })
  it('carries the ABSOLUTE wall, without which the stall budget extends nothing (#37ter)', () => {
    // `productive` is guarded on `maxBudgetMs !== null`: a caller that hands in
    // `peers` and `budgetMs` but no absolute wall keeps the plain three-attempt
    // schedule, silently. Dropping this one field from the shipped options
    // would disable the stall extension with every other unit test still green.
    expect(BOOT_DOCUMENT_RESOLUTION.maxBudgetMs).toBe(BOOT_RESOLVE_MAX_MS)
    expect(BOOT_DOCUMENT_RESOLUTION.maxBudgetMs).toBeGreaterThan(BOOT_DOCUMENT_RESOLUTION.budgetMs)
  })

  it('can answer the progress question at all: the oracle carries `inboundBytes`', () => {
    // The seam is optional by design, and its absence reads as "no progress
    // observed" — the safe default, but one that would leave the stall
    // extension inert on the boot path. The shipped oracle must implement it.
    expect(typeof BOOT_DOCUMENT_RESOLUTION.peers.inboundBytes).toBe('function')
    expect(BOOT_DOCUMENT_RESOLUTION.peers.inboundBytes!()).toBeGreaterThanOrEqual(0)
    // And the threshold has to be a real filter: 0 would let a heartbeat hold
    // the stall wall open for ever.
    expect(MIN_PROGRESS_BYTES).toBeGreaterThan(0)
  })
})
