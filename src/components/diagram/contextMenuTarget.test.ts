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
import { usesMultiSelectMenu } from './contextMenuTarget'
import type { SelectedItem } from '../../types'

const obj = (id: string): SelectedItem => ({ id, type: 'object' })

/**
 * The regression this file guards: right-clicking a shape OUTSIDE a
 * multi-selection must not open the multi-selection menu, whose Delete calls
 * `deleteSelectedItems()` — the user would delete shapes they were not pointing
 * at, irreversibly, in an app with no undo.
 *
 * Right-click deliberately does not change the selection (`CanvasEngine`
 * returns early for `e.button === 2`), which is why membership has to be tested
 * explicitly rather than inferred from the count.
 */
describe('usesMultiSelectMenu', () => {
  it('THE BUG: a right-click outside the selection does not get the multi menu', () => {
    // Select Y and Z, right-click X. A count-only gate sees "2 objects
    // selected" and offers to delete Y and Z from a menu anchored on X.
    expect(usesMultiSelectMenu('X', [obj('Y'), obj('Z')])).toBe(false)
  })

  it('acts on the whole selection when the click IS inside it', () => {
    expect(usesMultiSelectMenu('Y', [obj('Y'), obj('Z')])).toBe(true)
  })

  it('is single-shape for a lone selection, even when that shape is the one clicked', () => {
    expect(usesMultiSelectMenu('Y', [obj('Y')])).toBe(false)
  })

  it('is single-shape when nothing is selected at all', () => {
    expect(usesMultiSelectMenu('Y', [])).toBe(false)
  })

  it('counts OBJECTS only — groups and connections are not deleted by this menu', () => {
    // `deleteSelectedItems` acts on the selection, but the multi menu is an
    // object-shape menu; counting a selected group toward the ">1" would open
    // it for what is really a single-object selection.
    expect(usesMultiSelectMenu('Y', [obj('Y'), { id: 'g1', type: 'group' }])).toBe(false)
    expect(usesMultiSelectMenu('Y', [obj('Y'), { id: 'c1', type: 'connection' }])).toBe(false)
  })

  it('is single-shape when the click hit no object at all', () => {
    expect(usesMultiSelectMenu(null, [obj('Y'), obj('Z')])).toBe(false)
    expect(usesMultiSelectMenu(undefined, [obj('Y'), obj('Z')])).toBe(false)
  })
})
