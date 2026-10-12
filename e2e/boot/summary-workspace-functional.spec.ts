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
 * The ELEVEN functional controls of the summary migration, replayable.
 *
 * The summary migration is validated on a large workspace (10 000 diagrams)
 * with eleven controls driven by real clicks. They are named C1…C11 in the
 * assertion messages.
 *
 * THREE RULES ARE BUILT INTO THE SHAPE OF THIS FILE:
 *
 *  1. A WITNESS THAT SURVIVES THE ABSENCE OF THE FACT IS NOT A WITNESS.
 *     An edit control that only checks the sync badge passes when the drag
 *     missed every shape, because the badge has been green since boot. So C11 asserts the diagram's composition CHANGED,
 *     on the SERVER, before it looks at the badge — and when the gesture misses
 *     it fails saying the edit never happened, so the badge proves nothing.
 *     Same rule applied throughout: the fact first, the claim about the fact
 *     second.
 *  2. THE REAL INTERFACE, NEVER THE STORE. Every gesture here is a click or a drag on the real UI, and every
 *     oracle is either something on screen or something the SERVER says. Where
 *     an internal is read (`__bridgeDebug`, `__canvasEngine`) it is to
 *     DIAGNOSE — to state the boot contract, which has no UI surface, or to
 *     locate a connection so a PIXEL can answer — never as the oracle for a
 *     user-visible fact.
 *  3. A SKIP IS NOT A PASS. These controls mean nothing off a summary workspace.
 *     Name the workspace with `E2E_SUMMARY_LANDSCAPE` and "not summary" becomes
 *     a FAILURE; leave it unset and the suite skips with a reason. Same parti as
 *     `summary-diagram-delete.spec.ts`.
 *
 * NAVIGATION IS IN-APP. Never `page.goto` onto the diagrams / model / dependency
 * routes: a route entered by `goto` is not the route a user enters. Deep-linking the
 * WORKSPACE HOME in a cold context is not what that rule forbids, and the
 * suite still reaches every view through the nav menu.
 *
 * HOW TO RUN IT (example values for an isolated stack with a large summary workspace):
 *
 *   E2E_BOOT_URL=http://localhost:5197 E2E_BOOT_API=http://localhost:3021 \
 *   E2E_SUMMARY_LANDSCAPE=M8Kxam8LPTFiJvWB E2E_SUMMARY_VERSION=u6X5xp_PLKOzZZ0B \
 *   E2E_SUMMARY_OBJECT_TOTAL=100000 E2E_SUMMARY_CONNECTION_TOTAL=160000 \
 *   npx playwright test --project=boot e2e/boot/summary-workspace-functional.spec.ts
 *
 * The two TOTAL variables are optional and they STRENGTHEN the run: set, C5/C7
 * additionally require the displayed total to be at least the fixture's seeded
 * baseline (100 000 / 160 000 here). A FLOOR and not an equality, deliberately —
 * C11 adds a shape on every run, so the fixture's object total climbs.
 *
 * ⚠ NO VITE FLAGS ON THE STACK. The summary contract must come from the ROOT.
 * C1 asserts the session starts flagless AND classic on the default workspace,
 * so a stack carrying `VITE_BOOT_FROM_SERVER` fails there rather than passing
 * every later control for the wrong reason.
 *
 * ⚠ THE LOGIN MUST NOT LAND ON THE TARGET. C1 is about the IN-APP SWITCH. If
 * the declared workspace is also the default one, there is no switch to
 * exercise and the suite says so instead of pretending.
 */

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { syncBar } from '../support/workspaceReady'
import { dragNewShapeToCanvas } from './helpers'

const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3002'
const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'
/** When set, the stack DECLARES it has a summary workspace: a missing contract
 * is then a defect in the stack or the app, never a reason to skip. */
const SUMMARY_LANDSCAPE = process.env.E2E_SUMMARY_LANDSCAPE ?? null
const SUMMARY_VERSION = process.env.E2E_SUMMARY_VERSION ?? null

