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
 * Defect 2026-10-17: two stacks on `localhost` shared one `maplespire_session`
 * cookie (browsers ignore the port), so a login on one logged the other out —
 * "Invalid or expired session". `AUTH_COOKIE_NAME` renames the cookie, and every
 * reader and writer — HTTP middleware, WS upgrade, logout, impersonation stash —
 * must follow it, or a renamed stack would set one cookie and read another.
 */
import type { IncomingMessage } from 'node:http'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_STASH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  adminStashCookieName,
  clearSessionCookie,
  readSessionCookie,
  sessionCookieName,
  setSessionCookie,
  signSession,
} from './tokens.js'
import { authenticateUpgrade } from './wsAuth.js'

function headersOf(fn: (res: Response) => void): string[] {
  const appended: string[] = []
  const res = { append: (_name: string, value: string) => { appended.push(value) } } as unknown as Response
  fn(res)
  return appended
}

const reqWithCookie = (cookie: string) => ({ headers: { cookie } }) as unknown as Request

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', 'session-cookie-name-test-secret-0123456789')
  vi.stubEnv('AUTH', 'on')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('AUTH_COOKIE_NAME', () => {
  it('control: unset, the cookie keeps its deployed name', () => {
    vi.stubEnv('AUTH_COOKIE_NAME', '')
    expect(sessionCookieName()).toBe(SESSION_COOKIE_NAME)
    expect(adminStashCookieName()).toBe(ADMIN_STASH_COOKIE_NAME)
  })

  it('renames the cookie the login sets, the logout clears, and the middleware reads', () => {
    vi.stubEnv('AUTH_COOKIE_NAME', 'maplespire_session_3013')
    expect(headersOf((res) => setSessionCookie(res, 'tok'))[0]).toMatch(/^maplespire_session_3013=tok;/)
    expect(headersOf((res) => clearSessionCookie(res))[0]).toMatch(/^maplespire_session_3013=;/)
    // Another stack's cookie on the same host is not this stack's session.
    expect(readSessionCookie(reqWithCookie('maplespire_session=foreign; maplespire_session_3013=mine'))).toBe('mine')
    expect(readSessionCookie(reqWithCookie('maplespire_session=foreign'))).toBeNull()
  })

  it('the WebSocket upgrade reads the same renamed cookie', async () => {
    vi.stubEnv('AUTH_COOKIE_NAME', 'maplespire_session_3013')
    const token = await signSession({ userId: 'u1', orgId: null, isPlatformAdmin: false, epoch: 1 })
    const upgrade = (cookie: string) => authenticateUpgrade({ headers: { cookie } } as IncomingMessage)
    expect((await upgrade(`maplespire_session_3013=${encodeURIComponent(token)}`)).claims?.userId).toBe('u1')
    // The deployed name no longer authenticates this stack.
    expect((await upgrade(`maplespire_session=${encodeURIComponent(token)}`)).claims ?? null).toBeNull()
  })

  it('names the impersonation stash after the renamed session', () => {
    vi.stubEnv('AUTH_COOKIE_NAME', 'maplespire_session_3013')
    expect(adminStashCookieName()).toBe('maplespire_session_3013_admin')
  })

  it('refuses a name a Set-Cookie header cannot carry, rather than falling back', () => {
    vi.stubEnv('AUTH_COOKIE_NAME', 'bad name;')
    expect(() => sessionCookieName()).toThrow(/AUTH_COOKIE_NAME/)
  })
})
