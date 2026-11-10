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

import { createRequire } from 'node:module'
import path from 'node:path'
import { test, expect, request as pwRequest, type APIRequestContext, type APIResponse } from '@playwright/test'

/**
 * V0-16 — authentication, org administration and permissions in a REAL browser
 * against a REAL AUTH=on server (docs/auth-setup.md). Runs in the
 * `chromium-auth` project:
 *
 *   E2E_AUTH_BASE_URL=http://localhost:<vite port> \
 *   E2E_AUTH_PLATFORM_EMAIL=<PLATFORM_ADMIN_BOOTSTRAP_EMAIL of the stack> \
 *   E2E_AUTH_DATABASE_URL=postgres://user:pw@localhost:<pg port>/<db> \
 *   npx playwright test --project=chromium-auth e2e/auth-admin-permissions.spec.ts
 *
 * Stack requirements (server env): AUTH=on AUTH_DEV_LOGIN=on
 * AUTH_PASSWORD_LOGIN=on AUTH_SECRET=… EMAIL_PROVIDER=local (the password
 * account is confirmed through the local outbox) READ_MODEL=on AM_SELECTIVE_SYNC=on,
 * and Vite proxying `/api` to that server. Optional pieces SKIP their own
 * case, with the reason, when absent:
 *
 *   - the whole file         : /api/auth/config must report stage=on, devLogin,
 *                              passwordLogin.
 *   - suspended org          : E2E_AUTH_PLATFORM_EMAIL must be a dev-login
 *                              identity that is (or is bootstrapped into) a
 *                              platform admin — on a database that already
 *                              has a platform admin, pass that admin's email.
 *   - Entra tenant allowlist : E2E_AUTH_DATABASE_URL (the stack's Postgres);
 *                              the spec writes `users.issuer/idp_tenant_id`
 *                              directly, see the case's own comment.
 *
 * Case 1a spends 4 password-login attempts and 1 registration of the per-IP
 * budget (20 and 8 per 15 minutes, passwordAuth.ts): re-running it more than
 * ~4 times in a quarter of an hour against one server process answers 429 —
 * restart the server (in-memory limiter) or wait.
 *
 * Every account is created by the spec (unique `e2e-v016-<run>-…` emails); no
 * real credential is used.
 *
 * OIDC SIMULATION. A real Google/Entra callback cannot run offline. The least
 * invasive stand-in that already exists is `POST /api/auth/dev-login`
 * (devLogin.ts): it runs the SAME `resolveLoginOrg` + `signCurrentSession`
 * path the OIDC callback runs (provisioning.ts, sessionEpoch.ts) and sets the
 * same session cookie, only the identity proof differs (issuer `dev`). The
 * Microsoft-specific part — a recorded `idp_tenant_id` on an Entra-issuer
 * identity — is seeded in the database (case 5).
 */

const BASE_URL = process.env.E2E_AUTH_BASE_URL ?? 'http://localhost:5174'
const PLATFORM_EMAIL = process.env.E2E_AUTH_PLATFORM_EMAIL
const DATABASE_URL = process.env.E2E_AUTH_DATABASE_URL
const RUN = Date.now().toString(36)
const LEGAL_VERSION = '2026-08-02' // ignored unless the stack sets AUTH_LEGAL_ACCEPTANCE=on

const ENTRA_ISSUER = 'https://login.microsoftonline.com/common/v2.0'
const TENANT_ALLOWED = '11111111-2222-4333-8444-555555555555'
const TENANT_OTHER = '99999999-8888-4777-8666-555555555555'

test.use({ channel: process.env.PW_BROWSER_CHANNEL || undefined })

let emailSeq = 0
const email = (label: string) => `e2e-v016-${RUN}-${label}-${++emailSeq}@example.com`

interface Session {
  api: APIRequestContext
  email: string
  userId: string
  orgId: string | null
  isPlatformAdmin: boolean
}

const opened: APIRequestContext[] = []

async function newApi(): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({ baseURL: BASE_URL })
  opened.push(api)
  return api
}

async function text(res: APIResponse): Promise<string> {
  return `${res.status()} ${res.url()} ${await res.text().catch(() => '')}`
}

async function devLogin(addr: string, intent?: 'invite'): Promise<Session> {
  const api = await newApi()
  const res = await api.post('/api/auth/dev-login', { data: { email: addr, ...(intent ? { intent } : {}) } })
  expect(res.status(), await text(res)).toBe(200)
  const body = (await res.json()) as { user: { id: string; isPlatformAdmin: boolean }; orgId: string | null }
  return { api, email: addr, userId: body.user.id, orgId: body.orgId, isPlatformAdmin: body.user.isPlatformAdmin }
}

