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
import { pinnedCacheNeedsRefresh, shouldCacheBoundedServerPage } from './cacheGenerationPolicy'

const fullPinned = {
  coverage: 'full' as const,
  pinned: true,
  serverGeneration: 12,
}

describe('bounded server page cache policy', () => {
  it('never demotes an explicit complete offline copy to a working set', () => {
    expect(shouldCacheBoundedServerPage(fullPinned)).toBe(false)
  })

  it('continues caching ordinary and unpinned working sets', () => {
    expect(shouldCacheBoundedServerPage(undefined)).toBe(true)
    expect(shouldCacheBoundedServerPage({ ...fullPinned, pinned: false })).toBe(true)
    expect(shouldCacheBoundedServerPage({ ...fullPinned, coverage: 'working-set' })).toBe(true)
  })

  it('requests an incremental refresh only when the server is ahead', () => {
    expect(pinnedCacheNeedsRefresh(fullPinned, 13)).toBe(true)
    expect(pinnedCacheNeedsRefresh(fullPinned, 12)).toBe(false)
    expect(pinnedCacheNeedsRefresh({ ...fullPinned, pinned: false }, 13)).toBe(false)
  })
})
