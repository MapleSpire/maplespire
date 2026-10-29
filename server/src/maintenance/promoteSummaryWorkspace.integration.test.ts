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
 * The summary promotion primitive against REAL Postgres and REAL Automerge
 * storage.
 *
 * Everything here is a property of DURABLE state, which is why it cannot live
 * in the unit suite: "the allow-list committed before the root flipped" is only
 * checkable by stopping between the two and reading what survived. A fake
 * database cannot tell a committed row from an intended one, and a step LOG
 * would only prove the code called its own hooks in order.
 *
 * So the ordering tests CRASH: a hook throws at a named step, and the
 * assertions are made against the database, the storage table and `fsck` —
 * exactly the state a restarted server would find. The bug each test guards
 * against is named on it.
 *
 * The fence wait uses an injected clock/sleep pair, so no wall time is spent on
 * a fact that is about ORDER, not duration; the assertion is on the elapsed
 * value the promotion itself observed, not on "sleep was called".
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Repo, type StorageAdapterInterface } from '@automerge/automerge-repo'
import { createEmptyRoot } from '../automergeServer.js'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { cachedHandles, findReadyDocument } from '../automergeRepoCompat.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import { evictWorkspaceDocumentCache } from '../syncCells/repoFreshness.js'
import { coverWorkspace } from '../rbac/claimCoverage.js'
import { BASELINE_FENCE_ARMING_BOUND_MS, BASELINE_FENCE_TTL_MS } from '../rbac/docScope.js'
import { digestOfIds } from '../readModel/contentDigest.js'
import { assertReadModelPlane } from '../readModel/projectionAuthority.js'
import { fsckWorkspace } from './workspaceFsck.js'
import { repairReferenceIntegrity, type ReferenceRepairPlan } from './referenceIntegrityRepair.js'
import { asLegacyStaticOrphan } from '../testing/legacyStaticOrphan.js'
import {
  PROMOTED_STATIC_SOURCE,
  demoteSummaryWorkspace,
  promoteSummaryWorkspace,
  repairSummaryFlag,
  type PromotionStep,
  type SummaryDemotionReport,
  type SummaryFlagRepairReport,
} from './promoteSummaryWorkspace.js'
import { openBootstrapScope } from '../bootstrapScope.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

const idOf = (url: string) => url.replace(/^automerge:/, '').split('?')[0]

interface RootDoc {
  modelUrl?: string
  modelMetaUrl?: string
  shardUrls?: string[]
  registryWriteUrl?: string
  registrySummaryOnly?: boolean
  diagramCount?: number
}

