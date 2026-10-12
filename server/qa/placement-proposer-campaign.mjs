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
import { creditProposerPasses, evaluateProposalHistory, qualificationMicros as us } from './placement-proposer-qualification.mjs'
import { nativeProposerHistory } from './placement-proposer-history.mjs'

export const PROPOSER_AUTHORITY_TABLES = Object.freeze([
  'workspace_placement', 'sync_workspace_ownership', 'read_model_static_workspaces',
  'landscapes', 'versions', 'orgs', 'sync_workspace_placement_moves',
  'workspace_claim_coverage', 'automerge_document_workspace', 'automerge_storage',
  'sync_topology_contract', 'sync_placement_history_coverage',
])
const need = (value, reason) => assert.ok(value, reason)
const same = (a, b, reason) => assert.deepEqual(a, b, reason)
const key = w => JSON.stringify([w.landscapeId, w.versionId])
const sorted = rows => [...rows].sort((a, b) => key(a).localeCompare(key(b)))
const entry = record => record?.kind === 'entry' ? record.value : null
const withoutAge = value => { const copy = { ...value }; delete copy.ageMs; return copy }
const time = record => us(record.monoUs)

/** Fixed native success conditions. This pure evaluator receives decoded facts;
 * loadProposerCampaign separately verifies closed files, hashes and source pins.
 * Tests can exercise these rules with explicitly synthetic records. Passing
 * invented facts alone is never a source or native-execution attestation. */
