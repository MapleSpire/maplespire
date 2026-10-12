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

import { test, expect, type Page, type Browser } from '@playwright/test'

// End-to-end coverage of the Automerge sync layer through the REAL app, using two
// ISOLATED browser contexts (separate IndexedDB) — a true two-browser test that
// the single-context MCP driver can't do. Requires the dev stack running.

async function enterApp(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: /Start designing free/ }).first().click()
  // Bridge connected + model projected (left sidebar shows real model objects).
  await expect(page.getByText(/Firebase|Claude|Asset bucket|Icon bucket/).first()).toBeVisible()
  await expect(page.getByTestId('diagram-name')).toBeVisible()
}

async function twoBrowsers(browser: Browser) {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  await enterApp(a)
  await enterApp(b)
  return { ctxA, ctxB, a, b, close: async () => { await ctxA.close(); await ctxB.close() } }
}

test.describe('Automerge real-time sync — two isolated browsers', () => {
  test('real-time: a rename in browser A appears in B without reload', async ({ browser }) => {
    const { a, b, close } = await twoBrowsers(browser)
    try {
      const name = 'E2E-RT-' + Date.now()
      await a.getByTestId('diagram-name').fill(name)
      await a.getByTestId('diagram-name').blur()
      // B reflects A's edit live (through the server), no reload.
      await expect(b.getByTestId('diagram-name')).toHaveValue(name)
    } finally {
      await close()
    }
  })

  test('field-level merge: A renames while B adds a checkpoint — both survive', async ({ browser }) => {
    const { a, b, close } = await twoBrowsers(browser)
    try {
      const name = 'E2E-MERGE-' + Date.now()
      const cp = 'CP-FROM-B-' + Date.now()

      // Concurrent edits to DIFFERENT parts of the same diagram doc:
      // A edits diagram.name, B appends to diagram.checkpoints.
      await a.getByTestId('diagram-name').fill(name)
      await b.getByTestId('open-history').click()
      await b.getByTestId('checkpoint-label').fill(cp)
      await b.getByTestId('checkpoint-add').click()
      await expect(b.getByTestId('checkpoint-list')).toContainText(cp)

      // Both edits must survive on BOTH browsers (field-level merge):
      // - A's name reaches B
      await expect(b.getByTestId('diagram-name')).toHaveValue(name)
      // - B's checkpoint reaches A
      await a.getByTestId('open-history').click()
      await expect(a.getByTestId('checkpoint-list')).toContainText(cp)
      // - and A still shows its own name (not clobbered by B's edit)
      await expect(a.getByTestId('diagram-name')).toHaveValue(name)
    } finally {
      await close()
    }
  })

  test('deletion + re-projection survives reload (durable)', async ({ browser }) => {
    const { a, b, close } = await twoBrowsers(browser)
    try {
      const name = 'E2E-DURABLE-' + Date.now()
      await a.getByTestId('diagram-name').fill(name)
      await expect(b.getByTestId('diagram-name')).toHaveValue(name)
      // B reloads (cold) and still sees A's edit — proves server-side durability.
      // With URL routing the diagram link persists, so a reload returns straight
      // to the app (no landing page to click through).
      await b.reload()
      await expect(b.getByTestId('diagram-name')).toHaveValue(name)
    } finally {
      await close()
    }
  })
})

test.describe('History & revert — single browser', () => {
  test('checkpoint then restore reverts the diagram name (undoable)', async ({ browser }) => {
    // Fresh isolated context. Establish a KNOWN base name and let the bridge
    // write it into the Automerge doc BEFORE checkpointing, so the checkpoint
    // captures heads at the base state (not a stale or future one).
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    try {
      await enterApp(page)
      const base = 'BASE-' + Date.now()
      await page.getByTestId('diagram-name').fill(base)
      await expect(page.getByTestId('diagram-name')).toHaveValue(base)
      await page.waitForTimeout(1000) // bridge debounce → `base` lands in the doc

      // Checkpoint the base state.
      await page.getByTestId('open-history').click()
      const cp = 'CP-' + Date.now()
      await page.getByTestId('checkpoint-label').fill(cp)
      await page.getByTestId('checkpoint-add').click()
      await expect(page.getByTestId('checkpoint-list')).toContainText(cp)
      await page.getByTestId('history-close').click()

      // Change the name, let it persist, then restore the checkpoint.
      const changed = 'CHANGED-' + Date.now()
      await page.getByTestId('diagram-name').fill(changed)
      await expect(page.getByTestId('diagram-name')).toHaveValue(changed)
      await page.waitForTimeout(800)

      await page.getByTestId('open-history').click()
      await page
        .getByTestId('checkpoint-list')
        .locator('li', { hasText: cp })
        .getByRole('button', { name: /Restore/ })
        .click()

      // Name reverts to the checkpoint-time value (restore is itself a new change).
      await expect(page.getByTestId('diagram-name')).toHaveValue(base)
    } finally {
      await ctx.close()
    }
  })
})
