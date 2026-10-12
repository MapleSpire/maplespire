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
 * WHAT A LIVE TAB DOES WHEN THE DEFAULT VERSION MOVES UNDER IT.
 *
 * `versionId: 'current'` is a moving pointer. An admin repointing a landscape
 * moves it, and every tab following the alias is affected without asking. Two
 * mechanisms answer that, and this spec is the only place they meet a running
 * stack together:
 *
 *  - the SERVER invalidates its route cache and, after a delay that outlasts
 *    every alias cache it cannot reach, asks the sockets bound to the OLD
 *    default to reconnect (`syncCells/defaultVersionRepoint.ts`);
 *  - the BROWSER is told which workspace each socket was bound to, and on a
 *    disagreement either FOLLOWS the move or HOLDS its transport on the version
 *    it was editing (`lib/automerge/workspaceBinding.ts`, `bridge.ts`).
 *
 * ## The discriminant, and what it is against
 *
 * Test 1 fails against a server with no drain, deterministically: nothing else
 * makes a healthy localhost socket fall, so the tab keeps syncing the OLD
 * version and the object created after the repoint lands there. That is the
 * whole reason the drain exists — without it the alias means "the default as of
 * whenever your network last hiccuped".
 *
 * Test 2 is the CONTROL for it. Draining alone would convert a working client
 * into one that can sync nothing (the post-repoint write lost behind a badge
 * reading "Enregistrement…"); it is safe only because the browser can hold.
 * If a change ever makes the drain carry a tab away from unsaved work, test 2
 * goes red and test 1 stays green — which is the pair worth having, since each
 * alone can be satisfied by breaking the other.
 *
 * ## Why the badge is the precondition of test 1, and not decoration
 *
 * "Nothing to lose" is `pendingDurabilityCount() === 0`, which is exactly what
 * `ws-sync-status[data-status=ready]` reports. Asserting it first is not
 * belt-and-braces: on a landscape created in the same session the follow never
 * happens, because that status is a durability LATCH that never reaches
 * `ready` on a brand-new landscape (`TagPerspectiveBar.tsx` says so; measured
 * `unsaved: 1` → `action: 'pin'`). A repoint on such a workspace always HOLDS. That is the
 * safe direction — it never discards work — but it is a real limit, and a test
 * that did not state its precondition would have blamed the drain for it.
 *
 * ## How test 2 keeps a CONNECTED tab holding unsaved work
 *
 * A connected tab is durable within milliseconds, so the state this arm needs
 * looks impossible to hold open. It is not: a document leaves `durableHeads`
 * only when the server answers `durable:true` for the exact frontier that was
 * sent, so blocking that one endpoint suspends the acknowledgement while the
 * sync socket stays healthy and the write itself still reaches the server. The
 * drain is therefore the trigger in BOTH arms, and the only difference between
 * them is what the tab has to lose.
 *
 * Both tests repoint the landscape THE SESSION LANDED ON, read off the router's
 * URL, onto a FORK of its current default — the promoted-draft gesture, and a
 * superset of what it replaces, so later suites see an equivalent workspace.
 * `repoint-offline-create.spec.ts` already leaves the stack that way for the
 * same reason. The landscape is read rather than named because the tab and the
 * repoint have to address the same one, and a constant cannot guarantee that:
 * if the session lands elsewhere, the run measures a workspace no socket is
 * following.
 *
 * ## Running it
 *
 * Against an isolated import-volume stack (see scripts/dev-boot.mjs for the isolation env vars):
 *
 *   E2E_BOOT_URL=http://localhost:5199 E2E_BOOT_API=http://localhost:3099 \
 *     npx playwright test --project=boot e2e/boot/repoint-live-tab.spec.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { test, expect, type Page } from '@playwright/test'
import { flushLocal, gotoModelObjects, moAddTopLevel } from './helpers.js'

const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3099'
const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'

/** The server's residual delay plus the reconnect, the binding frame and a
 * workspace reload. Deliberately NOT derived from the server constant: a bound
 * computed from the value under test agrees with whatever that value is given. */
const FOLLOW_TIMEOUT_MS = 60_000

interface Workspace { landscapeId: string; versionId: string }

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
    await page.waitForURL('**/app/**', { timeout: 30_000 })
  }
  await page.waitForFunction(
    () => Array.isArray((window as any).__modelStore?.getState?.().diagrams),
    undefined,
    { timeout: 45_000 },
  )
}

