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
 * T-SUM-0, exit (4): what becomes of a write made OFFLINE on an ORDINARY
 * workspace that an operator PROMOTES to summary while the writer is away.
 *
 * This QUALIFIES behaviour, it does not fix it (the fix is T-SUM-1). An
 * earlier analysis held that the loss is "not established": the diagram-creation
 * journal recreates with the original id and is acknowledged only after a
 * durable flush, so the loss would need the journal to be gone. Each test
 * below is one cell of that claim, measured on a real stack:
 *
 *   write          × journal
 *   ───────────────┼──────────────────────────────────────────────
 *   diagram        │ present: the writer's own profile comes back
 *   object edit    │ absent:  the journal keys are deleted from the
 *                  │          writer's IndexedDB before it comes back
 *
 * THE SEQUENCE, identical in every cell: Paul opens an ordinary workspace and
 * lets it settle; his live tab goes OFFLINE (`goOffline({ live: true })` —
 * HTTP aborted and the sync socket refused, as an outage would); he writes;
 * the operator promotes the workspace through the route (zero connected
 * peers, so no override is sent); Paul comes back ONLINE, sees the contract
 * banner and reloads (the banner's own affordance); then Marie, in a cold
 * profile, looks for the write through the SERVER-answered views (the
 * Diagrams page search, the Model Objects search). Nothing is read from a
 * store: a card or a row on Marie's screen is the oracle.
 *
 * THE VERDICTS ARE PINNED, NOT HOPED. `EXPECTED` below says, per cell, what
 * the stack was measured to do (the T-SUM-0 measurements, dated below). A
 * cell that LOSES the write asserts the loss, with a message naming T-SUM-1:
 * when T-SUM-1 lands, that cell goes red and its expectation is flipped —
 * that is the point, a qualification that cannot notice the fix is not one.
 *
 * WHICH CLIENT. The write path depends on the build flags:
 * under boot-from-server an object edit goes to an OVERLAY head, without it
 * to an `object-base` shard — the kind the baseline fence drops. The harness
 * runs this file twice: `E2E_OFFLINE_CLIENT=bfs` (production flags) and
 * `E2E_OFFLINE_CLIENT=classic` (boot-from-server off, sharding on).
 *
 * Run it through `node scripts/e2e-summary-visibility.mjs --suite=offline`,
 * which seeds one fresh ordinary workspace per test (a promotion is one-way
 * for the run) and passes them as `E2E_OFFLINE_WORKSPACES`.
 */

import { appendFileSync } from 'node:fs'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { syncBar, waitForWorkspaceProjected } from '../support/workspaceReady'
import { goOffline, goOnline, installServerRouting, flushLocal } from './helpers'

const PAUL = process.env.E2E_DEV_EMAIL ?? 'paul@summary.e2e.test'
const MARIE = process.env.E2E_COLD_EMAIL ?? 'marie@summary.e2e.test'
const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3587'
const CLIENT = (process.env.E2E_OFFLINE_CLIENT ?? 'bfs') as 'bfs' | 'classic'
const OBSERVATIONS = process.env.E2E_OFFLINE_OBSERVATIONS ?? null

type Workspace = { landscapeId: string; versionId: string }
type Cell = 'diagram-present' | 'diagram-absent' | 'object-present' | 'object-absent'

const WORKSPACES: Workspace[] = JSON.parse(process.env.E2E_OFFLINE_WORKSPACES ?? '[]')

/**
 * What the stack DOES, per client and cell — measured, see the dates below.
 * `true` = Marie sees the write; `false` = she does not (a loss, carried
 * into T-SUM-1). Filled from the measurement, never from the design notes.
 */
const EXPECTED: Record<typeof CLIENT, Record<Cell, boolean>> = {
  // Measured 21/11/2026: all four LOST. Diagram cells:
  // banner shown, reload lands on summary, badge stays "saving", no
  // ro_diagrams row, no registry-shard queue row. Object cells: badge
  // "Synced" after the reload, ro_objects unchanged — confounded by the
  // static-plane object-overlay defect, which loses ONLINE renames too.
  //
  // Re-measured 22/11/2026 with the T-SUM-0b fix: the two OBJECT cells now
  // SEE the rename, journal present and absent — their loss was that defect,
  // not the promotion. The
  // diagram cells are unchanged: still lost, still T-SUM-1.
  bfs: {
    'diagram-present': false,
    'diagram-absent': false,
    'object-present': true,
    'object-absent': true,
  },
  // Measured 21/11/2026 (run 20261122T034818Z): all four LOST, and here the
  // badge stays "saving" after the reload in every cell — the writer is told,
  // nobody else ever sees the write. The object edit is an `object-base`
  // write, the kind the baseline fence drops. Re-measured 22/11/2026 with the
  // T-SUM-0b fix (run 20261122T142714Z): unchanged, all four still LOST —
  // T-SUM-0b touches overlay heads, not `object-base` shards.
  classic: {
    'diagram-present': false,
    'diagram-absent': false,
    'object-present': false,
    'object-absent': false,
  },
}

type ProbeWindow = Window & {
  __bridgeDebug?: () => { registrySummaryOnly?: boolean; bfsActive?: boolean }
  __modelStore?: { getState: () => { currentDiagramId: string | null; objects: Array<{ id: string; name: string }> } }
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  const field = page.getByTestId('dev-login-email')
  const landed = await Promise.race([
    field.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'form' as const),
    page.waitForURL('**/app/**', { timeout: 20_000 }).then(() => 'app' as const),
  ]).catch(() => 'form' as const)
  if (landed === 'form') {
    const legal = page.getByTestId('legal-acceptance')
    if (await legal.count()) await legal.check().catch(() => {})
    await field.fill(email)
    await field.press('Enter')
    await page.waitForURL('**/app/**', { timeout: 60_000 })
  }
}

