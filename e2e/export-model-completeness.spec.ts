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
 * A LANDSCAPE-scope export must ship the LANDSCAPE — not whatever diagram
 * happened to be open when Share was pressed.
 *
 * `gatherExportBundle('landscape')` starts from a store that is WINDOWED to the
 * active diagram (this stack runs `VITE_BOOT_FROM_SERVER=true`) and backfills
 * from a ladder: model shards → a NON-EMPTY monolith → the workspace-scoped
 * server read model → the window itself. The defect was the ladder ending on a
 * rung that could not answer, so the emitters were handed the window and wrote a
 * file that parses, validates, and is missing five sixths of the model.
 *
 * The window this test deliberately exports from is `DevelopmentDeployment`: 5
 * of the landscape's 30 objects, and — because a deployment view holds container
 * INSTANCES — 5 objects that share no id with anything the C4 views draw. Before
 * the fix this produced `people: 0, softwareSystems: 0` in the Structurizr JSON
 * and a DSL with no persons and no real software systems at all. Both numbers are
 * measured, not guessed: see the per-assertion notes below.
 *
 * The DSL is here as the CONTROL. It is a completely separate emitter, so a fault
 * visible in both files cannot live in either one — it has to be upstream, in the
 * gather. That is what identified the bug the first time.
 */

import { test, expect, type Page } from '@playwright/test'
import { submitDevLogin } from './support/devLogin'
import { waitForWorkspaceProjected } from './support/workspaceReady'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test.use({ channel: process.env.PW_BROWSER_CHANNEL || undefined })

const FIXTURE_REL = 'src/lib/structurizr/fixtures/json/big-bank-plc.json'

/** The diagram we deliberately leave open — the least representative window in
 * the fixture (5 container INSTANCES; no person, no software system, no
 * component is a member). */
const WINDOW_DIAGRAM = 'DevelopmentDeployment'

// Ground truth, read off the fixture and confirmed against the real emitters:
//   model      3 people · 4 software systems · 5 containers · 6 components
//              21 deployment nodes (5 top-level) · 41 relationships
//   views      7 views, 67 element rows, 46 of them carrying coordinates
// The window alone yields people 0 / softwareSystems 0 / components 0.
const PEOPLE = ['Personal Banking Customer', 'Customer Service Staff', 'Back Office Staff']
const SYSTEMS = ['Mainframe Banking System', 'E-mail System', 'ATM', 'Internet Banking System']
const CONTAINERS = ['Database', 'Mobile App', 'Web Application', 'API Application', 'Single-Page Application']
const COMPONENTS = [
  'Mainframe Banking System Facade',
  'Sign In Controller',
  'Accounts Summary Controller',
  'Security Component',
  'Reset Password Controller',
  'E-mail Component',
]

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── WebSocket witness ───────────────────────────────────────────────────────
// Installed BEFORE the first navigation and kept in sessionStorage so it survives
// the reload. `getRootHandle` also ROUTES THE NETWORK, so a getter called with the
// default workspace ref re-points the live sync socket at `landscapeId=default`
// for the rest of the session — a socket URL is the only direct witness of that.

const WS_KEY = '__e2eExportWsUrls'

async function installSocketRecorder(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    const read = (): string[] => {
      try {
        return JSON.parse(sessionStorage.getItem(key) || '[]') as string[]
      } catch {
        return []
      }
    }
    const push = (url: string) => {
      try {
        sessionStorage.setItem(key, JSON.stringify([...read(), url]))
      } catch {
        /* about:blank / storage-partitioned: nothing to record there anyway */
      }
    }
    const Native = window.WebSocket
    class Recording extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        push(String(url))
        super(url, protocols)
      }
    }
    ;(window as any).WebSocket = Recording
  }, WS_KEY)
}

/** Every automerge sync socket this tab has opened, oldest first (with repeats —
 * a reconnect to the SAME url is not a new route). */
async function automergeSockets(page: Page): Promise<string[]> {
  const urls: string[] = await page.evaluate((key: string) => {
    try {
      return JSON.parse(sessionStorage.getItem(key) || '[]') as string[]
    } catch {
      return []
    }
  }, WS_KEY)
  return urls.filter((u) => u.includes('/automerge'))
}

function landscapeIdOf(socketUrl: string): string | null {
  try {
    return new URL(socketUrl).searchParams.get('landscapeId')
  } catch {
    return null
  }
}

