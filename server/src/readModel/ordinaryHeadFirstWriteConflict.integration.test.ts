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
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { ensureReadModelSchema } from './schema.js'
import { startReadModelProjector } from './projectorService.js'
import type { OrdinaryHeadRotationConfig } from './ordinaryHeadRotation.js'
import type { WorkspaceKey } from './projector.js'
import {
  collectAutomergeEntityConflicts,
  mergeConcurrentAutomergeEntity,
  wholeEntityConflictIds,
} from './overlayHistoryProtocol.js'
import { overlayEntityBases } from './overlayHistoryStore.js'

/**
 * G4-16g, step 1 — the WITNESS for known limit 1 of
 * `docs/read-model-projector-health.md` ("the first write of an entity into a
 * fresh head is a whole-entity put").
 *
 * The claim under test: right after a REAL ordinary rotation, two ONLINE
 * clients edit DIFFERENT fields of an entity X that only an older segment
 * serves. Each one's first write into the fresh head is the whole entity
 * (`bridge.ts`, `writeEditsShards`: `if (s.objects[id]) reconcile(…) else
 * s.objects[id] = clean`), so the two puts are a `$` conflict at key X, and the
 * heal (`overlayConflictHealing.ts` → `mergeConcurrentAutomergeEntity`) was
 * suspected of merging them against a base that is not their common ancestor.
 *
 * What is real here: PostgreSQL storage, the ordinary projector with
 * `AM_ORDINARY_HEAD_ROTATION=on`, the rotation (the projector's own, triggered
 * by the head crossing its change threshold), the heal, `ro_*`, a cold
 * rebuild from a second Repo.
 *
 * What is simulated, and why it is faithful: the two clients. Each is an
 * Automerge fork of the fresh head with its OWN actor, taken after the repoint
 * (so both depend on the same heads: concurrent), whose one change is exactly
 * the bridge's branch for an id the head does not hold — `s.objects[id] =
 * clean`, `clean` being the whole entity as the tab knows it (the served value
 * plus its edit) — plus its `writeBatchIds` push. Merging the fork into the
 * server's handle delivers the same changes a sync connection would. The
 * bridge itself cannot run in this package (browser stores, IndexedDB); its
 * branch is reproduced, not imported, and `bridgeOverlayRepoint.test.ts`
 * pins that the post-repoint write lands in the fresh head.
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-ohfw', versionId: 'v1' }
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

const X0: Entity = { id: 'x', name: 'X', description: 'd0', type: 'system' }

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000): Promise<T> {
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
  const adapter = new PostgresStorageAdapter({ db: db.pool })
  return new Repo({ storage: adapter, network: [], saveDebounceRate: 60_000 })
}

interface Workspace {
  repo: Repo
  rootUrl: string
  meta: DocHandle<Meta>
  head: DocHandle<ObjHead>
}

async function workspace(repo: Repo): Promise<Workspace> {
  const base = repo.create<{ objects: Record<string, Entity> }>({ objects: { b: { id: 'b', name: 'B', type: 'system' } } })
  // X lives in the CURRENT head before the rotation: after it, only the
  // retired segment serves X, and the fresh head does not hold it.
  const head = repo.create<ObjHead>({ objects: { x: { ...X0 } }, writeBatchIds: [] })
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
  for (const h of handles) {
    await db.pool.query(
      'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [String(h.documentId), WS.landscapeId, WS.versionId],
    )
  }
  return { repo, rootUrl: root.url, meta, head }
}

let restoreRegistration: () => void = () => {}

function on(maxChanges: number): OrdinaryHeadRotationConfig {
  return { mode: 'on', allowlist: new Set([LISTED]), maxActors: 1_000_000, maxChanges }
}

async function start(ws: Workspace, config: OrdinaryHeadRotationConfig) {
  return startReadModelProjector(
    ws.repo, ws.rootUrl, db.pool, WS, undefined, 0, undefined,
    undefined, undefined, undefined, config,
  )
}

function quietLogs() {
  const spies = [
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
  ]
  return () => { for (const spy of spies) spy.mockRestore() }
}

function changeHeadTo(head: DocHandle<ObjHead>, target: number) {
  let index = 0
  while (A.stats(head.doc() as A.Doc<unknown>).numChanges < target) {
    head.change((d) => { d.objects[`n${index}`] = { id: `n${index}`, name: `N${index}`, type: 'system' } })
    index += 1
  }
}

const roObject = async (id: string) => (await db.pool.query<{ data: Record<string, unknown> }>(
  'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
  [WS.landscapeId, WS.versionId, id],
)).rows[0]?.data
const roObjectRows = async () => (await db.pool.query<{ id: string; data: unknown }>(
  'SELECT id, data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id',
  [WS.landscapeId, WS.versionId],
)).rows
const conflictRows = async () => (await db.pool.query(
  'SELECT entity_id, conflict_paths FROM read_model_overlay_conflicts WHERE landscape_id = $1 AND version_id = $2',
  [WS.landscapeId, WS.versionId],
)).rows
const currentHead = (ws: Workspace) => ws.meta.doc().editsObjectShardUrl

/** An ONLINE tab, at the instant it first writes X into the fresh head: a fork
 * with its own actor, whose one change is the bridge's branch for an id the
 * head does not hold. */
