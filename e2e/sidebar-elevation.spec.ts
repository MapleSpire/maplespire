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
import { enterAppWorkspace } from './support/devLogin'

// Lets local validation reuse an installed Chrome when Playwright's bundled
// browser cache is intentionally absent from an isolated worktree/container.
test.use({ channel: process.env.PW_BROWSER_CHANNEL || undefined })

/**
 * Visual regression guard for the workspace chrome. The handoff's dark-mode
 * `--shadow-xl` is deliberately a two-layer elevation: a black drop shadow
 * plus a subtle inset top highlight. Checking computed styles in Chromium
 * proves the real Tailwind utility still resolves the runtime theme token.
 */
test('workspace sidebars use the design-system dark xl elevation', async ({ page }) => {
  await enterAppWorkspace(page, process.env.E2E_SIDEBAR_EMAIL ?? 'e2e-sidebar-elevation@example.com')

  // The diagram editor owns a distinct left panel from the workspace pages.
  // Check it explicitly so a workspace-only fix cannot mask a regression here.
  const diagramLeft = page.getByTestId('diagram-left-sidebar')
  const diagramRight = page.getByTestId('workspace-right-sidebar')
  await expect(diagramLeft).toBeVisible()
  await expect(diagramRight).toBeVisible()
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  const diagramElevations = await Promise.all(
    [diagramLeft, diagramRight].map((sidebar) =>
      sidebar.evaluate((element) => ({ shadow: getComputedStyle(element).boxShadow, radius: getComputedStyle(element).borderRadius }))
    )
  )
  for (const elevation of diagramElevations) {
    expect(elevation.radius).toBe('20px')
    expect(elevation.shadow).toContain('rgba(0, 0, 0, 0.55) 0px 10px 28px 0px')
    expect(elevation.shadow).toContain('rgba(255, 255, 255, 0.04) 0px 1px 0px 0px inset')
  }

  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-model-objects').click()

  const left = page.getByTestId('workspace-nav-sidebar')
  const right = page.getByTestId('workspace-right-sidebar')
  await expect(left).toBeVisible()
  // The navigation item is a button made of an icon and a text wrapper. Both
  // hit targets must expose the same cursor, otherwise it visibly alternates
  // while moving across a single menu entry.
  const objectsNavigation = page.getByTestId('ws-nav-model-objects')
  await expect(objectsNavigation).toBeVisible()
  const navigationCursors = await Promise.all([
    objectsNavigation.evaluate((element) => getComputedStyle(element).cursor),
    objectsNavigation.locator('svg').evaluate((element) => getComputedStyle(element).cursor),
  ])
  expect(navigationCursors).toEqual(['pointer', 'pointer'])

  // The properties sidebar is intentionally conditional: select a real model
  // object through the page UI so we validate the same state as the report.
  const systems = page.getByRole('row', { name: /New system/ })
  if ((await systems.count()) === 0) {
    await page.getByTestId('mo-add-object').click()
    await page.getByTestId('mo-add-system').click()
  }
  const draggableRow = systems.last()
  const rowCursors = await draggableRow.evaluate((row) => {
    const cell = row.querySelector('td')
    const name = Array.from(row.querySelectorAll('span')).find((span) => span.textContent?.trim())
    const icon = row.querySelector('svg, img')
    const action = row.querySelector('button')
    return {
      row: getComputedStyle(row).cursor,
      cell: cell ? getComputedStyle(cell).cursor : null,
      name: name ? getComputedStyle(name).cursor : null,
      icon: icon ? getComputedStyle(icon).cursor : null,
      action: action ? getComputedStyle(action).cursor : null,
    }
  })
  expect(rowCursors).toEqual({
    row: 'grab',
    cell: 'grab',
    name: 'grab',
    icon: 'grab',
    action: 'pointer',
  })
  await draggableRow.click()
  await expect(right).toBeVisible()

  // This is the design-system dark theme; set it directly so the assertion is
  // independent of the browser's saved appearance preference.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

  const elevations = await Promise.all(
    [left, right].map((sidebar) =>
      sidebar.evaluate((element) => {
        const style = getComputedStyle(element)
        return { shadow: style.boxShadow, radius: style.borderRadius }
      })
    )
  )

  for (const elevation of elevations) {
    expect(elevation.radius).toBe('20px')
    expect(elevation.shadow).toContain('rgba(0, 0, 0, 0.55) 0px 10px 28px 0px')
    expect(elevation.shadow).toContain('rgba(255, 255, 255, 0.04) 0px 1px 0px 0px inset')
  }
})

test('workspace tables keep 24px of breathing room beside the left sidebar', async ({ page }) => {
  await enterAppWorkspace(page, process.env.E2E_SIDEBAR_GAP_EMAIL ?? 'e2e-sidebar-gap@example.com')

  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-connections').click()

  const sidebar = page.getByTestId('workspace-nav-sidebar')
  const firstColumnLabel = page.locator('table thead th').first().locator('button')
  await expect(sidebar).toBeVisible()
  await expect(firstColumnLabel).toBeVisible()

  const sidebarBox = await sidebar.boundingBox()
  const labelBox = await firstColumnLabel.boundingBox()
  expect(sidebarBox).not.toBeNull()
  expect(labelBox).not.toBeNull()

  const contentGap = labelBox!.x - (sidebarBox!.x + sidebarBox!.width)
  expect(contentGap).toBeGreaterThanOrEqual(23.5)
  expect(contentGap).toBeLessThanOrEqual(24.5)
})
