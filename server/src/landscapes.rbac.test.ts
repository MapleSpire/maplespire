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

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from './testing/isolatedSchema.js'

/**
 * Integration test: `deleteLandscape`/
 * `deleteVersion` soft-delete their matching RBAC scope row(s) as a
 * best-effort companion to the real delete. Landscape delete soft-deletes its landscape scope AND every
 * version scope under it; version delete soft-deletes just its own version
 * scope.
 *
 * `landscapes.ts` imports `pool` from `./db.js` directly (not injected), so
 * this file mocks `./db.js` to the real test pool — same technique
 * `rbac/orgRoutes.test.ts` uses for its live-Postgres tier. Fixture rows are
 * inserted directly into `landscapes`/`versions` (bypassing `createLandscape`,
 * which needs a real Automerge `Repo`) since `root_url` has no FK — any
 * opaque string is a valid fixture value here.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

function rid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('base64url')}`
}

describe.skipIf(!TEST_DATABASE_URL)('landscapes.ts: RBAC scope soft-delete on delete (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let realPool: pg.Pool
  let deleteLandscape: typeof import('./landscapes.js').deleteLandscape
  let deleteVersion: typeof import('./landscapes.js').deleteVersion
  let upsertVersionScope: typeof import('./rbac/schema.js').upsertVersionScope
  let ensureDefaultOrg: typeof import('./auth/schema.js').ensureDefaultOrg

  beforeAll(async () => {
    // Isolated schema: `ensureDefaultOrg` below creates a default org INSIDE
    // this suite's throwaway schema — the shared database's real default org
    // is unreachable from here (search_path excludes public).
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'landscapes_rbac')
    realPool = db.pool

    vi.doMock('./db.js', () => ({ pool: realPool }))
    vi.resetModules()

    const authSchema = await import('./auth/schema.js')
    const rbacSchema = await import('./rbac/schema.js')
    await authSchema.ensureAuthSchema(realPool)
    await rbacSchema.ensureRbacSchema(realPool)
    // landscapes/versions tables live in db.ts's initSchema, not
    // auth/rbac schema — create them directly here (same DDL, idempotent)
    // rather than running the whole server's initSchema (which also touches
    // unrelated tables like automerge storage).
    await realPool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        default_version_id TEXT,
        org_id             TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await realPool.query(`
      CREATE TABLE IF NOT EXISTS versions (
        id                TEXT PRIMARY KEY,
        landscape_id      TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label             TEXT NOT NULL,
        root_url          TEXT NOT NULL,
        parent_version_id TEXT,
        kind              TEXT NOT NULL DEFAULT 'version',
        status            TEXT NOT NULL DEFAULT 'active',
        base_manifest     JSONB,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // deleteLandscape also removes the landscape's share links (V0-03), so it
    // needs db.ts's base shared_links table (ensureShareSchema adds the rest).
    await realPool.query(`
      CREATE TABLE IF NOT EXISTS shared_links (
        token TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'latest', scope TEXT NOT NULL DEFAULT 'diagram',
        diagram_id TEXT, limit_to_diagram BOOLEAN NOT NULL DEFAULT true, enabled BOOLEAN NOT NULL DEFAULT true,
        checkpoint_id TEXT, checkpoint_label TEXT, heads JSONB, snapshot JSONB NOT NULL,
        view_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ
      )
    `)

    ;({ deleteLandscape, deleteVersion } = await import('./landscapes.js'))
    ;({ upsertVersionScope } = await import('./rbac/schema.js'))
    ;({ ensureDefaultOrg } = await import('./auth/schema.js'))
  })

  afterAll(async () => {
    await db?.teardown()
    vi.doUnmock('./db.js')
    vi.resetModules()
  })

  /** A landscape with TWO versions (so deleting one non-default version is
   * legal — landscapes.ts refuses deleting the default version or the last
   * remaining one) plus registered RBAC scope rows for both. */
  async function makeLandscapeWithTwoVersions(): Promise<{ landscapeId: string; defaultVersionId: string; extraVersionId: string }> {
    const landscapeId = rid('landscape')
    const defaultVersionId = rid('version')
    const extraVersionId = rid('version')

    await realPool.query(`INSERT INTO landscapes (id, name, default_version_id) VALUES ($1, $2, $3)`, [
      landscapeId,
      `Test ${landscapeId}`,
      defaultVersionId,
    ])
    await realPool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)`, [
      defaultVersionId,
      landscapeId,
      `automerge:fixture-${defaultVersionId}`,
    ])
    await realPool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Extra', $3)`, [
      extraVersionId,
      landscapeId,
      `automerge:fixture-${extraVersionId}`,
    ])

    const orgId = await ensureDefaultOrg(realPool)
    await upsertVersionScope(realPool, orgId, landscapeId, defaultVersionId)
    await upsertVersionScope(realPool, orgId, landscapeId, extraVersionId)

    return { landscapeId, defaultVersionId, extraVersionId }
  }

  async function scopeDeletedAt(kind: string, landscapeId: string, versionId?: string): Promise<Date | null> {
    const orgId = await ensureDefaultOrg(realPool)
    const params: unknown[] = [orgId, kind, landscapeId]
    let sql = `SELECT deleted_at FROM scopes WHERE org_id = $1 AND kind = $2 AND landscape_id = $3`
    if (versionId !== undefined) {
      params.push(versionId)
      sql += ` AND version_id = $4`
    } else {
      sql += ` AND version_id IS NULL`
    }
    const { rows } = await realPool.query<{ deleted_at: string | null }>(sql, params)
    return rows[0]?.deleted_at ? new Date(rows[0].deleted_at) : null
  }

  it('deleting a non-default version soft-deletes only that version scope', async () => {
    const { landscapeId, extraVersionId } = await makeLandscapeWithTwoVersions()
    try {
      const result = await deleteVersion(landscapeId, extraVersionId)
      expect(result.ok).toBe(true)

      const extraScopeDeletedAt = await scopeDeletedAt('version', landscapeId, extraVersionId)
      expect(extraScopeDeletedAt).not.toBeNull()

      const landscapeScopeDeletedAt = await scopeDeletedAt('landscape', landscapeId)
      expect(landscapeScopeDeletedAt).toBeNull()
    } finally {
      await realPool.query('DELETE FROM landscapes WHERE id = $1', [landscapeId])
    }
  })

  it('deleting a landscape soft-deletes the landscape scope AND every version scope under it', async () => {
    // deleteLandscape refuses to delete the ONLY landscape in the DB — seed a
    // second throwaway landscape first so the count check passes regardless
    // of what else exists in this test database.
    const decoyId = rid('decoy-landscape')
    await realPool.query(`INSERT INTO landscapes (id, name) VALUES ($1, $2)`, [decoyId, 'Decoy'])

    const { landscapeId, defaultVersionId, extraVersionId } = await makeLandscapeWithTwoVersions()
    try {
      const result = await deleteLandscape(landscapeId)
      expect(result.ok).toBe(true)

      const landscapeScopeDeletedAt = await scopeDeletedAt('landscape', landscapeId)
      expect(landscapeScopeDeletedAt).not.toBeNull()

      const defaultVersionScopeDeletedAt = await scopeDeletedAt('version', landscapeId, defaultVersionId)
      expect(defaultVersionScopeDeletedAt).not.toBeNull()

      const extraVersionScopeDeletedAt = await scopeDeletedAt('version', landscapeId, extraVersionId)
      expect(extraVersionScopeDeletedAt).not.toBeNull()
    } finally {
      // deleteLandscape's own DELETE already removed the landscapes row
      // (CASCADE took its versions); only the decoy remains to clean up.
      await realPool.query('DELETE FROM landscapes WHERE id = $1', [decoyId])
    }
  })

  it('a deleted version takes its epoch DISCARD EXPORTS, OVERRIDE rows, forward writes and journals with it; a deleted landscape, all of them', async () => {
    const { ensureModelEpochSchema } = await import('./readModel/modelEpochStore.js')
    await ensureModelEpochSchema(realPool)
    // One row of EACH user-content epoch table per version.
    const discard = async (journal: string, landscapeId: string, versionId: string) => {
      await realPool.query(
        `INSERT INTO read_model_model_epoch_discards (journal_id, landscape_id, version_id, source_document_id, payload)
         VALUES ($1, $2, $3, 'src', '{}'::jsonb)`, [journal, landscapeId, versionId])
      await realPool.query(
        `INSERT INTO read_model_model_epoch_overrides (id, landscape_id, version_id, journal_id, source_doc, target_doc, entity_kind,
           entity_id, path, reason, late_value, current_value_at_forward, current_heads_at_forward, late_actors)
         VALUES ($1, $2, $3, $1, 'src', 'tgt', 'object', 'o', '["objects","o","name"]'::jsonb, 'leaf', '"Marie"'::jsonb, '"Paul"'::jsonb, '{}', '{}')`,
        [journal, landscapeId, versionId])
      await realPool.query(
        `INSERT INTO read_model_model_epoch_forward_writes (journal_id, target_document_id, landscape_id, version_id, message, change_hash, heads_before)
         VALUES ($1, 'tgt', $2, $3, 'm', 'h', '{}')`, [journal, landscapeId, versionId])
      await realPool.query(
        `INSERT INTO read_model_model_epoch_forwards (id, landscape_id, version_id, source_document_id, from_heads, to_heads, owner_instance)
         VALUES ($1, $2, $3, $1, '{}', '{}', 'cell')`, [journal, landscapeId, versionId])
    }
    const tables = ['read_model_model_epoch_discards', 'read_model_model_epoch_overrides', 'read_model_model_epoch_forward_writes', 'read_model_model_epoch_forwards']
    const journals = async (landscapeId: string) => {
      const out: string[] = []
      for (const table of tables) {
        const column = table === 'read_model_model_epoch_overrides' || table === 'read_model_model_epoch_forwards' ? 'id' : 'journal_id'
        const { rows } = await realPool.query<{ j: string }>(`SELECT ${column} AS j FROM ${table} WHERE landscape_id = $1 ORDER BY 1`, [landscapeId])
        out.push(...rows.map((r) => `${table.replace('read_model_model_epoch_', '')}:${r.j}`))
      }
      return out
    }
    const decoyId = rid('decoy-landscape')
    await realPool.query(`INSERT INTO landscapes (id, name) VALUES ($1, $2)`, [decoyId, 'Decoy'])
    const { landscapeId, defaultVersionId, extraVersionId } = await makeLandscapeWithTwoVersions()
    try {
      await discard(`${landscapeId}-a`, landscapeId, defaultVersionId)
      await discard(`${landscapeId}-b`, landscapeId, extraVersionId)
      expect((await deleteVersion(landscapeId, extraVersionId)).ok).toBe(true)
      expect(await journals(landscapeId)).toEqual(['discards', 'overrides', 'forward_writes', 'forwards'].map((t) => `${t}:${landscapeId}-a`))
      expect((await deleteLandscape(landscapeId)).ok).toBe(true)
      expect(await journals(landscapeId)).toEqual([])
    } finally {
      await realPool.query('DELETE FROM landscapes WHERE id = ANY($1::text[])', [[decoyId, landscapeId]])
    }
  })

  it('a delete that fails validation (e.g. deleting the default version) leaves scopes untouched', async () => {
    const { landscapeId, defaultVersionId } = await makeLandscapeWithTwoVersions()
    try {
      const result = await deleteVersion(landscapeId, defaultVersionId)
      expect(result.ok).toBe(false)

      const defaultVersionScopeDeletedAt = await scopeDeletedAt('version', landscapeId, defaultVersionId)
      expect(defaultVersionScopeDeletedAt).toBeNull()
    } finally {
      await realPool.query('DELETE FROM landscapes WHERE id = $1', [landscapeId])
    }
  })
})
