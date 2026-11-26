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
 * G4-16f: a static publish that APPLIED NOTHING
 * must never be acknowledged as projected by its retry.
 *
 * Each pass moves in-memory derived state ahead of its publish — the
 * ModelMeta pass its tombstone baselines and (after it) its semantic
 * fingerprint; the overlay passes `segments` and `effective`
 * (`updateStaticOverlaySegment`). When the publish then gave up (the mutex
 * held elsewhere: `false`) or lost the plane inside its transaction (an
 * authority loss: `false`, after the action RAN and was rolled back), the
 * queue row stayed pending — and the retry of the same revision found the
 * moved state, computed nothing to write (`metadataUnchanged`, or an empty
 * segment delta) and went to `acknowledgeOnly`, marking it projected. The
 * groups, tombstones and overlay rows of that revision were lost, silently.
 *
 * Each arm: a first pass applies (control), the document changes, the next
 * pass is REFUSED (control: the refusal's own warn line, nothing landed, the
 * queue row still pending), the refusal is lifted, and the SAME revision is
 * re-projected: its rows must land and the queue row must be acknowledged.
 *
 * Real Automerge repo, real StaticDeltaProjector dispatch, real PostgreSQL in
 * an isolated schema; skips without TEST_DATABASE_URL.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import type { PoolClient } from 'pg'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { StaticDeltaProjector, staticOverlayDeferralMetricSamples } from './staticDeltaProjector.js'
import { upsertConnections, upsertDiagrams, upsertObjects } from './projector.js'
import { roConnection, roGroup, roObject } from './queries.js'

const CONNECTION = process.env.TEST_DATABASE_URL
const WS = { landscapeId: 'ls-static-unapplied', versionId: 'v1' }
const MUTEX_KEY = `read-model-projection:${WS.landscapeId}:${WS.versionId}`

type Refusal = 'mutex' | 'authority'
/** The line each refusal logs — the proof that the branch under test ran. */
const REFUSAL_LINE: Record<Refusal, string> = {
  mutex: `[read-model] static projection yielded the mutex for ${WS.landscapeId}/${WS.versionId}`,
  authority: `[read-model] static projection refused for ${WS.landscapeId}/${WS.versionId}`,
}

