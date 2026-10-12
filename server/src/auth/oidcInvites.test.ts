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
import { createHash } from 'node:crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

/**
 * DB-free tests for oidc.ts + invites.ts.
 *
 * No Postgres involved: `../db.js`'s `pool` is mocked to a `{ query: vi.fn() }`
 * stub, and `email/index.js` /
 * `auth/audit.js` are mocked so the routes' business logic (env-driven
 * provider list, 401/403 authorization gates, token hashing, response shapes)
 * is exercised without any network or IdP calls. `oidc.ts`'s actual
 * discovery()/authorizationCodeGrant() calls are exercised only for the
 * error paths that never reach the network (unknown provider, invalid state).
 */

const queryMock = vi.fn()
const appendAuditMock = vi.fn().mockResolvedValue(undefined)
const sendMock = vi.fn().mockResolvedValue({ id: 'email-1' })

vi.mock('../db.js', () => ({
  pool: {
    query: (...args: unknown[]) => queryMock(...args),
    // The hardened invite-accept runs in a transaction on a dedicated client;
    // route its queries through the same mock so tests see one stream.
    connect: async () => ({ query: (...args: unknown[]) => queryMock(...args), release: () => {} }),
  },
}))
vi.mock('./audit.js', () => ({
  appendAudit: (...args: unknown[]) => appendAuditMock(...args),
}))
vi.mock('../email/index.js', () => ({
  getEmailProvider: () => ({ send: sendMock }),
}))
vi.mock('../email/templates.js', () => ({
  inviteEmail: (a: { orgName: string; inviterEmail: string; role: string; acceptUrl: string }) => ({
    subject: `Invite to ${a.orgName}`,
    html: `<p>${a.acceptUrl}</p>`,
    text: a.acceptUrl,
  }),
}))

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  queryMock.mockReset()
  appendAuditMock.mockClear()
  sendMock.mockClear()
  process.env = { ...ORIGINAL_ENV }
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
  delete process.env.MS_CLIENT_ID
  delete process.env.MS_CLIENT_SECRET
  delete process.env.MS_TENANT
  delete process.env.MS_SSO_CLIENT_ID
  delete process.env.MS_SSO_CLIENT_SECRET
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.resetModules()
})

/** Boot a throwaway Express server, register `register`, optionally inject
 * `req.auth` on every request, and return `{url, close}`. */
