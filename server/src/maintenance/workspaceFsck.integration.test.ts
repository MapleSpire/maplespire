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

import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as Automerge from '@automerge/automerge'
import { Repo, generateAutomergeUrl } from '@automerge/automerge-repo'
import { createEmptyRoot } from '../automergeServer.js'
import { PostgresStorageAdapter, isDocumentStorageKey } from '../automergeStorage.js'
import { findReadyDocument } from '../automergeRepoCompat.js'
import { fsckWorkspace, fsckSharedRoots, FSCK_CHECKS, documentIdOf, overlayHeadQuietForMs, OVERLAY_HEAD_CEILING, OVERLAY_SEGMENT_BYTE_CEILING } from './workspaceFsck.js'
import { coverWorkspace } from '../rbac/claimCoverage.js'
import { CLAIM_PROTOCOL_VERSION } from '../rbac/documentClaims.js'
import { getWorkspaceProjectionFreshness } from '../readModel/health.js'
import { durabilityWitnessPayload, roDurabilityWitness } from '../readModel/queries.js'
import { asLegacyStaticOrphan } from '../testing/legacyStaticOrphan.js'
import { openBootstrapScope } from '../bootstrapScope.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/**
 * fsck against a REAL Postgres + the real storage adapter + real
 * createEmptyRoot output. This is what makes fsck meaningful in CI: the CI database
 * carries no workspaces (the fleet script would exit 0 having checked nothing),
 * so the invariant runs HERE, on workspaces provisioned the way production
 * provisions them. The unit suite next door proves the verdict function; this
 * suite proves the fact-gathering SQL against the actual schema.
 */
