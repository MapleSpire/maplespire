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
 * The promotion door, as a gate that can go RED.
 *
 * `promoteSummaryWorkspace.integration.test.ts` already promotes a real
 * workspace and checks the order of the four commits. This file is a GATE
 * rather than a suite: it is wired into `run-harness-suites.mjs` with a
 * `witness` regex, so "it did not run" and "it ran and agreed" are different
 * observable facts.
 *
 * ARM A drives the door itself. ARM B proves the CONSEQUENCE of the lifecycle
 * write fence: a projection already in flight fails its own
 * end-of-transaction plane assert and rolls back WHOLE rather than committing
 * over the published rows (without the fence, most published rows can be
 * erased by a COMMIT that succeeds with no error).
 *
 * ## What each `// N<n>` marker pins
 *
 *   N3  the fence is rotated ATOMICALLY with the publish (same transaction),
 *       not by a follow-up statement — the "resurrection window".
 *   N12 the sentinel row is proven present before the rollback.
 *   N9  the fence-arming bound is compared to the imported constant AND to a
 *       literal floor (the import alone agrees with a zeroed constant).
 *   N1  the allow-list CONTENT by kind, not just its size and root.
 *   N14 the write head is admitted, not merely minted and allow-listed.
 *   N4  the root flip is durable, read back through an independent repo.
 *   N15 the ordinary projector is released before the fence wait.
 *   N13 the promoted static source literal (distinct from performance fixtures,
 *       and what the demotion escape hatch keys on).
 *   N8  `staticBaseline` on ModelMeta — half of the summary contract.
 *
 * ## What this file does NOT cover
 *
 * ARM B is a deterministic SEQUENCE, not a race: `apply()` is fully awaited
 * before the assert. Deliberate — it makes the gate non-flaky — but it says
 * nothing about interleavings where the promotion commits midway through the
 * projection's own writes.
 *
 * Two of the markers above cannot fail in this fixture:
 *
 *   N14, deleting `claimWorkspaceDocuments` for the write head, does not change
 *   what `armA.writeHeadIsCLAIMED` observes: `markStaticReadModelWorkspace`
 *   admits every allow-listed document through
 *   `registerDocumentWorkspaceAssignments`, so the head is admitted either way.
 *   What that deletion actually removes is the FOREIGN-claim detection — the
 *   explicit claim returns `foreign` ids and throws, while the allow-list
 *   insert is `ON CONFLICT DO NOTHING` and would silently publish a document
 *   owned by another workspace. Exercising that needs a colliding document id
 *   staged in advance; this gate does not stage one.
 *
 *   N4, deleting the step-6 `repo.flush`, is unobservable HERE because this
 *   fixture sets `saveDebounceRate: 0`, so the adapter saves eagerly and the
 *   flip is durable without the explicit flush — confirmed by reading the root
 *   back through an ephemeral repo over the same storage. Production does not
 *   set 0, so the flush matters there and this gate cannot see it. The
 *   durability assertion is kept because it still catches a total failure to
 *   persist; it is not evidence that the flush is exercised.
 *
 * ## The output contract
 *
 * ONE `QARESULT` line carrying `reached` and `pass` as SEPARATE fields;
 * `run-harness-suites.mjs` keys `witness` on the former and `verdict` on the
 * latter, and `gate-liveness.test.mjs` mechanically requires the verdict to be
 * a literal STRENGTHENING of the witness. Folding them together would make the
 * witness the same predicate as the exit code, so a FAIL could go unseen.
 *
 * ## Why it REFUSES rather than skips without a database
 *
 * `TEST_DATABASE_URL` unset prints `pass:false` with `void:"no-database"` and
 * exits non-zero. A check that returns 0 for having done nothing is the failure
 * this file exists to stop. It is therefore in the DB-needing half of `CHECKS`
 * and runs only where a database exists — see `run-harness-suites.mjs`.
 */
