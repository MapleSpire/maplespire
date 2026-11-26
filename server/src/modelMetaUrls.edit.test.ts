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

import { describe, expect, it } from 'vitest'
import * as A from '@automerge/automerge'
import { generateAutomergeUrl } from '@automerge/automerge-repo'
import {
  adoptScalarMetaUrls,
  appendMetaUrl,
  elementUrl,
  metaUrlEditStats,
  readMetaUrls,
  readMetaUrlView,
  writeMetaUrls,
} from './modelMetaUrls.js'
import { spliceFoldedRunInMeta, spliceFoldedRunInPlace } from './readModel/ordinaryChainFoldWriter.js'
import { rewriteListInPlace } from './crdtListEdit.js'
import { extractModelEntities } from './readModel/projectorService.js'
import { collectReferencedUrls } from './maintenance/workspaceFsck.js'

/**
 * G4-16f — the in-place list edit of `modelMetaUrls.ts`: unreadable
 * elements, the prefix/suffix trim, the op
 * order against the code it replaced, the cut-over's fidelity, the dedupe.
 */

type Meta = Record<string, unknown>
const url = (i: number) => `automerge:${String(i).padStart(4, '0')}KnpCseyhnK8izDmLpGP5WMd`
const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
/** The ops of ONE change applied to a fresh copy of `base` with a FIXED actor,
 * so two writers' ops compare as JSON. */
function opsOf(base: A.Doc<Meta>, write: (d: Meta) => void): { doc: A.Doc<Meta>; ops: string } {
  const doc = A.change(A.clone(base, ACTOR), (d) => write(d))
  const change = A.getLastLocalChange(doc)
  return { doc, ops: change ? JSON.stringify(A.decodeChange(change).ops) : '[]' }
}


describe('an unreadable element is left in place', () => {
  it('text authority: append on [A, null, {val: 5}, B] only pushes', () => {
    const base = A.from<Meta>({ objectShardUrls: [url(1), null, { val: 5 }, url(2)] })
    const viaHelper = opsOf(base, (d) => appendMetaUrl(d, 'objectShardUrls', url(3)))
    const raw = opsOf(base, (d) => { (d.objectShardUrls as unknown[]).push(url(3)) })
    expect(viaHelper.ops).toBe(raw.ops)
    expect((viaHelper.doc.objectShardUrls as unknown[])[1]).toBeNull()
    expect(readMetaUrls(viaHelper.doc, 'objectShardUrls')).toEqual([url(1), 'invalid:object', 'invalid:object', url(2), url(3)])
  })

  it('scalar authority: the same append is one op and keeps the unreadable element where it is', () => {
    let doc = A.change(A.from<Meta>({ objectShardUrls: [url(1), null, url(2)] }), (d) => adoptScalarMetaUrls(d))
    expect(readMetaUrls(doc, 'objectShardUrls')).toEqual([url(1), 'invalid:object', url(2)])
    doc = A.change(doc, (d) => appendMetaUrl(d, 'objectShardUrls', url(3)))
    expect(A.decodeChange(A.getLastLocalChange(doc)!).ops).toHaveLength(1)
    expect(readMetaUrls(doc, 'objectShardUrls')).toEqual([url(1), 'invalid:object', url(2), url(3)])
  })

  it('the one normalisation: null and a corrupt value read alike, an absent list stays absent', () => {
    expect(elementUrl(null)).toBe('invalid:object')
    expect(elementUrl({ val: 5 })).toBe('invalid:object')
    expect(elementUrl(url(1))).toBe(url(1))
    expect(readMetaUrls({}, 'objectShardUrls')).toBeUndefined()
  })
})

