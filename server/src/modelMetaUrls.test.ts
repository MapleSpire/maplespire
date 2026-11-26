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
import {
  adoptScalarMetaUrls,
  appendMetaUrl,
  META_URL_FORMAT_FIELD,
  metaUrlValue,
  readMetaUrl,
  readMetaUrls,
  readMetaUrlsUnion,
  withMetaUrlView,
  writeMetaUrl,
  writeMetaUrls,
} from './modelMetaUrls.js'
import { publishOverlaySegment, type OverlayMetaLike } from './overlaySegments.js'
import { appendCompactionSegmentInPlace } from './readModel/compaction.js'
import { substituteOverlayPrefix } from './readModel/staticDeltaProjector.js'
import { spliceFoldedRunInMeta } from './readModel/ordinaryChainFoldWriter.js'

/**
 * G4-16f: the ModelMeta URL fields as scalars, with a dual-field
 * migration. Pure Automerge, no Repo, no database (the Repo-level
 * mixed-version tests are in `modelMetaUrls.mixed.test.ts`).
 */

type Meta = Record<string, unknown>

// Real-shaped urls (the op count of a text url is one per character).
const url = (i: number) => `automerge:${String(i).padStart(4, '0')}KnpCseyhnK8izDmLpGP5WMd`
const lastChangeOps = (doc: A.Doc<unknown>) => A.decodeChange(A.getLastLocalChange(doc)!).ops.length
const totalOps = (doc: A.Doc<unknown>) => A.stats(doc).numOps
/** A scalar-ruled ModelMeta, BORN so (as an epoch meta is): the shape in
 * the first change, before anything is measured. */
const scalarMeta = (initial: Meta) => A.change(A.from<Meta>(initial), (d) => adoptScalarMetaUrls(d))

/** A fake handle over a plain Automerge doc, the shape `publishOverlaySegment` takes. */
function handleOf(initial: Meta, scalar = false) {
  let doc = scalar ? scalarMeta(initial) : A.from<Meta>(initial)
  return {
    get doc() { return doc },
    handle: { change: (fn: (m: OverlayMetaLike) => void) => { doc = A.change(doc, (d) => fn(d as OverlayMetaLike)) } },
  }
}

function freshMeta(): Meta {
  return {
    objectShardUrls: [url(0), url(1)],
    connectionShardUrls: [url(9000)],
    editsObjectShardUrl: url(1),
    editsObjectShardUrls: [url(1)],
    editsConnectionShardUrl: url(9000),
    editsConnectionShardUrls: [url(9000)],
    editsOverlayWriteHeadVersion: 1,
  }
}

describe('metaUrlValue — the one element reader', () => {
  it('reads text as itself and an ImmutableString by its value, materialized and through a change proxy', () => {
    const doc = A.from<Meta>({ t: [url(1)], s: [new A.ImmutableString(url(2))], h: new A.ImmutableString(url(3)) })
    expect(typeof (doc.s as unknown[])[0]).toBe('object')
    expect(metaUrlValue((doc.t as unknown[])[0])).toBe(url(1))
    expect(metaUrlValue((doc.s as unknown[])[0])).toBe(url(2))
    expect(metaUrlValue(doc.h)).toBe(url(3))
    A.change(A.clone(doc), (d) => {
      expect(metaUrlValue((d.s as unknown[])[0])).toBe(url(2))
      expect(metaUrlValue(d.h)).toBe(url(3))
    })
  })

  it('ARRAY FIRST: a list proxy answers isImmutableString but is not read as one', () => {
    const doc = A.from<Meta>({ s: [new A.ImmutableString(url(2))] })
    A.change(A.clone(doc), (d) => {
      // The trap, measured in 3.2.6: true on the LIST proxy.
      expect(A.isImmutableString(d.s)).toBe(true)
      expect(metaUrlValue(d.s)).toBe('invalid:object')
    })
  })

  it('a corrupt element is never read as a url: absent stays absent, anything else is invalid', () => {
    expect(metaUrlValue(undefined)).toBeUndefined()
    expect(metaUrlValue(null)).toBeUndefined()
    expect(metaUrlValue({ val: 5 })).toBe('invalid:object')
    expect(metaUrlValue(7)).toBe('invalid:number')
  })

  it('what an OLD reader does with a scalar: every check it uses misses', () => {
    const doc = A.from<Meta>({ s: [new A.ImmutableString(url(2))] })
    const list = doc.s as unknown[]
    expect(typeof list[0]).not.toBe('string')
    expect(list.includes(url(2))).toBe(false)
    expect(list.indexOf(url(2))).toBe(-1)
    expect(list[0] === url(2)).toBe(false)
  })
})

