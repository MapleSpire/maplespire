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
 * The workspace-contract epoch guard END TO END.
 *
 * Two tabs, one workspace. Tab A is an ordinary CLASSIC session — a client with
 * none of the Vite flags, on a workspace whose root does not yet say
 * `registrySummaryOnly`. The workspace is then PROMOTED to the server-registry
 * (summary) contract while that tab is live, which is what an operator running
 * the migration does to a landscape someone happens to have open.
 *
 * What must be true afterwards, and none of it is provable from a unit test:
 *
 *  1. The banner is ON SCREEN in tab A. The store boolean is covered by
 *     `bridgeSummaryContract.test.ts` and the render by
 *     `WorkspaceContractBanner.test.tsx`; only a real browser proves the
 *     component is actually MOUNTED on the route the user is on, above the app's
 *     own chrome, and not painted under the impersonation strip.
 *  2. Tab A stops writing. The freeze lives in `flushWrite`, and the thing it
 *     protects is durability, so the honest assertion is on the SERVER: an edit
 *     made in tab A after the promotion must not appear in the read model, and
 *     — the part that matters — must not have corrupted the baseline the server
 *     just fenced.
 *  3. The reload lands on the new contract. Same tab, one click, and afterwards
 *     the session is boot-from-server with the banner gone.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PREREQUISITES. The run needs a stack that can actually promote — an
 * ISOLATED one (this mutates a boot contract for every tab on it), `AUTH=on`
 * (or `dual`) with the dev-login account bootstrapped as a PLATFORM ADMIN, a
 * workspace whose fsck is clean and whose read model is converged, and
 * `E2E_PROMOTE_URL` pointing at `POST /api/platform/workspace/promote-summary`
 * (`server/src/maintenance/promoteSummaryWorkspace.ts`). `promoteWorkspace`
 * below FAILS EXPLICITLY when `E2E_PROMOTE_URL` is unset — per
 * e2e/boot/README.md, a missing prerequisite fails the run, it never skips it.
 * Never point it at a stack whose default workspace other specs (e.g.
 * `summary-workspace-functional.spec.ts`) rely on as the classic control.
 *
 * ⚠ TWO STACK REQUIREMENTS, both of which turn this spec RED (409/403) on a
 * stack that does not meet them:
 *
 *  1. **`apply: true` must be sent explicitly.** Without it the route answers
 *     a dry-run REPORT with `applied: null` — 200, banner never appears, every
 *     assertion below fails for the wrong reason. The request built below
 *     sends it.
 *  2. **An APPLY requires an identified platform admin at EVERY auth stage.**
 *     `page.request` shares the context's cookies, so signing in as one in
 *     `enterClassicApp` is all that is needed. On an AUTH-less stack the
 *     promotion answers 403 and names the operator script instead; that is the
 *     run being VOID, not the app being broken.
 *
 * `allowConnectedPeers: true` IS REQUIRED HERE, and it is the whole point of
 * this scenario. The primitive's v1 quiesce precondition refuses a promotion
 * with any live socket on the workspace — because a CLASSIC tab does not
 * journal its entity writes (the client intent capture is gated on
 * `bfsActive`), so an in-flight object/connection edit would be lost. This spec
 * promotes with a live classic tab ON PURPOSE, to prove the banner + the write
 * freeze + the reload. Sending the flag is the operator saying "I accept that
 * loss"; without it the server answers 409 and the run correctly fails.
 *
 * Run it on an ISOLATED stack only — it mutates a workspace's boot contract for
 * every other tab and every other spec pointed at that stack. It is reversible
 * (`npm run demote-summary -- --landscape X --version Y --apply
 * --assume-quiesced`, or `POST /api/platform/workspace/demote-summary`), but it
 * is not free: at scale the demotion re-exposes both client walls.
 *
 *   E2E_BOOT_URL=http://localhost:5182 \
 *   E2E_BOOT_API=http://localhost:3006 \
 *   E2E_PROMOTE_URL=http://localhost:3006/api/platform/workspace/promote-summary \
 *   npx playwright test --project=boot e2e/boot/workspace-contract-promotion.spec.ts
 */
import { test, expect, type Page } from '@playwright/test'

const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3002'
const PROMOTE_URL = process.env.E2E_PROMOTE_URL
/** Must be a PLATFORM ADMIN on the target stack — see requirement 2 above. */
const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'