describe.skipIf(!TEST_DATABASE_URL)('summary promotion (live Postgres + real Automerge storage)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb
  let storage: StorageAdapterInterface
  let repo: Repo

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'promote_summary')
    const { ensureReadModelSchema } = await import('../readModel/schema.js')
    await ensureReadModelSchema(db.pool)
    // Minimal shapes of the tables this primitive touches outside the read
    // model (no FKs — the suite owns every row it reads; the real DDL is in
    // db.ts / syncCells/ownership.ts).
    await db.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      parent_version_id TEXT, kind TEXT DEFAULT 'version', status TEXT DEFAULT 'active',
      base_manifest JSONB,
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
    storage = new PostgresStorageAdapter({ db: db.pool })
    // `network: []` — with an adapter attached and no peer connected,
    // `repo.find()` never settles for a missing document, which is exactly
    // what the preconditions have to be able to report.
    repo = new Repo({ storage, network: [], saveDebounceRate: 0 })
  })

  afterAll(async () => {
    await repo?.shutdown().catch(() => undefined)
    await db?.teardown()
  })

  /**
   * A PROMOTABLE ordinary workspace, provisioned the way production does:
   * `createEmptyRoot` (root + legacy monolith + ModelMeta + one object shard
   * that is also its overlay head + one connection shard likewise + one
   * registry shard) plus a starter diagram, then admitted, covered, projected
   * and SEALED.
   */
  async function provision(landscapeId: string, versionId: string): Promise<{
    rootUrl: string
    diagramId: string
    diagramDocUrl: string
    registryUrl: string
  }> {
    // The single choke point where this file creates a workspace, so it is
    // where the lifecycle witness learns which keys are its own to police.
    ownedLockKeys.add(lockKeyOf(landscapeId, versionId))
    const { rootUrl, documentIds } = await createEmptyRoot(repo, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-test' }, { kind: 'unfenced', reason: 'no-forker' }), { starterDiagram: true })
    await db.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, $3)`,
      [landscapeId, versionId, rootUrl],
    )
    for (const documentId of documentIds) {
      await db.pool.query(
        `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
         VALUES ($1, $2, $3) ON CONFLICT (document_id) DO NOTHING`,
        [documentId, landscapeId, versionId],
      )
    }
    const root = (await findReadyDocument<RootDoc>(repo, rootUrl)).doc()!
    const registryUrl = root.shardUrls![0]
    const registry = (await findReadyDocument<{ diagrams: Record<string, { docUrl: string }> }>(
      repo, registryUrl,
    )).doc()!
    const [diagramId, meta] = Object.entries(registry.diagrams)[0]

    // The read model, as the fleet projector would have left it.
    await db.pool.query(
      `INSERT INTO ro_diagrams (landscape_id, version_id, id, data)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [landscapeId, versionId, diagramId, JSON.stringify({ id: diagramId, docUrl: meta.docUrl })],
    )
    await coverWorkspace(db.pool, { landscapeId, versionId }, '0')
    // The read-model content seals, at the generation the row carries. Empty sets for the
    // three kinds this fixture has no rows for; the diagram kind is the one
    // that actually compares something.
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
      [landscapeId, versionId, JSON.stringify(sealed)],
    )
    return { rootUrl, diagramId, diagramDocUrl: meta.docUrl, registryUrl }
  }

  /** Every storage write in this fixture predates the projection, so the
   * arrival-watermark witness can prove absence. Re-stamped right before a run
   * because an earlier test's writes share the storage table. */
  async function markProjectionCurrent(landscapeId: string, versionId: string): Promise<void> {
    await db.pool.query(
      `UPDATE read_model_projection_state SET last_projected_at = now()
        WHERE landscape_id = $1 AND version_id = $2`,
      [landscapeId, versionId],
    )
  }

  /** An injected clock+sleep pair, so the fence wait costs no wall time and the
   * elapsed value is OBSERVABLE rather than merely intended. */
  function fakeClock() {
    let now = 1_700_000_000_000
    return {
      clock: () => now,
      sleep: async (ms: number) => { now += ms },
      advance: (ms: number) => { now += ms },
      get now() { return now },
    }
  }

  async function promote(
    landscapeId: string,
    versionId: string,
    extra: Partial<Parameters<typeof promoteSummaryWorkspace>[0]> = {},
  ) {
    const timing = fakeClock()
    await markProjectionCurrent(landscapeId, versionId)
    const report = await promoteSummaryWorkspace({
      db: db.pool,
      repo,
      residency: null,
      storage,
      workspace: { landscapeId, versionId },
      connectedPeers: () => 0,
      expectedProjectorInstanceId: 'run-under-test',
      clock: timing.clock,
      sleep: timing.sleep,
      ...extra,
    })
    return { report, timing }
  }

  const readRoot = async (rootUrl: string) => (await findReadyDocument<RootDoc>(repo, rootUrl)).doc()!
  const staticRow = async (landscapeId: string, versionId: string) => (
    await db.pool.query<{ source: string }>(
      `SELECT source FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2`,
      [landscapeId, versionId],
    )
  ).rows[0] ?? null
  const allowListRows = async (landscapeId: string, versionId: string) => (
    await db.pool.query<{ document_id: string; kind: string; entity_id: string | null }>(
      `SELECT document_id, kind, entity_id FROM read_model_static_documents
        WHERE landscape_id = $1 AND version_id = $2`,
      [landscapeId, versionId],
    )
  ).rows

  /**
   * The lifecycle key text, recomputed HERE rather than imported (as
   * `referenceIntegrityRepair.test.ts` also does): a witness that imports the
   * implementation's arithmetic agrees with it by construction, including when
   * both are wrong. This is the wire format of an exclusion between processes,
   * so the test states it independently.
   */
  const lockKeyOf = (landscapeId: string, versionId: string): number => {
    const text = `promote-summary:${landscapeId}:${versionId}`
    let hash = 0x811c9dc5
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    return hash | 0
  }

  /**
   * The lifecycle keys THIS FILE could legitimately hold: one per workspace it
   * has provisioned, plus the control sentinel. Filled by `provision`.
   *
   * Advisory locks are CLUSTER-wide; the database filter handles a sibling
   * DATABASE, but vitest workers share ONE database with separate schemas, so
   * without this scoping a concurrent FILE holding a
   * `promote-summary:<its own workspace>` key would be counted here as if this
   * file's promotion had leaked.
   *
   * This narrows the witness, it does not soften it. The proposition asserted
   * is "the door under test released ITS key", and every arm calls
   * `provision` for the workspace it then promotes — including the arm that
   * requires the count to read exactly 1 from inside the promotion's own
   * window, which is what stops this from becoming a witness that can only
   * return zero.
   */
  const witnessSentinelKey = lockKeyOf('__witness-control__', 'V0')
  const ownedLockKeys = new Set<number>([witnessSentinelKey])

  /**
   * How many lifecycle apply keys a LIVE session in this database holds.
   *
   * `EXISTS (pg_stat_activity)` filters out backends that have already gone:
   * `releaseLifecycleApplyLock` destroys the connection whenever the unlock
   * cannot be proven, and pg-pool's destroy is asynchronous, so a `pg_locks`
   * row can outlive its session by a few milliseconds. The defect these
   * assertions catch is a key held by a connection that is BACK IN THE POOL
   * AND ALIVE (a bare `release()` keeps the lock); a dying backend cannot
   * serve anybody, so filtering it out makes the assertion narrower and
   * stronger rather than adding a timing bet.
   */
  const heldLifecycleKeysNow = async (): Promise<number> => {
    const { rows } = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_locks lock
        -- SCOPED TO THIS DATABASE. Advisory locks are CLUSTER-wide, so an
        -- unfiltered count also sees a sibling database on the same Postgres
        -- server and this assertion fails on a defect that is not there.
        -- Measured, not guessed: a second suite running on another database of
        -- this server held classid 21337 and turned every one of these three
        -- copies into \`expected 1 to be +0\`.
        WHERE lock.locktype = 'advisory' AND lock.classid = $1 AND lock.objsubid = 2
          AND lock.granted
          AND lock.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          -- LIVE sessions only — see the docstring above for the measurement.
          AND EXISTS (SELECT 1 FROM pg_stat_activity backend WHERE backend.pid = lock.pid)
          -- AND SCOPED TO THIS FILE'S OWN WORKSPACES — see \`ownedLockKeys\`.
          -- Sixteen workers share one database; the filter above is not enough.
          -- \`::bigint\`, because \`objid\` is an unsigned \`oid\` while the key is a
          -- signed int32 that is frequently negative.
          AND lock.objid::bigint = ANY($2::bigint[])`,
      [0x5359, [...ownedLockKeys].map((key) => key >>> 0)],
    )
    return Number(rows[0].n)
  }

  /**
   * The same count, with the instrument's OWN CONTROL taken on every call.
   *
   * WHY PER CALL. Most arms assert `heldLifecycleKeys() === 0`, and a witness
   * that can only ever return zero (e.g. a predicate broken into `AND false`)
   * satisfies `toBe(0)` perfectly. A control in one neighbouring arm does not
   * protect the others.
   *
   * So the control lives in the instrument: take a sentinel key on a
   * scratch connection, require the count to RISE BY EXACTLY ONE, drop it, and
   * only then answer. `+1` and not `> 0`: a witness miscounting in some other
   * way is a different defect, and a control that accepts any positive number
   * would pass through it.
   *
   * The sentinel is a workspace no test provisions, keyed through the same
   * `promote-summary:<lid>:<vid>` text as a real one, so the control exercises
   * the arithmetic under test rather than a special case beside it.
   */
  const heldLifecycleKeys = async (): Promise<number> => {
    const before = await heldLifecycleKeysNow()
    const sentinel = witnessSentinelKey
    const client = await db.pool.connect()
    let witnessed: number
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS locked', [0x5359, sentinel],
      )
      // `pg_try_`, never the blocking form: nothing else takes this key, so a
      // refusal means the fixture is not what this control assumes, and hanging
      // the suite is a worse way to report that than failing it.
      if (rows[0]?.locked !== true) throw new Error('witness control could not take the sentinel key')
      witnessed = await heldLifecycleKeysNow()
      await client.query('SELECT pg_advisory_unlock($1, $2)', [0x5359, sentinel])
    } finally {
      // Bare is correct ONLY because the unlock above is proven by the
      // `witnessed` assertion below plus the next call's `before`; a leaked
      // sentinel would make every subsequent control read one too high and
      // fail loudly rather than silently.
      client.release()
    }
    if (witnessed !== before + 1) {
      throw new Error(
        `the pg_locks witness is not capable of reporting a held key: it read ${before} with none `
        + `of its own held and ${witnessed} while holding one. Every \`toBe(0)\` backed by it is `
        + 'vacuous until this is fixed.',
      )
    }
    return before
  }

  // ── the happy path ────────────────────────────────────────────────────────

  it('promotes an ordinary workspace and leaves fsck CLEAN', async () => {
    const L = 'L-promote'
    const { rootUrl, diagramId, diagramDocUrl, registryUrl } = await provision(L, 'V1')

    const before = await fsckWorkspace(db.pool, repo, { landscapeId: L, versionId: 'V1' }, rootUrl)
    expect(before.status).toBe('clean') // anti-void: it was promotable to begin with

    const released: string[] = []
    const { report } = await promote(L, 'V1', {
      apply: true,
      hooks: { releaseOrdinaryProjector: (_key, reason) => released.push(reason) },
    })
    expect(report.blockers).toEqual([])
    expect(report.applied).not.toBeNull()
    expect(released).toEqual(['promoted'])

    // The ROOT carries the summary contract, at the SAME url (in place, never
    // rotated — every client cache and `versions.root_url` keys off it).
    const root = await readRoot(rootUrl)
    expect(root.registrySummaryOnly).toBe(true)
    expect(root.diagramCount).toBe(1)
    expect(root.registryWriteUrl).toBe(report.applied!.writeHeadUrl)
    // The frozen baseline registry KEEPS its place: removing it would make fsck
    // report every diagram document orphaned.
    expect(root.shardUrls).toEqual([registryUrl, report.applied!.writeHeadUrl])

    const meta = (await findReadyDocument<{ staticBaseline?: boolean }>(repo, root.modelMetaUrl!)).doc()!
    expect(meta.staticBaseline).toBe(true)

    expect((await staticRow(L, 'V1'))?.source).toBe(PROMOTED_STATIC_SOURCE)
    const rows = await allowListRows(L, 'V1')
    expect(rows).toHaveLength(report.applied!.allowListSize)
    expect(rows.find((row) => row.document_id === idOf(report.applied!.writeHeadUrl))?.kind)
      .toBe('registry-shard')
    expect(rows.find((row) => row.document_id === idOf(registryUrl))?.kind).toBe('registry')
    expect(rows.find((row) => row.document_id === idOf(diagramDocUrl)))
      .toMatchObject({ kind: 'diagram', entity_id: diagramId })
    expect(rows.find((row) => row.document_id === idOf(rootUrl))?.kind).toBe('root')

    const after = await fsckWorkspace(db.pool, repo, { landscapeId: L, versionId: 'V1' }, rootUrl)
    expect(after.findings).toEqual([])
    expect(after.status).toBe('clean')
  })

  it('a second promotion of the same workspace is REFUSED (it would mint a second write head)', async () => {
    const { report } = await promote('L-promote', 'V1', { apply: true })
    expect(report.blockers.map((blocker) => blocker.code)).toContain('already-summary')
    expect(report.applied).toBeNull()
  })

  it('keeps the control documents durable across the ordinary projector residency release', async () => {
    const L = 'L-promotion-residency'
    const { rootUrl, registryUrl } = await provision(L, 'V1')
    const root = await findReadyDocument<RootDoc>(repo, rootUrl)
    const metaUrl = root.doc().modelMetaUrl!
    const meta = await findReadyDocument<{ staticBaseline?: boolean }>(repo, metaUrl)
    const registry = await findReadyDocument(repo, registryUrl)
    const residency = new AutomergeResidencyLeases(repo)
    const ordinaryOwner = 'ordinary-projector-residency-regression'
    for (const handle of [root, meta, registry]) residency.acquire(handle, ordinaryOwner, `${L}/V1`)
    let afterRelease: { rootRetained: boolean; metaRetained: boolean; registryEvicted: boolean } | undefined
    const cold = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [] })
    try {
      const { report } = await promote(L, 'V1', {
        apply: true,
        residency,
        hooks: {
          releaseOrdinaryProjector: () => {
            // This is the release performed by ProjectorFleet.stop, not an
            // order-only spy: it actually removes unleased cached handles.
            residency.releaseOwner(ordinaryOwner)
            const handles = cachedHandles(repo)
            afterRelease = {
              rootRetained: handles[root.documentId] === root,
              metaRetained: handles[meta.documentId] === meta,
              registryEvicted: handles[registry.documentId] === undefined,
            }
          },
        },
      })
      expect(report.blockers).toEqual([])
      expect(report.applied).not.toBeNull()
      // Read through a fresh Repo before shutdown/flush can repair the writer.
      const durableRoot = (await findReadyDocument<RootDoc>(cold, rootUrl)).doc()
      const durableMeta = (await findReadyDocument<{ staticBaseline?: boolean }>(cold, metaUrl)).doc()
      expect(durableRoot.registrySummaryOnly).toBe(true)
      expect(durableRoot.registryWriteUrl).toBe(report.applied!.writeHeadUrl)
      expect(durableRoot.shardUrls).toEqual([registryUrl, report.applied!.writeHeadUrl])
      expect(durableMeta.staticBaseline).toBe(true)
      expect(afterRelease).toEqual({ rootRetained: true, metaRetained: true, registryEvicted: true })
      await residency.drain()
      expect((await residency.snapshot()).leaseOwners).toBe(0)
    } finally {
      residency.releaseOwner(ordinaryOwner)
      await residency.drain()
      await cold.shutdown()
    }
  })

  it('keeps the newly durable registry head resident until publication', async () => {
    const L = 'L-promotion-head-residency'
    await provision(L, 'V1')
    const existing = new Set(Object.keys(cachedHandles(repo)))
    const residency = new AutomergeResidencyLeases(repo)
    let checkedHead: string | undefined
    const { report } = await promote(L, 'V1', {
      apply: true, residency,
      hooks: {
        onStep: async step => {
          if (step !== 'write-head-durable') return
          const fresh = Object.values(cachedHandles(repo)).filter(handle => !existing.has(handle.documentId))
          expect(fresh).toHaveLength(1)
          const head = fresh[0]
          checkedHead = head.url
          // A missing lease on the fresh head is invisible to the
          // control-document tests, so exercise the real eviction at this await.
          expect(await residency.evict(head.documentId)).toBe(false)
          expect(cachedHandles(repo)[head.documentId]).toBe(head)
        },
      },
    })
    expect(report.applied?.writeHeadUrl).toBe(checkedHead)
    expect(checkedHead).toBeDefined()
    await residency.drain()
    expect((await residency.snapshot()).leaseOwners).toBe(0)
  })

  it.each(['absent', 'reloaded'] as const)('refuses a forced ownership eviction with a %s ModelMeta handle', async (mode) => {
    const L = `L-promotion-forced-${mode}`
    const { rootUrl } = await provision(L, 'V1')
    const root = await findReadyDocument<RootDoc>(repo, rootUrl)
    const metaUrl = root.doc().modelMetaUrl!
    const oldMeta = await findReadyDocument(repo, metaUrl)
    const residency = new AutomergeResidencyLeases(repo)
    let evictions = 0
    await expect(promote(L, 'V1', {
      apply: true,
      residency,
      hooks: {
        onStep: async (step) => {
          if (step !== 'fence-waited') return
          expect(residency.isLeased(oldMeta.documentId)).toBe(true)
          // The production ownership-loss path intentionally ignores leases.
          evictions = await evictWorkspaceDocumentCache(repo, db.pool, { landscapeId: L, versionId: 'V1' }, residency)
          expect(cachedHandles(repo)[oldMeta.documentId]).toBeUndefined()
          if (mode === 'reloaded') {
            expect(await findReadyDocument(repo, metaUrl)).not.toBe(oldMeta)
          }
        },
      },
    })).rejects.toThrow(`promotion control document ${oldMeta.documentId} was evicted or replaced`)
    expect(evictions).toBeGreaterThan(0)
    expect((await staticRow(L, 'V1'))?.source).toBe(PROMOTED_STATIC_SOURCE)
    const cold = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [] })
    try {
      expect((await findReadyDocument<RootDoc>(cold, rootUrl)).doc().registrySummaryOnly).toBeUndefined()
      expect((await findReadyDocument<{ staticBaseline?: boolean }>(cold, metaUrl)).doc().staticBaseline).toBeUndefined()
    } finally {
      await cold.shutdown()
      await residency.drain()
    }
    expect((await residency.snapshot()).leaseOwners).toBe(0)
  })

  it.each(['report', 'refusal', 'witness-error', 'write-head-durable', 'static-committed', 'fence-waited'] as const)(
    'releases promotion residency after %s', async (exit) => {
      const L = `L-promotion-cleanup-${exit}`
      const { rootUrl } = await provision(L, 'V1')
      const root = await findReadyDocument<RootDoc>(repo, rootUrl)
      const meta = await findReadyDocument(repo, root.doc().modelMetaUrl!)
      const residency = new AutomergeResidencyLeases(repo)
      const interrupted = new Error(`promotion interrupted at ${exit}`)
      let observedAcquisition = false
      const pending = promote(L, 'V1', {
        apply: exit !== 'report',
        residency,
        connectedPeers: () => exit === 'refusal' ? 1 : 0,
        onProgress: (message) => {
          if (message !== 'running fsck') return
          observedAcquisition = residency.isLeased(root.documentId) && residency.isLeased(meta.documentId)
          if (exit === 'witness-error') throw interrupted
        },
        hooks: { onStep: (step) => { if (step === exit) throw interrupted } },
      })
      if (exit === 'report' || exit === 'refusal') {
        const { report } = await pending
        expect(report.applied).toBeNull()
        expect(report.blockers.map(blocker => blocker.code)).toEqual(exit === 'refusal' ? ['peers-connected'] : [])
      } else {
        await expect(pending).rejects.toBe(interrupted)
      }
      expect(observedAcquisition).toBe(true)
      await residency.drain()
      expect((await residency.snapshot()).leaseOwners).toBe(0)
    },
  )

  it('a concurrent report cannot release the applying invocation residency', async () => {
    const L = 'L-promotion-concurrent-residency'
    const { rootUrl } = await provision(L, 'V1')
    const root = await findReadyDocument<RootDoc>(repo, rootUrl)
    const meta = await findReadyDocument(repo, root.doc().modelMetaUrl!)
    const residency = new AutomergeResidencyLeases(repo)
    let entered!: () => void
    let resume!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { resume = resolve })
    const applyResult = promote(L, 'V1', {
      apply: true, residency,
      hooks: { onStep: async step => { if (step === 'write-head-durable') { entered(); await gate } } },
    }).then(value => ({ value, error: null }), error => ({ value: null, error }))
    try {
      await Promise.race([reached, applyResult.then(() => { throw new Error('promotion ended before the required pause') })])
      const { report } = await promote(L, 'V1', { residency })
      expect(report.blockers).toEqual([])
      expect(report.applied).toBeNull()
      expect(residency.isLeased(root.documentId)).toBe(true)
      expect(residency.isLeased(meta.documentId)).toBe(true)
      const handles = cachedHandles(repo)
      expect(handles[root.documentId]).toBe(root)
      expect(handles[meta.documentId]).toBe(meta)
    } finally {
      resume()
      await applyResult
      await residency.drain()
    }
    const applied = await applyResult
    expect(applied.error).toBeNull()
    expect(applied.value?.report.applied).not.toBeNull()
    await residency.drain()
    expect((await residency.snapshot()).leaseOwners).toBe(0)
  })

  it.each(['meta-reject', 'meta-evict', 'meta-replace', 'root-evict'] as const)(
    'keeps residency until an in-flight save settles (%s)', async (mode) => {
      const L = `L-promotion-save-${mode}`
      const { rootUrl } = await provision(L, 'V1')
      const root = await findReadyDocument<RootDoc>(repo, rootUrl)
      const metaUrl = root.doc().modelMetaUrl!
      const meta = await findReadyDocument(repo, metaUrl)
      const residency = new AutomergeResidencyLeases(repo)
      const saveTarget = mode === 'root-evict' ? root.documentId : meta.documentId
      const failure = new Error('injected control-document storage failure')
      let armed = false
      let saveCalls = 0
      let settled = false
      let entered!: () => void
      let resume!: () => void
      const reached = new Promise<void>(resolve => { entered = resolve })
      const gate = new Promise<void>(resolve => { resume = resolve })
      const save = storage.save.bind(storage)
      const spy = vi.spyOn(storage, 'save').mockImplementation(async (key, bytes) => {
        if (armed && key[0] === saveTarget) {
          saveCalls++
          entered()
          await gate
          if (mode === 'meta-reject') throw failure
        }
        return save(key, bytes)
      })
      const outcome = promote(L, 'V1', {
        apply: true, residency,
        hooks: { onStep: step => { if (step === 'fence-waited') armed = true } },
      }).then(value => { settled = true; return { value, error: null } }, error => {
        settled = true; return { value: null, error }
      })
      let result: Awaited<typeof outcome> | undefined
      try {
        await Promise.race([reached, outcome.then(() => { throw new Error('promotion ended before the required save') })])
        expect(saveCalls).toBeGreaterThan(0)
        expect(settled).toBe(false)
        expect(residency.isLeased(root.documentId)).toBe(true)
        expect(residency.isLeased(meta.documentId)).toBe(true)
        if (mode !== 'root-evict') expect(root.doc().registrySummaryOnly).toBeUndefined()
        if (mode !== 'meta-reject') {
          expect(await evictWorkspaceDocumentCache(repo, db.pool, { landscapeId: L, versionId: 'V1' }, residency))
            .toBeGreaterThan(0)
          if (mode === 'meta-replace') expect(await findReadyDocument(repo, metaUrl)).not.toBe(meta)
        }
      } finally {
        resume()
        result = await outcome
        spy.mockRestore()
        await residency.drain()
      }
      expect(result?.value).toBeNull()
      if (mode === 'meta-reject') expect(result?.error).toBe(failure)
      else expect(result?.error?.message).toContain(`promotion control document ${meta.documentId} was evicted or replaced`)
      expect((await residency.snapshot()).leaseOwners).toBe(0)
      const cold = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [] })
      try {
        const durableRoot = (await findReadyDocument<RootDoc>(cold, rootUrl)).doc()
        expect(durableRoot.registrySummaryOnly).toBe(mode === 'root-evict' ? true : undefined)
      } finally {
        await cold.shutdown()
      }
    },
  )

  // ── ORDER ─────────────────────────────────────────────────────────────────

  it('allow-list and static row commit BEFORE the root flip', async () => {
    // GUARDS AGAINST: flipping the root before the commit. This test stops the
    // promotion in the window between them and reads what a restarted server
    // would find. Under the correct order that is the recoverable DEGRADED
    // state (rows present, root still ordinary; see the module header of
    // `promoteSummaryWorkspace.ts` for its cost). Under the swap it would be
    // fsck `data-loss`: a summary-only root with no static row, whose diagrams
    // no cold client can list or open.
    const L = 'L-order'
    const { rootUrl } = await provision(L, 'V1')
    const crash = new Error('simulated crash between the commit and the root flip')
    await expect(promote(L, 'V1', {
      apply: true,
      hooks: { onStep: (step: PromotionStep) => { if (step === 'fence-waited') throw crash } },
    })).rejects.toBe(crash)

    // Committed: the row AND the complete allow-list, in one transaction.
    expect((await staticRow(L, 'V1'))?.source).toBe(PROMOTED_STATIC_SOURCE)
    const rows = await allowListRows(L, 'V1')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter((row) => row.kind === 'registry-shard')).toHaveLength(1)

    // NOT committed: the root is untouched.
    const root = await readRoot(rootUrl)
    expect(root.registrySummaryOnly).toBeUndefined()
    expect(root.registryWriteUrl).toBeUndefined()

    // And the verdict a restarted server's fsck would reach.
    const report = await fsckWorkspace(db.pool, repo, { landscapeId: L, versionId: 'V1' }, rootUrl)
    expect(report.findings.map((finding) => finding.severity)).not.toContain('data-loss')
    const coherence = report.findings.find((finding) => finding.check === 'summary-static-coherence')
    expect(coherence?.severity).toBe('degraded')
  })

  it('the write head is durable and claimed BEFORE the root names it', async () => {
    // GUARDS AGAINST: flipping the root before the transaction. Stopped in the
    // same window, the write head must already be (a) in storage and (b)
    // admitted to this workspace, while the root still names neither — so a
    // cold boot after the crash resolves everything the root points at.
    //
    // Of the three assertions below only the LAST one — "the root must not
    // name it yet" — is independently discriminating. Dropping step 1's
    // `repo.flush` would stay green (the storage adapter under
    // `saveDebounceRate: 0` persists a created document on its own), and so
    // would dropping the explicit `claimWorkspaceDocuments`
    // (`markStaticReadModelWorkspace` registers the same admission). Those are
    // belt-and-braces; what this test pins is the ORDER.
    const L = 'L-writehead'
    const { rootUrl } = await provision(L, 'V1')
    let writeHeadUrl = ''
    const crash = new Error('simulated crash before the root flip')
    await expect(promote(L, 'V1', {
      apply: true,
      hooks: {
        onStep: async (step: PromotionStep) => {
          if (step === 'static-committed') {
            const rows = await allowListRows(L, 'V1')
            writeHeadUrl = rows.find((row) => row.kind === 'registry-shard')!.document_id
          }
          if (step === 'fence-waited') throw crash
        },
      },
    })).rejects.toBe(crash)
    expect(writeHeadUrl).not.toBe('')

    const stored = await db.pool.query(
      `SELECT 1 FROM automerge_storage WHERE split_part(key, '/', 1) = $1 LIMIT 1`, [writeHeadUrl],
    )
    expect(stored.rowCount, 'the write head must be DURABLE').toBe(1)
    const admitted = await db.pool.query<{ landscape_id: string; version_id: string }>(
      `SELECT landscape_id, version_id FROM automerge_document_workspace WHERE document_id = $1`,
      [writeHeadUrl],
    )
    expect(admitted.rows[0], 'the write head must be CLAIMED').toEqual({ landscape_id: L, version_id: 'V1' })

    const root = await readRoot(rootUrl)
    expect(root.registryWriteUrl, 'the root must not name it yet').toBeUndefined()
    expect(root.shardUrls).not.toContain(`automerge:${writeHeadUrl}`)

    // A COLD reader — a fresh repo over the same storage, the state a restarted
    // server is in — resolves it.
    const cold = new Repo({ storage, network: [], saveDebounceRate: 0 })
    try {
      const handle = await findReadyDocument<{ diagrams: Record<string, unknown> }>(
        cold, `automerge:${writeHeadUrl}`, 5_000,
      )
      expect(handle.doc()).toEqual({ diagrams: {} })
    } finally {
      await cold.shutdown()
    }
  })

  it('promotion waits out the FULL fence arming bound before flipping the root', async () => {
    // GUARDS AGAINST: no wait at all, or waiting a single
    // `BASELINE_FENCE_TTL_MS`, which is too short. Two fence caches sit in series in front of a
    // baseline write and neither refresh is synchronised with the COMMIT: the
    // global static-world bit (one TTL) and the per-document verdict, whose
    // expiry is stamped at the SETTLEMENT of a query that has its own
    // `BASELINE_FENCE_LOOKUP_DEADLINE_MS`. A write admitted inside the real
    // window is applied and acked, and then invisible to the summary world
    // that starts at the root flip.
    //
    // The assertion is on the elapsed value the promotion OBSERVED between its
    // own two steps, not on "sleep was called": a wait that sleeps for the
    // wrong duration fails here too.
    const L = 'L-fence'
    await provision(L, 'V1')
    await markProjectionCurrent(L, 'V1')
    const timing = fakeClock()
    let committedAt = -1
    let elapsedAtRootFlip = -1
    const report = await promoteSummaryWorkspace({
      db: db.pool,
      repo,
      residency: null,
      storage,
      workspace: { landscapeId: L, versionId: 'V1' },
      apply: true,
      connectedPeers: () => 0,
      expectedProjectorInstanceId: 'run-under-test',
      clock: timing.clock,
      sleep: timing.sleep,
      hooks: {
        onStep: (step: PromotionStep) => {
          if (step === 'static-committed') committedAt = timing.clock()
          if (step === 'root-flipped') elapsedAtRootFlip = timing.clock() - committedAt
        },
      },
    })

    expect(report.applied).not.toBeNull()
    expect(elapsedAtRootFlip).toBeGreaterThanOrEqual(BASELINE_FENCE_ARMING_BOUND_MS)
    expect(report.applied!.fenceWaitMs).toBeGreaterThanOrEqual(BASELINE_FENCE_ARMING_BOUND_MS)
    // One TTL is NOT enough — stated as its own assertion so a regression to
    // `BASELINE_FENCE_TTL_MS` fails on a line that says why.
    expect(BASELINE_FENCE_ARMING_BOUND_MS).toBeGreaterThan(BASELINE_FENCE_TTL_MS)
    expect(elapsedAtRootFlip).toBeGreaterThan(BASELINE_FENCE_TTL_MS)
    // …and it is the fence's own bound, not an unrelated constant that happens
    // to be large: bump either fence constant and this still holds, shorten the
    // wait to any fixed number below it and it fails.
    expect(elapsedAtRootFlip).toBeLessThan(BASELINE_FENCE_ARMING_BOUND_MS * 3)
  })

  // ── preconditions, against real facts ─────────────────────────────────────

  it('a diagram missing from ro_diagrams aborts the promotion', async () => {
    // GUARDS AGAINST: losing precondition 3. The DiagramDoc is reachable from
    // the registry but absent from ro_diagrams, so the allow-list derived from
    // the read model would omit it — and `resolveDurable`'s `static_allowed`
    // filter makes an unlisted document permanently unresolvable the moment the
    // static row lands. The document would still be in storage, and gone.
    const L = 'L-divergence'
    const { rootUrl, diagramDocUrl } = await provision(L, 'V1')
    await db.pool.query(`DELETE FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2`, [L, 'V1'])

    const { report } = await promote(L, 'V1', { apply: true })
    expect(report.blockers.map((blocker) => blocker.code)).toContain('crdt-sql-divergence')
    // The consequence: this exact document would have been left out of the
    // allow-list.
    expect(report.plan!.unclassified).toContain(idOf(diagramDocUrl))
    expect(report.applied).toBeNull()
    // Nothing was written — no half-promotion.
    expect(await staticRow(L, 'V1')).toBeNull()
    expect(await allowListRows(L, 'V1')).toEqual([])
    expect((await readRoot(rootUrl)).registrySummaryOnly).toBeUndefined()
  })

  it('refuses an uncovered workspace and a connected peer', async () => {
    const L = 'L-refusals'
    await provision(L, 'V1')
    const peered = await promote(L, 'V1', { apply: true, connectedPeers: () => 3 })
    expect(peered.report.blockers.map((blocker) => blocker.code)).toContain('peers-connected')
    expect(peered.report.applied).toBeNull()

    await db.pool.query(
      `UPDATE workspace_claim_coverage SET covered = false WHERE landscape_id = $1 AND version_id = $2`,
      [L, 'V1'],
    )
    const uncovered = await promote(L, 'V1', { apply: true })
    expect(uncovered.report.blockers.map((blocker) => blocker.code)).toContain('claim-coverage-missing')
    expect(uncovered.report.applied).toBeNull()
  })

  it('--allow-connected-peers overrides the quiesce and ONLY the quiesce, and records it', async () => {
    // The single overridable precondition. It exists because the online case is
    // a real operational scenario (the baseline fence + the client's epoch
    // guard close the residual window) and because the epoch-guard e2e has to
    // promote a workspace with a live classic tab on it. What it must NOT do is
    // become a general `force`: a divergence override would leave a document in
    // storage and unreachable forever, with no way back.
    const L = 'L-override'
    await provision(L, 'V1')
    const { report } = await promote(L, 'V1', {
      apply: true, connectedPeers: () => 2, allowConnectedPeers: true,
    })
    expect(report.blockers).toEqual([])
    expect(report.overridden.map((blocker) => blocker.code)).toEqual(['peers-connected'])
    expect(report.applied).not.toBeNull()

    // …and it does not touch anything else. A diverged workspace stays refused
    // even with the override on.
    const D = 'L-override-divergence'
    await provision(D, 'V1')
    await db.pool.query(`DELETE FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2`, [D, 'V1'])
    const diverged = await promote(D, 'V1', {
      apply: true, connectedPeers: () => 2, allowConnectedPeers: true,
    })
    expect(diverged.report.blockers.map((blocker) => blocker.code)).toContain('crdt-sql-divergence')
    expect(diverged.report.applied).toBeNull()
  })

  it('report mode gathers every witness and writes NOTHING', async () => {
    const L = 'L-dryrun'
    const { rootUrl } = await provision(L, 'V1')
    const { report } = await promote(L, 'V1')
    expect(report.mode).toBe('report')
    expect(report.blockers).toEqual([])
    expect(report.witnesses.fsck?.status).toBe('clean')
    expect(report.witnesses.integrity?.outcome).toBe('verified')
    expect(report.witnesses.freshness?.absenceProvable).toBe(true)
    expect(report.witnesses.quiesce).toBe('measured')
    expect(report.witnesses.registry?.diagramsInCrdt).toBe(1)
    expect(report.plan!.allowList.length).toBeGreaterThan(0)
    expect(report.applied).toBeNull()
    expect(await staticRow(L, 'V1')).toBeNull()
    expect((await readRoot(rootUrl)).registrySummaryOnly).toBeUndefined()
  })

  // ── de-promotion ──────────────────────────────────────────────────────────

  it('demotion is refused while a sparse child is active', async () => {
    const L = 'L-demote-child'
    await provision(L, 'V1')
    const promoted = await promote(L, 'V1', { apply: true })
    expect(promoted.report.applied).not.toBeNull()

    await db.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url, parent_version_id, kind, status, base_manifest)
       VALUES ($1, 'D1', 'automerge:childroot', 'V1', 'draft', 'active', $2::jsonb)`,
      [L, JSON.stringify({ mode: 'sparse-static' })],
    )
    const blocked = await demoteSummaryWorkspace({
      db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' },
      apply: true, connectedPeers: () => 0,
    })
    expect(blocked.blockers.map((blocker) => blocker.code)).toEqual(['sparse-child-active'])
    expect(blocked.applied).toBeNull()
    // still summary
    expect((await staticRow(L, 'V1'))?.source).toBe(PROMOTED_STATIC_SOURCE)

    // Discharge the child and the demotion goes through — the anti-void half.
    await db.pool.query(`UPDATE versions SET status = 'merged' WHERE landscape_id = $1 AND id = 'D1'`, [L])
    const done = await demoteSummaryWorkspace({
      db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' },
      apply: true, connectedPeers: () => 0,
    })
    expect(done.blockers).toEqual([])
    expect(done.applied).not.toBeNull()
  })

  it('demotion reverts the root FIRST, keeps the write head in shardUrls, and deletes the static rows', async () => {
    const L = 'L-demote'
    const { rootUrl, registryUrl } = await provision(L, 'V1')
    const { report } = await promote(L, 'V1', { apply: true })
    const writeHeadUrl = report.applied!.writeHeadUrl

    // A DIAGRAM IN THE WRITE HEAD, so the fsck at the end of this arm is not
    // vacuous: `registry-head-projected` does not skip an empty head, so on a
    // freshly minted head it would pass having compared zero diagrams.
    // Removing the `ro_diagrams` insert below makes the arm fail with a
    // `registry-head-projected` finding.
    //
    // Both sides are seeded because the check COMPARES them; seeding only the
    // head would turn a vacuous pass into a guaranteed failure.
    //
    // Its document is REAL — stored and admitted, as a client-created diagram's
    // is. A placeholder url (`automerge:dgSincePromotion`) used to pass here only
    // because every reachability check dropped an invalid url; `diagram-doc-url`
    // now reports exactly that.
    const sinceDoc = repo.create({
      name: 'Since', type: 'context', objectIds: [], connectionIds: [], groupIds: [],
      layouts: {}, comments: {}, flows: {}, checkpoints: [],
    })
    await repo.flush([sinceDoc.documentId])
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ($1, $2, $3) ON CONFLICT (document_id) DO NOTHING`,
      [idOf(sinceDoc.url), L, 'V1'],
    )
    const head = await findReadyDocument<{ diagrams: Record<string, { docUrl: string; name?: string }> }>(
      repo, writeHeadUrl,
    )
    head.change((doc) => {
      doc.diagrams = {
        ...(doc.diagrams ?? {}),
        'dg-since-promotion': { docUrl: sinceDoc.url, name: 'Since' },
      }
    })
    await repo.flush([head.documentId])
    await db.pool.query(
      `INSERT INTO ro_diagrams (landscape_id, version_id, id, data) VALUES ($1, $2, $3, $4::jsonb)`,
      [L, 'V1', 'dg-since-promotion', JSON.stringify({ id: 'dg-since-promotion', docUrl: sinceDoc.url })],
    )

    const steps: string[] = []
    const observed: Record<string, { summaryRoot: boolean; staticRow: boolean }> = {}
    const demotion = await demoteSummaryWorkspace({
      db: db.pool,
      repo,
      workspace: { landscapeId: L, versionId: 'V1' },
      apply: true,
      connectedPeers: () => 0,
      hooks: {
        onStep: async (step) => {
          steps.push(step)
          observed[step] = {
            summaryRoot: (await readRoot(rootUrl)).registrySummaryOnly === true,
            staticRow: (await staticRow(L, 'V1')) !== null,
          }
        },
      },
    })
    expect(demotion.blockers).toEqual([])
    // THE INVERSE ORDER, observed on durable state: at the moment the root has
    // already reverted, the static rows are still there. That intermediate is
    // fsck `degraded`; the opposite order's intermediate is `data-loss`.
    expect(observed['root-reverted']).toEqual({ summaryRoot: false, staticRow: true })
    expect(observed['static-deleted']).toEqual({ summaryRoot: false, staticRow: false })

    const root = await readRoot(rootUrl)
    expect(root.registrySummaryOnly).toBeUndefined()
    expect(root.diagramCount).toBeUndefined()
    // The write head STAYS: a classic client merges every shard, so every
    // diagram created since the promotion remains visible. Dropping it would
    // silently delete them.
    expect(root.shardUrls).toEqual([registryUrl, writeHeadUrl])
    expect(root.registryWriteUrl).toBe(writeHeadUrl)
    expect(await staticRow(L, 'V1')).toBeNull()
    expect(await allowListRows(L, 'V1')).toEqual([])
    const meta = (await findReadyDocument<{ staticBaseline?: boolean }>(repo, root.modelMetaUrl!)).doc()!
    expect(meta.staticBaseline).toBe(false)

    // TWO DELIBERATE RESIDUES, pinned here.

    // The write head keeps its workspace CLAIM. It has to: the head is still in
    // `shardUrls`, so it is reachable, and `document-admitted` would fire on a
    // reachable document with no claim. The fsck below is clean BECAUSE of this
    // row, not despite it.
    const claim = await db.pool.query(
      `SELECT landscape_id, version_id FROM automerge_document_workspace WHERE document_id = $1`,
      [idOf(writeHeadUrl)],
    )
    expect(claim.rows).toEqual([{ landscape_id: L, version_id: 'V1' }])

    // The lifecycle WRITE FENCE is not cleared. `readModel/health.ts` relies on
    // this: a projector attaching afterwards observes the sentinel as its
    // `expectedPrevious`.
    const fence = await db.pool.query<{ write_fence: string | null }>(
      `SELECT write_fence FROM read_model_projection_state
        WHERE landscape_id = $1 AND version_id = $2`,
      [L, 'V1'],
    )
    expect(fence.rows[0]?.write_fence).toMatch(/^lifecycle:/)

    // …and the workspace is structurally sound afterwards. NOT vacuous: the
    // write head above carries a diagram for `registry-head-projected` to
    // compare against `ro_diagrams`.
    const fsck = await fsckWorkspace(db.pool, repo, { landscapeId: L, versionId: 'V1' }, rootUrl)
    expect(fsck.findings).toEqual([])
    expect(fsck.status).toBe('clean')
  })

  // ── the allow-list ⇄ admission equality guard ─────────────────────────────

  it('an admitted-but-unlisted document aborts the promotion, and so does a listed-but-unadmitted one', async () => {
    // GUARDS AGAINST: losing the `allow-list-incomplete` guard, which stands
    // between a promotion and a document that `resolveDurable`'s
    // `static_allowed` filter stops resolving the moment the static row lands —
    // durable in storage, unreachable forever.
    //
    // Both senses, because they fail differently: an admitted document missing
    // from the list is one the promotion would strand; a listed document that
    // is not admitted means the list was built from a graph the admission table
    // disagrees with, and the disagreement is the finding.
    const L = 'L-allow-equality'
    const { rootUrl, registryUrl } = await provision(L, 'V1')
    const ghost = 'ghostdocumentid00000001'

    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3)`,
      [ghost, L, 'V1'],
    )
    const admittedOnly = await promote(L, 'V1', { apply: true })
    expect(admittedOnly.report.blockers.map((blocker) => blocker.code)).toContain('allow-list-incomplete')
    expect(admittedOnly.report.plan!.admittedButUnlisted).toContain(ghost)
    expect(admittedOnly.report.applied).toBeNull()
    expect(await staticRow(L, 'V1')).toBeNull()

    await db.pool.query(`DELETE FROM automerge_document_workspace WHERE document_id = $1`, [ghost])
    // The other direction: a document the root still reaches, whose admission
    // row is gone.
    await db.pool.query(`DELETE FROM automerge_document_workspace WHERE document_id = $1`, [idOf(registryUrl)])
    const listedOnly = await promote(L, 'V1', { apply: true })
    expect(listedOnly.report.blockers.map((blocker) => blocker.code)).toContain('allow-list-incomplete')
    expect(listedOnly.report.plan!.listedButUnadmitted).toContain(idOf(registryUrl))
    expect(listedOnly.report.applied).toBeNull()
    expect((await readRoot(rootUrl)).registrySummaryOnly).toBeUndefined()
  })

  // ── the two control documents ─────────────────────────────────────────────

  it('an apply whose ModelMeta does not resolve pushes a BLOCKER, never a silent no-op', async () => {
    // GUARDS AGAINST: a null handle silently returning the report. That would
    // produce `apply` + zero blockers + `applied: null` — a 200 from the route
    // and exit 0 from the script, both read as "done" on a workspace where
    // nothing happened. (The route's half — a 500 rather than a 200 for an
    // apply that changed nothing — is pinned in `summaryMigrationRoute.test.ts`.)
    const L = 'L-meta-gone'
    const { rootUrl } = await provision(L, 'V1')
    const metaId = idOf((await readRoot(rootUrl)).modelMetaUrl!)
    await db.pool.query(`DELETE FROM automerge_storage WHERE split_part(key, '/', 1) = $1`, [metaId])

    // A COLD repo — the state a restarted server is in. The suite's shared repo
    // still holds the document in memory, and asking it would prove nothing.
    const cold = new Repo({ storage, network: [], saveDebounceRate: 0 })
    try {
      const { report } = await promote(L, 'V1', { apply: true, repo: cold, resolveTimeoutMs: 2_000 })
      expect(report.blockers.map((blocker) => blocker.code)).toContain('meta-unresolved')
      expect(report.applied).toBeNull()
      expect(await staticRow(L, 'V1')).toBeNull()
    } finally {
      await cold.shutdown()
    }
  })

  // ── the override's cost, and what shortens it ─────────────────────────────

  it('an overridden quiesce drains the peers BEFORE the commit', async () => {
    // GUARDS AGAINST: draining only after the root flip. Under
    // `allowConnectedPeers` there ARE live classic tabs, and a diagram CREATED
    // by one of them between the commit and the flip is acked while the fence
    // is still arming, then lands in a document the static allow-list does not
    // carry: accepted, durable, unreachable. A drain after the fence wait
    // closes nothing.
    const L = 'L-drain-order'
    await provision(L, 'V1')
    const events: string[] = []
    const { report } = await promote(L, 'V1', {
      apply: true,
      connectedPeers: () => 2,
      allowConnectedPeers: true,
      hooks: {
        drainPeers: (_key, reason) => { events.push(`drain:${reason}`) },
        onStep: (step: PromotionStep) => { events.push(`step:${step}`) },
      },
    })
    expect(report.applied).not.toBeNull()
    expect(report.overridden.map((blocker) => blocker.code)).toEqual(['peers-connected'])

    const firstDrain = events.findIndex((event) => event.startsWith('drain:'))
    const commit = events.indexOf('step:static-committed')
    expect(firstDrain, 'the peers must be drained at all').toBeGreaterThanOrEqual(0)
    expect(commit).toBeGreaterThanOrEqual(0)
    expect(firstDrain, `drain order: ${events.join(' -> ')}`).toBeLessThan(commit)
    // The post-flip belt is KEPT — anything that reconnected in between is
    // asked again.
    expect(events.filter((event) => event.startsWith('drain:'))).toHaveLength(2)
  })

  it('WITHOUT an override there is nothing to drain early — exactly one drain, after the flip', async () => {
    // The anti-void half: without it the test above passes against a promotion
    // that drains unconditionally at the top, which would be a behaviour change
    // on the ordinary path rather than the override's cost being paid.
    const L = 'L-drain-control'
    await provision(L, 'V1')
    const events: string[] = []
    const { report } = await promote(L, 'V1', {
      apply: true,
      hooks: {
        drainPeers: () => { events.push('drain') },
        onStep: (step: PromotionStep) => { events.push(`step:${step}`) },
      },
    })
    expect(report.applied).not.toBeNull()
    expect(report.overridden).toEqual([])
    expect(events.filter((event) => event === 'drain')).toHaveLength(1)
    expect(events.indexOf('drain')).toBeGreaterThan(events.indexOf('step:root-flipped'))
  })

  // ── the apply lock ────────────────────────────────────────────────────────

  it('two concurrent applies mint ONE write head: the second is refused by the apply lock', async () => {
    // GUARDS AGAINST: losing the `pg_try_advisory_lock`. The TOCTOU it closes
    // is as wide as the registry materialisation (~33 s at 10k diagrams), and
    // what it costs is not a retry: the second `markStaticReadModelWorkspace` DELETEs
    // the first's allow-list before writing its own, so the root ends up naming
    // write head A while the only admitted, allow-listed head is B — and every
    // diagram created into A is durable and unreachable.
    //
    // The first promotion is PARKED inside the critical section (at
    // `write-head-durable`, after the lock and before the commit) so the race is
    // deterministic rather than a timing bet: with the lock removed the second
    // one sees a still-null static source, proceeds, and applies.
    const L = 'L-apply-lock'
    const { rootUrl } = await provision(L, 'V1')
    let openTheGate = (): void => {}
    const gate = new Promise<void>((resolve) => { openTheGate = resolve })
    let announceInside = (): void => {}
    const inside = new Promise<void>((resolve) => { announceInside = resolve })

    const first = promote(L, 'V1', {
      apply: true,
      hooks: {
        onStep: async (step: PromotionStep) => {
          if (step === 'write-head-durable') { announceInside(); await gate }
        },
      },
    })
    await inside

    const second = await promote(L, 'V1', { apply: true })
    expect(second.report.applied).toBeNull()
    expect(second.report.blockers.map((blocker) => blocker.code)).toContain('promotion-in-flight')

    openTheGate()
    const { report } = await first
    expect(report.applied).not.toBeNull()

    // ONE head, and it is the one the root names.
    const rows = await allowListRows(L, 'V1')
    expect(rows.filter((row) => row.kind === 'registry-shard').map((row) => row.document_id))
      .toEqual([idOf(report.applied!.writeHeadUrl)])
    const root = await readRoot(rootUrl)
    expect(root.registryWriteUrl).toBe(report.applied!.writeHeadUrl)
    expect(root.shardUrls).toContain(report.applied!.writeHeadUrl)

    const fsck = await fsckWorkspace(db.pool, repo, { landscapeId: L, versionId: 'V1' }, rootUrl)
    expect(fsck.findings).toEqual([])
    expect(fsck.status).toBe('clean')
  })

  it('a static row that appears behind the promotion back is caught before anything is written', async () => {
    // The other half of the TOCTOU the lock closes: a neighbouring promotion
    // may COMMIT and RELEASE while this one is gathering evidence, so the lock
    // alone would let a stale verdict apply on top of it.
    const L = 'L-witness-moved'
    await provision(L, 'V1')
    const { report: dry } = await promote(L, 'V1')
    expect(dry.blockers).toEqual([]) // anti-void: it was promotable a moment ago

    await db.pool.query(
      `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source) VALUES ($1, $2, $3)`,
      [L, 'V1', PROMOTED_STATIC_SOURCE],
    )
    const { report } = await promote(L, 'V1', { apply: true })
    expect(report.blockers.map((blocker) => blocker.code)).toContain('already-summary')
    expect(report.applied).toBeNull()
  })

  // ── the quiesce PROVENANCE ────────────────────────────────────────────────

  it('reports HOW the quiesce was established — measured, operator-asserted, or unknown', async () => {
    // GUARDS AGAINST: a hard-coded provenance. A report that says `measured`
    // when nothing was measured lets an operator read a promotion as proved
    // when it was only promised, and makes the standalone script's
    // `--assume-quiesced` indistinguishable from the server route's census.
    const L = 'L-provenance'
    await provision(L, 'V1')

    const measured = await promote(L, 'V1')
    expect(measured.report.witnesses.quiesce).toBe('measured')
    expect(measured.report.witnesses.connectedPeers).toBe(0)

    const asserted = await promote(L, 'V1', { connectedPeers: undefined, assumeQuiesced: true })
    expect(asserted.report.witnesses.quiesce).toBe('operator-asserted')
    expect(asserted.report.witnesses.connectedPeers).toBeNull()
    expect(asserted.report.blockers.map((blocker) => blocker.code)).not.toContain('quiesce-unproven')

    const unknown = await promote(L, 'V1', { connectedPeers: undefined })
    expect(unknown.report.witnesses.quiesce).toBe('unknown')
    expect(unknown.report.blockers.map((blocker) => blocker.code)).toContain('quiesce-unproven')
  })

  it('the DE-PROMOTION reports its quiesce provenance too', async () => {
    const L = 'L-provenance-demote'
    await provision(L, 'V1')
    expect((await promote(L, 'V1', { apply: true })).report.applied).not.toBeNull()
    const workspace = { landscapeId: L, versionId: 'V1' }

    const measured = await demoteSummaryWorkspace({ db: db.pool, repo, workspace, connectedPeers: () => 0 })
    expect(measured.witnesses.quiesce).toBe('measured')
    const asserted = await demoteSummaryWorkspace({ db: db.pool, repo, workspace, assumeQuiesced: true })
    expect(asserted.witnesses.quiesce).toBe('operator-asserted')
    expect(asserted.blockers.map((blocker) => blocker.code)).not.toContain('quiesce-unproven')
    const unknown = await demoteSummaryWorkspace({ db: db.pool, repo, workspace })
    expect(unknown.witnesses.quiesce).toBe('unknown')
    expect(unknown.blockers.map((blocker) => blocker.code)).toContain('quiesce-unproven')
  })

  it('la démotion LIT vraiment les tombstones, et son override est le sien (T6)', async () => {
    // `promoteSummaryWorkspace.test.ts` pins `evaluateDemotionPreconditions`
    // (handed `diagramTombstones` as a literal) and pins
    // `DEMOTION_OVERRIDABLE_BLOCKERS` as a SET. Neither pins the two pieces
    // that decide the outcome in production: the code that READS
    // `ModelMeta.deletedDiagramIds`, and the `overridden` predicate that
    // consults the set — e.g. never reading the list, or letting
    // `allowConnectedPeers` lift the resurrection blocker.
    //
    // The second matters most: resurrecting every deleted diagram is NOT the
    // same promise as dropping a live session's in-flight writes, so it gets
    // its own flag, and only the set's consumer can enforce that.
    const L = 'L-demote-tombstones'
    const { rootUrl } = await provision(L, 'V1')
    expect((await promote(L, 'V1', { apply: true })).report.applied).not.toBeNull()
    const workspace = { landscapeId: L, versionId: 'V1' }

    // Anti-void guard: with no tombstone the door is open, and the witness says
    // zero rather than "unknown".
    const clear = await demoteSummaryWorkspace({ db: db.pool, repo, workspace, connectedPeers: () => 0 })
    expect(clear.blockers.map((blocker) => blocker.code)).not.toContain('diagram-tombstones-outstanding')
    expect(clear.witnesses.diagramTombstones).toBe(0)

    const root = await readRoot(rootUrl)
    const meta = await findReadyDocument<Record<string, unknown>>(repo, root.modelMetaUrl!)
    meta.change((doc) => { doc.deletedDiagramIds = ['dg-a', 'dg-b', 'dg-b'] })
    await repo.flush([meta.documentId])

    const blocked = await demoteSummaryWorkspace({
      db: db.pool, repo, workspace, apply: true, connectedPeers: () => 0,
    })
    expect(blocked.blockers.map((blocker) => blocker.code)).toEqual(['diagram-tombstones-outstanding'])
    expect(blocked.witnesses.diagramTombstones).toBe(2)
    expect(blocked.blockers[0].detail).toContain('2')
    expect(blocked.applied).toBeNull()
    expect((await staticRow(L, 'V1'))?.source).toBe(PROMOTED_STATIC_SOURCE)

    // The quiesce override must NOT reach it: different promise, own flag.
    const stillBlocked = await demoteSummaryWorkspace({
      db: db.pool, repo, workspace, apply: true, connectedPeers: () => 0, allowConnectedPeers: true,
    })
    expect(stillBlocked.blockers.map((blocker) => blocker.code)).toEqual(['diagram-tombstones-outstanding'])
    expect(stillBlocked.overridden).toEqual([])
    expect(stillBlocked.applied).toBeNull()

    // Its own flag does, and says so in `overridden` rather than silently.
    const forced = await demoteSummaryWorkspace({
      db: db.pool, repo, workspace, apply: true, connectedPeers: () => 0, allowDiagramResurrection: true,
    })
    expect(forced.blockers).toEqual([])
    expect(forced.overridden.map((blocker) => blocker.code)).toEqual(['diagram-tombstones-outstanding'])
    expect(forced.applied).not.toBeNull()
  })

  it('un ModelMeta que la démotion ne peut pas résoudre bloque : non mesurable n est pas zéro (T6)', async () => {
    // The `connectedPeers` rule, applied to the tombstone witness's reading
    // half: `metaHandle ? … : null` silently becoming `: 0` would open the
    // door on a workspace whose tombstone
    // count is simply UNKNOWN, and demoting blind resurrects every diagram the
    // frozen baseline shards still carry.
    const L = 'L-demote-meta-lost'
    const { rootUrl } = await provision(L, 'V1')
    expect((await promote(L, 'V1', { apply: true })).report.applied).not.toBeNull()

    // A ModelMeta url the repo can never resolve. `network: []` in this suite
    // is what makes that a rejection rather than a hang.
    const rootHandle = await findReadyDocument<RootDoc>(repo, rootUrl)
    rootHandle.change((doc) => {
      (doc as unknown as { modelMetaUrl: string }).modelMetaUrl = 'automerge:4NMNnkyJxmHTLxcnrEc9BLDJTnLK'
    })
    await repo.flush([rootHandle.documentId])

    const blocked = await demoteSummaryWorkspace({
      db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' },
      apply: true, connectedPeers: () => 0, resolveTimeoutMs: 2_000,
    })
    expect(blocked.blockers.map((blocker) => blocker.code)).toContain('diagram-tombstones-outstanding')
    expect(blocked.witnesses.diagramTombstones).toBeNull()
    expect(blocked.applied).toBeNull()
  })

  // ── the sparse-child guard's SECOND reading ───────────────────────────────

  it('a sparse child known ONLY by read_model_static_workspaces.base_version_id blocks the demotion', async () => {
    // GUARDS AGAINST: dropping the `EXISTS (… base_version_id …)` branch of
    // `readActiveSparseChildren`. Both readings exist because each can be
    // wrong on its own — a draft whose manifest was
    // rewritten, a static row posed by a repair — and only the second sees this
    // child. Missing it deletes the baseline underneath a live draft: every
    // untouched entity in it resolves to nothing and its merge diffs against a
    // void.
    const L = 'L-demote-base-child'
    await provision(L, 'V1')
    expect((await promote(L, 'V1', { apply: true })).report.applied).not.toBeNull()

    await db.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url, parent_version_id, kind, status, base_manifest)
       VALUES ($1, 'D-base', 'automerge:childroot', 'V1', 'draft', 'active', $2::jsonb)`,
      // NOT 'sparse-static' — the manifest reading is blind to this child.
      [L, JSON.stringify({ mode: 'full' })],
    )
    await db.pool.query(
      `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source, base_version_id)
       VALUES ($1, 'D-base', 'sparse-draft', 'V1')`,
      [L],
    )

    const blocked = await demoteSummaryWorkspace({
      db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' }, apply: true, connectedPeers: () => 0,
    })
    expect(blocked.blockers.map((blocker) => blocker.code)).toEqual(['sparse-child-active'])
    expect(blocked.blockers[0].detail).toContain('D-base')
    expect(blocked.witnesses.activeSparseChildren).toEqual(['D-base'])
    expect(blocked.applied).toBeNull()
    expect((await staticRow(L, 'V1'))?.source).toBe(PROMOTED_STATIC_SOURCE)
  })

  // ── the LIFECYCLE apply lock: the three doors, mutually excluded ──────────
  //
  // The window these close is not narrow. The promotion commits the static row
  // at step 3 and only flips the root at step 6, after the fence wait, and
  // `evaluateDemotionPreconditions` ADMITS a demotion in between:
  // `not-summary` needs a NULL source and the source is set, `not-promoted`
  // needs a DIFFERENT source and it is exactly the promoted one. Every test
  // below drives the real promotion and injects at `static-committed`, which is
  // the first instant of that window.

  it('a demotion inside the promotion is REFUSED, and the workspace stays coherent', async () => {
    const L = 'L-lock-demote'
    const { rootUrl } = await provision(L, 'V1')
    let inWindow: SummaryDemotionReport | null = null
    const { report } = await promote(L, 'V1', {
      apply: true,
      hooks: {
        onStep: async (step) => {
          if (step !== 'static-committed') return
          // The promotion has committed the static row and has NOT yet flipped
          // the root. Without the lock this demotion would be admitted and applied.
          inWindow = await demoteSummaryWorkspace({
            db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' },
            apply: true, connectedPeers: () => 0,
          })
        },
      },
    })

    expect(report.applied).not.toBeNull()
    expect(inWindow).not.toBeNull()
    expect(inWindow!.blockers.map((blocker) => blocker.code)).toEqual(['lifecycle-in-flight'])
    expect(inWindow!.applied).toBeNull()

    // The end state is what makes this a data-loss test rather than a blocker
    // test. Without the lock the demotion deletes the static row and the
    // promotion flips the root anyway, leaving a summary-only root with NO static row —
    // `summary-static-coherence` at `data-loss`. Both halves are asserted
    // because either alone can be satisfied by the wrong thing: a refusal with
    // a broken workspace, or a coherent workspace because nothing ran.
    expect((await readRoot(rootUrl)).registrySummaryOnly).toBe(true)
    expect((await staticRow(L, 'V1'))?.source).toBe(PROMOTED_STATIC_SOURCE)
    expect((await allowListRows(L, 'V1')).length).toBeGreaterThan(0)
  })

  it('a reference-integrity APPLY inside the promotion is REFUSED — the FOURTH door (T-34)', async () => {
    // The three summary doors live in `promoteSummaryWorkspace.ts`. This one
    // lives in `referenceIntegrityRepair.ts`, is reached from
    // `POST /api/platform/reference-integrity/repair`, and deletes registry
    // entries, strips ids from every diagram and drops layout keys, all
    // bypassing the RBAC write gate — so it takes the same lifecycle lock.
    //
    // WHAT THIS ARM PROVES: the two doors share one key against a REAL
    // promotion (`referenceIntegrityRepair.test.ts` simulates the neighbour
    // with a hand-held key, which cannot show that the key texts agree across
    // modules). The data loss an unlocked apply causes is shown by the
    // blast-radius arm below.
    //
    // THE CONTROL IS INSIDE THE WINDOW, at the same instant as the arm: a dry
    // run reporting a `safeToApply` plan. Without it the rejection is
    // satisfiable by "nothing to repair" — that path returns `applied: 0` from
    // an early return that never asks for the lock — and this test would be
    // green against a tree with no lock in it at all.
    const L = 'L-lock-refintegrity'
    const { rootUrl } = await provision(L, 'V1')
    // One dangling composition reference, so the repair has something to apply.
    await db.pool.query(
      `INSERT INTO ro_diagram_objects (landscape_id, version_id, diagram_id, object_id)
       SELECT $1, $2, id, 'obj-ghost' FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2`,
      [L, 'V1'],
    )

    let actionableInWindow = -1
    let refusal: unknown = null
    const { report } = await promote(L, 'V1', {
      apply: true,
      hooks: {
        onStep: async (step) => {
          if (step !== 'static-committed') return
          // CONTROL — and the dry run's own property: it is NOT gated, because
          // it is the report an operator reads when a promotion looks stuck.
          const dry = await repairReferenceIntegrity(db.pool, repo, {
            landscapeId: L, versionId: 'V1',
          })
          actionableInWindow = dry.plans.filter((plan) => plan.safeToApply).length
          refusal = await repairReferenceIntegrity(db.pool, repo, {
            landscapeId: L, versionId: 'V1', apply: true,
          }).then(() => null, (error: unknown) => error)
        },
      },
    })

    expect(report.applied).not.toBeNull()
    expect(actionableInWindow).toBeGreaterThan(0)
    expect((refusal as Error | null)?.message).toMatch(/holds the apply lock/)
    expect((refusal as { code?: string } | null)?.code).toBe('lock-unavailable')
    // The neighbour was not disturbed by the door it refused.
    expect((await readRoot(rootUrl)).registrySummaryOnly).toBe(true)
    expect((await staticRow(L, 'V1'))?.source).toBe(PROMOTED_STATIC_SOURCE)
    expect((await allowListRows(L, 'V1')).length).toBeGreaterThan(0)
  })

  it('the BLAST RADIUS, measured: an unlocked apply deletes a LIVE object from the CRDT (T-34)', async () => {
    // The arm above proves the two doors share one key; this one shows what
    // the refusal is WORTH. (There, the only actionable finding is a
    // `strip-composition` on an id no DiagramDoc lists, so an unlocked apply
    // would write nothing visible.)
    //
    // THE MECHANISM. A `diagram.objectIds` finding
    // is scanned from `ro_diagram_objects` minus `ro_objects` — READ MODEL on
    // both sides, no document consulted anywhere — and `planReferenceRepair`
    // answers `safeToApply: true` from the KIND ALONE. The write then lands on
    // the DiagramDoc. So ANY state in which the read model lacks a row the
    // documents carry is a state in which this repair deletes live user data
    // from every diagram that shows it. `readModel/staticDeltaProjector.ts`
    // documents exactly such a state (a row leaving `ro_objects` while the
    // CRDT stays correct).
    //
    // WHY A PROMOTION IS WHEN IT HAPPENS: the promotion commits the static row
    // at step 3 and DETACHES the ordinary projector at step 4, handing the
    // `ro_*` plane to a different writer. The plane changes owner inside the
    // window this arm opens.
    //
    // WHAT IS INJECTED, said plainly rather than implied. This fixture runs no
    // projector, so the DELETE below stands in for the incoming projector's
    // own write; that one line is simulation. Everything the claim rests on is
    // not: a REAL promotion holding a REAL key, the scan's own verdict on the
    // resulting plane, the planner's own `safeToApply`, the refusal, and the
    // damage — which is `stripIdsFromAllDiagrams` running for real against
    // real Automerge storage.
    const L = 'L-lock-blastradius'
    const { diagramId, diagramDocUrl, registryUrl } = await provision(L, 'V1')
    const OBJ = 'obj-live'

    // A LIVE object: in the DiagramDoc's composition, in its layout, and in the
    // registry stub. The stub is load-bearing for the damage, not decoration —
    // `stripIdsFromAllDiagrams` opens a DiagramDoc only when the STUB mentions
    // the id, so a fixture that seeds the document alone measures nothing.
    type DiagramShape = { objectIds: string[]; layouts: Record<string, unknown> }
    type RegistryShape = { diagrams: Record<string, { objectIds: string[] }> }
    const diagramHandle = await findReadyDocument<DiagramShape>(repo, diagramDocUrl)
    diagramHandle.change((d) => { d.objectIds.push(OBJ); d.layouts[OBJ] = { x: 10, y: 20 } })
    const registryHandle = await findReadyDocument<RegistryShape>(repo, registryUrl)
    registryHandle.change((s) => { s.diagrams[diagramId]!.objectIds.push(OBJ) })
    await repo.flush()

    // The read model AGREES with the documents, so there is nothing to repair.
    await db.pool.query(
      `INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES ($1, $2, $3, '{}'::jsonb)`,
      [L, 'V1', OBJ],
    )
    await db.pool.query(
      `INSERT INTO ro_diagram_objects (landscape_id, version_id, diagram_id, object_id) VALUES ($1, $2, $3, $4)`,
      [L, 'V1', diagramId, OBJ],
    )
    // RE-SEAL. `provision` stamps the object content seal as
    // `digestOfIds([])`, and a workspace whose `ro_objects` disagrees with its
    // seal is refused at `read-model-not-sealed`. Re-stamping is what a real
    // projector would have left behind; without it the promotion never reaches
    // `static-committed`, the window never opens, and the arm tests nothing.
    await db.pool.query(
      `UPDATE read_model_projection_state
          SET content_digest = jsonb_set(content_digest, '{object}', $3::jsonb)
        WHERE landscape_id = $1 AND version_id = $2`,
      [L, 'V1', JSON.stringify({ ...digestOfIds([OBJ]), g: 1 })],
    )

    const composition = async () => {
      const doc = (await findReadyDocument<DiagramShape>(repo, diagramDocUrl)).doc()!
      return { objectIds: [...doc.objectIds], layoutKeys: Object.keys(doc.layouts) }
    }
    const stubIds = async () => {
      const shard = (await findReadyDocument<RegistryShape>(repo, registryUrl)).doc()!
      return [...shard.diagrams[diagramId]!.objectIds]
    }

    // CONTROL 1 — the finding DOES NOT PRE-EXIST. Without it this arm is
    // satisfiable by a fixture that was already broken, and would then be
    // measuring damage from a bad scan rather than damage from the
    // interleaving, which is a different claim and a weaker one.
    const before = await repairReferenceIntegrity(db.pool, repo, { landscapeId: L, versionId: 'V1' })
    expect(before.plans.filter((plan) => plan.safeToApply)).toEqual([])
    expect(await composition()).toEqual({ objectIds: [OBJ], layoutKeys: [OBJ] })

    let planned: ReferenceRepairPlan[] = []
    let refusal: unknown = null
    const { report } = await promote(L, 'V1', {
      apply: true,
      hooks: {
        onStep: async (step) => {
          if (step !== 'static-committed') return
          // The incoming projector's write — the one simulated line, see above.
          await db.pool.query(
            `DELETE FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
            [L, 'V1', OBJ],
          )
          // CONTROL 2 — taken INSIDE the window, at the same instant as the
          // arm: the apply below really did have something destructive to do.
          // An empty `actionable` returns `applied: 0` from an early return
          // that never asks for the lock, which is indistinguishable from a
          // refusal in every other assertion here.
          const dry = await repairReferenceIntegrity(db.pool, repo, { landscapeId: L, versionId: 'V1' })
          planned = dry.plans.filter((plan) => plan.safeToApply)
          refusal = await repairReferenceIntegrity(db.pool, repo, {
            landscapeId: L, versionId: 'V1', apply: true,
          }).then(() => null, (error: unknown) => error)
        },
      },
    })

    expect(report.applied).not.toBeNull()
    expect(planned).toHaveLength(1)
    expect(planned[0]).toMatchObject({
      action: 'strip-composition',
      finding: { kind: 'diagram.objectIds', sourceId: diagramId, targetId: OBJ },
    })
    // THE BLAST RADIUS, ASSERTED FIRST: with the refusal check ahead of it, a
    // missing lock would fail on `code === 'lock-unavailable'` and never
    // evaluate the damage. Without the lock the apply empties
    // DiagramDoc.objectIds, DiagramDoc.layouts and the registry stub's
    // objectIds — a shape the user placed, its position and its registry
    // entry, gone from the CRDT while the object was live in every document.
    expect(await composition()).toEqual({ objectIds: [OBJ], layoutKeys: [OBJ] })
    expect(await stubIds()).toEqual([OBJ])
    // And the MECHANISM that prevented it, after the effect it prevented. Both
    // halves are asserted because either alone is satisfiable by the wrong
    // thing: a refusal over a fixture with nothing to lose, or an intact
    // document because the repair never ran at all.
    expect((refusal as { code?: string } | null)?.code).toBe('lock-unavailable')
  })

  it('a flag repair inside the promotion is REFUSED — its precondition IS a healthy promotion', async () => {
    // This door exists to finish a promotion that CRASHED between its commit
    // and its root flip. A promotion that is merely still running occupies the
    // identical state, and unlocked this door cannot tell them apart.
    const L = 'L-lock-repair'
    const { rootUrl } = await provision(L, 'V1')
    let inWindow: SummaryFlagRepairReport | null = null
    const { report } = await promote(L, 'V1', {
      apply: true,
      hooks: {
        onStep: async (step) => {
          if (step !== 'static-committed') return
          inWindow = await repairSummaryFlag({
            db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' }, apply: true,
          })
        },
      },
    })

    expect(report.applied).not.toBeNull()
    expect(inWindow!.blockers.map((blocker) => blocker.code)).toEqual(['lifecycle-in-flight'])
    expect(inWindow!.applied).toBeNull()
    expect((await readRoot(rootUrl)).registrySummaryOnly).toBe(true)
  })

  it('every door RELEASES the lock — asked of pg_locks, with a control that sees it held', async () => {
    // Asserting the SYMPTOM ("a demotion right after a promotion is not
    // refused") cannot catch a leaked unlock: a leaked SESSION lock rides the
    // pooled connection back into the pool, and `pg_try_advisory_lock` on a
    // key your own session already holds SUCCEEDS (it is a counting lock). So
    // the next door, handed that same connection, is admitted and the leak
    // stays invisible. Every door's release must also be exercised, not only
    // the promotion's.
    //
    // `pg_locks` answers the property itself. The CONTROL is the half that
    // makes the zero mean something: taken from inside the promotion's own
    // window, the same query must report exactly one held key, or it is not
    // capable of reporting any.
    const L = 'L-lock-release'
    await provision(L, 'V1')
    expect(await heldLifecycleKeys()).toBe(0)

    let heldDuringPromotion = -1
    const { report } = await promote(L, 'V1', {
      apply: true,
      hooks: {
        onStep: async (step) => {
          if (step === 'static-committed') heldDuringPromotion = await heldLifecycleKeys()
        },
      },
    })
    expect(report.applied).not.toBeNull()
    // CONTROL: the instrument can see a held key.
    expect(heldDuringPromotion).toBe(1)
    expect(await heldLifecycleKeys()).toBe(0)

    const after = await demoteSummaryWorkspace({
      db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' },
      apply: true, connectedPeers: () => 0,
    })
    expect(after.blockers).toEqual([])
    expect(after.applied).not.toBeNull()
    expect(await staticRow(L, 'V1')).toBeNull()
    // The demotion's release, checked directly.
    expect(await heldLifecycleKeys()).toBe(0)
  })

  it('a REFUSED door releases the lock too — the refusal paths are not exempt', async () => {
    // A `return` from inside the try is the easiest way to leak a lock that a
    // happy-path test never notices, and the doors have several such returns.
    const L = 'L-lock-refuse-release'
    await provision(L, 'V1')
    await promote(L, 'V1', { apply: true })

    const moved = await demoteSummaryWorkspace({
      db: db.pool,
      repo,
      workspace: { landscapeId: L, versionId: 'V1' },
      apply: true,
      connectedPeers: async () => {
        await db.pool.query(
          `DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = 'V1'`,
          [L],
        )
        return 0
      },
    })
    expect(moved.blockers.map((blocker) => blocker.code)).toEqual(['witness-moved'])
    expect(await heldLifecycleKeys()).toBe(0)
  })

  it('a demotion whose static row vanishes between the verdict and the lock is REFUSED', async () => {
    // The lock does not reach backwards. The demotion's facts are gathered up
    // to two document resolves before it asks for the door, so a promotion
    // (or another demotion) that COMMITTED and RELEASED in that window leaves a
    // verdict computed against a workspace that no longer exists.
    //
    // `connectedPeers` is awaited during fact-gathering, AFTER the static
    // source is read and BEFORE the lock — so it is the one seam that can move
    // a witness at exactly the right instant without a second process.
    const L = 'L-lock-witness'
    const { rootUrl } = await provision(L, 'V1')
    await promote(L, 'V1', { apply: true })

    const moved = await demoteSummaryWorkspace({
      db: db.pool,
      repo,
      workspace: { landscapeId: L, versionId: 'V1' },
      apply: true,
      connectedPeers: async () => {
        await db.pool.query(
          `DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = 'V1'`,
          [L],
        )
        return 0
      },
    })

    expect(moved.blockers.map((blocker) => blocker.code)).toEqual(['witness-moved'])
    expect(moved.blockers[0].detail).toContain('changed from')
    expect(moved.applied).toBeNull()
    // And it refused BEFORE the root revert — the first irreversible act. A
    // guard that fires after it would leave the hybrid this door exists to
    // avoid creating.
    expect((await readRoot(rootUrl)).registrySummaryOnly).toBe(true)
  })

  it('the promotion takes the write fence in the SAME transaction as the static row', async () => {
    // The fence is what stops an ordinary cold build ALREADY RUNNING from
    // committing its blanket rebuild over the plane the promotion just handed
    // to the static projector. Nothing else can: that build's own
    // `assertReadModelPlane` ran before this row existed, and it cannot be
    // re-checked at the end either, because ordinary authority is the ABSENCE
    // of a row and absence is not lockable.
    //
    // SAME TRANSACTION is the invariant, not an implementation detail. Split
    // across two commits, the gap between them is a resurrection window: a
    // projector attaching inside it reads the sentinel as its own
    // `expectedPrevious`, and its CAS then succeeds. Asserted at the
    // `static-committed` hook, which is the first instant after that one
    // COMMIT — if the fence were taken in a later transaction it would still
    // be the projector's value here.
    const L = 'L-promote-fence'
    await provision(L, 'V1')

    const fenceAtCommit: (string | null)[] = []
    const { report } = await promote(L, 'V1', {
      apply: true,
      hooks: {
        onStep: async (step) => {
          if (step !== 'static-committed') return
          const { rows } = await db.pool.query<{ write_fence: string | null }>(
            `SELECT write_fence FROM read_model_projection_state
              WHERE landscape_id = $1 AND version_id = 'V1'`,
            [L],
          )
          fenceAtCommit.push(rows[0]?.write_fence ?? null)
        },
      },
    })

    expect(report.applied).not.toBeNull()
    expect(fenceAtCommit).toHaveLength(1)
    expect(fenceAtCommit[0]).toMatch(/^lifecycle:promote:/)
    // And the static row is visible at that same instant — the two halves of
    // the one transaction.
    expect((await staticRow(L, 'V1'))?.source).toBe(PROMOTED_STATIC_SOURCE)
  })

  it('the demotion takes the WORKSPACE row and lets the FK reach the documents — and the witness moves', async () => {
    // `assertReadModelPlane` holds `read_model_static_workspaces` in key share
    // for the whole of every static publish, and that publish also writes
    // `read_model_static_documents`. Deleting the documents first would leave
    // the demotion holding them and waiting for the workspace row while the
    // publish holds the workspace row and wants the documents — ABBA, on one
    // workspace, no fan-out needed.
    //
    // `read_model_static_documents_workspace_fk` cascades the workspace
    // delete to the documents, so what is pinned is:
    //
    //  - the workspace delete comes BEFORE any standalone
    //    `DELETE FROM read_model_static_documents` (the reverse reopens the ABBA);
    //  - the WITNESS must move. `staticRowsDeleted` is the only number the
    //    operator-facing door reports about the allow-list, and reading it from
    //    a DELETE after the cascade would make it 0 on every successful
    //    demotion. Checked against a count taken independently, by SQL, before
    //    the run, plus a non-vacuity assertion, because `toBe(before)` passes
    //    when `before` is itself 0.
    const L = 'L-demote-order'
    await provision(L, 'V1')
    await promote(L, 'V1', { apply: true })

    const statements: string[] = []
    const recordingPool = new Proxy(db.pool, {
      get(target, prop, receiver) {
        if (prop !== 'connect') {
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async () => {
          const client = await target.connect()
          return new Proxy(client, {
            get(clientTarget, clientProp, clientReceiver) {
              if (clientProp !== 'query') {
                const value = Reflect.get(clientTarget, clientProp, clientReceiver)
                return typeof value === 'function' ? value.bind(clientTarget) : value
              }
              return async (text: string, params?: unknown[]) => {
                if (typeof text === 'string') statements.push(text.trim().split('\n')[0].trim())
                return clientTarget.query(text, params)
              }
            },
          })
        }
      },
    })

    // Counted BEFORE the run, by a statement the demotion does not issue.
    const { rows: [{ rows: allowListed }] } = await db.pool.query<{ rows: number }>(
      `SELECT count(*)::int AS rows FROM read_model_static_documents
       WHERE landscape_id = $1 AND version_id = 'V1'`, [L])

    const done = await demoteSummaryWorkspace({
      db: recordingPool, repo, workspace: { landscapeId: L, versionId: 'V1' },
      apply: true, connectedPeers: () => 0,
    })
    expect(done.applied).not.toBeNull()

    // A promotion that allow-listed nothing would make every assertion below
    // agree with a demotion that deleted nothing.
    expect(allowListed).toBeGreaterThan(0)
    expect(done.applied?.staticRowsDeleted).toBe(allowListed)

    // ORDER, not absence: the standalone documents DELETE is the only
    // automatic reaper of an orphaned allow-list, and the ABBA is only
    // D-BEFORE-S. Issued after the workspace delete it takes the locks in the
    // documented global order.
    //
    // The recorder keeps each statement's FIRST LINE only, so the CTE is
    // identified by its opening and not by the table it names three lines down.
    const workspaceDelete = statements.findIndex((sql) => sql.startsWith('WITH counted AS ('))
    const documentsDelete = statements.findIndex((sql) =>
      sql.startsWith('DELETE FROM read_model_static_documents'))
    expect(workspaceDelete).toBeGreaterThanOrEqual(0)
    expect(documentsDelete).toBeGreaterThanOrEqual(0)
    expect(workspaceDelete).toBeLessThan(documentsDelete)
    // …and the rows really are gone. `staticRowsDeleted` counting them is not
    // by itself evidence that anything was removed.
    const { rows: [{ rows: left }] } = await db.pool.query<{ rows: number }>(
      `SELECT count(*)::int AS rows FROM read_model_static_documents
       WHERE landscape_id = $1 AND version_id = 'V1'`, [L])
    expect(left).toBe(0)
    // And a ceiling, so this transaction reports rather than parking behind an
    // `overlay-rotation` holder while it still holds the lifecycle apply lock.
    //
    // Asserted as a LITERAL: a substring check for `lock_timeout` would also
    // accept `SET LOCAL lock_timeout = 0`, which in Postgres means NO TIMEOUT
    // AT ALL, and a bound checked against the constant under test agrees with
    // every value that constant is given.
    expect(statements).toContain("SET LOCAL lock_timeout = '5000ms'")
  })

  it('the half-state is REPAIRED, and the witness counts what the cascade could not reach', async () => {
    // Two properties in one fixture, and they fail in opposite directions.
    //
    // `not-summary` admits a demotion when the root is `registrySummaryOnly`
    // and the source is ALREADY null — the hybrid half-state this module
    // documents and `summary-static-coherence` reports as `data-loss`. There is
    // no workspace row, so nothing cascades. If the door does not sweep the
    // allow-list explicitly it stops being a repair: this is the ONLY automatic
    // reaper of an orphaned allow-list in the tree.
    //
    // And the witness must count the swept rows WITHOUT counting the cascaded
    // ones twice — a naive `deleted = document_rows` on this path would report
    // deletions that the cascade never made.
    const L = 'L-demote-halfstate'
    await provision(L, 'V1')
    await promote(L, 'V1', { apply: true })

    // Deleting the authority row now cascades the allow-list away, so the rows
    // have to be put back the way the legacy ones exist — see
    // `asLegacyStaticOrphan`.
    await db.pool.query(
      `DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = 'V1'`, [L])
    await asLegacyStaticOrphan(db.pool, () => db.pool.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
       VALUES ($1, 'V1', 'halfstate-a', 'registry-shard'), ($1, 'V1', 'halfstate-b', 'diagram')`,
      [L]))

    const done = await demoteSummaryWorkspace({
      db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' },
      apply: true, connectedPeers: () => 0,
    })
    // Non-vacuity, and it is the assertion that makes the 0 mean anything: a
    // door that REFUSED would report `applied: null`, and `?.staticRowsDeleted`
    // on null is undefined, not 0 — but a future `?? 0` anywhere on that path
    // would make the refusal indistinguishable from the case under test.
    expect(done.blockers.map((blocker) => blocker.code)).toEqual([])
    expect(done.applied).not.toBeNull()
    // TWO, not four: the two rows really removed, counted once. Double-counting
    // is the failure mode on this path — `document_rows` also reports 2 here,
    // from the count taken before the sweep, and adding both would report 4
    // deletions from a table that held 2 rows.
    expect(done.applied?.staticRowsDeleted).toBe(2)

    // …and they are GONE, which is the fact the 2 is about. The witness
    // counting them is not by itself evidence that anything was removed.
    const { rows: [{ rows: left }] } = await db.pool.query<{ rows: number }>(
      `SELECT count(*)::int AS rows FROM read_model_static_documents
       WHERE landscape_id = $1 AND version_id = 'V1'`, [L])
    expect(left).toBe(0)
  })

  it('a sparse child born between the verdict and the lock REFUSES the demotion', async () => {
    // The witness the apply lock structurally CANNOT cover. `createDraft`
    // publishes a sparse child taking no lifecycle lock — and even if it did,
    // `lifecycleLockKey` is keyed on (landscapeId, versionId) and the draft's
    // key is the CHILD's, so it could never exclude a door on the parent.
    // Deleting the parent's static rows underneath a sparse draft leaves every
    // untouched entity in that draft resolving to nothing.
    //
    // `connectedPeers` is awaited AFTER `readActiveSparseChildren` and BEFORE
    // the lock, so it is the seam that reproduces the birth at the right
    // instant. The verdict sees no children; the re-read sees one.
    const L = 'L-lock-sparse-born'
    const { rootUrl } = await provision(L, 'V1')
    await promote(L, 'V1', { apply: true })

    const born = await demoteSummaryWorkspace({
      db: db.pool,
      repo,
      workspace: { landscapeId: L, versionId: 'V1' },
      apply: true,
      connectedPeers: async () => {
        await db.pool.query(
          `INSERT INTO versions (landscape_id, id, root_url, parent_version_id, kind, status, base_manifest)
           VALUES ($1, 'D-born', 'automerge:childroot', 'V1', 'draft', 'active', $2::jsonb)`,
          [L, JSON.stringify({ mode: 'sparse-static' })],
        )
        return 0
      },
    })

    expect(born.blockers.map((blocker) => blocker.code)).toEqual(['witness-moved'])
    expect(born.blockers[0].detail).toContain('D-born')
    expect(born.applied).toBeNull()
    // Refused before the root revert, and the child's baseline is intact.
    expect((await readRoot(rootUrl)).registrySummaryOnly).toBe(true)
    expect((await staticRow(L, 'V1'))?.source).toBe(PROMOTED_STATIC_SOURCE)
    expect((await allowListRows(L, 'V1')).length).toBeGreaterThan(0)
  })

  it("the promotion's step-3 transaction destroys its client when the ROLLBACK fails", async () => {
    // By the time this transaction can throw it holds FOUR row-lock sets:
    // `automerge_document_workspace`, `read_model_static_workspaces`,
    // `read_model_static_documents` and `read_model_projection_state` (the
    // write fence), which every projection takes FOR UPDATE. A client returned
    // to the pool still inside its transaction hands all four to the next
    // borrower — a silent wedge.
    //
    // Both halves asserted: the ORIGINAL error propagates (a failed rollback
    // must not replace the one that explains the failure), and the client is
    // released with something truthy so the pool destroys it.
    const L = 'L-promote-rollback'
    await provision(L, 'V1')

    const releases: unknown[][] = []
    let sawCommit = false
    const brokenPool = new Proxy(db.pool, {
      get(target, prop, receiver) {
        if (prop !== 'connect') {
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async () => {
          const client = await target.connect()
          return new Proxy(client, {
            get(clientTarget, clientProp, clientReceiver) {
              if (clientProp === 'release') {
                return (...args: unknown[]) => {
                  releases.push(args)
                  return (clientTarget.release as (...a: unknown[]) => void).apply(clientTarget, args)
                }
              }
              if (clientProp !== 'query') {
                const value = Reflect.get(clientTarget, clientProp, clientReceiver)
                return typeof value === 'function' ? value.bind(clientTarget) : value
              }
              return async (text: string, params?: unknown[]) => {
                if (typeof text === 'string' && text.startsWith('COMMIT')) {
                  sawCommit = true
                  throw new Error('the publication failed')
                }
                if (typeof text === 'string' && text.startsWith('ROLLBACK')) {
                  throw new Error('connection terminated during rollback')
                }
                return clientTarget.query(text, params)
              }
            },
          })
        }
      },
    })

    await expect(promoteSummaryWorkspace({
      db: brokenPool,
      repo,
      residency: null,
      storage,
      workspace: { landscapeId: L, versionId: 'V1' },
      apply: true,
      connectedPeers: () => 0,
      expectedProjectorInstanceId: 'run-under-test',
      clock: () => 1_700_000_000_000,
      sleep: async () => undefined,
    })).rejects.toThrow('the publication failed')

    expect(sawCommit).toBe(true)
    // The lock client is released bare (its unlock succeeded); the transaction
    // client must be released WITH the failure. So at least one release carries
    // a truthy argument, and that is the discriminating one.
    expect(releases.some((args) => Boolean(args[0]))).toBe(true)
  }, 30_000)

  it('a static publish holding the workspace turns the demotion into a BLOCKER, not a 500', async () => {
    // The one path on this door that reports AFTER a durable act. As a throw,
    // `55P03` would escape to the route's generic handler: a bare 500, no
    // report, and no audit row (`appendAudit` is gated on `report.applied`) —
    // while the root has already been reverted AND flushed, which is exactly
    // what an operator needs to know.
    //
    // Driven by holding the row exactly the way a real publish does — through
    // `assertReadModelPlane`, not a hand-written lock — so the test exercises
    // the mechanism rather than a lookalike.
    const L = 'L-demote-publish'
    const { rootUrl } = await provision(L, 'V1')
    await promote(L, 'V1', { apply: true })

    const publish = await db.pool.connect()
    let report: SummaryDemotionReport
    try {
      await publish.query('BEGIN')
      await assertReadModelPlane(publish, { landscapeId: L, versionId: 'V1' }, 'static')

      report = await demoteSummaryWorkspace({
        db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' },
        apply: true, connectedPeers: () => 0,
      })
    } finally {
      await publish.query('ROLLBACK').catch(() => undefined)
      publish.release()
    }

    expect(report.blockers.map((blocker) => blocker.code)).toEqual(['publish-in-flight'])
    expect(report.applied).toBeNull()
    // The detail must SAY the root moved — that is the whole point of reporting
    // rather than throwing.
    expect(report.blockers[0].detail).toMatch(/root HAS already been reverted/)
    // And the state really is the hybrid one: root ordinary, static rows intact.
    expect((await readRoot(rootUrl)).registrySummaryOnly).toBeUndefined()
    expect((await staticRow(L, 'V1'))?.source).toBe(PROMOTED_STATIC_SOURCE)

    // A re-run is admitted and finishes the job — the claim the detail makes.
    const again = await demoteSummaryWorkspace({
      db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' },
      apply: true, connectedPeers: () => 0,
    })
    expect(again.blockers).toEqual([])
    expect(again.applied).not.toBeNull()
    expect(await staticRow(L, 'V1')).toBeNull()
  }, 30_000)

  it('a FAILED unlock still returns the key — the connection is destroyed, not pooled', async () => {
    // A plain `client.release()` does NOT drop the session or its lock:
    // pg-pool removes the client only when the release argument is truthy. A
    // failed unlock followed by a bare release would return a LOCK-HOLDING
    // connection to the pool — and because an advisory lock is COUNTED per
    // session, the next door served by that connection would be admitted
    // while every door on another connection was refused.
    //
    // Driven by making the unlock statement itself fail. The witness is
    // `pg_locks` from an independent connection, not a downstream symptom: a
    // re-entrant success is exactly what the symptom cannot see.
    const L = 'L-lock-unlock-fails'
    await provision(L, 'V1')
    await promote(L, 'V1', { apply: true })
    expect(await heldLifecycleKeys()).toBe(0)

    let unlockAttempts = 0
    const brokenUnlockPool = new Proxy(db.pool, {
      get(target, prop, receiver) {
        if (prop !== 'connect') {
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async () => {
          const client = await target.connect()
          return new Proxy(client, {
            get(clientTarget, clientProp, clientReceiver) {
              if (clientProp !== 'query') {
                const value = Reflect.get(clientTarget, clientProp, clientReceiver)
                return typeof value === 'function' ? value.bind(clientTarget) : value
              }
              return async (text: string, params?: unknown[]) => {
                if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                  unlockAttempts += 1
                  throw new Error('connection terminated during unlock')
                }
                return clientTarget.query(text, params)
              }
            },
          })
        }
      },
    })

    const done = await demoteSummaryWorkspace({
      db: brokenUnlockPool, repo, workspace: { landscapeId: L, versionId: 'V1' },
      apply: true, connectedPeers: () => 0,
    })
    expect(done.blockers).toEqual([])
    expect(done.applied).not.toBeNull()
    expect(unlockAttempts).toBe(1)
    // The whole point: the key is back even though the unlock never ran.
    expect(await heldLifecycleKeys()).toBe(0)

    // AND THE RUN SAYS SO. The exit witness lives in
    // `releaseLifecycleApplyLock`, so every door reports it, whether or not it
    // uses `withLifecycleApplyLock`.
    //
    // This run APPLIED and returned no blockers, so `exclusionProven` is the
    // only field that distinguishes it from a clean one — which is precisely
    // the case the operator has to be told about, because the writes happened
    // and the exclusion could not be proven over them.
    expect(done.exclusionProven).toBe(false)

    // CONTROL: the same door, unbroken, reports it PROVEN. Without this, the
    // false above is satisfied by a field wired to a constant.
    const L2 = 'L-lock-unlock-works'
    await provision(L2, 'V1')
    const promoted = await promote(L2, 'V1', { apply: true })
    expect(promoted.report.applied).not.toBeNull()
    expect(promoted.report.exclusionProven).toBe(true)

    // And a run that never reached the door leaves it ABSENT rather than false:
    // "no critical section" and "the critical section was not excluded" are
    // different facts and must not share a value.
    const reportOnly = await promote(L2, 'V1', { apply: false })
    expect(reportOnly.report.exclusionProven).toBeUndefined()
  })

  // `planReadDelayMs` delays one of the plan's four PARALLEL reads (each runs on
  // its own pooled connection, so Postgres may execute them in any order). The
  // 300 ms run pins the order that made this test fail intermittently under
  // ci:local load (2026-10-21): the allow-list read landing after the move.
  it.each([0, 300])('a flag repair whose static row vanishes between the plan and the lock is REFUSED (plan read delayed %i ms)', async (planReadDelayMs) => {
    // The third door has no callback between its fact-gathering and its lock —
    // no `connectedPeers`, and `onStep` fires only after the flip — so the seam
    // has to be the POOL it is handed. The plan gathers its facts with FOUR
    // PARALLEL reads; the proxy answers all four truthfully and moves the row
    // only once the last of them has been read, which is exactly the instant a
    // promotion committing-and-releasing between the plan and the lock would
    // move it. Moving it after the FIRST read (the old trigger) let a slower
    // plan read see the move and refuse early, for the wrong reason, under load.
    // Nothing in production changes shape for this.
    const L = `L-lock-repair-witness-${planReadDelayMs}`
    const { rootUrl } = await provision(L, 'V1')
    await promote(L, 'V1', { apply: true })
    await stripSummaryFlag(rootUrl)

    const PLAN_READS = [
      'SELECT source FROM read_model_static_workspaces',
      'SELECT document_id, kind FROM read_model_static_documents',
      'SELECT document_id FROM automerge_document_workspace',
      'SELECT count(*)::text AS n FROM ro_diagrams',
    ]
    const planReadsDone = new Set<string>()
    let moved = false
    const movingPool = new Proxy(db.pool, {
      get(target, prop, receiver) {
        if (prop !== 'query') {
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async (text: string, params?: unknown[]) => {
          if (planReadDelayMs && typeof text === 'string'
            && text.includes('SELECT document_id, kind FROM read_model_static_documents')) {
            await new Promise((resolve) => setTimeout(resolve, planReadDelayMs))
          }
          const result = await target.query(text, params)
          const planRead = typeof text === 'string' ? PLAN_READS.find((sql) => text.includes(sql)) : undefined
          if (planRead) planReadsDone.add(planRead)
          if (!moved && planRead && planReadsDone.size === PLAN_READS.length) {
            moved = true
            await target.query(
              `DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = 'V1'`,
              [L],
            )
          }
          return result
        }
      },
    })

    const report = await repairSummaryFlag({
      db: movingPool, repo, workspace: { landscapeId: L, versionId: 'V1' }, apply: true,
    })
    expect(moved).toBe(true)
    expect(report.blockers.map((blocker) => blocker.code)).toEqual(['witness-moved'])
    expect(report.applied).toBeNull()
    // Refused BEFORE the root flip, which is this door's first irreversible act.
    expect((await readRoot(rootUrl)).registrySummaryOnly).toBeUndefined()
  })

  // ── the THIRD door: repairSummaryFlag ─────────────────────────────────────

  /** Strip the summary contract from a root, leaving the static rows: the
   * HYBRID state, built the way the summary-migration fixtures are (by hand) and the
   * way a crash between the commit and the root flip leaves it. */
  async function stripSummaryFlag(rootUrl: string): Promise<void> {
    const handle = await findReadyDocument<RootDoc>(repo, rootUrl)
    handle.change((doc) => {
      delete doc.registrySummaryOnly
      delete doc.diagramCount
    })
    const meta = await findReadyDocument<{ staticBaseline?: boolean }>(repo, handle.doc()!.modelMetaUrl!)
    meta.change((doc) => { doc.staticBaseline = false })
    await repo.flush([handle.documentId, meta.documentId])
  }

  it('repairs a HYBRID workspace — the ROOT half only, nothing minted — and fsck goes clean', async () => {
    const L = 'L-repair-hybrid'
    const { rootUrl, registryUrl } = await provision(L, 'V1')
    const promoted = await promote(L, 'V1', { apply: true })
    const writeHeadUrl = promoted.report.applied!.writeHeadUrl
    await stripSummaryFlag(rootUrl)

    // The state this door exists for, named by fsck: `degraded`, not clean.
    const before = await fsckWorkspace(db.pool, repo, { landscapeId: L, versionId: 'V1' }, rootUrl)
    expect(before.findings.find((finding) => finding.check === 'summary-static-coherence')?.severity)
      .toBe('degraded')
    // …and neither of the other two doors will touch it.
    expect((await promote(L, 'V1', { apply: true })).report.blockers.map((blocker) => blocker.code))
      .toContain('already-summary')

    const report = await repairSummaryFlag({
      db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' }, apply: true,
    })
    expect(report.blockers).toEqual([])
    expect(report.applied).toEqual({ writeHeadUrl, adoptedFromAllowList: false, diagramCount: 1 })
    // THE THIRD DOOR'S EXIT WITNESS, asserted here because the other arms only
    // cover the promotion's and the demotion's.
    expect(report.exclusionProven).toBe(true)

    const root = await readRoot(rootUrl)
    expect(root.registrySummaryOnly).toBe(true)
    expect(root.diagramCount).toBe(1)
    expect(root.registryWriteUrl).toBe(writeHeadUrl)
    // NOTHING was minted: the same head, the same shardUrls, the same allow-list.
    expect(root.shardUrls).toEqual([registryUrl, writeHeadUrl])
    const rows = await allowListRows(L, 'V1')
    expect(rows.filter((row) => row.kind === 'registry-shard').map((row) => row.document_id))
      .toEqual([idOf(writeHeadUrl)])
    const meta = (await findReadyDocument<{ staticBaseline?: boolean }>(repo, root.modelMetaUrl!)).doc()!
    expect(meta.staticBaseline).toBe(true)

    const after = await fsckWorkspace(db.pool, repo, { landscapeId: L, versionId: 'V1' }, rootUrl)
    expect(after.findings).toEqual([])
    expect(after.status).toBe('clean')

    // Idempotent by REFUSAL, not by re-writing: a second run has nothing to close.
    const again = await repairSummaryFlag({
      db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' }, apply: true,
    })
    expect(again.blockers.map((blocker) => blocker.code)).toContain('not-hybrid')
    expect(again.applied).toBeNull()
  })

  it('repairs a CRASHED promotion by ADOPTING the write head the allow-list already carries', async () => {
    // The promotion's crash window made recoverable. The promotion is
    // deliberately written to fail INTO this state (rows committed, root
    // untouched) rather than into `data-loss`, and this door is the way out:
    // the root names no write head, so `promote` refuses (`already-summary`)
    // and `demote` would throw away a complete, correct allow-list.
    //
    // Nothing is minted here either: the head adopted is the one the crashed
    // promotion made durable and claimed inside its own transaction.
    const L = 'L-repair-crash'
    const { rootUrl } = await provision(L, 'V1')
    const crash = new Error('simulated crash between the commit and the root flip')
    await expect(promote(L, 'V1', {
      apply: true,
      hooks: { onStep: (step: PromotionStep) => { if (step === 'fence-waited') throw crash } },
    })).rejects.toBe(crash)

    const head = (await allowListRows(L, 'V1')).find((row) => row.kind === 'registry-shard')!.document_id
    expect((await readRoot(rootUrl)).registryWriteUrl, 'the root must name no write head yet').toBeUndefined()

    const report = await repairSummaryFlag({
      db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' }, apply: true,
    })
    expect(report.blockers).toEqual([])
    expect(report.applied).toEqual({
      writeHeadUrl: `automerge:${head}`, adoptedFromAllowList: true, diagramCount: 1,
    })

    const root = await readRoot(rootUrl)
    expect(root.registrySummaryOnly).toBe(true)
    expect(root.registryWriteUrl).toBe(`automerge:${head}`)
    expect(root.shardUrls).toContain(`automerge:${head}`)
    expect((await allowListRows(L, 'V1')).filter((row) => row.kind === 'registry-shard')).toHaveLength(1)

    const fsck = await fsckWorkspace(db.pool, repo, { landscapeId: L, versionId: 'V1' }, rootUrl)
    expect(fsck.findings).toEqual([])
    expect(fsck.status).toBe('clean')
  })

  it('refuses to repair when the allow-list and the admission set disagree', async () => {
    // GUARDS AGAINST: losing the equality guard. Flipping the root over a PARTIAL
    // allow-list arms `static_allowed` over documents the list does not carry —
    // they stop resolving durably and their content is stranded. The repair only
    // ever completes a promotion whose durable half is COMPLETE, and it has no
    // way to tell an incomplete list from a complete one except this count.
    const L = 'L-repair-partial'
    const { rootUrl } = await provision(L, 'V1')
    expect((await promote(L, 'V1', { apply: true })).report.applied).not.toBeNull()
    await stripSummaryFlag(rootUrl)
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3)`,
      ['ghostdocumentid00000002', L, 'V1'],
    )

    const report = await repairSummaryFlag({
      db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' }, apply: true,
    })
    expect(report.blockers.map((blocker) => blocker.code)).toContain('allow-list-incomplete')
    expect(report.applied).toBeNull()
    expect((await readRoot(rootUrl)).registrySummaryOnly, 'the root must not have moved').toBeUndefined()

    // Anti-void: remove the disagreement and the same call goes through.
    await db.pool.query(`DELETE FROM automerge_document_workspace WHERE document_id = $1`, ['ghostdocumentid00000002'])
    const repaired = await repairSummaryFlag({
      db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' }, apply: true,
    })
    expect(repaired.blockers).toEqual([])
    expect(repaired.applied).not.toBeNull()
  })

  it('refuses to repair when no write head can be found — it never mints one', async () => {
    const L = 'L-repair-headless'
    const { rootUrl } = await provision(L, 'V1')
    expect((await promote(L, 'V1', { apply: true })).report.applied).not.toBeNull()
    await stripSummaryFlag(rootUrl)
    // Take the head out of the root AND out of the allow-list: the state where a
    // repair has nothing durable to point at. Minting one here is the single
    // irreversible mistake available to this module.
    const handle = await findReadyDocument<RootDoc>(repo, rootUrl)
    handle.change((doc) => { delete doc.registryWriteUrl })
    await repo.flush([handle.documentId])
    await db.pool.query(
      `DELETE FROM read_model_static_documents WHERE landscape_id = $1 AND version_id = $2 AND kind = 'registry-shard'`,
      [L, 'V1'],
    )

    const report = await repairSummaryFlag({
      db: db.pool, repo, workspace: { landscapeId: L, versionId: 'V1' }, apply: true,
    })
    expect(report.blockers.map((blocker) => blocker.code)).toContain('write-head-missing')
    expect(report.plan).toBeNull()
    expect(report.applied).toBeNull()
    expect((await readRoot(rootUrl)).registrySummaryOnly).toBeUndefined()
  })
})