function declaredTotal(name: string): number | null {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} is not a number: ${raw}`)
  return value
}
const OBJECT_TOTAL = declaredTotal('E2E_SUMMARY_OBJECT_TOTAL')
const CONNECTION_TOTAL = declaredTotal('E2E_SUMMARY_CONNECTION_TOTAL')

interface Workspace { landscapeId: string; versionId: string }

interface Contract {
  /** The boot-from-server FLAG (build + localStorage override), not the regime. */
  flagBootFromServer: boolean
  flagServerReadModel: boolean
  bfsActive: boolean | null
  registrySummaryOnly: boolean | null
  /** How many diagram metas the RESIDENT registry shards carry. 10 000 in a
   * classic boot of this fixture; a handful under the summary contract. */
  registryMetaCount: number | null
  residentDiagrams: number
  residentObjects: number
  residentConnections: number
  currentDiagramId: string | null
}

type ProbeWindow = Window & {
  __bridgeDebug?: () => {
    bfsActive?: boolean
    registrySummaryOnly?: boolean
    registryMetaIds?: string[]
  }
  __bootFromServer?: { enabled?: () => boolean }
  __serverReadModel?: { enabled?: () => boolean }
  __modelStore?: {
    getState: () => {
      diagrams: Array<{ id: string; objectIds?: string[]; layouts?: Record<string, unknown> }>
      objects: Array<{ id: string }>
      connections: Array<{ id: string }>
      currentDiagramId: string | null
    }
  }
}

// ── entering the app ────────────────────────────────────────────────────────

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

/** Sign in with the three runtime overrides CLEARED, so nothing about the boot
 * contract can come from this browser profile. */
async function enterFlaglessApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('maplespire:bootFromServer')
    localStorage.removeItem('maplespire:serverReadModel')
    localStorage.removeItem('maplespire:modelPaging')
  })
  await signIn(page)
  await waitForBootedWorkspace(page)
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

/** The nav menu is a TOGGLE and it closes itself after a navigation, so one
 * blind click is a coin flip. Click until the item we want is really there. */
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

async function readContract(page: Page): Promise<Contract> {
  return page.evaluate(() => {
    const w = window as ProbeWindow
    const debug = w.__bridgeDebug?.() ?? null
    const state = w.__modelStore?.getState() ?? null
    return {
      flagBootFromServer: w.__bootFromServer?.enabled?.() ?? false,
      flagServerReadModel: w.__serverReadModel?.enabled?.() ?? false,
      bfsActive: debug?.bfsActive ?? null,
      registrySummaryOnly: debug?.registrySummaryOnly ?? null,
      registryMetaCount: Array.isArray(debug?.registryMetaIds) ? debug.registryMetaIds.length : null,
      residentDiagrams: state?.diagrams.length ?? -1,
      residentObjects: state?.objects.length ?? -1,
      residentConnections: state?.connections.length ?? -1,
      currentDiagramId: state?.currentDiagramId ?? null,
    }
  })
}

/** The workspace the address bar names — the API calls must target THAT one.
 * Read from the URL, not from a store: the URL is what the user is on. */
function workspaceFromUrl(page: Page): Workspace {
  const found = new URL(page.url()).pathname.match(/\/app\/landscape\/([^/]+)\/version\/([^/]+)/)
  if (!found) throw new Error(`the address bar does not name a workspace: ${page.url()}`)
  return { landscapeId: found[1], versionId: found[2] }
}

function diagramFromUrl(page: Page): string | null {
  return new URL(page.url()).pathname.match(/\/diagram\/([^/?#]+)/)?.[1] ?? null
}

/**
 * THE gesture C1 is about: switch landscape by clicking what a user clicks.
 * Never a `goto` onto the target workspace — the whole question is whether the
 * contract follows an IN-APP switch, and a fresh navigation would boot it from
 * scratch and answer a different question.
 */
async function switchLandscapeInApp(page: Page, landscapeId: string): Promise<void> {
  await openNav(page, 'workspace-landscapes')
  await page.getByTestId('workspace-landscapes').click({ timeout: 30_000 })
  const entry = page.locator(`[data-testid="landscape-switch"][data-landscape-id="${landscapeId}"]`)
  await expect(
    entry,
    `the landscape switcher never offered ${landscapeId} — is the declared workspace visible to ${DEV_EMAIL}?`,
  ).toBeVisible({ timeout: 30_000 })
  await entry.click()
  await page.waitForURL(new RegExp(`/app/landscape/${landscapeId}/`), { timeout: 90_000 })
  await waitForBootedWorkspace(page)
  await expect
    .poll(async () => (await readContract(page)).registrySummaryOnly, {
      timeout: 90_000,
      message: 'the bridge never reported a boot contract after the in-app switch',
    })
    .not.toBeNull()
}

/**
 * Skip only on a stack that never claimed to have a summary workspace. When
 * `E2E_SUMMARY_LANDSCAPE` names one, "not summary" is a FAILURE — a skip must
 * never be mistakable for a pass in the record.
 */
function requireDeclaration(): string {
  test.skip(
    SUMMARY_LANDSCAPE === null,
    'this stack declares no summary workspace; T8 has nothing to exercise here — set '
    + 'E2E_SUMMARY_LANDSCAPE/E2E_SUMMARY_VERSION to a promoted or performance-seeded workspace',
  )
  return SUMMARY_LANDSCAPE!
}

/** Sign in flagless, prove the landing session is CLASSIC, then switch IN-APP. */
async function enterSummaryWorkspaceInApp(page: Page): Promise<{ before: Contract; after: Contract }> {
  const target = requireDeclaration()
  await enterFlaglessApp(page)

  const before = await readContract(page)
  const landing = workspaceFromUrl(page)
  expect(
    landing.landscapeId,
    `the login already lands on ${target}, so there is no in-app switch to exercise (C1). Make another `
    + 'landscape the default for this account, or point E2E_SUMMARY_LANDSCAPE at a non-default one.',
  ).not.toBe(target)
  expect(
    before.flagBootFromServer,
    'this stack carries the boot-from-server FLAG — with it set, C1 cannot attribute the summary '
    + 'contract to the root. Clear VITE_BOOT_FROM_SERVER and restart Vite.',
  ).toBe(false)
  expect(
    before.flagServerReadModel,
    'this stack carries the server-read-model FLAG; same reason as above.',
  ).toBe(false)
  expect(
    before.registrySummaryOnly,
    'the landing workspace is already summary-only, so the switch cannot show a contract CHANGE',
  ).toBe(false)

  await switchLandscapeInApp(page, target)
  const after = await readContract(page)
  expect(
    after.registrySummaryOnly,
    `E2E_SUMMARY_LANDSCAPE=${target} is not running the summary contract — the run is VOID, not green`,
  ).toBe(true)
  return { before, after }
}

/** A cold client: brand-new context, brand-new profile. A warm one reads its own
 * IndexedDB and would confirm nothing about the server.
 *
 * `baseURL` is passed EXPLICITLY. `browser.newContext()` does not inherit the
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
  await page.goto(`/app/landscape/${target}/version/${SUMMARY_VERSION ?? 'current'}`, { waitUntil: 'domcontentloaded' })
  await waitForBootedWorkspace(page)
  await expect
    .poll(async () => (await readContract(page)).registrySummaryOnly, { timeout: 90_000 })
    .toBe(true)
}

// ── server witnesses ────────────────────────────────────────────────────────

/** The SERVER's view of a diagram's composition. Independent of the client
 * store, of IndexedDB, and of anything the recovering party feeds. */
async function serverRender(
  page: Page,
  workspace: Workspace,
  diagramId: string,
): Promise<{ objects: string[]; connections: string[] } | null> {
  const response = await page.request.get(
    `${API_BASE}/api/model/diagram-render?landscapeId=${workspace.landscapeId}`
    + `&versionId=${workspace.versionId}&id=${encodeURIComponent(diagramId)}`,
  )
  if (!response.ok()) return null
  const body = await response.json() as {
    objects?: Array<{ id: string }>
    connections?: Array<{ id: string }>
  }
  return {
    objects: (body.objects ?? []).map((o) => o.id),
    connections: (body.connections ?? []).map((c) => c.id),
  }
}

async function serverDiagramMeta(
  page: Page,
  workspace: Workspace,
  diagramId: string,
): Promise<{ id: string; name: string } | null> {
  const response = await page.request.get(
    `${API_BASE}/api/model/diagram-meta?landscapeId=${workspace.landscapeId}`
    + `&versionId=${workspace.versionId}&id=${encodeURIComponent(diagramId)}`,
  )
  if (!response.ok()) return null
  const body = await response.json() as { diagram?: { id: string; name: string } }
  return body.diagram ?? null
}

/** How many diagrams the workspace really holds, server-side. C2's anti-void
 * guard: "the resident registry is small" says nothing unless the workspace is
 * big. */
async function serverDiagramTotal(page: Page, workspace: Workspace): Promise<number> {
  const response = await page.request.get(
    `${API_BASE}/api/model/diagrams/page?landscapeId=${workspace.landscapeId}`
    + `&versionId=${workspace.versionId}&limit=1`,
  )
  expect(response.ok(), `the server would not page this workspace's diagrams: ${response.status()}`).toBe(true)
  const body = await response.json() as { total?: number }
  return body.total ?? -1
}

