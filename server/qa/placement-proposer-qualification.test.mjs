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
import { evaluateProposalHistory, creditProposerPasses, qualificationMicros } from './placement-proposer-qualification.mjs'

function proposal(id, at, { landscape = 'subject', versions = ['v1'], from = 0, to = 1, generation = 'g1' } = {}) {
  return { proposal_id: id, landscape_id: landscape, at_us: String(at),
    payload: { evaluatedAtUs: String(at), generation, members: versions.map(versionId =>
      ({ landscapeId: landscape, versionId, fromPartition: from, toPartition: to })) } }
}
const run = (proposals, movements = []) => evaluateProposalHistory({ proposals, movements })
const first = 1_000_000_000_000_000n

test('a positive proposal does not need a movement', () => {
  const result = run([proposal('a', first)])
  assert.equal(result.pass, true); assert.equal(result.proposalCount, 1); assert.equal(result.movementCount, 0)
})
test('a movement without any proposal cannot satisfy positivity', () => {
  const result = run([], [{ move_id: 'm', landscape_id: 'elsewhere', version_id: 'deleted' }])
  assert.equal(result.pass, false); assert.equal(result.status, 'void'); assert.equal(result.movementCount, 1)
  assert.deepEqual(result.reasons, ['no-positive-admission'])
})
test('the movement register is counted independently of admitted members', () => {
  assert.equal(run([proposal('a', first)], [{ move_id: 'unrelated' }]).movementCount, 1)
})
test('two admissions at one hour are a reached negative verdict', () => {
  const result = run([proposal('a', first), proposal('b', first + 3_600_000_000n)])
  assert.equal(result.reached, true); assert.equal(result.pass, false); assert.equal(result.status, 'fail')
  assert.equal(result.maxPerWorkspaceWindow, 2)
  assert.deepEqual(result.reasons, ['multiple-admissions-in-six-hours'])
})
for (const [gap, expected] of [[21_599_999_999n, false], [21_600_000_000n, true], [21_600_000_001n, true]]) {
  test('left-open six-hour boundary at gap ' + gap + ' microseconds', () => {
    assert.equal(run([proposal('a', first), proposal('b', first + gap)]).pass, expected)
  })
}
test('an old violation cannot disappear outside the final six-hour window', () => {
  const result = run([proposal('a', first), proposal('b', first + 3_600_000_000n),
    proposal('c', first + 60_000_000_000n)])
  assert.equal(result.pass, false); assert.equal(result.violations.length, 1)
  assert.deepEqual(result.violations[0].proposalIds, ['a', 'b'])
})
test('input row order does not choose the window being checked', () => {
  assert.equal(run([proposal('later', first + 3_600_000_000n), proposal('earlier', first)]).pass, false)
})
test('different targets or generations do not reset a member budget', () => {
  const result = run([proposal('a', first), proposal('b', first + 3_600_000_000n, { to: 2, generation: 'g2' })])
  assert.equal(result.pass, false)
})
test('every member is counted including one already at target', () => {
  const group = proposal('a', first, { versions: ['main', 'draft', 'already-there'] })
  group.payload.members[2].fromPartition = 1
  const result = run([group, proposal('b', first + 3_600_000_000n, { versions: ['already-there'] })])
  assert.equal(result.pass, false); assert.equal(result.workspaceCount, 3)
  assert.deepEqual(result.violations[0].workspace, ['subject', 'already-there'])
})
test('full workspace identity separates same-named versions in two landscapes', () => {
  const result = run([proposal('a', first), proposal('b', first, { landscape: 'another' })])
  assert.equal(result.pass, true); assert.equal(result.workspaceCount, 2)
})
test('a duplicate reading of one identical UUID is not another admission', () => {
  const row = proposal('a', first)
  const result = run([row, structuredClone(row)])
  assert.equal(result.pass, true); assert.equal(result.proposalCount, 1)
})
test('conflicting rows for one UUID are invalid rather than silently deduplicated', () => {
  const result = run([proposal('a', first), proposal('a', first + 1n)])
  assert.equal(result.pass, false); assert.ok(result.reasons.includes('conflicting-proposal-id'))
})
test('two UUIDs at the same instant are two admissions', () => {
  assert.equal(run([proposal('a', first), proposal('b', first)]).pass, false)
})
for (const [label, mutate, reason] of [
  ['no members', row => { row.payload.members = [] }, 'missing-members'],
  ['duplicate member', row => { row.payload.members.push({ ...row.payload.members[0] }) }, 'invalid-proposal-members'],
  ['wrong landscape', row => { row.payload.members[0].landscapeId = 'other' }, 'invalid-proposal-members'],
  ['missing identity', row => { row.payload.members[0].versionId = '' }, 'invalid-identity'],
  ['timestamp disagreement', row => { row.payload.evaluatedAtUs = String(first + 1n) }, 'proposal-time-disagrees'],
  ['fractional partition', row => { row.payload.members[0].toPartition = 0.5 }, 'invalid-member-partition'],
]) {
  test('invalid proposal: ' + label, () => {
    const row = proposal('a', first); mutate(row)
    const result = run([row]); assert.equal(result.pass, false); assert.ok(result.reasons.includes(reason))
  })
}
for (const input of [null, {}, { proposals: [] }, { proposals: '[]', movements: [] }]) {
  test('missing registers cannot pass: ' + JSON.stringify(input), () => {
    assert.equal(evaluateProposalHistory(input).pass, false)
  })
}
for (const value of [1, -1, '1.5', '01', '-1', '1e9', '', '8640000000000000001']) {
  test('microseconds are lossless bounded decimal strings: ' + value, () => {
    assert.throws(() => qualificationMicros(value), /invalid-microseconds/)
  })
}

