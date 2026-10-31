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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Request } from 'express'
import {
  signSession,
  verifySession,
  readSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  sessionEndedPending,
  rememberSessionEnded,
  sessionEndedCookieName,
  SESSION_COOKIE_NAME,
  type SessionClaims,
} from './tokens.js'
import { authStage, requireAuth } from './middleware.js'

// These tests are DB-free by design: tokens/middleware never touch Postgres, so
// none of this needs a pool or a live server.

const ORIGINAL_ENV = { ...process.env }

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key]
  }
  Object.assign(process.env, ORIGINAL_ENV)
}

const claims: SessionClaims = { userId: 'u1', orgId: 'org1', isPlatformAdmin: false, epoch: 1 }

describe('tokens: signSession / verifySession', () => {
  beforeEach(() => {
    resetEnv()
    process.env.AUTH_SECRET = 'test-secret-1234567890'
  })
  afterEach(resetEnv)

  it('round-trips claims through sign then verify', async () => {
    const token = await signSession(claims)
    const verified = await verifySession(token)
    expect(verified).toEqual(claims)
  })

  it('preserves a null orgId', async () => {
    const platformClaims: SessionClaims = { userId: 'admin1', orgId: null, isPlatformAdmin: true, epoch: 3 }
    const token = await signSession(platformClaims)
    expect(await verifySession(token)).toEqual(platformClaims)
  })

  it('signSession throws a clear error when AUTH_SECRET is missing', async () => {
    delete process.env.AUTH_SECRET
    await expect(signSession(claims)).rejects.toThrow(/AUTH_SECRET/)
  })

  it('verifySession returns null (never throws) when AUTH_SECRET is missing', async () => {
    const token = await signSession(claims)
    delete process.env.AUTH_SECRET
    await expect(verifySession(token)).resolves.toBeNull()
  })

  it('verifySession returns null for a token signed with a different secret', async () => {
    const token = await signSession(claims)
    process.env.AUTH_SECRET = 'a-completely-different-secret'
    await expect(verifySession(token)).resolves.toBeNull()
  })

  it('verifySession returns null for garbage input', async () => {
    await expect(verifySession('not-a-jwt')).resolves.toBeNull()
    await expect(verifySession('')).resolves.toBeNull()
  })

  it('verifySession returns null for an expired token', async () => {
    vi.useFakeTimers()
    try {
      process.env.AUTH_SESSION_MAX_AGE_S = '10'
      const token = await signSession(claims)
      // Just past expiry.
      vi.advanceTimersByTime(11_000)
      await expect(verifySession(token)).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('respects AUTH_SESSION_MAX_AGE_S for a still-valid token', async () => {
    vi.useFakeTimers()
    try {
      process.env.AUTH_SESSION_MAX_AGE_S = '3600'
      const token = await signSession(claims)
      vi.advanceTimersByTime(1_000)
      await expect(verifySession(token)).resolves.toEqual(claims)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('tokens: impersonation claims (imp)', () => {
  beforeEach(() => {
    resetEnv()
    process.env.AUTH_SECRET = 'test-secret-1234567890'
  })
  afterEach(resetEnv)

  const impClaims: SessionClaims = {
    userId: 'target1',
    orgId: 'org1',
    isPlatformAdmin: false,
    epoch: 1,
    imp: { by: 'admin1' },
  }

  it('round-trips imp through sign then verify', async () => {
    const token = await signSession(impClaims)
    await expect(verifySession(token)).resolves.toEqual(impClaims)
  })

  it('a normal (pre-impersonation-shape) session has no imp property after verify', async () => {
    const token = await signSession(claims)
    const verified = await verifySession(token)
    expect(verified).not.toBeNull()
    expect(verified!.imp).toBeUndefined()
  })

  it('signSession honors an explicit maxAgeS override regardless of AUTH_SESSION_MAX_AGE_S', async () => {
    vi.useFakeTimers()
    try {
      process.env.AUTH_SESSION_MAX_AGE_S = '999999' // would normally keep it alive
      const token = await signSession(impClaims, 10) // but override forces a 10s life
      vi.advanceTimersByTime(11_000)
      await expect(verifySession(token)).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a token whose imp claim is malformed (tampered shape)', async () => {
    // Sign a normal session, then hand-craft a payload with a bogus `imp` to
    // simulate a tampered/forward-incompatible token — verifySession must
    // reject the whole thing, not silently drop just the bad `imp`.
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(process.env.AUTH_SECRET!)
    const bogus = await new SignJWT({
      userId: 'u1',
      orgId: 'org1',
      isPlatformAdmin: false,
      epoch: 1,
      imp: { by: 123 }, // wrong type
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(secret)
    await expect(verifySession(bogus)).resolves.toBeNull()
  })
})

describe('tokens: per-user epoch (uepoch)', () => {
  beforeEach(() => {
    resetEnv()
    process.env.AUTH_SECRET = 'test-secret-1234567890'
  })
  afterEach(resetEnv)

  it('round-trips uepoch through sign then verify', async () => {
    const withUser: SessionClaims = { userId: 'u1', orgId: 'org1', isPlatformAdmin: false, epoch: 4, uepoch: 2 }
    await expect(verifySession(await signSession(withUser))).resolves.toEqual(withUser)
  })

  it('a cookie minted before uepoch existed still verifies, with no uepoch (read as 1 by the epoch checks)', async () => {
    const verified = await verifySession(await signSession(claims))
    expect(verified).not.toBeNull()
    expect(verified).not.toHaveProperty('uepoch')
  })

  it('rejects a token whose uepoch is not a number', async () => {
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(process.env.AUTH_SECRET!)
    const bogus = await new SignJWT({ userId: 'u1', orgId: 'org1', isPlatformAdmin: false, epoch: 1, uepoch: '2' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(secret)
    await expect(verifySession(bogus)).resolves.toBeNull()
  })
})

describe('tokens: cookie read/write', () => {
  beforeEach(() => {
    resetEnv()
    process.env.AUTH_SECRET = 'test-secret-1234567890'
  })
  afterEach(resetEnv)

  function fakeReq(cookieHeader: string | undefined): Request {
    return { headers: { cookie: cookieHeader } } as unknown as Request
  }

  it('readSessionCookie parses the session cookie out of a multi-cookie header', () => {
    const req = fakeReq(`other=1; ${SESSION_COOKIE_NAME}=abc.def.ghi; another=2`)
    expect(readSessionCookie(req)).toBe('abc.def.ghi')
  })

  it('readSessionCookie returns null when the cookie is absent', () => {
    expect(readSessionCookie(fakeReq('unrelated=1'))).toBeNull()
    expect(readSessionCookie(fakeReq(undefined))).toBeNull()
  })

  it('readSessionCookie url-decodes the value', () => {
    const encoded = encodeURIComponent('a.b.c+d/e')
    const req = fakeReq(`${SESSION_COOKIE_NAME}=${encoded}`)
    expect(readSessionCookie(req)).toBe('a.b.c+d/e')
  })

  function fakeRes() {
    const headers: string[] = []
    return {
      append: (name: string, value: string) => {
        if (name === 'Set-Cookie') headers.push(value)
      },
      headers,
    }
  }

  it('setSessionCookie sets httpOnly, SameSite=Lax, Path=/', () => {
    const res = fakeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSessionCookie(res as any, 'my-token')
    expect(res.headers).toHaveLength(1)
    const header = res.headers[0]
    expect(header).toContain(`${SESSION_COOKIE_NAME}=my-token`)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Path=/')
  })

  it('setSessionCookie omits Secure by default under http APP_URL', () => {
    process.env.APP_URL = 'http://localhost:5173'
    const res = fakeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSessionCookie(res as any, 'my-token')
    expect(res.headers[0]).not.toContain('Secure')
  })

  it('setSessionCookie adds Secure when APP_URL is https (auto mode)', () => {
    process.env.APP_URL = 'https://app.example.com'
    const res = fakeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSessionCookie(res as any, 'my-token')
    expect(res.headers[0]).toContain('Secure')
  })

  it('setSessionCookie adds Secure when AUTH_COOKIE_SECURE=on regardless of APP_URL', () => {
    process.env.APP_URL = 'http://localhost:5173'
    process.env.AUTH_COOKIE_SECURE = 'on'
    const res = fakeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSessionCookie(res as any, 'my-token')
    expect(res.headers[0]).toContain('Secure')
  })

  it('clearSessionCookie expires the cookie immediately', () => {
    const res = fakeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearSessionCookie(res as any)
    expect(res.headers).toHaveLength(1)
    const header = res.headers[0]
    expect(header).toContain(`${SESSION_COOKIE_NAME}=;`)
    expect(header).toContain('Max-Age=0')
    expect(header).toContain('1970')
  })

  // The "session ended" marker: a stale cookie answered by one request and
  // cleared must still be explainable to the next (GET /api/auth/me).
  it('rememberSessionEnded leaves a short-lived HttpOnly marker named after the session cookie', () => {
    const res = fakeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rememberSessionEnded(res as any)
    expect(res.headers).toHaveLength(1)
    expect(res.headers[0]).toContain(`${SESSION_COOKIE_NAME}_ended=stale`)
    // Exact attributes: a browser drops or never sends a marker with another Path/Domain/SameSite,
    // and Max-Age is seconds (120000 would be ~33 h).
    expect(res.headers[0]).toMatch(/^[a-z_]+_ended=stale; Path=\/; HttpOnly; SameSite=Lax; Max-Age=120$/)
    expect(sessionEndedCookieName()).toBe(`${SESSION_COOKIE_NAME}_ended`)
  })

  it('the marker follows a renamed session cookie (per-stack AUTH_COOKIE_NAME), so stacks never share it', () => {
    process.env.AUTH_COOKIE_NAME = 'maplespire_session_5261'
    expect(sessionEndedCookieName()).toBe('maplespire_session_5261_ended')
    const res = fakeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rememberSessionEnded(res as any)
    expect(res.headers[0]).toContain('maplespire_session_5261_ended=stale')
  })

  it('sessionEndedPending reads the marker WITHOUT clearing it, so every tab is told', () => {
    const res = fakeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(sessionEndedPending(fakeReq(`${SESSION_COOKIE_NAME}_ended=stale`))).toBe(true)
    expect(res.headers).toEqual([])
    expect(sessionEndedPending(fakeReq('other=1'))).toBe(false)
    // Another stack's marker (different AUTH_COOKIE_NAME) is not ours.
    expect(sessionEndedPending(fakeReq('maplespire_session_5261_ended=stale'))).toBe(false)
  })

  it('setSessionCookie still sets exactly one cookie (the marker needs no clearing there)', () => {
    const res = fakeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSessionCookie(res as any, 'my-token')
    expect(res.headers).toHaveLength(1)
  })
})

describe('middleware: authStage', () => {
  beforeEach(resetEnv)
  afterEach(resetEnv)

  it('defaults to off when AUTH is unset', () => {
    delete process.env.AUTH
    expect(authStage()).toBe('off')
  })

  it('reads off / dual / on', () => {
    process.env.AUTH = 'off'
    expect(authStage()).toBe('off')
    process.env.AUTH = 'dual'
    expect(authStage()).toBe('dual')
    process.env.AUTH = 'on'
    expect(authStage()).toBe('on')
  })

  it('falls back to off for an unknown value and warns once', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.AUTH = 'bogus'
    expect(authStage()).toBe('off')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('middleware: requireAuth', () => {
  beforeEach(() => {
    resetEnv()
    process.env.AUTH_SECRET = 'test-secret-1234567890'
  })
  afterEach(resetEnv)

  function fakeReqRes(opts: { path: string; method?: string; cookie?: string }) {
    const req = {
      path: opts.path,
      method: opts.method ?? 'GET',
      headers: { cookie: opts.cookie },
    } as unknown as Request
    let statusCode: number | undefined
    let jsonBody: unknown
    const res = {
      status(code: number) {
        statusCode = code
        return this
      },
      json(body: unknown) {
        jsonBody = body
        return this
      },
      get statusCode() {
        return statusCode
      },
      get jsonBody() {
        return jsonBody
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    return { req, res }
  }

  it('off stage: always calls next(), never touches req.auth', async () => {
    process.env.AUTH = 'off'
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/landscapes' })
    const next = vi.fn()
    handler(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(req.auth).toBeUndefined()
  })

  it('on stage: 401s a non-allowlisted route with no cookie', async () => {
    process.env.AUTH = 'on'
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/landscapes' })
    const next = vi.fn()
    handler(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })

  it('on stage: allows /auth/ prefix through with no cookie (mount-relative, no /api)', async () => {
    process.env.AUTH = 'on'
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/auth/dev-login', method: 'POST' })
    const next = vi.fn()
    handler(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBeUndefined()
  })

  it('on stage: allows /health through with no cookie', async () => {
    process.env.AUTH = 'on'
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/health' })
    const next = vi.fn()
    handler(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('on stage: allows /health/pools through with no cookie', async () => {
    // The pool meter (`/api/health/pools`). Its whole value is being answerable when
    // the primary pool has nothing left to give, and an operator diagnosing
    // that has no reason to also hold a session. `/health` is a PREFIX in
    // `ALLOWLISTED_PREFIXES`, which is what admits the sub-path — pinned here
    // so that narrowing the entry to an exact match is a red test rather than
    // a silently authenticated instrument.
    process.env.AUTH = 'on'
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/health/pools' })
    const next = vi.fn()
    handler(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBeUndefined()
  })

  it('on stage: allows /ready through with no cookie for orchestrator probes', async () => {
    process.env.AUTH = 'on'
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/ready' })
    const next = vi.fn()
    handler(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBeUndefined()
  })

  it('on stage: allows /dev/outbox through with no cookie', async () => {
    process.env.AUTH = 'on'
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/dev/outbox' })
    const next = vi.fn()
    handler(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('on stage: allows GET /shares/:token through with no cookie', async () => {
    process.env.AUTH = 'on'
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/shares/tok123', method: 'GET' })
    const next = vi.fn()
    handler(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBeUndefined()
  })

  it('on stage: does NOT allowlist a mutating /shares/:token request', async () => {
    process.env.AUTH = 'on'
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/shares/tok123', method: 'DELETE' })
    const next = vi.fn()
    handler(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })

  it('on stage: a valid session cookie sets req.auth and calls next()', async () => {
    process.env.AUTH = 'on'
    const token = await signSession(claims)
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/landscapes', cookie: `${SESSION_COOKIE_NAME}=${token}` })
    const next = vi.fn()
    handler(req, res, next)
    await vi.waitFor(() => {
      expect(req.auth).toEqual(claims)
      expect(next).toHaveBeenCalledTimes(1)
    })
    expect(res.statusCode).toBeUndefined()
  })

  it('on stage: an invalid session cookie 401s a non-allowlisted route', async () => {
    process.env.AUTH = 'on'
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/landscapes', cookie: `${SESSION_COOKIE_NAME}=garbage` })
    const next = vi.fn()
    handler(req, res, next)
    await vi.waitFor(() => {
      expect(next).not.toHaveBeenCalled()
      expect(res.statusCode).toBe(401)
    })
  })

  it('dual stage: missing cookie is logged (throttled) but still calls next()', async () => {
    process.env.AUTH = 'dual'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/landscapes' })
    const next = vi.fn()
    handler(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBeUndefined()
    expect(req.auth).toBeUndefined()
    warnSpy.mockRestore()
  })

  it('dual stage: a valid cookie still sets req.auth', async () => {
    process.env.AUTH = 'dual'
    const token = await signSession(claims)
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/landscapes', cookie: `${SESSION_COOKIE_NAME}=${token}` })
    const next = vi.fn()
    // The handler returns void and resolves the session asynchronously (jose's
    // verify hops through webcrypto) — a single setTimeout(0) flushed it on an
    // idle machine but flaked under full-suite parallel load. Wait for the
    // observable effect instead of guessing at the microtask depth.
    handler(req, res, next)
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1))
    expect(req.auth).toEqual(claims)
  })
})

describe('tokens: global epoch (gepoch, imp.gepoch)', () => {
  beforeEach(() => {
    resetEnv()
    process.env.AUTH_SECRET = 'test-secret-1234567890'
  })
  afterEach(resetEnv)

  it("round-trips gepoch and the impersonator's imp.gepoch", async () => {
    const full: SessionClaims = { ...claims, uepoch: 2, gepoch: 3, imp: { by: 'admin-1', gepoch: 4 } }
    await expect(verifySession(await signSession(full))).resolves.toEqual(full)
  })

  it('a cookie minted before gepoch existed verifies with none (read as 1), and an old imp keeps only `by`', async () => {
    const verified = await verifySession(await signSession({ ...claims, imp: { by: 'admin-1' } }))
    expect(verified).not.toHaveProperty('gepoch')
    expect(verified?.imp).toEqual({ by: 'admin-1' })
  })

  it('rejects a token whose gepoch or imp.gepoch is not a number', async () => {
    const { SignJWT } = await import('jose')
    const secret = new TextEncoder().encode(process.env.AUTH_SECRET!)
    const sign = (payload: Record<string, unknown>) => new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(secret)
    const base = { userId: 'u1', orgId: 'org1', isPlatformAdmin: false, epoch: 1 }
    await expect(verifySession(await sign({ ...base, gepoch: '2' }))).resolves.toBeNull()
    await expect(verifySession(await sign({ ...base, imp: { by: 'a', gepoch: '2' } }))).resolves.toBeNull()
  })
})

describe('middleware: requireAuth isSessionCurrent (a revoked session on cookie HTTP)', () => {
  beforeEach(() => {
    resetEnv()
    process.env.AUTH_SECRET = 'test-secret-1234567890'
  })
  afterEach(resetEnv)

  function fakeReqRes(opts: { path: string; cookie?: string }) {
    const req = { path: opts.path, method: 'GET', headers: { cookie: opts.cookie } } as unknown as Request
    const res = {
      statusCode: undefined as number | undefined,
      jsonBody: undefined as unknown,
      setCookies: [] as string[],
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(body: unknown) {
        this.jsonBody = body
        return this
      },
      append(name: string, value: string) {
        if (name === 'Set-Cookie') this.setCookies.push(value)
        return this
      },
    }
    return { req, res }
  }
  async function run(opts: {
    stage: 'on' | 'dual'
    path?: string
    isSessionCurrent: (c: SessionClaims) => Promise<boolean>
    preAuth?: SessionClaims
  }) {
    process.env.AUTH = opts.stage
    const token = await signSession(claims)
    const { req, res } = fakeReqRes({ path: opts.path ?? '/landscapes', cookie: `${SESSION_COOKIE_NAME}=${token}` })
    if (opts.preAuth) req.auth = opts.preAuth
    const next = vi.fn()
    requireAuth({ isSessionCurrent: opts.isSessionCurrent })(req, res as never, next)
    await vi.waitFor(() => expect(next.mock.calls.length > 0 || res.statusCode !== undefined).toBe(true))
    return { req, res, next }
  }

  it('a stale session is a 401 session_stale, clears the cookie, and never reaches the route', async () => {
    const { req, res, next } = await run({ stage: 'on', isSessionCurrent: async () => false })
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toMatchObject({ code: 'session_stale' })
    expect(res.setCookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=;`))).toBe(true)
    expect(req.auth).toBeUndefined()
  })

  it('a stale session also leaves the "session ended" marker, so the cleared cookie does not erase the reason', async () => {
    const { res } = await run({ stage: 'on', isSessionCurrent: async () => false })
    expect(res.setCookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}_ended=stale`))).toBe(true)
  })

  it('a current session leaves no marker', async () => {
    const { res } = await run({ stage: 'on', isSessionCurrent: async () => true })
    expect(res.setCookies.some((c) => c.includes('_ended='))).toBe(false)
  })

  it('a current session proceeds with req.auth set, and the check saw its claims', async () => {
    const isSessionCurrent = vi.fn(async () => true)
    const { req, next } = await run({ stage: 'on', isSessionCurrent })
    expect(next).toHaveBeenCalledTimes(1)
    expect(req.auth).toEqual(claims)
    expect(isSessionCurrent).toHaveBeenCalledWith(claims)
  })

  it('a stale session on an allowlisted path proceeds UNauthenticated (logout and /auth/me still answer)', async () => {
    const { req, res, next } = await run({ stage: 'on', path: '/auth/me', isSessionCurrent: async () => false })
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBeUndefined()
    expect(req.auth).toBeUndefined()
  })

  it('a failed check on an allowlisted path proceeds unauthenticated (logout still answers with the DB down)', async () => {
    const { req, res, next } = await run({ stage: 'on', path: '/auth/logout', isSessionCurrent: async () => { throw new Error('db down') } })
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBeUndefined()
    expect(req.auth).toBeUndefined()
  })

  it('a failed check fails closed with a 503, never admitted', async () => {
    const { req, res, next } = await run({ stage: 'on', isSessionCurrent: async () => { throw new Error('db down') } })
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(503)
    expect(req.auth).toBeUndefined()
  })

  // QA lens round 2 (2026-10-17): each of the cases below survived a mutant.
  it('/auth/me proceeds unauthenticated on a failed check too (it reads the cookie itself)', async () => {
    const { req, res, next } = await run({ stage: 'on', path: '/auth/me', isSessionCurrent: async () => { throw new Error('db down') } })
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBeUndefined()
    expect(req.auth).toBeUndefined()
  })

  it('an ALLOWLISTED route other than logout and /auth/me still answers a failed check with 503', async () => {
    for (const path of ['/auth/switch-org', '/auth/invite/tok/accept']) {
      const { req, res, next } = await run({ stage: 'on', path, isSessionCurrent: async () => { throw new Error('db down') } })
      expect(next).not.toHaveBeenCalled()
      expect(res.statusCode).toBe(503)
      expect(req.auth).toBeUndefined()
    }
  })

  it('/health, /health/* and /ready never consult the session check — not even with the database down', async () => {
    for (const path of ['/health', '/health/deep', '/ready']) {
      const isSessionCurrent = vi.fn(async (): Promise<boolean> => { throw new Error('db down') })
      const { req, res, next } = await run({ stage: 'on', path, isSessionCurrent })
      expect(isSessionCurrent).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledTimes(1)
      expect(res.statusCode).toBeUndefined()
      expect(req.auth).toEqual(claims)
    }
    // Control: a path merely STARTING with "health" is not a probe, so the
    // check runs (it is allowlisted by prefix, so a stale session proceeds
    // unauthenticated rather than 401).
    const isSessionCurrent = vi.fn(async () => false)
    const { req } = await run({ stage: 'on', path: '/healthy-landscapes', isSessionCurrent })
    expect(isSessionCurrent).toHaveBeenCalledTimes(1)
    expect(req.auth).toBeUndefined()
  })

  it('a failed check is logged, at most once a minute', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // Far past any failure an earlier test logged: the throttle is open.
      vi.setSystemTime(Date.now() + 3_600_000)
      const fail = async () => { throw new Error('db down') }
      const logged = () => error.mock.calls.filter(([m]) => String(m).includes('session epoch check failed')).length
      await run({ stage: 'on', isSessionCurrent: fail })
      expect(logged()).toBe(1)
      await run({ stage: 'on', isSessionCurrent: fail })
      expect(logged()).toBe(1)
      vi.setSystemTime(Date.now() + 61_000)
      await run({ stage: 'on', isSessionCurrent: fail })
      expect(logged()).toBe(2)
    } finally {
      vi.useRealTimers()
      error.mockRestore()
    }
  })

  it("stage 'dual' does not enforce it, and a bearer identity set upstream is not re-checked", async () => {
    const isSessionCurrent = vi.fn(async () => false)
    const dual = await run({ stage: 'dual', isSessionCurrent })
    expect(dual.next).toHaveBeenCalledTimes(1)
    expect(dual.req.auth).toEqual(claims)
    const bearer = await run({ stage: 'on', isSessionCurrent, preAuth: { ...claims, userId: 'bearer-user' } })
    expect(bearer.next).toHaveBeenCalledTimes(1)
    expect(isSessionCurrent).not.toHaveBeenCalled()
  })
})

describe('middleware: impersonation read-only guard', () => {
  beforeEach(() => {
    resetEnv()
    process.env.AUTH_SECRET = 'test-secret-1234567890'
  })
  afterEach(resetEnv)

  const impClaims: SessionClaims = { userId: 'target1', orgId: 'org1', isPlatformAdmin: false, epoch: 1, imp: { by: 'admin1' } }

  function fakeReqRes(opts: { path: string; method?: string; cookie?: string }) {
    const req = {
      path: opts.path,
      method: opts.method ?? 'GET',
      headers: { cookie: opts.cookie },
    } as unknown as Request
    let statusCode: number | undefined
    let jsonBody: unknown
    const res = {
      status(code: number) {
        statusCode = code
        return this
      },
      json(body: unknown) {
        jsonBody = body
        return this
      },
      get statusCode() {
        return statusCode
      },
      get jsonBody() {
        return jsonBody
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    return { req, res }
  }

  it('dual stage: a non-GET request on an imp session is 403 impersonation-read-only', async () => {
    process.env.AUTH = 'dual'
    const token = await signSession(impClaims)
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/landscapes/abc', method: 'DELETE', cookie: `${SESSION_COOKIE_NAME}=${token}` })
    const next = vi.fn()
    handler(req, res, next)
    await vi.waitFor(() => expect(res.statusCode).toBeDefined())
    expect(res.statusCode).toBe(403)
    expect(res.jsonBody).toEqual({ error: 'impersonation-read-only' })
    expect(next).not.toHaveBeenCalled()
  })

  it('on stage: a non-GET request on an imp session is 403 impersonation-read-only', async () => {
    process.env.AUTH = 'on'
    const token = await signSession(impClaims)
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/landscapes/abc', method: 'POST', cookie: `${SESSION_COOKIE_NAME}=${token}` })
    const next = vi.fn()
    handler(req, res, next)
    await vi.waitFor(() => expect(res.statusCode).toBeDefined())
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('a GET request on an imp session passes through', async () => {
    process.env.AUTH = 'on'
    const token = await signSession(impClaims)
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/landscapes', method: 'GET', cookie: `${SESSION_COOKIE_NAME}=${token}` })
    const next = vi.fn()
    handler(req, res, next)
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1))
    expect(res.statusCode).toBeUndefined()
    expect(req.auth).toEqual(impClaims)
  })

  it('POST /auth/impersonate/exit is exempt (mount-relative path) even on an imp session', async () => {
    process.env.AUTH = 'on'
    const token = await signSession(impClaims)
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/auth/impersonate/exit', method: 'POST', cookie: `${SESSION_COOKIE_NAME}=${token}` })
    const next = vi.fn()
    handler(req, res, next)
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1))
    expect(res.statusCode).toBeUndefined()
  })

  it('a non-GET request on a NORMAL (non-imp) session is unaffected', async () => {
    process.env.AUTH = 'on'
    const token = await signSession(claims)
    const handler = requireAuth()
    const { req, res } = fakeReqRes({ path: '/landscapes/abc', method: 'DELETE', cookie: `${SESSION_COOKIE_NAME}=${token}` })
    const next = vi.fn()
    handler(req, res, next)
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1))
    expect(res.statusCode).toBeUndefined()
  })
})

describe('tokens: named cookie helpers (admin stash)', () => {
  beforeEach(() => {
    resetEnv()
    process.env.AUTH_SECRET = 'test-secret-1234567890'
  })
  afterEach(resetEnv)

  function fakeRes() {
    const headers: string[] = []
    return {
      append: (name: string, value: string) => {
        if (name === 'Set-Cookie') headers.push(value)
      },
      headers,
    }
  }

  it('setNamedCookie / readNamedCookie round-trip a value under a custom name', async () => {
    const { setNamedCookie, readNamedCookie, ADMIN_STASH_COOKIE_NAME } = await import('./tokens.js')
    const res = fakeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setNamedCookie(res as any, ADMIN_STASH_COOKIE_NAME, 'stashed-token', 3600)
    expect(res.headers[0]).toContain(`${ADMIN_STASH_COOKIE_NAME}=stashed-token`)
    expect(res.headers[0]).toContain('Max-Age=3600')

    const cookieHeader = res.headers[0].split(';')[0]
    const req = { headers: { cookie: cookieHeader } } as unknown as Request
    expect(readNamedCookie(req, ADMIN_STASH_COOKIE_NAME)).toBe('stashed-token')
  })

  it('clearNamedCookie expires the cookie immediately', async () => {
    const { clearNamedCookie, ADMIN_STASH_COOKIE_NAME } = await import('./tokens.js')
    const res = fakeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearNamedCookie(res as any, ADMIN_STASH_COOKIE_NAME)
    expect(res.headers[0]).toContain(`${ADMIN_STASH_COOKIE_NAME}=;`)
    expect(res.headers[0]).toContain('Max-Age=0')
  })
})