/** Assertion A, applied at every checkpoint. */
async function expectNoDefaultWorkspaceSocket(page: Page, when: string): Promise<void> {
  const sockets = await automergeSockets(page)
  expect(
    sockets.filter((u) => landscapeIdOf(u) === 'default'),
    `${when}: no automerge socket may be routed at landscapeId=default — that is the live sync socket being torn off the active landscape`,
  ).toEqual([])
}

// ── cleanup ledger ──────────────────────────────────────────────────────────
// The landscape this spec imports into must be gone at the end, pass or fail —
// it holds a 30-object model and a resident projector, and leaving it behind
// makes the NEXT run's fleet and registry assertions harder to trust. The API
// origin is learned from the app's own traffic (the app talks to
// VITE_SYNC_API_URL, not the page origin); the session cookie is host-scoped.

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

// ── App entry ───────────────────────────────────────────────────────────────

async function signIn(page: Page): Promise<void> {
  await page.goto('/app')
  const devLogin = page.getByTestId('dev-login-email')
  // The sign-in redirect lands a tick or more after `load`, and boot passes
  // THROUGH `/app` on its way to `/login`. A bare `isVisible()` reads the page
  // before it has decided, skips the submit, and the run then dies on the login
  // screen 60 s later. Wait for whichever outcome actually arrives.
  await Promise.race([
    devLogin.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined),
    page.waitForURL(/\/app\/landscape\/[^/]+\/version\//, { timeout: 45_000 }).catch(() => undefined),
  ])
  if (await devLogin.isVisible().catch(() => false)) {
    await submitDevLogin(page, `e2e-export-completeness-${Date.now()}@example.com`)
  }
  await page.waitForURL(/\/app\//, { timeout: 90_000 })
}

/** The app shell has booted far enough to navigate. Deliberately does NOT require
 * a current diagram: a freshly seeded personal org may have none, and the flow's
 * first step is the Diagrams page, not the canvas. */
async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = (window as any).__modelStore?.getState?.()
      return !!s && Array.isArray(s.diagrams)
    },
    undefined,
    { timeout: 90_000 },
  )
  await expect(page.getByTestId('nav-menu')).toBeVisible({ timeout: 60_000 })
}

/** The editor is usable: a diagram is open and its window has projected. */
async function waitForEditorReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = (window as any).__modelStore?.getState?.()
      return !!s && Array.isArray(s.objects) && Array.isArray(s.diagrams) && !!s.currentDiagramId
    },
    undefined,
    { timeout: 90_000 },
  )
}

function workspaceRefFromUrl(url: string): { landscapeId: string; versionId: string } | null {
  const m = /\/app\/landscape\/([^/]+)\/version\/([^/]+)/.exec(url)
  return m ? { landscapeId: m[1], versionId: m[2] } : null
}

// ── Download capture ────────────────────────────────────────────────────────

/** Click Download in the Export tab and return the file's bytes as text. */
async function downloadExport(page: Page): Promise<{ filename: string; text: string }> {
  const button = page.getByTestId('export-download')
  await expect(button, 'the Download button must become enabled once the bundle is gathered').toBeEnabled({
    timeout: 90_000,
  })
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), button.click()])
  const file = await download.path()
  expect(file, 'the download must produce a file on disk').toBeTruthy()
  return { filename: download.suggestedFilename(), text: readFileSync(file!, 'utf8') }
}

// ── Structurizr JSON shape walkers ──────────────────────────────────────────

function allContainers(ws: any): any[] {
  return (ws.model?.softwareSystems ?? []).flatMap((s: any) => s.containers ?? [])
}

function allComponents(ws: any): any[] {
  return allContainers(ws).flatMap((c: any) => c.components ?? [])
}

function allDeploymentNodes(ws: any): any[] {
  const out: any[] = []
  const walk = (n: any) => {
    out.push(n)
    for (const child of n.children ?? []) walk(child)
  }
  for (const n of ws.model?.deploymentNodes ?? []) walk(n)
  return out
}

