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
import { centeredObjectContentTop, fitObjectDescription, objectContentLayout } from './objectContentLayout'

describe('objectContentLayout', () => {
  it('keeps the icon, title, description and type badge on one centered vertical axis', () => {
    expect(objectContentLayout({
      x: 40,
      y: 80,
      width: 160,
      height: 100,
      contentTop: 3,
    })).toEqual({
      centerX: 120,
      iconCenterY: 105,
      titleTopY: 121,
      descriptionTopY: 137,
      typeBadgeTopY: 160,
    })
  })

  it('works with negative off-window coordinates without changing relative spacing', () => {
    const layout = objectContentLayout({ x: -310, y: -90, width: 200, height: 120 })

    expect(layout.centerX).toBe(-210)
    expect(layout.titleTopY - layout.iconCenterY).toBe(16)
    expect(layout.descriptionTopY - layout.titleTopY).toBe(16)
    expect(layout.typeBadgeTopY).toBe(10)
  })

  it('centres the identity stack while reserving the 2D type-badge space', () => {
    expect(centeredObjectContentTop({
      height: 100,
      descriptionLines: 1,
      hasBadge: true,
    })).toBe(2)
    expect(centeredObjectContentTop({
      height: 100,
      descriptionLines: 1,
      hasBadge: false,
    })).toBe(10)
  })

  it('fits a compact description into at most two lines before shrinking', () => {
    const fitted = fitObjectDescription({
      text: 'A concise summary that should wrap cleanly over two balanced lines',
      maxWidth: 185,
      measureText: (text, size) => text.length * size * 0.5,
    })

    expect(fitted.lines).toHaveLength(2)
    expect(fitted.fontSize).toBe(10.5)
    expect(fitted.truncated).toBe(false)
    expect(fitted.lines.every((line) => line.length * fitted.fontSize * 0.5 <= 185)).toBe(true)
  })

  it('ellipsizes the second line at the readable floor instead of overflowing', () => {
    const fitted = fitObjectDescription({
      text: 'This deliberately verbose short description contains enough words to overflow every possible compact two line layout on a small card',
      maxWidth: 112,
      measureText: (text, size) => text.length * size * 0.55,
    })

    expect(fitted.lines).toHaveLength(2)
    expect(fitted.fontSize).toBe(9)
    expect(fitted.truncated).toBe(true)
    expect(fitted.lines[1].endsWith('…')).toBe(true)
    expect(fitted.lines.every((line) => line.length * fitted.fontSize * 0.55 <= 112)).toBe(true)
  })

  it('shrinks two lines enough to preserve the gap above the type badge', () => {
    const fitted = fitObjectDescription({
      text: 'A compact description that fills both available lines',
      maxWidth: 190,
      maxHeight: 21,
      measureText: (text, size) => text.length * size * 0.5,
    })

    expect(fitted.lines).toHaveLength(2)
    expect(fitted.fontSize).toBe(9)
    expect(fitted.lines.length * fitted.fontSize * 1.15).toBeLessThanOrEqual(21)
  })
})
