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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { ensureReadModelSchema } from './schema.js'
import { ProjectorFleet } from './projectorService.js'
import { compactionFleet } from './fleetServing.js'
import { LiveWorkspaceResidency } from './liveWorkspaceResidency.js'
import { classifyWarmupFailure } from './warmupOutcome.js'
import { readProjectionAcknowledgement } from './compaction.js'
import { runWorkspaceCompaction, type WorkspaceCompactionDeps } from './workspaceCompaction.js'
import { acquireOverlayRotationLock, overlayRotationLockKey, releaseOverlayRotationLock } from './overlayRotationLock.js'
import type { WorkspaceKey } from './projector.js'

/**
 * T-VANISH: objects must never leave `ro_objects` while
 * a shard ModelMeta lists still holds them.
 *
 * The defect, as this file reproduced it before the fix:
 * `runWorkspaceCompaction` detaches the projector
 * (`fleet.release(key, 'compaction')`), folds the overlay into the base
 * shards, then clears the folded entries from the overlay head. A sync
 * frame in that window (`LiveWorkspaceResidency.noteOwnedActivity`, called by
 * the ownership gate, `automergeServer.ts`) started a COLD BUILD whose
 * extraction read the head BEFORE the clear and seeded the head's watcher
 * with the folded ids; the clear was then a "delete" to that watcher, whose
 * gap pass (`applyObjectShardDelta`) deleted rows the base shard held. The
 * compaction's own re-attach awaited that start instead of building after
 * the fold. Measured before the fix: 31/31 runs deleted them, 23/31 for good.
 *
 * The guard is the WINDOW (`ProjectorFleet`): no start but the compaction's
 * own `{ adopt: false }` re-attach while the fold runs (a read joins that
 * re-attach once it is building), the window closed after the re-attach on
 * every way out of the pass, and by itself past `compactionWindowMaxMs`. A
 * second layer ("a shard delta keeps an id another listed shard holds") was
 * built and dropped: the last case of this file says why.
 *
 * Real PostgreSQL storage, real Repo, real `ProjectorFleet`, real
 * `LiveWorkspaceResidency`, real compaction. Skips without TEST_DATABASE_URL.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-vanish', versionId: 'v1' }

let db: IsolatedSchemaDb

type Entity = { id: string; [field: string]: unknown }
type ObjShard = { objects: Record<string, Entity>; writeBatchIds?: string[] }
type ConnShard = { connections: Record<string, Entity>; writeBatchIds?: string[] }
type Meta = {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrl: string
  editsObjectShardUrls: string[]
  editsConnectionShardUrl: string
  editsConnectionShardUrls: string[]
  groups: Record<string, unknown>
  deletedObjectIds: string[]
  deletedConnectionIds: string[]
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

interface Workspace {
  repo: Repo
  rootUrl: string
  meta: DocHandle<Meta>
  head: DocHandle<ObjShard>
  base: DocHandle<ObjShard>
  connHead: DocHandle<ConnShard>
}

/** T-SUM-2c nn-a, reduced: a system `s` with a child app `a`, a system `p`,
 * `x`, the object a colleague deletes, and one connection `c1` (s → p) in a
 * connection base shard. */
async function workspace(repo: Repo): Promise<Workspace> {
  const base = repo.create<ObjShard>({
    objects: {
      s: { id: 's', name: 'Storefront', type: 'system' },
      a: { id: 'a', name: 'API', type: 'app', parentId: 's' },
      p: { id: 'p', name: 'Payments', type: 'system' },
      x: { id: 'x', name: 'Orders', type: 'store', parentId: 's' },
    },
  })
  const head = repo.create<ObjShard>({ objects: {}, writeBatchIds: [] })
  const connBase = repo.create<ConnShard>({ connections: { c1: { id: 'c1', fromId: 's', toId: 'p', label: 'Charges' } } })
  const connHead = repo.create<ConnShard>({ connections: {}, writeBatchIds: [] })
  const meta = repo.create<Meta>({
    objectShardUrls: [base.url, head.url],
    connectionShardUrls: [connBase.url, connHead.url],
    editsObjectShardUrl: head.url,
    editsObjectShardUrls: [head.url],
    editsConnectionShardUrl: connHead.url,
    editsConnectionShardUrls: [connHead.url],
    groups: {},
    deletedObjectIds: [],
    deletedConnectionIds: [],
  })
  const registry = repo.create({ diagrams: {} })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
  const handles = [base, head, connBase, connHead, meta, registry, root]
  await Promise.all(handles.map((h) => h.whenReady()))
  await repo.flush()
  for (const handle of handles) {
    await db.pool.query(
      'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [String(handle.documentId), WS.landscapeId, WS.versionId],
    )
  }
  return { repo, rootUrl: root.url, meta, head, base, connHead }
}

