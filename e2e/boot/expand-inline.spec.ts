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
import { test, expect, type Browser, type Page, type WebSocketRoute } from '@playwright/test'
import { submitDevLogin } from '../support/devLogin'
import { waitForWorkspaceProjected } from '../support/workspaceReady'
import { clickExpandIndicator, dragNewShapeToCanvas, goOffline, goOnline, installServerRouting } from './helpers'

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

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/app')
  const devLogin = page.getByTestId('dev-login-email')
  await Promise.race([
    devLogin.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined),
    page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+/, { timeout: 45_000 }).catch(() => undefined),
  ])
  if (await devLogin.isVisible().catch(() => false)) {
    await submitDevLogin(page, email)
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
  // Keep the SAME read that satisfied the poll. Reading again afterwards raced
  // the next projection: the diagram could already be a layout-less stub again,
  // and the ground truth came back with `layouts: null` (measured 2026-10-15:
  // 1 run in ~20, a TypeError deep in expectArrangement).
  // Widened by hand: assigned inside the poll callback, which control-flow
  // analysis cannot see, so a plain `null` initialiser narrows it to `never`.
  let placed = null as ProbeDiagram | null
  await expect
    .poll(
      async () => {
        const d = await readDiagram(page, id)
        const complete = !!d && d.objectIds.length > 0 && d.objectIds.every((o) => d.layouts?.[o] !== undefined)
        if (complete) placed = d
        return complete
      },
      { timeout: 45_000, message: `diagram ${id} never became fully placed in the store` },
    )
    .toBe(true)
  return placed!
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

/** Sign in, import the fixture into a new landscape, and read each diagram's
 *  own layout while it is the active one — the ground truth for "where". */
async function importFixture(page: Page, email = `e2e-expand-inline-${Date.now()}@example.com`) {
  page.on('request', (request) => {
    if (apiOrigin) return
    try {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) apiOrigin = url.origin
    } catch { /* not an http request */ }
  })

  await signIn(page, email)
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

  return { email, context, containers, components, systemId, serviceId, pulledContainers, pulledComponents }
}

/** Open a diagram by URL in this workspace and wait for its first frame. */
async function openDiagram(page: Page, workspace: string, diagramId: string): Promise<void> {
  await page.goto(`${workspace}/diagram/${diagramId}`)
  await page.waitForFunction(
    (id) => (window as any).__modelStore?.getState?.().currentDiagramId === id
      && ((window as any).__canvasEngine?.objectMap?.size ?? 0) > 0,
    diagramId,
    { timeout: 60_000 },
  )
}

/** Click the collapse indicator of an inline expansion's wrapper. The engine's
 *  own hit test picks the point, so this cannot click beside it and pass. */
async function clickCollapseIndicator(page: Page, hostObjectId: string): Promise<void> {
  const pt = await page.evaluate((host) => {
    const eng = (window as any).__canvasEngine
    const group = [...eng.groupMap.values()].find((g: any) => g.parentObjectId === host && g.id.startsWith('inline-expand:'))
    // An auto-sized wrapper has no stored geometry; the engine derives it.
    const bounds = group && eng.getGroupBounds(group)
    if (!bounds) return null
    const right = bounds.x + bounds.width
    const top = bounds.y
    for (let y = top; y <= top + 60; y += 2) {
      for (let x = right - 60; x <= right; x += 2) {
        // The point must also be the one a click resolves to this group.
        if (eng.isClickOnGroupExpandIndicator(group, x, y) && eng.hitTestGroup(x, y)?.id === group.id) {
          eng.panToWorld(x, y)
          const rect = eng.canvas.getBoundingClientRect()
          const vp = eng.viewport
          return { x: x * vp.scale + vp.x + rect.left, y: y * vp.scale + vp.y + rect.top }
        }
      }
    }
    return null
  }, hostObjectId)
  expect(pt, `no collapse indicator found on the wrapper of ${hostObjectId}`).not.toBeNull()
  await page.mouse.click(pt!.x, pt!.y)
}

/** Select the first shape of `type` by clicking its centre on the canvas, and
 *  rename it in the side panel — the real selection and edit paths. */
