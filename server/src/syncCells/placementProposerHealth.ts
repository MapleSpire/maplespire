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

import type { MetricSample } from '../runtime/metrics.js'
import { DEFAULT_PLACEMENT_POLICY, PLACEMENT_COOLDOWN_MS, type PlacementObservation,
  type PlacementAdmissionInput } from './placementHysteresis.js'
import type { ProposalWriteResult } from './placementProposer.js'

export const PROPOSER_HEALTH_INTERVAL_MS = 1_000
export const PROPOSER_HEALTH_STATES = ['disabled', 'initial-unknown', 'evaluating', 'healthy-no-proposal',
  'proposing', 'halted-signal-unknown', 'halted-oscillation-guard', 'halted-no-candidate-target',
  'warming-history', 'waiting-idle', 'warming-stability', 'revalidation-refused', 'stopped'] as const
export type ProposerHealthState = typeof PROPOSER_HEALTH_STATES[number]
type Clock = { wall(): number; monotonic(): number }
type History = PlacementAdmissionInput['history']
type Observation = { observedAtUs: string; oldestSignalAtUs: string | null; censusCount: number;
  capturedMono: number; capturedWall: number; ageMs: number }
const unknownState = (state: ProposerHealthState): boolean => state === 'initial-unknown' || state === 'halted-signal-unknown'
const badReason = new Set(['invalid-input', 'unknown-census', 'unknown-signal', 'stale-signal',
  'topology-mismatch', 'not-placed', 'no-group', 'census-changed', 'transaction-deadline', 'stopped'])

/** A local publication model, never a database client. Collection supplies the
 * already decoded global SQL snapshot and actual ActivityWitness verdicts.
 * Its freshness anchor predates admission/COMMIT/cleanup; reads only age it. */
export class PlacementProposerHealth {
  private state: ProposerHealthState
  private reason: string
  private observation: Observation | null = null
  private lastSuccess: Observation | null = null
  private unknownSince: { mono: number; wall: number } | null
  private publishedAt: string | null = null
  private history: 'unknown' | 'warming' | 'ready' = 'unknown'
  private blocked = true
  private frames = 0
  private candidates = 0
  private exhausted = false
  private results = { admitted: 0, 'already-admitted': 0, refused: 0, unknown: 0 }
  private admittedMembers = 0
  private lastAdmission: { id: string; landscapeId: string; toPartition: number; purpose: string;
    memberCount: number; evaluatedAtUs: string; acknowledgedAt: string } | null = null
  private lastReconciledId: string | null = null

