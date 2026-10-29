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

import { test, expect, type Page } from '@playwright/test'
import { submitDevLogin } from './support/devLogin'
import { waitForWorkspaceProjected } from './support/workspaceReady'

/**
 * `workspaceStore.newVersion` + `workspaceStore.makeDefault`, driven through the
 * REAL workspace menu.
 *
 * These are two of the six paths whose navigation is now AWAITED INSIDE the
 * `busy` guard. Three shipped regressions are pinned here, each of which a
 * 2000-test vitest suite could not see:
 *
 *  1. `eacf4d51` — `createVersion` omitting `{shardedModel: true}` left the new
 *     version with no durable home for objects. Everything looked right until a
 *     RELOAD, which came back with the diagrams and none of the shapes. Every
 *     flow below therefore WRITES into the version it just created and reloads.
 *  2. `844402fe` — releasing `busy` before the URL moved made every switch really
 *     three (WorkspaceRoute read the stale URL against the already-new live ref
 *     and bounced the workspace back). Witnessed here two ways: an in-page probe
 *     that asserts the store's ref and the address bar never disagree at the
 *     instant `busy` goes false, and a socket/console ledger that must show
 *     EXACTLY ONE `[switchWorkspace]`-worth of churn per action.
 *  3. `ade9ce1f` — a bare-default document resolution re-routed the live sync
 *     socket onto `landscapeId=default`. No automerge socket in these runs may
 *     ever carry that landscape: each test signs in as a brand-new dev user, so
 *     its org's landscape id is always a generated one.
 *
 * Nothing here drives a store action. The stores are READ (never written) for
 * the ordering probe; every mutation goes through the menu, the table and the
 * address bar the user actually uses.
 */

test.use({ channel: process.env.PW_BROWSER_CHANNEL || undefined })

// ── ledgers ──────────────────────────────────────────────────────────────────

interface SocketOpen {
  url: string
  landscapeId: string | null
  versionId: string | null
}

interface Probe {
  /** Every automerge socket the page opened, in order, since before `goto`. */
  sockets: SocketOpen[]
  /** Every `[switchWorkspace] <lid>/<vid> in Nms` the bridge logged. */
  switches: string[]
  /** The landscape the address bar named once sign-in landed (see expectNeverDefaultScoped). */
  homeLandscapeId?: string
  /** Socket indices a verified, requested switch into a landscape named `default` opened. */
  requestedDefault: Set<number>
}

/**
 * Socket recorder.
 *
 * Deliberately `page.on('websocket')` rather than an `addInitScript` monkey-patch
 * of `window.WebSocket`: this hooks the browser's real socket layer, so it cannot
 * be defeated by app code, AND — the reason that matters here — its ledger
 * SURVIVES `page.reload()`. An in-page array does not, and these flows reload
 * between the action and the assertion.
 */
function attachProbe(page: Page): Probe {
  const probe: Probe = { sockets: [], switches: [], requestedDefault: new Set() }
  page.on('websocket', (socket) => {
    const url = socket.url()
    if (!url.includes('/automerge')) return // Vite HMR and friends
    let landscapeId: string | null = null
    let versionId: string | null = null
    try {
      const parsed = new URL(url.replace(/^ws/, 'http'))
      landscapeId = parsed.searchParams.get('landscapeId')
      versionId = parsed.searchParams.get('versionId')
    } catch {
      /* unparseable — the raw url still lands in the failure message */
    }
    probe.sockets.push({ url, landscapeId, versionId })
  })
  page.on('console', (message) => {
    const text = message.text()
    if (text.includes('[switchWorkspace]')) probe.switches.push(text)
  })
  return probe
}

const routeKey = (s: SocketOpen): string => `${s.landscapeId}/${s.versionId}`

function mark(probe: Probe): { sockets: number; switches: number } {
  return { sockets: probe.sockets.length, switches: probe.switches.length }
}

/**
 * The whole point of awaiting navigation inside the `busy` guard: ONE new socket,
 * scoped to the workspace actually entered. A `busy`-ordering bounce shows up as
 * a second (and third) socket at a different route key, and as extra
 * `[switchWorkspace]` lines.
 */
