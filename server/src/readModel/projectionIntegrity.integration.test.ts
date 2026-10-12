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

// The half of the content digest that cannot be unit-tested: does the SQL aggregate compute
// EXACTLY what `digestOfIds` computes, over a real PostgreSQL?
//
// Everything else in this feature rests on that agreement, and it rests on
// details no amount of reading proves — `bit_xor` returns NULL over zero rows,
// `to_hex` drops leading zeros, and `('x'||md5(id))::bit(64)::bigint` produces a
// NEGATIVE bigint for roughly half of all ids while this codebase holds the same
// value unsigned. Any one of those going wrong yields a permanent, inexplicable
// mismatch on some workspaces and not others.
//
// So the id sets below are not decoration: `unicode` and `quotes` pin the text
// encoding, and `uuidish` is large enough to cover both halves of the signed
// range many times over.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { digestOfIds, digestSql, digestTable, parseDigestRow } from './contentDigest.js'
import {
  fleetDefectSummary,
  stampProjectionIntegrity,
  verifyWorkspaceIntegrity,
} from './projectionIntegrity.js'
import type { WorkspaceKey } from './projector.js'

const CONNECTION = process.env.TEST_DATABASE_URL

describe.skipIf(!CONNECTION)('content digest: SQL and TypeScript agree', () => {
  let database: IsolatedSchemaDb

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'read_model_integrity')
    await ensureReadModelSchema(database.pool)
  })
  afterAll(async () => { await database?.teardown() })

  const workspace: WorkspaceKey = { landscapeId: 'ls-digest', versionId: 'v1' }

  /** Replace ro_objects for the workspace with exactly `ids`. */
  async function setObjects(ids: readonly string[]): Promise<void> {
    await database.pool.query(
      'DELETE FROM ro_objects WHERE landscape_id = $1 AND version_id = $2',
      [workspace.landscapeId, workspace.versionId],
    )
    for (const id of ids) {
      await database.pool.query(
        `INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES ($1, $2, $3, $4::jsonb)`,
        [workspace.landscapeId, workspace.versionId, id, JSON.stringify({ id })],
      )
    }
  }

  async function sqlDigest() {
    const { rows } = await database.pool.query<{ n: string; x: string }>(
      digestSql('object'), [workspace.landscapeId, workspace.versionId],
    )
    return parseDigestRow(rows[0])
  }

  const CASES: Array<[string, string[]]> = [
    ['an empty set', []],
    ['a single id', ['obj-1']],
    ['plain ascii', ['a', 'b', 'c', 'obj-1', 'obj-2']],
    ['non-ascii text', ['café', 'naïve', '日本語', 'emoji-🦫']],
    ['ids containing quotes and backslashes', ["it's", 'a"b', 'back\\slash', 'semi;colon']],
    ['500 uuid-shaped ids, covering both halves of the signed range',
      Array.from({ length: 500 }, (_, index) => `01890c7e-0000-7000-8000-${String(index).padStart(12, '0')}`)],
  ]

  it.each(CASES)('agrees on %s', async (_label, ids) => {
    await setObjects(ids)
    expect(await sqlDigest()).toEqual(digestOfIds(ids))
  })

  it('is independent of insertion order, which is why the SQL has no ORDER BY', async () => {
    const ids = CASES[5]![1]
    await setObjects(ids)
    const forward = await sqlDigest()
    await setObjects([...ids].reverse())
    expect(await sqlDigest()).toEqual(forward)
  })

  it('changes when one row is deleted — the property the whole feature rests on', async () => {
    const ids = CASES[5]![1]
    await setObjects(ids)
    const before = await sqlDigest()
    await database.pool.query(
      'DELETE FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
      [workspace.landscapeId, workspace.versionId, ids[7]],
    )
    expect(await sqlDigest()).not.toEqual(before)
  })

  it('names a real table for every kind', async () => {
    // A typo here is a query that throws at verification time on a path nothing
    // else exercises.
    for (const kind of ['object', 'connection', 'group', 'diagram'] as const) {
      const { rows } = await database.pool.query<{ n: string; x: string }>(
        digestSql(kind), [workspace.landscapeId, workspace.versionId],
      )
      expect(parseDigestRow(rows[0]), digestTable(kind)).not.toBeNull()
    }
  })
})