  constructor(readonly enabled: boolean, private readonly clock: Clock = {
    wall: Date.now, monotonic: () => performance.now(),
  }) {
    this.state = enabled ? 'initial-unknown' : 'disabled'
    this.reason = enabled ? 'no-observation' : 'flag-off'
    this.unknownSince = enabled ? { mono: clock.monotonic(), wall: clock.wall() } : null
  }
  private expire(): void {
    if (!this.enabled || this.state === 'stopped' || !this.observation) return
    const now = this.clock.monotonic(), o = this.observation
    const elapsed = now - o.capturedMono
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      this.state = 'halted-signal-unknown'; this.reason = 'invalid-clock'; this.blocked = true
      this.unknownSince ??= { mono: o.capturedMono, wall: o.capturedWall }
    } else if (o.ageMs + elapsed >= DEFAULT_PLACEMENT_POLICY.maxSignalAgeMs) {
      this.state = 'halted-signal-unknown'; this.reason = 'observation-expired'; this.blocked = true
      // Start at the actual expiry, even if no publication/scrape happened then.
      const remaining = Math.max(0, DEFAULT_PLACEMENT_POLICY.maxSignalAgeMs - o.ageMs)
      this.unknownSince ??= { mono: o.capturedMono + remaining, wall: o.capturedWall + remaining }
    }
  }
  unknown(reason: string): void {
    this.expire()
    if (!this.enabled || this.state === 'stopped') return
    this.state = 'halted-signal-unknown'; this.reason = reason; this.blocked = true
    this.unknownSince ??= { mono: this.clock.monotonic(), wall: this.clock.wall() }
  }
  stop(): void {
    this.state = 'stopped'; this.reason = 'stopped'; this.blocked = true; this.unknownSince = null
  }

  /** Validate facts even when no candidate exists. Policy short-circuit refusals
   * (no-change/target-not-authorized) do not establish global history coverage. */
  observe(frame: PlacementObservation, history: History, capturedMono: number, queryAgeMs: number, frames: number): void {
    this.expire()
    if (!this.enabled || this.state === 'stopped') return
    let ageMs = queryAgeMs, oldest: bigint | null = null
    let valid = frame.complete && frame.topology.placementMode === 'placed'
      && Number.isFinite(queryAgeMs) && queryAgeMs >= 0
    for (const workspace of frame.workspaces) {
      const verdict = workspace.activity.verdict
      const at = verdict.observedAt === null ? NaN : Date.parse(verdict.observedAt)
      if (verdict.kind === 'unknown' || !Number.isSafeInteger(at) || at < 0
        || verdict.ageMs === null || !Number.isFinite(verdict.ageMs) || verdict.ageMs < 0
        || !Number.isSafeInteger(verdict.sampleCount) || verdict.sampleCount <= 0) { valid = false; continue }
      const us = BigInt(at) * 1_000n
      if (us > frame.atUs) valid = false
      oldest = oldest === null || us < oldest ? us : oldest
      ageMs = Math.max(ageMs, verdict.ageMs, Number(frame.atUs - us) / 1_000)
    }
    this.observation = { observedAtUs: frame.atUs.toString(), oldestSignalAtUs: oldest?.toString() ?? null,
      censusCount: frame.workspaces.length, capturedMono,
      capturedWall: this.clock.wall() - (this.clock.monotonic() - capturedMono), ageMs }
    this.frames = frames; this.candidates = 0; this.exhausted = false
    const coverage = [history.proposalCoverage, history.movementCoverage]
    this.history = coverage.every(c => c && c.origin && typeof c.fromBeginning === 'boolean'
      && c.fromUs >= 0n && c.fromUs <= c.throughUs && c.throughUs === frame.atUs)
      ? coverage.every(c => c!.fromUs <= frame.atUs - BigInt(PLACEMENT_COOLDOWN_MS) * 1_000n) ? 'ready' : 'warming'
      : 'unknown'
    if (!valid) { this.unknown('invalid-observation'); return }
    if (this.history === 'unknown') { this.unknown('history-unavailable'); return }
    const elapsed = this.clock.monotonic() - capturedMono
    if (!Number.isFinite(elapsed) || elapsed < 0) { this.unknown('invalid-clock'); return }
    if (ageMs + elapsed >= DEFAULT_PLACEMENT_POLICY.maxSignalAgeMs) {
      this.unknown('observation-expired'); return
    }
    // A readable snapshot is not yet a successful pass: global policy
    // validation or transactional revalidation can still be unknown. Keep
    // an existing episode until finish positively classifies this frame.
    this.blocked = false
    if (!this.unknownSince) { this.state = 'evaluating'; this.reason = 'evaluating-candidates' }
    this.expire()
  }
  private classified(state: ProposerHealthState, reason: string): void {
    this.state = state; this.reason = reason; this.unknownSince = null
    if (this.history === 'ready' && this.observation) this.lastSuccess = { ...this.observation }
  }
  finish(outcomes: readonly ProposalWriteResult[], exhausted: boolean): void {
    this.expire()
    this.candidates = outcomes.length; this.exhausted = exhausted
    for (const outcome of outcomes) {
      this.results[outcome.kind] += 1
      if (outcome.kind === 'admitted') {
        this.admittedMembers += outcome.admission.members.length
        this.lastAdmission = { id: outcome.id, landscapeId: outcome.admission.landscapeId,
          toPartition: outcome.admission.members[0]!.toPartition, purpose: outcome.admission.purpose,
          memberCount: outcome.admission.members.length, evaluatedAtUs: outcome.admission.evaluatedAtUs.toString(),
          acknowledgedAt: new Date(this.clock.wall()).toISOString() }
      }
      if (outcome.kind === 'already-admitted') this.lastReconciledId = outcome.id
    }
    if (outcomes.some(o => o.kind === 'unknown' || (o.kind === 'refused'
      && (badReason.has(o.reason) || (o.reason === 'warming-history' && this.history === 'ready'))))) {
      this.unknown('evaluation-unknown'); return
    }
    if (this.blocked || this.state === 'stopped') return
    if (outcomes.some(o => o.kind === 'admitted')) { this.classified('proposing', 'admitted'); return }
    if (this.history === 'warming') { this.classified('warming-history', 'warming-history'); return }
    const reasons = outcomes.flatMap(o => o.kind === 'refused' ? [o.reason] : [])
    if (reasons.some(reason => reason === 'recent-proposal' || reason === 'recent-movement')) {
      this.classified('halted-oscillation-guard', 'recent-admission-or-movement')
    } else if (reasons.includes('group-not-idle')) {
      this.classified('waiting-idle', 'group-not-idle')
    } else if (reasons.includes('warming-stability')) {
      this.classified('warming-stability', 'warming-stability')
    } else if (!exhausted) {
      this.classified('revalidation-refused', 'pass-ended-after-admission-check')
    } else if (outcomes.length > 0 && reasons.length === outcomes.length
      && reasons.every(reason => reason === 'no-change' || reason === 'target-not-authorized')) {
      this.classified('halted-no-candidate-target', 'no-authorized-alternative')
    } else if (this.observation?.censusCount === 0 || (reasons.length === outcomes.length && reasons.length > 0
      && reasons.every(reason => ['no-change', 'target-not-authorized', 'insufficient-gain'].includes(reason)))) {
      this.classified('healthy-no-proposal', this.observation?.censusCount === 0 ? 'empty-active-fleet' : 'no-proposal-needed')
    } else this.unknown('evaluation-incomplete')
  }
  reconciled(outcome: ProposalWriteResult): void {
    this.results[outcome.kind] += 1
    if (outcome.kind === 'already-admitted') this.lastReconciledId = outcome.id
    // Reconciliation has no new activity frame and cannot heal the signal.
    this.unknown(outcome.kind === 'unknown' ? 'reconciliation-unknown' : 'awaiting-fresh-observation')
  }
  publish(sampleCount: number, emit?: (value: ProposerHealthSnapshot) => void): ProposerHealthSnapshot {
    const publishedAt = new Date(this.clock.wall()).toISOString()
    const snapshot = { ...this.snapshot(sampleCount), publishedAt }
    // The sink accepted this write synchronously; this is not an OS flush or
    // remote-receipt acknowledgement. A throwing sink keeps the old timestamp.
    emit?.(snapshot)
    this.publishedAt = publishedAt
    return snapshot
  }
  snapshot(sampleCount: number): ProposerHealthSnapshot {
    this.expire()
    const now = this.clock.monotonic(), o = this.observation, success = this.lastSuccess
    const age = (value: number): number | null => Number.isFinite(value) && value >= 0 ? value : null
    return { kind: 'proposer-health', state: this.state, reason: this.reason, enabled: this.enabled,
      observedAtUs: o?.observedAtUs ?? null, oldestSignalAtUs: o?.oldestSignalAtUs ?? null,
      publishedAt: this.publishedAt, renderedAt: new Date(this.clock.wall()).toISOString(),
      ageMs: o ? age(o.ageMs + now - o.capturedMono) : null, sampleCount,
      censusCount: o?.censusCount ?? null, frames: this.frames, candidates: this.candidates, exhausted: this.exhausted,
      history: this.history, lastSuccessObservedAtUs: success?.observedAtUs ?? null,
      lastSuccessAgeMs: success ? age(success.ageMs + now - success.capturedMono) : null,
      unknownSince: this.unknownSince ? new Date(this.unknownSince.wall).toISOString() : null,
      unknownAgeMs: this.unknownSince ? age(now - this.unknownSince.mono) : null,
      results: { ...this.results }, admittedMembers: this.admittedMembers,
      lastAdmission: this.lastAdmission ? { ...this.lastAdmission } : null, lastReconciledId: this.lastReconciledId }
  }
}
export interface ProposerHealthSnapshot {
  kind: 'proposer-health'; state: ProposerHealthState; reason: string; enabled: boolean
  observedAtUs: string | null; oldestSignalAtUs: string | null; publishedAt: string | null; renderedAt: string
  ageMs: number | null; sampleCount: number; censusCount: number | null; frames: number; candidates: number; exhausted: boolean
  history: 'unknown' | 'warming' | 'ready'; lastSuccessObservedAtUs: string | null; lastSuccessAgeMs: number | null
  unknownSince: string | null; unknownAgeMs: number | null
  results: Record<ProposalWriteResult['kind'], number>; admittedMembers: number
  lastAdmission: { id: string; landscapeId: string; toPartition: number; purpose: string; memberCount: number;
    evaluatedAtUs: string; acknowledgedAt: string } | null
  lastReconciledId: string | null
}

