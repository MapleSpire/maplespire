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

import { describe, expect, it } from 'vitest'
import { PlacementProposerHealth, placementProposerMetricSamples, PROPOSER_HEALTH_STATES } from './placementProposerHealth.js'
import { placementProposerMetricsConfig } from './placementProposerConfig.js'
import type { PlacementAdmissionInput, PlacementObservation } from './placementHysteresis.js'
import type { ProposalWriteResult } from './placementProposer.js'
import { renderPrometheus } from '../runtime/metrics.js'

const epoch = Date.parse('2026-09-13T12:00:00Z')
function fixture(enabled = true) {
  let mono = 0
  const health = new PlacementProposerHealth(enabled, { wall: () => epoch + mono, monotonic: () => mono })
  const observe = (options: { age?: number; empty?: boolean; history?: 'missing' | 'warm'; at?: number } = {}) => {
    const atUs = BigInt(epoch + (options.at ?? mono)) * 1_000n
    const signalAt = new Date(Number(atUs / 1_000n)).toISOString()
    const frame: PlacementObservation = { atUs, origin: 'test-origin', complete: true,
      topology: { generation: 'v1.ce1461953e2b8ac2', partitionCount: 1, placementMode: 'placed', reservedPartitions: [] },
      grants: [], workspaces: options.empty ? [] : [{ landscapeId: 'subject', versionId: 'v1', tier: 'standard',
        orgId: null, orgStatus: null, placement: { generation: 'v1.ce1461953e2b8ac2', partition: 0 },
        activity: { witnessId: 'w', verdict: { kind: 'idle', workspace: { landscapeId: 'subject', versionId: 'v1' },
          observedAt: signalAt, requestStartedAt: signalAt, ageMs: options.age ?? 0, sampleCount: 7,
          facts: { workspaceStatus: 'active', claimCoverageCurrent: true, admittedDocuments: 1, missingContentDocuments: 0,
            latestContentAt: new Date(Number(atUs / 1_000n) - 600_000).toISOString(), observedAt: signalAt } } } }] }
    const coverage = { fromUs: atUs - BigInt(options.history === 'warm' ? 1000 : 25_200_000) * 1_000n,
      throughUs: atUs, origin: 'capture', fromBeginning: true }
    const history: PlacementAdmissionInput['history'] = { proposalCoverage: coverage,
      movementCoverage: options.history === 'missing' ? null : coverage, proposals: [], movements: [] }
    health.observe(frame, history, mono, options.age ?? 0, 1)
    return { frame, history }
  }
  return { health, observe, advance: (ms: number) => { mono += ms } }
}
const refusal = (reason: string): ProposalWriteResult => ({ kind: 'refused', reason })