async function startServer(
  register: (app: express.Express) => void,
  auth?: { userId: string; orgId: string | null; isPlatformAdmin: boolean; epoch: number }
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  if (auth) {
    app.use((req, _res, next) => {
      req.auth = auth
      next()
    })
  }
  register(app)
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

// ---------------------------------------------------------------------------
// oidc.ts
// ---------------------------------------------------------------------------

describe('GET /api/auth/providers', () => {
  it('lists no providers when no OIDC env is set (default-off)', async () => {
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/providers`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ providers: [] })
    } finally {
      await close()
    }
  })

  it('lists google once GOOGLE_CLIENT_ID + SECRET are set', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-id'
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret'
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/providers`)
      expect(await res.json()).toEqual({ providers: [{ id: 'google', label: 'Google' }] })
    } finally {
      await close()
    }
  })

  it('lists both providers once both are fully configured, omits a half-configured one', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-id'
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret'
    process.env.MS_CLIENT_ID = 'ms-id'
    // MS_CLIENT_SECRET intentionally left unset — microsoft must NOT appear.
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/providers`)
      expect(await res.json()).toEqual({ providers: [{ id: 'google', label: 'Google' }] })
    } finally {
      await close()
    }
  })

  it('lists microsoft once MS_CLIENT_ID + SECRET are set', async () => {
    process.env.MS_CLIENT_ID = 'ms-id'
    process.env.MS_CLIENT_SECRET = 'ms-secret'
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/providers`)
      expect(await res.json()).toEqual({ providers: [{ id: 'microsoft', label: 'Microsoft' }] })
    } finally {
      await close()
    }
  })

  it('never lists microsoft-sso on the default (public) surface, even fully configured', async () => {
    process.env.MS_CLIENT_ID = 'ms-id'
    process.env.MS_CLIENT_SECRET = 'ms-secret'
    process.env.MS_TENANT = 'tenant-123'
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/providers`)
      // Only the public 'microsoft' (common endpoint) entry — 'microsoft-sso'
      // must never leak onto the general page regardless of env.
      expect(await res.json()).toEqual({ providers: [{ id: 'microsoft', label: 'Microsoft' }] })
    } finally {
      await close()
    }
  })

  it('?surface=sso omits microsoft-sso when MS_TENANT is unset, even with MS_CLIENT_ID + SECRET', async () => {
    process.env.MS_CLIENT_ID = 'ms-id'
    process.env.MS_CLIENT_SECRET = 'ms-secret'
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/providers?surface=sso`)
      expect(await res.json()).toEqual({ providers: [] })
    } finally {
      await close()
    }
  })

  it('?surface=sso lists microsoft-sso once MS_TENANT + MS_CLIENT_ID + SECRET are all set', async () => {
    process.env.MS_CLIENT_ID = 'ms-id'
    process.env.MS_CLIENT_SECRET = 'ms-secret'
    process.env.MS_TENANT = 'tenant-123'
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/providers?surface=sso`)
      expect(await res.json()).toEqual({ providers: [{ id: 'microsoft-sso', label: 'Microsoft' }] })
    } finally {
      await close()
    }
  })

  it('?surface=sso never lists the public google/microsoft entries', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-id'
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret'
    process.env.MS_CLIENT_ID = 'ms-id'
    process.env.MS_CLIENT_SECRET = 'ms-secret'
    process.env.MS_TENANT = 'tenant-123'
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/providers?surface=sso`)
      expect(await res.json()).toEqual({ providers: [{ id: 'microsoft-sso', label: 'Microsoft' }] })
    } finally {
      await close()
    }
  })

  it('MS_SSO_CLIENT_ID/SECRET override MS_CLIENT_ID/SECRET for microsoft-sso only', async () => {
    process.env.MS_CLIENT_ID = 'ms-id'
    process.env.MS_CLIENT_SECRET = 'ms-secret'
    process.env.MS_TENANT = 'tenant-123'
    process.env.MS_SSO_CLIENT_ID = 'sso-id'
    process.env.MS_SSO_CLIENT_SECRET = 'sso-secret'
    vi.resetModules()
    const oidc = await import('./oidc.js')
    const { registerOidcRoutes } = oidc
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      // Both surfaces still list their one entry — the override doesn't
      // disable anything, it only changes WHICH client id/secret is used
      // internally (exercised indirectly; discovery() itself isn't invoked
      // by these env-only checks).
      const pub = await fetch(`${url}/api/auth/providers`)
      expect(await pub.json()).toEqual({ providers: [{ id: 'microsoft', label: 'Microsoft' }] })
      const sso = await fetch(`${url}/api/auth/providers?surface=sso`)
      expect(await sso.json()).toEqual({ providers: [{ id: 'microsoft-sso', label: 'Microsoft' }] })
    } finally {
      await close()
    }
  })

  it('microsoft-sso stays disabled with only MS_SSO_CLIENT_ID/SECRET and no MS_TENANT', async () => {
    process.env.MS_SSO_CLIENT_ID = 'sso-id'
    process.env.MS_SSO_CLIENT_SECRET = 'sso-secret'
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/providers?surface=sso`)
      expect(await res.json()).toEqual({ providers: [] })
    } finally {
      await close()
    }
  })
})

describe('GET /api/auth/login/:provider', () => {
  it('404s for an unknown provider id', async () => {
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/login/okta`, { redirect: 'manual' })
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })

  it('404s for a known provider id that has no env configured', async () => {
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/login/google`, { redirect: 'manual' })
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })

  it('404s for microsoft-sso when MS_CLIENT_ID/SECRET are set but MS_TENANT is not', async () => {
    process.env.MS_CLIENT_ID = 'ms-id'
    process.env.MS_CLIENT_SECRET = 'ms-secret'
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/login/microsoft-sso`, { redirect: 'manual' })
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })
})

