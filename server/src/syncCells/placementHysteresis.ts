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

import type { WorkspaceKey } from '../rbac/docScope.js'
import type { ActivityVerdict } from './activityWitness.js'
import { workspacePartition } from './assignment.js'
import { formatTopologyContract, type TopologyContract } from './topologyContract.js'

/** Policy choices, not measured capacity.
 * History clocks retain PostgreSQL microseconds: a move one microsecond after
 * the open boundary must not be rounded down into an admissible six-hour gap. */
export const PLACEMENT_COOLDOWN_MS = 21_600_000
export const DEFAULT_PLACEMENT_POLICY = Object.freeze({
  id: 'sampled-occupancy-v1',
  activeWeight: 2, idleWeight: 1, activityLookbackMs: 300_000,
  entryGain: 4, returnGain: 8,
  entryStableMs: 300_000, returnStableMs: 1_800_000,
  maxSampleGapMs: 10_000, maxSignalAgeMs: 10_000,
})
export type PlacementPolicy = Readonly<{ [K in keyof typeof DEFAULT_PLACEMENT_POLICY]:
  K extends 'id' ? string : number }>

export interface ReservationGrant {
  readonly partition: number
  readonly orgId: string
  /** An explicit operator grant; empty occupancy alone never grants a slot. */
  readonly landscapeIds: readonly string[]
}

export interface PlacementWorkspaceFact extends Readonly<WorkspaceKey> {
  readonly tier: 'standard' | 'enterprise'
  readonly orgId: string | null
  readonly orgStatus: string | null
  /** Null means positively absent in a complete current-generation read. */
  readonly placement: { readonly generation: string; readonly partition: number } | null
  readonly activity: { readonly witnessId: string; readonly verdict: ActivityVerdict }
}

export interface PlacementObservation {
  readonly atUs: bigint
  readonly origin: string
  /** All active versions, including those without a workspace_placement row. */
  readonly complete: boolean
  readonly topology: Readonly<TopologyContract>
  readonly grants: readonly ReservationGrant[]
  readonly workspaces: readonly PlacementWorkspaceFact[]
}

export interface PlacementHistoryCoverage {
  readonly fromUs: bigint
  readonly throughUs: bigint
  readonly origin: string
  /** False after truncation or when observation began after the writer. Used
   * only to choose conservative return hysteresis, never to waive cooldown. */
  readonly fromBeginning: boolean
}

export interface AdmittedPlacement {
  readonly id: string
  readonly workspace: Readonly<WorkspaceKey>
  readonly atUs: bigint
  readonly fromPartition: number
  readonly toPartition: number
  readonly topology: Readonly<TopologyContract>
}

export interface PlacementMovement {
  readonly id: string
  readonly workspace: Readonly<WorkspaceKey>
  readonly atUs: bigint
  readonly fromCellId: string
  readonly toCellId: string
}

export interface PlacementAdmissionInput {
  readonly candidate: {
    readonly landscapeId: string
    readonly toPartition: number
    readonly topology: Readonly<TopologyContract>
  }
  /** Ordered samples. A caller may retain the whole window; the function uses
   * its suffix. An unknown sample or a gap inside that suffix breaks stability. */
  readonly observations: readonly PlacementObservation[]
  readonly history: {
    readonly proposalCoverage: PlacementHistoryCoverage | null
    readonly movementCoverage: PlacementHistoryCoverage | null
    /** Each member of a group admission has its own workspace history row. */
    readonly proposals: readonly AdmittedPlacement[]
    readonly movements: readonly PlacementMovement[]
  }
}

type RefusalReason = 'invalid-input' | 'unknown-census' | 'unknown-signal'
  | 'stale-signal' | 'topology-mismatch' | 'not-placed' | 'no-group'
  | 'target-not-authorized' | 'no-change' | 'warming-history' | 'recent-proposal'
  | 'recent-movement' | 'insufficient-gain' | 'warming-stability' | 'group-not-idle'

export interface PlacementPolicyGain {
  readonly rightsBefore: number
  readonly rightsAfter: number
  readonly poolCostBefore: number
  readonly poolCostAfter: number
  readonly poolGain: number
}

interface AdmissionMetadata {
  readonly policyId: string
  readonly evaluatedAtUs: bigint
  readonly coverage: {
    readonly proposals: PlacementHistoryCoverage | null
    readonly movements: PlacementHistoryCoverage | null
  }
}

