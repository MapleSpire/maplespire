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
import { resolveAiPublicBaseUrl } from './api'

describe('resolveAiPublicBaseUrl', () => {
  it('uses the browser origin for same-origin production builds', () => {
    expect(resolveAiPublicBaseUrl('', 'https://maplespire.ca')).toBe('https://maplespire.ca')
  })

  it('keeps an explicitly configured API origin', () => {
    expect(resolveAiPublicBaseUrl('https://api.maplespire.ca/', 'https://maplespire.ca')).toBe(
      'https://api.maplespire.ca'
    )
  })
})
