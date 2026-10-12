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
 * A workspace MOVE during an open session must not break a page.
 *
 * ## Why this is not the two-cell bench, and why that is legitimate here
 *
 * A real ownership move between sync cells is exercised by the two-partition
 * sync-cell bench. But the move is not what the CLIENT sees. What the client
 * sees is one thing only: `createWorkspaceHttpRouting` answering
 * `503 {retryable: true}` on the routed HTTP surface while the new owner warms
 * up. That response is reproducible at the transport level, exactly, without a
 * second cell — and the pages break (or do not) on the response, not on the
 * topology behind it.
 *
 * What this spec therefore does NOT establish: that a real move produces only
 * these responses and no others. That is the bench's job.
 *
 * ## Running it
 *
 * There is no `webServer` in `playwright.config.ts`; these specs expect a stack
 * already listening on `E2E_BASE_URL`. Run against
 * `infra/compose/sync-cell-failover.yml` (two partitions, fresh volumes,
 * dev login, an empty personal landscape created by the first login):
 *
 *     E2E_BASE_URL=http://127.0.0.1:<frontend port> \
 *       npx playwright test e2e/workspace-move-retryable.spec.ts --project=chromium
 *
 * « Document … is unavailable after 3 attempt(s) » on that stack means the
 * frontend cannot reach the WebSocket router (see the `SYNC_WS_PORT` comment in
 * the compose file), not a data problem.
 *
 * Selectors worth knowing:
 *
 *  - `ws-sync-status` is WorkspaceShell's badge and renders on the LIST pages
 *    (Model Objects, Model Connections, Dependencies). The canvas the app lands
 *    on has the editor's `#sync-status` instead — the same store behind both.
 *  - The Dependencies view's own element is `focus-picker-trigger`, the one
 *    `e2e/boot/helpers.ts` waits on.
 *  - The list pages are reached through the breadcrumb mega-menu
 *    (`nav-menu` → `nav-<view>`), not through a `link`.
 *
 * Navigate through the REAL UI, never `page.goto` to the target route: a direct
 * `goto` can settle in states the real navigation does not.
 */
import { test, expect, type Page, type Route } from '@playwright/test'
import { gotoView } from './boot/helpers'

const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'

/** The refusal the router actually writes — copied from
 *  `createWorkspaceHttpRouting`, not invented. */
const RETRYABLE_503 = {
  status: 503,
  contentType: 'application/json',
  body: JSON.stringify({ error: 'workspace owner unavailable', retryable: true }),
}

/**
 * Refuse the first `count` routed read-model requests with the router's 503,
 * then let everything through — the shape of a move: a burst of refusals while
 * ownership changes hands, then a healthy new owner.
 *
 * Returns two counters so a test can assert the fault was ACTUALLY injected AND
 * actually absorbed. A spec must not green-light because its interceptor never
 * matched, nor because the page renders its EMPTY state whether or not the
 * read ever succeeded (the landscape a first login creates has no data, so
 * "the page is visible" cannot tell a served read from an abandoned one).
 * `recovered` counts refused URLs
 * that the client asked AGAIN and got a 200 for — the retry, seen on the wire.
 */
async function refuseFirstRoutedReads(page: Page, count: number): Promise<{ refused: () => number; recovered: () => number }> {
  let refused = 0
  const refusedKeys = new Set<string>()
  const recoveredKeys = new Set<string>()
  const keyOf = (rawUrl: string) => { const u = new URL(rawUrl); return u.pathname + u.search }
  page.on('response', (response) => {
    if (response.request().method() !== 'GET' || response.status() !== 200) return
    const key = keyOf(response.url())
    if (refusedKeys.has(key)) recoveredKeys.add(key)
  })
  await page.route('**/api/model/**', async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    if (refused < count) {
      refused += 1
      refusedKeys.add(keyOf(route.request().url()))
      await route.fulfill(RETRYABLE_503)
      return
    }
    await route.continue()
  })
  return { refused: () => refused, recovered: () => recoveredKeys.size }
}

/**
 * The dev-login form is REQUIRED rather than probed: an `isVisible()` guard
 * would swallow its absence and fail 25 s later on an unrelated badge
 * assertion. If this deployment does not serve dev login, this fails here,
 * naming that, instead of blaming the app. The submit button is `disabled`
 * until the legal checkbox is ticked (`LoginPage.tsx`).
 *
 * Landing is the CANVAS, whose durable-state badge is the editor's `#sync-status`
 * (WorkspaceShell's `ws-sync-status` only exists on the list pages).
 */
