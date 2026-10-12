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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspacePartition } from './assignment.js'
import { admitPlacementProposal, DEFAULT_PLACEMENT_POLICY, type AdmittedPlacement,
  type PlacementAdmissionInput, type PlacementMovement, type PlacementPolicy } from './placementHysteresis.js'

type Mutable<T> = T extends readonly (infer E)[] ? Mutable<E>[]
  : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T
const NOW = 1_800_000_000_000_000n
const BOUNDARY = 1_799_978_400_000_000n
const TOPOLOGY = { generation: 'v1.ce1461953e2b8ac2', partitionCount: 2,
  placementMode: 'placed' as const, reservedPartitions: [] as number[] }
interface Seed {
  landscapeId: string; versionId?: string; partition: number | null
  active?: boolean; tier?: 'standard' | 'enterprise'; orgId?: string | null; orgStatus?: string | null
}
const seed = (landscapeId: string, partition: number | null, extra: Partial<Seed> = {}): Seed => ({ landscapeId, partition, ...extra })
const entrySeeds = (): Seed[] => [seed('subject', 0), seed('one', 0), seed('two', 0), seed('three', 0), seed('peer', 1)]
const returnSeeds = (): Seed[] => [seed('subject', 0), seed('one', 0), seed('two', 0), seed('three', 0), seed('four', 0)]

