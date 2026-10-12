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
import pg from 'pg'
import { ensureReadModelSchema } from './schema.js'
import { releaseSupersededOverlaySegment } from './overlayHistoryStore.js'
import { StaticDeltaProjector } from './staticDeltaProjector.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import type { WorkspaceKey } from './projector.js'

/**
 * Static-plane retention SQL, against a real Postgres.
 *
 * Each case targets one predicate of the retention/close statements. These
 * cannot be tested with a fake: a fake answers the same thing to a statement
 * with four join predicates and to one with three.
 *
 * Its own schema, and never `<mine>,public` — see
 * `staticPlaneReconciliation.integration.test.ts` for the reason (`CREATE TABLE IF NOT EXISTS` sees the shared tables and
 * creates nothing, after which every DELETE here falls on another suite's rows).
 */
// See the sibling file: `TEST_DATABASE_URL` first, and NO fallback to a dev
// stack that this file would `DROP SCHEMA … CASCADE` against.
const URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? ''
const WS: WorkspaceKey = { landscapeId: 'land-bat', versionId: 'version-bat' }
const SCHEMA = 'test_a10_battery'

async function probe(): Promise<{ pool: pg.Pool; teardown: () => Promise<void> } | null> {
  // See the sibling file: an empty connection string is not inert.
  if (!URL) return null
  const db = {
    pool: guardIdleClientErrors(new pg.Pool({
      connectionString: URL,
      max: 2,
      connectionTimeoutMillis: 4000,
      options: `-c search_path=${SCHEMA}`,
    }), 'a10-battery'),
    teardown: async () => {
      await db.pool.end().catch(() => undefined)
      const cleanup = guardIdleClientErrors(
        new pg.Pool({ connectionString: URL, max: 1 }), 'a10-battery:cleanup')
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      } finally {
        await cleanup.end()
      }
    },
  }
  try {
    const admin = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 1 }), 'a10-battery:admin')
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    } finally {
      await admin.end()
    }
    const client = await db.pool.connect()
    try {
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
if (!pool) console.warn(`[a10-battery] no Postgres at ${URL} — skipping`)

suite('A10 battery — the predicates a fake cannot answer', () => {
  const db = pool!
  const running: StaticDeltaProjector[] = []

  afterAll(async () => {
    for (const projector of running.splice(0)) await projector.stop().catch(() => undefined)
    await isolated!.teardown().catch(() => undefined)
  })

  beforeEach(async () => {
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

  const seedSegment = (
    landscapeId: string, versionId: string, collection: 'object' | 'connection',
    documentId: string, isCurrent: boolean,
  ) => db.query(
    `INSERT INTO read_model_overlay_segments
       (landscape_id, version_id, collection, document_id, segment_url, is_current)
     VALUES ($1, $2, $3, $4, 'automerge:' || $4, $5)`,
    [landscapeId, versionId, collection, documentId, isCurrent])

  const retainOf = async (
    landscapeId: string, versionId: string, collection: 'object' | 'connection', documentId: string,
  ) => {
    const { rows } = await db.query(
      `SELECT retain_until, retired_at, is_current FROM read_model_overlay_segments
        WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND document_id = $4`,
      [landscapeId, versionId, collection, documentId])
    return rows[0] as { retain_until: Date | null; retired_at: Date | null; is_current: boolean }
  }

  it('M06/M07/M08 — the DEFAULT window is thirty days, pinned by a LITERAL', async () => {
    // Asserted against `interval '29 days'` / `'31 days'` and NOT against
    // `OVERLAY_RETENTION_DAYS`. A bound derived from the constant under test
    // agrees with every value that constant can be given.
    await seedSegment(WS.landscapeId, WS.versionId, 'object', 'abandoned', false)
    await releaseSupersededOverlaySegment(db, WS, 'object', 'abandoned')
    const { rows } = await db.query(
      `SELECT retain_until > now() + interval '29 days' AS at_least_29,
              retain_until < now() + interval '31 days' AS at_most_31
         FROM read_model_overlay_segments
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = 'abandoned'`,
      [WS.landscapeId, WS.versionId])
    expect(rows[0]).toMatchObject({ at_least_29: true, at_most_31: true })
  })

  it('M03 — a second release cannot re-stamp `retired_at` either', async () => {
    // `retain_until`'s COALESCE has its own test; `retired_at`'s is the other
    // half of one guarantee. `retired_at` is what a human reads to answer "when did
    // this stop being the head" and what any future age-based sweep would key
    // on, so a helper that moves it forward on every call makes an abandoned
    // segment look permanently fresh.
    await seedSegment(WS.landscapeId, WS.versionId, 'object', 'abandoned', false)
    await releaseSupersededOverlaySegment(db, WS, 'object', 'abandoned')
    const first = await retainOf(WS.landscapeId, WS.versionId, 'object', 'abandoned')
    expect(first.retired_at).not.toBeNull()

    // Real time has to pass, or "unchanged" would be true of a re-stamp too.
    await db.query(`SELECT pg_sleep(0.02)`)
    await releaseSupersededOverlaySegment(db, WS, 'object', 'abandoned')
    const second = await retainOf(WS.landscapeId, WS.versionId, 'object', 'abandoned')
    expect(second.retired_at).toEqual(first.retired_at)
    expect(second.retain_until).toEqual(first.retain_until)
  })

  it('M10/M11/M12/M13/M14 — the close CTE correlates on all four columns, and spares the head',
    async () => {
      // FIVE decoys, one per join predicate, each identical to the real target
      // in every column but one. A single-workspace fixture cannot tell a
      // four-column correlation from a one-column one.
      await db.query(
        `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source)
         VALUES ($1, $2, 'promotion')`, [WS.landscapeId, WS.versionId])

      // THE TARGET: an admitted object rotation whose version is no longer
      // active, and its abandoned child's segment.
      await seedSegment(WS.landscapeId, WS.versionId, 'object', 'rotation-child', false)
      await db.query(
        `INSERT INTO read_model_overlay_rotations
           (landscape_id, version_id, collection, old_document_id, new_document_id,
            new_segment_url, status)
         VALUES ($1, $2, 'object', 'old-head', 'rotation-child',
                 'automerge:rotation-child', 'admitted')`,
        [WS.landscapeId, WS.versionId])

      // DECOY 1 (kills `NOT segment.is_current`): a connection rotation whose
      // child is ALREADY the live head. A rotation superseded by a later one
      // that promoted the same document must keep its pin — de-pinning the live
      // write head is the one outcome this predicate exists to forbid.
      await seedSegment(WS.landscapeId, WS.versionId, 'connection', 'conn-live-head', true)
      await db.query(
        `INSERT INTO read_model_overlay_rotations
           (landscape_id, version_id, collection, old_document_id, new_document_id,
            new_segment_url, status)
         VALUES ($1, $2, 'connection', 'conn-old', 'conn-live-head',
                 'automerge:conn-live-head', 'admitted')`,
        [WS.landscapeId, WS.versionId])

      // DECOY 2 (kills the `collection` predicate): the SAME document id in the
      // other collection, with no rotation of its own.
      await seedSegment(WS.landscapeId, WS.versionId, 'connection', 'rotation-child', false)
      // DECOY 3 (kills the `landscape_id` predicate): a sibling landscape
      // reusing this version id.
      await seedSegment('land-other', WS.versionId, 'object', 'rotation-child', false)
      // DECOY 4 (kills the `version_id` predicate): the same landscape, another
      // version.
      await seedSegment(WS.landscapeId, 'version-other', 'object', 'rotation-child', false)
      // DECOY 5 (kills the `document_id` predicate): another retired segment of
      // the very same chain.
      await seedSegment(WS.landscapeId, WS.versionId, 'object', 'unrelated-child', false)

      // Merging or discarding a Draft is exactly this.
      await db.query(`UPDATE versions SET status = 'merged'
                       WHERE landscape_id = $1 AND id = $2`, [WS.landscapeId, WS.versionId])

      const projector = new StaticDeltaProjector(new Repo({}), db)
      running.push(projector)
      await (projector as unknown as {
        recoverAdmittedOverlayRotations(): Promise<void>
      }).recoverAdmittedOverlayRotations()

      // LIVENESS FIRST — without it every negative below is satisfied by a
      // statement that matched nothing at all.
      const { rows: statuses } = await db.query(
        `SELECT collection, status FROM read_model_overlay_rotations
          WHERE landscape_id = $1 AND version_id = $2 ORDER BY collection`,
        [WS.landscapeId, WS.versionId])
      expect(statuses).toEqual([
        { collection: 'connection', status: 'superseded' },
        { collection: 'object', status: 'superseded' },
      ])
      expect((await retainOf(WS.landscapeId, WS.versionId, 'object', 'rotation-child'))
        .retain_until).not.toBeNull()

      // …and every decoy is untouched.
      expect((await retainOf(WS.landscapeId, WS.versionId, 'connection', 'conn-live-head'))
        .retain_until).toBeNull()
      expect((await retainOf(WS.landscapeId, WS.versionId, 'connection', 'rotation-child'))
        .retain_until).toBeNull()
      expect((await retainOf('land-other', WS.versionId, 'object', 'rotation-child'))
        .retain_until).toBeNull()
      expect((await retainOf(WS.landscapeId, 'version-other', 'object', 'rotation-child'))
        .retain_until).toBeNull()
      expect((await retainOf(WS.landscapeId, WS.versionId, 'object', 'unrelated-child'))
        .retain_until).toBeNull()
    })
  /** The private close statement, driven on its own. `recoverAdmittedOverlay-
   * Rotations` is the right entry for most cases; this one is needed where the
   * test must hold a row lock, because the public entry then goes on to borrow
   * its own pooled connections and this suite's pool is `max: 2`. */
  const closeOnly = (p: StaticDeltaProjector) => (p as unknown as {
    closeInactiveAdmittedRotations(): Promise<void>
  }).closeInactiveAdmittedRotations()

  const seedVersion = (landscapeId: string, versionId: string, status: string) => db.query(
    `INSERT INTO versions (id, landscape_id, label, status) VALUES ($1, $2, 'v', $3)`,
    [versionId, landscapeId, status])

  const seedRotation = (
    landscapeId: string, versionId: string, collection: 'object' | 'connection',
    newDocumentId: string, status: 'admitted' | 'published' | 'superseded',
  ) => db.query(
    `INSERT INTO read_model_overlay_rotations
       (landscape_id, version_id, collection, old_document_id, new_document_id,
        new_segment_url, status)
     VALUES ($1, $2, $3, 'old-head', $4, 'automerge:' || $4, $5)`,
    [landscapeId, versionId, collection, newDocumentId, status])

  const statusOf = async (
    landscapeId: string, versionId: string, collection: string, newDocumentId: string,
  ) => {
    const { rows } = await db.query(
      `SELECT status FROM read_model_overlay_rotations
        WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
          AND new_document_id = $4`,
      [landscapeId, versionId, collection, newDocumentId])
    return (rows[0] as { status: string } | undefined)?.status
  }

  it('QA-A — the close CTE supersedes only rows that are themselves CANDIDATES', async () => {
    // The M10-M14 test above covers the `closed` -> `segment` half of this
    // statement. This covers the `candidates` -> `rotation` half: in that
    // fixture every rotation IS a candidate, so a correlation dropped from
    // `UPDATE ... FROM candidates` would join a candidate to a row that was
    // going to be superseded anyway. Targets: each correlation column, the
    // `status = 'admitted'` candidate predicate, and the
    // `version.landscape_id` correlation inside the NOT EXISTS.
    //
    // Every decoy below is a state production reaches: a Draft of the same
    // landscape, a sibling landscape reusing a version id, and the OTHER
    // collection's already-published rotation — whose child is the live write
    // head, which is why superseding it is not cosmetic.
    await seedVersion(WS.landscapeId, 'version-live', 'active')
    await seedVersion('land-other', WS.versionId, 'active')
    await db.query(`UPDATE versions SET status = 'merged'
                     WHERE landscape_id = $1 AND id = $2`, [WS.landscapeId, WS.versionId])

    // THE TARGET, and the only candidate anywhere in the database.
    await seedRotation(WS.landscapeId, WS.versionId, 'object', 'child-target', 'admitted')
    await seedSegment(WS.landscapeId, WS.versionId, 'object', 'child-target', false)

    // DECOY A — a sibling LANDSCAPE reusing this version id, still active.
    await seedRotation('land-other', WS.versionId, 'object', 'child-target', 'admitted')
    // DECOY B — a sibling VERSION of this landscape, still active.
    await seedRotation(WS.landscapeId, 'version-live', 'object', 'child-target', 'admitted')
    // DECOY C — the other collection of the SAME workspace, already published.
    await seedRotation(WS.landscapeId, WS.versionId, 'connection', 'child-target', 'published')
    // DECOY D — the same collection, a different child, already published.
    await seedRotation(WS.landscapeId, WS.versionId, 'object', 'child-other', 'published')

    const projector = new StaticDeltaProjector(new Repo({}), db)
    running.push(projector)
    await closeOnly(projector)

    // LIVENESS FIRST — without it every negative below is satisfied by a
    // statement that matched nothing. It doubles as the detector for the
    // `version.landscape_id` correlation inside the NOT EXISTS: without that
    // column the ACTIVE `land-other/version-bat` row satisfies the subquery and
    // the target stops being a candidate at all.
    expect(await statusOf(WS.landscapeId, WS.versionId, 'object', 'child-target'))
      .toBe('superseded')
    expect((await retainOf(WS.landscapeId, WS.versionId, 'object', 'child-target'))
      .retain_until).not.toBeNull()

    // …and no row that was not a candidate has moved.
    expect(await statusOf('land-other', WS.versionId, 'object', 'child-target')).toBe('admitted')
    expect(await statusOf(WS.landscapeId, 'version-live', 'object', 'child-target')).toBe('admitted')
    expect(await statusOf(WS.landscapeId, WS.versionId, 'connection', 'child-target')).toBe('published')
    expect(await statusOf(WS.landscapeId, WS.versionId, 'object', 'child-other')).toBe('published')
  })

  it('QA-B — a CONTENDED candidate is skipped and the pass still closes the rest', async () => {
    // `FOR UPDATE SKIP LOCKED`, not a blocking `FOR UPDATE` (nor no lock):
    // this is reached from `start()`, so a plain wait behind another pod's
    // `publishAdmittedRotation` would hold one of four connections while the
    // pod never finishes starting.
    //
    // The verdict is taken at the DEADLINE and stored, never read after the
    // holder is released: once the lock goes, a blocked statement completes and
    // the late success would erase the finding.
    await seedVersion('land-blocked', WS.versionId, 'merged')
    await db.query(`UPDATE versions SET status = 'merged'
                     WHERE landscape_id = $1 AND id = $2`, [WS.landscapeId, WS.versionId])
    await seedRotation('land-blocked', WS.versionId, 'object', 'child-blocked', 'admitted')
    await seedRotation(WS.landscapeId, WS.versionId, 'object', 'child-free', 'admitted')
    await seedSegment('land-blocked', WS.versionId, 'object', 'child-blocked', false)
    await seedSegment(WS.landscapeId, WS.versionId, 'object', 'child-free', false)

    const projector = new StaticDeltaProjector(new Repo({}), db)
    running.push(projector)

    const holder = await db.connect()
    // No initialisers on the latter two (eslint `no-useless-assignment`):
    // every path that READS them assigns first.
    let outcome: 'pending' | 'returned' | 'failed' = 'pending'
    let pass: Promise<unknown> | undefined
    let atDeadline: typeof outcome | undefined
    try {
      await holder.query('BEGIN')
      await holder.query(
        `SELECT 1 FROM read_model_overlay_rotations
          WHERE landscape_id = 'land-blocked' AND version_id = $1
            AND collection = 'object' AND new_document_id = 'child-blocked'
          FOR UPDATE`, [WS.versionId])
      pass = closeOnly(projector).then(
        () => { outcome = 'returned' }, () => { outcome = 'failed' })
      await Promise.race([pass, new Promise((resolve) => { setTimeout(resolve, 1500) })])
      atDeadline = outcome
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      holder.release()
    }
    await pass?.catch(() => undefined)

    // 1 500 ms is a give-up bound, not a performance target: the statement is
    // one indexed sweep over an empty-ish table and returns in single-digit
    // milliseconds when nothing is contended.
    expect(atDeadline).toBe('returned')
    // The contended row was SKIPPED, not merely deferred: it is still
    // `admitted` after the holder has long since rolled back.
    expect(await statusOf('land-blocked', WS.versionId, 'object', 'child-blocked'))
      .toBe('admitted')
    expect((await retainOf('land-blocked', WS.versionId, 'object', 'child-blocked'))
      .retain_until).toBeNull()
    // LIVENESS — the uncontended candidate in the same statement was closed, so
    // "it returned" is not "it matched nothing".
    expect(await statusOf(WS.landscapeId, WS.versionId, 'object', 'child-free'))
      .toBe('superseded')
    expect((await retainOf(WS.landscapeId, WS.versionId, 'object', 'child-free'))
      .retain_until).not.toBeNull()
  })

  it('QA-C — the close CTE cannot re-stamp a retention window already running', async () => {
    // The M03 and A10-i5 tests pin this for `releaseSupersededOverlaySegment`.
    // The CTE writes the same two columns with its own copy of the COALESCEs,
    // so this drives it over a segment that is already stamped.
    //
    // Reachable in production: `publishAdmittedRotation`'s abandon branches and
    // a later fold both release a child's pin while an older `admitted`
    // rotation row for the same child is still on the table. Re-stamping makes
    // an abandoned segment look permanently fresh, which is the one thing that
    // bounds overlay storage.
    await seedSegment(WS.landscapeId, WS.versionId, 'object', 'child-target', false)
    // A ONE-day window, deliberately unlike the CTE's thirty: an equality
    // assertion against a value a faulty CTE would REPLACE, not merely re-stamp.
    await releaseSupersededOverlaySegment(db, WS, 'object', 'child-target', 1)
    const first = await retainOf(WS.landscapeId, WS.versionId, 'object', 'child-target')
    expect(first.retain_until).not.toBeNull()

    await seedRotation(WS.landscapeId, WS.versionId, 'object', 'child-target', 'admitted')
    await db.query(`UPDATE versions SET status = 'discarded'
                     WHERE landscape_id = $1 AND id = $2`, [WS.landscapeId, WS.versionId])
    // Real time has to pass, or "unchanged" would be true of a re-stamp too.
    await db.query(`SELECT pg_sleep(0.02)`)

    const projector = new StaticDeltaProjector(new Repo({}), db)
    running.push(projector)
    await closeOnly(projector)

    // LIVENESS — the statement did reach this row.
    expect(await statusOf(WS.landscapeId, WS.versionId, 'object', 'child-target'))
      .toBe('superseded')
    const second = await retainOf(WS.landscapeId, WS.versionId, 'object', 'child-target')
    expect(second.retain_until).toEqual(first.retain_until)
    expect(second.retired_at).toEqual(first.retired_at)
  })
})
