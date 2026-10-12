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
 * Regression: an entity created under boot-from-server survives a HARD renderer
 * crash that happens BEFORE the flush lands it in the overlay document.
 *
 * The lost-object defect: between a keystroke and `writeEditsShards`, the edit
 * lived only in RAM; a tab that died in that window lost it silently while the
 * badge read "Synchronisé". The entity-intent journal (IndexedDB, persisted at
 * capture) closes it — this test is its regression proof.
 *
 * Two honesty rules baked in:
 * - The crash is CDP `Page.crash()` — a real renderer kill. `page.close()` or
 *   `reload()` fire pagehide, which runs the lifecycle flush: a test using them
 *   would pass on pre-journal code and prove nothing.
 * - The PRECONDITION is asserted at crash time: the journal tab-key is on disk
 *   AND `dirtyObjectIds` still holds the entity (dirty is only cleared by the
 *   overlay-doc write, so dirty ≥ 1 proves the doc write has NOT happened yet).
 *   If the 150 ms write debounce ever wins the race, the test goes RED as a
 *   void run — it can never false-pass by accidentally testing doc persistence.
 */
import { test, expect, chromium, type Page, type BrowserContext } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addCanvasComment, openFlowsPanel } from './helpers'

const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'

// A fresh profile lands on the BARE /app after login (no remembered
// workspace); RouteSync upgrades the URL to the versioned form once the
// bridge boots — so wait on the /app prefix, not on '**/app/**' which
// requires a trailing segment and times out on exactly that landing.
const inApp = (url: URL) => url.pathname === '/app' || url.pathname.startsWith('/app/')

async function signIn(page: Page): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  const email = page.getByTestId('dev-login-email')
  const landed = await Promise.race([
    email.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'form' as const),
    page.waitForURL(inApp, { timeout: 20_000 }).then(() => 'app' as const),
  ]).catch(() => 'form' as const)
  if (landed === 'form') {
    const legal = page.getByTestId('legal-acceptance')
    if (await legal.count()) await legal.check().catch(() => {})
    await email.fill(DEV_EMAIL)
    await email.press('Enter')
    await page.waitForURL(inApp, { timeout: 30_000 })
  }
}

async function openModelObjects(page: Page): Promise<void> {
  // Let the bridge finish booting first: RouteSync upgrades the bare /app to
  // the versioned workspace URL when it does. Navigating mid-boot leaves the
  // target view waiting on a workspace that never finishes attaching.
  await page.waitForURL('**/app/landscape/**', { timeout: 60_000 })
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-model-objects').click()
  await expect(page.getByTestId('mo-add-object')).toBeVisible({ timeout: 30_000 })
}

interface CrashPrecondition {
  createdId: string | null
  dirtyObjects: number
  journalOnDisk: boolean
}

/** Read the crash-window state straight from the app + raw IndexedDB. */
async function readCrashPrecondition(page: Page, priorIds: string[]): Promise<CrashPrecondition> {
  return await page.evaluate(async (prior: string[]) => {
    const w = window as unknown as {
      __modelStore?: { getState: () => { objects: Array<{ id: string; name: string }> } }
      __bridgeDebug?: () => { dirtyObj: number }
    }
    const objects = w.__modelStore?.getState().objects ?? []
    const created = objects.find((o) => /^New system/i.test(o.name) && !prior.includes(o.id))
    const journalOnDisk = await new Promise<boolean>((resolve) => {
      const open = indexedDB.open(((ns) => (ns ? `maplespire-model-index@${ns}` : 'maplespire-model-index'))(localStorage.getItem('maplespire:accountNamespace')))
      open.onerror = () => resolve(false)
      open.onsuccess = () => {
        const db = open.result
        try {
          const tx = db.transaction('idx', 'readonly')
          const req = tx.objectStore('idx').getAllKeys()
          req.onsuccess = () => {
            db.close()
            resolve((req.result as IDBValidKey[]).some((key) =>
              typeof key === 'string' && key.includes('pending-entity-intents:') && key.includes(':tab:')))
          }
          req.onerror = () => { db.close(); resolve(false) }
        } catch {
          db.close()
          resolve(false)
        }
      }
    })
    return {
      createdId: created?.id ?? null,
      dirtyObjects: w.__bridgeDebug?.().dirtyObj ?? -1,
      journalOnDisk,
    }
  }, priorIds)
}

async function crashRenderer(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page)
  // Page.crash kills the renderer process: no pagehide, no visibilitychange,
  // no lifecycle flush — the same shape as an OS kill or a browser crash.
  // The CDP reply never comes back from a dead renderer (measured: the await
  // parked the test until the suite timeout — neither resolve nor reject), so
  // the send is raced against a ceiling instead of awaited.
  await Promise.race([
    cdp.send('Page.crash').catch(() => { /* the session dies with the page */ }),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ])
}

