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
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { hostname, tmpdir } from 'node:os'
import { Pool } from 'pg'
import { Repo, type Chunk, type StorageAdapter, type StorageKey } from '@automerge/automerge-repo'
import {
  collectDocumentCensus,
  collectDocumentProbes,
  createDatabaseBackup,
  probeDocumentUrls,
  createTemporaryRestoreDatabase,
  databaseUrlWithName,
  DockerPgTools,
  classifyRestoreDatabase,
  dropOrphanedRestoreDatabases,
  readRestoreDatabaseCensus,
  NativePgTools,
  restoreAndVerifyDatabase,
  restoreDatabaseAgeMs,
  type PgTools,
} from './backupRestore.js'
import { BUNDLE_OWNER_FILE, bundleOwnerLiveness, readBundleOwner, type BundleOwner } from './bundleOwner.js'
import { listRetiredWorkspaces, reinstateDocument, retireDocument, retireWorkspace } from './workspaceRetirement.js'
import { summariseSourceIntegrity } from './drillRunner.js'
import { ensureBackupSchema } from './schema.js'
import { runTeardownSteps } from '../runtime/teardownSteps.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

const TEST_DATABASE_URL = process.env.BACKUP_RESTORE_TEST_DATABASE_URL
const TEST_CONTAINER = process.env.BACKUP_RESTORE_TEST_PG_CONTAINER

function keyText(key: StorageKey): string {
  return key.join('/')
}

