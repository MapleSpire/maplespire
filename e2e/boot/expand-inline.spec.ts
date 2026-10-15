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
import { waitForWorkspaceProjected } from '../support/workspaceReady'
import { clickExpandIndicator } from './helpers'

/**
 * "Expand here" draws a linked diagram INSIDE the shape, in that diagram's own
 * arrangement — driven through the real ⤢ indicator and the real menu button.
 *
 * The defect (2026-10-15, found recording the Product Hunt video): on a System
 * Context diagram, ⤢ on a system → "Expand here" replaced the system with its
 * wrapper and drew ALL its containers on one point, stacked, only the top one
 * visible. The planner read the target's placement from the diagram index,
 * where every diagram but the active one is a layout-less STUB; a Structurizr
 * import leaves every model-level position equal, so all of them coincided.
 *
 * What makes this spec able to see it:
 *  - the source of truth for "where should they be" is each target diagram's
 *    own layout, read while THAT diagram is the active one (so it is complete),
 *    BEFORE a reload makes it a stub again;
 *  - a precondition asserts the target IS a stub when the expansion happens —
 *    on a build where it is not, this spec would be testing nothing;
 *  - the assertion is the ARRANGEMENT (every shape offset from its layout by
 *    one common translation), not merely "distinct": a grid fallback would be
 *    distinct and still wrong here, since the placement is readable.
 *
 * The nested half: a container pulled in by the first expansion carries ⤢ too.
 * Its indicator used to be dropped (the related-diagram query only asked about
 * the windowed store), and the planner refused a host that was not in the base
 * diagram, so it was a click that did nothing.
 *
 * Runs against the boot stack (windowed store + server read model), with or
 * without AUTH: E2E_BOOT_URL / E2E_BOOT_API, see e2e/boot/README.md.
 */

const DSL = `workspace "Expand inline" {
    !identifiers hierarchical
    model {
        customer = person "Customer" "Orders things."
        stripe = softwareSystem "Card processor" "Payments." "External"
        shop = softwareSystem "Shop" "The system expanded in place." {
            web = container "Web App" "Storefront." "React"
            orders = container "Order Service" "Order lifecycle." "NodeJS" {
                api = component "Order API" "REST." "Express"
                checkout = component "Checkout" "Takes payment." "NodeJS"
                machine = component "Order State Machine" "Lifecycle." "NodeJS"
            }
            payments = container "Payment Service" "Charges." "Golang"
            db = container "Orders Database" "History." "PostgreSQL"
        }
        customer -> shop.web "Orders with"
        shop.web -> shop.orders.api "Places orders" "HTTPS"
        shop.orders.api -> shop.orders.checkout "Submits cart"
        shop.orders.checkout -> shop.orders.machine "Creates order"
        shop.orders.checkout -> shop.payments "Charges card" "gRPC"
        shop.orders.machine -> shop.db "Stores orders" "SQL"
        shop.payments -> stripe "Charges cards" "HTTPS"
    }
    views {
        systemContext shop { include * autoLayout }
        container shop { include * autoLayout }
        component shop.orders { include * autoLayout }
    }
}`

interface Placement { position: { x: number; y: number }; size: { width: number; height: number } }
interface ProbeDiagram {
  id: string
  type: string
  parentObjectId?: string
  objectIds: string[]
  layouts: Record<string, Placement> | null
}

// ── UI drivers ───────────────────────────────────────────────────────────────

async function signIn(page: Page): Promise<void> {
  await page.goto('/app')
  const devLogin = page.getByTestId('dev-login-email')
  await Promise.race([
    devLogin.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined),
    page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+/, { timeout: 45_000 }).catch(() => undefined),
  ])
  if (await devLogin.isVisible().catch(() => false)) {
    await submitDevLogin(page, `e2e-expand-inline-${Date.now()}@example.com`)
  }
  await page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+/, { timeout: 90_000 })
  await page.waitForFunction(() => Array.isArray((window as any).__modelStore?.getState?.().diagrams), undefined, {
    timeout: 60_000,
  })
}

