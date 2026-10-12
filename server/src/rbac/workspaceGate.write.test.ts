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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { randomBytes } from 'node:crypto'
import type { Request, Response } from 'express'
import {
  requireLandscapeWrite,
  requireVersionWrite,
  requireOrgAdmin,
  workspaceAccessForRequest,
} from './workspaceGate.js'
import { _clearAllowedWorkspaceKeysCacheForTests } from './docScope.js'
import { ensureAuthSchema } from '../auth/schema.js'
import { ensureRbacSchema, upsertVersionScope, upsertLandscapeScope } from './schema.js'
import type { SessionClaims } from '../auth/tokens.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'

/**
 * SECURITY matrix for the REST write gates. `requireLandscapeInOrg` proves
 * membership, not privilege, so every landscape-scoped mutation
 * (rename/delete landscape, create/rename/delete versions, snapshots, drafts,
 * MERGE-INTO-LIVE) also needs a write gate. A read-only ("View") team member
 * must get 403 at stage 'on' from every mutating endpoint, while
 * writers/org-admins/platform-admins keep working and stage 'off'/'dual'
 * preserve legacy behavior.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

function rid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('base64url')}`
}

function reqFor(claims: SessionClaims | undefined): Request {
  return { auth: claims } as unknown as Request
}

interface RecordedRes {
  statusCode: number
  body: unknown
}
function fakeRes(): Response & RecordedRes {
  const r = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return r as unknown as Response & RecordedRes
}

describe.skipIf(!TEST_DATABASE_URL)('workspaceGate write gates (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let pool: pg.Pool
  const originalAuth = process.env.AUTH

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'wsgate_write')
    pool = db.pool
    await pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT, org_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL, root_url TEXT NOT NULL, parent_version_id TEXT,
        kind TEXT NOT NULL DEFAULT 'version', status TEXT NOT NULL DEFAULT 'active',
        base_manifest JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await ensureAuthSchema(pool)
    await ensureRbacSchema(pool)
  })

  afterAll(async () => {
    if (originalAuth === undefined) delete process.env.AUTH
    else process.env.AUTH = originalAuth
    await db?.teardown()
  })

  beforeEach(() => {
    process.env.AUTH = 'on'
    _clearAllowedWorkspaceKeysCacheForTests()
  })

  // ── Fixtures ─────────────────────────────────────────────────────────────
  interface Fixture {
    orgId: string
    landscapeId: string
    versionId: string
    landscapeScopeId: string
    versionScopeId: string
  }

  async function makeFixture(): Promise<Fixture> {
    const orgId = rid('org')
    await pool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [orgId, `gate org ${orgId}`, orgId])
    const landscapeId = rid('landscape')
    const versionId = rid('version')
    await pool.query(`INSERT INTO landscapes (id, name, org_id, default_version_id) VALUES ($1, 'L', $2, $3)`, [
      landscapeId, orgId, versionId,
    ])
    await pool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', 'automerge:x')`, [
      versionId, landscapeId,
    ])
    const landscapeScopeId = await upsertLandscapeScope(pool, orgId, landscapeId)
    const versionScopeId = await upsertVersionScope(pool, orgId, landscapeId, versionId)
    return { orgId, landscapeId, versionId, landscapeScopeId, versionScopeId }
  }

  async function makeMember(orgId: string, role: 'admin' | 'member'): Promise<SessionClaims> {
    const userId = rid('user')
    await pool.query(`INSERT INTO users (id, issuer, subject, email, name) VALUES ($1, 'test', $2, $3, $3)`, [
      userId, userId, `${userId}@example.com`,
    ])
    await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)`, [orgId, userId, role])
    return { userId, orgId, isPlatformAdmin: false, epoch: 1 }
  }

  async function grant(orgId: string, userId: string, scopeId: string, canWrite: boolean): Promise<void> {
    const teamId = rid('team')
    await pool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'T')`, [teamId, orgId])
    await pool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [teamId, userId])
    await pool.query(
      `INSERT INTO team_scope_permissions (team_id, scope_id, resource_type, can_read, can_write) VALUES ($1, $2, '*', true, $3)`,
      [teamId, scopeId, canWrite]
    )
  }

  async function dropOrg(orgId: string): Promise<void> {
    await pool.query(`DELETE FROM landscapes WHERE org_id = $1`, [orgId])
    await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId])
  }

  // ── requireLandscapeWrite ────────────────────────────────────────────────

  it('THE DEFECT (REST): a View-grant member gets 403 from landscape mutations', async () => {
    const f = await makeFixture()
    try {
      const viewer = await makeMember(f.orgId, 'member')
      await grant(f.orgId, viewer.userId, f.landscapeScopeId, false) // read-only grant
      const res = fakeRes()
      expect(await requireLandscapeWrite(pool, reqFor(viewer), res, f.landscapeId)).toBe(false)
      expect(res.statusCode).toBe(403)
      expect(res.body).toEqual({ error: 'forbidden' })
    } finally {
      await dropOrg(f.orgId)
    }
  })

  it('a write-grant member passes', async () => {
    const f = await makeFixture()
    try {
      const writer = await makeMember(f.orgId, 'member')
      await grant(f.orgId, writer.userId, f.landscapeScopeId, true)
      expect(await requireLandscapeWrite(pool, reqFor(writer), fakeRes(), f.landscapeId)).toBe(true)
    } finally {
      await dropOrg(f.orgId)
    }
  })

  it('an org admin passes with no team grant; a grantless member does not', async () => {
    const f = await makeFixture()
    try {
      const admin = await makeMember(f.orgId, 'admin')
      const member = await makeMember(f.orgId, 'member')
      expect(await requireLandscapeWrite(pool, reqFor(admin), fakeRes(), f.landscapeId)).toBe(true)
      const res = fakeRes()
      expect(await requireLandscapeWrite(pool, reqFor(member), res, f.landscapeId)).toBe(false)
      expect(res.statusCode).toBe(403)
    } finally {
      await dropOrg(f.orgId)
    }
  })

  it('platform admin bypasses; stage off and sessionless requests pass through (legacy)', async () => {
    const f = await makeFixture()
    try {
      const pa: SessionClaims = { userId: 'pa', orgId: null, isPlatformAdmin: true, epoch: 1 }
      expect(await requireLandscapeWrite(pool, reqFor(pa), fakeRes(), f.landscapeId)).toBe(true)

      process.env.AUTH = 'off'
      const viewer = await makeMember(f.orgId, 'member')
      expect(await requireLandscapeWrite(pool, reqFor(viewer), fakeRes(), f.landscapeId)).toBe(true)

      process.env.AUTH = 'on'
      expect(await requireLandscapeWrite(pool, reqFor(undefined), fakeRes(), f.landscapeId)).toBe(true)
    } finally {
      await dropOrg(f.orgId)
    }
  })

  it("stage 'dual' warns but allows the same viewer the 'on' stage refuses", async () => {
    const f = await makeFixture()
    try {
      const viewer = await makeMember(f.orgId, 'member')
      await grant(f.orgId, viewer.userId, f.landscapeScopeId, false)
      process.env.AUTH = 'dual'
      expect(await requireLandscapeWrite(pool, reqFor(viewer), fakeRes(), f.landscapeId)).toBe(true)
      process.env.AUTH = 'on'
      expect(await requireLandscapeWrite(pool, reqFor(viewer), fakeRes(), f.landscapeId)).toBe(false)
    } finally {
      await dropOrg(f.orgId)
    }
  })

  it('a missing landscape passes through (the endpoint 404s, not the gate)', async () => {
    const someone: SessionClaims = { userId: rid('user'), orgId: rid('org'), isPlatformAdmin: false, epoch: 1 }
    expect(await requireLandscapeWrite(pool, reqFor(someone), fakeRes(), 'no-such-landscape')).toBe(true)
  })

  it('a cross-org admin is refused (defense in depth under requireLandscapeInOrg)', async () => {
    const f = await makeFixture()
    const otherOrgId = rid('org')
    await pool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'other', $1)`, [otherOrgId])
    try {
      const foreignAdmin = await makeMember(otherOrgId, 'admin')
      const res = fakeRes()
      expect(await requireLandscapeWrite(pool, reqFor(foreignAdmin), res, f.landscapeId)).toBe(false)
      expect(res.statusCode).toBe(403)
    } finally {
      await dropOrg(f.orgId)
      await dropOrg(otherOrgId)
    }
  })

  it("a SUSPENDED org's landscape is unwritable even for its org admin", async () => {
    const f = await makeFixture()
    try {
      const admin = await makeMember(f.orgId, 'admin')
      await pool.query(`UPDATE orgs SET status = 'suspended' WHERE id = $1`, [f.orgId])
      const res = fakeRes()
      expect(await requireLandscapeWrite(pool, reqFor(admin), res, f.landscapeId)).toBe(false)
      expect(res.statusCode).toBe(403)
    } finally {
      await dropOrg(f.orgId)
    }
  })

  it('missing scope row (pre-backfill edge): org admin passes, member fails closed', async () => {
    const f = await makeFixture()
    try {
      await pool.query(`DELETE FROM scopes WHERE landscape_id = $1`, [f.landscapeId])
      const admin = await makeMember(f.orgId, 'admin')
      const member = await makeMember(f.orgId, 'member')
      expect(await requireLandscapeWrite(pool, reqFor(admin), fakeRes(), f.landscapeId)).toBe(true)
      const res = fakeRes()
      expect(await requireLandscapeWrite(pool, reqFor(member), res, f.landscapeId)).toBe(false)
      expect(res.statusCode).toBe(403)
    } finally {
      await dropOrg(f.orgId)
    }
  })

  // ── requireVersionWrite ──────────────────────────────────────────────────

  it('a VERSION-scoped write grant opens that version but not landscape-level mutations', async () => {
    const f = await makeFixture()
    try {
      const contributor = await makeMember(f.orgId, 'member')
      await grant(f.orgId, contributor.userId, f.versionScopeId, true) // write on ONE version only

      // May mutate that version (rename/delete/merge-into-it)…
      expect(await requireVersionWrite(pool, reqFor(contributor), fakeRes(), f.landscapeId, f.versionId)).toBe(true)
      // …but may NOT restructure the landscape (create versions, rename it, …).
      const res = fakeRes()
      expect(await requireLandscapeWrite(pool, reqFor(contributor), res, f.landscapeId)).toBe(false)
      expect(res.statusCode).toBe(403)
    } finally {
      await dropOrg(f.orgId)
    }
  })

  it('a landscape-level write grant inherits down to every version (requireVersionWrite passes)', async () => {
    const f = await makeFixture()
    try {
      const writer = await makeMember(f.orgId, 'member')
      await grant(f.orgId, writer.userId, f.landscapeScopeId, true)
      expect(await requireVersionWrite(pool, reqFor(writer), fakeRes(), f.landscapeId, f.versionId)).toBe(true)
    } finally {
      await dropOrg(f.orgId)
    }
  })

  it('a View grant fails requireVersionWrite too (no privilege via the version path)', async () => {
    const f = await makeFixture()
    try {
      const viewer = await makeMember(f.orgId, 'member')
      await grant(f.orgId, viewer.userId, f.landscapeScopeId, false)
      const res = fakeRes()
      expect(await requireVersionWrite(pool, reqFor(viewer), res, f.landscapeId, f.versionId)).toBe(false)
      expect(res.statusCode).toBe(403)
    } finally {
      await dropOrg(f.orgId)
    }
  })

  // ── requireOrgAdmin (landscape create/delete) ────────────────────────────

  it('requireOrgAdmin: member 403, admin passes, platform admin bypasses, suspended org refused', async () => {
    const f = await makeFixture()
    try {
      const member = await makeMember(f.orgId, 'member')
      const admin = await makeMember(f.orgId, 'admin')
      const pa: SessionClaims = { userId: 'pa', orgId: null, isPlatformAdmin: true, epoch: 1 }

      const memberRes = fakeRes()
      expect(await requireOrgAdmin(pool, reqFor(member), memberRes)).toBe(false)
      expect(memberRes.statusCode).toBe(403)
      expect(await requireOrgAdmin(pool, reqFor(admin), fakeRes())).toBe(true)
      expect(await requireOrgAdmin(pool, reqFor(pa), fakeRes())).toBe(true)

      await pool.query(`UPDATE orgs SET status = 'suspended' WHERE id = $1`, [f.orgId])
      const suspendedRes = fakeRes()
      expect(await requireOrgAdmin(pool, reqFor(admin), suspendedRes)).toBe(false)
      expect(suspendedRes.statusCode).toBe(403)
    } finally {
      await dropOrg(f.orgId)
    }
  })

  it('requireOrgAdmin: an org-less session (invite-intent login) is refused at stage on', async () => {
    const orgless: SessionClaims = { userId: rid('user'), orgId: null, isPlatformAdmin: false, epoch: 1 }
    const res = fakeRes()
    expect(await requireOrgAdmin(pool, reqFor(orgless), res)).toBe(false)
    expect(res.statusCode).toBe(403)
  })

  // ── workspaceAccessForRequest (the client's lock-down signal) ────────────

  it('reports canRead:true/canWrite:false/enforced:true for a viewer at stage on', async () => {
    const f = await makeFixture()
    try {
      const viewer = await makeMember(f.orgId, 'member')
      await grant(f.orgId, viewer.userId, f.landscapeScopeId, false)
      const access = await workspaceAccessForRequest(pool, reqFor(viewer), {
        landscapeId: f.landscapeId,
        versionId: f.versionId,
      })
      expect(access).toEqual({ canRead: true, canWrite: false, enforced: true })
    } finally {
      await dropOrg(f.orgId)
    }
  })

  it('reports full access for a writer, and enforced:false at stage dual', async () => {
    const f = await makeFixture()
    try {
      const writer = await makeMember(f.orgId, 'member')
      await grant(f.orgId, writer.userId, f.landscapeScopeId, true)
      expect(
        await workspaceAccessForRequest(pool, reqFor(writer), { landscapeId: f.landscapeId, versionId: f.versionId })
      ).toEqual({ canRead: true, canWrite: true, enforced: true })

      process.env.AUTH = 'dual'
      _clearAllowedWorkspaceKeysCacheForTests()
      const viewer = await makeMember(f.orgId, 'member')
      await grant(f.orgId, viewer.userId, f.landscapeScopeId, false)
      const dualAccess = await workspaceAccessForRequest(pool, reqFor(viewer), {
        landscapeId: f.landscapeId,
        versionId: f.versionId,
      })
      expect(dualAccess.canWrite).toBe(false)
      expect(dualAccess.enforced).toBe(false) // client must NOT lock below stage 'on'
    } finally {
      await dropOrg(f.orgId)
    }
  })

  it('stage off / sessionless: full access (legacy identity)', async () => {
    process.env.AUTH = 'off'
    expect(await workspaceAccessForRequest(pool, reqFor(undefined), { landscapeId: 'x', versionId: 'y' })).toEqual({
      canRead: true,
      canWrite: true,
      enforced: false,
    })
    process.env.AUTH = 'on'
    expect(await workspaceAccessForRequest(pool, reqFor(undefined), { landscapeId: 'x', versionId: 'y' })).toEqual({
      canRead: true,
      canWrite: true,
      enforced: false,
    })
  })
})