async function expectSingleScopedSwitch(
  page: Page,
  probe: Probe,
  since: { sockets: number; switches: number },
  expected: { landscapeId: string; versionId: string },
  what: string,
): Promise<void> {
  const key = `${expected.landscapeId}/${expected.versionId}`
  await expect
    .poll(() => probe.sockets.length, { timeout: 60_000, message: `${what}: no new automerge socket opened` })
    .toBeGreaterThan(since.sockets)
  // A bounce is a SECOND switch a beat later — give it time to appear before
  // concluding "exactly one".
  await page.waitForTimeout(2_000)
  expect(probe.sockets.slice(since.sockets).map(routeKey), `${what}: automerge sockets opened`).toEqual([key])
  expect(probe.switches.slice(since.switches), `${what}: [switchWorkspace] log lines`).toEqual([
    expect.stringContaining(`] ${key} in `),
  ])
  // A switch the spec ASKED for, into a landscape that is really named
  // `default`, accounts for exactly the one socket just verified above.
  if (expected.landscapeId === 'default') probe.requestedDefault.add(since.sockets)
}

/**
 * Regression 3's direct witness.
 *
 * At AUTH=on the session's home is a fresh org's GENERATED landscape, so every
 * `default` socket is a tear. At AUTH=off (dev:local) the app boots into the
 * legacy workspace whose landscape id IS `default`. Two kinds of `default`
 * socket are then the session's own, not a tear: the LEADING run, opened before
 * the spec entered its own landscape (every flow here leaves at its first step,
 * `createLandscape`), and a socket `expectSingleScopedSwitch` verified as the
 * one a requested switch to `default` opened. Every other one is a witness.
 */
function expectNeverDefaultScoped(probe: Probe, what: string): void {
  const firstElsewhere = probe.sockets.findIndex((s) => s.landscapeId !== 'default')
  const homeRun = probe.homeLandscapeId === 'default' ? (firstElsewhere < 0 ? probe.sockets.length : firstElsewhere) : 0
  const witnesses = probe.sockets.filter((_, index) => index >= homeRun && !probe.requestedDefault.has(index))
  expect(
    witnesses.filter((s) => s.landscapeId === 'default').map((s) => s.url),
    `${what}: sockets routed at landscapeId=default`,
  ).toEqual([])
}

// ── busy-guard ordering probe (in-page, read-only) ───────────────────────────

interface OrderViolation {
  path: string
  ref: { landscapeId: string; versionId: string }
}

/**
 * The DIRECT assertion for `844402fe`.
 *
 * `workspaceStore` releases `busy` and publishes the new `ref` in a single write,
 * and it must do that only AFTER the address bar has moved. So: subscribe to the
 * store and, on every state write where `busy` is false, compare the live
 * `location.pathname` against the ref being published. Reading the pathname from
 * inside the subscriber is what makes this exact — it samples at the instant of
 * the write, which no Playwright-side poll can hit reliably.
 *
 * Under the old ordering (`set({busy:false})` first, `void navigate()` after) the
 * pathname still names the PREVIOUS version at that instant → a violation is
 * recorded. That window is exactly what let WorkspaceRoute bounce the workspace.
 *
 * Read-only: `subscribe` observes, it does not drive. Must be re-installed after
 * every reload.
 */
async function installOrderProbe(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __routeStores?: unknown }).__routeStores === 'function',
    undefined,
    { timeout: 60_000 },
  )
  await page.evaluate(async () => {
    interface Snapshot { busy: boolean; ref: { landscapeId: string; versionId: string } }
    const w = window as unknown as {
      __routeStores: () => Promise<{ workspace: { subscribe: (fn: (s: Snapshot) => void) => () => void } }>
      __wsOrderUnsub?: () => void
      __wsOrderViolations?: unknown[]
    }
    w.__wsOrderUnsub?.()
    w.__wsOrderViolations = []
    const { workspace } = await w.__routeStores()
    w.__wsOrderUnsub = workspace.subscribe((state) => {
      if (state.busy) return
      const found = location.pathname.match(/\/app\/landscape\/([^/]+)\/version\/([^/]+)/)
      // No workspace segment yet (bare `/app`, pre-boot) — nothing to disagree with.
      if (!found) return
      if (found[1] !== state.ref.landscapeId || found[2] !== state.ref.versionId) {
        w.__wsOrderViolations!.push({ path: location.pathname, ref: { ...state.ref } })
      }
    })
  })
}

