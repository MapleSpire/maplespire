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

import { test, expect, type Page } from '@playwright/test'
import { enterBootApp, goOffline, goOnline, pickOffWindowObject, serverObject, sidebarDeleteTreeNode } from './helpers'

// Spotlight's server tier, on the boot-from-server stack (VITE_BOOT_FROM_SERVER +
// VITE_SERVER_READ_MODEL; enterBootApp FAILS unless boot-from-server is really active).
// The resident store holds the open diagram's window only, so an object placed on
// another diagram can be found only through POST /api/model/spotlight. These tests
// search for such an object through the real UI (⌘K / Ctrl K, typing, Enter), and
// prove the resident results still answer when the server cannot.

const input = (page: Page) => page.getByTestId('spotlight-input')
const row = (page: Page, id: string) => page.locator(`[data-testid="spotlight-row"][data-key$=":${id}"]`)

async function openSpotlight(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k')
  await expect(input(page)).toBeVisible()
}

type StoreWindow = { __modelStore: { getState(): { objects: Array<{ id: string; name: string }> } } }

/** Whether the store holds the object (a precondition check, never an action). */
async function isResident(page: Page, id: string): Promise<boolean> {
  return page.evaluate((oid) => (window as unknown as StoreWindow).__modelStore.getState().objects.some((o) => o.id === oid), id)
}

/** A resident object with a name no other object shares, for the offline control. */
async function residentObject(page: Page): Promise<{ id: string; name: string }> {
  return page.evaluate(() => {
    const objects = (window as unknown as StoreWindow).__modelStore.getState().objects
    const counts = new Map<string, number>()
    for (const o of objects) counts.set(o.name, (counts.get(o.name) ?? 0) + 1)
    const o = objects.find((x) => counts.get(x.name) === 1 && x.name.trim().length >= 3) ?? objects[0]
    return { id: o.id, name: o.name }
  })
}

test.describe('Spotlight — the server tier covers the whole workspace', () => {
  test('finds an object that is NOT in the resident window, and opens it on its diagram', async ({ page }) => {
    await enterBootApp(page)
    const off = await pickOffWindowObject(page)
    expect(await serverObject(page, off.id), 'the target exists in the read model').toBeTruthy()

    await openSpotlight(page)
    const answered = page.waitForResponse((r) => r.url().includes('/api/model/spotlight') && r.request().method() === 'POST')
    await input(page).fill(off.name)
    const response = await answered
    expect(response.status()).toBe(200)
    // Asked about the CONCRETE version this tab's documents belong to, as the
    // durability witness is (`documentsWorkspaceFor`), never the `current`
    // alias, and answered about exactly that version.
    const asked = new URL(response.url()).searchParams
    const echo = await response.json() as { landscapeId?: unknown; versionId?: unknown }
    expect(asked.get('versionId'), 'Spotlight asks about a concrete version').not.toBe('current')
    expect({ landscapeId: echo.landscapeId, versionId: echo.versionId }, 'the server answered about exactly what was asked')
      .toEqual({ landscapeId: asked.get('landscapeId'), versionId: asked.get('versionId') })

    // The only way this row exists is the server's answer: the store does not hold it.
    await expect(row(page, off.id).first()).toBeVisible()
    expect(await isResident(page, off.id)).toBe(false)

    await row(page, off.id).first().click()
    await expect(input(page)).toBeHidden()
    // Opened on a diagram that places it, selected in the inspector.
    await expect(page).toHaveURL(/\/diagram\//)
    await expect(page.getByTestId('object-name')).toHaveValue(off.name)
  })

  test('does not bring back an object this tab deleted while the projection still lists it', async ({ page }) => {
    await enterBootApp(page)
    const off = await pickOffWindowObject(page)

    // Control: before the delete the server lists it. Keep its hit as the server sent it.
    await openSpotlight(page)
    const first = page.waitForResponse((r) => r.url().includes('/api/model/spotlight') && r.request().method() === 'POST')
    await input(page).fill(off.name)
    const body = await (await first).json() as { sections: Array<{ kind: string; hits: Array<{ doc: { id: string } }> }> }
    const section = body.sections.find((s) => s.hits.some((h) => h.doc.id === off.id))
    expect(section, 'the server lists the object before the delete').toBeTruthy()
    const staleHit = section!.hits.find((h) => h.doc.id === off.id)!
    await expect(row(page, off.id).first()).toBeVisible()
    await page.keyboard.press('Escape') // clears the query
    await page.keyboard.press('Escape') // closes

    // Delete it through the real sidebar menu.
    await sidebarDeleteTreeNode(page, off.id, off.name)
    await expect(page.getByTestId(`tree-node-${off.id}`)).toHaveCount(0)

    // The projection lags: every answer still carries the deleted object.
    let injected = 0
    await page.route('**/api/model/spotlight**', async (route) => {
      const response = await route.fetch()
      const answer = await response.json() as { sections: Array<{ kind: string; total: number; totalCapped: boolean; hits: unknown[] }> }
      const others = answer.sections.filter((s) => s.kind !== section!.kind)
      answer.sections = [...others, { kind: section!.kind, total: 1, totalCapped: false, hits: [staleHit] }]
      injected += 1
      await route.fulfill({ response, json: answer })
    })
    await openSpotlight(page)
    await input(page).fill(off.name)
    await expect.poll(() => injected).toBeGreaterThan(0)
    await page.waitForTimeout(500)
    await expect(row(page, off.id)).toHaveCount(0)
  })

  test('keeps answering from the store when the server is down, and widens again when it is back', async ({ page }) => {
    await enterBootApp(page)
    const off = await pickOffWindowObject(page)
    const resident = await residentObject(page)
    const spotlightRequests: string[] = []
    page.on('request', (r) => { if (r.url().includes('/api/model/spotlight')) spotlightRequests.push(r.url()) })

    // The server goes away (requests fail) while the tab stays loaded.
    await goOffline(page)
    await openSpotlight(page)
    await input(page).fill(resident.name)
    await expect(row(page, resident.id).first()).toBeVisible()
    await input(page).fill(off.name)
    await expect.poll(() => spotlightRequests.length).toBeGreaterThan(0)
    // The failed request settles into a notice; nothing beyond the store appears.
    await expect(page.getByTestId('spotlight-notice')).toBeVisible()
    await expect(row(page, off.id)).toHaveCount(0)

    // The server is back: the next query reaches it again.
    await goOnline(page)
    await input(page).fill(`${off.name} `)
    await expect(row(page, off.id).first()).toBeVisible()
    await expect(page.getByTestId('spotlight-notice')).toHaveCount(0)
  })

  test('does not ask the server while the browser is offline, and still searches the store', async ({ page }) => {
    await enterBootApp(page)
    const off = await pickOffWindowObject(page)
    const resident = await residentObject(page)
    const spotlightRequests: string[] = []
    page.on('request', (r) => { if (r.url().includes('/api/model/spotlight')) spotlightRequests.push(r.url()) })

    await page.context().setOffline(true)
    try {
      await openSpotlight(page)
      await input(page).fill(resident.name)
      await expect(row(page, resident.id).first()).toBeVisible()
      await input(page).fill(off.name)
      await expect(page.getByTestId('spotlight-notice')).toBeVisible()
      await expect(row(page, off.id)).toHaveCount(0)
      expect(spotlightRequests).toEqual([])
    } finally {
      await page.context().setOffline(false)
    }
  })
})
