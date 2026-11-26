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
 * T-SUM-0b: an object rename on a workspace that has just ENTERED the static
 * plane (promoted, or performance-seeded) reached no `ro_objects` row.
 *
 * Measured on a stack: at the
 * entry no overlay head has a projected snapshot (neither the promotion nor
 * the seed writes one); the startup rotation (`writeHeadVersion < 2`) makes
 * the object chain `[old, new]`; the old head is never projected by anyone
 * (its own pass forwards, `attach` projects no data document, and it has no
 * queue row), so every pass of the new head returned at `!ready` from
 * `updateStaticOverlaySegment` — no acknowledgement, no log, `projected_revision`
 * 0 for ever. The connection chain escaped by an ordering accident: the
 * ModelMeta pass the OBJECT rotation triggers runs `synchronizeOverlayHead`
 * while the connection head is still the old one, which INSERTs a row for it
 * whose `last_projected_snapshot` is the column DEFAULT `'{}'` — read back as
 * "projected, and empty" for a head that held connections.
 *
 * Real Automerge repo, the real projector (its `start()` and its rotation for
 * the first case, its dispatch for the others), real PostgreSQL in an
 * isolated schema; skips without TEST_DATABASE_URL.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { readMetaUrl } from '../modelMetaUrls.js'
import { ensureReadModelSchema } from './schema.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { StaticDeltaProjector, staticOverlayNotReadyMetricSamples } from './staticDeltaProjector.js'
import { recordOverlaySegmentProjection, synchronizeOverlayHead } from './overlayHistoryStore.js'
import { upsertConnections, upsertObjects } from './projector.js'
import { roConnection, roObject } from './queries.js'

const CONNECTION = process.env.TEST_DATABASE_URL
const WS = { landscapeId: 'ls-entering-static', versionId: 'v1' }

type ObjectHead = { objects: Record<string, { id: string; name: string }>; writeHeadVersion: number; writeBatchIds: string[] }
type Connection = { id: string; fromId: string; toId: string; label: string }
type ConnectionHead = { connections: Record<string, Connection>; writeHeadVersion: number; writeBatchIds: string[] }

