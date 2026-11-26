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
 * T-SUM-2 — the static plane's arrival certificate, against a REAL Repo on a
 * REAL `PostgresStorageAdapter` (so every chunk carries a minted
 * `arrival_seq` and every write enqueues its queue revision), and the
 * product's own verdict, `getWorkspaceProjectionFreshness().absenceProvable`,
 * as the oracle.
 *
 * The interleavings the certificate rule asks for are built, not hoped for: the pass's
 * publication transaction is HELD before its COMMIT (or failed after its
 * certificate) through a proxy on the pool the projector is given. The pass
 * is driven through the real `project()`, never a branch.
 *
 *  1. an arrival between the pass's durable read and its COMMIT is NOT
 *     certified: after the commit the proof refuses until a later pass
 *     projects that arrival, and then it holds;
 *  2. a certificate is never visible ahead of the rows it vouches for: a
 *     publication that fails after writing it leaves the document refused,
 *     even once ANOTHER document's publish has brought the workspace back to
 *     healthy — the interleaving that turns "written before the validation"
 *     into a false proof;
 *  3. the frozen baseline is marked once, only where the clause covers it,
 *     and an arrival nothing projects then refuses for good — where the
 *     timestamp fallback would have certified it at the next publish.
 *
 * The two doors (the promotion's mark, the demotion's drop) are pinned in
 * `promoteSummaryWorkspace.integration.test.ts`, which has their fixture.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import type { Pool } from 'pg'

import { PostgresStorageAdapter } from '../automergeStorage.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { getWorkspaceProjectionFreshness, markReadModelProjectorAttached } from './health.js'
import { markStaticEntryWatermarks } from './arrivalWatermark.js'
import { StaticDeltaProjector } from './staticDeltaProjector.js'

const CONNECTION = process.env.TEST_DATABASE_URL
const WS = { landscapeId: 'ls-static-watermark', versionId: 'v1' }

type RegistryShard = { diagrams: Record<string, { id: string; name: string; type: string }> }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** The pool the projector is handed, with ONE hook on every statement of the
 * pool and of the clients it lends — SQL, values and bytes unchanged. */
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

