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
import { performance } from 'node:perf_hooks'
import { from, getHeads, save } from '@automerge/automerge'
import { interpretAsDocumentId } from '@automerge/automerge-repo'

/** The durability API accepts change hashes, not DocHandle's encoded UrlHeads. */
export function rehearsalSeedFrontier(handle) {
  return { documentId: handle.documentId, heads: getHeads(handle.doc()) }
}

export function rehearsalDurableAcknowledged(documents, response) {
  return Array.isArray(response?.documents) && response.documents.length === documents.length
    && new Set(response.documents.map(row => row.documentId)).size === documents.length
    && documents.every(document => response.documents.some(row => row.documentId === document.documentId && row.durable === true))
}

/** A requested WebSocket close is not its completion. Stop retries before
 * awaiting shutdown, retain the socket before disconnect clears the adapter,
 * and refuse admission if either shutdown or the close witness is missing. */
export async function closeRehearsalSeeder(repo, adapter, timeoutMs = 10_000) {
  const requestedAt = Date.now()
  const socket = adapter.socket
  const alreadyClosed = !socket || socket.readyState === 3
  let closeObservedAt = null, onClose, timer
  const closed = alreadyClosed ? Promise.resolve() : new Promise(resolve => {
    onClose = () => { closeObservedAt = Date.now(); resolve() }
    socket.addEventListener('close', onClose, { once: true })
  })
  const errors = []
  try {
    adapter.disconnect()
    await Promise.race([
      Promise.all([repo.shutdown(), closed]),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('rehearsal seeder shutdown/close timed out')), timeoutMs) }),
    ])
    assert.ok(!socket || socket.readyState === 3, 'seeder socket did not close')
  } catch (error) {
    errors.push(error)
    // Only this seeder's socket. A forced stop is cleanup of a VOID seed,
    // never a substitute for the successful close witness above.
    try { socket?.terminate() } catch (failure) { errors.push(failure) }
  } finally {
    clearTimeout(timer)
    if (onClose) socket.removeEventListener('close', onClose)
    try { adapter.disconnect() } catch (failure) { errors.push(failure) }
  }
  if (errors.length) throw new AggregateError(errors, 'rehearsal seeder closure could not be confirmed')
  return { requestedAt, completedAt: Date.now(), alreadyClosed, closeObservedAt, socketPresent: Boolean(socket) }
}

/** Mint/import follows the browser's named-document path. Each base is durable
 * before ModelMeta can reference it. Sequential imports also keep the initial
 * sync from becoming one 12k-object change; the ten-writer head stays small. */
