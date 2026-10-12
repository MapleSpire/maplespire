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
import { reconciledCachedChildCount } from './cachedHierarchy'

describe('cached hierarchy disclosure', () => {
  it('removes a stale child summary when the active generation has no child row', () => {
    expect(reconciledCachedChildCount(1, false)).toBe(0)
  })

  it('restores disclosure as soon as children are indexed locally', () => {
    expect(reconciledCachedChildCount(0, true)).toBe(1)
  })

  it('keeps an authoritative server summary after proving one local child exists', () => {
    expect(reconciledCachedChildCount(42, true)).toBe(42)
  })
})
