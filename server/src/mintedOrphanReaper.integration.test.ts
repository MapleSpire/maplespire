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

import { readFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { Repo, interpretAsDocumentId, type BinaryDocumentId } from '@automerge/automerge-repo'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from './testing/isolatedSchema.js'
import { PostgresStorageAdapter } from './automergeStorage.js'
import { createEmptyRoot } from './automergeServer.js'
import { forkRoot } from './forkRoot.js'
import { createBootstrapDocument, resetBootstrapMintCountersForTest } from './bootstrapMint.js'
import { claimWorkspaceDocuments } from './rbac/documentClaims.js'
import { setWorkspaceDocumentsRegistrationForTest } from './rbac/docScope.js'
import { mintDocumentIdBytes, type WorkspaceRef } from './rbac/documentIdMint.js'
import {
  reapMintedOrphans,
  mintedOrphanReaperMetricSamples,
  resetMintedOrphanReaperCountersForTest,
} from './mintedOrphanReaper.js'
import { openBootstrapScope } from './bootstrapScope.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/**
 * The reaper is DESTRUCTIVE, so every arm below states the presence it is
 * protecting before it asserts the absence it is checking, and every
 * "untouched" arm has a sibling that IS reaped in the same run — otherwise a
 * reaper that deletes nothing at all would pass every protective arm green.
 */
describe.skipIf(!TEST_DATABASE_URL)('minted-orphan reaper (live Postgres + real Automerge storage)', () => {
  let db: IsolatedSchemaDb
  let repo: Repo
  let restoreRegistration: () => void = () => {}
  const savedSecret = process.env.AUTH_SECRET
  const HOUR = 60 * 60 * 1_000

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'minted_orphan_reaper')
    process.env.AUTH_SECRET = 'minted-orphan-reaper-test-secret'
    const authSchema = await import('./auth/schema.js')
    const rbacSchema = await import('./rbac/schema.js')
    await authSchema.ensureAuthSchema(db.pool)
    await rbacSchema.ensureRbacSchema(db.pool)
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT, org_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL, root_url TEXT NOT NULL, parent_version_id TEXT,
        kind TEXT NOT NULL DEFAULT 'version', status TEXT NOT NULL DEFAULT 'active',
        base_manifest JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    const ownership = await import('./syncCells/ownership.js')
    await ownership.ensureSyncCellOwnershipSchema(db.pool)
    // Only the ONE read-model table the reaper touches, by hand: the full
    // `ensureReadModelSchema` needs the pg_trgm extension, which a plain
    // Postgres container does not carry, and the reaper's DELETE needs
    // nothing of it but the column.
    await db.pool.query(`CREATE TABLE IF NOT EXISTS read_model_document_watermarks (document_id TEXT PRIMARY KEY)`)
    // The snapshots table, mirroring db.ts: the reaper reads it as a liveness
    // root and REFUSES to run without it.
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS landscape_versions (
        id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, label TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'named', manifest JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query(`CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq`)
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS automerge_storage (
        key TEXT PRIMARY KEY, data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    // Real claims through the real batch helper, against the isolated pool —
    // the same INSERT ... JOIN versions the production hook runs.
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(({ landscapeId, versionId, documentIds }) =>
      claimWorkspaceDocuments(db.pool, { landscapeId, versionId }, documentIds))
    // A LONG debounce, on purpose: the end-to-end arm needs the rollback's
    // real Postgres DELETEs to finish BEFORE the armed save fires, so that the
    // write-back is the thing being measured and not a race against the
    // default 100 ms, whose margin is too thin. 1 500 ms is the order, not a
    // bet; explicit flushes below bypass it.
    repo = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 1_500 })
  })

  afterAll(async () => {
    restoreRegistration()
    if (savedSecret === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = savedSecret
    await db?.teardown()
  })

  beforeEach(() => {
    resetMintedOrphanReaperCountersForTest()
    resetBootstrapMintCountersForTest()
    delete process.env.MINTED_ORPHAN_REAPER_MINIMUM_AGE_MS
    delete process.env.MINTED_ORPHAN_REAPER_MAX_CANDIDATES
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.MINTED_ORPHAN_REAPER_MINIMUM_AGE_MS
    delete process.env.MINTED_ORPHAN_REAPER_MAX_CANDIDATES
  })

  const mintedId = (target: WorkspaceRef): string => String(interpretAsDocumentId(mintDocumentIdBytes(target) as BinaryDocumentId))
  const legacyId = (): string => String(interpretAsDocumentId(Uint8Array.from(Buffer.from(randomUUID().replace(/-/g, ''), 'hex')) as BinaryDocumentId))

  /** A storage row for `doc`, born and last written `ageMs` ago. */
  async function seedChunk(doc: string, ageMs: number): Promise<void> {
    const at = new Date(Date.now() - ageMs)
    await db.pool.query(
      `INSERT INTO automerge_storage (key, data, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [`${doc}/snapshot/${randomUUID().slice(0, 8)}`, Buffer.from([1, 2, 3]), at],
    )
  }
  async function storedDocs(): Promise<Set<string>> {
    const { rows } = await db.pool.query<{ doc: string }>(`SELECT DISTINCT split_part(key, '/', 1) AS doc FROM automerge_storage`)
    return new Set(rows.map((r) => r.doc))
  }
  async function publishWorkspace(target: WorkspaceRef, rootUrl: string, documentIds: string[]): Promise<void> {
    await db.pool.query(`INSERT INTO landscapes (id, name, default_version_id) VALUES ($1, $1, $2) ON CONFLICT DO NOTHING`, [target.landscapeId, target.versionId])
    await db.pool.query(`INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, $1, $3)`, [target.versionId, target.landscapeId, rootUrl])
    const result = await claimWorkspaceDocuments(db.pool, target, documentIds)
    expect(result.foreign).toEqual([])
    expect(result.missingVersion).toBe(false)
  }
  const fresh = (prefix: string): WorkspaceRef => ({ landscapeId: `${prefix}-L-${randomUUID().slice(0, 6)}`, versionId: `${prefix}-V-${randomUUID().slice(0, 6)}` })

  it('END TO END — a fork that fails before its flush is written back by the armed save, and the reaper takes it', async () => {
    // The scenario the whole design exists for (forkRollback.ts § the armed save, forkRoot.test.ts KNOWN GAP): the
    // rollback removes the documents, the armed save writes them back, and
    // nothing durable points at them. Named for the child that never got its
    // versions row, they are reaper candidates by construction.
    const parent = fresh('e2e-parent')
    const child = fresh('e2e-child')
    const source = await createEmptyRoot(repo, openBootstrapScope(parent, { kind: 'unfenced', reason: 'no-forker' }))
    await publishWorkspace(parent, source.rootUrl, source.documentIds)
    const before = await storedDocs()
    expect(before.size, 'the source graph must be durable').toBeGreaterThan(0)

    const torn: string[] = []
    const realRemove = repo.removeFromCache.bind(repo)
    vi.spyOn(repo, 'removeFromCache').mockImplementation(async (id) => { torn.push(String(id)); await realRemove(id) })
    const realFind = repo.find.bind(repo)
    let reads = 0
    vi.spyOn(repo, 'find').mockImplementation(((...args: Parameters<Repo['find']>) => {
      reads += 1
      if (reads > 3) throw new Error('source read failed mid-fork')
      return realFind(...args)
    }) as Repo['find'])
    await expect(forkRoot(repo, source.rootUrl, openBootstrapScope(child, { kind: 'unfenced', reason: 'no-forker' }))).rejects.toThrow(/source read failed mid-fork/)
    vi.restoreAllMocks()
    expect(torn.length, 'PRESENCE FIRST — the fork created documents before failing').toBeGreaterThan(0)

    // Past the 1 500 ms debounce, with margin: the armed saves land on the real adapter.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    const resurrected = [...await storedDocs()].filter((doc) => !before.has(doc))
    expect(resurrected.length, 'the armed save wrote the torn-down documents back — the gap this reaper closes').toBe(torn.length)
    for (const doc of resurrected) expect(torn).toContain(doc)

    const outcome = await reapMintedOrphans(repo, { db: db.pool, minimumAgeMs: 0 })
    expect(outcome.status).toBe('completed')
    expect(outcome.skippedInMemory, 'removeFromCache dropped the handles; the write-back does not re-cache them').toBe(0)
    expect(outcome.stranded).toBe(0)
    expect(outcome.reapedDocumentIds.sort()).toEqual([...resurrected].sort())
    const after = await storedDocs()
    for (const doc of resurrected) expect(after.has(doc), `${doc} must be gone`).toBe(false)
    for (const doc of before) expect(after.has(doc), `source document ${doc} must survive`).toBe(true)
    expect(mintedOrphanReaperMetricSamples().find((s) => s.name.endsWith('_reaped_documents_total'))!.values[0]!.value).toBe(resurrected.length)
  })

  it('reaps the minted orphan and leaves EVERY protected neighbour alone — one run, all six cases', async () => {
    const live = fresh('live')
    const liveRoot = createBootstrapDocument(repo, live, { shardUrls: [] })
    await liveRoot.whenReady()
    await repo.flush([liveRoot.documentId])
    const liveRootId = String(liveRoot.documentId)
    // A claimed member of the live version.
    const claimedId = mintedId(live)
    await seedChunk(claimedId, 3 * HOUR)
    await publishWorkspace(live, `automerge:${liveRootId}`, [claimedId])
    // Bound to the live version but NEVER claimed — stranded, not orphaned.
    const strandedId = mintedId(live)
    await seedChunk(strandedId, 3 * HOUR)
    // Bound to a version that does not exist, old — the orphan.
    const orphanId = mintedId(fresh('gone'))
    await seedChunk(orphanId, 3 * HOUR)
    // Same, but young.
    const youngId = mintedId(fresh('gone'))
    await seedChunk(youngId, 10 * 60 * 1_000)
    // Born long ago but WRITTEN five minutes ago — a fork still in progress is
    // not old, whatever its birth date says.
    const stillWritingId = mintedId(fresh('gone'))
    await seedChunk(stillWritingId, 3 * HOUR)
    await db.pool.query(`UPDATE automerge_storage SET updated_at = NOW() - INTERVAL '5 minutes' WHERE split_part(key, '/', 1) = $1`, [stillWritingId])
    // A LEGACY id, unclaimed and old — a browser document whose link may still
    // be on its way. Never the reaper's business.
    const legacy = legacyId()
    await seedChunk(legacy, 3 * HOUR)
    // A 24-byte id of an UNKNOWN scheme version: the right LENGTH for the SQL
    // prefilter, not our format. This is what makes the JS format guard
    // load-bearing — a mutation battery found the legacy case above covered
    // by the length prefilter alone.
    const unknownScheme = String(interpretAsDocumentId(Uint8Array.from(Buffer.concat([Buffer.from([2]), randomBytes(23)])) as BinaryDocumentId))
    await seedChunk(unknownScheme, 3 * HOUR)
    // Bound to nothing, old, unclaimed — but NAMED BY A SAVED SNAPSHOT
    // MANIFEST, the liveness root `gcOrphanedDocs` honours for documents a
    // root stopped referencing. The two sweepers must agree on liveness.
    const snapshotted = mintedId(fresh('gone'))
    await seedChunk(snapshotted, 3 * HOUR)
    await db.pool.query(
      `INSERT INTO landscape_versions (id, landscape_id, label, manifest) VALUES ($1, $2, 'snap', $3)`,
      [`snap-${randomUUID().slice(0, 6)}`, live.landscapeId, JSON.stringify({ docs: [{ url: `automerge:${snapshotted}`, heads: [] }] })],
    )
    // Bound to nothing, old, but held in memory by this process.
    const inMemory = createBootstrapDocument(repo, fresh('gone'), { objects: {} })
    await inMemory.whenReady()
    await repo.flush([inMemory.documentId])
    await db.pool.query(`UPDATE automerge_storage SET created_at = NOW() - INTERVAL '3 hours', updated_at = NOW() - INTERVAL '3 hours' WHERE split_part(key, '/', 1) = $1`, [String(inMemory.documentId)])
    // Age the live root too, so it is a candidate on every axis but the root guard.
    await db.pool.query(`UPDATE automerge_storage SET created_at = NOW() - INTERVAL '3 hours', updated_at = NOW() - INTERVAL '3 hours' WHERE split_part(key, '/', 1) = $1`, [liveRootId])
    await repo.removeFromCache(liveRoot.documentId)

    const outcome = await reapMintedOrphans(repo, { db: db.pool, minimumAgeMs: HOUR })
    const after = await storedDocs()
    expect(outcome.reapedDocumentIds, 'exactly the orphan').toEqual([orphanId])
    expect(after.has(orphanId)).toBe(false)
    expect(after.has(claimedId), 'claimed').toBe(true)
    expect(after.has(strandedId), 'stranded — bound to a live version, unclaimed').toBe(true)
    expect(outcome.strandedDocumentIds).toEqual([strandedId])
    expect(after.has(youngId), 'younger than the floor').toBe(true)
    expect(after.has(stillWritingId), 'born old, written recently — a fork in progress').toBe(true)
    expect(after.has(legacy), 'legacy id — never considered').toBe(true)
    expect(after.has(unknownScheme), 'unknown scheme version — minted-length, not our format').toBe(true)
    expect(outcome.notMintedFormat).toBe(1)
    expect(after.has(snapshotted), 'named by a snapshot manifest — the GC’s liveness root, honoured here').toBe(true)
    expect(outcome.skippedSnapshot).toBe(1)
    expect(after.has(String(inMemory.documentId)), 'in memory').toBe(true)
    expect(outcome.skippedInMemory).toBe(1)
    expect(after.has(liveRootId), 'a version root, unclaimed here but protected by the root guard and the MAC').toBe(true)
    expect(mintedOrphanReaperMetricSamples().find((s) => s.name.endsWith('_stranded_documents_total'))!.values[0]!.value).toBe(1)
  })

  it('REFUSES to run without a mint key — with no key every id reads unminted and the verdict would be vacuous', async () => {
    const orphanId = mintedId(fresh('gone'))
    await seedChunk(orphanId, 3 * HOUR)
    const secret = process.env.AUTH_SECRET
    delete process.env.AUTH_SECRET
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const outcome = await reapMintedOrphans(repo, { db: db.pool, minimumAgeMs: 0 })
      expect(outcome.status).toBe('refused_no_mint_key')
      expect(outcome.reaped).toBe(0)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      process.env.AUTH_SECRET = secret
    }
    expect((await storedDocs()).has(orphanId), 'nothing deleted on a refused run').toBe(true)
    // Positive control: with the key back, the same row IS reaped.
    const outcome = await reapMintedOrphans(repo, { db: db.pool, minimumAgeMs: 0 })
    expect(outcome.reapedDocumentIds).toContain(orphanId)
  })

  it('reportOnly computes the set and deletes nothing', async () => {
    const orphanId = mintedId(fresh('gone'))
    await seedChunk(orphanId, 3 * HOUR)
    const dry = await reapMintedOrphans(repo, { db: db.pool, minimumAgeMs: 0, reportOnly: true })
    expect(dry.reportOnly).toBe(true)
    expect(dry.reaped).toBe(0)
    expect((await storedDocs()).has(orphanId)).toBe(true)
    const wet = await reapMintedOrphans(repo, { db: db.pool, minimumAgeMs: 0 })
    expect(wet.reapedDocumentIds).toContain(orphanId)
  })

  it('caps the REAPABLE documents per run, pages past permanent skips, and a later run finishes the job', async () => {
    // The arms above leave PERMANENT candidates behind at 3 h (stranded, in
    // memory, unknown format, snapshotted). A cap on SQL rows would let those
    // fill every slot on every run, so `truncated` would never go false and an
    // orphan YOUNGER than them would never be examined. Hence the orphans
    // below are seeded YOUNGER than the permanent set, on purpose: the cap
    // must reach past it.
    const ids = [mintedId(fresh('gone')), mintedId(fresh('gone')), mintedId(fresh('gone'))]
    for (const id of ids) await seedChunk(id, 2 * HOUR)
    const first = await reapMintedOrphans(repo, { db: db.pool, minimumAgeMs: 0, maxCandidates: 2 })
    expect(first.truncated).toBe(true)
    expect(first.reaped).toBe(2)
    expect(first.candidates, 'examined rows include the permanent skips it paged past').toBeGreaterThan(2)
    expect(ids.filter((id) => first.reapedDocumentIds.includes(id))).toHaveLength(2)
    let outcome = first
    for (let runs = 0; outcome.truncated && runs < 5; runs += 1) {
      outcome = await reapMintedOrphans(repo, { db: db.pool, minimumAgeMs: 0, maxCandidates: 2 })
    }
    expect(outcome.truncated, 'a run that ran out of rows says so, whatever it skipped').toBe(false)
    const after = await storedDocs()
    for (const id of ids) expect(after.has(id), `${id} reaped across runs`).toBe(false)
  })

  it('REFUSES to run when the snapshots table is missing — a lost liveness root is a thrown run, not a quieter sweep', async () => {
    const orphanId = mintedId(fresh('gone'))
    await seedChunk(orphanId, 3 * HOUR)
    await db.pool.query('ALTER TABLE landscape_versions RENAME TO landscape_versions_hidden')
    try {
      await expect(reapMintedOrphans(repo, { db: db.pool, minimumAgeMs: 0 })).rejects.toThrow(/landscape_versions/)
      expect((await storedDocs()).has(orphanId), 'nothing deleted on a faulted run').toBe(true)
    } finally {
      await db.pool.query('ALTER TABLE landscape_versions_hidden RENAME TO landscape_versions')
    }
    const outcome = await reapMintedOrphans(repo, { db: db.pool, minimumAgeMs: 0 })
    expect(outcome.reapedDocumentIds).toContain(orphanId)
  })

  describe('MINTED_ORPHAN_REAPER_MINIMUM_AGE_MS is a live knob with a rejection floor', () => {
    // Observable: a row born 30 minutes ago is reaped under a 1-minute floor
    // and deferred under the default hour. A value under the floor must FALL
    // BACK to the hour, not be honoured — `1000` honoured would reap it.
    async function thirtyMinuteRowReaped(value: string | undefined): Promise<boolean> {
      if (value === undefined) delete process.env.MINTED_ORPHAN_REAPER_MINIMUM_AGE_MS
      else process.env.MINTED_ORPHAN_REAPER_MINIMUM_AGE_MS = value
      const id = mintedId(fresh('gone'))
      await seedChunk(id, 30 * 60 * 1_000)
      await reapMintedOrphans(repo, { db: db.pool })
      const reaped = !(await storedDocs()).has(id)
      if (!reaped) await db.pool.query(`DELETE FROM automerge_storage WHERE split_part(key, '/', 1) = $1`, [id])
      return reaped
    }
    it('control — the default floor is an hour', async () => { expect(await thirtyMinuteRowReaped(undefined)).toBe(false) })
    it('honours a one-minute floor', async () => { expect(await thirtyMinuteRowReaped('60000')).toBe(true) })
    it('falls back on a value UNDER the floor', async () => { expect(await thirtyMinuteRowReaped('1000')).toBe(false) })
    it('falls back on a blank', async () => { expect(await thirtyMinuteRowReaped('')).toBe(false) })
  })
})

describe('the reaper deletes exactly what gcOrphanedDocs deletes — a parity gate, not a parity claim', () => {
  const reaper = readFileSync(new URL('./mintedOrphanReaper.ts', import.meta.url), 'utf8')
  const gc = readFileSync(new URL('./gc.ts', import.meta.url), 'utf8')
  const deletedTables = (source: string): string[] => [...source.matchAll(/DELETE FROM (\w+)/g)].map((m) => m[1]!).sort()

  it('both modules delete from the same three tables, in a transaction under the fence', () => {
    expect(deletedTables(reaper)).toEqual(['automerge_document_workspace', 'automerge_storage', 'read_model_document_watermarks'])
    expect(deletedTables(gc)).toEqual(deletedTables(reaper))
    expect(reaper).toMatch(/if \(options\.fence\) await assertMaintenanceFence\(client, options\.fence\)/)
  })

  it('index.ts pushes the reaper metrics, schedules it, and mounts the on-demand endpoint', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/metrics\.push\(\.\.\.mintedOrphanReaperMetricSamples\(\)\)/)
    expect(source).toMatch(/runFenced\('minted_orphan_reaper'/)
    expect(source).toMatch(/app\.post\('\/api\/automerge\/reap-minted-orphans'/)
    expect(source).toMatch(/MINTED_ORPHAN_REAPER !== 'off'/)
  })

  it('the job is registered with the coordinator and is NOT workspace-keyable', async () => {
    const { MAINTENANCE_JOBS, WORKSPACE_KEYABLE_JOBS } = await import('./maintenance/coordinator.js')
    expect(MAINTENANCE_JOBS.minted_orphan_reaper).toBeTypeOf('number')
    expect(WORKSPACE_KEYABLE_JOBS.minted_orphan_reaper).toBe(false)
  })
})