function fixture(seeds = entrySeeds(), spanMs = 300_000, stepMs = 10_000): Mutable<PlacementAdmissionInput> {
  const observations: Mutable<PlacementAdmissionInput>['observations'] = []
  for (let offset = spanMs, count = 1; offset >= 0; offset -= stepMs, count += 1) {
    const atUs = NOW - BigInt(offset) * 1_000n
    const observedMs = Number(atUs / 1_000n) - 1
    const observedAt = new Date(observedMs).toISOString()
    observations.push({ atUs, origin: 'complete-pg-census:test', complete: true,
      topology: structuredClone(TOPOLOGY), grants: [], workspaces: seeds.map((item, index) => {
        const workspace = { landscapeId: item.landscapeId, versionId: item.versionId ?? 'v1' }
        return { ...workspace, tier: item.tier ?? 'standard', orgId: item.orgId === undefined ? 'org' : item.orgId,
          orgStatus: item.orgStatus === undefined ? 'active' : item.orgStatus,
          placement: item.partition === null ? null : { generation: TOPOLOGY.generation, partition: item.partition },
          activity: { witnessId: 'retained-witness', verdict: { ...workspace, workspace, kind: item.active ? 'active' : 'idle',
            sampleCount: count * seeds.length + index, requestStartedAt: observedAt, observedAt, ageMs: 1,
            facts: { workspaceStatus: 'active', claimCoverageCurrent: true, admittedDocuments: 1, missingContentDocuments: 0,
              observedAt, latestContentAt: new Date(observedMs - (item.active ? 1 : 300_001)).toISOString() } } } }
      }) })
  }
  return { candidate: { landscapeId: 'subject', toPartition: 1, topology: structuredClone(TOPOLOGY) }, observations,
    history: { proposalCoverage: { fromUs: BOUNDARY, throughUs: NOW, origin: 'proposal-inception:test', fromBeginning: true },
      movementCoverage: { fromUs: BOUNDARY, throughUs: NOW, origin: 'trigger-verified:test', fromBeginning: false },
      proposals: [], movements: [] } }
}
function proposal(atUs: bigint, extra: Partial<AdmittedPlacement> = {}): Mutable<AdmittedPlacement> {
  const value = { id: 'proposal-1', atUs, workspace: { landscapeId: 'subject', versionId: 'v1' },
    fromPartition: 0, toPartition: 1, topology: TOPOLOGY, ...extra }
  return { ...value, topology: { ...value.topology, reservedPartitions: [...value.topology.reservedPartitions] } }
}
function movement(atUs: bigint, extra: Partial<PlacementMovement> = {}): PlacementMovement {
  return { id: 'move-1', atUs, workspace: { landscapeId: 'subject', versionId: 'v1' },
    fromCellId: 'cell-a', toCellId: 'cell-b', ...extra }
}
function allFrames(input: Mutable<PlacementAdmissionInput>, change: (frame: Mutable<PlacementAdmissionInput>['observations'][number]) => void): void {
  for (const frame of input.observations) change(frame)
}
function reserve(input: Mutable<PlacementAdmissionInput>, grant = true): void {
  input.candidate.topology.reservedPartitions = [1]
  allFrames(input, frame => {
    frame.topology.reservedPartitions = [1]
    if (grant) frame.grants = [{ partition: 1, orgId: 'org', landscapeIds: ['subject'] }]
  })
}
function refusal(input: PlacementAdmissionInput, reason: string, nowUs = NOW, policy?: PlacementPolicy): void {
  expect(admitPlacementProposal(input, nowUs, policy)).toMatchObject({ kind: 'refuse', reason })
}
function freezeDeep(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('explicit sampled occupancy policy', () => {
  it('admits gain four at exactly five minutes; reports cost, group and coverage', () => {
    const input = fixture()
    expect(admitPlacementProposal(input, NOW)).toMatchObject({ kind: 'admit', direction: 'entry', purpose: 'balance-pool',
      gain: { rightsBefore: 0, rightsAfter: 0, poolCostBefore: 17, poolCostAfter: 13, poolGain: 4 },
      stableFromUs: 1_799_999_700_000_000n, stableThroughUs: NOW, sampleCount: 31,
      evaluatedAtUs: NOW, coverage: { proposals: { origin: 'proposal-inception:test' }, movements: { origin: 'trigger-verified:test' } },
      members: [{ landscapeId: 'subject', versionId: 'v1', fromPartition: 0, toPartition: 1 }] })
  })
  it('refuses positive gain two below entry four', () => refusal(fixture(entrySeeds().filter(item => item.landscapeId !== 'three')), 'insufficient-gain'))
  it('refuses zero gain', () => refusal(fixture([seed('subject', 0), seed('one', 0), seed('peer', 1)]), 'insufficient-gain'))
  it('refuses a move that increases cost', () => refusal(fixture([seed('subject', 0), seed('one', 1), seed('peer', 1)]), 'insufficient-gain'))
  it('uses active weight two and idle weight one, not a workspace or document count', () => {
    const input = fixture([seed('subject', 0, { active: true }), seed('one', 0), seed('two', 0), seed('three', 0), seed('peer', 1)])
    expect(admitPlacementProposal(input, NOW)).toMatchObject({ kind: 'admit', gain: { poolCostBefore: 26, poolCostAfter: 18, poolGain: 8 } })
  })
  it('pins the activity lookback inclusively at 300000 ms', () => {
    const input = fixture([seed('subject', 0), seed('one', 0), seed('two', 0), seed('three', 0), seed('peer', 1)])
    allFrames(input, frame => {
      const facts = frame.workspaces[0]!.activity.verdict.facts!
      facts.latestContentAt = new Date(Date.parse(facts.observedAt) - 300_000).toISOString()
    })
    expect(admitPlacementProposal(input, NOW)).toMatchObject({ kind: 'admit', gain: { poolGain: 8 } })
  })
  it('does not use the witness kind as an opaque activity weight', () => {
    const input = fixture()
    allFrames(input, frame => { frame.workspaces[0]!.activity.verdict.kind = 'active' })
    expect(admitPlacementProposal(input, NOW)).toMatchObject({ kind: 'admit', gain: { poolGain: 4 } })
  })
  it('requires thirty minutes and gain eight for a return to a previous source', () => {
    const input = fixture(returnSeeds(), 1_800_000)
    input.history.proposals = [structuredClone(proposal(BOUNDARY, { fromPartition: 1, toPartition: 0 }))]
    expect(admitPlacementProposal(input, NOW)).toMatchObject({ kind: 'admit', direction: 'return', sampleCount: 181,
      stableFromUs: 1_799_998_200_000_000n, gain: { poolCostBefore: 25, poolCostAfter: 17, poolGain: 8 } })
  })
  it('refuses return gain six even after thirty minutes', () => {
    const input = fixture(returnSeeds().filter(item => item.landscapeId !== 'four'), 1_800_000)
    input.history.proposals = [structuredClone(proposal(BOUNDARY - 1n, { fromPartition: 1, toPartition: 0 }))]
    refusal(input, 'insufficient-gain')
  })
  it('treats a retained history without its inception as a conservative return', () => {
    const input = fixture(returnSeeds(), 1_800_000)
    input.history.proposalCoverage!.fromBeginning = false
    expect(admitPlacementProposal(input, NOW)).toMatchObject({ kind: 'admit', direction: 'return' })
  })
  it('uses return hysteresis for an incompatible historical contract', () => {
    const input = fixture(returnSeeds(), 1_800_000)
    input.history.proposals = [structuredClone(proposal(BOUNDARY, { topology: { ...TOPOLOGY, generation: 'older' } }))]
    expect(admitPlacementProposal(input, NOW)).toMatchObject({ kind: 'admit', direction: 'return' })
  })
  it('keeps compatible history to other targets as entry when not returning', () => {
    const input = fixture()
    input.history.proposals = [structuredClone(proposal(BOUNDARY - 1n))]
    expect(admitPlacementProposal(input, NOW)).toMatchObject({ kind: 'admit', direction: 'entry' })
  })
  it('is synchronous, repeatable and uses only the injected clock with frozen inputs', () => {
    const input = fixture(); freezeDeep(input)
    vi.useFakeTimers(); vi.setSystemTime('2045-01-01T00:00:00Z')
    const first = admitPlacementProposal(input, NOW)
    expect(first).not.toBeInstanceOf(Promise)
    expect(first.kind).toBe('admit')
    vi.setSystemTime('2001-01-01T00:00:00Z')
    expect(admitPlacementProposal(input, NOW)).toEqual(first)
    expect(Object.isFrozen(input.observations[0]!.workspaces)).toBe(true)
  })
  it('never returns aliases of the input group, topology or coverage', () => {
    const input = fixture(), result = admitPlacementProposal(input, NOW)
    expect(result.kind).toBe('admit')
    if (result.kind !== 'admit') throw new Error('positive control')
    input.history.proposalCoverage!.origin = 'changed'
    input.candidate.topology.reservedPartitions.push(0)
    input.observations.at(-1)!.workspaces[0]!.landscapeId = 'changed'
    expect(result.coverage.proposals!.origin).toBe('proposal-inception:test')
    expect(result.topology.reservedPartitions).toEqual([])
    expect(result.members[0]!.landscapeId).toBe('subject')
  })
})

describe('two independently covered histories and an open six-hour boundary', () => {
  for (const history of ['proposals', 'movements'] as const) {
    for (const [offset, expected] of [[-1n, 'admit'], [0n, 'admit'], [1n, 'refuse']] as const) {
      it(`${history}: boundary ${offset} microseconds is ${expected}`, () => {
        const input = fixture()
        if (history === 'proposals') input.history.proposals = [structuredClone(proposal(BOUNDARY + offset))]
        else input.history.movements = [structuredClone(movement(BOUNDARY + offset))]
        expect(admitPlacementProposal(input, NOW).kind).toBe(expected)
        if (expected === 'refuse') refusal(input, history === 'proposals' ? 'recent-proposal' : 'recent-movement')
      })
    }
    it(`${history}: an event exactly now blocks`, () => {
      const input = fixture()
      if (history === 'proposals') input.history.proposals = [structuredClone(proposal(NOW))]
      else input.history.movements = [structuredClone(movement(NOW))]
      refusal(input, history === 'proposals' ? 'recent-proposal' : 'recent-movement')
    })
    it(`${history}: a future event is not silently ignored`, () => {
      const input = fixture()
      if (history === 'proposals') input.history.proposals = [structuredClone(proposal(NOW + 1n))]
      else input.history.movements = [structuredClone(movement(NOW + 1n))]
      refusal(input, 'invalid-input')
    })
  }
  it('blocks A to B to A from a proposal never applied', () => {
    const input = fixture(returnSeeds(), 1_800_000)
    input.history.proposals = [structuredClone(proposal(NOW - 1_000n, { fromPartition: 1, toPartition: 0 }))]
    refusal(input, 'recent-proposal')
  })
  it('blocks a failover with no associated proposal', () => {
    const input = fixture(); input.history.movements = [structuredClone(movement(NOW - 1_000n))]
    refusal(input, 'recent-movement')
  })
  it('does not reset the budget at a generation or target change', () => {
    const input = fixture()
    input.history.proposals = [structuredClone(proposal(NOW - 1_000n, { topology: { ...TOPOLOGY, generation: 'past', partitionCount: 3 }, toPartition: 2 }))]
    refusal(input, 'recent-proposal')
  })
  it('does not reset the budget after reconstructing all inputs on restart', () => {
    const input = fixture(); input.history.proposals = [structuredClone(proposal(NOW - 1_000n))]
    refusal(structuredClone(input), 'recent-proposal')
  })
  it('uses both identity fields, not a version id or cell id', () => {
    const input = fixture()
    input.history.proposals = [structuredClone(proposal(NOW - 1_000n, { workspace: { landscapeId: 'elsewhere', versionId: 'v1' } }))]
    input.history.movements = [structuredClone(movement(NOW - 1_000n, { workspace: { landscapeId: 'subject', versionId: 'inactive-other-version' } }))]
    expect(admitPlacementProposal(input, NOW).kind).toBe('admit')
  })
  for (const name of ['proposalCoverage', 'movementCoverage'] as const) {
    it(`${name}: absent coverage is not a zero-event observation`, () => {
      const input = fixture(); input.history[name] = null; refusal(input, 'warming-history')
    })
    it(`${name}: one microsecond less than six hours is warming, with the origin published`, () => {
      const input = fixture(); input.history[name]!.fromUs += 1n
      const result = admitPlacementProposal(input, NOW)
      expect(result).toMatchObject({ kind: 'refuse', reason: 'warming-history' })
      expect(result.coverage[name === 'proposalCoverage' ? 'proposals' : 'movements']!.origin).toBe(input.history[name]!.origin)
    })
    it(`${name}: the complete history must reach this decision snapshot`, () => {
      const input = fixture(); input.history[name]!.throughUs -= 1n; refusal(input, 'warming-history')
    })
  }
  it('refuses duplicate proposal member rows and duplicate movements', () => {
    const input = fixture(), row = structuredClone(proposal(BOUNDARY))
    input.history.proposals = [row, row]; refusal(input, 'invalid-input')
    input.history.proposals = []
    const move = structuredClone(movement(BOUNDARY)); input.history.movements = [move, move]
    refusal(input, 'invalid-input')
  })
})

describe('sampled stability without replay or unknown gaps', () => {
  it('one microsecond less than five minutes is insufficient', () => {
    const input = fixture(); input.observations[0]!.atUs += 1n; refusal(input, 'warming-stability')
  })
  it('one microsecond less than thirty minutes is insufficient on return', () => {
    const input = fixture(returnSeeds(), 1_800_000)
    input.history.proposalCoverage!.fromBeginning = false
    input.observations[0]!.atUs += 1n; refusal(input, 'warming-stability')
  })
  it('five minutes alone cannot satisfy return hysteresis', () => {
    const input = fixture(returnSeeds()); input.history.proposalCoverage!.fromBeginning = false
    refusal(input, 'warming-stability')
  })
  it('accepts ten-second gaps but rejects ten seconds plus one microsecond', () => {
    const input = fixture(); expect(admitPlacementProposal(input, NOW).kind).toBe('admit')
    input.observations[0]!.atUs -= 1n; refusal(input, 'warming-stability')
  })
  it('refuses a missing sampling round', () => {
    const input = fixture(); input.observations.splice(15, 1); refusal(input, 'warming-stability')
  })
  it('does not skip an unknown intermediate activity sample', () => {
    const input = fixture(), verdict = input.observations[15]!.workspaces[0]!.activity.verdict
    input.observations[15]!.workspaces[0]!.activity.verdict = { ...verdict, kind: 'unknown', reason: 'query-timeout' }
    refusal(input, 'unknown-signal')
  })
  it('uses the relevant suffix, so older failed observations need not live forever', () => {
    const input = fixture(entrySeeds(), 1_800_000)
    input.observations[0]!.complete = false
    expect(admitPlacementProposal(input, NOW)).toMatchObject({ kind: 'admit', sampleCount: 31 })
  })
  it('refuses a replayed observedAt despite a refreshed frame and counter', () => {
    const input = fixture(entrySeeds(), 300_000, 5_000)
    const older = input.observations.at(-2)!.workspaces[0]!.activity.verdict
    const latest = input.observations.at(-1)!.workspaces[0]!.activity.verdict
    latest.observedAt = older.observedAt; latest.facts!.observedAt = older.facts!.observedAt
    refusal(input, 'warming-stability')
  })
  it('refuses a replayed sample counter despite a fresh timestamp', () => {
    const input = fixture()
    input.observations.at(-1)!.workspaces[0]!.activity.verdict.sampleCount = input.observations.at(-2)!.workspaces[0]!.activity.verdict.sampleCount
    refusal(input, 'warming-stability')
  })
  it('refuses a witness restart in the stability suffix', () => {
    const input = fixture(); input.observations.at(-1)!.workspaces[0]!.activity.witnessId = 'new-witness'
    refusal(input, 'warming-stability')
  })
  it('requires renewed destination and peer activity too', () => {
    const input = fixture(), newest = input.observations.at(-1)!.workspaces.at(-1)!
    newest.activity.verdict.sampleCount = input.observations.at(-2)!.workspaces.at(-1)!.activity.verdict.sampleCount
    refusal(input, 'warming-stability')
  })
  it('rejects stale current signal at the literal ten-second age', () => {
    const input = fixture(); input.observations.at(-1)!.workspaces[0]!.activity.verdict.ageMs = 10_000
    refusal(input, 'stale-signal')
  })
  it('adds signal and frame age rather than accepting two separately fresh ages', () => {
    const input = fixture(), latest = input.observations.at(-1)!
    latest.atUs -= 9_000_000n
    for (const workspace of latest.workspaces) {
      const observedAt = new Date(Number(latest.atUs / 1_000n) - 1).toISOString()
      workspace.activity.verdict.observedAt = observedAt
      workspace.activity.verdict.facts!.observedAt = observedAt
    }
    const verdict = latest.workspaces[0]!.activity.verdict
    verdict.observedAt = new Date(Number(NOW / 1_000n) - 18_000).toISOString()
    verdict.facts!.observedAt = verdict.observedAt
    refusal(input, 'stale-signal')
  })
  it('refuses a stale observation even when its stored age says one millisecond', () => {
    const input = fixture(); input.observations.pop(); refusal(input, 'stale-signal')
  })
  it('requires the gain at each sample, not just the two endpoints', () => {
    const input = fixture(); input.observations[15]!.workspaces[3]!.placement!.partition = 1
    refusal(input, 'warming-stability')
  })
  it('resets on group placement, membership or grant changes', () => {
    const input = fixture(returnSeeds())
    input.observations[15]!.workspaces[1]!.landscapeId = 'subject'
    input.observations[15]!.workspaces[1]!.versionId = 'other'
    input.observations[15]!.workspaces[1]!.activity.verdict.workspace = { landscapeId: 'subject', versionId: 'other' }
    refusal(input, 'warming-stability')
  })
})

describe('complete groups, hard rights and reservations', () => {
  it('moves every active version of the landscape, not the rest of its organisation', () => {
    const input = fixture([seed('subject', 0, { tier: 'enterprise' }), seed('subject', 0, { tier: 'enterprise', versionId: 'v2' }), seed('small-sibling', 0)])
    reserve(input)
    expect(admitPlacementProposal(input, NOW)).toMatchObject({ kind: 'admit', purpose: 'restore-isolation', gain: { rightsBefore: 2 },
      members: [{ landscapeId: 'subject', versionId: 'v1', toPartition: 1 }, { landscapeId: 'subject', versionId: 'v2', toPartition: 1 }] })
  })
  it('charges cooldown for another active member even if already at the destination', () => {
    const input = fixture([seed('subject', 0, { tier: 'enterprise' }), seed('subject', 1, { tier: 'enterprise', versionId: 'v2' })])
    reserve(input)
    input.history.movements = [structuredClone(movement(NOW - 1_000n, { workspace: { landscapeId: 'subject', versionId: 'v2' } }))]
    refusal(input, 'recent-movement')
  })
  it('needs an explicit grant even for an empty reserved partition', () => {
    const input = fixture([seed('subject', 0, { tier: 'enterprise' })]); reserve(input, false)
    refusal(input, 'target-not-authorized')
  })
  it('needs the named landscape and organisation in the grant', () => {
    const input = fixture([seed('subject', 0, { tier: 'enterprise' })]); reserve(input)
    allFrames(input, frame => { frame.grants[0]!.landscapeIds = ['someone-else'] })
    refusal(input, 'target-not-authorized')
    allFrames(input, frame => { frame.grants[0]!.landscapeIds = ['subject']; frame.grants[0]!.orgId = 'other-org' })
    refusal(input, 'target-not-authorized')
  })
  it('does not revoke an idle active enterprise landscape hard right', () => {
    const input = fixture([seed('subject', 1, { tier: 'enterprise' })]); reserve(input); input.candidate.toPartition = 0
    refusal(input, 'target-not-authorized')
  })
  it('does not grant a standard landscape an enterprise slot', () => {
    const input = fixture([seed('subject', 0)]); reserve(input); refusal(input, 'target-not-authorized')
  })
  for (const orgStatus of ['suspended', 'future-status', null]) {
    it(`does not give a reserved slot to enterprise with org status ${orgStatus}`, () => {
      const input = fixture([seed('subject', 0, { tier: 'enterprise', orgStatus })]); reserve(input)
      refusal(input, 'target-not-authorized')
    })
  }
  it('prioritizes a revoked reserved right despite negative balance gain, with return stability', () => {
    const input = fixture([seed('subject', 1), seed('one', 0), seed('two', 0)], 1_800_000)
    reserve(input); input.candidate.toPartition = 0
    input.history.proposals = [structuredClone(proposal(BOUNDARY, { topology: { ...TOPOLOGY, reservedPartitions: [1] } }))]
    expect(admitPlacementProposal(input, NOW)).toMatchObject({ kind: 'admit', direction: 'return', purpose: 'restore-isolation',
      gain: { rightsBefore: 1, rightsAfter: 0, poolCostBefore: 4, poolCostAfter: 9, poolGain: -5 } })
  })
  it('never waives stability or cooldown for an isolation correction', () => {
    const input = fixture([seed('subject', 0, { tier: 'enterprise' })]); reserve(input)
    input.observations.shift(); refusal(input, 'warming-stability')
    input.history.movements = [structuredClone(movement(NOW - 1_000n))]; refusal(input, 'recent-movement')
  })
  it('classifies reserve to pool as return even without a previous proposition', () => {
    const input = fixture([seed('subject', 1)])
    reserve(input); input.candidate.toPartition = 0
    refusal(input, 'warming-stability')
    const warmed = fixture([seed('subject', 1)], 1_800_000)
    reserve(warmed); warmed.candidate.toPartition = 0
    expect(admitPlacementProposal(warmed, NOW)).toMatchObject({ kind: 'admit', direction: 'return', hysteresisReason: 'release-reservation' })
  })
  it('requires idle recalculated with the policy on every member before releasing a reservation', () => {
    const input = fixture([seed('subject', 1)], 1_800_000)
    reserve(input); input.candidate.toPartition = 0
    allFrames(input, frame => {
      const facts = frame.workspaces[0]!.activity.verdict.facts!
      facts.latestContentAt = new Date(Date.parse(facts.observedAt) - 120_000).toISOString()
    })
    refusal(input, 'group-not-idle')
    const input2 = fixture([seed('subject', 1)], 1_800_000)
    reserve(input2); input2.candidate.toPartition = 0
    const facts = input2.observations[90]!.workspaces[0]!.activity.verdict.facts!
    facts.latestContentAt = facts.observedAt
    refusal(input2, 'warming-stability')
  })
  it('recognizes source contamination by an ungranted standard peer from the same organisation', () => {
    const input = fixture([seed('subject', 1, { tier: 'enterprise' }), seed('small-sibling', 1)])
    input.candidate.toPartition = 2
    input.candidate.topology.partitionCount = 3
    input.candidate.topology.reservedPartitions = [1, 2]
    allFrames(input, frame => {
      frame.topology.partitionCount = 3; frame.topology.reservedPartitions = [1, 2]
      frame.grants = [1, 2].map(partition => ({ partition, orgId: 'org', landscapeIds: ['subject'] }))
    })
    expect(admitPlacementProposal(input, NOW)).toMatchObject({ kind: 'admit', purpose: 'restore-isolation', gain: { rightsBefore: 1, poolGain: 0 } })
    allFrames(input, frame => {
      frame.workspaces[1]!.tier = 'enterprise'
      frame.grants[0]!.landscapeIds.push('small-sibling')
    })
    refusal(input, 'insufficient-gain')
  })
  it('rejects a reserved destination containing an unlisted occupant', () => {
    const input = fixture([seed('subject', 0, { tier: 'enterprise' }), seed('other', 1, { tier: 'enterprise' })]); reserve(input)
    refusal(input, 'target-not-authorized')
  })
  it('permits explicitly granted enterprise peers from the same organisation', () => {
    const input = fixture([seed('subject', 0, { tier: 'enterprise' }), seed('other', 1, { tier: 'enterprise' })]); reserve(input)
    allFrames(input, frame => { frame.grants[0]!.landscapeIds.push('other') })
    expect(admitPlacementProposal(input, NOW).kind).toBe('admit')
  })
  it('refuses adding a different organisation beside a hard tenant misplaced in the pool', () => {
    const input = fixture([...returnSeeds(), seed('hard-peer', 1, { tier: 'enterprise', orgId: 'other-org' })])
    refusal(input, 'target-not-authorized')
  })
  it('uses the hash fallback when a current-generation placement row is positively absent', () => {
    const input = fixture()
    const partition = workspacePartition({ landscapeId: 'subject', versionId: 'v1' }, 2)
    allFrames(input, frame => { frame.workspaces[0]!.placement = null })
    input.candidate.toPartition = partition
    refusal(input, 'no-change')
  })
  it('includes a hash-only occupant when checking a reserved destination', () => {
    const name = Array.from({ length: 20 }, (_, i) => `hashed-peer-${i}`)
      .find(landscapeId => workspacePartition({ landscapeId, versionId: 'v1' }, 2) === 1)!
    expect(name).toBeTruthy()
    const input = fixture([seed('subject', 0, { tier: 'enterprise' }), seed(name, null)])
    reserve(input); refusal(input, 'target-not-authorized')
  })
  it('refuses shadow mode even if a placement row exists', () => {
    const input = fixture(); input.candidate.topology.placementMode = 'shadow'
    allFrames(input, frame => { frame.topology.placementMode = 'shadow' }); refusal(input, 'not-placed')
  })
  it('binds the candidate to the complete topology, not generation alone', () => {
    const input = fixture(); input.candidate.topology.reservedPartitions = [1]; refusal(input, 'topology-mismatch')
  })
  it('does not interpret an incomplete census as the absence of occupants', () => {
    const input = fixture(); input.observations.at(-1)!.complete = false; refusal(input, 'unknown-census')
  })
  it('refuses duplicate workspace identities and inconsistent landscape rights', () => {
    const input = fixture(), latest = input.observations.at(-1)!
    latest.workspaces.push(structuredClone(latest.workspaces[0]!)); refusal(input, 'invalid-input')
    latest.workspaces.at(-1)!.versionId = 'v2'; latest.workspaces.at(-1)!.orgId = 'different-org'
    refusal(input, 'invalid-input')
  })
})

describe('invalid and unavailable facts fail closed', () => {
  it('requires a known signal for every census member', () => {
    const input = fixture(), fact = input.observations.at(-1)!.workspaces.at(-1)!
    fact.activity.verdict = { ...fact.activity.verdict, kind: 'unknown', reason: 'query-failed', facts: null }
    refusal(input, 'unknown-signal')
  })
  it('rejects idle inferred from uncovered or missing content despite a known upstream kind', () => {
    const input = fixture(), facts = input.observations.at(-1)!.workspaces[0]!.activity.verdict.facts!
    facts.claimCoverageCurrent = false; refusal(input, 'unknown-signal')
    facts.claimCoverageCurrent = true; facts.missingContentDocuments = 1; refusal(input, 'unknown-signal')
  })
  it('allows positive recent content with incomplete coverage, matching T-14b', () => {
    const input = fixture([seed('subject', 0, { active: true }), seed('one', 0), seed('two', 0), seed('three', 0), seed('peer', 1)])
    allFrames(input, frame => { frame.workspaces[0]!.activity.verdict.facts!.claimCoverageCurrent = false })
    expect(admitPlacementProposal(input, NOW).kind).toBe('admit')
  })
  it('rejects a future content clock and an impossible zero-document positive witness', () => {
    const input = fixture(), facts = input.observations.at(-1)!.workspaces[0]!.activity.verdict.facts!
    facts.latestContentAt = new Date(Date.parse(facts.observedAt) + 1).toISOString(); refusal(input, 'invalid-input')
    facts.latestContentAt = facts.observedAt; facts.admittedDocuments = 0; refusal(input, 'invalid-input')
  })
  it('rejects wrong workspace signal identity', () => {
    const input = fixture(); input.observations.at(-1)!.workspaces[0]!.activity.verdict.workspace.versionId = 'wrong'
    refusal(input, 'invalid-input')
  })
  it('rejects stale placement generations rather than silently hashing them', () => {
    const input = fixture(); input.observations.at(-1)!.workspaces[0]!.placement!.generation = 'old'
    refusal(input, 'invalid-input')
  })
  it.each([NaN, Infinity, -1, 0, 1.5])('refuses an invalid policy weight %s', value => {
    refusal(fixture(), 'invalid-input', NOW, { ...DEFAULT_PLACEMENT_POLICY, idleWeight: value })
  })
  it('refuses collapsed entry and return thresholds', () => {
    refusal(fixture(), 'invalid-input', NOW, { ...DEFAULT_PLACEMENT_POLICY, returnGain: 4 })
    refusal(fixture(), 'invalid-input', NOW, { ...DEFAULT_PLACEMENT_POLICY, returnStableMs: 300_000 })
  })
  it('refuses non-microsecond, negative and future decision clocks', () => {
    refusal(fixture(), 'invalid-input', -1n)
    // @ts-expect-error The API requires lossless microseconds, not a Date or millisecond number.
    expect(admitPlacementProposal(fixture(), Date.now())).toMatchObject({ kind: 'refuse', reason: 'invalid-input' })
    refusal(fixture(), 'invalid-input', NOW - 1n)
  })
})
