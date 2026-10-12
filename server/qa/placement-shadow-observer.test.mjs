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

import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { installPlacementShadowObserver, PLACEMENT_SELECT } from './placement-shadow-observer.mjs'

// This control class exercises the observer contract only. It is neither a
// product coordinator nor a Redis/PG replacement for the native bench.
// Its timers are native; its supplied query values are explicit test inputs.
const OWNABLE = "SELECT landscape_id, id FROM versions WHERE status = 'active'"
const GENERATION = 'observer-control.ce1461953e2b8ac2'
const KEYS = Object.freeze([
  Object.freeze({ landscapeId: 'land-a', versionId: 'version-a' }),
  Object.freeze({ landscapeId: 'land-b', versionId: 'version-b' }),
])
const METHODS = ['start', 'reconcileNow', 'performReconcile', 'comparePlacementShadow']

async function waitFor(predicate, message) {
  const deadline = performance.now() + 2_000
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message)
    await delay(2)
  }
}

function control(t, options = {}) {
  const calls = { start: [], reconcile: [], perform: [], compare: [], query: [], tick: [] }
  const events = [], deferreds = []
  const tokens = Object.freeze({ start: {}, pass: {}, comparison: {}, argument: {} })
  const discovered = Object.freeze({ rows: Object.freeze(KEYS.map(key => Object.freeze({ landscape_id: key.landscapeId, id: key.versionId }))) })
  const placements = Object.freeze({ rows: Object.freeze(KEYS.map((key, index) => Object.freeze({ landscape_id: key.landscapeId, version_id: key.versionId, partition: String(index) }))) })
  const timers = { setInterval: globalThis.setInterval }
  const nativeInterval = timers.setInterval
  const record = (kind, receiver, args, invoke) => {
    const call = { receiver, args }
    calls[kind].push(call)
    try { call.result = invoke(); return call.result }
    catch (error) { call.error = error; throw error }
  }
  class Coordinator {
    constructor() {
      this.config = { cellId: 'cell-control', topologyGeneration: GENERATION, placementMode: 'shadow',
        partitionCount: 2, reconcileIntervalMs: options.intervalMs ?? 60_000 }
      this.partitionLease = { partition: 0 }
      this.partitionAcquisitionCount = 1
      this.partitionLossCount = 2
      this.errorCount = 3
      this.passAbandonedCount = 4
      this.placementDivergenceCount = null
      this.placementRowsCompared = null
      this.reconcileFlight = null
      this.reconcileTimer = null
      this.db = { query: function (...args) {
        return record('query', this, args, () => options.query
          ? options.query(this, args)
          : Promise.resolve(args[0] === OWNABLE ? discovered : placements))
      } }
    }
    start(...args) {
      return record('start', this, args, () => {
        if (options.start) return options.start(this, args)
        const owner = this
        this.reconcileTimer = timers.setInterval(function (...tickArgs) {
          return record('tick', this, tickArgs, () => options.tick
            ? options.tick(owner, tickArgs)
            : owner.reconcileNow('timer', tokens.argument).catch(() => {}))
        }, this.config.reconcileIntervalMs, tokens.argument)
        this.reconcileTimer.unref()
        return Promise.resolve(tokens.start)
      })
    }
    reconcileNow(...args) {
      return record('reconcile', this, args, () => {
        if (options.reconcile) return options.reconcile(this, args)
        if (this.reconcileFlight) return this.reconcileFlight
        const running = this.performReconcile(...args)
        this.reconcileFlight = running
        const clear = () => { if (this.reconcileFlight === running) this.reconcileFlight = null }
        running.then(clear, clear)
        return running
      })
    }
    performReconcile(...args) {
      return record('perform', this, args, () => options.perform ? options.perform(this, args) : (async () => {
        const value = await this.db.query(OWNABLE)
        await this.comparePlacementShadow(value.rows.map(row => ({ landscapeId: row.landscape_id, versionId: row.id })), tokens.argument)
        return tokens.pass
      })())
    }
    comparePlacementShadow(...args) {
      return record('compare', this, args, () => options.compare ? options.compare(this, args) : (async () => {
        await this.db.query(PLACEMENT_SELECT, [GENERATION])
        this.placementRowsCompared = args[0].length
        this.placementDivergenceCount = 1
        return tokens.comparison
      })())
    }
  }
  const originals = Object.fromEntries(METHODS.map(name => [name, Coordinator.prototype[name]]))
  const owner = new Coordinator(), originalQuery = owner.db.query
  const observer = installPlacementShadowObserver({ Coordinator, ownableSql: OWNABLE, timers,
    emit(event) {
      events.push(structuredClone(event))
      return options.emit ? options.emit(event) : true
    }, metadata: { runId: 'observer-contract-only', pid: process.pid, threadId: 0 },
    ...(options.monotonic ? { monotonic: options.monotonic } : {}),
    ...(options.maxRows ? { maxRows: options.maxRows } : {}) })
  let disposed = false
  const dispose = () => { observer.dispose(); disposed = true }
  const deferred = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    deferreds.push(resolve)
    return { promise, resolve, reject }
  }
  t.after(async () => {
    clearInterval(owner.reconcileTimer)
    for (const release of deferreds) release(undefined)
    await Promise.allSettled(calls.perform.map(call => call.result).filter(value => value instanceof Promise))
    await Promise.resolve()
    if (!disposed) dispose()
  })
  return { owner, Coordinator, originals, originalQuery, nativeInterval, timers, observer, events, calls,
    tokens, discovered, placements, deferred, dispose }
}

