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

import { readFileSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'

/**
 * 3D board regression suite — drives the REAL UI (dev login, Structurizr
 * import, pill toggle, trusted pointer drags, share dialog) against a running
 * dev stack. Run with the isolated 3D stack (README: scripts/dev3d-*.mjs):
 *
 *   npx playwright test --project=view3d        # E2E_3D_URL ?? localhost:5191
 *
 * Requirements: the frontend must run in Vite DEV mode (the `__scene3d`
 * introspection handle is dev-only) and the server with AUTH_DEV_LOGIN=on
 * (AUTH=off stacks skip the login step automatically).
 *
 * Golden rules honored here:
 * - No store-driven ACTIONS — every mutation goes through pointer/keyboard on
 *   the real UI. `__scene3d` / `__modelStore` are read-only assertion probes.
 * - After any view/preset flip, wait for `isCameraAnimating() === false`
 *   before computing coordinates (the morph keeps moving content ~850ms).
 */

// ── introspection contracts (dev-only globals) ───────────────────────────────

const STOREFRONT_DSL = `workspace "Northwind" {
    model {
        customer = person "Customer" "Person"
        auth = softwareSystem "Auth provider" "Identity & tokens"
        storefront = softwareSystem "Storefront platform" "Customer-facing commerce" {
            web = container "Web app" "Single-page app" "React"
            api = container "API service" "Core platform logic" "Node.js"
            db = container "Orders database" "Document storage" "PostgreSQL" {
                tags "Database"
            }
        }
        customer -> web "1. Log in"
        web -> auth "2. Verify"
        web -> api "3. Request"
        api -> db "4. Query"
    }
    views {
        container storefront { include *  autoLayout }
    }
}`

// ── shared steps (all through the real UI) ───────────────────────────────────

async function loginIfNeeded(page: Page) {
  // Target the login route directly: AUTH=on renders the dev-login form there;
  // AUTH=off (or an authed session) redirects straight into the app. Waiting on
  // the field (not a count-probe) avoids racing the initial render.
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

/** Import the storefront DSL as a fresh diagram and land in the editor on it. */
async function importStorefront(page: Page) {
  await page.locator('[data-testid="nav-menu"]').click()
  await page.locator('[data-testid="nav-diagrams"]').click()
  await page.locator('[data-testid="create-diagram-button"]').click()
  await page.locator('[data-testid="create-import"]').click()
  await page.locator('[data-testid="import-textarea"]').fill(STOREFRONT_DSL)
  await page.locator('[data-testid="import-parse"]').click()
  await page.locator('[data-testid="import-generate"]').click()
  await page.waitForURL('**/diagram/**', { timeout: 30000 })
  // let the import settle + first zoom-to-fit land
  await page.waitForTimeout(1500)
}

async function enter3d(page: Page) {
  await page.locator('[data-testid="view-3d"]').click()
  await page.waitForFunction(
    () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
    undefined,
    { timeout: 30000 },
  )
}

/** Durability gate before a reload-persistence assertion (the boot suite's
 * flushLocal): let the bridge's debounced flushWrite commit + automerge-repo's
 * auto-save settle, else the reload honestly races the write pipeline — the
 * validation workspace has accumulated enough docs that the old incidental
 * delays no longer cover it. */
async function flushSync(page: Page) {
  await page.waitForTimeout(1500) // > WRITE_DEBOUNCE_MS + repo auto-save settle
  await page
    .evaluate(async () => {
      const f = (window as unknown as { __repoFlush?: () => Promise<void> }).__repoFlush
      if (f) await f()
    })
    .catch(() => {})
}

/** Pin the test diagram to the UNLIT baseline skin ('default') through the
 * real diagram-settings panel (visible whenever nothing is selected). The
 * pixel/perf suites are the UNLIT-rendering contract: they must keep
 * exercising the unlit pipeline even as individual themes migrate to the lit
 * (PBR) profile — 'default' is the unlit reference and is never scheduled for
 * migration. The override lives on the test's own freshly imported diagram,
 * so there is nothing to restore afterwards. ('default' is deliberately not
 * in the shop, hence the per-diagram select rather than a shop equip.) */
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

/** World point (on the lifted card face) → viewport css px, from the live pose.
 * Mirrors camera.ts posePosition/lookAt so drags aim at real screen pixels. */
async function worldToScreen(page: Page, wx: number, lift: number, wz: number) {
  return page.evaluate(
    ([wx, lift, wz]) => {
      const pose = window.__scene3d!.getPose()
      const D = Math.PI / 180
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
      const v = sub({ x: wx, y: lift, z: wz }, cam)
      const zd = -dot(v, zc)
      const t = Math.tan((pose.fov / 2) * D)
      const aspect = innerWidth / innerHeight
      return {
        x: ((dot(v, xc) / (zd * t * aspect) + 1) / 2) * innerWidth,
        y: ((1 - dot(v, yc) / (zd * t)) / 2) * innerHeight,
      }
    },
    [wx, lift, wz] as [number, number, number],
  )
}

// The isolated stack is a shared stateful backend — keep tests sequential.
test.describe.configure({ mode: 'serial' })

test.describe('3D board', () => {
  test('toggle renders the board at the design pose and remembers the mode per diagram', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)
    await pinUnlitSkin(page)
    await enter3d(page)

    // exact design camera: Iso = polar 55 / azimuth 40 (editor3d.css)
    const pose = await page.evaluate(() => window.__scene3d!.getPose())
    expect(pose.polar).toBeCloseTo(55, 5)
    expect(pose.azimuth).toBeCloseTo(40, 5)
    expect(await page.evaluate(() => window.__scene3d!.nodeCount())).toBeGreaterThan(0)

    // Render-profile contract (PBR migration ground truth): an unlit theme
    // reports itself as such — no GPU lights, no shadow map, no IBL env, no
    // composer, nothing casting. Lit themes get their own gate suite; THIS
    // suite pins the unlit pipeline and must stay green through the migration.
    const stats = await page.evaluate(() => window.__scene3d!.sceneStats())
    expect(stats.renderProfile, 'default skin renders unlit').toBe('unlit')
    expect(stats.lightsCount, 'no GPU lights in the unlit scene').toBe(0)
    expect(stats.shadowMapEnabled, 'shadow maps off in unlit').toBe(false)
    expect(stats.envMap, 'no IBL environment in unlit').toBe(false)
    expect(stats.composerPasses, 'direct render, no composer').toBe(0)
    expect(stats.shadowCasters, 'nothing casts GPU shadows in unlit').toBe(0)

    // REGRESSION (user-reported): connections must be VISIBLE, not just
    // raycastable — a permanently transparent floor slab painted over the
    // opaque non-depth-writing ribbons (and splashed the ground blob across
    // the board as a giant circle). Pixels + the layering invariant, both.
    const layer = await page.evaluate(() => {
      const s = window.__scene3d!
      // at rest the slab must be back to opaque + depth-writing (floorAlpha 1)
      const floorState = s.floorFadeState()
      // Sample MANY pointer-reachable connection pixels plus one bare-floor
      // pixel. A single sample is not enough: the pickable strip is a couple
      // of px wider than the painted core (antialiased edge), and a top-down
      // scan meets the strip at exactly that edge — under curved connections
      // (the default shape) the first hit deterministically reads pure floor.
      // The regression this guards (ribbons painted over by a transparent
      // slab) blanks the WHOLE strip, so "some sampled pixel contrasts" is
      // the honest form of "lines actually render".
      const conns: { r: number; g: number; b: number }[] = []
      let floor: { r: number; g: number; b: number } | null = null
      for (let y = 100; y < innerHeight - 120 && (conns.length < 60 || !floor); y += 3) {
        for (let x = 80; x < innerWidth - 90 && (conns.length < 60 || !floor); x += 3) {
          const el = document.elementFromPoint(x, y)
          if (!el || !el.closest('[data-testid="canvas-3d"]')) continue
          const p = s.pickAt(x, y)
          if (p && p.kind === 'connection' && conns.length < 60) conns.push(s.readPixel(x, y))
          else if (!floor && !p) floor = s.readPixel(x, y)
        }
      }
      return { floorState, conns, floor }
    })
    expect(layer.floorState.some((f) => !f.transparent && f.depthWrite), 'slab opaque + depth-writing at rest').toBe(true)
    expect(layer.conns.length, 'connection ribbons are pointer-reachable').toBeGreaterThan(0)
    expect(layer.floor, 'a bare floor point is pointer-reachable').toBeTruthy()
    const dist = Math.max(
      ...layer.conns.map(
        (c) => Math.abs(c.r - layer.floor!.r) + Math.abs(c.g - layer.floor!.g) + Math.abs(c.b - layer.floor!.b),
      ),
    )
    expect(dist, 'ribbon pixels must differ from the slab (lines actually render)').toBeGreaterThan(20)

    // per-diagram persistence: a reload restores straight into 3D
    await page.reload()
    await page.waitForFunction(
      () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
      undefined,
      { timeout: 30000 },
    )
    await expect(page.locator('[data-testid="canvas-3d"]')).toHaveCount(1)
  })

  test('dragging a card forks the 3D layer, leaves 2D untouched, and survives a reload', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)
    await enter3d(page)

    // Pick a card whose face projects into the UNOBSTRUCTED central canvas —
    // the floating panels (left ~330px, right ~350px) sit above the canvas and
    // would swallow the pointer, exactly like they would for a real user.
    const vp = page.viewportSize()!
    const candidates = await page.evaluate(() => {
      const s = window.__scene3d!
      return s.nodeIds().map((id) => ({ id, p: s.nodeWorldPos(id)! }))
    })
    let id = ''
    let before = { x: 0, y: 0 }
    let from = { x: 0, y: 0 }
    for (const c of candidates) {
      const pt = await worldToScreen(page, c.p.x + 50, 18, c.p.y + 40)
      if (pt.x > 345 && pt.x < vp.width - 480 && pt.y > 90 && pt.y < vp.height - 90) {
        id = c.id
        before = c.p
        from = pt
        break
      }
    }
    expect(id, 'no card projects into the unobstructed canvas area').toBeTruthy()
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (120 * i) / 8, from.y + (50 * i) / 8)
    await page.mouse.up()

    // Drop-snap (USER BUG), refined by smart guides: on release each axis
    // either clips to the half-grid (the 2D engine's gridSize 20 / 2 = 10) or
    // keeps a guide-aligned coordinate when that axis was guide-captured at
    // the drop (the capture behaviour itself is covered by the dedicated
    // guide test below). Wait for the snapped store echo to land in the scene.
    await page.waitForFunction(
      (id) => {
        const s = window.__scene3d!
        const p = s.nodeWorldPos(id)
        if (!p) return false
        const g = s.smartGuideInfo().lastDropSnap
        const on = (v: number) => Math.abs(v / 10 - Math.round(v / 10)) < 1e-6
        return (on(p.x) || g.x) && (on(p.y) || g.y)
      },
      id,
      { timeout: 5000 },
    )
    const after = await page.evaluate((id) => window.__scene3d!.nodeWorldPos(id)!, id)
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(30)

    // fork happened: the Align affordance appears, 2D layer holds the original spot
    await expect(page.locator('[data-testid="camera-align-2d"]')).toHaveCount(1)
    const layers = await page.evaluate((id) => {
      const ms = window.__modelStore!.getState()
      const d = ms.diagrams.find((x) => x.id === ms.currentDiagramId)!
      return { l2d: d.layouts?.[id]?.position ?? null, l3d: d.layouts3d?.[id]?.position ?? null }
    }, id)
    expect(layers.l2d).toEqual({ x: before.x, y: before.y })
    expect(layers.l3d?.x).toBeCloseTo(after.x, 3)

    // 2D mode shows the 2D canvas again (the board unmounts)
    await page.locator('[data-testid="view-2d"]').click()
    await expect(page.locator('[data-testid="canvas-3d"]')).toHaveCount(0)
    await page.locator('[data-testid="view-3d"]').click()

    // synced: the 3D placement survives a full reload
    await flushSync(page)
    await page.reload()
    await page.waitForFunction(
      () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
      undefined,
      { timeout: 30000 },
    )
    const reloaded = await page.evaluate((id) => window.__scene3d!.nodeWorldPos(id)!, id)
    expect(reloaded.x).toBeCloseTo(after.x, 3)
    expect(reloaded.y).toBeCloseTo(after.y, 3)
  })

  test('dragging a 3D card exposes the shared alignment guide and snaps to it', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)
    await enter3d(page)

    const vp = page.viewportSize()!
    const candidates = await page.evaluate(() => {
      const scene = window.__scene3d!
      return scene.nodeIds().map((id) => ({ id, p: scene.nodeWorldPos(id)! }))
    })
    let moving: (typeof candidates)[number] | null = null
    let from = { x: 0, y: 0 }
    for (const candidate of candidates) {
      const point = await worldToScreen(page, candidate.p.x + 50, 18, candidate.p.y + 40)
      if (point.x > 345 && point.x < vp.width - 480 && point.y > 90 && point.y < vp.height - 90) {
        moving = candidate
        from = point
        break
      }
    }
    expect(moving, 'no pointer-reachable moving card').toBeTruthy()
    if (!moving) throw new Error('no pointer-reachable moving card')
    const target = candidates.find((candidate) => candidate.id !== moving.id)!
    expect(target, 'the guide needs a stationary peer').toBeTruthy()

    const canvas = page.locator('[data-testid="canvas-3d"] canvas')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    type SmartGuideSnapshot = { guides: Array<{ kind: string; axis: string }>; snapped: { x: boolean; y: boolean } }
    let active: SmartGuideSnapshot | null = null
    try {
      // Sweep across the target's x anchor. The camera is perspective, so the
      // small world-space sweep deliberately brackets the exact screen point.
      for (let offset = -20; offset <= 20 && !active; offset += 2) {
        const point = await worldToScreen(page, target.p.x + 50 + offset, 18, moving.p.y + 100)
        await page.mouse.move(point.x, point.y, { steps: 3 })
        const raw = await canvas.getAttribute('data-smart-guides-current')
        if (!raw) continue
        const parsed = JSON.parse(raw) as SmartGuideSnapshot | null
        if (parsed?.guides.some((guide) => guide.kind === 'alignment')) active = parsed
      }
      expect(active, 'a real 3D pointer drag should activate an alignment guide').not.toBeNull()
      expect(active!.guides.some((guide) => guide.kind === 'alignment')).toBe(true)
      expect(active!.snapped.x || active!.snapped.y).toBe(true)
    } finally {
      await page.mouse.up()
    }
    expect(await canvas.getAttribute('data-smart-guides-current')).toBeNull()
    const last = JSON.parse((await canvas.getAttribute('data-smart-guides-last')) ?? '{}') as typeof active
    expect(last?.guides.some((guide) => guide.kind === 'alignment')).toBe(true)
  })

  test('presets, free orbit and reset', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)
    await enter3d(page)

    await page.locator('[data-testid="camera-preset-tilt"]').click()
    await page.waitForFunction(() => !window.__scene3d!.isCameraAnimating(), undefined, { timeout: 10000 })
    let pose = await page.evaluate(() => window.__scene3d!.getPose())
    expect(pose.polar).toBeCloseTo(32, 5)
    expect(pose.azimuth).toBeCloseTo(0, 5)

    // free orbit: drag on EMPTY space. Deterministic aim — grid-scan for a
    // point where (a) the pointer actually reaches the 3D canvas (no floating
    // chrome above it) and (b) the scene raycast picks NOTHING (cards, drums
    // and group platforms are draggable and would move instead of orbiting).
    const emptyPt = await page.evaluate(() => {
      for (let y = 110; y < innerHeight - 120; y += 48) {
        for (let x = 360; x < innerWidth - 380; x += 60) {
          const el = document.elementFromPoint(x, y)
          if (!el || !el.closest('[data-testid="canvas-3d"]')) continue
          if ((window.__scene3d as unknown as { pickAt(x: number, y: number): unknown }).pickAt(x, y)) continue
          return { x, y }
        }
      }
      return null
    })
    expect(emptyPt, 'no empty board point is pointer-reachable').toBeTruthy()
    await page.mouse.move(emptyPt!.x, emptyPt!.y)
    await page.mouse.down()
    await page.mouse.move(emptyPt!.x + 140, emptyPt!.y - 60, { steps: 6 })
    await page.mouse.up()
    pose = await page.evaluate(() => window.__scene3d!.getPose())
    expect(Math.abs(pose.azimuth - 0) + Math.abs(pose.polar - 32)).toBeGreaterThan(5)

    // …and reset tweens back to the active preset
    await page.locator('[data-testid="camera-reset"]').click()
    await page.waitForFunction(() => !window.__scene3d!.isCameraAnimating(), undefined, { timeout: 10000 })
    pose = await page.evaluate(() => window.__scene3d!.getPose())
    expect(pose.polar).toBeCloseTo(32, 5)
    expect(pose.azimuth).toBeCloseTo(0, 5)
  })

  test('share allow_3d gates the public viewer both ways', async ({ page, context }) => {
    await loginIfNeeded(page)
    await importStorefront(page)

    // create the link through the dialog
    await page.getByRole('button', { name: /Partager|Share/ }).first().click()
    const dialog = page.locator('[role="dialog"]')
    await dialog.getByRole('switch').first().click()
    const urlText = await dialog.locator('text=/\\/share\\//').first().innerText({ timeout: 15000 })
    const shareUrl = urlText.match(/https?:\/\/\S+\/share\/\S+/)?.[0]
    expect(shareUrl).toBeTruthy()

    // public viewer offers 3D and renders the board read-only
    const visitor = await context.newPage()
    await visitor.goto(shareUrl!)
    await visitor.locator('[data-testid="viewer-view-3d"]').click({ timeout: 20000 })
    await visitor.waitForFunction(
      () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
      undefined,
      { timeout: 30000 },
    )

    // untick Allow-3D → the toggle disappears for visitors
    const allow3dSwitch = dialog.locator('div', { hasText: /Autoriser la vue 3D|Allow 3D/ }).getByRole('switch').last()
    await allow3dSwitch.click()
    await page.waitForTimeout(1200)
    await visitor.reload()
    await visitor.waitForTimeout(2500)
    await expect(visitor.locator('[data-testid="viewer-view-3d"]')).toHaveCount(0)

    // re-enable → it comes back (leave the link permissive)
    await allow3dSwitch.click()
    await page.waitForTimeout(1200)
    await visitor.reload()
    await expect(visitor.locator('[data-testid="viewer-view-3d"]')).toHaveCount(1, { timeout: 15000 })
    await visitor.close()
  })

  test('connection edits in 3D land on the *3d twins only (bend, label, anchor, remove)', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)
    await enter3d(page)

    // Pick a connection whose ribbon AND label are pointer-reachable (on the
    // canvas, not under floating chrome) — same deterministic scan as the
    // orbit test, but demanding a specific raycast target.
    const findPick = (id: string | null, kind: string) =>
      page.evaluate(
        ([id, kind]) => {
          for (let sy = 100; sy < innerHeight - 110; sy += 2)
            for (let sx = 355; sx < innerWidth - 370; sx += 2) {
              const el = document.elementFromPoint(sx, sy)
              if (!el || !el.closest('[data-testid="canvas-3d"]')) continue
              const p = window.__scene3d!.pickAt(sx, sy)
              if (p && p.kind === kind && (id === null || p.id === id)) return { sx, sy, id: p.id, end: p.end ?? null }
            }
          return null
        },
        [id, kind] as [string | null, string],
      )

    let connId = ''
    let ribbon: { sx: number; sy: number } | null = null
    for (const cand of await page.evaluate(() => window.__scene3d!.connectionIds())) {
      const r = await findPick(cand, 'connection')
      const l = await findPick(cand, 'connLabel')
      if (r && l) {
        connId = cand
        ribbon = r
        break
      }
    }
    expect(connId, 'no connection has a reachable ribbon + label').toBeTruthy()

    // 1) clicking the ribbon selects the connection. Wait for the SCENE (not
    // just the store) to carry the selection — the edit handles and the
    // press-on-line gesture only arm once the setSelection effect lands.
    await page.mouse.click(ribbon!.sx, ribbon!.sy)
    await page.waitForFunction(
      (id) => {
        const sel = window.__modelStore!.getState().selectedItems
        return (
          sel.length === 1 &&
          sel[0].id === id &&
          sel[0].type === 'connection' &&
          window.__scene3d!.selectionIds().includes(id)
        )
      },
      connId,
      { timeout: 5000 },
    )

    const readConn = (id: string) =>
      page.evaluate((id) => {
        const c = window.__modelStore!.getState().connections.find((x) => x.id === id)!
        return {
          waypoints: c.waypoints ?? null,
          waypoints3d: c.waypoints3d ?? null,
          fromAnchor: c.fromAnchor ?? null,
          toAnchor: c.toAnchor ?? null,
          fromAnchor3d: c.fromAnchor3d ?? null,
          toAnchor3d: c.toAnchor3d ?? null,
          locked: c.lockedToAnchors ?? false,
          locked3d: c.lockedToAnchors3d ?? null,
          labelPosition: c.labelPosition ?? null,
          labelOffset: c.labelOffset ?? null,
          labelPosition3d: c.labelPosition3d ?? null,
          labelOffset3d: c.labelOffset3d ?? null,
          fromId: c.fromId,
          toId: c.toId,
        }
      }, id)
    const base = await readConn(connId)

    // 2) press on the selected line + drag → ONE MORE bend lands in
    // waypoints3d (the import's auto-layout may have pre-seeded bends; the
    // first 3D edit also fork-stamps the 2D routing into the twins).
    const baseBends = base.waypoints?.length ?? 0
    const press = await findPick(connId, 'connection')
    expect(press, 'selected ribbon no longer reachable').toBeTruthy()
    await page.mouse.move(press!.sx, press!.sy)
    await page.mouse.down()
    await page.mouse.move(press!.sx + 55, press!.sy + 20, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(
      ([id, n]) => (window.__modelStore!.getState().connections.find((x) => x.id === id)!.waypoints3d ?? []).length === n,
      [connId, baseBends + 1] as [string, number],
      { timeout: 5000 },
    )
    const preLabel = await readConn(connId)
    expect(preLabel.waypoints).toEqual(base.waypoints)
    // the rebuilt layer's label placement runs in slices after the frame
    // (Scene3D.runLabelJob, 2026-10-11): the plates move when it commits,
    // and the probe reports the scene busy until then
    await page.waitForFunction(() => !window.__scene3d!.isCameraAnimating(), undefined, { timeout: 10000 })

    // 3) sliding the label writes labelPosition3d/labelOffset3d, 2D untouched.
    // Compare against the POST-FORK snapshot — the fork already stamped the
    // twins with the 2D values, so "defined" would pass trivially.
    const labelPt = await findPick(connId, 'connLabel')
    expect(labelPt, 'label plate not reachable').toBeTruthy()
    await page.mouse.move(labelPt!.sx, labelPt!.sy)
    await page.mouse.down()
    await page.mouse.move(labelPt!.sx + 28, labelPt!.sy + 36, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(
      ([id, t0, o0]) => {
        const c = window.__modelStore!.getState().connections.find((x) => x.id === id)!
        return c.labelPosition3d !== undefined && (c.labelPosition3d !== t0 || c.labelOffset3d !== o0)
      },
      [connId, preLabel.labelPosition3d, preLabel.labelOffset3d] as [string, number | null, number | null],
      { timeout: 5000 },
    )
    const afterLabel = await readConn(connId)
    expect(afterLabel.labelOffset3d).toBeGreaterThanOrEqual(-40)
    expect(afterLabel.labelOffset3d).toBeLessThanOrEqual(40)
    expect(afterLabel.labelPosition).toEqual(base.labelPosition)
    expect(afterLabel.labelOffset).toEqual(base.labelOffset)
    await page.waitForFunction(() => !window.__scene3d!.isCameraAnimating(), undefined, { timeout: 10000 })

    // 4) dragging an endpoint dot re-anchors the 3D twin only. Aim the drop at
    // a KNOWN anchor — the geometric opposite of the current one — pulled 22%
    // inward so the pointer hovers the card while the plane-projected snap
    // point stays nearest to that anchor (WYSIWYG with the highlighted dot).
    const dot = await findPick(connId, 'connEndpoint')
    expect(dot, 'no endpoint dot reachable (they ride the card top rims)').toBeTruthy()
    const end = dot!.end as 'source' | 'target'
    const shapeId = end === 'source' ? base.fromId : base.toId
    const preAnchor = end === 'source' ? preLabel.fromAnchor3d : preLabel.toAnchor3d
    const targetAnchor = preAnchor == null ? 4 : (preAnchor + 6) % 12
    const aim = await page.evaluate(
      ([shapeId, ai]) => {
        const o = window.__modelStore!.getState().objects.find((x) => x.id === shapeId)!
        const p = window.__scene3d!.nodeWorldPos(shapeId)!
        const r = { x: p.x, y: p.y, w: o.size.width, h: o.size.height }
        // the engine/scene 12-anchor table (3 per side, corner radius 8 inset)
        const defs = [
          ['top', 0.2], ['top', 0.5], ['top', 0.8],
          ['right', 0.2], ['right', 0.5], ['right', 0.8],
          ['bottom', 0.2], ['bottom', 0.5], ['bottom', 0.8],
          ['left', 0.2], ['left', 0.5], ['left', 0.8],
        ] as [string, number][]
        const [side, ratio] = defs[ai as number]
        const pt =
          side === 'top'
            ? { x: r.x + 8 + ratio * Math.max(0, r.w - 16), y: r.y }
            : side === 'bottom'
              ? { x: r.x + 8 + ratio * Math.max(0, r.w - 16), y: r.y + r.h }
              : side === 'left'
                ? { x: r.x, y: r.y + 8 + ratio * Math.max(0, r.h - 16) }
                : { x: r.x + r.w, y: r.y + 8 + ratio * Math.max(0, r.h - 16) }
        const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
        return { x: pt.x + (c.x - pt.x) * 0.22, y: pt.y + (c.y - pt.y) * 0.22, planeY: window.__scene3d!.connEditPoints(window.__scene3d!.connectionIds()[0])!.planeY }
      },
      [shapeId, targetAnchor] as [string, number],
    )
    const dropPt = await worldToScreen(page, aim.x, aim.planeY, aim.y)
    await page.mouse.move(dot!.sx, dot!.sy)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++)
      await page.mouse.move(dot!.sx + ((dropPt.x - dot!.sx) * i) / 10, dot!.sy + ((dropPt.y - dot!.sy) * i) / 10)
    await page.mouse.up()
    await page.waitForFunction(
      ([id, end, want]) => {
        const c = window.__modelStore!.getState().connections.find((x) => x.id === id)!
        return (end === 'source' ? c.fromAnchor3d : c.toAnchor3d) === want && c.lockedToAnchors3d === true
      },
      [connId, end, targetAnchor] as [string, string, number],
      { timeout: 5000 },
    )
    const afterAnchor = await readConn(connId)
    expect(afterAnchor.locked).toBe(base.locked) // 2D lock untouched
    expect(afterAnchor.fromAnchor).toEqual(base.fromAnchor)
    expect(afterAnchor.toAnchor).toEqual(base.toAnchor)
    expect(afterAnchor.fromId).toBe(base.fromId)
    expect(afterAnchor.toId).toBe(base.toId)

    // 5) double-clicking a bend dot removes that bend from the 3D twin
    const bendDot = await findPick(connId, 'connWaypoint')
    expect(bendDot, 'bend dot not reachable').toBeTruthy()
    await page.mouse.dblclick(bendDot!.sx, bendDot!.sy)
    await page.waitForFunction(
      ([id, n]) => {
        const c = window.__modelStore!.getState().connections.find((x) => x.id === id)!
        return Array.isArray(c.waypoints3d) && c.waypoints3d.length === n
      },
      [connId, baseBends] as [string, number],
      { timeout: 5000 },
    )
    if (baseBends === 0) {
      // the "[] ≠ undefined" sentinel: no bends in 3D even if 2D grows some
      expect((await readConn(connId)).waypoints3d).toEqual([])
    }

    // 6) everything persists across a full reload; 2D routing still pristine
    await flushSync(page)
    await page.reload()
    await page.waitForFunction(
      () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
      undefined,
      { timeout: 30000 },
    )
    const final = await readConn(connId)
    expect(final.waypoints3d?.length).toBe(baseBends)
    expect(final.waypoints).toEqual(base.waypoints)
    expect(final.labelPosition3d).toBeCloseTo(afterLabel.labelPosition3d!, 5)
    expect(final.locked3d).toBe(true)
    expect(end === 'source' ? final.fromAnchor3d : final.toAnchor3d).toEqual(targetAnchor)
    expect(final.locked).toBe(base.locked)
    expect(final.fromAnchor).toEqual(base.fromAnchor)
    expect(final.toAnchor).toEqual(base.toAnchor)
  })

  test('the 2D↔3D switch is a crossfade morph: flat start, floor fade, framing handoff', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)

    // ── enter: the morph must START from the framing identity of the 2D
    // viewport (top-down, same zoom, same world centre) and land on the design
    // pose with the board dressing faded in. The start pose is asserted from a
    // deterministic probe — sampling mid-tween would race SwiftShader's first
    // (shader-compiling) frame.
    const before = await page.evaluate(() => window.__canvasEngine!.getViewport())
    const box2d = (await page.locator('[data-testid="canvas-2d"]').boundingBox())!
    await page.locator('[data-testid="view-3d"]').click()
    await page.waitForFunction(
      () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
      undefined,
      { timeout: 30000 },
    )
    const D = Math.PI / 180
    const start = (await page.evaluate(() => window.__scene3d!.enterStartPose()))!
    expect(start.polar, 'enter starts from the flat top-down reading').toBeLessThanOrEqual(1)
    expect(start.azimuth).toBe(0)
    // framing identity: same zoom (cssPx/worldPx) and same world point at centre
    const startZoom = box2d.height / (2 * start.distance * Math.tan((start.fov / 2) * D))
    expect(startZoom).toBeCloseTo(before.scale, 5)
    expect(start.targetX).toBeCloseTo((box2d.width / 2 - before.x) / before.scale, 3)
    expect(start.targetZ).toBeCloseTo((box2d.height / 2 - before.y) / before.scale, 3)
    // …landed on the design pose, board fully dressed
    const landed = await page.evaluate(() => ({ pose: window.__scene3d!.getPose(), floor: window.__scene3d!.floorAlpha() }))
    expect(landed.floor).toBeCloseTo(1, 5)
    expect(landed.pose.polar).toBeCloseTo(55, 5) // iso default
    expect(landed.pose.azimuth).toBeCloseTo(40, 5)

    // ── change the framing like a user (dolly in), then exit ──────────────────
    const box = (await page.locator('[data-testid="canvas-3d"]').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -300)
    // the wheel GLIDES to its target (CameraRig.dollySmooth) — read the pose
    // the exit will hand off only once it has landed
    await page.waitForFunction(() => !window.__scene3d!.isCameraAnimating(), undefined, { timeout: 5000 })
    const pre = await page.evaluate(() => window.__scene3d!.getPose())
    // the exit handoff the 2D canvas must receive (mirror of viewportForPose)
    const scaleRaw = box.height / (2 * pre.distance * Math.tan((pre.fov / 2) * D))
    const expScale = Math.min(4, Math.max(0.1, scaleRaw))
    const expX = box.width / 2 - pre.targetX * expScale
    const expY = box.height / 2 - pre.targetZ * expScale

    await page.locator('[data-testid="view-2d"]').click()
    // the overlay OUTLIVES the mode flip to play its exit choreography…
    await page.waitForTimeout(250)
    await expect(page.locator('[data-testid="canvas-3d"]')).toHaveCount(1)
    expect(await page.locator('[data-testid="canvas-3d"]').getAttribute('data-morph')).toMatch(/exit|bye/)
    const midExit = await page.evaluate(() => ({
      animating: window.__scene3d!.isCameraAnimating(),
      floor: window.__scene3d!.floorAlpha(),
    }))
    expect(midExit.animating, 'exit reverse-TWEENS (not a jump) without reduced motion').toBe(true)
    expect(midExit.floor, 'floor dressing fades OUT during the exit').toBeLessThan(0.999)
    // …the 2D canvas is already revealed beneath it (crossfade, not a blink)
    await expect(page.locator('[data-testid="canvas-2d"]')).toBeVisible()
    // …then unmounts, having handed the camera's framing to the 2D viewport
    await expect(page.locator('[data-testid="canvas-3d"]')).toHaveCount(0, { timeout: 4000 })
    const after = await page.evaluate(() => window.__canvasEngine!.getViewport())
    expect(after.scale).toBeCloseTo(expScale, 3)
    expect(after.x).toBeCloseTo(expX, 0)
    expect(after.y).toBeCloseTo(expY, 0)

    // ── prefers-reduced-motion: jump cut both ways ────────────────────────────
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator('[data-testid="view-3d"]').click()
    // the enter now starts once the shaders have linked (enterPending): read
    // the state at the FIRST moment it has started — a tweened enter would
    // still be at its flat start pose here, a jump cut is already landed
    await page.waitForFunction(
      () => !!window.__scene3d && window.__scene3d.nodeCount() > 0 && !window.__scene3d.enterPending(),
      undefined,
      { timeout: 30000, polling: 16 },
    )
    const cut = await page.evaluate(() => ({
      animating: window.__scene3d!.isCameraAnimating(),
      floor: window.__scene3d!.floorAlpha(),
      polar: window.__scene3d!.getPose().polar,
    }))
    expect(cut.animating).toBe(false)
    expect(cut.floor).toBe(1)
    expect(cut.polar).toBeCloseTo(55, 5)
    const t0 = Date.now()
    await page.locator('[data-testid="view-2d"]').click()
    await expect(page.locator('[data-testid="canvas-3d"]')).toHaveCount(0, { timeout: 2000 })
    expect(Date.now() - t0, 'reduced motion exits without the 850ms tween').toBeLessThan(1200)
    await page.emulateMedia({ reducedMotion: null })
  })

  test('theme 3D surface: cyberpunk pack dresses the board, default skin restores it', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)

    // remember the equipped skin so the shared backend is restored at the end
    const origSkinId = await page.evaluate(() => window.__canvasEngine!.skin?.id ?? 'studio')

    /** Equip a skin through the REAL shop UI (open → collection → equip → close). */
    const equip = async (skinId: string) => {
      const current = await page.evaluate(() => window.__canvasEngine!.skin?.id)
      if (current === skinId) return
      await page.locator('[data-testid="open-theme-shop"]').click()
      await page.locator('[data-testid="shop-tab-collection"]').click()
      await page.locator(`[data-testid="skin-equip-${skinId}"]`).click()
      await page.locator('[data-testid="shop-close"]').click()
      await page.waitForFunction(
        (id) => window.__canvasEngine!.skin?.id === id,
        skinId,
        { timeout: 10000 },
      )
    }

    try {
      await equip('cyberpunk')
      await enter3d(page)

      // the pack's full surface: gradient sky (environment), neon rims on every
      // card (object3d), a spinning drum (spec micro-animation)
      await page.waitForFunction(() => window.__scene3d!.theme3dInfo().hasTheme, undefined, { timeout: 10000 })
      const info = await page.evaluate(() => window.__scene3d!.theme3dInfo())
      expect(info.bgIsGradient, 'environment background gradient applied').toBe(true)
      expect(info.glowCount, 'edge-glow rim per card (4 cards in the storefront)').toBe(4)
      expect(info.motionCount, 'the database drum spins').toBe(1)

      // the 8-bit pack: pixel-art equirect SKY (the first theme art-directing
      // the environment background), dithered floorTexture, flat grid fracture
      // dissolving the board edges — all from embedded meta.assets + specs
      await equip('eightbit')
      await page.waitForFunction(() => {
        const a = window.__scene3d!.assetInfo()
        return a.bgIsEquirect && a.floorTextured && a.voxels > 0
      }, undefined, { timeout: 10000 })
      // the skin swap rebuilds the board and links its programs before the
      // next frame (Scene3D.scheduleCompile) — aim only at a settled board
      await page.waitForFunction(() => !window.__scene3d!.isCameraAnimating(), undefined, { timeout: 15000 })

      const voxelInfo = await page.evaluate(() => window.__scene3d!.voxelInfo())
      expect(voxelInfo.count).toBe(120)
      expect(voxelInfo.interactive).toBe(true)
      expect(voxelInfo.displaced).toBe(0)

      // Aim at a REAL visible instance (the instanced mesh exposes an id per
      // raycast hit), then drag it through the canvas like a user would.
      let target: { id: string; x: number; y: number; world: { x: number; y: number; z: number } } | null = null
      for (const fragment of voxelInfo.fragments) {
        const screen = await worldToScreen(page, fragment.x, fragment.y, fragment.z)
        if (screen.x < 0 || screen.y < 0 || screen.x > page.viewportSize()!.width || screen.y > page.viewportSize()!.height) continue
        const probe = await page.evaluate(([x, y]) => ({
          hit: window.__scene3d!.pickAt(x, y),
          hitsCanvas: document.elementFromPoint(x, y)?.tagName === 'CANVAS',
        }), [screen.x, screen.y] as [number, number])
        if (probe.hitsCanvas && probe.hit?.kind === 'voxel' && probe.hit.id === fragment.id) {
          target = { id: fragment.id, x: screen.x, y: screen.y, world: fragment }
          break
        }
      }
      expect(target, 'at least one loose edge fragment is visible and pickable').not.toBeNull()

      const selectionBefore = await page.evaluate(() => window.__scene3d!.selectionIds())
      await page.mouse.move(target!.x, target!.y)
      await expect(page.locator('[data-testid="canvas-3d"] canvas')).toHaveCSS('cursor', 'grab')
      // The fragment grabbed is whatever the pointer hits AT THE PRESS — in a
      // full suite run fragments can still be settling between the scan above
      // and here, so re-resolve the id at the exact press point instead of
      // assuming the scanned one (the assertion stays: that fragment moves).
      const before = await page.evaluate(([x, y]) => {
        const hit = window.__scene3d!.pickAt(x, y)
        const all = window.__scene3d!.voxelInfo().fragments
        return { id: hit?.kind === 'voxel' ? hit.id : null, all }
      }, [target!.x, target!.y] as [number, number])
      expect(before.id, 'the press lands on a loose fragment').not.toBeNull()
      const start = before.all.find((f) => f.id === before.id)!
      await page.mouse.down()
      await page.mouse.move(target!.x + 42, target!.y + 18, { steps: 8 })
      await page.mouse.up()

      await expect.poll(() => page.evaluate(() => window.__scene3d!.voxelInfo().displaced)).toBeGreaterThan(0)
      const moved = await page.evaluate((id) => window.__scene3d!.voxelInfo().fragments.find((f) => f.id === id)!, before.id!)
      expect(Math.hypot(moved.x - start.x, moved.z - start.z), `${before.id} follows the drag`).toBeGreaterThan(1)
      expect(await page.evaluate(() => window.__scene3d!.selectionIds())).toEqual(selectionBefore)

      // Scene interaction is deliberately ephemeral: a new Scene3D instance
      // reconstructs the deterministic fracture and starts with no offsets.
      await page.reload()
      if (!(await page.evaluate(() => !!window.__scene3d))) await enter3d(page)
      else {
        await page.waitForFunction(
          () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
          undefined,
          { timeout: 30000 },
        )
      }
      await page.waitForFunction(() => window.__scene3d!.voxelInfo().interactive, undefined, { timeout: 10000 })
      expect(await page.evaluate(() => window.__scene3d!.voxelInfo().displaced)).toBe(0)

      // A surface-free skin removes the whole pack (derived look). The unlit
      // baseline 'default' is the reference here — NOT 'studio', which ships
      // its own 3D lighting surface under the PBR migration. Pinned via the
      // per-diagram override (the real settings UI; 'default' isn't shopped).
      await page.locator('[data-testid="diagram-skin-select"]').selectOption('default')
      await page.waitForFunction(() => !window.__scene3d!.theme3dInfo().hasTheme, undefined, { timeout: 10000 })
      const restored = await page.evaluate(() => window.__scene3d!.theme3dInfo())
      expect(restored.glowCount).toBe(0)
      expect(restored.motionCount).toBe(0)
      expect(restored.bgIsGradient).toBe(false)
      const cleared = await page.evaluate(() => window.__scene3d!.assetInfo())
      expect(cleared.bgIsEquirect).toBe(false)
      expect(cleared.voxels).toBe(0)
    } finally {
      // never leave the shared validation workspace re-skinned; drop the
      // test-diagram override first so the global re-equip is observable
      // through the resolved skin (the override would mask it).
      await page.locator('[data-testid="diagram-skin-select"]').selectOption('').catch(() => {})
      await equip(origSkinId).catch(() => {})
    }
  })

  test('focus animates source connections and the bottom "color by" bars follow the tabs (2D parity)', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)
    await enter3d(page)

    // USER BUG: no "color by" tab active → NO bottom accent bar (the kit's
    // always-on tech strip was explicitly rejected; 2D shows nothing either)
    expect(await page.evaluate(() => window.__scene3d!.accentBars().length)).toBe(0)

    // ── pick a card WITH outgoing connections whose face projects into the
    // unobstructed canvas, and select it with a real click ──────────────────
    const vp = page.viewportSize()!
    const candidates = await page.evaluate(() => {
      const s = window.__scene3d!
      const ms = window.__modelStore!.getState()
      const board = new Set(s.connectionIds())
      return s
        .nodeIds()
        .map((id) => ({
          id,
          p: s.nodeWorldPos(id)!,
          out: ms.connections.filter((c) => board.has(c.id) && c.fromId === id).length,
        }))
        .filter((c) => c.out > 0)
    })
    let target: { id: string; out: number; pt: { x: number; y: number } } | null = null
    for (const c of candidates) {
      const pt = await worldToScreen(page, c.p.x + 50, 18, c.p.y + 40)
      if (pt.x > 345 && pt.x < vp.width - 480 && pt.y > 90 && pt.y < vp.height - 90) {
        target = { id: c.id, out: c.out, pt }
        break
      }
    }
    expect(target, 'a source card projects into the unobstructed canvas area').toBeTruthy()
    await page.mouse.click(target!.pt.x, target!.pt.y)
    await page.waitForFunction((id) => window.__scene3d!.selectionIds().includes(id), target!.id, { timeout: 5000 })

    // ── USER BUG: focusing a 3D shape must animate its source connections
    // like the 2D canvas — one flow unit per outgoing connection (default
    // style = traveling-dot) and the dot must actually travel ────────────────
    const flow0 = await page.evaluate(() => window.__scene3d!.flowInfo())
    expect(flow0.units, 'one focus animation per source connection').toBe(target!.out)
    expect(flow0.kinds.every((k) => k === 'traveling-dot'), 'default style is the traveling dot').toBe(true)
    expect(flow0.dotPos).toBeTruthy()
    // Assert PROGRESS on the animation phase, not world distance — the picked
    // path may be short and SwiftShader frames sparse. Three samples so no
    // cycle-wrap alignment can fake a standstill.
    await page.waitForTimeout(400)
    const flow1 = await page.evaluate(() => window.__scene3d!.flowInfo())
    await page.waitForTimeout(250)
    const flow2 = await page.evaluate(() => window.__scene3d!.flowInfo())
    const dt = (a: number | null, b: number | null) => {
      if (a === null || b === null) return 0
      const x = Math.abs(a - b)
      return Math.min(x, 1 - x) // the phase wraps at the cycle boundary
    }
    const progressed = Math.max(dt(flow0.phase, flow1.phase), dt(flow0.phase, flow2.phase), dt(flow1.phase, flow2.phase))
    expect(progressed, 'the dot advances along its path parameter').toBeGreaterThan(0.05)

    // 2D focus dim: source connections stay full, the rest drop to 15%
    // (board connections only — the model store holds the whole workspace)
    const alphas = await page.evaluate((id) => {
      const s = window.__scene3d!
      const ms = window.__modelStore!.getState()
      const from = new Map(ms.connections.map((c) => [c.id, c.fromId]))
      const board = s.connectionIds()
      return {
        mine: board.filter((cid) => from.get(cid) === id).map((cid) => s.connectionAlpha(cid)),
        others: board.filter((cid) => from.get(cid) !== id).map((cid) => s.connectionAlpha(cid)),
      }
    }, target!.id)
    expect(alphas.mine.every((a) => a !== null && a > 0.9), 'source connections stay bright').toBe(true)
    expect(alphas.others.length).toBeGreaterThan(0)
    expect(alphas.others.every((a) => a !== null && a < 0.2), 'other connections dim to 15%').toBe(true)

    // deselect on bare floor → focus animations stop (idle rAF can go quiet)
    const bare = await page.evaluate(() => {
      const s = window.__scene3d!
      for (let y = 100; y < innerHeight - 120; y += 4) {
        for (let x = 80; x < innerWidth - 90; x += 4) {
          const el = document.elementFromPoint(x, y)
          if (!el || !el.closest('[data-testid="canvas-3d"]')) continue
          if (!s.pickAt(x, y)) return { x, y }
        }
      }
      return null
    })
    expect(bare, 'a bare floor point is clickable').toBeTruthy()
    await page.mouse.click(bare!.x, bare!.y)
    await page.waitForFunction(() => window.__scene3d!.selectionIds().length === 0, undefined, { timeout: 5000 })
    expect(await page.evaluate(() => window.__scene3d!.flowInfo().units)).toBe(0)

    // ── USER BUG: the bottom accent bar must exist in 3D and follow the
    // Tags / Technology / Status tabs. The import creates every object with
    // status 'live' (mapper.ts); flip one card to 'down' through the REAL
    // sidebar so the status view carries two colors, then walk the tabs ─────
    await page.mouse.click(target!.pt.x, target!.pt.y)
    await page.waitForFunction((id) => window.__scene3d!.selectionIds().includes(id), target!.id, { timeout: 5000 })
    await page.locator('[data-testid="status-trigger"]').click()
    await page.locator('[data-testid="status-option-down"]').click()

    // status tab: every object carries a bar; the flipped card reads 'down'
    await page.locator('[data-testid="bottom-tab-status"]').click()
    await page.waitForFunction(() => window.__scene3d!.accentBars().length > 0, undefined, { timeout: 10000 })
    const statusBars = await page.evaluate(() => window.__scene3d!.accentBars())
    expect(statusBars.length, 'every status-carrying object shows a bar').toBe(5)
    expect(new Set(statusBars).size, "the 'down' card differs from the 'live' rest").toBe(2)

    // technology tab: React/Node.js cards + the PostgreSQL drum band, colors differ
    await page.locator('[data-testid="bottom-tab-technology"]').click()
    await page.waitForFunction(
      (prev) => {
        const bars = window.__scene3d!.accentBars()
        return bars.length >= 3 && bars.join() !== prev
      },
      statusBars.join(),
      { timeout: 10000 },
    )
    const techBars = await page.evaluate(() => window.__scene3d!.accentBars())
    expect(techBars.length, 'web + api cards and the db drum band').toBeGreaterThanOrEqual(3)
    expect(new Set(techBars).size, 'technology colors differ per tech').toBeGreaterThan(1)

    // toggling the tab off clears every accent bar again (no default strip)
    await page.locator('[data-testid="bottom-tab-technology"]').click()
    await page.waitForFunction(() => window.__scene3d!.accentBars().length === 0, undefined, { timeout: 10000 })
  })

  test('every connection animation style runs in 3D (USER BUG: strands & electric were stubbed)', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)
    await enter3d(page)

    // a source card in the unobstructed canvas + a bare-floor deselect point
    const vp = page.viewportSize()!
    const candidates = await page.evaluate(() => {
      const s = window.__scene3d!
      const ms = window.__modelStore!.getState()
      const board = new Set(s.connectionIds())
      return s
        .nodeIds()
        .map((id) => ({
          id,
          p: s.nodeWorldPos(id)!,
          out: ms.connections.filter((c) => board.has(c.id) && c.fromId === id).length,
        }))
        .filter((c) => c.out > 0)
    })
    let target: { id: string; pt: { x: number; y: number } } | null = null
    for (const c of candidates) {
      const pt = await worldToScreen(page, c.p.x + 50, 18, c.p.y + 40)
      if (pt.x > 345 && pt.x < vp.width - 480 && pt.y > 90 && pt.y < vp.height - 90) {
        target = { id: c.id, pt }
        break
      }
    }
    expect(target, 'a source card projects into the unobstructed canvas area').toBeTruthy()
    const bare = await page.evaluate(() => {
      const s = window.__scene3d!
      for (let y = 100; y < innerHeight - 120; y += 4) {
        for (let x = 80; x < innerWidth - 90; x += 4) {
          const el = document.elementFromPoint(x, y)
          if (!el || !el.closest('[data-testid="canvas-3d"]')) continue
          if (!s.pickAt(x, y)) return { x, y }
        }
      }
      return null
    })
    expect(bare, 'a bare floor point is clickable').toBeTruthy()

    const wrap = (a: number | null, b: number | null) => {
      if (a === null || b === null) return 0
      const x = Math.abs(a - b)
      return Math.min(x, 1 - x)
    }

    // The style picker lives in the diagram-settings panel (visible when
    // nothing is selected) — per style: deselect → pick style → re-select →
    // the unit must carry that style AND its phase must advance.
    const STYLES = ['strands', 'electric', 'pulse', 'lightning', 'neon-dash', 'gradient-flow', 'energy-beam', 'sparkle']
    for (const style of STYLES) {
      await page.mouse.click(bare!.x, bare!.y)
      await page.waitForFunction(() => window.__scene3d!.selectionIds().length === 0, undefined, { timeout: 5000 })
      await page.locator(`[data-testid="anim-style-${style}"]`).click()
      await page.mouse.click(target!.pt.x, target!.pt.y)
      await page.waitForFunction((id) => window.__scene3d!.selectionIds().includes(id), target!.id, { timeout: 5000 })
      await page.waitForFunction((s) => window.__scene3d!.flowInfo().kinds[0] === s, style, { timeout: 5000 })
      const p0 = await page.evaluate(() => window.__scene3d!.flowInfo().phase)
      await page.waitForTimeout(350)
      const p1 = await page.evaluate(() => window.__scene3d!.flowInfo().phase)
      await page.waitForTimeout(200)
      const p2 = await page.evaluate(() => window.__scene3d!.flowInfo().phase)
      const progressed = Math.max(wrap(p0, p1), wrap(p0, p2), wrap(p1, p2))
      expect(progressed, `${style} animates on the board`).toBeGreaterThan(0.03)
    }

    // 'none' kills the effect entirely
    await page.mouse.click(bare!.x, bare!.y)
    await page.waitForFunction(() => window.__scene3d!.selectionIds().length === 0, undefined, { timeout: 5000 })
    await page.locator('[data-testid="anim-style-none"]').click()
    await page.mouse.click(target!.pt.x, target!.pt.y)
    await page.waitForFunction((id) => window.__scene3d!.selectionIds().includes(id), target!.id, { timeout: 5000 })
    expect(await page.evaluate(() => window.__scene3d!.flowInfo().units)).toBe(0)
  })

  // USER REGRESSION 2026-10-10: "sur les shapes je vois des régressions sur la
  // police et la taille de la police et l'icône par rapport à avant". At the
  // default (fit-to-screen) framing every card had swapped its face for a
  // big Inter 700 title with no tech badge, subtitle or pill, and the drum
  // names were printed on the drums in bold with the badge moved onto the
  // lid. The base face (edfc9c6f7) is the contract at every framing.
  test('shape faces keep the base fonts, sizes and tech badges at the default framing (USER REGRESSION)', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)
    await enter3d(page)
    await page.waitForFunction(() => window.__scene3d!.techIcons().length >= 2, undefined, { timeout: 10000 })
    await page.waitForTimeout(300) // the settle-edge LOD pass
    // the faces are only read at their design size from the design pose: a
    // branch landed the enter morph on the fit pose, ~2x farther, and the
    // user saw every title at half size (2026-10-10)
    const pose = await page.evaluate(() => ({ at: window.__scene3d!.getPose(), base: window.__scene3d!.presetPose() }))
    expect(pose.at.distance / pose.base.distance, 'enter lands on the base design pose').toBeCloseTo(1, 1)
    const faces = await page.evaluate(() => window.__scene3d!.nodeFaces())
    expect(faces.length).toBe(await page.evaluate(() => window.__scene3d!.nodeCount()))
    const cards = faces.filter((f) => f.kind === 'card')
    const drums = faces.filter((f) => f.kind === 'store')
    expect(cards.length, 'the storefront board has cards').toBeGreaterThanOrEqual(3)
    expect(drums.length, 'the storefront board has the Orders database drum').toBe(1)
    for (const f of cards) {
      expect(f.title, `card ${f.id}: title`).toEqual({ font: 'inter600', size: 13, visible: true })
      expect(f.badge, `card ${f.id}: icon tile shown at its built size`).toEqual({ visible: true, scale: 1 })
      expect(f.foreignFonts, `card ${f.id}: no font the base face never used`).toEqual([])
    }
    // the React web app's tech tile is one of them
    expect(cards.some((f) => f.hasTech)).toBe(true)
    for (const f of drums) {
      expect(f.hasTech, 'the PostgreSQL drum has a technology').toBe(true)
      expect(f.title, `drum ${f.id}: name tag`).toEqual({ font: 'inter600', size: 10.5, visible: true })
      expect(f.badge, `drum ${f.id}: side badge shown at its built size`).toEqual({ visible: true, scale: 1 })
      expect(f.foreignFonts).toEqual([])
    }
  })

  test('grid toggle hides the floor dots; technology icons render on cards and drums (USER BUGS)', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)
    await enter3d(page)

    // icons: the import maps each element's technology onto obj.icon — the
    // web CARD carries the React tile, the db DRUM wears PostgreSQL. ('Node.js'
    // is not a registry name — the 2D engine draws nothing for it either; the
    // 3D tile falls back to the type glyph.)
    await page.waitForFunction(() => window.__scene3d!.techIcons().length >= 2, undefined, { timeout: 10000 })
    const icons = await page.evaluate(() => window.__scene3d!.techIcons())
    expect(icons).toEqual(expect.arrayContaining(['React', 'PostgreSQL']))

    // Cards use the exact same vertical hierarchy as 2D: centred icon, title,
    // description, then a centred and localized shape-type badge.
    const cardContent = await page.evaluate(() => {
      for (const id of window.__scene3d!.nodeIds()) {
        const items = window.__scene3d!.cardContentInfo(id)
        const roles = new Set(items.map((item) => item.role))
        if (roles.has('icon') && roles.has('title') && roles.has('description') && roles.has('typeBadge')) {
          return items
        }
      }
      return []
    })
    const byRole = Object.fromEntries(cardContent.map((item) => [item.role, item]))
    expect(Object.keys(byRole)).toEqual(expect.arrayContaining(['icon', 'title', 'description', 'typeBadge', 'typeBadgeText']))
    expect(new Set(cardContent.map((item) => item.x)).size).toBe(1)
    expect(byRole.icon.z).toBeLessThan(byRole.title.z)
    expect(byRole.title.z).toBeLessThan(byRole.description.z)
    expect(byRole.description.z).toBeLessThan(byRole.typeBadge.z)
    const { lineCount, fontSize } = byRole.description
    // Asserted BEFORE they are used in arithmetic. They are optional on the
    // probe (only the description role carries them), and the layout maths
    // below silently produces NaN on `undefined` — an assertion that then
    // fails for the wrong reason.
    expect(lineCount, 'the description role must report its line count').toBeDefined()
    expect(fontSize, 'the description role must report its font size').toBeDefined()
    expect(lineCount).toBeGreaterThanOrEqual(1)
    expect(lineCount).toBeLessThanOrEqual(2)
    expect(fontSize).toBeGreaterThanOrEqual(9)
    const descriptionBottom = byRole.description.z + lineCount! * fontSize! * 1.15
    expect(byRole.typeBadge.z - descriptionBottom).toBeGreaterThanOrEqual(4.5)
    expect(byRole.typeBadgeText.text).toMatch(/^(Person|System|App|Component)$/)

    // grid: the REAL chrome button must drive the board's dots both ways
    expect(await page.evaluate(() => window.__scene3d!.gridInfo())).toEqual({ showGrid: true, dotsVisible: true })
    await page.locator('[data-testid="toggle-grid"]').click()
    await page.waitForFunction(() => {
      const g = window.__scene3d!.gridInfo()
      return !g.showGrid && !g.dotsVisible
    }, undefined, { timeout: 5000 })
    await page.locator('[data-testid="toggle-grid"]').click()
    await page.waitForFunction(() => {
      const g = window.__scene3d!.gridInfo()
      return g.showGrid && g.dotsVisible
    }, undefined, { timeout: 5000 })
  })

  test('group platforms: click selects with a ring, member drags re-hug, platform drags carry members (USER BUGS)', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)
    await enter3d(page)

    // the imported container boundary is the diagram's one group
    const groupId = await page.evaluate(() => window.__scene3d!.groupInfo()[0]?.id)
    expect(groupId).toBeTruthy()
    const memberIds = await page.evaluate(
      (gid) => window.__modelStore!.getState().groups.find((g) => g.id === gid)!.objectIds,
      groupId,
    )
    expect(memberIds.length).toBeGreaterThanOrEqual(2)

    // A REAL user's platform click target: a point where the PLATE is what the
    // pointer would pick AND the 3D canvas is the top DOM element (the floating
    // panels/chrome swallow clicks exactly like they would for a user).
    const platformPoint = () =>
      page.evaluate((gid) => {
        const s = window.__scene3d!
        const canvas = document.querySelector('[data-testid="canvas-3d"] canvas')
        if (!canvas) return null
        const r = canvas.getBoundingClientRect()
        for (let gx = 0.05; gx < 0.95; gx += 0.015) {
          for (let gy = 0.08; gy < 0.92; gy += 0.015) {
            const x = Math.round(r.left + r.width * gx)
            const y = Math.round(r.top + r.height * gy)
            const t = s.pickAt(x, y)
            if (t?.kind === 'group' && t.id === gid && document.elementFromPoint(x, y) === canvas) return { x, y }
          }
        }
        return null
      }, groupId)

    // ── selection (USER BUG: no response at all): click the plate → the store
    //    selects the group AND the plate is rebuilt wearing the selection ring
    const pt1 = await platformPoint()
    expect(pt1, 'no clickable platform point in the clear canvas area').toBeTruthy()
    await page.mouse.click(pt1!.x, pt1!.y)
    await page.waitForFunction((gid) => window.__scene3d!.selectionIds().includes(gid), groupId, { timeout: 5000 })
    await page.waitForFunction(
      (gid) => window.__scene3d!.groupInfo().find((g) => g.id === gid)!.selectedVisual,
      groupId,
      { timeout: 5000 },
    )

    // ── autolayout re-hug (USER BUG: platform froze at its stored rect): drag
    //    ONE member far outward → the derived bounds move and the plate
    //    geometry is REBUILT to hug them, ring intact
    const rectBefore = await page.evaluate(
      (gid) => window.__scene3d!.groupInfo().find((g) => g.id === gid)!.rect,
      groupId,
    )
    const vp = page.viewportSize()!
    let dragged = ''
    for (const id of memberIds) {
      const p = await page.evaluate((id) => window.__scene3d!.nodeWorldPos(id), id)
      if (!p) continue
      const pt = await worldToScreen(page, p.x + 50, 18, p.y + 40)
      if (pt.x > 345 && pt.x < vp.width - 480 && pt.y > 90 && pt.y < vp.height - 90) {
        dragged = id
        await page.mouse.move(pt.x, pt.y)
        await page.mouse.down()
        for (let i = 1; i <= 8; i++) await page.mouse.move(pt.x + (170 * i) / 8, pt.y - (70 * i) / 8)
        await page.mouse.up()
        break
      }
    }
    expect(dragged, 'no group member projects into the unobstructed canvas area').toBeTruthy()
    await page.waitForFunction(
      (id) => {
        const p = window.__scene3d!.nodeWorldPos(id)
        if (!p) return false
        const on = (v: number) => Math.abs(v / 10 - Math.round(v / 10)) < 1e-6
        return on(p.x) && on(p.y)
      },
      dragged,
      { timeout: 5000 },
    )
    const afterMemberDrag = await page.evaluate(
      (gid) => window.__scene3d!.groupInfo().find((g) => g.id === gid)!,
      groupId,
    )
    expect(afterMemberDrag.rect).not.toEqual(rectBefore) // bounds re-derived from members
    expect(afterMemberDrag.builtRect).toEqual(afterMemberDrag.rect) // plate rebuilt to hug them
    expect(afterMemberDrag.selectedVisual).toBe(true) // ring survives the rebuild

    // ── platform drag (USER BUG: members stayed behind): grabbing the plate
    //    carries every member by ONE delta, snapped once on release so the
    //    anchor member lands on the half-grid and the others keep their
    //    offsets from it (the 2D group-drag contract; snapping each member on
    //    its own moved them by different amounts — groupPlatform.ts)
    const starts: [string, { x: number; y: number }][] = []
    for (const id of memberIds) {
      const p = await page.evaluate((id) => window.__scene3d!.nodeWorldPos(id)!, id)
      starts.push([id, p])
    }
    const pt2 = await platformPoint()
    expect(pt2, 'platform not clickable after the re-hug').toBeTruthy()
    await page.mouse.move(pt2!.x, pt2!.y)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(pt2!.x - (120 * i) / 8, pt2!.y + (55 * i) / 8)
    await page.mouse.up()
    // every member landed: displaced, all by the same delta, and the anchor
    // clipped to the dot lattice
    await page.waitForFunction(
      (starts) => {
        const on = (v: number) => Math.abs(v / 10 - Math.round(v / 10)) < 1e-6
        const now = starts.map(([id]) => window.__scene3d!.nodeWorldPos(id))
        if (now.some((p) => !p)) return false
        const d0 = { dx: now[0]!.x - starts[0][1].x, dy: now[0]!.y - starts[0][1].y }
        return starts.every(([, s0], i) => {
          const p = now[i]!
          return Math.hypot(p.x - s0.x, p.y - s0.y) > 30
            && Math.abs(p.x - s0.x - d0.dx) < 1e-6 && Math.abs(p.y - s0.y - d0.dy) < 1e-6
        }) && now.some((p) => on(p!.x) && on(p!.y))
      },
      starts,
      { timeout: 5000 },
    )
    // and the platform followed its members
    const final = await page.evaluate((gid) => window.__scene3d!.groupInfo().find((g) => g.id === gid)!, groupId)
    expect(final.builtRect).toEqual(final.rect)
    expect(final.platePos).toEqual({ x: final.rect.x, y: final.rect.y })
  })

  test('community theme 3D spec hooks execute in the sandbox worker (Blueprint edge lights)', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)

    const origSkinId = await page.evaluate(() => window.__canvasEngine!.skin?.id ?? 'studio')
    // community cards live on the Community tab; official skins in Collection
    const equip = async (skinId: string) => {
      const current = await page.evaluate(() => window.__canvasEngine!.skin?.id)
      if (current === skinId) return
      const community = skinId.startsWith('community:')
      await page.locator('[data-testid="open-theme-shop"]').click()
      await page.locator(`[data-testid="shop-tab-${community ? 'community' : 'collection'}"]`).click()
      await page.locator(`[data-testid="${community ? 'community-equip' : 'skin-equip'}-${skinId}"]`).click()
      await page.locator('[data-testid="shop-close"]').click()
      await page.waitForFunction((id) => window.__canvasEngine!.skin?.id === id, skinId, { timeout: 10000 })
    }

    try {
      // Blueprint is the bundled COMMUNITY sample: untrusted code, worker-run.
      // Its object3d/floor3d hooks execute in the sandbox; specs land async
      // (worker round-trip) and the host re-pushes the source into the scene.
      await equip('community:demo:blueprint')
      await enter3d(page)
      await page.waitForFunction(() => window.__scene3d!.theme3dInfo().glowCount >= 2, undefined, { timeout: 10000 })
      const info = await page.evaluate(() => window.__scene3d!.theme3dInfo())
      expect(info.hasTheme).toBe(true)
      // web + api keep the rim; actor + system get custom asset bodies below
      expect(info.glowCount, 'community edgeGlow rim per plain card').toBe(2)

      // meta.assets custom bodies: the person mounts the pin GLB,
      // the identity system a camera-facing beacon billboard, and the slab top
      // carries the paper floorTexture — all decoded from EMBEDDED data URIs
      await page.waitForFunction(() => {
        const a = window.__scene3d!.assetInfo()
        return a.mounted.includes('pin') && a.mounted.includes('beacon') && a.floorTextured
      }, undefined, { timeout: 10000 })
      const assets = await page.evaluate(() => window.__scene3d!.assetInfo())
      expect(assets.billboards, 'beacon plane is camera-facing').toBe(1)

      // the unlit baseline skin removes the community surface again ('default'
      // stays surface-free through the PBR migration; 'studio' will not)
      await page.locator('[data-testid="diagram-skin-select"]').selectOption('default')
      await page.waitForFunction(() => {
        const t = window.__scene3d!.theme3dInfo()
        const a = window.__scene3d!.assetInfo()
        return t.glowCount === 0 && a.mounted.length === 0 && !a.floorTextured
      }, undefined, { timeout: 10000 })
    } finally {
      // never leave the shared validation workspace re-skinned; the override
      // must go first or it masks the global re-equip from the resolved skin.
      await page.locator('[data-testid="diagram-skin-select"]').selectOption('').catch(() => {})
      await equip(origSkinId).catch(() => {})
    }
  })

  test('rectangular casters cast rounded-rect shadows, not oval blobs (USER BUG)', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)
    await pinUnlitSkin(page) // luminance ordering below is the UNLIT shadow contract
    await enter3d(page)

    // structural: every card (4) + the board slab casts the roundedRect SDF
    // shadow; the drum keeps the radial blob (it IS round) so it's unmarked
    const shapes = await page.evaluate(() => window.__scene3d!.shadowInfo())
    expect(shapes.filter((s) => s === 'roundedRect').length).toBeGreaterThanOrEqual(5)

    // pixel discriminator: a point just inside the shadow's BOTTOM-RIGHT CORNER
    // region is shaded by a rect-footprint shadow but was UNSHADED under the
    // old radial blob (an oval never reaches its bounding rect's corners).
    // Reference = the same point +(40,40) world: identical dot-lattice phase
    // (dots repeat every 20), outside the shadow skirt.
    // readPixel reads the GL drawing buffer — DOM panels don't occlude it, so
    // samples only need to land inside the canvas viewport (unlike clicks)
    const vp = page.viewportSize()!
    const clear = (pt: { x: number; y: number }) =>
      pt.x > 10 && pt.x < vp.width - 10 && pt.y > 10 && pt.y < vp.height - 10
    const candidates = await page.evaluate(() => {
      const ms = window.__modelStore!.getState()
      const grouped = new Set(ms.groups.flatMap((g) => g.objectIds))
      return window.__scene3d!
        .nodeIds()
        .filter((id) => !grouped.has(id)) // floor-level cards only (dot grid reference)
        .map((id) => {
          const o = ms.objects.find((x) => x.id === id)!
          const p = window.__scene3d!.nodeWorldPos(id)!
          return { id, x: p.x, y: p.y, w: o.size.width, h: o.size.height }
        })
    })
    let asserted = false
    for (const c of candidates) {
      const cornerW = { x: c.x + c.w + 4, y: c.y + c.h + 6 }
      const refW = { x: cornerW.x + 40, y: cornerW.y + 40 }
      const corner = await worldToScreen(page, cornerW.x, 0, cornerW.y)
      const ref = await worldToScreen(page, refW.x, 0, refW.y)
      if (!clear(corner) || !clear(ref)) continue
      const lum = async (pt: { x: number; y: number }) => {
        const px = await page.evaluate(
          ([x, y]) => window.__scene3d!.readPixel(x, y),
          [pt.x, pt.y] as [number, number],
        )
        return px.r + px.g + px.b
      }
      const cornerLum = await lum(corner)
      const refLum = await lum(ref)
      expect(cornerLum, `corner-region floor (card ${c.id}) must sit in the shadow`).toBeLessThan(refLum - 5)
      asserted = true
      break
    }
    expect(asserted, 'no floor-level card projected into the clear canvas area').toBe(true)
  })

  test('?view=3d deep link opens the editor and viewer straight into 3D (P6.0)', async ({ page, context }) => {
    await loginIfNeeded(page)
    await importStorefront(page)

    // Editor deep link: reload the diagram URL with ?view=3d — a full navigation
    // re-captures the boot param (takeInitialViewMode), so the board opens in 3D
    // with NO pill click, and RouteSync keeps the address bar a copyable 3D link.
    const editorUrl = `${page.url().split('?')[0]}?view=3d`
    await page.goto(editorUrl)
    await page.waitForFunction(
      () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
      undefined,
      { timeout: 40000 },
    )
    await expect(page.locator('[data-testid="canvas-3d"]')).toHaveCount(1)
    await expect.poll(() => page.url(), { timeout: 10000 }).toContain('view=3d')

    // Flip to 2D via the real pill → the deep-link param drops from the URL.
    await page.locator('[data-testid="view-2d"]').click()
    await page.waitForFunction(() => !location.search.includes('view=3d'), undefined, { timeout: 10000 })

    // Viewer deep link: create a share link, append ?view=3d → the read-only
    // viewer mounts the board with the 3D toggle pre-pressed, no click needed.
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
    await expect(visitor.locator('[data-testid="viewer-view-3d"][aria-pressed="true"]')).toHaveCount(1)
    await visitor.close()
  })

  test('Export → PNG · 3D view downloads the live board as a real PNG (same-frame GL readback) (P6.0)', async ({ page }) => {
    await loginIfNeeded(page)
    await importStorefront(page)
    await enter3d(page)

    await page.getByRole('button', { name: /Partager|Share/ }).first().click()
    const dialog = page.locator('[role="dialog"]')
    await dialog.locator('[data-testid="share-tab-export"]').click()
    await dialog.locator('[data-testid="export-type-png"]').click()
    // The source toggle is offered because the 3D view is open; pick the live board.
    await dialog.locator('[data-testid="export-source-3d"]').click()
    await expect(dialog.locator('[data-testid="export-filename"]')).toContainText('-3d.png')

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 })
    await dialog.locator('[data-testid="export-download"]').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/-3d\.png$/)

    const path = await download.path()
    expect(path).toBeTruthy()
    const bytes = readFileSync(path!)
    // A valid PNG signature + a substantial payload proves the GL buffer was read
    // back with real content (a blank/failed capture would be tiny or non-PNG).
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(bytes.length).toBeGreaterThan(5000)

    await expect(dialog.locator('[data-testid="export-toast"]')).toBeVisible({ timeout: 10000 })
  })
})