function landscapeFromUrl(page: Page): string | null {
  return new URL(page.url()).pathname.match(/\/landscape\/([^/]+)\//)?.[1] ?? null
}

const createdLandscapes: string[] = []
let apiOrigin: string | null = null

test.afterEach(async ({ page }) => {
  for (const id of createdLandscapes.splice(0)) {
    if (!apiOrigin) break
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

async function gotoDiagrams(page: Page): Promise<void> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  await expect(page.locator('[data-testid^="diagram-card-"]').first()).toBeVisible({ timeout: 30_000 })
}

// ── Probes (read-only) ───────────────────────────────────────────────────────

function readDiagram(page: Page, id: string): Promise<ProbeDiagram | null> {
  return page.evaluate((diagramId) => {
    const diagram = (window as any).__modelStore.getState().diagrams.find((d: any) => d.id === diagramId)
    if (!diagram) return null
    return {
      id: diagram.id,
      type: diagram.type,
      parentObjectId: diagram.parentObjectId,
      objectIds: [...diagram.objectIds],
      layouts: diagram.layouts ? JSON.parse(JSON.stringify(diagram.layouts)) : null,
    }
  }, id)
}

/** Select a card and wait until the store holds that diagram FULLY placed —
 *  the only moment its layout is in memory, and the ground truth below. */
async function materialise(page: Page, id: string): Promise<ProbeDiagram> {
  await page.getByTestId(`diagram-card-${id}`).click()
  await expect
    .poll(
      async () => {
        const d = await readDiagram(page, id)
        return !!d && d.objectIds.length > 0 && d.objectIds.every((o) => d.layouts?.[o] !== undefined)
      },
      { timeout: 45_000, message: `diagram ${id} never became fully placed in the store` },
    )
    .toBe(true)
  return (await readDiagram(page, id))!
}

type EnginePositions = Record<string, { x: number; y: number }>

function enginePositions(page: Page): Promise<EnginePositions> {
  return page.evaluate(() => {
    const out: Record<string, { x: number; y: number }> = {}
    for (const [id, o] of (window as any).__canvasEngine.objectMap as Map<string, any>) {
      out[id] = { x: o.position.x, y: o.position.y }
    }
    return out
  })
}

/** Wait until every id is drawn, then return where. */
async function waitDrawn(page: Page, ids: string[], what: string): Promise<EnginePositions> {
  await expect
    .poll(async () => {
      const drawn = await enginePositions(page)
      return ids.filter((id) => !drawn[id])
    }, { timeout: 30_000, message: `${what} never all reached the canvas` })
    .toEqual([])
  return enginePositions(page)
}

/**
 * The block must be the target's arrangement, translated as a whole: every
 * shape's offset from its own layout position is the SAME vector. On the
 * defective build every shape sat on one point, so the offsets differed by
 * exactly the layout's spread.
 */
function expectArrangement(drawn: EnginePositions, layouts: Record<string, Placement>, ids: string[], what: string) {
  const keys = ids.map((id) => `${drawn[id].x},${drawn[id].y}`)
  expect(new Set(keys).size, `${what}: two shapes share one position — ${JSON.stringify(drawn)}`).toBe(ids.length)
  const [first] = ids
  const dx = drawn[first].x - layouts[first].position.x
  const dy = drawn[first].y - layouts[first].position.y
  for (const id of ids) {
    expect(
      { x: drawn[id].x - layouts[id].position.x, y: drawn[id].y - layouts[id].position.y },
      `${what}: ${id} is not where the target diagram's layout puts it`,
    ).toEqual({ x: dx, y: dy })
  }
}

/**
 * What the engine DRAWS that sits on something it does not belong to: two
 * shapes overlapping, a shape over a wrapper it is not inside, two wrappers
 * crossing without one wholly containing the other. Read from the engine's own
 * boxes (`getGroupBoundsById`), not recomputed: the box drawn is the claim.
 */
function drawnOverlaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const engine = (window as any).__canvasEngine
    type Box = { x: number; y: number; width: number; height: number }
    const cross = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    const inside = (o: Box, i: Box) => i.x >= o.x && i.y >= o.y && i.x + i.width <= o.x + o.width && i.y + i.height <= o.y + o.height
    const shapes = [...(engine.objectMap as Map<string, any>).values()].map((o) => ({
      id: o.id as string, box: { x: o.position.x, y: o.position.y, width: o.size.width, height: o.size.height } as Box,
    }))
    const wrappers = (engine.groups as any[])
      .filter((g) => String(g.id).startsWith('inline-expand:'))
      .map((g) => ({ id: g.id as string, members: new Set<string>(g.objectIds), box: engine.getGroupBoundsById(g.id) as Box }))
    const out: string[] = []
    for (const a of shapes) {
      for (const b of shapes) if (a.id < b.id && cross(a.box, b.box)) out.push(`${a.id} × ${b.id}`)
      for (const w of wrappers) if (!w.members.has(a.id) && cross(a.box, w.box)) out.push(`${a.id} × ${w.id}`)
    }
    for (const a of wrappers) {
      for (const b of wrappers) {
        if (a.id >= b.id || !cross(a.box, b.box)) continue
        if (!inside(a.box, b.box) && !inside(b.box, a.box)) out.push(`${a.id} × ${b.id}`)
      }
    }
    return out
  })
}

