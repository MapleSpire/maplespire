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
import {
  virtualGridColumnCount,
  virtualGridRowCount,
  virtualGridRowItems,
} from './virtualGridLayout'

describe('VirtualGrid layout', () => {
  it('converts the responsive card grid into virtual rows', () => {
    expect(virtualGridColumnCount(1_000, 232, 16)).toBe(4)
    expect(virtualGridRowCount(30_000, 4)).toBe(7_500)
  })

  it('materializes only the cards belonging to a requested virtual row', () => {
    const diagrams = Array.from({ length: 30_000 }, (_, index) => `diagram-${index}`)
    expect(virtualGridRowItems(diagrams, 4, 2_000)).toEqual([
      'diagram-8000',
      'diagram-8001',
      'diagram-8002',
      'diagram-8003',
    ])
  })
})
