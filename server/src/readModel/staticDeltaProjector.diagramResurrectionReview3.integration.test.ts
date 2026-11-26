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
 * T-DIAGDEF, the third hardening round of the static plane's diagram
 * resurrection. Each case is labelled; its tests carry the label:
 *
 *  - I2 a `CREATE INDEX CONCURRENTLY` interrupted by `lock_timeout` leaves an
 *       INVALID index: the build rebuilds it valid or reports it `deferred` —
 *       never "built" over an invalid index;
 *  - M2 migration 0008 no longer builds (the catalogue only); the background
 *       build does, once at a time across the cluster, idempotently;
 *  - M1 the durable re-open of unprojected DiagramDocs no longer runs on
 *       every ModelMeta pass — only on one that lifts a tombstone (and on the
 *       repair tick).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo, type DocHandle } from '@automerge/automerge-repo'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema, ensureStaticMembershipHeadIndex, startStaticMembershipHeadIndexBuild, STATIC_MEMBERSHIP_HEAD_INDEX } from './schema.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { StaticDeltaProjector } from './staticDeltaProjector.js'
import { schemaMigrations } from '../db/schemaMigrations.js'

const CONNECTION = process.env.TEST_DATABASE_URL
const LANDSCAPE = 'ls-diagram-review3'
const VERSION = 'v1'
const WS = { landscapeId: LANDSCAPE, versionId: VERSION }

