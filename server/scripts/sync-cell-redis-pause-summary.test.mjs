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
import { test } from 'node:test'
import { summarizeRedisPauseObservation } from './sync-cell-redis-pause-summary.mjs'

function sample(t, readyAt, stateAt, routerAt, paused) {
  return {
    t, phase: 'deliberately-wrong',
    ...Object.fromEntries(['a', 'b'].map((key) => [key, {
      ready: { at: readyAt, status: paused ? 503 : 200, checks: { redis: !paused, syncCellConverged: !paused && key === 'a' } },
      state: { at: stateAt, status: 200, partitionIndex: paused || key === 'b' ? null : 0, ready: !paused && key === 'a' },
    }])),
    router: { at: routerAt, status: paused ? 503 : 200, body: { checks: { redis: !paused } } },
  }
}

function fixture() {
  return {
    label: 'controlled-arrivals', t0: 10_000,
    pauseStartedAt: 11_000, pausedAt: 11_100, unpauseStartedAt: 13_000, unpausedAt: 13_200,
    samples: [
      sample(100, 200, 210, 220, false),
      sample(1_300, 1_900, 1_410, 1_800, true),
      // A LATER tick whose replies arrive FIRST. A .find over request order
      // falsely reports 800 ms instead of 700 ms for readiness.
      sample(1_500, 1_800, 1_510, 1_750, true),
      sample(3_300, 3_400, 3_410, 3_420, false),
    ],
  }
}

test('arrival minima, not request order, determine both windows and the completed gate batch', () => {
  const input = fixture()
  const result = summarizeRedisPauseObservation(input)
  assert.equal(result.measurementValid, true, result.measurementIssues.join('; '))
  assert.equal(result.perCell.a.firstReady503AfterPauseMs, 700)
  assert.equal(result.perCell.a.firstPartitionNullAfterPauseMs, 310)
  assert.equal(result.router.firstReady503AfterPauseMs, 650)
  assert.equal(result.gateFirstHeldAtMs, 1_800)
  assert.equal(result.gateFirstHeldTickMs, 1_500)
  assert.equal(result.perCell.a.firstReady200AfterUnpauseMs, 200)
  assert.equal(result.perCell.b.convergedCheckBeforePause.false, 1)
  assert.equal(result.pauseCommandDurationMs, 100)
  assert.equal(result.unpauseCommandDurationMs, 200)
  const shuffled = summarizeRedisPauseObservation({ ...input, samples: [...input.samples].reverse() })
  assert.deepEqual(shuffled, result)
})

test('arrivals within pause/unpause command intervals are transitional and cannot certify a window', () => {
  const input = fixture()
  input.samples.push(sample(900, 1_020, 1_030, 1_040, true))
  input.samples.push(sample(2_900, 3_020, 3_030, 3_040, false))
  const result = summarizeRedisPauseObservation(input)
  assert.equal(result.measurementValid, true)
  assert.equal(result.perCell.a.firstReady503AfterPauseMs, 700)
  assert.equal(result.perCell.a.firstReady200AfterUnpauseMs, 200)
  assert.deepEqual(result.perCell.a.arrivalCounts.transition, { ready: 2, state: 2 })
})

test('the tick phase is not the arrival phase: a pre-pause request may answer during the pause', () => {
  const input = fixture()
  input.samples.push(sample(900, 1_200, 1_210, 1_220, true))
  const result = summarizeRedisPauseObservation(input)
  assert.equal(result.perCell.a.firstReady503AfterPauseMs, 100)
  assert.equal(result.perCell.a.firstPartitionNullAfterPauseMs, 110)
  assert.equal(result.router.firstReady503AfterPauseMs, 120)
})

test('replies after unpause never count as paused, even when every request was sent during it', () => {
  const input = fixture()
  input.samples = [input.samples[0], sample(1_300, 3_500, 3_510, 3_520, true), input.samples[3]]
  const result = summarizeRedisPauseObservation(input)
  assert.equal(result.measurementValid, false)
  assert.equal(result.perCell.a.firstReady503AfterPauseMs, null)
  assert.equal(result.gateEverHeldDuringPause, false)
  assert.equal(result.router.firstReady503AfterPauseMs, null)
})

test('a timeout is an observation, never evidence of HTTP 503 or checks.redis=false', () => {
  const input = fixture()
  for (const s of input.samples.slice(1, 3)) {
    s.a.ready = { at: s.a.ready.at, error: 'timeout' }
    s.router = { at: s.router.at, error: 'timeout' }
  }
  const result = summarizeRedisPauseObservation(input)
  assert.equal(result.measurementValid, false)
  assert.equal(result.perCell.a.firstReady503AfterPauseMs, null)
  assert.equal(result.perCell.a.readyStatusesDuringPause.timeout, 2)
  assert.equal(result.router.firstReady503AfterPauseMs, null)
})

test('503/redis=false and null/not-ready each have to occur in the SAME response', () => {
  const input = fixture()
  input.samples[1].a.ready.checks.redis = true
  input.samples[2].a.ready.status = 200
  input.samples[1].b.state.ready = true
  input.samples[2].b.state.partitionIndex = 0
  const result = summarizeRedisPauseObservation(input)
  assert.equal(result.measurementValid, false)
  assert.equal(result.perCell.a.firstReady503AfterPauseMs, null)
  assert.equal(result.perCell.b.firstPartitionNullAfterPauseMs, null)
  assert.equal(result.gateEverHeldDuringPause, false)
})

test('missing or impossible timestamps invalidate the record rather than supplying zeroes', () => {
  for (const at of [undefined, null, NaN, 1_000]) {
    const input = fixture()
    input.samples[1].a.ready.at = at
    const result = summarizeRedisPauseObservation(input)
    assert.equal(result.measurementValid, false)
    assert.match(result.measurementIssues.join('; '), /arrival timestamp|arrival before request/)
  }
  const result = summarizeRedisPauseObservation({ ...fixture(), samples: [] })
  assert.equal(result.measurementValid, false)
  assert.equal(result.perCell.a.firstReady503AfterPauseMs, null)
  assert.equal(result.router.firstReady503AfterPauseMs, null)
})

test('missing or reversed transition boundaries invalidate the measurement, not the application', () => {
  for (const override of [{ pausedAt: null }, { unpauseStartedAt: 10_500 }]) {
    const result = summarizeRedisPauseObservation({ ...fixture(), ...override })
    assert.equal(result.measurementValid, false)
    assert.equal(result.gateEverHeldDuringPause, false)
    assert.match(result.measurementIssues.join('; '), /phase timestamps/)
  }
  assert.equal(summarizeRedisPauseObservation({ ...fixture(), error: 'output collection failed' }).measurementValid, false)
})
