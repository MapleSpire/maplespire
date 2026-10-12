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
 * IMPORT VOLUME: a burst of new documents must not lose any of them.
 *
 * The failure this gates loses diagrams: a Structurizr import into a
 * landscape CREATED IN THE SAME BROWSER SESSION, not yet reloaded. The mint
 * hands the browser workspace-bound document ids so a new document is
 * placeable by the sync gates without the durable index — but
 * `takeMintedDocumentIdBytes` is synchronous and never blocks, while the
 * top-up is asynchronous. An import creates one DiagramDoc per view in ONE
 * synchronous loop, so if the burst outruns what is in hand the rest take
 * RANDOM ids, the route gate cannot place them, and automerge-repo discards
 * their change-bearing frames. The badge holds "Enregistrement…" honestly and
 * forever. The pre-provision of minted ids prevents that.
 *
 * `repoint-offline-create.spec.ts` is MONO-DOCUMENT and cannot see a burst.
 *
 * ## Why a session-fresh landscape, and why it is not incidental
 *
 * The reserve is namespaced PER WORKSPACE (`startMintedIdSupply` binds to
 * `workspaceKvStore()`). A landscape created in-session therefore always starts
 * from an empty pool, refilled to one drawn block. Measured on this stack: a
 * brand-new landscape leaves `available() === 15` — one block of 16 minus the
 * id its default diagram spent. Any import of more than 15 documents is over
 * the edge; every import into a landscape that has been open a while is not.
 *
 * ## The two criteria, and which one is the discriminant
 *
 *  (a) `takenFallback` delta === 0. DETERMINISTIC. Without the pre-provision, a
 *      burst needing more than the drawn block spends the block and takes
 *      random ids for the remainder, every run (measured 16 minted / 2
 *      fallback at 17 views, 8 runs out of 8).
 *  (b) zero loss. The property that matters, and a RACE: the same 7-view file
 *      lost 1, 2 and 5 across three runs. A single green run of (b) proves
 *      nothing on its own, which is exactly why (a) is here.
 *
 * ## Two instruments, deliberately independent
 *
 *  - `fsck` over the DOCUMENT GRAPH — the authority. `ro_diagrams` LIES here:
 *    it counts registry stubs and reported 18/18 on every losing run.
 *  - a FRESH browser context that opens every imported diagram and checks the
 *    editor is live. This is the half fsck cannot see: under boot-from-server
 *    the picture comes from `/api/model/diagram-render`, so a diagram whose
 *    DiagramDoc never resolved still DISPLAYS — it is merely read-only forever.
 *    `tool-select` is `disabled={!editReady}`, so it is the UI's own answer.
 *
 * ## Two volumes
 *
 *  - big-bank: UNDER the drawn block (its seven view declarations parse to four
 *    diagrams — measured, not counted from the file). It is the liveness
 *    witness: green with or without the pre-provision, so a red run of the
 *    other volume is about volume and not about the harness.
 *  - a generated 30-view DSL: twice the block. MEASURED against a mutant with
 *    the pre-provision removed — 15 minted and 15 RANDOM, both attempts — which
 *    is a real loss surface, rather than the margin of ONE that the repo's
 *    largest committed fixture happens to give (saoe parses to 15 diagrams
 *    against 15 ids in hand).
 *
 * That mutant run is what makes this spec worth having: the witness volume
 * stayed GREEN on the same broken code. A gate that cannot pass for the right
 * reason is as useless as one that cannot fail.
 *
 * Neither volume hard-codes its document count; what the design depends on is which SIDE of the block
 * a volume lands on, so that is what the test asserts — against the reserve it
 * measured in the same run.
 *
 * ## Running it
 *
 * Against an isolated import-volume stack (see scripts/dev-boot.mjs for the isolation env vars):
 *
 *   E2E_BOOT_URL=http://localhost:5199 E2E_BOOT_API=http://localhost:3099 \
 *     npx playwright test --project=boot e2e/boot/import-volume.spec.ts
 *
 * `E2E_IMPORT_DATABASE_URL` points fsck at that stack's Postgres and defaults
 * to it. If fsck cannot run, this spec FAILS with an explicit message; it never
 * skips, because a green run that did not run is the worst outcome.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Browser, type Page } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3099'
const DATABASE_URL =
  process.env.E2E_IMPORT_DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5499/maplespire'
const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'

/** One drawn block minus the id a new landscape's default diagram spends. Not
 * a tuning knob — the number this whole spec is positioned around, and the
 * volumes below straddle it on purpose. Asserted, not assumed. */
const EXPECTED_FRESH_RESERVE = 15

