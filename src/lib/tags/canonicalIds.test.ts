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

import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetTagCanonicalIdsForTest, canonicalTagId, equivalentTagIds, registerTagCanonicalIds,
} from './canonicalIds'

afterEach(__resetTagCanonicalIdsForTest)

describe('Tag canonical identities', () => {
  it('expands a canonical selection to loaded historical source IDs', () => {
    registerTagCanonicalIds([{
      id: 'risk-high', canonicalTagId: 'risk-critical', redirectedFromIds: ['risk-severe'],
    }])
    expect(canonicalTagId('risk-high')).toBe('risk-critical')
    expect(new Set(equivalentTagIds(['risk-critical']))).toEqual(
      new Set(['risk-critical', 'risk-high', 'risk-severe'])
    )
  })
})
