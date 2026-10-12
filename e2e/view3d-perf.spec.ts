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
 * 3D board PERF GATE — drives the real UI, imports a large
 * diagram, and reads honest counters off the `__scene3d.sceneStats()` probe:
 * draw calls, triangles, built vs. LOD-visible text, and the median single-frame
 * render cost. Also asserts idle rAF = 0 (no render while nothing animates).
 *
 * Run with the isolated 3D stack:  npx playwright test --project=view3d-perf
 */

/** A container view with `n` containers + a chain of connections — a worst-case
 * fit-all frame (every node in frustum). */
function bigDsl(n: number): string {
  let containers = ''
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = `c${i}`
    ids.push(id)
    containers += `      ${id} = container "Service ${i}" "Does thing ${i}" "Node.js"\n`
  }
  let rels = ''
  for (let i = 0; i + 1 < ids.length; i++) {
    if (i % 3 === 0) rels += `    ${ids[i]} -> ${ids[i + 1]} "calls"\n`
  }
  return `workspace "Perf" {
  model {
    platform = softwareSystem "Platform" "Big system" {
${containers}    }
${rels}  }
  views {
    container platform { include * autoLayout }
  }
}`
}

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
  await page.waitForTimeout(2500) // import settle + first zoom-to-fit
}

async function enter3d(page: Page) {
  await page.locator('[data-testid="view-3d"]').click()
  await page.waitForFunction(
    () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
    undefined,
    { timeout: 40000 },
  )
  await page.waitForTimeout(1200) // let the enter morph fully settle
}

/** Pin the test diagram to the UNLIT baseline skin ('default') via the real
 * diagram-settings panel. These budgets are the UNLIT perf contract — the lit
 * (PBR) profile carries shadow/AO costs and gets its own budget suite — so
 * this gate must keep measuring the unlit pipeline as themes migrate.
 * Per-diagram override on a fresh test diagram ⇒ nothing to restore. */
async function pinUnlitSkin(page: Page) {
  const current = await page.evaluate(() => window.__canvasEngine!.skin?.id)
  if (current === 'default') return
  // The diagram-settings panel only shows while nothing is selected.
  await page.keyboard.press('Escape')
  const select = page.locator('[data-testid="diagram-skin-select"]')
  await select.waitFor({ state: 'visible', timeout: 10000 })
  await select.selectOption('default')
  await page.waitForFunction(() => window.__canvasEngine!.skin?.id === 'default', undefined, { timeout: 10000 })
  await page.waitForTimeout(400) // the skin swap rebuilds the board — let it settle
}

const NODES = 200

test.describe.configure({ mode: 'serial' })

test.describe('3D perf gate', () => {
  test(`draw-call budget + frame cost + idle rAF at ${NODES} nodes`, async ({ page }) => {
    await loginIfNeeded(page)
    await importDsl(page, bigDsl(NODES))
    await pinUnlitSkin(page)
    await enter3d(page)

    // Median single-frame render cost (CPU-side) at the fit-all pose — the
    // worst case where every node sits in the frustum.
    const measured = await page.evaluate(() => {
      const s = window.__scene3d!
      const times: number[] = []
      let stats = s.sceneStats()
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now()
        stats = s.sceneStats()
        times.push(performance.now() - t0)
      }
      times.sort((a, b) => a - b)
      return { stats, medianRenderMs: times[Math.floor(times.length / 2)] }
    })

    // Idle rAF must be 0: with nothing animating, the cumulative render-frame
    // counter (read WITHOUT rendering — rendererInfo doesn't render) does not
    // advance over a quiet second.
    const frameBefore = await page.evaluate(() => window.__scene3d!.rendererInfo().frame)
    await page.waitForTimeout(1100)
    const frameAfter = await page.evaluate(() => window.__scene3d!.rendererInfo().frame)

    console.log('[PERF]', JSON.stringify({ ...measured, idleFramesAdvanced: frameAfter - frameBefore }, null, 2))

    const s = measured.stats
    expect(s.nodes).toBeGreaterThanOrEqual(NODES - 5)

    // ── the gates ────────────────────────────────────────────────────────────
    // Text LOD is active and caps visible text well under the ~150 budget: at a
    // fit-all of 200 nodes the vast majority is sub-pixel and hidden (baseline
    // was 668 all-visible — that regression must fail this gate).
    expect(s.visibleTexts).toBeLessThanOrEqual(150)
    expect(s.visibleTexts).toBeLessThan(s.texts) // LOD genuinely engaged
    // Draw calls at fit-all are far below the per-node baseline (2270 → ~1076):
    // guard the LOD win without pinning the exact per-node floor.
    expect(s.calls).toBeLessThan(1600)
    // DPR capped at 2 (retina clamp).
    expect(s.pixelRatio).toBeLessThanOrEqual(2)
    // Frame cost stays cheap even on the SwiftShader runner (integrated-GPU proxy
    // is faster still). Generous 2-frame ceiling — catches a pathological blowup.
    expect(measured.medianRenderMs).toBeLessThan(33)
    // Idle rAF = 0: no render churn while nothing animates.
    expect(frameAfter - frameBefore).toBe(0)
  })

  test('LOD restores decorations when a node is zoomed to a readable size', async ({ page }) => {
    await loginIfNeeded(page)
    await importDsl(page, bigDsl(NODES))
    await pinUnlitSkin(page)
    await enter3d(page)

    const farTexts = await page.evaluate(() => window.__scene3d!.sceneStats().visibleTexts)

    // Fly the camera close to a real node → its decorations must come back.
    await page.evaluate(() => {
      const s = window.__scene3d!
      const id = s.nodeIds()[0]
      const p = s.nodeWorldPos(id)!
      s.focusWorld(p.x, p.y, 320) // tight distance frames the card large on screen
    })
    await page.waitForFunction(() => !window.__scene3d!.isCameraAnimating(), undefined, { timeout: 15000 })
    await page.waitForTimeout(300)
    const nearTexts = await page.evaluate(() => window.__scene3d!.sceneStats().visibleTexts)

    // Zooming in reveals more readable text than the fit-all view showed.
    expect(nearTexts).toBeGreaterThan(farTexts)
  })

  // Fidelity guard: LOD must NEVER hide anything at a normal-sized diagram's
  // default framing — the user works at a zoom where every card is clearly
  // readable, so the full design (names, tiles, subtitles, pills) must render.
  test('LOD hides nothing at a normal-sized diagram default framing (no fidelity loss)', async ({ page }) => {
    await loginIfNeeded(page)
    await importDsl(page, bigDsl(8))
    await pinUnlitSkin(page)
    await enter3d(page)
    const s = await page.evaluate(() => window.__scene3d!.sceneStats())
    expect(s.nodes).toBe(8)
    expect(s.visibleTexts).toBe(s.texts) // every built text block is on screen
  })
})
