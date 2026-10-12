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
import { cableProfileFor, cableYAt } from './cableProfile'

/**
 * Vertical shape of a lit cable (regression: cables must visibly connect —
 * ends sit EXACTLY at their plug heights, and the run rests at the support
 * height, never below it).
 */
describe('cableProfileFor / cableYAt', () => {
  it('endpoints are exactly the plug heights; the long mid-run rests at yRest', () => {
    const p = cableProfileFor(7.5, 12, -4.6, 600)
    expect(cableYAt(p, 0)).toBe(7.5)
    expect(cableYAt(p, 1)).toBe(12)
    expect(cableYAt(p, 0.5)).toBe(-4.6)
    // rest holds across the whole middle span (shoulders are 55/600 ≈ 9%)
    expect(cableYAt(p, 0.2)).toBe(-4.6)
    expect(cableYAt(p, 0.8)).toBe(-4.6)
  })

  it('never dips below the requested rest (support clearance is a floor)', () => {
    const p = cableProfileFor(7.5, 7.5, 3.4, 800)
    for (let i = 0; i <= 40; i++) {
      expect(cableYAt(p, i / 40)).toBeGreaterThanOrEqual(3.4 - 1e-9)
    }
  })

  it('short spans droop gently instead of V-diving to the support', () => {
    // 70 px between adjacent slabs: max dip = total·0.12 = 8.4 below the
    // lower plug, NOT the full descent to the desk 12+ below
    const p = cableProfileFor(7.5, 7.5, -4.6, 70)
    expect(p.yRest).toBeCloseTo(7.5 - 70 * 0.12, 10)
    expect(cableYAt(p, 0.5)).toBeCloseTo(7.5 - 8.4, 10)
  })

  it('descent is monotone through the shoulder (no overshoot/ringing)', () => {
    const p = cableProfileFor(9, 5, -3, 400)
    let prev = cableYAt(p, 0)
    const s = 55 / 400
    for (let i = 1; i <= 20; i++) {
      const y = cableYAt(p, (i / 20) * s)
      expect(y).toBeLessThanOrEqual(prev + 1e-9)
      prev = y
    }
  })

  it('a rest ABOVE a plug clamps to the lower plug (cable never climbs mid-span)', () => {
    // thin platform wall: plug at 2.2 but support clearance would ask 3.4
    const p = cableProfileFor(2.2, 7.5, 3.4, 300)
    expect(p.yRest).toBe(2.2)
    for (let i = 0; i <= 30; i++) {
      expect(cableYAt(p, i / 30)).toBeLessThanOrEqual(7.5 + 1e-9)
    }
  })
})
