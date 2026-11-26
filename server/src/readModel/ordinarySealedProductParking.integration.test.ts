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
import { createHash } from 'node:crypto'
import { Repo, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import { cachedHandles } from '../automergeRepoCompat.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { ensureReadModelSchema } from './schema.js'
import { awaitSealedProductCacheWrites, hasInitialDiagramProbe, hasSealedProductCacheWriter, startReadModelProjector } from './projectorService.js'
import { ordinaryRotationTelemetry } from './ordinaryRotationTelemetry.js'
import { durableHeadsDecoder } from './durableHeadsDecoder.js'
import type { OrdinaryHeadRotationConfig } from './ordinaryHeadRotation.js'
import { documentLoadCount } from './documentLoadTelemetry.js'
import { durableHeadsMemo } from './durableHeadsMemo.js'
import type { WorkspaceKey } from './projector.js'

/**
 * G4-16f: SEALED fold products are PARKED — read once, indexed, given back —
 * with the real projector's own rotations and folds, real residency leases,
 * a real Repo over the PostgreSQL storage adapter, a real schema.
 *
 * The measured defect: every sealed product (a fold marker and at least the
 * seal ceiling of entities) stayed leased and resident for the projector's
 * life, and a cold build resolved every shard before reading any, so the
 * wasm heap after a cold attach grew with the corpus' age. The seal is
 * injected small here (`chainFold.segmentCeiling`): each fold of two heads
 * of three entities seals at five.
 *
 * Each test below says what makes it RED on the base (no parking): there,
 * no `read_model.ordinary_sealed_product_parked` line is ever logged and
 * every product stays leased.
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-osp', versionId: 'v1' }
const LISTED = `${WS.landscapeId}/${WS.versionId}`
/** Changes per head: its creating change plus three entities. */
const THRESHOLD = 4
/** Two heads of three entities fold into six: sealed. */
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
  registry: DocHandle<{ diagrams: Record<string, unknown>; touched?: number }>
}

async function workspace(repo: Repo): Promise<Workspace> {
  const base = repo.create<{ objects: Record<string, Entity> }>({ objects: { b: { id: 'b', name: 'B', type: 'system' } } })
  const head = repo.create<ObjHead>({ objects: {}, writeBatchIds: [] })
  const connHead = repo.create({ connections: {}, writeBatchIds: [] })
  const meta = repo.create<Meta>({
    objectShardUrls: [base.url, head.url],
    connectionShardUrls: [connHead.url],
    editsObjectShardUrl: head.url,
    editsObjectShardUrls: [head.url],
    editsConnectionShardUrl: connHead.url,
    editsConnectionShardUrls: [connHead.url],
    groups: {},
  })
  const registry = repo.create<{ diagrams: Record<string, unknown>; touched?: number }>({ diagrams: {} })
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
  return { repo, rootUrl: root.url, meta, registry }
}

function config(): OrdinaryHeadRotationConfig {
  return {
    mode: 'on', allowlist: new Set([LISTED]), maxActors: 1_000_000, maxChanges: THRESHOLD,
    deferral: { quietMs: 0, maxMs: 0 },
    chainFold: { minChain: 2, budget: 2, retainMs: 86_400_000, segmentCeiling: CEILING, windowEntities: 4 * CEILING },
  }
}

function start(repo: Repo, rootUrl: string, residency: AutomergeResidencyLeases, pool: IsolatedSchemaDb['pool'] = db.pool) {
  return startReadModelProjector(repo, rootUrl, pool, WS, residency, 0, undefined, undefined, undefined, undefined, config())
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
 * from `connect()`) and its parameters BEFORE it runs: it may hold or throw.
 * (Copied from `ordinaryHeadResidency.integration.test.ts`: a test file
 * imports no other.) */
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
const roObject = async (id: string) => (await db.pool.query<{ data: Record<string, unknown> }>(
  'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
  [WS.landscapeId, WS.versionId, id],
)).rows[0]?.data
/** The fields the writes control, so a row compares with what was written
 * whatever else the projection stores beside them. */
const shapeOf = (id: string, data: Record<string, unknown>) =>
  ({ id, name: data.name ?? null, p: data.p ?? null, n: data.n ?? null, race: data.race ?? null })
const roObjectRows = async () => (await db.pool.query<{ id: string; data: Record<string, unknown> }>(
  'SELECT id, data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id',
  [WS.landscapeId, WS.versionId],
)).rows.map((row) => shapeOf(row.id, row.data))
  // In JS, as `expectedRows` sorts: the database's collation may order
  // punctuation differently.
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
const projectionState = async () => (await db.pool.query<{
  degraded_since: unknown; projected_generation: string; last_projection_kind: string | null
}>(
  `SELECT degraded_since, projected_generation::text AS projected_generation, last_projection_kind
     FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
  [WS.landscapeId, WS.versionId],
)).rows[0]
/** The stored adopt row's protocol digests and an INDEPENDENT recomputation
 * of them from the raw rows (the documented format, `schema.ts`
 * ADOPT_PROTOCOL_DIGESTS_BODY; copied from `adoptState.integration.test.ts`,
 * a test file imports no other), read in ONE snapshot. */
async function protocolDigestsSnapshot(): Promise<{ stored: unknown; tables: unknown }> {
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const stored = (await client.query<{ retirements_digest: string; folds_digest: string }>(
      'SELECT retirements_digest, folds_digest FROM read_model_adopt_state WHERE landscape_id = $1 AND version_id = $2',
      [WS.landscapeId, WS.versionId])).rows[0]
    const jsonbText = (value: unknown): string => Array.isArray(value)
      ? `[${value.map(jsonbText).join(', ')}]`
      : value === null || value === undefined ? 'null' : JSON.stringify(value)
    const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
    const sha = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex')
    const retirements = (await client.query<Record<string, string | string[] | null>>(
      `SELECT collection, document_id, status, retirement_heads, forwarded_heads, folded_into,
              (extract(epoch FROM retain_until) * 1000000)::bigint::text AS retain_us,
              arrival_watermark::text AS arrival_watermark, origin
         FROM read_model_ordinary_head_retirements WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId])).rows
      .sort((a, b) => byteOrder(String(a.collection), String(b.collection)) || byteOrder(String(a.document_id), String(b.document_id)))
      .map((row) => jsonbText([row.collection, row.document_id, row.status, row.retirement_heads, row.forwarded_heads,
        row.folded_into, row.retain_us, row.arrival_watermark, row.origin]))
    const folds = (await client.query<Record<string, string | string[]>>(
      `SELECT collection, product_document_id, source_document_ids
         FROM read_model_ordinary_chain_folds WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId])).rows
      .sort((a, b) => byteOrder(String(a.collection), String(b.collection))
        || byteOrder(String(a.product_document_id), String(b.product_document_id)))
      .map((row) => jsonbText([row.collection, row.product_document_id, row.source_document_ids]))
    await client.query('COMMIT')
    return { stored, tables: { retirements_digest: sha(retirements), folds_digest: sha(folds) } }
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}
const cachedEntityIds = async (productId: string) => (await db.pool.query<{ id: string }>(
  `SELECT entity.entity_id AS id FROM read_model_sealed_product_entities entity
     JOIN read_model_sealed_product_extracts header USING (landscape_id, version_id, collection, product_document_id)
    WHERE entity.landscape_id = $1 AND entity.version_id = $2 AND entity.product_document_id = $3`,
  [WS.landscapeId, WS.versionId, productId],
)).rows.map((row) => row.id)
const rowStatus = async (documentId: string) => (await db.pool.query<{ status: string }>(
  `SELECT status FROM read_model_ordinary_head_retirements
    WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' AND document_id = $3`,
  [WS.landscapeId, WS.versionId, documentId],
)).rows[0]?.status ?? null

/** What one test drove: entity ids by head, heads by tag. */
interface Driven {
  /** retired head document id -> the entity ids written into it. */
  entitiesOf: Map<string, string[]>
  /** Every entity written, id -> value (unique ids: nothing overwrites). */
  written: Map<string, Entity>
}
const driven = (): Driven => ({ entitiesOf: new Map(), written: new Map([['b', { id: 'b', name: 'B', type: 'system' }]]) })

/** Fill the CURRENT head with entities of unique ids (each carries `p`, a
 * field only its own segment ever holds) until it is due, and wait for the
 * projector to rotate it. Returns the retired head's document id. */
async function fillAndRotate(ws: Workspace, tag: string, d: Driven, extra?: Entity, bulk = 0): Promise<string> {
  const url = currentHead(ws)
  const head = await ws.repo.find<ObjHead>(url as AutomergeUrl)
  const ids: string[] = []
  // An entity of a chosen id first (it may repeat across heads), counted as
  // one of the head's entities.
  if (extra) {
    head.change((doc) => { doc.objects[extra.id] = { ...extra } })
    d.written.set(extra.id, extra)
    ids.push(extra.id)
  }
  // `bulk` entities in ONE change: a head at or above the seal by size
  // (never folded, never a product), retired and forwarded for good.
  if (bulk > 0) {
    const values = Array.from({ length: bulk }, (_, at) => {
      const id = `${tag}-bulk${at}`
      return { id, name: id, type: 'system', p: tag }
    })
    head.change((doc) => { for (const value of values) doc.objects[value.id] = { ...value } })
    for (const value of values) { d.written.set(value.id, value); ids.push(value.id) }
  }
  let index = 0
  while (A.stats(head.doc() as A.Doc<unknown>).numChanges < THRESHOLD) {
    const id = `${tag}-${index}`
    const value = { id, name: id, type: 'system', p: tag }
    head.change((doc) => { doc.objects[id] = { ...value } })
    d.written.set(id, value)
    ids.push(id)
    index += 1
  }
  // Up to 45 s: a rotation refused because a fold holds the shared key is
  // retried on its backoff (1 s, 5 s, 30 s).
  const next = await until(() => currentHead(ws), (now) => now !== url, 45_000)
  expect(next).not.toBe(url)
  d.entitiesOf.set(docId(url), ids)
  return docId(url)
}