describe.skipIf(!CONNECTION)('T-SUM-0b — a workspace entering the static plane projects its object head (Automerge → Postgres)', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let projector: StaticDeltaProjector

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'static_entering_plane')
    await ensureReadModelSchema(database.pool)
    // The admission tables' minimal shape, as in the sibling integration
    // files; `arrival_seq` because `start()` reads the storage clock.
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      parent_version_id TEXT, kind TEXT NOT NULL DEFAULT 'version',
      status TEXT NOT NULL DEFAULT 'active', base_manifest JSONB,
      PRIMARY KEY (landscape_id, id))`)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT)`)
    await database.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, 'automerge:root') ON CONFLICT DO NOTHING`,
      [WS.landscapeId, WS.versionId],
    )
  })
  afterAll(async () => { await database?.teardown() })

  beforeEach(async () => {
    repo = new Repo({ network: [] })
    projector = new StaticDeltaProjector(repo, database.pool)
    for (const table of [
      'ro_objects', 'ro_connections', 'read_model_static_documents', 'read_model_static_document_queue',
      'read_model_overlay_segments', 'read_model_overlay_rotations', 'read_model_static_entity_deltas',
      'ro_workspace_stats', 'automerge_document_workspace',
    ]) {
      await database.pool.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
    }
    await markStaticReadModelWorkspace(database.pool, WS, 'test')
  })
  afterEach(async () => { await projector?.stop() })

  const register = (handle: DocHandle<unknown>, kind: string) =>
    registerStaticReadModelDocuments(database.pool, WS, [{ documentId: handle.documentId, kind: kind as 'object-overlay' }])

  async function dispatch(handle: DocHandle<unknown>, kind: string): Promise<void> {
    const internal = projector as unknown as {
      project(descriptor: Record<string, unknown>, handle: DocHandle<unknown>): Promise<void>
    }
    await internal.project({ ...WS, documentId: handle.documentId, kind, entityId: null, orgId: null }, handle)
  }

  /** A storage write's enqueue, as production does it: a new revision. */
  async function enqueue(handle: DocHandle<unknown>, revision: number): Promise<void> {
    await database.pool.query(
      `INSERT INTO read_model_static_document_queue (landscape_id, version_id, document_id, revision)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE SET revision = EXCLUDED.revision`,
      [WS.landscapeId, WS.versionId, handle.documentId, revision],
    )
  }

  const projectedRevision = async (handle: DocHandle<unknown>) => Number((await database.pool.query<{ projected_revision: string }>(
    `SELECT projected_revision FROM read_model_static_document_queue
     WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
    [WS.landscapeId, WS.versionId, handle.documentId],
  )).rows[0]?.projected_revision ?? -1)

  /** The segment row of a document as the ModelMeta pass would restore it:
   * null when there is none, else its revision and snapshot. */
  const segmentRow = async (documentId: string) => (await database.pool.query<{ revision: string; snapshot: Record<string, unknown> }>(
    `SELECT last_projected_revision::text AS revision, last_projected_snapshot AS snapshot
     FROM read_model_overlay_segments WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
    [WS.landscapeId, WS.versionId, documentId],
  )).rows[0] ?? null

  async function until(what: string, predicate: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!(await predicate()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(await predicate(), what).toBe(true)
  }

  const objectName = async (id: string) => (await roObject(database.pool, WS, id) as { name?: string } | undefined)?.name
  const connectionLabel = async (id: string) => (await roConnection(database.pool, WS, id) as { label?: string } | undefined)?.label

  /**
   * The stack's sequence, driven by the real `start()`: a workspace whose
   * object head was written on the ordinary plane, admitted with NO segment
   * snapshot, rows already served for it (the promotion's cold build). The
   * projector starts, the startup rotation publishes a new head, the user
   * renames in the new head.
   */
  async function enterTheStaticPlane(options: { oldHeadSnapshotRecorded: boolean }) {
    const oldHead = repo.create<ObjectHead>({
      objects: { o1: { id: 'o1', name: 'Before' }, o2: { id: 'o2', name: 'Only in the old head' } },
      writeHeadVersion: 1, writeBatchIds: [],
    })
    const meta = repo.create<Record<string, unknown>>({
      groups: {}, editsObjectShardUrls: [oldHead.url], editsObjectShardUrl: oldHead.url,
    })
    await register(meta as DocHandle<unknown>, 'model-meta')
    await register(oldHead as DocHandle<unknown>, 'object-overlay')
    // The cold build served `o1`. `o2` is deliberately NOT served: a pass
    // that completes the chain from the documents is a FULL pass, and only a
    // full pass upserts an entity of the old head that nothing shadows.
    await upsertObjects(database.pool, WS, null, [{ id: 'o1', name: 'Before' }] as never)
    if (options.oldHeadSnapshotRecorded) {
      await recordOverlaySegmentProjection(database.pool, WS, 'object', oldHead.documentId, 1, oldHead.doc()!.objects)
    }
    // A 300 ms reload, so a tick re-derives the rotation obligation once the
    // ModelMeta pass has installed the current heads; a 50 ms rotation quiet.
    projector = new StaticDeltaProjector(
      repo, database.pool, 250, 300, () => true, undefined, undefined, undefined, undefined, 50, 100,
    )
    await projector.start()
    let newUrl: string | undefined
    await until('control: the startup rotation published a new object head', () => {
      newUrl = readMetaUrl(meta.doc(), 'editsObjectShardUrl')
      return Boolean(newUrl && newUrl !== oldHead.url)
    })
    const newHead = await repo.find<ObjectHead>(newUrl as AutomergeUrl)
    return { oldHead, newHead, meta }
  }

  // THE MUTANT this file exists to kill: "a retired head without a segment
  // ⇒ `!ready`" — the code before T-SUM-0b. On it, `o1` stays "Before", the
  // new head's queue row stays at 0, and nothing is logged.
  it('a rename written in the head the startup rotation published reaches ro_objects, the old head having no snapshot', async () => {
    const { oldHead, newHead } = await enterTheStaticPlane({ oldHeadSnapshotRecorded: false })
    const before = await segmentRow(oldHead.documentId)
    expect(before === null || (before.revision === '0' && JSON.stringify(before.snapshot) === '{}'),
      `control: the old head has no projected snapshot (${JSON.stringify(before)})`).toBe(true)

    await enqueue(newHead as DocHandle<unknown>, 10)
    newHead.change((doc) => {
      if (!doc.objects) doc.objects = {}
      doc.objects.o1 = { id: 'o1', name: 'After' }
    })
    await until('the rename reached ro_objects', async () => await objectName('o1') === 'After')
    await until('the new head\'s queue row is acknowledged', async () => await projectedRevision(newHead as DocHandle<unknown>) === 10)
    expect(await objectName('o2'), 'the pass that completed the chain was a FULL one').toBe('Only in the old head')
    expect((await segmentRow(oldHead.documentId))?.snapshot, 'the old head\'s snapshot is now recorded, from its document')
      .toEqual(oldHead.doc()!.objects)
    expect(projector.notReadyOverlaySnapshot().heads, 'nothing is reported blocked').toBe(0)
  }, 30_000)

  // CONTROL (green on the code before T-SUM-0b too): the same sequence with
  // the old head's snapshot recorded. The oracle can say "projected", and the
  // only difference with the case above is the snapshot.
  it('control: with the old head\'s snapshot recorded, the same rename reaches ro_objects', async () => {
    const { newHead } = await enterTheStaticPlane({ oldHeadSnapshotRecorded: true })
    await enqueue(newHead as DocHandle<unknown>, 10)
    newHead.change((doc) => {
      if (!doc.objects) doc.objects = {}
      doc.objects.o1 = { id: 'o1', name: 'After' }
    })
    await until('the rename reached ro_objects', async () => await objectName('o1') === 'After')
    await until('the new head\'s queue row is acknowledged', async () => await projectedRevision(newHead as DocHandle<unknown>) === 10)
  }, 30_000)

  // The connection half: the bookkeeping row `synchronizeOverlayHead` leaves
  // for the old head (`'{}'` at revision 0) must not be restored as "projected,
  // and empty". Observable when the current head deletes a key the old head
  // also holds: the effective value falls back to the old head's, which an
  // empty baseline turns into a DELETE of a connection every client still
  // merges from the old head.
  it('a bookkeeping segment row (`\'{}\'` at revision 0) is not a projected empty snapshot: a delete falls back to the old head', async () => {
    const oldHead = repo.create<ConnectionHead>({
      connections: { c1: { id: 'c1', fromId: 'o1', toId: 'o2', label: 'from the old head' } },
      writeHeadVersion: 2, writeBatchIds: [],
    })
    const newHead = repo.create<ConnectionHead>({
      connections: { c1: { id: 'c1', fromId: 'o1', toId: 'o2', label: 'override' } },
      writeHeadVersion: 2, writeBatchIds: [],
    })
    const meta = repo.create<Record<string, unknown>>({
      groups: {}, editsConnectionShardUrls: [oldHead.url, newHead.url], editsConnectionShardUrl: newHead.url,
    })
    for (const [handle, kind] of [[meta, 'model-meta'], [oldHead, 'connection-overlay'], [newHead, 'connection-overlay']] as const) {
      await register(handle as DocHandle<unknown>, kind)
    }
    // The production writer of the bookkeeping rows, in the stack's order:
    // the old head while it was current, then the new one.
    await synchronizeOverlayHead(database.pool, WS, 'connection', oldHead.url)
    await synchronizeOverlayHead(database.pool, WS, 'connection', newHead.url)
    expect(await segmentRow(oldHead.documentId), 'control: the bookkeeping row').toEqual({ revision: '0', snapshot: {} })
    await upsertConnections(database.pool, WS, null, [{ id: 'c1', fromId: 'o1', toId: 'o2', label: 'from the old head' }] as never)

    await enqueue(meta as DocHandle<unknown>, 1)
    await dispatch(meta as DocHandle<unknown>, 'model-meta')
    await enqueue(newHead as DocHandle<unknown>, 1)
    await dispatch(newHead as DocHandle<unknown>, 'connection-overlay')
    expect(await connectionLabel('c1'), 'control: the new head\'s override is served').toBe('override')

    newHead.change((doc) => { delete doc.connections.c1 })
    await enqueue(newHead as DocHandle<unknown>, 2)
    await dispatch(newHead as DocHandle<unknown>, 'connection-overlay')
    expect(await projectedRevision(newHead as DocHandle<unknown>), 'control: the delete pass was acknowledged').toBe(2)
    expect(await connectionLabel('c1'), 'the old head still holds c1: the row falls back to it').toBe('from the old head')
  }, 30_000)

  // A hole that cannot be filled — the old head has a PENDING revision, its
  // own pass owns it — keeps the head `!ready`, and that is no longer silent.
  // Then the old head is acknowledged and the next pass completes the chain.
  it('a pending old head is left to its own pass: the new head stays `!ready`, reported by the gauge and the log, until it is acknowledged', async () => {
    const oldHead = repo.create<ObjectHead>({
      objects: { o1: { id: 'o1', name: 'Before' } }, writeHeadVersion: 2, writeBatchIds: [],
    })
    const newHead = repo.create<ObjectHead>({ objects: {}, writeHeadVersion: 2, writeBatchIds: [] })
    const meta = repo.create<Record<string, unknown>>({
      groups: {}, editsObjectShardUrls: [oldHead.url, newHead.url], editsObjectShardUrl: newHead.url,
    })
    for (const [handle, kind] of [[meta, 'model-meta'], [oldHead, 'object-overlay'], [newHead, 'object-overlay']] as const) {
      await register(handle as DocHandle<unknown>, kind)
    }
    await upsertObjects(database.pool, WS, null, [{ id: 'o1', name: 'Before' }] as never)
    await enqueue(oldHead as DocHandle<unknown>, 3) // pending: 3 > 0
    await enqueue(meta as DocHandle<unknown>, 1)
    await dispatch(meta as DocHandle<unknown>, 'model-meta')

    await enqueue(newHead as DocHandle<unknown>, 1)
    newHead.change((doc) => { doc.objects.o1 = { id: 'o1', name: 'After' } })
    const t0 = 1_900_000_000_000
    const passAt = async (offsetMs: number) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(t0 + offsetMs)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await dispatch(newHead as DocHandle<unknown>, 'object-overlay')
        return warn.mock.calls.map((call) => String(call[0]))
          .filter((line) => line.includes('read_model.static_overlay_not_ready'))
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      } finally {
        warn.mockRestore()
        now.mockRestore()
      }
    }
    expect(await passAt(0), 'a fresh block logs nothing').toEqual([])
    expect(await objectName('o1'), 'blocked: the rename is not served').toBe('Before')
    expect(await projectedRevision(newHead as DocHandle<unknown>), 'blocked: not acknowledged').toBe(0)
    expect(projector.notReadyOverlaySnapshot(t0 + 10_000), 'the gauge reports the head at once').toEqual({ heads: 1, oldestAgeMs: 10_000 })
    expect(await passAt(31_000), 'past 30 s: one line naming the missing segment').toEqual([{
      event: 'read_model.static_overlay_not_ready',
      landscapeId: WS.landscapeId, versionId: WS.versionId, kind: 'object', documentId: newHead.documentId,
      blockedForMs: 31_000, missingSegments: 1, missingSegmentIds: [oldHead.documentId],
    }])
    expect(await passAt(60_000), 'rate-limited').toEqual([])
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0 + 100_000)
    try {
      const samples = staticOverlayNotReadyMetricSamples()
      expect(samples.find((sample) => sample.name === 'maplespire_read_model_static_overlay_heads_not_ready')?.values,
        'the /metrics default reads the live projector').toEqual([{ value: 1 }])
      expect(samples.find((sample) => sample.name === 'maplespire_read_model_static_overlay_heads_not_ready_oldest_seconds')?.values)
        .toEqual([{ value: 100 }])
    } finally {
      now.mockRestore()
    }

    // The old head's own pass acknowledges it (here, by hand); the next pass
    // of the new head reads it from its document and completes the chain.
    await database.pool.query(
      `UPDATE read_model_static_document_queue SET projected_revision = revision
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [WS.landscapeId, WS.versionId, oldHead.documentId],
    )
    await dispatch(newHead as DocHandle<unknown>, 'object-overlay')
    expect(await objectName('o1'), 'unblocked: the rename is served').toBe('After')
    expect(await projectedRevision(newHead as DocHandle<unknown>)).toBe(1)
    expect(projector.notReadyOverlaySnapshot().heads, 'and no longer reported').toBe(0)
    expect((await segmentRow(oldHead.documentId))?.revision, 'recorded at the revision it was read at').toBe('3')
  }, 30_000)

  // The same, on the CONNECTION branch: its own block, its own gauge entry,
  // its own record of the materialised segment (findings M10a, M13/M16).
  it('connection: a pending old head blocks, is reported, and once acknowledged the chain completes and is recorded', async () => {
    const oldHead = repo.create<ConnectionHead>({
      connections: { c1: { id: 'c1', fromId: 'o1', toId: 'o2', label: 'Before' } }, writeHeadVersion: 2, writeBatchIds: [],
    })
    const newHead = repo.create<ConnectionHead>({ connections: {}, writeHeadVersion: 2, writeBatchIds: [] })
    const meta = repo.create<Record<string, unknown>>({
      groups: {}, editsConnectionShardUrls: [oldHead.url, newHead.url], editsConnectionShardUrl: newHead.url,
    })
    for (const [handle, kind] of [[meta, 'model-meta'], [oldHead, 'connection-overlay'], [newHead, 'connection-overlay']] as const) {
      await register(handle as DocHandle<unknown>, kind)
    }
    await upsertConnections(database.pool, WS, null, [{ id: 'c1', fromId: 'o1', toId: 'o2', label: 'Before' }] as never)
    await enqueue(oldHead as DocHandle<unknown>, 4) // pending
    await enqueue(meta as DocHandle<unknown>, 1)
    await dispatch(meta as DocHandle<unknown>, 'model-meta')
    await enqueue(newHead as DocHandle<unknown>, 1)
    newHead.change((doc) => { doc.connections.c2 = { id: 'c2', fromId: 'o2', toId: 'o1', label: 'New' } })
    await dispatch(newHead as DocHandle<unknown>, 'connection-overlay')
    expect(await connectionLabel('c2'), 'blocked').toBeUndefined()
    expect(projector.notReadyOverlaySnapshot().heads, 'the connection head is reported').toBe(1)

    await database.pool.query(
      `UPDATE read_model_static_document_queue SET projected_revision = revision
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [WS.landscapeId, WS.versionId, oldHead.documentId],
    )
    await dispatch(newHead as DocHandle<unknown>, 'connection-overlay')
    expect(await connectionLabel('c2'), 'unblocked').toBe('New')
    expect(await connectionLabel('c1')).toBe('Before')
    expect(projector.notReadyOverlaySnapshot().heads, 'and cleared').toBe(0)
    expect(await segmentRow(oldHead.documentId), 'the old head recorded, at its revision, from its document')
      .toEqual({ revision: '4', snapshot: oldHead.doc()!.connections })
  }, 30_000)

  // Reviewer F1, measured on the first draft (which made the pass full by
  // dropping the head's own entry): a key the head REMOVED since its last
  // projection, with no ModelMeta tombstone, kept its row for good.
  it('the full pass that completes the chain still deletes a key the head removed since its last projection', async () => {
    const oldHead = repo.create<ObjectHead>({ objects: { a1: { id: 'a1', name: 'A1' } }, writeHeadVersion: 2, writeBatchIds: [] })
    const head = repo.create<ObjectHead>({
      objects: { k: { id: 'k', name: 'K' }, j: { id: 'j', name: 'J' } }, writeHeadVersion: 2, writeBatchIds: [],
    })
    const meta = repo.create<Record<string, unknown>>({
      groups: {}, editsObjectShardUrls: [oldHead.url, head.url], editsObjectShardUrl: head.url,
    })
    for (const [handle, kind] of [[meta, 'model-meta'], [oldHead, 'object-overlay'], [head, 'object-overlay']] as const) {
      await register(handle as DocHandle<unknown>, kind)
    }
    // The old head: a bookkeeping row only. The head: projected at revision
    // 1 with `{k, j}`, rows served.
    await synchronizeOverlayHead(database.pool, WS, 'object', oldHead.url)
    await synchronizeOverlayHead(database.pool, WS, 'object', head.url)
    await recordOverlaySegmentProjection(database.pool, WS, 'object', head.documentId, 1, head.doc()!.objects)
    await enqueue(head as DocHandle<unknown>, 1)
    await database.pool.query(
      `UPDATE read_model_static_document_queue SET projected_revision = 1
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [WS.landscapeId, WS.versionId, head.documentId],
    )
    await upsertObjects(database.pool, WS, null, [{ id: 'a1', name: 'A1' }, { id: 'k', name: 'K' }, { id: 'j', name: 'J' }] as never)
    await enqueue(meta as DocHandle<unknown>, 1)
    await dispatch(meta as DocHandle<unknown>, 'model-meta')

    head.change((doc) => { delete doc.objects.k })
    await enqueue(head as DocHandle<unknown>, 2)
    await dispatch(head as DocHandle<unknown>, 'object-overlay')
    expect(await projectedRevision(head as DocHandle<unknown>), 'control: the pass applied').toBe(2)
    expect((await segmentRow(oldHead.documentId))?.snapshot, 'control: the chain was completed from the document')
      .toEqual(oldHead.doc()!.objects)
    expect(await objectName('k'), 'the removed key\'s row is deleted').toBeUndefined()
    expect(await objectName('j')).toBe('J')
    expect(await objectName('a1')).toBe('A1')
  }, 30_000)

  // A segment read on a pass that then stays
  // `!ready` (another hole pending) was kept in memory and never recorded.
  it('a segment read on a pass that stays `!ready` is recorded by the pass that completes the chain', async () => {
    const settled = repo.create<ObjectHead>({ objects: { s1: { id: 's1', name: 'S1' } }, writeHeadVersion: 2, writeBatchIds: [] })
    const pending = repo.create<ObjectHead>({ objects: { p1: { id: 'p1', name: 'P1' } }, writeHeadVersion: 2, writeBatchIds: [] })
    const head = repo.create<ObjectHead>({ objects: {}, writeHeadVersion: 2, writeBatchIds: [] })
    const meta = repo.create<Record<string, unknown>>({
      groups: {}, editsObjectShardUrls: [settled.url, pending.url, head.url], editsObjectShardUrl: head.url,
    })
    for (const [handle, kind] of [[meta, 'model-meta'], [settled, 'object-overlay'], [pending, 'object-overlay'], [head, 'object-overlay']] as const) {
      await register(handle as DocHandle<unknown>, kind)
    }
    await enqueue(pending as DocHandle<unknown>, 2)
    await enqueue(meta as DocHandle<unknown>, 1)
    await dispatch(meta as DocHandle<unknown>, 'model-meta')
    await enqueue(head as DocHandle<unknown>, 1)
    head.change((doc) => { doc.objects.h1 = { id: 'h1', name: 'H1' } })
    await dispatch(head as DocHandle<unknown>, 'object-overlay')
    expect(await objectName('h1'), 'control: blocked on the pending segment').toBeUndefined()

    await database.pool.query(
      `UPDATE read_model_static_document_queue SET projected_revision = revision
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [WS.landscapeId, WS.versionId, pending.documentId],
    )
    await dispatch(head as DocHandle<unknown>, 'object-overlay')
    expect(await objectName('h1'), 'control: unblocked').toBe('H1')
    expect((await segmentRow(settled.documentId))?.snapshot, 'the segment read on the blocked pass is recorded too')
      .toEqual(settled.doc()!.objects)
    expect((await segmentRow(pending.documentId))?.snapshot).toEqual(pending.doc()!.objects)
  }, 30_000)
})
