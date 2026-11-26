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
 * T-ZEROWM-3 — the durable recovery of a static document (`recoverChangedDocuments`,
 * at boot and every reload tick: the pass that re-certifies a document a
 * withdrawn pass re-opened) runs under its own residency lease, and a
 * document whose re-openings keep failing is never abandoned: it is retried
 * under a doubling backoff capped at `recoveryBackoffCapMs`, logged once per
 * step, counted, and never certified 0.
 *
 * Real projector, real Repo on the real `PostgresStorageAdapter`, real
 * `AutomergeResidencyLeases`, real PostgreSQL. A diagram is the document under
 * test: nothing else leases one, which is exactly the document an idle
 * eviction could take from under its recovery. ONE pool hook holds (or fails)
 * the diagram's acknowledgement; a trigger records every 0 ever written.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo, type DocHandle, type DocumentId } from '@automerge/automerge-repo'
import type { Pool } from 'pg'

import { PostgresStorageAdapter } from '../automergeStorage.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { markStaticReadModelWorkspace, registerStaticReadModelDocuments } from './staticWorkspace.js'
import { getWorkspaceProjectionFreshness, markReadModelProjectorAttached } from './health.js'
import { StaticDeltaProjector, staticPassWatchMetricSamples, staticRecoveryBackoffMetricSamples } from './staticDeltaProjector.js'

const CONNECTION = process.env.TEST_DATABASE_URL
const WS = { landscapeId: 'ls-zero-watermark-recovery', versionId: 'v1' }

