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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { Repo, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { createClaimedDocumentFromBinary, setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { withLifecycleApplyLock } from '../maintenance/lifecycleApplyLock.js'
import { buildEpochMeta } from '../modelEpochs.js'
import { metaUrlsAreScalar, readMetaUrls } from '../modelMetaUrls.js'
import { ensureReadModelSchema } from './schema.js'
import { startReadModelProjector } from './projectorService.js'
import { readProjectionAcknowledgement } from './compaction.js'
import { runModelEpochMetaJob, runWorkspaceCompaction, type WorkspaceCompactionDeps } from './workspaceCompaction.js'
import { modelEpochConfig } from './modelEpochConfig.js'
import { firstRollDate, firstRollDue, storageDurableHeads } from './modelEpochStep.js'
import { modelEpochLockKey } from './modelEpochRoll.js'
import { lifecycleRotationEdges, projectionInboundEdges, projectionLockOrderViolations, unknownAdvisoryKeys } from './lockEdgeScan.js'
import { overlayRotationLockKey } from './overlayRotationLock.js'
import type { WorkspaceKey } from './projector.js'
import { sweepModelEpochs } from './modelEpochSweep.js'
import { epochRolledOrRecovered } from './modelEpochForwardWiring.js'

/**
 * G4-16f — THE EPOCH STEP of the compaction pass, end to end: real
 * PostgreSQL storage and schema, a real projector the pass detaches and
 * re-attaches, `runWorkspaceCompaction` with `modelEpochs` wired as
 * `index.ts` wires it (the lifecycle lock included).
 *
 *  - flag OFF: the pass is the pass it was, and no epoch row exists;
 *  - flag ON: the first pass rolls epoch 1 — the root names a scalar-native
 *    ModelMeta, the base shard is a fresh claimed document whose durable
 *    heads are its one change, the read model re-attached on the new epoch
 *    serves the same objects; the next pass is `not_due`;
 *  - the lifecycle lock held elsewhere: nothing rolls;
 *  - the lock scanners over the pass's real statement stream: the
 *    `model-epoch:` key is taken and given back, no projection mutex under
 *    any key, no unknown key;
 *  - R4-d: a repoint of the root by ANY writer (here a script-shaped one, and
 *    a second Repo's synced change) makes the running projector ask to be
 *    recycled, once.
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-epoch-step', versionId: 'v1' }
let db: IsolatedSchemaDb

type Entity = { id: string; [field: string]: unknown }
type Meta = Record<string, unknown>

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))
const storageRepo = () => new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 60_000 })

async function claim(documentId: string) {
  await db.pool.query(
    'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [documentId, WS.landscapeId, WS.versionId])
}

async function workspace(repo: Repo) {
  const base = repo.create<{ objects: Record<string, Entity> }>({
    objects: { b: { id: 'b', name: 'Base B', type: 'system' }, c: { id: 'c', name: 'Base C', type: 'system' } },
  })
  for (let i = 0; i < 10; i += 1) base.change((d) => { d.objects.b!.name = `Base B ${i}` })
  const head = repo.create({ objects: { h: { id: 'h', name: 'In the head', type: 'system' } }, writeBatchIds: [] })
  const connHead = repo.create({ connections: {}, writeBatchIds: [] })
  const meta = repo.create<Meta>({
    objectShardUrls: [base.url, head.url], connectionShardUrls: [connHead.url],
    editsObjectShardUrl: head.url, editsObjectShardUrls: [head.url],
    editsConnectionShardUrl: connHead.url, editsConnectionShardUrls: [connHead.url],
    groups: {},
  })
  const registry = repo.create({ diagrams: {} })
  const root = repo.create<Meta>({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
  const handles = [base, head, connHead, meta, registry, root]
  await Promise.all(handles.map((h) => h.whenReady()))
  await repo.flush()
  for (const handle of handles) await claim(String(handle.documentId))
  return { repo, root, meta, base, head }
}
type World = Awaited<ReturnType<typeof workspace>>

function projectorFleet(ws: World, pool: IsolatedSchemaDb['pool'] = db.pool) {
  let instance: string | null = null
  let stop: (() => void) | null = null
  const counts = { starts: 0, releases: 0, repointed: 0 }
  const startOne = async () => {
    counts.starts += 1
    stop = await startReadModelProjector(
      ws.repo, ws.root.url, pool, WS, undefined, 0, undefined, undefined, undefined, (id) => { instance = id },
      undefined, { onModelMetaRepointed: () => { counts.repointed += 1 } },
    )
  }
  const fleet: WorkspaceCompactionDeps['fleet'] = {
    isResident: () => stop !== null,
    ensure: async () => { if (!stop) await startOne(); return true },
    release: () => { counts.releases += 1; stop?.(); stop = null },
    residentProjectorInstanceId: () => instance,
  }
  return { fleet, counts, start: startOne, stop: () => { stop?.(); stop = null } }
}

const epochsOn = (over: Partial<NonNullable<WorkspaceCompactionDeps['modelEpochs']>> = {}): NonNullable<WorkspaceCompactionDeps['modelEpochs']> => ({
  config: modelEpochConfig({ AM_MODEL_EPOCHS: 'on' }),
  instanceId: 'test-instance',
  // The workspace's first-roll day (workspaces' first rolls are spread).
  now: () => firstRollDate(WS, 30),
  withLifecycleLock: async (critical) => {
    const locked = await withLifecycleApplyLock(db.pool, WS, () => critical())
    return locked.granted ? { granted: true, value: locked.value } : { granted: false }
  },
  ...over,
})

function deps(ws: World, fleet: WorkspaceCompactionDeps['fleet'], over: Partial<WorkspaceCompactionDeps> = {}): WorkspaceCompactionDeps {
  return {
    repo: ws.repo, rootUrl: ws.root.url, db: db.pool, fleet,
    connect: () => db.pool.connect(),
    ownership: { owns: () => true }, isShuttingDown: () => false,
    log: () => {}, warn: () => {},
    ...over,
  } as WorkspaceCompactionDeps
}

const acknowledged = () => until(() => readProjectionAcknowledgement(db.pool, WS), (ack) => ack.acknowledged)
const roNames = async () => (await db.pool.query<{ id: string; data: { name?: string } }>(
  'SELECT id, data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id', [WS.landscapeId, WS.versionId],
)).rows.map((row) => [row.id, row.data.name])
const epochRows = async () => (await db.pool.query<{ epoch_no: number; state: string; kind: string }>(
  `SELECT epoch_no, state, kind FROM read_model_model_epochs WHERE landscape_id = $1 AND version_id = $2 ORDER BY epoch_no`,
  [WS.landscapeId, WS.versionId])).rows

suite('the compaction pass\'s epoch step (G4-16f)', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'model_epoch_step')
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
  let restoreRegistration: () => void = () => {}
  beforeEach(async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.pool.query(`TRUNCATE automerge_storage, automerge_document_workspace, ro_objects, ro_connections, ro_groups,
          read_model_projection_state, read_model_change_events, read_model_overlay_batch_acks,
          read_model_overlay_entity_bases, read_model_ordinary_head_retirements, read_model_document_watermarks,
          read_model_ordinary_chain_folds, read_model_model_epochs, read_model_model_epoch_docs,
          read_model_model_epoch_forwards, read_model_model_epoch_forward_writes, read_model_model_epoch_overrides`)
        break
      } catch (error) {
        if ((error as { code?: string }).code !== '40P01' || attempt >= 5) throw error
        await settle(200)
      }
    }
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async ({ landscapeId, versionId, documentIds }) => {
      for (const documentId of documentIds) {
        await db.pool.query(
          'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [documentId, landscapeId, versionId])
      }
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
  })
  afterEach(() => { restoreRegistration(); vi.restoreAllMocks() })

  it('flag OFF: the pass rolls nothing, and with no modelEpochs dep there is no epoch outcome at all', async () => {
    const ws = await workspace(storageRepo())
    const projector = projectorFleet(ws)
    await projector.start()
    try {
      await acknowledged()
      const without = await runWorkspaceCompaction(WS, deps(ws, projector.fleet))
      expect(without.result.skippedReason).toBeUndefined()
      expect(without.epoch).toBeUndefined()
      await acknowledged()
      const off = await runWorkspaceCompaction(WS, deps(ws, projector.fleet, { modelEpochs: epochsOn({ config: modelEpochConfig({}) }) }))
      expect(off.epoch).toBeUndefined() // the step is not even called when disabled
      expect(await epochRows()).toEqual([])
      expect((ws.root.doc() as Meta).modelMetaUrl).toBe(ws.meta.url)
    } finally {
      projector.stop()
    }
  })

  it('flag ON: epoch 1 is rolled, the root names a scalar-native meta, the re-attached read model serves the same objects; the next pass is not due', async () => {
    const ws = await workspace(storageRepo())
    const projector = projectorFleet(ws)
    await projector.start()
    try {
      await acknowledged()
      const before = await roNames()
      expect(before.map(([id]) => id)).toEqual(['b', 'c', 'h'])
      const outcome = await runWorkspaceCompaction(WS, deps(ws, projector.fleet, { modelEpochs: epochsOn() }))
      expect(outcome.result.skippedReason).toBeUndefined()
      expect(outcome.reattach).toBe('reattached')
      expect(outcome.epoch).toMatchObject({ outcome: 'rolled', epochNo: 1, kind: 'full' })
      expect(await epochRows()).toEqual([
        { epoch_no: 0, state: 'retained', kind: 'legacy' },
        { epoch_no: 1, state: 'published', kind: 'full' },
      ])
      const newMetaUrl = (ws.root.doc() as Meta).modelMetaUrl as string
      expect(newMetaUrl).not.toBe(ws.meta.url)
      const newMeta = (await ws.repo.find<Meta>(newMetaUrl as AutomergeUrl)).doc()
      expect(metaUrlsAreScalar(newMeta)).toBe(true)
      expect(A.getAllChanges(newMeta as A.Doc<unknown>)).toHaveLength(1)
      // The base shard is a fresh, claimed, DURABLE document; the overlay
      // segments are the same documents.
      const objects = readMetaUrls(newMeta, 'objectShardUrls')!
      expect(objects[1]).toBe(ws.head.url)
      expect(objects[0]).not.toBe(ws.base.url)
      const newBase = await ws.repo.find<{ objects: Record<string, Entity> }>(objects[0] as AutomergeUrl)
      expect(A.getAllChanges(newBase.doc() as A.Doc<unknown>)).toHaveLength(1)
      const id = objects[0]!.replace('automerge:', '')
      expect(await storageDurableHeads(db.pool, id)).toEqual([...A.getHeads(newBase.doc() as A.Doc<unknown>)])
      const { rows: claims } = await db.pool.query('SELECT 1 FROM automerge_document_workspace WHERE document_id = $1', [id])
      expect(claims).toHaveLength(1)
      // The re-attached projector serves the same objects from the new epoch.
      await acknowledged()
      expect(await roNames()).toEqual(before)
      // The predecessor carries the successor hint.
      expect(String(((ws.meta.doc() as Meta).epochSuccessorRef as { val: string }).val)).toBe(newMetaUrl)
      // Not due again for 30 days.
      await acknowledged()
      const next = await runWorkspaceCompaction(WS, deps(ws, projector.fleet, { modelEpochs: epochsOn() }))
      expect(next.epoch).toMatchObject({ outcome: 'not_due' })
      expect((ws.root.doc() as Meta).modelMetaUrl).toBe(newMetaUrl)
    } finally {
      projector.stop()
    }
  })

  it('an attempt left IN FLIGHT is recovered on the next pass — before the due check, and with the flag OFF', async () => {
    const ws = await workspace(storageRepo())
    const projector = projectorFleet(ws)
    await projector.start()
    try {
      await acknowledged()
      const first = await runWorkspaceCompaction(WS, deps(ws, projector.fleet, { modelEpochs: epochsOn() }))
      expect(first.epoch).toMatchObject({ outcome: 'rolled', epochNo: 1 })
      // A dead attempt: epoch 2 `preparing` (a crash before S6a), NOT due.
      await db.pool.query(
        `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, cut_heads, instance_id)
         VALUES ($1, $2, 2, 'full', 'preparing', 1, '{}'::jsonb, 'dead-cell')`, [WS.landscapeId, WS.versionId])
      await acknowledged()
      const off = await runWorkspaceCompaction(WS, deps(ws, projector.fleet, {
        modelEpochs: epochsOn({ config: modelEpochConfig({}) }),
      }))
      expect(off.epoch).toEqual({ outcome: 'disabled' })
      expect(await epochRows()).toEqual([
        { epoch_no: 0, state: 'retained', kind: 'legacy' },
        { epoch_no: 1, state: 'published', kind: 'full' },
        { epoch_no: 2, state: 'abandoned', kind: 'full' },
      ])
    } finally {
      projector.stop()
    }
  })

  it('flag OFF and no epoch row: the pass issues no epoch statement beyond the one probe', async () => {
    const ws = await workspace(storageRepo())
    const projector = projectorFleet(ws)
    await projector.start()
    try {
      await acknowledged()
      const seen: string[] = []
      const recorded = new Proxy(db.pool, {
        get(target, property) {
          if (property === 'query') {
            return (sql: unknown, values?: unknown[]) => { if (typeof sql === 'string') seen.push(sql); return (target.query as (s: unknown, v?: unknown[]) => Promise<unknown>).call(target, sql, values) }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as unknown as IsolatedSchemaDb['pool']
      const outcome = await runWorkspaceCompaction(WS, deps(ws, projector.fleet, {
        db: recorded, modelEpochs: epochsOn({ config: modelEpochConfig({}) }),
      }))
      expect(outcome.epoch).toBeUndefined()
      const epochStatements = seen.filter((sql) => /read_model_model_epoch/.test(sql))
      expect(epochStatements).toHaveLength(2) // the to_regclass probe and the EXISTS
      expect(epochStatements.every((sql) => /to_regclass|EXISTS/.test(sql))).toBe(true)
    } finally {
      projector.stop()
    }
  })

  it('the META-ONLY job rolls a meta epoch that CARRIES the base shards, under both rotation keys; flag off and no row: nothing', async () => {
    const ws = await workspace(storageRepo())
    const projector = projectorFleet(ws)
    await projector.start()
    try {
      await acknowledged()
      const job = (over: Partial<NonNullable<WorkspaceCompactionDeps['modelEpochs']>> = {}) => runModelEpochMetaJob(WS, {
        repo: ws.repo, rootUrl: ws.root.url, db: db.pool, connect: () => db.pool.connect(), fleet: projector.fleet,
        ownership: { owns: () => true }, isShuttingDown: () => false, modelEpochs: epochsOn(over),
      })
      expect(await job({ config: modelEpochConfig({}) })).toEqual({ outcome: 'no_epoch_rows' })
      expect(await epochRows()).toEqual([])
      const outcome = await job()
      expect(outcome).toMatchObject({ outcome: 'rolled', epochNo: 1, kind: 'meta' })
      expect(await epochRows()).toEqual([
        { epoch_no: 0, state: 'retained', kind: 'legacy' },
        { epoch_no: 1, state: 'published', kind: 'meta' },
      ])
      const newMeta = (await ws.repo.find<Meta>((ws.root.doc() as Meta).modelMetaUrl as AutomergeUrl)).doc()
      expect(metaUrlsAreScalar(newMeta)).toBe(true)
      expect(readMetaUrls(newMeta, 'objectShardUrls')![0]).toBe(ws.base.url) // carried, never rebuilt
      // S9 is due after a meta-only roll, and the
      // PERIODIC sweep (which now walks the meta-only workspaces) retires the
      // superseded meta — nothing else would since the event-driven pass is
      // forward-only.
      expect(epochRolledOrRecovered(outcome)).toBe(true)
      const swept = await sweepModelEpochs(WS, {
        repo: ws.repo, db: db.pool, connect: () => db.pool.connect(),
        residentProjectorInstanceId: (k) => projector.fleet.residentProjectorInstanceId(k), owns: () => true,
        isShuttingDown: () => false, instanceId: 'cell-a', retire: { retain: 0, periodDays: 30 },
      })
      expect(swept).toMatchObject({ outcome: 'swept' })
      expect((swept as { retired: { retiring?: string[] } }).retired.retiring).toContain(String(ws.meta.documentId))
      // Contended rotation key: refused, nothing rolled.
      const client = await db.pool.connect()
      try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object')])
        expect(await job()).toEqual({ outcome: 'overlay_rotation_lock_contended' })
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object')])
        client.release()
      }
    } finally {
      projector.stop()
    }
  })

  it('the lifecycle lock held by another door: nothing rolls, the fold stands', async () => {
    const ws = await workspace(storageRepo())
    const projector = projectorFleet(ws)
    await projector.start()
    try {
      await acknowledged()
      const outcome = await runWorkspaceCompaction(WS, deps(ws, projector.fleet, {
        modelEpochs: epochsOn({ withLifecycleLock: async () => ({ granted: false }) }),
      }))
      expect(outcome.result.skippedReason).toBeUndefined()
      expect(outcome.epoch).toEqual({ outcome: 'lifecycle_lock_contended' })
      expect(await epochRows()).toEqual([])
      expect((ws.root.doc() as Meta).modelMetaUrl).toBe(ws.meta.url)
    } finally {
      projector.stop()
    }
  })

  it('LOCK ORDER on the real statement stream: model-epoch: taken and given back, no projection mutex under any key, no unknown key', async () => {
    const ws = await workspace(storageRepo())
    type Call = { sql: string; params: readonly unknown[]; pass: boolean }
    const calls: Call[] = []
    let recording = false
    const record = (sql: unknown, params?: unknown[]) => {
      if (!recording || typeof sql !== 'string') return
      const limit = Error.stackTraceLimit
      Error.stackTraceLimit = 200
      const stack = new Error().stack ?? ''
      Error.stackTraceLimit = limit
      calls.push({ sql, params: params ?? [], pass: stack.includes('runWorkspaceCompaction') })
    }
    const recorded = new Proxy(db.pool, {
      get(target, property) {
        if (property === 'query') {
          return (sql: unknown, values?: unknown[]) => { record(sql, values); return (target.query as (s: unknown, v?: unknown[]) => Promise<unknown>).call(target, sql, values) }
        }
        if (property === 'connect') {
          return async () => {
            const client = await target.connect()
            return new Proxy(client, {
              get(subject, name) {
                if (name === 'query') {
                  return (sql: unknown, values?: unknown[]) => { record(sql, values); return (subject.query as (s: unknown, v?: unknown[]) => Promise<unknown>).call(subject, sql, values) }
                }
                const value = Reflect.get(subject, name, subject)
                return typeof value === 'function' ? value.bind(subject) : value
              },
            })
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as unknown as IsolatedSchemaDb['pool']
    const projector = projectorFleet(ws)
    await projector.start()
    try {
      await acknowledged()
      recording = true
      const outcome = await runWorkspaceCompaction(WS, deps(ws, projector.fleet, {
        db: recorded, connect: () => recorded.connect(), modelEpochs: epochsOn({
          // The lifecycle lock through the recorded pool too: the
          // rotation→lifecycle edge is in the stream.
          withLifecycleLock: async (critical) => {
            const locked = await withLifecycleApplyLock(recorded, WS, () => critical())
            return locked.granted ? { granted: true, value: locked.value } : { granted: false }
          },
        }),
      }))
      recording = false
      expect(outcome.epoch).toMatchObject({ outcome: 'rolled' })
    } finally {
      recording = false
      projector.stop()
    }
    const own = calls.filter((call) => call.pass)
    const epochKey = modelEpochLockKey(WS.landscapeId, WS.versionId)
    expect(own.some((c) => c.sql.includes('pg_try_advisory_lock(') && c.params[0] === epochKey)).toBe(true)
    expect(own.some((c) => c.sql.includes('pg_advisory_unlock(') && c.params[0] === epochKey)).toBe(true)
    expect(own.some((c) => c.sql.includes('INSERT INTO read_model_model_epochs'))).toBe(true)
    const tuples = own.map((c) => [c.sql, c.params] as const)
    expect(projectionLockOrderViolations(tuples)).toEqual([])
    expect(projectionInboundEdges(own)).toEqual([])
    expect(unknownAdvisoryKeys(own)).toEqual([])
    // The edge exists on the real stream, and it is a TRY: against a
    // promotion's lifecycle→rotation order, mutual refusal, never a cycle.
    const edges = lifecycleRotationEdges(own)
    expect(edges.edges).toContainEqual({ direction: 'rotation→lifecycle', form: 'try' })
    expect(edges.violations).toEqual([])
  })

  it('the lifecycle → rotation order (a promotion\'s): with the rotation keys held by a pass, the door\'s bounded wait refuses, and the pass\'s try refuses the other way', async () => {
    const ws = await workspace(storageRepo())
    const projector = projectorFleet(ws)
    await projector.start()
    try {
      await acknowledged()
      // The door: holds the lifecycle lock, then WAITS (bounded) for the
      // object rotation key — while a compaction pass holds it.
      let doorOutcome: string | null = null
      const pass = runWorkspaceCompaction(WS, deps(ws, projector.fleet, {
        modelEpochs: epochsOn({
          withLifecycleLock: async (critical) => {
            // Inside the pass, the rotation keys held: a door takes the
            // lifecycle lock first and asks for the rotation key, as a
            // promotion's publish does, under its lock_timeout ceiling.
            const door = await withLifecycleApplyLock(db.pool, WS, async () => {
              const client = await db.pool.connect()
              try {
                await client.query('BEGIN')
                await client.query("SET LOCAL lock_timeout = '300ms'")
                await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object')])
                await client.query('COMMIT')
                return 'acquired'
              } catch (error) {
                await client.query('ROLLBACK').catch(() => undefined)
                return (error as { code?: string }).code === '55P03' ? 'refused-lock-timeout' : `error ${String(error)}`
              } finally {
                client.release()
              }
            })
            doorOutcome = door.granted ? door.value : 'door-not-granted'
            // …and the pass's own try on the lifecycle lock, while the door
            // holds it, is refused at once.
            const held = await withLifecycleApplyLock(db.pool, WS, async () =>
              withLifecycleApplyLock(db.pool, WS, critical))
            return held.granted && held.value.granted ? { granted: true, value: held.value.value } : { granted: false }
          },
        }),
      }))
      const outcome = await pass
      expect(doorOutcome).toBe('refused-lock-timeout')
      expect(outcome.epoch).toEqual({ outcome: 'lifecycle_lock_contended' })
      expect(outcome.result.skippedReason).toBeUndefined() // the fold stands
    } finally {
      projector.stop()
    }
  })

  it('the first-roll spread: a never-rolled workspace is due on its own day only', async () => {
    const day = firstRollDate(WS, 30)
    expect(firstRollDue(WS, 30, day)).toBe(true)
    expect(firstRollDue(WS, 30, new Date(day.getTime() + 86_400_000))).toBe(false)
    // On the real pass: the day after its slot, flag ON, nothing rolls.
    const ws = await workspace(storageRepo())
    const projector = projectorFleet(ws)
    await projector.start()
    try {
      await acknowledged()
      const outcome = await runWorkspaceCompaction(WS, deps(ws, projector.fleet, {
        modelEpochs: epochsOn({ now: () => new Date(day.getTime() + 86_400_000) }),
      }))
      expect(outcome.epoch).toMatchObject({ outcome: 'first_roll_not_due' })
      expect(await epochRows()).toEqual([])
    } finally {
      projector.stop()
    }
  })

  it('R4-d: a repoint by ANY writer makes the running projector ask to be recycled, once', async () => {
    const ws = await workspace(storageRepo())
    const projector = projectorFleet(ws)
    await projector.start()
    try {
      await acknowledged()
      // A script-shaped repoint (`slim-performance-model-meta.ts`): a new
      // meta, claimed, then the root's pointer moved — no epoch row at all.
      const copy = buildEpochMeta<Meta>(ws.meta.doc() as A.Doc<unknown>, A.getHeads(ws.meta.doc() as A.Doc<unknown>), {
        epoch: 1, predecessorUrl: ws.meta.url, baseShardUrl: (url) => url,
      })
      const created = await createClaimedDocumentFromBinary<Meta>(ws.repo, WS, ws.root.url, A.save(copy))
      ws.root.change((r) => { r.modelMetaUrl = created.url })
      expect(await until(() => projector.counts.repointed, (n) => n >= 1)).toBe(1)
      // A second change to the root does not report again.
      ws.root.change((r) => { r.unrelated = 'x' })
      await settle(300)
      expect(projector.counts.repointed).toBe(1)
    } finally {
      projector.stop()
    }
  })

  it('R4-d: a repoint that arrives by SYNC from another Repo is reported too', async () => {
    const repoA = storageRepo()
    const ws = await workspace(repoA)
    const projector = projectorFleet(ws)
    await projector.start()
    try {
      await acknowledged()
      // A second Repo (another process) writes the root; repo A receives it as
      // a merged change on the same handle — the projector's root handler runs.
      const remote = A.change(A.clone(ws.root.doc() as A.Doc<Meta>), (r) => { r.modelMetaUrl = ws.head.url })
      ws.root.update((local) => A.merge(local, A.clone(remote)))
      expect(await until(() => projector.counts.repointed, (n) => n >= 1)).toBe(1)
    } finally {
      projector.stop()
    }
  })

  /** A projector with ROTATION on (threshold 4 changes), its fleet's hook a
   * counter only — so it stays attached to the superseded meta. */
  function rotatingProjector(ws: World) {
    let stop: (() => void) | null = null
    const counts = { repointed: 0 }
    return {
      counts,
      start: async () => {
        stop = await startReadModelProjector(
          ws.repo, ws.root.url, db.pool, WS, undefined, 0, undefined, undefined, undefined, undefined,
          { mode: 'on', allowlist: new Set([`${WS.landscapeId}/${WS.versionId}`]), maxActors: 1_000_000, maxChanges: 4 },
          { onModelMetaRepointed: () => { counts.repointed += 1 } },
        )
      },
      stop: () => { stop?.(); stop = null },
    }
  }
  const fillHead = async (ws: World) => {
    for (let i = 0; A.stats(ws.head.doc() as A.Doc<unknown>).numChanges < 6; i += 1) {
      ws.head.change((d) => { (d as { objects: Record<string, Entity> }).objects[`r${i}`] = { id: `r${i}`, name: `r${i}`, type: 'system' } })
    }
  }

  it('the rotator does not write a SUPERSEDED meta (metaIsCurrent), and rotates without the repoint (control)', async () => {
    // Control: no repoint, the head crosses the threshold and is rotated.
    {
      const ws = await workspace(storageRepo())
      const projector = rotatingProjector(ws)
      await projector.start()
      try {
        await acknowledged()
        await fillHead(ws)
        const moved = await until(() => (ws.meta.doc() as Meta).editsObjectShardUrl, (url) => url !== ws.head.url, 20_000)
        expect(moved).not.toBe(ws.head.url)
      } finally { projector.stop() }
    }
    // Repointed first: the projector still holds the old meta and must not rotate into it.
    const ws = await workspace(storageRepo())
    const projector = rotatingProjector(ws)
    await projector.start()
    try {
      await acknowledged()
      const copy = buildEpochMeta<Meta>(ws.meta.doc() as A.Doc<unknown>, A.getHeads(ws.meta.doc() as A.Doc<unknown>), {
        epoch: 1, predecessorUrl: ws.meta.url, baseShardUrl: (url) => url,
      })
      const created = await createClaimedDocumentFromBinary<Meta>(ws.repo, WS, ws.root.url, A.save(copy))
      ws.root.change((r) => { r.modelMetaUrl = created.url })
      await until(() => projector.counts.repointed, (n) => n >= 1)
      const metaHeads = [...A.getHeads(ws.meta.doc() as A.Doc<unknown>)]
      await fillHead(ws)
      await settle(6_000)
      expect((ws.meta.doc() as Meta).editsObjectShardUrl).toBe(ws.head.url)
      expect([...A.getHeads(ws.meta.doc() as A.Doc<unknown>)]).toEqual(metaHeads)
    } finally { projector.stop() }
  }, 60_000)

  it('a compaction-pass roll does NOT report a repoint: the projector is detached across it and re-attaches on the new root', async () => {
    const ws = await workspace(storageRepo())
    const projector = projectorFleet(ws)
    await projector.start()
    try {
      await acknowledged()
      const outcome = await runWorkspaceCompaction(WS, deps(ws, projector.fleet, { modelEpochs: epochsOn() }))
      expect(outcome.epoch).toMatchObject({ outcome: 'rolled' })
      await acknowledged()
      await settle(300)
      expect(projector.counts.repointed).toBe(0)
    } finally {
      projector.stop()
    }
  })
})

// Exported for the type-checker only: keeps `DocHandle` referenced if the file is trimmed.
export type _Handle = DocHandle<unknown>
