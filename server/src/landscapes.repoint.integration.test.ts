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
 * `setDefaultVersion` against live Postgres.
 *
 * The one thing here that cannot be asserted anywhere else: the statement
 * returns the default from BEFORE its own update (CTE snapshot semantics). The
 * value names the workspace whose sockets get drained, so reading it back one
 * update too late would drain the version the landscape just MOVED TO.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from './testing/isolatedSchema.js'
import type { DefaultVersionRepoint } from './syncCells/defaultVersionRepoint.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('setDefaultVersion (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let realPool: pg.Pool
  let landscapes: typeof import('./landscapes.js')
  let repointModule: typeof import('./syncCells/defaultVersionRepoint.js')
  let announced: DefaultVersionRepoint[]
  let uninstall: (() => void) | null = null

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'repoint')
    realPool = db.pool

    vi.doMock('./db.js', () => ({ pool: realPool }))
    vi.resetModules()

    const authSchema = await import('./auth/schema.js')
    const rbacSchema = await import('./rbac/schema.js')
    await authSchema.ensureAuthSchema(realPool)
    await rbacSchema.ensureRbacSchema(realPool)
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

    landscapes = await import('./landscapes.js')
    repointModule = await import('./syncCells/defaultVersionRepoint.js')
  })

  afterAll(async () => {
    uninstall?.()
    vi.doUnmock('./db.js')
    await db?.teardown()
  })

  afterEach(async () => {
    uninstall?.()
    uninstall = null
    await realPool.query('DELETE FROM versions')
    await realPool.query('DELETE FROM landscapes')
  })

  async function seed(landscapeId: string, versionIds: string[], defaultVersionId: string | null) {
    await realPool.query('INSERT INTO landscapes (id, name) VALUES ($1, $1)', [landscapeId])
    for (const versionId of versionIds) {
      await realPool.query(
        `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, $1, 'automerge:seed')`,
        [versionId, landscapeId]
      )
    }
    if (defaultVersionId !== null) {
      await realPool.query('UPDATE landscapes SET default_version_id = $2 WHERE id = $1', [
        landscapeId,
        defaultVersionId,
      ])
    }
    announced = []
    uninstall = repointModule.installDefaultVersionRepointHandler((r) => { announced.push(r) })
  }

  async function currentDefault(landscapeId: string): Promise<string | null> {
    const { rows } = await realPool.query<{ default_version_id: string | null }>(
      'SELECT default_version_id FROM landscapes WHERE id = $1',
      [landscapeId]
    )
    return rows[0]?.default_version_id ?? null
  }

  it('announces the default from BEFORE its own update', async () => {
    await seed('L_prev', ['V_one', 'V_two'], 'V_one')

    await expect(landscapes.setDefaultVersion('L_prev', 'V_two')).resolves.toBe(true)

    expect(await currentDefault('L_prev')).toBe('V_two')
    expect(announced).toEqual([
      { landscapeId: 'L_prev', previousVersionId: 'V_one', versionId: 'V_two' },
    ])
  })

  it('reports null for a landscape that never had a default', async () => {
    await seed('L_null', ['V_one'], null)

    await expect(landscapes.setDefaultVersion('L_null', 'V_one')).resolves.toBe(true)
    expect(announced).toEqual([
      { landscapeId: 'L_null', previousVersionId: null, versionId: 'V_one' },
    ])
  })

  it('reports the no-op repoint as one, rather than hiding it', async () => {
    await seed('L_same', ['V_one'], 'V_one')

    await expect(landscapes.setDefaultVersion('L_same', 'V_one')).resolves.toBe(true)
    // Equal ids: the handler's own first line turns this into nothing. Deciding
    // it HERE instead would put the rule in two places, and this is the place
    // that cannot see whether a sync server exists.
    expect(announced).toEqual([
      { landscapeId: 'L_same', previousVersionId: 'V_one', versionId: 'V_one' },
    ])
  })

  it('refuses a version from another landscape without writing or announcing', async () => {
    await realPool.query('INSERT INTO landscapes (id, name) VALUES ($1, $1)', ['L_other'])
    await realPool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ('V_alien', 'L_other', 'alien', 'automerge:seed')`
    )
    await seed('L_guard', ['V_one'], 'V_one')

    await expect(landscapes.setDefaultVersion('L_guard', 'V_alien')).resolves.toBe(false)
    expect(await currentDefault('L_guard')).toBe('V_one')
    expect(announced).toEqual([])
  })

  it('refuses an unknown version, and an unknown landscape', async () => {
    await seed('L_unknown', ['V_one'], 'V_one')

    await expect(landscapes.setDefaultVersion('L_unknown', 'V_nope')).resolves.toBe(false)
    await expect(landscapes.setDefaultVersion('L_nope', 'V_one')).resolves.toBe(false)
    expect(await currentDefault('L_unknown')).toBe('V_one')
    expect(announced).toEqual([])
  })
})
