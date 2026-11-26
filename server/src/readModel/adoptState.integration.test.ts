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
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { envNumber } from '../envNumber.js'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { PROTOCOL_FIXTURE_MARK, protocolFixtureDb, protocolFixtureQuery } from '../testing/protocolFixture.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import * as Automerge from '@automerge/automerge'
import {
  assertReadModelWriteFence,
  claimReadModelWriteFence,
  markReadModelProjectorAdopting,
  markReadModelProjectorAttached,
  ReadModelWriteFenceError,
} from './health.js'
import { recordProjectedWatermarks, recordSampledDocumentWatermark, recordSampledDocumentWatermarks } from './arrivalWatermark.js'
import { OVERLAY_SEGMENT_ENTITY_CEILING } from './overlayChainFold.js'
import type { OrdinaryHeadRotationConfig } from './ordinaryHeadRotation.js'
import { ReadModelProtocolMarkerError } from './protocolParticipant.js'
import { dropReadModelSchema, ensureReadModelSchema } from './schema.js'
import { awaitAdoptStamps, startReadModelProjector } from './projectorService.js'
import {
  ADOPT_STATE_VERSION,
  AdoptFenceBindingError,
  PROJECTION_FORMAT_VERSION,
  adoptPostureText,
  adoptProtocolDigests,
  adoptRefusal,
  adoptTopology,
  adoptTopologyDigest,
  bindAdoptFence,
  readAdoptPlane,
  readAdoptPlaneForUpdate,
  recordAdoptWatermarks,
  refuseAdoptWatermarks,
  updateAdoptTopology,
  withAdoptSavepoint,
  writeAdoptState,
  type AdoptTopology,
} from './adoptState.js'
import { commitOrdinaryHeadRetirement } from './ordinaryHeadRotator.js'
import { commitForwardedHeads, readOrdinaryHeadRetirement, recordOrdinaryHeadRetirement } from './ordinaryHeadForwarding.js'
import { advanceFoldedArrivalWatermark, advanceFoldedArrivalWatermarks } from './ordinaryFoldedArrivals.js'
import { assertReadModelPlane, isReadModelAuthorityLoss } from './projectionAuthority.js'
import { acquireOverlayRotationLock, overlayRotationLockKey, releaseOverlayRotationLock } from './overlayRotationLock.js'
import { withReadModelProjectionTransaction } from './projectionTransaction.js'
import { claimAdopt, verifyAdoptShadow, type AdoptVerifyInput } from './adoptVerify.js'
import { settleCompactedOrdinarySegments } from './workspaceCompaction.js'
import type { Queryable } from './types.js'
import { abandonOrdinaryChainFold, recordOrdinaryChainFold, sweepOrdinaryChainFoldRows } from './ordinaryChainFold.js'
import { durableHeadsDecoder } from './durableHeadsDecoder.js'
import { durableHeadsMemo } from './durableHeadsMemo.js'
import type { WorkspaceKey } from './projector.js'

/**
 * G4-16f C2: the ADOPT plane's writers — the cold build, the metadata pass
 * and the registry pass — with the real projector, a real Repo over the
 * PostgreSQL storage adapter and the real schema; and the PROTOCOL DIGESTS,
 * which the database keeps (`adoptState.ts`): after every protocol writer
 * commits, the stored digests equal an INDEPENDENT recomputation from the
 * raw rows (`independentProtocolDigests`, written here from the documented
 * format, never through `read_model_adopt_protocol_digests`).
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-adopt', versionId: 'v1' }
const EMPTY_DIGEST = createHash('sha256').update('').digest('hex')

let db: IsolatedSchemaDb

type Meta = {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrl: string
  editsObjectShardUrls: string[]
  editsConnectionShardUrl: string
  editsConnectionShardUrls: string[]
  groups: Record<string, unknown>
}
type Root = { modelMetaUrl: string; modelUrl: string; shardUrls: string[] }

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}

function storageRepo() {
  return new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 60_000 })
}

async function claim(documentId: string) {
  await db.pool.query(
    'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [documentId, WS.landscapeId, WS.versionId],
  )
}

interface Workspace {
  repo: Repo
  root: DocHandle<Root>
  meta: DocHandle<Meta>
  registry: DocHandle<{ diagrams: Record<string, unknown> }>
  shards: string[]
}

async function workspace(repo: Repo): Promise<Workspace> {
  const base = repo.create({ objects: { b: { id: 'b', name: 'B', type: 'system' } } })
  const head = repo.create({ objects: {}, writeBatchIds: [] })
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
  const registry = repo.create<{ diagrams: Record<string, unknown> }>({ diagrams: {} })
  const root = repo.create<Root>({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
  const handles = [base, head, connHead, meta, registry, root]
  await Promise.all(handles.map((h) => h.whenReady()))
  await repo.flush()
  for (const handle of handles) await claim(String(handle.documentId))
  return { repo, root, meta, registry, shards: [base, head, connHead].map((h) => String(h.documentId)) }
}

/** The test pool, `before` offered each query (pool-level and on a client
 * from `connect()`) BEFORE it runs. (Copied from the parking suite: a test
 * file imports no other.) */
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

const adoptWatermark = async (documentId: string) => (await db.pool.query<{ w: string }>(
  `SELECT adopt_watermark::text AS w FROM read_model_adopt_watermarks
    WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
  [WS.landscapeId, WS.versionId, documentId],
)).rows[0]?.w ?? null
/** The highest arrival of a document's content rows: what a positive
 * certificate must reach. */
const maxArrival = async (documentId: string) => (await db.pool.query<{ m: string | null }>(
  `SELECT max(arrival_seq)::text AS m FROM automerge_storage WHERE split_part(key, '/', 1) = $1`, [documentId],
)).rows[0]!.m
const adoptState = async (key: WorkspaceKey = WS) => (await db.pool.query<{
  format_version: number; org_id: string | null; topology_digest: string
  retirements_digest: string; folds_digest: string; defects: number
}>(
  `SELECT format_version, org_id, topology_digest, retirements_digest, folds_digest, defects
     FROM read_model_adopt_state WHERE landscape_id = $1 AND version_id = $2`,
  [key.landscapeId, key.versionId],
)).rows[0]
const exactWatermarkIds = async () => (await db.pool.query<{ id: string }>(
  'SELECT document_id AS id FROM read_model_document_watermarks WHERE landscape_id = $1 AND version_id = $2',
  [WS.landscapeId, WS.versionId],
)).rows.map((row) => row.id).sort()
const adoptIds = async () => (await db.pool.query<{ id: string }>(
  'SELECT document_id AS id FROM read_model_adopt_watermarks ORDER BY 1')).rows.map((row) => row.id)

/** THE TOPOLOGY DIGEST, written here from its documented field list
 * (`adoptTopologyDigest`'s doc comment), never by calling it. */
const expectedTopology = (root: Partial<Root> | undefined, meta: Partial<Meta> | undefined): string =>
  createHash('sha256').update(JSON.stringify([
    root?.modelMetaUrl ?? null, root?.modelUrl ?? null, root?.shardUrls ? [...root.shardUrls] : null,
    meta?.objectShardUrls ? [...meta.objectShardUrls] : null, meta?.connectionShardUrls ? [...meta.connectionShardUrls] : null,
    meta?.editsObjectShardUrl ?? null, meta?.editsObjectShardUrls ? [...meta.editsObjectShardUrls] : null,
    meta?.editsConnectionShardUrl ?? null, meta?.editsConnectionShardUrls ? [...meta.editsConnectionShardUrls] : null,
  ])).digest('hex')

/** A value as PostgreSQL's `jsonb::text` renders it (arrays `[a, b]`,
 * strings JSON-quoted): enough for the ASCII ids, heads and numbers here. */
const jsonbText = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(jsonbText).join(', ')}]`
  : value === null || value === undefined ? 'null' : JSON.stringify(value)
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const sha256Lines = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex')

/** THE PROTOCOL DIGESTS recomputed from the raw rows of `key`, from the
 * documented format (`schema.ts`, `ADOPT_PROTOCOL_DIGESTS_BODY`'s comment):
 * the oracle every protocol-writer arm compares the STORED row against. */
async function independentProtocolDigests(key: WorkspaceKey = WS): Promise<{ retirements_digest: string; folds_digest: string }> {
  const retirements = (await db.pool.query<{
    collection: string; document_id: string; status: string; retirement_heads: string[] | null
    forwarded_heads: string[] | null; folded_into: string | null; retain_us: string | null
    arrival_watermark: string | null; origin: string | null
  }>(
    `SELECT collection, document_id, status, retirement_heads, forwarded_heads, folded_into,
            (extract(epoch FROM retain_until) * 1000000)::bigint::text AS retain_us,
            arrival_watermark::text AS arrival_watermark, origin
       FROM read_model_ordinary_head_retirements WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )).rows
    .sort((a, b) => byteOrder(a.collection, b.collection) || byteOrder(a.document_id, b.document_id))
    .map((row) => jsonbText([row.collection, row.document_id, row.status, row.retirement_heads, row.forwarded_heads,
      row.folded_into, row.retain_us, row.arrival_watermark, row.origin]))
  const folds = (await db.pool.query<{ collection: string; product_document_id: string; source_document_ids: string[] }>(
    `SELECT collection, product_document_id, source_document_ids
       FROM read_model_ordinary_chain_folds WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )).rows
    .sort((a, b) => byteOrder(a.collection, b.collection) || byteOrder(a.product_document_id, b.product_document_id))
    .map((row) => jsonbText([row.collection, row.product_document_id, row.source_document_ids]))
  return { retirements_digest: sha256Lines(retirements), folds_digest: sha256Lines(folds) }
}
const storedProtocolDigests = async (key: WorkspaceKey = WS) => {
  const state = await adoptState(key)
  return state ? { retirements_digest: state.retirements_digest, folds_digest: state.folds_digest } : undefined
}

const quiet = () => {
  const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})]
  return () => { for (const spy of spies) spy.mockRestore() }
}

