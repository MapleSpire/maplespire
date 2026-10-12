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
import { Repo } from '@automerge/automerge-repo'
import { mintDocumentIdBytes } from './documentIdMint.js'
import {
  buildAccessCheck,
  buildWriteCheck,
  writableWorkspaceKeys,
  allowedWorkspaceKeys,
  _clearAllowedWorkspaceKeysCacheForTests,
  type PeerIdentityLookup,
} from './docScope.js'
import { ensureAuthSchema } from '../auth/schema.js'
import { ensureRbacSchema, upsertVersionScope, upsertLandscapeScope } from './schema.js'
import type { SessionClaims } from '../auth/tokens.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'

/**
 * SECURITY matrix for the WRITE side of the sync access resolution — the
 * live-Postgres counterpart of syncWriteGate.test.ts. A user in a read-only
 * ("View") team must not be able to edit diagrams. Every case here pins the
 * asymmetry: the READ check may allow while the WRITE check denies, and write
 * comes ONLY from a can_write grant, org adminship, or platform adminship.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

function rid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('base64url')}`
}

describe('buildWriteCheck â€” workspace route boundary', () => {
  it('does not let a platform admin write outside the socket workspace', async () => {
    const wsA = { landscapeId: 'L1', versionId: 'V1' }
    const wsB = { landscapeId: 'L2', versionId: 'V2' }
    const index = {
      resolveDocWorkspace: async (docId: string) => docId === 'a' ? wsA : docId === 'b' ? wsB : null,
      isServerManagedRoot: async () => false,
    }
    const claims: SessionClaims = { userId: 'platform', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const registry: PeerIdentityLookup = {
      identityForPeer: () => claims,
      workspaceForPeer: () => wsA,
    }
    const check = buildWriteCheck({} as pg.Pool, index as never, registry)
    expect(await check('peer', 'a')).toBe(true)
    expect(await check('peer', 'b')).toBe(false)
    expect(await check('peer', 'unknown')).toBe(false)
  })

  it('denies a static root mutation even to a platform admin while keeping its children writable', async () => {
    const workspace = { landscapeId: 'L-static', versionId: 'V-static' }
    const index = {
      resolveDocWorkspace: async () => workspace,
      isServerManagedRoot: async (documentId: string) => documentId === 'root',
    }
    const claims: SessionClaims = { userId: 'platform', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const registry: PeerIdentityLookup = {
      identityForPeer: () => claims,
      workspaceForPeer: () => workspace,
    }
    const check = buildWriteCheck({} as pg.Pool, index as never, registry)

    await expect(check('peer', 'root')).resolves.toBe(false)
    await expect(check('peer', 'diagram-child')).resolves.toBe(true)
  })
})

describe.skipIf(!TEST_DATABASE_URL)('buildWriteCheck — write gate matrix (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let pool: pg.Pool

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'docscope_write')
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
    await db?.teardown()
  })

  async function makeOrg(): Promise<string> {
    const id = rid('org')
    await pool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [id, `write test org ${id}`, id])
    return id
  }
  async function makeUser(): Promise<string> {
    const id = rid('user')
    await pool.query(`INSERT INTO users (id, issuer, subject, email, name) VALUES ($1, 'test', $2, $3, $3)`, [
      id, id, `${id}@example.com`,
    ])
    return id
  }
  async function makeWorkspace(orgId: string): Promise<{ landscapeId: string; versionId: string }> {
    const landscapeId = rid('landscape')
    const versionId = rid('version')
    await pool.query(`INSERT INTO landscapes (id, name, org_id) VALUES ($1, 'L', $2)`, [landscapeId, orgId])
    await pool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', 'automerge:fake')`, [
      versionId, landscapeId,
    ])
    await upsertVersionScope(pool, orgId, landscapeId, versionId)
    return { landscapeId, versionId }
  }
  /** Team + membership + one grant on the given scope. */
  async function grantOnScope(
    orgId: string,
    userId: string,
    scopeId: string,
    perms: { canRead: boolean; canWrite: boolean }
  ): Promise<void> {
    const teamId = rid('team')
    await pool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'T')`, [teamId, orgId])
    await pool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [teamId, userId])
    await pool.query(
      `INSERT INTO team_scope_permissions (team_id, scope_id, resource_type, can_read, can_write) VALUES ($1, $2, '*', $3, $4)`,
      [teamId, scopeId, perms.canRead, perms.canWrite]
    )
  }
  async function versionScopeId(orgId: string, ws: { landscapeId: string; versionId: string }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM scopes WHERE org_id = $1 AND kind = 'version' AND landscape_id = $2 AND version_id = $3`,
      [orgId, ws.landscapeId, ws.versionId]
    )
    return rows[0].id
  }
  async function memberOf(orgId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
    await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)`, [orgId, userId, role])
  }
  function claimsFor(userId: string, orgId: string | null, epoch = 1): SessionClaims {
    return { userId, orgId, isPlatformAdmin: false, epoch }
  }
  function registryFor(claims: SessionClaims | null | undefined): PeerIdentityLookup {
    return { identityForPeer: () => claims }
  }
  /** A ROUTED socket — required for the mint's placement branch to be reachable. */
  function registryRouted(
    claims: SessionClaims | null | undefined,
    route: { landscapeId: string; versionId: string },
  ): PeerIdentityLookup {
    return { identityForPeer: () => claims, workspaceForPeer: () => route }
  }
  /** Named the way the client names one: through `create2` over a minted id. */
  async function mintedIdFor(ws: { landscapeId: string; versionId: string }): Promise<string> {
    const repo = new Repo({ idFactory: async () => mintDocumentIdBytes(ws) })
    return String((await repo.create2({ made: 'offline' })).documentId)
  }
  function fakeIndex(resolved: Record<string, { landscapeId: string; versionId: string } | null>) {
    return {
      resolveDocWorkspace: async (docId: string) => resolved[docId] ?? null,
      isServerManagedRoot: async () => false,
    } as unknown as import('./docScope.js').WorkspaceDocIndex
  }
  async function dropOrg(orgId: string): Promise<void> {
    await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId])
  }
  async function dropLandscape(landscapeId: string): Promise<void> {
    await pool.query(`DELETE FROM landscapes WHERE id = $1`, [landscapeId])
  }

  it('THE DEFECT: a View-grant member READS but cannot WRITE the same doc', async () => {
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await memberOf(orgId, userId, 'member')
      const ws = await makeWorkspace(orgId)
      await grantOnScope(orgId, userId, await versionScopeId(orgId, ws), { canRead: true, canWrite: false })

      const claims = claimsFor(userId, orgId)
      const read = buildAccessCheck(pool, fakeIndex({ doc: ws }), registryFor(claims))
      const write = buildWriteCheck(pool, fakeIndex({ doc: ws }), registryFor(claims))
      expect(await read('p', 'doc')).toBe(true) // View means view…
      expect(await write('p', 'doc')).toBe(false) // …not edit.
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('T6 — un membre en consultation ne peut pas écrire le ModelMeta (le porteur du tombstone)', async () => {
    // Its own row rather than resting on the case above: ModelMeta carries a
    // DESTRUCTIVE operation — `deletedDiagramIds`. A View-grant user who could
    // write it could delete diagrams for everyone. `buildWriteCheck` is
    // agnostic of document KIND, so this row pins that a future "control
    // documents are exempt" shortcut cannot be added quietly.
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await memberOf(orgId, userId, 'member')
      const ws = await makeWorkspace(orgId)
      await grantOnScope(orgId, userId, await versionScopeId(orgId, ws), { canRead: true, canWrite: false })

      const claims = claimsFor(userId, orgId)
      const index = fakeIndex({ 'model-meta': ws })
      const read = buildAccessCheck(pool, index, registryFor(claims))
      const write = buildWriteCheck(pool, index, registryFor(claims))
      expect(await read('p', 'model-meta')).toBe(true)
      expect(await write('p', 'model-meta')).toBe(false)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  // PLACEMENT IS NOT PERMISSION.
  //
  // A minted id lets the gates place a document the index has not seen yet.
  // The other mint tests use a platform-admin session, which returns before
  // the grant lookup runs; these two rows pin that an ORDINARY member still
  // has to earn the document after placement succeeds — the mint fills a hole
  // in the index, it is not a way around RBAC.
  it('MINTED but ungranted: a member with no grant is still denied a correctly minted document', async () => {
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await memberOf(orgId, userId, 'member') // membership only — no team grant
      const ws = await makeWorkspace(orgId)
      const claims = claimsFor(userId, orgId)
      const documentId = await mintedIdFor(ws)

      // The index has NEVER seen it: placement can only come from the MAC.
      const read = buildAccessCheck(pool, fakeIndex({}), registryRouted(claims, ws))
      const write = buildWriteCheck(pool, fakeIndex({}), registryRouted(claims, ws))
      expect(await read('p', documentId)).toBe(false)
      expect(await write('p', documentId)).toBe(false)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('MINTED and View-only: the read passes, the write does NOT — the asymmetry survives placement', async () => {
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await memberOf(orgId, userId, 'member')
      const ws = await makeWorkspace(orgId)
      await grantOnScope(orgId, userId, await versionScopeId(orgId, ws), { canRead: true, canWrite: false })
      const claims = claimsFor(userId, orgId)
      const documentId = await mintedIdFor(ws)

      const read = buildAccessCheck(pool, fakeIndex({}), registryRouted(claims, ws))
      const write = buildWriteCheck(pool, fakeIndex({}), registryRouted(claims, ws))
      expect(await read('p', documentId)).toBe(true)
      expect(await write('p', documentId), 'a View grant must not gain write from a minted id').toBe(false)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('a write-grant member passes both checks', async () => {
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await memberOf(orgId, userId, 'member')
      const ws = await makeWorkspace(orgId)
      await grantOnScope(orgId, userId, await versionScopeId(orgId, ws), { canRead: true, canWrite: true })

      const claims = claimsFor(userId, orgId)
      const read = buildAccessCheck(pool, fakeIndex({ doc: ws }), registryFor(claims))
      const write = buildWriteCheck(pool, fakeIndex({ doc: ws }), registryFor(claims))
      expect(await read('p', 'doc')).toBe(true)
      expect(await write('p', 'doc')).toBe(true)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('a LANDSCAPE-level write grant inherits down to the version scope (seed layout)', async () => {
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await memberOf(orgId, userId, 'member')
      const ws = await makeWorkspace(orgId)
      // Grant on the LANDSCAPE scope, exactly like orgSeed's Architecture/Platform teams.
      const landScopeId = await upsertLandscapeScope(pool, orgId, ws.landscapeId)
      await grantOnScope(orgId, userId, landScopeId, { canRead: true, canWrite: true })

      const write = buildWriteCheck(pool, fakeIndex({ doc: ws }), registryFor(claimsFor(userId, orgId)))
      expect(await write('p', 'doc')).toBe(true)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('an org admin writes without any team grant', async () => {
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await memberOf(orgId, userId, 'admin')
      const ws = await makeWorkspace(orgId)
      const write = buildWriteCheck(pool, fakeIndex({ doc: ws }), registryFor(claimsFor(userId, orgId)))
      expect(await write('p', 'doc')).toBe(true)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('a plain member with NO grant writes nothing (write never comes from membership)', async () => {
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await memberOf(orgId, userId, 'member')
      const ws = await makeWorkspace(orgId)
      const write = buildWriteCheck(pool, fakeIndex({ doc: ws }), registryFor(claimsFor(userId, orgId)))
      expect(await write('p', 'doc')).toBe(false)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('an admin of a DIFFERENT org cannot write (org isolation)', async () => {
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgA = await makeOrg()
    const orgB = await makeOrg()
    try {
      const userB = await makeUser()
      await memberOf(orgB, userB, 'admin')
      const wsA = await makeWorkspace(orgA)
      const write = buildWriteCheck(pool, fakeIndex({ doc: wsA }), registryFor(claimsFor(userB, orgB)))
      expect(await write('p', 'doc')).toBe(false)
      await dropLandscape(wsA.landscapeId)
    } finally {
      await dropOrg(orgA)
      await dropOrg(orgB)
    }
  })

  it('platform admin -> write ALLOW (bypasses doc indexing like the read check)', async () => {
    const claims: SessionClaims = { userId: 'pa', orgId: null, isPlatformAdmin: true, epoch: 1 }
    const write = buildWriteCheck(pool, fakeIndex({}), registryFor(claims))
    expect(await write('p', 'doc-unindexed')).toBe(true)
  })

  it('unknown peer / sessionless socket / unindexed doc -> write DENY (default-deny chain)', async () => {
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await memberOf(orgId, userId, 'admin')
      expect(await buildWriteCheck(pool, fakeIndex({}), registryFor(undefined))('p', 'doc')).toBe(false)
      expect(await buildWriteCheck(pool, fakeIndex({}), registryFor(null))('p', 'doc')).toBe(false)
      // org-admin claims but the doc resolves to no workspace: quarantined.
      expect(
        await buildWriteCheck(pool, fakeIndex({}), registryFor(claimsFor(userId, orgId)))('p', 'doc-unindexed')
      ).toBe(false)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('a DEACTIVATED user loses write even with a write grant', async () => {
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await memberOf(orgId, userId, 'member')
      const ws = await makeWorkspace(orgId)
      await grantOnScope(orgId, userId, await versionScopeId(orgId, ws), { canRead: true, canWrite: true })
      await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [userId])

      const write = buildWriteCheck(pool, fakeIndex({ doc: ws }), registryFor(claimsFor(userId, orgId)))
      expect(await write('p', 'doc')).toBe(false)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  it("a SUSPENDED org's workspaces are unwritable even for its org admin", async () => {
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await memberOf(orgId, userId, 'admin')
      const ws = await makeWorkspace(orgId)
      await pool.query(`UPDATE orgs SET status = 'suspended' WHERE id = $1`, [orgId])

      const write = buildWriteCheck(pool, fakeIndex({ doc: ws }), registryFor(claimsFor(userId, orgId)))
      expect(await write('p', 'doc')).toBe(false)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
    }
  })

  it('writableWorkspaceKeys is cached per (user, epoch): a new grant shows up on epoch bump, not mid-epoch', async () => {
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await memberOf(orgId, userId, 'member')
      const ws = await makeWorkspace(orgId)
      const key = `${ws.landscapeId}/${ws.versionId}`

      // Epoch 1: no grant -> not writable (and now cached under epoch 1).
      expect((await writableWorkspaceKeys(pool, claimsFor(userId, orgId, 1))).has(key)).toBe(false)

      // Grant arrives (in production this bumps the org epoch via triggers,
      // which terminates sockets and reissues sessions with the new epoch).
      await grantOnScope(orgId, userId, await versionScopeId(orgId, ws), { canRead: true, canWrite: true })

      // Same epoch inside the TTL still answers from cache — bounded staleness…
      expect((await writableWorkspaceKeys(pool, claimsFor(userId, orgId, 1))).has(key)).toBe(false)
      // …and the bumped epoch (what a re-authenticated socket carries) sees it.
      expect((await writableWorkspaceKeys(pool, claimsFor(userId, orgId, 2))).has(key)).toBe(true)
      // The read set shares the same entry/semantics.
      expect((await allowedWorkspaceKeys(pool, claimsFor(userId, orgId, 2))).has(key)).toBe(true)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
      _clearAllowedWorkspaceKeysCacheForTests()
    }
  })

  it('REVOCATION: dropping the write grant removes write (new epoch) while read-only remains if granted', async () => {
    _clearAllowedWorkspaceKeysCacheForTests()
    const orgId = await makeOrg()
    try {
      const userId = await makeUser()
      await memberOf(orgId, userId, 'member')
      const ws = await makeWorkspace(orgId)
      const key = `${ws.landscapeId}/${ws.versionId}`
      const scopeId = await versionScopeId(orgId, ws)
      await grantOnScope(orgId, userId, scopeId, { canRead: true, canWrite: true })
      expect((await writableWorkspaceKeys(pool, claimsFor(userId, orgId, 1))).has(key)).toBe(true)

      // Demote the grant to read-only (an admin flips the team to View).
      await pool.query(`UPDATE team_scope_permissions SET can_write = false WHERE scope_id = $1`, [scopeId])

      expect((await writableWorkspaceKeys(pool, claimsFor(userId, orgId, 2))).has(key)).toBe(false)
      expect((await allowedWorkspaceKeys(pool, claimsFor(userId, orgId, 2))).has(key)).toBe(true)
      await dropLandscape(ws.landscapeId)
    } finally {
      await dropOrg(orgId)
      _clearAllowedWorkspaceKeysCacheForTests()
    }
  })
})
