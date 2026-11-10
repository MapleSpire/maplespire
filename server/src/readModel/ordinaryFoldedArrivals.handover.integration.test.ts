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
import { randomUUID } from 'node:crypto'
import pg, { type PoolClient } from 'pg'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import { cachedHandles } from '../automergeRepoCompat.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { ensureReadModelSchema } from './schema.js'
import { startReadModelProjector } from './projectorService.js'
import type { OrdinaryHeadRotationConfig } from './ordinaryHeadRotation.js'
import type { WorkspaceKey } from './projector.js'
import { handoverBarrierTimeoutCount, handoverRecheckAbandonedCount } from './ordinaryFoldedArrivals.js'
import { storageWriteApplication } from '../db.js'

/**
 * G4-16d: a late write to a retired head (folded, parked, watched) across an
 * OWNERSHIP HANDOVER, and the handover re-check that carries it.
 *
 * Two cells on one storage: the OLD cell (its Repo, its projector) and the NEW
 * one (another Repo over its own adapter, another projector). The old cell's
 * save of a late client write draws its `arrival_seq` (the `nextval` in the
 * INSERT), and only COMMITS after the new cell has read a higher arrival of
 * the same head — its own client's write — forwarded it and moved the head's
 * watermark past it. In production that is a FENCED save whose statement
 * snapshot predates the new fence (`automergeStorage.ts`: the fence check does
 * not lock the ownership row). These adapters have no ownership configured, so
 * the statement is the UNFENCED variant of the same INSERT; what the test
 * models is its timing — a transaction open around the adapter's own
 * statement, after PostgreSQL drew the sequence, exactly where production
 * draws it. The old write then sits BELOW the watermark, and no poll asks
 * about it again.
 *
 * THE GATE. The re-check waits for no client backend to run a transaction
 * older than the attach (the barrier, `handoverBarrierBlockers`). A
 * transaction a test opens BEFORE the new cell attaches holds the re-check
 * back until the test commits it: the race below runs first, deterministically,
 * with a short delay knob. The barrier test uses the old cell's own held save
 * as that transaction.
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-ofah', versionId: 'v1' }
const LISTED = `${WS.landscapeId}/${WS.versionId}`
const THRESHOLD = 4
/** The re-check delay knob the tests run with; the jitter adds up to half. */
const RECHECK_MS = 300
const RECHECK_LATEST_MS = RECHECK_MS * 1.5

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
type Pool = IsolatedSchemaDb['pool']

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

/**
 * The old cell's storage pool: the real pool, except that ONE content chunk
 * INSERT for the held document runs inside an open transaction — the sequence
 * is drawn, the row is written, and the COMMIT waits for `release()`.
 * `release()` is idempotent and safe in a `finally`.
 */
