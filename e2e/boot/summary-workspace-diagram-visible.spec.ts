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
 * A diagram created on a summary workspace appears in the Diagrams page.
 *
 * WHAT IS AT STAKE. On a summary workspace a creation writes a `DiagramDoc`
 * plus one entry in the registry WRITE HEAD, and nothing into the model. Unless
 * the projector handles the `registry-shard` branch and the write head is in
 * the projection queue, the diagram reaches NO server table: durable, openable
 * from the nav menu, and invisible to the Diagrams page, the search, "linked
 * diagrams", `diagram-render` and every share link.
 *
 * TWO ORACLES, AND THE SECOND IS THE PROOF.
 *
 *  (a) SAME TAB. Create, reach the Diagrams page THROUGH THE NAV MENU, find the
 *      card. Today the latency mask has ONE call site, `handleDuplicate`, and creation cannot
 *      reach it — `handleCreateBlank` navigates to the canvas, which unmounts
 *      the list and takes its component state with it. So (a) CANNOT pass on
 *      the mask, and as the code stands it already proves the projection.
 *      That is a property of today's mask, not of this oracle, which is why it
 *      is still not the proof — see (b).
 *
 *  (b) COLD PROFILE. A brand-new browser context, empty IndexedDB, no session
 *      memory of anything. It can only have got the diagram FROM THE SERVER.
 *      Nothing on the client can fake this one. It is here precisely because
 *      (a)'s strength is contingent: widen the mask to cover creation, or make
 *      it survive a remount, and (a) silently becomes a weak oracle — with
 *      nothing in the run saying so. (b) is the
 *      assertion that does not depend on how the mask happens to be scoped.
 *
 * NAVIGATION IS IN-APP. Never `page.goto` onto the diagrams route: a route
 * entered by `goto` is not the route a user enters. Deep-linking the WORKSPACE
 * HOME in a cold context is not what that rule forbids.
 *
 * NO STORE ORACLES. Every assertion below is a card on screen.
 *
 * HOW TO RUN IT:
 *
 *   E2E_BOOT_URL=http://localhost:5197 E2E_BOOT_API=http://localhost:3021 \
 *   E2E_SUMMARY_LANDSCAPE=M8Kxam8LPTFiJvWB E2E_SUMMARY_VERSION=u6X5xp_PLKOzZZ0B \
 *   npx playwright test --project=boot e2e/boot/summary-workspace-diagram-visible.spec.ts
 */

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { syncBar } from '../support/workspaceReady'

const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'
const SUMMARY_LANDSCAPE = process.env.E2E_SUMMARY_LANDSCAPE ?? null
const SUMMARY_VERSION = process.env.E2E_SUMMARY_VERSION ?? null

/** Two workspace boots of a 10 000-diagram fixture, one of them cold. */
const BUDGET_MS = 420_000

type ProbeWindow = Window & {
  __bridgeDebug?: () => { registrySummaryOnly?: boolean }
  __modelStore?: { getState: () => { currentDiagramId: string | null } }
}

/** Skip only on a stack that never claimed to have a summary workspace. When
 * one is declared, "not summary" is a FAILURE — a skip must never be mistakable
 * for a pass in the record. */
function requireDeclaration(): string {
  test.skip(
    SUMMARY_LANDSCAPE === null,
    'this stack declares no summary workspace; #41 has nothing to exercise here — set '
    + 'E2E_SUMMARY_LANDSCAPE/E2E_SUMMARY_VERSION to a promoted or performance-seeded workspace',
  )
  return SUMMARY_LANDSCAPE!
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  const email = page.getByTestId('dev-login-email')
  const landed = await Promise.race([
    email.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'form' as const),
    page.waitForURL('**/app/**', { timeout: 20_000 }).then(() => 'app' as const),
  ]).catch(() => 'form' as const)
  if (landed === 'form') {
    const legal = page.getByTestId('legal-acceptance')
    if (await legal.count()) await legal.check().catch(() => {})
    await email.fill(DEV_EMAIL)
    await email.press('Enter')
    await page.waitForURL('**/app/**', { timeout: 60_000 })
  }
}

