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

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import pg from 'pg'
import { ensureReadModelSchema } from './schema.js'
import { beginReadModelProjection, completeReadModelProjection, getWorkspaceProjectionFreshness } from './health.js'
import { appendReadModelChange, roReadModelChanges } from './changeFeed.js'
import { StaticDeltaProjector } from './staticDeltaProjector.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import type { WorkspaceKey } from './projector.js'

/**
 * The static projector repairs `ro_objects.c4_parent_id` once per ATTACH.
 *
 * The rows below are what an OLD-code cell leaves behind during a rolling
 * deploy, after migration `0005-ro-objects-c4-parent` has already run: its
 * INSERT does not name the column (NULL — the object reads as a root), and its
 * delete of a parent never clears the children (they point at a gone id — at
 * no level). A static workspace has no cold build to heal them, so the cell
 * that takes it over must.
 *
 * Own schema, two connections — the discipline of
 * staticPlaneReconciliation.integration.test.ts, for the same reasons.
 */
const URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? ''
const WS: WorkspaceKey = { landscapeId: 'land-c4-static', versionId: 'version-c4-static' }
const OTHER: WorkspaceKey = { landscapeId: 'land-c4-other', versionId: 'version-c4-other' }
// Each shares ONE key half with WS, so a repair scoped by one column alone shows.
const SIBLING_VERSION: WorkspaceKey = { landscapeId: WS.landscapeId, versionId: 'version-c4-sibling' }
const SIBLING_LANDSCAPE: WorkspaceKey = { landscapeId: 'land-c4-sibling', versionId: WS.versionId }
const UNSERVED = [OTHER, SIBLING_VERSION, SIBLING_LANDSCAPE]
const SCHEMA = 'test_c4_static_repair'

async function probe(): Promise<{ pool: pg.Pool; teardown: () => Promise<void> } | null> {
  if (!URL) return null
  const db = {
    pool: guardIdleClientErrors(new pg.Pool({
      connectionString: URL,
      max: 2,
      connectionTimeoutMillis: 4000,
      options: `-c search_path=${SCHEMA}`,
    }), 'c4-static'),
    teardown: async () => {
      await db.pool.end().catch(() => undefined)
      const cleanup = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 1 }), 'c4-static:cleanup')
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      } finally {
        await cleanup.end()
      }
    },
  }
  try {
    const admin = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 1 }), 'c4-static:admin')
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    } finally {
      await admin.end()
    }
    const client = await db.pool.connect()
    try {
      await client.query(`CREATE TABLE versions (
        id TEXT NOT NULL, landscape_id TEXT NOT NULL, label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        PRIMARY KEY (landscape_id, id)
      )`)
      await client.query(`CREATE TABLE automerge_document_workspace (
        document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL
      )`)
      // `start()` reads the projection queue's source table, and
      // `getWorkspaceProjectionFreshness` its arrival clock.
      await client.query(`CREATE TABLE automerge_storage (
        key TEXT PRIMARY KEY, data BYTEA NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        arrival_seq BIGINT
      )`)
      await ensureReadModelSchema(client)
      // A REAL database failure, on demand: while `c4_fail` holds a row, every
      // UPDATE of ro_objects raises — the repair's statements included.
      // `demote` instead removes the workspace from the static plane INSIDE the
      // repair's own transaction, so `transactionOnly`'s second plane assert
      // refuses and the whole pass rolls back — an authority loss AFTER the
      // action ran, the one quiet refusal that a "did my action run" flag
      // cannot tell from success.
      await client.query(`CREATE TABLE c4_fail (mode TEXT NOT NULL)`)
      await client.query(`CREATE FUNCTION c4_fail_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM c4_fail WHERE mode = 'raise') THEN RAISE EXCEPTION 'c4_fail armed'; END IF;
          IF EXISTS (SELECT 1 FROM c4_fail WHERE mode = 'demote') THEN
            DELETE FROM read_model_static_workspaces
            WHERE landscape_id = NEW.landscape_id AND version_id = NEW.version_id;
          END IF;
          RETURN NEW;
        END $$`)
      await client.query(`CREATE TRIGGER c4_fail_update BEFORE UPDATE ON ro_objects
        FOR EACH ROW EXECUTE FUNCTION c4_fail_update()`)
    } finally {
      client.release()
    }
    return db
  } catch (error) {
    console.warn('[c4-static] setup failed', error)
    await db.pool.end().catch(() => undefined)
    return null
  }
}

