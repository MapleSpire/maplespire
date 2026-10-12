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
import {
  planOverlayChainFold,
  foldOverlaySegmentContents,
  splitMergedOverlaySegment,
  OVERLAY_SEGMENT_ENTITY_CEILING,
  OVERLAY_CHAIN_FOLD_WINDOW_ENTITIES,
  OVERLAY_CHAIN_FOLD_MIN,
} from './overlayChainFold.js'
import { OVERLAY_CHAIN_CEILING } from '../maintenance/workspaceFsck.js'
import { mergeStaticOverlaySegments } from './staticDeltaProjector.js'
import { canonicalOverlayDocumentIds } from './overlayHistoryProtocol.js'

/**
 * The planning half of overlay chain folding.
 *
 * Every test here names the mutant it kills, because the two failure modes of
 * this module are silent: folding the write head loses whatever lands during
 * the pass, and folding a non-contiguous subset silently reorders last-wins.
 * Neither shows up as an exception.
 */

const seg = (n: number) => `automerge:seg-${n}`
const chain = (n: number) => Array.from({ length: n }, (_, i) => seg(i))

describe('planOverlayChainFold', () => {
  it('never folds the current write head, even when ModelMeta lists it FIRST', () => {
    // The trap: `canonicalOverlayDocumentIds` MOVES the head to last, so a
    // planner that slices its output without dropping the tail element folds
    // the head whenever a stale client appended it early.
    const head = seg(0)
    const ids = [head, ...chain(80).slice(1)]
    const plan = planOverlayChainFold(ids, head, { minChain: 4, budget: 8 })

    expect(plan.fold).not.toContain(head)
    expect(plan.tail.at(-1)).toBe(head)
    // MUTANT: `ordered.slice(0, take)` computed over `retired` without
    // re-anchoring on the canonical order — it would fold seg-0 here.
    expect(plan.fold[0]).toBe(seg(1))
  })

  it('folds a CONTIGUOUS oldest prefix, and fold+tail rebuilds the canonical order', () => {
    const ids = chain(100)
    const head = seg(99)
    const plan = planOverlayChainFold(ids, head, { minChain: 4, budget: 12 })

    expect(plan.fold).toEqual(chain(12))
    expect([...plan.fold, ...plan.tail]).toEqual(canonicalOverlayDocumentIds(ids, head))
    // MUTANT: folding the NEWEST retired segments, or any non-contiguous
    // subset — the merged segment would then outrank segments that beat it.
    expect(plan.tail[0]).toBe(seg(12))
  })

  it('respects the budget on a very long chain, and leaves an obligation', () => {
    const ids = chain(3000)
    const plan = planOverlayChainFold(ids, seg(2999), { minChain: 64, budget: 32 })

    expect(plan.fold).toHaveLength(32)
    expect(plan.tail).toHaveLength(3000 - 32)
    // MUTANT: fold everything in one pass — minutes of a blocked projector.
  })

  it('does nothing below the threshold, with a NAMED reason', () => {
    const ids = chain(10)
    const plan = planOverlayChainFold(ids, seg(9), { minChain: 64, budget: 32 })

    expect(plan.fold).toEqual([])
    expect(plan.skippedReason).toBe('chain-below-threshold')
    // A skip must always be named: a silent no-op is indistinguishable from
    // dead code.
    expect(plan.tail).toEqual(ids)
  })

  it('counts the RETIRED chain against the threshold, not the whole list', () => {
    // 64 entries total = 63 retired + the head. One short, on purpose.
    const ids = chain(64)
    const plan = planOverlayChainFold(ids, seg(63), { minChain: 64, budget: 32 })

    expect(plan.skippedReason).toBe('chain-below-threshold')
    // MUTANT: `ordered.length < minChain` instead of `retired.length < minChain`.
    expect(planOverlayChainFold(chain(65), seg(64), { minChain: 64, budget: 32 }).fold)
      .toHaveLength(32)
  })

  it('refuses when the head is unknown, and NAMES that case apart from an unlisted head', () => {
    expect(planOverlayChainFold(chain(100), undefined, { minChain: 4 }).skippedReason)
      .toBe('no-current-head')
    // MUTANT: treating an unknown head as "fold everything" — every edit that
    // lands during the pass goes into a segment nobody points at any more.

    // The two cases are NOT interchangeable: `canonicalOverlayDocumentIds` APPENDS an unlisted head, so
    // `ordered.at(-1) === head` is true for both and cannot separate them.
    expect(planOverlayChainFold(chain(100), 'automerge:not-listed', { minChain: 4 }).skippedReason)
      .toBe('head-not-listed')
    // MUTANT: checking the last element instead of membership in the raw list —
    // it silently folds on a ModelMeta whose two overlay fields disagree.
  })

  it('refuses a budget below two — one into one costs a document and buys nothing', () => {
    const plan = planOverlayChainFold(chain(100), seg(99), { minChain: 4, budget: 1 })
    expect(plan.skippedReason).toBe('budget-below-two')
    expect(plan.fold).toEqual([])
  })

  it('deduplicates a repeated url before planning', () => {
    const ids = [seg(0), seg(1), seg(0), seg(2), seg(3)]
    const plan = planOverlayChainFold(ids, seg(3), { minChain: 2, budget: 2 })
    expect(plan.fold).toEqual([seg(0), seg(1)])
    expect([...plan.fold, ...plan.tail]).toEqual([seg(0), seg(1), seg(2), seg(3)])
  })
})

