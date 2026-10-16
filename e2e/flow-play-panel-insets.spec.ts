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
import { waitForWorkspaceProjected } from './support/workspaceReady'

/**
 * Regression, 2026-10-16: with the left sidebar open on its Flows tab, "Play
 * flow" framed the introduction step — and later the conclusion — as if no
 * panel were open, so the left part of the diagram (the actors) sat under the
 * 312 px sidebar. The canvas Fit button, with the same panels open, framed
 * correctly; it is the reference here.
 *
 * Driven through the real UI against the demo seed (`npm run dev:local`,
 * AUTH off): `diagram-1` carries the "Authentication" flow, introduction first
 * and conclusion last. The engine probe is only READ, to measure where the
 * content landed.
 */

test.use({ channel: process.env.PW_BROWSER_CHANNEL || undefined, viewport: { width: 1600, height: 900 } })

interface Framing {
  viewport: { x: number; y: number; scale: number }
  contentLeft: number
  contentRight: number
}

async function framing(page: Page): Promise<Framing> {
  return page.evaluate(() => {
    const engine = window.__canvasEngine as unknown as {
      getViewport(): { x: number; y: number; scale: number }
      getBounds(): { x: number; y: number; width: number; height: number }
      canvas: HTMLCanvasElement
    }
    const left = engine.canvas.getBoundingClientRect().left
    const v = engine.getViewport()
    const b = engine.getBounds()
    return {
      viewport: v,
      contentLeft: left + b.x * v.scale + v.x,
      contentRight: left + (b.x + b.width) * v.scale + v.x,
    }
  })
}

async function expectSameFraming(page: Page, reference: Framing, label: string) {
  await expect
    .poll(async () => {
      const now = (await framing(page)).viewport
      return Math.abs(now.x - reference.viewport.x) < 1
        && Math.abs(now.y - reference.viewport.y) < 1
        && Math.abs(now.scale - reference.viewport.scale) < 1e-3
    }, { message: `${label} is not framed like the Fit button` })
    .toBe(true)
}

test('playing a flow frames its introduction and conclusion between the open side panels', async ({ page }) => {
  await page.goto('/app/landscape/default/version/current/diagram/diagram-1')
  await page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+\/diagram\/diagram-1/, { timeout: 90_000 })
  await waitForWorkspaceProjected(page)
  await page.waitForFunction(() => Boolean(window.__canvasEngine))

  const showShapes = page.getByTestId('show-shapes-panel')
  if (await showShapes.isVisible().catch(() => false)) await showShapes.click()
  const leftSidebar = page.getByTestId('diagram-left-sidebar')
  await expect(leftSidebar).toBeVisible()
  const leftBox = (await leftSidebar.boundingBox())!
  const sidebarRight = leftBox.x + leftBox.width
  const rightShell = page.getByTestId('right-sidebar-shell')
  const rightBox = (await rightShell.isVisible().catch(() => false)) ? await rightShell.boundingBox() : null
  const rightPanelLeft = rightBox ? rightBox.x : 1600

  await page.getByTestId('left-tab-flows').click()
  await expect(page.getByTestId('flow-dropdown-trigger')).toContainText('Authentication')

  // The known-good reference: Fit with the same panels open.
  await page.getByTestId('canvas-fit-screen').click()
  const reference = await framing(page)
  const expectBetweenPanels = (f: Framing, label: string) => {
    expect(f.contentLeft, `${label}: content under the left sidebar`).toBeGreaterThanOrEqual(sidebarRight)
    expect(f.contentRight, `${label}: content under the right sidebar`).toBeLessThanOrEqual(rightPanelLeft)
  }
  expectBetweenPanels(reference, 'Fit')

  // Move away first, so a Play that frames nothing cannot pass.
  await page.getByTestId('canvas-zoom-in').click()
  await page.getByTestId('canvas-zoom-in').click()
  expect((await framing(page)).viewport.scale, 'zoom-in did not move the view off the Fit framing')
    .not.toBeCloseTo(reference.viewport.scale, 3)

  await page.getByRole('button', { name: /^(Play flow|Lancer le flux)$/ }).click()
  await expectSameFraming(page, reference, 'the introduction step')
  const intro = await framing(page)
  expectBetweenPanels(intro, 'the introduction step')

  // Walk to the conclusion (the last of six steps) through the real Next button.
  const next = page.getByRole('button', { name: /^(Next|Suivant)$/ })
  for (let i = 0; i < 4; i += 1) await next.click()
  await page.getByTestId('canvas-zoom-in').click()
  expect((await framing(page)).viewport.scale, 'zoom-in did not move the view off the Fit framing')
    .not.toBeCloseTo(reference.viewport.scale, 3)
  await next.click()
  await expect(page.getByText(/^6 \/ 6$/)).toBeVisible()
  await expectSameFraming(page, reference, 'the conclusion step')
  const conclusion = await framing(page)
  expectBetweenPanels(conclusion, 'the conclusion step')
})