/** A transaction on its own client, committed (or rolled back on a throw). */
async function inTransaction<T>(run: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** The value `adoptRow` writes into the fence. */
const FENCE = 'fence'

/** A transaction that takes the fence row FIRST, as every production
 * protocol writer does (`assertReadModelWriteFence`, THE LOCK ORDER). */
async function inFencedTransaction<T>(run: (tx: pg.PoolClient) => Promise<T>, key: WorkspaceKey = WS): Promise<T> {
  return inTransaction(async (tx) => {
    await assertReadModelWriteFence(tx, key, FENCE)
    return run(tx)
  })
}

/** LOCK ORDER 4's predicate: why `text` (the module at `file`, relative to
 * `server/`) could take the fixtures' wildcard or touch a protocol setting —
 * a static, dynamic or `require` import of `testing/protocolFixture`, or a
 * mention of either setting (by name or by constant) outside the modules
 * that own it. A mention is enough: a wildcard built at run time
 * (`',' || '*'`) still has to name the setting it is written into. */
function protocolBypassReasons(file: string, text: string): string[] {
  const reasons: string[] = []
  if (/(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*['"`][^'"`]*testing\/protocolFixture/.test(text)) {
    reasons.push('imports testing/protocolFixture')
  }
  if (!['src/readModel/health.ts', 'src/readModel/schema.ts'].includes(file)
    && /read_model_fence_rows|PROTOCOL_FENCE_ROWS_SETTING/.test(text)) {
    reasons.push('names the fence-rows setting')
  }
  if (!['src/readModel/protocolParticipant.ts', 'src/db/poolErrorGuard.ts', 'src/readModel/schema.ts'].includes(file)
    && /read_model_protocol\b|READ_MODEL_PROTOCOL_(?:SETTING|VERSION)/.test(text)) {
    reasons.push('names the participant setting')
  }
  return reasons
}

/** A topology for rows written by hand (the digest is all the C2 arms read). */
const fixtureTopology = (digest: string): AdoptTopology => ({
  digest, rootDocumentId: 'root', metaDocumentId: 'meta', objectShardIds: ['o1', 'o1'], connectionShardIds: [], registryShardIds: ['r1'],
})
const fixtureAdoptState = (digest = 't') => ({
  orgId: null, topology: fixtureTopology(digest), defects: 0, sealedCeiling: 4,
  posture: { rotation: true, fold: true, parking: true, extractCache: false },
})

/** A workspace with a fence row and an adopt row, as a cold build leaves it. */
async function adoptRow(key: WorkspaceKey = WS): Promise<void> {
  await db.pool.query(
    `INSERT INTO read_model_projection_state (landscape_id, version_id, write_fence) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [key.landscapeId, key.versionId, FENCE],
  )
  await inTransaction(async (tx) => {
    expect(await withAdoptSavepoint(tx, key, () => writeAdoptState(tx, key, fixtureAdoptState()))).toBe(true)
  })
}

suite('G4-16f C2 — adopt watermarks and adopt state, writers only (real projector, Repo, PostgreSQL)', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'adopt_state_c2')
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
  afterAll(async () => { await new Promise((r) => setTimeout(r, 300)); await db?.teardown() })
  let restoreLogs: () => void = () => {}
  let restoreRegistration: () => void = () => {}
  beforeEach(async () => {
    await db.pool.query(`TRUNCATE automerge_storage, automerge_document_workspace, ro_objects, ro_connections, ro_groups,
      read_model_projection_state, read_model_change_events, read_model_document_watermarks,
      read_model_adopt_watermarks, read_model_adopt_state, read_model_ordinary_head_retirements, read_model_ordinary_chain_folds`)
    restoreLogs = quiet()
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async ({ documentIds }) => {
      for (const documentId of documentIds) await claim(documentId)
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
  })
  afterEach(() => { restoreRegistration(); restoreLogs() })

  // ------------------------------------------- THE DEFERRED ADOPT STAMPS
  /** Hold the FIRST deferred stamp inside its durable proof (the decode the
   * proof runs) until `release()`. */
  function holdFirstProof() {
    const real = durableHeadsDecoder.decode.bind(durableHeadsDecoder)
    let hold = false
    let entered!: () => void
    const inProof = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const spy = vi.spyOn(durableHeadsDecoder, 'decode').mockImplementation(async (id, chunks) => {
      if (hold) { hold = false; entered(); await released }
      return real(id, chunks)
    })
    return { arm: () => { hold = true }, inProof, release: () => release(), restore: () => { release(); spy.mockRestore() } }
  }

  it('S1: a burst of metadata passes is stamped by ONE debounced job, not one job per pass', async () => {
    const ws = await workspace(storageRepo())
    let stamps = 0
    let armed = false
    let passes = 0
    const pool = poolBeforeQuery((text) => {
      if (!armed) return
      if (text.includes('INSERT INTO read_model_adopt_watermarks')) stamps += 1
      if (text.includes('UNION SELECT object_id FROM ro_group_objects')) passes += 1
    })
    const stop = await startReadModelProjector(ws.repo, ws.root.url, pool, WS)
    try {
      await new Promise((r) => setTimeout(r, 400))
      armed = true
      for (let at = 0; at < 6; at += 1) {
        ws.meta.change((meta) => { meta.groups[`b${at}`] = { id: `b${at}`, name: `burst ${at}` } })
        await new Promise((r) => setTimeout(r, 30))
      }
      await new Promise((r) => setTimeout(r, 1500))
      expect(passes).toBeGreaterThanOrEqual(3)
      // Each pass writes its own refusal (an INSERT too); the rest are stamp jobs.
      const jobs = stamps - passes
      expect(jobs, `passes=${passes} stamps=${stamps}`).toBeGreaterThanOrEqual(1)
      expect(jobs, `passes=${passes} stamps=${stamps}`).toBeLessThanOrEqual(2)
      // And the burst ends certified.
      expect(BigInt((await adoptWatermark(String(ws.meta.documentId)))!)).toBeGreaterThan(0n)
    } finally {
      stop()
    }
  }, 60_000)

  it('S2: a pass that commits WHILE a stamp job is running is stamped by the job that follows', async () => {
    const ws = await workspace(storageRepo())
    const metaId = String(ws.meta.documentId)
    const held = holdFirstProof()
    const stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS)
    try {
      await new Promise((r) => setTimeout(r, 400))
      held.arm()
      ws.meta.change((meta) => { meta.groups.first = { id: 'first', name: 'first' } })
      await held.inProof // the first stamp job is inside its durable proof
      ws.meta.change((meta) => { meta.groups.second = { id: 'second', name: 'second' } })
      // The second pass commits (its own 0) while the job still runs.
      expect(await until(async () => (await db.pool.query(
        `SELECT 1 FROM ro_groups WHERE landscape_id = $1 AND id = 'second'`, [WS.landscapeId])).rowCount, (n) => n === 1)).toBe(1)
      held.release()
      const reached = await until(async () => {
        const wm = await adoptWatermark(metaId)
        const top = await maxArrival(metaId)
        return wm !== null && wm !== '0' && top !== null && BigInt(wm) >= BigInt(top)
      }, (ok) => ok, 15_000)
      expect(reached, 'the revision committed during the running job is stamped exactly afterwards').toBe(true)
    } finally {
      held.restore()
      stop()
    }
  }, 60_000)

  it('S4: awaitAdoptStamps resolves only once the deferred stamp of the last pass has run (what the gc park-watermark test relies on)', async () => {
    const ws = await workspace(storageRepo())
    const metaId = String(ws.meta.documentId)
    const held = holdFirstProof()
    const stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS)
    try {
      await new Promise((r) => setTimeout(r, 400))
      held.arm()
      ws.meta.change((meta) => { meta.groups.s4 = { id: 's4', name: 's4' } })
      await held.inProof
      let settled = false
      const waiting = awaitAdoptStamps(WS).then(() => { settled = true })
      await new Promise((r) => setTimeout(r, 300))
      expect(settled, 'still waiting while the stamp is inside its proof').toBe(false)
      held.release()
      await waiting
      expect(BigInt((await adoptWatermark(metaId))!)).toBeGreaterThan(0n)
    } finally {
      held.restore()
      stop()
    }
  }, 60_000)

  it('S5: awaitAdoptStamps THROWS, naming the cause, when the stamps are still running at its deadline (it never resolves as if idle)', async () => {
    const ws = await workspace(storageRepo())
    const held = holdFirstProof()
    const stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS)
    try {
      await new Promise((r) => setTimeout(r, 400))
      held.arm()
      ws.meta.change((meta) => { meta.groups.s5 = { id: 's5', name: 's5' } })
      await held.inProof
      const startedAt = performance.now()
      await expect(awaitAdoptStamps(WS, 300)).rejects.toThrow(/still running after 300 ms/)
      expect(performance.now() - startedAt).toBeLessThan(5_000)
      held.release()
      await awaitAdoptStamps(WS)
    } finally {
      held.restore()
      stop()
    }
  }, 60_000)

  it('S7: awaitAdoptStamps called while the stamp is ARMED but not yet running (inside the debounce after a pass) resolves once it has run — it does not spin the event loop to its deadline', async () => {
    const ws = await workspace(storageRepo())
    const metaId = String(ws.meta.documentId)
    const stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS)
    try {
      await awaitAdoptStamps(WS)
      expect(BigInt((await until(() => adoptWatermark(metaId), (w) => w !== null && w !== '0'))!)).toBeGreaterThan(0n)
      ws.meta.change((meta) => { meta.groups.s7 = { id: 's7', name: 's7' } })
      // The pass's own transaction writes 0 for the moved ModelMeta and
      // commits; the debounce (250 ms) is armed right after. Polled tightly
      // so the call below lands well inside it.
      const sawZero = await until(() => adoptWatermark(metaId), (w) => w === '0', 15_000)
      expect(sawZero, 'the pass committed its refusal').toBe('0')
      const calledAt = performance.now()
      await awaitAdoptStamps(WS, 5_000)
      const waited = performance.now() - calledAt
      expect(BigInt((await adoptWatermark(metaId))!), 'the armed stamp ran').toBeGreaterThan(0n)
      // The debounce plus one proof, not the deadline (the spin waited all
      // 5 000 ms, then threw "armed").
      expect(waited).toBeLessThan(3_000)
    } finally {
      stop()
    }
  }, 60_000)

  it('S6: an attach that FAILS after a pass inside it armed the stamp debounce clears that debounce, and no deferred stamp is ever written by the failed projector', async () => {
    // Two registry shards: the attach watches the first, then waits on the
    // second (held, then failed) while a registry pass of the first commits.
    const repo = storageRepo()
    const ws = await workspace(repo)
    const second = repo.create<{ diagrams: Record<string, unknown> }>({ diagrams: {} })
    await second.whenReady()
    ws.root.change((root) => { root.shardUrls.push(second.url) })
    await repo.flush()
    await claim(String(second.documentId))
    const attachRepo = storageRepo()
    let committed = false
    let failed = false
    let deferredStamps = 0
    const pool = poolBeforeQuery((text) => {
      if (text.includes('INSERT INTO read_model_adopt_state')) committed = true
      if (failed && text.includes('INSERT INTO read_model_adopt_watermarks')) deferredStamps += 1
    })
    let gated!: () => void
    const gateEntered = new Promise<void>((resolve) => { gated = resolve })
    let fail!: () => void
    const failNow = new Promise<never>((_, reject) => { fail = () => reject(new Error('test: boom (not an availability error)')) })
    failNow.catch(() => {})
    let gateUsed = false
    const failing = new Proxy(attachRepo, {
      get(target, prop) {
        if (prop === 'find') {
          return (url: string, ...rest: unknown[]) => {
            const fromAttach = committed && url === second.url && /watchRegistryShard/.test(new Error().stack ?? '')
            if (fromAttach && !gateUsed) { gateUsed = true; gated(); return failNow }
            if (fromAttach) return Promise.reject(new Error('test: boom (not an availability error)'))
            return (target.find as (...a: unknown[]) => unknown).call(target, url, ...rest)
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as Repo
    // The stamp debounce is the 250 ms timer; record which were armed and cleared.
    const armedDebounces = new Set<unknown>()
    const cleared = new Set<unknown>()
    const realSet = globalThis.setTimeout
    const realClear = globalThis.clearTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = realSet(fn as never, ms, ...rest)
      if (ms === 250) armedDebounces.add(handle)
      return handle
    }) as never)
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: unknown) => { cleared.add(handle); return realClear(handle as never) }) as never)
    try {
      const outcome = startReadModelProjector(failing, ws.root.url, pool, WS).then(() => 'attached', (e: Error) => `failed:${e.message}`)
      await gateEntered
      const first = await attachRepo.find<{ diagrams: Record<string, unknown>; touched?: number }>(ws.registry.url)
      first.change((doc) => { doc.touched = (doc.touched ?? 0) + 1 })
      for (let at = 0; at < 80 && !armedDebounces.size; at += 1) await new Promise((r) => realSet(r, 25))
      expect(armedDebounces.size, 'the pass inside the attach armed the stamp debounce (else this proves nothing)').toBeGreaterThan(0)
      failed = true
      fail()
      expect(await outcome).toMatch(/^failed:/)
      for (const handle of armedDebounces) expect(cleared.has(handle), 'the armed stamp debounce is cleared by the failed attach').toBe(true)
      // Well past the debounce: nothing stamps.
      await new Promise((r) => realSet(r, 900))
      expect(deferredStamps, 'a deferred adopt stamp written by the projector of a FAILED attach').toBe(0)
      // Another change: the failed attach's listeners still run a pass (a
      // pre-existing zombie, known and not covered), whose
      // own transaction writes its refusal; no DEFERRED stamp follows it.
      const generation = async () => Number((await db.pool.query<{ g: string | null }>(
        'SELECT projected_generation::text AS g FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId])).rows[0]?.g ?? 0)
      const before = await generation()
      first.change((doc) => { doc.touched = (doc.touched ?? 0) + 1 })
      await until(generation, (g) => g > before, 3_000)
      const inPass = deferredStamps
      await new Promise((r) => realSet(r, 1_200))
      expect(deferredStamps, 'a deferred adopt stamp written by the projector of a FAILED attach').toBe(inPass)
    } finally {
      vi.mocked(globalThis.setTimeout).mockRestore()
      vi.mocked(globalThis.clearTimeout).mockRestore()
    }
  }, 60_000)

  it('S3: a deferred stamp whose owner lost the write fence during its proof writes NOTHING positive (the stamp transaction asserts the fence)', async () => {
    const ws = await workspace(storageRepo())
    const metaId = String(ws.meta.documentId)
    const held = holdFirstProof()
    let fenceAssertions = 0
    const pool = poolBeforeQuery((text) => {
      if (/SELECT write_fence\b[\s\S]*FROM read_model_projection_state[\s\S]*FOR UPDATE/.test(text)) fenceAssertions += 1
    })
    const stop = await startReadModelProjector(ws.repo, ws.root.url, pool, WS)
    try {
      await new Promise((r) => setTimeout(r, 400))
      held.arm()
      ws.meta.change((meta) => { meta.groups.first = { id: 'first', name: 'first' } })
      await held.inProof
      expect(await adoptWatermark(metaId)).toBe('0') // the pass refused it in its own transaction
      // Another cell cold-builds and claims the fence while the old owner's proof still runs.
      await db.pool.query('UPDATE read_model_projection_state SET write_fence = $3 WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId, 'cell-b-projector'])
      const before = fenceAssertions
      held.release()
      await new Promise((r) => setTimeout(r, 1200))
      expect(await adoptWatermark(metaId), 'the fenced-out owner must not certify').toBe('0')
      // Witness that the job reached its transaction after the takeover (and
      // was stopped by its fence assertion there, not by giving up before).
      expect(fenceAssertions).toBeGreaterThan(before)
    } finally {
      held.restore()
      stop()
    }
  }, 60_000)

  it('A1: a cold build certifies root, ModelMeta and the registry shard EXACTLY, writes the state row, and keeps them out of read_model_document_watermarks', async () => {
    const ws = await workspace(storageRepo())
    // The digests must be read over THESE rows (another workspace's must not count).
    await db.pool.query(`INSERT INTO read_model_ordinary_chain_folds (landscape_id, version_id, collection, product_document_id, source_document_ids)
      VALUES ('elsewhere', 'v1', 'object', 'p', ARRAY['s'])`)
    const stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS)
    try {
      for (const handle of [ws.root, ws.meta, ws.registry]) {
        const w = await adoptWatermark(String(handle.documentId))
        expect(w).not.toBeNull()
        expect(BigInt(w!)).toBeGreaterThan(0n)
        expect(BigInt(w!)).toBeGreaterThanOrEqual(BigInt((await maxArrival(String(handle.documentId)))!))
      }
      expect(await adoptState()).toEqual({
        format_version: 1,
        org_id: null,
        topology_digest: expectedTopology(ws.root.doc(), ws.meta.doc()),
        retirements_digest: EMPTY_DIGEST,
        folds_digest: EMPTY_DIGEST,
        defects: 0,
      })
      expect(PROJECTION_FORMAT_VERSION).toBe(1)
      // The exact table holds the model shards and nothing of the control documents.
      expect(await exactWatermarkIds()).toEqual([...ws.shards].sort())
    } finally {
      stop()
    }
  }, 60_000)

  it('A2: a cold build that rolls back (lost ownership: its fence claim is skipped) leaves no adopt row at all', async () => {
    const ws = await workspace(storageRepo())
    await expect(startReadModelProjector(ws.repo, ws.root.url, db.pool, WS, undefined, 0, undefined, () => false))
      .rejects.toThrow()
    // Witness that the build reached its transaction and rolled back: no ro_* row either.
    expect((await db.pool.query('SELECT 1 FROM ro_objects WHERE landscape_id = $1', [WS.landscapeId])).rowCount).toBe(0)
    expect((await db.pool.query('SELECT 1 FROM read_model_adopt_watermarks')).rowCount).toBe(0)
    expect((await db.pool.query('SELECT 1 FROM read_model_adopt_state')).rowCount).toBe(0)
  }, 60_000)

  it('A3: a ModelMeta change projected while its heads move under the pass writes 0 over a positive value; the next pass certifies it again', async () => {
    const ws = await workspace(storageRepo())
    const metaId = String(ws.meta.documentId)
    let armed = false
    let seen = 0
    let releaseSecond!: () => void
    const secondHeld = new Promise<void>((resolve) => { releaseSecond = resolve })
    // Inside the METADATA transaction only (its group-membership read).
    const pool = poolBeforeQuery(async (text) => {
      if (!armed || !text.includes('UNION SELECT object_id FROM ro_group_objects')) return
      seen += 1
      if (seen === 1) ws.meta.change((meta) => { meta.groups.moved = { id: 'moved', name: 'moved under the pass' } })
      else if (seen === 2) await secondHeld
    })
    const stop = await startReadModelProjector(ws.repo, ws.root.url, pool, WS)
    try {
      const before = await adoptWatermark(metaId)
      expect(BigInt(before!)).toBeGreaterThan(0n)
      armed = true
      ws.meta.change((meta) => { meta.groups.g1 = { id: 'g1', name: 'G1' } })
      // Exact, not monotone: the refusal replaces the positive value.
      expect(await until(() => adoptWatermark(metaId), (w) => w === '0', 15_000)).toBe('0')
      expect(seen).toBeGreaterThanOrEqual(1)
      releaseSecond()
      const after = await until(() => adoptWatermark(metaId), (w) => w !== null && BigInt(w) > 0n, 15_000)
      expect(BigInt(after!)).toBeGreaterThan(BigInt(before!))
      expect(BigInt(after!)).toBeGreaterThanOrEqual(BigInt((await maxArrival(metaId))!))
      expect((await adoptState())?.topology_digest).toBe(expectedTopology(ws.root.doc(), ws.meta.doc()))
    } finally {
      releaseSecond()
      stop()
    }
  }, 60_000)

  it('A4: a registry shard appended to the root is certified by the registry pass, and the topology digest follows the root', async () => {
    const ws = await workspace(storageRepo())
    const stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS)
    try {
      const before = (await adoptState())!.topology_digest
      const added = ws.repo.create<{ diagrams: Record<string, unknown> }>({ diagrams: {} })
      await added.whenReady()
      await ws.repo.flush([added.documentId])
      await claim(String(added.documentId))
      ws.root.change((root) => { root.shardUrls.push(added.url) })
      const w = await until(() => adoptWatermark(String(added.documentId)), (value) => value !== null && BigInt(value) > 0n, 15_000)
      expect(BigInt(w!)).toBeGreaterThanOrEqual(BigInt((await maxArrival(String(added.documentId)))!))
      const digest = await until(async () => (await adoptState())!.topology_digest, (value) => value !== before, 15_000)
      expect(digest).toBe(expectedTopology(ws.root.doc(), ws.meta.doc()))
      // The root's own certificate moved with the root.
      expect(BigInt((await adoptWatermark(String(ws.root.documentId)))!))
        .toBeGreaterThanOrEqual(BigInt((await maxArrival(String(ws.root.documentId)))!))
    } finally {
      stop()
    }
  }, 60_000)

  it('A5: a failing adopt write is rolled back to its savepoint; the enclosing transaction survives and keeps its own writes', async () => {
    const client = await db.pool.connect()
    try {
      const put = (id: string) => client.query(
        `INSERT INTO read_model_adopt_watermarks (landscape_id, version_id, document_id, adopt_watermark) VALUES ('l', 'v', $1, 1)`, [id])
      await client.query('BEGIN')
      await put('kept-before')
      const failed = await withAdoptSavepoint(client, WS, async () => {
        await put('dropped-with-the-savepoint')
        await client.query('SELECT 1 FROM no_such_table_at_all')
      })
      expect(failed).toBe(false)
      await put('written-after')
      const ok = await withAdoptSavepoint(client, WS, async () => { await put('written-inside') })
      expect(ok).toBe(true)
      const jsFailure = await withAdoptSavepoint(client, WS, async () => { await put('dropped-too'); throw new Error('not a sql error') })
      expect(jsFailure).toBe(false)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    expect(await adoptIds()).toEqual(['kept-before', 'written-after', 'written-inside'])
  }, 60_000)

  it('A6: a cold build whose adopt tables are unusable still commits the projection, and the adopt writes are rolled back with their savepoint', async () => {
    const ws = await workspace(storageRepo())
    await db.pool.query('ALTER TABLE read_model_adopt_state RENAME COLUMN defects TO defects_renamed')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let stop: (() => void) | null = null
    try {
      stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS)
      expect((await db.pool.query('SELECT 1 FROM ro_objects WHERE landscape_id = $1 AND id = $2', [WS.landscapeId, 'b'])).rowCount).toBe(1)
      // Witness: the adopt bookkeeping did fail, and left nothing behind (watermarks rolled back with the state row).
      expect(errors.mock.calls.some((call) => String(call[0]).includes('adopt bookkeeping failed'))).toBe(true)
      expect(await adoptIds()).toEqual([])
      // A later pass keeps working over the broken table.
      ws.meta.change((meta) => { meta.groups.g1 = { id: 'g1', name: 'G1' } })
      expect(await until(async () => (await db.pool.query('SELECT 1 FROM ro_groups WHERE landscape_id = $1 AND id = $2', [WS.landscapeId, 'g1'])).rowCount,
        (n) => n === 1, 15_000)).toBe(1)
    } finally {
      stop?.()
      errors.mockRestore()
      await db.pool.query('ALTER TABLE read_model_adopt_state RENAME COLUMN defects_renamed TO defects')
    }
  }, 60_000)

  it('A7: a ModelMeta handle replaced between the extraction and the stamp refuses the certificate (0), not a positive one read through the stale handle', async () => {
    const ws = await workspace(storageRepo())
    const metaId = String(ws.meta.documentId)
    const rootId = String(ws.root.documentId)
    let swapped = false
    // The adopt proof's metadata read names root and ModelMeta together:
    // the handle is replaced just before it, after the extraction.
    const pool = poolBeforeQuery(async (_text, params) => {
      const ids = Array.isArray(params?.[0]) ? (params![0] as string[]) : []
      if (!swapped && ids.includes(metaId) && ids.includes(rootId)) {
        swapped = true
        await ws.repo.removeFromCache(ws.meta.documentId)
        await ws.repo.find<Meta>(ws.meta.url)
      }
    })
    const stop = await startReadModelProjector(ws.repo, ws.root.url, pool, WS)
    try {
      expect(swapped).toBe(true)
      expect(await adoptWatermark(metaId)).toBe('0')
      // Control: the root, whose handle was not replaced, is certified.
      expect(BigInt((await adoptWatermark(rootId))!)).toBeGreaterThan(0n)
    } finally {
      stop()
    }
  }, 60_000)

  it('A8: an adopt proof preparation that fails (root/ModelMeta undecodable) stamps 0 and leaves the projection and the other stamps alone', async () => {
    const ws = await workspace(storageRepo())
    const refused = new Set([String(ws.root.documentId), String(ws.meta.documentId)])
    durableHeadsMemo.clear()
    const real = durableHeadsDecoder.decode.bind(durableHeadsDecoder)
    const spy = vi.spyOn(durableHeadsDecoder, 'decode').mockImplementation(async (documentId, chunks) => {
      if (refused.has(documentId)) throw new Error('test: the strict decoder refuses this control document')
      return real(documentId, chunks)
    })
    let stop: (() => void) | null = null
    try {
      stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS)
      expect(spy.mock.calls.some(([id]) => refused.has(id))).toBe(true)
      expect((await db.pool.query('SELECT 1 FROM ro_objects WHERE landscape_id = $1 AND id = $2', [WS.landscapeId, 'b'])).rowCount).toBe(1)
      // The whole preparation failed, so every control document is stamped 0 ...
      expect(await adoptWatermark(String(ws.root.documentId))).toBe('0')
      expect(await adoptWatermark(String(ws.meta.documentId))).toBe('0')
      // ... and the shard stamps (a different preparation) are untouched.
      expect(await exactWatermarkIds()).toEqual([...ws.shards].sort())
    } finally {
      stop?.()
      spy.mockRestore()
    }
  }, 60_000)

  it('A9: a registry pass writes 0 for the root whose revision moved IN ITS OWN TRANSACTION, without the deferred exact stamp', async () => {
    const ws = await workspace(storageRepo())
    const stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS)
    const rootId = String(ws.root.documentId)
    // The deferred stamp's durable proof never finishes from here on, so
    // whatever the root's row says next, the PASS wrote it.
    const proof = vi.spyOn(durableHeadsDecoder, 'decode').mockImplementation(() => new Promise(() => {}))
    try {
      expect(BigInt((await adoptWatermark(rootId))!)).toBeGreaterThan(0n)
      const before = (await adoptState())!.topology_digest
      const added = ws.repo.create<{ diagrams: Record<string, unknown> }>({ diagrams: {} })
      await added.whenReady()
      await ws.repo.flush([added.documentId])
      await claim(String(added.documentId))
      ws.root.change((root) => { root.shardUrls.push(added.url) })
      // The registry pass committed (its topology rides the same savepoint).
      expect(await until(async () => (await adoptState())!.topology_digest, (value) => value !== before, 15_000)).not.toBe(before)
      expect(await adoptWatermark(rootId)).toBe('0')
      await new Promise((r) => setTimeout(r, 600))
      expect(await adoptWatermark(rootId)).toBe('0')
    } finally {
      proof.mockRestore()
      stop()
    }
  }, 60_000)

  // --------------------------------------------- ADOPT PLANE v2 (C6b)
  // The fence binding, the topology id lists, the seal and posture, and the
  // SAMPLED heads beside each shard watermark — written by the real
  // projector, read back raw.

  /** A workspace whose lists are out of byte order and carry a duplicate:
   * ModelMeta lists base, head, base; the root lists two registry shards,
   * the second created first. */
  async function v2Workspace(repo: Repo) {
    const base = repo.create({ objects: { b: { id: 'b', name: 'B', type: 'system' } } })
    const head = repo.create<{ objects: Record<string, unknown>; writeBatchIds: string[] }>({ objects: {}, writeBatchIds: [] })
    const connHead = repo.create({ connections: {}, writeBatchIds: [] })
    const meta = repo.create<Meta>({
      objectShardUrls: [base.url, head.url, base.url],
      connectionShardUrls: [connHead.url],
      editsObjectShardUrl: head.url,
      editsObjectShardUrls: [head.url],
      editsConnectionShardUrl: connHead.url,
      editsConnectionShardUrls: [connHead.url],
      groups: {},
    })
    const regB = repo.create<{ diagrams: Record<string, unknown> }>({ diagrams: {} })
    const regA = repo.create<{ diagrams: Record<string, unknown> }>({ diagrams: {} })
    const root = repo.create<Root>({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [regA.url, regB.url] })
    const handles = [base, head, connHead, meta, regA, regB, root]
    await Promise.all(handles.map((h) => h.whenReady()))
    await repo.flush()
    for (const handle of handles) await claim(String(handle.documentId))
    return { repo, root, meta, base, head, connHead, regA, regB }
  }
  const watermarkRow = async (documentId: string) => (await db.pool.query<{ w: string; heads: string[] | null }>(
    `SELECT projected_watermark::text AS w, projected_heads AS heads FROM read_model_document_watermarks
      WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
    [WS.landscapeId, WS.versionId, documentId],
  )).rows[0]
  const idOf = (handle: DocHandle<unknown>) => String(handle.documentId)
  const headsOf = (handle: DocHandle<unknown>) => Automerge.getHeads(handle.doc() as Automerge.Doc<unknown>)

  it('V1: a cold build binds the adopt row to the fence it claimed, writes the id lists in list order WITH the duplicate, the default posture and seal, and the row is adoptable on the plane\'s own terms', async () => {
    const ws = await v2Workspace(storageRepo())
    let instance: string | null = null
    const stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS, undefined, 0, undefined, undefined, undefined,
      (id) => { instance = id })
    try {
      const row = await readAdoptPlane(db.pool, WS)
      expect(instance).not.toBeNull()
      expect(row?.writeFence).toBe(instance)
      expect(row?.fenceBinding).toBe(instance)
      expect(row).toMatchObject({
        adoptVersion: ADOPT_STATE_VERSION,
        rootDocumentId: idOf(ws.root),
        metaDocumentId: idOf(ws.meta),
        objectShardIds: [idOf(ws.base), idOf(ws.head), idOf(ws.base)],
        connectionShardIds: [idOf(ws.connHead)],
        registryShardIds: [idOf(ws.regA), idOf(ws.regB)],
        sealedCeiling: OVERLAY_SEGMENT_ENTITY_CEILING,
        posture: 'rotation=off;fold=off;parking=off;cache=off',
      })
      expect(ADOPT_STATE_VERSION).toBe(2)
      expect(PROJECTION_FORMAT_VERSION, 'C6b must not move the projection version (it keys the extract cache)').toBe(1)
      expect(adoptRefusal(row)).toBeNull()
      // The digest is still the one of the same read (one adoptTopology call).
      expect((await adoptState())?.topology_digest).toBe(expectedTopology(ws.root.doc(), ws.meta.doc()))
      // The fence moving (another cell's claim) leaves the binding behind.
      await db.pool.query('UPDATE read_model_projection_state SET write_fence = $3 WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId, 'cell-b-projector'])
      expect(adoptRefusal(await readAdoptPlane(db.pool, WS))).toBe('fence-moved')
    } finally {
      stop()
    }
  }, 60_000)

  it('V2: the cold build records each shard\'s SAMPLED heads with its watermark; the shard listed twice (no single sampled revision) gets NULL heads', async () => {
    const ws = await v2Workspace(storageRepo())
    const stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS)
    try {
      for (const handle of [ws.head, ws.connHead]) {
        const row = await watermarkRow(idOf(handle))
        expect(BigInt(row!.w)).toBeGreaterThan(0n)
        expect(row!.heads).toEqual(headsOf(handle))
      }
      // Control for the NULL: the duplicated base's certificate is refused too.
      expect(await watermarkRow(idOf(ws.base))).toEqual({ w: '0', heads: null })
    } finally {
      stop()
    }
  }, 60_000)

  it('V3: a delta pass whose shard moves AFTER its sample records the SAMPLED heads (with the refused 0), not the live ones; the next pass records its own', async () => {
    const ws = await v2Workspace(storageRepo())
    const headId = idOf(ws.head)
    let armed = false
    let seen = 0
    let sampled: string[] | null = null
    let releaseSecond!: () => void
    const secondHeld = new Promise<void>((resolve) => { releaseSecond = resolve })
    // Inside the object-shard delta's transaction, after its sample and
    // before its watermark: the row write of the head's objects.
    const pool = poolBeforeQuery(async (text) => {
      if (!armed || !text.includes('INSERT INTO ro_objects')) return
      seen += 1
      if (seen === 1) {
        sampled = headsOf(ws.head)
        ws.head.change((doc) => { doc.objects.y = { id: 'y', name: 'moved under the pass', type: 'system' } })
      } else if (seen === 2) await secondHeld
    })
    const stop = await startReadModelProjector(ws.repo, ws.root.url, pool, WS)
    try {
      armed = true
      ws.head.change((doc) => { doc.objects.x = { id: 'x', name: 'X', type: 'system' } })
      const refused = await until(() => watermarkRow(headId), (row) => row?.w === '0', 15_000)
      expect(refused?.w).toBe('0')
      expect(sampled).not.toBeNull()
      expect(refused!.heads).toEqual(sampled)
      // Witness that live and sampled differ here (else the arm proves nothing).
      expect(headsOf(ws.head)).not.toEqual(sampled)
      releaseSecond()
      const next = await until(() => watermarkRow(headId), (row) => row !== undefined && BigInt(row.w) > 0n, 15_000)
      expect(BigInt(next!.w)).toBeGreaterThan(0n)
      expect(next!.heads).toEqual(headsOf(ws.head))
    } finally {
      releaseSecond()
      stop()
    }
  }, 60_000)

  it('V4: the watermark writers that have no heads write NULL over heads an earlier sample left; the single-document writer records the sample, never the live heads', async () => {
    const prepared = { watermarkPost: '77', durableHeadsById: new Map<string, readonly string[]>([['d1', ['a']], ['d2', ['a']]]) }
    await recordSampledDocumentWatermark(db.pool, WS, 'd1', ['a'], () => ['b'], prepared)
    expect(await watermarkRow('d1')).toEqual({ w: '0', heads: ['a'] })
    await recordSampledDocumentWatermark(db.pool, WS, 'd1', ['a'], () => ['a'], prepared)
    expect(await watermarkRow('d1')).toEqual({ w: '77', heads: ['a'] })
    // recordProjectedWatermarks knows no heads: NULL, not the stale ['a'].
    await recordProjectedWatermarks(db.pool, WS, ['d1'], '80')
    expect(await watermarkRow('d1')).toEqual({ w: '80', heads: null })
    // No sampled heads: NULL (and 0).
    await recordSampledDocumentWatermark(db.pool, WS, 'd2', ['a'], () => ['a'], prepared)
    await recordSampledDocumentWatermark(db.pool, WS, 'd2', null, () => ['a'], prepared)
    expect(await watermarkRow('d2')).toEqual({ w: '0', heads: null })
    // Empty heads are a value, not NULL; order is kept.
    await recordSampledDocumentWatermarks(db.pool, WS, [
      { documentId: 'd3', sampledHeads: [], readCurrentHeads: () => [] },
      { documentId: 'd4', sampledHeads: ['z', 'a'], readCurrentHeads: () => ['z', 'a'] },
      { documentId: 'd5', sampledHeads: ['a'], readCurrentHeads: () => ['a'] },
      { documentId: 'd5', sampledHeads: ['b'], readCurrentHeads: () => ['a'] },
      { documentId: 'd6', sampledHeads: ['s'], readCurrentHeads: () => ['c'] },
      { documentId: 'd7', sampledHeads: ['a'], readCurrentHeads: () => ['a'] },
      { documentId: 'd7', sampledHeads: ['b'], readCurrentHeads: () => ['a'] },
      { documentId: 'd7', sampledHeads: ['a'], readCurrentHeads: () => ['a'] },
    ], { watermarkPost: '90', durableHeadsById: new Map([['d3', []], ['d4', ['z', 'a']], ['d5', ['a']], ['d6', ['s']], ['d7', ['a']]]) })
    // A disagreement is sticky: a, b, a names no single revision either.
    expect(await watermarkRow('d7')).toEqual({ w: '0', heads: null })
    expect(await watermarkRow('d3')).toEqual({ w: '90', heads: [] })
    expect(await watermarkRow('d4')).toEqual({ w: '90', heads: ['z', 'a'] })
    // Moved since its sample: refused, and the heads are the SAMPLE's.
    expect(await watermarkRow('d6')).toEqual({ w: '0', heads: ['s'] })
    // Two samples of one document at different revisions: no single sampled revision.
    expect(await watermarkRow('d5')).toEqual({ w: '0', heads: null })
  }, 60_000)

  it('V5: a row written before C6b (every v2 column NULL), a v2 row never bound, and a row bound to a fence that moved all read as NOT adoptable', async () => {
    await db.pool.query(`INSERT INTO read_model_projection_state (landscape_id, version_id, write_fence) VALUES ($1, $2, $3)`,
      [WS.landscapeId, WS.versionId, FENCE])
    // The pre-C6b writer's statement, as it was.
    await db.pool.query(`INSERT INTO read_model_adopt_state (landscape_id, version_id, format_version, org_id,
        topology_digest, retirements_digest, folds_digest, defects)
      SELECT $1, $2, 1, NULL, 't', digests.retirements, digests.folds, 0
        FROM read_model_adopt_protocol_digests($1, $2) AS digests`, [WS.landscapeId, WS.versionId])
    const old = await readAdoptPlane(db.pool, WS)
    expect(old?.fenceBinding).toBeNull()
    expect(adoptRefusal(old)).toBe('adopt-version')
    // Even with the version forged in, a NULL binding refuses.
    await db.pool.query('UPDATE read_model_adopt_state SET adopt_version = $3 WHERE landscape_id = $1 AND version_id = $2',
      [WS.landscapeId, WS.versionId, ADOPT_STATE_VERSION])
    expect(adoptRefusal(await readAdoptPlane(db.pool, WS))).toBe('fence-unbound')
    // A v2 row written but never bound.
    await inFencedTransaction((tx) => writeAdoptState(tx, WS, fixtureAdoptState()))
    expect(adoptRefusal(await readAdoptPlane(db.pool, WS))).toBe('fence-unbound')
    await inFencedTransaction(async (tx) => { expect(await bindAdoptFence(tx, WS, FENCE)).toBe(true) })
    expect(adoptRefusal(await readAdoptPlane(db.pool, WS))).toBeNull()
    // A rewrite of the row unbinds it (a binding never outlives the row it described).
    await inFencedTransaction((tx) => writeAdoptState(tx, WS, fixtureAdoptState('t2')))
    expect(adoptRefusal(await readAdoptPlane(db.pool, WS))).toBe('fence-unbound')
    expect(adoptRefusal(undefined)).toBe('no-adopt-row')
  }, 60_000)

  it('V6: bindAdoptFence refuses a fence its transaction does not hold (nothing written), and sees a claim made earlier in its own transaction', async () => {
    await adoptRow()
    await expect(inTransaction((tx) => bindAdoptFence(tx, WS, 'not-the-fence'))).rejects.toBeInstanceOf(AdoptFenceBindingError)
    expect((await readAdoptPlane(db.pool, WS))?.fenceBinding).toBeNull()
    // A workspace with no fence row at all is refused too.
    const bare: WorkspaceKey = { landscapeId: 'ls-bare', versionId: 'v1' }
    await expect(inTransaction((tx) => bindAdoptFence(tx, bare, FENCE))).rejects.toBeInstanceOf(AdoptFenceBindingError)
    // THE LOCK ORDER inside the bind: the fence row FOR UPDATE is its first
    // statement, the adopt row second (a C6 caller may hold no fence lock).
    const statements: string[] = []
    await inFencedTransaction(async (tx) => {
      const recorder: Queryable = { query: ((text: string, params?: unknown[]) => {
        statements.push(text)
        return tx.query(text, params)
      }) as Queryable['query'] }
      expect(await bindAdoptFence(recorder, WS, FENCE)).toBe(true)
    })
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/FROM read_model_projection_state[\s\S]*FOR UPDATE/)
    expect(statements[1]).toMatch(/UPDATE read_model_adopt_state/)
    // Claim then bind in ONE transaction: the bind reads the claim.
    await inTransaction(async (tx) => {
      await claimReadModelWriteFence(tx, WS, null, 'new-owner', FENCE)
      expect(await bindAdoptFence(tx, WS, 'new-owner')).toBe(true)
    })
    const row = await readAdoptPlane(db.pool, WS)
    expect(row?.fenceBinding).toBe('new-owner')
    expect(row?.writeFence).toBe('new-owner')
  }, 60_000)

  it('V7: a cold build whose adopt row write FAILS leaves the earlier owner\'s row unbound from the new fence — never the stale row bound to it', async () => {
    const ws = await v2Workspace(storageRepo())
    let first: string | null = null
    const stop1 = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS, undefined, 0, undefined, undefined, undefined,
      (id) => { first = id })
    stop1()
    expect((await readAdoptPlane(db.pool, WS))?.fenceBinding).toBe(first)
    // The second owner's adopt-state write fails; everything else commits.
    let refusedWrites = 0
    const pool = poolBeforeQuery((text) => {
      if (text.includes('INSERT INTO read_model_adopt_state')) { refusedWrites += 1; throw new Error('test: the adopt row write fails') }
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let second: string | null = null
    let stop2: (() => void) | null = null
    try {
      stop2 = await startReadModelProjector(ws.repo, ws.root.url, pool, WS, undefined, 0, undefined, undefined, undefined,
        (id) => { second = id })
      expect(refusedWrites).toBeGreaterThan(0)
      const row = await readAdoptPlane(db.pool, WS)
      expect(row?.writeFence).toBe(second)
      expect(row?.fenceBinding, 'the stale row keeps the OLD binding').toBe(first)
      expect(adoptRefusal(row)).toBe('fence-moved')
    } finally {
      stop2?.()
      errors.mockRestore()
    }
  }, 60_000)

  it('V9: the registry pass and the metadata pass rewrite the id lists with the digest (a registry shard appended to the root, a shard appended to ModelMeta), order and duplicates kept, and leave the binding alone', async () => {
    const ws = await v2Workspace(storageRepo())
    const stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS)
    try {
      const bound = (await readAdoptPlane(db.pool, WS))!.fenceBinding
      expect(bound).not.toBeNull()
      const regC = ws.repo.create<{ diagrams: Record<string, unknown> }>({ diagrams: {} })
      await regC.whenReady()
      await ws.repo.flush([regC.documentId])
      await claim(idOf(regC))
      ws.root.change((root) => { root.shardUrls.push(regC.url, ws.regA.url) })
      const registry = [idOf(ws.regA), idOf(ws.regB), idOf(regC), idOf(ws.regA)]
      const afterRegistry = await until(() => readAdoptPlane(db.pool, WS),
        (row) => JSON.stringify(row?.registryShardIds) === JSON.stringify(registry), 15_000)
      expect(afterRegistry?.registryShardIds).toEqual(registry)
      expect(afterRegistry?.rootDocumentId).toBe(idOf(ws.root))
      expect(afterRegistry?.metaDocumentId).toBe(idOf(ws.meta))
      expect(adoptRefusal(afterRegistry)).toBeNull()
      expect((await adoptState())?.topology_digest).toBe(expectedTopology(ws.root.doc(), ws.meta.doc()))
      const extra = ws.repo.create({ objects: { e: { id: 'e', name: 'E', type: 'system' } } })
      await extra.whenReady()
      await ws.repo.flush([extra.documentId])
      await claim(idOf(extra))
      ws.meta.change((meta) => { meta.objectShardUrls.push(extra.url) })
      const objects = [idOf(ws.base), idOf(ws.head), idOf(ws.base), idOf(extra)]
      const afterMeta = await until(() => readAdoptPlane(db.pool, WS),
        (row) => JSON.stringify(row?.objectShardIds) === JSON.stringify(objects), 15_000)
      expect(afterMeta?.objectShardIds).toEqual(objects)
      expect((await adoptState())?.topology_digest).toBe(expectedTopology(ws.root.doc(), ws.meta.doc()))
      expect(afterMeta?.fenceBinding).toBe(bound)
      expect(afterMeta?.rootDocumentId).toBe(idOf(ws.root))
      expect(afterMeta?.metaDocumentId).toBe(idOf(ws.meta))
      expect(adoptRefusal(afterMeta)).toBeNull()
      // The connection list follows too (a duplicate appended).
      const connExtra = ws.repo.create({ connections: {} })
      await connExtra.whenReady()
      await ws.repo.flush([connExtra.documentId])
      await claim(idOf(connExtra))
      ws.meta.change((meta) => { meta.connectionShardUrls.push(connExtra.url, ws.connHead.url) })
      const connections = [idOf(ws.connHead), idOf(connExtra), idOf(ws.connHead)]
      const afterConn = await until(() => readAdoptPlane(db.pool, WS),
        (row) => JSON.stringify(row?.connectionShardIds) === JSON.stringify(connections), 15_000)
      expect(afterConn?.connectionShardIds).toEqual(connections)
    } finally {
      stop()
    }
  }, 60_000)

  it('V10: a BOUND v2 row still refuses on each NULL list or id, a NULL seal or posture, and a defect count (a defected shard keeps an earlier build\'s watermark row)', async () => {
    await adoptRow()
    await inFencedTransaction(async (tx) => { expect(await bindAdoptFence(tx, WS, FENCE)).toBe(true) })
    expect(adoptRefusal(await readAdoptPlane(db.pool, WS))).toBeNull()
    const cases: Array<[string, string]> = [
      ['root_document_id = NULL', 'topology-lists'], ['meta_document_id = NULL', 'topology-lists'],
      ['object_shard_ids = NULL', 'topology-lists'], ['connection_shard_ids = NULL', 'topology-lists'],
      ['registry_shard_ids = NULL', 'topology-lists'], ['sealed_ceiling = NULL', 'posture'],
      ['posture = NULL', 'posture'], ['defects = 1', 'defects'],
    ]
    for (const [set, reason] of cases) {
      const client = await db.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`UPDATE read_model_adopt_state SET ${set} WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
        expect(adoptRefusal(await readAdoptPlane(client, WS)), set).toBe(reason)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
      // Rolled back: the control still adopts.
      expect(adoptRefusal(await readAdoptPlane(db.pool, WS)), `after ${set}`).toBeNull()
    }
  }, 60_000)

  it('V8: a projector that rotates and folds records that posture and ITS seal', async () => {
    const ws = await v2Workspace(storageRepo())
    const rotation: OrdinaryHeadRotationConfig = {
      mode: 'on', allowlist: 'all', maxActors: 1_000_000, maxChanges: 1_000_000,
      chainFold: { minChain: 1_000, budget: 2, retainMs: 86_400_000, segmentCeiling: 7 },
    }
    const stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS, undefined, 0, undefined, undefined, undefined,
      undefined, rotation)
    try {
      expect(await readAdoptPlane(db.pool, WS)).toMatchObject({
        sealedCeiling: 7,
        // No residency: nothing is parked, so no extract cache either.
        posture: 'rotation=on;fold=on;parking=off;cache=off',
      })
    } finally {
      stop()
    }
  }, 60_000)

  // ------------------------------------------------- THE PROTOCOL DIGESTS
  // Each arm: an adopt row, ONE real writer committed, then the stored row
  // equals the independent recomputation — and differs from before (the
  // writer changed something, so the equality is not vacuous).

  /** Run `write` in its own committed transaction; the stored digests must
   * then equal the independent ones, and have moved. */
  async function expectMaintained(write: (tx: pg.PoolClient) => Promise<unknown>): Promise<void> {
    const before = await storedProtocolDigests()
    expect(before).toBeDefined()
    await inFencedTransaction(write)
    const after = await storedProtocolDigests()
    expect(after).toEqual(await independentProtocolDigests())
    expect(after).not.toEqual(before)
  }

  it('P1: the rotator\'s retirement (an INSERT, then the upsert of the same head) keeps the stored digests equal to the tables', async () => {
    await adoptRow()
    await expectMaintained((tx) => commitOrdinaryHeadRetirement(tx, WS, 'object', 'head-1', ['h1']))
    await expectMaintained((tx) => commitOrdinaryHeadRetirement(tx, WS, 'object', 'head-1', ['h2']))
    await expectMaintained((tx) => recordOrdinaryHeadRetirement(tx, WS, { collection: 'connection', documentId: 'c-1', retirementHeads: ['x'], status: 'retired' }))
  }, 60_000)

  it('P2: a forward (commitForwardedHeads) keeps them', async () => {
    await adoptRow()
    await commitOrdinaryHeadRetirement(protocolFixtureDb(db.pool), WS, 'object', 'head-1', ['h1'])
    await expectMaintained(async (tx) => expect(await commitForwardedHeads(tx, WS, 'object', 'head-1', null, ['h1', 'late'])).toBe(true))
  }, 60_000)

  it('P3: a fold record, its folded-arrival watermark advance, its abandon, and the sweep each keep them', async () => {
    await adoptRow()
    for (const id of ['s1', 's2']) await commitOrdinaryHeadRetirement(protocolFixtureDb(db.pool), WS, 'object', id, [`h-${id}`])
    const retainUntil = new Date(Date.now() + 3_600_000)
    await expectMaintained(async (tx) => expect(await recordOrdinaryChainFold(tx, WS, {
      collection: 'object', productDocumentId: 'p1', productHeads: ['hp'], currentDocumentId: 'current',
      sources: [{ documentId: 's1', forwardedHeads: null }, { documentId: 's2', forwardedHeads: null }], retainUntil,
    })).toBe('recorded'))
    expect((await storedProtocolDigests())!.folds_digest).not.toBe(EMPTY_DIGEST)
    await expectMaintained(async (tx) => expect(await advanceFoldedArrivalWatermark(tx, WS, 'object', 's1', null, '42')).toBe(true))
    await expectMaintained(async (tx) => expect(await abandonOrdinaryChainFold(tx, WS, { collection: 'object', productDocumentId: 'p1' }))
      .toEqual({ outcome: 'abandoned', reverted: ['s1', 's2'] }))
    // The sweep: s1 folded into p2, p2 itself folded into p3 long enough ago.
    await expectMaintained(async (tx) => expect(await recordOrdinaryChainFold(tx, WS, {
      collection: 'object', productDocumentId: 'p2', productHeads: ['hp2'], currentDocumentId: 'current',
      sources: [{ documentId: 's1', forwardedHeads: null }], retainUntil,
    })).toBe('recorded'))
    await expectMaintained(async (tx) => expect(await recordOrdinaryChainFold(tx, WS, {
      collection: 'object', productDocumentId: 'p3', productHeads: ['hp3'], currentDocumentId: 'current',
      sources: [{ documentId: 'p2', forwardedHeads: null }], retainUntil,
    })).toBe('recorded'))
    await protocolFixtureQuery(db.pool, `UPDATE read_model_ordinary_head_retirements SET retain_until = now() - interval '1 hour',
      updated_at = now() - interval '1 hour' WHERE landscape_id = $1 AND document_id IN ('s1', 'p2')`, [WS.landscapeId])
    await expectMaintained(async (tx) => expect(await sweepOrdinaryChainFoldRows(tx, WS, 'object'))
      .toEqual({ rows: 1, records: 1 }))
  }, 60_000)

  it('P4: a workspace with no adopt row gets none from a protocol write, and another workspace\'s write leaves this row as it was', async () => {
    const other: WorkspaceKey = { landscapeId: 'ls-other', versionId: 'v1' }
    await commitOrdinaryHeadRetirement(db.pool, other, 'object', 'o-1', ['h'])
    expect(await adoptState(other)).toBeUndefined()
    await adoptRow()
    await adoptRow(other)
    const mine = await storedProtocolDigests()
    await inFencedTransaction((tx) => commitOrdinaryHeadRetirement(tx, other, 'object', 'o-2', ['h']), other)
    expect(await storedProtocolDigests()).toEqual(mine)
    expect(await storedProtocolDigests(other)).toEqual(await independentProtocolDigests(other))
    expect(await storedProtocolDigests(other)).not.toEqual(mine)
  }, 60_000)

  it('P5: the cold build\'s row starts equal to the tables (rows written before it) and every column the digest documents moves it', async () => {
    await db.pool.query(`INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id)
      VALUES ($1, $2, 'object', 'd1')`, [WS.landscapeId, WS.versionId])
    await db.pool.query(`INSERT INTO read_model_ordinary_chain_folds (landscape_id, version_id, collection, product_document_id, source_document_ids)
      VALUES ($1, $2, 'object', 'p', ARRAY['s1'])`, [WS.landscapeId, WS.versionId])
    await adoptRow()
    expect(await storedProtocolDigests()).toEqual(await independentProtocolDigests())
    const steps = [
      `UPDATE read_model_ordinary_head_retirements SET retirement_heads = ARRAY['h']`,
      `UPDATE read_model_ordinary_head_retirements SET forwarded_heads = ARRAY['f']`,
      `UPDATE read_model_ordinary_head_retirements SET status = 'retired'`,
      `UPDATE read_model_ordinary_head_retirements SET origin = 'rotation'`,
      `UPDATE read_model_ordinary_head_retirements SET status = 'folded', folded_into = 'p', retain_until = TIMESTAMPTZ '2030-01-01 00:00:00+00'`,
      `UPDATE read_model_ordinary_head_retirements SET retain_until = TIMESTAMPTZ '2030-01-01 00:00:00.000001+00'`,
      `UPDATE read_model_ordinary_head_retirements SET folded_into = 'q'`,
      `UPDATE read_model_ordinary_head_retirements SET arrival_watermark = 5`,
      `UPDATE read_model_ordinary_head_retirements SET origin = 'fold-product'`,
      `UPDATE read_model_ordinary_chain_folds SET source_document_ids = ARRAY['s1', 's2']`,
      `UPDATE read_model_ordinary_chain_folds SET source_document_ids = ARRAY['s2', 's1']`,
      `DELETE FROM read_model_ordinary_chain_folds`,
      `DELETE FROM read_model_ordinary_head_retirements`,
    ]
    const seen = new Set([JSON.stringify(await storedProtocolDigests())])
    for (const sql of steps) {
      await protocolFixtureQuery(db.pool, sql)
      const stored = await storedProtocolDigests()
      expect(stored, sql).toEqual(await independentProtocolDigests())
      expect(seen.has(JSON.stringify(stored)), `the digests must move with: ${sql}`).toBe(false)
      seen.add(JSON.stringify(stored))
    }
    expect(await storedProtocolDigests()).toEqual({ retirements_digest: EMPTY_DIGEST, folds_digest: EMPTY_DIGEST })
  }, 60_000)

  it('P6: a TRUNCATE of the protocol tables (tests only) re-stamps the adopt rows it leaves', async () => {
    await commitOrdinaryHeadRetirement(protocolFixtureDb(db.pool), WS, 'object', 'head-1', ['h1'])
    await adoptRow()
    expect((await storedProtocolDigests())!.retirements_digest).not.toBe(EMPTY_DIGEST)
    await db.pool.query('TRUNCATE read_model_ordinary_head_retirements')
    expect(await storedProtocolDigests()).toEqual({ retirements_digest: EMPTY_DIGEST, folds_digest: EMPTY_DIGEST })
  }, 60_000)

  it('P7: two protocol writers of one workspace with NO fence row, the second waiting on the first, still leave the digests of both', async () => {
    await adoptRow()
    await db.pool.query('DELETE FROM read_model_projection_state')
    const first = await db.pool.connect()
    const second = await db.pool.connect()
    try {
      await first.query('BEGIN')
      await commitOrdinaryHeadRetirement(first, WS, 'object', 'one', ['h1'])
      await second.query('BEGIN')
      const waiting = commitOrdinaryHeadRetirement(second, WS, 'object', 'two', ['h2'])
      await new Promise((r) => setTimeout(r, 300))
      await first.query('COMMIT')
      await waiting
      await second.query('COMMIT')
    } finally {
      first.release()
      second.release()
    }
    expect(await storedProtocolDigests()).toEqual(await independentProtocolDigests())
  }, 60_000)

  // ---------------------------------------------------------- LOCK ORDER
  // The order is ENFORCED by the protocol tables' trigger (`schema.ts`):
  // a write in a transaction that has not taken the workspace's fence row
  // through `assertReadModelWriteFence` is refused at its own statement,
  // contended or not. LOCK ORDER 2 and 3 pin the refusal; the projector's
  // own closures are pinned where they are driven (`commit`,
  // `commitFoldedArrival`, `commitDetachedWatermarks`, the rotator, the fold
  // writer and the settle — every projector-driven suite goes red on a
  // misordered one, checked by reordering each of them).

  it('LOCK ORDER 1: a projector adopt write that started first takes the fence row before the adopt row, so a fold-shaped writer waits and both commit', async () => {
    await commitOrdinaryHeadRetirement(protocolFixtureDb(db.pool), WS, 'object', 'head-1', ['h1'])
    await adoptRow()
    const projector = await db.pool.connect()
    const writer = await db.pool.connect()
    try {
      await projector.query('BEGIN')
      await writer.query('BEGIN')
      // A metadata pass's adopt write, then a fold-shaped writer: fence row first, then its row.
      expect(await withAdoptSavepoint(projector, WS, () => updateAdoptTopology(projector, WS, fixtureTopology('raced')))).toBe(true)
      let waited = true
      const writing = assertReadModelWriteFence(writer, WS, FENCE).then(() => { waited = false })
        .then(() => commitForwardedHeads(writer, WS, 'object', 'head-1', null, ['h1', 'late']))
      await new Promise((r) => setTimeout(r, 300))
      expect(waited, 'the writer waits on the fence row the projector holds').toBe(true)
      await assertReadModelWriteFence(projector, WS, FENCE)
      await projector.query('COMMIT')
      expect(await writing).toBe(true)
      await writer.query('COMMIT')
    } finally {
      await projector.query('ROLLBACK').catch(() => {})
      await writer.query('ROLLBACK').catch(() => {})
      projector.release()
      writer.release()
    }
    expect((await adoptState())?.topology_digest).toBe('raced')
    expect(await storedProtocolDigests()).toEqual(await independentProtocolDigests())
  }, 60_000)

  it('LOCK ORDER 2: a protocol write made BEFORE its transaction takes the fence row is refused at that statement, uncontended, on both tables and every statement kind', async () => {
    await commitOrdinaryHeadRetirement(protocolFixtureDb(db.pool), WS, 'object', 'head-1', ['h1'])
    await adoptRow()
    const before = await storedProtocolDigests()
    const writes = [
      `INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id) VALUES ($1, $2, 'object', 'new')`,
      `UPDATE read_model_ordinary_head_retirements SET forwarded_heads = ARRAY['late'] WHERE landscape_id = $1 AND version_id = $2`,
      `DELETE FROM read_model_ordinary_head_retirements WHERE landscape_id = $1 AND version_id = $2`,
      `INSERT INTO read_model_ordinary_chain_folds (landscape_id, version_id, collection, product_document_id, source_document_ids)
         VALUES ($1, $2, 'object', 'p', ARRAY['head-1'])`,
    ]
    for (const sql of writes) {
      await expect(inTransaction((tx) => tx.query(sql, [WS.landscapeId, WS.versionId])), sql)
        .rejects.toThrow(/read-model lock order: .* without its read_model_projection_state row held first/)
      // The same statement after the fence: admitted.
      await inFencedTransaction((tx) => tx.query(sql, [WS.landscapeId, WS.versionId]))
    }
    // Nothing the refused statements did survived, and the digests followed the admitted ones.
    expect(await storedProtocolDigests()).not.toEqual(before)
    expect(await storedProtocolDigests()).toEqual(await independentProtocolDigests())
    // A production writer handed a transaction that never asserted the fence.
    await expect(inTransaction((tx) => commitOrdinaryHeadRetirement(tx, WS, 'object', 'head-2', ['h2'])))
      .rejects.toThrow(/read-model lock order/)
  }, 60_000)

  it('LOCK ORDER 3: the mark is per workspace and per transaction — another workspace\'s fence, a fence rolled back with its savepoint, and an earlier transaction\'s fence do not admit', async () => {
    const other: WorkspaceKey = { landscapeId: 'ls-other', versionId: 'v1' }
    await adoptRow()
    await adoptRow(other)
    const write = (tx: pg.PoolClient) => commitOrdinaryHeadRetirement(tx, WS, 'object', 'head-1', ['h1'])
    await expect(inFencedTransaction(write, other)).rejects.toThrow(/read-model lock order/)
    await expect(inTransaction(async (tx) => {
      await tx.query('SAVEPOINT fence')
      await assertReadModelWriteFence(tx, WS, FENCE)
      await tx.query('ROLLBACK TO SAVEPOINT fence')
      await write(tx)
    })).rejects.toThrow(/read-model lock order/)
    const client = await db.pool.connect()
    try {
      await client.query('BEGIN')
      await assertReadModelWriteFence(client, WS, FENCE)
      await client.query('COMMIT')
      await client.query('BEGIN')
      await expect(write(client)).rejects.toThrow(/read-model lock order/)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    // Control: the same write, fenced, is admitted.
    await inFencedTransaction(write)
    expect(await storedProtocolDigests()).toEqual(await independentProtocolDigests())
  }, 60_000)

  // ------------------------------------------------------- MIXED VERSION
  // The previous release has no adopt plane and never
  // touches the triggers; once this version has booted they stay through a
  // rollback. Its connections carry no participant marker
  // (`protocolParticipant.ts`) — simulated by a bare `pg.Client`, which no
  // pool guard ever saw — and its writers write the row, THEN take the fence
  // row with its own assertion (a plain FOR UPDATE, nothing recorded).

  /** A connection of a process that does not know the protocol. */
  async function developClient(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: connection!, options: `-c search_path=${db.schema}` })
    client.on('error', () => {})
    await client.connect()
    return client
  }
  /** The previous release's `assertReadModelWriteFence`, verbatim in effect. */
  const developFence = (client: pg.Client, key: WorkspaceKey = WS) => client.query(
    `SELECT write_fence FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2 FOR UPDATE`,
    [key.landscapeId, key.versionId])
  const participant = async (q: { query: pg.Pool['query'] }) =>
    (await q.query<{ v: string | null }>(`SELECT current_setting('maplespire.read_model_protocol', true) AS v`)).rows[0]!.v

  it('MIXED VERSION 1: a previous-release writer (no marker; write, then fence) is ADMITTED on every statement kind and its writes keep the digests; the same writer on this version\'s pool, fence omitted, is REFUSED', async () => {
    await commitOrdinaryHeadRetirement(protocolFixtureDb(db.pool), WS, 'object', 'head-1', ['h1'])
    await adoptRow()
    const develop = await developClient()
    try {
      expect(await participant(develop), 'a bare client is a non-participant').toBeNull()
      expect(await participant(db.pool), 'every connection of a guarded pool is a participant').toBe('2')
      const writes: Array<(c: pg.Client) => Promise<unknown>> = [
        (c) => commitOrdinaryHeadRetirement(c, WS, 'object', 'dev-1', ['d1']),
        (c) => commitForwardedHeads(c, WS, 'object', 'head-1', null, ['h1', 'late']),
        (c) => c.query(`INSERT INTO read_model_ordinary_chain_folds (landscape_id, version_id, collection, product_document_id, source_document_ids)
          VALUES ($1, $2, 'object', 'p-dev', ARRAY['head-1'])`, [WS.landscapeId, WS.versionId]),
        (c) => c.query(`DELETE FROM read_model_ordinary_head_retirements WHERE landscape_id = $1 AND version_id = $2 AND document_id = 'dev-1'`,
          [WS.landscapeId, WS.versionId]),
      ]
      for (const write of writes) {
        const before = await storedProtocolDigests()
        await develop.query('BEGIN')
        await write(develop)
        await developFence(develop)
        await develop.query('COMMIT')
        const after = await storedProtocolDigests()
        expect(after, String(write)).not.toEqual(before)
        expect(after, String(write)).toEqual(await independentProtocolDigests())
      }
    } finally {
      await develop.query('ROLLBACK').catch(() => {})
      await develop.end()
    }
    // This version, the same production writer, the fence omitted: refused.
    await expect(inTransaction((tx) => commitOrdinaryHeadRetirement(tx, WS, 'object', 'dev-2', ['d2'])))
      .rejects.toThrow(/read-model lock order/)
    await expect(inTransaction(async (tx) => {
      await commitOrdinaryHeadRetirement(tx, WS, 'object', 'dev-2', ['d2'])
      await assertReadModelWriteFence(tx, WS, FENCE) // write-then-fence, the previous release's order
    })).rejects.toThrow(/read-model lock order/)
  }, 60_000)

  it('MIXED VERSION 2 (the residual): a previous-release writer holding its retirement row against this version holding the fence row is a deadlock PostgreSQL detects — one aborts with 40P01, the other commits, the digests are kept', async () => {
    await commitOrdinaryHeadRetirement(protocolFixtureDb(db.pool), WS, 'object', 'head-1', ['h1'])
    await adoptRow()
    const develop = await developClient()
    const mine = await db.pool.connect()
    try {
      await mine.query('BEGIN')
      await assertReadModelWriteFence(mine, WS, FENCE)
      await develop.query('BEGIN')
      const developPid = (await develop.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      // The previous release: its row first; its statement's re-stamp then waits on the fence row.
      const developWrite = commitForwardedHeads(develop, WS, 'object', 'head-1', null, ['dev'])
        .then(async () => { await developFence(develop); await develop.query('COMMIT'); return 'committed' },
          (error: { code?: string }) => error.code ?? String(error))
      await until(async () => (await db.pool.query<{ w: string | null }>(
        'SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1', [developPid])).rows[0]?.w, (w) => w === 'Lock')
      // This version: the fence row held, now the row the previous release holds.
      const mineWrite = commitForwardedHeads(mine, WS, 'object', 'head-1', null, ['mine'])
        .then(async () => { await mine.query('COMMIT'); return 'committed' }, (error: { code?: string }) => error.code ?? String(error))
      const outcomes = await Promise.all([developWrite, mineWrite])
      expect([...outcomes].sort()).toEqual(['40P01', 'committed'])
    } finally {
      await develop.query('ROLLBACK').catch(() => {})
      await mine.query('ROLLBACK').catch(() => {})
      mine.release()
      await develop.end()
    }
    expect(await storedProtocolDigests()).toEqual(await independentProtocolDigests())
  }, 60_000)

  it('PRESET: a fence-rows value set outside the transaction — ALTER ROLE … SET (the fixtures\' old wildcard, a bare token, another transaction\'s wildcard) or a session SET — admits nothing', async () => {
    await adoptRow()
    const role = `g416f_preset_${randomBytes(4).toString('hex')}`
    const password = randomBytes(16).toString('hex')
    await db.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
    const url = new URL(connection!)
    url.username = role
    url.password = password
    // The token as `assertReadModelWriteFence` builds it (md5 of the jsonb array's text).
    const token = createHash('md5').update(jsonbText([WS.landscapeId, WS.versionId])).digest('hex')
    try {
      await db.pool.query(`GRANT USAGE ON SCHEMA ${db.schema} TO ${role}`)
      await db.pool.query(`GRANT ALL ON ALL TABLES IN SCHEMA ${db.schema} TO ${role}`)
      for (const preset of [',*', `,${token}`, ',1:*', `,1:${token}`]) {
        await db.pool.query(`ALTER ROLE ${role} SET maplespire.read_model_fence_rows = '${preset}'`)
        const pool = guardIdleClientErrors(new pg.Pool({ connectionString: url.toString(), max: 1, options: `-c search_path=${db.schema}` }), 'preset')
        try {
          const client = await pool.connect()
          try {
            // Witnesses: the role setting reached the session; the session is a participant.
            expect((await client.query<{ v: string }>(`SELECT current_setting('maplespire.read_model_fence_rows') AS v`)).rows[0]!.v).toBe(preset)
            expect(await participant(client)).toBe('2')
            await client.query('BEGIN')
            await expect(commitOrdinaryHeadRetirement(client, WS, 'object', 'preset', ['p']), preset).rejects.toThrow(/read-model lock order/)
            await client.query('ROLLBACK')
            // A session-level SET is no better.
            await client.query(`SET maplespire.read_model_fence_rows = '${preset}'`)
            await client.query('BEGIN')
            await expect(commitOrdinaryHeadRetirement(client, WS, 'object', 'preset', ['p']), `SET ${preset}`).rejects.toThrow(/read-model lock order/)
            await client.query('ROLLBACK')
            // Control: this role CAN write, through the fence of this transaction.
            await client.query('BEGIN')
            await assertReadModelWriteFence(client, WS, FENCE)
            await commitOrdinaryHeadRetirement(client, WS, 'object', 'preset', ['p'])
            await client.query('ROLLBACK')
          } finally {
            await client.query('ROLLBACK').catch(() => {})
            client.release()
          }
        } finally {
          await pool.end()
        }
      }
    } finally {
      await db.pool.query(`DROP OWNED BY ${role}`).catch(() => {})
      await db.pool.query(`DROP ROLE IF EXISTS ${role}`)
    }
    expect(await storedProtocolDigests()).toEqual(await independentProtocolDigests())
  }, 60_000)

  it('LOCK ORDER 4: no production module or `qa/` harness can take the fixtures\' wildcard or touch either protocol setting (they live in health.ts, schema.ts, protocolParticipant.ts, poolErrorGuard.ts and testing/ only)', () => {
    const server = fileURLToPath(new URL('../..', import.meta.url))
    const scanned = ['src', 'qa'].flatMap((dir) => readdirSync(`${server}/${dir}`, { recursive: true, encoding: 'utf8' })
      .map((file) => `${dir}/${file.replace(/\\/g, '/')}`))
      .filter((file) => /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(file) && !/\.test\.[cm]?[jt]s$/.test(file)
        && !file.startsWith('src/testing/'))
    // The walk sees every module kind it claims to: TypeScript, the .mjs
    // workers and the `qa/` harnesses (.mts, .mjs).
    expect(scanned.filter((file) => file.startsWith('src/') && file.endsWith('.ts')).length).toBeGreaterThan(100)
    expect(scanned).toEqual(expect.arrayContaining(['src/readModel/durableHeadsWorker.mjs', 'qa/g416f-trigger-cost.mts', 'qa/lib.mjs']))
    const offenders = scanned
      .map((file) => ({ file, reasons: protocolBypassReasons(file, readFileSync(`${server}/${file}`, 'utf8')) }))
      .filter((found) => found.reasons.length)
    expect(offenders).toEqual([])
    // The detector sees each shape (its controls), and lets the owners be.
    const samples: Array<[string, string]> = [
      ['static import', `import { markProtocolFixture } from '../testing/protocolFixture.js'`],
      ['dynamic import', `export const later = () => import("../testing/protocolFixture.js")`],
      ['require', `const fixture = require('../testing/protocolFixture.js')`],
      ['a wildcard built at run time', `SELECT set_config('maplespire.read_model_fence_rows', ',' || '*', true)`],
      ['the setting constant', `import { PROTOCOL_FENCE_ROWS_SETTING } from './health.js'`],
      ['the participant marker cleared', `SET LOCAL maplespire.read_model_protocol = ''`],
      ['the participant constant', `import { READ_MODEL_PROTOCOL_SETTING } from './protocolParticipant.js'`],
    ]
    for (const [shape, text] of samples) expect(protocolBypassReasons('src/readModel/x.ts', text), shape).not.toEqual([])
    expect(protocolBypassReasons('src/readModel/x.ts', 'read_model_adopt_protocol_restamp, read_model_protocol_x')).toEqual([])
    for (const owner of ['src/readModel/health.ts', 'src/readModel/schema.ts']) {
      expect(protocolBypassReasons(owner, readFileSync(`${server}/${owner}`, 'utf8')), owner).toEqual([])
    }
    expect(protocolBypassReasons('src/readModel/health.ts', `import('../testing/protocolFixture.js')`)).not.toEqual([])
  })
})

suite('G4-16f — the adopt protocol triggers: statement shapes, the schema lifecycle, and concurrent writers (PostgreSQL)', () => {
  const A: WorkspaceKey = { landscapeId: 'ls-trig-a', versionId: 'v1' }
  const B: WorkspaceKey = { landscapeId: 'ls-trig-b', versionId: 'v1' }
  let tdb: IsolatedSchemaDb
  const fx = (sql: string, params?: unknown[]) => protocolFixtureQuery(tdb.pool, sql, params)
  const stored = async (key: WorkspaceKey) => (await tdb.pool.query<{ retirements_digest: string; folds_digest: string }>(
    'SELECT retirements_digest, folds_digest FROM read_model_adopt_state WHERE landscape_id = $1 AND version_id = $2',
    [key.landscapeId, key.versionId])).rows[0]
  const live = async (key: WorkspaceKey) => (await tdb.pool.query<{ retirements: string; folds: string }>(
    'SELECT * FROM read_model_adopt_protocol_digests($1, $2)', [key.landscapeId, key.versionId])).rows[0]!
  const expectKept = async (key: WorkspaceKey) => {
    const [s, l] = [await stored(key), await live(key)]
    expect({ r: s?.retirements_digest, f: s?.folds_digest }).toEqual({ r: l.retirements, f: l.folds })
  }
  const row = (key: WorkspaceKey, id: string) => fx(
    `INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id) VALUES ($1, $2, 'object', $3)`,
    [key.landscapeId, key.versionId, id])
  const line = async (key: WorkspaceKey, collection: string, id: string) => (await tdb.pool.query<{ r: string }>(
    `SELECT jsonb_build_array(collection, document_id, status, retirement_heads, forwarded_heads, folded_into,
       (extract(epoch FROM retain_until) * 1000000)::bigint::text, arrival_watermark::text, origin)::text AS r
       FROM read_model_ordinary_head_retirements WHERE landscape_id = $1 AND collection = $2 AND document_id = $3`,
    [key.landscapeId, collection, id])).rows[0]!.r
  /** This schema's adopt protocol triggers (other suites' schemas share the database). */
  const triggers = async () => (await tdb.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relnamespace = current_schema()::regnamespace AND t.tgname LIKE 'read_model_adopt_protocol_%'`)).rows[0]!.n
  async function withAdoptRow(key: WorkspaceKey): Promise<void> {
    await tdb.pool.query(`INSERT INTO read_model_projection_state (landscape_id, version_id, write_fence) VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING`, [key.landscapeId, key.versionId, FENCE])
    const client = await tdb.pool.connect()
    try {
      await client.query('BEGIN')
      await withAdoptSavepoint(client, key, () => writeAdoptState(client, key, fixtureAdoptState()))
      await client.query('COMMIT')
    } finally { client.release() }
  }

  beforeAll(async () => {
    tdb = await createIsolatedSchemaDb(connection!, 'adopt_protocol_triggers')
    await ensureReadModelSchema(tdb.pool)
    await tdb.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
  })
  afterAll(async () => { await tdb?.teardown() })
  beforeEach(async () => {
    await tdb.pool.query('TRUNCATE read_model_ordinary_head_retirements, read_model_ordinary_chain_folds, read_model_adopt_state, read_model_projection_state')
    await withAdoptRow(A)
    await withAdoptRow(B)
  })

  it('X1: an UPDATE that MOVES a row from one workspace to another re-stamps BOTH', async () => {
    await row(A, 'moved')
    await expectKept(A)
    await fx(`UPDATE read_model_ordinary_head_retirements SET landscape_id = $1 WHERE landscape_id = $2 AND document_id = 'moved'`,
      [B.landscapeId, A.landscapeId])
    await expectKept(A)
    await expectKept(B)
    expect((await stored(B))!.retirements_digest).not.toBe(EMPTY_DIGEST)
  })

  it('X2: ONE multi-row INSERT into two workspaces re-stamps both; X3: several rows of one workspace, all of them', async () => {
    await fx(`INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id)
      VALUES ($1, 'v1', 'object', 'x1'), ($2, 'v1', 'object', 'x2')`, [A.landscapeId, B.landscapeId])
    await expectKept(A)
    await expectKept(B)
    await fx(`INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id)
      VALUES ($1, 'v1', 'object', 'm1'), ($1, 'v1', 'object', 'm2'), ($1, 'v1', 'object', 'm3')`, [A.landscapeId])
    await expectKept(A)
    expect((await stored(A))!.retirements_digest).not.toBe((await stored(B))!.retirements_digest)
  })

  it('X4: a multi-workspace DELETE and X5: a multi-workspace UPDATE re-stamp both; X6: an UPDATE of zero rows changes nothing and does not fail', async () => {
    await row(A, 'd1')
    await row(B, 'd2')
    await fx(`UPDATE read_model_ordinary_head_retirements SET forwarded_heads = ARRAY['z']`)
    await expectKept(A)
    await expectKept(B)
    const before = await stored(A)
    await fx(`UPDATE read_model_ordinary_head_retirements SET forwarded_heads = ARRAY['y'] WHERE false`)
    expect(await stored(A)).toEqual(before)
    await fx('DELETE FROM read_model_ordinary_head_retirements')
    await expectKept(A)
    await expectKept(B)
    expect((await stored(A))!.retirements_digest).toBe(EMPTY_DIGEST)
  })

  it('X7: INSERT .. ON CONFLICT DO UPDATE (the rotator\'s upsert) over an existing row re-stamps', async () => {
    await row(A, 'k')
    const before = await stored(A)
    await fx(`INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id, retirement_heads)
      VALUES ($1, 'v1', 'object', 'k', ARRAY['h']) ON CONFLICT (landscape_id, version_id, collection, document_id)
      DO UPDATE SET retirement_heads = EXCLUDED.retirement_heads`, [A.landscapeId])
    await expectKept(A)
    expect(await stored(A)).not.toEqual(before)
  })

  it('X8: chain folds — a multi-workspace INSERT, an UPDATE moving a row out, a TRUNCATE', async () => {
    await fx(`INSERT INTO read_model_ordinary_chain_folds (landscape_id, version_id, collection, product_document_id, source_document_ids)
      VALUES ($1, 'v1', 'object', 'p', ARRAY['s']), ($2, 'v1', 'object', 'p', ARRAY['s'])`, [A.landscapeId, B.landscapeId])
    await expectKept(A)
    await expectKept(B)
    await fx(`UPDATE read_model_ordinary_chain_folds SET landscape_id = 'ls-trig-c' WHERE landscape_id = $1`, [A.landscapeId])
    await expectKept(A)
    expect((await stored(A))!.folds_digest).toBe(EMPTY_DIGEST)
    await tdb.pool.query('TRUNCATE read_model_ordinary_chain_folds')
    await expectKept(B)
    expect((await stored(B))!.folds_digest).toBe(EMPTY_DIGEST)
  })

  it('X9: the sort is collection FIRST, then id, in byte order (C collation) — an independent hash over mixed-case and non-ASCII ids agrees', async () => {
    await fx(`INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id)
      VALUES ($1, 'v1', 'object', 'a'), ($1, 'v1', 'connection', 'z')`, [A.landscapeId])
    expect((await stored(A))!.retirements_digest)
      .toBe(sha256Lines([await line(A, 'connection', 'z'), await line(A, 'object', 'a')]))
    for (const id of ['b', 'B', 'A', '_', 'é', 'z-1', 'z_1']) await row(A, id)
    const ids = ['a', 'b', 'B', 'A', '_', 'é', 'z-1', 'z_1'].sort(byteOrder)
    const lines = [await line(A, 'connection', 'z')]
    for (const id of ids) lines.push(await line(A, 'object', id))
    expect((await stored(A))!.retirements_digest).toBe(sha256Lines(lines))
  })

  it('X10: ensureReadModelSchema REPLACES a function whose body changed (an older body on an existing database does not survive a boot)', async () => {
    await tdb.pool.query(`CREATE OR REPLACE FUNCTION read_model_adopt_protocol_digests(p_landscape TEXT, p_version TEXT, OUT retirements TEXT, OUT folds TEXT)
      LANGUAGE sql STABLE AS $$ SELECT 'stale'::text, 'stale'::text $$`)
    expect((await live(A)).retirements).toBe('stale')
    await ensureReadModelSchema(tdb.pool)
    expect(await live(A)).toEqual({ retirements: EMPTY_DIGEST, folds: EMPTY_DIGEST })
    await row(A, 'after')
    await expectKept(A)
    expect((await stored(A))!.retirements_digest).not.toBe(EMPTY_DIGEST)
  })

  it('X13: every protocol function this version installs is TAGGED with its version; a boot never DOWNGRADES a body tagged with a higher version, and replaces a same-version body that differs', async () => {
    const SIGNATURES = ['read_model_adopt_protocol_digests(text,text)', 'read_model_adopt_protocol_restamp(text,text)',
      'read_model_adopt_protocol_touched(text,text,text,text)', 'read_model_adopt_protocol_refresh()']
    const tagOf = async (signature: string) => (await tdb.pool.query<{ c: string | null }>(
      `SELECT obj_description(to_regprocedure(current_schema() || '.' || $1), 'pg_proc') AS c`, [signature])).rows[0]!.c
    for (const signature of SIGNATURES) expect(await tagOf(signature), signature).toBe('maplespire-protocol=2')
    const STALE = `CREATE OR REPLACE FUNCTION read_model_adopt_protocol_digests(p_landscape TEXT, p_version TEXT, OUT retirements TEXT, OUT folds TEXT)
      LANGUAGE sql STABLE AS $$ SELECT 'v3-body'::text, 'v3-body'::text $$`
    const restore = quiet()
    try {
      // A later version's body (tagged 3): this version's boot keeps it, twice over.
      await tdb.pool.query(STALE)
      await tdb.pool.query(`COMMENT ON FUNCTION read_model_adopt_protocol_digests(text,text) IS 'maplespire-protocol=3'`)
      await ensureReadModelSchema(tdb.pool)
      await ensureReadModelSchema(tdb.pool)
      expect((await live(A)).retirements, 'a v3 body is not downgraded').toBe('v3-body')
      expect(await tagOf(SIGNATURES[0]!)).toBe('maplespire-protocol=3')
      // A higher version spelled with more digits is still higher (numeric, not text, order).
      await tdb.pool.query(`COMMENT ON FUNCTION read_model_adopt_protocol_digests(text,text) IS 'maplespire-protocol=10'`)
      await ensureReadModelSchema(tdb.pool)
      expect((await live(A)).retirements, 'a v10 body is not downgraded').toBe('v3-body')
      // The same version with a different body (another build of version 2): replaced.
      await tdb.pool.query(`COMMENT ON FUNCTION read_model_adopt_protocol_digests(text,text) IS 'maplespire-protocol=2'`)
      await ensureReadModelSchema(tdb.pool)
      expect(await live(A), 'a same-version, different body is replaced').toEqual({ retirements: EMPTY_DIGEST, folds: EMPTY_DIGEST })
      expect(await tagOf(SIGNATURES[0]!)).toBe('maplespire-protocol=2')
      // An older (1) or untagged body: replaced and tagged.
      for (const older of [`'maplespire-protocol=1'`, 'NULL']) {
        await tdb.pool.query(STALE)
        await tdb.pool.query(`COMMENT ON FUNCTION read_model_adopt_protocol_digests(text,text) IS ${older}`)
        await ensureReadModelSchema(tdb.pool)
        expect(await live(A), older).toEqual({ retirements: EMPTY_DIGEST, folds: EMPTY_DIGEST })
        expect(await tagOf(SIGNATURES[0]!), older).toBe('maplespire-protocol=2')
      }
    } finally {
      await tdb.pool.query(`COMMENT ON FUNCTION read_model_adopt_protocol_digests(text,text) IS 'maplespire-protocol=2'`)
      await ensureReadModelSchema(tdb.pool)
      restore()
    }
    await row(A, 'after-x13')
    await expectKept(A)
  })

  it('X14: the tag is read ANCHORED — a comment carrying two tags, or a tag inside other text, is UNTAGGED: the body is replaced and re-tagged, never frozen as a higher version', async () => {
    const tagOf = async () => (await tdb.pool.query<{ c: string | null }>(
      `SELECT obj_description(to_regprocedure(current_schema() || '.read_model_adopt_protocol_digests(text,text)'), 'pg_proc') AS c`)).rows[0]!.c
    const STALE = `CREATE OR REPLACE FUNCTION read_model_adopt_protocol_digests(p_landscape TEXT, p_version TEXT, OUT retirements TEXT, OUT folds TEXT)
      LANGUAGE sql STABLE AS $$ SELECT 'hand-tagged'::text, 'hand-tagged'::text $$`
    const restore = quiet()
    try {
      for (const comment of [
        'maplespire-protocol=3 maplespire-protocol=2', 'maplespire-protocol=2,maplespire-protocol=3',
        'note: maplespire-protocol=3', 'maplespire-protocol=3 (hand-written)', ' maplespire-protocol=3',
        'maplespire-protocol=3x', 'maplespire-protocol=',
      ]) {
        await tdb.pool.query(STALE)
        // No parameter in a utility statement: the literal is built by the server.
        const { rows } = await tdb.pool.query<{ sql: string }>(
          `SELECT format('COMMENT ON FUNCTION read_model_adopt_protocol_digests(text,text) IS %L', $1::text) AS sql`, [comment])
        await tdb.pool.query(rows[0]!.sql)
        expect(await tagOf(), 'the comment as written').toBe(comment)
        await ensureReadModelSchema(tdb.pool)
        expect(await live(A), `${JSON.stringify(comment)} is untagged: replaced`).toEqual({ retirements: EMPTY_DIGEST, folds: EMPTY_DIGEST })
        expect(await tagOf(), JSON.stringify(comment)).toBe('maplespire-protocol=2')
      }
      // Control: the exact tag of a higher version is still kept.
      await tdb.pool.query(STALE)
      await tdb.pool.query(`COMMENT ON FUNCTION read_model_adopt_protocol_digests(text,text) IS 'maplespire-protocol=3'`)
      await ensureReadModelSchema(tdb.pool)
      expect((await live(A)).retirements, 'an exact higher tag is kept').toBe('hand-tagged')
    } finally {
      await tdb.pool.query(`COMMENT ON FUNCTION read_model_adopt_protocol_digests(text,text) IS 'maplespire-protocol=2'`)
      await ensureReadModelSchema(tdb.pool)
      restore()
    }
    expect(await live(A)).toEqual({ retirements: EMPTY_DIGEST, folds: EMPTY_DIGEST })
  })

  it('X11: dropReadModelSchema takes the triggers with the tables they read — a protocol write between the drop and the next ensure succeeds — and the ensure brings them back', async () => {
    await dropReadModelSchema(tdb.pool)
    try {
      // The protocol tables stay (durable state); a write must not fail 42P01 on a dropped table.
      await tdb.pool.query(`INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id)
        VALUES ($1, 'v1', 'object', 'between')`, [A.landscapeId])
      expect(await triggers()).toBe(0)
    } finally {
      await ensureReadModelSchema(tdb.pool)
    }
    expect(await triggers()).toBe(8)
    await withAdoptRow(A)
    await row(A, 'after-ensure')
    await expectKept(A)
    // And the lock-order check is back with them.
    await expect(tdb.pool.query(`INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id)
      VALUES ($1, 'v1', 'object', 'unfenced')`, [A.landscapeId])).rejects.toThrow(/read-model lock order/)
  })

  /** A's adopt row bound and its fence row projected once: what a shadow
   * verify needs to get past its precheck and S1 (the fixture has no seal,
   * so it stops at S4 with both rows held). */
  async function adoptableToS4(key: WorkspaceKey): Promise<void> {
    await tdb.pool.query(`UPDATE read_model_projection_state SET last_projected_at = now() WHERE landscape_id = $1 AND version_id = $2`,
      [key.landscapeId, key.versionId])
    const client = await tdb.pool.connect()
    try {
      await client.query('BEGIN')
      await assertReadModelWriteFence(client, key, FENCE)
      expect(await bindAdoptFence(client, key, FENCE)).toBe(true)
      await client.query('COMMIT')
    } finally { client.release() }
  }
  const shadowInput = (afterStep?: AdoptVerifyInput['afterStep']): AdoptVerifyInput => ({
    orgId: null, fenceObserved: FENCE, sealedCeiling: 4,
    posture: { rotation: true, fold: true, parking: true, extractCache: false }, afterStep,
  })

  it('LOCK ORDER 5 (G4-16f C6-1): the shadow verify takes the fence row FIRST — at S1 the fence row is held and the adopt row free, from S2 both are held (with the projection mutex), and nothing is held after its rollback', async () => {
    await adoptableToS4(A)
    // A second connection asks for each row FOR UPDATE NOWAIT: 55P03 means
    // the verify holds it. (An uncontended row lock lives in the tuple, not
    // in pg_locks; pg_locks shows the verify's advisory mutex.)
    const probe = async (table: string): Promise<'held' | 'free'> => {
      const c = await tdb.pool.connect()
      try {
        await c.query('BEGIN')
        await c.query(`SELECT 1 FROM ${table} WHERE landscape_id = $1 AND version_id = $2 FOR UPDATE NOWAIT`, [A.landscapeId, A.versionId])
        return 'free'
      } catch (error) {
        if ((error as { code?: string }).code === '55P03') return 'held'
        throw error
      } finally {
        await c.query('ROLLBACK').catch(() => {})
        c.release()
      }
    }
    /** Advisory locks pg_locks shows granted to the verify's own backend. */
    const advisoryHeldBy = async (pid: number) => (await tdb.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = $1`, [pid])).rows[0]!.n
    const seen: Record<string, { fence: string; adopt: string; mutex: number }> = {}
    const verdict = await verifyAdoptShadow(tdb.pool, A, shadowInput(async (stage, tx) => {
      const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      seen[stage] = { fence: await probe('read_model_projection_state'), adopt: await probe('read_model_adopt_state'), mutex: await advisoryHeldBy(pid) }
    }))
    expect(seen.S1).toMatchObject({ fence: 'held', adopt: 'free' })
    expect(seen.S1!.mutex).toBeGreaterThanOrEqual(1)
    expect(seen.S2).toMatchObject({ fence: 'held', adopt: 'held' })
    expect(seen.S3).toMatchObject({ fence: 'held', adopt: 'held' })
    expect(verdict).toMatchObject({ verdict: 'refused', reason: 'digest-stale-object', stage: 'S4' })
    expect({ fence: await probe('read_model_projection_state'), adopt: await probe('read_model_adopt_state') })
      .toEqual({ fence: 'free', adopt: 'free' })
  })

  it('LOCK ORDER 5b (G4-16f C6-2a): the CLAIM (adopt on) takes the same order — at S1 the fence row held and the adopt row free, from S2 both — and holds nothing after a refusal', async () => {
    await adoptableToS4(A)
    const probe = async (table: string): Promise<'held' | 'free'> => {
      const c = await tdb.pool.connect()
      try {
        await c.query('BEGIN')
        await c.query(`SELECT 1 FROM ${table} WHERE landscape_id = $1 AND version_id = $2 FOR UPDATE NOWAIT`, [A.landscapeId, A.versionId])
        return 'free'
      } catch (error) {
        if ((error as { code?: string }).code === '55P03') return 'held'
        throw error
      } finally {
        await c.query('ROLLBACK').catch(() => {})
        c.release()
      }
    }
    const seen: Record<string, { fence: string; adopt: string }> = {}
    const verdict = await claimAdopt(tdb.pool, A, {
      ...shadowInput(async (stage) => { seen[stage] = { fence: await probe('read_model_projection_state'), adopt: await probe('read_model_adopt_state') } }),
      instanceId: 'claimer', stillClaiming: () => true,
    })
    expect(seen.S1).toEqual({ fence: 'held', adopt: 'free' })
    expect(seen.S2).toEqual({ fence: 'held', adopt: 'held' })
    expect(verdict).toMatchObject({ mode: 'on', verdict: 'refused', reason: 'digest-stale-object', stage: 'S4' })
    expect({ fence: await probe('read_model_projection_state'), adopt: await probe('read_model_adopt_state') }).toEqual({ fence: 'free', adopt: 'free' })
    // Nothing claimed on a refusal.
    expect((await readAdoptPlane(tdb.pool, A))?.writeFence).toBe(FENCE)
  })

  it('X12: eight production writers of ONE workspace, concurrently, in their production order — no deadlock (40P01), no lock timeout (55P03), digests equal to the tables; a ninth that skips the fence is refused at once, never deadlocked', async () => {
    // 25 iterations by default; a soak raises them, or the jitter (0 = every
    // writer released at once), through the environment.
    const ITERATIONS = envNumber('G416F_X12_ITERATIONS', { fallback: 25, minimum: 1, maximum: 100_000, integer: true })
    const JITTER_MS = envNumber('G416F_X12_JITTER_MS', { fallback: 6, minimum: 0, maximum: 1_000 })
    // G4-16f C6-1: the shadow verify joins them (fence row, then adopt row,
    // under the mutex), so A must get past its precheck.
    await adoptableToS4(A)
    const shadowStages: string[] = []
    const claimStages: string[] = []
    const errors: Array<{ op: string; code?: string; message: string }> = []
    const strayRefusals: string[] = []
    const record = (op: string) => (error: unknown) => {
      const e = error as { code?: string; message?: string; name?: string }
      if (e?.name === 'OrdinaryChainFoldConflictError') return // a fold that lost its CAS: a benign loser
      errors.push({ op, code: e?.code, message: String(e?.message ?? error).slice(0, 200) })
    }
    const jitter = () => new Promise((r) => setTimeout(r, Math.random() * JITTER_MS))
    /** A fold/rotator-shaped transaction on its own client: plane, fence, then its rows. */
    const ownClient = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
      const client = await tdb.pool.connect()
      try {
        await client.query(`BEGIN; SET LOCAL lock_timeout = '8000ms'`)
        await assertReadModelPlane(client, A, 'ordinary')
        await assertReadModelWriteFence(client, A, FENCE)
        const out = await fn(client)
        await client.query('COMMIT')
        return out
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    }
    const projection = (fn: (tx: Queryable) => Promise<unknown>) => withReadModelProjectionTransaction(tdb.pool, A, 'ordinary', fn)
    for (let i = 0; i < ITERATIONS; i += 1) {
      const [a, b, prod, head] = [`s${i}a`, `s${i}b`, `p${i}`, `h${i}`]
      await ownClient(async (c) => {
        for (const id of [a, b, head]) await commitOrdinaryHeadRetirement(c, A, 'object', id, [`${id}-h`])
      })
      await Promise.all([
        // A metadata pass: the adopt savepoint, the fence at its end.
        (async () => { await jitter(); await projection(async (tx) => {
          await withAdoptSavepoint(tx, A, () => updateAdoptTopology(tx, A, fixtureTopology(`t${i}`)))
          await assertReadModelWriteFence(tx, A, FENCE)
        }) })().catch(record('pass')),
        // The deferred adopt stamp: the fence, then the adopt savepoint.
        (async () => { await jitter(); await projection(async (tx) => {
          await assertReadModelWriteFence(tx, A, FENCE)
          await withAdoptSavepoint(tx, A, () => refuseAdoptWatermarks(tx, A, [a]))
        }) })().catch(record('stamp')),
        // The projector's late-write commit(): the fence, then the forward.
        (async () => { await jitter(); await projection(async (tx) => {
          await assertReadModelWriteFence(tx, A, FENCE)
          const current = await readOrdinaryHeadRetirement(tx, A, 'object', head)
          await commitForwardedHeads(tx, A, 'object', head, current?.forwardedHeads ?? null, [`${head}-h`, `late${i}`])
        }) })().catch(record('forward')),
        // A folded-arrival advance (commitFoldedArrival's shape).
        (async () => { await jitter(); await projection(async (tx) => {
          await assertReadModelWriteFence(tx, A, FENCE)
          await advanceFoldedArrivalWatermarks(tx, A, 'object', [{ documentId: a, arrivalSeq: String(i + 1) }])
        }) })().catch(record('arrival')),
        // The fold writer: record, then abandon and sweep.
        (async () => {
          await jitter()
          await ownClient((c) => recordOrdinaryChainFold(c, A, { collection: 'object', productDocumentId: prod, productHeads: [`${prod}-h`],
            currentDocumentId: 'cur', sources: [{ documentId: a, forwardedHeads: null }, { documentId: b, forwardedHeads: null }],
            retainUntil: new Date(Date.now() + 3_600_000) }))
          await jitter()
          await ownClient(async (c) => {
            await abandonOrdinaryChainFold(c, A, { collection: 'object', productDocumentId: prod })
            await sweepOrdinaryChainFoldRows(c, A, 'object')
          })
        })().catch(record('fold')),
        // The compaction settle, its own function and client.
        (async () => { await jitter(); const c = await tdb.pool.connect(); try {
          await settleCompactedOrdinarySegments(c, A, 'object', [{ documentId: `c${i}`, heads: [`c${i}-h`], current: true }], FENCE)
        } finally { c.release() } })().catch(record('settle')),
        // The rotator's retirement.
        (async () => { await jitter(); await ownClient((c) => commitOrdinaryHeadRetirement(c, A, 'object', `r${i}`, [`r${i}-h`])) })()
          .catch(record('rotate')),
        // A second pass, so two projector-shaped transactions contend too.
        (async () => { await jitter(); await projection(async (tx) => {
          await withAdoptSavepoint(tx, A, () => updateAdoptTopology(tx, A, fixtureTopology(`u${i}`)))
          await assertReadModelWriteFence(tx, A, FENCE)
        }) })().catch(record('pass2')),
        // C6b: a cold-build-shaped transaction in its production order — the
        // shard watermarks WITH their heads, the claim (FENCE -> FENCE, so
        // the other writers keep their fence), then ONE adopt savepoint
        // writing the row and binding it.
        (async () => { await jitter(); await projection(async (tx) => {
          await recordSampledDocumentWatermarks(tx, A, [
            { documentId: 'wm-a', sampledHeads: [`a${i}`], readCurrentHeads: () => [`a${i}`] },
            { documentId: 'wm-b', sampledHeads: [`b${i}`], readCurrentHeads: () => [`b${i}`] },
          ], { watermarkPost: String(i + 1), durableHeadsById: new Map([['wm-a', [`a${i}`]], ['wm-b', [`b${i}`]]]) })
          await claimReadModelWriteFence(tx, A, null, FENCE, FENCE)
          const kept = await withAdoptSavepoint(tx, A, async () => {
            await writeAdoptState(tx, A, fixtureAdoptState(`c${i}`))
            if (!(await bindAdoptFence(tx, A, FENCE))) throw new Error('no adopt row to bind')
          })
          if (!kept) throw new Error('the cold build\'s adopt savepoint rolled back')
          await assertReadModelWriteFence(tx, A, FENCE)
        }) })().catch(record('cold')),
        // C6b: a delta-shaped pass — one shard watermark with its heads, then
        // the topology lists in the adopt savepoint.
        (async () => { await jitter(); await projection(async (tx) => {
          await recordSampledDocumentWatermark(tx, A, 'wm-b', [`d${i}`], () => [`d${i}`],
            { watermarkPost: String(i + 1), durableHeadsById: new Map([['wm-b', [`d${i}`]]]) })
          await withAdoptSavepoint(tx, A, () => updateAdoptTopology(tx, A, fixtureTopology(`d${i}`)))
          await assertReadModelWriteFence(tx, A, FENCE)
        }) })().catch(record('delta')),
        // G4-16f C6-1: a shadow verify-and-adopt (rolled back). Its own
        // failures are verdicts, not throws: an `error` verdict (40P01,
        // 55P03, anything) is recorded as an error here.
        (async () => { await jitter(); const v = await verifyAdoptShadow(tdb.pool, A, shadowInput())
          shadowStages.push(v.stage)
          if (v.verdict === 'error') errors.push({ op: 'shadow', code: v.reason ?? undefined, message: String(v.detail) })
        })(),
        // G4-16f C6-2a (A8): the CLAIM (`claimAdopt`, adopt on) — the same
        // S1-S5 path, refused at S4 on this unsealed fixture, every lock of
        // the verify taken under contention; an `error` verdict is an error.
        (async () => { await jitter(); const v = await claimAdopt(tdb.pool, A, { ...shadowInput(), instanceId: FENCE, stillClaiming: () => true })
          claimStages.push(v.stage)
          if (v.verdict === 'error') errors.push({ op: 'claim', code: v.reason ?? undefined, message: String(v.detail) })
        })().catch(record('claim')),
        // ...and the claim's S6 in its production order, after the same
        // reads under the same locks (fence row FOR UPDATE, then the adopt
        // row): the CAS (FENCE -> FENCE, so the other writers keep their
        // fence), the fence assertion, the row marked not attached.
        (async () => { await jitter(); await projection(async (tx) => {
          await assertReadModelWriteFence(tx, A, FENCE)
          await tx.query('SELECT 1 FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2 FOR UPDATE', [A.landscapeId, A.versionId])
          await readAdoptPlaneForUpdate(tx, A)
          await adoptProtocolDigests(tx, A)
          await claimReadModelWriteFence(tx, A, null, FENCE, FENCE)
          await assertReadModelWriteFence(tx, A, FENCE)
          await markReadModelProjectorAdopting(tx, A, FENCE)
        }) })().catch(record('claim-s6')),
        // The attach's B5: the fence, the binding, the row attached — one
        // transaction on the projection tail's shape.
        (async () => { await jitter(); await projection(async (tx) => {
          await assertReadModelWriteFence(tx, A, FENCE)
          if (!(await bindAdoptFence(tx, A, FENCE))) throw new Error('B5: no adopt row to bind')
          await markReadModelProjectorAttached(tx, A, null, FENCE)
        }) })().catch(record('b5')),
        // A STRAY writer that never takes the fence (a future path, an operator's psql).
        (async () => { await jitter(); const c = await tdb.pool.connect(); try {
          await c.query(`BEGIN; SET LOCAL lock_timeout = '8000ms'`)
          await c.query('UPDATE read_model_ordinary_head_retirements SET updated_at = now() WHERE landscape_id = $1 AND document_id = ANY($2::text[])',
            [A.landscapeId, [a, head, b]])
          await c.query('COMMIT')
          errors.push({ op: 'stray', message: 'a write without the fence row was ADMITTED' })
        } catch (error) {
          await c.query('ROLLBACK').catch(() => {})
          const message = String((error as Error).message)
          if (/read-model lock order/.test(message)) strayRefusals.push(message)
          else record('stray')(error)
        } finally { c.release() } })(),
      ])
    }
    expect(errors, JSON.stringify(errors.slice(0, 3))).toEqual([])
    expect(strayRefusals).toHaveLength(ITERATIONS)
    // Witness: the shadow verifies ran each iteration, and reached S4 —
    // past both row locks — rather than refusing at the precheck.
    expect(shadowStages).toHaveLength(ITERATIONS)
    expect(shadowStages.filter((stage) => stage === 'S4').length, JSON.stringify(shadowStages)).toBeGreaterThan(0)
    // C6-2a: the claims ran each iteration and got past both row locks too.
    expect(claimStages).toHaveLength(ITERATIONS)
    expect(claimStages.filter((stage) => stage === 'S4').length, JSON.stringify(claimStages)).toBeGreaterThan(0)
    await expectKept(A)
    // Witness: the writers wrote (a run where every one failed early would also have no deadlock).
    expect((await tdb.pool.query(`SELECT count(*)::int AS n FROM read_model_ordinary_head_retirements
      WHERE landscape_id = $1 AND document_id LIKE 'r%'`, [A.landscapeId])).rows[0]!.n).toBe(ITERATIONS)
    expect((await stored(A))!.retirements_digest).not.toBe(EMPTY_DIGEST)
    // C6b witnesses: the cold-build-shaped writer bound the row (and the
    // passes after it left the binding alone), and the heads were written.
    const plane = await readAdoptPlane(tdb.pool, A)
    expect(plane?.fenceBinding).toBe(FENCE)
    expect(adoptRefusal(plane)).toBeNull()
    const heads = (await tdb.pool.query<{ id: string; heads: string[] | null }>(
      `SELECT document_id AS id, projected_heads AS heads FROM read_model_document_watermarks
        WHERE landscape_id = $1 AND document_id IN ('wm-a', 'wm-b') ORDER BY 1`, [A.landscapeId])).rows
    expect(heads.map((row) => row.id)).toEqual(['wm-a', 'wm-b'])
    expect(heads.every((row) => row.heads !== null && row.heads.length === 1)).toBe(true)
  }, 300_000)

  it('X15 (C6b): the v2 columns upgrade a schema of the pre-C6b shape — old rows read NULL (not adoptable) — and a second ensure is a no-op that issues no ALTER on either table', async () => {
    await tdb.pool.query('TRUNCATE read_model_document_watermarks')
    // Back to the pre-C6b shape: the v2 columns did not exist.
    await tdb.pool.query(`ALTER TABLE read_model_adopt_state
      DROP COLUMN adopt_version, DROP COLUMN fence_binding, DROP COLUMN root_document_id, DROP COLUMN meta_document_id,
      DROP COLUMN object_shard_ids, DROP COLUMN connection_shard_ids, DROP COLUMN registry_shard_ids,
      DROP COLUMN sealed_ceiling, DROP COLUMN posture`)
    await tdb.pool.query('ALTER TABLE read_model_document_watermarks DROP COLUMN projected_heads')
    await tdb.pool.query(`INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark)
      VALUES ($1, $2, 'old-doc', 9)`, [A.landscapeId, A.versionId])
    const columns = async () => (await tdb.pool.query<{ table: string; column: string; type: string }>(
      `SELECT table_name AS table, column_name AS column, data_type AS type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name IN ('read_model_adopt_state', 'read_model_document_watermarks')
        ORDER BY 1, 2`)).rows
    const alters: string[] = []
    const counting = new Proxy(tdb.pool, {
      get(target, prop) {
        if (prop === 'query') {
          return (...args: unknown[]) => {
            const text = typeof args[0] === 'string' ? args[0] : ''
            if (/ALTER TABLE read_model_(adopt_state|document_watermarks)\b/.test(text)) alters.push(text)
            return (target.query as (...a: unknown[]) => unknown)(...args)
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as IsolatedSchemaDb['pool']
    await ensureReadModelSchema(counting)
    expect(alters, 'the upgrade issues the two guarded ALTERs').toHaveLength(2)
    const upgraded = await columns()
    expect(upgraded.filter((c) => c.table === 'read_model_adopt_state').map((c) => [c.column, c.type])).toEqual(expect.arrayContaining([
      ['adopt_version', 'integer'], ['fence_binding', 'text'], ['root_document_id', 'text'], ['meta_document_id', 'text'],
      ['object_shard_ids', 'ARRAY'], ['connection_shard_ids', 'ARRAY'], ['registry_shard_ids', 'ARRAY'],
      ['sealed_ceiling', 'integer'], ['posture', 'text'],
    ]))
    expect(upgraded).toContainEqual({ table: 'read_model_document_watermarks', column: 'projected_heads', type: 'ARRAY' })
    // The rows the old shape held: kept, NULL in every new column, not adoptable.
    const plane = await readAdoptPlane(tdb.pool, A)
    expect(plane).toMatchObject({ adoptVersion: null, fenceBinding: null, objectShardIds: null, posture: null })
    expect(adoptRefusal(plane)).toBe('adopt-version')
    expect((await tdb.pool.query(`SELECT projected_watermark::text AS w, projected_heads AS h FROM read_model_document_watermarks
      WHERE document_id = 'old-doc'`)).rows).toEqual([{ w: '9', h: null }])
    // Run twice: nothing changes and nothing is altered.
    alters.length = 0
    await ensureReadModelSchema(counting)
    expect(alters).toEqual([])
    expect(await columns()).toEqual(upgraded)
  }, 60_000)
})

suite('G4-16f — the fence mark the lock-order check reads: tokens, savepoints, pooled sessions, statement kinds (PostgreSQL)', () => {
  let mdb: IsolatedSchemaDb
  /** max 1: every transaction runs on the SAME physical client. */
  let solo: pg.Pool
  const REFUSED = /read-model lock order/
  const key = (landscapeId: string, versionId = 'v1'): WorkspaceKey => ({ landscapeId, versionId })
  const state = (k: WorkspaceKey) => mdb.pool.query(
    'INSERT INTO read_model_projection_state (landscape_id, version_id, write_fence) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [k.landscapeId, k.versionId, FENCE])
  const insertRow = (q: { query: pg.Pool['query'] }, k: WorkspaceKey, id = 'x') => q.query(
    `INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id) VALUES ($1, $2, 'object', $3)`,
    [k.landscapeId, k.versionId, id])
  async function tx<T>(pool: pg.Pool, run: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { client.release() }
  }
  const setting = async (q: { query: pg.Pool['query'] }) =>
    (await q.query<{ v: string | null }>(`SELECT current_setting('maplespire.read_model_fence_rows', true) AS v`)).rows[0]!.v

  beforeAll(async () => {
    mdb = await createIsolatedSchemaDb(connection!, 'adopt_fence_mark')
    await ensureReadModelSchema(mdb.pool)
    solo = guardIdleClientErrors(new pg.Pool({ connectionString: connection!, max: 1, options: `-c search_path=${mdb.schema}` }), 'fence-mark:solo')
  })
  afterAll(async () => { await solo?.end(); await mdb?.teardown() })
  beforeEach(async () => {
    await mdb.pool.query('TRUNCATE read_model_ordinary_head_retirements, read_model_ordinary_chain_folds, read_model_adopt_state, read_model_projection_state')
  })

  it('MARK 1: tokens never collide — concatenation-ambiguous, prefix, comma, percent, underscore and wildcard-looking ids are each refused under another workspace\'s fence', async () => {
    const holder = key('a', 'bc')
    const victims = [key('ab', 'c'), key('a', 'b'), key('a1', 'bc'), key('a', 'bc0'), key('a,bc', ''), key('a', ',bc'),
      key('*', 'x'), key('%', '%'), key('_', '_'), key('ws1', 'v'), key('ws10', 'v'), key('ws1', 'v0')]
    for (const k of [holder, ...victims]) await state(k)
    for (const victim of victims) {
      await expect(tx(mdb.pool, async (c) => {
        await assertReadModelWriteFence(c, holder, FENCE)
        await insertRow(c, victim)
      }), JSON.stringify(victim)).rejects.toThrow(REFUSED)
    }
    // ws1 holds; ws10 is not admitted by a prefix match of the list.
    await expect(tx(mdb.pool, async (c) => {
      await assertReadModelWriteFence(c, key('ws1', 'v'), FENCE)
      await insertRow(c, key('ws10', 'v'))
    })).rejects.toThrow(REFUSED)
    // Control: the holder itself is admitted.
    await tx(mdb.pool, async (c) => { await assertReadModelWriteFence(c, holder, FENCE); await insertRow(c, holder) })
  })

  it('MARK 2: one transaction fencing TWO workspaces may write to both (the list appends, never replaces), and fencing one again is idempotent', async () => {
    const [a, b] = [key('two-a'), key('two-b')]
    await state(a)
    await state(b)
    await tx(mdb.pool, async (c) => {
      await assertReadModelWriteFence(c, a, FENCE)
      await assertReadModelWriteFence(c, b, FENCE)
      await insertRow(c, a)
      await insertRow(c, b)
      await assertReadModelWriteFence(c, a, FENCE)
      await insertRow(c, a, 'y')
      await insertRow(c, b, 'y')
      expect((await setting(c))!.split(',').filter(Boolean)).toHaveLength(2)
    })
  })

  it('MARK 3: the no-row exemption is per workspace — another VERSION of a landscape with a row, or any workspace of a non-empty table, is not checked; the one with the row is', async () => {
    await state(key('has', 'v1'))
    await tx(mdb.pool, (c) => insertRow(c, key('has', 'v2')))
    await tx(mdb.pool, (c) => insertRow(c, key('nobody', 'v1')))
    await expect(tx(mdb.pool, (c) => insertRow(c, key('has', 'v1')))).rejects.toThrow(REFUSED)
  })

  it('MARK 4: a fence row INSERTED by the writing transaction is checked (refused); one DELETED by it before the write is exempt (admitted, by design: adoptState.ts)', async () => {
    const k = key('abuse')
    await expect(tx(mdb.pool, async (c) => {
      await c.query(`INSERT INTO read_model_projection_state (landscape_id, version_id, write_fence) VALUES ($1, $2, 'f')`, [k.landscapeId, k.versionId])
      await insertRow(c, k)
    })).rejects.toThrow(REFUSED)
    await state(k)
    await tx(mdb.pool, async (c) => {
      await c.query('DELETE FROM read_model_projection_state WHERE landscape_id = $1', [k.landscapeId])
      await insertRow(c, k)
    })
    expect((await mdb.pool.query('SELECT 1 FROM read_model_ordinary_head_retirements WHERE landscape_id = $1', [k.landscapeId])).rowCount).toBe(1)
  })

  it('MARK 5: savepoints — a fence taken under a rolled-back savepoint does not admit, one under a released savepoint does, an inner rollback keeps the outer fence', async () => {
    const [a, b] = [key('sp-a'), key('sp-b')]
    await state(a)
    await state(b)
    await expect(tx(mdb.pool, async (c) => {
      await assertReadModelWriteFence(c, a, FENCE)
      await c.query('SAVEPOINT s1')
      await assertReadModelWriteFence(c, b, FENCE)
      await c.query('ROLLBACK TO SAVEPOINT s1')
      await insertRow(c, a) // still admitted
      await insertRow(c, b) // refused: b's entry went with the savepoint
    })).rejects.toThrow(/read-model lock order: INSERT on read_model_ordinary_head_retirements of sp-b/)
    await tx(mdb.pool, async (c) => {
      await c.query('SAVEPOINT s1')
      await assertReadModelWriteFence(c, a, FENCE)
      await c.query('RELEASE SAVEPOINT s1')
      await insertRow(c, a)
    })
    await tx(mdb.pool, async (c) => {
      await c.query('SAVEPOINT o')
      await assertReadModelWriteFence(c, a, FENCE)
      await c.query('SAVEPOINT i')
      await assertReadModelWriteFence(c, b, FENCE)
      await c.query('ROLLBACK TO SAVEPOINT i')
      await insertRow(c, a, 'nested')
      await c.query('RELEASE SAVEPOINT o')
    })
  })

  it('MARK 6: the next transaction on the SAME pooled backend never inherits a fence — after a commit, a rollback, an error, an autocommit assertion, the projection helper, or a fixture\'s wildcard', async () => {
    const k = key('pool')
    await state(k)
    const pidOf = async (c: pg.PoolClient) => (await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p
    let pid = 0
    await tx(solo, async (c) => {
      pid = await pidOf(c)
      await assertReadModelWriteFence(c, k, FENCE)
      await insertRow(c, k, 'ok')
      expect(await setting(c)).toMatch(/^,\d+:[0-9a-f]{32}$/)
    })
    const after = await solo.connect()
    try {
      expect(await pidOf(after), 'the pool really reused the backend').toBe(pid)
      expect(await setting(after)).toBe('')
      await after.query('BEGIN')
      await expect(insertRow(after, k, 'inherit')).rejects.toThrow(REFUSED)
      await after.query('ROLLBACK')
      await after.query('BEGIN')
      await assertReadModelWriteFence(after, k, FENCE)
      await after.query('ROLLBACK')
      expect(await setting(after)).toBe('')
      await after.query('BEGIN')
      await expect(insertRow(after, k, 'inherit2')).rejects.toThrow(REFUSED)
      await after.query('ROLLBACK')
      await after.query('BEGIN')
      await assertReadModelWriteFence(after, k, FENCE)
      await after.query('SELECT 1/0').catch(() => {})
      await after.query('ROLLBACK')
      await after.query('BEGIN')
      await expect(insertRow(after, k, 'inherit3')).rejects.toThrow(REFUSED)
      await after.query('ROLLBACK')
      // Autocommit: the assertion alone (its own implicit transaction) leaves nothing.
      await assertReadModelWriteFence(after, k, FENCE)
      await expect(insertRow(after, k, 'inherit4')).rejects.toThrow(REFUSED)
    } finally { after.release() }
    await withReadModelProjectionTransaction(solo, k, 'ordinary', async (t) => {
      await assertReadModelWriteFence(t, k, FENCE)
      await insertRow(t, k, 'helper')
    })
    await expect(withReadModelProjectionTransaction(solo, k, 'ordinary', (t) => insertRow(t, k, 'helper2'))).rejects.toThrow(REFUSED)
    await expect(tx(solo, (c) => commitOrdinaryHeadRetirement(c, k, 'object', 'prod', ['h']))).rejects.toThrow(REFUSED)
    await tx(solo, async (c) => { await c.query(PROTOCOL_FIXTURE_MARK); await insertRow(c, k, 'fx') })
    await expect(tx(solo, (c) => insertRow(c, k, 'after-fx'))).rejects.toThrow(REFUSED)
  })

  it('MARK 7: every statement kind that writes a protocol table unfenced is refused — the folds table\'s UPDATE and DELETE, MERGE, INSERT … ON CONFLICT DO UPDATE, and a writing CTE', async () => {
    const k = key('kinds')
    await state(k)
    await tx(mdb.pool, async (c) => {
      await assertReadModelWriteFence(c, k, FENCE)
      await c.query(`INSERT INTO read_model_ordinary_chain_folds (landscape_id, version_id, collection, product_document_id, source_document_ids)
        VALUES ($1, $2, 'object', 'p', ARRAY['s'])`, [k.landscapeId, k.versionId])
      await insertRow(c, k, 'up')
    })
    for (const sql of [
      `UPDATE read_model_ordinary_chain_folds SET created_at = now() WHERE landscape_id = $1`,
      `DELETE FROM read_model_ordinary_chain_folds WHERE landscape_id = $1`,
      `MERGE INTO read_model_ordinary_head_retirements t USING (SELECT $1::text AS l, 'v1'::text AS v, 'mx'::text AS d) s
         ON t.landscape_id = s.l AND t.version_id = s.v AND t.collection = 'object' AND t.document_id = s.d
         WHEN NOT MATCHED THEN INSERT (landscape_id, version_id, collection, document_id) VALUES (s.l, s.v, 'object', s.d)`,
      `INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id)
         VALUES ($1, 'v1', 'object', 'up') ON CONFLICT (landscape_id, version_id, collection, document_id) DO UPDATE SET updated_at = now()`,
      `WITH x AS (INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id)
         VALUES ($1, 'v1', 'object', 'cte') RETURNING 1) SELECT * FROM x`,
    ]) await expect(tx(mdb.pool, (c) => c.query(sql, [k.landscapeId])), sql).rejects.toThrow(REFUSED)
  })

  it('MARK 8: a TRUNCATE of a protocol table is admitted unfenced (by design: tests only; adoptState.ts) and re-stamps', async () => {
    const k = key('trunc')
    await state(k)
    await tx(mdb.pool, async (c) => { await assertReadModelWriteFence(c, k, FENCE); await insertRow(c, k) })
    await tx(mdb.pool, (c) => c.query('TRUNCATE read_model_ordinary_head_retirements'))
    expect((await mdb.pool.query('SELECT count(*)::int AS n FROM read_model_ordinary_head_retirements')).rows[0]!.n).toBe(0)
  })

  it('MARK 9: the fold record on a transaction that never fenced is refused', async () => {
    const k = key('rec')
    await state(k)
    await tx(mdb.pool, async (c) => {
      await assertReadModelWriteFence(c, k, FENCE)
      await commitOrdinaryHeadRetirement(c, k, 'object', 's1', ['h1'])
      await commitOrdinaryHeadRetirement(c, k, 'object', 's2', ['h2'])
    })
    await expect(tx(mdb.pool, (c) => recordOrdinaryChainFold(c, k, {
      collection: 'object', productDocumentId: 'p', productHeads: ['h'], currentDocumentId: 'cur',
      sources: [{ documentId: 's1', forwardedHeads: null }, { documentId: 's2', forwardedHeads: null }],
      retainUntil: new Date(Date.now() + 3_600_000),
    }))).rejects.toThrow(REFUSED)
  })

  it('VERSION: the marker is a protocol VERSION — a higher one (3, 02) is judged by version 2\'s lock order; a non-number (x, \' 2\', 10 digits), empty, or a lower one (1) is a non-participant', async () => {
    const k = key('versions')
    await state(k)
    const unfencedWith = (marker: string) => tx(mdb.pool, async (c) => {
      // Transaction-local, so the pooled connection keeps its own marker.
      await c.query(`SELECT set_config('maplespire.read_model_protocol', $1, true)`, [marker])
      await insertRow(c, k, `m-${marker.trim() || 'empty'}-${randomBytes(3).toString('hex')}`)
    })
    for (const marker of ['3', '02', '2', '999999999']) await expect(unfencedWith(marker), marker).rejects.toThrow(REFUSED)
    for (const marker of ['x', ' 2', '2.0', '1', '0', '', '9999999999']) await expect(unfencedWith(marker), JSON.stringify(marker)).resolves.toBeUndefined()
    // Control: the pooled connection is back on its own marker afterwards.
    await expect(tx(mdb.pool, (c) => insertRow(c, k, 'after'))).rejects.toThrow(REFUSED)
  })

  it('LOST MARKER: a writer of this version on a connection whose session reset dropped the marker (RESET ALL, DISCARD ALL, SET to \'\', or a lower or non-numeric version) is REFUSED by the fence assertion, by name — not silently unenforced', async () => {
    const k = key('lost')
    await state(k)
    const participant = async (c: pg.PoolClient) =>
      (await c.query<{ v: string | null }>(`SELECT current_setting('maplespire.read_model_protocol', true) AS v`)).rows[0]!.v
    for (const reset of ['RESET ALL', 'DISCARD ALL', `SET maplespire.read_model_protocol = ''`,
      `SET maplespire.read_model_protocol = '1'`, `SET maplespire.read_model_protocol = 'x'`]) {
      // A pool of its own: the reset poisons its one physical connection for good.
      const pool = guardIdleClientErrors(new pg.Pool({ connectionString: connection!, max: 1, options: `-c search_path=${mdb.schema}` }), 'lost-marker')
      try {
        const c = await pool.connect()
        try {
          expect(await participant(c), 'marked at connect').toBe('2')
          await c.query(reset)
          expect(await participant(c), `${reset} dropped or lowered it`).not.toBe('2')
          // The trigger no longer enforces on this connection: the hole the assertion closes.
          await c.query('BEGIN')
          await insertRow(c, k, `hole-${randomBytes(3).toString('hex')}`)
          await c.query('ROLLBACK')
          // This version's writer: refused by name at its fence assertion, before any write.
          await c.query('BEGIN')
          const refused = await assertReadModelWriteFence(c, k, FENCE).then(() => null, (error: unknown) => error)
          expect(refused, reset).toBeInstanceOf(ReadModelProtocolMarkerError)
          expect((refused as ReadModelProtocolMarkerError).code).toBe('protocol_marker_missing')
          expect(String((refused as Error).message)).toMatch(/protocol marker.*direct or session-mode connection/)
          expect(refused, 'never a fence loss (which is handled as a benign rollback)').not.toBeInstanceOf(ReadModelWriteFenceError)
          await c.query('ROLLBACK')
        } finally {
          await c.query('ROLLBACK').catch(() => {})
          c.release()
        }
        // The projection helper and a production writer, on the same (still
        // reset) physical connection: the same refusal, and nothing written.
        await expect(withReadModelProjectionTransaction(pool, k, 'ordinary', async (t) => {
          await assertReadModelWriteFence(t, k, FENCE)
          await commitOrdinaryHeadRetirement(t, k, 'object', 'lost', ['h'])
        })).rejects.toBeInstanceOf(ReadModelProtocolMarkerError)
        expect((await mdb.pool.query(`SELECT count(*)::int AS n FROM read_model_ordinary_head_retirements
          WHERE landscape_id = $1 AND document_id = 'lost'`, [k.landscapeId])).rows[0]!.n).toBe(0)
      } finally {
        await pool.end()
      }
    }
    // Control: a guarded pool's fresh connection asserts, and writes, as ever.
    await tx(mdb.pool, async (c) => {
      await assertReadModelWriteFence(c, k, FENCE)
      await insertRow(c, k, 'control')
    })
  })

  it('LOST MARKER, FENCE LOST: the fence verdict comes FIRST — an instance whose fence another took is told so (an authority loss), even on a connection that also lost its marker; a missing row likewise', async () => {
    const k = key('lost-both')
    await state(k)
    await mdb.pool.query(`UPDATE read_model_projection_state SET write_fence = 'the-new-owner' WHERE landscape_id = $1`, [k.landscapeId])
    const gone = key('lost-norow')
    const pool = guardIdleClientErrors(new pg.Pool({ connectionString: connection!, max: 1, options: `-c search_path=${mdb.schema}` }), 'lost-both')
    try {
      for (const reset of ['DISCARD ALL', 'RESET ALL', `SET maplespire.read_model_protocol = ''`]) {
        for (const [target, held] of [[k, 'the-new-owner'], [gone, undefined]] as const) {
          const c = await pool.connect()
          let refused: unknown
          try {
            await c.query(reset)
            await c.query('BEGIN')
            refused = await assertReadModelWriteFence(c, target, FENCE).then(() => null, (error: unknown) => error)
            await c.query('ROLLBACK')
          } finally {
            // This test reset the session itself: never hand it back.
            c.release(true)
          }
          expect(refused, `${reset}, ${target.landscapeId}`).toBeInstanceOf(ReadModelWriteFenceError)
          expect(refused, 'not reported as a marker fault').not.toBeInstanceOf(ReadModelProtocolMarkerError)
          expect(isReadModelAuthorityLoss(refused), 'handled as an authority loss: no failure telemetry on the new owner\'s row').toBe(true)
          expect((refused as ReadModelWriteFenceError).message).toContain(held ?? 'nobody')
        }
      }
      // Control: the fence ours again, the same lost marker is the marker fault.
      await mdb.pool.query(`UPDATE read_model_projection_state SET write_fence = $2 WHERE landscape_id = $1`, [k.landscapeId, FENCE])
      const c = await pool.connect()
      try {
        await c.query('DISCARD ALL')
        await c.query('BEGIN')
        await expect(assertReadModelWriteFence(c, k, FENCE)).rejects.toBeInstanceOf(ReadModelProtocolMarkerError)
        await c.query('ROLLBACK')
      } finally { c.release(true) }
    } finally {
      await pool.end()
    }
  })

  it('A LOST MARKER ENDS THE CONNECTION: the refused connection is destroyed, not returned — on a pool of one, the next writer gets a NEW backend and writes (the projection transaction, and every overlay-rotation key holder through releaseOverlayRotationLock)', async () => {
    const k = key('lost-destroy')
    await state(k)
    const pidOf = async (q: { query: pg.Pool['query'] }) =>
      (await q.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    const rowsOf = async (documentId: string) => (await mdb.pool.query<{ n: number }>(`SELECT count(*)::int AS n
      FROM read_model_ordinary_head_retirements WHERE landscape_id = $1 AND document_id = $2`, [k.landscapeId, documentId])).rows[0]!.n
    const pool = guardIdleClientErrors(new pg.Pool({ connectionString: connection!, max: 1, options: `-c search_path=${mdb.schema}` }), 'lost-destroy')
    try {
      // 1. withReadModelProjectionTransaction. A session reset by something
      //    else (a middleware) on a guarded client, handed back CLEAN.
      const c = await pool.connect()
      const poisoned = await pidOf(c)
      await c.query('DISCARD ALL')
      c.release()
      let refusedOn: number | null = null
      await expect(withReadModelProjectionTransaction(pool, k, 'ordinary', async (t) => {
        refusedOn = await pidOf(t)
        await assertReadModelWriteFence(t, k, FENCE)
        await commitOrdinaryHeadRetirement(t, k, 'object', 'refused', ['h'])
      })).rejects.toBeInstanceOf(ReadModelProtocolMarkerError)
      expect(refusedOn, 'the writer drew the reset connection (a pool of one)').toBe(poisoned)
      let wroteOn: number | null = null
      await withReadModelProjectionTransaction(pool, k, 'ordinary', async (t) => {
        wroteOn = await pidOf(t)
        await assertReadModelWriteFence(t, k, FENCE)
        await commitOrdinaryHeadRetirement(t, k, 'object', 'written', ['h'])
      })
      expect(wroteOn, 'the refused connection was destroyed: a new backend').not.toBe(poisoned)
      expect(await rowsOf('refused')).toBe(0)
      expect(await rowsOf('written')).toBe(1)

      // 2. An overlay-rotation key holder (here the compaction settle, on the
      //    key's own client; the rotator and the fold writer hand back through
      //    the same releaseOverlayRotationLock). RESET ALL, which keeps the key.
      const lockKey = overlayRotationLockKey(k.landscapeId, k.versionId, 'object')
      const holder = await pool.connect()
      const held = await pidOf(holder)
      let lock: Awaited<ReturnType<typeof acquireOverlayRotationLock>> = 'unknown'
      try {
        lock = await acquireOverlayRotationLock(holder, lockKey)
        expect(lock).toBe('acquired')
        await holder.query('RESET ALL')
        await expect(settleCompactedOrdinarySegments(holder, k, 'object',
          [{ documentId: 'settle-refused', heads: ['h'], current: true }], FENCE)).rejects.toBeInstanceOf(ReadModelProtocolMarkerError)
      } finally {
        await releaseOverlayRotationLock(holder, lockKey, lock)
      }
      const next = await pool.connect()
      try {
        expect(await pidOf(next), 'the key holder\'s refused connection was destroyed').not.toBe(held)
        // Ending the session returned the key.
        expect(await acquireOverlayRotationLock(next, lockKey)).toBe('acquired')
        await next.query('SELECT pg_advisory_unlock_all()')
      } finally { next.release() }
      expect(await rowsOf('settle-refused')).toBe(0)
    } finally {
      await pool.end()
    }
  })
})

describe('G4-16f C6b — adopt plane v2 without a database', () => {
  it('adoptPostureText maps each flag to its own label, over all 16 combinations', () => {
    const seen = new Set<string>()
    for (let bits = 0; bits < 16; bits += 1) {
      const posture = { rotation: Boolean(bits & 1), fold: Boolean(bits & 2), parking: Boolean(bits & 4), extractCache: Boolean(bits & 8) }
      const on = (flag: boolean) => (flag ? 'on' : 'off')
      const text = adoptPostureText(posture)
      expect(text).toBe(`rotation=${on(posture.rotation)};fold=${on(posture.fold)};parking=${on(posture.parking)};cache=${on(posture.extractCache)}`)
      seen.add(text)
    }
    expect(seen.size).toBe(16)
  })

  it('adoptTopology lists bare document ids (prefix and query dropped) in list order with duplicates, null where a list is absent, and the digest of the same read', () => {
    const root = { modelMetaUrl: 'automerge:META?x=1', modelUrl: '', shardUrls: ['automerge:R2', 'automerge:R1?y=2', 'automerge:R2'] }
    const meta = { objectShardUrls: ['automerge:O2?x=1', 'automerge:O1', 'automerge:O2'], connectionShardUrls: ['automerge:C1'] }
    expect(adoptTopology('ROOT', root, meta)).toEqual({
      digest: adoptTopologyDigest(root, meta),
      rootDocumentId: 'ROOT', metaDocumentId: 'META',
      objectShardIds: ['O2', 'O1', 'O2'], connectionShardIds: ['C1'], registryShardIds: ['R2', 'R1', 'R2'],
    })
    expect(adoptTopology(null, { modelUrl: 'automerge:M' }, undefined)).toEqual({
      digest: adoptTopologyDigest({ modelUrl: 'automerge:M' }, undefined),
      rootDocumentId: null, metaDocumentId: null, objectShardIds: null, connectionShardIds: null, registryShardIds: null,
    })
  })
})

describe('G4-16f C2 — adopt bookkeeping without a database', () => {
  it('recordAdoptWatermarks certifies only when EVERY sample equals both the current and the durable heads', async () => {
    const calls: unknown[][] = []
    const tx = { query: async (_text: string, params: unknown[]) => { calls.push(params); return { rows: [], rowCount: 0 } } }
    const same = (heads: string[]) => () => heads
    await recordAdoptWatermarks(tx as never, WS, [
      { documentId: 'ok', sampledHeads: ['a'], readCurrentHeads: same(['a']) },
      { documentId: 'durable-differs', sampledHeads: ['a'], readCurrentHeads: same(['a']) },
      { documentId: 'first-unstable', sampledHeads: ['a'], readCurrentHeads: same(['b']) },
      { documentId: 'first-unstable', sampledHeads: ['a'], readCurrentHeads: same(['a']) },
      { documentId: 'no-durable', sampledHeads: ['a'], readCurrentHeads: same(['a']) },
      { documentId: 'null-sample', sampledHeads: null, readCurrentHeads: same(['a']) },
      { documentId: 'null-current', sampledHeads: ['a'], readCurrentHeads: () => null },
    ], {
      watermarkPost: '77',
      durableHeadsById: new Map([['ok', ['a']], ['durable-differs', ['z']], ['first-unstable', ['a']], ['null-sample', ['a']], ['null-current', ['a']]]),
    })
    expect(calls).toHaveLength(1)
    const [, , ids, marks] = calls[0] as [string, string, string[], string[]]
    expect(Object.fromEntries(ids.map((id, at) => [id, marks[at]]))).toEqual({
      ok: '77', 'durable-differs': '0', 'first-unstable': '0', 'no-durable': '0', 'null-sample': '0', 'null-current': '0',
    })
  })

  it('every field the topology digest claims to cover changes it, order and duplicates included', () => {
    const root = { modelMetaUrl: 'm', modelUrl: '', shardUrls: ['s1', 's2'] }
    const meta = {
      objectShardUrls: ['o1', 'o2'], connectionShardUrls: ['c1'], editsObjectShardUrl: 'eo', editsObjectShardUrls: ['eo'],
      editsConnectionShardUrl: 'ec', editsConnectionShardUrls: ['ec'], groups: {},
    }
    const variants: Array<[Partial<Root>, Partial<Meta> | undefined]> = [
      [root, meta],
      [{ ...root, modelMetaUrl: 'm2' }, meta], [{ ...root, modelUrl: 'x' }, meta],
      [{ ...root, shardUrls: ['s2', 's1'] }, meta], [{ ...root, shardUrls: ['s1', 's2', 's2'] }, meta],
      [root, { ...meta, objectShardUrls: ['o2', 'o1'] }], [root, { ...meta, objectShardUrls: ['o1', 'o2', 'o1'] }],
      [root, { ...meta, connectionShardUrls: ['c1', 'c2'] }],
      [root, { ...meta, editsObjectShardUrl: 'eo2' }], [root, { ...meta, editsObjectShardUrls: ['eo', 'eo2'] }],
      [root, { ...meta, editsConnectionShardUrl: 'ec2' }], [root, { ...meta, editsConnectionShardUrls: ['ec', 'ec2'] }],
      [root, undefined],
    ]
    for (const [r, m] of variants) expect(adoptTopologyDigest(r, m)).toBe(expectedTopology(r, m))
    expect(new Set(variants.map(([r, m]) => adoptTopologyDigest(r, m))).size).toBe(variants.length)
  })

  it('a failed adopt write whose ROLLBACK TO also fails logs the ORIGINAL failure first, then throws the rollback\'s', async () => {
    const original = new Error('the adopt write failed')
    const rollback = new Error('the rollback to the savepoint failed')
    const tx = { query: async (text: string) => {
      if (text.startsWith('ROLLBACK TO SAVEPOINT')) throw rollback
      return { rows: [], rowCount: 0 }
    } }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(withAdoptSavepoint(tx as never, WS, async () => { throw original })).rejects.toBe(rollback)
      expect(errors.mock.calls.map((call) => call[1])).toEqual([original])
    } finally {
      errors.mockRestore()
    }
  })
})
