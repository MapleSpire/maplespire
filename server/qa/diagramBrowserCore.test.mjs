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

// The rules of the BROWSER arm, pure so they are tested without Chromium.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateBrowserArm,
  evaluateHybridCampaign,
  evaluateLivenessWitness,
  evaluateObserverCapture,
  splitCostLegs,
  summarizeObserverFrames,
} from './diagramBrowserCore.mjs'

const observer = (overrides = {}) => ({
  index: 0,
  connected: true,
  inboundFrames: 120,
  inboundBytes: 45_000,
  navigations: 1,
  longTaskCaptureEnabled: true,
  longTasks: [{ startMs: 1_000, durationMs: 60 }],
  frameProcessingMs: [4, 6, 9, 55],
  heartbeatGaps: [{ startMs: 1_000, endMs: 1_060, durationMs: 60 }],
  ...overrides,
})

// ── The external witness: a blocked tab reports nothing, and
//    "no long task recorded" reads exactly like "no long task". ──

test('evaluateLivenessWitness accepts a gap that a long task explains', () => {
  const verdict = evaluateLivenessWitness(
    [{ startMs: 1_000, endMs: 1_060, durationMs: 60 }],
    [{ startMs: 995, durationMs: 70 }],
    { budgetMs: 50 },
  )
  assert.equal(verdict.ok, true)
  assert.equal(verdict.unexplainedGaps.length, 0)
})

test('evaluateLivenessWitness VOIDS a gap with no long task to explain it — the capture failed', () => {
  const verdict = evaluateLivenessWitness(
    [{ startMs: 5_000, endMs: 5_400, durationMs: 400 }],
    [{ startMs: 1_000, durationMs: 60 }],
    { budgetMs: 50 },
  )
  assert.equal(verdict.ok, false)
  assert.equal(verdict.unexplainedGaps.length, 1)
  assert.match(verdict.reason, /VOID/)
})

test('evaluateLivenessWitness ignores gaps inside the budget', () => {
  const verdict = evaluateLivenessWitness([{ startMs: 1, endMs: 30, durationMs: 29 }], [], { budgetMs: 50 })
  assert.equal(verdict.ok, true)
})

test('evaluateLivenessWitness voids when the witness never beat at all', () => {
  const verdict = evaluateLivenessWitness(null, [], { budgetMs: 50 })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /VOID/)
})

// ── An observer that did not observe ──

test('evaluateObserverCapture passes a healthy observer', () => {
  const verdict = evaluateObserverCapture(observer(), { livenessBudgetMs: 50 })
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.voids, [])
})

test('evaluateObserverCapture VOIDS a browser that never joined the document', () => {
  const verdict = evaluateObserverCapture(observer({ inboundFrames: 0, connected: false }), { livenessBudgetMs: 50 })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.voids.some((reason) => /never joined|no inbound/i.test(reason)))
})

test('evaluateObserverCapture VOIDS when the long-task capture was off', () => {
  const verdict = evaluateObserverCapture(observer({ longTaskCaptureEnabled: false, longTasks: [] }), { livenessBudgetMs: 50 })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.voids.some((reason) => /long ?task/i.test(reason)))
})

test('evaluateObserverCapture VOIDS a page that reloaded inside the window', () => {
  // Trap 4: an HMR reload mid-window invalidates everything the page recorded.
  const verdict = evaluateObserverCapture(observer({ navigations: 2 }), { livenessBudgetMs: 50 })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.voids.some((reason) => /reload|navigat/i.test(reason)))
})

test('evaluateObserverCapture VOIDS on an unexplained liveness gap', () => {
  const verdict = evaluateObserverCapture(
    observer({ heartbeatGaps: [{ startMs: 9_000, endMs: 9_500, durationMs: 500 }] }),
    { livenessBudgetMs: 50 },
  )
  assert.equal(verdict.ok, false)
  assert.ok(verdict.voids.some((reason) => /witness|gap/i.test(reason)))
})

// ── The three legs, and the client/server split ──

