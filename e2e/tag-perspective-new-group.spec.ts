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
import { waitForWorkspaceProjected } from './support/workspaceReady'

/**
 * Regression, 2026-10-15: in the canvas bottom bar, Tags → "New group" → Save
 * created the group on the server, closed the dialog — and nothing visible
 * changed. The strip lists only the Tag groups the current diagram uses, so the
 * fresh (necessarily empty) group was filtered out, and the active-group reset
 * then cleared the selection the Save had just made.
 *
 * Driven entirely through the real UI. Needs an AUTH=on + AUTH_DEV_LOGIN=on
 * stack (the Tag catalog is org-scoped): a fresh dev-login user gets a personal
 * org it administers, so "New group" is offered. On a stack without an org the
 * spec FAILS on the missing button rather than skipping.
 */

test.use({ channel: process.env.PW_BROWSER_CHANNEL || undefined })

test('a Tag group created from the bottom bar is shown, active, and can take a value', async ({ page }) => {
  await enterAppWorkspace(page, `e2e-tag-group-${Date.now()}@example.com`)
  await page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+\/diagram\//, { timeout: 90_000 })
  await waitForWorkspaceProjected(page)

  await page.getByTestId('bottom-tab-tags').click()
  const newGroup = page.getByTestId('tag-new-group')
  await expect(newGroup, 'this stack offers no "New group" — it needs AUTH=on with an org the user administers').toBeVisible()
  await newGroup.click()

  const groupName = `E2E group ${Date.now().toString(36)}`
  const dialog = page.getByTestId('perspective-new-group')
  await dialog.getByTestId('perspective-new-group-name').fill(groupName)
  await dialog.locator('button[type="submit"]').click()
  await expect(dialog).toBeHidden()

  // The symptom: this chip never appeared.
  const chip = page.locator('[data-testid^="tag-group-"]:not([data-testid^="tag-group-strip"])').filter({ hasText: groupName })
  await expect(chip).toBeVisible()
  await expect(chip.getByRole('button', { name: groupName, exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(/^(No values in this diagram|Aucune valeur dans ce diagramme)$/)).toBeVisible()

  // ...and the user can continue from the bar: New tag → Save shows the value.
  await page.getByTestId('tag-new-tag').click()
  const tagDialog = page.getByTestId('perspective-new-tag')
  await tagDialog.getByTestId('perspective-new-tag-name').fill('GA')
  await tagDialog.locator('button[type="submit"]').click()
  await expect(tagDialog).toBeHidden()
  await expect(page.locator('[data-testid^="tag-value-"]:not([data-testid^="tag-value-strip"])').filter({ hasText: 'GA' })).toBeVisible()
  await expect(chip).toBeVisible()
})