describe.skipIf(!TEST_DATABASE_URL)('workspace fsck (live Postgres + real storage adapter)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb
  let repo: Repo

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'workspace_fsck')
    const { ensureReadModelSchema } = await import('../readModel/schema.js')
    await ensureReadModelSchema(db.pool)
    // Minimal shapes of the three fsck-facing tables (no FKs — the suite owns
    // every row it reads; see db.ts / syncCells/ownership.ts for the real DDL).
    await db.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      PRIMARY KEY (landscape_id, id))`)
    await db.pool.query(`CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS workspace_claim_coverage (
      landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      covered BOOLEAN NOT NULL, protocol INTEGER NOT NULL,
      invalidations BIGINT NOT NULL DEFAULT 0,
      covered_at TIMESTAMPTZ, invalidated_at TIMESTAMPTZ, invalidated_reason TEXT,
      PRIMARY KEY (landscape_id, version_id))`)
    // network: [] on purpose — with an adapter attached and no peer connected,
    // repo.find() never settles for a missing document, which is exactly the
    // condition fsck looks for.
    repo = new Repo({
      storage: new PostgresStorageAdapter({ db: db.pool }),
      network: [],
      saveDebounceRate: 0,
    })
  })

  afterAll(async () => { await db?.teardown() })

  /** Provision a workspace the way production does (createEmptyRoot), then
   * admit every document it created — the state of a fully-walked workspace.
   * The repo (and its storage) is shared across the suite's workspaces, so the
   * admitted set is the storage DELTA, not the whole table — admitting another
   * workspace's documents here would manufacture the very orphans the check
   * exists to find. */
  async function provision(landscapeId: string, versionId: string): Promise<string> {
    const storedIds = async () => new Set(
      (await db.pool.query<{ document_id: string }>(
        `SELECT DISTINCT split_part(key, '/', 1) AS document_id FROM automerge_storage`,
      )).rows.map((row) => row.document_id),
    )
    // `new Repo(...)` mints its storage identity from an UNAWAITED async IIFE in
    // the constructor, so `storage-adapter-id` lands at an arbitrary moment
    // after `beforeAll` returns. When it landed between the two snapshots below
    // it was admitted as a document of whichever workspace was provisioning,
    // and `document-orphaned` then reported it — a freshly provisioned
    // workspace could not be `clean`. Flaky, pre-existing, and nothing in the
    // output distinguished it from data.
    //
    // Two independent closes, on purpose. `isDocumentStorageKey` is the fix
    // (shared with `gc.ts` and `backupRestore.ts`); awaiting the identity here
    // removes the RACE itself, so this fixture no longer depends on when an
    // unawaited promise happens to settle.
    await repo.storageId()
    const before = await storedIds()
    const { rootUrl } = await createEmptyRoot(repo, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-test' }, { kind: 'unfenced', reason: 'no-forker' }))
    await db.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, $3)`,
      [landscapeId, versionId, rootUrl],
    )
    for (const documentId of await storedIds()) {
      if (before.has(documentId)) continue
      if (!isDocumentStorageKey(documentId)) continue
      await db.pool.query(
        `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
         VALUES ($1, $2, $3) ON CONFLICT (document_id) DO NOTHING`,
        [documentId, landscapeId, versionId],
      )
    }
    // Production bootstrap sets the claim-coverage marker as its LAST
    // write, so a freshly provisioned workspace is COVERED — which is what
    // makes claim-coverage RUN (not skip) in the clean report below.
    await coverWorkspace(db.pool, { landscapeId, versionId }, '0')
    return rootUrl
  }

  it('overlay-head-bounded FIRE de bout en bout: tête pleine, silencieuse, sur le plan STATIQUE', async () => {
    // POSITIVE coverage through the REAL collector. Everything else about this
    // check is exercised against a fabricated `StructureCheckInput`; a fixture
    // that only ever skips a check is a fixture that cannot fail it, and until
    // this test the check had never once fired through `fsckWorkspace` —
    // meaning `measureOverlayWriteHeads`, `overlayHeadQuietForMs` and the
    // static gate had never been driven together against real storage.
    const key = { landscapeId: 'L-fathead', versionId: 'V1' }
    const rootUrl = await provision(key.landscapeId, key.versionId)
    const root = await findReadyDocument<Record<string, unknown>>(repo, rootUrl)
    const meta = await findReadyDocument<Record<string, unknown>>(repo, root.doc()!.modelMetaUrl as string)

    // The STATIC plane, and its root flag together — `summary-static-coherence`
    // fires on either half alone, and a fixture carrying a second violation it
    // did not mean to is a fixture nobody can read.
    root.change((doc) => { doc.registrySummaryOnly = true })
    await repo.flush([root.documentId])
    await db.pool.query(
      `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source)
       VALUES ($1, $2, 'promoted') ON CONFLICT DO NOTHING`,
      [key.landscapeId, key.versionId],
    )

    const headUrl = meta.doc()!.editsObjectShardUrl as string
    const head = await findReadyDocument<Record<string, unknown>>(repo, headUrl)
    head.change((doc) => {
      // MUTATED IN PLACE, never reassigned. `doc.objects` inside `change` is a
      // live Automerge proxy, and writing it back — `doc.objects = objects` —
      // raises `RangeError: Cannot create a reference to an existing document
      // object`. It reads as ordinary defensive JavaScript and is not.
      if (!doc.objects) doc.objects = {}
      const objects = doc.objects as Record<string, unknown>
      // Past the ceiling by one. Sized from the constant deliberately: the
      // LITERAL is pinned in the unit suite, and duplicating it here would
      // give two places to edit when the knob moves.
      for (let index = 0; index <= OVERLAY_HEAD_CEILING; index += 1) objects[`o${index}`] = { id: `o${index}` }
    })
    await repo.flush([head.documentId])

    // …and QUIET. The storage adapter stamps `enqueued_at` on its own writes,
    // but this fixture wrote through the repo without the static allow-list in
    // place, so the row is posed here — dated past the grace, which is the
    // second half of the conjunct. Three hours because the grace is 65 minutes,
    // sized against `AM_OVERLAY_ROTATION_MAX_DELAY_MS`'s clamped MAXIMUM of one
    // hour rather than its 30 s default.
    await db.pool.query(
      `INSERT INTO read_model_static_document_queue
         (landscape_id, version_id, document_id, revision, projected_revision, enqueued_at)
       VALUES ($1, $2, $3, 1, 1, now() - interval '3 hours')
       ON CONFLICT (landscape_id, version_id, document_id)
       DO UPDATE SET enqueued_at = EXCLUDED.enqueued_at`,
      [key.landscapeId, key.versionId, documentIdOf(headUrl)],
    )

    const report = await fsckWorkspace(db.pool, repo, key, rootUrl)
    const finding = report.findings.find((f) => f.check === 'overlay-head-bounded')
    expect(finding?.severity).toBe('degraded')
    expect(finding?.documentUrl).toBe(headUrl)
    expect(finding?.detail).toContain(`${OVERLAY_HEAD_CEILING + 1} entities`)
    expect(finding?.detail).toContain('rotation is not running')
    expect(report.checksRun).toContain('overlay-head-bounded')

    // The headline numbers travel with it — the effective thresholds, so a
    // reader of a CLEAN report elsewhere knows which ones produced it, and the
    // bytes, which are the measure that keeps reporting where the check skips.
    //
    // These are the ONLY assertions on the three fields that go through the
    // real collectors: without them the quiescence query and the byte query
    // could each be unplugged (e.g. replaced by `async () => null`) with the
    // whole suite green.
    expect(report.overlayHeadCeiling).toBe(OVERLAY_HEAD_CEILING)
    // LITERALS beside the derivation, so the pair cannot agree with a knob that
    // moved. 32/128 are this suite's defaults; the unit file pins the relation.
    expect(report.overlaySegmentSize).toBe(32)
    expect(report.overlayHeadCeiling).toBe(128)
    // Complete, not partial: the head really is in storage, so a `null` here
    // would mean the byte collector answered nothing.
    expect(report.overlayWriteHeadBytes).toBeGreaterThan(0)

    // …and it counts CONTENT only. automerge-repo writes a
    // `<id>/sync-state/<peerId>` row the first time any peer merely TRIES to
    // sync a document, so a byte figure without the chunk filter grows with
    // the number of peers that have ever looked, not with the head.
    // REGRESSION GUARD: dropping `AND ${documentContentChunkFilter()}` from the byte query.
    const before = report.overlayWriteHeadBytes
    await db.pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, $2)`,
      [`${documentIdOf(headUrl)}/sync-state/somePeerId`, Buffer.alloc(4096, 7)],
    )
    const after = await fsckWorkspace(db.pool, repo, key, rootUrl)
    expect(after.overlayWriteHeadBytes).toBe(before)
  })

  it('overlayHeadQuietForMs: répond pour un document À JOUR, et `null` quand il n\'y a pas de ligne', async () => {
    // The QUIESCENCE fact `overlay-head-bounded` leans on, driven against real
    // SQL because that is the only place its predicate is decidable.
    //
    // A mutation battery is why this exists: adding `AND revision >
    // projected_revision` — the filter `registryWriteHeadProjectionLagMs` uses
    // ten lines away, and the obvious thing for a reader to "unify" — SURVIVED
    // the whole suite. It asks a different question ("is a projection
    // pending"), and under it a caught-up document reads as UNKNOWN, so an
    // over-full head skips as unreadable instead of being reported. A detector
    // silenced by a one-line tidy-up, with no test to notice.
    const key = { landscapeId: 'L-quiet', versionId: 'V1' }
    await db.pool.query(
      `INSERT INTO read_model_static_document_queue
         (landscape_id, version_id, document_id, revision, projected_revision, enqueued_at)
       VALUES ($1, $2, 'quietDoc', 7, 7, now() - interval '90 seconds')`,
      [key.landscapeId, key.versionId],
    )
    const caughtUp = await overlayHeadQuietForMs(db.pool, key, 'quietDoc')
    // Non-null, and roughly the interval — the assertion that dies under the
    // filtered predicate, which would return no row at all here.
    expect(caughtUp).not.toBeNull()
    expect(caughtUp).toBeGreaterThan(80_000)
    expect(caughtUp).toBeLessThan(150_000)

    // No row is UNKNOWN, never "quiet for ever". Rounding it up would turn the
    // conjunct that separates a bulk import from a dead rotator into a rubber
    // stamp.
    await expect(overlayHeadQuietForMs(db.pool, key, 'noSuchDoc')).resolves.toBeNull()
  })

  it('overlay-segment-bounded: fires through fsckWorkspace, and the WIRE is what this pins (A11)', async () => {
    // THE WIRE, not the predicate. `workspaceFsck.test.ts` drives
    // `checkWorkspaceStructure` directly with a hand-built `overlaySegmentSizes`
    // array, so every assertion there passes with the code that BUILDS that
    // array deleted. This test is the only thing in the tree that fails if
    // `fsckWorkspace` stops measuring listed segments (no finding, and the run
    // turns `incomplete`).
    const key = { landscapeId: 'L-segbound', versionId: 'V1' }
    const rootUrl = await provision(key.landscapeId, key.versionId)
    const root = await findReadyDocument<Record<string, unknown>>(repo, rootUrl)
    const meta = await findReadyDocument<Record<string, unknown>>(repo, root.doc()!.modelMetaUrl as string)

    // A RETIRED segment, not the head. The check deliberately excludes the two
    // current heads — `overlay-head-bounded` owns those, and owns them WITH a
    // 65-minute quiescence conjunct, because a head over its bound and a bulk
    // import still landing are indistinguishable without one. So a fixture
    // built only from heads would exercise nothing: the freshly provisioned
    // workspace lists just its heads, and before this segment existed the check
    // did not RUN at all here.
    const retiredUrl = generateAutomergeUrl()
    const segmentId = documentIdOf(retiredUrl)
    meta.change((doc) => {
      // Assign, then re-read: `?? (x = [])` yields the plain `[]`, not the list.
      if (!doc.editsObjectShardUrls) doc.editsObjectShardUrls = []
      // Ahead of the head, which is where a retired segment lives.
      ;(doc.editsObjectShardUrls as string[]).unshift(retiredUrl)
      if (!doc.objectShardUrls) doc.objectShardUrls = []
      ;(doc.objectShardUrls as string[]).unshift(retiredUrl)
    })
    await repo.flush([meta.documentId])
    // Present, admitted, and SMALL — the control state.
    await db.pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, $2)`,
      [`${segmentId}/snapshot/a11-base`, Buffer.alloc(64, 1)],
    )
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [segmentId, key.landscapeId, key.versionId],
    )

    const clean = await fsckWorkspace(db.pool, repo, key, rootUrl)
    // CONTROL FIRST: the freshly provisioned workspace must be silent here and
    // the check must have RUN, or the assertion below is measuring the fixture
    // rather than the defect. A check that only ever skips cannot fail.
    expect(clean.findings.filter((f) => f.check === 'overlay-segment-bounded')).toEqual([])
    expect(clean.checksRun).toContain('overlay-segment-bounded')

    // A listed segment past the BYTE ceiling. Written straight into
    // `automerge_storage` rather than through the repo: the check reads bytes
    // precisely because that is the one source a dead projector cannot flatter,
    // so the test must exercise that source and not a document.
    await db.pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, $2)`,
      [`${segmentId}/incremental/a11-bulk`, Buffer.alloc(OVERLAY_SEGMENT_BYTE_CEILING + 1, 3)],
    )

    const report = await fsckWorkspace(db.pool, repo, key, rootUrl)
    const finding = report.findings.find((f) => f.check === 'overlay-segment-bounded')
    expect(finding?.severity).toBe('degraded')
    expect(finding?.documentUrl).toBe(`automerge:${segmentId}`)
    expect(finding?.detail).toContain('past the')

    // …and it counts CONTENT only, for the same reason the head's byte figure
    // does: automerge-repo writes `<id>/sync-state/<peerId>` the first time any
    // peer merely TRIES to sync, so a size that admitted those would grow with
    // the number of peers that have ever looked rather than with the segment.
    // REGRESSION GUARD: dropping `AND ${documentContentChunkFilter()}` from
    // `overlaySegmentStorageBytes`.
    const peerKey = { landscapeId: 'L-segbound2', versionId: 'V1' }
    const peerRoot = await provision(peerKey.landscapeId, peerKey.versionId)
    const peerRootDoc = await findReadyDocument<Record<string, unknown>>(repo, peerRoot)
    const peerMeta = await findReadyDocument<Record<string, unknown>>(
      repo, peerRootDoc.doc()!.modelMetaUrl as string,
    )
    const peerUrl = generateAutomergeUrl()
    const peerSegmentId = documentIdOf(peerUrl)
    peerMeta.change((doc) => {
      if (!doc.editsObjectShardUrls) doc.editsObjectShardUrls = []
      ;(doc.editsObjectShardUrls as string[]).unshift(peerUrl)
      if (!doc.objectShardUrls) doc.objectShardUrls = []
      ;(doc.objectShardUrls as string[]).unshift(peerUrl)
    })
    await repo.flush([peerMeta.documentId])
    await db.pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, $2)`,
      [`${peerSegmentId}/snapshot/a11-base`, Buffer.alloc(64, 1)],
    )
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [peerSegmentId, peerKey.landscapeId, peerKey.versionId],
    )
    await db.pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, $2)`,
      [`${peerSegmentId}/sync-state/a11-peer`, Buffer.alloc(OVERLAY_SEGMENT_BYTE_CEILING + 1, 9)],
    )
    const after = await fsckWorkspace(db.pool, repo, peerKey, peerRoot)
    expect(after.findings.filter((f) => f.check === 'overlay-segment-bounded')).toEqual([])
  })

  it('reports a freshly provisioned workspace CLEAN with every registered check run', async () => {
    const rootUrl = await provision('L-clean', 'V1')
    const report = await fsckWorkspace(db.pool, repo, { landscapeId: 'L-clean', versionId: 'V1' }, rootUrl)
    expect(report.findings).toEqual([])
    expect(report.status).toBe('clean')
    // `createEmptyRoot` provisions a CLASSIC root, which writes through its
    // registry shards and names no `registryWriteUrl` — so `registry-head-projected` does not
    // apply here and skips as such. Every OTHER registered check must have run,
    // and the union below still fails a check added to FSCK_CHECKS and wired
    // nowhere (it would appear in neither list). The positive coverage — the
    // check RUNNING and finding a real violation — is the write-head test
    // further down, and the pure suite next door pins it on a fixture where the
    // head is present.
    expect([...report.checksRun, ...report.checksSkipped.map((entry) => entry.check)].sort())
      .toEqual(Object.keys(FSCK_CHECKS).sort())
    expect(report.checksSkipped.find((entry) => entry.check === 'registry-head-projected')?.reason)
      .toMatch(/^monolith workspace/)
  })

  it('finds the born-broken head-less meta as data-loss (the shape that lost a real object)', async () => {
    const rootUrl = await provision('L-headless', 'V1')
    const root = await findReadyDocument<{ modelMetaUrl?: string }>(repo, rootUrl)
    const meta = await findReadyDocument<Record<string, unknown>>(repo, root.doc()!.modelMetaUrl!)
    meta.change((doc) => {
      delete doc.editsObjectShardUrl
      delete doc.editsConnectionShardUrl
      delete doc.editsOverlayWriteHeadVersion
    })
    await repo.flush([meta.documentId])
    const report = await fsckWorkspace(db.pool, repo, { landscapeId: 'L-headless', versionId: 'V1' }, rootUrl)
    expect(report.status).toBe('violations')
    const finding = report.findings.find((f) => f.check === 'model-write-head')
    expect(finding?.severity).toBe('data-loss')
  })

  it('container-conflict FIRES through fsckWorkspace on a head whose writeBatchIds two peers created concurrently', async () => {
    // The WIRE (reviewer lens, round 2): the pure suite injects `hiddenBatchIds`,
    // so replacing the collector's measurement with `0` survived every unit
    // test. Here the head is a real stored document with a real conflict.
    const key = { landscapeId: 'L-batch-conflict', versionId: 'V1' }
    const rootUrl = await provision(key.landscapeId, key.versionId)
    const root = await findReadyDocument<{ modelMetaUrl?: string }>(repo, rootUrl)
    const meta = await findReadyDocument<Record<string, unknown>>(repo, root.doc()!.modelMetaUrl!)
    const head = await findReadyDocument<Record<string, unknown>>(repo, meta.doc()!.editsObjectShardUrl as string)
    // Control: a clean head reports nothing.
    expect((await fsckWorkspace(db.pool, repo, key, rootUrl)).findings.filter((f) => f.check === 'container-conflict')).toEqual([])
    const base = head.doc()!
    const assign = (actor: string, id: string) => Automerge.change(Automerge.clone(base, { actor }), (d) => {
      d.writeBatchIds = [id]
    })
    head.update((doc) => Automerge.merge(Automerge.merge(Automerge.clone(doc), assign('aaaaaa', 'batch-a')), assign('bbbbbb', 'batch-b')))
    await repo.flush([head.documentId])

    const report = await fsckWorkspace(db.pool, repo, key, rootUrl)
    const found = report.findings.filter((f) => f.check === 'container-conflict')
    expect(found).toEqual([expect.objectContaining({ severity: 'sync-stall', documentUrl: head.url })])
    expect(found[0]!.detail).toMatch(/1 batch id/)
  })

  it('finds a de-admitted reachable document as sync-stall', async () => {
    const rootUrl = await provision('L-stall', 'V1')
    const root = await findReadyDocument<{ modelMetaUrl?: string }>(repo, rootUrl)
    const metaId = documentIdOf(root.doc()!.modelMetaUrl!)
    await db.pool.query(`DELETE FROM automerge_document_workspace WHERE document_id = $1`, [metaId])
    const report = await fsckWorkspace(db.pool, repo, { landscapeId: 'L-stall', versionId: 'V1' }, rootUrl)
    const finding = report.findings.find((f) => f.check === 'document-admitted')
    expect(finding?.severity).toBe('sync-stall')
    expect(finding?.documentUrl && documentIdOf(finding.documentUrl)).toBe(metaId)
  })

  it('finds an admission the graph no longer references as document-orphaned', async () => {
    const rootUrl = await provision('L-orphan', 'V1')
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ('zzzOrphanedDocumentId', 'L-orphan', 'V1')`,
    )
    const report = await fsckWorkspace(db.pool, repo, { landscapeId: 'L-orphan', versionId: 'V1' }, rootUrl)
    const findings = report.findings.filter((f) => f.check === 'document-orphaned')
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('degraded')
    expect(findings[0].documentUrl).toBe('automerge:zzzOrphanedDocumentId')
  })

  it('a coverage marker at an OLDER protocol reads as uncovered: claim-coverage skips with a reason (U7)', async () => {
    // The reader (fsckWorkspace) compares the stored protocol BEFORE the pure
    // verdict ever sees the marker: an old-protocol row is an UNCOVERED
    // workspace (its coverage promise predates the current contract), not a
    // lying one — otherwise every CLAIM_PROTOCOL_VERSION bump would flood
    // fsck with phantom violations across the whole stock.
    const rootUrl = await provision('L-oldproto', 'V1')
    await db.pool.query(
      `UPDATE workspace_claim_coverage SET protocol = $1
        WHERE landscape_id = 'L-oldproto' AND version_id = 'V1'`,
      [CLAIM_PROTOCOL_VERSION - 1],
    )
    const report = await fsckWorkspace(db.pool, repo, { landscapeId: 'L-oldproto', versionId: 'V1' }, rootUrl)
    expect(report.checksRun).not.toContain('claim-coverage')
    const skipped = report.checksSkipped.find((entry) => entry.check === 'claim-coverage')
    expect(skipped?.reason).toContain('uncovered workspace')
    // A does-not-apply skip is not incompleteness: the report can still be clean.
    expect(report.findings).toEqual([])
    expect(report.status).toBe('clean')
  })

  it('diagram-tombstone-honoured: the WIRING, not just the verdict (T6)', async () => {
    // The unit suite next door pins `checkWorkspaceStructure`'s verdict — it is
    // handed `diagramTombstones` and `liveTombstonedDiagramIds` as literals.
    // This pins where those two come from, the half that can go inert without
    // a sound: emptying the `ro_diagrams` lookup, or dropping the
    // `deletedDiagramIds` read from the resolved ModelMeta, would keep the
    // check in `checksRun`, keep every report `clean`, and keep the whole unit
    // suite green. A check whose declaration is pinned but whose INPUT is not
    // reports on a question it never asked.
    const rootUrl = await provision('L-tombstone', 'V1')
    const root = await findReadyDocument<{ modelMetaUrl?: string }>(repo, rootUrl)
    const meta = await findReadyDocument<Record<string, unknown>>(repo, root.doc()!.modelMetaUrl!)
    meta.change((doc) => {
      // `dg-honoured` was projected (no row left); `dg-stuck` was not.
      doc.deletedDiagramIds = ['dg-honoured', 'dg-stuck', 'dg-stuck']
    })
    await repo.flush([meta.documentId])
    await db.pool.query(
      `INSERT INTO ro_diagrams (landscape_id, version_id, id, data)
       VALUES ($1, $2, 'dg-stuck', '{"id":"dg-stuck","name":"Toujours servi"}'::jsonb)
       ON CONFLICT DO NOTHING`,
      ['L-tombstone', 'V1'],
    )

    const report = await fsckWorkspace(db.pool, repo, { landscapeId: 'L-tombstone', versionId: 'V1' }, rootUrl)

    // The check RAN — the anti-void guard for everything below.
    expect(report.checksRun).toContain('diagram-tombstone-honoured')
    const findings = report.findings.filter((f) => f.check === 'diagram-tombstone-honoured')
    // Exactly one: the id whose row is still served. The honoured one is
    // silent, and the duplicate id is reported once.
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('degraded')
    expect(findings[0].detail).toContain('dg-stuck')
    expect(report.status).toBe('violations')
    // The tombstone count, deduplicated and taken from the real document: the
    // ONLY number that reports the accepted-but-unbounded growth, and the
    // one the fleet script prints in its headline.
    expect(report.diagramTombstoneCount).toBe(2)
  })

  it('registry-head-projected: the WIRING, and the #41 defect found by a RUN (T9)', async () => {
    // A summary workspace writes a new diagram into the registry WRITE HEAD
    // and nowhere else; the write is durable, the nav menu opens it, and
    // without a projection no server surface knows it exists. Same discipline
    // as the tombstone wiring test above: the pure suite is handed the two id lists as
    // literals, so nothing there pins WHERE they come from — dropping the
    // `root.registryWriteUrl` read, or emptying the `ro_diagrams` lookup, would
    // keep the check in `checksRun`, keep every report `clean`, and keep the
    // whole unit suite green.
    const rootUrl = await provision('L-writehead', 'V1')
    const rootHandle = await findReadyDocument<{
      shardUrls?: string[]
      registryWriteUrl?: string
    }>(repo, rootUrl)
    // The write head, exactly as a summary client publishes one: a bounded
    // registry document appended to `shardUrls` AND named by `registryWriteUrl`
    // (`publishNewRegistryShard`, bridge.ts).
    const head = repo.create<{ diagrams: Record<string, { id: string; docUrl?: string }> }>({
      diagrams: {
        // Projected — the read model can serve it.
        'dg-served': { id: 'dg-served' },
        // Written, durable, and invisible everywhere but the nav menu. THE defect.
        'dg-invisible': { id: 'dg-invisible' },
        // Deleted in-session: the shard entry is gone in production, but a
        // tombstoned id must never be DEMANDED here — the projection refuses to
        // resurrect it, so requiring a row would fire on correct behaviour.
        'dg-tombed': { id: 'dg-tombed' },
      },
    })
    await repo.flush([head.documentId])
    rootHandle.change((doc) => {
      doc.shardUrls = [...(doc.shardUrls ?? []), head.url]
      doc.registryWriteUrl = head.url
    })
    await repo.flush([rootHandle.documentId])
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ($1, $2, $3) ON CONFLICT (document_id) DO NOTHING`,
      [head.documentId, 'L-writehead', 'V1'],
    )
    const meta = await findReadyDocument<Record<string, unknown>>(
      repo, (rootHandle.doc() as { modelMetaUrl?: string }).modelMetaUrl!,
    )
    meta.change((doc) => { doc.deletedDiagramIds = ['dg-tombed'] })
    await repo.flush([meta.documentId])
    await db.pool.query(
      `INSERT INTO ro_diagrams (landscape_id, version_id, id, data)
       VALUES ($1, $2, 'dg-served', '{"id":"dg-served","name":"Servi"}'::jsonb)
       ON CONFLICT DO NOTHING`,
      ['L-writehead', 'V1'],
    )

    const report = await fsckWorkspace(
      db.pool, repo, { landscapeId: 'L-writehead', versionId: 'V1' }, rootUrl,
    )

    // The check RAN — the anti-void guard for everything below.
    expect(report.checksRun).toContain('registry-head-projected')
    const findings = report.findings.filter((f) => f.check === 'registry-head-projected')
    // EXACTLY one: the served id is silent, and the tombstoned id is not
    // demanded. A checker that also reported `dg-tombed` would contradict
    // `diagram-tombstone-honoured` and get muted.
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('sync-stall')
    expect(findings[0].detail).toContain('dg-invisible')
    expect(findings[0].documentUrl).toBe(head.url)
    expect(report.status).toBe('violations')
    // The write-head size, from the real document: the write head is NOT
    // bounded by SHARD_SIZE — `findOrCreateSummaryWriteShard` has no size test
    // at all, unlike its twin `findOrCreateShardForNew`, and nothing rotates it
    // — so this number is every diagram ever created on the workspace, and the
    // reconciliation reads it in full on the CREATION path. Reported, never
    // turned into a violation: growth is not brokenness, and failing the run
    // for it would dilute the one property that makes `clean` worth reading.
    expect(report.registryWriteHeadDiagramCount).toBe(3)
  })

  it('write-head-writable: la moitié SQL est CÂBLÉE, et sa portée est celle de la clôture', async () => {
    // Deux choses qu'aucun test de la fonction pure ne peut couvrir, parce que
    // celle-ci reçoit la liste de kinds en littéral.
    //
    // 1. LE CÂBLAGE. Sans ce test, supprimer la requête, retirer sa jointure ou
    //    rendre `[]` au lieu des lignes laisse le check DÉFINITIVEMENT sauté en
    //    production — et les tests unitaires restent verts, parce qu'ils
    //    fabriquent eux-mêmes l'entrée que la requête est censée produire.
    //
    // 2. LA PORTÉE. La clôture cherche `WHERE document.document_id = $1`, SANS
    //    filtre d'espace, jointe à `read_model_static_workspaces`. La ligne
    //    posée ci-dessous appartient donc à un espace ENTIÈREMENT AUTRE, et la
    //    tête de celui-ci n'a aucune ligne à lui : une lecture scopée à
    //    `L-fenced/V1` rendrait zéro et certifierait `clean` pendant que la
    //    clôture gèle chaque écriture. Ce faux négatif n'est visible que d'ici.
    const rootUrl = await provision('L-fenced', 'V1')
    const rootHandle = await findReadyDocument<{
      shardUrls?: string[]
      registryWriteUrl?: string
    }>(repo, rootUrl)
    const head = repo.create<{ diagrams: Record<string, { id: string }> }>({ diagrams: {} })
    await repo.flush([head.documentId])
    rootHandle.change((doc) => {
      doc.shardUrls = [...(doc.shardUrls ?? []), head.url]
      doc.registryWriteUrl = head.url
    })
    await repo.flush([rootHandle.documentId])

    // Le manifeste du VOISIN, pas le nôtre. La jointure exige que cet espace-là
    // soit statique, sans quoi la clôture ne verrait pas la ligne non plus — la
    // fixture doit reproduire la condition, pas la contourner.
    await db.pool.query(
      `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source)
       VALUES ('L-neighbour', 'V1', 'test') ON CONFLICT DO NOTHING`,
    )
    await db.pool.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
       VALUES ('L-neighbour', 'V1', $1, 'registry') ON CONFLICT DO NOTHING`,
      [head.documentId],
    )

    const report = await fsckWorkspace(
      db.pool, repo, { landscapeId: 'L-fenced', versionId: 'V1' }, rootUrl,
    )

    // Le garde anti-vide : le check a TOURNÉ. Sans lui, un accesseur qui rend
    // toujours null passerait ce test en ne trouvant rien.
    expect(report.checksRun).toContain('write-head-writable')
    const findings = report.findings.filter((f) => f.check === 'write-head-writable')
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('data-loss')
    expect(findings[0].documentUrl).toBe(head.url)
    expect(report.status).toBe('violations')
  })

  it('write-head-writable: une tête que PERSONNE ne liste est propre, et le check a tourné', async () => {
    // Le pendant du test ci-dessus, et il porte tout son poids : sans lui, un
    // accesseur qui rendrait `null` (« pas pu regarder ») au lieu de `[]` (« la
    // clôture laisse passer ») ferait passer CHAQUE espace ordinaire de `clean`
    // à `incomplete`, et l'alarme qui se déclenche sur le cas normal finit
    // muette. Les deux tests ne peuvent pas être verts en même temps pour un
    // accesseur cassé.
    const rootUrl = await provision('L-unlisted', 'V1')
    const rootHandle = await findReadyDocument<{
      shardUrls?: string[]
      registryWriteUrl?: string
    }>(repo, rootUrl)
    const head = repo.create<{ diagrams: Record<string, { id: string }> }>({ diagrams: {} })
    await repo.flush([head.documentId])
    rootHandle.change((doc) => {
      doc.shardUrls = [...(doc.shardUrls ?? []), head.url]
      doc.registryWriteUrl = head.url
    })
    await repo.flush([rootHandle.documentId])

    // Une ligne de manifeste ORPHELINE : elle nomme cette tête avec un kind de
    // socle, mais son espace n'est PAS dans `read_model_static_workspaces` —
    // le résidu qu'une dépromotion laisse derrière elle. La clôture ne la voit
    // pas, à cause de sa jointure ; ce check ne doit pas la voir non plus.
    // Sans la jointure, ce test signalerait une perte de données là où rien
    // n'est gelé — la fausse alarme symétrique du faux négatif que le test
    // précédent attrape. Une alarme qui se déclenche sur le cas normal finit
    // muette.
    // `read_model_static_documents_workspace_fk` refuse désormais d'écrire une
    // telle ligne : le résidu est de la donnée LÉGATAIRE, laissée par une
    // dépromotion antérieure à la contrainte. La fixture reproduit donc la
    // séquence qui l'a produite plutôt qu'un état qu'une base vivante ne peut
    // plus atteindre — et c'est précisément la population que
    // `static-allow-list-orphaned` existe pour signaler.
    await asLegacyStaticOrphan(db.pool, () => db.pool.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
       VALUES ('L-demoted', 'V1', $1, 'registry') ON CONFLICT DO NOTHING`,
      [head.documentId],
    ))

    const report = await fsckWorkspace(
      db.pool, repo, { landscapeId: 'L-unlisted', versionId: 'V1' }, rootUrl,
    )

    expect(report.checksRun).toContain('write-head-writable')
    expect(report.findings.filter((f) => f.check === 'write-head-writable')).toEqual([])
    expect(report.checksSkipped.map((e) => e.check)).not.toContain('write-head-writable')
  })

  it('#37: le jeu de BOOT est pesé, et il exclut ce qui n est pas sur le chemin du boot', async () => {
    // Les documents de boot ne sont PAS tous petits (un tesson de registre
    // peut peser plusieurs Mo sur un gros paysage) ; ce nombre le rend visible
    // sans décoder Automerge à la main.
    //
    // Deux nombres dans l'EN-TÊTE, pas une ligne de `FSCK_CHECKS` : un espace
    // qui a légitimement grossi n'est pas cassé (même règle que
    // `diagramTombstoneCount` et `registryWriteHeadDiagramCount`).
    const rootUrl = await provision('L-bootbytes', 'V1')
    const rootHandle = await findReadyDocument<{
      shardUrls?: string[]
      modelMetaUrl?: string
    }>(repo, rootUrl)

    // Un DIAGRAMME volumineux, atteignable depuis le registre mais JAMAIS sur
    // le chemin du boot : c'est lui qui discrimine. Un compteur qui pèserait
    // « tout ce qui est atteignable » le prendrait, et le nombre cesserait de
    // dire quoi que ce soit sur le boot.
    // De l'ENTROPIE, pas une répétition : Automerge compresse ses morceaux, et
    // 200 000 fois « x » se range en 424 octets — le garde-fou aurait mesuré la
    // compression au lieu de la taille.
    const fat = randomBytes(200_000).toString('base64')
    const diagram = repo.create<{ id: string; blob: string }>({ id: 'dg-fat', blob: fat })
    await repo.flush([diagram.documentId])
    const registryUrl = (rootHandle.doc()!.shardUrls ?? [])[0]
    const registry = await findReadyDocument<{ diagrams: Record<string, unknown> }>(repo, registryUrl)
    registry.change((doc) => { doc.diagrams['dg-fat'] = { id: 'dg-fat', docUrl: diagram.url } })
    await repo.flush([registry.documentId])

    const report = await fsckWorkspace(
      db.pool, repo, { landscapeId: 'L-bootbytes', versionId: 'V1' }, rootUrl,
    )

    // Le jeu de boot est EXACTEMENT celui que `BOOT_DOCUMENT_RESOLUTION`
    // résout côté client : racine + ModelMeta + tessons de registre.
    const bootIds = [rootUrl, rootHandle.doc()!.modelMetaUrl!, ...(rootHandle.doc()!.shardUrls ?? [])]
      .map(documentIdOf)
    const { rows } = await db.pool.query<{ document_id: string; bytes: string }>(
      `SELECT split_part(key, '/', 1) AS document_id, SUM(octet_length(data))::bigint AS bytes
         FROM automerge_storage
        WHERE split_part(key, '/', 1) = ANY($1::text[])
        GROUP BY 1`,
      [bootIds],
    )
    const expected = rows.map((row) => Number(row.bytes))
    expect(expected.length).toBe(bootIds.length)
    expect(report.bootCriticalBytes).toBe(expected.reduce((sum, value) => sum + value, 0))
    expect(report.largestBootDocumentBytes).toBe(Math.max(...expected))
    expect(report.bootCriticalBytes).toBeGreaterThan(0)

    // Le garde-fou contre « pèse tout le graphe » : le diagramme de
    // 200 ko est atteignable, et il ne doit peser dans AUCUN des deux nombres.
    const { rows: fatRows } = await db.pool.query<{ bytes: string }>(
      `SELECT SUM(octet_length(data))::bigint AS bytes FROM automerge_storage
        WHERE split_part(key, '/', 1) = $1`,
      [diagram.documentId],
    )
    const fatBytes = Number(fatRows[0].bytes)
    expect(fatBytes).toBeGreaterThan(100_000)
    expect(report.largestBootDocumentBytes).toBeLessThan(fatBytes)
    expect(report.bootCriticalBytes).toBeLessThan(fatBytes)
  })

  it('la taille de la tete d ecriture est nulle pour un monolithe, jamais zero (revue M3)', async () => {
    // Null and 0 are different facts: 0 means "a head with nothing in it", null
    // means "no head at all". Reporting 0 for a monolith would print a bound
    // for a document that does not exist — the same null/empty confusion the
    // checker refuses elsewhere.
    const rootUrl = await provision('L-monolith-head', 'V1')

    const report = await fsckWorkspace(
      db.pool, repo, { landscapeId: 'L-monolith-head', versionId: 'V1' }, rootUrl,
    )

    expect(report.registryWriteHeadDiagramCount).toBeNull()
  })

  it('a sync-state row is not content: the document still reports document-present', async () => {
    // automerge-repo writes `sync-state/<peerId>` (2 bytes) the
    // FIRST TIME a peer tries to sync a document — including one whose content
    // was never durably written. So opening a broken diagram, and getting
    // "Document … is unavailable", is itself what creates its storage row.
    //
    // A presence check that asks "any row with this prefix?" then answers YES,
    // and the finding disappears as soon as a user opens the broken document.
    // The check must key on CONTENT, so that a detector cannot be silenced by
    // the defect occurring.
    const rootUrl = await provision('L-syncstate', 'V1')
    const root = await findReadyDocument<{ modelMetaUrl?: string }>(repo, rootUrl)
    const metaId = documentIdOf(root.doc()!.modelMetaUrl!)

    await db.pool.query(
      `DELETE FROM automerge_storage WHERE split_part(key, '/', 1) = $1`,
      [metaId],
    )
    await db.pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, $2)`,
      [`${metaId}/sync-state/aa38df3e-04d9-41c7-b770-7ecb97d15de5`, Buffer.from([0, 0])],
    )

    const report = await fsckWorkspace(db.pool, repo, { landscapeId: 'L-syncstate', versionId: 'V1' }, rootUrl)
    const finding = report.findings.find(
      (f) => f.check === 'document-present' && f.documentUrl && documentIdOf(f.documentUrl) === metaId,
    )
    expect(finding, 'a document reduced to its sync-state marker must NOT count as present').toBeDefined()
  })

  it('park check: two versions rows on one root are reported as shared-root', async () => {
    const rootUrl = await provision('L-twin-a', 'V1')
    await db.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ('L-twin-b', 'V1', $1)`,
      [rootUrl],
    )
    const findings = await fsckSharedRoots(db.pool)
    const twin = findings.find((f) => f.rootUrl === rootUrl)
    expect(twin).toBeDefined()
    expect(twin!.workspaces.map((w) => w.landscapeId).sort()).toEqual(['L-twin-a', 'L-twin-b'])
  })
})

