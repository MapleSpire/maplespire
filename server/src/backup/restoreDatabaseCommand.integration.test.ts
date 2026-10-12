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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Pool } from 'pg'
import {
  createDatabaseBackup,
  createTemporaryRestoreDatabase,
  DockerPgTools,
  NativePgTools,
  restoreAndVerifyDatabase,
  type PgTools,
} from './backupRestore.js'
import { ensureBackupSchema } from './schema.js'
import { ensureSyncCellOwnershipSchema } from '../syncCells/ownership.js'
import { ensureSyncTopologyContractSchema } from '../syncCells/topologyMirror.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

const TEST_DATABASE_URL = process.env.BACKUP_RESTORE_TEST_DATABASE_URL
const TEST_CONTAINER = process.env.BACKUP_RESTORE_TEST_PG_CONTAINER

/**
 * `restore:database` releases the routing claims it just restored.
 *
 * ── WHY THIS DRIVES THE SCRIPT AS A SUBPROCESS ──────────────────────────────
 *
 * The property is that `server/scripts/restore-database.ts` CALLS the reset.
 * Calling `resetSyncCellOwnershipClaims` from a test proves the reset works and
 * says nothing about who calls it, and reading the source for the call is not
 * a test. So: the real script, through tsx, with the real environment
 * variables, against real databases and a real `pg_dump`/`pg_restore`. It is
 * the only harness that fails when the call is removed.
 *
 * `npx` is deliberately not used: `spawnSync('npx.cmd', …)` can return EINVAL
 * on Windows, which would score every arm as a pass-shaped non-run.
 * `process.execPath` plus the resolved CLI entry has no such hole.
 *
 * ── THIS SUITE'S "IT REALLY RAN" WITNESS IS NOT IN THIS FILE ────────────────
 *
 * An assertion inside the `describe.skipIf` cannot witness the skip condition.
 * The witness is `scripts/check-test-skips.mjs` against this file's
 * `requiresEnv` entry in `test-skip-allowlist.json`: with
 * `BACKUP_RESTORE_TEST_DATABASE_URL` set, a skipped file is an ERROR.
 *
 * ── THE FIXTURE IS STAMPED PER RUN, AND THAT IS THE POINT ───────────────────
 *
 * A script that printed literal counts equal to a fixed fixture's values would
 * pass a fixed fixture. So the cell ids and the number of already-released
 * rows are stamped from a per-run identifier that no literal in
 * `restore-database.ts` can match. The stamp is printed in every failure
 * message, so a red run is still reproducible.
 *
 * The three counts are also kept PAIRWISE DIFFERENT (3 live, 2-4 released, 1
 * future-expiry), so transposing two of them is caught — notably
 * `recentlyAcquiredClaims`, the number printed BECAUSE `force` silenced the
 * refusal.
 */
