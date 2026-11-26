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
 *      memory of anything. It is here precisely because
 *      (a)'s strength is contingent: widen the mask to cover creation, or make
 *      it survive a remount, and (a) silently becomes a weak oracle — with
 *      nothing in the run saying so. (b) is the
 *      assertion that does not depend on how the mask happens to be scoped.
 *
 *      ⚠ "a cold profile can only have got it from the server" was FALSE, and
 *      it was measured during T-SUM-0: the cold client syncs the registry
 *      write head over Automerge, so it HOLDS the diagram locally. With the
 *      `registry-shard` projection neutralised AND the list forced onto its
 *      local-window fallback, both arms stayed green with zero `ro_diagrams`
 *      rows. So (b) now also requires (i) that a `/api/model/diagrams/page`
 *      RESPONSE seen by the cold page lists the id, (ii) that the
 *      partial-offline banner is absent, and the harness adds a SQL
 *      post-check (`ro_diagrams` row, registry-shard queue row projected).
 *
 * NAVIGATION IS IN-APP. Never `page.goto` onto the diagrams route: a route
 * entered by `goto` is not the route a user enters. Deep-linking the WORKSPACE
 * HOME in a cold context is not what that rule forbids.
 *
 * NO STORE ORACLES. Every assertion below is a card on screen.
 *
 * TWO USERS (T-SUM-0). `E2E_COLD_EMAIL` names the user of the cold profile
 * (Marie); Paul (`E2E_DEV_EMAIL`) creates. Without it the cold profile is
 * Paul again — still a cold client, but not "another user sees it".
 *
 * THE OBJECT RENAME (T-SUM-0b), oracle (c). After oracle (a), Paul renames the
 * first object row of the Model Objects page; Marie, in the same cold profile,
 * searches the Model Objects page for the NEW name and must see it in that
 * object's row, carried by a `/api/model/objects/search` response. Until
 * T-SUM-0b no rename on a summary workspace reached `ro_objects`: the object
 * write head published by the rotation at the entry into the static plane was
 * never projected. The harness judges the row's
 * content against the overlay heads read from storage (`judgeObjectFacts`).
 *
 * PROMOTED ARM (T-SUM-0). With `E2E_SUMMARY_PROMOTE=1` the declared workspace
 * is an ORDINARY one, and the test first opens it in a throw-away profile (so
 * it is sharded and projected as a user's workspace is), closes that profile
 * (no connected peer), then promotes it through
 * `POST /api/platform/workspace/promote-summary` with Paul's platform-admin
 * session — the route an operator is told to use.
 *
 * HOW TO RUN IT: `node scripts/e2e-summary-visibility.mjs` (own stack, both
 * arms, a skip is a failure — it sets `E2E_SUMMARY_REQUIRED=1`), or by hand:
 *
 *   E2E_BOOT_URL=http://localhost:5197 E2E_BOOT_API=http://localhost:3021 \
 *   E2E_SUMMARY_LANDSCAPE=M8Kxam8LPTFiJvWB E2E_SUMMARY_VERSION=u6X5xp_PLKOzZZ0B \
 *   npx playwright test --project=boot e2e/boot/summary-workspace-diagram-visible.spec.ts
 */

import { writeFileSync } from 'node:fs'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { syncBar, waitForWorkspaceProjected } from '../support/workspaceReady'

const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'
const COLD_EMAIL = process.env.E2E_COLD_EMAIL ?? DEV_EMAIL
const SUMMARY_LANDSCAPE = process.env.E2E_SUMMARY_LANDSCAPE ?? null
const SUMMARY_VERSION = process.env.E2E_SUMMARY_VERSION ?? null
const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3002'
const PROMOTE_FIRST = process.env.E2E_SUMMARY_PROMOTE === '1'
/** Set by the harness: a missing declaration is then a FAILURE, never a skip. */
const REQUIRED = process.env.E2E_SUMMARY_REQUIRED === '1'
/** Where the harness wants the created id, for its SQL post-check. */
const CREATED_FILE = process.env.E2E_SUMMARY_CREATED_FILE ?? null

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
  if (REQUIRED) {
    expect(SUMMARY_LANDSCAPE, 'E2E_SUMMARY_REQUIRED=1 but no E2E_SUMMARY_LANDSCAPE: the harness declared nothing').toBeTruthy()
    return SUMMARY_LANDSCAPE!
  }
  test.skip(
    SUMMARY_LANDSCAPE === null,
    'this stack declares no summary workspace; #41 has nothing to exercise here — set '
    + 'E2E_SUMMARY_LANDSCAPE/E2E_SUMMARY_VERSION to a promoted or performance-seeded workspace',
  )
  return SUMMARY_LANDSCAPE!
}