export async function publishRehearsalBases({ repo, metaHandle, head, workspace, backgroundIds, createObject, mint, waitDurable, onDurable = () => {} }) {
  const originalMeta = metaHandle.doc()
  const metaFrontier = rehearsalSeedFrontier(metaHandle)
  assert.notEqual(originalMeta.registrySummaryOnly, true, 'seed requires ordinary metadata')
  assert.deepEqual([...originalMeta.objectShardUrls], [head.url], 'seed requires one original object head')
  const headIds = Object.keys(head.doc().objects)
  assert.equal(new Set([...headIds, ...backgroundIds]).size, headIds.length + backgroundIds.length, 'duplicate seed object id')
  const shardSize = 512
  const shardCount = Math.ceil(backgroundIds.length / shardSize)
  assert.ok(shardCount <= 64, 'one bounded mint request per seed')
  const durability = []
  const acknowledge = async (handle, role) => {
    const documents = [rehearsalSeedFrontier(handle)]
    const requestedAt = Date.now()
    const response = await waitDurable(documents)
    assert.ok(rehearsalDurableAcknowledged(documents, response), `missing durable acknowledgement: ${role}`)
    const receipt = { role, documents, requestedAt, completedAt: Date.now(), response }
    durability.push(receipt)
    onDurable(receipt)
  }
  await acknowledge(head, 'writer-head')
  const bases = []
  if (shardCount) {
    const minted = await mint(shardCount)
    assert.equal(minted?.landscapeId, workspace.landscapeId, 'foreign minted landscape')
    assert.equal(minted?.versionId, workspace.versionId, 'foreign minted version')
    assert.ok(Array.isArray(minted.ids) && minted.ids.length === shardCount, 'wrong minted id count')
    const ids = minted.ids.map(wire => {
      assert.equal(typeof wire, 'string', 'invalid minted id encoding')
      const bytes = Buffer.from(wire, 'base64')
      // Current wire protocol: version 1, 24 bytes (documentIdMint.ts).
      assert.ok(bytes.length === 24 && bytes[0] === 1 && bytes.toString('base64') === wire, 'invalid minted id bytes')
      return interpretAsDocumentId(new Uint8Array(bytes))
    })
    const existingIds = new Set(Object.keys(repo.handles))
    assert.equal(new Set(ids).size, ids.length, 'duplicate minted id')
    assert.ok(ids.every(id => !existingIds.has(id)), 'minted id already exists in seed repo')
    for (let index = 0; index < ids.length; index++) {
      const objectIds = backgroundIds.slice(index * shardSize, (index + 1) * shardSize)
      const objects = Object.fromEntries(objectIds.map(id => [id, createObject(id)]))
      const handle = repo.import(save(from({ objects })), { docId: ids[index] })
      bases.push({ handle, objectIds, bytes: save(handle.doc()).byteLength })
      await acknowledge(handle, `base-${index}`)
    }
    assert.deepEqual(rehearsalSeedFrontier(metaHandle), metaFrontier, 'metadata changed during seed')
    metaHandle.change(meta => { meta.objectShardUrls.unshift(...bases.map(base => base.handle.url)) })
  }
  await acknowledge(metaHandle, 'model-meta')
  assert.deepEqual([...metaHandle.doc().objectShardUrls], [...bases.map(base => base.handle.url), head.url], 'writer head must remain last')
  assert.deepEqual(Object.keys(head.doc().objects), headIds, 'writer head changed during seed')
  return { shardSize, baseShards: bases.map(base => ({ url: base.handle.url, documentId: base.handle.documentId, objects: base.objectIds.length, bytes: base.bytes })),
    writerHead: { url: head.url, documentId: head.documentId, objects: headIds.length, bytes: save(head.doc()).byteLength },
    totalObjects: headIds.length + bases.reduce((sum, base) => sum + Object.keys(base.handle.doc().objects).length, 0),
    durability }
}

const services = ['sync-cell-a', 'sync-cell-b', 'sync-cell-c']
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const count = value => Number.isSafeInteger(value) && value >= 0
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** D60: the loop and convergence budgets are a p99 over the pass's whole
 * population — every counted loop window of one cell, every episode-partition
 * convergence — never the maximum of it. A window is one consuming read:
 * nominally 500 ms, longer for the first read of an episode and the last one.
 * Nearest-rank, so the reported value is an observed one: with n values the
 * p99 is the ceil(0.99 n)-th smallest, and
 * a pass of n windows tolerates n - ceil(0.99 n) windows at or over budget. */
export function populationP99(values) {
  if (!Array.isArray(values) || !values.length || !values.every(finite)) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(0.99 * sorted.length) - 1]
}

/** What a reader needs beside the gated p99: the tail the p99 tolerates. The
 * run length is over the values in arrival order (one cell's windows). */
export function populationTail(values, budget) {
  let run = 0, longest = 0
  for (const value of values) { run = value >= budget ? run + 1 : 0; longest = Math.max(longest, run) }
  return { p99Ms: populationP99(values), maxMs: values.length ? Math.max(...values) : null,
    overBudget: values.filter(value => value >= budget).length,
    allowedOverBudget: values.length ? values.length - Math.ceil(0.99 * values.length) : 0,
    longestOverBudgetRun: longest, legacyMaxRuleFailed: values.some(value => value >= budget) }
}

