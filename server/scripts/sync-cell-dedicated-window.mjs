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

const cellIds = ['failover-cell-a', 'failover-cell-b', 'failover-cell-c']
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Bounds of LOCAL API ownership transitions on one host monotonic clock.
 * A response samples state somewhere between request start and body receipt.
 * These intervals do not timestamp a Redis release/acquire or make concurrent
 * HTTP responses simultaneous. Raw samples remain part of the gate's output.
 */
export function summarizeDedicatedWindow({ samples, commit, sourceCellId, targetCellId }) {
  assert.ok(cellIds.includes(sourceCellId) && cellIds.includes(targetCellId) && sourceCellId !== targetCellId,
    'The move needs two distinct known cells')
  assert.ok(time(commit?.startedAtMs) && time(commit?.completedAtMs)
    && commit.startedAtMs <= commit.completedAtMs, 'Invalid COMMIT interval')
  assert.ok(Array.isArray(samples) && samples.length >= 3, 'Not enough ownership samples')
  const byCell = Object.fromEntries(cellIds.map(id => [id, []]))
  const sampleSpans = []
  let roundsWithThreeZeroResponses = 0, roundsWithTwoOwnerResponses = 0
  for (const sample of samples) {
    assert.ok(Array.isArray(sample.readings) && sample.readings.length === 3, 'Every sample needs all three cells')
    assert.deepEqual(sample.readings.map(row => row.cellId).sort(), cellIds, 'Missing, duplicate or unknown cell')
    for (const row of sample.readings) {
      assert.ok(time(row.startedAtMs) && time(row.completedAtMs) && row.startedAtMs <= row.completedAtMs,
        'Invalid HTTP request interval')
      assert.ok(row.ownedWorkspaceCount === 0 || row.ownedWorkspaceCount === 1, 'Invalid local ownership count')
      const history = byCell[row.cellId]
      assert.ok(!history.length || history.at(-1).completedAtMs <= row.startedAtMs,
        'Requests for one cell must be sequential')
      history.push(row)
    }
    const owners = sample.readings.filter(row => row.ownedWorkspaceCount === 1)
    if (!owners.length) roundsWithThreeZeroResponses++
    if (owners.length > 1) roundsWithTwoOwnerResponses++
    assert.ok(owners.every(row => row.cellId === sourceCellId || row.cellId === targetCellId),
      'A third cell owned the measured workspace')
    sampleSpans.push({ start: Math.min(...sample.readings.map(row => row.startedAtMs)),
      end: Math.max(...sample.readings.map(row => row.completedAtMs)) })
  }
  function transition(cellId, before, after) {
    const rows = byCell[cellId]
    assert.equal(rows[0].ownedWorkspaceCount, before, 'Missing healthy pre-move ownership witness')
    const firstAfter = rows.findIndex(row => row.ownedWorkspaceCount === after)
    assert.ok(firstAfter > 0, 'Ownership transition was not observed')
    assert.ok(rows.slice(firstAfter).every(row => row.ownedWorkspaceCount === after),
      'Ownership changed back inside the measured move')
    assert.ok(rows.length - firstAfter >= 2, 'Two stable post-move observations are required')
    assert.ok(rows[0].completedAtMs <= commit.startedAtMs, 'Baseline must finish before COMMIT is sent')
    return { lowerMs: rows[firstAfter - 1].startedAtMs, upperMs: rows[firstAfter].completedAtMs }
  }
  const release = transition(sourceCellId, 1, 0)
  const acquisition = transition(targetCellId, 0, 1)
  assert.ok(release.upperMs >= commit.startedAtMs && acquisition.upperMs >= commit.startedAtMs,
    'A pre-COMMIT transition cannot qualify the requested move')
  const signedReaction = { lowerMs: acquisition.lowerMs - commit.completedAtMs,
    upperMs: acquisition.upperMs - commit.startedAtMs }
  const reaction = { lowerMs: Math.max(0, signedReaction.lowerMs), upperMs: signedReaction.upperMs }
  // Keep the signed interval too: local snapshots do not establish the order
  // of release and acquisition when their possible intervals overlap.
  const signedGap = { lowerMs: acquisition.lowerMs - release.upperMs,
    upperMs: acquisition.upperMs - release.lowerMs }
  assert.ok(signedGap.upperMs >= 0, 'Samples establish local destination ownership before source release')
  const nonnegativeGap = { lowerMs: Math.max(0, signedGap.lowerMs), upperMs: signedGap.upperMs }
  const overlap = { lowerMs: Math.max(0, -signedGap.upperMs), upperMs: Math.max(0, -signedGap.lowerMs) }
  const gaps = sampleSpans.slice(1).map((span, i) => span.start - sampleSpans[i].end)
  assert.ok(gaps.every(gap => gap >= 0), 'Sampling passes must be sequential')
  return { sourceCellId, targetCellId, commit, release, acquisition,
    signedCommitToLocalOwnerMs: signedReaction, commitToLocalOwnerMs: reaction,
    signedLocalHandoffGapMs: signedGap, possibleLocalOverlapMs: overlap,
    localOrderAtSampleResolution: signedGap.lowerMs > 0 ? 'release-before-acquire' : 'indeterminate',
    localOwnerlessGapIfReleasePrecedesAcquireMs: nonnegativeGap,
    samples: samples.length, roundsWithThreeZeroResponses, roundsWithTwoOwnerResponses,
    maxRequestSpanMs: Math.max(...sampleSpans.map(span => span.end - span.start)),
    maxBetweenPassGapMs: Math.max(0, ...gaps),
    caveat: 'Request brackets of local API counts, conditional on a single transition per cell. Unobserved reversals remain possible. No exact Redis event time or continuous absence is claimed; the nonnegative gap assumes release precedes acquire.' }
}

/** Nearest-rank p95, retaining uncertainty rather than selecting a midpoint. */
export function dedicatedWindowPercentiles(windows) {
  assert.ok(Array.isArray(windows) && windows.length >= 20, 'At least twenty qualified moves are required')
  const percentile = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
  const bounds = key => {
    const intervals = windows.map(window => window[key])
    assert.ok(intervals.every(value => time(value?.lowerMs) && time(value?.upperMs)
      && value.lowerMs <= value.upperMs), 'Invalid interval in percentile input')
    return { lowerMs: percentile(intervals.map(value => value.lowerMs)),
      upperMs: percentile(intervals.map(value => value.upperMs)) }
  }
  const reaction = bounds('commitToLocalOwnerMs')
  return { samples: windows.length, convention: 'nearest rank: sorted[ceil(0.95 * n) - 1]',
    commitToLocalOwnerP95Ms: reaction,
    conditionalLocalOwnerlessGapP95Ms: bounds('localOwnerlessGapIfReleasePrecedesAcquireMs'),
    d52BudgetMs: 3000,
    d52ReactionBudget: reaction.lowerMs > 3000 ? 'exceeded' : reaction.upperMs <= 3000 ? 'within' : 'uncertain' }
}