export type PlacementAdmission = AdmissionMetadata & (
  | { readonly kind: 'refuse'; readonly reason: RefusalReason }
  | {
    readonly kind: 'admit'
    readonly direction: 'entry' | 'return'
    readonly hysteresisReason: 'release-reservation' | 'incompatible-history' | 'previous-source' | 'retained-history' | 'first-or-forward'
    readonly purpose: 'restore-isolation' | 'balance-pool'
    readonly gain: PlacementPolicyGain
    readonly stableFromUs: bigint
    readonly stableThroughUs: bigint
    readonly sampleCount: number
    readonly topology: Readonly<TopologyContract>
    readonly landscapeId: string
    readonly orgId: string | null
    readonly members: readonly (Readonly<WorkspaceKey> & {
      readonly fromPartition: number; readonly toPartition: number
    })[]
  }
)

class Refusal extends Error {
  constructor(readonly reason: RefusalReason) { super(reason) }
}
function need(condition: unknown, reason: RefusalReason = 'invalid-input'): asserts condition {
  if (!condition) throw new Refusal(reason)
}
const identity = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 1_024 && !value.includes('\u0000')
const timestamp = (value: unknown): value is bigint => typeof value === 'bigint'
  && value >= 0n && value <= 8_640_000_000_000_000_000n
const integer = (value: unknown): value is number => Number.isSafeInteger(value)
const keyOf = (value: Readonly<WorkspaceKey>): string => JSON.stringify([value.landscapeId, value.versionId])
const micros = (milliseconds: number): bigint => BigInt(milliseconds) * 1_000n

function workspaceKey(value: Readonly<WorkspaceKey>): string {
  need(value && identity(value.landscapeId) && identity(value.versionId))
  return keyOf(value)
}
function topologyKey(value: Readonly<TopologyContract>): string {
  need(value && (value.placementMode === 'shadow' || value.placementMode === 'placed')
    && Array.isArray(value.reservedPartitions))
  try { return formatTopologyContract(value) } catch { throw new Refusal('invalid-input') }
}
function policyValid(policy: PlacementPolicy): void {
  need(policy && identity(policy.id))
  for (const field of ['activeWeight', 'idleWeight', 'activityLookbackMs', 'entryGain', 'returnGain',
    'entryStableMs', 'returnStableMs', 'maxSampleGapMs', 'maxSignalAgeMs'] as const) {
    need(integer(policy[field]) && policy[field] > 0 && policy[field] <= 2_147_483_647)
  }
  need(policy.activeWeight > policy.idleWeight && policy.returnGain > policy.entryGain
    && policy.returnStableMs > policy.entryStableMs && policy.maxSampleGapMs <= policy.entryStableMs
    && policy.maxSignalAgeMs <= policy.maxSampleGapMs)
}

function coverageValid(value: PlacementHistoryCoverage | null): PlacementHistoryCoverage | null {
  if (value == null) return null
  need(timestamp(value.fromUs) && timestamp(value.throughUs) && identity(value.origin)
    && typeof value.fromBeginning === 'boolean' && value.fromUs <= value.throughUs)
  return { ...value }
}

interface WeightedWorkspace {
  fact: PlacementWorkspaceFact
  key: string
  partition: number
  hard: boolean
  weight: number
  signalUs: bigint
}
interface EvaluatedFrame {
  frame: PlacementObservation
  group: WeightedWorkspace[]
  workspaces: WeightedWorkspace[]
  context: string
  gain: PlacementPolicyGain
}

