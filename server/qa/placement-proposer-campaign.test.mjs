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
import { test } from 'node:test'
import { evaluateProposerCampaign } from './placement-proposer-campaign.mjs'
import { controlledProposerCampaign } from './placement-proposer-campaign.fixture.mjs'
import { creditProposerPasses } from './placement-proposer-qualification.mjs'
import { proposerSqlMicros } from './placement-proposer-history.mjs'

const base = controlledProposerCampaign()
const run = (change = () => {}) => { const input = structuredClone(base); change(input); return evaluateProposerCampaign(input) }
function rejected(change, reason) {
  const result = run(change)
  assert.equal(result.reached, true); assert.equal(result.pass, false)
  assert.ok(result.reasons.includes(reason), JSON.stringify(result.reasons))
}
const records = (campaign, index = 0) => campaign.segments[index].records

test('synthetic complete facts satisfy the fixed rules; they are not native evidence', () => {
  const result = evaluateProposerCampaign(base)
  assert.equal(result.pass, true, JSON.stringify(result.reasons))
  assert.equal(result.creditedUs, '22725000000'); assert.equal(result.temporal.proposalCount, 1)
  assert.ok(BigInt(result.unknownCreditUs) > 300_000_000n)
})
for (const [field, value, reason] of [
  ['mode', 'smoke', 'not-a-long-campaign'], ['complete', false, 'campaign-not-closed'],
  ['parentPoolsClosed', false, 'campaign-not-closed'],
]) test('campaign rejects ' + field, () => rejected(c => { c[field] = value }, reason))
for (const field of ['closed', 'rootExited', 'cleanupConfirmed']) {
  test('a missing native receipt obligation rejects ' + field, () => rejected(c => { c.segments[0].receipt[field] = false }, 'native-child-not-successfully-joined'))
}
for (const field of ['timedOut', 'aborted', 'captureDetached']) {
  test('native ' + field + ' cannot become successful through a worker report', () => rejected(c => { c.segments[1].receipt[field] = true }, 'native-child-not-successfully-joined'))
}
test('a recycled PID does not prove a fresh process', () => rejected(c => {
  c.segments[1].receipt.pid = c.segments[1].worker.pid = 111
}, 'restart-not-fresh-and-serial'))
test('overlapping children do not prove stop then restart', () => rejected(c => {
  c.segments[1].receipt.startedAtMs = 1
}, 'restart-not-fresh-and-serial'))
test('the worker must use the campaign role', () => rejected(c => {
  records(c)[0].value.role = 'another-role'
}, 'worker-role-or-schema-disagrees'))
test('the record is not the worker summary alone', () => rejected(c => {
  records(c).pop()
}, 'missing-worker-lifetime-envelope'))
test('independent SQL count catches an omitted row', () => rejected(c => {
  c.snapshots[2].counts.sync_placement_proposals = '2'
}, 'proposal-count-disagrees'))
test('placement changes fail even if all temporal proposal windows pass', () => rejected(c => {
  c.snapshots[2].authority.workspace_placement[0].partition = 1
}, 'authority-changed:workspace_placement'))
test('every named authority table is required', () => rejected(c => {
  delete c.snapshots[2].authority.automerge_storage
}, 'missing-authority-table'))
test('history origin cannot be substituted between snapshots', () => rejected(c => {
  c.snapshots[1].observation.history.proposalCoverage.origin = 'another-origin'
}, 'history-origin-changed'))
test('the entry must actually reload complete member history after restart', () => rejected(c => {
  records(c, 1).find(r => r.kind === 'observation').value.history.proposals = []
}, 'observed-history-incomplete'))
test('a finished pass cannot invent its activity calls', () => rejected(c => {
  records(c).find(r => r.kind === 'activity-start').kind = 'unrelated'
}, 'activity-result-without-call'))
test('an observed frame needs all six distinct workspace verdicts', () => rejected(c => {
  const frame = records(c).find(r => r.kind === 'observation').value.frame
  frame.workspaces[5].activity.verdict = frame.workspaces[0].activity.verdict
}, 'frame-verdict-not-observed'))
test('the health counter cannot run ahead of actual sample calls', () => rejected(c => {
  records(c).find(r => r.value?.kind === 'proposer-health').value.sampleCount = 10
}, 'health-sample-counter-reversed-or-ahead'))
test('the restored frame may precede the administrative post-UPDATE receipt', () => {
  const result = run(c => {
    const list = records(c), returned = list.find(r => r.kind === 'control-committed' && r.value.kind === 'signal-return')
    returned.monoUs = '335230000'
    list.sort((a, b) => Number(BigInt(a.monoUs) - BigInt(b.monoUs)))
    list.forEach((r, index) => { r.sequence = index + 1 })
  })
  assert.equal(result.pass, true, JSON.stringify(result.reasons))
})
test('frozen verdict metadata after ACK is rejected even when results and frames agree', () => rejected(c => {
  const frozen = new Map()
  for (const r of records(c)) {
    if (BigInt(r.monoUs) < 640_000_000n) continue
    if (r.kind === 'activity-result') {
      const id = r.value.verdict.workspace.versionId
      if (!frozen.has(id)) frozen.set(id, structuredClone(r.value.verdict))
      r.value.verdict = structuredClone(frozen.get(id))
    }
    if (r.kind === 'observation') for (const w of r.value.frame.workspaces) {
      w.activity.verdict = { ...structuredClone(frozen.get(w.versionId)), ageMs: 100 }
    }
  }
}, 'sample-not-renewed'))
test('facts and verdict observed clocks must agree', () => rejected(c => {
  const r = records(c).find(r => r.kind === 'activity-result')
  r.value.verdict.facts.observedAt = '2000-01-01T00:00:00.000Z'
}, 'sample-facts-clock-disagrees'))
test('a fresh-looking local age cannot conceal stale PG signal', () => rejected(c => {
  const list = records(c), sample = list.find(r => r.kind === 'activity-result').value.verdict
  sample.observedAt = sample.facts.observedAt = '2000-01-01T00:00:00.000Z'
  list.find(r => r.kind === 'observation').value.frame.workspaces[0].activity.verdict.observedAt = sample.observedAt
}, 'sample-pg-clock-stale-or-future'))
test('a stableFrom value copied consistently into SQL and ACK still needs an observed frame', () => rejected(c => {
  for (const snapshot of c.snapshots) for (const row of snapshot.proposals) row.payload.stableFromUs = '1789000335099999'
  records(c).find(r => r.value?.outcomes?.some(o => o.kind === 'admitted')).value.outcomes[0].admission.stableFromUs = '1789000335099999'
}, 'stability-from-not-observed'))
test('two frames 300 seconds apart before ACK cannot borrow later samples', () => rejected(c => {
  const segment = c.segments[0]
  segment.records = segment.records.filter(r => BigInt(r.monoUs) < 340_000_000n || BigInt(r.monoUs) >= 635_000_000n)
  for (const snapshot of c.snapshots) for (const row of snapshot.proposals) row.payload.sampleCount = 2
  segment.records.find(r => r.value?.outcomes?.some(o => o.kind === 'admitted')).value.outcomes[0].admission.sampleCount = 2
  recount(segment)
}, 'stability-contains-unsampled-gap'))
test('a long receipt with few executed passes does not earn six hours', () => rejected(c => {
  const segment = c.segments[1]
  segment.records = segment.records.filter(r => BigInt(r.monoUs) < 1000_000_000n || r.kind === 'worker-finished'
    || (r.kind === 'entry' && r.value?.state === 'stopped'))
  recount(segment)
}, 'insufficient-native-polling-credit'))
test('native credit cannot exceed the parent observed duration', () => rejected(c => {
  c.snapshots[2].parentMonoUs = '1000000'
}, 'parent-duration-shorter-than-credit'))