async function signIn(page: Page): Promise<void> {
  await page.goto('/login')
  await expect(
    page.getByTestId('dev-login-email'),
    'this deployment does not serve the dev-login form — set AUTH dev login on, or point E2E_BASE_URL at one that does',
  ).toBeVisible()
  // The submit is disabled until this is ticked; clicking first would hang on a
  // disabled button and report a timeout rather than a missing precondition.
  const legal = page.getByTestId('legal-acceptance')
  if (await legal.isVisible().catch(() => false)) await legal.check()
  await page.getByTestId('dev-login-email').fill(DEV_EMAIL)
  await page.getByTestId('dev-login-submit').click()
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 45_000, waitUntil: 'domcontentloaded' })
  await expect(page.locator('#sync-status'), 'the canvas and its bottom bar must have rendered').toBeVisible({ timeout: 45_000 })
}

/** WorkspaceShell's badge — only present once a list page is open. */
const shellBadge = (page: Page) => page.getByTestId('ws-sync-status')

test.describe('a workspace move during an open session', () => {
  test('Dependencies survives a burst of retryable refusals and still renders its page', async ({ page }) => {
    await signIn(page)
    const fault = await refuseFirstRoutedReads(page, 2)

    await gotoView(page, 'dependencies')

    // THE PAGE, not a spinner and not an error. `fetchRetryable` should have
    // absorbed both refusals and the third attempt should have served the view.
    await expect(page.getByTestId('focus-picker-trigger')).toBeVisible({ timeout: 30_000 })
    await expect(shellBadge(page)).toBeVisible()
    await expect(page.getByText(/failed|error|HTTP 503/i)).toHaveCount(0)

    // The positivity controls: without the first this passes on a build where
    // the interceptor pattern never matched; without the second it passes on a
    // client that gave up, because an empty landscape renders the same page.
    expect(fault.refused(), 'no request was actually refused — the fault never fired').toBeGreaterThan(0)
    await expect.poll(fault.recovered, { timeout: 15_000, message: 'no refused read was asked again and served — the client did not retry' }).toBeGreaterThan(0)
  })

  test('the badge says Synchronisation… during the refusals and Synced after', async ({ page }) => {
    await signIn(page)
    await gotoView(page, 'model-objects')
    const badge = shellBadge(page)
    await expect(badge).toHaveAttribute('data-status', 'ready', { timeout: 45_000 })

    const fault = await refuseFirstRoutedReads(page, 3)
    await gotoView(page, 'connections')

    // DURING: the badge must not claim Synced while the client is waiting.
    await expect(badge).toHaveAttribute('data-status', 'saving', { timeout: 10_000 })
    // AFTER: and it must come back, or the badge is merely stuck.
    await expect(badge).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
    expect(fault.refused(), 'no request was actually refused').toBeGreaterThan(0)
    // "ready" after the burst must mean RECOVERED, not "gave up and went quiet".
    await expect.poll(fault.recovered, { timeout: 15_000, message: 'the badge came back but no refused read was ever served' }).toBeGreaterThan(0)
  })

  test('a NON-retryable refusal is still surfaced rather than silently retried', async ({ page }) => {
    // The counter-arm. Without it, a client that retried everything would pass
    // both tests above while hiding real server defects behind a delay.
    await signIn(page)
    // Per URL, not a single total: the page issues several distinct reads
    // (tree/children, diagram-render, cache/events, connections/page…), some
    // re-issued by different callers. Retrying is the SAME URL asked again by
    // the client that was refused.
    const served = new Map<string, number>()
    await page.route('**/api/model/**', async (route: Route) => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }
      const url = new URL(route.request().url())
      const key = url.pathname + url.search
      served.set(key, (served.get(key) ?? 0) + 1)
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'internal_error' }),
      })
    })

    await gotoView(page, 'connections')
    // Longer than the whole retry budget's first three backoffs (250 ms · 2^n,
    // full jitter): a retried 500 WOULD show up in this window.
    await page.waitForTimeout(5_000)
    const counts = [...served.entries()].map(([k, v]) => `${v}× ${k}`).join('\n')
    // Positivity first: a page that issued no routed read would pass the bounds
    // below with zero and prove nothing.
    const pageRead = [...served.entries()].filter(([k]) => k.startsWith('/api/model/connections/page'))
    expect(pageRead.length, `the Connections page issued no routed read — the counter-arm never fired\n${counts}`).toBe(1)
    // A 500 carries no contract, so the client must give up at once rather than
    // spending its budget on it: the page's own read is asked exactly ONCE…
    expect(pageRead[0][1], `the page's 500 was retried\n${counts}`).toBe(1)
    // …and no other routed read reaches `maxAttempts` either.
    for (const [key, count] of served) {
      expect(count, `${key} was asked ${count} times on a 500\n${counts}`).toBeLessThan(4)
    }
  })
})