function onlineTab<T extends ObjHead>(handle: DocHandle<T>, actor: string) {
  let fork = A.clone(handle.doc() as A.Doc<T>, { actor })
  return {
    writeAsBridge(entity: Entity, batchId: string) {
      fork = A.change(fork, (s) => {
        if (!s.writeBatchIds) s.writeBatchIds = []
        s.writeBatchIds.push(batchId)
        if (!s.objects) s.objects = {}
        // bridge.ts `writeEditsShards`: `if (s.objects[id]) reconcile(...)
        // else s.objects[id] = clean`. The fresh head does not hold X.
        expect(s.objects[entity.id], 'premise: the fresh head does not hold X').toBeUndefined()
        s.objects[entity.id] = { ...entity }
      })
    },
    fork: () => fork,
    deliver() { handle.update((doc) => A.merge(doc, fork)) },
  }
}

type Order = 'together' | 'a-projected-first'

interface Outcome {
  preHealConflictIds: string[]
  ro: Record<string, unknown> | undefined
  doc: Entity | undefined
  docConflictIdsAfter: string[]
  base: { existed: boolean; data: Record<string, unknown> | undefined } | undefined
  /** What the heal computes as the same-field conflict signal, recomputed
   * from the base row the real projector captured. The ordinary projector
   * keeps no ledger (`recordConflicts` is the static plane's), so this is the
   * only place the signal exists on this path. */
  signalledPaths: string[]
  roAfterHeal: Array<{ id: string; data: unknown }>
  roCold: Array<{ id: string; data: unknown }>
  ledger: unknown[]
}

