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
 * `workspaceStore.removeVersion` / `removeLandscape` driven through the REAL UI.
 *
 * These are the two DESTRUCTIVE workspace paths, and the two whose navigation is
 * now awaited INSIDE the `busy` guard. Three regressions this suite exists to
 * catch, all of which were invisible to the vitest suite:
 *
 *  1. A workspace created without `{shardedModel:true}` has no durable home: it
 *     looks right until a reload empties it. → every flow here RELOADS and
 *     re-asserts its seeded content by id.
 *  2. Releasing `busy` before the URL moved turned one switch into three (the
 *     route effect bounced the store back). → every switch asserts EXACTLY ONE
 *     new automerge socket, and asserts it again after a settle window.
 *  3. A bare `getRootHandle()` re-points the app's only sync socket at
 *     `landscapeId=default`. → no socket URL may ever name `landscapeId=default`.
 *
 * Isolation: each test signs in as a BRAND-NEW dev-login user, which provisions a
 * personal org holding exactly ONE landscape ('Main' version + starter diagram).
 * Nothing here can see or trample another agent's landscapes, and the "refuses to
 * delete the last landscape" guard is reachable without destroying anyone's data.
 */

import { expect, test, type Page } from '@playwright/test'
import { submitDevLogin } from './support/devLogin'
import { waitForWorkspaceProjected } from './support/workspaceReady'

test.use({ channel: process.env.PW_BROWSER_CHANNEL || undefined })

const WS_URL_RE = /\/app\/landscape\/([^/?#]+)\/version\/([^/?#]+)/

interface Ref {
  landscapeId: string
  versionId: string
}

interface VersionInfo {
  id: string
  label: string
}

interface LandscapeInfo {
  id: string
  name: string
  defaultVersionId: string | null
  versions: VersionInfo[]
}

/** Every socket the page opens, in order, recorded from BEFORE the first goto and
 * surviving reloads (the init script is re-installed on every document; the array
 * lives in Node). */
interface SocketRecorder {
  /** All automerge sync sockets seen so far. */
  automerge(): Ref[]
  /** Index to measure "sockets opened by the next action" from. */
  mark(): number
  /** Automerge sockets opened since `mark()`. */
  since(mark: number): Ref[]
}

function refFromSocketUrl(url: string): Ref {
  // `ws://`→`http://`, `wss://`→`https://`; the base covers a relative url so a
  // malformed socket surfaces as a failed assertion, never as a thrown helper.
  const parsed = new URL(url.replace(/^ws/, 'http'), 'http://socket.invalid')
  return {
    landscapeId: parsed.searchParams.get('landscapeId') ?? '<none>',
    versionId: parsed.searchParams.get('versionId') ?? '<none>',
  }
}

async function installSocketRecorder(page: Page): Promise<SocketRecorder> {
  const urls: string[] = []
  await page.exposeFunction('__e2eSocketOpened', (url: string) => {
    urls.push(url)
  })
  await page.addInitScript(() => {
    const Native = window.WebSocket
    class RecordingWebSocket extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const record = (window as unknown as { __e2eSocketOpened?: (u: string) => void }).__e2eSocketOpened
        try {
          record?.(String(url))
        } catch {
          /* recorder detached between documents — never break the app */
        }
      }
    }
    window.WebSocket = RecordingWebSocket as unknown as typeof WebSocket
  })
  const automerge = (): Ref[] => urls.filter((u) => u.includes('/automerge')).map(refFromSocketUrl)
  return {
    automerge,
    mark: () => automerge().length,
    since: (mark: number) => automerge().slice(mark),
  }
}

/** The app talks to the API on its own origin (VITE_SYNC_API_URL), which is NOT the
 * page origin. Learn it from the app's own traffic instead of guessing a port or
 * depending on the Vite `/api` proxy; the session cookie is host-scoped (ports are
 * not part of cookie identity), so `context.request` carries it either way. */
function trackApiOrigin(page: Page): (path: string) => string {
  let origin: string | null = null
  page.on('request', (request) => {
    if (origin) return
    try {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) origin = url.origin
    } catch {
      /* non-http request (ws:, data:) — ignore */
    }
  })
  return (path: string) => `${origin ?? ''}${path}`
}

