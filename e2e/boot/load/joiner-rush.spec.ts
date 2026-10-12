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
 * The joiners' rush: N clients boot the same heavy landscape at once.
 *
 * Measured: the classic boot of a 3 000-diagram landscape (before the fix) fails
 * **0 times in 51** with ONE client on an idle server (95% CI [0 % – 7,0 %]),
 * and **3 times in 40** with eight simultaneous clients ([2,6 % – 19,9 %]).
 * A "works on my machine" at one client proves nothing here: the failure is a
 * race between a freshly routed socket's handshake and the very first `find()`
 * on the workspace root, and only a loaded server widens that window enough to
 * lose it.
 *
 * It lives in its own Playwright project because it is SLOW by construction —
 * N real browser contexts, each doing a real sign-in and a real workspace
 * switch — and slowness in the default suite is how a suite stops being run.
 *
 *   E2E_RUSH_LANDSCAPE=<id> npx playwright test --project=boot-load
 *   E2E_RUSH_LANDSCAPE=<id> E2E_RUSH_JOINERS=8 npx playwright test --project=boot-load
 *
 * `E2E_RUSH_LANDSCAPE` is REQUIRED, and an unnamed target is a FAILURE rather
 * than a default. Its discriminating power is proportional to the size of the
 * target: on a small landscape (e.g. 631 kB of boot set) every joiner paints
 * and the gate exercises the concurrency but not the load.
 *
 * `cd server && npm run fsck` prints `boot … kB/max … kB` per workspace; name
 * the biggest. Example (performance seed):
 *
 *   slope-a        631 kB      slope-b       1 990 kB
 *   slope-c      6 671 kB      slope-target 21 614 kB
 *
 * The floor `E2E_RUSH_MIN_BOOT_KB` (default 4 000) is then checked against what
 * the joiners ACTUALLY pulled over their sync sockets, never against a
 * declared figure — a declaration would only move the vacuity one env var
 * upstream.
 */
import { test, expect, type Browser, type Page } from '@playwright/test'

const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'
const JOINERS = Math.max(2, Number(process.env.E2E_RUSH_JOINERS ?? 6))
const TARGET = process.env.E2E_RUSH_LANDSCAPE ?? ''
/** kB of sync traffic the heaviest joiner must really have pulled for this run
 * to have measured anything. 4 000 sits above `slope-b` (1 990) and well below
 * `slope-c` (6 671), so it separates "big enough to queue documents behind one
 * another on a serial server" from merely "a landscape". */
const MIN_BOOT_KB = Math.max(0, Number(process.env.E2E_RUSH_MIN_BOOT_KB ?? 4_000))

async function signIn(page: Page): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  const email = page.getByTestId('dev-login-email')
  const landed = await Promise.race([
    email.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'form' as const),
    page.waitForURL('**/app/**', { timeout: 30_000 }).then(() => 'app' as const),
  ]).catch(() => 'form' as const)
  if (landed === 'form') {
    const legal = page.getByTestId('legal-acceptance')
    if (await legal.count()) await legal.check().catch(() => {})
    await email.fill(DEV_EMAIL)
    await email.press('Enter')
    await page.waitForURL('**/app/**', { timeout: 60_000 })
  }
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => Array.isArray((window as any).__modelStore?.getState?.().diagrams),
    undefined,
    { timeout: 90_000 },
  )
}

/** Through the REAL navigation menu, never a `goto` to the target route. */
async function switchLandscape(page: Page, landscapeId: string): Promise<void> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('workspace-landscapes').click()
  await page.locator(`[data-testid="landscape-switch"][data-landscape-id="${landscapeId}"]`)
    .click({ timeout: 30_000 })
}