describe('the cost: one operation per scalar url, ~39 per text url', () => {
  it('measured on one push', () => {
    const base = A.from<Meta>({ t: [], s: [] })
    const text = A.change(A.clone(base), (d) => { (d.t as unknown[]).push(url(5)) })
    const scalar = A.change(A.clone(base), (d) => { (d.s as unknown[]).push(new A.ImmutableString(url(5))) })
    // One op per character plus the insertion: 38 for this 37-character url.
    expect(lastChangeOps(text)).toBe(url(5).length + 1)
    expect(lastChangeOps(scalar)).toBe(1)
  })
})

describe('text authority (no marker): exactly the writes of the build before', () => {
  it('writes only the old text fields, the same operations a raw push and assignment cost', () => {
    const viaHelper = A.change(A.from<Meta>(freshMeta()), (d) => {
      appendMetaUrl(d, 'editsObjectShardUrls', url(2))
      writeMetaUrl(d, 'editsObjectShardUrl', url(2))
    })
    const raw = A.change(A.from<Meta>(freshMeta()), (d) => {
      (d.editsObjectShardUrls as unknown[]).push(url(2))
      d.editsObjectShardUrl = url(2)
    })
    expect(viaHelper[META_URL_FORMAT_FIELD]).toBeUndefined()
    expect(viaHelper.editsObjectShardRefs).toBeUndefined()
    expect(viaHelper.editsObjectShardRef).toBeUndefined()
    expect(viaHelper.editsObjectShardUrls).toEqual([url(1), url(2)])
    expect(viaHelper.editsObjectShardUrl).toBe(url(2))
    expect(lastChangeOps(viaHelper)).toBe(lastChangeOps(raw))
  })

  it('reads the OLD field, whatever a scalar-named field holds, while the marker is absent', () => {
    const doc = A.from<Meta>({ objectShardUrls: [url(1), url(7)], objectShardRefs: [new A.ImmutableString(url(1))] })
    expect(readMetaUrls(doc, 'objectShardUrls')).toEqual([url(1), url(7)])
  })
})

describe('scalar authority (marker): only scalars written, the text field frozen', () => {
  it('a scalar-ruled document mirrors every field, then writes cost one op per url', () => {
    let doc = scalarMeta(freshMeta())
    doc = A.change(doc, (d) => appendMetaUrl(d, 'editsObjectShardUrls', url(2)))
    expect(doc[META_URL_FORMAT_FIELD]).toBe(2)
    expect(doc.editsObjectShardUrls).toEqual([url(1)]) // frozen at the cut-over
    expect(readMetaUrls(doc, 'editsObjectShardUrls')).toEqual([url(1), url(2)])
    expect(readMetaUrls(doc, 'objectShardUrls')).toEqual([url(0), url(1)])
    expect(readMetaUrl(doc, 'editsConnectionShardUrl')).toBe(url(9000))
    doc = A.change(doc, (d) => appendMetaUrl(d, 'editsObjectShardUrls', url(3)))
    expect(lastChangeOps(doc)).toBe(1)
    doc = A.change(doc, (d) => writeMetaUrl(d, 'editsObjectShardUrl', url(3)))
    expect(lastChangeOps(doc)).toBe(1)
    expect(doc.editsObjectShardUrl).toBe(url(1))
  })

  it('the marker rules: a scalar document stays scalar', () => {
    let doc = scalarMeta(freshMeta())
    doc = A.change(doc, (d) => appendMetaUrl(d, 'objectShardUrls', url(4)))
    expect(doc.objectShardUrls).toEqual([url(0), url(1)])
    expect(readMetaUrls(doc, 'objectShardUrls')).toEqual([url(0), url(1), url(4)])
  })

  it('adoptScalarMetaUrls is idempotent', () => {
    const once = scalarMeta(freshMeta())
    const twice = A.change(once, (d) => adoptScalarMetaUrls(d))
    expect(A.getHeads(twice)).toEqual(A.getHeads(once))
  })

  // G4-16f: NO WRITE CUTS A DOCUMENT OVER IN PLACE — not even with the
  // retired switch set in the process. The cut-over's hazards lived in that
  // path; a scalar-ruled ModelMeta is born so (an epoch).
  it('no write ever cuts a TEXT document over, whatever the environment says', () => {
    process.env.AM_META_URL_SCALAR = 'on'
    try {
      let doc = A.from<Meta>(freshMeta())
      doc = A.change(doc, (d) => {
        appendMetaUrl(d, 'objectShardUrls', url(4))
        writeMetaUrls(d, 'editsObjectShardUrls', [url(1), url(5)])
        writeMetaUrl(d, 'editsObjectShardUrl', url(5))
      })
      expect(doc[META_URL_FORMAT_FIELD]).toBeUndefined()
      expect(doc.objectShardRefs).toBeUndefined()
      expect(doc.editsObjectShardRef).toBeUndefined()
      expect(doc.objectShardUrls).toEqual([url(0), url(1), url(4)])
      expect(doc.editsObjectShardUrl).toBe(url(5))
    } finally {
      delete process.env.AM_META_URL_SCALAR
    }
  })
})

