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
 * LIT-profile gates (PBR migration — Studio flagship). The unlit contract
 * stays pinned to the 'default' skin in the legacy suites; THIS suite equips
 * Studio (the first migrated theme) and asserts the lit pipeline:
 *
 * - profile structure via sceneStats (lights mounted, shadow map on, IBL env,
 *   ACES exposure) — data → GL wiring, no screenshots;
 * - luminance ORDERING probes instead of exact hex (tone mapping shifts
 *   colors by design): sun-facing wall vs opposite wall, shadowed board vs
 *   open board;
 * - the perf contracts that must survive lighting: idle rAF === 0, capture.
 *
 * Run with the isolated 3D stack:  npx playwright test --project=view3d
 */

const DSL = `workspace "LitGate" {
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

/** Pin the test diagram to the LIT flagship skin ('studio') via the real
 * diagram-settings panel — per-diagram override on a fresh test diagram, so
 * nothing to restore and the shared workspace's global skin stays untouched. */
async function pinStudioSkin(page: Page) {
  const current = await page.evaluate(() => window.__canvasEngine!.skin?.id)
  if (current === 'studio') return
  await page.keyboard.press('Escape')
  const select = page.locator('[data-testid="diagram-skin-select"]')
  await select.waitFor({ state: 'visible', timeout: 10000 })
  await select.selectOption('studio')
  await page.waitForFunction(() => window.__canvasEngine!.skin?.id === 'studio', undefined, { timeout: 10000 })
  await page.waitForTimeout(400) // the skin swap rebuilds the board — let it settle
}

test.describe.configure({ mode: 'serial' })

test.describe('3D lit profile (Studio flagship)', () => {
  test('studio renders lit: rig mounted, shadows on, IBL env, tone mapping — and unlit stays clean after switching back', async ({ page }) => {
    await loginIfNeeded(page)
    await importDsl(page, DSL)
    await pinStudioSkin(page)
    await enter3d(page)

    // Profile structure — data → GL wiring, honest and screenshot-free.
    const stats = await page.evaluate(() => window.__scene3d!.sceneStats())
    expect(stats.renderProfile, 'studio is the lit flagship').toBe('lit')
    // 3 lights: sun + hemisphere + the workbench desk lamp's
    // practical SpotLight (the default lit background carries the brass lamp)
    expect(stats.lightsCount, 'fixed rig + the workbench practical').toBe(3)
    expect(stats.shadowMapEnabled, 'PCFSoft shadow map on').toBe(true)
    expect(stats.envMap, 'PMREM room environment attached').toBe(true)
    expect(stats.shadowCasters, 'slabs/drums/floor cast (capped)').toBeGreaterThan(0)

    // The post chunk loads lazily — wait for the composer, then hold it to
    // the tier contract: SwiftShader's default tier is 'medium' (no AO pass)
    // ⇒ RenderPass + EffectPass(Bloom) = 2 passes exactly.
    await page.waitForFunction(() => window.__scene3d!.sceneStats().composerPasses > 0, undefined, { timeout: 15000 })
    const post = await page.evaluate(() => {
      const st = window.__scene3d!.sceneStats()
      return { passes: st.composerPasses, tier: st.qualityTier }
    })
    expect(post.tier, 'software raster starts at medium (AO excluded)').toBe('medium')
    expect(post.passes, 'composer = RenderPass + Bloom EffectPass').toBe(2)

    // Idle rAF === 0 must SURVIVE lighting: nothing animates at rest.
    const frameBefore = await page.evaluate(() => window.__scene3d!.rendererInfo().frame)
    await page.waitForTimeout(1100)
    const frameAfter = await page.evaluate(() => window.__scene3d!.rendererInfo().frame)
    expect(frameAfter - frameBefore, 'no render churn while nothing animates').toBe(0)

    // Luminance ORDERING (robust to lighting tweaks — no exact hex under tone
    // mapping): some board pixel hugging a card must sit in that card's shadow
    // (real key-light shadow + contact SDF), i.e. read measurably darker than
    // open board far from any caster at the same lattice phase.
    const shading = await page.evaluate(() => {
      const s = window.__scene3d!
      const pose = s.getPose()
      const D = Math.PI / 180
      const cam = {
        x: pose.targetX + pose.distance * Math.sin(pose.polar * D) * Math.sin(pose.azimuth * D),
        y: pose.distance * Math.cos(pose.polar * D),
        z: pose.targetZ + pose.distance * Math.sin(pose.polar * D) * Math.cos(pose.azimuth * D),
      }
      const sub = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
      const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => a.x * b.x + a.y * b.y + a.z * b.z
      const cross = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
      const norm = (a: { x: number; y: number; z: number }) => { const l = Math.hypot(a.x, a.y, a.z); return { x: a.x / l, y: a.y / l, z: a.z / l } }
      const zc = norm(sub(cam, { x: pose.targetX, y: 0, z: pose.targetZ }))
      const xc = norm(cross({ x: 0, y: 1, z: 0 }, zc))
      const yc = cross(zc, xc)
      const proj = (wx: number, wz: number) => {
        const v = sub({ x: wx, y: 0, z: wz }, cam)
        const zd = -dot(v, zc)
        const t = Math.tan((pose.fov / 2) * D)
        const aspect = innerWidth / innerHeight
        return { x: ((dot(v, xc) / (zd * t * aspect) + 1) / 2) * innerWidth, y: ((1 - dot(v, yc) / (zd * t)) / 2) * innerHeight }
      }
      const lum = (px: { r: number; g: number; b: number }) => px.r + px.g + px.b
      const clear = (pt: { x: number; y: number }) => pt.x > 10 && pt.x < innerWidth - 10 && pt.y > 10 && pt.y < innerHeight - 10
      // RING-LOCAL contrast around one caster: the shadowed arc of a card's
      // surrounding board must read measurably darker than its sun-side arc.
      // Ring-local comparison cancels board-wide gradients; without real
      // key-light shadows the ring is uniform (± paper-grid hairlines).
      let best: { ringMin: number; ringMax: number } | null = null
      for (const id of s.nodeIds()) {
        const p = s.nodeWorldPos(id)
        if (!p) continue
        // approximate card footprint 200×120 (import defaults) — the ring
        // hugs the slab at two radii so part of it crosses the shadow foot
        const cx = p.x + 100
        const cz = p.y + 60
        const ringL: number[] = []
        for (const rad of [130, 150]) {
          for (let k = 0; k < 20; k++) {
            const a = (k / 20) * Math.PI * 2
            const wx = cx + Math.cos(a) * rad
            const wz = cz + Math.sin(a) * rad * 0.75 // squash to the footprint
            const sc = proj(wx, wz)
            if (!clear(sc)) continue
            if (s.pickAt(sc.x, sc.y)) continue // bare board only
            ringL.push(lum(s.readPixel(sc.x, sc.y)))
          }
        }
        if (ringL.length < 10) continue
        const candidate = { ringMin: Math.min(...ringL), ringMax: Math.max(...ringL) }
        if (!best || candidate.ringMax - candidate.ringMin > best.ringMax - best.ringMin) best = candidate
      }
      return best
    })
    expect(shading, 'a card with enough bare board around it projects on screen').not.toBeNull()
    expect(
      shading!.ringMax - shading!.ringMin,
      'the board ring around a caster carries a shadowed arc (real key-light shadows)',
    ).toBeGreaterThan(12)

    // Lines render visibly: scan pointer-reachable connection picks and
    // require at least one pixel that clearly contrasts with bare board
    // (the lit line is a dark ink on the board — this must be easy).
    const cable = await page.evaluate(() => {
      const s = window.__scene3d!
      const conns: number[] = []
      let floorPx: { r: number; g: number; b: number } | null = null
      for (let y = 100; y < innerHeight - 120 && (conns.length < 60 || !floorPx); y += 3) {
        for (let x = 80; x < innerWidth - 90 && (conns.length < 60 || !floorPx); x += 3) {
          const el = document.elementFromPoint(x, y)
          if (!el || !el.closest('[data-testid="canvas-3d"]')) continue
          const p = s.pickAt(x, y)
          if (p && p.kind === 'connection' && conns.length < 60) {
            const px = s.readPixel(x, y)
            conns.push(px.r + px.g + px.b)
          } else if (!floorPx && !p) floorPx = s.readPixel(x, y)
        }
      }
      if (!floorPx || conns.length === 0) return null
      const f = floorPx.r + floorPx.g + floorPx.b
      return { maxDelta: Math.max(...conns.map((c) => Math.abs(c - f))), samples: conns.length }
    })
    expect(cable, 'lines are pointer-reachable over bare board').not.toBeNull()
    expect(cable!.maxDelta, 'the lit line paints visibly against the paper').toBeGreaterThan(20)

    // USER ROUND 2026-10-12 ("Remet les lignes connections comme le theme
    // Clean"): every lit connection is Clean's flat ribbon + flat 2D head,
    // inked (inkLine.ts) — no tube, cone or torus left in the layer, nothing
    // of it casts a shadow, one ink core (+ at most one casing) per line, and
    // each head's point on its target's edge (connectionPath's arrowTip, 2D
    // parity). This diagram covers grouped cards AND a drum target.
    const heads = await page.evaluate(() => window.__scene3d!.arrowheadInfo())
    const layer = await page.evaluate(() => window.__scene3d!.connLayerInfo())
    expect(heads.length, 'both connections draw').toBeGreaterThanOrEqual(2)
    for (const h of heads) {
      expect(h.kind, `${h.connId} draws a flat head`).toBe('flat')
      expect(h.ink, `${h.connId} is an ink line`).toBe(true)
      expect(Math.abs(h.tipClear), `${h.connId} head's point on its target's edge`).toBeLessThanOrEqual(1)
    }
    for (const t of ['TubeGeometry', 'ConeGeometry', 'TorusGeometry', 'CylinderGeometry']) {
      expect(layer.geometryTypes[t] ?? 0, `no ${t} in the connection layer`).toBe(0)
    }
    expect(layer.shadowCasters, 'flat printed ink casts no shadow').toBe(0)
    expect(layer.inkCores, 'one ink core per line').toBe(heads.length)
    expect(layer.inkMeshes, 'at most a casing and a core per line').toBeLessThanOrEqual(2 * heads.length)
    expect(layer.inkSet, 'the paper board takes the dark ink').toBe('darkInk')

    // WORKBENCH decor rides along on lit themes: pick a pack through the
    // REAL popover and the desk annulus outside the slab dresses too
    // (pencil / cable coil / note at bench level)
    await page.locator('[data-testid="decor-open"]').click()
    await page.locator('[data-testid="decor-pack-maquette-people"]').click()
    await page.waitForFunction(
      () => {
        const d = window.__scene3d!.decorInfo()
        return d.packId === 'maquette-people' && d.archetypes.some((a) => a.id.startsWith('desk-') && a.count > 0)
      },
      undefined,
      { timeout: 10000 },
    )

    // GL context loss under the lit profile: the PMREM env texture and every
    // composer target died with the old context — the restore path must
    // rebuild BOTH (applyRenderProfile forceEnvRefresh) and come back lit.
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
    await page.waitForFunction(() => window.__scene3d!.sceneStats().composerPasses > 0, undefined, { timeout: 15000 })
    const restored = await page.evaluate(() => window.__scene3d!.sceneStats())
    expect(restored.renderProfile, 'profile survives the restore').toBe('lit')
    expect(restored.lightsCount, 'rig + workbench practical survive the restore').toBe(3)
    expect(restored.envMap, 'PMREM regenerated on the new context').toBe(true)
    expect(restored.shadowMapEnabled).toBe(true)

    // Switching the diagram back to the unlit baseline clears every lit
    // resource — the state-leak contract between profiles. The explicit
    // 'default' option only exists when the GLOBAL default is another skin;
    // in a fresh e2e profile the global default IS 'default', so clearing the
    // override ('' = "use my default") is the way back to the unlit baseline.
    await page.keyboard.press('Escape')
    const select = page.locator('[data-testid="diagram-skin-select"]')
    await select.waitFor({ state: 'visible', timeout: 10000 })
    await select.selectOption('')
    await page.waitForFunction(() => window.__canvasEngine!.skin?.id === 'default', undefined, { timeout: 10000 })
    await page.waitForTimeout(400)
    const back = await page.evaluate(() => window.__scene3d!.sceneStats())
    expect(back.renderProfile).toBe('unlit')
    expect(back.lightsCount, 'rig fully dismounted').toBe(0)
    expect(back.shadowMapEnabled).toBe(false)
    expect(back.envMap, 'PMREM released').toBe(false)
    expect(back.shadowCasters).toBe(0)
    expect(back.composerPasses, 'composer disposed with the profile').toBe(0)
  })
})