describe('foldOverlaySegmentContents', () => {
  const oldest = { a: { id: 'a', v: 1 }, shared: { id: 'shared', v: 1 } }
  const middle = { shared: { id: 'shared', v: 2 } }
  const newest = { b: { id: 'b', v: 1 }, shared: { id: 'shared', v: 3 } }

  it('is last-wins in ModelMeta order, and keeps the record keys', () => {
    const merged = foldOverlaySegmentContents([oldest, middle, newest])
    expect(merged).toEqual({
      a: { id: 'a', v: 1 },
      shared: { id: 'shared', v: 3 },
      b: { id: 'b', v: 1 },
    })
    // MUTANT: iterating a Set of segments, or Object.assign in reverse — the
    // OLDEST value of `shared` would win and the user's latest edit vanishes.
  })

  it('agrees with mergeStaticOverlaySegments — the repo does not need a fourth order', () => {
    const mine = Object.values(foldOverlaySegmentContents([oldest, middle, newest]))
    const theirs = mergeStaticOverlaySegments([oldest, middle, newest])
    expect(mine).toEqual(theirs)
    // This pin is the point: a comment saying "keep these identical" does not
    // fail when one of them drifts.
  })

  it('does NOT apply tombstones — a fold must not change the effective set', () => {
    const merged = foldOverlaySegmentContents([oldest, middle, newest])
    expect(Object.keys(merged)).toContain('shared')
    // MUTANT: passing ModelMeta.deletedObjectIds through here. The tombstone
    // list is applied downstream and can be CLEARED; dropping the value at
    // fold time makes that clearing resurrect nothing.
  })

  it('an empty chain folds to an empty segment, not to undefined', () => {
    expect(foldOverlaySegmentContents([])).toEqual({})
  })
})

/**
 * Sealing and the window budget. Without them the merged segment is bounded by
 * NOTHING: because the merge lands at the window's slot it becomes the oldest
 * element of the chain it produces, so the next pass folds it back in and its
 * entity count rises toward every distinct entity in the landscape.
 *
 * What an unbounded ~12 000-entity segment costs: `repo.create` + `repo.flush`
 * takes ~3-7 s depending on `ObjectInput` shape, the snapshot handed to
 * Postgres as one jsonb parameter is ~4-9 MB, and — the one that cannot be
 * undone — wasm32 linear memory never shrinks, so ~740 MB per pass is retained
 * for the process's life.
 */