test('splitCostLegs keeps client cost and server cost in separate fields', () => {
  const legs = splitCostLegs({
    emitMs: { p50: 0.3, p99: 1.2, count: 900 },
    serverEventLoopMs: { p50: 2, p99: 12, max: 30 },
    serverSyncCpuMs: { receiveTotalMs: 400, generateTotalMs: 1_200, receiveCount: 900, generateCount: 8_100 },
    observerReceiveMs: { p50: 8, p99: 61, count: 500 },
  })
  assert.ok(legs.client, 'client leg missing')
  assert.ok(legs.server, 'server leg missing')
  assert.equal(legs.client.emitMs.p99, 1.2)
  assert.equal(legs.client.receiveMs.p99, 61)
  assert.equal(legs.server.eventLoopMs.p99, 12)
  assert.equal(legs.server.generateCount, 8_100)
  // The whole point: a reader must never have to guess which side a number is.
  assert.equal(legs.attribution, 'client and server costs are reported separately and are NOT summed')
})

test('splitCostLegs marks the server leg unknown rather than zero when it was not captured', () => {
  const legs = splitCostLegs({ emitMs: { p99: 1 }, serverEventLoopMs: null, serverSyncCpuMs: null, observerReceiveMs: null })
  assert.equal(legs.server.eventLoopMs, null)
  assert.equal(legs.serverCaptured, false)
})

test('summarizeObserverFrames reports the receive leg from frame processing, exactly', () => {
  const summary = summarizeObserverFrames([4, 6, 9, 55])
  assert.equal(summary.count, 4)
  assert.equal(summary.max, 55)
  assert.equal(summary.p50, 6)
})

// ── The arm as a whole ──

test('evaluateBrowserArm voids when fewer observers than asked for actually observed', () => {
  const verdict = evaluateBrowserArm([observer({ index: 0 }), observer({ index: 1, inboundFrames: 0, connected: false })], {
    requestedObservers: 2,
    livenessBudgetMs: 50,
  })
  assert.equal(verdict.outcome, 'void')
  assert.ok(verdict.voids.some((reason) => /observer 1/.test(reason)))
})

test('evaluateBrowserArm passes when every observer observed', () => {
  const verdict = evaluateBrowserArm([observer({ index: 0 }), observer({ index: 1 })], {
    requestedObservers: 2,
    livenessBudgetMs: 50,
  })
  assert.equal(verdict.outcome, 'passed')
})

test('evaluateBrowserArm voids when the arm was requested and no observer started at all', () => {
  const verdict = evaluateBrowserArm([], { requestedObservers: 2, livenessBudgetMs: 50 })
  assert.equal(verdict.outcome, 'void')
})

// ── The hybrid accounting (a few browser contexts within 100 peers): the
//    browsers OBSERVE a regime they do not generate. ──

test('evaluateHybridCampaign counts browsers as peers ON the document, not as generators', () => {
  const verdict = evaluateHybridCampaign({
    nodePeers: 98,
    observers: [observer({ index: 0 }), observer({ index: 1 })],
    requestedPeersOnDocument: 100,
    requestedObservers: 2,
    livenessBudgetMs: 50,
  })
  assert.equal(verdict.peersOnDocument, 100)
  assert.equal(verdict.browserObservers, 2)
  assert.equal(verdict.loadGeneratingPeers, 98)
  assert.equal(verdict.outcome, 'passed')
})

test('evaluateHybridCampaign VOIDS when the document did not carry the requested peer count', () => {
  const verdict = evaluateHybridCampaign({
    nodePeers: 40,
    observers: [observer({ index: 0 })],
    requestedPeersOnDocument: 100,
    requestedObservers: 1,
    livenessBudgetMs: 50,
  })
  assert.equal(verdict.outcome, 'void')
  assert.ok(verdict.voids.some((reason) => /41\/100/.test(reason)))
})

test('evaluateHybridCampaign VOIDS the whole campaign when the browser arm is void', () => {
  const verdict = evaluateHybridCampaign({
    nodePeers: 99,
    observers: [observer({ index: 0, longTaskCaptureEnabled: false, longTasks: [] })],
    requestedPeersOnDocument: 100,
    requestedObservers: 1,
    livenessBudgetMs: 50,
  })
  assert.equal(verdict.outcome, 'void')
})
