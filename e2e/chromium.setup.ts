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

import { test as setup, expect, type Browser, type Page } from '@playwright/test'
import { syncBar } from './support/workspaceReady'

// The `chromium` project runs against `npm run dev:local` on a FRESH database.
// Until 2026-10-19 the first client to open the empty default root seeded the
// demo itself, as several documents that reached the server independently;
// measured 2026-10-18, a client closed 1.4 s after load left a partial demo
// (the model without its registry entries, or entries without their
// DiagramDocs), and every later fresh context failed. The suite's first test
// closes that fast, so it poisoned every test after it.
//
// The server now writes the demo before it publishes the root
// (server/src/demoSeed.ts), so that race is gone. This setup stays as the
// suite's precondition, checked once, before any test:
//   1. one context boots the demo and waits until the badge reports DURABLE
//      (`ready`) on the projected workspace, not merely loaded;
//   2. a SECOND fresh context — no IndexedDB, nothing but the server — boots
//      it too. That is the property every test assumes; the badge is only the
//      signal for when to look. A database left partial by an older build, or
//      a regression of the server seed, fails here with a message, instead of
//      as N unrelated two-minute timeouts.

async function enterDemo(page: Page): Promise<void> {
  // This build has no landing page (`/` only redirects to `/app`), so open the
  // app directly.
  await page.goto('/app')
  await expect(page.getByText(/Firebase|Claude|Asset bucket|Icon bucket/).first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('diagram-name')).toBeVisible({ timeout: 60_000 })
}

async function inFreshContext(browser: Browser, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext()
  try {
    await run(await context.newPage())
  } finally {
    await context.close()
  }
}

setup('the demo seed is durable on the server before any test runs', async ({ browser }) => {
  setup.setTimeout(180_000)

  await inFreshContext(browser, async (page) => {
    await enterDemo(page)
    // `ready` is a process-wide latch, so read it only from the bar that
    // names the workspace it projected (an empty attribute means "none yet").
    const bar = syncBar(page)
    // Measured on a database a fast-closing client had already poisoned: the
    // canvas renders, the badge goes to `error` ("Document … is unavailable"),
    // and the workspace never reports projected.
    await expect(
      bar,
      `the default workspace never finished booting. On a database that is not fresh this is a partial demo `
      + `seed left by an earlier run (the badge's title names the unavailable document): restart \`npm run dev:local\` `
      + `on an empty database.`,
    ).toHaveAttribute('data-projected-workspace', /.+\/.+/, { timeout: 60_000 })
    await expect(
      bar,
      'the first client never reported the workspace durable (badge never `ready`)',
    ).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
  })

  await inFreshContext(browser, async (page) => {
    await enterDemo(page).catch((error: unknown) => {
      throw new Error(
        'the first client reported durable, yet a fresh browser context cannot boot the demo from the server.\n'
        + String(error),
      )
    })
    await expect(
      syncBar(page),
      'a fresh browser context booted the canvas but not the workspace: the server does not hold the whole demo',
    ).toHaveAttribute('data-projected-workspace', /.+\/.+/, { timeout: 60_000 })
  })
})