async function booted(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const state = (window as ProbeWindow).__modelStore?.getState()
    return !!state && !!state.currentDiagramId && !!(window as ProbeWindow).__bridgeDebug
  }, undefined, { timeout: 120_000 })
}

async function contract(page: Page): Promise<boolean | null> {
  return page.evaluate(() => (window as ProbeWindow).__bridgeDebug?.().registrySummaryOnly ?? null).catch(() => null)
}

async function openNav(page: Page, testId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await page.getByTestId(testId).isVisible().catch(() => false)) return
    await page.getByTestId('nav-menu').click({ timeout: 30_000 }).catch(() => {})
    const shown = await page.getByTestId(testId).waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)
    if (shown) return
    await page.waitForTimeout(400)
  }
  throw new Error(`the nav menu never showed ${testId}`)
}

async function cold(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL })
  return { context, page: await context.newPage() }
}

async function enterWorkspace(page: Page, ws: Workspace): Promise<void> {
  await page.goto(`/app/landscape/${ws.landscapeId}/version/${ws.versionId}`, { waitUntil: 'domcontentloaded' })
  await booted(page)
}

/** The operator's gesture, from a context with no page on the workspace. */
async function promote(browser: Browser, ws: Workspace): Promise<{ status: number; body: unknown }> {
  const admin = await cold(browser)
  try {
    await signIn(admin.page, PAUL)
    await admin.page.goto('about:blank')
    let status = 0
    let body: { blockers?: Array<{ code: string }> } = {}
    // A read model that has not caught up yet also shows as unsealed rows,
    // CRDT/SQL divergence and unclassified diagram documents: those are
    // retried while — and only while — `read-model-not-caught-up` is among
    // the blockers. Anything else is the answer.
    const transient = new Set(['read-model-not-caught-up', 'peers-connected'])
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await admin.context.request.post(`${API_BASE}/api/platform/workspace/promote-summary`, {
        data: { ...ws, apply: true }, timeout: 180_000,
      })
      status = response.status()
      body = await response.json().catch(() => ({}))
      const codes = (body.blockers ?? []).map((blocker) => blocker.code)
      const catchingUp = codes.includes('read-model-not-caught-up')
      if (status !== 409 || codes.length === 0 || (!catchingUp && !codes.every((code) => transient.has(code)))) break
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
    return { status, body }
  } finally {
    await admin.context.close()
  }
}

/** "Journal absent": delete the entity-intent journal from the writer's
 * IndexedDB while NO page of the app is running in that profile (a live tab
 * would re-persist it from memory). The page used is a static asset of the
 * same origin, which boots nothing. Returns how many keys were deleted. */
async function deleteIntentJournal(context: BrowserContext): Promise<number> {
  const page = await context.newPage()
  try {
    await page.goto('/favicon.svg')
    return await page.evaluate(async () => {
      const names = (await indexedDB.databases()).map((db) => db.name ?? '').filter((name) => name.startsWith('maplespire-model-index'))
      let deleted = 0
      for (const name of names) {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        if (!db.objectStoreNames.contains('idx')) { db.close(); continue }
        const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
          const request = db.transaction('idx').objectStore('idx').getAllKeys()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const doomed = keys.filter((key) => String(key).includes('pending-entity-intents'))
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('idx', 'readwrite')
          for (const key of doomed) tx.objectStore('idx').delete(key)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        })
        deleted += doomed.length
        db.close()
      }
      return deleted
    })
  } finally {
    await page.close()
  }
}

