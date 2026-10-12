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
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { createPlacementProposerFixture } from '../src/testing/placementProposerFixture.ts'
import { guardIdleClientErrors } from '../src/db/poolErrorGuard.ts'
import { openProposerSoakOwnerPool, snapshot } from './placement-proposer-soak.mjs'

// Exercise the actual supervisor pool and snapshot against one new, owned
// schema. One control changes the session context. A second removes one real
// coverage row in this disposable fixture, then restores its exact SQL value.
const result = { test: 'placement-proposer-preflight', reached: false, pass: false,
  healthySnapshots: 0, wrongContextRejected: false, missingCoverageRejected: false, authorityUnchanged: false,
  poolsClosed: false, fixtureRemoved: false, reason: null }
let fixture, owner, wrongContext, mainError
const errors = []
try {
  assert.ok(process.env.TEST_DATABASE_URL, 'test-database-required')
  fixture = await createPlacementProposerFixture(process.env.TEST_DATABASE_URL,
    't14f_preflight_' + randomBytes(8).toString('hex'))
  owner = openProposerSoakOwnerPool(process.env.TEST_DATABASE_URL, fixture.config,
    () => errors.push('owner-pool-error'))
  const checked = { ...fixture, db: { ...fixture.db, pool: owner } }
  result.reached = true
  const before = await snapshot(checked, () => '0')
  for (const name of ['proposalCoverage', 'movementCoverage']) {
    assert.ok(before.observation.history[name], 'healthy-history-missing:' + name)
  }
  result.healthySnapshots++
  wrongContext = guardIdleClientErrors(new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL,
    max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000,
    idle_in_transaction_session_timeout: 5000, options: '-c search_path=pg_catalog,public' }),
  't14f-preflight-wrong-context', () => errors.push('wrong-context-pool-error'))
  wrongContext.on('error', () => errors.push('wrong-context-pool-error'))
  await assert.rejects(snapshot({ ...fixture, db: { ...fixture.db, pool: wrongContext } }, () => '0'),
    /snapshot-history-coverage-missing/)
  result.wrongContextRejected = true
  const after = await snapshot(checked, () => '1')
  assert.deepEqual(after.authority, before.authority)
  assert.deepEqual(after.proposals, before.proposals)
  assert.deepEqual(after.counts, before.counts)
  result.healthySnapshots++
  result.authorityUnchanged = true
  const coverage = before.authority.sync_placement_history_coverage.find(row => row.kind === 'movements')
  assert.ok(coverage, 'missing-control-row')
  const removed = await fixture.db.pool.query('DELETE FROM sync_placement_history_coverage WHERE kind=$1', ['movements'])
  assert.equal(removed.rowCount, 1)
  await assert.rejects(snapshot(checked, () => '2'), /snapshot-history-coverage-missing:movementCoverage/)
  result.missingCoverageRejected = true
  await fixture.db.pool.query(`INSERT INTO sync_placement_history_coverage
    (kind, origin, from_at, protocol, from_beginning, capture_signature) VALUES ($1,$2,$3,$4,$5,$6)`,
  [coverage.kind, coverage.origin, coverage.from_at, coverage.protocol, coverage.from_beginning, coverage.capture_signature])
  const restored = await snapshot(checked, () => '3')
  assert.deepEqual(restored.authority, before.authority)
  assert.deepEqual(restored.proposals, before.proposals)
  assert.deepEqual(restored.counts, before.counts)
  result.healthySnapshots++
} catch (error) {
  mainError = error
  result.reason = error instanceof Error ? error.message.split('\n')[0] : 'preflight-check-failed'
} finally {
  let ownerClosed = false, wrongClosed = false
  try { await owner?.end(); ownerClosed = true } catch { errors.push('owner-close-failed') }
  try { await wrongContext?.end(); wrongClosed = true } catch { errors.push('wrong-context-close-failed') }
  result.poolsClosed = ownerClosed && wrongClosed
  if (fixture && result.poolsClosed) {
    try { await fixture.cleanup(); result.fixtureRemoved = true }
    catch { errors.push('fixture-cleanup-failed') }
  }
}
result.errors = errors
result.pass = !mainError && result.reached && result.healthySnapshots === 3
  && result.wrongContextRejected && result.missingCoverageRejected && result.authorityUnchanged && result.poolsClosed
  && result.fixtureRemoved && errors.length === 0
console.log('QARESULT ' + JSON.stringify(result))
if (!result.pass) process.exitCode = 1