/**
 * The workspace THIS TAB is on, read off the router's own URL.
 *
 * Named rather than configured, because the two have to be the same landscape
 * and a constant cannot guarantee it: with an id from an env var, the session
 * can land on a different landscape and the detector's basis reads null for a
 * workspace no socket is following — a test measuring nothing, and reporting
 * it as a failure of the code under test.
 */
function tabWorkspace(page: Page): { landscapeId: string; versionSegment: string } {
  const parts = new URL(page.url()).pathname.split('/')
  // /app/landscape/<landscapeId>/version/<versionId>/…
  expect(parts[2], `unexpected route shape: ${page.url()}`).toBe('landscape')
  expect(parts[4], `unexpected route shape: ${page.url()}`).toBe('version')
  return { landscapeId: parts[3], versionSegment: parts[5] }
}

/** The tab must be following the ALIAS, or there is nothing here to move: a
 * concrete ref names its own version and the browser's detector early-returns
 * on it by design. */
function aliasLandscape(page: Page): string {
  const { landscapeId, versionSegment } = tabWorkspace(page)
  expect(
    versionSegment,
    'this tab is pinned to a concrete version, so no repoint can move it — the scenario '
    + 'this spec exists for requires a session on the `current` alias',
  ).toBe('current')
  return landscapeId
}

async function defaultVersionId(page: Page, landscapeId: string): Promise<string> {
  const response = await page.request.get(`${API_BASE}/api/landscapes`)
  expect(response.ok(), `GET /api/landscapes -> ${response.status()}`).toBe(true)
  const body = (await response.json()) as any
  const list: any[] = Array.isArray(body) ? body : (body.landscapes ?? [])
  const found = list.find((l) => l.id === landscapeId)
  expect(found?.defaultVersionId, `landscape ${landscapeId} should name a default version`).toBeTruthy()
  return found.defaultVersionId as string
}

/**
 * FORK and SET-DEFAULT are separate on purpose, and the order is load-bearing.
 *
 * A fork COPIES. Doing both after the tab has written something means the new
 * version contains that write, and "the held work must not appear in the version
 * the tab refused to follow" then reads `present` — which looks like a
 * durability defect but is a snapshot taken too late. Fork
 * FIRST, so the snapshot predates the work; promote afterwards. That is also the
 * realistic gesture: a draft branched earlier, promoted later.
 *
 * Both go through `page.request`, which shares the context's cookies and is NOT
 * intercepted by `page.route` — so an operator can act while the page's own
 * requests are being blocked, which is exactly the real scenario.
 */
async function fork(page: Page, landscapeId: string, from: string): Promise<string> {
  const response = await page.request.post(`${API_BASE}/api/landscapes/${landscapeId}/versions`, {
    data: { label: `e2e-live-repoint-${Date.now().toString(36)}`, forkFromVersionId: from },
  })
  expect(response.ok(), `fork -> ${response.status()}`).toBe(true)
  const to = ((await response.json()) as { version: { id: string } }).version.id
  expect(to, 'the fork must be a different version').not.toBe(from)
  return to
}

async function setDefaultVersion(page: Page, landscapeId: string, versionId: string): Promise<void> {
  const response = await page.request.put(`${API_BASE}/api/landscapes/${landscapeId}/default-version`, {
    data: { versionId },
  })
  expect(response.ok(), `set-default -> ${response.status()}`).toBe(true)
}

/** Fork the current default and promote it in one gesture — for the arm where
 * nothing has been written in between and the order cannot matter. */
async function repoint(page: Page, landscapeId: string, from: string): Promise<string> {
  const to = await fork(page, landscapeId, from)
  await setDefaultVersion(page, landscapeId, to)
  return to
}

/**
 * Is an object durable in ONE named workspace?
 *
 * The version is passed explicitly rather than left to the page's own params:
 * this question is asked about the workspace the tab is NOT on, and a query
 * that inherited the tab's params could not tell the two apart.
 */
type Presence = 'present' | 'absent' | 'unknown'