/** nn-a gens 17-19 (a rename, a creation, a rename, all in the overlay
 * head) and the colleague's tombstone on `x`; waits until projected. */
async function editAndTombstone(ws: Workspace): Promise<void> {
  ws.head.change((d) => {
    d.objects.a = { id: 'a', name: 'API renamed', type: 'app', parentId: 's' }
    d.objects.n = { id: 'n', name: 'Created', type: 'app' }
    d.objects.p = { id: 'p', name: 'Payments renamed', type: 'system' }
    d.writeBatchIds!.push('batch-1')
  })
  ws.meta.change((m) => { m.deletedObjectIds.push('x') })
  await until(roIds, (ids) => ids.includes('n') && !ids.includes('x'))
  expect(await roIds()).toEqual(['a', 'n', 'p', 's'])
  await acknowledged()
}

interface StackOptions {
  /** A client's sync frame reaches the ownership gate right after the fold's
   * detach (`buildOwnershipWriteCheck` calls `noteOwnedActivity` for every
   * owned frame; the throttle is stamped only by a frame that found the
   * projector NOT resident, so the first frame of the window is never
   * throttled). */
  frameAfterRelease?: boolean
  /** Called right after the fold's detach, before the pass goes on. */
  afterRelease?: () => void
  isShuttingDown?: () => boolean
  owns?: () => boolean
  repo?: Repo
}

/** The production fleet, as compaction sees it (`compactionFleet`), with the
 * production live residency in front of it. */
function stack(ws: Workspace, opts: StackOptions = {}) {
  const fleet = new ProjectorFleet(ws.repo, async () => ws.rootUrl, { fallbackRootUrl: ws.rootUrl, db: db.pool, maxProjectors: 8 })
  const residency = new LiveWorkspaceResidency({
    fleet: () => fleet,
    isExpectedRefusal: (error) => classifyWarmupFailure(error).expected,
  })
  const base = compactionFleet(fleet)
  const compacting: WorkspaceCompactionDeps['fleet'] = {
    ...base,
    release: (key, reason) => {
      base.release(key, reason)
      if (reason !== 'compaction') return
      opts.afterRelease?.()
      if (opts.frameAfterRelease) residency.noteOwnedActivity(WS)
    },
  }
  const deps = {
    repo: opts.repo ?? ws.repo, rootUrl: ws.rootUrl, db: db.pool, fleet: compacting,
    connect: () => db.pool.connect(),
    ownership: { owns: opts.owns ?? (() => true) }, isShuttingDown: opts.isShuttingDown ?? (() => false),
    log: () => {}, warn: () => {},
  } as unknown as WorkspaceCompactionDeps
  return { fleet, residency, deps }
}

const roIds = async () => (await db.pool.query<{ id: string }>(
  'SELECT id FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id',
  [WS.landscapeId, WS.versionId],
)).rows.map((row) => row.id)
const roRows = async (table: 'ro_objects' | 'ro_connections') => Object.fromEntries((await db.pool.query<{ id: string; data: Record<string, unknown> }>(
  `SELECT id, data FROM ${table} WHERE landscape_id = $1 AND version_id = $2 ORDER BY id`,
  [WS.landscapeId, WS.versionId],
)).rows.map((row) => [row.id, row.data.name ?? row.data.label ?? null]))
const events = async (after: number) => (await db.pool.query<{ generation: string; change_kind: string; payload: unknown }>(
  'SELECT generation, change_kind, payload FROM read_model_change_events WHERE landscape_id = $1 AND version_id = $2 AND generation > $3 ORDER BY generation',
  [WS.landscapeId, WS.versionId, after],
)).rows
const generation = async () => Number((await db.pool.query<{ g: string }>(
  'SELECT COALESCE(MAX(generation), 0)::text AS g FROM read_model_change_events WHERE landscape_id = $1 AND version_id = $2',
  [WS.landscapeId, WS.versionId],
)).rows[0]?.g ?? 0)
const acknowledged = () => until(() => readProjectionAcknowledgement(db.pool, WS), (ack) => ack.acknowledged, 15_000)
const baseIds = (ws: Workspace) => Object.keys(ws.base.doc()!.objects).sort()
const deletedIn = (feed: Awaited<ReturnType<typeof events>>, kind: 'objects' | 'connections') => feed.flatMap((row) => {
  const payload = row.payload as { deleteIds?: string[]; exact?: Record<string, { deleteIds?: string[] } | undefined> }
  return [...(row.change_kind === kind ? payload.deleteIds ?? [] : []), ...(payload.exact?.[kind]?.deleteIds ?? [])]
})

