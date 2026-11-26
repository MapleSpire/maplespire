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
 * T-ZEROWM (B) — a rotation is `published` in SQL only once the ModelMeta that
 * names its new head is DURABLE.
 *
 * The defect, measured in three red runs of a manual test on a stack: a
 * startup rotation cut by SIGTERM was `published` in SQL while the durable
 * ModelMeta history held no change naming its new head, so the next boot put
 * the old head back, forwarded the orphan into it, and the zero-watermark
 * race (`zeroWatermark.integration.test.ts`) followed.
 *
 * The mechanism, established here (real Repo on the real
 * `PostgresStorageAdapter`, real `AutomergeResidencyLeases`, real projector,
 * real PostgreSQL; ONE pool hook holds the rotation's advisory-lock
 * statement, SQL unchanged): the rotation resolves its ModelMeta handle before
 * it takes the lock. `stop()` — or any release of the ModelMeta's residency
 * lease — evicts that handle while the rotation waits: `removeFromCache` drops
 * it from the Repo and the residency detaches its persistence listener. The
 * rotation then changes THAT handle (in memory only), `repo.flush([meta])`
 * finds no resident handle to save, and `publishAdmittedRotation` reads the
 * URL back from the same detached handle — so it marks the rotation
 * `published`. Durable ModelMeta: unchanged.
 *
 *  1. `stop()` during a held rotation: after the stop, `published` ⇒ the
 *     durable ModelMeta names the new head (and `stop()` lets the rotation
 *     finish BEFORE it releases any lease).
 *  2. the ModelMeta's lease released under a held rotation, the projector
 *     still running: no `published` row while the durable ModelMeta does not
 *     name the new head, and the admitted-rotation recovery publishes it once
 *     it does.
 *  3. a `stop()` whose in-flight work outlives its ceiling still returns, and
 *     says so (`read_model.static_stop_drain_overdue`).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import type { Pool } from 'pg'

import { PostgresStorageAdapter } from '../automergeStorage.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { readMetaUrl } from '../modelMetaUrls.js'
import { ensureReadModelSchema } from './schema.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { markReadModelProjectorAttached } from './health.js'
import { StaticDeltaProjector } from './staticDeltaProjector.js'

const CONNECTION = process.env.TEST_DATABASE_URL
const WS = { landscapeId: 'ls-rotation-shutdown', versionId: 'v1' }

type ConnectionHead = { connections: Record<string, { id: string; fromId: string; toId: string }>; writeHeadVersion: number; writeBatchIds: string[] }
type ObjectHead = { objects: Record<string, { id: string; name: string }>; writeHeadVersion: number; writeBatchIds: string[] }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** ONE hook on every statement of the pool and of the clients it lends. */
function hookedPool(pool: Pool, hook: (sql: string, proceed: () => Promise<unknown>) => Promise<unknown>): Pool {
  const wrap = <T extends object>(target: T): T => new Proxy(target, {
    get(subject, property) {
      if (property === 'query') {
        return (sql: unknown, values?: unknown[]) => {
          const proceed = () => (Reflect.get(subject, 'query', subject) as (sql: unknown, values?: unknown[]) => Promise<unknown>)
            .call(subject, sql, values)
          return typeof sql === 'string' ? hook(sql, proceed) : proceed()
        }
      }
      if (property === 'connect') {
        return async () => wrap(await (Reflect.get(subject, 'connect', subject) as () => Promise<object>).call(subject))
      }
      const value = Reflect.get(subject, property, subject)
      return typeof value === 'function' ? value.bind(subject) : value
    },
  })
  return wrap(pool)
}

