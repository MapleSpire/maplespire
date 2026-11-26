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

import { expect, test } from '@playwright/test'
import {
  addObjects, dumpHopTrace, enterApp, forceRoll, forwardPassesIdle, forwardUntil, hopProbe,
  newContext, objectsOnCurrentDiagram, sleep, sql, stageRetiring, takeUnexpectedNavigations, updateObject,
} from '../support/epochStack'

test.afterEach(() => {
  expect(takeUnexpectedNavigations()).toEqual([])
})

/**
 * G4-16f — the epoch Marie holds is moved to `retiring` (the retirement
 * walk's step 1, GC not run yet) between the rolls and her reconnect: a periodic sweep passed. Her offline edits reach
 * those documents past their forward cursor. Before the fix the durable-heads
 * route answered them `forwarded: false` with no pass to wait for (nothing
 * forwards a `retiring` document until the next periodic walk revives it):
 * the hop stayed in backoff (240 s by hand, no banner) and after her reload
 * the tab booted on the current epoch, her 1 225 objects in none of its
 * documents, nor a fresh browser's.
 *
 * Now the route asks the pass it triggers to revive them (back to `live`),
 * the pass forwards them, the hop settles, and EVERY object she created is
 * checked one by one: on her screen after a reload, and on a fresh browser.
 */
const ROLLS = 4

test.describe('the held epoch moved to `retiring` before the reconnect', () => {
  test('the hop settles, and every object she created offline is on her screen after a reload and on a fresh browser', async ({ browser }) => {
    test.setTimeout(480_000)
    const ctxA = await newContext(browser)
    const fresh = await newContext(browser)
    const a = await ctxA.newPage()
    try {
      await enterApp(a)
      const [z] = await objectsOnCurrentDiagram(a, 1)
      const tag = Date.now().toString(36)
      await ctxA.setOffline(true)
      await updateObject(a, z!, { name: `Z-retiring-${tag}` })
      const ids: string[] = []
      for (let round = 0; round < 12; round += 1) {
        ids.push(...await addObjects(a, 25, `ring-${tag}-${round}`))
        await sleep(120)
      }
      await sleep(2_000)
      let next = ''
      for (let r = 0; r < ROLLS; r += 1) {
        next = await forceRoll()
        await forwardPassesIdle()
      }
      const staged = stageRetiring(3)
      const held = (await hopProbe(a)).bootedMetaUrl!.replace(/^automerge:/, '')
      expect(sql(`SELECT state FROM read_model_model_epoch_docs WHERE document_id = '${held}'`)).toBe('retiring')
      console.log(`[ring] objects=${ids.length} staged=${staged}`)

      await ctxA.setOffline(false)
      const reconnectedAt = Date.now()
      await forwardUntil(async () => (await hopProbe(a)).bootedMetaUrl === next, 120_000)
      console.log(`[ring] hopped ${Date.now() - reconnectedAt} ms after the reconnect, phase=${(await hopProbe(a)).state.phase}`)
      // Forwarded, not retired: nothing to export.
      expect((await hopProbe(a)).state.phase).toBe('idle')
      // The documents she wrote are sources again (revived), the rest stay retiring.
      console.log(`[ring] revived=${sql(`SELECT count(*) FROM read_model_model_epoch_docs WHERE state = 'live' AND superseded_epoch IS NOT NULL AND superseded_epoch <= (SELECT max(epoch_no) FROM read_model_model_epochs WHERE state = 'published') - 3`)}`)

      const missing = (page: typeof a) => page.evaluate(([wanted, zId, zName]) => {
        const objects = window.__modelStore!.getState().objects
        const have = new Set(objects.map((o) => o.id))
        const lost = (wanted as string[]).filter((id) => !have.has(id))
        if (objects.find((o) => o.id === zId)?.name !== zName) lost.push(`${zId}:name`)
        return lost
      }, [ids, z!, `Z-retiring-${tag}`] as const)
      expect(await missing(a)).toEqual([])
      await a.reload()
      await a.getByTestId('diagram-name').waitFor({ timeout: 60_000 })
      await expect.poll(() => missing(a), { timeout: 120_000, intervals: [1_000] }).toEqual([])
      const p = await fresh.newPage()
      await enterApp(p)
      await expect.poll(async () => (await hopProbe(p)).bootedMetaUrl, { timeout: 60_000 }).toBe(next)
      await expect.poll(() => missing(p), { timeout: 150_000, intervals: [1_500] }).toEqual([])
      console.log(`[ring] reload ok, fresh sees all ${ids.length} and Z's name`)
    } finally {
      await dumpHopTrace(a, `ring-${Date.now()}`)
      await ctxA.close()
      await fresh.close()
    }
  })
})