export function evaluateProposerCampaign(campaign, { historySource = 'sql-snapshots' } = {}) {
  const result = { reached: true, pass: false, status: 'void', reasons: [],
    temporal: null, segments: [], creditedUs: '0', observedCreditUs: '0', unknownCreditUs: '0' }
  try {
    need(['sql-snapshots', 'native-frames'].includes(historySource), 'unknown-history-source')
    need(campaign?.protocol === 1 && campaign.mode === 'long', 'not-a-long-campaign')
    need(campaign.complete === true && campaign.parentPoolsClosed === true, 'campaign-not-closed')
    need(campaign.preparation?.history === 'seven-hours-seeded-not-elapsed', 'undeclared-history-preparation')
    need(Array.isArray(campaign.snapshots) && campaign.snapshots.length === 3, 'missing-sql-snapshots')
    need(Array.isArray(campaign.segments) && campaign.segments.length === 2, 'missing-process-segments')
    const [before, restart, after] = campaign.snapshots
    // Revision 2 is an explicit reanalysis, never an automatic fallback when
    // the original snapshot observer rejects. It does not edit decoded input.
    const nativeHistory = historySource === 'native-frames' ? nativeProposerHistory(campaign) : null
    const historyBaseline = nativeHistory?.history ?? before.observation.history
    const baseline = { ...before.observation, history: historyBaseline }
    if (nativeHistory) result.historyEvidence = nativeHistory.evidence
    for (const snapshot of campaign.snapshots) {
      us(snapshot.atUs); us(snapshot.parentMonoUs)
      same(Object.keys(snapshot.authority ?? {}).sort(), [...PROPOSER_AUTHORITY_TABLES].sort(), 'missing-authority-table')
      for (const table of PROPOSER_AUTHORITY_TABLES) {
        need(Array.isArray(snapshot.authority[table]), 'invalid-authority-rows')
        same(String(snapshot.authority[table].length), snapshot.counts?.[table], 'sql-count-disagrees')
        same(snapshot.authority[table], before.authority[table], 'authority-changed:' + table)
      }
      need(Array.isArray(snapshot.proposals) && Array.isArray(snapshot.movements), 'missing-raw-register')
      same(String(snapshot.proposals.length), snapshot.counts.sync_placement_proposals, 'proposal-count-disagrees')
      same(String(snapshot.movements.length), snapshot.counts.sync_workspace_placement_moves, 'movement-count-disagrees')
      same(snapshot.movements, snapshot.authority.sync_workspace_placement_moves, 'movement-copy-disagrees')
      need(snapshot.movements.length === 0, 'unexpected-movement')
      same(snapshot.observation.workspaces, before.observation.workspaces, 'population-changed')
      same(snapshot.observation.topology, before.observation.topology, 'topology-changed')
      if (!nativeHistory || !nativeHistory.evidence.sqlAnchorsWithoutDerivedCoverage.includes(campaign.snapshots.indexOf(snapshot))) {
        validateCoverage(snapshot.observation, historyBaseline)
      }
      validateHistoryRows(snapshot.observation, snapshot.proposals)
      need(snapshot.proposals.every(row => us(row.at_us) <= us(snapshot.atUs)), 'future-proposal')
    }
    same(before.proposals, [], 'not-a-fresh-proposal-register')
    need(before.observation.workspaces.length === 6
      && new Set(before.observation.workspaces.map(w => w.landscapeId)).size === 4
      && before.observation.topology.partitionCount === 2, 'wrong-bench-population')
    need(before.authority.versions.some(v => v.kind === 'draft'), 'missing-draft')
    need(before.authority.workspace_placement.some(w => w.partition === 1), 'missing-already-at-target-member')
    need(campaign.roleAudit?.role === campaign.role && campaign.roleAudit.schema === campaign.schema, 'missing-role-audit')
    same(campaign.denials?.map(item => [item.operation, item.code]),
      [['placement-update', '42501'], ['ownership-update', '42501'], ['proposal-truncate', '42501']], 'restricted-login-denials-missing')
    result.temporal = evaluateProposalHistory(after)
    if (result.temporal.status === 'fail') result.status = 'fail'
    need(result.temporal.pass, 'proposal-window-or-positivity-failed')
    for (const old of restart.proposals) same(after.proposals.find(row => row.proposal_id === old.proposal_id), old, 'proposal-history-rewritten')
    const admissions = new Map(), healthAdmissions = new Set(), details = []
    let credit = 0n, observedCredit = 0n, unknownCredit = 0n, previousReceipt = null
    for (const [index, segment] of campaign.segments.entries()) {
      const phase = index === 0 ? 'initial' : 'continued', { worker, receipt, records } = segment
      need(receipt?.closed && receipt.rootExited && receipt.cleanupConfirmed && receipt.code === 0
        && !receipt.timedOut && !receipt.aborted && !receipt.captureDetached && !receipt.spawnError
        && !receipt.captureError && !receipt.signal && receipt.cleanupIssues?.length === 0, 'native-child-not-successfully-joined')
      need(Number.isSafeInteger(receipt.pid) && receipt.pid > 0 && worker.pid === receipt.pid, 'pid-disagrees')
      need(Number.isFinite(receipt.startedAtMs) && Number.isFinite(receipt.completedAtMs)
        && receipt.completedAtMs > receipt.startedAtMs, 'invalid-parent-monotonic-receipt')
      if (previousReceipt) need(receipt.pid !== previousReceipt.pid
        && receipt.startedAtMs >= previousReceipt.completedAtMs, 'restart-not-fresh-and-serial')
      previousReceipt = receipt
      need(worker.complete && worker.phase === phase && worker.entryStarted && worker.entryJoined
        && worker.adminClosed && worker.failure === null, 'worker-not-complete')
      same([records[0]?.value?.role, records[0]?.value?.schema], [campaign.role, campaign.schema], 'worker-role-or-schema-disagrees')
      same(worker.stoppedFor, index === 0 ? 'scheduled-restart' : 'credit-target-reached', 'wrong-stop-reason')
      const credited = creditProposerPasses(records)
      need(credited.pass, 'invalid-pass-journal')
      same(worker.creditedUs, credited.creditedUs, 'worker-credit-disagrees')
      same(worker.passCount, credited.passCount, 'worker-pass-count-disagrees')
      same(worker.knownPasses, credited.observedCount, 'worker-known-count-disagrees')
      need(credited.unframedOutcomeCount === 0, 'unexpected-uncertain-transaction')
      credit += us(credited.creditedUs); observedCredit += us(credited.observedCreditUs); unknownCredit += us(credited.unknownCreditUs)
      const detail = validateSegment(segment, baseline, after.proposals, admissions, healthAdmissions)
      details.push(detail)
      const journalSpan = time(records.at(-1)) - time(records[0])
      need(Number(journalSpan) / 1000 <= receipt.completedAtMs - receipt.startedAtMs, 'journal-outlives-native-child')
      result.segments.push({ phase, pid: worker.pid, ...credited, activityCalls: detail.activityCalls,
        dispatches: detail.finalHealth.sampleCount, firstFrameAtUs: detail.frames[0].value.frame.atUs,
        lastFrameAtUs: detail.frames.at(-1).value.frame.atUs })
    }
    same([...admissions.keys()].sort(), after.proposals.map(row => row.proposal_id).sort(), 'durable-and-ack-registers-disagree')
    same([...healthAdmissions].sort(), [...admissions.keys()].sort(), 'durable-and-health-registers-disagree')
    const initial = details[0], continued = details[1]
    const loss = initial.controls.find(r => r.value.kind === 'signal-loss')
    const returned = initial.controls.find(r => r.value.kind === 'signal-return')
    const lossStart = initial.controlStarts.find(r => r.value.kind === 'signal-loss')
    const returnStart = initial.controlStarts.find(r => r.value.kind === 'signal-return')
    need(initial.controls.length === 2 && initial.controlStarts.length === 2 && loss && returned
      && lossStart && returnStart && continued.controls.length === 0 && continued.controlStarts.length === 0, 'signal-intervention-missing')
    need(lossStart.sequence < loss.sequence && loss.sequence < returnStart.sequence
      && returnStart.sequence < returned.sequence, 'signal-control-order-invalid')
    same(loss.value.before, before.authority.workspace_claim_coverage, 'signal-before-disagrees')
    same(loss.value.after, returned.value.before, 'signal-intervention-disagrees')
    same(returned.value.after, before.authority.workspace_claim_coverage, 'signal-not-restored')
    for (const control of initial.controls) {
      const covered = control.value.kind === 'signal-return'
      need(control.value.changed.length === 6 && control.value.after.length === 6, 'partial-signal-control')
      same(control.value.after, control.value.before.map(row => ({ ...row, covered })), 'signal-control-changed-other-data')
      need(control.value.changed.every(row => row.covered === covered), 'signal-update-disagrees')
    }
    need(time(returnStart) - time(loss) >= 310_000_000n, 'signal-loss-too-short')
    const preLoss = initial.frames.filter(r => r.sequence < loss.sequence)
    need(preLoss.length >= 3, 'no-known-signal-before-loss')
    // UPDATE visibility can precede the administrative post-update receipt.
    // Neither transition is counted as a stable loss interval. A genuine
    // restored frame may arrive between return-start and return-committed.
    const lostPasses = initial.passes.filter(r => time(r) > time(loss) + 10_000_000n && r.sequence < returnStart.sequence)
    need(lostPasses.length >= 29 && lostPasses.every(r => entry(r)?.kind === 'unknown'
      && entry(r)?.reason === 'activity-uncovered'), 'signal-loss-not-observed')
    need(initial.health.some(r => r.sequence > loss.sequence && r.sequence < returned.sequence
      && entry(r).state === 'halted-signal-unknown'), 'unknown-health-not-published')
    need(after.proposals.every(row => us(row.at_us) > us(returned.value.atUs)), 'admission-before-signal-restoration')
    const restored = initial.frames.filter(r => r.sequence > returnStart.sequence)
    need(restored.length >= 61, 'fresh-restored-samples-missing')
    need(restored[0].value.frameCount === 1, 'stability-not-reset-after-loss')
    need(restored[0].value.frame.workspaces[0].activity.witnessId !== preLoss.at(-1).value.frame.workspaces[0].activity.witnessId,
      'activity-witness-not-renewed')
    need(restart.proposals.length > 0, 'no-admission-before-restart')
    const firstAdmission = admissions.get(restart.proposals[0].proposal_id)
    need(firstAdmission.segment === 'initial' && time(firstAdmission.record) - time(restored[0]) >= 300_000_000n, 'native-stability-too-short')
    need(time(initial.records.at(-1)) - time(firstAdmission.record) >= 3_600_000_000n, 'restart-too-early')
    need(continued.frames[0].value.frame.origin !== initial.frames[0].value.frame.origin, 'observation-origin-reused')
    need(continued.frames[0].value.frameCount === 1, 'fresh-process-kept-old-frames')
    const restartFirst = continued.passes.find(r => entry(r)?.kind === 'observed')
    need(entry(restartFirst)?.outcomes.some(o => o.kind === 'refused' && o.reason === 'recent-proposal'), 'restart-did-not-enforce-durable-budget')
    need(us(entry(restartFirst).atUs) - us(restart.proposals[0].at_us) < 21_600_000_000n, 'restart-refusal-not-discriminating')
    const firstFrame = initial.frames[0].value.frame, lastFrame = continued.frames.at(-1).value.frame
    need(credit >= 21_600_000_000n, 'insufficient-native-polling-credit')
    need(us(lastFrame.atUs) - us(firstFrame.atUs) >= 21_600_000_000n, 'insufficient-pg-observation-span')
    need(us(after.parentMonoUs) - us(before.parentMonoUs) >= credit, 'parent-duration-shorter-than-credit')
    need(us(before.atUs) <= us(firstFrame.atUs) && us(after.atUs) >= us(lastFrame.atUs), 'observations-outside-sql-capture')
    result.creditedUs = credit.toString(); result.observedCreditUs = observedCredit.toString(); result.unknownCreditUs = unknownCredit.toString()
    result.pgObservationSpanUs = (us(lastFrame.atUs) - us(firstFrame.atUs)).toString()
    result.signalLossUs = (time(returnStart) - time(loss)).toString()
    result.pass = true; result.status = 'pass'
  } catch (error) {
    result.reasons.push(error instanceof Error ? error.message.split('\n')[0] : 'invalid-campaign')
  }
  return result
}

