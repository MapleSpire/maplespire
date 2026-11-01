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

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect, type Page, type Browser } from '@playwright/test'
import { addCanvasComment } from './helpers'
import { submitDevLogin } from '../support/devLogin'

// Regression (2026-10-16): accepting an org invite revoked every live session
// in the org, the inviter's included. The membership insert's trigger bumped
// the org's auth epoch; the inviter's socket was closed as "revoked", every
// reconnect was refused at the upgrade, and the page said nothing — edits
// stopped syncing silently and a reload hung with no current diagram.
//
// Three tests:
//  1. an ADDITION (invite accepted) no longer revokes anybody;
//  2. a real revocation (an admin demoted) is VISIBLE on the revoked live
//     page — a "session ended" banner whose button leads back through sign-in
//     to the same diagram — and revokes ONLY the demoted user: the admin who
//     did it keeps working (it used to sign the whole org out);
//  3. a page OPENED on a revoked cookie lands on sign-in saying why. (Measured
//     before the fix: that reload already reached /login in ~3 s — the
//     reported "45 s hang" was a spec waiting for a canvas on the login page —
//     but the page gave no reason.)
//
// Self-gating like auth.spec.ts: needs AUTH=on + AUTH_DEV_LOGIN=on (only stage
// 'on' enforces the epoch); skips everywhere else.

const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3002'

async function devLogin(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await expect(page.getByTestId('dev-login-email')).toBeVisible({ timeout: 15_000 })
  await submitDevLogin(page, email)
  await page.waitForURL(/\/app|\/invite\//, { timeout: 30_000 })
}

async function waitForDiagram(page: Page): Promise<string> {
  await page.waitForFunction(
    () => {
      const s = (window as any).__modelStore?.getState?.()
      return !!s?.currentDiagramId && !!(window as any).__canvasEngine
    },
    undefined,
    { timeout: 45_000 }
  )
  return page.evaluate(() => (window as any).__modelStore.getState().currentDiagramId as string)
}

/** Owner signs in (first login provisions an org with a starter diagram), invites
 * `guestEmail` as an admin, and the guest accepts through the real invite page.
 * The owner does NOT sign in again afterwards — that is the point. */
async function ownerInvitesGuest(browser: Browser, run: string) {
  const ownerEmail = `owner-${run}@example.com`
  const guestEmail = `guest-${run}@example.com`
  const ownerCtx = await browser.newContext()
  const guestCtx = await browser.newContext()
  const owner = await ownerCtx.newPage()
  const guest = await guestCtx.newPage()

  await devLogin(owner, ownerEmail)
  const diagramId = await waitForDiagram(owner)
  const invite = await owner.evaluate(
    async ({ base, email }) => {
      const me = await (await fetch(`${base}/api/auth/me`, { credentials: 'include' })).json()
      const r = await fetch(`${base}/api/orgs/${me.claims.orgId}/invites`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: 'admin' }),
      })
      return {
        status: r.status,
        body: r.ok ? await r.json() : null,
        orgId: me.claims.orgId as string,
        ownerId: me.user.id as string,
      }
    },
    { base: API_BASE, email: guestEmail }
  )
  expect(invite.status).toBe(201)

  await devLogin(guest, guestEmail)
  await guest.goto(new URL(invite.body.acceptUrl).pathname)
  await guest.getByTestId('invite-accept').click()
  await guest.waitForURL(/\/app/, { timeout: 30_000 })

  return { owner, guest, ownerCtx, guestCtx, ownerEmail, guestEmail, diagramId, orgId: invite.orgId, ownerId: invite.ownerId }
}

