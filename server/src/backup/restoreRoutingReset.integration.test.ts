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
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import {
  createDatabaseBackup,
  createTemporaryRestoreDatabase,
  DockerPgTools,
  NativePgTools,
  restoreAndVerifyDatabase,
  type PgTools,
  type Queryable,
} from './backupRestore.js'
import { ensureBackupSchema } from './schema.js'
import { ensureSyncCellOwnershipSchema } from '../syncCells/ownership.js'
import { LiveLeasesPresentError, resetSyncCellOwnershipClaims } from '../syncCells/restoreRoutingReset.js'
import { ensureSyncTopologyContractSchema } from '../syncCells/topologyMirror.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

const TEST_DATABASE_URL = process.env.BACKUP_RESTORE_TEST_DATABASE_URL
const TEST_CONTAINER = process.env.BACKUP_RESTORE_TEST_PG_CONTAINER

/**
 * `restore:reset-routing`, token-preserving.
 *
 * The suite is CONJUNCTIVE, and each clause names the way the remedy could be
 * got wrong rather than the way it could be got right:
 *
 *   1. the bundle and its manifest are still readable afterwards — a reset that
 *      damaged the backup it was run beside would be a worse outcome than the
 *      wedge it fixes;
 *   2. every row is released — removing the reset turns this red, which is what
 *      makes the clause a test of the reset and not of `pg_restore`;
 *   3. every fencing token is EXACTLY its pre-reset value — replacing the
 *      UPDATE with a DELETE turns this red, and that is the whole design
 *      argument.
 *
 * The restore is REAL — `pg_dump` and `pg_restore` against a scratch database —
 * because the whole subject is what a restore leaves behind.
 *
 * ── THE FIXTURE IS NOT ARBITRARY ────────────────────────────────────────────
 * Each choice below exists so a specific wrong implementation fails.
 *
 *  - The two largest tokens are 9007199254740992 and 9007199254740993, IN THAT
 *    ORDER: they are the same `double`, so a `Number()` comparison cannot order
 *    them and keeps the first. Only BigInt reports the larger.
 *  - The maximum sits on an ALREADY-RELEASED row, so a survey narrowed to live
 *    rows reports the wrong maximum.
 *  - `cell-zeta` appears twice and is encountered BEFORE `cell-alpha`, so
 *    dedup and sort are both exercised rather than accidentally satisfied.
 *  - Exactly one row has an observed lease expiry in the FUTURE, which is what
 *    the `--force` refusal is about. Read the field's own doc before reading
 *    that as "a live cell": `lease_observed_expires_at` is written only on
 *    ACQUISITION, never on renewal, so it cannot detect a long-running cell at
 *    all.
 *
 *    A future value does NOT prove the row was written after the dump: this
 *    fixture seeds such a row BEFORE the dump. What it proves is bounded: the
 *    row was written less than one lease TTL ago (6–120 s, 15 s default),
 *    which on a restored database is the incident OR a dump taken inside that
 *    window.
 *  - `acquired_at` and `updated_at` are seeded an hour in the past so "the
 *    reset moved updated_at and did NOT move acquired_at" is an assertion with
 *    two sides rather than a tautology about NOW().
 */
