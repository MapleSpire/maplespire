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
 * Diagram duplication, driven through the real UI, in a landscape that is NOT
 * the session's boot landscape.
 *
 * Why this file exists
 * --------------------
 * `src/lib/diagrams/duplicateSource.ts` is a bare caller of
 * `getRegistryShardHandles()` → `getRootHandle()`. `ade9ce1f` changed that
 * getter's default from `DEFAULT_WORKSPACE_REF` to `currentWorkspaceRef()`. On a
 * single-workspace install the two are the same value and nothing is observable.
 * In a multi-landscape session they are not, and the difference is invisible
 * twice over:
 *
 *  1. `getRootHandle` ROUTES THE NETWORK (`routeWorkspaceNetwork(ref)`), so a
 *     bare call under the old default tears the app's only sync socket off the
 *     landscape the user is in and re-points it at `landscapeId=default` — for
 *     the rest of the session. Nothing in the UI says so. The WebSocket recorder
 *     installed below is the direct witness.
 *  2. The registry shards it then reads belong to the WRONG workspace, so the
 *     diagram being duplicated is looked up in a model that does not contain it.
 *
 * What the spec pins down
 * -----------------------
 *  A. The copy's composition (object ids, connection ids, group ids) and its
 *     LAYOUT are the source's, byte for byte — the source being a diagram that is
 *     deliberately NOT the active one, which is the only tier that reaches the
 *     repo getters at all (`loadDiagramDuplicateSource` tier 2, `via: 'document'`).
 *  B. F10's contract: duplicating a VIEW must not duplicate the MODEL. Object /
 *     connection / group counts are unchanged, and the copy references the very
 *     same object ids — one object, two views.
 *  C. It survives a reload with its content, not just its name in a list.
 *  D. No socket ever names `landscapeId=default` once we are inside a minted
 *     landscape, and entering a landscape opens exactly one workspace socket,
 *     scoped to the landscape actually entered.
 *
 * Everything the test ACTS on goes through pointer input on the real UI. The
 * `__modelStore` reads are assertion probes only — never a way to make something
 * happen.
 */

// ── Store probe (read-only) ───────────────────────────────────────────────────

interface Placement {
  position: { x: number; y: number }
  size: { width: number; height: number }
}

interface ProbeDiagram {
  id: string
  name: string
  type: string
  objectIds: string[]
  connectionIds: string[]
  groupIds: string[]
  layouts: Record<string, Placement>
}

interface ProbeSnapshot {
  currentDiagramId: string | null
  objectIds: string[]
  objectNames: string[]
  connectionCount: number
  groupCount: number
  diagramIds: string[]
}

// The `interface ProbeWindow extends Window` that stood here was the ninth
// private description of `window.__modelStore` in this tree, and the only one
// TypeScript could ever have flagged: it EXTENDS Window, so the shared
// declaration in e2e/support/probes.d.ts turns the disagreement into a TS2430
// rather than the silent shadowing the eight `declare global` blocks produced.
// The probe's type now comes from the store itself.

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Two landscapes with DISJOINT vocabularies. Element ids are derived from the
// DSL identifiers, so a copy assembled from the wrong landscape's model can only
// carry ids that do not exist in the landscape we are standing in — which the
// composition assertions catch even when the socket assertion does not.

const ALPHA_DSL = `workspace "Alpha" {
    model {
        aops = person "Alpha operator" "Runs the plant"
        amill = softwareSystem "Alpha mill" "Grinds the wheat" {
            amillapi = container "Alpha mill API" "Control plane" "Go"
            amilldb = container "Alpha mill store" "Telemetry" "TimescaleDB"
        }
        aops -> amill "Operates"
        amillapi -> amilldb "Writes"
    }
    views {
        systemContext amill { include *  autoLayout }
        container amill { include *  autoLayout }
    }
}`