describe('the in-place edit: a longest common subsequence, never a re-creation', () => {
  it('a middle insertion re-creates nothing: a concurrent removal after it is not undone', () => {
    const base = A.from<Meta>({ objectShardUrls: [url(1), url(2), url(3), url(4)] })
    // The new writer inserts before url(3) (compaction's base shard before the overlay).
    const inserter = A.change(A.clone(base), (d) => writeMetaUrls(d, 'objectShardUrls', [url(1), url(2), url(99), url(3), url(4)]))
    // One text url inserted (38 ops); a re-creation of url(3) and url(4) would add ~150.
    expect(lastChangeOps(inserter)).toBe(url(99).length + 1)
    // A concurrent writer (old build) removes url(4).
    const remover = A.change(A.clone(base), (d) => { (d.objectShardUrls as unknown[]).splice(3, 1) })
    const merged = A.merge(A.clone(inserter), remover)
    expect(readMetaUrls(merged, 'objectShardUrls')).toEqual([url(1), url(2), url(99), url(3)])
  })

  it('removals and reorders still reach the target', () => {
    const doc = A.change(A.from<Meta>({ objectShardUrls: [url(1), url(2), url(3), url(1)] }), (d) => {
      writeMetaUrls(d, 'objectShardUrls', [url(3), url(1)])
    })
    expect(doc.objectShardUrls).toEqual([url(3), url(1)])
    const scalar = A.change(A.change(A.from<Meta>({ objectShardUrls: [url(1), url(2), url(3), url(1)] }), (d) => adoptScalarMetaUrls(d)), (d) => {
      writeMetaUrls(d, 'objectShardUrls', [url(3), url(1)])
    })
    expect((scalar.objectShardRefs as unknown[]).map(metaUrlValue)).toEqual([url(3), url(1)])
    expect(scalar.objectShardUrls).toEqual([url(1), url(2), url(3), url(1)])
  })
})

describe('views and unions', () => {
  it('a view keeps no marker and no scalar copy, so a copy of it seeds a text-authority document', () => {
    const doc = A.change(scalarMeta(freshMeta()), (d) => appendMetaUrl(d, 'objectShardUrls', url(5)))
    const view = withMetaUrlView(doc) as Meta
    expect(view[META_URL_FORMAT_FIELD]).toBeUndefined()
    expect(view.objectShardRefs).toBeUndefined()
    expect(view.objectShardUrls).toEqual([url(0), url(1), url(5)])
    const seeded = A.from<Meta>(JSON.parse(JSON.stringify(view)))
    expect(readMetaUrls(seeded, 'objectShardUrls')).toEqual([url(0), url(1), url(5)])
  })

  it('the union names what EITHER copy names: the frozen text mirror', () => {
    const doc = A.change(scalarMeta(freshMeta()), (d) => {
      writeMetaUrls(d, 'editsObjectShardUrls', [url(2)])
      writeMetaUrl(d, 'editsObjectShardUrl', url(2))
    })
    expect(readMetaUrlsUnion(doc, 'editsObjectShardUrls')).toEqual([url(2), url(1)])
    expect(readMetaUrlsUnion(doc, 'editsObjectShardUrl')).toEqual([url(2), url(1)])
    expect(readMetaUrlsUnion({}, 'objectShardUrls')).toBeUndefined()
  })
})