function recount(segment) {
  let calls = 0
  for (const [index, record] of segment.records.entries()) {
    record.sequence = index + 1
    if (record.kind === 'activity-start') record.value.call = ++calls
    if (record.kind === 'activity-result') record.value.call = calls
    if (record.kind === 'entry' && record.value?.kind === 'proposer-health') record.value.sampleCount = calls
  }
  const credit = creditProposerPasses(segment.records)
  Object.assign(segment.worker, { creditedUs: credit.creditedUs, passCount: credit.passCount,
    knownPasses: credit.observedCount, activityCalls: calls,
    finalHealth: segment.records.findLast(r => r.kind === 'entry' && r.value?.kind === 'proposer-health').value })
}

const nativeHistoryOptions = { historySource: 'native-frames' }
function nullSqlCoverage(campaign) {
  for (const snapshot of campaign.snapshots) {
    snapshot.observation.history.proposalCoverage = null
    snapshot.observation.history.movementCoverage = null
  }
}
function reanalysisRejected(change, reason) {
  const input = structuredClone(base)
  nullSqlCoverage(input); change(input)
  const result = evaluateProposerCampaign(input, nativeHistoryOptions)
  assert.equal(result.reached, true); assert.equal(result.pass, false)
  assert.ok(result.reasons.includes(reason), JSON.stringify(result.reasons))
}
test('history reanalysis is explicit and does not fill the original SQL nulls', () => {
  const input = structuredClone(base)
  nullSqlCoverage(input)
  assert.deepEqual(evaluateProposerCampaign(input).reasons, ['missing-history-coverage'])
  const before = JSON.stringify(input), result = evaluateProposerCampaign(input, nativeHistoryOptions)
  assert.equal(result.pass, true, JSON.stringify(result.reasons))
  assert.deepEqual(result.historyEvidence.sqlAnchorsWithoutDerivedCoverage, [0, 1, 2])
  assert.equal(result.historyEvidence.baseline.sequence, records(input).find(r => r.kind === 'observation').sequence)
  assert.equal(result.creditedUs, '22725000000')
  assert.equal(JSON.stringify(input), before)
  assert.deepEqual(evaluateProposerCampaign(input).reasons, ['missing-history-coverage'])
})
test('native history also reconciles snapshots whose original coverage is present', () => {
  const result = evaluateProposerCampaign(base, nativeHistoryOptions)
  assert.equal(result.pass, true, JSON.stringify(result.reasons))
  assert.deepEqual(result.historyEvidence.sqlAnchorsWithoutDerivedCoverage, [])
})
test('an unknown history option cannot weaken the default gate', () => {
  assert.deepEqual(evaluateProposerCampaign(base, { historySource: 'skip' }).reasons, ['unknown-history-source'])
})
for (const position of ['first', 'middle', 'last']) test('reanalysis requires coverage in the ' + position + ' actual frame', () => {
  reanalysisRejected(c => {
    const list = c.segments.flatMap(s => s.records.filter(r => r.kind === 'observation'))
    list[position === 'first' ? 0 : position === 'last' ? list.length - 1 : Math.floor(list.length / 2)]
      .value.history.movementCoverage = null
  }, 'missing-history-coverage')
})
test('a changed native origin after restart still rejects the reanalysis', () => reanalysisRejected(c => {
  records(c, 1).find(r => r.kind === 'observation').value.history.proposalCoverage.origin = 'substitution'
}, 'history-origin-changed'))
test('a frame cannot borrow a throughUs from a later observation', () => reanalysisRejected(c => {
  const frame = records(c, 1).find(r => r.kind === 'observation')
  frame.value.history.proposalCoverage.throughUs = String(BigInt(frame.value.frame.atUs) + 1n)
}, 'history-coverage-too-short'))
for (const [field, value, reason] of [
  ['origin', 'raw-substitution', 'raw-and-native-history-disagree'],
  ['from_beginning', false, 'raw-and-native-history-disagree'],
  ['from_at', '2026-09-09T00:00:00.000001+00:00', 'raw-and-native-history-disagree'],
  ['protocol', 2, 'invalid-raw-history-coverage'],
  ['capture_signature', null, 'invalid-raw-history-coverage'],
  ['capture_signature', ['0123456789abcdef0123456789abcdef'], 'invalid-raw-history-coverage'],
]) test('reanalysis independently reconciles raw ' + field, () => reanalysisRejected(c => {
  for (const snapshot of c.snapshots) snapshot.authority.sync_placement_history_coverage[0][field] = value
}, reason))
test('a changed signature in a later raw anchor cannot be hidden by matching LOGIN tuples', () => reanalysisRejected(c => {
  c.snapshots[2].authority.sync_placement_history_coverage[0].capture_signature = '11111111111111111111111111111111'
}, 'authority-changed:sync_placement_history_coverage'))
test('both distinct raw coverage rows are required at every anchor', () => reanalysisRejected(c => {
  for (const snapshot of c.snapshots) {
    snapshot.authority.sync_placement_history_coverage.pop()
    snapshot.counts.sync_placement_history_coverage = '1'
  }
}, 'invalid-raw-history-coverage'))
test('two copies of the same raw kind do not cover both registers', () => reanalysisRejected(c => {
  for (const snapshot of c.snapshots) snapshot.authority.sync_placement_history_coverage[0].kind = 'proposals'
}, 'invalid-raw-history-coverage'))
test('a one-microsecond raw start mismatch is visible', () => reanalysisRejected(c => {
  for (const snapshot of c.snapshots) {
    const row = snapshot.authority.sync_placement_history_coverage[0]
    row.from_at = row.from_at.replace('.000Z', '.000001Z')
  }
}, 'raw-and-native-history-disagree'))
test('consistent but too-recent native and raw origins cannot claim six-hour coverage', () => reanalysisRejected(c => {
  const short = '1788978410100001' // First actual fixture frame minus six hours plus one microsecond.
  const whole = new Date(Number(BigInt(short) / 1000n)).toISOString().slice(0, 19)
  const fromAt = whole + '.100001Z'
  for (const snapshot of c.snapshots) {
    for (const row of snapshot.authority.sync_placement_history_coverage) row.from_at = fromAt
  }
  for (const segment of c.segments) for (const record of segment.records) if (record.kind === 'observation') {
    record.value.history.proposalCoverage.fromUs = short
    record.value.history.movementCoverage.fromUs = short
  }
}, 'history-coverage-too-short'))
test('partial snapshot coverage is not silently repaired', () => reanalysisRejected(c => {
  c.snapshots[0].observation.history.proposalCoverage = structuredClone(base.snapshots[0].observation.history.proposalCoverage)
}, 'partial-snapshot-history-coverage'))
test('nonnull snapshot coverage must still agree with the native history', () => reanalysisRejected(c => {
  c.snapshots[1].observation.history = structuredClone(base.snapshots[1].observation.history)
  c.snapshots[1].observation.history.proposalCoverage.origin = 'wrong-admin-origin'
}, 'history-origin-changed'))
test('native history reanalysis keeps the complete snapshot register check', () => reanalysisRejected(c => {
  c.snapshots[1].observation.history.proposals = []
}, 'observed-history-incomplete'))
test('native history reanalysis keeps the complete LOGIN register check', () => reanalysisRejected(c => {
  records(c, 1).find(r => r.kind === 'observation').value.history.proposals = []
}, 'observed-history-incomplete'))
test('native history reanalysis keeps the parent duration constraint', () => reanalysisRejected(c => {
  c.snapshots[2].parentMonoUs = '1000000'
}, 'parent-duration-shorter-than-credit'))
test('native history reanalysis still requires six hours of actually credited passes', () => reanalysisRejected(c => {
  const segment = c.segments[1]
  segment.records = segment.records.filter(r => BigInt(r.monoUs) < 1000_000_000n || r.kind === 'worker-finished'
    || (r.kind === 'entry' && r.value?.state === 'stopped'))
  recount(segment)
}, 'insufficient-native-polling-credit'))
test('SQL time parsing preserves fractions and explicit offsets', () => {
  assert.equal(proposerSqlMicros('1970-01-01T00:00:00.000001Z'), '1')
  assert.equal(proposerSqlMicros('1970-01-01T02:30:00.000001+02:30'), '1')
  assert.equal(proposerSqlMicros('1970-01-01T00:00:00.123456-03:30'), '12600123456')
  assert.equal(proposerSqlMicros('2026-09-13T20:31:03.808328+00:00'), '1789331463808328')
  assert.equal(proposerSqlMicros('2026-09-13T16:31:03.808328-04:00'), '1789331463808328')
})
test('SQL time parsing rejects local, normalized, truncated and invalid timestamps', () => {
  for (const value of ['2026-09-13T20:31:03.808328', '2026-09-13T20:31:03.8083281Z',
    '2026-02-30T00:00:00Z', '2026-09-13T24:00:00Z', '2026-09-13T20:31:60Z',
    '2026-09-13T20:31:03+15:00', '2026-09-13T20:31:03+02:60', '2026-09-13T20:31:03+14:01',
    '1969-12-31T23:59:59Z', null]) assert.throws(() => proposerSqlMicros(value), /invalid-sql-history/)
})
