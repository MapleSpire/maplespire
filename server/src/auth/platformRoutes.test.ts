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

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import pg from 'pg'
import { randomBytes } from 'node:crypto'

/**
 * Tests for platformRoutes.ts (Platform Admin console REST endpoints).
 *
 * Same two-tier shape as `rbac/orgRoutes.test.ts`:
 *  - Stub-pool tests for the 401/403 fresh-DB-check authorization surface +
 *    input validation — DB-free, always run.
 *  - `describe.skipIf(!process.env.TEST_DATABASE_URL)` integration tests
 *    against a real Postgres for: org create/suspend + epoch bump,
 *    last-platform-admin 409, impersonate mints an imp cookie + exit
 *    restores the admin session, suspended-org login refusal.
 */

// ---------------------------------------------------------------------------
// Stub-pool tests (DB-free)
// ---------------------------------------------------------------------------

const queryMock = vi.fn()
const appendAuditMock = vi.fn().mockResolvedValue(undefined)
const explainAccessMock = vi.fn()
const liveConnectionCountMock = vi.fn().mockReturnValue(0)

vi.mock('../db.js', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args), connect: () => connectMock() },
}))
vi.mock('./audit.js', () => ({
  appendAudit: (...args: unknown[]) => appendAuditMock(...args),
}))
vi.mock('../rbac/access.js', () => ({
  explainAccess: (...args: unknown[]) => explainAccessMock(...args),
}))
vi.mock('./wsAuth.js', () => ({
  liveConnectionCount: () => liveConnectionCountMock(),
}))

function makeStubClient() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  }
}
let stubClient = makeStubClient()
function connectMock() {
  return Promise.resolve(stubClient)
}

async function startServer(
  register: (app: express.Express) => void,
  auth?: { userId: string; orgId: string | null; isPlatformAdmin: boolean; epoch: number; imp?: { by: string } }
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

const platformAdminAuth = { userId: 'platform-1', orgId: null, isPlatformAdmin: true, epoch: 1 }
const memberAuth = { userId: 'u1', orgId: 'org1', isPlatformAdmin: false, epoch: 1 }
// A cookie can claim isPlatformAdmin=true, but the fresh DB re-check is what
// actually gates every route — this stub proves the cookie flag alone is
// never trusted.
const staleAdminCookieAuth = { userId: 'was-admin-1', orgId: null, isPlatformAdmin: true, epoch: 1 }

beforeEach(() => {
  queryMock.mockReset()
  appendAuditMock.mockClear()
  explainAccessMock.mockReset()
  liveConnectionCountMock.mockReturnValue(0)
  stubClient = makeStubClient()
})

afterEach(() => {
  vi.resetModules()
})

describe('platform routes: authorization surfaces', () => {
  const endpoints: Array<{ method: 'get' | 'post' | 'patch' | 'put' | 'delete'; path: string; body?: unknown }> = [
    { method: 'get', path: '/api/platform/overview' },
    { method: 'get', path: '/api/platform/settings' },
    { method: 'patch', path: '/api/platform/settings', body: { requireIndependentTechnologyReview: false } },
    { method: 'get', path: '/api/platform/orgs' },
    { method: 'post', path: '/api/platform/orgs', body: { name: 'Acme', slug: 'acme' } },
    { method: 'patch', path: '/api/platform/orgs/org1', body: { status: 'suspended' } },
    { method: 'get', path: '/api/platform/users' },
    { method: 'patch', path: '/api/platform/users/u2', body: { status: 'deactivated' } },
    { method: 'patch', path: '/api/platform/users/u2/platform-admin', body: { grant: true } },
    { method: 'post', path: '/api/platform/impersonate', body: { userId: 'u2' } },
    { method: 'delete', path: '/api/platform/impersonations/imp1' },
    { method: 'get', path: '/api/platform/impersonations' },
    { method: 'get', path: '/api/platform/access-debug?userId=u2&scopeId=s1' },
    { method: 'get', path: '/api/platform/audit' },
  ]

  for (const ep of endpoints) {
    it(`${ep.method.toUpperCase()} ${ep.path} -> 401 with no session`, async () => {
      vi.resetModules()
      const { registerPlatformRoutes } = await import('./platformRoutes.js')
      const { url, close } = await startServer(registerPlatformRoutes)
      try {
        const res = await fetch(`${url}${ep.path}`, {
          method: ep.method.toUpperCase(),
          headers: { 'Content-Type': 'application/json' },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        })
        expect(res.status).toBe(401)
      } finally {
        await close()
      }
    })

    it(`${ep.method.toUpperCase()} ${ep.path} -> 403 for a non-platform-admin session`, async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ is_platform_admin: false, status: 'active' }] }) // fresh DB check
      vi.resetModules()
      const { registerPlatformRoutes } = await import('./platformRoutes.js')
      const { url, close } = await startServer(registerPlatformRoutes, memberAuth)
      try {
        const res = await fetch(`${url}${ep.path}`, {
          method: ep.method.toUpperCase(),
          headers: { 'Content-Type': 'application/json' },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        })
        expect(res.status).toBe(403)
      } finally {
        await close()
      }
    })

    it(`${ep.method.toUpperCase()} ${ep.path} -> 403 when the cookie claims platform admin but the DB says otherwise (revoked mid-session)`, async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ is_platform_admin: false, status: 'active' }] }) // fresh DB check overrides the stale cookie
      vi.resetModules()
      const { registerPlatformRoutes } = await import('./platformRoutes.js')
      const { url, close } = await startServer(registerPlatformRoutes, staleAdminCookieAuth)
      try {
        const res = await fetch(`${url}${ep.path}`, {
          method: ep.method.toUpperCase(),
          headers: { 'Content-Type': 'application/json' },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        })
        expect(res.status).toBe(403)
      } finally {
        await close()
      }
    })

    it(`${ep.method.toUpperCase()} ${ep.path} -> 403 when the user row no longer exists`, async () => {
      queryMock.mockResolvedValueOnce({ rows: [] }) // fresh DB check: no such user
      vi.resetModules()
      const { registerPlatformRoutes } = await import('./platformRoutes.js')
      const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
      try {
        const res = await fetch(`${url}${ep.path}`, {
          method: ep.method.toUpperCase(),
          headers: { 'Content-Type': 'application/json' },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        })
        expect(res.status).toBe(403)
      } finally {
        await close()
      }
    })
  }
})