/**
 * The projection-freshness read behind /api/model/durability-witness: absence
 * is a proof only under `healthy`. Same schema, real SQL.
 */
describe.skipIf(!TEST_DATABASE_URL)('durability witness freshness (live Postgres)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb
  const WS = { landscapeId: 'L-w', versionId: 'V-w' }
  let staleGraceBefore: string | undefined

  beforeAll(async () => {
    // The grace-window discriminator below asserts `caughtUp` STAYS true for a
    // seconds-old write, which holds only under the default 60 s grace — a
    // shell that compressed READ_MODEL_STALE_GRACE_MS (the eviction-canary
    // recipe does) would flip the ladder to `stale` and fail the wrong
    // assertion. Pin it for the suite.
    staleGraceBefore = process.env.READ_MODEL_STALE_GRACE_MS
    process.env.READ_MODEL_STALE_GRACE_MS = '60000'
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'witness_freshness')
    const { ensureReadModelSchema } = await import('../readModel/schema.js')
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
  })

  afterAll(async () => {
    if (staleGraceBefore === undefined) delete process.env.READ_MODEL_STALE_GRACE_MS
    else process.env.READ_MODEL_STALE_GRACE_MS = staleGraceBefore
    await db?.teardown()
  })

  it('a workspace with NO projection state row is uninitialized — absence proves nothing', async () => {
    const freshness = await getWorkspaceProjectionFreshness(db.pool, WS)
    expect(freshness.status).toBe('uninitialized')
    expect(freshness.caughtUp).toBe(false)
  })

  it('healthy ladder + ZERO admitted documents is still NOT caught up (round-4 probe)', async () => {
    // The stale detector's out-of-band probe walks the admission table; with
    // nothing admitted, a durable write is invisible to it and the ladder
    // reads healthy while arbitrarily behind. caughtUp therefore also
    // requires at least one admission.
    await db.pool.query(
      `INSERT INTO read_model_projection_state
         (landscape_id, version_id, observed_generation, projected_generation,
          projector_attached, last_projected_at)
       VALUES ($1, $2, 7, 7, true, NOW())
       ON CONFLICT (landscape_id, version_id) DO UPDATE SET
         observed_generation = 7, projected_generation = 7,
         projector_attached = true, last_projected_at = NOW(),
         degraded_since = NULL`,
      [WS.landscapeId, WS.versionId],
    )
    const freshness = await getWorkspaceProjectionFreshness(db.pool, WS)
    expect(freshness.status).toBe('healthy')
    expect(freshness.admittedDocuments).toBe(0)
    expect(freshness.caughtUp).toBe(false)
  })

  it('attached + fully projected + storage in agreement + admissions reads healthy/caughtUp/provable', async () => {
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ('w-doc1', $1, $2) ON CONFLICT (document_id) DO NOTHING`,
      [WS.landscapeId, WS.versionId],
    )
    const freshness = await getWorkspaceProjectionFreshness(db.pool, WS)
    expect(freshness.status).toBe('healthy')
    expect(freshness.admittedDocuments).toBe(1)
    expect(freshness.caughtUp).toBe(true)
    // No storage write at all → nothing can postdate the projection.
    expect(freshness.absenceProvable).toBe(true)
    expect(freshness.projectedGeneration).toBe(7)
  })

  it('a durable write INSIDE the stale grace window: caughtUp still true, absence NOT provable (round 5)', async () => {
    // A write the projector has not observed, younger than the 60s grace,
    // leaves the status ladder on `healthy` — yet the projection provably does
    // not include it. The write-checkpoint clause (newest durable arrival <
    // last completed projection, same Postgres clock, one snapshot) refuses
    // the proof; dropping the clause fails here.
    await db.pool.query(
      `UPDATE read_model_projection_state SET last_projected_at = now() - interval '10 seconds'
       WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId],
    )
    await db.pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ('w-doc1/snapshot/1', decode('00', 'hex'))
       ON CONFLICT (key) DO UPDATE SET updated_at = now()`,
    )
    const during = await getWorkspaceProjectionFreshness(db.pool, WS)
    expect(during.status).toBe('healthy') // inside the grace window
    expect(during.caughtUp).toBe(true)
    expect(during.absenceProvable).toBe(false)
    // Once a projection COMPLETES after the arrival, the proof holds again.
    await db.pool.query(
      `UPDATE read_model_projection_state SET last_projected_at = now()
       WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId],
    )
    const after = await getWorkspaceProjectionFreshness(db.pool, WS)
    expect(after.status).toBe('healthy')
    expect(after.absenceProvable).toBe(true)
  })

  it('an observed backlog reads catching_up — and forbids absence proofs', async () => {
    await db.pool.query(
      `UPDATE read_model_projection_state SET observed_generation = 9
       WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId],
    )
    const freshness = await getWorkspaceProjectionFreshness(db.pool, WS)
    expect(freshness.status).toBe('catching_up')
    expect(freshness.caughtUp).toBe(false)
  })

  it('a degraded workspace forbids absence proofs even with generations level', async () => {
    await db.pool.query(
      `UPDATE read_model_projection_state
       SET observed_generation = 9, projected_generation = 9, degraded_since = NOW()
       WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId],
    )
    const freshness = await getWorkspaceProjectionFreshness(db.pool, WS)
    expect(freshness.status).toBe('degraded')
    expect(freshness.caughtUp).toBe(false)
  })

  it('roDurabilityWitness answers BOTH families in one shot, scoped to the workspace', async () => {
    await db.pool.query(
      `INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES
         ($1, $2, 'o1', '{"id":"o1","name":"One"}'::jsonb)
       ON CONFLICT DO NOTHING`,
      [WS.landscapeId, WS.versionId],
    )
    await db.pool.query(
      `INSERT INTO ro_connections (landscape_id, version_id, id, from_id, to_id, data) VALUES
         ($1, $2, 'c1', 'o1', 'o2', '{"id":"c1","fromId":"o1","toId":"o2"}'::jsonb)
       ON CONFLICT DO NOTHING`,
      [WS.landscapeId, WS.versionId],
    )
    const result = await roDurabilityWitness(db.pool, WS, ['o1', 'missing'], ['c1'])
    expect((result.objects.o1 as { name: string }).name).toBe('One')
    expect(result.objects.missing).toBeUndefined()
    expect((result.connections.c1 as { toId: string }).toId).toBe('o2')
    // Another workspace's rows never leak in.
    const foreign = await roDurabilityWitness(db.pool, { landscapeId: 'other', versionId: 'v' }, ['o1'], ['c1'])
    expect(Object.keys(foreign.objects)).toEqual([])
    expect(Object.keys(foreign.connections)).toEqual([])
  })

  it('N2 acceptance: a sequenced arrival ABOVE the projected watermark refuses the proof even where the timestamp clause would grant it', async () => {
    // The wall-clock clause is blind to an arrival sampled-after but
    // completed-before — the minted order is not. Here the storage row's
    // arrival_seq EXCEEDS the recorded watermark while its updated_at PREDATES
    // last_projected_at, so the timestamp clause alone would say covered. The
    // exact branch must win and refuse; the fallback may never override an
    // exact refusal.
    const { rows: seqRows } = await db.pool.query<{ arrival_seq: string }>(
      `SELECT arrival_seq::text FROM automerge_storage WHERE key = 'w-doc1/snapshot/1'`,
    )
    const arrivalSeq = BigInt(seqRows[0].arrival_seq)
    expect(arrivalSeq > 0n).toBe(true) // the fixture INSERT minted from the sequence
    // Make the TIMESTAMP clause pass: projection "completed" after the write.
    await db.pool.query(
      `UPDATE read_model_projection_state SET last_projected_at = now(),
         observed_generation = 9, projected_generation = 9, degraded_since = NULL
       WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId],
    )
    // Watermark BELOW the arrival: the projection sampled before it arrived.
    const { recordProjectedWatermarks } = await import('../readModel/arrivalWatermark.js')
    await recordProjectedWatermarks(db.pool, WS, ['w-doc1'], String(arrivalSeq - 1n))
    const stale = await getWorkspaceProjectionFreshness(db.pool, WS)
    expect(stale.status).toBe('healthy')
    expect(stale.caughtUp).toBe(true)
    expect(stale.absenceProvable).toBe(false) // exact refusal wins over the timestamp
    // A projection that SAMPLED after the arrival records a covering watermark
    // and the proof returns.
    await recordProjectedWatermarks(db.pool, WS, ['w-doc1'], String(arrivalSeq))
    const covered = await getWorkspaceProjectionFreshness(db.pool, WS)
    expect(covered.absenceProvable).toBe(true)
    // GREATEST monotonicity: a late completion of an OLDER sampling can never
    // regress the record.
    await recordProjectedWatermarks(db.pool, WS, ['w-doc1'], String(arrivalSeq - 1n))
    const still = await getWorkspaceProjectionFreshness(db.pool, WS)
    expect(still.absenceProvable).toBe(true)
  })

  it('the storage adapter mints a strictly increasing arrival_seq on every CONTENT save', async () => {
    const { PostgresStorageAdapter } = await import('../automergeStorage.js')
    const adapter = new PostgresStorageAdapter({ db: db.pool })
    const storageKey = ['w-clock-doc', 'snapshot', 'clock-probe'] as [string, string, string]
    await adapter.save([...storageKey], new Uint8Array([1]))
    const first = await db.pool.query<{ arrival_seq: string }>(
      `SELECT arrival_seq::text FROM automerge_storage WHERE key = 'w-clock-doc/snapshot/clock-probe'`,
    )
    await adapter.save([...storageKey], new Uint8Array([2]))
    const second = await db.pool.query<{ arrival_seq: string }>(
      `SELECT arrival_seq::text FROM automerge_storage WHERE key = 'w-clock-doc/snapshot/clock-probe'`,
    )
    expect(BigInt(first.rows[0].arrival_seq) > 0n).toBe(true)
    expect(BigInt(second.rows[0].arrival_seq) > BigInt(first.rows[0].arrival_seq)).toBe(true)
  })

  it('sync-state saves mint NOTHING — protocol bookkeeping is not an arrival (round-6 C1)', async () => {
    // A sync-state chunk is written on every peer round-trip WITHOUT the
    // document changing: no change event ever fires, so no projection would
    // ever cover a sequence minted for it — the proof would refuse FOREVER on
    // a healthy quiet workspace. The insert must override the column DEFAULT
    // explicitly.
    const { PostgresStorageAdapter } = await import('../automergeStorage.js')
    const adapter = new PostgresStorageAdapter({ db: db.pool })
    const storageKey = ['w-clock-doc', 'sync-state', 'peer-1'] as [string, string, string]
    await adapter.save([...storageKey], new Uint8Array([1]))
    await adapter.save([...storageKey], new Uint8Array([2]))
    const { rows } = await db.pool.query<{ arrival_seq: string | null }>(
      `SELECT arrival_seq::text FROM automerge_storage WHERE key = 'w-clock-doc/sync-state/peer-1'`,
    )
    expect(rows[0].arrival_seq).toBeNull()
  })

  it('the measure side ALSO ignores sync-state rows — even ones a legacy deploy already stamped', async () => {
    // Defense in depth: rows stamped by an older deployment (or by a foreign
    // writer) must not freeze the proof either. Plant a
    // sync-state row for the ADMITTED document with a sequence far above its
    // watermark: the proof must stand.
    const before = await getWorkspaceProjectionFreshness(db.pool, WS)
    expect(before.absenceProvable).toBe(true) // precondition from earlier tests
    await db.pool.query(
      `INSERT INTO automerge_storage (key, data, arrival_seq)
       VALUES ('w-doc1/sync-state/peer-x', decode('00','hex'), nextval('automerge_arrival_seq'))
       ON CONFLICT (key) DO UPDATE SET arrival_seq = nextval('automerge_arrival_seq')`,
    )
    const after = await getWorkspaceProjectionFreshness(db.pool, WS)
    expect(after.absenceProvable).toBe(true) // fails if the sync-state filter is dropped
  })

  it('prepared watermark protocol: moved heads invalidate, stable heads certify exactly (kills round-6 mutant d)', async () => {
    // The decision lives in recordSampledDocumentWatermark so it can be tested
    // here: recording wPost without the heads check must not certify moved
    // heads. Preparation reads the real durable document after draining saves,
    // outside the recording operation.
    const { recordSampledDocumentWatermark, recordProjectedWatermarks, captureArrivalWatermark, prepareDocumentWatermarkProofs } = await import('../readModel/arrivalWatermark.js')
    const { getHeads } = await import('@automerge/automerge')
    const repo = new Repo({ network: [], saveDebounceRate: 0,
      storage: new PostgresStorageAdapter({ db: db.pool }) })
    try {
      const handle = repo.create<{ n?: number }>({ n: 1 })
      await repo.flush([handle.documentId])
      const protoKey = { landscapeId: 'L-proto', versionId: 'V-proto' }
      const sampledHeads = getHeads(handle.doc() as never)
      const targets = [{ documentId: handle.documentId,
        drainPendingSaves: () => repo.storageSubsystem!.drainDocumentSaves(handle.documentId) }]
      // An arrival interleaves after the sample. Neither an old certificate
      // nor a pre-sample minted sequence proves the newly projected rows.
      handle.change((doc) => { doc.n = 2 })
      await repo.flush([handle.documentId])
      const movedHeads = getHeads(handle.doc() as never)
      const movedProof = await prepareDocumentWatermarkProofs(db.pool, targets)
      expect(movedProof.durableHeadsById.get(handle.documentId)).toEqual(movedHeads)
      const previousCertificate = await captureArrivalWatermark(db.pool)
      await recordProjectedWatermarks(db.pool, protoKey, [handle.documentId], previousCertificate)
      await recordSampledDocumentWatermark(db.pool, protoKey, handle.documentId, sampledHeads,
        () => getHeads(handle.doc() as never), movedProof)
      const afterMoved = await db.pool.query<{ w: string }>(
        `SELECT projected_watermark::text AS w FROM read_model_document_watermarks
         WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
        [protoKey.landscapeId, protoKey.versionId, handle.documentId],
      )
      expect(afterMoved.rows[0].w).toBe('0')
      // No interleaving: stable heads restore the prepared certificate.
      const stableHeads = getHeads(handle.doc() as never)
      const stableProof = await prepareDocumentWatermarkProofs(db.pool, targets)
      await recordSampledDocumentWatermark(db.pool, protoKey, handle.documentId, stableHeads,
        () => getHeads(handle.doc() as never), stableProof)
      const afterStable = await db.pool.query<{ w: string }>(
        `SELECT projected_watermark::text AS w FROM read_model_document_watermarks
         WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
        [protoKey.landscapeId, protoKey.versionId, handle.documentId],
      )
      expect(BigInt(afterStable.rows[0].w) > 0n).toBe(true)
      expect(afterStable.rows[0].w).toBe(stableProof.watermarkPost)
      // Replacing a previous higher certificate must not retain its claim:
      // the current projection only proved content through its prepared cut.
      const higherCertificate = await captureArrivalWatermark(db.pool)
      await recordProjectedWatermarks(db.pool, protoKey, [handle.documentId], higherCertificate)
      await recordSampledDocumentWatermark(db.pool, protoKey, handle.documentId, stableHeads,
        () => getHeads(handle.doc() as never), stableProof)
      const afterOlderPreparation = await db.pool.query<{ w: string }>(
        `SELECT projected_watermark::text AS w FROM read_model_document_watermarks
         WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
        [protoKey.landscapeId, protoKey.versionId, handle.documentId],
      )
      expect(BigInt(higherCertificate) > BigInt(stableProof.watermarkPost)).toBe(true)
      expect(afterOlderPreparation.rows[0].w).toBe(stableProof.watermarkPost)
    } finally {
      await repo.shutdown()
    }
  })

  it('the endpoint PAYLOAD carries the proof and the resolved workspace (contract test)', async () => {
    // A route that dropped `absenceProvable` (or the workspace echo) would
    // fail SAFE — the client's strict read defers everything — but SILENTLY:
    // permanent deferral with no detector, a forbidden class. The
    // payload is assembled in durabilityWitnessPayload precisely so this test
    // can exist without an HTTP harness.
    const payload = await durabilityWitnessPayload(db.pool, WS, ['o1'], ['c1'])
    const freshness = await getWorkspaceProjectionFreshness(db.pool, WS)
    expect(payload.landscapeId).toBe(WS.landscapeId)
    expect(payload.versionId).toBe(WS.versionId)
    expect(typeof payload.absenceProvable).toBe('boolean')
    expect(payload.absenceProvable).toBe(freshness.absenceProvable)
    expect(payload.caughtUp).toBe(freshness.caughtUp)
    expect(payload.status).toBe(freshness.status)
    expect((payload.objects.o1 as { name: string }).name).toBe('One')
    expect((payload.connections.c1 as { toId: string }).toId).toBe('o2')
  })
})
