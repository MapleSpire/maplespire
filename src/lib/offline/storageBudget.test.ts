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
import { computeDerivedCacheBudget } from './storageBudget'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

describe('computeDerivedCacheBudget', () => {
  it('keeps quota headroom and caps derived data', () => {
    const result = computeDerivedCacheBudget({ usageBytes: 1 * GIB, quotaBytes: 10 * GIB })
    expect(result.quotaKnown).toBe(true)
    expect(result.reservedHeadroomBytes).toBe(2 * GIB)
    expect(result.availableAfterHeadroomBytes).toBe(7 * GIB)
    expect(result.budgetBytes).toBe(2 * GIB)
  })

  it('returns zero rather than consuming protected headroom', () => {
    const result = computeDerivedCacheBudget({ usageBytes: 900 * MIB, quotaBytes: 1 * GIB })
    expect(result.budgetBytes).toBe(0)
    expect(result.availableAfterHeadroomBytes).toBe(0)
  })

  it('returns a target total and sheds derived bytes to restore headroom', () => {
    const result = computeDerivedCacheBudget({
      usageBytes: 900 * MIB,
      quotaBytes: 1 * GIB,
      currentDerivedBytes: 300 * MIB,
    })
    // The 256 MiB minimum headroom is stricter than 20% for a 1 GiB quota,
    // leaving a 168 MiB target for the current 300 MiB derived cache.
    expect(result.budgetBytes).toBe(168 * MIB)
  })

  it('uses a conservative bounded fallback when quota is unavailable', () => {
    const result = computeDerivedCacheBudget({ usageBytes: null, quotaBytes: null })
    expect(result.quotaKnown).toBe(false)
    expect(result.budgetBytes).toBe(256 * MIB)
  })
})