suite('T-VANISH — real storage, ProjectorFleet, PostgreSQL', () => {
  let restoreRegistration: () => void = () => {}
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 't_vanish')
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
    await db.pool.query(`TRUNCATE automerge_storage, automerge_document_workspace, ro_objects, ro_connections, ro_groups,
      read_model_projection_state, read_model_change_events, read_model_overlay_batch_acks,
      read_model_overlay_entity_bases, read_model_document_watermarks`)
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

  const newRepo = () => new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 60_000 })

  it('CONTROL: with no frame in the detached window, the folded objects stay served — and a later write to the cleared head keeps them', async () => {
    const ws = await workspace(newRepo())
    const { fleet, deps } = stack(ws)
    try {
      expect(await fleet.ensure(WS)).toBe(true)
      await editAndTombstone(ws)
      const outcome = await runWorkspaceCompaction(WS, deps)
      expect(outcome.result.skippedReason).toBeUndefined()
      expect(outcome.result.objectsFolded).toBe(3)
      expect(outcome.reattach).toBe('reattached')
      await acknowledged()
      await settle(500)
      expect(baseIds(ws)).toEqual(['a', 'n', 'p', 's'])
      expect(await roIds()).toEqual(['a', 'n', 'p', 's'])
      // An offline client still holding the head the compaction cleared.
      ws.head.change((d) => { d.writeBatchIds!.push('batch-late') })
      await settle(1_500)
      expect(await roIds()).toEqual(['a', 'n', 'p', 's'])
    } finally {
      fleet.stopAll()
    }
  }, 120_000)

  it('REGRESSION (red before the fix): a sync frame right after the compaction detaches is refused, the compaction builds after the fold, and no object the base shard holds ever leaves ro_objects', async () => {
    const ws = await workspace(newRepo())
    const { fleet, residency, deps } = stack(ws, { frameAfterRelease: true })
    try {
      expect(await fleet.ensure(WS)).toBe(true)
      await editAndTombstone(ws)
      const before = await generation()
      const outcome = await runWorkspaceCompaction(WS, deps)
      await acknowledged()
      await settle(1_500)
      const feed = await events(before)
      // Preconditions: the pass folded, re-attached, the base shard holds
      // every object and the cleared head none.
      expect(outcome.result.skippedReason).toBeUndefined()
      expect(outcome.result.objectsFolded).toBe(3)
      expect(outcome.reattach).toBe('reattached')
      expect(baseIds(ws)).toEqual(['a', 'n', 'p', 's'])
      expect(Object.keys(ws.head.doc()!.objects)).toEqual([])
      // The frame met the window: refused, counted, never an error.
      expect(residency.snapshot()).toMatchObject({ refused: 1, failed: 0 })
      expect(fleet.isCompactionWindowOpen(WS)).toBe(false)
      // The verdict: what the documents hold is what is served — and was at
      // every generation (a delete event is the defect even when a later
      // pass repairs the rows: every client drops the object meanwhile).
      expect(await roIds(), 'objects the base shard holds left ro_objects').toEqual(['a', 'n', 'p', 's'])
      expect(deletedIn(feed, 'objects').filter((id) => ['a', 'n', 'p'].includes(id)), 'the feed deleted objects the base shard holds').toEqual([])
    } finally {
      fleet.stopAll()
    }
  }, 120_000)

  it('the window stays open through the compaction\'s own re-attach and closes after it, once', async () => {
    const ws = await workspace(newRepo())
    const { fleet, deps } = stack(ws)
    const calls: string[] = []
    const recorded: WorkspaceCompactionDeps['fleet'] = {
      ...deps.fleet,
      release: (key, reason) => { calls.push(`release:${reason}`); deps.fleet.release(key, reason) },
      ensure: async (key, options) => {
        calls.push(`ensure:${options?.adopt === false ? 'adopt-false' : 'plain'}:window-${fleet.isCompactionWindowOpen(key) ? 'open' : 'closed'}`)
        return deps.fleet.ensure(key, options)
      },
      endCompactionWindow: (key) => { calls.push('end'); deps.fleet.endCompactionWindow(key) },
    }
    try {
      expect(await fleet.ensure(WS)).toBe(true)
      await editAndTombstone(ws)
      const outcome = await runWorkspaceCompaction(WS, { ...deps, fleet: recorded })
      expect(outcome.reattach).toBe('reattached')
      expect(calls.slice(calls.indexOf('release:compaction'))).toEqual(['release:compaction', 'ensure:adopt-false:window-open', 'end'])
    } finally {
      fleet.stopAll()
    }
  }, 120_000)

  it('a pass that never detached (its rotation key contended) leaves another pass\'s window alone', async () => {
    const ws = await workspace(newRepo())
    const { fleet, deps } = stack(ws)
    const holder = await db.pool.connect()
    const lockKey = overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object')
    const calls: string[] = []
    const recorded: WorkspaceCompactionDeps['fleet'] = {
      ...deps.fleet,
      endCompactionWindow: (key) => { calls.push('end'); deps.fleet.endCompactionWindow(key) },
    }
    let state: Awaited<ReturnType<typeof acquireOverlayRotationLock>> | null = null
    try {
      expect(await fleet.ensure(WS)).toBe(true)
      await editAndTombstone(ws)
      state = await acquireOverlayRotationLock(holder, lockKey)
      expect(state).toBe('acquired')
      // Another pass's window, as if that pass were folding now.
      fleet.release(WS, 'compaction')
      const outcome = await runWorkspaceCompaction(WS, { ...deps, fleet: recorded })
      expect(outcome).toMatchObject({ reattach: 'not_detached', result: { skippedReason: 'overlay_rotation_lock_contended' } })
      expect(calls).toEqual([])
      expect(fleet.isCompactionWindowOpen(WS)).toBe(true)
      fleet.endCompactionWindow(WS)
    } finally {
      if (state) await releaseOverlayRotationLock(holder, lockKey, state)
      else holder.release()
      fleet.stopAll()
    }
  }, 120_000)

  it('the window closes on every way out of the pass: shutting down at the re-attach, ownership lost at the re-attach, the fold thrown', async () => {
    for (const exit of ['shutting-down', 'not-owned', 'fold-throws'] as const) {
      await db.pool.query('TRUNCATE ro_objects, ro_connections, read_model_projection_state, read_model_change_events')
      const ws = await workspace(newRepo())
      let armed = false
      // The fold's first document resolution throws once armed.
      const throwingRepo = new Proxy(ws.repo, {
        get(target, property, receiver) {
          if (armed && exit === 'fold-throws' && property === 'find') {
            return () => Promise.reject(new Error('injected: the fold could not resolve a document'))
          }
          const value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as Repo
      const { fleet, deps } = stack(ws, {
        afterRelease: () => { armed = true },
        isShuttingDown: () => armed && exit === 'shutting-down',
        owns: () => !(armed && exit === 'not-owned'),
        repo: throwingRepo,
      })
      try {
        expect(await fleet.ensure(WS)).toBe(true)
        const outcome = await runWorkspaceCompaction(WS, deps).catch((error: unknown) => ({ thrown: String(error) }))
        armed = false
        // The exit really was the one named (not a pass that re-attached).
        const expected = { 'shutting-down': { reattach: 'skipped_shutting_down' }, 'not-owned': { reattach: 'skipped_not_owned' } } as const
        if (exit === 'fold-throws') expect(outcome, 'the fold must have thrown').toMatchObject({ thrown: expect.stringContaining('injected') })
        else expect(outcome).toMatchObject(expected[exit])
        expect(fleet.isCompactionWindowOpen(WS), `${exit}: the window is still open (${JSON.stringify(outcome)})`).toBe(false)
        // Admitted again: a read's plain ensure builds.
        expect(await fleet.ensure(WS), `${exit}: a start after the pass`).toBe(true)
        expect(fleet.isResident(WS)).toBe(true)
      } finally {
        fleet.stopAll()
      }
    }
  }, 180_000)

  it('WHY THERE IS NO "absence is not deletion" DEFENCE: a user deletion drops the overlay copy BEFORE its tombstone lands, and the row goes at once', async () => {
    // T-VANISH tried a second layer — a shard delta keeps an id another
    // listed shard still holds — and dropped it:
    // the bridge's delete removes the overlay copy (`captureExplicitDeletes`
    // → `deleteObjectFromOverlaySegments`) before the flush writes the
    // tombstone (`writeTombstones`), so in the order the server sees it the
    // object is briefly "held by the base shard, not tombstoned". Measured on
    // the e2e stack: the deleted object and its incident connections were
    // re-served at their base values until the tombstone pass, in every run.
    // This pins the shipped behaviour that a naive defence would break.
    const ws = await workspace(newRepo())
    const { fleet } = stack(ws)
    try {
      expect(await fleet.ensure(WS)).toBe(true)
      ws.head.change((d) => {
        d.objects.a = { id: 'a', name: 'API renamed', type: 'app', parentId: 's' }
        d.writeBatchIds!.push('batch-1')
      })
      await until(() => roRows('ro_objects'), (rows) => rows.a === 'API renamed')
      const before = await generation()
      ws.head.change((d) => { delete d.objects.a })
      await until(async () => (await generation()) > before, Boolean)
      expect(Object.keys(ws.base.doc()!.objects)).toContain('a')
      expect(await roIds(), 'the deleted object is served again from the base shard').toEqual(['p', 's', 'x'])
      expect(deletedIn(await events(before), 'objects')).toEqual(['a'])
      // Then the tombstone: still gone.
      ws.meta.change((m) => { m.deletedObjectIds.push('a') })
      await settle(500)
      expect(await roIds()).toEqual(['p', 's', 'x'])
    } finally {
      fleet.stopAll()
    }
  }, 120_000)
})
