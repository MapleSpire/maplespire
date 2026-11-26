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
 * T-DIAGDEF-2: a workspace switch while the SERVER is down (the browser is
 * online: only the backend is gone), through the real interface, on a stack
 * whose server the spec stops (one SIGTERM) and restarts.
 *
 *  A. A diagram is deleted from its card in an ORDINARY workspace, the server
 *     is stopped at once, the user switches to a workspace this profile has
 *     already visited, the server comes back, the user switches back. The
 *     delete must reach the server — the `ro_diagrams` row leaves — without a
 *     reload. (manual test of T-DIAGDEF: the row stayed, 2/2, even after a reload.)
 *  B. With the server down, a switch to a workspace this profile has NEVER
 *     visited must end within a bound: either the workspace opens, or the user
 *     is told it could not be opened. (manual test: still not done after 25 s.)
 *
 * (M7, the badge over a diagram delete not yet written on the full-model
 * plane, is a bridge test: `bridgeDiagramDeleteDebt.test.ts`.)
 *
 * Run by `node scripts/e2e-summary-visibility.mjs --suite=switch-down`, which
 * gives the spec the two workspaces, the database and the server control. It
 * skips nothing: without them it fails.
 */

import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

const PAUL = process.env.E2E_DEV_EMAIL ?? 'paul@summary.e2e.test'
const DATABASE_URL = process.env.DATABASE_URL ?? ''
const CONTROL = process.env.E2E_SERVER_CONTROL ?? ''
const OBSERVATIONS = process.env.E2E_SWITCH_DOWN_OBSERVATIONS ?? null
const WORKSPACES = JSON.parse(process.env.E2E_SWITCH_DOWN_WORKSPACES ?? '{}') as {
  ordinary?: Workspace
  summary?: Workspace
}
/**
 * B's bound, judged from the click: the switch must have ended by then. What
 * it may wait on, when nothing answers: the outgoing drain (≤ 3 s,
 * `WORKSPACE_SWITCH_DRAIN_MS`) BESIDE the destination's access probe (≤ 3 s,
 * `WORKSPACE_ACCESS_TIMEOUT_MS`), then the root request (≤ 10 s, the boot
 * reads' `BOOT_HTTP_TIMEOUT_MS`): 13 s, plus 2 s for the page's own work.
 * A refused connection ends all three at once.
 */
const NEVER_VISITED_SWITCH_BOUND_MS = 15_000
/** A: how long the delete gets to reach `ro_diagrams` after the return. */
const RETURN_DRAIN_BUDGET_MS = 30_000

interface Workspace { landscapeId: string; versionId: string }
type ProbeWindow = Window & {
  __bridgeDebug?: () => Record<string, unknown>
  __modelStore?: { getState: () => { currentDiagramId: string | null; diagrams: Array<{ id: string }> } }
}

/** The server's `pg`, typed for the one use made of it here. */
type Pg = { Client: new (options: { connectionString: string }) => {
  connect(): Promise<void>; end(): Promise<void>
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>
} }
const pg = createRequire(path.join(process.cwd(), 'server', 'package.json'))('pg') as Pg

function observe(event: Record<string, unknown>): void {
  if (OBSERVATIONS) appendFileSync(OBSERVATIONS, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
}

async function sql<T = Record<string, unknown>>(text: string, values: unknown[]): Promise<T[]> {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    return (await client.query(text, values)).rows as T[]
  } finally {
    await client.end()
  }
}

const diagramRows = async (ws: Workspace, id: string): Promise<number> => Number((await sql<{ n: string }>(
  'SELECT count(*) AS n FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
  [ws.landscapeId, ws.versionId, id],
))[0]?.n ?? 0)

async function serverControl(action: 'stop' | 'start'): Promise<Record<string, unknown>> {
  const response = await fetch(`${CONTROL}/server/${action}`, { method: 'POST' })
  const body = await response.json() as Record<string, unknown>
  if (!response.ok || body.ok !== true) throw new Error(`server ${action}: ${response.status} ${JSON.stringify(body)}`)
  return body
}

