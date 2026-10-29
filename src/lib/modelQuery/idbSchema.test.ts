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
  MODEL_READ_CACHE_VERSION,
  normalizeModelSearchText,
  objectSearchTrigramKeys,
  objectSearchTrigramPrefix,
  searchTrigrams,
} from './idbSchema'

describe('model read cache search normalization', () => {
  it('normalizes case, accents and repeated whitespace', () => {
    expect(normalizeModelSearchText('  Càfé   Checkout  ')).toBe('cafe checkout')
  })

  it('creates unique trigrams without whole-model tokens', () => {
    expect(searchTrigrams('aaaa')).toEqual(['aaa'])
    expect(searchTrigrams('ab')).toEqual([])
    expect(searchTrigrams('Node.js')).toEqual(['nod', 'ode', 'de.', 'e.j', '.js'])
  })

  it('uses the schema that indexes the Model Viewer level by C4 parent', () => {
    expect(MODEL_READ_CACHE_VERSION).toBe(8)
  })

  it('embeds the normalized name in scoped multi-entry object trigram keys', () => {
    expect(objectSearchTrigramPrefix('ls:v1', 7, 'che')).toBe('ls%3Av1\u00017\u0001che\u0001')
    expect(objectSearchTrigramKeys('ls:v1', 7, 'checkout api', 'checkout api')).toContain(
      'ls%3Av1\u00017\u0001che\u0001checkout api',
    )
  })
})
