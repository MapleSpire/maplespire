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
import type { PoolClient } from 'pg'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import { cachedHandles } from '../automergeRepoCompat.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { markProtocolFixture } from '../testing/protocolFixture.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { ensureReadModelSchema } from './schema.js'
import { ProjectorFleet, startReadModelProjector } from './projectorService.js'
import type { OrdinaryHeadRotationConfig } from './ordinaryHeadRotation.js'
import { readOrdinaryHeadRetirement } from './ordinaryHeadForwarding.js'
import { ORDINARY_FOLD_SOURCES_FIELD, recordOrdinaryChainFold } from './ordinaryChainFold.js'
import { foldOrdinaryChain } from './ordinaryChainFoldWriter.js'
import { rotateOrdinaryHead } from './ordinaryHeadRotator.js'
import { readProjectionAcknowledgement } from './compaction.js'
import { assertReadModelPlane } from './projectionAuthority.js'
import { runWorkspaceCompaction, type WorkspaceCompactionDeps } from './workspaceCompaction.js'
import { acquireOverlayRotationLock, overlayRotationLockKey, releaseOverlayRotationLock } from './overlayRotationLock.js'
import {
  projectionInboundEdges,
  projectionLockOrderViolations,
  unknownAdvisoryKeys,
  type LockEdgeCall,
} from './lockEdgeScan.js'
import type { WorkspaceKey } from './projector.js'

/**
 * G4-16i: COMPACTION on a workspace whose ordinary write heads ROTATE and
 * whose chain FOLDS — real rotations and folds by the projector, real
 * compactions (`runWorkspaceCompaction`), over the real PostgreSQL storage
 * adapter and schema.
 *
 * The defects this pins, measured on the G4-16f aged bench (5 compactions,
 * then 5 refusals naming the same product):
 *  - W1: a compaction clears a fold PRODUCT, whose row nothing forwards, so it
 *    stays unsettled for ever: the fold stops (`sources-not-settled`) and every
 *    later compaction refuses `retired_head_forward_pending`. The head the
 *    compaction replaces has no row and splits the fold's runs;
 *  - L1: a fold RECORDED but not published leaves its sources listed and
 *    `folded`; a compaction that clears them lets the recovery publish a
 *    product built from the PRE-clear content, and a value written later is
 *    served at the older one.
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-cof', versionId: 'v1' }
const LISTED = `${WS.landscapeId}/${WS.versionId}`
const THRESHOLD = 4

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
  head: DocHandle<ObjHead>
  base: DocHandle<{ objects: Record<string, Entity> }>
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
  for (const handle of handles) await claim(String(handle.documentId))
  return { repo, rootUrl: root.url, meta, head, base }
}

async function claim(documentId: string) {
  await db.pool.query(
    'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [documentId, WS.landscapeId, WS.versionId],
  )
}
let restoreRegistration: () => void = () => {}

function config(minChain: number, budget = 8): OrdinaryHeadRotationConfig {
  return {
    mode: 'on', allowlist: new Set([LISTED]), maxActors: 1_000_000, maxChanges: THRESHOLD,
    chainFold: { minChain, budget, retainMs: 86_400_000 },
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
    lines,
    events: (event: string) => lines.filter((line) => line.event === event),
    restore: () => { for (const spy of spies) spy.mockRestore() },
  }
}

const currentHead = (ws: Workspace) => ws.meta.doc()!.editsObjectShardUrl
const docId = (url: string) => url.replace(/^automerge:/, '')
const roObjectRows = async () => (await db.pool.query<{ id: string; data: { name?: string } }>(
  'SELECT id, data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id',
  [WS.landscapeId, WS.versionId],
)).rows.map((row) => ({ id: row.id, name: row.data.name }))
const roObject = async (id: string) => (await db.pool.query<{ data: Record<string, unknown> }>(
  'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
  [WS.landscapeId, WS.versionId, id],
)).rows[0]?.data
/** Every ro_* row of the workspace, whole (every column), in a stable order:
 * what a cold rebuild must reproduce exactly. */
const roSnapshot = async () => {
  const out: Record<string, unknown[]> = {}
  for (const table of ['ro_objects', 'ro_connections', 'ro_groups']) {
    out[table] = (await db.pool.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM ${table} t WHERE landscape_id = $1 AND version_id = $2 ORDER BY id`,
      [WS.landscapeId, WS.versionId],
    )).rows.map((r) => r.row)
  }
  return out
}
const degradedSince = async () => (await db.pool.query<{ degraded_since: unknown }>(
  'SELECT degraded_since FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
  [WS.landscapeId, WS.versionId],
)).rows[0]?.degraded_since ?? null
const headsOf = (handle: { doc(): unknown }) => [...A.getHeads(handle.doc() as A.Doc<unknown>)].sort()
/** Sessions holding an `overlay-rotation:` key of this workspace, asked from an
 * independent connection (`pg_locks` masks nothing). */
const rotationKeysHeld = async () => Number((await db.pool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM pg_locks
    WHERE locktype = 'advisory' AND granted
      AND ((classid::bigint << 32) | objid::bigint) IN (
        SELECT hashtextextended(k, 0) FROM unnest($1::text[]) AS k)`,
  [[overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object'),
    overlayRotationLockKey(WS.landscapeId, WS.versionId, 'connection')]],
)).rows[0]?.n ?? 0)

/** Fill the CURRENT head with `n0..` tagged `tag` until it crosses the
 * threshold, and wait for the projector to rotate it. `latest` records the
 * newest value written for each id. */
async function fillAndRotate(ws: Workspace, tag: string, latest?: Map<string, string>): Promise<DocHandle<ObjHead>> {
  const url = currentHead(ws)
  const head = await ws.repo.find<ObjHead>(url as AutomergeUrl)
  let index = 0
  while (A.stats(head.doc() as A.Doc<unknown>).numChanges < THRESHOLD) {
    head.change((d) => { d.objects[`n${index}`] = { id: `n${index}`, name: `${tag}-${index}`, type: 'system' } })
    latest?.set(`n${index}`, `${tag}-${index}`)
    index += 1
  }
  // Up to 45 s: a rotation refused because a fold holds the shared
  // `overlay-rotation:` key is retried on its backoff (1 s, 5 s, 30 s).
  const next = await until(() => currentHead(ws), (now) => now !== url, 45_000)
  expect(next).not.toBe(url)
  return ws.repo.find<ObjHead>(next as AutomergeUrl)
}