/**
 * Promote the workspace's ROOT to the summary contract, from OUTSIDE the
 * browser — an operator running the migration, not the app.
 *
 * Never falls back to "do it from the page": the client has no API for this and
 * inventing one for the test would be testing the test. If the stack cannot
 * promote, the run is void and says so.
 */
async function promoteWorkspace(
  page: Page,
  workspace: { landscapeId: string; versionId: string },
): Promise<void> {
  expect(
    PROMOTE_URL,
    'E2E_PROMOTE_URL is not set — this spec needs a stack-side way to promote a live workspace to '
    + 'registrySummaryOnly. Without it the promotion never happens and every assertion below would '
    + 'pass for the wrong reason.',
  ).toBeTruthy()
  // `apply: true` — must be EXPLICIT. Without it this is a dry run
  // that answers 200 with `applied: null`, and every assertion below fails
  // downstream of a promotion that never happened.
  //
  // `allowConnectedPeers` — see the file header. THIS tab is the connected peer
  // the primitive's quiesce precondition refuses; overriding it by name is what
  // makes the live-promotion scenario reachable at all. A 409 here means the
  // server refused for some OTHER reason (a diverged read model, an uncovered
  // workspace, an unclean fsck), and the body says which — none of those is
  // overridable, deliberately. A 403 means the session is not a platform admin
  // (header, requirement 2); a 500 means an apply that changed nothing.
  const response = await page.request.post(PROMOTE_URL!, {
    data: { ...workspace, apply: true, allowConnectedPeers: true },
  })
  expect(response.ok(), `promotion request failed: ${response.status()} ${await response.text()}`).toBe(true)
  // A 200 is now the primitive's own claim that it APPLIED — assert on the body
  // too, so a future status-code change cannot make this step vacuous.
  const body = await response.json() as { applied: unknown; blockers: unknown[] }
  expect(body.blockers, 'the promotion must report no blockers').toEqual([])
  expect(body.applied, 'the promotion must report what it applied').toBeTruthy()
}

/**
 * The workspace the tab is actually on — the promotion must target THAT one.
 *
 * Through `__routeStores()`: there is no `window.__workspaceStore` global.
 * A probe cannot reach the route stores with `import('/src/stores/…')` either —
 * Vite resolves that specifier to a SECOND module instance whose state is all
 * defaults, which reads back as plausible but wrong data.
 */
async function activeWorkspace(page: Page): Promise<{ landscapeId: string; versionId: string }> {
  return page.evaluate(async () => {
    const routeStores = (window as unknown as {
      __routeStores?: () => Promise<{
        workspace: { getState: () => { ref: { landscapeId: string; versionId: string } } }
      }>
    }).__routeStores
    const ref = routeStores ? (await routeStores()).workspace.getState().ref : undefined
    if (!ref) throw new Error('no active workspace ref on the page')
    return { landscapeId: ref.landscapeId, versionId: ref.versionId }
  })
}

/** Enter the app as a CLASSIC client: no flags, so the boot contract can only
 * come from the root — which is the whole point of this spec.
 *
 * The sign-in is required: requirement 2 in the file header needs this session
 * to be a PLATFORM ADMIN, because `page.request` shares the context's cookies
 * and that is what authorises the promotion POST. */
