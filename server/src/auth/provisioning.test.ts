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

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Repo } from '@automerge/automerge-repo'
import pg from 'pg'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'

/**
 * DB-gated integration tests (live Postgres, isolated per-suite schema) for
 * the multi-org substrate: first-login provisioning (personal org + landscape
 * + starter diagram), login-org resolution, POST /api/orgs and
 * POST /api/auth/switch-org. The Automerge repo is a bare in-memory Repo —
 * document CONTENT is asserted through it directly.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('provisioning + multi-org endpoints (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let realPool: pg.Pool
  let repo: Repo
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let provisioning: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let orgsRoutes: any

  beforeAll(async () => {
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-secret-for-provisioning-suite'
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'provisioning_orgs')
    realPool = db.pool

    vi.doMock('../db.js', () => ({ pool: realPool }))
    vi.resetModules()

    const authSchema = await import('./schema.js')
    const rbacSchema = await import('../rbac/schema.js')
    await authSchema.ensureAuthSchema(realPool)
    await rbacSchema.ensureRbacSchema(realPool)
    // landscapes/versions live in db.ts's initSchema — recreate the relevant
    // shape here (same DDL, incl. the org_id column).
    await realPool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        default_version_id TEXT,
        org_id             TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await realPool.query(`
      CREATE TABLE IF NOT EXISTS versions (
        id                TEXT PRIMARY KEY,
        landscape_id      TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label             TEXT NOT NULL,
        root_url          TEXT NOT NULL,
        parent_version_id TEXT,
        kind              TEXT NOT NULL DEFAULT 'version',
        status            TEXT NOT NULL DEFAULT 'active',
        base_manifest     JSONB,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    repo = new Repo({ network: [] })
    provisioning = await import('./provisioning.js')
    provisioning.setProvisioningRepo(repo)
    orgsRoutes = await import('./orgs.js')
  }, 30_000)

  afterAll(async () => {
    await db?.teardown()
    vi.doUnmock('../db.js')
    vi.resetModules()
  })

  async function createUser(email: string): Promise<string> {
    const id = `u-${randomBytes(6).toString('hex')}`
    await realPool.query(`INSERT INTO users (id, issuer, subject, email, given_name) VALUES ($1, 'dev', $2, $3, 'Test')`, [
      id,
      email.toLowerCase(),
      email,
    ])
    return id
  }

  it('provisions a personal org: org + admin membership + landscape + Main version + starter diagram, all wired', async () => {
    const userId = await createUser('prov-1@example.test')
    const result = await provisioning.provisionOrgWithLandscape(realPool, {
      name: "Test's organization",
      ownerUserId: userId,
    })
    expect(result).not.toBeNull()

    const { rows: orgRows } = await realPool.query(
      'SELECT name, slug, default_landscape_id FROM orgs WHERE id = $1',
      [result.orgId]
    )
    expect(orgRows[0].name).toBe("Test's organization")
    expect(orgRows[0].slug).toMatch(/^[a-z0-9-]{2,40}$/)
    expect(orgRows[0].default_landscape_id).toBe(result.landscapeId)

    const { rows: memberRows } = await realPool.query(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
      [result.orgId, userId]
    )
    expect(memberRows[0].role).toBe('admin')

    const { rows: lsRows } = await realPool.query(
      'SELECT org_id, default_version_id FROM landscapes WHERE id = $1',
      [result.landscapeId]
    )
    expect(lsRows[0].org_id).toBe(result.orgId)
    expect(lsRows[0].default_version_id).toBe(result.versionId)

    const { rows: lastOrg } = await realPool.query('SELECT last_org_id FROM users WHERE id = $1', [userId])
    expect(lastOrg[0].last_org_id).toBe(result.orgId)

    // RBAC scope registered under the OWNING org.
    const { rows: scopeRows } = await realPool.query(
      `SELECT 1 FROM scopes WHERE org_id = $1 AND kind = 'version' AND landscape_id = $2 AND version_id = $3`,
      [result.orgId, result.landscapeId, result.versionId]
    )
    expect(scopeRows.length).toBe(1)

    // The workspace docs carry the starter diagram + sharded skeleton.
    const { rows: vRows } = await realPool.query('SELECT root_url FROM versions WHERE id = $1', [result.versionId])
    const rootHandle = await repo.find(vRows[0].root_url)
    await rootHandle.whenReady()
    const root = rootHandle.doc() as { modelUrl: string; modelMetaUrl?: string; shardUrls: string[] }
    expect(root.modelMetaUrl).toBeTruthy()
    const shard = await repo.find(root.shardUrls[0] as never)
    await shard.whenReady()
    const diagrams = Object.values((shard.doc() as { diagrams: Record<string, { name: string; docUrl: string }> }).diagrams)
    expect(diagrams).toHaveLength(1)
    expect(diagrams[0].name).toBe('New context diagram')
  })

  it('resolveLoginOrg: invite intent skips provisioning; without intent it provisions once even under concurrency', async () => {
    const intentUserId = await createUser('prov-intent@example.test')
    const intentRes = await provisioning.resolveLoginOrg(
      realPool,
      { id: intentUserId, email: 'prov-intent@example.test', givenName: 'Test' },
      { inviteIntent: true }
    )
    expect(intentRes).toEqual({ kind: 'none' })
    const { rows: none } = await realPool.query('SELECT 1 FROM org_members WHERE user_id = $1', [intentUserId])
    expect(none.length).toBe(0)

    const raceUserId = await createUser('prov-race@example.test')
    const user = { id: raceUserId, email: 'prov-race@example.test', givenName: 'Race' }
    const [a, b] = await Promise.all([
      provisioning.resolveLoginOrg(realPool, user, { inviteIntent: false }),
      provisioning.resolveLoginOrg(realPool, user, { inviteIntent: false }),
    ])
    expect(a.kind).toBe('org')
    expect(b.kind).toBe('org')
    expect(a.orgId).toBe(b.orgId) // one personal org, not two
    const { rows: memberships } = await realPool.query('SELECT org_id FROM org_members WHERE user_id = $1', [raceUserId])
    expect(memberships.length).toBe(1)
  })

  it('resolveLoginOrg: prefers last_org_id among active memberships; all-suspended refuses', async () => {
    const userId = await createUser('prov-multi@example.test')
    const user = { id: userId, email: 'prov-multi@example.test', givenName: 'Multi' }
    const first = await provisioning.provisionOrgWithLandscape(realPool, { name: 'First org', ownerUserId: userId })
    const second = await provisioning.provisionOrgWithLandscape(realPool, { name: 'Second org', ownerUserId: userId })

    // last_org_id currently = second (set by the later provisioning).
    let res = await provisioning.resolveLoginOrg(realPool, user, { inviteIntent: false })
    expect(res).toEqual({ kind: 'org', orgId: second.orgId })

    // Suspend the last org → falls back to the earliest ACTIVE membership.
    await realPool.query(`UPDATE orgs SET status = 'suspended' WHERE id = $1`, [second.orgId])
    res = await provisioning.resolveLoginOrg(realPool, user, { inviteIntent: false })
    expect(res).toEqual({ kind: 'org', orgId: first.orgId })

    // Everything suspended → refused.
    await realPool.query(`UPDATE orgs SET status = 'suspended' WHERE id = $1`, [first.orgId])
    res = await provisioning.resolveLoginOrg(realPool, user, { inviteIntent: false })
    expect(res).toEqual({ kind: 'suspended' })
  })

  describe('org endpoints', () => {
    async function startServer(auth: {
      userId: string
      orgId: string | null
      isPlatformAdmin: boolean
      epoch: number
      imp?: { by: string }
    }): Promise<{ url: string; close: () => Promise<void> }> {
      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        req.auth = auth
        next()
      })
      orgsRoutes.registerOrgRoutes(app)
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s))
      })
      const port = (server.address() as AddressInfo).port
      return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
      }
    }

    it('POST /api/orgs provisions a full org and GET /api/me/orgs lists it with isCurrent', async () => {
      const userId = await createUser('orgs-create@example.test')
      const { url, close } = await startServer({ userId, orgId: null, isPlatformAdmin: false, epoch: 1 })
      try {
        const res = await fetch(`${url}/api/orgs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Second Org' }),
        })
        expect(res.status).toBe(201)
        const { org } = (await res.json()) as { org: { id: string; defaultLandscapeId: string } }
        expect(org.defaultLandscapeId).toBeTruthy()

        const listRes = await fetch(`${url}/api/me/orgs`)
        const { orgs } = (await listRes.json()) as { orgs: Array<{ id: string; role: string; isCurrent: boolean; defaultLandscapeId: string }> }
        const created = orgs.find((o) => o.id === org.id)
        expect(created?.role).toBe('admin')
        expect(created?.isCurrent).toBe(false) // session pinned to null
        expect(created?.defaultLandscapeId).toBe(org.defaultLandscapeId)
      } finally {
        await close()
      }
    })

    it('switch-org: requires membership, refuses suspended orgs and impersonated sessions, sets a fresh cookie', async () => {
      const userId = await createUser('orgs-switch@example.test')
      const own = await provisioning.provisionOrgWithLandscape(realPool, { name: 'Mine', ownerUserId: userId })
      const foreign = await provisioning.provisionOrgWithLandscape(realPool, {
        name: 'Theirs',
        ownerUserId: await createUser('orgs-other@example.test'),
      })

      const { url, close } = await startServer({ userId, orgId: null, isPlatformAdmin: false, epoch: 1 })
      try {
        const okRes = await fetch(`${url}/api/auth/switch-org`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId: own.orgId }),
        })
        expect(okRes.status).toBe(200)
        expect(okRes.headers.get('set-cookie')).toContain('maplespire_session=')

        const notMember = await fetch(`${url}/api/auth/switch-org`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId: foreign.orgId }),
        })
        expect(notMember.status).toBe(403)
        expect(((await notMember.json()) as { error: string }).error).toBe('not_a_member')

        await realPool.query(`UPDATE orgs SET status = 'suspended' WHERE id = $1`, [own.orgId])
        const suspended = await fetch(`${url}/api/auth/switch-org`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId: own.orgId }),
        })
        expect(suspended.status).toBe(403)
        expect(((await suspended.json()) as { error: string }).error).toBe('org_suspended')
        await realPool.query(`UPDATE orgs SET status = 'active' WHERE id = $1`, [own.orgId])
      } finally {
        await close()
      }

      const imp = await startServer({ userId, orgId: null, isPlatformAdmin: false, epoch: 1, imp: { by: 'admin-x' } })
      try {
        const impRes = await fetch(`${imp.url}/api/auth/switch-org`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId: own.orgId }),
        })
        expect(impRes.status).toBe(403)
        expect(((await impRes.json()) as { error: string }).error).toBe('forbidden_while_impersonating')
      } finally {
        await imp.close()
      }
    })
  })
})
