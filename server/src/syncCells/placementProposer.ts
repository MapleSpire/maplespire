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

import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { performance } from 'node:perf_hooks'
import { ActivityWitness } from './activityWitness.js'
import { admitPlacementProposal, DEFAULT_PLACEMENT_POLICY,
  type PlacementAdmission, type PlacementAdmissionInput, type PlacementObservation } from './placementHysteresis.js'
import { type ProposerConfig } from './placementProposerConfig.js'
import { auditPlacementProposerRole } from './placementProposerRole.js'
import { censusSignature, readPlacementProposerSnapshot, type ProposerSnapshot } from './placementProposerSnapshot.js'
import { PROPOSAL_TABLE, proposerSchemaName } from './placementProposerSchema.js'
import { formatTopologyContract } from './topologyContract.js'
import { PlacementProposerHealth } from './placementProposerHealth.js'

export const placementJson = (value: unknown): string => JSON.stringify(value,
  (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item)
const digest = (value: unknown): string => createHash('sha256').update(placementJson(value)).digest('hex')
const workspaceKey = (w: { landscapeId: string; versionId: string }): string => JSON.stringify([w.landscapeId, w.versionId])
type Admitted = Extract<PlacementAdmission, { kind: 'admit' }>
class AdmissionHalted extends Error {}
export const PROPOSER_TRANSACTION_BUDGET_MS = 5_000
export type ProposalWriteResult =
  | { readonly kind: 'admitted'; readonly id: string; readonly admission: Admitted }
  | { readonly kind: 'already-admitted'; readonly id: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string; readonly id: string }

export interface ObservedPlacement {
  readonly snapshot: ProposerSnapshot
  readonly observations: readonly PlacementObservation[]
}
export function placementProposalLockKey(schema: string, member: string): string {
  return JSON.stringify(['maplespire-placement-proposer-v1', schema, member])
}
function withFreshCensus(observed: ObservedPlacement, snapshot: ProposerSnapshot): PlacementObservation[] {
  const frames = observed.observations
  const last = frames[frames.length - 1]
  if (!last || snapshot.atUs < last.atUs) throw new Error('proposer-clock-reversed')
  const ageDelta = Number(snapshot.atUs - last.atUs) / 1_000
  // Replace the last frame, NEVER append a cached sample as a new observation.
  const current: PlacementObservation = { ...last, atUs: snapshot.atUs, topology: snapshot.topology,
    workspaces: snapshot.workspaces.map(w => {
      const previous = last.workspaces.find(p => workspaceKey(p) === workspaceKey(w))
      if (!previous) throw new Error('proposer-census-changed')
      const verdict = previous.activity.verdict
      return { ...w, activity: { ...previous.activity, verdict: { ...verdict,
        ageMs: verdict.ageMs === null ? null : verdict.ageMs + ageDelta } } }
    }) }
  return [...frames.slice(0, -1), current]
}
function admissionInput(config: ProposerConfig, observed: ObservedPlacement,
  landscapeId: string, toPartition: number): PlacementAdmissionInput {
  return { candidate: { landscapeId, toPartition, topology: config.topology },
    observations: observed.observations, history: observed.snapshot.history }
}

/** Single bounded transaction, under the real dedicated LOGIN. All contenders
 * lock the landscape then every full workspace identity in canonical order.
 * Existing version/ownership writers do not take these locks: the recommendation
 * describes the post-lock snapshot; it is not an actuator fence for future writes.
 * requestId survives an uncertain COMMIT; callers may reconcile this SAME intent. */
export async function persistObservedPlacement(
  pool: Pick<Pool, 'connect'>, config: ProposerConfig, observed: ObservedPlacement,
  landscapeId: string, toPartition: number, requestId: string = randomUUID(), signal?: AbortSignal,
  reconcileOnly = false,
): Promise<ProposalWriteResult> {
  if (signal?.aborted) return { kind: 'refused', reason: 'stopped' }
  const members = observed.snapshot.workspaces.filter(w => w.landscapeId === landscapeId).map(workspaceKey).sort()
  if (!members.length) return { kind: 'refused', reason: 'no-group' }
  const intent = digest({ landscapeId, toPartition, members,
    contract: formatTopologyContract(config.topology), grants: config.grants, policy: DEFAULT_PLACEMENT_POLICY })
  const client = await pool.connect()
  let transaction = false, committing = false, destroy = false
  const deadline = performance.now() + PROPOSER_TRANSACTION_BUDGET_MS
  const checkpoint = () => {
    if (signal?.aborted) throw new AdmissionHalted('stopped')
    if (performance.now() >= deadline) throw new AdmissionHalted('transaction-deadline')
  }
  const execute = async (): Promise<ProposalWriteResult> => {
    checkpoint()
    transaction = true
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    checkpoint()
    await auditPlacementProposerRole(client, config.schema, config.role)
    for (const member of [JSON.stringify(['landscape', landscapeId]), ...members]) {
      checkpoint()
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [placementProposalLockKey(config.schema, member)])
    }
    checkpoint()
    const snapshot = await readPlacementProposerSnapshot(client, config.schema)
    checkpoint()
    const s = proposerSchemaName(config.schema)
    const existing = await client.query<{ payload: { intent?: string } }>(
      `SELECT payload FROM ${s}.${PROPOSAL_TABLE} WHERE proposal_id = $1`, [requestId])
    checkpoint()
    if (existing.rowCount) {
      // Snapshot decoding already validates the complete atomic payload. Check
      // identity against that same snapshot, not just a UUID returned by INSERT.
      const rows = snapshot.history.proposals.filter(p => p.id === requestId)
      if (existing.rows[0].payload.intent !== intent
        || JSON.stringify(rows.map(p => workspaceKey(p.workspace)).sort()) !== JSON.stringify(members)
        || rows.some(p => p.toPartition !== toPartition
          || formatTopologyContract(p.topology) !== formatTopologyContract(config.topology))) {
        return { kind: 'unknown', reason: 'idempotency-conflict', id: requestId }
      }
      return { kind: 'already-admitted', id: requestId }
    }
    if (reconcileOnly) return { kind: 'refused', reason: 'not-admitted' }
    if (censusSignature(snapshot) !== censusSignature(observed.snapshot)) {
      return { kind: 'refused', reason: 'census-changed' }
    }
    const observations = withFreshCensus(observed, snapshot)
    const input = admissionInput(config, { snapshot, observations }, landscapeId, toPartition)
    const admission = admitPlacementProposal(input, snapshot.atUs)
    if (admission.kind !== 'admit') return { kind: 'refused', reason: admission.reason }
    checkpoint()
    const payload = { ...admission, protocol: 1, intent, memberCount: admission.members.length,
      contract: formatTopologyContract(admission.topology), policy: DEFAULT_PLACEMENT_POLICY,
      proof: { observationOrigin: observations.at(-1)!.origin, observationDigest: digest(observations),
        census: snapshot.workspaces, grants: config.grants,
        historyRows: { proposals: snapshot.history.proposals.length, movements: snapshot.history.movements.length } } }
    await client.query(`INSERT INTO ${s}.${PROPOSAL_TABLE}
      (proposal_id, landscape_id, proposed_at, payload)
      VALUES ($1, $2, TIMESTAMPTZ 'epoch' + $3::bigint * interval '1 microsecond', $4::jsonb)`,
    [requestId, landscapeId, snapshot.atUs.toString(), placementJson(payload)])
    checkpoint()
    committing = true
    await client.query('COMMIT')
    transaction = false
    return { kind: 'admitted', id: requestId, admission }
  }
  let outcome: ProposalWriteResult
  let rollbackFailed = false
  try {
    outcome = await execute()
  } catch (error) {
    // An ACK lost during COMMIT says nothing about durable admission. Do not
    // retry under another UUID and never return 'admitted' from this branch.
    if (committing) {
      destroy = true
      transaction = false
      outcome = { kind: 'unknown', reason: 'commit-uncertain', id: requestId }
    } else if (error instanceof AdmissionHalted) {
      outcome = { kind: 'refused', reason: error.message }
    } else {
      outcome = { kind: 'unknown', reason: 'transaction-failed', id: requestId }
    }
  } finally {
    try {
      if (transaction) await client.query('ROLLBACK')
    } catch {
      destroy = true
      rollbackFailed = true
    } finally {
      client.release(destroy)
    }
  }
  // Cleanup failure is surfaced after release, without throwing from finally.
  if (rollbackFailed) throw new Error('placement-proposer-rollback-failed')
  return outcome
}

