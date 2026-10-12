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
  objectDetailedDescription,
  objectShortDescription,
  separateObjectDescription,
  separateObjectShortDescription,
} from './objectDescription'

describe('objectShortDescription', () => {
  it('keeps legacy descriptions visible until a separate short description is saved', () => {
    expect(objectShortDescription({ description: 'Legacy summary' })).toBe('Legacy summary')
    expect(objectDetailedDescription({ description: 'Legacy summary' })).toBeUndefined()
  })

  it('never falls back to detailed Markdown once the compact field exists', () => {
    expect(objectShortDescription({ shortDescription: 'Compact', description: '# Detailed' })).toBe('Compact')
    expect(objectDetailedDescription({ shortDescription: 'Compact', description: '# Detailed' })).toBe('# Detailed')
    expect(objectShortDescription({ shortDescription: '', description: '# Detailed' })).toBeUndefined()
  })

  it('materializes the legacy compact label before the first detailed edit', () => {
    expect(separateObjectDescription({ description: 'Legacy summary' }, '# New details')).toEqual({
      shortDescription: 'Legacy summary',
      description: '# New details',
    })
  })

  it('retires the legacy overloaded value when the compact label is edited first', () => {
    expect(separateObjectShortDescription({ description: 'Legacy summary' }, 'New compact')).toEqual({
      shortDescription: 'New compact',
      description: '',
    })
  })
})
