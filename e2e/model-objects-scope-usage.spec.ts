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

import { test, expect, type Page } from '@playwright/test'
import { submitDevLogin } from './support/devLogin'

/**
 * Model Objects shows the DERIVED per-diagram scope next to the default one —
 * "External in N of M diagrams" — and filters on "external on some diagram".
 *
 * Driven through the real UI only: the override is set with the details
 * panel's "scope on this diagram" toggle, which writes `Diagram.objectScopes`
 * through the bridge into BOTH the DiagramDoc and the registry meta. The count
 * is read back after a RELOAD, so it comes from a persisted copy, not from the
 * in-memory store that wrote it. What each tier proves, honestly:
 *  - server tier: the registry-meta copy (the read model counts from
 *    `ro_diagrams.data`, i.e. the meta) — the bridge wire. Verified RED with
 *    `objectScopes` dropped from the bridge's active-diagram meta.
 *  - resident tier: diagram-1 is the ACTIVE diagram after the reload, so its
 *    overrides come from the DiagramDoc, not from a registry stub. The stub
 *    path (non-active diagrams) is pinned by unit tests only
 *    (`metaToStubDiagram`, `objectExplorerFallback.test.ts`).
 *
 * Fixture: the demo workspace — diagram-1 is the container view drilling into
 * MapleSpire.io; Web app is one of its internal containers, API service another.
 */

test.use({ channel: process.env.PW_BROWSER_CHANNEL || undefined })

const LS_SERVER_TIER = 'maplespire:serverReadModel'

async function openModelObjects(page: Page): Promise<void> {
  await expect(page.getByTestId('nav-menu')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-model-objects').click()
  await expect(page.getByTestId('mo-row-group-maplespire')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('mo-expand-group-maplespire').click()
  await expect(page.getByTestId('mo-row-webapp')).toBeVisible()
}

for (const tier of ['resident', 'server'] as const) {
  test(`${tier} tier: a per-diagram override shows as "external in 1 of 1" and drives the filter`, async ({ page }) => {
    await page.addInitScript(([key, on]) => {
      if (on) localStorage.setItem(key, 'true')
      else localStorage.removeItem(key)
    }, [LS_SERVER_TIER, tier === 'server'] as const)

    // `/app`, not `/`: with AUTH off `/` is the marketing page.
    await page.goto('/app')
    const devLogin = page.getByTestId('dev-login-email')
    await devLogin.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => null)
    if (await devLogin.isVisible().catch(() => false)) {
      await submitDevLogin(page, `e2e-scope-usage-${tier}-${Date.now()}@example.com`)
    }
    await page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+/, { timeout: 90_000 })
    await openModelObjects(page)

    const usage = page.getByTestId('mo-external-usage-webapp')
    // A clean start: internal default, internal on its only diagram -> no badge.
    await page.getByTestId('mo-row-webapp').locator('td').first().click()
    const scopeHere = page.getByTestId('scope-on-diagram')
    await expect(scopeHere).toBeVisible()
    if (await page.getByTestId('scope-source').getByRole('button').isVisible().catch(() => false)) {
      await page.getByTestId('scope-source').getByRole('button').click()
    }
    await expect(usage).toHaveCount(0)

    // Override on THIS diagram only; the default stays internal.
    await scopeHere.getByRole('button').nth(1).click()
    await expect(scopeHere.getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('scope-default').getByRole('button').nth(0)).toHaveAttribute('aria-pressed', 'true')
    await expect(usage).toHaveText(/(External in|Externe dans) 1 (of|sur) 1/)

    // Persisted: the count after a reload comes from the stored copy.
    await expect(page.getByTestId('ws-sync-status')).not.toContainText(/Saving|Enregistrement/, { timeout: 30_000 })
    await page.reload()
    await openModelObjects(page)
    await expect(usage).toHaveText(/(External in|Externe dans) 1 (of|sur) 1/, { timeout: 30_000 })

    // The filter keeps Web app and drops an internal-everywhere sibling.
    await page.getByRole('button', { name: /^(Filter|Filtrer)/ }).click()
    await page.getByTestId('mo-filter-external-on-some-diagram').click()
    await expect(page.getByTestId('mo-filter-external-on-some-diagram')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('mo-row-webapp')).toBeVisible()
    await expect(page.getByTestId('mo-row-apiservice')).toHaveCount(0)
    await page.getByTestId('mo-filter-external-on-some-diagram').click()
    await expect(page.getByTestId('mo-row-apiservice')).toBeVisible({ timeout: 30_000 })

    // Leave the shared demo workspace as found.
    await page.keyboard.press('Escape')
    await page.getByTestId('mo-row-webapp').locator('td').first().click()
    await page.getByTestId('scope-source').getByRole('button').click()
    await expect(usage).toHaveCount(0)
  })
}