interface MintCounters {
  minted: number
  fallback: number
  available: number
  poolWorkspace: string | null
}

interface FsckReport {
  workspace: { landscapeId: string; versionId: string }
  status: string
  findings: { check: string; severity: string; detail?: string; documentUrl?: string }[]
  checksRun: string[]
  reachableDocuments: number
}

/**
 * A Structurizr DSL with `views` system-context views, one per software system.
 *
 * Generated rather than committed because the volume IS the parameter: the
 * repo's largest fixture parses to 15 diagrams, which clears the reserve by
 * one, and a margin of one makes the loss half of this spec a coin flip.
 * It goes through the same production parser as every other DSL.
 */
function generatedDsl(views: number): string {
  let model = ''
  let viewBlock = ''
  for (let i = 1; i <= views; i += 1) {
    model += `      s${i} = softwareSystem "System ${i}" {\n        c${i} = container "App ${i}"\n      }\n`
    viewBlock += `    systemContext s${i} "ctx${i}" { include * autolayout lr }\n`
  }
  return `workspace "Volume" "generated" {\n  model {\n    u = person "User"\n${model}    u -> s1 "uses"\n  }\n  views {\n${viewBlock}  }\n}\n`
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
    await page.waitForURL('**/app/**', { timeout: 30_000 })
  }
  await page.waitForFunction(
    () => Array.isArray((window as any).__modelStore?.getState?.().diagrams),
    undefined,
    { timeout: 45_000 },
  )
}

function mintCounters(page: Page): Promise<MintCounters> {
  return page.evaluate(() => {
    const m = (window as any).__mintedIdSupply
    if (!m) throw new Error('__mintedIdSupply is absent — this build is not a DEV build')
    return {
      minted: m.takenMinted(),
      fallback: m.takenFallback(),
      available: m.available(),
      poolWorkspace: m.poolWorkspace(),
    }
  })
}

/** Create a landscape through the REAL workspace panel and wait for the app to
 * switch into it. Returns its id, read off the URL the router put there. */
async function createLandscapeInSession(page: Page, name: string): Promise<string> {
  const before = page.url()
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('workspace-landscapes').click()
  await page.getByTestId('new-landscape-name').fill(name)
  await page.getByTestId('new-landscape-add').click()
  await page.waitForFunction(
    (previous) => window.location.href !== previous && /\/app\/landscape\/[^/]+\//.test(window.location.href),
    before,
    { timeout: 60_000 },
  )
  await page.waitForFunction(
    () => Array.isArray((window as any).__modelStore?.getState?.().diagrams),
    undefined,
    { timeout: 60_000 },
  )
  const id = new URL(page.url()).pathname.split('/')[3]
  expect(id, 'the router should name the new landscape in the URL').toBeTruthy()
  return id
}

/** Drive the import modal for real: open it from the diagrams list's create
 * menu, paste, parse, generate. Returns how many diagrams the preview promised,
 * which is the count every later assertion is measured against. */
async function importDsl(page: Page, dsl: string): Promise<number> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  await page.getByTestId('create-diagram-button').click()
  await page.getByTestId('create-import').click()
  await expect(page.getByTestId('import-modal')).toBeVisible()

  await page.getByTestId('import-textarea').fill(dsl)
  await page.getByTestId('import-parse').click()
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('import-error')).toHaveCount(0)

  const promised = await page.evaluate(() => {
    const text = document.querySelector('[data-testid="import-preview"]')?.textContent ?? ''
    // The preview's own sentence, in whichever locale the app is running.
    const m = text.match(/(\d+)\s+diagram/i)
    return m ? Number(m[1]) : 0
  })
  expect(promised, 'the preview must name how many diagrams the burst will create').toBeGreaterThan(0)

  await page.getByTestId('import-generate').click()
  // The modal closing IS the success signal — a short pre-provision holds it
  // open on `import-mint-shortfall` instead, which is the surface S2 added.
  await expect(page.getByTestId('import-mint-shortfall')).toHaveCount(0, { timeout: 120_000 })
  await expect(page.getByTestId('import-modal')).toHaveCount(0, { timeout: 120_000 })
  return promised
}

/** The landscape's concrete default version. The URL carries `current`, which
 * is an alias; fsck needs the id the alias resolves to. */
