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

import { expect, test, type Browser } from '@playwright/test'
import {
  addObjects, AUTH_ON, deferredQueue, enterApp, forceRoll, forgetLocalRoot, hopProbe, objectField, signIn, sleep, takeUnexpectedNavigations,
} from '../support/epochStack'

/**
 * G4-16f: an overflow model shard created OFFLINE, then a roll (or two) the
 * tab never saw, then a reload. Its objects were first found "lost", and
 * measured to be so for this reason: the server forwards the
 * old meta and adopts the shard, but the reloaded tab booted on the new meta
 * BEFORE that, and a resident tab loads model shards only at boot or a hop.
 * The fix journals the random-id pointer and writes it into the CURRENT meta
 * at the resume — so the author sees her objects AT BOOT (asserted within a
 * bound shorter than any of the reloads that made earlier runs pass), and a
 * FRESH browser (no local copy: the server's truth) sees them too.
 *
 *  - AUTH off: no id is minted (random ids);
 *  - AUTH on (`node scripts/e2e-epochs.mjs --auth`), the mint reserve EMPTY
 *    (the mint route refused): random ids where the server admits a document
 *    only through a pointer — the production shape;
 *  - two rolls between the offline creation and the reload.
 */

/** Seconds a tab may take to show its own held objects after boot: shorter
 * than the unexplained page reloads (+18 s) that once made these runs pass. */
const AT_BOOT_MS = 12_000

async function scenario(browser: Browser, options: { rolls: number; emptyMintReserve: boolean }): Promise<void> {
  const ctxA = await browser.newContext()
  const fresh = await browser.newContext()
  try {
    await signIn(ctxA)
    await signIn(fresh)
    if (options.emptyMintReserve) {
      // The reserve never fills: every document this browser creates gets a
      // random id (mintedIdSupply.ts falls back to `repo.create`).
      await ctxA.route('**/api/automerge/mint-document-ids', (route) =>
        route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'e2e: mint refused', retryable: true }) }))
    }
    const a = await ctxA.newPage()
    await enterApp(a)
    const shardsBefore = (await hopProbe(a)).objectShards
    const tag = Date.now().toString(36)
    await ctxA.setOffline(true)
    const ids: string[] = []
    // Up to 3000 objects: the earlier variants leave room in the shards they
    // filled (the fourth variant of a run found ~1000 free slots).
    for (let round = 0; round < 120 && (await hopProbe(a)).objectShards.length === shardsBefore.length; round += 1) {
      ids.push(...await addObjects(a, 25, `ovf-${tag}-${round}`))
      await sleep(200)
    }
    const overflow = (await hopProbe(a)).objectShards.filter((s) => !shardsBefore.includes(s))
    // Never past what the shards held
    // can carry — a store holding more objects than `MODEL_SHARD_SIZE` (512)
    // times the shards means the writes reached no document.
    const inStore = await a.evaluate(() => window.__modelStore!.getState().objects.length)
    expect(inStore, `${inStore} objects in the store for ${(await hopProbe(a)).objectShards.length} object shards`)
      .toBeLessThanOrEqual(512 * (await hopProbe(a)).objectShards.length)
    if (overflow.length === 0) {
      const state = await a.evaluate(() => ({
        objects: window.__modelStore?.getState().objects.length,
        status: (window as unknown as { __automergeStatus?: { getState(): { status: string } } }).__automergeStatus?.getState().status,
      }))
      console.log(`[b3c] NO overflow: added=${ids.length} shards=${shardsBefore.length} state=${JSON.stringify(state)} probe=${JSON.stringify(await hopProbe(a))}`.slice(0, 3000))
    }
    expect(overflow.length).toBeGreaterThan(0)
    const last = ids[ids.length - 1]!
    const lastName = await objectField(a, last, 'name')
    expect(lastName).not.toBeNull()
    await sleep(2_000) // persisted locally; then the page dies, still offline
    // The variant names the id path it tests. The
    // queue holds one entry per overflow shard: MINTED (no `unminted` flag)
    // with an active reserve on the AUTH-on stack, RANDOM otherwise (AUTH
    // off cannot mint; an empty reserve falls back to `repo.create`). A
    // reserve found empty at the creation would otherwise rerun the random
    // path silently.
    const held = (await deferredQueue(a)).filter((e) => overflow.some((id) => e.url === `automerge:${id}`))
    expect(held.length).toBeGreaterThan(0)
    const minted = AUTH_ON && !options.emptyMintReserve
    expect(held.map((e) => e.unminted === true)).toEqual(held.map(() => !minted))
    console.log(`[b3c] rolls=${options.rolls} mintEmpty=${options.emptyMintReserve} auth=${AUTH_ON} objects=${ids.length} overflow=${JSON.stringify(overflow)}`)
    await a.close()
    let next = ''
    for (let r = 0; r < options.rolls; r += 1) next = await forceRoll()
    await ctxA.setOffline(false)
    // The reload boots on the CURRENT epoch — the
    // path the fix is about (the pointer held on E(n−rolls), resumed into
    // E(n); with two rolls the lineage walk). Booted on the root this browser
    // cached, the objects would be visible trivially (the old meta lists
    // them) and the spec would test the hop instead.
    expect(await forgetLocalRoot(ctxA)).toBeGreaterThan(0)
    const a2 = await ctxA.newPage()
    const warnings: string[] = []
    a2.on('console', (message) => {
      if (/held|epoch|deferred|predecessor/i.test(message.text())) warnings.push(message.text().slice(0, 300))
    })
    await enterApp(a2)
    const bootedAt = Date.now()
    expect((await hopProbe(a2)).bootedMetaUrl).toBe(next)
    try {
      await expect.poll(() => objectField(a2, last, 'name'), { timeout: AT_BOOT_MS }).toBe(lastName)
    } catch (error) {
      const p = await hopProbe(a2)
      console.log(`[b3c] NOT visible at boot; predecessors=${JSON.stringify(p.predecessorMetas)} shards=${JSON.stringify(p.objectShards)} console=${JSON.stringify(warnings)}`)
      throw error
    }
    expect((await hopProbe(a2)).objectShards.some((s) => overflow.includes(s))).toBe(true)
    console.log(`[b3c] visible ${Date.now() - bootedAt} ms after a boot on the current epoch`)
    expect((await hopProbe(a2)).bootedMetaUrl).toBe(next)
    expect(await objectField(a2, last, 'name')).toBe(lastName)
    // EVERY object, one by one — not only the last.
    const missing = (page: typeof a2) => page.evaluate((wanted) => {
      const have = new Set(window.__modelStore!.getState().objects.map((o) => o.id))
      return wanted.filter((id) => !have.has(id))
    }, ids)
    await expect.poll(() => missing(a2), { timeout: AT_BOOT_MS }).toEqual([])
    // The SERVER's truth: a browser with no local copy boots on the current
    // epoch and sees the objects (the shard admitted, named by the meta).
    const p = await fresh.newPage()
    await enterApp(p)
    await expect.poll(async () => (await hopProbe(p)).bootedMetaUrl, { timeout: 60_000 }).toBe(next)
    await expect.poll(() => objectField(p, last, 'name'), { timeout: 120_000, intervals: [1_000] }).toBe(lastName)
    await expect.poll(() => missing(p), { timeout: 60_000, intervals: [1_000] }).toEqual([])
    // …and the author's held-pointer entries leave the QUEUE once the server
    // holds the shard (the queue itself is read, not the ledger).
    const queued = async () => (await deferredQueue(a2)).filter((e) => overflow.some((id) => e.url === `automerge:${id}`))
    await expect.poll(queued, { timeout: 60_000 }).toEqual([])
    await expect.poll(async () => (await hopProbe(a2)).durablePending.filter((d) => overflow.includes(d)), { timeout: 60_000 }).toEqual([])
  } finally {
    await ctxA.close()
    await fresh.close()
  }
}

