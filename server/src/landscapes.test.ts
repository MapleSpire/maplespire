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

import { describe, it, expect } from 'vitest'
import { effectiveVersionId } from './landscapes.js'

describe('effectiveVersionId (current-version sentinel resolution)', () => {
  it("resolves the 'current' sentinel to the landscape's default version", () => {
    expect(effectiveVersionId('current', 'v-default')).toBe('v-default')
  })

  it('treats missing/null versionId as the default version', () => {
    expect(effectiveVersionId(undefined, 'v-default')).toBe('v-default')
    expect(effectiveVersionId(null, 'v-default')).toBe('v-default')
  })

  it('passes a specific version id through unchanged', () => {
    expect(effectiveVersionId('v-123', 'v-default')).toBe('v-123')
  })

  it('returns null when there is no default and no specific version', () => {
    expect(effectiveVersionId('current', null)).toBeNull()
    expect(effectiveVersionId(undefined, null)).toBeNull()
  })
})
