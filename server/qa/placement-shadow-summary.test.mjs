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
import { summarizePlacementShadow } from './placement-shadow-summary.mjs'
import { installPlacementShadowObserver, PLACEMENT_SELECT } from './placement-shadow-observer.mjs'

const generation = 'maplespire-v1~2222222222222222'
const hashRows = [
  { landscapeId: 'default', versionId: 'root', partition: 0 },
  { landscapeId: 'fixture', versionId: 'model', partition: 1 },
]
const expectedRows = hashRows.map((row, index) => ({ ...row, partition: index === 0 ? 1 : row.partition }))
const sha = 'a'.repeat(64)

// Literal observer protocol fixture. No timers, product coordinator or SQL runs.
function stream(cellId, count, { rows = expectedRows, divergence = 1, close = true,
  endPhase = true, warmup = false } = {}) {
  let time = 0, phase = 0, passId = 0, tick = 0, queryId = 0
  const events = [], active = new Map()
  const monotonic = () => String(++time)
  const metadata = { runId: 't10h2-3176-summary-test', pid: 1, hostname: `container-${cellId}`, cellId,
    manifestSha256: sha, sourceHashes: { 'ownership.ts': sha }, hashes: { '/app/dist/ownership.js': sha } }
  const identity = () => ({ cellId, generation, mode: 'shadow', partitionCount: 2,
    partitionIndex: cellId === 'a' ? 0 : 1, partitionAcquisitionCount: 1,
    partitionLossCount: 0, errorCount: 0, passAbandonedCount: 0 })
  const gauge = () => ({ divergence, compared: rows.length })
  const emit = record => {
    const event = { schema: 'maplespire-placement-shadow/v1', ...metadata,
      sequence: events.length + 1, monotonic: monotonic(), utc: '2026-09-09T02:00:00.000Z',
      observerFault: null, ...record }
    events.push(event)
    return event
  }
  const mark = () => emit({ event: 'phase-marker', phase: ++phase,
    states: [{ cellId, passSequence: passId, tickSequence: tick, activePasses: [...active.keys()] }] })
  const begin = (origin = 'timer') => {
    const pass = { id: ++passId, origin, tick: origin === 'timer' ? ++tick : null,
      phase, start: monotonic(), before: identity(), gaugeBefore: gauge(), queries: [], comparisons: [] }
    active.set(pass.id, pass)
    emit({ event: 'pass-start', cellId, passId: pass.id, phase, origin, tick: pass.tick })
    return pass
  }
  const finish = pass => {
    const discovery = { id: ++queryId, kind: 'discovery', parameters: [], start: monotonic(),
      rows: rows.map(({ landscapeId, versionId }) => ({ landscapeId, versionId })), outcome: 'fulfilled' }
    discovery.end = monotonic()
    const comparison = { start: monotonic(), workspaces: structuredClone(discovery.rows), before: gauge() }
    const placement = { id: ++queryId, kind: 'placement', parameters: [generation], start: monotonic(),
      rows: structuredClone(rows), outcome: 'fulfilled' }
    placement.end = monotonic()
    comparison.end = monotonic()
    comparison.outcome = 'fulfilled'
    comparison.after = gauge()
    pass.queries.push(discovery, placement)
    pass.comparisons.push(comparison)
    pass.end = monotonic()
    pass.endPhase = phase
    pass.outcome = 'fulfilled'
    active.delete(pass.id)
    emit({ event: 'pass-end', cellId, pass, after: identity(), gaugeAfter: gauge(), timerBound: true })
  }
  const seal = () => emit({ event: 'closed', stats: { phase, eventSequence: events.length,
    fault: null, coordinators: 1, activePasses: active.size } })
  emit({ event: 'installed', phase })
  if (warmup) finish(begin('other'))
  emit({ event: 'timer-bound', phase, ...identity(), reconcileIntervalMs: 1000 })
  mark()
  for (let index = 0; index < count; index += 1) finish(begin())
  if (endPhase) mark()
  if (close) seal()
  return { events, begin, finish, mark, seal, emit }
}
function input(count = 100, options = {}) {
  return { eventsByCell: { a: stream('a', count, options).events, b: stream('b', count, options).events },
    expectedRows, hashRows, generation, phase: 1 }
}
const ends = events => events.filter(event => event.event === 'pass-end')
const last = events => events.at(-1)
function invalid(data, code) {
  const result = summarizePlacementShadow(data)
  assert.equal(result.verdict, 'invalid', JSON.stringify(result.reasons))
  assert.ok(result.reasons.some(reason => reason.code === code), JSON.stringify(result.reasons))
  assert.equal(result.final, false)
  return result
}
function resequence(events) {
  events.forEach((event, index) => { event.sequence = index + 1 })
  if (last(events)?.event === 'closed') last(events).stats.eventSequence = events.length - 1
}

