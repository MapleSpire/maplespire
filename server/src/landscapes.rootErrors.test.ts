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

/**
 * `resolveRootUrl`'s failed-read branch, without a database.
 *
 * `landscapes.repoint.integration.test.ts` pins it against a real failed read,
 * but skips without `TEST_DATABASE_URL`. The explicit callers this branch
 * protects — the projector fleet, the AI tool context, compaction, decision
 * records — have no test of their own for it, so a revert would otherwise be
 * green in every run without a database.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('./db.js', () => ({ pool: { query } }))

const { resolveRootUrl } = await import('./landscapes.js')

const PRIMARY = 'automerge:primary-root'

afterEach(() => {
  query.mockReset()
})

describe('resolveRootUrl — a failed read', () => {
  it('THROWS for an explicit ref, whichever read failed', async () => {
    const failure = new Error('connection terminated')
    query.mockRejectedValueOnce(failure)
    await expect(resolveRootUrl('L', 'current', PRIMARY)).rejects.toBe(failure)

    query
      .mockResolvedValueOnce({ rows: [{ default_version_id: 'v1' }] })
      .mockRejectedValueOnce(failure)
    await expect(resolveRootUrl('L', 'v1', PRIMARY)).rejects.toBe(failure)

    // Either half makes a ref explicit: a version with no landscape names one too.
    query.mockRejectedValueOnce(failure)
    await expect(resolveRootUrl(undefined, 'v1', PRIMARY)).rejects.toBe(failure)
    expect(query).toHaveBeenCalledTimes(4)
  })

  it('answers the fallback for the no-params call, and only there', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      query.mockRejectedValueOnce(new Error('connection terminated'))
      await expect(resolveRootUrl(undefined, undefined, PRIMARY)).resolves.toBe(PRIMARY)
      expect(query).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
    }
  })

  it('reads an empty landscape id as the landscape "", as canonicalWorkspaceKey does', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    await expect(resolveRootUrl('', 'current', PRIMARY)).resolves.toBeNull()
    expect(query.mock.calls[0]?.[1]).toEqual([''])
    // Control: no landscape at all is the default one.
    query.mockResolvedValueOnce({ rows: [] })
    await expect(resolveRootUrl(undefined, undefined, PRIMARY)).resolves.toBe(PRIMARY)
    expect(query.mock.calls[1]?.[1]).toEqual(['default'])
  })

  it('control: a successful read answers the root, not the fallback', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ default_version_id: 'v1' }] })
      .mockResolvedValueOnce({ rows: [{ root_url: 'automerge:root-of-v1' }] })
    await expect(resolveRootUrl('L', 'current', PRIMARY)).resolves.toBe('automerge:root-of-v1')
  })
})
