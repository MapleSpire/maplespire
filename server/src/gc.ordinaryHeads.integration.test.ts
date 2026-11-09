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
import { Repo, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from './automergeStorage.js'
import { AutomergeResidencyLeases } from './automergeResidency.js'
import { cachedHandles } from './automergeRepoCompat.js'
import { gcOrphanedDocs, type GcResult } from './gc.js'
import { MaintenanceCoordinator } from './maintenance/coordinator.js'
import { ensureMaintenanceSchema } from './maintenance/schema.js'
import { setWorkspaceDocumentsRegistrationForTest, WorkspaceDocIndex } from './rbac/docScope.js'
import { ensureSyncCellOwnershipSchema } from './syncCells/ownership.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from './testing/isolatedSchema.js'
import { ensureReadModelSchema } from './readModel/schema.js'
import { startReadModelProjector } from './readModel/projectorService.js'
import type { OrdinaryHeadRotationConfig } from './readModel/ordinaryHeadRotation.js'
import { readOrdinaryHeadRetirement } from './readModel/ordinaryHeadForwarding.js'
import type { WorkspaceKey } from './readModel/projector.js'

/**
 * G4-16c — what keeps a RETIRED ordinary write head alive through a real,
 * DESTRUCTIVE GC pass, end to end, against a real PostgreSQL.
 *
 * `gc.test.ts` pins the folded-head root with a fake pool that models its
 * query. This file runs the query itself, with heads the projector really
 * rotated, folded and detached (or parked). The read-model tables come from
 * their real definition (`ensureReadModelSchema`), the claims table from its
 * real one (`ensureSyncCellOwnershipSchema`). `landscapes`, `versions`,
 * `landscape_versions`, `automerge_meta` and `automerge_storage` are copies
 * of `db.ts`'s DDL in production shape: `initSchema` runs on the module's own
 * pool, which an isolated schema cannot reach.
 *
 * The GC runs as `maintenance/globalGcWorker.ts` runs it: its OWN Repo over
 * the shared storage, fenced by the maintenance coordinator. That separate
 * Repo is why the sync cell's in-memory handles protect nothing here. With
 * `now` taken from the database clock after every write and `minimumAgeMs:
 * 0`, the age grace protects nothing either (`deferredYoung` is asserted 0).
 * Every pass asserts it was not aborted, and the tests that expect a head to
 * survive also make the pass delete an unlinked orphan: the sweep ran.
 *
 * Two retired heads, two different protections:
 *
 * - FOLDED (fold on): unlisted from ModelMeta, so the walk never reaches it;
 *   only the `folded` root (`gc.ts`) keeps it — until `retain_until`, or
 *   past it while a late write above its `arrival_watermark` is not carried
 *   yet. Its late write is then carried by the folded-head poll, after a
 *   cold restart of the cell on a fresh Repo, so the write has to load the
 *   head from storage.
 * - PARKED (fold off): `retired` row, not `folded`, so the folded root does
 *   not apply; still LISTED in ModelMeta, so the walk marks it. Its lease is
 *   given back and it is evicted, so its late write too is loaded from
 *   storage, then carried by `pollParkedRetiredHeads`. Control: unlisted, it
 *   is swept.
 *
 * Runtime: about a minute and a half (fourteen tests, most of them two real
 * rotations and a fold each).
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-gcoh', versionId: 'v-gcoh' }
const LISTED = `${WS.landscapeId}/${WS.versionId}`
const THRESHOLD = 4
/** A maintenance-lock namespace of our own: the advisory lock is
 * DATABASE-wide, and `gc.integration.test.ts` or a dev server's in-process GC
 * on the same database would otherwise contend for `automerge_gc`. */
const LOCK_NAMESPACE = 1_700_000_000 + Math.floor(Math.random() * 100_000_000)

let db: IsolatedSchemaDb

type Entity = { id: string; [field: string]: unknown }
type ObjHead = { objects: Record<string, Entity>; writeBatchIds: string[] }
type ConnHead = { connections: Record<string, unknown>; writeBatchIds: string[] }
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
}

async function claim(documentId: string) {
  await db.pool.query(
    'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [documentId, WS.landscapeId, WS.versionId],
  )
}

/** A real workspace graph (root → ModelMeta → shards, registry), flushed,
 * its `versions` row pointing at the root, every document claimed. Returns
 * the first object write head too. */