async function waitForBootedWorkspace(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const state = (window as ProbeWindow).__modelStore?.getState()
      return !!state && !!state.currentDiagramId && !!(window as ProbeWindow).__bridgeDebug
    },
    undefined,
    { timeout: 120_000 },
  )
}

/** The nav menu is a TOGGLE and closes itself after a navigation, so one blind
 * click is a coin flip. Click until the item we want is really there. */
async function openNav(page: Page, testId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await page.getByTestId(testId).isVisible().catch(() => false)) return
    await page.getByTestId('nav-menu').click({ timeout: 30_000 }).catch(() => {})
    const shown = await page.getByTestId(testId).waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true).catch(() => false)
    if (shown) return
    await page.waitForTimeout(400)
  }
  throw new Error(`the nav menu never showed ${testId}`)
}

async function summaryContract(page: Page): Promise<boolean | null> {
  return page.evaluate(() => (window as ProbeWindow).__bridgeDebug?.().registrySummaryOnly ?? null)
}

function diagramFromUrl(page: Page): string | null {
  return new URL(page.url()).pathname.match(/\/diagram\/([^/?#]+)/)?.[1] ?? null
}

/** Enter the declared summary workspace by clicking what a user clicks. */
async function enterSummaryWorkspaceInApp(page: Page): Promise<void> {
  const target = requireDeclaration()
  await page.addInitScript(() => {
    localStorage.removeItem('maplespire:bootFromServer')
    localStorage.removeItem('maplespire:serverReadModel')
    localStorage.removeItem('maplespire:modelPaging')
  })
  await signIn(page)
  await waitForBootedWorkspace(page)

  if (!new URL(page.url()).pathname.includes(`/landscape/${target}/`)) {
    await openNav(page, 'workspace-landscapes')
    await page.getByTestId('workspace-landscapes').click({ timeout: 30_000 })
    const entry = page.locator(`[data-testid="landscape-switch"][data-landscape-id="${target}"]`)
    await expect(
      entry,
      `the landscape switcher never offered ${target} — is it visible to ${DEV_EMAIL}?`,
    ).toBeVisible({ timeout: 30_000 })
    await entry.click()
    await page.waitForURL(new RegExp(`/app/landscape/${target}/`), { timeout: 90_000 })
    await waitForBootedWorkspace(page)
  }

  await expect
    .poll(() => summaryContract(page), {
      timeout: 90_000,
      message: `E2E_SUMMARY_LANDSCAPE=${target} is not running the summary contract — the run is VOID, not green`,
    })
    .toBe(true)
}

/** A cold client: brand-new context, brand-new profile. A warm one reads its own
 * IndexedDB and would confirm nothing about the server.
 *
 * `baseURL` is passed EXPLICITLY: `browser.newContext()` does not inherit the
 * project's `use` options, so a bare call yields a context where every relative
 * `page.goto('/login')` throws — a cold half that never runs. */
async function coldContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL })
  return { context, page: await context.newPage() }
}

/** Deep-link the WORKSPACE HOME (allowed — the header forbids arriving at a VIEW
 * route by goto) and wait for the summary contract to be live there. */
async function enterSummaryWorkspaceCold(page: Page): Promise<void> {
  const target = SUMMARY_LANDSCAPE!
  await page.addInitScript(() => {
    localStorage.removeItem('maplespire:bootFromServer')
    localStorage.removeItem('maplespire:serverReadModel')
    localStorage.removeItem('maplespire:modelPaging')
  })
  await signIn(page)
  await page.goto(
    `/app/landscape/${target}/version/${SUMMARY_VERSION ?? 'current'}`,
    { waitUntil: 'domcontentloaded' },
  )
  await waitForBootedWorkspace(page)
  await expect.poll(() => summaryContract(page), { timeout: 90_000 }).toBe(true)
}