function validateHistory(observation, proposals, baseline) {
  validateCoverage(observation, baseline)
  validateHistoryRows(observation, proposals)
}

function validateCoverage(observation, baseline) {
  const at = us(observation.atUs), history = observation.history
  for (const name of ['proposalCoverage', 'movementCoverage']) {
    const coverage = history?.[name], initial = baseline[name]
    need(coverage && typeof coverage.origin === 'string' && coverage.origin.length > 0
      && typeof coverage.fromBeginning === 'boolean', 'missing-history-coverage')
    same([coverage.origin, coverage.fromUs, coverage.fromBeginning],
      [initial?.origin, initial?.fromUs, initial?.fromBeginning], 'history-origin-changed')
    need(us(coverage.throughUs) === at && us(coverage.fromUs) <= at - 21_600_000_000n, 'history-coverage-too-short')
  }
}

function validateHistoryRows(observation, proposals) {
  const at = us(observation.atUs), history = observation.history
  const expected = proposals.filter(row => us(row.at_us) <= at).flatMap(row => row.payload.members.map(member => ({
    id: row.proposal_id, workspace: { landscapeId: member.landscapeId, versionId: member.versionId },
    atUs: row.at_us, fromPartition: member.fromPartition, toPartition: member.toPartition,
  })))
  const order = rows => [...rows].sort((a, b) => JSON.stringify([a.id, a.workspace]).localeCompare(JSON.stringify([b.id, b.workspace])))
  same(order(history.proposals.map(row => ({ id: row.id, workspace: row.workspace, atUs: row.atUs,
    fromPartition: row.fromPartition, toPartition: row.toPartition }))), order(expected), 'observed-history-incomplete')
  same(history.movements, [], 'observed-movements-disagree')
}