function signalWeight(fact: PlacementWorkspaceFact, atUs: bigint, policy: PlacementPolicy): {
  weight: number; signalUs: bigint
} {
  need(fact.activity && identity(fact.activity.witnessId))
  const verdict = fact.activity.verdict
  need(verdict && workspaceKey(verdict.workspace) === keyOf(fact)
    && integer(verdict.sampleCount) && verdict.sampleCount > 0)
  need(verdict.kind === 'active' || verdict.kind === 'idle', 'unknown-signal')
  const facts = verdict.facts
  need(facts && facts.workspaceStatus === 'active' && typeof facts.claimCoverageCurrent === 'boolean'
    && integer(facts.admittedDocuments) && facts.admittedDocuments >= 0
    && integer(facts.missingContentDocuments) && facts.missingContentDocuments >= 0
    && facts.missingContentDocuments <= facts.admittedDocuments)
  const observedMs = typeof verdict.observedAt === 'string' ? Date.parse(verdict.observedAt) : NaN
  const newestMs = typeof facts.latestContentAt === 'string' ? Date.parse(facts.latestContentAt) : NaN
  need(Number.isSafeInteger(observedMs) && observedMs >= 0 && facts.observedAt === verdict.observedAt
    && (facts.latestContentAt === null || (Number.isSafeInteger(newestMs) && newestMs >= 0 && newestMs <= observedMs))
    && (facts.admittedDocuments !== 0 || facts.latestContentAt === null)
    && (facts.admittedDocuments <= facts.missingContentDocuments || facts.latestContentAt !== null))
  const signalUs = micros(observedMs)
  need(signalUs <= atUs && typeof verdict.ageMs === 'number' && Number.isFinite(verdict.ageMs)
    && verdict.ageMs >= 0)
  need(atUs - signalUs < micros(policy.maxSignalAgeMs) && verdict.ageMs < policy.maxSignalAgeMs, 'stale-signal')
  // Recompute using this policy's lookback; an ActivityWitness can be configured
  // with another lookback. Its unknown verdict still cannot become a zero.
  const active = facts.latestContentAt !== null && newestMs >= observedMs - policy.activityLookbackMs
  if (!active) need(facts.claimCoverageCurrent && facts.admittedDocuments > 0
    && facts.missingContentDocuments === 0 && facts.latestContentAt !== null, 'unknown-signal')
  return { weight: active ? policy.activeWeight : policy.idleWeight, signalUs }
}

function evaluateFrame(frame: PlacementObservation, input: PlacementAdmissionInput,
  nowUs: bigint, policy: PlacementPolicy): EvaluatedFrame {
  need(frame && timestamp(frame.atUs) && frame.atUs <= nowUs && identity(frame.origin))
  need(frame.complete === true, 'unknown-census')
  const contract = topologyKey(frame.topology)
  need(contract === topologyKey(input.candidate.topology), 'topology-mismatch')
  need(frame.topology.placementMode === 'placed', 'not-placed')
  const { partitionCount, reservedPartitions } = frame.topology
  const target = input.candidate.toPartition
  need(integer(target) && target >= 0 && target < partitionCount)
  need(Array.isArray(frame.grants) && Array.isArray(frame.workspaces))
  const grants = new Map<number, ReservationGrant>()
  for (const grant of frame.grants) {
    need(grant && integer(grant.partition) && reservedPartitions.includes(grant.partition)
      && identity(grant.orgId) && Array.isArray(grant.landscapeIds) && grant.landscapeIds.length > 0
      && grant.landscapeIds.every(identity) && new Set(grant.landscapeIds).size === grant.landscapeIds.length
      && !grants.has(grant.partition))
    grants.set(grant.partition, grant)
  }
  const keys = new Set<string>()
  const landscapes = new Map<string, string>()
  const workspaces = frame.workspaces.map(fact => {
    const key = workspaceKey(fact)
    need(!keys.has(key)); keys.add(key)
    need((fact.tier === 'standard' || fact.tier === 'enterprise')
      && (fact.orgId === null || identity(fact.orgId)) && (fact.orgStatus === null || identity(fact.orgStatus)))
    const rights = JSON.stringify([fact.tier, fact.orgId, fact.orgStatus])
    need(!landscapes.has(fact.landscapeId) || landscapes.get(fact.landscapeId) === rights)
    landscapes.set(fact.landscapeId, rights)
    const placed = fact.placement
    need(placed === null || (placed && placed.generation === frame.topology.generation
      && integer(placed.partition) && placed.partition >= 0 && placed.partition < partitionCount))
    const partition = placed === null ? workspacePartition(fact, partitionCount) : placed.partition
    return { fact, key, partition, hard: fact.tier === 'enterprise' && fact.orgStatus === 'active'
      && fact.orgId !== null, ...signalWeight(fact, frame.atUs, policy) }
  })
  const group = workspaces.filter(workspace => workspace.fact.landscapeId === input.candidate.landscapeId)
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  need(group.length > 0, 'no-group')
  const authorized = (workspace: WeightedWorkspace, partition: number): boolean => {
    if (!workspace.hard) return !reservedPartitions.includes(partition)
    const grant = grants.get(partition)
    return Boolean(grant && grant.orgId === workspace.fact.orgId && grant.landscapeIds.includes(workspace.fact.landscapeId))
  }
  need(group.every(member => authorized(member, target)), 'target-not-authorized')
  const peers = workspaces.filter(workspace => workspace.partition === target
    && workspace.fact.landscapeId !== input.candidate.landscapeId)
  // A pre-existing misplaced hard tenant is not permission to add another org
  // beside it. Likewise a grant never erases an unlisted current occupant.
  need(peers.every(peer => reservedPartitions.includes(target)
    ? authorized(peer, target)
    : !peer.hard || peer.fact.orgId === group[0]!.fact.orgId), 'target-not-authorized')
  need(group.some(member => member.partition !== target), 'no-change')
  const rightsBefore = group.filter(member => !authorized(member, member.partition)
    || (member.hard && workspaces.some(peer => peer.partition === member.partition
      && (peer.fact.orgId !== member.fact.orgId || !authorized(peer, member.partition))))).length
  const before = Array<number>(partitionCount).fill(0)
  const after = Array<number>(partitionCount).fill(0)
  for (const workspace of workspaces) {
    if (!reservedPartitions.includes(workspace.partition)) before[workspace.partition]! += workspace.weight
    const destination = workspace.fact.landscapeId === input.candidate.landscapeId ? target : workspace.partition
    if (!reservedPartitions.includes(destination)) after[destination]! += workspace.weight
  }
  const cost = (weights: number[]): number => weights.reduce((total, weight) => total + weight * weight, 0)
  const poolCostBefore = cost(before), poolCostAfter = cost(after)
  need(Number.isSafeInteger(poolCostBefore) && Number.isSafeInteger(poolCostAfter))
  const context = JSON.stringify([contract, [...grants.values()].sort((a, b) => a.partition - b.partition)
    .map(grant => [grant.partition, grant.orgId, [...grant.landscapeIds].sort()]),
  group.map(member => [member.key, member.partition, member.fact.tier, member.fact.orgId, member.fact.orgStatus])])
  return { frame, group, workspaces, context, gain: { rightsBefore, rightsAfter: 0,
    poolCostBefore, poolCostAfter, poolGain: poolCostBefore - poolCostAfter } }
}

