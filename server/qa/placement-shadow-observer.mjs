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
import { AsyncLocalStorage } from 'node:async_hooks'

export const PLACEMENT_SELECT = 'SELECT landscape_id, version_id, partition FROM workspace_placement WHERE topology_generation = $1'
const normalize = sql => typeof sql === 'string' ? sql.trim().replace(/\s+/g, ' ') : null

/** Bench-only observation of the existing methods and their Promise results.
 * This module never supplies query results or calls a reconciliation itself.
 * Hooks return the original result; observation failures invalidate the log,
 * without replacing a business exception or making a rejected query succeed.
 */
export function installPlacementShadowObserver({ Coordinator, ownableSql, emit, metadata,
  timers = globalThis, monotonic = () => process.hrtime.bigint().toString(), maxRows = 128 }) {
  const prototype = Coordinator.prototype
  const names = ['start', 'reconcileNow', 'performReconcile', 'comparePlacementShadow']
  for (const name of names) assert.equal(typeof prototype[name], 'function', `Missing hook: ${name}`)
  assert.equal(typeof emit, 'function')
  assert.ok(Number.isInteger(maxRows) && maxRows > 0 && maxRows <= 128)
  assert.equal(typeof metadata.runId, 'string')
  const originals = Object.fromEntries(names.map(name => [name, prototype[name]]))
  const wrappers = {}
  const contexts = new AsyncLocalStorage()
  const instances = new WeakMap()
  const states = []
  const intervals = new WeakMap()
  const nativeInterval = timers.setInterval
  let activeTick = null, activeCall = null, phase = 0, eventSequence = 0, fault = null

  function invalidate(error) { fault ??= error instanceof Error ? error.name : String(error) }
  function safely(action) { try { action() } catch (error) { invalidate(error) } }
  function publish(record) {
    safely(() => {
      assert.ok(eventSequence < 10000, 'Observer event bound exceeded')
      const event = { schema: 'maplespire-placement-shadow/v1', ...metadata,
        sequence: ++eventSequence, monotonic: monotonic(), utc: new Date().toISOString(),
        observerFault: fault, ...record }
      assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 65536, 'Observer record bound exceeded')
      if (emit(event) !== true) invalidate('output-backpressure')
    })
  }
  function after(value, onFulfilled, onRejected) {
    safely(() => {
      assert.ok(value instanceof Promise, 'Observed method must return its native Promise')
      // Both reactions are contained: the discarded observation Promise cannot
      // reject, and the caller still receives the original Promise below.
      value.then(result => safely(() => onFulfilled(result)), error => safely(() => onRejected(error)))
    })
    return value
  }
  const gauge = owner => ({ divergence: owner.placementDivergenceCount, compared: owner.placementRowsCompared })
  const identity = owner => ({ cellId: owner.config.cellId, generation: owner.config.topologyGeneration,
    mode: owner.config.placementMode, partitionCount: owner.config.partitionCount,
    partitionIndex: owner.partitionLease?.partition ?? null,
    partitionAcquisitionCount: owner.partitionAcquisitionCount, partitionLossCount: owner.partitionLossCount,
    errorCount: owner.errorCount, passAbandonedCount: owner.passAbandonedCount })
  function keys(workspaces) {
    assert.ok(Array.isArray(workspaces) && workspaces.length <= maxRows, 'Workspace bound exceeded')
    return workspaces.map(workspace => {
      assert.equal(typeof workspace.landscapeId, 'string')
      assert.equal(typeof workspace.versionId, 'string')
      assert.ok(workspace.landscapeId.length <= 256 && workspace.versionId.length <= 256)
      return { landscapeId: workspace.landscapeId, versionId: workspace.versionId }
    })
  }
  function copyRows(rows, kind) {
    assert.ok(Array.isArray(rows) && rows.length <= maxRows, 'Query row bound exceeded')
    return rows.map(row => {
      const result = keys([{ landscapeId: row.landscape_id, versionId: kind === 'placement' ? row.version_id : row.id }])[0]
      if (kind === 'placement') {
        assert.ok(typeof row.partition === 'number' || typeof row.partition === 'string')
        assert.ok(Number.isSafeInteger(Number(row.partition)))
        result.partition = Number(row.partition)
      }
      return result
    })
  }
  function stateFor(owner) {
    let state = instances.get(owner)
    if (state) return state
    assert.equal(states.length, 0, 'Exactly one coordinator per cell process is expected')
    assert.ok(owner.db && typeof owner.db.query === 'function')
    state = { owner, passSequence: 0, tickSequence: 0, querySequence: 0, active: new Set(),
      db: owner.db, originalQuery: owner.db.query, timerBound: false }
    state.queryWrapper = function (...args) {
      const context = contexts.getStore()
      const sql = normalize(args[0])
      const kind = sql === normalize(ownableSql) ? 'discovery' : sql === PLACEMENT_SELECT ? 'placement' : null
      if (!context || context.state !== state || !kind) return Reflect.apply(state.originalQuery, this, args)
      let query
      safely(() => {
        const prepared = { id: ++state.querySequence, kind, start: monotonic(), outcome: 'pending',
          parameters: kind === 'placement' ? Array.isArray(args[1]) ? [...args[1]] : null : [] }
        context.pass.queries.push(prepared)
        query = prepared
      })
      if (!query) return Reflect.apply(state.originalQuery, this, args)
      const finished = (outcome, value) => {
        query.end = monotonic()
        query.outcome = outcome
        if (outcome === 'fulfilled') query.rows = copyRows(value.rows, kind)
        else query.error = { name: value?.name ?? null, code: value?.code ?? null }
      }
      let result
      try { result = Reflect.apply(state.originalQuery, this, args) }
      catch (error) { safely(() => finished('rejected', error)); throw error }
      return after(result, value => finished('fulfilled', value), error => finished('rejected', error))
    }
    state.db.query = state.queryWrapper
    instances.set(owner, state)
    states.push(state)
    return state
  }

  timers.setInterval = function (callback, ...args) {
    // Keep the native handle: unref/clearInterval retain their original target.
    if (typeof callback !== 'function') return Reflect.apply(nativeInterval, this, [callback, ...args])
    let handle
    const record = { state: null }
    const wrapped = function (...callbackArgs) {
      const previous = activeTick
      activeTick = record.state ? { state: record.state, id: ++record.state.tickSequence, consumed: false } : null
      try { return Reflect.apply(callback, this, callbackArgs) }
      finally { activeTick = previous }
    }
    handle = Reflect.apply(nativeInterval, this, [wrapped, ...args])
    intervals.set(handle, record)
    return handle
  }
  const intervalWrapper = timers.setInterval
  wrappers.start = function (...args) {
    let state
    safely(() => { state = stateFor(this) })
    const result = Reflect.apply(originals.start, this, args)
    return after(result, () => {
      assert.ok(state)
      const interval = intervals.get(this.reconcileTimer)
      assert.ok(interval, 'The native reconcile interval was not observed')
      assert.ok(!interval.state || interval.state === state)
      interval.state = state
      state.timerBound = true
      publish({ event: 'timer-bound', phase, ...identity(this), reconcileIntervalMs: this.config.reconcileIntervalMs })
    }, error => publish({ event: 'start-rejected', phase, error: { name: error?.name ?? null, code: error?.code ?? null } }))
  }
  wrappers.reconcileNow = function (...args) {
    const state = instances.get(this)
    const token = activeTick && activeTick.state === state && !activeTick.consumed ? activeTick : null
    if (token) token.consumed = true
    const previous = activeCall
    activeCall = { state, origin: token ? 'timer' : 'other', tick: token?.id ?? null }
    safely(() => {
      if (token && this.reconcileFlight) publish({ event: 'coalesced-tick', phase, tick: token.id, cellId: this.config.cellId })
    })
    try { return Reflect.apply(originals.reconcileNow, this, args) }
    finally { activeCall = previous }
  }
  wrappers.performReconcile = function (...args) {
    const state = instances.get(this)
    if (!state) { invalidate('unobserved-coordinator'); return Reflect.apply(originals.performReconcile, this, args) }
    const call = activeCall?.state === state ? activeCall : null
    let pass
    safely(() => {
      const prepared = { id: ++state.passSequence, origin: call?.origin ?? 'other', tick: call?.tick ?? null,
        phase, start: monotonic(), before: identity(this), gaugeBefore: gauge(this), queries: [], comparisons: [] }
      state.active.add(prepared.id)
      pass = prepared
      publish({ event: 'pass-start', cellId: this.config.cellId, passId: pass.id,
        phase, origin: pass.origin, tick: pass.tick })
    })
    if (!pass) return Reflect.apply(originals.performReconcile, this, args)
    const finish = (outcome, error) => {
      state.active.delete(pass.id)
      pass.end = monotonic()
      pass.endPhase = phase
      pass.outcome = outcome
      if (error) pass.error = { name: error.name ?? null, code: error.code ?? null }
      publish({ event: 'pass-end', cellId: this.config.cellId, pass,
        after: identity(this), gaugeAfter: gauge(this), timerBound: state.timerBound })
    }
    let result
    try { result = contexts.run({ state, pass }, () => Reflect.apply(originals.performReconcile, this, args)) }
    catch (error) { safely(() => finish('rejected', error)); throw error }
    return after(result, () => finish('fulfilled'), error => finish('rejected', error))
  }
  wrappers.comparePlacementShadow = function (...args) {
    const context = contexts.getStore()
    let comparison = null
    safely(() => {
      assert.ok(context && context.state.owner === this, 'Comparison outside its real pass')
      comparison = { start: monotonic(), workspaces: keys(args[0]), before: gauge(this) }
      context.pass.comparisons.push(comparison)
    })
    const result = Reflect.apply(originals.comparePlacementShadow, this, args)
    return after(result, () => {
      assert.ok(comparison)
      comparison.end = monotonic()
      comparison.outcome = 'fulfilled'
      comparison.after = gauge(this)
    }, error => {
      assert.ok(comparison)
      comparison.end = monotonic()
      comparison.outcome = 'rejected'
      comparison.error = { name: error?.name ?? null, code: error?.code ?? null }
    })
  }
  for (const name of names) prototype[name] = wrappers[name]
  publish({ event: 'installed', phase })
  return {
    markPhase() {
      phase += 1
      publish({ event: 'phase-marker', phase, states: states.map(state => ({ cellId: state.owner.config.cellId,
        passSequence: state.passSequence, tickSequence: state.tickSequence, activePasses: [...state.active] })) })
      return phase
    },
    stats() { return { phase, eventSequence, fault, coordinators: states.length,
      activePasses: states.reduce((sum, state) => sum + state.active.size, 0) } },
    dispose() {
      assert.ok(states.every(state => state.active.size === 0), 'An observed pass is still running')
      assert.equal(timers.setInterval, intervalWrapper)
      for (const name of names) assert.equal(prototype[name], wrappers[name])
      for (const state of states) assert.equal(state.db.query, state.queryWrapper)
      timers.setInterval = nativeInterval
      for (const name of names) prototype[name] = originals[name]
      for (const state of states) state.db.query = state.originalQuery
      contexts.disable()
    },
  }
}
