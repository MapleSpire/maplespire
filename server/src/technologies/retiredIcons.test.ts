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
import { ICON_CATALOG, RETIRED_ICON_PATHS } from '../ai/core/tools/iconCatalog.gen.js'
import { TechnologyInputError, validateTechnologyRevisionInput } from './normalize.js'

const input = (iconLightPath: string) => ({
  name: 'Private Oracle Database',
  iconLightPath,
  recommendedShapeTypes: ['store'],
  defaultRole: 'database',
})

describe('artwork paths of re-artworked catalog entries', () => {
  // Oracle Database's wordmark, replaced on 2026-10-11. Private technologies
  // and drafts saved before that still carry it; refusing it made any edit of
  // those records a 400.
  const ORACLE_WORDMARK = '/icons/light/oracle-database-3dace2e5.png'

  it('keeps the previous artwork of every replaced entry', () => {
    expect(RETIRED_ICON_PATHS).toContain(ORACLE_WORDMARK)
    const current = new Set(ICON_CATALOG.flatMap((icon) => [icon.iconLight, icon.iconDark]))
    expect(RETIRED_ICON_PATHS.filter((path) => current.has(path))).toEqual([])
  })

  it('still accepts a retired path as icon input', () => {
    expect(validateTechnologyRevisionInput(input(ORACLE_WORDMARK)).iconLightPath).toBe(ORACLE_WORDMARK)
  })

  it('still refuses a path that was never in the catalog', () => {
    expect(() => validateTechnologyRevisionInput(input('/icons/light/NeverPublished000000.png')))
      .toThrow(TechnologyInputError)
  })
})
