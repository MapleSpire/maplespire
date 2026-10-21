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
 * Canvas undo/redo + clipboard on the 2D canvas — drives the REAL UI only
 * (pointer, keyboard, native clipboard events, context menus, tool pill).
 * `__modelStore` / `__canvasEngine` are READ-ONLY probes, used to assert and to
 * compute where a shape is on screen; no store action is ever called here.
 *
 *   E2E_BASE_URL=http://localhost:5297 npx playwright test e2e/canvas-undo-clipboard.spec.ts --project=chromium
 *
 * Each test signs in with a fresh dev-login email, so it owns an empty
 * personal workspace and imports its own diagram — no shared state.
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

// ── shared steps (all through the real UI) ───────────────────────────────────

async function signIn(page: Page, tag: string) {
  // Read-only witness: records which native clipboard events the page sees
  // (capture phase, never cancels or alters them).
  await page.addInitScript(() => {
    const log: string[] = []
    ;(window as unknown as { __clipEvents: string[] }).__clipEvents = log
    for (const type of ['copy', 'cut', 'paste'] as const) document.addEventListener(type, () => log.push(type), true)
  })
  await page.goto('/')
  const devLogin = page.getByTestId('dev-login-email')
  await devLogin.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => null)
  if (await devLogin.isVisible().catch(() => false)) {
    await submitDevLogin(page, `e2e-undo-${tag}-${Date.now()}@example.com`)
  }
  await page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+/, { timeout: 90_000 })
  await expect(page.getByTestId('nav-menu')).toBeVisible({ timeout: 60_000 })
}

/** Import the storefront DSL as a fresh diagram and land in the editor on it. */
async function importStorefront(page: Page) {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  await page.getByTestId('create-diagram-button').click()
  await page.getByTestId('create-import').click()
  await page.getByTestId('import-textarea').fill(STOREFRONT_DSL)
  await page.getByTestId('import-parse').click()
  await page.getByTestId('import-generate').click()
  await page.waitForURL('**/diagram/**', { timeout: 30_000 })
  await waitForCanvas(page)
}

async function waitForCanvas(page: Page) {
  await page.waitForFunction(
    () => {
      const s = window.__modelStore?.getState()
      const d = s?.diagrams.find((x) => x.id === s.currentDiagramId)
      return !!window.__canvasEngine && !!d && d.objectIds.length > 0 && Object.keys(d.layouts ?? {}).length > 0
    },
    undefined,
    { timeout: 30_000 },
  )
  // let the first zoom-to-fit land before computing screen points
  await page.waitForTimeout(1500)
}

/** Durability gate before a reload: debounce + repo auto-save, then flush. */
async function flushSync(page: Page) {
  await page.waitForTimeout(1500)
  await page
    .evaluate(async () => {
      const f = (window as unknown as { __repoFlush?: () => Promise<void> }).__repoFlush
      if (f) await f()
    })
    .catch(() => {})
}

interface Snap {
  diagramId: string
  diagramObjectIds: string[]
  objectIds: string[]
  names: Record<string, string>
  types: Record<string, string>
  layouts: Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }>
  selected: string[]
}

async function snap(page: Page): Promise<Snap> {
  return page.evaluate(() => {
    const s = window.__modelStore!.getState()
    const d = s.diagrams.find((x) => x.id === s.currentDiagramId)!
    return {
      diagramId: d.id,
      diagramObjectIds: [...d.objectIds],
      objectIds: s.objects.map((o) => o.id),
      names: Object.fromEntries(s.objects.map((o) => [o.id, o.name])),
      types: Object.fromEntries(s.objects.map((o) => [o.id, o.type as string])),
      layouts: JSON.parse(JSON.stringify(d.layouts ?? {})),
      selected: s.selectedItems.map((i) => i.id),
    }
  })
}

type EngineProbe = {
  worldToScreen(x: number, y: number): { x: number; y: number }
  screenToWorld(x: number, y: number): { x: number; y: number }
}

/**
 * Page-space centre of a shape on the 2D canvas, or null when that point is
 * not pointer-reachable (off-screen, or under a floating panel — exactly what
 * a real user could not click either).
 */
async function shapeCenter(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((id) => {
    const s = window.__modelStore!.getState()
    const d = s.diagrams.find((x) => x.id === s.currentDiagramId)!
    const l = d.layouts?.[id]
    if (!l) return null
    const canvas = document.querySelector('[data-testid="canvas-2d"]') as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    const engine = window.__canvasEngine as unknown as EngineProbe
    const p = engine.worldToScreen(l.position.x + l.size.width / 2, l.position.y + l.size.height / 2)
    const x = rect.left + p.x
    const y = rect.top + p.y
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null
    return document.elementFromPoint(x, y) === canvas ? { x, y } : null
  }, id)
}

