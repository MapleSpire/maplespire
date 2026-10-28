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
 * Model Viewer regression suite — drives the REAL UI (dev login, fresh
 * landscape, Structurizr import, tiles/edges/panels/breadcrumb, the 2D
 * drill-down zoom and the 3D board drill) against the isolated 3D stack:
 *
 *   npx playwright test --project=view3d e2e/view3d-model-viewer.spec.ts
 *
 * Golden rules honored:
 * - Every ACTION goes through pointer/keyboard on the real UI; `__scene3d` /
 *   `__modelStore` are read-only assertion probes (dev-only globals).
 * - No fixed-window timing bets: transition assertions either widen the window
 *   through the real zoom-speed control or poll for a settled end state.
 * - Each test builds its OWN fresh landscape (the shared stack's default
 *   workspace is a 1600-object stress model — unusable as a fixture).
 */

const NORTHWIND_DSL = `workspace "Northwind" {
    model {
        customer = person "Customer" "Shops and places orders"
        auth = softwareSystem "Auth provider" "Federated identity"
        storefront = softwareSystem "Storefront" "Customer-facing commerce experience" {
            web = container "Web app" "Single-page storefront" "React" {
                cart = component "Cart" "Basket state and totals"
                checkout = component "Checkout" "Payment capture flow"
            }
            bff = container "Storefront BFF" "Backend-for-frontend gateway" "Node.js"
        }
        orders = softwareSystem "Order management" "Cart, checkout and order lifecycle" {
            api = container "Orders API" "Order orchestration" "Node.js" {
                ctrl = component "Order controller" "REST endpoints"
                pricing = component "Pricing engine" "Discounts and totals"
            }
            db = container "Orders database" "Order records" "PostgreSQL" {
                tags "Database"
            }
        }
        customer -> web "Browses and buys"
        web -> auth "Verifies identity"
        web -> bff "Calls"
        storefront -> orders "Places orders"
        web -> api "Places order"
        checkout -> ctrl "Submits order"
        api -> db "Reads and writes"
        ctrl -> pricing "Prices"
    }
    views {
        systemContext storefront { include *  autoLayout }
        container storefront { include *  autoLayout }
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

/** Create a fresh landscape (unique name) and land on it — isolates the test
 * from the shared stack's accumulated default workspace. */
async function createFreshLandscape(page: Page): Promise<string> {
  const name = `viewer-e2e-${Date.now()}`
  await page.locator('[data-testid="nav-menu"]').click()
  await page.locator('[data-testid="workspace-landscapes"]').click()
  await page.locator('[data-testid="new-landscape-name"]').fill(name)
  await page.locator('[data-testid="new-landscape-add"]').click()
  // The switch re-boots the bridge; the trigger shows the new landscape name.
  await expect(page.locator('[data-testid="nav-menu"]')).toContainText(name, { timeout: 30000 })
  await page.keyboard.press('Escape')
  return name
}

/** Import the Northwind DSL (3 C4 levels) into the current landscape. */
async function importNorthwind(page: Page) {
  await page.locator('[data-testid="nav-menu"]').click()
  await page.locator('[data-testid="nav-diagrams"]').click()
  await page.locator('[data-testid="create-diagram-button"]').click()
  await page.locator('[data-testid="create-import"]').click()
  await page.locator('[data-testid="import-textarea"]').fill(NORTHWIND_DSL)
  await page.locator('[data-testid="import-parse"]').click()
  await page.locator('[data-testid="import-generate"]').click()
  await page.waitForURL('**/diagram/**', { timeout: 30000 })
  await page.waitForTimeout(1000) // let the import settle
}

async function openModelViewer(page: Page) {
  await page.locator('[data-testid="nav-menu"]').click()
  await page.locator('[data-testid="nav-model-viewer"]').click()
  await page.waitForURL('**/model-viewer', { timeout: 15000 })
}

// Exact-text on the NAME node: hasText would also match descriptions (the
// Storefront tile's "Customer-facing …" contains "Customer").
const tile = (page: Page, name: string) =>
  page.locator('[data-testid="mv-tile"]').filter({ has: page.getByText(name, { exact: true }) })

/** Read-only probe: sample the tile count of each drill zoom layer on every
 * animation frame until stopped. Returns the per-layer min/max over the frames
 * that carried both layers (frames = 0 means the zoom never ran). */
async function startZoomLayerRecorder(page: Page) {
  await page.evaluate(() => {
    const rec = { frames: 0, out: [] as number[], in: [] as number[], run: true }
    ;(window as unknown as { __mvZoomRec: typeof rec }).__mvZoomRec = rec
    const tick = () => {
      const layers = document.querySelectorAll<HTMLElement>('[data-testid="mv-zoom-layer"]')
      if (layers.length === 2) {
        rec.frames += 1
        for (const layer of layers) {
          rec[layer.dataset.layer as 'out' | 'in'].push(layer.querySelectorAll('[data-testid="mv-tile"]').length)
        }
      }
      if (rec.run) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopZoomLayerRecorder(page: Page) {
  const rec = await page.evaluate(() => {
    const r = (window as unknown as { __mvZoomRec: { frames: number; out: number[]; in: number[]; run: boolean } }).__mvZoomRec
    r.run = false
    return { frames: r.frames, out: r.out, in: r.in }
  })
  expect(rec.frames, 'the drill zoom never showed its two layers').toBeGreaterThan(0)
  return {
    outMin: Math.min(...rec.out),
    outMax: Math.max(...rec.out),
    inMin: Math.min(...rec.in),
    inMax: Math.max(...rec.in),
  }
}

// The isolated stack is a shared stateful backend — keep tests sequential.
test.describe.configure({ mode: 'serial' })

test.describe('Model viewer', () => {
  test('2D: context grid, hover emphasis, drill-down zoom, breadcrumb ascent, rollup panel', async ({ page }) => {
    await loginIfNeeded(page)
    await createFreshLandscape(page)
    await importNorthwind(page)
    await openModelViewer(page)

    // ── Context level: 4 tiles; expand only on decomposable systems ──────────
    await expect(page.locator('[data-testid="mv-tile"]')).toHaveCount(4)
    await expect(page.locator('[data-testid="mv-level"]')).toHaveText(/context|contexte/i)
    await expect(tile(page, 'Storefront').locator('[data-testid="mv-expand"]')).toHaveCount(1)
    await expect(tile(page, 'Customer').locator('[data-testid="mv-expand"]')).toHaveCount(0)
    // one level edge at context (storefront→orders); the cross-boundary
    // customer→web edge must NOT be drawn here
    await expect(page.locator('[data-testid="mv-edge"]')).toHaveCount(1)

    // ── Selection: panel opens read-only with the object's facts ─────────────
    await tile(page, 'Order management').click()
    await expect(page.locator('[data-testid="mv-object-panel"]')).toBeVisible()
    await expect(page.locator('[data-testid="mv-object-panel"]')).toContainText('Order management')

    // ── Drill-down zoom: widen the window through the REAL speed control,
    // then catch the twin WAAPI layers mid-flight ─────────────────────────────
    await page.locator('[data-testid="mv-view-options"]').click()
    const range = page.locator('input[type="range"]')
    const box = await range.boundingBox()
    if (box) await page.mouse.click(box.x + 2, box.y + box.height / 2) // ≈ 0.5× speed → ~1.1s zoom
    await page.locator('[data-testid="mv-view-options"]').click()

    // Every animation frame of the zoom must show BOTH levels populated: the
    // level window is fetched per level, and clearing it on the path change
    // once zoomed two EMPTY layers and popped the tiles in afterwards — while
    // a "two layers exist" check stayed green (2026-10-19).
    await startZoomLayerRecorder(page)
    await tile(page, 'Storefront').locator('[data-testid="mv-expand"]').click()
    // landed: boundary chrome + container level
    await expect(page.locator('[data-testid="mv-back"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid="mv-level"]')).toHaveText(/container|conteneur/i)
    await expect(page.locator('[data-testid="mv-tile"]')).toHaveCount(2) // web, bff
    await expect(page.locator('[data-testid="mv-crumb-current"]')).toContainText('Storefront')
    expect(await stopZoomLayerRecorder(page)).toMatchObject({ outMin: 4, outMax: 4, inMin: 2, inMax: 2 })

    // ── Boundary Back ascends to the context level ────────────────────────────
    await startZoomLayerRecorder(page)
    await page.locator('[data-testid="mv-back"]').click()
    await expect(page.locator('[data-testid="mv-level"]')).toHaveText(/context|contexte/i, { timeout: 10000 })
    await expect(page.locator('[data-testid="mv-tile"]')).toHaveCount(4)
    expect(await stopZoomLayerRecorder(page)).toMatchObject({ outMin: 2, outMax: 2, inMin: 4, inMax: 4 })

    // ── Connection panel: the context edge rolls up the deeper connections ───
    await page.locator('[data-testid="mv-edge"]').click()
    const connPanel = page.locator('[data-testid="mv-conn-panel"]')
    await expect(connPanel).toBeVisible()
    await expect(connPanel).toContainText('Places orders')
    // lower rollups: web→api ("Places order") and checkout→ctrl ("Submits order")
    await expect(connPanel).toContainText('Web app')
    await expect(connPanel).toContainText('Orders API')
    await expect(connPanel).toContainText('Submits order')
    // the direct edge lives in the generated System Context diagram
    await expect(connPanel.locator('[data-testid="mv-conn-diagram"]')).toHaveCount(2)
  })

  test('2D: level warm-up follows intent — a sweep is free, a dwell warms one level, the drill needs no request', async ({ page }) => {
    await loginIfNeeded(page)
    await createFreshLandscape(page)
    await importNorthwind(page)
    await openModelViewer(page)
    await expect(page.locator('[data-testid="mv-tile"]')).toHaveCount(4)
    await page.waitForTimeout(1500) // let the level fetch / change feed settle before counting

    const levelRequests: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/model/viewer/level')) levelRequests.push(req.url())
    })

    // A pointer crossing the grid must not become a request per tile: the dwell
    // timer dies with each exit. (The model can hold hundreds of thousands of
    // objects — a sweep over 200 tiles would otherwise be 200 requests.)
    const centres: Array<{ x: number; y: number }> = []
    for (const t of await page.locator('[data-testid="mv-tile"]').all()) {
      const b = await t.boundingBox()
      if (b) centres.push({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    }
    for (const c of centres) await page.mouse.move(c.x, c.y)
    await page.mouse.move(2, 2)
    await page.waitForTimeout(500)
    expect(levelRequests, 'a sweep over every tile requested levels').toHaveLength(0)

    // Dwelling on a decomposable tile warms exactly that level, once.
    const box = await tile(page, 'Order management').boundingBox()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await expect.poll(() => levelRequests.length, { timeout: 5000 }).toBe(1)
    await page.waitForTimeout(400)
    expect(levelRequests).toHaveLength(1)

    // The drill and the way back then need no request at all.
    await startZoomLayerRecorder(page)
    await tile(page, 'Order management').locator('[data-testid="mv-expand"]').click()
    await expect(page.locator('[data-testid="mv-back"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid="mv-tile"]')).toHaveCount(2) // api, db
    expect(await stopZoomLayerRecorder(page)).toMatchObject({ outMin: 4, outMax: 4, inMin: 2, inMax: 2 })
    await page.locator('[data-testid="mv-back"]').click()
    await expect(page.locator('[data-testid="mv-tile"]')).toHaveCount(4, { timeout: 10000 })
    await expect(page.locator('[data-testid="mv-level"]')).toHaveText(/context|contexte/i)
    expect(levelRequests, 'the drill or the way back fetched a level that was warm').toHaveLength(1)
  })

  test('2D: the drill zooms about the opened tile — the pivot never slides across the screen', async ({ page }) => {
    await loginIfNeeded(page)
    await createFreshLandscape(page)
    await importNorthwind(page)
    await openModelViewer(page)
    await expect(page.locator('[data-testid="mv-tile"]')).toHaveCount(4)

    // Slow the zoom through the REAL speed control so sampling has room.
    await page.locator('[data-testid="mv-view-options"]').click()
    const range = page.locator('input[type="range"]')
    const rangeBox = await range.boundingBox()
    if (rangeBox) await page.mouse.click(rangeBox.x + 2, rangeBox.y + rangeBox.height / 2)
    await page.locator('[data-testid="mv-view-options"]').click()

    const viewport = await page.locator('[data-testid="mv-viewport"]').boundingBox()
    const tileBox = await tile(page, 'Order management').boundingBox()
    const focal = {
      x: tileBox!.x + tileBox!.width / 2 - viewport!.x,
      y: tileBox!.y + tileBox!.height / 2 - viewport!.y,
    }

    // Freeze the app's own animations at fixed fractions of their duration and
    // find, for each layer, the point the zoom is centred on: the fixed point of
    // x → s·x + e. The sampler is ARMED BEFORE the click and fires from a
    // MutationObserver the moment both zoom layers exist, sampling
    // synchronously (getComputedStyle recomputes a paused animation's current
    // time on read). Sampling after the click returned raced the zoom itself:
    // under load the zoom had already landed (2026-10-25, 0 samples).
    type PivotRow = { layer: string; frac: number; s: number; cx: number | null; cy: number | null }
    const armPivotSampler = () =>
      page.evaluate(() => {
        const w = window as unknown as { __mvPivots?: PivotRow[] }
        w.__mvPivots = undefined
        const sample = (): boolean => {
          const layers = [...document.querySelectorAll<HTMLElement>('[data-testid="mv-zoom-layer"]')]
          const animations = document.getAnimations()
          if (layers.length !== 2 || animations.length < 2) return false
          animations.forEach((a) => a.pause())
          const rows: PivotRow[] = []
          for (const frac of [0.02, 0.05, 0.1, 0.2, 0.4, 0.6]) {
            animations.forEach((a) => {
              a.currentTime = frac * Number(a.effect?.getComputedTiming().duration ?? 0)
            })
            for (const layer of layers) {
              const m = new DOMMatrix(getComputedStyle(layer).transform)
              const scaling = Math.abs(1 - m.a) > 0.02
              rows.push({
                layer: layer.dataset.layer ?? '?',
                frac,
                s: m.a,
                cx: scaling ? m.e / (1 - m.a) : null,
                cy: scaling ? m.f / (1 - m.d) : null,
              })
            }
          }
          animations.forEach((a) => a.finish()) // let the zoom land
          w.__mvPivots = rows
          return true
        }
        const observer = new MutationObserver(() => { if (sample()) observer.disconnect() })
        observer.observe(document.querySelector('[data-testid="mv-viewport"]')!, { childList: true })
      })
    const collectPivots = async (): Promise<PivotRow[]> => {
      await page.waitForFunction(() => (window as unknown as { __mvPivots?: unknown }).__mvPivots !== undefined, null, { timeout: 10_000 })
      return page.evaluate(() => (window as unknown as { __mvPivots: PivotRow[] }).__mvPivots)
    }
    const expectPivotOnTile = (rows: PivotRow[], what: string) => {
      const scaling = rows.filter((r) => r.cx !== null)
      expect(scaling.length, `${what}: no sample was scaling`).toBeGreaterThan(6)
      for (const r of scaling) {
        const drift = Math.hypot(r.cx! - focal.x, r.cy! - focal.y)
        // Before the fix the pivot started at the viewport's top-left corner and
        // slid to the tile: ~1000 px away at the first frame.
        expect(drift, `${what}: the ${r.layer} layer zooms about (${r.cx!.toFixed(0)}, ${r.cy!.toFixed(0)}) at ${r.frac}, not the tile`).toBeLessThan(3)
      }
    }

    await armPivotSampler()
    await tile(page, 'Order management').locator('[data-testid="mv-expand"]').click()
    expectPivotOnTile(await collectPivots(), 'dive')
    await expect(page.locator('[data-testid="mv-back"]')).toBeVisible({ timeout: 10000 })

    // The way back shrinks into the same tile of the parent layout.
    await armPivotSampler()
    await page.locator('[data-testid="mv-back"]').click()
    expectPivotOnTile(await collectPivots(), 'ascent')
    await expect(page.locator('[data-testid="mv-tile"]')).toHaveCount(4, { timeout: 10000 })
  })

  test('3D: board renders the level; dblclick dives into the lower level and the breadcrumb ascends', async ({ page }) => {
    await loginIfNeeded(page)
    await createFreshLandscape(page)
    await importNorthwind(page)
    await openModelViewer(page)
    await expect(page.locator('[data-testid="mv-tile"]')).toHaveCount(4)

    // ── Enter 3D: the board shows the same 4-node context level ──────────────
    await page.locator('[data-testid="mv-view-3d"]').click()
    await page.waitForFunction(
      () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() === 4,
      undefined,
      { timeout: 30000 },
    )

    // ── Dblclick the Storefront node → the drill choreography ────────────────
    const storefrontId = await page.evaluate(
      () => window.__modelStore!.getState().objects.find((o) => o.name === 'Storefront')!.id,
    )
    const target = await page.evaluate((id) => {
      // node centre (its position is the tile's top-left; tiles are 170×150)
      const p = window.__scene3d!.nodeWorldPos(id)!
      const pose = window.__scene3d!.getPose()
      const D = Math.PI / 180
      const wx = p.x + 85
      const wz = p.y + 75
      // Unlike the editor, the viewer's canvas does NOT span the window (it
      // sits below the pill band) — project into the canvas rect, then offset.
      const rect = document.querySelector('[data-testid="mv-canvas-3d"] canvas')!.getBoundingClientRect()
      const cam = {
        x: pose.targetX + pose.distance * Math.sin(pose.polar * D) * Math.sin(pose.azimuth * D),
        y: pose.distance * Math.cos(pose.polar * D),
        z: pose.targetZ + pose.distance * Math.sin(pose.polar * D) * Math.cos(pose.azimuth * D),
      }
      const sub = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
      const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => a.x * b.x + a.y * b.y + a.z * b.z
      const cross = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => ({
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
      })
      const norm = (a: { x: number; y: number; z: number }) => {
        const l = Math.hypot(a.x, a.y, a.z)
        return { x: a.x / l, y: a.y / l, z: a.z / l }
      }
      const zc = norm(sub(cam, { x: pose.targetX, y: 0, z: pose.targetZ }))
      const xc = norm(cross({ x: 0, y: 1, z: 0 }, zc))
      const yc = cross(zc, xc)
      const v = sub({ x: wx, y: 10, z: wz }, cam)
      const zd = -dot(v, zc)
      const t = Math.tan((pose.fov / 2) * D)
      const aspect = rect.width / rect.height
      return {
        x: rect.left + ((dot(v, xc) / (zd * t * aspect) + 1) / 2) * rect.width,
        y: rect.top + ((1 - dot(v, yc) / (zd * t)) / 2) * rect.height,
      }
    }, storefrontId)
    const before = await page.evaluate(() => window.__scene3d!.getPose())
    await page.mouse.dblclick(target.x, target.y)

    // the level swaps to Storefront's containers and the camera settles on the
    // new framing (event-based: poll the end state, no fixed windows)
    await expect
      .poll(async () => page.evaluate(() => window.__scene3d?.nodeCount() ?? -1), { timeout: 15000 })
      .toBe(2)
    await expect(page.locator('[data-testid="mv-crumb-current"]')).toContainText('Storefront')
    await expect(page.locator('[data-testid="mv-level"]')).toHaveText(/container|conteneur/i)
    await expect
      .poll(async () => page.evaluate(() => window.__scene3d!.isCameraAnimating()), { timeout: 15000 })
      .toBe(false)
    // the drill genuinely moved the camera (a data swap alone keeps the pose)
    const after = await page.evaluate(() => window.__scene3d!.getPose())
    const moved =
      Math.abs(after.targetX - before.targetX) + Math.abs(after.targetZ - before.targetZ) + Math.abs(after.distance - before.distance)
    expect(moved).toBeGreaterThan(1)

    // ── Breadcrumb ascends back to the 4-node context board ──────────────────
    await page.locator('[data-testid="mv-crumb"]').first().click()
    await expect
      .poll(async () => page.evaluate(() => window.__scene3d?.nodeCount() ?? -1), { timeout: 15000 })
      .toBe(4)
    await expect(page.locator('[data-testid="mv-level"]')).toHaveText(/context|contexte/i)

    // ── Back to 2D: the grid returns where we left it ─────────────────────────
    await page.locator('[data-testid="mv-view-2d"]').click()
    await expect(page.locator('[data-testid="mv-tile"]')).toHaveCount(4)
  })
})