async function marieSeesDiagram(browser: Browser, ws: Workspace, id: string, name: string): Promise<boolean> {
  const marie = await cold(browser)
  try {
    await signIn(marie.page, MARIE)
    await enterWorkspace(marie.page, ws)
    await expect.poll(() => contract(marie.page), { timeout: 90_000 }).toBe(true)
    await openNav(marie.page, 'nav-diagrams')
    await marie.page.getByTestId('nav-diagrams').click()
    const search = marie.page.getByTestId('diagrams-search')
    await expect(search).toBeVisible({ timeout: 60_000 })
    await search.fill(name)
    const seen = await marie.page.getByTestId(`diagram-card-${id}`).waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true).catch(() => false)
    await marie.page.screenshot({ path: test.info().outputPath(`marie-diagrams-${seen ? 'seen' : 'missing'}.png`) })
    return seen
  } finally {
    await marie.context.close()
  }
}

async function marieSeesObjectName(browser: Browser, ws: Workspace, id: string, name: string): Promise<boolean> {
  const marie = await cold(browser)
  try {
    await signIn(marie.page, MARIE)
    await enterWorkspace(marie.page, ws)
    await expect.poll(() => contract(marie.page), { timeout: 90_000 }).toBe(true)
    await openNav(marie.page, 'nav-model-objects')
    await marie.page.getByTestId('nav-model-objects').click()
    const search = marie.page.getByTestId('mo-search')
    await expect(search).toBeVisible({ timeout: 60_000 })
    await search.fill(name)
    // The ROW is not the oracle: the table lists every object, and a row
    // that merely exists says nothing about the edit (measured: the search
    // box did not narrow a 1 000-object table, and the edited object's row was
    // on screen under its OLD name). The NAME in that row is the oracle.
    const seen = await expect(marie.page.getByTestId(`mo-row-${id}`)).toContainText(name, { timeout: 60_000 })
      .then(() => true).catch(() => false)
    await marie.page.screenshot({ path: test.info().outputPath(`marie-objects-${seen ? 'seen' : 'missing'}.png`) })
    return seen
  } finally {
    await marie.context.close()
  }
}

function record(cell: Cell, facts: Record<string, unknown>): void {
  test.info().annotations.push({ type: 'observation', description: JSON.stringify({ client: CLIENT, cell, ...facts }) })
  if (!OBSERVATIONS) return
  // One line per cell; the harness collects the file into the record.
  appendFileSync(OBSERVATIONS, `${JSON.stringify({ client: CLIENT, cell, at: new Date().toISOString(), ...facts })}\n`)
}

const CELLS: Cell[] = ['diagram-present', 'diagram-absent', 'object-present', 'object-absent']

