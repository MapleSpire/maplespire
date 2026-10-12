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

function boundedInteger(raw, fallback, minimum, maximum, label) {
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

export function parseAutomergeMemorySoakConfig(env = process.env, argv = process.argv.slice(2)) {
  const arg = (name) => argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  const enabled = (value) => ['1', 'true', 'on'].includes(String(value ?? '').toLowerCase())
  const targetUrl = arg('target') || env.AM_MEMORY_TARGET_URL?.trim()
  if (!targetUrl?.startsWith('automerge:')) throw new Error('AM_MEMORY_TARGET_URL/--target must be an automerge: URL')
  return {
    baseUrl: (arg('baseUrl') || env.AM_MEMORY_BASE_URL || 'http://localhost:3015').replace(/\/$/, ''),
    wsUrl: arg('wsUrl') || env.AM_MEMORY_WS_URL || 'ws://localhost:3015/automerge',
    email: arg('email') || env.AM_MEMORY_EMAIL || 'admin@example.com',
    landscapeId: arg('landscapeId') || env.AM_MEMORY_LANDSCAPE_ID || 'n54y6DChuvuGnnYu',
    versionId: arg('versionId') || env.AM_MEMORY_VERSION_ID || '88uoFIGymDEvzxR6',
    targetUrl,
    followCurrent: enabled(arg('followCurrent') || env.AM_MEMORY_FOLLOW_CURRENT),
    pgUrl: arg('pgUrl') || env.AM_MEMORY_PG_URL || 'postgres://maplespire:maplespire@localhost:5455/maplespire',
    waves: boundedInteger(arg('waves') || env.AM_MEMORY_WAVES, 20, 2, 100, 'waves'),
    users: boundedInteger(arg('users') || env.AM_MEMORY_USERS, 25, 2, 100, 'users'),
    rounds: boundedInteger(arg('rounds') || env.AM_MEMORY_ROUNDS, 3, 1, 20, 'rounds'),
    objects: boundedInteger(arg('objects') || env.AM_MEMORY_OBJECTS, 10, 1, 100, 'objects'),
    settleMs: boundedInteger(arg('settleMs') || env.AM_MEMORY_SETTLE_MS, 45_000, 5_000, 180_000, 'settleMs'),
    staggerMs: boundedInteger(arg('staggerMs') || env.AM_MEMORY_STAGGER_MS, 40, 0, 2_000, 'staggerMs'),
    idleWaitMs: boundedInteger(arg('idleWaitMs') || env.AM_MEMORY_IDLE_WAIT_MS, 17_000, 0, 120_000, 'idleWaitMs'),
    capacityBytes: boundedInteger(arg('capacityMb') || env.AM_MEMORY_CAPACITY_MB, 1_024, 256, 65_536, 'capacityMb') * 1024 * 1024,
    handleAllowance: boundedInteger(env.AM_MEMORY_HANDLE_ALLOWANCE, 2, 0, 100, 'AM_MEMORY_HANDLE_ALLOWANCE'),
    peerAllowance: boundedInteger(env.AM_MEMORY_PEER_ALLOWANCE, 2, 0, 100, 'AM_MEMORY_PEER_ALLOWANCE'),
    maxConvergenceMs: boundedInteger(arg('maxConvergenceMs') || env.AM_MEMORY_MAX_CONVERGENCE_MS, 3_000, 100, 180_000, 'maxConvergenceMs'),
    maxEventLoopP99Ms: boundedInteger(arg('maxEventLoopP99Ms') || env.AM_MEMORY_MAX_EVENT_LOOP_P99_MS, 100, 10, 10_000, 'maxEventLoopP99Ms'),
    abnormalCloseAllowance: boundedInteger(env.AM_MEMORY_ABNORMAL_CLOSE_ALLOWANCE, 2, 0, 10_000, 'AM_MEMORY_ABNORMAL_CLOSE_ALLOWANCE'),
  }
}

function slope(values) {
  if (values.length < 2) return 0
  const xMean = (values.length - 1) / 2
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < values.length; index += 1) {
    numerator += (index - xMean) * (values[index] - yMean)
    denominator += (index - xMean) ** 2
  }
  return denominator ? numerator / denominator : 0
}

