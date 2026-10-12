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

import { isDeepStrictEqual } from 'node:util'

const SCHEMA = 'maplespire-placement-shadow/v1'
const IDENTITY_FIELDS = ['cellId', 'generation', 'mode', 'partitionCount', 'partitionIndex',
  'partitionAcquisitionCount', 'partitionLossCount', 'errorCount', 'passAbandonedCount']
const METADATA_FIELDS = ['runId', 'pid', 'hostname', 'cellId', 'manifestSha256', 'sourceHashes', 'hashes']
class InvalidEvidence extends Error {
  constructor(code) { super(code); this.code = code }
}
function requireFact(condition, code) { if (!condition) throw new InvalidEvidence(code) }
const equal = (actual, expected, code) => requireFact(isDeepStrictEqual(actual, expected), code)
const integer = value => Number.isSafeInteger(value) && value >= 0
function clock(value) {
  requireFact(typeof value === 'string' && /^\d+$/.test(value), 'invalid-monotonic-clock')
  return BigInt(value)
}
function chronology(...values) {
  const times = values.map(clock)
  requireFact(times.every((time, index) => index === 0 || time >= times[index - 1]), 'reversed-observation-time')
}
function vector(rows, partitions) {
  requireFact(Array.isArray(rows) && rows.length <= 128, 'invalid-row-vector')
  const seen = new Set()
  return rows.map(row => {
    requireFact(row && typeof row.landscapeId === 'string' && row.landscapeId.length > 0
      && row.landscapeId.length <= 256 && typeof row.versionId === 'string'
      && row.versionId.length > 0 && row.versionId.length <= 256, 'invalid-workspace-key')
    const key = JSON.stringify([row.landscapeId, row.versionId])
    requireFact(!seen.has(key), 'duplicate-workspace-key')
    seen.add(key)
    if (partitions) requireFact(row.partition === 0 || row.partition === 1, 'invalid-partition')
    return partitions ? [row.landscapeId, row.versionId, row.partition] : [row.landscapeId, row.versionId]
  }).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)
}
function identity(value, cellId, generation) {
  requireFact(value && typeof value === 'object', 'missing-cell-identity')
  equal([value.cellId, value.generation, value.mode, value.partitionCount],
    [cellId, generation, 'shadow', 2], 'unexpected-cell-identity')
  requireFact(value.partitionIndex === 0 || value.partitionIndex === 1, 'partition-not-held')
  for (const field of IDENTITY_FIELDS.slice(5)) requireFact(integer(value[field]), 'invalid-identity-counter')
  return Object.fromEntries(IDENTITY_FIELDS.map(field => [field, value[field]]))
}
function inspectPass(event, { cellId, generation, expected, keys, divergence, marker }) {
  const pass = event.pass
  requireFact(pass.origin === 'timer' && integer(pass.tick) && pass.tick > marker.tickSequence
    && event.timerBound === true, 'not-a-bound-timer-pass')
  requireFact(pass.id > marker.passSequence, 'pass-not-after-phase-floor')
  requireFact(pass.outcome === 'fulfilled' && pass.error === undefined, 'reconcile-failed')
  const before = identity(pass.before, cellId, generation)
  equal(identity(event.after, cellId, generation), before, 'identity-or-counters-changed-in-pass')
  requireFact(Array.isArray(pass.queries) && pass.queries.length === 2
    && pass.queries.every(query => query && typeof query === 'object')
    && pass.queries[0].kind === 'discovery' && pass.queries[1].kind === 'placement', 'missing-or-extra-real-select')
  const [discovery, placement] = pass.queries
  for (const query of pass.queries) {
    requireFact(query.outcome === 'fulfilled' && query.error === undefined, 'select-not-successful')
  }
  equal(discovery.parameters, [], 'unexpected-discovery-parameters')
  equal(placement.parameters, [generation], 'wrong-select-generation')
  equal(vector(discovery.rows, false), keys, 'discovered-workspaces-differ')
  equal(vector(placement.rows, true), expected, 'selected-placement-vector-differs')
  requireFact(Array.isArray(pass.comparisons) && pass.comparisons.length === 1, 'missing-or-extra-comparison')
  const comparison = pass.comparisons[0]
  requireFact(comparison && comparison.outcome === 'fulfilled' && comparison.error === undefined, 'comparison-failed')
  equal(vector(comparison.workspaces, false), keys, 'comparison-workspaces-differ')
  const gauge = { divergence, compared: keys.length }
  equal(comparison.after, gauge, 'comparison-gauge-differs')
  equal(event.gaugeAfter, gauge, 'pass-gauge-differs')
  chronology(pass.start, discovery.start, discovery.end, comparison.start,
    placement.start, placement.end, comparison.end, pass.end, event.monotonic)
  return { passId: pass.id, tick: pass.tick, start: pass.start, end: pass.end,
    comparisonObservedAt: comparison.end, eventSequence: event.sequence, utc: event.utc,
    identity: before, gauge, vector: expected.map(row => [...row]) }
}