export const LOOP_P99_BUDGET_MS = 100
export const CONVERGENCE_P99_BUDGET_MS = 3_000

/** One consumer of loop windows: finish the current collection before pausing,
 * skip the unavailable owner, then drain exactly once before admitting it again. */
export class RehearsalSampler {
  constructor(cells, read) {
    this.cells = cells
    this.read = read
    this.unavailableService = null
    this.pending = Promise.resolve()
  }

  serial(work) {
    const result = this.pending.then(work)
    this.pending = result.catch(() => {})
    return result
  }

  collect(consume) {
    return this.serial(async () => {
      const unavailableService = this.unavailableService
      const snapshots = await Promise.all(this.cells.map(cell => cell.service === unavailableService
        ? { service: cell.service, intentionallyUnavailable: true } : this.read(cell)))
      const context = { unavailableService, excludedEventLoopServices: unavailableService ? [unavailableService] : [] }
      consume(snapshots, context)
      return { snapshots, context }
    })
  }

  hold(service) {
    return this.serial(() => {
      assert.equal(this.unavailableService, null, 'a cell is already withheld')
      this.unavailableService = service
    })
  }

  resume(service) {
    return this.serial(async () => {
      assert.equal(this.unavailableService, service)
      const drained = await this.read(this.cells.find(cell => cell.service === service))
      assert.ok(drained.stats && drained.ownership && drained.fleet, 'owner loop-window drain failed')
      this.unavailableService = null
      return drained
    })
  }
}

export function freshnessIdentityValid(before, after, replacement, expectedTopology) {
  const id = before?.stats?.processBootId
  const cell = before?.ownership?.cellId
  return uuid.test(id) && id === after?.stats?.processBootId
    && typeof cell === 'string' && cell.trim().length > 0
    && cell === after?.ownership?.cellId && cell === replacement?.state?.cellId
    && typeof expectedTopology?.effectiveGeneration === 'string' && expectedTopology.effectiveGeneration.length > 0
    && [before?.ownership, after?.ownership, replacement?.state].every(state =>
      state?.effectiveGeneration === expectedTopology.effectiveGeneration
      && state?.topologyGeneration === expectedTopology.effectiveGeneration
      && state?.configuredGeneration === expectedTopology.configuredGeneration)
    && before?.service === after?.service && after?.service === replacement?.service
}

/** Sparse verdict events and per-sample facts are emitted immediately. A killed
 * process must leave observations, although it can never leave a valid PASS. */
export class RehearsalObservations {
  constructor({ publish, initialSnapshots, wall = Date.now, monotonic = () => performance.now() }) {
    this.publish = publish
    this.wall = wall
    this.monotonic = monotonic
    this.startedAt = wall()
    this.startedMono = monotonic()
    this.previousMono = this.startedMono
    this.firstFailure = null
    this.failures = []
    this.invalid = []
    this.episodes = []
    this.previous = new Map()
    this.maxEventLoopP99MsByService = Object.fromEntries(services.map(service => [service, 0]))
    this.peakActiveConnections = 0
    this.samples = 0
    this.earlyResults = new Map()
    this.reportedConvergence = new Set()
    this.loopWindows = new Map()
    this.loopWindowCounts = Object.fromEntries(services.map(service => [service, 0]))
    this.loopPopulation = Object.fromEntries(services.map(service => [service, []]))
    this.convergencePopulation = new Map()
    if (!Array.isArray(initialSnapshots) || initialSnapshots.length !== 3
      || new Set(initialSnapshots.map(row => row?.service)).size !== 3
      || initialSnapshots.some(row => !services.includes(row?.service))) {
      this.refuse('missing opening event-loop window census', {})
    } else {
      for (const row of initialSnapshots) this.consumeWindow(row, { phase: 'opening', cycle: 0 }, true)
      this.emit('event-loop-opening', { windows: [...this.loopWindows].map(([service, receipt]) => ({ service, ...receipt })) })
    }
  }

