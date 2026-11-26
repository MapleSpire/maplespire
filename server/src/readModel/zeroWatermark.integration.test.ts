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
 * T-ZEROWM (A) — a rotation never evicts the old write head under its own
 * pass, and an orphan refusal 0 is re-projected.
 *
 * Born as the zero-watermark diagnosis's demonstration file, where its third
 * case was a gated RED demonstration on the code before the fix: the owed
 * rotation of a protocol-v1 connection head takes the workspace tail; a pass
 * of the old head queues its acknowledgement behind it; the rotation's
 * activation releases the old head's write-head lease and the residency
 * evicts it; the acknowledgement's `readCurrentHeads` answers null and the
 * certificate is the refusal 0, which nothing ever lifts.
 *
 * Real projector, real Repo on the real `PostgresStorageAdapter`, real
 * `AutomergeResidencyLeases`, real PostgreSQL. ONE pool hook holds the
 * rotation's advisory-lock statement (SQL unchanged; one case also fails one
 * statement), and call-through wrappers only OBSERVE (when the old head's
 * acknowledgement is queued, what its `readCurrentHeads` answered).
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
import { DOCUMENT_ARRIVAL_BRANCH_SQL, getWorkspaceProjectionFreshness, markReadModelProjectorAttached } from './health.js'
import { StaticDeltaProjector, staticRecoveryBackoffMetricSamples } from './staticDeltaProjector.js'

const CONNECTION = process.env.TEST_DATABASE_URL
const WS = { landscapeId: 'ls-zero-watermark', versionId: 'v1' }

