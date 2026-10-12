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

import { PROPOSER_AUTHORITY_TABLES } from './placement-proposer-campaign.mjs'
import { creditProposerPasses } from './placement-proposer-qualification.mjs'

/** Fabricated facts for tests of rejection rules only. No process, SQL query,
 * monotonic clock, six-hour exposure or file-integrity claim is made here.
 * The native runner never imports this module. */
export function controlledProposerCampaign() {
  const epoch = 1_789_000_000_000_000n, stamp = seconds => (epoch + BigInt(seconds) * 1_000_000n).toString()
  const role = 'controlled_role', schema = 'controlled_schema'
  const workspaces = [['one', 'one-v'], ['subject', 's1'], ['subject', 's2'], ['subject', 's3'], ['three', 'three-v'], ['two', 'two-v']]
    .map(([landscapeId, versionId]) => ({ landscapeId, versionId, tier: 'standard', orgId: 'org', orgStatus: 'active',
      placement: { generation: 'controlled-generation', partition: versionId === 's3' ? 1 : 0 } }))
  const topology = { generation: 'controlled-generation', partitionCount: 2, placementMode: 'placed', reservedPartitions: [] }
  const coverage = atUs => ({ origin: 'controlled-history-origin', fromUs: stamp(-25_200), throughUs: atUs, fromBeginning: true })
  const admissionAtUs = (BigInt(stamp(635)) + 101_000n).toString()
  const admission = { kind: 'admit', direction: 'entry', evaluatedAtUs: admissionAtUs,
    stableFromUs: (BigInt(stamp(335)) + 100_000n).toString(), stableThroughUs: admissionAtUs,
    sampleCount: 61, landscapeId: 'one', purpose: 'balance-pool',
    members: [{ landscapeId: 'one', versionId: 'one-v', fromPartition: 0, toPartition: 1 }] }
  const proposal = { proposal_id: 'controlled-admission', landscape_id: 'one', at_us: admissionAtUs,
    payload: { ...admission, proof: { observationOrigin: 'initial-origin', census: workspaces } } }
  const history = atUs => ({ proposalCoverage: coverage(atUs), movementCoverage: coverage(atUs), movements: [],
    proposals: BigInt(atUs) < BigInt(admissionAtUs) ? [] : [{ id: proposal.proposal_id, workspace: { landscapeId: 'one', versionId: 'one-v' },
      atUs: admissionAtUs, fromPartition: 0, toPartition: 1, topology }] })
  const claims = workspaces.map(w => ({ landscape_id: w.landscapeId, version_id: w.versionId, covered: true, protocol: 1 }))
  const authority = Object.fromEntries(PROPOSER_AUTHORITY_TABLES.map(table => [table, []]))
  authority.sync_placement_history_coverage = ['movements', 'proposals'].map(kind => ({
    kind, origin: 'controlled-history-origin', from_at: new Date(Number(BigInt(stamp(-25_200)) / 1000n)).toISOString(),
    protocol: 1, from_beginning: true, capture_signature: '0123456789abcdef0123456789abcdef',
  }))
  authority.workspace_claim_coverage = claims
  authority.versions = workspaces.map(w => ({ id: w.versionId, landscape_id: w.landscapeId, status: 'active', kind: w.versionId === 's2' ? 'draft' : 'version' }))
  authority.landscapes = ['one', 'subject', 'three', 'two'].map(id => ({ id, tier: 'standard' }))
  authority.orgs = [{ id: 'org', status: 'active' }]
  authority.workspace_placement = workspaces.map(w => ({ landscape_id: w.landscapeId, version_id: w.versionId,
    partition: w.placement.partition, topology_generation: w.placement.generation }))
  function sql(atSeconds) {
    const atUs = stamp(atSeconds), proposals = atSeconds > 635 ? [structuredClone(proposal)] : []
    return { atUs, parentMonoUs: String(atSeconds * 1_000_000), authority: structuredClone(authority),
      counts: { ...Object.fromEntries(PROPOSER_AUTHORITY_TABLES.map(table => [table, String(authority[table].length)])),
        sync_placement_proposals: String(proposals.length) }, proposals, movements: [],
      observation: { atUs, topology, workspaces, history: history(atUs) } }
  }
  function segment(phase, offset, endSeconds, pid) {
    const records = [], emit = (monoUs, kind, value) => {
      const record = { sequence: records.length + 1, monoUs: String(monoUs),
        utc: new Date(Number(epoch / 1000n) + offset * 1000 + monoUs / 1000).toISOString(), kind, value }
      records.push(record); return record
    }
    emit(0, 'worker-start', { phase, pid, role, schema, clock: 'native' })
    let calls = 0, witnessCalls = 0, frameCount = 0, lastAdmission = null, finalHealth
    const health = (monoUs, state) => {
      finalHealth = { kind: 'proposer-health', state, sampleCount: calls, lastAdmission }
      emit(monoUs, 'entry', finalHealth)
    }
    health(1, 'initial-unknown')
    for (let sec = 10; sec <= endSeconds; sec += 5) {
      const lost = phase === 'initial' && sec >= 25 && sec <= 330, base = sec * 1_000_000
      if (phase === 'initial' && sec === 25) {
        emit(20_300_000, 'control-start', { kind: 'signal-loss' })
        emit(20_400_000, 'control-committed', { kind: 'signal-loss', before: claims,
          after: claims.map(row => ({ ...row, covered: false })),
          changed: claims.map(row => ({ landscape_id: row.landscape_id, version_id: row.version_id, covered: false })), atUs: stamp(20) })
      }
      if (phase === 'initial' && sec === 335) {
        emit(330_500_000, 'control-start', { kind: 'signal-return' })
        emit(330_600_000, 'control-committed', { kind: 'signal-return', before: claims.map(row => ({ ...row, covered: false })), after: claims,
          changed: claims.map(row => ({ landscape_id: row.landscape_id, version_id: row.version_id, covered: true })), atUs: stamp(330) })
      }
      const actualSamples = []
      for (const [index, w] of (lost ? workspaces.slice(0, 1) : workspaces).entries()) {
        const call = ++calls, observedAt = new Date(Number(epoch / 1000n) + (offset + sec) * 1000 + index).toISOString()
        const verdict = { workspace: { landscapeId: w.landscapeId, versionId: w.versionId }, kind: lost ? 'unknown' : 'idle',
          sampleCount: ++witnessCalls, observedAt, requestStartedAt: observedAt, ageMs: 1,
          facts: { workspaceStatus: 'active', claimCoverageCurrent: !lost, admittedDocuments: 1, missingContentDocuments: 0,
            observedAt, latestContentAt: new Date(Number(epoch / 1000n) - 600_000).toISOString() }, ...(lost ? { reason: 'uncovered' } : {}) }
        emit(base + index * 10_000, 'activity-start', { call, workspace: w })
        emit(base + index * 10_000 + 1000, 'activity-result', { call, verdict })
        actualSamples.push(verdict)
      }
      if (lost) {
        frameCount = 0; witnessCalls = 0
        emit(base + 210_000, 'entry', { kind: 'unknown', reason: 'activity-uncovered' })
        health(base + 220_000, 'halted-signal-unknown')
      } else {
        frameCount++
        const atUs = (BigInt(stamp(offset + sec)) + 100_000n).toString()
        const frame = { atUs, origin: phase + '-origin', complete: true, topology, grants: [],
          workspaces: workspaces.map((w, index) => ({ ...w, activity: {
            witnessId: phase + (phase === 'initial' && sec >= 335 ? '-restored-witness' : '-early-witness'),
            verdict: { ...actualSamples[index], ageMs: 100 } } })) }
        emit(base + 200_000, 'observation', { frame, history: history(atUs), frameCount })
        const admitted = phase === 'initial' && sec === 635
        const outcomes = admitted ? [{ kind: 'admitted', id: proposal.proposal_id, admission }]
          : [{ kind: 'refused', reason: BigInt(atUs) > BigInt(admissionAtUs) ? 'recent-proposal' : 'warming-stability' }]
        emit(base + 210_000, 'entry', { kind: 'observed', atUs, censusCount: 6, frames: frameCount, outcomes })
        if (admitted) lastAdmission = { id: proposal.proposal_id, evaluatedAtUs: admissionAtUs, memberCount: 1 }
        health(base + 220_000, admitted ? 'proposing' : 'warming-stability')
      }
    }
    health(endSeconds * 1_000_000 + 230_000, 'stopped')
    const stoppedFor = phase === 'initial' ? 'scheduled-restart' : 'credit-target-reached'
    emit(endSeconds * 1_000_000 + 240_000, 'worker-finished', { phase, pid, entryStarted: true, entryJoined: true,
      adminClosed: true, failure: null, stoppedFor })
    const credit = creditProposerPasses(records)
    return { records, worker: { phase, pid, complete: true, entryStarted: true, entryJoined: true, adminClosed: true,
      failure: null, stoppedFor, finalHealth, creditedUs: credit.creditedUs, passCount: credit.passCount,
      knownPasses: credit.observedCount, activityCalls: calls },
    receipt: { pid, closed: true, rootExited: true, cleanupConfirmed: true, code: 0, signal: null, timedOut: false,
      aborted: false, captureDetached: false, spawnError: null, captureError: null, cleanupIssues: [],
      startedAtMs: offset * 1000, completedAtMs: (offset + endSeconds + 1) * 1000 } }
  }
  return { protocol: 1, mode: 'long', complete: true, parentPoolsClosed: true, role, schema,
    preparation: { history: 'seven-hours-seeded-not-elapsed' }, roleAudit: { role, schema },
    denials: ['placement-update', 'ownership-update', 'proposal-truncate'].map(operation => ({ operation, code: '42501' })),
    snapshots: [sql(0), sql(4237), sql(22_750)],
    segments: [segment('initial', 0, 4235, 111), segment('continued', 4238, 18_510, 222)] }
}
