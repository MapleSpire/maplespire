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

import assert from 'node:assert/strict'
import test from 'node:test'
import { dedicatedWindowPercentiles, summarizeDedicatedWindow } from './sync-cell-dedicated-window.mjs'

function input() {
  // Release in [140,180], acquisition in [190,225], COMMIT in [100,110].
  // Fixed evidence brackets deliberately do not derive from implementation constants.
  const raw = [
    [70, 80, 1, 0], [140, 150, 1, 0], [170, 180, 0, 0],
    [190, 200, 0, 0], [210, 225, 0, 1], [240, 250, 0, 1],
  ]
  return { commit: { startedAtMs: 100, completedAtMs: 110 },
    sourceCellId: 'failover-cell-a', targetCellId: 'failover-cell-c',
    samples: raw.map(([start, end, a, c]) => ({ readings: [
      { cellId: 'failover-cell-a', startedAtMs: start, completedAtMs: end, ownedWorkspaceCount: a },
      { cellId: 'failover-cell-b', startedAtMs: start, completedAtMs: end, ownedWorkspaceCount: 0 },
      { cellId: 'failover-cell-c', startedAtMs: start, completedAtMs: end, ownedWorkspaceCount: c },
    ] })) }
}

test('separates COMMIT reaction from local ownerless bounds using request intervals', () => {
  const result = summarizeDedicatedWindow(input())
  assert.deepEqual(result.release, { lowerMs: 140, upperMs: 180 })
  assert.deepEqual(result.acquisition, { lowerMs: 190, upperMs: 225 })
  assert.deepEqual(result.commitToLocalOwnerMs, { lowerMs: 80, upperMs: 125 })
  assert.deepEqual(result.signedLocalHandoffGapMs, { lowerMs: 10, upperMs: 85 })
  assert.equal(result.roundsWithThreeZeroResponses, 2)
  assert.equal(result.roundsWithTwoOwnerResponses, 0)
  assert.equal(result.maxRequestSpanMs, 15)
  assert.equal(result.maxBetweenPassGapMs, 60)
})

test('slow requests widen the result instead of being timestamped at their end', () => {
  const fixture = input()
  fixture.samples[4].readings[2].completedAtMs = 239
  const result = summarizeDedicatedWindow(fixture)
  assert.equal(result.commitToLocalOwnerMs.upperMs, 139)
  assert.equal(result.localOwnerlessGapIfReleasePrecedesAcquireMs.upperMs, 99)
  assert.equal(result.maxRequestSpanMs, 29)
})

test('overlapping transition brackets disclose ambiguity and preserve the signed interval', () => {
  const fixture = input()
  fixture.samples[2].readings[2].ownedWorkspaceCount = 1
  fixture.samples[3].readings[2].ownedWorkspaceCount = 1
  const result = summarizeDedicatedWindow(fixture)
  assert.deepEqual(result.signedLocalHandoffGapMs, { lowerMs: -40, upperMs: 40 })
  assert.deepEqual(result.localOwnerlessGapIfReleasePrecedesAcquireMs, { lowerMs: 0, upperMs: 40 })
  assert.equal(result.roundsWithThreeZeroResponses, 0)
  assert.deepEqual(result.possibleLocalOverlapMs, { lowerMs: 0, upperMs: 40 })
  assert.equal(result.localOrderAtSampleResolution, 'indeterminate')
})

test('a request bracket crossing COMMIT retains its negative signed lower bound', () => {
  const fixture = input()
  for (const sample of fixture.samples.slice(1)) sample.readings[2].ownedWorkspaceCount = 1
  const result = summarizeDedicatedWindow(fixture)
  assert.deepEqual(result.signedCommitToLocalOwnerMs, { lowerMs: -40, upperMs: 50 })
  assert.deepEqual(result.commitToLocalOwnerMs, { lowerMs: 0, upperMs: 50 })
  assert.equal(result.localOrderAtSampleResolution, 'indeterminate')
})

for (const [label, alter] of [
  ['missing third cell', x => x.samples[1].readings.pop()],
  ['duplicate cell', x => { x.samples[1].readings[1].cellId = 'failover-cell-a' }],
  ['missing ownership count', x => { delete x.samples[1].readings[1].ownedWorkspaceCount }],
  ['third cell owning', x => { x.samples[1].readings[1].ownedWorkspaceCount = 1 }],
  ['negative request interval', x => { x.samples[1].readings[0].completedAtMs = 130 }],
  ['overlapping same-cell requests', x => { x.samples[1].readings[0].startedAtMs = 75 }],
  ['late COMMIT timestamp', x => { x.commit = { startedAtMs: 230, completedAtMs: 231 } }],
  ['reversed COMMIT', x => { x.commit.completedAtMs = 99 }],
  ['missing pre-move witness', x => { x.samples[0].readings[2].ownedWorkspaceCount = 1 }],
  ['ownership returns to source', x => { x.samples[4].readings[0].ownedWorkspaceCount = 1 }],
  ['no destination transition', x => { for (const s of x.samples) s.readings[2].ownedWorkspaceCount = 0 }],
  ['one post-move witness only', x => x.samples.pop()],
  ['certain local ownership overlap', x => {
    for (const sample of x.samples.slice(1)) sample.readings[2].ownedWorkspaceCount = 1
    x.samples[2].readings[0].ownedWorkspaceCount = 1
    x.samples[3].readings[0].ownedWorkspaceCount = 1
  }],
]) test('rejects ' + label, () => {
  const fixture = input()
  alter(fixture)
  assert.throws(() => summarizeDedicatedWindow(fixture))
})

test('nearest-rank p95 keeps both bounds and D52 uncertainty', () => {
  const windows = Array.from({ length: 20 }, (_, i) => ({
    commitToLocalOwnerMs: { lowerMs: i * 100, upperMs: i * 100 + 20 },
    localOwnerlessGapIfReleasePrecedesAcquireMs: { lowerMs: i, upperMs: i + 10 },
  }))
  const result = dedicatedWindowPercentiles(windows)
  assert.deepEqual(result.commitToLocalOwnerP95Ms, { lowerMs: 1800, upperMs: 1820 })
  assert.deepEqual(result.conditionalLocalOwnerlessGapP95Ms, { lowerMs: 18, upperMs: 28 })
  assert.equal(result.d52ReactionBudget, 'within')
  for (const window of windows) window.commitToLocalOwnerMs = { lowerMs: 2990, upperMs: 3010 }
  assert.equal(dedicatedWindowPercentiles(windows).d52ReactionBudget, 'uncertain')
  for (const window of windows) window.commitToLocalOwnerMs = { lowerMs: 3001, upperMs: 3020 }
  assert.equal(dedicatedWindowPercentiles(windows).d52ReactionBudget, 'exceeded')
  assert.throws(() => dedicatedWindowPercentiles(windows.slice(1)))
})