describe('planOverlayChainFold — sealing and the window budget (A11)', () => {
  const sizes = (map: Record<string, number>) => (url: string) => map[url]

  it('SEALS a segment at the ceiling and starts the window after it', () => {
    const ids = chain(80)
    // seg-0 is full; the run therefore has to begin at seg-1.
    const plan = planOverlayChainFold(ids, seg(79), {
      minChain: 4, budget: 8, segmentCeiling: 100, windowEntities: 10_000,
      entityCountOf: sizes({ [seg(0)]: 100 }),
    })
    expect(plan.fold).not.toContain(seg(0))
    expect(plan.fold[0]).toBe(seg(1))
    expect(plan.foldAt).toBe(1)
    // MUTANT: `size > ceiling` instead of `>=`. A segment exactly AT the bound
    // is the common case — every full part `splitMergedOverlaySegment` emits is
    // exactly `ceiling` — so an off-by-one there re-folds every one of them and
    // restores the unbounded merge with the seal still in the source.
  })

  it('bounds the window by ENTITIES, not by the segment count', () => {
    const ids = chain(80)
    // Eight segments of 400 would be admitted by `budget: 8`; the entity budget
    // stops at three.
    const plan = planOverlayChainFold(ids, seg(79), {
      minChain: 4, budget: 8, segmentCeiling: 100_000, windowEntities: 1_000,
      entityCountOf: () => 400,
    })
    // The budget is a ceiling NOT to cross, not a floor to reach: three
    // segments would be 1 200 entities, so the window stops at two.
    expect(plan.fold).toHaveLength(2)
    expect(plan.windowEntities).toBe(800)
    // The CONTROL that makes the number above mean something — the same chain
    // and the same `budget: 8`, with only the entity budget lifted, admits all
    // eight. Without this line a mutant that always returns two would pass.
    const unbudgeted = planOverlayChainFold(ids, seg(79), {
      minChain: 4, budget: 8, segmentCeiling: 100_000, windowEntities: 10_000,
      entityCountOf: () => 400,
    })
    expect(unbudgeted.fold).toHaveLength(8)
    // MUTANT: dropping the window check, or applying it to `budget` instead.
    // `budget` counts SEGMENTS and says nothing about what is inside the
    // advisory lock — 32 segments of 512 is 16 384 entities and ~9.6 s held on
    // a key `synchronizeOverlaySegments` takes with `lock_timeout = 0`.
  })

  it('always admits TWO segments, even when the pair busts the budget', () => {
    const plan = planOverlayChainFold(chain(80), seg(79), {
      minChain: 4, budget: 8, segmentCeiling: 100_000, windowEntities: 10,
      entityCountOf: () => 900,
    })
    expect(plan.fold).toHaveLength(2)
    // MUTANT: an unconditional budget break. A run of large-but-unsealed
    // segments would then be permanently unfoldable — a pass that reports work
    // to do and never does it, which is the shape this file's `skippedReason`
    // discipline exists to prevent.
  })

  it('NAMES the case where every candidate run is shorter than two', () => {
    const ids = chain(80)
    // Alternate sealed/unsealed: every unsealed run is exactly one segment.
    const sealed: Record<string, number> = {}
    for (let i = 0; i < 80; i += 2) sealed[seg(i)] = 100
    const plan = planOverlayChainFold(ids, seg(79), {
      minChain: 4, budget: 8, segmentCeiling: 100, windowEntities: 10_000,
      entityCountOf: sizes(sealed),
    })
    expect(plan.fold).toEqual([])
    expect(plan.skippedReason).toBe('no-foldable-run')
    // MUTANT: returning a one-segment fold. Merging one document into one
    // document costs a document and buys nothing — the reason `budget < 2` is
    // already refused above.
  })

  it('resumes AFTER the sealed segment that broke a run, never past the one behind it', () => {
    // MUTANT: `cursor = end + 2`. It skips
    // a segment as a run start, so a foldable pair beginning right after the
    // sealed one is invisible and the fold refuses work it should do.
    //
    // Layout: seg-0 alone (seg-1 sealed), then seg-2/seg-3 foldable.
    const plan = planOverlayChainFold(chain(80), seg(79), {
      minChain: 4, budget: 8, segmentCeiling: 100, windowEntities: 10_000,
      entityCountOf: (url) => (url === seg(1) ? 100 : 10),
    })
    expect(plan.fold[0]).toBe(seg(2))
    expect(plan.foldAt).toBe(2)
  })

  it('stops the window BEFORE crossing the budget, not at it', () => {
    // MUTANT: `next > windowEntities` weakened to `>=`.
    // Four segments of 250 against a 1 000 budget must all be admitted — the
    // sum is exactly the budget, and a window that lands ON its ceiling has not
    // exceeded it. With `>=` the fourth is refused.
    const plan = planOverlayChainFold(chain(80), seg(79), {
      minChain: 4, budget: 8, segmentCeiling: 100_000, windowEntities: 1_000,
      entityCountOf: () => 250,
    })
    expect(plan.fold).toHaveLength(4)
    expect(plan.windowEntities).toBe(1_000)
  })

  it('REPAIRS a lone oversized segment by handing it back as a window of ONE', () => {
    // A bulk import puts
    // the whole landscape in one head; `rotateOverlayHead` retires it WHOLE
    // (it creates an empty successor and never splits); the resulting segment
    // is `>= segmentCeiling` so it is SEALED from birth — excluded from every
    // window for ever — and `overlay-segment-bounded` then reports `degraded`
    // on it permanently with nothing in the tree able to repair it. A detector
    // for a state that cannot be left is a gate that gets muted.
    const ids = chain(80)
    const plan = planOverlayChainFold(ids, seg(79), {
      minChain: 4, budget: 8, segmentCeiling: 100, windowEntities: 200,
      // Everything sealed, so no PAIR is mergeable — and one is oversized.
      entityCountOf: (url) => (url === seg(5) ? 900 : 100),
    })
    expect(plan.fold).toEqual([seg(5)])
    expect(plan.foldAt).toBe(5)
    expect(plan.windowEntities).toBe(900)
    // MUTANT: drop the repair branch. `no-foldable-run` for ever, and an
    // oversized import segment is never split.
  })

  it('does NOT re-split a segment sitting exactly AT the ceiling', () => {
    // Strictly greater, not `>=`. A segment at the ceiling is what a correct
    // split produces; re-splitting it emits one part identical to its input,
    // which is a pass that runs for ever and never converges.
    const plan = planOverlayChainFold(chain(80), seg(79), {
      minChain: 4, budget: 8, segmentCeiling: 100, windowEntities: 200,
      entityCountOf: () => 100,
    })
    expect(plan.fold).toEqual([])
    expect(plan.skippedReason).toBe('no-foldable-run')
  })

  it('prefers an ordinary PAIR to the repair, so the cheap work happens first', () => {
    const plan = planOverlayChainFold(chain(80), seg(79), {
      minChain: 4, budget: 8, segmentCeiling: 100, windowEntities: 10_000,
      // seg-0/seg-1 are a mergeable pair; seg-5 is oversized.
      entityCountOf: (url) => (url === seg(5) ? 900 : url === seg(0) || url === seg(1) ? 10 : 100),
    })
    expect(plan.fold).toEqual([seg(0), seg(1)])
    // MUTANT: run the repair scan first. One oversized segment would then
    // starve every ordinary fold until it is split, and the repair is the most
    // expensive pass there is.
  })

  it('never repairs the current write HEAD, however large it is', () => {
    // `retired` excludes the head, and it must: clients are still writing into
    // it, so a fold that swallowed it would lose every edit landing during the
    // pass. An oversized head is repaired only AFTER a rotation retires it.
    const plan = planOverlayChainFold(chain(80), seg(79), {
      minChain: 4, budget: 8, segmentCeiling: 100, windowEntities: 200,
      entityCountOf: (url) => (url === seg(79) ? 99_999 : 100),
    })
    expect(plan.fold).toEqual([])
    expect(plan.skippedReason).toBe('no-foldable-run')
  })

  it('treats an UNKNOWN size as unsealed and as zero, so a cold projector can still fold', () => {
    const plan = planOverlayChainFold(chain(80), seg(79), {
      minChain: 4, budget: 8, segmentCeiling: 1, windowEntities: 1,
      entityCountOf: () => undefined,
    })
    // Every segment would be sealed if `undefined` counted as "large", and the
    // fold would refuse for ever on a projector that has not yet materialised
    // its segments — which after any restart is the normal state.
    expect(plan.fold).toHaveLength(8)
    expect(plan.foldAt).toBe(0)
  })

  it('is byte-identical to the old contract when no sizes are supplied', () => {
    const ids = chain(100)
    const plan = planOverlayChainFold(ids, seg(99), { minChain: 4, budget: 12 })
    expect(plan.fold).toEqual(chain(12))
    expect(plan.foldAt).toBe(0)
    expect(plan.windowEntities).toBeUndefined()
    // `fold.concat(tail)` is the canonical order — the invariant every caller
    // that cannot cheaply count entities still relies on.
    expect([...plan.fold, ...plan.tail]).toEqual(canonicalOverlayDocumentIds(ids, seg(99)))
  })

  it('the shipped constants satisfy the chain ceiling for the reference landscape', () => {
    // Not `toBe(1024)`: the point is the RELATION, which is what breaks when
    // somebody moves one number. A sealed run holds ceil(D / ceiling) segments,
    // and `overlay-chain-bounded` refuses past 256.
    expect(OVERLAY_CHAIN_FOLD_WINDOW_ENTITIES).toBeGreaterThanOrEqual(2 * OVERLAY_SEGMENT_ENTITY_CEILING)
    const REFERENCE_LANDSCAPE = 11_935
    // IMPORTED, not restated: local literals for `OVERLAY_CHAIN_CEILING` and
    // `MIN_CHAIN` would let a change to `OVERLAY_CHAIN_FOLD_MIN` — the knob
    // that actually PRODUCES the chain ceiling — pass unnoticed.
    expect(Math.ceil(REFERENCE_LANDSCAPE / OVERLAY_SEGMENT_ENTITY_CEILING))
      .toBeLessThan(OVERLAY_CHAIN_CEILING - OVERLAY_CHAIN_FOLD_MIN - 1)
  })
})