describe('GET /api/platform/overview', () => {
  it('returns global counters including liveConnections from the WS registry', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] }) // fresh DB check
      .mockResolvedValueOnce({ rows: [{ n: '4' }] }) // orgs
      .mockResolvedValueOnce({ rows: [{ n: '10' }] }) // users
      .mockResolvedValueOnce({ rows: [{ n: '7' }] }) // landscapes
      .mockResolvedValueOnce({ rows: [{ n: '12' }] }) // versions
      .mockResolvedValueOnce({ rows: [{ n: '1' }] }) // activeImpersonations
    liveConnectionCountMock.mockReturnValue(3)

    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/overview`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        orgs: 4,
        users: 10,
        landscapes: 7,
        versions: 12,
        liveConnections: 3,
        activeImpersonations: 1,
      })
    } finally {
      await close()
    }
  })
})

describe('platform settings', () => {
  it('returns the configured policy and automatically bypasses it for a sole active admin', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{
        settings: { requireIndependentTechnologyReview: true },
        active_platform_admin_count: 1,
      }] })

    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/settings`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        requireIndependentTechnologyReview: true,
        activePlatformAdminCount: 1,
        independentTechnologyReviewEffective: false,
      })
    } finally {
      await close()
    }
  })

  it('strictly updates the independent-review setting and audits the change', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{
        settings: { requireIndependentTechnologyReview: true },
        active_platform_admin_count: 2,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        settings: { requireIndependentTechnologyReview: false },
        active_platform_admin_count: 2,
      }] })

    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireIndependentTechnologyReview: false }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        requireIndependentTechnologyReview: false,
        independentTechnologyReviewEffective: false,
      })
      expect(appendAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'platform.settings-updated',
          detail: expect.objectContaining({ previous: true, current: false, effective: false }),
        }),
      )
    } finally {
      await close()
    }
  })

  it('rejects unknown settings instead of persisting an open JSON bag', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] })
    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireIndependentTechnologyReview: false, unknown: true }),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid-platform-settings' })
    } finally {
      await close()
    }
  })
})

describe('POST /api/platform/orgs', () => {
  it('rejects an invalid slug with 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] })
    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/orgs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme', slug: 'NOT VALID!' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('409s when the slug is already taken', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // slug exists

    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/orgs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      })
      expect(res.status).toBe(409)
    } finally {
      await close()
    }
  })

  it('creates an org and audits platform.org-created', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [] }) // slug free
      .mockResolvedValueOnce({ rows: [] }) // insert

    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/orgs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.slug).toBe('acme')
      expect(appendAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'platform.org-created' })
      )
    } finally {
      await close()
    }
  })
})

describe('PATCH /api/platform/orgs/:orgId', () => {
  it('rejects an invalid status with 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] })
    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/orgs/org1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('404s when the org does not exist', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [] }) // org lookup: not found

    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/orgs/ghost`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'suspended' }),
      })
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })

  it('suspends an org and bumps its epoch', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // org lookup
      .mockResolvedValueOnce({ rows: [] }) // update
      .mockResolvedValueOnce({ rows: [] }) // bump_auth_epoch

    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/orgs/org1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'suspended' }),
      })
      expect(res.status).toBe(200)
      expect(queryMock).toHaveBeenCalledWith('SELECT bump_auth_epoch($1)', ['org1'])
      expect(appendAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'platform.org-suspended' })
      )
    } finally {
      await close()
    }
  })
})

describe('PATCH /api/platform/users/:userId/platform-admin', () => {
  it('rejects a non-boolean grant with 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] })
    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/users/u2/platform-admin`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant: 'yes' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('409s revoking the last platform admin', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] }) // fresh check
    stubClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'platform-1' }] }) // admin rows FOR UPDATE (only one)
      .mockResolvedValueOnce({ rows: [{ is_platform_admin: true }] }) // target lookup: is the only admin
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK

    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/users/platform-1/platform-admin`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant: false }),
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'last-platform-admin' })
    } finally {
      await close()
    }
  })

  it('grants platform-admin to a second user without conflict', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] }) // fresh check
    stubClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'platform-1' }] }) // admin rows FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ is_platform_admin: false }] }) // target lookup
      .mockResolvedValueOnce({ rows: [] }) // update
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/users/u2/platform-admin`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant: true }),
      })
      expect(res.status).toBe(200)
      expect(appendAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'platform.admin-granted' })
      )
    } finally {
      await close()
    }
  })
})

