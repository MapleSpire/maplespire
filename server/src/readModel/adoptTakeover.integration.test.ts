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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import * as A from '@automerge/automerge'
import pg from 'pg'
import { appendFileSync } from 'node:fs'
import { Repo, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import { cachedHandles } from '../automergeRepoCompat.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { ensureReadModelSchema } from './schema.js'
import { ColdBuildAdmission, ColdBuildAdmissionStoppedError } from './coldBuildAdmission.js'
import {
  ProjectorFleet,
  ProjectorOwnershipError,
  awaitAdoptStamps,
  awaitSealedProductCacheWrites,
  hasSealedProductCacheWriter,
  heldSealedValues,
  startReadModelProjector,
} from './projectorService.js'
import type { OrdinaryHeadRotationConfig } from './ordinaryHeadRotation.js'
import { adoptRefusal, readAdoptPlane } from './adoptState.js'
import { AdoptClaimOutcomeUnknownError, ReadModelAdoptAttachError, verifyAdoptShadow, type AdoptVerifyInput } from './adoptVerify.js'
import { claimLifecycleWriteFence, claimReadModelWriteFence, getWorkspaceProjectionFreshness } from './health.js'
import { invalidateContentDigests, verifyWorkspaceIntegrity } from './projectionIntegrity.js'
import type { WorkspaceKey } from './projector.js'
import { durabilityWitnessPayload } from './queries.js'
import { compactionFleet, divergenceEligible, ensureServedForReadiness, readRouteServes } from './fleetServing.js'

/**
 * G4-16f C6-1: VERIFY-AND-ADOPT IN SHADOW, with the real projector, real
 * residency leases, a real Repo over the PostgreSQL storage adapter and the
 * real schema. A corpus primed by a first projector (rotation and fold on,
 * sealed products parked, deltas after its cold build) is taken over by a
 * second attach with `adopt: 'shadow'`, which must log the verdict the
 * claim's checks reach, roll the verify transaction back, and then
 * cold-build exactly as it does with the flag off.
 *
 * Fixtures copied from `ordinarySealedProductParking.integration.test.ts`
 * (a test file imports no other). Isolated schema, TEST_DATABASE_URL; skips
 * without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-c61', versionId: 'v1' }
const LISTED = `${WS.landscapeId}/${WS.versionId}`
const THRESHOLD = 4
const CEILING = 5

let db: IsolatedSchemaDb

type Entity = { id: string; [field: string]: unknown }
type ObjHead = { objects: Record<string, Entity>; writeBatchIds: string[] }
type Meta = {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrl: string
  editsObjectShardUrls: string[]
  editsConnectionShardUrl: string
  editsConnectionShardUrls: string[]
  groups: Record<string, unknown>
}

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))

function storageRepo() {
  return new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 60_000 })
}

interface Workspace {
  repo: Repo
  rootUrl: string
  meta: DocHandle<Meta>
  baseId: string
}

async function workspace(repo: Repo): Promise<Workspace> {
  const base = repo.create<{ objects: Record<string, Entity> }>({ objects: { b: { id: 'b', name: 'B', type: 'system' } } })
  const head = repo.create<ObjHead>({ objects: {}, writeBatchIds: [] })
  const connHead = repo.create({ connections: { c1: { id: 'c1', fromId: 'b', toId: 'b' } }, writeBatchIds: [] })
  const meta = repo.create<Meta>({
    objectShardUrls: [base.url, head.url],
    connectionShardUrls: [connHead.url],
    editsObjectShardUrl: head.url,
    editsObjectShardUrls: [head.url],
    editsConnectionShardUrl: connHead.url,
    editsConnectionShardUrls: [connHead.url],
    groups: {},
  })
  const registry = repo.create<{ diagrams: Record<string, unknown> }>({ diagrams: {} })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
  const handles = [base, head, connHead, meta, registry, root]
  await Promise.all(handles.map((h) => h.whenReady()))
  await repo.flush()
  for (const handle of handles) {
    await db.pool.query(
      'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [String(handle.documentId), WS.landscapeId, WS.versionId],
    )
  }
  return { repo, rootUrl: root.url, meta, baseId: String(base.documentId) }
}

function config(fold = true): OrdinaryHeadRotationConfig {
  return {
    mode: 'on', allowlist: new Set([LISTED]), maxActors: 1_000_000, maxChanges: THRESHOLD,
    deferral: { quietMs: 0, maxMs: 0 },
    ...(fold ? { chainFold: { minChain: 2, budget: 2, retainMs: 86_400_000, segmentCeiling: CEILING, windowEntities: 4 * CEILING } } : {}),
  }
}

function logLines() {
  const lines: Array<Record<string, unknown>> = []
  const capture = (...args: unknown[]) => {
    const first = args[0]
    if (typeof first !== 'string' || !first.startsWith('{')) return
    try { lines.push(JSON.parse(first) as Record<string, unknown>) } catch { /* not ours */ }
  }
  const spies = [
    vi.spyOn(console, 'warn').mockImplementation(capture),
    vi.spyOn(console, 'error').mockImplementation(capture),
    vi.spyOn(console, 'log').mockImplementation(capture),
  ]
  return {
    events: (event: string) => lines.filter((line) => line.event === event),
    restore: () => { for (const spy of spies) spy.mockRestore() },
  }
}

/** The test pool, `before` offered each query (pool-level and on a client
 * from `connect()`) BEFORE it runs. (Copied from the parking suite.) */