describe.skipIf(!CONNECTION)('T-ZEROWM (B) — a rotation is published only once its ModelMeta is durable (real storage, residency, PostgreSQL)', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let residency: AutomergeResidencyLeases
  let projector: StaticDeltaProjector | undefined

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'rotation_shutdown')
    await ensureReadModelSchema(database.pool)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await database.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      parent_version_id TEXT, kind TEXT NOT NULL DEFAULT 'version',
      status TEXT NOT NULL DEFAULT 'active', base_manifest JSONB,
      PRIMARY KEY (landscape_id, id))`)
    await database.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, 'automerge:root') ON CONFLICT DO NOTHING`,
      [WS.landscapeId, WS.versionId],
    )
  }, 60_000)
  afterAll(async () => { await database?.teardown() })

  beforeEach(async () => {
    for (const table of [
      'ro_objects', 'ro_connections', 'read_model_static_documents', 'read_model_static_document_queue',
      'read_model_static_entity_deltas', 'read_model_overlay_segments', 'read_model_overlay_rotations',
      'read_model_overlay_batch_acks', 'ro_workspace_stats', 'automerge_document_workspace',
      'read_model_document_watermarks', 'read_model_projection_state', 'read_model_static_document_state',
    ]) {
      await database.pool.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
    }
    await database.pool.query('DELETE FROM automerge_storage')
    repo = new Repo({
      storage: new PostgresStorageAdapter({ db: database.pool, trackStaticReadModel: true }), network: [], saveDebounceRate: 0,
    })
    residency = new AutomergeResidencyLeases(repo)
    await markStaticReadModelWorkspace(database.pool, WS, 'test')
    await markReadModelProjectorAttached(database.pool, WS, null, 'rotation-shutdown')
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await projector?.stop()
    projector = undefined
    await repo.shutdown()
  })

  async function until(what: string, predicate: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!(await predicate()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await predicate(), what).toBe(true)
  }

  /** The ModelMeta's current connection head as STORAGE holds it. */
  const durableConnectionHead = async (documentId: string) => {
    const { rows } = await database.pool.query<{ data: Buffer }>(
      `SELECT data FROM automerge_storage
        WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) IN ('snapshot', 'incremental')
        ORDER BY arrival_seq NULLS FIRST`,
      [documentId])
    let doc = A.init<unknown>()
    for (const row of rows) doc = A.loadIncremental(doc, new Uint8Array(row.data))
    return readMetaUrl(A.toJS(doc), 'editsConnectionShardUrl')
  }
  const connectionRotations = async () => (await database.pool.query<{ new_url: string; status: string }>(
    `SELECT new_segment_url AS new_url, status FROM read_model_overlay_rotations
      WHERE landscape_id = $1 AND version_id = $2 AND collection = 'connection' ORDER BY created_at`,
    [WS.landscapeId, WS.versionId])).rows

  /** A ModelMeta, a protocol-v2 object head, and a protocol-v1 connection
   * head the projector must rotate at start. */
  async function summaryWorkspace() {
    const objectHead = repo.create<ObjectHead>()
    const connectionHead = repo.create<ConnectionHead>()
    const meta = repo.create<Record<string, unknown>>()
    await registerStaticReadModelDocuments(database.pool, WS, [
      { documentId: meta.documentId, kind: 'model-meta' },
      { documentId: objectHead.documentId, kind: 'object-overlay' },
      { documentId: connectionHead.documentId, kind: 'connection-overlay' },
    ])
    objectHead.change((doc) => {
      doc.objects = { o1: { id: 'o1', name: 'A' } }
      doc.writeHeadVersion = 2
      doc.writeBatchIds = []
    })
    connectionHead.change((doc) => {
      doc.connections = {}
      doc.writeHeadVersion = 1
      doc.writeBatchIds = []
    })
    meta.change((doc) => {
      doc.groups = {}
      doc.editsObjectShardUrls = [objectHead.url]
      doc.editsObjectShardUrl = objectHead.url
      doc.editsConnectionShardUrls = [connectionHead.url]
      doc.editsConnectionShardUrl = connectionHead.url
    })
    await repo.flush()
    return { connectionHead, meta }
  }

  /** Start a projector whose startup rotation is HELD at its advisory lock. */
  async function startWithHeldRotation(reloadMs: number) {
    const { connectionHead, meta } = await summaryWorkspace()
    const rotationHeld = deferred()
    const releaseRotation = deferred()
    let holdNext = true
    const pool = hookedPool(database.pool, async (sql, proceed) => {
      if (holdNext && sql.includes('pg_try_advisory_lock')) {
        holdNext = false
        rotationHeld.resolve()
        await releaseRotation.promise
      }
      return proceed()
    })
    projector = new StaticDeltaProjector(
      repo, pool, 250, reloadMs, () => true, undefined, residency, undefined, undefined, 50, 100,
    )
    await projector.start()
    await rotationHeld.promise
    return { connectionHead, meta: meta as DocHandle<unknown>, releaseRotation }
  }

  it('1. stop() during a held rotation: after it, a `published` rotation is named by the DURABLE ModelMeta', async () => {
    const { connectionHead, meta, releaseRotation } = await startWithHeldRotation(5_000)
    const stopping = projector!.stop()
    // The rotation is released only once the stop has had every chance to
    // release leases synchronously (it used to, BEFORE awaiting anything).
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseRotation.resolve()
    await stopping
    projector = undefined
    const rotations = await connectionRotations()
    const durable = await durableConnectionHead(meta.documentId)
    expect(rotations.length, 'control: the held rotation was admitted').toBeGreaterThan(0)
    for (const rotation of rotations) {
      if (rotation.status === 'published') {
        expect(durable, `published ⇒ durable: the durable ModelMeta names ${rotation.new_url} (in memory: ${readMetaUrl(meta.doc(), 'editsConnectionShardUrl')})`)
          .toBe(rotation.new_url)
      }
    }
    expect(rotations.some((rotation) => rotation.status === 'published') || durable === connectionHead.url,
      'nothing lost: either published (and durable), or the old head is still the durable head').toBe(true)
    // And the stop WAITED for it (within its ceiling): the rotation in flight
    // finished before any lease went, so it is published, not left admitted.
    expect(rotations.map((rotation) => rotation.status), 'the in-flight rotation completed before the leases were released')
      .toContain('published')
  }, 60_000)

  it('2. the ModelMeta evicted under a held rotation: no `published` row until the durable ModelMeta names the head, then the recovery publishes it', async () => {
    const { meta, releaseRotation } = await startWithHeldRotation(400)
    // The eviction `stop()` used to cause, without the stop: the ModelMeta's
    // residency lease released while the rotation holds its handle.
    const owner = `static-control:${WS.landscapeId}\u0000${WS.versionId}:model-meta`
    expect(residency.release(meta.documentId, owner), 'control: the projector leased the ModelMeta').toBe(true)
    const violations: string[] = []
    let durable: string | undefined
    const check = async () => {
      durable = await durableConnectionHead(meta.documentId)
      for (const rotation of await connectionRotations()) {
        if (rotation.status === 'published' && rotation.new_url !== durable) {
          violations.push(`${rotation.new_url} published while the durable ModelMeta names ${durable}`)
        }
      }
      return (await connectionRotations()).some((rotation) => rotation.status === 'published' && rotation.new_url === durable)
    }
    releaseRotation.resolve()
    await until('the rotation is eventually published, and durable', check)
    expect(violations, 'never published ahead of the durable ModelMeta').toEqual([])
    // THE HELD rotation — the admitted-rotation recovery redid it — not a
    // second one a later rotation obligation made instead.
    const rotations = await connectionRotations()
    expect(rotations[0]?.status, `the first admitted rotation is the one published (${JSON.stringify(rotations)})`).toBe('published')
    expect(rotations[0]?.new_url).toBe(durable)
  }, 60_000)

  it('4. the ModelMeta dropped from the Repo WITHOUT an eviction notice: the recovery re-resolves it instead of reusing the stale listened handle', async () => {
    const { meta, releaseRotation } = await startWithHeldRotation(400)
    // What `removeFromCache` callers that announce nothing do (a fork
    // rollback, a document re-resolution): the projector still lists the old
    // handle as `ready`, and a change on it is saved by nobody.
    meta.removeAllListeners('heads-changed')
    await repo.removeFromCache(meta.documentId)
    releaseRotation.resolve()
    await until('the held rotation is eventually published, and durable', async () => {
      const durable = await durableConnectionHead(meta.documentId)
      const first = (await connectionRotations())[0]
      return first?.status === 'published' && first.new_url === durable
    })
  }, 60_000)

  it('3. a stop() whose in-flight work outlives its ceiling returns and logs read_model.static_stop_drain_overdue', async () => {
    const warn = vi.spyOn(console, 'warn')
    const { releaseRotation } = await startWithHeldRotation(5_000)
    ;(projector as unknown as { stopDrainCeilingMs: number }).stopDrainCeilingMs = 200
    const startedAt = Date.now()
    const stopping = projector!.stop()
    let stopped = false
    void stopping.then(() => { stopped = true })
    while (!stopped && Date.now() - startedAt < 5_000) await new Promise((resolve) => setTimeout(resolve, 10))
    // Read BEFORE the rotation is released: a stop that only returns once its
    // work finishes must not pass this case.
    const returnedWhileHeld = stopped
    const overdue = warn.mock.calls.map((call) => String(call[0])).find((line) => line.includes('read_model.static_stop_drain_overdue'))
    releaseRotation.resolve()
    await stopping
    // T-ZEROWM-2: the overdue rotation outlives the stop; let it end here, or
    // it holds the workspace's rotation lock into the next case.
    const overdueTails = (projector as unknown as { workspaceTails: Map<string, Promise<unknown>> }).workspaceTails
    for (let round = 0; round < 3; round += 1) await Promise.allSettled([...overdueTails.values()])
    projector = undefined
    expect(returnedWhileHeld, 'stop() returned while the rotation was still held').toBe(true)
    expect(overdue, 'the overdue drain was logged').toBeDefined()
  }, 60_000)

  it('5. (T-ZEROWM-2) a rotation still in flight past the stop ceiling, its ModelMeta evicted, is never `published` ahead of the durable ModelMeta — and the NEXT BOOT (a fresh Repo and projector) publishes that same rotation, durably', async () => {
    const { connectionHead, meta, releaseRotation } = await startWithHeldRotation(5_000)
    const first = projector! as unknown as { stopDrainCeilingMs: number; workspaceTails: Map<string, Promise<unknown>>; stop(): Promise<void> }
    first.stopDrainCeilingMs = 200
    await first.stop()
    projector = undefined
    await residency.drain()
    const metaResident = Boolean((repo.synchronizer as unknown as { docSynchronizers: Record<string, unknown> }).docSynchronizers[meta.documentId])
    expect(metaResident, 'control: the stop past its ceiling evicted the ModelMeta under the held rotation').toBe(false)
    releaseRotation.resolve()
    // The overdue rotation runs to its end on the stopped projector.
    for (let round = 0; round < 3; round += 1) await Promise.allSettled([...first.workspaceTails.values()])
    const afterStop = await connectionRotations()
    const durableAfterStop = await durableConnectionHead(meta.documentId)
    expect(afterStop.length, 'control: the held rotation was admitted').toBeGreaterThan(0)
    for (const rotation of afterStop) {
      if (rotation.status === 'published') expect(durableAfterStop, 'published ⇒ durable, even past the ceiling').toBe(rotation.new_url)
    }
    expect(afterStop[0]?.status, `control: the overdue rotation is left \`admitted\` (${JSON.stringify(afterStop)}; durable ${durableAfterStop})`).toBe('admitted')
    expect(durableAfterStop, 'control: the durable ModelMeta still names the old head').toBe(connectionHead.url)
    // THE NEXT BOOT: a fresh Repo on the same storage, a fresh projector.
    await repo.shutdown()
    repo = new Repo({
      storage: new PostgresStorageAdapter({ db: database.pool, trackStaticReadModel: true }), network: [], saveDebounceRate: 0,
    })
    residency = new AutomergeResidencyLeases(repo)
    projector = new StaticDeltaProjector(repo, database.pool, 250, 400, () => true, undefined, residency, undefined, undefined, 50, 100)
    await projector.start()
    await until('the next boot publishes the admitted rotation, durably', async () => {
      const durable = await durableConnectionHead(meta.documentId)
      const rotation = (await connectionRotations())[0]
      return rotation?.status === 'published' && rotation.new_url === durable
    })
    const rotations = await connectionRotations()
    expect(rotations[0]?.new_url, 'THE rotation the stop left admitted, not a new one').toBe(afterStop[0]?.new_url)
  }, 60_000)
})
