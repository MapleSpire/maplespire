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
import { mergeBoundedPageItems, mergeUniquePageItems } from './pageMerge'

describe('mergeUniquePageItems', () => {
  it('appends cursor pages without duplicates and refreshes repeated rows in place', () => {
    const merged = mergeUniquePageItems(
      [{ id: 'a', name: 'A' }, { id: 'b', name: 'old B' }],
      [{ id: 'b', name: 'new B' }, { id: 'c', name: 'C' }, { id: 'c', name: 'latest C' }],
    )

    expect(merged).toEqual([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'new B' },
      { id: 'c', name: 'latest C' },
    ])
  })

  it('replaces an old query window while still deduplicating the first page', () => {
    expect(mergeUniquePageItems(
      [{ id: 'stale', name: 'Stale' }],
      [{ id: 'result', name: 'first' }, { id: 'result', name: 'last' }],
      true,
    )).toEqual([{ id: 'result', name: 'last' }])
  })

  it('enforces a bounded resident window instead of accumulating every page', () => {
    const result = mergeBoundedPageItems(
      Array.from({ length: 4 }, (_, index) => ({ id: `old-${index}` })),
      [{ id: 'new-1' }, { id: 'new-2' }],
      5,
    )
    expect(result.items.map((item) => item.id)).toEqual([
      'old-0', 'old-1', 'old-2', 'old-3', 'new-1',
    ])
    expect(result.limited).toBe(true)
  })
})