  consumeWindow(row, context, opening = false) {
    const window = row.stats?.transport?.eventLoopWindow
    const processBootId = row.stats?.processBootId
    const previous = this.loopWindows.get(row.service)
    if (!uuid.test(processBootId) || window?.consumer !== 'qualification'
      || !count(window?.resetCount) || !Number.isFinite(Date.parse(window?.startedAt ?? ''))
      || window.lastResetBy !== (window.resetCount === 0 ? 'boot' : 'consume')
      || (!opening && (!previous || processBootId !== previous.processBootId
        || window.resetCount !== previous.window.resetCount + 1
        || Date.parse(window.startedAt) < Date.parse(previous.window.startedAt)))) {
      this.refuse('missing or discontinuous event-loop window', { ...context, service: row.service,
        previous: previous ?? null, received: { processBootId, window } })
      return
    }
    this.loopWindows.set(row.service, { processBootId, window: { ...window } })
    this.loopWindowCounts[row.service]++
  }

  emit(kind, detail) {
    const mono = this.monotonic()
    assert.ok(finite(mono) && mono >= this.previousMono, 'rehearsal monotonic clock regressed')
    this.previousMono = mono
    const event = { kind, observedAt: this.wall(), elapsedMs: mono - this.startedMono, ...detail }
    this.publish(event)
    return event
  }

  refuse(reason, context) {
    const event = this.emit('invalid', { reason, ...context })
    this.invalid.push(event)
  }

  fail(criterion, value, context) {
    const event = this.emit('criterion-failed', { criterion, value, ...context })
    this.failures.push(event)
    if (this.firstFailure === null) this.firstFailure = structuredClone(event)
  }