test('100 paired protocol records qualify D=1, W=2 and zero cross-cell difference', () => {
  const result = summarizePlacementShadow(input())
  assert.equal(result.verdict, 'clean')
  assert.equal(result.final, true)
  assert.equal(result.samples, 100)
  assert.equal(result.pairs.length, 100)
  assert.equal(result.observationsByCell.a.length, 100)
  assert.equal(result.observationsByCell.b.length, 100)
  assert.equal(result.rowsCompared, 2)
  assert.equal(result.differentRows, 1)
  assert.equal(result.crossCellDivergence, 0)
  assert.deepEqual(result.reasons, [])
})

for (const count of [0, 99]) test(`${count} completed pairs cannot be published as 100`, () => {
  const result = summarizePlacementShadow(input(count))
  assert.equal(result.verdict, 'incomplete')
  assert.equal(result.samples, count)
  assert.ok(result.reasons.some(reason => reason.code === 'insufficient-completed-passes'))
})

test('asymmetric 100/99 streams remain incomplete', () => {
  const data = input()
  data.eventsByCell.b = stream('b', 99).events
  assert.equal(summarizePlacementShadow(data).verdict, 'incomplete')
})

test('zero intentional differences is void after actual fresh zero gauges', () => {
  const data = input(1, { rows: hashRows, divergence: 0 })
  data.expectedRows = hashRows
  data.samples = 1
  const result = summarizePlacementShadow(data)
  assert.equal(result.verdict, 'void')
  assert.equal(result.final, true)
  assert.equal(result.samples, 1)
  assert.equal(result.differentRows, 0)
})

test('zero observed gauge in the nontrivial arm is invalid', () => {
  const data = input()
  ends(data.eventsByCell.a)[0].pass.comparisons[0].after.divergence = 0
  invalid(data, 'comparison-gauge-differs')
})

test('SQL error with fulfilled comparison and stale correct gauge is invalid', () => {
  const data = input()
  const query = ends(data.eventsByCell.a)[3].pass.queries[1]
  query.outcome = 'rejected'
  query.error = { name: 'Error', code: '08006' }
  delete query.rows
  invalid(data, 'select-not-successful')
})

test('equal gauges cannot conceal distinct wrong vectors', () => {
  const data = input()
  ends(data.eventsByCell.b)[0].pass.queries[1].rows = hashRows.map(row => ({ ...row, partition: 0 }))
  invalid(data, 'selected-placement-vector-differs')
})