async function renameShapeOfType(page: Page, type: string, name: string): Promise<string> {
  // The point must be one the engine's own hit test gives to THAT shape. Right
  // after an import every shape first sits on one model-level position until
  // the diagram's layout lands, and a click there renamed whichever shape was
  // on top (2026-10-16: aimed at Web App, renamed Order Service, 5 runs of 5).
  let pt = null as { id: string; x: number; y: number } | null
  await expect.poll(async () => {
    pt = await page.evaluate((wanted) => {
      const eng = (window as any).__canvasEngine
      const o = [...eng.objectMap.values()].find((candidate: any) => candidate.type === wanted)
      if (!o) return null
      const wx = o.position.x + o.size.width / 2
      const wy = o.position.y + o.size.height / 2
      if (eng.hitTest(wx, wy)?.id !== o.id) return null
      eng.panToWorld(wx, wy)
      const rect = eng.canvas.getBoundingClientRect()
      const vp = eng.viewport
      return { id: o.id as string, x: wx * vp.scale + vp.x + rect.left, y: wy * vp.scale + vp.y + rect.top }
    }, type)
    return pt !== null
  }, { timeout: 30_000, message: `no ${type} on the canvas that a click at its centre would select` }).toBe(true)
  await page.mouse.click(pt!.x, pt!.y)
  const field = page.getByTestId('object-name')
  await field.waitFor({ state: 'visible', timeout: 10_000 })
  await field.fill(name)
  await field.press('Enter')
  await expect(field).toHaveValue(name)
  return pt!.id
}

/** `expectArrangement` as a predicate, for polling and for preconditions. */
function isArrangement(drawn: EnginePositions, layouts: Record<string, Placement>, ids: string[]): boolean {
  const [first] = ids
  if (!drawn[first]) return false
  const dx = drawn[first].x - layouts[first].position.x
  const dy = drawn[first].y - layouts[first].position.y
  return ids.every((id) => drawn[id]
    && drawn[id].x - layouts[id].position.x === dx
    && drawn[id].y - layouts[id].position.y === dy)
}

// Shared stateful backend — never run beside the rest.
test.describe.configure({ mode: 'serial' })