export function evaluateAutomergeMemorySoak(evidence, config) {
  const failures = []
  const memoryFailures = []
  for (const wave of evidence.waves) {
    if (!wave.load?.fullyConverged || wave.load?.missingFields || wave.load?.hotDiverged) {
      failures.push(`wave ${wave.wave} did not converge`)
    }
    if (wave.load?.serverTransport?.backpressureDisconnectsDelta > 0
      || wave.load?.serverTransport?.droppedOutboundFramesDelta > 0) {
      failures.push(`wave ${wave.wave} lost transport data`)
    }
    if (Number(wave.load?.convergenceMs ?? 0) > config.maxConvergenceMs) {
      failures.push(`wave ${wave.wave} exceeded convergence budget`)
    }
    if (Number(wave.load?.serverTransport?.eventLoopDelayP99Ms ?? 0) > config.maxEventLoopP99Ms) {
      failures.push(`wave ${wave.wave} exceeded event-loop p99 budget`)
    }
  }
  const baseline = evidence.baseline
  const final = evidence.waves.at(-1)?.memory
  if (!final) memoryFailures.push('no final memory sample')
  if (final && final.handles > baseline.handles + config.handleAllowance) memoryFailures.push('resident handles did not return to baseline')
  if (final && final.peerReferences > baseline.peerReferences + config.peerAllowance) memoryFailures.push('peer references did not return to baseline')

  const postWarm = evidence.waves.slice(1).map((wave) => wave.memory.rss)
  const postWarmExternal = evidence.waves.slice(1).map((wave) => wave.memory.external)
  const rssSlopeBytesPerWave = slope(postWarm)
  const externalSlopeBytesPerWave = slope(postWarmExternal)
  const rssSpreadRatio = postWarm.length
    ? (Math.max(...postWarm) - Math.min(...postWarm)) / Math.max(1, baseline.rss)
    : 0
  const strictlyMonotoneRss = postWarm.length > 2
    && postWarm.every((value, index) => index === 0 || value > postWarm[index - 1])
    && postWarm.at(-1) > postWarm[0] * 1.02
  if (strictlyMonotoneRss) memoryFailures.push('RSS grew monotonically after warm-up')

  const strictReturn = !!final
    && final.rss <= baseline.rss * 1.2
    && final.external <= baseline.external * 1.2
  const stablePlateau = !!final
    && !strictlyMonotoneRss
    && rssSpreadRatio <= 0.1
    && final.rss <= config.capacityBytes * 0.7
  if (!strictReturn && !stablePlateau) memoryFailures.push('memory neither returned within 20% nor reached a bounded plateau')

  const peakServerRss = Math.max(
    baseline.rss,
    ...evidence.waves.map((wave) => Number(wave.load?.serverTransport?.rssBytes ?? 0)),
    ...evidence.waves.map((wave) => wave.memory.rss),
  )
  if (peakServerRss > config.capacityBytes) memoryFailures.push('server RSS exceeded the configured memory budget')

  failures.push(...memoryFailures)
  const finalTransport = evidence.waves.at(-1)?.transport
  const abnormalCloseDelta = finalTransport && evidence.transportBaseline
    ? finalTransport.abnormalCloses - evidence.transportBaseline.abnormalCloses
    : 0
  if (abnormalCloseDelta > config.abnormalCloseAllowance) {
    failures.push(`abnormal WebSocket closes exceeded allowance (${abnormalCloseDelta})`)
  }

  const addedOps = final ? final.numOps - baseline.numOps : 0
  const addedChanges = final ? final.numChanges - baseline.numChanges : 0
  return {
    outcome: failures.length ? 'failed' : 'passed',
    failures: [...new Set(failures)],
    memoryOutcome: memoryFailures.length ? 'failed' : 'passed',
    memoryFailures: [...new Set(memoryFailures)],
    waves: evidence.waves.length,
    usersPerWave: config.users,
    baseline,
    final,
    peakServerRss,
    strictReturn,
    stablePlateau,
    rssSpreadRatio,
    rssSlopeBytesPerWave,
    externalSlopeBytesPerWave,
    abnormalCloseDelta,
    addedOps,
    addedChanges,
    rssBytesPerAddedOp: addedOps > 0 && final ? (final.rss - baseline.rss) / addedOps : 0,
    externalBytesPerAddedOp: addedOps > 0 && final ? (final.external - baseline.external) / addedOps : 0,
  }
}