describe('op for op against the code it replaced (text authority)', () => {
  const cases: [string, string[], string[]][] = [
    ['append', [url(1), url(2)], [url(1), url(2), url(3)]],
    ['plain removal', [url(1), url(2), url(3), url(4)], [url(1), url(3)]],
    ["the rotator's reorder [A, C, B] -> [A, B, C, N]", [url(1), url(3), url(2)], [url(1), url(2), url(3), url(4)]],
  ]
  for (const [name, list, target] of cases) {
    it(`${name}: the same ops as crdtListEdit.rewriteListInPlace`, () => {
      const base = A.from<Meta>({ objectShardUrls: list })
      const viaHelper = opsOf(base, (d) => writeMetaUrls(d, 'objectShardUrls', target))
      const greedy = opsOf(base, (d) => rewriteListInPlace(d.objectShardUrls as string[], target))
      expect(viaHelper.doc.objectShardUrls).toEqual(target)
      expect(viaHelper.ops).toBe(greedy.ops)
    })
  }

  it('a fold window: the same ops as spliceFoldedRunInPlace on the live list', () => {
    const base = A.from<Meta>({ editsObjectShardUrls: [url(1), url(2), url(3), url(4), url(5)] })
    const viaHelper = opsOf(base, (d) => { expect(spliceFoldedRunInMeta(d, 'editsObjectShardUrls', [url(2), url(3), url(4)], url(9))).toBe(true) })
    const live = opsOf(base, (d) => { expect(spliceFoldedRunInPlace(d.editsObjectShardUrls as string[], [url(2), url(3), url(4)], url(9))).toBe(true) })
    expect(viaHelper.doc.editsObjectShardUrls).toEqual([url(1), url(9), url(5)])
    expect(viaHelper.ops).toBe(live.ops)
  })

  it('a fold window skips an unreadable element for its run check and leaves it in place', () => {
    const base = A.from<Meta>({ editsObjectShardUrls: [url(1), url(2), null, url(3), url(5)] })
    const { doc } = opsOf(base, (d) => { expect(spliceFoldedRunInMeta(d, 'editsObjectShardUrls', [url(2), url(3)], url(9))).toBe(true) })
    expect(readMetaUrls(doc, 'editsObjectShardUrls')).toEqual([url(1), url(9), 'invalid:object', url(5)])
  })
})

describe('the trim: appends and one-slot substitutions stay cheap on long lists', () => {
  const long = Array.from({ length: 5_000 }, (_, i) => url(i))

  it('an append to 5 000 entries is one insertion (no LCS table, no greedy fallback)', () => {
    const base = A.from<Meta>({ objectShardUrls: long })
    const started = performance.now()
    const { doc, ops } = opsOf(base, (d) => writeMetaUrls(d, 'objectShardUrls', [...long, url(9999)]))
    expect(performance.now() - started).toBeLessThan(2_000)
    expect((doc.objectShardUrls as string[]).at(-1)).toBe(url(9999))
    // One insertion: the list op plus one op per character.
    expect(JSON.parse(ops)).toHaveLength(url(9999).length + 1)
    // The trim left nothing to match: no LCS table, no greedy fallback.
    expect(metaUrlEditStats.lastLcsCells).toBe(0)
  })

  it('a substitution in the middle of 5 000 entries deletes the window and inserts one', () => {
    const base = A.from<Meta>({ objectShardUrls: long })
    const target = [...long.slice(0, 2_000), url(9999), ...long.slice(2_003)]
    const { doc, ops } = opsOf(base, (d) => writeMetaUrls(d, 'objectShardUrls', target))
    expect(doc.objectShardUrls).toEqual(target)
    expect(JSON.parse(ops)).toHaveLength(3 + url(9999).length + 1)
    // A middle of 3 against 1: (3 + 1) x (1 + 1) cells, not 5 000 x 4 998.
    expect(metaUrlEditStats.lastLcsCells).toBe(8)
  })

  it('a disordered window: the LCS keeps what the greedy pass would re-create', () => {
    // prefix [1] and no common suffix; the middle [2, 3, 4] becomes [9, 2, 3, 8]:
    // the greedy pass drops 2 and 3 at the first mismatch and re-creates them.
    const base = A.from<Meta>({ objectShardUrls: [url(1), url(2), url(3), url(4)] })
    const target = [url(1), url(9), url(2), url(3), url(8)]
    const { doc } = opsOf(base, (d) => writeMetaUrls(d, 'objectShardUrls', target))
    expect(doc.objectShardUrls).toEqual(target)
    expect(metaUrlEditStats.lastLcsCells).toBeGreaterThan(0)
    // A concurrent writer removes url(3); a kept element is not resurrected.
    const remover = A.change(A.clone(base), (d) => { (d.objectShardUrls as unknown[]).splice(2, 1) })
    expect(A.merge(A.clone(doc), remover).objectShardUrls).toEqual([url(1), url(9), url(2), url(8)])
  })

  it('above the cell ceiling (a reversed 2 100-entry middle) the fallback still reaches the target', () => {
    const list = Array.from({ length: 2_100 }, (_, i) => url(i))
    const target = [url(9000), ...[...list].reverse(), url(9001)]
    const base = A.from<Meta>({ objectShardUrls: list })
    const { doc } = opsOf(base, (d) => writeMetaUrls(d, 'objectShardUrls', target))
    expect(doc.objectShardUrls).toEqual(target)
  })
})