/** A shape on the current diagram whose centre is pointer-reachable. */
async function reachableShape(
  page: Page,
  accept: (id: string, s: Snap) => boolean = () => true,
): Promise<{ id: string; at: { x: number; y: number } }> {
  const s = await snap(page)
  for (const id of s.diagramObjectIds) {
    if (!accept(id, s) || !s.layouts[id]) continue
    const at = await shapeCenter(page, id)
    if (at) return { id, at }
  }
  throw new Error('no shape centre is pointer-reachable on the canvas')
}

/** A pointer-reachable canvas point that no shape (plus a margin) covers. */
async function emptyCanvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const pt = await page.evaluate(() => {
    const s = window.__modelStore!.getState()
    const d = s.diagrams.find((x) => x.id === s.currentDiagramId)!
    const canvas = document.querySelector('[data-testid="canvas-2d"]') as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    const engine = window.__canvasEngine as unknown as EngineProbe
    const boxes = Object.values(d.layouts ?? {})
    const groups = s.groups.filter((g) => d.groupIds.includes(g.id))
    for (let y = rect.top + 120; y < rect.bottom - 120; y += 25) {
      for (let x = rect.left + 120; x < rect.right - 120; x += 25) {
        if (document.elementFromPoint(x, y) !== canvas) continue
        const w = engine.screenToWorld(x - rect.left, y - rect.top)
        const m = 60
        const hit = (b: { position: { x: number; y: number }; size: { width: number; height: number } }) =>
          w.x > b.position.x - m && w.x < b.position.x + b.size.width + m && w.y > b.position.y - m && w.y < b.position.y + b.size.height + m
        if (boxes.some(hit)) continue
        if (groups.some((g) => g.position && g.size && hit({ position: g.position, size: g.size }))) continue
        return { x, y }
      }
    }
    return null
  })
  if (!pt) throw new Error('no empty pointer-reachable canvas point')
  return pt
}

async function selectShape(page: Page, id: string, at: { x: number; y: number }) {
  await page.mouse.click(at.x, at.y)
  await expect.poll(async () => (await snap(page)).selected).toEqual([id])
}

const undoBtn = (page: Page) => page.getByTestId('toolpill-undo')
const redoBtn = (page: Page) => page.getByTestId('toolpill-redo')

/** Ctrl+C then Ctrl+V on the selected shape; returns the id of the new copy. */
async function copyPasteSelected(page: Page, before: Snap): Promise<string> {
  await page.keyboard.press('ControlOrMeta+c')
  await page.keyboard.press('ControlOrMeta+v')
  await expect.poll(async () => (await snap(page)).diagramObjectIds.length).toBe(before.diagramObjectIds.length + 1)
  const after = await snap(page)
  const added = after.diagramObjectIds.filter((id) => !before.diagramObjectIds.includes(id))
  expect(added).toHaveLength(1)
  return added[0]
}

// ── tests ────────────────────────────────────────────────────────────────────

