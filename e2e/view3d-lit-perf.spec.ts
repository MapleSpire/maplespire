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
 * LIT-profile PERF GATE (PBR migration). The unlit budgets live in
 * `view3d-perf.spec.ts` and stay untouched; THIS gate prices the lit
 * pipeline at the same 200-node fit-all worst case, on the deterministic
 * SwiftShader tier ('medium': shadows + bloom composer, no AO):
 *
 *   calls < 1900   (unlit gate is 1600 — the delta is the shadow depth pass)
 *   median < 45ms  (SwiftShader pays PCF 2048 + the composer fullscreen work)
 *   idle rAF === 0 (the composer renders on demand, never continuously)
 *
 * Run with the isolated 3D stack:  npx playwright test --project=view3d
 */

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
  return `workspace "LitPerf" {
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

/** Pin the test diagram to the LIT flagship (studio) via the real settings
 * panel — per-diagram override on a fresh diagram, nothing to restore. */
async function pinStudioSkin(page: Page) {
  const current = await page.evaluate(() => window.__canvasEngine!.skin?.id)
  if (current === 'studio') return
  await page.keyboard.press('Escape')
  const select = page.locator('[data-testid="diagram-skin-select"]')
  await select.waitFor({ state: 'visible', timeout: 10000 })
  await select.selectOption('studio')
  await page.waitForFunction(() => window.__canvasEngine!.skin?.id === 'studio', undefined, { timeout: 10000 })
  await page.waitForTimeout(400)
}

const NODES = 200

test.describe.configure({ mode: 'serial' })

test.describe('3D lit perf gate (Studio, tier medium)', () => {
  test(`lit draw-call + frame budgets + idle rAF at ${NODES} nodes`, async ({ page }) => {
    await loginIfNeeded(page)
    await importDsl(page, bigDsl(NODES))
    await pinStudioSkin(page)
    await enter3d(page)

    // SwiftShader lands on 'medium' by the tier heuristic — assert it so the
    // budgets below stay tied to a deterministic pass chain, and wait for the
    // lazy post chunk so `calls` includes the composer's fullscreen work.
    await page.waitForFunction(() => window.__scene3d!.sceneStats().composerPasses > 0, undefined, { timeout: 20000 })

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

    const frameBefore = await page.evaluate(() => window.__scene3d!.rendererInfo().frame)
    await page.waitForTimeout(1100)
    const frameAfter = await page.evaluate(() => window.__scene3d!.rendererInfo().frame)

    console.log('[LIT PERF]', JSON.stringify({ ...measured, idleFramesAdvanced: frameAfter - frameBefore }, null, 2))

    const s = measured.stats
    expect(s.nodes).toBeGreaterThanOrEqual(NODES - 5)
    expect(s.renderProfile).toBe('lit')
    expect(s.qualityTier, 'deterministic CI tier').toBe('medium')
    expect(s.composerPasses).toBe(2)
    expect(s.shadowMapEnabled).toBe(true)
    // ── the lit budgets ─────────────────────────────────────────────────────
    // The delta over the unlit 1600 gate is the shadow depth pass (casters
    // only — slabs + drums, LOD-gated) + the composer's fullscreen passes.
    expect(s.calls).toBeLessThan(1900)
    expect(s.pixelRatio).toBeLessThanOrEqual(2)
    expect(measured.medianRenderMs).toBeLessThan(45)
    expect(frameAfter - frameBefore, 'no idle render churn under the composer').toBe(0)
  })
})