import pg from 'pg'
import { Repo, type StorageAdapterInterface } from '@automerge/automerge-repo'
import { createEmptyRoot } from '../src/automergeServer.js'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { findReadyDocument } from '../src/automergeRepoCompat.js'
import { coverWorkspace } from '../src/rbac/claimCoverage.js'
import { BASELINE_FENCE_ARMING_BOUND_MS } from '../src/rbac/docScope.js'
import { digestOfIds } from '../src/readModel/contentDigest.js'
import {
  ReadModelWriteFenceError,
  assertReadModelWriteFence,
  claimReadModelWriteFence,
  isLifecycleWriteFence,
} from '../src/readModel/health.js'
import {
  PROMOTED_STATIC_SOURCE,
  promoteSummaryWorkspace,
  type PromotionStep,
} from '../src/maintenance/promoteSummaryWorkspace.js'
import { fsckWorkspace } from '../src/maintenance/workspaceFsck.js'
import type { IsolatedSchemaDb } from '../src/testing/isolatedSchema.js'
import type { WorkspaceKey } from '../src/readModel/projector.js'
import { openBootstrapScope } from '../src/bootstrapScope.js'

/** N9: the imported constant is compared to a LITERAL FLOOR as well as to the
 *  run's own wait. Comparing only to the import defends against the constant
 *  moving; it cannot notice the constant being zeroed, which voids the fence
 *  wait while every assertion still agrees. So pin the behaviour with a
 *  number the code cannot move. */
const ARMING_BOUND_FLOOR_MS = 15_000

interface RootDoc {
  modelMetaUrl?: string
  shardUrls?: string[]
  registryWriteUrl?: string
  registrySummaryOnly?: boolean
  diagramCount?: number
}

const idOf = (url: string) => url.replace(/^automerge:/, '').split('?')[0]

interface Outcome {
  facts: Record<string, unknown>
  failures: string[]
  void?: string
}

/**
 * Run both arms. Returns rather than exiting, so the caller's `finally` can
 * still drop the schema — `process.exit()` inside a `try` skips every `finally`
 * on the stack, which would leak a `test_promotion_door` schema per run.
 */