test('Expand here draws the linked diagram in its own arrangement, nested expansions included', async ({ page }) => {
  test.setTimeout(300_000)
  const { context, containers, components, systemId, serviceId, pulledContainers, pulledComponents } =
    await importFixture(page)

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
  // A comment pinned past where the cuts will fall, BEFORE expanding: when the
  // expansion opens only the cuts change, not the comments — the pin must still
  // move with everything else (QA lens 2026-10-15: no test saw it).
  const systemSize = await page.evaluate((id) => ({ ...(window as any).__canvasEngine.objectMap.get(id).size }), systemId)
  const pinScreen = await page.evaluate(({ x, y }) => {
    const engine = (window as any).__canvasEngine
    engine.panToWorld(x, y)
    const rect = engine.canvas.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }, { x: beforeOuter[systemId].x + systemSize.width + 700, y: beforeOuter[systemId].y + systemSize.height + 700 })
  await page.getByTestId('comment-mode-toggle').click()
  await page.mouse.click(pinScreen.x, pinScreen.y)
  await page.getByTestId('comment-input').fill('pinned before expanding')
  await page.getByTestId('comment-submit').click()
  const pinModel = () => page.evaluate(() => {
    const s = (window as any).__modelStore.getState()
    const c = s.comments.find((x: any) => x.diagramId === s.currentDiagramId && x.text === 'pinned before expanding')
    return c ? { id: c.id as string, position: { ...c.position } as { x: number; y: number } } : null
  })
  await expect.poll(pinModel, { message: 'the comment was not created' }).not.toBeNull()
  const pin = (await pinModel())!
  await page.keyboard.press('Escape')
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
  // The pin moved with the rest — by exactly the room made — and the model
  // comment did not.
  const pinDrawn = () => page.evaluate((id) => (window as any).__canvasEngine.getCommentPosition(id), pin.id) as
    Promise<{ x: number; y: number } | null>
  await expect.poll(pinDrawn, { message: 'the pin was not moved out of the way with the rest' }).toEqual({
    x: pin.position.x + outerBox!.width - systemSize.width,
    y: pin.position.y + outerBox!.height - systemSize.height,
  })
  expect((await pinModel())!.position, 'the displacement reached the stored comment').toEqual(pin.position)

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

  // ── Every OTHER writer from this canvas, past a cut ──────────────────────
  // Found by the review lenses (2026-10-15): the palette drop and the comment
  // composer wrote the view point as is, so the next render displaced it a
  // second time — the new shape / pin appeared hundreds of units away.
  const outerNow = (await wrapperBox(page, systemId))!
  /** Pan a world point beyond (right of and below) the whole block to the
   *  canvas centre; return the world point actually under the centre. */
  const centreBeyondBlock = (dy: number) => page.evaluate(({ x, y }) => {
    const engine = (window as any).__canvasEngine
    engine.panToWorld(x, y)
    const rect = engine.canvas.getBoundingClientRect()
    return {
      world: engine.screenToWorld(rect.width / 2, rect.height / 2) as { x: number; y: number },
      screen: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    }
  }, { x: outerNow.x + outerNow.width + 400, y: outerNow.y + outerNow.height + 400 + dy })

  const dropAt = await centreBeyondBlock(0)
  expect(dropAt.world.y, 'precondition: the drop point is past the cut').toBeGreaterThan(outerNow.y + outerNow.height)
  const created = await dragNewShapeToCanvas(page, 'app', 0.5, 0.5)
  await expect
    .poll(() => page.evaluate((id) => {
      const o = (window as any).__canvasEngine.objectMap.get(id)
      return o ? { x: o.position.x + o.size.width / 2, y: o.position.y + o.size.height / 2 } : null
    }, created).then((centre) => near(centre, dropAt.world) || centre), {
      message: `the dropped shape is not drawn where it was dropped (${JSON.stringify(dropAt.world)})`,
    })
    .toBe(true)

  const pinAt = await centreBeyondBlock(500)
  await page.keyboard.press('Escape')
  await page.getByTestId('comment-mode-toggle').click()
  await page.mouse.click(pinAt.screen.x, pinAt.screen.y)
  await page.getByTestId('comment-input').fill('pinned past the cut')
  await page.getByTestId('comment-submit').click()
  await expect
    .poll(() => page.evaluate(() => {
      const s = (window as any).__modelStore.getState()
      const c = s.comments.find((x: any) => x.diagramId === s.currentDiagramId && x.text === 'pinned past the cut')
      return c ? (window as any).__canvasEngine.getCommentPosition(c.id) : null
    }).then((drawn) => near(drawn, pinAt.world) || drawn), { message: 'the new pin is not drawn where it was placed' })
    .toBe(true)

  // ── Moving a DISPLACED pin stores model position + move ──────────────────
  await page.keyboard.press('Escape')
  const pinBefore = (await pinDrawn())!
  const pinModelBefore = (await pinModel())!.position
  expect(pinBefore, 'precondition: the pin is drawn displaced').not.toEqual(pinModelBefore)
  const pinGrab = await page.evaluate(({ x, y }) => {
    const engine = (window as any).__canvasEngine
    engine.panToWorld(x, y)
    const rect = engine.canvas.getBoundingClientRect()
    const s = engine.worldToScreen(x, y)
    return { x: rect.left + s.x, y: rect.top + s.y }
  }, pinBefore)
  await page.mouse.move(pinGrab.x, pinGrab.y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step++) await page.mouse.move(pinGrab.x + step * 10, pinGrab.y + step * 6)
  const pinPreview = (await pinDrawn())!
  await page.mouse.up()
  const pinMoved = { x: pinPreview.x - pinBefore.x, y: pinPreview.y - pinBefore.y }
  expect(Math.hypot(pinMoved.x, pinMoved.y), 'the drag moved the pin').toBeGreaterThan(0)
  const pinTarget = { x: pinModelBefore.x + pinMoved.x, y: pinModelBefore.y + pinMoved.y }
  await expect
    .poll(() => pinModel().then((c) => near(c?.position ?? null, pinTarget) || c?.position), {
      message: `the moved pin must be stored at model position + move (${JSON.stringify(pinTarget)})`,
    })
    .toBe(true)
  await expect
    .poll(() => pinDrawn().then((at) => near(at, pinPreview) || at), { message: 'the pin jumped after the move' })
    .toBe(true)
})