async function pollUntil(probe: () => Promise<boolean>, timeoutMs: number, stepMs = 250): Promise<number | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await probe()) return Date.now() - startedAt
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return null
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  const field = page.getByTestId('dev-login-email')
  const landed = await Promise.race([
    field.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'form' as const),
    page.waitForURL('**/app/**', { timeout: 20_000 }).then(() => 'app' as const),
  ]).catch(() => 'form' as const)
  if (landed === 'form') {
    const legal = page.getByTestId('legal-acceptance')
    if (await legal.count()) await legal.check().catch(() => {})
    await field.fill(PAUL)
    await field.press('Enter')
    await page.waitForURL('**/app/**', { timeout: 60_000 })
  }
}

async function waitBooted(page: Page, timeout = 120_000): Promise<void> {
  await page.waitForFunction(() => {
    const state = (window as ProbeWindow).__modelStore?.getState()
    return !!state?.currentDiagramId && !!(window as ProbeWindow).__bridgeDebug
  }, undefined, { timeout })
}

async function openWorkspace(page: Page, ws: Workspace, plane: 'ordinary' | 'summary'): Promise<void> {
  await page.goto(`/app/landscape/${ws.landscapeId}/version/${ws.versionId}`, { waitUntil: 'domcontentloaded' })
  await waitBooted(page)
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__bridgeDebug?.().registrySummaryOnly ?? null),
    { timeout: 90_000, message: `the workspace is not running the ${plane} contract: VOID` }).toBe(plane === 'summary')
}

async function goNav(page: Page, testId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await page.getByTestId(testId).isVisible().catch(() => false)) break
    await page.getByTestId('nav-menu').click({ timeout: 30_000 }).catch(() => {})
    if (await page.getByTestId(testId).waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)) break
  }
  await page.getByTestId(testId).click()
}

const currentDiagramId = (page: Page): Promise<string> =>
  page.evaluate(() => (window as ProbeWindow).__modelStore!.getState().currentDiagramId as string)

async function createDiagram(page: Page): Promise<string> {
  await goNav(page, 'nav-diagrams')
  const before = await currentDiagramId(page)
  await page.getByTestId('create-diagram-button').click()
  await page.getByTestId('create-blank').click()
  await expect.poll(() => currentDiagramId(page), { timeout: 30_000 }).not.toBe(before)
  return currentDiagramId(page)
}

async function showCard(page: Page, id: string): Promise<void> {
  await goNav(page, 'nav-diagrams')
  await page.getByTestId('diagrams-search').fill('New context diagram')
  await expect(page.getByTestId(`diagram-card-${id}`)).toBeVisible({ timeout: 60_000 })
}

async function deleteCard(page: Page, id: string): Promise<void> {
  await page.getByTestId(`diagram-menu-${id}`).click()
  await page.getByTestId('diagram-delete').click()
}

