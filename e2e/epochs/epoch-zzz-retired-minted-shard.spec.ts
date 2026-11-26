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
  addObjects, applyRetention, AUTH_ON, dumpHopTrace, enterApp, forceRoll, forwardPassesIdle, forwardUntil, hopProbe,
  newContext, objectsOnCurrentDiagram, publishedEpochNo, sleep, sql, takeUnexpectedNavigations, updateObject, waitSynced,
} from '../support/epochStack'

test.afterEach(() => {
  expect(takeUnexpectedNavigations()).toEqual([])
})

/**
 * G4-16f — AUTH ON, retention applied, the mint reserve WORKING
 * (`epoch-zz-retired-offline-shard.spec.ts` refuses it, so its shard has a
 * random id).
 * Marie, offline, adds objects: they fill shards she already holds, then a
 * NEW shard with a MINTED id, whose pointer is HELD (not written) until the
 * server acknowledges it. Rolls land, retention retires her epoch, she
 * reconnects with the tab open.
 *
 * Before the fix: the reconnect made the new shard durable during the hop,
 * its held pointer was written into the OLD meta — retired, forwarded by no
 * one — and its queue entry left; the swap carried the shard but decided
 * nothing about it (no `unminted` entry), so it was on her screen only, and
 * gone at her next reload (measured by hand: 2 088 objects before, 2 048
 * after).
 *
 * Now every object she created is checked ONE BY ONE: on her screen after a
 * reload, or a line of the retired export; and every one the server holds
 * (not exported) is seen by a browser with no local copy.
 */
const ROLLS = 4

test.describe('a MINTED shard created offline into an epoch retired since (AUTH on)', () => {
  test.skip(!AUTH_ON, 'minted ids need AUTH on')

  test('every object she created offline is on her screen after a reload or exported, and the server\'s are seen by a fresh browser', async ({ browser }) => {
    test.setTimeout(480_000)
    const ctxA = await newContext(browser, { acceptDownloads: true })
    const fresh = await newContext(browser)
    const a = await ctxA.newPage()
    try {
      await enterApp(a)
      // The minted supply warm: the new shard gets a minted id.
      await expect.poll(() => a.evaluate(() => (window as unknown as { __mintedIdSupply?: { available: () => number } }).__mintedIdSupply?.available() ?? 0),
        { timeout: 60_000 }).toBeGreaterThan(4)
      const [z] = await objectsOnCurrentDiagram(a, 1)
      const shardsBefore = (await hopProbe(a)).objectShards
      const heldMetaId = (await hopProbe(a)).bootedMetaUrl!.replace(/^automerge:/, '')
      const tag = Date.now().toString(36)
      await ctxA.setOffline(true)
      await updateObject(a, z!, { name: `Z-minted-${tag}` })
      const ids: string[] = []
      for (let round = 0; round < 160 && (await hopProbe(a)).objectShards.length === shardsBefore.length; round += 1) {
        ids.push(...await addObjects(a, 25, `mint-${tag}-${round}`))
        await sleep(120)
      }
      // A few more after the overflow, into the new shard.
      ids.push(...await addObjects(a, 25, `mint-${tag}-after`))
      const overflow = (await hopProbe(a)).objectShards.filter((s) => !shardsBefore.includes(s))
      expect(overflow.length).toBeGreaterThan(0)
      // Minted — a longer binary id than a random one's 16 bytes, and no
      // random-id (`unminted`) entry: the case this spec is for.
      const idBytes = await a.evaluate((shards) => shards.map((s) => (window as unknown as { __docIdInfo?: (url: string) => { bytes: number } }).__docIdInfo?.(`automerge:${s}`)?.bytes ?? null), overflow)
      expect(idBytes.every((b) => b !== null && b > 16)).toBe(true)
      console.log(`[o3on] objects=${ids.length} overflow=${JSON.stringify(overflow)} idBytes=${JSON.stringify(idBytes)}`)
      await sleep(2_000)
      let next = ''
      for (let r = 0; r < ROLLS; r += 1) {
        next = await forceRoll()
        await forwardPassesIdle()
      }
      applyRetention(3)
      expect(sql(`SELECT state FROM read_model_model_epoch_docs WHERE document_id = '${heldMetaId}'`)).toBe('retired')

      await ctxA.setOffline(false)
      await forwardUntil(async () => (await hopProbe(a)).bootedMetaUrl === next, 150_000)
      expect((await hopProbe(a)).state.phase).toBe('retired')
      await expect(a.getByTestId('epoch-retired-banner')).toBeVisible()
      const downloading = a.waitForEvent('download')
      await a.getByTestId('epoch-retired-export').click()
      const download = await downloading
      const chunks: Buffer[] = []
      for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
      const exported = new Set((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { differences: Array<{ id: string }> }).differences.map((d) => d.id))

      const storeIds = async () => new Set(await a.evaluate((prefix) => window.__modelStore!.getState().objects
        .filter((o) => String(o.name ?? '').startsWith(prefix)).map((o) => o.id), `mint-${tag}-`))
      const unaccounted = (have: Set<string>) => ids.filter((id) => !have.has(id) && !exported.has(id))
      expect(unaccounted(await storeIds())).toEqual([])
      // The carried shards reach the CURRENT meta, and are durable.
      await expect.poll(async () => {
        const p = await hopProbe(a)
        const listed = new Set((p.metaObjectShardUrls ?? []).map((u) => u.replace(/^automerge:/, '')))
        return overflow.filter((s) => p.objectShards.includes(s) && !listed.has(s))
      }, { timeout: 90_000, intervals: [1_000] }).toEqual([])
      await expect.poll(async () => (await hopProbe(a)).durablePending.filter((d) => overflow.includes(d)), { timeout: 90_000 }).toEqual([])
      await waitSynced(a)
      console.log(`[o3on] decisions=${JSON.stringify((await hopProbe(a) as unknown as { carriedDecisions?: string[] }).carriedDecisions)} exported=${exported.size} epoch=${publishedEpochNo()}`)

      // Her reload: each object on her screen, or exported.
      await a.reload()
      await a.getByTestId('diagram-name').waitFor({ timeout: 60_000 })
      await expect.poll(async () => unaccounted(await storeIds()).length, { timeout: 120_000, intervals: [1_000] }).toBe(0)

      // The server's: a browser with no local copy sees each one not exported.
      const held = ids.filter((id) => !exported.has(id))
      const p = await fresh.newPage()
      await enterApp(p)
      await expect.poll(async () => (await hopProbe(p)).bootedMetaUrl, { timeout: 60_000 }).toBe(next)
      await expect.poll(async () => {
        const have = new Set(await p.evaluate((prefix) => window.__modelStore!.getState().objects
          .filter((o) => String(o.name ?? '').startsWith(prefix)).map((o) => o.id), `mint-${tag}-`))
        return held.filter((id) => !have.has(id)).length
      }, { timeout: 150_000, intervals: [1_500] }).toBe(0)
      console.log(`[o3on] reload ok, fresh sees ${held.length}, exported ${exported.size} of ${ids.length}`)
    } finally {
      await dumpHopTrace(a, `o3on-${Date.now()}`)
      await ctxA.close()
      await fresh.close()
    }
  })
})
