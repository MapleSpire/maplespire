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
import { test, expect, type Page } from '@playwright/test'
import { submitDevLogin } from '../support/devLogin'
import { dragNewShapeToCanvas } from './helpers'

/**
 * A NEW landscape's documents become durable — the badge reaches "ready".
 *
 * The defect (2026-10-16, found on an AUTH-off boot stack): every document of a
 * landscape created in the session answered `durable:false` from
 * `POST /api/automerge/durable-heads` for as long as anyone watched (158 s+),
 * the badge stayed `saving`, and because `scheduleLiveSyncRefresh` waits for
 * `ready`, an imported diagram whose edges were all roll-ups rendered with 0
 * edges indefinitely. Nothing was refused and nothing was logged.
 *
 * Cause: the acknowledgement only counts documents listed in
 * `automerge_document_workspace`, and with AUTH off and `AM_WORKSPACE_ROUTING`
 * unset the server built no `WorkspaceDocIndex` — the one writer of that table
 * on the sync path. The same flow with AUTH on was durable within ~1 s.
 *
 * Runs against the boot stack with or without AUTH (E2E_BOOT_URL /
 * E2E_BOOT_API, see e2e/boot/README.md). It is the AUTH-OFF run that pins the
 * defect: `scripts/dev-boot.mjs` leaves both AUTH and AM_WORKSPACE_ROUTING
 * unset, which is the configuration that failed.
 */

const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3002'
const createdLandscapes: string[] = []

test.afterEach(async ({ page }) => {
  for (const id of createdLandscapes.splice(0)) {
    await page.context().request.delete(`${API_BASE}/api/landscapes/${encodeURIComponent(id)}`).catch(() => {})
  }
})

function landscapeFromUrl(page: Page): string | null {
  return new URL(page.url()).pathname.match(/\/landscape\/([^/]+)\//)?.[1] ?? null
}

/** The badge in whichever shell is mounted: the editor's bottom bar or the
 * workspace views' header (see entity-intent-journal.spec.ts). */
function syncBadge(page: Page) {
  return page.locator('[data-testid="ws-sync-status"], #sync-status').first()
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/app')
  const devLogin = page.getByTestId('dev-login-email')
  await Promise.race([
    devLogin.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined),
    page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+/, { timeout: 45_000 }).catch(() => undefined),
  ])
  if (await devLogin.isVisible().catch(() => false)) {
    await submitDevLogin(page, `durable-${Date.now().toString(36)}@example.test`)
  }
  await page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+/, { timeout: 90_000 })
  await page.waitForFunction(() => Array.isArray((window as any).__modelStore?.getState?.().diagrams), undefined, {
    timeout: 60_000,
  })
}

test('a landscape created in the session reaches "ready", and so does an edit inside it', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page)
  // The workspace the app booted into settles first. On a FRESH database the
  // defect already fails HERE — the default workspace had no manifest rows
  // either (measured 2026-10-16). On a database a fixed server
  // has run against, this passes and the new-landscape assertion below is the
  // one that goes red.
  await expect.poll(() => syncBadge(page).getAttribute('data-status'), { timeout: 60_000 }).toBe('ready')

  const previous = landscapeFromUrl(page)
  const name = `e2e-durable-${Date.now().toString(36)}`
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('workspace-landscapes').click()
  await page.getByTestId('new-landscape-name').fill(name)
  await page.getByTestId('new-landscape-add').click()
  await expect(page.getByTestId('nav-menu')).toContainText(name, { timeout: 60_000 })
  await page.keyboard.press('Escape')
  await expect.poll(() => landscapeFromUrl(page), { timeout: 30_000 }).not.toBe(previous)
  const landscapeId = landscapeFromUrl(page)!
  createdLandscapes.push(landscapeId)

  // `ready` is a GLOBAL latch with no workspace identity, so read it only off
  // the badge that names THIS landscape as projected — otherwise the previous
  // workspace's `ready`, still on screen while the switch runs, satisfies it
  // (awaitWorkspaceProjection.ts § why the identity matters).
  const newLandscapeBadge = page
    .locator('[data-testid="ws-sync-status"], #sync-status')
    .and(page.locator(`[data-projected-workspace^="${landscapeId}/"]`))
  await expect(newLandscapeBadge).toHaveCount(1, { timeout: 60_000 })
  // The defect: this stayed `saving` for good. ~1 s on a healthy stack; the
  // bound leaves room for a cold projector without ever passing a stuck badge.
  await expect(newLandscapeBadge).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })

  // An edit in the new landscape: a fresh document write must be acknowledged
  // too, not only whatever the landscape was born with.
  await page.waitForFunction(() => !!(window as any).__modelStore?.getState?.().currentDiagramId, undefined, {
    timeout: 30_000,
  })
  const id = await dragNewShapeToCanvas(page, 'system')
  // FIRST the server has the edit — read back from THIS workspace's read model
  // (explicit params: the bare endpoint answers for the default workspace;
  // `page.request` so an AUTH-on run carries the session cookie, see
  // repoint-live-tab.spec.ts § objectPresence). Only then is a `ready` badge
  // evidence: read before this, it could predate the edit's own `saving`.
  const versionId = new URL(page.url()).pathname.match(/\/version\/([^/]+)/)![1]
  const query = new URLSearchParams({ landscapeId, versionId })
  await expect.poll(async () => {
    const response = await page.request.get(`${API_BASE}/api/model/object/${encodeURIComponent(id)}?${query}`)
    return response.status() === 200 ? ((await response.json()) as any).object?.id ?? null : response.status()
  }, { timeout: 30_000 }).toBe(id)
  await expect(newLandscapeBadge).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
})