/** The REAL workspace menu. Returns the click's time. */
async function clickSwitch(page: Page, ws: Workspace): Promise<number> {
  await page.keyboard.press('Escape')
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('workspace-landscapes').click()
  const row = page.locator(`[data-testid="landscape-switch"][data-landscape-id="${ws.landscapeId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  const clickedAt = Date.now()
  await row.click()
  await page.keyboard.press('Escape')
  return clickedAt
}

async function switchAndBoot(page: Page, ws: Workspace): Promise<void> {
  await clickSwitch(page, ws)
  await expect(page).toHaveURL(new RegExp(`/app/landscape/${ws.landscapeId}/`), { timeout: 60_000 })
  await waitBooted(page)
}

/** What the app holds about the deleted diagram, for the observations. */
async function clientWitness(page: Page, id: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (target: string) => {
    const state = (window as ProbeWindow).__modelStore?.getState() as unknown as Record<string, unknown> | undefined
    const ns = localStorage.getItem('maplespire:accountNamespace')
    const ledgers = await new Promise<Record<string, unknown>>((resolve) => {
      const open = indexedDB.open(ns ? `maplespire-model-index@${ns}` : 'maplespire-model-index')
      open.onerror = () => resolve({ error: 'open' })
      open.onsuccess = () => {
        const db = open.result
        try {
          const tx = db.transaction('idx', 'readonly')
          const keys = tx.objectStore('idx').getAllKeys()
          const values = tx.objectStore('idx').getAll()
          tx.oncomplete = () => {
            db.close()
            const out: Record<string, unknown> = {}
            ;(keys.result as IDBValidKey[]).forEach((key, index) => {
              if (typeof key !== 'string') return
              if (key.includes('pending-durable-heads') || key.includes('pending-entity-intents')) out[key] = values.result[index]
            })
            resolve(out)
          }
        } catch (error) {
          db.close()
          resolve({ error: String(error) })
        }
      }
    })
    return {
      url: location.pathname,
      inStore: Array.isArray(state?.diagrams) && (state!.diagrams as Array<{ id: string }>).some((d) => d.id === target),
      deletedDiagramIds: state?.deletedDiagramIds ?? null,
      pendingDeletedDiagramIds: state?.pendingDeletedDiagramIds ?? null,
      bridge: (window as ProbeWindow).__bridgeDebug?.() ?? null,
      ledgers,
    }
  }, id)
}

function requireStack(): { ordinary: Workspace; summary: Workspace } {
  const { ordinary, summary } = WORKSPACES
  if (!ordinary || !summary || !DATABASE_URL || !CONTROL) {
    throw new Error('E2E_SWITCH_DOWN_WORKSPACES, DATABASE_URL and E2E_SERVER_CONTROL are required: '
      + 'run it through `node scripts/e2e-summary-visibility.mjs --suite=switch-down`')
  }
  return { ordinary, summary }
}

// Independent cases (a fresh browser context each), run one after the other
// by the config (one worker); a red one does not hide the next.
test.afterEach(async () => {
  // Whatever happened, the next test gets a server.
  await serverControl('start').catch(() => undefined)
})

for (const entry of ['deep link', 'menu'] as const) test(`A (${entry}): a delete made just before the server stops reaches the server after an offline switch to a visited workspace`, async ({ page }) => {
  test.setTimeout(420_000)
  const { ordinary, summary } = requireStack()
  const consoleLines: string[] = []
  page.on('console', (message) => { consoleLines.push(`${message.type()} ${message.text().slice(0, 400)}`) })
  await signIn(page)
  if (entry === 'deep link') {
    // The destination is visited first: its root is cached in this profile.
    // The ordinary workspace is then entered by its CONCRETE version.
    await openWorkspace(page, summary, 'summary')
    await openWorkspace(page, ordinary, 'ordinary')
  } else {
    // Both visited through the menu (the `current` version), as the manual test did.
    await openWorkspace(page, ordinary, 'ordinary')
    await switchAndBoot(page, summary)
    await switchAndBoot(page, ordinary)
  }
  const id = await createDiagram(page)
  await showCard(page, id)
  expect(await pollUntil(async () => (await diagramRows(ordinary, id)) === 1, 60_000),
    `the created diagram ${id} never reached ro_diagrams: the precondition failed`).not.toBeNull()

  await deleteCard(page, id)
  const stopped = await serverControl('stop')
  observe({ test: `A ${entry}`, step: 'server stopped', id, stopped })
  const clickedAt = await clickSwitch(page, summary)
  const away = await expect(page).toHaveURL(new RegExp(`/app/landscape/${summary.landscapeId}/`), { timeout: 60_000 })
    .then(() => Date.now() - clickedAt, () => null)
  observe({ test: `A ${entry}`, step: 'switched away offline', urlMs: away, rowWhileAway: await diagramRows(ordinary, id) })
  const restarted = await serverControl('start')
  observe({ test: `A ${entry}`, step: 'server restarted', restarted })

  await switchAndBoot(page, ordinary)
  const goneMs = await pollUntil(async () => (await diagramRows(ordinary, id)) === 0, RETURN_DRAIN_BUDGET_MS)
  const witness = await clientWitness(page, id)
  observe({ test: `A ${entry}`, step: 'returned', id, goneMs, witness, console: consoleLines.filter((line) => !/^debug /.test(line)).slice(-80) })
  expect(goneMs, `the ro_diagrams row of the deleted diagram ${id} is still there ${RETURN_DRAIN_BUDGET_MS} ms after the return`).not.toBeNull()
  await showCardsFor(page)
  await expect(page.getByTestId(`diagram-card-${id}`)).toHaveCount(0)
})

async function showCardsFor(page: Page): Promise<void> {
  await goNav(page, 'nav-diagrams')
  await page.getByTestId('diagrams-search').fill('New context diagram')
}

/**
 * B's two shapes of "the server is down", the browser online:
 *  - `refused`: the process is gone (SIGTERM), every connection is refused at
 *    once — the manual test's case;
 *  - `unanswered`: the server, or the path to it, accepts and never answers
 *    (a process stuck in its drain, a black-holed route): every HTTP request
 *    to the API and every NEW sync socket hang. Modelled in the browser (a
 *    route that never fulfils, a WebSocket route with no server behind it).
 */
for (const shape of ['refused', 'unanswered'] as const) test(`B (${shape}): with the server down, a switch to a never-visited workspace ends within its bound`, async ({ page }) => {
  test.setTimeout(300_000)
  const { ordinary, summary } = requireStack()
  const consoleLines: string[] = []
  page.on('console', (message) => { consoleLines.push(`${message.type()} ${message.text().slice(0, 400)}`) })
  await signIn(page)
  // A fresh context: the summary workspace was never opened by this profile.
  await openWorkspace(page, ordinary, 'ordinary')
  // As the manual test did: something still owed to the workspace being left, so the
  // switch's drain is part of what is bounded.
  const id = await createDiagram(page)
  await showCard(page, id)
  expect(await pollUntil(async () => (await diagramRows(ordinary, id)) === 1, 60_000)).not.toBeNull()
  await deleteCard(page, id)
  if (shape === 'refused') {
    observe({ test: `B ${shape}`, step: 'server stopped', stopped: await serverControl('stop') })
  } else {
    const api = new URL(process.env.E2E_BOOT_API ?? 'http://localhost:3587')
    await page.route((url) => url.host === api.host, () => { /* never answered */ })
    await page.routeWebSocket((url) => url.host === api.host, () => { /* no server behind it */ })
  }
  const clickedAt = await clickSwitch(page, summary)
  const failure = page.getByTestId('canvas-boot-error')
  const outcome = await Promise.race([
    expect(page).toHaveURL(new RegExp(`/app/landscape/${summary.landscapeId}/`), { timeout: NEVER_VISITED_SWITCH_BOUND_MS })
      .then(() => waitBooted(page, Math.max(1, NEVER_VISITED_SWITCH_BOUND_MS - (Date.now() - clickedAt))))
      .then(() => 'opened' as const),
    failure.waitFor({ state: 'visible', timeout: NEVER_VISITED_SWITCH_BOUND_MS }).then(() => 'refused' as const),
  ]).catch(() => 'neither' as const)
  const elapsedMs = Date.now() - clickedAt
  const message = outcome === 'refused' ? await failure.innerText() : null
  const cause = outcome === 'refused' ? await failure.getAttribute('data-cause') : null
  observe({ test: `B ${shape}`, step: 'outcome', outcome, elapsedMs, cause, message, url: new URL(page.url()).pathname,
    console: consoleLines.filter((line) => !/^debug /.test(line)).slice(-60) })
  expect(outcome, `the switch neither opened the workspace nor told the user it could not, ${elapsedMs} ms after the click`).not.toBe('neither')
  // Never visited and no server: nothing here can open it, so the only right
  // end is the failure screen (accepting "opened" would skip every check
  // below).
  expect(outcome, 'a workspace this browser never opened "opened" with the server down: the case is VOID').toBe('refused')
  expect(elapsedMs).toBeLessThanOrEqual(NEVER_VISITED_SWITCH_BOUND_MS)
  // Told WHY: the server, not a sync still running ("still syncing" was the
  // only text this screen had).
  expect(cause, `the failure screen does not say the server could not be reached: ${message}`).toBe('server-unreachable')
})