async function expectNoOrderViolation(page: Page, what: string): Promise<void> {
  const violations = await page.evaluate(
    () => ((window as unknown as { __wsOrderViolations?: OrderViolation[] }).__wsOrderViolations ?? []) as OrderViolation[],
  )
  expect(violations, `${what}: store ref published while the URL still named another workspace`).toEqual([])
}

// ── UI helpers (every one of these drives the real chrome) ───────────────────

const WS_URL_RE = /\/app\/landscape\/[^/]+\/version\/[^/]+/

function refFromUrl(url: string): { landscapeId: string; versionId: string } | null {
  const found = new URL(url).pathname.match(/\/app\/landscape\/([^/]+)\/version\/([^/]+)/)
  return found ? { landscapeId: found[1], versionId: found[2] } : null
}

function currentRef(page: Page): { landscapeId: string; versionId: string } {
  const ref = refFromUrl(page.url())
  expect(ref, `the address bar does not name a workspace: ${page.url()}`).not.toBeNull()
  return ref!
}

async function signIn(page: Page, probe: Probe, tag: string): Promise<void> {
  await page.goto('/app')
  const devLogin = page.getByTestId('dev-login-email')
  // The sign-in redirect lands a tick or more after `load`, so a bare
  // `isVisible()` here reads the page BEFORE it has decided — wait for whichever
  // of the two outcomes arrives (login form at AUTH=on, workspace URL at off).
  await Promise.race([
    devLogin.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => null),
    page.waitForURL(WS_URL_RE, { timeout: 45_000 }).catch(() => null),
  ])
  if (await devLogin.isVisible().catch(() => false)) {
    // A fresh address every run = a fresh personal org with a GENERATED landscape
    // id. That is what makes "no socket carries landscapeId=default" meaningful,
    // and it keeps this spec off the landscapes the other suites are editing.
    await submitDevLogin(page, `e2e-ws-versions-${tag}-${Date.now().toString(36)}@example.com`)
  }
  await page.waitForURL(WS_URL_RE, { timeout: 90_000 })
  probe.homeLandscapeId = currentRef(page).landscapeId
  await installOrderProbe(page)
}

async function openNavMenu(page: Page): Promise<void> {
  const anchor = page.getByTestId('workspace-landscapes')
  if (await anchor.isVisible().catch(() => false)) return
  await page.getByTestId('nav-menu').click()
  await expect(anchor).toBeVisible()
}

/**
 * Expand one of the mega-menu's two workspace panels.
 *
 * The toggle is a TOGGLE — clicking it on an already-open panel collapses it —
 * and the menu is left open by some actions and closed by others, so this drives
 * to the wanted state rather than assuming one.
 */
async function openWorkspacePanel(page: Page, which: 'landscape' | 'version'): Promise<void> {
  const toggle = which === 'version' ? 'workspace-versions' : 'workspace-landscapes'
  const anchor =
    which === 'version' ? page.getByTestId('version-follow-default') : page.getByTestId('new-landscape-name')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await anchor.isVisible().catch(() => false)) return
    await openNavMenu(page)
    if (await anchor.isVisible().catch(() => false)) return
    await page.getByTestId(toggle).click()
    const opened = await anchor
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
    if (opened) return
  }
  await expect(anchor).toBeVisible()
}

const openVersionPanel = (page: Page): Promise<void> => openWorkspacePanel(page, 'version')
const openLandscapePanel = (page: Page): Promise<void> => openWorkspacePanel(page, 'landscape')

async function navigateTo(page: Page, link: 'nav-model-objects' | 'nav-diagrams'): Promise<void> {
  await openNavMenu(page)
  const target = page.getByTestId(link)
  if (!(await target.isVisible().catch(() => false))) {
    await page.getByTestId('nav-menu').click()
    await expect(target).toBeVisible()
  }
  await target.click()
}

async function gotoModelObjects(page: Page): Promise<void> {
  if (!(await page.getByTestId('mo-table-scroll').isVisible().catch(() => false))) {
    await navigateTo(page, 'nav-model-objects')
  }
  await expect(page.getByTestId('mo-table-scroll')).toBeVisible({ timeout: 60_000 })
}

async function gotoDiagrams(page: Page): Promise<void> {
  await navigateTo(page, 'nav-diagrams')
  await expect(page).toHaveURL(/\/diagrams$/, { timeout: 60_000 })
}

