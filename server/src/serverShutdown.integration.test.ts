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
 * T-ZEROWM-2 (2) — THE SHUTDOWN ORDER, MEASURED on `index.ts`'s own sequence
 * (`runGracefulShutdown`, `serverShutdown.ts`) over real resources: a Repo on
 * the real `PostgresStorageAdapter`, the real `AutomergeResidencyLeases`, a
 * started `StaticDeltaProjector` with a pass in flight, the real durable-heads
 * decoder (a worker), the real Automerge drain (`drainAutomergeResources`) and
 * shutdown steps (`automergeShutdownSteps`), and a pool of its own that the
 * sequence ENDS. Every operation is observed by call-through wrappers (no
 * behaviour changed) and stamped in one ordered log:
 *
 *  - I1: no residency eviction is still running — or starts — once the Repo
 *        shuts down (an eviction is an async `removeFromCache`, plus a flush
 *        for a document with an unsaved write);
 *  - I2: no statement is issued on the pool once its `end()` began;
 *  - I3: no decode is asked of the decoder once its `close()` began, by a
 *        pass the sequence still waits for (within the ceiling);
 *  - I4: no storage save once the Repo's shutdown ended.
 *
 * Two shapes: a pass held INSIDE the static projector's drain ceiling (the
 * ordinary case of a SIGTERM during a seed), and one held PAST it (the
 * ceiling lowered). Each logs its trace (`server.shutdown_trace`) and its
 * ordered log, for the measure record.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { appendFileSync } from 'node:fs'

import { PostgresStorageAdapter } from './automergeStorage.js'
import { AutomergeResidencyLeases } from './automergeResidency.js'
import { automergeShutdownSteps } from './automergeStorageWiring.js'
import { drainAutomergeResources, runShutdownSteps } from './automergeDrain.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from './testing/isolatedSchema.js'
import { guardIdleClientErrors } from './db/poolErrorGuard.js'
import { ensureReadModelSchema } from './readModel/schema.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './readModel/staticWorkspace.js'
import { markReadModelProjectorAttached } from './readModel/health.js'
import { StaticDeltaProjector } from './readModel/staticDeltaProjector.js'
import { durableHeadsDecoder } from './readModel/durableHeadsDecoder.js'
import { runGracefulShutdown } from './serverShutdown.js'

const CONNECTION = process.env.TEST_DATABASE_URL
const WS = { landscapeId: 'ls-shutdown-order', versionId: 'v1' }
/** Where the measure's trace goes, when set (a JSON-lines file). */
const TRACE_FILE = process.env.ZEROWM2_SHUTDOWN_TRACE_FILE

type ObjectHead = { objects: Record<string, { id: string; name: string }>; writeHeadVersion: number; writeBatchIds: string[] }
type ConnectionHead = { connections: Record<string, unknown>; writeHeadVersion: number; writeBatchIds: string[] }

