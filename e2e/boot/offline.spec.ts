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

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import {
  enterBootApp,
  enterBootAppOffline,
  reloadBootApp,
  goOffline,
  goOnline,
  flushLocal,
  waitForDiagramRenderCached,
  dragNewShapeToCanvas,
  serverObject,
  storeObject,
} from './helpers'

/** The distinct, deduped object ids resident in the windowed store right now. */
const residentObjectIds = (page: import('@playwright/test').Page): Promise<string[]> =>
  page.evaluate(() => [...new Set(
    (window as any).__modelStore.getState().objects.map((o: any) => String(o.id)),
  )].sort() as string[])

// Offline-first resilience against the boot-from-server stack. We block ONLY the backend
// (:3002 — HTTP render + WS sync) and keep the SPA (:5180) reachable, so the app reloads but
// boots OFFLINE. There is no server to confirm against, so durability is proven by reloading
// OFFLINE (full page reload wipes the JS heap) and reading the value back from the store, which
// rehydrates from IndexedDB — i.e. it survived without the server. flushLocal() forces pending
// Automerge changes to IndexedDB first (the offline analogue of the server-confirm gate).
//
// Prerequisite: repo.ts caches the root-doc url so a warm client can boot offline at all —
// otherwise fetchRootUrl() would do a hard HTTP GET on boot and the app would die offline.

test.describe('offline-first — boot', () => {
  test('a warm client boots OFFLINE: the diagram list + registry load from IndexedDB', async ({ page }) => {
    await enterBootApp(page) // warm IndexedDB (and cache the root url) while online
    const onlineDiagrams = await page.evaluate(() => (window as any).__modelStore.getState().diagrams.length)
    expect(onlineDiagrams).toBeGreaterThan(0)

    await goOffline(page)
    await page.reload()
    await enterBootAppOffline(page) // must NOT throw — the app boots with no backend

    const s = await page.evaluate(() => {
      const st = (window as any).__modelStore.getState()
      return { diagrams: st.diagrams.length, groups: st.groups.length, currentDiagramId: st.currentDiagramId }
    })
    expect(s.currentDiagramId).toBeTruthy() // a diagram is open
    expect(s.diagrams).toBeGreaterThan(0) // the whole diagram registry is available offline
  })
})

test.describe('offline-first — create + edit local content', () => {
  test('add a new shape offline; it persists across an offline reload', async ({ page }) => {
    await enterBootApp(page)
    await goOffline(page)

    const id = await dragNewShapeToCanvas(page, 'system') // create offline (local edits overlay)
    expect(await storeObject(page, id)).toBeTruthy()

    await flushLocal(page) // commit the local Automerge change to IndexedDB
    await page.reload()
    await enterBootAppOffline(page)

    // Survived a full offline reload, read back from IndexedDB (not memory) — no server involved.
    await expect.poll(async () => await storeObject(page, id).then((o: any) => !!o), { timeout: 15_000 }).toBe(true)
  })

  test('edit a shape created offline; the edit persists across an offline reload', async ({ page }) => {
    await enterBootApp(page)
    await goOffline(page)

    const id = await dragNewShapeToCanvas(page, 'app')
    // The drop selects it → edit its name through the real sidebar.
    const name = 'OFFLINE-EDIT-' + Date.now()
    await expect(page.getByTestId('object-name')).toBeVisible()
    await page.getByTestId('object-name').fill(name)
    await page.getByTestId('object-name').blur()
    await expect(page.getByTestId('object-name')).toHaveValue(name)

    await flushLocal(page)
    await page.reload()
    await enterBootAppOffline(page)

    await expect.poll(async () => (await storeObject(page, id))?.name, { timeout: 15_000 }).toBe(name)
  })

  test('create a NEW diagram offline; it persists across an offline reload', async ({ page }) => {
    await enterBootApp(page)
    const before: string[] = await page.evaluate(() =>
      (window as any).__modelStore.getState().diagrams.map((d: any) => d.id)
    )
    await goOffline(page)

    // Real UI: breadcrumb menu → All diagrams → Create diagram → Blank diagram.
    await page.getByTestId('nav-menu').click()
    await page.getByTestId('nav-diagrams').click()
    await page.getByTestId('create-diagram-button').click()
    await page.getByTestId('create-blank').click()

    // Creating a blank diagram switches to it → currentDiagramId is the new id.
    const newId = await page.evaluate(
      async (prev: string[]) => {
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
        for (let i = 0; i < 50; i++) {
          const s = (window as any).__modelStore.getState()
          const fresh = s.diagrams.find((d: any) => !prev.includes(d.id))
          if (fresh) return fresh.id as string
          await wait(60)
        }
        return null
      },
      before
    )
    expect(newId).toBeTruthy()

    await flushLocal(page)
    await page.reload()
    await enterBootAppOffline(page)

    const stillThere = await page.evaluate(
      (nid) => (window as any).__modelStore.getState().diagrams.some((d: any) => d.id === nid),
      newId
    )
    expect(stillThere).toBe(true) // the offline-created diagram survived the offline reload
  })
})

