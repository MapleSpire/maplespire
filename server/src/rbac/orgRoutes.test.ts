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
 * Tests for orgRoutes.ts (Org Admin console REST endpoints).
 *
 * Two tiers, same shape as `oidcInvites.test.ts` / `rbac.test.ts`:
 *  - Stub-pool tests (`../db.js`'s `pool` mocked to `{ query: vi.fn() }`) for
 *    the 401/403 authorization surfaces + input validation — DB-free, always run.
 *  - `describe.skipIf(!process.env.TEST_DATABASE_URL)` integration tests
 *    against a real Postgres for the properties that only a real transaction
 *    can prove: last-admin protection, grant batch CAS + rollback atomicity,
 *    archived teams disappearing from the matrix, and the access/preview
 *    happy path. Throwaway-org pattern from rbac.test.ts: random ids, cascade
 *    cleanup in `finally`.
 */

// ---------------------------------------------------------------------------
// Stub-pool tests (DB-free)
// ---------------------------------------------------------------------------

const queryMock = vi.fn()
const appendAuditMock = vi.fn().mockResolvedValue(undefined)
const explainAccessMock = vi.fn()
const getOrgReadModelHealthMock = vi.fn()

vi.mock('../db.js', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args), connect: () => connectMock() },
}))
vi.mock('../auth/audit.js', () => ({
  appendAudit: (...args: unknown[]) => appendAuditMock(...args),
}))
vi.mock('./access.js', () => ({
  explainAccess: (...args: unknown[]) => explainAccessMock(...args),
}))
vi.mock('../readModel/health.js', () => ({
  getOrgReadModelHealth: (...args: unknown[]) => getOrgReadModelHealthMock(...args),
}))

// A stub transaction client, used by the mutation routes that call
// `pool.connect()` (member role/remove, access batch apply).
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

/** Boot a throwaway Express server, register `register`, optionally inject
 * `req.auth` on every request, and return `{url, close}`. Mirrors
 * `oidcInvites.test.ts`'s helper exactly. */
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

const memberAuth = { userId: 'u1', orgId: 'org1', isPlatformAdmin: false, epoch: 1 }
const platformAdminAuth = { userId: 'platform-1', orgId: null, isPlatformAdmin: true, epoch: 1 }

beforeEach(() => {
  queryMock.mockReset()
  appendAuditMock.mockClear()
  explainAccessMock.mockReset()
  getOrgReadModelHealthMock.mockReset()
  stubClient = makeStubClient()
})

afterEach(() => {
  vi.resetModules()
})

