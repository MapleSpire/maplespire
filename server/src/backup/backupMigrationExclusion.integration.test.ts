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

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Pool, type PoolClient } from 'pg'
import {
  createDatabaseBackup,
  createTemporaryRestoreDatabase,
  DockerPgTools,
  NativePgTools,
  type PgTools,
} from './backupRestore.js'
import { ensureBackupSchema } from './schema.js'
import { MIGRATION_ADVISORY_LOCK_KEY, runMigrations, withMigrationLock } from '../db/migrations.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { runTeardownSteps } from '../runtime/teardownSteps.js'

/**
 * The demo stack, 2026-10-12: a full `docker compose restart` left both API
 * containers unhealthy for five minutes, and they would have stayed so for the
 * dump's one-hour ceiling. Three sessions, one cycle, and Postgres could see
 * only two of its edges:
 *
 *   backup snapshot txn   holds ACCESS SHARE on every table (the inventory
 *                         counts rows), waits on its CLIENT for pg_dump;
 *   boot migration        `0001-baseline` is repeatable, so every boot runs
 *                         `ALTER TABLE theme_plugins ADD COLUMN IF NOT EXISTS`
 *                         — ACCESS EXCLUSIVE, queued behind the snapshot txn;
 *   pg_dump               `LOCK TABLE … IN ACCESS SHARE MODE`, queued behind
 *                         the waiting ALTER.
 *
 * The last edge runs through the backup process, so the deadlock detector never
 * fires. Everything reading `theme_plugins` queued behind the ALTER too.
 *
 * The fixes: a backup holds the migration advisory key shared, so migrations
 * and boot DDL (`withMigrationLock`) wait for it on the key; and pg_dump
 * bounds its lock wait for any DDL that takes no key and can close the same
 * cycle.
 */

const TEST_DATABASE_URL = process.env.BACKUP_RESTORE_TEST_DATABASE_URL
const TEST_CONTAINER = process.env.BACKUP_RESTORE_TEST_PG_CONTAINER

/** How long a test lets a backup run before calling it hung. The pre-fix
 * behaviour is a hang, so without this the red arm is a vitest timeout with no
 * assertion named. */
const HANG_CEILING_MS = 30_000

type LockWait = { waitEventType: string | null; waitEvent: string | null }

