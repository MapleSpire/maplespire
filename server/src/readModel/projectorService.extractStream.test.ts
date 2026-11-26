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

import { describe, it, expect } from 'vitest'
import { extractModelEntities, type ModelShardRead } from './projectorService.js'
import { SealedWinnerIndex, sealedRankIn } from './sealedWinnerIndex.js'

/**
 * G4-16f: the STREAMING extraction (`extractModelEntities`' third
 * argument). Pure — fake resolver, fake stream, no database.
 *  - a sealed product is ranked by the list the extraction MERGES, never by
 *    ModelMeta's live one (a takeover's concurrent rewrite moved it);
 *  - each read is merged as it arrives, before the next shard is asked for.
 */
const docs: Record<string, unknown> = {
  meta: { objectShardUrls: ['base', 'S1', 'U', 'S2'], connectionShardUrls: [], groups: {} },
  base: { objects: { a: { id: 'a', v: 'base' } } },
  U: { objects: { b: { id: 'b', v: 'U' } } },
}
const sealedContent: Record<string, Record<string, { id: string; v: string }>> = {
  S1: { a: { id: 'a', v: 'S1' }, b: { id: 'b', v: 'S1' }, c: { id: 'c', v: 'S1' } },
  S2: { a: { id: 'a', v: 'S2' } },
}

describe('extractModelEntities streaming (G4-16f)', () => {
  it('hands the stream the list being merged, and ranks by it even when the live list moved under the build', async () => {
    const index = new SealedWinnerIndex<unknown>()
    // ModelMeta's LIVE list, rewritten during the build: S1 unlisted, S2 moved first.
    const live = ['S2', 'base', 'U']
    const lists: Array<readonly string[]> = []
    const model = await extractModelEntities({ modelMetaUrl: 'meta' }, async (url) => docs[url], async (url, _kind, list) => {
      lists.push(list)
      if (!(url in sealedContent)) return { doc: docs[url] }
      // Ranking by `live` would throw for S1 ("not listed") and fail the build.
      index.add(url, Object.keys(sealedContent[url]!), sealedRankIn(list), new Map())
      return { sealed: sealedContent[url]! }
    })
    expect(lists).toHaveLength(4)
    for (const list of lists) expect(list).toEqual(['base', 'S1', 'U', 'S2'])
    // The rows: last wins in the MERGED order.
    const byId = Object.fromEntries(model.objects.map((object) => [object.id, (object as unknown as { v: string }).v]))
    expect(byId).toEqual({ a: 'S2', b: 'U', c: 'S1' })
    // The index agrees with the rows: S2 wins a, S1 keeps b (U, unsealed,
    // overrides it in the merge) and c.
    expect(index.idsWonBy('S2')).toEqual(['a'])
    expect(index.idsWonBy('S1').sort()).toEqual(['b', 'c'])
    // And the moved live list is what `checkSealedIndexOrder` refuses.
    expect(index.orderMatches(live)).toBe(false)
    expect(() => new SealedWinnerIndex<unknown>().add('S1', [], sealedRankIn(live), new Map())).toThrow(/not listed/)
    // Sealed shards have no per-shard entry (nothing watches them).
    expect([...model.objectsByShardUrl.keys()]).toEqual(['base', 'U'])
  })

  it('merges each read as it arrives: the previous shard is in the result before the next one is asked for', async () => {
    // Each sealed record says when the extraction READ it (the merge reads
    // `sealed`); each stream call says what had been read by then. RED on
    // the previous version, which collected every record before merging any.
    const events: string[] = []
    await extractModelEntities({ modelMetaUrl: 'meta' }, async (url) => docs[url], async (url) => {
      events.push(`ask:${url}`)
      if (!(url in sealedContent)) return { doc: docs[url] }
      const read: ModelShardRead = {
        get sealed() { events.push(`merged:${url}`); return sealedContent[url]! },
      }
      return read
    })
    expect(events).toEqual(['ask:base', 'ask:S1', 'merged:S1', 'ask:U', 'ask:S2', 'merged:S2'])
  })

  it('sealedRankIn ranks a url listed twice by its LAST slot (the merge\'s last-wins)', () => {
    expect(sealedRankIn(['S1', 'U', 'S1'])('S1')).toBe(2)
    expect(sealedRankIn(['S1'])('nope')).toBe(-1)
  })
})
