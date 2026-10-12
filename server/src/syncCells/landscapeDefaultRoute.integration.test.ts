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
 * THE LANDSCAPE DEFAULT READ, AGAINST A REAL POSTGRES.
 *
 * `POST /api/landscapes/:id/drafts` and `POST /api/landscapes/:id/versions`
 * are placed on the landscape's DEFAULT version — the lease the bootstrap
 * fence keys both creations on. Same discipline as
 * `mergeParentRoute.integration.test.ts`, for the same reason: every
 * middleware arm injects its own resolver, so the real statement behind that
 * seam needs its own test.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resolveLandscapeDefaultWorkspace } from './workspaceRoute.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('the landscape-default read for the two creation doors (live Postgres)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'landscape_default_route')
    await db.pool.query(`CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT)`)
  }, 60_000)

  afterAll(async () => { await db?.teardown() })

  beforeEach(async () => {
    await db.pool.query('DELETE FROM landscapes')
    await db.pool.query(`
      INSERT INTO landscapes (id, name, default_version_id) VALUES
        ('L-1', 'One', 'V-main'),
        ('L-null', 'Legacy', NULL)
    `)
  })

  it('resolves a landscape to its DEFAULT version — the workspace both creations are fenced under', async () => {
    await expect(resolveLandscapeDefaultWorkspace(db.pool, 'L-1')).resolves.toEqual({
      kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'V-main' },
    })
  })

  it('a NULL default is unresolved — never a half key that hashes the empty string somewhere', async () => {
    await expect(resolveLandscapeDefaultWorkspace(db.pool, 'L-null')).resolves.toEqual({ kind: 'unresolved' })
  })

  it('an unknown landscape is unresolved, and the router hands it back to Express', async () => {
    await expect(resolveLandscapeDefaultWorkspace(db.pool, 'nope')).resolves.toEqual({ kind: 'unresolved' })
  })

  it('a database failure REJECTS — never swallowed into a miss that runs the creation locally', async () => {
    await db.pool.query('ALTER TABLE landscapes RENAME TO landscapes_hidden')
    try {
      await expect(resolveLandscapeDefaultWorkspace(db.pool, 'L-1')).rejects.toThrow(/landscapes/)
    } finally {
      await db.pool.query('ALTER TABLE landscapes_hidden RENAME TO landscapes')
    }
    await expect(resolveLandscapeDefaultWorkspace(db.pool, 'L-1')).resolves.toMatchObject({ kind: 'workspace' })
  })
})