describe.skipIf(!CONNECTION)('T-ZEROWM-2 (2) — the shutdown order, measured (real Repo, residency, static projector, decoder, pool)', () => {
  let database: IsolatedSchemaDb

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'shutdown_order')
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
  })

  /** One shutdown over real resources, with a static pass held `holdMs` after
   * the signal; `ceilingMs`: the static projector's drain ceiling. */
  async function measuredShutdown(o: { holdMs: number; ceilingMs: number; label: string }) {
    const t0 = performance.now()
    const events: { t: number; ev: string }[] = []
    const note = (ev: string) => events.push({ t: Math.round((performance.now() - t0) * 10) / 10, ev })
    // The pool the sequence ENDS (search_path pinned like the suite's).
    const ownPool = guardIdleClientErrors(new pg.Pool({
      connectionString: CONNECTION!, options: `-c search_path=${database.schema}`, max: 6,
    }), 'serverShutdown:test')
    let poolEnding = false
    /** Statements on the POOL (a new checkout) or new checkouts, once its
     * `end()` began: refused by pg, a write that cannot happen. */
    const lateStatements: string[] = []
    /** Statements on a client checked out BEFORE the end (a transaction in
     * flight): `end()` waits for them; recorded, not a violation. */
    const lateTransactionStatements: string[] = []
    let armed = false
    let heldObjectHead = ''
    let releaseHeld: () => void = () => {}
    const held = new Promise<void>((resolve) => { releaseHeld = resolve })
    let heldReached = false
    const observe = (sql: string, values: unknown[] | undefined, onClient: boolean) => {
      if (poolEnding) (onClient ? lateTransactionStatements : lateStatements).push(sql.replace(/\s+/g, ' ').slice(0, 80))
      if (armed && sql.includes('UPDATE read_model_static_document_queue') && Array.isArray(values) && values[2] === heldObjectHead) {
        armed = false
        heldReached = true
        note('static pass held (inside its transaction)')
        return held
      }
      return undefined
    }
    const wrap = <T extends object>(target: T, onClient = false): T => new Proxy(target, {
      get(subject, property) {
        if (property === 'query') {
          return async (sql: unknown, values?: unknown[]) => {
            const text = typeof sql === 'string' ? sql : String((sql as { text?: string })?.text ?? '')
            const wait = observe(text, values, onClient)
            if (wait) await wait
            return (Reflect.get(subject, 'query', subject) as (s: unknown, v?: unknown[]) => Promise<unknown>).call(subject, sql, values)
          }
        }
        if (property === 'connect') {
          return async () => {
            if (poolEnding) lateStatements.push('connect')
            return wrap(await (Reflect.get(subject, 'connect', subject) as () => Promise<object>).call(subject), true)
          }
        }
        const value = Reflect.get(subject, property, subject)
        return typeof value === 'function' ? value.bind(subject) : value
      },
    })
    const pool = wrap(ownPool)
    const storageAdapter = new PostgresStorageAdapter({ db: pool, trackStaticReadModel: true })
    let repoShutDown = false
    let repoShuttingDown = false
    const lateSaves: string[] = []
    const save = storageAdapter.save.bind(storageAdapter)
    storageAdapter.save = async (key, data) => {
      if (repoShutDown) lateSaves.push(String(key[0]))
      return save(key, data)
    }
    const repo = new Repo({ storage: storageAdapter, network: [], saveDebounceRate: 0 })
    const residency = new AutomergeResidencyLeases(repo)
    let evictionsRunning = 0
    const evictionsAfterRepoShutdown: string[] = []
    const evictionsRunningAtRepoShutdown: string[] = []
    const evict = residency.evict.bind(residency)
    residency.evict = async (documentId, expected) => {
      if (repoShuttingDown) evictionsAfterRepoShutdown.push(documentId)
      evictionsRunning += 1
      note(`residency evict start ${documentId.slice(0, 6)}`)
      try {
        return await evict(documentId, expected)
      } finally {
        evictionsRunning -= 1
        note(`residency evict end ${documentId.slice(0, 6)}`)
      }
    }
    let decoderClosing = false
    const lateDecodes: string[] = []
    const decode = vi.spyOn(durableHeadsDecoder, 'decode').mockImplementation(async (documentId, chunks) => {
      if (decoderClosing) lateDecodes.push(documentId)
      // Call-through to the real decoder (a process singleton, never closed
      // here: `closeDurableHeadsDecoder` below only MARKS the close, so the
      // other cases of this worker keep a decoder). I3 therefore measures the
      // calls asked of it after the sequence closes it, not the real close.
      return decodeReal(documentId, chunks)
    })
    // A failing control below must not leak the projector, the
    // Repo, the pool or the spy into the next case.
    let sequenceRan = false
    let started: StaticDeltaProjector | undefined
    try {

    // The workspace: a ModelMeta and two protocol-v2 heads (no rotation owed).
    await markStaticReadModelWorkspace(database.pool, WS, 'test')
    await markReadModelProjectorAttached(database.pool, WS, null, 'shutdown-order')
    const objectHead = repo.create<ObjectHead>()
    const connectionHead = repo.create<ConnectionHead>()
    const meta = repo.create<Record<string, unknown>>()
    await registerStaticReadModelDocuments(database.pool, WS, [
      { documentId: meta.documentId, kind: 'model-meta' },
      { documentId: objectHead.documentId, kind: 'object-overlay' },
      { documentId: connectionHead.documentId, kind: 'connection-overlay' },
    ])
    objectHead.change((doc) => { doc.objects = { o1: { id: 'o1', name: 'A' } }; doc.writeHeadVersion = 2; doc.writeBatchIds = [] })
    connectionHead.change((doc) => { doc.connections = {}; doc.writeHeadVersion = 2; doc.writeBatchIds = [] })
    meta.change((doc) => {
      doc.groups = {}
      doc.editsObjectShardUrls = [objectHead.url]
      doc.editsObjectShardUrl = objectHead.url
      doc.editsConnectionShardUrls = [connectionHead.url]
      doc.editsConnectionShardUrl = connectionHead.url
    })
    await repo.flush()
    heldObjectHead = String(objectHead.documentId)
    const projector = new StaticDeltaProjector(repo, pool, 250, 5_000, () => true, undefined, residency, undefined, undefined, 50, 100)
    ;(projector as unknown as { stopDrainCeilingMs: number }).stopDrainCeilingMs = o.ceilingMs
    started = projector
    await projector.start()
    const queued = async () => (await database.pool.query<{ revision: string; projected: string }>(
      `SELECT revision::text, projected_revision::text AS projected FROM read_model_static_document_queue
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`, [WS.landscapeId, WS.versionId, heldObjectHead])).rows[0]
    for (let i = 0; i < 400; i += 1) {
      const row = await queued()
      if (row && row.projected === row.revision) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    // The pass in flight at the signal: a write, its pass held inside its
    // transaction (after its proof was prepared through the decoder).
    armed = true
    ;(objectHead as DocHandle<ObjectHead>).change((doc) => { doc.objects.o2 = { id: 'o2', name: 'B' } })
    await repo.flush([objectHead.documentId])
    for (let i = 0; i < 400 && !heldReached; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(heldReached, 'control: a static pass is held in flight at the signal').toBe(true)
    const heldRevision = Number((await queued())?.revision)

    // The sequence, its resources the real ones (observed).
    let draining: Promise<void> | null = null
    const drainAutomerge = () => {
      draining ??= drainAutomergeResources({
        stopEpochRevocation: () => {}, stopWorkspaceCacheInvalidation: () => {},
        wss: { clients: new Set(), close: (callback?: () => void) => { callback?.() } } as never,
        drainResidency: async () => { note('automerge drain: residency start'); await residency.drain(); note('automerge drain: residency end') },
        restoreInboundQueue: () => {},
        flush: async () => { note('automerge drain: final flush start'); await repo.flush(); note('automerge drain: final flush end') },
      })
      return draining
    }
    let exitCode: number | null = null
    const lines: string[] = []
    setTimeout(() => { note('static pass released'); releaseHeld() }, o.holdMs).unref()
    note('signal')
    sequenceRan = true
    await runGracefulShutdown('SIGTERM', {
      stopIntake: () => {},
      stopStaticProjector: () => {
        note('static projector stop start')
        return projector.stop().finally(() => note('static projector stop end'))
      },
      stopMaintenanceIntake: () => {},
      drainMaintenance: async () => {},
      closeDurableHeadsDecoder: async () => { decoderClosing = true; note('decoder close') },
      drainAutomerge,
      stopChangeHub: async () => {},
      closeHttp: async () => {},
      stopOwnership: async () => {},
      shutdownAutomerge: () => runShutdownSteps('Automerge shutdown', automergeShutdownSteps({
        drain: drainAutomerge,
        repoShutdown: async () => {
          repoShuttingDown = true
          evictionsRunningAtRepoShutdown.push(...(evictionsRunning ? [`${evictionsRunning} running`] : []))
          note('repo shutdown start')
          await repo.shutdown()
          repoShutDown = true
          note('repo shutdown end')
        },
        storageAdapter,
        stopBackgroundSaveErrors: () => {},
      })),
      stopRedis: async () => {},
      endPools: async () => {
        poolEnding = true
        note('pool end start')
        await ownPool.end()
        note('pool end end')
      },
      exit: (code) => { exitCode = code },
      log: (line) => lines.push(line),
    })
    note('sequence returned')
    // What still runs after the sequence (past the ceiling): wait for it.
    releaseHeld()
    const inFlight = (projector as unknown as { inFlightRuns: Set<Promise<void>> }).inFlightRuns
    for (let i = 0; i < 400 && inFlight.size > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    note('in-flight passes settled')
    await residency.drain()
    const heldCertificate = (await database.pool.query<{ wm: string }>(
      `SELECT projected_watermark::text AS wm FROM read_model_document_watermarks
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`, [WS.landscapeId, WS.versionId, heldObjectHead])).rows[0]?.wm ?? null
    const heldQueue = await queued()
    const trace = lines.find((line) => line.includes('server.shutdown_trace'))
    const record = {
      label: o.label, holdMs: o.holdMs, ceilingMs: o.ceilingMs, exitCode,
      heldCertificate,
      heldCommitted: Boolean(heldQueue && Number(heldQueue.projected) >= heldRevision),
      heldOwed: Boolean(heldQueue && Number(heldQueue.revision) > Number(heldQueue.projected)),
      evictionsRunningAtRepoShutdown, evictionsAfterRepoShutdown, lateStatements, lateTransactionStatements, lateDecodes, lateSaves,
      trace: trace ? JSON.parse(trace) : null, events,
    }
    if (TRACE_FILE) appendFileSync(TRACE_FILE, `${JSON.stringify(record)}\n`)
    return record
    } finally {
      releaseHeld()
      decode.mockRestore()
      if (!sequenceRan) {
        await started?.stop().catch(() => undefined)
        await repo.shutdown().catch(() => undefined)
        await ownPool.end().catch(() => undefined)
      }
    }
  }

  // The real decoder the spy above calls through to.
  let decodeReal: typeof durableHeadsDecoder.decode
  beforeAll(() => {
    const original = durableHeadsDecoder.decode.bind(durableHeadsDecoder)
    decodeReal = original
  })

  it('a static pass in flight INSIDE the drain ceiling: the stop waits for it; every eviction its lease releases start has settled before the Repo shuts down; nothing reaches the pool after its end, nor the decoder after its close, nor storage after the Repo', async () => {
    const run = await measuredShutdown({ holdMs: 600, ceilingMs: 10_000, label: 'inside-ceiling' })
    expect(run.exitCode, 'the sequence completed').toBe(0)
    const at = (ev: string) => run.events.find((entry) => entry.ev === ev)?.t ?? Number.NaN
    expect(at('static projector stop end'), 'control: the stop waited for the held pass').toBeGreaterThan(at('static pass released'))
    expect(run.events.some((entry) => entry.ev.startsWith('residency evict start')), 'control: the stop released leases that evicted documents').toBe(true)
    // Red on the earlier order (no residency drain after the projectors).
    expect(run.evictionsRunningAtRepoShutdown, `I1: no eviction still running at the Repo shutdown (${JSON.stringify(run.events)})`).toEqual([])
    expect(run.evictionsAfterRepoShutdown, 'I1: no eviction starts after it').toEqual([])
    expect(run.lateStatements, 'I2: no statement once the pool is ending').toEqual([])
    expect(run.lateDecodes, 'I3: no decode once the decoder is closing').toEqual([])
    expect(run.lateSaves, 'I4: no storage save after the Repo shut down').toEqual([])
  }, 60_000)

  it('a static pass in flight PAST the drain ceiling: the sequence does not wait for it; its open transaction finishes on its own client while the pool\'s end waits for it — and, its head evicted by the stop, it certifies no 0', async () => {
    const run = await measuredShutdown({ holdMs: 1_500, ceilingMs: 200, label: 'past-ceiling' })
    expect(run.exitCode, 'the sequence completed').toBe(0)
    const at = (ev: string) => run.events.find((entry) => entry.ev === ev)?.t ?? Number.NaN
    expect(at('static projector stop end'), 'control: the stop returned at its ceiling, before the pass was released').toBeLessThan(at('static pass released'))
    expect(at('pool end end'), 'measured: the pool\'s end waited for the open transaction').toBeGreaterThan(at('static pass released'))
    expect(run.heldCommitted, 'control: the held pass committed, after the Repo shut down').toBe(true)
    // Whatever ran on a client once the end began was that transaction, to
    // its COMMIT (on a slow host it may have committed before: then nothing).
    if (run.lateTransactionStatements.length) expect(run.lateTransactionStatements.at(-1)).toBe('COMMIT')
    expect(run.evictionsRunningAtRepoShutdown, 'I1').toEqual([])
    expect(run.evictionsAfterRepoShutdown, 'I1').toEqual([])
    expect(run.lateSaves, 'I4').toEqual([])
    expect(run.lateStatements, `I2: no NEW statement or checkout reaches the ended pool (${JSON.stringify(run.events)})`).toEqual([])
    expect(run.lateDecodes, 'I3').toEqual([])
    // T-ZEROWM-2 through the real sequence. Before the fix this read '0'.
    expect(run.heldCertificate, 'control: the head has a certificate row (its first pass)').not.toBeNull()
    expect(run.heldCertificate, 'the overdue pass wrote no refusal 0 for the head the stop evicted').not.toBe('0')
    expect(run.heldOwed, 'it left the head owed, for the next boot').toBe(true)
  }, 60_000)
})
