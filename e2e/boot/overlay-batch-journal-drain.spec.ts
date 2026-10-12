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
 * The BROWSER half of "every projector acknowledges": on an ORDINARY
 * workspace, the client's overlay write-batch journal DRAINS.
 *
 * The client journals every write batch it puts into its overlay head
 * (`bridge.ts`, `overlayBatchJournal.record` + `writeBatchIds.push`) and polls
 * `POST /api/model/overlay-batches/status` until each is terminal. If the
 * ordinary projector does not acknowledge, no batch is ever terminal and the
 * journal grows by one entry per flush for the life of the browser profile.
 * The server side is pinned by `loadGateSeedProjection.integration.test.ts`; this spec is
 * the half the server cannot see — that the journal on DISK empties.
 *
 * Three witnesses, in order, all through the REAL UI and the REAL server:
 *  1. after an object is added through the Model Objects page, the journal in
 *     IndexedDB (`maplespire-model-index` / `idx`, the bytes a reopened tab
 *     would hydrate from) carries the batch that wrote it;
 *  2. the SERVER answers `projected` for that batch — asked from the test, with
 *     the client's own request (url + body) replayed, so the client's polling
 *     is not what is being trusted;
 *  3. once the client's poll is allowed through, the journal is empty on disk
 *     and the client timeline carries `overlay.batch.acknowledged`.
 *
 * WHY THE HELD ROUTE. The client polls one second after the flush and the
 * ordinary projector acknowledges within a projection tick, so "journal
 * written, then drained" is a ~1 s window: a poll racing it would either miss
 * the entry (and this spec would prove nothing about the drain) or see it by
 * luck. The status request is therefore HELD — not answered, not faked — while
 * witnesses 1 and 2 are read, then continued unchanged to the real server.
 * Nothing about the app or the server is stubbed; the pre-acknowledgement
 * state is merely made observable.
 *
 * Can it fail? Yes: with the route FULFILLED as `{ batches: [] }` (a server
 * that never acknowledges) witness 3 times out on a journal that keeps its
 * entry; with the ordinary projector's delta acknowledgement removed,
 * witness 2 times out on `null`.
 *
 * Run against the isolated boot stack (`.claude/launch.json` → "Boot e2e stack
 * (isolated …)"):
 *   E2E_BOOT_URL=http://localhost:5189 E2E_BOOT_API=http://localhost:3009 \
 *     npx playwright test --project=boot e2e/boot/overlay-batch-journal-drain.spec.ts
 */
import { test, expect, type Page, type Request } from '@playwright/test'
import { gotoModelObjects, moAddTopLevel } from './helpers'

/* eslint-disable @typescript-eslint/no-explicit-any */

const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'
/** `overlayBatchJournal.ts` STORAGE_KEY, namespaced per workspace by
 *  `workspaceKvStore()` as `<landscapeId>::<versionId>::<key>`. */
const JOURNAL_KEY_SUFFIX = '::overlay-write-batches:v2'
const STATUS_ROUTE = '**/api/model/overlay-batches/status**'

interface JournalEntry {
  batchId: string
  workspaceKey: string
  collection: 'object' | 'connection'
  documentId: string
  createdAt: number
}

/** Sign in when the stack runs AUTH=on; on AUTH=off the race settles on the app. */
async function signInIfRequired(page: Page): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  const email = page.getByTestId('dev-login-email')
  const landed = await Promise.race([
    email.waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'form' as const),
    page.waitForURL(/\/app(?:\/|$)/, { timeout: 15_000 }).then(() => 'app' as const),
  ]).catch(() => 'app' as const)
  if (landed !== 'form') return
  const legal = page.getByTestId('legal-acceptance')
  if (await legal.count()) await legal.check().catch(() => {})
  await email.fill(DEV_EMAIL)
  await email.press('Enter')
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 30_000 })
}