/** A brand-new dev identity: auto-provisioned a personal org it administers. */
async function newAdmin(label: string): Promise<Session & { orgId: string; landscapeId: string; versionId: string }> {
  const s = await devLogin(email(label))
  expect(s.orgId, 'a first login provisions a personal org').toBeTruthy()
  const res = await s.api.get('/api/landscapes')
  expect(res.status(), await text(res)).toBe(200)
  const { landscapes } = (await res.json()) as { landscapes: Array<{ id: string; versions: Array<{ id: string }> }> }
  return { ...s, orgId: s.orgId!, landscapeId: landscapes[0].id, versionId: landscapes[0].versions[0].id }
}

/** Invite `addr` as a plain member (optionally into teams) and accept as them. */
async function addMember(admin: Session & { orgId: string }, addr: string, teamIds: string[] = []): Promise<Session> {
  const inv = await admin.api.post(`/api/orgs/${admin.orgId}/invites`, { data: { email: addr, role: 'member', teamIds } })
  expect(inv.status(), await text(inv)).toBe(201)
  const { acceptUrl } = (await inv.json()) as { acceptUrl: string }
  return acceptInvite(acceptUrl, addr)
}

async function acceptInvite(acceptUrl: string, addr: string): Promise<Session> {
  const token = new URL(acceptUrl).pathname.split('/').pop()!
  const member = await devLogin(addr, 'invite')
  const acc = await member.api.post(`/api/auth/invite/${token}/accept`)
  expect(acc.status(), await text(acc)).toBe(200)
  const body = (await acc.json()) as { orgId: string }
  return { ...member, orgId: body.orgId }
}

/** A member whose only access is a READ-ONLY grant on the admin's landscape. */
async function addReader(admin: Session & { orgId: string }, addr: string): Promise<Session> {
  const team = await admin.api.post(`/api/orgs/${admin.orgId}/teams`, { data: { name: `Readers ${RUN}-${++emailSeq}` } })
  expect(team.status(), await text(team)).toBeLessThan(300)
  const { id: teamId } = (await team.json()) as { id: string }
  const matrix = await admin.api.get(`/api/orgs/${admin.orgId}/access`)
  const { scopes } = (await matrix.json()) as { scopes: Array<{ id: string; kind: string }> }
  const landscapeScope = scopes.find((s) => s.kind === 'landscape')
  expect(landscapeScope, 'the personal org has a landscape scope').toBeTruthy()
  const grant = await admin.api.put(`/api/orgs/${admin.orgId}/access`, {
    data: { changes: [{ teamId, scopeId: landscapeScope!.id, resourceType: '*', canRead: true, canWrite: false, expectedUpdatedAt: null }] },
  })
  expect(grant.status(), await text(grant)).toBe(200)
  return addMember(admin, addr, [teamId])
}

/** GET that waits out the read model's cold build of a freshly provisioned workspace (retryable 503). */
async function readStatus(api: APIRequestContext, url: string, headers?: Record<string, string>): Promise<APIResponse> {
  let last = await api.get(url, { headers })
  for (let i = 0; i < 60 && last.status() === 503; i++) {
    await new Promise((r) => setTimeout(r, 1_000))
    last = await api.get(url, { headers })
  }
  return last
}

const modelQuery = (a: { landscapeId: string; versionId: string }) =>
  `/api/model/objects/search?q=&landscapeId=${a.landscapeId}&versionId=${a.versionId}`

// ── optional DB access (case 5 only) ─────────────────────────────────────────
interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  end(): Promise<void>
}
async function openDb(): Promise<Db> {
  // `pg` is a dependency of server/, not of the root package.
  const serverRequire = createRequire(path.resolve(process.cwd(), 'server', 'package.json'))
  const { Pool } = serverRequire('pg') as { Pool: new (cfg: { connectionString: string }) => Db }
  return new Pool({ connectionString: DATABASE_URL! })
}

let skipReason: string | null = null