/**
 * Reach the Diagrams page through the NAV MENU and find one diagram's card.
 *
 * The fixture holds 10 000+ diagrams and the list is a name-ordered keyset page,
 * so a freshly created diagram is almost never on page 1 — searching is what a
 * user does, and under the summary contract the search is answered BY THE
 * SERVER. That makes this helper a server oracle by construction: a diagram
 * with no `ro_diagrams` row cannot be returned by any page of it.
 */
async function findDiagramCard(page: Page, diagramId: string, name: string): Promise<void> {
  await openNav(page, 'nav-diagrams')
  await page.getByTestId('nav-diagrams').click({ timeout: 30_000 })
  await page.waitForURL(/\/diagrams(?:[/?#]|$)/, { timeout: 60_000 })
  const search = page.getByTestId('diagrams-search')
  await expect(search, 'the Diagrams page never mounted its search box').toBeVisible({ timeout: 60_000 })
  await search.fill(name)
  await expect(
    page.getByTestId(`diagram-card-${diagramId}`),
    `the Diagrams page never showed a card for ${diagramId} ("${name}"). Under the summary contract this `
    + 'page renders the SERVER rows, so the diagram has no ro_diagrams row: the registry write head was '
    + 'either never enqueued for projection, or never projected',
  ).toBeVisible({ timeout: 90_000 })
}

test.describe('#41 — un diagramme créé sur un espace summary apparaît dans la page Diagrammes', () => {
  test('même onglet ET profil FROID', async ({ page, browser }) => {
    test.setTimeout(BUDGET_MS)
    await enterSummaryWorkspaceInApp(page)
    const beforeId = diagramFromUrl(page)

    // ── the gesture ─────────────────────────────────────────────────────────
    await openNav(page, 'create-diagram-context')
    await page.getByTestId('create-diagram-context').click({ timeout: 30_000 })
    await page.waitForURL(
      (url) => /\/diagram\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(`/diagram/${beforeId}`),
      { timeout: 90_000 },
    )
    const createdId = diagramFromUrl(page)
    expect(createdId, 'creating a diagram did not land on a new diagram route').toBeTruthy()
    expect(createdId, 'the route did not change — the click was a no-op').not.toBe(beforeId)

    // The name is read off the editor rather than assumed: it is localised, and
    // a hard-coded English string made an earlier hand-run of this scenario
    // search for something that never existed and read as a defect.
    const name = (await page.getByTestId('diagram-name').inputValue().catch(() => null))
      ?? await page.getByTestId('diagram-name').innerText()
    expect(name, 'the editor shows no name for the diagram just created').toBeTruthy()

    await expect(syncBar(page), 'the sync badge never settled after the creation')
      .toHaveAttribute('data-status', 'ready', { timeout: 120_000 })

    // ── ORACLE (a) — same tab, in-app navigation ────────────────────────────
    await findDiagramCard(page, createdId!, name)

    // ── ORACLE (b) — a SECOND, brand-new profile. THIS is the proof ─────────
    // Empty IndexedDB, no session memory: the only place this client can have
    // got the diagram is the server's read model. If the projection regressed,
    // (a) might still pass off a client-side mask; (b) cannot.
    const cold = await coldContext(browser)
    try {
      await enterSummaryWorkspaceCold(cold.page)
      await findDiagramCard(cold.page, createdId!, name)
      // And it is a real, openable diagram — not a row that lists but cannot be
      // reached, which is the other half of "the creation went somewhere".
      await cold.page.getByTestId(`diagram-card-${createdId}`).dblclick()
      await cold.page.waitForURL(new RegExp(`/diagram/${createdId}(?:[/?#]|$)`), { timeout: 60_000 })
      await expect(
        cold.page.locator('canvas').first(),
        'the cold client opened the diagram on no canvas',
      ).toBeVisible({ timeout: 60_000 })
    } finally {
      await cold.context.close()
    }
  })
})