function inspectCell(events, options) {
  const { cellId, generation, phase } = options
  requireFact(Array.isArray(events) && events.length <= 10001, 'invalid-event-stream')
  const result = { observations: [], warmup: 0, transitions: 0, otherPhases: 0,
    coalescedTicks: 0, activeAtClose: null, pendingInPhase: 0, closed: false,
    phaseEnded: false, marker: null, metadata: null, excludedPasses: [], activePasses: [] }
  if (events.length === 0) return result
  let currentPhase = 0, passSequence = 0, tickSequence = 0, querySequence = 0
  let previousClock = null, timerBound = false, targetIdentity = null
  const starts = new Map()
  const first = events[0]
  requireFact(first.event === 'installed', 'missing-installation-event')
  requireFact(typeof first.runId === 'string' && first.runId.length > 0, 'missing-run-identity')
  requireFact(integer(first.pid) && first.pid > 0 && typeof first.hostname === 'string'
    && first.hostname.length > 0 && first.cellId === cellId, 'missing-process-identity')
  requireFact(typeof first.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(first.manifestSha256), 'invalid-manifest-hash')
  for (const field of ['sourceHashes', 'hashes']) {
    requireFact(first[field] && typeof first[field] === 'object' && !Array.isArray(first[field])
      && Object.keys(first[field]).length > 0 && Object.values(first[field]).every(value =>
        typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), 'invalid-source-hashes')
  }
  result.metadata = Object.fromEntries(METADATA_FIELDS.map(field => [field, first[field]]))
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    requireFact(event && event.schema === SCHEMA && event.sequence === index + 1, 'event-sequence-gap-or-duplicate')
    equal(Object.fromEntries(METADATA_FIELDS.map(field => [field, event[field]])), result.metadata, 'process-metadata-changed')
    if (event.cellId !== undefined) equal(event.cellId, cellId, 'stream-cell-id-differs')
    const now = clock(event.monotonic)
    requireFact(previousClock === null || now >= previousClock, 'event-clock-regressed')
    previousClock = now
    requireFact(typeof event.utc === 'string' && Number.isFinite(Date.parse(event.utc)), 'invalid-event-utc')
    requireFact(event.observerFault === null, 'observer-fault')
    if (event.event === 'installed') {
      requireFact(index === 0 && event.phase === 0, 'duplicate-installation')
    } else if (event.event === 'phase-marker') {
      requireFact(event.phase === currentPhase + 1, 'phase-sequence-differs')
      currentPhase = event.phase
      requireFact(Array.isArray(event.states) && event.states.length === 1, 'phase-coordinator-count-differs')
      const state = event.states[0]
      equal(state, { cellId, passSequence, tickSequence, activePasses: [...starts.keys()] }, 'phase-floor-differs')
      if (currentPhase === phase) result.marker = { ...state, sequence: event.sequence, monotonic: event.monotonic }
      if (currentPhase > phase) result.phaseEnded = true
    } else if (event.event === 'timer-bound') {
      requireFact(!timerBound && event.phase === currentPhase, 'timer-binding-differs')
      requireFact(Number.isFinite(event.reconcileIntervalMs) && event.reconcileIntervalMs > 0, 'invalid-timer-interval')
      equal([event.cellId, event.generation, event.mode, event.partitionCount], [cellId, generation, 'shadow', 2], 'timer-identity-differs')
      timerBound = true
    } else if (event.event === 'pass-start' || event.event === 'coalesced-tick') {
      requireFact(event.phase === currentPhase, 'pass-start-phase-differs')
      if (event.event === 'coalesced-tick' || event.origin === 'timer') {
        requireFact(timerBound && event.tick === tickSequence + 1, 'timer-tick-gap-or-duplicate')
        tickSequence = event.tick
      }
      if (event.event === 'coalesced-tick') {
        requireFact(starts.size === 1, 'coalesced-without-active-pass')
        if (currentPhase === phase) result.coalescedTicks += 1
      } else {
        requireFact(event.passId === passSequence + 1 && starts.size === 0, 'pass-sequence-gap-duplicate-or-overlap')
        requireFact(event.origin === 'timer' || (event.origin === 'other' && event.tick === null), 'invalid-pass-origin')
        passSequence = event.passId
        starts.set(event.passId, event)
      }
    } else if (event.event === 'pass-end') {
      const pass = event.pass
      const start = starts.get(pass?.id)
      requireFact(start, 'pass-end-without-start')
      equal([pass.phase, pass.origin, pass.tick], [start.phase, start.origin, start.tick], 'pass-start-end-differ')
      requireFact(pass.endPhase === currentPhase, 'pass-end-phase-differs')
      chronology(pass.start, start.monotonic, pass.end, event.monotonic)
      requireFact(Array.isArray(pass.queries), 'missing-query-records')
      for (const query of pass.queries) {
        requireFact(query && query.id === querySequence + 1, 'query-sequence-gap-or-duplicate')
        querySequence = query.id
      }
      starts.delete(pass.id)
      if (pass.phase !== pass.endPhase) result.transitions += 1
      else if (pass.phase === 0) result.warmup += 1
      else if (pass.phase !== phase) result.otherPhases += 1
      else {
        requireFact(result.marker && timerBound, 'phase-marker-or-timer-missing')
        chronology(result.marker.monotonic, pass.start)
        const observation = inspectPass(event, { ...options, marker: result.marker })
        if (targetIdentity) equal(observation.identity, targetIdentity, 'identity-or-counters-changed-in-phase')
        targetIdentity = observation.identity
        result.observations.push(observation)
      }
      if (pass.phase !== phase || pass.phase !== pass.endPhase) result.excludedPasses.push({
        passId: pass.id, phase: pass.phase, endPhase: pass.endPhase, outcome: pass.outcome,
        queryOutcomes: pass.queries.map(query => ({ kind: query.kind, outcome: query.outcome })),
      })
    } else if (event.event === 'closed') {
      requireFact(index === events.length - 1, 'event-after-close')
      const stats = event.stats
      requireFact(stats && stats.fault === null && stats.coordinators === 1, 'closure-fault-or-coordinators')
      requireFact(stats.eventSequence === event.sequence - 1 && stats.phase === currentPhase, 'closure-sequence-or-phase-differs')
      requireFact(stats.activePasses === starts.size, 'closure-active-count-differs')
      result.closed = true
      result.activeAtClose = stats.activePasses
    } else throw new InvalidEvidence('unexpected-event-or-start-failure')
  }
  for (const start of starts.values()) {
    result.activePasses.push({ passId: start.passId, phase: start.phase, origin: start.origin })
    if (start.phase === phase && currentPhase === phase) result.pendingInPhase += 1
    else if (start.phase !== currentPhase) result.transitions += 1
  }
  result.phaseEnded ||= result.closed && currentPhase === phase && result.pendingInPhase === 0
  return result
}