test('observer preserves native Promises, this, arguments and query objects while recording a completed comparison', async t => {
  const fixture = control(t)
  const { owner, observer, calls, tokens, events } = fixture
  const start = owner.start(tokens.argument)
  assert.equal(start, calls.start[0].result)
  assert.equal(await start, tokens.start)
  const running = owner.reconcileNow(tokens.argument, KEYS)
  assert.equal(running, calls.reconcile[0].result)
  assert.equal(running, calls.perform[0].result)
  assert.equal(await running, tokens.pass)
  assert.equal(await calls.compare[0].result, tokens.comparison)
  assert.equal(await calls.query[0].result, fixture.discovered)
  assert.equal(await calls.query[1].result, fixture.placements)
  assert.equal(fixture.placements.rows[0].partition, '0', 'Observation must not convert the original row')
  for (const kind of ['start', 'reconcile', 'perform', 'compare']) {
    assert.equal(calls[kind].length, 1)
    assert.equal(calls[kind][0].receiver, owner)
  }
  assert.equal(calls.start[0].args[0], tokens.argument)
  assert.equal(calls.perform[0].args[0], tokens.argument)
  assert.equal(calls.perform[0].args[1], KEYS)
  assert.equal(calls.compare[0].args[1], tokens.argument)
  assert.equal(calls.query.length, 2)
  assert.ok(calls.query.every(call => call.receiver === owner.db))
  const ending = events.find(event => event.event === 'pass-end')
  assert.ok(ending)
  assert.equal(ending.pass.origin, 'other')
  assert.equal(ending.pass.outcome, 'fulfilled')
  assert.deepEqual(ending.pass.queries.map(query => [query.kind, query.outcome]), [['discovery', 'fulfilled'], ['placement', 'fulfilled']])
  assert.deepEqual(ending.pass.queries[1].parameters, [GENERATION])
  assert.deepEqual(ending.pass.queries[1].rows, KEYS.map((key, index) => ({ ...key, partition: index })))
  assert.deepEqual(ending.pass.comparisons[0].workspaces, KEYS)
  assert.deepEqual(ending.gaugeAfter, { divergence: 1, compared: 2 })
  assert.equal(ending.after.errorCount, 3)
  assert.equal(ending.after.passAbandonedCount, 4)
  assert.equal(ending.after.generation, GENERATION)
  assert.equal(ending.after.mode, 'shadow')
  assert.equal(observer.stats().fault, null)
  assert.equal(observer.stats().activePasses, 0)
})

test('observer preserves unrelated query arguments without logging their parameters', async t => {
  const argument = Object.freeze({ privateControlValue: 'unrelated-parameter-sentinel' })
  const result = Object.freeze({ rows: [] })
  const fixture = control(t, { query: () => Promise.resolve(result),
    perform: owner => owner.db.query('SELECT unrelated_control($1)', [argument]) })
  await fixture.owner.start()
  const outside = fixture.owner.db.query('SELECT unrelated_control($1)', [argument])
  assert.equal(outside, fixture.calls.query[0].result)
  assert.equal(await outside, result)
  assert.equal(await fixture.owner.reconcileNow(), result)
  assert.equal(fixture.calls.query.length, 2)
  assert.ok(fixture.calls.query.every(call => call.args[1][0] === argument))
  assert.deepEqual(fixture.events.find(event => event.event === 'pass-end').pass.queries, [])
  assert.ok(!JSON.stringify(fixture.events).includes(argument.privateControlValue))
})

