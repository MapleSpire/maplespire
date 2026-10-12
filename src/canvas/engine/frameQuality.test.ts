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
import { AdaptiveFrameQuality } from './frameQuality'

describe('AdaptiveFrameQuality', () => {
  it('degrades after a sustained p95 budget breach and recovers with hysteresis', () => {
    const quality = new AdaptiveFrameQuality({
      sampleSize: 8,
      minimumSamples: 4,
      degradeAboveMs: 25,
      recoverBelowMs: 18,
    })

    for (const duration of [12, 14, 31]) expect(quality.record(duration)).toBe(false)
    expect(quality.record(29)).toBe(true)
    expect(quality.isDegraded()).toBe(true)

    for (const duration of [14, 15, 17]) expect(quality.record(duration)).toBe(false)
    expect(quality.record(16)).toBe(true)
    expect(quality.isDegraded()).toBe(false)
  })

  it('ignores invalid samples', () => {
    const quality = new AdaptiveFrameQuality({ minimumSamples: 1 })
    expect(quality.record(Number.NaN)).toBe(false)
    expect(quality.record(-1)).toBe(false)
    expect(quality.isDegraded()).toBe(false)
  })
})