describe.skipIf(!CONNECTION)('T-DIAGDEF third hardening round — the static plane', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let projector: StaticDeltaProjector

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'diagram_review3')
    await ensureReadModelSchema(database.pool)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      parent_version_id TEXT, kind TEXT NOT NULL DEFAULT 'version',
      status TEXT NOT NULL DEFAULT 'active', base_manifest JSONB,
      PRIMARY KEY (landscape_id, id))`)
    await database.pool.query(`CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq`)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await database.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, 'automerge:root') ON CONFLICT DO NOTHING`, [LANDSCAPE, VERSION],
    )
  })
  afterAll(async () => { await database?.teardown() })

  beforeEach(async () => {
    repo = new Repo({ network: [] })
    projector = new StaticDeltaProjector(repo, database.pool)
    for (const table of [
      'ro_diagrams', 'read_model_static_documents', 'read_model_static_membership_deltas',
      'read_model_static_document_queue', 'read_model_static_workspaces', 'read_model_projection_state',
    ]) {
      await database.pool.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [LANDSCAPE, VERSION])
    }
    await markStaticReadModelWorkspace(database.pool, WS, 'test')
  })
  afterEach(async () => { vi.restoreAllMocks(); await projector?.stop() })

  const indexState = async (): Promise<'valid' | 'invalid' | 'absent'> => {
    const { rows } = await database.pool.query<{ valid: boolean }>(
      `SELECT index.indisvalid AS valid FROM pg_index index JOIN pg_class class ON class.oid = index.indexrelid
        WHERE class.relname = $1 AND class.relnamespace = to_regnamespace($2)`,
      [STATIC_MEMBERSHIP_HEAD_INDEX, database.schema],
    )
    return !rows[0] ? 'absent' : rows[0].valid ? 'valid' : 'invalid'
  }

  // ── I2 ──────────────────────────────────────────────────────────────────
  it('I2 — a CIC interrupted by lock_timeout leaves an INVALID index: rebuilt valid, or deferred — never silent', async () => {
    const client = await database.pool.connect()
    const holder = await database.pool.connect()
    try {
      await client.query(`DROP INDEX IF EXISTS ${STATIC_MEMBERSHIP_HEAD_INDEX}`)
      // An open SNAPSHOT: a CONCURRENTLY build creates its (invalid) catalogue
      // entry, then waits for this transaction — and its `lock_timeout` cuts
      // it there, leaving the index INVALID.
      await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await holder.query('SELECT count(*) FROM ro_diagrams')
      const lines: string[] = []
      const outcome = await ensureStaticMembershipHeadIndex(client, { attempts: 2, retryMs: 10, log: (line) => lines.push(line) })
      const state = await indexState()
      expect(state === 'valid' || outcome.deferred.includes(STATIC_MEMBERSHIP_HEAD_INDEX),
        `state ${state}, deferred ${JSON.stringify(outcome.deferred)}`).toBe(true)
      if (state !== 'valid') {
        expect(outcome.valid).toBe(false)
        expect(lines.some((line) => line.includes('read_model.static_membership_index_deferred'))).toBe(true)
      }
      await holder.query('ROLLBACK')
      // Once nothing holds it, the next build ends VALID.
      const again = await ensureStaticMembershipHeadIndex(client, { attempts: 2, retryMs: 10, log: () => undefined })
      expect(again).toEqual({ deferred: [], valid: true })
      expect(await indexState()).toBe('valid')
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      holder.release()
      client.release()
    }
  }, 60_000)

  // ── M2 ──────────────────────────────────────────────────────────────────
  it('M2 — migration 0008 builds nothing (the catalogue); the background build does, once at a time', async () => {
    await database.pool.query(`DROP INDEX IF EXISTS ${STATIC_MEMBERSHIP_HEAD_INDEX}`)
    const entry = schemaMigrations(database.pool).find((migration) => migration.id === '0008-static-membership-entity-index')!
    const migrationClient = await database.pool.connect()
    try {
      await entry.run(migrationClient)
    } finally {
      migrationClient.release()
    }
    expect(await indexState()).toBe('absent')

    const lines: string[] = []
    const first = startStaticMembershipHeadIndexBuild(database.pool, { log: (line) => lines.push(line) })
    const concurrent = startStaticMembershipHeadIndexBuild(database.pool, { log: (line) => lines.push(line) })
    expect(concurrent).toBe(first) // one build per process at a time
    expect(await first).toBe('built')
    expect(await indexState()).toBe('valid')
    expect(await startStaticMembershipHeadIndexBuild(database.pool, { log: () => undefined })).toBe('already-valid')

    // Another cell building (its session holds the key): this one skips.
    await database.pool.query(`DROP INDEX IF EXISTS ${STATIC_MEMBERSHIP_HEAD_INDEX}`)
    const other = await database.pool.connect()
    try {
      await other.query(`SELECT pg_advisory_lock(hashtextextended('maplespire:read-model:static-membership-head-index', 0))`)
      expect(await startStaticMembershipHeadIndexBuild(database.pool, { log: () => undefined })).toBe('skipped')
    } finally {
      await other.query(`SELECT pg_advisory_unlock(hashtextextended('maplespire:read-model:static-membership-head-index', 0))`)
      other.release()
    }
    expect(await startStaticMembershipHeadIndexBuild(database.pool, { log: () => undefined })).toBe('built')
  }, 60_000)

  // ── M1 ──────────────────────────────────────────────────────────────────
  it('M1 — a ModelMeta pass that lifts nothing does not walk the DiagramDocs; one that lifts does', async () => {
    const meta = repo.create<{ deletedDiagramIds: string[]; groups: Record<string, never> }>({ deletedDiagramIds: ['dg-a'], groups: {} })
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: meta.documentId, kind: 'model-meta' }])
    await (projector as unknown as { reloadDescriptors(): Promise<void> }).reloadDescriptors()
    const walk = vi.spyOn(projector as unknown as { reopenUnprojectedDiagramDocuments: (...a: unknown[]) => Promise<number> }, 'reopenUnprojectedDiagramDocuments')
    // T-ZEROWM-4: the queue revision is bumped BEFORE the change, and
    // the passes the change starts settle before the direct one. This Repo has
    // no storage, so a change bumps no queue revision; and the ModelMeta is
    // listened from the first pass on (its scan attaches it). A listener pass
    // of the lift that ran before the bump found its revision projected,
    // short-circuited, and recorded the lift's fingerprint without walking —
    // then the direct pass saw `metadataUnchanged` and did not walk either
    // (1 run in 30 under load; with storage a pass flushes, and the
    // save bumps the queue, before it reads its revision: not a production
    // order). Whichever pass applies the change walks once; the other finds its
    // revision projected.
    type MetaLike = { deletedDiagramIds: string[]; groups: Record<string, never> }
    const inFlight = (projector as unknown as { inFlightRuns: Set<Promise<void>> }).inFlightRuns
    const pass = async (edit?: (m: MetaLike) => void) => {
      await database.pool.query(
        `INSERT INTO read_model_static_document_queue (landscape_id, version_id, document_id, revision, projected_revision)
         VALUES ($1, $2, $3, 1, 0)
         ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE SET revision = read_model_static_document_queue.revision + 1`,
        [LANDSCAPE, VERSION, meta.documentId],
      )
      if (edit) meta.change(edit)
      while (inFlight.size) await Promise.allSettled([...inFlight])
      await (projector as unknown as { project(d: unknown, h: DocHandle<unknown>): Promise<void> }).project(
        { ...WS, documentId: meta.documentId, kind: 'model-meta', entityId: null, orgId: null }, meta,
      )
      while (inFlight.size) await Promise.allSettled([...inFlight])
    }

    await pass() // first pass: the fact becomes known, nothing lifted
    await pass((m) => { m.deletedDiagramIds.push('dg-b') }) // a new tombstone: nothing lifted
    expect(walk).not.toHaveBeenCalled()

    await pass((m) => { m.deletedDiagramIds.splice(0, 1) }) // dg-a lifted
    expect(walk).toHaveBeenCalledTimes(1)
  })
})
