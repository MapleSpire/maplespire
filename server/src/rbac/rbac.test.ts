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

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { ensureAuthSchema } from '../auth/schema.js'
import { ensureRbacSchema, upsertOrgScope, upsertLandscapeScope, upsertVersionScope, softDeleteScope } from './schema.js'
import { explainAccess } from './access.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'

/**
 * Real-database tests for the RBAC schema: policy functions on a throwaway
 * Postgres. This suite stays green with NO database configured
 * (skipped entirely) and exercises the real triggers/functions against a live
 * Postgres when TEST_DATABASE_URL is set.
 *
 * Every fixture lives inside one throwaway org created with a random id, and
 * that org row is deleted at the end — `ON DELETE CASCADE` from `orgs` takes
 * every team/scope/grant/effective-permission row with it, so cleanup is a
 * single statement.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

function rid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('base64url')}`
}

describe.skipIf(!TEST_DATABASE_URL)('rbac schema (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let pool: pg.Pool

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'rbac_schema')
    pool = db.pool
    await ensureAuthSchema(pool)
    await ensureRbacSchema(pool)
  })

  afterAll(async () => {
    await db?.teardown()
  })

  /** Insert a throwaway org + return its id. */
  async function makeOrg(): Promise<string> {
    const id = rid('org')
    await pool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [id, `RBAC test org ${id}`, id])
    return id
  }

  /** Insert a throwaway user (unique issuer/subject) + return its id. */
  async function makeUser(email: string): Promise<string> {
    const id = rid('user')
    await pool.query(
      `INSERT INTO users (id, issuer, subject, email, name) VALUES ($1, 'test', $2, $3, $3)`,
      [id, id, email]
    )
    return id
  }

  async function addOrgMember(orgId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
    await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)`, [orgId, userId, role])
  }

  async function makeTeam(orgId: string): Promise<string> {
    const id = rid('team')
    await pool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3)`, [id, orgId, `Team ${id}`])
    return id
  }

  async function addTeamMember(teamId: string, userId: string): Promise<void> {
    await pool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [teamId, userId])
  }

  async function removeTeamMember(teamId: string, userId: string): Promise<void> {
    await pool.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [teamId, userId])
  }

  async function grant(
    teamId: string,
    scopeId: string,
    perms: { canRead: boolean; canWrite: boolean },
    resourceType = '*'
  ): Promise<void> {
    await pool.query(
      `INSERT INTO team_scope_permissions (team_id, scope_id, resource_type, can_read, can_write)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (team_id, scope_id, resource_type)
       DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write`,
      [teamId, scopeId, resourceType, perms.canRead, perms.canWrite]
    )
  }

  async function effectivePermsFor(userId: string): Promise<Array<{ scope_id: string; resource_type: string; can_read: boolean; can_write: boolean }>> {
    const { rows } = await pool.query(
      `SELECT scope_id, resource_type, can_read, can_write FROM user_effective_permissions WHERE user_id = $1`,
      [userId]
    )
    return rows
  }

  async function dropOrg(orgId: string): Promise<void> {
    await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId])
  }

  it('closure table: org -> landscape -> version chain has correct depths', async () => {
    const orgId = await makeOrg()
    try {
      const landscapeId = rid('landscape')
      const versionId = rid('version')
      const orgScopeId = await upsertOrgScope(pool, orgId)
      const landscapeScopeId = await upsertLandscapeScope(pool, orgId, landscapeId)
      const versionScopeId = await upsertVersionScope(pool, orgId, landscapeId, versionId)

      const { rows: versionAncestors } = await pool.query<{ ancestor_id: string; depth: number }>(
        `SELECT ancestor_id, depth FROM scope_ancestors WHERE scope_id = $1 ORDER BY depth ASC`,
        [versionScopeId]
      )
      expect(versionAncestors).toEqual([
        { ancestor_id: versionScopeId, depth: 0 },
        { ancestor_id: landscapeScopeId, depth: 1 },
        { ancestor_id: orgScopeId, depth: 2 },
      ])

      const { rows: landscapeAncestors } = await pool.query<{ ancestor_id: string; depth: number }>(
        `SELECT ancestor_id, depth FROM scope_ancestors WHERE scope_id = $1 ORDER BY depth ASC`,
        [landscapeScopeId]
      )
      expect(landscapeAncestors).toEqual([
        { ancestor_id: landscapeScopeId, depth: 0 },
        { ancestor_id: orgScopeId, depth: 1 },
      ])

      const { rows: orgAncestors } = await pool.query<{ ancestor_id: string; depth: number }>(
        `SELECT ancestor_id, depth FROM scope_ancestors WHERE scope_id = $1`,
        [orgScopeId]
      )
      expect(orgAncestors).toEqual([{ ancestor_id: orgScopeId, depth: 0 }])
    } finally {
      await dropOrg(orgId)
    }
  })

  it('scope upserts are idempotent: repeated calls return the same scope id', async () => {
    const orgId = await makeOrg()
    try {
      const landscapeId = rid('landscape')
      const versionId = rid('version')
      const first = await upsertVersionScope(pool, orgId, landscapeId, versionId)
      const second = await upsertVersionScope(pool, orgId, landscapeId, versionId)
      expect(second).toBe(first)

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM scopes WHERE org_id = $1 AND kind = $2', [
        orgId,
        'version',
      ])
      expect(rows[0].n).toBe(1)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('grant to a team on the LANDSCAPE scope: member gets can_read via ancestors on the VERSION scope', async () => {
    const orgId = await makeOrg()
    try {
      const landscapeId = rid('landscape')
      const versionId = rid('version')
      const landscapeScopeId = await upsertLandscapeScope(pool, orgId, landscapeId)
      const versionScopeId = await upsertVersionScope(pool, orgId, landscapeId, versionId)

      const userId = await makeUser('member@example.com')
      await addOrgMember(orgId, userId, 'member')
      const teamId = await makeTeam(orgId)
      await addTeamMember(teamId, userId)

      // Read-only grant at the landscape level.
      await grant(teamId, landscapeScopeId, { canRead: true, canWrite: false })

      const result = await explainAccess(pool, userId, versionScopeId, '*')
      expect(result.allowed).toBe(true)
      expect(result.canRead).toBe(true)
      expect(result.canWrite).toBe(false)
      expect(result.via).toBe('team-grant')
      expect(result.grantScopeId).toBe(landscapeScopeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('can_write only where granted: a read-only landscape grant does not imply write on the version scope', async () => {
    const orgId = await makeOrg()
    try {
      const landscapeId = rid('landscape')
      const versionId = rid('version')
      const landscapeScopeId = await upsertLandscapeScope(pool, orgId, landscapeId)
      const versionScopeId = await upsertVersionScope(pool, orgId, landscapeId, versionId)

      const userId = await makeUser('reader@example.com')
      await addOrgMember(orgId, userId, 'member')
      const teamId = await makeTeam(orgId)
      await addTeamMember(teamId, userId)
      await grant(teamId, landscapeScopeId, { canRead: true, canWrite: false })

      const versionAccess = await explainAccess(pool, userId, versionScopeId, '*')
      expect(versionAccess.canRead).toBe(true)
      expect(versionAccess.canWrite).toBe(false)

      // A direct write grant AT the version scope does grant write there
      // (and only there, not e.g. at a sibling version).
      await grant(teamId, versionScopeId, { canRead: true, canWrite: true })
      const versionAccessAfterWriteGrant = await explainAccess(pool, userId, versionScopeId, '*')
      expect(versionAccessAfterWriteGrant.canWrite).toBe(true)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('org member with no team grants anywhere gets no access', async () => {
    const orgId = await makeOrg()
    try {
      const landscapeId = rid('landscape')
      const versionId = rid('version')
      const versionScopeId = await upsertVersionScope(pool, orgId, landscapeId, versionId)

      const userId = await makeUser('nogrant@example.com')
      await addOrgMember(orgId, userId, 'member')

      const result = await explainAccess(pool, userId, versionScopeId, '*')
      expect(result.allowed).toBe(false)
      expect(result.canRead).toBe(false)
      expect(result.canWrite).toBe(false)
      expect(result.via).toBe('none')
    } finally {
      await dropOrg(orgId)
    }
  })

  it('team-member removal empties effective perms for that user (trigger)', async () => {
    const orgId = await makeOrg()
    try {
      const landscapeId = rid('landscape')
      const landscapeScopeId = await upsertLandscapeScope(pool, orgId, landscapeId)

      const userId = await makeUser('leaver@example.com')
      await addOrgMember(orgId, userId, 'member')
      const teamId = await makeTeam(orgId)
      await addTeamMember(teamId, userId)
      await grant(teamId, landscapeScopeId, { canRead: true, canWrite: true })

      const before = await effectivePermsFor(userId)
      expect(before.length).toBeGreaterThan(0)

      await removeTeamMember(teamId, userId)

      const after = await effectivePermsFor(userId)
      expect(after).toEqual([])

      const access = await explainAccess(pool, userId, landscapeScopeId, '*')
      expect(access.allowed).toBe(false)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('org admin bypass via rbac_effective_access: full read+write regardless of team grants', async () => {
    const orgId = await makeOrg()
    try {
      const landscapeId = rid('landscape')
      const landscapeScopeId = await upsertLandscapeScope(pool, orgId, landscapeId)

      const adminId = await makeUser('admin@example.com')
      await addOrgMember(orgId, adminId, 'admin')
      // No team, no grant — org-admin bypass alone must grant full access.

      const result = await explainAccess(pool, adminId, landscapeScopeId, '*')
      expect(result.allowed).toBe(true)
      expect(result.canRead).toBe(true)
      expect(result.canWrite).toBe(true)
      expect(result.via).toBe('org-admin')
    } finally {
      await dropOrg(orgId)
    }
  })

  it('deactivated users get no access even with a live grant', async () => {
    const orgId = await makeOrg()
    try {
      const landscapeId = rid('landscape')
      const landscapeScopeId = await upsertLandscapeScope(pool, orgId, landscapeId)

      const userId = await makeUser('deactivated@example.com')
      await addOrgMember(orgId, userId, 'member')
      const teamId = await makeTeam(orgId)
      await addTeamMember(teamId, userId)
      await grant(teamId, landscapeScopeId, { canRead: true, canWrite: true })

      await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [userId])

      const result = await explainAccess(pool, userId, landscapeScopeId, '*')
      expect(result.allowed).toBe(false)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('parent_id immutability raises on UPDATE', async () => {
    const orgId = await makeOrg()
    try {
      const landscapeIdA = rid('landscape')
      const landscapeIdB = rid('landscape')
      const scopeA = await upsertLandscapeScope(pool, orgId, landscapeIdA)
      const scopeB = await upsertLandscapeScope(pool, orgId, landscapeIdB)

      // Re-parenting scopeA under scopeB (a genuinely different scope than
      // its current parent, the org scope) must raise.
      await expect(
        pool.query('UPDATE scopes SET parent_id = $1 WHERE id = $2', [scopeB, scopeA])
      ).rejects.toThrow(/parent_id is immutable/)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('softDeleteScope marks deleted_at but leaves the row (and its grants) intact', async () => {
    const orgId = await makeOrg()
    try {
      const landscapeId = rid('landscape')
      const versionId = rid('version')
      const domainId = rid('domain')
      const { upsertDomainScope } = await import('./schema.js')
      const domainScopeId = await upsertDomainScope(pool, orgId, landscapeId, versionId, domainId)

      await softDeleteScope(pool, domainScopeId)

      const { rows } = await pool.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM scopes WHERE id = $1', [
        domainScopeId,
      ])
      expect(rows[0].deleted_at).not.toBeNull()

      // Re-upserting the same domain un-deletes it and returns the same id.
      const resurrected = await upsertDomainScope(pool, orgId, landscapeId, versionId, domainId)
      expect(resurrected).toBe(domainScopeId)
      const { rows: afterResurrect } = await pool.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM scopes WHERE id = $1',
        [domainScopeId]
      )
      expect(afterResurrect[0].deleted_at).toBeNull()
    } finally {
      await dropOrg(orgId)
    }
  })
})