  sample(snapshots, { phase, cycle, unavailableService = null, excludedEventLoopServices = [], drainService = null }) {
    const context = { phase, cycle }
    const expectedCount = drainService === null ? 3 : 1
    if (!Array.isArray(snapshots) || snapshots.length !== expectedCount
      || new Set(snapshots.map(row => row?.service)).size !== expectedCount
      || snapshots.some(row => !services.includes(row?.service))
      || excludedEventLoopServices.some(service => service !== drainService
        && !(service === unavailableService && snapshots.some(row => row.service === service
          && row.intentionallyUnavailable === true && !row.stats && !row.fleet && !row.ownership)))
      || (drainService !== null && (snapshots[0]?.service !== drainService
        || excludedEventLoopServices.length !== 1 || excludedEventLoopServices[0] !== drainService))) {
      this.refuse('incomplete sample cell census', context)
      return
    }
    if (drainService === null) this.samples++
    let active = 0
    const observations = []
    for (const row of snapshots) {
      if ((!row.stats || !row.fleet || !row.ownership) && row.service === unavailableService) {
        observations.push({ service: row.service, intentionallyUnavailable: true })
        continue
      }
      this.consumeWindow(row, context)
      const fact = {
        service: row.service,
        processBootId: row.stats?.processBootId,
        cellId: row.ownership?.cellId,
        generation: row.ownership?.effectiveGeneration,
        partitionLossCount: row.ownership?.partitionLossCount,
        eventLoopP99Ms: row.stats?.transport?.eventLoopDelayMs?.p99,
        activeConnections: row.stats?.transport?.connections?.active,
        backpressureDisconnects: row.stats?.transport?.backpressure?.disconnects,
        droppedFrames: row.stats?.transport?.traffic?.outboundDroppedBackpressure,
        rejectedMutations: row.ownership?.storageFence?.rejectedMutationCount,
        foreignResidentProjectors: row.fleet?.foreignResidentProjectors,
        eventLoopExcluded: excludedEventLoopServices.includes(row.service),
        eventLoopWindow: row.stats?.transport?.eventLoopWindow,
        sampleStartedMonotonicMs: row.sampleStartedMonotonicMs,
      }
      observations.push(fact)
      if (!uuid.test(fact.processBootId) || !fact.cellId || !fact.generation || !finite(fact.eventLoopP99Ms)
        || !['partitionLossCount', 'activeConnections', 'backpressureDisconnects', 'droppedFrames',
          'rejectedMutations', 'foreignResidentProjectors'].every(key => count(fact[key]))) {
        this.refuse('missing or invalid sample facts', { ...context, service: row.service })
        continue
      }
      const previous = this.previous.get(row.service)
      if (previous) {
        if (['processBootId', 'cellId', 'generation'].some(key => fact[key] !== previous[key])) {
          this.refuse('process or topology changed during rehearsal', { ...context, service: row.service })
        }
        if (['partitionLossCount', 'backpressureDisconnects', 'droppedFrames', 'rejectedMutations']
          .some(key => fact[key] < previous[key])) {
          this.refuse('counter reset during rehearsal', { ...context, service: row.service })
        }
      }
      this.previous.set(row.service, fact)
      if (fact.foreignResidentProjectors > 0) this.fail('qualification', 'foreign resident projectors observed', { ...context, service: row.service })
      if (row.stats?.synchronizer?.retiredDocuments?.overLimit === true) this.fail('qualification', 'retired document limit exceeded', { ...context, service: row.service })
      active += fact.activeConnections
      if (!fact.eventLoopExcluded) {
        this.maxEventLoopP99MsByService[row.service] = Math.max(this.maxEventLoopP99MsByService[row.service], fact.eventLoopP99Ms)
        // One window over budget is a published fact, not a verdict (D60).
        this.loopPopulation[row.service].push(fact.eventLoopP99Ms)
        if (fact.eventLoopP99Ms >= LOOP_P99_BUDGET_MS) {
          this.emit('event-loop-window-over-budget', { ...context, service: row.service, value: fact.eventLoopP99Ms,
            budgetExclusiveMs: LOOP_P99_BUDGET_MS })
        }
      }
    }
    if (drainService === null) this.peakActiveConnections = Math.max(this.peakActiveConnections, active)
    this.emit(drainService === null ? 'sample' : 'owner-drain-facts', { ...context, cells: observations })
  }

  convergence(raw, phase, cycle) {
    if (!Array.isArray(raw) || raw.some(row => !row || ![0, 1].includes(row.partition)
      || !Number.isInteger(row.cohort) || row.cohort < 0 || row.cohort > 3
      || !count(row.convergedAt) || !['missingFields', 'staleFields', 'hotDiverged'].every(key => count(row[key]))
      || !Array.isArray(row.localOwnFieldsAfterEdit)
      || row.localOwnFieldsAfterEdit.some(entry => !Array.isArray(entry?.values)))) {
      this.refuse('malformed early convergence facts', { phase, cycle })
      return
    }
    for (const partition of [0, 1]) {
      const rows = raw.filter(row => row?.partition === partition)
      if (!rows.length || new Set(rows.map(row => row.cohort)).size !== rows.length) continue
      const writer = rows.find(row => row.cohort === 0)
      const lastWriteCompletedAt = writer?.lastWriteCompletedAt
      const convergedAt = Math.max(...rows.map(row => row.convergedAt))
      const convergenceMs = convergedAt - lastWriteCompletedAt
      const key = `${phase}:${cycle}:${partition}:convergence`
      if (!count(lastWriteCompletedAt) || !finite(convergenceMs)) continue
      // Later cohort rows can only raise convergedAt, so the last write per
      // episode-partition is its final value; a population member, not a verdict (D60).
      this.convergencePopulation.set(key, { phase, cycle, partition, convergenceMs })
      if (convergenceMs >= CONVERGENCE_P99_BUDGET_MS && !this.reportedConvergence.has(key)) {
        this.reportedConvergence.add(key)
        const detail = { phase, cycle, partition, lastWriteCompletedAt, convergedAt,
          receivedAt: Math.max(...rows.map(row => row.receivedAt ?? 0)) }
        // Failover is gated per partition, so its first crossing is its verdict.
        if (phase === 'failover') this.fail('convergence', convergenceMs, { ...detail, statistic: 'failover-each', ceilingExclusiveMs: CONVERGENCE_P99_BUDGET_MS })
        else this.emit('convergence-episode-over-budget', { ...detail, value: convergenceMs, budgetExclusiveMs: CONVERGENCE_P99_BUDGET_MS })
      }
    }
    const lost = raw.reduce((total, row) => total + (row?.missingFields ?? NaN) + (row?.staleFields ?? NaN)
      + (row?.hotDiverged ?? NaN) + (row?.localOwnFieldsAfterEdit?.reduce((sum, entry) =>
        sum + entry.values.filter(value => value == null).length, 0) ?? NaN), 0)
    const key = `${phase}:${cycle}:lost-edits`
    if (finite(lost) && lost > 0 && !this.reportedConvergence.has(key)) {
      this.reportedConvergence.add(key)
      this.fail('lost-edits', lost, { phase, cycle, meaning: 'confirmed count in the cohort results received so far' })
    }
  }

