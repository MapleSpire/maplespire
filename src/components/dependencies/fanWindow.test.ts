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

import { CAP_PER_SIDE, fanWindow, nextFanOffset, shouldLoadMore } from './fanWindow'

const peers = (n: number) => Array.from({ length: n }, (_, i) => `peer-${i + 1}`)

describe('fanWindow', () => {
  // The point of the whole exercise: the DOM cost is the window, not the model.
  it('draws the same number of cards for seven peers as for two thousand', () => {
    expect(fanWindow(peers(7), 7, 0).cards).toHaveLength(CAP_PER_SIDE)
    expect(fanWindow(peers(2000), 2000, 0).cards).toHaveLength(CAP_PER_SIDE)
    expect(fanWindow(peers(2000), 2000, 900).cards).toHaveLength(CAP_PER_SIDE)
  })

  it('shows the slice the offset points at', () => {
    expect(fanWindow(peers(14), 14, 4).cards).toEqual([
      'peer-5', 'peer-6', 'peer-7', 'peer-8', 'peer-9', 'peer-10',
    ])
  })

  // `totalPeers` is the seam's count for the filtered set; `peers` is only what
  // has been paged in. Counting the remainder against the loaded array would
  // make the slot read "+0 more" the moment the first page ran out.
  it('counts the remainder against the total, not against what is loaded', () => {
    expect(fanWindow(peers(50), 2000, 0).more).toBe(2000 - CAP_PER_SIDE)
  })

  it('drops the more-slot only when the window reaches the true end', () => {
    expect(fanWindow(peers(6), 6, 0).more).toBe(0)
    expect(fanWindow(peers(6), 6, 0).slots).toBe(6)
    expect(fanWindow(peers(7), 7, 0).slots).toBe(CAP_PER_SIDE + 1)
  })

  // A filter can shrink the set under a window the user had scrolled far out to.
  // Clamping to `totalPeers - 1` would strand a single last card mid-band.
  it('falls back to a full window when the offset outruns a shrunken set', () => {
    expect(fanWindow(peers(3), 3, 900).cards).toEqual(['peer-1', 'peer-2', 'peer-3'])
    expect(fanWindow(peers(3), 3, 900).more).toBe(0)

    expect(fanWindow(peers(20), 20, 900).cards).toHaveLength(CAP_PER_SIDE)
    expect(fanWindow(peers(20), 20, 900).start).toBe(20 - CAP_PER_SIDE)
  })

  it('clamps a stale offset exactly where the wheel would have stopped', () => {
    // Two functions clamping differently is a window that jumps on the next notch.
    const total = 40
    expect(fanWindow(peers(total), total, 999).start).toBe(nextFanOffset(999, 1, total))
  })

  it('treats a negative offset as the start', () => {
    expect(fanWindow(peers(9), 9, -5).start).toBe(0)
  })
})

describe('nextFanOffset', () => {
  it('moves one peer per notch in both directions', () => {
    expect(nextFanOffset(4, 1, 100)).toBe(5)
    expect(nextFanOffset(4, -1, 100)).toBe(3)
  })

  it('stops at the start', () => {
    expect(nextFanOffset(0, -1, 100)).toBe(0)
  })

  // Past this the window would show a shrinking handful drifting off the band.
  it('stops with the last full window flush against the end', () => {
    expect(nextFanOffset(94, 1, 100)).toBe(100 - CAP_PER_SIDE)
    expect(nextFanOffset(999, 1, 100)).toBe(100 - CAP_PER_SIDE)
  })

  it('never scrolls a fan that fits', () => {
    expect(nextFanOffset(0, 1, 4)).toBe(0)
    expect(nextFanOffset(0, 1, CAP_PER_SIDE)).toBe(0)
  })
})

describe('shouldLoadMore', () => {
  it('asks while the window is still short of the loaded end', () => {
    expect(shouldLoadMore(10, 50, true)).toBe(false)
  })

  // Overlaps the fetch with the scrolling instead of following it.
  it('asks as the window reaches the end of what is loaded', () => {
    expect(shouldLoadMore(44, 50, true)).toBe(true)
    expect(shouldLoadMore(50, 50, true)).toBe(true)
  })

  it('does not ask when the seam said there is nothing after this', () => {
    expect(shouldLoadMore(50, 50, false)).toBe(false)
  })
})
