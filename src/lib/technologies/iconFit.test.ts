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
import { containIconRect } from './iconFit'

describe('containIconRect', () => {
  it('fills the box with a square image', () => {
    expect(containIconRect(128, 128, 10, 20, 20)).toEqual({ x: 10, y: 20, width: 20, height: 20 })
  })

  it('fits a wide image to the box width, centred vertically', () => {
    expect(containIconRect(400, 100, 0, 0, 20)).toEqual({ x: 0, y: 7.5, width: 20, height: 5 })
  })

  it('fits a tall image to the box height, centred horizontally', () => {
    expect(containIconRect(30, 120, 100, 100, 128)).toEqual({ x: 100 + 48, y: 100, width: 32, height: 128 })
  })

  it('falls back to the whole box when the natural size is unknown', () => {
    expect(containIconRect(0, 0, 1, 2, 20)).toEqual({ x: 1, y: 2, width: 20, height: 20 })
    expect(containIconRect(64, Number.NaN, 1, 2, 20)).toEqual({ x: 1, y: 2, width: 20, height: 20 })
  })
})