async function objectPresence(page: Page, id: string, ws: Workspace): Promise<Presence> {
  // `page.request`, NOT an in-page `fetch`. The API is a different ORIGIN from
  // the app under this stack, so a plain fetch sends no session cookie and
  // answers 401 for everything — a witness that can only ever say "absent",
  // which makes every negative assertion built on it vacuous rather than red.
  // Measured: it reported the object missing from the workspace the tab had
  // just written it to, while the read model held it.
  const query = new URLSearchParams({ landscapeId: ws.landscapeId, versionId: ws.versionId })
  const response = await page.request.get(
    `${API_BASE}/api/model/object/${encodeURIComponent(id)}?${query.toString()}`,
  )
  if (response.status() === 200) return ((await response.json()) as any).object ? 'present' : 'absent'
  if (response.status() === 404) return 'absent'
  // THREE values on purpose. A freshly forked version has no resident
  // projector until something asks for it, and the endpoint answers 503 —
  // measured here, on the version the tab had just refused to follow. Folding
  // that into `absent` would turn "I cannot see" into "there is nothing there",
  // which is the same two-valued mistake the sync-cell fence made, and it would
  // make the negative assertion below pass for the wrong reason.
  return 'unknown'
}

/** What the browser's detector currently believes, from the hook the module
 * installs on itself (a dynamic import can resolve to a different instance
 * after an HMR pass — measured, and it read the detector as unarmed when it was
 * not). */
function bindingProbe(page: Page, landscapeId: string) {
  return page.evaluate((lid) => {
    const probe = (window as any).__workspaceBinding
    if (!probe) throw new Error('__workspaceBinding absent — this build is not a DEV build')
    return {
      framesSeen: probe.framesSeen() as number,
      lastBinding: probe.lastBinding() as Workspace | null,
      basis: probe.basisFor({ landscapeId: lid, versionId: 'current' }) as Workspace | null,
      held: probe.held() as Workspace | null,
    }
  }, landscapeId)
}

/**
 * Hold this tab's work in the "authored, not yet durable" state — while its
 * sync socket stays perfectly healthy.
 *
 * A document leaves `durableHeads` only when the server answers `durable:true`
 * for the exact frontier that was sent (`bridge.ts`), so blocking that one
 * endpoint keeps `pendingDurabilityCount() > 0` for as long as we like. Nothing
 * else is affected: the write itself travels over the WebSocket and is durable
 * server-side, which is what lets the same test assert both "this tab has
 * something to lose" and "the work is safe in the version it is held on".
 *
 * The obvious alternative does NOT work, and the run that used it looked green
 * on a precondition it had never established: `page.routeWebSocket` applies to
 * sockets opened AFTER it is installed, so calling it mid-session leaves the
 * live socket untouched and the write reaches the server immediately.
 */
async function blockDurableAcknowledgement(page: Page): Promise<void> {
  await page.route('**/api/automerge/durable-heads*', (route) => route.abort('connectionfailed'))
}

async function allowDurableAcknowledgement(page: Page): Promise<void> {
  await page.unroute('**/api/automerge/durable-heads*')
}

test.describe.configure({ mode: 'serial' })

