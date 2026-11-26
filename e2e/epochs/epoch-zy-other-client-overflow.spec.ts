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
  addObjects, enterApp, hopProbe, newContext, sleep, takeUnexpectedNavigations, waitSynced,
} from '../support/epochStack'

test.afterEach(() => {
  expect(takeUnexpectedNavigations()).toEqual([])
})

/**
 * A defect older than epochs (a manual test saw 28 of 550 objects missing in
 * Paul's open tab). Two resident tabs of the same workspace, both
 * online. Marie's tab creates objects until it overflows into a NEW model
 * shard, whose pointer it appends to the current ModelMeta. Paul's tab,
 * open all along, must project that shard: it resolved its shard list once,
 * at boot, and never followed an addition (`followListedModelShards`,
 * `bridge.ts`). Every object Marie created reaches Paul's store. Named to
 * run just before `epoch-zz-retired-offline-shard.spec.ts` (its objects weigh
 * on the specs after it).
 */
test('an open resident tab projects the overflow shard ANOTHER client adds to the current meta', async ({ browser }) => {
  test.setTimeout(300_000)
  const ctxMarie = await newContext(browser)
  const ctxPaul = await newContext(browser)
  const marie = await ctxMarie.newPage()
  const paul = await ctxPaul.newPage()
  try {
    await enterApp(marie)
    await enterApp(paul)
    const before = (await hopProbe(marie)).objectShards
    const paulBefore = (await hopProbe(paul)).objectShards
    const tag = Date.now().toString(36)
    const ids: string[] = []
    for (let round = 0; round < 120 && (await hopProbe(marie)).objectShards.length === before.length; round += 1) {
      ids.push(...await addObjects(marie, 25, `d1-${tag}-${round}`))
      await sleep(150)
    }
    const added = (await hopProbe(marie)).objectShards.filter((s) => !before.includes(s))
    expect(added.length).toBeGreaterThan(0)
    // A few more, all in the new shard.
    ids.push(...await addObjects(marie, 10, `d1-${tag}-last`))
    await waitSynced(marie)
    const inPaul = () => paul.evaluate((wanted) => {
      const have = new Set(window.__modelStore!.getState().objects.map((o) => o.id))
      return wanted.filter((id) => have.has(id)).length
    }, ids)
    try {
      await expect.poll(inPaul, { timeout: 120_000, intervals: [1_000] }).toBe(ids.length)
    } catch (error) {
      // Diagnostics: what each tab holds when Paul misses objects.
      const missing = await paul.evaluate((wanted) => {
        const have = new Set(window.__modelStore!.getState().objects.map((o) => o.id))
        return wanted.filter((id) => !have.has(id))
      }, ids)
      const inShards = async (page: typeof paul, id: string) => page.evaluate((i) => {
        const probe = (window as unknown as { __epochHop: (id: string) => { objectInDocuments?: string[]; editsHeads?: unknown[] } }).__epochHop(i)
        return { docs: probe.objectInDocuments, heads: probe.editsHeads }
      }, id)
      const marieHasInStore = await marie.evaluate((wanted) => {
        const have = new Set(window.__modelStore!.getState().objects.map((o) => o.id))
        return wanted.filter((id) => have.has(id)).length
      }, missing)
      const byName = await marie.evaluate((prefix) => window.__modelStore!.getState().objects
        .filter((o) => String(o.name).startsWith(prefix)).map((o) => o.id), `d1-${tag}-last`)
      const paulByName = await paul.evaluate((prefix) => window.__modelStore!.getState().objects
        .filter((o) => String(o.name).startsWith(prefix)).map((o) => o.id), `d1-${tag}-last`)
      console.log(`[d1-fail] marieStoreHasMissing=${marieHasInStore}/${missing.length} lastByNameMarie=${JSON.stringify(byName)} lastByNamePaul=${JSON.stringify(paulByName)} missingIds=${JSON.stringify(missing)}`)
      const marieState = await marie.evaluate(() => ({
        status: (window as unknown as { __automergeStatus?: { getState(): { status: string } } }).__automergeStatus?.getState().status,
        probe: (window as unknown as { __epochHop: () => Record<string, unknown> }).__epochHop(),
      }))
      console.log(`[d1-fail] missing=${missing.length} first=${missing[0]} marieHoldsIn=${JSON.stringify(await inShards(marie, missing[0]!))} paulHoldsIn=${JSON.stringify(await inShards(paul, missing[0]!))} marieStatus=${marieState.status} provisional=${JSON.stringify(marieState.probe.provisionalShards)} durablePending=${JSON.stringify(marieState.probe.durablePending)} unminted=${String(marieState.probe.unmintedRetriesPending)}`)
      const m = await hopProbe(marie)
      const p = await hopProbe(paul) as unknown as Record<string, unknown>
      console.log(`[d1-fail] marieShards=${JSON.stringify(m.objectShards)} paulShards=${JSON.stringify(p.objectShards)} paulMeta=${JSON.stringify(p.metaObjectShardUrls)} followFailures=${JSON.stringify(p.followFailures)} represented=${String(p.followRepresentations)} waits=${JSON.stringify(p.followRepresentWaits)}`)
      throw error
    }
    const paulNow = (await hopProbe(paul)).objectShards
    expect(added.every((s) => paulNow.includes(s))).toBe(true)
    const represented = (await hopProbe(paul) as unknown as { followRepresentations?: number }).followRepresentations
    console.log(`[d1] objects=${ids.length} newShards=${added.length} paulShards ${paulBefore.length} -> ${paulNow.length} represented=${represented}`)
  } finally {
    await ctxMarie.close()
    await ctxPaul.close()
  }
})