test.describe('2D canvas undo/redo + clipboard', () => {
  test('copy/paste makes an offset, selected copy; Ctrl+Z / Ctrl+Shift+Z and the pill undo/redo it', async ({ page }) => {
    await signIn(page, 'copy')
    await importStorefront(page)

    const { id, at } = await reachableShape(page)
    await selectShape(page, id, at)
    const before = await snap(page)

    const copyId = await copyPasteSelected(page, before)
    const after = await snap(page)
    expect(after.objectIds.length).toBe(before.objectIds.length + 1)
    expect(after.names[copyId]).toMatch(COPY_SUFFIX)
    expect(after.names[copyId].replace(COPY_SUFFIX, '')).toBe(before.names[id])
    // Observation only: did the keys reach the app as NATIVE clipboard events,
    // or through the hook's keydown fallback? Recorded as a test annotation.
    test.info().annotations.push({
      type: 'clipboard-events',
      description: JSON.stringify(await page.evaluate(() => (window as unknown as { __clipEvents?: string[] }).__clipEvents)),
    })
    expect(after.layouts[copyId].position).toEqual({
      x: before.layouts[id].position.x + 20,
      y: before.layouts[id].position.y + 20,
    })
    expect(after.selected).toEqual([copyId])
    await expect(undoBtn(page)).toBeEnabled()

    // keyboard undo → the copy is gone from the diagram AND the model
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await snap(page)).diagramObjectIds.length).toBe(before.diagramObjectIds.length)
    let s = await snap(page)
    expect(s.objectIds).not.toContain(copyId)
    expect(s.objectIds.length).toBe(before.objectIds.length)
    await expect(redoBtn(page)).toBeEnabled()

    // keyboard redo → the very same copy is back, same place
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await snap(page)).diagramObjectIds).toContain(copyId)
    s = await snap(page)
    expect(s.layouts[copyId].position).toEqual(after.layouts[copyId].position)
    expect(s.names[copyId]).toBe(after.names[copyId])

    // pill buttons do the same
    await undoBtn(page).click()
    await expect.poll(async () => (await snap(page)).diagramObjectIds).not.toContain(copyId)
    expect((await snap(page)).objectIds).not.toContain(copyId)
    await redoBtn(page).click()
    await expect.poll(async () => (await snap(page)).diagramObjectIds).toContain(copyId)
    expect((await snap(page)).objectIds).toContain(copyId)
    await expect(redoBtn(page)).toBeDisabled()
  })

  test('a drag is undone to the exact previous position and Ctrl+Y re-applies it', async ({ page }) => {
    await signIn(page, 'drag')
    await importStorefront(page)

    const { id, at } = await reachableShape(page)
    const before = await snap(page)
    const from = before.layouts[id].position

    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(at.x + (140 * i) / 10, at.y + (70 * i) / 10)
    await page.mouse.up()

    await expect
      .poll(async () => {
        const p = (await snap(page)).layouts[id].position
        return Math.hypot(p.x - from.x, p.y - from.y)
      })
      .toBeGreaterThan(30)
    // let a trailing write settle so it belongs to the same gesture
    await page.waitForTimeout(300)
    const moved = (await snap(page)).layouts[id].position

    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await snap(page)).layouts[id].position).toEqual(from)
    // nothing else moved
    const undone = await snap(page)
    for (const other of before.diagramObjectIds) expect(undone.layouts[other]).toEqual(before.layouts[other])

    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await snap(page)).layouts[id].position).toEqual(moved)
  })

  test('undo of a model delete restores the shape durably; an undone paste stays gone after reload', async ({ page }) => {
    await signIn(page, 'delete')
    await importStorefront(page)

    // pick a reachable shape whose menu offers "delete from model"
    const initial = await snap(page)
    let victim = ''
    for (const id of initial.diagramObjectIds) {
      const at = await shapeCenter(page, id)
      if (!at) continue
      await page.mouse.click(at.x, at.y, { button: 'right' })
      const row = page.getByTestId('ctx-object-delete-from-model')
      if (await row.isVisible({ timeout: 2000 }).catch(() => false)) {
        victim = id
        await row.click()
        break
      }
      await page.keyboard.press('Escape')
    }
    expect(victim, 'no shape offers delete-from-model').toBeTruthy()
    const name = initial.names[victim]

    await expect.poll(async () => (await snap(page)).diagramObjectIds).not.toContain(victim)
    expect((await snap(page)).objectIds).not.toContain(victim)

    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await snap(page)).diagramObjectIds).toContain(victim)
    let s = await snap(page)
    expect(s.objectIds).toContain(victim)
    expect(s.names[victim]).toBe(name)
    expect(s.layouts[victim]).toEqual(initial.layouts[victim])

    await flushSync(page)
    await page.reload()
    await waitForCanvas(page)
    await expect.poll(async () => (await snap(page)).diagramObjectIds, { timeout: 30_000 }).toContain(victim)
    await expect.poll(async () => (await snap(page)).objectIds, { timeout: 30_000 }).toContain(victim)
    s = await snap(page)
    expect(s.names[victim]).toBe(name)

    // reverse: a pasted copy that is undone must not come back after reload
    const { id, at } = await reachableShape(page)
    await selectShape(page, id, at)
    const beforePaste = await snap(page)
    const copyId = await copyPasteSelected(page, beforePaste)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await snap(page)).diagramObjectIds).not.toContain(copyId)

    await flushSync(page)
    await page.reload()
    await waitForCanvas(page)
    // give any late resurrection (sync replay) a chance to show itself
    await page.waitForTimeout(3000)
    s = await snap(page)
    expect(s.diagramObjectIds).not.toContain(copyId)
    expect(s.objectIds).not.toContain(copyId)
    expect(s.diagramObjectIds.sort()).toEqual([...beforePaste.diagramObjectIds].sort())
  })

  test('Ctrl+Z typed inside a text field never undoes canvas edits', async ({ page }) => {
    await signIn(page, 'field')
    await importStorefront(page)

    const { id, at } = await reachableShape(page)
    await selectShape(page, id, at)
    const before = await snap(page)
    const copyId = await copyPasteSelected(page, before)
    const afterPaste = await snap(page)

    // the copy is selected → the right sidebar shows its name field
    const field = page.getByTestId('object-name')
    await expect(field).toHaveValue(afterPaste.names[copyId])
    await field.click()
    await field.press('End')
    await field.type('!')
    await expect(field).toHaveValue(afterPaste.names[copyId] + '!')

    await field.press('ControlOrMeta+z')
    await field.press('ControlOrMeta+z')
    await page.waitForTimeout(500)

    // the canvas paste must still be there, nothing moved
    const s = await snap(page)
    expect(s.diagramObjectIds).toEqual(afterPaste.diagramObjectIds)
    expect(s.objectIds).toContain(copyId)
    expect(s.layouts).toEqual(afterPaste.layouts)
    // and the focus is still in the field (the keys belonged to it)
    await expect(field).toBeFocused()
  })

  test('cut on one diagram and paste on another adds the SAME element there', async ({ page }) => {
    await signIn(page, 'cut')
    await importStorefront(page)

    // Model baseline from the Model Objects page (the whole model; the
    // windowed store only holds the current diagram's objects under
    // boot-from-server, so `store.objects` cannot answer "did the model grow").
    const modelRows = page.locator('[data-testid^="mo-row-"]')
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('nav-model-objects').click()
    await expect(modelRows.first()).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(1000)
    const baselineRows = await modelRows.count()
    await page.goBack()
    await waitForCanvas(page)

    // a top-level element (person/system), so its Model Objects row is not
    // folded under a parent in the tree
    const { id, at } = await reachableShape(page, (x, s) => !['app', 'store', 'component'].includes(s.types[x]))
    await selectShape(page, id, at)
    const onA = await snap(page)

    await page.keyboard.press('ControlOrMeta+x')
    await expect.poll(async () => (await snap(page)).diagramObjectIds).not.toContain(id)
    // cut = remove from THIS diagram, never a model delete
    expect((await snap(page)).objectIds).toContain(id)

    await page.getByTestId('add-shape-button').click()
    await page.getByTestId('add-blank-diagram-option').click()
    await expect.poll(async () => (await snap(page)).diagramId).not.toBe(onA.diagramId)
    const onB = await snap(page)
    expect(onB.diagramObjectIds).toEqual([])
    await page.waitForTimeout(800)

    // focus the canvas like a user would, then paste
    const canvas = page.getByTestId('canvas-2d')
    const box = (await canvas.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.press('ControlOrMeta+v')

    await expect.poll(async () => (await snap(page)).diagramObjectIds).toEqual([id])
    const s = await snap(page)
    expect(s.diagramId).toBe(onB.diagramId)
    expect(s.names[id]).toBe(onA.names[id])
    expect(s.selected).toEqual([id])
    // No copy was minted: the model is the same size as before the cut.
    expect(Object.values(s.names).filter((n) => COPY_SUFFIX.test(n))).toEqual([])
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('nav-model-objects').click()
    await expect(page.getByTestId(`mo-row-${id}`)).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(1000)
    await expect(modelRows).toHaveCount(baselineRows)
    await expect(modelRows.filter({ hasText: / \((copy|copie)\)/ })).toHaveCount(0)
  })

  test('right-click "Paste here" on empty canvas pastes centred on the click point', async ({ page }) => {
    await signIn(page, 'here')
    await importStorefront(page)

    const { id, at } = await reachableShape(page)
    await selectShape(page, id, at)
    await page.keyboard.press('ControlOrMeta+c')
    const before = await snap(page)

    const pt = await emptyCanvasPoint(page)
    const world = await page.evaluate(
      ([x, y]) => {
        const canvas = document.querySelector('[data-testid="canvas-2d"]') as HTMLCanvasElement
        const rect = canvas.getBoundingClientRect()
        return (window.__canvasEngine as unknown as EngineProbe).screenToWorld(x - rect.left, y - rect.top)
      },
      [pt.x, pt.y] as [number, number],
    )
    await page.mouse.click(pt.x, pt.y, { button: 'right' })
    await expect(page.getByTestId('ctx-canvas-select-all')).toBeVisible()
    await expect(page.getByTestId('ctx-canvas-undo')).toBeVisible()
    await expect(page.getByTestId('ctx-canvas-redo')).toBeVisible()
    await page.getByTestId('ctx-canvas-paste-here').click()

    await expect.poll(async () => (await snap(page)).diagramObjectIds.length).toBe(before.diagramObjectIds.length + 1)
    const s = await snap(page)
    const copyId = s.diagramObjectIds.find((x) => !before.diagramObjectIds.includes(x))!
    expect(s.names[copyId]).toMatch(COPY_SUFFIX)
    const l = s.layouts[copyId]
    const cx = l.position.x + l.size.width / 2
    const cy = l.position.y + l.size.height / 2
    expect(Math.abs(cx - world.x), `centre x ${cx} vs click ${world.x}`).toBeLessThan(15)
    expect(Math.abs(cy - world.y), `centre y ${cy} vs click ${world.y}`).toBeLessThan(15)
    expect(s.selected).toEqual([copyId])
  })
})