// The container view is the duplication source: `buildContainer` ALWAYS emits a
// system-boundary group, so `groupIds` is non-empty by construction and the
// group half of the composition assertion is a real comparison, not `[] === []`.
const BRAVO_DSL = `workspace "Bravo" {
    model {
        bportal = softwareSystem "Bravo portal" "Public entry point"
        bauth = softwareSystem "Bravo auth" "Federated identity"
        bcore = softwareSystem "Bravo core" "Domain services" {
            bapi = container "Bravo API" "Orchestration" "Node.js"
            bdb = container "Bravo store" "Order records" "PostgreSQL"
            bworker = container "Bravo worker" "Async jobs" "Node.js"
        }
        bportal -> bcore "Calls"
        bauth -> bcore "Verifies"
        bapi -> bdb "Reads and writes"
        bworker -> bdb "Writes"
        bapi -> bworker "Enqueues"
    }
    views {
        systemContext bcore { include *  autoLayout }
        container bcore { include *  autoLayout }
    }
}`

// ── WebSocket recorder ───────────────────────────────────────────────────────
// Installed with addInitScript BEFORE the first goto, and re-installed by
// Playwright on every navigation. The log lives in sessionStorage so it SURVIVES
// the reload — a socket torn off the workspace before the reload is still
// visible in the final sweep.

const WS_LOG_KEY = '__ms_e2e_ws_log'

async function installSocketRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Literal, not WS_LOG_KEY: addInitScript serialises this function's SOURCE
    // and evaluates it in the page, where the test file's bindings do not exist.
    // Keep it identical to WS_LOG_KEY above.
    const KEY = '__ms_e2e_ws_log'
    const record = (url: string) => {
      try {
        const prev = JSON.parse(window.sessionStorage.getItem(KEY) ?? '[]') as string[]
        prev.push(url)
        window.sessionStorage.setItem(KEY, JSON.stringify(prev))
      } catch {
        /* storage unavailable — never break the app under test for a probe */
      }
    }
    const Native = window.WebSocket
    class RecordingWebSocket extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        record(String(url))
      }
    }
    window.WebSocket = RecordingWebSocket as unknown as typeof WebSocket
  })
}

/** Every socket the app opened that declares a workspace. Vite's HMR socket
 *  carries no `landscapeId`, so this filter is exactly the sync population. */
async function workspaceSockets(page: Page): Promise<string[]> {
  const all = await page.evaluate((key) => {
    try {
      return JSON.parse(window.sessionStorage.getItem(key) ?? '[]') as string[]
    } catch {
      return [] as string[]
    }
  }, WS_LOG_KEY)
  return all.filter((url) => url.includes('landscapeId='))
}

function landscapeOf(socketUrl: string): string | null {
  try {
    return new URL(socketUrl).searchParams.get('landscapeId')
  } catch {
    return null
  }
}

/**
 * No socket opened since `since` may name a landscape other than `landscapeId`,
 * and none may name `default`.
 *
 * Scoped from a mark rather than from the beginning of time because the session
 * BOOTS into an org landscape whose id this test does not choose; from the moment
 * we enter a landscape we minted, any other id is a tear rather than a switch.
 *
 * Opening NO socket is a pass — a workspace already routed does not re-route, and
 * the whole regression is a socket that should not exist. The non-vacuous half
 * (a socket that must exist, scoped correctly) is asserted separately at each
 * landscape switch and across the reload.
 */
async function expectNoForeignSockets(page: Page, landscapeId: string, since: number): Promise<string[]> {
  const opened = (await workspaceSockets(page)).slice(since)
  const named = opened.map(landscapeOf)
  const where = `sockets opened since the mark: ${JSON.stringify(opened)}`
  expect(named, where).not.toContain('default')
  expect([...new Set(named)].filter((id) => id !== landscapeId), where).toEqual([])
  return opened
}

// ── UI drivers ───────────────────────────────────────────────────────────────

