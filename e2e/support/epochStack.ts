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

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

/**
 * TEST-ONLY helpers for the epoch suite (`scripts/e2e-epochs.mjs` stack).
 *
 * The roll rides the compaction pass, forced through the existing
 * `POST /api/model/compact` (AUTH off: no admin needed). A roll AFTER the
 * first is made due by back-dating the published epoch's `published_at`
 * straight in SQL, on the stack's own throwaway Postgres container — never a
 * route, so nothing here ships. Retirement is staged the same way.
 */
const SERVER = process.env.E2E_EPOCHS_SERVER ?? 'http://localhost:3746'
const PG = process.env.E2E_EPOCHS_PG_CONTAINER ?? 'ui-epochs-pg-55746'

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function sql(query: string): string {
  return execFileSync('docker', ['exec', PG, 'psql', '-U', 'maplespire', '-d', 'maplespire', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim()
}

export function publishedMetaUrl(): string {
  return sql(`SELECT meta_url FROM read_model_model_epochs WHERE state = 'published' AND kind <> 'legacy' ORDER BY epoch_no DESC LIMIT 1`)
}

export function publishedEpochNo(): number {
  return Number(sql(`SELECT coalesce(max(epoch_no), -1) FROM read_model_model_epochs WHERE state = 'published'`))
}

/** `--auth` stacks: AUTH=on, the dev login. */
export const AUTH_ON = process.env.E2E_EPOCHS_AUTH === 'on'
const ADMIN_EMAIL = process.env.E2E_EPOCHS_ADMIN_EMAIL ?? 'marie@epochs.e2e.test'
/** The admin session's cookie, sent with the helpers' own requests. */
let stackCookie: string | null = null
const authHeaders = (): Record<string, string> => (stackCookie ? { Cookie: stackCookie } : {})

/** On an `--auth` stack, sign this browser context in as the platform admin
 * (the dev login; the compaction route needs one at AUTH=on), and keep its
 * cookie for the helpers. A no-op on an AUTH-off stack. */
export async function signIn(context: BrowserContext, email = ADMIN_EMAIL): Promise<void> {
  if (!AUTH_ON) return
  const login = async () => {
    const response = await context.request.post(`${SERVER}/api/auth/dev-login`, { data: { email } })
    if (!response.ok()) throw new Error(`dev-login → HTTP ${response.status()} ${await response.text()}`)
  }
  await login()
  if (email !== ADMIN_EMAIL) {
    // ANOTHER user, with access to the
    // seeded workspace — made platform admin on the test's own database
    // (staging, like the suite's other SQL), then signed in again so the
    // session carries it. Its cookie is not the helpers'.
    sql(`UPDATE users SET is_platform_admin = true WHERE issuer = 'dev' AND subject = '${email.toLowerCase().replace(/'/g, "''")}'`)
    await context.clearCookies()
    await login()
    return
  }
  const cookies = await context.cookies(SERVER)
  stackCookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

/** Paul's identity on an `--auth` stack: a user OTHER than the admin. */
export const SECOND_USER_EMAIL = 'paul@epochs.e2e.test'

/** A new browser context, signed in on an `--auth` stack (every spec runs
 * on both stacks) — as `email` when given. */
export async function newContext(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}, email?: string): Promise<BrowserContext> {
  const context = await browser.newContext(options)
  await signIn(context, email)
  return context
}

/** One compaction pass: forwards late writes on superseded documents, and
 * rolls when an epoch is due. `hold` (the stack's
 * MODEL_EPOCH_E2E_COMPACTION_HOLD knob): the pass keeps the pool-heavy slot
 * `holdMs` longer after its work (a long base-shard storage compaction), then hands it at its release
 * to one more holder of `afterMs`. */
export async function compact(hold?: { holdMs?: number; afterMs?: number }): Promise<unknown> {
  const query = hold ? `?e2eHoldMs=${hold.holdMs ?? 0}&e2eHoldAfterMs=${hold.afterMs ?? 0}` : ''
  const response = await fetch(`${SERVER}/api/model/compact${query}`, { method: 'POST', headers: authHeaders() })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`compact → HTTP ${response.status} ${JSON.stringify(body)}`)
  return body
}

/** Back-date the published epoch so the next compaction pass rolls. */
export function makeRollDue(): void {
  sql(`UPDATE read_model_model_epochs SET published_at = published_at - interval '2 days' WHERE state = 'published'`)
}

/** This run's server trace (MODEL_EPOCH_TRACE_FILE) from `sinceMs` on. */
export function serverTrace(sinceMs = 0): Array<{ t: number; event: string; [key: string]: unknown }> {
  const dir = process.env.E2E_EPOCHS_LOG_DIR
  if (!dir) throw new Error('serverTrace needs E2E_EPOCHS_LOG_DIR (run through scripts/e2e-epochs.mjs)')
  const file = path.join(dir, 'epoch-trace.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { t: number; event: string })
    .filter((e) => e.t >= sinceMs)
}

/** Make the next roll due and run the pass; returns the new epoch's meta URL. */
export async function forceRoll(): Promise<string> {
  const before = publishedEpochNo()
  makeRollDue()
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await compact()
    if (publishedEpochNo() > before) return publishedMetaUrl()
    await sleep(1_000)
  }
  throw new Error(`no roll after 10 passes (published epoch still ${before})`)
}

/** Keep forcing forwarding passes until `done()`. A superseded document is
 * "forwarded" only once a forwarder pass has advanced its cursor past the
 * roll's own changes, and the server's sweep runs every 10 min — so the test
 * drives compaction passes instead of waiting for it. */
export async function forwardUntil(done: () => Promise<boolean>, timeoutMs = 150_000, intervalMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await done()) return
    await compact().catch(() => undefined)
    await sleep(intervalMs)
  }
  throw new Error('forwarding never completed')
}