describe.skipIf(!CONNECTION)('verifyWorkspaceIntegrity', () => {
  let database: IsolatedSchemaDb

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'read_model_integrity_verify')
    await ensureReadModelSchema(database.pool)
  })
  afterAll(async () => { await database?.teardown() })

  let counter = 0
  /** A workspace whose ro_objects hold `ids` and whose projection state sits at
   * `generation`. Each test gets its own so ordering cannot matter. */
  async function seed(ids: readonly string[], generation: number): Promise<WorkspaceKey> {
    counter += 1
    const workspace: WorkspaceKey = { landscapeId: `ls-${counter}`, versionId: 'v1' }
    await database.pool.query(
      `INSERT INTO read_model_projection_state
         (landscape_id, version_id, observed_generation, projected_generation, last_projected_at)
       VALUES ($1, $2, $3, $3, now())`,
      [workspace.landscapeId, workspace.versionId, generation],
    )
    for (const id of ids) {
      await database.pool.query(
        `INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES ($1, $2, $3, $4::jsonb)`,
        [workspace.landscapeId, workspace.versionId, id, JSON.stringify({ id })],
      )
    }
    return workspace
  }

  /**
   * One projection, in PRODUCTION ORDER: stamp first — while the row still
   * carries the generation being superseded, which is what `unchanged` is
   * measured against — then advance the generation as
   * `completeReadModelProjection` does.
   *
   * A test that stamps and advances in the other order is testing an ordering
   * `runTracked` does not use, and would stay green over a false-mismatch
   * defect.
   */
  async function project(
    workspace: WorkspaceKey,
    generation: number,
    integrity: Parameters<typeof stampProjectionIntegrity>[3],
  ): Promise<void> {
    await stampProjectionIntegrity(database.pool, workspace, generation, integrity)
    await database.pool.query(
      `UPDATE read_model_projection_state
          SET projected_generation = GREATEST(projected_generation, $2),
              observed_generation = GREATEST(observed_generation, $2)
        WHERE landscape_id = $1`,
      [workspace.landscapeId, generation],
    )
  }

  it('verifies a workspace whose rows still match the sealed digest', async () => {
    const workspace = await seed(['a', 'b', 'c'], 6)
    await project(workspace, 7, {
      defects: [], digests: { object: digestOfIds(['a', 'b', 'c']) },
    })
    const report = await verifyWorkspaceIntegrity(database.pool, workspace)
    expect(report.outcome).toBe('verified')
    expect(report.verdicts.find((verdict) => verdict.kind === 'object')?.outcome).toBe('match')
    expect(report.defectCount).toBe(0)
  })

  it('detects a row deleted OUT OF BAND, which no CRDT comparison would see', async () => {
    // The class this covers: the projector wrote the rows and committed, and
    // something else removed one afterwards. Both sides of a CRDT-vs-read-model
    // comparison would have to be re-derived to notice; the sealed digest
    // notices with one aggregate.
    const workspace = await seed(['a', 'b', 'c'], 6)
    await project(workspace, 7, {
      digests: { object: digestOfIds(['a', 'b', 'c']) },
    })
    await database.pool.query(
      'DELETE FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
      [workspace.landscapeId, workspace.versionId, 'b'],
    )
    const report = await verifyWorkspaceIntegrity(database.pool, workspace)
    expect(report.outcome).toBe('mismatch')
    const verdict = report.verdicts.find((candidate) => candidate.kind === 'object')
    expect(verdict?.outcome).toBe('mismatch')
    expect(verdict?.expected?.n).toBe(3)
    expect(verdict?.actual?.n).toBe(2)
  })

  it('detects a row that was SWAPPED, where the count alone sees nothing', async () => {
    const workspace = await seed(['a', 'b'], 6)
    await project(workspace, 7, {
      digests: { object: digestOfIds(['a', 'b']) },
    })
    await database.pool.query(
      'UPDATE ro_objects SET id = $3 WHERE landscape_id = $1 AND version_id = $2 AND id = $4',
      [workspace.landscapeId, workspace.versionId, 'zzz', 'b'],
    )
    const report = await verifyWorkspaceIntegrity(database.pool, workspace)
    expect(report.outcome).toBe('mismatch')
    expect(report.verdicts.find((verdict) => verdict.kind === 'object')?.actual?.n).toBe(2)
  })

  it('reports NOT-VERIFIABLE, never verified, once the projector has moved on', async () => {
    const workspace = await seed(['a'], 6)
    await project(workspace, 7, { digests: { object: digestOfIds(['a']) } })
    await database.pool.query(
      'UPDATE read_model_projection_state SET projected_generation = 9, observed_generation = 9 WHERE landscape_id = $1',
      [workspace.landscapeId],
    )
    const report = await verifyWorkspaceIntegrity(database.pool, workspace)
    expect(report.outcome).toBe('not-verifiable')
    expect(report.summary).toBe('verified=0/4')
  })

  it('REFUSES to stamp when a newer generation already committed', async () => {
    // `completeReadModelProjection` advances with GREATEST precisely because a
    // newer generation can win during a handover. Stamping this projection's id
    // set against somebody else's rows would look exactly like corruption.
    const workspace = await seed(['a'], 9)
    await stampProjectionIntegrity(database.pool, workspace, 7, {
      defects: [], digests: { object: digestOfIds(['stale']) },
    })
    const { rows } = await database.pool.query<{ content_digest: unknown; defect_count: number | null }>(
      'SELECT content_digest, defect_count FROM read_model_projection_state WHERE landscape_id = $1',
      [workspace.landscapeId],
    )
    expect(rows[0]?.content_digest).toBeNull()
    expect(rows[0]?.defect_count).toBeNull()
  })

  it('MERGES per kind, so one kind\'s stamp cannot erase another\'s', async () => {
    const workspace = await seed(['a'], 6)
    await stampProjectionIntegrity(database.pool, workspace, 7, { digests: { object: digestOfIds(['a']) } })
    await project(workspace, 7, { digests: { diagram: digestOfIds(['d1']) } })
    const report = await verifyWorkspaceIntegrity(database.pool, workspace)
    // `.not.toBeNull()` alone would pass on `undefined`, so a `find` that matched
    // nothing would slip through — assert the verdict exists first.
    for (const kind of ['object', 'diagram'] as const) {
      const verdict = report.verdicts.find((candidate) => candidate.kind === kind)
      expect(verdict, kind).toBeDefined()
      expect(verdict!.expected, kind).not.toBeNull()
    }
  })

  it('carries an UNCHANGED kind forward only while its seal was still current', async () => {
    // Same rule as the live-projector test, pinned here on the SQL itself.
    const workspace = await seed(['a'], 6)
    await stampProjectionIntegrity(database.pool, workspace, 7, { digests: { object: digestOfIds(['a']) } })
    await database.pool.query(
      'UPDATE read_model_projection_state SET projected_generation = 7, observed_generation = 7 WHERE landscape_id = $1',
      [workspace.landscapeId],
    )
    // Generation 8 truthfully touched no objects: the seal is current, so it moves.
    await stampProjectionIntegrity(database.pool, workspace, 8, { unchanged: ['object'] })
    await database.pool.query(
      'UPDATE read_model_projection_state SET projected_generation = 8, observed_generation = 8 WHERE landscape_id = $1',
      [workspace.landscapeId],
    )
    expect((await verifyWorkspaceIntegrity(database.pool, workspace)).outcome).toBe('verified')

    // Generation 9 changes the objects and declines to re-seal: the seal is now
    // stale. Generation 10 touched no objects — but it must NOT resurrect a seal
    // that no longer describes the rows.
    await database.pool.query(
      `INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES ($1, $2, 'b', '{"id":"b"}'::jsonb)`,
      [workspace.landscapeId, workspace.versionId],
    )
    await database.pool.query(
      'UPDATE read_model_projection_state SET projected_generation = 9, observed_generation = 9 WHERE landscape_id = $1',
      [workspace.landscapeId],
    )
    await stampProjectionIntegrity(database.pool, workspace, 10, { unchanged: ['object'] })
    await database.pool.query(
      'UPDATE read_model_projection_state SET projected_generation = 10, observed_generation = 10 WHERE landscape_id = $1',
      [workspace.landscapeId],
    )
    const report = await verifyWorkspaceIntegrity(database.pool, workspace)
    expect(report.verdicts.find((verdict) => verdict.kind === 'object')?.outcome).toBe('not-verifiable')
    expect(report.outcome).not.toBe('mismatch')
  })

  it('does not let a projection that never looked clear a defect count', async () => {
    const workspace = await seed(['a'], 6)
    await project(workspace, 7, {
      defects: [{ kind: 'document-uninitialised', source: 'object-shard', url: 'automerge:os0' }],
      digests: { object: digestOfIds(['a']) },
    })
    // A later projection that carries digests only and never looked at documents.
    await project(workspace, 8, { digests: { group: digestOfIds([]) } })
    const report = await verifyWorkspaceIntegrity(database.pool, workspace)
    expect(report.defectCount).toBe(1)
    expect(report.defectSummary).toContain('object-shard/document-uninitialised')
  })

  it('counts never-examined workspaces apart from clean ones', async () => {
    // EXACT counts, on a schema this test owns. `toBeGreaterThan(0)` would pass
    // even with the `FILTER (WHERE defect_count IS NULL)` replaced by `count(*)`,
    // because earlier tests leave unstamped workspaces behind.
    const before = await fleetDefectSummary(database.pool)
    const examined = await seed(['a'], 6)
    await project(examined, 7, { defects: [] })
    await seed(['b'], 7) // never stamped
    const after = await fleetDefectSummary(database.pool)
    expect(after.workspacesNeverExamined).toBe(before.workspacesNeverExamined + 1)
    expect(after.workspacesWithDefects).toBe(before.workspacesWithDefects)
  })

  it('skips the ranked query when the caller only wants the totals', async () => {
    // `/metrics` scrapes three numbers and must not pay for a ranked scan it
    // would throw away on every scrape.
    const summary = await fleetDefectSummary(database.pool, { worstLimit: 0 })
    expect(summary.worst).toEqual([])
    expect(Number.isFinite(summary.totalDefects)).toBe(true)
  })
})
