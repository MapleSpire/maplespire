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
import express from 'express'
import type { AddressInfo } from 'node:net'
import type pg from 'pg'
import { randomBytes, createHash } from 'node:crypto'
import type { IsolatedSchemaDb } from '../testing/isolatedSchema.js'

/**
 * V0-02 against real Postgres: the `org_allowed_idp_tenants` table and the
 * `orgs.microsoft_personal_accounts_allowed` / `users.idp_tenant_id` /
 * `users.email_verified` columns as `ensureAuthSchema` (the repeatable
 * baseline migration) creates them; the `tenantAllowedSql` predicate as
 * Postgres evaluates it, through the real `signCurrentSession`,
 * `resolveLoginOrg` and invite-accept paths; and the org-admin routes —
 * authorization, Zod validation, the self-lockout guard, and the per-user
 * epoch bump that revokes sessions a change newly forbids.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

const ENTRA = 'https://login.microsoftonline.com/common/v2.0'
const PERSONAL = '9188040d-6c67-4c5b-b112-36a304b66dad'
const CORP = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-8888-4777-8666-555555555555'

const rid = (p: string) => `${p}-${randomBytes(6).toString('hex')}`

describe.skipIf(!TEST_DATABASE_URL)('org Entra tenant policy (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let realPool: pg.Pool
  let signCurrentSession: typeof import('./sessionEpoch.js').signCurrentSession
  let resolveLoginOrg: typeof import('./provisioning.js').resolveLoginOrg
  let registerOrgTenantRoutes: typeof import('./orgTenantRoutes.js').registerOrgTenantRoutes
  let registerInviteRoutes: typeof import('./invites.js').registerInviteRoutes

  beforeAll(async () => {
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-secret-for-org-tenant-policy'
    vi.resetModules()
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'org_tenant_policy')
    realPool = db.pool
    const { ensureAuthSchema } = await import('./schema.js')
    const { ensureRbacSchema } = await import('../rbac/schema.js')
    const { ensureEpochTriggers } = await import('./wsAuth.js')
    await ensureAuthSchema(realPool)
    // Twice: it is the repeatable baseline, so the new DDL must be idempotent.
    await ensureAuthSchema(realPool)
    await ensureRbacSchema(realPool)
    await ensureEpochTriggers(realPool)

    vi.doMock('../db.js', () => ({ pool: realPool }))
    vi.doMock('../email/index.js', () => ({ getEmailProvider: () => ({ send: async () => ({ id: 'x' }) }) }))
    vi.resetModules()
    ;({ signCurrentSession } = await import('./sessionEpoch.js'))
    ;({ resolveLoginOrg } = await import('./provisioning.js'))
    ;({ registerOrgTenantRoutes } = await import('./orgTenantRoutes.js'))
    ;({ registerInviteRoutes } = await import('./invites.js'))
  })

  afterAll(async () => {
    await db?.teardown()
    vi.doUnmock('../db.js')
    vi.doUnmock('../email/index.js')
    vi.resetModules()
  })

  async function makeOrg(opts: { tenants?: string[]; personalAllowed?: boolean } = {}): Promise<string> {
    const id = rid('org')
    await realPool.query(
      'INSERT INTO orgs (id, name, slug, microsoft_personal_accounts_allowed) VALUES ($1, $1, $1, $2)',
      [id, opts.personalAllowed ?? false],
    )
    for (const t of opts.tenants ?? []) {
      await realPool.query(
        "INSERT INTO org_allowed_idp_tenants (org_id, provider, tenant_id, added_by) VALUES ($1, 'microsoft', $2, 'seed')",
        [id, t],
      )
    }
    return id
  }
  async function makeUser(opts: { issuer?: string; tid?: string | null; emailVerified?: boolean | null; email?: string } = {}): Promise<string> {
    const id = rid('user')
    await realPool.query(
      `INSERT INTO users (id, issuer, subject, email, idp_tenant_id, email_verified)
       VALUES ($1, $2, $1, $3, $4, $5)`,
      [id, opts.issuer ?? ENTRA, opts.email ?? `${id}@example.com`, opts.tid ?? null, opts.emailVerified ?? null],
    )
    return id
  }
  async function addMember(orgId: string, userId: string, role: 'admin' | 'member' = 'member'): Promise<void> {
    await realPool.query('INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, userId, role])
  }
  async function mint(userId: string, orgId: string): Promise<'ok' | string> {
    try {
      await signCurrentSession(realPool, { userId, orgId, isPlatformAdmin: false })
      return 'ok'
    } catch (err) {
      return (err as { reason?: string }).reason ?? String(err)
    }
  }
  async function userEpoch(orgId: string, userId: string): Promise<number> {
    const { rows } = await realPool.query<{ epoch: string }>(
      'SELECT epoch FROM auth_user_epochs WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    )
    return rows[0] ? Number(rows[0].epoch) : 1
  }

  async function withServer<T>(
    register: (app: express.Express) => void,
    auth: { userId: string; orgId: string | null; isPlatformAdmin: boolean; epoch: number },
    run: (url: string) => Promise<T>,
  ): Promise<T> {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { req.auth = auth; next() })
    register(app)
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    try {
      return await run(`http://127.0.0.1:${port}`)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  const as = (userId: string, isPlatformAdmin = false) => ({ userId, orgId: null, isPlatformAdmin, epoch: 1 })
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  // ── migration ────────────────────────────────────────────────────────────

  describe('schema (ensureAuthSchema)', () => {
    it('creates the allowlist table, the org policy column (default false) and the identity columns', async () => {
      const { rows: cols } = await realPool.query<{ table_name: string; column_name: string; column_default: string | null }>(
        `SELECT table_name, column_name, column_default FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND (table_name = 'org_allowed_idp_tenants'
             OR (table_name = 'orgs' AND column_name = 'microsoft_personal_accounts_allowed')
             OR (table_name = 'users' AND column_name IN ('idp_tenant_id', 'email_verified')))`,
      )
      const names = cols.map((c) => `${c.table_name}.${c.column_name}`).sort()
      expect(names).toEqual([
        'org_allowed_idp_tenants.added_at',
        'org_allowed_idp_tenants.added_by',
        'org_allowed_idp_tenants.org_id',
        'org_allowed_idp_tenants.provider',
        'org_allowed_idp_tenants.tenant_id',
        'orgs.microsoft_personal_accounts_allowed',
        'users.email_verified',
        'users.idp_tenant_id',
      ])
      expect(cols.find((c) => c.column_name === 'microsoft_personal_accounts_allowed')?.column_default).toBe('false')
      const org = rid('org')
      await realPool.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)', [org])
      const { rows } = await realPool.query('SELECT microsoft_personal_accounts_allowed AS p FROM orgs WHERE id = $1', [org])
      expect(rows[0].p).toBe(false)
    })

    it('rejects a malformed tenant id or provider, and cascades on org delete', async () => {
      const org = await makeOrg({ tenants: [CORP] })
      await expect(realPool.query(
        "INSERT INTO org_allowed_idp_tenants (org_id, provider, tenant_id, added_by) VALUES ($1, 'microsoft', 'not-a-guid', 'x')",
        [org],
      )).rejects.toThrow(/check/i)
      await expect(realPool.query(
        "INSERT INTO org_allowed_idp_tenants (org_id, provider, tenant_id, added_by) VALUES ($1, 'google', $2, 'x')",
        [org, OTHER],
      )).rejects.toThrow(/check/i)
      await realPool.query('DELETE FROM orgs WHERE id = $1', [org])
      const { rows } = await realPool.query('SELECT 1 FROM org_allowed_idp_tenants WHERE org_id = $1', [org])
      expect(rows).toHaveLength(0)
    })
  })

  // ── the predicate, through the real session mint ─────────────────────────

  describe('signCurrentSession (every org-pinned session)', () => {
    it('admits a listed tenant, refuses an unlisted one', async () => {
      const org = await makeOrg({ tenants: [CORP] })
      const corp = await makeUser({ tid: CORP })
      const other = await makeUser({ tid: OTHER })
      await addMember(org, corp)
      await addMember(org, other)
      expect(await mint(corp, org)).toBe('ok')
      expect(await mint(other, org)).toBe('tenant_not_allowed')
    })

    it('refuses the personal-accounts tenant under a list unless the org policy allows it', async () => {
      const org = await makeOrg({ tenants: [CORP] })
      const msa = await makeUser({ tid: PERSONAL })
      await addMember(org, msa)
      expect(await mint(msa, org)).toBe('tenant_not_allowed')
      await realPool.query('UPDATE orgs SET microsoft_personal_accounts_allowed = true WHERE id = $1', [org])
      expect(await mint(msa, org)).toBe('ok')
    })

    it('an empty list keeps the pre-V0-02 behaviour; an unknown (NULL) tid is refused only by a list', async () => {
      const open = await makeOrg()
      const restricted = await makeOrg({ tenants: [CORP] })
      const msa = await makeUser({ tid: PERSONAL })
      const legacy = await makeUser({ tid: null })
      for (const u of [msa, legacy]) {
        await addMember(open, u)
        await addMember(restricted, u)
      }
      expect(await mint(msa, open)).toBe('ok')
      expect(await mint(legacy, open)).toBe('ok')
      expect(await mint(legacy, restricted)).toBe('tenant_not_allowed')
    })

    it('does not apply to non-Entra identities', async () => {
      const org = await makeOrg({ tenants: [CORP] })
      const google = await makeUser({ issuer: 'https://accounts.google.com/', tid: null })
      await addMember(org, google)
      expect(await mint(google, org)).toBe('ok')
    })

    it('resolveLoginOrg lands a multi-org user in an org that admits them, else tenant_not_allowed', async () => {
      const refuses = await makeOrg({ tenants: [CORP] })
      const admits = await makeOrg({ tenants: [OTHER] })
      const user = await makeUser({ tid: OTHER })
      await addMember(refuses, user)
      await addMember(admits, user)
      await realPool.query('UPDATE users SET last_org_id = $2 WHERE id = $1', [user, refuses])
      expect(await resolveLoginOrg(realPool, { id: user, email: 'x@example.com' }, { inviteIntent: false }))
        .toEqual({ kind: 'org', orgId: admits })
      await realPool.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [admits, user])
      expect(await resolveLoginOrg(realPool, { id: user, email: 'x@example.com' }, { inviteIntent: false }))
        .toEqual({ kind: 'tenant_not_allowed' })
    })
  })

  // ── membership read in the org NAMED BY THE REQUEST (session pinned elsewhere) ──

  describe('cross-org membership gates', () => {
    it('rbac_effective_access gives a refused org admin nothing in that org (sync + REST workspace gates)', async () => {
      const { upsertOrgScope } = await import('../rbac/schema.js')
      const org = await makeOrg({ tenants: [CORP] })
      const scope = await upsertOrgScope(realPool, org)
      const refused = await makeUser({ tid: OTHER })
      const admitted = await makeUser({ tid: CORP })
      await addMember(org, refused, 'admin')
      await addMember(org, admitted, 'admin')
      const access = async (u: string) =>
        (await realPool.query('SELECT can_read, can_write, via FROM rbac_effective_access($1, $2, $3)', [u, scope, '*'])).rows
      expect(await access(admitted)).toEqual([{ can_read: true, can_write: true, via: 'org-admin' }])
      expect(await access(refused)).toEqual([])
    })

    it('a refused org admin cannot use the org admin routes from a session pinned to another org', async () => {
      const org = await makeOrg({ tenants: [CORP] })
      const refused = await makeUser({ tid: OTHER })
      await addMember(org, refused, 'admin')
      const personal = await makeOrg()
      await addMember(personal, refused, 'admin')
      const res = await withServer(registerOrgTenantRoutes, { userId: refused, orgId: personal, isPlatformAdmin: false, epoch: 1 },
        async (url) => [
          await fetch(`${url}/api/orgs/${org}/idp-tenants`),
          // The B1 scenario: re-listing their own tenant to undo the policy.
          await fetch(`${url}/api/orgs/${org}/idp-tenants`, json('POST', { tenantId: OTHER })),
        ])
      expect(res.map((r) => r.status)).toEqual([403, 403])
      const { orgRoleIfAdmitted } = await import('./tenantPolicy.js')
      expect(await orgRoleIfAdmitted(realPool, org, refused)).toBeNull()
      expect(await orgRoleIfAdmitted(realPool, personal, refused)).toBe('admin')
    })

    it("an org-audience share refuses a member the org's policy refuses", async () => {
      const { checkShareAudienceAccess } = await import('../shares.js')
      const org = await makeOrg({ tenants: [CORP] })
      const refused = await makeUser({ tid: OTHER })
      const admitted = await makeUser({ tid: CORP })
      await addMember(org, refused)
      await addMember(org, admitted)
      const share = { audience: 'org' as const, orgId: org, allowedEmailDomain: null }
      expect(await checkShareAudienceAccess(realPool, share, { userId: admitted, isPlatformAdmin: false })).toBe('allow')
      expect(await checkShareAudienceAccess(realPool, share, { userId: refused, isPlatformAdmin: false })).toBe('forbidden')
    })

    it('an org-bound AI bearer token stops working once the org refuses its owner', async () => {
      const org = await makeOrg()
      const user = await makeUser({ tid: OTHER })
      await addMember(org, user)
      // Only the token lookup is stubbed; the live owner check
      // (loadLiveTokenOwner — pins, status, tenant) is the real one. Pins at
      // the current epochs (1), and the tenant row below is inserted directly,
      // bumping no epoch: what refuses is the live tenant check alone.
      vi.doMock('../ai/core/tokens.js', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../ai/core/tokens.js')>()),
        verifyAiToken: async () => ({
          userId: user, orgId: org, kind: 'pat', scopes: ['mcp'], tokenId: 't1',
          pins: { global: 1, org: 1, user: 1 },
        }),
      }))
      vi.resetModules()
      const { verifyBearerIdentity } = await import('../ai/core/identity.js')
      try {
        expect((await verifyBearerIdentity(realPool, 'bvr_x'))?.orgId).toBe(org)
        await realPool.query(
          "INSERT INTO org_allowed_idp_tenants (org_id, provider, tenant_id, added_by) VALUES ($1, 'microsoft', $2, 'seed')",
          [org, CORP],
        )
        expect(await verifyBearerIdentity(realPool, 'bvr_x')).toBeNull()
      } finally {
        vi.doUnmock('../ai/core/tokens.js')
      }
    })
  })

  // ── invite accept ────────────────────────────────────────────────────────

  describe('POST /api/auth/invite/:token/accept', () => {
    async function invite(orgId: string, email: string): Promise<string> {
      const token = randomBytes(16).toString('hex')
      await realPool.query(
        `INSERT INTO org_invites (id, org_id, email, role, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, 'member', $4, now() + interval '1 hour', 'inviter')`,
        [rid('inv'), orgId, email, createHash('sha256').update(token).digest('hex')],
      )
      return token
    }
    const isMember = async (orgId: string, userId: string) =>
      (await realPool.query('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, userId])).rows.length > 0

    it('refuses an unlisted tenant and grants no membership; admits a listed one', async () => {
      const org = await makeOrg({ tenants: [CORP] })
      const other = await makeUser({ tid: OTHER, emailVerified: true })
      const refusedToken = await invite(org, `${other}@example.com`)
      const refused = await withServer(registerInviteRoutes, as(other), (url) =>
        fetch(`${url}/api/auth/invite/${refusedToken}/accept`, { method: 'POST' }))
      expect(refused.status).toBe(403)
      expect(await refused.json()).toEqual({ error: 'tenant_not_allowed' })
      expect(await isMember(org, other)).toBe(false)

      const corp = await makeUser({ tid: CORP, emailVerified: true })
      const okToken = await invite(org, `${corp}@example.com`)
      const ok = await withServer(registerInviteRoutes, as(corp), (url) =>
        fetch(`${url}/api/auth/invite/${okToken}/accept`, { method: 'POST' }))
      expect(ok.status).toBe(200)
      expect(await isMember(org, corp)).toBe(true)
    })

    it('refuses a matching but unverified Microsoft email', async () => {
      const org = await makeOrg()
      const user = await makeUser({ tid: OTHER, emailVerified: false })
      const token = await invite(org, `${user}@example.com`)
      const res = await withServer(registerInviteRoutes, as(user), (url) =>
        fetch(`${url}/api/auth/invite/${token}/accept`, { method: 'POST' }))
      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe('email_unverified')
      expect(await isMember(org, user)).toBe(false)
    })
  })

  // ── org-admin routes ─────────────────────────────────────────────────────

  describe('org admin routes', () => {
    it('are org-admin only', async () => {
      const org = await makeOrg()
      const member = await makeUser({ issuer: 'dev' })
      await addMember(org, member)
      const outsider = await makeUser({ issuer: 'dev' })
      for (const userId of [member, outsider]) {
        const res = await withServer(registerOrgTenantRoutes, as(userId), async (url) => [
          await fetch(`${url}/api/orgs/${org}/idp-tenants`),
          await fetch(`${url}/api/orgs/${org}/idp-tenants`, json('POST', { tenantId: CORP })),
          await fetch(`${url}/api/orgs/${org}/idp-tenants/${CORP}`, json('DELETE')),
          await fetch(`${url}/api/orgs/${org}/idp-tenant-policy`, json('PATCH', { microsoftPersonalAccountsAllowed: true })),
        ])
        expect(res.map((r) => r.status)).toEqual([403, 403, 403, 403])
      }
      const { rows } = await realPool.query('SELECT 1 FROM org_allowed_idp_tenants WHERE org_id = $1', [org])
      expect(rows).toHaveLength(0)
    })

    it('list → add → remove → toggle, with the empty-list warning and audit rows', async () => {
      const org = await makeOrg()
      const admin = await makeUser({ issuer: 'dev' })
      await addMember(org, admin, 'admin')
      await withServer(registerOrgTenantRoutes, as(admin), async (url) => {
        const empty = await (await fetch(`${url}/api/orgs/${org}/idp-tenants`)).json()
        expect(empty).toEqual({ tenants: [], microsoftPersonalAccountsAllowed: false, warning: 'no_tenant_restriction' })

        const added = await fetch(`${url}/api/orgs/${org}/idp-tenants`, json('POST', { tenantId: ` ${CORP.toUpperCase()} ` }))
        expect(added.status).toBe(201)
        const addedBody = await added.json()
        expect(addedBody.tenants).toEqual([expect.objectContaining({ provider: 'microsoft', tenantId: CORP, addedBy: admin })])
        expect(addedBody.warning).toBeNull()

        const dup = await fetch(`${url}/api/orgs/${org}/idp-tenants`, json('POST', { tenantId: CORP }))
        expect(dup.status).toBe(409)
        expect((await dup.json()).error).toBe('already_allowed')

        const toggled = await fetch(`${url}/api/orgs/${org}/idp-tenant-policy`, json('PATCH', { microsoftPersonalAccountsAllowed: true }))
        expect((await toggled.json()).microsoftPersonalAccountsAllowed).toBe(true)

        const removed = await fetch(`${url}/api/orgs/${org}/idp-tenants/${CORP}`, json('DELETE'))
        expect(removed.status).toBe(200)
        expect((await removed.json()).warning).toBe('no_tenant_restriction')
        const missing = await fetch(`${url}/api/orgs/${org}/idp-tenants/${CORP}`, json('DELETE'))
        expect(missing.status).toBe(404)
      })
      const { rows } = await realPool.query<{ action: string }>(
        `SELECT action FROM audit_log WHERE org_id = $1 ORDER BY id`, [org],
      )
      expect(rows.map((r) => r.action)).toEqual([
        'org.idp_tenant_added', 'org.idp_tenant_policy_changed', 'org.idp_tenant_removed',
      ])
    })

    it('validates bodies with Zod and refuses the personal tenant as a list entry', async () => {
      const org = await makeOrg()
      const admin = await makeUser({ issuer: 'dev' })
      await addMember(org, admin, 'admin')
      await withServer(registerOrgTenantRoutes, as(admin), async (url) => {
        const bad = [
          await fetch(`${url}/api/orgs/${org}/idp-tenants`, json('POST', { tenantId: 'contoso.onmicrosoft.com' })),
          await fetch(`${url}/api/orgs/${org}/idp-tenants`, json('POST', { tenantId: CORP, extra: 1 })),
          await fetch(`${url}/api/orgs/${org}/idp-tenants`, json('POST', {})),
          await fetch(`${url}/api/orgs/${org}/idp-tenant-policy`, json('PATCH', { microsoftPersonalAccountsAllowed: 'yes' })),
          await fetch(`${url}/api/orgs/${org}/idp-tenants/not-a-guid`, json('DELETE')),
        ]
        expect(bad.map((r) => r.status)).toEqual([400, 400, 400, 400, 400])
        const personal = await fetch(`${url}/api/orgs/${org}/idp-tenants`, json('POST', { tenantId: PERSONAL }))
        expect(personal.status).toBe(400)
        expect((await personal.json()).error).toBe('personal_tenant_is_a_policy')
      })
      const { rows } = await realPool.query('SELECT 1 FROM org_allowed_idp_tenants WHERE org_id = $1', [org])
      expect(rows).toHaveLength(0)
    })

    it('refuses a change that would lock the acting org admin out (nothing written); a platform admin is exempt', async () => {
      const org = await makeOrg()
      const admin = await makeUser({ tid: OTHER })
      await addMember(org, admin, 'admin')
      const res = await withServer(registerOrgTenantRoutes, as(admin), (url) =>
        fetch(`${url}/api/orgs/${org}/idp-tenants`, json('POST', { tenantId: CORP })))
      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe('would_lock_out_self')
      const { rows } = await realPool.query('SELECT 1 FROM org_allowed_idp_tenants WHERE org_id = $1', [org])
      expect(rows).toHaveLength(0)

      const operator = await makeUser({ issuer: 'dev' })
      const byOperator = await withServer(registerOrgTenantRoutes, as(operator, true), (url) =>
        fetch(`${url}/api/orgs/${org}/idp-tenants`, json('POST', { tenantId: CORP })))
      expect(byOperator.status).toBe(201)
    })

    it('revokes exactly the members a change newly refuses (per-user epoch), nobody else', async () => {
      const org = await makeOrg()
      const admin = await makeUser({ tid: CORP })
      const colleague = await makeUser({ tid: CORP })
      const outsiderTenant = await makeUser({ tid: OTHER })
      const msa = await makeUser({ tid: PERSONAL })
      const google = await makeUser({ issuer: 'https://accounts.google.com/' })
      await addMember(org, admin, 'admin')
      for (const u of [colleague, outsiderTenant, msa, google]) await addMember(org, u)
      const before = await Promise.all([admin, colleague, outsiderTenant, msa, google].map((u) => userEpoch(org, u)))

      const added = await withServer(registerOrgTenantRoutes, as(admin), async (url) =>
        (await fetch(`${url}/api/orgs/${org}/idp-tenants`, json('POST', { tenantId: CORP }))).json())
      expect(added.revokedMembers).toBe(2)
      const after = await Promise.all([admin, colleague, outsiderTenant, msa, google].map((u) => userEpoch(org, u)))
      expect(after.map((e, i) => e - before[i])).toEqual([0, 0, 1, 1, 0])
      expect(await mint(outsiderTenant, org)).toBe('tenant_not_allowed')
      expect(await mint(colleague, org)).toBe('ok')

      // Allowing personal accounts revokes nobody; disallowing again revokes the MSA once more.
      const allow = await withServer(registerOrgTenantRoutes, as(admin), async (url) =>
        (await fetch(`${url}/api/orgs/${org}/idp-tenant-policy`, json('PATCH', { microsoftPersonalAccountsAllowed: true }))).json())
      expect(allow.revokedMembers).toBe(0)
      const deny = await withServer(registerOrgTenantRoutes, as(admin), async (url) =>
        (await fetch(`${url}/api/orgs/${org}/idp-tenant-policy`, json('PATCH', { microsoftPersonalAccountsAllowed: false }))).json())
      expect(deny.revokedMembers).toBe(1)
      expect(await userEpoch(org, msa)).toBe(after[3] + 1)
    })
  })
})