/** Sign in as a brand-new user. Returns null when this stack is not running the
 * authenticated configuration these flows require. */
async function signInAsNewUser(page: Page, tag: string, apiUrl: (p: string) => string): Promise<string | null> {
  await page.goto('/app')
  const emailField = page.getByTestId('dev-login-email')
  // Race against the WORKSPACE url, never a bare `/app`. Boot passes THROUGH
  // `/app` on its way to `/login`, so a `/\/app(?:\/|$)/` race resolves on that
  // transient url, `isVisible()` then reads a login form that has not rendered
  // yet, the submit is skipped, and the run dies 60 s later sitting on the login
  // page with an empty email box. Measured: all three tests here failed that way.
  await Promise.race([
    emailField.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined),
    page.waitForURL(WS_URL_RE, { timeout: 45_000 }).catch(() => undefined),
  ])
  if (await emailField.isVisible().catch(() => false)) {
    await submitDevLogin(page, `e2e-ws-removal-${tag}-${Date.now()}@example.com`)
  }
  await page.waitForURL(WS_URL_RE, { timeout: 90_000 })
  const me = await page.context().request.get(apiUrl('/api/auth/me'))
  if (me.status() !== 200) return null
  const body = (await me.json()) as { claims?: { orgId?: string | null } }
  return body.claims?.orgId ?? null
}

function refFromUrl(url: string): Ref {
  const m = WS_URL_RE.exec(url)
  if (!m) throw new Error(`not a workspace URL: ${url}`)
  return { landscapeId: decodeURIComponent(m[1]), versionId: decodeURIComponent(m[2]) }
}

function refKey(ref: Ref): string {
  return `${ref.landscapeId}/${ref.versionId}`
}

function readRef(page: Page): string {
  try {
    return refKey(refFromUrl(page.url()))
  } catch {
    return page.url()
  }
}

/** Wait until the address bar names `want`. The URL is the app's own statement of
 * which workspace it thinks it is in — regression 2 was precisely a disagreement
 * between it and the live ref. */
async function expectUrlRef(page: Page, want: Ref, label: string): Promise<void> {
  await expect.poll(() => readRef(page), { message: label, timeout: 60_000 }).toBe(refKey(want))
}

async function waitForRefChange(page: Page, from: Ref, label: string): Promise<Ref> {
  await expect.poll(() => readRef(page), { message: label, timeout: 60_000 }).not.toBe(refKey(from))
  return refFromUrl(page.url())
}

/**
 * A workspace switch must open EXACTLY ONE new sync socket, on the ref actually
 * entered. Asserted twice: once as soon as one appears, then again after a settle
 * window — the bounce-back regression opened its extra sockets a beat later, so a
 * single instantaneous check would have passed over it.
 */
async function expectExactlyOneNewSocket(
  page: Page,
  recorder: SocketRecorder,
  mark: number,
  expected: Ref,
  label: string,
): Promise<void> {
  await expect.poll(() => recorder.since(mark).length, { message: `${label}: a new sync socket opens`, timeout: 60_000 })
    .toBeGreaterThan(0)
  await page.waitForTimeout(2_500)
  expect(recorder.since(mark).map(refKey), `${label}: exactly one new sync socket, on the entered workspace`)
    .toEqual([refKey(expected)])
}

/** Regression 3's only direct witness. Vacuous on an empty list, so it always runs
 * next to a "the recorder actually saw sockets" check. */
function expectNoDefaultLandscapeSocket(recorder: SocketRecorder, label: string): void {
  expect(recorder.automerge().length, `${label}: the socket recorder is live`).toBeGreaterThan(0)
  expect(
    recorder.automerge().filter((r) => r.landscapeId === 'default').map(refKey),
    `${label}: no sync socket may be scoped to landscapeId=default`,
  ).toEqual([])
}

// ── Workspace menu (nav-menu → WorkspaceMenu) ─────────────────────────────────

async function openWorkspaceMenu(page: Page): Promise<void> {
  if (!(await page.getByTestId('workspace-landscapes').isVisible().catch(() => false))) {
    await page.getByTestId('nav-menu').click()
  }
  await expect(page.getByTestId('workspace-landscapes')).toBeVisible()
}

