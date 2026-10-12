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

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import { ensureReadModelSchema } from './schema.js'
import { OVERLAY_RETENTION_DAYS, releaseSupersededOverlaySegment } from './overlayHistoryStore.js'
import { StaticDeltaProjector } from './staticDeltaProjector.js'
import { registerStaticReadModelDocuments } from './staticWorkspace.js'
import { asLegacyStaticOrphan, staticAllowListFkPresent } from '../testing/legacyStaticOrphan.js'
import pg from 'pg'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import type { WorkspaceKey } from './projector.js'

/**
 * Static-plane reconciliation against a REAL Postgres. The unit tests next door supply the descriptor
 * SELECT's rows, so none of them can see which rows the real statement returns —
 * a fake cannot fail over a missing join. These run the statements.
 *
 * The GC half is here for the same reason: `retain_until IS NULL` means
 * RETAINED, and whether a row still matches the reachability predicate is a
 * property of the database, not of the call.
 */
// `TEST_DATABASE_URL` first and NO hardcoded fallback, like the other DB-gated
// files: this file opens with `DROP SCHEMA … CASCADE`, and a default such as
// `localhost:5432/maplespire` would be a developer's DEV STACK. With neither
// variable set, skipping is the only acceptable answer.
const URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? ''
const WS: WorkspaceKey = { landscapeId: 'land-a10', versionId: 'version-a10' }

const SCHEMA = 'test_a10_reconcile'

/**
 * `search_path` pinned to this suite's schema ALONE — never `<mine>,public`.
 *
 * With `public` on the path, `CREATE TABLE IF NOT EXISTS` SEES the shared
 * tables and creates nothing, so every DELETE in `beforeEach` would fall on
 * rows belonging to other suites — green in isolation, destructive in company.
 *
 * Not `createIsolatedSchemaDb`: its pool is `max: 5`, and five more
 * connections in a sixteen-worker run can push the cluster past
 * `max_connections` — which shows up as DB-gated tests in OTHER files
 * reporting SKIPPED. Two connections, the helper's schema discipline, and a
 * fixed name so a crashed run leaves at most one stale schema.
 */
async function probe(): Promise<{ pool: pg.Pool; teardown: () => Promise<void> } | null> {
  // EXPLICIT, because an empty connection string is not inert: libpq falls back
  // to `PGHOST`/`PGUSER` or localhost, which would put this file's
  // `DROP SCHEMA … CASCADE` on whatever cluster happens to be there.
  if (!URL) return null
  const db = {
    pool: guardIdleClientErrors(new pg.Pool({
      connectionString: URL,
      max: 2,
      connectionTimeoutMillis: 4000,
      options: `-c search_path=${SCHEMA}`,
    }), 'a10'),
    teardown: async () => {
      await db.pool.end().catch(() => undefined)
      const cleanup = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 1 }), 'a10:cleanup')
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      } finally {
        await cleanup.end()
      }
    },
  }
  try {
    const admin = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 1 }), 'a10:admin')
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    } finally {
      await admin.end()
    }
    const client = await db.pool.connect()
    try {
      // Nothing resolves to `public`, so every table this suite reads has to
      // exist here — including the two the projector reaches past the read
      // model. Only the columns these tests use.
      // COMPOSITE key, because that is how production is READ: every join in
      // the projector correlates `version.landscape_id AND version.id`. A local
      // copy with `id` alone as the primary key cannot express a sibling
      // landscape reusing a version id — which is exactly the shape the
      // both-key-columns test needs to tell a two-column join from a
      // one-column one.
      await client.query(`CREATE TABLE versions (
        id TEXT NOT NULL, landscape_id TEXT NOT NULL, label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        PRIMARY KEY (landscape_id, id)
      )`)
      await client.query(`CREATE TABLE automerge_document_workspace (
        document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL
      )`)
      await ensureReadModelSchema(client)
    } finally {
      client.release()
    }
    return db
  } catch {
    await db.pool.end().catch(() => undefined)
    return null
  }
}

