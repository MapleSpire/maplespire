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