test.describe('B3 variant (c): an overflow shard created offline survives the rolls', () => {
  test('AUTH off: one roll, then a reload — its objects are back at boot and on the server', async ({ browser }) => {
    test.skip(AUTH_ON, 'the AUTH-off stack')
    test.setTimeout(300_000)
    await scenario(browser, { rolls: 1, emptyMintReserve: false })
  })

  test('TWO rolls between the offline creation and the reload', async ({ browser }) => {
    test.skip(AUTH_ON, 'the AUTH-off stack')
    test.setTimeout(360_000)
    await scenario(browser, { rolls: 2, emptyMintReserve: false })
  })

  test('AUTH on, the mint reserve EMPTY: random ids admitted only through the pointer', async ({ browser }) => {
    test.skip(!AUTH_ON, 'needs `node scripts/e2e-epochs.mjs --auth`')
    test.setTimeout(360_000)
    await scenario(browser, { rolls: 1, emptyMintReserve: true })
  })

  test('AUTH on, the mint reserve EMPTY, TWO rolls', async ({ browser }) => {
    test.skip(!AUTH_ON, 'needs `node scripts/e2e-epochs.mjs --auth`')
    test.setTimeout(360_000)
    await scenario(browser, { rolls: 2, emptyMintReserve: true })
  })

  // The original defect's own scenario — MINTED ids, the pointer HELD on
  // E(n−2), a predecessor the tab never booted (E(n−1)): resumed after the
  // first render by the background walk.
  test('AUTH on, the mint ACTIVE, TWO rolls', async ({ browser }) => {
    test.skip(!AUTH_ON, 'needs `node scripts/e2e-epochs.mjs --auth`')
    test.setTimeout(360_000)
    await scenario(browser, { rolls: 2, emptyMintReserve: false })
  })
})

test.afterEach(() => {
  expect(takeUnexpectedNavigations()).toEqual([])
})
