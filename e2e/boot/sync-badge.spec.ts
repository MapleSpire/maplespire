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

/**
 * Regression: the sync badge must reach "Synchronisé" (data-status="ready").
 *
 * `scheduleWrite` optimistically shows "saving" as soon as a write is requested,
 * but several `flushWrite` paths legitimately produce nothing durable — most of
 * all boot-from-server, which never writes model shards. On those paths no
 * handle reached `trackDurableHandle`, so the durable-ack loop was never
 * re-armed (it only re-arms while `durableHeads.size > 0`) and the badge stayed
 * on "Enregistrement…" forever. Measured before the fix: baseline settled in 8 s,
 * boot-from-server was still "saving" past 40 s.
 *
 * In an offline-first editor that badge is how a user knows their work is safe,
 * so a permanently-"saving" badge is a correctness bug, not cosmetics.
 *
 * Runs against any dev stack: the boot-from-server flag is set through its
 * localStorage override, so a stack without the build-time `VITE_BOOT_FROM_SERVER`
 * still exercises the path. Point it at one with `E2E_BOOT_URL`.
 */
import { test, expect, type Page } from '@playwright/test'

const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'

async function signIn(page: Page): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  const email = page.getByTestId('dev-login-email')
  const landed = await Promise.race([
    email.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'form' as const),
    page.waitForURL('**/app/**', { timeout: 20_000 }).then(() => 'app' as const),
  ]).catch(() => 'form' as const)
  if (landed === 'form') {
    const legal = page.getByTestId('legal-acceptance')
    if (await legal.count()) await legal.check().catch(() => {})
    await email.fill(DEV_EMAIL)
    await email.press('Enter')
    await page.waitForURL('**/app/**', { timeout: 30_000 })
  }
}

/** Open a workspace page — WorkspaceShell is where ws-sync-status renders. */
async function openModelObjects(page: Page): Promise<void> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-model-objects').click()
  await expect(page.getByTestId('ws-sync-status')).toBeVisible({ timeout: 30_000 })
}

for (const [label, flags] of [
  ['classic boot', {}],
  ['boot-from-server', { 'maplespire:bootFromServer': 'true' }],
  ['boot-from-server + server read model', {
    'maplespire:bootFromServer': 'true',
    'maplespire:serverReadModel': 'true',
  }],
] as const) {
  test(`sync badge settles to Synchronisé — ${label}`, async ({ page }) => {
    await page.addInitScript((f: Record<string, string>) => {
      for (const [k, v] of Object.entries(f)) localStorage.setItem(k, v)
    }, flags as Record<string, string>)

    await signIn(page)
    await openModelObjects(page)

    // The badge spins for 'connecting' and 'saving'; it must land on 'ready'.
    // Before the fix this stayed 'saving' indefinitely under boot-from-server.
    await expect(page.getByTestId('ws-sync-status')).toHaveAttribute('data-status', 'ready', {
      timeout: 45_000,
    })
  })
}
