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
  addObjects, applyRetention, AUTH_ON, deferredQueue, dumpHopTrace, enterApp, forceRoll, forwardPassesIdle, forwardUntil, hopProbe,
  newContext, objectField, objectsOnCurrentDiagram, publishedEpochNo, sleep, sql, takeUnexpectedNavigations, updateObject, waitSynced,
} from '../support/epochStack'

test.afterEach(() => {
  expect(takeUnexpectedNavigations()).toEqual([])
})

/**
 * G4-16f — a shard created offline into an epoch retired since, WITHOUT any
 * staging of the shard. Marie's tab, offline, edits an object and creates a model shard (random id: AUTH
 * off, or AUTH on with the mint reserve empty), whose pointer is written at
 * once into the meta she holds. Four rolls land meanwhile and retention
 * retires her epoch. She reconnects, the tab still open.
 *
 * Before the fix the hop waited for every document of the old meta to be
 * durable; the new shard is named only by a RETIRED meta, nothing forwards
 * that pointer, the server never claims the shard, and the hop stayed in
 * backoff for minutes with no banner. Now: the hop swaps on the retired
 * path, the banner offers her edit to the retired base shard as an export,
 * the new shard stays on her screen, its pointer goes into the current meta
 * — a browser with no local copy sees its objects — and its queue entry
 * leaves once the server holds it.
 */
const ROLLS = 4

