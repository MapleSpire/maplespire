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
import { IncompleteCollectionError, pageAllComplete } from './pageAllComplete'

const page = (objects: unknown[], nextCursor: string | null) =>
  new Response(JSON.stringify({ objects, nextCursor }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const refused = (status = 503) =>
  new Response(JSON.stringify({ error: 'nope' }), { status })

const options = { workspaceParams: 'landscapeId=L-1&versionId=V-1' }

describe('pageAllComplete — a partial collection is never returned as a whole one', () => {
  it('returns every row across pages when the server finishes', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page([{ id: 'a' }], 'cur-1'))
      .mockResolvedValueOnce(page([{ id: 'b' }], 'cur-2'))
      .mockResolvedValueOnce(page([{ id: 'c' }], null))

    const rows = await pageAllComplete('page-objects', 'objects', {
      ...options, fetchImpl: fetchImpl as never,
    })

    expect(rows).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('THROWS when a later page is refused — the defect this exists for', async () => {
    // Returning the three pages that arrived before page 4 of 12 was refused
    // would let the caller merge them into a file that looks complete.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page([{ id: 'a' }], 'cur-1'))
      .mockResolvedValueOnce(page([{ id: 'b' }], 'cur-2'))
      .mockResolvedValueOnce(refused())

    await expect(pageAllComplete('page-objects', 'objects', {
      ...options, fetchImpl: fetchImpl as never,
    })).rejects.toBeInstanceOf(IncompleteCollectionError)
  })

  it('carries what it managed, so an operator can tell a blip from a wall', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page([{ id: 'a' }], 'cur-1'))
      .mockResolvedValueOnce(refused(500))

    await expect(pageAllComplete('page-objects', 'objects', {
      ...options, fetchImpl: fetchImpl as never,
    })).rejects.toMatchObject({ pagesFetched: 1, status: 500, path: 'page-objects' })
  })

  it('KEEPS the offline fallback: nothing fetched at all is [] and not a throw', async () => {
    // This is the half that must not regress. The callers merge the server's
    // rows over the RESIDENT window, so `[]` means "use what is resident" —
    // which is exactly right when the server cannot be reached, and is what
    // makes an export work offline at all.
    const fetchImpl = vi.fn().mockResolvedValue(refused())

    await expect(pageAllComplete('page-objects', 'objects', {
      ...options, fetchImpl: fetchImpl as never,
    })).resolves.toEqual([])
  })

  it('…including when the very first request THROWS rather than answers', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(pageAllComplete('page-objects', 'objects', {
      ...options, fetchImpl: fetchImpl as never,
    })).resolves.toEqual([])
  })

  it('but a transport failure AFTER a page has landed is incomplete, not offline', async () => {
    // The asymmetry is the whole design: the same error means different things
    // depending on whether anything had already arrived.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page([{ id: 'a' }], 'cur-1'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(pageAllComplete('page-objects', 'objects', {
      ...options, fetchImpl: fetchImpl as never,
    })).rejects.toMatchObject({ pagesFetched: 1, status: null })
  })

  it('treats an unparseable 200 after a page as incomplete', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page([{ id: 'a' }], 'cur-1'))
      .mockResolvedValueOnce(new Response('<html>', { status: 200 }))

    await expect(pageAllComplete('page-objects', 'objects', {
      ...options, fetchImpl: fetchImpl as never,
    })).rejects.toBeInstanceOf(IncompleteCollectionError)
  })

  it('throws when the page ceiling is hit with a cursor still outstanding', async () => {
    // The old loop returned its accumulator here, which is a truncation
    // presented as a complete collection — the same defect by a different road.
    const fetchImpl = vi.fn().mockResolvedValue(page([{ id: 'x' }], 'never-ends'))

    await expect(pageAllComplete('page-objects', 'objects', {
      ...options, fetchImpl: fetchImpl as never,
    })).rejects.toBeInstanceOf(IncompleteCollectionError)
  })

  it('carries the workspace pair on EVERY request, cursor included', async () => {
    // A request without the pair is answered for the DEFAULT landscape, which
    // is how a non-default landscape once paged zero rows and called itself
    // offline. Asserting page 2 as well, because the cursor branch builds its
    // URL separately and is where that would regress.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page([{ id: 'a' }], 'cur-1'))
      .mockResolvedValueOnce(page([{ id: 'b' }], null))

    await pageAllComplete('page-objects', 'objects', { ...options, fetchImpl: fetchImpl as never })

    for (const [url] of fetchImpl.mock.calls) {
      expect(url).toContain('landscapeId=L-1&versionId=V-1')
    }
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('after=cur-1')
  })

  it('reads the key it was asked for, not whatever the payload happens to hold', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ objects: [{ id: 'o' }], connections: [{ id: 'c' }], nextCursor: null }), {
        status: 200,
      }),
    )

    const rows = await pageAllComplete('page-connections', 'connections', {
      ...options, fetchImpl: fetchImpl as never,
    })
    expect(rows).toEqual([{ id: 'c' }])
  })
})
