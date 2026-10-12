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
import { calculateSmartGuides, type GuideRect, unionGuideRects } from './alignmentGuides'

const rect = (id: string, x: number, y: number, width = 100, height = 60): GuideRect => ({
  id, x, y, width, height,
})

describe('calculateSmartGuides', () => {
  it.each([
    ['left', rect('moving', 103, 150), rect('target', 100, 0), -3],
    ['centre-x', rect('moving', 204, 150), rect('target', 200, 0), -4],
    ['right', rect('moving', 307, 150), rect('target', 300, 0), -7],
  ])('snaps matching x %s anchors', (_name, moving, target, expectedDx) => {
    const result = calculateSmartGuides(moving, [target], 8)
    expect(result.dx).toBe(expectedDx)
    expect(result.guides).toContainEqual(expect.objectContaining({ kind: 'alignment', axis: 'x' }))
  })

  it.each([
    ['top', rect('moving', 150, 103), rect('target', 0, 100), -3],
    ['middle-y', rect('moving', 150, 204), rect('target', 0, 200), -4],
    ['bottom', rect('moving', 150, 307), rect('target', 0, 300), -7],
  ])('snaps matching y %s anchors', (_name, moving, target, expectedDy) => {
    const result = calculateSmartGuides(moving, [target], 8)
    expect(result.dy).toBe(expectedDy)
    expect(result.guides).toContainEqual(expect.objectContaining({ kind: 'alignment', axis: 'y' }))
  })

  it('snaps to equal horizontal gaps between neighbours', () => {
    const result = calculateSmartGuides(
      rect('moving', 101, 0, 50, 50),
      [rect('left', 0, 0, 50, 50), rect('right', 200, 0, 50, 50)],
      8,
    )
    expect(result.dx).toBe(-1)
    expect(result.guides.filter((guide) => guide.kind === 'spacing' && guide.axis === 'x')).toHaveLength(2)
    expect(result.guides).toContainEqual(expect.objectContaining({ kind: 'spacing', distance: 50 }))
  })

  it('snaps to equal vertical gaps between neighbours with different sizes', () => {
    const result = calculateSmartGuides(
      rect('moving', 0, 112, 80, 40),
      [rect('top', 0, 0, 80, 40), rect('bottom', 0, 240, 80, 80)],
      10,
    )
    expect(result.dy).toBe(8)
    expect(result.guides.filter((guide) => guide.kind === 'spacing' && guide.axis === 'y')).toHaveLength(2)
  })

  it('matches the repeated gap of two preceding shapes', () => {
    const result = calculateSmartGuides(
      rect('moving', 196, 0, 50, 50),
      [rect('first', 0, 0, 50, 50), rect('second', 100, 0, 50, 50)],
      8,
    )
    expect(result.dx).toBe(4)
    expect(result.guides.filter((guide) => guide.kind === 'spacing')).toHaveLength(2)
  })

  it('chooses the smallest correction and lets alignment win exact ties', () => {
    const result = calculateSmartGuides(
      rect('moving', 103, 0, 50, 50),
      [rect('aligned', 100, 100, 50, 50), rect('left', 0, 0, 50, 50), rect('right', 200, 0, 50, 50)],
      8,
    )
    expect(result.dx).toBe(-3)
    expect(result.guides.some((guide) => guide.kind === 'alignment' && guide.axis === 'x')).toBe(true)
  })

  it('does not snap outside the screen-space tolerance', () => {
    expect(calculateSmartGuides(rect('moving', 20, 20), [rect('target', 0, 0)], 5)).toMatchObject({
      dx: 0,
      dy: 0,
      snappedX: false,
      snappedY: false,
      guides: [],
    })
  })

  it('supports negative/off-window coordinates', () => {
    const result = calculateSmartGuides(rect('moving', -303, -197), [rect('target', -300, -200)], 5)
    expect(result).toMatchObject({ dx: 3, dy: -3, snappedX: true, snappedY: true })
  })
})

describe('unionGuideRects', () => {
  it('builds selection bounds and returns null for an empty selection', () => {
    expect(unionGuideRects([rect('a', -20, 10, 40, 30), rect('b', 50, -10, 20, 80)])).toEqual({
      id: 'selection', x: -20, y: -10, width: 90, height: 80,
    })
    expect(unionGuideRects([])).toBeNull()
  })
})