/** Pure classification of complete observer events; no I/O or product imports.
 * `clean` means both cells read the expected nontrivial P and report D(P,H).
 * Zero intentional differences is `void`, not a clean migration witness.
 * Polling may expose completed pairs, but can never publish a final verdict.
 */
export function summarizePlacementShadow({ eventsByCell, expectedRows, hashRows, generation,
  phase, samples = 100, requireClosed = true } = {}) {
  const output = { verdict: 'incomplete', reasons: [], samplesRequested: samples, samples: 0,
    rowsCompared: null, differentRows: null, observationsByCell: {}, cells: {}, pairs: [],
    crossCellDivergence: null, final: false }
  const reason = (code, cellId) => output.reasons.push(cellId ? { code, cellId } : { code })
  try {
    requireFact(integer(samples) && samples > 0 && samples <= 1000, 'invalid-sample-count')
    requireFact(integer(phase) && phase > 0 && typeof requireClosed === 'boolean', 'invalid-phase-or-closure-option')
    requireFact(typeof generation === 'string' && generation.length > 0, 'missing-generation')
    requireFact(eventsByCell && typeof eventsByCell === 'object' && !Array.isArray(eventsByCell), 'invalid-cell-streams')
    const cellIds = Object.keys(eventsByCell).sort()
    requireFact(cellIds.length === 2 && cellIds.every(id => id.length > 0), 'expected-exactly-two-cells')
    const expected = vector(expectedRows, true), hash = vector(hashRows, true)
    const keys = expected.map(row => row.slice(0, 2))
    requireFact(keys.length >= 2, 'too-few-workspaces')
    equal(hash.map(row => row.slice(0, 2)), keys, 'hash-workspaces-differ')
    const divergence = expected.filter((row, index) => row[2] !== hash[index][2]).length
    output.rowsCompared = keys.length
    output.differentRows = divergence
    for (const cellId of cellIds) {
      try {
        const cell = inspectCell(eventsByCell[cellId], { cellId, generation, phase, expected, keys, divergence })
        output.cells[cellId] = cell
        output.observationsByCell[cellId] = cell.observations
      } catch (error) {
        if (!(error instanceof InvalidEvidence)) throw error
        reason(error.code, cellId)
      }
    }
    if (output.reasons.length) { output.verdict = 'invalid'; return output }
    const [a, b] = cellIds.map(id => output.cells[id])
    if (a.metadata && b.metadata) {
      for (const field of ['runId', 'manifestSha256', 'sourceHashes', 'hashes']) {
        equal(a.metadata[field], b.metadata[field], 'different-run-identities-or-sources')
      }
      requireFact(a.metadata.hostname !== b.metadata.hostname, 'same-container-hostname')
    }
    if (a.observations.length && b.observations.length) {
      requireFact(a.observations[0].identity.partitionIndex !== b.observations[0].identity.partitionIndex,
        'two-cells-hold-same-partition')
    }
    const available = Math.min(a.observations.length, b.observations.length)
    output.samples = Math.min(samples, available)
    for (let index = 0; index < output.samples; index += 1) {
      equal(a.observations[index].vector, b.observations[index].vector, 'cross-cell-vector-differs')
      output.pairs.push({ sample: index + 1, cells: cellIds.map((cellId, side) => ({ cellId,
        passId: [a, b][side].observations[index].passId, tick: [a, b][side].observations[index].tick })) })
    }
    if (output.samples > 0) output.crossCellDivergence = 0
    for (const cellId of cellIds) {
      const cell = output.cells[cellId]
      if (!cell.marker) reason('target-phase-not-observed', cellId)
      if (!cell.closed) reason('stream-not-closed', cellId)
      if (!cell.phaseEnded || cell.pendingInPhase) reason('target-phase-not-finished', cellId)
      if (cell.observations.length < samples) reason('insufficient-completed-passes', cellId)
    }
    if (!requireClosed) reason('progress-only-not-final')
    if (output.reasons.length === 0) {
      output.verdict = divergence === 0 ? 'void' : 'clean'
      output.final = true
    }
  } catch (error) {
    if (!(error instanceof InvalidEvidence)) throw error
    reason(error.code)
    output.verdict = 'invalid'
  }
  return output
}