describe('GET /api/auth/callback/:provider', () => {
  it('redirects to a stable unknown_provider error for an unknown provider (never leaks internals)', async () => {
    process.env.APP_URL = 'https://app.example.com'
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/callback/okta`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('https://app.example.com/login?error=unknown_provider')
    } finally {
      await close()
    }
  })

  it('redirects to invalid_state when there is no OIDC attempt cookie', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-id'
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret'
    process.env.APP_URL = 'https://app.example.com'
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const res = await fetch(`${url}/api/auth/callback/google?code=abc&state=xyz`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('https://app.example.com/login?error=invalid_state')
      // The (nonexistent) attempt cookie is still cleared on every outcome.
      expect(res.headers.get('set-cookie')).toContain('maplespire_oidc=;')
    } finally {
      await close()
    }
  })

  it('redirects to invalid_state when the cookie is present but the state does not match', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-id'
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret'
    process.env.APP_URL = 'https://app.example.com'
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const payload = {
        provider: 'google',
        state: 'the-real-state',
        nonce: 'n',
        codeVerifier: 'v',
        createdAt: Date.now(),
      }
      const cookie = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
      const res = await fetch(`${url}/api/auth/callback/google?code=abc&state=forged-state`, {
        redirect: 'manual',
        headers: { Cookie: `maplespire_oidc=${cookie}` },
      })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('https://app.example.com/login?error=invalid_state')
    } finally {
      await close()
    }
  })

  it('redirects to invalid_state when the cookie is older than the 10-minute TTL', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-id'
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret'
    process.env.APP_URL = 'https://app.example.com'
    vi.resetModules()
    const { registerOidcRoutes } = await import('./oidc.js')
    const { url, close } = await startServer(registerOidcRoutes)
    try {
      const payload = {
        provider: 'google',
        state: 'the-real-state',
        nonce: 'n',
        codeVerifier: 'v',
        createdAt: Date.now() - 11 * 60 * 1000, // 11 minutes ago
      }
      const cookie = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
      const res = await fetch(`${url}/api/auth/callback/google?code=abc&state=the-real-state`, {
        redirect: 'manual',
        headers: { Cookie: `maplespire_oidc=${cookie}` },
      })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('https://app.example.com/login?error=invalid_state')
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// invites.ts
// ---------------------------------------------------------------------------

describe('POST /api/orgs/:orgId/invites', () => {
  it('401s with no req.auth (no session)', async () => {
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes)
    try {
      const res = await fetch(`${url}/api/orgs/org1/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', role: 'member' }),
      })
      expect(res.status).toBe(401)
    } finally {
      await close()
    }
  })

  it('403s when the caller is a non-admin org member and not a platform admin', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'member' }] }) // canManageOrg lookup
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes, {
      userId: 'u1',
      orgId: 'org1',
      isPlatformAdmin: false,
      epoch: 1,
    })
    try {
      const res = await fetch(`${url}/api/orgs/org1/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', role: 'member' }),
      })
      expect(res.status).toBe(403)
    } finally {
      await close()
    }
  })

  it('403s when the caller has no membership row at all in the target org', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // canManageOrg lookup: no row
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes, {
      userId: 'u1',
      orgId: 'org2',
      isPlatformAdmin: false,
      epoch: 1,
    })
    try {
      const res = await fetch(`${url}/api/orgs/org1/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', role: 'member' }),
      })
      expect(res.status).toBe(403)
    } finally {
      await close()
    }
  })

  it('skips the org-admin DB lookup entirely for a platform admin, and succeeds', async () => {
    // Isolated worktrees deliberately override APP_URL. Pin it here because
    // this test verifies the invite URL contract, not the caller's dev port.
    process.env.APP_URL = 'http://localhost:5173'
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'Acme Corp' }] }) // org lookup
      .mockResolvedValueOnce({ rows: [{ email: 'admin@platform.test' }] }) // inviter lookup
      .mockResolvedValueOnce({ rows: [] }) // insert org_invites

    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes, {
      userId: 'platform-admin-1',
      orgId: null,
      isPlatformAdmin: true,
      epoch: 1,
    })
    try {
      const res = await fetch(`${url}/api/orgs/org1/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'newperson@example.com', role: 'admin' }),
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { id: string; acceptUrl: string }
      expect(body.id).toBeTruthy()
      expect(body.acceptUrl).toMatch(/^http:\/\/localhost:5173\/invite\/[\w-]+$/)
      // canManageOrg must short-circuit on isPlatformAdmin — never queries org_members.
      expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining('org_members'), expect.anything())
      expect(sendMock).toHaveBeenCalledTimes(1)
      expect(appendAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'invite.created', orgId: 'org1' })
      )
    } finally {
      await close()
    }
  })

  it('rejects an invalid email with 400 before touching the database', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg lookup
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes, {
      userId: 'u1',
      orgId: 'org1',
      isPlatformAdmin: false,
      epoch: 1,
    })
    try {
      const res = await fetch(`${url}/api/orgs/org1/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email', role: 'member' }),
      })
      expect(res.status).toBe(400)
      // Only the one authorization query ran — no invite/org queries after the 400.
      expect(queryMock).toHaveBeenCalledTimes(1)
    } finally {
      await close()
    }
  })

  it('rejects an invalid role with 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg lookup
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes, {
      userId: 'u1',
      orgId: 'org1',
      isPlatformAdmin: false,
      epoch: 1,
    })
    try {
      const res = await fetch(`${url}/api/orgs/org1/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', role: 'owner' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })
})

describe('GET /api/auth/invite/:token', () => {
  it('never returns the token hash, and derives expired/accepted from the row', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          org_name: 'Acme Corp',
          role: 'member',
          inviter_email: 'admin@acme.test',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          accepted_at: null,
        },
      ],
    })
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes)
    try {
      const res = await fetch(`${url}/api/auth/invite/some-token`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        orgName: 'Acme Corp',
        role: 'member',
        inviterEmail: 'admin@acme.test',
        expired: false,
        accepted: false,
      })
      expect(JSON.stringify(body)).not.toContain('hash')
    } finally {
      await close()
    }
  })

  it('reports expired=true for a past expiry', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          org_name: 'Acme Corp',
          role: 'member',
          inviter_email: 'admin@acme.test',
          expires_at: new Date(Date.now() - 60_000).toISOString(),
          accepted_at: null,
        },
      ],
    })
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes)
    try {
      const res = await fetch(`${url}/api/auth/invite/some-token`)
      const body = await res.json()
      expect(body.expired).toBe(true)
    } finally {
      await close()
    }
  })

  it('404s for an unknown token', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes)
    try {
      const res = await fetch(`${url}/api/auth/invite/nope`)
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })

  it('hashes the raw token with sha256 hex before querying (never queries the raw token)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes)
    try {
      const rawToken = 'my-raw-invite-token'
      await fetch(`${url}/api/auth/invite/${rawToken}`)
      const expectedHash = createHash('sha256').update(rawToken).digest('hex')
      const [, params] = queryMock.mock.calls[0] as [string, unknown[]]
      expect(params).toEqual([expectedHash])
    } finally {
      await close()
    }
  })
})

describe('POST /api/auth/invite/:token/accept', () => {
  /** SQL-routing mock for the hardened accept flow (transaction + FOR UPDATE):
   * the exact call ORDER is an implementation detail, so route by statement
   * instead of by position. */
  function routeAcceptQueries(
    invite: Record<string, unknown> | null,
    opts?: { sessionEmail?: string; memberInsertRowCount?: number; teamIds?: string[] }
  ): void {
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql)
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] }
      if (s.includes('FROM org_invites') && s.includes('FOR UPDATE')) return { rows: invite ? [invite] : [] }
      if (s.includes('SELECT email FROM users')) return { rows: [{ email: opts?.sessionEmail ?? 'invited@example.com' }] }
      if (s.includes('INSERT INTO org_members')) return { rows: [], rowCount: opts?.memberInsertRowCount ?? 1 }
      if (s.includes('FROM invite_teams')) return { rows: (opts?.teamIds ?? []).map((t) => ({ team_id: t })) }
      if (s.includes('INSERT INTO team_members')) return { rows: [], rowCount: 1 }
      if (s.includes('UPDATE org_invites SET accepted_at')) return { rows: [] }
      if (s.includes('UPDATE users SET last_org_id')) return { rows: [] }
      if (s.includes('FROM auth_epochs')) return { rows: [{ epoch: '4' }] } // BIGINT → string
      return { rows: [] }
    })
  }

  const pendingInvite = (over?: Record<string, unknown>) => ({
    id: 'inv1',
    org_id: 'org1',
    email: 'invited@example.com',
    role: 'member',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    accepted_at: null,
    ...over,
  })

  it('401s with a stable sign_in_required code when there is no session', async () => {
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes)
    try {
      const res = await fetch(`${url}/api/auth/invite/tok/accept`, { method: 'POST' })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'sign_in_required' })
    } finally {
      await close()
    }
  })

  it('410s an already-accepted invite', async () => {
    routeAcceptQueries(pendingInvite({ accepted_at: new Date().toISOString() }))
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes, {
      userId: 'u1',
      orgId: null,
      isPlatformAdmin: false,
      epoch: 1,
    })
    try {
      const res = await fetch(`${url}/api/auth/invite/tok/accept`, { method: 'POST' })
      expect(res.status).toBe(410)
    } finally {
      await close()
    }
  })

  it('410s an expired invite', async () => {
    routeAcceptQueries(pendingInvite({ expires_at: new Date(Date.now() - 60_000).toISOString() }))
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes, {
      userId: 'u1',
      orgId: null,
      isPlatformAdmin: false,
      epoch: 1,
    })
    try {
      const res = await fetch(`${url}/api/auth/invite/tok/accept`, { method: 'POST' })
      expect(res.status).toBe(410)
    } finally {
      await close()
    }
  })

  it("403s email_mismatch (masked hint) when the session's email differs from the invited address", async () => {
    routeAcceptQueries(pendingInvite({ email: 'someone-else@example.com' }), {
      sessionEmail: 'attacker@example.com',
    })
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes, {
      userId: 'session-user-1',
      orgId: null,
      isPlatformAdmin: false,
      epoch: 1,
    })
    try {
      const res = await fetch(`${url}/api/auth/invite/tok/accept`, { method: 'POST' })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'email_mismatch', invitedEmail: 's***@example.com' })
      // Nothing was granted and the invite stays pending.
      const calls = queryMock.mock.calls.map((c) => String(c[0]))
      expect(calls.some((s) => s.includes('INSERT INTO org_members'))).toBe(false)
      expect(calls.some((s) => s.includes('UPDATE org_invites SET accepted_at'))).toBe(false)
    } finally {
      await close()
    }
  })

  it('accepts a matching-email invite (case-insensitive), applies pre-assigned teams, audits, and re-pins the session', async () => {
    process.env.AUTH_SECRET = 'test-secret-for-accept-repin'
    routeAcceptQueries(pendingInvite({ email: 'Invited@Example.com', role: 'admin' }), {
      sessionEmail: 'invited@example.com',
      teamIds: ['team-a', 'team-b'],
    })
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes, {
      userId: 'session-user-1',
      orgId: null,
      isPlatformAdmin: false,
      epoch: 1,
    })
    try {
      const res = await fetch(`${url}/api/auth/invite/tok/accept`, { method: 'POST' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ orgId: 'org1', alreadyMember: false, teamsApplied: 2 })
      // The org-less session got re-pinned: a fresh session cookie is set.
      expect(res.headers.get('set-cookie')).toContain('maplespire_session=')
      // Both team memberships were written.
      const teamInserts = queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO team_members'))
      expect(teamInserts.map((c) => (c[1] as unknown[])[0])).toEqual(['team-a', 'team-b'])
      expect(appendAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'invite.accepted',
          orgId: 'org1',
          actorUserId: 'session-user-1',
          detail: expect.objectContaining({
            invitedEmail: 'Invited@Example.com',
            acceptedByUserId: 'session-user-1',
            teamIds: ['team-a', 'team-b'],
            alreadyMember: false,
          }),
        })
      )
    } finally {
      await close()
    }
  })

  it('never rewrites an existing membership role — reports alreadyMember instead', async () => {
    process.env.AUTH_SECRET = 'test-secret-for-accept-repin'
    routeAcceptQueries(pendingInvite({ role: 'admin' }), {
      sessionEmail: 'invited@example.com',
      memberInsertRowCount: 0, // ON CONFLICT DO NOTHING — already a member
    })
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes, {
      userId: 'session-user-1',
      orgId: null,
      isPlatformAdmin: false,
      epoch: 1,
    })
    try {
      const res = await fetch(`${url}/api/auth/invite/tok/accept`, { method: 'POST' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ orgId: 'org1', alreadyMember: true, teamsApplied: 0 })
      // The insert used DO NOTHING — no role-overwriting variant anywhere.
      const memberSql = queryMock.mock.calls.map((c) => String(c[0])).find((s) => s.includes('INSERT INTO org_members'))
      expect(memberSql).toContain('DO NOTHING')
      expect(memberSql).not.toContain('DO UPDATE')
    } finally {
      await close()
    }
  })

  it('404s an unknown token', async () => {
    routeAcceptQueries(null)
    vi.resetModules()
    const { registerInviteRoutes } = await import('./invites.js')
    const { url, close } = await startServer(registerInviteRoutes, {
      userId: 'u1',
      orgId: null,
      isPlatformAdmin: false,
      epoch: 1,
    })
    try {
      const res = await fetch(`${url}/api/auth/invite/tok/accept`, { method: 'POST' })
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })
})