/**
 * The op-count witness (b): N rotations through the rotator's ONE ModelMeta
 * change (`publishOverlaySegment`, `ordinaryHeadRotator.ts`), N compactions'
 * ModelMeta writes and N folds' splices, text against scalar. A mutant that
 * writes text again (`asScalar` returning the string) turns the scalar arm RED.
 */
describe('witness: ops per rotation, compaction and fold', () => {
  const N = 60

  function rotate(scalar: boolean): { perRotation: number; bytes: number } {
    const meta = handleOf(freshMeta(), scalar)
    // A first write, out of the measured window.
    publishOverlaySegment(meta.handle as never, 'objects', url(2))
    const before = totalOps(meta.doc)
    for (let i = 0; i < N; i += 1) publishOverlaySegment(meta.handle as never, 'objects', url(100 + i))
    const perRotation = (totalOps(meta.doc) - before) / N
    expect(readMetaUrls(meta.doc, 'editsObjectShardUrls')!.at(-1)).toBe(url(100 + N - 1))
    expect(readMetaUrl(meta.doc, 'editsObjectShardUrl')).toBe(url(100 + N - 1))
    return { perRotation, bytes: A.save(meta.doc).length }
  }

  it('rotation: text ~3 urls x 39 ops, scalar a handful', () => {
    const text = rotate(false)
    const scalar = rotate(true)
    // Text writes the segment list, the head and the shard list (each a url
    // of ~38 characters) plus the scalar shadow; scalar writes three scalars
    // and the version.
    expect(text.perRotation).toBeGreaterThanOrEqual(3 * (url(0).length + 1))
    expect(scalar.perRotation).toBeLessThanOrEqual(5)
    expect(scalar.bytes).toBeLessThan(text.bytes)
  })

  it('compaction ModelMeta writes and fold splices: scalar a handful per url', () => {
    let doc = scalarMeta(freshMeta())
    const before = totalOps(doc)
    for (let i = 0; i < N; i += 1) {
      doc = A.change(doc, (d) => {
        appendCompactionSegmentInPlace(d, 'editsObjectShardUrls', url(200 + i))
        writeMetaUrl(d, 'editsObjectShardUrl', url(200 + i))
        appendMetaUrl(d, 'objectShardUrls', url(200 + i))
      })
    }
    expect((totalOps(doc) - before) / N).toBeLessThanOrEqual(4)
    // A fold of two segments into one product, on both lists (ordinary
    // writer) and through the static plane's substitution.
    const beforeFold = totalOps(doc)
    doc = A.change(doc, (d) => {
      expect(spliceFoldedRunInMeta(d, 'editsObjectShardUrls', [url(200), url(201)], url(900))).toBe(true)
      expect(spliceFoldedRunInMeta(d, 'objectShardUrls', [url(200), url(201)], url(900))).toBe(true)
    })
    expect(totalOps(doc) - beforeFold).toBeLessThanOrEqual(6)
    expect(readMetaUrls(doc, 'editsObjectShardUrls')!.slice(0, 3)).toEqual([url(1), url(900), url(202)])
    const beforeStatic = totalOps(doc)
    doc = A.change(doc, (d) => {
      expect(substituteOverlayPrefix(d as never, 'editsObjectShardUrls', [url(900), url(202)], [url(901)], true, true)).toBe(true)
    })
    expect(totalOps(doc) - beforeStatic).toBeLessThanOrEqual(4)
    expect(readMetaUrls(doc, 'editsObjectShardUrls')!.slice(0, 3)).toEqual([url(1), url(901), url(203)])
  })
})