describe('POST /api/platform/impersonate', () => {
  it('requires a userId with 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] })
    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/impersonate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('404s for an unknown target user', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [] }) // target lookup: not found

    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/impersonate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'ghost' }),
      })
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })

  it('400s for a deactivated target user', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ is_platform_admin: true, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'u2', email: 'b@example.com', status: 'deactivated' }] })

    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/impersonate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u2' }),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'target-not-active' })
    } finally {
      await close()
    }
  })

  // QA lens round 2 (2026-10-17): the 403 mapping survived its deletion. The
  // gate read the admin as active; the mint's own read (one statement with the
  // epoch) finds them deactivated since — it must refuse, and say why.
  it('403s with the mint refusal when the impersonator is deactivated between the gate and the mint', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (s.includes('SELECT is_platform_admin, status FROM users')) return { rows: [{ is_platform_admin: true, status: 'active' }] }
      if (s.includes('SELECT id, email, status FROM users')) return { rows: [{ id: 'u2', email: 'b@example.com', status: 'active' }] }
      if (s.includes('FROM org_members WHERE user_id')) return { rows: [{ org_id: 'org1' }] }
      if (s.includes('LEFT JOIN auth_global_epochs')) {
        return { rows: [
          { id: 'u2', is_platform_admin: false, status: 'active', gepoch: '1' },
          { id: 'platform-1', is_platform_admin: true, status: 'deactivated', gepoch: '2' },
        ] }
      }
      if (s.includes('FROM orgs o')) return { rows: [{ status: 'active', epoch: '1', uepoch: '1', member: true }] }
      return { rows: [] }
    })
    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/platform/impersonate`, {
        method: 'POST',
        // A current cookie, so the stash reuses it rather than minting.
        headers: { 'Content-Type': 'application/json', Cookie: 'maplespire_session=the-admins-own-cookie' },
        body: JSON.stringify({ userId: 'u2' }),
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'impersonator_not_admin' })
      expect((res.headers.getSetCookie?.() ?? []).filter((c) => c.startsWith('maplespire_session='))).toEqual([])
      expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO impersonations'))).toBe(false)
    } finally {
      await close()
    }
  })
})

describe('POST /api/auth/impersonate/exit', () => {
  it('400s when the session is not an impersonation session', async () => {
    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const { url, close } = await startServer(registerPlatformRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/auth/impersonate/exit`, { method: 'POST' })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'not-impersonating' })
    } finally {
      await close()
    }
  })

  it('400s when there is no stashed admin cookie', async () => {
    vi.resetModules()
    const { registerPlatformRoutes } = await import('./platformRoutes.js')
    const impAuth = { userId: 'target1', orgId: 'org1', isPlatformAdmin: false, epoch: 1, imp: { by: 'admin1' } }
    const { url, close } = await startServer(registerPlatformRoutes, impAuth)
    try {
      const res = await fetch(`${url}/api/auth/impersonate/exit`, { method: 'POST' })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'no-stashed-session' })
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// Integration tests against a real Postgres
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

function rid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('base64url')}`
}

describe.skipIf(!TEST_DATABASE_URL)('platform routes (live Postgres)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb
  let realPool: pg.Pool
  let registerPlatformRoutes: (app: express.Express) => void

  beforeAll(async () => {
    // impersonate/exit sign+verify real session JWTs — AUTH_SECRET must be
    // set before any route in this describe block runs, not just before the
    // exit-flow test (signSession throws loud with no secret, by design).
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-secret-for-platform-routes-integration'

    vi.doUnmock('../db.js')
    vi.doUnmock('./audit.js')
    vi.doUnmock('../rbac/access.js')
    vi.doUnmock('./wsAuth.js')
    vi.resetModules()

    // Isolated schema is load-bearing: tests below suspend "the default org"
    // and flip is_platform_admin globally — inside this throwaway schema those
    // are pure fixtures; the shared database's real rows are unreachable.
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'platform_routes')
    realPool = db.pool
    const { ensureAuthSchema } = await import('./schema.js')
    const { ensureRbacSchema } = await import('../rbac/schema.js')
    const { ensureEpochTriggers } = await import('./wsAuth.js')
    await ensureAuthSchema(realPool)
    await ensureRbacSchema(realPool)
    await ensureEpochTriggers(realPool)

    vi.doMock('../db.js', () => ({ pool: realPool }))
    vi.resetModules()
    ;({ registerPlatformRoutes } = await import('./platformRoutes.js'))
  })

  afterAll(async () => {
    await db?.teardown()
    vi.doUnmock('../db.js')
    vi.resetModules()
  })

  async function makeOrg(): Promise<string> {
    const id = rid('org')
    await realPool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [id, `Org ${id}`, id.replace(/_/g, '-')])
    return id
  }

  async function makeUser(email: string, opts?: { isPlatformAdmin?: boolean }): Promise<string> {
    const id = rid('user')
    await realPool.query(
      `INSERT INTO users (id, issuer, subject, email, name, is_platform_admin) VALUES ($1, 'test', $2, $3, $3, $4)`,
      [id, id, email, opts?.isPlatformAdmin ?? false]
    )
    return id
  }

  async function addOrgMember(orgId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
    await realPool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)`, [orgId, userId, role])
  }

  async function dropOrg(orgId: string): Promise<void> {
    await realPool.query(`DELETE FROM orgs WHERE id = $1`, [orgId])
  }

  async function dropUser(userId: string): Promise<void> {
    await realPool.query(`DELETE FROM users WHERE id = $1`, [userId])
  }

  async function withServer<T>(
    auth: { userId: string; orgId: string | null; isPlatformAdmin: boolean; epoch: number; imp?: { by: string } },
    fn: (url: string) => Promise<T>
  ): Promise<T> {
    const { url, close } = await startServer(registerPlatformRoutes, auth)
    try {
      return await fn(url)
    } finally {
      await close()
    }
  }

  it('org create + suspend bumps the epoch', async () => {
    const platformAdminId = await makeUser('platform-admin@example.com', { isPlatformAdmin: true })
    try {
      const slug = rid('acme').replace(/_/g, '-').toLowerCase()
      let orgId = ''
      await withServer({ userId: platformAdminId, orgId: null, isPlatformAdmin: true, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/platform/orgs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Acme Corp', slug }),
        })
        expect(res.status).toBe(201)
        const body = await res.json()
        orgId = body.id
      })

      const { rows: beforeEpoch } = await realPool.query('SELECT epoch FROM auth_epochs WHERE org_id = $1', [orgId])
      const epochBefore = beforeEpoch[0] ? Number(beforeEpoch[0].epoch) : 1

      await withServer({ userId: platformAdminId, orgId: null, isPlatformAdmin: true, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/platform/orgs/${orgId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'suspended' }),
        })
        expect(res.status).toBe(200)
      })

      const { rows: afterStatus } = await realPool.query('SELECT status, id FROM orgs WHERE id = $1', [orgId])
      expect(afterStatus[0].status).toBe('suspended')

      const { rows: afterEpoch } = await realPool.query<{ epoch: string }>('SELECT epoch FROM auth_epochs WHERE org_id = $1', [orgId])
      expect(Number(afterEpoch[0].epoch)).toBeGreaterThan(epochBefore)

      await dropOrg(orgId)
    } finally {
      await dropUser(platformAdminId)
    }
  })

  it("deactivating a user revokes THEIR sessions in every org they belong to — not their colleagues'", async () => {
    const platformAdminId = await makeUser('deactivate-platform-admin@example.com', { isPlatformAdmin: true })
    const targetUserId = await makeUser('multi-org-member@example.com')
    const colleagueId = await makeUser('deactivate-colleague@example.com')
    const orgA = await makeOrg()
    const orgB = await makeOrg()
    try {
      await addOrgMember(orgA, targetUserId, 'member')
      await addOrgMember(orgB, targetUserId, 'member')
      await addOrgMember(orgA, colleagueId, 'member')

      const epochOf = async (table: 'auth_epochs' | 'auth_user_epochs', orgId: string, userId?: string) => {
        const { rows } = table === 'auth_epochs'
          ? await realPool.query<{ epoch: string }>('SELECT epoch FROM auth_epochs WHERE org_id = $1', [orgId])
          : await realPool.query<{ epoch: string }>('SELECT epoch FROM auth_user_epochs WHERE org_id = $1 AND user_id = $2', [orgId, userId])
        return rows[0] ? Number(rows[0].epoch) : 1 // no row = implicit epoch 1 (see auth/schema.ts)
      }
      const before = {
        orgA: await epochOf('auth_epochs', orgA),
        orgB: await epochOf('auth_epochs', orgB),
        colleague: await epochOf('auth_user_epochs', orgA, colleagueId),
      }

      await withServer({ userId: platformAdminId, orgId: null, isPlatformAdmin: true, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/platform/users/${targetUserId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'deactivated' }),
        })
        expect(res.status).toBe(200)
      })

      const { rows: statusRows } = await realPool.query('SELECT status FROM users WHERE id = $1', [targetUserId])
      expect(statusRows[0].status).toBe('deactivated')

      // The target's epoch moved in BOTH orgs…
      expect(await epochOf('auth_user_epochs', orgA, targetUserId)).toBeGreaterThan(1)
      expect(await epochOf('auth_user_epochs', orgB, targetUserId)).toBeGreaterThan(1)
      // …and neither org's epoch nor a colleague's did.
      expect(await epochOf('auth_epochs', orgA)).toBe(before.orgA)
      expect(await epochOf('auth_epochs', orgB)).toBe(before.orgB)
      expect(await epochOf('auth_user_epochs', orgA, colleagueId)).toBe(before.colleague)
    } finally {
      await dropOrg(orgA)
      await dropOrg(orgB)
      await dropUser(targetUserId)
      await dropUser(colleagueId)
      await dropUser(platformAdminId)
    }
  })

  it('last-platform-admin protection: revoking the only admin returns 409 and changes nothing', async () => {
    // This asserts a GLOBAL invariant ("there is exactly one platform admin
    // right now"). The suite's isolated schema means "global" is only this
    // file's own fixtures, but earlier tests in this file create platform
    // admins too — if one crashed mid-test its admin row may linger, so
    // neutralize any other admin first and restore in `finally`.
    const { rows: otherAdmins } = await realPool.query<{ id: string }>('SELECT id FROM users WHERE is_platform_admin = true')
    if (otherAdmins.length > 0) {
      await realPool.query(
        'UPDATE users SET is_platform_admin = false WHERE id = ANY($1::text[])',
        [otherAdmins.map((r) => r.id)]
      )
    }

    const soleAdminId = await makeUser('sole-platform-admin@example.com', { isPlatformAdmin: true })
    try {
      await withServer({ userId: soleAdminId, orgId: null, isPlatformAdmin: true, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/platform/users/${soleAdminId}/platform-admin`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant: false }),
        })
        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ error: 'last-platform-admin' })
      })

      const { rows } = await realPool.query('SELECT is_platform_admin FROM users WHERE id = $1', [soleAdminId])
      expect(rows[0].is_platform_admin).toBe(true)
    } finally {
      await dropUser(soleAdminId)
      if (otherAdmins.length > 0) {
        await realPool.query(
          'UPDATE users SET is_platform_admin = true WHERE id = ANY($1::text[])',
          [otherAdmins.map((r) => r.id)]
        )
      }
    }
  })

  it('revoking one of TWO platform admins succeeds', async () => {
    const admin1 = await makeUser('platform-admin-1@example.com', { isPlatformAdmin: true })
    const admin2 = await makeUser('platform-admin-2@example.com', { isPlatformAdmin: true })
    try {
      await withServer({ userId: admin1, orgId: null, isPlatformAdmin: true, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/platform/users/${admin2}/platform-admin`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant: false }),
        })
        expect(res.status).toBe(200)
      })

      const { rows } = await realPool.query('SELECT is_platform_admin FROM users WHERE id = $1', [admin2])
      expect(rows[0].is_platform_admin).toBe(false)
    } finally {
      await dropUser(admin1)
      await dropUser(admin2)
    }
  })

  /**
   * The cookie gates a revoked session must fail, as production wires them:
   * the HTTP gate (requireAuth + the session epoch validator), GET
   * /api/auth/me, and the sync upgrade check. `upgrade` is the burst-cached
   * validator the upgrade calls (automergeServer.ts), against the live
   * triggers, and must agree with the uncached isSessionEpochCurrent that
   * /api/auth/me runs (QA lens, 2026-10-16: the validator had only ever met
   * fake databases).
   */
  async function withCookieGates<T>(fn: (check: (token: string) => Promise<{ http: number; httpCleared: boolean; me: number; meCode?: string; meCleared: boolean; upgrade: boolean }>) => Promise<T>): Promise<T> {
    const savedAuth = process.env.AUTH
    process.env.AUTH = 'on'
    const { requireAuth } = await import('./middleware.js')
    const { registerAuthRoutes } = await import('./devLogin.js')
    const { createSessionEpochValidator, isSessionEpochCurrent } = await import('./sessionEpoch.js')
    const { verifySession } = await import('./tokens.js')
    const validator = createSessionEpochValidator(realPool, { cacheTtlMs: 0 })
    const app = express()
    app.use(express.json())
    app.use('/api', requireAuth({ isSessionCurrent: validator }))
    registerAuthRoutes(app)
    app.get('/api/probe', (req, res) => {
      res.json({ isPlatformAdmin: req.auth?.isPlatformAdmin })
    })
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      return await fn(async (token) => {
        const headers = { Cookie: `maplespire_session=${encodeURIComponent(token)}` }
        const http = await fetch(`${url}/api/probe`, { headers })
        const me = await fetch(`${url}/api/auth/me`, { headers })
        const meBody = (await me.json()) as { code?: string }
        const claims = await verifySession(token)
        const cleared = (r: Response) => (r.headers.get('set-cookie') ?? '').startsWith('maplespire_session=;')
        return {
          http: http.status,
          httpCleared: cleared(http),
          me: me.status,
          meCode: meBody.code,
          meCleared: cleared(me),
          upgrade: await (async () => {
            const [cached, uncached] = await Promise.all([validator(claims!), isSessionEpochCurrent(realPool, claims!)])
            expect(cached).toBe(uncached)
            return cached
          })(),
        }
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (savedAuth === undefined) delete process.env.AUTH
      else process.env.AUTH = savedAuth
    }
  }
  const accepted = { http: 200, httpCleared: false, me: 200, meCode: undefined, meCleared: false, upgrade: true }
  const revoked = { http: 401, httpCleared: true, me: 401, meCode: 'session_stale', meCleared: true, upgrade: false }

  // Regression (architect lens, 2026-10-16): the revoke bumped no epoch, so the
  // old cookie — whose signed isPlatformAdmin the sync gate and HTTP routes
  // trust across every org — stayed good for its 30-day life.
  it("revoking platform admin ends the revoked admin's sessions on every gate — org-less, org-pinned, and impersonations they started — and nobody else's", async () => {
    const actor = await makeUser('revoking-admin@example.com', { isPlatformAdmin: true })
    const revokedAdmin = await makeUser('revoked-admin@example.com', { isPlatformAdmin: true })
    const target = await makeUser('revoked-admin-target@example.com')
    const orgId = await makeOrg()
    try {
      await addOrgMember(orgId, revokedAdmin, 'admin')
      await addOrgMember(orgId, target, 'member')
      const { signCurrentSession } = await import('./sessionEpoch.js')
      const sessions = {
        orgless: await signCurrentSession(realPool, { userId: revokedAdmin, orgId: null, isPlatformAdmin: true }),
        inOrg: await signCurrentSession(realPool, { userId: revokedAdmin, orgId, isPlatformAdmin: true }),
        impersonation: await signCurrentSession(realPool, { userId: target, orgId, isPlatformAdmin: false, imp: { by: revokedAdmin } }),
        actor: await signCurrentSession(realPool, { userId: actor, orgId: null, isPlatformAdmin: true }),
        target: await signCurrentSession(realPool, { userId: target, orgId, isPlatformAdmin: false }),
      }

      await withCookieGates(async (check) => {
        for (const token of Object.values(sessions)) expect(await check(token)).toEqual(accepted)

        await withServer({ userId: actor, orgId: null, isPlatformAdmin: true, epoch: 1 }, async (url) => {
          const res = await fetch(`${url}/api/platform/users/${revokedAdmin}/platform-admin`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grant: false }),
          })
          expect(res.status).toBe(200)
        })

        expect(await check(sessions.orgless)).toEqual(revoked)
        expect(await check(sessions.inOrg)).toEqual(revoked)
        expect(await check(sessions.impersonation)).toEqual(revoked)
        expect(await check(sessions.actor)).toEqual(accepted)
        expect(await check(sessions.target)).toEqual(accepted)

        // Signing in again works, and carries the truth.
        const fresh = await signCurrentSession(realPool, { userId: revokedAdmin, orgId: null, isPlatformAdmin: false })
        expect(await check(fresh)).toEqual(accepted)
      })
    } finally {
      await dropOrg(orgId)
      for (const id of [target, revokedAdmin, actor]) await dropUser(id)
    }
  })

  it('granting platform admin revokes nothing: the grantee keeps working', async () => {
    const actor = await makeUser('granting-admin@example.com', { isPlatformAdmin: true })
    const grantee = await makeUser('grantee@example.com')
    try {
      const { signCurrentSession } = await import('./sessionEpoch.js')
      const session = await signCurrentSession(realPool, { userId: grantee, orgId: null, isPlatformAdmin: false })
      await withCookieGates(async (check) => {
        await withServer({ userId: actor, orgId: null, isPlatformAdmin: true, epoch: 1 }, async (url) => {
          const res = await fetch(`${url}/api/platform/users/${grantee}/platform-admin`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grant: true }),
          })
          expect(res.status).toBe(200)
        })
        expect(await check(session)).toEqual(accepted)
      })
    } finally {
      await dropUser(grantee)
      await dropUser(actor)
    }
  })

  // Regression (architect lens, 2026-10-16): deactivation bumped only the
  // (org, user) epochs of the user's CURRENT memberships, which an org-less
  // session never checks; and the user could simply sign in again (dev-login
  // and OIDC never read `users.status`).
  it('deactivating a user ends their org-less and org sessions, and they cannot sign straight back in', async () => {
    const actor = await makeUser('deactivating-admin@example.com', { isPlatformAdmin: true })
    const email = `deactivated-${rid('u').toLowerCase()}@example.com`
    const { rows: [{ id: user }] } = await realPool.query<{ id: string }>(
      `INSERT INTO users (id, issuer, subject, email, name) VALUES ($1, 'dev', $2, $2, $2) RETURNING id`,
      [rid('user'), email],
    )
    const orgId = await makeOrg()
    try {
      await addOrgMember(orgId, user, 'member')
      const { signCurrentSession } = await import('./sessionEpoch.js')
      const orgless = await signCurrentSession(realPool, { userId: user, orgId: null, isPlatformAdmin: false })
      const inOrg = await signCurrentSession(realPool, { userId: user, orgId, isPlatformAdmin: false })

      await withCookieGates(async (check) => {
        expect(await check(orgless)).toEqual(accepted)
        expect(await check(inOrg)).toEqual(accepted)

        await withServer({ userId: actor, orgId: null, isPlatformAdmin: true, epoch: 1 }, async (url) => {
          const res = await fetch(`${url}/api/platform/users/${user}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'deactivated' }),
          })
          expect(res.status).toBe(200)
        })

        expect(await check(orgless)).toEqual(revoked)
        expect(await check(inOrg)).toEqual(revoked)
      })

      // Signing in again through dev-login is refused, and mints nothing.
      const savedDevLogin = process.env.AUTH_DEV_LOGIN
      process.env.AUTH_DEV_LOGIN = 'on'
      try {
        const { registerAuthRoutes } = await import('./devLogin.js')
        const { url, close } = await startServer(registerAuthRoutes)
        try {
          const res = await fetch(`${url}/api/auth/dev-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          })
          expect(res.status).toBe(403)
          expect(await res.json()).toEqual({ error: 'user_inactive' })
          expect(res.headers.getSetCookie?.() ?? []).toEqual([])
        } finally {
          await close()
        }
      } finally {
        if (savedDevLogin === undefined) delete process.env.AUTH_DEV_LOGIN
        else process.env.AUTH_DEV_LOGIN = savedDevLogin
      }
    } finally {
      await dropOrg(orgId)
      await dropUser(user)
      await dropUser(actor)
    }
  })

  // Regression (reviewer + architect lenses, 2026-10-16): the mint read the
  // epoch AFTER the caller had decided the facts. switch-org copied
  // `isPlatformAdmin` from the old cookie; a switch that ran after the revoke
  // committed minted `{ isPlatformAdmin: true, gepoch: <bumped> }`, a fresh
  // 30-day admin cookie current on every gate.
  it('switch-org after a revoke, still carrying the old admin claim, mints a session that is NOT platform admin', async () => {
    const actor = await makeUser('race-actor@example.com', { isPlatformAdmin: true })
    const revokedAdmin = await makeUser('race-revoked@example.com', { isPlatformAdmin: true })
    const [orgA, orgB] = [await makeOrg(), await makeOrg()]
    try {
      await addOrgMember(orgA, revokedAdmin, 'member')
      await addOrgMember(orgB, revokedAdmin, 'member')
      await withServer({ userId: actor, orgId: null, isPlatformAdmin: true, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/platform/users/${revokedAdmin}/platform-admin`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant: false }),
        })
        expect(res.status).toBe(200)
      })

      // The request passed the gate before the revoke: req.auth is the OLD claim.
      const { registerOrgRoutes } = await import('./orgs.js')
      const { verifySession } = await import('./tokens.js')
      const { isSessionEpochCurrent } = await import('./sessionEpoch.js')
      const { url, close } = await startServer(registerOrgRoutes, {
        userId: revokedAdmin, orgId: orgA, isPlatformAdmin: true, epoch: 1,
      })
      try {
        const res = await fetch(`${url}/api/auth/switch-org`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId: orgB }),
        })
        expect(res.status).toBe(200)
        const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('maplespire_session='))
        const minted = await verifySession(decodeURIComponent(cookie!.split(';')[0].slice('maplespire_session='.length)))
        expect(minted).toMatchObject({ userId: revokedAdmin, orgId: orgB, isPlatformAdmin: false, gepoch: 2 })
        await expect(isSessionEpochCurrent(realPool, minted!)).resolves.toBe(true)
      } finally {
        await close()
      }
    } finally {
      await dropOrg(orgA)
      await dropOrg(orgB)
      await dropUser(revokedAdmin)
      await dropUser(actor)
    }
  })

  it('the mint re-checks each fact with its epoch: refuses an inactive user, a non-member, a suspended org, a revoked impersonator', async () => {
    const admin = await makeUser('mint-admin@example.com', { isPlatformAdmin: true })
    const exAdmin = await makeUser('mint-ex-admin@example.com', { isPlatformAdmin: true })
    const member = await makeUser('mint-member@example.com')
    const inactive = await makeUser('mint-inactive@example.com')
    const [orgId, otherOrg, suspendedOrg] = [await makeOrg(), await makeOrg(), await makeOrg()]
    try {
      await addOrgMember(orgId, member, 'member')
      await addOrgMember(suspendedOrg, member, 'member')
      await realPool.query("UPDATE orgs SET status = 'suspended' WHERE id = $1", [suspendedOrg])
      await realPool.query("UPDATE users SET status = 'deactivated' WHERE id = $1", [inactive])
      await realPool.query('UPDATE users SET is_platform_admin = false WHERE id = $1', [exAdmin])
      const { signCurrentSession, SessionMintRefusedError } = await import('./sessionEpoch.js')
      const refusal = (p: Promise<unknown>) => p.then(() => 'minted', (e: unknown) => e instanceof SessionMintRefusedError ? e.reason : `threw ${String(e)}`)

      expect(await refusal(signCurrentSession(realPool, { userId: inactive, orgId: null, isPlatformAdmin: false }))).toBe('user_inactive')
      expect(await refusal(signCurrentSession(realPool, { userId: 'no-such-user', orgId: null, isPlatformAdmin: false }))).toBe('user_inactive')
      expect(await refusal(signCurrentSession(realPool, { userId: member, orgId: otherOrg, isPlatformAdmin: false }))).toBe('not_a_member')
      expect(await refusal(signCurrentSession(realPool, { userId: member, orgId: 'no-such-org', isPlatformAdmin: false }))).toBe('not_a_member')
      expect(await refusal(signCurrentSession(realPool, { userId: member, orgId: suspendedOrg, isPlatformAdmin: false }))).toBe('org_suspended')
      expect(await refusal(signCurrentSession(realPool, { userId: member, orgId, isPlatformAdmin: false, imp: { by: exAdmin } }))).toBe('impersonator_not_admin')
      expect(await refusal(signCurrentSession(realPool, { userId: member, orgId, isPlatformAdmin: false, imp: { by: admin } }))).toBe('minted')
      // Never elevated past the database, nor past the caller.
      const { verifySession } = await import('./tokens.js')
      const asAdmin = await verifySession(await signCurrentSession(realPool, { userId: member, orgId, isPlatformAdmin: true }))
      expect(asAdmin?.isPlatformAdmin).toBe(false)
      const callerSaysNo = await verifySession(await signCurrentSession(realPool, { userId: admin, orgId: null, isPlatformAdmin: false }))
      expect(callerSaysNo?.isPlatformAdmin).toBe(false)

      // QA lens round 2 (2026-10-17): each line below killed a surviving mutant.
      // A DEACTIVATED platform admin (the flag is still true) cannot impersonate,
      // nor can an impersonator whose row is gone.
      const deactivatedAdmin = await makeUser('mint-deactivated-admin@example.com', { isPlatformAdmin: true })
      try {
        await realPool.query("UPDATE users SET status = 'deactivated' WHERE id = $1", [deactivatedAdmin])
        expect(await refusal(signCurrentSession(realPool, { userId: member, orgId, isPlatformAdmin: false, imp: { by: deactivatedAdmin } }))).toBe('impersonator_not_admin')
      } finally {
        await dropUser(deactivatedAdmin)
      }
      expect(await refusal(signCurrentSession(realPool, { userId: member, orgId, isPlatformAdmin: false, imp: { by: 'no-such-admin' } }))).toBe('impersonator_not_admin')
      // Membership is THIS user's in THIS org: an org with other members is still refused.
      await addOrgMember(otherOrg, admin, 'admin')
      expect(await refusal(signCurrentSession(realPool, { userId: member, orgId: otherOrg, isPlatformAdmin: false }))).toBe('not_a_member')
    } finally {
      for (const id of [orgId, otherOrg, suspendedOrg]) await dropOrg(id)
      for (const id of [admin, exAdmin, member, inactive]) await dropUser(id)
    }
  })

  // QA lens round 2 (2026-10-17): every session minted in the suite so far
  // carried epoch = uepoch = gepoch = 1 for both users, so the mint could read
  // any epoch from the wrong row (or none) and nothing noticed.
  it('the mint signs each epoch from ITS row: the org, this user in this org, this user, and the impersonator', async () => {
    const admin = await makeUser('mint-epochs-admin@example.com', { isPlatformAdmin: true })
    const target = await makeUser('mint-epochs-target@example.com')
    const [orgId, elsewhere] = [await makeOrg(), await makeOrg()]
    try {
      await addOrgMember(orgId, target, 'member')
      await addOrgMember(elsewhere, target, 'member')
      // Raw rows (no trigger, no notify), every value distinct. The target's
      // epoch in ANOTHER org is written first, so a join that lost its org key
      // meets it before the right one.
      await realPool.query('INSERT INTO auth_user_epochs (org_id, user_id, epoch) VALUES ($1, $2, 9)', [elsewhere, target])
      await realPool.query('INSERT INTO auth_user_epochs (org_id, user_id, epoch) VALUES ($1, $2, 4)', [orgId, target])
      await realPool.query('INSERT INTO auth_epochs (org_id, epoch) VALUES ($1, 6)', [orgId])
      await realPool.query('INSERT INTO auth_global_epochs (user_id, epoch) VALUES ($1, 5), ($2, 3)', [target, admin])
      const { signCurrentSession, isSessionEpochCurrent } = await import('./sessionEpoch.js')
      const { verifySession } = await import('./tokens.js')

      const own = await verifySession(await signCurrentSession(realPool, { userId: target, orgId, isPlatformAdmin: false }))
      expect(own).toMatchObject({ epoch: 6, uepoch: 4, gepoch: 5 })
      await expect(isSessionEpochCurrent(realPool, own!)).resolves.toBe(true)

      const imp = await verifySession(await signCurrentSession(realPool, { userId: target, orgId, isPlatformAdmin: false, imp: { by: admin } }))
      expect(imp).toMatchObject({ epoch: 6, uepoch: 4, gepoch: 5, imp: { by: admin, gepoch: 3 } })
      await expect(isSessionEpochCurrent(realPool, imp!)).resolves.toBe(true)
    } finally {
      await dropOrg(orgId)
      await dropOrg(elsewhere)
      await dropUser(target)
      await dropUser(admin)
    }
  })

  it('switch-org by a user deactivated since their cookie was signed is a 403 user_inactive, with no session', async () => {
    const user = await makeUser('switch-deactivated@example.com')
    const [orgA, orgB] = [await makeOrg(), await makeOrg()]
    try {
      await addOrgMember(orgA, user, 'member')
      await addOrgMember(orgB, user, 'member')
      await realPool.query("UPDATE users SET status = 'deactivated' WHERE id = $1", [user])
      const { registerOrgRoutes } = await import('./orgs.js')
      // The request passed the gate before the deactivation: req.auth is the old claim.
      const { url, close } = await startServer(registerOrgRoutes, { userId: user, orgId: orgA, isPlatformAdmin: false, epoch: 1 })
      try {
        const res = await fetch(`${url}/api/auth/switch-org`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId: orgB }),
        })
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'user_inactive' })
        expect((res.headers.getSetCookie?.() ?? []).filter((c) => c.startsWith('maplespire_session='))).toEqual([])
      } finally {
        await close()
      }
    } finally {
      await dropOrg(orgA)
      await dropOrg(orgB)
      await dropUser(user)
    }
  })

  // Regression (architect lens, 2026-10-16): cookie HTTP checked only the
  // global epoch, but workspaceGate.ts requireLandscapeInOrg admits on the
  // signed `orgId` with no membership read — a removed member's cookie kept
  // reading the org's landscape snapshots.
  it("a member removed from the org is refused on cookie HTTP, and a colleague is not", async () => {
    const [removed, colleague] = [await makeUser('removed-member@example.com'), await makeUser('stays-member@example.com')]
    const orgId = await makeOrg()
    try {
      await addOrgMember(orgId, removed, 'member')
      await addOrgMember(orgId, colleague, 'member')
      const { signCurrentSession } = await import('./sessionEpoch.js')
      const removedSession = await signCurrentSession(realPool, { userId: removed, orgId, isPlatformAdmin: false })
      const colleagueSession = await signCurrentSession(realPool, { userId: colleague, orgId, isPlatformAdmin: false })
      await withCookieGates(async (check) => {
        expect(await check(removedSession)).toEqual(accepted)
        await realPool.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, removed])
        expect(await check(removedSession)).toEqual(revoked)
        expect(await check(colleagueSession)).toEqual(accepted)
      })
    } finally {
      await dropOrg(orgId)
      await dropUser(removed)
      await dropUser(colleague)
    }
  })

  it('impersonate mints an imp cookie and exit restores the admin session', async () => {
    const adminId = await makeUser('impersonating-admin@example.com', { isPlatformAdmin: true })
    const targetId = await makeUser('impersonation-target@example.com')
    try {
      const { url, close } = await startServer(registerPlatformRoutes, {
        userId: adminId,
        orgId: null,
        isPlatformAdmin: true,
        epoch: 1,
      })
      try {
        const impRes = await fetch(`${url}/api/platform/impersonate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: targetId }),
        })
        expect(impRes.status).toBe(200)
        const setCookies = impRes.headers.getSetCookie?.() ?? []
        expect(setCookies.some((c) => c.startsWith('maplespire_session='))).toBe(true)
        expect(setCookies.some((c) => c.startsWith('maplespire_admin_session='))).toBe(true)

        const { rows: activeRows } = await realPool.query(
          `SELECT admin_user_id, target_user_id, ended_at FROM impersonations WHERE admin_user_id = $1 AND target_user_id = $2 ORDER BY started_at DESC LIMIT 1`,
          [adminId, targetId]
        )
        expect(activeRows[0].ended_at).toBeNull()
      } finally {
        await close()
      }

      // Exit flow: a fresh server instance simulating the impersonated
      // session, with req.auth.imp set + the stashed cookie forwarded — the
      // route itself verifies the stashed token via `verifySession`, so we
      // mint a real one here rather than faking `req.auth` on the exit call.
      const { signSession } = await import('./tokens.js')
      process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-secret-for-platform-routes-integration'
      const adminStashToken = await signSession({ userId: adminId, orgId: null, isPlatformAdmin: true, epoch: 1 })

      const exitAuth = { userId: targetId, orgId: null, isPlatformAdmin: false, epoch: 1, imp: { by: adminId } }
      const { url: exitUrl, close: exitClose } = await startServer(registerPlatformRoutes, exitAuth)
      try {
        const exitRes = await fetch(`${exitUrl}/api/auth/impersonate/exit`, {
          method: 'POST',
          headers: { Cookie: `maplespire_admin_session=${encodeURIComponent(adminStashToken)}` },
        })
        expect(exitRes.status).toBe(200)
        expect(await exitRes.json()).toEqual({ success: true })

        const { rows: endedRows } = await realPool.query(
          `SELECT ended_at FROM impersonations WHERE admin_user_id = $1 AND target_user_id = $2 ORDER BY started_at DESC LIMIT 1`,
          [adminId, targetId]
        )
        expect(endedRows[0].ended_at).not.toBeNull()
      } finally {
        await exitClose()
      }
    } finally {
      await dropUser(targetId)
      await dropUser(adminId)
    }
  })

  it('suspended org login is refused (devLogin) for an EXISTING member of that org', async () => {
    // Multi-org semantics: a brand-new email gets its own personal org, not
    // the default org, so suspension is
    // asserted on a user whose ONLY membership is the suspended org —
    // resolveLoginOrg finds all memberships suspended and refuses the login.
    process.env.AUTH_DEV_LOGIN = 'on'
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-secret-for-platform-routes-integration'
    vi.resetModules()
    vi.doMock('../db.js', () => ({ pool: realPool }))
    const { registerAuthRoutes } = await import('./devLogin.js')
    const { ensureDefaultOrg } = await import('./schema.js')

    // Safe ONLY because of the isolated schema: this "default org" is a
    // fixture ensureDefaultOrg creates inside the suite's throwaway schema.
    // (Against a shared database this suspend would invalidate every live
    // session via the epoch triggers — never point a raw pool at
    // TEST_DATABASE_URL's public schema for this.)
    const orgId = await ensureDefaultOrg(realPool)
    const email = `suspended-login-${randomBytes(4).toString('hex')}@example.com`
    const userId = `susp-${randomBytes(6).toString('hex')}`
    await realPool.query(
      `INSERT INTO users (id, issuer, subject, email) VALUES ($1, 'dev', $2, $3)`,
      [userId, email.toLowerCase(), email]
    )
    await realPool.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`,
      [orgId, userId]
    )
    await realPool.query(`UPDATE orgs SET status = 'suspended' WHERE id = $1`, [orgId])
    try {
      const app = express()
      app.use(express.json())
      registerAuthRoutes(app)
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s))
      })
      const port = (server.address() as AddressInfo).port
      const url = `http://127.0.0.1:${port}`
      try {
        const res = await fetch(`${url}/api/auth/dev-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        })
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'org_suspended' })
      } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)))
      }
    } finally {
      await realPool.query(`UPDATE orgs SET status = 'active' WHERE id = $1`, [orgId])
      await dropUser(userId)
      delete process.env.AUTH_DEV_LOGIN
    }
  })
})