/**
 * Forwarding as an EVENT-DRIVEN forwarder would do it: one pass the moment
 * the tab's latch goes up (its heads are then paused and final), so the pass
 * can land inside the 2 s budget. A continuous typist's latch cannot converge
 * on a timer-driven pass except by luck (the server's sweep is every 10 min).
 */
export async function forwardOnLatch(page: Page, done: () => Promise<boolean>, timeoutMs = 200_000): Promise<void> {
  const latched = () => page.evaluate(() =>
    (window as unknown as { __epochHopStore: { getState(): { latched: boolean } } }).__epochHopStore.getState().latched)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await done()) return
    if (await latched()) {
      // The paused heads are final, but the last keystrokes may still be on
      // their way to the server: pass until the server says those heads are
      // durable and forwarded, or the latch lifts.
      const held = (await hopProbe(page)).heldHeads
      while (Date.now() < deadline && await latched()) {
        if (!(await serverForwarded(held))) await compact().catch(() => undefined)
        else await sleep(50)
      }
    } else {
      await sleep(50)
    }
  }
  throw new Error('the hop never converged')
}

/**
 * Stage RETENTION as the periodic sweep applies it once the documents are
 * quiet — a
 * superseded document whose age (epochs published since it was superseded,
 * that one included) is past `retain` is retired; the rest stay live. The
 * periodic sweep does this every 10 minutes with a one-period quiet test,
 * which a stack that rolls every few seconds never reaches (a manual test
 * counted 113 live superseded documents). Same test-only path as `retireSupersededBy`.
 * Returns the live superseded documents left.
 */
export function applyRetention(retain = 3): number {
  sql(`UPDATE read_model_model_epoch_docs SET state = 'retired', updated_at = now()
        WHERE state = 'live' AND superseded_epoch IS NOT NULL
          AND superseded_epoch <= (SELECT max(epoch_no) FROM read_model_model_epochs WHERE state = 'published') - ${Number(retain)}`)
  return Number(sql(`SELECT count(*) FROM read_model_model_epoch_docs WHERE state = 'live' AND superseded_epoch IS NOT NULL`))
}

/** The retirement walk's step 1 (`live → retiring`, GC not run yet) on every document past `retain` — what a
 * periodic sweep passing between the rolls does. Returns how many moved. */