type Snapshot = {
  relaunched: number; withdrawn: number; withdrawnBackedOff?: number
  recoveryLeases?: number; sweepLeases?: number; retiringLeases: number
  /** T-ZEROWM-4: pass watches seen past their ceiling. */
  overdueWatches?: number
}
type Tunable = {
  withdrawnReopenLimit: number; withdrawnFirstBackoffMs: number; recoveryBackoffCapMs: number
  stopDrainCeilingMs: number; inFlightRuns: Set<Promise<void>>
  /** T-ZEROWM-4: the age past which a pass watch is logged and counted. */
  passWatchCeilingMs?: number
  /** T-ZEROWM-4: the period of the overdue-watch check. */
  passWatchCheckMs?: number
  zeroCertificateSweepSnapshot(): Snapshot
  recoveryBackoffSnapshot(): { withdrawnBackingOff: number; zeroSweepBackingOff: number }
  /** The withdrawn re-opening book (its size: entries of any state). */
  withdrawnReopens: { size: number; get(documentId: string): { nextAt: number; revision: string | null } | undefined }
  descriptors: Map<string, unknown>
  listened: Map<string, { handle: DocHandle<unknown> }>
  overlaysAwaitingMeta: Map<string, Map<string, number>>
  retriggerOverlaysAwaitingMeta(workspace: string): void
  recoverChangedDocuments(): Promise<void>
  reloadDescriptors(): Promise<void>
  scanResidentHandles(): void
  trigger(descriptor: unknown, handle: DocHandle<unknown>, immediate?: boolean): Promise<void> | undefined
  passStamps: Map<string, { revision: number }>
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** The pool the projector is handed, with ONE hook on every statement of the
 * pool and of the clients it lends (as in `zeroWatermark.integration.test.ts`). */
function hookedPool(pool: Pool, hook: (sql: string, values: unknown[] | undefined, proceed: () => Promise<unknown>) => Promise<unknown>): Pool {
  const wrap = <T extends object>(target: T): T => new Proxy(target, {
    get(subject, property) {
      if (property === 'query') {
        return (sql: unknown, values?: unknown[]) => {
          const proceed = () => (Reflect.get(subject, 'query', subject) as (sql: unknown, values?: unknown[]) => Promise<unknown>)
            .call(subject, sql, values)
          return typeof sql === 'string' ? hook(sql, values, proceed) : proceed()
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

/** The acknowledgement of a pass of `documentId` — not the withdrawn pass's
 * re-opening of the queue, which is the same table. */
const isAck = (sql: string, values: unknown[] | undefined, documentId: string) =>
  sql.includes('UPDATE read_model_static_document_queue') && !sql.includes('projected_revision + 1')
  && Array.isArray(values) && values[2] === documentId

describe.skipIf(!CONNECTION)('T-ZEROWM-3 — the static recovery pass is leased and never abandoned (real storage, residency, StaticDeltaProjector, PostgreSQL)', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let residency: AutomergeResidencyLeases
  let projector: StaticDeltaProjector | undefined

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'zero_watermark_recovery')
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
    // (f): EVERY 0 ever written to a certificate, whoever wrote it.
    await database.pool.query(`CREATE TABLE IF NOT EXISTS zero_writes (
      document_id TEXT NOT NULL, heads TEXT[], at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`)
    await database.pool.query(`CREATE OR REPLACE FUNCTION record_zero_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.projected_watermark = 0 THEN
          INSERT INTO zero_writes (document_id, heads) VALUES (NEW.document_id, NEW.projected_heads);
        END IF;
        RETURN NEW;
      END $$`)
    await database.pool.query(`DROP TRIGGER IF EXISTS zero_write_witness ON read_model_document_watermarks`)
    await database.pool.query(`CREATE TRIGGER zero_write_witness AFTER INSERT OR UPDATE ON read_model_document_watermarks
      FOR EACH ROW EXECUTE FUNCTION record_zero_write()`)
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
    await database.pool.query('DELETE FROM zero_writes')
    repo = new Repo({
      storage: new PostgresStorageAdapter({ db: database.pool, trackStaticReadModel: true }), network: [], saveDebounceRate: 0,
    })
    residency = new AutomergeResidencyLeases(repo)
    await markStaticReadModelWorkspace(database.pool, WS, 'test')
    await markReadModelProjectorAttached(database.pool, WS, null, 'zero-watermark-recovery')
  })
  afterEach(async () => {
    await projector?.stop()
    projector = undefined
    await repo.shutdown()
  })

  async function until(what: string, predicate: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!(await predicate()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await predicate(), what).toBe(true)
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const certificate = async (documentId: string) => (await database.pool.query<{ wm: string; heads: string[] | null }>(
    `SELECT projected_watermark::text AS wm, projected_heads AS heads FROM read_model_document_watermarks
      WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
    [WS.landscapeId, WS.versionId, documentId])).rows[0] ?? null
  const newestArrival = async (documentId: string) => (await database.pool.query<{ seq: string | null }>(
    `SELECT max(arrival_seq)::text AS seq FROM automerge_storage
      WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) <> 'sync-state'`,
    [documentId])).rows[0]?.seq ?? null
  const queueRow = async (documentId: string) => (await database.pool.query<{ revision: string; projected: string }>(
    `SELECT revision::text, projected_revision::text AS projected FROM read_model_static_document_queue
      WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
    [WS.landscapeId, WS.versionId, documentId])).rows[0] ?? null
  const zeroWrites = async (documentId: string) => Number((await database.pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM zero_writes WHERE document_id = $1', [documentId])).rows[0]!.n)
  /** Nothing owed, and the certificate covers the newest arrival. */
  const certifiedExactly = async (documentId: string) => {
    const row = await queueRow(documentId)
    const stamp = await certificate(documentId)
    const newest = await newestArrival(documentId)
    return Boolean(row && row.projected === row.revision
      && stamp && newest && stamp.wm !== '0' && BigInt(stamp.wm) >= BigInt(newest))
  }
  /** A save by ANOTHER writer (a second Repo on the same storage): no change
   * event reaches this projector — only the durable queue, which the storage
   * adapter bumps, says the document moved. The document must not be
   * resident here (its handle would be stale). */
  const writeElsewhere = async (url: DocHandle<unknown>['url'], name: string) => {
    const writer = new Repo({
      storage: new PostgresStorageAdapter({ db: database.pool, trackStaticReadModel: true }), network: [], saveDebounceRate: 0,
    })
    try {
      const handle = await writer.find<Record<string, unknown>>(url)
      handle.change((doc) => { doc.name = name })
      await writer.flush([handle.documentId])
    } finally {
      await writer.shutdown()
    }
  }
  const leaseOwners = (documentId: string): string[] => {
    const leases = (residency as unknown as { leases: Map<string, { owners: Map<string, unknown> }> }).leases
    return [...(leases.get(documentId)?.owners.keys() ?? [])]
  }
  const recoveryOwners = (documentId: string) => leaseOwners(documentId).filter((owner) => owner.startsWith('static-recovery:'))
  const resident = (documentId: string) => Boolean(
    (repo.synchronizer as unknown as { docSynchronizers: Record<string, unknown> }).docSynchronizers[documentId],
  )
  const tunable = () => projector as unknown as Tunable
  /** T-DIAGDEF: when each reload tick's durable recovery STARTED,
   * and when each PASS started (`project`, whatever started it). */
  const observeTicksAndPasses = (tuned: Tunable, ticks: number[], starts: Array<{ at: number; documentId: string }>) => {
    const observed = tuned as unknown as {
      recoverChangedDocuments(): Promise<void>
      project(descriptor: { documentId: string }, handle: DocHandle<unknown>): Promise<void>
    }
    const recover = observed.recoverChangedDocuments.bind(tuned)
    observed.recoverChangedDocuments = () => { ticks.push(Date.now()); return recover() }
    const project = observed.project.bind(tuned)
    observed.project = (descriptor, handle) => { starts.push({ at: Date.now(), documentId: descriptor.documentId }); return project(descriptor, handle) }
  }
  /** An eviction no lease can refuse — the partition failover's
   * (`evictWorkspaceDocumentCache`: announce, detach the persistence
   * listener, drop from the cache) — under the held pass. */
  const forcedEviction = async (documentId: string) => {
    const held = (repo.synchronizer as unknown as { docSynchronizers: Record<string, { query: { peek(): { state: string; handle?: DocHandle<unknown> } } }> })
      .docSynchronizers[documentId]?.query.peek()
    residency.notifyBeforeEvict(documentId, held?.handle)
    await residency.drain()
    if (!resident(documentId)) return
    held?.handle?.removeAllListeners('heads-changed')
    await repo.removeFromCache(documentId as DocumentId)
  }

  /** A saved, registered diagram, certified exactly by its first pass, then
   * dropped from the cache (idle: nothing leases a diagram) and written by
   * another writer: owed, its certificate below the newest arrival, and only
   * the durable recovery (`recoverChangedDocuments`, the next reload tick)
   * projects it again — the state a withdrawn pass leaves. */
  async function owedDiagram(options: {
    reloadMs?: number
    hook?: (sql: string, values: unknown[] | undefined, id: string) => Promise<void> | void
    tune?: (projector: Tunable) => void
    entityId?: string
    start?: boolean
    /** Called once the projector runs, just before the document is made owed
     * (with the diagram's handle, evicted: a dead handle from then on). */
    beforeOwed?: (id: string, evicted: DocHandle<unknown>) => void
  } = {}) {
    const diagram = repo.create<Record<string, unknown>>()
    const id = String(diagram.documentId)
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: id, kind: 'diagram', entityId: options.entityId ?? 'd1' }])
    diagram.change((doc) => { doc.id = options.entityId ?? 'd1'; doc.name = 'first'; doc.objectIds = []; doc.connectionIds = [] })
    await repo.flush([diagram.documentId])
    if (options.start === false) return { id, diagram }
    let armed = false
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (armed && options.hook) await options.hook(sql, values, id)
      return proceed()
    })
    projector = new StaticDeltaProjector(repo, pool, 250, options.reloadMs ?? 400, () => true, undefined, residency, undefined, undefined, 50, 100)
    options.tune?.(tunable())
    await projector.start()
    await until('control: the first pass is certified exactly', () => certifiedExactly(id))
    await until('control: the first pass settled', () => tunable().inFlightRuns.size === 0)
    await residency.evict(id)
    await residency.drain()
    expect(resident(id), 'control: the diagram is idle and unleased — evicted').toBe(false)
    armed = true
    options.beforeOwed?.(id, diagram as DocHandle<unknown>)
    await writeElsewhere(diagram.url, 'second')
    return { id, diagram }
  }

  /** The recovery pass of the owed diagram reaches its acknowledgement and
   * is held there (or fails there). */
  async function heldRecovery(mode: 'hold' | 'fail', reloadMs?: number) {
    const gate = { reached: deferred(), release: deferred() }
    let fired = false
    const owners: string[] = []
    const { id } = await owedDiagram({
      reloadMs,
      hook: async (sql, values, documentId) => {
        if (fired || !isAck(sql, values, documentId)) return
        fired = true
        owners.push(...leaseOwners(documentId))
        gate.reached.resolve()
        if (mode === 'fail') throw new Error('injected: the recovery pass\'s acknowledgement fails')
        await gate.release.promise
      },
    })
    await gate.reached.promise
    return { id, release: () => gate.release.resolve(), ownersAtAck: owners }
  }

  // --------------------------------------------- (a) the recovery pass is leased

  it('(a) an idle eviction during the recovery pass is refused; the pass certifies, then its lease goes and the document is idle-evictable again', async () => {
    const recovery = await heldRecovery('hold')
    try {
      // Measured before the fix: [] — nothing leased the recovery.
      expect.soft(recoveryOwners(recovery.id), `leased by the recovery during its pass (${JSON.stringify(leaseOwners(recovery.id))})`).toHaveLength(1)
      expect.soft(tunable().zeroCertificateSweepSnapshot().recoveryLeases, 'counted').toBe(1)
      // The idle sweep's own call. Measured before the fix: true.
      expect(await residency.evict(recovery.id), 'the idle eviction is refused: the recovery holds the document').toBe(false)
    } finally {
      recovery.release()
    }
    await until('the recovery certified the newest arrival', () => certifiedExactly(recovery.id))
    await until('then the recovery lease goes', () => recoveryOwners(recovery.id).length === 0
      && tunable().zeroCertificateSweepSnapshot().recoveryLeases === 0)
    await until('its pass settled', () => tunable().inFlightRuns.size === 0)
    await residency.drain()
    // RELINQUISHED, not released: left resident for the idle sweep, as a
    // recovered document was before the lease — which it now evicts.
    expect(resident(recovery.id), 'the release did not drop the document from the cache').toBe(true)
    expect(leaseOwners(recovery.id), 'no owner left').toEqual([])
    expect(await residency.evict(recovery.id), 'the idle eviction now goes through').toBe(true)
    expect(tunable().zeroCertificateSweepSnapshot().withdrawn, 'no pass was withdrawn').toBe(0)
    expect(await zeroWrites(recovery.id), 'no 0 written').toBe(0)
    expect((await getWorkspaceProjectionFreshness(database.pool, WS)).arrivalRefusals?.exact, 'nothing refused on the exact branch').toBe(0)
  }, 60_000)

  it('(a) a recovery pass that FAILS releases its lease all the same', async () => {
    const recovery = await heldRecovery('fail', 5_000)
    // Measured before the fix: no `static-recovery:` owner at the acknowledgement.
    expect(recovery.ownersAtAck.filter((owner) => owner.startsWith('static-recovery:')), 'control: the recovery lease WAS held at its acknowledgement').toHaveLength(1)
    await until('the failed pass released its recovery lease', () => recoveryOwners(recovery.id).length === 0
      && tunable().zeroCertificateSweepSnapshot().recoveryLeases === 0)
    // (Not "still owed": the resolve's `document` event may have queued a
    // second pass of the same document behind the failing one —
    // `triggerIfDurablyPending` — which keeps the lease until it settles and
    // may acknowledge it; measured once in a control run.)
    expect(await zeroWrites(recovery.id), 'no 0 written').toBe(0)
  }, 60_000)

  it('(a) stop() past its ceiling, the recovery pass still held, releases the recovery lease', async () => {
    const recovery = await heldRecovery('hold')
    const stopping = tunable()
    try {
      expect(recoveryOwners(recovery.id), 'control: leased by the recovery').toHaveLength(1)
      stopping.stopDrainCeilingMs = 300
      await projector!.stop()
      projector = undefined
      expect(recoveryOwners(recovery.id), 'no recovery lease after the stop').toEqual([])
      expect(stopping.zeroCertificateSweepSnapshot().recoveryLeases, 'none counted').toBe(0)
      await residency.drain()
      // The recovery lease is RELINQUISHED, so the stop does
      // not evict the diagram (nothing asked for its eviction) — its overdue
      // pass is therefore NOT withdrawn: it still reads its live handle.
      expect(resident(recovery.id), 'relinquished, not evicted, by the stop').toBe(true)
    } finally {
      recovery.release()
      await until('the overdue pass settled', () => stopping.inFlightRuns.size === 0)
    }
    expect(stopping.zeroCertificateSweepSnapshot().withdrawn, 'not withdrawn: its handle was still the Repo\'s').toBe(0)
    expect(await zeroWrites(recovery.id), 'the overdue pass wrote no 0').toBe(0)
  }, 60_000)

  it('(a) release(workspace) during the recovery pass releases the recovery lease', async () => {
    const recovery = await heldRecovery('hold')
    try {
      expect(recoveryOwners(recovery.id), 'control: leased by the recovery').toHaveLength(1)
      projector!.release(WS, 'test: ownership lost')
      expect(recoveryOwners(recovery.id), 'no recovery lease after the release').toEqual([])
      expect(tunable().zeroCertificateSweepSnapshot().recoveryLeases).toBe(0)
    } finally {
      recovery.release()
    }
  }, 60_000)

  it('(a) detach (an announced eviction no lease refuses, the failover\'s) releases the recovery lease; the withdrawn pass writes no 0 and leaves the document owed', async () => {
    const recovery = await heldRecovery('hold', 5_000)
    try {
      expect(recoveryOwners(recovery.id), 'control: leased by the recovery').toHaveLength(1)
      await forcedEviction(recovery.id)
      expect(recoveryOwners(recovery.id), 'no recovery lease after the detach').toEqual([])
      expect(resident(recovery.id), 'control: evicted under the held pass').toBe(false)
    } finally {
      recovery.release()
    }
    await until('the withdrawn pass committed', () => tunable().zeroCertificateSweepSnapshot().withdrawn === 1)
    await until('it settled', () => tunable().inFlightRuns.size === 0)
    const row = await queueRow(recovery.id)
    expect(Number(row?.revision), `left owed (${JSON.stringify(row)})`).toBeGreaterThan(Number(row?.projected))
    expect(await zeroWrites(recovery.id), 'no 0 written').toBe(0)
  }, 60_000)

  // T-DIAGDEF — an intermittent CI red of `--static`: "(a) detach …:
  // control: leased by the recovery: expected [] to have a length of 1" (2 in
  // 30 runs of this file under load, on the `reloadMs: 5_000` cases). The
  // recovery's resolve loads the evicted
  // diagram; the projector's 4 Hz scan (`scanResidentHandles`) attaches its
  // change listener to the handle while it loads, and the load's own change
  // event starts the pass — UNLEASED — before the recovery goes on, which then
  // found the document busy and skipped it (the busy check of the next
  // case). Made certain
  // here: the recovery's `repo.find`, once the document is loaded, runs the
  // scan, replays a change event, and returns only once that pass started.
  it('T-DIAGDEF: a pass started during the recovery\'s own resolve (the scan\'s listener hearing the load) runs under the recovery lease, and is not asked again', async () => {
    const ticks: number[] = []
    const starts: Array<{ at: number; documentId: string }> = []
    const gate = { reached: deferred(), release: deferred() }
    let fired = false
    let startedFirst: boolean | undefined
    const ownersAtAck: string[] = []
    const plain = repo.find.bind(repo)
    const finding = repo as unknown as { find: (...args: unknown[]) => Promise<DocHandle<unknown>> }
    try {
      const { id } = await owedDiagram({
        hook: async (sql, values, documentId) => {
          if (fired || !isAck(sql, values, documentId)) return
          fired = true
          ownersAtAck.push(...leaseOwners(documentId))
          gate.reached.resolve()
          await gate.release.promise
        },
        beforeOwed: (owedId) => {
          observeTicksAndPasses(tunable(), ticks, starts)
          const scanning = tunable() as unknown as { scanResidentHandles(): void }
          finding.find = async (...args: unknown[]) => {
            const handle = await (plain as (...args: unknown[]) => Promise<DocHandle<unknown>>)(...args)
            if (startedFirst === undefined && String(handle.documentId) === owedId) {
              // What the CI interleaved, in its order: the scan attaches its
              // listener to the handle the resolve loaded, and that listener
              // hears a change event (on the CI, the load's own; replayed
              // here, so that it never lands before the listener — measured
              // under load, 1 run in 11, with a scan merely run during the find).
              scanning.scanResidentHandles()
              handle.emit('change', { handle, doc: handle.doc(), patches: [], patchInfo: { before: handle.doc(), after: handle.doc(), source: 'change' } } as never)
              const deadline = Date.now() + 5_000
              while (!starts.some((start) => start.documentId === owedId) && Date.now() < deadline) await sleep(5)
              startedFirst = starts.some((start) => start.documentId === owedId)
            }
            return handle
          }
        },
      })
      await gate.reached.promise
      expect(startedFirst, 'control: the load\'s change event started the pass before the recovery went on').toBe(true)
      // Measured before the fix: [] — the pass ran unleased.
      expect(ownersAtAck.filter((owner) => owner.startsWith('static-recovery:')), `leased by the recovery at its acknowledgement (${JSON.stringify(ownersAtAck)})`).toHaveLength(1)
      expect(await residency.evict(id), 'the idle eviction is refused under the pass').toBe(false)
      gate.release.resolve()
      await until('the pass certified the newest arrival', () => certifiedExactly(id))
      await until('it settled', () => tunable().inFlightRuns.size === 0)
      await until('then the recovery lease goes', () => recoveryOwners(id).length === 0
        && tunable().zeroCertificateSweepSnapshot().recoveryLeases === 0)
      // Not asked again (no `pending` re-run from its `finally`): one pass,
      // and no later tick started another.
      expect(ticks.length, 'control: the recovery ticked').toBeGreaterThanOrEqual(1)
      expect(starts.filter((start) => start.documentId === id), 'exactly one pass of the document').toHaveLength(1)
      expect(await zeroWrites(id), 'no 0 written').toBe(0)
    } finally {
      gate.release.resolve()
      finding.find = plain as unknown as (...args: unknown[]) => Promise<DocHandle<unknown>>
    }
  }, 60_000)

  // ------------------------------- (b)–(d), (f): never abandoned, backed off, capped

  it('(b)(c)(d)(f) a document whose recovery is withdrawn 10 times in a row is retried under a capped backoff, logged once per step, never certified 0 — and certified, without a restart, once the cause is gone', async () => {
    const FIRST = 300
    const CAP = 1_500
    const FAILURES = 10
    // When each withdrawal was logged: "the next tick" is counted
    // from it. The lines still go to the console, as before.
    const warned: Array<{ at: number; line: string }> = []
    const realWarn = console.warn.bind(console)
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push({ at: Date.now(), line: String(args[0]) })
      realWarn(...args)
    })
    // Possibly absent: this case was measured RED on a build without this
    // metric, and must fail there on the abandonment, not on the import.
    const samples = () => (staticRecoveryBackoffMetricSamples as typeof staticRecoveryBackoffMetricSamples | undefined)?.() ?? []
    const counter = () => samples()[0]?.values.find((value) => value.labels?.recovery === 'withdrawn_reopen')?.value ?? 0
    const gauge = () => samples()[1]?.values.find((value) => value.labels?.recovery === 'withdrawn_reopen')?.value ?? 0
    const counterBefore = counter()
    const attempts: number[] = []
    let withdrawing = true
    const zeroSeen: string[] = []
    // T-DIAGDEF: when each reload tick's durable recovery STARTED —
    // "the next tick" is counted in ticks, not in milliseconds (under load a
    // tick of the 100 ms interval came 340 ms after the previous one).
    const recoveryTicks: number[] = []
    // When each PASS started (`project`), so "the next tick"
    // runs up to the START of attempt k+1, not to its acknowledgement.
    const passStarts: Array<{ at: number; documentId: string }> = []
    try {
      const { id } = await owedDiagram({
        reloadMs: 100,
        tune: (tuned) => {
          tuned.withdrawnReopenLimit = 5; tuned.withdrawnFirstBackoffMs = FIRST; tuned.recoveryBackoffCapMs = CAP
          observeTicksAndPasses(tuned, recoveryTicks, passStarts)
        },
        hook: async (sql, values, documentId) => {
          if (!isAck(sql, values, documentId)) return
          attempts.push(Date.now())
          // The cause: an eviction no lease refuses, under every recovery pass.
          if (withdrawing) await forcedEviction(documentId)
        },
      })
      // (f) polled as well as the trigger: the certificate is never 0.
      const poll = setInterval(() => {
        void certificate(id).then((stamp) => { if (stamp?.wm === '0') zeroSeen.push(JSON.stringify(stamp)) }).catch(() => undefined)
      }, 25)
      try {
        // Measured before the fix: 6 withdrawals, then
        // `static_withdrawn_reopen_exhausted` and nothing more until a restart.
        await until(`${FAILURES} withdrawn recovery passes`, () => tunable().zeroCertificateSweepSnapshot().withdrawn >= FAILURES, 40_000)
        // A second document owed while the first backs off at the cap is not
        // starved: it is certified at the next ticks.
        const other = await owedDiagram({ start: false, entityId: 'd2' })
        await until('control: the second diagram\'s first pass', () => certifiedExactly(other.id))
        expect(gauge(), 'the backing-off document is in the gauge').toBe(1)
        expect((await getWorkspaceProjectionFreshness(database.pool, WS)).arrivalRefusals?.exact, 'control: the first is refused while it backs off').toBe(1)
        await until('control: the second diagram\'s pass settled', () => tunable().inFlightRuns.size === 0)
        await residency.evict(other.id)
        await residency.drain()
        await writeElsewhere(other.diagram.url, 'second')
        await until('the second diagram is certified while the first backs off', () => certifiedExactly(other.id), 1_000)
        expect(gauge(), 'control: the first still backs off').toBe(1)
        withdrawing = false
        await until('the document is certified, without a restart, once the cause is gone', () => certifiedExactly(id), 20_000)
      } finally {
        withdrawing = false // whatever failed above, no eviction outlives the case
        clearInterval(poll)
      }
      const snapshot = tunable().zeroCertificateSweepSnapshot()
      const failures = snapshot.withdrawn
      const withdrawnLines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('read_model.static_certificate_withdrawn_head'))
      expect(failures, `every injected withdrawal, and only them (${withdrawnLines.map((line) => (line.includes(id) ? 'A' : 'other')).join(',')}; attempts ${JSON.stringify(attempts.map((at) => at - attempts[0]!))})`).toBe(attempts.length - 1)
      expect(failures, 'at least the planned withdrawals').toBeGreaterThanOrEqual(FAILURES)
      // (c) the schedule: failures 1–5 retried at the next tick (backed off
      // only "beyond 5"); failure k ≥ 6 waits FIRST·2^(k−6), capped at CAP.
      const expected = Array.from({ length: failures }, (_, index) => {
        const failure = index + 1
        return failure <= 5 ? 0 : Math.min(CAP, FIRST * 2 ** (failure - 6))
      })
      const gaps = attempts.slice(1, failures + 1).map((at, index) => at - attempts[index]!)
      const withdrawnAt = warned
        .filter((entry) => entry.line.includes('read_model.static_certificate_withdrawn_head') && entry.line.includes(id))
        .map((entry) => entry.at)
      // One logged withdrawal per failure — or the tick count below
      // would read an absent one as "no tick", and pass in silence.
      expect(withdrawnAt.length, 'one withdrawal line per failure').toBe(failures)
      const startsOf = passStarts.filter((start) => start.documentId === id).map((start) => start.at)
      for (const [index, gap] of gaps.entries()) {
        expect(gap, `attempt ${index + 2} waited at least the backoff of failure ${index + 1} (${expected[index]} ms; gaps ${JSON.stringify(gaps)})`)
          .toBeGreaterThanOrEqual(expected[index]!)
      }
      for (const index of gaps.keys()) {
        if (expected[index]! > 0) continue
        // The first failures are retried at the NEXT tick, not
        // backed off — counted in TICKS from the withdrawal, not in
        // milliseconds (under load the 100 ms interval drifted to 340 ms): at
        // most two recovery ticks STARTED between failure k's withdrawal and
        // attempt k+1 (one may read the queue before the withdrawal's
        // re-opening committed; the next takes it). Up to the
        // START of attempt k+1's pass — its first `project` after the
        // withdrawal — not to its acknowledgement, which a loaded pass
        // reaches ticks later.
        const withdrawal = withdrawnAt[index]!
        const started = startsOf.find((at) => at >= withdrawal)
        expect(started, `control: attempt ${index + 2}'s pass started after withdrawal ${index + 1}`).toBeDefined()
        const ticksBetween = recoveryTicks.filter((at) => at >= withdrawal && at <= started!).length
        expect(ticksBetween, `attempt ${index + 2} came at the next ticks (ticks between withdrawal ${index + 1} and its start: ${ticksBetween}; gaps ${JSON.stringify(gaps)})`).toBeLessThanOrEqual(2)
      }
      for (const [index, gap] of gaps.entries()) {
        if (expected[index]! < CAP) continue
        expect(gap, `capped: attempt ${index + 2} came within the cap plus a tick (${CAP} ms; gaps ${JSON.stringify(gaps)})`).toBeLessThan(CAP + 700)
      }
      // (d) logged once per STEP, not once per retry: steps 300, 600, 1 200, 1 500.
      const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(id))
      const steps = lines.filter((line) => line.includes('read_model.static_withdrawn_reopen_backoff')).map((line) => JSON.parse(line) as { backoffMs: number; reopens: number })
      expect(steps.map((step) => step.backoffMs), 'one line per backoff step').toEqual([300, 600, 1_200, 1_500])
      expect(steps.map((step) => step.reopens), 'beyond the 5th failure').toEqual([6, 7, 8, 9])
      expect(lines.filter((line) => line.includes('read_model.static_withdrawn_reopen_exhausted')), 'never abandoned').toEqual([])
      expect(lines.filter((line) => line.includes('read_model.static_recovery_backoff_healed')), 'its healing said once').toHaveLength(1)
      // The metric: one retry per backed-off failure (the 6th on).
      expect(counter() - counterBefore, 'counted').toBe(failures - 5)
      expect(snapshot.withdrawnBackedOff, 'counted on the projector').toBe(failures - 5)
      expect(gauge(), 'healed: out of the gauge').toBe(0)
      // (f) never a 0, at any point.
      expect(zeroSeen, 'no 0 observed').toEqual([])
      expect(await zeroWrites(id), 'no 0 ever written (trigger)').toBe(0)
      const freshness = await getWorkspaceProjectionFreshness(database.pool, WS)
      expect({ zero: freshness.arrivalRefusals?.zero, exact: freshness.arrivalRefusals?.exact }, 'nothing refused').toEqual({ zero: 0, exact: 0 })
    } finally {
      warn.mockRestore()
    }
  }, 90_000)

  it('T-DIAGDEF: reload ticks during a RUNNING recovery pass do not re-run it past its backoff once it is withdrawn', async () => {
    // The intermittent red of the case above (`ci:local --static`:
    // "attempt 7 … 41 ms … ≥ 300"), made deterministic: the first pass that
    // backs off (failure 6) is held at its acknowledgement for five reload
    // ticks (100 ms). Measured before the fix: every tick's
    // `recoverChangedDocuments` asked for the document while its pass ran,
    // `trigger` marked it `pending`, and the pass's `finally` re-ran it at once
    // after its withdrawal had set the 300 ms backoff.
    const FIRST = 300
    const attempts: number[] = []
    let heldFrom = 0
    let heldUntil = 0
    let withdrawing = true
    const recoveryTicks: number[] = []
    try {
      const { id } = await owedDiagram({
        reloadMs: 100,
        tune: (tuned) => {
          tuned.withdrawnReopenLimit = 5; tuned.withdrawnFirstBackoffMs = FIRST; tuned.recoveryBackoffCapMs = 1_500
          observeTicksAndPasses(tuned, recoveryTicks, [])
        },
        hook: async (sql, values, documentId) => {
          // Pass 6 — the first one to back off — held at its source-revision
          // read (after its sample, BEFORE any workspace-tail work, which the
          // reload chain awaits) across five reload ticks.
          if (attempts.length === 5 && heldUntil === 0 && sql.includes('SELECT revision FROM read_model_static_document_queue')
            && Array.isArray(values) && values[2] === documentId) {
            heldUntil = -1
            heldFrom = Date.now()
            await new Promise((resolve) => setTimeout(resolve, 500))
            heldUntil = Date.now()
            return
          }
          if (!isAck(sql, values, documentId)) return
          attempts.push(Date.now())
          if (withdrawing) await forcedEviction(documentId)
        },
      })
      await until('the attempt after the first backed-off failure', () => attempts.length >= 7, 20_000)
      withdrawing = false
      expect(heldUntil, 'control: pass 6 was held').toBeGreaterThan(0)
      // The race this case is about needs a tick DURING the hold.
      expect(recoveryTicks.filter((at) => at >= heldFrom && at <= heldUntil).length, 'control: recovery ticks started during the hold').toBeGreaterThanOrEqual(1)
      // Measured from attempt 6's acknowledgement: its withdrawal — and the
      // backoff it sets — comes right after it.
      const gap = attempts[6]! - attempts[5]!
      expect(gap, `attempt 7 waited the backoff of failure 6 (${FIRST} ms; attempts ${JSON.stringify(attempts.map((at) => at - attempts[0]!))})`)
        .toBeGreaterThanOrEqual(FIRST)
      await until('certified once the cause is gone', () => certifiedExactly(id), 20_000)
    } finally {
      withdrawing = false
    }
  }, 60_000)

  it('T-DIAGDEF: a tick between the eviction of a pass and the commit of its withdrawal starts no second pass', async () => {
    // `detach` empties `docRuns` at the eviction's announcement, while the
    // evicted pass runs on to its withdrawal; the re-opening (and its
    // backoff) exists only once that transaction commits. The window, held
    // open: pass 6 is evicted at its source-revision read — after its sample,
    // BEFORE its workspace-tail work (the reload chain awaits the tails, so an
    // eviction under the acknowledgement leaves no tick to race) — and held
    // there 500 ms (five reload ticks); it then runs on to its withdrawal.
    // Measured before the fix: a tick started a second pass on a fresh
    // handle inside the window.
    const FIRST = 300
    const attempts: number[] = []
    let evictedAt = 0
    let heldUntil = 0
    let withdrawing = true
    const recoveryTicks: number[] = []
    const passStarts: Array<{ at: number; documentId: string }> = []
    try {
      const { id } = await owedDiagram({
        reloadMs: 100,
        tune: (tuned) => {
          tuned.withdrawnReopenLimit = 5; tuned.withdrawnFirstBackoffMs = FIRST; tuned.recoveryBackoffCapMs = 1_500
          observeTicksAndPasses(tuned, recoveryTicks, passStarts)
        },
        hook: async (sql, values, documentId) => {
          if (attempts.length === 5 && heldUntil === 0 && sql.includes('SELECT revision FROM read_model_static_document_queue')
            && Array.isArray(values) && values[2] === documentId) {
            heldUntil = -1
            await forcedEviction(documentId)
            evictedAt = Date.now()
            await new Promise((resolve) => setTimeout(resolve, 500))
            heldUntil = Date.now()
            return
          }
          if (!isAck(sql, values, documentId)) return
          attempts.push(Date.now())
          if (withdrawing) await forcedEviction(documentId)
        },
      })
      await until('the attempt after the held one', () => attempts.length >= 7, 20_000)
      withdrawing = false
      expect(heldUntil, 'control: pass 6 was held').toBeGreaterThan(0)
      expect(recoveryTicks.filter((at) => at >= evictedAt && at <= heldUntil).length, 'control: recovery ticks started in the window').toBeGreaterThanOrEqual(1)
      const inWindow = passStarts.filter((start) => start.documentId === id && start.at > evictedAt && start.at < heldUntil)
      expect(inWindow.map((start) => start.at - evictedAt), 'no second pass while the evicted one has not ended').toEqual([])
      expect(attempts[6]! - heldUntil, `attempt 7 waited the backoff of failure 6 (${FIRST} ms after the held pass ended)`).toBeGreaterThanOrEqual(FIRST)
      await until('certified once the cause is gone', () => certifiedExactly(id), 20_000)
    } finally {
      withdrawing = false
    }
  }, 60_000)

  it('T-DIAGDEF: the recovery of an owed ModelMeta runs ONE pass — not the one `attach` starts plus a pending re-run', async () => {
    // `attach` itself starts the pass of a ModelMeta (and of a root); were the
    // recovery to ask for it again, `trigger` would mark it pending and its
    // `finally` re-run it at once. A GUARD, green before the fix too
    // (measured): here the 4 Hz scan may already attach the handle the resolve
    // loads, and the busy check after the resolve then skips it. The check added
    // after `attach` covers the handle that is resident but not listened,
    // which `attach` itself starts.
    const recoveryTicks: number[] = []
    const passStarts: Array<{ at: number; documentId: string }> = []
    const meta = repo.create<Record<string, unknown>>()
    const id = String(meta.documentId)
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: id, kind: 'model-meta' }])
    meta.change((doc) => { doc.deletedDiagramIds = []; doc.groups = {} })
    await repo.flush([meta.documentId])
    projector = new StaticDeltaProjector(repo, database.pool, 250, 100, () => true, undefined, residency, undefined, undefined, 50, 100)
    observeTicksAndPasses(tunable(), recoveryTicks, passStarts)
    await projector.start()
    await until('control: the boot passes settled', () => tunable().inFlightRuns.size === 0)
    // T-ZEROWM-4: nothing of THIS projector loads the ModelMeta
    // while the other writer writes. Each tick's control-document hydration
    // re-attaches an evicted ModelMeta — and `attach` runs its pass — so
    // without this hold the re-attach could land INSIDE the write: a first
    // pass of the revision before the save (read 2 or 3), then the recovery's
    // pass of the revision the save made owed (4) — two passes of two
    // revisions, both due (measured under load, this file alone: 5 to 7 runs
    // in 30).
    // Not a double pass: a witness that counted from before the write.
    const written = deferred()
    const plain = repo.find.bind(repo)
    repo.find = (async (...args: Parameters<Repo['find']>) => {
      if (String(args[0]).endsWith(id)) await written.promise
      return plain(...args)
    }) as Repo['find']
    // Not resident, and owed: the next tick (its hydration of the control
    // documents, or its recovery) loads and attaches it.
    await forcedEviction(id)
    expect(resident(id), 'control: the ModelMeta is not resident').toBe(false)
    // Before the write: a tick (100 ms) may recover it before the writer's
    // shutdown returns (measured under load: its one pass started before a
    // `from` taken after the write — "expected [] to have a length of 1").
    const from = Date.now()
    try {
      await writeElsewhere(meta.url, 'owed')
    } finally {
      written.resolve()
      repo.find = plain as Repo['find']
    }
    await until('the recovery projected it', async () => {
      const { rows } = await database.pool.query<{ owed: boolean }>(
        `SELECT revision > projected_revision AS owed FROM read_model_static_document_queue
          WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`, [WS.landscapeId, WS.versionId, id])
      return rows[0]?.owed === false
    }, 10_000)
    await until('every pass settled', () => tunable().inFlightRuns.size === 0)
    // Three more ticks: a pending re-run, had there been one, has started.
    const ticksSoFar = recoveryTicks.length
    await until('three more recovery ticks', () => recoveryTicks.length >= ticksSoFar + 3, 10_000)
    const passes = passStarts.filter((start) => start.documentId === id && start.at >= from)
    expect(passes.map((start) => start.at - from), 'one pass of the recovered ModelMeta').toHaveLength(1)
  }, 60_000)

  it('(c) a newer save is not held back by the backoff of a re-opened revision', async () => {
    let withdrawing = true
    const attempts: number[] = []
    const { id, diagram } = await owedDiagram({
      reloadMs: 100,
      // Failure 1 already backs off, and for a long time.
      tune: (tuned) => { tuned.withdrawnReopenLimit = 0; tuned.withdrawnFirstBackoffMs = 60_000; tuned.recoveryBackoffCapMs = 60_000 },
      hook: async (sql, values, documentId) => {
        if (!isAck(sql, values, documentId)) return
        attempts.push(Date.now())
        if (withdrawing) await forcedEviction(documentId)
      },
    })
    await until('the recovery was withdrawn once', () => tunable().zeroCertificateSweepSnapshot().withdrawn === 1)
    await sleep(800)
    // Measured before the fix: retried at every tick (no backoff).
    expect(attempts, 'backing off: not retried inside its window').toHaveLength(1)
    withdrawing = false
    // A real save, by ANOTHER writer (only the durable queue says it): the
    // storage adapter bumps the queue revision past the re-opened one.
    expect(resident(id), 'control: the withdrawn handle is gone here').toBe(false)
    await writeElsewhere(diagram.url, 'third')
    await until('the newer save is projected and certified at once, inside the 60 s window', () => certifiedExactly(id), 5_000)
    expect(attempts.length, 'by the recovery').toBe(2)
    expect(await zeroWrites(id)).toBe(0)
  }, 60_000)

  // ------------------------------------- the handle check and the lease's timing

  /** The recovery's resolve of the owed diagram, observed: `inside` evicts it
   * before the resolve returns (the handle it hands back is dead); `next-turn`
   * schedules an idle eviction for the very next timer turn — after the
   * resolve, before any await of the pass. */
  async function evictionAroundTheResolve(mode: 'inside' | 'next-turn' | 'microtask-after-check') {
    const evictions: boolean[] = []
    let armedResolve = false
    const originalFind = repo.find.bind(repo)
    const { id } = await owedDiagram({
      reloadMs: 300,
      beforeOwed: (documentId) => {
        armedResolve = true
        repo.find = (async (...args: Parameters<Repo['find']>) => {
          const handle = await originalFind(...args)
          if (armedResolve && String(handle.documentId) === documentId) {
            armedResolve = false
            if (mode === 'inside') evictions.push(await residency.evict(documentId))
            else if (mode === 'next-turn') setTimeout(() => { void residency.evict(documentId).then((evicted) => evictions.push(evicted)) }, 0)
            else {
              // The recovery's handle check is the next `peek` of this
              // document: it queues an idle eviction as a MICROTASK, which runs
              // at the first await after the check — none before the lease.
              const query = (repo.synchronizer as unknown as { docSynchronizers: Record<string, { query: { peek: () => unknown } }> })
                .docSynchronizers[documentId]!.query
              const peek = query.peek.bind(query)
              query.peek = () => {
                query.peek = peek
                queueMicrotask(() => { void residency.evict(documentId).then((evicted) => evictions.push(evicted)) })
                return peek()
              }
            }
          }
          return handle
        }) as Repo['find']
      },
    })
    try {
      await until('the eviction was attempted', () => evictions.length === 1)
      await until('the document is certified', () => certifiedExactly(id), 10_000)
    } finally {
      repo.find = originalFind as Repo['find']
    }
    return { id, evicted: evictions[0] }
  }

  it('(a) a handle evicted inside the recovery\'s resolve is not projected: skipped (no withdrawal, no 0), and the next tick certifies', async () => {
    const run = await evictionAroundTheResolve('inside')
    expect(run.evicted, 'control: the eviction inside the resolve went through').toBe(true)
    expect(tunable().zeroCertificateSweepSnapshot().withdrawn, 'no pass ran on the dead handle (it would have been withdrawn)').toBe(0)
    expect(await zeroWrites(run.id)).toBe(0)
  }, 60_000)

  it('(a) the lease is taken in the same macrotask as the resolve: an idle eviction at the next timer turn is already refused', async () => {
    const run = await evictionAroundTheResolve('next-turn')
    expect(run.evicted, 'the idle eviction right after the resolve is refused: the recovery holds the document').toBe(false)
    expect(tunable().zeroCertificateSweepSnapshot().withdrawn, 'no withdrawal').toBe(0)
    expect(await zeroWrites(run.id)).toBe(0)
  }, 60_000)

  it('(a) the lease is taken with NO await between the handle check and the acquisition: an idle eviction queued as a microtask by the check is already refused', async () => {
    const run = await evictionAroundTheResolve('microtask-after-check')
    // Mutant `await Promise.resolve()` between the check and `acquire`: true.
    expect(run.evicted, 'refused: leased before any microtask ran').toBe(false)
    expect(tunable().zeroCertificateSweepSnapshot().withdrawn, 'no withdrawal').toBe(0)
    expect(await zeroWrites(run.id)).toBe(0)
  }, 60_000)

  // --------------------------------------- a document the bounded book dropped

  it('(c) saturation: a backing-off document dropped from the bounded book re-enters at the cap, and stays there', async () => {
    const FIRST = 200
    const CAP = 1_500
    const failing = new Set<string>()
    const failOnce = new Set<string>()
    const attempts = new Map<string, number[]>()
    const lines: { at: number; line: string }[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { lines.push({ at: Date.now(), line: String(line) }) })
    let aId = ''
    let bId = ''
    let bFailed = false
    try {
      const { id: a } = await owedDiagram({
        reloadMs: 100,
        tune: (tuned) => {
          tuned.withdrawnReopenLimit = 1; tuned.withdrawnFirstBackoffMs = FIRST; tuned.recoveryBackoffCapMs = CAP
          // A book of ONE entry: a second failing document drops the first.
          ;(tuned as unknown as { withdrawnReopens: { bound: number } }).withdrawnReopens.bound = 1
        },
        beforeOwed: (documentId) => { failing.add(documentId) },
        hook: async (sql, values) => {
          const documentId = Array.isArray(values) ? String(values[2]) : ''
          if (!failing.has(documentId) || !isAck(sql, values, documentId)) return
          attempts.set(documentId, [...(attempts.get(documentId) ?? []), Date.now()])
          if (failOnce.delete(documentId)) failing.delete(documentId)
          // T-ZEROWM-4: B keeps failing until A's next failure — HERE,
          // inside A's transaction, which holds the workspace's tail: B's
          // healing pass cannot commit before A's withdrawal does. With B
          // failing ONCE, its healing pass of the same tick could commit first
          // and empty the book of one entry, which DESATURATES it; A then
          // re-entered unsaturated, never "assumed" (forced: 3 runs in 3;
          // 2 runs in 60 under load otherwise).
          if (documentId === aId && bFailed) failing.delete(bId)
          if (documentId === bId) bFailed = true
          await forcedEviction(documentId)
        },
      })
      aId = a
      await until('A backs off (two failures)', () => (attempts.get(a)?.length ?? 0) >= 2)
      // B fails ONCE: the book drops A, which was backing off — saturated.
      const b = await owedDiagram({ start: false, entityId: 'd2' })
      await until('control: B\'s first pass', () => certifiedExactly(b.id))
      await until('control: B\'s pass settled', () => tunable().inFlightRuns.size === 0)
      await residency.evict(b.id)
      await residency.drain()
      bId = b.id
      failing.add(b.id)
      await writeElsewhere(b.diagram.url, 'second')
      const entered = () => lines.find(({ line }) => line.includes('read_model.static_withdrawn_reopen_backoff')
        && line.includes(a) && line.includes('"assumedFromSaturation":true'))
      await until('A re-entered the saturated book at the cap', () => Boolean(entered()), 20_000)
      const enteredAt = entered()!.at
      expect((JSON.parse(entered()!.line) as { backoffMs: number }).backoffMs, 'at the cap').toBe(CAP)
      await until('two more failures of A', () => (attempts.get(a) ?? []).filter((at) => at > enteredAt).length >= 2, 20_000)
      failing.delete(a)
      const after = (attempts.get(a) ?? []).filter((at) => at > enteredAt)
      // Measured with `entering` ignored: ~200 ms; with the entry counted at 1
      // (the first version of this fix): the gap after it ~400 ms.
      expect(after[0]! - enteredAt, `the retry after it waited the cap (${JSON.stringify(after.map((at) => at - enteredAt))})`).toBeGreaterThanOrEqual(CAP - 20)
      expect(after[1]! - after[0]!, `and the next one too (${JSON.stringify(after.map((at) => at - enteredAt))})`).toBeGreaterThanOrEqual(CAP)
      await until('A certified once the cause is gone', () => certifiedExactly(a), 20_000)
      await until('B certified', () => certifiedExactly(b.id), 20_000)
      expect(await zeroWrites(a) + await zeroWrites(b.id), 'no 0').toBe(0)
    } finally {
      warn.mockRestore()
    }
  }, 90_000)

  // ------------------------------------------------------ books and commits

  it('a withdrawn pass whose TRANSACTION ROLLS BACK touches no book (updates apply after COMMIT only)', async () => {
    let evictOnce = true
    let failNext = false
    let failed = false
    const { id } = await owedDiagram({
      reloadMs: 5_000,
      // The first withdrawal already backs off: an entry would show.
      tune: (tuned) => { tuned.withdrawnReopenLimit = 0 },
      hook: async (sql, values, documentId) => {
        if (failNext && !sql.startsWith('ROLLBACK')) {
          failNext = false
          failed = true
          throw new Error('injected: the statement after the re-opening fails, the transaction rolls back')
        }
        if (evictOnce && isAck(sql, values, documentId)) {
          evictOnce = false
          await forcedEviction(documentId)
        }
        if (sql.includes('projected_revision + 1') && Array.isArray(values) && values[2] === documentId && !failed) failNext = true
      },
    })
    // The queue row as the other writer left it (the recovery is ≥ 5 s away).
    const owedRow = await queueRow(id)
    await until('the withdrawn pass rolled back', () => failed, 15_000)
    await until('it settled', () => tunable().inFlightRuns.size === 0)
    expect(tunable().zeroCertificateSweepSnapshot().withdrawn, 'control: the pass WAS withdrawn (counted as a decision)').toBe(1)
    // With the book updated inside the transaction (a mutant): 1 entry, backing off.
    expect(tunable().withdrawnReopens.size, 'no book entry for a rolled-back re-opening').toBe(0)
    expect(tunable().recoveryBackoffSnapshot().withdrawnBackingOff).toBe(0)
    expect(tunable().zeroCertificateSweepSnapshot().withdrawnBackedOff).toBe(0)
    // The row EXACTLY as before — neither the acknowledgement
    // nor the re-opening committed.
    expect(await queueRow(id), 'nothing committed').toEqual(owedRow)
    await until('the next tick certifies it', () => certifiedExactly(id), 15_000)
    expect(await zeroWrites(id)).toBe(0)
  }, 60_000)

  it('no book entry for a document whose descriptor went while its withdrawn pass was in flight', async () => {
    const gate = { reached: deferred(), release: deferred() }
    let fired = false
    const { id } = await owedDiagram({
      reloadMs: 300,
      tune: (tuned) => { tuned.withdrawnReopenLimit = 0 },
      hook: async (sql, values, documentId) => {
        if (fired || !isAck(sql, values, documentId)) return
        fired = true
        gate.reached.resolve()
        await gate.release.promise
      },
    })
    try {
      await gate.reached.promise
      // The document leaves the plane's allow-list; the reload drops it.
      await database.pool.query('DELETE FROM read_model_static_documents WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3',
        [WS.landscapeId, WS.versionId, id])
      // T-ZEROWM-4: the reload's OWN step, called here — not a wait for the
      // reload chain. The held acknowledgement sits on the workspace's tail,
      // and every tick awaits the tails (`hydrateControlDocuments`,
      // `recoverChangedDocuments`): a tick whose descriptor SELECT ran before
      // the DELETE then waits on this very hold, and no later tick runs until
      // it is released — which happens only once the descriptor is gone. Under
      // load one run in 30 had such a tick (measured; forced, 3 runs in 3):
      // 20 s, then "the
      // reload dropped the descriptor" failed. A witness deadlock, not a
      // projector defect. The direct call holds whatever state the chain is
      // in — parked already, about to park, or free (a first form of this fix
      // also waited for a tick to reload during the hold: under load the chain
      // was sometimes parked BEFORE it, and that wait failed, 4 runs in 30).
      await tunable().reloadDescriptors()
      expect(tunable().descriptors.has(id), 'the reload dropped the descriptor').toBe(false)
      await forcedEviction(id)
    } finally {
      gate.release.resolve()
    }
    await until('the withdrawn pass committed', () => tunable().zeroCertificateSweepSnapshot().withdrawn === 1)
    await until('it settled', () => tunable().inFlightRuns.size === 0)
    // Without the `stillProjects` guard: 1 entry, backing off, for ever.
    expect(tunable().withdrawnReopens.size, 'no phantom entry').toBe(0)
    expect(tunable().recoveryBackoffSnapshot().withdrawnBackingOff, 'not in the gauge').toBe(0)
    expect(await zeroWrites(id)).toBe(0)
  }, 60_000)

  it('the ModelMeta-driven re-run of deferred overlays (retriggerOverlaysAwaitingMeta) runs under the recovery lease, and skips a dead listened handle', async () => {
    const gate = { reached: deferred(), release: deferred() }
    let holdAck = false
    const ownersAtAck: string[] = []
    let acks = 0
    const diagram = repo.create<Record<string, unknown>>()
    const id = String(diagram.documentId)
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: id, kind: 'diagram', entityId: 'd1' }])
    diagram.change((doc) => { doc.id = 'd1'; doc.name = 'first'; doc.objectIds = []; doc.connectionIds = [] })
    await repo.flush([diagram.documentId])
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (isAck(sql, values, id)) {
        acks += 1
        if (holdAck) {
          holdAck = false
          ownersAtAck.push(...leaseOwners(id))
          gate.reached.resolve()
          await gate.release.promise
        }
      }
      return proceed()
    })
    projector = new StaticDeltaProjector(repo, pool, 250, 60_000, () => true, undefined, residency, undefined, undefined, 50, 100)
    await projector.start()
    await until('control: the first pass is certified', () => certifiedExactly(id))
    await until('control: attached and settled', () => tunable().listened.has(id) && tunable().inFlightRuns.size === 0)
    const workspace = `${WS.landscapeId}\u0000${WS.versionId}`
    // White-box: the deferral the ModelMeta pass ends (`deferUntilMetaState`).
    holdAck = true
    tunable().overlaysAwaitingMeta.set(workspace, new Map([[id, Date.now()]]))
    tunable().retriggerOverlaysAwaitingMeta(workspace)
    try {
      await gate.reached.promise
      expect(ownersAtAck.filter((owner) => owner.startsWith('static-recovery:')), `under the recovery lease (${JSON.stringify(ownersAtAck)})`).toHaveLength(1)
      expect(await residency.evict(id), 'an idle eviction during it is refused').toBe(false)
    } finally {
      gate.release.resolve()
    }
    await until('settled', () => tunable().inFlightRuns.size === 0)
    // A DEAD listened handle: dropped from the Repo with no announcement.
    const before = acks
    await repo.removeFromCache(diagram.documentId)
    expect(tunable().listened.get(id)?.handle, 'control: still listened (no announcement)').toBe(diagram)
    tunable().overlaysAwaitingMeta.set(workspace, new Map([[id, Date.now()]]))
    tunable().retriggerOverlaysAwaitingMeta(workspace)
    await sleep(800)
    expect(acks, 'no pass ran on the dead handle').toBe(before)
    expect(tunable().zeroCertificateSweepSnapshot().withdrawn, 'and none was withdrawn').toBe(0)
  }, 60_000)

  // ------------------------------------------------------------------ T-ZEROWM-4

  /** A registered diagram saved once, certified by its first pass (boot), its
   * pass settled — on a projector with no reload tick of its own (60 s) and,
   * with `scanMs`, no 4 Hz scan either: the ticks are driven by hand. */
  async function certifiedDiagram(pool: Pool, options: { entityId?: string; scanMs?: number; start?: boolean } = {}) {
    const diagram = repo.create<Record<string, unknown>>()
    const id = String(diagram.documentId)
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: id, kind: 'diagram', entityId: options.entityId ?? 'd1' }])
    diagram.change((doc) => { doc.id = options.entityId ?? 'd1'; doc.name = 'first'; doc.objectIds = []; doc.connectionIds = [] })
    await repo.flush([diagram.documentId])
    if (options.start !== false) {
      projector = new StaticDeltaProjector(repo, pool, options.scanMs ?? 250, 60_000, () => true, undefined, residency, undefined, undefined, 50, 100)
      await projector.start()
    }
    return { id, diagram }
  }
  const sourceRevisionRead = (sql: string, values: unknown[] | undefined, documentId: string) =>
    sql.includes('SELECT revision FROM read_model_static_document_queue') && Array.isArray(values) && values[2] === documentId
  /** The pass's durable read (`prepareDocumentWatermarkProofs`): AFTER its
   * source-revision read, BEFORE its stamp. */
  const durableRead = (sql: string, values: unknown[] | undefined, documentId: string) =>
    sql.includes('FROM unnest($1::text[]) AS documents(document_id)') && Array.isArray(values)
    && Array.isArray(values[0]) && (values[0] as unknown[]).includes(documentId)

  it('T-ZEROWM-4: the recovery re-reads the backoff before it triggers — a withdrawal committed after its SELECT, before its turn, is not re-run past its backoff', async () => {
    // The tick's SELECT reads X and Y owed. While the loop resolves X (held),
    // a pass of Y that is NOT the recovery's — a change event's — is withdrawn
    // and commits its re-opening with a 60 s backoff. Measured before the fix: the
    // loop then reached Y and re-ran it at once, inside that backoff (the
    // backoff was only applied to the SELECT).
    let holdYAck = false
    const yAck = { reached: deferred(), release: deferred() }
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (holdYAck && isAck(sql, values, yId)) {
        holdYAck = false
        yAck.reached.resolve()
        await yAck.release.promise
      }
      return proceed()
    })
    let yId = ''
    const x = await certifiedDiagram(pool, { entityId: 'x1', start: false })
    const y = await certifiedDiagram(pool, { entityId: 'y1' })
    yId = y.id
    const tuned = tunable()
    tuned.withdrawnReopenLimit = 0; tuned.withdrawnFirstBackoffMs = 60_000; tuned.recoveryBackoffCapMs = 60_000
    const starts: Array<{ at: number; documentId: string }> = []
    observeTicksAndPasses(tuned, [], starts)
    await until('control: both certified by the boot', async () => await certifiedExactly(x.id) && await certifiedExactly(y.id))
    await until('control: settled', () => tuned.inFlightRuns.size === 0)
    // X owed, not resident (FIRST in the queue's order); Y's change-event pass held at its acknowledgement.
    await residency.evict(x.id)
    await residency.drain()
    await writeElsewhere(x.diagram.url, 'second')
    holdYAck = true
    y.diagram.change((doc) => { doc.name = 'second' })
    await repo.flush([y.diagram.documentId])
    await yAck.reached.promise
    // The tick, by hand: its SELECT reads X and Y owed; X's resolve is held.
    const xFind = { reached: deferred(), release: deferred() }
    const plain = repo.find.bind(repo)
    repo.find = (async (...args: Parameters<Repo['find']>) => {
      const handle = await plain(...args)
      if (String(handle.documentId) === x.id) { xFind.reached.resolve(); await xFind.release.promise }
      return handle
    }) as Repo['find']
    let tick: Promise<void> | undefined
    try {
      tick = tuned.recoverChangedDocuments()
      await xFind.reached.promise
      // Y's pass withdrawn (an eviction no lease refuses), its re-opening and backoff committed.
      await forcedEviction(y.id)
      yAck.release.resolve()
      await until('control: Y\'s withdrawal committed, backing off', () => (tuned.withdrawnReopens.get(y.id)?.nextAt ?? 0) > Date.now() + 30_000)
      await until('control: Y\'s pass settled', () => tuned.inFlightRuns.size === 0)
    } finally {
      yAck.release.resolve()
      xFind.release.resolve()
    }
    const withdrawnAt = Date.now()
    await tick
    repo.find = plain as Repo['find']
    await until('control: X\'s recovery pass settled', () => tuned.inFlightRuns.size === 0)
    await sleep(300)
    // Measured before the fix: one pass of Y, started by this very tick.
    expect(starts.filter((start) => start.documentId === y.id && start.at >= withdrawnAt).map((start) => start.at - withdrawnAt), 'no pass of Y inside its backoff').toEqual([])
    expect(starts.some((start) => start.documentId === x.id), 'control: X was recovered by the tick').toBe(true)
    expect(await zeroWrites(y.id)).toBe(0)
  }, 60_000)

  it('T-ZEROWM-4: a row the tick\'s SELECT read owed and that a pass acknowledged since is not re-run (no redundant pass)', async () => {
    // The tick's SELECT reads X and Y owed; while the loop resolves X (held),
    // Y's change-event pass — held at its acknowledgement — commits. Measured
    // before the fix (and behind the owed-ModelMeta case above, 1 run in 60
    // under load): the loop then resolved Y and ran a SECOND pass of the revision
    // just acknowledged (which publishes nothing).
    let holdYAck = false
    const yAck = { reached: deferred(), release: deferred() }
    let yId = ''
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (holdYAck && isAck(sql, values, yId)) {
        holdYAck = false
        yAck.reached.resolve()
        await yAck.release.promise
      }
      return proceed()
    })
    const x = await certifiedDiagram(pool, { entityId: 'x1', start: false })
    const y = await certifiedDiagram(pool, { entityId: 'y1', scanMs: 60_000 })
    yId = y.id
    const tuned = tunable()
    const starts: Array<{ at: number; documentId: string }> = []
    observeTicksAndPasses(tuned, [], starts)
    await until('control: both certified by the boot', async () => await certifiedExactly(x.id) && await certifiedExactly(y.id))
    await until('control: settled', () => tuned.inFlightRuns.size === 0)
    await residency.evict(x.id)
    await residency.drain()
    await writeElsewhere(x.diagram.url, 'second')
    holdYAck = true
    y.diagram.change((doc) => { doc.name = 'second' })
    await repo.flush([y.diagram.documentId])
    await yAck.reached.promise
    const xFind = { reached: deferred(), release: deferred() }
    const plain = repo.find.bind(repo)
    repo.find = (async (...args: Parameters<Repo['find']>) => {
      const handle = await plain(...args)
      if (String(handle.documentId) === x.id) { xFind.reached.resolve(); await xFind.release.promise }
      return handle
    }) as Repo['find']
    let tick: Promise<void> | undefined
    try {
      tick = tuned.recoverChangedDocuments()
      await xFind.reached.promise
      yAck.release.resolve()
      await until('control: Y\'s pass certified it', () => certifiedExactly(y.id))
      await until('control: Y\'s pass settled', () => tuned.inFlightRuns.size === 0)
    } finally {
      yAck.release.resolve()
      xFind.release.resolve()
    }
    const ackedAt = Date.now()
    await tick
    repo.find = plain as Repo['find']
    await until('control: X recovered and settled', async () => await certifiedExactly(x.id) && tuned.inFlightRuns.size === 0)
    expect(starts.filter((start) => start.documentId === y.id && start.at >= ackedAt).map((start) => start.at - ackedAt), 'no redundant pass of Y').toEqual([])
  }, 60_000)

  it('T-ZEROWM-4 (after the resolve): a withdrawal committed DURING the recovery\'s resolve (a retried find) is not re-run past its backoff either', async () => {
    // Lenses: the read before the resolve is not enough. The recovery's find
    // of Y loads H0; a change-event pass of Y on H0 is evicted and commits its
    // withdrawal (a 60 s backoff); the find then returns a fresh handle, as a
    // retry of `resolveHandleWithRetry` would. No run and no watch are left.
    // Measured before the fix (one read, before the resolve): the recovery
    // re-ran Y at once, inside the backoff.
    let holdAck = false
    const ack = { reached: deferred(), release: deferred() }
    let id = ''
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (holdAck && isAck(sql, values, id)) {
        holdAck = false
        ack.reached.resolve()
        await ack.release.promise
      }
      return proceed()
    })
    const made = await certifiedDiagram(pool, { scanMs: 60_000 })
    id = made.id
    const tuned = tunable()
    tuned.withdrawnReopenLimit = 0; tuned.withdrawnFirstBackoffMs = 60_000; tuned.recoveryBackoffCapMs = 60_000
    const starts: Array<{ at: number; documentId: string }> = []
    observeTicksAndPasses(tuned, [], starts)
    await until('control: certified by the boot', () => certifiedExactly(id))
    await until('control: settled', () => tuned.inFlightRuns.size === 0)
    await residency.evict(id)
    await residency.drain()
    await writeElsewhere(made.diagram.url, 'second')
    const plain = repo.find.bind(repo)
    let withdrawnAt = 0
    let returned: DocHandle<unknown> | undefined
    let loaded: DocHandle<unknown> | undefined
    repo.find = (async (...args: Parameters<Repo['find']>) => {
      const first = await plain(...args)
      if (loaded || String(first.documentId) !== id) return first
      loaded = first as DocHandle<unknown>
      // The handle the find loaded, listened; a change on it starts Y's pass.
      tuned.scanResidentHandles()
      holdAck = true
      ;(first as DocHandle<Record<string, unknown>>).change((doc) => { doc.name = 'third' })
      await repo.flush([first.documentId])
      await ack.reached.promise
      await forcedEviction(id)
      ack.release.resolve()
      await until('control: the withdrawal committed, backing off', () => (tuned.withdrawnReopens.get(id)?.nextAt ?? 0) > Date.now() + 30_000)
      await until('control: that pass settled', () => tuned.inFlightRuns.size === 0)
      withdrawnAt = Date.now()
      // …and the find "retried": a fresh handle.
      returned = await plain(...args) as DocHandle<unknown>
      return returned as Awaited<ReturnType<Repo['find']>>
    }) as Repo['find']
    try {
      await tuned.recoverChangedDocuments()
    } finally {
      ack.release.resolve()
      repo.find = plain as Repo['find']
    }
    expect(returned, 'control: the find returned a fresh handle').toBeDefined()
    expect(returned === loaded, 'control: not the evicted one').toBe(false)
    // The tick returned: any pass it started has started.
    expect(starts.filter((start) => start.documentId === id && start.at >= withdrawnAt).map((start) => start.at - withdrawnAt), 'no pass of Y inside its backoff').toEqual([])
    expect(await zeroWrites(id)).toBe(0)
  }, 60_000)

  it('T-ZEROWM-4 (a listener swapped under the same entry): a re-requested pass re-runs on the handle listened NOW, not on its own dead one', async () => {
    // P1 runs on H1 (held); a change re-requests it; H1 is
    // dropped from the Repo with no announcement (no `detach`: the `docRuns`
    // entry stays), H2 is loaded and attached — the scan swaps the listener —
    // and a change on H2 moves the durable document on. Measured before the
    // fix: P1's `finally` re-ran the document on H1 — stale — and
    // acknowledged the queue with a refusal 0 for good.
    let hold = false
    const p1 = { reached: deferred(), release: deferred() }
    let id = ''
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (hold && durableRead(sql, values, id)) {
        hold = false
        p1.reached.resolve()
        await p1.release.promise
      }
      return proceed()
    })
    const made = await certifiedDiagram(pool, { scanMs: 60_000 })
    id = made.id
    const tuned = tunable()
    const handles: Array<{ at: number; handle: DocHandle<unknown> }> = []
    const observed = tuned as unknown as { project(descriptor: { documentId: string }, handle: DocHandle<unknown>): Promise<void> }
    const project = observed.project.bind(tuned)
    observed.project = (descriptor, handle) => {
      if (descriptor.documentId === id) handles.push({ at: Date.now(), handle })
      return project(descriptor, handle)
    }
    await until('control: certified by the boot', () => certifiedExactly(id))
    await until('control: settled', () => tuned.inFlightRuns.size === 0)
    let fresh: DocHandle<Record<string, unknown>> | undefined
    try {
      hold = true
      made.diagram.change((doc) => { doc.name = 'second' })
      await repo.flush([made.diagram.documentId])
      await p1.reached.promise
      made.diagram.change((doc) => { doc.name = 'third' })
      await repo.flush([made.diagram.documentId])
      await repo.removeFromCache(made.diagram.documentId)
      fresh = await repo.find<Record<string, unknown>>(made.diagram.url)
      tuned.scanResidentHandles()
      expect(tuned.listened.get(id)?.handle, 'control: the listener swapped to the new handle').toBe(fresh)
      expect((tuned as unknown as { docRuns: Map<string, { pending: boolean }> }).docRuns.get(id)?.pending, 'control: P1 re-requested, its entry kept').toBe(true)
      fresh.change((doc) => { doc.name = 'fourth' })
      await repo.flush([fresh.documentId])
    } finally {
      p1.release.resolve()
    }
    await until('every pass settled', () => tuned.inFlightRuns.size === 0)
    // handles[0]: P1 (the boot pass started before the wrapper).
    expect.soft(handles.slice(1).map((entry) => entry.handle === fresh), 'the re-run is on the listened handle').toEqual([true])
    const { rows } = await database.pool.query<{ name: string }>(
      `SELECT data->>'name' AS name FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = 'd1'`, [WS.landscapeId, WS.versionId])
    expect.soft(rows[0]?.name, 'the newest content projected').toBe('fourth')
    expect(await certifiedExactly(id), `certified at the newest arrival (${JSON.stringify(await certificate(id))}, queue ${JSON.stringify(await queueRow(id))})`).toBe(true)
  }, 60_000)

  it('T-ZEROWM-4: stop() during a zombie — held INSIDE its transaction, a pass queued behind it — returns within its drain ceiling, and the queued pass starts nothing after it', async () => {
    // The shutdown's bound (serverShutdown.ts): a forced exit at 30 s, and the
    // static projector's stop step must return well before it so the rest of
    // the sequence (late-write flush, ownership release, pools) still runs.
    // The zombie: the recovery pass of a diagram, evicted, held at its
    // acknowledgement — a pooled client with an OPEN transaction, for good.
    // Behind it, a change-event pass of the same document on a reloaded handle
    // waits (`project`). The default ceiling (10 s), as in production.
    const recovery = await heldRecovery('hold', 60_000)
    const tuned = tunable()
    const stopping = projector!
    const reads: number[] = []
    try {
      await forcedEviction(recovery.id)
      const fresh = await repo.find<Record<string, unknown>>(`automerge:${recovery.id}` as DocHandle<unknown>['url'])
      tuned.scanResidentHandles()
      const watches = () => [...((tuned as unknown as { passWithdrawals: Map<string, Set<{ waiting?: boolean }>> }).passWithdrawals.get(recovery.id) ?? [])]
      fresh.change((doc) => { doc.name = 'third' })
      await repo.flush([fresh.documentId])
      await until('control: a pass waits behind the zombie', () => watches().some((watch) => watch.waiting === true))
      // From here, every source-revision read of the document (the queued pass's first).
      const observed = tuned as unknown as { sourceRevision(d: { documentId: string }): Promise<number> }
      const sourceRevision = observed.sourceRevision.bind(tuned)
      observed.sourceRevision = (d) => { if (d.documentId === recovery.id) reads.push(Date.now()); return sourceRevision(d) }
      expect(tuned.stopDrainCeilingMs, 'control: the production ceiling').toBe(10_000)
      const startedAt = Date.now()
      await stopping.stop()
      projector = undefined
      const took = Date.now() - startedAt
      // Past its ceiling (the zombie never drains), then the leases, the
      // detach marks: nothing waits for the zombie's transaction.
      expect(took, `stop() returned in ${took} ms`).toBeGreaterThanOrEqual(10_000)
      expect(took, `stop() returned in ${took} ms, far below the 30 s forced exit`).toBeLessThan(13_000)
    } finally {
      recovery.release()
    }
    // The zombie ends after the stop; the pass queued behind it then wakes —
    // and, its projector stopped past its drain, starts nothing.
    await until('the zombie and the queued pass settled', () => tuned.inFlightRuns.size === 0, 20_000)
    // Measured before the fix: the queued pass read its revision after the stop.
    expect(reads, 'no read by the queued pass after stop()').toEqual([])
    expect(await zeroWrites(recovery.id)).toBe(0)
  }, 90_000)

  it('T-ZEROWM-4: an evicted pass that never ends — its watch past the ceiling is logged and counted ONCE; the recovery still waits for it', async () => {
    const lines: string[] = []
    const realWarn = console.warn.bind(console)
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); realWarn(...args) })
    const hold = { reached: deferred(), release: deferred() }
    let armed = true
    const starts: Array<{ at: number; documentId: string }> = []
    const ticks: number[] = []
    // Possibly absent: this case was measured RED on a build without this metric.
    const samples = () => (staticPassWatchMetricSamples as typeof staticPassWatchMetricSamples | undefined)?.() ?? []
    const counter = () => samples()[0]?.values[0]?.value ?? 0
    const gauge = () => samples()[1]?.values[0]?.value ?? 0
    const counterBefore = counter()
    try {
      const { id } = await owedDiagram({
        reloadMs: 100,
        // The check every 50 ms from the start; the 300 ms ceiling only once
        // the zombie is held (below) — under load the BOOT pass itself took
        // more than 300 ms and was rightly logged too (1 run in 30).
        tune: (tuned) => { tuned.passWatchCheckMs = 50; observeTicksAndPasses(tuned, ticks, starts) },
        hook: async (sql, values, documentId) => {
          // The recovery pass, evicted at its source-revision read and held: a zombie.
          if (!armed || !sourceRevisionRead(sql, values, documentId)) return
          armed = false
          await forcedEviction(documentId)
          hold.reached.resolve()
          await hold.release.promise
        },
      })
      try {
        await hold.reached.promise
        tunable().passWatchCeilingMs = 300
        const heldAt = Date.now()
        await until('control: ticks well past the ceiling', () => ticks.filter((at) => at > heldAt + 600).length >= 5, 10_000)
        const overdue = lines.filter((line) => line.includes('read_model.static_pass_watch_overdue') && line.includes(id))
        // Measured before the fix: no line, no count.
        expect(overdue, 'logged once').toHaveLength(1)
        const logged = JSON.parse(overdue[0]!) as { ageMs: number; ceilingMs: number; withdrawn: boolean }
        expect(logged.ceilingMs).toBe(300)
        expect(logged.ageMs).toBeGreaterThanOrEqual(300)
        expect(logged.withdrawn, 'the zombie is the evicted pass').toBe(true)
        expect(tunable().zeroCertificateSweepSnapshot().overdueWatches, 'counted once').toBe(1)
        expect(counter() - counterBefore, 'the process counter (`/metrics`)').toBe(1)
        expect(gauge(), 'the gauge: one pass in flight past its ceiling').toBe(1)
        expect(starts.filter((start) => start.documentId === id && start.at > heldAt), 'the recovery still waits: no second pass').toEqual([])
      } finally {
        hold.release.resolve()
      }
      await until('the gauge falls back once the zombie ended', () => gauge() === 0)
      await until('the zombie ended, withdrawn', () => tunable().zeroCertificateSweepSnapshot().withdrawn === 1)
      await until('then the recovery certifies it', () => certifiedExactly(id))
      expect(await zeroWrites(id)).toBe(0)
    } finally {
      warn.mockRestore()
    }
  }, 60_000)

  it('T-ZEROWM-4: `trigger`\'s `finally` does not re-run a pass on the DEAD handle of a detached entry — the document is left owed and the recovery certifies it on a live handle', async () => {
    // P1 runs on H1 and is held; a change re-requests it (`pending`); H1 is
    // evicted (`detach`) and another writer moves the durable document on.
    // Measured before the fix: P1's `finally` re-ran the document on H1 — its
    // stale in-memory document — which acknowledged the queue at the durable
    // revision with a refusal 0 (sample unlike the durable heads): stale,
    // refused, and owed by nothing.
    let hold = false
    const p1 = { reached: deferred(), release: deferred() }
    let id = ''
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      // P1 held at its durable read: after its source-revision read, so it
      // acknowledges only the revision it sampled.
      if (hold && durableRead(sql, values, id)) {
        hold = false
        p1.reached.resolve()
        await p1.release.promise
      }
      return proceed()
    })
    const made = await certifiedDiagram(pool, { scanMs: 60_000 })
    id = made.id
    const tuned = tunable()
    const starts: Array<{ at: number; documentId: string }> = []
    observeTicksAndPasses(tuned, [], starts)
    await until('control: certified by the boot', () => certifiedExactly(id))
    await until('control: settled', () => tuned.inFlightRuns.size === 0)
    try {
      hold = true
      made.diagram.change((doc) => { doc.name = 'second' })
      await repo.flush([made.diagram.documentId])
      await p1.reached.promise
      made.diagram.change((doc) => { doc.name = 'third' })
      await repo.flush([made.diagram.documentId])
      const internal = tuned as unknown as { docRuns: Map<string, { pending: boolean }> }
      expect(internal.docRuns.get(id)?.pending, 'control: P1 re-requested').toBe(true)
      await forcedEviction(id)
      await writeElsewhere(made.diagram.url, 'fourth')
    } finally {
      p1.release.resolve()
    }
    const released = Date.now()
    await until('P1 settled', () => tuned.inFlightRuns.size === 0)
    await sleep(200)
    // Measured before the fix: one — the re-run on the dead handle.
    expect.soft(starts.filter((start) => start.documentId === id && start.at >= released).length, 'no re-run of the detached entry').toBe(0)
    const owed = await queueRow(id)
    expect.soft(Number(owed?.revision), `left owed (${JSON.stringify(owed)}, certificate ${JSON.stringify(await certificate(id))})`).toBeGreaterThan(Number(owed?.projected))
    // The tick, by hand: a live handle, the durable content, certified.
    await tuned.recoverChangedDocuments()
    await until('the recovery certifies the newest arrival', () => certifiedExactly(id))
    const { rows } = await database.pool.query<{ name: string }>(
      `SELECT data->>'name' AS name FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = 'd1'`, [WS.landscapeId, WS.versionId])
    expect(rows[0]?.name, 'the durable content projected').toBe('fourth')
  }, 60_000)

  it('T-ZEROWM-4: behind a zombie, a waiting pass evicted meanwhile is superseded by the next one — at most one waits on a live handle — and the last one certifies once the zombie ends', async () => {
    // A: a change event's pass, held after its source-revision read, evicted
    // there (the zombie). B: a pass on a reloaded handle, waiting behind A —
    // then evicted too. C: a pass on a third handle. Measured before the fix: B
    // kept waiting with its dead handle (one more per eviction/reload cycle).
    let holdA = false
    const aHeld = { reached: deferred(), release: deferred() }
    let id = ''
    const reads: Array<{ at: number }> = []
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (id && sourceRevisionRead(sql, values, id)) reads.push({ at: Date.now() })
      if (holdA && durableRead(sql, values, id)) {
        holdA = false
        aHeld.reached.resolve()
        await aHeld.release.promise
      }
      return proceed()
    })
    const made = await certifiedDiagram(pool, { scanMs: 60_000 })
    id = made.id
    const tuned = tunable()
    const watches = () => [...((tuned as unknown as { passWithdrawals: Map<string, Set<{ waiting?: boolean; withdrawn: boolean }>> }).passWithdrawals.get(id) ?? [])]
    const reload = async (name: string) => {
      const fresh = await repo.find<Record<string, unknown>>(made.diagram.url)
      tuned.scanResidentHandles()
      fresh.change((doc) => { doc.name = name })
      await repo.flush([fresh.documentId])
      return fresh
    }
    try {
      await until('control: certified by the boot', () => certifiedExactly(id))
      await until('control: settled', () => tuned.inFlightRuns.size === 0)
      holdA = true
      made.diagram.change((doc) => { doc.name = 'second' })
      await repo.flush([made.diagram.documentId])
      await aHeld.reached.promise
      await forcedEviction(id)
      await reload('third')
      await until('control: B waits behind A', () => watches().some((watch) => watch.waiting === true))
      const readsBefore = reads.length
      await forcedEviction(id)
      expect(watches().some((watch) => watch.waiting === true && watch.withdrawn), 'control: B evicted while it waits').toBe(true)
      await reload('fourth')
      // Measured before the fix: three watches — A, B (dead), C.
      await until('B superseded: A and C left', () => watches().length === 2, 5_000)
      expect(watches().filter((watch) => watch.waiting === true).length, 'one pass waiting, on the live handle').toBe(1)
      expect(reads.length - readsBefore, 'B read nothing').toBe(0)
    } finally {
      aHeld.release.resolve()
    }
    await until('every pass settled', () => tuned.inFlightRuns.size === 0)
    const { rows } = await database.pool.query<{ name: string }>(
      `SELECT data->>'name' AS name FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = 'd1'`, [WS.landscapeId, WS.versionId])
    expect(rows[0]?.name, 'the newest content projected').toBe('fourth')
    expect(await certifiedExactly(id), 'certified at the newest arrival').toBe(true)
  }, 60_000)

  it('T-ZEROWM-4: stop() while a SLOW pass (4 s) runs with a pass queued behind it — both drained inside the ceiling', async () => {
    // The serialization makes a queued pass's drain time add to the slow
    // one's. Measured here: what `stop()` takes, against its 10 s ceiling.
    let holdA = false
    let id = ''
    let aHeldAt = 0
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (holdA && durableRead(sql, values, id)) {
        holdA = false
        aHeldAt = Date.now()
        await sleep(4_000)
      }
      return proceed()
    })
    const made = await certifiedDiagram(pool, { scanMs: 60_000 })
    id = made.id
    const tuned = tunable()
    await until('control: certified by the boot', () => certifiedExactly(id))
    await until('control: settled', () => tuned.inFlightRuns.size === 0)
    holdA = true
    made.diagram.change((doc) => { doc.name = 'second' })
    await repo.flush([made.diagram.documentId])
    await until('control: A is slow', () => aHeldAt > 0)
    await forcedEviction(id)
    const fresh = await repo.find<Record<string, unknown>>(made.diagram.url)
    tuned.scanResidentHandles()
    fresh.change((doc) => { doc.name = 'third' })
    await repo.flush([fresh.documentId])
    const watches = () => [...((tuned as unknown as { passWithdrawals: Map<string, Set<{ waiting?: boolean }>> }).passWithdrawals.get(id) ?? [])]
    await until('control: B queued behind A', () => watches().some((watch) => watch.waiting === true))
    const observed = tuned as unknown as { sourceRevision(d: { documentId: string }): Promise<number> }
    const sourceRevision = observed.sourceRevision.bind(tuned)
    const reads: number[] = []
    observed.sourceRevision = (d) => { if (d.documentId === id) reads.push(Date.now()); return sourceRevision(d) }
    const stopping = projector!
    const startedAt = Date.now()
    await stopping.stop()
    projector = undefined
    const took = Date.now() - startedAt
    // The measurement, on stderr (vitest keeps the console of a passing case to itself).
    process.stderr.write(`${JSON.stringify({ event: 'measure.stop_with_slow_pass', tookMs: took, slowPassLeftMs: 4_000 - (startedAt - aHeldAt) })}\n`)
    expect(took, `stop() took ${took} ms: A's remainder, inside the ceiling`).toBeLessThan(tuned.stopDrainCeilingMs)
    expect(tuned.inFlightRuns.size, 'both drained').toBe(0)
    // B, queued when `stop()` began, woke during its drain and started
    // nothing — not one query; the queue says it is owed.
    expect(reads, 'B read nothing once stop() began').toEqual([])
    const row = await queueRow(id)
    expect(Number(row?.revision), `left owed for the next owner (${JSON.stringify(row)})`).toBeGreaterThan(Number(row?.projected))
  }, 60_000)

  it('T-ZEROWM-4: release(workspace) while a pass waits behind another — once it wakes it starts nothing, not one query', async () => {
    let holdA = false
    let id = ''
    const aHeld = { reached: deferred(), release: deferred() }
    const queries: string[] = []
    let watching = false
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      // A read its revision before its hold: a revision read from here is B's.
      if (watching && sourceRevisionRead(sql, values, id)) queries.push(sql.replace(/\s+/g, ' ').slice(0, 80))
      if (holdA && durableRead(sql, values, id)) {
        holdA = false
        aHeld.reached.resolve()
        await aHeld.release.promise
      }
      return proceed()
    })
    const made = await certifiedDiagram(pool, { scanMs: 60_000 })
    id = made.id
    const tuned = tunable()
    await until('control: certified by the boot', () => certifiedExactly(id))
    await until('control: settled', () => tuned.inFlightRuns.size === 0)
    const watches = () => [...((tuned as unknown as { passWithdrawals: Map<string, Set<{ waiting?: boolean }>> }).passWithdrawals.get(id) ?? [])]
    try {
      holdA = true
      made.diagram.change((doc) => { doc.name = 'second' })
      await repo.flush([made.diagram.documentId])
      await aHeld.reached.promise
      await forcedEviction(id)
      const fresh = await repo.find<Record<string, unknown>>(made.diagram.url)
      tuned.scanResidentHandles()
      fresh.change((doc) => { doc.name = 'third' })
      await repo.flush([fresh.documentId])
      await until('control: B waits behind A', () => watches().some((watch) => watch.waiting === true))
      projector!.release(WS, 'test: ownership lost')
      watching = true
    } finally {
      aHeld.release.resolve()
    }
    // A, already past its revision read, finishes (refused or not by the
    // released workspace — not judged here); B wakes after it.
    await until('every pass settled', () => tuned.inFlightRuns.size === 0, 15_000)
    // Measured before the fix: B ran — its plane check, then its revision read.
    expect(queries, 'B read nothing once the workspace was released').toEqual([])
  }, 60_000)

  it('T-ZEROWM-4: a re-request the `finally` refuses (its handle dropped, no live one listened yet) is CLEARED — the document is not left busy for good, and the recovery certifies it', async () => {
    // P1 runs on H1 (held); a change re-requests it; H1 is dropped from the
    // Repo with no announcement (no `detach`: the entry stays) and P1 ends
    // BEFORE anything attaches a live handle (no scan here). Measured before
    // the fix: `pending` stayed true with nothing running — `passBusy` true
    // for good, so every recovery tick skipped the document.
    let hold = false
    const p1 = { reached: deferred(), release: deferred() }
    let id = ''
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (hold && durableRead(sql, values, id)) {
        hold = false
        p1.reached.resolve()
        await p1.release.promise
      }
      return proceed()
    })
    const made = await certifiedDiagram(pool, { scanMs: 60_000 })
    id = made.id
    const tuned = tunable()
    await until('control: certified by the boot', () => certifiedExactly(id))
    await until('control: settled', () => tuned.inFlightRuns.size === 0)
    const internal = tuned as unknown as { docRuns: Map<string, { running: boolean; pending: boolean; timer?: unknown }>; passBusy(id: string): boolean }
    try {
      hold = true
      made.diagram.change((doc) => { doc.name = 'second' })
      await repo.flush([made.diagram.documentId])
      await p1.reached.promise
      made.diagram.change((doc) => { doc.name = 'third' })
      await repo.flush([made.diagram.documentId])
      expect(internal.docRuns.get(id)?.pending, 'control: P1 re-requested').toBe(true)
      await repo.removeFromCache(made.diagram.documentId)
    } finally {
      p1.release.resolve()
    }
    await until('P1 settled', () => tuned.inFlightRuns.size === 0)
    expect(internal.docRuns.get(id)?.running, 'control: nothing runs').toBe(false)
    expect(internal.passBusy(id), 'not busy for good').toBe(false)
    // The tick, by hand: the recovery resolves a live handle and certifies.
    await tuned.recoverChangedDocuments()
    await until('the recovery certifies the newest arrival', () => certifiedExactly(id))
    await until('settled', () => tuned.inFlightRuns.size === 0)
    expect(recoveryOwners(id), 'no lease left behind').toEqual([])
  }, 60_000)

  it('T-ZEROWM-4: `trigger` on a DEAD handle starts nothing — not even from inside the recovery\'s resolve — and the recovery certifies on the live one', async () => {
    // Every caller that hands `trigger` a handle held from before an await —
    // a pass asking itself to run again, a write head's registration, a commit
    // hook, a deferral, a dropped handle's listener — may hand it a dead one.
    // `trigger` is called here with the evicted handle while the recovery's
    // resolve is in flight. Measured before the fix: a pass started on it
    // (the recovery sometimes even leased it), sampled its stale
    // document, and acknowledged the queue with a refusal 0 for good.
    let returned: unknown = 'not called'
    let entryAfter: unknown = 'not read'
    const plain = repo.find.bind(repo)
    const finding = repo as unknown as { find: (...args: unknown[]) => Promise<DocHandle<unknown>> }
    let deadTried = false
    const passHandles: Array<DocHandle<unknown>> = []
    let deadHandle: DocHandle<unknown> | undefined
    try {
      const { id } = await owedDiagram({
        reloadMs: 300,
        beforeOwed: (owedId, evicted) => {
          deadHandle = evicted
          const tuned = tunable()
          const observed = tuned as unknown as { project(descriptor: { documentId: string }, handle: DocHandle<unknown>): Promise<void> }
          const project = observed.project.bind(tuned)
          observed.project = (descriptor, handle) => { if (descriptor.documentId === owedId) passHandles.push(handle); return project(descriptor, handle) }
          finding.find = async (...args: unknown[]) => {
            const handle = await (plain as (...args: unknown[]) => Promise<DocHandle<unknown>>)(...args)
            if (!deadTried && String(handle.documentId) === owedId && handle !== evicted) {
              deadTried = true
              returned = tuned.trigger(tuned.descriptors.get(owedId), evicted, true)
              entryAfter = (tuned as unknown as { docRuns: Map<string, unknown> }).docRuns.get(owedId)
            }
            return handle
          }
        },
      })
      await until('the recovery certifies the newest arrival', () => certifiedExactly(id))
      expect(deadTried, 'control: tried from inside the resolve').toBe(true)
      expect(returned, 'no pass started on the dead handle').toBeUndefined()
      expect(entryAfter, 'and no entry made for it').toBeUndefined()
      expect(passHandles.filter((handle) => handle === deadHandle), 'no pass of the dead handle at all').toEqual([])
      await until('settled', () => tunable().inFlightRuns.size === 0)
      expect(recoveryOwners(id), 'its lease went').toEqual([])
      expect(await zeroWrites(id)).toBe(0)
    } finally {
      finding.find = plain as unknown as (...args: unknown[]) => Promise<DocHandle<unknown>>
    }
  }, 60_000)

  it('T-ZEROWM-4: the recovery\'s OWN `attach` starts the pass of the ModelMeta it loads (no scan running): that pass is leased by the recovery and runs ONCE', async () => {
    // Kills the mutant "the check after `attach` removed" (it survived the
    // owed-ModelMeta case above, where the 4 Hz scan may attach first). No scan
    // here, no tick: the recovery is run by hand on a ModelMeta that is owed,
    // not resident and not listened — so `attach` is the one that starts it.
    const meta = repo.create<Record<string, unknown>>()
    const id = String(meta.documentId)
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: id, kind: 'model-meta' }])
    meta.change((doc) => { doc.deletedDiagramIds = []; doc.groups = {} })
    await repo.flush([meta.documentId])
    let hold = false
    const held = { reached: deferred(), release: deferred() }
    const ownersAtHold: string[] = []
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (hold && sourceRevisionRead(sql, values, id)) {
        hold = false
        ownersAtHold.push(...leaseOwners(id))
        held.reached.resolve()
        await held.release.promise
      }
      return proceed()
    })
    projector = new StaticDeltaProjector(repo, pool, 60_000, 60_000, () => true, undefined, residency, undefined, undefined, 50, 100)
    const starts: Array<{ at: number; documentId: string }> = []
    observeTicksAndPasses(tunable(), [], starts)
    await projector.start()
    await until('control: the boot passes settled', () => tunable().inFlightRuns.size === 0)
    await forcedEviction(id)
    expect(tunable().listened.has(id), 'control: not listened').toBe(false)
    await writeElsewhere(meta.url, 'owed')
    const from = Date.now()
    hold = true
    const tick = tunable().recoverChangedDocuments()
    try {
      await held.reached.promise
      expect(ownersAtHold.filter((owner) => owner.startsWith('static-recovery:')), `leased by the recovery (${JSON.stringify(ownersAtHold)})`).toHaveLength(1)
    } finally {
      held.release.resolve()
    }
    await tick
    await until('every pass settled', () => tunable().inFlightRuns.size === 0)
    await sleep(300)
    // Mutant: two — the one `attach` started, then the `pending` re-run.
    expect(starts.filter((start) => start.documentId === id && start.at >= from).length, 'one pass').toBe(1)
    expect(recoveryOwners(id), 'its lease went with it').toEqual([])
  }, 60_000)

  it('T-ZEROWM-4 (overlap): a live pass started beside an evicted pass of the same document waits for it — the document ends with the NEWER rows and certificate, not the evicted pass\'s', async () => {
    // A: a change event's pass, held after its source-revision read (before
    // its stamp), and evicted there — `detach` drops its `docRuns` entry. B: a
    // change event on a reloaded handle, of a newer save, starts a second pass
    // of the document. Measured before the fix: B ran beside A and committed
    // first; A, released, committed AFTER it — its older rows over B's, and a
    // refusal 0 (its sample is no longer the durable heads), on a queue row
    // acknowledged at B's revision: stale, refused, and nothing re-projects it
    // (the sweep reads that 0 as a true hole). (Its first form, with B's
    // acknowledgement held instead, measured the shared `passStamps` slot: B
    // read A's stamp and recorded nothing.)
    let holdA = false
    const aHeld = { reached: deferred(), release: deferred() }
    let id = ''
    const reads: Array<{ at: number }> = []
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (id && sourceRevisionRead(sql, values, id)) reads.push({ at: Date.now() })
      if (holdA && durableRead(sql, values, id)) {
        holdA = false
        aHeld.reached.resolve()
        await aHeld.release.promise
      }
      return proceed()
    })
    const made = await certifiedDiagram(pool)
    id = made.id
    const tuned = tunable()
    const starts: Array<{ at: number; documentId: string }> = []
    observeTicksAndPasses(tuned, [], starts)
    let releasedAt = 0
    try {
      await until('control: certified by the boot', () => certifiedExactly(id))
      await until('control: settled', () => tuned.inFlightRuns.size === 0)
      holdA = true
      made.diagram.change((doc) => { doc.name = 'second' })
      await repo.flush([made.diagram.documentId])
      await aHeld.reached.promise
      await forcedEviction(id)
      const fresh = await repo.find<Record<string, unknown>>(made.diagram.url)
      tuned.scanResidentHandles()
      expect(tuned.listened.get(id)?.handle, 'control: the new handle is listened').toBe(fresh)
      const readsBefore = reads.length
      fresh.change((doc) => { doc.name = 'third' })
      await repo.flush([fresh.documentId])
      await until('control: B started', () => starts.filter((start) => start.documentId === id).length >= 2)
      // A positive witness, not a sleep: B either read its revision (it did
      // not wait) or is seen waiting behind A.
      const watches = () => [...((tuned as unknown as { passWithdrawals: Map<string, Set<{ waiting?: boolean }>> }).passWithdrawals.get(id) ?? [])]
      await until('control: B read without waiting, or waits behind A', () => reads.length > readsBefore || watches().some((watch) => watch.waiting === true))
      // Measured before the fix: B read its revision (and ran to its end) while A was held.
      expect.soft(reads.length - readsBefore, 'B has not read anything while A is in flight').toBe(0)
      // Where B did not wait (the defect), it is let run to its end before A
      // goes on — the order that leaves the document stale; the checks below
      // then say so.
      if (reads.length > readsBefore) await until('B ran to its end beside A', () => tuned.inFlightRuns.size === 1)
      else {
        // B waiting behind A is not a second overdue pass. Both
        // older than a 50 ms ceiling here: the gauge names A alone.
        tuned.passWatchCeilingMs = 50
        await sleep(120)
        expect((tuned as unknown as { passWatchSnapshot(): { overdueWatchesInFlight: number } }).passWatchSnapshot().overdueWatchesInFlight,
          'one pass in flight past its ceiling: A, not B queued behind it').toBe(1)
      }
    } finally {
      releasedAt = Date.now()
      aHeld.release.resolve()
    }
    await until('both passes settled', () => tuned.inFlightRuns.size === 0)
    const { rows } = await database.pool.query<{ name: string }>(
      `SELECT data->>'name' AS name FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = 'd1'`, [WS.landscapeId, WS.versionId])
    expect.soft(rows[0]?.name, 'the rows are the newer pass\'s').toBe('third')
    expect.soft(await certifiedExactly(id), `certified at the newest arrival (${JSON.stringify(await certificate(id))}, newest ${await newestArrival(id)}, queue ${JSON.stringify(await queueRow(id))})`).toBe(true)
    expect(reads.filter((read) => read.at >= releasedAt).length, 'control: B read its revision once A was released').toBeGreaterThanOrEqual(1)
  }, 60_000)
})
