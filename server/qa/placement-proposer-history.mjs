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

/** Parse the JSON timestamptz representation without losing microseconds.
 * PostgreSQL emits an explicit offset; accepting local time would make an
 * archived observation depend on the verifier's timezone. */
export function proposerSqlMicros(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  assert.ok(match, 'invalid-sql-history-time')
  const [, year, month, day, hour, minute, second, fraction = '', offset] = match
  const literal = `${year}-${month}-${day}T${hour}:${minute}:${second}`
  const whole = Date.parse(literal + 'Z')
  assert.ok(Number.isSafeInteger(whole) && new Date(whole).toISOString() === literal + '.000Z', 'invalid-sql-history-calendar')
  let offsetMinutes = 0
  if (offset !== 'Z') {
    const hours = Number(offset.slice(1, 3)), minutes = Number(offset.slice(4))
    assert.ok(hours <= 14 && minutes < 60 && (hours < 14 || minutes === 0), 'invalid-sql-history-offset')
    offsetMinutes = (offset[0] === '-' ? -1 : 1) * (hours * 60 + minutes)
  }
  const micros = BigInt(whole) * 1000n - BigInt(offsetMinutes) * 60_000_000n + BigInt(fraction.padEnd(6, '0'))
  assert.ok(micros >= 0n, 'invalid-sql-history-time')
  return micros.toString()
}

/** The first actual LOGIN frame is the coverage anchor for an explicit
 * reanalysis. Raw SQL snapshots still attest rows, census and register bounds.
 * They never acquire a throughUs that their original reader did not return.
 * Source/file hashes and the externally retained manifest are checked by the
 * loader, not invented here from otherwise self-consistent decoded facts. */
export function nativeProposerHistory(campaign) {
  const first = campaign.segments[0]?.records?.find(record => record.kind === 'observation')
  assert.ok(first?.value?.history, 'missing-native-history-baseline')
  const history = first.value.history
  const pairs = [['proposals', 'proposalCoverage'], ['movements', 'movementCoverage']]
  const anchorsWithoutCoverage = []
  for (const [index, snapshot] of campaign.snapshots.entries()) {
    const rows = snapshot.authority?.sync_placement_history_coverage
    assert.ok(Array.isArray(rows) && rows.length === 2
      && new Set(rows.map(row => row.kind)).size === 2, 'invalid-raw-history-coverage')
    const missing = pairs.map(([, name]) => snapshot.observation?.history?.[name] === null)
    assert.ok(missing.every(Boolean) || missing.every(value => !value), 'partial-snapshot-history-coverage')
    if (missing.every(Boolean)) anchorsWithoutCoverage.push(index)
    for (const [kind, name] of pairs) {
      const row = rows.find(item => item.kind === kind), coverage = history[name]
      assert.ok(coverage && typeof coverage.origin === 'string' && coverage.origin.length > 0
        && typeof coverage.fromBeginning === 'boolean', 'missing-history-coverage')
      assert.ok(row?.protocol === 1 && typeof row.origin === 'string' && row.origin.length > 0
        && typeof row.from_beginning === 'boolean' && typeof row.capture_signature === 'string'
        && /^[a-f0-9]{32}$/.test(row.capture_signature), 'invalid-raw-history-coverage')
      assert.deepEqual([row.origin, proposerSqlMicros(row.from_at), row.from_beginning],
        [coverage.origin, coverage.fromUs, coverage.fromBeginning], 'raw-and-native-history-disagree')
    }
  }
  return { history, evidence: { source: 'native-frames', revision: 2,
    baseline: { phase: 'initial', sequence: first.sequence, atUs: first.value.frame.atUs },
    sqlAnchorsWithoutDerivedCoverage: anchorsWithoutCoverage,
    rawCoverageRowsChecked: campaign.snapshots.length * 2 } }
}