/** A projector the compaction can release and re-attach, as `ProjectorFleet`
 * does (`ordinaryHeadRotator.integration.test.ts`, the compaction refusal). */
function projectorFleet(ws: Workspace, minChain: number, opts: {
  pool?: IsolatedSchemaDb['pool']
  /** G4-16f: residency leases (sealed products are parked only with them). */
  residency?: AutomergeResidencyLeases
  config?: OrdinaryHeadRotationConfig
} = {}) {
  let instance: string | null = null
  let stop: (() => void) | null = null
  /** Cold builds started (each `startOne` is one) and detaches by the fleet. */
  const counts = { starts: 0, releases: 0 }
  const startOne = async () => {
    counts.starts += 1
    stop = await startReadModelProjector(
      ws.repo, ws.rootUrl, opts.pool ?? db.pool, WS, opts.residency, 0, undefined,
      undefined, undefined, (id) => { instance = id }, opts.config ?? config(minChain),
    )
  }
  const fleet: WorkspaceCompactionDeps['fleet'] = {
    isResident: () => stop !== null,
    ensure: async () => {
      if (!stop) await startOne()
      return true
    },
    release: () => {
      counts.releases += 1
      stop?.()
      stop = null
    },
    residentProjectorInstanceId: () => instance,
  }
  return {
    fleet,
    counts: () => ({ ...counts }),
    instance: () => instance,
    start: startOne,
    stop: () => { stop?.(); stop = null },
    /** A cold restart: what a later process serves. */
    restart: async () => { stop?.(); stop = null; await settle(); await startOne() },
  }
}

function deps(ws: Workspace, fleet: WorkspaceCompactionDeps['fleet'], over: Partial<WorkspaceCompactionDeps> = {}): WorkspaceCompactionDeps {
  return {
    repo: ws.repo, rootUrl: ws.rootUrl, db: db.pool, fleet,
    connect: () => db.pool.connect(),
    ownership: { owns: () => true }, isShuttingDown: () => false,
    log: () => {}, warn: () => {},
    ...over,
  } as WorkspaceCompactionDeps
}

const acknowledged = () => until(() => readProjectionAcknowledgement(db.pool, WS), (ack) => ack.acknowledged, 15_000)

