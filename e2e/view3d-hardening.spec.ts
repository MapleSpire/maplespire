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
// One shared probe type — see e2e/support/probes.d.ts.
import type { Scene3dSceneStats } from '../src/canvas3d/scene3dProbe'

/**
 * 3D board HARDENING drills — context-loss recovery.
 * Forces a real GL context loss via WEBGL_lose_context (the renderer's
 * forceContextLoss/forceContextRestore) and asserts the board comes back
 * IDENTICAL: same node/text counts, draw calls flowing again, and the same
 * rendered pixels at the same camera pose. Pixels are the honest check —
 * a restore that re-inits GL but leaves the board black passes every
 * geometry assertion and fails this one.
 *
 * Run with the isolated 3D stack:  npx playwright test --project=view3d
 */

const DSL = `workspace "Hardening" {
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
 * diagram-settings panel. The hardening drills are the UNLIT contract for
 * context loss / leaks — lit themes get their own drills — so they must keep
 * exercising the unlit pipeline as themes migrate to the lit (PBR) profile.
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

/** Sample the rendered board at the canvas centre + 4 offsets (client px). */
async function samplePixels(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="canvas-3d"] canvas') as HTMLCanvasElement
    const r = canvas.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const pts: [number, number][] = [
      [cx, cy],
      [cx - 80, cy],
      [cx + 80, cy],
      [cx, cy - 60],
      [cx, cy + 60],
    ]
    return pts.map(([x, y]) => window.__scene3d!.readPixel(x, y))
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('3D hardening', () => {
  test('context loss → automatic recovery: full rebuild, same pixels', async ({ page }) => {
    await loginIfNeeded(page)
    await importDsl(page, DSL)
    await pinUnlitSkin(page)
    await enter3d(page)

    // Park the camera on a real node so the sampled pixels cover actual
    // content (card top + floor), not just empty background.
    await page.evaluate(() => {
      const s = window.__scene3d!
      const p = s.nodeWorldPos(s.nodeIds()[0])!
      s.focusWorld(p.x, p.y, 420)
    })
    await page.waitForFunction(() => !window.__scene3d!.isCameraAnimating(), undefined, { timeout: 15000 })
    await page.waitForTimeout(300)

    const statsBefore = await page.evaluate(() => window.__scene3d!.sceneStats())
    const pixelsBefore = await samplePixels(page)
    expect(statsBefore.calls).toBeGreaterThan(0)
    // Sanity: the samples aren't all one flat color (we're looking at content).
    const distinct = new Set(pixelsBefore.map((p) => `${p.r},${p.g},${p.b}`))
    expect(distinct.size).toBeGreaterThan(1)

    // ── the drill ────────────────────────────────────────────────────────────
    await page.evaluate(() => window.__scene3d!.forceContextLoss())
    await page.waitForFunction(() => window.__scene3d!.contextInfo().lost === true, undefined, { timeout: 10000 })

    await page.evaluate(() => window.__scene3d!.forceContextRestore())
    await page.waitForFunction(
      () => {
        const c = window.__scene3d!.contextInfo()
        return !c.lost && c.restores >= 1
      },
      undefined,
      { timeout: 15000 },
    )
    await page.waitForTimeout(500) // rebuild + async SDF text re-generation settle

    // ── recovery must be lossless ───────────────────────────────────────────
    const statsAfter = await page.evaluate(() => window.__scene3d!.sceneStats())
    expect(statsAfter.nodes).toBe(statsBefore.nodes)
    expect(statsAfter.texts).toBe(statsBefore.texts)
    expect(statsAfter.calls).toBeGreaterThan(0)
    // The render profile must survive a restore exactly — a recovery that
    // leaves a light mounted or a shadow map enabled is a state leak.
    expect(statsAfter.renderProfile).toBe(statsBefore.renderProfile)
    expect(statsAfter.lightsCount).toBe(statsBefore.lightsCount)
    expect(statsAfter.shadowMapEnabled).toBe(statsBefore.shadowMapEnabled)
    expect(statsAfter.envMap).toBe(statsBefore.envMap)
    expect(statsAfter.composerPasses).toBe(statsBefore.composerPasses)

    // Same pose + same content ⇒ same pixels (±3/channel guards dithering).
    const pixelsAfter = await samplePixels(page)
    for (let i = 0; i < pixelsBefore.length; i++) {
      const b = pixelsBefore[i]
      const a = pixelsAfter[i]
      expect(Math.abs(a.r - b.r), `pixel ${i} R`).toBeLessThanOrEqual(3)
      expect(Math.abs(a.g - b.g), `pixel ${i} G`).toBeLessThanOrEqual(3)
      expect(Math.abs(a.b - b.b), `pixel ${i} B`).toBeLessThanOrEqual(3)
    }
  })

  // ── leak bar: "geometry disposed deterministically" ────────────────────────

  /** A 30-node view — big enough that a per-rebuild leak of even one
   * geometry/texture is a +48 signal over the churn, small enough to rebuild
   * fast on SwiftShader. */
  function churnDsl(): string {
    let containers = ''
    for (let i = 0; i < 30; i++) containers += `      c${i} = container "Service ${i}" "Does ${i}" "Node.js"\n`
    let rels = ''
    for (let i = 0; i + 1 < 30; i += 3) rels += `    c${i} -> c${i + 1} "calls"\n`
    return `workspace "Churn" {\n  model {\n    platform = softwareSystem "Platform" "Big" {\n${containers}    }\n${rels}  }\n  views {\n    container platform { include * autoLayout }\n  }\n}`
  }

  const readStats = (page: Page) => page.evaluate(() => window.__scene3d!.sceneStats())

  test('50 full-rebuild churns leave the GPU allocation plateau flat (leak gate)', async ({ page }) => {
    await loginIfNeeded(page)
    await importDsl(page, churnDsl())
    await pinUnlitSkin(page)
    await enter3d(page)

    // Every preset flip busts the build signature → clearRoot + full rebuild,
    // the same path a diagram switch takes. Alternate through the REAL buttons.
    const flip = async (p: 'tilt' | 'iso') => {
      await page.locator(`[data-testid="camera-preset-${p}"]`).click()
      await page.waitForTimeout(120)
    }

    // Warm-up: one build of each preset fills every module cache (icon
    // textures, shared SDFs, troika atlas) to its plateau.
    await flip('tilt')
    await flip('iso')
    await page.waitForFunction(() => !window.__scene3d!.isCameraAnimating(), undefined, { timeout: 15000 })
    const base = await readStats(page)

    for (let i = 0; i < 48; i++) await flip(i % 2 ? 'iso' : 'tilt') // ends on iso = base preset
    await page.waitForFunction(() => !window.__scene3d!.isCameraAnimating(), undefined, { timeout: 15000 })
    const after = await readStats(page)

    console.log('[LEAK churn]', JSON.stringify({ base, after }))
    // Deterministic dispose: the counts RETURN to the plateau, exactly.
    expect(after.geometries).toBe(base.geometries)
    expect(after.textures).toBe(base.textures)
    expect(after.texts).toBe(base.texts)
    expect(after.meshes).toBe(base.meshes)
    expect(after.nodes).toBe(base.nodes)
  })

  test('3D↔2D mount cycles: dispose residue is tiny and stable, remounts return to the plateau', async ({ page }) => {
    await loginIfNeeded(page)
    await importDsl(page, churnDsl())
    await pinUnlitSkin(page)
    await enter3d(page)
    const first = await readStats(page)

    const residues: { geometries: number; textures: number }[] = []
    const plateaus: Scene3dSceneStats[] = []
    for (let cycle = 0; cycle < 5; cycle++) {
      await page.locator('[data-testid="view-2d"]').click()
      // Exit morph → host unmounts the board → dispose() stamps the residue.
      await page.waitForFunction(() => !window.__scene3d && !!window.__scene3dDisposeResidue, undefined, {
        timeout: 15000,
      })
      residues.push((await page.evaluate(() => window.__scene3dDisposeResidue))!)
      await enter3d(page)
      plateaus.push(await readStats(page))
    }

    console.log('[LEAK cycles]', JSON.stringify({ first, residues, plateaus }))
    for (const r of residues) {
      // Small fixed residue is legit (troika's module-global SDF atlas); a
      // missed dispose of board content (~hundreds of geometries) is not.
      expect(r.geometries).toBeLessThanOrEqual(10)
      expect(r.textures).toBeLessThanOrEqual(10)
    }
    // The residue must not CLIMB across cycles — climbing = a per-mount leak.
    expect(residues[residues.length - 1].geometries).toBe(residues[0].geometries)
    expect(residues[residues.length - 1].textures).toBe(residues[0].textures)
    // And every remount rebuilds the exact same board at the same plateau.
    for (const p of plateaus) {
      expect(p.nodes).toBe(first.nodes)
      expect(p.texts).toBe(first.texts)
      expect(p.meshes).toBe(first.meshes)
      expect(p.geometries).toBe(plateaus[0].geometries)
      expect(p.textures).toBe(plateaus[0].textures)
    }
  })

  // ── showcase mode: slow auto-orbit, pauses on interaction ──────────────────

  test('showcase mode: viewer auto-orbit drifts, pauses on interaction, resumes, and hides under reduced motion', async ({
    page,
    context,
  }) => {
    await loginIfNeeded(page)
    await importDsl(page, DSL)

    await page.getByRole('button', { name: /Partager|Share/ }).first().click()
    const dialog = page.locator('[role="dialog"]')
    await dialog.getByRole('switch').first().click()
    const urlText = await dialog.locator('text=/\\/share\\//').first().innerText({ timeout: 15000 })
    const shareUrl = urlText.match(/https?:\/\/\S+\/share\/\S+/)?.[0]
    expect(shareUrl).toBeTruthy()

    const visitor = await context.newPage()
    await visitor.goto(`${shareUrl}?view=3d`)
    await visitor.waitForFunction(
      () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
      undefined,
      { timeout: 30000 },
    )
    const azimuth = () => visitor.evaluate(() => window.__scene3d!.getPose().azimuth)

    // Event-based waits, NOT fixed windows: a cold viewer can re-run its data
    // effect late (async skin resolve → a fresh enter tween), and SwiftShader
    // first-frame shader compiles stall rAF so drift under-accrues in a fixed
    // window (the stepper clamps dt to 100ms/frame). Poll for the STATE.
    /** Eventually parked: two samples 400ms apart identical while no tween runs. */
    const expectParked = async () => {
      await expect
        .poll(
          async () => {
            if (await visitor.evaluate(() => window.__scene3d!.isCameraAnimating())) return 'animating'
            const a0 = await azimuth()
            await visitor.waitForTimeout(400)
            const a1 = await azimuth()
            return Math.abs(a1 - a0) < 0.01 ? 'parked' : 'moving'
          },
          { timeout: 15000 },
        )
        .toBe('parked')
    }
    /** Drift genuinely accrues >1° from here (however long the frames take). */
    const expectDrift = async () => {
      const a0 = await azimuth()
      await expect
        .poll(async () => Math.abs((await azimuth()) - a0), { timeout: 15000 })
        .toBeGreaterThan(1)
    }

    // Off by default: the camera parks after the enter choreography.
    await expectParked()

    // Regression: with the details sidebar open (the viewer default), the
    // camera cluster must sit LEFT of the opaque panel card, not underneath it.
    // Hit-test the button's center so the failure names the occluder instead of
    // a click timeout.
    await expect(visitor.locator('[data-testid="viewer-details-sidebar-shell"]')).toBeVisible()
    const occluder = await visitor.locator('[data-testid="viewer-showcase"]').evaluate((btn) => {
      const r = btn.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (btn === hit || btn.contains(hit)) return null
      return hit ? `${hit.tagName}.${String((hit as HTMLElement).className)}` : 'nothing'
    })
    expect(occluder, `viewer-showcase is covered by ${occluder}`).toBeNull()

    // Toggle on → slow drift (~6°/s).
    await visitor.locator('[data-testid="viewer-showcase"]').click()
    expect((await visitor.evaluate(() => window.__scene3d!.showcaseInfo())).on).toBe(true)
    await expectDrift()

    // A real orbit drag pauses the drift…
    const box = (await visitor.locator('[data-testid="viewer-canvas-3d"] canvas').boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await visitor.mouse.move(cx, cy)
    await visitor.mouse.down()
    await visitor.mouse.move(cx + 60, cy, { steps: 5 })
    await visitor.mouse.up()
    expect((await visitor.evaluate(() => window.__scene3d!.showcaseInfo())).holding).toBe(true)
    const held0 = await azimuth()
    await visitor.waitForTimeout(500)
    // still inside the 2.5s hold window: not a single degree moved
    expect((await visitor.evaluate(() => window.__scene3d!.showcaseInfo())).holding).toBe(true)
    expect(Math.abs((await azimuth()) - held0)).toBeLessThan(0.01)

    // …and it resumes once the hold window expires.
    await expectDrift()

    // Toggle off → parked again.
    await visitor.locator('[data-testid="viewer-showcase"]').click()
    await expectParked()
    await visitor.close()

    // Reduced motion: the toggle isn't even offered.
    const rm = await context.newPage()
    await rm.emulateMedia({ reducedMotion: 'reduce' })
    await rm.goto(`${shareUrl}?view=3d`)
    await rm.waitForFunction(() => !!window.__scene3d && window.__scene3d.nodeCount() > 0, undefined, {
      timeout: 30000,
    })
    await expect(rm.locator('[data-testid="camera-controls"]')).toBeVisible()
    await expect(rm.locator('[data-testid="viewer-showcase"]')).toHaveCount(0)
    await rm.close()
  })
})
