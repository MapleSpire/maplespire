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

/**
 * 3D board WebGL-ABSENT fallback — the whole file runs in its
 * own worker whose chromium launches with WebGL disabled (test.use replaces
 * the project's SwiftShader args). Entering 3D must show the graceful
 * fallback with a working "back to flat canvas" action on BOTH surfaces
 * (editor + share viewer) — never a dead black board.
 *
 * Run with the isolated 3D stack:  npx playwright test --project=view3d
 */

test.use({ launchOptions: { args: ['--disable-webgl'] } })

const DSL = `workspace "NoGL" {
  model {
    platform = softwareSystem "Platform" "System" {
      api = container "API service" "Core logic" "Node.js"
      web = container "Web app" "SPA" "React"
    }
    web -> api "calls"
  }
  views {
    container platform { include * autoLayout }
  }
}`

async function loginIfNeeded(page: Page) {
  await page.goto('/login')
  const devLogin = page.locator('[data-testid="dev-login-email"]')
  const outcome = await Promise.race([
    devLogin.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'form' as const),
    page.waitForURL('**/app/**', { timeout: 15000 }).then(() => 'app' as const),
  ]).catch(() => 'form' as const)
  if (outcome === 'form') {
    // The ToS/privacy checkbox gates the whole login form (LoginPage legal
    // gate) — accept it exactly like a real user.
    await page.locator('[data-testid="legal-acceptance"]').check()
    await devLogin.fill('admin@example.com')
    await devLogin.press('Enter')
  }
  await page.waitForURL('**/app/**', { timeout: 30000 })
}

async function importDsl(page: Page, dsl: string) {
  await page.locator('[data-testid="nav-menu"]').click()
  await page.locator('[data-testid="nav-diagrams"]').click()
  await page.locator('[data-testid="create-diagram-button"]').click()
  await page.locator('[data-testid="create-import"]').click()
  await page.locator('[data-testid="import-textarea"]').fill(dsl)
  await page.locator('[data-testid="import-parse"]').click()
  await page.locator('[data-testid="import-generate"]').click()
  await page.waitForURL('**/diagram/**', { timeout: 60000 })
  await page.waitForTimeout(2000) // import settle
}

/** Precondition guard: if WebGL ever sneaks back in (flag renamed, defaults
 * changed), fail HERE instead of green-lighting a fallback that never ran. */
async function assertWebglTrulyAbsent(page: Page) {
  const absent = await page.evaluate(() => {
    const c = document.createElement('canvas')
    return c.getContext('webgl2') === null && c.getContext('webgl') === null
  })
  expect(absent, 'WebGL must be disabled in this worker for the fallback drill').toBe(true)
}

test.describe.configure({ mode: 'serial' })

test.describe('3D WebGL-absent fallback', () => {
  test('editor: entering 3D shows the fallback; back-to-2D returns to the flat canvas', async ({ page }) => {
    await loginIfNeeded(page)
    await assertWebglTrulyAbsent(page)
    await importDsl(page, DSL)

    // 2D keeps working without WebGL (Canvas2D engine) — the board rendered.
    await expect(page.locator('[data-testid="view-3d"]')).toBeVisible()

    await page.locator('[data-testid="view-3d"]').click()
    // Chunk loads fine; Scene3D's WebGLRenderer constructor throws → fallback.
    const fallback = page.locator('[data-testid="webgl-fallback"]')
    await expect(fallback).toBeVisible({ timeout: 30000 })
    await expect(fallback).toContainText(/3D view unavailable|Vue 3D indisponible/)

    await page.locator('[data-testid="webgl-fallback-back"]').click()
    await expect(fallback).toHaveCount(0)
    // Back on the flat canvas: the 3D overlay unmounted entirely.
    await expect(page.locator('[data-testid="canvas-3d"]')).toHaveCount(0)
  })

  test('share viewer: ?view=3d shows the fallback; back-to-2D lands on the flat viewer', async ({ page, context }) => {
    await loginIfNeeded(page)
    await assertWebglTrulyAbsent(page)
    await importDsl(page, DSL)

    // Create a share link through the real dialog (allow3d defaults on).
    await page.getByRole('button', { name: /Partager|Share/ }).first().click()
    const dialog = page.locator('[role="dialog"]')
    await dialog.getByRole('switch').first().click()
    const urlText = await dialog.locator('text=/\\/share\\//').first().innerText({ timeout: 15000 })
    const shareUrl = urlText.match(/https?:\/\/\S+\/share\/\S+/)?.[0]
    expect(shareUrl).toBeTruthy()

    const visitor = await context.newPage()
    await visitor.goto(`${shareUrl}?view=3d`)
    const fallback = visitor.locator('[data-testid="webgl-fallback"]')
    await expect(fallback).toBeVisible({ timeout: 30000 })

    await visitor.locator('[data-testid="webgl-fallback-back"]').click()
    await expect(fallback).toHaveCount(0)
    // The flat viewer canvas is back and the deep link no longer pins 3D.
    await expect(visitor.locator('[data-testid="viewer-canvas-3d"]')).toHaveCount(0)
    await visitor.waitForFunction(() => !location.search.includes('view=3d'), undefined, { timeout: 10000 })
    await visitor.close()
  })
})