describe.skipIf(!TEST_DATABASE_URL)('restore:database releases the routing claims it restored', () => {
  let source: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let scriptTarget: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let libraryTarget: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let schemalessTarget: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let refusingTarget: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let sourcePool: Pool
  let scriptTargetPool: Pool
  let libraryTargetPool: Pool
  let temporaryDirectory: string
  let bundleDirectory: string
  let schemalessBundleDirectory: string
  let refusingBundleDirectory: string
  let missingDependencyBundleDirectory: string
  let preMirrorBundleDirectory: string
  let emptyCwd: string
  let assetTarget: string
  let tools: PgTools

  /** Per-run stamp. Everything the script could hard-code is derived from it. */
  const RUN = randomUUID().replaceAll('-', '').slice(0, 8)
  /**
   * 2 or 4, from the stamp: deterministic given RUN, unguessable without it.
   *
   * Never 3, which is the number of LIVE rows: that would collapse
   * `alreadyReleased` onto `claimsReleased` and stop the suite discriminating a
   * transposition. The fixture guard in arm 1 checks this.
   */
  const RELEASED_ROWS = 2 + 2 * (Number.parseInt(RUN.slice(0, 1), 16) % 2)
  const ALPHA = `cell-alpha-${RUN}`
  const ZETA = `cell-zeta-${RUN}`

  const HUGE_LOWER = '9007199254740992'
  const HUGE_UPPER = '9007199254740993'
  const MIRROR_VALUE = `restore-${RUN}.ce1461953e2b8ac2|1`
  const mirror = async (pool: Pool) => (await pool.query(
    'SELECT value, written_by, written_at::text AS written_at FROM sync_topology_contract',
  )).rows

  interface Workspace {
    landscapeId: string
    versionId: string
    cellId: string
    token: string
    released?: boolean
    expiryInTheFuture?: boolean
  }

  /**
   * Deliberately the shape `restoreRoutingReset.integration.test.ts` uses, for
   * the same reasons — the two largest tokens are the same `double` so a
   * `Number()` comparison cannot order them, the maximum sits on an
   * already-released row so a survey narrowed to live rows reports the wrong
   * one, and `cell-zeta…` is met BEFORE `cell-alpha…` so dedup and sort are
   * exercised rather than accidentally satisfied.
   *
   * Exactly one row carries a FUTURE observed expiry, and it is seeded BEFORE
   * the dump. That is what makes this suite a test of the `force` arbitration
   * rather than of the happy path: a dump CAN carry a future expiry, so a reset
   * that did not force would be refused here. Drop `force: true` and arm 1
   * goes red on the exit code.
   */
  const WORKSPACES: Workspace[] = [
    { landscapeId: 'landscape-1', versionId: 'version-a', cellId: ZETA, token: '39', expiryInTheFuture: true },
    { landscapeId: 'landscape-1', versionId: 'version-b', cellId: ALPHA, token: '41' },
    { landscapeId: 'landscape-1', versionId: 'version-c', cellId: ZETA, token: HUGE_LOWER },
    { landscapeId: 'landscape-2', versionId: 'version-d', cellId: ALPHA, token: HUGE_UPPER, released: true },
    ...Array.from({ length: RELEASED_ROWS - 1 }, (unused, index) => ({
      landscapeId: 'landscape-2',
      versionId: `version-r${index}`,
      cellId: `cell-retired-${index}-${RUN}`,
      token: String(100 + index),
      released: true,
    })),
  ]

  const SCRIPT = fileURLToPath(new URL('../../scripts/restore-database.ts', import.meta.url))
  const TSX = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url))

  interface ScriptRun {
    status: number | null
    /** `spawnSync`'s own failure — ENOENT, or the ceiling being hit. Carried
     *  separately because ENOENT leaves `status` null and both streams empty,
     *  which otherwise reads as a script that ran and said nothing. (On a
     *  TIMEOUT `spawnSync` sets this AND returns whatever it captured.) */
    spawnError: string | null
    stdout: string
    stderr: string
    /** Every JSON object the script printed, on either stream. NOT in emission
     *  order across streams — the two are concatenated, so a stderr line printed
     *  first lands last. Nothing here asserts ordering; if something ever needs
     *  to, it needs a different collector. */
    events: Record<string, unknown>[]
  }

  function runRestoreScript(options: {
    sourceDatabaseUrl: string
    targetDatabaseUrl: string
    bundle: string
  }): ScriptRun {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: options.sourceDatabaseUrl,
      RESTORE_DATABASE_URL: options.targetDatabaseUrl,
      BACKUP_DIRECTORY: options.bundle,
    }
    // Set or REMOVED, never left to whatever the ambient run exported: with
    // `BACKUP_POSTGRES_CONTAINER` inherited from `ci:local` but no container
    // here, the script would pick Docker tools while this suite expects native
    // ones, and the failure would read as a restore bug.
    if (TEST_CONTAINER) env.BACKUP_POSTGRES_CONTAINER = TEST_CONTAINER
    else delete env.BACKUP_POSTGRES_CONTAINER
    // The sibling suites build `new DockerPgTools(container)` with no host/port,
    // meaning "the container holds the server too". `tools()` takes a DIFFERENT
    // branch if either of these is set, so an ambient pair inherited from a
    // developer's shell would silently point the dump at another server.
    delete env.BACKUP_POSTGRES_DOCKER_HOST
    delete env.BACKUP_POSTGRES_DOCKER_PORT

    const result = spawnSync(
      process.execPath,
      [TSX, SCRIPT, '--asset-target', assetTarget],
      // The cwd is an EMPTY directory so `import 'dotenv/config'` finds no
      // `.env` — running from `server/` would let a developer's file supply
      // anything set below, which is this command family's standing trap. It
      // does NOT make the child hermetic: `process.env` is inherited on purpose
      // (PATH, and the Docker container name above). The four `delete`s are the
      // variables that would change what the script DOES; `DB_SSL_MODE`,
      // `PG_DUMP_BIN` and `PG_RESTORE_BIN` are inherited and would fail loudly.
      { cwd: emptyCwd, env, encoding: 'utf8', timeout: 300_000 },
    )
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const events: Record<string, unknown>[] = []
    for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object') events.push(parsed as Record<string, unknown>)
      } catch {
        // Not every line the script prints is JSON; only the events matter.
      }
    }
    return {
      status: result.status,
      spawnError: result.error ? `${result.error.name}: ${result.error.message}` : null,
      stdout,
      stderr,
      events,
    }
  }

  function event(run: ScriptRun, name: string): Record<string, unknown> | undefined {
    return run.events.find((entry) => entry.event === name)
  }

  /**
   * Assert the exit code THROUGH the output, because a subprocess that never
   * started and one that ran and failed are indistinguishable from a bare
   * `expect(run.status).toBe(0)` — both give a number or null and no reason.
   * Putting stderr and the run stamp in the compared value means the diff
   * carries the reason and the fixture identity instead of the reader going to
   * look for them.
   */
  function expectExit(run: ScriptRun, expected: number): void {
    expect({
      run: RUN,
      status: run.status,
      spawnError: run.spawnError,
      stderr: run.stderr.slice(0, 4000),
    }).toMatchObject({ status: expected })
  }

  async function seedTables(pool: Pool): Promise<void> {
    await pool.query(`
      CREATE TABLE automerge_storage (
        key TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE landscapes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        default_version_id TEXT
      );
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL,
        root_url TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `)
    for (const landscapeId of [...new Set(WORKSPACES.map((workspace) => workspace.landscapeId))]) {
      await pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [landscapeId, landscapeId])
    }
    await ensureBackupSchema(pool)
  }

  async function seedOwnership(pool: Pool): Promise<void> {
    // `landscapes` above is not decoration: `ensureSyncCellOwnershipSchema` also
    // creates `automerge_document_workspace`, whose `landscape_id` REFERENCES
    // it, and without the table the DDL throws inside `beforeAll` — the shape
    // where the FILE fails while no test inside it does.
    await ensureSyncCellOwnershipSchema(pool)
    for (const workspace of WORKSPACES) {
      await pool.query(
        `INSERT INTO versions (id, landscape_id, root_url, kind, status)
         VALUES ($1, $2, $3, 'version', 'active')`,
        [workspace.versionId, workspace.landscapeId, `automerge:root-${workspace.versionId}`],
      )
      await pool.query(
        `INSERT INTO sync_workspace_ownership (
           landscape_id, version_id, cell_id, fencing_token,
           lease_observed_expires_at, acquired_at, updated_at, released_at
         ) VALUES ($1, $2, $3, $4::bigint,
           NOW() + ($5 || ' minutes')::interval,
           NOW() - interval '1 hour', NOW() - interval '1 hour', $6)`,
        [
          workspace.landscapeId, workspace.versionId, workspace.cellId, workspace.token,
          // SIXTY minutes: the property under test is the SIGN, not the
          // magnitude, and the window must comfortably outlast the `beforeAll`
          // and an arm (300 s each) or a slow CI box would read as a `force`
          // regression.
          workspace.expiryInTheFuture ? '60' : '-60',
          workspace.released ? new Date() : null,
        ],
      )
    }
  }

  interface ClaimRow {
    landscape_id: string
    version_id: string
    cell_id: string
    fencing_token: string
    released: boolean
    expiry_in_future: boolean
    acquired_at: string
    updated_at: string
    /** Milliseconds, computed by the SERVER. A `released_at::text` compared in
     *  JS would be a `Date.parse` of a non-ISO Postgres rendering. Read so a
     *  back-dated `released_at` is caught. */
    released_ms_ago: number | null
  }

  async function claims(pool: Pool): Promise<ClaimRow[]> {
    const { rows } = await pool.query<ClaimRow>(`
      SELECT landscape_id, version_id, cell_id,
             fencing_token::text AS fencing_token,
             (released_at IS NOT NULL) AS released,
             (released_at IS NULL AND lease_observed_expires_at > NOW()) AS expiry_in_future,
             acquired_at::text AS acquired_at,
             updated_at::text AS updated_at,
             (EXTRACT(EPOCH FROM (NOW() - released_at)) * 1000)::float8 AS released_ms_ago
        FROM sync_workspace_ownership
       ORDER BY landscape_id, version_id
    `)
    return rows
  }

  beforeAll(async () => {
    // Keep the number of scratch databases low. `createTemporaryRestoreDatabase`
    // opens an admin pool per database and holds it until `drop()`, so each
    // pins a connection for the whole suite; with 16 workers against one
    // Postgres (`max_connections = 100`) more of them starved a sibling suite's
    // teardown. The bundles below share ONE source; the pre-mirror arm
    // allocates its own short-lived target only while it runs.
    source = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    scriptTarget = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    libraryTarget = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    schemalessTarget = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    refusingTarget = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)

    temporaryDirectory = await mkdtemp(join(tmpdir(), 'maplespire-restore-command-'))
    bundleDirectory = join(temporaryDirectory, 'bundle')
    schemalessBundleDirectory = join(temporaryDirectory, 'bundle-schemaless')
    refusingBundleDirectory = join(temporaryDirectory, 'bundle-refusing')
    missingDependencyBundleDirectory = join(temporaryDirectory, 'bundle-missing-dependency')
    preMirrorBundleDirectory = join(temporaryDirectory, 'bundle-pre-mirror')
    emptyCwd = join(temporaryDirectory, 'cwd')
    assetTarget = join(temporaryDirectory, 'assets')
    // `mkdir`, NOT `mkdtemp`: `mkdtemp` treats its argument as a PREFIX and
    // appends six random characters, so it would create `…/cwdA1b2C3` and leave
    // `emptyCwd` pointing at nothing. `spawnSync` with a cwd that does not exist
    // fails ENOENT with no output — which reads exactly like a script that ran
    // and printed nothing.
    await mkdir(emptyCwd, { recursive: true })
    await mkdir(assetTarget, { recursive: true })

    // Both databases are dropped `WITH (FORCE)` in teardown, which terminates
    // every other connection, and an unhandled `57P01` on an idle pooled client
    // kills the whole vitest worker (the run exits 1 with every test passing).
    sourcePool = guardIdleClientErrors(new Pool({ connectionString: source.url }), 'restoreCommand:source')
    tools = TEST_CONTAINER ? new DockerPgTools(TEST_CONTAINER) : new NativePgTools()

    // Five bundles from one source, including the ownership-without-mirror
    // compatibility case. The order is the fixture: each backup captures the
    // schema as it stood, so the bundles differ by exactly the thing each arm
    // is about.

    // (1) Before `ensureSyncCellOwnershipSchema` — a bundle with no ownership
    // table at all, so the reset has nothing to release and the copy is
    // FINISHED. Arm 3.
    await seedTables(sourcePool)
    await createDatabaseBackup({
      databaseUrl: source.url,
      bundleDirectory: schemalessBundleDirectory,
      pgTools: tools,
      applicationRevision: `restore-command-schemaless-${RUN}`,
    })

    // (2) Claims exist, but `sync_topology_contract` does not: a real
    // pre-mirror dump.
    await seedOwnership(sourcePool)
    await sourcePool.query('DROP TABLE sync_topology_contract')
    expect((await sourcePool.query("SELECT to_regclass('sync_workspace_ownership')::text AS claims, to_regclass('sync_topology_contract') AS mirror")).rows)
      .toEqual([{ claims: 'sync_workspace_ownership', mirror: null }])
    expect((await claims(sourcePool)).filter(row => !row.released)).toHaveLength(3)
    await createDatabaseBackup({
      databaseUrl: source.url,
      bundleDirectory: preMirrorBundleDirectory,
      pgTools: tools,
      applicationRevision: `restore-command-pre-mirror-${RUN}`,
    })
    // (3) Current schema and its actual durable mirror. Arms 1 and 2.
    await ensureSyncTopologyContractSchema(sourcePool)
    await sourcePool.query(`INSERT INTO sync_topology_contract (value, written_by, written_at)
      VALUES ($1, $2, '2001-02-03T04:05:06Z')`, [MIRROR_VALUE, `dump-creator-${RUN}`])
    expect(await mirror(sourcePool)).toHaveLength(1)
    await createDatabaseBackup({
      databaseUrl: source.url,
      bundleDirectory,
      pgTools: tools,
      applicationRevision: `restore-command-${RUN}`,
    })

    // (4) Plus a trigger that REFUSES updates. Without this the `failed` branch
    // — the whole reason the outcome is returned rather than thrown — has no
    // fixture at all: arm 3 only exercises `skipped`. The trigger survives
    // dump and restore, so the SURVEY succeeds
    // and the UPDATE raises `P0001` — a genuine, non-`42P01` failure. It is
    // added after the successful bundles so it cannot reach them.
    await sourcePool.query(`
      CREATE FUNCTION refuse_ownership_update() RETURNS trigger AS $refuse$
      BEGIN
        RAISE EXCEPTION 'ownership table is read-only in this fixture';
      END
      $refuse$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_ownership_update
        BEFORE UPDATE ON sync_workspace_ownership
        FOR EACH ROW EXECUTE FUNCTION refuse_ownership_update();
    `)
    await createDatabaseBackup({
      databaseUrl: source.url,
      bundleDirectory: refusingBundleDirectory,
      pgTools: tools,
      applicationRevision: `restore-command-refusing-${RUN}`,
    })

    // (5) Ownership exists, but its UPDATE trigger reads an unrelated missing
    // relation. PostgreSQL itself raises 42P01 after the reset's catalog survey;
    // it must not be mistaken for a dump with no ownership table.
    await sourcePool.query(`
      CREATE OR REPLACE FUNCTION refuse_ownership_update() RETURNS trigger AS $refuse$
      BEGIN
        PERFORM 1 FROM b3i_missing_reset_dependency;
        RETURN NEW;
      END
      $refuse$ LANGUAGE plpgsql;
    `)
    expect((await sourcePool.query("SELECT to_regclass('sync_workspace_ownership')::text AS ownership, to_regclass('b3i_missing_reset_dependency') AS dependency")).rows)
      .toEqual([{ ownership: 'sync_workspace_ownership', dependency: null }])
    await createDatabaseBackup({
      databaseUrl: source.url,
      bundleDirectory: missingDependencyBundleDirectory,
      pgTools: tools,
      applicationRevision: `restore-command-missing-dependency-${RUN}`,
    })

    scriptTargetPool = guardIdleClientErrors(
      new Pool({ connectionString: scriptTarget.url }),
      'restoreCommand:scriptTarget',
    )
    libraryTargetPool = guardIdleClientErrors(
      new Pool({ connectionString: libraryTarget.url }),
      'restoreCommand:libraryTarget',
    )
  }, 300_000)

  // THE CEILING IS DECLARED, and it is strictly greater than
  // `POOL_CONNECT_TIMEOUT_MS` (30 000 ms) on purpose.
  //
  // vitest's DEFAULT hook timeout is also 30 000 ms, and the only wait in here
  // is a pool reconnect bounded by that same number. Two equal ceilings mean the
  // bounded failure can never be reported: the hook dies at the instant the pool
  // would have said "could not connect", so the log says `Hook timed out in
  // 30000ms` and names nothing.
  afterAll(async () => {
    await scriptTargetPool?.end().catch(() => undefined)
    await libraryTargetPool?.end().catch(() => undefined)
    await sourcePool?.end().catch(() => undefined)
    await refusingTarget?.drop().catch(() => undefined)
    await schemalessTarget?.drop().catch(() => undefined)
    await libraryTarget?.drop().catch(() => undefined)
    await scriptTarget?.drop().catch(() => undefined)
    await source?.drop().catch(() => undefined)
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  }, 120_000)

  /**
   * ARM 1 — the script calls the reset. Deleting the call from
   * `restore-database.ts` leaves live claims on the restored copy and no
   * `routingReset` key in the line, and both halves of this test go red.
   */
  it('restores, verifies, and leaves no live routing claim behind', async () => {
    expect(await mirror(sourcePool)).toHaveLength(1)
    const before = await claims(sourcePool)
    const live = before.filter((row) => !row.released)
    const run = runRestoreScript({
      sourceDatabaseUrl: source.url,
      targetDatabaseUrl: scriptTarget.url,
      bundle: bundleDirectory,
    })
    expectExit(run, 0)
    expect(await mirror(scriptTargetPool)).toEqual([])

    const verified = event(run, 'backup.database.restore_verified')
    expect(verified).toBeDefined()
    // DERIVED from the fixture, never transcribed. Every value here is a
    // function of the per-run stamp, so a report built from literals cannot
    // match.
    expect(verified?.routingReset).toEqual({
      outcome: 'released',
      afterVerification: 'passed',
      claimsReleased: live.length,
      alreadyReleased: before.length - live.length,
      // Deduplicated AND sorted; the zeta id appears twice and is met first.
      claimingCells: [...new Set(live.map((row) => row.cell_id))].sort(),
      // NOT equal to either count above, deliberately, so a transposition with
      // `alreadyReleased` is caught. This is the number printed BECAUSE `force`
      // silenced the refusal.
      recentlyAcquiredClaims: live.filter((row) => row.expiry_in_future).length,
      // The values are the point rather than the shape. On a clean end-to-end
      // restore NOTHING claims the target between the emptiness proof and the
      // reset, so `writtenAfterEmptinessProof` must be exactly 0 and every
      // recent claim must be accounted for as carried by the dump. This is the
      // NEGATIVE arm of the discriminant; the positive one lives in
      // `restoreRoutingReset.integration.test.ts`, where a writer is injected.
      recentlyAcquiredBreakdown: {
        writtenAfterEmptinessProof: 0,
        carriedByTheDump: live.filter((row) => row.expiry_in_future).length,
      },
      // BigInt, not Number: the top two tokens are the same `double`, and the
      // maximum sits on an already-released row.
      highestFencingTokenBeforeReset: before
        .map((row) => row.fencing_token)
        .reduce((highest, token) => (BigInt(token) > BigInt(highest) ? token : highest)),
      forced: true,
    })
    // Sanity on the fixture itself: if these ever coincide, transpositions
    // above become invisible.
    expect(new Set([live.length, before.length - live.length, 1]).size).toBe(3)
    // The restore's own facts are still in the same line — the reset is an
    // addition to the record, not a replacement of it.
    expect(verified?.outcome).toBe('passed')
    expect(Number(verified?.tables)).toBeGreaterThan(0)

    const after = await claims(scriptTargetPool)
    expect(after).toHaveLength(before.length)
    expect(after.every((row) => row.released)).toBe(true)
    // Every token EXACTLY its source value, cell ids too: replacing the reset's
    // UPDATE with a DELETE, or letting it touch `fencing_token`, turns this red.
    // It is the clause the whole release-rather-than-delete design exists for.
    expect(after.map((row) => row.fencing_token)).toEqual(before.map((row) => row.fencing_token))
    expect(after.map((row) => row.cell_id)).toEqual(before.map((row) => row.cell_id))
    // `acquired_at` does not move — nothing acquired anything.
    expect(after.map((row) => row.acquired_at)).toEqual(before.map((row) => row.acquired_at))
    // TWO-SIDED, because the reset's `WHERE released_at IS NULL` means a row
    // that was ALREADY released must be left completely alone: exactly the
    // live rows move.
    const moved = after.filter((row, index) => row.updated_at !== before[index]!.updated_at)
    expect(moved.map((row) => row.version_id)).toEqual(live.map((row) => row.version_id))
    // And `released_at` is NOW, not some other time.
    for (const row of moved) {
      expect(row.released_ms_ago).toBeGreaterThanOrEqual(0)
      expect(row.released_ms_ago).toBeLessThan(600_000)
    }
  }, 300_000)

  /**
   * ARM 2 — the reset is NOT inside the library restore.
   *
   * The LIBRARY call alone leaves every live claim live; arm 1 says the SCRIPT
   * releases them. Together they say the reset is in the script and only in
   * the script, and either one goes red if it moves.
   */
  it('the library restore alone leaves the claims live — the reset is the script\'s, not its', async () => {
    const before = await claims(sourcePool)
    const verification = await restoreAndVerifyDatabase({
      sourceDatabaseUrl: source.url,
      targetDatabaseUrl: libraryTarget.url,
      bundleDirectory,
      pgTools: tools,
    })
    expect(verification.outcome).toBe('passed')
    const restored = await claims(libraryTargetPool)
    expect(restored.filter((row) => !row.released)).toHaveLength(before.filter((row) => !row.released).length)
    expect(restored.map((row) => row.fencing_token)).toEqual(before.map((row) => row.fencing_token))
    expect(await mirror(libraryTargetPool)).toEqual(await mirror(sourcePool))
  }, 300_000)

  it('B3i releases claims from a pre-mirror dump instead of misreporting a schemaless skip', async () => {
    const destination = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    const observer = guardIdleClientErrors(new Pool({ connectionString: destination.url, max: 1 }), 'restoreCommand:preMirror')
    try {
      const before = await claims(sourcePool)
      expect(before.filter(row => !row.released)).toHaveLength(3)
      const run = runRestoreScript({ sourceDatabaseUrl: source.url, targetDatabaseUrl: destination.url, bundle: preMirrorBundleDirectory })
      expectExit(run, 0)
      const verified = event(run, 'backup.database.restore_verified')
      expect(verified?.outcome).toBe('passed')
      expect(verified?.routingReset).toMatchObject({ outcome: 'released', claimsReleased: 3 })
      expect(event(run, 'backup.database.routing_reset_skipped')).toBeUndefined()
      expect(event(run, 'backup.database.routing_reset_failed')).toBeUndefined()
      const after = await claims(observer)
      expect(after).toHaveLength(before.length)
      expect(after.every(row => row.released)).toBe(true)
      expect(after.map(row => row.fencing_token)).toEqual(before.map(row => row.fencing_token))
      expect((await observer.query("SELECT to_regclass('sync_topology_contract') AS name")).rows).toEqual([{ name: null }])
    } finally {
      try { await observer.end() } finally { await destination.drop() }
    }
  }, 300_000)

  /**
   * ARM 3 — nothing to release is not a failure.
   *
   * A bundle predating `ensureSyncCellOwnershipSchema` has no
   * `sync_workspace_ownership`. The restored copy carries no routing claims and
   * is FINISHED, so this must exit 0 and say `skipped`. (Suggesting
   * `restore:reset-routing --apply` here would be useless: it runs the SAME
   * survey against the SAME missing table.)
   */
  it('a bundle with no ownership table is SKIPPED, not failed, and exits 0', () => {
    const run = runRestoreScript({
      // The same source database as arm 1 — the bundle is what differs, taken
      // before the ownership schema existed. `restoreAndVerifyDatabase` uses the
      // source URL only for `assertSafeRestoreTarget`, never to connect.
      sourceDatabaseUrl: source.url,
      targetDatabaseUrl: schemalessTarget.url,
      bundle: schemalessBundleDirectory,
    })
    const verified = event(run, 'backup.database.restore_verified')
    expect(verified).toBeDefined()
    expect(verified?.outcome).toBe('passed')
    expect(event(run, 'backup.database.restore_failed')).toBeUndefined()
    expect(event(run, 'backup.database.routing_reset_failed')).toBeUndefined()

    const reset = verified?.routingReset as Record<string, unknown> | undefined
    expect(reset?.outcome).toBe('skipped')

    const skipped = event(run, 'backup.database.routing_reset_skipped')
    expect(skipped).toBeDefined()
    // Read from the SERVER with `current_database()`, never parsed out of the
    // URL — this command family's standing rule, failure lines included.
    expect(skipped?.database).toBe(schemalessTarget.database)
    expectExit(run, 0)
  }, 300_000)

  /**
   * ARM 4 — a real reset failure is reported without lying about the restore,
   * and exits 2.
   *
   * Two exits are not enough: `main`'s catch uses 1 for "the restore failed", so
   * collapsing "restore ok, post-step failed" onto 1 throws away the only
   * distinction a caller could act on. This arm requires all five at once — the
   * verification line, `passed` inside it, the failed reset inside it, the
   * dedicated failure line with the SQLSTATE and the database, and exit 2.
   */
  it.each(['P0001', '42P01'] as const)('a reset that genuinely fails with %s does not lie about the restore, and exits 2', async code => {
    // A restore requires an empty target. Allocate the second arm's target only
    // for this test instead of adding another suite-long admin connection.
    const destination = code === 'P0001' ? refusingTarget : await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    const observer = guardIdleClientErrors(new Pool({ connectionString: destination.url, max: 1 }), `restoreCommand:refusal:${code}`)
    try {
      const before = await claims(sourcePool)
      expect(before.filter(row => !row.released)).toHaveLength(3)
      const run = runRestoreScript({
        sourceDatabaseUrl: source.url,
        targetDatabaseUrl: destination.url,
        bundle: code === 'P0001' ? refusingBundleDirectory : missingDependencyBundleDirectory,
      })
      const verified = event(run, 'backup.database.restore_verified')
      expect(verified).toBeDefined()
      expect(verified?.outcome).toBe('passed')
      expect(event(run, 'backup.database.restore_failed')).toBeUndefined()
      expect(event(run, 'backup.database.routing_reset_skipped')).toBeUndefined()

      const reset = verified?.routingReset as Record<string, unknown> | undefined
      expect(reset?.outcome).toBe('failed')

      const failure = event(run, 'backup.database.routing_reset_failed')
      expect(failure).toBeDefined()
      expect(failure?.code).toBe(code)
      expect(failure?.database).toBe(destination.database)
      if (code === '42P01') expect(failure?.error).toContain('b3i_missing_reset_dependency')
      // EXACT, not `toContain`: a prefix match would accept a typo in the
      // operator-facing remedy.
      expect(failure?.remedy).toBe(
        'RESET_DATABASE_URL=<target> npm --prefix server run restore:reset-routing -- --apply',
      )
      expectExit(run, 2)
      expect((await observer.query("SELECT to_regclass('sync_workspace_ownership')::text AS ownership, to_regclass('b3i_missing_reset_dependency') AS dependency")).rows)
        .toEqual([{ ownership: 'sync_workspace_ownership', dependency: null }])
      const after = await claims(observer)
      expect(after.map(row => ({ ...row, released_ms_ago: null })))
        .toEqual(before.map(row => ({ ...row, released_ms_ago: null })))
      expect(await mirror(observer)).toEqual(await mirror(sourcePool))
    } finally {
      try { await observer.end() } finally { if (destination !== refusingTarget) await destination.drop() }
    }
  }, 300_000)
})