  received(row, phase, cycle) {
    const id = row?.episodeId
    if (!uuid.test(id)) { this.refuse('received cohort has no episode identity', { phase, cycle }); return }
    const entries = this.earlyResults.get(id) ?? []
    if (entries.some(entry => entry.partition === row.partition && entry.cohort === row.cohort)) {
      this.refuse('duplicate result emitted by a cohort', { phase, cycle }); return
    }
    entries.push(structuredClone(row))
    this.earlyResults.set(id, entries)
    this.emit('cohort-result', { phase, cycle, result: row })
    this.convergence(entries, phase, cycle)
  }

  episode(record, phase, cycle) {
    const episodeId = record.baselineAdmission?.barrierId
    if (record.phase !== phase) this.refuse('record phase differs from the executed episode', { phase, cycle })
    if (!uuid.test(episodeId) || this.episodes.some(entry => entry.episodeId === episodeId)) {
      this.refuse('episode identity missing or reused', { phase, cycle })
    }
    for (const reason of record.invalid ?? []) this.refuse(reason, { phase, cycle })
    if (record.status === 'VOID' && !(record.invalid?.length)) this.refuse('episode is VOID', { phase, cycle })
    if (record.status !== 'VOID') {
      if (this.earlyResults.get(episodeId)?.length !== 8) this.convergence(record.baselineResults, phase, cycle)
      for (const reason of record.failures ?? []) {
        if (/partition loss|cohorts disagree/.test(reason)) this.fail('qualification', reason, { phase, cycle })
      }
    }
    const entry = { phase, cycle, episodeId, record }
    this.episodes.push(entry)
    this.emit('episode', entry)
  }

