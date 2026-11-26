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
  applyRetention, dumpHopTrace, enterApp, forceRoll, hopProbe, latchStats, newContext, objectField, objectsOnCurrentDiagram,
  publishedEpochNo, sleep, sql, takeUnexpectedNavigations, updateObject, waitSynced,
} from '../support/epochStack'

test.afterEach(() => {
  expect(takeUnexpectedNavigations()).toEqual([])
})

/**
 * G4-16f — the hop on an AGED stack. A manual test found that after ~17
 * rolls (113 live superseded documents: retention never ran on a stack that
 * rolls every few seconds) a continuous writer never hopped: every
 * event-driven pass re-read and re-wrote the cursor of every live source
 * (~35 ms each), so a pass outgrew the 2 s latch, and a latch started while
 * the roll's own pass (S9) ran was bound to time out.
 *
 * Here the stack is aged by several rolls with RETENTION APPLIED (the
 * retention end state, staged in SQL like every retirement of this suite), then one tab
 * writes every 400 ms through the store (no pause) and a second tab is idle,
 * a roll lands, and BOTH must hop with ONE latch each — the server's own
 * event-driven forward only, no test-driven pass. Every write reaches the
 * other tab.
 */
const AGE_ROLLS = 6
const WRITE_EVERY_MS = 400

test.describe('the live epoch hop on an aged stack', () => {
  test('a writer that never pauses hops with ONE latch after many rolls, retention applied', async ({ browser }) => {
    test.setTimeout(360_000)
    // Signed in first (an `--auth` stack: the compaction route needs the admin).
    const ctxA = await newContext(browser)
    const ctxB = await newContext(browser)
    // Aging: rolls with no tab open, retention applied after each one.
    const startEpoch = publishedEpochNo()
    let live = 0
    for (let i = 0; i < AGE_ROLLS; i += 1) {
      await forceRoll()
      live = applyRetention()
    }
    expect(publishedEpochNo()).toBeGreaterThanOrEqual(startEpoch + AGE_ROLLS)
    const retired = Number(sql(`SELECT count(*) FROM read_model_model_epoch_docs WHERE state = 'retired' AND superseded_epoch IS NOT NULL`))
    console.log(`[aged] epoch=${publishedEpochNo()} liveSuperseded=${live} retired=${retired}`)
    expect(retired).toBeGreaterThan(0)

    const a = await ctxA.newPage()
    const b = await ctxB.newPage()
    const pageErrors: string[] = []
    a.on('pageerror', (error) => pageErrors.push(error.message))
    b.on('pageerror', (error) => pageErrors.push(error.message))
    try {
      await enterApp(a)
      await enterApp(b)
      const [typed] = await objectsOnCurrentDiagram(a, 1)
      expect(typed).toBeTruthy()
      const tag = Date.now().toString(36)
      let writing = true
      let n = 0
      let last = ''
      const writer = (async () => {
        while (writing) {
          last = `aged-${tag}-${n++}`
          await updateObject(a, typed!, { description: last }).catch(() => undefined)
          await sleep(WRITE_EVERY_MS)
        }
      })()
      await sleep(1_500)
      const next = await forceRoll()
      const hopped = (page: typeof a) => expect.poll(async () => (await hopProbe(page)).bootedMetaUrl, { timeout: 90_000, intervals: [250] })
        .toBe(next).then(() => true, () => false)
      const [writerHopped, idleHopped] = await Promise.all([hopped(a), hopped(b)])
      // Still writing after the swap: the new epoch takes the writes.
      const writesAtSwap = n
      await sleep(2_000)
      writing = false
      await writer
      const writerLatches = await latchStats(a)
      const idleLatches = await latchStats(b)
      console.log(`[aged-hop] writerHopped=${writerHopped} idleHopped=${idleHopped} writer=${JSON.stringify(writerLatches)} idle=${JSON.stringify(idleLatches)} writes=${n} atSwap=${writesAtSwap}`)
      expect(writerHopped).toBe(true)
      expect(idleHopped).toBe(true)
      expect(writerLatches.latchCount).toBe(1)
      expect(idleLatches.latchCount).toBe(1)
      expect(writerLatches.maxLatchMs).toBeLessThan(2_100)
      expect(n - writesAtSwap).toBeGreaterThanOrEqual(3)

      // Nothing lost: the last write is durable and reaches the idle tab.
      await waitSynced(a)
      expect(await objectField(a, typed!, 'description')).toBe(last)
      await expect.poll(() => objectField(b, typed!, 'description'), { timeout: 60_000 }).toBe(last)
      expect(pageErrors).toEqual([])
    } finally {
      await dumpHopTrace(a, `aged-writer-${Date.now()}`)
      await dumpHopTrace(b, `aged-idle-${Date.now()}`)
      await ctxA.close()
      await ctxB.close()
    }
  })
})