for (const method of ['start', 'reconcile', 'perform', 'compare', 'query']) {
  for (const failure of ['throw', 'reject']) {
    test(`observer preserves the exact ${method} ${failure} and invokes business code once`, async t => {
      const sentinel = Object.assign(new Error(`business-${method}-${failure}`), { code: 'CONTROL_ERROR' })
      const options = { [method]: () => { if (failure === 'throw') throw sentinel; return Promise.reject(sentinel) } }
      if (method === 'compare') options.perform = owner => owner.comparePlacementShadow(KEYS)
      if (method === 'query') options.perform = owner => owner.db.query(PLACEMENT_SELECT, [GENERATION])
      const fixture = control(t, options)
      if (method !== 'start') await fixture.owner.start()
      const invoke = () => method === 'start' ? fixture.owner.start(fixture.tokens.argument) : fixture.owner.reconcileNow(fixture.tokens.argument)
      if (failure === 'throw') assert.throws(invoke, error => error === sentinel)
      else {
        const promise = invoke()
        assert.equal(promise, fixture.calls[method][0].result)
        await assert.rejects(promise, error => error === sentinel)
      }
      assert.equal(fixture.calls[method].length, 1)
      assert.equal(fixture.calls[method][0].receiver, method === 'query' ? fixture.owner.db : fixture.owner)
      assert.equal(fixture.observer.stats().activePasses, 0)
    })
  }
}

test('a real interval keeps its native handle and coalesces ticks into one actual pending pass', async t => {
  let held
  const fixture = control(t, { intervalMs: 5, perform: () => held.promise })
  held = fixture.deferred()
  await fixture.owner.start()
  assert.equal(typeof fixture.owner.reconcileTimer.unref, 'function')
  await waitFor(() => fixture.events.filter(event => event.event === 'coalesced-tick').length >= 2, 'Native interval did not produce coalesced ticks')
  clearInterval(fixture.owner.reconcileTimer)
  assert.equal(fixture.calls.perform.length, 1)
  assert.ok(fixture.calls.reconcile.length >= 3)
  assert.ok(fixture.calls.reconcile.every(call => call.result === held.promise))
  assert.ok(fixture.calls.tick.every(call => call.receiver === fixture.owner.reconcileTimer && call.args[0] === fixture.tokens.argument))
  assert.equal(fixture.events.filter(event => event.event === 'pass-end').length, 0)
  const beginning = fixture.events.find(event => event.event === 'pass-start')
  assert.equal(beginning.origin, 'timer')
  assert.equal(beginning.tick, 1)
  const ticks = fixture.events.filter(event => event.event === 'coalesced-tick').map(event => event.tick)
  assert.equal(new Set(ticks).size, ticks.length)
  held.resolve(fixture.tokens.pass)
  await held.promise
  await Promise.resolve()
  const endings = fixture.events.filter(event => event.event === 'pass-end')
  assert.equal(endings.length, 1)
  assert.equal(endings[0].pass.id, beginning.passId)
  assert.ok(BigInt(endings[0].pass.end) >= BigInt(endings[0].pass.start))
  assert.equal(fixture.observer.stats().fault, null)
})

test('timer origin does not leak through await, microtask or timeout callbacks', async t => {
  let finished = false, callbackError
  const fixture = control(t, { intervalMs: 5, perform: () => Promise.resolve('control-pass'),
    tick: async owner => {
      clearInterval(owner.reconcileTimer)
      try {
        const direct = owner.reconcileNow('direct')
        await direct
        await owner.reconcileNow('after-await')
        await new Promise(resolve => queueMicrotask(resolve))
        await owner.reconcileNow('after-microtask')
        await delay(0)
        await owner.reconcileNow('after-timeout')
      } catch (error) { callbackError = error }
      finally { finished = true }
    } })
  await fixture.owner.start()
  await waitFor(() => finished, 'Asynchronous native timer callback did not finish')
  assert.equal(callbackError, undefined)
  assert.equal(fixture.calls.perform.length, 4)
  assert.deepEqual(fixture.calls.perform.map(call => call.args[0]), ['direct', 'after-await', 'after-microtask', 'after-timeout'])
  assert.deepEqual(fixture.events.filter(event => event.event === 'pass-end').map(event => event.pass.origin), ['timer', 'other', 'other', 'other'])
  assert.equal(fixture.observer.stats().fault, null)
})

test('phase markers expose active passes and dispose refuses them before restoring exact hooks', async t => {
  let held
  const fixture = control(t, { perform: () => held.promise })
  held = fixture.deferred()
  await fixture.owner.start()
  assert.equal(fixture.observer.markPhase(), 1)
  const pending = fixture.owner.reconcileNow()
  assert.equal(fixture.observer.markPhase(), 2)
  const marker = fixture.events.filter(event => event.event === 'phase-marker').at(-1)
  assert.deepEqual(marker.states[0].activePasses, [1])
  assert.equal(marker.states[0].passSequence, 1)
  assert.throws(() => fixture.observer.dispose(), /still running/)
  assert.notEqual(fixture.timers.setInterval, fixture.nativeInterval)
  assert.notEqual(fixture.owner.db.query, fixture.originalQuery)
  held.resolve(fixture.tokens.pass)
  assert.equal(await pending, fixture.tokens.pass)
  const ending = fixture.events.find(event => event.event === 'pass-end')
  assert.equal(ending.pass.phase, 1)
  assert.equal(ending.pass.endPhase, 2)
  fixture.dispose()
  assert.equal(fixture.timers.setInterval, fixture.nativeInterval)
  assert.equal(fixture.owner.db.query, fixture.originalQuery)
  for (const method of METHODS) assert.equal(fixture.Coordinator.prototype[method], fixture.originals[method])
})