test.describe('a default version that moves under a live tab', () => {
  test('is followed by a tab with nothing to lose, without a page reload', async ({ page }) => {
    await signIn(page)
    await gotoModelObjects(page)

    // THE PRECONDITION, user-visible: the badge says everything is durable, so
    // this tab has nothing to strand. Without it the tab would legitimately
    // hold and this test would blame the drain — see the header.
    await expect(page.getByTestId('ws-sync-status')).toHaveAttribute('data-status', 'ready', {
      timeout: 120_000,
    })

    const LANDSCAPE = aliasLandscape(page)
    const v1 = await defaultVersionId(page, LANDSCAPE)
    // The detector has to be armed BEFORE the move, or the first binding frame
    // is adopted as the basis and the move goes unnoticed by construction.
    await expect
      .poll(async () => (await bindingProbe(page, LANDSCAPE)).basis?.versionId ?? null, { timeout: 60_000 })
      .toBe(v1)

    // A witness that this tab was never reloaded. A page reload would reach the
    // new default for reasons that have nothing to do with the drain, and would
    // make this test pass against a server that does not drain at all.
    await page.evaluate(() => { (window as any).__liveTabSentinel = 'alive' })

    const v2 = await repoint(page, LANDSCAPE, v1)

    // The follow completes when the tab's own comparison basis has become the
    // new version: the socket fell, came back on V2, the browser saw the
    // disagreement, found nothing pending and reloaded the workspace in place.
    await expect
      .poll(async () => (await bindingProbe(page, LANDSCAPE)).basis?.versionId ?? null, {
        timeout: FOLLOW_TIMEOUT_MS,
      })
      .toBe(v2)

    expect(
      await page.evaluate(() => (window as any).__liveTabSentinel ?? null),
      'the tab must have followed IN PLACE — a lost sentinel means the document reloaded, '
      + 'and a reload reaches the new default whether or not the server drains',
    ).toBe('alive')

    // Nothing was at stake, so nothing is held and the user is told nothing.
    expect((await bindingProbe(page, LANDSCAPE)).held).toBeNull()
    await expect(page.getByTestId('workspace-repoint-banner')).toHaveCount(0)

    // The property a user would state: work done after the move lands in the
    // version they were moved to.
    await gotoModelObjects(page)
    const objectId = await moAddTopLevel(page, 'system')
    // The quick-add pushes into the store; the write path is debounced. Without
    // this the run measured a read model that had simply not been written to
    // yet, and read as a lost write.
    await flushLocal(page)
    await expect
      .poll(() => objectPresence(page, objectId, { landscapeId: LANDSCAPE, versionId: v2 }), {
        timeout: 90_000,
      })
      .toBe('present')
    // Polled to a DEFINITE answer rather than read once: `unknown` is the third
    // value and it must not be allowed to satisfy an absence claim.
    await expect
      .poll(() => objectPresence(page, objectId, { landscapeId: LANDSCAPE, versionId: v1 }), {
        timeout: 60_000,
      })
      .toBe('absent')
  })

  test('is NOT followed by a tab holding unsaved work — it is held, and says so', async ({ page }) => {
    await signIn(page)
    await gotoModelObjects(page)
    await expect(page.getByTestId('ws-sync-status')).toHaveAttribute('data-status', 'ready', {
      timeout: 120_000,
    })

    const LANDSCAPE = aliasLandscape(page)
    const v1 = await defaultVersionId(page, LANDSCAPE)
    await expect
      .poll(async () => (await bindingProbe(page, LANDSCAPE)).basis?.versionId ?? null, { timeout: 60_000 })
      .toBe(v1)

    // The snapshot is taken BEFORE the work exists, so the absence assertion
    // below is about this tab's write and not about when the copy was made.
    const v2 = await fork(page, LANDSCAPE, v1)

    // Now give this tab something to lose, without touching its socket.
    await blockDurableAcknowledgement(page)
    const objectId = await moAddTopLevel(page, 'system')
    // The quick-add pushes into the store; the write path is debounced. Without
    // this the run measured a read model that had simply not been written to
    // yet, and read as a lost write.
    await flushLocal(page)
    await expect(page.getByTestId('ws-sync-status')).not.toHaveAttribute('data-status', 'ready', {
      timeout: 30_000,
    })

    // The repoint now lands on a tab that is CONNECTED and holding unsaved
    // work: the drain is what reaches it, and the hold is what answers.
    await setDefaultVersion(page, LANDSCAPE, v2)

    // The tab is held on the version it was editing, and the address bar still
    // says `current` — the hold moves the TRANSPORT, never the reference. Moving
    // the reference would lose the very work it exists to protect: the intent
    // journals are keyed by the ref.
    await expect
      .poll(async () => (await bindingProbe(page, LANDSCAPE)).held?.versionId ?? null, { timeout: 90_000 })
      .toBe(v1)
    expect(page.url()).toContain('/version/current')
    await expect(page.getByTestId('workspace-repoint-banner')).toBeVisible({ timeout: 30_000 })

    // And the work is DURABLE where the tab is, not merely still on screen.
    await expect
      .poll(() => objectPresence(page, objectId, { landscapeId: LANDSCAPE, versionId: v1 }), {
        timeout: 90_000,
      })
      .toBe('present')
    // The version the tab refused to follow has no resident projector until
    // something asks, so this one genuinely starts at `unknown` — poll it to a
    // definite answer instead of reading a 503 as an absence.
    await expect
      .poll(() => objectPresence(page, objectId, { landscapeId: LANDSCAPE, versionId: v2 }), {
        timeout: 60_000,
      })
      .toBe('absent')

    // The banner is the user's way out, and taking it must not cost the work.
    // The acknowledgement is restored first: the interesting question is what
    // the button does for a user whose situation has recovered, not what it
    // does while the endpoint is still down.
    await allowDurableAcknowledgement(page)
    await page.getByTestId('workspace-repoint-follow').click()
    await expect
      .poll(async () => (await bindingProbe(page, LANDSCAPE)).basis?.versionId ?? null, { timeout: 90_000 })
      .toBe(v2)
    await expect
      .poll(() => objectPresence(page, objectId, { landscapeId: LANDSCAPE, versionId: v1 }), {
        timeout: 60_000,
      })
      .toBe('present')
  })
})