function validateSegment(segment, baseline, proposals, admissions, healthAdmissions) {
  const { records, worker } = segment, frames = [], health = [], passes = [], controls = [], controlStarts = []
  need(records[0]?.kind === 'worker-start' && records.at(-1)?.kind === 'worker-finished', 'missing-worker-lifetime-envelope')
  same([records[0].value.pid, records[0].value.phase, records[0].value.clock], [worker.pid, worker.phase, 'native'], 'worker-start-disagrees')
  same([records.at(-1).value.entryStarted, records.at(-1).value.entryJoined, records.at(-1).value.adminClosed,
    records.at(-1).value.failure, records.at(-1).value.stoppedFor], [true, true, true, null, worker.stoppedFor], 'worker-end-disagrees')
  let active = null, calls = 0, completed = [], observation = null, lastSampleCount = 0
  const samplesByWitness = new Map()
  for (const record of records) {
    const value = record.value
    if (record.kind === 'activity-start') {
      need(active === null && value.call === calls + 1, 'activity-call-overlap-or-gap')
      active = value; calls++
    } else if (record.kind === 'activity-result') {
      need(active?.call === value.call && key(active.workspace) === key(value.verdict.workspace), 'activity-result-without-call')
      completed.push(value.verdict); active = null
    } else if (record.kind === 'activity-error') throw new Error('native-activity-rejected')
    else if (record.kind === 'control-committed') controls.push(record)
    else if (record.kind === 'control-start') controlStarts.push(record)
    else if (record.kind === 'observation') {
      const frame = value.frame
      need(observation === null && active === null && frame.complete === true && typeof frame.origin === 'string', 'invalid-observation-order')
      same(sorted(frame.workspaces.map(w => { const copy = { ...w }; delete copy.activity; return copy })),
        sorted(baseline.workspaces), 'frame-census-disagrees')
      same(frame.topology, baseline.topology, 'frame-topology-disagrees')
      same(frame.grants, [], 'unexpected-reservation-grants')
      need(completed.length === 6, 'frame-without-six-real-samples')
      for (const w of frame.workspaces) {
        const sample = completed.find(v => key(v.workspace) === key(w))
        need(sample?.kind === 'idle' && sample.facts?.claimCoverageCurrent === true, 'frame-not-known-idle')
        same(withoutAge(w.activity.verdict), withoutAge(sample), 'frame-verdict-not-observed')
        need(Number.isFinite(sample.ageMs) && sample.ageMs >= 0 && Number.isFinite(w.activity.verdict.ageMs) && w.activity.verdict.ageMs >= sample.ageMs
          && w.activity.verdict.ageMs < 10_000, 'frame-age-invalid')
        need(typeof w.activity.witnessId === 'string' && w.activity.witnessId.length > 0, 'missing-witness-identity')
        const observedMs = Date.parse(sample.observedAt)
        need(Number.isSafeInteger(observedMs) && observedMs >= 0 && sample.facts.observedAt === sample.observedAt,
          'sample-facts-clock-disagrees')
        const ageUs = us(frame.atUs) - BigInt(observedMs) * 1000n
        need(ageUs >= 0n && ageUs < 10_000_000n, 'sample-pg-clock-stale-or-future')
        need(Number.isSafeInteger(sample.sampleCount) && sample.sampleCount > 0, 'sample-dispatch-counter-invalid')
        const sampleKey = JSON.stringify([w.activity.witnessId, key(w)]), old = samplesByWitness.get(sampleKey)
        if (old) need(observedMs > old.observedMs && sample.sampleCount > old.count, 'sample-not-renewed')
        samplesByWitness.set(sampleKey, { observedMs, count: sample.sampleCount })
      }
      validateHistory({ atUs: frame.atUs, history: value.history }, proposals, baseline.history)
      if (frames.length) need(us(frame.atUs) > us(frames.at(-1).value.frame.atUs), 'pg-frame-clock-reversed')
      observation = record; frames.push(record)
    } else if (record.kind === 'entry' && value?.kind === 'proposer-health') {
      need(Number.isSafeInteger(value.sampleCount) && value.sampleCount >= lastSampleCount
        && value.sampleCount <= calls, 'health-sample-counter-reversed-or-ahead')
      lastSampleCount = value.sampleCount; health.push(record)
      if (value.state === 'proposing') {
        const row = proposals.find(p => p.proposal_id === value.lastAdmission?.id)
        need(row && row.at_us === value.lastAdmission.evaluatedAtUs && row.payload.members.length === value.lastAdmission.memberCount,
          'proposing-without-matching-durable-row')
        healthAdmissions.add(row.proposal_id)
      }
    } else if (record.kind === 'entry' && ['observed', 'unknown', 'stopped'].includes(value?.kind)) {
      if (value.kind === 'observed') {
        need(observation !== null && value.atUs === observation.value.frame.atUs && value.censusCount === 6
          && value.frames === observation.value.frameCount, 'pass-without-matching-frame')
      } else if (value.kind === 'unknown') {
        need(observation === null && completed.length === 1 && completed[0].kind === 'unknown'
          && completed[0].reason === 'uncovered' && value.reason === 'activity-uncovered', 'unexpected-unknown-pass')
      }
      need(active === null, 'pass-before-activity-result')
      for (const outcome of value.outcomes ?? []) if (outcome.kind === 'admitted') {
        const row = proposals.find(p => p.proposal_id === outcome.id)
        need(row && !admissions.has(outcome.id), 'admission-ack-not-unique-and-durable')
        for (const field of ['evaluatedAtUs', 'members', 'landscapeId', 'purpose', 'stableFromUs', 'stableThroughUs', 'sampleCount']) {
          same(outcome.admission?.[field], row.payload[field], 'admission-payload-disagrees:' + field)
        }
        // observe() records collection frames. The product revalidates the
        // final frame after locks; that later timestamp is carried by the ACK
        // and durable payload, not falsely attributed to the forwarding hook.
        need(us(row.at_us) >= us(observation.value.frame.atUs), 'admission-precedes-collection')
        same(row.payload.proof?.observationOrigin, observation.value.frame.origin, 'admission-origin-disagrees')
        same(sorted(row.payload.proof?.census ?? []), sorted(baseline.workspaces), 'admission-census-disagrees')
        validateAdmissionStability(row, frames)
        admissions.set(outcome.id, { record, segment: worker.phase })
      }
      passes.push(record); observation = null; completed = []
    }
  }
  need(active === null && observation === null && completed.length === 0, 'unfinished-activity-or-observation')
  same(calls, worker.activityCalls, 'activity-call-count-disagrees')
  need(health.length >= 2 && entry(health[0]).state === 'initial-unknown' && entry(health[0]).sampleCount === 0,
    'fresh-process-health-missing')
  const finalHealth = entry(health.at(-1))
  same(finalHealth, worker.finalHealth, 'final-health-disagrees')
  need(finalHealth.state === 'stopped' && finalHealth.sampleCount === calls, 'final-health-counter-or-stop-disagrees')
  need(frames.length >= 2, 'insufficient-native-frames')
  return { records, frames, health, passes, controls, controlStarts, activityCalls: calls, finalHealth }
}