async function signIn(page: Page, emailAddress: string = DEV_EMAIL): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  const email = page.getByTestId('dev-login-email')
  const landed = await Promise.race([
    email.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'form' as const),
    page.waitForURL('**/app/**', { timeout: 20_000 }).then(() => 'app' as const),
  ]).catch(() => 'form' as const)
  if (landed === 'form') {
    const legal = page.getByTestId('legal-acceptance')
    if (await legal.count()) await legal.check().catch(() => {})
    await email.fill(emailAddress)
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
async function enterSummaryWorkspaceCold(page: Page, emailAddress: string = COLD_EMAIL): Promise<void> {
  const target = SUMMARY_LANDSCAPE!
  await page.addInitScript(() => {
    localStorage.removeItem('maplespire:bootFromServer')
    localStorage.removeItem('maplespire:serverReadModel')
    localStorage.removeItem('maplespire:modelPaging')
  })
  await signIn(page, emailAddress)
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
 * A large fixture's list is a name-ordered keyset page, so a freshly created
 * diagram is rarely on page 1 — searching is what a user does, and under the
 * summary contract the search is answered by the server. The CARD alone is
 * not a server oracle (the local-window fallback can render it, see the
 * header), so the caller also checks `serverListed` and the banner.
 *
 * Returns the ids every `/api/model/diagrams/page` response this page received
 * listed, from the moment the helper started.
 */
async function findDiagramCard(page: Page, diagramId: string, name: string): Promise<{ serverListed: Set<string> }> {
  const serverListed = new Set<string>()
  page.on('response', (response) => {
    if (!response.url().includes('/api/model/diagrams/page') || !response.ok()) return
    void response.json().then((body: { items?: Array<{ id?: string }> }) => {
      for (const item of body.items ?? []) if (item.id) serverListed.add(item.id)
    }).catch(() => {})
  })
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
  return { serverListed }
}

type RenamedObject = { id: string; previousName: string; name: string; renameStartedAt: string }

/**
 * T-SUM-0b: rename the first OBJECT row of the Model Objects page (a group
 * row is a ModelMeta write, not an overlay one, so it is excluded: only an
 * object row is draggable), through the details panel, as a user does.
 */
async function renameFirstObject(page: Page): Promise<RenamedObject> {
  await openNav(page, 'nav-model-objects')
  await page.getByTestId('nav-model-objects').click({ timeout: 30_000 })
  await expect(page.getByTestId('mo-search'), 'the Model Objects page never mounted its search box')
    .toBeVisible({ timeout: 60_000 })
  const row = page.locator('tr[data-testid^="mo-row-"][draggable="true"]').first()
  await expect(row, 'the Model Objects page listed no object row').toBeVisible({ timeout: 60_000 })
  const id = (await row.getAttribute('data-testid'))!.replace(/^mo-row-/, '')
  await row.click()
  const field = page.getByTestId('object-name')
  await expect(field, 'selecting the row opened no name field').toBeVisible({ timeout: 30_000 })
  const previousName = await field.inputValue()
  const name = `T-SUM-0b renamed ${Date.now()}`
  expect(name).not.toBe(previousName)
  const renameStartedAt = new Date().toISOString()
  await field.fill(name)
  await field.blur()
  await expect(field).toHaveValue(name)
  return { id, previousName, name, renameStartedAt }
}

/**
 * Marie's half of the rename: the Model Objects page, searched by the NEW
 * name. The ROW alone is not the oracle — a row exists under the OLD name
 * whatever happened (measured by T-SUM-0: the search did not narrow a
 * 1 000-object table, and the row was on screen under its old name). The
 * NAME shown in that row is, and a `/api/model/objects/search` response the
 * page received must carry the id with the new name, so the row is a server
 * answer and not the cold client's own copy of the overlay head.
 */
async function findRenamedObject(page: Page, renamed: RenamedObject): Promise<void> {
  let serverAnswered = false
  page.on('response', (response) => {
    if (!response.url().includes('/api/model/objects/search') || !response.ok()) return
    void response.text().then((text) => {
      if (text.includes(renamed.id) && text.includes(renamed.name)) serverAnswered = true
    }).catch(() => {})
  })
  await openNav(page, 'nav-model-objects')
  await page.getByTestId('nav-model-objects').click({ timeout: 30_000 })
  const search = page.getByTestId('mo-search')
  await expect(search, 'the cold Model Objects page never mounted its search box').toBeVisible({ timeout: 60_000 })
  await search.fill(renamed.name)
  await expect(
    page.getByTestId(`mo-row-${renamed.id}`),
    `Marie never saw object ${renamed.id} under Paul's new name "${renamed.name}" (it was "${renamed.previousName}"): `
    + 'the rename reached no ro_objects row — the static plane did not project the object write head',
  ).toContainText(renamed.name, { timeout: 90_000 })
  await expect.poll(() => serverAnswered, {
    timeout: 30_000,
    message: `no /api/model/objects/search response carried ${renamed.id} with "${renamed.name}": the row did not come from the server`,
  }).toBe(true)
  await page.screenshot({ path: test.info().outputPath('cold-profile-renamed-object.png') })
}

/**
 * The PROMOTED arm's preamble: a user opens the ordinary workspace (and so
 * shards it and lets it project, as any user's workspace is when an operator
 * promotes it), leaves, and the operator promotes it through the ROUTE.
 * Every failure here is a failure of the run, never a skip.
 */
async function promoteThroughRoute(browser: Browser): Promise<void> {
  const target = requireDeclaration()
  const version = SUMMARY_VERSION
  expect(version, 'the promoted arm needs E2E_SUMMARY_VERSION').toBeTruthy()
  const visit = await coldContext(browser)
  try {
    await signIn(visit.page, DEV_EMAIL)
    await visit.page.goto(`/app/landscape/${target}/version/${version}`, { waitUntil: 'domcontentloaded' })
    await waitForBootedWorkspace(visit.page)
    await waitForWorkspaceProjected(visit.page, { landscapeId: target, versionId: version! })
    expect(await summaryContract(visit.page), 'the promoted arm must START from an ordinary workspace').toBe(false)
    await expect(syncBar(visit.page), 'the ordinary workspace never settled before the promotion')
      .toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
  } finally {
    await visit.context.close()
  }
  // Paul's session, from a context with no page on the workspace: the
  // promotion's quiesce precondition counts live sockets, and this one has
  // none. `allowConnectedPeers` is NOT sent — a peer still bound would be a
  // defect of this preamble, and the 409 says so.
  const admin = await coldContext(browser)
  try {
    await signIn(admin.page, DEV_EMAIL)
    await admin.page.goto('about:blank')
    const url = `${API_BASE}/api/platform/workspace/promote-summary`
    let body: { applied?: unknown; blockers?: Array<{ code: string; detail: string }> } = {}
    let status = 0
    // The ordinary projector and the socket census may lag the visit by a few
    // seconds: those two transient refusals are retried, anything else is
    // the answer.
    const transient = new Set(['read-model-not-caught-up', 'peers-connected'])
    for (let attempt = 0; attempt < 20; attempt += 1) {
      // The apply WAITS OUT the baseline fence's arming bound (15 s) on
      // purpose, plus fsck and the registry materialisation: the default
      // 15 s request timeout fires while the promotion is still running.
      const response = await admin.context.request.post(url, {
        data: { landscapeId: target, versionId: version, apply: true },
        timeout: 180_000,
      })
      status = response.status()
      body = await response.json().catch(() => ({}))
      const codes = (body.blockers ?? []).map((blocker) => blocker.code)
      if (status !== 409 || codes.length === 0 || !codes.every((code) => transient.has(code))) break
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
    expect(status, `promotion through the route answered ${status}: ${JSON.stringify(body)}`).toBe(200)
    expect(body.blockers, 'the promotion must report no blockers').toEqual([])
    expect(body.applied, 'the promotion must report what it applied').toBeTruthy()
  } finally {
    await admin.context.close()
  }
}

test.describe('#41 — un diagramme créé sur un espace summary apparaît dans la page Diagrammes', () => {
  test('même onglet ET profil FROID', async ({ page, browser }) => {
    test.setTimeout(BUDGET_MS)
    if (PROMOTE_FIRST) await promoteThroughRoute(browser)
    await enterSummaryWorkspaceInApp(page)
    const beforeId = diagramFromUrl(page)

    // ── the gesture ─────────────────────────────────────────────────────────
    // For the harness's post-check: the carrier's queue row must have been
    // projected AFTER this instant.
    const creationStartedAt = new Date().toISOString()
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
    // The harness's SQL post-check reads this (ro_diagrams row, queue row) —
    // written BEFORE any oracle, so the server half is judged on every run.
    // `type` is what the gesture asks for (`create-diagram-context`).
    if (CREATED_FILE) {
      writeFileSync(CREATED_FILE, JSON.stringify({ diagramId: createdId, name, type: 'context', creationStartedAt }))
    }

    await expect(syncBar(page), 'the sync badge never settled after the creation')
      .toHaveAttribute('data-status', 'ready', { timeout: 120_000 })

    // ── ORACLE (a) — same tab, in-app navigation ────────────────────────────
    await findDiagramCard(page, createdId!, name)

    // ── the OBJECT rename (T-SUM-0b) ────────────────────────────────────────
    // Done after the diagram's oracle (a), so the server has long rotated the
    // object write head it found at the workspace's entry into the static
    // plane: the defect T-SUM-0b fixes lived in the head AFTER that rotation.
    // The harness reports whether the rotation did precede the rename.
    const renamed = await renameFirstObject(page)
    if (CREATED_FILE) {
      writeFileSync(CREATED_FILE, JSON.stringify({
        diagramId: createdId, name, type: 'context', creationStartedAt, object: renamed,
      }))
    }
    await expect(syncBar(page), 'the sync badge never settled after the object rename')
      .toHaveAttribute('data-status', 'ready', { timeout: 120_000 })

    // ── ORACLE (b) — a SECOND user, brand-new profile ───────────────────────
    // Empty IndexedDB, no session memory — but it syncs the registry write
    // head, so the card alone could come from its local window (header). The
    // server's own list response and the absence of the partial-offline
    // banner are what make (b) a server oracle.
    if (REQUIRED) {
      expect(COLD_EMAIL, 'E2E_SUMMARY_REQUIRED=1: the cold profile must be ANOTHER user (E2E_COLD_EMAIL)')
        .not.toBe(DEV_EMAIL)
    }
    const cold = await coldContext(browser)
    try {
      await enterSummaryWorkspaceCold(cold.page)
      const me = await cold.context.request.get(`${API_BASE}/api/auth/me`)
      const meBody = await me.json().catch(() => null) as { user?: { email?: string } } | null
      expect(meBody?.user?.email, 'the cold profile is not signed in as E2E_COLD_EMAIL').toBe(COLD_EMAIL)
      const { serverListed } = await findDiagramCard(cold.page, createdId!, name)
      await expect(
        cold.page.getByTestId('diagram-list-partial-offline'),
        'the cold profile rendered its LOCAL window (partial-offline banner): the card is not a server answer',
      ).toHaveCount(0)
      await expect.poll(() => serverListed.has(createdId!), {
        timeout: 30_000,
        message: `no /api/model/diagrams/page response listed ${createdId}: the card did not come from the server`,
      }).toBe(true)
      // What the cold user SAW, kept with the run (the harness's log dir): the
      // card on screen is the claim, and the picture is its record.
      await cold.page.screenshot({ path: test.info().outputPath('cold-profile-diagrams-card.png') })
      // And it is a real, openable diagram — not a row that lists but cannot be
      // reached, which is the other half of "the creation went somewhere".
      await cold.page.getByTestId(`diagram-card-${createdId}`).dblclick()
      await cold.page.waitForURL(new RegExp(`/diagram/${createdId}(?:[/?#]|$)`), { timeout: 60_000 })
      await expect(
        cold.page.locator('canvas').first(),
        'the cold client opened the diagram on no canvas',
      ).toBeVisible({ timeout: 60_000 })

      // ── ORACLE (c) — Paul's OBJECT rename, seen by Marie (T-SUM-0b) ────────
      await findRenamedObject(cold.page, renamed)
    } finally {
      await cold.context.close()
    }
  })
})
