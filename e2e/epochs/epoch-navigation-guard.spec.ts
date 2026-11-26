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

import { expect, test } from '@playwright/test'
import { __guardNavigationsForTest, takeUnexpectedNavigations } from '../support/epochStack'

/**
 * The harness's guard against document loads a spec did not ask for. A
 * `goto` that FAILS before its `domcontentloaded` used to leave its allowance
 * open, and that leftover absorbed the next load nobody asked for: the guard
 * went blind exactly once.
 */
test('a failed goto does not absorb a later unrequested page load', async ({ page }) => {
  await page.goto('/icons/icon-192.png')
  __guardNavigationsForTest(page)
  // Requested: allowed.
  await page.goto('/icons/icon-192.png')
  expect(takeUnexpectedNavigations()).toEqual([])
  // Requested but failing before any document: nothing loads.
  await page.route('**/never-answered', () => { /* never fulfilled */ })
  await expect(page.goto('/never-answered', { timeout: 500 })).rejects.toThrow()
  await page.goto('/icons/icon-192.png')
  expect(takeUnexpectedNavigations()).toEqual([])
  // NOT requested: a reload from inside the page must be reported.
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.evaluate(() => { setTimeout(() => location.reload(), 0) }),
  ])
  expect(takeUnexpectedNavigations()).toHaveLength(1)
})
