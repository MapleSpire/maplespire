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
import { requestPublicBaseUrl } from './publicBaseUrl.js'

function request(protocol: string, headers: Record<string, string>) {
  return {
    protocol,
    get(name: string) {
      return headers[name.toLowerCase()]
    },
  }
}

describe('requestPublicBaseUrl', () => {
  it('uses the forwarded HTTPS scheme from the trusted same-origin proxy', () => {
    expect(
      requestPublicBaseUrl(request('http', {
        host: 'maplespire.ca',
        'x-forwarded-proto': 'https',
      }))
    ).toBe('https://maplespire.ca')
  })

  it('falls back to the direct request protocol', () => {
    expect(requestPublicBaseUrl(request('http', { host: 'localhost:3001' }))).toBe('http://localhost:3001')
  })
})