const mutations = [
  ['missing discovery', event => event.pass.queries.shift(), 'missing-or-extra-real-select'],
  ['missing comparison', event => { event.pass.comparisons = [] }, 'missing-or-extra-comparison'],
  ['wrong query generation', event => { event.pass.queries[1].parameters = ['old'] }, 'wrong-select-generation'],
  ['missing comparison workspace', event => event.pass.comparisons[0].workspaces.pop(), 'comparison-workspaces-differ'],
  ['missing discovery workspace', event => event.pass.queries[0].rows.pop(), 'discovered-workspaces-differ'],
  ['missing placement workspace', event => event.pass.queries[1].rows.pop(), 'selected-placement-vector-differs'],
  ['duplicate placement workspace', event => event.pass.queries[1].rows.push({ ...expectedRows[0] }), 'duplicate-workspace-key'],
  ['bad stored partition', event => { event.pass.queries[1].rows[0].partition = '1' }, 'invalid-partition'],
  ['wrong mode', event => { event.pass.before.mode = 'placed' }, 'unexpected-cell-identity'],
  ['wrong identity generation', event => { event.pass.before.generation = 'old' }, 'unexpected-cell-identity'],
  ['partition absent', event => { event.pass.before.partitionIndex = null }, 'partition-not-held'],
  ['new error in pass', event => { event.after.errorCount = 1 }, 'identity-or-counters-changed-in-pass'],
  ['new abandoned pass', event => { event.after.passAbandonedCount = 1 }, 'identity-or-counters-changed-in-pass'],
  ['missing counter', event => { delete event.pass.before.errorCount }, 'invalid-identity-counter'],
  ['late pass failure', event => { event.pass.outcome = 'rejected' }, 'reconcile-failed'],
  ['unbound timer', event => { event.timerBound = false }, 'not-a-bound-timer-pass'],
  ['stale gauge after pass', event => { event.gaugeAfter.compared = 1 }, 'pass-gauge-differs'],
  ['comparison error', event => { event.pass.comparisons[0].outcome = 'rejected' }, 'comparison-failed'],
  ['reversed query time', event => { event.pass.queries[1].end = '0' }, 'reversed-observation-time'],
]
for (const [name, mutate, code] of mutations) test(`${name} invalidates an armed phase`, () => {
  const data = input()
  mutate(ends(data.eventsByCell.a)[2])
  // Missing discovery otherwise first fails its independent query-id census.
  invalid(data, name === 'missing discovery' ? 'query-sequence-gap-or-duplicate' : code)
})

test('counter change between otherwise coherent passes is invalid', () => {
  const data = input()
  const event = ends(data.eventsByCell.a)[3]
  event.pass.before.errorCount = event.after.errorCount = 1
  invalid(data, 'identity-or-counters-changed-in-phase')
})

test('non-timer origin is invalid even with a fresh matching SELECT', () => {
  const data = input(1)
  for (const event of data.eventsByCell.a) {
    if (event.event === 'pass-start') { event.origin = 'other'; event.tick = null }
    if (event.event === 'pass-end') { event.pass.origin = 'other'; event.pass.tick = null }
    if (event.event === 'phase-marker' && event.phase === 2) event.states[0].tickSequence = 0
  }
  invalid(data, 'not-a-bound-timer-pass')
})

test('phase floor is checked against actual earlier events', () => {
  const data = input()
  data.eventsByCell.a.find(event => event.event === 'phase-marker').states[0].passSequence = 1
  invalid(data, 'phase-floor-differs')
})

test('mismatched phase at completion is rejected, not treated as a transition', () => {
  const data = input()
  ends(data.eventsByCell.a)[0].pass.endPhase = 2
  invalid(data, 'pass-end-phase-differs')
})

test('duplicate event and duplicate tick are rejected', () => {
  const data = input()
  data.eventsByCell.a.splice(5, 0, structuredClone(data.eventsByCell.a[4]))
  invalid(data, 'event-sequence-gap-or-duplicate')
  const second = input()
  second.eventsByCell.a.filter(event => event.event === 'pass-start')[1].tick = 1
  invalid(second, 'timer-tick-gap-or-duplicate')
})

test('duplicate pass ID is rejected despite complete global event sequences', () => {
  const data = input()
  data.eventsByCell.a.filter(event => event.event === 'pass-start')[1].passId = 1
  invalid(data, 'pass-sequence-gap-duplicate-or-overlap')
})

test('missing close is incomplete and progress can never be final clean', () => {
  const data = input(100, { close: false })
  const result = summarizePlacementShadow(data)
  assert.equal(result.verdict, 'incomplete')
  assert.ok(result.reasons.some(reason => reason.code === 'stream-not-closed'))
  const progress = summarizePlacementShadow({ ...input(), requireClosed: false })
  assert.equal(progress.samples, 100)
  assert.equal(progress.verdict, 'incomplete')
  assert.equal(progress.final, false)
  assert.ok(progress.reasons.some(reason => reason.code === 'progress-only-not-final'))
})