test.describe(`T-SUM-0 — écriture hors ligne pendant la promotion (${CLIENT})`, () => {
  for (const [index, cell] of CELLS.entries()) {
    test(cell, async ({ browser }) => {
      test.setTimeout(480_000)
      const ws = WORKSPACES[index]
      expect(ws, `E2E_OFFLINE_WORKSPACES needs ${CELLS.length} fresh ordinary workspaces (got ${WORKSPACES.length})`).toBeTruthy()
      const [write, journal] = cell.split('-') as ['diagram' | 'object', 'present' | 'absent']

      // ── Paul, online, on the ORDINARY workspace ────────────────────────────
      const paul = await cold(browser)
      let page = paul.page
      await installServerRouting(page)
      await signIn(page, PAUL)
      await enterWorkspace(page, ws)
      await waitForWorkspaceProjected(page, ws)
      expect(await contract(page), 'the cell must START on an ordinary workspace').toBe(false)
      // A CLASSIC client reads nothing from the server read model, so on its
      // own it never makes the workspace's ordinary projector resident, and
      // the promotion would refuse an `uninitialized` read model (measured:
      // 409, read-model-not-caught-up). One server read, as any server-tier
      // reader of the workspace would make, warms it.
      // 503 is "read model warming up" (measured): poll it, as a reader would.
      const warmUrl = `${API_BASE}/api/model/diagrams/page?limit=1&landscapeId=${encodeURIComponent(ws.landscapeId)}&versionId=${encodeURIComponent(ws.versionId)}`
      await expect.poll(async () => (await paul.context.request.get(warmUrl)).status(), {
        timeout: 120_000, intervals: [1_000, 2_000, 3_000],
        message: 'the read model of the ordinary workspace never answered a server read',
      }).toBe(200)
      const bfsActive = await page.evaluate(() => (window as ProbeWindow).__bridgeDebug?.().bfsActive ?? null)
      expect(bfsActive, `client ${CLIENT}: bfsActive`).toBe(CLIENT === 'bfs')
      let objectId: string | null = null
      if (write === 'object') {
        await openNav(page, 'nav-model-objects')
        await page.getByTestId('nav-model-objects').click()
        await expect(page.getByTestId('mo-search')).toBeVisible({ timeout: 60_000 })
        const firstRow = page.locator('[data-testid^="mo-row-"]').first()
        await expect(firstRow).toBeVisible({ timeout: 60_000 })
        objectId = (await firstRow.getAttribute('data-testid'))!.replace('mo-row-', '')
        await firstRow.click()
        await expect(page.getByTestId('object-name')).toBeVisible({ timeout: 30_000 })
      }
      await expect(syncBar(page)).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })

      // ── OFFLINE, and the write ────────────────────────────────────────────
      await goOffline(page, { live: true })
      let writtenId: string
      let writtenName: string
      if (write === 'diagram') {
        const beforeId = new URL(page.url()).pathname.match(/\/diagram\/([^/?#]+)/)?.[1] ?? null
        await openNav(page, 'create-diagram-context')
        await page.getByTestId('create-diagram-context').click({ timeout: 30_000 })
        await page.waitForURL((url) => /\/diagram\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(`/diagram/${beforeId}`), { timeout: 90_000 })
        writtenId = new URL(page.url()).pathname.match(/\/diagram\/([^/?#]+)/)![1]
        writtenName = `T-SUM-0 offline ${CLIENT} ${cell} ${Date.now()}`
        const nameField = page.getByTestId('diagram-name')
        await nameField.fill(writtenName)
        await nameField.press('Enter').catch(() => {})
        await nameField.blur().catch(() => {})
      } else {
        writtenId = objectId!
        writtenName = `T-SUM-0 offline ${CLIENT} ${cell} ${Date.now()}`
        await page.getByTestId('object-name').fill(writtenName)
        await page.getByTestId('object-name').blur()
        await expect(page.getByTestId('object-name')).toHaveValue(writtenName)
      }
      await flushLocal(page)
      const offlineStatus = await syncBar(page).getAttribute('data-status').catch(() => null)

      // ── the operator promotes while Paul is away ──────────────────────────
      const promotion = await promote(browser, ws)
      expect(promotion.status, `promotion: ${JSON.stringify(promotion.body)}`).toBe(200)

      // ── Paul comes back ───────────────────────────────────────────────────
      await goOnline(page)
      const banner = await page.getByTestId('workspace-contract-banner').waitFor({ state: 'visible', timeout: 90_000 })
        .then(() => true).catch(() => false)
      const statusBeforeReload = await syncBar(page).getAttribute('data-status').catch(() => null)
      let journalKeysDeleted: number | null = null
      if (journal === 'absent') {
        // No page of the app may run while the journal is deleted.
        await page.close()
        journalKeysDeleted = await deleteIntentJournal(paul.context)
        page = await paul.context.newPage()
        await enterWorkspace(page, ws)
      } else if (banner) {
        await page.getByTestId('workspace-contract-reload').click()
        await booted(page)
      } else {
        await page.reload()
        await booted(page)
      }
      await expect.poll(() => contract(page), { timeout: 90_000, message: 'Paul\'s reload did not land on the summary contract' }).toBe(true)
      const settled = await syncBar(page).waitFor({ state: 'visible', timeout: 30_000 }).then(async () => {
        await expect(syncBar(page)).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
        return true
      }).catch(() => false)
      const statusAfterReload = await syncBar(page).getAttribute('data-status').catch(() => null)
      await paul.context.close()

      // ── Marie, cold, through the server-answered views ────────────────────
      const seen = write === 'diagram'
        ? await marieSeesDiagram(browser, ws, writtenId, writtenName)
        : await marieSeesObjectName(browser, ws, writtenId, writtenName)

      record(cell, {
        workspace: ws, writtenId, writtenName, offlineStatus, banner, statusBeforeReload,
        journalKeysDeleted, settledAfterReload: settled, statusAfterReload, marieSees: seen,
      })
      const expected = EXPECTED[CLIENT][cell]
      expect(
        seen,
        expected
          ? `${CLIENT}/${cell}: the write made offline before the promotion is NOT visible to a cold user after Paul came back — a loss (carry it into T-SUM-1, then flip EXPECTED)`
          : `${CLIENT}/${cell}: the write is now VISIBLE — the loss recorded by T-SUM-0 is gone (T-SUM-1?): flip EXPECTED and update the measurement notes above it`,
      ).toBe(expected)
    })
  }
})