const isolated = await probe()
const pool = isolated?.pool ?? null
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[c4-static] no Postgres at ${URL} — skipping`)

interface Internals {
  reloadDescriptors(): Promise<void>
  scheduleC4ParentRepairs(): void
  attachedWorkspaces: Map<string, unknown>
  workspaceTails: Map<string, Promise<void>>
  c4RepairChain: Promise<void>
}

suite('static projector: c4_parent_id repaired once per attach (old-writer drift)', () => {
  const db = pool!
  const running: StaticDeltaProjector[] = []

  afterAll(async () => {
    await isolated!.teardown().catch(() => undefined)
  })
  afterEach(async () => {
    for (const projector of running.splice(0)) await projector.stop().catch(() => undefined)
  })

  beforeEach(async () => {
    for (const table of [
      'read_model_static_documents', 'read_model_static_workspaces',
      'read_model_projection_state', 'automerge_document_workspace', 'ro_objects', 'versions', 'c4_fail',
      'read_model_change_events', 'read_model_static_document_state', 'automerge_storage',
    ]) await db.query(`DELETE FROM ${table}`)
    for (const key of [WS, ...UNSERVED]) {
      await db.query(`INSERT INTO versions (id, landscape_id, label) VALUES ($1, $2, 'v')`,
        [key.versionId, key.landscapeId])
    }
    await db.query(
      `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source)
       VALUES ($1, $2, 'promotion')`, [WS.landscapeId, WS.versionId])
    await db.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
       VALUES ($1, $2, 'c4-static-shard', 'registry-shard')`, [WS.landscapeId, WS.versionId])
    await drift(WS)
    for (const key of UNSERVED) await drift(key)
  })

  /** The shape an old-code cell writes: `c4_parent_id` as its INSERT leaves
   * it (NULL), and as its parent delete leaves it (the gone id). */
  const drift = async (key: WorkspaceKey) => {
    await db.query(`DELETE FROM ro_objects WHERE landscape_id = $1 AND version_id = $2`,
      [key.landscapeId, key.versionId])
    const rows: Array<[string, string | null, string | null]> = [
      ['sys', null, null],
      ['app', 'sys', null], // inserted by old code: should be 'sys'
      ['orphan', 'gone', 'gone'], // parent deleted by old code: should be NULL
      ['moved', null, 'sys'], // reparented to the root by old code: should be NULL
      ['regrouped', 'app', 'sys'], // reparented under an existing object by old code: should be 'app'
    ]
    for (const [id, parentId, c4] of rows) {
      await db.query(
        `INSERT INTO ro_objects (landscape_id, version_id, id, name, parent_id, c4_parent_id, data)
         VALUES ($1, $2, $3, $3, $4, $5, $6::jsonb)`,
        [key.landscapeId, key.versionId, id, parentId, c4, JSON.stringify({ id, name: id, parentId })],
      )
    }
  }
  const c4Of = async (key: WorkspaceKey) => Object.fromEntries((await db.query<{ id: string; c4_parent_id: string | null }>(
    `SELECT id, c4_parent_id FROM ro_objects WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )).rows.map((row) => [row.id, row.c4_parent_id]))
  /** The projection-state row an attach alone leaves (`reloadDescriptors`): no generation allocated. */
  const ATTACHED_ONLY = [{ observed_generation: '0', projected_generation: '0' }]
  const REPAIRED = { sys: null, app: 'sys', orphan: null, moved: null, regrouped: 'app' }
  const DRIFTED = { sys: null, app: null, orphan: 'gone', moved: 'sys', regrouped: 'sys' }

  function internals(instance: StaticDeltaProjector): Internals {
    return instance as unknown as Internals
  }
  const settle = async (instance: StaticDeltaProjector) => {
    // The repairs run one at a time on `c4RepairChain`; each is a
    // `transactionOnly` on the workspace's tail, and its WeakSet mark lands one
    // continuation after that settles.
    await internals(instance).c4RepairChain
    await Promise.allSettled([...internals(instance).workspaceTails.values()])
    await new Promise((resolve) => setImmediate(resolve))
  }

  it('THE WIRE: the running reload tick repairs an attached static workspace, and only that one', async () => {
    // A 50 ms reload so the first tick lands inside the test; `start()`'s own
    // first reload deliberately does NOT repair (boot cost), so the repair seen
    // here can only have come from the interval.
    const projector = new StaticDeltaProjector(new Repo({}), db, 60_000, 50)
    running.push(projector)
    await projector.start()
    expect(await c4Of(WS)).toEqual(DRIFTED)

    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (JSON.stringify(await c4Of(WS)) === JSON.stringify(REPAIRED)) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(await c4Of(WS)).toEqual(REPAIRED)
    // scoped: a workspace this projector does not serve is left alone
    for (const key of UNSERVED) expect(await c4Of(key)).toEqual(DRIFTED)
  })

  it('ONCE per attach: a second tick does not rescan; a release and re-attach repairs again', async () => {
    const projector = new StaticDeltaProjector(new Repo({}), db)
    running.push(projector)
    const p = internals(projector)
    await p.reloadDescriptors()
    expect(p.attachedWorkspaces.size).toBe(1)

    p.scheduleC4ParentRepairs()
    await settle(projector)
    expect(await c4Of(WS)).toEqual(REPAIRED)

    // drift again under the SAME attach: no second pass
    await drift(WS)
    p.scheduleC4ParentRepairs()
    await settle(projector)
    expect(await c4Of(WS)).toEqual(DRIFTED)

    // the workspace leaves the static plane (released) and comes back: a new
    // attach, a new repair
    await db.query(`DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId])
    await p.reloadDescriptors()
    expect(p.attachedWorkspaces.size).toBe(0)
    await db.query(
      `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source)
       VALUES ($1, $2, 'promotion')`, [WS.landscapeId, WS.versionId])
    await db.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
       VALUES ($1, $2, 'c4-static-shard', 'registry-shard')
       ON CONFLICT DO NOTHING`, [WS.landscapeId, WS.versionId])
    await p.reloadDescriptors()
    expect(p.attachedWorkspaces.size).toBe(1)
    p.scheduleC4ParentRepairs()
    await settle(projector)
    expect(await c4Of(WS)).toEqual(REPAIRED)
  })

  // ── The change feed: an offline browser cache holding the drifted
  // `c4ParentId` learns of the repair only through read_model_change_events.
  const feed = async (key: WorkspaceKey) => (await db.query<{
    generation: string; change_kind: string; payload: { upsertIds?: string[]; deleteIds?: string[] }
  }>(
    `SELECT generation, change_kind, payload FROM read_model_change_events
     WHERE landscape_id = $1 AND version_id = $2 ORDER BY generation`,
    [key.landscapeId, key.versionId],
  )).rows
  const generations = async (key: WorkspaceKey) => (await db.query<{
    observed_generation: string; projected_generation: string
  }>(
    `SELECT observed_generation, projected_generation FROM read_model_projection_state
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )).rows
  const documentState = async () => (await db.query(
    `SELECT landscape_id, version_id, document_id, source_updated_at::text, projected_generation, projected_at::text
     FROM read_model_static_document_state ORDER BY landscape_id, version_id, document_id`,
  )).rows
  const repairOnce = async () => {
    const projector = new StaticDeltaProjector(new Repo({}), db)
    running.push(projector)
    const p = internals(projector)
    await p.reloadDescriptors()
    expect(p.attachedWorkspaces.size).toBe(1)
    p.scheduleC4ParentRepairs()
    await settle(projector)
    return projector
  }

  it('a drifted repair appends exactly ONE objects event naming exactly the repaired ids, projected', async () => {
    // A workspace already at generation 7: the repair must take 8, a literal,
    // not a value derived from the event it is checked against.
    await db.query(
      `INSERT INTO read_model_projection_state (landscape_id, version_id, observed_generation, projected_generation)
       VALUES ($1, $2, 7, 7)`, [WS.landscapeId, WS.versionId])
    await repairOnce()
    expect(await c4Of(WS)).toEqual(REPAIRED)
    const events = await feed(WS)
    expect(events).toHaveLength(1)
    expect(events[0].change_kind).toBe('objects')
    // `sys` was right already: not named
    expect([...events[0].payload.upsertIds!].sort()).toEqual(['app', 'moved', 'orphan', 'regrouped'])
    expect(events[0].payload.deleteIds).toEqual([])
    // the token was completed: a reader gated on projected_generation sees it
    expect(Number(events[0].generation)).toBe(8)
    expect(await generations(WS)).toEqual([{ observed_generation: '8', projected_generation: '8' }])
    for (const key of UNSERVED) expect(await feed(key)).toEqual([])
  })

  // One KIND of drift alone — a workspace that only saw old-code inserts, or
  // only old-code parent deletes, is the ordinary case. Each row comes from a
  // different one of the two UPDATEs, so "publish only when both statements
  // hit" or "only when more than one row moved" goes red here (QA lens).
  it.each(['app', 'orphan'])('ONE drifted row (%s) alone publishes exactly that id', async (only) => {
    const correct = Object.entries(REPAIRED).filter(([id]) => id !== only)
    for (const [id, c4] of correct) {
      await db.query(`UPDATE ro_objects SET c4_parent_id = $4 WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
        [WS.landscapeId, WS.versionId, id, c4])
    }
    await repairOnce()
    expect(await c4Of(WS)).toEqual(REPAIRED)
    const events = await feed(WS)
    expect(events).toHaveLength(1)
    expect(events[0].payload.upsertIds).toEqual([only])
  })

  it('a consistent workspace appends nothing and allocates no generation', async () => {
    await repairOnce()
    const before = { events: await feed(WS), state: await generations(WS) }
    expect(before.events).toHaveLength(1)
    // a NEW attach (fresh projector) over the now-consistent rows: the repair
    // runs (once per attach) and finds nothing
    await repairOnce()
    expect(await feed(WS)).toEqual(before.events)
    expect(await generations(WS)).toEqual(before.state)
  })

  it('a workspace that never drifted allocates no generation (the attach row stays at 0)', async () => {
    // Written by hand from REPAIRED, not by the function under test.
    await db.query(
      `UPDATE ro_objects SET c4_parent_id = CASE id WHEN 'app' THEN 'sys' WHEN 'regrouped' THEN 'app' END
       WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId])
    expect(await c4Of(WS)).toEqual(REPAIRED)
    await repairOnce()
    expect(await feed(WS)).toEqual([])
    expect(await generations(WS)).toEqual(ATTACHED_ONLY)
  })

  it('the repair leaves read_model_static_document_state untouched (a pending shard stays pending)', async () => {
    // The shard has a storage write the projector has not projected; a state
    // row stamped by the repair would claim it had.
    await db.query(`INSERT INTO automerge_storage (key, data) VALUES ('c4-static-shard/incremental/1', '\\x00')`)
    await db.query(
      `INSERT INTO read_model_static_document_state (landscape_id, version_id, document_id, source_updated_at, projected_generation, projected_at)
       VALUES ($1, $2, 'c4-static-shard', '2000-01-01T00:00:00Z', 0, '2000-01-01T00:00:00Z')`,
      [WS.landscapeId, WS.versionId])
    const before = await documentState()
    await repairOnce()
    expect(await feed(WS)).toHaveLength(1) // it did publish
    expect(await documentState()).toEqual(before)
    // and with NO prior row, none is created
    await db.query(`DELETE FROM read_model_static_document_state`)
    await drift(WS)
    await repairOnce()
    expect(await documentState()).toEqual([])
  })

  // ── Health: the repair projects no document, so it must not report one as
  // projected. Read through the same freshness function the durability
  // witness serves, not the raw columns.
  const healthColumns = async () => (await db.query(
    `SELECT last_projected_at::text, source_changed_at::text, last_projection_kind,
            last_error_generation, last_error_code, consecutive_failures
     FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
    [WS.landscapeId, WS.versionId],
  )).rows

  it('health: an attach-only workspace stays uninitialized after a drifted repair', async () => {
    await repairOnce()
    expect(await feed(WS)).toHaveLength(1) // it did publish
    expect((await getWorkspaceProjectionFreshness(db, WS)).status).toBe('uninitialized')
  })

  it('health: a durable write nothing projected still reads stale after the repair', async () => {
    await db.query(`INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ('c4-static-shard', $1, $2)`,
      [WS.landscapeId, WS.versionId])
    await db.query(`INSERT INTO automerge_storage (key, data, updated_at) VALUES ('c4-static-shard/incremental/1', '\\x00', now() - interval '10 minutes')`)
    await db.query(
      `INSERT INTO read_model_projection_state (landscape_id, version_id, observed_generation, projected_generation,
         last_projected_at, source_changed_at, last_projection_kind, last_error_generation, last_error_code, consecutive_failures)
       VALUES ($1, $2, 7, 7, now() - interval '1 hour', now() - interval '1 hour', 'registry', 5, 'old_failure', 2)`,
      [WS.landscapeId, WS.versionId])
    const attacher = new StaticDeltaProjector(new Repo({}), db)
    running.push(attacher)
    await internals(attacher).reloadDescriptors() // attaches: projector_attached, so the ladder reaches `stale`
    expect((await getWorkspaceProjectionFreshness(db, WS)).status).toBe('stale')
    const before = await healthColumns()
    await repairOnce()
    expect(await feed(WS)).toHaveLength(1)
    const after = await getWorkspaceProjectionFreshness(db, WS)
    expect(after.status).toBe('stale')
    expect(after.projectedGeneration).toBe(8)
    expect(await healthColumns()).toEqual(before)
  })

  it('health: a workspace behind (catching up) gets the event queued behind its backlog, not projected past it', async () => {
    await db.query(
      `INSERT INTO read_model_projection_state (landscape_id, version_id, observed_generation, projected_generation)
       VALUES ($1, $2, 9, 7)`, [WS.landscapeId, WS.versionId])
    await repairOnce()
    const events = await feed(WS)
    expect(events.map((event) => Number(event.generation))).toEqual([10])
    expect(await generations(WS)).toEqual([{ observed_generation: '10', projected_generation: '7' }])

    // WHEN is it served? Not when the backlog (8, 9) completes — those tokens
    // are below it — but once a projection allocated after it does.
    for (const generation of [8, 9]) {
      const token = { generation, startedAtMs: Date.now() }
      await appendReadModelChange(db, WS, token, { kind: 'objects', upsertIds: [`backlog-${generation}`], deleteIds: [] })
      await completeReadModelProjection(db, WS, token)
    }
    const afterBacklog = await roReadModelChanges(db, WS, { afterGeneration: 7 })
    expect(afterBacklog.events.map((event) => event.generation)).toEqual([8, 9])
    expect(afterBacklog.resetRequired).toBe(false)

    const later = await beginReadModelProjection(db, WS, null, 'registry')
    expect(later.generation).toBe(11)
    await appendReadModelChange(db, WS, later, { kind: 'objects', upsertIds: ['later'], deleteIds: [] })
    await completeReadModelProjection(db, WS, later)
    const served = await roReadModelChanges(db, WS, { afterGeneration: 9 })
    expect(served.events.map((event) => event.generation)).toEqual([10, 11])
    const repairEvent = served.events[0] as { kind: string; upsertIds: string[] }
    expect(repairEvent.kind).toBe('objects')
    expect([...repairEvent.upsertIds].sort()).toEqual(['app', 'moved', 'orphan', 'regrouped'])
    expect(served.resetRequired).toBe(false)
  })

  it('a repair rolled back by an authority loss leaves no event and no generation behind', async () => {
    const projector = new StaticDeltaProjector(new Repo({}), db)
    running.push(projector)
    const p = internals(projector)
    await p.reloadDescriptors()
    await db.query(`INSERT INTO c4_fail VALUES ('demote')`)
    p.scheduleC4ParentRepairs()
    await settle(projector)
    expect(await c4Of(WS)).toEqual(DRIFTED)
    expect(await feed(WS)).toEqual([])
    expect(await generations(WS)).toEqual(ATTACHED_ONLY)
  })

  it('start() itself does not repair: boot pays nothing, the first tick does', async () => {
    // A reload interval far past the test, so only start()'s own first reload
    // could have queued a repair.
    const projector = new StaticDeltaProjector(new Repo({}), db, 60_000, 60_000)
    running.push(projector)
    await projector.start()
    await settle(projector)
    expect(await c4Of(WS)).toEqual(DRIFTED)
  })

  it('a failed repair NEVER rejects, is not marked done, and the next tick retries it', async () => {
    const projector = new StaticDeltaProjector(new Repo({}), db)
    running.push(projector)
    const p = internals(projector)
    await p.reloadDescriptors()
    await db.query(`INSERT INTO c4_fail VALUES ('raise')`)
    p.scheduleC4ParentRepairs()
    // `settle` awaits the chain: a rejection from the scheduled, unawaited
    // repair would surface here instead of as an unhandled rejection
    await settle(projector)
    expect(await c4Of(WS)).toEqual(DRIFTED)

    await db.query(`DELETE FROM c4_fail`)
    p.scheduleC4ParentRepairs()
    await settle(projector)
    expect(await c4Of(WS)).toEqual(REPAIRED)
  })

  it('a repair whose commit is refused AFTER it ran (authority lost) is not marked done', async () => {
    const projector = new StaticDeltaProjector(new Repo({}), db)
    running.push(projector)
    const p = internals(projector)
    await p.reloadDescriptors()
    await db.query(`INSERT INTO c4_fail VALUES ('demote')`)
    p.scheduleC4ParentRepairs()
    await settle(projector)
    // rolled back with the demotion: still drifted, and the plane row is back
    expect(await c4Of(WS)).toEqual(DRIFTED)
    const plane = await db.query(`SELECT 1 FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId])
    expect(plane.rowCount).toBe(1)
    // the same attach is still due
    await db.query(`DELETE FROM c4_fail`)
    p.scheduleC4ParentRepairs()
    await settle(projector)
    expect(await c4Of(WS)).toEqual(REPAIRED)
  })

  it('a repair still waiting on the workspace tail when stop() lands does not run', async () => {
    const projector = new StaticDeltaProjector(new Repo({}), db)
    const p = internals(projector)
    await p.reloadDescriptors()
    // Hold the workspace's tail, as a long projection would.
    let releaseTail!: () => void
    const held = new Promise<void>((resolve) => { releaseTail = resolve })
    p.workspaceTails.set(`${WS.landscapeId}\u0000${WS.versionId}`, held)
    p.scheduleC4ParentRepairs()
    // let the chain reach `transactionOnly`, which queues behind `held`
    await new Promise((resolve) => setImmediate(resolve))
    const stopping = projector.stop()
    releaseTail()
    await stopping
    expect(await c4Of(WS)).toEqual(DRIFTED)
  })

  it('a workspace this cell does not own is not repaired, and stays due', async () => {
    let owns = false
    const projector = new StaticDeltaProjector(new Repo({}), db, 60_000, 60_000, () => owns)
    running.push(projector)
    const p = internals(projector)
    // attach while owned, then lose ownership before the repair runs
    owns = true
    await p.reloadDescriptors()
    owns = false
    p.scheduleC4ParentRepairs()
    await settle(projector)
    expect(await c4Of(WS)).toEqual(DRIFTED)
    // still due: regaining ownership under the same attach repairs it
    owns = true
    p.scheduleC4ParentRepairs()
    await settle(projector)
    expect(await c4Of(WS)).toEqual(REPAIRED)
  })
})
