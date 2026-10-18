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

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect, type Page } from '@playwright/test'
import { submitDevLogin } from '../support/devLogin'
import { dragNewShapeToCanvas } from './helpers'

/**
 * Entering, leaving and merging a Draft keeps the diagram being viewed ON THE
 * CANVAS — driven through the real "+ Add" → "New draft" form, the pill's exit
 * X and the Changes merge.
 *
 * The defect (2026-10-17, after 288d55b3f): on "FoodDash - Containers",
 * creating a Draft showed "Draft: …" in the pill but the URL lost its
 * /diagram/ segment and the canvas stayed EMPTY. The store-level test
 * (src/stores/draftsStayOnDiagram.test.ts) mocks `switchWorkspace`, so it
 * proved the diagram id was HANDED to the switch, never that the switch landed
 * on it — this spec asserts the shapes the canvas engine actually holds.
 *
 * Runs against the boot stack (E2E_BOOT_URL / E2E_BOOT_API), AUTH off or on.
 */

const DSL = `workspace "FoodDash" "Draft stays on diagram." {
    !identifiers hierarchical
    model {
        customer = person "Customer" "Orders meals."
        courier = person "Courier" "Delivers orders."
        stripe = softwareSystem "Stripe" "Card payments." "External"
        fooddash = softwareSystem "FoodDash" "Food delivery platform." {
            mobileApp = container "Mobile App" "Ordering." "React Native"
            portal = container "Restaurant Portal" "Menus." "React"
            orders = container "Order Service" "Order lifecycle." "NodeJS" {
                api = component "Order API" "REST." "Express"
                checkout = component "Checkout" "Takes payment." "NodeJS"
            }
            payments = container "Payment Service" "Charges." "Golang"
            db = container "Orders Database" "History." "PostgreSQL"
        }
        customer -> fooddash.mobileApp "Orders with"
        courier -> fooddash.mobileApp "Delivers with"
        fooddash.mobileApp -> fooddash.orders.api "Places orders" "HTTPS"
        fooddash.portal -> fooddash.orders.api "Accepts orders" "HTTPS"
        fooddash.orders.api -> fooddash.orders.checkout "Submits cart"
        fooddash.orders.checkout -> fooddash.payments "Charges card" "gRPC"
        fooddash.orders.checkout -> fooddash.db "Stores orders" "SQL"
        fooddash.payments -> stripe "Charges cards" "HTTPS"
    }
    views {
        systemContext fooddash { include * autoLayout }
        container fooddash { include * autoLayout }
        component fooddash.orders { include * autoLayout }
    }
}`

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/app')
  const devLogin = page.getByTestId('dev-login-email')
  await Promise.race([
    devLogin.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined),
    page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+/, { timeout: 45_000 }).catch(() => undefined),
  ])
  if (await devLogin.isVisible().catch(() => false)) await submitDevLogin(page, email)
  await page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+/, { timeout: 90_000 })
  await page.waitForFunction(() => Array.isArray((window as any).__modelStore?.getState?.().diagrams), undefined, {
    timeout: 60_000,
  })
}

function landscapeFromUrl(page: Page): string | null {
  return new URL(page.url()).pathname.match(/\/landscape\/([^/]+)\//)?.[1] ?? null
}

const createdLandscapes: string[] = []
const apiOrigin = (process.env.E2E_BOOT_API ?? 'http://localhost:3002').replace(/\/$/, '')

test.afterEach(async ({ page }) => {
  for (const id of createdLandscapes.splice(0)) {
    await page.context().request.delete(`${apiOrigin}/api/landscapes/${encodeURIComponent(id)}`).catch(() => {})
  }
})

async function createLandscape(page: Page, name: string): Promise<string> {
  const previous = landscapeFromUrl(page)
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('workspace-landscapes').click()
  await page.getByTestId('new-landscape-name').fill(name)
  await page.getByTestId('new-landscape-add').click()
  await expect(page.getByTestId('nav-menu')).toContainText(name, { timeout: 60_000 })
  await page.keyboard.press('Escape')
  await expect.poll(() => landscapeFromUrl(page), { timeout: 30_000 }).not.toBe(previous)
  const id = landscapeFromUrl(page)!
  createdLandscapes.push(id)
  return id
}

async function importDsl(page: Page, dsl: string): Promise<void> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  await page.getByTestId('create-diagram-button').click()
  await page.getByTestId('create-import').click()
  await page.getByTestId('import-textarea').fill(dsl)
  await page.getByTestId('import-parse').click()
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('import-error')).toHaveCount(0)
  await page.getByTestId('import-generate').click()
  await page.waitForURL(/\/diagram\//, { timeout: 60_000 })
}