function poolBeforeQuery(before: (text: string, params: unknown[] | undefined) => Promise<void> | void) {
  const wrapQuery = (target: { query: (...a: unknown[]) => unknown }) => async (...args: unknown[]) => {
    const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '')
    await before(text, args[1] as unknown[] | undefined)
    return target.query(...args)
  }
  return new Proxy(db.pool, {
    get(target, prop) {
      if (prop === 'query') return wrapQuery(target as never)
      if (prop === 'connect') {
        return async () => {
          const client = await target.connect()
          return new Proxy(client, {
            get(c, p) {
              if (p === 'query') return wrapQuery(c as never)
              const value = Reflect.get(c, p, c) as unknown
              return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(c) : value
            },
          })
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  }) as IsolatedSchemaDb['pool']
}

const currentHead = (ws: Workspace) => ws.meta.doc()!.editsObjectShardUrl
const docId = (url: string) => url.replace(/^automerge:/, '')
const resident = (repo: Repo, id: string) => Object.prototype.hasOwnProperty.call(cachedHandles(repo), id)
const shapeOf = (id: string, data: Record<string, unknown>) => ({ id, name: data.name ?? null, p: data.p ?? null })
const roObjectRows = async () => (await db.pool.query<{ id: string; data: Record<string, unknown> }>(
  'SELECT id, data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id',
  [WS.landscapeId, WS.versionId],
)).rows.map((row) => shapeOf(row.id, row.data)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
const roConnectionIds = async () => (await db.pool.query<{ id: string }>(
  'SELECT id FROM ro_connections WHERE landscape_id = $1 AND version_id = $2 ORDER BY id', [WS.landscapeId, WS.versionId],
)).rows.map((row) => row.id)
const roGroupIds = async () => (await db.pool.query<{ id: string }>(
  'SELECT id FROM ro_groups WHERE landscape_id = $1 AND version_id = $2 ORDER BY id', [WS.landscapeId, WS.versionId],
)).rows.map((row) => row.id)

interface Driven { written: Map<string, Entity> }
const driven = (): Driven => ({ written: new Map([['b', { id: 'b', name: 'B', type: 'system' }]]) })
const expectedRows = (d: Driven) => [...d.written.values()]
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  .map((entity) => shapeOf(entity.id, entity))

/** Fill the current head until due and wait for the projector to rotate it. */
async function fillAndRotate(ws: Workspace, tag: string, d: Driven): Promise<void> {
  const url = currentHead(ws)
  const head = await ws.repo.find<ObjHead>(url as AutomergeUrl)
  let index = 0
  while (A.stats(head.doc() as A.Doc<unknown>).numChanges < THRESHOLD) {
    const id = `${tag}-${index}`
    const value = { id, name: id, type: 'system', p: tag }
    head.change((doc) => { doc.objects[id] = { ...value } })
    d.written.set(id, value)
    index += 1
  }
  const next = await until(() => currentHead(ws), (now) => now !== url, 45_000)
  expect(next).not.toBe(url)
}

const parkedProducts = (log: ReturnType<typeof logLines>) =>
  [...new Set(log.events('read_model.ordinary_sealed_product_parked').map((line) => docId(String(line.url))))]

const fenceRow = async () => (await db.pool.query<{ row: Record<string, unknown> }>(
  `SELECT to_jsonb(p) AS row FROM read_model_projection_state p WHERE landscape_id = $1 AND version_id = $2`,
  [WS.landscapeId, WS.versionId])).rows[0]?.row
const adoptRow = async () => (await db.pool.query<{ row: Record<string, unknown> }>(
  `SELECT to_jsonb(a) AS row FROM read_model_adopt_state a WHERE landscape_id = $1 AND version_id = $2`,
  [WS.landscapeId, WS.versionId])).rows[0]?.row
const fenceNow = async () => String((await fenceRow())!.write_fence)

suite('verify-and-adopt in SHADOW (G4-16f C6-1) — real projector, leases, Repo, PostgreSQL', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'adopt_takeover_c61')
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query(`CREATE TABLE automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query(`CREATE TABLE scopes (kind TEXT, landscape_id TEXT, version_id TEXT, org_id TEXT)`)
    await db.pool.query('CREATE TABLE c61_canary (x INT)')
  })
  afterAll(async () => { await settle(500); await db?.teardown() })
  let restoreRegistration: () => void = () => {}
  beforeEach(async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.pool.query(`TRUNCATE automerge_storage, automerge_document_workspace, ro_objects, ro_connections, ro_groups,
          read_model_projection_state, read_model_change_events, read_model_overlay_batch_acks,
          read_model_overlay_entity_bases, read_model_ordinary_head_retirements, read_model_document_watermarks,
          read_model_ordinary_chain_folds, read_model_adopt_watermarks, read_model_adopt_state,
          read_model_sealed_product_extracts, read_model_sealed_product_entities, c61_canary`)
        break
      } catch (error) {
        if ((error as { code?: string }).code !== '40P01' || attempt >= 5) throw error
        await settle(200)
      }
    }
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async ({ landscapeId, versionId, documentIds }) => {
      for (const documentId of documentIds) {
        await db.pool.query(
          'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [documentId, landscapeId, versionId],
        )
      }
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
  })
  afterEach(() => {
    restoreRegistration()
    delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
  })

  /** A first projector (adopt off) primes the corpus: rotations, a fold whose
   * sealed product is parked, then one more delta after all of them; then it
   * is stopped and its repo flushed. */
  async function primed(log: ReturnType<typeof logLines>) {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const d = driven()
    const stop = await startReadModelProjector(ws.repo, ws.rootUrl, db.pool, WS, residency, 0, undefined, undefined, undefined,
      undefined, config())
    try {
      for (let i = 0; i < 8 && parkedProducts(log).length < 1; i += 1) {
        await fillAndRotate(ws, `h${i}`, d)
        // A fold needs two retired heads; then give it time to run and park.
        if (i >= 1) await until(() => parkedProducts(log).length, (n) => n >= 1, 10_000)
      }
      expect(parkedProducts(log).length, 'the corpus has a parked sealed product').toBeGreaterThanOrEqual(1)
      for (const id of parkedProducts(log)) {
        expect(await until(async () => { await residency.drain(); return !residency.isLeased(id) && !resident(ws.repo, id) },
          (gone) => gone, 15_000)).toBe(true)
      }
      // A delta after the fold: a write into the current head, projected.
      const head = await ws.repo.find<ObjHead>(currentHead(ws) as AutomergeUrl)
      head.change((doc) => { doc.objects.late = { id: 'late', name: 'late', type: 'system', p: 'late' } })
      d.written.set('late', { id: 'late', name: 'late', type: 'system', p: 'late' })
      expect(await until(roObjectRows, (rows) => JSON.stringify(rows) === JSON.stringify(expectedRows(d)), 20_000))
        .toEqual(expectedRows(d))
      await settle(500)
    } finally {
      stop()
    }
    await ws.repo.flush()
    await settle(500)
    const retired = (await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM read_model_ordinary_head_retirements WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId])).rows[0]!.n
    expect(retired, 'retirement rows exist (rotation and fold ran)').toBeGreaterThan(0)
    // Adopt OFF (the default) verifies nothing and logs no verdict.
    expect(log.events('read_model.adopt_verdict')).toHaveLength(0)
    return { ws, d }
  }

  /** A takeover attach with `adopt: 'shadow'` on a fresh Repo (a restarted
   * process): its verdict, its comparison line, and the build it made. */
  async function shadowAttach(ws: Workspace, log: ReturnType<typeof logLines>, pool: IsolatedSchemaDb['pool'] = db.pool) {
    const verdictsBefore = log.events('read_model.adopt_verdict').length
    const comparisonsBefore = log.events('read_model.adopt_shadow_comparison').length
    const buildsBefore = log.events('read_model.cold_build_phases').length
    const repo = storageRepo()
    const residency = new AutomergeResidencyLeases(repo)
    let instance: string | null = null
    const stop = await startReadModelProjector(repo, ws.rootUrl, pool, WS, residency, 0, undefined, undefined, undefined,
      (id) => { instance = id }, config(), { adopt: 'shadow' })
    const verdicts = log.events('read_model.adopt_verdict').slice(verdictsBefore)
    const comparisons = log.events('read_model.adopt_shadow_comparison').slice(comparisonsBefore)
    expect(verdicts, 'exactly one verdict per shadow attach').toHaveLength(1)
    expect(log.events('read_model.cold_build_phases').length - buildsBefore, 'the attach cold-built').toBe(1)
    return { stop, repo, verdict: verdicts[0]!, comparison: comparisons[0], instance: instance! }
  }

  /** The cold build after a verdict is CORRECT: the rows are the corpus',
   * the adopt row is rebound to the new owner, the seals verify. */
  async function expectCorrectBuild(d: Driven, instance: string) {
    expect(await roObjectRows()).toEqual(expectedRows(d))
    expect(await roConnectionIds()).toEqual(['c1'])
    const plane = await readAdoptPlane(db.pool, WS)
    expect(plane?.writeFence).toBe(instance)
    expect(plane?.fenceBinding).toBe(instance)
    expect(adoptRefusal(plane)).toBeNull()
    expect((await verifyWorkspaceIntegrity(db.pool, WS)).outcome).toBe('verified')
  }

  it('A15: on a clean primed corpus the verdict is ADOPTABLE; the verify transaction is rolled back (a write inside it is gone; fence, attached flag and adopt row untouched); the cold build that follows is the same as with the flag off and its digests equal the kept ones', async () => {
    const log = logLines()
    let stop: (() => void) | null = null
    try {
      const { ws, d } = await primed(log)
      const plane = (await adoptRow())!
      // 1. The verifier alone, with a write INSIDE its transaction at S5 and
      //    lock probes from another connection while it holds them.
      const fenceBefore = await fenceRow()
      const adoptBefore = await adoptRow()
      const input: AdoptVerifyInput = {
        orgId: null, fenceObserved: await fenceNow(), sealedCeiling: Number(plane.sealed_ceiling),
        posture: { rotation: true, fold: true, parking: true, extractCache: true },
        afterStep: async (stage, tx) => { if (stage === 'S5') await tx.query('INSERT INTO c61_canary VALUES (1)') },
      }
      expect(plane.posture, 'the primed posture is the one compared').toBe('rotation=on;fold=on;parking=on;cache=on')
      const direct = await verifyAdoptShadow(db.pool, WS, input)
      expect(direct, JSON.stringify(direct)).toMatchObject({ mode: 'shadow', verdict: 'adoptable', reason: null, stage: 'S5' })
      expect(direct.counts!.retired + direct.counts!.products, 'retired heads and products were classified').toBeGreaterThan(0)
      expect(direct.counts!.products).toBeGreaterThanOrEqual(1)
      expect(direct.seeds!.some((seed) => seed.source === 'projected')).toBe(true)
      expect(Object.keys(direct.stepMs).sort()).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'open', 'precheck'])
      expect((await db.pool.query('SELECT * FROM c61_canary')).rows, 'the verify transaction rolled back').toEqual([])
      expect(await fenceRow()).toEqual(fenceBefore)
      expect(await adoptRow()).toEqual(adoptBefore)
      expect(fenceBefore!.projector_attached).toBe(false)
      // Measurement hook: repeated verifies
      // of this corpus, appended to a file only when asked for.
      const measureOut = process.env.G416F_C61_MEASURE_OUT
      if (measureOut) {
        const samples = []
        for (let i = 0; i < 9; i += 1) samples.push(await verifyAdoptShadow(db.pool, WS, { ...input, afterStep: undefined }))
        const rows = (await db.pool.query<{ o: number; c: number }>(
          `SELECT (SELECT count(*)::int FROM ro_objects WHERE landscape_id = $1) AS o,
                  (SELECT count(*)::int FROM ro_connections WHERE landscape_id = $1) AS c`, [WS.landscapeId])).rows[0]
        appendFileSync(measureOut, `${JSON.stringify({ corpus: { ...rows, counts: direct.counts },
          samples: samples.map((s) => ({ verdict: s.verdict, verifyMs: s.verifyMs, stepMs: s.stepMs })) })}\n`)
      }

      // 2. The takeover attach in shadow: the same verdict, logged; then the
      //    cold build, whose seals equal the digests the verifier kept.
      const taken = await shadowAttach(ws, log)
      stop = taken.stop
      expect(taken.verdict).toMatchObject({ verdict: 'adoptable', reason: null, stage: 'S5', mode: 'shadow' })
      expect(Number(taken.verdict.verifyMs)).toBeGreaterThan(0)
      expect(taken.comparison, 'the post-build comparison was logged').toBeDefined()
      expect(taken.comparison!.equal).toEqual({ object: true, connection: true, group: true, diagram: true })
      expect(taken.comparison!.topologyMatches).toBe(true)
      // The logged line carries the classification counts, not only the return value.
      expect(taken.verdict.counts).toEqual(direct.counts)
      const seedHeads = taken.comparison!.seedHeads as { compared: number; differ: number; unknown: number }
      expect(seedHeads.compared).toBeGreaterThan(0)
      expect(seedHeads.differ, JSON.stringify(seedHeads)).toBe(0)
      await expectCorrectBuild(d, taken.instance)
    } finally {
      stop?.()
      log.restore()
    }
  }, 300_000)

  it('A15 stray writes, A3 refusals: each mutation is REFUSED for its own reason, and every refusal is followed by a correct cold build in the same call', async () => {
    const log = logLines()
    let current: (() => void) | null = null
    try {
      const { ws, d } = await primed(log)
      const state = (set: string) => db.pool.query(`UPDATE read_model_projection_state SET ${set} WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId])
      const adopt = (set: string) => db.pool.query(`UPDATE read_model_adopt_state SET ${set} WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId])
      // `unequal`: the kinds whose kept digest must differ from the built one
      // in the post-build comparison (logged on a refusal too).
      const cases: Array<{ name: string; reason: string; stage: string; mutate: () => Promise<unknown>; undo?: () => Promise<unknown>; unequal?: string[] }> = [
        { name: 'stray INSERT on ro_objects', reason: 'digest-mismatch-object', stage: 'S4', unequal: ['object'], mutate: () => db.pool.query(
          `INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES ($1, $2, 'stray', '{}'::jsonb)`, [WS.landscapeId, WS.versionId]) },
        { name: 'stray DELETE on ro_objects', reason: 'digest-mismatch-object', stage: 'S4', unequal: ['object'], mutate: () => db.pool.query(
          `DELETE FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = 'b'`, [WS.landscapeId, WS.versionId]) },
        // Same count, different ids: only the XOR half of the digest sees it.
        { name: 'stray id rename on ro_objects', reason: 'digest-mismatch-object', stage: 'S4', unequal: ['object'], mutate: () => db.pool.query(
          `UPDATE ro_objects SET id = 'renamed' WHERE landscape_id = $1 AND version_id = $2 AND id = 'b'`, [WS.landscapeId, WS.versionId]) },
        { name: 'stray INSERT on ro_connections', reason: 'digest-mismatch-connection', stage: 'S4', unequal: ['connection'], mutate: () => db.pool.query(
          `INSERT INTO ro_connections (landscape_id, version_id, id, from_id, to_id, data) VALUES ($1, $2, 'stray', 'b', 'b', '{}'::jsonb)`,
          [WS.landscapeId, WS.versionId]) },
        { name: 'stale seal', reason: 'digest-stale-connection', stage: 'S4', unequal: [], mutate: () => invalidateContentDigests(db.pool, WS, ['connection']) },
        // A stale seal on one kind and a real mismatch on a later one: the mismatch is named.
        { name: 'stale object seal and a stray connection', reason: 'digest-mismatch-connection', stage: 'S4', unequal: ['connection'], mutate: async () => {
          await invalidateContentDigests(db.pool, WS, ['object'])
          await db.pool.query(`INSERT INTO ro_connections (landscape_id, version_id, id, from_id, to_id, data) VALUES ($1, $2, 'stray2', 'b', 'b', '{}'::jsonb)`,
            [WS.landscapeId, WS.versionId])
        } },
        // The ids still match: only the generation the seal is dated to is older.
        { name: 'a seal dated to an older generation', reason: 'digest-stale-object', stage: 'S4', unequal: [], mutate: () => state(
          `content_digest = jsonb_set(content_digest, '{object,g}', to_jsonb((content_digest->'object'->>'g')::bigint - 1))`) },
        { name: 'pre-C6b row', reason: 'adopt-version', stage: 'precheck', mutate: () => adopt('adopt_version = NULL') },
        { name: 'unbound row', reason: 'fence-unbound', stage: 'precheck', mutate: () => adopt('fence_binding = NULL') },
        { name: 'no adopt row', reason: 'no-adopt-row', stage: 'precheck', mutate: () => db.pool.query(
          'DELETE FROM read_model_adopt_state WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId]) },
        { name: 'fence moved by a previous-release-shaped claim', reason: 'fence-moved', stage: 'precheck', mutate: async () =>
          claimReadModelWriteFence(db.pool, WS, null, 'develop-instance', await fenceNow()) },
        { name: 'lifecycle fence', reason: 'lifecycle-fence', stage: 'precheck', mutate: async () => {
          const client = await db.pool.connect()
          try { await client.query('BEGIN'); await claimLifecycleWriteFence(client, WS); await client.query('COMMIT') } finally { client.release() }
        } },
        { name: 'defects > 0', reason: 'defects', stage: 'precheck', mutate: () => adopt('defects = 1') },
        { name: 'org mismatch', reason: 'org', stage: 'S2', mutate: () => adopt(`org_id = 'another-org'`) },
        { name: 'ceiling mismatch', reason: 'sealed-ceiling', stage: 'S2', mutate: () => adopt('sealed_ceiling = sealed_ceiling + 1') },
        { name: 'posture mismatch', reason: 'posture', stage: 'S2', mutate: () => adopt(`posture = 'rotation=on;fold=on;parking=on;cache=off'`) },
        { name: 'degraded', reason: 'degraded', stage: 'S1', mutate: () => state('degraded_since = now()'),
          undo: () => state('degraded_since = NULL') },
        { name: 'failed', reason: 'failed', stage: 'S1', mutate: () => state('last_error_generation = projected_generation + 1'),
          undo: () => state('last_error_generation = NULL') },
        { name: 'protocol digest mismatch (a write with the triggers off)', reason: 'protocol-digests', stage: 'S3', mutate: async () => {
          const client = await db.pool.connect()
          try {
            await client.query('BEGIN')
            await client.query('SET LOCAL session_replication_role = replica')
            await client.query(`INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id)
              VALUES ($1, $2, 'object', 'ghost-admitted')`, [WS.landscapeId, WS.versionId])
            await client.query('COMMIT')
          } finally { client.release() }
        } },
        { name: 'NULL projected_heads on a non-retired shard', reason: 'null-projected-heads', stage: 'S5', mutate: () => db.pool.query(
          `UPDATE read_model_document_watermarks SET projected_heads = NULL WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
          [WS.landscapeId, WS.versionId, ws.baseId]) },
        { name: 'duplicate listing', reason: 'duplicate-listing', stage: 'S5', mutate: () => adopt('object_shard_ids = object_shard_ids || object_shard_ids[1:1]') },
      ]
      const seen: string[] = []
      for (const c of cases) {
        await c.mutate()
        const taken = await shadowAttach(ws, log)
        current = taken.stop
        expect(taken.verdict, c.name).toMatchObject({ verdict: 'refused', reason: c.reason, stage: c.stage })
        if (c.unequal) {
          expect(taken.comparison, `${c.name}: the comparison is logged on a refusal too`).toBeDefined()
          const equal = taken.comparison!.equal as Record<string, boolean>
          expect(Object.keys(equal).filter((kind) => !equal[kind]).sort(), c.name).toEqual([...c.unequal].sort())
        }
        await c.undo?.()
        await expectCorrectBuild(d, taken.instance)
        taken.stop()
        current = null
        await taken.repo.flush()
        await settle(300)
        seen.push(c.name)
      }
      expect(seen).toHaveLength(cases.length)
      // Control: after every refusal and rebuild, the corpus adopts again.
      const control = await shadowAttach(ws, log)
      current = control.stop
      expect(control.verdict).toMatchObject({ verdict: 'adoptable', reason: null })
    } finally {
      current?.()
      log.restore()
    }
  }, 600_000)

  it('S1 under the locks: a fence moved AFTER the precheck (inside the mutex wait) is refused at S1 by the fence assertion; a lost protocol marker is refused at S1 and its connection destroyed', async () => {
    const log = logLines()
    try {
      const { ws } = await primed(log)
      const plane = (await adoptRow())!
      const input = (fence: string): AdoptVerifyInput => ({
        orgId: null, fenceObserved: fence, sealedCeiling: Number(plane.sealed_ceiling),
        posture: { rotation: true, fold: true, parking: true, extractCache: true },
      })
      // The control first: unmoved, adoptable — with every statement of the
      // verify under its own statement_timeout, and none after it.
      const fence = await fenceNow()
      let timeoutInside: string | null = null
      expect((await verifyAdoptShadow(db.pool, WS, { ...input(fence), afterStep: async (stage, tx) => {
        if (stage === 'S1') timeoutInside = (await tx.query<{ t: string }>(`SELECT current_setting('statement_timeout') AS t`)).rows[0]!.t
      } })).verdict).toBe('adoptable')
      expect(timeoutInside).toBe('5s')
      expect((await db.pool.query<{ t: string }>(`SELECT current_setting('statement_timeout') AS t`)).rows[0]!.t).toBe('0')
      // An observation that is not the current fence: refused at the precheck.
      expect(await verifyAdoptShadow(db.pool, WS, input('not-the-fence'))).toMatchObject({ verdict: 'refused', reason: 'fence-moved', stage: 'precheck' })
      // Moved between the precheck and S1 (just before the mutex).
      let moved = false
      const pool = poolBeforeQuery(async (text) => {
        if (!moved && text.includes('pg_advisory_xact_lock')) {
          moved = true
          await claimReadModelWriteFence(db.pool, WS, null, 'moved-under-the-verify', fence)
        }
      })
      expect(await verifyAdoptShadow(pool, WS, input(fence))).toMatchObject({ verdict: 'refused', reason: 'fence-moved', stage: 'S1' })
      expect(moved).toBe(true)
      await claimReadModelWriteFence(db.pool, WS, null, fence, 'moved-under-the-verify')
      // The adopt row changed between the precheck and S2: S2's own
      // adoptRefusal, under the lock, refuses it.
      let rewritten = false
      const s2pool = poolBeforeQuery(async (text) => {
        if (!rewritten && text.includes('FOR UPDATE OF adopt')) {
          rewritten = true
          await db.pool.query('UPDATE read_model_adopt_state SET adopt_version = NULL WHERE landscape_id = $1 AND version_id = $2',
            [WS.landscapeId, WS.versionId])
        }
      })
      expect(await verifyAdoptShadow(s2pool, WS, input(fence))).toMatchObject({ verdict: 'refused', reason: 'adopt-version', stage: 'S2' })
      expect(rewritten).toBe(true)
      await db.pool.query('UPDATE read_model_adopt_state SET adopt_version = 2 WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId])
      // A connection whose marker a session reset dropped (a pool of one).
      const one = guardIdleClientErrors(new pg.Pool({ connectionString: connection!, max: 1, options: `-c search_path=${db.schema}` }), 'c61-marker')
      try {
        const pidOf = async (q: { query: pg.Pool['query'] }) => (await q.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
        const c = await one.connect()
        const poisoned = await pidOf(c)
        await c.query('DISCARD ALL')
        c.release()
        expect(await verifyAdoptShadow(one, WS, input(fence))).toMatchObject({ verdict: 'refused', reason: 'protocol-marker', stage: 'S1' })
        expect(await pidOf(one), 'the refused connection was destroyed').not.toBe(poisoned)
        expect((await verifyAdoptShadow(one, WS, input(fence))).verdict).toBe('adoptable')
      } finally {
        await one.end()
      }
      void ws
    } finally {
      log.restore()
    }
  }, 300_000)

  it('a shard appended to ModelMeta while no owner runs: the claim alone still says adoptable (S5 reads the KEPT lists), and the post-build comparison says the topology moved and the object digest differs', async () => {
    const log = logLines()
    let stop: (() => void) | null = null
    try {
      const { ws, d } = await primed(log)
      // A writer with no projector: its own Repo (the primed one's ModelMeta
      // handle was given back when its projector stopped).
      const writer = storageRepo()
      const extra = writer.create<{ objects: Record<string, Entity> }>({ objects: { appended: { id: 'appended', name: 'appended', type: 'system' } } })
      await extra.whenReady()
      await db.pool.query(
        'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [String(extra.documentId), WS.landscapeId, WS.versionId])
      const meta = await writer.find<Meta>(ws.meta.url)
      meta.change((doc) => { doc.objectShardUrls.push(extra.url) })
      await writer.flush()
      d.written.set('appended', { id: 'appended', name: 'appended', type: 'system' })
      const taken = await shadowAttach(ws, log)
      stop = taken.stop
      expect(taken.verdict).toMatchObject({ verdict: 'adoptable' })
      expect(taken.comparison!.topologyMatches).toBe(false)
      expect(await roObjectRows()).toEqual(expectedRows(d))
      expect((taken.comparison!.equal as Record<string, boolean>).object, JSON.stringify(taken.comparison)).toBe(false)
      expect(await roObjectRows()).toEqual(expectedRows(d))
    } finally {
      stop?.()
      log.restore()
    }
  }, 300_000)

  it('a verifier that THROWS (a statement failing inside the transaction) is logged as the verdict `error` and the attach still cold-builds correctly', async () => {
    const log = logLines()
    let stop: (() => void) | null = null
    try {
      const { ws, d } = await primed(log)
      const pool = poolBeforeQuery((text) => {
        if (text.includes('read_model_adopt_protocol_digests') && text.includes('SELECT retirements, folds')) {
          throw Object.assign(new Error('test: the protocol digest read fails'), { code: 'XX123' })
        }
      })
      const taken = await shadowAttach(ws, log, pool)
      stop = taken.stop
      expect(taken.verdict).toMatchObject({ verdict: 'error', reason: 'XX123', stage: 'S3' })
      expect(String(taken.verdict.detail)).toContain('test: the protocol digest read fails')
      expect(taken.comparison, 'no comparison without kept digests').toBeUndefined()
      await expectCorrectBuild(d, taken.instance)
    } finally {
      stop?.()
      log.restore()
    }
  }, 300_000)
})

// ============================================================ C6-2a: ADOPT ON

/** The fence row and the adopt row's binding, in one statement. */
const planeState = async () => (await db.pool.query<{
  write_fence: string | null; projector_attached: boolean | null; projector_instance_id: string | null
  fence_binding: string | null; projected_generation: string | null; degraded_since: unknown
}>(
  `SELECT p.write_fence, p.projector_attached, p.projector_instance_id, a.fence_binding,
          p.projected_generation::text AS projected_generation, p.degraded_since
     FROM read_model_projection_state p
     LEFT JOIN read_model_adopt_state a ON a.landscape_id = p.landscape_id AND a.version_id = p.version_id
    WHERE p.landscape_id = $1 AND p.version_id = $2`,
  [WS.landscapeId, WS.versionId])).rows[0]!

/** Every `ro_*` table with a landscape column, each row as JSON without its
 * timestamp columns (`*_at`), sorted: the whole served plane of WS. */
async function roDump(): Promise<Record<string, string[]>> {
  const tables = (await db.pool.query<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name LIKE 'ro\\_%' AND column_name = 'landscape_id' ORDER BY 1`,
  )).rows.map((row) => row.t)
  const out: Record<string, string[]> = {}
  for (const table of tables) {
    const rows = (await db.pool.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS row FROM ${table} t WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])).rows
    out[table] = rows.map(({ row }) => JSON.stringify(Object.entries(row)
      .filter(([column]) => !column.endsWith('_at'))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))).sort()
  }
  return out
}

/** What a C6-2a attach did, and what it left behind. */
interface AttachRun {
  stop: (() => void) | null
  error: unknown
  repo: Repo
  instance: string | null
  /** This attach's `read_model.adopt_verdict` (adopt on only). */
  verdict: Record<string, unknown> | undefined
  /** This attach's `read_model.adopt_attach` (an adopted attach only). */
  attachLine: Record<string, unknown> | undefined
  /** `read_model.cold_build_phases` lines this attach logged. */
  builds: number
  /** 'change' listeners left on every handle this attach resolved. */
  listeners: () => number
  /** Residency leases held by a projector owner. */
  projectorLeases: () => number
  leasedAtMost: number
  /** Projector timers still armed, each with the stack that armed it. */
  liveTimers: Map<unknown, string>
  armedTimers: number
  finds: Map<string, number>
}

interface AttachOptions {
  pool?: IsolatedSchemaDb['pool']
  /** Awaited inside the Repo's `find`, before it runs: the url and how many
   * finds of it this attach has made (1-based). May throw (the find fails). */
  beforeFind?: (url: string, nth: number) => Promise<void> | void
  stillOwned?: () => boolean
  mode?: 'on' | 'off'
  fold?: boolean
  /** Track the timers the projector arms during the attach. */
  timers?: boolean
  /** C6-2b: the projector's `onServing` hook. */
  onServing?: () => void
  /** T-DIAGDEF-2: the attach's own Repo, before the attach starts. */
  onRepo?: (repo: Repo) => void
}

/** A takeover attach on a FRESH Repo (a restarted process), adopt on by
 * default, never throwing: its outcome and its leftovers. */
async function attachOnce(ws: Workspace, log: ReturnType<typeof logLines>, o: AttachOptions = {}): Promise<AttachRun> {
  const verdictsBefore = log.events('read_model.adopt_verdict').length
  const buildsBefore = log.events('read_model.cold_build_phases').length
  const attachesBefore = log.events('read_model.adopt_attach').length
  const repo = storageRepo()
  o.onRepo?.(repo)
  const found = new Set<DocHandle<unknown>>()
  const finds = new Map<string, number>()
  const proxied = new Proxy(repo, {
    get(target, prop) {
      if (prop === 'find') {
        return async (url: AutomergeUrl, ...rest: unknown[]) => {
          const nth = (finds.get(String(url)) ?? 0) + 1
          finds.set(String(url), nth)
          await o.beforeFind?.(String(url), nth)
          const handle = await ((target.find as (...a: unknown[]) => unknown).call(target, url, ...rest) as Promise<DocHandle<unknown>>)
          found.add(handle)
          return handle
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  }) as Repo
  const residency = new AutomergeResidencyLeases(repo)
  const projectorLeases = () => {
    let n = 0
    for (const lease of (residency as unknown as { leases: Map<string, { owners: Map<string, unknown> }> }).leases.values()) {
      for (const owner of lease.owners.keys()) if (owner.startsWith('projector:')) n += 1
    }
    return n
  }
  let leasedAtMost = 0
  const acquire = residency.acquire.bind(residency)
  residency.acquire = (...args: Parameters<AutomergeResidencyLeases['acquire']>) => {
    acquire(...args)
    leasedAtMost = Math.max(leasedAtMost, projectorLeases())
  }
  const liveTimers = new Map<unknown, string>()
  let armedTimers = 0
  const timerSpies: Array<{ mockRestore: () => void }> = []
  if (o.timers) {
    let lastStack = ''
    const fromProjector = () => {
      lastStack = new Error().stack ?? ''
      // The pool's own idle timer, armed on a client released from a
      // projector frame, is the pool's, not the projector's.
      return /projectorService\.ts/.test(lastStack) && !/pg-pool/.test(lastStack)
    }
    const realSetTimeout = globalThis.setTimeout
    const realSetInterval = globalThis.setInterval
    const realClearTimeout = globalThis.clearTimeout
    const realClearInterval = globalThis.clearInterval
    timerSpies.push(
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
        const tracked = fromProjector()
        const timer: unknown = realSetTimeout((...a: unknown[]) => { liveTimers.delete(timer); fn(...a) }, ms, ...rest)
        if (tracked) { liveTimers.set(timer, lastStack); armedTimers += 1 }
        return timer
      }) as unknown as typeof setTimeout),
      vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
        const timer = realSetInterval(fn, ms, ...rest)
        if (fromProjector()) { liveTimers.set(timer, lastStack); armedTimers += 1 }
        return timer
      }) as unknown as typeof setInterval),
      vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((timer: Parameters<typeof clearTimeout>[0]) => {
        liveTimers.delete(timer)
        realClearTimeout(timer)
      }) as typeof clearTimeout),
      vi.spyOn(globalThis, 'clearInterval').mockImplementation(((timer: Parameters<typeof clearInterval>[0]) => {
        liveTimers.delete(timer)
        realClearInterval(timer)
      }) as typeof clearInterval),
    )
  }
  let instance: string | null = null
  let stop: (() => void) | null = null
  let error: unknown
  try {
    stop = await startReadModelProjector(proxied, ws.rootUrl, o.pool ?? db.pool, WS, residency, 0, 2_000, o.stillOwned, undefined,
      (id) => { instance = id }, config(o.fold ?? true), { adopt: o.mode ?? 'on', ...(o.onServing ? { onServing: o.onServing } : {}) })
  } catch (thrown) {
    error = thrown
  } finally {
    for (const spy of timerSpies) spy.mockRestore()
  }
  return {
    stop, error, repo, instance,
    verdict: log.events('read_model.adopt_verdict').slice(verdictsBefore).at(-1),
    attachLine: log.events('read_model.adopt_attach').slice(attachesBefore).at(-1),
    builds: log.events('read_model.cold_build_phases').length - buildsBefore,
    listeners: () => [...found].reduce((sum, handle) => sum + handle.listenerCount('change'), 0),
    projectorLeases, leasedAtMost, liveTimers, armedTimers, finds,
  }
}

suite('verify-and-adopt ON (G4-16f C6-2a) — the claim and the background attach B1-B5, real projector, leases, Repo, PostgreSQL', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'adopt_takeover_c62a')
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query(`CREATE TABLE automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query(`CREATE TABLE scopes (kind TEXT, landscape_id TEXT, version_id TEXT, org_id TEXT)`)
  })
  afterAll(async () => { await settle(500); await db?.teardown() })
  let restoreRegistration: () => void = () => {}
  beforeEach(async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    // EVERY ro_* table, so a full dump compares this test's rows only.
    const roTables = (await db.pool.query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'ro\\_%'`,
    )).rows.map((row) => row.t)
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.pool.query(`TRUNCATE automerge_storage, automerge_document_workspace, ${roTables.join(', ')},
          read_model_projection_state, read_model_change_events, read_model_overlay_batch_acks,
          read_model_overlay_entity_bases, read_model_ordinary_head_retirements, read_model_document_watermarks,
          read_model_ordinary_chain_folds, read_model_adopt_watermarks, read_model_adopt_state,
          read_model_sealed_product_extracts, read_model_sealed_product_entities`)
        break
      } catch (error) {
        if ((error as { code?: string }).code !== '40P01' || attempt >= 5) throw error
        await settle(200)
      }
    }
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async ({ landscapeId, versionId, documentIds }) => {
      for (const documentId of documentIds) {
        await db.pool.query(
          'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [documentId, landscapeId, versionId],
        )
      }
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
  })
  afterEach(() => {
    restoreRegistration()
    delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
  })

  /** A first projector (adopt off) primes the corpus: rotations; with the
   * fold on, at least `products` sealed products parked and their extracts
   * written; then deltas after all of them — an object write into the
   * current head, a connection, a group — all projected. Stopped, unless
   * `keepAlive` (a process that died without `stop()`: its row still says
   * attached), and its repo flushed. */
  async function primedForAdopt(log: ReturnType<typeof logLines>, opts: {
    products?: number; keepAlive?: boolean; fold?: boolean; p1Pool?: IsolatedSchemaDb['pool']
  } = {}) {
    const products = opts.products ?? 1
    const fold = opts.fold ?? true
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const d = driven()
    const stop = await startReadModelProjector(ws.repo, ws.rootUrl, opts.p1Pool ?? db.pool, WS, residency, 0, undefined, undefined,
      undefined, undefined, config(fold))
    let stopped = false
    const stopP1 = () => { if (!stopped) { stopped = true; stop() } }
    try {
      if (fold) {
        for (let i = 0; i < 4 * products + 4 && parkedProducts(log).length < products; i += 1) {
          await fillAndRotate(ws, `h${i}`, d)
          if (i >= 1) await until(() => parkedProducts(log).length, (n) => n >= Math.floor((i + 1) / 2), 10_000)
        }
        const parked = await until(() => parkedProducts(log), (ids) => ids.length >= products, 60_000)
        expect(parked.length, 'the corpus has its parked sealed products').toBeGreaterThanOrEqual(products)
        for (const id of parked) {
          expect(await until(async () => { await residency.drain(); return !residency.isLeased(id) && !resident(ws.repo, id) },
            (gone) => gone, 15_000)).toBe(true)
        }
        await awaitSealedProductCacheWrites(WS)
      } else {
        await fillAndRotate(ws, 'h0', d)
        await fillAndRotate(ws, 'h1', d)
      }
      // Deltas after the cold build and the folds.
      const head = await ws.repo.find<ObjHead>(currentHead(ws) as AutomergeUrl)
      head.change((doc) => { doc.objects.late = { id: 'late', name: 'late', type: 'system', p: 'late' } })
      d.written.set('late', { id: 'late', name: 'late', type: 'system', p: 'late' })
      const conn = await ws.repo.find<{ connections: Record<string, Entity> }>(ws.meta.doc()!.editsConnectionShardUrl as AutomergeUrl)
      conn.change((doc) => { doc.connections.c2 = { id: 'c2', fromId: 'b', toId: 'late' } })
      ws.meta.change((doc) => { doc.groups.g1 = { id: 'g1', name: 'G1', objectIds: ['b'] } })
      expect(await until(roObjectRows, (rows) => JSON.stringify(rows) === JSON.stringify(expectedRows(d)), 20_000))
        .toEqual(expectedRows(d))
      expect(await until(roConnectionIds, (ids) => ids.includes('c2'), 20_000)).toEqual(['c1', 'c2'])
      expect(await until(roGroupIds, (ids) => ids.includes('g1'), 20_000)).toEqual(['g1'])
      await settle(500)
      await awaitAdoptStamps(WS)
      await awaitSealedProductCacheWrites(WS)
    } finally {
      if (!opts.keepAlive) stopP1()
    }
    await ws.repo.flush()
    await settle(500)
    // The corpus is adoptable (the precondition of every test here).
    expect(adoptRefusal(await readAdoptPlane(db.pool, WS))).toBeNull()
    return { ws, d, stopP1, residency }
  }

  /** A throw at each await of the background attach (after the claim):
   * where (a find of a url, its nth; or a statement's text) and the stage
   * the attach must fail at. Shared by A5 (the projector) and the C6-2b
   * window (the fleet). */
  type FaultCase = {
    name: string; stage: string; succeeds?: boolean
    find?: (url: string, nth: number) => boolean
    sql?: string
  }
  async function backgroundFaultCases(ws: Workspace): Promise<FaultCase[]> {
    const meta = ws.meta.doc()!
    const rootUrl = ws.rootUrl
    const registryUrl = (await (await ws.repo.find<{ shardUrls: string[] }>(rootUrl as AutomergeUrl)).doc()!).shardUrls[0]!
    const baseUrl = meta.objectShardUrls[0]!
    return [
      { name: 'B1 root resolve', stage: 'B1', find: (url) => url === rootUrl },
      { name: 'B1 ModelMeta resolve', stage: 'B1', find: (url) => url === ws.meta.url },
      { name: 'B1 registry resolve', stage: 'B1', find: (url, nth) => url === registryUrl && nth === 1 },
      { name: 'B1 retirement rows', stage: 'B1', sql: 'SELECT collection, document_id, retirement_heads, forwarded_heads, status, folded_into' },
      { name: 'B2 cache headers (a miss, not a failure)', stage: 'B2', succeeds: true, sql: 'header.extraction_version, header.entity_count' },
      { name: 'B2 a miss\'s arrival read', stage: 'B2', sql: 'FROM unnest($1::text[]) AS d(id)' },
      { name: 'B3 seed resolve', stage: 'B3', find: (url) => url === baseUrl },
      { name: 'B3 registry watcher', stage: 'B3', find: (url, nth) => url === registryUrl && nth === 2 },
      { name: 'B4 ModelMeta pass', stage: 'B4', sql: 'UNION SELECT object_id FROM ro_group_objects' },
      { name: 'B4 registry pass', stage: 'B4', sql: 'SELECT id FROM ro_diagrams WHERE landscape_id' },
      { name: 'B5 bind', stage: 'B5', sql: 'UPDATE read_model_adopt_state SET fence_binding' },
    ]
  }

  /** A FLEET (adopt on) on a fresh Repo — a restarted process — whose finds
   * and statements a test can intercept; it records every projector
   * instance it starts, in order. */
  function takeoverFleet(ws: Workspace, o: {
    pool?: IsolatedSchemaDb['pool']
    beforeFind?: (url: string, nth: number) => Promise<void> | void
    coldBuildAdmission?: ColdBuildAdmission
  } = {}) {
    const repo = storageRepo()
    const finds = new Map<string, number>()
    const proxied = new Proxy(repo, {
      get(target, prop) {
        if (prop === 'find') {
          return async (url: AutomergeUrl, ...rest: unknown[]) => {
            const nth = (finds.get(String(url)) ?? 0) + 1
            finds.set(String(url), nth)
            await o.beforeFind?.(String(url), nth)
            return (target.find as (...a: unknown[]) => unknown).call(target, url, ...rest) as Promise<DocHandle<unknown>>
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as Repo
    const residency = new AutomergeResidencyLeases(repo)
    const instances: string[] = []
    const fleet = new ProjectorFleet(proxied, async () => ws.rootUrl, {
      fallbackRootUrl: ws.rootUrl, db: o.pool ?? db.pool, residency, ordinaryHeadRotation: config(), adopt: 'on',
      ...(o.coldBuildAdmission ? { coldBuildAdmission: o.coldBuildAdmission } : {}),
      startProjector: ((...args: Parameters<typeof startReadModelProjector>) => {
        const onAttached = args[9]
        args[9] = (id: string) => { instances.push(id); onAttached?.(id) }
        return startReadModelProjector(...args)
      }) as typeof startReadModelProjector,
    })
    const leasesOf = (instance: string) => {
      let n = 0
      for (const lease of (residency as unknown as { leases: Map<string, { owners: Map<string, unknown> }> }).leases.values()) {
        if (lease.owners.has(`projector:${instance}`)) n += 1
      }
      return n
    }
    return { fleet, repo, residency, instances, leasesOf }
  }

  /** A Repo writing to storage with no projector (no owner runs). */
  async function ownerless<T>(fn: (writer: Repo) => Promise<T>): Promise<T> {
    const writer = storageRepo()
    const out = await fn(writer)
    await writer.flush()
    return out
  }

  /** After a FAILED adopt: the next attach (adopt on) refuses at the
   * precheck — the binding is the previous fence — and cold-builds ONCE,
   * correctly; it is stopped and the corpus is adoptable again. */
  async function nextAttachColdBuilds(ws: Workspace, log: ReturnType<typeof logLines>, d: Driven, label: string) {
    const next = await attachOnce(ws, log)
    try {
      expect(next.error, `${label}: the next attach`).toBeUndefined()
      expect(next.verdict, label).toMatchObject({ verdict: 'refused', reason: 'fence-moved', stage: 'precheck' })
      expect(next.builds, `${label}: exactly one cold build`).toBe(1)
      expect(await roObjectRows(), label).toEqual(expectedRows(d))
      expect(await planeState(), label).toMatchObject({ write_fence: next.instance, fence_binding: next.instance, projector_attached: true })
    } finally {
      next.stop?.()
      await next.repo.flush()
      await settle(300)
    }
  }

  it('A1: the happy path — rotation and fold on, three sealed products served from the cache, deltas after the cold build, P1 dropped WITHOUT stop(): P2 claims and attaches with no cold build and no product loaded; idle (no absence proof) in the window, healthy with it after B5; the fence and the binding are P2\'s; the whole ro_* plane equals a reference cold build', async () => {
    const log = logLines()
    let p2: AttachRun | null = null
    let reference: AttachRun | null = null
    let stopP1: () => void = () => {}
    try {
      const primed = await primedForAdopt(log, { products: 3, keepAlive: true })
      stopP1 = primed.stopP1
      const { ws, d } = primed
      const before = await planeState()
      expect(before.projector_attached, 'P1 died without stop(): its row still says attached').toBe(true)
      const fenceBefore = before.write_fence
      expect(before.fence_binding).toBe(fenceBefore)
      const products = parkedProducts(log)
      expect(products.length).toBeGreaterThanOrEqual(3)
      // The window, sampled as B5 binds (its first adopt-row statement).
      let window: { freshness: Awaited<ReturnType<typeof getWorkspaceProjectionFreshness>>; state: Awaited<ReturnType<typeof planeState>> } | null = null
      const pool = poolBeforeQuery(async (text) => {
        if (window === null && text.includes('UPDATE read_model_adopt_state SET fence_binding')) {
          window = { freshness: await getWorkspaceProjectionFreshness(db.pool, WS), state: await planeState() }
        }
      })
      p2 = await attachOnce(ws, log, { pool })
      expect(p2.error, String(p2.error)).toBeUndefined()
      expect(p2.verdict).toMatchObject({ mode: 'on', verdict: 'claimed', reason: null, stage: 'S6' })
      expect(p2.builds, 'no cold_build_phases line: nothing was rebuilt').toBe(0)
      expect(p2.attachLine, 'the adopt attach line').toBeDefined()
      expect(p2.attachLine).toMatchObject({ productsLoaded: 0, changedProducts: 0, cacheHeadsRefused: 0, bound: true })
      expect(Number(p2.attachLine!.cacheHits)).toBe(products.length)
      for (const id of products) {
        expect(resident(p2.repo, id), `sealed product ${id} was never resolved`).toBe(false)
        expect(p2.finds.get(`automerge:${id}`) ?? 0, `sealed product ${id} was never found`).toBe(0)
      }
      // The window: claimed (P2's fence), NOT attached, the binding still P1's.
      expect(window, 'B5 ran').not.toBeNull()
      expect(window!.state).toMatchObject({
        write_fence: p2.instance, projector_attached: false, projector_instance_id: p2.instance, fence_binding: fenceBefore,
      })
      expect(window!.freshness.status).toBe('idle')
      expect(window!.freshness.caughtUp).toBe(false)
      expect(window!.freshness.absenceProvable).toBe(false)
      // After B5.
      expect(await planeState()).toMatchObject({
        write_fence: p2.instance, projector_attached: true, projector_instance_id: p2.instance, fence_binding: p2.instance,
      })
      expect(adoptRefusal(await readAdoptPlane(db.pool, WS))).toBeNull()
      const fresh = await until(() => getWorkspaceProjectionFreshness(db.pool, WS), (f) => f.status === 'healthy' && f.absenceProvable, 20_000)
      expect(fresh).toMatchObject({ status: 'healthy', caughtUp: true, absenceProvable: true })
      expect(await roObjectRows()).toEqual(expectedRows(d))
      // The whole ro_* plane against a reference cold build of the same documents.
      await settle(500)
      const adopted = await roDump()
      expect(Object.values(adopted).flat().length, 'the dump holds rows').toBeGreaterThan(10)
      p2.stop?.()
      p2.stop = null
      await p2.repo.flush()
      await settle(300)
      reference = await attachOnce(ws, log, { mode: 'off' })
      expect(reference.error).toBeUndefined()
      expect(reference.builds).toBe(1)
      expect(await roDump()).toEqual(adopted)
    } finally {
      p2?.stop?.()
      reference?.stop?.()
      stopP1()
      log.restore()
    }
  }, 300_000)

  it('A2 + A11: a current-head write and a base-shard delete landing AFTER the claim and before B3 are both in the rows after B5; the gap passes that completed during the window left the status idle', async () => {
    const log = logLines()
    let p2: AttachRun | null = null
    try {
      const { ws, d } = await primedForAdopt(log)
      const meta = ws.meta.doc()!
      let claimedGeneration: number | null = null
      let wrote = false
      let suspended = false
      let window: { status: string; generation: number } | null = null
      const pool = poolBeforeQuery(async (text) => {
        // B1's retirement read: after the claim committed, before any shard is read.
        if (!wrote && text.includes('SELECT collection, document_id, retirement_heads, forwarded_heads, status, folded_into')
          && (await planeState()).projector_attached === false && (await planeState()).write_fence !== null) {
          const state = await planeState()
          if (state.projector_instance_id === null) return
          wrote = true
          claimedGeneration = Number(state.projected_generation)
          await ownerless(async (writer) => {
            const head = await writer.find<ObjHead>(meta.editsObjectShardUrl as AutomergeUrl)
            head.change((doc) => { doc.objects.during = { id: 'during', name: 'during', type: 'system', p: 'during' } })
            const base = await writer.find<{ objects: Record<string, Entity> }>(meta.objectShardUrls[0] as AutomergeUrl)
            base.change((doc) => { delete doc.objects.b })
          })
        }
        // The first gap pass is SUSPENDED (1.5 s) in its durable-proof read,
        // BEFORE it queues its transaction on the projection tail (which B5
        // also queues on): an attach that did not wait for the pass would
        // bind and resolve before its rows.
        if (wrote && !suspended && text.includes('AS documents(document_id)')) {
          suspended = true
          await settle(1_500)
        }
        if (window === null && text.includes('UPDATE read_model_adopt_state SET fence_binding')) {
          const f = await getWorkspaceProjectionFreshness(db.pool, WS)
          window = { status: f.status, generation: f.projectedGeneration }
        }
      })
      d.written.set('during', { id: 'during', name: 'during', type: 'system', p: 'during' })
      d.written.delete('b')
      p2 = await attachOnce(ws, log, { pool })
      expect(p2.error, String(p2.error)).toBeUndefined()
      expect(wrote, 'the writes landed inside the window').toBe(true)
      expect(suspended, 'a gap pass was suspended').toBe(true)
      expect(p2.verdict).toMatchObject({ verdict: 'claimed' })
      expect(p2.builds).toBe(0)
      // Immediately after the attach resolved: B5 waited for the gap passes.
      expect(await roObjectRows()).toEqual(expectedRows(d))
      // A11: passes completed during the window (the generation moved) and
      // the status was still idle at B5.
      expect(window).not.toBeNull()
      expect(window!.generation, 'a gap pass completed before B5').toBeGreaterThan(claimedGeneration!)
      expect(window!.status).toBe('idle')
    } finally {
      p2?.stop?.()
      log.restore()
    }
  }, 300_000)

  it('T-DIAGDEF-2: a registry shard appended to the root AFTER B1 read it, before the root watcher: its later edits are projected', async () => {
    const log = logLines()
    let p2: AttachRun | null = null
    try {
      const { ws } = await primedForAdopt(log, { fold: false })
      const registryUrl = (await (await ws.repo.find<{ shardUrls: string[] }>(ws.rootUrl as AutomergeUrl)).doc()!).shardUrls[0]!
      let attachRepo: Repo | null = null
      let appended: DocHandle<{ diagrams: Record<string, unknown> }> | null = null
      const diagramRows = async () => (await db.pool.query<{ id: string }>(
        'SELECT id FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 ORDER BY id', [WS.landscapeId, WS.versionId],
      )).rows.map((row) => row.id)
      p2 = await attachOnce(ws, log, {
        fold: false,
        onRepo: (repo) => { attachRepo = repo },
        // B3's watcher of the boot registry shard (its 2nd find): B1 has read
        // the root, and the root watcher is attached only after B3.
        beforeFind: async (url, nth) => {
          if (appended || url !== registryUrl || nth !== 2) return
          const repo = attachRepo!
          const doc = repo.create({ layouts: {}, comments: {}, flows: {} })
          appended = repo.create<{ diagrams: Record<string, unknown> }>({ diagrams: {
            dFirst: { id: 'dFirst', name: 'In the appended shard', docUrl: doc.url, objectIds: [] },
          } })
          await Promise.all([doc.whenReady(), appended.whenReady()])
          for (const handle of [doc, appended]) {
            await db.pool.query('INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
              [String(handle.documentId), WS.landscapeId, WS.versionId])
          }
          const root = await repo.find<{ shardUrls: string[] }>(ws.rootUrl as AutomergeUrl)
          root.change((d) => { d.shardUrls.push(appended!.url) })
        },
      })
      expect(p2.error, String(p2.error)).toBeUndefined()
      expect(p2.verdict, 'the attach ADOPTED: the case is about B4').toMatchObject({ verdict: 'claimed' })
      expect(appended, 'the root never changed inside the window: VOID').not.toBeNull()
      // B4's registry pass reads the live root: the appended shard's diagram is in.
      expect(await until(diagramRows, (ids) => ids.includes('dFirst'), 10_000)).toContain('dFirst')
      // …and the shard is WATCHED: an edit of it after the attach reaches the rows.
      const lateDoc = attachRepo!.create({ layouts: {}, comments: {}, flows: {} })
      await lateDoc.whenReady()
      appended!.change((d) => { d.diagrams.dLater = { id: 'dLater', name: 'Added after the attach', docUrl: lateDoc.url, objectIds: [] } })
      expect(await until(diagramRows, (ids) => ids.includes('dLater'), 10_000)).toContain('dLater')
    } finally {
      p2?.stop?.()
      log.restore()
    }
  }, 300_000)

  it('A2b: a base-shard delete made while NO owner runs is removed by the adopter (the seed is the content at the projected heads, not the live one)', async () => {
    const log = logLines()
    let p2: AttachRun | null = null
    try {
      const { ws, d } = await primedForAdopt(log)
      await ownerless(async (writer) => {
        const base = await writer.find<{ objects: Record<string, Entity> }>(ws.meta.doc()!.objectShardUrls[0] as AutomergeUrl)
        base.change((doc) => { delete doc.objects.b; doc.objects.b3 = { id: 'b3', name: 'B3', type: 'system' } })
      })
      d.written.delete('b')
      d.written.set('b3', { id: 'b3', name: 'B3', type: 'system' })
      p2 = await attachOnce(ws, log)
      expect(p2.error, String(p2.error)).toBeUndefined()
      expect(p2.verdict).toMatchObject({ verdict: 'claimed' })
      expect(Number(p2.attachLine!.seededByView), 'the base was seeded by a view').toBeGreaterThanOrEqual(1)
      expect(await roObjectRows()).toEqual(expectedRows(d))
    } finally {
      p2?.stop?.()
      log.restore()
    }
  }, 300_000)

  it('A4: P1 mid-pass (holding the projection mutex) during the claim: the claim waits, then verifies P1\'s committed rows; the rows are right and P1 is fenced out afterwards', async () => {
    const log = logLines()
    let p2: AttachRun | null = null
    let stopP1: () => void = () => {}
    try {
      let armed = false
      let held = false
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      const p1Pool = poolBeforeQuery(async (text) => {
        if (armed && !held && text.includes('AS participant FROM read_model_projection_state')) {
          held = true
          await gate
        }
      })
      const primed = await primedForAdopt(log, { keepAlive: true, p1Pool })
      stopP1 = primed.stopP1
      const { ws, d } = primed
      // P1 projects a write and stops inside its pass, the mutex held.
      armed = true
      const head = await ws.repo.find<ObjHead>(currentHead(ws) as AutomergeUrl)
      head.change((doc) => { doc.objects.mid = { id: 'mid', name: 'mid', type: 'system', p: 'mid' } })
      d.written.set('mid', { id: 'mid', name: 'mid', type: 'system', p: 'mid' })
      expect(await until(() => held, Boolean, 10_000), 'P1 is mid-pass').toBe(true)
      await ws.repo.flush()
      const adopting = attachOnce(ws, log)
      await settle(400)
      release()
      p2 = await adopting
      expect(p2.error, String(p2.error)).toBeUndefined()
      expect(p2.verdict!.verdict === 'claimed' || p2.builds === 1, JSON.stringify(p2.verdict)).toBe(true)
      expect(await roObjectRows()).toEqual(expectedRows(d))
      expect((await planeState()).write_fence).toBe(p2.instance)
      // P1 writes on: fenced out, the rows unchanged by it.
      head.change((doc) => { doc.objects.zombie = { id: 'zombie', name: 'zombie', type: 'system', p: 'zombie' } })
      await settle(1_500)
      expect((await roObjectRows()).map((row) => row.id)).not.toContain('zombie')
    } finally {
      p2?.stop?.()
      stopP1()
      log.restore()
    }
  }, 300_000)

  it('A5: a throw at each await of the background attach leaves no listener, no lease, no timer, no writer, the binding on the previous fence and the row not attached — and the next attach cold-builds exactly once (no adopt loop); a cache that cannot be read only misses', async () => {
    const log = logLines()
    try {
      const { ws, d } = await primedForAdopt(log)
      const cases = await backgroundFaultCases(ws)
      for (const c of cases) {
        const fenceBefore = (await planeState()).write_fence
        let claimed = false
        let injected = false
        const fault = () => { injected = true; return new Error(`test: ${c.name} fails`) }
        const pool = poolBeforeQuery((text) => {
          if (text.includes('projector_attached = false') && text.includes('projector_instance_id = $3')) claimed = true
          // B2's miss case: the cache must miss first (its header deleted below).
          if (claimed && !injected && c.sql && text.includes(c.sql)) throw fault()
        })
        if (c.name.startsWith('B2 a miss')) {
          await db.pool.query('DELETE FROM read_model_sealed_product_extracts WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId])
        }
        const run = await attachOnce(ws, log, {
          pool, timers: true,
          beforeFind: (url, nth) => { if (claimed && !injected && c.find?.(url, nth)) throw fault() },
        })
        expect(injected, `${c.name}: the fault was reached`).toBe(true)
        expect(claimed, `${c.name}: the claim committed first`).toBe(true)
        if (c.succeeds) {
          expect(run.error, `${c.name}: ${String(run.error)}`).toBeUndefined()
          expect(run.attachLine, c.name).toMatchObject({ cacheHits: 0 })
          expect(Number(run.attachLine!.productsLoaded), `${c.name}: every product loaded instead`).toBeGreaterThanOrEqual(1)
          expect(await roObjectRows()).toEqual(expectedRows(d))
          run.stop?.()
          await run.repo.flush()
          await settle(300)
          continue
        }
        expect(run.error, c.name).toBeInstanceOf(ReadModelAdoptAttachError)
        expect((run.error as ReadModelAdoptAttachError).stage, `${c.name}: ${String(run.error)}`).toBe(c.stage)
        expect((run.error as ReadModelAdoptAttachError).reason, c.name).not.toBe('aborted')
        expect(run.builds, `${c.name}: no cold build`).toBe(0)
        await settle(1_500)
        // Witness (from the meta resolve on: the root's own failure comes first).
        if (c.name !== 'B1 root resolve') expect(run.leasedAtMost, `${c.name}: it held leases`).toBeGreaterThan(0)
        expect(run.listeners(), `${c.name}: no change listener left`).toBe(0)
        expect(run.projectorLeases(), `${c.name}: no lease left`).toBe(0)
        // Witness (B4 on: the health beat was armed before the failure).
        if (c.stage === 'B4' || c.stage === 'B5') expect(run.armedTimers, `${c.name}: it armed timers`).toBeGreaterThan(0)
        expect([...run.liveTimers.values()].map((stack) => stack.split('\n').slice(2, 6).join(' | ')), `${c.name}: no timer left armed`).toEqual([])
        expect(hasSealedProductCacheWriter(WS), `${c.name}: no writer registered`).toBe(false)
        expect(await planeState(), c.name).toMatchObject({ write_fence: run.instance, projector_attached: false, fence_binding: fenceBefore })
        await nextAttachColdBuilds(ws, log, d, c.name)
      }
    } finally {
      log.restore()
    }
  }, 600_000)

  it('A6: release() — and stopAll() — while the attach is in B3: the fleet\'s start fails as an ownership loss, nothing is left attached, leased or bound to it, and the next ensure cold-builds exactly once; nothing is projected after the release', async () => {
    const log = logLines()
    try {
      const { ws, d } = await primedForAdopt(log)
      const baseUrl = ws.meta.doc()!.objectShardUrls[0]!
      for (const how of ['release', 'stopAll'] as const) {
        const fenceBefore = (await planeState()).write_fence
        const repo = storageRepo()
        const found = new Set<DocHandle<unknown>>()
        let claimed = false
        let released = false
        let metadataAfterRelease = 0
        let servingAtRelease: [boolean, boolean] | null = null
        let servingAfterRelease: boolean | null = null
        const pool = poolBeforeQuery((text) => {
          if (text.includes('projector_attached = false') && text.includes('projector_instance_id = $3')) claimed = true
          if (released && text.includes('UNION SELECT object_id FROM ro_group_objects')) metadataAfterRelease += 1
        })
        // eslint-disable-next-line prefer-const -- assigned once, after the proxy that calls it is built
        let fleet!: ProjectorFleet
        // `release` lands at the base shard's WATCHER resolve (its second
        // find, B3's watcher loop: only the check after it stands between it
        // and the ModelMeta pass), `stopAll` at its SEED resolve (the first).
        const landsAt = how === 'release' ? 2 : 1
        let baseFinds = 0
        const proxied = new Proxy(repo, {
          get(target, prop) {
            if (prop === 'find') {
              return async (url: AutomergeUrl, ...rest: unknown[]) => {
                if (claimed && String(url) === baseUrl) baseFinds += 1
                if (claimed && !released && String(url) === baseUrl && baseFinds === landsAt) {
                  released = true
                  // C6-2b: B3 is inside the serving window.
                  servingAtRelease = [fleet.isServing(WS), fleet.isResident(WS)]
                  if (how === 'release') fleet.release(WS, 'test')
                  else fleet.stopAll()
                  servingAfterRelease = fleet.isServing(WS)
                }
                const handle = await ((target.find as (...a: unknown[]) => unknown).call(target, url, ...rest) as Promise<DocHandle<unknown>>)
                found.add(handle)
                return handle
              }
            }
            const value = Reflect.get(target, prop, target) as unknown
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
          },
        }) as Repo
        const residency = new AutomergeResidencyLeases(repo)
        const projectorLeases = () => {
          let n = 0
          for (const lease of (residency as unknown as { leases: Map<string, { owners: Map<string, unknown> }> }).leases.values()) {
            for (const owner of lease.owners.keys()) if (owner.startsWith('projector:')) n += 1
          }
          return n
        }
        fleet = new ProjectorFleet(proxied, async () => ws.rootUrl, {
          fallbackRootUrl: ws.rootUrl, db: pool, residency, ordinaryHeadRotation: config(), adopt: 'on',
        })
        // C6-2b: a plain ensure resolves at SERVING (before B3); the attach's
        // own outcome is `until: 'attached'`.
        const servedAt = fleet.ensure(WS)
        const ensured = fleet.ensure(WS, { until: 'attached' })
        expect(await servedAt, `${how}: served before B3`).toBe(true)
        await expect(ensured, how).rejects.toThrow(how === 'release' ? ProjectorOwnershipError : ColdBuildAdmissionStoppedError)
        expect(released, `${how} landed in B3`).toBe(true)
        expect(servingAtRelease, `${how}: serving and not resident in B3`).toEqual([true, false])
        expect(servingAfterRelease, `${how} ends serving at once`).toBe(false)
        expect(fleet.isServing(WS)).toBe(false)
        if (how === 'release') expect(fleet.snapshot().ownershipRejectedStarts, 'counted as an ownership loss').toBe(1)
        await settle(1_500)
        expect([...found].reduce((sum, handle) => sum + handle.listenerCount('change'), 0), how).toBe(0)
        expect(projectorLeases(), how).toBe(0)
        expect(fleet.isResident(WS)).toBe(false)
        expect(metadataAfterRelease, `${how}: no ModelMeta pass ran after it`).toBe(0)
        const state = await planeState()
        expect(state.projector_attached, how).toBe(false)
        expect(state.fence_binding, how).toBe(fenceBefore)
        fleet.stopAll()
        await nextAttachColdBuilds(ws, log, d, how)
      }
    } finally {
      log.restore()
    }
  }, 600_000)

  it('A7: two fleets adopt the same workspace at once — exactly one attaches; the other gets ProjectorOwnershipError, and its instance is nowhere in the fence, the row or the binding', async () => {
    const log = logLines()
    const fleets: ProjectorFleet[] = []
    try {
      const { ws, d } = await primedForAdopt(log)
      const ids: string[][] = [[], []]
      for (const at of [0, 1]) {
        const repo = storageRepo()
        fleets.push(new ProjectorFleet(repo, async () => ws.rootUrl, {
          fallbackRootUrl: ws.rootUrl, db: db.pool, residency: new AutomergeResidencyLeases(repo),
          ordinaryHeadRotation: config(), adopt: 'on',
          startProjector: ((...args: Parameters<typeof startReadModelProjector>) => {
            const onAttached = args[9]
            args[9] = (id: string) => { ids[at]!.push(id); onAttached?.(id) }
            return startReadModelProjector(...args)
          }) as typeof startReadModelProjector,
        }))
      }
      const outcomes = await Promise.allSettled(fleets.map((fleet) => fleet.ensure(WS, { until: 'attached' })))
      const won = outcomes.flatMap((outcome, at) => (outcome.status === 'fulfilled' ? [at] : []))
      expect(won, JSON.stringify(outcomes.map((o) => o.status === 'rejected' ? String(o.reason) : 'ok'))).toHaveLength(1)
      const winner = won[0]!
      const loser = 1 - winner
      expect((outcomes[loser] as PromiseRejectedResult).reason).toBeInstanceOf(ProjectorOwnershipError)
      const winnerId = fleets[winner]!.residentProjectorInstanceId(WS)
      const state = await planeState()
      expect(state).toMatchObject({ write_fence: winnerId, projector_instance_id: winnerId, fence_binding: winnerId, projector_attached: true })
      for (const id of ids[loser]!) expect([state.write_fence, state.projector_instance_id, state.fence_binding]).not.toContain(id)
      expect(ids[loser]!.length).toBeGreaterThan(0)
      expect(await roObjectRows()).toEqual(expectedRows(d))
      expect(log.events('read_model.adopt_verdict').filter((line) => line.verdict === 'claimed').length, 'one claim').toBeGreaterThanOrEqual(1)
    } finally {
      for (const fleet of fleets) fleet.stopAll()
      log.restore()
    }
  }, 300_000)

  it('A9: the claim connection lost its protocol marker: refused (protocol-marker), the bad connection destroyed, and a correct cold build on a fresh one in the same call', async () => {
    const log = logLines()
    let run: AttachRun | null = null
    const two = guardIdleClientErrors(new pg.Pool({ connectionString: connection!, max: 2, options: `-c search_path=${db.schema}` }), 'c62a-marker')
    try {
      const { ws, d } = await primedForAdopt(log)
      const pidOf = async (q: { query: pg.Pool['query'] }) => (await q.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      const a = await two.connect()
      const b = await two.connect()
      const poisoned = await pidOf(b)
      await b.query('DISCARD ALL')
      // The pool hands back the last released client first: the poisoned one.
      a.release()
      b.release()
      run = await attachOnce(ws, log, { pool: two as unknown as IsolatedSchemaDb['pool'] })
      expect(run.error, String(run.error)).toBeUndefined()
      expect(run.verdict).toMatchObject({ verdict: 'refused', reason: 'protocol-marker', stage: 'S1' })
      expect(run.builds).toBe(1)
      expect(await roObjectRows()).toEqual(expectedRows(d))
      expect(await until(async () => (await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [poisoned])).rows[0]!.n,
        (n) => n === 0, 5_000), 'the refused connection was destroyed').toBe(0)
    } finally {
      run?.stop?.()
      await settle(500)
      await two.end()
      log.restore()
    }
  }, 300_000)

  it('A10: write batches written while no owner ran are acknowledged by the adopter (projected); the ones acknowledged before stay acknowledged', async () => {
    const log = logLines()
    let p2: AttachRun | null = null
    try {
      const { ws, d } = await primedForAdopt(log)
      const acks = async () => (await db.pool.query<{ batch_id: string; status: string }>(
        'SELECT batch_id, status FROM read_model_overlay_batch_acks WHERE landscape_id = $1 AND version_id = $2 ORDER BY batch_id',
        [WS.landscapeId, WS.versionId])).rows
      await ownerless(async (writer) => {
        const head = await writer.find<ObjHead>(ws.meta.doc()!.editsObjectShardUrl as AutomergeUrl)
        head.change((doc) => {
          doc.objects.batched = { id: 'batched', name: 'batched', type: 'system', p: 'batched' }
          doc.writeBatchIds.push('batch-ownerless')
        })
      })
      d.written.set('batched', { id: 'batched', name: 'batched', type: 'system', p: 'batched' })
      const before = await acks()
      expect(before.map((row) => row.batch_id)).not.toContain('batch-ownerless')
      p2 = await attachOnce(ws, log)
      expect(p2.error, String(p2.error)).toBeUndefined()
      expect(p2.verdict).toMatchObject({ verdict: 'claimed' })
      expect(await roObjectRows()).toEqual(expectedRows(d))
      const after = await acks()
      expect(after).toContainEqual({ batch_id: 'batch-ownerless', status: 'projected' })
      for (const row of before) expect(after).toContainEqual(row)
    } finally {
      p2?.stop?.()
      log.restore()
    }
  }, 300_000)

  it('A12: a RETIRED head with a late write made while no owner ran is forwarded at attach; its seed is forwarded_heads ?? H_r, never its projected_heads (made foreign to its history here, so seeding there would fail the attach)', async () => {
    const log = logLines()
    let p2: AttachRun | null = null
    try {
      const { ws, d } = await primedForAdopt(log, { fold: false })
      const retired = (await db.pool.query<{ id: string }>(
        `SELECT document_id AS id FROM read_model_ordinary_head_retirements
          WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' AND status = 'retired' ORDER BY created_at LIMIT 1`,
        [WS.landscapeId, WS.versionId])).rows[0]?.id
      expect(retired, 'a retired head exists').toBeDefined()
      expect(ws.meta.doc()!.objectShardUrls).toContain(`automerge:${retired}`)
      // Its projected_heads: a head of ANOTHER document (the root's), as a stamp of other heads would leave.
      const rootHeads = A.getHeads((await ws.repo.find(ws.rootUrl as AutomergeUrl)).doc() as A.Doc<unknown>)
      const updated = await db.pool.query(`UPDATE read_model_document_watermarks SET projected_heads = $3
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $4`, [WS.landscapeId, WS.versionId, rootHeads, retired])
      expect(updated.rowCount, 'the retired head has a watermark row').toBe(1)
      await ownerless(async (writer) => {
        const head = await writer.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
        head.change((doc) => { doc.objects.straggler = { id: 'straggler', name: 'straggler', type: 'system', p: 'straggler' } })
      })
      d.written.set('straggler', { id: 'straggler', name: 'straggler', type: 'system', p: 'straggler' })
      p2 = await attachOnce(ws, log, { fold: false })
      expect(p2.error, String(p2.error)).toBeUndefined()
      expect(p2.verdict).toMatchObject({ verdict: 'claimed' })
      // Forwarded into the current head and served.
      expect(await roObjectRows()).toEqual(expectedRows(d))
      const current = await p2.repo.find<ObjHead>(ws.meta.doc()!.editsObjectShardUrl as AutomergeUrl)
      expect(Object.keys(current.doc()!.objects)).toContain('straggler')
    } finally {
      p2?.stop?.()
      log.restore()
    }
  }, 300_000)

  it('A13: a sealed fold product changed while no owner ran is DEGRADED, never applied (its new value never reaches the rows); a product with no watermark row is not applied whole either', async () => {
    const log = logLines()
    let p2: AttachRun | null = null
    try {
      const { ws, d } = await primedForAdopt(log)
      const product = parkedProducts(log)[0]!
      // Witness: a mid-session product has no watermark row.
      expect((await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM read_model_document_watermarks
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`, [WS.landscapeId, WS.versionId, product])).rows[0]!.n).toBe(0)
      const someId = (await db.pool.query<{ id: string }>(`SELECT entity_id AS id FROM read_model_sealed_product_entities
        WHERE landscape_id = $1 AND version_id = $2 AND product_document_id = $3 LIMIT 1`, [WS.landscapeId, WS.versionId, product])).rows[0]!.id
      await ownerless(async (writer) => {
        const handle = await writer.find<ObjHead>(`automerge:${product}` as AutomergeUrl)
        handle.change((doc) => {
          doc.objects[someId] = { id: someId, name: 'CHANGED', type: 'system', p: 'changed' }
          doc.objects.injected = { id: 'injected', name: 'injected', type: 'system', p: 'injected' }
        })
      })
      p2 = await attachOnce(ws, log)
      expect(p2.error, String(p2.error)).toBeUndefined()
      expect(p2.verdict).toMatchObject({ verdict: 'claimed' })
      expect(Number(p2.attachLine!.changedProducts)).toBe(1)
      expect(await roObjectRows(), 'the change is not projected').toEqual(expectedRows(d))
      const state = await planeState()
      expect(state.degraded_since, 'degraded').not.toBeNull()
      expect((await getWorkspaceProjectionFreshness(db.pool, WS)).status).toBe('degraded')
      expect(log.events('read_model.ordinary_sealed_product_changed').some((line) => line.reason === 'changed-while-ownerless')).toBe(true)
    } finally {
      p2?.stop?.()
      log.restore()
    }
  }, 300_000)

  it('A14: a cache header whose heads are not the product\'s H_r is a MISS before the winners statement, as is a pruned header — both products loaded in B2 with their values pinned, their extracts rewritten only after B5; the rows are right and nothing is degraded', async () => {
    const log = logLines()
    let p2: AttachRun | null = null
    try {
      const { ws, d } = await primedForAdopt(log, { products: 2 })
      const [wrongHeads, pruned] = parkedProducts(log)
      expect(pruned).toBeDefined()
      const otherHeads = A.getHeads((await ws.repo.find(ws.rootUrl as AutomergeUrl)).doc() as A.Doc<unknown>)
      await db.pool.query(`UPDATE read_model_sealed_product_extracts SET heads = $4
        WHERE landscape_id = $1 AND version_id = $2 AND product_document_id = $3`, [WS.landscapeId, WS.versionId, wrongHeads, otherHeads])
      await db.pool.query(`DELETE FROM read_model_sealed_product_extracts WHERE landscape_id = $1 AND version_id = $2 AND product_document_id = $3`,
        [WS.landscapeId, WS.versionId, pruned])
      const headerHeads = async (id: string) => (await db.pool.query<{ heads: string[] }>(`SELECT heads FROM read_model_sealed_product_extracts
        WHERE landscape_id = $1 AND version_id = $2 AND product_document_id = $3`, [WS.landscapeId, WS.versionId, id])).rows[0]?.heads ?? null
      let atB5: { wrong: string[] | null; pruned: string[] | null } | null = null
      const pool = poolBeforeQuery(async (text) => {
        if (atB5 === null && text.includes('UPDATE read_model_adopt_state SET fence_binding')) {
          atB5 = { wrong: await headerHeads(wrongHeads!), pruned: await headerHeads(pruned!) }
        }
      })
      p2 = await attachOnce(ws, log, { pool })
      expect(p2.error, String(p2.error)).toBeUndefined()
      expect(p2.verdict).toMatchObject({ verdict: 'claimed' })
      expect(p2.attachLine).toMatchObject({ cacheHeadsRefused: 1, productsLoaded: 2, changedProducts: 0 })
      expect(heldSealedValues(WS, `automerge:${wrongHeads}`), 'values pinned').toBeGreaterThan(0)
      expect(heldSealedValues(WS, `automerge:${pruned}`), 'values pinned').toBeGreaterThan(0)
      // Not rewritten before B5 (the writer is held until the attach is done)...
      expect(atB5).toEqual({ wrong: otherHeads, pruned: null })
      // ...and rewritten after it, at H_r.
      await awaitSealedProductCacheWrites(WS)
      expect(await until(() => headerHeads(pruned!), (heads) => heads !== null, 15_000)).not.toBeNull()
      expect(await headerHeads(wrongHeads!)).not.toEqual(otherHeads)
      expect(await roObjectRows()).toEqual(expectedRows(d))
      await settle(1_500)
      expect((await planeState()).degraded_since, 'nothing degraded (the parked heads are H_r)').toBeNull()
    } finally {
      p2?.stop?.()
      log.restore()
    }
  }, 300_000)

  it('A19: a shard appended to ModelMeta while no owner ran: B1 fails (topology-moved), and the next attach cold-builds exactly once with the appended shard\'s rows; a FLEET does that cold build in the same ensure', async () => {
    const log = logLines()
    let fleet: ProjectorFleet | null = null
    try {
      const { ws, d } = await primedForAdopt(log)
      await ownerless(async (writer) => {
        const extra = writer.create<{ objects: Record<string, Entity> }>({ objects: { appended: { id: 'appended', name: 'appended', type: 'system' } } })
        await extra.whenReady()
        await db.pool.query('INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [String(extra.documentId), WS.landscapeId, WS.versionId])
        const meta = await writer.find<Meta>(ws.meta.url)
        meta.change((doc) => { doc.objectShardUrls.push(extra.url) })
      })
      d.written.set('appended', { id: 'appended', name: 'appended', type: 'system' })
      const fenceBefore = (await planeState()).write_fence
      const failed = await attachOnce(ws, log)
      expect(failed.error).toBeInstanceOf(ReadModelAdoptAttachError)
      expect(failed.error).toMatchObject({ stage: 'B1', reason: 'topology-moved' })
      expect(await planeState()).toMatchObject({ write_fence: failed.instance, fence_binding: fenceBefore, projector_attached: false })
      await nextAttachColdBuilds(ws, log, d, 'A19')
      // The fleet, on the same shape (another ownerless append).
      await ownerless(async (writer) => {
        const extra = writer.create<{ objects: Record<string, Entity> }>({ objects: { appended2: { id: 'appended2', name: 'appended2', type: 'system' } } })
        await extra.whenReady()
        await db.pool.query('INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [String(extra.documentId), WS.landscapeId, WS.versionId])
        const meta = await writer.find<Meta>(ws.meta.url)
        meta.change((doc) => { doc.objectShardUrls.push(extra.url) })
      })
      d.written.set('appended2', { id: 'appended2', name: 'appended2', type: 'system' })
      const builds = log.events('read_model.cold_build_phases').length
      const repo = storageRepo()
      fleet = new ProjectorFleet(repo, async () => ws.rootUrl, {
        fallbackRootUrl: ws.rootUrl, db: db.pool, residency: new AutomergeResidencyLeases(repo), ordinaryHeadRotation: config(), adopt: 'on',
      })
      // C6-2b: the fallback cold build is the background continuation of the
      // same start; `until: 'attached'` is its end.
      expect(await fleet.ensure(WS, { until: 'attached' })).toBe(true)
      expect(log.events('read_model.adopt_attach_failed').at(-1)).toMatchObject({ stage: 'B1', reason: 'topology-moved' })
      expect(log.events('read_model.cold_build_phases').length - builds, 'one cold build, in the same ensure').toBe(1)
      expect(await roObjectRows()).toEqual(expectedRows(d))
    } finally {
      fleet?.stopAll()
      log.restore()
    }
  }, 300_000)

  it('A20: a seed head ABSENT from the shard\'s history fails B3 (seed-heads-unknown) — never an empty seed that would keep stale rows', async () => {
    const log = logLines()
    try {
      const { ws, d } = await primedForAdopt(log)
      const base = ws.meta.doc()!.objectShardUrls[0]!
      const rootHeads = A.getHeads((await ws.repo.find(ws.rootUrl as AutomergeUrl)).doc() as A.Doc<unknown>)
      const updated = await db.pool.query(`UPDATE read_model_document_watermarks SET projected_heads = $3
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $4`, [WS.landscapeId, WS.versionId, rootHeads, docId(base)])
      expect(updated.rowCount).toBe(1)
      // An ownerless delete the empty seed would never apply.
      await ownerless(async (writer) => {
        const handle = await writer.find<{ objects: Record<string, Entity> }>(base as AutomergeUrl)
        handle.change((doc) => { delete doc.objects.b })
      })
      d.written.delete('b')
      const fenceBefore = (await planeState()).write_fence
      const failed = await attachOnce(ws, log)
      expect(failed.error).toBeInstanceOf(ReadModelAdoptAttachError)
      expect(failed.error).toMatchObject({ stage: 'B3', reason: 'seed-heads-unknown' })
      expect(await planeState()).toMatchObject({ fence_binding: fenceBefore, projector_attached: false })
      await nextAttachColdBuilds(ws, log, d, 'A20')
    } finally {
      log.restore()
    }
  }, 300_000)

  it('ownership lost WITHOUT an abort (stillOwned flips, no signal) during B3\'s watcher loop: the check after the watcher fails the attach as aborted, and no ModelMeta pass runs after it', async () => {
    const log = logLines()
    try {
      const { ws, d } = await primedForAdopt(log)
      const baseUrl = ws.meta.doc()!.objectShardUrls[0]!
      let owned = true
      let claimed = false
      let metadataAfter = 0
      const pool = poolBeforeQuery((text) => {
        if (text.includes('projector_attached = false') && text.includes('projector_instance_id = $3')) claimed = true
        if (!owned && text.includes('UNION SELECT object_id FROM ro_group_objects')) metadataAfter += 1
      })
      const run = await attachOnce(ws, log, {
        pool, stillOwned: () => owned,
        // The base shard's WATCHER resolve (its second find): the find itself
        // completes (nothing aborts it), the ownership is gone after it.
        beforeFind: (url, nth) => { if (claimed && url === baseUrl && nth === 2) queueMicrotask(() => { owned = false }) },
      })
      expect(owned).toBe(false)
      expect(run.error).toBeInstanceOf(ReadModelAdoptAttachError)
      expect(run.error).toMatchObject({ stage: 'B3', reason: 'aborted' })
      expect(metadataAfter, 'no ModelMeta pass after the loss').toBe(0)
      await settle(1_000)
      expect(run.listeners()).toBe(0)
      expect(run.projectorLeases()).toBe(0)
      await nextAttachColdBuilds(ws, log, d, 'stillOwned in B3')
    } finally {
      log.restore()
    }
  }, 300_000)

  it('the claim abandons a release that lands during its checks (stillOwned before the CAS): an ownership loss, the fence NOT moved', async () => {
    const log = logLines()
    try {
      const { ws, d } = await primedForAdopt(log)
      const before = await planeState()
      let owned = true
      const pool = poolBeforeQuery((text) => { if (text.includes('WITH ORDINALITY AS l(id, ord)')) owned = false })
      const run = await attachOnce(ws, log, { pool, stillOwned: () => owned })
      expect(owned, 'the release landed at S5').toBe(false)
      expect(String(run.error)).toMatch(/write fence lost/)
      expect(run.builds).toBe(0)
      expect(await planeState()).toMatchObject({ write_fence: before.write_fence, fence_binding: before.fence_binding })
      // Untouched: the corpus is still adoptable by the next attach.
      const next = await attachOnce(ws, log)
      try {
        expect(next.verdict).toMatchObject({ verdict: 'claimed' })
        expect(await roObjectRows()).toEqual(expectedRows(d))
      } finally {
        next.stop?.()
      }
    } finally {
      log.restore()
    }
  }, 300_000)

  it('a boot GAP PASS that fails (its coalescer swallows the error) fails the attach at B4 (gap-failed) — B5 never certifies rows missing the ownerless writes — and the next attach cold-builds them', async () => {
    const log = logLines()
    try {
      const { ws, d } = await primedForAdopt(log)
      await ownerless(async (writer) => {
        const head = await writer.find<ObjHead>(ws.meta.doc()!.editsObjectShardUrl as AutomergeUrl)
        head.change((doc) => { doc.objects.gapped = { id: 'gapped', name: 'gapped', type: 'system', p: 'gapped' } })
      })
      d.written.set('gapped', { id: 'gapped', name: 'gapped', type: 'system', p: 'gapped' })
      const fenceBefore = (await planeState()).write_fence
      let claimed = false
      let failed = false
      const pool = poolBeforeQuery((text) => {
        if (text.includes('projector_attached = false') && text.includes('projector_instance_id = $3')) claimed = true
        // The gap pass's durable-proof read, the first after the claim.
        if (claimed && !failed && text.includes('AS documents(document_id)')) {
          failed = true
          throw Object.assign(new Error('test: the gap pass fails'), { code: 'XX001' })
        }
      })
      const run = await attachOnce(ws, log, { pool })
      expect(failed, 'the gap pass failed').toBe(true)
      expect(run.error).toBeInstanceOf(ReadModelAdoptAttachError)
      expect(run.error).toMatchObject({ stage: 'B4' })
      expect(String((run.error as Error).message)).toMatch(/gap-failed/)
      expect(await planeState()).toMatchObject({ projector_attached: false, fence_binding: fenceBefore })
      await settle(500)
      await nextAttachColdBuilds(ws, log, d, 'gap-failed')
    } finally {
      log.restore()
    }
  }, 300_000)

  it('a listed shard with NO row of any kind (its watermark lost: a crash between a ModelMeta pass and the shard\'s initial apply) is attached with its initial apply — its ownerless content reaches the rows', async () => {
    const log = logLines()
    let p2: AttachRun | null = null
    try {
      const { ws, d } = await primedForAdopt(log)
      const base = ws.meta.doc()!.objectShardUrls[0]!
      expect((await db.pool.query(`DELETE FROM read_model_document_watermarks WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
        [WS.landscapeId, WS.versionId, docId(base)])).rowCount).toBe(1)
      await ownerless(async (writer) => {
        const handle = await writer.find<{ objects: Record<string, Entity> }>(base as AutomergeUrl)
        handle.change((doc) => { doc.objects.fresh = { id: 'fresh', name: 'fresh', type: 'system' } })
      })
      d.written.set('fresh', { id: 'fresh', name: 'fresh', type: 'system' })
      p2 = await attachOnce(ws, log)
      expect(p2.error, String(p2.error)).toBeUndefined()
      expect(p2.verdict).toMatchObject({ verdict: 'claimed' })
      expect(p2.attachLine).toMatchObject({ newShards: 1 })
      expect(await roObjectRows()).toEqual(expectedRows(d))
    } finally {
      p2?.stop?.()
      log.restore()
    }
  }, 300_000)

  it('a claim whose COMMIT fails after S6 ran throws AdoptClaimOutcomeUnknownError (never a verdict, never a cold build over it); here it rolled back, so the next attach adopts', async () => {
    const log = logLines()
    try {
      const { ws, d } = await primedForAdopt(log)
      const before = await planeState()
      let s6 = false
      let failedCommit = false
      const pool = poolBeforeQuery((text) => {
        if (text.includes('projector_attached = false') && text.includes('projector_instance_id = $3')) s6 = true
        else if (s6 && !failedCommit && text.trim() === 'COMMIT') {
          failedCommit = true
          throw Object.assign(new Error('test: the commit acknowledgement is lost'), { code: '08006' })
        }
      })
      const run = await attachOnce(ws, log, { pool })
      expect(failedCommit).toBe(true)
      expect(run.error).toBeInstanceOf(AdoptClaimOutcomeUnknownError)
      expect(run.builds).toBe(0)
      expect(await planeState()).toMatchObject({ write_fence: before.write_fence, fence_binding: before.fence_binding })
      const next = await attachOnce(ws, log)
      try {
        expect(next.verdict).toMatchObject({ verdict: 'claimed' })
        expect(await roObjectRows()).toEqual(expectedRows(d))
      } finally {
        next.stop?.()
      }
    } finally {
      log.restore()
    }
  }, 300_000)

  it('B4 awaits the ModelMeta pass: a group added while no owner ran is in ro_groups when the attach resolves', async () => {
    const log = logLines()
    let p2: AttachRun | null = null
    try {
      const { ws } = await primedForAdopt(log)
      await ownerless(async (writer) => {
        const meta = await writer.find<Meta>(ws.meta.url)
        meta.change((doc) => { doc.groups.g2 = { id: 'g2', name: 'G2', objectIds: ['late'] } })
      })
      // The ModelMeta pass is SUSPENDED (1.5 s, inside its transaction): an
      // attach that did not await it would resolve before its rows.
      let suspended = false
      const pool = poolBeforeQuery(async (text) => {
        if (!suspended && text.includes('UNION SELECT object_id FROM ro_group_objects')) {
          suspended = true
          await settle(1_500)
        }
      })
      p2 = await attachOnce(ws, log, { pool })
      expect(suspended).toBe(true)
      expect(p2.error, String(p2.error)).toBeUndefined()
      expect(p2.verdict).toMatchObject({ verdict: 'claimed' })
      expect(await roGroupIds()).toEqual(['g1', 'g2'])
    } finally {
      p2?.stop?.()
      log.restore()
    }
  }, 300_000)

  // ========================================================== C6-2b: EARLY SERVING

  it('C6-2b onServing: fired after the claim COMMITTED (not at S6, not before its COMMIT) and before B1\'s first statement; the committed fence is ours when it fires', async () => {
    const log = logLines()
    let p2: AttachRun | null = null
    try {
      const { ws } = await primedForAdopt(log)
      let served = false
      let s6Seen = false
      const at: Record<string, boolean | null> = { s6: null, commit: null, b1: null }
      let fenceAtServing: Promise<string> | null = null
      const pool = poolBeforeQuery((text) => {
        if (!s6Seen && text.includes('projector_attached = false') && text.includes('projector_instance_id = $3')) {
          s6Seen = true
          at.s6 = served
        } else if (s6Seen && at.commit === null && text.trim() === 'COMMIT') {
          at.commit = served
        }
        if (at.b1 === null && text.includes('SELECT collection, document_id, retirement_heads, forwarded_heads, status, folded_into')) at.b1 = served
      })
      p2 = await attachOnce(ws, log, {
        pool,
        onServing: () => {
          served = true
          fenceAtServing = fenceNow()
        },
      })
      expect(p2.error, String(p2.error)).toBeUndefined()
      expect(p2.verdict).toMatchObject({ verdict: 'claimed' })
      expect(at, 'serving: after the COMMIT, before B1').toEqual({ s6: false, commit: false, b1: true })
      expect(await fenceAtServing!, 'the fence, read from another connection, is already ours').toBe(p2.instance)
      expect(log.events('read_model.adopt_serving'), 'one serving line').toHaveLength(1)
      // A COLD build never fires it.
      p2.stop?.()
      p2.stop = null
      await p2.repo.flush()
      await settle(300)
      let coldServed = false
      const cold = await attachOnce(ws, log, { mode: 'off', onServing: () => { coldServed = true } })
      expect(cold.error).toBeUndefined()
      expect(coldServed, 'a cold build is never serving early').toBe(false)
      cold.stop?.()
    } finally {
      p2?.stop?.()
      log.restore()
    }
  }, 300_000)

  it('A17 (C6-2b, real fleet): ensure resolves at SERVING with the attach still in B3; in the window isServing and not isResident, the read route serves the kept rows with freshness REFUSED (durability witness idle, no caughtUp, no absence proof), divergence and compaction see nothing resident; after B5 resident and fresh', async () => {
    const log = logLines()
    let fleet: ProjectorFleet | null = null
    try {
      const { ws, d } = await primedForAdopt(log)
      const baseUrl = ws.meta.doc()!.objectShardUrls[0]!
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      let held = false
      const t = takeoverFleet(ws, {
        beforeFind: async (url) => {
          // B3's seed resolve of the base shard (the first find of it).
          if (!held && url === baseUrl) {
            held = true
            await gate
          }
        },
      })
      fleet = t.fleet
      const buildsBefore = log.events('read_model.cold_build_phases').length
      expect(await fleet.ensure(WS)).toBe(true)
      expect(await until(() => held, Boolean, 20_000), 'the attach is held in B3').toBe(true)
      // The window.
      expect(fleet.isServing(WS)).toBe(true)
      expect(fleet.isResident(WS)).toBe(false)
      expect(readRouteServes(fleet, WS), 'the read route answers').toBe(true)
      expect(divergenceEligible(fleet, WS), 'divergence: not resident').toBe(false)
      expect(compactionFleet(fleet).isResident(WS), 'compaction: not resident').toBe(false)
      expect(fleet.residentProjectorInstanceId(WS)).toBeNull()
      const adopter = t.instances[0]!
      expect(await planeState()).toMatchObject({ write_fence: adopter, projector_attached: false })
      const witness = await durabilityWitnessPayload(db.pool, WS, ['late', 'b'], ['c2'])
      expect(witness, 'served, freshness refused').toMatchObject({ status: 'idle', caughtUp: false, absenceProvable: false })
      expect(Object.keys(witness.objects).sort(), 'the kept rows are served').toEqual(['b', 'late'])
      expect(Object.keys(witness.connections)).toEqual(['c2'])
      expect(await roObjectRows(), 'the whole kept object plane').toEqual(expectedRows(d))
      // Compaction's ensure waits for the attach.
      let compactionDone = false
      const compaction = compactionFleet(fleet).ensure(WS, { adopt: false }).then((v) => { compactionDone = true; return v })
      await settle(300)
      expect(compactionDone, 'compaction\'s ensure is still waiting').toBe(false)
      release()
      expect(await compaction).toBe(true)
      expect(fleet.isResident(WS)).toBe(true)
      expect(log.events('read_model.cold_build_phases').length - buildsBefore, 'adopted, not rebuilt').toBe(0)
      const fresh = await until(() => getWorkspaceProjectionFreshness(db.pool, WS), (f) => f.absenceProvable, 20_000)
      expect(fresh).toMatchObject({ status: 'healthy', caughtUp: true, absenceProvable: true })
    } finally {
      fleet?.stopAll()
      log.restore()
    }
  }, 300_000)

  it('A18 (C6-2b): a restarted process\'s BOOT readiness (ensureServedForReadiness) turns true at serving, before B5 — measured against the full attach on this corpus', async () => {
    const log = logLines()
    let fleet: ProjectorFleet | null = null
    try {
      const { ws } = await primedForAdopt(log, { products: 1, keepAlive: false })
      // B4's ModelMeta pass held 1.5 s inside its transaction: B5 cannot have
      // run when readiness is observed.
      let suspended = false
      const pool = poolBeforeQuery(async (text) => {
        if (!suspended && text.includes('UNION SELECT object_id FROM ro_group_objects')) {
          suspended = true
          await settle(1_500)
        }
      })
      const t = takeoverFleet(ws, { pool })
      fleet = t.fleet
      const t0 = performance.now()
      let atReady: { ms: number; resident: boolean; serving: boolean } | null = null
      const ready = ensureServedForReadiness(fleet, WS).then((ok) => {
        atReady = { ms: performance.now() - t0, resident: fleet!.isResident(WS), serving: fleet!.isServing(WS) }
        return ok
      })
      const attached = fleet.ensure(WS, { until: 'attached' }).then((ok) => ({ ok, ms: performance.now() - t0 }))
      expect(await ready).toBe(true)
      const stateAtReady = await planeState()
      const done = await attached
      expect(done.ok).toBe(true)
      expect(atReady!.resident, 'not resident at readiness').toBe(false)
      expect(atReady!.serving).toBe(true)
      expect(stateAtReady, 'B5 has not run at readiness').toMatchObject({ projector_attached: false, write_fence: t.instances[0] })
      expect(suspended).toBe(true)
      expect(atReady!.ms).toBeLessThan(done.ms)
      expect(await planeState()).toMatchObject({ projector_attached: true, fence_binding: t.instances[0] })
      const serving = log.events('read_model.adopt_serving').at(-1)
      const attachLine = log.events('read_model.adopt_attach').at(-1)
      const measure = {
        test: 'A18', servedMs: Math.round(atReady!.ms), attachedMs: Math.round(done.ms),
        servingLineMs: serving?.ms ?? null, verifyMs: serving?.verifyMs ?? null, attachTotalMs: attachLine?.totalMs ?? null,
        note: 'tiny synthetic corpus; B4 ModelMeta pass held 1500 ms by the test',
      }
      if (process.env.C62B_MEASURE_OUT) appendFileSync(process.env.C62B_MEASURE_OUT, `${JSON.stringify(measure)}\n`)
    } finally {
      fleet?.stopAll()
      log.restore()
    }
  }, 300_000)

  it('A5/A6 in the WINDOW (C6-2b, real fleet): a throw at each await of the background attach AFTER serving keeps the kept rows served through the background fallback, never lets the abandoned adopt\'s rows read as fresh, leaves no lease of the adopter, and the background fallback cold build brings the workspace to resident with the right rows', async () => {
    const log = logLines()
    try {
      const { ws, d } = await primedForAdopt(log)
      const cases = (await backgroundFaultCases(ws)).filter((c) => !c.succeeds)
      for (const c of cases) {
        let claimed = false
        let injected = false
        const fault = () => { injected = true; return new Error(`test: ${c.name} fails`) }
        const pool = poolBeforeQuery((text) => {
          if (text.includes('projector_attached = false') && text.includes('projector_instance_id = $3')) claimed = true
          if (claimed && !injected && c.sql && text.includes(c.sql)) throw fault()
        })
        if (c.name.startsWith('B2 a miss')) {
          await db.pool.query('DELETE FROM read_model_sealed_product_extracts WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId])
        }
        const t = takeoverFleet(ws, {
          pool,
          beforeFind: (url, nth) => { if (claimed && !injected && c.find?.(url, nth)) throw fault() },
        })
        const builds = log.events('read_model.cold_build_phases').length
        try {
          expect(await t.fleet.ensure(WS), `${c.name}: served`).toBe(true)
          // Sample until resident: freshness is never claimed while the row
          // names the ADOPTER (sampled before AND after the freshness read).
          const samples: Array<{ serving: boolean; resident: boolean; adopterBoth: boolean; caughtUp: boolean }> = []
          const deadline = Date.now() + 60_000
          while (!t.fleet.isResident(WS) && Date.now() < deadline) {
            const before = await planeState()
            const serving = t.fleet.isServing(WS)
            const resident = t.fleet.isResident(WS)
            const f = await getWorkspaceProjectionFreshness(db.pool, WS)
            const after = await planeState()
            const adopter = t.instances[0]
            samples.push({
              serving, resident, caughtUp: f.caughtUp,
              adopterBoth: before.projector_instance_id === adopter && after.projector_instance_id === adopter,
            })
          }
          expect(injected, `${c.name}: the fault was reached`).toBe(true)
          expect(t.fleet.isResident(WS), `${c.name}: resident after the fallback`).toBe(true)
          expect(samples.filter((s) => s.adopterBoth && s.caughtUp), `${c.name}: never fresh under the adopter`).toEqual([])
          expect(samples.length, `${c.name}: the window was sampled`).toBeGreaterThan(0)
          expect(samples.filter((s) => !s.serving && !s.resident), `${c.name}: served throughout (the fallback keeps serving the kept rows)`).toEqual([])
          expect(t.instances.length, `${c.name}: the adopter, then the fallback`).toBe(2)
          expect(log.events('read_model.adopt_attach_failed').at(-1), c.name).toMatchObject({ stage: c.stage })
          expect(log.events('read_model.cold_build_phases').length - builds, `${c.name}: one cold build`).toBe(1)
          expect(await t.fleet.ensure(WS, { until: 'attached' })).toBe(true)
          expect(t.leasesOf(t.instances[0]!), `${c.name}: no lease of the adopter`).toBe(0)
          expect(await roObjectRows(), c.name).toEqual(expectedRows(d))
          expect(await planeState(), c.name).toMatchObject({ write_fence: t.instances[1], projector_attached: true, fence_binding: t.instances[1] })
        } finally {
          t.fleet.stopAll()
          await t.repo.flush()
          await settle(300)
        }
      }
    } finally {
      log.restore()
    }
  }, 900_000)

  it('C6-2b admitBuild (real projector): with the one cold-build slot held elsewhere, the claim still commits and SERVES, and B1 does not start until the slot is free; a release while queued for it is an ownership loss with no fallback and no lease', async () => {
    const log = logLines()
    try {
      const { ws, d } = await primedForAdopt(log)
      const b1Sql = 'SELECT collection, document_id, retirement_heads, forwarded_heads, status, folded_into'
      for (const how of ['free', 'release'] as const) {
        const cold = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 0 })
        let freeSlot: () => void = () => {}
        const blocker = cold.run(() => new Promise<void>((resolve) => { freeSlot = resolve }))
        let b1Started = false
        const pool = poolBeforeQuery((text) => { if (text.includes(b1Sql)) b1Started = true })
        const t = takeoverFleet(ws, { pool, coldBuildAdmission: cold })
        const failedBefore = log.events('read_model.adopt_attach_failed').length
        const buildsBefore = log.events('read_model.cold_build_phases').length
        try {
          expect(await t.fleet.ensure(WS), `${how}: served with no build slot`).toBe(true)
          const attached = t.fleet.ensure(WS, { until: 'attached' })
          await settle(500)
          expect(b1Started, `${how}: B1 waits for the build slot`).toBe(false)
          expect(cold.snapshot(), `${how}: queued past maxQueued 0`).toMatchObject({ active: 1, queued: 1 })
          expect(t.fleet.isServing(WS)).toBe(true)
          if (how === 'free') {
            freeSlot()
            expect(await attached).toBe(true)
            expect(b1Started).toBe(true)
            expect(log.events('read_model.cold_build_phases').length - buildsBefore, 'adopted').toBe(0)
            expect(await roObjectRows()).toEqual(expectedRows(d))
          } else {
            t.fleet.release(WS, 'test')
            await expect(attached).rejects.toThrow(ProjectorOwnershipError)
            expect(cold.snapshot(), 'the abandoned wait left the queue').toMatchObject({ queued: 0 })
            expect(b1Started).toBe(false)
            expect(t.instances, 'no fallback start').toHaveLength(1)
            expect(log.events('read_model.adopt_attach_failed').length - failedBefore, 'not an adopt failure').toBe(0)
            expect(t.leasesOf(t.instances[0]!)).toBe(0)
            freeSlot()
            await nextAttachColdBuilds(ws, log, d, 'released while queued for the build slot')
          }
        } finally {
          freeSlot()
          await blocker
          t.fleet.stopAll()
          await t.repo.flush()
          await settle(300)
        }
      }
    } finally {
      log.restore()
    }
  }, 300_000)

  it('C6-2b a THROWING onServing hook is logged and ignored: the attach still adopts', async () => {
    const log = logLines()
    let p2: AttachRun | null = null
    try {
      const { ws, d } = await primedForAdopt(log)
      let called = 0
      p2 = await attachOnce(ws, log, { onServing: () => { called += 1; throw new Error('test: hook threw') } })
      expect(called).toBe(1)
      expect(p2.error, String(p2.error)).toBeUndefined()
      expect(p2.attachLine, 'adopted to B5').toBeDefined()
      expect(await roObjectRows()).toEqual(expectedRows(d))
    } finally {
      p2?.stop?.()
      log.restore()
    }
  }, 300_000)
})
