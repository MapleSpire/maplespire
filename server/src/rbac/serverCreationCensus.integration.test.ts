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
 * THE CENSUS that enabling `SYNC_CELL_UNPLACED_CREATION=refuse` rests on:
 * every server-minted document reaches the storage fence with a workspace some
 * source can name.
 *
 * ## What the numbers mean
 *
 * `PostgresStorageAdapter.snapshot()` splits the mutations it admitted WITHOUT a
 * durable `automerge_document_workspace` row into three:
 *
 *   quarantined            — admitted with no durable row (the whole set)
 *   provisionallyFenced    — of those, checked against the ROUTE GATE's placement
 *   bootstrapFenced        — of those, checked against the FORKER's lease
 *
 * So `quarantined - provisionallyFenced - bootstrapFenced` is the population
 * that reached the fence with NOTHING to check a lease against — what
 * `SYNC_CELL_UNPLACED_CREATION=refuse` would start refusing. It must read ZERO
 * with a NON-ZERO placed count: a run that created nothing would report zero
 * unplaced and prove nothing, so `placed > 0` is asserted too.
 *
 * The active-active outage bench measures the same counters across a Redis
 * outage on two cells; this suite keeps the property checked in `ci:local`.
 */
import { Repo } from '@automerge/automerge-repo'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { PostgresStorageAdapter } from '../automergeStorage.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('B2-9 — the OBSERVE census: no server-minted document reaches the fence unplaced', () => {
  let db: IsolatedSchemaDb
  let landscapes: typeof import('../landscapes.js')
  let bootstrapScope: typeof import('../bootstrapScope.js')
  let placement: typeof import('./serverCreationPlacement.js')
  let repo: Repo
  let adapter: PostgresStorageAdapter
  let orgId: string
  let uninstall: (() => void) | null = null
  const savedMode = process.env.SYNC_CELL_UNPLACED_CREATION

  beforeAll(async () => {
    // THE DEFAULT IS THE SUBJECT: this census is what OBSERVE reports, so the
    // variable is cleared rather than set, and the arm below asserts that a
    // cleared variable really is `observe`.
    delete process.env.SYNC_CELL_UNPLACED_CREATION
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'server_creation_census')
    vi.doMock('../db.js', () => ({ pool: db.pool }))
    vi.resetModules()

    const authSchema = await import('../auth/schema.js')
    const rbacSchema = await import('./schema.js')
    await authSchema.ensureAuthSchema(db.pool)
    await rbacSchema.ensureRbacSchema(db.pool)
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT,
        org_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL, root_url TEXT NOT NULL, parent_version_id TEXT,
        kind TEXT NOT NULL DEFAULT 'version', status TEXT NOT NULL DEFAULT 'active',
        base_manifest JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await db.pool.query('CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq')
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS automerge_storage (
        key TEXT PRIMARY KEY, data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq')
      )
    `)
    const ownership = await import('../syncCells/ownership.js')
    await ownership.ensureSyncCellOwnershipSchema(db.pool)
    const readModelSchema = await import('../readModel/schema.js')
    await readModelSchema.ensureReadModelSchema(db.pool)
    orgId = await authSchema.ensureDefaultOrg(db.pool)

    landscapes = await import('../landscapes.js')
    bootstrapScope = await import('../bootstrapScope.js')
    placement = await import('./serverCreationPlacement.js')
    const docScope = await import('./docScope.js')

    // A cell that OWNS everything: the census counts what the fence was given
    // to check, not whether the check passed, so a refusal here would only add
    // noise to a number about placement.
    //
    // THE TWO PLACEMENT SOURCES ARE PASSED, NOT DEFAULTED. This suite mocks
    // `../db.js` and resets the module graph, so there are TWO instances of
    // `serverCreationPlacement`: the one the statically imported adapter
    // closed over (its default), and the one `createDraft` populates. With the
    // default, every fenced creation would count as UNPLACED. Importing the
    // adapter dynamically does not work either: it would resolve `withDbRetry`
    // from the `../db.js` mock, which only provides `pool`.
    const provisionalSource = await import('./provisionalPlacementSource.js')
    adapter = new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: () => '7' },
      provisionalPlacement: (documentId) =>
        provisionalSource.provisionalPlacementFor(documentId) ?? placement.placementForFence(documentId),
      bootstrapPlacement: (documentId) => placement.bootstrapPlacementFor(documentId),
    })
    repo = new Repo({ storage: adapter })
    new docScope.WorkspaceDocIndex(repo, db.pool)
    uninstall = bootstrapScope.installBootstrapOwnership({
      required: () => true,
      current: () => ({ enabled: true, owns: () => true, fencingToken: () => '7' }),
    })
  }, 120_000)

  afterEach(() => {
    if (savedMode === undefined) delete process.env.SYNC_CELL_UNPLACED_CREATION
    else process.env.SYNC_CELL_UNPLACED_CREATION = savedMode
  })

  afterAll(async () => {
    uninstall?.()
    placement?.resetServerCreationPlacementForTest()
    await db?.teardown()
    vi.doUnmock('../db.js')
    vi.resetModules()
  })

  it('a real creation smoke leaves ZERO unplaced mutations, and a NON-ZERO placed count', async () => {
    delete process.env.SYNC_CELL_UNPLACED_CREATION
    const before = adapter.snapshot()

    // The smoke, in TWO measured halves, because the two populations are not
    // the same claim. `createLandscape` opens an `unfenced` scope by design —
    // no landscape row exists yet, so no lease could authorise its documents,
    // and `bootstrapScope.ts` calls that "a declared, counted population, not
    // an omission". Folding it in would make `unplaced === 0` unsatisfiable by
    // construction.
    const landscape = await landscapes.createLandscape(repo, 'census landscape', orgId)
    await repo.flush()
    const afterUnfenced = adapter.snapshot()

    // THE LEASE, which a real cell holds and a fixture has to write. Without
    // the row the fence's SQL refuses every fork with `StaleSyncCellWriteError`
    // however non-null `fencingToken` is — the token is compared AGAINST this
    // row. That refusal would be correct behaviour, but would pollute the
    // census, so the row is seeded.
    await db.pool.query(
      `INSERT INTO sync_workspace_ownership (
         landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, released_at
       ) VALUES ($1, $2, 'census-cell', '7', NOW() + INTERVAL '1 hour', NULL)
       ON CONFLICT (landscape_id, version_id) DO UPDATE SET fencing_token = EXCLUDED.fencing_token, released_at = NULL`,
      [landscape.id, landscape.defaultVersionId],
    )

    const draft = await landscapes.createDraft(repo, landscape.id, 'census draft')
    expect(draft, 'the draft was created').not.toBeNull()
    const version = await landscapes.createVersion(repo, landscape.id, 'census version')
    expect(version, 'the version was created').not.toBeNull()
    await repo.flush()

    const after = adapter.snapshot()
    const between = (from: typeof before, to: typeof before, key: keyof typeof before): number =>
      Number(to[key]) - Number(from[key])

    // ── The FENCED half: the two forks, which is what the `refuse` flag governs ──
    const quarantined = between(afterUnfenced, after, 'quarantinedMutationCount')
    const placed = between(afterUnfenced, after, 'provisionallyFencedMutationCount')
      + between(afterUnfenced, after, 'bootstrapFencedMutationCount')

    // THE VOID GUARD. A smoke that minted nothing would report zero unplaced
    // and prove nothing at all, so the placed count is asserted FIRST
    // (measured at 12: six documents per fork, two forks).
    expect(placed, 'the forks minted nothing the fence could place — this run measured NOTHING').toBeGreaterThan(0)
    expect(
      quarantined - placed,
      `${quarantined - placed} of ${quarantined} forked mutations reached the fence with no workspace to check a `
      + 'lease against. Arming SYNC_CELL_UNPLACED_CREATION=refuse would start refusing them',
    ).toBe(0)

    // ── The UNFENCED half: declared, and COUNTED rather than waved past ──
    // `createLandscape` opens `{ kind: 'unfenced', reason: 'no-forker' }`: no
    // landscape row exists yet, so no lease could authorise its documents.
    // Those mutations ARE unplaced, permanently and by design (measured at 6),
    // which is why the criterion above is stated over the forks. What must not
    // drift is the REASON: an unfenced scope opened for any other reason —
    // ownership disabled, ownership not installed — would be a cell that
    // stopped fencing, wearing the same zero.
    const unfencedQuarantined = between(before, afterUnfenced, 'quarantinedMutationCount')
    expect(unfencedQuarantined, 'the landscape creation wrote nothing — this half measured NOTHING').toBeGreaterThan(0)
    expect(
      between(before, afterUnfenced, 'provisionallyFencedMutationCount')
      + between(before, afterUnfenced, 'bootstrapFencedMutationCount'),
      'a landscape creation was placed — the declared unfenced population changed shape',
    ).toBe(0)
    const scopes = bootstrapScope.bootstrapScopeSnapshot()
    expect(scopes.unfencedByReason['no-forker'], 'the unfenced scope was the landscape creation').toBeGreaterThan(0)
    expect(
      scopes.unfencedByReason['ownership-disabled'] + scopes.unfencedByReason['ownership-not-installed'],
      'a scope went unfenced because ownership was missing, not because it had no forker',
    ).toBe(0)
  }, 60_000)

  it('WHAT THE FLIP WOULD DO: the same smoke under `refuse`, measured rather than argued', async () => {
    // The census above does NOT read zero over the whole smoke: the landscape
    // creation contributes an unfenced population by design. So the real
    // question is whether `refuse` REACHES that population — answered by
    // setting the variable and running the same creations.
    process.env.SYNC_CELL_UNPLACED_CREATION = 'refuse'
    const before = adapter.snapshot()

    const landscape = await landscapes.createLandscape(repo, 'refuse-mode landscape', orgId)
    await repo.flush()
    await db.pool.query(
      `INSERT INTO sync_workspace_ownership (
         landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, released_at
       ) VALUES ($1, $2, 'census-cell', '7', NOW() + INTERVAL '1 hour', NULL)
       ON CONFLICT (landscape_id, version_id) DO UPDATE SET fencing_token = EXCLUDED.fencing_token, released_at = NULL`,
      [landscape.id, landscape.defaultVersionId],
    )
    const draft = await landscapes.createDraft(repo, landscape.id, 'refuse-mode draft')
    expect(draft, 'the draft was created under `refuse`').not.toBeNull()
    await repo.flush()

    const after = adapter.snapshot()
    // NOTHING WAS REFUSED. `placementForFence` reads the OWNER tier
    // (`createClaimedDocument`'s documents); these creations use
    // `provisionalPlacementFor` and `bootstrapPlacementFor`, neither of which
    // the flag gates. So the flip does not reach the population the census
    // cannot bring to zero.
    //
    // Limit: this is a negative over a set these paths leave EMPTY, so it only
    // goes red if one of these creations starts landing in the owner tier. The
    // gate's positive direction is covered by `serverCreationPlacement.test.ts`.
    // The second assertion keeps the pair non-vacuous: the fork WAS fenced.
    expect(
      Number(after.rejectedMutationCount) - Number(before.rejectedMutationCount),
      '`refuse` rejected a server creation — the flip reaches the bootstrap population after all',
    ).toBe(0)
    expect(
      Number(after.bootstrapFencedMutationCount) - Number(before.bootstrapFencedMutationCount),
      'the fork was still fenced under its forker lease while `refuse` was set',
    ).toBeGreaterThan(0)
  }, 60_000)

  it('NO committed manifest arms the refusal — `observe` stays the shipped default', async () => {
    // The flip is a CONFIG change, so its safety lives in the manifests rather
    // than in the code; this checks that nothing ships with `refuse`.
    // Manifests are WALKED, not listed, so a new manifest cannot be missed.
    const { readdirSync, readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { join } = await import('node:path')
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const manifests = [
      ...readdirSync(root).filter((f) => /^(compose|docker-compose)\..*\.ya?ml$/.test(f)),
      ...readdirSync(root).filter((f) => /^docker-compose\.ya?ml$/.test(f)),
      ...readdirSync(join(root, 'infra/compose')).filter((f) => /\.ya?ml$/.test(f)).map((f) => join('infra/compose', f)),
      ...readdirSync(join(root, 'docker')).filter((f) => /\.ya?ml$/.test(f)).map((f) => join('docker', f)),
    ]
    expect(manifests.length, 'the manifest walk found nothing — the scan is broken, not the tree').toBeGreaterThan(2)

    const arming: string[] = []
    for (const relative of manifests) {
      for (const line of readFileSync(join(root, relative), 'utf8').split(/\r?\n/)) {
        if (!line.includes('SYNC_CELL_UNPLACED_CREATION') || line.trim().startsWith('#')) continue
        const value = line.split('#')[0]!.split(':').slice(1).join(':').trim().replace(/^["']|["']$/g, '').trim().toLowerCase()
        if (value === 'refuse') arming.push(`${relative.replace(/\\/g, '/')}: ${line.trim()}`)
      }
    }
    expect(
      arming,
      'a committed manifest arms SYNC_CELL_UNPLACED_CREATION=refuse. That refusal lands on documents whose '
      + 'creator may have nowhere to be routed; B2-9 arms it deliberately, after a census, not by a manifest edit',
    ).toEqual([])
  })
})