/** Open a diagram through its card on the Diagrams page. */
async function openDiagramNamed(page: Page, name: RegExp): Promise<string> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  const card = page.locator('[data-testid^="diagram-card-"]', { hasText: name }).first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  const id = (await card.getAttribute('data-testid'))!.replace('diagram-card-', '')
  await card.dblclick()
  await page.waitForURL(new RegExp(`/diagram/${id}`), { timeout: 30_000 })
  return id
}

/** The shapes the canvas ENGINE holds, i.e. what is drawn — not the store. */
function canvasShapeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(((window as any).__canvasEngine?.objectMap as Map<string, unknown>) ?? new Map()).keys()].sort())
}

function viewedDiagram(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__modelStore.getState().currentDiagramId as string | null)
}

/** The canvas shows `diagramId` with exactly `shapes`, and the URL names it. */
async function expectOnCanvas(page: Page, versionRe: RegExp, diagramId: string, shapes: string[]): Promise<void> {
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 45_000, message: 'URL must name the viewed diagram' })
    .toMatch(new RegExp(`${versionRe.source}/diagram/${diagramId}$`))
  await expect.poll(() => viewedDiagram(page), { timeout: 15_000 }).toBe(diagramId)
  await expect
    .poll(() => canvasShapeIds(page), { timeout: 45_000, message: 'canvas must draw the viewed diagram' })
    .toEqual(shapes)
  // Present is not visible: the shapes' box must be framed inside the canvas.
  await expect
    .poll(() => framing(page), { timeout: 15_000, message: 'the diagram must be framed in the canvas' })
    .toEqual({ sane: true, inside: true })
}

/** The drawn shapes' bounding box, in screen pixels, against the canvas. */
function framing(page: Page): Promise<{ sane: boolean; inside: boolean }> {
  return page.evaluate(() => {
    const engine = (window as any).__canvasEngine
    const { x, y, scale } = engine.getViewport() as { x: number; y: number; scale: number }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const o of (engine.objectMap as Map<string, any>).values()) {
      minX = Math.min(minX, o.position.x)
      minY = Math.min(minY, o.position.y)
      maxX = Math.max(maxX, o.position.x + o.size.width)
      maxY = Math.max(maxY, o.position.y + o.size.height)
    }
    const rect = (engine.canvas as HTMLCanvasElement).getBoundingClientRect()
    const left = minX * scale + x, top = minY * scale + y
    const right = maxX * scale + x, bottom = maxY * scale + y
    return {
      sane: scale >= 0.1 && scale <= 4,
      inside: left >= 0 && top >= 0 && right <= rect.width && bottom <= rect.height,
    }
  })
}

