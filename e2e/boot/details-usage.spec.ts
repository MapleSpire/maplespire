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

import { test, expect } from '@playwright/test'
import { enterBootApp, gotoModelObjects, moSelectRow, currentDiagramId } from './helpers'

// Regression (2026-10-15, found scripting the Product Hunt video): the object
// Details panel showed HARD-CODED "In 1 diagram" (a button with no onClick),
// "In 0 flows" and a "Contains" that reported the object's PARENT. On Model
// Objects, an object the table counts in 2 diagrams said "In 1 diagram".
//
// Real UI only: the table row, the panel, the button, the diagram link. The
// expected numbers come from the server read model, never from the client the
// test is checking.

const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3002'
// Seeded by `seed-workspace.ts real`: Netflix sits on the landscape diagram AND
// its own System Context diagram, and has the Netflix containers as children.
const NETFLIX = 're-netflix-sys'

// English copy + a viewport wide enough for the table's "In diagrams" column
// (hidden below 1360px).
test.use({ locale: 'en-US', viewport: { width: 1600, height: 950 } })

async function serverTruth(page: import('@playwright/test').Page, id: string) {
  return page.evaluate(async ([base, oid]) => {
    const related = await (await fetch(`${base}/api/model/related-diagrams?object=${encodeURIComponent(oid)}&limit=100`)).json()
    const tree = await (await fetch(`${base}/api/model/tree/children?parentId=${encodeURIComponent(oid)}&limit=100`)).json()
    return {
      diagramIds: (related.reference as Array<{ id: string }>).map((d) => d.id).sort(),
      diagramTotal: related.totals.reference as number,
      childCount: (tree.items as unknown[]).length,
      childPageComplete: !tree.nextCursor,
    }
  }, [API_BASE, id] as const)
}

// The seeded Netflix request flow lives on the Netflix CONTAINERS diagram and
// walks Zuul API Gateway; the app boots on the landscape diagram, so the flow is
// in a diagram whose DiagramDoc the client has not opened.
const ZUUL = 're-netflix-cnt0'
const NETFLIX_FLOW = 're-netflix-fl0'

test('Flows row counts flows of diagrams that are not open, and opens them', async ({ page }) => {
  await enterBootApp(page)
  const open = await currentDiagramId(page)
  // Server truth, once the projector has indexed the holding diagram(s).
  await expect.poll(() => page.evaluate(async ([base, oid]) => {
    const r = await (await fetch(`${base}/api/model/entity-flows?kind=object&id=${encodeURIComponent(oid)}`)).json()
    return { total: r.total, complete: r.complete, ids: r.flows.map((f: { id: string }) => f.id) }
  }, [API_BASE, ZUUL] as const), { timeout: 60_000 }).toEqual({ total: 1, complete: true, ids: [NETFLIX_FLOW] })
  const flowDiagram = await page.evaluate(async ([base, oid]) => {
    const r = await (await fetch(`${base}/api/model/entity-flows?kind=object&id=${encodeURIComponent(oid)}`)).json()
    return r.flows[0].diagramId as string
  }, [API_BASE, ZUUL] as const)
  expect(flowDiagram, 'fixture: the flow must live in a diagram that is NOT the open one').not.toBe(open)

  await gotoModelObjects(page)
  await moSelectRow(page, ZUUL, 'Zuul')
  // Before the read-model flow index this said "0 in the open diagram".
  const flows = page.getByTestId('usage-flows-count')
  await expect(flows).toHaveText('In 1 flow')
  await expect(flows).toHaveAttribute('data-complete', 'true')

  await flows.click()
  await page.locator(`[data-testid="usage-flow-link"][data-flow-id="${NETFLIX_FLOW}"]`).click()
  await expect.poll(() => currentDiagramId(page)).toBe(flowDiagram)
  // The canvas is showing that flow (the engine receives the current flow).
  await expect
    .poll(() => page.evaluate(() => (window as any).__canvasEngine?.currentFlowId ?? null)) // eslint-disable-line @typescript-eslint/no-explicit-any
    .toBe(NETFLIX_FLOW)
})

test('Details panel counts the diagrams an object is in, and the count opens them', async ({ page }) => {
  await enterBootApp(page)
  const truth = await serverTruth(page, NETFLIX)
  expect(truth.diagramTotal, 'fixture: the seeded object must sit in exactly two diagrams').toBe(2)
  expect(truth.childPageComplete).toBe(true)
  expect(truth.childCount).toBeGreaterThan(0)

  await gotoModelObjects(page)
  await moSelectRow(page, NETFLIX, 'Netflix')

  // The table's own "In diagrams" column says 2 …
  const headers = await page.locator('thead th').allInnerTexts()
  const column = headers.findIndex((h) => /in diagrams/i.test(h))
  expect(column, 'the In diagrams column is visible').toBeGreaterThan(0)
  await expect(page.getByTestId(`mo-row-${NETFLIX}`).locator('td').nth(column)).toHaveText('2')

  // … and so does the panel (it said "In 1 diagram" whatever the object).
  const count = page.getByTestId('usage-diagrams-count')
  await expect(count).toHaveText('In 2 diagrams')
  // Contains = the object's children (it said "1 object" whenever it HAD a parent).
  await expect(page.getByTestId('usage-contains-count')).toHaveText(`${truth.childCount} objects`)

  await count.click()
  const links = page.getByTestId('usage-diagram-link')
  await expect(links).toHaveCount(2)
  const listed = (await links.evaluateAll((els) => els.map((el) => el.getAttribute('data-diagram-id') ?? ''))).sort()
  expect(listed).toEqual(truth.diagramIds)

  // Open the diagram that is NOT the current one, through the link.
  const before = await currentDiagramId(page)
  const target = listed.find((id) => id !== before)!
  await page.locator(`[data-testid="usage-diagram-link"][data-diagram-id="${target}"]`).click()

  await expect.poll(() => currentDiagramId(page)).toBe(target)
  await expect(page).toHaveURL(new RegExp(`/diagram/${target}$`))
  await expect
    .poll(() => page.evaluate(() => (window as any).__modelStore.getState().selectedItems)) // eslint-disable-line @typescript-eslint/no-explicit-any
    .toEqual([{ id: NETFLIX, type: 'object' }])
  // … and the canvas DRAWS it selected (an engine created after the selection
  // was made used to start with none).
  await expect
    .poll(() => page.evaluate((oid) => !!(window as any).__canvasEngine?.selectedObjectIds?.has(oid), NETFLIX)) // eslint-disable-line @typescript-eslint/no-explicit-any
    .toBe(true)

  // Centred on the canvas: once the engine draws the shape, its centre sits in
  // the middle of the canvas, not wherever a zoom-to-fit would have put it.
  await expect
    .poll(() => page.evaluate((oid) => {
      const eng = (window as any).__canvasEngine // eslint-disable-line @typescript-eslint/no-explicit-any
      const o = eng?.objectMap?.get(oid)
      if (!o) return Number.POSITIVE_INFINITY
      const rect = eng.canvas.getBoundingClientRect()
      const vp = eng.viewport
      const cx = (o.position.x + o.size.width / 2) * vp.scale + vp.x
      const cy = (o.position.y + o.size.height / 2) * vp.scale + vp.y
      return Math.max(Math.abs(cx - rect.width / 2), Math.abs(cy - rect.height / 2))
    }, NETFLIX), { timeout: 20_000 })
    .toBeLessThan(4)
})