async function concreteVersionId(page: Page, landscapeId: string): Promise<string> {
  const response = await page.request.get(`${API_BASE}/api/landscapes`)
  expect(response.ok(), `GET /api/landscapes -> ${response.status()}`).toBe(true)
  const body = (await response.json()) as any
  const list: any[] = Array.isArray(body) ? body : (body.landscapes ?? [])
  const found = list.find((l) => l.id === landscapeId)
  expect(found, `landscape ${landscapeId} should be listed`).toBeTruthy()
  expect(found.defaultVersionId, 'the landscape should name a default version').toBeTruthy()
  return found.defaultVersionId as string
}

/**
 * The durable authority, over the document graph.
 *
 * Two traps, both hit while writing this. `--landscape-id` alone does NOT
 * filter — without `--version-id` the scan covers every workspace in the
 * database. And the exit code is about the WHOLE database: one unrelated stale
 * workspace makes it non-zero, so the verdict has to come from the parsed
 * report for THIS workspace, never from the status.
 */
function fsckWorkspace(landscapeId: string, versionId: string): FsckReport {
  const args = [
    'node_modules/tsx/dist/cli.mjs',
    'scripts/fsck-workspaces.ts',
    '--json',
    '--landscape-id',
    landscapeId,
    '--version-id',
    versionId,
  ]
  let out: string
  try {
    out = execFileSync(process.execPath, args, {
      cwd: resolve(ROOT, 'server'),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    out = String((err as any).stdout ?? '')
    if (!out.includes('{')) {
      throw new Error(
        `fsck could not run against ${DATABASE_URL} — this spec asserts nothing without it.\n`
        + `${String((err as any).stderr ?? (err as Error).message)}`,
        { cause: err },
      )
    }
  }
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { reports: FsckReport[] }
  expect(parsed.reports, 'the filter must match exactly one workspace, or the run measured someone else')
    .toHaveLength(1)
  return parsed.reports[0]
}

/**
 * The independent instrument: a context that has never seen this landscape
 * opens every imported diagram and confirms the editor is LIVE.
 *
 * Not a duplicate of fsck. A diagram whose DiagramDoc never reached the server
 * still draws under boot-from-server — the read model paints it — and is simply
 * read-only for good, which is the exact user report this defect produced.
 */
async function everyDiagramEditableInAFreshContext(
  browser: Browser,
  landscapeId: string,
  versionId: string,
  diagramIds: string[],
): Promise<number> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signIn(page)

    let checked = 0
    for (const id of diagramIds) {
      // A DEEP LINK, not the diagrams list. The list is virtualized, so its
      // rendered rows are a property of the viewport rather than of what was
      // imported — and the store cannot stand in for it either: under
      // boot-from-server a fresh context's window holds only the ACTIVE
      // diagram, so reading `__modelStore` here returns 0 and would have made
      // the whole instrument vacuous. Entering each diagram cold is also the
      // strongest form of this check: it is what a user opening a shared link
      // does, with nothing in IndexedDB to fall back on.
      await page.goto(`/app/landscape/${landscapeId}/version/${versionId}/diagram/${id}`)
      // `tool-select` is `disabled={!editReady}`, and `editReady` is set only
      // once the DiagramDoc itself resolved. A lost document leaves it disabled
      // forever, with the picture still painted by the read model and no error
      // anywhere on screen — the exact user report this defect produced.
      await expect(
        page.getByTestId('tool-select'),
        `diagram ${id} opened but its editor never became live — its DiagramDoc did not resolve`,
      ).toBeEnabled({ timeout: 60_000 })
      checked += 1
    }
    return checked
  } finally {
    await context.close()
  }
}

interface Volume {
  label: string
  dsl: () => string
  /**
   * Which side of the drawn block this volume must land on. NOT a document
   * count: the big-bank fixture declares seven views and MapleSpire's parser
   * collapses them to four
   * diagrams. What the design actually depends on is the SIDE, so that is what
   * is asserted, against the reserve measured in the same run.
   */
  side: 'under' | 'over'
  role: string
}

const VOLUMES: Volume[] = [
  {
    label: 'big-bank',
    side: 'under',
    role: 'liveness witness: fits in the drawn block, so it is green with or without the pre-provision',
    dsl: () => readFileSync(resolve(ROOT, 'src/lib/structurizr/fixtures/big-bank-plc.dsl'), 'utf8'),
  },
  {
    label: 'generated (30 views)',
    side: 'over',
    role: 'discriminant: twice the drawn block, so a missing pre-provision spends ~16 random ids',
    dsl: () => generatedDsl(30),
  },
]

test.describe.configure({ mode: 'serial' })

