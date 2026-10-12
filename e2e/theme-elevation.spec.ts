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

test.use({ channel: process.env.PW_BROWSER_CHANNEL || undefined })

test('the dark login card keeps a compact true-black elevation without a warm halo', async ({ page }) => {
  await page.goto('/login')
  const card = page.getByTestId('login-card')
  await expect(card).toBeVisible()

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  const shadow = await card.evaluate((element) => getComputedStyle(element).boxShadow)

  expect(shadow).toContain('rgba(0, 0, 0, 0.55) 0px 10px 28px 0px')
  expect(shadow).toContain('rgba(255, 255, 255, 0.04) 0px 1px 0px 0px inset')
  expect(shadow).not.toContain('rgba(38, 34, 28')
})
