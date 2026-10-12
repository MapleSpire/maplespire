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

/** Pure reduction of ARRIVALS, never of request order or a tick's phase label.
 * Docker's pause/unpause commands have a begin and an acknowledgement. Replies
 * inside those intervals are retained as transitions, not attributed to a
 * pause whose exact kernel timestamp the instrument cannot observe. */
export function summarizeRedisPauseObservation({
  label, t0, pauseStartedAt, pausedAt, unpauseStartedAt, unpausedAt,
  samples, samplePeriodMs = 200, routerSamplePeriodMs = 1_000, error = null,
}) {
  const issues = []
  const marks = [t0, pauseStartedAt, pausedAt, unpauseStartedAt, unpausedAt]
  const boundariesValid = marks.every(Number.isFinite)
    && marks.every((value, i) => i === 0 || value >= marks[i - 1])
  if (!boundariesValid) issues.push('missing, invalid or unordered phase timestamps')
  if (error) issues.push(String(error))
  const relative = (value) => Number.isFinite(value) && Number.isFinite(t0) ? value - t0 : null
  const pauseBegin = relative(pauseStartedAt)
  const pauseAck = relative(pausedAt)
  const resumeBegin = relative(unpauseStartedAt)
  const resumeAck = relative(unpausedAt)
  const phaseOf = (at) => {
    if (!boundariesValid || !Number.isFinite(at)) return 'invalid'
    if (at < pauseBegin) return 'before'
    if (at < pauseAck) return 'transition'
    if (at < resumeBegin) return 'paused'
    if (at < resumeAck) return 'transition'
    return 'unpaused'
  }
  const valid = (value, tick, name) => {
    if (!value || !Number.isFinite(value.at) || !Number.isFinite(tick) || value.at < tick || tick < 0) {
      issues.push(`${name}: missing/invalid arrival timestamp or arrival before request`)
      return false
    }
    return true
  }
  const records = { a: { ready: [], state: [] }, b: { ready: [], state: [] }, router: [] }
  for (const [i, sample] of samples.entries()) {
    for (const key of ['a', 'b']) {
      for (const part of ['ready', 'state']) {
        const value = sample[key]?.[part]
        if (valid(value, sample.t, `sample ${i} ${key}.${part}`)) records[key][part].push(value)
      }
    }
    if (sample.router !== null && sample.router !== undefined) {
      if (valid(sample.router, sample.t, `sample ${i} router`)) records.router.push(sample.router)
    }
  }
  const inPhase = (values, phase) => values.filter((value) => phaseOf(value.at) === phase)
  const earliest = (values, predicate = () => true) => {
    const hits = values.filter(predicate)
    return hits.length ? hits.reduce((first, value) => value.at < first.at ? value : first) : null
  }
  const latest = (values) => values.length ? values.reduce((last, value) => value.at > last.at ? value : last) : null
  const delay = (value, start) => value && start !== null ? value.at - start : null
  const tally = (values) => values.reduce((result, value) => {
    const key = String(value ?? 'missing')
    result[key] = (result[key] ?? 0) + 1
    return result
  }, {})
  const unavailable = (value) => value.status === 503 && value.checks?.redis === false
  const unowned = (value) => value.status === 200 && value.partitionIndex === null && value.ready === false
  const healthy = (value) => value.status === 200 && value.checks?.redis === true
  const perCell = Object.fromEntries(['a', 'b'].map((key) => {
    const ready = records[key].ready
    const state = records[key].state
    const beforeReady = inPhase(ready, 'before')
    const duringReady = inPhase(ready, 'paused')
    const duringState = inPhase(state, 'paused')
    const afterReady = inPhase(ready, 'unpaused')
    const afterState = inPhase(state, 'unpaused')
    const firstUnavailable = earliest(duringReady, unavailable)
    const firstUnowned = earliest(duringState, unowned)
    const firstRecovered = earliest(afterReady, healthy)
    if (!beforeReady.some(healthy)) issues.push(`${key}: no healthy pre-pause readiness sample`)
    if (!firstUnavailable) issues.push(`${key}: no paused 503 with checks.redis=false`)
    if (!firstUnowned) issues.push(`${key}: no paused partitionIndex=null with ready=false`)
    if (!firstRecovered) issues.push(`${key}: no healthy post-unpause readiness sample`)
    return [key, {
      readyStatusesDuringPause: tally(duringReady.map((value) => value.status ?? value.error)),
      redisCheckDuringPause: tally(duringReady.map((value) => value.checks?.redis ?? 'n/a')),
      platformStatusesDuringPause: tally(duringState.map((value) => value.status ?? value.error)),
      firstReady503AfterPauseMs: delay(firstUnavailable, pauseAck),
      firstPartitionNullAfterPauseMs: delay(firstUnowned, pauseAck),
      firstNotReadyAfterPauseMs: delay(firstUnowned, pauseAck),
      readyStatusesBeforePause: tally(beforeReady.map((value) => value.status ?? value.error)),
      redisCheckBeforePause: tally(beforeReady.map((value) => value.checks?.redis ?? 'n/a')),
      convergedCheckBeforePause: tally(beforeReady.map((value) => value.checks?.syncCellConverged ?? 'n/a')),
      firstReady200AfterUnpauseMs: delay(firstRecovered, resumeAck),
      firstPartitionOwnedAfterUnpauseMs: delay(earliest(afterState, (value) => (
        value.status === 200 && Number.isInteger(value.partitionIndex) && value.ready === true
      )), resumeAck),
      stateBeforePause: latest(inPhase(state, 'before')),
      stateAtEndOfPause: latest(duringState),
      stateAtEndOfRecovery: latest(afterState),
      arrivalCounts: Object.fromEntries(['before', 'transition', 'paused', 'unpaused'].map((phase) => [phase, {
        ready: inPhase(ready, phase).length, state: inPhase(state, phase).length,
      }])),
    }]
  }))
  // Keep the gate's four-answer shape. All four must have ARRIVED during the
  // pause; choose the earliest completed matching batch, not the first tick.
  const gateBatches = samples.flatMap((sample) => {
    const answers = ['a', 'b'].flatMap((key) => [sample[key]?.ready, sample[key]?.state])
    if (!answers.every((answer) => answer && phaseOf(answer.at) === 'paused')) return []
    if (!['a', 'b'].every((key) => unavailable(sample[key].ready) && unowned(sample[key].state))) return []
    return [{ at: Math.max(...answers.map((answer) => answer.at)), tick: sample.t }]
  })
  const firstGate = earliest(gateBatches)
  if (!firstGate) issues.push('no complete four-answer gate witness during the pause')
  const duringRouter = inPhase(records.router, 'paused')
  const firstRouter503 = earliest(duringRouter, (value) => value.status === 503 && value.body?.checks?.redis === false)
  const firstRouter200 = earliest(inPhase(records.router, 'unpaused'), (value) => value.status === 200 && value.body?.checks?.redis === true)
  if (!inPhase(records.router, 'before').some((value) => value.status === 200 && value.body?.checks?.redis === true)) issues.push('router: no healthy pre-pause sample')
  if (!firstRouter503) issues.push('router: no paused 503 with checks.redis=false')
  if (!firstRouter200) issues.push('router: no healthy post-unpause sample')
  const pausedTicks = samples.map((sample) => sample.t).filter((at) => phaseOf(at) === 'paused').sort((a, b) => a - b)
  const gaps = pausedTicks.slice(1).map((at, i) => at - pausedTicks[i])
  return {
    label,
    measurementValid: issues.length === 0,
    measurementIssues: [...new Set(issues)],
    t0Iso: Number.isFinite(t0) ? new Date(t0).toISOString() : null,
    pauseStartedAtMs: pauseBegin,
    pausedAtMs: pauseAck,
    pausedAtIso: Number.isFinite(pausedAt) ? new Date(pausedAt).toISOString() : null,
    unpauseStartedAtMs: resumeBegin,
    unpausedAtMs: resumeAck,
    pauseCommandDurationMs: boundariesValid ? pausedAt - pauseStartedAt : null,
    unpauseCommandDurationMs: boundariesValid ? unpausedAt - unpauseStartedAt : null,
    timingOrigin: 'command-completion; replies inside command begin/completion intervals are transitions',
    sampleCount: samples.length,
    samplePeriodMs,
    pausedTickPeriodMs: gaps.length ? { min: Math.min(...gaps), max: Math.max(...gaps), ticks: pausedTicks.length } : null,
    gateEverHeldDuringPause: Boolean(firstGate),
    gateFirstHeldAtMs: firstGate?.at ?? null,
    gateFirstHeldTickMs: firstGate?.tick ?? null,
    perCell,
    router: {
      service: 'sync-ws-router', sampleCount: records.router.length,
      samplePeriodMs: routerSamplePeriodMs,
      readyStatusesDuringPause: tally(duringRouter.map((value) => value.status ?? value.error)),
      redisCheckDuringPause: tally(duringRouter.map((value) => value.body?.checks?.redis ?? 'n/a')),
      firstReady503AfterPauseMs: delay(firstRouter503, pauseAck),
      firstReady200AfterUnpauseMs: delay(firstRouter200, resumeAck),
      statusBeforePause: latest(inPhase(records.router, 'before'))?.status ?? null,
      statusAtEndOfRecovery: latest(inPhase(records.router, 'unpaused'))?.status ?? null,
      maxExecMs: Math.max(0, ...records.router.map((value) => value.execMs ?? 0)),
    },
  }
}