type Connection = { id: string; fromId: string; toId: string; label: string }
type ConnectionHead = {
  connections: Record<string, Connection>
  writeHeadVersion: number
  writeBatchIds: string[]
  forwardedBatchIds?: string[]
}
type ObjectHead = { objects: Record<string, { id: string; name: string }>; writeHeadVersion: number; writeBatchIds: string[] }
type PassStamp = { revision: number; sampledHeads: readonly string[] | null; readCurrentHeads: () => readonly string[] | null }
type Sweep = {
  relaunched: number; legitimate: number; backedOff?: number; retiringLeases: number; withdrawn?: number; sweepLeases?: number
  retiringUnderRecovery?: number
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** The pool the projector is handed, with ONE hook on every statement of the
 * pool and of the clients it lends (the shape of
 * `staticDeltaProjector.watermark.integration.test.ts`). */
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

describe.skipIf(!CONNECTION)('T-ZEROWM (A) — the old write head is never evicted under its own pass (real storage, residency, StaticDeltaProjector, PostgreSQL)', () => {
  let database: IsolatedSchemaDb
  let repo: Repo
  let residency: AutomergeResidencyLeases
  let projector: StaticDeltaProjector | undefined

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'zero_watermark')
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
    // `trackStaticReadModel`, as the server sets it under READ_MODEL=on: every
    // content save mints an arrival and enqueues its queue revision.
    repo = new Repo({
      storage: new PostgresStorageAdapter({ db: database.pool, trackStaticReadModel: true }), network: [], saveDebounceRate: 0,
    })
    residency = new AutomergeResidencyLeases(repo)
    await markStaticReadModelWorkspace(database.pool, WS, 'test')
    await markReadModelProjectorAttached(database.pool, WS, null, 'zero-watermark')
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
  /** The durable heads of a document, decoded from every stored chunk. */
  const durableHeads = async (documentId: string) => {
    const { rows } = await database.pool.query<{ data: Buffer }>(
      `SELECT data FROM automerge_storage
        WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) IN ('snapshot', 'incremental')
        ORDER BY arrival_seq NULLS FIRST`,
      [documentId])
    let doc = A.init<unknown>()
    for (const row of rows) doc = A.loadIncremental(doc, new Uint8Array(row.data))
    return A.getHeads(doc)
  }
  const leaseOwners = (documentId: string): string[] => {
    const leases = (residency as unknown as { leases: Map<string, { owners: Map<string, unknown> }> }).leases
    return [...(leases.get(documentId)?.owners.keys() ?? [])]
  }
  /** The Repo's synchronizer of the document: one per residency (an eviction
   * drops it; a later load makes a new one). */
  const residentEntry = (documentId: string): unknown =>
    (repo.synchronizer as unknown as { docSynchronizers: Record<string, unknown> }).docSynchronizers[documentId]
  const resident = (documentId: string) => Boolean(residentEntry(documentId))
  const sweep = (): Sweep => (projector as unknown as { zeroCertificateSweepSnapshot(): Sweep }).zeroCertificateSweepSnapshot()

  /**
   * The workspace of the red dumps, reduced: a ModelMeta, a protocol-v2 object
   * head (no rotation owed) and a protocol-v1 connection head that the
   * projector must rotate. Every document is registered BEFORE its first save,
   * so each save enqueues a queue revision.
   */
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
      doc.objects = { o1: { id: 'o1', name: 'A' }, o2: { id: 'o2', name: 'B' } }
      doc.writeHeadVersion = 2
      doc.writeBatchIds = []
    })
    connectionHead.change((doc) => {
      doc.connections = { c1: { id: 'c1', fromId: 'o1', toId: 'o2', label: 'first' } }
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

  /**
   * The order of the red dumps, forced: the owed rotation takes the tail and is
   * held at its lock; a pass of the old head (its first, or one made by a
   * write carrying no entity — the forward of the dumps) queues its
   * acknowledgement behind it; the rotation is released.
   *
   * `keepOldHeadResident`: a second residency owner on the old head (the
   * control that held before the fix too). `beforeRelease`: what happens
   * while the rotation is still held (a stop, a release). `failAck`: the old
   * head's acknowledgement fails once (a SQL error), to prove no lease leaks.
   */
  async function rotationOvertakesTheOldHeadsPass(options: {
    keepOldHeadResident: boolean
    reloadMs?: number
    ack?: 'fail' | 'hold'
    sweep?: { firstBackoffMs: number; maxAttempts: number; capMs?: number }
  }) {
    const { connectionHead, meta } = await summaryWorkspace()
    const oldHead = connectionHead as DocHandle<unknown>
    const rotationHeld = deferred()
    const releaseRotation = deferred()
    // T-ZEROWM-2: re-armable (`armAck`), the first gate kept for `ackReached`.
    let ackGate = { reached: deferred(), release: deferred() }
    const firstGate = ackGate
    let rotationIsHeld = false
    let holdNextRotation = true
    let ackHook = options.ack
    let racingArmed = false
    /** `times`: when each failed acknowledgement was attempted (T-ZEROWM-3). */
    const failures = { everyAck: false, times: [] as number[] }
    /** T-ZEROWM-4: run once at the old head's NEXT source-revision read (after
     * its sample, before any tail work). */
    let sourceReadHook: (() => Promise<void>) | undefined
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (sourceReadHook && sql.includes('SELECT revision FROM read_model_static_document_queue')
        && Array.isArray(values) && values[2] === oldHead.documentId) {
        const hook = sourceReadHook
        sourceReadHook = undefined
        await hook()
      }
      if (failures.everyAck && sql.includes('UPDATE read_model_static_document_queue')
        && Array.isArray(values) && values[2] === oldHead.documentId) {
        failures.times.push(Date.now())
        throw new Error('injected: every acknowledgement of the old head fails')
      }
      if (holdNextRotation && sql.includes('pg_try_advisory_lock')) {
        holdNextRotation = false
        rotationIsHeld = true
        rotationHeld.resolve()
        await releaseRotation.promise
      }
      if (ackHook && racingArmed && sql.includes('UPDATE read_model_static_document_queue')
        && Array.isArray(values) && values[2] === oldHead.documentId) {
        const hook = ackHook
        ackHook = undefined
        const gate = ackGate
        gate.reached.resolve()
        if (hook === 'fail') throw new Error('injected: the old head\'s acknowledgement fails once')
        await gate.release.promise
      }
      return proceed()
    })
    // OBSERVATION ONLY: every residency owner the projector acquires.
    const acquiredOwners: string[] = []
    const originalAcquire = residency.acquire.bind(residency)
    residency.acquire = (handle, owner, workspace, documentType) => {
      acquiredOwners.push(owner)
      return originalAcquire(handle, owner, workspace, documentType)
    }
    projector = new StaticDeltaProjector(
      repo, pool, 250, options.reloadMs ?? 5_000, () => true, undefined, residency, undefined, undefined, 50, 100,
    )
    if (options.sweep) {
      const tunable = projector as unknown as { zeroSweepFirstBackoffMs: number; zeroSweepMaxAttempts: number }
      tunable.zeroSweepFirstBackoffMs = options.sweep.firstBackoffMs
      tunable.zeroSweepMaxAttempts = options.sweep.maxAttempts
      if (options.sweep.capMs !== undefined) (projector as unknown as { recoveryBackoffCapMs: number }).recoveryBackoffCapMs = options.sweep.capMs
    }
    // OBSERVATION ONLY (call-through).
    const internal = projector as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const stamps = (projector as unknown as { passStamps: Map<string, PassStamp> }).passStamps
    const queuedRevisions: number[] = []
    for (const name of ['publish', 'transactionOnly'] as const) {
      const original = internal[name]!.bind(projector)
      internal[name] = (descriptor: unknown, ...rest: unknown[]) => {
        const stamp = stamps.get(oldHead.documentId)
        if ((descriptor as { documentId?: string }).documentId === oldHead.documentId && stamp) queuedRevisions.push(stamp.revision)
        return original(descriptor, ...rest)
      }
    }
    const currentHeadsAnswers: { revision: number; answer: readonly string[] | null }[] = []
    const originalSet = stamps.set.bind(stamps)
    stamps.set = (documentId: string, stamp: PassStamp) => {
      if (documentId === oldHead.documentId) {
        const read = stamp.readCurrentHeads
        stamp.readCurrentHeads = () => {
          const answer = read()
          currentHeadsAnswers.push({ revision: stamp.revision, answer })
          return answer
        }
      }
      return originalSet(documentId, stamp)
    }
    await projector.start()

    await until('control: the owed startup rotation took the tail', () => rotationIsHeld)
    if (options.keepOldHeadResident) residency.acquire(oldHead, 'zero-watermark-probe', `${WS.landscapeId}/${WS.versionId}`)
    await until('the old head\'s pass is acknowledged or queued', async () => {
      const row = await queueRow(oldHead.documentId)
      return Boolean(row && (row.projected === row.revision || queuedRevisions.includes(Number(row.revision))))
    })
    let row = await queueRow(oldHead.documentId)
    if (row!.projected === row!.revision) {
      connectionHead.change((doc) => { doc.forwardedBatchIds = ['legacy-connection-probe-1'] })
      await repo.flush([oldHead.documentId])
      await until('the old head\'s late pass is queued on the tail, behind the held rotation', async () => {
        row = await queueRow(oldHead.documentId)
        return Boolean(row && Number(row.revision) > Number(row.projected) && queuedRevisions.includes(Number(row.revision)))
      })
    }
    racingArmed = true
    const racingRevision = Number(row!.revision)
    const sampledHeads = [...(stamps.get(oldHead.documentId)?.sampledHeads ?? [])]
    const arrivalAtSample = await newestArrival(oldHead.documentId)
    expect(readMetaUrl(meta.doc(), 'editsConnectionShardUrl'), 'control: the rotation has not published yet').toBe(connectionHead.url)
    const release = async () => {
      releaseRotation.resolve()
      await until('the rotation published a new connection head', () => readMetaUrl(meta.doc(), 'editsConnectionShardUrl') !== connectionHead.url)
    }
    const answerFor = () => currentHeadsAnswers.find((entry) => entry.revision === racingRevision)?.answer
    const retiringTaken = () => acquiredOwners.some((owner) => owner.startsWith('static-retiring:'))
    return {
      oldHead, sampledHeads, racingRevision, arrivalAtSample, release, answerFor, retiringTaken,
      ackReached: firstGate.reached.promise, releaseAck: () => firstGate.release.resolve(), failures,
      acquiredOwners,
      /** Hold the old head's NEXT acknowledgement (or fail it). */
      armAck: (hook: 'fail' | 'hold') => {
        const gate = { reached: deferred(), release: deferred() }
        ackGate = gate
        ackHook = hook
        return { reached: gate.reached.promise, release: () => gate.release.resolve() }
      },
      /** T-ZEROWM-4: run `hook` at the old head's NEXT source-revision read. */
      armSourceRead: (hook: () => Promise<void>) => { sourceReadHook = hook },
    }
  }

  /** An eviction no lease can refuse — the partition failover's
   * (`evictWorkspaceDocumentCache`: announce, detach the persistence
   * listener, drop from the cache), as in `zeroWatermarkRecovery`. */
  const forcedEviction = async (documentId: string) => {
    const held = (repo.synchronizer as unknown as { docSynchronizers: Record<string, { query: { peek(): { state: string; handle?: DocHandle<unknown> } } }> })
      .docSynchronizers[documentId]?.query.peek()
    residency.notifyBeforeEvict(documentId, held?.handle)
    await residency.drain()
    if (!resident(documentId)) return
    held?.handle?.removeAllListeners('heads-changed')
    await repo.removeFromCache(documentId as Parameters<Repo['removeFromCache']>[0])
  }
  /** T-ZEROWM-4: every pass of `documentId` from now on (`project`, whatever started it). */
  const observePasses = (documentId: string) => {
    const starts: number[] = []
    const observed = projector as unknown as { project(descriptor: { documentId: string }, handle: DocHandle<unknown>): Promise<void> }
    const project = observed.project.bind(projector)
    observed.project = (descriptor, handle) => {
      if (descriptor.documentId === documentId) starts.push(Date.now())
      return project(descriptor, handle)
    }
    return starts
  }
  /** T-ZEROWM-4: the next `repo.find` of `documentId` — once the document is
   * loaded — runs the projector's 4 Hz scan (which attaches its change
   * listener to the handle being loaded) and replays a change event, the
   * load's own (replayed so that it never lands before the listener); with `started`, it returns only once that event's pass has
   * started (its coalescing timer fired). Restored by the returned function. */
  const loadStartsAPass = (documentId: string, mode: 'started' | 'armed', starts: number[]) => {
    const plain = repo.find.bind(repo)
    const finding = repo as unknown as { find: (...args: unknown[]) => Promise<DocHandle<unknown>> }
    let done = false
    /** `caller`: the call chain of the find that loaded it. */
    const state = { replayed: false, started: false, caller: '' }
    finding.find = async (...args: unknown[]) => {
      const caller = new Error().stack ?? ''
      const handle = await (plain as (...args: unknown[]) => Promise<DocHandle<unknown>>)(...args)
      if (!done && String(handle.documentId) === documentId) {
        done = true
        state.caller = caller
        const before = starts.length
        ;(projector as unknown as { scanResidentHandles(): void }).scanResidentHandles()
        handle.emit('change', { handle, doc: handle.doc(), patches: [], patchInfo: { before: handle.doc(), after: handle.doc(), source: 'change' } } as never)
        state.replayed = true
        if (mode === 'started') {
          const deadline = Date.now() + 5_000
          while (starts.length === before && Date.now() < deadline) await sleep(5)
          state.started = starts.length > before
        }
      }
      return handle
    }
    return { state, restore: () => { finding.find = plain as unknown as (...args: unknown[]) => Promise<DocHandle<unknown>> } }
  }

  it('control: the old head kept resident by a second owner — its racing pass is certified exactly', async () => {
    const race = await rotationOvertakesTheOldHeadsPass({ keepOldHeadResident: true })
    await race.release()
    await until('the racing revision is acknowledged', async () => Number((await queueRow(race.oldHead.documentId))?.projected) >= race.racingRevision)
    expect(race.answerFor(), 'control: readCurrentHeads found the sampled heads').toEqual(race.sampledHeads)
    const stamp = await certificate(race.oldHead.documentId)
    expect(stamp?.wm, 'a positive certificate').not.toBe('0')
    expect(BigInt(stamp!.wm) >= BigInt(race.arrivalAtSample!), `exact: it covers the arrival the pass sampled (${stamp!.wm} vs ${race.arrivalAtSample})`).toBe(true)
  }, 60_000)

  it('the retiring head stays resident under `static-retiring` until its pass settles: certified exactly, then the lease goes and it is evicted', async () => {
    const race = await rotationOvertakesTheOldHeadsPass({ keepOldHeadResident: false })
    await race.release()
    await until('the racing revision is acknowledged', async () => Number((await queueRow(race.oldHead.documentId))?.projected) >= race.racingRevision)
    // Measured before the fix: null (the head evicted before the commit).
    expect(race.answerFor(), 'readCurrentHeads found the sampled heads: the head was still resident at its commit').toEqual(race.sampledHeads)
    const stamp = await certificate(race.oldHead.documentId)
    expect(stamp?.wm, 'not the refusal 0').not.toBe('0')
    expect(BigInt(stamp!.wm) >= BigInt(race.arrivalAtSample!), `exact: it covers the arrival the pass sampled (${stamp!.wm} vs ${race.arrivalAtSample})`).toBe(true)
    expect(stamp!.heads, 'the stored heads are the sampled heads').toEqual(race.sampledHeads)
    await until('then the retiring lease goes', () => !leaseOwners(race.oldHead.documentId).some((owner) => owner.startsWith('static-retiring:')))
    await until('and the retired head is evicted', () => !resident(race.oldHead.documentId))
    expect(sweep().retiringLeases, 'no retiring lease left').toBe(0)
  }, 60_000)

  it('regression: once the old head\'s last revision is projected, the absence proof is not refused by it for ever', async () => {
    const race = await rotationOvertakesTheOldHeadsPass({ keepOldHeadResident: false })
    await race.release()
    await until('the racing revision is acknowledged', async () => Number((await queueRow(race.oldHead.documentId))?.projected) >= race.racingRevision)
    // More than one reload tick (5 s): every recovery path gets its turn.
    await sleep(6_000)
    const row = await queueRow(race.oldHead.documentId)
    expect(row?.projected, 'control: nothing is pending for the old head').toBe(row?.revision)
    const stamp = await certificate(race.oldHead.documentId)
    expect(BigInt(stamp?.wm ?? '0') >= BigInt((await newestArrival(race.oldHead.documentId))!),
      `the projected revision is certified (got ${JSON.stringify(stamp)})`).toBe(true)
    const freshness = await getWorkspaceProjectionFreshness(database.pool, WS)
    expect(freshness.arrivalRefusals?.zero, 'no document refuses on the `zero` branch').toBe(0)
  }, 60_000)

  it('no lease leaks when the retained head\'s pass FAILS: the retiring lease is released in its `finally`', async () => {
    const race = await rotationOvertakesTheOldHeadsPass({ keepOldHeadResident: false, ack: 'fail' })
    await race.release()
    await race.ackReached
    await until('the failed pass settled and released its retiring lease',
      () => sweep().retiringLeases === 0 && !leaseOwners(race.oldHead.documentId).some((owner) => owner.startsWith('static-retiring:')))
    expect(race.retiringTaken(), 'control: the retiring lease WAS taken').toBe(true)
    expect(Number((await queueRow(race.oldHead.documentId))?.projected), 'control: the failed acknowledgement did not move the queue')
      .toBeLessThan(race.racingRevision)
  }, 60_000)

  it('stop() during the retention releases the retiring lease (its drain ceiling passed)', async () => {
    const race = await rotationOvertakesTheOldHeadsPass({ keepOldHeadResident: false, ack: 'hold' })
    const stopping = projector as unknown as { stopDrainCeilingMs: number; inFlightRuns: Set<Promise<void>>; stop(): Promise<void> }
    try {
      await race.release()
      await race.ackReached
      expect(leaseOwners(race.oldHead.documentId).filter((owner) => owner.startsWith('static-retiring:')), 'control: retained while its pass is held').toHaveLength(1)
      stopping.stopDrainCeilingMs = 300
      await stopping.stop()
      projector = undefined
      expect(leaseOwners(race.oldHead.documentId), 'no owner of any kind left on the old head').toEqual([])
    } finally {
      race.releaseAck()
      // The held pass outlived the stop; let it finish before the next test's
      // cleanup DELETEs (a deadlock in the next beforeEach otherwise).
      await until('the overdue pass settled', () => stopping.inFlightRuns.size === 0)
    }
  }, 60_000)

  it('T-ZEROWM-3 B1: a rotation during the RECOVERY pass of the current head — once that pass settles the retired head is no longer resident', async () => {
    // The boot recovery's pass of the protocol-v1 head (saved before start,
    // so owed) is held at its source-revision read — after its sample, before
    // any tail work — while the owed startup rotation publishes a new head.
    const { connectionHead, meta } = await summaryWorkspace()
    const oldId = String(connectionHead.documentId)
    const reached = deferred()
    const resume = deferred()
    let holding = true
    const ownersAtHold: string[] = []
    // T-DIAGDEF: the handle the held recovery pass keeps resident.
    let heldResidency: unknown
    // The NEXT ModelMeta pass — the one whose
    // segment hydration loads the retired head again — held at its first
    // query, so the eviction is judged BEFORE any reader can bring it back.
    const metaId = String(meta.documentId)
    let holdMeta = false
    let metaHeld = 0
    const metaResume = deferred()
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (holding && sql.includes('SELECT revision FROM read_model_static_document_queue')
        && Array.isArray(values) && values[2] === oldId) {
        holding = false
        ownersAtHold.push(...leaseOwners(oldId))
        heldResidency = residentEntry(oldId)
        reached.resolve()
        await resume.promise
      }
      if (holdMeta && sql.includes('SELECT revision FROM read_model_static_document_queue')
        && Array.isArray(values) && values[2] === metaId) {
        holdMeta = false
        metaHeld += 1
        await metaResume.promise
      }
      return proceed()
    })
    projector = new StaticDeltaProjector(repo, pool, 250, 5_000, () => true, undefined, residency, undefined, undefined, 50, 100)
    const started = projector.start()
    try {
      await reached.promise
      expect(ownersAtHold.some((owner) => owner.startsWith('static-recovery:')), `control: the held pass is the boot recovery's (${JSON.stringify(ownersAtHold)})`).toBe(true)
      await until('the rotation published a new connection head', () => readMetaUrl(meta.doc(), 'editsConnectionShardUrl') !== connectionHead.url)
      await until('control: the ModelMeta pass moved the pointer and retired the head under the recovery', () =>
        leaseOwners(oldId).some((owner) => owner.startsWith('static-retiring:')))
      const owners = leaseOwners(oldId)
      expect(owners.some((owner) => owner.startsWith('static-recovery:')), `control: still under the recovery lease (${JSON.stringify(owners)})`).toBe(true)
      expect(owners.some((owner) => owner.startsWith('static-write-head:')), 'control: the write-head owner moved on').toBe(false)
      // The pass that retired the head runs to its end (its own hydration
      // finds the head still held: the same handle) — then the next one is held.
      await until('control: the retiring ModelMeta pass acknowledged', async () => {
        const row = await queueRow(metaId)
        return row !== null && row.projected === row.revision
      })
      holdMeta = true
    } finally {
      resume.resolve()
    }
    try {
      await started
      await until('the held pass settled and every owner left', () => leaseOwners(oldId).length === 0
        && (projector as unknown as { passLeases: { recovery: Map<string, unknown> } }).passLeases.recovery.size === 0)
      // BEFORE the drain and with no ModelMeta pass able to run: no reader can
      // have loaded it again, so "not resident" is the eviction itself.
      expect(leaseOwners(oldId), 'no owner holds the retired head').toEqual([])
      await until('the retired head is evicted once the recovery pass settled (no reader in between)', () => !resident(oldId), 5_000)
      expect(metaHeld, 'a ModelMeta pass held at most').toBeLessThanOrEqual(1)
    } finally {
      metaResume.resolve()
    }
    await until('every pass settled', () => (projector as unknown as { inFlightRuns: Set<unknown> }).inFlightRuns.size === 0)
    await residency.drain()
    // Measured before the fix: still resident — the retiring lease's release found
    // the recovery's still there, and the recovery only relinquished.
    //
    // THE WITNESS IS THE HANDLE THE RECOVERY HELD, not "any handle" (measured
    // on two earlier versions, 1/30 and 3/30 runs of this file): the eviction DID run once the last lease left (83 ms), and
    // the ModelMeta pass the rotation queued then hydrated its segment list —
    // the retired head is still one of the connection segments — and loaded it
    // AGAIN, unleased (87 ms, `hydrateOverlayDocuments`). That is a new
    // residency, by a reader that holds no lease, which the idle sweep takes;
    // the defect is a recovery that keeps the head IT held.
    expect(heldResidency, 'control: the held pass had the head resident').toBeDefined()
    expect(residentEntry(oldId) === heldResidency,
      'the retired head the recovery pass held is evicted once that pass settled').toBe(false)
    // T-ZEROWM-4 (1): waited for, not read at once — the ModelMeta pass's
    // segment hydration reloads the retired head, and a pass its load arms
    // (a coalescing timer: not in `inFlightRuns` yet) now runs under the
    // recovery lease, which goes with that pass (measured under load, 3 runs
    // in 30: a `static-recovery:` owner of that later pass, read here).
    await until('and no owner holds it once every pass ran', () => leaseOwners(oldId).length === 0, 10_000)
    expect(sweep().retiringUnderRecovery, 'counted').toBe(1)
  }, 60_000)

  it('release(workspace) during the retention releases the retiring lease', async () => {
    const race = await rotationOvertakesTheOldHeadsPass({ keepOldHeadResident: false, ack: 'hold' })
    try {
      await race.release()
      await race.ackReached
      expect(leaseOwners(race.oldHead.documentId).filter((owner) => owner.startsWith('static-retiring:')), 'control: retained while its pass is held').toHaveLength(1)
      projector!.release(WS, 'test: ownership lost')
      expect(leaseOwners(race.oldHead.documentId).filter((owner) => owner.startsWith('static-retiring:')), 'no retiring lease after the release').toEqual([])
      expect(sweep().retiringLeases).toBe(0)
    } finally {
      race.releaseAck()
    }
  }, 60_000)

  // ------------------------------------------------ T-ZEROWM-2 (1): no 0 for a withdrawn head

  it('T-ZEROWM-2 (1): a pass that acknowledges AFTER stop() passed its ceiling and its head was evicted certifies no 0 (the row is left as it was)', async () => {
    const race = await rotationOvertakesTheOldHeadsPass({ keepOldHeadResident: false, ack: 'hold' })
    const stopping = projector as unknown as { stopDrainCeilingMs: number; inFlightRuns: Set<Promise<void>>; stop(): Promise<void> }
    let before: Awaited<ReturnType<typeof certificate>> | undefined
    try {
      await race.release()
      await race.ackReached
      before = await certificate(race.oldHead.documentId)
      stopping.stopDrainCeilingMs = 300
      await stopping.stop()
      projector = undefined
      await residency.drain()
      expect(resident(race.oldHead.documentId), 'control: the stop past its ceiling evicted the old head under its held pass').toBe(false)
    } finally {
      race.releaseAck()
      await until('the overdue pass settled', () => stopping.inFlightRuns.size === 0)
    }
    expect(Number((await queueRow(race.oldHead.documentId))?.projected), 'control: the overdue acknowledgement COMMITTED')
      .toBeGreaterThanOrEqual(race.racingRevision)
    expect(race.answerFor(), 'control: its readCurrentHeads answered null (the handle was gone)').toBeNull()
    const after = await certificate(race.oldHead.documentId)
    // Measured before the fix: '0'.
    expect(after?.wm, `no refusal 0 written for the withdrawn head (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`).not.toBe('0')
    expect(after, 'the row is exactly the one before the overdue pass').toEqual(before)
    const freshness = await getWorkspaceProjectionFreshness(database.pool, WS)
    expect(freshness.arrivalRefusals?.zero, 'no document refuses on the `zero` branch').toBe(0)
    // A blocking defect of an earlier version: a kept row below the projected arrival is
    // `exact_low`, which no sweep reads, on a head nothing writes again — so
    // the withdrawn pass leaves the document OWED in its transaction.
    const owed = await queueRow(race.oldHead.documentId)
    expect(Number(owed?.revision), `the old head is left owed (${JSON.stringify(owed)})`).toBeGreaterThan(Number(owed?.projected))
    // THE NEXT BOOT (a fresh Repo and projector) re-projects it and certifies it.
    await repo.shutdown()
    repo = new Repo({
      storage: new PostgresStorageAdapter({ db: database.pool, trackStaticReadModel: true }), network: [], saveDebounceRate: 0,
    })
    residency = new AutomergeResidencyLeases(repo)
    projector = new StaticDeltaProjector(repo, database.pool, 250, 600, () => true, undefined, residency, undefined, undefined, 50, 100)
    await projector.start()
    await until('the next boot certifies the retired head\'s newest arrival', async () => {
      const stamp = await certificate(race.oldHead.documentId)
      const newest = await newestArrival(race.oldHead.documentId)
      return Boolean(stamp && newest && stamp.wm !== '0' && BigInt(stamp.wm) >= BigInt(newest))
    })
    // T-ZEROWM-4: the retired head's OWN branch at once; the workspace's once
    // it settled. Read at one instant, the workspace count also counted the
    // heads the next boot still owed — the rotation's new head among them —
    // whose passes come after (measured under load, 1 run in 30: `exact: 2`
    // right after the retired head was certified).
    expect(await arrivalBranch(String(race.oldHead.documentId)), 'the retired head refuses no more').toBe('exact_ok')
    await until('nothing refused on the exact branches once the workspace settled', async () => {
      const healed = await getWorkspaceProjectionFreshness(database.pool, WS)
      return healed.arrivalRefusals?.zero === 0 && healed.arrivalRefusals?.exact === 0
    })
  }, 60_000)

  it('T-ZEROWM-2 (1): an unleased document (a diagram) evicted IDLE under its running pass — projector alive — certifies no 0, is left owed, and the next reload tick certifies it with no further write', async () => {
    const diagram = repo.create<Record<string, unknown>>()
    const id = String(diagram.documentId)
    await registerStaticReadModelDocuments(database.pool, WS, [{ documentId: id, kind: 'diagram', entityId: 'd1' }])
    diagram.change((doc) => { doc.id = 'd1'; doc.name = 'first'; doc.objectIds = []; doc.connectionIds = [] })
    await repo.flush([diagram.documentId])
    let armed = false
    const gate = { reached: deferred(), release: deferred() }
    const pool = hookedPool(database.pool, async (sql, values, proceed) => {
      if (armed && sql.includes('UPDATE read_model_static_document_queue') && Array.isArray(values) && values[2] === id) {
        armed = false
        gate.reached.resolve()
        await gate.release.promise
      }
      return proceed()
    })
    // Reload ticks 3 s apart: the certificate is read right after the held
    // commit, well before the next tick (which both heals here and, before
    // the fix, relaunched the 0 through the sweep).
    projector = new StaticDeltaProjector(repo, pool, 250, 3_000, () => true, undefined, residency, undefined, undefined, 50, 100)
    await projector.start()
    await until('control: the first pass is certified exactly', async () => {
      const row = await queueRow(id)
      const stamp = await certificate(id)
      return Boolean(row && row.projected === row.revision && stamp && stamp.wm !== '0')
    })
    const before = await certificate(id)
    armed = true
    diagram.change((doc) => { doc.name = 'second' })
    await repo.flush([diagram.documentId])
    await gate.reached.promise
    const heldRevision = Number((await queueRow(id))?.revision)
    expect(leaseOwners(id), 'control: nothing leases a diagram').toEqual([])
    // The idle sweep's own call (`startIdleEviction` → `evict`).
    const evicted = await residency.evict(id)
    gate.release.resolve()
    expect(evicted, 'control: the idle eviction went through under the held pass').toBe(true)
    await until('the held pass committed', async () => Number((await queueRow(id))?.projected) >= heldRevision)
    const after = await certificate(id)
    // Measured before the fix: '0'.
    expect(after?.wm, `no refusal 0 for the evicted handle (after ${JSON.stringify(after)})`).not.toBe('0')
    expect(after, 'the row is the first pass\'s').toEqual(before)
    const owed = await queueRow(id)
    expect(Number(owed?.revision), `left owed (${JSON.stringify(owed)})`).toBeGreaterThan(Number(owed?.projected))
    const freshness = await getWorkspaceProjectionFreshness(database.pool, WS)
    expect(freshness.arrivalRefusals?.zero, 'nothing on the `zero` branch').toBe(0)
    // No further write: the document was left owed, and a reload tick
    // (`recoverChangedDocuments`) re-projects it with a fresh handle.
    await until('the next reload tick certifies the newest arrival', async () => {
      const stamp = await certificate(id)
      const newest = await newestArrival(id)
      return Boolean(stamp && newest && stamp.wm !== '0' && BigInt(stamp.wm) >= BigInt(newest))
    })
  }, 60_000)

  /** A settled race, then the old (retired) head's certificate forced to 0 —
   * the dumps' state, whatever produced it. `heads`: what the 0 row names. */
  async function retiredHeadWithForcedZero(
    heads: 'projected' | 'other',
    sweepTuning?: { firstBackoffMs: number; maxAttempts: number; capMs?: number },
    beforeForce?: (race: Awaited<ReturnType<typeof rotationOvertakesTheOldHeadsPass>>) => void | Promise<void>,
  ) {
    const race = await rotationOvertakesTheOldHeadsPass({ keepOldHeadResident: false, reloadMs: 600, sweep: sweepTuning })
    await race.release()
    await until('the racing revision is acknowledged', async () => Number((await queueRow(race.oldHead.documentId))?.projected) >= race.racingRevision)
    await until('the retired head\'s pass has settled', () => sweep().retiringLeases === 0)
    await beforeForce?.(race)
    const durable = await durableHeads(race.oldHead.documentId)
    await database.pool.query(
      `UPDATE read_model_document_watermarks SET projected_watermark = 0, projected_heads = $4
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [WS.landscapeId, WS.versionId, race.oldHead.documentId, heads === 'projected' ? durable : ['00'.repeat(32)]])
    const row = await queueRow(race.oldHead.documentId)
    expect(row?.projected, 'control: the queue row is acknowledged — no pass is owed').toBe(row?.revision)
    return race
  }

  /** T-DIAGDEF: once the sweep healed `healed`, NO ORPHAN 0 is left
   * in the workspace — no document certified 0 on an acknowledged queue row,
   * the sweep's own frontier — at once; and no document on the `zero` branch
   * at all once the workspace settled. Not "zero refusals at this instant":
   * the head the rotation published may still be owed, its pass to come, and
   * refuse meanwhile (measured under load, 2 runs in 30: that new connection
   * head at 0 with revision 8 against 4 projected, healed 3 s later). */
  /** T-ZEROWM-4: the arrival branch ONE document takes — the CASE the
   * absence proof itself reads (`DOCUMENT_ARRIVAL_BRANCH_SQL`), over the same
   * rows (`getWorkspaceProjectionFreshness`). */
  async function arrivalBranch(documentId: string): Promise<string | null> {
    const { rows } = await database.pool.query<{ name: string }>(
      `SELECT ${DOCUMENT_ARRIVAL_BRANCH_SQL} AS name
         FROM automerge_document_workspace dw
         LEFT JOIN read_model_projection_state p ON p.landscape_id = dw.landscape_id AND p.version_id = dw.version_id
         LEFT JOIN LATERAL (
           SELECT max(s.updated_at) AS newest_at, max(s.arrival_seq) AS max_seq FROM automerge_storage s
            WHERE split_part(s.key, '/', 1) = dw.document_id AND split_part(s.key, '/', 2) <> 'sync-state'
         ) newest ON true
         LEFT JOIN read_model_document_watermarks wm
           ON wm.landscape_id = dw.landscape_id AND wm.version_id = dw.version_id AND wm.document_id = dw.document_id
         LEFT JOIN read_model_adopt_watermarks aw
           ON aw.landscape_id = dw.landscape_id AND aw.version_id = dw.version_id AND aw.document_id = dw.document_id
        WHERE dw.landscape_id = $1 AND dw.version_id = $2 AND dw.document_id = $3`,
      [WS.landscapeId, WS.versionId, documentId])
    return rows[0]?.name ?? null
  }

  async function noOrphanZeroLeft(healed: string) {
    const { rows: orphans } = await database.pool.query<{ document_id: string; revision: string; projected: string }>(
      `SELECT wm.document_id, q.revision::text, q.projected_revision::text AS projected
         FROM read_model_document_watermarks wm
         JOIN read_model_static_document_queue q USING (landscape_id, version_id, document_id)
        WHERE wm.landscape_id = $1 AND wm.version_id = $2
          AND wm.projected_watermark = 0 AND q.revision = q.projected_revision`,
      [WS.landscapeId, WS.versionId])
    expect(orphans, 'no 0 on an acknowledged queue row').toEqual([])
    // T-ZEROWM-4: the healed head's OWN branch, read directly — not its
    // absence from `arrivalRefusals.sample`, which lists the first FIVE
    // refusing documents by id and so says nothing of a sixth.
    expect(await arrivalBranch(healed), 'the healed head refuses no more: its certificate covers its newest arrival').toBe('exact_ok')
    await until('no document on the `zero` branch once the workspace settled',
      async () => (await getWorkspaceProjectionFreshness(database.pool, WS)).arrivalRefusals?.zero === 0)
  }

  it('the sweep re-projects an ORPHAN 0 (queue acknowledged, projected heads = durable heads) and certifies it', async () => {
    const race = await retiredHeadWithForcedZero('projected')
    const before = sweep().relaunched
    await until('the orphan 0 is certified again', async () => (await certificate(race.oldHead.documentId))?.wm !== '0', 15_000)
    // Counted once the relaunched pass has an outcome.
    await until('counted as a relaunch', () => sweep().relaunched > before)
    const stamp = await certificate(race.oldHead.documentId)
    expect(BigInt(stamp!.wm) >= BigInt((await newestArrival(race.oldHead.documentId))!), 'exact').toBe(true)
    await noOrphanZeroLeft(String(race.oldHead.documentId))
  }, 60_000)

  it('the sweep leaves a LEGITIMATE 0 alone (its projected heads are not the durable heads: a true hole)', async () => {
    const race = await retiredHeadWithForcedZero('other')
    const before = sweep()
    // Several reload ticks (600 ms).
    await until('the sweep looked at it', () => sweep().legitimate > before.legitimate, 15_000)
    await sleep(2_000)
    expect(sweep().relaunched, 'not relaunched').toBe(before.relaunched)
    expect(sweep().legitimate - before.legitimate, 'counted ONCE for this row version, not once per tick').toBe(1)
    expect((await certificate(race.oldHead.documentId))?.wm, 'still the refusal').toBe('0')
  }, 60_000)

  it('the sweep is not starved: 40 legitimate 0s (more than a page) do not hide an orphan 0 behind them', async () => {
    const race = await retiredHeadWithForcedZero('projected')
    // 40 older legitimate refusals in the same workspace (registered documents
    // with an acknowledged queue row and heads that are not their durable ones).
    // Real (empty, never saved) documents: no durable heads, so each is a
    // legitimate refusal by the sweep's frontier.
    const ids = Array.from({ length: 40 }, () => String(repo.create<ConnectionHead>().documentId))
    await registerStaticReadModelDocuments(database.pool, WS, ids.map((documentId) => ({ documentId, kind: 'connection-overlay' as const })))
    for (const documentId of ids) {
      await database.pool.query(
        `INSERT INTO read_model_static_document_queue (landscape_id, version_id, document_id, revision, projected_revision)
         VALUES ($1, $2, $3, 1, 1)
         ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE SET projected_revision = read_model_static_document_queue.revision`,
        [WS.landscapeId, WS.versionId, documentId])
      await database.pool.query(
        `INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark, projected_heads, updated_at)
         VALUES ($1, $2, $3, 0, ARRAY['${'11'.repeat(32)}'], now() - interval '1 hour')
         ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE
         SET projected_watermark = 0, projected_heads = EXCLUDED.projected_heads, updated_at = EXCLUDED.updated_at`,
        [WS.landscapeId, WS.versionId, documentId])
    }
    await until('the orphan 0 behind them is certified', async () => (await certificate(race.oldHead.documentId))?.wm !== '0', 20_000)
  }, 60_000)

  it('the sweep backs off: a relaunch that cannot heal is retried at most once per backoff window', async () => {
    const race = await retiredHeadWithForcedZero('projected', { firstBackoffMs: 60_000, maxAttempts: 5 })
    race.failures.everyAck = true
    await until('relaunched once', () => sweep().relaunched === 1, 15_000)
    // Several reload ticks (600 ms) inside the 60 s window.
    await sleep(3_000)
    expect(sweep().relaunched, 'not again inside the backoff window').toBe(1)
    race.failures.everyAck = false
  }, 60_000)

  it('T-ZEROWM-3 (2): past its logged relaunches the sweep never gives up — it relaunches under a capped backoff, logged once per step, counted, and certifies once the cause is gone (no restart)', async () => {
    const FIRST = 200
    const CAP = 1_500
    const MAX = 2
    const RELAUNCHES = 6
    // Possibly absent: a build without the metric must fail here, not throw.
    const samples = () => (staticRecoveryBackoffMetricSamples as typeof staticRecoveryBackoffMetricSamples | undefined)?.() ?? []
    const metric = (index: number) => samples()[index]?.values.find((value) => value.labels?.recovery === 'zero_sweep')?.value ?? 0
    const counterBefore = metric(0)
    const warn = vi.spyOn(console, 'warn')
    // WHEN EACH RELAUNCH HAPPENED — the sweep's residency lease
    // (`static-zero-sweep:`) — and the `nextAt` its decision
    // wrote in the book, read at that very lease.
    const relaunches: Array<{ documentId: string; at: number; nextAt: number | undefined }> = []
    const book = () => (projector as unknown as { zeroSweepAttempts: Map<string, { nextAt: number }> }).zeroSweepAttempts
    for (const method of ['acquire', 'acquireTransient'] as const) {
      const real = residency[method].bind(residency) as (...args: unknown[]) => void
      vi.spyOn(residency, method).mockImplementation(((handle: DocHandle<unknown>, owner: string, ...rest: unknown[]) => {
        if (owner.startsWith('static-zero-sweep:')) {
          relaunches.push({ documentId: String(handle.documentId), at: Date.now(), nextAt: book().get(String(handle.documentId))?.nextAt })
        }
        return real(handle, owner, ...rest)
      }) as never)
    }
    // EVERY pass of the old head, with what started it — read off
    // the synchronous call chain into `project` (the sweep's relaunch, a
    // change event, or anything else: a `pending` re-run, the recovery…).
    const passStarts: Array<{ at: number; cause: 'sweep' | 'change' | 'other'; chain: string }> = []
    try {
      const race = await retiredHeadWithForcedZero('projected', { firstBackoffMs: FIRST, maxAttempts: MAX, capMs: CAP }, (settled) => {
        settled.failures.everyAck = true
        const oldId = String(settled.oldHead.documentId)
        const observed = projector as unknown as {
          project(descriptor: { documentId: string }, handle: DocHandle<unknown>): Promise<void>
          trigger(descriptor: { documentId: string }, handle: DocHandle<unknown>, immediate?: boolean): Promise<void> | undefined
        }
        const causeOf = (chain: string): 'sweep' | 'change' | 'other' =>
          chain.includes('relaunchOrphanZeroCertificates') ? 'sweep' : /\bonChange\b/.test(chain) ? 'change' : 'other'
        const callChain = () => (new Error().stack ?? '').split('\n').slice(3, 10).join(' < ')
        // An overlay's non-immediate `trigger` arms a coalescing timer: the
        // pass it starts runs from `Timeout`, its cause lost from the stack
        // (measured under load: a change event's pass read as "other"). So
        // every call since the last pass start is kept, and a timer-started
        // pass is the cause of the calls that armed it — "other" if ANY was
        // (a `pending` re-run from `trigger`'s `finally` re-arms that timer).
        let armedBy: Array<'sweep' | 'change' | 'other'> = []
        const trigger = observed.trigger.bind(projector)
        observed.trigger = (descriptor, handle, immediate) => {
          if (descriptor.documentId === oldId) armedBy.push(causeOf(callChain()))
          return trigger(descriptor, handle, immediate)
        }
        const project = observed.project.bind(projector)
        observed.project = (descriptor, handle) => {
          if (descriptor.documentId === oldId) {
            const chain = callChain()
            const direct = causeOf(chain)
            const timed = direct === 'other' && /\bTimeout\b/.test(chain)
            const cause = !timed ? direct
              : armedBy.length > 0 && !armedBy.includes('other') ? (armedBy.includes('change') ? 'change' : 'sweep') : 'other'
            passStarts.push({
              at: Date.now(),
              cause,
              chain: `${timed ? `timer armed by ${JSON.stringify(armedBy)}: ` : ''}${chain.replace(/\s+/g, ' ')}`.slice(0, 340),
            })
            armedBy = []
          }
          return project(descriptor, handle)
        }
      })
      // Measured before the fix: 2 relaunches, `static_zero_certificate_unhealed`,
      // then nothing until a restart.
      await until(`${RELAUNCHES} relaunches`, () => sweep().relaunched >= RELAUNCHES, 30_000)
      expect(metric(1), 'backing off: in the gauge').toBe(1)
      race.failures.everyAck = false
      await until('the orphan 0 is certified once the cause is gone, without a restart', async () => (await certificate(race.oldHead.documentId))?.wm !== '0', 10_000)
      const stamp = await certificate(race.oldHead.documentId)
      expect(BigInt(stamp!.wm) >= BigInt((await newestArrival(race.oldHead.documentId))!), 'exact').toBe(true)
      // Counts land once the relaunched pass has an outcome.
      await until('the healing relaunch settled', () => (projector as unknown as { inFlightRuns: Set<unknown> }).inFlightRuns.size === 0)
      const relaunched = sweep().relaunched
      const times = race.failures.times
      // The schedule: relaunch k waits FIRST·2^(k−1) before relaunch k+1, capped at CAP.
      // Measured between the RELAUNCHES, not between failed acknowledgements
      // (a pass's own duration, and passes started by a change event, sat
      // between them), and against the `nextAt` each decision
      // wrote — no margin — and that `nextAt` against the backoff.
      const backoff = (attempt: number) => Math.min(CAP, FIRST * 2 ** (attempt - 1))
      const own = relaunches.filter((relaunch) => relaunch.documentId === race.oldHead.documentId)
      const relaunchedAt = own.map((relaunch) => relaunch.at)
      expect(relaunchedAt.length, `every relaunch seen (${JSON.stringify(relaunchedAt)})`).toBe(relaunched)
      const gaps = relaunchedAt.slice(1).map((at, index) => at - relaunchedAt[index]!)
      const ackGaps = times.slice(1).map((at, index) => at - times[index]!)
      for (const [index, gap] of gaps.entries()) {
        const decided = own[index]!
        expect(decided.nextAt, `relaunch ${index + 1} wrote its backoff in the book`).toBeDefined()
        // Between writing `nextAt` and taking the lease, the sweep logs (a
        // `console.warn`) and enters `runUnderRecoveryLease`, synchronously:
        // the backoff it wrote is at most `backoff` past the lease, and less
        // than that by the time those few synchronous calls took (well under
        // a millisecond; 100 ms bounds them even under load, and still tells
        // the smallest backoff here, 200 ms, from none).
        expect(decided.nextAt! - decided.at, `relaunch ${index + 1}'s backoff (${backoff(index + 1)} ms)`).toBeLessThanOrEqual(backoff(index + 1))
        expect(decided.nextAt! - decided.at, `relaunch ${index + 1}'s backoff (${backoff(index + 1)} ms)`).toBeGreaterThan(backoff(index + 1) - 100)
        // …and the next relaunch is no earlier than that `nextAt`: exact.
        expect(own[index + 1]!.at, `relaunch ${index + 2} not before the nextAt of relaunch ${index + 1} (relaunch gaps ${JSON.stringify(gaps)}, acknowledgement gaps ${JSON.stringify(ackGaps)})`)
          .toBeGreaterThanOrEqual(decided.nextAt!)
        if (backoff(index + 1) >= CAP) {
          expect(gap, `capped (${CAP} ms plus a 600 ms tick; relaunch gaps ${JSON.stringify(gaps)})`).toBeLessThan(CAP + 1_100)
        }
      }
      // Every pass of the old head is the sweep's or a change event's — the
      // sweep's own load emits the change event its listener hears
      // (measured) — and nothing else: a `pending` re-run from `trigger`'s `finally`, or
      // the durable recovery, would be a relaunch outside the schedule.
      const others = passStarts.filter((start) => start.cause === 'other')
      expect(others.map((start) => start.chain), 'every pass started by the sweep or by a change event').toEqual([])
      // Each failed acknowledgement paired with the relaunch interval it fell
      // in, [relaunch j, relaunch j+1): AT MOST ONE per relaunch. T-ZEROWM-4:
      // no allowance any more for a change-event pass — the change event
      // the sweep's own load emits starts a pass DURING its resolve, and the
      // sweep now takes that pass as its relaunch (its lease, its book entry:
      // a relaunch above) instead of skipping the document and leaving it to
      // run unleased between two relaunches (as an earlier version allowed).
      const intervalOf = (at: number) => {
        let j = -1
        while (j + 1 < relaunchedAt.length && relaunchedAt[j + 1]! <= at) j += 1
        return j
      }
      const changes = passStarts.filter((start) => start.cause === 'change').map((start) => intervalOf(start.at))
      expect(times.every((at) => intervalOf(at) >= 0), 'no failed acknowledgement before the first relaunch').toBe(true)
      for (let j = 0; j < relaunchedAt.length; j += 1) {
        expect(changes.filter((interval) => interval === j).length, `at most one change-event pass between relaunches ${j + 1} and ${j + 2}`).toBeLessThanOrEqual(1)
        const acks = times.filter((at) => intervalOf(at) === j).length
        expect(acks, `failed acknowledgements between relaunches ${j + 1} and ${j + 2} (${JSON.stringify(times.map((at) => at - relaunchedAt[0]!))}; relaunches ${JSON.stringify(relaunchedAt.map((at) => at - relaunchedAt[0]!))}; change passes in intervals ${JSON.stringify(changes)})`)
          .toBeLessThanOrEqual(1)
      }
      // Review: the last relaunch may have failed before the cause went.
      expect(times.length, `one failed acknowledgement per failed pass (${relaunched} relaunches, ${changes.length} change passes)`).toBeGreaterThanOrEqual(relaunched - 1)
      const lines = warn.mock.calls.map((call) => String(call[0]))
      expect(lines.filter((line) => line.includes('read_model.static_zero_certificate_unhealed')), 'never given up').toEqual([])
      expect(lines.filter((line) => line.includes('read_model.static_zero_certificate_relaunched')), 'the first relaunches, one line each').toHaveLength(MAX)
      const steps = lines.filter((line) => line.includes('read_model.static_zero_certificate_backoff'))
        .map((line) => (JSON.parse(line) as { backoffMs: number }).backoffMs)
      // Relaunches 3 (800 ms) and 4 on (the 1 500 ms cap): one line per STEP.
      expect(steps, 'past them, one line per backoff step, not one per relaunch').toEqual([800, 1_500])
      expect(sweep().backedOff, 'every relaunch past them counted').toBe(relaunched - MAX)
      // The metric: the counter counted them, and the healed document left
      // the gauge (it once never did).
      expect(metric(0) - counterBefore, 'counter').toBe(relaunched - MAX)
      expect(metric(1), 'healed: out of the gauge').toBe(0)
      await noOrphanZeroLeft(String(race.oldHead.documentId))
    } finally {
      warn.mockRestore()
    }
  }, 90_000)

  // ------------------------------------------------ T-ZEROWM-2 (3): the sweep relaunches under a lease

  it('T-ZEROWM-2 (3): the sweep relaunches under its own residency lease — an idle eviction during the relaunch is refused, the relaunch certifies, then the lease goes and the head is evicted', async () => {
    let held: { reached: Promise<void>; release: () => void } | undefined
    const race = await retiredHeadWithForcedZero('projected', undefined, (settled) => { held = settled.armAck('hold') })
    try {
      await held!.reached
      const owners = leaseOwners(race.oldHead.documentId)
      expect.soft(owners.filter((owner) => owner.startsWith('static-zero-sweep:')), `leased by the sweep during its relaunch (${JSON.stringify(owners)})`).toHaveLength(1)
      // The idle sweep's own call, while the relaunch's pass is in flight.
      // Measured before the fix: true — the head goes under the relaunch.
      expect(await residency.evict(race.oldHead.documentId), 'the idle eviction is refused: the relaunch holds the head').toBe(false)
    } finally {
      held?.release()
    }
    await until('the relaunch certified the orphan 0', async () => (await certificate(race.oldHead.documentId))?.wm !== '0', 15_000)
    await until('then the sweep lease goes', () => !leaseOwners(race.oldHead.documentId).some((owner) => owner.startsWith('static-zero-sweep:'))
      && sweep().sweepLeases === 0)
    await until('and the retired head is evicted', () => !resident(race.oldHead.documentId))
    await noOrphanZeroLeft(String(race.oldHead.documentId))
  }, 60_000)

  it('T-ZEROWM-2 (3): stop() past its ceiling, a relaunch still held, releases the sweep lease', async () => {
    let held: { reached: Promise<void>; release: () => void } | undefined
    const race = await retiredHeadWithForcedZero('projected', undefined, (settled) => { held = settled.armAck('hold') })
    const stopping = projector as unknown as { stopDrainCeilingMs: number; inFlightRuns: Set<Promise<void>>; stop(): Promise<void> }
    try {
      await held!.reached
      expect(leaseOwners(race.oldHead.documentId).some((owner) => owner.startsWith('static-zero-sweep:')), 'control: leased by the relaunch').toBe(true)
      stopping.stopDrainCeilingMs = 300
      await stopping.stop()
      projector = undefined
      expect(leaseOwners(race.oldHead.documentId).filter((owner) => owner.startsWith('static-zero-sweep:')), 'no sweep lease after the stop').toEqual([])
      expect((stopping as unknown as { zeroCertificateSweepSnapshot(): Sweep }).zeroCertificateSweepSnapshot().sweepLeases, 'none counted').toBe(0)
    } finally {
      held?.release()
      await until('the overdue relaunch settled', () => stopping.inFlightRuns.size === 0)
    }
  }, 60_000)

  it('T-ZEROWM-2 (3): a relaunch whose pass FAILS releases its sweep lease all the same', async () => {
    let held: { reached: Promise<void>; release: () => void } | undefined
    const race = await retiredHeadWithForcedZero('projected', { firstBackoffMs: 60_000, maxAttempts: 5 }, (settled) => { held = settled.armAck('fail') })
    await held!.reached
    expect(race.acquiredOwners.some((owner) => owner.startsWith('static-zero-sweep:')), 'control: the sweep lease WAS taken').toBe(true)
    await until('the failed relaunch released its sweep lease', () => !leaseOwners(race.oldHead.documentId).some((owner) => owner.startsWith('static-zero-sweep:'))
      && sweep().sweepLeases === 0)
    expect((await certificate(race.oldHead.documentId))?.wm, 'control: the failed relaunch healed nothing').toBe('0')
  }, 60_000)

  // ------------------------------------------------------------------ T-ZEROWM-3

  it('T-ZEROWM-3 (6): the sweep relaunch of a document ALREADY resident relinquishes it — still resident after — while one it loaded itself is evicted (the case above)', async () => {
    let loaded: DocHandle<unknown> | undefined
    const race = await retiredHeadWithForcedZero('projected', undefined, async (settled) => {
      // The retired head, evicted by its retiring lease's release, loaded
      // again by someone else (unleased) before the sweep relaunches it.
      // (Already evicted by its retiring lease's release; an idle eviction
      // otherwise — it is unleased once its pass settled.)
      await until('control: unleased', () => leaseOwners(settled.oldHead.documentId).length === 0)
      await residency.evict(settled.oldHead.documentId)
      await residency.drain()
      expect(resident(settled.oldHead.documentId), 'control: the retired head is not resident').toBe(false)
      loaded = await repo.find(settled.oldHead.url)
    })
    await until('the relaunch certified it', async () => (await certificate(race.oldHead.documentId))?.wm !== '0', 15_000)
    await until('the sweep lease went', () => sweep().sweepLeases === 0
      && !leaseOwners(race.oldHead.documentId).some((owner) => owner.startsWith('static-zero-sweep:')))
    await residency.drain()
    // Measured before the fix: evicted under the other holder.
    expect(resident(race.oldHead.documentId), 'not evicted by the relaunch: it did not load it').toBe(true)
    expect(loaded?.state, 'control: the other holder\'s handle').toBe('ready')
  }, 60_000)

  it('T-ZEROWM-3 (4): saturation on the SWEEP side — an orphan the saturated book does not know is relaunched at the cap, logged as assumed', async () => {
    const CAP = 1_500
    const lines: { at: number; line: string }[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { lines.push({ at: Date.now(), line: String(line) }) })
    try {
      const race = await retiredHeadWithForcedZero('projected', { firstBackoffMs: 100, maxAttempts: 5, capMs: CAP }, (settled) => {
        settled.failures.everyAck = true
        // A book of ONE entry, full of a document backing off; a second one
        // drops it: saturated before the orphan's first relaunch.
        const book = (projector as unknown as { zeroSweepAttempts: { bound: number; saturated: boolean; set(id: string, entry: object): void } }).zeroSweepAttempts
        book.bound = 1
        const entry = { attempts: 9, nextAt: Number.MAX_SAFE_INTEGER, backingOff: true, workspace: 'elsewhere' }
        book.set('backing-off-1', entry)
        book.set('backing-off-2', entry)
        expect(book.saturated, 'control: saturated').toBe(true)
      })
      const assumed = () => lines.find(({ line }) => line.includes('read_model.static_zero_certificate_backoff')
        && line.includes(race.oldHead.documentId) && line.includes('"assumedFromSaturation":true'))
      await until('the orphan\'s first relaunch entered at the cap', () => Boolean(assumed()), 15_000)
      expect((JSON.parse(assumed()!.line) as { backoffMs: number }).backoffMs).toBe(CAP)
      const enteredAt = assumed()!.at
      await until('one more relaunch', () => race.failures.times.filter((at) => at > enteredAt).length >= 2, 15_000)
      const after = race.failures.times.filter((at) => at > enteredAt)
      // Without saturation: 100 ms. Measured between failed acknowledgements
      // (150 ms of slack for the pass itself).
      expect(after[1]! - after[0]!, `the next relaunch waited the cap (${JSON.stringify(after)})`).toBeGreaterThanOrEqual(CAP - 150)
      race.failures.everyAck = false
    } finally {
      warn.mockRestore()
    }
  }, 60_000)

  // ------------------------------------------------------------------ T-ZEROWM-4

  // (2) The sweep's own window, the one already closed for the recovery: its
  // resolve LOADS the retired head; the 4 Hz scan attaches the change listener
  // to the handle being loaded, and the load's own change event starts (or
  // arms) the head's pass before the sweep goes on. Measured before the fix: the
  // sweep found the document busy and skipped it — the pass ran with no sweep
  // lease (an idle eviction free to take the head from under it) and outside
  // the sweep's book (the change-event allowance an earlier witness had).
  for (const mode of ['started', 'armed'] as const) {
    it(`T-ZEROWM-4 (2): a pass ${mode === 'started' ? 'started' : 'armed (coalescing timer)'} during the SWEEP's own resolve is the relaunch — under the sweep lease, in its book, and not asked again`, async () => {
      let held: { reached: Promise<void>; release: () => void } | undefined
      let starts: number[] = []
      let load: ReturnType<typeof loadStartsAPass> | undefined
      const before = { relaunched: 0 }
      try {
        const race = await retiredHeadWithForcedZero('projected', { firstBackoffMs: 60_000, maxAttempts: 5 }, (settled) => {
          before.relaunched = sweep().relaunched
          starts = observePasses(String(settled.oldHead.documentId))
          load = loadStartsAPass(String(settled.oldHead.documentId), mode, starts)
          held = settled.armAck('hold')
        })
        const oldId = String(race.oldHead.documentId)
        await held!.reached
        expect(load!.state.replayed, 'control: the sweep\'s resolve loaded the head and its change event was heard').toBe(true)
        expect(load!.state.caller, 'control: the find was the sweep\'s').toContain('relaunchOrphanZeroCertificates')
        // (Waited for: that pass may reach its acknowledgement before the
        // find's 5 ms poll sees it start.)
        if (mode === 'started') await until('control: that event\'s pass started before the sweep went on', () => load!.state.started, 5_000)
        const owners = leaseOwners(oldId)
        // Measured before the fix: [] — no sweep lease, the pass unleased.
        expect(owners.filter((owner) => owner.startsWith('static-zero-sweep:')), `under the sweep lease at its acknowledgement (${JSON.stringify(owners)})`).toHaveLength(1)
        expect(await residency.evict(oldId), 'an idle eviction is refused under it').toBe(false)
        held!.release()
        await until('the relaunch certified the orphan 0', async () => (await certificate(oldId))?.wm !== '0', 15_000)
        await until('its pass settled', () => (projector as unknown as { inFlightRuns: Set<unknown> }).inFlightRuns.size === 0)
        await until('then the sweep lease goes', () => sweep().sweepLeases === 0 && !leaseOwners(oldId).some((owner) => owner.startsWith('static-zero-sweep:')))
        // ONE pass, and it is the relaunch (counted once it has an outcome).
        expect(starts.length, 'one pass of the head: the sweep did not ask for it again').toBe(1)
        expect(sweep().relaunched - before.relaunched, 'counted as the relaunch').toBe(1)
        await until('the sweep evicted the head it loaded', () => !resident(oldId))
        await noOrphanZeroLeft(oldId)
      } finally {
        held?.release()
        load?.restore()
      }
    }, 60_000)
  }

  it('T-ZEROWM-4 (2): a sweep tick between the eviction of a relaunched pass and the commit of its withdrawal starts no second pass', async () => {
    // The sweep's twin of the recovery case: `detach` empties `docRuns`, the
    // evicted pass runs on to its withdrawal, and meanwhile the 0 is still on
    // an acknowledged queue row past its (short) backoff — the sweep's own
    // frontier. Measured before the fix: a later tick relaunched it, a second
    // pass concurrent with the first.
    let evictedAt = 0
    let heldUntil = 0
    let starts: number[] = []
    const race = await retiredHeadWithForcedZero('projected', { firstBackoffMs: 100, maxAttempts: 5, capMs: 1_500 }, (settled) => {
      const oldId = String(settled.oldHead.documentId)
      starts = observePasses(oldId)
      settled.armSourceRead(async () => {
        await forcedEviction(oldId)
        evictedAt = Date.now()
        await sleep(1_500)
        heldUntil = Date.now()
      })
    })
    const oldId = String(race.oldHead.documentId)
    await until('the held relaunch ended', () => heldUntil > 0, 20_000)
    await until('control: the evicted relaunch committed its withdrawal', () => (sweep().withdrawn ?? 0) >= 1)
    const inWindow = starts.filter((at) => at > evictedAt && at < heldUntil)
    expect(inWindow.map((at) => at - evictedAt), 'no second pass while the evicted one has not ended').toEqual([])
    await until('the head is certified once the withdrawn pass re-opened it', async () => {
      const stamp = await certificate(oldId)
      const newest = await newestArrival(oldId)
      return Boolean(stamp && newest && stamp.wm !== '0' && BigInt(stamp.wm) >= BigInt(newest))
    }, 20_000)
  }, 60_000)

  // (1) `hydrateOverlayDocuments` — the ModelMeta pass loading its segment
  // list — loads a RETIRED head (a historical segment) on a fresh boot; the
  // load's change event (heard by the scan's listener) starts or arms that
  // head's pass during the hydration's resolve. Measured before the fix: that
  // pass ran with no lease at all (nothing leases a retired head).
  /** T-ZEROWM-4 (1): a workspace whose ModelMeta lists a retired connection
   * head, projected by a first life; then a fresh Repo — nothing resident, so
   * the next boot's ModelMeta pass LOADS the retired head (its segment
   * hydration). */
  async function retiredSegmentOnAFreshBoot() {
    const objectHead = repo.create<ObjectHead>()
    const retired = repo.create<ConnectionHead>()
    const current = repo.create<ConnectionHead>()
    const meta = repo.create<Record<string, unknown>>()
    await registerStaticReadModelDocuments(database.pool, WS, [
      { documentId: meta.documentId, kind: 'model-meta' },
      { documentId: objectHead.documentId, kind: 'object-overlay' },
      { documentId: retired.documentId, kind: 'connection-overlay' },
      { documentId: current.documentId, kind: 'connection-overlay' },
    ])
    objectHead.change((doc) => { doc.objects = { o1: { id: 'o1', name: 'A' }, o2: { id: 'o2', name: 'B' } }; doc.writeHeadVersion = 2; doc.writeBatchIds = [] })
    retired.change((doc) => { doc.connections = { c1: { id: 'c1', fromId: 'o1', toId: 'o2', label: 'old' } }; doc.writeHeadVersion = 2; doc.writeBatchIds = [] })
    current.change((doc) => { doc.connections = {}; doc.writeHeadVersion = 2; doc.writeBatchIds = [] })
    meta.change((doc) => {
      doc.groups = {}
      doc.editsObjectShardUrls = [objectHead.url]
      doc.editsObjectShardUrl = objectHead.url
      doc.editsConnectionShardUrls = [retired.url, current.url]
      doc.editsConnectionShardUrl = current.url
    })
    await repo.flush()
    // (The current head, empty, stays owed: the next boot's recovery takes
    // it — it is not the document under test.)
    const ids = [meta, objectHead, retired].map((handle) => String(handle.documentId))
    projector = new StaticDeltaProjector(repo, database.pool, 250, 60_000, () => true, undefined, residency, undefined, undefined, 50, 100)
    await projector.start()
    await until('control: the first life acknowledged the ModelMeta and the retired head', async () => {
      for (const id of ids) {
        const row = await queueRow(id)
        if (!row || row.projected !== row.revision) return false
      }
      return true
    })
    await until('control: settled', () => (projector as unknown as { inFlightRuns: Set<unknown> }).inFlightRuns.size === 0)
    await projector.stop()
    projector = undefined
    await repo.shutdown()
    repo = new Repo({ storage: new PostgresStorageAdapter({ db: database.pool, trackStaticReadModel: true }), network: [], saveDebounceRate: 0 })
    residency = new AutomergeResidencyLeases(repo)
    return String(retired.documentId)
  }

  it('T-ZEROWM-4: a coalescing timer armed on a handle dropped before it fires starts nothing, leaves nothing armed, and lets its lease go', async () => {
    // An overlay's change arms a timer (`trigger`, not immediate) on its
    // handle — under a recovery lease, as the hydration takes one for an armed
    // pass. The handle is dropped from the Repo with no announcement (no
    // `detach`: the timer is not cleared). Measured before the fix: the timer
    // started a pass on the dead handle.
    const retiredId = await retiredSegmentOnAFreshBoot()
    projector = new StaticDeltaProjector(repo, database.pool, 60_000, 60_000, () => true, undefined, residency, undefined, undefined, 50, 100)
    await projector.start()
    await until('control: settled', () => (projector as unknown as { inFlightRuns: Set<unknown> }).inFlightRuns.size === 0)
    const internal = projector as unknown as {
      descriptors: Map<string, unknown>
      docRuns: Map<string, { running: boolean; pending: boolean; timer?: unknown }>
      trigger(descriptor: unknown, handle: DocHandle<unknown>, immediate?: boolean): Promise<void> | undefined
      takeRecoveryLease(kind: string, descriptor: unknown, handle: DocHandle<unknown>, evictOnRelease: boolean): void
      passBusy(id: string): boolean
    }
    const handle = await repo.find<ConnectionHead>(`automerge:${retiredId}` as DocHandle<unknown>['url'])
    const starts = observePasses(retiredId)
    internal.trigger(internal.descriptors.get(retiredId), handle as DocHandle<unknown>)
    expect(internal.docRuns.get(retiredId)?.timer, 'control: a coalescing timer is armed').toBeDefined()
    internal.takeRecoveryLease('recovery', internal.descriptors.get(retiredId), handle as DocHandle<unknown>, false)
    expect(leaseOwners(retiredId).filter((owner) => owner.startsWith('static-recovery:')), 'control: leased for it').toHaveLength(1)
    await repo.removeFromCache(handle.documentId)
    // Past the coalescing window (500 ms by default; at most 3 s).
    await until('the timer fired', () => !internal.docRuns.get(retiredId)?.timer, 5_000)
    await sleep(100)
    expect(starts, 'no pass on the dead handle').toEqual([])
    expect(internal.passBusy(retiredId), 'nothing left armed or pending').toBe(false)
    expect(leaseOwners(retiredId).filter((owner) => owner.startsWith('static-recovery:')), 'its lease went').toEqual([])
  }, 60_000)

  it('T-ZEROWM-4 (1): a retired head evicted inside the segment hydration\'s resolve is not attached (the dead handle would replace a live listener)', async () => {
    const retiredId = await retiredSegmentOnAFreshBoot()
    projector = new StaticDeltaProjector(repo, database.pool, 60_000, 60_000, () => true, undefined, residency, undefined, undefined, 50, 100)
    const plain = repo.find.bind(repo)
    const finding = repo as unknown as { find: (...args: unknown[]) => Promise<DocHandle<unknown>> }
    let dead: DocHandle<unknown> | undefined
    let caller = ''
    let deadListened: boolean | undefined
    finding.find = async (...args: unknown[]) => {
      const stack = new Error().stack ?? ''
      const handle = await (plain as (...args: unknown[]) => Promise<DocHandle<unknown>>)(...args)
      if (!dead && String(handle.documentId) === retiredId) {
        dead = handle
        caller = stack
        // The idle sweep's own call: unleased, it goes through.
        expect(await residency.evict(retiredId), 'control: evicted inside the resolve').toBe(true)
        // Read right after THIS hydration's continuation (the microtasks that
        // follow the find): a later ModelMeta pass may hydrate the head again,
        // live, and replace whatever this one attached.
        setTimeout(() => {
          deadListened = (projector as unknown as { listened: Map<string, { handle: DocHandle<unknown> }> }).listened.get(retiredId)?.handle === handle
        }, 0)
      }
      return handle
    }
    try {
      await projector.start()
      // `start()` does not wait for the ModelMeta pass (only for its tail
      // work): under load the hydration came after it (6 runs in 30).
      await until('control: the hydration loaded the retired head', () => Boolean(dead))
      await until('control: the ModelMeta pass (its hydration) settled', () =>
        (projector as unknown as { inFlightRuns: Set<unknown> }).inFlightRuns.size === 0)
      expect(caller, 'control: the find was the segment hydration\'s').toContain('hydrateOverlayDocuments')
      await until('control: read after the hydration\'s continuation', () => deadListened !== undefined)
      // Mutant without the check: the dead handle is listened.
      expect(deadListened, 'the dead handle is not attached').toBe(false)
    } finally {
      finding.find = plain as unknown as (...args: unknown[]) => Promise<DocHandle<unknown>>
    }
  }, 60_000)

  for (const mode of ['started', 'armed'] as const) {
    it(`T-ZEROWM-4 (1): the segment hydration of a retired head whose load ${mode === 'started' ? 'starts' : 'arms'} its pass — that pass runs under the recovery lease, which goes with it`, async () => {
      const retiredId = await retiredSegmentOnAFreshBoot()
      let hold = true
      const gate = { reached: deferred(), release: deferred() }
      const pool = hookedPool(database.pool, async (sql, values, proceed) => {
        if (hold && sql.includes('SELECT revision FROM read_model_static_document_queue') && Array.isArray(values) && values[2] === retiredId) {
          hold = false
          gate.reached.resolve()
          await gate.release.promise
        }
        return proceed()
      })
      projector = new StaticDeltaProjector(repo, pool, 250, 60_000, () => true, undefined, residency, undefined, undefined, 50, 100)
      const starts = observePasses(retiredId)
      const load = loadStartsAPass(retiredId, mode, starts)
      const started = projector.start()
      try {
        await gate.reached.promise
        expect(load.state.replayed, 'control: the hydration loaded the retired head and its change event was heard').toBe(true)
        expect(load.state.caller, 'control: the find was the segment hydration\'s').toContain('hydrateOverlayDocuments')
        // Measured before the fix: [] — the retired head's pass unleased.
        await until(`under the recovery lease (${JSON.stringify(leaseOwners(retiredId))})`, () =>
          leaseOwners(retiredId).filter((owner) => owner.startsWith('static-recovery:')).length === 1, 3_000)
        expect(await residency.evict(retiredId), 'an idle eviction is refused under it').toBe(false)
      } finally {
        gate.release.resolve()
        load.restore()
      }
      await started
      await until('its pass settled', () => (projector as unknown as { inFlightRuns: Set<unknown> }).inFlightRuns.size === 0)
      await until('then the recovery lease goes', () => !leaseOwners(retiredId).some((owner) => owner.startsWith('static-recovery:'))
        && sweep().recoveryLeases === 0)
      expect(starts.length, 'one pass of the retired head').toBe(1)
      expect((await certificate(retiredId))?.wm, 'no refusal 0').not.toBe('0')
    }, 60_000)
  }
})