async function login(page: Page): Promise<void> {
  await page.goto('/app')
  const devLogin = page.getByTestId('dev-login-email')
  // The sign-in redirect lands a tick or more after `load`, and boot passes
  // THROUGH `/app` on its way to `/login`. A bare `isVisible()` here therefore
  // reads the page before it has decided, skips the submit, and the run dies on
  // the login screen 60 s later. Wait for whichever outcome actually arrives.
  await Promise.race([
    devLogin.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined),
    page.waitForURL(/\/app\/landscape\/[^/]+\/version\/[^/]+/, { timeout: 45_000 }).catch(() => undefined),
  ])
  if (await devLogin.isVisible().catch(() => false)) {
    await submitDevLogin(page, `e2e-dup-${Date.now()}@example.com`)
  }
  await page.waitForURL(/\/app\//, { timeout: 90_000 })
  // The route layer rewrites to the versioned URL once the bridge has landed on
  // the boot ref; every workspace assertion below reads that URL.
  await expect
    .poll(() => landscapeFromUrl(page), { timeout: 60_000, message: 'boot never produced a versioned URL' })
    .not.toBeNull()
}

/** The active workspace, read off the versioned URL (`/app/landscape/<id>/version/<id>/…`). */
function landscapeFromUrl(page: Page): string | null {
  try {
    return new URL(page.url()).pathname.match(/\/landscape\/([^/]+)\//)?.[1] ?? null
  } catch {
    return null
  }
}

/** Same, but the URL MUST be workspace-scoped — a bare `/app/…` means the route
 *  layer changed shape and every ref assertion below is meaningless. */
function requireLandscape(page: Page): string {
  const id = landscapeFromUrl(page)
  expect(id, `no /landscape/<id>/ segment in ${page.url()}`).not.toBeNull()
  return id!
}

/**
 * Create a landscape and land in it. Returns its id, taken from the URL — the
 * only place the app publishes the ref it actually switched to.
 */
// ── cleanup ledger ───────────────────────────────────────────────────────────
// Every landscape this spec creates must be gone at the end, pass or fail: a
// leftover workspace is a resident projector and an extra registry row that the
// NEXT run then has to reason about. The API origin is learned from the app's own
// traffic (the app talks to VITE_SYNC_API_URL, not the page origin); the session
// cookie is host-scoped, so `context.request` carries it.
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

test.afterEach(async ({ page }) => {
  const apiUrl = cleanupApiUrl
  if (!apiUrl) return
  for (const id of createdLandscapes.splice(0)) {
    try {
      await page.context().request.delete(apiUrl(`/api/landscapes/${encodeURIComponent(id)}`))
    } catch {
      /* best effort — teardown must never fail a run */
    }
  }
})

async function createLandscape(page: Page, name: string): Promise<string> {
  const previous = requireLandscape(page)
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('workspace-landscapes').click()
  await page.getByTestId('new-landscape-name').fill(name)
  await page.getByTestId('new-landscape-add').click()
  await expect(page.getByTestId('nav-menu')).toContainText(name, { timeout: 60_000 })
  await page.keyboard.press('Escape')
  await expect
    .poll(() => landscapeFromUrl(page), {
      timeout: 30_000,
      message: 'the URL never moved to the new landscape',
    })
    .not.toBe(previous)
  const created = requireLandscape(page)
  createdLandscapes.push(created)
  return created
}

/** Import a Structurizr DSL into the CURRENT landscape (the modal's default target). */
async function importDsl(page: Page, dsl: string): Promise<void> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  await page.getByTestId('create-diagram-button').click()
  await page.getByTestId('create-import').click()
  await page.getByTestId('import-textarea').fill(dsl)
  await page.getByTestId('import-parse').click()
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('import-error')).toHaveCount(0)
  await page.getByTestId('import-generate').click()
  await page.waitForURL(/\/diagram\//, { timeout: 60_000 })
}

async function gotoDiagrams(page: Page): Promise<void> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  await expect(page.locator('[data-testid^="diagram-card-"]').first()).toBeVisible({ timeout: 30_000 })
}

