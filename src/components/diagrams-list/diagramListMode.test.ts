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
import { shouldUseServerPagedDiagrams } from './diagramListMode'

describe('shouldUseServerPagedDiagrams', () => {
  it('pages an editable summary-only performance registry', () => {
    expect(shouldUseServerPagedDiagrams({
      canManage: true,
      serverReadModelEnabled: true,
      registrySummaryOnly: true,
    })).toBe(true)
  })

  it('keeps an ordinary editable resident registry local', () => {
    expect(shouldUseServerPagedDiagrams({
      canManage: true,
      serverReadModelEnabled: true,
      registrySummaryOnly: false,
    })).toBe(false)
  })

  it('keeps the existing read-only server-paged behavior', () => {
    expect(shouldUseServerPagedDiagrams({
      canManage: false,
      serverReadModelEnabled: true,
      registrySummaryOnly: false,
    })).toBe(true)
  })
})