export function stageRetiring(retain = 3): number {
  return Number(sql(`WITH r AS (UPDATE read_model_model_epoch_docs SET state = 'retiring', updated_at = now()
        WHERE state = 'live' AND superseded_epoch IS NOT NULL
          AND superseded_epoch <= (SELECT max(epoch_no) FROM read_model_model_epochs WHERE state = 'published') - ${Number(retain)}
        RETURNING 1) SELECT count(*) FROM r`))
}

/** Stage retirement of every document an epoch superseded (retention's end state). */
export function retireSupersededBy(epochNo: number): number {
  return Number(sql(`WITH r AS (UPDATE read_model_model_epoch_docs SET state = 'retired' WHERE superseded_epoch = ${Number(epochNo)} RETURNING 1) SELECT count(*) FROM r`))
}

export interface HopProbe {
  bootedMetaUrl: string | null; state: { phase: string }; retainedSets: number; retainedDocuments: string[]
  writesDeferredByLatch: number; deferredWritesAtSwap: number
  heldHeads: Array<{ documentId: string; heads: string[] }>
  retainedPins: number
  objectShards: string[]
  hopTrace: Array<Record<string, unknown>>
  epochCapability: boolean
  epochCapabilityFrom: string | null
  durablePending: string[]
  predecessorMetas: string[]
  repointProbePending: boolean
  /** Diagnostics (absent on an older build). */
  metaObjectShardUrls?: string[]
  /** The hop's invariant alerts. */
  hopUnaccountedObjects?: string[]
}

/**
 * Until no event-driven forward pass is running on the server — every
 * `pass_start` of this run's trace (MODEL_EPOCH_TRACE_FILE, in
 * `E2E_EPOCHS_LOG_DIR`) has its end. The roll's own pass (S9) is logged as
 * started before `POST /api/model/compact` answers, so after `forceRoll()`
 * this waits for it.
 */
export async function forwardPassesIdle(timeoutMs = 60_000): Promise<void> {
  const dir = process.env.E2E_EPOCHS_LOG_DIR
  if (!dir) throw new Error('forwardPassesIdle needs E2E_EPOCHS_LOG_DIR (run through scripts/e2e-epochs.mjs)')
  const file = path.join(dir, 'epoch-trace.jsonl')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
    let open = 0
    for (const line of lines) {
      const event = (JSON.parse(line) as { event?: string }).event
      if (event === 'forward_trigger.pass_start') open += 1
      else if (event === 'forward_trigger.pass_end' || event === 'forward_trigger.pass_failed') open -= 1
    }
    if (open <= 0) return
    await sleep(100)
  }
  throw new Error('a forward pass never ended')
}

/** The tab's hop timeline, written next to this run's server trace
 * (`E2E_EPOCHS_LOG_DIR`, one directory per run): never overwritten. */
export async function dumpHopTrace(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_EPOCHS_LOG_DIR
  if (!dir) return
  const trace = await hopProbe(page).then((p) => p.hopTrace, (error: unknown) => [{ probeFailed: String(error) }])
  writeFileSync(path.join(dir, `hop-trace-${name}.json`), JSON.stringify(trace, null, 1))
}

/** The server's own answer for `documents`, asked from the test (not the
 * tab, whose requests a spec may be holding). */