function holdingPool(base: Pool) {
  let heldDocumentId: string | null = null
  let drawn: () => void = () => {}
  let open: () => void = () => {}
  let gate: Promise<void> = Promise.resolve()
  const wrap = (client: PoolClient): PoolClient => new Proxy(client, {
    get(target, prop) {
      if (prop === 'query') {
        return async (...args: unknown[]) => {
          const text = typeof args[0] === 'string' ? args[0] : ''
          const params = args[1] as unknown[] | undefined
          const id = heldDocumentId
          const key = typeof params?.[0] === 'string' ? params[0] as string : ''
          if (id && text.includes('INSERT INTO automerge_storage') && key.startsWith(`${id}/`)
            && /\/(incremental|snapshot)\//.test(key)) {
            heldDocumentId = null
            await target.query('BEGIN')
            try {
              const result = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args)
              drawn()
              await gate
              await target.query('COMMIT')
              return result
            } catch (error) {
              await target.query('ROLLBACK').catch(() => undefined)
              throw error
            }
          }
          return (target.query as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
  const pool = new Proxy(base, {
    get(target, prop) {
      if (prop === 'connect') return async () => wrap(await target.connect())
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  }) as Pool
  return {
    pool,
    /** Arm the hold; resolves once the held INSERT has drawn its sequence. */
    hold(documentId: string): Promise<void> {
      heldDocumentId = documentId
      gate = new Promise((resolve) => { open = resolve })
      return new Promise((resolve) => { drawn = resolve })
    },
    release: () => open(),
  }
}

/** The new cell's projector pool, with a hook in front of `query` (connect()
 * and the rest pass through, so `isPool` and transactions still work). */
function hookedPool(
  hook: (sql: string, params: unknown[] | undefined) => Promise<void> | void,
  /** Sees each result, after the query and before the caller does. */
  after?: (sql: string, rows: unknown[]) => void,
) {
  return new Proxy(db.pool, {
    get(target, prop) {
      if (prop === 'query') {
        return async (...args: unknown[]) => {
          const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '')
          await hook(text, args[1] as unknown[] | undefined)
          const result = await (target.query as (...a: unknown[]) => Promise<{ rows?: unknown[] }>)(...args)
          after?.(text, result?.rows ?? [])
          return result
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  }) as Pool
}
const isBarrierQuery = (sql: string) => sql.includes('pg_stat_activity')
const isChunksRead = (sql: string) => sql.includes('SELECT data, arrival_seq::text AS seq FROM automerge_storage')
const isRetirementsRead = (sql: string) =>
  sql.includes('status, folded_into') && sql.includes('FROM read_model_ordinary_head_retirements') && !sql.includes('document_id = $')
const isFoldedPoll = (sql: string) => sql.includes('CROSS JOIN LATERAL') && sql.includes('arrival_watermark')

/** A transaction opened NOW and held: the barrier counts it until `release`. */
async function gate(pool: Pool) {
  const client = await pool.connect()
  await client.query('BEGIN')
  await client.query('SELECT txid_current()')
  let released = false
  return {
    release: async () => {
      if (released) return
      released = true
      try { await client.query('COMMIT') } finally { client.release() }
    },
  }
}

function storageRepo(pool: Pool = db.pool) {
  return new Repo({ storage: new PostgresStorageAdapter({ db: pool }), network: [], saveDebounceRate: 60_000 })
}

interface Workspace {
  repo: Repo
  rootUrl: string
  meta: DocHandle<Meta>
  head: DocHandle<ObjHead>
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
  const registry = repo.create({ diagrams: {} })
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
  return { repo, rootUrl: root.url, meta, head }
}

function config(fold: boolean): OrdinaryHeadRotationConfig {
  return {
    mode: 'on', allowlist: new Set([LISTED]), maxActors: 1_000_000, maxChanges: THRESHOLD,
    ...(fold ? { chainFold: { minChain: 2, budget: 8, retainMs: 86_400_000 } } : {}),
  }
}
function start(
  repo: Repo, rootUrl: string,
  opts: { fold?: boolean; rotation?: OrdinaryHeadRotationConfig | undefined; residency?: AutomergeResidencyLeases; pool?: Pool } = {},
) {
  return startReadModelProjector(
    repo, rootUrl, opts.pool ?? db.pool, WS, opts.residency, 0, undefined,
    undefined, undefined, undefined, 'rotation' in opts ? opts.rotation : config(opts.fold ?? false),
  )
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

const currentHead = (meta: DocHandle<Meta>) => meta.doc()!.editsObjectShardUrl
const docId = (url: string) => url.replace(/^automerge:/, '')
const resident = (repo: Repo, id: string) => Object.prototype.hasOwnProperty.call(cachedHandles(repo), id)
const roObject = async (id: string) => (await db.pool.query<{ data: Record<string, unknown> }>(
  'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
  [WS.landscapeId, WS.versionId, id],
)).rows[0]?.data
const foldedWatermark = async (documentId: string) => (await db.pool.query<{ w: string | null }>(
  `SELECT arrival_watermark::text AS w FROM read_model_ordinary_head_retirements
    WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3 AND status = 'folded'`,
  [WS.landscapeId, WS.versionId, documentId],
)).rows[0]?.w ?? null
/** The highest content arrival of a document, committed so far. */
const maxArrival = async (documentId: string) => (await db.pool.query<{ s: string | null }>(
  `SELECT max(arrival_seq)::text AS s FROM automerge_storage
    WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) IN ('snapshot', 'incremental')`,
  [documentId],
)).rows[0]?.s ?? null
/** key -> arrival of every committed content chunk of a document: the race
 * finds the two chunks it added by set difference. */
const contentKeys = async (documentId: string) => new Map((await db.pool.query<{ key: string; s: string }>(
  `SELECT key, arrival_seq::text AS s FROM automerge_storage
    WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) IN ('snapshot', 'incremental')`,
  [documentId],
)).rows.map((row) => [row.key, row.s]))

async function fillAndRotate(ws: { repo: Repo; meta: DocHandle<Meta> }, tag: string): Promise<string> {
  const url = currentHead(ws.meta)
  const head = await ws.repo.find<ObjHead>(url as AutomergeUrl)
  let index = 0
  while (A.stats(head.doc() as A.Doc<unknown>).numChanges < THRESHOLD) {
    head.change((d) => { d.objects[`n${index}`] = { id: `n${index}`, name: `${tag}-${index}`, type: 'system' } })
    index += 1
  }
  const next = await until(() => currentHead(ws.meta), (now) => now !== url, 45_000)
  expect(next).not.toBe(url)
  return docId(url)
}

const OLD = { id: 'old-cell', name: 'from the old cell', type: 'system' }
const NEW = { id: 'new-cell', name: 'from the new cell', type: 'system' }

suite('G4-16d late write across an ownership handover — two cells, one storage, PostgreSQL', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'ordinary_folded_arrivals_handover')
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
  /** Run at the end of every test, whatever happened: held transactions
   * committed, projectors stopped, Repos shut down, logs restored. */
  let teardown: Array<() => unknown> = []
  beforeEach(async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.pool.query(`TRUNCATE automerge_storage, automerge_document_workspace, ro_objects, ro_connections, ro_groups,
          read_model_projection_state, read_model_change_events, read_model_overlay_batch_acks,
          read_model_overlay_entity_bases, read_model_ordinary_head_retirements, read_model_document_watermarks,
          read_model_ordinary_chain_folds`)
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
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    process.env.AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS = String(RECHECK_MS)
  })
  afterEach(async () => {
    for (const fn of teardown.reverse()) {
      try { await fn() } catch { /* best effort: the next one still runs */ }
    }
    teardown = []
    restoreRegistration()
    delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    delete process.env.AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS
    delete process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS
  })
  /** A pool of ANOTHER process's storage writes, for the barrier: tagged
   * like `storageWritePoolConfig` tags one, with a boot id of its own. Ended
   * after everything else at teardown. */
  const taggedPool = (label: string): Pool => {
    const tagged = guardIdleClientErrors(new pg.Pool({
      connectionString: connection!, max: 6, options: `-c search_path=${db.schema}`,
      application_name: `ms-storage:${label}:${randomUUID()}`,
    }), `handover-test:${label}`)
    teardown.unshift(() => tagged.end())
    return tagged
  }
  /** Registered for teardown, in order; run in reverse. */
  const later = <T extends () => unknown>(fn: T): T => { teardown.push(fn); return fn }
  const repoFor = (pool?: Pool) => {
    const repo = storageRepo(pool)
    later(() => repo.shutdown())
    return repo
  }
  const capture = () => {
    const log = logLines()
    later(() => log.restore())
    return log
  }
  /** Start a projector whose stop runs at teardown too (idempotent). */
  const startTracked = async (...args: Parameters<typeof start>) => {
    const stop = await start(...args)
    later(stop)
    return stop
  }

  /** Old cell: workspace, two rotations, both retired heads folded. */
  async function foldedOnOldCell(oldRepo: Repo, log: ReturnType<typeof logLines>) {
    const ws = await workspace(oldRepo)
    const stopOld = await startTracked(oldRepo, ws.rootUrl, { fold: true })
    const folded = ws.head.documentId as string
    await fillAndRotate(ws, 'h0')
    await fillAndRotate(ws, 'h1')
    await until(() => log.events('read_model.ordinary_fold_source_detached').length, (n) => n >= 2, 30_000)
    expect(log.events('read_model.ordinary_fold_source_detached').length).toBeGreaterThanOrEqual(2)
    await until(() => foldedWatermark(folded), (w) => w !== null, 15_000)
    await oldRepo.flush()
    return { ws, stopOld, folded }
  }
  /** Old cell, fold off: workspace, one rotation. */
  async function retiredOnOldCell(oldRepo: Repo) {
    const ws = await workspace(oldRepo)
    const stopOld = await startTracked(oldRepo, ws.rootUrl, { residency: new AutomergeResidencyLeases(oldRepo) })
    const retired = await fillAndRotate(ws, 'h0')
    await oldRepo.flush()
    return { ws, stopOld, retired }
  }

  /** The old cell's client writes `old-cell` into its copy of the head and
   * its save draws arrival x, uncommitted. */
  async function oldSaveDrawn(held: ReturnType<typeof holdingPool>, oldRepo: Repo, id: string) {
    const before = await contentKeys(id)
    const drawn = held.hold(id)
    const oldCopy = await oldRepo.find<ObjHead>(`automerge:${id}` as AutomergeUrl)
    oldCopy.change((d) => { d.objects[OLD.id] = OLD })
    const saved = oldRepo.flush([oldCopy.documentId])
    await drawn
    return { before, saved }
  }
  /** The new cell's client writes `new-cell` into the same head: arrival
   * y > x, committed; the new cell forwards it (its row appears) and its
   * watermark for the head reaches y. */
  async function newCellWrite(newRepo: Repo, id: string, watermarkOnNewCell: () => Promise<string | null>) {
    const newCopy = await newRepo.find<ObjHead>(`automerge:${id}` as AutomergeUrl)
    newCopy.change((d) => { d.objects[NEW.id] = NEW })
    await newRepo.flush([newCopy.documentId])
    const y = await maxArrival(id)
    expect((await until(() => roObject(NEW.id), (row) => row !== undefined, 15_000))?.name).toBe(NEW.name)
    const watermark = await until(watermarkOnNewCell, (w) => w !== null && BigInt(w) >= BigInt(y!), 15_000)
    expect(BigInt(watermark!)).toBeGreaterThanOrEqual(BigInt(y!))
    return BigInt(watermark!)
  }
  /** The old save commits; asserts THE HAZARD: x below the new watermark. */
  async function oldSaveCommits(
    held: ReturnType<typeof holdingPool>, id: string,
    drawnSave: { before: Map<string, string>; saved: Promise<void> }, watermark: bigint,
  ) {
    held.release()
    await drawnSave.saved
    const added = [...(await contentKeys(id)).entries()].filter(([key]) => !drawnSave.before.has(key))
    // Two new chunks: the old cell's (x) and the new cell's (y).
    expect(added).toHaveLength(2)
    const x = added.map(([, seq]) => BigInt(seq)).sort((a, b) => (a < b ? -1 : 1))[0]!
    expect(x).toBeLessThan(watermark)
    return x
  }
  /** The whole race, the re-check held back by `gate`. */
  async function race(
    held: ReturnType<typeof holdingPool>, oldRepo: Repo, newRepo: Repo, id: string,
    watermarkOnNewCell: () => Promise<string | null>,
  ) {
    const drawnSave = await oldSaveDrawn(held, oldRepo, id)
    const watermark = await newCellWrite(newRepo, id, watermarkOnNewCell)
    return oldSaveCommits(held, id, drawnSave, watermark)
  }
  /** A parked head's watermark is in memory, not in a row. Its stand-in: once
   * the new cell's write is projected (only the parked poll forwards it: the
   * head is not watched), the highest committed arrival — y, the one that poll
   * read before loading and set the watermark to. */
  const parkedWatermarkStandIn = (id: string) => async () => (await roObject(NEW.id) ? maxArrival(id) : null)
  const rechecksOf = (log: ReturnType<typeof logLines>) => () => log.events('read_model.ordinary_handover_recheck').length
  /** Two fold rows the fold-row sweep may take: `fk-s1` (expired) folded
   * into `fk-p`, itself folded long enough ago. No document behind them:
   * the re-check owes them, then forgets them (unknown). */
  const seedSweepable = () => db.pool.query(
    `INSERT INTO read_model_ordinary_head_retirements
       (landscape_id, version_id, collection, document_id, retirement_heads, forwarded_heads, status, folded_into, retain_until, updated_at)
     VALUES ($1, $2, 'object', 'fk-s1', ARRAY['h']::text[], ARRAY['h']::text[], 'folded', 'fk-p', now() - interval '1 hour', now() - interval '1 hour'),
            ($1, $2, 'object', 'fk-p', ARRAY['h']::text[], ARRAY['h']::text[], 'folded', 'fk-q', now() + interval '1 day', now() - interval '1 hour')`,
    [WS.landscapeId, WS.versionId],
  )
  const rowPresent = async (documentId: string) => ((await db.pool.query(
    'SELECT 1 FROM read_model_ordinary_head_retirements WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3',
    [WS.landscapeId, WS.versionId, documentId],
  )).rowCount ?? 0) > 0

  it('FOLDED head: an old-cell save drawn before, committed after the new cell moved the watermark, is still projected', async () => {
    const held = holdingPool(taggedPool('old'))
    later(() => held.release())
    const oldRepo = repoFor(held.pool)
    const log = capture()
    const { ws, stopOld, folded } = await foldedOnOldCell(oldRepo, log)
    // HANDOVER: the old projector stops; the new cell attaches over the same
    // storage with its own Repo and adapter, the re-check held by the gate.
    stopOld()
    const rechecks = rechecksOf(log)
    const byOld = rechecks()
    const held2 = await gate(taggedPool('gate'))
    later(held2.release)
    const newRepo = repoFor()
    const stopNew = await startTracked(newRepo, ws.rootUrl, { fold: true })
    const x = await race(held, oldRepo, newRepo, folded, () => foldedWatermark(folded))
    // The new cell's handle holds the head (its client wrote into it): only a
    // merge from storage can bring x in.
    expect(resident(newRepo, folded)).toBe(true)
    await settle(RECHECK_LATEST_MS + 300)
    expect(rechecks()).toBe(byOld) // the gate held it
    // A watermark ABOVE everything the re-check will read: it must stay.
    const raised = String(BigInt((await foldedWatermark(folded))!) + 1_000n)
    await db.pool.query(
      `UPDATE read_model_ordinary_head_retirements SET arrival_watermark = $4::bigint
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [WS.landscapeId, WS.versionId, folded, raised],
    )

    await held2.release()
    const row = await until(() => roObject(OLD.id), (value) => value !== undefined, 20_000)
    expect(row?.name).toBe(OLD.name)
    expect(rechecks()).toBe(byOld + 1)
    // Carried into the CURRENT head of the new cell, as any late write is.
    const meta = await newRepo.find<Meta>(ws.meta.url)
    const current = await newRepo.find<ObjHead>(currentHead(meta) as AutomergeUrl)
    expect(current.doc()!.objects[OLD.id]).toMatchObject({ name: OLD.name })
    // And the watermark is never lowered: not below what covered x, nor
    // below the raised value, which no arrival reached.
    expect(BigInt((await foldedWatermark(folded))!)).toBeGreaterThan(x)
    expect(await foldedWatermark(folded)).toBe(raised)
    // The poll's cost (logged at stop): the re-checked head counted as a
    // re-check row, not as an expired one.
    const summariesBefore = log.events('read_model.ordinary_fold_arrival_poll_summary').length
    stopNew()
    const summaries = log.events('read_model.ordinary_fold_arrival_poll_summary').slice(summariesBefore)
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    expect(summaries.reduce((n, line) => n + Number(line.recheckRows), 0)).toBeGreaterThanOrEqual(1)
    expect(summaries.reduce((n, line) => n + Number(line.expiredRows), 0)).toBe(0)
  }, 180_000)

  it('BARRIER: an old-cell save drawn BEFORE the new cell attached holds the re-check until it commits; then it is projected', async () => {
    const held = holdingPool(taggedPool('old'))
    later(() => held.release())
    const oldRepo = repoFor(held.pool)
    const log = capture()
    const { ws, stopOld, folded } = await foldedOnOldCell(oldRepo, log)
    // The old cell's save is drawn while it still owns, and is still open
    // when the new cell attaches: the delay alone would re-check too early.
    const drawnSave = await oldSaveDrawn(held, oldRepo, folded)
    stopOld()
    const rechecks = rechecksOf(log)
    const byOld = rechecks()
    const newRepo = repoFor()
    await startTracked(newRepo, ws.rootUrl, { fold: true })
    const watermark = await newCellWrite(newRepo, folded, () => foldedWatermark(folded))
    // Several delays later, the re-check still waits: the old save is open.
    await settle(RECHECK_LATEST_MS * 3)
    expect(rechecks()).toBe(byOld)
    await oldSaveCommits(held, folded, drawnSave, watermark)
    const row = await until(() => roObject(OLD.id), (value) => value !== undefined, 20_000)
    expect(row?.name).toBe(OLD.name)
    expect(rechecks()).toBe(byOld + 1)
  }, 180_000)

  it('BARRIER TIMEOUT: an old save that never commits does not hold the re-check for ever; the ONE follow-up catches its late commit', async () => {
    // 20 s: the new cell's write below must be forwarded (its watermark past
    // the old save) before the first maximum wait ends, and the old save
    // committed before the follow-up's. With 8 s, the test failed once in a
    // 46-file run after 16.7 s — two maximum waits — which reads as that
    // write outliving both (not measured directly).
    process.env.AM_ORDINARY_FOLD_HANDOVER_BARRIER_MAX_WAIT_MS = '20000'
    later(() => { delete process.env.AM_ORDINARY_FOLD_HANDOVER_BARRIER_MAX_WAIT_MS })
    const held = holdingPool(taggedPool('old'))
    later(() => held.release())
    const oldRepo = repoFor(held.pool)
    const log = capture()
    const { ws, stopOld, folded } = await foldedOnOldCell(oldRepo, log)
    const drawnSave = await oldSaveDrawn(held, oldRepo, folded)
    stopOld()
    // Rows the fold-row sweep could take: held until the FOLLOW-UP ran.
    await seedSweepable()
    const recheckEvents = () => log.events('read_model.ordinary_handover_recheck')
    const byOld = recheckEvents().length
    const reasons = () => recheckEvents().slice(byOld).map((line) => line.reason)
    const why = () => JSON.stringify({
      reasons: reasons(),
      failed: log.events('read_model.ordinary_handover_recheck_failed'),
      timeouts: log.events('read_model.ordinary_handover_recheck_barrier_timeout').length,
    })
    const timeoutsBefore = handoverBarrierTimeoutCount()
    const timeoutLines = log.events('read_model.ordinary_handover_recheck_barrier_timeout').length
    const newRepo = repoFor()
    await startTracked(newRepo, ws.rootUrl, { fold: true })
    const watermark = await newCellWrite(newRepo, folded, () => foldedWatermark(folded))
    // The maximum wait is reached with the old save still open: logged,
    // counted, and the re-check RUNS.
    expect(await until(() => recheckEvents().length, (n) => n > byOld, 60_000), why()).toBe(byOld + 1)
    expect(reasons(), why()).toEqual(['barrier-timeout'])
    expect(handoverBarrierTimeoutCount()).toBe(timeoutsBefore + 1)
    expect(log.events('read_model.ordinary_handover_recheck_barrier_timeout').length).toBe(timeoutLines + 1)
    expect(await roObject(OLD.id)).toBeUndefined()
    // Between the first re-check and the follow-up the sweep is still held.
    await settle(500)
    expect(await rowPresent('fk-s1')).toBe(true)
    // The save commits AFTER that re-check: the follow-up, on the barrier
    // clearing, carries it.
    await oldSaveCommits(held, folded, drawnSave, watermark)
    const row = await until(() => roObject(OLD.id), (value) => value !== undefined, 20_000)
    expect(row?.name).toBe(OLD.name)
    expect(await until(reasons, (r) => r.length >= 2, 10_000), why()).toEqual(['barrier-timeout', 'follow-up'])
    // Released after the follow-up: the deferred sweep runs, unasked.
    expect(await until(() => rowPresent('fk-s1'), (v) => !v, 20_000)).toBe(false)
    // ONE follow-up, no more (nothing else is ever scheduled).
    await settle(3_000)
    expect(reasons(), why()).toEqual(['barrier-timeout', 'follow-up'])
  }, 180_000)

  it('the re-check timer firing DURING a running poll does not lose the owed folded head', async () => {
    const held = holdingPool(taggedPool('old'))
    later(() => held.release())
    const oldRepo = repoFor(held.pool)
    const log = capture()
    const { ws, stopOld, folded } = await foldedOnOldCell(oldRepo, log)
    stopOld()
    const rechecks = rechecksOf(log)
    const byOld = rechecks()
    // Hold the next folded poll's query until the re-check has filled the
    // owed set: that poll started with nothing owed.
    let holdPolls = false
    let pollHeld = false
    const pool = hookedPool(async (sql) => {
      if (!holdPolls || !isFoldedPoll(sql)) return
      holdPolls = false
      pollHeld = true
      await until(rechecks, (n) => n > byOld, 20_000)
      await settle(100)
    })
    const held2 = await gate(taggedPool('gate'))
    later(held2.release)
    const newRepo = repoFor()
    await startTracked(newRepo, ws.rootUrl, { fold: true, pool })
    await race(held, oldRepo, newRepo, folded, () => foldedWatermark(folded))
    holdPolls = true
    expect(await until(() => pollHeld, (v) => v, 10_000)).toBe(true)
    await held2.release()
    expect(await until(rechecks, (n) => n > byOld, 20_000)).toBe(byOld + 1)
    const row = await until(() => roObject(OLD.id), (value) => value !== undefined, 20_000)
    expect(row?.name).toBe(OLD.name)
  }, 180_000)

  it('PARKED head, evicted (fold off): the old-cell save committed below the parked watermark is still projected', async () => {
    process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS = '300'
    const held = holdingPool(taggedPool('old'))
    later(() => held.release())
    const oldRepo = repoFor(held.pool)
    const log = capture()
    const { ws, stopOld, retired } = await retiredOnOldCell(oldRepo)
    stopOld()
    const parks = () => log.events('read_model.ordinary_retired_head_parked')
      .filter((line) => docId(String(line.url)) === retired).length
    const parkedByOld = parks()
    const rechecks = rechecksOf(log)
    const byOld = rechecks()
    const held2 = await gate(taggedPool('gate'))
    later(held2.release)
    const newRepo = repoFor()
    const residency = new AutomergeResidencyLeases(newRepo)
    await startTracked(newRepo, ws.rootUrl, { residency })
    // The NEW cell parks the retired head (its own watcher, its own sweep).
    expect(await until(parks, (n) => n > parkedByOld, 15_000)).toBeGreaterThan(parkedByOld)
    await race(held, oldRepo, newRepo, retired, parkedWatermarkStandIn(retired))
    // Still parked: the new cell's write went through the parked poll; and
    // evicted, so the re-check's load reads storage afresh.
    expect(log.events('read_model.ordinary_retired_head_unparked')).toHaveLength(0)
    expect(await until(async () => { await residency.drain(); return resident(newRepo, retired) }, (v) => !v, 10_000)).toBe(false)
    expect(rechecks()).toBe(byOld)

    await held2.release()
    const row = await until(() => roObject(OLD.id), (value) => value !== undefined, 20_000)
    expect(row?.name).toBe(OLD.name)
    expect(rechecks()).toBe(byOld + 1)
  }, 180_000)

  it('PARKED head kept RESIDENT by another lease: the re-check merges storage into the stale handle', async () => {
    process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS = '300'
    const held = holdingPool(taggedPool('old'))
    later(() => held.release())
    const oldRepo = repoFor(held.pool)
    const log = capture()
    const { ws, stopOld, retired } = await retiredOnOldCell(oldRepo)
    stopOld()
    const parks = () => log.events('read_model.ordinary_retired_head_parked')
      .filter((line) => docId(String(line.url)) === retired).length
    const parkedByOld = parks()
    const rechecks = rechecksOf(log)
    const byOld = rechecks()
    const held2 = await gate(taggedPool('gate'))
    later(held2.release)
    const newRepo = repoFor()
    const residency = new AutomergeResidencyLeases(newRepo)
    await startTracked(newRepo, ws.rootUrl, { residency })
    // Another holder (a connected peer, say) keeps the head resident.
    const pinned = await newRepo.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
    residency.acquire(pinned as DocHandle<unknown>, 'test-peer', LISTED)
    expect(await until(parks, (n) => n > parkedByOld, 15_000)).toBeGreaterThan(parkedByOld)
    await race(held, oldRepo, newRepo, retired, parkedWatermarkStandIn(retired))
    expect(log.events('read_model.ordinary_retired_head_unparked')).toHaveLength(0)
    await residency.drain()
    expect(resident(newRepo, retired)).toBe(true)
    // The resident handle does not hold the old write.
    expect(pinned.doc()!.objects[OLD.id]).toBeUndefined()
    expect(rechecks()).toBe(byOld)

    await held2.release()
    const row = await until(() => roObject(OLD.id), (value) => value !== undefined, 20_000)
    expect(row?.name).toBe(OLD.name)
    expect(pinned.doc()!.objects[OLD.id]).toMatchObject({ name: OLD.name })
  }, 180_000)

  it('WATCHED retired head (fold off, no parking, no poll running): the merge reaches its watcher, a failed read is retried', async () => {
    process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS = '0'
    const oldRepo = repoFor()
    const log = capture()
    const { ws, stopOld, retired } = await retiredOnOldCell(oldRepo)
    stopOld()
    const rechecks = rechecksOf(log)
    const byOld = rechecks()
    let failChunksRead = false
    let failed = 0
    let foldedPolls = 0
    const pool = hookedPool((sql, params) => {
      if (isFoldedPoll(sql)) foldedPolls += 1
      if (failChunksRead && isChunksRead(sql) && params?.[0] === retired) {
        failChunksRead = false
        failed += 1
        throw new Error('injected chunks read failure')
      }
    })
    const held2 = await gate(taggedPool('gate'))
    later(held2.release)
    const newRepo = repoFor()
    await startTracked(newRepo, ws.rootUrl, { pool, residency: new AutomergeResidencyLeases(newRepo) })
    // The new cell watches the retired head: loaded now, before the old write.
    await until(() => resident(newRepo, retired), (v) => v, 10_000)
    const oldCopy = await oldRepo.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
    oldCopy.change((d) => { d.objects[OLD.id] = OLD })
    await oldRepo.flush([oldCopy.documentId])
    await settle(RECHECK_LATEST_MS + 300)
    // Nothing carries it: no watcher event (another process wrote it), no
    // poll (fold off, nothing parked, no folded row).
    expect(await roObject(OLD.id)).toBeUndefined()
    expect(foldedPolls).toBe(0)
    expect(rechecks()).toBe(byOld)

    failChunksRead = true
    await held2.release()
    const row = await until(() => roObject(OLD.id), (value) => value !== undefined, 20_000)
    expect(row?.name).toBe(OLD.name)
    expect(failed).toBe(1)
    expect(log.events('read_model.ordinary_handover_recheck_failed')
      .filter((line) => line.documentId === retired)).toHaveLength(1)
  }, 180_000)

  // ---- G4-16 M3 review: a fold (or a park) of a head the re-check owes ----

  /** Old cell, fold ON: one rotation, so one retired head the fold cannot
   * take yet (MIN 2). */
  async function oneRetiredOnOldCellFoldOn(oldRepo: Repo) {
    const ws = await workspace(oldRepo)
    const stopOld = await startTracked(oldRepo, ws.rootUrl, { fold: true, residency: new AutomergeResidencyLeases(oldRepo) })
    const retired = await fillAndRotate(ws, 'h0')
    await oldRepo.flush()
    return { ws, stopOld, retired }
  }
  /** The old cell's client writes `old-cell` into the head, committed: in
   * storage, not in the new cell's handle (loaded before). */
  async function oldWriteCommitted(oldRepo: Repo, id: string) {
    const oldCopy = await oldRepo.find<ObjHead>(`automerge:${id}` as AutomergeUrl)
    oldCopy.change((d) => { d.objects[OLD.id] = OLD })
    await oldRepo.flush([oldCopy.documentId])
  }
  const detachedLines = (log: ReturnType<typeof logLines>, id: string) =>
    log.events('read_model.ordinary_fold_source_detached').filter((line) => docId(String(line.url)) === id)

  it('FOLD before the re-check: the new cell folds and detaches the source before the re-check runs; the old cell\'s write still reaches its row', async () => {
    const oldRepo = repoFor()
    const log = capture()
    const { ws, stopOld, retired } = await oneRetiredOnOldCellFoldOn(oldRepo)
    stopOld()
    const rechecks = rechecksOf(log)
    const byOld = rechecks()
    const held2 = await gate(taggedPool('gate'))
    later(held2.release)
    const newRepo = repoFor()
    const residency = new AutomergeResidencyLeases(newRepo)
    await startTracked(newRepo, ws.rootUrl, { fold: true, residency })
    await until(() => resident(newRepo, retired), (v) => v, 10_000)
    await oldWriteCommitted(oldRepo, retired)
    // The new cell rotates once more: the fold takes the retired head and
    // detaches it, its re-check still held by the gate.
    const newMeta = await newRepo.find<Meta>(ws.meta.url)
    await fillAndRotate({ repo: newRepo, meta: newMeta }, 'h1')
    expect(await until(() => detachedLines(log, retired).length, (n) => n >= 1, 30_000)).toBe(1)
    await until(async () => { await residency.drain(); return resident(newRepo, retired) }, (v) => !v, 10_000)
    expect(await roObject(OLD.id)).toBeUndefined()
    expect(rechecks()).toBe(byOld)

    await held2.release()
    const row = await until(() => roObject(OLD.id), (value) => value !== undefined, 20_000)
    expect(row?.name).toBe(OLD.name)
  }, 180_000)

  it('FOLD DURING the re-check (QA): a change that reaches the OWED source after its watcher stopped is saved by the detach\'s flush and carried', async () => {
    const oldRepo = repoFor()
    const log = capture()
    const { ws, stopOld, retired } = await oneRetiredOnOldCellFoldOn(oldRepo)
    stopOld()
    // As the test below: the re-check's chunk read for the watched head
    // returns only once the fold has detached it, so the head is owed (its
    // re-check in flight) when the detach samples it.
    let holdChunks = true
    let chunksHeld = false
    const pool = hookedPool(async (sql, params) => {
      if (!holdChunks || !isChunksRead(sql) || params?.[0] !== retired) return
      holdChunks = false
      chunksHeld = true
      await until(() => detachedLines(log, retired).length, (n) => n >= 1, 30_000)
    })
    const held2 = await gate(taggedPool('gate'))
    later(held2.release)
    const newRepo = repoFor()
    const residency = new AutomergeResidencyLeases(newRepo)
    await startTracked(newRepo, ws.rootUrl, { fold: true, residency, pool })
    await until(() => resident(newRepo, retired), (v) => v, 10_000)
    await held2.release()
    expect(await until(() => chunksHeld, (v) => v, 15_000)).toBe(true)
    const newMeta = await newRepo.find<Meta>(ws.meta.url)
    // A change reaches the OWED source's handle once its watcher is stopped
    // (the detach's own), in memory only.
    const originalFlush = newRepo.flush.bind(newRepo)
    let injected = false
    let watcherStopped = false
    const listed = (id: string) => newMeta.doc()!.objectShardUrls.some((url) => docId(url) === id)
    const owedHandle = await newRepo.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
    const originalOff = owedHandle.off.bind(owedHandle) as (...args: unknown[]) => unknown
    const offSpy = vi.spyOn(owedHandle, 'off').mockImplementation(((...args: unknown[]) => {
      if (args[0] === 'change' && !listed(retired)) watcherStopped = true
      return originalOff(...args)
    }) as unknown as typeof owedHandle.off)
    later(() => offSpy.mockRestore())
    // What was flushed from the injection on, as of the moment the detach is
    // LOGGED (synchronously after its leases are released): the residency's
    // own flush of an unsaved document comes later and must not count.
    const flushedAfter: string[] = []
    let flushedAtDetachLog: string[] | null = null
    const realLog = console.log
    console.log = (...args: unknown[]) => {
      if (flushedAtDetachLog === null && typeof args[0] === 'string' && args[0].includes('ordinary_fold_source_detached') && args[0].includes(retired)) {
        flushedAtDetachLog = [...flushedAfter]
      }
      return realLog(...args)
    }
    later(() => { console.log = realLog })
    const flushSpy = vi.spyOn(newRepo, 'flush').mockImplementation(async (ids) => {
      if (injected) flushedAfter.push(...(ids ?? []).map(String))
      // The first flush after the source's watcher was stopped: the detach's.
      if (!injected && watcherStopped) {
        injected = true
        const copy = await newRepo.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
        copy.change((d) => { d.objects[NEW.id] = NEW })
      }
      return originalFlush(ids)
    })
    later(() => flushSpy.mockRestore())
    await fillAndRotate({ repo: newRepo, meta: newMeta }, 'h1')
    const detached = await until(() => detachedLines(log, retired), (lines) => lines.length >= 1, 30_000)
    expect(injected).toBe(true)
    expect(detached[0]!.watermark).toBeNull() // owed when detached
    // The detach itself flushed the OWED source (not only the settled ones).
    expect(flushedAtDetachLog).toContain(retired)
    const row = await until(() => roObject(NEW.id), (value) => value !== undefined, 20_000)
    expect(row?.name).toBe(NEW.name)
  }, 180_000)

  it('FOLD DURING the re-check: a source detached while its re-check merge is in flight stays owed, and the old cell\'s write still reaches its row', async () => {
    const oldRepo = repoFor()
    const log = capture()
    const { ws, stopOld, retired } = await oneRetiredOnOldCellFoldOn(oldRepo)
    stopOld()
    // The watched head's re-check read of its chunks returns only once the
    // fold has detached (and evicted) it.
    let holdChunks = true
    let chunksHeld = false
    const pool = hookedPool(async (sql, params) => {
      if (!holdChunks || !isChunksRead(sql) || params?.[0] !== retired) return
      holdChunks = false
      chunksHeld = true
      await until(() => detachedLines(log, retired).length, (n) => n >= 1, 30_000)
    })
    const held2 = await gate(taggedPool('gate'))
    later(held2.release)
    const newRepo = repoFor()
    const residency = new AutomergeResidencyLeases(newRepo)
    await startTracked(newRepo, ws.rootUrl, { fold: true, residency, pool })
    await until(() => resident(newRepo, retired), (v) => v, 10_000)
    await oldWriteCommitted(oldRepo, retired)
    await held2.release()
    expect(await until(() => chunksHeld, (v) => v, 15_000)).toBe(true)
    const newMeta = await newRepo.find<Meta>(ws.meta.url)
    await fillAndRotate({ repo: newRepo, meta: newMeta }, 'h1')
    const detached = await until(() => detachedLines(log, retired), (lines) => lines.length >= 1, 30_000)
    const row = await until(() => roObject(OLD.id), (value) => value !== undefined, 20_000)
    expect(row?.name).toBe(OLD.name)
    // Owed the re-check when it was detached: no watermark of its own.
    expect(detached[0]!.watermark).toBeNull()
  }, 180_000)

  it('PARK DURING the re-check (fold off): a head owed the re-check is not parked under its merge; the old cell\'s write still reaches its row', async () => {
    process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS = '1000'
    const oldRepo = repoFor()
    const log = capture()
    const { ws, stopOld, retired } = await retiredOnOldCell(oldRepo)
    stopOld()
    const parks = () => log.events('read_model.ordinary_retired_head_parked')
      .filter((line) => docId(String(line.url)) === retired).length
    const parkedByOld = parks()
    // The re-check read of the watched head's chunks returns once the head is
    // parked — or after long enough for several park sweeps to have tried.
    let holdChunks = true
    let chunksHeld = false
    let parkedUnderMerge = false
    const pool = hookedPool(async (sql, params) => {
      if (!holdChunks || !isChunksRead(sql) || params?.[0] !== retired) return
      holdChunks = false
      chunksHeld = true
      parkedUnderMerge = (await until(parks, (n) => n > parkedByOld, 4_000)) > parkedByOld
    })
    const held2 = await gate(taggedPool('gate'))
    later(held2.release)
    const newRepo = repoFor()
    const residency = new AutomergeResidencyLeases(newRepo)
    await startTracked(newRepo, ws.rootUrl, { residency, pool })
    await until(() => resident(newRepo, retired), (v) => v, 10_000)
    await oldWriteCommitted(oldRepo, retired)
    await held2.release()
    expect(await until(() => chunksHeld, (v) => v, 15_000)).toBe(true)
    const row = await until(() => roObject(OLD.id), (value) => value !== undefined, 20_000)
    expect(row?.name).toBe(OLD.name)
    expect(parkedUnderMerge).toBe(false)
    // Parked later, once re-checked.
    expect(await until(parks, (n) => n > parkedByOld, 15_000)).toBeGreaterThan(parkedByOld)
  }, 180_000)

  it('ONCE per attach, from FRESH rows: a retirement made after attach is re-checked; a failed fire-time read re-arms once', async () => {
    process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS = '0'
    const repo = repoFor()
    const ws = await workspace(repo)
    const log = capture()
    const rechecks = rechecksOf(log)
    // The fire-time read is the retirements read right after the FIRST
    // barrier scan that comes back CLEAR (the gate released): armed from that
    // scan's result, deterministically, whenever the release happens; and
    // once only, so the re-armed fire is not refused again.
    let injected = false
    let failNextFireRead = false
    let barrierQueries = 0
    let chunkReads = 0
    const pool = hookedPool((sql) => {
      if (isBarrierQuery(sql)) barrierQueries += 1
      if (isChunksRead(sql)) chunkReads += 1
      if (failNextFireRead && isRetirementsRead(sql)) {
        failNextFireRead = false
        throw new Error('injected retirements read failure')
      }
    }, (sql, rows) => {
      if (injected || !isBarrierQuery(sql)) return
      const blockers = rows.filter((row) => (row as { pid: number | null }).pid !== null)
      if (!blockers.length) { injected = true; failNextFireRead = true }
    })
    // An UNRELATED long transaction (no storage-write tag: a `pg_dump`, a
    // `psql` session), open from before the attach to the end: it must not
    // hold the re-check.
    const unrelated = await gate(db.pool)
    later(unrelated.release)
    const held2 = await gate(taggedPool('gate'))
    later(held2.release)
    // No retirement row at attach: the workspace rotates (allow-listed), so
    // the re-check is armed anyway.
    expect((await db.pool.query('SELECT 1 FROM read_model_ordinary_head_retirements')).rowCount).toBe(0)
    await startTracked(repo, ws.rootUrl, { pool, residency: new AutomergeResidencyLeases(repo) })
    const retired = await fillAndRotate(ws, 'h0')
    expect(rechecks()).toBe(0)

    await held2.release()
    expect(await until(() => log.events('read_model.ordinary_handover_recheck_failed').length, (n) => n >= 1, 10_000)).toBe(1)
    expect(await until(rechecks, (n) => n >= 1, 10_000)).toBe(1)
    const event = log.events('read_model.ordinary_handover_recheck')[0]!
    expect(Number(event.retirements)).toBeGreaterThanOrEqual(1)
    // The retired head and both current heads, at least.
    expect(Number(event.heads)).toBeGreaterThanOrEqual(3)
    // Exactly once: more than two delays later, still one event, and each
    // owed head was read from storage once.
    await settle(RECHECK_LATEST_MS * 2 + 500)
    expect(rechecks()).toBe(1)
    expect(barrierQueries).toBeGreaterThanOrEqual(1)
    expect(chunkReads).toBe(Number(event.heads))
    // The unrelated transaction was open all along.
    expect((await db.pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction'`,
    )).rows[0]!.n).toBeGreaterThanOrEqual(1)
    expect(retired).toBeTruthy()
  }, 180_000)

  it('knob 0 arms nothing, and neither does a workspace that does not rotate', async () => {
    const repo = repoFor()
    const ws = await workspace(repo)
    const log = capture()
    let barrierQueries = 0
    const pool = hookedPool((sql) => { if (isBarrierQuery(sql)) barrierQueries += 1 })
    process.env.AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS = '0'
    const stopA = await startTracked(repo, ws.rootUrl, { pool })
    await settle(RECHECK_LATEST_MS * 3)
    stopA()
    process.env.AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS = String(RECHECK_MS)
    // Rotation off for this workspace, no retirement row: no arm.
    const stopB = await startTracked(repo, ws.rootUrl, { pool, rotation: undefined })
    await settle(RECHECK_LATEST_MS * 3)
    stopB()
    expect(barrierQueries).toBe(0)
    expect(log.events('read_model.ordinary_handover_recheck')).toHaveLength(0)
    // Control: the same workspace, rotating, with the knob on, IS armed.
    const stopC = await startTracked(repo, ws.rootUrl, { pool })
    expect(await until(() => barrierQueries, (n) => n > 0, 10_000)).toBeGreaterThan(0)
    expect(await until(() => log.events('read_model.ordinary_handover_recheck').length, (n) => n > 0, 10_000)).toBe(1)
    stopC()
  }, 60_000)

  // ---- QA of a80ac251: the sweep hold, the barrier's own tag, the abandon,
  // the per-poll budget ----

  it('SWEEP HOLD: held for the whole attach and logged ONCE; released by the re-check, the deferred sweep runs unasked', async () => {
    const repo = repoFor()
    const ws = await workspace(repo)
    const log = capture()
    await seedSweepable()
    const held = log.events.bind(null, 'read_model.ordinary_chain_fold_rows_sweep_held')
    const gate2 = await gate(taggedPool('gate'))
    later(gate2.release)
    await startTracked(repo, ws.rootUrl, { fold: true })
    // Several fold passes that reach the sweep step (the attach's, two
    // rotations'; a pass refused its lock does not count): all held, ONE line.
    const sweepingPasses = () => log.events('read_model.ordinary_chain_fold_pass')
      .filter((line) => line.kind === 'object' && (line.outcome === 'skipped' || line.outcome === 'folded')).length
    await fillAndRotate(ws, 'h0')
    await fillAndRotate(ws, 'h1')
    expect(await until(sweepingPasses, (n) => n >= 2, 45_000)).toBeGreaterThanOrEqual(2)
    expect(held()).toHaveLength(1)
    expect(await rowPresent('fk-s1')).toBe(true)
    expect(log.events('read_model.ordinary_chain_fold_rows_swept')).toHaveLength(0)
    // The re-check runs; the hold goes; the sweep runs without any other
    // trigger from here (no rotation, no edit).
    await gate2.release()
    expect(await until(() => rowPresent('fk-s1'), (v) => !v, 30_000)).toBe(false)
    expect(log.events('read_model.ordinary_chain_fold_rows_swept').length).toBeGreaterThanOrEqual(1)
    expect(held()).toHaveLength(1)
    // fk-p's own product has no row: it stays.
    expect(await rowPresent('fk-p')).toBe(true)
  }, 180_000)

  it('knob 0 (no re-check armed), fold ON: the hold is released at once — expired rows are still swept, nothing held', async () => {
    process.env.AM_ORDINARY_FOLD_HANDOVER_RECHECK_MS = '0'
    const repo = repoFor()
    const ws = await workspace(repo)
    const log = capture()
    await seedSweepable()
    await startTracked(repo, ws.rootUrl, { fold: true })
    expect(await until(() => rowPresent('fk-s1'), (v) => !v, 30_000)).toBe(false)
    expect(log.events('read_model.ordinary_chain_fold_rows_sweep_held')).toHaveLength(0)
    expect(log.events('read_model.ordinary_handover_recheck')).toHaveLength(0)
  }, 120_000)

  it('the barrier ignores this process\'s OWN storage writes, and a tagged transaction opened AFTER the attach', async () => {
    expect(storageWriteApplication.startsWith('ms-storage:')).toBe(true)
    expect(storageWriteApplication.length).toBeGreaterThan('ms-storage:'.length + 10)
    const repo = repoFor()
    const ws = await workspace(repo)
    const log = capture()
    // This process's own tag, open from before the attach.
    const own = guardIdleClientErrors(new pg.Pool({
      connectionString: connection!, max: 1, options: `-c search_path=${db.schema}`, application_name: storageWriteApplication,
    }), 'handover-test:own')
    teardown.unshift(() => own.end())
    const ownTx = await gate(own)
    later(ownTx.release)
    await startTracked(repo, ws.rootUrl)
    // Another process's tag, but opened after the attach.
    const lateTx = await gate(taggedPool('late'))
    later(lateTx.release)
    expect(await until(() => log.events('read_model.ordinary_handover_recheck').length, (n) => n >= 1, 15_000)).toBe(1)
    expect(log.events('read_model.ordinary_handover_recheck')[0]!.reason).toBe('barrier-clear')
  }, 120_000)

  it('ABANDON: a head whose re-check fails five times is given up — logged and counted', async () => {
    process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS = '0'
    const repo = repoFor()
    const ws = await workspace(repo)
    const log = capture()
    let failFor: string | null = null
    const pool = hookedPool((sql, params) => {
      if (failFor && isChunksRead(sql) && params?.[0] === failFor) throw new Error('injected chunks read failure')
    })
    const gate2 = await gate(taggedPool('gate'))
    later(gate2.release)
    await startTracked(repo, ws.rootUrl, { pool, residency: new AutomergeResidencyLeases(repo) })
    const retired = await fillAndRotate(ws, 'h0')
    failFor = retired
    const before = handoverRecheckAbandonedCount()
    await gate2.release()
    const abandoned = () => log.events('read_model.ordinary_handover_recheck_abandoned').filter((line) => line.documentId === retired)
    expect(await until(() => abandoned().length, (n) => n >= 1, 30_000)).toBe(1)
    expect(abandoned()[0]).toMatchObject({ failures: 5 })
    expect(handoverRecheckAbandonedCount()).toBe(before + 1)
    expect(log.events('read_model.ordinary_handover_recheck_failed').filter((line) => line.documentId === retired)).toHaveLength(5)
  }, 120_000)

  it('the per-poll budget: with more than eight heads owed, no poll pass reads more than eight from storage', async () => {
    const repo = repoFor()
    const ws = await workspace(repo)
    const log = capture()
    // Ten resident documents, each with a FOLDED row naming its real heads
    // (nothing to forward): owed, resident, so each re-check reads its chunks.
    const heads: string[] = []
    for (let i = 0; i < 10; i += 1) {
      const doc = repo.create<ObjHead>({ objects: {}, writeBatchIds: [] })
      await doc.whenReady()
      await repo.flush([doc.documentId])
      const h = A.getHeads(doc.doc() as A.Doc<unknown>)
      await db.pool.query(
        `INSERT INTO read_model_ordinary_head_retirements
           (landscape_id, version_id, collection, document_id, retirement_heads, forwarded_heads, status, folded_into, retain_until)
         VALUES ($1, $2, 'object', $3, $4::text[], $4::text[], 'folded', 'budget-product', now() + interval '1 day')`,
        [WS.landscapeId, WS.versionId, String(doc.documentId), h],
      )
      heads.push(String(doc.documentId))
    }
    const marks: string[] = []
    const pool = hookedPool((sql) => {
      if (isFoldedPoll(sql)) marks.push('poll')
      if (isChunksRead(sql)) marks.push('read')
    })
    const gate2 = await gate(taggedPool('gate'))
    later(gate2.release)
    await startTracked(repo, ws.rootUrl, { pool, fold: true })
    await settle(RECHECK_LATEST_MS + 300)
    marks.length = 0
    await gate2.release()
    const total = () => marks.filter((mark) => mark === 'read').length
    // Ten folded heads and both current heads: twelve reads, over passes.
    expect(await until(total, (n) => n >= 12, 30_000)).toBeGreaterThanOrEqual(12)
    const perPass: number[] = []
    for (const mark of marks) {
      if (mark === 'poll') perPass.push(0)
      else if (perPass.length) perPass[perPass.length - 1]! += 1
    }
    expect(Math.max(...perPass)).toBeLessThanOrEqual(8)
    expect(perPass.filter((n) => n > 0).length).toBeGreaterThanOrEqual(2)
    expect(log.events('read_model.ordinary_handover_recheck')).toHaveLength(1)
  }, 120_000)
})