/** Bounded labels only. Identities and recommendation details remain in JSON
 * and the durable proposal table, never in Prometheus label values. */
export function placementProposerMetricSamples(snapshot: ProposerHealthSnapshot): MetricSample[] {
  const seconds = (ms: number | null): number => ms === null ? NaN : ms / 1_000
  const timestamp = (us: string | null): number => us === null ? NaN : Number(us) / 1_000_000
  return [
    { name: 'maplespire_placement_proposer_enabled', help: 'Explicit activation, not inferred from target absence.',
      type: 'gauge', values: [{ value: Number(snapshot.enabled) }] },
    { name: 'maplespire_placement_proposer_state', help: 'Current local state, one-hot over a fixed enum.', type: 'gauge',
      values: PROPOSER_HEALTH_STATES.map(state => ({ labels: { state }, value: Number(state === snapshot.state) })) },
    { name: 'maplespire_placement_proposer_signal_unknown', help: 'Initial or ongoing unknown episode.', type: 'gauge',
      values: [{ value: Number(unknownState(snapshot.state)) }] },
    { name: 'maplespire_placement_proposer_unknown_age_seconds', help: 'Continuous unknown duration; NaN outside unknown.', type: 'gauge',
      values: [{ value: seconds(snapshot.unknownAgeMs) }] },
    { name: 'maplespire_placement_proposer_observation_age_seconds', help: 'Conservative global observation age; never refreshed by scrape.', type: 'gauge',
      values: [{ value: seconds(snapshot.ageMs) }] },
    { name: 'maplespire_placement_proposer_observed_timestamp_seconds', help: 'PG snapshot time; NaN before first observation.', type: 'gauge',
      values: [{ value: timestamp(snapshot.observedAtUs) }] },
    { name: 'maplespire_placement_proposer_published_timestamp_seconds', help: 'Last JSON health publication wall time, distinct from render time.', type: 'gauge',
      values: [{ value: snapshot.publishedAt === null ? NaN : Date.parse(snapshot.publishedAt) / 1_000 }] },
    { name: 'maplespire_placement_proposer_last_success_timestamp_seconds', help: 'PG time of last complete fresh observation with ready history.', type: 'gauge',
      values: [{ value: timestamp(snapshot.lastSuccessObservedAtUs) }] },
    { name: 'maplespire_placement_proposer_last_success_age_seconds', help: 'Conservative age of last successful observation, retained on failure.', type: 'gauge',
      values: [{ value: seconds(snapshot.lastSuccessAgeMs) }] },
    { name: 'maplespire_placement_proposer_activity_queries_total', help: 'Actual ActivityWitness dispatches, including failures and retired witnesses.', type: 'counter',
      values: [{ value: snapshot.sampleCount }] },
    { name: 'maplespire_placement_proposer_candidate_results_total', help: 'Candidate results, including preview refusals; reconciliation counted separately by outcome.', type: 'counter',
      values: Object.entries(snapshot.results).map(([outcome, value]) => ({ labels: { outcome }, value })) },
    { name: 'maplespire_placement_proposer_admitted_members_total', help: 'Members of groups acknowledged after COMMIT; excludes reconciliation.', type: 'counter',
      values: [{ value: snapshot.admittedMembers }] },
    { name: 'maplespire_placement_proposer_census_workspaces', help: 'Last collected census count; NaN before collection.', type: 'gauge',
      values: [{ value: snapshot.censusCount ?? NaN }] },
  ]
}
