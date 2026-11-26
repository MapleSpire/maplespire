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
 * T-SUM-2b: the entity-intent replay once the server can PROVE an absence,
 * two Chromium, on an ordinary workspace AND on a summary one
 * (`E2E_REPLAY_WORKSPACES`, one entry per plane; the harness's
 * `--suite=resurrection` declares both).
 *
 * THE CRASH BETWEEN TWO INDEXEDDB WRITES is built, not waited for. An init
 * script wraps `IDBObjectStore` writes: once armed for an entity id, the put
 * that persists that entity's STAMPED intent (`writtenInBatchId`, not SENT)
 * goes through, and every IndexedDB write after it — Automerge's own storage,
 * the SENT persist, every journal — is dropped, as if the process had died
 * right after that put. Then the renderer is killed (CDP `Page.crash`). The
 * reopened profile is read raw BEFORE the app boots (a static file of the same
 * origin), so a run whose disk does not hold exactly "stamped, not SENT" is
 * VOID, not green.
 *
 * Test 1 — RESURRECTION. Marie renames X; the batch reaches the server and is
 * projected (`ro_objects`, `read_model_overlay_batch_acks`), the tab dies
 * before the SENT persist. Paul deletes X and writes until the object write
 * head ROTATES, so Marie's batch is out of the sight of the head a new session
 * loads; the witness then proves X absent (`absenceProvable`). Marie reopens.
 * The planner finds a stamped upsert, its batch in no loaded segment, X in no
 * overlay and absent from a caught-up read model: it replays the snapshot,
 * lifts Paul's tombstone, and X comes back. The verdict: X stays deleted and
 * the intent is acknowledged.
 *
 * Test 2 — THE BATCH NEVER SENT. Marie creates N with her outbound Automerge
 * frames dropped (`routeWebSocket`), the tab dies after the stamp. Nothing of
 * N exists on the server. Marie reopens: N must be replayed EXACTLY ONCE (one
 * `entity-intents.replay` mark carrying a replay) and acknowledged, and the
 * server must hold N.
 */

import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { syncBar } from '../support/workspaceReady'

const PAUL = process.env.E2E_DEV_EMAIL ?? 'paul@summary.e2e.test'
const MARIE = process.env.E2E_COLD_EMAIL ?? 'marie@summary.e2e.test'
const DATABASE_URL = process.env.DATABASE_URL ?? ''
const OBSERVATIONS = process.env.E2E_REPLAY_OBSERVATIONS ?? null
const WORKSPACES = JSON.parse(process.env.E2E_REPLAY_WORKSPACES ?? '[]') as Array<{
  plane: 'ordinary' | 'summary'
  landscapeId: string
  versionId: string
}>
/** How long the reopened tab gets to drain its journal. */
const DRAIN_BUDGET_MS = 60_000

type Store = {
  currentDiagramId: string | null
  objects: Array<{ id: string; name: string }>
  updateObject: (id: string, data: { name: string }) => void
  deleteObject: (id: string) => void
  addObject: (object: Record<string, unknown>) => string
}
type ProbeWindow = Window & {
  __bridgeDebug?: () => { registrySummaryOnly?: boolean } & Record<string, unknown>
  __modelStore?: { getState: () => Store }
  __maplespireDiagnostics?: { timeline?: () => { entries: Array<{ name: string; details: Record<string, unknown> }> } }
  __e2eIdbFreeze?: { armedFor: string | null; frozen: boolean; dropped: number }
}
type JournalEntry = { id?: string; op?: string; writtenInBatchId?: string; sent?: unknown }