async function enterClassicApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('maplespire:bootFromServer')
    localStorage.removeItem('maplespire:serverReadModel')
    localStorage.removeItem('maplespire:modelPaging')
  })
  // This helper is called on a COLD tab and again after `page.reload()`, so it
  // has to be right about BOTH:
  //  - a bare `isVisible()` on the login field is a synchronous probe against an
  //    ASYNCHRONOUS redirect: it can run while the marketing shell is still up,
  //    report "no login form" and skip the sign-in;
  //  - on the re-entry call the session is ALREADY authenticated, and a race
  //    whose loser rejects can settle as 'form' with no form on the page. Ask
  //    the address bar first; only race when it says we are still outside.
  if (!/\/app(\/|$)/.test(page.url())) await page.goto('/')
  const email = page.getByTestId('dev-login-email')
  const landed = /\/app(\/|$)/.test(page.url())
    ? 'app' as const
    : await Promise.race([
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
  const start = page.getByRole('button', { name: /Start designing free/ })
  if (await start.first().isVisible().catch(() => false)) await start.first().click()
  await page.waitForFunction(
    () => {
      const state = (window as unknown as { __modelStore?: { getState: () => { diagrams: unknown[]; currentDiagramId: string | null } } })
        .__modelStore?.getState()
      return !!state && state.diagrams.length > 0 && !!state.currentDiagramId
    },
    undefined,
    { timeout: 60_000 },
  )
  // Anti-void: a stack that happens to carry the build flags would boot
  // boot-from-server here and there would be no classic session to promote.
  const bfs = await page.evaluate(
    () => (window as unknown as { __bootFromServer?: { enabled: () => boolean } }).__bootFromServer?.enabled?.() ?? false,
  )
  expect(bfs, 'this tab must be a CLASSIC session — clear the Vite flags on this stack').toBe(false)
}

/** Bring the renamed control card back on screen (the list virtualizes and
 * re-sorts on rename) and assert it really carries the new name. */
async function showControlCard(page: Page, controlId: string, name: string): Promise<void> {
  const search = page.getByTestId('diagrams-search')
  if (await search.isVisible().catch(() => false)) await search.fill(name)
  const card = page.getByTestId(`diagram-card-${controlId}`)
  await card.scrollIntoViewIfNeeded({ timeout: 30_000 }).catch(() => {})
  await expect(card).toContainText(name)
}

test('a live promotion banners the classic tab, freezes its writes, and the reload lands on the new contract', async ({ page }) => {
  await enterClassicApp(page)
  const workspace = await activeWorkspace(page)

  // Control, and the anti-void guard: BEFORE the promotion this tab really does
  // persist. Without it a frozen-from-birth session would pass every assertion
  // below.
  const before = `pre-promotion ${Date.now()}`
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  const firstCard = page.locator('[data-testid^="diagram-card-"]').first()
  const controlId = (await firstCard.getAttribute('data-testid'))!.replace('diagram-card-', '')
  await page.getByTestId(`diagram-menu-${controlId}`).click()
  await page.getByTestId(`diagram-rename-${controlId}`).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(before)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('ws-sync-status')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
  // The list is VIRTUALIZED and sorted by name, so the rename moves the card —
  // "pre-promotion …" lands near the end of the alphabet and its row unmounts.
  // Asserting on it where it used to be reports "element(s) not found", which
  // reads like a lost write and is only a scroll.
  await showControlCard(page, controlId, before)
  await page.reload()
  await enterClassicApp(page)
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  await showControlCard(page, controlId, before)

  // The operator promotes the workspace while this tab is live.
  await promoteWorkspace(page, workspace)

  // 1. The banner reaches the SCREEN — mounted on the route the user is on.
  const banner = page.getByTestId('workspace-contract-banner')
  await expect(banner).toBeVisible({ timeout: 30_000 })
  await expect(banner).toHaveAttribute('role', 'status')
  // Not painted under something else: its box must actually be on screen and
  // its reload affordance hittable (a `fixed top-0` strip hidden beneath the
  // impersonation banner reports visible and is unusable).
  await expect(page.getByTestId('workspace-contract-reload')).toBeVisible()
  const box = await banner.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThan(0)

  // 2. The writes are frozen. An edit made now must not reach the server: the
  // baseline is fenced, the classic session journals nothing, and the honest
  // outcome is that the promotion's quiesce holds.
  const after = `post-promotion ${Date.now()}`
  await page.getByTestId(`diagram-menu-${controlId}`).click()
  await page.getByTestId(`diagram-rename-${controlId}`).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(after)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(3_000)
  const listed = await page.request.get(
    `${API_BASE}/api/model/diagrams?landscapeId=${workspace.landscapeId}&versionId=${workspace.versionId}&limit=500`,
  )
  expect(listed.ok()).toBe(true)
  const body = await listed.json() as { items: Array<{ id: string; name: string }> }
  const row = body.items.find((item) => item.id === controlId)
  expect(row, 'the control diagram must still exist server-side').toBeTruthy()
  expect(row!.name, 'a frozen tab must not have written the post-promotion name').not.toBe(after)
  expect(row!.name).toBe(before)

  // 3. The reload lands on the NEW contract, and the banner is gone with it.
  await page.getByTestId('workspace-contract-reload').click()
  await page.waitForFunction(
    () => (window as unknown as { __bootFromServer?: { enabled: () => boolean } }).__bootFromServer !== undefined,
    undefined,
    { timeout: 60_000 },
  )
  await expect(page.getByTestId('workspace-contract-banner')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByTestId('ws-sync-status')).toBeVisible({ timeout: 60_000 })
})
