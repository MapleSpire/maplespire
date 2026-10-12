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

/**
 * Pins the compaction-scale measurement's own controls.
 *
 * The cases below are the bogus results each control must reject. The harness
 * is run by no gate, so without this file nothing checks that its controls can
 * still fail.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  growsWithScale,
  foldToEmptyRatioGrows,
  segmentsPartitionTheCall,
  RATIO_GROWTH_FACTOR,
} from './m7-controls.mjs'

test('growth control: accepts real growth, rejects flat and rejects shrinking', () => {
  assert.equal(growsWithScale(47.6, 240.5), true, 'the measured pair must pass')
  assert.equal(growsWithScale(100, 100), false, 'an instrument returning the same number at both ends measures itself')
  // Guards against `largest > smallest` weakened to `largest > 0`, which would
  // declare a decreasing series (57 -> 53.2) as growing.
  assert.equal(growsWithScale(57, 53.2), false, 'a DECREASING series must never be declared growth')
})

test('growth control: a missing scale is a FAILED control, not a passed one', () => {
  // A child that died writes no row. The parent must not skip the scale and
  // publish the rest; `null` has to read as failure on either side.
  assert.equal(growsWithScale(115.5, null), false)
  assert.equal(growsWithScale(null, 240.5), false)
  assert.equal(growsWithScale(undefined, undefined), false)
  assert.equal(growsWithScale(1, Number.NaN), false)
  assert.equal(growsWithScale(1, Number.POSITIVE_INFINITY), false)
})

test('ratio control: growth in the fold/empty ratio passes, a FLAT ratio does not', () => {
  assert.equal(foldToEmptyRatioGrows(9.7, 95.4), true, 'the measured pair must pass')
  // The hypothesis being excluded is "compactMs is a constant": against it the
  // ratio is flat WHATEVER its value, so a large flat ratio must still fail.
  assert.equal(foldToEmptyRatioGrows(50, 50), false)
  assert.equal(foldToEmptyRatioGrows(1000, 1000), false)
  assert.equal(foldToEmptyRatioGrows(9.7, 3 * 9.7), false, 'exactly the factor is not MORE than the factor')
  assert.equal(foldToEmptyRatioGrows(9.7, 3 * 9.7 + 0.1), true)
})

test('ratio control: the factor is a named constant, and a zero denominator is not growth', () => {
  assert.equal(RATIO_GROWTH_FACTOR, 3)
  assert.equal(foldToEmptyRatioGrows(0, 1000), false, 'dividing by an unmeasured empty pass is not evidence')
  assert.equal(foldToEmptyRatioGrows(-1, 1000), false)
  assert.equal(foldToEmptyRatioGrows(null, 95.4), false)
})

test('partition control: the segments must fit inside the call they were timed in', () => {
  assert.equal(segmentsPartitionTheCall(3117.1, 3118.6), true, 'the measured pair must pass')
  assert.equal(segmentsPartitionTheCall(3118.6, 3118.6), true, 'equality is the exact-fit case')
  // The middle segment computed from `performance.now()` instead of the
  // re-attach's start instant: a 4 918 ms window for a ~2 200 ms call.
  assert.equal(segmentsPartitionTheCall(4918.3, 2184.4), false)
  assert.equal(segmentsPartitionTheCall(null, 100), false)
})
