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

/**
 * The docScope reference walk is triggered by a finding, never by an attach:
 * a boot + create-diagram + edit session on a COVERED workspace must move
 * `maplespire_docscope_walks_total` by exactly ZERO — the reference walk is a
 * repair path now, not an attach cost, and claim-at-write means creation
 * publishes no link the route gate would have to detect.
 *
 * Honest by construction (E2E honesty rule): every action drives the REAL UI
 * — the landscape is created through the mega menu, the app boots through its
 * own entry, the diagram is created with the diagrams view's own button, the
 * edit is a real palette drag onto the canvas — and the instrument is the
 * production /metrics endpoint, not a store shortcut. `rate()` over this
 * counter is exactly what the dashboard derives, so no new gauge is needed
 * (index.ts's walk metrics block).
 *
 * WHY the measured workspace is a BRAND-NEW landscape: a
 * warm-up boot of the default workspace pays the legacy-stock covering walk,
 * and that walk leaves control-document WATCHERS in the server process — so
 * every subsequent edit of that workspace re-fires `coalescedRewalk` under
 * them, and the counter moves for reasons that have nothing to do with the
 * attach path: a guaranteed false RED. A landscape created through the real
 * UI is covered at birth (the bootstrap publisher claims every document at
 * write and poses the marker as its last word), no covering walk ever runs
 * for it, no watcher exists, and the measured window (boot + create + edit)
 * therefore isolates exactly the property under test.
 *
 * Runs under the `boot` Playwright project (its testMatch covers every spec
 * in e2e/boot/), against the dev:boot stack — see e2e/boot/README.md.
 */

import { test, expect, type Page } from '@playwright/test'
import {
  enterBootApp,
  gotoView,
  dragNewShapeToCanvas,
  flushLocal,
} from './helpers.js'

const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3002'
const METRICS_TOKEN = process.env.E2E_METRICS_TOKEN

/** The process-lifetime walk counter from the production metrics endpoint.
 * Same contract as repoint-offline-create's gateMissTotal: the token is
 * REQUIRED and a non-200 fails loudly — an unauthenticated scrape returns a
 * body with no metric lines, which would read as "missing" and blame the
 * wrong layer. */
async function docScopeWalksTotal(page: Page): Promise<number> {
  expect(
    METRICS_TOKEN,
    'E2E_METRICS_TOKEN is not exported — the boot stack must set METRICS_TOKEN '
    + '(server env) and the runner must export E2E_METRICS_TOKEN with the same '
    + 'value; see e2e/boot/README.md. This spec fails rather than skips.',
  ).toBeTruthy()
  const response = await page.request.get(`${API_BASE}/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  })
  expect(response.status(), `/metrics answered ${response.status()} — check METRICS_TOKEN pairing`).toBe(200)
  const body = await response.text()
  const line = body.split('\n').find((candidate) => candidate.startsWith('maplespire_docscope_walks_total'))
  expect(line, 'maplespire_docscope_walks_total missing from /metrics').toBeTruthy()
  return Number(line!.trim().split(/\s+/).pop())
}

/** Wait until the bridge finished loading the ACTIVE workspace after a boot or
 * a switch. Unlike enterBootApp's gate this does not require resident objects:
 * the measured workspace starts EMPTY (that is the point), so the signal is
 * the bound starter diagram, then a settle beat for the first projection. */
async function waitWorkspaceReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __modelStore?: { getState: () => { diagrams?: unknown[]; currentDiagramId?: string } } })
        .__modelStore?.getState?.()
      return !!s && Array.isArray(s.diagrams) && s.diagrams.length > 0 && !!s.currentDiagramId
    },
    undefined,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(1200)
}

test('boot + create diagram + edit on a covered workspace: docscope walks delta = 0', async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept())

  // Enter the app (default workspace — its legacy covering walk, if any, is
  // NOT part of the measured window and touches a workspace we never edit).
  await enterBootApp(page)

  // Warm-up = create the MEASURED workspace: a brand-new landscape through
  // the real mega menu. Born covered (claim-at-write + marker as the
  // bootstrap's last word): no covering walk, no watcher on it.
  const name = `e2e-claim-${Date.now().toString(36)}`
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('workspace-landscapes').click()
  await page.getByTestId('new-landscape-name').fill(name)
  await page.getByTestId('new-landscape-add').click()
  await page.waitForFunction(
    () => {
      const ref = JSON.parse(localStorage.getItem('maplespire:workspaceRef') ?? '{}') as { landscapeId?: string }
      return !!ref.landscapeId && ref.landscapeId !== 'default'
    },
    undefined,
    { timeout: 30_000 },
  )
  await waitWorkspaceReady(page)

  // The measured window opens on THIS covered workspace.
  const walksBefore = await docScopeWalksTotal(page)

  // Boot: a fresh reload lands on the persisted workspaceRef (the new
  // landscape) — a fresh socket attach whose pre-warm must consult the
  // marker and schedule nothing.
  await page.reload()
  await waitWorkspaceReady(page)

  // Edit: a real palette drag creating a brand-new object on the canvas.
  await dragNewShapeToCanvas(page, 'system')
  await flushLocal(page)

  // Create: a brand-new diagram through the diagrams view's own button —
  // the server-side creator claims at write, so no published link is ever
  // un-placeable and the route gate has nothing to constat.
  await gotoView(page, 'diagrams')
  // Two clicks, not one: create-blank lives inside the create menu (same real
  // path as repoint-offline-create's createBlankDiagramViaUi).
  await page.getByTestId('create-diagram-button').click()
  await page.getByTestId('create-blank').click()
  // The create lands us in the editor on the new diagram; wait for the store
  // to carry it (real-UI signal, not a store mutation).
  await page.waitForFunction(
    () => Boolean((window as unknown as { __modelStore?: { getState: () => { currentDiagramId?: string } } })
      .__modelStore?.getState?.().currentDiagramId),
    undefined,
    { timeout: 30_000 },
  )
  await flushLocal(page)

  // Let the server digest the session's sync traffic before sampling: a walk
  // triggered by anything above would land within this window.
  await page.waitForTimeout(2_000)

  const walksAfter = await docScopeWalksTotal(page)
  expect(walksAfter - walksBefore, 'a covered session must trigger ZERO reference walks').toBe(0)

  // Cleanup OUTSIDE the measured window: delete the test landscape through
  // the real mega menu (the suite shares one live stack). Best effort — a
  // failure here must not fail the criterion above.
  try {
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('workspace-landscapes').click()
    await page.getByTestId('landscape-switch').filter({ hasText: 'Default' }).first().click()
    await page.waitForFunction(
      () => (JSON.parse(localStorage.getItem('maplespire:workspaceRef') ?? '{}') as { landscapeId?: string })
        .landscapeId === 'default',
      undefined,
      { timeout: 30_000 },
    )
    // The mega menu stays open after a switch — reopen the landscapes section.
    await page.getByTestId('workspace-landscapes').click()
    const row = page.locator('div.group', { has: page.getByTestId('landscape-switch').filter({ hasText: name }) })
    await row.hover()
    await row.getByTestId('landscape-delete').click({ force: true })
    await expect(page.getByTestId('landscape-switch').filter({ hasText: name })).toHaveCount(0, { timeout: 15_000 })
  } catch {
    /* cleanup only — the assertion above already decided the test */
  }
})