class FixturePostgresStorage implements StorageAdapter {
  constructor(private readonly pool: Pool) {}

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const { rows } = await this.pool.query<{ data: Buffer }>(
      'SELECT data FROM automerge_storage WHERE key = $1', [keyText(key)],
    )
    return rows[0]?.data
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    await this.pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data`,
      [keyText(key), Buffer.from(data)],
    )
  }

  async remove(key: StorageKey): Promise<void> {
    await this.pool.query('DELETE FROM automerge_storage WHERE key = $1', [keyText(key)])
  }

  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    const text = keyText(prefix)
    const { rows } = await this.pool.query<{ key: string; data: Buffer }>(
      `SELECT key, data FROM automerge_storage
       WHERE key = $1 OR key LIKE $2 || '/%'
       ORDER BY key`,
      [text, text],
    )
    return rows.map((row) => ({ key: row.key.split('/'), data: row.data }))
  }

  async removeRange(prefix: StorageKey): Promise<void> {
    const text = keyText(prefix)
    await this.pool.query(
      `DELETE FROM automerge_storage WHERE key = $1 OR key LIKE $2 || '/%'`,
      [text, text],
    )
  }
}

describe.skipIf(!TEST_DATABASE_URL)('real PostgreSQL backup and restore drill', () => {
  let source: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let target: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let temporaryDirectory: string
  let sourcePool: Pool
  let tools: PgTools
  /** The technology-icon volume. Deliberately populated: an empty-volume pass
   * is not evidence for the non-empty case. */
  let assetVolume: string
  const icons = [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"/>'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#111"/>'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" id="pending"/>'),
  ].map((body) => ({ body, name: `${createHash('sha256').update(body).digest('hex')}.svg` }))

  beforeAll(async () => {
    source = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    target = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'maplespire-backup-test-'))
    // Every pool in this suite sits on a database this suite itself drops
    // `WITH (FORCE)`, which terminates every other connection to it — so an
    // idle client here can take a `57P01`, and an unhandled `'error'` on a pg
    // Pool kills the whole worker (seen in CI as uncaught `57P01`s failing an
    // otherwise green run). So every pool here gets an idle-error guard.
    //
    // It is NOT a cross-worker race: `dropOrphanedRestoreDatabases` throws
    // below `MINIMUM_SWEEPABLE_AGE_MS` (one hour) and filters candidates by the
    // timestamp in their name, so a sibling worker's seconds-old database
    // cannot be swept by anyone. The reachable race is this file's own — the
    // case at "drops the old orphan and NOTHING else" deliberately runs a
    // forced drop against a pool that is still draining.
    sourcePool = guardIdleClientErrors(new Pool({ connectionString: source.url }), 'backupRestore:source')
    tools = TEST_CONTAINER ? new DockerPgTools(TEST_CONTAINER) : new NativePgTools()
    await sourcePool.query(`
      CREATE TABLE automerge_storage (
        key TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL,
        root_url TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE automerge_document_workspace (
        document_id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL,
        version_id TEXT NOT NULL
      );
      CREATE TABLE technology_assets (
        org_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        path TEXT NOT NULL,
        content_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        reference_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (org_id, sha256)
      );
      CREATE TABLE technology_revisions (
        technology_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        icon_light_path TEXT,
        icon_dark_path TEXT,
        PRIMARY KEY (technology_id, revision)
      );
    `)
    await ensureBackupSchema(sourcePool)

    assetVolume = join(temporaryDirectory, 'asset-volume')
    await mkdir(assetVolume, { recursive: true })
    for (const icon of icons) await writeFile(join(assetVolume, icon.name), icon.body)
    await sourcePool.query(
      `INSERT INTO technology_assets (org_id, sha256, path, content_type, bytes, reference_count)
       VALUES ($1, $2, $3, 'image/svg+xml', $4, $5)`,
      ['org', icons[0]!.name.slice(0, 64), `/assets/technologies/${icons[0]!.name}`, icons[0]!.body.length, 1],
    )
    await sourcePool.query(
      `INSERT INTO technology_assets (org_id, sha256, path, content_type, bytes, reference_count)
       VALUES ($1, $2, $3, 'image/svg+xml', $4, $5)`,
      ['org', icons[1]!.name.slice(0, 64), `/assets/technologies/${icons[1]!.name}`, icons[1]!.body.length, 1],
    )
    // Uploaded, never attached to a revision: the tolerated-missing class.
    await sourcePool.query(
      `INSERT INTO technology_assets (org_id, sha256, path, content_type, bytes, reference_count)
       VALUES ($1, $2, $3, 'image/svg+xml', $4, 0)`,
      ['org', icons[2]!.name.slice(0, 64), `/assets/technologies/${icons[2]!.name}`, icons[2]!.body.length],
    )
    await sourcePool.query(
      `INSERT INTO technology_revisions (technology_id, revision, icon_light_path, icon_dark_path)
       VALUES ('tech', 1, $1, $2)`,
      [`/assets/technologies/${icons[0]!.name}`, `/assets/technologies/${icons[1]!.name}`],
    )
    const repo = new Repo({
      network: [],
      storage: new FixturePostgresStorage(sourcePool),
      saveDebounceRate: 0,
    })
    const model = repo.create({ objects: { account: { id: 'account', name: 'Ledger' } } })
    const registry = repo.create({ diagrams: {} })
    const root = repo.create({ modelUrl: model.url, shardUrls: [registry.url] })
    await Promise.all([model.whenReady(), registry.whenReady(), root.whenReady()])
    await repo.flush([model.documentId, registry.documentId, root.documentId])
    await sourcePool.query(
      `INSERT INTO versions (id, landscape_id, root_url, kind, status)
       VALUES ('main', 'landscape', $1, 'version', 'active')`,
      [root.url],
    )
    for (const documentId of [model.documentId, registry.documentId, root.documentId]) {
      await sourcePool.query(
        `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
         VALUES ($1, 'landscape', 'main')`,
        [documentId],
      )
    }
    await repo.shutdown()
  })

  /**
   * Teardown budget. `DROP DATABASE … WITH (FORCE)` forces an IMMEDIATE
   * checkpoint and waits for it, so the cost of this hook is set by the
   * cluster's checkpointer, not by this file. Measured on the CI containers,
   * one variable changed (concurrent write pressure on the cluster):
   *
   *   this file alone .................... 0.2 s
   *   full `vitest run` (31 forks) ....... 16-17 s
   *   full run + 20 external writers ..... 35-73 s
   *
   * The default `hookTimeout: 30_000` from vitest.config.ts would be blown
   * about one run in five, and a hook timeout fails the FILE with no test
   * named.
   */
  const TEARDOWN_HOOK_MS = 240_000
  const TEARDOWN_STEP_MS = 90_000
  const POOL_CLOSE_CEILING_MS = 10_000

  afterAll(async () => {
    // Concurrent by design — see runTeardownSteps. Sequential drops would leave
    // the second database AND the temporary directory uncleaned whenever the
    // first exceeded the hook timeout, leaking a `maplespire_restore_*`
    // database and a `maplespire-backup-test-*` directory per red run.
    await runTeardownSteps(
      [
        {
          name: 'source pool + source database',
          run: async () => {
            // Sequenced INSIDE the step because the order matters here, but
            // bounded: `DROP … WITH (FORCE)` terminates whatever is still
            // connected, so a pool that will not drain must not be allowed to
            // hold the drop — and therefore the database — hostage.
            const closed = sourcePool
              ? sourcePool.end().then(() => undefined, (error: unknown) => error)
              : Promise.resolve(undefined)
            let timer: ReturnType<typeof setTimeout> | undefined
            const ceiling = new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), POOL_CLOSE_CEILING_MS)
              timer.unref?.()
            })
            const outcome = await Promise.race([closed, ceiling])
            if (timer) clearTimeout(timer)
            await source?.drop()
            // Reported, never swallowed: a pool that fails to close is a finding.
            if (outcome !== undefined) throw outcome
          },
        },
        { name: 'restore target database', run: async () => { await target?.drop() } },
        {
          name: 'temporary directory',
          run: async () => {
            if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
          },
        },
      ],
      { stepTimeoutMs: TEARDOWN_STEP_MS, label: 'backup/restore drill teardown' },
    )
  }, TEARDOWN_HOOK_MS)

  it('claims the partial directory while dumping, and leaves no claim in the bundle', async () => {
    // The resource-side lock, observed at the ONE moment it exists. The claim's
    // lifetime is the partial's: written before the first byte, removed before
    // the rename. After the call there is nothing left to look at, so a test
    // that only inspected the finished bundle could not tell "written then
    // removed" from "never written".
    //
    // `pgTools` is injected, so wrapping `dump` gives an observation point
    // INSIDE the window without changing what runs: the real dump still
    // executes, and `dirname(outputFile)` is the partial directory itself.
    let seen: { name: string; claim: unknown } | null = null
    const observed: PgTools = {
      ...tools,
      dump: async (dumpOptions) => {
        const partialDirectory = dirname(dumpOptions.outputFile)
        seen = {
          name: basename(partialDirectory),
          claim: await readBundleOwner(partialDirectory),
        }
        return tools.dump(dumpOptions)
      },
    }

    const bundleDirectory = join(temporaryDirectory, 'claimed-bundle')
    await createDatabaseBackup({
      databaseUrl: source.url,
      bundleDirectory,
      pgTools: observed,
      assetDirectory: assetVolume,
      ownerKind: 'drill',
    })

    expect(seen).not.toBeNull()
    expect(seen!.name).toMatch(/\.partial-\d+-[0-9a-f]+$/)
    // The claim names THIS process, which is what makes it answerable. A claim
    // carrying somebody else's pid would read `unknown` from here and veto
    // nothing.
    expect(seen!.claim).toMatchObject({ host: hostname(), pid: process.pid, kind: 'drill' })
    // `startedAt` too, and as a RANGE rather than a shape. `toMatchObject`
    // ignores every key it does not name, so a `writeBundleOwner` stamping `0`
    // would pass — inert today, and load-bearing the moment anything compares
    // a claim's age against a permitted drill hold.
    expect((seen!.claim as BundleOwner).startedAt).toBeGreaterThan(Date.now() - 600_000)
    expect((seen!.claim as BundleOwner).startedAt).toBeLessThanOrEqual(Date.now())
    // `as BundleOwner | null`, not `as never`: `as never` on a mock defeats
    // the compiler exactly where it was needed — and server test files
    // are typechecked by nothing, so nothing else would have caught it.
    expect(bundleOwnerLiveness(seen!.claim as BundleOwner | null)).toBe('live')

    // And it is GONE from the finished bundle. A claim that outlived its
    // directory would ship inside every archive describing a process that
    // exited long ago.
    expect(await readBundleOwner(bundleDirectory)).toBeNull()
    expect(await readdir(bundleDirectory)).not.toContain(BUNDLE_OWNER_FILE)
  })

  it('restores exact chunks, documents and a non-empty asset volume', async () => {
    const bundleDirectory = join(temporaryDirectory, 'bundle')
    const manifest = await createDatabaseBackup({
      databaseUrl: source.url,
      bundleDirectory,
      pgTools: tools,
      applicationRevision: 'integration-test',
      maxDocumentProbes: 8,
      assetDirectory: assetVolume,
    })
    expect(manifest.documentProbes.length).toBeGreaterThanOrEqual(3)
    expect(manifest.assets).toMatchObject({ files: 3, referencedByRevision: 2, unreferencedFiles: 0 })

    const restoredAssets = join(temporaryDirectory, 'restored-assets')
    const verification = await restoreAndVerifyDatabase({
      sourceDatabaseUrl: source.url,
      targetDatabaseUrl: target.url,
      bundleDirectory,
      pgTools: tools,
      assetTargetDirectory: restoredAssets,
    })
    expect(verification).toMatchObject({
      outcome: 'passed',
      automergeDocuments: manifest.automergeStorage.documents,
      documentProbes: manifest.documentProbes.length,
      assetFiles: 3,
      assetsRestoredTo: restoredAssets,
    })
    // Byte-for-byte, not merely present: a restore that writes the right
    // filenames with the wrong contents serves broken images and passes a
    // filename-only check.
    for (const icon of icons) {
      expect(await readFile(join(restoredAssets, icon.name))).toEqual(icon.body)
    }
  }, 180_000)

  it('names every unopenable workspace, and covers it again once repaired', async () => {
    // A well-formed URL with no chunks behind it: the shape a draft takes when
    // its storage was lost before anyone tried to back it up. Minted from a real
    // repo rather than hand-written — a hand-written URL fails
    // `isValidAutomergeUrl`, takes the malformed path below, and would have
    // tested a different defect while looking like this one.
    const orphanRepo = new Repo({ network: [] })
    const orphanRoot = orphanRepo.create({ modelUrl: 'automerge:none' }).url
    await orphanRepo.shutdown()
    await sourcePool.query(
      `INSERT INTO versions (id, landscape_id, root_url, kind, status)
       VALUES ('lost-draft', 'landscape', $1, 'draft', 'active')`,
      [orphanRoot],
    )
    try {
      const failing = createDatabaseBackup({
        databaseUrl: source.url,
        bundleDirectory: join(temporaryDirectory, 'bundle-broken'),
        pgTools: tools,
        maxDocumentProbes: 8,
        assetDirectory: assetVolume,
      })
      // Fail-OPEN on the copy. An unopenable workspace is a fact about the
      // SOURCE, and vetoing the backup over it leaves the operator with no copy
      // AND the same broken workspace — a handful of bad mapping rows must not
      // stop every nightly backup.
      const broken = await failing
      expect(broken.dump.bytes).toBeGreaterThan(0)

      // Fail-CLOSED on the verdict, and still actionable: an operator needs the
      // workspace named, not just "a probe failed".
      expect(broken.documentProbeFailures).toEqual([expect.objectContaining({
        url: orphanRoot,
        workspace: { landscapeId: 'landscape', versionId: 'lost-draft' },
      })])
      const verdict = summariseSourceIntegrity(broken)
      expect(verdict.verdict).toBe('violations')
      expect(verdict.detail).toContain('landscape/lost-draft')

      await retireWorkspace(sourcePool, {
        landscapeId: 'landscape',
        versionId: 'lost-draft',
        reason: 'chunks lost before this database existed; draft abandoned',
        retiredBy: 'integration-test',
      })
      const manifest = await createDatabaseBackup({
        databaseUrl: source.url,
        bundleDirectory: join(temporaryDirectory, 'bundle-retired'),
        pgTools: tools,
        maxDocumentProbes: 8,
        assetDirectory: assetVolume,
      })
      // Retirement narrows the gate by exactly one named workspace and says so.
      expect(manifest.documentProbes.some((probe) => probe.url === orphanRoot)).toBe(false)
      expect(manifest.retiredWorkspaces).toEqual([expect.objectContaining({
        landscapeId: 'landscape',
        versionId: 'lost-draft',
        rootUrl: orphanRoot,
        retiredBy: 'integration-test',
      })])
      expect(await listRetiredWorkspaces(sourcePool)).toHaveLength(1)
    } finally {
      await sourcePool.query(`DELETE FROM backup_retired_workspaces WHERE version_id = 'lost-draft'`)
      await sourcePool.query(`DELETE FROM versions WHERE id = 'lost-draft'`)
    }
  }, 180_000)

  it('records a root_url that is not an Automerge URL, and still writes the bundle', async () => {
    // An unprobeable URL must not be silently dropped from the candidate set
    // (the most obviously broken root would get the least scrutiny), nor be
    // fatal — the workspace is the one to repair, but the OTHER workspaces
    // still deserve a backup tonight.
    await sourcePool.query(
      `INSERT INTO versions (id, landscape_id, root_url, kind, status)
       VALUES ('bad-url', 'landscape', 'automerge:not-a-real-document-id', 'draft', 'active')`,
    )
    try {
      const manifest = await createDatabaseBackup({
        databaseUrl: source.url,
        bundleDirectory: join(temporaryDirectory, 'bundle-bad-url'),
        pgTools: tools,
        maxDocumentProbes: 8,
        assetDirectory: assetVolume,
      })
      expect(manifest.dump.bytes).toBeGreaterThan(0)
      expect(manifest.documentProbeFailures).toEqual([expect.objectContaining({
        error: 'root_url is not a valid Automerge URL',
        workspace: { landscapeId: 'landscape', versionId: 'bad-url' },
      })])
      expect(summariseSourceIntegrity(manifest).verdict).toBe('violations')
    } finally {
      await sourcePool.query(`DELETE FROM versions WHERE id = 'bad-url'`)
    }
  }, 180_000)
})

/**
 * The sweep that reclaims restore databases an earlier drill abandoned.
 *
 * Against a real cluster on purpose. The dangerous half of this feature is not
 * "does it drop the orphan" but "what else does it consider fair game", so every
 * test here is built around a database that MUST SURVIVE.
 *
 * WARNING, and it is the reason this suite is opt-in: the sweep is CLUSTER-WIDE.
 * It enumerates `pg_database` on whatever `BACKUP_RESTORE_TEST_DATABASE_URL`
 * names and drops every `maplespire_restore_*` database older than the age gate,
 * not only the ones these tests created. Correct against `ci:local`'s throwaway
 * container; destructive if anyone points that variable at a development
 * cluster that has ever run a drill.
 */
describe.skipIf(!TEST_DATABASE_URL)('orphaned restore database sweep', () => {
  let admin: Pool
  const created: string[] = []
  /**
   * Databases this suite creates while PRETENDING they belong to someone else.
   *
   * A second list, and the reason is precise: a case that manufactures foreign
   * litter must keep it out of every ownership list the exclusion consults —
   * otherwise the exclusion has nothing to find and the assertion that it works
   * is inert. But `afterAll` still has to reclaim it, and the case's own
   * `finally` is not enough: on a vitest timeout the abandoned body issues its
   * cleanup against a pool `afterAll` has already ended, the error is
   * swallowed, and the litter leaks — and a leaked stray is permanently
   * excluded from every sweep the suite runs. Hence a list `afterAll` drains
   * and the exclusion never reads.
   */
  const strays: string[] = []
  /** Roles a case creates, drained by `afterAll`. See the note there. */
  const roles: string[] = []

  /** A name in the real minted format, stamped as if created `agoMs` ago. */
  const aged = (agoMs: number) =>
    `maplespire_restore_${(Date.now() - agoMs).toString(36)}_${randomBytes(4).toString('hex')}`
  const SIX_HOURS = 6 * 60 * 60 * 1000

  async function makeDatabase(name: string): Promise<string> {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
    created.push(name)
    return name
  }
  /** Litter this suite plants and disowns: cleaned up, never excluded-by-name. */
  async function makeStray(name: string): Promise<string> {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
    strays.push(name)
    return name
  }
  async function exists(name: string): Promise<boolean> {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    return rows.length > 0
  }

  /**
   * Every database the sweep could claim that THIS CASE does not own.
   *
   * Why it exists: the sweep is cluster-wide and walks
   * `candidates.sort()`; the stamps are equal-length base-36, so that sort is
   * chronological, and anything an interrupted earlier run left behind is dated
   * BEFORE this suite's own 24 h orphan and is therefore dropped FIRST. Each of
   * those drops is a `DROP DATABASE ... WITH (FORCE)`, which waits on
   * `IPC / ProcSignalBarrier` until every busy backend absorbs it — measured on
   * this container, ten drops per arm: 40 ms median idle, 35 s median and 301 s
   * worst with eight concurrent writers. The sweep's 30 s budget buys TWO of
   * those, not fifty — so foreign leftovers could exhaust the budget before
   * this case's orphan is reached, with the code under test perfectly correct.
   *
   * `exclude` is the production option for exactly this — "databases the caller
   * is using right now and must never be swept" — so naming everything else
   * makes the candidate set equal to what the CASE created, without dropping,
   * renaming, or otherwise touching another run's databases.
   *
   * PER CASE, not per suite: filtering against the suite-wide `created` would
   * leave `sourceLike` — created 24 h-aged by the first case, asserted by it to
   * survive, and still in the cluster — neither owned by a later case nor
   * excluded from it, while its older stamp puts it AHEAD in the walk. One
   * forced drop under contention, and the later case's own subject is never
   * reached.
   *
   * The PRODUCTION dater decides what counts, not a second copy of that regex
   * here: the exclusion has to name precisely what the sweep would consider,
   * and a twin is a thing to drift. Note this does not make the assertion
   * circular — a dater that recognised nothing would empty `exclude` AND drop
   * the orphan out of `candidates`, so `candidates` still bites.
   *
   * NO AGE FILTER, deliberately. Filtering at `>= SIX_HOURS` would re-implement
   * the caller's `minimumAgeMs` — a threshold twin — and open a window this
   * function cannot see: a foreign database at five hours fifty-nine when this
   * snapshot is taken and past six hours when the sweep re-dates it is excluded
   * by nothing and dropped. `restoreDatabaseAgeMs(...) !== null` is MONOTONE —
   * a name that dates now dates forever — so excluding every dateable foreign
   * name is race-free, and it cannot over-exclude, because this case's own
   * fixtures are protected by ownership rather than by age. `young` stays
   * un-excluded on purpose: it is what proves the age gate rejected it.
   */
  async function everySweepableExcept(owned: readonly string[]): Promise<string[]> {
    const { rows } = await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE NOT datistemplate',
    )
    const now = Date.now()
    return rows
      .map((row) => row.datname)
      .filter((name) => !owned.includes(name))
      .filter((name) => restoreDatabaseAgeMs(name, now) !== null)
  }

  beforeAll(() => {
    admin = guardIdleClientErrors(new Pool({ connectionString: databaseUrlWithName(TEST_DATABASE_URL!, 'postgres'), max: 2 }), 'backupRestore:admin')
    // `WITH (FORCE)` terminates connections to whatever it drops, and an
    // unhandled 'error' on a pg Pool takes the whole worker down.
  })

  afterAll(async () => {
    for (const name of [...created, ...strays]) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined)
    }
    // ROLES after databases, because a role owning one cannot be dropped.
    //
    // On its own list for the reason the `strays` docblock above already gives:
    // a case's own `finally` is not enough, since a vitest timeout abandons the
    // body and its cleanup then runs against a pool `afterAll` has ended. A
    // leaked DATABASE is caught by `created`; a leaked ROLE needs this list,
    // and this cluster is shared with every other worktree.
    for (const role of roles) {
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined)
    }
    // Hygiene, deliberately AFTER every assertion and deliberately unable to
    // fail one.
    //
    // The cases exclude other runs' litter so their verdict does not depend on
    // it; without this, that litter would accumulate forever on a long-lived
    // container, one leftover per interrupted run. So the reclamation happens
    // here, where it decides nothing.
    //
    // Its own ceiling, because `afterAll` inherits `hookTimeout: 30_000` and a
    // hook that overruns fails the FILE with no test named. Racing it is safe for
    // the same reason the production boot sweep races it, and this suite proves
    // that reason two cases down: an abandoned DROP completes server-side.
    // Shipped caps, not the widened ones the cases use: nothing is asserted
    // here, so there is no reason to authorise more than production would.
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      dropOrphanedRestoreDatabases(TEST_DATABASE_URL!, { minimumAgeMs: SIX_HOURS })
        .catch(() => undefined),
      new Promise((resolve) => { timer = setTimeout(resolve, 20_000); timer.unref?.() }),
    ])
    if (timer) clearTimeout(timer)
    await admin.end().catch(() => undefined)
  }, 180_000)

  it('dates a name the real minter produced, so the two cannot drift apart', async () => {
    // Not a hand-written twin: if `createTemporaryRestoreDatabase` ever changes
    // its format, the sweep stops recognising its own litter and silently
    // reclaims nothing. This is the assertion that fails when that happens.
    const minted = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    try {
      const age = restoreDatabaseAgeMs(minted.database, Date.now())
      expect(age).not.toBeNull()
      expect(age!).toBeLessThan(60_000)
    } finally {
      await minted.drop().catch(() => undefined)
    }
    // Not the default 20 s: `createTemporaryRestoreDatabase` plus its `drop()`
    // is two round trips and one forced drop, which measured 35 s median under
    // eight writers. A give-up bound, matching every other real-cluster case in
    // this file.
  }, 180_000)

  it('drops the old orphan and NOTHING else, with foreign litter in the way', async () => {
    const orphan = await makeDatabase(aged(24 * 60 * 60 * 1000))
    const young = await makeDatabase(aged(60_000))
    // A source database that is itself a restore database, and old. This is not
    // hypothetical: the suite above builds its source with exactly this call.
    const sourceLike = await makeDatabase(aged(24 * 60 * 60 * 1000))
    // Matches `datname LIKE 'maplespire_restore_%'` — `_` is a LIKE wildcard —
    // but is not one of ours.
    const decoy = await makeDatabase(`maplespireXrestoreY${Date.now().toString(36)}_deadbeef`)
    // An interrupted earlier run's leftover, MANUFACTURED rather than waited
    // for. Disowned on purpose — `makeStray`, not `makeDatabase` — so the
    // exclusion has to FIND it, and dated 48 h so `candidates.sort()` puts it
    // AHEAD of the orphan. Without it the exclusion is inert on a clean
    // cluster: an implementation that ignored `exclude` entirely would pass and
    // the assertion below would be testing nothing.
    const litter = await makeStray(aged(48 * 60 * 60 * 1000))

    const foreign = await everySweepableExcept([orphan, young, sourceLike, decoy])
    // Conjunctive: the exclusion must have SEEN the litter, or `candidates`
    // below is 1 for the wrong reason.
    expect(foreign).toContain(litter)

    const swept = await dropOrphanedRestoreDatabases(
      databaseUrlWithName(TEST_DATABASE_URL!, sourceLike),
      {
        minimumAgeMs: SIX_HOURS,
        exclude: foreign,
        // Named, never inherited. A budget this case does not choose is a
        // second uncontrolled variable behind the assertion. This case is about
        // SELECTION; the budget has a
        // case of its own below, and the connect-versus-budget relation has one
        // in `backupRestore.test.ts`.
        budgetMs: 120_000,
        // TIGHTER than the shipped default of 5, not looser: a large cap binds
        // only when the exclusion has already missed something — and there it
        // would authorise many forced drops against databases another checkout
        // owns. With exactly one candidate asserted, two is one slot of
        // slack: enough that an exclusion miss shows up as `candidates`, small
        // enough that it cannot become an incident.
        maxDrops: 2,
      },
    )

    // Exactly one candidate, and it is ours. `toContain(orphan)` alone is weak
    // in both directions: true of a sweep that also ate forty of somebody
    // else's databases, false of a correct sweep that ran out of budget three
    // databases before reaching ours.
    //
    // This one line does four jobs: `young` was rejected by the age gate,
    // `decoy` by the name test, `sourceLike` by being the source, `litter` by
    // `exclude`. (`remaining === 0` would add nothing: `0` is that field's
    // degenerate value, so a hardcoded `0` would pass it.)
    expect(swept.candidates).toBe(1)
    expect(swept.dropped).toEqual([orphan])
    expect(await exists(orphan)).toBe(false)
    expect(await exists(sourceLike)).toBe(true)
    expect(await exists(young)).toBe(true)
    expect(await exists(decoy)).toBe(true)
    // Another run's database is not this suite's to reclaim, and saying so is
    // the difference between "excluded" and "not reached yet".
    expect(await exists(litter)).toBe(true)
    expect(swept.failed).toEqual([])
    // A give-up bound, not a target: one forced drop measured 35 s median and
    // 301 s worst under eight writers, and every neighbouring case in this file
    // that touches the real cluster carries the same 180 s. Inheriting the
    // global 20 s here would turn a slow cluster into a red test.
    //
    // What it does NOT do, stated because the number invites the opposite
    // reading: it does not make contention survivable. At the 301 s worst case
    // this case is red either way — it just says "timed out" instead of
    // "wrong database", which is a bound that names the step rather than one
    // that names nothing.
  }, 180_000)

  it('finishes a drop nobody is waiting for, which is what makes the ceiling safe', async () => {
    // The load-bearing premise of the teardown ceiling: it abandons the
    // promise, not the work. If PostgreSQL ever stopped completing an abandoned DROP, the drill
    // would leak a database every night and only the sweep would notice — so
    // this is an assertion rather than a sentence in a comment.
    const doomed = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    const seed = guardIdleClientErrors(new Pool({ connectionString: doomed.url, max: 1 }), 'backupRestore:seed')
    await seed.query(`CREATE TABLE bulk AS SELECT g, repeat('x', 900) pad FROM generate_series(1, 200000) g`)
    await seed.end()

    let settled = false
    const abandoned = doomed.drop().then(() => { settled = true }, () => { settled = true })
    // Deliberately NOT awaited here — that is the whole scenario.
    expect(await Promise.race([
      abandoned.then(() => 'drop' as const),
      new Promise<'ceiling'>((r) => setTimeout(() => r('ceiling'), 1)),
    ])).toBe('ceiling')

    // 120 s of polling: a forced drop is 40 ms on an idle cluster but measured
    // 35 s median and 301 s worst under eight writers. A negative here does not mean "PostgreSQL abandoned the work" —
    // it means the poll gave up first, which is the opposite conclusion from
    // the one this case exists to draw.
    for (let i = 0; i < 1_200 && await exists(doomed.database); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(await exists(doomed.database)).toBe(false)
    // The closure awaits `admin.end()` in its own `finally` before resolving, so
    // a settled promise is also proof that the admin pool did not leak.
    await abandoned
    expect(settled).toBe(true)
  }, 180_000)

  it('refuses an age gate low enough to eat a neighbouring test worker', async () => {
    // Several vitest workers share one cluster and the suite above builds its
    // SOURCE database with `createTemporaryRestoreDatabase`. A test that lowered
    // this would not fail — it would delete another worker's data.
    await expect(dropOrphanedRestoreDatabases(TEST_DATABASE_URL!, { minimumAgeMs: 0 }))
      .rejects.toThrow(/Refusing to sweep/)
  })

  it('reclaims a database left invalid by a drop that was killed in flight', async () => {
    // Measured: killing the backend mid-`DROP DATABASE` leaves `datconnlimit =
    // -2` — PostgreSQL 16 marks the database invalid so nothing can connect to
    // it — and only another DROP can clear it. That matters here because the
    // scheduler is SIGKILLed on every deploy that overruns its grace period, so
    // the sweep is the repair path, not just the tidy-up.
    const name = `maplespire_restore_${(Date.now() - 24 * 60 * 60 * 1000).toString(36)}_${randomBytes(4).toString('hex')}`
    await makeDatabase(name)
    await admin.query('UPDATE pg_database SET datconnlimit = -2 WHERE datname = $1', [name])
    const marked = await admin.query<{ datconnlimit: number }>(
      'SELECT datconnlimit FROM pg_database WHERE datname = $1', [name])
    // Asserted, not assumed. The catalog write needs superuser; where it is
    // refused this test would otherwise degrade silently into a re-run of the
    // ordinary sweep case and report coverage it does not have.
    expect(marked.rows[0]?.datconnlimit, 'could not mark the database invalid').toBe(-2)

    // The same treatment as the case above: with the default `maxDrops` of 5
    // and default budget, five leftovers dated before this one would make it
    // red on their own, with no contention required at all.
    //
    // `[name]` alone is the ownership list — per CASE, not per suite (see
    // `everySweepableExcept`), so this case cannot destroy the first case's
    // `sourceLike` fixture or spend its budget on it.
    const swept = await dropOrphanedRestoreDatabases(TEST_DATABASE_URL!, {
      minimumAgeMs: SIX_HOURS,
      exclude: await everySweepableExcept([name]),
      budgetMs: 120_000,
      maxDrops: 2,
    })

    // `candidates`, for the same reason as the case above: it pins that the
    // sweep considered ONE database and reclaimed it, where `toContain` alone
    // is satisfied by any amount of collateral damage around it.
    expect(swept.candidates).toBe(1)
    expect(swept.dropped).toEqual([name])
    expect(await exists(name)).toBe(false)
  }, 180_000)

  it('reports what a spent budget left behind instead of implying it finished', async () => {
    const first = await makeDatabase(aged(24 * 60 * 60 * 1000))
    const second = await makeDatabase(aged(25 * 60 * 60 * 1000))

    // A budget already spent before the first drop is attempted. The sweep must
    // stop STARTING drops rather than inherit the unbounded wait it exists to
    // clean up after — and must say how many it left, because a cap nobody is
    // told about reads as "there was nothing else".
    const swept = await dropOrphanedRestoreDatabases(TEST_DATABASE_URL!, {
      minimumAgeMs: SIX_HOURS,
      budgetMs: -1,
    })

    expect(swept.dropped).toEqual([])
    expect(swept.completed).toBe(true)
    expect(swept.candidates).toBeGreaterThanOrEqual(2)
    expect(swept.remaining).toBe(swept.candidates)
    expect(await exists(first)).toBe(true)
    expect(await exists(second)).toBe(true)
  })

  it('reclaims PAST litter it can never drop, at the boot sweep\'s own cap', async () => {
    // The starvation, against a real cluster, with a real permanent failure.
    //
    // The unit suite drives this through `createPool` because "a real cluster
    // offers no deterministic way to make DROP DATABASE fail" — true for the
    // failures this file's comment had in mind (`max_prepared_transactions` is
    // 0 and `wal_level` is `replica`, so neither a prepared transaction nor a
    // logical slot can be arranged), and NOT true in general. OWNERSHIP gives a
    // permanent, instant one: a role that does not own a database cannot drop
    // it, ever, no matter how long the sweep runs.
    //
    // That matters more than the extra coverage. A loop that charged a failure
    // to `maxDrops` would starve: `candidates` is sorted oldest-first while an
    // undroppable database is never reclaimed, so such a database drifts to
    // the head and stays there. At the boot sweep's `maxDrops: 2`, TWO of them
    // would stop every boot sweep forever.
    const suffix = randomBytes(4).toString('hex')
    const role = `sweep_starve_${suffix}`
    const password = `pw_${suffix}`
    // Owned by the superuser this suite connects as: the weak role below can
    // never drop these. Older than the reclaimable one, so the oldest-first
    // walk puts them in FRONT — the position that does the starving.
    const stubborn = [
      await makeDatabase(aged(72 * 60 * 60 * 1000)),
      await makeDatabase(aged(71 * 60 * 60 * 1000)),
    ]
    const reclaimable = aged(48 * 60 * 60 * 1000)
    const exclude = await everySweepableExcept([...stubborn, reclaimable])

    const weakUrl = new URL(databaseUrlWithName(TEST_DATABASE_URL!, 'postgres'))
    weakUrl.username = role
    weakUrl.password = password

    try {
      roles.push(role)
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`)
      await admin.query(`CREATE DATABASE "${reclaimable}" TEMPLATE template0 OWNER "${role}"`)
      created.push(reclaimable)

      const swept = await dropOrphanedRestoreDatabases(weakUrl.toString(), {
        minimumAgeMs: SIX_HOURS,
        // Exactly what `sweepOrphanedRestoreDatabasesAtBoot` passes. The whole
        // claim is about this number, so it is written here rather than
        // defaulted.
        maxDrops: 2,
        budgetMs: 120_000,
        exclude,
      })

      // Conjunctive, because either half alone is satisfiable by a starving
      // loop: it would also report two failures and three candidates.
      expect(swept.candidates).toBe(3)
      expect(swept.failed).toHaveLength(2)
      expect(swept.failed.join(' ')).toContain('must be owner of database')
      // The point. A starving loop returns `[]` and the database survives.
      expect(swept.dropped).toEqual([reclaimable])
      expect(await exists(reclaimable)).toBe(false)
      // The two it could not drop are still there, which is what makes the
      // NEXT boot's report honest rather than a silent loss.
      expect(await exists(stubborn[0]!)).toBe(true)
      expect(await exists(stubborn[1]!)).toBe(true)
    } finally {
      // The role owns nothing once its database is gone, but the sweep may have
      // been the thing that failed, so drop defensively and in dependency order.
      await admin.query(`DROP DATABASE IF EXISTS "${reclaimable}" WITH (FORCE)`).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined)
    }
  }, 180_000)

  it('SEES the foreign-owned litter that starves the sweep, from a role owning nothing', async () => {
    // The census is the consequence check for the sweep above, and this is the
    // single property the whole design rests on: it must be able to see litter
    // the sweep CANNOT reclaim. The measured starvation failure is an ownership
    // error, so the databases that starve the sweep belong to another role — and
    // if `pg_database` visibility followed ownership, this census would be blind
    // in exactly the place the sweep is blind, for the same reason. It would then
    // agree with a broken sweep instead of catching it, which is the failure mode
    // a consequence check exists to be immune to.
    //
    // Pinned against a real cluster rather than reasoned from the docs, because
    // a catalogue visibility rule is precisely the kind of thing a major version
    // can tighten, and the metric would go quiet rather than red.
    const suffix = randomBytes(4).toString('hex')
    const role = `census_blind_${suffix}`
    const password = `pw_${suffix}`
    // Superuser-owned and far past the age gate: the weak role can never drop
    // this, which is what makes it the discriminating case.
    const stubborn = await makeDatabase(aged(72 * 60 * 60 * 1000))
    const young = await makeDatabase(aged(60 * 1000))
    const weakUrl = new URL(databaseUrlWithName(TEST_DATABASE_URL!, 'postgres'))
    weakUrl.username = role
    weakUrl.password = password
    let weak: Pool | undefined

    try {
      roles.push(role)
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`)
      weak = guardIdleClientErrors(new Pool({ connectionString: weakUrl.toString(), max: 1 }), 'backupRestore:weak-role')

      const seen = await readRestoreDatabaseCensus(weak, SIX_HOURS)
      const { rows } = await weak.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE NOT datistemplate',
      )
      const names = rows.map((row) => row.datname)

      // The claim, stated three ways because the count alone would also be
      // satisfied by a census that saw some OTHER suite's leftovers.
      expect(names).toContain(stubborn)
      expect(names).toContain(young)
      expect(seen.counts.reclaimable).toBeGreaterThanOrEqual(1)

      // And it classifies them the way the sweep would: the 72 h one is litter,
      // the 60 s one could still belong to a drill in flight. Asserting both
      // directions matters — a classifier that called everything reclaimable
      // would pass the first assertion and have this suite's own in-flight restore
      // database reported as litter to an operator.
      const now = Date.now()
      expect(classifyRestoreDatabase(stubborn, now, SIX_HOURS)).toBe('reclaimable')
      expect(classifyRestoreDatabase(young, now, SIX_HOURS)).toBe('live')

      // A DELTA, never an absolute: the census is cluster-wide, so another
      // suite's leftovers are legitimately in these counts and an equality
      // assertion here would be a flake that reads as a real finding — the same
      // mistake the exclusion above exists to fix, one layer over.
      const before = seen.counts.reclaimable
      const planted = await makeDatabase(aged(96 * 60 * 60 * 1000))
      const after = await readRestoreDatabaseCensus(weak, SIX_HOURS)
      expect(after.counts.reclaimable).toBe(before + 1)
      expect(after.oldestReclaimableAgeMs).toBeGreaterThanOrEqual(96 * 60 * 60 * 1000)
      expect(await exists(planted)).toBe(true)
    } finally {
      await weak?.end().catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined)
    }
  }, 120_000)
})

