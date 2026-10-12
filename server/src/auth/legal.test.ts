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
import { LEGAL_VERSION, isCurrentLegalVersion, legalRequestAccepted } from './legal.js'

describe('legal acceptance gate', () => {
  afterEach(() => delete process.env.AUTH_LEGAL_ACCEPTANCE)

  it('accepts only the published version when enforcement is enabled', () => {
    process.env.AUTH_LEGAL_ACCEPTANCE = 'on'
    expect(isCurrentLegalVersion(LEGAL_VERSION)).toBe(true)
    expect(legalRequestAccepted(LEGAL_VERSION)).toBe(true)
    expect(legalRequestAccepted(undefined)).toBe(false)
    expect(legalRequestAccepted('2026-01-01')).toBe(false)
  })

  it('keeps local and test stacks backwards compatible until explicitly enabled', () => {
    expect(legalRequestAccepted(undefined)).toBe(true)
  })
})