describe('org admin routes: authorization surfaces', () => {
  const endpoints: Array<{ method: 'get' | 'post' | 'patch' | 'put' | 'delete'; path: string; body?: unknown }> = [
    { method: 'get', path: '/api/orgs/org1/overview' },
    { method: 'get', path: '/api/orgs/org1/read-model-health' },
    { method: 'get', path: '/api/orgs/org1/members' },
    { method: 'patch', path: '/api/orgs/org1/members/u2', body: { role: 'member' } },
    { method: 'delete', path: '/api/orgs/org1/members/u2' },
    { method: 'get', path: '/api/orgs/org1/invites' },
    { method: 'delete', path: '/api/orgs/org1/invites/inv1' },
    { method: 'get', path: '/api/orgs/org1/teams' },
    { method: 'get', path: '/api/orgs/org1/teams/t1' },
    { method: 'post', path: '/api/orgs/org1/teams', body: { name: 'Team A' } },
    { method: 'patch', path: '/api/orgs/org1/teams/t1', body: { name: 'New name' } },
    { method: 'put', path: '/api/orgs/org1/teams/t1/members/u2' },
    { method: 'delete', path: '/api/orgs/org1/teams/t1/members/u2' },
    { method: 'get', path: '/api/orgs/org1/access' },
    { method: 'put', path: '/api/orgs/org1/access', body: { changes: [] } },
    { method: 'get', path: '/api/orgs/org1/access/preview?userId=u2&scopeId=s1' },
  ]

  for (const ep of endpoints) {
    it(`${ep.method.toUpperCase()} ${ep.path} -> 401 with no session`, async () => {
      vi.resetModules()
      const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
      const { url, close } = await startServer(registerOrgAdminRoutes)
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

    it(`${ep.method.toUpperCase()} ${ep.path} -> 403 for a non-admin org member`, async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ role: 'member' }] }) // canManageOrg lookup
      vi.resetModules()
      const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
      const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
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

    it(`${ep.method.toUpperCase()} ${ep.path} -> 403 when caller has no membership row at all`, async () => {
      queryMock.mockResolvedValueOnce({ rows: [] }) // canManageOrg lookup: no row
      vi.resetModules()
      const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
      const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
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

  it('a platform admin skips the org_members DB lookup entirely for overview', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'org1', name: 'Org One', slug: 'org-one', status: 'active', settings: {} }] }) // org lookup
      .mockResolvedValueOnce({ rows: [{ n: '3' }] }) // memberCount
      .mockResolvedValueOnce({ rows: [{ n: '1' }] }) // teamCount
      .mockResolvedValueOnce({ rows: [{ n: '0' }] }) // pendingInviteCount
      .mockResolvedValueOnce({ rows: [{ n: '2' }] }) // landscapeCount
      .mockResolvedValueOnce({ rows: [] }) // recentAudit

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/overview`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        org: { id: 'org1', name: 'Org One', slug: 'org-one', status: 'active', settings: {} },
        memberCount: 3,
        teamCount: 1,
        pendingInviteCount: 0,
        landscapeCount: 2,
        recentAudit: [],
      })
      // canManageOrg's membership-lookup query must never run for a platform
      // admin (it's a role bypass, not just "happens to return admin") — the
      // overview's OWN `count(*) FROM org_members` (memberCount) is fine and
      // expected, so assert on the more specific canManageOrg shape.
      expect(queryMock).not.toHaveBeenCalledWith(
        expect.stringContaining('SELECT role FROM org_members'),
        expect.anything()
      )
    } finally {
      await close()
    }
  })

  it('overview 404s when the org does not exist', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // org lookup: not found
    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/overview`)
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })

  it('returns privacy-minimized read-model health to an org admin', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
    queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    getOrgReadModelHealthMock.mockResolvedValueOnce({
      enabled: true,
      generatedAt: '2026-07-18T12:00:00.000Z',
      counts: { healthy: 1, catching_up: 0, failed: 0, idle: 0, uninitialized: 0 },
      worstLagMs: 0,
      totalWorkspaceCount: 1,
      listedWorkspaceCount: 0,
      workspaces: [],
    })
    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/read-model-health`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.counts.healthy).toBe(1)
      expect(getOrgReadModelHealthMock).toHaveBeenCalledWith(expect.anything(), 'org1')
      expect(JSON.stringify(body)).not.toContain('object')
    } finally {
      await close()
    }
  })

  it('returns 404 for read-model health of a missing org to a platform admin', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, platformAdminAuth)
    try {
      const res = await fetch(`${url}/api/orgs/missing/read-model-health`)
      expect(res.status).toBe(404)
      expect(getOrgReadModelHealthMock).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })
})

describe('GET /api/orgs/:orgId/members', () => {
  it('returns members with teams attached, keyed by user id', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
      .mockResolvedValueOnce({
        rows: [
          { user_id: 'u1', email: 'a@example.com', name: 'Alice', role: 'admin', status: 'active' },
          { user_id: 'u2', email: 'b@example.com', name: 'Bob', role: 'member', status: 'active' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ user_id: 'u1', id: 't1', name: 'Payments' }],
      })

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/members`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.members).toEqual([
        { userId: 'u1', email: 'a@example.com', name: 'Alice', role: 'admin', status: 'active', teams: [{ id: 't1', name: 'Payments' }] },
        { userId: 'u2', email: 'b@example.com', name: 'Bob', role: 'member', status: 'active', teams: [] },
      ])
      expect(body.nextCursor).toBeNull()
    } finally {
      await close()
    }
  })

  it('filters team candidates in SQL instead of copying the org roster into React', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [] })

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/members?excludeTeamId=t1&limit=20`)
      expect(res.status).toBe(200)
      const memberQuery = queryMock.mock.calls.at(-1)
      expect(String(memberQuery?.[0])).toContain('NOT EXISTS')
      expect(String(memberQuery?.[0])).toContain('excluded_member.team_id')
      expect(memberQuery?.[1]).toEqual(['org1', 't1', 21])
    } finally {
      await close()
    }
  })
})

describe('PATCH /api/orgs/:orgId/members/:userId', () => {
  it('rejects an invalid role with 400 before opening a transaction', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/members/u2`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'owner' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('404s when the target member does not exist', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
    stubClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // lock_permission_writes()
      .mockResolvedValueOnce({ rows: [{ user_id: 'u1' }] }) // admin rows FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // target lookup: not found
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/members/ghost`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'member' }),
      })
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })

  // Both member writes take the permission-write lock inside the transaction
  // and before their FOR UPDATE on the admin rows (reviewer lens, 2026-10-17).
  for (const [method, body] of [['PATCH', JSON.stringify({ role: 'member' })], ['DELETE', undefined]] as const) {
    it(`${method} takes the permission-write lock after BEGIN and before locking the admin rows`, async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
      vi.resetModules()
      const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
      const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
      try {
        await fetch(`${url}/api/orgs/org1/members/ghost`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body,
        })
        const sql = stubClient.query.mock.calls.map(([text]) => String(text))
        const begin = sql.indexOf('BEGIN')
        const lockAt = sql.findIndex((s) => s.includes('lock_permission_writes'))
        const adminRows = sql.findIndex((s) => s.includes("role = 'admin' FOR UPDATE"))
        expect(begin).toBeGreaterThan(-1)
        expect(lockAt).toBeGreaterThan(begin)
        expect(adminRows).toBeGreaterThan(lockAt)
      } finally {
        await close()
      }
    })
  }
})

describe('PUT /api/orgs/:orgId/access', () => {
  it('rejects an empty changes array with 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [] }),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('rejects a malformed change (missing fields) with 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [{ teamId: 't1' }] }),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it("takes the permission-write lock before locking any grant row (no row-order inversion between two batches)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
    stubClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 't1' }, { id: 't2' }] }) // owned teams
      .mockResolvedValueOnce({ rows: [{ id: 's1' }] }) // owned scopes
    // everything after: the stub's default empty result

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const change = (teamId: string) => ({ teamId, scopeId: 's1', resourceType: '*', canRead: true, canWrite: false, expectedUpdatedAt: null })
      const res = await fetch(`${url}/api/orgs/org1/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [change('t2'), change('t1')] }),
      })
      expect(res.status).toBe(200)
      const sql = stubClient.query.mock.calls.map(([text]) => String(text))
      const lockAt = sql.findIndex((s) => s.includes('lock_permission_writes'))
      const firstRowLock = sql.findIndex((s) => s.includes('FOR UPDATE'))
      expect(lockAt).toBeGreaterThan(-1)
      expect(lockAt).toBeLessThan(firstRowLock)
      // Inside the transaction: a transaction-scoped lock taken before BEGIN
      // runs in autocommit and is released at once (QA lens, 2026-10-16).
      expect(lockAt).toBeGreaterThan(sql.indexOf('BEGIN'))
    } finally {
      await close()
    }
  })

  describe('deadlock-victim backstop', () => {
    const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' })
    const body = JSON.stringify({
      changes: [{ teamId: 't1', scopeId: 's1', resourceType: '*', canRead: true, canWrite: false, expectedUpdatedAt: null }],
    })
    /** Route the stub client's SQL: ownership checks succeed; `forUpdate`
     * decides what the batch's first row lock does on each attempt. */
    function scriptClient(forUpdate: (attempt: number) => Promise<unknown>) {
      let attempt = 0
      stubClient.query.mockImplementation(async (text: unknown) => {
        const sql = String(text)
        if (sql === 'BEGIN') attempt++
        if (sql.includes('FROM teams')) return { rows: [{ id: 't1' }] }
        if (sql.includes('FROM scopes WHERE org_id')) return { rows: [{ id: 's1' }] }
        if (sql.includes('FOR UPDATE')) return forUpdate(attempt)
        return { rows: [] }
      })
      return () => stubClient.query.mock.calls.filter(([s]) => s === 'BEGIN').length
    }
    async function put() {
      queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
      vi.resetModules()
      const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
      const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
      try {
        return await fetch(`${url}/api/orgs/org1/access`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
      } finally {
        await close()
      }
    }

    it('re-runs a batch Postgres picked as a deadlock victim, and it applies', async () => {
      const begins = scriptClient(async (attempt) => {
        if (attempt === 1) throw deadlock()
        return { rows: [] }
      })
      const res = await put()
      expect(res.status).toBe(200)
      expect(begins()).toBe(2)
      expect(appendAuditMock).toHaveBeenCalledTimes(1)
    })

    it('gives up after 3 attempts with a 500', async () => {
      const begins = scriptClient(async () => { throw deadlock() })
      const res = await put()
      expect(res.status).toBe(500)
      expect(begins()).toBe(3)
      expect(appendAuditMock).not.toHaveBeenCalled()
    })

    it('never re-runs a batch that already committed, nor any other error', async () => {
      let begins = scriptClient(async () => ({ rows: [] }))
      appendAuditMock.mockRejectedValueOnce(deadlock()) // after COMMIT
      expect((await put()).status).toBe(500)
      expect(begins()).toBe(1)

      stubClient.query.mockReset()
      begins = scriptClient(async () => { throw Object.assign(new Error('boom'), { code: '23505' }) })
      expect((await put()).status).toBe(500)
      expect(begins()).toBe(1)
    })
  })

  it('400s when a referenced team does not belong to the org', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
    stubClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // owned teams: none found (foreign team id)
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [{ teamId: 'foreign-team', scopeId: 's1', resourceType: '*', canRead: true, canWrite: false, expectedUpdatedAt: null }],
        }),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })
})

