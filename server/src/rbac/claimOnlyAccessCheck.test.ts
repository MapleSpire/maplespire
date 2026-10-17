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

import { describe, expect, it, vi } from 'vitest'
import { accessCheckMode, createClaimOnlyAccessCheck } from './claimOnlyAccessCheck.js'

describe('accessCheckMode', () => {
  it('enforces nothing only at AUTH off with routing optional — every other configuration enforces', () => {
    expect(accessCheckMode('off', false)).toBe('claim-only')
    expect(accessCheckMode('off', true)).toBe('enforcing')
    expect(accessCheckMode('dual', false)).toBe('enforcing')
    expect(accessCheckMode('dual', true)).toBe('enforcing')
    expect(accessCheckMode('on', false)).toBe('enforcing')
    expect(accessCheckMode('on', true)).toBe('enforcing')
  })
})

describe('createClaimOnlyAccessCheck', () => {
  it('runs the route gate for its claim, with the peer and document it was asked about', async () => {
    const routeCheck = vi.fn().mockResolvedValue(true)
    await expect(createClaimOnlyAccessCheck(routeCheck)('peer-1', 'doc-1')).resolves.toBe(true)
    expect(routeCheck).toHaveBeenCalledWith('peer-1', 'doc-1')
  })

  it('admits what the route gate would deny — nothing is enforced at AUTH off with routing optional', async () => {
    await expect(createClaimOnlyAccessCheck(vi.fn().mockResolvedValue(false))('peer', 'doc')).resolves.toBe(true)
  })

  it('does not wait for the route gate: a gate that never settles still admits', async () => {
    const never = new Promise<boolean>(() => {})
    const verdict = await Promise.race([
      createClaimOnlyAccessCheck(() => never)('peer', 'doc'),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
    ])
    expect(verdict).toBe(true)
  })

  it('reports a rejected or throwing route gate instead of failing the admission', async () => {
    const onError = vi.fn()
    const rejected = new Error('sql down')
    await expect(createClaimOnlyAccessCheck(() => Promise.reject(rejected), onError)('p', 'doc-r')).resolves.toBe(true)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('doc-r', rejected))

    const thrown = new Error('sync throw')
    const throwing = (() => { throw thrown }) as unknown as (p: string, d: string) => Promise<boolean>
    await expect(createClaimOnlyAccessCheck(throwing, onError)('p', 'doc-t')).resolves.toBe(true)
    expect(onError).toHaveBeenCalledWith('doc-t', thrown)
  })
})
