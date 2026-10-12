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
 * The waiver cap is a SETTING, and a bounded one.
 *
 * Handshake latency is a property of the deployment, not of the code: 683 ms
 * is the worst seen on a local dev stack, and a cloud deployment may be
 * slower for perfectly good reasons. So the cap has to be settable. But a cap
 * settable to 30 s reintroduces exactly the long hang the cap removes, in a
 * configuration file where nobody would think to look for it — hence a
 * maximum, and hence a clamp that SAYS SO. A setting silently ignored is
 * worse than no setting at all: the operator believes a value that is not in
 * force.
 */

// @vitest-environment jsdom
// jsdom for localStorage — the runtime override lives there.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWaiverAllocation,
  resolveWaiverBudgetMs,
  WAIVER_BUDGET_DEFAULT_MS,
  WAIVER_BUDGET_MAX_MS,
  WAIVER_BUDGET_MS,
} from './waiverBudget'

const LS_KEY = 'maplespire:bootWaiverMs'

afterEach(() => {
  localStorage.removeItem(LS_KEY)
  vi.restoreAllMocks()
})

describe('the waiver cap as a setting', () => {
  it('defaults to the MEASURED number, and the module constant is that default', () => {
    // 683 ms is the worst handshake delay measured (eight concurrent clients
    // on a local stack); 2 000 is very nearly three times it. Changing this
    // should be a decision somebody takes with a measurement in hand.
    expect(WAIVER_BUDGET_DEFAULT_MS).toBe(2_000)
    expect(WAIVER_BUDGET_DEFAULT_MS).toBeGreaterThan(2 * 683)
    expect(resolveWaiverBudgetMs()).toBe(WAIVER_BUDGET_DEFAULT_MS)
    // No override was set when this module was imported, so the constant the
    // retry loop actually uses is the default.
    expect(WAIVER_BUDGET_MS).toBe(WAIVER_BUDGET_DEFAULT_MS)
  })

  it('takes a runtime override, so a slower deployment does not need a rebuild', () => {
    localStorage.setItem(LS_KEY, '3500')
    expect(resolveWaiverBudgetMs()).toBe(3_500)
  })

  it('CLAMPS an override past the maximum, and says so out loud', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    localStorage.setItem(LS_KEY, '30000')

    expect(resolveWaiverBudgetMs()).toBe(WAIVER_BUDGET_MAX_MS)
    // Visible, never silent: 30 s of waiting for a peer is the hang the cap
    // exists to prevent, and an operator who set it has to learn that it did not apply.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CLAMPED'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(String(WAIVER_BUDGET_MAX_MS)))
  })

  it('keeps the maximum itself bounded by what the product promises', () => {
    // The cap is how long an UNREACHABLE server costs before the boot gives
    // up, so its maximum is a product decision and not a tuning knob: past
    // this, instant offline boot is gone. 5 000 is already ~7x the worst
    // delay measured.
    expect(WAIVER_BUDGET_MAX_MS).toBe(5_000)
    expect(WAIVER_BUDGET_MAX_MS).toBeLessThan(8 * 683)
  })

  it('falls back to the default on a malformed or negative setting, and says that too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    localStorage.setItem(LS_KEY, 'soon')
    expect(resolveWaiverBudgetMs()).toBe(WAIVER_BUDGET_DEFAULT_MS)
    localStorage.setItem(LS_KEY, '-1')
    expect(resolveWaiverBudgetMs()).toBe(WAIVER_BUDGET_DEFAULT_MS)

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a non-negative number'))
  })

  it('accepts 0 — "never wait" is a legitimate policy, not a malformed one', () => {
    // Distinct from the malformed case above on purpose: `Number('')` is 0 and
    // `Number(null)` is 0, so a resolver that treated 0 as absent would turn a
    // deliberate "no waiver" into the full default.
    localStorage.setItem(LS_KEY, '0')
    expect(resolveWaiverBudgetMs()).toBe(0)
  })
})

/**
 * The allowance as a value that can be SHARED.
 *
 * The arithmetic is trivial; what these pin is the two properties the sharing
 * rests on. It never goes negative, so a caller composing a deadline on it
 * cannot build one in the past. And two independent allocations really are
 * independent, which is what makes "the boot shares one" a statement about
 * the call sites rather than about a hidden global.
 */
describe('createWaiverAllocation', () => {
  it('starts full, drains by what is spent, and never goes below zero', () => {
    const allowance = createWaiverAllocation(2_000)
    expect(allowance.remainingMs()).toBe(2_000)
    allowance.spend(1_200)
    expect(allowance.remainingMs()).toBe(800)
    allowance.spend(5_000)
    // Clamped. A negative remainder handed to `waitStartedAt + remaining`
    // would be a deadline in the PAST, and the caller only ever composes on it
    // after checking `> 0` — so the clamp is belt to that brace.
    expect(allowance.remainingMs()).toBe(0)
  })

  it('defaults to the configured cap, and two allowances are independent', () => {
    expect(createWaiverAllocation().remainingMs()).toBe(WAIVER_BUDGET_MS)
    const first = createWaiverAllocation(1_000)
    const second = createWaiverAllocation(1_000)
    first.spend(1_000)
    expect(first.remainingMs()).toBe(0)
    expect(second.remainingMs()).toBe(1_000)
  })

  it('ignores a negative spend rather than refunding the allowance', () => {
    // A clock that went backwards must not BUY waiver time. `performance.now()`
    // is monotone, so this should not happen; the guard removes the question.
    const allowance = createWaiverAllocation(1_000)
    allowance.spend(-500)
    expect(allowance.remainingMs()).toBe(1_000)
  })
})
