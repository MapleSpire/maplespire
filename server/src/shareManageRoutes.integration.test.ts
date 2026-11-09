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

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import pg from 'pg'
import { randomBytes } from 'node:crypto'
import type { SessionClaims } from './auth/tokens.js'
import type { IsolatedSchemaDb } from './testing/isolatedSchema.js'

/**
 * V0-03 (security finding S2) — share links of a DELETED landscape, and the
 * share PATCH body, against live Postgres:
 *
 *  - deleting a landscape removes its `shared_links` rows, so the public GET
 *    (`getShare` → null → 404 in index.ts) stops serving its snapshot;
 *  - the PATCH manage route refuses (404) a share whose landscape is gone —
 *    including an orphan row left by a pre-fix delete — instead of the write
 *    gate's "missing landscape passes" default;
 *  - an ill-typed PATCH body answers 400 and changes nothing; a valid one
 *    still updates the row.
 *
 * The route under test is the REAL handler (`sharePatchHandler`) index.ts
 * registers, mounted on a throwaway Express app at AUTH=on with injected
 * claims. `./db.js` is mocked to an isolated-schema pool, same technique as
 * `landscapes.rbac.test.ts`.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

function rid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('base64url')}`
}

describe.skipIf(!TEST_DATABASE_URL)('share links: deleted landscape + PATCH validation (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let pool: pg.Pool
  let shares: typeof import('./shares.js')
  let landscapes: typeof import('./landscapes.js')
  let routes: typeof import('./shareManageRoutes.js')
  let gate: typeof import('./rbac/workspaceGate.js')
  let rbacSchema: typeof import('./rbac/schema.js')
  let docScope: typeof import('./rbac/docScope.js')
  const originalAuth = process.env.AUTH

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('./testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'share_manage')
    pool = db.pool
    const realPool = pool
    vi.doMock('./db.js', () => ({ pool: realPool }))
    vi.resetModules()

    const authSchema = await import('./auth/schema.js')
    rbacSchema = await import('./rbac/schema.js')
    await authSchema.ensureAuthSchema(pool)
    await rbacSchema.ensureRbacSchema(pool)
    // Same DDL as db.ts's initSchema for the three tables this path touches.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT, org_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shared_links (
        token TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'latest', scope TEXT NOT NULL DEFAULT 'diagram',
        diagram_id TEXT, limit_to_diagram BOOLEAN NOT NULL DEFAULT true, enabled BOOLEAN NOT NULL DEFAULT true,
        checkpoint_id TEXT, checkpoint_label TEXT, heads JSONB, snapshot JSONB NOT NULL,
        view_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ
      )
    `)

    shares = await import('./shares.js')
    landscapes = await import('./landscapes.js')
    routes = await import('./shareManageRoutes.js')
    gate = await import('./rbac/workspaceGate.js')
    docScope = await import('./rbac/docScope.js')
  })

  afterAll(async () => {
    if (originalAuth === undefined) delete process.env.AUTH
    else process.env.AUTH = originalAuth
    await db?.teardown()
    vi.doUnmock('./db.js')
    vi.resetModules()
  })

  beforeEach(() => {
    process.env.AUTH = 'on'
    docScope._clearAllowedWorkspaceKeysCacheForTests()
  })

  interface Org { orgId: string; admin: SessionClaims; landscapeId: string; versionId: string }

  /** An org with TWO landscapes (deleteLandscape refuses the org's last one)
   * and an org admin, who holds write on every scope of the org. */
  async function makeOrg(): Promise<Org> {
    const orgId = rid('org')
    await pool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [orgId, `Org ${orgId}`, orgId])
    let first: { landscapeId: string; versionId: string } | null = null
    for (let i = 0; i < 2; i++) {
      const landscapeId = rid('landscape')
      const versionId = rid('version')
      await pool.query(`INSERT INTO landscapes (id, name, org_id, default_version_id) VALUES ($1, 'L', $2, $3)`, [
        landscapeId, orgId, versionId,
      ])
      await pool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', 'automerge:x')`, [
        versionId, landscapeId,
      ])
      await rbacSchema.upsertVersionScope(pool, orgId, landscapeId, versionId)
      first ??= { landscapeId, versionId }
    }
    const userId = rid('user')
    await pool.query(`INSERT INTO users (id, issuer, subject, email, name) VALUES ($1, 'test', $2, $3, $3)`, [
      userId, userId, `${userId}@example.com`,
    ])
    await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, userId])
    return { orgId, admin: { userId, orgId, isPlatformAdmin: false, epoch: 1 }, ...first! }
  }

  async function shareRow(token: string): Promise<{ enabled: boolean; mode: string } | null> {
    const { rows } = await pool.query<{ enabled: boolean; mode: string }>(
      `SELECT enabled, mode FROM shared_links WHERE token = $1`, [token]
    )
    return rows[0] ?? null
  }

  /** The real PATCH handler on a throwaway app. `workspaceKey` mirrors
   * index.ts's `shareWorkspaceKey` for explicit (non-'current') version ids,
   * which is all these fixtures use. */
  async function patch(auth: SessionClaims, token: string, body: string): Promise<{ status: number; json: unknown }> {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { req.auth = auth; next() })
    app.patch('/api/shares/:token', routes.sharePatchHandler({
      pool,
      workspaceKey: async (landscapeId, versionId) => {
        const raw = { landscapeId: landscapeId ?? 'default', versionId: versionId ?? 'current' }
        return (await gate.canonicalWorkspaceKey(pool, raw)) ?? raw
      },
    }))
    const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
    try {
      const port = (server.address() as AddressInfo).port
      const res = await fetch(`http://127.0.0.1:${port}/api/shares/${encodeURIComponent(token)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      return { status: res.status, json: await res.json().catch(() => null) }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it('deleting a landscape removes its share rows; the share then resolves to nothing (GET 404s) and PATCH 404s', async () => {
    const o = await makeOrg()
    const share = await shares.createShare({ snapshot: { schema: 1 }, landscapeId: o.landscapeId, versionId: o.versionId })
    expect(await shareRow(share.token)).not.toBeNull()

    const result = await landscapes.deleteLandscape(o.landscapeId)
    expect(result).toEqual({ ok: true })

    const { rows } = await pool.query(`SELECT token FROM shared_links WHERE landscape_id = $1`, [o.landscapeId])
    expect(rows).toEqual([])
    expect(await shares.getShare(share.token)).toBeNull()

    const res = await patch(o.admin, share.token, JSON.stringify({ enabled: false }))
    expect([403, 404]).toContain(res.status)
  })

  it('deleting one landscape leaves the shares of another landscape untouched', async () => {
    const o = await makeOrg()
    const other = await makeOrg()
    const kept = await shares.createShare({ snapshot: { schema: 1 }, landscapeId: other.landscapeId, versionId: other.versionId })
    await shares.createShare({ snapshot: { schema: 1 }, landscapeId: o.landscapeId, versionId: o.versionId })
    expect(await landscapes.deleteLandscape(o.landscapeId)).toEqual({ ok: true })
    expect(await shareRow(kept.token)).not.toBeNull()
  })

  it('an ORPHAN share row (landscape already gone, e.g. deleted before this fix) is refused by PATCH, row unchanged', async () => {
    const o = await makeOrg()
    const token = rid('orphan')
    // Inserted directly: a row whose landscape was deleted without the cleanup.
    await pool.query(
      `INSERT INTO shared_links (token, snapshot, landscape_id, version_id, org_id, enabled) VALUES ($1, '{}', $2, $3, $4, true)`,
      [token, rid('gone-landscape'), rid('gone-version'), o.orgId]
    )
    const res = await patch(o.admin, token, JSON.stringify({ enabled: false, audience: 'public' }))
    expect(res.status).toBe(404)
    expect(await shareRow(token)).toEqual({ enabled: true, mode: 'latest' })
  })

  it('public read: an ORPHAN share (landscape row gone) resolves to nothing, a live share still resolves', async () => {
    const o = await makeOrg()
    const live = await shares.createShare({ snapshot: { schema: 1, live: true }, landscapeId: o.landscapeId, versionId: o.versionId })
    const orphan = rid('orphan')
    // Inserted directly: a pre-V0-03 delete left this row behind.
    await pool.query(
      `INSERT INTO shared_links (token, snapshot, landscape_id, version_id, org_id) VALUES ($1, '{"schema":1}', $2, $3, $4)`,
      [orphan, rid('gone-landscape'), rid('gone-version'), o.orgId]
    )
    // getShare is the only read behind GET /api/shares/:token; null → 404 there.
    expect(await shares.getShare(orphan)).toBeNull()
    const resolved = await shares.getShare(live.token)
    expect(resolved?.token).toBe(live.token)
    expect(resolved?.snapshot).toEqual({ schema: 1, live: true })
    // Not purged: the orphan row is still in the table (deleting it is the owner's call).
    expect(await shareRow(orphan)).not.toBeNull()

    // A NULL landscape_id (legacy, pre-workspace row not yet backfilled — the
    // backfill in ensureShareSchema already ran in this process) keeps today's
    // behaviour: it resolves.
    const legacy = rid('legacy')
    await pool.query(`INSERT INTO shared_links (token, snapshot) VALUES ($1, '{"schema":1}')`, [legacy])
    expect((await shares.getShare(legacy))?.token).toBe(legacy)
  })

  it('an ill-typed PATCH body answers 400 and changes nothing', async () => {
    const o = await makeOrg()
    const share = await shares.createShare({ snapshot: { schema: 1 }, landscapeId: o.landscapeId, versionId: o.versionId })
    const invalid = [
      { enabled: 'no' },
      { mode: 'bogus' },
      { scope: 42 },
      { audience: 'everyone' },
      { snapshot: 'not-an-object' },
      { snapshot: null },
      { heads: 'abc' },
      { allow3d: 'yes' },
      { limitToDiagram: 1 },
      { checkpointLabel: 7 },
      { allowedEmailDomain: ['a.com'] },
      [{ enabled: false }],
    ]
    for (const body of invalid) {
      const res = await patch(o.admin, share.token, JSON.stringify(body))
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(await shareRow(share.token)).toEqual({ enabled: true, mode: 'latest' })
  })

  it('a valid PATCH still updates the share', async () => {
    const o = await makeOrg()
    const share = await shares.createShare({ snapshot: { schema: 1 }, landscapeId: o.landscapeId, versionId: o.versionId })
    const res = await patch(o.admin, share.token, JSON.stringify({
      enabled: false, mode: 'pinned', heads: ['h1'], checkpointLabel: null, allow3d: false,
    }))
    expect(res.status).toBe(200)
    expect((res.json as { share: { enabled: boolean; mode: string; allow3d: boolean } }).share).toMatchObject({
      enabled: false, mode: 'pinned', allow3d: false,
    })
    expect(await shareRow(share.token)).toEqual({ enabled: false, mode: 'pinned' })

    // The client's audience switch to 'domain' with no domain yet is legal
    // (ShareMainView/ManageSharingView send allowedEmailDomain: null).
    const domain = await patch(o.admin, share.token, JSON.stringify({ audience: 'domain', allowedEmailDomain: null }))
    expect(domain.status).toBe(200)
  })
})