test.describe('a Draft keeps the viewed diagram on the canvas', () => {
  test('create from "+ Add", exit, reopen and merge all land on the same drawn diagram', async ({ page }) => {
    test.setTimeout(300_000)
    page.on('dialog', (d) => void d.accept())
    const run = Date.now().toString(36)
    await signIn(page, `drafts-${run}@example.com`)
    const landscapeId = await createLandscape(page, `e2e-draft-stay-${run}`)
    await importDsl(page, DSL)

    // ── the live Containers diagram, drawn ──
    const containersId = await openDiagramNamed(page, /Containers/)
    await expect.poll(async () => (await canvasShapeIds(page)).length, { timeout: 45_000 }).toBeGreaterThan(3)
    const shapes = await canvasShapeIds(page)
    const live = new RegExp(`/app/landscape/${landscapeId}/version/current`)

    // ── "+ Add" → "New draft" → name → Enter ──
    await page.getByTestId('add-shape-button').click()
    await page.getByTestId('add-draft-option').click()
    await page.locator('#editor-add-draft-name').fill('Partner portal')
    await page.locator('#editor-add-draft-name').press('Enter')
    await expect(page.getByTestId('active-draft-pill')).toContainText('Partner portal', { timeout: 60_000 })
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).not.toMatch(live)
    const draftId = new URL(page.url()).pathname.match(/\/version\/([^/]+)/)![1]
    const inDraft = new RegExp(`/app/landscape/${landscapeId}/version/${draftId}`)
    await expectOnCanvas(page, inDraft, containersId, shapes)

    // ── exit X → live, same diagram ──
    await page.getByTestId('active-draft-pill').locator('button').first().click()
    await expectOnCanvas(page, live, containersId, shapes)

    // ── reopen from the Drafts page → the draft, same diagram ──
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('nav-drafts').click()
    await page.getByTestId(`draft-row-${draftId}`).dblclick()
    await expectOnCanvas(page, inDraft, containersId, shapes)

    // ── an edit in the Draft, then Review & merge → live, same diagram, edit drawn ──
    const added = await dragNewShapeToCanvas(page, 'system')
    const merged = [...shapes, added].sort()
    await expect.poll(() => canvasShapeIds(page), { timeout: 15_000 }).toEqual(merged)
    // The palette the drag opened sits over the Changes dropdown: close it.
    await page.keyboard.press('Escape')
    if (await page.getByTestId('create-shape-palette').count()) await page.getByTestId('add-shape').click()
    await expect(page.getByTestId('create-shape-palette')).toHaveCount(0)
    await page.waitForTimeout(1500) // > write debounce: the edit must be durable before the server diffs it
    await page.getByTestId('changes-dropdown-trigger').click()
    await page.getByTestId('review-merge-button').click()
    await expect(page.getByTestId('merge-button')).toBeEnabled({ timeout: 30_000 })
    await page.getByTestId('merge-button').click()
    await expect(page.getByTestId('active-draft-pill')).toHaveCount(0, { timeout: 60_000 })
    await expectOnCanvas(page, live, containersId, merged)
  })

  /**
   * The two cases where the viewed diagram is NOT simply in both versions.
   * Exit: a diagram made in the Draft is absent from live — the user must land
   * on a real live diagram, drawn, not on a blank canvas or not-found. Merge:
   * the same diagram becomes live by a merge applied IN PLACE, so this tab's
   * cached live registry is stale when the switch boots — "absent from my copy"
   * must not be read as "absent" (a first fix judged it by a 3 s timer, then by
   * the read model, which answers a sparse Draft from its parent).
   */
  test('exit off a diagram made in the Draft lands on live; merging it back lands on it', async ({ page }) => {
    test.setTimeout(300_000)
    page.on('dialog', (d) => void d.accept())
    const run = Date.now().toString(36)
    await signIn(page, `drafts-new-${run}@example.com`)
    const landscapeId = await createLandscape(page, `e2e-draft-new-${run}`)
    await importDsl(page, DSL)
    const containersId = await openDiagramNamed(page, /Containers/)
    await expect.poll(async () => (await canvasShapeIds(page)).length, { timeout: 45_000 }).toBeGreaterThan(3)
    const live = new RegExp(`/app/landscape/${landscapeId}/version/current`)
    const liveDiagramIds = await page.evaluate(
      () => ((window as any).__modelStore.getState().diagrams as Array<{ id: string }>).map((d) => d.id),
    )

    await page.getByTestId('add-shape-button').click()
    await page.getByTestId('add-draft-option').click()
    await page.locator('#editor-add-draft-name').fill('New screens')
    await page.locator('#editor-add-draft-name').press('Enter')
    await expect(page.getByTestId('active-draft-pill')).toContainText('New screens', { timeout: 60_000 })
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).not.toMatch(live)
    const draftId = new URL(page.url()).pathname.match(/\/version\/([^/]+)/)![1]
    const inDraft = new RegExp(`/app/landscape/${landscapeId}/version/${draftId}`)
    await expectOnCanvas(page, inDraft, containersId, await canvasShapeIds(page))

    // ── a diagram made in the Draft, with one shape, viewed ──
    await page.getByTestId('add-shape-button').click()
    await page.getByTestId('add-blank-diagram-option').click()
    await expect.poll(() => viewedDiagram(page), { timeout: 15_000 }).not.toBe(containersId)
    const draftOnlyId = (await viewedDiagram(page))!
    const shape = await dragNewShapeToCanvas(page, 'system')
    await page.keyboard.press('Escape')
    if (await page.getByTestId('create-shape-palette').count()) await page.getByTestId('add-shape').click()
    await expect(page.getByTestId('create-shape-palette')).toHaveCount(0)
    await page.waitForTimeout(1500) // > write debounce
    await expectOnCanvas(page, inDraft, draftOnlyId, [shape])

    // ── exit: live lacks it → a real live diagram, drawn ──
    await page.getByTestId('active-draft-pill').locator('button').first().click()
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 45_000 }).toMatch(new RegExp(`${live.source}/diagram/`))
    const landed = (await viewedDiagram(page))!
    expect(liveDiagramIds, 'exit must land on a diagram live really has').toContain(landed)
    await expect.poll(async () => (await canvasShapeIds(page)).length, { timeout: 45_000 }).toBeGreaterThan(0)
    await expect.poll(() => framing(page), { timeout: 15_000 }).toEqual({ sane: true, inside: true })

    // ── back into the Draft, onto its own diagram, then merge it into live ──
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('nav-drafts').click()
    await page.getByTestId(`draft-row-${draftId}`).dblclick()
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 45_000 }).toMatch(inDraft)
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('nav-diagrams').click()
    await page.getByTestId(`diagram-card-${draftOnlyId}`).dblclick()
    await expectOnCanvas(page, inDraft, draftOnlyId, [shape])
    await page.getByTestId('changes-dropdown-trigger').click()
    await page.getByTestId('review-merge-button').click()
    await expect(page.getByTestId('merge-button')).toBeEnabled({ timeout: 30_000 })
    await page.getByTestId('merge-button').click()
    await expect(page.getByTestId('active-draft-pill')).toHaveCount(0, { timeout: 60_000 })
    await expectOnCanvas(page, live, draftOnlyId, [shape])
  })
})