  finish({ actualSoakMs, freshness, calibration, extraFailures = [] }) {
    const cycles = this.episodes.filter(entry => entry.phase === 'soak' && entry.record.status !== 'VOID')
    if (this.episodes[0]?.phase !== 'baseline' || this.episodes[1]?.phase !== 'failover'
      || this.episodes.slice(2).some((entry, index) => entry.phase !== 'soak' || entry.cycle !== index + 1)) {
      this.refuse('rehearsal requires baseline, failover and ordered soak cycles', {})
    }
    if (!finite(actualSoakMs) || !cycles.length) this.refuse('no complete measured soak cycle', {})
    if (this.peakActiveConnections < 200) this.refuse('fleet never reached 200 observed connections', {})
    const durationCompleted = finite(actualSoakMs) && actualSoakMs >= 7_200_000
    if (!this.firstFailure && !durationCompleted) this.refuse('a PASS requires 7200000 ms of actual soak', {})
    for (const reason of extraFailures) this.fail('qualification', reason, { phase: 'final', cycle: null })
    const eventLoopPopulation = Object.fromEntries(services.map(service => {
      const values = this.loopPopulation[service]
      return [service, { windows: values.length, ...populationTail(values, LOOP_P99_BUDGET_MS) }]
    }))
    for (const [service, population] of Object.entries(eventLoopPopulation)) {
      if (population.p99Ms === null) this.refuse('empty event-loop window population', { service })
      else if (population.p99Ms >= LOOP_P99_BUDGET_MS) {
        this.fail('event-loop', population.p99Ms, { phase: 'final', cycle: null, service, statistic: 'population-p99',
          ceilingExclusiveMs: LOOP_P99_BUDGET_MS, windows: population.windows, overBudget: population.overBudget,
          allowedOverBudget: population.allowedOverBudget })
      }
    }
    // The single failover episode is its own population of two partitions, so
    // its p99 is its maximum: pooled with every soak cycle it would be one of
    // hundreds of members, and the one episode this gate exists to qualify
    // could take any value (architecture lens, 2026-10-21).
    const members = [...this.convergencePopulation.values()]
    const steady = members.filter(entry => entry.phase !== 'failover')
    const failover = members.filter(entry => entry.phase === 'failover')
    const convergencePopulation = {
      steady: { episodePartitions: steady.length, ...populationTail(steady.map(entry => entry.convergenceMs), CONVERGENCE_P99_BUDGET_MS),
        byPartition: [0, 1].map(partition => ({ partition,
          ...populationTail(steady.filter(entry => entry.partition === partition).map(entry => entry.convergenceMs), CONVERGENCE_P99_BUDGET_MS) })) },
      failover: failover.map(({ partition, convergenceMs }) => ({ partition, convergenceMs })),
    }
    if (convergencePopulation.steady.p99Ms === null) this.refuse('empty convergence population', {})
    else if (convergencePopulation.steady.p99Ms >= CONVERGENCE_P99_BUDGET_MS) {
      this.fail('convergence', convergencePopulation.steady.p99Ms, { phase: 'final', cycle: null, statistic: 'population-p99',
        ceilingExclusiveMs: CONVERGENCE_P99_BUDGET_MS, episodePartitions: steady.length,
        overBudget: convergencePopulation.steady.overBudget, allowedOverBudget: convergencePopulation.steady.allowedOverBudget })
    }
    if (failover.length !== 2) this.refuse('failover convergence population is not exactly two partitions', { failover: failover.length })
    // convergence() skips a partition it cannot measure; under D60 a skip would
    // silently drop a member — possibly the worst one — so every recorded
    // steady episode must have contributed both partitions (correctness + QA lenses).
    for (const entry of this.episodes) {
      if (entry.phase === 'failover' || entry.record.status === 'VOID') continue
      const missing = [0, 1].filter(partition => !this.convergencePopulation.has(`${entry.phase}:${entry.cycle}:${partition}:convergence`))
      if (missing.length) this.refuse('steady episode missing from the convergence population', { phase: entry.phase, cycle: entry.cycle, missing })
    }
    if (!freshness?.valid || !calibration?.valid || !(calibration.freshAfterTakeoverMs < 500)
      || !(freshness.freshAfterTakeoverMs >= 1_000)) {
      this.refuse('freshness calibration did not discriminate 5 and 12000 objects', {})
    }
    const status = this.invalid.length ? 'VOID' : this.firstFailure ? 'FAIL' : 'PASS'
    return {
      task: 'G4-7', status, outcome: status === 'PASS' ? 'passed' : 'failed',
      profile: 'fleet', usersPerWorkspace: 100, writersPerWorkspace: 10, objects: 10,
      peakActiveConnections: this.peakActiveConnections, soakCycles: cycles.length,
      requestedSoakMs: 7_200_000, actualSoakMs, durationCompleted,
      startedAt: this.startedAt, firstFailure: this.firstFailure, failures: this.failures, invalid: this.invalid,
      firstFailureDefinition: 'first criterion observed by the parent; source timestamps and sampled windows do not establish the physical order within overlapping intervals',
      statistic: 'D60. Loop, per cell: each consuming read yields one window value, the HDR p99 of its 20 ms-resolution samples — nominally a 500 ms window of about 25 samples, i.e. about its maximum; the first window of an episode and the final one are longer. The gate is the nearest-rank p99 of those window values, so at most n - ceil(0.99 n) windows of the pass may reach 100 ms. Steady convergence (baseline and soak, partitions pooled): the same p99 over episode-partitions, budget 3000 ms. Failover convergence: each of its two partitions under 3000 ms. Maxima, over-budget counts, longest consecutive run and the pre-D60 max-rule verdict are published, not gated.',
      eventLoopPopulation, convergencePopulation,
      maxEventLoopP99MsByService: this.maxEventLoopP99MsByService, samples: this.samples,
      eventLoopWindowCounts: this.loopWindowCounts,
      freshness, calibration, episodes: this.episodes,
      capacityCertified: false,
    }
  }
}

