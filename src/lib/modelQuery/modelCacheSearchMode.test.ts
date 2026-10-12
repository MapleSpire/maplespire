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
import { modelCacheSearchMode } from './modelCacheSearchMode'

describe('model cache search mode', () => {
  it('uses the name index as a paged browse for an empty picker query', () => {
    expect(modelCacheSearchMode('')).toBe('browse')
  })

  it('keeps the two-character enterprise search threshold', () => {
    expect(modelCacheSearchMode('a')).toBe('too-short')
    expect(modelCacheSearchMode('ap')).toBe('search')
  })
})