for (const volume of VOLUMES) {
  test(`import of ${volume.label} into a session-fresh landscape loses nothing`, async ({ page, browser }) => {
    // Full coverage of every imported diagram in a second context is the point
    // of the spec, and it is one in-app navigation each.
    test.setTimeout(600_000)

    await signIn(page)
    const landscapeName = `import-volume-${Date.now().toString(36)}`
    const landscapeId = await createLandscapeInSession(page, landscapeName)

    // The reserve a session-fresh landscape starts from. Asserted rather than
    // assumed: if this number moves, the volumes above stop straddling it and
    // the discriminant quietly becomes a second liveness witness.
    const before = await mintCounters(page)
    expect(before.poolWorkspace, 'the pool must have re-bound to the new landscape')
      .toContain(landscapeId)
    expect(
      before.available,
      `a session-fresh landscape should hold ${EXPECTED_FRESH_RESERVE} drawn ids; `
      + `at ${before.available} the volumes no longer straddle the block`,
    ).toBe(EXPECTED_FRESH_RESERVE)

    const promised = await importDsl(page, volume.dsl())
    const documents = promised + 1 // one DiagramDoc per view, plus the registry shard
    if (volume.side === 'under') {
      expect(
        documents,
        `${volume.label} must fit inside the drawn block to be what it is for — ${volume.role}`,
      ).toBeLessThanOrEqual(before.available)
    } else {
      expect(
        documents,
        `${volume.label} must OUTRUN the drawn block to be what it is for — ${volume.role}. `
        + `At ${documents} documents against ${before.available} in hand it tests nothing.`,
      ).toBeGreaterThan(before.available)
    }

    // Read on the NEAR side of any reload: these are module counters, so they
    // go back to zero with the page and a delta across a reload is not a small
    // error but a meaningless one.
    const after = await mintCounters(page)
    const mintedDelta = after.minted - before.minted
    const fallbackDelta = after.fallback - before.fallback

    // (a) the deterministic discriminant, reported FIRST because it is the one
    // that names the defect. Measured against a mutant with the pre-provision
    // removed: this volume spends 15 minted and 15 RANDOM, both attempts.
    expect(
      fallbackDelta,
      `${promised} diagrams were created and ${fallbackDelta} took a RANDOM id. `
      + 'Random ids are unplaceable by the sync gates until the durable index catches up, '
      + 'and their first change-bearing frames are discarded.',
    ).toBe(0)

    // Validity gate: zero fallbacks because nothing was created is not a pass.
    //
    // ONE id per DiagramDoc, and no more. `prepareDocumentIds` asks for
    // `diagrams.length + 1`, the spare being for a registry shard — but a shard
    // is only minted at ROLLOVER (VITE_SHARD_SIZE, 200 by default), so at these
    // volumes the import appends to the shard the landscape already has and the
    // spare is headroom, not a spend. Measured 4/4, 15/15 and 30/30 on this
    // stack. Asserted exactly rather than loosely so that if a volume ever does
    // roll a shard over, this line says so instead of absorbing it.
    expect(
      mintedDelta,
      `the burst must actually have spent ${promised} ids; minted moved by ${mintedDelta}`,
    ).toBe(promised)

    const versionId = await concreteVersionId(page, landscapeId)

    // (b) the property that matters, through the authority. Give the burst a
    // moment to reach Postgres first — the assertion is about durability, not
    // about how fast it got there.
    await page.waitForTimeout(8_000)
    const report = fsckWorkspace(landscapeId, versionId)
    expect(
      report.checksRun,
      'a report that did not RUN document-present cannot say anything about loss',
    ).toContain('document-present')
    expect(
      report.findings.map((f) => `${f.check}:${f.severity} ${f.documentUrl ?? ''}`),
      'every document the registry points at must be durably present and admitted',
    ).toEqual([])
    expect(report.status, 'incomplete is not clean').toBe('clean')
    expect(
      report.reachableDocuments,
      `the graph should reach at least the ${documents} documents this import created`,
    ).toBeGreaterThanOrEqual(documents)

    // (b) again, independently, and through the half fsck cannot see. The ids
    // come from the IMPORTING context, which is the only party that holds them
    // all — see the note in the helper about why the fresh context cannot be
    // asked for its own list.
    const diagramIds: string[] = await page.evaluate(() =>
      ((window as any).__modelStore.getState().diagrams as any[]).map((d) => d.id))
    expect(
      diagramIds.length,
      `the importing context should hold every imported diagram; it holds ${diagramIds.length}`,
    ).toBeGreaterThanOrEqual(promised)

    const checked = await everyDiagramEditableInAFreshContext(browser, landscapeId, versionId, diagramIds)
    expect(checked, 'the second instrument must have opened every diagram, not a sample')
      .toBe(diagramIds.length)
  })
}