async function cardIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="diagram-card-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid')!.slice('diagram-card-'.length)),
    )
}

/** Rows on the Model Objects table — the model's size as the USER can see it. */
async function modelObjectRowCount(page: Page): Promise<number> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-model-objects').click()
  const scroll = page.getByTestId('mo-table-scroll')
  await expect(scroll).toBeVisible({ timeout: 30_000 })
  // The table mounts EMPTY and fills from the server read model a beat later, so
  // counting rows the moment the scroller appears reads 0 on a healthy workspace
  // (measured: 4 before the duplicate, 0 straight after — a pure read race, not a
  // change in the model). Wait for the explorer to settle, and read the count the
  // component itself publishes rather than the virtualized DOM, which only ever
  // renders the visible window.
  await expect(scroll).toHaveAttribute('data-refreshing', 'false', { timeout: 60_000 })
  await expect
    .poll(async () => Number(await scroll.getAttribute('data-loaded-row-count')), {
      timeout: 60_000,
      message: 'the model objects table never reported a row count',
    })
    .toBeGreaterThan(0)
  return Number(await scroll.getAttribute('data-loaded-row-count'))
}

// ── Store reads (assertions only) ────────────────────────────────────────────

async function snapshot(page: Page): Promise<ProbeSnapshot> {
  return page.evaluate(() => {
    const store = window.__modelStore
    if (!store) throw new Error('__modelStore probe missing — is this a dev build?')
    const state = store.getState()
    return {
      currentDiagramId: state.currentDiagramId ?? null,
      objectIds: state.objects.map((o) => o.id),
      objectNames: state.objects.map((o) => o.name),
      connectionCount: state.connections.length,
      groupCount: state.groups.length,
      diagramIds: state.diagrams.map((d) => d.id),
    }
  })
}

async function readDiagram(page: Page, id: string): Promise<ProbeDiagram | null> {
  return page.evaluate((diagramId) => {
    const store = window.__modelStore
    if (!store) throw new Error('__modelStore probe missing — is this a dev build?')
    const diagram = store.getState().diagrams.find((d) => d.id === diagramId)
    if (!diagram) return null
    return {
      id: diagram.id,
      name: diagram.name,
      type: diagram.type,
      objectIds: [...diagram.objectIds],
      connectionIds: [...diagram.connectionIds],
      groupIds: [...diagram.groupIds],
      // The store's value may be an Automerge proxy; hand back plain data.
      layouts: JSON.parse(JSON.stringify(diagram.layouts ?? {})) as Record<string, Placement>,
    }
  }, id)
}

/** The placements for exactly the diagram's members, in a stable shape to compare. */
function memberPlacements(diagram: ProbeDiagram): Record<string, Placement | undefined> {
  const out: Record<string, Placement | undefined> = {}
  for (const id of [...diagram.objectIds, ...diagram.groupIds]) out[id] = diagram.layouts[id]
  return out
}

/**
 * Select a card and wait until the store holds it FULLY — every member placed.
 * Selecting is how the app materialises a diagram; a card that has never been
 * selected is a layout-less stub, which is the whole premise of the source
 * resolver under test.
 *
 * A brand-new landscape is seeded with an EMPTY starter diagram
 * (`seedStarterDiagram`), which has nothing to place — waiting for a placement
 * there would hang on a diagram that is legitimately empty.
 */
async function selectAndMaterialise(page: Page, id: string): Promise<ProbeDiagram> {
  await page.getByTestId(`diagram-card-${id}`).click()
  await expect
    .poll(async () => (await snapshot(page)).currentDiagramId, { timeout: 30_000 })
    .toBe(id)
  await expect
    .poll(async () => (await readDiagram(page, id)) !== null, {
      timeout: 30_000,
      message: `diagram ${id} never appeared in the store after being selected`,
    })
    .toBe(true)

  const selected = (await readDiagram(page, id))!
  if ([...selected.objectIds, ...selected.groupIds].length === 0) return selected

  await expect
    .poll(
      async () => {
        const diagram = await readDiagram(page, id)
        if (!diagram) return false
        const members = [...diagram.objectIds, ...diagram.groupIds]
        return members.length > 0 && members.every((member) => diagram.layouts[member] !== undefined)
      },
      { timeout: 45_000, message: `diagram ${id} never became fully placed in the store` },
    )
    .toBe(true)
  return (await readDiagram(page, id))!
}