/** The ids a product holds: the entities of every source it folded. */
const productEntities = (d: Driven, log: ReturnType<typeof logLines>, product: string): string[] => {
  const fold = log.events('read_model.ordinary_chain_folded').find((line) => line.product === product)
  return ((fold?.sources as string[] | undefined) ?? []).flatMap((source) => d.entitiesOf.get(source) ?? [])
}

const parkedProducts = (log: ReturnType<typeof logLines>) =>
  [...new Set(log.events('read_model.ordinary_sealed_product_parked').map((line) => docId(String(line.url))))]

/** Rotate until at least `k` sealed products are parked AND given back. */
async function sealAndPark(ws: Workspace, residency: AutomergeResidencyLeases, log: ReturnType<typeof logLines>, k: number, d: Driven) {
  for (let i = 0; i < 4 * k + 4 && parkedProducts(log).length < k; i += 1) {
    await fillAndRotate(ws, `h${i}`, d)
    await until(() => parkedProducts(log).length, (n) => n >= Math.floor((i + 1) / 2), 10_000)
  }
  const parked = await until(() => parkedProducts(log), (ids) => ids.length >= k, 60_000)
  // RED on the base: nothing is ever parked.
  expect(parked.length).toBeGreaterThanOrEqual(k)
  for (const id of parked) {
    expect(await until(async () => {
      await residency.drain()
      return !residency.isLeased(id) && !resident(ws.repo, id)
    }, (gone) => gone, 15_000)).toBe(true)
  }
  return parked
}

/** ro_objects as the writes say it must be: every entity once (`b` too). */
const expectedRows = (d: Driven) => [...d.written.values()]
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  .map((entity) => shapeOf(entity.id, entity))

