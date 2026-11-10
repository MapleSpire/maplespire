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

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ensureAuthSchema } from '../auth/schema.js'
import { ensureAiSchema } from './core/schema.js'
import { createAiToken, resolvePatExpiry, PatExpiryTooLongError } from './core/tokens.js'
import type { McpDeps } from './adapters/mcp/buildServer.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const DAY = 24 * 60 * 60 * 1000

// The bridge and /mcp read `pool` from db.js; point it at the isolated schema.
const holder = vi.hoisted(() => ({
  pool: null as null | { query: (...a: unknown[]) => Promise<unknown>; connect: () => Promise<unknown> },
}))
vi.mock('../db.js', () => ({
  pool: {
    query: (...a: unknown[]) => holder.pool!.query(...a),
    // revokeToken runs its UPDATE + audit insert in one transaction.
    connect: () => holder.pool!.connect(),
  },
}))

/**
 * V0-06: bearer tokens follow the same revocation rules as sessions —
 * disabled owner, suspended org, and any epoch bump after mint end the token
 * (401 on the bridge and on /mcp) — and new PATs expire (90 days by default,
 * per-org ceiling `orgs.settings.aiTokenMaxDays`).
 */
describe.skipIf(!TEST_DATABASE_URL)('bearer token revocation + default expiry (live Postgres)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb
  let server: Server
  let base: string

  async function post(path: string, token: string, body: unknown = {}) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    })
  }

  /** Status of an authenticated-looking call through the bridge: 200 echo with auth, or auth null. */
  async function bridgeAuthUser(token: string): Promise<string | null> {
    const res = await fetch(`${base}/api/ai/tools`, { headers: { authorization: `Bearer ${token}` } })
    const body = (await res.json()) as { auth: { userId: string } | null }
    return body.auth?.userId ?? null
  }

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  }

  async function mint(userId: string, orgId: string | null, extra: { expiresAt?: Date | null } = {}) {
    return (await createAiToken(db.pool, { userId, orgId, name: 't', ...extra })).token
  }

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'ai_token_revocation')
    holder.pool = db.pool
    await ensureAuthSchema(db.pool)
    await ensureAiSchema(db.pool)
    await db.pool.query(
      `INSERT INTO users (id, issuer, subject, email, name, status) VALUES
       ('a', 'test', 'a', 'a@example.com', 'A', 'active'),
       ('b', 'test', 'b', 'b@example.com', 'B', 'active'),
       ('c', 'test', 'c', 'c@example.com', 'C', 'active'),
       ('d', 'test', 'd', 'd@example.com', 'D', 'active'),
       ('e', 'test', 'e', 'e@example.com', 'E', 'active'),
       ('f', 'test', 'f', 'f@example.com', 'F', 'active')`
    )
    await db.pool.query(
      `INSERT INTO orgs (id, name, slug) VALUES ('o1', 'O1', 'o1'), ('o2', 'O2', 'o2'), ('o3', 'O3', 'o3')`
    )

    const { aiBearerBridge } = await import('./adapters/bearerAuth.js')
    const { registerMcpHttpRoutes } = await import('./adapters/mcp/http.js')
    const app = express()
    app.use(express.json())
    registerMcpHttpRoutes(app, {} as McpDeps)
    app.use('/api', aiBearerBridge())
    app.use((req, res) => {
      res.json({ auth: req.auth ?? null })
    })
    server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }, 60_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    await db?.teardown()
  })

  it('control: a live PAT authenticates through the bridge and /mcp', async () => {
    const token = await mint('a', 'o1', { expiresAt: new Date(Date.now() + 60_000) })
    expect(await bridgeAuthUser(token)).toBe('a')
    expect((await post('/mcp', token, initialize)).status).toBe(200)
  })

  it('a disabled user PAT gets 401 on /mcp and no identity on the bridge', async () => {
    const token = await mint('b', 'o1')
    expect(await bridgeAuthUser(token)).toBe('b')
    await db.pool.query(`UPDATE users SET status = 'deactivated' WHERE id = 'b'`)
    expect((await post('/mcp', token, initialize)).status).toBe(401)
    expect(await bridgeAuthUser(token)).toBeNull()
  })

  it('a deleted user PAT is refused', async () => {
    const token = await mint('f', null)
    await db.pool.query(`DELETE FROM users WHERE id = 'f'`)
    expect((await post('/mcp', token, initialize)).status).toBe(401)
  })

  it('a PAT minted before a global epoch bump is refused; one minted after is accepted', async () => {
    const before = await mint('c', 'o1')
    expect((await post('/mcp', before, initialize)).status).toBe(200)
    await db.pool.query(
      `INSERT INTO auth_global_epochs (user_id, epoch) VALUES ('c', 2)
       ON CONFLICT (user_id) DO UPDATE SET epoch = auth_global_epochs.epoch + 1`
    )
    expect((await post('/mcp', before, initialize)).status).toBe(401)
    expect(await bridgeAuthUser(before)).toBeNull()
    const after = await mint('c', 'o1')
    expect((await post('/mcp', after, initialize)).status).toBe(200)
  })

  it('a PAT minted before a per-user epoch bump in its org is refused', async () => {
    const before = await mint('d', 'o1')
    expect(await bridgeAuthUser(before)).toBe('d')
    await db.pool.query(
      `INSERT INTO auth_user_epochs (org_id, user_id, epoch) VALUES ('o1', 'd', 2)
       ON CONFLICT (org_id, user_id) DO UPDATE SET epoch = auth_user_epochs.epoch + 1`
    )
    expect(await bridgeAuthUser(before)).toBeNull()
    expect((await post('/mcp', before, initialize)).status).toBe(401)
  })

  it('a suspended org (org epoch bumped, status suspended) refuses its PATs', async () => {
    const token = await mint('e', 'o2')
    expect(await bridgeAuthUser(token)).toBe('e')
    // Status alone must be enough, with no epoch bump.
    await db.pool.query(`UPDATE orgs SET status = 'suspended' WHERE id = 'o2'`)
    expect(await bridgeAuthUser(token)).toBeNull()
    expect((await post('/mcp', token, initialize)).status).toBe(401)
    // Un-suspended with no bump: accepted again (same as a session minted before the suspension but after the bump).
    await db.pool.query(`UPDATE orgs SET status = 'active' WHERE id = 'o2'`)
    expect(await bridgeAuthUser(token)).toBe('e')
    // An org-wide epoch bump (what a suspension does to sessions) kills it.
    await db.pool.query(
      `INSERT INTO auth_epochs (org_id, epoch) VALUES ('o2', 2)
       ON CONFLICT (org_id) DO UPDATE SET epoch = auth_epochs.epoch + 1`
    )
    expect(await bridgeAuthUser(token)).toBeNull()
  })

  it('a row with missing pins fails closed (the schema step backfills, so none should exist)', async () => {
    const token = await mint('a', 'o3')
    expect(await bridgeAuthUser(token)).toBe('a')
    await db.pool.query(
      `UPDATE ai_api_tokens SET pin_org_epoch = NULL, pin_user_epoch = NULL, pin_global_epoch = NULL
       WHERE user_id = 'a' AND org_id = 'o3'`
    )
    expect(await bridgeAuthUser(token)).toBeNull()
  })

  it('an OAuth refresh grant is refused once the owner is disabled (no re-mint under current epochs)', async () => {
    const { hashToken } = await import('./core/crypto.js')
    const { findByRefreshToken, loadLiveTokenOwner } = await import('./core/tokens.js')
    const refresh = 'bvrr_' + 'b'.repeat(40)
    await createAiToken(db.pool, {
      userId: 'a', orgId: 'o1', name: 'MCP', kind: 'oauth', refreshTokenHash: hashToken(refresh),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const row = (await findByRefreshToken(db.pool, refresh))!
    expect(await loadLiveTokenOwner(db.pool, row)).not.toBeNull()
    await db.pool.query(`INSERT INTO auth_global_epochs (user_id, epoch) VALUES ('a', 2)
      ON CONFLICT (user_id) DO UPDATE SET epoch = auth_global_epochs.epoch + 1`)
    expect(await loadLiveTokenOwner(db.pool, row)).toBeNull()
    await db.pool.query(`DELETE FROM auth_global_epochs WHERE user_id = 'a'`)
  })

  it('an expired PAT gets 401 on /mcp and no identity on the bridge', async () => {
    const token = await mint('a', 'o1', { expiresAt: new Date(Date.now() - 1000) })
    expect((await post('/mcp', token, initialize)).status).toBe(401)
    expect(await bridgeAuthUser(token)).toBeNull()
  })

  describe('legacy rows (minted before the pin columns existed)', () => {
    it('are pinned to the CURRENT epochs once; a later bump kills them; a second schema run does not resurrect them', async () => {
      const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
      const { verifyBearerIdentity } = await import('./core/identity.js')
      const { hashToken } = await import('./core/crypto.js')
      const legacy = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'ai_token_legacy_pins')
      try {
        await ensureAuthSchema(legacy.pool)
        await ensureAiSchema(legacy.pool)
        // Recreate the pre-V0-06 table shape and a legacy token minted under it.
        await legacy.pool.query(
          `ALTER TABLE ai_api_tokens DROP COLUMN pin_org_epoch, DROP COLUMN pin_user_epoch, DROP COLUMN pin_global_epoch`
        )
        await legacy.pool.query(
          `INSERT INTO users (id, issuer, subject, email, status) VALUES ('lu', 't', 'lu', 'lu@example.com', 'active')`
        )
        await legacy.pool.query(`INSERT INTO orgs (id, name, slug) VALUES ('lo', 'LO', 'lo')`)
        await legacy.pool.query(
          `INSERT INTO auth_global_epochs (user_id, epoch) VALUES ('lu', 3);
           INSERT INTO auth_epochs (org_id, epoch) VALUES ('lo', 4);
           INSERT INTO auth_user_epochs (org_id, user_id, epoch) VALUES ('lo', 'lu', 5)`
        )
        const token = 'bvr_' + 'c'.repeat(40)
        await legacy.pool.query(
          `INSERT INTO ai_api_tokens (id, kind, user_id, org_id, name, token_hash, token_prefix)
           VALUES ('legacy1', 'pat', 'lu', 'lo', 'old', $1, 'bvr_cccccc…')`,
          [hashToken(token)]
        )

        await ensureAiSchema(legacy.pool)
        expect(await verifyBearerIdentity(legacy.pool, token)).toMatchObject({ userId: 'lu', orgId: 'lo' })
        const { rows } = await legacy.pool.query(
          `SELECT pin_global_epoch, pin_org_epoch, pin_user_epoch FROM ai_api_tokens WHERE id = 'legacy1'`
        )
        expect(rows[0]).toEqual({ pin_global_epoch: '3', pin_org_epoch: '4', pin_user_epoch: '5' })

        await legacy.pool.query(`UPDATE auth_user_epochs SET epoch = 6 WHERE org_id = 'lo' AND user_id = 'lu'`)
        expect(await verifyBearerIdentity(legacy.pool, token)).toBeNull()

        // Boot again after the bump: the backfill must not re-pin to 6.
        await ensureAiSchema(legacy.pool)
        expect(await verifyBearerIdentity(legacy.pool, token)).toBeNull()
      } finally {
        await legacy.teardown()
      }
    }, 60_000)
  })

  describe('default expiry', () => {

    it('a new PAT carries a 90-day expiry by default (org without setting, and org-less)', async () => {
      const now = Date.now()
      expect((await resolvePatExpiry(db.pool, 'o1', undefined, now)).getTime()).toBe(now + 90 * DAY)
      expect((await resolvePatExpiry(db.pool, null, undefined, now)).getTime()).toBe(now + 90 * DAY)
    })

    it('the org setting aiTokenMaxDays changes the default and the ceiling', async () => {
      const now = Date.now()
      await db.pool.query(`UPDATE orgs SET settings = settings || '{"aiTokenMaxDays": 30}'::jsonb WHERE id = 'o1'`)
      expect((await resolvePatExpiry(db.pool, 'o1', undefined, now)).getTime()).toBe(now + 30 * DAY)
      // shorter is allowed, longer is refused
      expect((await resolvePatExpiry(db.pool, 'o1', 7, now)).getTime()).toBe(now + 7 * DAY)
      await expect(resolvePatExpiry(db.pool, 'o1', 31, now)).rejects.toBeInstanceOf(PatExpiryTooLongError)
      // a raised ceiling allows a longer, explicit request
      await db.pool.query(`UPDATE orgs SET settings = settings || '{"aiTokenMaxDays": 365}'::jsonb WHERE id = 'o1'`)
      expect((await resolvePatExpiry(db.pool, 'o1', 200, now)).getTime()).toBe(now + 200 * DAY)
      // a corrupt stored value falls back to the default
      await db.pool.query(`UPDATE orgs SET settings = settings || '{"aiTokenMaxDays": "forever"}'::jsonb WHERE id = 'o1'`)
      expect((await resolvePatExpiry(db.pool, 'o1', undefined, now)).getTime()).toBe(now + 90 * DAY)
      await db.pool.query(`UPDATE orgs SET settings = settings - 'aiTokenMaxDays' WHERE id = 'o1'`)
    })

    it('POST /api/me/ai-tokens stamps the default, honours a shorter request and refuses a longer one', async () => {
      const { registerAiHttpRoutes } = await import('./adapters/httpRoutes.js')
      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        req.auth = { userId: 'a', orgId: 'o1', isPlatformAdmin: false, epoch: 1 }
        next()
      })
      registerAiHttpRoutes(app, {} as never)
      const s = createServer(app)
      await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/me/ai-tokens`
      const mintVia = async (body: unknown) =>
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      try {
        const dflt = await mintVia({ name: 'default' })
        expect(dflt.status).toBe(200)
        const exp = new Date(((await dflt.json()) as { info: { expiresAt: string } }).info.expiresAt).getTime()
        expect(Math.abs(exp - (Date.now() + 90 * DAY))).toBeLessThan(60_000)

        const short = await mintVia({ name: 'short', expiresInDays: 7 })
        const shortExp = new Date(((await short.json()) as { info: { expiresAt: string } }).info.expiresAt).getTime()
        expect(Math.abs(shortExp - (Date.now() + 7 * DAY))).toBeLessThan(60_000)

        const long = await mintVia({ name: 'long', expiresInDays: 91 })
        expect(long.status).toBe(400)
        expect(await long.json()).toMatchObject({ error: 'expires_too_long', maxDays: 90 })

        // 0 / negative no longer mean "never expires".
        expect((await mintVia({ name: 'zero', expiresInDays: 0 })).status).toBe(400)

        await db.pool.query(`UPDATE orgs SET settings = settings || '{"aiTokenMaxDays": 30}'::jsonb WHERE id = 'o1'`)
        const orgDefault = await mintVia({ name: 'org' })
        const orgExp = new Date(((await orgDefault.json()) as { info: { expiresAt: string } }).info.expiresAt).getTime()
        expect(Math.abs(orgExp - (Date.now() + 30 * DAY))).toBeLessThan(60_000)
      } finally {
        await db.pool.query(`UPDATE orgs SET settings = settings - 'aiTokenMaxDays' WHERE id = 'o1'`)
        await new Promise<void>((resolve) => s.close(() => resolve()))
      }
    })

    it('refuses a longer-than-default request without a setting, and non-positive requests', async () => {
      await expect(resolvePatExpiry(db.pool, 'o1', 91)).rejects.toBeInstanceOf(PatExpiryTooLongError)
      await expect(resolvePatExpiry(db.pool, 'o1', 0)).rejects.toBeInstanceOf(RangeError)
      await expect(resolvePatExpiry(db.pool, 'o1', -5)).rejects.toBeInstanceOf(RangeError)
      await expect(resolvePatExpiry(db.pool, 'o1', Number.NaN)).rejects.toBeInstanceOf(RangeError)
    })
  })

  /** One express app over the real token routes, signed in as `userId`. */
  async function tokenRoutes(userId: string, orgId: string | null) {
    const { registerAiHttpRoutes } = await import('./adapters/httpRoutes.js')
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.auth = { userId, orgId, isPlatformAdmin: false, epoch: 1 }
      next()
    })
    registerAiHttpRoutes(app, {} as never)
    const s = createServer(app)
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/me/ai-tokens`
    return {
      url,
      mint: (body: unknown) =>
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      close: () => new Promise<void>((resolve) => s.close(() => resolve())),
    }
  }

  describe('V0-07 scopes at mint', () => {
    it('stores requested catalog scopes as given, defaults to mcp, refuses unknown ones', async () => {
      const r = await tokenRoutes('a', 'o1')
      try {
        const dflt = await r.mint({ name: 'default' })
        expect(((await dflt.json()) as { info: { scopes: string[] } }).info.scopes).toEqual(['mcp'])

        const ro = await r.mint({ name: 'ro', scopes: ['model:read'] })
        expect(ro.status).toBe(200)
        const { token, info } = (await ro.json()) as { token: string; info: { id: string; scopes: string[] } }
        expect(info.scopes).toEqual(['model:read'])
        const { rows } = await db.pool.query(`SELECT scopes FROM ai_api_tokens WHERE id = $1`, [info.id])
        expect(rows[0].scopes).toEqual(['model:read'])
        // the bridge honours it: a read route passes, the write-only agent loop does not
        expect(await bridgeAuthUser(token)).toBe('a')
        const run = await fetch(`${base}/api/ai/run`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
        expect(run.status).toBe(403)

        const unknown = await r.mint({ name: 'bad', scopes: ['model:read', 'org:admin'] })
        expect(unknown.status).toBe(400)
        expect(await unknown.json()).toMatchObject({ error: 'unknown_scope', unknown: ['org:admin'] })
        const { rows: bad } = await db.pool.query(`SELECT 1 FROM ai_api_tokens WHERE name = 'bad'`)
        expect(bad).toHaveLength(0)
      } finally {
        await r.close()
      }
    })
  })

  describe('V0-07 audited revocation', () => {
    async function auditRows(tokenId: string) {
      const { rows } = await db.pool.query(
        `SELECT at, org_id, actor_user_id, impersonator_user_id, action, target_kind, target_id, detail
         FROM audit_log WHERE target_kind = 'ai_token' AND target_id = $1 ORDER BY id`,
        [tokenId]
      )
      return rows
    }

    it('self-revocation writes one audit row (actor, owner, default reason, timestamp) and the token then gets 401', async () => {
      const { token, info } = await createAiToken(db.pool, { userId: 'a', orgId: 'o1', name: 'self' })
      expect(await bridgeAuthUser(token)).toBe('a')
      const r = await tokenRoutes('a', 'o1')
      try {
        const before = Date.now()
        const del = await fetch(`${r.url}/${info.id}`, { method: 'DELETE' })
        expect(del.status).toBe(200)
        const rows = await auditRows(info.id)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          org_id: 'o1',
          actor_user_id: 'a',
          impersonator_user_id: null,
          action: 'ai_token.revoked',
          target_kind: 'ai_token',
          target_id: info.id,
          detail: { ownerUserId: 'a', reason: 'revoked by owner', actorRole: 'owner', tokenKind: 'pat' },
        })
        expect(Math.abs(new Date(rows[0].at as string).getTime() - before)).toBeLessThan(60_000)
        const { rows: tok } = await db.pool.query(`SELECT revoked_at FROM ai_api_tokens WHERE id = $1`, [info.id])
        expect(new Date(rows[0].at as string).getTime()).toBe(new Date(tok[0].revoked_at as string).getTime())

        expect((await post('/mcp', token, initialize)).status).toBe(401)
        expect(await bridgeAuthUser(token)).toBeNull()

        // a second revoke is a 404 and writes nothing
        expect((await fetch(`${r.url}/${info.id}`, { method: 'DELETE' })).status).toBe(404)
        expect(await auditRows(info.id)).toHaveLength(1)
      } finally {
        await r.close()
      }
    })

    it('a supplied self-revocation reason is recorded; another user cannot revoke the token', async () => {
      const { info } = await createAiToken(db.pool, { userId: 'a', orgId: 'o1', name: 'reasoned' })
      const other = await tokenRoutes('c', 'o1')
      const owner = await tokenRoutes('a', 'o1')
      try {
        expect((await fetch(`${other.url}/${info.id}`, { method: 'DELETE' })).status).toBe(404)
        expect(await auditRows(info.id)).toHaveLength(0)
        const del = await fetch(`${owner.url}/${info.id}`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'laptop lost' }),
        })
        expect(del.status).toBe(200)
        expect((await auditRows(info.id))[0].detail).toMatchObject({ reason: 'laptop lost' })
      } finally {
        await other.close()
        await owner.close()
      }
    })

    it('an admin revocation needs a non-empty reason and records the admin as actor, the owner in detail', async () => {
      const { revokeToken } = await import('./core/tokens.js')
      const { token, info } = await createAiToken(db.pool, { userId: 'a', orgId: 'o1', name: 'admin-revoked' })
      await expect(revokeToken(db.pool, info.id, '   ', { role: 'admin', userId: 'c' })).rejects.toBeInstanceOf(RangeError)
      expect(await bridgeAuthUser(token)).toBe('a')
      const revoked = await revokeToken(db.pool, info.id, 'offboarding', {
        role: 'admin',
        userId: 'c',
        impersonatorUserId: 'd',
      })
      expect(revoked).toMatchObject({ tokenId: info.id, ownerUserId: 'a', orgId: 'o1' })
      const rows = await auditRows(info.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        actor_user_id: 'c',
        impersonator_user_id: 'd',
        detail: { ownerUserId: 'a', reason: 'offboarding', actorRole: 'admin' },
      })
      expect(await bridgeAuthUser(token)).toBeNull()
      // already revoked: nothing to do, nothing written
      expect(await revokeToken(db.pool, info.id, 'again', { role: 'admin', userId: 'c' })).toBeNull()
      expect(await auditRows(info.id)).toHaveLength(1)
    })

    it('a failing audit insert leaves the token live (one transaction)', async () => {
      const { revokeToken } = await import('./core/tokens.js')
      const { token, info } = await createAiToken(db.pool, { userId: 'a', orgId: 'o1', name: 'atomic' })
      // A CHECK constraint that refuses exactly this token's audit row makes
      // the INSERT fail after the UPDATE has run inside the transaction.
      await db.pool.query(`ALTER TABLE audit_log ADD CONSTRAINT v007_probe CHECK (target_id <> $$${info.id}$$)`)
      try {
        await expect(revokeToken(db.pool, info.id, 'x', { role: 'owner', userId: 'a' })).rejects.toThrow(/appendAudit/)
      } finally {
        await db.pool.query(`ALTER TABLE audit_log DROP CONSTRAINT v007_probe`)
      }
      expect(await bridgeAuthUser(token)).toBe('a')
      expect(await auditRows(info.id)).toHaveLength(0)
    })
  })
})