test('faulted and truncated closure cannot certify complete observations', () => {
  const data = input()
  last(data.eventsByCell.a).stats.fault = 'output-backpressure'
  invalid(data, 'closure-fault-or-coordinators')
  const other = input()
  last(other.eventsByCell.a).stats.eventSequence -= 1
  invalid(other, 'closure-sequence-or-phase-differs')
})

test('observer fault, source changes and same container are rejected', () => {
  const data = input()
  data.eventsByCell.a[5].observerFault = 'AssertionError'
  invalid(data, 'observer-fault')
  const source = input()
  source.eventsByCell.a[5] = { ...source.eventsByCell.a[5], manifestSha256: 'b'.repeat(64) }
  invalid(source, 'process-metadata-changed')
  const same = input()
  same.eventsByCell.b.forEach(event => { event.hostname = 'container-a' })
  invalid(same, 'same-container-hostname')
})

test('sources must also agree between two otherwise stable streams', () => {
  const data = input()
  data.eventsByCell.b.forEach(event => { event.hashes = { '/app/dist/ownership.js': 'b'.repeat(64) } })
  invalid(data, 'different-run-identities-or-sources')
})

test('warmup is retained but never counts toward the sample quota', () => {
  const data = input(99, { warmup: true })
  const result = summarizePlacementShadow(data)
  assert.equal(result.verdict, 'incomplete')
  assert.equal(result.samples, 99)
  assert.equal(result.cells.a.warmup, 1)
  assert.equal(result.cells.a.excludedPasses[0].phase, 0)
})

test('an actual transition is retained, with an unfinished later pass allowed at close', () => {
  const streams = ['a', 'b'].map(cellId => {
    const value = stream(cellId, 100, { close: false, endPhase: false })
    const transition = value.begin()
    value.mark()
    value.finish(transition)
    value.begin()
    value.seal()
    return value.events
  })
  const result = summarizePlacementShadow({ ...input(), eventsByCell: { a: streams[0], b: streams[1] } })
  assert.equal(result.verdict, 'clean', JSON.stringify(result.reasons))
  assert.equal(result.samples, 100)
  assert.equal(result.cells.a.transitions, 1)
  assert.equal(result.cells.a.activeAtClose, 1)
  assert.equal(result.cells.a.activePasses[0].phase, 2)
})

test('an unfinished target pass without a later marker remains incomplete', () => {
  const value = stream('a', 100, { close: false, endPhase: false })
  value.begin()
  value.seal()
  const data = input()
  data.eventsByCell.a = value.events
  const result = summarizePlacementShadow(data)
  assert.equal(result.verdict, 'incomplete')
  assert.equal(result.cells.a.pendingInPhase, 1)
})

test('a failure after the first 100 successes is not silently discarded', () => {
  const data = input(101)
  ends(data.eventsByCell.a)[100].pass.queries[1].outcome = 'rejected'
  invalid(data, 'select-not-successful')
})

test('extra healthy observations are retained outside the first 100 pairs', () => {
  const result = summarizePlacementShadow(input(101))
  assert.equal(result.verdict, 'clean')
  assert.equal(result.samples, 100)
  assert.equal(result.observationsByCell.a.length, 101)
})

test('removing a complete failed pass does not conceal the missing pass/query/tick sequence', () => {
  const data = input(101)
  data.eventsByCell.a = data.eventsByCell.a.filter(event => event.passId !== 4 && event.pass?.id !== 4)
  resequence(data.eventsByCell.a)
  invalid(data, 'timer-tick-gap-or-duplicate')
})

test('input arrays and rows are not sorted or mutated', () => {
  const data = input(1)
  data.samples = 1
  data.expectedRows = [...expectedRows].reverse()
  const before = structuredClone(data)
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  }
  freeze(data)
  assert.equal(summarizePlacementShadow(data).verdict, 'clean')
  assert.deepEqual(data, before)
})

