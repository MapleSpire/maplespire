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
import { evaluateAutomergeMemorySoak, parseAutomergeMemorySoakConfig } from './automergeMemorySoakCore.mjs'

const baseline = {
  rss: 600_000_000, external: 250_000_000, handles: 17, peerReferences: 18,
  numOps: 200_000, numChanges: 800,
}
const load = {
  fullyConverged: true, missingFields: 0, hotDiverged: 0,
  convergenceMs: 500,
  serverTransport: {
    rssBytes: 625_000_000, backpressureDisconnectsDelta: 0,
    droppedOutboundFramesDelta: 0, eventLoopDelayP99Ms: 25,
  },
}
const config = {
  users: 25, handleAllowance: 2, peerAllowance: 2, capacityBytes: 1024 ** 3,
  maxConvergenceMs: 3_000, maxEventLoopP99Ms: 100, abnormalCloseAllowance: 2,
}

test('accepts a returned, converged 20-wave memory profile', () => {
  const waves = Array.from({ length: 20 }, (_, index) => ({
    wave: index + 1,
    load,
    memory: {
      ...baseline,
      rss: 610_000_000 + (index % 2) * 1_000_000,
      external: 252_000_000,
      numOps: baseline.numOps + (index + 1) * 1_000,
      numChanges: baseline.numChanges + (index + 1) * 10,
    },
  }))
  const result = evaluateAutomergeMemorySoak({
    baseline,
    transportBaseline: { abnormalCloses: 10 },
    waves: waves.map((wave, index) => ({
      ...wave,
      transport: { abnormalCloses: 10 + (index === waves.length - 1 ? 1 : 0) },
    })),
  }, config)
  assert.equal(result.outcome, 'passed')
  assert.equal(result.memoryOutcome, 'passed')
  assert.equal(result.strictReturn, true)
  assert.equal(result.addedOps, 20_000)
})

test('rejects orphaned peers and monotone native growth', () => {
  const waves = Array.from({ length: 8 }, (_, index) => ({
    wave: index + 1,
    load,
    memory: {
      ...baseline,
      rss: baseline.rss + (index + 1) * 30_000_000,
      external: baseline.external + (index + 1) * 20_000_000,
      peerReferences: baseline.peerReferences + 25,
      numOps: baseline.numOps + (index + 1) * 1_000,
      numChanges: baseline.numChanges + (index + 1) * 10,
    },
  }))
  const result = evaluateAutomergeMemorySoak({ baseline, waves }, config)
  assert.equal(result.outcome, 'failed')
  assert.ok(result.failures.includes('peer references did not return to baseline'))
  assert.ok(result.failures.includes('RSS grew monotonically after warm-up'))
})

test('reports a bounded memory plateau but fails enterprise convergence and close SLOs', () => {
  const waves = [{
    wave: 1,
    load: {
      ...load,
      convergenceMs: 10_700,
      serverTransport: { ...load.serverTransport, eventLoopDelayP99Ms: 102 },
    },
    memory: { ...baseline, rss: 605_000_000, external: 251_000_000 },
    transport: { abnormalCloses: 20 },
  }, {
    wave: 2,
    load,
    memory: { ...baseline, rss: 606_000_000, external: 251_000_000 },
    transport: { abnormalCloses: 20 },
  }]
  const result = evaluateAutomergeMemorySoak({
    baseline,
    transportBaseline: { abnormalCloses: 10 },
    waves,
  }, config)
  assert.equal(result.memoryOutcome, 'passed')
  assert.equal(result.outcome, 'failed')
  assert.ok(result.failures.includes('wave 1 exceeded convergence budget'))
  assert.ok(result.failures.includes('wave 1 exceeded event-loop p99 budget'))
  assert.ok(result.failures.some((failure) => failure.startsWith('abnormal WebSocket closes')))
})

test('parses a bounded explicit target', () => {
  const parsed = parseAutomergeMemorySoakConfig({}, [
    '--target=automerge:abc', '--waves=3', '--capacityMb=2048',
    '--followCurrent=on', '--pgUrl=postgres://test',
  ])
  assert.equal(parsed.targetUrl, 'automerge:abc')
  assert.equal(parsed.waves, 3)
  assert.equal(parsed.capacityBytes, 2048 * 1024 * 1024)
  assert.equal(parsed.followCurrent, true)
  assert.equal(parsed.pgUrl, 'postgres://test')
})