/**
 * Contentless mapped documents must neither stop the backup nor go uncounted.
 *
 * A candidate predicate of
 * `EXISTS (SELECT 1 FROM automerge_storage WHERE split_part(key,'/',1) = document_id)`
 * is satisfied by a 2-byte `<id>/sync-state/<uuid>` row — automerge-repo's own
 * peer bookkeeping, never document content — so such documents get SELECTED
 * and then fail their cold load; if probing runs BEFORE `pgTools.dump` and is
 * fatal, the backup aborts before one byte is copied, every night.
 *
 * The same predicate errs the other way as well: documents with no storage row
 * at all are never selected, and are invisible to the gate entirely.
 *
 * The fixtures are built by stripping rows from REAL documents, because
 * `add()` drops anything `isValidAutomergeUrl` rejects — a hand-written id is
 * silently skipped and tests nothing.
 *
 * Every assertion here is CONJUNCTIVE on purpose. Narrowing the predicate alone
 * makes the probes pass and leaves the unopenable documents unmentioned
 * anywhere — loud findings become zero findings, a worse outcome wearing a
 * green badge. So each case pairs "the copy happened" with "the finding was
 * counted", and neither half passes alone.
 */
describe.skipIf(!TEST_DATABASE_URL)('#56 contentless mapped documents', () => {
  let database: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let pool: Pool
  let temporaryDirectory: string
  let tools: PgTools
  let healthyUrl: string
  let syncStateOnlyId: string
  let noRowsId: string

  beforeAll(async () => {
    database = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    pool = guardIdleClientErrors(new Pool({ connectionString: database.url }), 'backupRestore:census')
    // See the note in the suite above: a restore-prefixed database is sweepable
    // by any worker, and an unhandled idle-client error kills this one.
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'maplespire-56-'))
    tools = TEST_CONTAINER ? new DockerPgTools(TEST_CONTAINER) : new NativePgTools()
    await pool.query(`
      CREATE TABLE automerge_storage (
        key TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE automerge_document_workspace (
        document_id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL,
        version_id TEXT NOT NULL
      );
      -- The SECOND candidate branch. It carries its own copy of the same
      -- EXISTS predicate, and a mutation run proved it was covered by nothing:
      -- narrowing only the mapped branch left this one selecting contentless
      -- documents and every test stayed green.
      CREATE TABLE read_model_static_documents (
        document_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL
      );
    `)
    await ensureBackupSchema(pool)

    const repo = new Repo({
      network: [],
      storage: new FixturePostgresStorage(pool),
      saveDebounceRate: 0,
    })
    const healthy = repo.create({ objects: { a: { id: 'a' } } })
    const stripped = repo.create({ objects: { b: { id: 'b' } } })
    const erased = repo.create({ objects: { c: { id: 'c' } } })
    await Promise.all([healthy.whenReady(), stripped.whenReady(), erased.whenReady()])
    await repo.flush([healthy.documentId, stripped.documentId, erased.documentId])
    await repo.shutdown()

    healthyUrl = healthy.url
    syncStateOnlyId = stripped.documentId
    noRowsId = erased.documentId

    for (const id of [healthy.documentId, syncStateOnlyId, noRowsId]) {
      await pool.query(
        `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
         VALUES ($1, 'landscape', 'version')`,
        [id],
      )
    }

    // Shape 2: content gone, a lone 2-byte sync-state row left behind.
    await pool.query(`DELETE FROM automerge_storage WHERE split_part(key, '/', 1) = $1`, [syncStateOnlyId])
    await pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, $2)`,
      [`${syncStateOnlyId}/sync-state/aa38df3e-04d9-41c7-b770-7ecb97d15de5`, Buffer.from([0, 0])],
    )

    // Shape 3: mapped, and not one row anywhere.
    await pool.query(`DELETE FROM automerge_storage WHERE split_part(key, '/', 1) = $1`, [noRowsId])

    // Same contentless document, reachable through the OTHER candidate branch.
    await pool.query(
      `INSERT INTO read_model_static_documents (document_id, kind) VALUES ($1, 'diagram')`,
      [syncStateOnlyId],
    )
  })

  afterAll(async () => {
    await pool?.end()
    await database?.drop()
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  })

  it('holds the three storage shapes measured on the demo stack', async () => {
    const { rows } = await pool.query<{ shape: string; count: string }>(
      `WITH per_document AS (
         SELECT m.document_id,
                count(s.key) FILTER (WHERE split_part(s.key, '/', 2) IN ('snapshot', 'incremental')) AS chunks,
                count(s.key) AS rows_total
         FROM automerge_document_workspace m
         LEFT JOIN automerge_storage s ON split_part(s.key, '/', 1) = m.document_id
         GROUP BY 1)
       SELECT CASE WHEN chunks > 0 THEN 'content'
                   WHEN rows_total > 0 THEN 'sync-state-only'
                   ELSE 'no-rows' END AS shape, count(*)::text
       FROM per_document GROUP BY 1 ORDER BY 1`,
    )
    expect(Object.fromEntries(rows.map((row) => [row.shape, row.count]))).toEqual({
      'content': '1', 'no-rows': '1', 'sync-state-only': '1',
    })
  })

  it('stops probing contentless documents AND still counts every one of them', async () => {
    // Half one: a sync-state row is not content, so it is not a probe candidate,
    // and nothing is attributed to the backup that the backup did not do.
    const report = await collectDocumentProbes(pool)
    expect(report.probes.map((probe) => probe.url)).toEqual([healthyUrl])
    expect(report.failures).toEqual([])

    // Half two, and the half a narrowed predicate cannot deliver on its own: the
    // documents that stopped being probed are still counted, by name.
    const census = await collectDocumentCensus(pool)
    expect(census.status).toBe('complete')
    expect({
      mapped: census.mapped,
      withChunks: census.withChunks,
      syncStateOnly: census.syncStateOnly,
      noRows: census.noRows,
    }).toEqual({ mapped: 3, withChunks: 1, syncStateOnly: 1, noRows: 1 })
    expect(census.unretiredViolations).toBe(2)
    expect([...census.violationSample].sort()).toEqual([noRowsId, syncStateOnlyId].sort())
  })

  it('probes what the manifest NAMES, not what selection would have chosen', async () => {
    // Asking for "the first N candidates" where N is the manifest's probe COUNT
    // works only while a probe failure is fatal: once some probes may fail, the manifest holds the ones that SUCCEEDED
    // while selection returns the first N CANDIDATES, and comparing the two
    // reports documents missing that were never probed. Re-deriving by the same
    // rule is also not an independent witness of anything.
    //
    // So the seam takes URLs. Handing it a document selection would now never
    // pick proves it: the sync-state-only one is probed anyway, and reported.
    const report = await probeDocumentUrls(pool, [
      { url: healthyUrl, kind: 'root:version:active' },
      { url: `automerge:${syncStateOnlyId}`, kind: 'mapped-sample' },
    ])
    expect(report.probes.map((probe) => probe.url)).toEqual([healthyUrl])
    expect(report.failures.map((failure) => failure.url)).toEqual([`automerge:${syncStateOnlyId}`])
    expect(report.coverage.candidatesConsidered).toBe(2)
  })

  it('verifies a restore whose manifest probed FEWER documents than selection would pick', async () => {
    // The shape that makes probe-by-count wrong, built deterministically and
    // WITHOUT corrupting any bytes.
    //
    // `candidateDocumentUrls` runs the ROOTS branch first and gives it no
    // storage predicate at all, so an orphan root — a `versions` row pointing
    // at a document this database never held — is always candidate #1. It fails
    // its cold load; the healthy mapped document succeeds. The manifest
    // therefore names ONE probe while selection's first candidate is a different
    // document.
    //
    // A restore that re-derives "the first N candidates" with N = 1 gets the
    // orphan root, probes nothing, and reports the manifest's document missing —
    // a verification failure invented entirely by re-deriving the witness
    // instead of reading it. Ordering here is structural, not md5 luck, so the
    // test cannot flip between runs.
    //
    // (Do not produce this divergence by corrupting a snapshot chunk: that
    // triggers an unhandled rejection from automerge's WASM loader that no
    // try/catch on the probe path can catch, so tests "pass" while the process
    // exits 1.)
    const scratch = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    const scratchPool = guardIdleClientErrors(new Pool({ connectionString: scratch.url }), 'backupRestore:scratch')
    const target = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    try {
      await scratchPool.query(`
        CREATE TABLE automerge_storage (
          key TEXT PRIMARY KEY,
          data BYTEA NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE automerge_document_workspace (
          document_id TEXT PRIMARY KEY,
          landscape_id TEXT NOT NULL,
          version_id TEXT NOT NULL
        );
        CREATE TABLE versions (
          id TEXT PRIMARY KEY,
          landscape_id TEXT NOT NULL,
          root_url TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL
        );
      `)
      await ensureBackupSchema(scratchPool)

      const repo = new Repo({
        network: [],
        storage: new FixturePostgresStorage(scratchPool),
        saveDebounceRate: 0,
      })
      const kept = repo.create({ objects: { one: { id: 'one' } } })
      await kept.whenReady()
      await repo.flush([kept.documentId])
      await repo.shutdown()
      await scratchPool.query(
        `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
         VALUES ($1, 'landscape', 'version')`,
        [kept.documentId],
      )

      const orphanRepo = new Repo({ network: [] })
      const orphanRoot = orphanRepo.create({ modelUrl: 'automerge:none' }).url
      await orphanRepo.shutdown()
      await scratchPool.query(
        `INSERT INTO versions (id, landscape_id, root_url, kind, status)
         VALUES ('lost', 'landscape', $1, 'draft', 'active')`,
        [orphanRoot],
      )

      const bundleDirectory = join(temporaryDirectory, 'bundle-divergent')
      const manifest = await createDatabaseBackup({
        databaseUrl: scratch.url,
        bundleDirectory,
        pgTools: tools,
        assetDirectory: join(temporaryDirectory, 'no-assets'),
      })
      expect(manifest.documentProbes.map((probe) => probe.url)).toEqual([kept.url])
      expect(manifest.documentProbeFailures?.map((failure) => failure.url)).toEqual([orphanRoot])

      const verification = await restoreAndVerifyDatabase({
        sourceDatabaseUrl: scratch.url,
        targetDatabaseUrl: target.url,
        bundleDirectory,
        pgTools: tools,
      })
      expect(verification.outcome).toBe('passed')
      expect(verification.documentProbes).toBe(1)
    } finally {
      await scratchPool.end()
      await scratch.drop()
      await target.drop()
    }
  }, 180_000)

  it('the census adds up — every mapped document lands in exactly one bucket', async () => {
    const census = await collectDocumentCensus(pool)
    expect(census.withChunks! + census.syncStateOnly! + census.noRows!).toBe(census.mapped)
  })

  it('writes the bundle AND records the finding — neither half alone', async () => {
    // The regression this exists to stop, in one assertion pair. Re-add the
    // throw and the bundle directory is missing; suppress the finding and the
    // count is zero. A run has to satisfy both to be a pass.
    const bundleDirectory = join(temporaryDirectory, 'bundle')
    const manifest = await createDatabaseBackup({
      databaseUrl: database.url,
      bundleDirectory,
      pgTools: tools,
      assetDirectory: join(temporaryDirectory, 'no-assets'),
    })

    const dump = await stat(join(bundleDirectory, 'database.dump'))
    expect(dump.size).toBeGreaterThan(0)
    expect(JSON.parse(await readFile(join(bundleDirectory, 'manifest.json'), 'utf8')).format)
      .toBe('maplespire-postgres-backup-v2')

    expect(manifest.documentCensus?.unretiredViolations).toBe(2)
    expect(manifest.documentCensus?.syncStateOnly).toBe(1)
    expect(manifest.documentCensus?.noRows).toBe(1)
    expect(manifest.documentProbes.map((probe) => probe.url)).toEqual([healthyUrl])
    expect(manifest.probeCoverage?.probed).toBe(1)
  })

  it('refuses to call the census complete when a chunk kind is unrecognised', async () => {
    // The census classifies with a GROUP BY rather than a WHERE ... IN, so a
    // future storage layout cannot be silently exempted — which is the original
    // defect one layer up, and it would be committed by the very code auditing
    // for it.
    await pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, $2)`,
      [`${noRowsId}/some-future-chunk/1`, Buffer.from([1])],
    )
    try {
      const census = await collectDocumentCensus(pool)
      expect(census.status).toBe('incomplete')
      expect(census.otherChunkKinds).toEqual({ 'some-future-chunk': 1 })
    } finally {
      await pool.query(`DELETE FROM automerge_storage WHERE key = $1`, [`${noRowsId}/some-future-chunk/1`])
    }
  })

  it('reports nulls, never zeros, when the census cannot be taken', async () => {
    // "We could not count" and "there is nothing to count" must not be the same
    // answer — the report is signed, so a zero here would be a forgery-proof
    // clean bill of health nobody earned.
    const broken = {
      query: async (text: string) => {
        if (text.includes('to_regclass')) return { rows: [{ present: true }] } as never
        throw new Error('census query refused')
      },
    }
    const census = await collectDocumentCensus(broken as never)
    expect(census.status).toBe('incomplete')
    expect(census.mapped).toBeNull()
    expect(census.syncStateOnly).toBeNull()
    expect(census.unretiredViolations).toBeNull()
  })

  it('an operator retirement removes the violation without hiding the shape', async () => {
    await retireDocument(pool, {
      documentId: syncStateOnlyId,
      reason: 'known-empty fixture document',
      retiredBy: 'test',
    })
    try {
      const census = await collectDocumentCensus(pool)
      // The count an operator signed off drops...
      expect(census.unretiredViolations).toBe(1)
      // ...but the shape census does NOT lie about what is in the database.
      expect(census.syncStateOnly).toBe(1)
      expect(census.noRows).toBe(1)
    } finally {
      await reinstateDocument(pool, syncStateOnlyId)
    }
  })
})