describe('consumers under the scalar marker (frozen text deliberately stale)', () => {
  const scalarMeta = {
    metaUrlFormat: 2,
    groups: {},
    // FROZEN at the cut-over: names only the first shard of each kind.
    objectShardUrls: ['os0'], connectionShardUrls: ['cs0'],
    objectShardRefs: [new A.ImmutableString('os0'), new A.ImmutableString('os1')],
    connectionShardRefs: [new A.ImmutableString('cs0'), new A.ImmutableString('cs1')],
  }

  it('the projector extraction reads the scalar lists (projectorService metaView)', async () => {
    const docs: Record<string, unknown> = {
      meta: scalarMeta,
      os0: { objects: { o: { id: 'o', name: 'base' } } },
      os1: { objects: { o: { id: 'o', name: 'edited' } } },
      cs0: { connections: { c: { id: 'c', name: 'base' } } },
      cs1: { connections: { c: { id: 'c', name: 'edited' } } },
    }
    const model = await extractModelEntities({ modelMetaUrl: 'meta' }, async (u) => docs[u])
    expect(model.objects).toEqual([{ id: 'o', name: 'edited' }])
    expect(model.connections).toEqual([{ id: 'c', name: 'edited' }])
    expect([...model.objectsByShardUrl.keys()]).toEqual(['os0', 'os1'])
  })

  it('the fsck reference census names both copies', () => {
    // Minted, not hand-edited: a checksum-failing url is filtered out silently.
    const urls = { frozen: generateAutomergeUrl(), ruling: generateAutomergeUrl() }
    const found = collectReferencedUrls({ shardUrls: [] }, {
      metaUrlFormat: 2,
      objectShardUrls: [urls.frozen],
      objectShardRefs: [new A.ImmutableString(urls.ruling)],
    }, [])
    expect(found).toEqual(expect.arrayContaining([urls.frozen, urls.ruling]))
  })
})

describe('the cut-over and the dedupe', () => {
  it('readMetaUrlView is the same before and after a cut-over, all six fields non-trivial', () => {
    const doc = A.from<Meta>({
      objectShardUrls: [url(1), url(2), url(3)],
      connectionShardUrls: [url(11), url(12)],
      editsObjectShardUrls: [url(2), url(3)],
      editsConnectionShardUrls: [url(12), url(13)],
      editsObjectShardUrl: url(3),
      editsConnectionShardUrl: url(13),
    })
    const before = readMetaUrlView(doc)
    expect(Object.keys(before)).toHaveLength(6)
    const after = A.change(doc, (d) => adoptScalarMetaUrls(d))
    expect(after.metaUrlFormat).toBe(2)
    expect(readMetaUrlView(after)).toEqual(before)
    for (const key of ['objectShardRefs', 'connectionShardRefs', 'editsObjectShardRefs', 'editsConnectionShardRefs', 'editsObjectShardRef', 'editsConnectionShardRef']) {
      expect(after[key], key).toBeDefined()
    }
  })

  for (const scalar of [false, true]) {
    it(`appendMetaUrl of a url already listed changes nothing (${scalar ? 'scalar' : 'text'} authority)`, () => {
      let doc = A.from<Meta>({ objectShardUrls: [url(1), url(2)] })
      if (scalar) doc = A.change(doc, (d) => adoptScalarMetaUrls(d))
      const heads = A.getHeads(doc)
      doc = A.change(doc, (d) => appendMetaUrl(d, 'objectShardUrls', url(1)))
      expect(A.getHeads(doc)).toEqual(heads)
      expect(readMetaUrls(doc, 'objectShardUrls')).toEqual([url(1), url(2)])
    })
  }
})
