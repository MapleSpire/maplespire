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
 * The batch claim core against real Postgres.
 *
 * The unit fakes emulate the two guarantees this module RESTS ON; only a real
 * server can pin them: sorted overlapping batches never deadlock (40P01), and
 * `ON CONFLICT DO NOTHING RETURNING` returns only actually-inserted rows so
 * the loser detection by set difference is sound.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { claimWorkspaceDocuments, CLAIM_BATCH_SIZE } from './documentClaims.js'
import type { Queryable } from '../readModel/types.js'
import { ensureSyncCellOwnershipSchema } from '../syncCells/ownership.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('claimWorkspaceDocuments (live Postgres)', () => {
  let db: IsolatedSchemaDb

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'document_claims')
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
    await db.pool.query("INSERT INTO landscapes (id, name) VALUES ('L1', 'One'), ('L2', 'Two')")
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES
       ('V1', 'L1', 'Main', 'automerge:claims-l1'),
       ('V2', 'L2', 'Main', 'automerge:claims-l2')`,
    )
    await ensureSyncCellOwnershipSchema(db.pool)
  })

  afterAll(async () => {
    await db?.teardown()
  })

  it('concurrent overlapping batches settle first-owner-wins without deadlock', async () => {
    // Two workspaces claim heavily-overlapping sets AT THE SAME TIME, several
    // rounds. Unsorted multi-row autocommit INSERTs over overlapping unique
    // keys are the documented 40P01 shape; the module's sort makes the loser
    // wait instead. The ids are handed over in OPPOSITE orders so that an
    // implementation without the sort would actually interleave.
    for (let round = 0; round < 3; round++) {
      const shared = Array.from({ length: 400 }, (_v, i) => `race-${round}-${String(i).padStart(4, '0')}`)
      const mineOnly = Array.from({ length: 100 }, (_v, i) => `race-${round}-mine-${i}`)
      const theirsOnly = Array.from({ length: 100 }, (_v, i) => `race-${round}-theirs-${i}`)
      const [ours, theirs] = await Promise.all([
        claimWorkspaceDocuments(db.pool, { landscapeId: 'L1', versionId: 'V1' }, [...shared, ...mineOnly]),
        claimWorkspaceDocuments(db.pool, { landscapeId: 'L2', versionId: 'V2' }, [...shared].reverse().concat(theirsOnly)),
      ])
      // Every shared id has exactly ONE durable owner, and the two results
      // partition it consistently: won by one side, foreign (pointing at the
      // winner) or alreadyOurs on the other.
      const { rows } = await db.pool.query<{ document_id: string; landscape_id: string }>(
        'SELECT document_id, landscape_id FROM automerge_document_workspace WHERE document_id = ANY($1::text[])',
        [shared],
      )
      expect(rows).toHaveLength(shared.length)
      const ownerOf = new Map(rows.map((row) => [row.document_id, row.landscape_id]))
      for (const id of shared) {
        const winner = ownerOf.get(id)
        expect(winner === 'L1' || winner === 'L2').toBe(true)
        if (winner === 'L1') {
          expect(ours.claimed.includes(id) || ours.alreadyOurs.includes(id)).toBe(true)
          // The loser may have raced the winner SELECT past a not-yet-visible
          // row (unaccounted — self-heals at next sight); when it DID resolve,
          // it must point at the true winner.
          const foreign = theirs.foreign.find((entry) => entry.documentId === id)
          if (foreign) expect(foreign.winner).toEqual({ landscapeId: 'L1', versionId: 'V1' })
          expect(theirs.claimed).not.toContain(id)
        } else {
          expect(theirs.claimed.includes(id) || theirs.alreadyOurs.includes(id)).toBe(true)
          const foreign = ours.foreign.find((entry) => entry.documentId === id)
          if (foreign) expect(foreign.winner).toEqual({ landscapeId: 'L2', versionId: 'V2' })
          expect(ours.claimed).not.toContain(id)
        }
      }
      expect(ours.missingVersion).toBe(false)
      expect(theirs.missingVersion).toBe(false)
    }
  }, 30_000)

  it('re-running an identical batch is a no-op reporting alreadyOurs', async () => {
    const ids = Array.from({ length: 50 }, (_v, i) => `rerun-${i}`)
    const first = await claimWorkspaceDocuments(db.pool, { landscapeId: 'L1', versionId: 'V1' }, ids)
    expect(new Set(first.claimed)).toEqual(new Set(ids))

    // The seed re-run shape: same publisher, same ids. Without DO NOTHING the
    // second run raises a unique violation; with it, every id conflicts and
    // resolves to our own key.
    const second = await claimWorkspaceDocuments(db.pool, { landscapeId: 'L1', versionId: 'V1' }, ids)
    expect(second.claimed).toEqual([])
    expect(new Set(second.alreadyOurs)).toEqual(new Set(ids))
    expect(second.foreign).toEqual([])
    expect(second.missingVersion).toBe(false)

    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM automerge_document_workspace WHERE document_id = ANY($1::text[])',
      [ids],
    )
    expect(rows[0]!.n).toBe(String(ids.length))
  })

  it('a batch with intra-batch duplicates claims each id ONCE against real Postgres (U4)', async () => {
    const result = await claimWorkspaceDocuments(
      db.pool, { landscapeId: 'L1', versionId: 'V1' }, ['dup-a', 'dup-a', 'dup-b'],
    )
    expect([...result.claimed].sort()).toEqual(['dup-a', 'dup-b'])
    const { rows } = await db.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM automerge_document_workspace WHERE document_id IN ('dup-a', 'dup-b')",
    )
    expect(rows[0]!.n).toBe('2')
  })

  it('claims 1,000+ ids in ceil(n/1000) batches, attested by the rows that come back', async () => {
    // The batch count, pinned where the counting is honest: the statement
    // tally comes from a wrapper around the REAL pool, and the effect is
    // attested by the persisted rows, not by the API having been called.
    const ids = Array.from({ length: 1_205 }, (_v, i) => `bulk-${String(i).padStart(5, '0')}`)
    let claimStatements = 0
    const counting: Queryable = {
      query: (sql, params) => {
        if (sql.includes('INSERT INTO automerge_document_workspace')) claimStatements += 1
        return db.pool.query(sql, params)
      },
    }

    const result = await claimWorkspaceDocuments(counting, { landscapeId: 'L2', versionId: 'V2' }, ids)

    expect(result.claimed).toHaveLength(ids.length)
    // A unitary loop explodes this to 1,205.
    expect(claimStatements).toBe(Math.ceil(ids.length / CLAIM_BATCH_SIZE))
    const { rows } = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automerge_document_workspace
        WHERE landscape_id = 'L2' AND document_id = ANY($1::text[])`,
      [ids],
    )
    expect(rows[0]!.n).toBe(String(ids.length))
  }, 30_000)
})