test.describe('entity-intent journal — crash before flush', () => {
  // Two full cold boots (fresh profile + post-crash relaunch) plus the durable
  // drain; the suite default of 120 s is calibrated for one boot and 2 reloads.
  test.setTimeout(300_000)

  test('an object created then crashed pre-flush is visible again after reopening', async ({ baseURL }, testInfo) => {
    // A PERSISTENT profile, because the journal lives in IndexedDB and
    // storageState does not carry IndexedDB across contexts: crashing the
    // renderer takes the whole headless shell down, and the only faithful
    // "user reopens after the crash" is a fresh launch on the SAME profile.
    //
    // The profile MUST live outside cloud-synced folders: under OneDrive
    // (where test-results/ sits) Chromium's LevelDB backing store fails with
    // "Internal error opening backing store for indexedDB.open" and the app —
    // whose entire persistence is IndexedDB — hangs at boot. The same rule
    // applies to the embedded Postgres data dir.
    const userDataDir = mkdtempSync(join(tmpdir(), 'maplespire-crash-e2e-'))
    testInfo.attach?.('crash-profile-dir', { body: userDataDir })
    const flags = () => {
      localStorage.setItem('maplespire:bootFromServer', 'true')
      localStorage.setItem('maplespire:serverReadModel', 'true')
    }
    const context = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await context.addInitScript(flags)

    const page = context.pages()[0] ?? await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        console.log(`[page:${message.type()}]`, message.text().slice(0, 160))
      }
    })
    await signIn(page)
    await openModelObjects(page)
    const priorIds: string[] = await page.evaluate(() => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { objects: Array<{ id: string }> } }
      }
      return (w.__modelStore?.getState().objects ?? []).map((o) => o.id)
    })

    // Real UI creation — the flow that loses an object on a crash without the
    // journal.
    await page.getByTestId('mo-add-object').click()
    await page.getByTestId('mo-add-system').click()

    // Crash window: the journal's leading-edge persist is a few ms; the overlay
    // write sits behind a 150 ms debounce PLUS first-edit handle resolution.
    // Poll fast for the persisted journal, then assert the doc write has not
    // happened (dirty still holds the entity) and kill the renderer.
    let precondition: CrashPrecondition = { createdId: null, dirtyObjects: -1, journalOnDisk: false }
    await expect
      .poll(async () => {
        precondition = await readCrashPrecondition(page, priorIds)
        return precondition.createdId !== null && precondition.journalOnDisk
      }, { timeout: 5_000, intervals: [25, 25, 50, 50, 100] })
      .toBe(true)
    expect(precondition.createdId, 'the UI accepted the creation').not.toBeNull()
    expect(precondition.journalOnDisk, 'the intent reached IndexedDB before the crash').toBe(true)
    // VOID-RUN GUARD, not a flake allowance: dirty is cleared only by the
    // overlay-doc write. If it is already 0, the flush won the race and this
    // run proves nothing about the journal — fail loudly rather than pass on
    // the wrong mechanism.
    expect(precondition.dirtyObjects, 'crash must land BEFORE the overlay-doc write').toBeGreaterThanOrEqual(1)

    const createdId = precondition.createdId!
    await crashRenderer(context, page)
    // The crash may take the whole headless shell with it; discard the wreck —
    // and never WAIT on a wreck: close() on a crashed browser can also hang.
    await Promise.race([
      context.close().catch(() => { /* already dead */ }),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])

    // The user reopens the browser: a fresh launch on the SAME profile, so
    // IndexedDB (journal + automerge storage + session) is exactly what the
    // crash left behind.
    const reopenedContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await reopenedContext.addInitScript(flags)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await signIn(reopened)
    await openModelObjects(reopened)

    // The replay must bring the entity back where the user can see it: the
    // model-objects seam (the journal feeds the paging index at replay), and
    // once the drain completes, the durable pipeline end to end.
    await expect
      .poll(async () => await reopened.evaluate(async (id: string) => {
        const w = window as unknown as {
          __modelStore?: { getState: () => { objects: Array<{ id: string }> } }
          __bridgeDebug?: () => { editsObj: number }
        }
        if (w.__modelStore?.getState().objects.some((o) => o.id === id)) return true
        return (w.__bridgeDebug?.().editsObj ?? 0) >= 1
      }, createdId), { timeout: 30_000 })
      .toBe(true)

    // And it must become DURABLE without any further user action: the badge
    // may only claim ready once the journal drained into the overlay doc.
    await awaitSyncReady(reopened)
    // "Drained" = no key still CARRIES an intent. Key PRESENCE is not debt:
    // on adoption, a crashed tab's key is EMPTIED by an atomic conditional
    // update rather than deleted (a bare delete could wipe a LIVE sibling's
    // journal), so a leftover `[]`
    // key is the normal post-adoption shape, not an undrained journal.
    const drained = await reopened.evaluate(async () => {
      return await new Promise<boolean>((resolve) => {
        const open = indexedDB.open(((ns) => (ns ? `maplespire-model-index@${ns}` : 'maplespire-model-index'))(localStorage.getItem('maplespire:accountNamespace')))
        open.onerror = () => resolve(false)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction('idx', 'readonly')
          const store = tx.objectStore('idx')
          const keysReq = store.getAllKeys()
          const valuesReq = store.getAll()
          tx.oncomplete = () => {
            db.close()
            const keys = keysReq.result as IDBValidKey[]
            const values = valuesReq.result as unknown[]
            const undrained = keys.some((key, index) => {
              if (typeof key !== 'string' || !(key.includes('pending-entity-intents:') && key.includes(':tab:'))) return false
              const value = values[index]
              return Array.isArray(value) && value.length > 0
            })
            resolve(!undrained)
          }
          tx.onerror = () => { db.close(); resolve(false) }
        }
      })
    })
    expect(drained, 'the journal drained after the edit became durable (no key still carries an intent)').toBe(true)

    // The table itself shows the recovered object once the server projects it.
    await reopened.getByTestId('mo-search').fill('New system')
    await expect
      .poll(async () => await reopened.locator('table tbody tr', { hasText: 'New system' }).count(),
        { timeout: 60_000 })
      .toBeGreaterThan(0)

    // Leave the workspace as found: delete the recovered test object (a real
    // model delete — tombstone in ModelMeta) and let it drain before closing.
    await reopened.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { deleteObject?: (id: string) => void } }
      }
      w.__modelStore?.getState().deleteObject?.(id)
    }, createdId)
    await expect(reopened.getByTestId('ws-sync-status'))
      .toHaveAttribute('data-status', 'ready', { timeout: 60_000 })

    await reopenedContext.close()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  // ── round 8: the small-collection families ─────────────────────────────────
  //
  // Same crash discipline as the object test: a REAL renderer kill inside the
  // capture→flush window, and a void-run guard that reads the still-pending
  // journal intent (the value-checked ack in writeSmallCollections removes it
  // the moment the flush expressed it, so "intent still journaled" IS the
  // proof the doc write has not happened yet).

  interface SmallCrashPrecondition {
    createdId: string | null
    pendingOfKind: number
    journalOnDisk: boolean
  }

  async function smallCrashPrecondition(
    page: Page,
    kind: 'group' | 'decisionRecord',
    priorIds: string[],
    namePattern: RegExp,
  ): Promise<SmallCrashPrecondition> {
    return await page.evaluate(async (args: { kind: string; prior: string[]; pattern: string }) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => {
          groups: Array<{ id: string; name: string }>
          decisionRecords: Array<{ id: string; title: string }>
        } }
        __bridgeDebug?: () => { pendingIntentsByKind?: Record<string, number> }
      }
      const state = w.__modelStore?.getState()
      const pattern = new RegExp(args.pattern, 'i')
      const created = args.kind === 'group'
        ? state?.groups.find((g) => pattern.test(g.name) && !args.prior.includes(g.id))
        : state?.decisionRecords.find((r) => pattern.test(r.title) && !args.prior.includes(r.id))
      const journalOnDisk = await new Promise<boolean>((resolve) => {
        const open = indexedDB.open(((ns) => (ns ? `maplespire-model-index@${ns}` : 'maplespire-model-index'))(localStorage.getItem('maplespire:accountNamespace')))
        open.onerror = () => resolve(false)
        open.onsuccess = () => {
          const db = open.result
          try {
            const tx = db.transaction('idx', 'readonly')
            const store = tx.objectStore('idx')
            const keysReq = store.getAllKeys()
            const valuesReq = store.getAll()
            tx.oncomplete = () => {
              db.close()
              const keys = keysReq.result as IDBValidKey[]
              const values = valuesReq.result as unknown[]
              resolve(keys.some((key, index) => {
                if (typeof key !== 'string' || !(key.includes('pending-entity-intents:') && key.includes(':tab:'))) return false
                const list = values[index]
                return Array.isArray(list)
                  && list.some((entry) => (entry as { kind?: string }).kind === args.kind)
              }))
            }
            tx.onerror = () => { db.close(); resolve(false) }
          } catch {
            db.close()
            resolve(false)
          }
        }
      })
      return {
        createdId: created?.id ?? null,
        pendingOfKind: w.__bridgeDebug?.().pendingIntentsByKind?.[args.kind] ?? -1,
        journalOnDisk,
      }
    }, { kind, prior: priorIds, pattern: namePattern.source })
  }

  test('a GROUP created then crashed pre-flush is visible again after reopening', async ({ baseURL }, testInfo) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'maplespire-crash-e2e-'))
    testInfo.attach?.('crash-profile-dir', { body: userDataDir })
    const flags = () => {
      localStorage.setItem('maplespire:bootFromServer', 'true')
      localStorage.setItem('maplespire:serverReadModel', 'true')
    }
    const context = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await context.addInitScript(flags)
    const page = context.pages()[0] ?? await context.newPage()
    await signIn(page)
    await openModelObjects(page)
    const priorIds: string[] = await page.evaluate(() => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { groups: Array<{ id: string }> } }
      }
      return (w.__modelStore?.getState().groups ?? []).map((g) => g.id)
    })

    // Real UI creation: the Model Objects page's add menu carries 'group'.
    await page.getByTestId('mo-add-object').click()
    await page.getByTestId('mo-add-group').click()

    let precondition: SmallCrashPrecondition = { createdId: null, pendingOfKind: -1, journalOnDisk: false }
    await expect
      .poll(async () => {
        precondition = await smallCrashPrecondition(page, 'group', priorIds, /^New group/i)
        return precondition.createdId !== null && precondition.journalOnDisk
      }, { timeout: 5_000, intervals: [25, 25, 50, 50, 100] })
      .toBe(true)
    // VOID-RUN GUARD: the value-checked ack removes the intent when the
    // ModelMeta write expressed it — a still-pending intent proves the crash
    // lands BEFORE the small-collections flush.
    expect(precondition.pendingOfKind, 'crash must land BEFORE writeSmallCollections').toBeGreaterThanOrEqual(1)

    const createdId = precondition.createdId!
    await crashRenderer(context, page)
    await Promise.race([
      context.close().catch(() => { /* already dead */ }),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])

    const reopenedContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await reopenedContext.addInitScript(flags)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await signIn(reopened)
    await openModelObjects(reopened)

    // The replay writes the group straight into ModelMeta; the projection then
    // surfaces it in the store.
    await expect
      .poll(async () => await reopened.evaluate((id: string) => {
        const w = window as unknown as {
          __modelStore?: { getState: () => { groups: Array<{ id: string }> } }
        }
        return (w.__modelStore?.getState().groups ?? []).some((g) => g.id === id)
      }, createdId), { timeout: 30_000 })
      .toBe(true)
    // PROVENANCE, not just presence: the entity must have
    // come back through the REPLAY — the `entity-intents.small-replay`
    // timeline mark — or a flush that won the pre-crash race would make this
    // whole test pass while proving only ordinary persistence.
    await expect
      .poll(async () => await reopened.evaluate(() => {
        const w = window as unknown as {
          __maplespireDiagnostics?: { timeline: () => { entries: Array<{ name: string }> } }
        }
        return (w.__maplespireDiagnostics?.timeline().entries ?? [])
          .some((entry) => entry.name === 'entity-intents.small-replay')
      }), { timeout: 30_000 })
      .toBe(true)
    await awaitSyncReady(reopened)

    // Leave the workspace as found: a real UI-equivalent store delete drains
    // through the ordinary small-collections flush.
    await reopened.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { deleteGroup?: (id: string) => void } }
      }
      w.__modelStore?.getState().deleteGroup?.(id)
    }, createdId)
    await awaitSyncReady(reopened)

    await reopenedContext.close()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  test('an ADR created then crashed pre-flush is visible again after reopening', async ({ baseURL }, testInfo) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'maplespire-crash-e2e-'))
    testInfo.attach?.('crash-profile-dir', { body: userDataDir })
    const flags = () => {
      localStorage.setItem('maplespire:bootFromServer', 'true')
      localStorage.setItem('maplespire:serverReadModel', 'true')
    }
    const context = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await context.addInitScript(flags)
    const page = context.pages()[0] ?? await context.newPage()
    await signIn(page)
    await page.waitForURL('**/app/landscape/**', { timeout: 60_000 })
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('nav-decision-records').click()
    await expect(page.getByTestId('adr-create')).toBeVisible({ timeout: 30_000 })
    const priorIds: string[] = await page.evaluate(() => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { decisionRecords: Array<{ id: string }> } }
      }
      return (w.__modelStore?.getState().decisionRecords ?? []).map((r) => r.id)
    })

    await page.getByTestId('adr-create').click()

    let precondition: SmallCrashPrecondition = { createdId: null, pendingOfKind: -1, journalOnDisk: false }
    await expect
      .poll(async () => {
        precondition = await smallCrashPrecondition(page, 'decisionRecord', priorIds, /./)
        return precondition.createdId !== null && precondition.journalOnDisk
      }, { timeout: 5_000, intervals: [25, 25, 50, 50, 100] })
      .toBe(true)
    expect(precondition.pendingOfKind, 'crash must land BEFORE writeSmallCollections').toBeGreaterThanOrEqual(1)

    const createdId = precondition.createdId!
    await crashRenderer(context, page)
    await Promise.race([
      context.close().catch(() => { /* already dead */ }),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])

    const reopenedContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await reopenedContext.addInitScript(flags)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await signIn(reopened)
    await reopened.waitForURL('**/app/landscape/**', { timeout: 60_000 })
    await reopened.getByTestId('nav-menu').click()
    await reopened.getByTestId('nav-decision-records').click()

    await expect
      .poll(async () => await reopened.evaluate((id: string) => {
        const w = window as unknown as {
          __modelStore?: { getState: () => { decisionRecords: Array<{ id: string }> } }
        }
        return (w.__modelStore?.getState().decisionRecords ?? []).some((r) => r.id === id)
      }, createdId), { timeout: 30_000 })
      .toBe(true)
    // Provenance: restored BY THE REPLAY, not by a flush that won the race.
    await expect
      .poll(async () => await reopened.evaluate(() => {
        const w = window as unknown as {
          __maplespireDiagnostics?: { timeline: () => { entries: Array<{ name: string }> } }
        }
        return (w.__maplespireDiagnostics?.timeline().entries ?? [])
          .some((entry) => entry.name === 'entity-intents.small-replay')
      }), { timeout: 30_000 })
      .toBe(true)
    await awaitSyncReady(reopened)

    await reopened.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { deleteDecisionRecord?: (id: string) => void } }
      }
      w.__modelStore?.getState().deleteDecisionRecord?.(id)
    }, createdId)
    await awaitSyncReady(reopened)

    await reopenedContext.close()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  test('a GROUP deleted then crashed pre-flush STAYS deleted after reopening', async ({ baseURL }, testInfo) => {
    // `clearExplicitDeleteIntents` re-enters the store subscriber
    // synchronously; a capture that reseeds the baseline from the post-delete
    // slice before the diff runs never journals group deletes, so a crash
    // replays the cascaded connection deletes while RESURRECTING the group.
    // Against such code this test dies at the precondition (no 'group' delete
    // intent ever reaches the disk).
    const userDataDir = mkdtempSync(join(tmpdir(), 'maplespire-crash-e2e-'))
    testInfo.attach?.('crash-profile-dir', { body: userDataDir })
    const flags = () => {
      localStorage.setItem('maplespire:bootFromServer', 'true')
      localStorage.setItem('maplespire:serverReadModel', 'true')
    }
    const context = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await context.addInitScript(flags)
    const page = context.pages()[0] ?? await context.newPage()
    await signIn(page)
    await openModelObjects(page)

    // Create a group through the real UI and let it become DURABLE first —
    // the delete must be the only pending work when the crash lands.
    await page.getByTestId('mo-add-object').click()
    await page.getByTestId('mo-add-group').click()
    let createdId: string | null = null
    await expect
      .poll(async () => {
        createdId = await page.evaluate(() => {
          const w = window as unknown as {
            __modelStore?: { getState: () => { groups: Array<{ id: string; name: string }> } }
          }
          return (w.__modelStore?.getState().groups ?? []).find((g) => /^New group/i.test(g.name))?.id ?? null
        })
        return createdId !== null
      }, { timeout: 10_000 })
      .toBe(true)
    await awaitSyncReady(page)

    // Delete it. `deleteGroup` is the exact store action both UI delete paths
    // invoke; the property under test is the CAPTURE layer downstream of it
    // (pendingDeletedGroupIds + the baseline diff on the same tick).
    await page.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { deleteGroup?: (id: string) => void } }
      }
      w.__modelStore?.getState().deleteGroup?.(id)
    }, createdId!)

    let precondition: SmallCrashPrecondition = { createdId: null, pendingOfKind: -1, journalOnDisk: false }
    await expect
      .poll(async () => {
        precondition = await smallCrashPrecondition(page, 'group', [], /^New group/i)
        return precondition.journalOnDisk
      }, { timeout: 5_000, intervals: [25, 25, 50, 50, 100] })
      .toBe(true)
    expect(precondition.pendingOfKind, 'the DELETE intent is journaled before the crash').toBeGreaterThanOrEqual(1)

    await crashRenderer(context, page)
    await Promise.race([
      context.close().catch(() => { /* already dead */ }),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])

    const reopenedContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await reopenedContext.addInitScript(flags)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await signIn(reopened)
    await openModelObjects(reopened)

    // The replay executes the delete against ModelMeta; the group must NOT
    // resurrect, and the workspace must drain to ready on its own.
    await expect
      .poll(async () => await reopened.evaluate(() => {
        const w = window as unknown as {
          __maplespireDiagnostics?: { timeline: () => { entries: Array<{ name: string }> } }
        }
        return (w.__maplespireDiagnostics?.timeline().entries ?? [])
          .some((entry) => entry.name === 'entity-intents.small-replay')
      }), { timeout: 30_000 })
      .toBe(true)
    await awaitSyncReady(reopened)
    const stillThere = await reopened.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { groups: Array<{ id: string }> } }
      }
      return (w.__modelStore?.getState().groups ?? []).some((g) => g.id === id)
    }, createdId!)
    expect(stillThere, 'the crashed delete stayed deleted (no resurrection)').toBe(false)

    await reopenedContext.close()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  // ── phase B: the diagram-scoped families ────────────────────────────────────
  //
  // Same crash discipline. The void-run guard reads the journal's per-kind
  // pending count — the value-checked ack (flushWrite step 3 / the registry
  // pass) removes an intent the moment its write expressed it, so a
  // still-pending intent proves the crash lands inside the window.

  /** Journal + slice state for the comment/flow/diagram families. */
  async function diagramFamilyPrecondition(
    page: Page,
    kind: 'comment' | 'flow' | 'diagram',
    priorIds: string[],
  ): Promise<SmallCrashPrecondition> {
    return await page.evaluate(async (args: { kind: string; prior: string[] }) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => {
          comments: Array<{ id: string }>
          flows: Array<{ id: string }>
          diagrams: Array<{ id: string }>
        } }
        __bridgeDebug?: () => { pendingIntentsByKind?: Record<string, number> }
      }
      const state = w.__modelStore?.getState()
      const slice = args.kind === 'comment'
        ? state?.comments
        : args.kind === 'flow' ? state?.flows : state?.diagrams
      const created = (slice ?? []).find((item) => !args.prior.includes(item.id))
      const journalOnDisk = await new Promise<boolean>((resolve) => {
        const open = indexedDB.open(((ns) => (ns ? `maplespire-model-index@${ns}` : 'maplespire-model-index'))(localStorage.getItem('maplespire:accountNamespace')))
        open.onerror = () => resolve(false)
        open.onsuccess = () => {
          const db = open.result
          try {
            const tx = db.transaction('idx', 'readonly')
            const store = tx.objectStore('idx')
            const keysReq = store.getAllKeys()
            const valuesReq = store.getAll()
            tx.oncomplete = () => {
              db.close()
              const keys = keysReq.result as IDBValidKey[]
              const values = valuesReq.result as unknown[]
              resolve(keys.some((key, index) => {
                if (typeof key !== 'string' || !(key.includes('pending-entity-intents:') && key.includes(':tab:'))) return false
                const list = values[index]
                return Array.isArray(list)
                  && list.some((entry) => (entry as { kind?: string }).kind === args.kind)
              }))
            }
            tx.onerror = () => { db.close(); resolve(false) }
          } catch {
            db.close()
            resolve(false)
          }
        }
      })
      return {
        createdId: created?.id ?? null,
        pendingOfKind: w.__bridgeDebug?.().pendingIntentsByKind?.[args.kind] ?? -1,
        journalOnDisk,
      }
    }, { kind, prior: priorIds })
  }

  async function waitForCanvas(page: Page): Promise<void> {
    await page.waitForURL('**/app/landscape/**', { timeout: 60_000 })
    await expect(page.getByTestId('comment-mode-toggle')).toBeVisible({ timeout: 60_000 })
    await page.waitForFunction(() => Boolean((window as unknown as { __canvasEngine?: unknown }).__canvasEngine), null, { timeout: 30_000 })
  }

  /** The durable-state badge, wherever the current view renders it: the shell
   * views carry `ws-sync-status` (WorkspaceShell), the EDITOR carries the
   * bottom bar's `#sync-status` (AppShell renders BottomBar only when
   * isEditor — the canvas has no ws-sync-status at all). Same status store
   * behind both. */
  async function awaitSyncReady(page: Page): Promise<void> {
    const badge = page.locator('[data-testid="ws-sync-status"], #sync-status').first()
    await expect(badge).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  }

  test('a COMMENT added then crashed pre-flush is visible again after reopening', async ({ baseURL }, testInfo) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'maplespire-crash-e2e-'))
    testInfo.attach?.('crash-profile-dir', { body: userDataDir })
    const flags = () => {
      localStorage.setItem('maplespire:bootFromServer', 'true')
      localStorage.setItem('maplespire:serverReadModel', 'true')
    }
    const context = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await context.addInitScript(flags)
    const page = context.pages()[0] ?? await context.newPage()
    await signIn(page)
    await waitForCanvas(page)
    const priorIds: string[] = await page.evaluate(() => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { comments: Array<{ id: string }> } }
      }
      return (w.__modelStore?.getState().comments ?? []).map((c) => c.id)
    })

    // Real UI: comment mode → empty-canvas click → composer → submit.
    const commentText = `crash-comment ${Date.now().toString(36)}`
    const createdId = await addCanvasComment(page, commentText)

    let precondition: SmallCrashPrecondition = { createdId: null, pendingOfKind: -1, journalOnDisk: false }
    await expect
      .poll(async () => {
        precondition = await diagramFamilyPrecondition(page, 'comment', priorIds)
        return precondition.journalOnDisk
      }, { timeout: 5_000, intervals: [25, 25, 50, 50, 100] })
      .toBe(true)
    // VOID-RUN GUARD: the value-checked ack in flushWrite step 3 removes the
    // intent when the DiagramDoc write expressed it.
    expect(precondition.pendingOfKind, 'crash must land BEFORE the diagram-doc write').toBeGreaterThanOrEqual(1)

    await crashRenderer(context, page)
    await Promise.race([
      context.close().catch(() => { /* already dead */ }),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])

    const reopenedContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await reopenedContext.addInitScript(flags)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await signIn(reopened)
    await waitForCanvas(reopened)

    // The replay writes the comment straight into the active DiagramDoc.
    await expect
      .poll(async () => await reopened.evaluate((args: { id: string; text: string }) => {
        const w = window as unknown as {
          __modelStore?: { getState: () => { comments: Array<{ id: string; text: string }> } }
        }
        return (w.__modelStore?.getState().comments ?? [])
          .some((c) => c.id === args.id && c.text === args.text)
      }, { id: createdId, text: commentText }), { timeout: 30_000 })
      .toBe(true)
    // PROVENANCE: restored BY THE REPLAY, not by a flush that won the race.
    await expect
      .poll(async () => await reopened.evaluate(() => {
        const w = window as unknown as {
          __maplespireDiagnostics?: { timeline: () => { entries: Array<{ name: string }> } }
        }
        return (w.__maplespireDiagnostics?.timeline().entries ?? [])
          .some((entry) => entry.name === 'entity-intents.diagram-collection-replay')
      }), { timeout: 30_000 })
      .toBe(true)
    await awaitSyncReady(reopened)

    // Leave the workspace as found.
    await reopened.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { deleteComment?: (id: string) => void } }
      }
      w.__modelStore?.getState().deleteComment?.(id)
    }, createdId)
    await awaitSyncReady(reopened)

    await reopenedContext.close()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  test('a FLOW created then crashed pre-flush is visible again after reopening', async ({ baseURL }, testInfo) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'maplespire-crash-e2e-'))
    testInfo.attach?.('crash-profile-dir', { body: userDataDir })
    const flags = () => {
      localStorage.setItem('maplespire:bootFromServer', 'true')
      localStorage.setItem('maplespire:serverReadModel', 'true')
    }
    const context = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await context.addInitScript(flags)
    const page = context.pages()[0] ?? await context.newPage()
    await signIn(page)
    await waitForCanvas(page)
    const priorIds: string[] = await page.evaluate(() => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { flows: Array<{ id: string }> } }
      }
      return (w.__modelStore?.getState().flows ?? []).map((f) => f.id)
    })

    // Real UI: flows panel → New flow. Crash right after the creation tick.
    await openFlowsPanel(page)
    await page.getByTestId('flow-dropdown-trigger').click()
    await page.getByTestId('flow-add').click()

    let precondition: SmallCrashPrecondition = { createdId: null, pendingOfKind: -1, journalOnDisk: false }
    await expect
      .poll(async () => {
        precondition = await diagramFamilyPrecondition(page, 'flow', priorIds)
        return precondition.createdId !== null && precondition.journalOnDisk
      }, { timeout: 5_000, intervals: [25, 25, 50, 50, 100] })
      .toBe(true)
    expect(precondition.pendingOfKind, 'crash must land BEFORE the diagram-doc write').toBeGreaterThanOrEqual(1)

    const createdId = precondition.createdId!
    await crashRenderer(context, page)
    await Promise.race([
      context.close().catch(() => { /* already dead */ }),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])

    const reopenedContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await reopenedContext.addInitScript(flags)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await signIn(reopened)
    await waitForCanvas(reopened)

    await expect
      .poll(async () => await reopened.evaluate((id: string) => {
        const w = window as unknown as {
          __modelStore?: { getState: () => { flows: Array<{ id: string }> } }
        }
        return (w.__modelStore?.getState().flows ?? []).some((f) => f.id === id)
      }, createdId), { timeout: 30_000 })
      .toBe(true)
    await expect
      .poll(async () => await reopened.evaluate(() => {
        const w = window as unknown as {
          __maplespireDiagnostics?: { timeline: () => { entries: Array<{ name: string }> } }
        }
        return (w.__maplespireDiagnostics?.timeline().entries ?? [])
          .some((entry) => entry.name === 'entity-intents.diagram-collection-replay')
      }), { timeout: 30_000 })
      .toBe(true)
    await awaitSyncReady(reopened)

    await reopened.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { deleteFlow?: (id: string) => void } }
      }
      w.__modelStore?.getState().deleteFlow?.(id)
    }, createdId)
    await awaitSyncReady(reopened)

    await reopenedContext.close()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  test('a DIAGRAM created then crashed pre-flush exists and OPENS after reopening', async ({ baseURL }, testInfo) => {
    // Two properties in one: the creation survives (the stub journal), and the
    // recovered diagram is OPENABLE — the doc-durability gate means a placed
    // meta can never point at a document that died with the tab (the zombie
    // stub whose cold open hangs forever).
    const userDataDir = mkdtempSync(join(tmpdir(), 'maplespire-crash-e2e-'))
    testInfo.attach?.('crash-profile-dir', { body: userDataDir })
    const flags = () => {
      localStorage.setItem('maplespire:bootFromServer', 'true')
      localStorage.setItem('maplespire:serverReadModel', 'true')
    }
    const context = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await context.addInitScript(flags)
    const page = context.pages()[0] ?? await context.newPage()
    await signIn(page)
    await page.waitForURL('**/app/landscape/**', { timeout: 60_000 })
    const priorIds: string[] = await page.evaluate(() => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { diagrams: Array<{ id: string }> } }
      }
      return (w.__modelStore?.getState().diagrams ?? []).map((d) => d.id)
    })

    // Real UI creation: the nav mega-menu's container-diagram entry.
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('create-diagram-container').click()

    let precondition: SmallCrashPrecondition = { createdId: null, pendingOfKind: -1, journalOnDisk: false }
    await expect
      .poll(async () => {
        precondition = await diagramFamilyPrecondition(page, 'diagram', priorIds)
        return precondition.createdId !== null && precondition.journalOnDisk
      }, { timeout: 5_000, intervals: [25, 25, 50, 50, 100] })
      .toBe(true)
    expect(precondition.pendingOfKind, 'crash must land BEFORE the registry meta is durable').toBeGreaterThanOrEqual(1)

    const createdId = precondition.createdId!
    // The create→flush→publish gate's observable effect: at crash time the
    // meta must NOT be in any registry shard doc — a doc that dies with this
    // tab must never already be referenced by a synced shard (the zombie-stub
    // window). Removing the gate makes this line fail deterministically.
    const metaAlreadyPlaced = await page.evaluate((id: string) => {
      const w = window as unknown as { __bridgeDebug?: () => { registryMetaIds?: string[] } }
      return (w.__bridgeDebug?.().registryMetaIds ?? []).includes(id)
    }, createdId)
    expect(metaAlreadyPlaced, 'the registry meta is held back until the doc flush confirms').toBe(false)
    await crashRenderer(context, page)
    await Promise.race([
      context.close().catch(() => { /* already dead */ }),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])

    const reopenedContext = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await reopenedContext.addInitScript(flags)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await signIn(reopened)
    await reopened.waitForURL('**/app/landscape/**', { timeout: 60_000 })

    // The replay re-injects the creation and the ordinary registry pass
    // re-places its meta.
    await expect
      .poll(async () => await reopened.evaluate((id: string) => {
        const w = window as unknown as {
          __modelStore?: { getState: () => { diagrams: Array<{ id: string }> } }
        }
        return (w.__modelStore?.getState().diagrams ?? []).some((d) => d.id === id)
      }, createdId), { timeout: 30_000 })
      .toBe(true)
    await expect
      .poll(async () => await reopened.evaluate(() => {
        const w = window as unknown as {
          __maplespireDiagnostics?: { timeline: () => { entries: Array<{ name: string }> } }
        }
        return (w.__maplespireDiagnostics?.timeline().entries ?? [])
          .some((entry) => entry.name === 'entity-intents.diagram-replay')
      }), { timeout: 30_000 })
      .toBe(true)
    // The journal must drain on its own — polled with a debt dump so a stuck
    // badge names the exact debt instead of a bare timeout.
    await expect
      .poll(async () => {
        const debts = await reopened.evaluate(() => {
          const w = window as unknown as {
            __bridgeDebug?: () => { pendingIntentsByKind?: Record<string, number>; placementPending?: number }
          }
          const debug = w.__bridgeDebug?.()
          return {
            byKind: debug?.pendingIntentsByKind ?? {},
            placement: debug?.placementPending ?? -1,
          }
        })
        console.log('[diag] pending', JSON.stringify(debts.byKind), 'placement', debts.placement)
        return Object.values(debts.byKind).reduce((sum, count) => sum + count, 0)
      }, { timeout: 60_000, intervals: [1_000] })
      .toBe(0)
    await awaitSyncReady(reopened)

    // OPENABLE, not just listed: navigate to the Diagrams page and open it
    // through the real card — a zombie stub dies here (the open hangs). The
    // Diagrams page is SERVER-PAGED on large workspaces: the card exists only
    // once the read-model projector has caught up, so locate it through the
    // search box and poll generously.
    await reopened.getByTestId('nav-menu').click()
    await reopened.getByTestId('nav-diagrams').click()
    const createdName: string = await reopened.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { diagrams: Array<{ id: string; name: string }> } }
      }
      return (w.__modelStore?.getState().diagrams ?? []).find((d) => d.id === id)?.name ?? ''
    }, createdId)
    // The server-paged list fetches ONLY when the query changes — a static
    // poll would wait on a fetch that already raced the projector and lost.
    // Re-type the query until the projection surfaces the card, and SWEEP the
    // virtualized grid: an off-viewport card is not in the DOM at all, and
    // the default-named test diagram sorts among its earlier-run homonyms.
    await expect(async () => {
      await reopened.getByTestId('diagrams-search').fill('')
      await reopened.getByTestId('diagrams-search').fill(createdName)
      await reopened.waitForTimeout(700)
      await reopened.locator('main').hover()
      for (let sweep = 0; sweep < 15; sweep += 1) {
        if (await reopened.getByTestId(`diagram-card-${createdId}`).isVisible().catch(() => false)) return
        await reopened.mouse.wheel(0, 600)
        await reopened.waitForTimeout(150)
      }
      throw new Error('recovered diagram card not rendered yet')
    }).toPass({ timeout: 90_000, intervals: [2_000] })
    // Single click SELECTS (and activates in the background); DOUBLE click is
    // the real open-in-editor gesture.
    await reopened.getByTestId(`diagram-card-${createdId}`).scrollIntoViewIfNeeded()
    await reopened.getByTestId(`diagram-card-${createdId}`).dblclick()
    await expect(reopened.getByTestId('comment-mode-toggle')).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(async () => await reopened.evaluate(() => {
        const w = window as unknown as {
          __modelStore?: { getState: () => { currentDiagramId: string | null } }
        }
        return w.__modelStore?.getState().currentDiagramId
      }), { timeout: 30_000 })
      .toBe(createdId)

    // Leave the workspace as found.
    await reopened.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { deleteDiagram?: (id: string) => void } }
      }
      w.__modelStore?.getState().deleteDiagram?.(id)
    }, createdId)
    await awaitSyncReady(reopened)

    await reopenedContext.close()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  test('a NON-ACTIVE diagram rename survives its activation and a reload (meta name authority)', async ({ baseURL }, testInfo) => {
    // The phase-B scout's user-facing defect, no crash involved: renames land
    // in the registry meta only, nothing copies meta.name into the doc, and
    // the old doc-wins projection silently UNDID the rename the moment the
    // diagram was activated. The projection now takes name/type from the meta.
    const userDataDir = mkdtempSync(join(tmpdir(), 'maplespire-crash-e2e-'))
    testInfo.attach?.('crash-profile-dir', { body: userDataDir })
    const flags = () => {
      localStorage.setItem('maplespire:bootFromServer', 'true')
      localStorage.setItem('maplespire:serverReadModel', 'true')
    }
    const context = await chromium.launchPersistentContext(userDataDir, { baseURL })
    await context.addInitScript(flags)
    const page = context.pages()[0] ?? await context.newPage()
    await signIn(page)
    await page.waitForURL('**/app/landscape/**', { timeout: 60_000 })

    // Create a scratch diagram (becomes active), let it become durable.
    const priorIds: string[] = await page.evaluate(() => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { diagrams: Array<{ id: string }> } }
      }
      return (w.__modelStore?.getState().diagrams ?? []).map((d) => d.id)
    })
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('create-diagram-container').click()
    let scratchId: string | null = null
    await expect
      .poll(async () => {
        scratchId = await page.evaluate((prior: string[]) => {
          const w = window as unknown as {
            __modelStore?: { getState: () => { diagrams: Array<{ id: string }> } }
          }
          return (w.__modelStore?.getState().diagrams ?? []).find((d) => !prior.includes(d.id))?.id ?? null
        }, priorIds)
        return scratchId !== null
      }, { timeout: 15_000 })
      .toBe(true)
    // Journal drain first (with a debt dump — a stuck badge then names the
    // debt), then the badge; under full-suite load the server-side durable
    // ack can lag the local drain by several seconds.
    await expect
      .poll(async () => {
        const debts = await page.evaluate(() => {
          const w = window as unknown as {
            __bridgeDebug?: () => { pendingIntentsByKind?: Record<string, number>; placementPending?: number }
          }
          const debug = w.__bridgeDebug?.()
          return { byKind: debug?.pendingIntentsByKind ?? {}, placement: debug?.placementPending ?? -1 }
        })
        console.log('[diag] pending', JSON.stringify(debts.byKind), 'placement', debts.placement)
        return Object.values(debts.byKind).reduce((sum, count) => sum + count, 0)
      }, { timeout: 60_000, intervals: [1_000] })
      .toBe(0)
    await awaitSyncReady(page)

    // Make it NON-active: open a DIFFERENT diagram from the Diagrams page.
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('nav-diagrams').click()
    const otherId = priorIds[0]
    await page.getByTestId(`diagram-card-${otherId}`).click()
    await expect
      .poll(async () => await page.evaluate(() => {
        const w = window as unknown as {
          __modelStore?: { getState: () => { currentDiagramId: string | null } }
        }
        return w.__modelStore?.getState().currentDiagramId
      }), { timeout: 60_000 })
      .toBe(otherId)

    // Rename the (now non-active) scratch diagram through the list UI. The
    // Diagrams page is SERVER-PAGED on large workspaces — reach the card via
    // the search box and wait for the read-model projection to surface it.
    const newName = `Renamed off-active ${Date.now().toString(36)}`
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('nav-diagrams').click()
    const scratchName: string = await page.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { diagrams: Array<{ id: string; name: string }> } }
      }
      return (w.__modelStore?.getState().diagrams ?? []).find((d) => d.id === id)?.name ?? ''
    }, scratchId!)
    await expect(async () => {
      await page.getByTestId('diagrams-search').fill('')
      await page.getByTestId('diagrams-search').fill(scratchName)
      await expect(page.getByTestId(`diagram-card-${scratchId}`)).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 90_000, intervals: [2_000] })
    // Let the server-paged refetch settle: a list re-render mid-menu closes
    // the portalled card menu (observed — the first click opened it and the
    // refetch swallowed it). Then open the menu, re-opening if a late render
    // still steals it.
    await page.waitForTimeout(1_500)
    await expect(async () => {
      const renameItem = page.getByTestId(`diagram-rename-${scratchId}`)
      if (!(await renameItem.isVisible().catch(() => false))) {
        await page.getByTestId(`diagram-card-${scratchId}`).hover()
        await page.getByTestId(`diagram-menu-${scratchId}`).click()
      }
      await expect(renameItem).toBeVisible({ timeout: 1_500 })
    }).toPass({ timeout: 30_000 })
    await page.getByTestId(`diagram-rename-${scratchId}`).click()
    const nameInput = page.locator('input:focus')
    await nameInput.fill(newName)
    await nameInput.press('Enter')
    await awaitSyncReady(page)

    // ACTIVATE it — a single card click sets it current, which attaches and
    // hydrates its DiagramDoc in the background (the exact moment the old
    // doc-wins projection reverted the rename). Re-search under the NEW name:
    // the server-paged list drops the card from the old-name query once the
    // projection catches up.
    await expect(async () => {
      await page.getByTestId('diagrams-search').fill('')
      await page.getByTestId('diagrams-search').fill(newName)
      await expect(page.getByTestId(`diagram-card-${scratchId}`)).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 90_000, intervals: [2_000] })
    await page.getByTestId(`diagram-card-${scratchId}`).click()
    await expect
      .poll(async () => await page.evaluate(() => {
        const w = window as unknown as {
          __modelStore?: { getState: () => { currentDiagramId: string | null } }
        }
        return w.__modelStore?.getState().currentDiagramId
      }), { timeout: 60_000 })
      .toBe(scratchId)
    const nameAfterActivation = () => page.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { diagrams: Array<{ id: string; name: string }> } }
      }
      return (w.__modelStore?.getState().diagrams ?? []).find((d) => d.id === id)?.name
    }, scratchId!)
    // Poll BRIEFLY then hold: the pre-fix revert happened exactly when the
    // doc finished hydrating, so a single immediate read could false-pass.
    await expect.poll(nameAfterActivation, { timeout: 15_000 }).toBe(newName)
    await page.waitForTimeout(2_000)
    expect(await nameAfterActivation(), 'the rename survived the doc hydration (no revert)').toBe(newName)

    // And a reload agrees.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForURL('**/app/landscape/**', { timeout: 60_000 })
    await expect.poll(nameAfterActivation, { timeout: 60_000 }).toBe(newName)

    // Leave the workspace as found.
    await page.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { deleteDiagram?: (id: string) => void } }
      }
      w.__modelStore?.getState().deleteDiagram?.(id)
    }, scratchId!)
    await awaitSyncReady(page)

    await context.close()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  test('intents of a REMOTELY deleted diagram retire at the next boot (absence sweep)', async ({ baseURL }, testInfo) => {
    // Client A crashes with a pending comment intent for diagram D; client B
    // deletes D while A is down. Without the absence sweep, A's next boot
    // rehydrates the intent into a debt NOTHING can retire — the replay parks
    // non-active intents until "their diagram is activated" (which a deleted
    // diagram never is), the flush acks skip them, and the badge reads
    // 'saving' forever. The sweep retires them against the COMPLETE registry
    // observation instead.
    const userDataDirA = mkdtempSync(join(tmpdir(), 'maplespire-crash-e2e-'))
    const userDataDirB = mkdtempSync(join(tmpdir(), 'maplespire-crash-e2e-b-'))
    testInfo.attach?.('crash-profile-dir', { body: userDataDirA })
    const flags = () => {
      localStorage.setItem('maplespire:bootFromServer', 'true')
      localStorage.setItem('maplespire:serverReadModel', 'true')
    }

    // ── client A: create D, make it durable, comment on it, crash pre-flush ──
    const contextA = await chromium.launchPersistentContext(userDataDirA, { baseURL })
    await contextA.addInitScript(flags)
    const pageA = contextA.pages()[0] ?? await contextA.newPage()
    await signIn(pageA)
    await waitForCanvas(pageA)
    // Remember a safe diagram to boot into after the crash: the relaunch
    // restores the last ACTIVE diagram, which will be the deleted D.
    const homeUrl = pageA.url()
    const priorIds: string[] = await pageA.evaluate(() => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { diagrams: Array<{ id: string }> } }
      }
      return (w.__modelStore?.getState().diagrams ?? []).map((d) => d.id)
    })
    await pageA.getByTestId('nav-menu').click()
    await pageA.getByTestId('create-diagram-container').click()
    let doomedId: string | null = null
    await expect
      .poll(async () => {
        doomedId = await pageA.evaluate((prior: string[]) => {
          const w = window as unknown as {
            __modelStore?: { getState: () => { diagrams: Array<{ id: string }> } }
          }
          return (w.__modelStore?.getState().diagrams ?? []).find((d) => !prior.includes(d.id))?.id ?? null
        }, priorIds)
        return doomedId !== null
      }, { timeout: 15_000 })
      .toBe(true)
    // D must be durable before B can delete it: meta placed in a registry
    // shard (the create→flush→publish gate lifted), then the badge's 'ready'
    // — which requires the durable server ack of every written doc, so the
    // shard carrying D's meta has reached the server B syncs from. (No
    // /api polling here: the page's plain fetch to the API origin carries no
    // session cookie under AUTH=on — it reads 401/undefined forever.)
    await expect
      .poll(async () => await pageA.evaluate((id: string) => {
        const w = window as unknown as { __bridgeDebug?: () => { registryMetaIds?: string[] } }
        return (w.__bridgeDebug?.().registryMetaIds ?? []).includes(id)
      }, doomedId!), { timeout: 60_000, intervals: [500] })
      .toBe(true)
    await awaitSyncReady(pageA)
    const doomedName: string = await pageA.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { diagrams: Array<{ id: string; name: string }> } }
      }
      return (w.__modelStore?.getState().diagrams ?? []).find((d) => d.id === id)?.name ?? ''
    }, doomedId!)
    expect(doomedName, 'A must know the doomed diagram name for B to search').not.toBe('')

    // D is the active diagram (creation activates it). Comment through the
    // real composer, then crash INSIDE the debounce window so the intent is
    // journaled on disk but never expressed in the DiagramDoc.
    await expect(pageA.getByTestId('comment-mode-toggle')).toBeVisible({ timeout: 30_000 })
    const commentText = `remote-delete-wedge ${Date.now().toString(36)}`
    await addCanvasComment(pageA, commentText)
    let precondition: SmallCrashPrecondition = { createdId: null, pendingOfKind: -1, journalOnDisk: false }
    await expect
      .poll(async () => {
        precondition = await diagramFamilyPrecondition(pageA, 'comment', [])
        return precondition.journalOnDisk
      }, { timeout: 5_000, intervals: [25, 25, 50, 50, 100] })
      .toBe(true)
    // VOID-RUN GUARD: the crash must land before the flush acks the intent.
    expect(precondition.pendingOfKind, 'crash must land BEFORE the diagram-doc write').toBeGreaterThanOrEqual(1)
    await crashRenderer(contextA, pageA)
    await Promise.race([
      contextA.close().catch(() => { /* already dead */ }),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])

    // ── client B (own profile): delete D through the Diagrams-list UI ──
    const contextB = await chromium.launchPersistentContext(userDataDirB, { baseURL })
    await contextB.addInitScript(flags)
    const pageB = contextB.pages()[0] ?? await contextB.newPage()
    await signIn(pageB)
    await pageB.waitForURL('**/app/landscape/**', { timeout: 60_000 })
    await pageB.getByTestId('nav-menu').click()
    await pageB.getByTestId('nav-diagrams').click()
    // Locate the card (retyped search + virtualized sweep), then open the
    // portalled menu — the sweep must be OVER first, the card menu dismisses
    // on scroll.
    await expect(async () => {
      await pageB.getByTestId('diagrams-search').fill('')
      await pageB.getByTestId('diagrams-search').fill(doomedName)
      await pageB.waitForTimeout(700)
      await pageB.locator('main').hover()
      for (let sweep = 0; sweep < 15; sweep += 1) {
        if (await pageB.getByTestId(`diagram-card-${doomedId}`).isVisible().catch(() => false)) return
        await pageB.mouse.wheel(0, 600)
        await pageB.waitForTimeout(150)
      }
      throw new Error('doomed diagram card not rendered yet on client B')
    }).toPass({ timeout: 90_000, intervals: [2_000] })
    await pageB.waitForTimeout(1_500)
    await expect(async () => {
      const deleteItem = pageB.getByTestId('diagram-delete')
      if (!(await deleteItem.isVisible().catch(() => false))) {
        await pageB.getByTestId(`diagram-card-${doomedId}`).hover()
        await pageB.getByTestId(`diagram-menu-${doomedId}`).click()
      }
      await expect(deleteItem).toBeVisible({ timeout: 1_500 })
    }).toPass({ timeout: 30_000 })
    await pageB.getByTestId('diagram-delete').click()
    // The removal must be durably expressed before A reboots: B's resident
    // list drops D, then B's badge reaches 'ready' (durable server ack of
    // the shard write that removed the meta).
    await expect
      .poll(async () => await pageB.evaluate((id: string) => {
        const w = window as unknown as {
          __modelStore?: { getState: () => { diagrams: Array<{ id: string }> } }
        }
        return (w.__modelStore?.getState().diagrams ?? []).some((d) => d.id === id)
      }, doomedId!), { timeout: 30_000 })
      .toBe(false)
    await awaitSyncReady(pageB)
    await contextB.close()

    // ── client A reboots: the hydrated wedge must retire on its own ──
    const reopenedContext = await chromium.launchPersistentContext(userDataDirA, { baseURL })
    await reopenedContext.addInitScript(flags)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await signIn(reopened)
    // Boot into a diagram that still exists — booting into deleted D would
    // test the deep-link-to-missing-diagram path, not the sweep.
    await reopened.goto(homeUrl, { waitUntil: 'domcontentloaded' })
    await waitForCanvas(reopened)

    // The discriminator: pre-sweep code holds pendingIntentsByKind.comment at
    // ≥ 1 forever (nothing can retire it) and this poll times out RED.
    await expect
      .poll(async () => {
        const debts = await reopened.evaluate(() => {
          const w = window as unknown as {
            __bridgeDebug?: () => { pendingIntentsByKind?: Record<string, number>; placementPending?: number }
          }
          const debug = w.__bridgeDebug?.()
          return { byKind: debug?.pendingIntentsByKind ?? {}, placement: debug?.placementPending ?? -1 }
        })
        console.log('[remote-del] pending', JSON.stringify(debts.byKind), 'placement', debts.placement)
        return Object.values(debts.byKind).reduce((sum, count) => sum + count, 0)
      }, { timeout: 60_000, intervals: [1_000] })
      .toBe(0)
    // PROVENANCE: retired BY THE SWEEP — not by a replay, not by a flush.
    await expect
      .poll(async () => await reopened.evaluate(() => {
        const w = window as unknown as {
          __maplespireDiagnostics?: { timeline: () => { entries: Array<{ name: string }> } }
        }
        return (w.__maplespireDiagnostics?.timeline().entries ?? [])
          .some((entry) => entry.name === 'entity-intents.absence-sweep')
      }), { timeout: 30_000 })
      .toBe(true)
    await awaitSyncReady(reopened)
    // And the deleted diagram stayed deleted — the retirement never re-placed
    // anything.
    const doomedStillListed = await reopened.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { diagrams: Array<{ id: string }> } }
      }
      return (w.__modelStore?.getState().diagrams ?? []).some((d) => d.id === id)
    }, doomedId!)
    expect(doomedStillListed, 'the remote delete holds after the sweep').toBe(false)

    await reopenedContext.close()
    rmSync(userDataDirA, { recursive: true, force: true })
    rmSync(userDataDirB, { recursive: true, force: true })
  })

  test('a LIVE remote delete retires the parked intents without reload, and the next flush does not resurrect the diagram', async ({ baseURL }, testInfo) => {
    // The previous test exercises the boot junctions only; this one covers the
    // live shard-change trigger (needed because projectAll is blind under
    // boot-from-server). It also pins that, after the sweep retires, the
    // client's own flush does not RE-PLACE the remotely-deleted meta from its
    // stale store (placeIds), which would undo the colleague's delete
    // registry-wide.
    const userDataDirA = mkdtempSync(join(tmpdir(), 'maplespire-crash-e2e-'))
    const userDataDirB = mkdtempSync(join(tmpdir(), 'maplespire-crash-e2e-b-'))
    testInfo.attach?.('crash-profile-dir', { body: userDataDirA })
    const flags = () => {
      localStorage.setItem('maplespire:bootFromServer', 'true')
      localStorage.setItem('maplespire:serverReadModel', 'true')
    }

    // ── A1: create D (durable), comment on it, crash pre-flush — test 9's setup ──
    const contextA = await chromium.launchPersistentContext(userDataDirA, { baseURL })
    await contextA.addInitScript(flags)
    const pageA = contextA.pages()[0] ?? await contextA.newPage()
    await signIn(pageA)
    await waitForCanvas(pageA)
    const homeUrl = pageA.url()
    const priorIds: string[] = await pageA.evaluate(() => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { diagrams: Array<{ id: string }> } }
      }
      return (w.__modelStore?.getState().diagrams ?? []).map((d) => d.id)
    })
    await pageA.getByTestId('nav-menu').click()
    await pageA.getByTestId('create-diagram-container').click()
    let doomedId: string | null = null
    await expect
      .poll(async () => {
        doomedId = await pageA.evaluate((prior: string[]) => {
          const w = window as unknown as {
            __modelStore?: { getState: () => { diagrams: Array<{ id: string }> } }
          }
          return (w.__modelStore?.getState().diagrams ?? []).find((d) => !prior.includes(d.id))?.id ?? null
        }, priorIds)
        return doomedId !== null
      }, { timeout: 15_000 })
      .toBe(true)
    await expect
      .poll(async () => await pageA.evaluate((id: string) => {
        const w = window as unknown as { __bridgeDebug?: () => { registryMetaIds?: string[] } }
        return (w.__bridgeDebug?.().registryMetaIds ?? []).includes(id)
      }, doomedId!), { timeout: 60_000, intervals: [500] })
      .toBe(true)
    await awaitSyncReady(pageA)
    const doomedName: string = await pageA.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { diagrams: Array<{ id: string; name: string }> } }
      }
      return (w.__modelStore?.getState().diagrams ?? []).find((d) => d.id === id)?.name ?? ''
    }, doomedId!)
    expect(doomedName).not.toBe('')
    await expect(pageA.getByTestId('comment-mode-toggle')).toBeVisible({ timeout: 30_000 })
    await addCanvasComment(pageA, `live-remote-delete ${Date.now().toString(36)}`)
    let precondition: SmallCrashPrecondition = { createdId: null, pendingOfKind: -1, journalOnDisk: false }
    await expect
      .poll(async () => {
        precondition = await diagramFamilyPrecondition(pageA, 'comment', [])
        return precondition.journalOnDisk
      }, { timeout: 5_000, intervals: [25, 25, 50, 50, 100] })
      .toBe(true)
    expect(precondition.pendingOfKind, 'crash must land BEFORE the diagram-doc write').toBeGreaterThanOrEqual(1)
    await crashRenderer(contextA, pageA)
    await Promise.race([
      contextA.close().catch(() => { /* already dead */ }),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])

    // ── A2 reboots FIRST, while D still exists: the hydrated intent parks
    //    honestly (D is non-active — the home deep-link keeps it that way) ──
    const reopenedContext = await chromium.launchPersistentContext(userDataDirA, { baseURL })
    await reopenedContext.addInitScript(flags)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await signIn(reopened)
    await reopened.goto(homeUrl, { waitUntil: 'domcontentloaded' })
    await waitForCanvas(reopened)
    await expect
      .poll(async () => await reopened.evaluate(() => {
        const w = window as unknown as {
          __bridgeDebug?: () => { pendingIntentsByKind?: Record<string, number> }
        }
        return w.__bridgeDebug?.().pendingIntentsByKind?.comment ?? 0
      }), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1)

    // ── B deletes D while A2 is RUNNING ──
    const contextB = await chromium.launchPersistentContext(userDataDirB, { baseURL })
    await contextB.addInitScript(flags)
    const pageB = contextB.pages()[0] ?? await contextB.newPage()
    await signIn(pageB)
    await pageB.waitForURL('**/app/landscape/**', { timeout: 60_000 })
    await pageB.getByTestId('nav-menu').click()
    await pageB.getByTestId('nav-diagrams').click()
    await expect(async () => {
      await pageB.getByTestId('diagrams-search').fill('')
      await pageB.getByTestId('diagrams-search').fill(doomedName)
      await pageB.waitForTimeout(700)
      await pageB.locator('main').hover()
      for (let sweep = 0; sweep < 15; sweep += 1) {
        if (await pageB.getByTestId(`diagram-card-${doomedId}`).isVisible().catch(() => false)) return
        await pageB.mouse.wheel(0, 600)
        await pageB.waitForTimeout(150)
      }
      throw new Error('doomed diagram card not rendered yet on client B')
    }).toPass({ timeout: 90_000, intervals: [2_000] })
    await pageB.waitForTimeout(1_500)
    await expect(async () => {
      const deleteItem = pageB.getByTestId('diagram-delete')
      if (!(await deleteItem.isVisible().catch(() => false))) {
        await pageB.getByTestId(`diagram-card-${doomedId}`).hover()
        await pageB.getByTestId(`diagram-menu-${doomedId}`).click()
      }
      await expect(deleteItem).toBeVisible({ timeout: 1_500 })
    }).toPass({ timeout: 30_000 })
    await pageB.getByTestId('diagram-delete').click()
    await expect
      .poll(async () => await pageB.evaluate((id: string) => {
        const w = window as unknown as {
          __modelStore?: { getState: () => { diagrams: Array<{ id: string }> } }
        }
        return (w.__modelStore?.getState().diagrams ?? []).some((d) => d.id === id)
      }, doomedId!), { timeout: 30_000 })
      .toBe(false)

    // ── anti-resurrection probe FIRST, while A2's store still holds ghost D:
    //    the CRITICAL's real-world shape is a user actively editing (their
    //    keystrokes defer the live refresh via the quiet gate while their
    //    flushes run with the stale store). Editing right now keeps the
    //    ghost alive through the probe flush; pre-fix placeIds re-places
    //    D's meta here. The ghost state is logged so a slow run reads as
    //    less-discriminating rather than silently green.
    const ghostBeforeProbe = await reopened.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { diagrams: Array<{ id: string }> } }
      }
      return (w.__modelStore?.getState().diagrams ?? []).some((d) => d.id === id)
    }, doomedId!)
    console.log('[live-del] ghost in store before probe edit:', ghostBeforeProbe)
    const markerId = await addCanvasComment(reopened, `resurrection-probe ${Date.now().toString(36)}`)

    // ── the shard-change trigger must retire the parked debt, NO reload ──
    await expect
      .poll(async () => {
        const debts = await reopened.evaluate(() => {
          const w = window as unknown as {
            __bridgeDebug?: () => { pendingIntentsByKind?: Record<string, number>; placementPending?: number }
          }
          const debug = w.__bridgeDebug?.()
          return { byKind: debug?.pendingIntentsByKind ?? {}, placement: debug?.placementPending ?? -1 }
        })
        console.log('[live-del] pending', JSON.stringify(debts.byKind), 'placement', debts.placement)
        return Object.values(debts.byKind).reduce((sum, count) => sum + count, 0)
      }, { timeout: 60_000, intervals: [1_000] })
      .toBe(0)
    await expect
      .poll(async () => await reopened.evaluate(() => {
        const w = window as unknown as {
          __maplespireDiagnostics?: { timeline: () => { entries: Array<{ name: string }> } }
        }
        return (w.__maplespireDiagnostics?.timeline().entries ?? [])
          .some((entry) => entry.name === 'entity-intents.absence-sweep')
      }), { timeout: 30_000 })
      .toBe(true)
    await awaitSyncReady(reopened)
    const resurrected = await reopened.evaluate((id: string) => {
      const w = window as unknown as { __bridgeDebug?: () => { registryMetaIds?: string[] } }
      return (w.__bridgeDebug?.().registryMetaIds ?? []).includes(id)
    }, doomedId!)
    expect(resurrected, 'the flush after the sweep must NOT re-place the deleted meta').toBe(false)
    await awaitSyncReady(pageB)
    await contextB.close()

    // Leave the workspace as found.
    await reopened.evaluate((id: string) => {
      const w = window as unknown as {
        __modelStore?: { getState: () => { deleteComment?: (id: string) => void } }
      }
      w.__modelStore?.getState().deleteComment?.(id)
    }, markerId)
    await awaitSyncReady(reopened)

    await reopenedContext.close()
    rmSync(userDataDirA, { recursive: true, force: true })
    rmSync(userDataDirB, { recursive: true, force: true })
  })
})
