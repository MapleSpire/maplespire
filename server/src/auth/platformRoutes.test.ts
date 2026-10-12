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

  it('deactivating a user bumps the epoch of every org they belong to', async () => {
    const platformAdminId = await makeUser('deactivate-platform-admin@example.com', { isPlatformAdmin: true })
    const targetUserId = await makeUser('multi-org-member@example.com')
    const orgA = await makeOrg()
    const orgB = await makeOrg()
    try {
      await addOrgMember(orgA, targetUserId, 'member')
      await addOrgMember(orgB, targetUserId, 'member')

      const epochBeforeA = 1 // auth_epochs has no row yet — implicit epoch 1 (see auth/schema.ts)
      const epochBeforeB = 1

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

      const { rows: epochRowsA } = await realPool.query<{ epoch: string }>('SELECT epoch FROM auth_epochs WHERE org_id = $1', [orgA])
      const { rows: epochRowsB } = await realPool.query<{ epoch: string }>('SELECT epoch FROM auth_epochs WHERE org_id = $1', [orgB])
      expect(Number(epochRowsA[0].epoch)).toBeGreaterThan(epochBeforeA)
      expect(Number(epochRowsB[0].epoch)).toBeGreaterThan(epochBeforeB)
    } finally {
      await dropOrg(orgA)
      await dropOrg(orgB)
      await dropUser(targetUserId)
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
