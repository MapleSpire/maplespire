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
  deleteObject, dumpHopTrace, enterApp, forwardPassesIdle, forceRoll, forwardOnLatch, forwardUntil, hopProbe, latchStats, objectField, objectsOffCurrentDiagram, objectsOnCurrentDiagram,
  compact, makeRollDue, newContext, publishedEpochNo, publishedMetaUrl, retireSupersededBy, selectObject, serverForwarded, serverTrace, sleep, takeUnexpectedNavigations, updateObject, waitSynced,
} from '../support/epochStack'

// A document load the spec did not ask for fails it.
test.afterEach(() => {
  expect(takeUnexpectedNavigations()).toEqual([])
})

/**
 * G4-16f — the Marie scenario, end to end on a real stack with
 * `AM_MODEL_EPOCHS=on` (resident build). Tab A is Marie, tab B is Paul.
 */

async function objectsPageShows(page: Page, text: string): Promise<void> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-model-objects').click()
  await expect(page.locator('[data-testid^="mo-row-"]').first()).toBeVisible({ timeout: 30_000 })
  await page.getByPlaceholder(/search/i).first().fill(text)
  await expect(page.locator('[data-testid^="mo-row-"]').filter({ hasText: text }).first()).toBeVisible()
}

test.describe('the live epoch hop', () => {
  test('Marie keeps typing across the repoint, a second roll lands mid-hop, and after resync she sees her edits and Paul\'s', async ({ browser }) => {
    test.setTimeout(480_000)
    const ctxA = await newContext(browser)
    const ctxB = await newContext(browser)
    const a = await ctxA.newPage()
    const b = await ctxB.newPage()
    try {
      await enterApp(a)
      await enterApp(b)
      const [typed] = await objectsOnCurrentDiagram(a, 1)
      const [x, y, v, d] = await objectsOffCurrentDiagram(a, 4)
      expect([x, y, v, d, typed].every(Boolean)).toBe(true)
      const tag = Date.now().toString(36)
      // The name field caps at 120 characters and the stack is reused: start
      // the typed name short, durable, before anything else.
      await updateObject(a, typed!, { name: `T-${tag}-` })
      await waitSynced(a)

      // 1. Marie goes offline and edits: a field only she changes (X), a field
      //    Paul will change too (Y), and a delete (D).
      await ctxA.setOffline(true)
      await updateObject(a, x!, { description: `marie-x-${tag}` })
      await updateObject(a, y!, { name: `Y-marie-${tag}` })
      await deleteObject(a, d!)
      await sleep(800)

      // 2. A roll. Paul, online, follows it live, then edits Y and V.
      const e2 = await forceRoll()
      await forwardUntil(async () => (await hopProbe(b)).bootedMetaUrl === e2)
      await updateObject(b, y!, { name: `Y-paul-${tag}` })
      await updateObject(b, v!, { name: `V-paul-${tag}` })
      await waitSynced(b)

      // 3. Marie comes back online WITHOUT reload and keeps typing in the
      //    inspector. Her durable-heads answers are delayed, so the hop is
      //    still running when a SECOND roll lands.
      let delay = true
      await a.route('**/api/automerge/durable-heads**', async (route) => {
        if (delay) await sleep(1_500)
        await route.continue().catch(() => undefined) // unrouted while it slept
      })
      await selectObject(a, typed!)
      const field = a.getByTestId('object-name')
      await expect(field).toBeVisible()
      await field.click()
      await field.press('End')
      const accepted: string[] = []
      await ctxA.setOffline(false)

      let typing = true
      let i = 0
      const typeUntilStopped = async () => {
        while (typing) {
          // Under the 120-character cap: wrap around by erasing a run.
          const length = (await field.inputValue().catch(() => '')).length
          if (length >= 100) await a.keyboard.press('Backspace').catch(() => undefined)
          else await a.keyboard.type(String.fromCharCode(97 + (i % 26)), { delay: 0 }).catch(() => undefined)
          i += 1
          const value = await field.inputValue().catch(() => null)
          if (value !== null && (accepted.length === 0 || value !== accepted[accepted.length - 1])) accepted.push(value)
          // The overlay takes focus away during the latch: take it back after.
          if (!(await field.evaluate((el) => el === document.activeElement).catch(() => true))) {
            await field.click().catch(() => undefined)
            await field.press('End').catch(() => undefined)
          }
          await sleep(60)
        }
      }
      let typist = typeUntilStopped()

      await expect.poll(async () => (await hopProbe(a)).state.phase, { timeout: 60_000 }).not.toBe('idle')
      const e3 = await forceRoll()
      expect(e3).not.toBe(e2)
      delay = false
      // A continuous typist's latch converges only when a forwarding pass
      // lands inside its 2 s. The server's own event-driven forward does that
      // (proven alone by the next test); here, with the second roll and the
      // delayed answers, the test adds passes the moment a latch goes up. A
      // pass sometimes outlasts the 2 s; the tab then lifts, stays on the old
      // epoch, still forwarded, and backs off — by design. After 90 s of
      // that, Marie PAUSES and the hop must converge on her next latch.
      const convergedWhileTyping = await forwardOnLatch(a, async () => (await hopProbe(a)).bootedMetaUrl === e3, 90_000)
        .then(() => true, () => false)
      if (!convergedWhileTyping) {
        typing = false
        await typist
        await forwardOnLatch(a, async () => (await hopProbe(a)).bootedMetaUrl === e3, 120_000)
        await selectObject(a, typed!)
        await field.click()
        await field.press('End')
        typing = true
        typist = typeUntilStopped()
      }
      const acceptedBeforeSwap = accepted.length
      await sleep(1_500) // typing continues AFTER the latch, on the new epoch
      typing = false
      await typist
      await forwardUntil(async () => (await hopProbe(a)).bootedMetaUrl === e3, 30_000)
      await waitSynced(a)

      // Bounded: every latch is at most 2 s plus the swap (one `projectAll`,
      // allowed 1 s here).
      const latches = await latchStats(a)
      console.log(`[marie] convergedWhileTyping=${convergedWhileTyping} latches=${latches.latchCount} maxLatchMs=${latches.maxLatchMs} keystrokes accepted=${accepted.length}`)
      // She really typed, before AND after the swap (each accepted keystroke
      // changed the field; the last value is asserted below).
      expect(acceptedBeforeSwap).toBeGreaterThanOrEqual(10)
      expect(accepted.length - acceptedBeforeSwap).toBeGreaterThanOrEqual(5)
      expect(latches.latchCount).toBeGreaterThanOrEqual(1)
      expect(latches.latchCount).toBeLessThanOrEqual(8)
      expect(latches.maxLatchMs).toBeLessThan(3_000)

      // 4. Marie's tab: every accepted keystroke, her non-conflicting edit,
      //    Paul's two (his Y beats hers), her delete.
      const last = accepted[accepted.length - 1]!
      await forwardUntil(async () => (await objectField(b, typed!, 'name')) === last, 60_000)
      expect(await objectField(a, typed!, 'name')).toBe(last)
      await expect.poll(() => objectField(a, x!, 'description')).toBe(`marie-x-${tag}`)
      await expect.poll(() => objectField(a, y!, 'name')).toBe(`Y-paul-${tag}`)
      await expect.poll(() => objectField(a, v!, 'name')).toBe(`V-paul-${tag}`)
      await expect.poll(() => objectField(a, d!, 'name')).toBeNull()
      // …and Paul's: Marie's forwarded edits.
      await expect.poll(() => objectField(b, x!, 'description')).toBe(`marie-x-${tag}`)
      await expect.poll(() => objectField(b, d!, 'name')).toBeNull()
      // The old documents are released once forwarded — not before.
      await forwardUntil(async () => (await hopProbe(a)).retainedSets === 0, 60_000)

      // 5. Reload Marie: the same state, from the new epoch.
      await a.unroute('**/api/automerge/durable-heads**')
      await a.reload()
      await expect(a.getByTestId('diagram-name')).toBeVisible({ timeout: 60_000 })
      await expect.poll(async () => (await hopProbe(a)).bootedMetaUrl, { timeout: 60_000 }).toBe(e3)
      await expect.poll(() => objectField(a, typed!, 'name')).toBe(last)
      await expect.poll(() => objectField(a, x!, 'description')).toBe(`marie-x-${tag}`)
      await expect.poll(() => objectField(a, y!, 'name')).toBe(`Y-paul-${tag}`)
      await objectsPageShows(a, `V-paul-${tag}`)
    } finally {
      await dumpHopTrace(a, `marie-${Date.now()}`)
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('Marie types WITHOUT pause and the hop converges on the server\'s own event-driven forward', async ({ browser }) => {
    test.setTimeout(300_000)
    const ctxA = await newContext(browser)
    const ctxB = await newContext(browser)
    const a = await ctxA.newPage()
    const b = await ctxB.newPage()
    const pageErrors: string[] = []
    a.on('pageerror', (error) => pageErrors.push(error.message))
    try {
      await enterApp(a)
      // The epoch capability: a tab booted BEFORE the first roll
      // (a fresh stack runs this test alone) has none — the workspace has no
      // epoch row yet — and must learn it from an acknowledgement once the
      // roll lands; the boot probe must never leak a rejection.
      const bootedBeforeFirstRoll = (await hopProbe(a)).epochCapabilityFrom === null
      if (bootedBeforeFirstRoll) expect((await hopProbe(a)).epochCapability).toBe(false)
      await enterApp(b)
      const [typed] = await objectsOnCurrentDiagram(a, 1)
      const [x] = await objectsOffCurrentDiagram(a, 1)
      const tag = Date.now().toString(36)
      await updateObject(a, typed!, { name: `C-${tag}-` })
      await waitSynced(a)

      // Marie offline edits X; a roll; Paul follows it.
      await ctxA.setOffline(true)
      await updateObject(a, x!, { description: `cont-x-${tag}` })
      await sleep(800)
      const next = await forceRoll()
      await forwardUntil(async () => (await hopProbe(b)).bootedMetaUrl === next)

      // Marie back online, typing continuously. From here on the TEST runs no
      // compaction pass: the only forwarding is the server's own, triggered by
      // her latch's acknowledgement request (and by the roll, S9).
      await selectObject(a, typed!)
      const field = a.getByTestId('object-name')
      await expect(field).toBeVisible()
      await field.click()
      await field.press('End')
      await ctxA.setOffline(false)
      const accepted: string[] = []
      let typing = true
      let i = 0
      let longestPauseMs = 0
      let lastKeyAt = Date.now()
      const typist = (async () => {
        while (typing) {
          const length = (await field.inputValue().catch(() => '')).length
          if (length >= 100) await a.keyboard.press('Backspace').catch(() => undefined)
          else await a.keyboard.type(String.fromCharCode(97 + (i % 26)), { delay: 0 }).catch(() => undefined)
          i += 1
          const now = Date.now()
          longestPauseMs = Math.max(longestPauseMs, now - lastKeyAt)
          lastKeyAt = now
          const value = await field.inputValue().catch(() => null)
          if (value !== null && (accepted.length === 0 || value !== accepted[accepted.length - 1])) accepted.push(value)
          if (!(await field.evaluate((el) => el === document.activeElement).catch(() => true))) {
            await field.click().catch(() => undefined)
            await field.press('End').catch(() => undefined)
          }
          await sleep(60)
        }
      })()
      const convergedWhileTyping = await expect.poll(async () => (await hopProbe(a)).bootedMetaUrl, { timeout: 120_000, intervals: [250] })
        .toBe(next).then(() => true, () => false)
      const acceptedBeforeSwap = accepted.length
      await sleep(1_500)
      typing = false
      await typist
      const latches = await latchStats(a)
      console.log(`[marie-continuous] convergedWhileTyping=${convergedWhileTyping} latches=${latches.latchCount} maxLatchMs=${latches.maxLatchMs} accepted=${accepted.length} longestPauseMs=${longestPauseMs}`)
      const capability = await hopProbe(a)
      console.log(`[capability] bootedBeforeFirstRoll=${bootedBeforeFirstRoll} from=${capability.epochCapabilityFrom}`)
      expect(capability.epochCapability).toBe(true)
      if (bootedBeforeFirstRoll) expect(capability.epochCapabilityFrom).toBe('ack')
      expect(convergedWhileTyping).toBe(true)
      expect(acceptedBeforeSwap).toBeGreaterThanOrEqual(10)
      expect(accepted.length - acceptedBeforeSwap).toBeGreaterThanOrEqual(5)
      expect(latches.maxLatchMs).toBeLessThan(3_000)
      // The latch's own ask starts the pass at once (no
      // rest): one latch converges, two at most.
      expect(latches.latchCount).toBeLessThanOrEqual(2)

      // Every accepted keystroke and her offline edit reach Paul — still with
      // no test-driven pass.
      const last = accepted[accepted.length - 1]!
      await waitSynced(a)
      expect(await objectField(a, typed!, 'name')).toBe(last)
      await expect.poll(() => objectField(b, typed!, 'name'), { timeout: 60_000 }).toBe(last)
      await expect.poll(() => objectField(b, x!, 'description'), { timeout: 60_000 }).toBe(`cont-x-${tag}`)
      expect(pageErrors).toEqual([])
    } finally {
      await dumpHopTrace(a, `continuous-${Date.now()}`)
      await dumpHopTrace(b, `continuous-paul-${Date.now()}`)
      const paul = await hopProbe(b).catch(() => null)
      console.log(`[paul] booted=${paul?.bootedMetaUrl} capability=${paul?.epochCapability} from=${paul?.epochCapabilityFrom} state=${JSON.stringify(paul?.state)}`)
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('a write that bypasses the input block (code, not keys) DURING the latch is not lost by the swap', async ({ browser }) => {
    const ctxA = await newContext(browser)
    const ctxB = await newContext(browser)
    const a = await ctxA.newPage()
    const b = await ctxB.newPage()
    try {
      await enterApp(a)
      await enterApp(b)
      const [w] = await objectsOnCurrentDiagram(a, 1)
      const tag = Date.now().toString(36)
      // Deterministic: A's acknowledgements are HELD (the hop waits in its
      // drain) until forwarding passes have moved the superseded documents'
      // cursors past the roll's own changes, then each answers after 1 s — so
      // A's FIRST latch is acknowledged and SWAPS, and the second of its ask
      // leaves time to write inside it, after its flush: deferred to the swap.
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      await a.route('**/api/automerge/durable-heads**', async (route) => {
        await gate
        await sleep(1_000)
        await route.continue().catch(() => undefined)
      })
      await ctxA.setOffline(true)
      const next = await forceRoll()
      await ctxA.setOffline(false)
      await expect.poll(async () => (await hopProbe(a)).state.phase, { timeout: 60_000 }).toBe('draining')
      // Passes until the SERVER says A's held documents, at their current
      // heads, are durable and forwarded (a reconnect may write them).
      await forwardUntil(async () => serverForwarded((await hopProbe(a)).heldHeads), 90_000)
      release()
      // One write inside EVERY latch until one swaps (a reconnect can still
      // move the old documents, and that latch then times out): the value of
      // the latch that swapped is the last one, and it must survive.
      const latched = () => a.evaluate(() =>
        (window as unknown as { __epochHopStore: { getState(): { latched: boolean } } }).__epochHopStore.getState().latched)
      let value = ''
      for (let attempt = 0; attempt < 4 && (await hopProbe(a)).bootedMetaUrl !== next; attempt += 1) {
        await expect.poll(latched, { timeout: 90_000, intervals: [25] }).toBe(true)
        value = `during-latch-${tag}-${attempt}`
        await updateObject(a, w!, { description: value })
        await expect.poll(latched, { timeout: 10_000, intervals: [25] }).toBe(false)
        if ((await hopProbe(a)).bootedMetaUrl !== next) await forwardUntil(async () => serverForwarded((await hopProbe(a)).heldHeads), 90_000)
      }
      const swapped = await hopProbe(a)
      console.log(`[latch-write] deferred=${swapped.writesDeferredByLatch} atSwap=${swapped.deferredWritesAtSwap} latches=${JSON.stringify(await latchStats(a))}`)
      // The precondition this test exists for: the last write WAS held by
      // the latch that swapped (else it proves nothing about the swap).
      expect(swapped.bootedMetaUrl).toBe(next)
      expect(swapped.deferredWritesAtSwap).toBe(1)
      // The old documents the write went to are RETAINED and still syncing
      // (a hop that released them early fails here): every one of them holds the `epoch-retained` pin until
      // the server says it is forwarded.
      expect(swapped.retainedSets).toBeGreaterThan(0)
      expect(swapped.retainedPins).toBe(new Set(swapped.retainedDocuments).size)
      await a.unroute('**/api/automerge/durable-heads**')
      // The write landed in the OLD documents (retained, still syncing) and
      // reaches the new epoch by forwarding: both tabs end on the new epoch
      // with it, and A's retained set is released only after that.
      await forwardUntil(async () => (await hopProbe(b)).bootedMetaUrl === next
        && (await objectField(a, w!, 'description')) === value
        && (await objectField(b, w!, 'description')) === value
        && (await hopProbe(a)).retainedSets === 0, 120_000)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('the held epoch is RETIRED: the banner offers the unsynced edits as an export, the tab keeps working', async ({ browser }) => {
    const ctxA = await newContext(browser, { acceptDownloads: true })
    const a = await ctxA.newPage()
    try {
      await enterApp(a)
      const [z] = await objectsOnCurrentDiagram(a, 1)
      const tag = Date.now().toString(36)
      const heldEpoch = publishedEpochNo()
      await ctxA.setOffline(true)
      await updateObject(a, z!, { name: `Z-offline-${tag}` })
      await sleep(800)
      const next = await forceRoll()
      // A TEST ARTIFACT, not a product race: the retirement below is staged
      // by a bare SQL UPDATE. In the product, retirement runs inside the
      // sweep, under the overlay-rotation keys and the `model-epoch:` lock,
      // after the forwarder released them — it can never interleave a pass.
      // The roll's own pass (S9) loads its sources ONCE, as `live`; retiring
      // them by SQL while it runs would let it forward Marie's edit when she
      // reconnects (seen once: the banner then had nothing to export). So
      // the SQL waits for that pass to end, as the lock would make it wait.
      await forwardPassesIdle()
      // The epoch Marie holds is past retention by the time she reconnects.
      expect(retireSupersededBy(publishedEpochNo())).toBeGreaterThan(0)
      expect(publishedEpochNo()).toBeGreaterThan(heldEpoch)
      await ctxA.setOffline(false)
      await forwardUntil(async () => (await hopProbe(a)).bootedMetaUrl === next)
      const banner = a.getByTestId('epoch-retired-banner')
      await expect(banner).toBeVisible()
      const downloading = a.waitForEvent('download')
      await a.getByTestId('epoch-retired-export').click()
      const download = await downloading
      const chunks: Buffer[] = []
      for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
      const exported = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { metaUrl: string; differences: Array<{ id: string; local: { name?: string } }> }
      expect(exported.metaUrl).toBe(next)
      expect(exported.differences.find((dd) => dd.id === z)?.local.name).toBe(`Z-offline-${tag}`)
      // No lost tab state: the tab is on the new epoch, the badge settles, it still edits.
      await updateObject(a, z!, { description: `after-${tag}` })
      await waitSynced(a)
      expect(await objectField(a, z!, 'description')).toBe(`after-${tag}`)
    } finally {
      await ctxA.close()
    }
  })

  test('a hop DURING a LONG compaction: the latch is refused the pool-heavy slot while it is held, S9 is re-planned, the hop converges and nothing is lost', async ({ browser }) => {
    test.setTimeout(300_000)
    // F1 (`compactToSnapshot`) holds the slot up to ~4.8 s in production; the
    // e2e workspace compacts in well under a second, so the stack's knob
    // (MODEL_EPOCH_E2E_COMPACTION_HOLD) makes ONE pass hold it that long after
    // its work, then hands it at the release to one more pool-heavy holder
    // for longer than S9 waits (30 s) — the case S9's re-planning exists for.
    const HOLD_MS = 4_800
    const AFTER_MS = 33_000
    const ctxA = await newContext(browser)
    const ctxB = await newContext(browser)
    const a = await ctxA.newPage()
    const b = await ctxB.newPage()
    let compaction: Promise<unknown> = Promise.resolve()
    try {
      await enterApp(a)
      await enterApp(b)
      const [x] = await objectsOffCurrentDiagram(a, 1)
      const tag = Date.now().toString(36)
      await forwardPassesIdle()
      // Marie edits offline.
      await ctxA.setOffline(true)
      await updateObject(a, x!, { description: `compaction-x-${tag}` })
      await sleep(800)
      // THE LONG COMPACTION, which rolls: Marie reconnects the moment the new
      // epoch is published, while the pass still holds the slot — her hop's
      // latches ask for a forward pass the slot cannot give.
      const t0 = Date.now()
      const before = publishedMetaUrl()
      makeRollDue()
      compaction = compact({ holdMs: HOLD_MS, afterMs: AFTER_MS })
      // The new epoch's meta, once published (a first roll also publishes
      // the legacy epoch on its way: wait for the non-legacy one).
      await expect.poll(() => publishedMetaUrl(), { timeout: 30_000, intervals: [100] }).not.toMatch(new RegExp(`^(${before})?$`))
      const next = publishedMetaUrl()
      await ctxA.setOffline(false)
      await compaction
      await expect.poll(async () => (await hopProbe(a)).bootedMetaUrl, { timeout: 150_000, intervals: [250] }).toBe(next)
      const hoppedAt = Date.now()
      await forwardPassesIdle()

      // THE SERVER TRACE says what happened, in order.
      const trace = serverTrace(t0)
      const at = (event: string, where: (e: (typeof trace)[number]) => boolean = () => true) => trace.find((e) => e.event === event && where(e))
      const hold = at('e2e.compaction_hold', (e) => e.holdMs === HOLD_MS)
      const compactionAcquired = trace.filter((e) => e.event === 'compaction.slot_acquired' && e.t <= (hold?.t ?? 0)).at(-1)
      const compactionReleased = at('compaction.slot_released', (e) => e.t >= (hold?.t ?? Infinity))
      const afterAcquired = at('e2e.after_hold_acquired')
      const afterReleased = at('e2e.after_hold_released')
      expect(hold && compactionAcquired && compactionReleased && afterAcquired && afterReleased).toBeTruthy()
      expect(compactionReleased!.heldMs as number).toBeGreaterThanOrEqual(HOLD_MS)
      const slotHeldUntil = afterReleased!.t
      // While the LONG COMPACTION itself held the slot, the tab's forward
      // requests were refused (`busy`, never acquired, nothing counted)…
      const passEnds = trace.filter((e) => e.event === 'forward_trigger.pass_end')
      const refusedDuringCompaction = passEnds.filter((e) => e.busy === true && e.acquired === false
        && e.t >= compactionAcquired!.t && e.t <= compactionReleased!.t)
      expect(refusedDuringCompaction.length, 'a triggered pass refused while the long compaction held the slot').toBeGreaterThanOrEqual(1)
      // …and a LATCH's pass was refused while the slot was held (by the
      // compaction or the holder it handed it to): it waited ~1 s, as a waiter.
      const latchEnds = passEnds.filter((e) => e.priority === true)
      const refusedLatch = latchEnds.find((e) => e.busy === true && e.acquired === false && e.t >= compactionAcquired!.t && e.t <= slotHeldUntil)
      expect(refusedLatch, 'a latch refused the slot while it was held').toBeTruthy()
      expect(refusedLatch!.waitedMs as number).toBeGreaterThanOrEqual(900)
      // S9: requested at the release, waited its 30 s behind the next holder,
      // refused, RE-PLANNED, then got the slot.
      const s9Requested = at('forward_trigger.s9_requested', (e) => e.t >= compactionAcquired!.t)
      const s9Refused = at('forward_trigger.pass_end', (e) => e.reset === true && e.busy === true && e.acquired === false && e.t >= (s9Requested?.t ?? Infinity))
      const replanned = at('forward_trigger.reset_replanned', (e) => e.t >= (s9Refused?.t ?? Infinity))
      const s9Ran = at('forward_trigger.pass_acquired', (e) => e.reset === true && e.t >= (replanned?.t ?? Infinity))
      expect(s9Requested && s9Refused && replanned && s9Ran, 'S9 requested, refused, re-planned, then run').toBeTruthy()
      expect(s9Refused!.waitedMs as number).toBeGreaterThanOrEqual(29_000)
      // The hop converged on a pass that GOT the slot after it was freed and
      // before the swap (asserted, not only logged). In every measured run it
      // was the re-planned S9 that forwarded
      // her edit — the next latch then found nothing pending and needed no
      // pass — so either is accepted, and which one is logged.
      const latchRan = at('forward_trigger.pass_acquired', (e) => e.priority === true && e.t >= slotHeldUntil)
      const convergedBy = [latchRan, s9Ran].filter((e) => e && e.t >= slotHeldUntil && e.t <= hoppedAt)
      expect(convergedBy.length, 'a latch or the re-planned S9 got the slot after its release, before the hop').toBeGreaterThanOrEqual(1)
      // No pass that waited behind the compaction lost its write fence.
      const fenceLost = trace.filter((e) => e.event === 'forward_trigger.pass_failed' && String(e.error ?? '').includes('write fence lost'))
      expect(fenceLost).toEqual([])
      const latches = await latchStats(a)
      console.log(`[hop-during-long-compaction] ${JSON.stringify({
        compactionHeldMs: compactionReleased!.heldMs, injectedHoldMs: HOLD_MS, compactionReleasedAtMs: compactionReleased!.t - t0, afterHoldMs: AFTER_MS,
        refusedDuringCompaction: refusedDuringCompaction.map((e) => ({ atMs: e.t - t0, priority: e.priority, reset: e.reset, waitedMs: e.waitedMs })),
        latchPasses: latchEnds.length, latchBusy: latchEnds.filter((e) => e.busy === true).length,
        firstRefusedLatch: { atMs: refusedLatch!.t - t0, waitedMs: refusedLatch!.waitedMs },
        s9: { requestedAtMs: s9Requested!.t - t0, refusedAfterWaitMs: s9Refused!.waitedMs, replannedAttempt: replanned!.attempt, acquiredAtMs: s9Ran!.t - t0, waitedMs: s9Ran!.waitedMs },
        latchAcquiredAfterRelease: latchRan ? { atMs: latchRan.t - t0, waitedMs: latchRan.waitedMs } : null,
        slotFreeAtMs: slotHeldUntil - t0, hopAtMs: hoppedAt - t0, clientLatches: latches,
      })}`)
      expect(latches.latchCount).toBeGreaterThanOrEqual(1)
      expect(hoppedAt).toBeGreaterThan(slotHeldUntil) // nothing could forward before

      // Her offline edit reached the new epoch, for her and for Paul; the old
      // documents are released once forwarded.
      await waitSynced(a)
      await expect.poll(() => objectField(a, x!, 'description'), { timeout: 60_000 }).toBe(`compaction-x-${tag}`)
      await expect.poll(() => objectField(b, x!, 'description'), { timeout: 60_000 }).toBe(`compaction-x-${tag}`)
      await forwardUntil(async () => (await hopProbe(a)).retainedSets === 0, 60_000)
      // And the tab still writes on the new epoch.
      await updateObject(a, x!, { name: `after-compaction-${tag}` })
      await waitSynced(a)
      await expect.poll(() => objectField(b, x!, 'name'), { timeout: 60_000 }).toBe(`after-compaction-${tag}`)
    } finally {
      await compaction.catch(() => undefined)
      await dumpHopTrace(a, `compaction-${Date.now()}`)
      await ctxA.close()
      await ctxB.close()
    }
  })

  // The overflow-shard variant — the shard created offline — is its own spec
  // (`epoch-reload-offline-overflow.spec.ts`, which runs LAST: it adds over a
  // thousand objects and three rolls, which slow every later pass), with its
  // AUTH-on and two-roll variants.
})
