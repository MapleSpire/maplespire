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
 * The load gate's SEED, projected — a DB-gated witness for what
 * `verify:sync-load-soak` waits on.
 *
 * The gate seeds objects plus a batch id into each hot workspace's overlay
 * write head, then waits for the OWNER's projector to acknowledge them. That
 * depends on two things, read from two different places:
 *
 *  - the DOCUMENT: the batch id must reach the head. A head out of
 *    `createEmptyRoot` is `{ objects: {} }` — no `writeBatchIds` until the
 *    first client write — so the gate's helper must create the list.
 *  - the PROJECTOR: an ordinary workspace has no resident projector until a
 *    read-model route asks for one; every projector (ordinary and static)
 *    must acknowledge batches in `read_model_overlay_batch_acks`, in the same
 *    transaction as the rows it vouches for, so the client's batch journal
 *    drains on every workspace kind.
 *
 * Arms run against REAL rows, one per workspace kind, seeding through the
 * gate's own helper. Real rows rather than emitted SQL: the mocked unit suite
 * (`staticDeltaProjector.test.ts`) asserts the INSERT is EMITTED, but only a
 * row a reader can find is what `/api/model/overlay-batches/status` reads.
 *
 * Conflict-healing arms: the projector must NOT heal a same-field conflict by
 * assigning the whole entity back (a NEW map at the key) — a peer whose field
 * write had not yet reached the server would keep writing into the previous,
 * now unreferenced map, and its write would vanish with no conflict to show for
 * it. Both projectors share one healer (`overlayConflictHealing.ts`). A
 * creation without a base merges as a union (its base is the empty record), and
 * a `$` entity sharing a sample with a same-field entity leaves the latter
 * untouched.
 *
 * The invariant these arms are corners of — no client-written field disappears
 * without a client delete — is stated as a property over random schedules in
 * `overlayConflictHealing.test.ts`, with a naive policy as a failing control.
 *
 * RETIRED-head arms (12, 13, 14): a batch written into a head compaction has
 * rotated away from, mid-session and at the cold build's attach, on both
 * collections; and a head APPENDED to the meta that is not current at attach.
 * The generation counts in arms 4 and 5 make "never publish the lossy JSON
 * winner after a heal, in either case" a tested rule.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as A from '@automerge/automerge'
import { Repo, type DocHandle } from '@automerge/automerge-repo'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { startReadModelProjector } from './projectorService.js'
import { roConnection, roObject } from './queries.js'
import { overlayBatchStatuses, pendingOverlayBatchIds } from './overlayHistoryStore.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { StaticDeltaProjector } from './staticDeltaProjector.js'
import { buildModelMeta } from '../modelMeta.js'
// The gate's own seed helpers: what this file covers is what the bench runs.
import { appendOverlayBatchId, loadObjectIds } from '../../qa/loadUsersCore.mjs'

const CONNECTION = process.env.TEST_DATABASE_URL

interface ObjectHead {
  objects: Record<string, { id: string; type: string; name: string }>
  writeBatchIds?: string[]
  writeHeadVersion?: number
}

const ORDINARY = { landscapeId: 'ls-load-seed-ordinary', versionId: 'v1' }
const STATIC = { landscapeId: 'ls-load-seed-static', versionId: 'v1' }
const CONFLICT = { landscapeId: 'ls-load-seed-conflict', versionId: 'v1' }
const WHOLE = { landscapeId: 'ls-load-seed-whole-entity', versionId: 'v1' }
const CONNECTIONS = { landscapeId: 'ls-load-seed-connections', versionId: 'v1' }
const MIXED = { landscapeId: 'ls-load-seed-mixed-sample', versionId: 'v1' }
const COLD = { landscapeId: 'ls-load-seed-cold-build', versionId: 'v1' }
const ROTATED = { landscapeId: 'ls-load-seed-rotated-head', versionId: 'v1' }
const CURRENT = { landscapeId: 'ls-load-seed-current-wire', versionId: 'v1' }
const WINDOW = { landscapeId: 'ls-load-seed-heads-window', versionId: 'v1' }
const STATIC_WINDOW = { landscapeId: 'ls-load-seed-static-heads-window', versionId: 'v1' }
const RETIRED = { landscapeId: 'ls-load-seed-retired-head', versionId: 'v1' }
const RETIRED_COLD = { landscapeId: 'ls-load-seed-retired-head-cold', versionId: 'v1' }
const APPENDED = { landscapeId: 'ls-load-seed-appended-loser', versionId: 'v1' }

interface ConnectionHead {
  connections: Record<string, Record<string, unknown>>
  writeBatchIds?: string[]
  writeHeadVersion?: number
}

/** The test's pool, with ONE hook: the first read of the overlay entity bases
 *  — the second `await` between a heal's sample and its `handle.change` — runs
 *  `onBasesRead` before the query is answered. Everything else, `connect()`
 *  included, goes straight to the real pool. */
