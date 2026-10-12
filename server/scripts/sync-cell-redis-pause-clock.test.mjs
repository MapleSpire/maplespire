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
import { readFileSync } from 'node:fs'
import * as clockModel from './sync-cell-redis-pause-clock.mjs'
import { analyzeRedisPauseClock, calibrateObservationClock, classifyLeaseInterval } from './sync-cell-redis-pause-clock.mjs'

const t0 = Date.parse('2026-09-06T12:00:00.000Z')
const iso = ms => new Date(t0 + ms).toISOString()
const offset = 300
const clock = (at, delay = 10) => ({
  requestedAt: at, requestedMonoAt: at, at: at + delay, monoAt: at + delay,
  generatedAt: iso(at + offset + 5),
})
function fixture() {
  const times = [100, 200, 1100, 1300, 1440, 1500, 1800, 2200, 2300]
  const cells = [{ service: 'cell-a', id: 'a'.repeat(64) }, { service: 'cell-b', id: 'b'.repeat(64) }]
  const samples = times.map(at => {
    const lost = at >= 1440 && at < 2100
    return { t: at,
      a: { state: { ...clock(at), status: 200, partitionIndex: lost ? null : 0, ready: !lost, partitionLossCount: at >= 1440 ? 1 : 0 } },
      b: { state: { ...clock(at), status: 200, partitionIndex: null, ready: false, partitionLossCount: 0 } },
      engineClock: { ...clock(at), version: '29.7.2' },
    }
  })
  return { t0, pauseStartedAt: t0 + 1000, pausedAt: t0 + 1020, unpauseStartedAt: t0 + 2000,
    unpausedAt: t0 + 2100, samples, cells,
    logs: { 'cell-a': { containerId: cells[0].id,
      lossLines: [`${iso(1430 + offset)} [sync-cell] partition-worker-redis-unavailable failed: Error: partition lease keeper lost authority`] } },
  }
}

function baselineFixture() {
  return { t0, checkedAt: 300, checkedMonoAt: 300, samplePeriodMs: 50,
    samples: fixture().samples.filter(s => s.t <= 200) }
}

test('baseline admission uses real completed clocks without inventing outage phases', () => {
  const result = clockModel.analyzeRedisPauseBaseline(baselineFixture())
  assert.equal(result.valid, true, JSON.stringify(result))
  assert.equal(result.wallMonotonicToleranceMs, 2)
  assert.equal(result.sources.a.completed, 2)
  assert.equal(result.sources.engine.pending, 0)
  assert.equal(result.sources.a.latestRequestAgeMs, 100)
  assert.equal(result.sources.a.maxAgeMs, 100)
  assert.equal(result.sources.engine.maxAgeMs, 400)
  assert.equal(result.verdict, undefined, 'admission is not a lease verdict')
})

test('baseline refuses earlier clock steps, current clock steps, stale requests and missing witnesses', () => {
  for (const mutate of [
    input => { input.samples[0].a.state.monoAt += 2.001 },
    input => { input.checkedMonoAt += 2.001 },
    input => { input.checkedAt += 1; input.checkedMonoAt += 1 },
    input => { input.samples[1].a.state.at = 299; input.samples[1].a.state.monoAt = 299; input.checkedAt = 301; input.checkedMonoAt = 301 },
    input => { input.samples[1].engineClock = { pending: true } },
    input => { input.samples[0].a.state.error = 'timeout' },
    input => { input.samples[0].engineClock.version = '30.0.0' },
    input => { input.samples.forEach(s => { s.b.state.generatedAt = iso(s.t + 800) }) },
  ]) {
    const input = baselineFixture(); mutate(input)
    assert.equal(clockModel.analyzeRedisPauseBaseline(input).valid, false)
  }
})

test('pending observations are disclosed without replacing or cancelling their original records', () => {
  const input = baselineFixture()
  input.samples.push({ t: 300, a: { state: { pending: true } }, b: { state: { pending: true } }, engineClock: { pending: true } })
  const before = structuredClone(input)
  const result = clockModel.analyzeRedisPauseBaseline(input)
  assert.equal(result.valid, true, JSON.stringify(result))
  for (const value of Object.values(result.sources)) {
    assert.equal(value.pending, 1)
    assert.equal(value.completed, 2)
  }
  assert.deepEqual(input, before)
})