export interface ProposerPass {
  readonly kind: 'observed' | 'unknown' | 'stopped'
  readonly atUs?: string
  readonly censusCount?: number
  readonly frames?: number
  readonly outcomes?: readonly ProposalWriteResult[]
  readonly reason?: string
}

/** A retained scalar witness, sampled sequentially across the actual fleet.
 * No detached timeout/retry races; stop joins the same pass and raw activity
 * query before the entrypoint closes its owned pool. */
export class PlacementProposer {
  private witness: ActivityWitness
  private witnessId = randomUUID()
  private readonly origin = randomUUID()
  private frames: PlacementObservation[] = []
  private running: Promise<ProposerPass> | null = null
  private retiredSamples = 0
  private readonly abort = new AbortController()
  private pending: { id: string; landscapeId: string; toPartition: number; observed: ObservedPlacement } | null = null

  constructor(private readonly pool: Pool, private readonly config: ProposerConfig,
    readonly health = new PlacementProposerHealth(true)) {
    this.witness = this.makeWitness()
  }
  /** The witness count is cumulative, not a count to sum on each verdict.
   * Reading it is local even while a raw PostgreSQL query is pending. */
  get sampleCount(): number { return this.retiredSamples + (this.witness.snapshot()?.sampleCount ?? 0) }
  private makeWitness(): ActivityWitness {
    return new ActivityWitness(this.pool, { idleAfterMs: DEFAULT_PLACEMENT_POLICY.activityLookbackMs })
  }
  pass(): Promise<ProposerPass> {
    if (this.abort.signal.aborted) return Promise.resolve({ kind: 'stopped' })
    if (this.running) return this.running
    this.running = this.collect().catch((): ProposerPass => {
      this.frames = []
      this.health.unknown('collection-failed')
      return { kind: 'unknown', reason: 'collection-failed' }
    }).finally(() => { this.running = null })
    return this.running
  }
  async stop(): Promise<void> {
    this.abort.abort()
    await this.witness.stop()
    await this.running
    this.health.stop()
  }
  private async collect(): Promise<ProposerPass> {
    await auditPlacementProposerRole(this.pool, this.config.schema, this.config.role)
    if (this.pending) {
      const p = this.pending
      // Keep the original intent and member set, even if versions were created,
      // retired or all deleted after an ACK was lost. Reconciliation must not
      // depend on collecting fresh activity for those former members.
      const outcome = await persistObservedPlacement(this.pool, this.config, p.observed,
        p.landscapeId, p.toPartition, p.id, this.abort.signal, true)
      this.health.reconciled(outcome)
      if (outcome.kind === 'unknown') return { kind: 'unknown', reason: outcome.reason, outcomes: [outcome] }
      this.pending = null
      return { kind: 'observed', outcomes: [outcome] }
    }
    const before = await readPlacementProposerSnapshot(this.pool, this.config.schema)
    if (formatTopologyContract(before.topology) !== formatTopologyContract(this.config.topology)) {
      this.frames = []
      this.health.unknown('topology-mismatch')
      return { kind: 'unknown', reason: 'topology-mismatch' }
    }
    const signals = new Map<string, { activity: PlacementObservation['workspaces'][number]['activity']; returnedAt: number }>()
    for (const workspace of before.workspaces) {
      if (this.abort.signal.aborted) return { kind: 'stopped' }
      const verdict = await this.witness.sample(workspace)
      if (verdict.kind === 'unknown') {
        this.frames = []
        // Publish the visible failure before joining the retained raw query.
        this.health.unknown(`activity-${verdict.reason}`)
        // A visible timeout may leave raw PG work alive. Join before ANY next
        // query or replacement instance. A new identity resets stability.
        await this.witness.stop()
        if (!this.abort.signal.aborted) {
          this.retiredSamples += this.witness.snapshot()?.sampleCount ?? 0
          this.witnessId = randomUUID()
          this.witness = this.makeWitness()
        }
        return { kind: 'unknown', reason: `activity-${verdict.reason}` }
      }
      signals.set(workspaceKey(workspace), {
        activity: { witnessId: this.witnessId, verdict }, returnedAt: performance.now(),
      })
    }
    if (this.abort.signal.aborted) return { kind: 'stopped' }
    const snapshotStarted = performance.now()
    const snapshot = await readPlacementProposerSnapshot(this.pool, this.config.schema)
    if (censusSignature(before) !== censusSignature(snapshot)) {
      this.frames = []
      this.health.unknown('census-changed')
      return { kind: 'unknown', reason: 'census-changed' }
    }
    const now = performance.now()
    const current: PlacementObservation = { atUs: snapshot.atUs, origin: this.origin, complete: true,
      topology: snapshot.topology, grants: this.config.grants,
      workspaces: snapshot.workspaces.map(w => {
        const sample = signals.get(workspaceKey(w))!
        return { ...w, activity: { ...sample.activity, verdict: { ...sample.activity.verdict,
          ageMs: sample.activity.verdict.ageMs! + now - sample.returnedAt } } }
      }) }
    const retentionUs = BigInt(DEFAULT_PLACEMENT_POLICY.returnStableMs + DEFAULT_PLACEMENT_POLICY.maxSampleGapMs) * 1_000n
    this.frames = [...this.frames.filter(f => f.atUs >= snapshot.atUs - retentionUs), current]
    this.health.observe(current, snapshot.history, now, now - snapshotStarted, this.frames.length)
    const observed = { snapshot, observations: this.frames }
    const outcomes: ProposalWriteResult[] = []
    for (const landscapeId of [...new Set(snapshot.workspaces.map(w => w.landscapeId))].sort()) {
      for (let toPartition = 0; toPartition < snapshot.topology.partitionCount; toPartition++) {
        if (this.abort.signal.aborted) return { kind: 'stopped' }
        const preview = admitPlacementProposal(admissionInput(this.config, observed, landscapeId, toPartition), snapshot.atUs)
        if (preview.kind !== 'admit') {
          outcomes.push({ kind: 'refused', reason: preview.reason })
          continue
        }
        const id = randomUUID()
        const outcome = await persistObservedPlacement(this.pool, this.config, observed,
          landscapeId, toPartition, id, this.abort.signal)
        outcomes.push(outcome)
        if (outcome.kind === 'unknown') {
          this.pending = { id, landscapeId, toPartition, observed }
          this.health.finish(outcomes, false)
          return { kind: 'unknown', reason: outcome.reason, outcomes }
        }
        // At most one attempt per pass. The next pass reads actual placement,
        // not the recommendation, and reloads all durable proposal budgets.
        this.health.finish(outcomes, false)
        return { kind: 'observed', atUs: snapshot.atUs.toString(), censusCount: snapshot.workspaces.length,
          frames: this.frames.length, outcomes }
      }
    }
    this.health.finish(outcomes, true)
    return { kind: 'observed', atUs: snapshot.atUs.toString(), censusCount: snapshot.workspaces.length,
      frames: this.frames.length, outcomes }
  }
}
