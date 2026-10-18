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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  catalogIconArtwork,
  isIconCatalogLoading,
  loadIconCatalog,
  resetIconCatalogForTests,
  shapeIconArtwork,
} from './shapeIconArtwork'
import { getIconByName } from '../techIcons'

beforeEach(() => resetIconCatalogForTests())

describe('shapeIconArtwork', () => {
  it('returns the assignment as-is, without loading the catalog', () => {
    const iconAssignment = {
      source: 'generic' as const, mode: 'explicit' as const, displayName: 'X', iconLightPath: '/icons/light/x.png',
    }
    expect(shapeIconArtwork({ icon: 'React', iconAssignment })).toBe(iconAssignment)
    expect(isIconCatalogLoading()).toBe(false)
  })

  it('loads the catalog for a bare name, notifies once, then resolves case-insensitively', async () => {
    const ready = vi.fn()
    expect(shapeIconArtwork({ icon: 'React' }, ready)).toBeUndefined()
    expect(isIconCatalogLoading()).toBe(true)
    await loadIconCatalog()
    expect(ready).toHaveBeenCalledTimes(1)
    expect(isIconCatalogLoading()).toBe(false)
    // Expected paths come from the catalog itself: the artwork files differ
    // between distributions, the resolution rule does not.
    const react = getIconByName('React')!
    expect(react.iconLight).toMatch(/^\/icons\//)
    expect(shapeIconArtwork({ icon: 'react' })).toEqual({
      iconLightPath: react.iconLight,
      ...(react.iconDark ? { iconDarkPath: react.iconDark } : {}),
    })
  })

  it('has no artwork for an unknown name or an empty icon', async () => {
    await loadIconCatalog()
    expect(catalogIconArtwork('NotARealIconXYZ')).toBeUndefined()
    expect(shapeIconArtwork({ icon: '  ' })).toBeUndefined()
    expect(shapeIconArtwork({})).toBeUndefined()
  })
})