async function run(databaseUrl: string, cleanup: { db?: IsolatedSchemaDb; repo?: Repo }): Promise<Outcome> {
  const facts: Record<string, unknown> = {}
  const failures: string[] = []
  const check = (ok: boolean, name: string, detail = ''): void => {
    if (!ok) failures.push(detail ? `${name} (${detail})` : name)
  }

  // `pg_trgm` MUST EXIST IN `public` BEFORE the schema-pinned pool opens, and
  // this check has to do it itself. `ensureReadModelSchema` issues
  // `CREATE EXTENSION IF NOT EXISTS pg_trgm` with no SCHEMA clause, so it lands
  // in the FIRST schema of `search_path` — which `isolatedSchema.ts` pins to the
  // test schema with no `public` fallback — and the later index DDL then names
  // `public.gin_trgm_ops` explicitly and fails with "operator class does not
  // exist". Vitest's global setup avoids this by migrating the default pool
  // first; this check runs BEFORE the vitest steps, so it cannot inherit that
  // ordering.
  const bootstrap = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  try {
    await bootstrap.query('CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public')
  } finally {
    await bootstrap.end().catch(() => undefined)
  }

  const { createIsolatedSchemaDb } = await import('../src/testing/isolatedSchema.js')
  const { ensureReadModelSchema } = await import('../src/readModel/schema.js')
  const db = await createIsolatedSchemaDb(databaseUrl, 'promotion_door')
  cleanup.db = db

  await ensureReadModelSchema(db.pool)
  // The tables the primitive touches outside the read model — the same minimal
  // shapes the integration suite declares. No FKs: this check owns every row it
  // reads, and the real DDL lives in db.ts / syncCells/ownership.ts.
  await db.pool.query(`CREATE TABLE IF NOT EXISTS versions (
    landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
    parent_version_id TEXT, kind TEXT DEFAULT 'version', status TEXT DEFAULT 'active',
    base_manifest JSONB, PRIMARY KEY (landscape_id, id))`)
  await db.pool.query('CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq')
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

  const storage: StorageAdapterInterface = new PostgresStorageAdapter({ db: db.pool })
  // `network: []` — with an adapter attached and no peer connected,
  // `repo.find()` never settles for a missing document, which is exactly the
  // condition the preconditions must be able to REPORT rather than hang on.
  const repo = new Repo({ storage, network: [], saveDebounceRate: 0 })
  cleanup.repo = repo

  /** A promotable ordinary workspace, provisioned the way production does. */
  async function provision(key: WorkspaceKey): Promise<{ rootUrl: string; registryUrl: string; diagramId: string; diagramDocUrl: string }> {
    // The root graph is named for `key` (bootstrapMint.ts) — the same
    // order production uses, ids first, rows after.
    const { rootUrl, documentIds } = await createEmptyRoot(repo, openBootstrapScope(key, { kind: 'unfenced', reason: 'no-forker' }), { starterDiagram: true })
    await db.pool.query('INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, $3)',
      [key.landscapeId, key.versionId, rootUrl])
    for (const documentId of documentIds) {
      await db.pool.query(
        `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
         VALUES ($1, $2, $3) ON CONFLICT (document_id) DO NOTHING`,
        [documentId, key.landscapeId, key.versionId])
    }
    const root = (await findReadyDocument<RootDoc>(repo, rootUrl)).doc()!
    const registryUrl = root.shardUrls![0]
    const registry = (await findReadyDocument<{ diagrams: Record<string, { docUrl: string }> }>(
      repo, registryUrl)).doc()!
    const [diagramId, meta] = Object.entries(registry.diagrams)[0]
    await db.pool.query(
      'INSERT INTO ro_diagrams (landscape_id, version_id, id, data) VALUES ($1, $2, $3, $4::jsonb)',
      [key.landscapeId, key.versionId, diagramId, JSON.stringify({ id: diagramId, docUrl: meta.docUrl })])
    await coverWorkspace(db.pool, key, '0')
    const sealed = {
      object: { ...digestOfIds([]), g: 1 },
      connection: { ...digestOfIds([]), g: 1 },
      group: { ...digestOfIds([]), g: 1 },
      diagram: { ...digestOfIds([diagramId]), g: 1 },
    }
    await db.pool.query(
      `INSERT INTO read_model_projection_state (
         landscape_id, version_id, observed_generation, projected_generation,
         projector_attached, projector_instance_id, last_projected_at,
         last_projection_kind, content_digest
       ) VALUES ($1, $2, 1, 1, true, 'run-under-test', now(), 'cold_build', $3::jsonb)
       ON CONFLICT (landscape_id, version_id) DO UPDATE SET
         observed_generation = 1, projected_generation = 1,
         projector_attached = true, projector_instance_id = 'run-under-test',
         last_projected_at = now(), content_digest = EXCLUDED.content_digest,
         degraded_since = NULL`,
      [key.landscapeId, key.versionId, JSON.stringify(sealed)])
    return { rootUrl, registryUrl, diagramId, diagramDocUrl: meta.docUrl }
  }

  /**
   * ONE clock shared by `clock` and `sleep` — two calls to a factory would give
   * the promotion a clock that never advances and a sleep nothing reads, and
   * `fenceWaitMs` would then be 0 while every assertion still passed.
   */
  function fakeClock() {
    let now = 1_700_000_000_000
    return { clock: () => now, sleep: async (ms: number) => { now += ms } }
  }

  const readFence = async (key: WorkspaceKey): Promise<string | null> => {
    const { rows } = await db.pool.query<{ write_fence: string | null }>(
      'SELECT write_fence FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
      [key.landscapeId, key.versionId])
    return rows[0]?.write_fence ?? null
  }

  async function apply(key: WorkspaceKey, extra: Record<string, unknown> = {}) {
    // Re-stamped immediately before the run: every storage write in the fixture
    // must predate the projection or the arrival-watermark witness cannot prove
    // absence, and an earlier arm's writes share the storage table.
    await db.pool.query(
      'UPDATE read_model_projection_state SET last_projected_at = now() WHERE landscape_id = $1 AND version_id = $2',
      [key.landscapeId, key.versionId])
    const timing = fakeClock()
    return promoteSummaryWorkspace({
      db: db.pool, repo, storage, workspace: key, apply: true,
      residency: null, // Isolated Repo; live residency is exercised by the integration regression.
      connectedPeers: () => 0,
      expectedProjectorInstanceId: 'run-under-test',
      clock: timing.clock, sleep: timing.sleep,
      ...extra,
    })
  }

  // ══ ARM A — the door itself ═══════════════════════════════════════════════
  const A: WorkspaceKey = { landscapeId: 'door-a', versionId: 'v1' }
  const madeA = await provision(A)

  // ANTI-VOID: if the workspace was not promotable to begin with, "the
  // promotion refused" is indistinguishable from "the door is broken", and
  // every assertion below would be measuring the fixture.
  const fsckBefore = await fsckWorkspace(db.pool, repo, A, madeA.rootUrl)
  if (fsckBefore.status !== 'clean') {
    return { facts, failures, void: `fixture-not-promotable: fsck ${fsckBefore.status}` }
  }

  const released: string[] = []
  const steps: PromotionStep[] = []
  // N3: the fence read at `static-committed`, from an INDEPENDENT connection.
  // That hook fires immediately after the transaction's COMMIT, so a fence
  // rotated INSIDE that transaction is already visible here and one rotated by
  // a follow-up statement is not. This is the assertion that pins the call
  // site's own "in THIS transaction, never a follow-up one".
  let fenceAtStaticCommit: string | null = null
  const reportA = await apply(A, {
    hooks: {
      // The release records itself INTO THE STEP SEQUENCE, not into a separate
      // list: moving the real `releaseOrdinaryProjector` call while leaving
      // `onStep('projector-released')` in place would leave the marker sequence
      // identical. The marker says where the code claims to release; this says
      // where it actually did.
      releaseOrdinaryProjector: (_key: WorkspaceKey, reason: string) => {
        released.push(reason)
        steps.push('RELEASE' as PromotionStep)
      },
      onStep: async (step: PromotionStep) => {
        steps.push(step)
        if (step === 'static-committed') fenceAtStaticCommit = await readFence(A)
      },
    },
  })
  check(reportA.blockers.length === 0, 'armA.noBlockers', reportA.blockers.map((b) => b.code).join(','))
  check(reportA.applied !== null, 'armA.applied')

  check(isLifecycleWriteFence(fenceAtStaticCommit), 'armA.fenceRotatedByTheTimeTheStaticRowIsVisible',
    `write_fence was ${fenceAtStaticCommit ?? 'NULL'} at static-committed`)

  // N3, AND THE INSTRUMENT THAT ACTUALLY CATCHES IT. The `static-committed`
  // hook fires AFTER the whole try/finally, so it sees a fence claimed by a
  // follow-up statement exactly as it sees one claimed inside the transaction,
  // so that assertion alone cannot tell them apart. `xmin` does
  // discriminate, and deterministically: it is the id of the transaction that
  // wrote the row, so two rows published by ONE transaction carry the SAME
  // value and a follow-up UPDATE necessarily carries a different one. This is
  // the executable form of the call site's "in THIS transaction, never a
  // follow-up one: the gap between two commits is a resurrection window".
  const xmins = await db.pool.query<{ static_xmin: string; fence_xmin: string }>(
    `SELECT (SELECT xmin::text FROM read_model_static_workspaces
              WHERE landscape_id = $1 AND version_id = $2) AS static_xmin,
            (SELECT xmin::text FROM read_model_projection_state
              WHERE landscape_id = $1 AND version_id = $2) AS fence_xmin`,
    [A.landscapeId, A.versionId])
  const { static_xmin: staticXmin, fence_xmin: fenceXmin } = xmins.rows[0] ?? {}
  check(Boolean(staticXmin) && staticXmin === fenceXmin, 'armA.fenceClaimedInTHESAMEtransactionAsThePublish',
    `static row xmin=${staticXmin ?? 'absent'}, projection-state xmin=${fenceXmin ?? 'absent'}`)

  // N15: the release must precede the fence wait, not merely happen. Moved past
  // the root flip it leaves the ordinary projector — whose write is a blanket
  // DELETE by workspace — attached across the entire publish.
  const order = (step: string) => steps.indexOf(step as PromotionStep)
  check(released.includes('promoted'), 'armA.ordinaryProjectorReleased', released.join(',') || 'never released')
  check(order('RELEASE') >= 0 && order('RELEASE') < order('fence-waited'),
    'armA.projectorACTUALLYreleasedBEFOREtheFenceWait', steps.join(' -> '))
  check(order('RELEASE') < order('root-flipped'), 'armA.projectorACTUALLYreleasedBEFOREtheRootFlip',
    `${steps.join(' -> ')} — the ordinary projector's write is a blanket DELETE by workspace; `
    + 'left attached across the publish it erases the rows just published')
  check(order('fence-waited') < order('root-flipped'), 'armA.fenceWaitedBEFOREtheRootFlip', steps.join(' -> '))

  const rootA = (await findReadyDocument<RootDoc>(repo, madeA.rootUrl)).doc()!
  check(rootA.registrySummaryOnly === true, 'armA.rootCarriesSummaryContract')
  check(rootA.registryWriteUrl === reportA.applied?.writeHeadUrl, 'armA.rootNamesTheMintedWriteHead')
  check(JSON.stringify(rootA.shardUrls) === JSON.stringify([madeA.registryUrl, reportA.applied?.writeHeadUrl]),
    'armA.baselineRegistryRetained', JSON.stringify(rootA.shardUrls))

  // N8: the ModelMeta half of the summary contract.
  const metaA = (await findReadyDocument<{ staticBaseline?: boolean }>(repo, rootA.modelMetaUrl!)).doc()!
  check(metaA.staticBaseline === true, 'armA.modelMetaCarriesStaticBaseline')

  // N4: DURABILITY. Reading the root back through the same `repo` cannot tell a
  // flipped-and-flushed root from one flipped only in memory — dropping
  // `repo.flush` leaves exactly the hybrid state fsck calls `degraded`. An
  // ephemeral repo over the same storage sees only what actually reached it.
  const witnessRepo = new Repo({
    storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 0,
  })
  try {
    const durableRoot = (await findReadyDocument<RootDoc>(witnessRepo, madeA.rootUrl)).doc()!
    check(durableRoot.registrySummaryOnly === true, 'armA.rootFlipIsDURABLE',
      'the flip is in memory only — an ephemeral repo over storage does not see it')
    check(durableRoot.registryWriteUrl === reportA.applied?.writeHeadUrl, 'armA.durableRootNamesTheWriteHead')
  } finally {
    await witnessRepo.shutdown().catch(() => undefined)
  }

  // N13: the literal, not only the constant. Renaming PROMOTED_STATIC_SOURCE to
  // an existing source ('perf-seed') makes an operator promotion
  // indistinguishable from a performance fixture AND closes the demotion escape
  // hatch, because the demotion refuses any source it did not promote.
  const staticA = await db.pool.query<{ source: string }>(
    'SELECT source FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2',
    [A.landscapeId, A.versionId])
  check(staticA.rows[0]?.source === PROMOTED_STATIC_SOURCE, 'armA.staticRowCommitted',
    staticA.rows[0]?.source ?? 'absent')
  check(PROMOTED_STATIC_SOURCE === 'promoted', 'armA.promotedSourceIsTheExpectedLITERAL',
    `constant is '${PROMOTED_STATIC_SOURCE}'`)

  // N1: the allow-list's CONTENT, by kind. Checking the size and the root only
  // would miss every DiagramDoc relabelled `registry` — a BASELINE kind — which
  // would make the baseline write fence drop every write to every diagram on a
  // promoted workspace, forever, with the badge stuck on "Enregistrement…".
  const allowA = await db.pool.query<{ document_id: string; kind: string; entity_id: string | null }>(
    'SELECT document_id, kind, entity_id FROM read_model_static_documents WHERE landscape_id = $1 AND version_id = $2',
    [A.landscapeId, A.versionId])
  const kindOf = new Map(allowA.rows.map((row) => [row.document_id, row.kind]))
  check(allowA.rowCount === reportA.applied?.allowListSize, 'armA.allowListSizeAgrees',
    `${allowA.rowCount} rows vs reported ${reportA.applied?.allowListSize}`)
  check(kindOf.get(idOf(madeA.rootUrl)) === 'root', 'armA.rootKind', kindOf.get(idOf(madeA.rootUrl)) ?? 'absent')
  check(kindOf.get(idOf(madeA.registryUrl)) === 'registry', 'armA.baselineRegistryKind',
    kindOf.get(idOf(madeA.registryUrl)) ?? 'absent')
  check(kindOf.get(idOf(reportA.applied!.writeHeadUrl)) === 'registry-shard', 'armA.writeHeadKind',
    kindOf.get(idOf(reportA.applied!.writeHeadUrl)) ?? 'absent')
  check(kindOf.get(idOf(madeA.diagramDocUrl)) === 'diagram', 'armA.diagramDocKind',
    `${kindOf.get(idOf(madeA.diagramDocUrl)) ?? 'absent'} — a baseline kind here freezes every diagram write`)
  check(allowA.rows.find((r) => r.document_id === idOf(madeA.diagramDocUrl))?.entity_id === madeA.diagramId,
    'armA.diagramEntityId')

  // N14: the write head must be ADMITTED, not merely minted and allow-listed.
  // Without the claim, the one document a summary client keeps writing has no
  // owner in the workspace route check.
  const headAdmitted = await db.pool.query(
    'SELECT 1 FROM automerge_document_workspace WHERE document_id = $1 AND landscape_id = $2 AND version_id = $3',
    [idOf(reportA.applied!.writeHeadUrl), A.landscapeId, A.versionId])
  check(headAdmitted.rowCount === 1, 'armA.writeHeadIsCLAIMED',
    'the minted write head never entered automerge_document_workspace')

  // N9: the run's wait meets the imported bound AND the bound meets a literal
  // floor. The first alone agrees with anything once the constant is zeroed.
  const fenceWaitMs = reportA.applied?.fenceWaitMs ?? -1
  check(fenceWaitMs >= BASELINE_FENCE_ARMING_BOUND_MS, 'armA.fenceWaitMetTheArmingBound',
    `waited ${fenceWaitMs} ms, bound is ${BASELINE_FENCE_ARMING_BOUND_MS} ms`)
  check(BASELINE_FENCE_ARMING_BOUND_MS >= ARMING_BOUND_FLOOR_MS, 'armA.armingBoundItselfMeetsTheLITERALfloor',
    `constant is ${BASELINE_FENCE_ARMING_BOUND_MS} ms, floor is ${ARMING_BOUND_FLOOR_MS} ms`)

  const fsckAfter = await fsckWorkspace(db.pool, repo, A, madeA.rootUrl)
  check(fsckAfter.status === 'clean', 'armA.fsckStillClean',
    `${fsckAfter.status}: ${fsckAfter.findings.map((f) => f.check).join(',')}`)

  facts.armA = {
    allowListSize: reportA.applied?.allowListSize ?? null,
    fenceWaitMs, armingBoundMs: BASELINE_FENCE_ARMING_BOUND_MS,
    fenceAtStaticCommit: fenceAtStaticCommit === null ? null : String(fenceAtStaticCommit).slice(0, 18) + '…',
    steps: steps.join('>'),
    fsckBefore: fsckBefore.status, fsckAfter: fsckAfter.status,
  }

  // ══ ARM B — the ADVERSARIAL arm a replay cannot supply ════════════════════
  const B: WorkspaceKey = { landscapeId: 'door-b', versionId: 'v1' }
  const madeB = await provision(B)
  const COLD = 'cold-build-instance'
  const SENTINEL = 'sentinel-written-by-the-losing-projection'

  // The projection takes the fence the way a real cold build does, OUTSIDE its
  // own transaction — as `writeFence.integration.test.ts` stages it. The claim
  // is an UPDATE on `read_model_projection_state`; holding that row inside the
  // open transaction would make the promotion's own claim BLOCK on it instead
  // of racing it, and this check would measure a lock wait while reporting
  // nothing about the fence.
  await claimReadModelWriteFence(db.pool, B, null, COLD, null)

  // CONTROL FIRST: without it "the assert threw" could be an assert that always
  // throws. (An always-throwing assert and a no-op claim both fail on it.)
  const control = await db.pool.connect()
  let controlHeld = false
  let controlError: unknown = null
  try {
    await control.query('BEGIN')
    await assertReadModelWriteFence(control, B, COLD)
    controlHeld = true
  } catch (error) {
    controlError = error
  } finally {
    // Thread the failure into `release()`. Bare `release()` returns the client
    // to the pool STILL INSIDE its transaction (pg-pool removes it only for a
    // truthy argument) — a silent pool wedge.
    const rollback = await control.query('ROLLBACK').then(() => null, (error: unknown) => error)
    control.release((rollback ?? undefined) as Error | undefined)
  }
  check(controlHeld, 'armB.controlHoldsItsOwnFence',
    `the holder could not assert its own fence (${String(controlError)}), so the refusal below proves nothing`)

  const projection = await db.pool.connect()
  let fenceError: unknown = null
  let sentinelPresentBeforeRollback = -1
  let committed = false
  let reportB: Awaited<ReturnType<typeof apply>> | null = null
  try {
    await projection.query('BEGIN')
    await projection.query(
      'INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES ($1, $2, $3, $4::jsonb)',
      [B.landscapeId, B.versionId, SENTINEL, JSON.stringify({ id: SENTINEL })])
    // N12: the row must be PROVEN present before the rollback. Asserting only
    // that it is absent afterwards would pass with the INSERT deleted — a zero
    // with no evidence anything was ever there.
    sentinelPresentBeforeRollback = (await projection.query(
      'SELECT 1 FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
      [B.landscapeId, B.versionId, SENTINEL])).rowCount ?? -1

    // THE APPLY, issued while the transaction above is open.
    reportB = await apply(B)

    // …and this is the projection's LAST act before COMMIT.
    try {
      await assertReadModelWriteFence(projection, B, COLD)
    } catch (error) {
      fenceError = error
    }
    if (fenceError) {
      await projection.query('ROLLBACK')
    } else {
      // The mutant's path, and committing is deliberate: the damage the fence
      // exists to stop IS this COMMIT succeeding, so the check lets it happen
      // and then observes the wreckage rather than asserting on an intention.
      await projection.query('COMMIT')
      committed = true
    }
  } finally {
    const rollback = await projection.query('ROLLBACK').then(() => null, (error: unknown) => error)
    projection.release((rollback ?? undefined) as Error | undefined)
  }

  // The error is INSPECTED, not merely counted. A bare `catch { threw = true }`
  // passes for any fault that kills the session between BEGIN and the assert —
  // a backend termination or an idle-in-transaction timeout would leave every
  // assertion green while the fence was never exercised.
  const fenceLost = fenceError instanceof ReadModelWriteFenceError
  const fenceAfterApply = await readFence(B)
  check(fenceLost, 'armB.losingProjectionFailedItsOwnAssert',
    fenceError ? `threw ${String(fenceError)}` : 'the promotion did not rotate the write fence')
  check(isLifecycleWriteFence(fenceAfterApply), 'armB.fenceIsTheLIFECYCLEholder',
    `write_fence is ${fenceAfterApply ?? 'NULL'} — the refusal must be caused by the promotion, not by a dead session`)
  check(!committed, 'armB.losingProjectionDidNotCommit')
  check(sentinelPresentBeforeRollback === 1, 'armB.sentinelWasPresentBEFOREtheRollback',
    `${sentinelPresentBeforeRollback} row(s) — without this the absence below proves nothing`)

  const sentinel = await db.pool.query(
    'SELECT 1 FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
    [B.landscapeId, B.versionId, SENTINEL])
  check(sentinel.rowCount === 0, 'armB.rolledBackWhole', `${sentinel.rowCount} sentinel row(s) survived`)

  const staticB = await db.pool.query(
    'SELECT 1 FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2',
    [B.landscapeId, B.versionId])
  check(staticB.rowCount === 1, 'armB.publishedRowsSurvived', `${staticB.rowCount} static row(s)`)
  check(reportB?.blockers.length === 0, 'armB.applyWasNotBlocked',
    reportB?.blockers.map((b) => b.code).join(',') ?? 'no report')

  facts.armB = {
    controlHeld, fenceLost, committed,
    fenceAfterApply: fenceAfterApply === null ? null : String(fenceAfterApply).slice(0, 18) + '…',
    sentinelPresentBeforeRollback, sentinelRowsSurviving: sentinel.rowCount, staticRows: staticB.rowCount,
  }
  return { facts, failures }
}