// Collapsing an expansion used to leave the ones nested inside it in uiStore:
// reported 'missing' on every render, their targets still loaded, and back on
// screen when the outer shape was expanded again.
test('collapsing an outer expansion drops the ones nested inside it', async ({ page }) => {
  test.setTimeout(300_000)
  const { context, containers, components, systemId, serviceId, pulledContainers, pulledComponents } =
    await importFixture(page)
  await waitForWorkspaceProjected(page)
  const workspace = new URL(page.url()).pathname.match(/\/app\/landscape\/[^/]+\/version\/[^/]+/)![0]
  await openDiagram(page, workspace, context.id)
  await waitDrawn(page, [systemId], 'the system')
  await clickExpandIndicator(page, systemId)
  await page.getByTestId(`expand-here-${containers.id}`).click()
  await waitDrawn(page, pulledContainers, 'the containers')
  await expect
    .poll(() => page.evaluate((id) => (window as any).__canvasEngine.relatedDiagramObjectIds.has(id) as boolean, serviceId), {
      timeout: 15_000,
    })
    .toBe(true)
  await clickExpandIndicator(page, serviceId)
  await page.getByTestId(`expand-here-${components.id}`).click()
  await waitDrawn(page, pulledComponents, 'the components')

  // ── Collapse the OUTER one: the nested expansion goes with it ────────────
  // It used to stay in uiStore: reported 'missing' on every render, its target
  // still loaded, and, what a user sees, back again on re-expanding the
  // system, reopening a tree they had just closed.
  await clickCollapseIndicator(page, systemId)
  await expect
    .poll(async () => {
      const drawn = await enginePositions(page)
      return { system: !!drawn[systemId], leftovers: [...pulledContainers, ...pulledComponents].filter((id) => drawn[id]) }
    }, { timeout: 15_000, message: 'collapsing the system did not restore it as a shape' })
    .toEqual({ system: true, leftovers: [] })

  await clickExpandIndicator(page, systemId)
  await page.getByTestId(`expand-here-${containers.id}`).click()
  // Not the service: whether it is drawn as a shape is the question below.
  await waitDrawn(page, pulledContainers.filter((id) => id !== serviceId), 'the containers, re-expanded')
  // Give a remembered nested entry time to apply (its target loads well under
  // this on a local stack), then look.
  await page.waitForTimeout(3_000)
  const reExpanded = await enginePositions(page)
  expect(reExpanded[serviceId], 'the service came back expanded: the nested entry outlived its collapse').toBeDefined()
  expect(pulledComponents.filter((id) => reExpanded[id]), 'components drawn without being asked for').toEqual([])
})

/** Every edge the engine draws, as `from→to`, with whether it is a roll-up. */
function drawnEdges(page: Page): Promise<Array<{ pair: string; fromId: string; toId: string; lower: boolean }>> {
  return page.evaluate(() =>
    ((window as any).__canvasEngine.connections as any[]).map((c) => ({
      pair: `${c.fromId}→${c.toId}`, fromId: c.fromId as string, toId: c.toId as string, lower: c.kind === 'lower',
    })))
}