// ── the canvas, answered by PIXELS ──────────────────────────────────────────

/**
 * A canvas can hold `layouts = 10` with 0 members resolved and 0 pixels drawn:
 * a state-level assertion would call that a rendered canvas. So C3 asks the
 * framebuffer.
 *
 * Background is the MODAL colour, never pixel (0,0) — the corner is chrome on
 * some skins, so "differs from the corner" can report ink on an empty canvas. Nothing large is retained: three integers come back, never the image.
 */
interface CanvasInk {
  found: boolean
  width: number
  height: number
  sampled: number
  nonBackground: number
  distinctColours: number
  /** Members of the active diagram that RESOLVED into the session's window. */
  memberExpected: number | null
  memberResolved: number | null
  /** Connections whose on-path midpoint lies clear of every shape rectangle. */
  connectionsWithClearPoint: number
  /** …and how many of those really have ink on them. */
  connectionsPainted: number
  connections: number
}

async function readCanvasInk(page: Page): Promise<CanvasInk> {
  return page.evaluate(() => {
    const empty: CanvasInk = {
      found: false, width: 0, height: 0, sampled: 0, nonBackground: 0, distinctColours: 0,
      memberExpected: null, memberResolved: null,
      connectionsWithClearPoint: 0, connectionsPainted: 0, connections: 0,
    }
    const canvas = [...document.querySelectorAll('canvas')]
      .filter((c) => c.width > 200 && c.height > 200)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0]
    if (!canvas) return empty
    const context = canvas.getContext('2d')
    if (!context) return empty
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    const data = image.data
    const step = 4 * 7 // one pixel in seven; the answer is a share, not a census

    const histogram = new Map<number, number>()
    for (let i = 0; i < data.length; i += step) {
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
      histogram.set(key, (histogram.get(key) ?? 0) + 1)
    }
    let modeKey = 0
    let modeCount = -1
    for (const [key, count] of histogram) if (count > modeCount) { modeCount = count; modeKey = key }
    const bg = [((modeKey >> 8) & 15) << 4, ((modeKey >> 4) & 15) << 4, (modeKey & 15) << 4]

    let sampled = 0
    let nonBackground = 0
    for (let i = 0; i < data.length; i += step) {
      sampled += 1
      if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 40) {
        nonBackground += 1
      }
    }

    // Members of the active diagram that this session actually resolved.
    const state = (window as ProbeWindow).__modelStore?.getState() ?? null
    const diagram = state ? state.diagrams.find((d) => d.id === state.currentDiagramId) : undefined
    const memberExpected = diagram?.objectIds?.length ?? null
    const resident = new Set((state?.objects ?? []).map((o) => o.id))
    const memberResolved = diagram?.objectIds
      ? diagram.objectIds.filter((id) => resident.has(id)).length
      : null

    // Connections: the engine LOCATES the path, the pixel ANSWERS. A midpoint
    // inside a shape rectangle is discarded rather than counted, so shape fill
    // can never be mistaken for edge ink.
    interface Geometry {
      fromLineX: number; fromLineY: number; cp1x: number; cp1y: number
      cp2x: number; cp2y: number; toLineX: number; toLineY: number
    }
    interface Engine {
      connections?: Array<{ id: string }>
      objectMap?: Map<string, { position: { x: number; y: number }; size: { width: number; height: number } }>
      viewport?: { x: number; y: number; scale: number }
      canvas?: HTMLCanvasElement
      getConnectionGeometry?: (connection: { id: string }) => Geometry | null
    }
    const engine = (window as unknown as { __canvasEngine?: Engine }).__canvasEngine
    let connections = 0
    let connectionsWithClearPoint = 0
    let connectionsPainted = 0
    if (engine?.viewport && engine.canvas === canvas && engine.getConnectionGeometry) {
      const viewport = engine.viewport
      const dpr = canvas.width / canvas.clientWidth
      const inkAt = (x: number, y: number): boolean => {
        const px = Math.round(x * dpr)
        const py = Math.round(y * dpr)
        if (px < 0 || py < 0 || px >= image.width || py >= image.height) return false
        const i = (py * image.width + px) * 4
        return Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 30
      }
      const rects = [...(engine.objectMap ?? new Map()).values()].map((o) => ({
        x: o.position.x * viewport.scale + viewport.x,
        y: o.position.y * viewport.scale + viewport.y,
        w: o.size.width * viewport.scale,
        h: o.size.height * viewport.scale,
      }))
      const insideShape = (x: number, y: number): boolean =>
        rects.some((r) => x >= r.x - 4 && x <= r.x + r.w + 4 && y >= r.y - 4 && y <= r.y + r.h + 4)
      const bezier = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
        const u = 1 - t
        return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
      }
      const all = engine.connections ?? []
      connections = all.length
      for (const connection of all) {
        let geometry: Geometry | null
        try { geometry = engine.getConnectionGeometry(connection) } catch { geometry = null }
        if (!geometry) continue
        let clear = false
        let painted = false
        for (const t of [0.5, 0.4, 0.6, 0.3, 0.7]) {
          const sx = bezier(geometry.fromLineX, geometry.cp1x, geometry.cp2x, geometry.toLineX, t) * viewport.scale + viewport.x
          const sy = bezier(geometry.fromLineY, geometry.cp1y, geometry.cp2y, geometry.toLineY, t) * viewport.scale + viewport.y
          if (insideShape(sx, sy)) continue
          clear = true
          for (let dx = -3; dx <= 3 && !painted; dx += 1) {
            for (let dy = -3; dy <= 3; dy += 1) if (inkAt(sx + dx, sy + dy)) { painted = true; break }
          }
          if (painted) break
        }
        if (clear) connectionsWithClearPoint += 1
        if (painted) connectionsPainted += 1
      }
    }

    return {
      found: true,
      width: canvas.width,
      height: canvas.height,
      sampled,
      nonBackground,
      distinctColours: histogram.size,
      memberExpected,
      memberResolved,
      connectionsWithClearPoint,
      connectionsPainted,
      connections,
    }
  })
}

