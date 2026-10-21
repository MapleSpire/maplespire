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
 * Undo/redo + clipboard on the 3D board — the same command layer as the 2D
 * canvas, driven through trusted pointer drags and real key presses.
 * `__scene3d` / `__modelStore` are read-only probes.
 *
 *   E2E_3D_URL=http://localhost:5297 npx playwright test e2e/view3d-undo.spec.ts --project=view3d
 */

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

const COPY_SUFFIX = / \((copy|copie)\)$/

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

async function signIn(page: Page, tag: string) {
  await page.goto('/')
  const devLogin = page.getByTestId('dev-login-email')
  await devLogin.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => null)
  if (await devLogin.isVisible().catch(() => false)) {
    await submitDevLogin(page, `e2e-undo3d-${tag}-${Date.now()}@example.com`)
  }
  await page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+/, { timeout: 90_000 })
  await expect(page.getByTestId('nav-menu')).toBeVisible({ timeout: 60_000 })
}

async function importStorefront(page: Page) {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  await page.getByTestId('create-diagram-button').click()
  await page.getByTestId('create-import').click()
  await page.getByTestId('import-textarea').fill(STOREFRONT_DSL)
  await page.getByTestId('import-parse').click()
  await page.getByTestId('import-generate').click()
  await page.waitForURL('**/diagram/**', { timeout: 30_000 })
  await page.waitForTimeout(1500)
}

async function enter3d(page: Page) {
  await page.getByTestId('view-3d').click()
  await page.waitForFunction(
    () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
    undefined,
    { timeout: 30_000 },
  )
}

type Placement = { position: { x: number; y: number }; size: { width: number; height: number } }

async function layers(page: Page) {
  return page.evaluate(() => {
    const s = window.__modelStore!.getState()
    const d = s.diagrams.find((x) => x.id === s.currentDiagramId)!
    return {
      objectIds: [...d.objectIds],
      names: Object.fromEntries(s.objects.map((o) => [o.id, o.name])),
      l2d: JSON.parse(JSON.stringify(d.layouts ?? {})) as Record<string, Placement>,
      l3d: JSON.parse(JSON.stringify(d.layouts3d ?? {})) as Record<string, Placement>,
      selected: s.selectedItems.map((i) => i.id),
    }
  })
}

/** A screen point on a card face that the board's raycast resolves to that card. */
async function reachableCard(page: Page): Promise<{ id: string; at: { x: number; y: number } }> {
  const hit = await page.evaluate(() => {
    for (let y = 100; y < innerHeight - 110; y += 6) {
      for (let x = 355; x < innerWidth - 370; x += 6) {
        const el = document.elementFromPoint(x, y)
        if (!el || !el.closest('[data-testid="canvas-3d"]')) continue
        const p = window.__scene3d!.pickAt(x, y)
        if (!p || p.kind !== 'object') continue
        // prefer the middle of the card: require the pick to hold 12px around
        const ok = [[-12, 0], [12, 0], [0, -12], [0, 12]].every(([dx, dy]) => {
          const q = window.__scene3d!.pickAt(x + dx, y + dy)
          return q?.kind === 'object' && q.id === p.id
        })
        if (ok) return { id: p.id, at: { x, y } }
      }
    }
    return null
  })
  if (!hit) throw new Error('no card is pointer-reachable on the 3D board')
  return hit
}

test.describe('3D board undo/redo + clipboard', () => {
  test('a card drag is undone in 3D (layouts3d) without touching 2D, and redone', async ({ page }) => {
    await signIn(page, 'drag')
    await importStorefront(page)
    await enter3d(page)

    const { id, at } = await reachableCard(page)
    const before = await layers(page)
    const startWorld = await page.evaluate((id) => window.__scene3d!.nodeWorldPos(id)!, id)

    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(at.x + (120 * i) / 8, at.y + (50 * i) / 8)
    await page.mouse.up()

    await expect
      .poll(async () => {
        const p = await page.evaluate((id) => window.__scene3d!.nodeWorldPos(id)!, id)
        return Math.hypot(p.x - startWorld.x, p.y - startWorld.y)
      })
      .toBeGreaterThan(30)
    await page.waitForTimeout(500) // drop-snap echo lands in the same entry
    const moved = await layers(page)
    expect(moved.l3d[id], 'the drag forks the 3D layer').toBeTruthy()
    expect(moved.l2d).toEqual(before.l2d)

    // What the board SHOWS for a card is `layouts3d[id] ?? layouts[id]`. The
    // fork that copies the 2D layout into `layouts3d` on the first 3D edit is
    // by design not an undoable change (modelDiff: "the fork … is not a
    // change"), so after undo the 3D layer may still exist — but the shown 3D
    // placement must be exactly the pre-drag one.
    const shown3d = (l: Awaited<ReturnType<typeof layers>>) => (l.l3d[id] ?? l.l2d[id])?.position ?? null
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => shown3d(await layers(page))).toEqual(shown3d(before))
    const undone = await layers(page)
    expect(undone.l2d, '2D layouts untouched by the 3D undo').toEqual(before.l2d)
    await expect
      .poll(async () => {
        const p = await page.evaluate((id) => window.__scene3d!.nodeWorldPos(id)!, id)
        return Math.hypot(p.x - startWorld.x, p.y - startWorld.y)
      })
      .toBeLessThan(0.5)

    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await layers(page)).l3d[id]?.position ?? null).toEqual(moved.l3d[id].position)
    expect((await layers(page)).l2d).toEqual(before.l2d)
    await expect
      .poll(async () => {
        const p = await page.evaluate((id) => window.__scene3d!.nodeWorldPos(id)!, id)
        return Math.hypot(p.x - moved.l3d[id].position.x, p.y - moved.l3d[id].position.y)
      })
      .toBeLessThan(0.5)
  })

  test('Ctrl+C / Ctrl+V on a selected card adds a copy to the board', async ({ page }) => {
    await signIn(page, 'copy')
    await importStorefront(page)
    await enter3d(page)

    const { id, at } = await reachableCard(page)
    await page.mouse.click(at.x, at.y)
    await expect.poll(async () => (await layers(page)).selected).toEqual([id])
    const before = await layers(page)
    const nodesBefore = await page.evaluate(() => window.__scene3d!.nodeCount())

    await page.keyboard.press('ControlOrMeta+c')
    await page.keyboard.press('ControlOrMeta+v')

    await expect.poll(async () => (await layers(page)).objectIds.length).toBe(before.objectIds.length + 1)
    const after = await layers(page)
    const copyId = after.objectIds.find((x) => !before.objectIds.includes(x))!
    expect(after.names[copyId]).toMatch(COPY_SUFFIX)
    expect(after.names[copyId].replace(COPY_SUFFIX, '')).toBe(before.names[id])
    expect(after.selected).toEqual([copyId])
    await expect.poll(() => page.evaluate(() => window.__scene3d!.nodeCount())).toBe(nodesBefore + 1)
    await expect.poll(() => page.evaluate((cid) => window.__scene3d!.nodeIds().includes(cid), copyId)).toBe(true)

    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await layers(page)).objectIds).not.toContain(copyId)
    await expect.poll(() => page.evaluate(() => window.__scene3d!.nodeCount())).toBe(nodesBefore)
  })
})