async function workspace(repo: Repo): Promise<Workspace & { head: DocHandle<ObjHead> }> {
  const base = repo.create<{ objects: Record<string, Entity> }>({ objects: { b: { id: 'b', name: 'B', type: 'system' } } })
  const head = repo.create<ObjHead>({ objects: {}, writeBatchIds: [] })
  const connHead = repo.create<ConnHead>({ connections: {}, writeBatchIds: [] })
  const meta = repo.create<Meta>({
    objectShardUrls: [base.url, head.url],
    connectionShardUrls: [connHead.url],
    editsObjectShardUrl: head.url,
    editsObjectShardUrls: [head.url],
    editsConnectionShardUrl: connHead.url,
    editsConnectionShardUrls: [connHead.url],
    groups: {},
  })
  const registry = repo.create({ diagrams: {} })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
  const handles = [base, head, connHead, meta, registry, root]
  await Promise.all(handles.map((h) => h.whenReady()))
  await repo.flush()
  // The version GC marks from (`enumerateMaintainableWorkspaces`), and the one
  // the folded root joins to.
  await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $1)', [WS.landscapeId])
  await db.pool.query(
    'INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, $3, $4)',
    [WS.versionId, WS.landscapeId, 'Main', root.url],
  )
  for (const handle of handles) await claim(String(handle.documentId))
  return { repo, rootUrl: root.url, meta, head }
}

function config(fold: boolean): OrdinaryHeadRotationConfig {
  return {
    mode: 'on', allowlist: new Set([LISTED]), maxActors: 1_000_000, maxChanges: THRESHOLD,
    ...(fold ? { chainFold: { minChain: 2, budget: 8, retainMs: 86_400_000 } } : {}),
  }
}
const startProjector = (ws: Workspace, fold: boolean, residency?: AutomergeResidencyLeases) => startReadModelProjector(
  ws.repo, ws.rootUrl, db.pool, WS, residency, 0, undefined,
  undefined, undefined, undefined, config(fold),
)

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
type Log = ReturnType<typeof logLines>

const currentHead = (ws: Workspace) => ws.meta.doc()!.editsObjectShardUrl
const docId = (url: string) => url.replace(/^automerge:/, '')
const resident = (repo: Repo, id: string) => Object.prototype.hasOwnProperty.call(cachedHandles(repo), id)
const roObject = async (id: string) => (await db.pool.query<{ data: Record<string, unknown> }>(
  'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
  [WS.landscapeId, WS.versionId, id],
)).rows[0]?.data
const roNamed = async (id: string, name: string) =>
  (await until(() => roObject(id), (row) => row?.name === name, 20_000))?.name