const isolated = await probe()
const pool = isolated?.pool ?? null
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[a10] no Postgres at ${URL} — skipping`)

suite('A10 integration — the authority decides, and a superseded child stops being pinned', () => {
  const db = pool!
  const running: StaticDeltaProjector[] = []

  afterAll(async () => {
    for (const projector of running.splice(0)) await projector.stop().catch(() => undefined)
    await isolated!.teardown().catch(() => undefined)
  })

  beforeEach(async () => {
    // Unqualified: `search_path` is this suite's schema and nothing else, so a
    // name that resolved anywhere shared would be a missing-relation error
    // rather than a silent write into another suite's rows.
    for (const table of [
      'read_model_static_documents', 'read_model_static_workspaces',
      'read_model_overlay_segments', 'read_model_overlay_rotations',
      'read_model_projection_state', 'automerge_document_workspace',
      'ro_diagrams', 'versions',
    ]) await db.query(`DELETE FROM ${table}`)
    await db.query(
      `INSERT INTO versions (id, landscape_id, label, status)
       VALUES ($1, $2, 'v', 'active')`, [WS.versionId, WS.landscapeId])
  })

  const markStatic = () => db.query(
    `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source)
     VALUES ($1, $2, 'promotion')`, [WS.landscapeId, WS.versionId])

  const addDocument = (documentId: string, kind = 'registry-shard') => db.query(
    `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
     VALUES ($1, $2, $3, $4)`, [WS.landscapeId, WS.versionId, documentId, kind])

  /** See `asLegacyStaticOrphan` — a reproduction of pre-constraint data; the
   * A10-i9/i10 tests assert that a live write of the same shape is refused. */
  const asLegacyOrphan = (write: () => Promise<unknown>) => asLegacyStaticOrphan(db, write)

  function projector() {
    const instance = new StaticDeltaProjector(new Repo({}), db)
    running.push(instance)
    return instance as unknown as {
      reloadDescriptors(): Promise<void>
      descriptors: Map<string, unknown>
      attachedWorkspaces: Map<string, unknown>
    }
  }

  it('A10-i14 — the constraint PRODUCTION installs, asserted at schema level', async () => {
    // Other tests observe the constraint through a WRITE and its refusal, one
    // step removed. This reads the catalogue directly and asserts the
    // properties themselves rather than their consequence: which table, which
    // columns in which ORDER, which referenced table, `ON DELETE CASCADE`
    // (`confdeltype = 'c'`), and NOT VALID (`convalidated = false`).
    const { rows } = await db.query<{
      convalidated: boolean; confdeltype: string; columns: string[]; references_table: string
    }>(
      `SELECT c.convalidated, c.confdeltype,
              -- \`::text\`, not bare \`attname\`: that is \`name[]\` (OID 1003), which
              -- node-postgres has no array parser for and hands back as the raw
              -- string '{landscape_id,version_id}'.
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
              (SELECT relname FROM pg_class WHERE oid = c.confrelid) AS references_table
         FROM pg_constraint c
        WHERE c.conrelid = to_regclass('read_model_static_documents')
          AND c.conname = 'read_model_static_documents_workspace_fk'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].columns).toEqual(['landscape_id', 'version_id'])
    expect(rows[0].references_table).toBe('read_model_static_workspaces')
    expect(rows[0].confdeltype).toBe('c')
    expect(rows[0].convalidated).toBe(false)
  })

  it('A10-i15 — a boot against a database that ALREADY holds an orphan still comes up', async () => {
    // THE PROPERTY `NOT VALID` EXISTS FOR. Every test schema is created empty,
    // so a VALIDATED constraint would install perfectly well elsewhere; the
    // scenario the word defends is a deploy against a live database that
    // already carries a pre-constraint row.
    //
    // `ensureReadModelSchema` runs on every boot, so "the DDL throws" is not a
    // migration that fails, it is a server that cannot start.
    await db.query(`ALTER TABLE read_model_static_documents
      DROP CONSTRAINT IF EXISTS read_model_static_documents_workspace_fk`)
    await db.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
       VALUES ('land-predates-fk', 'version-predates-fk', 'legacy-orphan-doc', 'registry-shard')`)

    // The boot. With a validated constraint this raises 23503 and the process
    // never finishes starting.
    const client = await db.connect()
    try {
      await expect(ensureReadModelSchema(client)).resolves.toBeUndefined()
    } finally {
      client.release()
    }

    // …installed, un-validated, and the pre-existing row untouched.
    expect(await staticAllowListFkPresent(db)).toBe(true)
    const { rows } = await db.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint
        WHERE conrelid = to_regclass('read_model_static_documents')
          AND conname = 'read_model_static_documents_workspace_fk'`)
    expect(rows[0]?.convalidated).toBe(false)
    const survived = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM read_model_static_documents
        WHERE document_id = 'legacy-orphan-doc'`)
    expect(survived.rows[0].n).toBe(1)

    // …and it ENFORCES, so "it installed" is not standing in for "it works".
    await markStatic()
    await expect(addDocument('after-a-boot-with-an-orphan')).resolves.toBeDefined()
    await expect(db.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
       VALUES ('nobody', 'nothing', 'refused-after-boot', 'registry-shard')`))
      .rejects.toMatchObject({ code: '23503' })
  })

  it('A10-i1 — an ORPHAN document row does not attach the projector', async () => {
    // The measured state: a demotion removed the authority row and the demoted
    // projector's own rotation put a document row back. The SELECT must not
    // read that row as evidence to attach.
    await asLegacyOrphan(() => addDocument('orphan-doc'))
    const p = projector()
    await p.reloadDescriptors()
    expect(p.descriptors.size).toBe(0)
    expect(p.attachedWorkspaces.size).toBe(0)

    // CONTROL, and it is what makes the zero above mean anything: the SAME row
    // with the authority present must attach. Without this, "0" would also be
    // the answer to a statement that is simply broken.
    await markStatic()
    await p.reloadDescriptors()
    expect(p.descriptors.size).toBe(1)
    expect(p.attachedWorkspaces.size).toBe(1)
  })

  it('A10-i2 — the health row is written only for a workspace with authority', async () => {
    await asLegacyOrphan(() => addDocument('orphan-doc'))
    const p = projector()
    await p.reloadDescriptors()
    const before = await db.query(
      `SELECT count(*)::int AS n FROM read_model_projection_state
        WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
    // `markReadModelProjectorAttached` stamps the STATIC projector's instance
    // id onto the ORDINARY projector's health row. Forging that identity is a
    // second, quieter consequence of the same loop.
    expect(before.rows[0].n).toBe(0)

    await markStatic()
    await p.reloadDescriptors()
    const after = await db.query(
      `SELECT projector_attached FROM read_model_projection_state
        WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
    expect(after.rows[0]?.projector_attached).toBe(true)
  })

  it('A10-i3 — losing the authority releases the workspace on the next tick', async () => {
    await markStatic()
    await addDocument('doc-1')
    await addDocument('doc-2')
    const p = projector()
    await p.reloadDescriptors()
    expect(p.descriptors.size).toBe(2)

    // A demotion, exactly as `demoteSummaryWorkspace` performs it: authority
    // first, then the documents. The document rows are then re-created, which
    // is what one rotation by the unaware projector does.
    await db.query(`DELETE FROM read_model_static_workspaces
      WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
    await p.reloadDescriptors()
    expect(p.descriptors.size).toBe(0)
    expect(p.attachedWorkspaces.size).toBe(0)
  })

  it('A10-i7 — the join is on BOTH key columns, which one workspace cannot show', async () => {
    // A single-workspace database cannot tell a two-column join from a one-column one: with only
    // `land-a10/version-a10` present, joining on `landscape_id` alone gives the
    // same answer as joining on the pair. A Draft is a second VERSION of the
    // same landscape, so the discriminating shape is the ordinary case.
    await markStatic()
    await addDocument('mine')

    // A sibling version of the SAME landscape, with no authority row of its own.
    await db.query(
      `INSERT INTO versions (id, landscape_id, label, status) VALUES ('version-sib', $1, 'v', 'active')`,
      [WS.landscapeId])
    await asLegacyOrphan(() => db.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
       VALUES ($1, 'version-sib', 'sibling-version-doc', 'registry-shard')`, [WS.landscapeId]))
    // …and a sibling LANDSCAPE reusing the same version id, likewise unauthorised.
    await db.query(
      `INSERT INTO versions (id, landscape_id, label, status) VALUES ($1, 'land-sib', 'v', 'active')`,
      [WS.versionId])
    await asLegacyOrphan(() => db.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
       VALUES ('land-sib', $1, 'sibling-landscape-doc', 'registry-shard')`, [WS.versionId]))

    const p = projector()
    await p.reloadDescriptors()
    // Joining on `landscape_id` alone would admit `sibling-version-doc`;
    // on `version_id` alone, `sibling-landscape-doc`; crossed, neither and
    // nothing else either.
    expect([...p.descriptors.keys()]).toEqual(['mine'])
    expect(p.attachedWorkspaces.size).toBe(1)
  })

  it('A10-i8 — the entity_id backfill is a WRITE, and it obeys the authority too', async () => {
    // The backfill is an UPDATE that runs on every ten-second tick; unfiltered,
    // it would repair allow-list rows for workspaces the static plane does not
    // own.
    const seedDiagram = (landscapeId: string, versionId: string, id: string, documentId: string) => db.query(
      `INSERT INTO ro_diagrams (landscape_id, version_id, id, data)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [landscapeId, versionId, id, JSON.stringify({ docUrl: `automerge:${documentId}` })])

    // An UNAUTHORISED workspace whose allow-list row is missing its entity id.
    await db.query(
      `INSERT INTO versions (id, landscape_id, label, status) VALUES ('version-orph', $1, 'v', 'active')`,
      [WS.landscapeId])
    await asLegacyOrphan(() => db.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind, entity_id)
       VALUES ($1, 'version-orph', 'orphan-diagram-doc', 'diagram', NULL)`, [WS.landscapeId]))
    await seedDiagram(WS.landscapeId, 'version-orph', 'orphan-diagram', 'orphan-diagram-doc')

    const p = projector()
    await p.reloadDescriptors()
    const orphan = await db.query(
      `SELECT entity_id FROM read_model_static_documents WHERE document_id = 'orphan-diagram-doc'`)
    expect(orphan.rows[0].entity_id).toBeNull()

    // CONTROL — the same shape WITH an authority row must be repaired, or the
    // null above would only mean the statement is broken.
    await markStatic()
    await db.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind, entity_id)
       VALUES ($1, $2, 'mine-diagram-doc', 'diagram', NULL)`, [WS.landscapeId, WS.versionId])
    await seedDiagram(WS.landscapeId, WS.versionId, 'mine-diagram', 'mine-diagram-doc')
    await p.reloadDescriptors()

    const mine = await db.query(
      `SELECT entity_id FROM read_model_static_documents WHERE document_id = 'mine-diagram-doc'`)
    expect(mine.rows[0].entity_id).toBe('mine-diagram')
    // …and the unauthorised one is STILL null after a tick that repaired its neighbour.
    const stillOrphan = await db.query(
      `SELECT entity_id FROM read_model_static_documents WHERE document_id = 'orphan-diagram-doc'`)
    expect(stillOrphan.rows[0].entity_id).toBeNull()
  })

  it('A10-i9 — the allow-list cannot be written for a workspace with no authority', async () => {
    // The WRITER half (the reader half is the authority join), and the
    // assertion `asLegacyStaticOrphan` rests on: without it, that helper reads
    // as a workaround rather than as a reproduction of legacy data.
    await expect(addDocument('doc-without-authority')).rejects.toMatchObject({ code: '23503' })

    // CONTROL. A constraint that refuses everything would satisfy the line
    // above just as well.
    await markStatic()
    await expect(addDocument('doc-with-authority')).resolves.toBeDefined()
  })

  it('A10-i10 — and the PRODUCTION writer is refused, atomically, on a bare pool', async () => {
    // The raw INSERT above is not the shape that matters.
    // `registerStaticReadModelDocuments` is: some of its call sites run on a
    // bare pool with no plane check of any kind, and the constraint refuses
    // them from underneath rather than needing a gate at each site.
    //
    // Atomicity is asserted alongside. The function writes
    // `automerge_document_workspace` FIRST and the allow-list second, so a
    // refusal that did not roll back would leave a workspace claim for a
    // document that is in no allow-list.
    await expect(registerStaticReadModelDocuments(db, WS, [
      { documentId: 'pool-written-doc', kind: 'registry-shard' },
    ])).rejects.toMatchObject({ code: '23503' })
    const claim = await db.query(
      `SELECT count(*)::int AS n FROM automerge_document_workspace WHERE document_id = 'pool-written-doc'`)
    expect(claim.rows[0].n).toBe(0)

    // CONTROL — with the authority present the same call writes BOTH rows.
    await markStatic()
    await registerStaticReadModelDocuments(db, WS, [
      { documentId: 'pool-written-doc', kind: 'registry-shard' },
    ])
    const after = await db.query(
      `SELECT (SELECT count(*)::int FROM automerge_document_workspace
                WHERE document_id = 'pool-written-doc') AS claims,
              (SELECT count(*)::int FROM read_model_static_documents
                WHERE document_id = 'pool-written-doc') AS allowed`)
    expect(after.rows[0]).toEqual({ claims: 1, allowed: 1 })
  })

  it('A10-i11 — removing the authority row takes the allow-list with it', async () => {
    await markStatic()
    await addDocument('doc-a')
    await addDocument('doc-b')
    const before = await db.query(
      `SELECT count(*)::int AS n FROM read_model_static_documents`)
    // Non-vacuity: a cascade over an empty allow-list proves nothing.
    expect(before.rows[0].n).toBe(2)

    await db.query(
      `DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId])
    const after = await db.query(`SELECT count(*)::int AS n FROM read_model_static_documents`)
    expect(after.rows[0].n).toBe(0)
  })

  it('A10-i13 — the FK does not serialize an allow-list write behind an ordinary re-mark', async () => {
    // The constraint makes every allow-list
    // INSERT take a key-share row lock on the authority row, so
    // `registerStaticReadModelDocuments` — which writes
    // `automerge_document_workspace` first — takes S → D in the opposite order
    // to the global S → W → D that three other files state. That is safe only
    // because key share is compatible with the FOR NO KEY UPDATE an upsert on a
    // non-key column takes. This test notices a `SET source` becoming a `SET
    // version_id`, or the FK being re-declared with a stronger action.
    await markStatic()
    const remark = await db.connect()
    const rotation = await db.connect()
    try {
      await remark.query('BEGIN')
      await rotation.query('BEGIN')
      // Holds the authority row in FOR NO KEY UPDATE.
      await remark.query(
        `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source)
         VALUES ($1, $2, 're-mark')
         ON CONFLICT (landscape_id, version_id) DO UPDATE SET source = EXCLUDED.source`,
        [WS.landscapeId, WS.versionId])
      // Wants it in key share, via the constraint.
      const insert = rotation.query(
        `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
         VALUES ($1, $2, 'concurrent-doc', 'registry-shard')`,
        [WS.landscapeId, WS.versionId])
      const verdict = await Promise.race([
        insert.then(() => 'completed', (error: { code?: string }) => `error:${error.code}`),
        new Promise<string>((resolve) => setTimeout(() => resolve('BLOCKED'), 2000)),
      ])
      expect(verdict).toBe('completed')
    } finally {
      // Release WITH an error so the pool DESTROYS both connections. Asking a
      // BLOCKED client to `ROLLBACK` queues the rollback behind its own
      // in-flight query and wedges the suite — which is what a failing run of
      // this test would produce, i.e. exactly when it must not.
      remark.release(new Error('A10-i13 teardown'))
      rotation.release(new Error('A10-i13 teardown'))
    }
  })

  it('A10-i16 — the allow-list writer takes the AUTHORITY row before anything else', async () => {
    // The re-mark test above pins that a re-mark and an allow-list write do
    // not serialize; this pins the ORDER that stops the allow-list write
    // deadlocking against a DEMOTION.
    //
    // `read_model_static_documents_workspace_fk` makes the allow-list INSERT take
    // key share on the workspace row via an AFTER-ROW RI trigger — at END of
    // statement, once the allow-list rows are already locked. So without an
    // explicit lock up front the order is D → S, against the demotion's S → D.
    // Measured 18/18 deadlocks with a mixed batch (some rows inserted, some
    // updated — the production shape), 0/18 without the constraint, 0/18 with
    // the lock; and the DEMOTION was the victim every time, receiving `40P01`
    // after it had already reverted and flushed the root.
    //
    // Asserted on the STATEMENT STREAM rather than by staging 30 000 rows and a
    // real deadlock: that is this subsystem's idiom for lock order, and it is
    // deterministic and cheap enough for every CI run.
    await markStatic()
    const statements: string[] = []
    const recording = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'connect') {
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async () => {
          const client = await target.connect()
          return new Proxy(client, {
            get(clientTarget, clientProp, clientReceiver) {
              if (clientProp !== 'query') {
                const value = Reflect.get(clientTarget, clientProp, clientReceiver)
                return typeof value === 'function' ? value.bind(clientTarget) : value
              }
              return async (text: string, params?: unknown[]) => {
                if (typeof text === 'string') statements.push(text.trim().replace(/\s+/g, ' '))
                return clientTarget.query(text, params)
              }
            },
          })
        }
      },
    })

    await registerStaticReadModelDocuments(recording, WS, [
      { documentId: 'ordered-doc', kind: 'registry-shard' },
    ])

    const authority = statements.findIndex((sql) =>
      sql.includes('read_model_static_workspaces') && sql.includes('FOR KEY SHARE'))
    const claim = statements.findIndex((sql) => sql.includes('INTO automerge_document_workspace'))
    const allowList = statements.findIndex((sql) => sql.includes('INTO read_model_static_documents'))
    expect(authority).toBeGreaterThanOrEqual(0)
    expect(claim).toBeGreaterThanOrEqual(0)
    expect(allowList).toBeGreaterThanOrEqual(0)
    // S → W → D, the documented global order, and the whole point of the first.
    expect(authority).toBeLessThan(claim)
    expect(claim).toBeLessThan(allowList)
  })

  it('A10-i12 — a LEGACY orphan survives, because NOT VALID skips the back-scan', async () => {
    // The deliberate half. Validating the constraint would refuse to install it
    // on any database that already holds one of these, so `ensureReadModelSchema`
    // — which runs on every boot — would wedge the deploy. NOT VALID enforces
    // every future write and leaves the existing rows for `npm run fsck` to
    // report under `static-allow-list-orphaned`, where an operator can look at
    // them before anything is deleted.
    await asLegacyOrphan(() => addDocument('legacy-orphan'))
    const survived = await db.query(
      `SELECT count(*)::int AS n FROM read_model_static_documents WHERE document_id = 'legacy-orphan'`)
    expect(survived.rows[0].n).toBe(1)
    // …and the constraint really is back in force after the helper, so the rest
    // of this file is not running on a schema production does not have.
    await expect(addDocument('doc-after-helper')).rejects.toMatchObject({ code: '23503' })
  })

  const seedSegment = (documentId: string, isCurrent: boolean) => db.query(
    `INSERT INTO read_model_overlay_segments
       (landscape_id, version_id, collection, document_id, segment_url, is_current)
     VALUES ($1, $2, 'object', $3, 'automerge:' || $3, $4)`,
    [WS.landscapeId, WS.versionId, documentId, isCurrent])

  const retainOf = async (documentId: string) => {
    const { rows } = await db.query(
      `SELECT retain_until, retired_at, is_current FROM read_model_overlay_segments
        WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object'
          AND document_id = $3`, [WS.landscapeId, WS.versionId, documentId])
    return rows[0]
  }

  it('A10-i4 — a superseded child stops being an unbounded GC root; a CURRENT one does not', async () => {
    await seedSegment('abandoned-child', false)
    await seedSegment('live-head', true)

    // Both are reachability roots right now, and for the SAME reason — the
    // predicate `gc.ts` uses. That is correct while a rotation is in flight.
    expect((await retainOf('abandoned-child')).retain_until).toBeNull()
    expect((await retainOf('live-head')).retain_until).toBeNull()

    await releaseSupersededOverlaySegment(db, WS, 'object', 'abandoned-child')
    await releaseSupersededOverlaySegment(db, WS, 'object', 'live-head')

    const abandoned = await retainOf('abandoned-child')
    expect(abandoned.retain_until).not.toBeNull()
    expect(abandoned.retired_at).not.toBeNull()

    // THE CONTROL. `NOT is_current` is a safety, not a filter: a rotation
    // superseded by a later one that already promoted this same document must
    // keep its pin. Without this assertion the helper would be indistinguishable
    // from one that de-pins the live write head.
    expect((await retainOf('live-head')).retain_until).toBeNull()

    // What this does NOT do, said plainly: the row stays reachable for the
    // retention window. It gains an EXPIRY where it had none — expiry is the
    // only thing that ever bounds overlay storage.
    // A LITERAL 31 days, not `OVERLAY_RETENTION_DAYS + 1`. A bound derived from
    // the constant under test agrees with ANY value that constant is given.
    // The constant is pinned separately, so a deliberate change fails in one
    // obvious place rather than passing silently here.
    const { rows } = await db.query(
      `SELECT retain_until > now() AS still_reachable,
              retain_until < now() + interval '31 days' AS bounded,
              retain_until > now() + interval '29 days' AS not_shortened
         FROM read_model_overlay_segments
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = 'abandoned-child'`,
      [WS.landscapeId, WS.versionId])
    expect(rows[0]).toMatchObject({ still_reachable: true, bounded: true, not_shortened: true })
    expect(OVERLAY_RETENTION_DAYS).toBe(30)
  })

  it('A10-i5 — a second release cannot SHORTEN a window already running', async () => {
    await seedSegment('abandoned-child', false)
    await releaseSupersededOverlaySegment(db, WS, 'object', 'abandoned-child')
    const first = (await retainOf('abandoned-child')).retain_until as Date

    // One day, against the thirty above. `COALESCE` must ignore it entirely.
    await releaseSupersededOverlaySegment(db, WS, 'object', 'abandoned-child', 1)
    expect((await retainOf('abandoned-child')).retain_until).toEqual(first)
  })

  it('A10-i6 — closing a rotation for an inactive version releases its child in ONE statement', async () => {
    await markStatic()
    await seedSegment('rotation-child', false)
    await db.query(
      `INSERT INTO read_model_overlay_rotations
         (landscape_id, version_id, collection, old_document_id, new_document_id,
          new_segment_url, status)
       VALUES ($1, $2, 'object', 'old-head', 'rotation-child',
               'automerge:rotation-child', 'admitted')`,
      [WS.landscapeId, WS.versionId])

    const p = projector()
    // While the version is ACTIVE nothing is closed and nothing is released —
    // the control that makes the next assertion mean something.
    await (p as unknown as { recoverAdmittedOverlayRotations(): Promise<void> })
      .recoverAdmittedOverlayRotations()
    expect((await retainOf('rotation-child')).retain_until).toBeNull()

    // Merging or discarding a Draft is exactly this.
    await db.query(`UPDATE versions SET status = 'merged' WHERE id = $1`, [WS.versionId])
    await (p as unknown as { recoverAdmittedOverlayRotations(): Promise<void> })
      .recoverAdmittedOverlayRotations()

    const { rows } = await db.query(
      `SELECT status FROM read_model_overlay_rotations
        WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
    expect(rows[0].status).toBe('superseded')
    expect((await retainOf('rotation-child')).retain_until).not.toBeNull()
  })

  it('QA-D — the backfill correlates the DIAGRAM on both key columns, and only repairs kind=diagram', async () => {
    // The A10-i8 test covers the AUTHORITY join of this UPDATE. This one covers
    // the `ro_diagrams` join and the `kind` filter, which a fixture with one
    // landscape, one version and one diagram cannot discriminate.
    //
    // The descriptor SELECT does not join `ro_diagrams` (that join cost
    // 122 ms vs 1.5 ms without), so this UPDATE is the only writer of
    // `entity_id` for a row `projectRegistryShard` did not create — and
    // `project()` ignores a diagram descriptor whose `entityId` is null.
    const seedDiagram = (landscapeId: string, versionId: string, id: string, documentId: string) => db.query(
      `INSERT INTO ro_diagrams (landscape_id, version_id, id, data)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [landscapeId, versionId, id, JSON.stringify({ docUrl: `automerge:${documentId}` })])
    const addNullEntity = (documentId: string, kind: string) => db.query(
      `INSERT INTO read_model_static_documents
         (landscape_id, version_id, document_id, kind, entity_id)
       VALUES ($1, $2, $3, $4, NULL)`, [WS.landscapeId, WS.versionId, documentId, kind])
    const entityOf = async (documentId: string) => {
      const { rows } = await db.query(
        `SELECT entity_id FROM read_model_static_documents WHERE document_id = $1`,
        [documentId])
      return (rows[0] as { entity_id: string | null }).entity_id
    }

    await markStatic()
    await db.query(
      `INSERT INTO versions (id, landscape_id, label, status) VALUES ('version-alt', $1, 'v', 'active')`,
      [WS.landscapeId])

    // THE CONTROL — the only row that must be repaired.
    await addNullEntity('good-doc', 'diagram')
    await seedDiagram(WS.landscapeId, WS.versionId, 'good-diagram', 'good-doc')

    // DECOY 1 (kills `diagram.landscape_id = document.landscape_id`): the only
    // `ro_diagrams` row carrying this docUrl belongs to ANOTHER landscape that
    // happens to reuse the version id.
    await addNullEntity('cross-land-doc', 'diagram')
    await seedDiagram('land-other', WS.versionId, 'wrong-landscape-diagram', 'cross-land-doc')

    // DECOY 2 (kills `diagram.version_id = document.version_id`): the same
    // landscape, a sibling version — i.e. a Draft, the ordinary case.
    await addNullEntity('cross-version-doc', 'diagram')
    await seedDiagram(WS.landscapeId, 'version-alt', 'wrong-version-diagram', 'cross-version-doc')

    // DECOY 3 (kills `document.kind = 'diagram'`): an allow-list row of another
    // kind whose document id a diagram's `docUrl` points at. `entity_id` means
    // "the diagram this document IS" and is read only for `kind = 'diagram'`;
    // writing one onto an overlay row is a claim nothing else in the tree makes.
    await addNullEntity('overlay-doc', 'object-overlay')
    await seedDiagram(WS.landscapeId, WS.versionId, 'overlay-shaped-diagram', 'overlay-doc')

    const p = projector()
    await p.reloadDescriptors()

    // LIVENESS FIRST.
    expect(await entityOf('good-doc')).toBe('good-diagram')
    expect(await entityOf('cross-land-doc')).toBeNull()
    expect(await entityOf('cross-version-doc')).toBeNull()
    expect(await entityOf('overlay-doc')).toBeNull()
  })
})