async function closeWorkspaceMenu(page: Page): Promise<void> {
  if (await page.getByTestId('workspace-landscapes').isVisible().catch(() => false)) {
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('workspace-landscapes')).toHaveCount(0)
  }
}

async function expandLandscapes(page: Page): Promise<void> {
  await openWorkspaceMenu(page)
  if (!(await page.getByTestId('new-landscape-name').isVisible().catch(() => false))) {
    await page.getByTestId('workspace-landscapes').click()
  }
  await expect(page.getByTestId('new-landscape-name')).toBeVisible()
}

async function expandVersions(page: Page): Promise<void> {
  await openWorkspaceMenu(page)
  if (!(await page.getByTestId('new-version-label').isVisible().catch(() => false))) {
    await page.getByTestId('workspace-versions').click()
  }
  await expect(page.getByTestId('new-version-label')).toBeVisible()
}

/** Create a landscape through the menu; the app switches into it. Returns its ref. */
async function createLandscape(page: Page, name: string, from: Ref): Promise<Ref> {
  await expandLandscapes(page)
  await page.getByTestId('new-landscape-name').fill(name)
  await page.getByTestId('new-landscape-add').click()
  const entered = await waitForRefChange(page, from, `creating landscape "${name}" enters it`)
  expect(entered.versionId, 'a new landscape is entered on its default version').toBe('current')
  return entered
}

/** Create a version through the menu; the app switches into it. Returns its ref. */
async function createVersion(page: Page, label: string, from: Ref): Promise<Ref> {
  await expandVersions(page)
  await page.getByTestId('new-version-label').fill(label)
  await page.getByTestId('new-version-add').click()
  const entered = await waitForRefChange(page, from, `creating version "${label}" enters it`)
  expect(entered.landscapeId, 'a new version stays in the same landscape').toBe(from.landscapeId)
  expect(entered.versionId, 'a new version is pinned by id, not followed as "current"').not.toBe('current')
  return entered
}

// ── Model content (the only durable thing a reload can disprove) ──────────────

async function openModelObjects(page: Page): Promise<void> {
  await closeWorkspaceMenu(page)
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-model-objects').click()
  await expect(page.getByTestId('mo-table-scroll')).toBeVisible()
}

/** Row ids only — `mo-row-menu-*` / `mo-row-delete-*` share the prefix. */
async function objectRowIds(page: Page): Promise<string[]> {
  return page.locator('tr[data-testid^="mo-row-"]').evaluateAll((rows) =>
    rows.map((row) => (row.getAttribute('data-testid') ?? '').replace('mo-row-', '')),
  )
}

/** The app's own settled-sync signal. The page-shell views expose it as
 * `ws-sync-status`, the canvas as `#sync-status`; accept whichever is mounted so
 * this works right after boot (canvas) and on the data pages alike. */
async function waitForSyncReady(page: Page): Promise<void> {
  // NOT `data-status === 'ready'`: that is a durability latch that sits at
  // 'saving' indefinitely on a brand-new landscape/version — which is every
  // workspace this file creates — and carries no workspace identity, so a
  // mid-switch re-boot of the PREVIOUS workspace satisfies it. See
  // e2e/support/workspaceReady.ts.
  await waitForWorkspaceProjected(page)
}

/** Add one system through the real add menu and return the id of the row it created. */
async function addSystemObject(page: Page): Promise<string> {
  await openModelObjects(page)
  await waitForSyncReady(page)
  const before = new Set(await objectRowIds(page))
  await page.getByTestId('mo-add-object').click()
  await page.getByTestId('mo-add-system').click()
  let created = ''
  await expect.poll(async () => {
    created = (await objectRowIds(page)).find((id) => !before.has(id)) ?? created
    return created
  }, { message: 'the new object appears as a model-objects row', timeout: 60_000 }).not.toBe('')
  await waitForSyncReady(page)
  return created
}

/**
 * The content assertion every flow ends on. `present` must be non-empty: the
 * absence half is only meaningful once the workspace has demonstrably hydrated,
 * so it is asserted AFTER a positive control from the same workspace.
 */
