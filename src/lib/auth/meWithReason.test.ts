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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { me, meWithReason } from './api'

function answer(status: number, body?: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status })))
}

afterEach(() => vi.unstubAllGlobals())

describe('meWithReason — what the session watcher is allowed to conclude', () => {
  it("the server's session_stale 401 means the org's permissions changed", async () => {
    answer(401, { error: 'Session permissions changed; sign in again', code: 'session_stale' })
    await expect(meWithReason()).resolves.toEqual({ kind: 'signed-out', reason: 'permissions-changed' })
  })

  it('any other 401 — no body, another message — is a plain sign-out', async () => {
    answer(401)
    await expect(meWithReason()).resolves.toEqual({ kind: 'signed-out', reason: 'signed-out' })
    answer(401, { error: 'Invalid or expired session' })
    await expect(meWithReason()).resolves.toEqual({ kind: 'signed-out', reason: 'signed-out' })
  })

  it('a server that cannot answer THROWS: an outage must never read as a signed-out user', async () => {
    answer(503, { error: 'unavailable' })
    await expect(meWithReason()).rejects.toThrow('HTTP 503')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(meWithReason()).rejects.toThrow('Failed to fetch')
  })

  it('a valid session, and me() keeps its old contract (null on 401)', async () => {
    const result = { user: { id: 'u', email: 'u@x.test', isPlatformAdmin: false }, claims: { orgId: 'o' } }
    answer(200, result)
    await expect(meWithReason()).resolves.toEqual({ kind: 'signed-in', result })
    answer(401, { code: 'session_stale' })
    await expect(me()).resolves.toBeNull()
  })
})