test.describe('auth, org administration and permissions (AUTH=on)', () => {
  test.beforeAll(async () => {
    const probe = await pwRequest.newContext({ baseURL: BASE_URL })
    try {
      const res = await probe.get('/api/auth/config')
      const cfg = res.ok() ? ((await res.json()) as { stage?: string; devLogin?: boolean; passwordLogin?: boolean }) : null
      if (!cfg) skipReason = `no auth config reachable at ${BASE_URL}/api/auth/config (is the stack up and Vite proxying /api?)`
      else if (cfg.stage !== 'on' || !cfg.devLogin || !cfg.passwordLogin) {
        skipReason = `needs AUTH=on + AUTH_DEV_LOGIN=on + AUTH_PASSWORD_LOGIN=on (got ${JSON.stringify(cfg)})`
      }
    } catch (err) {
      skipReason = `stack unreachable at ${BASE_URL}: ${String(err)}`
    } finally {
      await probe.dispose()
    }
  })
  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? '')
  })
  test.afterAll(async () => {
    await Promise.all(opened.splice(0).map((c) => c.dispose().catch(() => undefined)))
  })

  // ── 1 ──────────────────────────────────────────────────────────────────────
  test('1a. local password login works through the real login page (and refuses the unconfirmed and the wrong password)', async ({ page, request }) => {
    const addr = email('local')
    const password = `Pw-${RUN}-e2e-Zx9!`
    const reg = await request.post('/api/auth/register', { data: { email: addr, password, legalVersion: LEGAL_VERSION } })
    expect(reg.status(), await text(reg)).toBe(202)

    // Unconfirmed address: refused even with the right password.
    const early = await request.post('/api/auth/password-login', { data: { email: addr, password, legalVersion: LEGAL_VERSION } })
    expect(early.status(), await text(early)).toBe(403)
    expect(((await early.json()) as { code: string }).code).toBe('email_not_verified')

    // Confirm through the local outbox, exactly like a user opening the mail.
    let verifyToken: string | null = null
    await expect.poll(async () => {
      const list = (await (await request.get('/api/dev/outbox')).json()) as Array<{ id: string; to: string }>
      const mail = list.find((m) => m.to === addr)
      if (!mail) return null
      const html = await (await request.get(`/api/dev/outbox/${mail.id}`)).text()
      verifyToken = /verify-email\?token=([A-Za-z0-9_%-]+)/.exec(html)?.[1] ?? null
      return verifyToken
    }, { message: 'the confirmation mail reaches the local outbox' }).not.toBeNull()
    const verified = await request.get(`/api/auth/verify-email?token=${verifyToken}`, { maxRedirects: 0 })
    expect(verified.status()).toBe(303)

    // Wrong password: refused, no session.
    const wrong = await request.post('/api/auth/password-login', { data: { email: addr, password: `${password}x`, legalVersion: LEGAL_VERSION } })
    expect(wrong.status(), await text(wrong)).toBe(401)

    // The real form.
    await page.goto('/login')
    await page.getByTestId('password-login-email').fill(addr)
    await page.getByTestId('password-login-password').fill(password)
    const legal = page.getByTestId('legal-acceptance')
    if (await legal.isVisible().catch(() => false)) await legal.check()
    await page.getByTestId('password-login-submit').click()
    await page.waitForURL(/\/app/, { timeout: 60_000 })

    // page.request shares the context's cookies and, unlike page.evaluate, survives the hard navigation.
    const meRes = await page.request.get('/api/auth/me')
    const me = meRes.ok() ? ((await meRes.json()) as { user: { email: string; identity: { issuer: string } } }) : null
    expect(me?.user.email).toBe(addr)
    expect(me?.user.identity.issuer).toBe('local')
  })

  test('1b. simulated OIDC (dev-login: same org resolution and session mint as the OIDC callback) signs in through the login page', async ({ page }) => {
    const addr = email('oidc-sim')
    await page.goto('/login')
    await page.getByTestId('dev-login-email').fill(addr)
    const legal = page.getByTestId('legal-acceptance')
    if (await legal.isVisible().catch(() => false)) await legal.check()
    await page.getByTestId('dev-login-submit').click()
    await page.waitForURL(/\/app/, { timeout: 60_000 })
    const meRes = await page.request.get('/api/auth/me')
    const me = meRes.ok() ? ((await meRes.json()) as { claims: { orgId: string | null }; user: { email: string } }) : null
    expect(me?.user.email).toBe(addr)
    expect(me?.claims.orgId, 'a first sign-in is pinned to its freshly provisioned personal org').toBeTruthy()
  })

  // ── 2 ──────────────────────────────────────────────────────────────────────
  test('2. a reader sees no write actions and is refused (403) on a direct API write', async ({ browser }) => {
    const admin = await newAdmin('rd-admin')
    const readerAddr = email('reader')
    const reader = await addReader(admin, readerAddr)

    // API: the reader reads, but a direct write is refused; the admin's same call is the control.
    expect((await readStatus(reader.api, modelQuery(admin))).status()).toBe(200)
    const denied = await reader.api.patch(`/api/landscapes/${admin.landscapeId}`, { data: { name: 'reader-rename' } })
    expect(denied.status(), await text(denied)).toBe(403)
    const deniedVersion = await reader.api.post(`/api/landscapes/${admin.landscapeId}/versions`, { data: { label: 'reader-version' } })
    expect(deniedVersion.status(), await text(deniedVersion)).toBe(403)
    const allowed = await admin.api.patch(`/api/landscapes/${admin.landscapeId}`, { data: { name: 'admin-rename' } })
    expect(allowed.status(), await text(allowed)).toBe(200)

    // UI: same workspace, two sessions.
    const open = async (addr: string) => {
      const context = await browser.newContext({ baseURL: BASE_URL, locale: 'en-US' })
      const res = await context.request.post('/api/auth/dev-login', { data: { email: addr } })
      expect(res.status(), await text(res)).toBe(200)
      const page = await context.newPage()
      await page.goto('/app')
      await page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+/, { timeout: 90_000 })
      await expect(page.getByTestId('canvas-2d')).toBeVisible({ timeout: 60_000 })
      return { context, page }
    }
    const asReader = await open(readerAddr)
    try {
      await expect(asReader.page.getByTestId('add-shape-button')).toBeDisabled()
      await expect(asReader.page.getByTestId('add-shape')).toHaveCount(0)
      await expect(asReader.page.getByTestId('auto-layout')).toHaveCount(0)
    } finally {
      await asReader.context.close()
    }
    const asAdmin = await open(admin.email)
    try {
      await expect(asAdmin.page.getByTestId('add-shape-button')).toBeEnabled()
      await expect(asAdmin.page.getByTestId('add-shape')).toBeVisible()
      await expect(asAdmin.page.getByTestId('auto-layout')).toBeVisible()
    } finally {
      await asAdmin.context.close()
    }
  })

  // ── 3 ──────────────────────────────────────────────────────────────────────
  test('3. an org admin invites, changes a role and removes a member through the admin console', async ({ browser }) => {
    const admin = await newAdmin('mem-admin')
    const inviteeAddr = email('invitee')

    const context = await browser.newContext({ baseURL: BASE_URL, locale: 'en-US' })
    try {
      expect((await context.request.post('/api/auth/dev-login', { data: { email: admin.email } })).status()).toBe(200)
      const page = await context.newPage()
      await page.goto(`/org/${admin.orgId}/admin/members`)
      await expect(page.getByTestId('admin-members')).toBeVisible({ timeout: 60_000 })

      // Invite.
      await page.getByTestId('invite-open').click()
      await page.getByTestId('invite-email').fill(inviteeAddr)
      await page.getByTestId('invite-submit').click()
      const acceptUrl = await page.getByTestId('invite-accept-url').inputValue()
      const invitee = await acceptInvite(acceptUrl, inviteeAddr)
      await page.reload()
      const row = page.getByTestId('member-row').filter({ hasText: inviteeAddr })
      await expect(row).toHaveCount(1)

      // A plain member cannot administer the org; after promotion it can.
      expect((await invitee.api.get(`/api/orgs/${admin.orgId}/members`)).status()).toBe(403)
      await row.getByTestId('member-role-select').selectOption('admin')
      await expect(row.getByTestId('member-role-select')).toHaveValue('admin')
      await expect.poll(async () => (await invitee.api.get(`/api/orgs/${admin.orgId}/members`)).status()).toBe(200)

      // Remove (typed confirmation of the address).
      await row.getByTestId('member-remove').click()
      await page.getByTestId('member-remove-confirm-input').fill(inviteeAddr)
      await page.getByTestId('member-remove-confirm-submit').click()
      await expect(page.getByTestId('member-row').filter({ hasText: inviteeAddr })).toHaveCount(0)

      const members = (await (await admin.api.get(`/api/orgs/${admin.orgId}/members`)).json()) as { members: Array<{ email: string }> }
      expect(members.members.map((m) => m.email)).not.toContain(inviteeAddr)
      // ...and the removed member has lost the org.
      // Removal bumps the member's epoch: the old session is cut off outright (401), or at least refused (403).
      const gone = await invitee.api.get(`/api/orgs/${admin.orgId}/members`)
      expect([401, 403], await text(gone)).toContain(gone.status())
      const relogin = await devLogin(inviteeAddr)
      const orgs = (await (await relogin.api.get('/api/me/orgs')).json()) as { orgs: Array<{ id: string }> }
      expect(orgs.orgs.map((o) => o.id)).not.toContain(admin.orgId)
    } finally {
      await context.close()
    }
  })

  // ── 4 ──────────────────────────────────────────────────────────────────────
  test('4. the admin of a suspended org is refused, and recovers when it is reinstated', async ({ page }) => {
    test.skip(!PLATFORM_EMAIL, 'set E2E_AUTH_PLATFORM_EMAIL to a platform-admin dev-login identity')
    const platform = await devLogin(PLATFORM_EMAIL!)
    test.skip(!platform.isPlatformAdmin, `${PLATFORM_EMAIL} is not a platform admin on this stack (bootstrap email or an existing admin is required)`)

    const admin = await newAdmin('susp-admin')
    expect((await admin.api.get(`/api/orgs/${admin.orgId}/members`)).status()).toBe(200)

    const setStatus = (status: 'active' | 'suspended') =>
      platform.api.patch(`/api/platform/orgs/${admin.orgId}`, { data: { status } })
    try {
      const suspended = await setStatus('suspended')
      expect(suspended.status(), await text(suspended)).toBe(200)

      // The live session is cut off...
      const stale = await admin.api.get(`/api/orgs/${admin.orgId}/members`)
      expect([401, 403], await text(stale)).toContain(stale.status())
      // ...and a fresh sign-in is refused.
      const again = await (await newApi()).post('/api/auth/dev-login', { data: { email: admin.email } })
      expect(again.status(), await text(again)).toBe(403)
      expect(((await again.json()) as { error: string }).error).toBe('org_suspended')

      // Through the real login page too: the form shows an error and never reaches /app.
      await page.goto('/login')
      await page.getByTestId('dev-login-email').fill(admin.email)
      const legal = page.getByTestId('legal-acceptance')
      if (await legal.isVisible().catch(() => false)) await legal.check()
      const attempt = page.waitForResponse((r) => r.url().includes('/api/auth/dev-login'))
      await page.getByTestId('dev-login-submit').click()
      expect((await attempt).status()).toBe(403)
      // The page stays on the form (it shows a generic error, without a testid) and holds no session.
      await expect(page.getByTestId('dev-login-submit')).toBeEnabled()
      expect(page.url()).not.toMatch(/\/app/)
      expect((await page.request.get('/api/auth/me')).status()).toBe(401)
    } finally {
      expect((await setStatus('active')).status()).toBe(200)
    }
    const back = await (await newApi()).post('/api/auth/dev-login', { data: { email: admin.email } })
    expect(back.status(), await text(back)).toBe(200)
  })

  // ── 5 ──────────────────────────────────────────────────────────────────────
  // A real Entra callback cannot run offline, so the Microsoft identity is
  // seeded: an ordinary member signs in (dev-login) and is then re-labelled in
  // the database as an Entra-issuer identity with a recorded `idp_tenant_id`.
  // What is exercised for real is the org's decision (tenantPolicy.ts,
  // `rbac_effective_access`), evaluated live on every workspace read.
  test('5. a Microsoft identity whose recorded tenant is not on the org allowlist is refused', async () => {
    test.skip(!DATABASE_URL, 'set E2E_AUTH_DATABASE_URL to the stack Postgres to seed idp_tenant_id')
    const admin = await newAdmin('tenant-admin')
    // One member per outcome, each re-labelled BEFORE its first workspace read:
    // the allowed-keys decision is cached for up to 30 s per (user, org, epoch)
    // (docScope.ts ALLOWED_KEYS_TTL_MS), and a direct UPDATE — unlike the
    // org-admin routes — bumps no epoch, so a read made before the re-label
    // would keep answering from the cache.
    const members = {
      other: await addReader(admin, email('tenant-other')),
      allowed: await addReader(admin, email('tenant-allowed')),
      unknown: await addReader(admin, email('tenant-unknown')),
    }
    const add = await admin.api.post(`/api/orgs/${admin.orgId}/idp-tenants`, { data: { tenantId: TENANT_ALLOWED } })
    expect(add.status(), await text(add)).toBe(201)

    const db = await openDb()
    try {
      const relabel = (userId: string, tenant: string | null) =>
        db.query('UPDATE users SET issuer = $2, idp_tenant_id = $3, email_verified = true WHERE id = $1', [userId, ENTRA_ISSUER, tenant])
      await relabel(members.other.userId, TENANT_OTHER)
      await relabel(members.allowed.userId, TENANT_ALLOWED)
      await relabel(members.unknown.userId, null)

      // Not on the list: the workspace is refused, so is a write.
      const refused = await members.other.api.get(modelQuery(admin))
      expect(refused.status(), await text(refused)).toBe(403)
      const refusedWrite = await members.other.api.patch(`/api/landscapes/${admin.landscapeId}`, { data: { name: 'tenant-rename' } })
      expect(refusedWrite.status(), await text(refusedWrite)).toBe(403)

      // Tenant not recorded yet (signed in before V0-02): refused under a non-empty list.
      const unknown = await members.unknown.api.get(modelQuery(admin))
      expect(unknown.status(), await text(unknown)).toBe(403)

      // Control: the listed tenant, same grant, is admitted — the list does not just block everyone.
      const admitted = await readStatus(members.allowed.api, modelQuery(admin))
      expect(admitted.status(), await text(admitted)).toBe(200)
    } finally {
      await db.end()
    }
  })

  // ── 6 ──────────────────────────────────────────────────────────────────────
  test('6a. a default (mcp) PAT is refused on a non-AI REST route and accepted on /api/ai/tools', async () => {
    const admin = await newAdmin('pat-mcp')
    const mint = await admin.api.post('/api/me/ai-tokens', { data: { name: `e2e mcp ${RUN}` } })
    expect(mint.status(), await text(mint)).toBe(200)
    const { token } = (await mint.json()) as { token: string }
    const bearer = { Authorization: `Bearer ${token}` }
    const bare = await pwRequest.newContext({ baseURL: BASE_URL })
    opened.push(bare)

    const landscapes = await bare.get('/api/landscapes', { headers: bearer })
    expect(landscapes.status(), await text(landscapes)).toBe(403)
    expect(((await landscapes.json()) as { error: string }).error).toBe('insufficient_scope')
    const tools = await bare.get('/api/ai/tools', { headers: bearer })
    expect(tools.status(), (await tools.text()).slice(0, 200)).toBe(200)
    // No cookie leaked into the bare context: the same call without the token is refused.
    expect((await bare.get('/api/ai/tools')).status()).toBe(401)
  })

  test('6b. a model:read PAT reads /api/model/* but cannot write', async () => {
    const admin = await newAdmin('pat-read')
    const mint = await admin.api.post('/api/me/ai-tokens', { data: { name: `e2e model:read ${RUN}`, scopes: ['model:read'] } })
    expect(mint.status(), await text(mint)).toBe(200)
    const { token } = (await mint.json()) as { token: string }
    const bearer = { Authorization: `Bearer ${token}` }
    const bare = await pwRequest.newContext({ baseURL: BASE_URL })
    opened.push(bare)

    const read = await readStatus(bare, modelQuery(admin), bearer)
    expect(read.status(), await text(read)).toBe(200)
    const list = await bare.get('/api/landscapes', { headers: bearer })
    expect(list.status(), (await list.text()).slice(0, 200)).toBe(200)

    const rename = await bare.patch(`/api/landscapes/${admin.landscapeId}`, { headers: bearer, data: { name: 'pat-rename' } })
    expect(rename.status(), await text(rename)).toBe(403)
    expect(((await rename.json()) as { error: string }).error).toBe('insufficient_scope')
    const witness = await bare.post('/api/model/durability-witness', { headers: bearer, data: {} })
    expect(witness.status(), await text(witness)).toBe(403)
    expect(((await witness.json()) as { error: string }).error).toBe('insufficient_scope')
    // The write really did not happen.
    const after = (await (await admin.api.get('/api/landscapes')).json()) as { landscapes: Array<{ id: string; name: string }> }
    expect(after.landscapes.find((l) => l.id === admin.landscapeId)?.name).not.toBe('pat-rename')

    // A token never mints its successor.
    const chain = await bare.post('/api/me/ai-tokens', { headers: bearer, data: { name: 'child' } })
    expect(chain.status(), await text(chain)).toBe(403)
  })
})
