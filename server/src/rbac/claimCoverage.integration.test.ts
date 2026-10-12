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

/**
 * The coverage marker's SQL against REAL Postgres, read back from the column,
 * never inferred from the API having been called.
 *
 * The unit fakes derive their behaviour from the statement TEXT, but a fake
 * can only imitate: the numbers the real statements carry — the `+ 1` bump of
 * the invalidation's DO UPDATE half (U1) and the `1` its INSERT half seeds
 * (U2) — are invisible to it. Both are pinned here by executing the statements
 * twice and SELECTing the counter.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  coverWorkspace,
  invalidateWorkspaceCoverage,
  _resetWorkspaceClaimCoverageForTests,
} from './claimCoverage.js'
import { CLAIM_PROTOCOL_VERSION } from './documentClaims.js'
import { ensureSyncCellOwnershipSchema } from '../syncCells/ownership.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('workspace claim coverage (live Postgres)', () => {
  let db: IsolatedSchemaDb

  const readRow = async (landscapeId: string, versionId: string) => {
    const { rows } = await db.pool.query<{
      covered: boolean
      protocol: number
      invalidations: string
      invalidated_reason: string | null
    }>(
      `SELECT covered, protocol, invalidations::text AS invalidations, invalidated_reason
         FROM workspace_claim_coverage
        WHERE landscape_id = $1 AND version_id = $2`,
      [landscapeId, versionId],
    )
    return rows[0]
  }

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'claim_coverage')
    await db.pool.query('CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT)')
    await db.pool.query(`
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `)
    await db.pool.query("INSERT INTO landscapes (id, name) VALUES ('L1', 'One')")
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES
       ('V-inv', 'L1', 'Invalidation', 'automerge:coverage-inv'),
       ('V-cas', 'L1', 'Cas', 'automerge:coverage-cas'),
       ('V-none', 'L1', 'NoRow', 'automerge:coverage-none')`,
    )
    await ensureSyncCellOwnershipSchema(db.pool)
  })

  afterAll(async () => {
    await db?.teardown()
  })

  beforeEach(() => {
    _resetWorkspaceClaimCoverageForTests()
  })

  it('invalidation is durable and cumulative: the INSERT seeds 1, the UPDATE bumps to 2 (U1+U2)', async () => {
    const key = { landscapeId: 'L1', versionId: 'V-inv' }

    // Row ABSENT → the INSERT half fires and must seed the counter at 1, so
    // an in-flight first cover (CAS expecting '0') loses (U2: mutate the
    // seed and this read breaks).
    await invalidateWorkspaceCoverage(db.pool, key, 'first constat')
    let row = await readRow('L1', 'V-inv')
    expect(row).toBeDefined()
    expect(row!.covered).toBe(false)
    expect(row!.invalidations).toBe('1')
    expect(row!.invalidated_reason).toBe('first constat')

    // Row PRESENT → the DO UPDATE half fires and must BUMP, not rewrite
    // (U1: drop the `+ 1` and this stays at 1).
    await invalidateWorkspaceCoverage(db.pool, key, 'second constat')
    row = await readRow('L1', 'V-inv')
    expect(row!.covered).toBe(false)
    expect(row!.invalidations).toBe('2')
    expect(row!.invalidated_reason).toBe('second constat')
  })

  it('the cover CAS on real rows: stale witness refuses, fresh witness wins, first cover seeds 0', async () => {
    const key = { landscapeId: 'L1', versionId: 'V-cas' }

    // First cover ('0' witness, no row): the INSERT branch seeds the counter
    // at 0 — the value the next observer reads as its CAS witness.
    expect(await coverWorkspace(db.pool, key, '0')).toBe(true)
    let row = await readRow('L1', 'V-cas')
    expect(row!.covered).toBe(true)
    expect(row!.protocol).toBe(CLAIM_PROTOCOL_VERSION)
    expect(row!.invalidations).toBe('0')

    // A constat bumps; a re-cover holding the PRE-constat witness must lose.
    await invalidateWorkspaceCoverage(db.pool, key, 'raced')
    expect(await coverWorkspace(db.pool, key, '0')).toBe(false)
    row = await readRow('L1', 'V-cas')
    expect(row!.covered).toBe(false)
    expect(row!.invalidations).toBe('1')

    // The caller that observed the bump wins.
    expect(await coverWorkspace(db.pool, key, '1')).toBe(true)
    row = await readRow('L1', 'V-cas')
    expect(row!.covered).toBe(true)
    expect(row!.invalidations).toBe('1')
  })

  it('a non-zero witness with NO row is a lost CAS, never a fabricated row (M1 n2)', async () => {
    // The row was deleted under our feet: covering would mint a counter
    // nothing observed and certify a coverage nothing proved.
    const key = { landscapeId: 'L1', versionId: 'V-none' }
    expect(await coverWorkspace(db.pool, key, '3')).toBe(false)
    expect(await readRow('L1', 'V-none')).toBeUndefined()
  })
})
