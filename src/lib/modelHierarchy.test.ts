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
import { canReparentObject } from './modelHierarchy'

describe('canReparentObject', () => {
  it('allows a store to move under a system', () => {
    expect(canReparentObject('store', 'system')).toBe(true)
  })

  it('only allows components under containers', () => {
    expect(canReparentObject('component', 'app')).toBe(true)
    expect(canReparentObject('component', 'store')).toBe(true)
    expect(canReparentObject('component', 'system')).toBe(false)
  })

  it('does not create invalid C4 nesting', () => {
    expect(canReparentObject('system', 'system')).toBe(false)
    expect(canReparentObject('store', 'app')).toBe(false)
    expect(canReparentObject('actor', 'system')).toBe(false)
  })
})
