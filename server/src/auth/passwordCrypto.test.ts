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
import { hashPassword, verificationTokenHash, verifyPassword } from './passwordCrypto.js'

describe('local password authentication crypto', () => {
  it('stores a salted scrypt envelope and verifies only the original password', async () => {
    const first = await hashPassword('correct horse battery staple')
    const second = await hashPassword('correct horse battery staple')

    expect(first).toMatch(/^scrypt\$16384\$8\$1\$/)
    expect(first).not.toBe(second)
    expect(await verifyPassword('correct horse battery staple', first)).toBe(true)
    expect(await verifyPassword('wrong horse battery staple', first)).toBe(false)
    expect(await verifyPassword('correct horse battery staple', 'malformed')).toBe(false)
  })

  it('hashes verification tokens deterministically without storing the token', () => {
    expect(verificationTokenHash('one-time-token')).toMatch(/^[a-f0-9]{64}$/)
    expect(verificationTokenHash('one-time-token')).toBe(verificationTokenHash('one-time-token'))
    expect(verificationTokenHash('one-time-token')).not.toBe(verificationTokenHash('another-token'))
  })
})