describe.skipIf(!CONNECTION)('a static publish that applied nothing is re-projected, never acknowledged (Automerge → Postgres)', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let projector: StaticDeltaProjector

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'static_unapplied_publish')
    await ensureReadModelSchema(database.pool)
    // The admission tables' minimal shape, as in
    // `staticDeltaProjector.duplicateIds.integration.test.ts`.
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
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
      'ro_objects', 'ro_connections', 'ro_groups', 'ro_group_objects', 'ro_diagrams',
      'read_model_static_documents', 'read_model_static_document_queue', 'ro_workspace_stats',
      'ro_decision_records', 'read_model_static_entity_deltas', 'read_model_overlay_segments',
    ]) {
      await database.pool.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
    }
    await markStaticReadModelWorkspace(database.pool, WS, 'test')
  })
  afterEach(async () => { await projector?.stop() })

  const register = (handle: DocHandle<unknown>, kind: string) =>
    registerStaticReadModelDocuments(database.pool, WS, [{ documentId: handle.documentId, kind: kind as 'object-overlay' }])

  /** The real dispatch (`project()`), without registering: the authority arm
   * must not touch the workspace row while it holds a lock on it. */
  async function dispatch(handle: DocHandle<unknown>, kind: string, on: StaticDeltaProjector = projector): Promise<void> {
    const internal = on as unknown as {
      project(descriptor: Record<string, unknown>, handle: DocHandle<unknown>): Promise<void>
    }
    await internal.project({ ...WS, documentId: handle.documentId, kind, entityId: null, orgId: null }, handle)
  }

  async function project(handle: DocHandle<unknown>, kind: string): Promise<void> {
    await register(handle, kind)
    await dispatch(handle, kind)
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

  type TombstoneMeta = {
    groups: Record<string, { id: string; name: string; objectIds: string[] }>
    deletedObjectIds: string[]; deletedConnectionIds: string[]; deletedDiagramIds: string[]
  }

  /** The object/connection TOMBSTONE deltas, with the generation that last
   * stamped each: a replay re-stamps them with a new one. */
  const tombstoneDeltas = async () => (await database.pool.query<{ id: string; generation: string }>(
    `SELECT entity_id AS id, generation::text AS generation FROM read_model_static_entity_deltas
     WHERE landscape_id = $1 AND version_id = $2 AND entity_kind IN ('object', 'connection') AND tombstone
     ORDER BY entity_id`, [WS.landscapeId, WS.versionId],
  )).rows

  const decisionTitles = async () => Object.fromEntries((await database.pool.query<{ id: string; title: string }>(
    `SELECT id, title FROM ro_decision_records WHERE landscape_id = $1 AND version_id = $2 ORDER BY id`,
    [WS.landscapeId, WS.versionId],
  )).rows.map((row) => [row.id, row.title]))

  const rowCount = async (table: string) => Number((await database.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId],
  )).rows[0].n)

  const diagramIds = async () => (await database.pool.query<{ id: string }>(
    `SELECT id FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 ORDER BY id`, [WS.landscapeId, WS.versionId],
  )).rows.map((row) => row.id)

  /**
   * Run `pass` (one dispatch of `handle`) while its publish is REFUSED, and
   * return the warn lines it logged. Then lift the refusal.
   *
   *  - `mutex`: another session holds the workspace's projection mutex for
   *    the whole pass; the publish's transaction times out on it
   *    (`PROJECTION_MUTEX_WAIT_MS`), rolls back, and `publish` resolves
   *    `false`.
   *  - `authority`: another session holds the mutex AND has deleted the
   *    static-plane row, uncommitted, so every pre-check of the pass (the
   *    dispatcher's, `publish`'s) still reads the plane as held. Once the
   *    pass is WAITING on the mutex — inside `withReadModelProjectionTransaction`,
   *    past every pre-check — the deletion commits: the publish then takes
   *    the mutex, `assertReadModelPlane` throws a plane error, the
   *    transaction rolls back, and `publish` resolves `false` through its
   *    `isReadModelAuthorityLoss` branch. The plane is then re-granted.
   */
  async function refused(refusal: Refusal, handle: DocHandle<unknown>, kind: string): Promise<string[]> {
    await register(handle, kind)
    const holder = await database.pool.connect()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let open = false
    try {
      await holder.query('BEGIN')
      open = true
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [MUTEX_KEY])
      if (refusal === 'mutex') {
        await dispatch(handle, kind)
      } else {
        await holder.query(
          'DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2',
          [WS.landscapeId, WS.versionId],
        )
        const pass = dispatch(handle, kind)
        const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
        const deadline = Date.now() + 4_000
        let waiting = false
        while (!waiting && Date.now() < deadline) {
          const { rows } = await database.pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND $1 = ANY(pg_blocking_pids(pid))`,
            [holderPid],
          )
          waiting = Number(rows[0].n) > 0
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20))
        }
        // CONTROL: the pass reached the mutex wait, i.e. it is past every
        // pre-check — a refusal BEFORE the transaction would be a different
        // exit (`holdsStaticPlane`), not the authority-loss branch.
        expect(waiting, 'the publish is waiting on the mutex').toBe(true)
        await holder.query('COMMIT')
        open = false
        await pass
      }
      return warn.mock.calls.map((call) => call.map(String).join(' '))
    } finally {
      warn.mockRestore()
      if (open) await holder.query('ROLLBACK')
      holder.release()
      if (refusal === 'authority') {
        await markStaticReadModelWorkspace(database.pool, WS, 'test')
        await register(handle, kind)
      }
    }
  }

  const refusalLogged = (lines: string[], refusal: Refusal) =>
    expect(lines.filter((line) => line.startsWith(REFUSAL_LINE[refusal])), 'control: the refusal ran').toHaveLength(1)

  describe.each(['mutex', 'authority'] as const)('refused by %s', (refusal) => {
    it('ModelMeta: the groups and every tombstone of the refused revision land on the retry', async () => {
      await upsertObjects(database.pool, WS, null, [{ id: 'o1', name: 'O1' }, { id: 'o2', name: 'O2' }])
      await upsertConnections(database.pool, WS, null, [{ id: 'c1', fromId: 'o2', toId: 'o2' }])
      await upsertDiagrams(database.pool, WS, null, [{ id: 'd1', name: 'D1', objectIds: [] }, { id: 'd2', name: 'D2', objectIds: [] }])
      type Meta = {
        groups: Record<string, { id: string; name: string; objectIds: string[] }>
        deletedObjectIds: string[]; deletedConnectionIds: string[]; deletedDiagramIds: string[]
      }
      const meta = repo.create<Meta>({
        groups: { g1: { id: 'g1', name: 'G1', objectIds: [] } },
        deletedObjectIds: [], deletedConnectionIds: [], deletedDiagramIds: [],
      })
      await enqueue(meta, 1)
      await project(meta, 'model-meta')
      expect((await roGroup(database.pool, WS, 'g1'))?.name, 'control: the first pass applied').toBe('G1')
      expect(await projectedRevision(meta)).toBe(1)

      meta.change((doc) => {
        doc.groups.g2 = { id: 'g2', name: 'G2', objectIds: [] }
        doc.deletedObjectIds.push('o1')
        doc.deletedConnectionIds.push('c1')
        doc.deletedDiagramIds.push('d1')
      })
      await enqueue(meta, 2)
      refusalLogged(await refused(refusal, meta, 'model-meta'), refusal)
      // CONTROL: nothing of revision 2 landed, and it is still pending.
      expect(await roGroup(database.pool, WS, 'g2')).toBeUndefined()
      expect(await roObject(database.pool, WS, 'o1')).toBeDefined()
      expect(await roConnection(database.pool, WS, 'c1')).toBeDefined()
      expect(await diagramIds()).toEqual(['d1', 'd2'])
      expect(await projectedRevision(meta)).toBe(1)

      await project(meta, 'model-meta')
      expect((await roGroup(database.pool, WS, 'g2'))?.name, 'the group').toBe('G2')
      expect(await roObject(database.pool, WS, 'o1'), 'the object tombstone').toBeUndefined()
      expect(await roConnection(database.pool, WS, 'c1'), 'the connection tombstone').toBeUndefined()
      expect(await diagramIds(), 'the diagram tombstone').toEqual(['d2'])
      expect(await roObject(database.pool, WS, 'o2'), 'an untombstoned row stays').toBeDefined()
      expect(await projectedRevision(meta)).toBe(2)
    }, 30_000)

    it('an object shard: the upserts and deletes of the refused revision land on the retry', async () => {
      type Head = { objects: Record<string, { id: string; name: string }>; writeHeadVersion: number; writeBatchIds: string[] }
      const head = repo.create<Head>({
        objects: { o1: { id: 'o1', name: 'A' }, o2: { id: 'o2', name: 'B' } }, writeHeadVersion: 1, writeBatchIds: [],
      })
      await enqueue(head, 1)
      await project(head, 'object-overlay')
      expect((await roObject(database.pool, WS, 'o1'))?.name, 'control: the first pass applied').toBe('A')

      head.change((doc) => {
        doc.objects.o1.name = 'A2'
        delete doc.objects.o2
        doc.objects.o3 = { id: 'o3', name: 'C' }
      })
      await enqueue(head, 2)
      refusalLogged(await refused(refusal, head, 'object-overlay'), refusal)
      expect((await roObject(database.pool, WS, 'o1'))?.name, 'control: nothing landed').toBe('A')
      expect(await roObject(database.pool, WS, 'o2')).toBeDefined()
      expect(await roObject(database.pool, WS, 'o3')).toBeUndefined()
      expect(await projectedRevision(head)).toBe(1)

      await project(head, 'object-overlay')
      expect((await roObject(database.pool, WS, 'o1'))?.name, 'the edit').toBe('A2')
      expect(await roObject(database.pool, WS, 'o2'), 'the delete').toBeUndefined()
      expect((await roObject(database.pool, WS, 'o3'))?.name, 'the insert').toBe('C')
      expect(await projectedRevision(head)).toBe(2)
    }, 30_000)

    it('a connection shard: the upserts and deletes of the refused revision land on the retry', async () => {
      type Head = {
        connections: Record<string, { id: string; fromId: string; toId: string; label: string }>
        writeHeadVersion: number; writeBatchIds: string[]
      }
      const head = repo.create<Head>({
        connections: {
          c1: { id: 'c1', fromId: 'o1', toId: 'o2', label: 'A' },
          c2: { id: 'c2', fromId: 'o2', toId: 'o1', label: 'B' },
        },
        writeHeadVersion: 1, writeBatchIds: [],
      })
      await enqueue(head, 1)
      await project(head, 'connection-overlay')
      expect((await roConnection(database.pool, WS, 'c1'))?.label, 'control: the first pass applied').toBe('A')

      head.change((doc) => {
        doc.connections.c1.label = 'A2'
        delete doc.connections.c2
        doc.connections.c3 = { id: 'c3', fromId: 'o1', toId: 'o1', label: 'C' }
      })
      await enqueue(head, 2)
      refusalLogged(await refused(refusal, head, 'connection-overlay'), refusal)
      expect((await roConnection(database.pool, WS, 'c1'))?.label, 'control: nothing landed').toBe('A')
      expect(await roConnection(database.pool, WS, 'c2')).toBeDefined()
      expect(await roConnection(database.pool, WS, 'c3')).toBeUndefined()
      expect(await projectedRevision(head)).toBe(1)

      await project(head, 'connection-overlay')
      expect((await roConnection(database.pool, WS, 'c1'))?.label, 'the edit').toBe('A2')
      expect(await roConnection(database.pool, WS, 'c2'), 'the delete').toBeUndefined()
      expect((await roConnection(database.pool, WS, 'c3'))?.label, 'the insert').toBe('C')
      expect(await projectedRevision(head)).toBe(2)
    }, 30_000)

    // The refused pass's tombstones must survive a SECOND pass that throws
    // after installing its state and before its publish; and once the replay
    // applied, a later pass replays none.
    describe.each([
      ['metaSourceAlreadyProjected', 'projected_revision >= $4 AS projected'],
      ['the ro_groups SELECT', 'SELECT id FROM ro_groups WHERE'],
    ] as const)('then a pass throwing at %s', (_await, sqlFragment) => {
      it('ModelMeta: the tombstones still land on the retry, and a later pass replays none of them', async () => {
        await upsertObjects(database.pool, WS, null, [{ id: 'o0', name: 'O0' }, { id: 'o1', name: 'O1' }, { id: 'o2', name: 'O2' }])
        await upsertConnections(database.pool, WS, null, [{ id: 'c1', fromId: 'o2', toId: 'o2' }])
        // `o0` is tombstoned AND APPLIED by the first pass: the retry below
        // must not replay it — only what was never applied.
        const meta = repo.create<TombstoneMeta>({
          groups: { g1: { id: 'g1', name: 'G1', objectIds: [] } },
          deletedObjectIds: ['o0'], deletedConnectionIds: [], deletedDiagramIds: [],
        })
        await enqueue(meta, 1)
        await project(meta, 'model-meta')
        expect(await projectedRevision(meta), 'control: the first pass applied').toBe(1)
        expect(await roObject(database.pool, WS, 'o0'), 'control: the first pass applied its tombstone').toBeUndefined()
        const applied = await tombstoneDeltas()
        expect(applied.map((row) => row.id)).toEqual(['o0'])

        meta.change((doc) => {
          doc.groups.g2 = { id: 'g2', name: 'G2', objectIds: [] }
          doc.deletedObjectIds.push('o1')
          doc.deletedConnectionIds.push('c1')
        })
        await enqueue(meta, 2)
        refusalLogged(await refused(refusal, meta, 'model-meta'), refusal)
        expect(await roObject(database.pool, WS, 'o1'), 'control: the refused pass deleted nothing').toBeDefined()

        // The second pass installs its state, then one await throws.
        const query = database.pool.query.bind(database.pool)
        let injected = 0
        const spy = vi.spyOn(database.pool, 'query').mockImplementation(((text: unknown, ...rest: unknown[]) => {
          if (typeof text === 'string' && text.includes(sqlFragment) && injected === 0) {
            injected += 1
            return Promise.reject(new Error('injected failure'))
          }
          return (query as (...args: unknown[]) => unknown)(text, ...rest)
        }) as typeof database.pool.query)
        try {
          await expect(dispatch(meta, 'model-meta')).rejects.toThrow('injected failure')
        } finally {
          spy.mockRestore()
        }
        expect(injected, 'control: the failure was injected at that await').toBe(1)
        expect(await roObject(database.pool, WS, 'o1'), 'control: the throwing pass deleted nothing').toBeDefined()
        expect(await projectedRevision(meta)).toBe(1)

        await dispatch(meta, 'model-meta')
        expect((await roGroup(database.pool, WS, 'g2'))?.name, 'the group').toBe('G2')
        expect(await roObject(database.pool, WS, 'o1'), 'the object tombstone').toBeUndefined()
        expect(await roConnection(database.pool, WS, 'c1'), 'the connection tombstone').toBeUndefined()
        expect(await projectedRevision(meta)).toBe(2)
        const replayed = await tombstoneDeltas()
        expect(replayed.map((row) => row.id), 'control: the replay recorded both tombstones').toEqual(['c1', 'o0', 'o1'])
        expect(replayed.find((row) => row.id === 'o0'), 'the APPLIED tombstone was not replayed').toEqual(applied[0])

        // Finding 2: the applied baseline advanced, so an unrelated change
        // re-stamps neither tombstone (and so is not a `reset all`).
        meta.change((doc) => { doc.groups.g3 = { id: 'g3', name: 'G3', objectIds: [] } })
        await enqueue(meta, 3)
        await project(meta, 'model-meta')
        expect((await roGroup(database.pool, WS, 'g3'))?.name, 'control: the third pass applied').toBe('G3')
        expect(await tombstoneDeltas(), 'no tombstone replayed').toEqual(replayed)
      }, 30_000)
    })

    it('ModelMeta: an id un-tombstoned by a REFUSED revision leaves the applied baseline, so its re-tombstone is applied', async () => {
      await upsertObjects(database.pool, WS, null, [{ id: 'o1', name: 'O1' }])
      const meta = repo.create<TombstoneMeta>({
        groups: {}, deletedObjectIds: ['o1'], deletedConnectionIds: [], deletedDiagramIds: [],
      })
      await enqueue(meta, 1)
      await project(meta, 'model-meta')
      expect(await roObject(database.pool, WS, 'o1'), 'control: the tombstone applied').toBeUndefined()

      // A forward resurrects o1 (`removeTombstonesInPlace`); that ModelMeta
      // revision is refused, and the overlay serves o1 again meanwhile.
      meta.change((doc) => { doc.deletedObjectIds.splice(0, 1) })
      await enqueue(meta, 2)
      refusalLogged(await refused(refusal, meta, 'model-meta'), refusal)
      await upsertObjects(database.pool, WS, null, [{ id: 'o1', name: 'O1 again' }])

      // The user deletes it again before the retry.
      meta.change((doc) => { doc.deletedObjectIds.push('o1') })
      await enqueue(meta, 3)
      await project(meta, 'model-meta')
      expect(await projectedRevision(meta)).toBe(3)
      expect(await roObject(database.pool, WS, 'o1'), 'the re-tombstone is applied').toBeUndefined()
    }, 30_000)

    it('ModelMeta: a decision record edited, inserted and deleted by the refused revision lands on the retry', async () => {
      type Meta = {
        groups: Record<string, never>
        decisionRecords: Record<string, { id: string; title: string; status: string }>
        deletedDecisionRecordIds: string[]
      }
      const meta = repo.create<Meta>({
        groups: {},
        decisionRecords: {
          dr1: { id: 'dr1', title: 'One', status: 'proposed' },
          dr2: { id: 'dr2', title: 'Two', status: 'proposed' },
        },
        deletedDecisionRecordIds: [],
      })
      await enqueue(meta, 1)
      await project(meta, 'model-meta')
      expect(await decisionTitles(), 'control: the first pass applied').toEqual({ dr1: 'One', dr2: 'Two' })

      meta.change((doc) => {
        doc.decisionRecords.dr1.title = 'One edited'
        doc.decisionRecords.dr3 = { id: 'dr3', title: 'Three', status: 'accepted' }
        delete doc.decisionRecords.dr2
        doc.deletedDecisionRecordIds.push('dr2')
      })
      await enqueue(meta, 2)
      refusalLogged(await refused(refusal, meta, 'model-meta'), refusal)
      expect(await decisionTitles(), 'control: nothing landed').toEqual({ dr1: 'One', dr2: 'Two' })
      expect(await projectedRevision(meta)).toBe(1)

      await project(meta, 'model-meta')
      expect(await decisionTitles()).toEqual({ dr1: 'One edited', dr3: 'Three' })
      expect(await projectedRevision(meta)).toBe(2)
    }, 30_000)

    // After a refused publish, nothing that belongs to an
    // APPLIED one runs — the `forwardedBatchIds` prune (a write to the user's
    // document), the duplicate-id log, the head rotation.
    describe.each([
      ['object', 'object-overlay'],
      ['connection', 'connection-overlay'],
    ] as const)('a %s shard', (collection, kind) => {
      it('refused: forwardedBatchIds stay, no duplicate-id log, no rotation; the retry does all three', async () => {
        type Entity = { id: string; name: string; fromId?: string; toId?: string }
        type Head = Record<string, unknown> & { writeHeadVersion: number; writeBatchIds: string[]; forwardedBatchIds?: string[] }
        const field = collection === 'object' ? 'objects' : 'connections'
        const entity = (id: string, name: string): Entity => collection === 'object'
          ? { id, name }
          : { id, name, fromId: 'o1', toId: 'o2' }
        // `aa` is a twin of `e1`: one inner id under two keys.
        const head = repo.create<Head>({
          [field]: { e1: entity('e1', 'A'), aa: entity('e1', 'TWIN'), e2: entity('e2', 'B') },
          writeHeadVersion: 1, writeBatchIds: [], forwardedBatchIds: ['batch-forwarded'],
        })
        // The current write head, so the rotation check would run on it.
        const meta = repo.create<Record<string, unknown>>({
          groups: {},
          [collection === 'object' ? 'editsObjectShardUrls' : 'editsConnectionShardUrls']: [head.url],
          [collection === 'object' ? 'editsObjectShardUrl' : 'editsConnectionShardUrl']: head.url,
        })
        await enqueue(meta, 1)
        await project(meta, 'model-meta')
        await enqueue(head, 1)
        await project(head, kind)
        expect(await projectedRevision(head), 'control: the first pass applied').toBe(1)
        // The first pass pruned the ids it saw; put one back for the next.
        head.change((doc) => {
          doc.forwardedBatchIds = ['batch-forwarded-2']
          ;(doc[field] as Record<string, Entity>).e1.name = 'A2'
        })
        await enqueue(head, 2)

        const internal = projector as unknown as { maybeRotateOverlayHead: (...args: unknown[]) => Promise<void> }
        const rotate = vi.spyOn(internal, 'maybeRotateOverlayHead')
        const lines = await refused(refusal, head, kind)
        refusalLogged(lines, refusal)
        expect(head.doc()!.forwardedBatchIds, 'the prune did not run').toEqual(['batch-forwarded-2'])
        expect(lines.filter((line) => line.includes('duplicate id(s)')), 'no duplicate-id log').toEqual([])
        expect(rotate, 'no rotation').not.toHaveBeenCalled()
        expect(await projectedRevision(head)).toBe(1)

        // CONTROL: the applied retry does all three, so each assertion above
        // can fail.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
          await project(head, kind)
          expect(warn.mock.calls.map((call) => call.map(String).join(' '))
            .filter((line) => line.includes('duplicate id(s)')), 'control: the retry logs the twin').toHaveLength(1)
        } finally {
          warn.mockRestore()
        }
        expect(head.doc()!.forwardedBatchIds, 'control: the retry pruned').toBeUndefined()
        expect(rotate, 'control: the retry reached the rotation check').toHaveBeenCalledTimes(1)
        expect(await projectedRevision(head)).toBe(2)
        rotate.mockRestore()
      }, 30_000)
    })
  })

  // Pinned: a PLAIN error thrown inside the publish's
  // transaction — not an authority loss — reverts too, and the retry lands.
  describe('a plain error thrown inside the transaction', () => {
    async function failing<T>(table: string, run: () => Promise<T>): Promise<void> {
      await database.pool.query(`CREATE OR REPLACE FUNCTION r6_injected_failure() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected trigger failure'; END $$`)
      await database.pool.query(`CREATE TRIGGER r6_injected_failure BEFORE INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION r6_injected_failure()`)
      try {
        await expect(run()).rejects.toThrow('injected trigger failure')
      } finally {
        await database.pool.query(`DROP TRIGGER IF EXISTS r6_injected_failure ON ${table}`)
      }
    }

    it('an object shard: the edit lands on the retry', async () => {
      type Head = { objects: Record<string, { id: string; name: string }>; writeHeadVersion: number; writeBatchIds: string[] }
      const head = repo.create<Head>({ objects: { o1: { id: 'o1', name: 'A' } }, writeHeadVersion: 1, writeBatchIds: [] })
      await enqueue(head, 1)
      await project(head, 'object-overlay')
      head.change((doc) => {
        doc.objects.o1.name = 'A2'
        doc.objects.o2 = { id: 'o2', name: 'B' }
      })
      await enqueue(head, 2)
      await failing('ro_objects', () => project(head, 'object-overlay'))
      expect((await roObject(database.pool, WS, 'o1'))?.name, 'control: nothing landed').toBe('A')
      expect(await projectedRevision(head)).toBe(1)

      await project(head, 'object-overlay')
      expect((await roObject(database.pool, WS, 'o1'))?.name).toBe('A2')
      expect((await roObject(database.pool, WS, 'o2'))?.name).toBe('B')
      expect(await projectedRevision(head)).toBe(2)
    }, 30_000)

    it('ModelMeta: the group and the tombstone land on the retry', async () => {
      await upsertObjects(database.pool, WS, null, [{ id: 'o1', name: 'O1' }])
      const meta = repo.create<TombstoneMeta>({
        groups: {}, deletedObjectIds: [], deletedConnectionIds: [], deletedDiagramIds: [],
      })
      await enqueue(meta, 1)
      await project(meta, 'model-meta')
      meta.change((doc) => {
        doc.groups.g1 = { id: 'g1', name: 'G1', objectIds: [] }
        doc.deletedObjectIds.push('o1')
      })
      await enqueue(meta, 2)
      await failing('ro_groups', () => project(meta, 'model-meta'))
      expect(await roObject(database.pool, WS, 'o1'), 'control: nothing landed').toBeDefined()
      expect(await projectedRevision(meta)).toBe(1)

      await project(meta, 'model-meta')
      expect((await roGroup(database.pool, WS, 'g1'))?.name).toBe('G1')
      expect(await roObject(database.pool, WS, 'o1')).toBeUndefined()
      expect(await projectedRevision(meta)).toBe(2)
    }, 30_000)
  })

  // On a restart or takeover the pending
  // overlay row can be projected BEFORE the ModelMeta pass installs the
  // workspace's overlay state. It must not project against a self-only
  // state: a key removed from the shard would never be deleted.
  it('an overlay pass before the ModelMeta state defers, and the ModelMeta pass re-triggers it: a removed key is deleted', async () => {
    type Head = { objects: Record<string, { id: string; name: string }>; writeHeadVersion: number; writeBatchIds: string[] }
    const head = repo.create<Head>({
      objects: { o1: { id: 'o1', name: 'A' }, o2: { id: 'o2', name: 'B' } }, writeHeadVersion: 1, writeBatchIds: [],
    })
    const meta = repo.create<Record<string, unknown>>({
      groups: {}, editsObjectShardUrls: [head.url], editsObjectShardUrl: head.url,
    })
    await enqueue(meta, 1)
    await project(meta, 'model-meta')
    await enqueue(head, 1)
    await project(head, 'object-overlay')
    expect(await rowCount('ro_objects'), 'control: the first projector applied').toBe(2)

    // The key is removed while no projector runs; then a NEW projector (a
    // restart, a takeover) sees the pending overlay row first.
    head.change((doc) => { delete doc.objects.o2 })
    await enqueue(head, 2)
    await projector.stop()
    const restarted = new StaticDeltaProjector(repo, database.pool)
    try {
      const internal = restarted as unknown as {
        reloadDescriptors(): Promise<void>
        attach(handle: DocHandle<unknown>): void
      }
      await internal.reloadDescriptors()
      internal.attach(head as DocHandle<unknown>)
      await dispatch(head, 'object-overlay', restarted)
      expect.soft(await projectedRevision(head), 'the overlay pass deferred: still pending').toBe(1)
      expect(await roObject(database.pool, WS, 'o2'), 'control: o2 still served').toBeDefined()

      await dispatch(meta, 'model-meta', restarted)
      // The overlay is re-run by the ModelMeta pass, not by this test.
      const deadline = Date.now() + 10_000
      while (await projectedRevision(head) < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(await projectedRevision(head), 'the deferred overlay was re-triggered and acknowledged').toBe(2)
      expect(await roObject(database.pool, WS, 'o2'), 'the removed key is deleted').toBeUndefined()
      expect((await roObject(database.pool, WS, 'o1'))?.name).toBe('A')
    } finally {
      await restarted.stop()
    }
  }, 30_000)

  // ---------------------------------------------------------------------
  // The ModelMeta tombstone seed and the overlay deferral.
  // ---------------------------------------------------------------------
  describe('the tombstone seed and the overlay deferral', () => {
    /** Another workspace holding rows under the SAME ids as `WS`: an unscoped
     * seed would read them as `WS`'s. */
    const OTHER = { landscapeId: 'ls-static-unapplied-other', versionId: 'v1' }
    /** The SAME landscape, another version: an id-and-landscape match with a
     * different `version_id`. */
    const SIBLING = { landscapeId: WS.landscapeId, versionId: 'v2' }

    beforeEach(async () => {
      for (const workspace of [OTHER, SIBLING]) {
        for (const table of ['ro_objects', 'ro_connections', 'ro_workspace_stats']) {
          await database.pool.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [workspace.landscapeId, workspace.versionId])
        }
      }
      await database.pool.query(`DELETE FROM read_model_change_events WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
    })

    type Internal = {
      reloadDescriptors(): Promise<void>
      attach(handle: DocHandle<unknown>): void
      docRuns: Map<string, { running: boolean; pending: boolean }>
    }

    /** A new projector over the same repo and database, as after a restart
     * or a takeover: descriptors loaded, nothing attached. Replaces
     * `projector`, so `afterEach` stops it. */
    async function restart(): Promise<{ restarted: StaticDeltaProjector; internal: Internal }> {
      await projector.stop()
      const restarted = new StaticDeltaProjector(repo, database.pool)
      projector = restarted
      const internal = restarted as unknown as Internal
      await internal.reloadDescriptors()
      return { restarted, internal }
    }

    async function until(what: string, predicate: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
      const deadline = Date.now() + ms
      while (!(await predicate()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
      expect(await predicate(), what).toBe(true)
    }

    const idle = (internal: Internal, handle: DocHandle<unknown>) => {
      const run = internal.docRuns.get(handle.documentId)
      return Boolean(run && !run.running && !run.pending)
    }

    const changeEvents = async () => (await database.pool.query<{ generation: string; change_kind: string; payload: Record<string, unknown> }>(
      `SELECT generation::text, change_kind, payload FROM read_model_change_events
       WHERE landscape_id = $1 AND version_id = $2 ORDER BY generation`, [WS.landscapeId, WS.versionId],
    )).rows.map((row) => ({ generation: Number(row.generation), kind: row.change_kind, payload: row.payload }))

    // Mutants: no seeding (an unseeded
    // baseline taken as empty) and a seed without workspace scoping are RED
    // here; a seed taken from the fact (ignoring rows) is RED in the next.
    it('a restart with N APPLIED tombstones, then one ModelMeta change: no tombstone re-stamped, no `reset all`, one change event', async () => {
      await upsertObjects(database.pool, WS, null, [
        { id: 'o1', name: 'O1' }, { id: 'o2', name: 'O2' }, { id: 'o3', name: 'O3' }, { id: 'keep', name: 'K' },
      ])
      await upsertConnections(database.pool, WS, null, [{ id: 'c1', fromId: 'keep', toId: 'keep' }, { id: 'c2', fromId: 'keep', toId: 'keep' }])
      await upsertObjects(database.pool, OTHER, null, [{ id: 'o1', name: 'X1' }, { id: 'o2', name: 'X2' }, { id: 'o3', name: 'X3' }])
      await upsertConnections(database.pool, OTHER, null, [{ id: 'c1', fromId: 'o1', toId: 'o1' }, { id: 'c2', fromId: 'o1', toId: 'o1' }])
      const meta = repo.create<TombstoneMeta>({
        groups: {}, deletedObjectIds: ['o1', 'o2', 'o3'], deletedConnectionIds: ['c1', 'c2'], deletedDiagramIds: [],
      })
      await enqueue(meta, 1)
      await project(meta, 'model-meta')
      expect(await rowCount('ro_objects'), 'control: the first process applied every tombstone').toBe(1)
      expect(await rowCount('ro_connections')).toBe(0)
      const applied = await tombstoneDeltas()
      expect(applied.map((row) => row.id), 'control: five tombstone deltas').toEqual(['c1', 'c2', 'o1', 'o2', 'o3'])

      const { internal } = await restart()
      internal.attach(meta as DocHandle<unknown>)
      await until('the attach pass ran', () => idle(internal, meta as DocHandle<unknown>))
      const before = await changeEvents()

      // ONE change, through the listener (enqueue first: no storage here, so
      // the pass reads the revision the test wrote).
      await enqueue(meta, 2)
      meta.change((doc) => { doc.groups.g1 = { id: 'g1', name: 'G1', objectIds: [] } })
      await until('the change was projected', async () => await projectedRevision(meta) === 2)
      await until('the pass is idle', () => idle(internal, meta as DocHandle<unknown>))

      expect((await roGroup(database.pool, WS, 'g1'))?.name, 'control: the change applied').toBe('G1')
      expect(await tombstoneDeltas(), 'no tombstone delta re-stamped').toEqual(applied)
      const published = (await changeEvents()).slice(before.length)
      expect(published, 'one change event for one ModelMeta change').toHaveLength(1)
      expect(published[0].kind, 'not `reset all`').toBe('objects')
      expect(published[0].payload.deleteIds, 'no tombstone in the payload').toEqual([])
      expect(await rowCount('ro_objects'), 'control: the kept object').toBe(1)
      expect((await roObject(database.pool, OTHER, 'o1'))?.name, 'control: the other workspace untouched').toBe('X1')
    }, 30_000)

    it('a restart where ONE tombstone was left unapplied (a refused pass of the previous process): that one, and only that one, is replayed', async () => {
      await upsertObjects(database.pool, WS, null, [{ id: 'o0', name: 'O0' }, { id: 'o1', name: 'O1' }, { id: 'keep', name: 'K' }])
      await upsertConnections(database.pool, WS, null, [{ id: 'c0', fromId: 'keep', toId: 'keep' }])
      const meta = repo.create<TombstoneMeta>({
        groups: {}, deletedObjectIds: ['o0'], deletedConnectionIds: ['c0'], deletedDiagramIds: [],
      })
      await enqueue(meta, 1)
      await project(meta, 'model-meta')
      const applied = await tombstoneDeltas()
      expect(applied.map((row) => row.id), 'control: the first pass applied both').toEqual(['c0', 'o0'])

      meta.change((doc) => { doc.deletedObjectIds.push('o1') })
      await enqueue(meta, 2)
      refusalLogged(await refused('mutex', meta, 'model-meta'), 'mutex')
      expect(await roObject(database.pool, WS, 'o1'), 'control: the refused pass left the row').toBeDefined()

      const { internal } = await restart()
      const before = await changeEvents()
      // The attach pass IS the first changed ModelMeta of the new process
      // (revision 2 is pending).
      internal.attach(meta as DocHandle<unknown>)
      await until('the pending revision was projected', async () => await projectedRevision(meta) === 2)
      await until('the pass is idle', () => idle(internal, meta as DocHandle<unknown>))

      expect(await roObject(database.pool, WS, 'o1'), 'the unapplied tombstone is applied').toBeUndefined()
      expect((await roObject(database.pool, WS, 'keep'))?.name, 'control: an untombstoned row stays').toBe('K')
      const deltas = await tombstoneDeltas()
      expect(deltas.map((row) => row.id)).toEqual(['c0', 'o0', 'o1'])
      expect(deltas.filter((row) => row.id !== 'o1'), 'the applied ones are not re-stamped').toEqual(applied)
      const published = (await changeEvents()).slice(before.length)
      expect(published, 'one change event').toHaveLength(1)
      expect(published[0].kind, 'objects, not `reset all`').toBe('objects')
      expect(published[0].payload.deleteIds, 'only the unapplied tombstone').toEqual(['o1'])
    }, 30_000)

    // Pins the published payload. Mutant: the `reset all`
    // condition on the FULL connection tombstone list.
    it('steady state: an already-applied connection tombstone and a group change publish `objects`, not `reset all`', async () => {
      await upsertConnections(database.pool, WS, null, [{ id: 'c1', fromId: 'x', toId: 'x' }])
      const meta = repo.create<TombstoneMeta>({
        groups: {}, deletedObjectIds: [], deletedConnectionIds: ['c1'], deletedDiagramIds: [],
      })
      await enqueue(meta, 1)
      await project(meta, 'model-meta')
      expect(await roConnection(database.pool, WS, 'c1'), 'control: the tombstone applied').toBeUndefined()
      const first = await changeEvents()
      expect(first.at(-1)?.kind, 'control: the first pass published the connection delete').toBe('connections')

      meta.change((doc) => { doc.groups.g1 = { id: 'g1', name: 'G1', objectIds: [] } })
      await enqueue(meta, 2)
      await project(meta, 'model-meta')
      expect((await roGroup(database.pool, WS, 'g1'))?.name, 'control: the change applied').toBe('G1')
      const published = (await changeEvents()).slice(first.length)
      expect(published).toHaveLength(1)
      expect(published[0]).toMatchObject({ kind: 'objects', payload: { upsertIds: ['g1'], deleteIds: [] } })
    }, 30_000)

    it('an id un-tombstoned by an APPLIED revision leaves the baseline, so its re-tombstone is applied', async () => {
      await upsertObjects(database.pool, WS, null, [{ id: 'o1', name: 'O1' }])
      const meta = repo.create<TombstoneMeta>({
        groups: {}, deletedObjectIds: ['o1'], deletedConnectionIds: [], deletedDiagramIds: [],
      })
      await enqueue(meta, 1)
      await project(meta, 'model-meta')
      expect(await roObject(database.pool, WS, 'o1'), 'control: the tombstone applied').toBeUndefined()

      meta.change((doc) => { doc.deletedObjectIds.splice(0, 1) })
      await enqueue(meta, 2)
      await project(meta, 'model-meta')
      expect(await projectedRevision(meta), 'control: the un-tombstone COMMITTED').toBe(2)
      // The overlay serves o1 again.
      await upsertObjects(database.pool, WS, null, [{ id: 'o1', name: 'O1 again' }])

      meta.change((doc) => { doc.deletedObjectIds.push('o1') })
      await enqueue(meta, 3)
      await project(meta, 'model-meta')
      expect(await projectedRevision(meta)).toBe(3)
      expect(await roObject(database.pool, WS, 'o1'), 'the re-tombstone is applied').toBeUndefined()
    }, 30_000)

    type Collection = 'object' | 'connection'
    const shardKind = (collection: Collection) => `${collection}-overlay`
    const field = (collection: Collection) => collection === 'object' ? 'objects' : 'connections'
    const entity = (collection: Collection, id: string, name: string) => collection === 'object'
      ? { id, name }
      : { id, name, fromId: 'x', toId: 'x' }
    const row = (collection: Collection, id: string) => collection === 'object'
      ? roObject(database.pool, WS, id)
      : roConnection(database.pool, WS, id)

    /** A ModelMeta pointing at one shard per collection given, each shard
     * holding `e1` and `e2` (`c-e1`... for connections) and projected once by
     * the current projector; then `e2` is removed from every shard while no
     * projector runs (revision 2 pending). */
    async function shardsWithARemovedKey(collections: readonly Collection[]) {
      const ids = (collection: Collection) => collection === 'object' ? ['e1', 'e2'] : ['c-e1', 'c-e2']
      const heads = new Map<Collection, DocHandle<Record<string, unknown>>>()
      for (const collection of collections) {
        const [a, b] = ids(collection)
        heads.set(collection, repo.create<Record<string, unknown>>({
          [field(collection)]: { [a]: entity(collection, a, 'A'), [b]: entity(collection, b, 'B') },
          writeHeadVersion: 1, writeBatchIds: [],
        }))
      }
      const meta = repo.create<Record<string, unknown>>({
        groups: {},
        ...(heads.has('object') ? { editsObjectShardUrls: [heads.get('object')!.url], editsObjectShardUrl: heads.get('object')!.url } : {}),
        ...(heads.has('connection') ? { editsConnectionShardUrls: [heads.get('connection')!.url], editsConnectionShardUrl: heads.get('connection')!.url } : {}),
      })
      await enqueue(meta, 1)
      await project(meta, 'model-meta')
      for (const [collection, head] of heads) {
        await enqueue(head, 1)
        await project(head, shardKind(collection))
        expect(await row(collection, ids(collection)[1]), `control: the ${collection} shard applied`).toBeDefined()
        head.change((doc) => { delete (doc[field(collection)] as Record<string, unknown>)[ids(collection)[1]] })
        await enqueue(head, 2)
      }
      return { meta, heads, removedId: (collection: Collection) => ids(collection)[1] }
    }

    // A deferral test for each shard kind alone. Mutant: object-only
    // deferral (the connection arm then projects a self-only state).
    describe.each(['object', 'connection'] as const)('a %s shard alone', (collection) => {
      it('defers before the ModelMeta state, and is re-triggered by the ModelMeta pass: the removed key is deleted', async () => {
        const { meta, heads, removedId } = await shardsWithARemovedKey([collection])
        const head = heads.get(collection)!
        const { internal } = await restart()
        internal.attach(head as DocHandle<unknown>)
        await dispatch(head, shardKind(collection))
        expect(await projectedRevision(head), 'the overlay pass deferred: still pending').toBe(1)
        expect(await row(collection, removedId(collection)), 'control: still served').toBeDefined()

        await dispatch(meta, 'model-meta')
        await until('re-triggered and acknowledged', async () => await projectedRevision(head) === 2)
        expect(await row(collection, removedId(collection)), 'the removed key is deleted').toBeUndefined()
      }, 30_000)
    })

    // The re-trigger must fire ALL deferred overlays. Mutant: `break`
    // after the first.
    it('an object AND a connection shard pending at restart: the ModelMeta pass re-triggers both', async () => {
      const { meta, heads, removedId } = await shardsWithARemovedKey(['object', 'connection'])
      const { internal } = await restart()
      for (const [collection, head] of heads) {
        internal.attach(head as DocHandle<unknown>)
        await dispatch(head, shardKind(collection))
        expect(await projectedRevision(head), `control: the ${collection} pass deferred`).toBe(1)
      }
      await dispatch(meta, 'model-meta')
      for (const [collection, head] of heads) {
        await until(`the ${collection} shard re-triggered and acknowledged`, async () => await projectedRevision(head) === 2)
        expect(await row(collection, removedId(collection)), `the ${collection} removed key is deleted`).toBeUndefined()
      }
    }, 30_000)

    // The DEFERRAL requests the ModelMeta pass. Nothing dispatches
    // ModelMeta here: its handle is attached for real, its attach pass throws
    // before installing the state (the segment-snapshot read), and only
    // `deferUntilMetaState`'s `this.trigger(meta, metaHandle)` can run it
    // again. Mutant: no trigger.
    it('the deferral itself triggers the ModelMeta pass of an attached ModelMeta whose state is not installed', async () => {
      const { meta, heads, removedId } = await shardsWithARemovedKey(['object'])
      const head = heads.get('object')!
      const { internal } = await restart()

      const query = database.pool.query.bind(database.pool)
      let injected = 0
      const spy = vi.spyOn(database.pool, 'query').mockImplementation(((text: unknown, ...rest: unknown[]) => {
        if (typeof text === 'string' && text.includes('FROM read_model_overlay_segments') && injected === 0) {
          injected += 1
          return Promise.reject(new Error('injected segment read failure'))
        }
        return (query as (...args: unknown[]) => unknown)(text, ...rest)
      }) as typeof database.pool.query)
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        internal.attach(meta as DocHandle<unknown>)
        await until('control: the attach pass threw at the segment read', () => injected === 1 && idle(internal, meta as DocHandle<unknown>))
      } finally {
        spy.mockRestore()
        error.mockRestore()
      }
      expect((projector as unknown as { overlayState: Map<string, unknown> }).overlayState.size, 'control: no state installed').toBe(0)

      internal.attach(head as DocHandle<unknown>)
      await dispatch(head, 'object-overlay')
      await until('the deferral ran the ModelMeta pass, which re-triggered the overlay', async () => await projectedRevision(head) === 2)
      expect(await roObject(database.pool, WS, removedId('object')), 'the removed key is deleted').toBeUndefined()
    }, 30_000)

    // The deferral is visible, rate-limited.
    it('a deferral that outlives 30 s logs `read_model.static_overlay_deferred`, at most once a minute, and the gauge reports it', async () => {
      const { heads } = await shardsWithARemovedKey(['object'])
      const head = heads.get('object')!
      const { restarted, internal } = await restart()
      internal.attach(head as DocHandle<unknown>)
      // The ModelMeta is known (descriptor) but never resident.
      const t0 = 1_900_000_000_000
      const at = async (offsetMs: number): Promise<Array<Record<string, unknown>>> => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(t0 + offsetMs)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
          await dispatch(head, 'object-overlay')
          return warn.mock.calls.map((call) => String(call[0]))
            .filter((line) => line.includes('read_model.static_overlay_deferred'))
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        } finally {
          warn.mockRestore()
          now.mockRestore()
        }
      }
      expect(await at(0), 'a fresh deferral logs nothing').toEqual([])
      expect(await projectedRevision(head), 'control: it deferred').toBe(1)
      expect(await at(29_000), 'still under 30 s').toEqual([])
      expect(await at(31_000), 'past 30 s: one line').toEqual([{
        event: 'read_model.static_overlay_deferred',
        landscapeId: WS.landscapeId, versionId: WS.versionId,
        deferredOverlays: 1, oldestDeferredAgeMs: 31_000, modelMetaResident: false,
      }])
      expect(await at(60_000), 'rate-limited').toEqual([])
      expect((await at(91_000)).map((line) => line.oldestDeferredAgeMs), 'a minute later: again, the age still from the FIRST deferral').toEqual([91_000])

      expect(restarted.deferredOverlaySnapshot(t0 + 100_000)).toEqual({ overlays: 1, oldestAgeMs: 100_000 })
      const now = vi.spyOn(Date, 'now').mockReturnValue(t0 + 100_000)
      try {
        const samples = staticOverlayDeferralMetricSamples()
        expect(samples.find((sample) => sample.name === 'maplespire_read_model_static_overlay_deferred')?.values, 'the /metrics default reads the live projector').toEqual([{ value: 1 }])
        expect(samples.find((sample) => sample.name === 'maplespire_read_model_static_overlay_deferred_oldest_seconds')?.values).toEqual([{ value: 100 }])
      } finally {
        now.mockRestore()
      }
    }, 30_000)

    // -------------------------------------------------------------------
    // The cases the tests above leave open.
    // -------------------------------------------------------------------

    /** Counts the tombstone SEED selects (`unappliedTombstones`) the
     * publish transactions run, per table, by wrapping the `query` of every
     * client the pool hands out while it is installed. */
    function countSeedQueries() {
      const counts = { ro_objects: 0, ro_connections: 0 }
      let active = true
      const wrapped = new WeakSet<object>()
      const connect = database.pool.connect.bind(database.pool) as unknown as (callback?: unknown) => Promise<PoolClient>
      const spy = vi.spyOn(database.pool, 'connect').mockImplementation((async (callback?: unknown) => {
        // `pool.query` itself connects with a callback: leave that form alone.
        if (typeof callback === 'function') return connect(callback)
        const client = await connect()
        if (!wrapped.has(client)) {
          wrapped.add(client)
          const query = client.query.bind(client) as (...args: unknown[]) => unknown
          ;(client as unknown as { query: unknown }).query = (...args: unknown[]) => {
            const match = active && typeof args[0] === 'string'
              ? /SELECT id FROM (ro_objects|ro_connections) WHERE landscape_id = \$1 AND version_id = \$2 AND id = ANY/.exec(args[0])
              : null
            if (match) counts[match[1] as keyof typeof counts] += 1
            return query(...args)
          }
        }
        return client
      }) as never)
      return { counts, stop: () => { active = false; spy.mockRestore() } }
    }

    // Mutant: "seeded baseline ignored" (the seed select runs every
    // pass): the id the overlay re-served is read as an unapplied tombstone,
    // deleted again and re-stamped.
    it('a SEEDED baseline is not seeded again: a row re-served for an applied tombstone survives a later ModelMeta change, and no seed query runs', async () => {
      await upsertObjects(database.pool, WS, null, [{ id: 'o1', name: 'O1' }, { id: 'keep', name: 'K' }])
      const meta = repo.create<TombstoneMeta>({
        groups: {}, deletedObjectIds: ['o1'], deletedConnectionIds: [], deletedDiagramIds: [],
      })
      await enqueue(meta, 1)
      await project(meta, 'model-meta')
      expect(await roObject(database.pool, WS, 'o1'), 'control: the tombstone applied').toBeUndefined()
      const applied = await tombstoneDeltas()
      expect(applied.map((row) => row.id)).toEqual(['o1'])

      const { internal } = await restart()
      const seeds = countSeedQueries()
      try {
        internal.attach(meta as DocHandle<unknown>)
        await until('the attach pass ran', () => idle(internal, meta as DocHandle<unknown>))
        expect(seeds.counts, 'control: the attach pass is a short circuit and seeds nothing').toEqual({ ro_objects: 0, ro_connections: 0 })

        // The first changed ModelMeta of this process: UNSEEDED, so it seeds
        // once from the rows. (`deletedConnectionIds` is empty: no query.)
        await enqueue(meta, 2)
        meta.change((doc) => { doc.groups.g1 = { id: 'g1', name: 'G1', objectIds: [] } })
        await until('the first change was projected', async () => await projectedRevision(meta) === 2)
        await until('the pass is idle', () => idle(internal, meta as DocHandle<unknown>))
        expect(seeds.counts, 'control: an unseeded baseline runs the object seed once').toEqual({ ro_objects: 1, ro_connections: 0 })
        expect(await tombstoneDeltas(), 'control: the applied tombstone is not replayed').toEqual(applied)

        // The overlay serves o1 again, then ANOTHER ModelMeta change arrives.
        await upsertObjects(database.pool, WS, null, [{ id: 'o1', name: 'O1 again' }])
        const before = await changeEvents()
        await enqueue(meta, 3)
        meta.change((doc) => { doc.groups.g2 = { id: 'g2', name: 'G2', objectIds: [] } })
        await until('the second change was projected', async () => await projectedRevision(meta) === 3)
        await until('the pass is idle again', () => idle(internal, meta as DocHandle<unknown>))

        expect((await roGroup(database.pool, WS, 'g2'))?.name, 'control: the change applied').toBe('G2')
        expect((await roObject(database.pool, WS, 'o1'))?.name, 'the re-served row is kept').toBe('O1 again')
        expect(await tombstoneDeltas(), 'the tombstone delta is not re-stamped').toEqual(applied)
        expect(seeds.counts, 'no seed query when the baseline is seeded').toEqual({ ro_objects: 1, ro_connections: 0 })
        const published = (await changeEvents()).slice(before.length)
        expect(published).toHaveLength(1)
        expect(published[0].payload.deleteIds, 'no tombstone in the payload').toEqual([])
      } finally {
        seeds.stop()
      }
    }, 30_000)

    // Mutant: the seed select not scoped by `version_id` (the
    // existing arm only differs by landscape).
    it('the seed is scoped by version: another version of the SAME landscape holding rows under the same ids does not make them unapplied', async () => {
      await upsertObjects(database.pool, WS, null, [{ id: 'o1', name: 'O1' }, { id: 'o2', name: 'O2' }, { id: 'keep', name: 'K' }])
      await upsertConnections(database.pool, WS, null, [{ id: 'c1', fromId: 'keep', toId: 'keep' }])
      await upsertObjects(database.pool, SIBLING, null, [{ id: 'o1', name: 'X1' }, { id: 'o2', name: 'X2' }])
      await upsertConnections(database.pool, SIBLING, null, [{ id: 'c1', fromId: 'o1', toId: 'o1' }])
      const meta = repo.create<TombstoneMeta>({
        groups: {}, deletedObjectIds: ['o1', 'o2'], deletedConnectionIds: ['c1'], deletedDiagramIds: [],
      })
      await enqueue(meta, 1)
      await project(meta, 'model-meta')
      expect(await rowCount('ro_objects'), 'control: the first process applied every tombstone').toBe(1)
      const applied = await tombstoneDeltas()
      expect(applied.map((row) => row.id), 'control: three tombstone deltas').toEqual(['c1', 'o1', 'o2'])

      const { internal } = await restart()
      internal.attach(meta as DocHandle<unknown>)
      await until('the attach pass ran', () => idle(internal, meta as DocHandle<unknown>))
      const before = await changeEvents()
      await enqueue(meta, 2)
      meta.change((doc) => { doc.groups.g1 = { id: 'g1', name: 'G1', objectIds: [] } })
      await until('the change was projected', async () => await projectedRevision(meta) === 2)
      await until('the pass is idle', () => idle(internal, meta as DocHandle<unknown>))

      expect((await roGroup(database.pool, WS, 'g1'))?.name, 'control: the change applied').toBe('G1')
      expect(await tombstoneDeltas(), 'no tombstone delta re-stamped').toEqual(applied)
      const published = (await changeEvents()).slice(before.length)
      expect(published).toHaveLength(1)
      expect(published[0].kind, 'not `reset all`').toBe('objects')
      expect(published[0].payload.deleteIds).toEqual([])
      expect((await roObject(database.pool, SIBLING, 'o1'))?.name, 'control: the sibling version untouched').toBe('X1')
    }, 30_000)

    /** The deferral log lines of `fn` (which dispatches), with `Date.now`
     * pinned at `t0 + offsetMs`. */
    async function deferralLogsAt(t0: number, offsetMs: number, fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
      const now = vi.spyOn(Date, 'now').mockReturnValue(t0 + offsetMs)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await fn()
        return warn.mock.calls.map((call) => String(call[0]))
          .filter((line) => line.includes('read_model.static_overlay_deferred'))
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      } finally {
        warn.mockRestore()
        now.mockRestore()
      }
    }

    // The ModelMeta is attached (resident) but its pass never
    // installs the state: every attempt throws at the segment read. Mutant:
    // `modelMetaResident` forced to false.
    it('the deferral warn reports `modelMetaResident: true` when the ModelMeta is attached but never installs its state', async () => {
      const { meta, heads } = await shardsWithARemovedKey(['object'])
      const head = heads.get('object')!
      const { internal } = await restart()

      const query = database.pool.query.bind(database.pool)
      let injected = 0
      const spy = vi.spyOn(database.pool, 'query').mockImplementation(((text: unknown, ...rest: unknown[]) => {
        if (typeof text === 'string' && text.includes('FROM read_model_overlay_segments')) {
          injected += 1
          return Promise.reject(new Error('injected segment read failure'))
        }
        return (query as (...args: unknown[]) => unknown)(text, ...rest)
      }) as typeof database.pool.query)
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        internal.attach(meta as DocHandle<unknown>)
        await until('control: the ModelMeta attach pass threw at the segment read', () => injected >= 1 && idle(internal, meta as DocHandle<unknown>))
        internal.attach(head as DocHandle<unknown>)

        const t0 = 1_900_000_000_000
        expect(await deferralLogsAt(t0, 0, () => dispatch(head, 'object-overlay')), 'a fresh deferral logs nothing').toEqual([])
        expect(await projectedRevision(head), 'control: it deferred').toBe(1)
        expect(await deferralLogsAt(t0, 31_000, () => dispatch(head, 'object-overlay'))).toEqual([{
          event: 'read_model.static_overlay_deferred',
          landscapeId: WS.landscapeId, versionId: WS.versionId,
          deferredOverlays: 1, oldestDeferredAgeMs: 31_000, modelMetaResident: true,
        }])
      } finally {
        spy.mockRestore()
        error.mockRestore()
      }
    }, 30_000)

    // Mutant: the oldest deferral taken as the NEWEST (in the warn
    // and in the snapshot the gauges read).
    it('two deferred documents of one projector: the warn and the gauge report both, with the age of the OLDEST first deferral', async () => {
      const { heads } = await shardsWithARemovedKey(['object', 'connection'])
      const objectHead = heads.get('object')!
      const connectionHead = heads.get('connection')!
      const { restarted, internal } = await restart()
      internal.attach(objectHead as DocHandle<unknown>)
      internal.attach(connectionHead as DocHandle<unknown>)
      const t0 = 1_900_000_000_000

      expect(await deferralLogsAt(t0, 0, () => dispatch(objectHead, 'object-overlay')), 'the first deferral, fresh').toEqual([])
      expect(await deferralLogsAt(t0, 20_000, () => dispatch(connectionHead, 'connection-overlay')), 'the second, 20 s later: the oldest is 20 s old').toEqual([])
      expect(await projectedRevision(objectHead), 'control: the object shard deferred').toBe(1)
      expect(await projectedRevision(connectionHead), 'control: the connection shard deferred').toBe(1)

      // 60 s after the first, 40 s after the second: both past the 30 s
      // threshold, so only the age tells the two apart.
      expect(await deferralLogsAt(t0, 60_000, () => dispatch(connectionHead, 'connection-overlay'))).toEqual([{
        event: 'read_model.static_overlay_deferred',
        landscapeId: WS.landscapeId, versionId: WS.versionId,
        deferredOverlays: 2, oldestDeferredAgeMs: 60_000, modelMetaResident: false,
      }])
      const snapshot = restarted.deferredOverlaySnapshot(t0 + 60_000)
      expect(snapshot).toEqual({ overlays: 2, oldestAgeMs: 60_000 })
      const samples = staticOverlayDeferralMetricSamples([snapshot])
      expect(samples.find((sample) => sample.name === 'maplespire_read_model_static_overlay_deferred')?.values).toEqual([{ value: 2 }])
      expect(samples.find((sample) => sample.name === 'maplespire_read_model_static_overlay_deferred_oldest_seconds')?.values).toEqual([{ value: 60 }])
    }, 30_000)

    // DESIGN, decided here: the rate limit belongs to an EPISODE of
    // deferral. The ModelMeta pass's re-trigger ends the episode (the
    // overlays were released) and clears the limiter; a NEW episode that
    // outlives 30 s is a new problem and warns even less than a minute after
    // the previous episode's warn. Mutant: `overlayDeferredWarnedAt` not
    // cleared at the re-trigger.
    it('a second deferral episode after a re-trigger warns again once it is 30 s old, even inside a minute of the first warn', async () => {
      const { heads } = await shardsWithARemovedKey(['object'])
      const head = heads.get('object')!
      const { restarted, internal } = await restart()
      internal.attach(head as DocHandle<unknown>)
      const t0 = 1_900_000_000_000

      expect(await deferralLogsAt(t0, 0, () => dispatch(head, 'object-overlay'))).toEqual([])
      expect((await deferralLogsAt(t0, 31_000, () => dispatch(head, 'object-overlay'))).map((line) => line.oldestDeferredAgeMs), 'episode 1 warns').toEqual([31_000])

      // The re-trigger (as the ModelMeta pass does it when it installs the
      // state; here the state is still absent, so the overlay pass defers
      // again at once: a new episode starting at t0 + 40 s).
      const awaiting = (restarted as unknown as { overlaysAwaitingMeta: Map<string, unknown> }).overlaysAwaitingMeta
      const workspace = [...awaiting.keys()][0]
      expect(workspace, 'control: the deferral is recorded').toBeDefined()
      const startedAt = t0 + 40_000
      const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        ;(restarted as unknown as { retriggerOverlaysAwaitingMeta(workspace: string): void }).retriggerOverlaysAwaitingMeta(workspace)
        await until('the re-triggered pass deferred again', () => restarted.deferredOverlaySnapshot(startedAt).overlays === 1 && idle(internal, head as DocHandle<unknown>))
        expect(restarted.deferredOverlaySnapshot(startedAt), 'control: a NEW episode, its age counts from the re-deferral').toEqual({ overlays: 1, oldestAgeMs: 0 })
        expect(warn.mock.calls.filter((call) => String(call[0]).includes('read_model.static_overlay_deferred')), 'a fresh episode logs nothing').toHaveLength(0)
      } finally {
        warn.mockRestore()
        now.mockRestore()
      }

      // 71 s: 31 s into episode 2, 40 s after episode 1's warn (< 60 s).
      const lines = await deferralLogsAt(t0, 71_000, () => dispatch(head, 'object-overlay'))
      expect(lines.map((line) => line.oldestDeferredAgeMs), 'episode 2 warns, aged from ITS first deferral').toEqual([31_000])
    }, 30_000)

    // The observation is the projector's own `deferredOverlaySnapshot`
    // call (what the /metrics default makes for every live projector), not a
    // sum other projectors of the worker could pollute.
    it('stop() removes the projector from the live set /metrics reads, and start() after stop() puts it back', async () => {
      const own = new StaticDeltaProjector(repo, database.pool)
      const snapshot = vi.spyOn(own, 'deferredOverlaySnapshot')
      const readByMetrics = () => {
        snapshot.mockClear()
        staticOverlayDeferralMetricSamples()
        return snapshot.mock.calls.length
      }
      try {
        expect(readByMetrics(), 'control: a constructed projector is live').toBe(1)
        await own.stop()
        expect(readByMetrics(), 'stopped: not read').toBe(0)
        await own.start()
        expect(readByMetrics(), 'started again: live again').toBe(1)
        await own.stop()
        expect(readByMetrics(), 'stopped again: not read').toBe(0)
      } finally {
        snapshot.mockRestore()
        await own.stop()
      }
    }, 30_000)
  })
})