// Seen 2026-10-16 on develop bfdceb13a (FoodDash): the expanded containers
// showed 2 of the containers view's edges. The rest are DERIVED — declared on
// a component, drawn between containers (Web App -> Order API is Web App ->
// Order Service) — and a non-active diagram's stub never lists them; the edges
// to the shapes around the block (Payment Service -> Card processor) were
// dropped for having one end outside it. Ground truth: what the engine draws
// on each target diagram while it is the active one.
test('Expand here draws the target\'s edges, derived and outward ones included, nested too', async ({ page }) => {
  test.setTimeout(300_000)
  const { context, containers, components, systemId, serviceId, pulledContainers, pulledComponents } =
    await importFixture(page)
  await waitForWorkspaceProjected(page)
  const workspace = new URL(page.url()).pathname.match(/\/app\/landscape\/[^/]+\/version\/[^/]+/)![0]

  type Edges = Awaited<ReturnType<typeof drawnEdges>>
  const truthOf = async (diagramId: string, what: string, settled: (edges: Edges) => boolean) => {
    await openDiagram(page, workspace, diagramId)
    let edges: Edges = []
    await expect.poll(async () => settled(edges = await drawnEdges(page)), {
      timeout: 30_000, message: `the ${what} diagram never drew what the fixture declares`,
    }).toBe(true)
    return edges
  }
  // Precondition, and the wait: without a roll-up onto the service this tests
  // nothing. Right after an import the active diagram first draws its declared
  // edges only: its render answered 404 before the server projected the import,
  // and the roll-ups arrive with the live refresh after it (measured 2026-10-16,
  // FoodDash, AUTH on: ~2 s; on an AUTH-off stack whose new landscape never
  // turned durable, never — the refresh waits for the badge to be 'ready').
  const containerEdges = await truthOf(containers.id, 'containers',
    (edges) => edges.some((e) => e.lower && (e.fromId === serviceId || e.toId === serviceId)))
  const componentEdges = await truthOf(components.id, 'components', (edges) => edges.length > 0)
  expect(containerEdges.some((e) => pulledContainers.includes(e.fromId) !== pulledContainers.includes(e.toId)),
    'fixture: some container edge leaves the system').toBe(true)

  await openDiagram(page, workspace, context.id)
  await waitDrawn(page, [systemId], 'the system')
  const stub = await readDiagram(page, containers.id)
  expect(stub?.layouts ?? null, 'precondition: the target must be a layout-less stub when it is expanded').toBeNull()

  /** The target's edges whose two ends are shapes on screen now. */
  const expectedOf = async (truth: typeof containerEdges) => {
    const drawn = await enginePositions(page)
    return truth.filter((e) => drawn[e.fromId] && drawn[e.toId]).map((e) => e.pair).sort()
  }
  const missing = async (truth: typeof containerEdges) => {
    const pairs = new Set((await drawnEdges(page)).map((e) => e.pair))
    return (await expectedOf(truth)).filter((pair) => !pairs.has(pair))
  }

  await clickExpandIndicator(page, systemId)
  await page.getByTestId(`expand-here-${containers.id}`).click()
  await waitDrawn(page, pulledContainers, 'the containers')
  expect((await expectedOf(containerEdges)).length, 'every container edge has its ends on screen').toBe(containerEdges.length)
  await expect.poll(() => missing(containerEdges), {
    timeout: 15_000, message: 'container edges the Containers diagram draws are missing from the expansion',
  }).toEqual([])

  // ── Nested: the components' links to the containers around them ─────────
  await expect
    .poll(() => page.evaluate((id) => (window as any).__canvasEngine.relatedDiagramObjectIds.has(id) as boolean, serviceId), {
      timeout: 15_000,
    })
    .toBe(true)
  await clickExpandIndicator(page, serviceId)
  await page.getByTestId(`expand-here-${components.id}`).click()
  await waitDrawn(page, pulledComponents, 'the components')
  await expect.poll(() => missing(componentEdges), {
    timeout: 15_000, message: 'component edges the Components diagram draws are missing from the nested expansion',
  }).toEqual([])
  // The roll-ups onto the service stay, on its wrapper (they may summarise
  // more than the block draws) — and no pair is drawn twice.
  const pairs = (await drawnEdges(page)).filter((e) => e.lower).map((e) => e.pair)
  expect(pairs.filter((pair, i) => pairs.indexOf(pair) !== i), 'a roll-up drawn twice').toEqual([])
})