// ── entry point ────────────────────────────────────────────────────────────
// Every path prints exactly ONE `QARESULT` line and exits from HERE, so the
// cleanup in `finally` always runs first.
const cleanup: { db?: IsolatedSchemaDb; repo?: Repo } = {}
let outcome: Outcome
const databaseUrl = process.env.TEST_DATABASE_URL

if (!databaseUrl) {
  outcome = { facts: {}, failures: ['TEST_DATABASE_URL is unset'], void: 'no-database' }
} else {
  try {
    outcome = await run(databaseUrl, cleanup)
  } catch (error) {
    // A throw is neither a pass nor a silent absence. Reported on the same line
    // shape, so the harness's `witness` still matches and the run is visibly a
    // failure.
    outcome = { facts: {}, failures: [`threw: ${error instanceof Error ? error.message : String(error)}`] }
  } finally {
    await cleanup.repo?.shutdown().catch(() => undefined)
    await cleanup.db?.teardown().catch(() => undefined)
  }
}

const pass = outcome.failures.length === 0 && outcome.void === undefined
console.log(`QARESULT ${JSON.stringify({
  test: 'promotion-door',
  reached: true,
  ...(outcome.void ? { void: outcome.void } : {}),
  ...outcome.facts,
  failures: outcome.failures,
  pass,
})}`)
process.exit(pass ? 0 : 1)