function validateAdmissionStability(row, frames) {
  const from = us(row.payload.stableFromUs), through = us(row.payload.stableThroughUs)
  need(through === us(row.at_us), 'stability-through-not-post-lock-time')
  const first = frames.findIndex(record => us(record.value.frame.atUs) === from)
  need(first >= 0, 'stability-from-not-observed')
  const stable = frames.slice(first).map(record => record.value.frame)
  need(stable.length === row.payload.sampleCount, 'stable-sample-count-disagrees')
  const origin = stable[0].origin, witnesses = stable[0].workspaces.map(w => [key(w), w.activity.witnessId])
  const times = stable.map(frame => us(frame.atUs))
  times[times.length - 1] = through // Revalidation replaces the last frame; it adds no sample.
  for (const [index, frame] of stable.entries()) {
    same(frame.origin, origin, 'stability-crosses-process-origin')
    same(frame.workspaces.map(w => [key(w), w.activity.witnessId]), witnesses, 'stability-crosses-witness-reset')
    if (index) need(times[index] > times[index - 1] && times[index] - times[index - 1] <= 10_000_000n,
      'stability-contains-unsampled-gap')
  }
  need(['entry', 'return'].includes(row.payload.direction), 'unknown-stability-direction')
  need(through - from >= (row.payload.direction === 'return' ? 1_800_000_000n : 300_000_000n), 'stable-window-too-short')
}
