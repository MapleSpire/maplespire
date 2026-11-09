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
import { planOrdinaryChainFold, substituteFoldedRun } from './ordinaryChainFoldWriter.js'

const plan = (overrides: Partial<Parameters<typeof planOrdinaryChainFold>[0]> = {}) => planOrdinaryChainFold({
  shardUrls: ['base', 'h0', 'h1', 'h2', 'h3', 'cur'],
  overlayUrls: ['h0', 'h1', 'h2', 'h3', 'cur'],
  currentUrl: 'cur',
  foldable: () => true,
  entityCountOf: () => 1,
  minChain: 2,
  budget: 8,
  segmentCeiling: 1_000,
  windowEntities: 1_000,
  ...overrides,
})

describe('planOrdinaryChainFold', () => {
  it('folds the OLDEST run of foldable heads, never the current head nor a base shard', () => {
    expect(plan()).toEqual({ fold: ['h0', 'h1', 'h2', 'h3'] })
  })

  it('stops at the budget', () => {
    expect(plan({ budget: 2 })).toEqual({ fold: ['h0', 'h1'] })
  })

  it('a budget under two still folds two: one segment is no fold', () => {
    expect(plan({ budget: 1 })).toEqual({ fold: ['h0', 'h1'] })
  })

  it('waits below the threshold, counting only FOLDABLE heads', () => {
    expect(plan({ minChain: 5 })).toEqual({ fold: [], skippedReason: 'chain-below-threshold' })
    expect(plan({ minChain: 3, foldable: (url) => url !== 'h1' && url !== 'h2' }))
      .toEqual({ fold: [], skippedReason: 'chain-below-threshold' })
  })

  it('a run is broken by a head that is not foldable, and the next run is taken', () => {
    expect(plan({ foldable: (url) => url !== 'h1' })).toEqual({ fold: ['h2', 'h3'] })
  })

  it('no run of two: nothing to fold', () => {
    expect(plan({ foldable: (url) => url === 'h0' || url === 'h2' }))
      .toEqual({ fold: [], skippedReason: 'no-foldable-run' })
  })

  it('a run must be contiguous in the READ order: a base shard between two heads breaks it', () => {
    expect(plan({
      shardUrls: ['h0', 'base', 'h1', 'cur'], overlayUrls: ['h0', 'h1', 'cur'],
    })).toEqual({ fold: [], skippedReason: 'no-foldable-run' })
  })

  it('and contiguous in the OVERLAY list too: heads adjacent in one list but not the other are not a run', () => {
    expect(plan({
      shardUrls: ['h0', 'h1', 'h2', 'cur'], overlayUrls: ['h0', 'h2', 'h1', 'cur'],
    })).toEqual({ fold: [], skippedReason: 'no-foldable-run' })
  })

  it('a shard not in the overlay list is never a candidate', () => {
    expect(plan({ overlayUrls: ['h2', 'h3', 'cur'] })).toEqual({ fold: ['h2', 'h3'] })
  })

  it('a run broken by OVERLAY order restarts AT the breaking head, which may begin the next run', () => {
    // h0 starts a run of one (h1 is not h0's next overlay entry); h1 then
    // begins [h1, h2]. Skipping past the breaking head would lose that run.
    expect(plan({
      shardUrls: ['h0', 'h1', 'h2', 'cur'], overlayUrls: ['h1', 'h2', 'h0', 'cur'],
    })).toEqual({ fold: ['h1', 'h2'] })
  })
})

describe('planOrdinaryChainFold — seal and window', () => {
  const sizes: Record<string, number> = { h0: 600, h1: 300, h2: 300, h3: 300 }
  const sized = (overrides: Partial<Parameters<typeof planOrdinaryChainFold>[0]> = {}) =>
    plan({ entityCountOf: (url) => sizes[url] ?? 0, segmentCeiling: 500, windowEntities: 700, ...overrides })

  it('a head at the ceiling is SEALED: never folded, and it breaks a run', () => {
    // h0 (600) is sealed; h1..h3 fold, within the window.
    expect(sized({ windowEntities: 1_000 })).toEqual({ fold: ['h1', 'h2', 'h3'] })
    expect(sized({ segmentCeiling: 600, windowEntities: 1_000 })).toEqual({ fold: ['h1', 'h2', 'h3'] })
    expect(sized({ segmentCeiling: 601, windowEntities: 2_000 })).toEqual({ fold: ['h0', 'h1', 'h2', 'h3'] })
  })

  it('sealed heads do not count towards the threshold', () => {
    expect(sized({ minChain: 4, windowEntities: 1_000 })).toEqual({ fold: [], skippedReason: 'chain-below-threshold' })
  })

  it('the WINDOW stops a run once two are in, never before', () => {
    // h1 + h2 = 600 fits 700; adding h3 would make 900.
    expect(sized()).toEqual({ fold: ['h1', 'h2'] })
    // Two always fold, even past the window: one segment is no fold.
    expect(sized({ windowEntities: 100 })).toEqual({ fold: ['h1', 'h2'] })
  })
})

describe('substituteFoldedRun', () => {
  it('replaces the run by the product at its slot', () => {
    expect(substituteFoldedRun(['b', 'h0', 'h1', 'c'], ['h0', 'h1'], 'P')).toEqual(['b', 'P', 'c'])
  })

  it.each([
    ['a source missing', ['b', 'h0', 'c'], ['h0', 'h1']],
    ['the run out of order', ['b', 'h1', 'h0', 'c'], ['h0', 'h1']],
    ['the run broken', ['h0', 'b', 'h1'], ['h0', 'h1']],
    ['the product already listed', ['P', 'h0', 'h1'], ['h0', 'h1']],
  ])('refuses %s (null)', (_label, list, sources) => {
    expect(substituteFoldedRun(list, sources, 'P')).toBeNull()
  })
})