// The reported follow-up: offline, a target's DiagramDoc that never synced to
// this browser cannot be read, so the expansion is laid on a GRID. The load ran
// only when the expansions changed, so reconnecting never replaced that grid
// with the arrangement the user made; it stayed wrong until a reload.
//
// A SECOND, cold browser context is what makes the document unreadable: the
// first one opened every diagram to read the ground truth, so it holds them all.
//
// Two outages, because they reach the reconnect signal differently:
//  - 'browser-offline': `navigator.onLine` false, the badge says 'offline'
//    until the transport is back;
//  - 'backend-down': the browser stays online while the server is gone, and
//    an edit made meanwhile leaves durable heads pending. Their failed
//    acknowledgement sets the badge to 'saving' DURING the outage, and the
//    real reconnect is then 'saving' -> 'ready': a consumer keyed on the badge
//    reloads at the wrong moment and misses the reconnect (architect lens).
type Outage = 'browser-offline' | 'backend-down'

async function laidOutOfflineThenBack(page: Page, browser: Browser, outage: Outage): Promise<void> {
  const { email, context, containers, systemId, pulledContainers } = await importFixture(page)
  await waitForWorkspaceProjected(page)
  const workspace = new URL(page.url()).pathname.match(/\/app\/landscape\/[^/]+\/version\/[^/]+/)![0]
  expect(apiOrigin, 'the API origin is learnt from the first page\'s requests').not.toBeNull()

  const cold = await browser.newContext()
  try {
    const other = await cold.newPage()
    // `setOffline` alone does not end an OPEN localhost WebSocket: sync
    // messages kept arriving on it and put the badge back to 'ready' within the
    // poll (2 runs in 3 measured). A real outage kills the socket, so this does:
    // the sync socket goes through a route that can close it and refuse
    // reconnections until the server is back. The API goes through one too,
    // for the outage where the browser itself stays online.
    let serverReachable = true
    /** Durable-heads acknowledgements refused while the rest still answers. */
    let acksRefused = false
    const sockets: WebSocketRoute[] = []
    await other.routeWebSocket(/\/automerge/, (ws) => {
      if (!serverReachable) {
        void ws.close({ code: 1006 }).catch(() => {})
        return
      }
      ws.connectToServer()
      sockets.push(ws)
    })
    const setServerReachable = async (reachable: boolean) => {
      serverReachable = reachable
      if (reachable) acksRefused = false
      if (outage === 'browser-offline') await cold.setOffline(!reachable)
      if (!reachable) for (const ws of sockets.splice(0)) await ws.close({ code: 1006 }).catch(() => {})
    }
    await signIn(other, email)
    // Installed after sign-in: only the outage needs it, and a route in front of
    // the login redirects aborted the navigation (ERR_ABORTED, measured).
    await other.route(`${apiOrigin}/**`, (route) => (
      serverReachable && !(acksRefused && route.request().url().includes('/durable-heads'))
        ? route.fallback()
        : route.abort('connectionrefused')))
    await openDiagram(other, workspace, context.id)
    await waitDrawn(other, [systemId], 'the system (cold context)')
    // Offline, the shapes come from the local index; wait for it so the test
    // is about the PLACEMENT, not about the objects being unreachable.
    await other.evaluate(() => (window as any).__indexReady?.whenReady?.())

    if (outage === 'browser-offline') {
      await setServerReachable(false)
      await expect.poll(() => other.locator('#sync-status').getAttribute('data-status'), { timeout: 30_000 }).toBe('offline')
    } else {
      // Durable heads left pending: an edit made while connected whose
      // acknowledgement is refused (an edit made DURING the outage is
      // journaled and produces none — measured, the badge stayed 'offline').
      acksRefused = true
      await renameShapeOfType(other, 'actor', `Customer renamed ${Date.now()}`)
      // Every badge transition from here on, so the precondition below can
      // ask for the ORDER, not for a value that was already showing.
      await other.evaluate(() => {
        const seen: string[] = []
        ;(window as any).__badgeTransitions = seen
        let last: string | null = null
        const look = () => {
          const value = document.querySelector('#sync-status')?.getAttribute('data-status') ?? null
          if (value && value !== last) { seen.push(value); last = value }
        }
        look()
        new MutationObserver(look).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-status'] })
      })
      await setServerReachable(false)
      // Precondition: after the transport dropped, the acknowledgement retry
      // fails with the browser online and puts the badge back to 'saving'
      // while the server is still gone — the edge that fooled a badge-keyed
      // consumer. Without it this variant would be the other one again.
      await expect
        .poll(async () => {
          const seen: string[] = await other.evaluate(() => (window as any).__badgeTransitions)
          const offlineAt = seen.indexOf('offline')
          return offlineAt >= 0 && seen.slice(offlineAt + 1).includes('saving')
        }, {
          timeout: 15_000,
          message: 'precondition: the badge must go offline, then back to saving, during the outage',
        })
        .toBe(true)
    }

    await clickExpandIndicator(other, systemId)
    await other.getByTestId(`expand-here-${containers.id}`).click()
    const offline = await waitDrawn(other, pulledContainers, 'the containers (offline)')
    // Precondition: the placement really was unreadable. If this cold context
    // could read the target's document offline, there is nothing to upgrade.
    expect(
      isArrangement(offline, containers.layouts!, pulledContainers),
      'precondition: the offline expansion must be the grid fallback, not the real arrangement',
    ).toBe(false)
    const keys = pulledContainers.map((id) => `${offline[id].x},${offline[id].y}`)
    expect(new Set(keys).size, 'the grid fallback still places every shape apart').toBe(pulledContainers.length)

    await setServerReachable(true)
    await expect.poll(() => other.locator('#sync-status').getAttribute('data-status'), { timeout: 45_000 }).toBe('ready')
    // No click, no reload: reconnecting alone must bring the real arrangement.
    await expect
      .poll(async () => isArrangement(await enginePositions(other), containers.layouts!, pulledContainers), {
        timeout: 30_000,
        message: 'the expansion kept its offline grid after reconnecting',
      })
      .toBe(true)
  } finally {
    await cold.close()
  }
}