/** Wait for the workspace to report itself synced before betting a reload on it. */
async function waitForSynced(page: Page): Promise<void> {
  // NOT `data-status === 'ready'`: that is a durability latch that sits at
  // 'saving' indefinitely on a freshly created landscape, which Bravo is.
  // See e2e/support/workspaceReady.ts.
  await waitForWorkspaceProjected(page)
}

// Shared stateful backend — never let these run beside each other.
test.describe.configure({ mode: 'serial' })
test.use({ channel: process.env.PW_BROWSER_CHANNEL || undefined })

test('duplicating a diagram in a non-boot landscape copies THAT landscape\'s view, leaves the model alone, and survives a reload', async ({
  page,
}) => {
  // Two landscapes + two imports + a reload, all against a live backend.
  test.setTimeout(300_000)

  await installSocketRecorder(page)
  cleanupApiUrl = trackApiOrigin(page)
  await login(page)

  // ── Two landscapes, disjoint content ───────────────────────────────────────
  // Landscape A exists so that B is demonstrably not the first landscape of the
  // session and so that a cross-landscape read has somewhere wrong to land.
  const stamp = Date.now()
  const beforeA = (await workspaceSockets(page)).length
  const alpha = await createLandscape(page, `dup-e2e-alpha-${stamp}`)
  const openedForAlpha = [...new Set((await workspaceSockets(page)).slice(beforeA))]
  expect(openedForAlpha, 'entering a landscape must open exactly one workspace socket').toHaveLength(1)
  expect(landscapeOf(openedForAlpha[0])).toBe(alpha)
  await importDsl(page, ALPHA_DSL)

  const beforeB = (await workspaceSockets(page)).length
  const bravo = await createLandscape(page, `dup-e2e-bravo-${stamp}`)
  const openedForBravo = [...new Set((await workspaceSockets(page)).slice(beforeB))]
  expect(openedForBravo, 'entering a landscape must open exactly one workspace socket').toHaveLength(1)
  expect(landscapeOf(openedForBravo[0])).toBe(bravo)
  expect(bravo).not.toBe(alpha)
  await importDsl(page, BRAVO_DSL)

  // Everything from here on happens inside Bravo. Mark the socket log: past this
  // point a socket naming any other landscape is a tear, not a switch.
  const bravoMark = (await workspaceSockets(page)).length

  // ── Pick the source: the CONTAINER diagram, materialised, then deselected ───
  await gotoDiagrams(page)
  const ids = await cardIds(page)
  // 3 cards: the landscape's empty starter diagram plus the two generated views.
  expect(ids.length, 'the Bravo import must produce both generated views').toBeGreaterThanOrEqual(3)

  const materialised: ProbeDiagram[] = []
  for (const id of ids) materialised.push(await selectAndMaterialise(page, id))

  const source = materialised.find((d) => d.type === 'container')
  expect(source, 'the container view is the source — it is the one with a boundary group').toBeTruthy()
  // Park the selection on another NON-EMPTY diagram: the empty starter would
  // leave the store's active window empty and make the model counts below say
  // nothing.
  const other = materialised.find((d) => d.id !== source!.id && d.objectIds.length > 0)
  expect(other, 'the Bravo import must produce a second non-empty view').toBeTruthy()

  // Fixture preconditions, stated so a fixture drift fails HERE and not as a
  // confusing assertion about the copy.
  expect(source!.objectIds.length, 'source objects').toBeGreaterThanOrEqual(3)
  expect(source!.connectionIds.length, 'source connections').toBeGreaterThanOrEqual(1)
  expect(source!.groupIds.length, 'source groups — otherwise the group assertion is [] === []')
    .toBeGreaterThanOrEqual(1)
  const sourcePlacements = memberPlacements(source!)
  for (const [member, placement] of Object.entries(sourcePlacements)) {
    expect(placement, `source member ${member} has no placement`).toBeTruthy()
  }

  // Leave the source NOT active. This is the whole point: an active diagram is
  // served from the store (tier 1) and never touches the repo getters, so it
  // cannot witness the workspace-ref default at all.
  await selectAndMaterialise(page, other!.id)
  expect((await snapshot(page)).currentDiagramId).not.toBe(source!.id)

  // ── The model, measured through the UI, before the copy ────────────────────
  const objectRowsBefore = await modelObjectRowCount(page)
  expect(objectRowsBefore, 'the Model Objects table must show the imported model').toBeGreaterThanOrEqual(3)
  await gotoDiagrams(page)
  // Navigating away and back must not have re-activated the source.
  expect((await snapshot(page)).currentDiagramId).not.toBe(source!.id)

  // ── Duplicate ──────────────────────────────────────────────────────────────
  // Taken HERE, not before the Model Objects trip: in a windowed store, visiting
  // another page can hydrate more of the model, and a count compared across that
  // navigation would measure the navigation instead of the duplicate.
  const beforeSnapshot = await snapshot(page)
  const cardsBefore = await cardIds(page)
  await page.getByTestId(`diagram-card-${source!.id}`).hover()
  await page.getByTestId(`diagram-menu-${source!.id}`).click()
  await page.getByTestId('diagram-duplicate').click()
  // The menu closes in handleDuplicate's `finally` — that is the completion cue,
  // and waiting for it means a REFUSAL is reported as a refusal instead of as a
  // 25s timeout on "the new card never appeared".
  await expect(page.getByTestId('diagram-duplicate')).toHaveCount(0, { timeout: 60_000 })
  await expect(
    page.getByTestId('diagram-duplicate-error'),
    'the source could not be resolved — a wrong-workspace root looks exactly like this',
  ).toHaveCount(0)

  const cardsAfter = await cardIds(page)
  expect(cardsAfter).toHaveLength(cardsBefore.length + 1)
  const copyId = cardsAfter.find((id) => !cardsBefore.includes(id))!
  expect(copyId).toBeTruthy()

  // ── A: the copy is the SOURCE's view, composition and placement ────────────
  const copy = (await readDiagram(page, copyId))!
  expect(copy, 'the copy must be in the store').toBeTruthy()
  expect([...copy.objectIds].sort()).toEqual([...source!.objectIds].sort())
  expect([...copy.connectionIds].sort()).toEqual([...source!.connectionIds].sort())
  expect([...copy.groupIds].sort()).toEqual([...source!.groupIds].sort())
  expect(copy.type).toBe(source!.type)
  expect(memberPlacements(copy)).toEqual(sourcePlacements)
  // A distinct view, not an aliased one.
  expect(copy.id).not.toBe(source!.id)
  expect(copy.name).not.toBe(source!.name)

  const afterSnapshot = await snapshot(page)

  // ── B: F10 — the VIEW is duplicated, the MODEL is not ──────────────────────
  expect(afterSnapshot.objectIds).toHaveLength(beforeSnapshot.objectIds.length)
  expect(afterSnapshot.connectionCount).toBe(beforeSnapshot.connectionCount)
  expect(afterSnapshot.groupCount).toBe(beforeSnapshot.groupCount)
  expect(afterSnapshot.diagramIds.length).toBe(beforeSnapshot.diagramIds.length + 1)
  expect(await modelObjectRowCount(page), 'duplicating a view must not add a single model object')
    .toBe(objectRowsBefore)
  await gotoDiagrams(page)

  // ── A': it did not pull from another landscape ─────────────────────────────
  // NOT asserted against the store window as it stands: under boot-from-server
  // `state.objects` is a WINDOW around the ACTIVE diagram, and the active diagram
  // is deliberately `other` — the copy's members are legitimately absent from it,
  // so that comparison goes red on a perfectly correct copy (measured). Activate
  // the COPY and read the window it projects instead: an id copied out of another
  // landscape has nothing in Bravo to resolve to, so it cannot show up here.
  // Deliberately placed after the F10 block, whose two snapshots must be taken
  // through the same window.
  const copyWindow = await selectAndMaterialise(page, copyId)
  const copySnapshot = await snapshot(page)
  const residentObjects = new Set(copySnapshot.objectIds)
  for (const objectId of copyWindow.objectIds) {
    expect(residentObjects.has(objectId), `copied object ${objectId} does not resolve inside this landscape`)
      .toBe(true)
  }
  expect(
    copySnapshot.objectNames.filter((name) => name.startsWith('Alpha')),
    'landscape Alpha\'s vocabulary must never appear inside Bravo',
  ).toEqual([])

  // ── D: no socket was torn off Bravo by the duplicate ───────────────────────
  // With the pre-`ade9ce1f` default, `loadDiagramDuplicateSource` → getRootHandle()
  // → routeWorkspaceNetwork(DEFAULT_WORKSPACE_REF) opens exactly one socket here,
  // at `landscapeId=default`, and nothing in the UI says so.
  await expectNoForeignSockets(page, bravo, bravoMark)

  // ── C: survive a reload ────────────────────────────────────────────────────
  await waitForSynced(page)
  const reloadMark = (await workspaceSockets(page)).length
  await page.reload()
  await page.waitForURL(/\/app\//, { timeout: 60_000 })
  expect(requireLandscape(page), 'the reload must come back into Bravo').toBe(bravo)
  await gotoDiagrams(page)

  await expect(page.getByTestId(`diagram-card-${copyId}`)).toBeVisible({ timeout: 60_000 })
  // The card's own numbers, read off the UI, are the first proof it came back
  // with CONTENT and not just a name.
  await page.getByTestId(`diagram-card-${copyId}`).click()
  await expect(page.getByTestId('diagram-panel-object-count')).toHaveText(String(source!.objectIds.length))
  await expect(page.getByTestId('diagram-panel-connection-count')).toHaveText(
    String(source!.connectionIds.length),
  )

  // And the full composition + placement, re-materialised from durable storage.
  const reloaded = await selectAndMaterialise(page, copyId)
  expect([...reloaded.objectIds].sort()).toEqual([...source!.objectIds].sort())
  expect([...reloaded.connectionIds].sort()).toEqual([...source!.connectionIds].sort())
  expect([...reloaded.groupIds].sort()).toEqual([...source!.groupIds].sort())
  expect(memberPlacements(reloaded)).toEqual(sourcePlacements)

  // The source is untouched by its own duplication.
  const reloadedSource = await selectAndMaterialise(page, source!.id)
  expect([...reloadedSource.objectIds].sort()).toEqual([...source!.objectIds].sort())
  expect(memberPlacements(reloadedSource)).toEqual(sourcePlacements)

  // The model did not double across the reload either (regression 1's shape).
  // Measured on the Model Objects page, not on the store: the resident object
  // array is a WINDOW around the active diagram in boot-from-server mode, so
  // comparing it across a reload would compare two different windows.
  expect(await modelObjectRowCount(page), 'the model must not have grown across the reload')
    .toBe(objectRowsBefore)

  // ── D again: the reload re-opened the socket, and it is still Bravo's ──────
  const openedByReload = await expectNoForeignSockets(page, bravo, reloadMark)
  expect(openedByReload.length, 'the reload must re-open the workspace socket').toBeGreaterThan(0)
  expect([...new Set(openedByReload.map(landscapeOf))]).toEqual([bravo])
  // …and nothing across the whole Bravo phase named another landscape.
  await expectNoForeignSockets(page, bravo, bravoMark)
})