/** Pure, synchronous recommendation admission. It does not reserve, persist or
 * apply anything. The persisting caller must re-read history and insert all
 * group members under transaction locks; passing a complete flag here cannot
 * establish SQL coverage. */
export function admitPlacementProposal(input: PlacementAdmissionInput, nowUs: bigint,
  policy: PlacementPolicy = DEFAULT_PLACEMENT_POLICY): PlacementAdmission {
  const coverage: AdmissionMetadata['coverage'] = { proposals: null, movements: null }
  let metadata: AdmissionMetadata = { policyId: policy?.id, evaluatedAtUs: nowUs, coverage }
  try {
    need(timestamp(nowUs)); policyValid(policy)
    need(input && input.candidate && identity(input.candidate.landscapeId)
      && Array.isArray(input.observations) && input.observations.length > 0 && input.history)
    const proposalCoverage = coverageValid(input.history.proposalCoverage)
    metadata = { ...metadata, coverage: { ...metadata.coverage, proposals: proposalCoverage } }
    const movementCoverage = coverageValid(input.history.movementCoverage)
    metadata = { ...metadata, coverage: { ...metadata.coverage, movements: movementCoverage } }
    const current = evaluateFrame(input.observations[input.observations.length - 1]!, input, nowUs, policy)
    need(nowUs - current.frame.atUs < micros(policy.maxSignalAgeMs), 'stale-signal')
    need(current.workspaces.every(workspace => nowUs - workspace.signalUs < micros(policy.maxSignalAgeMs)
      && workspace.fact.activity.verdict.ageMs! + Number(nowUs - current.frame.atUs) / 1_000 < policy.maxSignalAgeMs), 'stale-signal')
    need(proposalCoverage && movementCoverage, 'warming-history')
    need([proposalCoverage, movementCoverage].every(value => value.throughUs === nowUs
      && value.fromUs <= nowUs - micros(PLACEMENT_COOLDOWN_MS)), 'warming-history')
    need(Array.isArray(input.history.proposals) && Array.isArray(input.history.movements))
    const members = new Set(current.group.map(member => member.key))
    const boundary = nowUs - micros(PLACEMENT_COOLDOWN_MS)
    const releasingReservation = !current.group[0]!.hard && current.group.some(member =>
      current.frame.topology.reservedPartitions.includes(member.partition))
    let previousSource = false, incompatibleHistory = false
    const proposalIds = new Set<string>(), movementIds = new Set<string>()
    for (const proposal of input.history.proposals) {
      need(proposal && identity(proposal.id) && timestamp(proposal.atUs) && proposal.atUs <= nowUs)
      const key = workspaceKey(proposal.workspace), contract = topologyKey(proposal.topology)
      const rowId = JSON.stringify([proposal.id, key])
      need(!proposalIds.has(rowId)); proposalIds.add(rowId)
      need(integer(proposal.fromPartition) && proposal.fromPartition >= 0
        && proposal.fromPartition < proposal.topology.partitionCount && integer(proposal.toPartition)
        && proposal.toPartition >= 0 && proposal.toPartition < proposal.topology.partitionCount)
      if (!members.has(key)) continue
      need(proposal.atUs <= boundary, 'recent-proposal')
      if (contract !== topologyKey(current.frame.topology)) incompatibleHistory = true
      else if (proposal.fromPartition === input.candidate.toPartition) previousSource = true
    }
    for (const movement of input.history.movements) {
      need(movement && identity(movement.id) && timestamp(movement.atUs) && movement.atUs <= nowUs
        && identity(movement.fromCellId) && identity(movement.toCellId) && movement.fromCellId !== movement.toCellId)
      const key = workspaceKey(movement.workspace)
      need(!movementIds.has(movement.id)); movementIds.add(movement.id)
      if (members.has(key)) need(movement.atUs <= boundary, 'recent-movement')
    }
    const hysteresisReason = releasingReservation ? 'release-reservation' : incompatibleHistory ? 'incompatible-history'
      : previousSource ? 'previous-source' : !proposalCoverage.fromBeginning ? 'retained-history' : 'first-or-forward'
    const returning = hysteresisReason !== 'first-or-forward'
    const direction = returning ? 'return' : 'entry'
    const requiredGain = returning ? policy.returnGain : policy.entryGain
    const stabilityUs = micros(returning ? policy.returnStableMs : policy.entryStableMs)
    const purpose = current.gain.rightsBefore > 0 ? 'restore-isolation' : 'balance-pool'
    const allIdle = (sample: EvaluatedFrame): boolean => sample.group.every(member => member.weight === policy.idleWeight)
    need(!releasingReservation || allIdle(current), 'group-not-idle')
    const enoughGain = (sample: EvaluatedFrame): boolean => (!releasingReservation || allIdle(sample))
      && (purpose === 'restore-isolation' ? sample.gain.rightsBefore > 0
        : sample.gain.rightsBefore === 0 && sample.gain.poolGain >= requiredGain)
    need(enoughGain(current), 'insufficient-gain')
    let later = current, sampleCount = 1, index = input.observations.length - 2
    while (later.frame.atUs > nowUs - stabilityUs) {
      need(index >= 0, 'warming-stability')
      const earlier = evaluateFrame(input.observations[index--]!, input, nowUs, policy)
      need(earlier.frame.atUs < later.frame.atUs && later.frame.atUs - earlier.frame.atUs <= micros(policy.maxSampleGapMs)
        && earlier.context === current.context && enoughGain(earlier), 'warming-stability')
      // Every census member must have a renewed sample from the same witness.
      // Joining just the candidate would ignore stale load on the destination.
      const previous = new Map(earlier.workspaces.map(workspace => [workspace.key, workspace]))
      need(previous.size === later.workspaces.length, 'warming-stability')
      for (const workspace of later.workspaces) {
        const older = previous.get(workspace.key)
        need(older && older.signalUs < workspace.signalUs
          && older.fact.activity.witnessId === workspace.fact.activity.witnessId
          && older.fact.activity.verdict.sampleCount < workspace.fact.activity.verdict.sampleCount, 'warming-stability')
      }
      later = earlier; sampleCount += 1
    }
    return { ...metadata, kind: 'admit', direction, hysteresisReason, purpose, gain: { ...current.gain },
      stableFromUs: later.frame.atUs, stableThroughUs: current.frame.atUs, sampleCount,
      topology: { ...current.frame.topology, reservedPartitions: [...current.frame.topology.reservedPartitions] },
      landscapeId: input.candidate.landscapeId, orgId: current.group[0]!.fact.orgId,
      members: current.group.map(member => ({ landscapeId: member.fact.landscapeId, versionId: member.fact.versionId,
        fromPartition: member.partition, toPartition: input.candidate.toPartition })) }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    return { ...metadata, kind: 'refuse', reason: error.reason }
  }
}