test('an expansion laid out offline takes its real arrangement once back online', async ({ page, browser }) => {
  test.setTimeout(300_000)
  await laidOutOfflineThenBack(page, browser, 'browser-offline')
})

test('...and after a backend outage with the browser online and an edit pending', async ({ page, browser }) => {
  test.setTimeout(300_000)
  await laidOutOfflineThenBack(page, browser, 'backend-down')
})

// The first version followed the target's PLACEMENT only: a rename over there
// lives in the model, not in the target's DiagramDoc, so the expansion kept
// the old name until a reload. Another client renames; this one must follow.
test('a rename in the expanded diagram, made by another client, reaches the expansion', async ({ page, browser }) => {
  test.setTimeout(300_000)
  const { email, context, containers, systemId, pulledContainers } = await importFixture(page)
  await waitForWorkspaceProjected(page)
  const workspace = new URL(page.url()).pathname.match(/\/app\/landscape\/[^/]+\/version\/[^/]+/)![0]

  await openDiagram(page, workspace, context.id)
  await waitDrawn(page, [systemId], 'the system')
  // The expansion's connections used to be fetched one request each.
  const connectionRequests = { single: 0, batch: 0 }
  page.on('request', (request) => {
    const url = request.url()
    if (/\/api\/model\/connection\/[^/?]+/.test(url)) connectionRequests.single += 1
    if (url.includes('/api/model/cache/connections/by-ids')) connectionRequests.batch += 1
  })
  await clickExpandIndicator(page, systemId)
  await page.getByTestId(`expand-here-${containers.id}`).click()
  await waitDrawn(page, pulledContainers, 'the containers')
  expect(connectionRequests.single, 'an expansion fetched its connections one request each').toBe(0)
  expect(connectionRequests.batch, 'the expansion\'s connections were not fetched in a batch').toBeGreaterThan(0)

  const other = await browser.newContext()
  try {
    const editor = await other.newPage()
    await signIn(editor, email)
    await openDiagram(editor, workspace, containers.id)
    const name = `Renamed elsewhere ${Date.now()}`
    const renamedId = await renameShapeOfType(editor, 'app', name)
    expect(pulledContainers, 'the renamed shape must be one the expansion shows').toContain(renamedId)

    // No click, no reload here.
    await expect
      .poll(() => page.evaluate((id) => (window as any).__canvasEngine.objectMap.get(id)?.name, renamedId), {
        timeout: 30_000,
        message: 'the expansion kept the old name',
      })
      .toBe(name)
  } finally {
    await other.close()
  }
})