const watermarkOf = async (documentId: string) => (await db.pool.query<{ w: string | null }>(
  `SELECT arrival_watermark::text AS w FROM read_model_ordinary_head_retirements
   WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
  [WS.landscapeId, WS.versionId, documentId],
)).rows[0]?.w ?? null
/** The highest CONTENT arrival of the document (snapshot or incremental, the
 * chunks the poll and the GC root read), or null. */
const maxSeqOf = async (documentId: string) => {
  const m = (await db.pool.query<{ m: string | null }>(
    `SELECT max(arrival_seq)::text AS m FROM automerge_storage
      WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) IN ('snapshot', 'incremental')`,
    [documentId],
  )).rows[0]!.m
  return m === null ? null : BigInt(m)
}
/** Does storage hold an arrival above the head's watermark? (NULL = none
 * seen yet, as the poll reads it.) */
const pending = async (documentId: string) => {
  const [seq, watermark] = [await maxSeqOf(documentId), await watermarkOf(documentId)]
  return seq !== null && seq > (watermark === null ? -1n : BigInt(watermark))
}
const storedChunks = async (documentId: string) => Number((await db.pool.query<{ n: string }>(
  "SELECT count(*)::text AS n FROM automerge_storage WHERE split_part(key, '/', 1) = $1",
  [documentId],
)).rows[0]!.n)
const claimed = async (documentId: string) => (await db.pool.query(
  'SELECT 1 FROM automerge_document_workspace WHERE document_id = $1',
  [documentId],
)).rowCount === 1
/** What the ROUTE GATE answers for the document (`automergeServer.ts` wires
 * `docIndex.resolveDocWorkspace` into `createDocumentAccessCheck`): a null is
 * `unindexed-document`, the denial that loses an offline client's edits. A
 * fresh index each time, so the answer is the durable one, not a cached hit. */
const gateWorkspace = (repo: Repo, documentId: string) =>
  new WorkspaceDocIndex(repo, db.pool).resolveDocWorkspace(documentId)
/** Kept: storage, claim, and the gate still admits it. */
async function expectKept(repo: Repo, documentId: string) {
  expect(await storedChunks(documentId)).toBeGreaterThan(0)
  expect(await claimed(documentId)).toBe(true)
  expect(await gateWorkspace(repo, documentId)).toEqual(WS)
}
/** Swept: storage and claim gone, the gate refuses it. */
async function expectSwept(repo: Repo, documentId: string) {
  expect(await storedChunks(documentId)).toBe(0)
  expect(await claimed(documentId)).toBe(false)
  expect(await gateWorkspace(repo, documentId)).toBeNull()
}
/** Move every folded row's `retain_until` to the database's now + `interval`. */
const setRetain = (interval: string) => db.pool.query(
  `UPDATE read_model_ordinary_head_retirements SET retain_until = now() + $3::interval
    WHERE landscape_id = $1 AND version_id = $2 AND status = 'folded'`,
  [WS.landscapeId, WS.versionId, interval],
)

/** Fill the CURRENT head of `kind` until it crosses the threshold, wait for
 * the projector to rotate it. Returns the retired head's url. */
async function fillAndRotate(ws: Workspace, tag: string, kind: 'object' | 'connection' = 'object'): Promise<string> {
  const current = () => (kind === 'object' ? ws.meta.doc()!.editsObjectShardUrl : ws.meta.doc()!.editsConnectionShardUrl)
  const url = current()
  const head = await ws.repo.find<ObjHead & ConnHead>(url as AutomergeUrl)
  let index = 0
  while (A.stats(head.doc() as A.Doc<unknown>).numChanges < THRESHOLD) {
    const id = `${tag}-${index}`
    head.change((d) => {
      if (kind === 'object') d.objects[`n${index}`] = { id: `n${index}`, name: id, type: 'system' }
      else d.connections[id] = { id, fromId: 'b', toId: 'x', label: tag }
    })
    index += 1
  }
  const next = await until(current, (now) => now !== url, 45_000)
  expect(next).not.toBe(url)
  return url
}

/** A client-created document whose registry link never synced: claimed,
 * stored, reachable from nothing. The sweep's witness. */
async function orphan(repo: Repo): Promise<string> {
  const handle = repo.create({ objects: { o: { id: 'o', name: 'orphan', type: 'system' } } })
  await handle.whenReady()
  await repo.flush([handle.documentId])
  await claim(handle.documentId)
  return handle.documentId
}

/** One DESTRUCTIVE pass, as the global GC worker runs it: its own Repo over
 * the shared storage, fenced. `now` is the DATABASE clock read after every
 * write, so with `minimumAgeMs: 0` no document is young. */
async function destructiveGc(minimumAgeMs = 0): Promise<GcResult> {
  const { rows } = await db.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')
  const gcRepo = storageRepo()
  const coordinator = new MaintenanceCoordinator(db.pool, 'gc-ordinary-heads-test', LOCK_NAMESPACE)
  try {
    const outcome = await coordinator.runFenced('automerge_gc', async (fence) => (
      gcOrphanedDocs(gcRepo, { db: db.pool, fence, reportOnly: false, minimumAgeMs, now: rows[0]!.now })
    ))
    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') throw new Error(`gc ${outcome.status}`)
    const result = outcome.value
    // Ran to the sweep: an aborted pass deletes nothing, which is exactly
    // what a working root looks like too.
    expect(result).toMatchObject({ aborted: false, reportOnly: false, incompleteReasons: [] })
    expect(result.deferredYoung).toBe(0)
    return result
  } finally {
    coordinator.stopAccepting()
    await coordinator.drain()
    await gcRepo.shutdown()
  }
}
/** A destructive pass that must ALSO delete an orphan created just before it. */
async function witnessedGc(repo: Repo): Promise<GcResult> {
  const swept = await orphan(repo)
  await repo.flush()
  const result = await destructiveGc()
  expect(result.deleted).toBeGreaterThanOrEqual(1)
  expect(await storedChunks(swept)).toBe(0)
  expect(await claimed(swept)).toBe(false)
  return result
}

/** The offline client's write, as the server applies a stale client's sync:
 * the document is loaded from STORAGE by a Repo that does not hold it, the
 * change merged, the chunk saved (a fresh `arrival_seq`). */
async function lateWrite(repo: Repo, url: string, offline: A.Doc<ObjHead>, id: string, name: string) {
  expect(resident(repo, docId(url))).toBe(false)
  const head = await repo.find<ObjHead>(url as AutomergeUrl)
  const edited = A.change(A.clone(offline), (d) => { d.objects[id] = { id, name, type: 'system' } })
  head.update((doc) => A.merge(doc, edited))
  await repo.flush([head.documentId])
}
const forwardsOf = (log: Log, documentId: string) =>
  log.events('read_model.ordinary_head_forwarded').filter((line) => line.retired === documentId)

/** Everything a test started, torn down whatever happened. */
class Resources {
  private stops: Array<() => void> = []
  private repos: Repo[] = []
  repo(repo: Repo) { this.repos.push(repo); return repo }
  stop(stop: () => void) { this.stops.push(stop); return stop }
  async release() {
    for (const stop of this.stops) stop()
    await settle()
    for (const repo of this.repos) await repo.shutdown().catch(() => undefined)
  }
}

interface Folded {
  ws: Workspace
  stop: () => void
  /** The offline client's copy of the OLDEST head, taken before anything rotated. */
  offline: A.Doc<ObjHead>
  /** Both folded sources, oldest first, and the product they were folded into. */
  folded: [string, string]
  product: string
}
/** Two real rotations, the projector's own fold of both retired heads, both
 * detached; the poll has seen each once (watermark set), so nothing is pending. */
async function foldedFixture(res: Resources, log: Log): Promise<Folded> {
  process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
  const ws = await workspace(res.repo(storageRepo()))
  const stop = res.stop(await startProjector(ws, true))
  const offline = A.clone(ws.head.doc() as A.Doc<ObjHead>)
  await fillAndRotate(ws, 'h0')
  const h1 = await fillAndRotate(ws, 'h1')
  await until(() => log.events('read_model.ordinary_fold_source_detached').length, (n) => n >= 2, 30_000)
  expect(log.events('read_model.ordinary_fold_source_detached').length).toBeGreaterThanOrEqual(2)
  const folded: [string, string] = [ws.head.documentId, docId(h1)]
  for (const id of folded) {
    expect(await readOrdinaryHeadRetirement(db.pool, WS, 'object', id)).toMatchObject({ status: 'folded' })
    expect(await until(() => pending(id), (p) => !p)).toBe(false)
  }
  const product = (await readOrdinaryHeadRetirement(db.pool, WS, 'object', folded[0]))!.foldedInto!
  // The folded root is the ONLY thing that can save them: no longer listed.
  const meta = ws.meta.doc()!
  for (const id of folded) {
    expect(meta.objectShardUrls).not.toContain(`automerge:${id}`)
    expect(meta.editsObjectShardUrls).not.toContain(`automerge:${id}`)
  }
  expect(meta.editsObjectShardUrls).toContain(`automerge:${product}`)
  return { ws, stop, offline, folded, product }
}
/** The cell goes down: projector stopped, Repo flushed and shut. The poll's
 * view must be clean at that point — nothing pending on a folded head —
 * so whatever the restarted cell finds above a watermark is the test's own
 * late write, never a chunk the shutdown minted. */
async function cellDown(f: Folded) {
  f.stop()
  await settle()
  await f.ws.repo.flush()
  await f.ws.repo.shutdown()
  for (const id of f.folded) expect(await pending(id)).toBe(false)
}
/** A fresh Repo over the same storage (holding no folded head), with or without its projector. */
async function cellUp(res: Resources, f: Folded, projector: boolean): Promise<{ ws: Workspace; stop: () => void }> {
  const repo = res.repo(storageRepo())
  const ws: Workspace = { repo, rootUrl: f.ws.rootUrl, meta: await repo.find<Meta>(f.ws.meta.url) }
  return { ws, stop: projector ? res.stop(await startProjector(ws, true)) : () => {} }
}

interface Parked {
  ws: Workspace
  stop: () => void
  residency: AutomergeResidencyLeases
  offline: A.Doc<ObjHead>
  retiredUrl: string
  retired: string
}
/** Fold OFF: two rotations; the oldest retired head is parked, its lease
 * given back and evicted. Still listed, its row `retired`. */
async function parkedFixture(res: Resources, log: Log): Promise<Parked> {
  process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
  process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS = '300'
  const ws = await workspace(res.repo(storageRepo()))
  const residency = new AutomergeResidencyLeases(ws.repo)
  const stop = res.stop(await startProjector(ws, false, residency))
  const offline = A.clone(ws.head.doc() as A.Doc<ObjHead>)
  const retiredUrl = ws.head.url
  const retired = ws.head.documentId
  await fillAndRotate(ws, 'h0')
  await fillAndRotate(ws, 'h1')
  const parked = () => log.events('read_model.ordinary_retired_head_parked').some((line) => docId(String(line.url)) === retired)
  expect(await until(parked, Boolean, 30_000)).toBe(true)
  expect(await until(async () => { await residency.drain(); return !resident(ws.repo, retired) }, Boolean, 15_000)).toBe(true)
  expect(residency.isLeased(retired)).toBe(false)
  // What protects it is NOT the folded root: its row is `retired`. It is the
  // listing, which only the fold (off here) removes.
  expect(await readOrdinaryHeadRetirement(db.pool, WS, 'object', retired)).toMatchObject({ status: 'retired' })
  expect(ws.meta.doc()!.objectShardUrls).toContain(retiredUrl)
  expect(ws.meta.doc()!.editsObjectShardUrls).toContain(retiredUrl)
  return { ws, stop, residency, offline, retiredUrl, retired }
}

/** Poll-cost lines logged from `mark` on (one per 60 polls, and one at stop). */
const loadedSince = (log: Log, mark: number) => log.events('read_model.ordinary_fold_arrival_poll_summary')
  .slice(mark).reduce((n, line) => n + Number(line.loaded), 0)

suite('G4-16c — a retired ordinary head through a real destructive GC pass (PostgreSQL)', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'gc_ordinary_heads')
    // PRODUCTION SHAPE, copied from `db.ts`: the claims reference `versions`,
    // which references `landscapes`.
    await db.pool.query(`CREATE TABLE landscapes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), org_id TEXT)`)
    await db.pool.query(`CREATE TABLE versions (
      id TEXT PRIMARY KEY,
      landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
      label TEXT NOT NULL, root_url TEXT NOT NULL, parent_version_id TEXT,
      kind TEXT NOT NULL DEFAULT 'version', status TEXT NOT NULL DEFAULT 'active',
      base_manifest JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query(`CREATE TABLE landscape_versions (
      id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'named', manifest JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query('CREATE TABLE automerge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    // The REAL read-model definition (retirements, fold records, and the
    // `automerge_arrival_seq` sequence).
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    // The two production indexes, so the arrival probes run as in production.
    await db.pool.query(`CREATE INDEX idx_automerge_storage_doc_updated
      ON automerge_storage ((split_part(key, '/', 1)), updated_at)`)
    await db.pool.query(`CREATE INDEX idx_automerge_storage_doc_arrival
      ON automerge_storage ((split_part(key, '/', 1)), arrival_seq DESC NULLS LAST)`)
    // The REAL claims table (`automerge_document_workspace`).
    await ensureSyncCellOwnershipSchema(db.pool)
    await db.pool.query('CREATE TABLE scopes (kind TEXT, landscape_id TEXT, version_id TEXT, org_id TEXT)')
    await ensureMaintenanceSchema(db.pool)
  })
  afterAll(async () => { await settle(500); await db?.teardown() })

  let res: Resources
  let log: Log
  let restoreRegistration: () => void = () => {}
  beforeEach(async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.pool.query(`TRUNCATE automerge_storage, automerge_document_workspace, ro_objects, ro_connections, ro_groups,
          read_model_projection_state, read_model_change_events, read_model_overlay_batch_acks,
          read_model_overlay_entity_bases, read_model_ordinary_head_retirements, read_model_document_watermarks,
          read_model_ordinary_chain_folds, versions, landscapes CASCADE`)
        break
      } catch (error) {
        if ((error as { code?: string }).code !== '40P01' || attempt >= 5) throw error
        await settle(200)
      }
    }
    // Rotation and fold claim their new documents through this seam.
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async ({ landscapeId, versionId, documentIds }) => {
      for (const documentId of documentIds) {
        await db.pool.query(
          'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [documentId, landscapeId, versionId],
        )
      }
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
    res = new Resources()
    log = logLines()
  })
  afterEach(async () => {
    await res.release()
    log.restore()
    restoreRegistration()
    delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    delete process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS
  })

  // ---- FOLDED (fold on) ----

  it('FOLDED: the folded heads and their claims survive a destructive sweep, a late write after a cold restart is forwarded and projected; past retain_until the same heads are swept', async () => {
    const f = await foldedFixture(res, log)
    // Retained, so kept by the retention itself: not counted as pending.
    expect((await witnessedGc(f.ws.repo)).foldedKeptPending).toBe(0)
    for (const id of f.folded) await expectKept(f.ws.repo, id)

    // The cell restarts on a FRESH Repo: nothing holds the folded heads in
    // memory any more, so the late write has to load one from storage.
    await cellDown(f)
    const up = await cellUp(res, f, true)
    await lateWrite(up.ws.repo, `automerge:${f.folded[0]}`, f.offline, 'late', 'after-gc')
    expect(await roNamed('late', 'after-gc')).toBe('after-gc')
    // Carried from the folded head into the CURRENT one, not projected from it.
    expect(forwardsOf(log, f.folded[0]).length).toBeGreaterThan(0)
    const current = await up.ws.repo.find<ObjHead>(currentHead(up.ws) as AutomergeUrl)
    expect(current.doc()!.objects.late).toMatchObject({ name: 'after-gc' })
    // The watermark advance commits after the forward it follows.
    expect(await until(() => pending(f.folded[0]), (p) => !p)).toBe(false)

    // CONTROL: the same heads once `retain_until` has passed, nothing pending.
    // The next destructive pass sweeps them, storage and claim.
    up.stop()
    await settle()
    await up.ws.repo.flush()
    expect((await setRetain("-1 minute")).rowCount).toBe(2)
    const second = await destructiveGc()
    expect(second.deleted).toBeGreaterThanOrEqual(2)
    for (const id of f.folded) await expectSwept(up.ws.repo, id)
    // Bounded: the product and the current head are listed, and stay.
    expect(await storedChunks(f.product)).toBeGreaterThan(0)
    expect(await storedChunks(docId(currentHead(up.ws)))).toBeGreaterThan(0)
  }, 300_000)

  it('FOLDED, the expiry race: a late write not yet carried when retain_until passes keeps its head (and only it) through the sweep; once carried, it is swept', async () => {
    const f = await foldedFixture(res, log)
    // The write lands while no projector carries it (a cell restarting, or a
    // forward on its backoff), shortly before the retention ends.
    await cellDown(f)
    const serving = await cellUp(res, f, false)
    await lateWrite(serving.ws.repo, `automerge:${f.folded[0]}`, f.offline, 'late', 'before-expiry')
    expect(await pending(f.folded[0])).toBe(true)
    expect(await pending(f.folded[1])).toBe(false)
    expect((await setRetain('-1 minute')).rowCount).toBe(2)

    const keptLines = () => log.events('gc.folded_heads_kept_pending')
    const kept = await witnessedGc(serving.ws.repo)
    // The head holding an uncarried write: document and claim kept.
    await expectKept(serving.ws.repo, f.folded[0])
    // Same pass, same expiry, nothing pending: swept. The arrival is the
    // only difference between the two.
    await expectSwept(serving.ws.repo, f.folded[1])
    // The signal: one head kept past its retention for its arrival alone,
    // counted, logged as a bare count.
    expect(kept.foldedKeptPending).toBe(1)
    expect(keptLines()).toEqual([{ event: 'gc.folded_heads_kept_pending', count: 1 }])

    // The projector comes back: the poll carries the expired head's write.
    const mark = log.events('read_model.ordinary_fold_arrival_poll_summary').length
    serving.stop = res.stop(await startProjector(serving.ws, true))
    expect(await roNamed('late', 'before-expiry')).toBe('before-expiry')
    expect(forwardsOf(log, f.folded[0]).length).toBeGreaterThan(0)
    expect(await until(() => pending(f.folded[0]), (p) => !p)).toBe(false)
    // ...and says it carried an EXPIRED row.
    const carried = () => log.events('read_model.ordinary_fold_arrival_expired_carried')
    expect(await until(() => carried().length, (n) => n > 0)).toBeGreaterThan(0)
    expect(carried().every((line) => line.documentId === f.folded[0] && line.collection === 'object')).toBe(true)
    serving.stop()
    await settle()
    // The summary flushed at stop counts the expired row found and carried.
    const summaries = log.events('read_model.ordinary_fold_arrival_poll_summary').slice(mark)
    expect(summaries.reduce((n, line) => n + Number(line.expiredRows), 0)).toBeGreaterThanOrEqual(1)
    expect(summaries.reduce((n, line) => n + Number(line.expiredCarried), 0)).toBeGreaterThanOrEqual(1)
    await serving.ws.repo.flush()
    const after = await destructiveGc()
    await expectSwept(serving.ws.repo, f.folded[0])
    // Carried: nothing kept for a pending arrival any more, and no new line.
    expect(after.foldedKeptPending).toBe(0)
    expect(keptLines()).toHaveLength(1)
  }, 300_000)

  it('the fold ON with the poll OFF is said once at attach (GC then keeps every folded head); not with the poll on, nor with the fold off', async () => {
    const disabled = () => log.events('read_model.ordinary_fold_arrival_poll_disabled')
    const ws = await workspace(res.repo(storageRepo()))
    for (const [fold, poll, expected] of [[true, '0', 1], [true, '200', 0], [false, '0', 0]] as const) {
      process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = poll
      const before = disabled().length
      const stop = res.stop(await startProjector(ws, fold))
      await settle(300)
      stop()
      await settle()
      expect(disabled().length - before).toBe(expected)
    }
    expect(disabled()[0]).toEqual({
      event: 'read_model.ordinary_fold_arrival_poll_disabled',
      workspace: LISTED,
      reason: 'AM_ORDINARY_FOLD_ARRIVAL_POLL_MS=0',
      consequence: 'folded-heads-kept-by-gc',
    })
  }, 60_000)

  it('FOLDED: a retain_until 30 s ahead still protects', async () => {
    const f = await foldedFixture(res, log)
    f.stop()
    await settle()
    await setRetain('30 seconds')
    await witnessedGc(f.ws.repo)
    for (const id of f.folded) await expectKept(f.ws.repo, id)
  }, 120_000)

  it('FOLDED: an expired head is swept under a non-zero minimumAgeMs too (retention is read on the database clock, not the GC cutoff)', async () => {
    const f = await foldedFixture(res, log)
    f.stop()
    await settle()
    await f.ws.repo.flush()
    await db.pool.query("UPDATE automerge_storage SET updated_at = now() - interval '3 hours'")
    await setRetain('-30 minutes')
    await destructiveGc(3_600_000)
    for (const id of f.folded) expect(await storedChunks(id)).toBe(0)
  }, 120_000)

  it('FOLDED: once its VERSION is deleted, a folded head pins nothing, even with a sibling version on the same root', async () => {
    const f = await foldedFixture(res, log)
    f.stop()
    await settle()
    await f.ws.repo.flush()
    // A sibling of the same landscape keeps the walk complete (same root).
    await db.pool.query(
      "INSERT INTO versions (id, landscape_id, label, root_url) VALUES ('v-other', $1, 'Other', $2)",
      [WS.landscapeId, f.ws.rootUrl],
    )
    await db.pool.query('DELETE FROM versions WHERE id = $1', [WS.versionId])
    await destructiveGc()
    for (const id of f.folded) expect(await storedChunks(id)).toBe(0)
  }, 120_000)

  it('FOLDED: a late write at exactly watermark + 1 is carried; a second one forwards only itself, committed; idle polls reload nothing', async () => {
    const f = await foldedFixture(res, log)
    await cellDown(f)
    const up = await cellUp(res, f, true)
    const mark = log.events('read_model.ordinary_fold_arrival_poll_summary').length
    // The arrival is the one right above the watermark: an off-by-one in
    // the poll (>= vs >) would miss it.
    const watermark = (await watermarkOf(f.folded[0]))!
    await db.pool.query("SELECT setval('automerge_arrival_seq', $1::bigint)", [watermark])
    await lateWrite(up.ws.repo, `automerge:${f.folded[0]}`, f.offline, 'late', 'adjacent')
    expect(await maxSeqOf(f.folded[0])).toBe(BigInt(watermark) + 1n)
    expect(await roNamed('late', 'adjacent')).toBe('adjacent')
    expect(forwardsOf(log, f.folded[0]).at(-1)).toMatchObject({ committed: true })
    expect((await readOrdinaryHeadRetirement(db.pool, WS, 'object', f.folded[0]))!.forwardedHeads).not.toBeNull()
    // A second late write: forwarded from the committed heads, so ONE entity.
    const head = await up.ws.repo.find<ObjHead>(`automerge:${f.folded[0]}` as AutomergeUrl)
    const edited = A.change(A.clone(f.offline), (d) => { d.objects.late2 = { id: 'late2', name: 'two', type: 'system' } })
    head.update((doc) => A.merge(doc, edited))
    await up.ws.repo.flush([head.documentId])
    expect(await roNamed('late2', 'two')).toBe('two')
    expect(forwardsOf(log, f.folded[0]).at(-1)).toMatchObject({ entities: 1, committed: true })
    // Idle: once carried, the poll does not load the head again and again.
    await settle(1_500)
    up.stop()
    await settle(300)
    expect(loadedSince(log, mark)).toBeLessThanOrEqual(4)
  }, 120_000)

  it('FOLDED CONNECTION heads survive a destructive sweep too', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(res.repo(storageRepo()))
    const stop = res.stop(await startProjector(ws, true))
    const retired = [docId(await fillAndRotate(ws, 'c0', 'connection')), docId(await fillAndRotate(ws, 'c1', 'connection'))]
    for (const id of retired) {
      expect(await until(() => readOrdinaryHeadRetirement(db.pool, WS, 'connection', id), (row) => row?.status === 'folded', 30_000))
        .toMatchObject({ status: 'folded' })
      expect(ws.meta.doc()!.connectionShardUrls).not.toContain(`automerge:${id}`)
    }
    stop()
    await settle()
    await witnessedGc(ws.repo)
    for (const id of retired) await expectKept(ws.repo, id)
  }, 180_000)

  it('a RECORDED fold product not listed yet is kept by its record, and swept without it', async () => {
    const ws = await workspace(res.repo(storageRepo()))
    const product = await orphan(ws.repo)
    await db.pool.query(
      `INSERT INTO read_model_ordinary_chain_folds (landscape_id, version_id, collection, product_document_id, source_document_ids)
       VALUES ($1, $2, 'object', $3, ARRAY['x'])`,
      [WS.landscapeId, WS.versionId, product],
    )
    await witnessedGc(ws.repo)
    await expectKept(ws.repo, product)
    await db.pool.query('DELETE FROM read_model_ordinary_chain_folds')
    await destructiveGc()
    await expectSwept(ws.repo, product)
  }, 60_000)

  it('the sweep removes a swept document\'s arrival-watermark row with it', async () => {
    const ws = await workspace(res.repo(storageRepo()))
    const doc = await orphan(ws.repo)
    await db.pool.query(
      'INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark) VALUES ($1, $2, $3, 5)',
      [WS.landscapeId, WS.versionId, doc],
    )
    await ws.repo.flush()
    await destructiveGc()
    expect(await storedChunks(doc)).toBe(0)
    expect((await db.pool.query('SELECT 1 FROM read_model_document_watermarks WHERE document_id = $1', [doc])).rowCount).toBe(0)
  }, 60_000)

  // ---- PARKED (fold off) ----

  it('PARKED: its lease given back and evicted, a parked head survives a destructive sweep because it is still LISTED, and its late write is caught by the parked-head poll and projected', async () => {
    const p = await parkedFixture(res, log)
    await witnessedGc(p.ws.repo)
    await expectKept(p.ws.repo, p.retired)
    // The stale client's write: loaded from storage (evicted), no watcher.
    const before = forwardsOf(log, p.retired).length
    await lateWrite(p.ws.repo, p.retiredUrl, p.offline, 'late', 'after-gc-parked')
    expect(await roNamed('late', 'after-gc-parked')).toBe('after-gc-parked')
    expect(forwardsOf(log, p.retired).length).toBeGreaterThan(before)
    const current = await p.ws.repo.find<ObjHead>(currentHead(p.ws) as AutomergeUrl)
    expect(current.doc()!.objects.late).toMatchObject({ name: 'after-gc-parked' })
  }, 300_000)

  it('PARKED, control: once ModelMeta no longer lists it, the parked head is swept', async () => {
    const p = await parkedFixture(res, log)
    p.stop()
    await settle()
    const meta = await p.ws.repo.find<Meta>(p.ws.meta.url)
    meta.change((d) => {
      for (const list of [d.objectShardUrls, d.editsObjectShardUrls]) {
        const at = list.indexOf(p.retiredUrl)
        if (at >= 0) list.splice(at, 1)
      }
    })
    await witnessedGc(p.ws.repo)
    await expectSwept(p.ws.repo, p.retired)
  }, 120_000)

  it('PARKED: a late write at exactly its park watermark + 1 is carried', async () => {
    const p = await parkedFixture(res, log)
    // The park's watermark is the head's highest stored arrival.
    const watermark = String(await maxSeqOf(p.retired))
    await db.pool.query("SELECT setval('automerge_arrival_seq', $1::bigint)", [watermark])
    await lateWrite(p.ws.repo, p.retiredUrl, p.offline, 'late', 'adjacent-parked')
    expect(await maxSeqOf(p.retired)).toBe(BigInt(watermark) + 1n)
    expect(await roNamed('late', 'adjacent-parked')).toBe('adjacent-parked')
  }, 120_000)

  it('PARKED: the lease goes back after the forward, and idle polls reload nothing', async () => {
    const p = await parkedFixture(res, log)
    const mark = log.events('read_model.ordinary_fold_arrival_poll_summary').length
    await lateWrite(p.ws.repo, p.retiredUrl, p.offline, 'late', 'x')
    expect(await roNamed('late', 'x')).toBe('x')
    expect(await until(async () => { await p.residency.drain(); return !p.residency.isLeased(p.retired) }, Boolean, 10_000)).toBe(true)
    await settle(1_500)
    p.stop()
    await settle(300)
    expect(loadedSince(log, mark)).toBeLessThanOrEqual(3)
  }, 120_000)
})