async function scenario(browser: Browser): Promise<void> {
  const ctxA = await newContext(browser, { acceptDownloads: true })
  const fresh = await newContext(browser)
  if (AUTH_ON) {
    // The reserve never fills: the new shard gets a random id, admitted by
    // the server only through a pointer (the production shape of this case).
    await ctxA.route('**/api/automerge/mint-document-ids', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'e2e: mint refused', retryable: true }) }))
  }
  const a = await ctxA.newPage()
  const pageErrors: string[] = []
  a.on('pageerror', (error) => pageErrors.push(error.message))
  try {
    await enterApp(a)
    const [z] = await objectsOnCurrentDiagram(a, 1)
    expect(z).toBeTruthy()
    const shardsBefore = (await hopProbe(a)).objectShards
    const heldEpoch = publishedEpochNo()
    const heldMetaUrl = (await hopProbe(a)).bootedMetaUrl!
    const tag = Date.now().toString(36)
    await ctxA.setOffline(true)
    await updateObject(a, z!, { name: `Z-offline-${tag}` })
    const ids: string[] = []
    for (let round = 0; round < 120 && (await hopProbe(a)).objectShards.length === shardsBefore.length; round += 1) {
      ids.push(...await addObjects(a, 25, `o3-${tag}-${round}`))
      await sleep(150)
    }
    const overflow = (await hopProbe(a)).objectShards.filter((s) => !shardsBefore.includes(s))
    expect(overflow.length).toBeGreaterThan(0)
    const held = (await deferredQueue(a)).filter((e) => overflow.some((id) => e.url === `automerge:${id}`))
    expect(held.map((e) => e.unminted === true)).toEqual(held.map(() => true))
    expect(held.length).toBeGreaterThan(0)
    const last = ids[ids.length - 1]!
    const lastName = await objectField(a, last, 'name')
    await sleep(2_000)
    let next = ''
    for (let r = 0; r < ROLLS; r += 1) {
      next = await forceRoll()
      await forwardPassesIdle()
    }
    // Retention (its end state, staged like every retirement of this
    // suite): Marie's epoch is retired — the new shard itself is NOT staged.
    applyRetention(3)
    const heldMetaId = heldMetaUrl.replace(/^automerge:/, '')
    const heldRetired = sql(`SELECT state FROM read_model_model_epoch_docs WHERE document_id = '${heldMetaId}'`)
    expect(heldRetired).toBe('retired')
    const known = Number(sql(`SELECT count(*) FROM read_model_model_epoch_docs WHERE document_id = ANY(ARRAY[${overflow.map((id) => `'${id}'`).join(',')}]::text[])`))
    expect(known).toBe(0)
    console.log(`[o3] auth=${AUTH_ON} heldEpoch=${heldEpoch} now=${publishedEpochNo()} retiredHeld=${heldRetired} objects=${ids.length} overflow=${JSON.stringify(overflow)}`)
    // Diagnostics: which of her shards each object is in, before the hop.
    const shardOf = await a.evaluate((objectIds) => {
      const probe = (window as unknown as { __epochHop: (id?: string) => { objectShards: string[]; objectInShards?: unknown[] } }).__epochHop
      const out: Record<string, string> = {}
      for (const id of objectIds) {
        const p = probe(id)
        const at = (p.objectInShards ?? []).findIndex((o) => o !== null)
        out[id] = at >= 0 ? p.objectShards[at]! : 'none'
      }
      return out
    }, ids)

    await ctxA.setOffline(false)
    const reconnectedAt = Date.now()
    await forwardUntil(async () => (await hopProbe(a)).bootedMetaUrl === next, 120_000)
    console.log(`[o3] hopped ${Date.now() - reconnectedAt} ms after the reconnect, phase=${(await hopProbe(a)).state.phase}`)
    expect((await hopProbe(a)).state.phase).toBe('retired')

    // The export: her edit to the retired base shard.
    const banner = a.getByTestId('epoch-retired-banner')
    await expect(banner).toBeVisible()
    const downloading = a.waitForEvent('download')
    await a.getByTestId('epoch-retired-export').click()
    const download = await downloading
    const chunks: Buffer[] = []
    for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
    const exported = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { differences: Array<{ id: string; local: { name?: string } | null }> }
    expect(exported.differences.find((d) => d.id === z)?.local?.name).toBe(`Z-offline-${tag}`)
    // The objects that filled her retired base shard first are export lines;
    // the new shard's (the last one created is there) are NOT: they live on.
    expect(exported.differences.some((d) => d.id === last)).toBe(false)
    const exportedIds = new Set(exported.differences.map((d) => d.id))

    // Carried on her screen: the new shard and its objects; nothing of the
    // run is in neither the store nor the export.
    expect((await hopProbe(a)).objectShards.some((s) => overflow.includes(s))).toBe(true)
    const inStore = new Set(await a.evaluate((prefix) => window.__modelStore!.getState().objects
      .filter((o) => String(o.name ?? '').startsWith(prefix)).map((o) => o.id), `o3-${tag}-`))
    expect(inStore.has(last)).toBe(true)
    const missing = ids.filter((id) => !inStore.has(id) && !exportedIds.has(id))
    if (missing.length > 0) {
      const shards = [...new Set(missing.map((id) => shardOf[id]!))]
      const rows = shards.map((s) => `${s}:${sql(`SELECT coalesce(string_agg(state || '/' || coalesce(superseded_epoch::text, '-') || '/' || role, ','), 'no-row') FROM read_model_model_epoch_docs WHERE document_id = '${s}'`)}`)
      const now = await hopProbe(a)
      // Diagnostics: whether the server serves them (the read model), and
      // whether the tab projects every shard its current meta lists (a
      // compaction's new base shard was the cause once).
      const inReadModel = sql(`SELECT count(*) FROM ro_objects WHERE id = ANY(ARRAY[${missing.map((id) => `'${id}'`).join(',')}]::text[])`)
      const listedNotProjected = (now.metaObjectShardUrls ?? []).map((u) => u.replace(/^automerge:/, '')).filter((s) => !now.objectShards.includes(s))
      console.log(`[o3] MISSING served=${inReadModel} listedNotProjected=${JSON.stringify(listedNotProjected)} unaccounted=${(now.hopUnaccountedObjects ?? []).length}`)
      console.log(`[o3] MISSING ${missing.length}: shards ${JSON.stringify(rows)} projectedNow=${JSON.stringify(shards.map((s) => now.objectShards.includes(s)))} trace=${JSON.stringify(now.hopTrace.slice(-6))}`.slice(0, 4000))
    }
    expect(missing).toEqual([])
    console.log(`[o3] objects in the store ${inStore.size}, export lines ${exportedIds.size} of ${ids.length} created`)
    // Its pointer in the current meta, its entry dequeued, the badge settled.
    const queued = async () => (await deferredQueue(a)).filter((e) => overflow.some((id) => e.url === `automerge:${id}`))
    await expect.poll(queued, { timeout: 90_000, intervals: [1_000] }).toEqual([]).catch(async (error: unknown) => {
      const p = await hopProbe(a)
      const lists = (await queued()).map((e) => sql(`SELECT count(*) FROM automerge_document_workspace WHERE document_id = '${e.url.replace(/^automerge:/, '')}'`))
      console.log(`[o3] STILL QUEUED ${JSON.stringify(await queued())} claimed=${JSON.stringify(lists)} durablePending=${JSON.stringify(p.durablePending)} provisional=${JSON.stringify((p as unknown as { provisionalShards?: string[] }).provisionalShards)} predecessors=${JSON.stringify(p.predecessorMetas)} decisions=${JSON.stringify((p as unknown as { carriedDecisions?: string[] }).carriedDecisions)} metaLists=${JSON.stringify(((p as unknown as { metaObjectShardUrls?: string[] }).metaObjectShardUrls ?? []).some((u) => overflow.some((id) => u === `automerge:${id}`)))}`.slice(0, 4000))
      throw error
    })
    await expect.poll(async () => (await hopProbe(a)).durablePending.filter((d) => overflow.includes(d)), { timeout: 60_000 }).toEqual([])
    await waitSynced(a)

    // The server's truth: a browser with no local copy sees the objects.
    const p = await fresh.newPage()
    await enterApp(p)
    await expect.poll(async () => (await hopProbe(p)).bootedMetaUrl, { timeout: 60_000 }).toBe(next)
    await expect.poll(() => objectField(p, last, 'name'), { timeout: 120_000, intervals: [1_000] }).toBe(lastName)

    // The hop's own invariant, checked by the tab
    // 5 s after the swap — long past by now: nothing it had in the store is
    // neither projected nor exported.
    expect((await hopProbe(a)).hopUnaccountedObjects ?? []).toEqual([])

    // The tab keeps working.
    await updateObject(a, z!, { description: `after-${tag}` })
    await waitSynced(a)
    expect(await objectField(a, z!, 'description')).toBe(`after-${tag}`)
    expect(pageErrors).toEqual([])
  } finally {
    await dumpHopTrace(a, `o3-${Date.now()}`)
    await ctxA.close()
    await fresh.close()
  }
}

test.describe('a shard created offline into an epoch retired since', () => {
  test('the hop settles on the retired path, the shard lives on in the current meta, the export holds the base-shard edit', async ({ browser }) => {
    test.setTimeout(420_000)
    await scenario(browser)
  })
})