test('invalid input and an absent second cell are not vacuous passes', () => {
  invalid({}, 'invalid-phase-or-closure-option')
  invalid({ ...input(), samples: 0 }, 'invalid-sample-count')
  const data = input()
  delete data.eventsByCell.b
  invalid(data, 'expected-exactly-two-cells')
  invalid({ ...input(), expectedRows: [] }, 'too-few-workspaces')
})

test('actual observer output round-trips through the summary using a synthetic coordinator', async () => {
  const eventsByCell = {}
  const ownableSql = "SELECT landscape_id, id FROM versions WHERE status = 'active'"
  for (const cellId of ['a', 'b']) {
    let callback, timer, time = 0
    const timers = { setInterval(fn) { callback = fn; timer = {}; return timer } }
    class Coordinator {
      config = { cellId, topologyGeneration: generation, placementMode: 'shadow',
        partitionCount: 2, reconcileIntervalMs: 1000 }
      partitionLease = { partition: cellId === 'a' ? 0 : 1 }
      partitionAcquisitionCount = 1
      partitionLossCount = 0
      errorCount = 0
      passAbandonedCount = 0
      placementDivergenceCount = null
      placementRowsCompared = 0
      reconcileFlight = null
      db = { async query(sql) {
        assert.ok(sql === ownableSql || sql === PLACEMENT_SELECT)
        return { rows: expectedRows.map(row => sql === ownableSql
          ? { landscape_id: row.landscapeId, id: row.versionId }
          : { landscape_id: row.landscapeId, version_id: row.versionId, partition: row.partition }) }
      } }
      async start() {
        await this.reconcileNow()
        this.reconcileTimer = timers.setInterval(() => this.reconcileNow(), 1000)
      }
      async reconcileNow() {
        if (this.reconcileFlight) return this.reconcileFlight
        const running = this.performReconcile().finally(() => { this.reconcileFlight = null })
        this.reconcileFlight = running
        return running
      }
      async performReconcile() {
        const { rows } = await this.db.query(ownableSql)
        await this.comparePlacementShadow(rows.map(row => ({ landscapeId: row.landscape_id, versionId: row.id })))
      }
      async comparePlacementShadow(workspaces) {
        const { rows } = await this.db.query(PLACEMENT_SELECT, [generation])
        this.placementRowsCompared = workspaces.length
        this.placementDivergenceCount = rows.filter((row, index) => row.partition !== hashRows[index].partition).length
      }
    }
    const events = []
    const metadata = { runId: 't10h2-3176-observer-protocol', pid: 1, cellId,
      hostname: `container-${cellId}`, manifestSha256: sha,
      sourceHashes: { 'synthetic-coordinator': sha }, hashes: { 'synthetic-coordinator': sha } }
    const observer = installPlacementShadowObserver({ Coordinator, ownableSql, timers, metadata,
      monotonic: () => String(++time), emit: record => { events.push(JSON.parse(JSON.stringify(record))); return true } })
    try {
      const owner = new Coordinator()
      await owner.start()
      observer.markPhase()
      await callback.call(timer)
      await callback.call(timer)
      observer.markPhase()
    } finally { observer.dispose() }
    const stats = observer.stats()
    events.push({ schema: 'maplespire-placement-shadow/v1', ...metadata, event: 'closed',
      sequence: stats.eventSequence + 1, stats, observerFault: stats.fault,
      monotonic: String(++time), utc: new Date().toISOString() })
    eventsByCell[cellId] = events
  }
  const result = summarizePlacementShadow({ eventsByCell, expectedRows, hashRows, generation, phase: 1, samples: 2 })
  assert.equal(result.verdict, 'clean', JSON.stringify(result.reasons))
  assert.equal(result.samples, 2)
  assert.equal(result.cells.a.warmup, 1)
  assert.equal(result.cells.a.transitions, 0)
})