/** Put the whole diagram in view through the real zoom control before reading
 * pixels — a viewport parked on empty space is a black screen that is nobody's
 * defect. */
async function fitCanvasInApp(page: Page): Promise<void> {
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('canvas-zoom-fit').click({ timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(1_500)
}

// ── list-page helpers ───────────────────────────────────────────────────────

/** The number the footer SHOWS. Not "the biggest integer on the page" — that
 * one survives the footer being wrong, which is exactly the failure mode C11's
 * history warns about. */
async function footerTotal(page: Page, testId: string): Promise<number> {
  const text = (await page.getByTestId(testId).innerText()).replace(/[^\d]/g, '')
  return text === '' ? Number.NaN : Number(text)
}

async function residentIds(page: Page, kind: 'objects' | 'connections'): Promise<Set<string>> {
  const ids = await page.evaluate((which) => {
    const state = (window as ProbeWindow).__modelStore?.getState()
    return (which === 'objects' ? state?.objects ?? [] : state?.connections ?? []).map((e) => e.id)
  }, kind)
  return new Set(ids)
}

/**
 * The entity ids of the rows actually on screen. Both tables also emit
 * `…-row-menu-<id>` / `…-row-delete-<id>` testids under the same prefix, and
 * those slice down to a string that is in NO id set — which would inflate the
 * "off-window" count with pure chrome. They are dropped here, at the source.
 */
async function renderedRowIds(page: Page, prefix: string): Promise<string[]> {
  const ids: string[] = await page.locator(`[data-testid^="${prefix}"]`).evaluateAll(
    (nodes, p) => nodes.map((node) => node.getAttribute('data-testid')!.slice(p.length)),
    prefix,
  )
  return ids.filter((id) => !id.startsWith('menu-') && !id.startsWith('delete-'))
}

/**
 * Find a diagram the way a user does on a 10 000-diagram workspace: the
 * diagrams list and its search field. Returns the card locator, already
 * asserted visible.
 *
 * `name` is a LOCATOR, not the verdict — it is what gets typed into the search
 * box. The assertion is `diagram-card-<id>`, which is the diagram's identity and
 * cannot be satisfied by some other diagram with a similar name.
 */
async function findDiagramCardInApp(page: Page, diagramId: string, name: string) {
  await openNav(page, 'nav-diagrams')
  await page.getByTestId('nav-diagrams').click({ timeout: 30_000 })
  const search = page.getByTestId('diagrams-search')
  await expect(search, 'the diagrams list never mounted').toBeVisible({ timeout: 60_000 })
  await search.fill(name)
  const card = page.getByTestId(`diagram-card-${diagramId}`)
  await expect(card, `the diagrams list never showed ${diagramId} ("${name}")`).toBeVisible({ timeout: 60_000 })
  return card
}

/** …and open it. A single click SELECTS the card; the OPEN gesture is the
 * double-click (`onDoubleClick={handleGoToDiagram}`) or the right panel's
 * "open in editor". Clicking once and waiting for a navigation would wait
 * forever. */
async function openDiagramInApp(page: Page, diagramId: string, name: string): Promise<void> {
  const card = await findDiagramCardInApp(page, diagramId, name)
  await card.dblclick()
  await page.waitForURL(new RegExp(`/diagram/${diagramId}(?:[/?#]|$)`), { timeout: 60_000 })
  await waitForBootedWorkspace(page)
}


// ────────────────────────────────────────────────────────────────────────────

/** Each test boots a 10 000-diagram workspace at least once, and two of them
 * boot a second, COLD client on top. The config's 120 s is a canvas-suite
 * budget, not this one's. */
const BUDGET_MS = 420_000

test.describe('T8 — vérification fonctionnelle de l\'espace summary migré', () => {
  test('C1-C3 — la bascule IN-APP prend le contrat summary sans drapeau, sans matérialiser les tessons, et le canevas peint', async ({ page }) => {
    test.setTimeout(BUDGET_MS)
    const { before, after } = await enterSummaryWorkspaceInApp(page)
    const workspace = workspaceFromUrl(page)

    // ── C1 ──────────────────────────────────────────────────────────────────
    // The session was flagless and classic a moment ago (asserted in
    // `enterSummaryWorkspaceInApp`); it is summary now, and the FLAG is still
    // off. Nothing but the root can have decided that.
    expect(
      after.flagBootFromServer,
      'C1: the boot-from-server flag turned itself on during the switch — then the contract is not '
      + 'attributable to the root, and this whole suite is measuring the flag',
    ).toBe(false)
    expect(
      after.bfsActive,
      `C1: the in-app switch did not take the boot-from-server regime (before=${JSON.stringify(before)}, `
      + `after=${JSON.stringify(after)})`,
    ).toBe(true)
    expect(after.registrySummaryOnly, 'C1: the in-app switch did not take the summary contract').toBe(true)

    // ── C2 ──────────────────────────────────────────────────────────────────
    // Anti-void first: "few resident metas" says nothing on a small workspace.
    const totalDiagrams = await serverDiagramTotal(page, workspace)
    expect(
      totalDiagrams,
      'C2 is VOID on a workspace this small — the control is about NOT materialising a large baseline',
    ).toBeGreaterThan(1_000)
    expect(after.registryMetaCount, 'C2: the bridge reported no registry metas at all').not.toBeNull()
    expect(
      after.registryMetaCount!,
      `C2: the baseline registry shards ARE materialised — ${after.registryMetaCount} diagram metas are `
      + `resident out of ${totalDiagrams} on the server (a classic boot of this fixture resolves 51 shards `
      + 'carrying all of them)',
    ).toBeLessThan(50)

    // ── C3 ──────────────────────────────────────────────────────────────────
    const active = after.currentDiagramId
    expect(active, 'C3: no diagram is open after the switch').toBeTruthy()
    const render = await serverRender(page, workspace, active!)
    expect(render, `C3: the server would not render the active diagram ${active}`).not.toBeNull()
    // Anti-void: a diagram with no connections cannot prove connections paint.
    expect(render!.objects.length, 'C3 is VOID: the active diagram carries no objects').toBeGreaterThan(0)
    expect(render!.connections.length, 'C3 is VOID: the active diagram carries no connections').toBeGreaterThan(0)

    await fitCanvasInApp(page)
    const ink = await readCanvasInk(page)
    expect(ink.found, 'C3: there is no canvas on screen').toBe(true)
    // The discriminator: a classic boot of this fixture can resolve 0 members
    // of 10 and draw 0 pixels while `layouts` says 10.
    expect(
      ink.memberResolved,
      `C3: the diagram's members did not resolve — ${ink.memberResolved} of ${ink.memberExpected}. `
      + 'A canvas with unresolved members draws nothing, whatever the layouts say.',
    ).toBe(ink.memberExpected)
    expect(
      ink.nonBackground,
      `C3: the canvas is BLANK — ${ink.nonBackground} non-background pixels of ${ink.sampled} sampled. `
      + 'State-level assertions pass on exactly this screen; pixels do not.',
    ).toBeGreaterThan(ink.sampled * 0.01)
    expect(ink.distinctColours, 'C3: the canvas shows a single flat colour').toBeGreaterThan(5)
    // …and the connections are DRAWN, not merely present in the model. Sampled
    // clear of every shape rectangle, so shape fill cannot answer for an edge.
    expect(
      ink.connectionsWithClearPoint,
      `C3 is VOID for connections: none of the ${ink.connections} connections has an on-path point clear `
      + 'of every shape, so no pixel could distinguish edge ink from shape fill',
    ).toBeGreaterThan(0)
    expect(
      ink.connectionsPainted,
      `C3: connections are not painted — ${ink.connectionsPainted} of ${ink.connectionsWithClearPoint} `
      + 'connections with a clear on-path point have ink on them',
    ).toBeGreaterThanOrEqual(Math.max(1, Math.floor(ink.connectionsWithClearPoint * 0.5)))
  })

  test('C4-C8 — Objets du modèle, Connexions du modèle et Dépendances rendent les données du SERVEUR', async ({ page }) => {
    test.setTimeout(BUDGET_MS)
    const { after } = await enterSummaryWorkspaceInApp(page)
    const residentObjects = after.residentObjects
    const residentConnections = after.residentConnections

    // ── C4 / C5 — Model Objects ─────────────────────────────────────────────
    await openNav(page, 'nav-model-objects')
    await page.getByTestId('nav-model-objects').click({ timeout: 30_000 })
    await expect(page.getByTestId('mo-search'), 'C4: the Model Objects page never mounted').toBeVisible({ timeout: 60_000 })
    await expect
      .poll(async () => (await renderedRowIds(page, 'mo-row-')).length, { timeout: 60_000 })
      .toBeGreaterThan(0)
    const objectRows = await renderedRowIds(page, 'mo-row-')
    const residentObjectIds = await residentIds(page, 'objects')
    const offWindowObjectRows = objectRows.filter((id) => !residentObjectIds.has(id))
    expect(
      offWindowObjectRows.length,
      `C4: every one of the ${objectRows.length} rendered rows is an object this session already holds `
      + `(${residentObjectIds.size} resident) — the page is showing the local window, not the model`,
    ).toBeGreaterThan(0)

    const shownObjects = await footerTotal(page, 'ws-footer-total-objects')
    expect(Number.isFinite(shownObjects), 'C5: the objects total is not a number').toBe(true)
    expect(shownObjects, 'C5: the objects total is not a whole-model number').toBeGreaterThan(1_000)
    expect(
      shownObjects,
      `C5: the objects total (${shownObjects}) is within reach of the ${residentObjects}-object resident `
      + 'window, so this run cannot tell a server total from a local one',
    ).toBeGreaterThan(residentObjects * 10)
    if (OBJECT_TOTAL !== null) {
      // A FLOOR, not an equality. C11 drops a shape on the fixture every run, so
      // the seeded 100 000 becomes 100 001, 100 002… A `toBe` here would forbid
      // its own suite's writes.
      expect(
        shownObjects,
        `C5: the objects total (${shownObjects}) is BELOW the declared baseline ${OBJECT_TOTAL} — objects `
        + 'have gone missing from the model, or the page is not showing the server total',
      ).toBeGreaterThanOrEqual(OBJECT_TOTAL)
    }

    // ── C6 / C7 — Model Connections ─────────────────────────────────────────
    await openNav(page, 'nav-connections')
    await page.getByTestId('nav-connections').click({ timeout: 30_000 })
    await expect
      .poll(async () => (await renderedRowIds(page, 'connection-row-')).length, {
        timeout: 60_000,
        message: 'C6: the Model Connections page rendered no rows',
      })
      .toBeGreaterThan(0)
    const connectionRows = await renderedRowIds(page, 'connection-row-')
    const residentConnectionIds = await residentIds(page, 'connections')
    expect(
      connectionRows.filter((id) => !residentConnectionIds.has(id)).length,
      `C6: every one of the ${connectionRows.length} rendered connection rows is already resident `
      + `(${residentConnectionIds.size}) — the page is showing the local window`,
    ).toBeGreaterThan(0)

    const shownConnections = await footerTotal(page, 'ws-footer-total-connections')
    expect(Number.isFinite(shownConnections), 'C7: the connections total is not a number').toBe(true)
    expect(shownConnections, 'C7: the connections total is not a whole-model number').toBeGreaterThan(1_000)
    expect(
      shownConnections,
      `C7: the connections total (${shownConnections}) is within reach of the ${residentConnections}-connection `
      + 'resident window',
    ).toBeGreaterThan(residentConnections * 10)
    if (CONNECTION_TOTAL !== null) {
      expect(
        shownConnections,
        `C7: the connections total (${shownConnections}) is BELOW the declared baseline ${CONNECTION_TOTAL}`,
      ).toBeGreaterThanOrEqual(CONNECTION_TOTAL)
    }

    // ── C8 — Dependencies ───────────────────────────────────────────────────
    await openNav(page, 'nav-dependencies')
    await page.getByTestId('nav-dependencies').click({ timeout: 30_000 })
    await expect(page.getByTestId('focus-picker-trigger'), 'C8: the Dependencies page never mounted').toBeVisible({ timeout: 60_000 })
    // The focus CARD is the assertion, not the picker: the picker is chrome that
    // renders before anything is resolved, so a page stuck on "Chargement…"
    // would still show it. The card exists only once an entity resolved.
    await expect(
      page.getByTestId('dep-card-focus'),
      'C8: Dependencies mounted but never resolved a focus entity — the page is chrome over nothing',
    ).toBeVisible({ timeout: 60_000 })
  })

  test('C9-C10 — créer un diagramme marche, et il survit à un boot À FROID', async ({ page, browser }) => {
    test.setTimeout(BUDGET_MS)
    await enterSummaryWorkspaceInApp(page)
    const beforeId = diagramFromUrl(page)

    // ── C9 ──────────────────────────────────────────────────────────────────
    await openNav(page, 'create-diagram-context')
    await page.getByTestId('create-diagram-context').click({ timeout: 30_000 })
    await page.waitForURL(
      (url) => /\/diagram\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(`/diagram/${beforeId}`),
      { timeout: 90_000 },
    )
    const createdId = diagramFromUrl(page)
    expect(createdId, 'C9: creating a diagram did not land on a new diagram route').toBeTruthy()
    expect(createdId, 'C9: the route did not change — the click was a no-op').not.toBe(beforeId)

    // REACHABILITY FIRST, THE BADGE SECOND. A diagram the app cannot get back
    // to is not a created diagram, whatever the badge says. The nav menu lists
    // the RESIDENT registry, which under a summary contract is the window plus
    // this session's own creations — so it is the affordance a user has.
    //
    // ⚠ NEITHER THE SERVER READ MODEL NOR THE DIAGRAMS LIST IS THE WITNESS
    // HERE. On a summary workspace a creation goes to the registry WRITE HEAD
    // (`captureSummaryLocalDiagram`, bridge.ts); it reaches `ro_diagrams` and
    // the Diagrams page only through the projector's `registry-shard` branch.
    // That path is asserted — with a cold-profile oracle the client cannot
    // fake — in `summary-workspace-diagram-visible.spec.ts`. It stays out of
    // THIS control on purpose: C9/C10 are about the write head being durable and reachable,
    // and they must keep failing for that reason alone if it ever regresses.
    //
    // What is asserted is what durability actually rests on: the write head,
    // via the nav menu now and via a client holding nothing of its own in C10.
    await openNav(page, 'nav-diagrams')
    await expect(
      page.getByTestId(`nav-diagram-${createdId}`),
      `C9: the created diagram ${createdId} is not listed anywhere the user can click — the creation went `
      + 'nowhere the app can get back to',
    ).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Escape')
    await expect(syncBar(page), 'C9: the sync badge never settled after the creation')
      .toHaveAttribute('data-status', 'ready', { timeout: 120_000 })

    // ── C10 — a SECOND, brand-new profile ───────────────────────────────────
    // The only honest durability witness available for this write: a client
    // whose IndexedDB is empty, which can therefore only have got the diagram
    // from the server. Reloading the SAME tab would only be a warm client
    // confirming its own cache.
    const cold = await coldContext(browser)
    try {
      await enterSummaryWorkspaceCold(cold.page)
      await openNav(cold.page, 'nav-diagrams')
      const entry = cold.page.getByTestId(`nav-diagram-${createdId}`)
      await expect(
        entry,
        `C10: a brand-new profile does not see the diagram ${createdId} created by the warm one — the `
        + 'creation was never durable, only local',
      ).toBeVisible({ timeout: 60_000 })
      await entry.click()
      await cold.page.waitForURL(new RegExp(`/diagram/${createdId}(?:[/?#]|$)`), { timeout: 60_000 })
      await expect(cold.page.locator('canvas').first(), 'C10: the cold client opened the diagram on no canvas')
        .toBeVisible({ timeout: 60_000 })
    } finally {
      await cold.context.close()
    }
  })

  test('C11 — éditer une forme porte le diagramme de N à N+1, le badge revient, et l\'édition survit à un boot À FROID', async ({ page, browser }) => {
    test.setTimeout(BUDGET_MS)
    await enterSummaryWorkspaceInApp(page)
    const workspace = workspaceFromUrl(page)
    const diagramId = diagramFromUrl(page)
    expect(diagramId, 'C11: no diagram is open after the switch').toBeTruthy()
    const meta = await serverDiagramMeta(page, workspace, diagramId!)
    expect(meta, `C11: the server does not know the active diagram ${diagramId}`).not.toBeNull()

    const before = await serverRender(page, workspace, diagramId!)
    expect(before, 'C11: the server would not render the active diagram').not.toBeNull()
    const n = before!.objects.length

    // The gesture: a real HTML5 drag from the "Formes" create palette onto the
    // real canvas. `dragNewShapeToCanvas` throws when the drop produces no new
    // object, which is the honest outcome of a gesture that missed.
    await fitCanvasInApp(page)
    const newObjectId = await dragNewShapeToCanvas(page, 'system')

    // ── THE FACT, on the SERVER, BEFORE the badge ───────────────────────────
    // This ordering is rule 1 of the file header. If the composition never
    // moved, the badge is green from boot and proves nothing — so it is never
    // reached.
    await expect
      .poll(async () => (await serverRender(page, workspace, diagramId!))?.objects.length ?? -1, {
        timeout: 120_000,
        message: `C11: the diagram's composition never went from ${n} to ${n + 1} on the server. The edit `
          + 'never landed, so the sync badge proves NOTHING about it — do not read a green badge here.',
      })
      .toBe(n + 1)
    const after = (await serverRender(page, workspace, diagramId!))!
    expect(after.objects, 'C11: the composition grew, but not by the shape that was dropped').toContain(newObjectId)

    // …and only NOW the badge, which must SETTLE rather than wedge.
    await expect(syncBar(page), 'C11: the sync badge never returned to « Synchronisé » after a landed edit')
      .toHaveAttribute('data-status', 'ready', { timeout: 120_000 })

    // ── the COLD half ───────────────────────────────────────────────────────
    const cold = await coldContext(browser)
    try {
      await enterSummaryWorkspaceCold(cold.page)
      await openDiagramInApp(cold.page, diagramId!, meta!.name)
      // The server still carries it…
      const coldRender = await serverRender(cold.page, workspace, diagramId!)
      expect(coldRender?.objects, 'C11: the server lost the added shape').toContain(newObjectId)
      // …and the cold client RESOLVED it into the diagram it draws. A row in a
      // table would not prove the canvas can still open the diagram.
      await expect
        .poll(
          () => cold.page.evaluate((id) => {
            const state = (window as ProbeWindow).__modelStore?.getState()
            const diagram = state?.diagrams.find((d) => d.id === state.currentDiagramId)
            return !!diagram?.objectIds?.includes(id) && state!.objects.some((o) => o.id === id)
          }, newObjectId),
          {
            timeout: 90_000,
            message: 'C11: a cold client opened the diagram but never resolved the added shape into it',
          },
        )
        .toBe(true)
    } finally {
      await cold.context.close()
    }
  })
})
