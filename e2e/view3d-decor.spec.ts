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
// The probe's shape comes from `src/canvas3d/scene3dProbe.ts`, which
// `Scene3D.mount()` asserts its literal against with `satisfies`. This file used
// to declare its own — and its `sceneStats()` was the NARROWEST of four private
// copies, which is why the merged program picked it and 234 errors fell out of
// the other six specs.
import type { Scene3dDecorInfo } from '../src/canvas3d/scene3dProbe'

/**
 * Scene decoration — REAL UI end to end: the "Decorate"
 * popover writes the shared per-diagram setting, every client renders the
 * same deterministic placement, the share viewer shows the dressed board,
 * and pack switches never leak GPU allocations.
 *
 * Run with the isolated 3D stack:  npx playwright test --project=view3d
 */

const DSL = `workspace "Decor" {
  model {
    platform = softwareSystem "Platform" "System" {
      api = container "API service" "Core platform logic" "Node.js"
      web = container "Web app" "Single-page app" "React"
      db = container "Orders database" "Storage" "PostgreSQL"
    }
    web -> api "calls"
    api -> db "reads/writes"
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
  await page.waitForTimeout(2500)
}

async function enter3d(page: Page) {
  await page.locator('[data-testid="view-3d"]').click()
  await page.waitForFunction(
    () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
    undefined,
    { timeout: 40000 },
  )
  await page.waitForTimeout(1200)
}

const totalProps = (info: Scene3dDecorInfo) => info.archetypes.reduce((n, a) => n + a.count, 0)

test.describe.configure({ mode: 'serial' })

test.describe('scene decoration (real UI)', () => {
  test('popover dresses the board; density scales; reload + share viewer render the SAME layout; pack switches never leak', async ({ page, context }) => {
    await loginIfNeeded(page)
    await importDsl(page, DSL)
    await enter3d(page)

    // pick the people pack through the REAL popover
    await page.locator('[data-testid="decor-open"]').click()
    await page.locator('[data-testid="decor-pack-maquette-people"]').click()
    await page.waitForFunction(() => {
      const d = window.__scene3d!.decorInfo()
      return d.packId === 'maquette-people' && d.archetypes.length > 0
    }, undefined, { timeout: 10000 })
    const normal = await page.evaluate(() => window.__scene3d!.decorInfo())
    expect(totalProps(normal)).toBeGreaterThan(0)
    expect(normal.seed, 'seed defaulted from the diagram id').not.toBeNull()

    // density is monotone through the segmented control (the pack pick
    // closed the popover — reopen it)
    await page.locator('[data-testid="decor-open"]').click()
    await page.locator('[data-testid="decor-density-rich"]').click()
    await page.waitForFunction(
      (base) => {
        const d = window.__scene3d!.decorInfo()
        return d.density === 'rich' && d.archetypes.reduce((n, a) => n + a.count, 0) >= base
      },
      totalProps(normal),
      { timeout: 10000 },
    )
    const rich = await page.evaluate(() => window.__scene3d!.decorInfo())
    await page.locator('[data-testid="decor-density-sparse"]').click()
    await page.waitForFunction(() => window.__scene3d!.decorInfo().density === 'sparse', undefined, { timeout: 10000 })
    const sparse = await page.evaluate(() => window.__scene3d!.decorInfo())
    expect(totalProps(sparse)).toBeLessThan(totalProps(rich))
    await page.locator('[data-testid="decor-density-rich"]').click()
    await page.waitForFunction(() => window.__scene3d!.decorInfo().density === 'rich', undefined, { timeout: 10000 })

    await page.keyboard.press('Escape')

    // shared persistence: a reload restores the exact same decor
    const before = await page.evaluate(() => window.__scene3d!.decorInfo())
    await page.waitForTimeout(1500) // write debounce + repo auto-save settle
    await page.evaluate(async () => {
      const f = (window as unknown as { __repoFlush?: () => Promise<void> }).__repoFlush
      if (f) await f()
    }).catch(() => {})
    await page.reload()
    await page.waitForFunction(
      () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
      undefined,
      { timeout: 30000 },
    )
    await page.waitForFunction(() => window.__scene3d!.decorInfo().packId === 'maquette-people', undefined, { timeout: 10000 })
    const reloaded = await page.evaluate(() => window.__scene3d!.decorInfo())
    expect(reloaded.seed).toBe(before.seed)
    expect(reloaded.archetypes).toEqual(before.archetypes)

    // share viewer renders the SAME dressed board (determinism across clients)
    await page.getByRole('button', { name: /Partager|Share/ }).first().click()
    const dialog = page.locator('[role="dialog"]')
    await dialog.getByRole('switch').first().click()
    const urlText = await dialog.locator('text=/\\/share\\//').first().innerText({ timeout: 15000 })
    const shareUrl = urlText.match(/https?:\/\/\S+\/share\/\S+/)?.[0]
    expect(shareUrl).toBeTruthy()
    await page.keyboard.press('Escape')

    const visitor = await context.newPage()
    await visitor.goto(`${shareUrl}?view=3d`)
    await visitor.waitForFunction(
      () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
      undefined,
      { timeout: 30000 },
    )
    await visitor.waitForFunction(() => window.__scene3d!.decorInfo().packId === 'maquette-people', undefined, { timeout: 10000 })
    const viewerInfo = await visitor.evaluate(() => window.__scene3d!.decorInfo())
    expect(viewerInfo.seed).toBe(before.seed)
    expect(viewerInfo.archetypes).toEqual(before.archetypes)
    await expect(visitor.locator('[data-testid="decor-open"]')).toHaveCount(0) // viewer has no decor controls
    await visitor.close()

    // pack switches return to a flat GPU plateau (the silhouette cache fills
    // once; materials must dispose per switch)
    const base = await page.evaluate(() => {
      // warm every pack's geometry cache first
      return window.__scene3d!.sceneStats()
    })
    for (const pack of ['decor-pack-datacenter', 'decor-pack-greenery', 'decor-pack-maquette-people']) {
      await page.locator('[data-testid="decor-open"]').click()
      await page.locator(`[data-testid="${pack}"]`).click()
      await page.waitForTimeout(250)
    }
    const warmed = await page.evaluate(() => window.__scene3d!.sceneStats())
    for (const pack of ['decor-pack-datacenter', 'decor-pack-greenery', 'decor-pack-maquette-people']) {
      await page.locator('[data-testid="decor-open"]').click()
      await page.locator(`[data-testid="${pack}"]`).click()
      await page.waitForTimeout(250)
    }
    const after = await page.evaluate(() => window.__scene3d!.sceneStats())
    expect(after.geometries, 'pack switching returns to the warmed plateau').toBe(warmed.geometries)
    expect(after.textures).toBe(warmed.textures)
    void base

    // "None" clears everything
    await page.locator('[data-testid="decor-open"]').click()
    await page.locator('[data-testid="decor-pack-none"]').click()
    await page.waitForFunction(() => window.__scene3d!.decorInfo().packId === null, undefined, { timeout: 10000 })
    const cleared = await page.evaluate(() => window.__scene3d!.decorInfo())
    expect(cleared.archetypes).toEqual([])
  })

  test('tray + background pickers (real UI, lit profile): engine consumes them, "None" keeps them, reload restores them', async ({ page }) => {
    await loginIfNeeded(page)
    await importDsl(page, DSL)
    // trays/backgrounds are a lit-profile surface — pin the studio skin like
    // a real user (diagram-skin-select), then enter 3D
    await page.keyboard.press('Escape')
    const sel = page.locator('[data-testid="diagram-skin-select"]')
    await sel.waitFor({ state: 'visible', timeout: 10000 })
    await sel.selectOption('studio')
    await enter3d(page)

    // tray pick through the REAL chips — the engine rebuilds the lit cap
    await page.locator('[data-testid="decor-open"]').click()
    await page.locator('[data-testid="decor-board-museum"]').click()
    await page.waitForFunction(() => window.__scene3d!.decorInfo().boardStyle === 'museum', undefined, {
      timeout: 10000,
    })

    // background pick: the engine must actually BUILD the chosen world
    await page.locator('[data-testid="decor-bg-city"]').click()
    await page.waitForFunction(() => {
      const d = window.__scene3d!.decorInfo()
      return d.background === 'city' && d.world === 'city'
    }, undefined, { timeout: 10000 })
    await page.locator('[data-testid="decor-bg-void"]').click()
    await page.waitForFunction(() => window.__scene3d!.decorInfo().world === 'void', undefined, { timeout: 10000 })
    await page.locator('[data-testid="decor-bg-city"]').click()
    await page.waitForFunction(() => window.__scene3d!.decorInfo().world === 'city', undefined, { timeout: 10000 })

    // a pack joins, then "None" removes ONLY the pack — tray + background
    // survive (the popover's None is not a nuke anymore)
    await page.locator('[data-testid="decor-pack-maquette-people"]').click()
    await page.waitForFunction(() => window.__scene3d!.decorInfo().packId === 'maquette-people', undefined, {
      timeout: 10000,
    })
    await page.locator('[data-testid="decor-open"]').click()
    await page.locator('[data-testid="decor-pack-none"]').click()
    await page.waitForFunction(() => {
      const d = window.__scene3d!.decorInfo()
      return d.packId === null && d.boardStyle === 'museum' && d.background === 'city' && d.world === 'city'
    }, undefined, { timeout: 10000 })
    await page.keyboard.press('Escape')

    // shared persistence: reload restores tray + background without a pack
    await page.waitForTimeout(1500) // write debounce + repo auto-save settle
    await page.evaluate(async () => {
      const f = (window as unknown as { __repoFlush?: () => Promise<void> }).__repoFlush
      if (f) await f()
    }).catch(() => {})
    await page.reload()
    await page.waitForFunction(
      () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
      undefined,
      { timeout: 30000 },
    )
    await page.waitForFunction(() => {
      const d = window.__scene3d!.decorInfo()
      return d.boardStyle === 'museum' && d.background === 'city' && d.world === 'city'
    }, undefined, { timeout: 10000 })
  })
})
