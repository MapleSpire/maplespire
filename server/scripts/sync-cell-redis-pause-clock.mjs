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

// Local C3 measurement model, not a distributed-clock guarantee. It assumes
// 1 ms timestamp quantization and a wall clock that tracks the monotonic clock
// within 2 ms; samples that break the latter are reported as issues.
const QUANTIZATION_MS = 1
const WALL_MONOTONIC_TOLERANCE_MS = 2
const LEASE_LIMIT_MS = 475
const LOSS_MESSAGE = '[sync-cell] partition-worker-redis-unavailable failed: Error: partition lease keeper lost authority'

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return NaN
  const parsed = Date.parse(value)
  // Date.parse normalizes dates such as February 30. That is not a clock sample.
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) return NaN
  return parsed
}

function clockIntervals(records, t0) {
  const issues = []
  let lower = -Infinity, upper = Infinity
  const timed = []
  for (const [i, value] of records.entries()) {
    const g = timestamp(value?.generatedAt) - t0
    const { requestedAt: s, at: r, requestedMonoAt: sm, monoAt: rm } = value ?? {}
    if (value?.error || ![g, s, r, sm, rm].every(Number.isFinite) || s < 0 || r < s || rm < sm) {
      issues.push(`sample ${i}: invalid timestamp, request interval or error`)
      continue
    }
    if (Math.abs(s - sm) > WALL_MONOTONIC_TOLERANCE_MS || Math.abs(r - rm) > WALL_MONOTONIC_TOLERANCE_MS) {
      issues.push(`sample ${i}: wall clock differs from monotonic clock`)
    }
    lower = Math.max(lower, g - r - QUANTIZATION_MS)
    upper = Math.min(upper, g - s + QUANTIZATION_MS)
    timed.push(value)
  }
  return { issues, lower, upper, timed }
}

export function calibrateObservationClock(records, { t0, pauseBegin, resumeAck, pauseAck = pauseBegin, resumeBegin = resumeAck }) {
  const { issues, lower, upper, timed } = clockIntervals(records, t0)
  let before = 0, during = 0, after = 0, ambiguous = 0
  for (const { requestedAt: s, at: r } of timed) {
    if (r < pauseBegin) before += 1
    else if (s > resumeAck) after += 1
    else if (s >= pauseAck && r < resumeBegin) during += 1
    else ambiguous += 1
  }
  if (before < 2 || after < 2 || during < 2) issues.push('need at least two clock samples before, during and after the outage')
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) issues.push('clock offset intervals have no common intersection')
  return { valid: issues.length === 0, issues, samples: records.length, before, during, after, ambiguous,
    offsetMs: Number.isFinite(lower) && Number.isFinite(upper) ? { lower, upper } : null }
}

/** Admission on completed observations only, at the original t0. Pending
 * requests remain owned by the collector and are checked when stop drains
 * them. This is neither an outage calibration nor a lease verdict. */
export function analyzeRedisPauseBaseline({ t0, samples, checkedAt, checkedMonoAt, samplePeriodMs }) {
  const issues = []
  const result = { model: 'pre-pause-clock-admission-v1', valid: false,
    checkedAtMs: checkedAt, checkedMonoAtMs: checkedMonoAt,
    wallMonotonicToleranceMs: WALL_MONOTONIC_TOLERANCE_MS, sources: {}, issues,
    scope: 'Completed clock records and the current collector clock pair only. Pending reads and subsequent clock changes remain subject to final validation.',
  }
  if (![t0, checkedAt, checkedMonoAt].every(Number.isFinite) || checkedAt < 0 || checkedMonoAt < 0
    || !Array.isArray(samples) || !Number.isInteger(samplePeriodMs) || samplePeriodMs < 50 || samplePeriodMs > 1000) {
    issues.push('invalid baseline clocks, samples or cadence')
    return result
  }
  if (Math.abs(checkedAt - checkedMonoAt) > WALL_MONOTONIC_TOLERANCE_MS) issues.push('current wall clock differs from monotonic clock')
  const records = Object.fromEntries(['a', 'b'].map(key => [key, samples.map(sample => sample[key]?.state)]))
  records.engine = samples.filter(sample => sample.engineClock !== undefined).map(sample => sample.engineClock)
  for (const [key, values] of Object.entries(records)) {
    const completed = values.filter(value => value?.pending !== true)
    const { issues: sourceIssues, lower, upper, timed } = clockIntervals(completed, t0)
    const cadenceMs = key === 'engine' ? samplePeriodMs * Math.ceil(200 / samplePeriodMs) : samplePeriodMs
    const maxAgeMs = 2 * cadenceMs
    const latestRequest = Math.max(...timed.map(value => value.requestedMonoAt))
    const latestArrival = Math.max(...timed.map(value => value.monoAt))
    const latestRequestAgeMs = Number.isFinite(latestRequest) ? checkedMonoAt - latestRequest : null
    const latestArrivalAgeMs = Number.isFinite(latestArrival) ? checkedMonoAt - latestArrival : null
    if (timed.length < 2) sourceIssues.push('need at least two completed clock samples before injection')
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) sourceIssues.push('clock offset intervals have no common intersection')
    if (timed.some(value => value.at > checkedAt || value.monoAt > checkedMonoAt)) sourceIssues.push('clock record is later than the baseline check')
    if (latestRequestAgeMs === null || latestRequestAgeMs > maxAgeMs || latestArrivalAgeMs === null || latestArrivalAgeMs > maxAgeMs) {
      sourceIssues.push('no recent completed clock request within two sampling periods')
    }
    if (key === 'engine' && completed.some(value => value?.version !== '29.7.2')) sourceIssues.push('Engine version is outside the audited log timestamp model')
    result.sources[key] = { completed: completed.length, pending: values.length - completed.length,
      cadenceMs, maxAgeMs, latestRequestAgeMs, latestArrivalAgeMs,
      offsetMs: Number.isFinite(lower) && Number.isFinite(upper) ? { lower, upper } : null }
    issues.push(...sourceIssues.map(issue => `${key}: ${issue}`))
  }
  const offsets = Object.values(result.sources).map(source => source.offsetMs)
  if (offsets.every(Boolean) && Math.max(...offsets.map(value => value.lower)) > Math.min(...offsets.map(value => value.upper))) {
    issues.push('cell and Engine clocks are incompatible with shared local realtime')
  }
  result.valid = issues.length === 0
  return result
}