test('archived C5 baseline already refuses admission; archived C4 baseline is compatible, not requalified', () => {
  for (const [campaign, expected] of [[4, true], [5, false]]) {
    const report = JSON.parse(readFileSync(new URL(`./fixtures/redis-pause-baseline/campaign${campaign}.observation.json`, import.meta.url), 'utf8'))
    // Replay only records completed by this pre-pause cutoff. The current pair
    // is a synthetic neutral control, not a new measurement of the old host.
    const cutoff = 1_990
    const samples = structuredClone(report.samples.filter(s => s.t < cutoff))
    for (const sample of samples) {
      for (const key of ['a', 'b']) if (sample[key].state.at > cutoff) sample[key].state = { pending: true }
      if (sample.engineClock?.at > cutoff) sample.engineClock = { pending: true }
    }
    const result = clockModel.analyzeRedisPauseBaseline({ t0: Date.parse(report.summary.t0Iso),
      samples, checkedAt: cutoff, checkedMonoAt: cutoff, samplePeriodMs: 50 })
    assert.equal(result.valid, expected, JSON.stringify(result))
    if (!expected) assert.ok(result.issues.some(issue => issue.includes('wall clock differs')))
  }
})

test('clock intervals retain asymmetric round-trip uncertainty instead of midpoint offset', () => {
  const records = [100, 200, 1100, 1200, 2200, 2300].map(at => clock(at, 40))
  const c = calibrateObservationClock(records, { t0, pauseBegin: 1000, resumeAck: 2100 })
  assert.equal(c.valid, true)
  assert.deepEqual(c.offsetMs, { lower: 264, upper: 306 })
  assert.deepEqual([c.before, c.during, c.after], [2, 2, 2])
})

test('exact threshold is inclusive and fractions are not rounded into a PASS', () => {
  assert.equal(classifyLeaseInterval(470, 475), 'PASS')
  assert.equal(classifyLeaseInterval(470, 475.001), 'INCONCLUSIVE')
  assert.equal(classifyLeaseInterval(475.001, 500), 'FAIL')
  assert.equal(classifyLeaseInterval(475, 500), 'INCONCLUSIVE')
  assert.equal(classifyLeaseInterval(480, 475), 'INVALID')
  assert.equal(classifyLeaseInterval(null, 475), 'INVALID')
})

test('RFC3339Nano may omit fractional trailing zeros, including the entire fraction', () => {
  const records = [100, 200, 1100, 1200, 2200, 2300].map(at => ({ ...clock(at),
    generatedAt: iso(at + 800).replace(/0+Z$/, 'Z').replace('.Z', 'Z') }))
  assert.ok(records.some(record => !record.generatedAt.includes('.')))
  assert.equal(calibrateObservationClock(records, { t0, pauseBegin: 1000, resumeAck: 2100 }).valid, true)
})

test('exchanges crossing the outage constrain offset but cannot supply during-pause witnesses', () => {
  const trips = [[100, 102], [400, 402], [900, 3100], [950, 3150], [3200, 3202], [3400, 3402]]
  const records = trips.map(([s, r]) => ({ requestedAt: s, at: r, requestedMonoAt: s, monoAt: r, generatedAt: iso(s + 201) }))
  const result = calibrateObservationClock(records, { t0, pauseBegin: 1000, pauseAck: 1020, resumeBegin: 3000, resumeAck: 3020 })
  assert.deepEqual(result.offsetMs, { lower: 198, upper: 202 })
  assert.equal(result.during, 0)
  assert.equal(result.ambiguous, 2)
  assert.equal(result.valid, false)
})

test('qualified full-line log gives an upper from pause BEGIN, keeping every candidate', () => {
  const result = analyzeRedisPauseClock(fixture())
  assert.equal(result.valid, true, JSON.stringify(result.issues))
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.initialOwner, 'a')
  assert.deepEqual(result.transition.candidates, { httpArrival: 451, generatedAt: 451, completeWorkerLossLog: 437 })
  assert.equal(result.transition.upperMs, 437)
  assert.equal(result.transition.lowerMs, 279)
})

test('slow HTTP delivery does not move a source timestamp or the independent log upper', () => {
  const data = fixture()
  const state = data.samples.find(s => s.t === 1440).a.state
  state.at += 400; state.monoAt += 400
  const result = analyzeRedisPauseClock(data)
  assert.equal(result.valid, true, JSON.stringify(result.issues))
  assert.equal(result.transition.candidates.generatedAt, 452, 'source upper retains quantization when the tighter arrival upper is delayed')
  assert.equal(result.transition.upperMs, 437)
  assert.equal(result.transition.candidates.httpArrival, 511)
})