const wrapperBox = (page: Page, hostId: string) =>
  page.evaluate((id) => (window as any).__canvasEngine.getGroupBoundsById(`inline-expand:${id}`), hostId) as
    Promise<{ x: number; y: number; width: number; height: number } | null>

// Shared stateful backend — never run beside the rest.
test.describe.configure({ mode: 'serial' })

test('Expand here draws the linked diagram in its own arrangement, nested expansions included', async ({ page }) => {
  test.setTimeout(300_000)
  page.on('request', (request) => {
    if (apiOrigin) return
    try {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) apiOrigin = url.origin
    } catch { /* not an http request */ }
  })

  await signIn(page)
  const bootFromServer = await page.evaluate(() => (window as any).__bootFromServer?.enabled?.() ?? false)
  expect(bootFromServer, 'this spec targets the windowed boot-from-server stack').toBe(true)
  await createLandscape(page, `expand-inline-e2e-${Date.now()}`)
  await importDsl(page, DSL)

  // ── Ground truth: each diagram's own layout, read while it is active ──────
  await gotoDiagrams(page)
  const cardIds = await page
    .locator('[data-testid^="diagram-card-"]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-testid')!.slice('diagram-card-'.length)))
  const diagrams: ProbeDiagram[] = []
  for (const id of cardIds) {
    const d = await readDiagram(page, id)
    if (d && d.objectIds.length > 0) diagrams.push(await materialise(page, id))
  }
  const context = diagrams.find((d) => d.type === 'context')!
  const containers = diagrams.find((d) => d.type === 'container')!
  const components = diagrams.find((d) => d.type === 'component')!
  expect(context && containers && components, 'the import must produce all three views').toBeTruthy()
  const systemId = containers.parentObjectId!
  const serviceId = components.parentObjectId!
  expect(context.objectIds, 'the system must be on the context diagram').toContain(systemId)
  expect(containers.objectIds, 'the service must be on the containers diagram').toContain(serviceId)

  // What each expansion is expected to pull in: the target's shapes not already
  // drawn by then. In this fixture the outside world of each view (the person,
  // the card processor; then the sibling containers) is exactly what the
  // enclosing diagram already shows, so no scope lookup is needed.
  const pulledContainers = containers.objectIds.filter((id) => !context.objectIds.includes(id))
  expect(pulledContainers.length, 'fixture: the system holds several containers').toBeGreaterThanOrEqual(4)
  const pulledComponents = components.objectIds.filter((id) => !context.objectIds.includes(id) && !containers.objectIds.includes(id))
  expect(pulledComponents.length, 'fixture: the service holds several components').toBeGreaterThanOrEqual(3)

  // ── Cold reload on the context diagram: every other diagram is a stub ─────
  await waitForWorkspaceProjected(page)
  const workspace = new URL(page.url()).pathname.match(/\/app\/landscape\/[^/]+\/version\/[^/]+/)![0]
  await page.goto(`${workspace}/diagram/${context.id}`)
  await page.waitForFunction(
    (id) => (window as any).__modelStore?.getState?.().currentDiagramId === id
      && ((window as any).__canvasEngine?.objectMap?.size ?? 0) > 0,
    context.id,
    { timeout: 60_000 },
  )
  await waitDrawn(page, [systemId], 'the system')
  const stub = await readDiagram(page, containers.id)
  expect(stub?.layouts ?? null, 'precondition: the target must be a layout-less stub when it is expanded').toBeNull()

  // ── ⤢ → Expand here, on the system ──────────────────────────────────────
  const beforeOuter = await enginePositions(page)
  await clickExpandIndicator(page, systemId)
  await page.getByTestId(`expand-here-${containers.id}`).click()
  const afterOuter = await waitDrawn(page, pulledContainers, 'the containers')
  expectArrangement(afterOuter, containers.layouts!, pulledContainers, 'outer expansion')
  expect(afterOuter[systemId], 'the system is replaced by its wrapper').toBeUndefined()
  // Room is made (2026-10-15, second defect): the block is its true size, many
  // times the system's, and used to be drawn over the shapes beside and below
  // it. The wrapper's box takes the system's place; the rest moves out of it.
  const outerBox = await wrapperBox(page, systemId)
  expect(outerBox, 'the wrapper is drawn').not.toBeNull()
  expect({ x: outerBox!.x, y: outerBox!.y }, 'the wrapper starts where the system was').toEqual(beforeOuter[systemId])
  expect(await drawnOverlaps(page), 'the expanded block is drawn over other shapes').toEqual([])

  // ── Nested: ⤢ on a container the first expansion pulled in ──────────────
  // The ⤢ must be DRAWN on it — clicking alone cannot tell: in edit mode the
  // corner opens the menu whether ⤢ or the hover "+" (create a diagram) is
  // drawn, so a broken build still passed the click (measured: mutant green).
  // The related-diagram query that decides it used to ask only about the
  // windowed store; its answer replaced the render path's and the pulled
  // shapes lost ⤢ (sampled every 250 ms for 6 s on that mutant: never drawn).
  const drawsExpandIcon = () =>
    page.evaluate((id) => (window as any).__canvasEngine.relatedDiagramObjectIds.has(id) as boolean, serviceId)
  await expect
    .poll(drawsExpandIcon, { timeout: 15_000, message: 'the pulled container shows no ⤢ — nothing says it can be expanded' })
    .toBe(true)
  await clickExpandIndicator(page, serviceId)
  expect(await drawsExpandIcon(), 'the ⤢ was gone by the time it was clicked').toBe(true)
  await page.getByTestId(`expand-here-${components.id}`).click()
  const afterInner = await waitDrawn(page, pulledComponents, 'the components')
  expectArrangement(afterInner, components.layouts!, pulledComponents, 'nested expansion')
  expect(afterInner[serviceId], 'the service is replaced by its wrapper').toBeUndefined()
  // The inner block's box starts where the service was — the outer block's
  // origin is unchanged, and so is everything before the service inside it —
  // and its siblings past it moved out of its way (Payment Service, in the
  // repro), as did the diagram, for the outer block that grew around it.
  const innerBox = await wrapperBox(page, serviceId)
  expect({ x: innerBox!.x, y: innerBox!.y }, 'the nested wrapper starts where the service was').toEqual(afterOuter[serviceId])
  expect(await drawnOverlaps(page), 'the nested block is drawn over other shapes').toEqual([])

  // ── Dragging a DISPLACED shape writes its model position, not the view's ──
  // The engine reports where it draws a shape; with room made that is not
  // where the model has it. The displacement must never reach the model.
  const displaced = await page.evaluate((ids) => {
    const store = (window as any).__modelStore.getState()
    const layouts = store.diagrams.find((d: any) => d.id === store.currentDiagramId).layouts ?? {}
    const engine = (window as any).__canvasEngine
    for (const id of ids) {
      const drawn = engine.objectMap.get(id)
      const model = layouts[id]?.position
      if (drawn && model && (drawn.position.x !== model.x || drawn.position.y !== model.y)) {
        return { id, model: { ...model }, drawn: { ...drawn.position } }
      }
    }
    return null
  }, context.objectIds.filter((id) => id !== systemId))
  expect(displaced, 'precondition: some shape of the context diagram was moved out of the way').not.toBeNull()
  const grab = await page.evaluate((id) => {
    const engine = (window as any).__canvasEngine
    const o = engine.objectMap.get(id)
    const wx = o.position.x + o.size.width / 2
    const wy = o.position.y + o.size.height / 2
    engine.panToWorld(wx, wy)
    const rect = engine.canvas.getBoundingClientRect()
    const vp = engine.viewport
    return { x: wx * vp.scale + vp.x + rect.left, y: wy * vp.scale + vp.y + rect.top }
  }, displaced!.id)
  // Further along the way it was pushed: a drop inside the gap a cut opened has
  // no model coordinate of its own and snaps to the cut (a jump, by design).
  const along = {
    x: displaced!.drawn.x !== displaced!.model.x ? 10 : 0,
    y: displaced!.drawn.y !== displaced!.model.y ? 6 : 0,
  }
  const drawnNow = (id: string) =>
    page.evaluate((oid) => ({ ...(window as any).__canvasEngine.objectMap.get(oid).position }), id) as Promise<{ x: number; y: number }>
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step++) await page.mouse.move(grab.x + step * along.x, grab.y + step * along.y)
  // The drag is measured BEFORE the drop. After it, the view is recomputed from
  // whatever was written — and "drawn after − drawn before" then hides a written
  // displacement exactly (measured: a mutant writing the view coordinate passed
  // when this was read after mouse-up).
  const preview = await drawnNow(displaced!.id)
  await page.mouse.up()
  const moved = { x: preview.x - displaced!.drawn.x, y: preview.y - displaced!.drawn.y }
  expect(Math.hypot(moved.x, moved.y), 'the drag moved the shape').toBeGreaterThan(0)
  // The drop snaps to the grid (half a cell at most); the displacement written
  // by mistake is hundreds of units, so the tolerance cannot hide it.
  const SNAP = 20
  const near = (a: { x: number; y: number } | null, b: { x: number; y: number }) =>
    !!a && Math.abs(a.x - b.x) <= SNAP && Math.abs(a.y - b.y) <= SNAP
  const target = { x: displaced!.model.x + moved.x, y: displaced!.model.y + moved.y }
  await expect
    .poll(() => page.evaluate((id) => {
      const store = (window as any).__modelStore.getState()
      return store.diagrams.find((d: any) => d.id === store.currentDiagramId).layouts?.[id]?.position ?? null
    }, displaced!.id).then((stored) => near(stored, target) || stored), {
      timeout: 10_000, message: `the model must hold model position + drag (${JSON.stringify(target)}), not the displaced one`,
    })
    .toBe(true)
  // ...and the recomputed view still draws it where it was dropped: no jump.
  await expect
    .poll(() => drawnNow(displaced!.id).then((at) => near(at, preview) || at), { message: 'the shape jumped after the drop' })
    .toBe(true)
})