describe('GET /api/orgs/:orgId/access/preview', () => {
  it('400s when userId or scopeId is missing', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/access/preview?userId=u2`)
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('404s when the target user is not an org member', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
      .mockResolvedValueOnce({ rows: [] }) // membership check: not a member

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/access/preview?userId=u2&scopeId=s1`)
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })

  it('happy path calls explainAccess and returns its result', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // membership check: is a member
      .mockResolvedValueOnce({ rows: [{ id: 's1' }] }) // scope lookup

    explainAccessMock.mockResolvedValueOnce({
      allowed: true,
      canRead: true,
      canWrite: false,
      via: 'team-grant',
      grantScopeId: 's1',
      rawRows: [],
    })

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/access/preview?userId=u2&scopeId=s1`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.allowed).toBe(true)
      expect(body.via).toBe('team-grant')
    } finally {
      await close()
    }
  })
})

describe('POST /api/orgs/:orgId/teams', () => {
  it('rejects an empty name with 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('creates a team and audits team.created', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
      .mockResolvedValueOnce({ rows: [{ id: 'org1' }] }) // org lookup
      .mockResolvedValueOnce({ rows: [] }) // insert

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Payments' }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.name).toBe('Payments')
      expect(body.id).toBeTruthy()
      expect(appendAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'team.created', orgId: 'org1' })
      )
    } finally {
      await close()
    }
  })
})

describe('GET /api/orgs/:orgId/teams/:teamId', () => {
  it('returns the team + its members', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
      .mockResolvedValueOnce({ rows: [{ id: 't1', name: 'Payments', archived_at: null }] }) // team lookup
      .mockResolvedValueOnce({
        rows: [{ user_id: 'u1', email: 'a@example.com', name: 'Alice' }],
      }) // members

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/teams/t1`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        team: { id: 't1', name: 'Payments', archivedAt: null },
        members: [{ userId: 'u1', email: 'a@example.com', name: 'Alice' }],
        nextCursor: null,
      })
    } finally {
      await close()
    }
  })

  it('keyset-paginates a dense team instead of returning the whole roster', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{ id: 't1', name: 'Payments', archived_at: null }] })
      .mockResolvedValueOnce({
        rows: [
          { user_id: 'u1', email: 'a@example.com', name: 'Alice' },
          { user_id: 'u2', email: 'b@example.com', name: 'Bob' },
        ],
      })

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/teams/t1?limit=1`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        team: { id: 't1', name: 'Payments', archivedAt: null },
        members: [{ userId: 'u1', email: 'a@example.com', name: 'Alice' }],
        nextCursor: 'u1',
      })
      const memberQuery = queryMock.mock.calls.at(-1)
      expect(String(memberQuery?.[0])).toContain('ORDER BY tm.user_id')
      expect(memberQuery?.[1]).toEqual(['t1', null, 2])
    } finally {
      await close()
    }
  })

  it('404s when the team does not exist in this org', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
      .mockResolvedValueOnce({ rows: [] }) // team lookup: not found

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/teams/ghost`)
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })
})