test.describe('session epoch — invites and revocation', () => {
  test.beforeEach(async ({ request }) => {
    const cfg = await (await request.get(`${API_BASE}/api/auth/config`)).json()
    test.skip(cfg.stage !== 'on' || !cfg.devLogin, 'needs an AUTH=on + AUTH_DEV_LOGIN=on stack')
  })

  test("accepting an invite does not revoke the inviter's live session", async ({ browser }) => {
    const run = Date.now().toString(36)
    const s = await ownerInvitesGuest(browser, run)
    try {
      // The owner's page was never reloaded and never signed in again: its
      // socket must still be live and its edits must still reach the guest.
      const diagramPath = new URL(s.owner.url()).pathname
      await s.guest.goto(diagramPath)
      expect(await waitForDiagram(s.guest)).toBe(s.diagramId)

      const text = `E2E-NO-REVOKE-${run}`
      const commentId = await addCanvasComment(s.owner, text)
      await expect
        .poll(
          () => s.guest.evaluate((id) => (window as any).__modelStore.getState().comments.some((c: any) => c.id === id), commentId),
          { timeout: 30_000, message: "the inviter's comment must reach the new member" }
        )
        .toBe(true)
      await expect(s.owner.getByTestId('session-ended-banner')).toHaveCount(0)

      // And the inviter's session is still a session: a reload boots the diagram.
      await s.owner.reload()
      expect(await waitForDiagram(s.owner)).toBe(s.diagramId)
      await expect(s.owner).toHaveURL(/\/app\//)
    } finally {
      await s.ownerCtx.close()
      await s.guestCtx.close()
    }
  })

  test('a revoked live page says so, and "Sign in again" brings the user back to the diagram', async ({ browser }) => {
    const run = Date.now().toString(36)
    const s = await ownerInvitesGuest(browser, run)
    try {
      const diagramPath = new URL(s.owner.url()).pathname
      // The guest (an admin now) demotes the owner — a real reduction of access,
      // which must still revoke the owner's live session.
      expect(await setRole(s.guest, s.orgId, s.ownerId, 'member')).toBe(200)

      // The owner's page, untouched since the demotion, must SAY the session ended.
      const banner = s.owner.getByTestId('session-ended-banner')
      await expect(banner).toBeVisible({ timeout: 30_000 })
      await expect(banner).toContainText(/access in this organization changed/)
      await s.owner.screenshot({ path: test.info().outputPath('owner-session-ended.png') })

      // The demoted owner cannot undo their own demotion with the old cookie:
      // cookie HTTP checks every epoch (requireAuth isSessionCurrent), so the
      // call is a 401, not merely a 403 for a member.
      expect(await setRole(s.owner, s.orgId, s.ownerId, 'admin')).toBe(401)

      // Revocation is per user: the admin who demoted the owner keeps their own
      // session — no banner on their page, and their next call goes through
      // without signing in again. What made this call a 401 when the epoch was
      // org-wide (verified by restoring that trigger, 2026-10-16) is the
      // guest's own session carrying a now-stale org epoch: their socket was
      // closed as revoked and their cookie refused. The 3 s wait covers that
      // close + probe while LISTEN is up; with LISTEN down the revocation
      // would come from the 60 s poll instead.
      await s.guest.waitForTimeout(3_000)
      await expect(s.guest.getByTestId('session-ended-banner')).toHaveCount(0)
      expect(await setRole(s.guest, s.orgId, s.ownerId, 'admin')).toBe(200)
      // The owner follows the banner's own button: login page with the reason…
      await s.owner.getByTestId('session-ended-sign-in').click()
      await s.owner.waitForURL(/\/login/, { timeout: 30_000 })
      await expect(s.owner.getByTestId('session-ended-notice')).toBeVisible()
      // …then signs in and lands back on the diagram they were looking at.
      await expect(s.owner.getByTestId('dev-login-email')).toBeVisible({ timeout: 15_000 })
      await submitDevLogin(s.owner, s.ownerEmail)
      await s.owner.waitForURL((url) => url.pathname === diagramPath, { timeout: 30_000 })
      expect(await waitForDiagram(s.owner)).toBe(s.diagramId)
      await expect(s.owner.getByTestId('session-ended-banner')).toHaveCount(0)
    } finally {
      await s.ownerCtx.close()
      await s.guestCtx.close()
    }
  })

  test('a page opened on a revoked session lands on sign-in with the reason, not on a stalled canvas', async ({ browser }) => {
    const run = Date.now().toString(36)
    const s = await ownerInvitesGuest(browser, run)
    try {
      const diagramPath = new URL(s.owner.url()).pathname
      // No owner page is open while the session is revoked, so nothing probed it:
      // the cookie is still there, and stale.
      await s.owner.close()
      expect(await setRole(s.guest, s.orgId, s.ownerId, 'member')).toBe(200)

      const page = await s.ownerCtx.newPage()
      await page.goto(diagramPath)
      await page.waitForURL(/\/login/, { timeout: 30_000 })
      await expect(page.getByTestId('session-ended-notice')).toBeVisible()
    } finally {
      await s.ownerCtx.close()
      await s.guestCtx.close()
    }
  })
})

/** Change a member's org role through the real admin API, from `page`'s session. */
async function setRole(page: Page, orgId: string, userId: string, role: 'admin' | 'member'): Promise<number> {
  return page.evaluate(
    async ({ base, orgId, userId, role }) => {
      const r = await fetch(`${base}/api/orgs/${orgId}/members/${userId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      return r.status
    },
    { base: API_BASE, orgId, userId, role }
  )
}
