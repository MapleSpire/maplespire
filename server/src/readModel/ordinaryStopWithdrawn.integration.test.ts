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
 * T-ZEROWM-2 (4) — the ORDINARY plane's `stop()` releases its residency
 * leases WITHOUT draining the passes in flight (`projectorService.ts`, the
 * returned stop). A shard pass held past the stop commits after its head was
 * evicted; its `readCurrentHeads` answers null and, before this fix, it wrote
 * the refusal 0 with `projected_heads` = its sample. With
 * `READ_MODEL_ADOPT=on` the next attach ADOPTS that row (`adoptRefusal`
 * reads no shard certificate), seeds the head at those heads, finds its live
 * heads equal, runs no pass — and the 0 refuses the absence proof for good on
 * a quiet workspace (T-ZEROWM-2).
 *
 * Real projector, real `AutomergeResidencyLeases`, real Repo on the real
 * `PostgresStorageAdapter`, real PostgreSQL. ONE pool hook holds the
 * certificate statement of the held pass (SQL unchanged). Fixtures copied
 * from `adoptTakeover.integration.test.ts` (a test file imports no other).
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { Repo, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import { cachedHandles } from '../automergeRepoCompat.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { ensureReadModelSchema } from './schema.js'
import { awaitAdoptStamps, startReadModelProjector } from './projectorService.js'
import type { OrdinaryHeadRotationConfig } from './ordinaryHeadRotation.js'
import { adoptRefusal, readAdoptPlane } from './adoptState.js'
import { getWorkspaceProjectionFreshness } from './health.js'
import { withdrawShardCertificate } from './arrivalWatermark.js'
import type { WorkspaceKey } from './projector.js'

const connection = process.env.TEST_DATABASE_URL
const WS: WorkspaceKey = { landscapeId: 'ls-zerowm2-ordinary', versionId: 'v1' }
const LISTED = `${WS.landscapeId}/${WS.versionId}`

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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
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

async function workspace(repo: Repo) {
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
  return { repo, rootUrl: root.url, meta, head: head as DocHandle<ObjHead> }
}

/** No rotation is due in these cases (a threshold far above their writes). */
function config(): OrdinaryHeadRotationConfig {
  return { mode: 'on', allowlist: new Set([LISTED]), maxActors: 1_000_000, maxChanges: 10_000, deferral: { quietMs: 0, maxMs: 0 } }
}

/** The test pool, `before` offered each query BEFORE it runs (pool-level and
 * on a client from `connect()`). */
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

const resident = (repo: Repo, id: string) => Object.prototype.hasOwnProperty.call(cachedHandles(repo), id)
const certificate = async (documentId: string) => (await db.pool.query<{ wm: string; heads: string[] | null }>(
  `SELECT projected_watermark::text AS wm, projected_heads AS heads FROM read_model_document_watermarks
    WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
  [WS.landscapeId, WS.versionId, documentId])).rows[0] ?? null
const roObjectIds = async () => (await db.pool.query<{ id: string }>(
  'SELECT id FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id', [WS.landscapeId, WS.versionId],
)).rows.map((row) => row.id)

describe.skipIf(!connection)('T-ZEROWM-2 (4) — an ordinary stop() under a shard pass writes no 0 for the head it evicts (real projector, leases, Repo, PostgreSQL)', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'zerowm2_ordinary')
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
    const roTables = (await db.pool.query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'ro\\_%'`,
    )).rows.map((row) => row.t)
    await db.pool.query(`TRUNCATE automerge_storage, automerge_document_workspace, ${roTables.join(', ')},
      read_model_projection_state, read_model_change_events, read_model_overlay_batch_acks,
      read_model_overlay_entity_bases, read_model_ordinary_head_retirements, read_model_document_watermarks,
      read_model_ordinary_chain_folds, read_model_adopt_watermarks, read_model_adopt_state,
      read_model_sealed_product_extracts, read_model_sealed_product_entities`)
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
    vi.restoreAllMocks()
  })

  /**
   * P1 (adopt off) cold-builds, projects a first write (certified exactly),
   * then a second write whose pass is HELD at its certificate statement;
   * P1 is stopped under it (its leases released, the head evicted), the
   * pass released. `keepResident`: a second residency owner on the head (the
   * control: no eviction). `deleteAfterSample`: while the pass is held, a
   * write DELETES the second object (flushed) — the case where the
   * kept row's heads would then be an older base than the published rows.
   */
  async function stopUnderHeldShardPass(o: { keepResident: boolean; deleteAfterSample?: boolean }) {
    const ws = await workspace(storageRepo())
    const headId = String(ws.head.documentId)
    const residency = new AutomergeResidencyLeases(ws.repo)
    let armed = false
    const reached = deferred()
    const release = deferred()
    const pool = poolBeforeQuery(async (text, params) => {
      // The pass's FIRST row write naming the second object — inside its
      // transaction, BEFORE its certificate reads the live heads (holding
      // the certificate's own INSERT would hold it after that read).
      if (armed && /\bro_objects\b/.test(text) && /^\s*(INSERT|UPDATE|WITH)/i.test(text)
        && JSON.stringify(params ?? []).includes('"o2"')) {
        armed = false
        reached.resolve()
        await release.promise
      }
    })
    const stop = await startReadModelProjector(ws.repo, ws.rootUrl, pool, WS, residency, 0, undefined, undefined, undefined,
      undefined, config())
    ws.head.change((doc) => { doc.objects.o1 = { id: 'o1', name: 'one', type: 'system' } })
    expect(await until(roObjectIds, (ids) => ids.includes('o1'), 20_000), 'control: the first write is projected').toContain('o1')
    const first = await until(() => certificate(headId), (row) => Boolean(row && row.wm !== '0'), 20_000)
    expect(first?.wm, 'control: the first write is certified exactly').not.toBe('0')
    await settle(300)
    await awaitAdoptStamps(WS)
    const before = await certificate(headId)
    if (o.keepResident) residency.acquire(ws.head as DocHandle<unknown>, 'zerowm2-probe', LISTED)
    armed = true
    ws.head.change((doc) => { doc.objects.o2 = { id: 'o2', name: 'two', type: 'system' } })
    await reached.promise
    if (o.deleteAfterSample) {
      // o2: created by the held pass's sample, absent from the kept row's
      // (older) heads — the object a stale base would never delete.
      ws.head.change((doc) => { delete doc.objects.o2 })
      await ws.repo.flush([ws.head.documentId])
    }
    stop()
    await residency.drain()
    const evicted = !resident(ws.repo, headId)
    release.resolve()
    expect(await until(roObjectIds, (ids) => ids.includes('o2'), 20_000), 'control: the held pass COMMITTED after the stop').toContain('o2')
    await settle(500)
    await ws.repo.flush()
    await settle(300)
    return { ws, headId, before, evicted, after: await certificate(headId) }
  }

  it('withdrawShardCertificate: 0 with NULL heads, whether a row existed (an older, higher certificate does not survive) or not (a first certificate withdrawn must not let an adopter class the shard `new`)', async () => {
    await db.pool.query(
      `INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark, projected_heads)
       VALUES ($1, $2, 'kept', 7, ARRAY['aa'])`, [WS.landscapeId, WS.versionId])
    await withdrawShardCertificate(db.pool, WS, 'kept')
    await withdrawShardCertificate(db.pool, WS, 'first')
    expect(await certificate('kept')).toEqual({ wm: '0', heads: null })
    expect(await certificate('first')).toEqual({ wm: '0', heads: null })
  })

  it('control: the head kept resident by a second owner — the pass that commits after stop() certifies exactly', async () => {
    const run = await stopUnderHeldShardPass({ keepResident: true })
    expect(run.evicted, 'control: not evicted').toBe(false)
    expect(run.after?.wm, 'a positive certificate').not.toBe('0')
  }, 120_000)

  it('the head EVICTED by stop() under its held pass: its refusal carries NO heads (no adopter accepts it), and the next attach — adopt ON — ends with the absence proof', async () => {
    const run = await stopUnderHeldShardPass({ keepResident: false })
    expect(run.evicted, 'control: stop() evicted the head under its held pass').toBe(true)
    expect(run.before?.wm, 'control: the pass before certified').not.toBe('0')
    // Measured before the fix: '0' with projected_heads = the held pass's sample,
    // which the adopter then seeds at and keeps. SOFT, so a red run goes on to
    // show what the adoption then does with it.
    expect.soft(run.after?.wm, 'the old certificate does not survive the pass').toBe('0')
    expect.soft(run.after?.heads ?? null, `its heads are NULL: an adopter must not seed there (after ${JSON.stringify(run.after)})`).toBeNull()
    await expectNextAttachProves(run, ['b', 'o1', 'o2'])
  }, 120_000)

  it('a write DELETING an object lands after the held pass sampled — the next attach (adopt ON) does not keep the deleted object (no catch-up from a stale base)', async () => {
    const run = await stopUnderHeldShardPass({ keepResident: false, deleteAfterSample: true })
    expect(run.evicted, 'control: stop() evicted the head under its held pass').toBe(true)
    await expectNextAttachProves(run, ['b', 'o1'])
  }, 120_000)

  /** The next process (a fresh Repo, adopt ON): healthy with the absence
   * proof, the rows exactly `ids`, the head certified at its live heads. */
  async function expectNextAttachProves(run: Awaited<ReturnType<typeof stopUnderHeldShardPass>>, ids: string[]) {
    expect(adoptRefusal(await readAdoptPlane(db.pool, WS)), 'control: the plane is adoptable (the claim is attempted)').toBeNull()
    const repo = storageRepo()
    const residency = new AutomergeResidencyLeases(repo)
    const lines: string[] = []
    const capture = (...args: unknown[]) => { if (typeof args[0] === 'string') lines.push(args[0]) }
    vi.spyOn(console, 'log').mockImplementation(capture)
    vi.spyOn(console, 'warn').mockImplementation(capture)
    let stopP2: (() => void) | null = null
    try {
      stopP2 = await startReadModelProjector(repo, run.ws.rootUrl, db.pool, WS, residency, 0, 2_000, undefined, undefined,
        undefined, config(), { adopt: 'on' })
      const verdict = lines.filter((line) => line.includes('read_model.adopt_verdict')).at(-1)
      // Before the fix the claim succeeded (no cold build re-certified the 0);
      // with the fix the kept row has no heads, so it is refused and cold-built.
      expect(verdict, 'control: the adopt verdict was logged').toBeDefined()
      const fresh = await until(() => getWorkspaceProjectionFreshness(db.pool, WS),
        (f) => f.status === 'healthy' && f.absenceProvable, 20_000)
      // Measured before the fix: absenceProvable false, arrivalRefusals.zero 1, for good.
      expect({ absenceProvable: fresh.absenceProvable, zero: fresh.arrivalRefusals?.zero, status: fresh.status },
        `the adopted workspace proves absence (${JSON.stringify(fresh.arrivalRefusals)})`)
        .toEqual({ absenceProvable: true, zero: 0, status: 'healthy' })
      expect(await roObjectIds(), `the rows after the next attach (verdict ${verdict})`).toEqual(ids)
      const head = await certificate(run.headId)
      expect(head?.wm, 'the adopter certified the head itself').not.toBe('0')
      const live = A.getHeads((await repo.find<ObjHead>(run.ws.head.url as AutomergeUrl)).doc() as A.Doc<ObjHead>)
      expect([...(head?.heads ?? [])].sort(), 'at the live heads').toEqual([...live].sort())
    } finally {
      stopP2?.()
      await repo.flush()
      await settle(300)
    }
  }
})