describe('PUT /api/orgs/:orgId/teams/:teamId/members/:userId', () => {
  it('400s when the target user is not an org member', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
      .mockResolvedValueOnce({ rows: [{ id: 't1' }] }) // team lookup
      .mockResolvedValueOnce({ rows: [] }) // membership check: not a member

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/teams/t1/members/u2`, { method: 'PUT' })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('not-an-org-member')
    } finally {
      await close()
    }
  })

  it('404s when the team does not exist in this org', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
      .mockResolvedValueOnce({ rows: [] }) // team lookup: not found

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/teams/ghost/members/u2`, { method: 'PUT' })
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })
})

describe('DELETE /api/orgs/:orgId/invites/:inviteId', () => {
  it('409s when the invite is already accepted', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
      .mockResolvedValueOnce({ rows: [{ accepted_at: new Date().toISOString() }] }) // invite lookup

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/invites/inv1`, { method: 'DELETE' })
      expect(res.status).toBe(409)
    } finally {
      await close()
    }
  })

  it('404s for an unknown invite', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) // canManageOrg
      .mockResolvedValueOnce({ rows: [] }) // invite lookup: not found

    vi.resetModules()
    const { registerOrgAdminRoutes } = await import('./orgRoutes.js')
    const { url, close } = await startServer(registerOrgAdminRoutes, memberAuth)
    try {
      const res = await fetch(`${url}/api/orgs/org1/invites/ghost`, { method: 'DELETE' })
      expect(res.status).toBe(404)
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

describe.skipIf(!TEST_DATABASE_URL)('org admin routes (live Postgres)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb
  let realPool: pg.Pool
  let registerOrgAdminRoutes: (app: express.Express) => void
  let realExplainAccess: typeof import('./access.js').explainAccess

  beforeAll(async () => {
    vi.doUnmock('../db.js')
    vi.doUnmock('../auth/audit.js')
    vi.doUnmock('./access.js')
    vi.resetModules()

    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'org_routes')
    realPool = db.pool
    const { ensureAuthSchema } = await import('../auth/schema.js')
    const { ensureRbacSchema } = await import('./schema.js')
    await ensureAuthSchema(realPool)
    await ensureRbacSchema(realPool)

    // Point the module's internal `pool` (imported from ../db.js) at our
    // test pool by mocking ../db.js to re-export it — this file's dedicated
    // pool avoids colliding with whatever DATABASE_URL the rest of the
    // process might have configured.
    vi.doMock('../db.js', () => ({ pool: realPool }))
    vi.resetModules()
    ;({ registerOrgAdminRoutes } = await import('./orgRoutes.js'))
    ;({ explainAccess: realExplainAccess } = await import('./access.js'))
  })

  afterAll(async () => {
    await db?.teardown()
    vi.doUnmock('../db.js')
    vi.resetModules()
  })

  async function makeOrg(): Promise<string> {
    const id = rid('org')
    await realPool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [id, `Org ${id}`, id])
    return id
  }

  async function makeUser(email: string): Promise<string> {
    const id = rid('user')
    await realPool.query(`INSERT INTO users (id, issuer, subject, email, name) VALUES ($1, 'test', $2, $3, $3)`, [
      id,
      id,
      email,
    ])
    return id
  }

  async function addOrgMember(orgId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
    await realPool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)`, [orgId, userId, role])
  }

  async function dropOrg(orgId: string): Promise<void> {
    await realPool.query(`DELETE FROM orgs WHERE id = $1`, [orgId])
  }

  async function withServer<T>(
    auth: { userId: string; orgId: string | null; isPlatformAdmin: boolean; epoch: number },
    fn: (url: string) => Promise<T>
  ): Promise<T> {
    const { url, close } = await startServer(registerOrgAdminRoutes, auth)
    try {
      return await fn(url)
    } finally {
      await close()
    }
  }

  it('last-admin protection: demoting the only active admin returns 409', async () => {
    const orgId = await makeOrg()
    try {
      const adminId = await makeUser('sole-admin@example.com')
      await addOrgMember(orgId, adminId, 'admin')

      await withServer({ userId: adminId, orgId, isPlatformAdmin: false, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/orgs/${orgId}/members/${adminId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'member' }),
        })
        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ error: 'last-admin' })
      })

      const { rows } = await realPool.query('SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [
        orgId,
        adminId,
      ])
      expect(rows[0].role).toBe('admin')
    } finally {
      await dropOrg(orgId)
    }
  })

  it('last-admin protection: removing the only active admin returns 409', async () => {
    const orgId = await makeOrg()
    try {
      const adminId = await makeUser('sole-admin2@example.com')
      await addOrgMember(orgId, adminId, 'admin')

      await withServer({ userId: adminId, orgId, isPlatformAdmin: false, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/orgs/${orgId}/members/${adminId}`, { method: 'DELETE' })
        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ error: 'last-admin' })
      })

      const { rows } = await realPool.query('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [
        orgId,
        adminId,
      ])
      expect(rows.length).toBe(1)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('demoting one of TWO admins succeeds (not the last one)', async () => {
    const orgId = await makeOrg()
    try {
      const admin1 = await makeUser('admin1@example.com')
      const admin2 = await makeUser('admin2@example.com')
      await addOrgMember(orgId, admin1, 'admin')
      await addOrgMember(orgId, admin2, 'admin')

      await withServer({ userId: admin1, orgId, isPlatformAdmin: false, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/orgs/${orgId}/members/${admin2}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'member' }),
        })
        expect(res.status).toBe(200)
      })

      const { rows } = await realPool.query('SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [
        orgId,
        admin2,
      ])
      expect(rows[0].role).toBe('member')
    } finally {
      await dropOrg(orgId)
    }
  })

  it('grant batch CAS: apply then stale re-apply returns 409 and rolls back atomically', async () => {
    const orgId = await makeOrg()
    try {
      const adminId = await makeUser('access-admin@example.com')
      await addOrgMember(orgId, adminId, 'admin')

      const { upsertLandscapeScope } = await import('./schema.js')
      const landscapeId = rid('landscape')
      const scopeId = await upsertLandscapeScope(realPool, orgId, landscapeId)

      const teamId = rid('team')
      await realPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3)`, [teamId, orgId, 'Team A'])

      await withServer({ userId: adminId, orgId, isPlatformAdmin: false, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/orgs/${orgId}/access`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            changes: [{ teamId, scopeId, resourceType: '*', canRead: true, canWrite: false, expectedUpdatedAt: null }],
          }),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.applied).toBe(1)
      })

      const { rows: afterFirst } = await realPool.query<{ updated_at: string }>(
        `SELECT updated_at FROM team_scope_permissions WHERE team_id = $1 AND scope_id = $2 AND resource_type = '*'`,
        [teamId, scopeId]
      )
      const firstUpdatedAt = new Date(afterFirst[0].updated_at).toISOString()

      // Second, valid apply with the correct expectedUpdatedAt succeeds and
      // changes can_write.
      await withServer({ userId: adminId, orgId, isPlatformAdmin: false, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/orgs/${orgId}/access`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            changes: [
              { teamId, scopeId, resourceType: '*', canRead: true, canWrite: true, expectedUpdatedAt: firstUpdatedAt },
            ],
          }),
        })
        expect(res.status).toBe(200)
      })
      const { rows: afterSecond } = await realPool.query<{ can_write: boolean; updated_at: string }>(
        `SELECT can_write, updated_at FROM team_scope_permissions WHERE team_id = $1 AND scope_id = $2 AND resource_type = '*'`,
        [teamId, scopeId]
      )
      expect(afterSecond[0].can_write).toBe(true)
      const secondUpdatedAt = new Date(afterSecond[0].updated_at).toISOString()
      expect(secondUpdatedAt).not.toBe(firstUpdatedAt)

      // A stale re-apply using the FIRST (now outdated) expectedUpdatedAt
      // must 409 and change nothing (rollback atomicity) — batched with a
      // second, otherwise-valid change on a fresh scope, to prove the WHOLE
      // transaction rolls back, not just the conflicting row.
      const landscapeId2 = rid('landscape')
      const scopeId2 = await upsertLandscapeScope(realPool, orgId, landscapeId2)

      await withServer({ userId: adminId, orgId, isPlatformAdmin: false, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/orgs/${orgId}/access`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            changes: [
              { teamId, scopeId, resourceType: '*', canRead: true, canWrite: false, expectedUpdatedAt: firstUpdatedAt },
              { teamId, scopeId: scopeId2, resourceType: '*', canRead: true, canWrite: true, expectedUpdatedAt: null },
            ],
          }),
        })
        expect(res.status).toBe(409)
        const body = await res.json()
        expect(body.error).toBe('stale')
      })

      // Neither row changed: the first grant still has its post-second-apply
      // state, and the second scope has NO grant row at all (rolled back).
      const { rows: unchanged } = await realPool.query<{ can_write: boolean; updated_at: string }>(
        `SELECT can_write, updated_at FROM team_scope_permissions WHERE team_id = $1 AND scope_id = $2 AND resource_type = '*'`,
        [teamId, scopeId]
      )
      expect(unchanged[0].can_write).toBe(true)
      expect(new Date(unchanged[0].updated_at).toISOString()).toBe(secondUpdatedAt)

      const { rows: neverCreated } = await realPool.query(
        `SELECT 1 FROM team_scope_permissions WHERE team_id = $1 AND scope_id = $2`,
        [teamId, scopeId2]
      )
      expect(neverCreated.length).toBe(0)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('archiving a team removes it from the access matrix teams list', async () => {
    const orgId = await makeOrg()
    try {
      const adminId = await makeUser('archive-admin@example.com')
      await addOrgMember(orgId, adminId, 'admin')

      const teamId = rid('team')
      await realPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3)`, [teamId, orgId, 'Doomed Team'])

      await withServer({ userId: adminId, orgId, isPlatformAdmin: false, epoch: 1 }, async (url) => {
        const before = await fetch(`${url}/api/orgs/${orgId}/access`)
        const beforeBody = await before.json()
        expect(beforeBody.teams.some((t: { id: string }) => t.id === teamId)).toBe(true)

        const archiveRes = await fetch(`${url}/api/orgs/${orgId}/teams/${teamId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: true }),
        })
        expect(archiveRes.status).toBe(200)

        const after = await fetch(`${url}/api/orgs/${orgId}/access`)
        const afterBody = await after.json()
        expect(afterBody.teams.some((t: { id: string }) => t.id === teamId)).toBe(false)
      })
    } finally {
      await dropOrg(orgId)
    }
  })

  it('access/preview happy path matches explainAccess directly', async () => {
    const orgId = await makeOrg()
    try {
      const adminId = await makeUser('preview-admin@example.com')
      await addOrgMember(orgId, adminId, 'admin')
      const memberId = await makeUser('preview-member@example.com')
      await addOrgMember(orgId, memberId, 'member')

      const { upsertLandscapeScope } = await import('./schema.js')
      const landscapeId = rid('landscape')
      const scopeId = await upsertLandscapeScope(realPool, orgId, landscapeId)

      const teamId = rid('team')
      await realPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3)`, [teamId, orgId, 'Team B'])
      await realPool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [teamId, memberId])
      await realPool.query(
        `INSERT INTO team_scope_permissions (team_id, scope_id, resource_type, can_read, can_write) VALUES ($1, $2, '*', true, false)`,
        [teamId, scopeId]
      )

      const direct = await realExplainAccess(realPool, memberId, scopeId, '*')

      await withServer({ userId: adminId, orgId, isPlatformAdmin: false, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/orgs/${orgId}/access/preview?userId=${memberId}&scopeId=${scopeId}`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual(direct)
        expect(body.allowed).toBe(true)
        expect(body.canRead).toBe(true)
        expect(body.canWrite).toBe(false)
      })
    } finally {
      await dropOrg(orgId)
    }
  })

  it('access/preview 404s for a userId outside the org', async () => {
    const orgId = await makeOrg()
    try {
      const adminId = await makeUser('preview-admin2@example.com')
      await addOrgMember(orgId, adminId, 'admin')
      const outsiderId = await makeUser('outsider@example.com') // never added to this org

      const { upsertLandscapeScope } = await import('./schema.js')
      const scopeId = await upsertLandscapeScope(realPool, orgId, rid('landscape'))

      await withServer({ userId: adminId, orgId, isPlatformAdmin: false, epoch: 1 }, async (url) => {
        const res = await fetch(`${url}/api/orgs/${orgId}/access/preview?userId=${outsiderId}&scopeId=${scopeId}`)
        expect(res.status).toBe(404)
      })
    } finally {
      await dropOrg(orgId)
    }
  })
})
