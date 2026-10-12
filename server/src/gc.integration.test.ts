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

import { Repo, generateAutomergeUrl } from '@automerge/automerge-repo'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gcOrphanedDocs } from './gc.js'
import { MaintenanceCoordinator } from './maintenance/coordinator.js'
import { ensureMaintenanceSchema } from './maintenance/schema.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from './testing/isolatedSchema.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('fenced global Automerge GC', () => {
  let db: IsolatedSchemaDb
  let repo: Repo

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'global_gc_worker')
    await db.pool.query(`
      -- PRODUCTION SHAPE, not just the column this suite happens to read. It
      -- declared root_url alone, and task T-20 broke it: routing every
      -- maintenance sweep through one enumerator means the query also selects
      -- landscape_id and id, and this fixture answered
      -- 'column "landscape_id" does not exist'.
      --
      -- The file's own docblock below already called this out: it says the D3
      -- suite exists partly because its versions table carries the production
      -- columns instead of root_url alone. That divergence is gone now rather
      -- than compensated for.
      --
      -- (No backticks in this comment, deliberately: it lives inside a JS
      -- template literal, and the first one ends the string. The parse error
      -- that produced said only "Expected , or ) but found Identifier".)
      CREATE TABLE versions (
        id TEXT NOT NULL,
        landscape_id TEXT NOT NULL,
        root_url TEXT NOT NULL,
        PRIMARY KEY (landscape_id, id)
      )
    `)
    await db.pool.query(`
      CREATE TABLE automerge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)
    `)
    await db.pool.query(`
      CREATE TABLE landscape_versions (manifest JSONB NOT NULL)
    `)
    await db.pool.query(`
      CREATE TABLE automerge_storage (
        key TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `)
    await db.pool.query(`
      CREATE TABLE automerge_document_workspace (
        document_id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL,
        version_id TEXT NOT NULL
      )
    `)
    await db.pool.query(`
      CREATE TABLE read_model_document_watermarks (
        landscape_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        projected_watermark BIGINT NOT NULL,
        PRIMARY KEY (landscape_id, version_id, document_id)
      )
    `)
    await ensureMaintenanceSchema(db.pool)
    repo = new Repo({ network: [] })
  })

  afterAll(async () => {
    await repo?.shutdown()
    await db?.teardown()
  })

  it('deletes an old orphan but defers a newly-created unlinked document', async () => {
    const now = new Date('2026-07-22T12:00:00.000Z')
    await db.pool.query(
      `INSERT INTO automerge_storage (key, data, created_at, updated_at) VALUES
       ('old-orphan/snapshot/1', decode('00', 'hex'), $1, $1),
       ('young-orphan/snapshot/1', decode('00', 'hex'), $2, $2)`,
      [new Date(now.getTime() - 2 * 86_400_000), now],
    )
    // The admission rows: the swept document's must die WITH its storage —
    // left behind it is a permanent `document-orphaned` ghost that nothing
    // ever revisits; the survivor's must stay. Same rule for the watermarks.
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES
       ('old-orphan', 'L', 'V'), ('young-orphan', 'L', 'V')`,
    )
    await db.pool.query(
      `INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark) VALUES
       ('L', 'V', 'old-orphan', 5), ('L', 'V', 'young-orphan', 5)`,
    )
    const coordinator = new MaintenanceCoordinator(db.pool, 'global-worker-test')
    const outcome = await coordinator.runFenced('automerge_gc', async (fence) => (
      gcOrphanedDocs(repo, {
        db: db.pool,
        fence,
        minimumAgeMs: 86_400_000,
        now,
      })
    ))

    expect(outcome).toMatchObject({
      status: 'completed',
      value: { deleted: 1, deferredYoung: 1, aborted: false },
    })
    const { rows } = await db.pool.query<{ doc: string }>(
      "SELECT DISTINCT split_part(key, '/', 1) AS doc FROM automerge_storage ORDER BY doc",
    )
    expect(rows.map((row) => row.doc)).toEqual(['young-orphan'])
    const { rows: admissionRows } = await db.pool.query<{ document_id: string }>(
      'SELECT document_id FROM automerge_document_workspace ORDER BY document_id',
    )
    expect(admissionRows.map((row) => row.document_id)).toEqual(['young-orphan'])
    const { rows: watermarkRows } = await db.pool.query<{ document_id: string }>(
      'SELECT document_id FROM read_model_document_watermarks ORDER BY document_id',
    )
    expect(watermarkRows.map((row) => row.document_id)).toEqual(['young-orphan'])
  })
})

/**
 * The overlay reachability root, against a REAL PostgreSQL.
 *
 * The `describe` above cannot exercise it: its isolated schema hand-builds six
 * tables without `read_model_overlay_segments`, so gc.ts's `to_regclass` guard
 * returns null and the whole block is SKIPPED (the same holds for the
 * `read_model_static_workspaces` root). This file supplies the guard's TRUE
 * branch, in MC/DC terms.
 *
 * The schema comes from `ensureReadModelSchema`, the real definition, and
 * `versions` carries its production columns (`id`, `landscape_id`).
 * gc.test.ts covers the LOGIC with a fake pool; this test proves the query is
 * valid PostgreSQL and returns what we think.
 */
describe.skipIf(!TEST_DATABASE_URL)('D3 — racine GC des segments overlay retenus', () => {
  let db: IsolatedSchemaDb
  let repo: Repo

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'gc_overlay_root')
    await db.pool.query(`
      CREATE TABLE versions (
        id TEXT NOT NULL,
        landscape_id TEXT NOT NULL,
        root_url TEXT NOT NULL,
        PRIMARY KEY (landscape_id, id)
      )
    `)
    await db.pool.query(`
      CREATE TABLE automerge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)
    `)
    await db.pool.query(`
      CREATE TABLE landscape_versions (manifest JSONB NOT NULL)
    `)
    await db.pool.query(`
      CREATE TABLE automerge_storage (
        key TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `)
    await db.pool.query(`
      CREATE TABLE automerge_document_workspace (
        document_id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL,
        version_id TEXT NOT NULL
      )
    `)
    // The REAL definition, not a hand-written twin that can drift from it.
    const { ensureReadModelSchema } = await import('./readModel/schema.js')
    await ensureReadModelSchema(db.pool)
    await ensureMaintenanceSchema(db.pool)
    repo = new Repo({ network: [] })
  })

  afterAll(async () => {
    await repo?.shutdown()
    await db?.teardown()
  })

  it("retient un segment d une version VIVANTE et laisse tomber celui d une version supprimee", async () => {
    const now = new Date('2026-08-19T12:00:00.000Z')
    const old = new Date(now.getTime() - 2 * 86_400_000)
    // REAL document ids. `add()` runs `isValidAutomergeUrl` first and silently
    // DROPS anything else, so a hand-written id like `live-head` makes the root
    // look inert and the test pass or fail for the wrong reason.
    const id = (url: string) => url.replace('automerge:', '')
    const liveHead = id(generateAutomergeUrl())
    const liveRetained = id(generateAutomergeUrl())
    const liveCurrentExpired = id(generateAutomergeUrl())
    const liveNullNotCurrent = id(generateAutomergeUrl())
    const liveExpired = id(generateAutomergeUrl())
    const deadHead = id(generateAutomergeUrl())

    // Six documents, all old enough to sweep and none reachable any other way.
    // Only the overlay root can save any of them.
    await db.pool.query(
      `INSERT INTO automerge_storage (key, data, created_at, updated_at) VALUES
       ($2 || '/snapshot/1', decode('00', 'hex'), $1, $1),
       ($3 || '/snapshot/1', decode('00', 'hex'), $1, $1),
       ($4 || '/snapshot/1', decode('00', 'hex'), $1, $1),
       ($5 || '/snapshot/1', decode('00', 'hex'), $1, $1),
       ($6 || '/snapshot/1', decode('00', 'hex'), $1, $1),
       ($7 || '/snapshot/1', decode('00', 'hex'), $1, $1)`,
      [old, liveHead, liveRetained, liveCurrentExpired, liveNullNotCurrent, liveExpired, deadHead],
    )
    // ONE version row: L/V-live exists, L/V-dead has been deleted. That join is
    // the whole subject — without it `deadHead` stays pinned for ever, since
    // nothing in server/src ever deletes a `read_model_overlay_segments` row.
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, root_url) VALUES ('V-live', 'L', $1)`,
      [generateAutomergeUrl()],
    )
    // STATIC, because that is the only shape an overlay chain ever has: a
    // static root short-circuits the graph walk and reads its manifest from
    // SQL, so the fixture needs no valid Automerge root graph. (An
    // unresolvable or degenerate root would abort the sweep and delete
    // NOTHING, which reads as "the root protected them".)
    await db.pool.query(
      `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source)
       VALUES ('L', 'V-live', 'test')`,
    )
    // A non-empty manifest that rescues NONE of the four — an empty one is
    // `empty-static-manifest`, which aborts.
    await db.pool.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
       VALUES ('L', 'V-live', $1, 'model-meta')`,
      [id(generateAutomergeUrl())],
    )
    // `retain_until` is written RELATIVE TO THE DATABASE CLOCK, never to `now`.
    // The retention predicate is `segment.retain_until > now()` — SQL `now()`,
    // which `options.now` does not reach: that injected clock only feeds the age
    // cutoff. An absolute `now + 30 days` would expire on a calendar date and
    // the test would start failing with no code change.
    //
    // SIX rows, and the three extra ones exist to separate the three disjuncts
    // of `is_current OR retain_until IS NULL OR retain_until > now()`. With only
    // a `(true, NULL)` head, the first two disjuncts are mutually redundant and
    // deleting either would go unnoticed.
    //
    // The COLLECTIONS are not decoration: `idx_read_model_overlay_segments_current`
    // is UNIQUE on (landscape_id, version_id, collection) WHERE is_current, so a
    // workspace has at most one current segment per collection.
    await db.pool.query(
      `INSERT INTO read_model_overlay_segments
         (landscape_id, version_id, collection, document_id, segment_url, is_current, retain_until)
       VALUES
       -- the ordinary head: saved by two disjuncts at once, discriminates none
       ('L', 'V-live', 'object',     $1, 'u1', true,  NULL),
       -- saved ONLY by retain_until > now()
       ('L', 'V-live', 'connection', $2, 'u2', false, now() + interval '30 days'),
       -- saved ONLY by is_current       -> kills "drop the is_current disjunct"
       ('L', 'V-live', 'connection', $3, 'u3', true,  now() - interval '1 day'),
       -- saved ONLY by retain_until IS NULL -> kills "drop the IS NULL disjunct"
       ('L', 'V-live', 'connection', $4, 'u4', false, NULL),
       -- saved by NOTHING: past its window and not current
       ('L', 'V-live', 'object',     $5, 'u5', false, now() - interval '1 day'),
       -- saved by nothing either: its VERSION is gone -> kills "drop the JOIN"
       ('L', 'V-dead', 'object',     $6, 'u6', true,  NULL)`,
      [liveHead, liveRetained, liveCurrentExpired, liveNullNotCurrent, liveExpired, deadHead],
    )

    const coordinator = new MaintenanceCoordinator(db.pool, 'gc-overlay-root-test')
    const outcome = await coordinator.runFenced('automerge_gc', async (fence) => (
      gcOrphanedDocs(repo, { db: db.pool, fence, minimumAgeMs: 86_400_000, now })
    ))
    // A sweep that ABORTED deletes nothing, and "nothing deleted" is exactly
    // what a working retention root also looks like. Assert the run happened
    // before reading anything out of it.
    expect(outcome).toMatchObject({ status: 'completed', value: { aborted: false } })

    const { rows } = await db.pool.query<{ doc: string }>(
      "SELECT DISTINCT split_part(key, '/', 1) AS doc FROM automerge_storage",
    )
    // Four survive, one per disjunct plus the doubly-saved ordinary head; two
    // are swept. Each of these regressions flips exactly one document:
    //   drop `is_current OR`        -> `liveCurrentExpired` is swept
    //   drop `retain_until IS NULL` -> `liveNullNotCurrent` is swept
    //   drop the JOIN on `versions` -> `deadHead` survives
    expect(rows.map((row) => row.doc).sort()).toEqual(
      [liveHead, liveRetained, liveCurrentExpired, liveNullNotCurrent].sort(),
    )
  }, 30_000)
})
