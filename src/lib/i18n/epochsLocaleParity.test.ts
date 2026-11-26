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
import en from './locales/en/epochs.json'
import fr from './locales/fr/epochs.json'

/** Every leaf key path of a locale tree. */
function leafKeys(tree: unknown, prefix = ''): string[] {
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) return [prefix]
  return Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) => leafKeys(value, prefix ? `${prefix}.${key}` : key))
}

/**
 * G4-16f: the epoch strings are tested through a `t` that returns the key, so a key missing
 * from one locale broke nothing. The two trees must name the same keys, and
 * no value may be empty.
 */
describe('epochs.json: en and fr name the same keys', () => {
  it('the same leaf keys, none empty', () => {
    expect(leafKeys(fr).sort()).toEqual(leafKeys(en).sort())
    for (const locale of [en, fr]) {
      for (const key of leafKeys(locale)) {
        const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], locale)
        expect(typeof value === 'string' && value.trim().length > 0, key).toBe(true)
      }
    }
  })
})