function entry(sequence, monoUs, kind = 'observed') {
  return { sequence, monoUs: String(monoUs), kind: 'entry', value: kind === 'observed'
    ? { kind, atUs: String(first + BigInt(monoUs)), censusCount: 6, frames: sequence, outcomes: [] }
    : { kind, reason: 'activity-uncovered' } }
}
test('ordinary consecutive passes earn their actual interval', () => {
  const result = creditProposerPasses([entry(1, 0), entry(2, 5_000_000)])
  assert.equal(result.pass, true); assert.equal(result.creditedUs, '5000000'); assert.equal(result.observedCreditUs, '5000000')
})
test('six hours of silence earn at most ten seconds of interpolation', () => {
  const result = creditProposerPasses([entry(1, 0), entry(2, 21_600_000_000n)])
  assert.equal(result.spanUs, '21600000000'); assert.equal(result.creditedUs, '10000000')
  assert.equal(result.gaps[0].gapUs, '21600000000')
})
test('health publications never count as passes or polling credit endpoints', () => {
  const result = creditProposerPasses([entry(1, 0),
    { sequence: 2, monoUs: '5000000', kind: 'entry', value: { kind: 'proposer-health', sampleCount: 6 } },
    entry(3, 20_000_000)])
  assert.equal(result.passCount, 2); assert.equal(result.creditedUs, '10000000')
})
test('unknown attempts and their adjacent intervals remain distinguishable', () => {
  const result = creditProposerPasses([entry(1, 0), entry(2, 5_000_000, 'unknown'), entry(3, 10_000_000)])
  assert.equal(result.observedCount, 2); assert.equal(result.unknownCount, 1)
  assert.equal(result.observedCreditUs, '0'); assert.equal(result.unknownCreditUs, '10000000')
})
test('reconciliation without a fresh census cannot credit or bridge observations', () => {
  const result = creditProposerPasses([entry(1, 0),
    { sequence: 2, monoUs: '5000000', kind: 'entry', value: { kind: 'observed', outcomes: [{ kind: 'already-admitted', id: 'a' }] } },
    entry(3, 10_000_000), entry(4, 15_000_000)])
  assert.equal(result.unframedOutcomeCount, 1); assert.equal(result.observedCount, 3)
  assert.equal(result.creditedUs, '5000000')
})
test('a final reconciliation preserves earlier measured passes without new credit', () => {
  const result = creditProposerPasses([entry(1, 0), entry(2, 5_000_000),
    { sequence: 3, monoUs: '10000000', kind: 'entry', value: { kind: 'observed', outcomes: [{ kind: 'already-admitted', id: 'a' }] } }])
  assert.equal(result.pass, true); assert.equal(result.unframedOutcomeCount, 1)
  assert.equal(result.spanUs, '5000000'); assert.equal(result.creditedUs, '5000000')
})
test('repeated unknown reconciliation of the same intent earns no polling credit', () => {
  const pending = sequence => ({ sequence, monoUs: String((sequence - 1) * 5_000_000), kind: 'entry',
    value: { kind: 'unknown', reason: 'transaction-failed', outcomes: [{ kind: 'unknown', reason: 'transaction-failed', id: 'pending-a' }] } })
  const result = creditProposerPasses([entry(1, 0), pending(2), pending(3), pending(4),
    { sequence: 5, monoUs: '20000000', kind: 'entry', value: { kind: 'observed', outcomes: [{ kind: 'already-admitted', id: 'pending-a' }] } },
    entry(6, 25_000_000), entry(7, 30_000_000)])
  assert.equal(result.pass, true); assert.equal(result.unframedOutcomeCount, 4)
  assert.equal(result.unknownCount, 0); assert.equal(result.creditedUs, '5000000')
  assert.deepEqual(result.gaps.map(gap => [gap.fromSequence, gap.toSequence]), [[6, 7]])
})
for (const [label, records, reason] of [
  ['empty journal', [], 'insufficient-passes'],
  ['one pass', [entry(1, 0)], 'insufficient-passes'],
  ['missing sequence', [entry(1, 0), entry(3, 5_000_000)], 'journal-sequence-gap'],
  ['clock reversed', [entry(1, 10), entry(2, 9)], 'journal-clock-reversed'],
  ['duplicated pass instant', [entry(1, 10), entry(2, 10)], 'duplicate-pass-time'],
]) {
  test('invalid polling evidence: ' + label, () => {
    const result = creditProposerPasses(records); assert.equal(result.pass, false); assert.ok(result.reasons.includes(reason))
  })
}
test('an observed pass needs a positive population', () => {
  const second = entry(2, 5_000_000); second.value.censusCount = 0
  assert.equal(creditProposerPasses([entry(1, 0), second]).pass, false)
})