test.describe('offline-first — sync status badge', () => {
  test('the bottom-bar shows Offline when the server is unreachable, and clears on reconnect', async ({ page }) => {
    await enterBootApp(page) // online → Synced
    const badge = page.locator('#sync-status')
    await expect.poll(async () => badge.getAttribute('data-status'), { timeout: 15_000 }).toBe('ready')

    // In boot-from-server mode navigator.onLine stays true when only :3002 dies, so the badge is
    // driven by the render fetch failing. Go offline and reload → it must read Offline.
    await goOffline(page)
    await page.reload()
    await enterBootAppOffline(page)
    await expect.poll(async () => badge.getAttribute('data-status'), { timeout: 20_000 }).toBe('offline')
    await expect(badge).toContainText('Offline')

    // Reconnect → the next successful render flips the badge back to Synced.
    await goOnline(page)
    await reloadBootApp(page)
    await expect.poll(async () => badge.getAttribute('data-status'), { timeout: 20_000 }).toBe('ready')
  })
})

test.describe('offline-first — reconnect', () => {
  test('a shape added offline syncs to the server once back online', async ({ page }) => {
    await enterBootApp(page)
    await goOffline(page)
    const id = await dragNewShapeToCanvas(page, 'system')
    await flushLocal(page)
    // (can't query the server while offline — the fetch is blocked; the point is the reconnect.)

    // Reconnect and reload online → the queued local change syncs up to the server read model.
    await goOnline(page)
    await reloadBootApp(page)
    await expect.poll(async () => await serverObject(page, id).then((o: any) => !!o), { timeout: 30_000 }).toBe(true)
  })
})

// ── The active diagram's EXISTING (server-rendered) content offline ───────────────────
// When the server is unreachable, loadDiagramRenderForProjection serves the render from the
// Worker's diagram-render cache (readCachedDiagramRender — written by every online open), so
// the active diagram's pre-existing objects/connections stay visible AND editable offline.
// The fallback fires ONLY on the offline catch path — the online render is untouched. Each
// test waits, online, for that cache write to land: it is scheduled after paint and never
// awaited. (These used to wait for the legacy background index build, which nothing starts
// any more, so they could only time out.)
test.describe('offline-first — existing diagram content (Bug B fixed)', () => {
  test('existing shapes ARE visible offline, an EXACT match for the online render', async ({ page }) => {
    await enterBootApp(page)
    await waitForDiagramRenderCached(page) // the offline fallback serves the cached render
    const onlineIds = await residentObjectIds(page)
    test.skip(onlineIds.length === 0, 'active diagram had no server-rendered objects to begin with')

    await goOffline(page)
    await page.reload()
    await enterBootAppOffline(page)

    // Was 0 before the fix; now the existing content is served from the render cache, and it's
    // the SAME object set the server render produced (no missing, no spurious extras).
    await expect
      .poll(async () => (await residentObjectIds(page)).length, { timeout: 20_000 })
      .toBe(onlineIds.length)
    expect(await residentObjectIds(page)).toEqual(onlineIds)
  })

  test('edit an EXISTING (server-rendered) shape OFFLINE; persists across an offline reload', async ({ page }) => {
    await enterBootApp(page)
    await waitForDiagramRenderCached(page)
    const onlineIds = await residentObjectIds(page)
    test.skip(onlineIds.length === 0, 'active diagram had no server-rendered objects to begin with')
    const id = onlineIds[0]
    // It is a real, persisted server object (confirm while still online).
    expect(await serverObject(page, id)).toBeTruthy()

    await goOffline(page)
    await page.reload()
    await enterBootAppOffline(page)

    // The pre-existing shape is projected into the windowed store from the cached render.
    await expect.poll(async () => await storeObject(page, id).then((o: any) => !!o), { timeout: 20_000 }).toBe(true)

    // Select it through the real store action the canvas uses (selectedItems) → the RightSidebar
    // object editor opens; edit its name as a user would. (Selecting via the store, not a canvas
    // pixel-click, avoids racing the async offline re-projection / zoom-to-fit.)
    await page.evaluate((oid) => (window as any).__modelStore.getState().selectObjects([oid]), id)
    const name = 'OFFLINE-EXISTING-' + Date.now()
    await expect(page.getByTestId('object-name')).toBeVisible()
    await page.getByTestId('object-name').fill(name)
    await page.getByTestId('object-name').blur()
    await expect(page.getByTestId('object-name')).toHaveValue(name)

    await flushLocal(page)
    await page.reload()
    await enterBootAppOffline(page)

    // The offline edit to a pre-existing shape survived the offline reload (overlay on top of
    // the locally-rebuilt render), read back from IndexedDB — no server involved.
    await expect.poll(async () => (await storeObject(page, id))?.name, { timeout: 20_000 }).toBe(name)
  })

  test('existing content survives an online→offline→online round-trip with no duplication', async ({ page }) => {
    await enterBootApp(page)
    await waitForDiagramRenderCached(page)
    const onlineIds = await residentObjectIds(page)
    test.skip(onlineIds.length === 0, 'active diagram had no server-rendered objects to begin with')

    // OFFLINE: same id set, rebuilt from the index.
    await goOffline(page)
    await page.reload()
    await enterBootAppOffline(page)
    await expect
      .poll(async () => (await residentObjectIds(page)).length, { timeout: 20_000 })
      .toBe(onlineIds.length)
    expect(await residentObjectIds(page)).toEqual(onlineIds)

    // BACK ONLINE: the server render takes over again and the set is UNCHANGED — the offline
    // overlay didn't duplicate or drop anything.
    await goOnline(page)
    await reloadBootApp(page)
    expect(await residentObjectIds(page)).toEqual(onlineIds)
  })
})
