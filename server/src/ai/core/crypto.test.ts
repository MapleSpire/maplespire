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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aiCryptoAvailable, decryptSecret, encryptSecret, hashToken, keyHint, tokenHashEquals } from './crypto.js'

describe('ai/crypto', () => {
  const savedAi = process.env.AI_KEY_SECRET
  const savedAuth = process.env.AUTH_SECRET

  beforeEach(() => {
    process.env.AI_KEY_SECRET = 'unit-test-secret'
    delete process.env.AUTH_SECRET
  })
  afterEach(() => {
    if (savedAi === undefined) delete process.env.AI_KEY_SECRET
    else process.env.AI_KEY_SECRET = savedAi
    if (savedAuth === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = savedAuth
  })

  it('round-trips a secret', () => {
    const blob = encryptSecret('sk-super-secret-key-1234')
    expect(blob.startsWith('v1:')).toBe(true)
    expect(blob).not.toContain('sk-super-secret')
    expect(decryptSecret(blob)).toBe('sk-super-secret-key-1234')
  })

  it('produces a different blob per encryption (fresh IV) that still decrypts', () => {
    const a = encryptSecret('same')
    const b = encryptSecret('same')
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe('same')
    expect(decryptSecret(b)).toBe('same')
  })

  it('returns null on tamper, wrong version, garbage, and wrong key', () => {
    const blob = encryptSecret('value')
    const [v, iv, tag, ct] = blob.split(':')
    const flipped = ct.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))
    expect(decryptSecret(`${v}:${iv}:${tag}:${flipped}`)).toBeNull()
    expect(decryptSecret(`v9:${iv}:${tag}:${ct}`)).toBeNull()
    expect(decryptSecret('not-a-blob')).toBeNull()
    process.env.AI_KEY_SECRET = 'rotated-secret'
    expect(decryptSecret(blob)).toBeNull() // key rotation → caller surfaces re-enter-key
  })

  it('falls back to AUTH_SECRET and reports availability', () => {
    delete process.env.AI_KEY_SECRET
    expect(aiCryptoAvailable()).toBe(false)
    expect(() => encryptSecret('x')).toThrow(/AI_KEY_SECRET/)
    process.env.AUTH_SECRET = 'auth-secret'
    expect(aiCryptoAvailable()).toBe(true)
    expect(decryptSecret(encryptSecret('x'))).toBe('x')
  })

  it('treats empty interpolation values as absent and still uses a non-empty fallback', () => {
    process.env.AI_KEY_SECRET = '   '
    process.env.AUTH_SECRET = ''
    expect(aiCryptoAvailable()).toBe(false)
    expect(() => encryptSecret('x')).toThrow(/AI_KEY_SECRET/)

    process.env.AUTH_SECRET = ' auth-fallback '
    expect(aiCryptoAvailable()).toBe(true)
    const blob = encryptSecret('x')
    expect(decryptSecret(blob)).toBe('x')
    process.env.AUTH_SECRET = 'auth-fallback'
    expect(decryptSecret(blob)).toBeNull()
  })

  it('keyHint masks all but the tail', () => {
    expect(keyHint('sk-abcdef123456')).toBe('…3456')
    expect(keyHint('ab')).toBe('…')
  })

  it('hashToken is deterministic and constant-time comparable', () => {
    const h1 = hashToken('bvr_token')
    expect(h1).toBe(hashToken('bvr_token'))
    expect(h1).not.toBe(hashToken('bvr_other'))
    expect(tokenHashEquals(h1, hashToken('bvr_token'))).toBe(true)
    expect(tokenHashEquals(h1, hashToken('bvr_other'))).toBe(false)
  })
})
