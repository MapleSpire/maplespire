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
import type { SessionClaims } from './tokens.js'
import { createSessionEpochValidator, currentOrgEpoch, isSessionEpochCurrent } from './sessionEpoch.js'

const claims: SessionClaims = {
  userId: 'user-1',
  orgId: 'org-1',
  isPlatformAdmin: false,
  epoch: 7,
}

describe('session authorization epoch', () => {
  it('coerces PostgreSQL BIGINT strings and defaults an absent row to epoch 1', async () => {
    const withRow = { query: vi.fn(async () => ({ rows: [{ epoch: '7' }] })) }
    const withoutRow = { query: vi.fn(async () => ({ rows: [] })) }

    await expect(currentOrgEpoch(withRow as never, 'org-1')).resolves.toBe(7)
    await expect(currentOrgEpoch(withoutRow as never, 'org-new')).resolves.toBe(1)
  })

  it('rejects a cryptographically valid session after the organization epoch advances', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ epoch: '8' }] })) }

    await expect(isSessionEpochCurrent(db as never, claims)).resolves.toBe(false)
    expect(db.query).toHaveBeenCalledWith(
      'SELECT epoch FROM auth_epochs WHERE org_id = $1',
      ['org-1'],
    )
  })

  it('requires exact equality instead of accepting an impossible future epoch', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ epoch: '6' }] })) }
    await expect(isSessionEpochCurrent(db as never, claims)).resolves.toBe(false)
  })

  it('propagates an unavailable epoch store so the transport can fail closed', async () => {
    const db = { query: vi.fn(async () => { throw new Error('database unavailable') }) }
    await expect(isSessionEpochCurrent(db as never, claims)).rejects.toThrow('database unavailable')
  })

  it('accepts the current epoch and org-less platform sessions without a query', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ epoch: '7' }] })) }
    await expect(isSessionEpochCurrent(db as never, claims)).resolves.toBe(true)

    const orgless = { ...claims, orgId: null }
    db.query.mockClear()
    await expect(isSessionEpochCurrent(db as never, orgless)).resolves.toBe(true)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('coalesces concurrent reads and absorbs sequential reconnect waves within a bounded window', async () => {
    let now = 1_000
    let release!: (value: { rows: Array<{ epoch: string }> }) => void
    const first = new Promise<{ rows: Array<{ epoch: string }> }>((resolve) => {
      release = resolve
    })
    const db = {
      query: vi.fn()
        .mockReturnValueOnce(first)
        .mockResolvedValue({ rows: [{ epoch: '8' }] }),
    }
    const validate = createSessionEpochValidator(db as never, { cacheTtlMs: 500, now: () => now })

    const burst = Array.from({ length: 50 }, () => validate(claims))
    expect(db.query).toHaveBeenCalledTimes(1)
    release({ rows: [{ epoch: '7' }] })
    await expect(Promise.all(burst)).resolves.toEqual(Array.from({ length: 50 }, () => true))

    await expect(validate(claims)).resolves.toBe(true)
    expect(db.query).toHaveBeenCalledTimes(1)

    now += 501
    await expect(validate(claims)).resolves.toBe(false)
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('can disable the burst cache for immediate revalidation', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ epoch: '7' }] }) }
    const validate = createSessionEpochValidator(db as never, { cacheTtlMs: 0 })

    await validate(claims)
    await validate(claims)
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('clears a failed epoch flight and remains fail closed', async () => {
    const db = {
      query: vi.fn()
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValue({ rows: [{ epoch: '7' }] }),
    }
    const validate = createSessionEpochValidator(db as never)

    await expect(validate(claims)).rejects.toThrow('database unavailable')
    await expect(validate(claims)).resolves.toBe(true)
    expect(db.query).toHaveBeenCalledTimes(2)
  })
})