async function waitForLockWait(admin: Pool, database: string, applicationName: string): Promise<LockWait> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const { rows } = await admin.query<{ wait_event_type: string | null; wait_event: string | null }>(
      `SELECT wait_event_type, wait_event FROM pg_stat_activity
        WHERE application_name = $1 AND datname = $2 AND wait_event_type = 'Lock'`,
      [applicationName, database],
    )
    if (rows[0]) return { waitEventType: rows[0].wait_event_type, waitEvent: rows[0].wait_event }
    if (Date.now() > deadline) throw new Error(`${applicationName} never waited on a lock`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Advisory locks on the migration key, asked from an independent connection:
 * a session-level advisory lock is re-entrant, so the holder's own connection
 * cannot tell "released" from "still mine". */
async function migrationKeyHolders(admin: Pool, database: string): Promise<Array<{ mode: string; granted: boolean }>> {
  const { rows } = await admin.query<{ mode: string; granted: boolean }>(
    `SELECT l.mode, l.granted FROM pg_locks l JOIN pg_database d ON d.oid = l.database
      WHERE l.locktype = 'advisory' AND d.datname = $1
        AND ((l.classid::bigint << 32) | l.objid::bigint) = $2::bigint`,
    [database, String(MIGRATION_ADVISORY_LOCK_KEY)],
  )
  return rows
}

function withCeiling<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} still pending after ${HANG_CEILING_MS} ms`)), HANG_CEILING_MS)
  })
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer))
}

describe.skipIf(!TEST_DATABASE_URL)('a backup and a boot migration cannot deadlock', () => {
  let source: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let admin: Pool
  let migrationPool: Pool
  let ddlPool: Pool
  let temporaryDirectory: string
  let assetDirectory: string
  let tools: PgTools

  beforeAll(async () => {
    source = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'maplespire-backup-migration-'))
    assetDirectory = join(temporaryDirectory, 'assets')
    // Every pool here sits on a database afterAll drops WITH (FORCE).
    admin = guardIdleClientErrors(
      new Pool({ connectionString: source.url, max: 2, application_name: 'backupMigration:admin' }),
      'backupMigration:admin',
    )
    migrationPool = guardIdleClientErrors(
      new Pool({ connectionString: source.url, max: 1, application_name: 'migration-under-test' }),
      'backupMigration:migration',
    )
    ddlPool = guardIdleClientErrors(
      new Pool({ connectionString: source.url, max: 1, application_name: 'runtime-ddl-under-test' }),
      'backupMigration:ddl',
    )
    tools = TEST_CONTAINER ? new DockerPgTools(TEST_CONTAINER) : new NativePgTools()
    await admin.query(`
      CREATE TABLE automerge_storage (key TEXT PRIMARY KEY, data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE versions (id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, root_url TEXT NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE automerge_document_workspace (document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL,
        version_id TEXT NOT NULL);
      CREATE TABLE technology_assets (org_id TEXT NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL,
        content_type TEXT NOT NULL, bytes INTEGER NOT NULL, reference_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (org_id, sha256));
      CREATE TABLE technology_revisions (technology_id TEXT NOT NULL, revision INTEGER NOT NULL,
        icon_light_path TEXT, icon_dark_path TEXT, PRIMARY KEY (technology_id, revision));
      CREATE TABLE theme_plugins (id TEXT PRIMARY KEY);
      INSERT INTO theme_plugins (id) VALUES ('studio');
    `)
    await ensureBackupSchema(admin)
  })

  afterEach(async () => {
    // A red arm leaves a hung pg_dump, a queued ALTER or a snapshot transaction
    // behind, and the next test would inherit its locks and fail for the wrong
    // reason. A green arm leaves nothing, so this terminates nothing there.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid() AND application_name <> 'backupMigration:admin'
          AND (state <> 'idle' OR application_name IN ('migration-under-test', 'runtime-ddl-under-test'))`,
      [source.database],
    )
  })

  afterAll(async () => {
    await runTeardownSteps(
      [
        {
          name: 'pools + source database',
          run: async () => {
            // DROP … WITH (FORCE) terminates a hung pg_dump or a queued ALTER
            // left behind by a red arm, so the drop comes before the pools.
            await source?.drop()
            await Promise.allSettled([admin?.end(), migrationPool?.end(), ddlPool?.end()])
          },
        },
        {
          name: 'temporary directory',
          run: async () => {
            if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
          },
        },
      ],
      { stepTimeoutMs: 90_000, label: 'backup/migration exclusion teardown' },
    )
  }, 240_000)

  it('a boot migration arriving mid-backup waits on the advisory key, then both finish', async () => {
    const addColumn = {
      id: '0001-baseline',
      repeatable: true,
      run: async (client: PoolClient) => {
        await client.query('ALTER TABLE theme_plugins ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0')
      },
    }
    let migration: Promise<unknown> | null = null
    let migrationWait: LockWait | null = null
    let holdersDuringDump: Array<{ mode: string; granted: boolean }> = []
    const order: string[] = []

    const observed: PgTools = {
      ...tools,
      dump: async (dumpOptions) => {
        // The demo's interleaving, forced: the snapshot transaction has read
        // every table and the migration arrives before pg_dump takes its locks.
        migration = runMigrations(migrationPool, [addColumn], { log: () => undefined })
          .then((outcome) => { order.push('migration'); return outcome })
        migrationWait = await waitForLockWait(admin, source.database, 'migration-under-test')
        holdersDuringDump = await migrationKeyHolders(admin, source.database)
        await tools.dump(dumpOptions)
        order.push('dump')
      },
    }

    const manifest = await withCeiling(createDatabaseBackup({
      databaseUrl: source.url,
      bundleDirectory: join(temporaryDirectory, 'during-migration'),
      pgTools: observed,
      assetDirectory,
      ownerKind: 'drill',
    }), 'backup')

    // The migration waited on the KEY, before any DDL — not on a relation,
    // which is the queued ALTER every reader of the table then lines up behind.
    expect(migrationWait).toEqual({ waitEventType: 'Lock', waitEvent: 'advisory' })
    // The backup really held the key (shared, granted) while the migration
    // queued on it (exclusive, not granted). Control for the zero below.
    expect(holdersDuringDump).toEqual(expect.arrayContaining([
      { mode: 'ShareLock', granted: true },
      { mode: 'ExclusiveLock', granted: false },
    ]))

    expect(manifest.tables.theme_plugins?.rowCount).toBe(1)
    await withCeiling(migration!, 'migration')
    expect(order).toEqual(['dump', 'migration'])
    const { rows } = await admin.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'theme_plugins' AND column_name = 'price'`,
    )
    expect(rows).toHaveLength(1)
    // And nobody is left on the key: the backup let go of its shared hold.
    expect(await migrationKeyHolders(admin, source.database)).toEqual([])
  }, 120_000)

  it('a backup that starts during a migration waits for it, and can be aborted while it waits', async () => {
    const holder = await admin.connect()
    let dumped = false
    const observed: PgTools = {
      ...tools,
      dump: async (dumpOptions) => { dumped = true; await tools.dump(dumpOptions) },
    }
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY])

      // Abort while waiting: rejected promptly, nothing dumped, no partial left.
      const controller = new AbortController()
      const aborted = createDatabaseBackup({
        databaseUrl: source.url,
        bundleDirectory: join(temporaryDirectory, 'aborted-while-waiting'),
        pgTools: observed,
        assetDirectory,
        signal: controller.signal,
      })
      await new Promise((resolve) => setTimeout(resolve, 500))
      controller.abort(new Error('drill stopped'))
      await expect(withCeiling(aborted, 'aborted backup')).rejects.toThrow('drill stopped')
      expect(dumped).toBe(false)
      expect((await readdir(temporaryDirectory)).filter((name) => name.startsWith('aborted-while-waiting'))).toEqual([])

      // Waits while the migration holds the key...
      const waiting = createDatabaseBackup({
        databaseUrl: source.url,
        bundleDirectory: join(temporaryDirectory, 'after-migration'),
        pgTools: observed,
        assetDirectory,
      })
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(dumped).toBe(false)

      // ...and its snapshot comes AFTER what the migration committed. Taken at
      // the first poll instead, it would miss this row while the backup still
      // reported the key as respected.
      await holder.query(`INSERT INTO theme_plugins (id) VALUES ('committed-under-the-key')`)
      const { rows: [committed] } = await admin.query<{ n: string }>('SELECT count(*)::text AS n FROM theme_plugins')
      await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY])
      const manifest = await withCeiling(waiting, 'backup after migration')
      expect(dumped).toBe(true)
      expect(manifest.tables.theme_plugins?.rowCount).toBe(Number(committed!.n))
      expect(await migrationKeyHolders(admin, source.database)).toEqual([])
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()').catch(() => undefined)
      holder.release()
    }
  }, 120_000)

  it('boot DDL run through withMigrationLock waits for an in-flight backup on the key', async () => {
    // ensureRbacSchema, ensureAiSchema, the technology catalog and the GC
    // worker's initSchema all run DDL after the migrations, at boot.
    let ddl: Promise<unknown> | null = null
    let ddlWait: LockWait | null = null
    const order: string[] = []
    const observed: PgTools = {
      ...tools,
      dump: async (dumpOptions) => {
        ddl = withMigrationLock(migrationPool, (client) =>
          client.query('ALTER TABLE theme_plugins ADD COLUMN IF NOT EXISTS boot_note TEXT'))
          .then(() => { order.push('ddl') })
        ddlWait = await waitForLockWait(admin, source.database, 'migration-under-test')
        await tools.dump(dumpOptions)
        order.push('dump')
      },
    }

    await withCeiling(createDatabaseBackup({
      databaseUrl: source.url,
      bundleDirectory: join(temporaryDirectory, 'boot-ddl'),
      pgTools: observed,
      assetDirectory,
    }), 'backup during boot DDL')
    await withCeiling(ddl!, 'boot DDL')

    expect(ddlWait).toEqual({ waitEventType: 'Lock', waitEvent: 'advisory' })
    expect(order).toEqual(['dump', 'ddl'])
    expect(await migrationKeyHolders(admin, source.database)).toEqual([])
  }, 120_000)

  it('DDL that takes no migration key makes pg_dump give up, instead of hanging the table', async () => {
    let ddl: Promise<unknown> | null = null
    let ddlWait: LockWait | null = null
    const observed: PgTools = {
      ...tools,
      dump: async (dumpOptions) => {
        // Runtime DDL takes no migration key, so the exclusion above cannot
        // see it; only pg_dump's own lock wait can be bounded.
        ddl = ddlPool.query('ALTER TABLE theme_plugins ADD COLUMN IF NOT EXISTS runtime_note TEXT')
        ddlWait = await waitForLockWait(admin, source.database, 'runtime-ddl-under-test')
        await tools.dump(dumpOptions)
      },
    }

    const startedAt = Date.now()
    await expect(withCeiling(createDatabaseBackup({
      databaseUrl: source.url,
      bundleDirectory: join(temporaryDirectory, 'runtime-ddl'),
      pgTools: observed,
      assetDirectory,
      dumpLockWaitTimeoutMs: 1_500,
    }), 'backup under runtime DDL')).rejects.toThrow(/canceling statement due to statement timeout/)
    // (pg_dump implements --lock-wait-timeout as a statement_timeout around its
    // LOCK TABLE, hence the wording — measured on pg_dump 16.)
    const elapsedMs = Date.now() - startedAt

    expect(ddlWait).toEqual({ waitEventType: 'Lock', waitEvent: 'relation' })
    expect(elapsedMs).toBeLessThan(HANG_CEILING_MS)
    // The snapshot transaction rolled back, so the DDL went through.
    await withCeiling(ddl!, 'runtime DDL')
    const { rows } = await admin.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'theme_plugins' AND column_name = 'runtime_note'`,
    )
    expect(rows).toHaveLength(1)
    expect((await readdir(temporaryDirectory)).filter((name) => name.startsWith('runtime-ddl'))).toEqual([])
  }, 120_000)
})