for (const location of ['pass', 'query', 'comparison']) {
  test(`a clock failure during ${location} preparation does not suppress the business call`, async t => {
    let broken = false
    const value = Object.freeze({ rows: [] })
    const fixture = control(t, { monotonic: () => { if (broken) throw new Error('clock-control'); return process.hrtime.bigint().toString() },
      query: () => Promise.resolve(value), compare: () => Promise.resolve(value),
      perform: owner => {
        if (location === 'pass') return Promise.resolve(value)
        broken = true
        try { return location === 'query' ? owner.db.query(PLACEMENT_SELECT, [GENERATION]) : owner.comparePlacementShadow(KEYS) }
        finally { broken = false }
      } })
    await fixture.owner.start()
    if (location === 'pass') broken = true
    const running = fixture.owner.reconcileNow()
    broken = false
    assert.equal(running, fixture.calls.perform[0].result)
    assert.equal(await running, value)
    assert.equal(fixture.calls.perform.length, 1)
    if (location === 'query') assert.equal(fixture.calls.query.length, 1)
    if (location === 'comparison') assert.equal(fixture.calls.compare.length, 1)
    assert.notEqual(fixture.observer.stats().fault, null)
  })
}

test('an identity getter failure cannot prevent reconciliation delegation', async t => {
  const result = Promise.resolve(Object.freeze({ business: 'still-ran' }))
  const fixture = control(t, { perform: () => result })
  await fixture.owner.start()
  Object.defineProperty(fixture.owner, 'partitionLossCount', { get() { throw new Error('identity-control') }, configurable: true })
  assert.equal(fixture.owner.reconcileNow(), result)
  await result
  assert.equal(fixture.calls.perform.length, 1)
  assert.notEqual(fixture.observer.stats().fault, null)
})

for (const failure of ['throw', 'backpressure']) {
  test(`an emit ${failure} invalidates observation without preventing business work`, async t => {
    const fixture = control(t, { emit: () => { if (failure === 'throw') throw new Error('emit-control'); return false } })
    assert.equal(await fixture.owner.start(), fixture.tokens.start)
    assert.equal(await fixture.owner.reconcileNow(), fixture.tokens.pass)
    assert.equal(fixture.calls.perform.length, 1)
    assert.equal(fixture.calls.compare.length, 1)
    assert.equal(fixture.calls.query.length, 2)
    assert.notEqual(fixture.observer.stats().fault, null)
  })
}

for (const malformed of ['rows-not-array', 'invalid-partition', 'too-many-rows']) {
  test(`invalid observed ${malformed} does not replace the original query result`, async t => {
    const rows = malformed === 'rows-not-array' ? null : malformed === 'invalid-partition'
      ? [{ landscape_id: 'land', version_id: 'version', partition: 'not-an-integer' }]
      : KEYS.map(key => ({ landscape_id: key.landscapeId, version_id: key.versionId, partition: 0 }))
    const returned = Object.freeze({ rows })
    const fixture = control(t, { maxRows: malformed === 'too-many-rows' ? 1 : 128,
      query: () => Promise.resolve(returned), perform: owner => owner.db.query(PLACEMENT_SELECT, [GENERATION]) })
    await fixture.owner.start()
    const running = fixture.owner.reconcileNow()
    assert.equal(running, fixture.calls.query[0].result)
    assert.equal(await running, returned)
    assert.equal(fixture.calls.query.length, 1)
    assert.notEqual(fixture.observer.stats().fault, null)
  })
}

test('invalid comparison keys invalidate observation while preserving the original call and result', async t => {
  const result = Promise.resolve(Object.freeze({ acceptedByControl: true }))
  const fixture = control(t, { maxRows: 1, compare: () => result, perform: owner => owner.comparePlacementShadow(KEYS) })
  await fixture.owner.start()
  assert.equal(fixture.owner.reconcileNow(), result)
  await result
  assert.equal(fixture.calls.compare.length, 1)
  assert.equal(fixture.calls.compare[0].args[0], KEYS)
  assert.notEqual(fixture.observer.stats().fault, null)
})