/** The bridge has loaded the active workspace (the store carries a diagrams array). */
async function waitBridgeReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = (window as any).__modelStore?.getState?.()
      return !!s && Array.isArray(s.diagrams)
    },
    undefined,
    { timeout: 60_000 },
  )
}

/** The journal as it is ON DISK — raw IndexedDB, not the in-memory Map — for
 *  every workspace namespace present. An empty array means no key or an empty
 *  list; `persistOverlayBatchJournal` DELETES the key once nothing is pending. */
async function journalOnDisk(page: Page): Promise<JournalEntry[]> {
  return page.evaluate(async (suffix: string) => new Promise<JournalEntry[]>((resolve) => {
    // Per-user database name under AUTH=on (src/lib/auth/accountNamespace.ts).
    const open = indexedDB.open(((ns) => (ns ? `maplespire-model-index@${ns}` : 'maplespire-model-index'))(localStorage.getItem('maplespire:accountNamespace')))
    open.onerror = () => resolve([])
    open.onsuccess = () => {
      const db = open.result
      const done = (entries: JournalEntry[]) => { db.close(); resolve(entries) }
      try {
        const store = db.transaction('idx', 'readonly').objectStore('idx')
        const keys = store.getAllKeys()
        keys.onerror = () => done([])
        keys.onsuccess = () => {
          const journalKeys = (keys.result as IDBValidKey[])
            .filter((key): key is string => typeof key === 'string' && key.endsWith(suffix))
          if (!journalKeys.length) { done([]); return }
          const out: JournalEntry[] = []
          let left = journalKeys.length
          for (const key of journalKeys) {
            const read = store.get(key)
            read.onsuccess = () => {
              out.push(...((read.result as JournalEntry[] | undefined) ?? []))
              if (--left === 0) done(out)
            }
            read.onerror = () => { if (--left === 0) done(out) }
          }
        }
      } catch {
        done([])
      }
    }
  }), JOURNAL_KEY_SUFFIX)
}

/** `overlay.batch.acknowledged` marks in the client timeline (DEV diagnostics surface). */
function acknowledgedMarks(page: Page): Promise<number> {
  return page.evaluate(() => {
    const snapshot = (window as any).__maplespireDiagnostics?.timeline?.()
    const entries = (snapshot?.entries ?? []) as Array<{ name: string }>
    return entries.filter((entry) => entry.name === 'overlay.batch.acknowledged').length
  })
}