function countRelationships(ws: any): number {
  let total = 0
  const walk = (e: any) => {
    total += (e.relationships ?? []).length
    for (const child of [
      ...(e.containers ?? []),
      ...(e.components ?? []),
      ...(e.children ?? []),
      ...(e.containerInstances ?? []),
      ...(e.softwareSystemInstances ?? []),
    ])
      walk(child)
  }
  for (const e of [
    ...(ws.model?.people ?? []),
    ...(ws.model?.softwareSystems ?? []),
    ...(ws.model?.deploymentNodes ?? []),
  ])
    walk(e)
  return total
}

/** Every view in the workspace's view set, whatever collection it lives in
 * (`configuration` is not a view collection). */
function allViews(ws: any): { collection: string; view: any }[] {
  const out: { collection: string; view: any }[] = []
  for (const [collection, value] of Object.entries(ws.views ?? {})) {
    if (!Array.isArray(value)) continue
    for (const view of value) out.push({ collection, view })
  }
  return out
}

// ── The test ────────────────────────────────────────────────────────────────

test('a landscape-scope export ships the whole model, not the deployment diagram that is open', async ({
  page,
}) => {
  // Import (real ELK auto-layout in the browser) + a workspace creation + a
  // reload + two gathers. The 120s default is not enough for the whole chain.
  test.setTimeout(300_000)

  // `config.rootDir` is the TEST dir (`./e2e`), not the repo root, so joining the
  // repo-relative fixture path onto it points at `e2e/src/lib/...` and the upload
  // fails with ENOENT. Anchor on this file's own location instead.
  const fixturePath = path.resolve(fileURLToPath(import.meta.url), '..', '..', FIXTURE_REL)
  const landscapeName = `E2E Export Completeness ${Date.now()}`

  // TEMP DIAGNOSTIC
  const t00 = Date.now()
  page.on('console', (m) => {
    const t = m.text()
    if (/bridge|automerge|workspace|unavailable|falling back|failed|Error|error/i.test(t)) {
      console.log(`  CON +${Date.now() - t00}ms [${m.type()}] ${t.slice(0, 400)}`)
    }
  })
  page.on('pageerror', (e) => console.log(`  PAGEERR +${Date.now() - t00}ms ${e.message}`))

  await installSocketRecorder(page)
  cleanupApiUrl = trackApiOrigin(page)
  await signIn(page)
  await waitForAppReady(page)
  await expectNoDefaultWorkspaceSocket(page, 'after sign-in')

  const socketsBeforeImport = (await automergeSockets(page)).length

  // ── 1. Import big-bank-plc.json into a NEW landscape, through the real UI ──
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  // "New diagram" is a menu, and Import is one of its two items.
  await page.getByTestId('create-diagram-button').click()
  await page.getByTestId('create-import').click()
  await expect(page.getByTestId('import-modal')).toBeVisible()

  await page.getByTestId('import-source-structurizr-json').click()
  await page.getByTestId('import-file-input').setInputFiles(fixturePath)
  // The upload path is async (File.text() → setText); the parse button is only
  // meaningful once the textarea actually holds the workspace.
  await expect(page.getByTestId('import-textarea')).not.toHaveValue('', { timeout: 30_000 })

  await page.getByTestId('import-parse').click()
  // Parse runs ELK over the views the file never laid out — give it room.
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 120_000 })

  await page.getByTestId('import-target-new').click()
  await page.getByTestId('import-new-name').fill(landscapeName)
  await page.getByTestId('import-generate').click()
  // Creating the landscape switches the live workspace and waits for THAT
  // workspace's projection before applying; the modal closes only after.
  await expect(page.getByTestId('import-modal')).toBeHidden({ timeout: 180_000 })

  await page.waitForURL(/\/app\/landscape\/[^/]+\/version\//, { timeout: 60_000 })
  const ref = workspaceRefFromUrl(page.url())
  expect(ref, 'the import must land the app inside the landscape it created').not.toBeNull()
  createdLandscapes.push(ref!.landscapeId)

  // ── Assertion A (switch half): the workspace switch opened exactly ONE new
  // automerge route, and it is the landscape we actually entered. ────────────
  const socketsAfterImport = (await automergeSockets(page)).slice(socketsBeforeImport)
  const newRoutes = [...new Set(socketsAfterImport)]
  expect(
    newRoutes,
    `entering a new landscape must open exactly one new automerge route, got: ${JSON.stringify(newRoutes)}`,
  ).toHaveLength(1)
  expect(landscapeIdOf(newRoutes[0])).toBe(ref!.landscapeId)
  await expectNoDefaultWorkspaceSocket(page, 'after the import switched workspace')

  // ── 2. Assertion B: survive a reload. Everything after this point reads a
  // landscape rehydrated from durable storage, not one held in memory. ───────
  await page.reload()
  await waitForEditorReady(page)
  // `waitForEditorReady` only proves the STORE EXISTS; it is satisfied while the
  // workspace is still projecting, and the diagram list then reads `[]` (measured).
  // Gate on the workspace whose bridge session finished booting.
  await waitForWorkspaceProjected(page)
  await expectNoDefaultWorkspaceSocket(page, 'after the reload')

  let diagramNames: string[] = []
  await expect
    .poll(
      async () => {
        diagramNames = await page.evaluate(() =>
          (window as any).__modelStore.getState().diagrams.map((d: any) => d.name),
        )
        return diagramNames.length
      },
      { timeout: 90_000, message: 'the reloaded landscape never listed its imported diagrams' },
    )
    .toBeGreaterThan(0)
  // Seeded content, counted from the seed: the fixture has 7 views and every one
  // becomes a diagram, PLUS the starter diagram `createLandscape` seeds into every
  // new landscape. The starter is asserted by COUNT rather than by name — its name
  // is translated chrome ("New context diagram" / "Nouveau diagramme de contexte")
  // and pinning it would make this spec fail on a French UI.
  const IMPORTED_VIEWS = [
    'Components',
    'Containers',
    'DevelopmentDeployment',
    'LiveDeployment',
    'SignIn',
    'SystemContext',
    'SystemLandscape',
  ]
  expect(
    IMPORTED_VIEWS.filter((name) => !diagramNames.includes(name)),
    'every view in the fixture must have become a diagram',
  ).toEqual([])
  expect(diagramNames, 'the imported views plus exactly one starter diagram').toHaveLength(
    IMPORTED_VIEWS.length + 1,
  )

  // ── 3. Open the DEPLOYMENT diagram — the deliberately unrepresentative window.
  const windowDiagramId: string = await page.evaluate(
    (name: string) =>
      (window as any).__modelStore.getState().diagrams.find((d: any) => d.name === name)?.id ?? '',
    WINDOW_DIAGRAM,
  )
  expect(windowDiagramId, `the imported landscape must contain a ${WINDOW_DIAGRAM} diagram`).toBeTruthy()

  await page.getByTestId('nav-menu').click()
  const navItem = page.getByTestId(`nav-diagram-${windowDiagramId}`)
  await navItem.scrollIntoViewIfNeeded()
  await navItem.click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__modelStore.getState().currentDiagramId), {
      timeout: 30_000,
    })
    .toBe(windowDiagramId)

  // The window settles asynchronously (the projection replaces the store's
  // objects with THIS diagram's members). Wait for it, then record how small it
  // actually is — this number is the whole point of the scenario.
  // TEMP DIAGNOSTIC
  for (let i = 0; i < 6; i += 1) {
    const dump = await page.evaluate((wanted: string) => {
      const w = window as any
      const s = w.__modelStore.getState()
      const d = s.diagrams.find((x: any) => x.id === wanted)
      return {
        currentDiagramId: s.currentDiagramId,
        objects: s.objects.length,
        connections: s.connections.length,
        diagrams: s.diagrams.length,
        diagramKeys: d ? Object.keys(d) : null,
        diagramSummary: d
          ? {
              name: d.name,
              type: d.type,
              members: Array.isArray(d.objectIds) ? d.objectIds.length : undefined,
              nodeCount: Array.isArray(d.nodes) ? d.nodes.length : undefined,
              layoutCount: d.layout ? Object.keys(d.layout).length : undefined,
            }
          : null,
        engineObjects: w.__canvasEngine?.objectMap ? w.__canvasEngine.objectMap.size : null,
        bfs: typeof w.__bridgeDebug === 'function' ? w.__bridgeDebug() : null,
      }
    }, windowDiagramId)
    console.log(`DIAG ${i}: ${JSON.stringify(dump)}`)
    await page.waitForTimeout(3_000)
  }
  {
    const r = workspaceRefFromUrl(page.url())!
    for (const path of [
      `/api/model/diagram-render?id=${windowDiagramId}&landscapeId=${r.landscapeId}&versionId=${r.versionId}&cacheScope=diagram`,
      `/api/model/cache/objects?landscapeId=${r.landscapeId}&versionId=${r.versionId}&limit=3`,
      `/api/model/cache/diagrams?landscapeId=${r.landscapeId}&versionId=${r.versionId}&limit=3`,
    ]) {
      const url = cleanupApiUrl!(path)
      const res = await page.context().request.get(url)
      console.log(`RENDER ${path.slice(0, 60)} -> ${res.status()} ${(await res.text()).slice(0, 300)}`)
    }

    // Is this deployment-specific? Open SystemContext and see if ITS members project.
    const otherId: string = await page.evaluate(
      () => (window as any).__modelStore.getState().diagrams.find((d: any) => d.name === 'SystemContext')?.id ?? '',
    )
    await page.getByTestId('nav-menu').click()
    const other = page.getByTestId(`nav-diagram-${otherId}`)
    await other.scrollIntoViewIfNeeded()
    await other.click()
    await page.waitForTimeout(6_000)
    console.log(
      `OTHER(SystemContext): ${JSON.stringify(
        await page.evaluate(() => {
          const s = (window as any).__modelStore.getState()
          const d = s.diagrams.find((x: any) => x.id === s.currentDiagramId)
          return { current: d?.name, members: d?.objectIds?.length, objects: s.objects.length }
        }),
      )}`,
    )
  }

  await expect
    .poll(
      () => page.evaluate(() => (window as any).__modelStore.getState().objects.length as number),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0)
  const windowObjects: number = await page.evaluate(
    () => (window as any).__modelStore.getState().objects.length,
  )
  test.info().annotations.push({ type: 'window', description: `${windowObjects} objects resident` })

  // ── 4. Export Structurizr (JSON) at LANDSCAPE scope ───────────────────────
  await page.getByTestId('open-share').click()
  await expect(page.getByTestId('share-modal')).toBeVisible()
  await page.getByTestId('share-tab-export').click()
  await page.getByTestId('export-type-structurizr-json').click()
  await page.getByTestId('export-code-landscape').click()

  // The refusal path. On a landscape whose model IS reachable it must stay
  // silent — a banner here means the gather fell all the way to the window, and
  // `export-download` would be disabled rather than writing an amputated file.
  await expect(
    page.getByTestId('export-model-incomplete'),
    'the gather must reach a whole-landscape source; a visible refusal banner means it did not',
  ).toBeHidden()

  const json = await downloadExport(page)
  expect(json.filename).toMatch(/-structurizr\.json$/)
  const ws = JSON.parse(json.text)

  // ── 4a. The model. Every one of these was 0 or absent before the fix. ─────
  expect(ws.name, 'the file must name the landscape it was exported from').toBe(landscapeName)

  const peopleNames = (ws.model?.people ?? []).map((p: any) => p.name).sort()
  expect(peopleNames, 'people: 0 is the defect signature — no person is a member of the open deployment view').toEqual(
    [...PEOPLE].sort(),
  )

  const systemNames = (ws.model?.softwareSystems ?? []).map((s: any) => s.name).sort()
  expect(systemNames, 'softwareSystems: 0 is the defect signature').toEqual([...SYSTEMS].sort())

  const containerNames = allContainers(ws).map((c: any) => c.name).sort()
  expect(containerNames, 'the containers must hang off their own software system, not be lost with it').toEqual(
    [...CONTAINERS].sort(),
  )

  const componentNames = allComponents(ws).map((c: any) => c.name).sort()
  expect(componentNames, 'the component level is three deep — it only survives if the whole hierarchy did').toEqual(
    [...COMPONENTS].sort(),
  )

  // Deployment nodes are the ONE thing the window did hold, so they prove
  // nothing on their own — but losing them would mean the merge dropped the
  // resident half, which is the opposite failure and just as wrong.
  expect(allDeploymentNodes(ws).length, 'the deployment topology must survive too').toBeGreaterThanOrEqual(15)

  // 41 in the fixture. A floor, not the exact number: an emitter is entitled to
  // drop a relationship it cannot express (it warns when it does), but it is not
  // entitled to drop three quarters of them.
  expect(countRelationships(ws), 'the relationships are the model — a handful of them is not the landscape')
    .toBeGreaterThanOrEqual(30)

  // ── 4b. The layout has to reach the file. A valid workspace whose every
  // element sits at the origin is the failure this feature exists to prevent. ─
  const views = allViews(ws)
  expect(views.length, 'every diagram in the landscape must emit a view').toBeGreaterThanOrEqual(5)

  const elementRows = views.flatMap(({ view }) => (view.elements ?? []) as any[])
  const placed = elementRows.filter((e) => (e.x ?? 0) !== 0 || (e.y ?? 0) !== 0)
  // 67 rows / 46 placed on the fixture. The unplaced remainder is deployment-node
  // BOUNDARIES, which Structurizr sizes from their contents.
  expect(elementRows.length, 'the views must list their members').toBeGreaterThanOrEqual(55)
  expect(
    placed.length,
    `a workspace with no coordinates re-lays-out on open, discarding the arrangement (${placed.length}/${elementRows.length} placed)`,
  ).toBeGreaterThanOrEqual(35)

  // No view may be empty: an emitted view whose elements were all filtered out
  // by a missing model is exactly what the degraded bundle produced (6 of its 7
  // views had `elements: []`).
  for (const { collection, view } of views) {
    expect((view.elements ?? []).length, `${collection}/${view.key} must not be an empty view`).toBeGreaterThan(0)
  }

  // ── 4c. `automaticLayout` is the flag that makes a reader throw the
  // coordinates away and re-run its own layout. Writing coordinates AND this is
  // strictly worse than writing neither. ────────────────────────────────────
  for (const { collection, view } of views) {
    expect(
      view.automaticLayout,
      `${collection}/${view.key} carries automaticLayout — every reader will discard the arrangement we just wrote`,
    ).toBeUndefined()
  }

  // ── 5. The DSL control. A second, independent emitter over the same bundle:
  // if this is degraded too, the fault is upstream of both. ──────────────────
  await page.getByTestId('export-type-structurizr').click()
  await page.getByTestId('export-code-landscape').click()
  const dsl = await downloadExport(page)
  expect(dsl.filename).toMatch(/\.dsl$/)
  const text = dsl.text

  for (const name of PEOPLE) {
    expect(text, `the DSL must declare the person "${name}" (the degraded file declared none)`).toContain(
      `person "${name}"`,
    )
  }
  expect((text.match(/= person /g) ?? []).length, 'exactly the three people, once each').toBe(3)

  for (const name of SYSTEMS) {
    expect(text, `the DSL must declare the software system "${name}"`).toContain(`softwareSystem "${name}"`)
  }
  for (const name of COMPONENTS) {
    expect(text, `the DSL must declare the component "${name}" (the degraded file declared none)`).toContain(
      `component "${name}"`,
    )
  }

  // The `ungrouped` wrapper. NOTE (measured, not assumed): this fixture emits it
  // even from a COMPLETE bundle — a deployment view's container instances have no
  // parent software system, and the DSL has no legal top-level place for a
  // container, so the exporter wraps them. Asserting its absence would fail on a
  // correct file. What the degraded export actually looked like is `ungrouped`
  // holding the WHOLE model: 0 persons, 0 components, and 2 software systems of
  // which one was the wrapper. So the discriminating claim is that the REAL
  // hierarchy is there under its own identifiers — a container declared with the
  // model's identifier (`database = container "Database"`) rather than only as a
  // deployment instance (`developerdatabaseinstance = container "Database"`).
  expect(text, 'the real Database container must be declared under its own identifier, not only as an instance')
    .toMatch(/\bdatabase = container "Database"/)
  expect(text, 'the real API Application container must be declared under its own identifier')
    .toMatch(/\bapiapplication = container "API Application"/)
  expect(
    (text.match(/= softwareSystem /g) ?? []).length,
    'the synthetic `ungrouped` wrapper must not be the only system in the file',
  ).toBeGreaterThanOrEqual(5)

  // ── 6. Assertion A, final. Opening Share resolves root/meta/shard documents;
  // a bare-default getter on any of those re-routes the live socket. ─────────
  await expectNoDefaultWorkspaceSocket(page, 'after both landscape-scope exports')
  const finalRoutes = [...new Set(await automergeSockets(page))].map(landscapeIdOf)
  expect(
    [...new Set(finalRoutes)],
    'the session must never have been routed at more than the landscapes it actually visited',
  ).not.toContain('default')
})