describe('proposer publication facts and time', () => {
  it('distinguishes disabled and initial unknown without pretending to have observed anything', () => {
    expect(fixture(false).health.publish(0)).toMatchObject({ state: 'disabled', enabled: false, unknownSince: null,
      observedAtUs: null, ageMs: null, lastSuccessObservedAtUs: null, sampleCount: 0 })
    expect(fixture().health.publish(0)).toMatchObject({ state: 'initial-unknown', enabled: true,
      observedAtUs: null, lastSuccessObservedAtUs: null, unknownAgeMs: 0 })
  })
  it('keeps one initial unknown episode across reasons and beyond fifteen minutes', () => {
    const f = fixture(); f.advance(899_000); f.health.unknown('query-failed')
    expect(f.health.snapshot(2).unknownAgeMs).toBe(899_000)
    f.advance(1000); f.health.unknown('query-timeout')
    expect(f.health.snapshot(3).unknownAgeMs).toBe(900_000)
    f.advance(1); expect(f.health.snapshot(3).unknownAgeMs).toBe(900_001)
  })
  it('ages from collection rather than transaction completion or scrape', () => {
    const f = fixture(); f.observe({ age: 7_750 }); f.health.finish([refusal('no-change')], true)
    const first = f.health.publish(7)
    f.advance(2_249)
    expect(f.health.snapshot(7)).toMatchObject({ state: 'halted-no-candidate-target', ageMs: 9_999,
      observedAtUs: first.observedAtUs, publishedAt: first.publishedAt })
    f.advance(1)
    expect(f.health.snapshot(7)).toMatchObject({ state: 'halted-signal-unknown', ageMs: 10_000, unknownAgeMs: 0,
      lastSuccessObservedAtUs: first.observedAtUs })
    f.advance(900_001)
    expect(f.health.snapshot(7).unknownAgeMs).toBe(900_001)
    expect(f.health.snapshot(7).publishedAt).toBe(first.publishedAt)
  })
  it('does not postpone the unknown episode until the first scrape after expiry', () => {
    const f = fixture(); f.observe(); f.health.finish([refusal('insufficient-gain')], true)
    f.advance(910_001)
    expect(f.health.snapshot(7)).toMatchObject({ state: 'halted-signal-unknown', unknownAgeMs: 900_001 })
  })
  it('does not reset an ongoing unknown episode with newly returned but already stale samples', () => {
    const f = fixture(); f.advance(600_000); f.observe({ age: 10_000 }); f.advance(300_001)
    f.observe({ age: 10_001 })
    expect(f.health.snapshot(14)).toMatchObject({ state: 'halted-signal-unknown', unknownAgeMs: 900_001,
      lastSuccessObservedAtUs: null })
  })
  it('does not heal unknown on readable frames whose policy validation fails on every pass', () => {
    const f = fixture()
    for (let i = 0; i < 181; i++) {
      f.advance(5_000); f.observe()
      expect(f.health.snapshot(i * 7).state).toBe(i === 0 ? 'initial-unknown' : 'halted-signal-unknown')
      f.health.finish([refusal('invalid-input')], true)
    }
    expect(f.health.snapshot(1_267)).toMatchObject({ state: 'halted-signal-unknown', unknownAgeMs: 905_000,
      lastSuccessObservedAtUs: null })
    f.observe(); f.health.finish([refusal('insufficient-gain')], true)
    expect(f.health.snapshot(1_274)).toMatchObject({ state: 'healthy-no-proposal', unknownSince: null })
  })
  it('recovers only on new complete fresh facts and retains the old success during failure', () => {
    const f = fixture(); f.observe(); f.health.finish([refusal('insufficient-gain')], true)
    const first = f.health.publish(7); f.advance(800); f.health.unknown('query-failed'); f.advance(400)
    f.health.reconciled({ kind: 'already-admitted', id: 'durable-old-id' })
    expect(f.health.snapshot(8)).toMatchObject({ state: 'halted-signal-unknown', unknownAgeMs: 400,
      observedAtUs: first.observedAtUs, lastSuccessObservedAtUs: first.observedAtUs,
      results: { admitted: 0, 'already-admitted': 1 }, lastReconciledId: 'durable-old-id' })
    f.observe(); f.health.finish([refusal('insufficient-gain')], true)
    expect(f.health.snapshot(15)).toMatchObject({ state: 'healthy-no-proposal', unknownSince: null })
    expect(f.health.snapshot(15).observedAtUs).not.toBe(first.observedAtUs)
  })
  it.each([false, true])('requires both history coverages even if the fleet is empty=%s', empty => {
    const f = fixture(); f.observe({ empty, history: 'missing' })
    f.health.finish(empty ? [] : [refusal('no-change')], true)
    expect(f.health.snapshot(7).state).toBe('halted-signal-unknown')
  })
  it('keeps readable but young history separate from unknown, no-candidate and healthy', () => {
    const f = fixture(); f.observe({ history: 'warm' }); f.health.finish([refusal('no-change')], true)
    expect(f.health.snapshot(7)).toMatchObject({ state: 'warming-history', history: 'warming', lastSuccessObservedAtUs: null })
  })
  it.each([
    [['no-change'], 'halted-no-candidate-target'],
    [['target-not-authorized', 'no-change'], 'halted-no-candidate-target'],
    [['no-change', 'insufficient-gain'], 'healthy-no-proposal'],
    [['no-change', 'warming-stability'], 'warming-stability'],
    [['recent-proposal', 'no-change'], 'halted-oscillation-guard'],
    [['recent-movement', 'warming-stability'], 'halted-oscillation-guard'],
    [['no-change', 'group-not-idle'], 'waiting-idle'],
    [['group-not-idle', 'warming-stability'], 'waiting-idle'],
    [['invalid-input', 'no-change'], 'halted-signal-unknown'],
    [['no-change', 'stale-signal'], 'halted-signal-unknown'],
    [['warming-history'], 'halted-signal-unknown'],
  ] as const)('classifies all results %j as %s', (reasons, state) => {
    const f = fixture(); f.observe(); f.health.finish(reasons.map(refusal), true)
    expect(f.health.snapshot(7).state).toBe(state)
  })
  it('does not infer exhaustive no-candidate or no-need after a single transaction refusal', () => {
    const f = fixture(); f.observe(); f.health.finish([refusal('insufficient-gain')], false)
    expect(f.health.snapshot(7)).toMatchObject({ state: 'revalidation-refused', exhausted: false })
  })
  it('distinguishes a positively empty fleet from an omitted candidate evaluation', () => {
    const a = fixture(); a.observe({ empty: true }); a.health.finish([], true)
    expect(a.health.snapshot(0)).toMatchObject({ state: 'healthy-no-proposal', censusCount: 0, reason: 'empty-active-fleet' })
    const b = fixture(); b.observe(); b.health.finish([], true)
    expect(b.health.snapshot(7).state).toBe('halted-signal-unknown')
  })
  it('publishes stopped without manufacturing a new success', () => {
    const f = fixture(); f.health.stop(); f.advance(1000); f.health.unknown('query-failed')
    expect(f.health.publish(0)).toMatchObject({ state: 'stopped', lastSuccessObservedAtUs: null, unknownSince: null })
  })
  it('does not advance the accepted publication timestamp when the sink throws', () => {
    const f = fixture(), first = f.health.publish(0)
    f.advance(1_000)
    expect(() => f.health.publish(0, () => { throw new Error('sink-failed') })).toThrow('sink-failed')
    expect(f.health.snapshot(0).publishedAt).toBe(first.publishedAt)
    expect(f.health.publish(0).publishedAt).not.toBe(first.publishedAt)
  })
  it('emits bounded labels and NaN for facts not acquired, rather than zero', () => {
    const f = fixture(); const snapshot = f.health.publish(0)
    snapshot.reason = 'workspace-secret-id'
    const metrics = placementProposerMetricSamples(snapshot), text = renderPrometheus(metrics)
    expect(text).not.toContain('workspace-secret-id')
    expect(text).toContain('maplespire_placement_proposer_observed_timestamp_seconds NaN')
    const states = metrics.find(m => m.name === 'maplespire_placement_proposer_state')!.values
    expect(states).toHaveLength(13)
    expect(states.reduce((sum, item) => sum + item.value, 0)).toBe(1)
    expect(states.filter(item => item.value === 1)).toEqual([{ labels: { state: 'initial-unknown' }, value: 1 }])
    expect(new Set(states.map(item => item.labels!.state))).toEqual(new Set(PROPOSER_HEALTH_STATES))
    expect(metrics.flatMap(m => m.values.flatMap(v => Object.keys(v.labels ?? {}))).every(k => ['state', 'outcome'].includes(k))).toBe(true)
  })
})

describe('explicit metrics endpoint configuration', () => {
  it('does not open a port unless requested', () => { expect(placementProposerMetricsConfig({})).toBeNull() })
  it.each(['', ' ', '-1', '65536', '2.2', 'NaN', 'secret-in-invalid-port'])(
    'refuses %s without a fallback or exposing it', port => {
      expect(() => placementProposerMetricsConfig({ SYNC_CELL_PLACEMENT_PROPOSER_METRICS_PORT: port, METRICS_TOKEN: 'fixture' }))
        .toThrow('invalid-proposer-metrics-port')
    })
  it('requires a token and uses loopback by default; zero allocates a port', () => {
    expect(() => placementProposerMetricsConfig({ SYNC_CELL_PLACEMENT_PROPOSER_METRICS_PORT: '0' })).toThrow('missing-proposer-metrics-token')
    expect(placementProposerMetricsConfig({ SYNC_CELL_PLACEMENT_PROPOSER_METRICS_PORT: '0', METRICS_TOKEN: 'fixture' }))
      .toEqual({ host: '127.0.0.1', port: 0, token: 'fixture' })
  })
})