describe('splitMergedOverlaySegment (A11)', () => {
  const merged = (n: number) => Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`e${i}`, { id: `e${i}` }]),
  )

  it('bounds every part and loses nothing', () => {
    const parts = splitMergedOverlaySegment(merged(2_500), 1_000)
    expect(parts).toHaveLength(3)
    expect(parts.map((p) => Object.keys(p).length)).toEqual([1_000, 1_000, 500])
    const ids = parts.flatMap((p) => Object.keys(p))
    expect(ids).toHaveLength(2_500)
    // EXACTLY ONCE, which is why the split is order-safe at all: the merge has
    // already resolved last-wins, so no part can outrank another for any id.
    expect(new Set(ids).size).toBe(2_500)
  })

  it('returns ONE empty part rather than none', () => {
    // MUTANT: `[]`. A caller that substitutes the result would then remove the
    // window and put nothing back — shortening the chain by deleting history
    // the GC still owns.
    expect(splitMergedOverlaySegment({}, 100)).toEqual([{}])
  })

  it('never emits a zero-sized part for a nonsense bound', () => {
    expect(splitMergedOverlaySegment(merged(3), 0)).toHaveLength(3)
    expect(splitMergedOverlaySegment(merged(3), -5)).toHaveLength(3)
  })
})

// The contiguity invariant is enforced by `substituteOverlayPrefix`, and its
// tests live beside it in `overlayChainFoldPass.test.ts` — including gapped
// windows that would invert last-wins order, and the head-mid-list case that a
// pure positional helper could never get right.