suite('compaction on a rotated, folded ordinary workspace (G4-16i) — real storage, projector, PostgreSQL', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'compaction_ordinary_fold')
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
  })
  afterEach(() => { restoreRegistration() })

  it('W1: a compaction over a folded chain settles the product it rewrote and gives the head it replaced a row — the next compaction folds, and the fold goes on', async () => {
    const ws = await workspace(storageRepo())
    const log = logLines()
    const latest = new Map<string, string>([['b', 'B']])
    const projector = projectorFleet(ws, 2)
    await projector.start()
    try {
      await fillAndRotate(ws, 'h0', latest)
      await fillAndRotate(ws, 'h1', latest)
      // Witness: a fold ran and its product holds entities.
      const folds = await until(() => log.events('read_model.ordinary_chain_folded'), (lines) => lines.length >= 1, 30_000)
      expect(folds.length).toBeGreaterThanOrEqual(1)
      const product = folds[0]!.product as string
      expect(folds[0]!.entities as number).toBeGreaterThan(0)
      await until(() => ws.meta.doc()!.objectShardUrls.includes(`automerge:${product}`), Boolean)
      expect(ws.meta.doc()!.objectShardUrls).toContain(`automerge:${product}`)
      await acknowledged()

      // Compaction #1: the product is listed, so it is folded and cleared.
      const replaced = docId(currentHead(ws))
      const first = await runWorkspaceCompaction(WS, deps(ws, projector.fleet))
      expect(first.result.skippedReason).toBeUndefined()
      expect(first.result.objectsFolded).toBeGreaterThan(0)
      expect(first.reattach).toBe('reattached')
      // The head the compaction replaced has a row (it is retired, like any):
      // read now, asserted after compaction #2 (whose refusal is the defect).
      const replacedRow = await readOrdinaryHeadRetirement(db.pool, WS, 'object', replaced)
      // The product the compaction cleared is SETTLED at its post-clear heads.
      const productHandle = await ws.repo.find(`automerge:${product}` as AutomergeUrl)
      const productRow = await readOrdinaryHeadRetirement(db.pool, WS, 'object', product)
      await acknowledged()
      // And the fold takes them again BEFORE any further rotation or
      // compaction: the product and the replaced head are the chain's
      // foldable prefix (in the previous release the product never settles,
      // and the replaced head has no row).
      const productFoldedEarly = await until(() => readOrdinaryHeadRetirement(db.pool, WS, 'object', product),
        (row) => row?.status === 'folded', 20_000)
      await settle(1_000)

      // A user edit BETWEEN the compactions, of the entity whose home is the
      // base shard: compaction #2 folds it into the base and clears it from
      // the overlay, and it must be what is served at the end.
      const editHead = await ws.repo.find<ObjHead>(currentHead(ws) as AutomergeUrl)
      editHead.change((d) => { d.objects.b = { id: 'b', name: 'B-edited', type: 'system' } })
      latest.set('b', 'B-edited')
      await until(() => roObject('b'), (row) => row?.name === 'B-edited')

      await fillAndRotate(ws, 'h2', latest)
      await fillAndRotate(ws, 'h3', latest)
      await acknowledged()
      await settle(1_000)

      // Compaction #2: the previous release refused here, `retired_head_forward_pending`,
      // naming the product compaction #1 cleared — and every one after it.
      const second = await runWorkspaceCompaction(WS, deps(ws, projector.fleet))
      expect(log.events('compaction.refused').flatMap((line) => line.segments as string[])).not.toContain(product)
      expect(log.events('compaction.refused')).toEqual([])
      expect(second.result.skippedReason).toBeUndefined()
      expect(second.result.objectsFolded).toBeGreaterThan(0)
      expect(replacedRow).toMatchObject({ status: expect.stringMatching(/^(retired|folded)$/) })
      expect(productRow?.forwardedHeads).toEqual(headsOf(productHandle))
      expect(productFoldedEarly?.status).toBe('folded')

      // The fold goes on: the product and the head compaction #1 replaced are
      // folded again (they were the chain's foldable prefix), and the overlay
      // list is bounded again.
      expect((await until(() => readOrdinaryHeadRetirement(db.pool, WS, 'object', product),
        (row) => row?.status === 'folded', 30_000))?.status).toBe('folded')
      expect((await until(() => readOrdinaryHeadRetirement(db.pool, WS, 'object', replaced),
        (row) => row?.status === 'folded', 30_000))?.status).toBe('folded')
      expect(await until(() => ws.meta.doc()!.editsObjectShardUrls.length, (n) => n <= 3, 30_000)).toBeLessThanOrEqual(3)
      expect(log.events('read_model.ordinary_fold_product_changed')).toEqual([])

      // Every value is the LATEST one written, and a cold restart agrees.
      const expected = [...latest.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, name]) => ({ id, name }))
      expect(await until(roObjectRows, (rows) => JSON.stringify(rows) === JSON.stringify(expected), 15_000)).toEqual(expected)
      expect(await degradedSince()).toBeNull()
      // The base holds the edit made between the compactions (folded by #2).
      expect((await ws.repo.find<{ objects: Record<string, Entity> }>(ws.base.url)).doc()!.objects.b?.name).toBe('B-edited')
      const live = await roSnapshot()
      await projector.restart()
      await acknowledged()
      expect(await roObjectRows()).toEqual(expected)
      // ro_* after the sequence equals a cold rebuild, row for row.
      expect(await roSnapshot()).toEqual(live)
      expect(await degradedSince()).toBeNull()
    } finally {
      projector.stop()
      log.restore()
    }
  }, 300_000)

  it('A16 (G4-16f C6-2a): under READ_MODEL_ADOPT=on, the compaction re-attach through the REAL fleet is a cold build — no adopt verdict, no claim — and it is acknowledged and attached when ensure returns', async () => {
    const ws = await workspace(storageRepo())
    const log = logLines()
    const fleet = new ProjectorFleet(ws.repo, async () => ws.rootUrl, {
      fallbackRootUrl: ws.rootUrl, db: db.pool, ordinaryHeadRotation: config(2), adopt: 'on', maxProjectors: 2,
    })
    const latest = new Map<string, string>([['b', 'B']])
    try {
      expect(await fleet.ensure(WS)).toBe(true)
      await fillAndRotate(ws, 'h0', latest)
      await fillAndRotate(ws, 'h1', latest)
      await until(() => log.events('read_model.ordinary_chain_folded'), (lines) => lines.length >= 1, 30_000)
      await acknowledged()
      // The binding is the resident's: an ensure of a released workspace WOULD adopt.
      expect((await db.pool.query<{ b: string | null }>('SELECT fence_binding AS b FROM read_model_adopt_state WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId])).rows[0]?.b).toBe(fleet.residentProjectorInstanceId(WS))
      const verdicts = log.events('read_model.adopt_verdict').length
      const builds = log.events('read_model.cold_build_phases').length
      let attachedWhenEnsured: boolean | null = null
      const adapter: WorkspaceCompactionDeps['fleet'] = {
        isResident: (key) => fleet.isResident(key),
        ensure: async (key, options) => {
          const ok = await fleet.ensure(key, options)
          attachedWhenEnsured = (await readProjectionAcknowledgement(db.pool, WS)).acknowledged
          return ok
        },
        release: (key, reason) => fleet.release(key, reason),
        endCompactionWindow: (key) => fleet.endCompactionWindow(key),
        residentProjectorInstanceId: (key) => fleet.residentProjectorInstanceId(key),
      }
      const outcome = await runWorkspaceCompaction(WS, deps(ws, adapter))
      expect(outcome.result.skippedReason).toBeUndefined()
      expect(outcome.reattach).toBe('reattached')
      expect(log.events('read_model.adopt_verdict').length - verdicts, 'the re-attach verified nothing: it never adopts').toBe(0)
      expect(log.events('read_model.cold_build_phases').length - builds, 'the re-attach is ONE cold build').toBe(1)
      expect(attachedWhenEnsured, 'acknowledged the moment ensure returned').toBe(true)
      const expected = [...latest.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, name]) => ({ id, name }))
      expect(await until(roObjectRows, (rows) => JSON.stringify(rows) === JSON.stringify(expected), 15_000)).toEqual(expected)
    } finally {
      fleet.stopAll()
      log.restore()
    }
  }, 300_000)

  it('W2: a compaction whose settle FAILS after its clear leaves the product rewritten and unsettled — the next compaction is not refused on it, and settles it', async () => {
    const ws = await workspace(storageRepo())
    const log = logLines()
    const projector = projectorFleet(ws, 2)
    await projector.start()
    try {
      await fillAndRotate(ws, 'h0')
      await fillAndRotate(ws, 'h1')
      const folds = await until(() => log.events('read_model.ordinary_chain_folded'), (lines) => lines.length >= 1, 30_000)
      expect(folds.length).toBeGreaterThanOrEqual(1)
      const product = folds[0]!.product as string
      await until(() => ws.meta.doc()!.objectShardUrls.includes(`automerge:${product}`), Boolean)
      await acknowledged()
      const pointer = currentHead(ws)
      let armed = true
      const failing = async () => {
        const client = await db.pool.connect()
        return new Proxy(client, {
          get(subject, name) {
            if (name === 'query') {
              return (sql: unknown, values?: unknown[]) => {
                if (armed && typeof sql === 'string' && sql.startsWith('BEGIN')) {
                  armed = false
                  return Promise.reject(new Error('w2: injected settle failure'))
                }
                return (subject.query as (s: unknown, v?: unknown[]) => Promise<unknown>).call(subject, sql, values)
              }
            }
            const value = Reflect.get(subject, name, subject)
            return typeof value === 'function' ? value.bind(subject) : value
          },
        })
      }
      await expect(runWorkspaceCompaction(WS, deps(ws, projector.fleet, { connect: failing }))).rejects.toThrow('w2: injected settle failure')
      // Witness: the clear ran (the product is rewritten), the settle did not,
      // and ModelMeta was not repointed.
      expect(armed).toBe(false)
      const productHandle = await ws.repo.find(`automerge:${product}` as AutomergeUrl)
      const unsettled = await readOrdinaryHeadRetirement(db.pool, WS, 'object', product)
      expect(unsettled?.status).toBe('retired')
      expect(unsettled?.forwardedHeads ?? unsettled?.retirementHeads).not.toEqual(headsOf(productHandle))
      expect(currentHead(ws)).toBe(pointer)
      // The failed pass cleared every segment; the next one needs work to do
      // (a pass with nothing to fold writes nothing, a settle included — so
      // the product waits for the next edit's compaction).
      const head = await ws.repo.find<ObjHead>(pointer as AutomergeUrl)
      head.change((d) => { d.objects.w2 = { id: 'w2', name: 'w2', type: 'system' } })
      await until(() => roObject('w2'), (row) => row?.name === 'w2')
      await acknowledged()
      await settle(500)

      const next = await runWorkspaceCompaction(WS, deps(ws, projector.fleet))
      expect(log.events('compaction.refused')).toEqual([])
      expect(next.result.skippedReason).toBeUndefined()
      expect((await readOrdinaryHeadRetirement(db.pool, WS, 'object', product))?.forwardedHeads).toEqual(headsOf(productHandle))
      expect((await until(() => readOrdinaryHeadRetirement(db.pool, WS, 'object', product),
        (row) => row?.status === 'folded', 30_000))?.status).toBe('folded')
      expect(await degradedSince()).toBeNull()
    } finally {
      projector.stop()
      log.restore()
    }
  }, 300_000)

  it('L1: a fold RECORDED but not published refuses the compaction (ordinary_fold_unpublished); the recovery publishes it, the next compaction folds, and the newer value is still served after a cold restart', async () => {
    const ws = await workspace(storageRepo())
    const repo = ws.repo
    const log = logLines()
    // A threshold no chain reaches: rotations, no fold.
    const setup = projectorFleet(ws, 1_000)
    await setup.start()
    let holder: PoolClient | null = null
    let holderReleased: Promise<void> = Promise.resolve()
    const projector = projectorFleet(ws, 1_000)
    /** The boot fold of the attach below must NOT publish the record before
     * the compaction has read it: the key is held over that attach and given
     * back by the compaction's own first `connect()`, right before it asks for
     * the key — and only once the projector's fold has been refused three
     * times, so its next retry is 30 s away (`FOLD_RETRY_DELAYS_MS`). */
    const giveBackHolder = async () => {
      const held = holder
      holder = null
      if (held) {
        holderReleased = releaseOverlayRotationLock(held, overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object'), 'acquired')
      }
      await holderReleased
    }
    try {
      const h1 = await fillAndRotate(ws, 'h0')
      await fillAndRotate(ws, 'h1')
      const sources = [ws.head, h1]
      for (const source of sources) {
        await until(async () => {
          const row = await readOrdinaryHeadRetirement(db.pool, WS, 'object', source.documentId)
          return JSON.stringify(row?.forwardedHeads ?? row?.retirementHeads) === JSON.stringify(headsOf(source))
        }, Boolean)
      }
      setup.stop()
      await settle()
      expect(log.events('read_model.ordinary_chain_folded')).toEqual([])

      // The fold's steps 4 and 6 by hand (a crash before its ModelMeta change).
      const merged = Object.assign({}, ...sources.map((s) => JSON.parse(JSON.stringify(s.doc()!.objects))))
      expect(merged.n0.name).toBe('h1-0')
      const productHandle = repo.create({ objects: merged, writeBatchIds: [], [ORDINARY_FOLD_SOURCES_FIELD]: sources.map((s) => s.url) })
      await productHandle.whenReady()
      await repo.flush([productHandle.documentId])
      await claim(productHandle.documentId)
      const client = await db.pool.connect()
      try {
        await client.query('BEGIN')
        await markProtocolFixture(client)
        await recordOrdinaryChainFold(client, WS, {
          collection: 'object',
          productDocumentId: productHandle.documentId,
          productHeads: A.getHeads(productHandle.doc() as A.Doc<unknown>),
          currentDocumentId: docId(currentHead(ws)),
          sources: await Promise.all(sources.map(async (s) => ({
            documentId: s.documentId,
            forwardedHeads: (await readOrdinaryHeadRetirement(db.pool, WS, 'object', s.documentId))?.forwardedHeads ?? null,
          }))),
          retainUntil: new Date(Date.now() + 86_400_000),
        })
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      // A NEWER value, in the current head, after the record.
      const current = await repo.find<ObjHead>(currentHead(ws) as AutomergeUrl)
      current.change((d) => { d.objects.n0 = { id: 'n0', name: 'newer', type: 'system' } })
      await repo.flush([current.documentId])

      holder = await db.pool.connect() as PoolClient
      expect(await acquireOverlayRotationLock(holder, overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object'))).toBe('acquired')
      await projector.start()
      await acknowledged()
      expect((await until(() => roObject('n0'), (row) => row?.name === 'newer'))?.name).toBe('newer')
      const productUrl = productHandle.url
      // Witness: the record is still unpublished when the compaction starts.
      expect(ws.meta.doc()!.objectShardUrls).not.toContain(productUrl)
      const baseHeads = headsOf(ws.base)
      const sourceHeads = sources.map(headsOf)
      const foldRefusals = () => log.events('read_model.overlay_rotation_lock_contended')
        .filter((line) => line.path === 'fold' && line.kind === 'object').length
      expect(await until(foldRefusals, (n) => n >= 3, 20_000)).toBeGreaterThanOrEqual(3)

      const warned: string[] = []
      const gated = deps(ws, projector.fleet, {
        connect: async () => { await giveBackHolder(); return db.pool.connect() },
        warn: (message) => warned.push(message),
      })
      const first = await runWorkspaceCompaction(WS, gated)
      const firstBaseHeads = headsOf(ws.base)
      const firstSourceHeads = sources.map(headsOf)

      // The recovery (step 3a) publishes the record: at the re-attach, or at a
      // later attach (a skipped fold waits for the next rotation, so each
      // restart here stands in for one).
      const deadline = Date.now() + 60_000
      while (!ws.meta.doc()!.objectShardUrls.includes(productUrl) && Date.now() < deadline) {
        await until(() => ws.meta.doc()!.objectShardUrls.includes(productUrl), Boolean, 8_000)
        if (!ws.meta.doc()!.objectShardUrls.includes(productUrl)) await projector.restart()
      }
      expect(ws.meta.doc()!.objectShardUrls).toContain(productUrl)
      await acknowledged()
      await settle(1_000)
      const second = await runWorkspaceCompaction(WS, deps(ws, projector.fleet))

      // What a later process serves.
      await projector.restart()
      await acknowledged()
      expect((await roObject('n0'))?.name).toBe('newer')
      expect(ws.base.doc()!.objects.n0).toMatchObject({ name: 'newer' })
      expect(await degradedSince()).toBeNull()

      // The refusal, and what it left: nothing written.
      expect(first.result.skippedReason).toBe('ordinary_fold_unpublished')
      expect(warned.some((message) => message.includes('chain fold is recorded and not published'))).toBe(true)
      expect(first.reattach).toBe('reattached')
      expect(firstBaseHeads).toEqual(baseHeads)
      expect(firstSourceHeads).toEqual(sourceHeads)
      expect(second.result.skippedReason).toBeUndefined()
      expect(second.result.objectsFolded).toBeGreaterThan(0)
      expect(log.events('read_model.ordinary_chain_folded'))
        .toEqual([expect.objectContaining({ product: productHandle.documentId, recovered: true })])
    } finally {
      setup.stop()
      projector.stop()
      const held = holder as PoolClient | null
      if (held) await releaseOverlayRotationLock(held, overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object'), 'acquired')
      await holderReleased.catch(() => undefined)
      log.restore()
    }
  }, 300_000)

  it('THE RACE guard (d) exists for: a fold that sampled its sources BEFORE the clear and publishes BETWEEN the clear and the repoint — with the keys the compaction is refused and the newer value survives', async () => {
    // RED with `withRotationKeys` bypassed: the compaction folds
    // `newer` into the base and clears every segment; the paused fold then
    // records (its CAS passes: the detached projector forwards nothing) and
    // splices its product — built from the PRE-clear sources, n0 = h1-0 — in
    // place of the sources; the compaction repoints after it. ModelMeta order
    // then puts the product above the base, and a cold build serves h1-0.
    const ws = await workspace(storageRepo())
    const repo = ws.repo
    const log = logLines()
    const projector = projectorFleet(ws, 1_000)
    await projector.start()
    let releaseProduct: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseProduct = resolve })
    let foldRunning: Promise<Awaited<ReturnType<typeof foldOrdinaryChain>>> | null = null
    try {
      const h1 = await fillAndRotate(ws, 'h0')
      await fillAndRotate(ws, 'h1')
      for (const source of [ws.head, h1]) {
        await until(async () => {
          const row = await readOrdinaryHeadRetirement(db.pool, WS, 'object', source.documentId)
          return JSON.stringify(row?.forwardedHeads ?? row?.retirementHeads) === JSON.stringify(headsOf(source))
        }, Boolean)
      }
      const current = await repo.find<ObjHead>(currentHead(ws) as AutomergeUrl)
      current.change((d) => { d.objects.n0 = { id: 'n0', name: 'newer', type: 'system' } })
      expect((await until(() => roObject('n0'), (row) => row?.name === 'newer'))?.name).toBe('newer')
      await acknowledged()
      // The projector's own passes take the object key briefly: let them end.
      expect(await until(rotationKeysHeld, (n) => n === 0, 5_000)).toBe(0)
      await settle(500)

      // The fold, as the projector's writer runs it (another cell's, or a pass
      // that outlived the detach), paused once its product exists — i.e.
      // AFTER it sampled the sources, holding the object key.
      let productBuilt: () => void = () => {}
      const built = new Promise<void>((resolve) => { productBuilt = resolve })
      foldRunning = foldOrdinaryChain({
        key: WS, collection: 'object',
        meta: { documentId: ws.meta.documentId, doc: () => ws.meta.doc() as never, change: (fn) => ws.meta.change(fn as never) },
        minChain: 2, budget: 8, retainMs: 86_400_000,
        mayWrite: () => true, watched: () => true,
        assertAuthority: async () => {},
        connect: () => db.pool.connect(),
        // The plane, then the fence row's lock-order mark (the fence VALUE
        // is the projector's instance id, which this hand-run fold does not know).
        assertTransactionAuthority: async (tx) => {
          await assertReadModelPlane(tx, WS, 'ordinary')
          await markProtocolFixture(tx)
        },
        segment: async (url) => {
          const handle = await repo.find(url as AutomergeUrl)
          return { documentId: handle.documentId, doc: () => handle.doc() }
        },
        createProduct: async (entities, fields) => {
          const product = repo.create({ objects: entities, writeBatchIds: [], ...fields })
          await product.whenReady()
          await repo.flush([product.documentId])
          await claim(product.documentId)
          productBuilt()
          await gate
          return { url: product.url, documentId: product.documentId, doc: () => product.doc() }
        },
        flush: (documentIds) => repo.flush(documentIds),
        log: (line) => console.warn(line),
      })
      await built
      expect(await rotationKeysHeld()).toBe(1) // witness: the fold holds the object key

      // The compaction. IF it gets as far as its settle (after its clear,
      // before its repoint), the fold is let go there and finishes first.
      let between = false
      const racing = async () => {
        const client = await db.pool.connect()
        return new Proxy(client, {
          get(subject, name) {
            if (name === 'query') {
              return async (sql: unknown, values?: unknown[]) => {
                if (!between && typeof sql === 'string' && sql.startsWith('BEGIN')) {
                  between = true
                  releaseProduct()
                  await foldRunning
                }
                return (subject.query as (s: unknown, v?: unknown[]) => Promise<unknown>).call(subject, sql, values)
              }
            }
            const value = Reflect.get(subject, name, subject)
            return typeof value === 'function' ? value.bind(subject) : value
          },
        })
      }
      const result = await runWorkspaceCompaction(WS, deps(ws, projector.fleet, { connect: racing }))
      // Refused: the fold finishes now, as it would have.
      releaseProduct()
      const folded = await foldRunning
      expect(folded).toMatchObject({ outcome: 'folded' })

      // What a later process serves.
      await projector.restart()
      await acknowledged()
      expect((await roObject('n0'))?.name).toBe('newer')
      expect(await degradedSince()).toBeNull()
      // And why: the compaction never wrote while the fold was in flight.
      expect(result.result.skippedReason).toBe('overlay_rotation_lock_contended')
      expect(result.reattach).toBe('not_detached')
      expect(between).toBe(false)
    } finally {
      releaseProduct()
      await (foldRunning as Promise<unknown> | null)?.catch(() => undefined)
      projector.stop()
      log.restore()
    }
  }, 180_000)

  it('L2: a rotation key held elsewhere refuses the compaction (overlay_rotation_lock_contended) with nothing written and both keys free after; the compaction holds both keys while it writes', async () => {
    const ws = await workspace(storageRepo())
    const log = logLines()
    const projector = projectorFleet(ws, 1_000)
    await projector.start()
    const connKey = overlayRotationLockKey(WS.landscapeId, WS.versionId, 'connection')
    const holder = await db.pool.connect() as PoolClient
    let holderState: 'acquired' | 'refused' = 'refused'
    let holderReturned = false
    let unpause: (() => void) | null = null
    let running: Promise<unknown> | null = null
    try {
      await fillAndRotate(ws, 'h0')
      await acknowledged()
      const metaBefore = headsOf(ws.meta)
      const baseBefore = headsOf(ws.base)
      const headBefore = headsOf(await ws.repo.find(currentHead(ws) as AutomergeUrl))
      // The rotation's fold pass takes the object key briefly: let it finish.
      expect(await until(rotationKeysHeld, (n) => n === 0, 5_000)).toBe(0)
      await settle(500)
      holderState = await acquireOverlayRotationLock(holder, connKey) as 'acquired'
      expect(holderState).toBe('acquired')
      // Control: the key IS seen held from an independent connection.
      // `until`, not a bare read: the projector's own fold/rotation passes take
      // the same keys briefly (measured: 3 under load, 1 of 5 runs).
      expect(await until(rotationKeysHeld, (n) => n === 1, 5_000)).toBe(1)

      const countsBefore = projector.counts()
      const instanceBefore = projector.instance()
      expect(instanceBefore).not.toBeNull()
      const refused = await runWorkspaceCompaction(WS, deps(ws, projector.fleet))
      expect(refused.result.skippedReason).toBe('overlay_rotation_lock_contended')
      // Taken BEFORE the detach: a contended skip costs no detach and no cold
      // build — the projector that was attached is still the one attached.
      expect(refused.reattach).toBe('not_detached')
      expect(projector.counts()).toEqual(countsBefore)
      expect(projector.instance()).toBe(instanceBefore)
      expect(headsOf(ws.meta)).toEqual(metaBefore)
      expect(headsOf(ws.base)).toEqual(baseBefore)
      expect(headsOf(await ws.repo.find(currentHead(ws) as AutomergeUrl))).toEqual(headBefore)
      expect(log.events('read_model.overlay_rotation_lock_contended')
        .some((line) => line.path === 'compaction' && line.kind === 'connection')).toBe(true)
      // Only the holder's key is held: the compaction gave the object key back
      // (waited for: the re-attached projector's boot fold takes it briefly).
      expect(await until(rotationKeysHeld, (n) => n === 1, 5_000)).toBe(1)
      await releaseOverlayRotationLock(holder, connKey, 'acquired')
      holderReturned = true
      expect(await until(rotationKeysHeld, (n) => n === 0, 5_000)).toBe(0)

      // Free: the next compaction folds — and while it writes, it holds both
      // keys, so a rotation or a fold of either kind is refused.
      await acknowledged()
      let paused: (() => void) | null = null
      let entered: (() => void) | null = null
      const enteredAt = new Promise<void>((resolve) => { entered = resolve })
      let calls = 0
      // `owns` is synchronous in the interface; the pause is made inside the
      // staticness read that follows it in `stillSafeToWrite`, by awaiting the
      // gate there.
      let gate: Promise<void> | null = null
      const pausingDb = new Proxy(db.pool, {
        get(target, property) {
          if (property === 'query') {
            return async (sql: unknown, values?: unknown[]) => {
              if (gate && typeof sql === 'string' && sql.includes('read_model_static_workspaces')) {
                const wait = gate
                gate = null
                await wait
              }
              return (target.query as (s: unknown, v?: unknown[]) => Promise<unknown>).call(target, sql, values)
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as unknown as IsolatedSchemaDb['pool']
      const compaction = runWorkspaceCompaction(WS, deps(ws, projector.fleet, {
        db: pausingDb,
        ownership: {
          owns: () => {
            calls += 1
            // The first consultation of `stillSafeToWrite` (the fold's first
            // write is next): arm the pause on its staticness read.
            if (calls === 1) {
              gate = new Promise<void>((resolve) => { paused = resolve; unpause = resolve; entered?.() })
            }
            return true
          },
        },
      }))
      running = compaction
      await enteredAt
      expect(await until(rotationKeysHeld, (n) => n === 2, 5_000)).toBe(2)
      const refusedFold = await foldOrdinaryChain({
        key: WS, collection: 'object',
        meta: { documentId: ws.meta.documentId, doc: () => ws.meta.doc() as never, change: () => { throw new Error('unreachable') } },
        minChain: 2, budget: 8, retainMs: 86_400_000,
        mayWrite: () => true, watched: () => true,
        assertAuthority: async () => {},
        connect: () => db.pool.connect(),
        assertTransactionAuthority: async () => { throw new Error('unreachable') },
        segment: async () => { throw new Error('unreachable') },
        createProduct: async () => { throw new Error('unreachable') },
        flush: async () => { throw new Error('unreachable') },
        log: () => {},
      })
      expect(refusedFold).toMatchObject({ outcome: 'lock-refused', state: 'refused' })
      const connHead = await ws.repo.find<{ connections: Record<string, Entity> }>(ws.meta.doc()!.editsConnectionShardUrl as AutomergeUrl)
      const refusedRotation = await rotateOrdinaryHead({
        key: WS, collection: 'connection',
        retired: { url: connHead.url, documentId: connHead.documentId, doc: () => connHead.doc() },
        meta: { documentId: ws.meta.documentId, doc: () => ws.meta.doc() as never },
        publishedHeads: () => { throw new Error('unreachable') },
        mayWrite: () => true,
        assertAuthority: async () => {},
        connect: () => db.pool.connect(),
        createChild: async () => { throw new Error('unreachable') },
        flush: async () => { throw new Error('unreachable') },
        assertTransactionAuthority: async () => { throw new Error('unreachable') },
        publish: () => { throw new Error('unreachable') },
        log: () => {},
      })
      expect(refusedRotation).toMatchObject({ outcome: 'lock-refused', state: 'refused' })
      ;(paused as (() => void) | null)?.()
      const folded = await compaction
      expect(folded.result.skippedReason).toBeUndefined()
      expect(folded.result.objectsFolded).toBeGreaterThan(0)
      expect(folded.reattach).toBe('reattached')
      expect(await until(rotationKeysHeld, (n) => n === 0, 5_000)).toBe(0)
    } finally {
      ;(unpause as (() => void) | null)?.()
      await (running as Promise<unknown> | null)?.catch(() => undefined)
      if (!holderReturned) {
        if (holderState === 'acquired') await releaseOverlayRotationLock(holder, connKey, 'acquired')
        else holder.release()
      }
      projector.stop()
      log.restore()
    }
  }, 180_000)

  it('L3: a late write into the head a compaction replaces — before and after the repoint — is forwarded into the new head and served, after a cold restart too', async () => {
    const ws = await workspace(storageRepo())
    const log = logLines()
    const projector = projectorFleet(ws, 1_000)
    await projector.start()
    try {
      await fillAndRotate(ws, 'h0')
      const replacedUrl = currentHead(ws)
      const replaced = await ws.repo.find<ObjHead>(replacedUrl as AutomergeUrl)
      replaced.change((d) => { d.objects.x = { id: 'x', name: 'X', type: 'system' } })
      await until(() => roObject('x'), (row) => row?.name === 'X')
      await acknowledged()
      // Two clients offline across the compaction, holding the replaced head.
      const forkA = A.clone(replaced.doc() as A.Doc<ObjHead>)
      const forkB = A.clone(replaced.doc() as A.Doc<ObjHead>)
      const reconnect = (fork: A.Doc<ObjHead>, id: string) => {
        const edited = A.change(fork, (d) => { d.objects[id] = { id, name: id, type: 'system' } })
        replaced.update((doc) => A.merge(doc, edited))
      }
      // BEFORE the repoint: the first late write lands while the compaction
      // settles the segments it rewrote (after its clear, before its
      // ModelMeta change).
      let fired = false
      const hooked = new Proxy(db.pool, {
        get(target, property) {
          if (property === 'connect') {
            return async () => {
              const client = await target.connect()
              return new Proxy(client, {
                get(subject, name) {
                  if (name === 'query') {
                    return (sql: unknown, values?: unknown[]) => {
                      if (!fired && typeof sql === 'string' && sql.startsWith('BEGIN')) {
                        fired = true
                        expect(currentHead(ws)).toBe(replacedUrl)
                        expect(replaced.doc()!.objects.x).toBeUndefined()
                        reconnect(forkA, 'lateBefore')
                      }
                      return (subject.query as (s: unknown, v?: unknown[]) => Promise<unknown>).call(subject, sql, values)
                    }
                  }
                  const value = Reflect.get(subject, name, subject)
                  return typeof value === 'function' ? value.bind(subject) : value
                },
              })
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as unknown as IsolatedSchemaDb['pool']
      const result = await runWorkspaceCompaction(WS, deps(ws, projector.fleet, { connect: () => hooked.connect() }))
      expect(result.result.skippedReason).toBeUndefined()
      expect(fired).toBe(true)
      expect(currentHead(ws)).not.toBe(replacedUrl)
      // AFTER the repoint.
      reconnect(forkB, 'lateAfter')
      await ws.repo.flush([replaced.documentId])

      const fresh = await ws.repo.find<ObjHead>(currentHead(ws) as AutomergeUrl)
      for (const id of ['lateBefore', 'lateAfter']) {
        expect((await until(() => roObject(id), (row) => row?.name === id, 15_000))?.name).toBe(id)
        // FORWARDED into the new head, not projected from the replaced one.
        expect((await until(() => fresh.doc()!.objects[id], Boolean, 15_000))).toMatchObject({ name: id })
      }
      expect(log.events('read_model.ordinary_head_forwarded').some((line) => line.retired === replaced.documentId)).toBe(true)
      expect((await roObject('x'))?.name).toBe('X')
      const rows = await roObjectRows()
      await projector.restart()
      await acknowledged()
      expect(await roObjectRows()).toEqual(rows)
      expect(await degradedSince()).toBeNull()
    } finally {
      projector.stop()
      log.restore()
    }
  }, 180_000)

  it('LOCK ORDER: the compaction never asks for the projection mutex while it holds overlay-rotation (gates A8 and G5, on the real statement stream)', async () => {
    const ws = await workspace(storageRepo())
    const log = logLines()
    type Call = { connection: number; sql: string; params: readonly unknown[]; compaction: boolean }
    const calls: Call[] = []
    let connections = 0
    let recording = false
    const record = (connection: number, sql: unknown, params?: unknown[]) => {
      if (!recording || typeof sql !== 'string') return
      const limit = Error.stackTraceLimit
      Error.stackTraceLimit = 200
      const stack = new Error().stack ?? ''
      Error.stackTraceLimit = limit
      calls.push({ connection, sql, params: params ?? [], compaction: stack.includes('runWorkspaceCompaction') })
    }
    const recorded = new Proxy(db.pool, {
      get(target, property) {
        if (property === 'query') {
          return (sql: unknown, values?: unknown[]) => {
            record(0, sql, values)
            return (target.query as (s: unknown, v?: unknown[]) => Promise<unknown>).call(target, sql, values)
          }
        }
        if (property === 'connect') {
          return async () => {
            const client = await target.connect()
            const connection = ++connections
            return new Proxy(client, {
              get(subject, name) {
                if (name === 'query') {
                  return (sql: unknown, values?: unknown[]) => {
                    record(connection, sql, values)
                    return (subject.query as (s: unknown, v?: unknown[]) => Promise<unknown>).call(subject, sql, values)
                  }
                }
                const value = Reflect.get(subject, name, subject)
                return typeof value === 'function' ? value.bind(subject) : value
              },
            })
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as unknown as IsolatedSchemaDb['pool']
    const projector = projectorFleet(ws, 2, { pool: recorded })
    await projector.start()
    try {
      await fillAndRotate(ws, 'h0')
      await fillAndRotate(ws, 'h1')
      expect(await until(() => log.events('read_model.ordinary_chain_folded').length, (n) => n >= 1, 30_000)).toBeGreaterThanOrEqual(1)
      await acknowledged()
      await settle(500)
      recording = true
      const result = await runWorkspaceCompaction(WS, deps(ws, projector.fleet, { db: recorded, connect: () => recorded.connect() }))
      recording = false
      expect(result.result.skippedReason).toBeUndefined()
      expect(result.result.objectsFolded).toBeGreaterThan(0)
    } finally {
      recording = false
      projector.stop()
      log.restore()
    }
    const tuple = (call: Call) => [call.sql, call.params] as const
    const own = calls.filter((call) => call.compaction)
    // LIVENESS WITNESSES: both keys taken and given back, the settle's writes,
    // and the projection mutex somewhere in the recorded stream (the
    // re-attach's cold build, whose async chain is not the compaction's).
    for (const kind of ['object', 'connection'] as const) {
      const lockKey = overlayRotationLockKey(WS.landscapeId, WS.versionId, kind)
      expect(own.some((call) => call.sql.includes('pg_try_advisory_lock(') && call.params[0] === lockKey)).toBe(true)
      expect(own.some((call) => call.sql.includes('pg_advisory_unlock(') && call.params[0] === lockKey)).toBe(true)
    }
    expect(own.some((call) => call.sql.includes('read_model_ordinary_head_retirements')
      && /INSERT|UPDATE/.test(call.sql))).toBe(true)
    expect(calls.some((call) => call.sql.includes('pg_advisory_xact_lock(')
      && String(call.params[0]).startsWith('read-model-projection:'))).toBe(true)
    expect(projectionLockOrderViolations(own.map(tuple))).toEqual([])
    // THE WINDOW, across connections and whatever the stack says: the cold
    // build of the re-attach asks for the projection mutex from a chain that is
    // not the compaction's (`own` cannot see it), and it is a different
    // connection from the one holding a key (`projectionInboundEdges` cannot see
    // it either). So order the WHOLE recorded stream: from the first
    // `overlay-rotation:` acquisition of the pass to its last hand-back, no
    // statement may ask for the projection mutex.
    const isMutex = (call: Call) => call.sql.includes('pg_advisory_xact_lock(') && String(call.params[0]).startsWith('read-model-projection:')
    const isKeyOp = (call: Call) => call.compaction && (call.sql.includes('pg_try_advisory_lock(') || call.sql.includes('pg_advisory_unlock('))
    const firstKey = calls.findIndex(isKeyOp)
    const lastKey = calls.length - 1 - [...calls].reverse().findIndex(isKeyOp)
    expect(firstKey).toBeGreaterThanOrEqual(0)
    expect(lastKey).toBeGreaterThan(firstKey)
    expect(calls.slice(firstKey, lastKey + 1).filter(isMutex)).toEqual([])
    // …and the re-attach's mutex request DID come, after the last hand-back.
    expect(calls.slice(lastKey + 1).some(isMutex)).toBe(true)
    const byConnection = new Map<number, LockEdgeCall[]>()
    for (const call of calls) {
      if (call.connection === 0) continue
      byConnection.set(call.connection, [...(byConnection.get(call.connection) ?? []), { sql: call.sql, params: call.params }])
    }
    for (const stream of byConnection.values()) expect(projectionInboundEdges(stream)).toEqual([])
    expect(unknownAdvisoryKeys(calls.map((call) => ({ sql: call.sql, params: call.params })))).toEqual([])
  }, 180_000)

  it('G4-16f: a compaction over PARKED sealed products — the projector detached first, the products cleared (no longer sealed), the re-attach cold-builds them resident — serves the latest values, raises no product change, and a cold restart agrees', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const latest = new Map<string, string>([['b', 'B']])
    // A seal of 5: a head of three entities is foldable, two of them fold
    // into a sealed product of six (ids unique per head, unlike
    // `fillAndRotate`'s).
    const sealedConfig: OrdinaryHeadRotationConfig = {
      ...config(2, 2),
      deferral: { quietMs: 0, maxMs: 0 },
      chainFold: { minChain: 2, budget: 2, retainMs: 86_400_000, segmentCeiling: 5, windowEntities: 64 },
    }
    const projector = projectorFleet(ws, 2, { residency, config: sealedConfig })
    const resident = (id: string) => Object.prototype.hasOwnProperty.call(cachedHandles(ws.repo), id)
    const fillUnique = async (tag: string) => {
      const url = currentHead(ws)
      const head = await ws.repo.find<ObjHead>(url as AutomergeUrl)
      let index = 0
      while (A.stats(head.doc() as A.Doc<unknown>).numChanges < THRESHOLD) {
        const id = `${tag}-${index}`
        head.change((d) => { d.objects[id] = { id, name: `${tag}-${index}`, type: 'system' } })
        latest.set(id, `${tag}-${index}`)
        index += 1
      }
      expect(await until(() => currentHead(ws), (now) => now !== url, 45_000)).not.toBe(url)
    }
    await projector.start()
    try {
      const parkedOf = () => log.events('read_model.ordinary_sealed_product_parked').map((line) => docId(String(line.url)))
      for (let i = 0; i < 8 && parkedOf().length < 1; i += 1) {
        await fillUnique(`s${i}`)
        await until(parkedOf, (ids) => ids.length >= 1, 5_000)
      }
      // Witness (RED on the base: nothing is ever parked).
      const [product] = await until(parkedOf, (ids) => ids.length >= 1, 60_000)
      expect(product).toBeDefined()
      expect(await until(async () => { await residency.drain(); return !residency.isLeased(product!) && !resident(product!) },
        (gone) => gone, 15_000)).toBe(true)
      await acknowledged()

      // The compaction detaches the projector, clears what it folds (the
      // parked product among them), and re-attaches with a cold build.
      const first = await runWorkspaceCompaction(WS, deps(ws, projector.fleet))
      expect(first.result.skippedReason).toBeUndefined()
      expect(first.result.objectsFolded).toBeGreaterThan(0)
      expect(first.reattach).toBe('reattached')
      // With residency, the detach's `releaseOwner` EVICTED the ModelMeta
      // handle this test held (nobody else leased it): the compaction and the
      // re-attached projector read a fresh one from storage, and the old one
      // never sees the repoint. Ask the Repo again, as every other reader did.
      ws.meta = await ws.repo.find<Meta>(ws.meta.url as AutomergeUrl)
      await acknowledged()
      // The compaction's own writes to the product, made while the projector
      // was detached, are no "change after attach": nothing degrades.
      await settle(1_000)
      expect(log.events('read_model.ordinary_sealed_product_changed')).toEqual([])
      expect(log.events('read_model.ordinary_fold_product_changed')).toEqual([])
      expect(await degradedSince()).toBeNull()

      // The fold goes on after it, and parks again once a product seals.
      const parkedBefore = parkedOf().length
      for (let i = 0; i < 8 && parkedOf().length <= parkedBefore; i += 1) {
        await fillUnique(`t${i}`)
        await until(parkedOf, (ids) => ids.length > parkedBefore, 5_000)
      }
      expect((await until(parkedOf, (ids) => ids.length > parkedBefore, 60_000)).length).toBeGreaterThan(parkedBefore)

      const expected = [...latest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, name]) => ({ id, name }))
      const byId = (rows: Array<{ id: string; name?: string }>) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      expect(byId(await until(roObjectRows, (rows) => JSON.stringify(byId(rows)) === JSON.stringify(expected), 15_000))).toEqual(expected)
      expect(await degradedSince()).toBeNull()
      await projector.restart()
      await acknowledged()
      expect(byId(await roObjectRows())).toEqual(expected)
      expect(await degradedSince()).toBeNull()
    } finally {
      projector.stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 300_000)
})