export async function serverForwarded(documents: Array<{ documentId: string; heads: string[] }>): Promise<boolean> {
  if (documents.length === 0) return true
  const response = await fetch(`${SERVER}/api/automerge/durable-heads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ documents }),
  })
  if (!response.ok) return false
  const body = await response.json() as { documents: Array<{ durable: boolean; forwarded?: boolean }> }
  return body.documents.every((d) => d.durable && d.forwarded !== false)
}

export async function hopProbe(page: Page): Promise<HopProbe> {
  return page.evaluate(() => (window as unknown as { __epochHop: () => HopProbe }).__epochHop())
}

export async function enterApp(page: Page): Promise<void> {
  // AUTH on: the signed-in admin's first landscape is its own personal one;
  // the seeded (sharded) default workspace is named.
  await page.goto(AUTH_ON ? '/app/landscape/default/version/current' : '/')
  const start = page.getByRole('button', { name: /Start designing free/ }).first()
  const editor = page.getByTestId('diagram-name')
  // The landing's button may render AFTER the load event —
  // read once at `goto`, it was missed and the spec waited 60 s on the
  // landing page (seen once in 14). Wait for either, then click if needed.
  await expect(start.or(editor).first()).toBeVisible({ timeout: 60_000 })
  if (await start.isVisible().catch(() => false)) await start.click()
  await expect(editor).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await hopProbe(page)).bootedMetaUrl, { timeout: 60_000 }).not.toBeNull()
  // The boot has wired the store to the workspace's documents
  // (`projectedWorkspace`, after the active diagram opened — the canvas is
  // read-only until then). Before it, a spec writing through `__modelStore`
  // wrote into no document: an offline-overflow run once left 3 000 objects
  // in the store and in no shard, reproduced 5 of 5 by going offline at that
  // instant, without the epoch work too.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __automergeStatus?: { getState(): { projectedWorkspace: string | null } } })
    .__automergeStatus?.getState().projectedWorkspace ?? null), { timeout: 60_000 }).not.toBeNull()
  guardNavigations(page)
}

/**
 * EVERY DOCUMENT LOAD A SPEC DID NOT ASK FOR FAILS IT: earlier "green" runs
 * were carried by page reloads nobody
 * asked for (Vite's HMR and its WebSocket reconnect), which re-booted a tab
 * and hid what the spec claimed to test. From the end of `enterApp`, a main-
 * frame load is expected only when the spec called `goto`/`reload` on that
 * page; any other is recorded, and `takeUnexpectedNavigations` (each spec's
 * `afterEach`) fails the test with it.
 */
const unexpectedNavigations: string[] = []
const guardedPages = new WeakSet<Page>()

function guardNavigations(page: Page): void {
  if (guardedPages.has(page)) return
  guardedPages.add(page)
  // One ALLOWANCE per call, open
  // only while that call is in flight. A `goto`/`reload` that fails before
  // its `domcontentloaded`, or whose event never comes, closes its allowance
  // when it settles — it can no longer absorb a later load nobody asked for.
  const open = new Set<{ used: boolean }>()
  for (const name of ['goto', 'reload'] as const) {
    const original = (page[name] as (...args: unknown[]) => Promise<unknown>).bind(page)
    ;(page as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      const allowance = { used: false }
      open.add(allowance)
      try {
        return await original(...args)
      } finally {
        open.delete(allowance)
      }
    }
  }
  page.on('domcontentloaded', () => {
    const allowance = [...open].find((a) => !a.used)
    if (allowance) { allowance.used = true; return }
    unexpectedNavigations.push(`${new Date().toISOString()} ${page.url()}`)
  })
}

/** Test hook: the guard on a page, for its own unit test. */
export const __guardNavigationsForTest = guardNavigations

/** The unrequested document loads since the last call (then forgotten). */
export function takeUnexpectedNavigations(): string[] {
  return unexpectedNavigations.splice(0)
}

/**
 * Make `context`'s next boot read the root from the
 * SERVER — its local copy of the root document is deleted (only that
 * document's chunks; the held shards and the queue stay). Without it the boot
 * reads the root this browser cached, which still names an older epoch's
 * meta, and a spec meant for the boot path tests the hop instead.
 */
export async function forgetLocalRoot(context: BrowserContext): Promise<number> {
  const page = await context.newPage()
  try {
    // A static file of the app's origin: its storage, without booting the app.
    await page.goto('/icons/icon-192.png')
    return await page.evaluate(async () => {
      const rootIds = new Set<string>()
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)!
        const value = localStorage.getItem(key) ?? ''
        if (key.includes('maplespire:rootUrl') && value.startsWith('automerge:')) rootIds.add(value.slice('automerge:'.length))
      }
      let deleted = 0
      for (const info of await indexedDB.databases()) {
        if (!info.name?.startsWith('maplespire-automerge')) continue
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open(info.name!)
          open.onsuccess = () => resolve(open.result)
          open.onerror = () => reject(open.error)
        })
        for (const store of [...db.objectStoreNames]) {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite')
            const cursor = tx.objectStore(store).openCursor()
            cursor.onsuccess = () => {
              const c = cursor.result
              if (!c) return
              const key = c.primaryKey
              if (Array.isArray(key) && rootIds.has(String(key[0]))) { c.delete(); deleted += 1 }
              c.continue()
            }
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
          })
        }
        db.close()
      }
      return deleted
    })
  } finally {
    await page.close()
  }
}

/** The tab's held-pointer queue. */
export async function deferredQueue(page: Page): Promise<Array<{ url: string; unminted?: boolean; holderDocumentId: string }>> {
  return page.evaluate(() => (window as unknown as { __epochDeferredQueue: () => Promise<Array<{ url: string; unminted?: boolean; holderDocumentId: string }>> }).__epochDeferredQueue())
}

export async function objectField(page: Page, id: string, field: 'name' | 'description'): Promise<string | null> {
  return page.evaluate(([oid, f]) => {
    const o = window.__modelStore?.getState().objects.find((x) => x.id === oid) as Record<string, unknown> | undefined
    return o ? String(o[f!] ?? '') : null
  }, [id, field] as const)
}

/** Editing THROUGH the store's own action (the same call the inspector makes). */
export async function updateObject(page: Page, id: string, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(([oid, p]) => {
    (window.__modelStore!.getState() as unknown as { updateObject(id: string, patch: unknown): void }).updateObject(oid as string, p)
  }, [id, patch] as const)
}

/** `count` new model objects through the store's own action; their ids. */
export async function addObjects(page: Page, count: number, prefix: string): Promise<string[]> {
  return page.evaluate(([n, p]) => {
    const store = window.__modelStore!.getState() as unknown as { addObject(obj: Record<string, unknown>): string }
    const ids: string[] = []
    for (let i = 0; i < (n as number); i += 1) {
      ids.push(store.addObject({
        type: 'app', name: `${p as string}-${i}`, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
        scope: 'internal', status: 'live', properties: {},
      }))
    }
    return ids
  }, [count, prefix] as const)
}

export async function deleteObject(page: Page, id: string): Promise<void> {
  await page.evaluate((oid) => {
    (window.__modelStore!.getState() as unknown as { deleteObject(id: string): void }).deleteObject(oid)
  }, id)
}

export async function selectObject(page: Page, id: string): Promise<void> {
  await page.evaluate((oid) => {
    (window.__modelStore!.getState() as unknown as { selectObjects(ids: string[]): void }).selectObjects([oid])
  }, id)
}

/** Ids of objects placed on the current diagram (so the inspector shows them). */
export async function objectsOnCurrentDiagram(page: Page, count: number): Promise<string[]> {
  return page.evaluate((n) => {
    const s = window.__modelStore!.getState()
    const diagram = s.diagrams.find((d) => d.id === s.currentDiagramId)
    const ids = (diagram?.objectIds ?? []).filter((id) => s.objects.some((o) => o.id === id))
    return ids.slice(0, n)
  }, count)
}

/** Ids of model objects NOT on the current diagram: the stack is reused across
 * specs, and one that deletes must not eat the diagram the next one types in. */
export async function objectsOffCurrentDiagram(page: Page, count: number): Promise<string[]> {
  return page.evaluate((n) => {
    const s = window.__modelStore!.getState()
    const diagram = s.diagrams.find((d) => d.id === s.currentDiagramId)
    const on = new Set(diagram?.objectIds ?? [])
    return s.objects.filter((o) => !on.has(o.id)).slice(0, n).map((o) => o.id)
  }, count)
}

/** Wait until the tab's durability badge says everything is durable. */
export async function waitSynced(page: Page, timeout = 60_000): Promise<void> {
  await expect.poll(async () => page.evaluate(() => {
    const w = window as unknown as { __automergeStatus?: { getState(): { status: string } } }
    return w.__automergeStatus?.getState().status ?? 'unknown'
  }), { timeout }).toBe('ready')
}

export async function latchStats(page: Page): Promise<{ latchCount: number; maxLatchMs: number }> {
  return page.evaluate(() => {
    const s = (window as unknown as { __epochHopStore: { getState(): { latchCount: number; maxLatchMs: number } } }).__epochHopStore.getState()
    return { latchCount: s.latchCount, maxLatchMs: s.maxLatchMs }
  })
}
