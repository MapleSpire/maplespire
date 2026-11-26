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

import { expect, test, type Page } from '@playwright/test'
import {
  AUTH_ON, enterApp, forceRoll, forwardUntil, hopProbe, newContext, objectsOnCurrentDiagram, SECOND_USER_EMAIL, sleep, sql,
  takeUnexpectedNavigations, updateObject, waitSynced,
} from '../support/epochStack'

test.afterEach(() => {
  expect(takeUnexpectedNavigations()).toEqual([])
})

/**
 * G4-16f — Marie's rows on a SECOND device that never wrote (AUTH on: the
 * server lists a user's rows by the actors her devices recorded). Device 1 edits two fields offline; a roll; Paul (another
 * user) edits the same fields; device 1 reconnects and is offered the rows.
 * Device 2 — another browser profile of Marie, with no actor of its own —
 * asked nothing before the fix (an empty actor list asked nothing) and showed
 * no row, resident, reloaded or brand new. Now it asks with her session at
 * its boot, its hop and every refresh: the same rows, without writing; Paul
 * none. Its notice is up without any refresh asked by the test once it
 * boots after the rows exist (the reload, the new device).
 */
const rowsOf = async (page: Page, refresh = true) => page.evaluate(async (again) => {
  const p = (window as unknown as { __epochOverrides: { refresh(): Promise<void>; rows(): Array<{ id: string }> } }).__epochOverrides
  if (again) await p.refresh()
  return p.rows().map((r) => r.id).sort()
}, refresh)

test.describe('Marie\'s rows on a second device that never wrote (AUTH on)', () => {
  test.skip(!AUTH_ON, 'a user to join devices on needs AUTH on')

  test('device 2 — resident, reloaded, brand new — is offered device 1\'s rows without writing; Paul none', async ({ browser }) => {
    test.setTimeout(360_000)
    const c1 = await newContext(browser)
    const c2 = await newContext(browser)
    const cP = await newContext(browser, {}, SECOND_USER_EMAIL)
    const d1 = await c1.newPage()
    const d2 = await c2.newPage()
    const p = await cP.newPage()
    let c3: Awaited<ReturnType<typeof newContext>> | null = null
    const asked2: string[] = []
    d2.on('request', (r) => { if (/\/api\/model\/epoch-overrides\?/.test(r.url())) asked2.push(r.url()) })
    try {
      // This spec counts its own rows (as the re-apply spec does).
      sql(`UPDATE read_model_model_epoch_overrides SET state = 'dismissed' WHERE state = 'pending'`)
      await enterApp(d1)
      await enterApp(d2)
      await enterApp(p)
      const [o1, o2] = await objectsOnCurrentDiagram(d1, 2)
      const tag = Date.now().toString(36)
      await c1.setOffline(true)
      await updateObject(d1, o1!, { name: `O1-dev1-${tag}` })
      await updateObject(d1, o2!, { name: `O2-dev1-${tag}` })
      await sleep(1_000)
      const next = await forceRoll()
      await forwardUntil(async () => (await hopProbe(p)).bootedMetaUrl === next)
      await updateObject(p, o1!, { name: `O1-paul-${tag}` })
      await updateObject(p, o2!, { name: `O2-paul-${tag}` })
      await waitSynced(p)
      await c1.setOffline(false)
      await forwardUntil(async () => (await hopProbe(d1)).bootedMetaUrl === next && (await hopProbe(d2)).bootedMetaUrl === next
        && (await rowsOf(d1)).length >= 2, 240_000)
      const rows = await rowsOf(d1)
      // Device 2, resident, never wrote: no actor of its own, the same rows.
      expect(await d2.evaluate(() => (window as unknown as { __epochOverrides: { actorIds(): string[] } }).__epochOverrides.actorIds())).toEqual([])
      expect(await rowsOf(d2)).toEqual(rows)
      expect(asked2.length).toBeGreaterThan(0)
      // Reloaded: offered at its boot, no refresh asked by the test.
      await d2.reload()
      await d2.getByTestId('diagram-name').waitFor({ timeout: 60_000 })
      await expect.poll(() => rowsOf(d2, false), { timeout: 30_000 }).toEqual(rows)
      await expect(d2.getByTestId('epoch-overrides-notice')).toBeVisible()
      // A brand-new device of hers.
      c3 = await newContext(browser)
      const d3 = await c3.newPage()
      await enterApp(d3)
      await expect.poll(() => rowsOf(d3, false), { timeout: 30_000 }).toEqual(rows)
      // Paul, another user: none of hers.
      expect((await rowsOf(p)).filter((id) => rows.includes(id))).toEqual([])
      await expect(p.getByTestId('epoch-overrides-notice')).toHaveCount(0)
    } finally {
      await c1.close()
      await c2.close()
      await cP.close()
      await c3?.close()
    }
  })
})