/** completedAt is fixed at the ready response, before either cleanup or API
 * polling can move it. Async unpause runs alongside freshness without blocking
 * the observer's event loop. Its failure remains a cleanup failure. */
export async function measureTakeover({ originalService, pause, replacement, unpause, fresh,
  onReady = () => {}, onUnpaused = () => {},
  wall = Date.now, monotonic = () => performance.now() }) {
  const pauseRequestedAt = wall()
  let takeover
  let freshness
  let failure
  let unpauseCompletedAt
  try {
    await pause()
    const startedAt = wall()
    const startedMono = monotonic()
    const next = await replacement()
    const completedAt = wall()
    const completedMonotonicMs = monotonic()
    const takeoverMs = completedMonotonicMs - startedMono
    assert.ok(next.service && next.service !== originalService && next.state?.ready === true
      && next.state.partitionReady === true && next.state.partitionIndex === 0, 'replacement must be ready for partition zero')
    takeover = { verified: true, originalService, replacementService: next.service, replacementState: next.state,
      pauseRequestedAt, startedAt, completedAt, completedMonotonicMs, takeoverMs }
    onReady(takeover)
    // Attach rejection handling in this same turn, before starting cleanup.
    const freshResult = Promise.resolve().then(() => fresh(takeover, next))
    const resumeResult = Promise.resolve().then(unpause).then(async () => { unpauseCompletedAt = wall(); await onUnpaused() })
    const settled = await Promise.allSettled([freshResult, resumeResult])
    if (settled[0].status === 'fulfilled') freshness = settled[0].value
    else failure = settled[0].reason
    if (settled[1].status === 'rejected') throw new Error(`unpause failed: ${settled[1].reason?.message ?? settled[1].reason}`)
    if (failure) throw failure
  } catch (error) {
    if (unpauseCompletedAt === undefined) {
      try { await unpause(); unpauseCompletedAt = wall(); await onUnpaused() } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'takeover failed and owner unpause could not be confirmed')
      }
    }
    throw error
  }
  return { takeover: { ...takeover, unpauseCompletedAt }, freshness }
}

export function isFreshWitness(response, workspace, expectedObjects) {
  return Object.keys(expectedObjects).length > 0 && response?.status === 200 && response.route === 'owner'
    && response.body?.landscapeId === workspace.landscapeId && response.body?.versionId === workspace.versionId
    && response.body.absenceProvable === true
    && Object.entries(expectedObjects).every(([id, expected]) => {
      const observed = response.body.objects?.[id]
      return observed && Object.entries(expected).every(([field, value]) => observed[field] === value)
    })
}