function latchedPool(pool: IsolatedSchemaDb['pool'], onBasesRead: () => void): IsolatedSchemaDb['pool'] {
  let armed = true
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === 'query') {
        return async (text: unknown, params?: unknown[]) => {
          if (armed && typeof text === 'string' && text.includes('FROM read_model_overlay_entity_bases')) {
            armed = false
            onBasesRead()
          }
          return (target as unknown as { query(text: unknown, params?: unknown[]): Promise<unknown> }).query(text, params)
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** How many times `objects[<id>]` was PUT in the document's whole history — a
 *  `makeMap` op keyed by the id. One is the creation; every further one is a
 *  replacement that orphans the fields peers wrote into the previous map. */
function makeMapPuts(doc: A.Doc<unknown>, id: string): number {
  let count = 0
  for (const change of A.getAllChanges(doc)) {
    for (const op of A.decodeChange(change).ops ?? []) {
      if (op.action === 'makeMap' && op.key === id) count += 1
    }
  }
  return count
}

/** The workspace's two projection counters (`read_model_projection_state`,
 *  `health.ts`): `observed` moves when a tracked projection BEGINS, `projected`
 *  when one commits. Equal means nothing is in flight; the difference of
 *  `observed` across an interval is the number of tracked projections it cost. */
async function projectionGenerations(
  db: IsolatedSchemaDb['pool'],
  key: { landscapeId: string; versionId: string },
): Promise<{ observed: number; projected: number }> {
  const { rows } = await db.query<{ observed_generation: string | number; projected_generation: string | number }>(
    `SELECT observed_generation, projected_generation FROM read_model_projection_state
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  return { observed: Number(rows[0]?.observed_generation ?? 0), projected: Number(rows[0]?.projected_generation ?? 0) }
}

/** `observed` once nothing is in flight — polls until the two counters agree. */
async function settledGeneration(db: IsolatedSchemaDb['pool'], key: { landscapeId: string; versionId: string }): Promise<number> {
  let settled = -1
  await expect.poll(async () => {
    const generations = await projectionGenerations(db, key)
    if (generations.observed !== generations.projected) return null
    settled = generations.observed
    return settled
  }, { timeout: 10_000, interval: 50 }).not.toBeNull()
  return settled
}

/** The gate's seed, verbatim in shape: objects into the head's map and the
 *  batch id through `appendOverlayBatchId`, in ONE change. */
function seed(head: DocHandle<ObjectHead>, ids: string[], batchId: string): boolean {
  let appended = false
  head.change((doc) => {
    for (const id of ids) doc.objects[id] = { id, type: 'app', name: `QA load ${id}` }
    appended = appendOverlayBatchId(doc, batchId) as boolean
  })
  return appended
}

describe.skipIf(!CONNECTION)('T-G1c — the load gate seed reaches the read model, and who acknowledges it', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let stopOrdinary: (() => void) | null = null
  let projector: StaticDeltaProjector | null = null

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'load_gate_seed_projection')
    await ensureReadModelSchema(database.pool)
    // Minimal shape of the admission tables (their real DDL lives in db.ts) —
    // the same fixture as `staticDeltaProjector.registryShard.integration.test.ts`:
    // the static allow-list writer also records the workspace assignment, by a
    // JOIN on `versions`, so the static arm needs both.
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      parent_version_id TEXT, kind TEXT NOT NULL DEFAULT 'version',
      status TEXT NOT NULL DEFAULT 'active', base_manifest JSONB,
      PRIMARY KEY (landscape_id, id))`)
    // The static publish transaction stamps the source document's storage
    // timestamps into `read_model_static_document_state` from this table.
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    for (const workspace of [STATIC, STATIC_WINDOW]) {
      await database.pool.query(
        `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, 'automerge:root')
         ON CONFLICT DO NOTHING`,
        [workspace.landscapeId, workspace.versionId],
      )
    }
  })
  afterAll(async () => { await database?.teardown() })
  afterEach(async () => {
    stopOrdinary?.()
    stopOrdinary = null
    await projector?.stop()
    projector = null
  })

  it('ordinary workspace — the batch id lands on a fresh head, the objects reach ro_objects, and the ORDINARY projector acknowledges the batch', async () => {
    // network: [] — an adapter with no peer makes repo.find() never settle.
    repo = new Repo({ network: [] })
    // Exactly `createEmptyRoot`'s shapes (`automergeServer.ts`): the head has NO
    // `writeBatchIds` list, and the ModelMeta comes from the real builder.
    const head = repo.create<ObjectHead>({ objects: {} })
    const connections = repo.create({ connections: {} })
    const meta = repo.create(buildModelMeta({ objectWriteHead: head.url, connectionWriteHead: connections.url }))
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([head, connections, meta, root].map((handle) => handle.whenReady()))
    stopOrdinary = await startReadModelProjector(repo, root.url, database.pool, ORDINARY)

    const ids = loadObjectIds(3, 'qa-arm-ordinary') as string[]
    const batchId = 'qa-arm-ordinary-seed'
    // Half 1 — the gate's helper, on the shape the product creates.
    expect(seed(head, ids, batchId)).toBe(true)
    expect(head.doc()?.writeBatchIds).toEqual([batchId])

    // Half 2a — the owner's (ordinary) projector projected the head.
    for (const id of ids) {
      await expect.poll(() => roObject(database.pool, ORDINARY, id), { timeout: 10_000, interval: 50 }).toBeTruthy()
    }
    expect(await roObject(database.pool, ORDINARY, ids[0])).toMatchObject({ id: ids[0], name: `QA load ${ids[0]}` })

    // Half 2b — the acknowledgement, written in the SAME transaction as the
    // rows.
    await expect.poll(() => overlayBatchStatuses(database.pool, ORDINARY, [batchId]), { timeout: 10_000, interval: 50 })
      .toEqual([{ batchId, status: 'projected', documentId: head.documentId, updatedAt: expect.any(String) }])
    expect(await pendingOverlayBatchIds(database.pool, ORDINARY, [batchId])).toEqual([])

    // A second batch on the same head: the closure sends only the ids it has
    // not acknowledged yet (the list in the document only grows), and the new
    // one is acknowledged too — the first stays `projected`. "Only the new
    // ids" is OBSERVED, not trusted: the upsert stamps `updated_at = now()` on
    // every id it is given, so a re-sent first batch would move its stamp.
    const firstStamp = (await overlayBatchStatuses(database.pool, ORDINARY, [batchId]))[0].updatedAt
    const moreIds = loadObjectIds(2, 'qa-arm-ordinary-more') as string[]
    const secondBatchId = 'qa-arm-ordinary-seed-2'
    expect(seed(head, moreIds, secondBatchId)).toBe(true)
    expect(head.doc()?.writeBatchIds).toEqual([batchId, secondBatchId])
    await expect.poll(() => pendingOverlayBatchIds(database.pool, ORDINARY, [batchId, secondBatchId]), { timeout: 10_000, interval: 50 })
      .toEqual([])
    const rows = await overlayBatchStatuses(database.pool, ORDINARY, [batchId, secondBatchId])
    expect(rows.map((row) => row.status)).toEqual(['projected', 'projected'])
    expect(rows.find((row) => row.batchId === batchId)?.updatedAt).toBe(firstStamp)
  }, 30_000)

  it('ordinary workspace — a head APPENDED mid-session (the client rotated its write head) with a batch already inside is acknowledged by the initial apply', async () => {
    // The `applyInitial=true` attach: a url that appears in the ModelMeta while
    // the projector is resident (`watchObjectShard(url, true)` from the meta
    // watcher). The client creates the new head, writes into it, THEN repoints
    // the meta — so the batch is already there when the projector first sees
    // the document. Only this arm covers the attach acknowledgement on this
    // path; without it the ids are still added to the closure's Set, so no
    // later delta would ever re-send them.
    repo = new Repo({ network: [] })
    const head = repo.create<ObjectHead>({ objects: {} })
    const connections = repo.create({ connections: {} })
    const meta = repo.create(buildModelMeta({ objectWriteHead: head.url, connectionWriteHead: connections.url }))
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([head, connections, meta, root].map((handle) => handle.whenReady()))
    stopOrdinary = await startReadModelProjector(repo, root.url, database.pool, ROTATED)
    expect(seed(head, ['qa-arm-rotated-warm'], 'qa-arm-rotated-warm-seed')).toBe(true)
    await expect.poll(() => roObject(database.pool, ROTATED, 'qa-arm-rotated-warm'), { timeout: 10_000, interval: 50 }).toBeTruthy()

    const next = repo.create<ObjectHead>({ objects: {}, writeHeadVersion: 1, writeBatchIds: [] })
    await next.whenReady()
    const ids = loadObjectIds(2, 'qa-arm-rotated') as string[]
    const batchId = 'qa-arm-rotated-seed'
    expect(seed(next, ids, batchId)).toBe(true)
    meta.change((doc) => {
      doc.objectShardUrls.push(next.url)
      doc.editsObjectShardUrls.push(next.url)
      doc.editsObjectShardUrl = next.url
    })

    for (const id of ids) {
      await expect.poll(() => roObject(database.pool, ROTATED, id), { timeout: 10_000, interval: 50 }).toBeTruthy()
    }
    await expect.poll(() => pendingOverlayBatchIds(database.pool, ROTATED, [batchId]), { timeout: 10_000, interval: 50 }).toEqual([])
    expect(await overlayBatchStatuses(database.pool, ROTATED, [batchId])).toEqual([
      { batchId, status: 'projected', documentId: next.documentId, updatedAt: expect.any(String) },
    ])
  }, 30_000)

  it('ordinary workspace — the heal carries what the read model PUBLISHED since the base was captured: a field edited after the base and orphaned by two concurrent re-creations comes back', async () => {
    // The `current` wire (`current: () => undefined` is invisible to every
    // other arm). The base is captured once, at first sight;
    // a later edit lives only in the published row and in the map two peers
    // are about to replace from an older fork — the merge must start from what
    // is PUBLISHED, not from the base, or the edit is gone from the document.
    repo = new Repo({ network: [] })
    const head = repo.create<ObjectHead & { objects: Record<string, Record<string, unknown>> }>({
      objects: { o9: { id: 'o9', type: 'app', name: 'Nine' } },
    })
    const connections = repo.create({ connections: {} })
    const meta = repo.create(buildModelMeta({ objectWriteHead: head.url, connectionWriteHead: connections.url }))
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([head, connections, meta, root].map((handle) => handle.whenReady()))
    stopOrdinary = await startReadModelProjector(repo, root.url, database.pool, CURRENT)
    await expect.poll(() => roObject(database.pool, CURRENT, 'o9'), { timeout: 10_000, interval: 50 }).toBeTruthy()

    // Two peers fork HERE, before the edit below reaches anyone.
    const forkBase = head.doc()!
    // A third client edits o9; the projector publishes it — and captures o9's
    // base in that same delta, BEFORE applying it: the base is the pre-edit row.
    head.change((doc) => { doc.objects.o9.edited = 'yes' })
    await expect.poll(
      async () => ((await roObject(database.pool, CURRENT, 'o9')) as { edited?: string } | undefined)?.edited,
      { timeout: 10_000, interval: 50 },
    ).toBe('yes')

    const left = A.change(A.clone(forkBase), (doc) => { doc.objects.o9 = { id: 'o9', type: 'app', name: 'Nine', fromLeft: 'L' } })
    const right = A.change(A.clone(forkBase), (doc) => { doc.objects.o9 = { id: 'o9', type: 'app', name: 'Nine', fromRight: 'R' } })
    head.update((doc) => A.merge(A.merge(doc, left), right))
    // Both replacements supersede the map the edit was written into: the JSON
    // winner has no `edited`, and neither branch does.
    expect(Object.keys(A.getConflicts(head.doc()!.objects, 'o9') ?? {})).toHaveLength(2)
    expect(head.doc()!.objects.o9.edited).toBeUndefined()

    await expect.poll(async () => {
      const row = (await roObject(database.pool, CURRENT, 'o9')) as { fromLeft?: string; fromRight?: string; edited?: string } | undefined
      return row?.fromLeft === 'L' && row?.fromRight === 'R' && row?.edited === 'yes' ? 'all' : null
    }, { timeout: 10_000, interval: 50 }).toBe('all')
    expect(head.doc()!.objects.o9).toMatchObject({ fromLeft: 'L', fromRight: 'R', edited: 'yes' })
    expect(Object.keys(A.getConflicts(head.doc()!.objects, 'o9') ?? {}).length).toBeLessThanOrEqual(1)
  }, 30_000)

  it('ordinary workspace — a write landing between the heal\'s sample and its change is NOT overwritten: the heal stands down and the next tick carries it', async () => {
    // The `sampledHeads` wire (`null` from either projector would otherwise
    // pass, the guard being tested elsewhere only in isolation). Made
    // deterministic by a latch on the read of the entity
    // bases — the second of the two `await`s between the sample and the
    // change: the peer's write lands exactly in the window.
    repo = new Repo({ network: [] })
    const head = repo.create<ObjectHead & { objects: Record<string, Record<string, unknown>> }>({
      objects: { o9: { id: 'o9', type: 'app', name: 'Nine' } },
    })
    const connections = repo.create({ connections: {} })
    const meta = repo.create(buildModelMeta({ objectWriteHead: head.url, connectionWriteHead: connections.url }))
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([head, connections, meta, root].map((handle) => handle.whenReady()))
    let lateWrites = 0
    const pool = latchedPool(database.pool, () => {
      lateWrites += 1
      head.change((doc) => { doc.objects.o9.late = 'in-the-window' })
    })
    stopOrdinary = await startReadModelProjector(repo, root.url, pool, WINDOW)
    await expect.poll(() => roObject(database.pool, WINDOW, 'o9'), { timeout: 10_000, interval: 50 }).toBeTruthy()
    const generationBeforeConflict = await settledGeneration(database.pool, WINDOW)

    const before = head.doc()!
    const left = A.change(A.clone(before), (doc) => { doc.objects.o9 = { id: 'o9', type: 'app', name: 'Nine', fromLeft: 'L' } })
    const right = A.change(A.clone(before), (doc) => { doc.objects.o9 = { id: 'o9', type: 'app', name: 'Nine', fromRight: 'R' } })
    head.update((doc) => A.merge(A.merge(doc, left), right))

    // Without the guard the heal computed from the stale sample replaces the
    // map the late write went into, and `late` is orphaned with no conflict to
    // show for it. With it, the first attempt stands down and the second heals
    // from a sample that has `late`.
    await expect.poll(async () => {
      const row = (await roObject(database.pool, WINDOW, 'o9')) as { fromLeft?: string; fromRight?: string; late?: string } | undefined
      return row?.fromLeft === 'L' && row?.fromRight === 'R' && row?.late === 'in-the-window' ? 'all' : null
    }, { timeout: 10_000, interval: 50 }).toBe('all')
    expect(lateWrites).toBe(1)
    expect(head.doc()!.objects.o9).toMatchObject({ fromLeft: 'L', fromRight: 'R', late: 'in-the-window' })
    expect(Object.keys(A.getConflicts(head.doc()!.objects, 'o9') ?? {}).length).toBeLessThanOrEqual(1)
    // Creation, two replacements, ONE heal — the stood-down attempt wrote nothing.
    expect(makeMapPuts(head.doc()!, 'o9')).toBe(4)
    // And ONE tracked generation for the whole episode — the `stale` half of
    // "never publish the lossy JSON winner in either case" (publishing the
    // winner on the stood-down pass, then the union, would cost two
    // generations with the same puts and the same final rows).
    expect(await settledGeneration(database.pool, WINDOW) - generationBeforeConflict).toBe(1)
  }, 30_000)

  it('static workspace — the same window, the same rule: the static projector\'s heal stands down when the document moved past its sample', async () => {
    // The static half of the `sampledHeads` wire. The static projector re-projects from its
    // queue, which this fixture does not feed, so the second tick is driven by
    // hand — what the arm pins is that the FIRST one wrote nothing.
    repo = new Repo({ network: [] })
    await markStaticReadModelWorkspace(database.pool, STATIC_WINDOW, 'test')
    const head = repo.create<ObjectHead & { objects: Record<string, Record<string, unknown>> }>({
      objects: { o9: { id: 'o9', type: 'app', name: 'Nine' } }, writeHeadVersion: 1, writeBatchIds: [],
    })
    await head.whenReady()
    await registerStaticReadModelDocuments(
      database.pool, STATIC_WINDOW, [{ documentId: head.documentId, kind: 'object-overlay' }],
    )
    let lateWrites = 0
    const pool = latchedPool(database.pool, () => {
      lateWrites += 1
      head.change((doc) => { doc.objects.o9.late = 'in-the-window' })
    })
    projector = new StaticDeltaProjector(repo, pool)
    const internal = projector as unknown as {
      project(
        descriptor: { landscapeId: string; versionId: string; documentId: string; kind: string; entityId: null; orgId: null },
        handle: DocHandle<unknown>,
      ): Promise<void>
    }
    const descriptor = { ...STATIC_WINDOW, documentId: head.documentId, kind: 'object-overlay', entityId: null, orgId: null }
    await internal.project(descriptor, head)
    expect(await roObject(database.pool, STATIC_WINDOW, 'o9')).toMatchObject({ id: 'o9' })

    const before = head.doc()!
    const left = A.change(A.clone(before), (doc) => { doc.objects.o9 = { id: 'o9', type: 'app', name: 'Nine', fromLeft: 'L' } })
    const right = A.change(A.clone(before), (doc) => { doc.objects.o9 = { id: 'o9', type: 'app', name: 'Nine', fromRight: 'R' } })
    head.update((doc) => A.merge(A.merge(doc, left), right))
    const putsBefore = makeMapPuts(head.doc()!, 'o9')

    // First tick: the latch fires the late write during the bases read; the
    // heal must stand down — nothing written, `$` still there, `late` present.
    await internal.project(descriptor, head)
    expect(lateWrites).toBe(1)
    expect(makeMapPuts(head.doc()!, 'o9')).toBe(putsBefore)
    expect(Object.keys(A.getConflicts(head.doc()!.objects, 'o9') ?? {})).toHaveLength(2)
    expect(head.doc()!.objects.o9.late).toBe('in-the-window')
    // Second tick, fresh sample: the union carries `late`.
    await internal.project(descriptor, head)
    expect(head.doc()!.objects.o9).toMatchObject({ fromLeft: 'L', fromRight: 'R', late: 'in-the-window' })
    expect(makeMapPuts(head.doc()!, 'o9')).toBe(putsBefore + 1)
    expect(Object.keys(A.getConflicts(head.doc()!.objects, 'o9') ?? {}).length).toBeLessThanOrEqual(1)
  }, 30_000)

  it('ordinary workspace — a batch already in the head when the projector STARTS is acknowledged by the cold build\'s attach, with no client write to carry it', async () => {
    // THE GATE'S REAL SHAPE: the gate seeds, THEN its lookup call makes the
    // projector resident. The cold build publishes the objects through the
    // extraction, the shard attaches with `applyInitial=false` and heads equal
    // to the extraction's, and no gap projection ever runs — so the attach
    // itself must acknowledge the batch, or nothing does until the next client
    // write. The delta path is not on this route.
    repo = new Repo({ network: [] })
    const head = repo.create<ObjectHead>({ objects: {} })
    const connections = repo.create<{ connections: Record<string, Record<string, unknown>>; writeBatchIds?: string[] }>({ connections: {} })
    const meta = repo.create(buildModelMeta({ objectWriteHead: head.url, connectionWriteHead: connections.url }))
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([head, connections, meta, root].map((handle) => handle.whenReady()))

    const ids = loadObjectIds(3, 'qa-arm-cold') as string[]
    const batchId = 'qa-arm-cold-seed'
    expect(seed(head, ids, batchId)).toBe(true)
    const connectionBatchId = 'qa-arm-cold-connection-seed'
    connections.change((doc) => {
      doc.connections.c1 = { id: 'c1', fromId: ids[0], toId: ids[1], label: 'calls' }
      appendOverlayBatchId(doc, connectionBatchId)
    })

    // The projector starts AFTER the seed: this is the cold build.
    stopOrdinary = await startReadModelProjector(repo, root.url, database.pool, COLD)
    for (const id of ids) {
      await expect.poll(() => roObject(database.pool, COLD, id), { timeout: 10_000, interval: 50 }).toBeTruthy()
    }
    await expect.poll(() => roConnection(database.pool, COLD, 'c1'), { timeout: 10_000, interval: 50 }).toBeTruthy()
    // No write since the seed — the acknowledgement must come from the attach.
    await expect.poll(() => pendingOverlayBatchIds(database.pool, COLD, [batchId, connectionBatchId]), { timeout: 10_000, interval: 50 })
      .toEqual([])
    expect(await overlayBatchStatuses(database.pool, COLD, [batchId])).toEqual([
      { batchId, status: 'projected', documentId: head.documentId, updatedAt: expect.any(String) },
    ])
    expect(await overlayBatchStatuses(database.pool, COLD, [connectionBatchId])).toEqual([
      { batchId: connectionBatchId, status: 'projected', documentId: connections.documentId, updatedAt: expect.any(String) },
    ])
    // The document itself was not written by the server for any of this.
    expect(makeMapPuts(head.doc()!, ids[0])).toBe(1)
  }, 30_000)

  it('static workspace — the same seed is acknowledged `projected` by the static delta projector', async () => {
    repo = new Repo({ network: [] })
    await markStaticReadModelWorkspace(database.pool, STATIC, 'test')
    // `performanceSeed/workspace.ts` creates the head WITH the list; on that
    // shape the helper must do nothing beyond the push.
    const head = repo.create<ObjectHead>({ objects: {}, writeHeadVersion: 1, writeBatchIds: [] })
    await head.whenReady()
    await registerStaticReadModelDocuments(
      database.pool, STATIC, [{ documentId: head.documentId, kind: 'object-overlay' }],
    )
    projector = new StaticDeltaProjector(repo, database.pool)

    const ids = loadObjectIds(3, 'qa-arm-static') as string[]
    const batchId = 'qa-arm-static-seed'
    expect(seed(head, ids, batchId)).toBe(true)
    expect(head.doc()?.writeBatchIds).toEqual([batchId])

    // Drive the REAL dispatch — `project()` — the way the registry-shard suite
    // does, so the overlay branch and the acknowledgement inside its publish
    // transaction are both on the path.
    const internal = projector as unknown as {
      project(
        descriptor: { landscapeId: string; versionId: string; documentId: string; kind: string; entityId: null; orgId: null },
        handle: DocHandle<ObjectHead>,
      ): Promise<void>
    }
    await internal.project(
      { ...STATIC, documentId: head.documentId, kind: 'object-overlay', entityId: null, orgId: null },
      head,
    )

    for (const id of ids) expect(await roObject(database.pool, STATIC, id)).toMatchObject({ id })
    expect(await overlayBatchStatuses(database.pool, STATIC, [batchId])).toEqual([
      { batchId, status: 'projected', documentId: head.documentId, updatedAt: expect.any(String) },
    ])
    expect(await pendingOverlayBatchIds(database.pool, STATIC, [batchId])).toEqual([])
  }, 30_000)

  it('ordinary workspace — a same-field conflict is projected, never healed by replacing the entity, so a late peer\'s own field survives', async () => {
    repo = new Repo({ network: [] })
    const head = repo.create<ObjectHead & { objects: Record<string, Record<string, unknown>> }>({ objects: {} })
    const connections = repo.create({ connections: {} })
    const meta = repo.create(buildModelMeta({ objectWriteHead: head.url, connectionWriteHead: connections.url }))
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([head, connections, meta, root].map((handle) => handle.whenReady()))
    stopOrdinary = await startReadModelProjector(repo, root.url, database.pool, CONFLICT)

    // The seeded object, projected once so the projector's snapshot holds it.
    head.change((doc) => { doc.objects.o1 = { id: 'o1', type: 'app', name: 'QA load o1' } })
    await expect.poll(() => roObject(database.pool, CONFLICT, 'o1'), { timeout: 10_000, interval: 50 }).toBeTruthy()

    // Two peers write the SAME field concurrently — the bench's `hot` — and one
    // of them also writes its own field, the bench's `u<i>`. Forks of one state
    // are exactly what two browsers hold before the server relays either.
    const before = head.doc()!
    const left = A.change(A.clone(before), (doc) => { doc.objects.o1.hot = 'u0-r0' })
    const right = A.change(A.clone(before), (doc) => { doc.objects.o1.hot = 'u1-r0'; doc.objects.o1.u1 = 'r0' })
    head.update((doc) => A.merge(A.merge(doc, left), right))
    // The KEY is not in conflict; the FIELD is — the exact shape the bench produced.
    expect(Object.keys(A.getConflicts(head.doc()!.objects, 'o1') ?? {}).length).toBeLessThanOrEqual(1)
    expect(Object.keys(A.getConflicts(head.doc()!.objects.o1, 'hot') ?? {})).toHaveLength(2)
    const changesBefore = A.getAllChanges(head.doc()!).length

    // The projector sees the change and publishes the deterministic winner.
    await expect.poll(
      async () => ((await roObject(database.pool, CONFLICT, 'o1')) as { u1?: string } | undefined)?.u1,
      { timeout: 10_000, interval: 50 },
    ).toBe('r0')

    // A peer that has seen nothing since `before` writes its own field into the
    // ORIGINAL map. Had the projector replaced that map, this write would land
    // in an unreferenced branch: present in the history, absent from the
    // document, no conflict anywhere.
    const late = A.change(A.clone(before), (doc) => { doc.objects.o1.u7 = 'r0' })
    head.update((doc) => A.merge(doc, late))
    expect(head.doc()!.objects.o1.u7).toBe('r0')
    expect(head.doc()!.objects.o1.u1).toBe('r0')
    // The server wrote NOTHING into the document for a same-field conflict …
    expect(A.getAllChanges(head.doc()!).length).toBe(changesBefore + 1)
    // … and the key was put exactly once in the whole history.
    expect(makeMapPuts(head.doc()!, 'o1')).toBe(1)
  }, 30_000)

  it('ordinary workspace — a whole-entity (`$`) conflict IS healed, by one map replacement carrying both branches, then published', async () => {
    // The one case that DOES need a server write: two peers
    // REPLACING the same key concurrently (a paste, an import, a restore) leave
    // two whole-entity branches, and JSON shows only one. Without a structural
    // heal the other branch's distinct fields are invisible to every reader.
    repo = new Repo({ network: [] })
    // `o9` exists when the projector starts — an entity from an earlier session,
    // the common case for a real edit. Its cold-build row is what the heal's
    // three-way merge reads as the BASE (`captureOverlayEntityBases` at attach).
    const head = repo.create<ObjectHead & { objects: Record<string, Record<string, unknown>> }>({
      objects: { o9: { id: 'o9', type: 'app', name: 'Nine' } },
    })
    const connections = repo.create({ connections: {} })
    const meta = repo.create(buildModelMeta({ objectWriteHead: head.url, connectionWriteHead: connections.url }))
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([head, connections, meta, root].map((handle) => handle.whenReady()))
    stopOrdinary = await startReadModelProjector(repo, root.url, database.pool, WHOLE)
    await expect.poll(() => roObject(database.pool, WHOLE, 'o9'), { timeout: 10_000, interval: 50 }).toBeTruthy()
    // `o10` is born in the overlay after the projector started: its base row
    // records "did not exist", which is every entity an ordinary workspace has
    // ever created in-session.
    head.change((doc) => { doc.objects.o10 = { id: 'o10', type: 'app', name: 'Ten' } })
    await expect.poll(() => roObject(database.pool, WHOLE, 'o10'), { timeout: 10_000, interval: 50 }).toBeTruthy()
    const generationBeforeConflict = await settledGeneration(database.pool, WHOLE)

    const before = head.doc()!
    const left = A.change(A.clone(before), (doc) => {
      doc.objects.o9 = { id: 'o9', type: 'app', name: 'Nine', fromLeft: 'L' }
      doc.objects.o10 = { id: 'o10', type: 'app', name: 'Ten', fromLeft: 'L' }
    })
    const right = A.change(A.clone(before), (doc) => {
      doc.objects.o9 = { id: 'o9', type: 'app', name: 'Nine', fromRight: 'R' }
      doc.objects.o10 = { id: 'o10', type: 'app', name: 'Ten', fromRight: 'R' }
    })
    head.update((doc) => A.merge(A.merge(doc, left), right))
    // The KEYS themselves are in conflict now — the `$` shape.
    expect(Object.keys(A.getConflicts(head.doc()!.objects, 'o9') ?? {})).toHaveLength(2)
    expect(Object.keys(A.getConflicts(head.doc()!.objects, 'o10') ?? {})).toHaveLength(2)

    // WITH A BASE: the projector heals `o9` by one replacement carrying BOTH
    // branches' fields, and its own write re-triggers the projection that
    // publishes the union. MUTANT: delete the `$` branch and the conflict
    // stays, the puts stay at 3 and the read model shows one branch.
    await expect.poll(async () => {
      const row = (await roObject(database.pool, WHOLE, 'o9')) as { fromLeft?: string; fromRight?: string } | undefined
      return row?.fromLeft === 'L' && row?.fromRight === 'R' ? 'both' : null
    }, { timeout: 10_000, interval: 50 }).toBe('both')
    expect(head.doc()!.objects.o9).toMatchObject({ name: 'Nine', fromLeft: 'L', fromRight: 'R' })
    expect(Object.keys(A.getConflicts(head.doc()!.objects, 'o9') ?? {}).length).toBeLessThanOrEqual(1)
    // Creation, the two concurrent replacements, and exactly one heal.
    expect(makeMapPuts(head.doc()!, 'o9')).toBe(4)

    // WITHOUT A BASE: the base of a creation is the empty record, so the heal
    // carries BOTH replacements' fields for an overlay-born entity too (reading
    // "no base" as a value would keep only what was published and drop both
    // new fields).
    await expect.poll(async () => {
      const row = (await roObject(database.pool, WHOLE, 'o10')) as { fromLeft?: string; fromRight?: string } | undefined
      return row?.fromLeft === 'L' && row?.fromRight === 'R' ? 'both' : null
    }, { timeout: 10_000, interval: 50 }).toBe('both')
    expect(head.doc()!.objects.o10).toEqual({ id: 'o10', type: 'app', name: 'Ten', fromLeft: 'L', fromRight: 'R' })
    expect(makeMapPuts(head.doc()!, 'o10')).toBe(4)
    expect(Object.keys(A.getConflicts(head.doc()!.objects, 'o10') ?? {}).length).toBeLessThanOrEqual(1)

    // EXACTLY ONE generation for the whole episode: the projection
    // that sampled the conflict healed and stood down — the heal runs on the
    // pool, outside any tracked span — and the heal's own change re-triggered
    // the one tracked projection that published the union. The alternative the
    // comment forbids — publish the lossy JSON winner, THEN the union — costs
    // two, and nothing above can tell them apart: the puts are 4 either way and
    // the read model converges either way; only this count does.
    expect(await settledGeneration(database.pool, WHOLE) - generationBeforeConflict).toBe(1)
  }, 30_000)

  it('ordinary workspace — a `$` entity and a same-field entity in the SAME sample: only the `$` entity is written, the other keeps its contested leaf', async () => {
    // Healing is PER ENTITY: a gate that opened on `some()` over the sample
    // and healed EVERY conflicting entity in it would touch `o1`, whose only
    // conflict is on `hot`, a field the read model never published — deleting
    // the leaf and transcribing the deletion into the document, both writers'
    // values gone from every peer.
    repo = new Repo({ network: [] })
    const head = repo.create<ObjectHead & { objects: Record<string, Record<string, unknown>> }>({
      objects: {
        o9: { id: 'o9', type: 'app', name: 'Nine' },
        o1: { id: 'o1', type: 'app', name: 'One' },
      },
    })
    const connections = repo.create({ connections: {} })
    const meta = repo.create(buildModelMeta({ objectWriteHead: head.url, connectionWriteHead: connections.url }))
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([head, connections, meta, root].map((handle) => handle.whenReady()))
    stopOrdinary = await startReadModelProjector(repo, root.url, database.pool, MIXED)
    await expect.poll(() => roObject(database.pool, MIXED, 'o1'), { timeout: 10_000, interval: 50 }).toBeTruthy()

    const before = head.doc()!
    const left = A.change(A.clone(before), (doc) => {
      doc.objects.o9 = { id: 'o9', type: 'app', name: 'Nine', fromLeft: 'L' }
      doc.objects.o1.hot = 'u0-r0'
    })
    const right = A.change(A.clone(before), (doc) => {
      doc.objects.o9 = { id: 'o9', type: 'app', name: 'Nine', fromRight: 'R' }
      doc.objects.o1.hot = 'u1-r0'
      doc.objects.o1.u1 = 'r0'
    })
    // ONE update, so ONE sample holds both shapes.
    head.update((doc) => A.merge(A.merge(doc, left), right))
    expect(Object.keys(A.getConflicts(head.doc()!.objects, 'o9') ?? {})).toHaveLength(2)
    expect(Object.keys(A.getConflicts(head.doc()!.objects, 'o1') ?? {}).length).toBeLessThanOrEqual(1)
    expect(Object.keys(A.getConflicts(head.doc()!.objects.o1, 'hot') ?? {})).toHaveLength(2)

    // The `$` entity is healed and its union published …
    await expect.poll(async () => {
      const row = (await roObject(database.pool, MIXED, 'o9')) as { fromLeft?: string; fromRight?: string } | undefined
      return row?.fromLeft === 'L' && row?.fromRight === 'R' ? 'both' : null
    }, { timeout: 10_000, interval: 50 }).toBe('both')
    // … and the same-field entity was never written by the server: the leaf is
    // there, both values are still in the CRDT, the key was put once, and the
    // read model carries one of the two written values.
    expect(['u0-r0', 'u1-r0']).toContain(head.doc()!.objects.o1.hot)
    expect(head.doc()!.objects.o1.u1).toBe('r0')
    expect(Object.keys(A.getConflicts(head.doc()!.objects.o1, 'hot') ?? {})).toHaveLength(2)
    expect(makeMapPuts(head.doc()!, 'o1')).toBe(1)
    const published = (await roObject(database.pool, MIXED, 'o1')) as { hot?: string; u1?: string }
    expect(['u0-r0', 'u1-r0']).toContain(published.hot)
    expect(published.u1).toBe('r0')
  }, 30_000)

  it('ordinary workspace — the CONNECTION head follows the same rule: a same-field conflict is projected, never healed by replacing the entity', async () => {
    // The connection-shard closure mirrors the object one, and no other arm
    // exercises it. Same shape as the object arm, on the other head.
    repo = new Repo({ network: [] })
    const head = repo.create({ objects: {} })
    const connections = repo.create<{ connections: Record<string, Record<string, unknown>> }>({ connections: {} })
    const meta = repo.create(buildModelMeta({ objectWriteHead: head.url, connectionWriteHead: connections.url }))
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([head, connections, meta, root].map((handle) => handle.whenReady()))
    stopOrdinary = await startReadModelProjector(repo, root.url, database.pool, CONNECTIONS)

    // Seeded the way the client writes: the entity and its batch id in ONE change.
    const connectionBatchId = 'qa-arm-connections-seed'
    connections.change((doc) => {
      doc.connections.c1 = { id: 'c1', fromId: 'a', toId: 'b', label: 'calls' }
      appendOverlayBatchId(doc, connectionBatchId)
    })
    await expect.poll(() => roConnection(database.pool, CONNECTIONS, 'c1'), { timeout: 10_000, interval: 50 }).toBeTruthy()
    // The connection head is acknowledged by the ordinary projector too.
    await expect.poll(() => overlayBatchStatuses(database.pool, CONNECTIONS, [connectionBatchId]), { timeout: 10_000, interval: 50 })
      .toEqual([{ batchId: connectionBatchId, status: 'projected', documentId: connections.documentId, updatedAt: expect.any(String) }])

    const before = connections.doc()!
    const left = A.change(A.clone(before), (doc) => { doc.connections.c1.label = 'left' })
    const right = A.change(A.clone(before), (doc) => { doc.connections.c1.label = 'right'; doc.connections.c1.u1 = 'r0' })
    connections.update((doc) => A.merge(A.merge(doc, left), right))
    expect(Object.keys(A.getConflicts(connections.doc()!.connections, 'c1') ?? {}).length).toBeLessThanOrEqual(1)
    expect(Object.keys(A.getConflicts(connections.doc()!.connections.c1, 'label') ?? {})).toHaveLength(2)
    const changesBefore = A.getAllChanges(connections.doc()!).length

    await expect.poll(
      async () => ((await roConnection(database.pool, CONNECTIONS, 'c1')) as { u1?: string } | undefined)?.u1,
      { timeout: 10_000, interval: 50 },
    ).toBe('r0')

    const late = A.change(A.clone(before), (doc) => { doc.connections.c1.u7 = 'r0' })
    connections.update((doc) => A.merge(doc, late))
    expect(connections.doc()!.connections.c1.u7).toBe('r0')
    expect(connections.doc()!.connections.c1.u1).toBe('r0')
    expect(A.getAllChanges(connections.doc()!).length).toBe(changesBefore + 1)
    expect(makeMapPuts(connections.doc()!, 'c1')).toBe(1)
  }, 30_000)

  it('ordinary workspace — a batch written into a RETIRED head after compaction rotated away from it is projected AND acknowledged, on both collections', async () => {
    // Compaction mints a fresh write head and repoints the meta
    // (`compaction.ts`, `nextHead`); when the client's
    // `shouldRotateOverlayWriteHead` says so it merely defers to server
    // maintenance (`bridge.ts`, `overlay.rotation.deferred`) and keeps writing
    // into the current head. The retired head stays in `objectShardUrls`, so
    // its closure keeps projecting it — and the acknowledgement must NOT be
    // gated on `editsObjectShardUrl === url`, or a peer that was offline across
    // the rotation and kept writing into the old head has its batches
    // acknowledged by nobody: journal entry kept, retired head pinned in the
    // tab (`edits-overlay-pending`) for its life.
    // MUTANT: restore that gate and the two late batches below stay pending.
    repo = new Repo({ network: [] })
    const head = repo.create<ObjectHead>({ objects: {} })
    const connections = repo.create<ConnectionHead>({ connections: {} })
    const meta = repo.create(buildModelMeta({ objectWriteHead: head.url, connectionWriteHead: connections.url }))
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([head, connections, meta, root].map((handle) => handle.whenReady()))
    stopOrdinary = await startReadModelProjector(repo, root.url, database.pool, RETIRED)
    expect(seed(head, ['qa-arm-retired-warm'], 'qa-arm-retired-warm-seed')).toBe(true)
    await expect.poll(() => pendingOverlayBatchIds(database.pool, RETIRED, ['qa-arm-retired-warm-seed']), { timeout: 10_000, interval: 50 })
      .toEqual([])

    // The rotation, in compaction's shape: fresh heads, then the meta repointed
    // at them — the old heads stay listed, exactly as `compaction.ts` leaves
    // them ("historical URLs remain referenced so stale/offline clients can
    // finish syncing safely").
    const nextObjects = repo.create<ObjectHead>({ objects: {}, writeHeadVersion: 1, writeBatchIds: [] })
    const nextConnections = repo.create<ConnectionHead>({ connections: {}, writeHeadVersion: 1, writeBatchIds: [] })
    await Promise.all([nextObjects, nextConnections].map((handle) => handle.whenReady()))
    meta.change((doc) => {
      doc.objectShardUrls.push(nextObjects.url)
      doc.editsObjectShardUrls.push(nextObjects.url)
      doc.editsObjectShardUrl = nextObjects.url
      doc.connectionShardUrls.push(nextConnections.url)
      doc.editsConnectionShardUrls.push(nextConnections.url)
      doc.editsConnectionShardUrl = nextConnections.url
    })
    // The new heads are current and acknowledged — the projector has seen the
    // repoint before the late writes below land in the OLD heads. Hygiene, not
    // a kill condition: the meta is read synchronously in-process, so the
    // repoint is seen regardless.
    expect(seed(nextObjects, ['qa-arm-retired-next'], 'qa-arm-retired-next-seed')).toBe(true)
    nextConnections.change((doc) => {
      doc.connections.c1 = { id: 'c1', fromId: 'qa-arm-retired-next', toId: 'qa-arm-retired-warm', label: 'calls' }
      appendOverlayBatchId(doc, 'qa-arm-retired-next-connection-seed')
    })
    await expect.poll(
      () => pendingOverlayBatchIds(database.pool, RETIRED, ['qa-arm-retired-next-seed', 'qa-arm-retired-next-connection-seed']),
      { timeout: 10_000, interval: 50 },
    ).toEqual([])

    // The offline peer's writes, into the RETIRED heads.
    const lateIds = loadObjectIds(2, 'qa-arm-retired-late') as string[]
    const lateBatchId = 'qa-arm-retired-late-seed'
    expect(seed(head, lateIds, lateBatchId)).toBe(true)
    const lateConnectionBatchId = 'qa-arm-retired-late-connection-seed'
    connections.change((doc) => {
      doc.connections.c9 = { id: 'c9', fromId: lateIds[0], toId: lateIds[1], label: 'late' }
      appendOverlayBatchId(doc, lateConnectionBatchId)
    })
    // Projected — the retired heads are still watched …
    for (const id of lateIds) {
      await expect.poll(() => roObject(database.pool, RETIRED, id), { timeout: 10_000, interval: 50 }).toBeTruthy()
    }
    await expect.poll(() => roConnection(database.pool, RETIRED, 'c9'), { timeout: 10_000, interval: 50 }).toBeTruthy()
    // … and ACKNOWLEDGED, under the retired documents' own ids — which is what
    // proves the RETIRED closure wrote the row. The client's
    // journal, for its part, drains by batch id alone and keeps the documentId
    // it recorded at write time; the server column never reaches it.
    await expect.poll(() => pendingOverlayBatchIds(database.pool, RETIRED, [lateBatchId, lateConnectionBatchId]), { timeout: 10_000, interval: 50 })
      .toEqual([])
    expect(await overlayBatchStatuses(database.pool, RETIRED, [lateBatchId])).toEqual([
      { batchId: lateBatchId, status: 'projected', documentId: head.documentId, updatedAt: expect.any(String) },
    ])
    expect(await overlayBatchStatuses(database.pool, RETIRED, [lateConnectionBatchId])).toEqual([
      { batchId: lateConnectionBatchId, status: 'projected', documentId: connections.documentId, updatedAt: expect.any(String) },
    ])
    // The server wrote nothing into either retired document for any of this.
    expect(makeMapPuts(head.doc()!, lateIds[0])).toBe(1)
    expect(makeMapPuts(connections.doc()!, 'c9')).toBe(1)

    // A SECOND write into the retired head: the closure sends only the ids it
    // has not acknowledged yet, observed through `updated_at` as in arm 1 (a
    // Set fed for the current head only would re-send every retired-head id on
    // every delta — noise, not loss).
    const lateStamp = (await overlayBatchStatuses(database.pool, RETIRED, [lateBatchId]))[0].updatedAt
    const secondLateBatchId = 'qa-arm-retired-late-seed-2'
    expect(seed(head, loadObjectIds(1, 'qa-arm-retired-late-2') as string[], secondLateBatchId)).toBe(true)
    await expect.poll(() => pendingOverlayBatchIds(database.pool, RETIRED, [secondLateBatchId]), { timeout: 10_000, interval: 50 }).toEqual([])
    expect((await overlayBatchStatuses(database.pool, RETIRED, [lateBatchId]))[0].updatedAt).toBe(lateStamp)
  }, 30_000)

  it('ordinary workspace — a head APPENDED to the meta that is NOT the current head at attach is acknowledged by the initial apply, on both collections', async () => {
    // The acknowledgement must not sit inside `if (currentOverlayAtAttach)` of
    // the `applyInitial` transaction; arm 8 cannot see that, since it appends a
    // head that IS current at attach. The shape that is not: a shard whose first attach failed sits in
    // `degradedShards` and is re-attempted on the next meta change; when that
    // change is compaction's rotation, the shard re-attaches `applyInitial=true`,
    // carrying batches, and is no longer current. Under the mutant no row is
    // written AND the ids still enter the closure's Set, so no delta ever
    // re-sends them: pending for the life of the profile. ONE `meta.change`
    // appends the loser (with a batch inside) and the winner, and points at the
    // winner.
    repo = new Repo({ network: [] })
    const head = repo.create<ObjectHead>({ objects: {} })
    const connections = repo.create<ConnectionHead>({ connections: {} })
    const meta = repo.create(buildModelMeta({ objectWriteHead: head.url, connectionWriteHead: connections.url }))
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([head, connections, meta, root].map((handle) => handle.whenReady()))
    stopOrdinary = await startReadModelProjector(repo, root.url, database.pool, APPENDED)
    expect(seed(head, ['qa-arm-appended-warm'], 'qa-arm-appended-warm-seed')).toBe(true)
    await expect.poll(() => pendingOverlayBatchIds(database.pool, APPENDED, ['qa-arm-appended-warm-seed']), { timeout: 10_000, interval: 50 })
      .toEqual([])

    const loser = repo.create<ObjectHead>({ objects: {}, writeHeadVersion: 1, writeBatchIds: [] })
    const winner = repo.create<ObjectHead>({ objects: {}, writeHeadVersion: 1, writeBatchIds: [] })
    const loserConnections = repo.create<ConnectionHead>({ connections: {}, writeHeadVersion: 1, writeBatchIds: [] })
    const winnerConnections = repo.create<ConnectionHead>({ connections: {}, writeHeadVersion: 1, writeBatchIds: [] })
    await Promise.all([loser, winner, loserConnections, winnerConnections].map((handle) => handle.whenReady()))
    const ids = loadObjectIds(2, 'qa-arm-appended-loser') as string[]
    const batchId = 'qa-arm-appended-loser-seed'
    expect(seed(loser, ids, batchId)).toBe(true)
    const connectionBatchId = 'qa-arm-appended-loser-connection-seed'
    loserConnections.change((doc) => {
      doc.connections.c1 = { id: 'c1', fromId: ids[0], toId: ids[1], label: 'calls' }
      appendOverlayBatchId(doc, connectionBatchId)
    })
    meta.change((doc) => {
      doc.objectShardUrls.push(loser.url)
      doc.objectShardUrls.push(winner.url)
      doc.editsObjectShardUrls.push(loser.url)
      doc.editsObjectShardUrls.push(winner.url)
      doc.editsObjectShardUrl = winner.url
      doc.connectionShardUrls.push(loserConnections.url)
      doc.connectionShardUrls.push(winnerConnections.url)
      doc.editsConnectionShardUrls.push(loserConnections.url)
      doc.editsConnectionShardUrls.push(winnerConnections.url)
      doc.editsConnectionShardUrl = winnerConnections.url
    })

    for (const id of ids) {
      await expect.poll(() => roObject(database.pool, APPENDED, id), { timeout: 10_000, interval: 50 }).toBeTruthy()
    }
    await expect.poll(() => roConnection(database.pool, APPENDED, 'c1'), { timeout: 10_000, interval: 50 }).toBeTruthy()
    await expect.poll(() => pendingOverlayBatchIds(database.pool, APPENDED, [batchId, connectionBatchId]), { timeout: 10_000, interval: 50 })
      .toEqual([])
    expect(await overlayBatchStatuses(database.pool, APPENDED, [batchId])).toEqual([
      { batchId, status: 'projected', documentId: loser.documentId, updatedAt: expect.any(String) },
    ])
    expect(await overlayBatchStatuses(database.pool, APPENDED, [connectionBatchId])).toEqual([
      { batchId: connectionBatchId, status: 'projected', documentId: loserConnections.documentId, updatedAt: expect.any(String) },
    ])
  }, 30_000)

  it('ordinary workspace — a RETIRED head already carrying a batch when the projector STARTS is acknowledged by the cold build\'s attach', async () => {
    // The failover shape of the same residual: the rotation happened in an
    // earlier session, an offline peer's batch landed in the old head while no
    // projector was resident, and the new owner's cold build attaches that
    // head with `applyInitial=false` and heads equal to the extraction's — the
    // `acknowledgeOnly` route of arm 7. MUTANT: gate `attachBatchIds` on
    // `currentOverlayAtAttach` and this batch is pending until a client writes
    // into the retired head once more, which an online client never does.
    // BOTH collections: arm 7 attaches a CURRENT connection head and arm 12
    // sends the connection batch through the delta, so only the retired
    // connection head below catches that gate in `watchConnectionShard`'s
    // attach.
    repo = new Repo({ network: [] })
    const retired = repo.create<ObjectHead>({ objects: {} })
    const retiredConnections = repo.create<ConnectionHead>({ connections: {} })
    const current = repo.create<ObjectHead>({ objects: {}, writeHeadVersion: 1, writeBatchIds: [] })
    const currentConnections = repo.create<ConnectionHead>({ connections: {}, writeHeadVersion: 1, writeBatchIds: [] })
    const meta = repo.create(buildModelMeta({ objectWriteHead: retired.url, connectionWriteHead: retiredConnections.url }))
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([retired, retiredConnections, current, currentConnections, meta, root].map((handle) => handle.whenReady()))
    meta.change((doc) => {
      doc.objectShardUrls.push(current.url)
      doc.editsObjectShardUrls.push(current.url)
      doc.editsObjectShardUrl = current.url
      doc.connectionShardUrls.push(currentConnections.url)
      doc.editsConnectionShardUrls.push(currentConnections.url)
      doc.editsConnectionShardUrl = currentConnections.url
    })
    const ids = loadObjectIds(2, 'qa-arm-retired-cold') as string[]
    const batchId = 'qa-arm-retired-cold-seed'
    expect(seed(retired, ids, batchId)).toBe(true)
    const connectionBatchId = 'qa-arm-retired-cold-connection-seed'
    retiredConnections.change((doc) => {
      doc.connections.c1 = { id: 'c1', fromId: ids[0], toId: ids[1], label: 'calls' }
      appendOverlayBatchId(doc, connectionBatchId)
    })

    // The projector starts AFTER the rotation and the seeds: this is the cold build.
    stopOrdinary = await startReadModelProjector(repo, root.url, database.pool, RETIRED_COLD)
    for (const id of ids) {
      await expect.poll(() => roObject(database.pool, RETIRED_COLD, id), { timeout: 10_000, interval: 50 }).toBeTruthy()
    }
    await expect.poll(() => roConnection(database.pool, RETIRED_COLD, 'c1'), { timeout: 10_000, interval: 50 }).toBeTruthy()
    await expect.poll(() => pendingOverlayBatchIds(database.pool, RETIRED_COLD, [batchId, connectionBatchId]), { timeout: 10_000, interval: 50 })
      .toEqual([])
    expect(await overlayBatchStatuses(database.pool, RETIRED_COLD, [batchId])).toEqual([
      { batchId, status: 'projected', documentId: retired.documentId, updatedAt: expect.any(String) },
    ])
    expect(await overlayBatchStatuses(database.pool, RETIRED_COLD, [connectionBatchId])).toEqual([
      { batchId: connectionBatchId, status: 'projected', documentId: retiredConnections.documentId, updatedAt: expect.any(String) },
    ])
    expect(makeMapPuts(retired.doc()!, ids[0])).toBe(1)
    expect(makeMapPuts(retiredConnections.doc()!, 'c1')).toBe(1)
  }, 30_000)
})