/**
 * Block until the LIVE workspace has finished loading.
 *
 * Gates on `projectedWorkspace` (the bridge session that FINISHED booting, by
 * workspace identity), never on the sync badge's 'ready' — see
 * e2e/support/workspaceReady.ts for why the latter both lies and hangs on the
 * freshly created landscapes/versions this file lives on. Without a
 * workspace-identified gate, "the new version is empty" is also satisfied by the
 * store cleared mid-switch: a false PASS nothing downstream recovers.
 */
async function waitForWorkspaceReady(page: Page): Promise<void> {
  await waitForWorkspaceProjected(page)
}

/** The bridge's write debounce + flush, so a switch or reload can't beat it. */
async function settleWrites(page: Page): Promise<void> {
  await page.waitForTimeout(1_500)
  await waitForWorkspaceReady(page)
}

/** Create a landscape through the menu and return the id the app entered. */
async function createLandscape(page: Page, name: string): Promise<string> {
  const before = currentRef(page).landscapeId
  await openLandscapePanel(page)
  await page.getByTestId('new-landscape-name').fill(name)
  await page.getByTestId('new-landscape-add').click()
  await page.waitForURL((url) => refFromUrl(url.toString())?.landscapeId !== before && WS_URL_RE.test(url.pathname), {
    timeout: 90_000,
  })
  const created = currentRef(page).landscapeId
  createdLandscapes.push(created)
  return created
}

async function addModelObject(page: Page, type: 'system' | 'store' | 'actor'): Promise<string> {
  await gotoModelObjects(page)
  // Adding into a workspace that has not finished loading is the silent no-op
  // that made `844402fe` invisible — never write before the gate is open.
  await waitForWorkspaceReady(page)
  await page.getByTestId('mo-add-object').click()
  await page.getByTestId(`mo-add-${type}`).click()
  // Object names are user data ("New system"), not translated chrome.
  const row = page.getByRole('row', { name: new RegExp(`New ${type}`) }).last()
  await expect(row).toBeVisible({ timeout: 30_000 })
  const testid = await row.getAttribute('data-testid')
  expect(testid, `the new ${type} row carries no mo-row-<id> testid`).toBeTruthy()
  return testid!.replace('mo-row-', '')
}

/** The model objects the CURRENT workspace shows, asserted by identity. */
async function expectObjects(
  page: Page,
  present: string[],
  absent: string[],
  what: string,
): Promise<void> {
  await gotoModelObjects(page)
  await waitForWorkspaceReady(page)
  for (const id of present) {
    await expect(page.getByTestId(`mo-row-${id}`), `${what}: ${id} should be here`).toBeVisible({ timeout: 60_000 })
  }
  // Counted, not just "the wanted ones are present": a leak from another version
  // would otherwise pass silently.
  await expect
    .poll(
      () => page.getByTestId('mo-table-scroll').getAttribute('data-loaded-row-count').catch(() => null),
      { timeout: 60_000, message: `${what}: row count` },
    )
    .toBe(String(present.length))
  for (const id of absent) {
    await expect(page.getByTestId(`mo-row-${id}`), `${what}: ${id} must NOT be here`).toHaveCount(0)
  }
}

async function versionIds(page: Page): Promise<string[]> {
  await openVersionPanel(page)
  const rows = page.locator('[data-testid^="version-row-"]')
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  return (await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-testid')!.replace('version-row-', '')),
  )) as string[]
}

// ── cleanup ledger ───────────────────────────────────────────────────────────
//
// Every landscape/version these tests create must be gone at the end, on failure
// as well as success: a leftover workspace is a resident projector and an extra
// row in every later run's registry, and that is exactly how the NEXT run starts
// lying. Deletes go over REST with the page's own session cookie; the API origin
// is LEARNED from the app's traffic rather than guessed, because the app talks to
// VITE_SYNC_API_URL, not the page origin.

const createdLandscapes: string[] = []
let cleanupApiUrl: ((path: string) => string) | null = null

function trackApiOrigin(page: Page): (path: string) => string {
  let origin: string | null = null
  page.on('request', (request) => {
    if (origin) return
    try {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) origin = url.origin
    } catch {
      /* ws:/data: — not an API call */
    }
  })
  return (path: string) => `${origin ?? ''}${path}`
}

