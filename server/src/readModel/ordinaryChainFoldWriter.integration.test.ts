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
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { ensureReadModelSchema } from './schema.js'
import { startReadModelProjector } from './projectorService.js'
import type { OrdinaryHeadRotationConfig } from './ordinaryHeadRotation.js'
import { readOrdinaryHeadRetirement } from './ordinaryHeadForwarding.js'
import { ORDINARY_FOLD_SOURCES_FIELD, readOrdinaryChainFold, recordOrdinaryChainFold } from './ordinaryChainFold.js'
import type { WorkspaceKey } from './projector.js'
import type { PoolClient } from 'pg'
import { acquireOverlayRotationLock, overlayRotationLockKey, releaseOverlayRotationLock } from './overlayRotationLock.js'
import {
  projectionInboundEdges,
  projectionLockOrderViolations,
  unknownAdvisoryKeys,
  type LockEdgeCall,
} from './lockEdgeScan.js'

/**
 * G4-16b phase 4 step 3, END TO END: real rotations by the projector (a low
 * change threshold), then the projector's own chain folds, over the real
 * PostgreSQL storage adapter and schema. Every test carries a witness that
 * the fold ran: its log line, ModelMeta substituted, the rows `folded`.
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-ocfw', versionId: 'v1' }
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

const claims: string[] = []
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
async function start(ws: Workspace, minChain: number, pool: IsolatedSchemaDb['pool'] = db.pool, budget = 8) {
  return startReadModelProjector(
    ws.repo, ws.rootUrl, pool, WS, undefined, 0, undefined,
    undefined, undefined, undefined, config(minChain, budget),
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
const degradedSince = async () => (await db.pool.query<{ degraded_since: unknown }>(
  'SELECT degraded_since FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
  [WS.landscapeId, WS.versionId],
)).rows[0]?.degraded_since ?? null

/** Fill the CURRENT head with `n0..` tagged `tag` until it crosses the
 * threshold, and wait for the projector to rotate it. Returns the new head. */
async function fillAndRotate(ws: Workspace, tag: string): Promise<DocHandle<ObjHead>> {
  const url = currentHead(ws)
  const head = await ws.repo.find<ObjHead>(url as AutomergeUrl)
  let index = 0
  while (A.stats(head.doc() as A.Doc<unknown>).numChanges < THRESHOLD) {
    head.change((d) => { d.objects[`n${index}`] = { id: `n${index}`, name: `${tag}-${index}`, type: 'system' } })
    index += 1
  }
  // Up to 45 s: a rotation refused because a fold holds the shared
  // `overlay-rotation:` key is retried on its backoff (1 s, 5 s, 30 s).
  const next = await until(() => currentHead(ws), (now) => now !== url, 45_000)
  expect(next).not.toBe(url)
  return ws.repo.find<ObjHead>(next as AutomergeUrl)
}