test('record array and response arrival order are not transition order', () => {
  const data = fixture()
  data.samples.reverse()
  assert.deepEqual(analyzeRedisPauseClock(data), analyzeRedisPauseClock(fixture()))
})

test('a broad interval remains inconclusive and observed late ownership proves failure', () => {
  for (const [lastOwned, firstNull, expected] of [[1400, 1500, 'INCONCLUSIVE'], [1500, 1550, 'FAIL']]) {
    const data = fixture()
    data.samples[3] = { ...data.samples[3], a: { state: { ...clock(lastOwned), status: 200, partitionIndex: 0, ready: true, partitionLossCount: 0 } } }
    data.samples[4].a.state = { ...clock(firstNull), status: 200, partitionIndex: null, ready: false, partitionLossCount: 1 }
    data.samples[5].a.state = { ...clock(firstNull + 30), status: 200, partitionIndex: null, ready: false, partitionLossCount: 1 }
    data.logs['cell-a'].lossLines[0] = `${iso(firstNull + offset)} [sync-cell] partition-worker-redis-unavailable failed: Error: partition lease keeper lost authority`
    const result = analyzeRedisPauseClock(data)
    assert.equal(result.verdict, expected, JSON.stringify(result))
  }
})

test('missing, malformed, normalized date, failed or reversed clock samples invalidate evidence', () => {
  for (const mutate of [
    s => { delete s.generatedAt }, s => { s.generatedAt = null }, s => { s.generatedAt = '2026-02-30T12:00:00.000Z' },
    s => { s.generatedAt = '123' }, s => { s.error = 'timeout' }, s => { s.at = s.requestedAt - 1 },
  ]) {
    const data = fixture(); mutate(data.samples[0].a.state)
    assert.equal(analyzeRedisPauseClock(data).verdict, 'INVALID')
  }
})

test('observed clock steps, incompatible cell clocks and a host wall step are invalid', () => {
  for (const mutate of [
    data => { data.samples.at(-1).a.state.generatedAt = iso(9999) },
    data => { data.samples.forEach(s => { s.b.state.generatedAt = iso(s.t + 1000) }) },
    data => { data.samples[2].engineClock.monoAt -= 10 },
  ]) {
    const data = fixture(); mutate(data)
    assert.equal(analyzeRedisPauseClock(data).verdict, 'INVALID')
  }
})

test('absent baseline, missing recovery calibration and unaudited Engine cannot produce PASS', () => {
  for (const mutate of [
    data => { data.samples = data.samples.filter(s => s.t > 200) },
    data => { data.samples = data.samples.filter(s => s.t < 2200) },
    data => { data.samples[1].engineClock.version = '30.0.0' },
    data => { data.samples[1].engineClock = null },
    data => { delete data.samples[0].engineClock; delete data.samples[1].engineClock },
  ]) {
    const data = fixture(); mutate(data)
    assert.equal(analyzeRedisPauseClock(data).verdict, 'INVALID')
  }
})

test('rebound, multiple loss counter increments, or standby takeover refuse attribution', () => {
  for (const mutate of [
    data => { Object.assign(data.samples[6].a.state, { partitionIndex: 0, ready: true, partitionLossCount: 0 }) },
    data => { data.samples[4].a.state.partitionLossCount = 2 },
    data => { Object.assign(data.samples[4].b.state, { partitionIndex: 0, ready: true }) },
    data => { Object.assign(data.samples[1].b.state, { partitionIndex: 0, ready: true }) },
  ]) {
    const data = fixture(); mutate(data)
    assert.equal(analyzeRedisPauseClock(data).verdict, 'INVALID')
  }
})

test('missing, duplicate, old, truncated or misattributed loss logs are invalid', () => {
  for (const mutate of [
    log => { log.lossLines = [] }, log => { log.lossLines.push(log.lossLines[0]) },
    log => { log.lossLines = {} },
    log => { log.lossLines[0] = log.lossLines[0].replace(iso(1730), iso(900)) },
    log => { log.lossLines[0] = log.lossLines[0].slice(0, -5) },
    log => { log.containerId = 'c'.repeat(64) },
    log => { log.lossLines[0] += String.fromCharCode(0) },
  ]) {
    const data = fixture(); mutate(data.logs['cell-a'])
    assert.equal(analyzeRedisPauseClock(data).verdict, 'INVALID')
  }
})