// A relationship added between a COMPONENT and a container is drawn on the
// containers view as a roll-up — an edge no change names, since roll-ups are
// computed, not stored. The expansion of the containers must still follow it.
//
// Measured 2026-10-16 with the hook's edge-ends path disabled: RED 2 of 2 on
// a tree with 0dc4dbb, whose change feed names only the rows that changed. On
// the feed before it (every object of the touched shard), the target was
// re-read through its objects anyway and this stayed green.
test('a relationship added elsewhere reaches the expansion as a roll-up', async ({ page, browser }) => {
  test.setTimeout(300_000)
  const { email, context, containers, components, systemId, serviceId, pulledContainers } = await importFixture(page)
  await waitForWorkspaceProjected(page)
  const workspace = new URL(page.url()).pathname.match(/\/app\/landscape\/[^/]+\/version\/[^/]+/)![0]
  await openDiagram(page, workspace, context.id)
  await waitDrawn(page, [systemId], 'the system')
  await clickExpandIndicator(page, systemId)
  await page.getByTestId(`expand-here-${containers.id}`).click()
  await waitDrawn(page, pulledContainers, 'the containers')

  const other = await browser.newContext()
  try {
    const editor = await other.newPage()
    await signIn(editor, email)
    await openDiagram(editor, workspace, components.id)
    const ends = await editor.evaluate((service) => {
      const objects = [...(window as any).__canvasEngine.objectMap.values()] as any[]
      return {
        machine: objects.find((o) => o.name === 'Order State Machine' && o.parentId === service)?.id as string | undefined,
        web: objects.find((o) => o.name === 'Web App')?.id as string | undefined,
      }
    }, serviceId)
    expect(ends.machine && ends.web, 'fixture: the components view shows the state machine and the web app').toBeTruthy()
    const pair = `${serviceId}→${ends.web}`
    expect((await drawnEdges(page)).map((e) => e.pair), 'precondition: nothing yet from the service to the web app').not.toContain(pair)

    // The same store action the connect tool ends in (see createConnectionOnCanvas).
    await editor.evaluate(([from, to]) =>
      (window as any).__modelStore.getState().addConnection({ fromId: from, toId: to, type: 'solid', label: 'Pushes status' }),
    [ends.machine!, ends.web!] as const)

    // No click, no reload here.
    await expect
      .poll(async () => (await drawnEdges(page)).map((e) => e.pair), {
        timeout: 30_000,
        message: 'the expansion never drew the roll-up of a relationship added elsewhere',
      })
      .toContain(pair)
  } finally {
    await other.close()
  }
})

// `goOffline()` installed routes that only catch sockets opened LATER: a live
// page kept its open sync socket and stayed connected, so an "offline" test
// that did not reload was not offline at all.
test('goOffline() takes a LIVE page offline, and goOnline() brings it back', async ({ page }) => {
  test.setTimeout(180_000)
  // Before the first navigation: a socket route added to a loaded page never
  // sees that page's later sockets (see installServerRouting).
  await installServerRouting(page)
  await signIn(page, `e2e-expand-inline-${Date.now()}@example.com`)
  await waitForWorkspaceProjected(page)
  const badge = () => page.locator('[data-testid="ws-sync-status"], #sync-status').first().getAttribute('data-status')
  await expect.poll(badge, { timeout: 30_000 }).not.toBe('offline')

  await goOffline(page, { live: true })
  await expect.poll(badge, { timeout: 20_000, message: 'still connected after goOffline()' }).toBe('offline')
  // ...and it STAYS offline: the adapter retries after ~0.5, 1, 2, 4 s, and each
  // retry must meet the route. (A route on the wrong host — it was hard-coded
  // to :3002 — let the first retry reconnect; measured, this caught it.)
  await page.waitForTimeout(6_000)
  expect(await badge(), 'a reconnection got through while offline').toBe('offline')

  await goOnline(page)
  await expect.poll(badge, { timeout: 45_000, message: 'not back after goOnline()' }).not.toBe('offline')
})