async function runScenario(order: Order, editA: Partial<Entity>, editB: Partial<Entity>, expectRo: (x: Record<string, unknown> | undefined) => boolean): Promise<Outcome> {
  const repo = storageRepo()
  const repos = [repo]
  const ws = await workspace(repo)
  const restoreLogs = quietLogs()
  const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 2
  let stop = await start(ws, on(threshold))
  try {
    // Premise: X is published from the head that will be retired.
    expect(await until(() => roObject('x'), (x) => x?.name === 'X')).toMatchObject(X0)
    changeHeadTo(ws.head, threshold)
    const childUrl = await until(() => currentHead(ws), (url) => url !== ws.head.url)
    // Witness that a REAL rotation ran.
    expect(childUrl, 'the projector must have rotated the head').not.toBe(ws.head.url)
    const child = await repo.find<ObjHead>(childUrl as never)
    await settle(300)
    expect(child.doc().objects.x, 'premise: X is absent from the fresh head').toBeUndefined()
    // Both tabs see X as the read model serves it (the retired segment).
    const served = (await roObject('x')) as Entity
    expect(served).toMatchObject(X0)

    const a = onlineTab(child, 'aa'.repeat(16))
    const b = onlineTab(child, 'bb'.repeat(16))
    const valueA = { ...served, ...editA }
    const valueB = { ...served, ...editB }
    a.writeAsBridge(valueA, 'batch-a')
    b.writeAsBridge(valueB, 'batch-b')

    let current: Entity | undefined
    if (order === 'together') {
      // Both tabs' changes reach the server in ONE update: the projector's
      // first sample of X in the fresh head is already the `$`.
      child.update((doc) => A.merge(A.merge(doc, a.fork()), b.fork()))
      current = undefined
    } else {
      a.deliver()
      // A's put alone is projected (no conflict yet): ro_* carries it.
      expect(await until(() => roObject('x'), (x) => JSON.stringify(x) === JSON.stringify(valueA)))
        .toEqual(valueA)
      current = valueA
      b.deliver()
    }
    // Synchronous, before any projector await: the `$` conflict exists.
    const conflicts = collectAutomergeEntityConflicts(child.doc().objects as Record<string, unknown>)
    const preHealConflictIds = wholeEntityConflictIds(conflicts)
    const selected = child.doc().objects.x as Entity

    const ro = await until(() => roObject('x'), expectRo)
    const docConflictIdsAfter = await until(
      () => wholeEntityConflictIds(collectAutomergeEntityConflicts(child.doc().objects as Record<string, unknown>)),
      (ids) => ids.length === 0,
    )
    await settle(400)
    const bases = await overlayEntityBases(db.pool, WS, 'object', String(child.documentId), ['x'])
    const base = bases.get('x')
    const merged = mergeConcurrentAutomergeEntity(
      base?.data as Entity | undefined, current ?? (base?.data as Entity | undefined), selected,
      conflicts.get('x') ?? {},
    )
    const roAfterHeal = await roObjectRows()
    const ledger = await conflictRows()

    // Cold rebuild: a second process over the same storage, ro_objects empty.
    await repo.flush()
    stop()
    const repo2 = storageRepo()
    repos.push(repo2)
    await db.pool.query('TRUNCATE ro_objects')
    stop = await start({ ...ws, repo: repo2 }, on(threshold))
    const roCold = await until(roObjectRows, (rows) => JSON.stringify(rows) === JSON.stringify(roAfterHeal))
    return {
      preHealConflictIds,
      ro,
      doc: child.doc().objects.x,
      docConflictIdsAfter,
      base,
      signalledPaths: merged.conflicts,
      roAfterHeal,
      roCold,
      ledger,
    }
  } finally {
    stop()
    restoreLogs()
    await settle(300)
    for (const r of repos) await r.shutdown()
  }
}

suite('G4-16g witness — two online first writes of an EXISTING entity into a fresh head, after a real rotation', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'ordinary_head_first_write_conflict')
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
          read_model_overlay_entity_bases, read_model_overlay_conflicts, read_model_ordinary_head_retirements,
          read_model_document_watermarks`)
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

  for (const order of ['together', 'a-projected-first'] as const) {
    it(`DIFFERENT fields (${order}): A's name and B's description both survive — document, ro_*, cold rebuild — with no conflict signalled`, async () => {
      const both = (x: Record<string, unknown> | undefined) => x?.name === 'XA' && x?.description === 'dB'
      const out = await runScenario(order, { name: 'XA' }, { description: 'dB' }, both)
      // Witness that the suspected path really ran: a `$` at X, then healed.
      expect(out.preHealConflictIds).toEqual(['x'])
      expect(out.docConflictIdsAfter).toEqual([])
      // The symptom first: both edits in ro_* and in the served document.
      expect(out.ro).toEqual({ ...X0, name: 'XA', description: 'dB' })
      expect(out.doc).toEqual({ ...X0, name: 'XA', description: 'dB' })
      // The mechanism that decides it: the base the projector captured for X
      // in the fresh head is the value the OLDER segment served
      // (`captureOverlayEntityBases`, read from `ro_objects` before X's first
      // projection from this head).
      expect(out.base).toEqual({ existed: true, data: X0 })
      expect(out.signalledPaths).toEqual([])
      expect(out.ledger).toEqual([])
      expect(out.roCold).toEqual(out.roAfterHeal)
    })

    it(`control — the SAME field (${order}): a real conflict on name is still signalled, and the description is untouched`, async () => {
      const oneOfThem = (x: Record<string, unknown> | undefined) =>
        (x?.name === 'XA' || x?.name === 'XB') && x?.description === 'd0'
      const out = await runScenario(order, { name: 'XA' }, { name: 'XB' }, oneOfThem)
      expect(out.preHealConflictIds).toEqual(['x'])
      expect(out.base).toEqual({ existed: true, data: X0 })
      expect(oneOfThem(out.ro)).toBe(true)
      expect(out.doc?.name).toBe(out.ro?.name)
      expect(out.signalledPaths).toEqual(['name'])
      expect(out.roCold).toEqual(out.roAfterHeal)
    })
  }
})