test.describe('overlay write-batch journal — drains on an ordinary workspace', () => {
  test('a batch written through the UI is journaled on disk, acknowledged by the server, and drained', async ({ page }) => {
    page.on('console', (message) => {
      if (message.type() === 'error') console.log('[page:error]', message.text().slice(0, 200))
    })
    // HOLD the client's status polls from the first navigation on: the handler
    // AWAITS an explicit gate before `route.continue()`, so the request stays
    // pending (no answer, no fake) until this test has read the
    // pre-acknowledgement state. A handler that merely stores the route and
    // returns does NOT hold in Playwright — measured: with that shape the
    // harness mutant "server never acknowledges" passed green in 2.6 s, because
    // the request had gone through and the journal had drained before the
    // release step ran. `reconcileOverlayBatchAcknowledgements` sends nothing
    // while the journal is empty, so boot itself is not disturbed.
    let releaseHold: () => void = () => undefined
    const holdReleased = new Promise<void>((resolve) => { releaseHold = resolve })
    const held: Request[] = []
    await page.route(STATUS_ROUTE, async (route) => {
      held.push(route.request())
      await holdReleased
      await route.continue().catch(() => { /* the page may have navigated away */ })
    })

    await signInIfRequired(page)
    await waitBridgeReady(page)
    expect(
      await page.evaluate(() => (window as any).__bootFromServer?.enabled?.() ?? false),
      'this spec must run against the boot-from-server stack',
    ).toBe(true)
    expect(
      await page.evaluate(() => typeof (window as any).__maplespireDiagnostics?.timeline === 'function'),
      'the client timeline is the third witness; it exists on a Vite DEV server (or VITE_CLIENT_PERF_DIAGNOSTICS=true)',
    ).toBe(true)
    expect(await journalOnDisk(page), 'a fresh profile starts with an empty journal').toEqual([])
    const marksBefore = await acknowledgedMarks(page)

    // The write, through the real Model Objects page.
    await gotoModelObjects(page)
    const objectId = await moAddTopLevel(page, 'system')

    // Witness 1 — the journal ON DISK carries the batch that wrote this object.
    let entry: JournalEntry | undefined
    await expect.poll(async () => {
      const entries = await journalOnDisk(page)
      entry = entries.find((candidate) => candidate.collection === 'object')
      return entry?.batchId ?? null
    }, { timeout: 15_000, intervals: [100] }).not.toBeNull()
    const batchId = entry!.batchId
    expect(batchId).toMatch(/^overlay-object-/)

    // The client's own poll fires one second after the flush — and is held.
    await expect.poll(() => held.length, { timeout: 15_000, intervals: [100] }).toBeGreaterThan(0)
    const clientRequest = held[0]
    const statusUrl = clientRequest.url()
    const statusBody = clientRequest.postDataJSON() as { batchIds?: string[] }
    expect(statusBody.batchIds ?? [], 'the client asks about the batch it journaled').toContain(batchId)
    // The hold is load-bearing: the client's request must NOT have been answered.
    // Without this line a hold that silently lets the request through makes the
    // rest of the spec a lucky race (see the note at the route above).
    expect(await Promise.race([
      clientRequest.response().then(() => 'answered' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 750)),
    ]), 'the held status request must still be pending').toBe('pending')

    // The object reached the server's read model (the rows the acknowledgement
    // vouches for) — asked on the client's own API origin with its workspace
    // params, through `page.request` so the session cookie travels on an AUTH=on
    // stack (the helpers' bare cross-origin `fetch` answers 401 there).
    const statusTarget = new URL(statusUrl)
    const objectUrl = new URL(`/api/model/object/${encodeURIComponent(objectId)}`, statusTarget.origin)
    objectUrl.search = statusTarget.search
    await expect.poll(async () => {
      const response = await page.request.get(objectUrl.toString())
      if (!response.ok()) return `HTTP ${response.status()}`
      return ((await response.json()) as { object?: { id: string } }).object?.id ?? null
    }, { timeout: 20_000, intervals: [250] }).toBe(objectId)
    // Witness 2 — … and the SERVER already answers `projected`, asked with the
    // client's exact request replayed from the test (page routes do not apply to
    // `page.request`; it shares the context's cookies).
    await expect.poll(async () => {
      const response = await page.request.post(statusUrl, { data: statusBody })
      if (!response.ok()) return `HTTP ${response.status()}`
      const body = await response.json() as { batches?: Array<{ batchId: string; status: string }> }
      return body.batches?.find((batch) => batch.batchId === batchId)?.status ?? null
    }, { timeout: 20_000, intervals: [250] }).toBe('projected')
    // The client has not been answered yet: the entry is still on disk. This is
    // the line that separates "drained" from "never journaled".
    expect((await journalOnDisk(page)).some((candidate) => candidate.batchId === batchId)).toBe(true)

    // RELEASE — the held requests go to the real server, unchanged.
    releaseHold()

    // Witness 3 — the journal drains on disk and the timeline says why.
    await expect.poll(async () => {
      const entries = await journalOnDisk(page)
      return entries.filter((candidate) => candidate.batchId === batchId).length
    }, { timeout: 20_000, intervals: [250] }).toBe(0)
    await expect.poll(() => acknowledgedMarks(page), { timeout: 20_000, intervals: [250] }).toBeGreaterThan(marksBefore)
  })
})
