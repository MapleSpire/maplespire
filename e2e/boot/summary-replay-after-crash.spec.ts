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
 * T-SUM-2, exit (4): the crash replay on a SUMMARY workspace, two Chromium.
 *
 * The entity-intent replay (`maybeReplayEntityIntents`, bridge.ts) asks the
 * server witness about an intent whose entity it cannot find in the overlay
 * it loaded; the ABSENCE answer is usable only under `absenceProvable`
 * (bridge.ts, `if (!result.absenceProvable) witnessesReliable = false`), and
 * without it a STAMPED intent is deferred — kept journaled, counted by the
 * badge — until a later round can prove the absence.
 *
 * THE SEQUENCE, the one the T-SUM-2 claim names ("a deletion made by Marie
 * before the crash"):
 *
 *  1. Paul (a PERSISTENT profile) renames object X. The rename lands — synced,
 *     projected into `ro_objects` — and the journal STAMPS it with its batch
 *     id; its acknowledgement round is cut for that tab (`durable-heads`
 *     aborted: an outage of one endpoint), so the intent stays journaled.
 *  2. Marie (a second, cold Chromium) deletes X, then makes eight more edits —
 *     enough batches for the server to ROTATE the object write head (the
 *     harness runs this suite with `AM_OVERLAY_SEGMENT_SIZE=8`). Paul's live
 *     tab receives the rotated ModelMeta and re-enters its replay on the new
 *     head: the client loads only the CURRENT head, so his batch id is out of
 *     its sight and X is in no overlay and no `ro_objects` row — it must ask
 *     the witness (else the run is VOID: the case was not reached). Then his
 *     renderer is killed (CDP `Page.crash`, no lifecycle flush).
 *  3. Paul reopens on the same profile, the endpoint back. The journal must
 *     drain — the intent ACKNOWLEDGED — within the budget.
 *
 * MEASURED, AND IT DOES NOT DISCRIMINATE T-SUM-2: GREEN on the code before
 * the fix and on the fix alike. The crashed tab's intent is
 * already SENT — acknowledged locally by its own batch when it was written —
 * and the reopened tab releases it through `durable-heads` in tens of
 * milliseconds, never asking the witness; X stays deleted. The branch that
 * reads `absenceProvable` (a stamped intent deferred) is reached only by a
 * crash between the stamp's persist and the SENT persist, with the batch not
 * delivered — not built here. Kept as a QUALIFICATION of the summary crash
 * replay; the witness answers are recorded (`E2E_REPLAY_OBSERVATIONS`).
 *
 * NOT in CI: run it through `node scripts/e2e-summary-visibility.mjs
 * --suite=replay` (its own stack, fixture arm, the rotation settings above).
 */

import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { syncBar } from '../support/workspaceReady'

const PAUL = process.env.E2E_DEV_EMAIL ?? 'paul@summary.e2e.test'
const MARIE = process.env.E2E_COLD_EMAIL ?? 'marie@summary.e2e.test'
const LANDSCAPE = process.env.E2E_SUMMARY_LANDSCAPE ?? ''
const VERSION = process.env.E2E_SUMMARY_VERSION ?? ''
const DATABASE_URL = process.env.DATABASE_URL ?? ''
const OBSERVATIONS = process.env.E2E_REPLAY_OBSERVATIONS ?? null
/** How long the reopened tab gets to acknowledge the intent. */
const DRAIN_BUDGET_MS = 90_000

type ProbeWindow = Window & {
  __bridgeDebug?: () => { registrySummaryOnly?: boolean } & Record<string, unknown>
  __modelStore?: { getState: () => {
    currentDiagramId: string | null
    objects: Array<{ id: string; name: string }>
    updateObject: (id: string, data: { name: string }) => void
    deleteObject: (id: string) => void
  } }
}

function observe(event: Record<string, unknown>): void {
  if (OBSERVATIONS) appendFileSync(OBSERVATIONS, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
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

/** Deep-link the workspace HOME and wait for the summary contract. */
async function enterWorkspace(page: Page, email: string): Promise<void> {
  await signIn(page, email)
  await page.goto(`/app/landscape/${LANDSCAPE}/version/${VERSION}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const state = (window as ProbeWindow).__modelStore?.getState()
    return !!state?.currentDiagramId && state.objects.length > 0 && !!(window as ProbeWindow).__bridgeDebug
  }, undefined, { timeout: 120_000 })
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__bridgeDebug?.().registrySummaryOnly ?? null),
    { timeout: 90_000, message: 'the declared workspace is not running the summary contract: VOID' }).toBe(true)
}

/** The durability latch (`syncBar`'s `data-status`): every local write
 * acknowledged by the server. Used between Marie's edits so each is its own
 * flush, hence its own batch. */
async function syncReady(page: Page, timeout = 60_000): Promise<void> {
  await expect(syncBar(page)).toHaveAttribute('data-status', 'ready', { timeout })
}

/** The entity-intent journal records for `id`, read raw from IndexedDB. */
async function journalFor(page: Page, id: string): Promise<Array<{ op?: string; writtenInBatchId?: string }>> {
  return page.evaluate(async (target: string) => new Promise((resolve) => {
    const name = ((ns) => (ns ? `maplespire-model-index@${ns}` : 'maplespire-model-index'))(localStorage.getItem('maplespire:accountNamespace'))
    const open = indexedDB.open(name)
    open.onerror = () => resolve([])
    open.onsuccess = () => {
      const db = open.result
      try {
        const tx = db.transaction('idx', 'readonly')
        const store = tx.objectStore('idx')
        const keys = store.getAllKeys()
        const values = store.getAll()
        tx.oncomplete = () => {
          db.close()
          const found: Array<{ op?: string; writtenInBatchId?: string }> = []
          ;(keys.result as IDBValidKey[]).forEach((key, index) => {
            if (typeof key !== 'string' || !key.includes('pending-entity-intents:')) return
            const list = values.result[index]
            if (!Array.isArray(list)) return
            for (const entry of list) if ((entry as { id?: string }).id === target) found.push(entry as { op?: string; writtenInBatchId?: string })
          })
          resolve(found)
        }
        tx.onerror = () => { db.close(); resolve([]) }
      } catch {
        db.close()
        resolve([])
      }
    }
  }), id)
}

async function crash(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page)
  await Promise.race([
    cdp.send('Page.crash').catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ])
  await Promise.race([context.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000))])
}

type Pg = { Client: new (options: { connectionString: string }) => {
  connect(): Promise<void>; end(): Promise<void>
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
} }

test('a rename journaled before Paul\'s crash, its object deleted by Marie and its head rotated, is ACKNOWLEDGED after the reopen (summary, two Chromium)', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(420_000)
  expect(LANDSCAPE && VERSION, 'E2E_SUMMARY_LANDSCAPE/E2E_SUMMARY_VERSION: the harness declared nothing').toBeTruthy()
  expect(DATABASE_URL, 'DATABASE_URL: the rotation witness reads the database').toBeTruthy()
  const pg = createRequire(path.join(process.cwd(), 'server', 'package.json'))('pg') as Pg
  const db = new pg.Client({ connectionString: DATABASE_URL })
  await db.connect()
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'maplespire-tsum2-replay-'))
  try {
    // ── 1. Paul renames X, the journal stamps it, the renderer dies ──────────
    const paulContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
    const paul = paulContext.pages()[0] ?? await paulContext.newPage()
    await enterWorkspace(paul, PAUL)
    await syncReady(paul, 120_000)
    const objects = await paul.evaluate(() => (window as ProbeWindow).__modelStore!.getState().objects.map((o) => ({ id: o.id, name: o.name })))
    expect(objects.length, 'the landing diagram must show at least ten objects').toBeGreaterThanOrEqual(10)
    const target = objects[0]
    const renamed = `T-SUM-2 Paul ${Date.now()}`
    const startedAt = new Date()
    // The ACKNOWLEDGEMENT round is cut for this tab only (an outage of one
    // endpoint, not a crafted state): the release of a SENT intent needs a
    // positive `durable-heads` answer, so the stamped intent is still
    // journaled when the renderer dies, however long the rest takes. The
    // rename itself syncs over the socket as usual.
    await paulContext.route('**/api/automerge/durable-heads**', (route) => route.abort())
    await paul.evaluate(({ id, name }) => (window as ProbeWindow).__modelStore!.getState().updateObject(id, { name }), { id: target.id, name: renamed })
    let stamped: Array<{ op?: string; writtenInBatchId?: string }> = []
    const seen: string[] = []
    const stampDeadline = Date.now() + 10_000
    while (Date.now() < stampDeadline) {
      stamped = await journalFor(paul, target.id)
      const shape = JSON.stringify(stamped.map((entry) => ({ op: entry.op, stamped: typeof entry.writtenInBatchId === 'string' })))
      if (seen.at(-1) !== shape) seen.push(shape)
      if (stamped.some((entry) => typeof entry.writtenInBatchId === 'string')) break
    }
    observe({ step: 'paul-journal', seen })
    expect(stamped.some((entry) => typeof entry.writtenInBatchId === 'string'),
      `VOID: the journal never held a STAMPED intent for X (shapes seen: ${seen.join(' → ')})`).toBe(true)
    // The rename reached the server and was projected before the crash: the
    // write LANDED, only its acknowledgement did not.
    await expect.poll(async () => (await db.query<{ name: string | null }>(
      `SELECT name FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
      [LANDSCAPE, VERSION, target.id])).rows[0]?.name ?? null, { timeout: 30_000, message: 'VOID: the rename never reached ro_objects' }).toBe(renamed)
    expect((await journalFor(paul, target.id)).length, 'VOID: the intent was released before the crash').toBeGreaterThan(0)
    // Paul's witness answers, from here on (his live tab re-enters the replay
    // when the head rotates under it).
    const witness: Array<{ tab: string; absenceProvable: boolean | null; askedForTarget: boolean }> = []
    const listen = (page: Page, tab: string) => page.on('response', async (response) => {
      if (!response.url().includes('/api/model/durability-witness')) return
      const asked = response.request().postDataJSON() as { objects?: string[] } | null
      const body = await response.json().catch(() => ({})) as { absenceProvable?: boolean }
      witness.push({ tab, absenceProvable: body.absenceProvable ?? null, askedForTarget: Boolean(asked?.objects?.includes(target.id)) })
    })
    listen(paul, 'live')

    // ── 2. Marie deletes X and makes the head rotate ──────────────────────────
    const marieContext = await browser.newContext({ baseURL })
    const marie = await marieContext.newPage()
    await enterWorkspace(marie, MARIE)
    await syncReady(marie, 120_000)
    const marieObjects = await marie.evaluate(() => (window as ProbeWindow).__modelStore!.getState().objects.map((o) => o.id))
    expect(marieObjects, 'VOID: Marie\'s landing diagram does not show X').toContain(target.id)
    await marie.evaluate((id) => (window as ProbeWindow).__modelStore!.getState().deleteObject(id), target.id)
    await syncReady(marie)
    const others = marieObjects.filter((id) => id !== target.id).slice(0, 8)
    for (const [index, id] of others.entries()) {
      await marie.evaluate(({ id: objectId, name }) => (window as ProbeWindow).__modelStore!.getState().updateObject(objectId, { name }),
        { id, name: `T-SUM-2 Marie ${index} ${Date.now()}` })
      await marie.waitForTimeout(400)
      await syncReady(marie)
    }
    await expect.poll(async () => (await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM read_model_overlay_rotations
        WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' AND status = 'published' AND published_at > $3`,
      [LANDSCAPE, VERSION, startedAt])).rows[0].n, { timeout: 60_000, message: 'VOID: the object write head never rotated' }).not.toBe('0')
    // Paul's live tab receives the rotated ModelMeta and re-enters its replay
    // on the new head: his batch is out of its sight and X is in no overlay,
    // so it must ask the witness. Then the renderer dies.
    const askDeadline = Date.now() + 30_000
    while (Date.now() < askDeadline && !witness.some((entry) => entry.askedForTarget)) await paul.waitForTimeout(250)
    const beforeCrash = await journalFor(paul, target.id)
    const paulView = await paul.evaluate((id) => {
      const w = window as unknown as ProbeWindow & { __bridgeDebug?: () => Record<string, unknown> }
      const d = w.__bridgeDebug?.()
      return {
        storeName: w.__modelStore?.getState().objects.find((o) => o.id === id)?.name ?? null,
        tombstoned: Array.isArray(d?.tombObj) ? (d!.tombObj as string[]).includes(id) : null,
        metaDeleted: Array.isArray(d?.metaDeletedObj) ? (d!.metaDeletedObj as string[]).includes(id) : null,
        segments: d?.objectOverlaySegmentCount ?? null, heads: d?.resolvedObjectOverlayHeads ?? null,
        pending: d?.pendingIntentsByKind ?? null, editsObj: d?.editsObj ?? null, dirtyObj: d?.dirtyObj ?? null,
      }
    }, target.id)
    const heads = (await db.query<{ old_document_id: string; new_document_id: string; status: string }>(
      `SELECT old_document_id, new_document_id, status FROM read_model_overlay_rotations
        WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' ORDER BY created_at`, [LANDSCAPE, VERSION])).rows
    observe({ step: 'before-crash', witness: [...witness], paulView, heads,
      journal: beforeCrash.map((entry) => ({ op: entry.op, stamped: typeof entry.writtenInBatchId === 'string', sent: 'sent' in entry })) })
    expect(beforeCrash.length, 'VOID: the intent left the journal before the crash').toBeGreaterThan(0)
    await crash(paulContext, paul)
    observe({ step: 'paul-crashed', target: target.id })
    // The read model's view of X, from Marie's session, before Paul is back.
    const beforeReopen = await marie.evaluate(async ({ landscapeId, versionId, id }) => {
      const response = await fetch(`/api/model/durability-witness?landscapeId=${encodeURIComponent(landscapeId)}&versionId=${encodeURIComponent(versionId)}`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objects: [id], connections: [] }),
      })
      const body = await response.json() as { absenceProvable?: boolean; objects?: Record<string, { name?: string }>; status?: string }
      return { status: response.status, absenceProvable: body.absenceProvable ?? null, name: body.objects?.[id]?.name ?? null, freshness: body.status ?? null }
    }, { landscapeId: LANDSCAPE, versionId: VERSION, id: target.id })
    observe({ step: 'before-reopen', witness: beforeReopen })

    // ── 3. Paul reopens: the journal must drain — the intent acknowledged ────
    const reopenedContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    listen(reopened, 'reopened')
    await enterWorkspace(reopened, PAUL)
    const reopenedAt = Date.now()
    let drainedAfterMs: number | null = null
    const deadline = reopenedAt + DRAIN_BUDGET_MS
    while (Date.now() < deadline) {
      if ((await journalFor(reopened, target.id)).length === 0) { drainedAfterMs = Date.now() - reopenedAt; break }
      await reopened.waitForTimeout(500)
    }
    const remaining = await journalFor(reopened, target.id)
    // What Marie sees of X afterwards (recorded, not judged — see the header).
    await marie.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
    const marieSeesAfter = await marie.evaluate(async ({ landscapeId, versionId, id }) => {
      const response = await fetch(`/api/model/durability-witness?landscapeId=${encodeURIComponent(landscapeId)}&versionId=${encodeURIComponent(versionId)}`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objects: [id], connections: [] }),
      })
      const body = await response.json() as { objects?: Record<string, { name?: string }> }
      return body.objects?.[id]?.name ?? null
    }, { landscapeId: LANDSCAPE, versionId: VERSION, id: target.id }).catch(() => 'unread')
    observe({ step: 'after-reopen', witness, drainedAfterMs, remaining, marieSeesAfter, renamed })
    testInfo.annotations.push({ type: 't-sum-2', description: JSON.stringify({ beforeReopen, witness, drainedAfterMs, marieSeesAfter }) })
    expect(drainedAfterMs, `the intent was never acknowledged in ${DRAIN_BUDGET_MS} ms (journal: ${JSON.stringify(remaining)}; witness: ${JSON.stringify(witness)})`).not.toBeNull()
    await reopenedContext.close().catch(() => undefined)
    await marieContext.close().catch(() => undefined)
  } finally {
    await db.end().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
