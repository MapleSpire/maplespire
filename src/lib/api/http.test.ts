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
 * THE SEAM THAT CONNECTS THE RETRY TO THE APP.
 *
 * `retryable.test.ts` proves `fetchRetryable` behaves; this file proves that
 * the function the app actually calls IS that one. Every other retry test
 * either calls `fetchRetryable` directly or mocks this module out, so replacing
 * `workspaceApiFetch`'s body with a plain `apiFetch` — unwiring the feature from
 * every production call site — would otherwise go unnoticed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, workspaceApiFetch } from './http'
import { __resetRoutedRetriesForTest } from './retryable'

afterEach(() => {
  vi.unstubAllGlobals()
  __resetRoutedRetriesForTest()
})

const refusal = () => new Response(JSON.stringify({ error: 'workspace owner unavailable', retryable: true }), {
  status: 503,
  headers: { 'content-type': 'application/json' },
})

describe('workspaceApiFetch', () => {
  it('RETRIES the router refusal — this is the arm that fails if the wiring is cut', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(refusal())
      .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await workspaceApiFetch('/api/model/dependencies/page')

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('and plain apiFetch does NOT — so the two are not interchangeable', async () => {
    // The contrast is the assertion. Without it, an implementation where BOTH
    // retried (or neither did) would satisfy the arm above on its own.
    const fetchMock = vi.fn().mockResolvedValue(refusal())
    vi.stubGlobal('fetch', fetchMock)

    const res = await apiFetch('/api/model/dependencies/page')

    expect(res.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('still sends credentials, which is the reason apiFetch exists at all', async () => {
    // Composing a retry around the fetch must not lose the httpOnly session
    // cookie — the failure `apiFetch`'s own docblock was written for, and one
    // that only shows up once AUTH enforcement is switched on.
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await workspaceApiFetch('/api/model/search')

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' })
  })

  it('threads the caller’s signal to the FETCH, not only to the backoff', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await workspaceApiFetch('/api/model/search', { signal: controller.signal })

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal).toBe(controller.signal)
  })

  it('does not retry a POST through this seam either', async () => {
    const fetchMock = vi.fn().mockResolvedValue(refusal())
    vi.stubGlobal('fetch', fetchMock)

    const res = await workspaceApiFetch('/api/model/durability-witness', { method: 'POST' })

    expect(res.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