async function joinerReachesTheCanvas(browser: Browser, landscapeId: string, index: number) {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    // What this joiner really pulled over its sync socket. MEASURED, not
    // declared: it is the anti-vacuity guard for the whole gate, and a
    // guard fed by the same env var that chooses the target would guard
    // nothing. `framereceived` fires for the Automerge socket, which is where
    // the boot set travels.
    let bytes = 0
    page.on('websocket', (ws) => {
      if (!/\/automerge/.test(ws.url())) return
      ws.on('framereceived', (frame) => { bytes += frame.payload.length })
    })
    // The classic boot — the path the defect lives on.
    await page.addInitScript(() => {
      localStorage.setItem('maplespire:bootFromServer', 'false')
      localStorage.setItem('maplespire:serverReadModel', 'false')
    })
    await signIn(page)
    await switchLandscape(page, landscapeId)

    // The oracle is the DOM a user looks at, never a store selector, and the
    // failure is named rather than timed out on: a joiner that dies shows the
    // boot-failure panel, and its text carries the document that killed it.
    //
    // It names the WORKSPACE, not just a `<canvas>`. The previous landscape's
    // canvas is still mounted for the first frames of a switch, so
    // `locator('canvas').waitFor('visible')` resolves on the OLD one, at once,
    // whatever happens to the target: measured here on `slope-target`, where
    // both joiners reported `canvas` having pulled 1 218 kB — about what the
    // default landscape's own boot costs, and a fraction of the target's boot
    // set. The sibling spec had already been bitten by this and says so; this
    // one had not been taught yet.
    const booted = page.locator('#sync-status')
      .and(page.locator(`[data-projected-workspace^="${landscapeId}/"]`))
    const failure = page.getByTestId('canvas-boot-error-detail')
    const outcome = await Promise.race([
      booted.waitFor({ state: 'attached', timeout: 180_000 })
        .then(() => page.locator('canvas').first().waitFor({ state: 'visible', timeout: 30_000 }))
        .then(() => 'canvas' as const),
      failure.waitFor({ state: 'visible', timeout: 180_000 }).then(() => 'failed' as const),
    ]).catch(() => 'timeout' as const)
    const detail = outcome === 'failed' ? await failure.innerText().catch(() => '') : ''
    return { index, outcome, detail, bytes }
  } finally {
    await context.close()
  }
}

test.describe('#37 the joiners rush', () => {
  test(`${JOINERS} clients open the same landscape at once, and every one of them paints`, async ({ browser }) => {
    test.setTimeout(600_000)

    // NAMED, never chosen. Picking "the first landscape I am not in" could
    // land on a small one where all joiners paint whatever the boot budget.
    // Same ruling as `summary-diagram-delete.spec.ts` — a skip is not a success,
    // and neither is a default.
    expect(
      TARGET,
      'E2E_RUSH_LANDSCAPE must NAME the heaviest workspace on this stack'
      + ' (cd server && npm run fsck, then read the `boot … kB` column).'
      + ' Choosing one here would let the gate pass on a landscape too small to queue documents.',
    ).toBeTruthy()
    const landscapeId = TARGET

    // All at once, on purpose. Sequentially each of these boots passes — that
    // is the 0-in-51 measurement — and the interesting part is the contention.
    const results = await Promise.all(
      Array.from({ length: JOINERS }, (_, index) => joinerReachesTheCanvas(browser, landscapeId, index)),
    )

    const heaviestKb = Math.round(Math.max(...results.map((result) => result.bytes)) / 1024)
    const casualties = results.filter((result) => result.outcome !== 'canvas')
    expect(
      casualties,
      `joiners that never painted (heaviest boot ${heaviestKb} kB): ${JSON.stringify(casualties)}`,
    ).toEqual([])

    // AFTER the subject, and meaningful only because every joiner painted: a
    // casualty pulls fewer bytes by definition, so this figure reads cleanly
    // on an all-green run and nowhere else. The first guard stops the target
    // being unnamed; this one stops it being named and small.
    expect(
      heaviestKb,
      `the rush moved only ${heaviestKb} kB into ${landscapeId}: too light to queue documents behind`
      + ` one another on a server that serves them one at a time, so an all-green result proves`
      + ` nothing about the boot budget. Name a heavier workspace, or lower E2E_RUSH_MIN_BOOT_KB`
      + ` on purpose.`,
    ).toBeGreaterThanOrEqual(MIN_BOOT_KB)
  })
})