export function classifyLeaseInterval(lowerMs, upperMs) {
  if (![lowerMs, upperMs].every(Number.isFinite) || lowerMs > upperMs) return 'INVALID'
  if (upperMs <= LEASE_LIMIT_MS) return 'PASS'
  if (lowerMs > LEASE_LIMIT_MS) return 'FAIL'
  return 'INCONCLUSIVE'
}

export function analyzeRedisPauseClock({ t0, pauseStartedAt, pausedAt, unpauseStartedAt, unpausedAt, samples, logs, cells }) {
  const issues = []
  const result = {
    model: 'local-engine-worker-clock-v1', valid: false, verdict: 'INVALID', limitMs: LEASE_LIMIT_MS,
    assumptions: [
      'Each source has a constant clock offset for this episode; sampled consistency cannot exclude an unobserved clock step.',
      'Docker Engine and both cells share the local Linux CLOCK_REALTIME; no remote engine or clock virtualization.',
      'The exact worker loss log follows coordinator partitionLease=null and its single counter increment.',
      'Engine 29.7.2 / Moby 6a43e3d timestamps the complete short log line after reading application output.',
      'The captured log stream has no missing prefix: an isolated final fragment cannot otherwise be distinguished from a complete short line.',
    ],
    quantizationMs: QUANTIZATION_MS, wallMonotonicToleranceMs: WALL_MONOTONIC_TOLERANCE_MS,
    issues,
  }
  const marks = [t0, pauseStartedAt, pausedAt, unpauseStartedAt, unpausedAt]
  if (!marks.every(Number.isFinite) || marks.some((n, i) => i && n < marks[i - 1])
    || !Array.isArray(samples) || !Array.isArray(cells) || cells.length !== 2) {
    issues.push('invalid phase boundaries, samples or cells')
    return result
  }
  if (cells.some(cell => !/^[a-f0-9]{64}$/i.test(cell?.id ?? '')) || cells[0].id === cells[1].id
    || !cells[0].service || !cells[1].service || cells[0].service === cells[1].service) {
    issues.push('two distinct identified cell containers are required')
    return result
  }
  const pauseBegin = pauseStartedAt - t0, pauseAck = pausedAt - t0
  const resumeBegin = unpauseStartedAt - t0, resumeAck = unpausedAt - t0
  const records = Object.fromEntries(['a', 'b'].map(key => [key, samples.map(sample => sample[key]?.state)]))
  records.engine = samples.filter(sample => sample.engineClock !== undefined).map(sample => sample.engineClock)
  const clocks = Object.fromEntries(Object.entries(records).map(([key, values]) => [key,
    calibrateObservationClock(values, { t0, pauseBegin, pauseAck, resumeBegin, resumeAck })]))
  result.clocks = clocks
  for (const [key, clock] of Object.entries(clocks)) issues.push(...clock.issues.map(issue => `${key}: ${issue}`))
  if (records.engine.some(value => value?.version !== '29.7.2')) issues.push('Engine version is outside the audited log timestamp model')
  if (issues.length) return result
  // A common realtime clock must be compatible with all three independently
  // measured offsets. Do not improve a cell's bound by substituting its peer.
  if (Math.max(...Object.values(clocks).map(c => c.offsetMs.lower))
    > Math.min(...Object.values(clocks).map(c => c.offsetMs.upper))) {
    issues.push('cell and Engine clocks are incompatible with shared local realtime')
    return result
  }
  const interval = (record, clock) => ({
    lower: record.requestedAt - QUANTIZATION_MS,
    upper: Math.min(record.at + QUANTIZATION_MS, timestamp(record.generatedAt) - t0 - clock.offsetMs.lower + QUANTIZATION_MS),
  })
  const owned = value => value?.status === 200 && Number.isInteger(value.partitionIndex) && value.partitionIndex >= 0 && value.ready === true
  const unowned = value => value?.status === 200 && value.partitionIndex === null && value.ready === false
  const baseline = Object.fromEntries(['a', 'b'].map(key => [key, records[key]
    .filter(value => value.at < pauseBegin).sort((a, b) => b.requestedAt - a.requestedAt)[0]]))
  const owners = ['a', 'b'].filter(key => owned(baseline[key]))
  if (owners.length !== 1 || !['a', 'b'].every(key => owned(baseline[key]) || unowned(baseline[key]))) {
    issues.push('baseline does not identify exactly one owner and one standby')
    return result
  }
  const owner = owners[0], standby = owner === 'a' ? 'b' : 'a'
  result.initialOwner = owner
  const before = baseline[owner]
  if (!Number.isInteger(before.partitionLossCount) || before.partitionLossCount < 0) issues.push('baseline loss counter is invalid')
  const ownerSamples = records[owner].map(value => ({ value, time: interval(value, clocks[owner]) }))
  const during = ownerSamples.filter(({ time }) => time.lower >= pauseAck && time.upper < resumeBegin)
  const lost = during.filter(({ value }) => unowned(value))
  if (!lost.length) issues.push('no timestamp-qualified owner loss during the acquired pause')
  for (const { value } of during) {
    if (!(owned(value) || unowned(value))) issues.push('owner state during pause is missing or inconsistent')
    const expected = before.partitionLossCount + (unowned(value) ? 1 : 0)
    if (value.partitionLossCount !== expected) issues.push('loss counter does not attribute a single transition')
  }
  const earliestLossUpper = Math.min(...lost.map(({ time }) => time.upper))
  if (during.some(({ value, time }) => owned(value) && time.lower > earliestLossUpper)) issues.push('owner returned during the pause')
  const standbyDuring = records[standby].filter(value => value.requestedAt >= pauseAck && value.at < resumeBegin)
  if (!standbyDuring.length || standbyDuring.some(value => !unowned(value))) issues.push('standby did not remain unowned during the pause')
  const cell = cells[owner === 'a' ? 0 : 1]
  const ownerLog = logs?.[cell.service]
  if (ownerLog?.containerId !== cell.id || !Array.isArray(ownerLog?.lossLines)) issues.push('loss log is not attributed to the identified owner container')
  const lossLines = Array.isArray(ownerLog?.lossLines) ? ownerLog.lossLines : []
  const matched = []
  for (const line of lossLines) {
    const split = typeof line === 'string' ? line.indexOf(' ') : -1
    const logTime = split > 0 ? timestamp(line.slice(0, split)) : NaN
    if (!Number.isFinite(logTime) || line.slice(split + 1) !== LOSS_MESSAGE) {
      issues.push('loss log is fragmented, truncated or not the exact audited message')
      continue
    }
    const lower = logTime - t0 - clocks.engine.offsetMs.upper - QUANTIZATION_MS
    const upper = logTime - t0 - clocks.engine.offsetMs.lower + QUANTIZATION_MS
    if (lower >= pauseAck && upper < resumeBegin) matched.push({ line, lower, upper })
    else issues.push('loss log cannot be attributed entirely to the acquired pause')
  }
  if (matched.length !== 1) issues.push('need exactly one attributable worker loss log')
  if (issues.length) return result
  // The old HTTP arrival upper remains separately visible. We precommit the
  // minimum of all qualified uppers; no choice based on whether a pass is green.
  const candidates = {
    httpArrival: Math.min(...lost.map(({ value }) => value.at + QUANTIZATION_MS)) - pauseBegin,
    generatedAt: earliestLossUpper - pauseBegin,
    completeWorkerLossLog: matched[0].upper - pauseBegin,
  }
  const upperMs = Math.min(...Object.values(candidates))
  // A request sent while ownership is still reported establishes this lower
  // without assuming that generatedAt was taken before the snapshot.
  const lowerMs = Math.max(...ownerSamples.filter(({ value, time }) => owned(value) && time.upper < resumeBegin)
    .map(({ value }) => value.requestedAt - QUANTIZATION_MS)) - pauseAck
  result.transition = { lowerMs, upperMs, candidates, log: matched[0] }
  result.verdict = classifyLeaseInterval(lowerMs, upperMs)
  if (result.verdict === 'INVALID') issues.push('transition bounds contradict each other')
  result.valid = issues.length === 0
  return result
}
