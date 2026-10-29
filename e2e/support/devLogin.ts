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

import type { Page } from '@playwright/test'

/**
 * Complete the dev-login form.
 *
 * `LoginPage` gates EVERY submit button (dev, password and OIDC) behind the
 * legal-acceptance checkbox — `disabled={submitting || !legalAccepted}`. A spec
 * that only fills the email and clicks Continue hangs on a permanently disabled
 * button. Ticking `legal-acceptance` first is therefore part of the sign-in
 * dance, not an optional extra; keep it here so a future gate is fixed once.
 *
 * Assumes the caller has already established that `dev-login-email` is visible.
 */
export async function submitDevLogin(page: Page, email: string): Promise<void> {
  await page.getByTestId('dev-login-email').fill(email)
  const legal = page.getByTestId('legal-acceptance')
  if (await legal.isVisible().catch(() => false)) {
    if (!(await legal.isChecked().catch(() => true))) await legal.check()
  }
  await page.getByTestId('dev-login-submit').click()
}

const WORKSPACE_URL = /\/app\/landscape\/[^/]+\/version\/[^/]+/

/**
 * Open the app itself and land in a workspace, on either kind of stack.
 *
 * Starts at `/app`, never `/`: `/` is the marketing landing page in this
 * repository (the public copy redirects it to `/app`), so a spec that opens `/`
 * and waits for the editor waits on a page that never leaves the landing.
 *
 * At AUTH=on the dev-login form appears and is completed with `email`; at
 * AUTH=off the app goes straight to the workspace URL. The redirect lands a tick
 * after `load`, so this waits for whichever outcome arrives instead of reading
 * `isVisible()` before the page has decided.
 */
export async function enterAppWorkspace(page: Page, email: string): Promise<void> {
  await page.goto('/app')
  const devLogin = page.getByTestId('dev-login-email')
  await Promise.race([
    devLogin.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => null),
    page.waitForURL(WORKSPACE_URL, { timeout: 45_000 }).catch(() => null),
  ])
  if (await devLogin.isVisible().catch(() => false)) await submitDevLogin(page, email)
  await page.waitForURL(WORKSPACE_URL, { timeout: 90_000 })
}
