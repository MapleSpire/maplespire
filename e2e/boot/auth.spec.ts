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

import { test, expect } from '@playwright/test'

// Auth flow against an AUTH=dual stack: real login page → dev login →
// account badge → invite create (via API) → sign out →
// second user accepts the invite through the REAL /invite/:token page.
//
// Self-gating: on a stack without auth configured (stage 'off' — every legacy
// stack/e2e run) the whole file SKIPS, so the suite stays green everywhere.
// Start a compatible stack with: AUTH=dual AUTH_DEV_LOGIN=on AUTH_SECRET=...
// EMAIL_PROVIDER=local APP_URL=<vite origin> (see docs/auth-setup.md).

/* eslint-disable @typescript-eslint/no-explicit-any */

const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3002'

test.describe('auth — dev login, account badge, invite accept', () => {
  test('login → badge → invite → sign out → second user accepts', async ({ page, request }) => {
    const cfg = await (await request.get(`${API_BASE}/api/auth/config`)).json()
    test.skip(cfg.stage !== 'dual' || !cfg.devLogin, 'needs an AUTH=dual + AUTH_DEV_LOGIN=on stack')

    const run = Date.now().toString(36)
    // On a FRESH auth DB the first dev-login becomes the default org's admin, so
    // the generated address works. On a REUSED DB someone else already claimed
    // first-member-admin — pass E2E_AUTH_ADMIN_EMAIL (any org-admin/platform-admin
    // dev identity, e.g. the PLATFORM_ADMIN_BOOTSTRAP_EMAIL) to keep the invite
    // half of the test running instead of skipping.
    const adminEmail = process.env.E2E_AUTH_ADMIN_EMAIL ?? `e2e-admin-${run}@example.com`
    const inviteeEmail = `e2e-invitee-${run}@example.com`

    // ── real login page → dev login ──
    await page.goto('/login')
    await page.getByTestId('dev-login-email').fill(adminEmail)
    await page.getByTestId('dev-login-submit').click()
    await page.waitForURL(/\/app/, { timeout: 30_000 })

    // ── session is live: the account badge renders and knows who we are ──
    await expect(page.getByTestId('account-badge')).toBeVisible({ timeout: 15_000 })
    const me = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/auth/me`, { credentials: 'include' })
      return r.ok ? r.json() : null
    }, API_BASE)
    expect(me?.user?.email).toBe(adminEmail)
    const orgId = me.claims.orgId as string

    // ── create an invite (via API with the browser's session cookie; the
    //    EMAIL lands in the local outbox) ──
    // NOTE: dev-login users join the default org as 'member' after the first user;
    // invite creation requires admin/platform-admin. The FIRST dev-login of a fresh
    // DB is the admin; on a reused DB this test's user may be a plain member, so a
    // 403 here skips rather than fails (the invite ACCEPT path is what we pin).
    const inviteRes = await page.evaluate(
      async ({ base, orgId, email }) => {
        const r = await fetch(`${base}/api/orgs/${orgId}/invites`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, role: 'member' }),
        })
        return { status: r.status, body: r.ok ? await r.json() : null }
      },
      { base: API_BASE, orgId, email: inviteeEmail }
    )
    test.skip(inviteRes.status === 403, 'session user is not an org admin on this reused DB')
    expect(inviteRes.status).toBe(201)
    const acceptPath = new URL(inviteRes.body.acceptUrl).pathname
    // The invite email reached the local outbox.
    const outbox = await (await request.get(`${API_BASE}/api/dev/outbox`)).json()
    expect(outbox.some((m: any) => m.to === inviteeEmail)).toBe(true)

    // ── sign out through the badge ──
    await page.getByTestId('account-badge').click()
    await page.getByTestId('account-signout').click()
    await page.waitForFunction(
      async (base) => (await fetch(`${base}/api/auth/me`, { credentials: 'include' })).status === 401,
      API_BASE,
      { timeout: 15_000 }
    )

    // ── second user: invite page asks to sign in, then accepting grants membership ──
    await page.goto(acceptPath)
    await expect(page.getByText(/sign in/i).first()).toBeVisible({ timeout: 15_000 })
    await page.goto('/login')
    await page.getByTestId('dev-login-email').fill(inviteeEmail)
    await page.getByTestId('dev-login-submit').click()
    await page.waitForURL(/\/app|\/invite\//, { timeout: 30_000 })
    await page.goto(acceptPath)
    await page.getByTestId('invite-accept').click()
    await page.waitForURL(/\/app/, { timeout: 30_000 })
    const me2 = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/auth/me`, { credentials: 'include' })
      return r.ok ? r.json() : null
    }, API_BASE)
    expect(me2?.user?.email).toBe(inviteeEmail)
    expect(me2?.claims?.orgId).toBe(orgId)
  })
})
