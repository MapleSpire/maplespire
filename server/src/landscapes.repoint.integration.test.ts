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

  // `rootUrlOfVersion` is what `/api/automerge/root` resolves a CANONICAL key
  // through (`resolveWorkspaceRoot`). Its stubbed callers cannot see the SQL: a
  // query that matched nothing would send every `current` tab down the keyless
  // legacy path, and its durability witness would never be asked — silently.
  it('rootUrlOfVersion answers the root of exactly that (landscape, version)', async () => {
    await realPool.query('INSERT INTO landscapes (id, name) VALUES ($1, $1), ($2, $2)', ['L_root', 'L_root_other'])
    await realPool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES
         ('V_root_1', 'L_root', 'one', 'automerge:root-of-v1'),
         ('V_root_2', 'L_root', 'two', 'automerge:root-of-v2'),
         ('V_root_x', 'L_root_other', 'x', 'automerge:root-of-x')`
    )

    await expect(landscapes.rootUrlOfVersion({ landscapeId: 'L_root', versionId: 'V_root_1' })).resolves.toBe('automerge:root-of-v1')
    await expect(landscapes.rootUrlOfVersion({ landscapeId: 'L_root', versionId: 'V_root_2' })).resolves.toBe('automerge:root-of-v2')
    // A version of ANOTHER landscape is no root of this one.
    await expect(landscapes.rootUrlOfVersion({ landscapeId: 'L_root', versionId: 'V_root_x' })).resolves.toBeNull()
    await expect(landscapes.rootUrlOfVersion({ landscapeId: 'L_root', versionId: 'V_nope' })).resolves.toBeNull()
  })

  // The routes that disclose or read a workspace root check access on the
  // CANONICAL key (`canonicalWorkspaceKey`) first. These drive that same
  // sequence with the real SQL: a set-default landing between the check and
  // the root read, and a read that fails after (or during) the check.
  describe('a root is resolved only from the key its access was checked on', () => {
    const PRIMARY = 'automerge:primary-root'
    let workspaceGate: typeof import('./rbac/workspaceGate.js')
    let registryErrors: typeof import('./rbac/workspaceRegistryErrors.js')

    beforeAll(async () => {
      workspaceGate = await import('./rbac/workspaceGate.js')
      registryErrors = await import('./rbac/workspaceRegistryErrors.js')
    })

    async function seedRoots(landscapeId: string, defaultVersionId: string) {
      await realPool.query('INSERT INTO landscapes (id, name) VALUES ($1, $1)', [landscapeId])
      await realPool.query(
        `INSERT INTO versions (id, landscape_id, label, root_url) VALUES
           ($2, $1, 'one', 'automerge:root-of-v1'),
           ($3, $1, 'two', 'automerge:root-of-v2')`,
        [landscapeId, `${landscapeId}_V1`, `${landscapeId}_V2`],
      )
      await realPool.query('UPDATE landscapes SET default_version_id = $2 WHERE id = $1', [landscapeId, defaultVersionId])
    }

    /** A real failed read: the table the lookup needs is not there. */
    async function withTableAway<T>(table: 'landscapes' | 'versions', run: () => Promise<T>): Promise<T> {
      await realPool.query(`ALTER TABLE ${table} RENAME TO ${table}_away`)
      try {
        return await run()
      } finally {
        await realPool.query(`ALTER TABLE ${table}_away RENAME TO ${table}`)
      }
    }

    /** Console noise of the failure under test, captured inside the run. */
    async function quietly<T>(run: () => Promise<T>): Promise<T> {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        return await run()
      } finally {
        error.mockRestore()
      }
    }

    it('resolveRootUrl: a failed read THROWS for an explicit ref, and answers the fallback only for the no-params call', async () => {
      await seedRoots('L_err', 'L_err_V1')
      await withTableAway('versions', async () => {
        await expect(landscapes.resolveRootUrl('L_err', 'current', PRIMARY)).rejects.toThrow(/versions/)
        await expect(landscapes.resolveRootUrl('L_err', 'L_err_V1', PRIMARY)).rejects.toThrow(/versions/)
      })
      // The FIRST read fails here, so the no-params answer can only come from
      // the catch — a missing `default` landscape would answer it as a miss.
      await withTableAway('landscapes', async () => {
        await expect(landscapes.resolveRootUrl('L_err', 'current', PRIMARY)).rejects.toThrow(/landscapes/)
        await expect(quietly(() => landscapes.resolveRootUrl(undefined, undefined, PRIMARY))).resolves.toBe(PRIMARY)
      })
      // Control: the same calls with the table back resolve the real roots.
      await expect(landscapes.resolveRootUrl('L_err', 'current', PRIMARY)).resolves.toBe('automerge:root-of-v1')
      await expect(landscapes.resolveRootUrl('L_err', 'L_err_V2', PRIMARY)).resolves.toBe('automerge:root-of-v2')
    })

    /** The `/root` route's own dependencies, over the real registry SQL. */
    function routeDeps(overrides: Partial<Parameters<typeof landscapes.resolveWorkspaceRoot>[2]> = {}) {
      return {
        canonicalize: (ref: { landscapeId: string; versionId: string }) => workspaceGate.canonicalWorkspaceKey(realPool, ref),
        mayRead: async () => true,
        accessEnforced: false,
        ...overrides,
      }
    }

    it('canonicalWorkspaceKey: a read that FAILS throws the typed refusal — it is not "no such workspace"', async () => {
      await seedRoots('L_gate', 'L_gate_V1')
      const ref = { landscapeId: 'L_gate', versionId: 'current' }
      await withTableAway('landscapes', async () => {
        await expect(workspaceGate.canonicalWorkspaceKey(realPool, ref)).rejects.toBeInstanceOf(registryErrors.WorkspaceRegistryUnavailableError)
      })
      // Control: the same read, healthy, and a real miss.
      await expect(workspaceGate.canonicalWorkspaceKey(realPool, ref)).resolves.toEqual({ landscapeId: 'L_gate', versionId: 'L_gate_V1' })
      await expect(workspaceGate.canonicalWorkspaceKey(realPool, { landscapeId: 'L_nope', versionId: 'current' })).resolves.toBeNull()
    })

    it('/root: a set-default after the check still answers the checked version, beside its key', async () => {
      await seedRoots('L_race', 'L_race_V1')
      const ref = { landscapeId: 'L_race', versionId: 'current' }
      const checked: Array<{ landscapeId: string; versionId: string }> = []
      const answer = await landscapes.resolveWorkspaceRoot(ref, PRIMARY, routeDeps({
        mayRead: async (key) => {
          checked.push(key)
          // The set-default lands while the access check runs.
          await expect(landscapes.setDefaultVersion('L_race', 'L_race_V2')).resolves.toBe(true)
          return true
        },
      }))
      expect(checked).toEqual([{ landscapeId: 'L_race', versionId: 'L_race_V1' }])
      expect(answer).toEqual({
        kind: 'root',
        url: 'automerge:root-of-v1',
        key: { landscapeId: 'L_race', versionId: 'L_race_V1' },
      })
      // Control: the alias has really moved — reading the ref again answers v2.
      await expect(landscapes.resolveRootUrl('L_race', 'current', PRIMARY)).resolves.toBe('automerge:root-of-v2')
    })

    it('/root: a read that fails AFTER the check throws — the primary root only for no params where access is open', async () => {
      await seedRoots('L_after', 'L_after_V1')
      await seedRoots(landscapes.DEFAULT_LANDSCAPE_ID, `${landscapes.DEFAULT_LANDSCAPE_ID}_V1`)
      const ref = { landscapeId: 'L_after', versionId: 'current' }

      await withTableAway('versions', async () => {
        await expect(landscapes.resolveWorkspaceRoot(ref, PRIMARY, routeDeps())).rejects.toThrow(/versions/)
        await expect(landscapes.resolveWorkspaceRoot({}, PRIMARY, routeDeps({ accessEnforced: true })))
          .rejects.toThrow(/versions/)
        await expect(quietly(() => landscapes.resolveWorkspaceRoot({}, PRIMARY, routeDeps())))
          .resolves.toEqual({ kind: 'root', url: PRIMARY, key: null })
      })
      // Control: with the table back both resolve their own root, beside a key.
      await expect(landscapes.resolveWorkspaceRoot(ref, PRIMARY, routeDeps()))
        .resolves.toEqual({ kind: 'root', url: 'automerge:root-of-v1', key: { landscapeId: 'L_after', versionId: 'L_after_V1' } })
      await expect(landscapes.resolveWorkspaceRoot({}, PRIMARY, routeDeps())).resolves.toEqual({
        kind: 'root',
        url: 'automerge:root-of-v1',
        key: { landscapeId: landscapes.DEFAULT_LANDSCAPE_ID, versionId: `${landscapes.DEFAULT_LANDSCAPE_ID}_V1` },
      })
    })

    it('/root: a canonicalisation that cannot read is never answered as a miss, and never with an unchecked root where access is enforced', async () => {
      await seedRoots('L_canon', 'L_canon_V1')
      await seedRoots(landscapes.DEFAULT_LANDSCAPE_ID, `${landscapes.DEFAULT_LANDSCAPE_ID}_V1`)
      const ref = { landscapeId: 'L_canon', versionId: 'current' }

      await withTableAway('landscapes', async () => {
        await expect(landscapes.resolveWorkspaceRoot(ref, PRIMARY, routeDeps()))
          .rejects.toBeInstanceOf(registryErrors.WorkspaceRegistryUnavailableError)
        await expect(landscapes.resolveWorkspaceRoot({}, PRIMARY, routeDeps({ accessEnforced: true })))
          .rejects.toBeInstanceOf(registryErrors.WorkspaceRegistryUnavailableError)
        // Open access, no params: the bootable fallback, beside no key.
        await expect(quietly(() => landscapes.resolveWorkspaceRoot({}, PRIMARY, routeDeps())))
          .resolves.toEqual({ kind: 'root', url: PRIMARY, key: null })
      })
      // Control: a landscape that does not exist is a plain miss (404), and so is `?landscapeId=`.
      await expect(landscapes.resolveWorkspaceRoot({ landscapeId: 'L_nope', versionId: 'current' }, PRIMARY, routeDeps()))
        .resolves.toEqual({ kind: 'root', url: null, key: null })
      await expect(landscapes.resolveWorkspaceRoot({ landscapeId: '' }, PRIMARY, routeDeps()))
        .resolves.toEqual({ kind: 'root', url: null, key: null })
    })

    it('registry-diagram / doc-heads: a set-default after the check reads the checked version, not the new default', async () => {
      await seedRoots('L_probe', 'L_probe_V1')
      const checked: Array<{ landscapeId: string; versionId: string }> = []
      const workspace = await landscapes.readableWorkspace({ landscapeId: 'L_probe', versionId: 'current' }, {
        canonicalize: (ref) => workspaceGate.canonicalWorkspaceKey(realPool, ref),
        mayRead: async (key) => {
          checked.push(key)
          // The set-default lands after the check, before the root is read.
          await landscapes.setDefaultVersion('L_probe', 'L_probe_V2')
          return true
        },
      })
      expect(checked).toEqual([{ landscapeId: 'L_probe', versionId: 'L_probe_V1' }])
      if (workspace.kind !== 'readable') throw new Error(`expected a readable workspace, got ${workspace.kind}`)
      await expect(workspace.rootUrl()).resolves.toBe('automerge:root-of-v1')
      // Control: the alias has really moved — reading the ref again answers v2.
      await expect(landscapes.resolveRootUrl('L_probe', 'current', PRIMARY)).resolves.toBe('automerge:root-of-v2')
    })

    it('registry-diagram / doc-heads: a root read that fails after the check throws instead of answering the primary root', async () => {
      await seedRoots('L_probe_err', 'L_probe_err_V1')
      const workspace = await landscapes.readableWorkspace({ landscapeId: 'L_probe_err', versionId: 'current' }, {
        canonicalize: (ref) => workspaceGate.canonicalWorkspaceKey(realPool, ref),
        mayRead: async () => true,
      })
      if (workspace.kind !== 'readable') throw new Error(`expected a readable workspace, got ${workspace.kind}`)
      await withTableAway('versions', async () => {
        await expect(workspace.rootUrl()).rejects.toThrow(/versions/)
      })
    })

    it('registry-diagram / doc-heads: a canonicalisation that cannot read throws — it is not an "unknown" workspace', async () => {
      await seedRoots('L_probe_canon', 'L_probe_canon_V1')
      const mayRead = vi.fn(async () => true)
      await withTableAway('landscapes', async () => {
        await expect(landscapes.readableWorkspace({ landscapeId: 'L_probe_canon', versionId: 'current' }, {
          canonicalize: (ref) => workspaceGate.canonicalWorkspaceKey(realPool, ref),
          mayRead,
        })).rejects.toBeInstanceOf(registryErrors.WorkspaceRegistryUnavailableError)
      })
      expect(mayRead).not.toHaveBeenCalled()
    })
  })
})
