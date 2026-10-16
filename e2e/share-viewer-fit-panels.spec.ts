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
 * Regression, 2026-10-16: the share viewer's first fit and its Fit button
 * framed the diagram on the whole canvas, so its left part sat under the
 * 312 px flow panel (content edge measured at x 221, panel edge at 326).
 *
 * Driven through the real UI against the demo seed (`npm run dev:local`,
 * AUTH off): the link is published from the editor's Share dialog, then opened
 * like a reader would. The engine probe is only READ, to measure where the
 * content landed.
 */

test.use({ channel: process.env.PW_BROWSER_CHANNEL || undefined, viewport: { width: 1600, height: 900 } })

async function contentSpan(page: Page) {
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
      left: left + b.x * v.scale + v.x,
      right: left + (b.x + b.width) * v.scale + v.x,
      width: b.width * v.scale,
    }
  })
}

async function panelEdges(page: Page) {
  const flow = await page.getByTestId('viewer-flow-sidebar-shell').boundingBox()
  const details = await page.getByTestId('viewer-details-sidebar-shell').boundingBox()
  return { flowRight: flow ? flow.x + flow.width : 0, detailsLeft: details ? details.x : page.viewportSize()!.width }
}

async function publishShareLink(page: Page): Promise<string> {
  await page.goto('/app/landscape/default/version/current/diagram/diagram-1')
  await waitForWorkspaceProjected(page)
  const showProperties = page.getByTestId('show-properties-panel')
  if (await showProperties.isVisible().catch(() => false)) await showProperties.click()
  await page.getByTestId('open-share').click()
  await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 })
  const enable = page.getByTestId('share-enable-toggle')
  await expect(enable).toBeEnabled({ timeout: 30_000 })
  // Clicking an already-enabled switch would REVOKE the link.
  if ((await enable.getAttribute('aria-checked')) !== 'true') await enable.click()
  await expect(enable).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 })
  const url = ((await page.getByTestId('share-link-url').textContent()) ?? '').trim()
  expect(url, 'the Share dialog must surface a link url').toMatch(/^https?:\/\/.+\/share\/.+$/)
  return url
}

async function openViewer(page: Page, url: string) {
  await page.goto(url)
  await page.waitForFunction(() => Boolean(window.__canvasEngine))
  await expect(page.getByTestId('viewer-flow-sidebar-shell')).toBeVisible()
}

test('the share viewer fits its diagram between the panels that are open', async ({ page }) => {
  const url = await publishShareLink(page)
  await openViewer(page, url)
  const edges = await panelEdges(page)

  // The first fit runs in a frame after the snapshot lands.
  await expect
    .poll(async () => (await contentSpan(page)).left, { message: 'the first fit leaves content under the flow panel' })
    .toBeGreaterThanOrEqual(edges.flowRight)
  expect((await contentSpan(page)).right, 'the first fit leaves content under the details panel').toBeLessThanOrEqual(edges.detailsLeft)

  // Move away, then Fit.
  await page.getByTestId('viewer-zoom-in').click()
  await page.getByTestId('viewer-zoom-in').click()
  expect((await contentSpan(page)).left, 'zoom-in did not push content under the panel').toBeLessThan(edges.flowRight)
  await page.getByTestId('viewer-center-diagram').click()
  const fitted = await contentSpan(page)
  expect(fitted.left, 'Fit leaves content under the flow panel').toBeGreaterThanOrEqual(edges.flowRight)
  expect(fitted.right, 'Fit leaves content under the details panel').toBeLessThanOrEqual(edges.detailsLeft)

  // Closing the flow panel gives its room back to the next Fit.
  await page.getByTestId('viewer-flow-sidebar-shell').getByRole('button').first().click()
  await expect(page.getByTestId('viewer-flow-sidebar-shell')).toBeHidden()
  await page.getByTestId('viewer-center-diagram').click()
  const wider = await contentSpan(page)
  expect(wider.width, 'Fit did not use the room the closed panel left').toBeGreaterThan(fitted.width)
  expect(wider.right).toBeLessThanOrEqual(edges.detailsLeft)
})

test('on a phone, where the panels cover the canvas, the first fit still frames the whole canvas', async ({ page }) => {
  const url = await publishShareLink(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await openViewer(page, url)

  // Fitting into the (negative) span the two panels leave would shrink the
  // diagram to a dot; it must span most of the 375 px canvas instead.
  await expect
    .poll(async () => (await contentSpan(page)).width, { message: 'the phone fit shrank the diagram to a dot' })
    .toBeGreaterThan(200)
})