describe.skipIf(!TEST_DATABASE_URL)('restore:reset-routing releases claims and preserves tokens', () => {
  let source: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let target: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let sourcePool: Pool
  let targetPool: Pool
  let bundleDirectory: string
  let temporaryDirectory: string
  let tools: PgTools
  /** The instant `assertEmptyRestoreDatabase` proved the target empty, taken from
   *  the REAL verification rather than a clock this file reads. That lets the
   *  breakdown arms below catch an implementation returning the looser
   *  `manifest.createdAt` — earlier than this by the whole transfer, so every
   *  restored row would read as written AFTER it. */
  let emptyAtFromVerification: Date

  const HUGE_LOWER = '9007199254740992'
  const HUGE_UPPER = '9007199254740993'
  const MIRROR_VALUE = 'restored-v1.ce1461953e2b8ac2|1'
  const mirror = async (pool: Pool) => (await pool.query(
    'SELECT value, written_by, written_at::text AS written_at FROM sync_topology_contract',
  )).rows

  const WORKSPACES = [
    // order 1 — the only row with a future observed expiry. It is seeded BEFORE
    // the dump, which is the whole point: a future expiry does not mean
    // "written after the dump".
    { landscapeId: 'landscape-1', versionId: 'version-a', cellId: 'cell-zeta', token: '39', expiryInTheFuture: true },
    { landscapeId: 'landscape-1', versionId: 'version-b', cellId: 'cell-alpha', token: '41' },
    { landscapeId: 'landscape-1', versionId: 'version-c', cellId: 'cell-zeta', token: HUGE_LOWER },
    // order 4 — released, and carrying the MAXIMUM token.
    { landscapeId: 'landscape-2', versionId: 'version-d', cellId: 'cell-alpha', token: HUGE_UPPER, released: true },
  ]

  beforeAll(async () => {
    source = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    target = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'maplespire-routing-reset-'))
    bundleDirectory = join(temporaryDirectory, 'bundle')
    // Both databases are dropped `WITH (FORCE)` in the teardown, which
    // terminates every other connection to them — an unhandled `57P01` on an
    // idle pooled client kills the whole vitest worker (the run exits 1 with
    // every test passing).
    sourcePool = guardIdleClientErrors(new Pool({ connectionString: source.url }), 'routingReset:source')
    tools = TEST_CONTAINER ? new DockerPgTools(TEST_CONTAINER) : new NativePgTools()

    await sourcePool.query(`
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
    // `landscapes` is not decoration in this fixture: `ensureSyncCellOwnershipSchema`
    // also creates `automerge_document_workspace`, whose `landscape_id`
    // REFERENCES it. Without the table the DDL throws inside `beforeAll` — the
    // shape where the FILE fails while no test inside it does.
    for (const landscapeId of [...new Set(WORKSPACES.map((workspace) => workspace.landscapeId))]) {
      await sourcePool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [landscapeId, landscapeId])
    }
    await ensureBackupSchema(sourcePool)
    // The real DDL, not a hand-written copy: the column list and the FK to
    // `versions` are part of what the restore has to bring back.
    await ensureSyncCellOwnershipSchema(sourcePool)
    await sourcePool.query(`INSERT INTO sync_topology_contract (value, written_by, written_at)
      VALUES ($1, 'dump-creator', '2001-02-03T04:05:06Z')`, [MIRROR_VALUE])
    expect(await mirror(sourcePool)).toHaveLength(1)

    for (const workspace of WORKSPACES) {
      await sourcePool.query(
        `INSERT INTO versions (id, landscape_id, root_url, kind, status)
         VALUES ($1, $2, $3, 'version', 'active')`,
        [workspace.versionId, workspace.landscapeId, `automerge:root-${workspace.versionId}`],
      )
      await sourcePool.query(
        `INSERT INTO sync_workspace_ownership (
           landscape_id, version_id, cell_id, fencing_token,
           lease_observed_expires_at, acquired_at, updated_at, released_at
         ) VALUES ($1, $2, $3, $4::bigint,
           NOW() + ($5 || ' minutes')::interval,
           NOW() - interval '1 hour', NOW() - interval '1 hour', $6)`,
        [
          workspace.landscapeId, workspace.versionId, workspace.cellId, workspace.token,
          workspace.expiryInTheFuture ? '10' : '-10',
          workspace.released ? new Date() : null,
        ],
      )
    }
    // A spare version for the mid-reset writer below; no ownership row yet.
    await sourcePool.query(
      `INSERT INTO versions (id, landscape_id, root_url, kind, status)
       VALUES ('version-late', 'landscape-1', 'automerge:root-late', 'version', 'active')`,
    )

    await createDatabaseBackup({
      databaseUrl: source.url,
      bundleDirectory,
      pgTools: tools,
      applicationRevision: 'routing-reset-integration',
    })
    const verification = await restoreAndVerifyDatabase({
      sourceDatabaseUrl: source.url,
      targetDatabaseUrl: target.url,
      bundleDirectory,
      pgTools: tools,
    })
    // If the restore itself did not pass, every assertion below is about a
    // database that was never faithfully restored, and the conjunction would be
    // measuring the wrong thing while looking green on two of its three clauses.
    expect(verification.outcome).toBe('passed')
    emptyAtFromVerification = verification.emptyAt
    targetPool = guardIdleClientErrors(new Pool({ connectionString: target.url }), 'routingReset:target')
  }, 180_000)

  // THE CEILING IS DECLARED, and it is strictly greater than
  // `POOL_CONNECT_TIMEOUT_MS` (30 000 ms) on purpose. vitest's default hook
  // timeout is exactly 30 000 ms — the same number that bounds the only wait
  // inside it, a pool reconnect. Two equal ceilings mean the bounded failure
  // can never be reported: the hook dies at the instant the pool would have
  // said "could not connect", and the log reads `Hook timed out in 30000ms`
  // while naming nothing. Connection pressure from sibling suites (each
  // scratch database pins an admin pool until `drop()`) makes that wait real.
  afterAll(async () => {
    await targetPool?.end().catch(() => undefined)
    await sourcePool?.end().catch(() => undefined)
    await target?.drop().catch(() => undefined)
    await source?.drop().catch(() => undefined)
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  }, 120_000)

  interface ClaimRow {
    landscape_id: string
    version_id: string
    cell_id: string
    fencing_token: string
    released: boolean
    /** Projected as text so the assertions compare the STORED value rather than
     * two `Date` objects that a driver may round differently. All four
     * timestamps are read so moving `acquired_at`, not moving `updated_at`,
     * clobbering `lease_observed_expires_at` or back-dating `released_at` is
     * caught. */
    acquired_at: string
    updated_at: string
    released_at: string | null
    lease_observed_expires_at: string
  }

  async function claims(pool: Pool): Promise<ClaimRow[]> {
    const { rows } = await pool.query<ClaimRow>(`
      SELECT landscape_id, version_id, cell_id,
             fencing_token::text AS fencing_token,
             (released_at IS NOT NULL) AS released,
             acquired_at::text AS acquired_at,
             updated_at::text AS updated_at,
             released_at::text AS released_at,
             lease_observed_expires_at::text AS lease_observed_expires_at
        FROM sync_workspace_ownership
       ORDER BY landscape_id, version_id
    `)
    return rows
  }

  const byKey = (rows: ClaimRow[]) => new Map(rows.map((row) => [`${row.landscape_id}/${row.version_id}`, row]))

  let restored: ClaimRow[]

  // THE "IT REALLY RAN" WITNESS IS NOT IN THIS FILE: an assertion inside the
  // `describe.skipIf` cannot witness its own skip condition. The witness is
  // `scripts/check-test-skips.mjs` against this file's `requiresEnv` entry in
  // `test-skip-allowlist.json`: with `BACKUP_RESTORE_TEST_DATABASE_URL` set, a
  // skipped file is an ERROR that names the file.

  it('restores the claims verbatim, tokens and timestamps included', async () => {
    restored = await claims(targetPool)
    expect(restored).toHaveLength(4)
    expect(restored.map((row) => row.fencing_token)).toEqual(['39', '41', HUGE_LOWER, HUGE_UPPER])
    expect(restored.map((row) => row.released)).toEqual([false, false, false, true])
    expect(restored.map((row) => row.cell_id)).toEqual(['cell-zeta', 'cell-alpha', 'cell-zeta', 'cell-alpha'])
    expect(await mirror(targetPool)).toEqual(await mirror(sourcePool))
    expect((await mirror(targetPool))[0]).toMatchObject({ value: MIRROR_VALUE, written_by: 'dump-creator' })
  })

  /**
   * `restoreAndVerifyDatabase` must issue no `UPDATE` and no `DELETE` against
   * `sync_workspace_ownership`.
   *
   * A spy on the verification pool is not possible: `restoreAndVerifyDatabase`
   * builds its own pools from the URL. This is the observable form instead.
   *
   * WHAT IT COVERS, precisely. Every column of every row is compared against
   * the SOURCE, so any UPDATE that CHANGES a value and any DELETE turn it red. It does NOT
   * catch a value-preserving UPDATE or one that was rolled back — and
   * `updated_at` does not help there: there is no `BEFORE UPDATE` trigger on
   * `sync_workspace_ownership`, so that column moves only when a statement
   * sets it. A spy would prove no statement was issued; this proves no
   * statement SURVIVED, which is the weaker of the two and worth having
   * anyway — it is the property an operator can check on a restored copy.
   *
   * Its sibling clause — that the dump carries no table filter — is
   * `backupDumpArgs.test.ts`, which needs no database.
   */
  it('the restore writes NOTHING to the ownership table it just restored', async () => {
    const before = byKey(await claims(sourcePool))
    // RE-READ the target here rather than reusing the snapshot the previous
    // test took: reusing it would narrow the covered window to "before that
    // read" instead of "after the verification finished".
    const after = byKey(await claims(targetPool))
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [key, row] of after) {
      // `toEqual` on the whole row, not a field list: a column added later is
      // then covered by this clause on the day it is added, rather than on the
      // day someone remembers to extend an enumeration.
      expect(row).toEqual(before.get(key))
    }
  })

  it('previews without writing, and names the database it looked at', async () => {
    const beforeMirror = await mirror(targetPool)
    expect(beforeMirror).toHaveLength(1)
    const preview = await resetSyncCellOwnershipClaims(targetPool, { mode: 'preview' })
    expect(preview).toMatchObject({
      mode: 'preview',
      claimsReleased: 3,
      alreadyReleased: 1,
      // Deduplicated AND sorted: `cell-zeta` appears twice and is met first.
      claimingCells: ['cell-alpha', 'cell-zeta'],
      // The maximum is on a RELEASED row, and it is one above a token that is
      // the same `double`. Both facts are needed for this single assertion.
      highestFencingToken: HUGE_UPPER,
      recentlyAcquiredClaims: 1,
    })
    // A destructive command that cannot name its target is one an operator
    // cannot audit; the CLI's URL resolution silently falls through to
    // `server/.env`, so this comes from the SERVER and not from a parsed string.
    expect(preview.target.database).toBe(target.database)
    // Nothing moved. Asserted against the ROWS, because the report is precisely
    // the thing that would lie.
    expect(await claims(targetPool)).toEqual(restored)
    expect(await mirror(targetPool)).toEqual(beforeMirror)
  })

  it('B4-6b — tells a claim written AFTER the emptiness proof apart from one carried by the dump', async () => {
    // `recentlyAcquiredClaims` counts rows whose observed lease expiry is in the
    // future, i.e. written less than one lease TTL ago. On a restored database
    // that is either a cell claiming the target RIGHT NOW — the incident an
    // operator has to stop — or a dump taken inside that window and restored
    // fast, which is a non-event. The count alone cannot separate them.
    //
    // `assertEmptyRestoreDatabase` proved the target held no public table at
    // instant T. Every ownership row afterwards therefore came either from
    // `pg_restore` — carrying an `acquired_at` copied from the SOURCE's past —
    // or from a writer that arrived after T. `acquired_at >= T` is exact.
    // THE REAL INSTANT, from the verification that actually ran, not a clock
    // this file reads: swapping in the manifest's `createdAt` gives an instant
    // earlier than this by the whole transfer, so every restored row would read
    // as written AFTER the proof and arm 1 would go red.
    const emptyAt = emptyAtFromVerification
    expect(emptyAt, 'the verification returned no emptiness instant').toBeInstanceOf(Date)

    // WITHOUT the instant the report still cannot tell them apart, and says so
    // with `null` rather than a zero. "Nobody wrote after the proof" and "there
    // was no proof" are different facts and only one of them is reassuring.
    const blind = await resetSyncCellOwnershipClaims(targetPool, { mode: 'preview' })
    expect(blind.recentlyAcquiredClaims).toBe(1)
    expect(blind.recentlyAcquiredBreakdown).toBeNull()

    // ARM 1, BENIGN: only the dump's rows are present. The one recent claim came
    // in with the restore.
    const benign = await resetSyncCellOwnershipClaims(targetPool, { mode: 'preview', emptyAt })
    expect(benign.recentlyAcquiredClaims).toBe(1)
    expect(benign.recentlyAcquiredBreakdown)
      .toEqual({ writtenAfterEmptinessProof: 0, carriedByTheDump: 1 })

    // ARM 2, THE INCIDENT. A cell claims the target
    // between the proof and the reset, which is the window an operator running a
    // restore against a fleet that has not been stopped actually opens.
    try {
      await targetPool.query(
        `INSERT INTO sync_workspace_ownership (
           landscape_id, version_id, cell_id, fencing_token,
           lease_observed_expires_at, acquired_at, updated_at, released_at
         ) VALUES ('landscape-1', 'version-late', 'cell-intruder', 99::bigint,
           NOW() + interval '10 minutes', NOW(), NOW(), NULL)`,
      )

      const incident = await resetSyncCellOwnershipClaims(targetPool, { mode: 'preview', emptyAt })
      expect(incident.recentlyAcquiredClaims).toBe(2)
      expect(incident.recentlyAcquiredBreakdown)
        .toEqual({ writtenAfterEmptinessProof: 1, carriedByTheDump: 1 })
      // The two halves sum to the whole, by construction rather than by luck: a
      // breakdown whose own arithmetic does not add up is the first thing a
      // reader would have to check instead of reading.
      expect(
        incident.recentlyAcquiredBreakdown!.writtenAfterEmptinessProof
        + incident.recentlyAcquiredBreakdown!.carriedByTheDump,
      ).toBe(incident.recentlyAcquiredClaims)

      // AND THE OPERATOR IS TOLD WHICH. The refusal itself still applies — a
      // diagnostic must not loosen a safety gate as a side effect — but its
      // message names the split when an emptiness proof is available.
      await expect(resetSyncCellOwnershipClaims(targetPool, { mode: 'apply', emptyAt }))
        .rejects.toThrow(/1 of them were written AFTER this database was proved empty/)
      // And the blind message still says the honest thing when there is no proof.
      await expect(resetSyncCellOwnershipClaims(targetPool, { mode: 'apply' }))
        .rejects.toThrow(/with no emptiness proof to compare against/)
    } finally {
      await targetPool.query(
        `DELETE FROM sync_workspace_ownership WHERE version_id = 'version-late'`,
      )
    }
    // The fixture is back to what the arms below expect.
    expect((await claims(targetPool)).length).toBe(4)
  }, 60_000)

  it('refuses when something acquired after the dump, unless it is forced', async () => {
    const beforeMirror = await mirror(targetPool)
    expect(beforeMirror).toHaveLength(1)
    await expect(resetSyncCellOwnershipClaims(targetPool, { mode: 'apply' }))
      .rejects.toBeInstanceOf(LiveLeasesPresentError)
    // The refusal is only worth having if it refuses BEFORE writing.
    expect(await claims(targetPool)).toEqual(restored)
    expect(await mirror(targetPool)).toEqual(beforeMirror)
  })

  it('an unrecognised mode writes nothing — the gate is fail-safe, not fail-open', async () => {
    const beforeMirror = await mirror(targetPool)
    expect(beforeMirror).toHaveLength(1)
    // `'Preview'` with a capital P would WRITE under a `=== 'preview'` gate.
    // TypeScript does not reach a JavaScript caller, a JSON config or a CLI flag.
    const odd = await resetSyncCellOwnershipClaims(
      targetPool,
      { mode: 'Preview' as unknown as 'preview' },
    )
    expect(odd.claimsReleased).toBe(3)
    expect(await claims(targetPool)).toEqual(restored)
    expect(await mirror(targetPool)).toEqual(beforeMirror)
  })

  it('B3i rolls back claim releases when deleting the present mirror fails', async () => {
    const beforeClaims = await claims(targetPool), beforeMirror = await mirror(targetPool)
    expect(beforeClaims.filter(row => !row.released)).toHaveLength(3)
    expect(beforeMirror).toHaveLength(1)
    await targetPool.query(`CREATE FUNCTION refuse_mirror_delete() RETURNS trigger AS $mirror$
      BEGIN RAISE EXCEPTION 'B3i injected mirror delete failure'; END
      $mirror$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_mirror_delete BEFORE DELETE ON sync_topology_contract
        FOR EACH ROW EXECUTE FUNCTION refuse_mirror_delete();`)
    const observer = guardIdleClientErrors(new Pool({ connectionString: target.url, max: 1 }), 'routingReset:atomicObserver')
    try {
      await expect(resetSyncCellOwnershipClaims(targetPool, { mode: 'apply', force: true }))
        .rejects.toMatchObject({ code: 'P0001', message: 'B3i injected mirror delete failure' })
      expect(await claims(observer)).toEqual(beforeClaims)
      expect(await mirror(observer)).toEqual(beforeMirror)
    } finally {
      try { await observer.end() } finally {
        await targetPool.query('DROP TRIGGER refuse_mirror_delete ON sync_topology_contract; DROP FUNCTION refuse_mirror_delete()')
      }
    }
  })

  it('releases every claim, preserves every token, and moves only the right timestamps', async () => {
    expect(await mirror(targetPool)).toHaveLength(1)
    const before = byKey(restored)
    // A neighbouring table the reset has no business touching. Without a row in
    // it, a reset that also wiped `automerge_document_workspace` would go
    // unnoticed.
    await targetPool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ('doc-bystander', 'landscape-1', 'version-a')`,
    )

    const lines: string[] = []
    const realLog = console.log
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    let applied
    try {
      applied = await resetSyncCellOwnershipClaims(targetPool, { mode: 'apply', force: true })
    } finally {
      console.log = realLog
    }
    expect(applied).toMatchObject({
      mode: 'apply', claimsReleased: 3, alreadyReleased: 1,
      // Repeated from the preview assertion on purpose: emptying this on the
      // APPLY path only is invisible to a preview-side check.
      claimingCells: ['cell-alpha', 'cell-zeta'],
      recentlyAcquiredClaims: 1,
    })
    // The operator-facing record of a destructive act must be emitted.
    const emitted = lines
      .map((line) => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } })
      .filter((value): value is Record<string, unknown> => value?.event === 'sync.cell.restore_routing_reset')
    expect(emitted, 'the reset emitted no audit line').toHaveLength(1)
    expect(emitted[0]).toMatchObject({ claimsReleased: 3, forced: true })
    expect((emitted[0]!.target as { database: string }).database).toBe(target.database)

    const after = await claims(targetPool)
    expect(await mirror(targetPool)).toEqual([])
    // The reset deletes the topology mirror beside the claim update; document
    // mappings remain.
    const { rows: bystanders } = await targetPool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM automerge_document_workspace',
    )
    expect(bystanders[0]!.n).toBe('1')

    // CLAUSE 1 — the bundle and its manifest are still readable.
    const manifest = JSON.parse(await readFile(join(bundleDirectory, 'manifest.json'), 'utf8')) as {
      dump: { file: string; bytes: number }
    }
    expect(manifest.dump.bytes).toBeGreaterThan(0)
    await expect(readFile(join(bundleDirectory, manifest.dump.file))).resolves.toBeInstanceOf(Buffer)

    // CLAUSE 2 — every row released. Removing the reset turns this red.
    expect(after.map((row) => row.released)).toEqual([true, true, true, true])

    // CLAUSE 3 — every token EXACTLY its pre-reset value, cell ids too. A DELETE
    // turns this red on the row count alone; a SET that touches the token turns
    // it red on the value.
    expect(after).toHaveLength(4)
    for (const row of after) {
      const previous = before.get(`${row.landscape_id}/${row.version_id}`)!
      expect(row.fencing_token).toBe(previous.fencing_token)
      expect(row.cell_id).toBe(previous.cell_id)
      // Nothing acquired anything, so the acquisition timestamp must not move…
      expect(row.acquired_at).toBe(previous.acquired_at)
      // …and the observed lease expiry is an observation about an acquisition
      // that already happened, so it must not move either.
      expect(row.lease_observed_expires_at).toBe(previous.lease_observed_expires_at)
      if (previous.released) {
        // Already released: untouched, including its release timestamp. A reset
        // that re-released it would over-count and rewrite history.
        expect(row.released_at).toBe(previous.released_at)
        expect(row.updated_at).toBe(previous.updated_at)
      } else {
        // The row DID change, so its update timestamp must move forward…
        expect(Date.parse(row.updated_at)).toBeGreaterThan(Date.parse(previous.updated_at))
        // …and the release must be NOW, not back-dated: a release stamped an
        // hour ago reads in an incident timeline as having happened before the
        // restore did.
        expect(Date.now() - Date.parse(row.released_at!)).toBeLessThan(120_000)
      }
    }
  }, 60_000)

  it('is idempotent — a second apply finds nothing live and changes nothing', async () => {
    const before = await claims(targetPool)
    expect(await mirror(targetPool)).toEqual([])
    // No live claims does not make deleting the mirror optional. This also
    // distinguishes the UPDATE count 0 from a surrounding SELECT rowCount 1.
    await targetPool.query('INSERT INTO sync_topology_contract (value, written_by) VALUES ($1, $2)', [MIRROR_VALUE, 'no-live-claims'])
    expect(await mirror(targetPool)).toHaveLength(1)
    const again = await resetSyncCellOwnershipClaims(targetPool, { mode: 'apply' })
    expect(again).toMatchObject({ mode: 'apply', claimsReleased: 0, alreadyReleased: 4, claimingCells: [] })
    // No force needed: nothing looks live any more, which is itself the check
    // that the refusal above is conditional rather than permanent.
    expect(again.recentlyAcquiredClaims).toBe(0)
    expect(await claims(targetPool)).toEqual(before)
    expect(await mirror(targetPool)).toEqual([])
  })

  it('reports what it DID, not what it saw, when a writer lands mid-reset', async () => {
    // The `Queryable` seam makes the window between the survey and the UPDATE
    // addressable, deterministically, in a single-process fixture.
    let injected = false
    const seam: Queryable = {
      async query(text: string, values?: unknown[]) {
        const result = await targetPool.query(text, values)
        const isSurvey = text.includes('FROM sync_workspace_ownership') && !text.includes('UPDATE')
        if (isSurvey && !injected) {
          injected = true
          await targetPool.query(
            `INSERT INTO sync_workspace_ownership (
               landscape_id, version_id, cell_id, fencing_token,
               lease_observed_expires_at, acquired_at, updated_at, released_at
             ) VALUES ('landscape-1', 'version-late', 'cell-late', 500,
               NOW() - interval '10 minutes', NOW(), NOW(), NULL)`,
          )
        }
        return result
      },
    } as unknown as Queryable

    const report = await resetSyncCellOwnershipClaims(seam, { mode: 'apply' })
    expect(injected).toBe(true)
    // The survey saw nothing live; the UPDATE released the row that arrived
    // after it. `claimsReleased` reports the UPDATE — what was done.
    expect(report.claimsReleased).toBe(1)
    // Everything else keeps its pre-write epoch and therefore does NOT mention
    // the late row. That is the documented behaviour, not a defect — but it is
    // only honest because the field docs say which epoch each number comes from.
    expect(report.claimingCells).toEqual([])
    expect(report.highestFencingToken).toBe(HUGE_UPPER)
    const late = (await claims(targetPool)).find((row) => row.version_id === 'version-late')
    expect(late).toMatchObject({ released: true, fencing_token: '500' })
  })

  it('B3i still releases a pre-mirror schema without discarding any durable token', async () => {
    await targetPool.query("UPDATE sync_workspace_ownership SET released_at = NULL WHERE version_id = 'version-late'")
    const before = await claims(targetPool)
    expect(before.filter(row => !row.released)).toHaveLength(1)
    await targetPool.query('DROP TABLE sync_topology_contract')
    try {
      expect((await targetPool.query("SELECT to_regclass('sync_topology_contract') AS name")).rows).toEqual([{ name: null }])
      const report = await resetSyncCellOwnershipClaims(targetPool, { mode: 'apply', force: true })
      expect(report.claimsReleased).toBe(1)
      const after = await claims(targetPool)
      expect(after).toHaveLength(before.length)
      expect(after.every(row => row.released)).toBe(true)
      expect(after.map(row => row.fencing_token)).toEqual(before.map(row => row.fencing_token))
      expect((await targetPool.query("SELECT to_regclass('sync_topology_contract') AS name")).rows).toEqual([{ name: null }])
    } finally { await ensureSyncTopologyContractSchema(targetPool) }
  })

  it('B3i wires the actual reset CLI: preview preserves the mirror and apply removes it', async () => {
    await targetPool.query("UPDATE sync_workspace_ownership SET released_at = NULL WHERE version_id = 'version-late'")
    await targetPool.query('INSERT INTO sync_topology_contract (value, written_by) VALUES ($1, $2)', [MIRROR_VALUE, 'cli-creator'])
    const beforeClaims = await claims(targetPool), beforeMirror = await mirror(targetPool)
    expect(beforeClaims.filter(row => !row.released)).toHaveLength(1)
    expect(beforeMirror).toHaveLength(1)
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        fileURLToPath(new URL('../../scripts/reset-sync-cell-routing.ts', import.meta.url)),
        ...args,
      ], { cwd: temporaryDirectory, env: { ...process.env, RESET_DATABASE_URL: target.url }, timeout: 30_000 })
      expect({ code: result.status, signal: result.signal, error: result.error?.message ?? null,
        stderr: result.stderr?.toString() ?? '' }).toMatchObject({ code: 0, signal: null, error: null })
      return result.stdout.toString()
    }
    expect(run([])).toContain('PREVIEW ONLY')
    expect(await claims(targetPool)).toEqual(beforeClaims)
    expect(await mirror(targetPool)).toEqual(beforeMirror)
    expect(run(['--apply'])).toContain('sync.cell.restore_routing_reset')
    expect(await mirror(targetPool)).toEqual([])
    const after = await claims(targetPool)
    expect(after.every(row => row.released)).toBe(true)
    expect(after.map(row => row.fencing_token)).toEqual(beforeClaims.map(row => row.fencing_token))
  }, 90_000)
})