async function expectObjects(
  page: Page,
  { present, absent }: { present: string[]; absent?: string[] },
  label: string,
): Promise<void> {
  expect(present.length, `${label}: an empty-set assertion proves nothing`).toBeGreaterThan(0)
  await openModelObjects(page)
  await waitForSyncReady(page)
  for (const id of present) {
    await expect(page.getByTestId(`mo-row-${id}`), `${label}: object ${id} is here`).toHaveCount(1)
  }
  for (const id of absent ?? []) {
    await expect(page.getByTestId(`mo-row-${id}`), `${label}: object ${id} belongs to another workspace`)
      .toHaveCount(0)
  }
}

async function diagramCardIds(page: Page): Promise<string[]> {
  await closeWorkspaceMenu(page)
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  await expect(page.locator('[data-testid^="diagram-card-"]').first()).toBeVisible({ timeout: 60_000 })
  const ids = await page.locator('[data-testid^="diagram-card-"]').evaluateAll((cards) =>
    cards.map((card) => (card.getAttribute('data-testid') ?? '').replace('diagram-card-', '')),
  )
  return ids.sort() // compared as a SET across a workspace switch; ordering is the list's business
}

// ── REST (server contract only — never to drive the app) ──────────────────────

async function listLandscapes(page: Page, apiUrl: (p: string) => string): Promise<LandscapeInfo[]> {
  const res = await page.context().request.get(apiUrl('/api/landscapes'))
  expect(res.status(), 'GET /api/landscapes').toBe(200)
  return ((await res.json()) as { landscapes: LandscapeInfo[] }).landscapes
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

let createdLandscapes: string[] = []
let createdVersions: Ref[] = []
let cleanupApiUrl: ((p: string) => string) | null = null

test.beforeEach(() => {
  createdLandscapes = []
  createdVersions = []
  cleanupApiUrl = null
})

// This spec creates and destroys workspaces; leave nothing behind even when the
// body throws mid-flow. (The server refuses to delete an org's last landscape or a
// default version — those 409s are expected here, not cleanup failures.)
test.afterEach(async ({ page }) => {
  const apiUrl = cleanupApiUrl
  if (!apiUrl) return
  for (const ref of createdVersions) {
    try {
      await page.context().request.delete(
        apiUrl(
          `/api/landscapes/${encodeURIComponent(ref.landscapeId)}/versions/${encodeURIComponent(ref.versionId)}`,
        ),
      )
    } catch {
      /* best effort */
    }
  }
  for (const id of createdLandscapes) {
    try {
      await page.context().request.delete(apiUrl(`/api/landscapes/${encodeURIComponent(id)}`))
    } catch {
      /* best effort — the stack may already be gone */
    }
  }
})

test.describe('workspace removal', () => {
  test('deleting a non-default version switches away and leaves the remaining version intact', async ({ page }) => {
    test.setTimeout(240_000)
    const recorder = await installSocketRecorder(page)
    const apiUrl = trackApiOrigin(page)
    cleanupApiUrl = apiUrl
    page.on('dialog', (dialog) => void dialog.accept())

    const orgId = await signInAsNewUser(page, 'ver', apiUrl)
    test.skip(!orgId, 'needs the authenticated stack (AUTH=on + AUTH_DEV_LOGIN=on) for an isolated personal org')
    await page.waitForURL(WS_URL_RE, { timeout: 60_000 })
    const home = refFromUrl(page.url())
    expect(home.landscapeId, 'the booted landscape must not be the "default" placeholder').not.toBe('default')
    await waitForSyncReady(page)
    expectNoDefaultLandscapeSocket(recorder, 'after boot')

    // A landscape of our own, with content that only lives in its Main version.
    let mark = recorder.mark()
    const landscape = await createLandscape(page, `ws-rm-ver-${Date.now()}`, home)
    createdLandscapes.push(landscape.landscapeId)
    await expectExactlyOneNewSocket(page, recorder, mark, landscape, 'creating a landscape')
    const mainObject = await addSystemObject(page)

    const registry = await listLandscapes(page, apiUrl)
    const created = registry.find((l) => l.id === landscape.landscapeId)
    expect(created, 'the new landscape is in the registry').toBeTruthy()
    expect(created!.versions.map((v) => v.id), 'a new landscape starts with exactly one version').toHaveLength(1)
    const mainVersionId = created!.versions[0].id
    expect(created!.defaultVersionId, 'that one version is the default').toBe(mainVersionId)

    // A second, non-default version — entered on creation, and empty of Main's content.
    mark = recorder.mark()
    const second = await createVersion(page, `branch-${Date.now()}`, landscape)
    await expectExactlyOneNewSocket(page, recorder, mark, second, 'creating a version')
    const secondObject = await addSystemObject(page)
    await expectObjects(page, { present: [secondObject], absent: [mainObject] }, 'inside the new version')

    // Delete the version we are standing in.
    await expandVersions(page)
    const secondRow = page.getByTestId(`version-row-${second.versionId}`)
    await expect(secondRow, 'the new version is listed').toBeVisible()
    await secondRow.hover()
    const deleteSecond = secondRow.getByTestId('version-delete')
    await expect(deleteSecond, 'a non-default version is deletable').toBeEnabled()
    mark = recorder.mark()
    await deleteSecond.click()

    const followsDefault: Ref = { landscapeId: landscape.landscapeId, versionId: 'current' }
    await expectUrlRef(page, followsDefault, 'deleting the active version follows the landscape default')
    await expectExactlyOneNewSocket(page, recorder, mark, followsDefault, 'deleting the active version')
    // The delete navigates, which CLOSES the mega-menu — re-open it before reading
    // the switcher. Order matters: assert the survivor PRESENT first, so the
    // "deleted row is gone" check can never be satisfied by a closed menu.
    await expandVersions(page)
    await expect(page.getByTestId(`version-row-${mainVersionId}`), 'the remaining version is still listed')
      .toBeVisible()
    await expect(page.getByTestId(`version-row-${second.versionId}`), 'the deleted version leaves the switcher')
      .toHaveCount(0)
    await closeWorkspaceMenu(page)

    await expectObjects(page, { present: [mainObject], absent: [secondObject] }, 'back on the default version')

    // Regression 1: everything above passed in-memory on a workspace with no
    // durable home. Only the reload can tell the difference.
    await page.reload()
    await page.waitForURL(WS_URL_RE, { timeout: 60_000 })
    await waitForSyncReady(page)
    await expectUrlRef(page, followsDefault, 'the reload comes back on the surviving version')
    await expectObjects(page, { present: [mainObject], absent: [secondObject] }, 'after a reload')

    const after = await listLandscapes(page, apiUrl)
    expect(
      after.find((l) => l.id === landscape.landscapeId)?.versions.map((v) => v.id),
      'the server registry lost exactly the deleted version',
    ).toEqual([mainVersionId])
    expectNoDefaultLandscapeSocket(recorder, 'end of the version-removal flow')
  })

  test('deleting the ACTIVE landscape lands on a loaded workspace, not an empty shell', async ({ page }) => {
    test.setTimeout(240_000)
    const recorder = await installSocketRecorder(page)
    const apiUrl = trackApiOrigin(page)
    cleanupApiUrl = apiUrl
    page.on('dialog', (dialog) => void dialog.accept())

    const orgId = await signInAsNewUser(page, 'ls', apiUrl)
    test.skip(!orgId, 'needs the authenticated stack (AUTH=on + AUTH_DEV_LOGIN=on) for an isolated personal org')
    await page.waitForURL(WS_URL_RE, { timeout: 60_000 })
    const home = refFromUrl(page.url())
    expect(home.landscapeId, 'the booted landscape must not be the "default" placeholder').not.toBe('default')
    await waitForSyncReady(page)

    // Seed the landscape we expect to LAND ON, so "it loaded" is a statement about
    // content we put there and not about an empty page rendering without error.
    const homeObject = await addSystemObject(page)
    const homeDiagrams = await diagramCardIds(page)
    expect(homeDiagrams.length, 'the landing landscape has at least one diagram to come back to').toBeGreaterThan(0)

    let mark = recorder.mark()
    const doomed = await createLandscape(page, `ws-rm-ls-${Date.now()}`, home)
    createdLandscapes.push(doomed.landscapeId)
    await expectExactlyOneNewSocket(page, recorder, mark, doomed, 'creating the landscape to delete')
    const doomedObject = await addSystemObject(page)
    await expectObjects(page, { present: [doomedObject], absent: [homeObject] }, 'inside the new landscape')

    // Where must the app land? The store falls back to the FIRST landscape of the
    // reloaded registry — compute it from the server, immediately before deleting.
    const before = await listLandscapes(page, apiUrl)
    const survivors = before.filter((l) => l.id !== doomed.landscapeId)
    expect(survivors.length, 'deleting the active landscape must leave somewhere to go').toBeGreaterThan(0)
    const expectedFallback = survivors[0].id
    expect(expectedFallback, 'a fresh personal org falls back to its provisioned landscape').toBe(home.landscapeId)

    await expandLandscapes(page)
    const doomedRow = page.getByTestId(`landscape-row-${doomed.landscapeId}`)
    await expect(doomedRow).toBeVisible()
    await doomedRow.hover()
    const deleteDoomed = doomedRow.getByTestId('landscape-delete')
    await expect(deleteDoomed, 'with two landscapes, deleting one is offered').toBeEnabled()
    mark = recorder.mark()
    await deleteDoomed.click()

    const landing: Ref = { landscapeId: expectedFallback, versionId: 'current' }
    await expectUrlRef(page, landing, 'deleting the active landscape moves to the remaining one')
    await expectExactlyOneNewSocket(page, recorder, mark, landing, 'deleting the active landscape')
    // Same as above: the delete navigated and closed the menu, so re-open it and
    // prove the SURVIVOR is listed before concluding the deleted one is gone.
    await expandLandscapes(page)
    await expect(page.getByTestId(`landscape-row-${expectedFallback}`), 'the surviving landscape is listed')
      .toBeVisible()
    await expect(page.getByTestId(`landscape-row-${doomed.landscapeId}`), 'the deleted landscape leaves the switcher')
      .toHaveCount(0)
    await closeWorkspaceMenu(page)

    // "Actually loads": its objects AND its diagrams are back, and the canvas opens.
    await waitForSyncReady(page)
    await expectObjects(page, { present: [homeObject], absent: [doomedObject] }, 'on the landing landscape')
    expect(await diagramCardIds(page), 'the landing landscape brought its diagrams back').toEqual(homeDiagrams)
    // A single click only SELECTS a card (`setCurrentDiagram`); opening it is a
    // DOUBLE click (`handleGoToDiagram`), exactly as in the app.
    await page.getByTestId(`diagram-card-${homeDiagrams[0]}`).dblclick()
    await expect(page.getByTestId('canvas-2d'), 'the landing workspace opens a real diagram').toBeVisible({
      timeout: 60_000,
    })

    await page.reload()
    await page.waitForURL(WS_URL_RE, { timeout: 60_000 })
    await expect.poll(() => refFromUrl(page.url()).landscapeId, {
      message: 'the reload boots the landing landscape, not the deleted one',
      timeout: 60_000,
    }).toBe(expectedFallback)
    await waitForSyncReady(page)
    await expectObjects(page, { present: [homeObject], absent: [doomedObject] }, 'after a reload')

    const after = await listLandscapes(page, apiUrl)
    expect(after.map((l) => l.id), 'the server registry lost exactly the deleted landscape')
      .toEqual(before.filter((l) => l.id !== doomed.landscapeId).map((l) => l.id))
    expectNoDefaultLandscapeSocket(recorder, 'end of the landscape-removal flow')
  })

  test('the last landscape and the default version cannot be deleted', async ({ page }) => {
    test.setTimeout(240_000)
    const recorder = await installSocketRecorder(page)
    const apiUrl = trackApiOrigin(page)
    cleanupApiUrl = apiUrl
    page.on('dialog', (dialog) => void dialog.accept())

    const orgId = await signInAsNewUser(page, 'guard', apiUrl)
    test.skip(!orgId, 'needs the authenticated stack (AUTH=on + AUTH_DEV_LOGIN=on) for an isolated personal org')
    await page.waitForURL(WS_URL_RE, { timeout: 60_000 })
    const home = refFromUrl(page.url())
    await waitForSyncReady(page)
    const homeObject = await addSystemObject(page)

    // --- Guard 1: the org's last landscape -----------------------------------
    const registry = await listLandscapes(page, apiUrl)
    expect(registry.map((l) => l.id), 'a fresh personal org holds exactly one landscape')
      .toEqual([home.landscapeId])

    const refusedLandscape = await page.context().request.delete(
      apiUrl(`/api/landscapes/${encodeURIComponent(home.landscapeId)}`),
    )
    expect(refusedLandscape.status(), 'the server refuses to delete the only landscape').toBe(409)
    expect(((await refusedLandscape.json()) as { error?: string }).error ?? '', 'and says why')
      .toMatch(/only landscape/i)

    // What the UI does about that refusal: NOT "call and report the failure" —
    // it disables the affordance and explains through the tooltip, so the server
    // guard is never reached from here. That is the truth being asserted; it is
    // neither a visible error nor a silent no-op. (Finding, not asserted here
    // because no UI path reaches it: `workspaceStore.error` is rendered ONLY
    // inside the VERSION panel — `workspace-error` — so a landscape-level failure
    // that DID reach the store would have nowhere to appear.)
    await expandLandscapes(page)
    const homeRow = page.getByTestId(`landscape-row-${home.landscapeId}`)
    await homeRow.hover()
    const deleteHome = homeRow.getByTestId('landscape-delete')
    await expect(deleteHome, 'the only landscape offers no delete').toBeDisabled()
    expect(await deleteHome.getAttribute('title'), 'and explains itself on hover').toBeTruthy()

    // --- Guard 2: the landscape's default version ----------------------------
    const second = await createVersion(page, `branch-${Date.now()}`, home)
    createdVersions.push(second)
    const withTwo = await listLandscapes(page, apiUrl)
    const landscape = withTwo.find((l) => l.id === home.landscapeId)!
    expect(landscape.versions.map((v) => v.id).sort(), 'the landscape now has two versions')
      .toEqual([landscape.defaultVersionId!, second.versionId].sort())
    const defaultVersionId = landscape.defaultVersionId!
    expect(defaultVersionId, 'the new version did not steal the default').not.toBe(second.versionId)

    const refusedVersion = await page.context().request.delete(
      apiUrl(
        `/api/landscapes/${encodeURIComponent(home.landscapeId)}/versions/${encodeURIComponent(defaultVersionId)}`,
      ),
    )
    expect(refusedVersion.status(), 'the server refuses to delete the default version').toBe(409)
    expect(((await refusedVersion.json()) as { error?: string }).error ?? '', 'and says why')
      .toMatch(/default version/i)

    await expandVersions(page)
    const defaultRow = page.getByTestId(`version-row-${defaultVersionId}`)
    await defaultRow.hover()
    const deleteDefault = defaultRow.getByTestId('version-delete')
    await expect(deleteDefault, 'the default version offers no delete').toBeDisabled()
    expect(await deleteDefault.getAttribute('title'), 'and explains itself on hover').toBeTruthy()
    const secondRow = page.getByTestId(`version-row-${second.versionId}`)
    await secondRow.hover()
    await expect(secondRow.getByTestId('version-delete'), 'while the non-default one does').toBeEnabled()
    await closeWorkspaceMenu(page)

    // Two refused deletes must leave the workspace exactly as it was.
    await page.reload()
    await page.waitForURL(WS_URL_RE, { timeout: 60_000 })
    await waitForSyncReady(page)
    const survived = await listLandscapes(page, apiUrl)
    expect(survived.map((l) => l.id), 'the refused landscape delete changed nothing').toEqual([home.landscapeId])
    expect(
      survived[0].versions.map((v) => v.id).sort(),
      'the refused version delete changed nothing',
    ).toEqual([defaultVersionId, second.versionId].sort())

    await page.goto(`/app/landscape/${home.landscapeId}/version/current`)
    await page.waitForURL(WS_URL_RE, { timeout: 60_000 })
    await waitForSyncReady(page)
    await expectObjects(page, { present: [homeObject] }, 'the refusals left the content alone')
    expectNoDefaultLandscapeSocket(recorder, 'end of the guard flow')
  })
})
