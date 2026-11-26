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
import { displayValue, fieldLabel } from './epochOverrideValue'

const t = (key: string) => `[${key}]`

describe('fieldLabel', () => {
  it('a known field is translated; a whole entity reads per collection', () => {
    expect(fieldLabel('name', 'objects', t)).toBe('[epochs.overrides.field.name]')
    expect(fieldLabel('*', 'connections', t)).toBe('[epochs.overrides.wholeEntity.connections]')
    expect(fieldLabel('', null, t)).toBe('[epochs.overrides.wholeEntity.objects]')
  })
  it('a nested path keeps its tail under the translated field', () => {
    expect(fieldLabel('properties.k', 'objects', t)).toBe('[epochs.overrides.field.properties] › k')
    expect(fieldLabel('properties.a.b', 'objects', t)).toBe('[epochs.overrides.field.properties] › a.b')
  })
  it('an unknown field stays as it is', () => {
    expect(fieldLabel('zIndex', 'objects', t)).toBe('zIndex')
  })
})

describe('displayValue', () => {
  it('empty reads as a dash; long JSON is cut', () => {
    expect(displayValue('')).toBe('—')
    expect(displayValue(null)).toBe('—')
    expect(displayValue({ a: 'x'.repeat(100) }).endsWith('…')).toBe(true)
  })
})