suite('ordinary sealed fold products are parked (G4-16f) — real projector, leases, Repo, PostgreSQL', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'ordinary_sealed_product_parking')
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
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.pool.query(`TRUNCATE automerge_storage, automerge_document_workspace, ro_objects, ro_connections, ro_groups,
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
    delete process.env.AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS
    delete process.env.READ_MODEL_SEALED_CACHE
  })

  it('T1 + T4 + T5: three sealed products are parked — not leased, not in the Repo cache — and neither a fold pass nor a registry edit loads one back', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stop = await start(ws.repo, ws.rootUrl, residency)
    try {
      // T1 (RED on the base: no product is ever parked; each stays leased).
      const parked = await sealAndPark(ws, residency, log, 3, d)
      // RED on the base for more than the missing log line: every SEALED
      // product the fold logged (independent of any park line) is listed,
      // not leased and not in the Repo cache.
      const sealedByFold = log.events('read_model.ordinary_chain_folded')
        .filter((line) => Number(line.entities) >= CEILING).map((line) => String(line.product))
        .filter((id) => ws.meta.doc()!.objectShardUrls.includes(`automerge:${id}`))
      expect(sealedByFold.length).toBeGreaterThanOrEqual(3)
      for (const id of sealedByFold) {
        // A product published a moment ago may still be on its way to a park.
        expect(await until(async () => {
          await residency.drain()
          return !residency.isLeased(id) && !resident(ws.repo, id)
        }, (gone) => gone, 15_000)).toBe(true)
      }
      // Witness: each parked product IS a sealed fold product, still listed.
      for (const id of parked) {
        const fold = log.events('read_model.ordinary_chain_folded').find((line) => line.product === id)
        expect(Number(fold?.entities)).toBeGreaterThanOrEqual(CEILING)
        expect(ws.meta.doc()!.objectShardUrls).toContain(`automerge:${id}`)
      }
      // Control: the current head is leased and resident.
      expect(residency.isLeased(docId(currentHead(ws)))).toBe(true)
      // Served as before: every value the writes put.
      expect(await until(roObjectRows, (rows) => JSON.stringify(rows) === JSON.stringify(expectedRows(d)), 15_000))
        .toEqual(expectedRows(d))

      // T4 (kills "writer skip removed"): fold passes over a chain that
      // lists the parked products load none of them back.
      const foldSampleBefore = documentLoadCount('steady', 'fold-sample')
      const passesBefore = log.events('read_model.ordinary_chain_fold_pass').length
      for (let i = 0; i < 2; i += 1) await fillAndRotate(ws, `t4-${i}`, d)
      await until(() => log.events('read_model.ordinary_chain_fold_pass').length, (n) => n >= passesBefore + 2, 30_000)
      expect(log.events('read_model.ordinary_chain_fold_pass').length).toBeGreaterThanOrEqual(passesBefore + 2)
      await settle(500)
      expect(documentLoadCount('steady', 'fold-sample')).toBe(foldSampleBefore)
      for (const id of parked) {
        expect(residency.isLeased(id)).toBe(false)
        expect(resident(ws.repo, id)).toBe(false)
      }

      // T5 (kills "registryProjectLatest re-extracts parked products"): a
      // registry edit re-extracts the whole model; the parked products answer
      // from the index.
      const extractBefore = documentLoadCount('steady', 'extract')
      const generationBefore = Number((await projectionState())?.projected_generation ?? 0)
      ws.registry.change((doc) => { doc.touched = (doc.touched ?? 0) + 1 })
      const after = await until(projectionState,
        (state) => state?.last_projection_kind === 'registry' && Number(state.projected_generation) > generationBefore, 15_000)
      expect(after?.last_projection_kind).toBe('registry')
      expect(documentLoadCount('steady', 'extract')).toBe(extractBefore)
      for (const id of parked) expect(resident(ws.repo, id)).toBe(false)
      // And they answered with what they serve, not with nothing: a parked
      // product read as `{}` is a `document-uninitialised` defect of this
      // full extraction (kills "resolve serves {} for a parked product").
      const defects = (await db.pool.query<{ defect_count: number | null; defect_summary: string | null }>(
        'SELECT defect_count, defect_summary FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId],
      )).rows[0]
      expect({ count: defects?.defect_count ?? 0, summary: defects?.defect_summary ?? 'none' }).toEqual({ count: 0, summary: 'none' })
      expect(log.events('read_model.ordinary_sealed_product_changed')).toEqual([])
      expect((await projectionState())?.degraded_since ?? null).toBeNull()
    } finally {
      stop()
      log.restore()
    }
  }, 300_000)

  it('ADOPT (G4-16f C2): the adopt row\'s protocol digests equal the retirement and fold rows after the cold build, right after a rotation commits (no later pass needed), and at every sample while the projector rotates, folds and parks', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stop = await start(ws.repo, ws.rootUrl, residency)
    try {
      const atColdBuild = await protocolDigestsSnapshot()
      expect(atColdBuild.stored).toBeDefined()
      expect(atColdBuild.stored).toEqual(atColdBuild.tables)
      const retired = await fillAndRotate(ws, 'r0', d)
      expect(await until(() => rowStatus(retired), (status) => status === 'retired', 10_000)).toBe('retired')
      // In the rotation's own transaction: no pass after it is awaited.
      const afterRotation = await protocolDigestsSnapshot()
      expect(afterRotation.stored).toEqual(afterRotation.tables)
      expect(afterRotation.stored).not.toEqual(atColdBuild.stored)
      // Routine work after it: more rotations, a fold, forwards, parks.
      const samples: Array<{ stored: unknown; tables: unknown }> = []
      for (const tag of ['r1', 'r2']) {
        await fillAndRotate(ws, tag, d)
        samples.push(await protocolDigestsSnapshot())
      }
      const head = await ws.repo.find<ObjHead>(currentHead(ws) as AutomergeUrl)
      head.change((doc) => { doc.objects['after-rotation'] = { id: 'after-rotation', name: 'x', type: 'system' } })
      for (let at = 0; at < 20; at += 1) {
        samples.push(await protocolDigestsSnapshot())
        await settle(150)
      }
      for (const sample of samples) expect(sample.stored).toEqual(sample.tables)
      // Witness: the samples saw the plane move (not one value 22 times).
      expect(new Set(samples.map((sample) => JSON.stringify(sample.stored))).size).toBeGreaterThan(1)
    } finally {
      stop()
      log.restore()
    }
  }, 300_000)

  it('CACHE-W (G4-16f C3): every parked product gets its extract in the background — after a mid-session park and after a cold build — and an unlisted product\'s extract is pruned by the next cold build', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    let stop = await start(ws.repo, ws.rootUrl, residency)
    try {
      const parked = await sealAndPark(ws, residency, log, 2, d)
      await awaitSealedProductCacheWrites(WS)
      // Mid-session parks: cached, each with exactly what it holds.
      for (const id of parked) {
        expect((await cachedEntityIds(id)).sort()).toEqual([...productEntities(d, log, id)].sort())
      }
      // A stray extract of a product no longer listed: the next cold build prunes it.
      await db.pool.query(`INSERT INTO read_model_sealed_product_extracts (landscape_id, version_id, collection, product_document_id,
        rows_digest, heads, max_arrival_seq, extraction_version, entity_count) VALUES ($1, $2, 'object', 'unlisted', 'd', ARRAY['h'], 1, 1, 0)`,
      [WS.landscapeId, WS.versionId])
      // The cold build's own writes: emptied, then a new process rebuilds.
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts WHERE product_document_id = ANY($1::text[])', [parked])
      stop()
      await ws.repo.flush()
      await settle()
      const repo2 = storageRepo()
      stop = await start(repo2, ws.rootUrl, new AutomergeResidencyLeases(repo2))
      await awaitSealedProductCacheWrites(WS)
      for (const id of parked) {
        expect((await cachedEntityIds(id)).sort()).toEqual([...productEntities(d, log, id)].sort())
      }
      expect((await db.pool.query(`SELECT 1 FROM read_model_sealed_product_extracts WHERE product_document_id = 'unlisted'`)).rowCount).toBe(0)
    } finally {
      stop()
      log.restore()
    }
  }, 300_000)

  /** A corpus of at least three sealed products, two of which hold `dup` at
   * different values (the LATER-listed one must win), every one parked and
   * its extract written. Returns the parked product ids. */
  async function cachedCorpus(ws: Workspace, residency: AutomergeResidencyLeases, log: ReturnType<typeof logLines>, d: Driven) {
    const dup = (p: string): Entity => ({ id: 'dup', name: 'dup', type: 'system', p })
    await fillAndRotate(ws, 'c0', d, dup('first'))
    await fillAndRotate(ws, 'c1', d)
    await until(() => parkedProducts(log), (ids) => ids.length >= 1, 60_000)
    await fillAndRotate(ws, 'c2', d)
    await fillAndRotate(ws, 'c3', d, dup('second'))
    await until(() => parkedProducts(log), (ids) => ids.length >= 2, 60_000)
    await sealAndPark(ws, residency, log, 3, d)
    // EVERY sealed product listed (a fold may have sealed one more than
    // were waited for), each parked and cached.
    const sealedListed = () => [...new Set(log.events('read_model.ordinary_chain_folded')
      .filter((line) => Number(line.entities) >= CEILING).map((line) => String(line.product))
      .filter((id) => ws.meta.doc()!.objectShardUrls.includes(`automerge:${id}`)))]
    const parked = await until(async () => {
      await awaitSealedProductCacheWrites(WS)
      const ids = sealedListed()
      const cached = await Promise.all(ids.map(async (id) => (await cachedEntityIds(id)).length > 0))
      return cached.every(Boolean) && ids.every((id) => parkedProducts(log).includes(id)) ? ids : []
    }, (ids) => ids.length >= 3, 30_000)
    expect(parked.length).toBeGreaterThanOrEqual(3)
    expect(parked.filter((id) => productEntities(d, log, id).includes('dup')).length).toBeGreaterThanOrEqual(2)
    expect(await until(roObjectRows, (rows) => JSON.stringify(rows) === JSON.stringify(expectedRows(d)), 15_000))
      .toEqual(expectedRows(d))
    expect((await roObject('dup'))?.p).toBe('second')
    return parked
  }
  /** Every ro_* row of the workspace, as text, per table. */
  async function roSnapshot(): Promise<Record<string, string[]>> {
    const { rows: tables } = await db.pool.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name LIKE 'ro\\_%' AND column_name = 'landscape_id' ORDER BY 1`)
    const out: Record<string, string[]> = {}
    for (const { name } of tables) {
      const { rows } = await db.pool.query<{ x: string }>(
        `SELECT (to_jsonb(t) - 'updated_at' - 'created_at')::text AS x FROM ${name} t
          WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
      out[name] = rows.map((row) => row.x).sort()
    }
    return out
  }
  const lastPhases = (log: ReturnType<typeof logLines>) => {
    const lines = log.events('read_model.cold_build_phases')
    return lines[lines.length - 1] as Record<string, number>
  }
  /** A new process over the same storage, cold-building. */
  async function coldStart(rootUrl: string) {
    const repo2 = storageRepo()
    const residency2 = new AutomergeResidencyLeases(repo2)
    const stop2 = await start(repo2, rootUrl, residency2)
    return { repo2, residency2, stop2 }
  }

  it('CACHE-W2 (G4-16f C4): a cold build over products whose CURRENT rows carry a remembered refusal does not hand them to the writer again (no refused-before skip, no decode)', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const parked = await cachedCorpus(ws, residency, log, d)
      stopA()
      await ws.repo.flush()
      await settle()
      // Every product's header now says "refused" over the very rows it was written from.
      const marked = await db.pool.query(`UPDATE read_model_sealed_product_extracts SET refused_reason = 'insert-refused', entity_count = 0`)
      expect(marked.rowCount).toBeGreaterThanOrEqual(parked.length)
      await db.pool.query('DELETE FROM read_model_sealed_product_entities')
      const before = log.events('read_model.sealed_product_cache_drained').length
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      expect(lastPhases(log).cacheHits).toBe(0)
      // The C7 fields are on the event (nothing skipped, nothing dropped here).
      expect(lastPhases(log) as unknown as Record<string, unknown>).toMatchObject({
        derivedAnalyzeSkipped: false, analyzeSkippedTables: [], duplicateIdsDropped: 0,
      })
      await awaitSealedProductCacheWrites(WS)
      await settle(1_500)
      await awaitSealedProductCacheWrites(WS)
      const drains = log.events('read_model.sealed_product_cache_drained').slice(before)
      // Witness: the cold build's writer ran (its prune drains), so an empty skip count is not a writer that never ran.
      expect(drains.length).toBeGreaterThan(0)
      const skippedAny = drains.reduce((n, line) => n + Object.values((line.skipped as Record<string, number>) ?? {})
        .reduce((a, b2) => a + b2, 0), 0)
      const written = drains.reduce((n, line) => n + Number(line.written ?? 0), 0)
      expect(skippedAny, 'products with a remembered refusal over their current rows are not queued at all').toBe(0)
      expect(written).toBe(0)
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('CACHE-P1 (G4-16f C4): products served from the cache are NOT written back by the cold build that served them', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const parked = await cachedCorpus(ws, residency, log, d)
      stopA()
      await ws.repo.flush()
      await settle()
      const stamps = async () => (await db.pool.query<{ id: string; at: string }>(
        `SELECT product_document_id AS id, updated_at::text AS at FROM read_model_sealed_product_extracts ORDER BY 1`)).rows
      const before = await stamps()
      expect(before.length).toBeGreaterThanOrEqual(parked.length)
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      expect(lastPhases(log).cacheHits).toBe(parked.length)
      await awaitSealedProductCacheWrites(WS)
      await settle(1_500)
      await awaitSealedProductCacheWrites(WS)
      expect(await stamps()).toEqual(before)
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('CACHE-P2 (G4-16f C3): stopping the projector stops its cache writer (no extract is written after stop)', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const parked = await cachedCorpus(ws, residency, log, d)
      stopA()
      await ws.repo.flush()
      await settle()
      // Misses everywhere: the next cold build enqueues every product, paced at 2 s.
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts')
      process.env.READ_MODEL_SEALED_CACHE_INTERVAL_MS = '2000'
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      expect(lastPhases(log).cacheMisses).toBe(parked.length)
      stopB()
      stopB = null
      // Two pauses of 2 s would have written at least two products.
      await settle(5_500)
      const written = (await db.pool.query('SELECT count(*)::int AS n FROM read_model_sealed_product_extracts')).rows[0]!.n as number
      expect(written).toBe(0)
    } finally {
      delete process.env.READ_MODEL_SEALED_CACHE_INTERVAL_MS
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('CACHE-P3 (G4-16f C4): a product this Repo already holds (with a change storage does not) is read from the RESIDENT document, not from the cache', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const parked = await cachedCorpus(ws, residency, log, d)
      stopA()
      await ws.repo.flush()
      await settle()
      const product = parked[parked.length - 1]!
      const target = productEntities(d, log, product).find((id) => id !== 'dup')!
      const repo2 = storageRepo()
      const handle = await repo2.find<ObjHead>(`automerge:${product}` as AutomergeUrl)
      handle.change((doc) => { doc.objects[target]!.name = 'resident-only change' })
      stopB = await start(repo2, ws.rootUrl, new AutomergeResidencyLeases(repo2))
      const phases = lastPhases(log)
      expect(phases.cacheMisses).toBeGreaterThanOrEqual(1)
      expect(phases.cacheHits).toBe(parked.length - 1)
      expect((await roObject(target))?.name).toBe('resident-only change')
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('CACHE-P4 (G4-16f C4): READ_MODEL_SEALED_CACHE=off stops the READER — a cold build over a full cache reads every product from its document', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const parked = await cachedCorpus(ws, residency, log, d)
      stopA()
      await ws.repo.flush()
      await settle()
      process.env.READ_MODEL_SEALED_CACHE = 'off'
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      const phases = lastPhases(log)
      expect(phases.cacheHits).toBe(0)
      expect(phases.cacheMisses).toBe(0)
      expect(parked.length).toBeGreaterThanOrEqual(3)
      expect(await roObjectRows()).toEqual(expectedRows(d))
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('CACHE-P5 (G4-16f C3): READ_MODEL_SEALED_CACHE=off stops the WRITER — a cold build with no cache writes none', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      await cachedCorpus(ws, residency, log, d)
      stopA()
      await ws.repo.flush()
      await settle()
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts')
      process.env.READ_MODEL_SEALED_CACHE = 'off'
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      await awaitSealedProductCacheWrites(WS)
      await settle(1_500)
      expect((await db.pool.query('SELECT count(*)::int AS n FROM read_model_sealed_product_extracts')).rows[0]!.n).toBe(0)
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('CACHE-P6 (G4-16f C4): an extract smaller than the seal is never served, even with a matching digest', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const parked = await cachedCorpus(ws, residency, log, d)
      stopA()
      await ws.repo.flush()
      await settle()
      const product = parked[0]!
      // A consistent but too-small extract: the digest still matches the rows.
      await db.pool.query(
        `DELETE FROM read_model_sealed_product_entities WHERE product_document_id = $1
           AND entity_id <> (SELECT min(entity_id) FROM read_model_sealed_product_entities WHERE product_document_id = $1)`, [product])
      await db.pool.query('UPDATE read_model_sealed_product_extracts SET entity_count = 1 WHERE product_document_id = $1', [product])
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      const phases = lastPhases(log)
      expect(phases.cacheMisses).toBe(1)
      expect(phases.cacheHits).toBe(parked.length - 1)
      expect(await roObjectRows()).toEqual(expectedRows(d))
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('CACHE-P7 (G4-16f C3): an attach that THROWS after the writer exists (after the cold build queued every product) leaves a writer that never runs', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    try {
      await cachedCorpus(ws, residency, log, d)
      stopA()
      await ws.repo.flush()
      await settle()
      // Misses everywhere, so the next cold build queues every product.
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts')
      const builds = log.events('read_model.cold_build_phases').length
      const drains = log.events('read_model.sealed_product_cache_drained').length
      // The attach fails AFTER the cold build committed (its adopt row is
      // the last write of that transaction): the registry watcher's find of
      // the registry shard is refused from then on.
      let committed = false
      const pool = poolBeforeQuery((text) => { if (text.includes('INSERT INTO read_model_adopt_state')) committed = true })
      const repo2 = storageRepo()
      const registryUrl = ws.registry.url
      // F4 (G4-16f C6-1): every handle the failed attach resolved, to count
      // the 'change' listeners it leaves.
      const found = new Set<DocHandle<unknown>>()
      const failing = new Proxy(repo2, {
        get(target, prop) {
          if (prop === 'find') {
            return (url: AutomergeUrl, ...rest: unknown[]) => {
              if (committed && url === registryUrl) return Promise.reject(new Error('test: the registry shard is unavailable'))
              const result = (target.find as (...a: unknown[]) => unknown).call(target, url, ...rest) as Promise<DocHandle<unknown>>
              return result.then((handle) => { found.add(handle); return handle })
            }
          }
          const value = Reflect.get(target, prop, target) as unknown
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        },
      }) as Repo
      const residency2 = new AutomergeResidencyLeases(repo2)
      const projectorLeases = () => {
        let n = 0
        for (const lease of (residency2 as unknown as { leases: Map<string, { owners: Map<string, unknown> }> }).leases.values()) {
          for (const owner of lease.owners.keys()) if (owner.startsWith('projector:')) n += 1
        }
        return n
      }
      let leasedAtMost = 0
      const acquire = residency2.acquire.bind(residency2)
      residency2.acquire = (...args: Parameters<AutomergeResidencyLeases['acquire']>) => {
        acquire(...args)
        leasedAtMost = Math.max(leasedAtMost, projectorLeases())
      }
      // Timers armed from the projector's frames (setTimeout and setInterval),
      // live until they fire or are cleared.
      const liveTimers = new Set<unknown>()
      let armedTimers = 0
      const fromProjector = () => /projectorService\.ts/.test(new Error().stack ?? '')
      const realSetTimeout = globalThis.setTimeout
      const realSetInterval = globalThis.setInterval
      const realClearTimeout = globalThis.clearTimeout
      const realClearInterval = globalThis.clearInterval
      const timerSpies = [
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
          const tracked = fromProjector()
          const timer: unknown = realSetTimeout((...a: unknown[]) => { liveTimers.delete(timer); fn(...a) }, ms, ...rest)
          if (tracked) { liveTimers.add(timer); armedTimers += 1 }
          return timer
        }) as unknown as typeof setTimeout),
        vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
          const timer = realSetInterval(fn, ms, ...rest)
          if (fromProjector()) { liveTimers.add(timer); armedTimers += 1 }
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
      ]
      try {
        await expect(startReadModelProjector(failing, ws.rootUrl, pool, WS, residency2, 0, 200,
          undefined, undefined, undefined, config())).rejects.toThrow()
      } finally {
        for (const spy of timerSpies) spy.mockRestore()
      }
      expect(committed).toBe(true)
      // F4: what the failed attach registered after its cold build is gone
      // — RED when `attachFailed` does not run `cleanups` (listeners) or
      // does not release the owner (leases). Witnesses first: it HAD them.
      const listeners = () => [...found].reduce((sum, handle) => sum + handle.listenerCount('change'), 0)
      expect(found.size).toBeGreaterThan(0)
      expect(leasedAtMost, 'the failed attach held leases').toBeGreaterThan(0)
      expect(listeners(), 'no change listener left on any handle the failed attach resolved').toBe(0)
      expect(projectorLeases(), 'no residency lease left for the failed attach\'s owner').toBe(0)
      expect(armedTimers, 'the failed attach armed timers').toBeGreaterThan(0)
      // Witness: the cold build committed and queued its products (misses).
      expect(log.events('read_model.cold_build_phases').length).toBe(builds + 1)
      expect(lastPhases(log).cacheMisses).toBeGreaterThanOrEqual(3)
      // The failed attach's writer is gone from the registry (stopped), not
      // left held there for ever (`startReadModelProjector`, attachFailed).
      expect(hasSealedProductCacheWriter(WS)).toBe(false)
      // Well past the interval: nothing written, ever.
      await settle(1_500)
      expect((await db.pool.query('SELECT count(*)::int AS n FROM read_model_sealed_product_extracts')).rows[0]!.n).toBe(0)
      expect(log.events('read_model.sealed_product_cache_drained')).toHaveLength(drains)
      // F4, after the interval: no timer of the failed attach is still armed,
      // and no listener came back.
      expect(liveTimers.size, 'no projector timer left armed').toBe(0)
      expect(listeners()).toBe(0)
    } finally {
      stopA()
      log.restore()
    }
  }, 300_000)

  it('CACHE-P7b (G4-16f C6-1, F4): an attach that throws AFTER it marked itself attached and registered its diagram probe leaves no change listener, no lease, no probe entry, and is detached', async () => {
    const ws = await workspace(storageRepo())
    const stopA = await start(ws.repo, ws.rootUrl, new AutomergeResidencyLeases(ws.repo))
    stopA()
    await ws.repo.flush()
    await settle()
    let attachedMarked = false
    const pool = poolBeforeQuery((text) => { if (text.includes('projector_attached = true')) attachedMarked = true })
    const repo2 = storageRepo()
    const found = new Set<DocHandle<unknown>>()
    const tracking = new Proxy(repo2, {
      get(target, prop) {
        if (prop === 'find') {
          return (url: AutomergeUrl, ...rest: unknown[]) => ((target.find as (...a: unknown[]) => unknown).call(target, url, ...rest) as Promise<DocHandle<unknown>>)
            .then((handle) => { found.add(handle); return handle })
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as Repo
    const residency2 = new AutomergeResidencyLeases(repo2)
    const projectorLeases = () => {
      let n = 0
      for (const lease of (residency2 as unknown as { leases: Map<string, { owners: Map<string, unknown> }> }).leases.values()) {
        for (const owner of lease.owners.keys()) if (owner.startsWith('projector:')) n += 1
      }
      return n
    }
    // The last step that can throw in the attach: the rotation telemetry's
    // registration, after the attach mark, the diagram probe and bootComplete.
    let probeWhenFailing: boolean | null = null
    let leasesWhenFailing = 0
    const register = vi.spyOn(ordinaryRotationTelemetry, 'register').mockImplementation(() => {
      probeWhenFailing = hasInitialDiagramProbe(WS)
      leasesWhenFailing = projectorLeases()
      throw new Error('test: telemetry registration fails')
    })
    let instance: string | null = null
    try {
      await expect(startReadModelProjector(tracking, ws.rootUrl, pool, WS, residency2, 0, 200, undefined, undefined,
        (id) => { instance = id }, config())).rejects.toThrow(/telemetry registration fails/)
    } finally {
      register.mockRestore()
    }
    // Witnesses: it had marked itself attached, registered its probe, held leases.
    expect(attachedMarked).toBe(true)
    expect(probeWhenFailing).toBe(true)
    expect(leasesWhenFailing).toBeGreaterThan(0)
    expect(found.size).toBeGreaterThan(0)
    expect(hasInitialDiagramProbe(WS), 'the failed attach removed its own probe entry').toBe(false)
    expect([...found].reduce((sum, handle) => sum + handle.listenerCount('change'), 0)).toBe(0)
    expect(projectorLeases()).toBe(0)
    const attached = await until(async () => (await db.pool.query<{ a: boolean; id: string | null }>(
      'SELECT projector_attached AS a, projector_instance_id AS id FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
      [WS.landscapeId, WS.versionId])).rows[0], (row) => row?.a === false, 5_000)
    expect(instance).not.toBeNull()
    expect(attached, 'the failed attach is detached (CAS on its own id)').toMatchObject({ a: false, id: null })
  }, 300_000)

  it('CACHE-P8 (G4-16f B): the writer takes neither the decoder nor a client while a projection of its workspace is in flight, and resumes after it', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    let release: () => void = () => {}
    try {
      const parked = await cachedCorpus(ws, residency, log, d)
      stopA()
      await ws.repo.flush()
      await settle()
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts')
      // Its first job no sooner than 2 s after the attach.
      process.env.READ_MODEL_SEALED_CACHE_INTERVAL_MS = '2000'
      let hold = false
      let reached = false
      let holding = false
      const held = new Promise<void>((resolve) => { release = resolve })
      // The writer's two resources, counted while the pass is held: a client
      // (its first statement, the product's row read) and the decoder.
      let writerReadsWhileHeld = 0
      let writerReads = 0
      const decodes = vi.spyOn(durableHeadsDecoder, 'decodeField')
      let decodesWhenHeld = 0
      // A metadata pass held INSIDE its transaction (its group read).
      const pool = poolBeforeQuery(async (text) => {
        if (text.includes(`WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) IN ('snapshot', 'incremental')`)) {
          writerReads += 1
          if (holding) writerReadsWhileHeld += 1
        }
        if (!hold || !text.includes('UNION SELECT object_id FROM ro_group_objects')) return
        reached = true
        holding = true
        decodesWhenHeld = decodes.mock.calls.length
        await held
        holding = false
      })
      const repo2 = storageRepo()
      stopB = await start(repo2, ws.rootUrl, new AutomergeResidencyLeases(repo2), pool)
      expect(lastPhases(log).cacheMisses).toBe(parked.length)
      hold = true
      const meta2 = await repo2.find<Meta>(ws.meta.url)
      meta2.change((meta) => { meta.groups.held = { id: 'held', name: 'held pass' } })
      expect(await until(() => reached, Boolean, 10_000)).toBe(true)
      const extracts = async () => (await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM read_model_sealed_product_extracts')).rows[0]!.n
      // Well past the pauses of the prune job and the first product (2 s
      // each, from the attach): nothing written while the pass is open.
      await settle(6_500)
      expect(await extracts()).toBe(0)
      expect(writerReadsWhileHeld, 'no client taken for a product while the pass is open').toBe(0)
      expect(decodes.mock.calls.length - decodesWhenHeld, 'no decode while the pass is open').toBe(0)
      release()
      expect(await until(extracts, (n) => n >= parked.length, 60_000)).toBeGreaterThanOrEqual(parked.length)
      // Witnesses that the two counters can see the writer at all.
      expect(writerReads).toBeGreaterThanOrEqual(parked.length)
      expect(decodes.mock.calls.filter((call) => call[3] === 'background').length).toBeGreaterThanOrEqual(parked.length)
    } finally {
      release()
      vi.restoreAllMocks()
      delete process.env.READ_MODEL_SEALED_CACHE_INTERVAL_MS
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('CACHE-P9 (G4-16f B): the writer takes neither the decoder nor a client while a ROTATION of its workspace is in flight (off the projection tail), and resumes after it', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    let release: () => void = () => {}
    const decodes = vi.spyOn(durableHeadsDecoder, 'decodeField')
    try {
      const parked = await cachedCorpus(ws, residency, log, d)
      stopA()
      await ws.repo.flush()
      await settle()
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts')
      process.env.READ_MODEL_SEALED_CACHE_INTERVAL_MS = '2000'
      let hold = false
      let holding = false
      let reached = false
      const held = new Promise<void>((resolve) => { release = resolve })
      let writerReadsWhileHeld = 0
      let writerReads = 0
      let decodesWhenHeld = 0
      // The rotator's own transaction, held at its first statement: the
      // rotation is in flight and holds no row (the projection tail is free).
      const pool = poolBeforeQuery(async (text) => {
        if (text.includes(`WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) IN ('snapshot', 'incremental')`)) {
          writerReads += 1
          if (holding) writerReadsWhileHeld += 1
        }
        if (!hold || !text.startsWith('BEGIN; SET LOCAL lock_timeout')) return
        hold = false
        reached = true
        holding = true
        decodesWhenHeld = decodes.mock.calls.length
        await held
        holding = false
      })
      const repo2 = storageRepo()
      stopB = await start(repo2, ws.rootUrl, new AutomergeResidencyLeases(repo2), pool)
      expect(lastPhases(log).cacheMisses).toBe(parked.length)
      // Fill the current head through B's Repo until it is due.
      const meta2 = await repo2.find<Meta>(ws.meta.url)
      const head = await repo2.find<ObjHead>(meta2.doc()!.editsObjectShardUrl as AutomergeUrl)
      hold = true
      for (let index = 0; A.stats(head.doc() as A.Doc<unknown>).numChanges < THRESHOLD; index += 1) {
        const id = `p9-${index}`
        head.change((doc) => { doc.objects[id] = { id, name: id, type: 'system', p: 'p9' } })
      }
      expect(await until(() => reached, Boolean, 20_000), 'the rotation reached its transaction').toBe(true)
      const extracts = async () => (await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM read_model_sealed_product_extracts')).rows[0]!.n
      await settle(6_500)
      expect(await extracts()).toBe(0)
      expect(writerReadsWhileHeld, 'no client taken for a product while the rotation is in flight').toBe(0)
      expect(decodes.mock.calls.length - decodesWhenHeld, 'no decode while the rotation is in flight').toBe(0)
      release()
      expect(await until(extracts, (n) => n >= parked.length, 60_000)).toBeGreaterThanOrEqual(parked.length)
      expect(writerReads).toBeGreaterThanOrEqual(parked.length)
    } finally {
      release()
      decodes.mockRestore()
      delete process.env.READ_MODEL_SEALED_CACHE_INTERVAL_MS
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('CACHE-R1 (G4-16f C4): a cold build served from the extract cache writes the same ro_* as one without it, resolves no product, and the proof still certifies every product from the memo', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const parked = await cachedCorpus(ws, residency, log, d)
      stopA()
      await ws.repo.flush()
      await settle()
      // WITH the cache. The memo emptied first: this process's earlier loads
      // of the same table would otherwise answer the proof for the products,
      // and hide whether the cache hits themselves were remembered.
      durableHeadsMemo.clear()
      const withCache = await coldStart(ws.rootUrl)
      stopB = withCache.stop2
      const hitPhases = lastPhases(log)
      expect(hitPhases.cacheHits).toBe(parked.length)
      expect(hitPhases.cacheMisses).toBe(0)
      // Every cache-served product was remembered against the table its rows
      // were read from, so the proof answered it without a decode.
      expect(hitPhases.proofMemoHits).toBeGreaterThanOrEqual(parked.length)
      // No product was resolved (no Repo handle) for the build.
      for (const id of parked) expect(resident(withCache.repo2, id)).toBe(false)
      // The proof certified every cache-served product, from the memo.
      for (const id of parked) {
        const w = (await db.pool.query<{ w: string }>(
          'SELECT projected_watermark::text AS w FROM read_model_document_watermarks WHERE document_id = $1', [id])).rows[0]?.w
        expect(BigInt(w ?? '0')).toBeGreaterThan(0n)
      }
      expect((await roObject('dup'))?.p).toBe('second')
      expect(await roObjectRows()).toEqual(expectedRows(d))
      // The index of the cache-served products is in list order: a meta pass
      // (`checkSealedIndexOrder`) finds nothing to degrade.
      const generationBefore = Number((await projectionState())?.projected_generation ?? 0)
      const metaB = await withCache.repo2.find<Meta>(ws.meta.url)
      metaB.change((meta) => { meta.groups.touched = { id: 'touched', name: 'touched' } })
      expect(await until(projectionState, (state) => state?.last_projection_kind === 'metadata'
        && Number(state.projected_generation) > generationBefore, 15_000)).toMatchObject({ last_projection_kind: 'metadata' })
      await settle(500)
      expect(log.events('read_model.ordinary_sealed_product_changed')).toEqual([])
      // Durable, so the second arm reads the same ModelMeta.
      await withCache.repo2.flush()
      const served = await roSnapshot()
      stopB()
      stopB = null
      await settle()
      // WITHOUT it: the same rows.
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts')
      const without = await coldStart(ws.rootUrl)
      stopB = without.stop2
      const missPhases = lastPhases(log)
      expect(missPhases.cacheHits).toBe(0)
      expect(missPhases.cacheMisses).toBe(parked.length)
      expect(await roSnapshot()).toEqual(served)
      // Serving from the cache cost no extra proof decode (memo remembered).
      expect(hitPhases.proofMemoMisses).toBeLessThanOrEqual(missPhases.proofMemoMisses)
      await settle(1_000)
      expect(log.events('read_model.ordinary_sealed_product_changed')).toEqual([])
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('CACHE-R2 (G4-16f C4): a write landing on a cache-served product after the read degrades it through the park poll, never projected', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const parked = await cachedCorpus(ws, residency, log, d)
      stopA()
      await ws.repo.flush()
      await settle()
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      expect(lastPhases(log).cacheHits).toBe(parked.length)
      const product = parked[0]!
      const target = productEntities(d, log, product)[0]!
      const other = storageRepo()
      const handle = await other.find<ObjHead>(`automerge:${product}` as AutomergeUrl)
      handle.change((doc) => { doc.objects[target]!.name = 'changed after the cache read' })
      await other.flush([handle.documentId])
      const changed = await until(() => log.events('read_model.ordinary_sealed_product_changed'), (lines) => lines.length >= 1, 5_000)
      expect(changed[0]).toMatchObject({ url: `automerge:${product}`, reason: 'arrival' })
      expect(await until(async () => (await projectionState())?.degraded_since ?? null, (since) => since !== null, 5_000)).not.toBeNull()
      expect((await roObject(target))?.name).toBe(d.written.get(target)!.name)
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  const R3_SUBJECT = {
    'compaction-rewrite': 'a product whose rows were rewritten (same content, new row versions)',
    'version-bump': 'an extract of another extraction version',
    'entity-row-lost': 'an extract missing one entity row',
  } as const
  for (const variant of ['compaction-rewrite', 'version-bump', 'entity-row-lost'] as const) {
    it(`CACHE-R3 (${variant}) (G4-16f C4): ${R3_SUBJECT[variant]} MISSES — read from its document, served the same, not degraded`, async () => {
      const ws = await workspace(storageRepo())
        const residency = new AutomergeResidencyLeases(ws.repo)
      const log = logLines()
      const d = driven()
      const stopA = await start(ws.repo, ws.rootUrl, residency)
      let stopB: (() => void) | null = null
      try {
        const parked = await cachedCorpus(ws, residency, log, d)
        stopA()
        await ws.repo.flush()
        await settle()
        const product = parked[0]!
        if (variant === 'compaction-rewrite') {
          const { rows } = await db.pool.query<{ key: string; data: Uint8Array }>(
            `SELECT key, data FROM automerge_storage WHERE split_part(key, '/', 1) = $1
              ORDER BY CASE split_part(key, '/', 2) WHEN 'snapshot' THEN 0 ELSE 1 END, key`, [product])
          const bytes = Buffer.concat(rows.map((row) => Buffer.from(row.data)))
          const loaded = A.load(bytes)
          const headsBefore = A.getHeads(loaded)
          const compacted = A.save(loaded)
          expect(A.getHeads(A.load(compacted))).toEqual(headsBefore)
          await db.pool.query(`DELETE FROM automerge_storage WHERE split_part(key, '/', 1) = $1`, [product])
          await db.pool.query('INSERT INTO automerge_storage (key, data) VALUES ($1, $2)', [`${product}/snapshot/rewritten`, Buffer.from(compacted)])
        } else if (variant === 'version-bump') {
          await db.pool.query('UPDATE read_model_sealed_product_extracts SET extraction_version = extraction_version + 1')
        } else {
          const lost = await db.pool.query(
            `DELETE FROM read_model_sealed_product_entities WHERE product_document_id = $1
               AND entity_id = (SELECT min(entity_id) FROM read_model_sealed_product_entities WHERE product_document_id = $1)`, [product])
          expect(lost.rowCount).toBe(1)
        }
        const b = await coldStart(ws.rootUrl)
        stopB = b.stop2
        const phases = lastPhases(log)
        const misses = variant === 'version-bump' ? parked.length : 1
        expect(phases.cacheMisses).toBe(misses)
        expect(phases.cacheHits).toBe(parked.length - misses)
        expect(await roObjectRows()).toEqual(expectedRows(d))
        expect((await roObject('dup'))?.p).toBe('second')
        await settle(1_000)
        expect(log.events('read_model.ordinary_sealed_product_changed')).toEqual([])
        expect((await projectionState())?.degraded_since ?? null).toBeNull()
      } finally {
        stopB?.()
        stopA()
        log.restore()
      }
    }, 300_000)
  }

  it('T2: a write to a parked product through ANOTHER storage path degrades it (ORDINARY_FOLD_PRODUCT_CHANGED) within a poll, and is never projected', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const stop = await start(ws.repo, ws.rootUrl, residency)
    try {
      // RED on the base: nothing is parked (and a write into storage that this
      // Repo never loads reaches no watcher, so nothing would degrade either).
      const [product] = await sealAndPark(ws, residency, log, 1, d)
      expect((await projectionState())?.degraded_since ?? null).toBeNull()
      const target = productEntities(d, log, product!)[0]!
      const other = storageRepo()
      const handle = await other.find<ObjHead>(`automerge:${product}` as AutomergeUrl)
      handle.change((doc) => { doc.objects[target]!.name = 'changed behind the projector' })
      await other.flush([handle.documentId])
      // One poll is 200 ms; allow a few.
      const changed = await until(() => log.events('read_model.ordinary_sealed_product_changed'), (lines) => lines.length >= 1, 5_000)
      expect(changed[0]).toMatchObject({ url: `automerge:${product}`, reason: 'arrival' })
      expect(log.events('read_model.ordinary_fold_product_changed').some((line) => line.url === `automerge:${product}`)).toBe(true)
      expect(await until(async () => (await projectionState())?.degraded_since ?? null, (since) => since !== null, 5_000)).not.toBeNull()
      // Never projected, never unparked, reported once.
      expect((await roObject(target))?.name).toBe(target)
      await settle(1_000)
      expect(log.events('read_model.ordinary_sealed_product_changed')).toHaveLength(1)
      expect(residency.isLeased(product!)).toBe(false)
    } finally {
      stop()
      log.restore()
    }
  }, 300_000)

  it('T3: a late write to a retired head for an id only a parked product serves is forwarded against the product\'s value, and ro_* equals a fresh cold build', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    let stop = await start(ws.repo, ws.rootUrl, residency)
    try {
      // The head the late write reaches is listed BEFORE the products: one
      // sealed by SIZE (a fold never takes it, so it stays retired, listed
      // and forwarded). A retired head listed after the products would serve
      // its own late put to the forward (`servedOutsideCurrentHead` skips the
      // current head only), shadowing the product whether parked or not.
      const retired = await fillAndRotate(ws, 'big', d, undefined, CEILING + 1)
      const [product] = await sealAndPark(ws, residency, log, 1, d)
      const target = productEntities(d, log, product!)[0]!
      const served = d.written.get(target)!
      expect(served.p).toBeDefined()
      expect(await until(() => rowStatus(retired), (status) => status === 'retired', 10_000)).toBe('retired')
      const list = ws.meta.doc()!.objectShardUrls
      expect(list.indexOf(`automerge:${retired}`)).toBeLessThan(list.indexOf(`automerge:${product}`))
      // An offline client's whole-entity put into the retired head, without
      // `p` (a field only the product holds) and with a new field `n`.
      const late = await ws.repo.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
      late.change((doc) => { doc.objects[target] = { id: target, name: served.name as string, type: 'system', n: 'new' } })
      // The forward merges against what the OTHER segments serve, in
      // ModelMeta order: the retired head's own put, then the product, which
      // outranks it — the parked product's value, from the index. With the
      // product resident (the base) the same value comes from its document.
      // Kills "the index serves {} for a product": the base would then be the
      // put alone, and the row would lose `p`.
      const row = await until(() => roObject(target), (value) => value?.n === 'new', 30_000)
      expect(row).toMatchObject({ id: target, n: 'new', p: served.p })
      d.written.set(target, { ...served, n: 'new' })
      expect(log.events('read_model.ordinary_head_forwarded').some((line) => line.retired === retired)).toBe(true)
      // The product was never loaded back for it.
      expect(resident(ws.repo, product!)).toBe(false)
      const before = await roObjectRows()
      // A fresh cold build (a new process: a new Repo over the same storage).
      stop()
      await ws.repo.flush()
      await settle()
      const repo2 = storageRepo()
      stop = await start(repo2, ws.rootUrl, new AutomergeResidencyLeases(repo2))
      expect(await roObjectRows()).toEqual(before)
      expect((await roObject(target))).toMatchObject({ n: 'new', p: served.p })
    } finally {
      stop()
      log.restore()
    }
  }, 300_000)

  it('T6: a cold build over K sealed products streams them — at most one resident at any moment — parks every one, and a change landing before its arrival read is served', async () => {
    // The DOCUMENT path of the stream (the extract cache would serve every
    // product without resolving it; its own suite is CACHE-R).
    process.env.READ_MODEL_SEALED_CACHE = 'off'
    const ws = await workspace(storageRepo())
    const log = logLines()
    const d = driven()
    const residencyA = new AutomergeResidencyLeases(ws.repo)
    const stopA = await start(ws.repo, ws.rootUrl, residencyA)
    let stopB: (() => void) | null = null
    try {
      const parkedByA = await sealAndPark(ws, residencyA, log, 3, d)
      const expected = await until(roObjectRows, (rows) => JSON.stringify(rows) === JSON.stringify(expectedRows(d)), 15_000)
      expect(expected).toEqual(expectedRows(d))
      stopA()
      await ws.repo.flush()
      await settle()

      // A new process: nothing resident.
      const repo2 = storageRepo()
      const residency2 = new AutomergeResidencyLeases(repo2)
      const sealed = new Set(parkedByA)
      // Sampled at every `find` (each resolution starts with one): how many
      // sealed products are resident while the next document is asked for.
      let maxResident = 0
      const originalFind = repo2.find.bind(repo2) as (...args: unknown[]) => unknown
      const findSpy = vi.spyOn(repo2, 'find').mockImplementation(((...args: unknown[]) => {
        maxResident = Math.max(maxResident, [...sealed].filter((id) => resident(repo2, id)).length)
        return originalFind(...args)
      }) as unknown as typeof repo2.find)
      // THE RACE (kills "watermark read after the content"): a change reaches
      // the FIRST streamed product's handle — through this Repo, saved — just
      // before its arrival read. Read after it, the content holds it: served.
      // Read before it (the mutant), neither the content nor the poll (its
      // chunk is below S) ever has it.
      // A holder, not a `let`: assigned in a callback, which narrowing cannot see.
      const race: { hit: { product: string; entity: string } | null } = { hit: null }
      const pool = poolBeforeQuery(async (text, params) => {
        if (race.hit || !text.includes('max(arrival_seq)')) return
        const first = params?.[0]
        const ids = Array.isArray(first) ? first as string[] : []
        const product = ids.length === 1 && sealed.has(ids[0]!) ? ids[0]! : null
        if (!product) return
        const entity = productEntities(d, log, product)[0]!
        race.hit = { product, entity }
        const handle = await originalFind(`automerge:${product}` as AutomergeUrl) as DocHandle<ObjHead>
        handle.change((doc) => { doc.objects[entity]!.race = 'r' })
        await repo2.flush([handle.documentId])
      })
      stopB = await start(repo2, ws.rootUrl, residency2, pool)
      findSpy.mockRestore()
      // Witness: the stream ran over every product.
      const streamed = log.events('read_model.ordinary_sealed_products_streamed')
      expect(streamed.length).toBeGreaterThanOrEqual(1)
      expect(Number(streamed[streamed.length - 1]!.products)).toBeGreaterThanOrEqual(3)
      // RED on the base: every shard resolved before any was read — all K
      // resident together (and kept: leased, watched).
      expect(maxResident).toBeLessThanOrEqual(1)
      await residency2.drain()
      for (const id of sealed) {
        expect(residency2.isLeased(id)).toBe(false)
        expect(resident(repo2, id)).toBe(false)
      }
      // The race happened, and its value is served.
      expect(race.hit).not.toBeNull()
      const { entity } = race.hit!
      expect((await roObject(entity))?.race).toBe('r')
      // Everything else as A served it.
      const rows = await roObjectRows()
      expect(rows.filter((row) => row.id !== entity)).toEqual(expected.filter((row) => row.id !== entity))
      // And nothing is reported changed: what was read is what is stored.
      await settle(1_000)
      expect(log.events('read_model.ordinary_sealed_product_changed')).toEqual([])
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('T7: a takeover A -> B while A runs: B cold-builds with the products parked, ro_* equals the writes, the handover re-check finds nothing, and A holds no product lease after stop()', async () => {
    const ws = await workspace(storageRepo())
    const log = logLines()
    const d = driven()
    const residencyA = new AutomergeResidencyLeases(ws.repo)
    const stopA = await start(ws.repo, ws.rootUrl, residencyA)
    let stopB: (() => void) | null = null
    try {
      const parked = await sealAndPark(ws, residencyA, log, 2, d)
      await until(roObjectRows, (rows) => JSON.stringify(rows) === JSON.stringify(expectedRows(d)), 15_000)
      await ws.repo.flush()
      // B, another cell over the same storage, takes the workspace over while
      // A still runs; its re-check runs soon after its attach.
      process.env.AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS = '300'
      const repo2 = storageRepo()
      const residencyB = new AutomergeResidencyLeases(repo2)
      stopB = await start(repo2, ws.rootUrl, residencyB)
      stopA()
      await residencyA.drain()
      for (const id of parked) expect(residencyA.isLeased(id)).toBe(false)
      expect(await roObjectRows()).toEqual(expectedRows(d))
      // B parked them at its cold build, and its re-check of them (storage's
      // heads against the heads it read) found nothing.
      const streamed = log.events('read_model.ordinary_sealed_products_streamed')
      expect(Number(streamed[streamed.length - 1]?.products ?? 0)).toBeGreaterThanOrEqual(2)
      expect(await until(() => log.events('read_model.ordinary_handover_recheck'), (lines) => lines.length >= 1, 30_000))
        .not.toHaveLength(0)
      await settle(2_000)
      expect(log.events('read_model.ordinary_sealed_product_changed')).toEqual([])
      for (const id of parked) expect(residencyB.isLeased(id)).toBe(false)
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('T9: an id held by TWO sealed products is served at the LATER one — in the rows, as a forward\'s base, and by a cold build', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    let stop = await start(ws.repo, ws.rootUrl, residency)
    try {
      const dup = (p: string): Entity => ({ id: 'dup', name: 'dup', type: 'system', p })
      // The late write's head, listed BEFORE the products (see T3): sealed
      // by size, never folded, retired and forwarded.
      const retired = await fillAndRotate(ws, 'big', d, undefined, CEILING + 1)
      // Two folds of two heads each (budget 2, the oldest run first): `dup`
      // in the first pair at p=first, in the second at p=second.
      await fillAndRotate(ws, 'o0', d, dup('first'))
      await fillAndRotate(ws, 'o1', d)
      await until(() => parkedProducts(log), (ids) => ids.length >= 1, 60_000)
      await fillAndRotate(ws, 'o2', d)
      await fillAndRotate(ws, 'o3', d, dup('second'))
      const parked = await until(() => parkedProducts(log), (ids) => ids.length >= 2, 60_000)
      // RED on the base: nothing is parked.
      expect(parked.length).toBeGreaterThanOrEqual(2)
      expect(parked.filter((id) => productEntities(d, log, id).includes('dup'))).toHaveLength(2)
      expect((await until(() => roObject('dup'), (row) => row?.p === 'second', 15_000))?.p).toBe('second')
      // A forward's base for `dup` (absent from the current head): the
      // retired head's own put, then both products in ModelMeta order — the
      // later product's value wins; the index serves it (`valueIn`).
      expect(await until(() => rowStatus(retired), (status) => status === 'retired', 10_000)).toBe('retired')
      const late = await ws.repo.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
      late.change((doc) => { doc.objects.dup = { id: 'dup', name: 'dup', type: 'system', n: 'new' } })
      const row = await until(() => roObject('dup'), (value) => value?.n === 'new', 30_000)
      expect(row).toMatchObject({ n: 'new', p: 'second' })
      d.written.set('dup', { ...dup('second'), n: 'new' })
      // A cold build (a new Repo) streams both products and ranks them by
      // the list it merges: the same rows.
      const before = await roObjectRows()
      expect(before).toEqual(expectedRows(d))
      stop()
      await ws.repo.flush()
      await settle()
      const repo2 = storageRepo()
      stop = await start(repo2, ws.rootUrl, new AutomergeResidencyLeases(repo2))
      expect(await roObjectRows()).toEqual(before)
    } finally {
      stop()
      log.restore()
    }
  }, 300_000)

  for (const rewrite of ['swap', 'unlist'] as const) {
    it(`T10 (${rewrite}): a client rewrite of ModelMeta that ${rewrite === 'swap' ? 'swaps two parked products' : 'unlists a parked product'} leaves the index unable to answer — every parked product is degraded (list-order-changed)`, async () => {
      const ws = await workspace(storageRepo())
      const residency = new AutomergeResidencyLeases(ws.repo)
      const log = logLines()
      const d = driven()
      const stop = await start(ws.repo, ws.rootUrl, residency)
      try {
        // RED on the base: nothing is parked.
        const parked = await sealAndPark(ws, residency, log, 2, d)
        expect(log.events('read_model.ordinary_sealed_product_changed')).toEqual([])
        const list = ws.meta.doc()!.objectShardUrls
        const [first, second] = parked.map((id) => `automerge:${id}`).sort((a, b) => list.indexOf(a) - list.indexOf(b))
        ws.meta.change((meta) => {
          const i = meta.objectShardUrls.indexOf(first!)
          const j = meta.objectShardUrls.indexOf(second!)
          if (rewrite === 'swap') {
            meta.objectShardUrls[i] = second!
            meta.objectShardUrls[j] = first!
          } else {
            meta.objectShardUrls.splice(j, 1)
          }
        })
        const changed = await until(
          () => log.events('read_model.ordinary_sealed_product_changed').filter((line) => line.reason === 'list-order-changed'),
          (lines) => lines.length >= parked.length, 15_000)
        expect(new Set(changed.map((line) => docId(String(line.url))))).toEqual(new Set(parked))
        expect(await until(async () => (await projectionState())?.degraded_since ?? null, (since) => since !== null, 5_000)).not.toBeNull()
      } finally {
        stop()
        log.restore()
      }
    }, 300_000)
  }

  /** Hold or fail the RELEASE flush of a sealed product's park: the second
   * single-document flush of a fold product (its first is its creation's,
   * `createClaimedOverlaySegment`). */
  function releaseFlushOf(repo: Repo, mode: 'hold' | 'throw') {
    const products = new Set<string>()
    const flushes = new Map<string, number>()
    const originalCreate = repo.create.bind(repo) as (...args: unknown[]) => DocHandle<unknown>
    const createSpy = vi.spyOn(repo, 'create').mockImplementation(((...args: unknown[]) => {
      const handle = originalCreate(...args)
      const init = args[0] as Record<string, unknown> | undefined
      if (init && typeof init === 'object' && 'foldedFromUrls' in init) products.add(String(handle.documentId))
      return handle
    }) as unknown as typeof repo.create)
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => { open = resolve })
    const state: { hit: string | null } = { hit: null }
    const originalFlush = repo.flush.bind(repo)
    const flushSpy = vi.spyOn(repo, 'flush').mockImplementation((async (ids?: readonly string[]) => {
      const id = ids?.length === 1 ? String(ids[0]) : null
      if (id && products.has(id) && !state.hit) {
        const count = (flushes.get(id) ?? 0) + 1
        flushes.set(id, count)
        if (count === 2) {
          state.hit = id
          if (mode === 'throw') throw new Error('injected release flush failure')
          await gate
        }
      }
      return originalFlush(ids as never)
    }) as unknown as typeof repo.flush)
    return {
      state,
      open: () => open(),
      restore: () => { createSpy.mockRestore(); flushSpy.mockRestore() },
    }
  }

  it('T11: a stop() while a park waits on its release flush (steps 3-4) leaves no lease and nothing resident', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const held = releaseFlushOf(ws.repo, 'hold')
    const stop = await start(ws.repo, ws.rootUrl, residency)
    try {
      for (let i = 0; i < 6 && !held.state.hit; i += 1) {
        await fillAndRotate(ws, `s${i}`, d)
        await until(() => held.state.hit, (hit) => hit !== null, 10_000)
      }
      // RED on the base: no park, so no release flush is ever reached.
      expect(held.state.hit).not.toBeNull()
      const product = held.state.hit!
      stop()
      held.open()
      await settle(500)
      await residency.drain()
      expect(residency.isLeased(product)).toBe(false)
      expect(resident(ws.repo, product)).toBe(false)
      expect(log.events('read_model.ordinary_sealed_product_park_failed')).toEqual([])
    } finally {
      held.open()
      stop()
      held.restore()
      log.restore()
    }
  }, 300_000)

  it('T12: a release flush that FAILS leaves the product parked and leased; the next poll retries the release', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const failing = releaseFlushOf(ws.repo, 'throw')
    const stop = await start(ws.repo, ws.rootUrl, residency)
    try {
      for (let i = 0; i < 6 && !failing.state.hit; i += 1) {
        await fillAndRotate(ws, `s${i}`, d)
        await until(() => failing.state.hit, (hit) => hit !== null, 10_000)
      }
      // RED on the base: no park, so no release flush is ever reached.
      expect(failing.state.hit).not.toBeNull()
      const product = failing.state.hit!
      expect((await until(() => log.events('read_model.ordinary_sealed_product_park_failed'),
        (lines) => lines.length >= 1, 5_000))[0]).toMatchObject({ url: `automerge:${product}` })
      // The poll (200 ms) gives the lease back, durable first.
      expect(await until(async () => {
        await residency.drain()
        return !residency.isLeased(product) && !resident(ws.repo, product)
      }, (gone) => gone, 15_000)).toBe(true)
      expect(log.events('read_model.ordinary_sealed_product_changed')).toEqual([])
    } finally {
      stop()
      failing.restore()
      log.restore()
    }
  }, 300_000)

  /** Document ids of every fold product `repo` creates from here on. */
  function recordProducts(repo: Repo) {
    const ids = new Set<string>()
    const original = repo.create.bind(repo) as (...args: unknown[]) => DocHandle<unknown>
    const spy = vi.spyOn(repo, 'create').mockImplementation(((...args: unknown[]) => {
      const handle = original(...args)
      const init = args[0] as Record<string, unknown> | undefined
      if (init && typeof init === 'object' && 'foldedFromUrls' in init) ids.add(String(handle.documentId))
      return handle
    }) as unknown as typeof repo.create)
    return { ids, restore: () => spy.mockRestore() }
  }
  /** The ids of a single-document arrival read (`documentContentArrivals`). */
  const arrivalReadOf = (text: string, params: unknown[] | undefined): string | null => {
    if (!text.includes('max(arrival_seq)')) return null
    const first = params?.[0]
    return Array.isArray(first) && first.length === 1 ? String(first[0]) : null
  }

  it('T13: the MID-SESSION park reads the arrival watermark before the content — a change reaching the product just before that read degrades it', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const d = driven()
    const products = recordProducts(ws.repo)
    // THE RACE (kills "watermark read after the content / the watcher
    // stopped" in `parkSealedProduct`): just before the park's arrival read,
    // a change reaches the product's handle through this Repo and is saved.
    // Read in order, the watcher is still attached and refuses it at once. Read
    // after the sample and the stop (the mutant), the chunk is below S and
    // nothing ever reports it.
    const race: { hit: string | null } = { hit: null }
    const pool = poolBeforeQuery(async (text, params) => {
      const id = arrivalReadOf(text, params)
      if (race.hit || !id || !products.ids.has(id)) return
      race.hit = id
      const handle = await ws.repo.find<ObjHead>(`automerge:${id}` as AutomergeUrl)
      const entity = Object.keys(handle.doc()!.objects)[0]!
      handle.change((doc) => { doc.objects[entity]!.race = 'r' })
      await ws.repo.flush([handle.documentId])
    })
    const stop = await start(ws.repo, ws.rootUrl, residency, pool)
    try {
      for (let i = 0; i < 6 && !race.hit; i += 1) {
        await fillAndRotate(ws, `r${i}`, d)
        await until(() => race.hit, (hit) => hit !== null, 10_000)
      }
      // RED on the base: no park, so no arrival read for a product.
      expect(race.hit).not.toBeNull()
      const url = `automerge:${race.hit}`
      const reported = await until(() => [
        ...log.events('read_model.ordinary_fold_product_changed'),
        ...log.events('read_model.ordinary_sealed_product_changed'),
      ].filter((line) => line.url === url), (lines) => lines.length >= 1, 10_000)
      expect(reported.length).toBeGreaterThanOrEqual(1)
      expect(await until(async () => (await projectionState())?.degraded_since ?? null, (since) => since !== null, 5_000)).not.toBeNull()
    } finally {
      stop()
      products.restore()
      log.restore()
    }
  }, 300_000)

  it('T14: a ModelMeta rewrite DURING the streaming cold build (a product unlisted) neither fails it nor misranks it — the build ranks by the list it merges; the next meta pass degrades the stale index', async () => {
    // The document path, as T6.
    process.env.READ_MODEL_SEALED_CACHE = 'off'
    const ws = await workspace(storageRepo())
    const log = logLines()
    const d = driven()
    const residencyA = new AutomergeResidencyLeases(ws.repo)
    const stopA = await start(ws.repo, ws.rootUrl, residencyA)
    let stopB: (() => void) | null = null
    try {
      const parked = await sealAndPark(ws, residencyA, log, 2, d)
      const expected = await until(roObjectRows, (rows) => JSON.stringify(rows) === JSON.stringify(expectedRows(d)), 15_000)
      expect(expected).toEqual(expectedRows(d))
      const listed = ws.meta.doc()!.objectShardUrls
      const [first, last] = parked.map((id) => `automerge:${id}`).sort((a, b) => listed.indexOf(a) - listed.indexOf(b))
      stopA()
      await ws.repo.flush()
      await settle()
      const repo2 = storageRepo()
      // Kills "the cold build ranks by ModelMeta's LIVE list": while the FIRST
      // product is read, a client unlists the LAST one; ranked by the live
      // list, indexing it would refuse ("not listed") and fail the build.
      const rewrite: { done: boolean } = { done: false }
      const pool = poolBeforeQuery(async (text, params) => {
        const id = arrivalReadOf(text, params)
        if (rewrite.done || !id || `automerge:${id}` !== first) return
        rewrite.done = true
        const meta = await repo2.find<Meta>(ws.meta.url as AutomergeUrl)
        meta.change((m) => { m.objectShardUrls.splice(m.objectShardUrls.indexOf(last!), 1) })
      })
      stopB = await start(repo2, ws.rootUrl, new AutomergeResidencyLeases(repo2), pool)
      expect(rewrite.done).toBe(true)
      // The rows are the merged revision's: the unlisted product still served.
      expect(await roObjectRows()).toEqual(expected)
      const streamed = log.events('read_model.ordinary_sealed_products_streamed')
      expect(Number(streamed[streamed.length - 1]?.products ?? 0)).toBeGreaterThanOrEqual(2)
      // The next meta pass finds the index's order gone from the live list.
      const meta2 = await repo2.find<Meta>(ws.meta.url as AutomergeUrl)
      meta2.change((m) => { m.groups.touched = { id: 'touched', name: 'touched', objectIds: [] } })
      const changed = await until(
        () => log.events('read_model.ordinary_sealed_product_changed').filter((line) => line.reason === 'list-order-changed'),
        (lines) => lines.length >= 1, 15_000)
      expect(changed.length).toBeGreaterThanOrEqual(1)
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)
})