test.beforeEach(() => {
  createdLandscapes.length = 0
  cleanupApiUrl = null
})

test.afterEach(async ({ page }) => {
  const apiUrl = cleanupApiUrl
  if (!apiUrl) return
  // Deleting the landscape cascades its versions, so the versions these tests
  // create need no separate pass. The last-landscape guard (409) is expected for
  // whichever landscape the org was provisioned with — we never created it, and
  // it is not in this list.
  for (const id of createdLandscapes) {
    try {
      await page.context().request.delete(`${apiUrl(`/api/landscapes/${encodeURIComponent(id)}`)}`)
    } catch {
      /* best effort — never fail a run on teardown */
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────

test.describe('workspace versions — newVersion + makeDefault', () => {
  test('a from-scratch version is entered once, is writable, and survives a reload', async ({ page }) => {
    test.setTimeout(300_000)
    const probe = attachProbe(page)
    cleanupApiUrl = trackApiOrigin(page)
    await signIn(page, probe, 'new')

    // ── a landscape with REAL content, so there is something to lose ──────────
    const landscapeId = await createLandscape(page, `e2e-newversion-${Date.now().toString(36)}`)
    const systemId = await addModelObject(page, 'system')
    const storeId = await addModelObject(page, 'store')
    await settleWrites(page)

    // Baseline: the seed is durable BEFORE any version work. Without this, a
    // later "the fork is empty" reading could just be a seed that never landed.
    await page.reload()
    await installOrderProbe(page)
    await expectObjects(page, [systemId, storeId], [], 'seeded landscape after reload')

    const [mainVersionId] = await versionIds(page)
    expect(mainVersionId, 'a fresh landscape should have exactly one version').toBeTruthy()

    // ── new version (createEmptyRoot branch) ────────────────────────────────
    const since = mark(probe)
    await openVersionPanel(page)
    await page.getByTestId('new-version-label').fill('e2e-scratch')
    await page.getByTestId('new-version-add').click()
    await page.waitForURL(
      (url) => {
        const ref = refFromUrl(url.toString())
        return !!ref && ref.landscapeId === landscapeId && ref.versionId !== 'current' && ref.versionId !== mainVersionId
      },
      { timeout: 90_000 },
    )
    const newVersionId = currentRef(page).versionId

    await expectSingleScopedSwitch(page, probe, since, { landscapeId, versionId: newVersionId }, 'newVersion')
    await expectNoOrderViolation(page, 'newVersion')
    expectNeverDefaultScoped(probe, 'newVersion')

    // ── it is a DIFFERENT workspace: the source's objects are not in it ──────
    // Not an empty-equals-empty assertion: the two ids asserted absent are the
    // two that were just proved present in the sibling version.
    await expectObjects(page, [], [systemId, storeId], 'from-scratch version')

    // ── and it is usable: exactly the one starter diagram, and it takes a write
    await gotoDiagrams(page)
    await expect
      .poll(() => page.locator('[data-testid^="diagram-card-"]').count(), { timeout: 60_000 })
      .toBe(1)

    const actorId = await addModelObject(page, 'actor')
    await settleWrites(page)

    // `eacf4d51`'s only witness: the write must still be there after a reload.
    await page.reload()
    await installOrderProbe(page)
    await expect(page).toHaveURL(new RegExp(`/app/landscape/${landscapeId}/version/${newVersionId}`))
    await expectObjects(page, [actorId], [systemId, storeId], 'from-scratch version after reload')

    // ── back to the original version: its content is intact and unmixed ──────
    const sinceBack = mark(probe)
    await openVersionPanel(page)
    const mainRow = page.getByTestId(`version-row-${mainVersionId}`)
    await mainRow.hover()
    await mainRow.getByTestId('version-switch').click({ force: true })
    await page.waitForURL(
      (url) => refFromUrl(url.toString())?.versionId === mainVersionId,
      { timeout: 90_000 },
    )
    await expectSingleScopedSwitch(page, probe, sinceBack, { landscapeId, versionId: mainVersionId }, 'switch back')
    await expectObjects(page, [systemId, storeId], [actorId], 'original version after round trip')
    await expectNoOrderViolation(page, 'switch back')
    expectNeverDefaultScoped(probe, 'end of run')
  })

  test('a forked version carries the source content and is an independent copy', async ({ page }) => {
    test.setTimeout(300_000)
    const probe = attachProbe(page)
    cleanupApiUrl = trackApiOrigin(page)
    await signIn(page, probe, 'fork')

    const landscapeId = await createLandscape(page, `e2e-forkversion-${Date.now().toString(36)}`)
    const systemId = await addModelObject(page, 'system')
    const storeId = await addModelObject(page, 'store')
    await settleWrites(page)
    // The fork happens SERVER-side from the source's root url, so the source's
    // writes must be durable before duplicating — otherwise a green "the fork is
    // empty" would only mean the seed had not landed yet.
    await page.reload()
    await installOrderProbe(page)
    await expectObjects(page, [systemId, storeId], [], 'source version')

    const [mainVersionId] = await versionIds(page)
    await gotoDiagrams(page)
    await expect
      .poll(() => page.locator('[data-testid^="diagram-card-"]').count(), {
        timeout: 60_000,
        message: 'the source version never listed a diagram',
      })
      .toBeGreaterThan(0)
    const sourceDiagrams = await page.locator('[data-testid^="diagram-card-"]').count()

    // ── duplicate (forkRoot branch — NOT the branch eacf4d51 touched) ────────
    const since = mark(probe)
    await openVersionPanel(page)
    const sourceRow = page.getByTestId(`version-row-${mainVersionId}`)
    await sourceRow.hover()
    await sourceRow.getByTestId('version-duplicate').click({ force: true })
    await page.waitForURL(
      (url) => {
        const ref = refFromUrl(url.toString())
        return !!ref && ref.landscapeId === landscapeId && ref.versionId !== 'current' && ref.versionId !== mainVersionId
      },
      { timeout: 120_000 },
    )
    const forkId = currentRef(page).versionId

    await expectSingleScopedSwitch(page, probe, since, { landscapeId, versionId: forkId }, 'duplicate version')
    await expectNoOrderViolation(page, 'duplicate version')
    expectNeverDefaultScoped(probe, 'duplicate version')

    // ── the fork carries the SOURCE's content, by object identity ────────────
    await expectObjects(page, [systemId, storeId], [], 'fork')
    await gotoDiagrams(page)
    await expect
      .poll(() => page.locator('[data-testid^="diagram-card-"]').count(), { timeout: 60_000 })
      .toBe(sourceDiagrams)

    await page.reload()
    await installOrderProbe(page)
    await expect(page).toHaveURL(new RegExp(`/app/landscape/${landscapeId}/version/${forkId}`))
    await expectObjects(page, [systemId, storeId], [], 'fork after reload')

    // ── a COPY, not an alias: writing here must not reach the source ─────────
    const forkOnlyId = await addModelObject(page, 'actor')
    await settleWrites(page)

    const sinceBack = mark(probe)
    await openVersionPanel(page)
    const mainRow = page.getByTestId(`version-row-${mainVersionId}`)
    await mainRow.hover()
    await mainRow.getByTestId('version-switch').click({ force: true })
    await page.waitForURL((url) => refFromUrl(url.toString())?.versionId === mainVersionId, { timeout: 90_000 })
    await expectSingleScopedSwitch(page, probe, sinceBack, { landscapeId, versionId: mainVersionId }, 'back to source')
    await expectObjects(page, [systemId, storeId], [forkOnlyId], 'source after the fork was edited')
    await expectNoOrderViolation(page, 'back to source')
    expectNeverDefaultScoped(probe, 'end of run')
  })

  test('makeDefault repoints the landscape and the new default survives a reload', async ({ page }) => {
    test.setTimeout(300_000)
    const probe = attachProbe(page)
    cleanupApiUrl = trackApiOrigin(page)
    await signIn(page, probe, 'default')
    const homeLandscapeId = currentRef(page).landscapeId

    const landscapeId = await createLandscape(page, `e2e-makedefault-${Date.now().toString(36)}`)
    const systemId = await addModelObject(page, 'system')
    const storeId = await addModelObject(page, 'store')
    await settleWrites(page)
    const [mainVersionId] = await versionIds(page)

    // ── a second version with its OWN content ───────────────────────────────
    await openVersionPanel(page)
    await page.getByTestId('new-version-label').fill('e2e-next')
    await page.getByTestId('new-version-add').click()
    await page.waitForURL(
      (url) => {
        const ref = refFromUrl(url.toString())
        return !!ref && ref.landscapeId === landscapeId && ref.versionId !== 'current' && ref.versionId !== mainVersionId
      },
      { timeout: 90_000 },
    )
    const nextVersionId = currentRef(page).versionId
    const nextOnlyId = await addModelObject(page, 'actor')
    await settleWrites(page)

    // ── follow the default again — still the ORIGINAL default's content ──────
    const sinceFollow = mark(probe)
    await openVersionPanel(page)
    await page.getByTestId('version-follow-default').click()
    await page.waitForURL((url) => refFromUrl(url.toString())?.versionId === 'current', { timeout: 90_000 })
    await expectSingleScopedSwitch(page, probe, sinceFollow, { landscapeId, versionId: 'current' }, 'follow default')
    await expectObjects(page, [systemId, storeId], [nextOnlyId], 'following the original default')

    await openVersionPanel(page)
    await expect(page.getByTestId(`version-row-${mainVersionId}`)).toHaveAttribute('data-default', 'true')
    await expect(page.getByTestId(`version-row-${nextVersionId}`)).toHaveAttribute('data-default', 'false')

    // ── makeDefault: repoint the landscape at the second version ─────────────
    const sinceDefault = mark(probe)
    const nextRow = page.getByTestId(`version-row-${nextVersionId}`)
    await nextRow.hover()
    await page.getByTestId(`version-make-default-${nextVersionId}`).click({ force: true })

    // We follow 'current', so the pointer moving under us re-resolves the live
    // workspace: exactly one forced reconnect, at the SAME (landscape, current)
    // route key — never a bounce onto another landscape.
    await expectSingleScopedSwitch(page, probe, sinceDefault, { landscapeId, versionId: 'current' }, 'makeDefault')
    await expectNoOrderViolation(page, 'makeDefault')
    expectNeverDefaultScoped(probe, 'makeDefault')
    await expect(page).toHaveURL(new RegExp(`/app/landscape/${landscapeId}/version/current`))

    // The live view must now BE the new default's workspace.
    await expectObjects(page, [nextOnlyId], [systemId, storeId], 'after makeDefault')
    await openVersionPanel(page)
    await expect(page.getByTestId(`version-row-${nextVersionId}`)).toHaveAttribute('data-default', 'true')
    await expect(page.getByTestId(`version-row-${mainVersionId}`)).toHaveAttribute('data-default', 'false')

    // ── it stuck server-side ────────────────────────────────────────────────
    await page.reload()
    await installOrderProbe(page)
    await expect(page).toHaveURL(new RegExp(`/app/landscape/${landscapeId}/version/current`))
    await expectObjects(page, [nextOnlyId], [systemId, storeId], 'after reload')
    await openVersionPanel(page)
    await expect(page.getByTestId(`version-row-${nextVersionId}`)).toHaveAttribute('data-default', 'true')

    // ── and ENTERING the landscape lands on the new default ─────────────────
    const sinceAway = mark(probe)
    await openLandscapePanel(page)
    const homeRow = page.getByTestId(`landscape-row-${homeLandscapeId}`)
    await homeRow.hover()
    await homeRow.getByTestId('landscape-switch').click({ force: true })
    await page.waitForURL(
      (url) => refFromUrl(url.toString())?.landscapeId === homeLandscapeId,
      { timeout: 90_000 },
    )
    await expectSingleScopedSwitch(
      page,
      probe,
      sinceAway,
      { landscapeId: homeLandscapeId, versionId: 'current' },
      'leave the landscape',
    )

    const sinceBack = mark(probe)
    await openLandscapePanel(page)
    const targetRow = page.getByTestId(`landscape-row-${landscapeId}`)
    await targetRow.hover()
    await targetRow.getByTestId('landscape-switch').click({ force: true })
    await page.waitForURL((url) => refFromUrl(url.toString())?.landscapeId === landscapeId, { timeout: 90_000 })
    await expectSingleScopedSwitch(page, probe, sinceBack, { landscapeId, versionId: 'current' }, 're-enter the landscape')
    await expectObjects(page, [nextOnlyId], [systemId, storeId], 're-entered on the new default')
    await expectNoOrderViolation(page, 're-enter the landscape')
    expectNeverDefaultScoped(probe, 'end of run')
  })
})