function observe(event: Record<string, unknown>): void {
  if (OBSERVATIONS) appendFileSync(OBSERVATIONS, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
}

/**
 * Installed before any app script. Writes are dropped by answering with a
 * `count()` request of the same store — a request that succeeds and changes
 * nothing, so no caller sees an error it would retry or report.
 */
function installIdbFreeze(): void {
  const state = { armedFor: null as string | null, frozen: false, dropped: 0 }
  ;(window as unknown as { __e2eIdbFreeze: typeof state }).__e2eIdbFreeze = state
  const proto = IDBObjectStore.prototype as unknown as Record<string, (...args: unknown[]) => IDBRequest>
  for (const name of ['put', 'add', 'delete', 'clear']) {
    const original = proto[name]
    proto[name] = function (this: IDBObjectStore, ...args: unknown[]) {
      if (state.frozen) {
        state.dropped += 1
        return this.count()
      }
      const request = original.apply(this, args)
      if (name === 'put' && state.armedFor) {
        const [value, key] = args
        const stampedHere = typeof key === 'string' && key.includes('pending-entity-intents:') && Array.isArray(value)
          && value.some((entry) => entry && typeof entry === 'object'
            && (entry as JournalEntry).id === state.armedFor
            && typeof (entry as JournalEntry).writtenInBatchId === 'string'
            && !('sent' in (entry as object)))
        if (stampedHere) state.frozen = true
      }
      return request
    }
  }
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

async function enterWorkspace(page: Page, email: string, target: (typeof WORKSPACES)[number]): Promise<void> {
  await signIn(page, email)
  await page.goto(`/app/landscape/${target.landscapeId}/version/${target.versionId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const state = (window as ProbeWindow).__modelStore?.getState()
    return !!state?.currentDiagramId && state.objects.length > 0 && !!(window as ProbeWindow).__bridgeDebug
  }, undefined, { timeout: 120_000 })
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__bridgeDebug?.().registrySummaryOnly ?? null),
    { timeout: 90_000, message: `the workspace is not running the ${target.plane} contract: VOID` })
    .toBe(target.plane === 'summary')
}

async function syncReady(page: Page, timeout = 60_000): Promise<void> {
  await expect(syncBar(page)).toHaveAttribute('data-status', 'ready', { timeout })
}

/** The entity-intent journal records for `id`, read raw from IndexedDB. */
async function journalFor(page: Page, id: string): Promise<JournalEntry[]> {
  return page.evaluate(async (target: string) => new Promise<JournalEntry[]>((resolve) => {
    const ns = localStorage.getItem('maplespire:accountNamespace')
    const open = indexedDB.open(ns ? `maplespire-model-index@${ns}` : 'maplespire-model-index')
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
          const found: JournalEntry[] = []
          ;(keys.result as IDBValidKey[]).forEach((key, index) => {
            if (typeof key !== 'string' || !key.includes('pending-entity-intents:')) return
            const list = values.result[index]
            if (!Array.isArray(list)) return
            for (const entry of list) if ((entry as JournalEntry)?.id === target) found.push(entry as JournalEntry)
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

/** The same-origin witness, asked from a live session. */
async function witnessFrom(page: Page, target: (typeof WORKSPACES)[number], id: string) {
  return page.evaluate(async ({ landscapeId, versionId, objectId }) => {
    const response = await fetch(`/api/model/durability-witness?landscapeId=${encodeURIComponent(landscapeId)}&versionId=${encodeURIComponent(versionId)}`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objects: [objectId], connections: [] }),
    })
    const body = await response.json() as {
      absenceProvable?: boolean; status?: string; projectionGeneration?: number; objects?: Record<string, { name?: string }>
    }
    return {
      absenceProvable: body.absenceProvable ?? null, present: Boolean(body.objects?.[objectId]), name: body.objects?.[objectId]?.name ?? null,
      status: body.status ?? null, generation: body.projectionGeneration ?? null,
    }
  }, { landscapeId: target.landscapeId, versionId: target.versionId, objectId: id })
}

/**
 * Installed before any app script, in EVERY document of the context: copies
 * each `entity-intents.replay*` mark out of the bounded timeline (500 entries
 * — a boot overflows it, so reading it once at the end loses marks) every
 * 50 ms and hands it to Node (`__e2eReportReplayMark`, an exposed binding),
 * so a mark made in a document the tab later navigated away from (the login
 * redirect) is still counted — found in review: a per-document tally was blind
 * to it.
 */
function installReplayMarkCollector(): void {
  const seen = new Set<number>()
  setInterval(() => {
    const report = (window as unknown as { __e2eReportReplayMark?: (mark: Record<string, unknown>) => void }).__e2eReportReplayMark
    if (!report) return
    const timeline = (window as unknown as {
      __maplespireDiagnostics?: { timeline?: () => { entries: Array<{ sequence: number; name: string; details: Record<string, unknown> }> } }
    }).__maplespireDiagnostics?.timeline?.()
    for (const entry of timeline?.entries ?? []) {
      if (!entry.name.startsWith('entity-intents.replay') || seen.has(entry.sequence)) continue
      seen.add(entry.sequence)
      report({ name: entry.name, href: location.pathname, ...entry.details })
    }
  }, 50)
}

/** The replay marks collected so far, of one kind. */
function replayMarks(marks: Array<Record<string, unknown>>, name = 'entity-intents.replay'): Array<Record<string, unknown>> {
  return marks.filter((mark) => mark.name === name)
}

/** A crashed profile can still be written to by the dying browser. */
function removeProfile(userDataDir: string): void {
  try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* left in tmp */ }
}

type Pg = { Client: new (options: { connectionString: string }) => {
  connect(): Promise<void>; end(): Promise<void>
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
} }

function openDb() {
  const pg = createRequire(path.join(process.cwd(), 'server', 'package.json'))('pg') as Pg
  return new pg.Client({ connectionString: DATABASE_URL })
}

/** Reopen Marie's profile; read the journal from disk BEFORE the app runs. */
async function reopenAndReadDisk(userDataDir: string, baseURL: string | undefined, id: string) {
  const context = await chromium.launchPersistentContext(userDataDir, { baseURL })
  const marks: Array<Record<string, unknown>> = []
  await context.exposeBinding('__e2eReportReplayMark', (_source, mark: Record<string, unknown>) => { marks.push(mark) })
  await context.addInitScript(installReplayMarkCollector)
  const page = context.pages()[0] ?? await context.newPage()
  await page.goto('/favicon.svg', { waitUntil: 'domcontentloaded' })
  const onDisk = await journalFor(page, id)
  return { context, page, onDisk, marks }
}

/**
 * The ordinary plane FOLDS: the operator compaction route folds the overlay
 * into the base shards, applies Paul's tombstone (and clears it) and points
 * ModelMeta at a fresh, empty head (`compaction.ts`). A 200 can carry a SKIP
 * (`projection_not_acknowledged`, measured): only a pass that applied the
 * tombstone counts.
 */
async function compactOrdinary(paul: Page, target: (typeof WORKSPACES)[number], expect_: 'deleted' | 'folded' = 'deleted'): Promise<unknown> {
  let compaction: unknown = null
  await expect.poll(async () => {
    compaction = await paul.evaluate(async ({ landscapeId, versionId }) => {
      const response = await fetch(`/api/model/compact?landscapeId=${encodeURIComponent(landscapeId)}&versionId=${encodeURIComponent(versionId)}`,
        { method: 'POST', credentials: 'include' })
      return { status: response.status, body: await response.json().catch(() => null) }
    }, { landscapeId: target.landscapeId, versionId: target.versionId })
    const { status, body } = compaction as { status: number; body: { skippedReason?: string; objectsDeleted?: number; objectsFolded?: number } | null }
    const count = expect_ === 'deleted' ? body?.objectsDeleted : body?.objectsFolded
    return status === 200 && !body?.skippedReason && (count ?? 0) >= 1
  }, { timeout: 90_000, intervals: [2_000], message: `VOID: the compaction never ${expect_ === 'deleted' ? 'applied Paul\'s deletion' : 'folded the overlay'}` }).toBe(true)
  return compaction
}

/** T-SUM-2c: how long the witness gets to prove X absent, with no write. */
const PROOF_CEILING_MS = 10_000

/**
 * The precondition of the defect: the witness PROVES X absent — and, since
 * T-SUM-2c, with NO write to get it (exit 3). Before T-SUM-2c, on the
 * ordinary plane, the Repo's save of the ModelMeta revision the last pass
 * after the compaction had projected landed 1–3 ms after that pass, the
 * clause's timestamp refused it, and nothing projected again on a quiet
 * workspace: 91 s of `absenceProvable: false` until the next test wrote, in 4
 * runs of 8; T-SUM-2b worked around it with a rename
 * by Paul every 10 s, removed here. Now the proof must come within
 * {@link PROOF_CEILING_MS}, and in fewer than two projection passes (the
 * witness's generation) after the first answer that reads the projection
 * caught up (`healthy`): the passes the compaction's own re-attach runs after
 * its route answers (measured: `catching_up` at the first answer, three
 * passes before `healthy`) are the compaction, not a wait. Returns the
 * passes counted.
 *
 * ORDINARY PLANE ONLY. The summary plane keeps T-SUM-2b's loop
 * ({@link proveAbsentSummary}): measured with this rule on it, a summary
 * proof after a head rotation took 6.2 s, and once more than 10 s, with the
 * rotation's new heads on the timestamp fallback — a known T-SUM-2 residual,
 * not covered here.
 */
async function proveAbsent(paul: Page, target: (typeof WORKSPACES)[number], x: string, paulObjects: string[], context: Record<string, unknown>): Promise<number | null> {
  if (target.plane === 'summary') return proveAbsentSummary(paul, target, x, paulObjects, context)
  const startedAt = Date.now()
  const first = await witnessFrom(paul, target, x)
  let lastAnswer = first
  // Settled: caught up AND the deletion already out of the rows.
  let settled = first.status === 'healthy' && !first.present ? first : null
  let provedAfterMs: number | null = first.absenceProvable === true && !first.present ? 0 : null
  while (provedAfterMs === null && Date.now() - startedAt < PROOF_CEILING_MS) {
    await paul.waitForTimeout(100)
    lastAnswer = await witnessFrom(paul, target, x)
    if (!settled && lastAnswer.status === 'healthy' && !lastAnswer.present) settled = lastAnswer
    if (lastAnswer.absenceProvable === true && !lastAnswer.present) provedAfterMs = Date.now() - startedAt
  }
  const passes = settled ? (lastAnswer.generation ?? 0) - (settled.generation ?? 0) : null
  observe({ plane: target.plane, step: provedAfterMs === null ? 'never-proved' : 'proved', x, provedAfterMs, passes, first, settled, lastAnswer, ...context })
  expect(provedAfterMs, `the witness never proved X absent in ${PROOF_CEILING_MS} ms with no write (last answer ${JSON.stringify(lastAnswer)})`).not.toBeNull()
  expect(passes, `the proof took ${passes} projection passes after the projection settled (${JSON.stringify(settled)})`).not.toBeNull()
  expect(passes!, `the proof took ${passes} projection passes after the projection settled (${JSON.stringify(settled)})`).toBeLessThan(2)
  return passes
}

/** T-SUM-2b's precondition, kept for the SUMMARY plane: Paul renames another
 * object every 10 s until the witness proves X absent (90 s). Returns the
 * renames made. */
async function proveAbsentSummary(paul: Page, target: (typeof WORKSPACES)[number], x: string, paulObjects: string[], context: Record<string, unknown>): Promise<number> {
  let lastAnswer: unknown = null
  let lastNudge = 0
  let nudges = 0
  const proved = await expect.poll(async () => {
    const answer = await witnessFrom(paul, target, x)
    lastAnswer = answer
    const ok = answer.absenceProvable === true && !answer.present
    if (!ok && Date.now() - lastNudge > 10_000) {
      lastNudge = Date.now()
      const other = paulObjects.find((id) => id !== x)!
      await paul.evaluate(({ objectId, name }) => (window as ProbeWindow).__modelStore!.getState().updateObject(objectId, { name }),
        { objectId: other, name: `T-SUM-2b Paul nudge ${Date.now()}` })
      nudges += 1
    }
    return ok
  }, { timeout: 90_000 }).toBe(true).then(() => true, () => false)
  observe({ plane: target.plane, step: proved ? 'proved' : 'never-proved', x, nudges, lastAnswer, ...context })
  expect(proved, `VOID: the witness never proved X absent (last answer ${JSON.stringify(lastAnswer)})`).toBe(true)
  return nudges
}

/** Every witness answer the page receives, with what it asked. */
function recordWitness(page: Page): Array<{ request: { objects?: string[]; batches?: string[] } | null; absenceProvable: unknown; batches: unknown }> {
  const asked: Array<{ request: { objects?: string[]; batches?: string[] } | null; absenceProvable: unknown; batches: unknown }> = []
  page.on('response', async (response) => {
    if (!response.url().includes('/api/model/durability-witness')) return
    const request = response.request().postDataJSON() as { objects?: string[]; batches?: string[] } | null
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    asked.push({ request, absenceProvable: body.absenceProvable ?? null, batches: body.batches ?? null })
  })
  return asked
}

for (const target of WORKSPACES) {
  test.describe(`${target.plane} workspace`, () => {
    test('a colleague\'s deletion is not undone by the replay of a stamped rename whose batch landed', async ({ browser, baseURL }) => {
      test.setTimeout(420_000)
      expect(DATABASE_URL, 'DATABASE_URL: the witnesses read the database').toBeTruthy()
      const db = openDb()
      await db.connect()
      const userDataDir = mkdtempSync(path.join(tmpdir(), 'maplespire-tsum2b-'))
      try {
        // ── 1. Marie renames X; the tab dies between the stamp and SENT ──────
        const marieContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
        await marieContext.addInitScript(installIdbFreeze)
        const marie = marieContext.pages()[0] ?? await marieContext.newPage()
        await enterWorkspace(marie, MARIE, target)
        await syncReady(marie, 120_000)
        const objects = await marie.evaluate(() => (window as ProbeWindow).__modelStore!.getState().objects.map((o) => o.id))
        expect(objects.length, 'the landing diagram must show at least two objects').toBeGreaterThanOrEqual(2)
        const x = objects[0]
        const renamed = `T-SUM-2b Marie ${Date.now()}`
        await marie.evaluate((id) => { (window as ProbeWindow).__e2eIdbFreeze!.armedFor = id }, x)
        await marie.evaluate(({ id, name }) => (window as ProbeWindow).__modelStore!.getState().updateObject(id, { name }), { id: x, name: renamed })
        await expect.poll(() => marie.evaluate(() => (window as ProbeWindow).__e2eIdbFreeze!.frozen),
          { timeout: 15_000, message: 'VOID: the stamped intent was never persisted' }).toBe(true)
        const stamped = (await journalFor(marie, x)).find((entry) => typeof entry.writtenInBatchId === 'string')
        expect(stamped && !('sent' in stamped), `VOID: the disk does not hold a stamped, unsent intent (${JSON.stringify(stamped)})`).toBe(true)
        const batchId = stamped!.writtenInBatchId!
        // The write LANDED: projected, and its batch acknowledged by the server.
        await expect.poll(async () => (await db.query<{ name: string | null }>(
          `SELECT name FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
          [target.landscapeId, target.versionId, x])).rows[0]?.name ?? null,
        { timeout: 30_000, message: 'VOID: the rename never reached ro_objects' }).toBe(renamed)
        await expect.poll(async () => (await db.query<{ document_id: string }>(
          `SELECT document_id FROM read_model_overlay_batch_acks WHERE landscape_id = $1 AND version_id = $2 AND batch_id = $3`,
          [target.landscapeId, target.versionId, batchId])).rows.length,
        { timeout: 30_000, message: 'VOID: the server never acknowledged the batch' }).toBe(1)
        await crash(marieContext, marie)
        const startedAt = new Date()

        // ── 2. Paul deletes X and makes the object head rotate ───────────────
        const paulContext = await browser.newContext({ baseURL })
        const paul = await paulContext.newPage()
        await enterWorkspace(paul, PAUL, target)
        await syncReady(paul, 120_000)
        const paulObjects = await paul.evaluate(() => (window as ProbeWindow).__modelStore!.getState().objects.map((o) => o.id))
        expect(paulObjects, 'VOID: Paul\'s landing diagram does not show X').toContain(x)
        await paul.evaluate((id) => (window as ProbeWindow).__modelStore!.getState().deleteObject(id), x)
        await syncReady(paul)
        const ackHead = (await db.query<{ document_id: string }>(
          `SELECT document_id FROM read_model_overlay_batch_acks WHERE landscape_id = $1 AND version_id = $2 AND batch_id = $3`,
          [target.landscapeId, target.versionId, batchId])).rows[0].document_id
        const rotatedAway = async () => Number((await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM read_model_overlay_rotations
            WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' AND status = 'published' AND old_document_id = $3`,
          [target.landscapeId, target.versionId, ackHead])).rows[0].n) > 0
        let edits = 0
        let compaction: unknown = null
        if (target.plane === 'summary') {
          // The static plane rotates its head after eight batches
          // (`AM_OVERLAY_SEGMENT_SIZE=8`, set by the harness).
          const others = paulObjects.filter((id) => id !== x)
          while (edits < 24 && !(await rotatedAway())) {
            await paul.evaluate(({ objectId, name }) => (window as ProbeWindow).__modelStore!.getState().updateObject(objectId, { name }),
              { objectId: others[edits % others.length], name: `T-SUM-2b Paul ${edits} ${Date.now()}` })
            edits += 1
            await paul.waitForTimeout(400)
            await syncReady(paul)
          }
          await expect.poll(rotatedAway, { timeout: 60_000, message: `VOID: the head holding Marie's batch (${ackHead}) never rotated away` }).toBe(true)
        } else {
          compaction = await compactOrdinary(paul, target)
        }
        const proofPasses = await proveAbsent(paul, target, x, paulObjects, { test: 'resurrection', compaction, edits })
        observe({ plane: target.plane, test: 'resurrection', step: 'before-reopen', x, batchId, ackHead, paulEdits: edits, proofPasses, compaction, startedAt })

        // ── 3. Marie reopens ──────────────────────────────────────────────────
        const { context: reopenedContext, page: reopened, onDisk, marks: allMarks } = await reopenAndReadDisk(userDataDir, baseURL, x)
        observe({ plane: target.plane, test: 'resurrection', step: 'disk', onDisk: onDisk.map((entry) => ({ op: entry.op, stamped: typeof entry.writtenInBatchId === 'string', sent: 'sent' in entry })) })
        expect(onDisk.length === 1 && onDisk[0].writtenInBatchId === batchId && !('sent' in onDisk[0]),
          `VOID: the reopened disk does not hold the stamped, unsent intent (${JSON.stringify(onDisk)})`).toBe(true)
        const asked = recordWitness(reopened)
        await enterWorkspace(reopened, MARIE, target)
        const reopenedAt = Date.now()
        let drainedAfterMs: number | null = null
        while (Date.now() < reopenedAt + DRAIN_BUDGET_MS) {
          if ((await journalFor(reopened, x)).length === 0) { drainedAfterMs = Date.now() - reopenedAt; break }
          await reopened.waitForTimeout(500)
        }
        // Whatever the replay wrote has had time to reach the read model.
        await reopened.waitForTimeout(5_000)
        await syncReady(reopened).catch(() => undefined)
        const marks = replayMarks(allMarks)
        const row = (await db.query<{ name: string | null }>(
          `SELECT name FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
          [target.landscapeId, target.versionId, x])).rows[0] ?? null
        const witnessAfter = await witnessFrom(paul, target, x)
        observe({ plane: target.plane, test: 'resurrection', step: 'verdict', drainedAfterMs, marks, asked, row, witnessAfter })
        // The case was reached only if the reopened planner could NOT settle X
        // locally: its batch out of the loaded head, X in no overlay — so it
        // asked the server about X.
        // NOT required here: that the answer PROVED the absence. The fixed
        // planner settles X by its landed batch either way, and the planner
        // before the fix fails either way — it resurrects X under a proof
        // ("X CAME BACK", measured on both planes) or defers it without one
        // (the drain check below). Requiring it made the ordinary arm VOID in
        // 1 run of 4 after a compaction.
        expect(asked.some((entry) => (entry.request?.objects ?? []).includes(x)),
          `VOID: the reopened tab never asked the witness about X (its batch still in sight: ${JSON.stringify(asked)})`).toBe(true)
        expect(row, `X CAME BACK: ro_objects holds ${JSON.stringify(row)} after Marie's replay (replay marks ${JSON.stringify(marks)})`).toBeNull()
        expect(witnessAfter.present, 'X CAME BACK in the witness').toBe(false)
        expect(drainedAfterMs, `the intent was never acknowledged in ${DRAIN_BUDGET_MS} ms`).not.toBeNull()
        await reopenedContext.close().catch(() => undefined)
        await paulContext.close().catch(() => undefined)
      } finally {
        await db.end().catch(() => undefined)
        removeProfile(userDataDir)
      }
    })

    test('a creation stamped but never sent is replayed exactly once and acknowledged', async ({ baseURL }) => {
      test.setTimeout(300_000)
      expect(DATABASE_URL, 'DATABASE_URL: the witnesses read the database').toBeTruthy()
      const db = openDb()
      await db.connect()
      const userDataDir = mkdtempSync(path.join(tmpdir(), 'maplespire-tsum2b-'))
      try {
        const marieContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
        await marieContext.addInitScript(installIdbFreeze)
        const outbound = { drop: false, dropped: 0 }
        await marieContext.routeWebSocket(/\/automerge/, (ws) => {
          const server = ws.connectToServer()
          ws.onMessage((message) => {
            if (outbound.drop) { outbound.dropped += 1; return }
            server.send(message)
          })
        })
        const marie = marieContext.pages()[0] ?? await marieContext.newPage()
        await enterWorkspace(marie, MARIE, target)
        await syncReady(marie, 120_000)
        // One edit ONLINE first: the overlay write heads are resolved lazily,
        // on the first edit, through the server — with the outbound frames
        // already dropped that resolution never completes and nothing is ever
        // written, let alone stamped (measured: the first run stayed at
        // "saving" with the creation dirty and unstamped).
        const warm = await marie.evaluate(() => (window as ProbeWindow).__modelStore!.getState().objects[0].id)
        await marie.evaluate((id) => (window as ProbeWindow).__modelStore!.getState().updateObject(id, { name: `T-SUM-2b warm ${Date.now()}` }), warm)
        await syncReady(marie)
        const name = `T-SUM-2b created ${Date.now()}`
        outbound.drop = true
        const n = await marie.evaluate((objectName) => {
          const state = (window as ProbeWindow).__modelStore!.getState()
          const freeze = (window as ProbeWindow).__e2eIdbFreeze!
          // The id is only known once `addObject` returns; arm for it in the
          // same task, before any flush can run.
          const id = state.addObject({
            type: 'app', name: objectName, position: { x: 40, y: 40 }, size: { width: 160, height: 90 },
            scope: 'internal', status: 'live', properties: {},
          })
          freeze.armedFor = id
          return id
        }, name)
        const frozen = await marie.waitForFunction(() => (window as ProbeWindow).__e2eIdbFreeze!.frozen, undefined, { timeout: 15_000 })
          .then(() => true, () => false)
        if (!frozen) {
          observe({
            plane: target.plane, test: 'never-sent', step: 'no-stamp', n,
            journal: await journalFor(marie, n),
            inStore: await marie.evaluate((id) => (window as ProbeWindow).__modelStore!.getState().objects.some((o) => o.id === id), n),
            freeze: await marie.evaluate(() => ({ ...(window as ProbeWindow).__e2eIdbFreeze! })),
            sync: await syncBar(marie).getAttribute('data-status').catch(() => null),
            debug: await marie.evaluate(() => {
              const d = (window as ProbeWindow).__bridgeDebug?.() ?? {}
              return { pending: d.pendingIntentsByKind ?? null, editsObj: d.editsObj ?? null, dirtyObj: d.dirtyObj ?? null }
            }),
          })
        }
        expect(frozen, 'VOID: the stamped creation was never persisted').toBe(true)
        const stamped = (await journalFor(marie, n)).find((entry) => typeof entry.writtenInBatchId === 'string')
        expect(stamped && !('sent' in stamped), `VOID: the disk does not hold a stamped, unsent creation (${JSON.stringify(stamped)})`).toBe(true)
        await crash(marieContext, marie)
        // Nothing of N reached the server.
        const serverHas = async () => (await db.query<{ id: string }>(
          `SELECT id FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
          [target.landscapeId, target.versionId, n])).rows.length
        const ackRows = (await db.query<{ batch_id: string }>(
          `SELECT batch_id FROM read_model_overlay_batch_acks WHERE landscape_id = $1 AND version_id = $2 AND batch_id = $3`,
          [target.landscapeId, target.versionId, stamped!.writtenInBatchId])).rows.length
        expect({ serverHas: await serverHas(), ackRows, droppedFrames: outbound.dropped > 0 },
          'VOID: the creation reached the server before the crash').toEqual({ serverHas: 0, ackRows: 0, droppedFrames: true })

        const { context: reopenedContext, page: reopened, onDisk, marks: allMarks } = await reopenAndReadDisk(userDataDir, baseURL, n)
        expect(onDisk.length === 1 && onDisk[0].writtenInBatchId === stamped!.writtenInBatchId && !('sent' in onDisk[0]),
          `VOID: the reopened disk does not hold the stamped, unsent creation (${JSON.stringify(onDisk)})`).toBe(true)
        await enterWorkspace(reopened, MARIE, target)
        const reopenedAt = Date.now()
        let drainedAfterMs: number | null = null
        while (Date.now() < reopenedAt + DRAIN_BUDGET_MS) {
          if ((await journalFor(reopened, n)).length === 0) { drainedAfterMs = Date.now() - reopenedAt; break }
          await reopened.waitForTimeout(500)
        }
        await expect.poll(serverHas, { timeout: 30_000, message: 'the replayed creation never reached ro_objects' }).toBe(1)
        // Late passes (follow-ups, reconnects) have had their chance.
        await reopened.waitForTimeout(5_000)
        const marks = replayMarks(allMarks).filter((details) => Number(details.replayed ?? 0) > 0)
        observe({ plane: target.plane, test: 'never-sent', n, drainedAfterMs, marks, stampedBatch: stamped!.writtenInBatchId })
        expect(drainedAfterMs, `the replayed creation was never acknowledged in ${DRAIN_BUDGET_MS} ms`).not.toBeNull()
        expect(marks, 'the creation must be replayed exactly once').toHaveLength(1)
        await reopenedContext.close().catch(() => undefined)
      } finally {
        await db.end().catch(() => undefined)
        removeProfile(userDataDir)
      }
    })

    test('a rename never sent does not bring back an object a colleague deleted durably', async ({ browser, baseURL }) => {
      // The other half of exit (2): Marie's batch never reached the server,
      // so no server fact says "it landed" — the replay must consult the
      // DELETION (ModelMeta's tombstone, or, once a compaction cleared it, the
      // entity that existed and is proved absent) and let it win, as the
      // projector and a live offline edit already do.
      test.setTimeout(420_000)
      expect(DATABASE_URL, 'DATABASE_URL: the witnesses read the database').toBeTruthy()
      const db = openDb()
      await db.connect()
      const userDataDir = mkdtempSync(path.join(tmpdir(), 'maplespire-tsum2b-'))
      try {
        const marieContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
        await marieContext.addInitScript(installIdbFreeze)
        const outbound = { drop: false, dropped: 0 }
        await marieContext.routeWebSocket(/\/automerge/, (ws) => {
          const server = ws.connectToServer()
          ws.onMessage((message) => {
            if (outbound.drop) { outbound.dropped += 1; return }
            server.send(message)
          })
        })
        const marie = marieContext.pages()[0] ?? await marieContext.newPage()
        await enterWorkspace(marie, MARIE, target)
        await syncReady(marie, 120_000)
        const objects = await marie.evaluate(() => (window as ProbeWindow).__modelStore!.getState().objects.map((o) => o.id))
        expect(objects.length, 'the landing diagram must show at least two objects').toBeGreaterThanOrEqual(2)
        const x = objects[0]
        // The lazy write-head resolution needs the server (see the test above).
        await marie.evaluate((id) => (window as ProbeWindow).__modelStore!.getState().updateObject(id, { name: `T-SUM-2b warm ${Date.now()}` }), objects[1])
        await syncReady(marie)
        const renamed = `T-SUM-2b Marie offline ${Date.now()}`
        outbound.drop = true
        await marie.evaluate((id) => { (window as ProbeWindow).__e2eIdbFreeze!.armedFor = id }, x)
        await marie.evaluate(({ id, name }) => (window as ProbeWindow).__modelStore!.getState().updateObject(id, { name }), { id: x, name: renamed })
        await expect.poll(() => marie.evaluate(() => (window as ProbeWindow).__e2eIdbFreeze!.frozen),
          { timeout: 15_000, message: 'VOID: the stamped rename was never persisted' }).toBe(true)
        const stamped = (await journalFor(marie, x)).find((entry) => typeof entry.writtenInBatchId === 'string')
        expect(stamped && !('sent' in stamped), `VOID: the disk does not hold a stamped, unsent rename (${JSON.stringify(stamped)})`).toBe(true)
        await crash(marieContext, marie)
        const serverName = async () => (await db.query<{ name: string | null }>(
          `SELECT name FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
          [target.landscapeId, target.versionId, x])).rows[0]?.name ?? null
        const ackRows = (await db.query<{ batch_id: string }>(
          `SELECT batch_id FROM read_model_overlay_batch_acks WHERE landscape_id = $1 AND version_id = $2 AND batch_id = $3`,
          [target.landscapeId, target.versionId, stamped!.writtenInBatchId])).rows.length
        const before = await serverName()
        expect({ renamedOnServer: before === renamed, present: before !== null, ackRows, droppedFrames: outbound.dropped > 0 },
          'VOID: the rename reached the server before the crash').toEqual({ renamedOnServer: false, present: true, ackRows: 0, droppedFrames: true })

        const paulContext = await browser.newContext({ baseURL })
        const paul = await paulContext.newPage()
        await enterWorkspace(paul, PAUL, target)
        await syncReady(paul, 120_000)
        const paulObjects = await paul.evaluate(() => (window as ProbeWindow).__modelStore!.getState().objects.map((o) => o.id))
        expect(paulObjects, 'VOID: Paul\'s landing diagram does not show X').toContain(x)
        await paul.evaluate((id) => (window as ProbeWindow).__modelStore!.getState().deleteObject(id), x)
        await syncReady(paul)
        // Ordinary: the compaction applies the tombstone and CLEARS it — the
        // harder case, where only "it existed and is gone" is left. Summary:
        // the tombstone stays in ModelMeta.
        const compaction = target.plane === 'ordinary' ? await compactOrdinary(paul, target) : null
        const proofPasses = await proveAbsent(paul, target, x, paulObjects, { test: 'never-sent-rename', compaction })
        observe({ plane: target.plane, test: 'never-sent-rename', step: 'before-reopen', x, compaction, proofPasses })

        const { context: reopenedContext, page: reopened, onDisk, marks: allMarks } = await reopenAndReadDisk(userDataDir, baseURL, x)
        expect(onDisk.length === 1 && onDisk[0].writtenInBatchId === stamped!.writtenInBatchId && !('sent' in onDisk[0]),
          `VOID: the reopened disk does not hold the stamped, unsent rename (${JSON.stringify(onDisk)})`).toBe(true)
        const asked = recordWitness(reopened)
        await enterWorkspace(reopened, MARIE, target)
        const reopenedAt = Date.now()
        let drainedAfterMs: number | null = null
        while (Date.now() < reopenedAt + DRAIN_BUDGET_MS) {
          if ((await journalFor(reopened, x)).length === 0) { drainedAfterMs = Date.now() - reopenedAt; break }
          await reopened.waitForTimeout(500)
        }
        await reopened.waitForTimeout(5_000)
        const after = await serverName()
        const witnessAfter = await witnessFrom(paul, target, x)
        observe({ plane: target.plane, test: 'never-sent-rename', step: 'verdict', drainedAfterMs, marks: allMarks, asked, after, witnessAfter })
        expect(after, `X CAME BACK: ro_objects holds ${JSON.stringify(after)} after Marie's replay (marks ${JSON.stringify(allMarks)})`).toBeNull()
        expect(witnessAfter.present, 'X CAME BACK in the witness').toBe(false)
        expect(drainedAfterMs, `the intent was never acknowledged in ${DRAIN_BUDGET_MS} ms`).not.toBeNull()
        // Not silent: the drop is announced.
        expect(replayMarks(allMarks, 'entity-intents.replay-dropped-deleted').length, 'the dropped edit was never announced').toBeGreaterThan(0)
        await reopenedContext.close().catch(() => undefined)
        await paulContext.close().catch(() => undefined)
      } finally {
        await db.end().catch(() => undefined)
        removeProfile(userDataDir)
      }
    })

    test('a landed rename, its batch out of sight, does not overwrite a colleague\'s later rename', async ({ browser, baseURL }) => {
      // The LANDED proof alone (found in review: tests 1 and 3 are also saved by the
      // deletion rule, which hid a bridge that never asked for batches). Paul
      // RENAMES X after Marie's batch landed: nothing is deleted, X is
      // present, and without the server's "your batch landed" the replay
      // merges Marie's changed field over Paul's newer value.
      test.setTimeout(420_000)
      expect(DATABASE_URL, 'DATABASE_URL: the witnesses read the database').toBeTruthy()
      const db = openDb()
      await db.connect()
      const userDataDir = mkdtempSync(path.join(tmpdir(), 'maplespire-tsum2b-'))
      try {
        const marieContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
        await marieContext.addInitScript(installIdbFreeze)
        const marie = marieContext.pages()[0] ?? await marieContext.newPage()
        await enterWorkspace(marie, MARIE, target)
        await syncReady(marie, 120_000)
        const objects = await marie.evaluate(() => (window as ProbeWindow).__modelStore!.getState().objects.map((o) => o.id))
        expect(objects.length, 'the landing diagram must show at least two objects').toBeGreaterThanOrEqual(2)
        const x = objects[0]
        const marieName = `T-SUM-2b Marie landed ${Date.now()}`
        await marie.evaluate((id) => { (window as ProbeWindow).__e2eIdbFreeze!.armedFor = id }, x)
        await marie.evaluate(({ id, name }) => (window as ProbeWindow).__modelStore!.getState().updateObject(id, { name }), { id: x, name: marieName })
        await expect.poll(() => marie.evaluate(() => (window as ProbeWindow).__e2eIdbFreeze!.frozen),
          { timeout: 15_000, message: 'VOID: the stamped intent was never persisted' }).toBe(true)
        const stamped = (await journalFor(marie, x)).find((entry) => typeof entry.writtenInBatchId === 'string')
        expect(stamped && !('sent' in stamped), `VOID: the disk does not hold a stamped, unsent intent (${JSON.stringify(stamped)})`).toBe(true)
        const batchId = stamped!.writtenInBatchId!
        const serverName = async () => (await db.query<{ name: string | null }>(
          `SELECT name FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
          [target.landscapeId, target.versionId, x])).rows[0]?.name ?? null
        await expect.poll(serverName, { timeout: 30_000, message: 'VOID: the rename never reached ro_objects' }).toBe(marieName)
        const ackHead = await expect.poll(async () => (await db.query<{ document_id: string }>(
          `SELECT document_id FROM read_model_overlay_batch_acks WHERE landscape_id = $1 AND version_id = $2 AND batch_id = $3`,
          [target.landscapeId, target.versionId, batchId])).rows[0]?.document_id ?? null,
        { timeout: 30_000, message: 'VOID: the server never acknowledged the batch' }).not.toBeNull()
          .then(async () => (await db.query<{ document_id: string }>(
            `SELECT document_id FROM read_model_overlay_batch_acks WHERE landscape_id = $1 AND version_id = $2 AND batch_id = $3`,
            [target.landscapeId, target.versionId, batchId])).rows[0].document_id)
        await crash(marieContext, marie)

        const paulContext = await browser.newContext({ baseURL })
        const paul = await paulContext.newPage()
        await enterWorkspace(paul, PAUL, target)
        await syncReady(paul, 120_000)
        const paulObjects = await paul.evaluate(() => (window as ProbeWindow).__modelStore!.getState().objects.map((o) => o.id))
        expect(paulObjects, 'VOID: Paul\'s landing diagram does not show X').toContain(x)
        const paulName = `T-SUM-2b Paul later ${Date.now()}`
        await paul.evaluate(({ id, name }) => (window as ProbeWindow).__modelStore!.getState().updateObject(id, { name }), { id: x, name: paulName })
        await syncReady(paul)
        await expect.poll(serverName, { timeout: 30_000, message: 'VOID: Paul\'s rename never reached ro_objects' }).toBe(paulName)
        let compaction: unknown = null
        if (target.plane === 'summary') {
          const rotatedAway = async () => Number((await db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM read_model_overlay_rotations
              WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' AND status = 'published' AND old_document_id = $3`,
            [target.landscapeId, target.versionId, ackHead])).rows[0].n) > 0
          const others = paulObjects.filter((id) => id !== x)
          for (let edits = 0; edits < 24 && !(await rotatedAway()); edits += 1) {
            await paul.evaluate(({ objectId, name }) => (window as ProbeWindow).__modelStore!.getState().updateObject(objectId, { name }),
              { objectId: others[edits % others.length], name: `T-SUM-2b Paul ${edits} ${Date.now()}` })
            await paul.waitForTimeout(400)
            await syncReady(paul)
          }
          await expect.poll(rotatedAway, { timeout: 60_000, message: `VOID: the head holding Marie's batch (${ackHead}) never rotated away` }).toBe(true)
        } else {
          compaction = await compactOrdinary(paul, target, 'folded')
        }
        observe({ plane: target.plane, test: 'landed-vs-later-rename', step: 'before-reopen', x, batchId, ackHead, compaction })

        const { context: reopenedContext, page: reopened, onDisk, marks: allMarks } = await reopenAndReadDisk(userDataDir, baseURL, x)
        expect(onDisk.length === 1 && onDisk[0].writtenInBatchId === batchId && !('sent' in onDisk[0]),
          `VOID: the reopened disk does not hold the stamped, unsent intent (${JSON.stringify(onDisk)})`).toBe(true)
        const asked = recordWitness(reopened)
        await enterWorkspace(reopened, MARIE, target)
        const reopenedAt = Date.now()
        let drainedAfterMs: number | null = null
        while (Date.now() < reopenedAt + DRAIN_BUDGET_MS) {
          if ((await journalFor(reopened, x)).length === 0) { drainedAfterMs = Date.now() - reopenedAt; break }
          await reopened.waitForTimeout(500)
        }
        await reopened.waitForTimeout(5_000)
        const after = await serverName()
        observe({ plane: target.plane, test: 'landed-vs-later-rename', step: 'verdict', drainedAfterMs, marks: allMarks, asked, after, paulName, marieName })
        // The structural precondition (the batch's head rotated away, or the
        // overlay folded) was checked above on the server; whether the tab
        // ASKED about the batch is the subject, not a precondition (a VOID on
        // it was killed for the wrong reason by the mutant "never ask").
        expect(after, `Paul's later rename was OVERWRITTEN by the replay of Marie's landed one (asked ${JSON.stringify(asked)})`).toBe(paulName)
        expect(drainedAfterMs, `the intent was never acknowledged in ${DRAIN_BUDGET_MS} ms`).not.toBeNull()
        await reopenedContext.close().catch(() => undefined)
        await paulContext.close().catch(() => undefined)
      } finally {
        await db.end().catch(() => undefined)
        removeProfile(userDataDir)
      }
    })

    test('an undo of her own deletion, never sent, is replayed and lifts the tombstone', async ({ baseURL }) => {
      // The one upsert the deletion rule must let through (found in review:
      // the bridge's re-add flag was tested nowhere). Marie deletes X (durable),
      // then UNDOES it with her outbound frames dropped; the tab dies after
      // the stamp. On the reopen the tombstone is still in ModelMeta, and
      // only the re-add flag tells "the user brought it back" from "a later
      // deletion wins".
      test.setTimeout(300_000)
      expect(DATABASE_URL, 'DATABASE_URL: the witnesses read the database').toBeTruthy()
      const db = openDb()
      await db.connect()
      const userDataDir = mkdtempSync(path.join(tmpdir(), 'maplespire-tsum2b-'))
      try {
        const marieContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
        await marieContext.addInitScript(installIdbFreeze)
        const outbound = { drop: false, dropped: 0 }
        await marieContext.routeWebSocket(/\/automerge/, (ws) => {
          const server = ws.connectToServer()
          ws.onMessage((message) => {
            if (outbound.drop) { outbound.dropped += 1; return }
            server.send(message)
          })
        })
        const marie = marieContext.pages()[0] ?? await marieContext.newPage()
        await enterWorkspace(marie, MARIE, target)
        await syncReady(marie, 120_000)
        const objects = await marie.evaluate(() => (window as ProbeWindow).__modelStore!.getState().objects.map((o) => o.id))
        expect(objects.length, 'the landing diagram must show at least two objects').toBeGreaterThanOrEqual(2)
        const x = objects[0]
        await marie.evaluate((id) => (window as ProbeWindow).__modelStore!.getState().updateObject(id, { name: `T-SUM-2b warm ${Date.now()}` }), objects[1])
        await syncReady(marie)
        const serverHas = async () => (await db.query<{ id: string }>(
          `SELECT id FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
          [target.landscapeId, target.versionId, x])).rows.length
        await marie.evaluate((id) => (window as ProbeWindow).__modelStore!.getState().deleteObject(id), x)
        await syncReady(marie)
        await expect.poll(serverHas, { timeout: 30_000, message: 'VOID: the deletion never reached ro_objects' }).toBe(0)
        outbound.drop = true
        await marie.evaluate((id) => { (window as ProbeWindow).__e2eIdbFreeze!.armedFor = id }, x)
        const undone = await marie.evaluate((id) => {
          const history = (window as unknown as { __undoHistory?: { undo: () => unknown } }).__undoHistory
          history?.undo()
          return (window as ProbeWindow).__modelStore!.getState().objects.some((o) => o.id === id)
        }, x)
        expect(undone, 'VOID: the undo did not bring X back into the store').toBe(true)
        const frozen = await marie.waitForFunction(() => (window as ProbeWindow).__e2eIdbFreeze!.frozen, undefined, { timeout: 15_000 })
          .then(() => true, () => false)
        if (!frozen) observe({ plane: target.plane, test: 'undo-delete', step: 'no-stamp', x, journal: await journalFor(marie, x) })
        expect(frozen, 'VOID: the undo was never journaled and stamped').toBe(true)
        const stamped = (await journalFor(marie, x)).find((entry) => typeof entry.writtenInBatchId === 'string') as (JournalEntry & { reAdded?: boolean }) | undefined
        expect(stamped && !('sent' in stamped), `VOID: the disk does not hold a stamped, unsent re-add (${JSON.stringify(stamped)})`).toBe(true)
        // The bridge's half of the rule: the disk record says "re-added".
        expect(stamped!.reAdded, 'the journaled undo does not carry the re-add flag').toBe(true)
        await crash(marieContext, marie)
        expect(await serverHas(), 'VOID: the undo reached the server before the crash').toBe(0)

        const { context: reopenedContext, page: reopened, onDisk, marks: allMarks } = await reopenAndReadDisk(userDataDir, baseURL, x)
        expect(onDisk.length === 1 && onDisk[0].writtenInBatchId === stamped!.writtenInBatchId && !('sent' in onDisk[0]),
          `VOID: the reopened disk does not hold the stamped, unsent re-add (${JSON.stringify(onDisk)})`).toBe(true)
        await enterWorkspace(reopened, MARIE, target)
        const reopenedAt = Date.now()
        let drainedAfterMs: number | null = null
        while (Date.now() < reopenedAt + DRAIN_BUDGET_MS) {
          if ((await journalFor(reopened, x)).length === 0) { drainedAfterMs = Date.now() - reopenedAt; break }
          await reopened.waitForTimeout(500)
        }
        await expect.poll(serverHas, { timeout: 30_000, message: 'the undone deletion was LOST: X never came back' }).toBe(1)
        observe({ plane: target.plane, test: 'undo-delete', step: 'verdict', drainedAfterMs, marks: allMarks })
        expect(drainedAfterMs, `the re-add was never acknowledged in ${DRAIN_BUDGET_MS} ms`).not.toBeNull()
        await reopenedContext.close().catch(() => undefined)
      } finally {
        await db.end().catch(() => undefined)
        removeProfile(userDataDir)
      }
    })
  })
}

test('the harness declared both planes', () => {
  expect(WORKSPACES.map((workspace) => workspace.plane).sort()).toEqual(['ordinary', 'summary'])
})