describe.skipIf(!CONNECTION)('T-SUM-2 — the static plane writes its arrival certificate inside the publication (real Repo + PostgreSQL)', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let projector: StaticDeltaProjector | undefined

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'static_delta_watermark')
    await ensureReadModelSchema(database.pool)
    // The storage table's arrival clock, as `db.ts` declares it.
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
  })
  afterAll(async () => { await database?.teardown() })

  beforeEach(async () => {
    for (const table of [
      'ro_diagrams', 'ro_diagram_summaries', 'read_model_static_documents', 'read_model_static_document_queue',
      'read_model_static_membership_deltas', 'read_model_static_entity_deltas', 'ro_workspace_stats',
      'automerge_document_workspace', 'read_model_document_watermarks', 'read_model_projection_state',
    ]) {
      await database.pool.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
    }
    await database.pool.query('DELETE FROM automerge_storage')
    // `trackStaticReadModel`, as the server sets it under READ_MODEL=on
    // (`automergeServer.ts`): every content save enqueues its revision.
    repo = new Repo({
      storage: new PostgresStorageAdapter({ db: database.pool, trackStaticReadModel: true }), network: [], saveDebounceRate: 0,
    })
    await markStaticReadModelWorkspace(database.pool, WS, 'test')
    // The static projector's own attach marker (`reloadDescriptors`), so the
    // ladder can reach `healthy`; `start()` is NOT called — its listeners
    // would run passes concurrently with the ones each test drives.
    await markReadModelProjectorAttached(database.pool, WS, null, 'static-watermark-test')
  })
  afterEach(async () => {
    await projector?.stop()
    projector = undefined
    await repo.shutdown()
  })

  /** A registry write head, registered BEFORE its first save so the storage
   * write enqueues a queue revision (the enqueue CTE joins the allow-list). */
  async function registryHead(name: string, id = 'd1'): Promise<DocHandle<RegistryShard>> {
    const handle = repo.create<RegistryShard>()
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: handle.documentId, kind: 'registry-shard' }])
    handle.change((doc) => { doc.diagrams = { [id]: { id, name, type: 'context' } } })
    await repo.flush([handle.documentId])
    return handle
  }

  function rename(handle: DocHandle<RegistryShard>, name: string, id = 'd1'): void {
    handle.change((doc) => { doc.diagrams[id].name = name })
  }

  async function project(target: Pool, handle: DocHandle<RegistryShard>): Promise<void> {
    projector ??= new StaticDeltaProjector(repo, target)
    const internal = projector as unknown as {
      project(descriptor: Record<string, unknown>, handle: DocHandle<unknown>): Promise<void>
    }
    await internal.project({ ...WS, documentId: handle.documentId, kind: 'registry-shard', entityId: null, orgId: null },
      handle as DocHandle<unknown>)
  }

  const proven = async () => (await getWorkspaceProjectionFreshness(database.pool, WS)).absenceProvable
  const freshness = () => getWorkspaceProjectionFreshness(database.pool, WS)
  const servedName = async () => (await database.pool.query<{ name: string }>(
    `SELECT data->>'name' AS name FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = 'd1'`,
    [WS.landscapeId, WS.versionId])).rows[0]?.name ?? null
  const certificate = async (handle: DocHandle<unknown>) => (await database.pool.query<{ wm: string }>(
    `SELECT projected_watermark::text AS wm FROM read_model_document_watermarks
      WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
    [WS.landscapeId, WS.versionId, handle.documentId])).rows[0]?.wm ?? null
  const newestArrival = async (handle: DocHandle<unknown>) => (await database.pool.query<{ seq: string }>(
    `SELECT max(arrival_seq)::text AS seq FROM automerge_storage
      WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) <> 'sync-state'`,
    [handle.documentId])).rows[0]?.seq ?? null

  it('control: a pass certifies the revision it published, exactly, and the absence becomes provable', async () => {
    const head = await registryHead('First')
    expect(await proven(), 'before any pass nothing is certified').toBe(false)
    await project(database.pool, head)
    expect(await servedName()).toBe('First')
    const stamp = await certificate(head)
    expect(stamp, 'the pass wrote a positive certificate').not.toBeNull()
    expect(BigInt(stamp!) >= BigInt((await newestArrival(head))!), 'exact: it covers the newest arrival').toBe(true)
    expect(await freshness()).toMatchObject({ status: 'healthy', caughtUp: true, absenceProvable: true })
    expect((projector as unknown as { passStamps: Map<string, unknown> }).passStamps.size, 'the pass took its stamp with it').toBe(0)
  })

  it('an ARRIVAL between the durable read and the COMMIT is not certified — it refuses until a later pass projects it', async () => {
    const head = await registryHead('First')
    await project(database.pool, head)
    expect(await proven(), 'control: the first pass proves').toBe(true)
    rename(head, 'Second')
    await repo.flush([head.documentId])

    // Hold the publication transaction of the NEXT pass inside the
    // transaction, after its durable read and its rows, just before the queue
    // row moves and the certificate is decided.
    const held = deferred()
    const release = deferred()
    let holding = false
    const target = hookedPool(database.pool, async (sql, proceed) => {
      if (sql.includes('UPDATE read_model_static_document_queue') && !holding) {
        holding = true
        held.resolve()
        await release.promise
      }
      return proceed()
    })
    projector = new StaticDeltaProjector(repo, target)
    const pass = project(target, head)
    await held.promise
    // The arrival: a real change, saved durably through the real adapter (a
    // minted sequence, a queue revision) while the pass that sampled "Second"
    // waits inside its publication.
    try {
      rename(head, 'Third')
      await repo.flush([head.documentId])
    } finally {
      // Whatever happens above, never leave the transaction held.
      release.resolve()
    }
    await pass
    const arrival = await newestArrival(head)

    expect(await servedName(), 'the held pass published the revision it sampled').toBe('Second')
    expect(BigInt(arrival!) > 0n, 'control: the arrival is durable').toBe(true)
    // The document moved in this process since the sample, so the pass writes
    // the stored REFUSAL rather than its prepared sequence.
    expect(await certificate(head), 'a pass whose document moved since its sample writes 0').toBe('0')
    expect(await proven(), 'an arrival no pass has projected is not proven absent').toBe(false)

    await project(database.pool, head)
    expect(await servedName()).toBe('Third')
    expect(await proven(), 'the pass that projects it restores the proof').toBe(true)
  })

  it('a RAW arrival (no repo, no queue) between the durable read and the COMMIT is not certified, even after another publish', async () => {
    const head = await registryHead('First')
    const other = await registryHead('Other', 'd2')
    await project(database.pool, other)
    rename(head, 'Second')
    await repo.flush([head.documentId])
    const held = deferred()
    const release = deferred()
    let holding = false
    // Held inside the publication, before the queue row moves and before
    // anything about the certificate is decided or captured.
    const target = hookedPool(database.pool, async (sql, proceed) => {
      if (sql.includes('UPDATE read_model_static_document_queue') && !holding) {
        holding = true
        held.resolve()
        await release.promise
      }
      return proceed()
    })
    projector = new StaticDeltaProjector(repo, target)
    const pass = project(target, head)
    await held.promise
    // A chunk this process never loads: the repo's heads do not move, so only
    // the ORDER (its sequence against the prepared one) can refuse it.
    let raw: string
    try {
      raw = (await database.pool.query<{ seq: string }>(
        `INSERT INTO automerge_storage (key, data) VALUES ($1, $2) RETURNING arrival_seq::text AS seq`,
        [`${head.documentId}/incremental/t-sum-2-raw`, Buffer.from([0])],
      )).rows[0].seq
    } finally {
      release.resolve()
    }
    await pass
    const stamp = await certificate(head)
    expect(stamp, 'the heads agreed, so the pass certified its prepared sequence').not.toBe('0')
    expect(BigInt(stamp!) < BigInt(raw), `certificate ${stamp} must be below the raw arrival ${raw}`).toBe(true)
    expect(await proven()).toBe(false)
    // Another document publishes: on the timestamp fallback this would cover it.
    rename(other, 'Other renamed', 'd2')
    await repo.flush([other.documentId])
    await project(database.pool, other)
    expect((await freshness()).status, 'control: that publish completed').toBe('healthy')
    expect(await proven(), 'the raw arrival is still refused').toBe(false)
    await database.pool.query(`DELETE FROM automerge_storage WHERE key = $1`, [`${head.documentId}/incremental/t-sum-2-raw`])
  })

  it('a pass that only ACKNOWLEDGES (ModelMeta, nothing to publish) certifies too, and the root pass stamps the root', async () => {
    const meta = repo.create<Record<string, unknown>>()
    const root = repo.create<Record<string, unknown>>()
    await registerStaticReadModelDocuments(database.pool, WS, [
      { documentId: meta.documentId, kind: 'model-meta' }, { documentId: root.documentId, kind: 'root' },
    ])
    meta.change((doc) => { doc.groups = {} })
    root.change((doc) => { doc.shardUrls = [] })
    await repo.flush([meta.documentId, root.documentId])
    const internal = () => (projector ??= new StaticDeltaProjector(repo, database.pool)) as unknown as {
      project(descriptor: Record<string, unknown>, handle: DocHandle<unknown>): Promise<void>
    }
    const pass = (handle: DocHandle<Record<string, unknown>>, kind: string) => internal().project(
      { ...WS, documentId: handle.documentId, kind, entityId: null, orgId: null }, handle as DocHandle<unknown>)
    await pass(meta, 'model-meta')
    await pass(root, 'root')
    // A change no row depends on: the meta pass acknowledges it.
    meta.change((doc) => { doc.unrelated = 1 })
    await repo.flush([meta.documentId])
    const generation = (await freshness()).projectedGeneration
    await pass(meta, 'model-meta')
    expect((await freshness()).projectedGeneration, 'control: the second meta pass published nothing').toBe(generation)
    for (const [label, handle] of [['model-meta', meta], ['root', root]] as const) {
      const stamp = await certificate(handle as DocHandle<unknown>)
      expect(stamp, `${label} is certified`).not.toBeNull()
      expect(BigInt(stamp!) >= BigInt((await newestArrival(handle as DocHandle<unknown>))!), `${label}: exact`).toBe(true)
    }
    expect(await proven()).toBe(true)
  })

  it('a certificate never outlives a publication that did not commit, even once another publish heals the ladder', async () => {
    const head = await registryHead('First')
    const other = await registryHead('Other', 'd2')
    await project(database.pool, head)
    await project(database.pool, other)
    expect(await proven(), 'control: both certified').toBe(true)
    rename(head, 'Second')
    await repo.flush([head.documentId])

    // The pass writes its certificate, then its publication FAILS before the
    // commit (the generation completion throws once).
    let armed = true
    let sawCertificate = false
    const target = hookedPool(database.pool, async (sql, proceed) => {
      if (sql.includes('INSERT INTO read_model_document_watermarks')) sawCertificate = true
      if (armed && sawCertificate && sql.includes('last_duration_ms = CASE')) {
        armed = false
        throw new Error('T-SUM-2 injected: the publication fails after its certificate')
      }
      return proceed()
    })
    projector = new StaticDeltaProjector(repo, target)
    await expect(project(target, head)).rejects.toThrow(/injected/)
    expect(sawCertificate, 'control: the failed pass reached its certificate').toBe(true)
    expect(await servedName(), 'control: nothing of the failed pass was published').toBe('First')

    // ANOTHER document publishes: the ladder is healthy again.
    rename(other, 'Other renamed', 'd2')
    await repo.flush([other.documentId])
    await project(database.pool, other)
    const after = await freshness()
    expect(after.status, 'control: the other publish brought the workspace back to healthy').toBe('healthy')
    expect(after.absenceProvable, '"Second" was never published: its absence must not be proven').toBe(false)
  })

  it('the entry mark certifies every covered document once, lifts no refusal, and an arrival nothing projects then refuses for good', async () => {
    const head = await registryHead('First')
    // A pass-projected kind no pass has run on yet (the hole: a baseline
    // registry shard or DiagramDoc nobody writes).
    const unprojected = await registryHead('Never projected', 'd3')
    // A frozen baseline document (kind `object-base`), written and admitted.
    const base = repo.create<{ objects: Record<string, { id: string; name: string }> }>()
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: base.documentId, kind: 'object-base' }])
    base.change((doc) => { doc.objects = { o1: { id: 'o1', name: 'Base' } } })
    await repo.flush([base.documentId])
    // A document carrying a stored REFUSAL: the mark must not lift it.
    const refused = await registryHead('Refused', 'd4')
    // Not covered yet (no projection has completed since these writes): NOT marked.
    expect(await markStaticEntryWatermarks(database.pool, WS), 'nothing is covered yet').toBe(0)
    expect(await certificate(base as DocHandle<unknown>)).toBeNull()
    await project(database.pool, head)
    await database.pool.query(
      `INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark)
       VALUES ($1, $2, $3, 0)`, [WS.landscapeId, WS.versionId, refused.documentId])
    const headStamp = await certificate(head as DocHandle<unknown>)
    expect(await markStaticEntryWatermarks(database.pool, WS), 'the frozen document and the never-projected one').toBe(2)
    expect(await certificate(base as DocHandle<unknown>)).toBe(await newestArrival(base as DocHandle<unknown>))
    expect(await certificate(unprojected as DocHandle<unknown>)).toBe(await newestArrival(unprojected as DocHandle<unknown>))
    expect(await certificate(head as DocHandle<unknown>), 'an existing certificate is untouched').toBe(headStamp)
    expect(await certificate(refused as DocHandle<unknown>), 'a stored refusal is not lifted').toBe('0')
    await database.pool.query(`DELETE FROM read_model_document_watermarks WHERE document_id = $1`, [refused.documentId])
    await project(database.pool, refused)
    expect(await proven(), 'every admitted document now certified exactly: the proof holds').toBe(true)
    expect((await database.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM read_model_document_watermarks WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId])).rows[0].n, 'no document left on the fallback').toBe('4')

    // A RAW arrival on the never-projected document and a tracked one on the
    // frozen one — nothing projects either…
    await database.pool.query(`INSERT INTO automerge_storage (key, data) VALUES ($1, $2)`,
      [`${unprojected.documentId}/incremental/t-sum-2-raw`, Buffer.from([0])])
    base.change((doc) => { doc.objects.o1.name = 'Unprojected' })
    await repo.flush([base.documentId])
    expect(await proven()).toBe(false)
    // …and they stay refused after an unrelated publish, which on the
    // timestamp fallback would have covered them.
    rename(head, 'Second')
    await repo.flush([head.documentId])
    await project(database.pool, head)
    expect((await freshness()).status, 'control: that publish completed').toBe('healthy')
    expect(await proven(), 'the unprojected arrivals are still refused').toBe(false)
    await database.pool.query(`DELETE FROM automerge_storage WHERE key = $1`, [`${unprojected.documentId}/incremental/t-sum-2-raw`])
    expect(await proven(), 'control: the frozen arrival alone still refuses').toBe(false)
  })

  it('a write landing between the SAMPLE and the durable read is not certified (the sample, not a later read, is what the rows show)', async () => {
    const head = await registryHead('First')
    await project(database.pool, head)
    rename(head, 'Second')
    await repo.flush([head.documentId])
    // Held at the pass's own capture of the arrival clock — after its
    // snapshot and flush, before its durable read.
    const held = deferred()
    const release = deferred()
    let holding = false
    const target = hookedPool(database.pool, async (sql, proceed) => {
      if (/^\s*SELECT nextval\('automerge_arrival_seq'\)/.test(sql) && !holding) {
        holding = true
        held.resolve()
        await release.promise
      }
      return proceed()
    })
    projector = new StaticDeltaProjector(repo, target)
    const pass = project(target, head)
    await held.promise
    try {
      rename(head, 'Third')
      await repo.flush([head.documentId])
    } finally {
      release.resolve()
    }
    await pass
    expect(await servedName(), 'the pass published its sample').toBe('Second')
    expect(await certificate(head), 'sampled ≠ durable: the stored refusal').toBe('0')
    expect(await proven()).toBe(false)
  })

  it('a pass whose proof cannot be prepared still projects, writes NO certificate, and says so', async () => {
    const head = await registryHead('First')
    await project(database.pool, head)
    const before = await certificate(head)
    rename(head, 'Second')
    await repo.flush([head.documentId])
    const target = hookedPool(database.pool, async (sql, proceed) => {
      if (/^\s*SELECT nextval\('automerge_arrival_seq'\)/.test(sql)) throw new Error('T-SUM-2 injected: no arrival clock')
      return proceed()
    })
    projector = new StaticDeltaProjector(repo, target)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let logged: string[]
    try {
      await project(target, head)
      logged = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('read_model.static_watermark_proof_failed'))
    } finally {
      warn.mockRestore()
    }
    expect(logged, 'the failure is logged').toHaveLength(1)
    expect(await servedName(), 'the rows still projected').toBe('Second')
    expect(await certificate(head), 'no certificate written: the previous one stands').toBe(before)
    expect(await proven(), 'and it does not cover the new arrival').toBe(false)
    expect((projector as unknown as { passStamps: Map<string, unknown> }).passStamps.size, 'no stamp left behind').toBe(0)
  })
})