suite('ordinary chain fold, the writer (G4-16b phase 4 step 3) — real storage, projector, PostgreSQL', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'ordinary_chain_fold_writer')
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
    claims.length = 0
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async ({ landscapeId, versionId, documentIds }) => {
      for (const documentId of documentIds) {
        claims.push(documentId)
        await db.pool.query(
          'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [documentId, landscapeId, versionId],
        )
      }
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
  })
  afterEach(() => { restoreRegistration() })

  it('folds as rotation retires: the overlay list stays BOUNDED, products are folded again, no row moves, and a cold restart agrees', async () => {
    const repo = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let stop = await start(ws, 2)
    try {
      const longest: number[] = []
      let head = ws.head
      for (const tag of ['h0', 'h1', 'h2', 'h3', 'h4']) {
        head = await fillAndRotate(ws, tag)
        // Each fold lands before the next rotation can retire another head.
        await until(() => ws.meta.doc()!.editsObjectShardUrls.length, (n) => n <= 3)
        longest.push(ws.meta.doc()!.editsObjectShardUrls.length)
      }
      // At least two folds: a fold yields to a pending rotation, so one may
      // take three heads at once rather than two (measured: [3, 3] over five
      // rotations).
      const folds = await until(() => log.events('read_model.ordinary_chain_folded'), (lines) => lines.length >= 2)
      // Witnesses: folds ran, and a later one folded a PRODUCT.
      expect(folds.length).toBeGreaterThanOrEqual(2)
      const products = new Set(folds.map((line) => line.product as string))
      expect(folds.slice(1).some((line) => (line.sources as string[]).some((id) => products.has(id)))).toBe(true)
      // Bounded: never more than minChain + 1 overlay entries after a fold,
      // where five rotations without a fold leave six.
      expect(Math.max(...longest)).toBeLessThanOrEqual(3)
      const meta = ws.meta.doc()!
      expect(meta.objectShardUrls[0]).toBe(ws.base.url)
      expect(meta.objectShardUrls.slice(1)).toEqual(meta.editsObjectShardUrls)
      expect(meta.editsObjectShardUrls.at(-1)).toBe(meta.editsObjectShardUrl)
      // Every product is claimed, and recorded with its sources folded into it.
      for (const line of folds) {
        expect(claims).toContain(line.product)
        const record = await readOrdinaryChainFold(db.pool, WS, 'object', line.product as string)
        expect(record?.sourceDocumentIds.sort()).toEqual([...(line.sources as string[])].sort())
        for (const source of line.sources as string[]) {
          expect(await readOrdinaryHeadRetirement(db.pool, WS, 'object', source))
            .toMatchObject({ status: 'folded', foldedInto: line.product })
        }
      }
      // Every value is the LATEST one written: h4's (rotated too; the current head is empty).
      const rows = await until(roObjectRows, (r) => r.some((row) => row.name === 'h4-0'))
      expect(rows).toEqual([
        { id: 'b', name: 'B' },
        { id: 'n0', name: 'h4-0' }, { id: 'n1', name: 'h4-1' }, { id: 'n2', name: 'h4-2' },
      ])
      expect(await degradedSince()).toBeNull()
      // EVERY source of every fold was detached by the projector (after its
      // product attached, asynchronously: waited for, exactly).
      const sourceCount = folds.reduce((n, line) => n + (line.sources as string[]).length, 0)
      const detached = await until(() => log.events('read_model.ordinary_fold_source_detached').length,
        (n) => n >= sourceCount)
      expect(detached).toBe(sourceCount)

      // A cold restart over the same storage serves the same rows, healthy.
      stop()
      await settle()
      stop = await start(ws, 2)
      await settle(800)
      expect(await roObjectRows()).toEqual(rows)
      expect(await degradedSince()).toBeNull()
      void head
    } finally {
      stop()
      log.restore()
    }
  }, 300_000)

  it('a fold RECORDED but never published (a crash before its ModelMeta change) is published by the next pass', async () => {
    const repo = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    // A threshold no chain reaches: rotations, no fold.
    let stop = await start(ws, 1_000)
    try {
      const h1 = await fillAndRotate(ws, 'h0')
      const h2 = await fillAndRotate(ws, 'h1')
      void h2
      const sources = [ws.head, h1]
      // Settled: each source's forward has caught up with its live heads.
      for (const source of sources) {
        await until(async () => {
          const row = await readOrdinaryHeadRetirement(db.pool, WS, 'object', source.documentId)
          const heads = [...A.getHeads(source.doc() as A.Doc<unknown>)].sort()
          return JSON.stringify(row?.forwardedHeads ?? row?.retirementHeads) === JSON.stringify(heads)
        }, Boolean)
      }
      stop()
      await settle()
      expect(log.events('read_model.ordinary_chain_folded')).toEqual([])

      // The fold's steps 4 and 6 by hand: the product, then the record.
      const merged = Object.assign({}, ...sources.map((s) => JSON.parse(JSON.stringify(s.doc()!.objects))))
      const product = repo.create({ objects: merged, writeBatchIds: [], [ORDINARY_FOLD_SOURCES_FIELD]: sources.map((s) => s.url) })
      await product.whenReady()
      await repo.flush([product.documentId])
      await claim(product.documentId)
      const client = await db.pool.connect()
      try {
        await client.query('BEGIN')
        await recordOrdinaryChainFold(client, WS, {
          collection: 'object',
          productDocumentId: product.documentId,
          productHeads: A.getHeads(product.doc() as A.Doc<unknown>),
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
      const before = await roObjectRows()

      stop = await start(ws, 1_000)
      const recovered = await until(() => log.events('read_model.ordinary_chain_folded'), (lines) => lines.length > 0)
      expect(recovered).toEqual([expect.objectContaining({ product: product.documentId, recovered: true })])
      const meta = ws.meta.doc()!
      expect(meta.editsObjectShardUrls).toEqual([product.url, meta.editsObjectShardUrl])
      expect(meta.objectShardUrls).toEqual([ws.base.url, product.url, meta.editsObjectShardUrl])
      await until(() => log.events('read_model.ordinary_fold_source_detached').length, (n) => n >= 2)
      expect(await roObjectRows()).toEqual(before)
      expect(await degradedSince()).toBeNull()
    } finally {
      stop()
      log.restore()
    }
  }, 180_000)

  it('LOCK ORDER: the fold never asks for the projection mutex while it holds overlay-rotation (gates A8 and G5, on the real statement stream)', async () => {
    // A new session-lock holder of the `overlay-rotation:` key, like the
    // rotator (`ordinaryHeadRotator.integration.test.ts`, same detectors):
    // A8 over every statement issued while `foldOrdinaryChain` is on the
    // stack, G5 per connection.
    const repo = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    type Call = { connection: number; sql: string; params: readonly unknown[]; fold: boolean }
    const calls: Call[] = []
    let connections = 0
    const record = (connection: number, sql: unknown, params?: unknown[]) => {
      if (typeof sql !== 'string') return
      const limit = Error.stackTraceLimit
      Error.stackTraceLimit = 200
      const stack = new Error().stack ?? ''
      Error.stackTraceLimit = limit
      calls.push({ connection, sql, params: params ?? [], fold: stack.includes('foldOrdinaryChain') })
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
    const stop = await start(ws, 2, recorded)
    try {
      await fillAndRotate(ws, 'h0')
      await fillAndRotate(ws, 'h1')
      expect(await until(() => log.events('read_model.ordinary_chain_folded').length, (n) => n >= 1)).toBeGreaterThanOrEqual(1)
      await settle(300)
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
    const tuple = (call: Call) => [call.sql, call.params] as const
    const foldCalls = calls.filter((call) => call.fold)
    // LIVENESS WITNESSES: the fold's lock, its record, its release, and the
    // projection mutex somewhere in the stream.
    expect(foldCalls.some((call) => call.sql.includes('pg_try_advisory_lock(')
      && String(call.params[0]).startsWith('overlay-rotation:'))).toBe(true)
    expect(foldCalls.some((call) => call.sql.includes('INSERT INTO read_model_ordinary_chain_folds'))).toBe(true)
    expect(foldCalls.some((call) => call.sql.includes('pg_advisory_unlock('))).toBe(true)
    expect(calls.some((call) => call.sql.includes('pg_advisory_xact_lock(')
      && String(call.params[0]).startsWith('read-model-projection:'))).toBe(true)
    // The record runs on the LOCK's client: the connection that inserts it
    // took the lock earlier and had not released it. (Other passes, the one at
    // boot among them, take and release the lock on other connections.)
    const recordAt = foldCalls.findIndex((call) => call.sql.includes('INSERT INTO read_model_ordinary_chain_folds'))
    const recordConnection = foldCalls[recordAt]!.connection
    const own = foldCalls.slice(0, recordAt).filter((call) => call.connection === recordConnection)
    const lockedAt = own.map((call) => call.sql).lastIndexOf(
      own.map((call) => call.sql).filter((sql) => sql.includes('pg_try_advisory_lock(')).at(-1) ?? '\u0001')
    expect(lockedAt).toBeGreaterThanOrEqual(0)
    expect(own.slice(lockedAt).some((call) => call.sql.includes('pg_advisory_unlock('))).toBe(false)
    expect(projectionLockOrderViolations(foldCalls.map(tuple))).toEqual([])
    const byConnection = new Map<number, LockEdgeCall[]>()
    for (const call of calls) {
      if (call.connection === 0) continue
      byConnection.set(call.connection, [...(byConnection.get(call.connection) ?? []), { sql: call.sql, params: call.params }])
    }
    for (const stream of byConnection.values()) expect(projectionInboundEdges(stream)).toEqual([])
    expect(unknownAdvisoryKeys(calls.map((call) => ({ sql: call.sql, params: call.params })))).toEqual([])
  }, 180_000)


  // ---- the requestFold wire (projectorService.ts), from the QA lens ----

  /** Four rotations with no fold (threshold out of reach), each head settled,
   * then the projector stopped: a chain of four retired heads waiting. */
  async function chainOfFour(ws: Workspace) {
    const stop = await start(ws, 1_000)
    try {
      const heads = [ws.head]
      for (const tag of ['h0', 'h1', 'h2', 'h3']) heads.push(await fillAndRotate(ws, tag))
      for (const source of heads.slice(0, 4)) {
        await until(async () => {
          const row = await readOrdinaryHeadRetirement(db.pool, WS, 'object', source.documentId)
          const live = [...A.getHeads(source.doc() as A.Doc<unknown>)].sort()
          return JSON.stringify(row?.forwardedHeads ?? row?.retirementHeads) === JSON.stringify(live)
        }, Boolean)
      }
      expect(ws.meta.doc()!.editsObjectShardUrls).toHaveLength(5)
    } finally {
      stop()
    }
    await settle()
  }

  // Q5 (the boot kick) and Q1 (`again`): no rotation happens after the
  // restart, so only the attach-time request can start a fold, and only the
  // re-request after a landed fold can take a budget-2 chain of four down to one.
  it('a chain already long at ATTACH folds without a rotation, a budget at a time, down to one product', async () => {
    const ws = await workspace(storageRepo())
    await chainOfFour(ws)
    const log = logLines()
    const stop = await start(ws, 2, db.pool, 2)
    try {
      const overlay = await until(() => ws.meta.doc()!.editsObjectShardUrls.length, (n) => n === 2, 20_000)
      // The fold logs AFTER the ModelMeta flush, so its line can trail the list.
      expect((await until(() => log.events('read_model.ordinary_chain_folded'), (l) => l.length >= 3)).length)
        .toBeGreaterThanOrEqual(3)
      expect(overlay).toBe(2)
    } finally {
      stop()
      log.restore()
    }
  }, 180_000)

  // Q2: a refused lock is retried (1 s backoff), not left for the next rotation.
  it('a fold refused by a held overlay-rotation key is RETRIED once the key is free', async () => {
    const ws = await workspace(storageRepo())
    await chainOfFour(ws)
    const log = logLines()
    const holder = await db.pool.connect()
    const lockKey = overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object')
    let state = await acquireOverlayRotationLock(holder as unknown as PoolClient, lockKey)
    expect(state).toBe('acquired')
    const stop = await start(ws, 2)
    try {
      await settle(600)
      // Witness that the boot kick ran and was refused.
      expect(log.events('read_model.ordinary_chain_folded')).toEqual([])
      expect(ws.meta.doc()!.editsObjectShardUrls).toHaveLength(5)
      await releaseOverlayRotationLock(holder as unknown as PoolClient, lockKey, state)
      state = 'refused' // released: nothing left to give back
      const folds = await until(() => log.events('read_model.ordinary_chain_folded'), (l) => l.length > 0, 15_000)
      expect(folds.length).toBeGreaterThan(0)
    } finally {
      stop()
      log.restore()
      if (state === 'acquired') await releaseOverlayRotationLock(holder as unknown as PoolClient, lockKey, state)
    }
  }, 180_000)

  // Q7: the fold is gated on `headRotation.rotates` (on AND allow-listed),
  // not only on the config's `chainFold`.
  it('a workspace rotation does not rotate (not allow-listed) never folds, even with chainFold configured', async () => {
    const ws = await workspace(storageRepo())
    await chainOfFour(ws)
    const log = logLines()
    const stop = await startReadModelProjector(
      ws.repo, ws.rootUrl, db.pool, WS, undefined, 0, undefined, undefined, undefined, undefined,
      { ...config(2), allowlist: new Set(['someone-else/v1']) },
    )
    try {
      await settle(2_500)
      expect(log.events('read_model.ordinary_chain_folded')).toEqual([])
      expect(ws.meta.doc()!.editsObjectShardUrls).toHaveLength(5)
    } finally {
      stop()
      log.restore()
    }
    // Control: the same chain, allow-listed, folds at attach.
    const log2 = logLines()
    const stop2 = await start(ws, 2)
    try {
      expect((await until(() => log2.events('read_model.ordinary_chain_folded'), (l) => l.length > 0)).length).toBeGreaterThan(0)
    } finally {
      stop2()
      log2.restore()
    }
  }, 180_000)

  // Q8: a fold that FAILS (here: its record's INSERT, once) is retried.
  it('a fold that throws is logged and RETRIED, and then lands', async () => {
    const ws = await workspace(storageRepo())
    await chainOfFour(ws)
    const log = logLines()
    let armed = true
    const failing = new Proxy(db.pool, {
      get(target, property) {
        if (property === 'connect') {
          return async () => {
            const client = await target.connect()
            return new Proxy(client, {
              get(subject, name) {
                if (name === 'query') {
                  return (sql: unknown, values?: unknown[]) => {
                    if (armed && typeof sql === 'string' && sql.includes('INSERT INTO read_model_ordinary_chain_folds')) {
                      armed = false
                      return Promise.reject(new Error('injected record failure'))
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
    const stop = await start(ws, 2, failing)
    try {
      const failed = await until(() => log.events('read_model.ordinary_chain_fold_failed'), (l) => l.length > 0)
      expect(failed[0]).toMatchObject({ kind: 'object', error: 'injected record failure' })
      const folds = await until(() => log.events('read_model.ordinary_chain_folded'), (l) => l.length > 0, 15_000)
      expect(folds.length).toBeGreaterThan(0)
    } finally {
      stop()
      log.restore()
    }
  }, 180_000)

  // Q4: 'sources-not-settled' is retried (a forward is in flight), unlike the
  // other skips. Both retired heads get a late write while the projector is
  // down, so the attach-time fold finds nothing settled.
  it('a fold skipped because its sources are not settled yet is retried until they are', async () => {
    const ws = await workspace(storageRepo())
    const stop0 = await start(ws, 1_000)
    let h1: DocHandle<ObjHead>
    try {
      h1 = await fillAndRotate(ws, 'h0')
      await fillAndRotate(ws, 'h1')
    } finally {
      stop0()
    }
    await settle()
    for (const head of [ws.head, h1!]) head.change((d) => { d.objects.late = { id: 'late', name: 'late', type: 'system' } })
    const log = logLines()
    const stop = await start(ws, 2)
    try {
      const folds = await until(() => log.events('read_model.ordinary_chain_folded'), (l) => l.length > 0, 15_000)
      expect(folds.length).toBeGreaterThan(0)
    } finally {
      stop()
      log.restore()
    }
  }, 180_000)

  // ---- step 4: late writes to a folded head (ordinaryFoldedArrivals.ts) ----

  const watermarkOf = async (documentId: string) => (await db.pool.query<{ w: string | null }>(
    `SELECT arrival_watermark::text AS w FROM read_model_ordinary_head_retirements
     WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
    [WS.landscapeId, WS.versionId, documentId],
  )).rows[0]?.w ?? null
  const roObject = async (id: string) => (await db.pool.query<{ data: Record<string, unknown> }>(
    'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
    [WS.landscapeId, WS.versionId, id],
  )).rows[0]?.data

  /** Two rotations, then the fold of both retired heads: returns the folded
   * heads, once the projector has detached them. An offline copy of the
   * OLDEST is taken before anything rotates. */
  async function foldTwo(ws: Workspace, log: ReturnType<typeof logLines>) {
    const offline = A.clone(ws.head.doc() as A.Doc<ObjHead>)
    const h1 = await fillAndRotate(ws, 'h0')
    await fillAndRotate(ws, 'h1')
    await until(() => log.events('read_model.ordinary_fold_source_detached').length, (n) => n >= 2, 30_000)
    expect(log.events('read_model.ordinary_fold_source_detached').length).toBeGreaterThanOrEqual(2)
    return { folded: [ws.head, h1], offline }
  }

  /** The offline client comes back: its write lands in the folded head's
   * document and in storage (a fresh arrival), with no watcher on it. */
  async function lateWrite(ws: Workspace, head: DocHandle<ObjHead>, offline: A.Doc<ObjHead>, name: string) {
    const edited = A.change(A.clone(offline), (d) => { d.objects.late = { id: 'late', name, type: 'system' } })
    head.update((doc) => A.merge(doc, edited))
    await ws.repo.flush([head.documentId])
  }

  it('a late write to a FOLDED, detached head is found in storage, forwarded, projected, and its watermark advances', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const log = logLines()
    const stop = await start(ws, 2)
    try {
      const { folded, offline } = await foldTwo(ws, log)
      // The first poll after the detach loads each folded head once and,
      // with nothing to carry, sets its watermark.
      const first = await until(() => watermarkOf(folded[0]!.documentId), (w) => w !== null)
      expect(first).not.toBeNull()
      expect(await roObject('late')).toBeUndefined()

      await lateWrite(ws, folded[0]! as DocHandle<ObjHead>, offline, 'arrived')
      expect((await until(() => roObject('late'), (row) => row?.name === 'arrived', 15_000))?.name).toBe('arrived')
      // Carried into the CURRENT head, not projected from the folded one.
      const current = await ws.repo.find<ObjHead>(currentHead(ws) as AutomergeUrl)
      expect(current.doc()!.objects.late).toMatchObject({ name: 'arrived' })
      expect(log.events('read_model.ordinary_head_forwarded')
        .some((line) => line.retired === folded[0]!.documentId)).toBe(true)
      const after = await until(() => watermarkOf(folded[0]!.documentId), (w) => w !== null && BigInt(w) > BigInt(first!))
      expect(BigInt(after!)).toBeGreaterThan(BigInt(first!))
      expect(await degradedSince()).toBeNull()
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  it('after a COLD restart the folded heads are polled too: a late write still reaches its row', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const log = logLines()
    let stop = await start(ws, 2)
    try {
      const { folded, offline } = await foldTwo(ws, log)
      await until(() => watermarkOf(folded[0]!.documentId), (w) => w !== null)
      stop()
      await settle()
      // Written while no projector runs; the restarted one never attaches it.
      await lateWrite(ws, folded[0]! as DocHandle<ObjHead>, offline, 'after-restart')
      stop = await start(ws, 2)
      expect((await until(() => roObject('late'), (row) => row?.name === 'after-restart', 15_000))?.name)
        .toBe('after-restart')
      expect(await degradedSince()).toBeNull()
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  it('with the poll DISABLED (0) a late write to a folded head is not projected: the poll is what carries it', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '0'
    const ws = await workspace(storageRepo())
    const log = logLines()
    const stop = await start(ws, 2)
    try {
      const { folded, offline } = await foldTwo(ws, log)
      await lateWrite(ws, folded[0]! as DocHandle<ObjHead>, offline, 'unseen')
      await settle(1_500)
      expect(await roObject('late')).toBeUndefined()
      expect(await watermarkOf(folded[0]!.documentId)).toBeNull()
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  // ---- step 4: the poll's own guards (from the QA lens) ----

  /** The test pool with a hook in front of `query` (connect() and the rest
   * pass through, so `isPool` and transactions still work). */
  function hookedPool(hook: (sql: string, params: unknown[] | undefined) => Promise<void> | void) {
    return new Proxy(db.pool, {
      get(target, prop) {
        if (prop === 'query') {
          return async (...args: unknown[]) => {
            const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '')
            await hook(text, args[1] as unknown[] | undefined)
            return (target.query as (...a: unknown[]) => unknown)(...args)
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as IsolatedSchemaDb['pool']
  }
  const isPollQuery = (sql: string) => sql.includes('CROSS JOIN LATERAL') && sql.includes('arrival_watermark')
  /** `readOrdinaryHeadRetirement`, the forward's fresh row read, for ONE head. */
  const isFreshRowRead = (sql: string, params: unknown[] | undefined, documentId: string) =>
    sql.includes('SELECT collection, document_id, retirement_heads') && sql.includes('AND document_id = $4')
    && params?.[3] === documentId

  it('QA4 a forward that FAILS leaves the watermark, and the next pass carries the write', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    let failFor: string | null = null
    let failures = 0
    const pool = hookedPool((sql, params) => {
      if (failFor && isFreshRowRead(sql, params, failFor)) {
        failFor = null
        failures += 1
        throw new Error('qa4: injected transient failure')
      }
    })
    const ws = await workspace(storageRepo())
    const log = logLines()
    const stop = await start(ws, 2, pool)
    try {
      const { folded, offline } = await foldTwo(ws, log)
      const first = await until(() => watermarkOf(folded[0]!.documentId), (w) => w !== null)
      expect(first).not.toBeNull()
      failFor = folded[0]!.documentId
      await lateWrite(ws, folded[0]! as DocHandle<ObjHead>, offline, 'retried')
      expect((await until(() => roObject('late'), (row) => row?.name === 'retried', 15_000))?.name).toBe('retried')
      // Witness: the failure was injected, on the poll's path.
      expect(failures).toBe(1)
      expect(log.events('read_model.ordinary_fold_arrival_failed')
        .some((line) => line.documentId === folded[0]!.documentId)).toBe(true)
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  it('QA4 a head whose forward DEGRADES (unknown heads) keeps its watermark', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const log = logLines()
    const stop = await start(ws, 2)
    try {
      const { folded, offline } = await foldTwo(ws, log)
      const id = folded[0]!.documentId
      const first = await until(() => watermarkOf(id), (w) => w !== null)
      expect(first).not.toBeNull()
      await db.pool.query(
        `UPDATE read_model_ordinary_head_retirements SET forwarded_heads = ARRAY[$3]::text[]
          WHERE landscape_id = $1 AND version_id = $2 AND document_id = $4`,
        [WS.landscapeId, WS.versionId, 'ab'.repeat(32), id],
      )
      await lateWrite(ws, folded[0]! as DocHandle<ObjHead>, offline, 'unknown')
      // Witness: the poll reached the forward and it degraded.
      expect(await until(() => degradedSince(), (since) => since !== null, 15_000)).not.toBeNull()
      expect(log.events('read_model.ordinary_head_forward_refused').some((line) => line.retired === id)).toBe(true)
      await settle(1_000)
      expect(await watermarkOf(id)).toBe(first)
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  it('QA4 one head failing does not stop the others in the same pass', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    let failFor: string | null = null
    const pool = hookedPool((sql, params) => {
      if (failFor && isFreshRowRead(sql, params, failFor)) throw new Error('qa4: injected persistent failure')
    })
    const ws = await workspace(storageRepo())
    const log = logLines()
    const stop = await start(ws, 2, pool)
    try {
      const { folded, offline } = await foldTwo(ws, log)
      await until(() => watermarkOf(folded[0]!.documentId), (w) => w !== null)
      await until(() => watermarkOf(folded[1]!.documentId), (w) => w !== null)
      failFor = folded[1]!.documentId
      // folded[1] first: the LOWER arrival, so it comes first in the pass.
      ;(folded[1] as DocHandle<ObjHead>).change((d) => { d.objects.late2 = { id: 'late2', name: 'stuck', type: 'system' } })
      await ws.repo.flush([folded[1]!.documentId])
      await lateWrite(ws, folded[0]! as DocHandle<ObjHead>, offline, 'not-blocked')
      expect((await until(() => roObject('late'), (row) => row?.name === 'not-blocked', 15_000))?.name).toBe('not-blocked')
      expect(log.events('read_model.ordinary_fold_arrival_failed')
        .some((line) => line.documentId === folded[1]!.documentId)).toBe(true)
      expect(await roObject('late2')).toBeUndefined()
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  it('QA4 the poll is single-flight: a slow pass is never overlapped by the next tick', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '100'
    let slow = false
    let inFlight = 0
    let maxInFlight = 0
    let passes = 0
    const pool = hookedPool(async (sql) => {
      if (!slow || !isPollQuery(sql)) return
      passes += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try { await settle(700) } finally { inFlight -= 1 }
    })
    const ws = await workspace(storageRepo())
    const log = logLines()
    const stop = await start(ws, 2, pool)
    try {
      const { folded } = await foldTwo(ws, log)
      await until(() => watermarkOf(folded[0]!.documentId), (w) => w !== null)
      slow = true
      await settle(2_000)
      expect(passes).toBeGreaterThanOrEqual(2) // witness: the poll kept ticking
      expect(maxInFlight).toBe(1)
    } finally {
      slow = false
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  it('QA4 a pass that outlives stop() does not forward or advance anything', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    let gate: { entered: () => void } | null = null
    const pool = hookedPool(async (sql) => {
      if (!gate || !isPollQuery(sql)) return
      const current = gate
      gate = null
      current.entered()
      await settle(800)
    })
    const ws = await workspace(storageRepo())
    const log = logLines()
    const stop = await start(ws, 2, pool)
    let stopped = false
    try {
      const { folded, offline } = await foldTwo(ws, log)
      const first = await until(() => watermarkOf(folded[0]!.documentId), (w) => w !== null)
      const entered = new Promise<void>((resolve) => { gate = { entered: resolve } })
      await lateWrite(ws, folded[0]! as DocHandle<ObjHead>, offline, 'after-stop')
      await entered
      stop()
      stopped = true
      await settle(1_500)
      expect(await watermarkOf(folded[0]!.documentId)).toBe(first)
      expect(await roObject('late')).toBeUndefined()
    } finally {
      if (!stopped) stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  it('QA5 with a 10-min period, the detach and the boot each run a pass NOW', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '600000'
    const ws = await workspace(storageRepo())
    const log = logLines()
    let stop = await start(ws, 2)
    try {
      const { folded, offline } = await foldTwo(ws, log)
      expect(await until(() => watermarkOf(folded[0]!.documentId), (w) => w !== null)).not.toBeNull()
      stop()
      await settle()
      await lateWrite(ws, folded[0]! as DocHandle<ObjHead>, offline, 'boot-pass')
      stop = await start(ws, 2)
      expect((await until(() => roObject('late'), (row) => row?.name === 'boot-pass', 15_000))?.name).toBe('boot-pass')
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  it('QA5 stop() clears the poll interval', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '237'
    const ours: unknown[] = []
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const ws = await workspace(storageRepo())
    const log = logLines()
    const stop = await start(ws, 2)
    try {
      const { folded } = await foldTwo(ws, log)
      await until(() => watermarkOf(folded[0]!.documentId), (w) => w !== null)
      setSpy.mock.calls.forEach((call, index) => { if (call[1] === 237) ours.push(setSpy.mock.results[index]!.value) })
      expect(ours).toHaveLength(1) // witness: exactly one poll timer, ours
      stop()
      expect(clearSpy.mock.calls.some((call) => call[0] === ours[0])).toBe(true)
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  it('QA4 a head loaded only by the poll gives its residency lease back', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const held = new Map<string, number>()
    const residency = {
      acquire: (handle: DocHandle<unknown>) => { held.set(handle.documentId, (held.get(handle.documentId) ?? 0) + 1) },
      release: (documentId: string) => {
        const n = held.get(documentId) ?? 0
        if (n > 0) held.set(documentId, n - 1)
        return n > 0
      },
      releaseOwner: () => { held.clear() },
      onBeforeEvict: () => () => {},
    }
    const ws = await workspace(storageRepo())
    const log = logLines()
    const stop = await startReadModelProjector(
      ws.repo, ws.rootUrl, db.pool, WS, residency as never, 0, undefined,
      undefined, undefined, undefined, config(2),
    )
    try {
      const { folded, offline } = await foldTwo(ws, log)
      const id = folded[0]!.documentId
      const first = await until(() => watermarkOf(id), (w) => w !== null)
      await lateWrite(ws, folded[0]! as DocHandle<ObjHead>, offline, 'leased')
      await until(() => watermarkOf(id), (w) => w !== null && BigInt(w) > BigInt(first!), 15_000)
      // The forward's projection of the CURRENT head lands after the advance.
      expect((await until(() => roObject('late'), (row) => row?.name === 'leased', 15_000))?.name).toBe('leased')
      expect(held.get(id) ?? 0).toBe(0)
      expect(held.get(folded[1]!.documentId) ?? 0).toBe(0)
      // Control: the current head is leased (the fake is wired at all).
      expect(held.get(docId(currentHead(ws))) ?? 0).toBeGreaterThan(0)
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  it('ownership FLICKERING during the forward (not-owner): the watermark does not move past the write, which is carried next pass', async () => {
    // The lens finding behind the fix: `forwardInsteadOfProjecting` answers
    // true for `not-owner`. A poll that advanced on that answer (ownership
    // back by the time it commits) hid the write from every later poll.
    // Ownership is lost for exactly ONE check — the forward's own, right after
    // its fresh row read — and is back for the advance.
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    let dropNext = false
    let dropped = 0
    const stillOwned = () => {
      if (!dropNext) return true
      dropNext = false
      dropped += 1
      return false
    }
    let dropFor: string | null = null
    const pool = hookedPool((sql, params) => {
      if (dropFor && isFreshRowRead(sql, params, dropFor)) { dropFor = null; dropNext = true }
    })
    const ws = await workspace(storageRepo())
    const log = logLines()
    const stop = await startReadModelProjector(
      ws.repo, ws.rootUrl, pool, WS, undefined, 0, undefined,
      stillOwned, undefined, undefined, config(2),
    )
    try {
      const { folded, offline } = await foldTwo(ws, log)
      const id = folded[0]!.documentId
      const first = await until(() => watermarkOf(id), (w) => w !== null)
      dropFor = id
      await lateWrite(ws, folded[0]! as DocHandle<ObjHead>, offline, 'carried')
      // Witness: the drop happened on the poll's forward.
      await until(() => dropped, (n) => n > 0, 15_000)
      expect(dropped).toBe(1)
      // Advancing on not-owner would have moved the watermark past this
      // write, and no later poll would ever have carried it.
      expect((await until(() => roObject('late'), (row) => row?.name === 'carried', 20_000))?.name).toBe('carried')
      // Waited for, not read once: the advance commits after the forward it
      // follows, so the row can be visible first (measured 26 ms behind it in
      // 1 run of 10, once the rotation's quiet window moved the timing).
      const advanced = await until(() => watermarkOf(id), (w) => BigInt(w!) > BigInt(first!), 20_000)
      expect(BigInt(advanced!)).toBeGreaterThan(BigInt(first!))
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  // ---- QA lens (bench fold arm): kill tests ----
  // The two bench lines the load gate reads (verify-sync-cell-load-soak.mjs,
  // summarizeOrdinaryChainFoldEvents): one per fold pass, and one poll-cost
  // summary every 60 folded-arrival polls.
  it('QA bench: each fold pass logs ordinary_chain_fold_pass with its outcome, duration and the chain it leaves', async () => {
    const testStartedAt = Date.now()
    const ws = await workspace(storageRepo())
    const log = logLines()
    const stop = await start(ws, 2)
    try {
      await foldTwo(ws, log)
      const passes = await until(() => log.events('read_model.ordinary_chain_fold_pass'),
        (lines) => lines.some((line) => line.outcome === 'folded' && line.kind === 'object'), 30_000)
      for (const line of passes) {
        expect(line.workspace).toBe(LISTED)
        expect(['object', 'connection']).toContain(line.kind)
        expect(Number.isInteger(line.passMs) && (line.passMs as number) >= 0).toBe(true)
        expect(Number.isInteger(line.chain) && (line.chain as number) >= 1).toBe(true)
        expect(Number.isInteger(line.at)).toBe(true)
        expect(Number.isInteger(line.watched) && Number.isInteger(line.overlay)).toBe(true)
      }
      // Each kind reports ITS OWN chain: connections never rotate here, so
      // every connection pass names the connection list, and the object
      // passes name a longer one.
      const meta = ws.meta.doc()!
      const ofKind = (kind: string) => passes.filter((line) => line.kind === kind)
      expect(ofKind('connection').length).toBeGreaterThan(0)
      for (const line of ofKind('connection')) expect(line.chain).toBe(meta.connectionShardUrls.length)
      expect(ofKind('object').every((line) => (line.chain as number) > meta.connectionShardUrls.length)).toBe(true)
      // The writer's hold, timestamped: without `at` the summary cannot place
      // it in a quarter (every quarter read null on the PC, 2026-11-03).
      const held = log.events('read_model.ordinary_chain_fold_lock_held')
      expect(held.length).toBeGreaterThan(0)
      const readAt = Date.now()
      for (const line of held) {
        expect(Number.isInteger(line.at) && Number.isInteger(line.heldMs) && (line.heldMs as number) >= 0).toBe(true)
        // Taken at the release, within this test: the hold began at `at - heldMs`.
        expect(line.at as number).toBeLessThanOrEqual(readAt)
        expect((line.at as number) - (line.heldMs as number)).toBeGreaterThanOrEqual(testStartedAt)
      }
    } finally {
      stop()
      log.restore()
    }
  }, 180_000)

  // Read from the projector's in-memory `model`, `chain` named the list
  // before the fold (measured [folded chain 4, skipped chain 4] with ModelMeta
  // at 3); it is ModelMeta's now, the list clients load.
  it('QA bench: the last fold pass names the chain ModelMeta holds after the fold', async () => {
    const ws = await workspace(storageRepo())
    const log = logLines()
    const stop = await start(ws, 2)
    try {
      await foldTwo(ws, log)
      await until(() => log.events('read_model.ordinary_chain_fold_pass'),
        (lines) => lines.some((line) => line.outcome === 'folded' && line.kind === 'object'), 30_000)
      await settle(1_000)
      const last = log.events('read_model.ordinary_chain_fold_pass').filter((line) => line.kind === 'object').at(-1)!
      expect(last.chain).toBe(ws.meta.doc()!.objectShardUrls.length)
      // The overlay list is the chain the bench summarizes: the fold shortens it.
      expect(last.overlay).toBe(ws.meta.doc()!.editsObjectShardUrls!.length)
    } finally {
      stop()
      log.restore()
    }
  }, 180_000)

  it('QA bench: every 60 folded-arrival polls log one ordinary_fold_arrival_poll_summary, then the counters reset', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '20'
    const ws = await workspace(storageRepo())
    const log = logLines()
    const stop = await start(ws, 2)
    try {
      await foldTwo(ws, log)
      const summaries = await until(() => log.events('read_model.ordinary_fold_arrival_poll_summary'),
        (lines) => lines.length >= 2, 60_000)
      expect(summaries.length).toBeGreaterThanOrEqual(2) // `until` returns the last value on timeout
      for (const line of summaries.slice(0, 2)) {
        expect(line.workspace).toBe(LISTED)
        expect(line.polls).toBe(60)
        expect(typeof line.totalMs === 'number' && typeof line.maxMs === 'number' && Number.isInteger(line.at)).toBe(true)
        expect(line.maxMs as number).toBeLessThanOrEqual(line.totalMs as number)
        expect(line.loaded as number).toBeLessThanOrEqual(line.rows as number)
      }
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)
})
