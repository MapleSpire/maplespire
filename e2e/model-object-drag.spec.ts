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

type ModelStoreDebugWindow = Window & {
  __modelStore: {
    getState(): { objects: Array<{ id: string; parentId?: string }> }
  }
}

test.use({ channel: process.env.PW_BROWSER_CHANNEL || undefined })

test('dragging a store onto a system previews the target and reparents it', async ({ page }) => {
  await enterAppWorkspace(page, `e2e-model-drag-${Date.now()}@example.com`)

  await expect(page.getByTestId('nav-menu')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-model-objects').click()

  await page.getByTestId('mo-add-object').click()
  await page.getByTestId('mo-add-system').click()
  const system = page.getByRole('row', { name: /New system/ }).last()
  await expect(system).toBeVisible()
  const systemId = (await system.getAttribute('data-testid'))!.replace('mo-row-', '')

  await page.getByTestId('mo-add-object').click()
  await page.getByTestId('mo-add-store').click()
  const store = page.getByRole('row', { name: /New store/ }).last()
  await expect(store).toBeVisible()
  const storeId = (await store.getAttribute('data-testid'))!.replace('mo-row-', '')
  await expect.poll(() => store.evaluate((element) => getComputedStyle(element).cursor)).toBe('grab')
  await expect
    .poll(() => store.locator('td').first().evaluate((element) => getComputedStyle(element).cursor))
    .toBe('grab')
  // Every icon in the cell keeps the grab cursor (`.mo-object-row--draggable > td *`).
  // A non-expandable row has exactly one: its type icon (the disclosure slot is
  // an empty span); measured 2026-10-18, one `lucide-database` svg. The old
  // expectation of two failed on that row.
  await expect
    .poll(() => store.locator('td').first().locator('svg').evaluateAll((elements) => elements.map((element) => getComputedStyle(element).cursor)))
    .toEqual(['grab'])

  // Exercise the browser's native drag data path so both the moving-object
  // preview and the compatible-target treatment are observable before drop.
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await store.dispatchEvent('dragstart', { dataTransfer: transfer })
  await system.dispatchEvent('dragover', { dataTransfer: transfer })
  await expect(page.getByTestId('mo-drag-preview')).toContainText('New store')
  await expect(system).toHaveClass(/outline-accent/)
  await system.dispatchEvent('drop', { dataTransfer: transfer })

  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as unknown as ModelStoreDebugWindow).__modelStore
            .getState()
            .objects.find((object) => object.id === id)?.parentId,
        storeId
      )
    )
    .toBe(systemId)
  await expect(page.getByTestId(`mo-row-${storeId}`)).toBeVisible()

  // The blank table plane is a deliberate root drop zone: it gives an object
  // already nested under a system a direct, discoverable way back out.
  const rootTransfer = await page.evaluateHandle(() => new DataTransfer())
  await page.getByTestId(`mo-row-${storeId}`).dispatchEvent('dragstart', { dataTransfer: rootTransfer })
  const tableScroll = page.getByTestId('mo-table-scroll')
  await tableScroll.dispatchEvent('dragover', { dataTransfer: rootTransfer })
  await expect(page.getByTestId('mo-root-drop-target')).toBeVisible()
  await tableScroll.dispatchEvent('drop', { dataTransfer: rootTransfer })
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as unknown as ModelStoreDebugWindow).__modelStore
            .getState()
            .objects.find((object) => object.id === id)?.parentId,
        storeId
      )
    )
    .toBeUndefined()
})
