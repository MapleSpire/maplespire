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

import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createProcessExclusion } from '../maintenance/processExclusion.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import * as A from '@automerge/automerge'
import { Repo, generateAutomergeUrl, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { acknowledgeDurableHeads, currentEpochForwardTargets } from '../durableHeads.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { withLifecycleApplyLock } from '../maintenance/lifecycleApplyLock.js'
import { readMetaUrl, readMetaUrls } from '../modelMetaUrls.js'
import { ensureReadModelSchema } from './schema.js'
import { startReadModelProjector } from './projectorService.js'
import { readProjectionAcknowledgement } from './compaction.js'
import { runWorkspaceCompaction, type WorkspaceCompactionDeps } from './workspaceCompaction.js'
import { modelEpochConfig } from './modelEpochConfig.js'
import { fencedOn, firstRollDate } from './modelEpochStep.js'
import { forwardModelEpochLateWrites, purgeForwardWrites, type ForwarderDeps } from './modelEpochForwarder.js'
import { modelEpochForwardPending, modelEpochGcRoots, sqlEpochRowStore } from './modelEpochStore.js'
import { sweepModelEpochs } from './modelEpochSweep.js'
import { requestLateRetiringRevival, reviveRequestedRetiring } from './modelEpochRetire.js'
import { maintenanceFollowUpSweepOptions, TRIGGERED_SWEEP, triggeredSweepOptions } from './modelEpochForwardWiring.js'
import { listOverridesForActors, overrideActorsOfUser, parseResolveRequest, resolveOverrides } from './modelEpochOverrides.js'
import { discardQuarantinedForward, listQuarantinedForwards, readDiscardExport, releaseQuarantinedForward } from './modelEpochQuarantine.js'
import { forwardMessage } from '../modelEpochForward.js'
import type { FencedTransaction } from './modelEpochStore.js'
import type { OrdinaryHeadRotationConfig } from './ordinaryHeadRotation.js'
import { overlayRotationLockKey } from './overlayRotationLock.js'
import { modelEpochRotationEdges, projectionInboundEdges, unknownAdvisoryKeys } from './lockEdgeScan.js'
import type { WorkspaceKey } from './projector.js'

/**
 * G4-16f — THE EPOCH FORWARDER against real PostgreSQL storage and a
 * real projector: Marie's offline edits land on the SUPERSEDED epoch's base
 * shard and ModelMeta after a real roll, and are carried into the current
 * epoch, where the read model serves them.
 *
 *  - a base-shard field edit, a list insert and a created entity → the current
 *    base shard; an edit of an entity the current epoch serves from its write
 *    head → the head (design O1);
 *  - a ModelMeta group and a browser's overflow shard → the current meta (the
 *    shard ADOPTED);
 *  - the server's own S8 change only → the cursor advances (R3-2);
 *  - a crash between two targets: the journal stays open, GC keeps what it
 *    names, compaction refuses (R4-a), the replay applies each target ONCE;
 *  - the lease (R4-b): an open journal of a live owner is left alone;
 *  - THE GATE: a write head the journal recorded is
 *    ROTATED before the replay; the replay writes the retired head and the
 *    REAL ordinary head forwarder carries it into the new head.
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-epoch-fwd', versionId: 'v1' }
let db: IsolatedSchemaDb

type Entity = { id: string; [field: string]: unknown }
type Meta = Record<string, unknown>
type Shard = { objects: Record<string, Entity> }

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
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
const claim = (documentId: string) => db.pool.query(
  'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
  [documentId, WS.landscapeId, WS.versionId])

const ROTATION: OrdinaryHeadRotationConfig = {
  mode: 'on', allowlist: new Set([`${WS.landscapeId}/${WS.versionId}`]), maxActors: 1_000_000, maxChanges: 4,
}

async function workspace(repo: Repo) {
  const base = repo.create<Shard>({
    objects: {
      b: { id: 'b', name: 'Base B', type: 'system' },
      c: { id: 'c', name: 'Base C', type: 'system', tags: ['x'], stats: { s: 1 } },
    },
  })
  // `h` is an overlay entity; the roll's compaction folds it into the base
  // and starts a fresh head.
  const head = repo.create({ objects: { h: { id: 'h', name: 'Head H', type: 'system' } }, writeBatchIds: [] })
  const connHead = repo.create({ connections: {}, writeBatchIds: [] })
  const meta = repo.create<Meta>({
    objectShardUrls: [base.url, head.url], connectionShardUrls: [connHead.url],
    editsObjectShardUrl: head.url, editsObjectShardUrls: [head.url],
    editsConnectionShardUrl: connHead.url, editsConnectionShardUrls: [connHead.url],
    groups: { g0: { id: 'g0', name: 'G0' } },
  })
  const registry = repo.create({ diagrams: {} })
  const root = repo.create<Meta>({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
  const handles = [base, head, connHead, meta, registry, root]
  await Promise.all(handles.map((h) => h.whenReady()))
  await repo.flush()
  for (const handle of handles) await claim(String(handle.documentId))
  // MARIE goes offline NOW: her replicas of the base shard and the meta.
  const marieBase = A.clone(base.doc() as A.Doc<Shard>, { actor: 'aa'.repeat(16) })
  const marieMeta = A.clone(meta.doc() as A.Doc<Meta>, { actor: 'aa'.repeat(16) })
  return { repo, root, meta, base, head, marieBase, marieMeta }
}
type World = Awaited<ReturnType<typeof workspace>>

function projectorFleet(ws: World, rotation?: OrdinaryHeadRotationConfig) {
  let instance: string | null = null
  let stop: (() => void) | null = null
  const startOne = async () => {
    stop = await startReadModelProjector(ws.repo, ws.root.url, db.pool, WS, undefined, 0, undefined, undefined, undefined,
      (id) => { instance = id }, rotation)
  }
  const fleet: WorkspaceCompactionDeps['fleet'] = {
    isResident: () => stop !== null,
    ensure: async () => { if (!stop) await startOne(); return true },
    release: () => { stop?.(); stop = null },
    residentProjectorInstanceId: () => instance,
  }
  return { fleet, instance: () => instance, start: startOne, stop: () => { stop?.(); stop = null } }
}

const modelEpochs = (): NonNullable<WorkspaceCompactionDeps['modelEpochs']> => ({
  config: modelEpochConfig({ AM_MODEL_EPOCHS: 'on' }),
  instanceId: 'cell-a',
  now: () => firstRollDate(WS, 30),
  withLifecycleLock: async (critical) => {
    const locked = await withLifecycleApplyLock(db.pool, WS, () => critical())
    return locked.granted ? { granted: true, value: locked.value } : { granted: false }
  },
})
const passDeps = (ws: World, fleet: WorkspaceCompactionDeps['fleet']): WorkspaceCompactionDeps => ({
  repo: ws.repo, rootUrl: ws.root.url, db: db.pool, fleet, connect: () => db.pool.connect(),
  ownership: { owns: () => true }, isShuttingDown: () => false, log: () => {}, warn: () => {},
  modelEpochs: modelEpochs(),
} as WorkspaceCompactionDeps)

const acknowledged = () => until(() => readProjectionAcknowledgement(db.pool, WS), (ack) => ack.acknowledged)
const roData = async (id: string) => (await db.pool.query<{ data: Record<string, unknown> }>(
  'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3', [WS.landscapeId, WS.versionId, id],
)).rows[0]?.data
const roName = async (id: string) => (await db.pool.query<{ data: { name?: string } }>(
  'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3', [WS.landscapeId, WS.versionId, id],
)).rows[0]?.data.name

/** The forwarder's deps, its fenced transactions on a pooled client. */
async function forwarder(ws: World, fenceHolder: string | null, over: Partial<ForwarderDeps> = {}) {
  const client = await db.pool.connect()
  const deps: ForwarderDeps = {
    repo: ws.repo, key: WS, db: db.pool, connect: () => db.pool.connect(),
    fenced: fencedOn(client, WS, fenceHolder), instanceId: 'cell-a', mayWrite: () => true,
    ...over,
  }
  return { run: () => forwardModelEpochLateWrites(deps), release: () => client.release() }
}

/** Marie's offline session arrives on the OLD epoch's documents (a sync merge). */
function marieSyncs(ws: World, base: (d: Shard) => void, meta?: (m: Meta) => void) {
  const nextBase = A.change(ws.marieBase, base)
  ws.base.update((local) => A.merge(local, A.clone(nextBase)))
  if (meta) {
    const nextMeta = A.change(ws.marieMeta, meta)
    ws.meta.update((local) => A.merge(local, A.clone(nextMeta)))
  }
}

async function rolled(ws: World, rotation?: OrdinaryHeadRotationConfig) {
  const projector = projectorFleet(ws, rotation)
  await projector.start()
  await acknowledged()
  const outcome = await runWorkspaceCompaction(WS, passDeps(ws, projector.fleet))
  expect(outcome.epoch).toMatchObject({ outcome: 'rolled', epochNo: 1 })
  await acknowledged()
  const metaUrl = (ws.root.doc() as Meta).modelMetaUrl as string
  const currentMeta = await ws.repo.find<Meta>(metaUrl as AutomergeUrl)
  const currentBase = await ws.repo.find<Shard>(readMetaUrls(currentMeta.doc(), 'objectShardUrls')![0] as AutomergeUrl)
  return { projector, currentMeta, currentBase }
}

/** CARL, after the roll, edits `b` in the CURRENT write head (another field):
 * the current epoch now serves `b` from an overlay — Marie's `b` edit must go
 * to that head (design O1), where Carl's name is still the late writer's base. */
async function carlEditsBInTheHead(ws: World, currentMeta: DocHandle<Meta>): Promise<DocHandle<Shard>> {
  const headUrl = readMetaUrl(currentMeta.doc(), 'editsObjectShardUrl')!
  const head = await ws.repo.find<Shard>(headUrl as AutomergeUrl)
  head.change((d) => { d.objects.b = { id: 'b', name: 'Base B', type: 'container' } })
  await ws.repo.flush([head.documentId])
  return head
}

const cursorOf = async (documentId: string) => (await db.pool.query<{ forward_cursor: string[]; last_late_write_at: Date | null }>(
  'SELECT forward_cursor, last_late_write_at FROM read_model_model_epoch_docs WHERE document_id = $1', [documentId])).rows[0]
/** Run `fn` with a write-fenced transaction runner on a pooled client. */
async function withFence<T>(fenceHolder: string | null, fn: (fenced: FencedTransaction) => Promise<T>): Promise<T> {
  const client = await db.pool.connect()
  try { return await fn(fencedOn(client, WS, fenceHolder)) } finally { client.release() }
}
const journals = async () => (await db.pool.query<{ id: string; parts: unknown[] }>('SELECT id, parts FROM read_model_model_epoch_forwards')).rows

suite('the epoch forwarder (G4-16f)', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'model_epoch_forwarder')
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query(`CREATE TABLE automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query(`CREATE TABLE scopes (kind TEXT, landscape_id TEXT, version_id TEXT, org_id TEXT)`)
    await db.pool.query(`CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL)`)
    await db.pool.query(`CREATE TABLE versions (id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, label TEXT NOT NULL, root_url TEXT NOT NULL)`)
    await db.pool.query(`INSERT INTO landscapes VALUES ('ls-epoch-fwd', 'f')`)
    await db.pool.query(`INSERT INTO versions VALUES ('v1', 'ls-epoch-fwd', 'v', 'automerge:root')`)
  })
  afterAll(async () => { await settle(500); await db?.teardown() })
  let restoreRegistration: () => void = () => {}
  beforeEach(async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.pool.query(`TRUNCATE automerge_storage, automerge_document_workspace, ro_objects, ro_connections, ro_groups,
          read_model_projection_state, read_model_change_events, read_model_overlay_batch_acks,
          read_model_overlay_entity_bases, read_model_ordinary_head_retirements, read_model_document_watermarks,
          read_model_ordinary_chain_folds, read_model_model_epochs, read_model_model_epoch_docs, read_model_model_epoch_forwards,
          read_model_model_epoch_forward_writes, read_model_model_epoch_overrides, read_model_model_epoch_discards`)
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
  afterEach(() => { restoreRegistration() })

  it('Marie: base edits, a list insert and a create go to the current base shard; a head-served entity to the head; the read model serves them', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase, currentMeta } = await rolled(ws)
    const head = await carlEditsBInTheHead(ws, currentMeta)
    const f = await forwarder(ws, projector.instance())
    try {
      marieSyncs(ws, (d) => {
        d.objects.c!.name = 'Marie C'
        ;(d.objects.c!.tags as string[]).push('marie')
        d.objects.m = { id: 'm', name: 'Marie M', type: 'system' }
        d.objects.b!.name = 'Marie B' // `b` is served from the write head
      })
      const report = await f.run()
      expect(report).toMatchObject({ outcome: 'ran' })
      const base = currentBase.doc()!.objects
      expect(base.c!.name).toBe('Marie C')
      expect([...(base.c!.tags as string[])]).toEqual(['x', 'marie'])
      expect(base.m!.name).toBe('Marie M')
      // `b` went to the head that serves it: Marie's name, Carl's type.
      expect(head.doc()!.objects.b).toMatchObject({ name: 'Marie B', type: 'container' })
      expect(base.b!.name).toBe('Base B')
      // The cursor moved to the planned `to`; no journal is left.
      const cursor = await cursorOf(String(ws.base.documentId))
      expect([...cursor!.forward_cursor].sort()).toEqual([...A.getHeads(ws.base.doc() as A.Doc<unknown>)].sort())
      expect(cursor!.last_late_write_at).not.toBeNull()
      expect(await journals()).toEqual([])
      // The read model serves Marie's values.
      expect(await until(() => roName('c'), (n) => n === 'Marie C')).toBe('Marie C')
      expect(await until(() => roName('m'), (n) => n === 'Marie M')).toBe('Marie M')
      expect(await until(() => roName('b'), (n) => n === 'Marie B')).toBe('Marie B')
      // A second run has nothing to do.
      const before = [...A.getHeads(currentBase.doc() as A.Doc<unknown>)]
      await f.run()
      expect([...A.getHeads(currentBase.doc() as A.Doc<unknown>)]).toEqual(before)
    } finally { f.release(); projector.stop() }
  })

  it('Marie on the META: a group is forwarded, a browser overflow shard is ADOPTED; the server-only S8 change just advances', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentMeta } = await rolled(ws)
    const f = await forwarder(ws, projector.instance())
    try {
      const first = await f.run()
      // After the roll, the old meta's only post-cut change is S8: advanced.
      expect(first).toMatchObject({ outcome: 'ran' })
      expect((first as { sources: Array<{ documentId: string; outcome: string }> }).sources
        .find((s) => s.documentId === String(ws.meta.documentId))!.outcome).toBe('advanced')
      const overflow = ws.repo.create<Shard>({ objects: { o: { id: 'o', name: 'Overflow', type: 'system' } } })
      await overflow.whenReady()
      await ws.repo.flush([overflow.documentId])
      await claim(String(overflow.documentId))
      marieSyncs(ws, () => {}, (m) => {
        ;(m.groups as Record<string, unknown>).g1 = { id: 'g1', name: 'Marie G1' }
        ;(m.objectShardUrls as string[]).push(overflow.url)
      })
      await f.run()
      expect(((currentMeta.doc()!.groups as Record<string, { name: string }>).g1!).name).toBe('Marie G1')
      expect(readMetaUrls(currentMeta.doc(), 'objectShardUrls')).toContain(overflow.url)
      const { rows } = await db.pool.query<{ role: string }>('SELECT role FROM read_model_model_epoch_docs WHERE document_id = $1',
        [String(overflow.documentId)])
      expect(rows[0]?.role).toBe('adopted')
      expect(await until(() => roName('o'), (n) => n === 'Overflow')).toBe('Overflow')
    } finally { f.release(); projector.stop() }
  })

  it('a crash between two targets: the journal stays, GC keeps it, compaction refuses, the replay applies each target ONCE', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase, currentMeta } = await rolled(ws)
    const head = await carlEditsBInTheHead(ws, currentMeta)
    let crashes = 1
    // The crash comes right after the BASE target — the one carrying the
    // LIST INSERT — whatever its place in the journal: a replay that wrote
    // it again (never skipping) would push 'once' twice.
    const f = await forwarder(ws, projector.instance(), {
      afterTargetWrite: (id) => { if (id === String(currentBase.documentId) && crashes-- > 0) throw new Error('crash after the first target') },
    })
    try {
      marieSyncs(ws, (d) => {
        ;(d.objects.c!.tags as string[]).push('once')
        d.objects.b!.name = 'Marie B' // the head: a second target
      })
      await expect(f.run()).rejects.toThrow('crash after the first target')
      const open = await journals()
      expect(open).toHaveLength(1)
      expect(open[0]!.parts).toHaveLength(2)
      // GC marks everything the open journal names.
      const roots = await modelEpochGcRoots(db.pool)
      expect(roots.urls).toContain(head.url)
      expect(roots.urls).toContain(currentBase.url)
      // The next compaction pass's own forwarder (same instance, so no lease
      // to wait for) REPLAYS the open journal before it folds: the written
      // target is found by its message and skipped, the other one written.
      // (The refusal on a journal it cannot finish is the next test.)
      //
      // THE PASS'S OWN GATE is the acknowledgement watermark, and it is only
      // meaningful once the projector has OBSERVED the writes this test made
      // — Carl's head edit and the crashed forward's base write. Waiting on
      // `acknowledged()` alone raced that observation (the flake: the
      // watermark was "acknowledged" one instant, the projector then saw the
      // base write and the pass refused with `projection_not_acknowledged`).
      // So: first the read model SERVES both writes (observed and projected),
      // then the watermark.
      expect(await until(() => roData('c'), (d) => Array.isArray(d?.tags) && (d!.tags as string[]).includes('once'))).toMatchObject({ tags: ['x', 'once'] })
      expect(await until(() => roData('b'), (d) => d?.type === 'container')).toMatchObject({ type: 'container' })
      expect((await acknowledged()).acknowledged).toBe(true)
      const pass = await runWorkspaceCompaction(WS, passDeps(ws, projector.fleet))
      expect(pass.result.skippedReason).toBeUndefined()
      expect(pass.forwarded).toMatchObject({ outcome: 'ran' })
      // The replay SKIPPED the written target: nothing was written twice, so
      // the dedupe sweep had nothing to compensate (a replay that wrote it
      // again would be caught there — this pins that it is not needed).
      expect((pass.forwarded as { dedupe?: unknown[] }).dedupe).toBeUndefined()
      expect(await journals()).toEqual([])
      // The pass then folded the head into the base: both edits are there, once.
      expect([...(currentBase.doc()!.objects.c!.tags as string[])].filter((t) => t === 'once')).toHaveLength(1)
      expect(currentBase.doc()!.objects.b).toMatchObject({ name: 'Marie B', type: 'container' })
      expect(await until(() => roName('b'), (n) => n === 'Marie B')).toBe('Marie B')
    } finally { f.release(); projector.stop() }
  })

  it('R4-a on the pass itself: an open journal another LIVE owner holds makes compaction refuse, nothing detached', async () => {
    const ws = await workspace(storageRepo())
    const { projector } = await rolled(ws)
    try {
      await db.pool.query(
        `INSERT INTO read_model_model_epoch_forwards (id, landscape_id, version_id, source_document_id, from_heads, to_heads, owner_instance)
         VALUES ('j-live', $1, $2, $3, '{}', '{}', 'cell-b')`, [WS.landscapeId, WS.versionId, String(ws.base.documentId)])
      const outcome = await runWorkspaceCompaction(WS, passDeps(ws, projector.fleet))
      expect(outcome.result.skippedReason).toBe('epoch_forward_pending')
      expect(outcome.reattach).toBe('not_detached')
      // The lease: the pass's forwarder left the live owner's journal alone.
      expect(outcome.forwarded).toMatchObject({ outcome: 'ran' })
      expect((outcome.forwarded as { sources: Array<{ outcome: string; documentId: string }> }).sources
        .find((s) => s.documentId === String(ws.base.documentId))!.outcome).toBe('leased-elsewhere')
    } finally { projector.stop() }
  })

  it('the lease (R4-b): a live owner\'s journal is left alone; an expired one is taken over and finished', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    const a = await forwarder(ws, projector.instance(), { beforeTargetWrite: () => { throw new Error('cell A dies') } })
    try {
      marieSyncs(ws, (d) => { d.objects.c!.name = 'Leased C' })
      await expect(a.run()).rejects.toThrow('cell A dies')
      expect(await journals()).toHaveLength(1)
      const b = await forwarder(ws, projector.instance(), { instanceId: 'cell-b' })
      try {
        const live = await b.run()
        expect((live as { sources: Array<{ outcome: string; documentId: string }> }).sources
          .find((s) => s.documentId === String(ws.base.documentId))!.outcome).toBe('leased-elsewhere')
        expect(currentBase.doc()!.objects.c!.name).toBe('Base C')
        const expired = await forwarder(ws, projector.instance(), { instanceId: 'cell-b', leaseMs: 0 })
        try {
          await expired.run()
          expect(currentBase.doc()!.objects.c!.name).toBe('Leased C')
          expect(await journals()).toEqual([])
        } finally { expired.release() }
      } finally { b.release() }
    } finally { a.release(); projector.stop() }
  })

  it('R3-1: a forwarder whose model-epoch session is reported dead writes nothing, and its journal is replayed later', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    const dead = await forwarder(ws, projector.instance(), {
      lock: { acquire: async () => 'acquired', release: async () => undefined, alive: () => false },
    })
    try {
      marieSyncs(ws, (d) => { d.objects.c!.name = 'Not yet' })
      await expect(dead.run()).rejects.toThrow(/model-epoch key or the write authority was lost/)
      expect(currentBase.doc()!.objects.c!.name).toBe('Base C')
      expect(await journals()).toHaveLength(1)
      const live = await forwarder(ws, projector.instance())
      try { await live.run() } finally { live.release() }
      expect(currentBase.doc()!.objects.c!.name).toBe('Not yet')
    } finally { dead.release(); projector.stop() }
  })

  it('THE GATE: the recorded head is ROTATED before the replay; the replay writes the retired head and the REAL ordinary forwarder carries it', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentMeta } = await rolled(ws, ROTATION)
    const head = await carlEditsBInTheHead(ws, currentMeta)
    const f = await forwarder(ws, projector.instance(), { beforeTargetWrite: () => { throw new Error('crash before the head write') } })
    try {
      // Only a head-served entity: the journal's one target is the write head.
      marieSyncs(ws, (d) => { d.objects.b!.name = 'Marie B late' })
      await expect(f.run()).rejects.toThrow('crash before the head write')
      const open = await journals()
      expect(open).toHaveLength(1)
      expect((open[0]!.parts as Array<{ documentId: string }>).map((p) => p.documentId)).toEqual([String(head.documentId)])
      // The head rotates: fill it past the threshold; the attached projector rotates it.
      for (let i = 0; A.stats(head.doc() as A.Doc<unknown>).numChanges < 6; i += 1) {
        head.change((d) => { d.objects[`r${i}`] = { id: `r${i}`, name: `r${i}`, type: 'system' } })
      }
      const newHead = await until(() => readMetaUrl(currentMeta.doc(), 'editsObjectShardUrl'), (u) => u !== head.url, 45_000)
      expect(newHead).not.toBe(head.url)
      const { rows: retired } = await db.pool.query<{ status: string }>(
        'SELECT status FROM read_model_ordinary_head_retirements WHERE document_id = $1', [String(head.documentId)])
      expect(retired[0]?.status).toBe('retired')
      // The replay writes the RECORDED (now retired) head...
      const replay = await forwarder(ws, projector.instance())
      try { await replay.run() } finally { replay.release() }
      expect(await journals()).toEqual([])
      expect(head.doc()!.objects.b!.name).toBe('Marie B late')
      // ...and the real ordinary forwarder carries it into the new head; the read model serves it.
      const carried = await ws.repo.find<Shard>(newHead as AutomergeUrl)
      expect(await until(() => carried.doc()?.objects.b?.name, (n) => n === 'Marie B late', 30_000)).toBe('Marie B late')
      expect(await until(() => roName('b'), (n) => n === 'Marie B late', 30_000)).toBe('Marie B late')
    } finally { f.release(); projector.stop() }
  }, 120_000)

  it('O1, served ELSEWHERE: an entity held only by an OLDER overlay segment goes to the head with the served value under the late edit', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentMeta } = await rolled(ws, ROTATION)
    const head = await carlEditsBInTheHead(ws, currentMeta)
    try {
      // The head rotates: `b` now lives only in the retired head, an older
      // segment of the current epoch; the new head does not hold it.
      for (let i = 0; A.stats(head.doc() as A.Doc<unknown>).numChanges < 6; i += 1) {
        head.change((d) => { d.objects[`r${i}`] = { id: `r${i}`, name: `r${i}`, type: 'system' } })
      }
      const newHeadUrl = await until(() => readMetaUrl(currentMeta.doc(), 'editsObjectShardUrl'), (u) => u !== head.url, 45_000)
      expect(newHeadUrl).not.toBe(head.url)
      expect(readMetaUrls(currentMeta.doc(), 'editsObjectShardUrls')).toContain(head.url)
      const newHead = await ws.repo.find<Shard>(newHeadUrl as AutomergeUrl)
      expect(newHead.doc()!.objects.b).toBeUndefined()
      marieSyncs(ws, (d) => { d.objects.b!.name = 'Marie B served' })
      const f = await forwarder(ws, projector.instance())
      try { await f.run() } finally { f.release() }
      // Not dropped as "entity-deleted": the served value (Carl's type) under
      // Marie's name, on the head.
      expect(newHead.doc()!.objects.b).toMatchObject({ name: 'Marie B served', type: 'container' })
      expect(await until(() => roName('b'), (n) => n === 'Marie B served', 30_000)).toBe('Marie B served')
    } finally { projector.stop() }
  }, 120_000)

  it('a DUPLICATE of a completed forward on its target is compensated once — the insert counts once', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    const f = await forwarder(ws, projector.instance())
    try {
      marieSyncs(ws, (d) => { ;(d.objects.c!.tags as string[]).push('dup') })
      await f.run()
      const { rows } = await db.pool.query<{ message: string; heads_before: string[] }>(
        'SELECT message, heads_before FROM read_model_model_epoch_forward_writes WHERE target_document_id = $1',
        [String(currentBase.documentId)])
      expect(rows).toHaveLength(1)
      // The duplicate: the same forward written again under the same message
      // (a change synced before flush then a crash; the R4-b window).
      currentBase.change((d) => { ;(d.objects.c!.tags as string[]).push('dup') }, { message: rows[0]!.message })
      expect([...(currentBase.doc()!.objects.c!.tags as string[])].filter((t) => t === 'dup')).toHaveLength(2)
      const swept = await f.run()
      expect((swept as { dedupe?: unknown[] }).dedupe).toHaveLength(1)
      expect([...(currentBase.doc()!.objects.c!.tags as string[])].filter((t) => t === 'dup')).toHaveLength(1)
      // Once: a second sweep compensates nothing more.
      const again = await f.run()
      expect((again as { dedupe?: unknown[] }).dedupe).toBeUndefined()
      expect([...(currentBase.doc()!.objects.c!.tags as string[])].filter((t) => t === 'dup')).toHaveLength(1)
    } finally { f.release(); projector.stop() }
  })

  it('a POISONED journal is quarantined with an alert, stops blocking the fold, and the operator releases or discards it', async () => {
    const ws = await workspace(storageRepo())
    const { projector } = await rolled(ws)
    const log: Array<Record<string, unknown>> = []
    const f = await forwarder(ws, projector.instance(), {
      quarantineAfterAttempts: 2, quarantineMinAgeMs: 0, findTimeoutMs: 2_000, log: (e) => log.push(e),
    })
    try {
      // A journal naming a target that never resolves: a deterministic throw.
      const cursor = (await cursorOf(String(ws.base.documentId)))!.forward_cursor
      const missing = generateAutomergeUrl().slice('automerge:'.length)
      await db.pool.query(
        `INSERT INTO read_model_model_epoch_forwards (id, landscape_id, version_id, source_document_id, from_heads, to_heads, parts, owner_instance)
         VALUES ('j-poison', $1, $2, $3, $4::text[], $4::text[], $5::jsonb, 'cell-a')`,
        [WS.landscapeId, WS.versionId, String(ws.base.documentId), cursor,
          JSON.stringify([{ documentId: missing, paths: [], aligned: false, plannedInserts: [], adoptUrls: [] }])])
      const first = await f.run()
      expect(sourceOutcome(first, ws)).toBe('failed')
      expect(await modelEpochForwardPending(db.pool, WS)).toBe(true)
      const second = await f.run()
      expect(sourceOutcome(second, ws)).toBe('quarantined')
      expect(log.find((e) => e.event === 'model_epoch.forward.quarantined')).toMatchObject({ alert: true, journal: 'j-poison' })
      // No longer refusing: the fold writer, compaction and the roll go on.
      expect(await modelEpochForwardPending(db.pool, WS)).toBe(false)
      const third = await f.run()
      expect(sourceOutcome(third, ws)).toBe('quarantined')
      // The operator: list, then release. Its one target never resolves — not
      // a document of the current epoch, nor an overlay of the current meta —
      // and nothing was written: RE-PLANNED, the journal
      // goes and the cursor stays, so the next pass routes afresh.
      const qd = { db: db.pool, connect: () => db.pool.connect(), key: WS }
      expect((await listQuarantinedForwards(db.pool, WS)).map((q) => [q.id, q.attempts])).toEqual([['j-poison', 2]])
      await expect(releaseQuarantinedForward(qd, 'j-poison')).rejects.toThrow(/FENCED/) // only under the write fence
      expect(await withFence(projector.instance(), (fenced) => releaseQuarantinedForward({ ...qd, fenced }, 'j-poison')))
        .toMatchObject({ outcome: 'released', replanned: true, written: [] })
      expect(await journals()).toEqual([])
      expect((await cursorOf(String(ws.base.documentId)))!.forward_cursor).toEqual(cursor)
      // DISCARD, on another poisoned journal.
      await db.pool.query(
        `INSERT INTO read_model_model_epoch_forwards (id, landscape_id, version_id, source_document_id, from_heads, to_heads, parts, owner_instance, quarantined_at)
         VALUES ('j-poison-2', $1, $2, $3, $4::text[], $4::text[], $5::jsonb, 'cell-a', now())`,
        [WS.landscapeId, WS.versionId, String(ws.base.documentId), cursor,
          JSON.stringify([{ documentId: missing, paths: [], aligned: false, plannedInserts: [], adoptUrls: [] }])])
      // Never unfenced.
      await expect(discardQuarantinedForward(qd, 'j-poison-2')).rejects.toThrow(/FENCED/)
      const client = await db.pool.connect()
      try {
        const exportDir = mkdtempSync(path.join(tmpdir(), 'epoch-discard-'))
        const fq = { ...qd, fenced: fencedOn(client, WS, projector.instance()), exportDir }
        // THE CURSOR CAS: a cursor that moved
        // since the journal was written refuses, and writes nothing.
        await db.pool.query(`UPDATE read_model_model_epoch_docs SET forward_cursor = ARRAY['moved'] WHERE document_id = $1`, [String(ws.base.documentId)])
        expect(await discardQuarantinedForward(fq, 'j-poison-2')).toMatchObject({ outcome: 'cursor_moved', journal: 'j-poison-2' })
        expect((await journals()).map((j) => j.id)).toEqual(['j-poison-2'])
        expect((await cursorOf(String(ws.base.documentId)))!.forward_cursor).toEqual(['moved'])
        await db.pool.query(`UPDATE read_model_model_epoch_docs SET forward_cursor = $2::text[] WHERE document_id = $1`, [String(ws.base.documentId), cursor])
        const discarded = await discardQuarantinedForward(fq, 'j-poison-2')
        expect(discarded).toMatchObject({ outcome: 'discarded', targets: [missing], written: [], exportTable: 'read_model_model_epoch_discards' })
        // The file copy: 0600, never world-readable.
        const file = (discarded as { exportPath: string }).exportPath
        expect(statSync(file).mode & 0o777).toBe(0o600)
        const exported = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        expect(exported).toMatchObject({ journal: 'j-poison-2', source: String(ws.base.documentId), targetsAlreadyWritten: [], changes: [] })
        // The DURABLE copy is the row, with the routing an operator needs.
        expect(await readDiscardExport(db.pool, WS, 'j-poison-2')).toEqual(exported)
        expect((exported as { parts: unknown[] }).parts).toEqual([{ documentId: missing, paths: [], aligned: false, plannedInserts: [], headsBefore: null, alreadyWritten: false, overrides: [] }])
        expect(await journals()).toEqual([])
        expect(await discardQuarantinedForward(fq, 'j-poison-2')).toEqual({ outcome: 'not_quarantined', journal: 'j-poison-2' })
      } finally { client.release() }
    } finally { f.release(); projector.stop() }
  })

  it('a COMPACTION clears the recorded head after quarantine — release RE-ROUTES (nothing written), the edit lands in the base', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase, currentMeta } = await rolled(ws)
    const head = await carlEditsBInTheHead(ws, currentMeta)
    const crash = await forwarder(ws, projector.instance(), { beforeTargetWrite: () => { throw new Error('crash before the head write') } })
    try {
      marieSyncs(ws, (d) => { d.objects.b!.name = 'Marie B after the clear' })
      await expect(crash.run()).rejects.toThrow('crash before the head write')
      const [journal] = await journals()
      expect((journal!.parts as Array<{ documentId: string }>).map((p) => p.documentId)).toEqual([String(head.documentId)])
      await db.pool.query('UPDATE read_model_model_epoch_forwards SET quarantined_at = now()')
      // Quarantined, it no longer blocks: a pass folds the head into the base and clears it.
      // (The watermark only once Carl's head write is projected: see the crash test.)
      expect(await until(() => roData('b'), (d) => d?.type === 'container')).toMatchObject({ type: 'container' })
      expect((await acknowledged()).acknowledged).toBe(true)
      const pass = await runWorkspaceCompaction(WS, passDeps(ws, projector.fleet))
      expect(pass.result.skippedReason).toBeUndefined()
      expect(head.doc()!.objects.b).toBeUndefined()
      expect(currentBase.doc()!.objects.b).toMatchObject({ name: 'Base B', type: 'container' })
      const qd = { db: db.pool, connect: () => db.pool.connect(), key: WS }
      expect(await withFence(projector.instance(), (fenced) => releaseQuarantinedForward({ ...qd, fenced }, journal!.id)))
        .toMatchObject({ outcome: 'released', replanned: true })
      // The next pass routes Marie's edit against the CURRENT meta: the base.
      await acknowledged()
      const f = await forwarder(ws, projector.instance())
      try { await f.run() } finally { f.release() }
      expect(currentBase.doc()!.objects.b).toMatchObject({ name: 'Marie B after the clear', type: 'container' })
      expect(await until(() => roName('b'), (n) => n === 'Marie B after the clear')).toBe('Marie B after the clear')
    } finally { crash.release(); projector.stop() }
  }, 60_000)

  it('a ROLL after quarantine with one target already written — release REFUSES; discard exports, then records what was written', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase, currentMeta } = await rolled(ws)
    // Carl serves `c` from the head; Paul renames `b` in the base.
    const headUrl = readMetaUrl(currentMeta.doc(), 'editsObjectShardUrl')!
    const head = await ws.repo.find<Shard>(headUrl as AutomergeUrl)
    head.change((d) => { d.objects.c = { id: 'c', name: 'Base C', type: 'container' } })
    currentBase.change((d) => { d.objects.b!.name = 'Paul B' })
    await ws.repo.flush([head.documentId, currentBase.documentId])
    // The crash comes right after the BASE write: the head is still to write.
    const base = String(currentBase.documentId)
    const crash = await forwarder(ws, projector.instance(), { afterTargetWrite: (id) => { if (id === base) throw new Error('crash after the base') } })
    try {
      marieSyncs(ws, (d) => { d.objects.b!.name = 'Marie B'; d.objects.b!.type = 'container'; d.objects.c!.name = 'Marie C' })
      try { await expect(crash.run()).rejects.toThrow('crash after the base') } finally { crash.release() } // the test pool is small
      const [journal] = await journals()
      expect((journal!.parts as Array<{ documentId: string }>).map((p) => p.documentId)).toEqual([base, String(head.documentId)])
      await db.pool.query('UPDATE read_model_model_epoch_forwards SET quarantined_at = now()')
      // A ROLL while quarantined (the next period): epoch 2 supersedes the
      // base, its compaction clears the head. (The watermark only once every
      // write so far is projected: see the crash test.)
      expect(await until(() => roData('b'), (d) => d?.name === 'Paul B' && d?.type === 'container')).toMatchObject({ name: 'Paul B', type: 'container' })
      expect((await acknowledged()).acknowledged).toBe(true)
      const later = { ...passDeps(ws, projector.fleet), modelEpochs: { ...modelEpochs(), now: () => new Date(Date.now() + 40 * 86_400_000) } }
      const roll = await runWorkspaceCompaction(WS, later)
      expect(roll.epoch).toMatchObject({ outcome: 'rolled', epochNo: 2 })
      const qd = { db: db.pool, connect: () => db.pool.connect(), key: WS }
      expect(await withFence(projector.instance(), (fenced) => releaseQuarantinedForward({ ...qd, fenced }, journal!.id))).toEqual({
        outcome: 'superseded_since_quarantine', journal: journal!.id, written: [base], superseded: [String(head.documentId)],
      })
      expect((await journals()).map((j) => j.id)).toEqual([journal!.id]) // nothing changed
      const client = await db.pool.connect()
      try {
        await acknowledged()
        const exportDir = mkdtempSync(path.join(tmpdir(), 'epoch-discard-'))
        const fq = { ...qd, fenced: fencedOn(client, WS, projector.instance()), exportDir }
        // Marie's changes are not in STORAGE yet (the source was never
        // flushed after the crash): nothing could be exported, so nothing is
        // given up.
        expect(await discardQuarantinedForward(fq, journal!.id)).toEqual({ outcome: 'source_not_durable', journal: journal!.id })
        await ws.repo.flush([ws.base.documentId])
        const discarded = await discardQuarantinedForward(fq, journal!.id)
        expect(discarded).toMatchObject({ outcome: 'discarded', written: [base], targets: [base, String(head.documentId)] })
        // The export: Marie's change, the targets already written, and the
        // routing to redo the rest by hand — paths, heads before, override rows.
        const exported = (await readDiscardExport(db.pool, WS, journal!.id))!
        expect(exported.targetsAlreadyWritten).toEqual([base])
        expect(exported.changes.map((c) => c.actor)).toContain('aa'.repeat(16))
        const [basePart, headPart] = exported.parts
        expect(basePart).toMatchObject({ documentId: base, paths: [['objects', 'b']], alreadyWritten: true })
        expect(basePart!.headsBefore).toHaveLength(1)
        expect(basePart!.overrides).toEqual([expect.objectContaining({ target: ['objects', 'b', 'name'], late: 'Marie B', current: 'Paul B' })])
        expect(headPart).toMatchObject({ documentId: String(head.documentId), paths: [['objects', 'c']], alreadyWritten: false, headsBefore: null })
        // What was written is recorded as a completed forward: its canonical
        // change for the dedupe sweep, its override row (Paul's name won).
        const { rows: writes } = await db.pool.query<{ target_document_id: string }>(
          'SELECT target_document_id FROM read_model_model_epoch_forward_writes WHERE journal_id = $1', [journal!.id])
        expect(writes.map((w) => w.target_document_id)).toEqual([base])
        const overrides = await listOverridesForActors(db.pool, WS, ['aa'.repeat(16)])
        expect(overrides.map((o) => [o.path, o.lateValue, o.currentValueAtForward])).toEqual([[['objects', 'b', 'name'], 'Marie B', 'Paul B']])
        expect([...(await cursorOf(String(ws.base.documentId)))!.forward_cursor].sort()).toEqual([...A.getHeads(ws.base.doc() as A.Doc<unknown>)].sort())
        expect(await journals()).toEqual([])
      } finally { client.release() }
    } finally { projector.stop() }
  }, 90_000)

  it('release counts a target written IN MEMORY (not yet flushed) — with the Repo, never storage alone', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    try {
      const cursor = (await cursorOf(String(ws.base.documentId)))!.forward_cursor
      const missing = generateAutomergeUrl().slice('automerge:'.length)
      const base = String(currentBase.documentId)
      await db.pool.query(
        `INSERT INTO read_model_model_epoch_forwards (id, landscape_id, version_id, source_document_id, from_heads, to_heads, parts, owner_instance, quarantined_at)
         VALUES ('j-mem', $1, $2, $3, $4::text[], $4::text[], $5::jsonb, 'cell-a', now())`,
        [WS.landscapeId, WS.versionId, String(ws.base.documentId), cursor, JSON.stringify([
          { documentId: base, paths: [['objects', 'c']], aligned: true, plannedInserts: [], adoptUrls: [] },
          { documentId: missing, paths: [], aligned: false, plannedInserts: [], adoptUrls: [] },
        ])])
      // The base's forward change exists only in a process's MEMORY (its
      // flush failed): a Repo with no storage holds it, storage does not.
      const live = new Repo({ network: [] })
      const inMemory = A.change(A.clone(currentBase.doc() as A.Doc<Shard>), { message: forwardMessage('j-mem', base) },
        (d) => { d.objects.c!.name = 'In memory' })
      await live.import<Shard>(A.save(inMemory), { docId: currentBase.documentId }).whenReady()
      const qd = { db: db.pool, connect: () => db.pool.connect(), key: WS, repo: live }
      // Written (base) + superseded (the missing target): REFUSED — storage
      // alone would have seen nothing written and dropped the journal, and
      // the next pass would forward that edit a second time.
      expect(await withFence(projector.instance(), (fenced) => releaseQuarantinedForward({ ...qd, fenced }, 'j-mem'))).toEqual({
        outcome: 'superseded_since_quarantine', journal: 'j-mem', written: [base], superseded: [missing],
      })
      expect((await journals()).map((j) => j.id)).toEqual(['j-mem'])
    } finally { projector.stop() }
  })

  it('commit 9, server half: the durable acknowledgement carries `forwarded` for a superseded document, and `epochRetired` once retired', async () => {
    const ws = await workspace(storageRepo())
    const { projector } = await rolled(ws)
    const f = await forwarder(ws, projector.instance())
    try {
      marieSyncs(ws, (d) => { d.objects.c!.name = 'Acked C' })
      await ws.repo.flush([ws.base.documentId])
      const ask = () => acknowledgeDurableHeads(ws.repo, db.pool, WS, [
        { documentId: String(ws.base.documentId), heads: [...A.getHeads(ws.base.doc() as A.Doc<unknown>)] },
        { documentId: String(ws.root.documentId), heads: [...A.getHeads(ws.root.doc() as A.Doc<unknown>)] },
      ])
      // Durable, NOT forwarded yet — flagged for an event-driven pass; a
      // non-epoch document has no bit.
      expect(await ask()).toEqual([
        { documentId: String(ws.base.documentId), durable: true, forwarded: false, forwardPending: true },
        { documentId: String(ws.root.documentId), durable: true },
      ])
      await f.run()
      // Forwarded: with WHAT THE FORWARD WROTE — per target of the current
      // epoch, its forward change.
      const forwarded = (await ask())[0]!
      expect(forwarded).toEqual({
        documentId: String(ws.base.documentId), durable: true, forwarded: true, targetHeads: expect.any(Array),
      })
      const { rows: writes } = await db.pool.query<{ target_document_id: string; change_hash: string }>(
        `SELECT target_document_id, change_hash FROM read_model_model_epoch_forward_writes WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId])
      expect(writes.length).toBeGreaterThan(0)
      expect(forwarded.targetHeads).toEqual(expect.arrayContaining(
        writes.map((w) => ({ documentId: w.target_document_id, heads: [w.change_hash] }))))
      const { rows: current } = await db.pool.query<{ document_id: string }>(
        `SELECT document_id FROM read_model_model_epoch_docs WHERE landscape_id = $1 AND version_id = $2 AND superseded_epoch IS NULL`,
        [WS.landscapeId, WS.versionId])
      const currentIds = new Set(current.map((r) => r.document_id))
      for (const t of forwarded.targetHeads!) {
        // Only documents of the CURRENT epoch, whose server copy holds the hash.
        expect(currentIds.has(t.documentId)).toBe(true)
        const doc = (await ws.repo.find<unknown>(`automerge:${t.documentId}` as AutomergeUrl)).doc() as A.Doc<unknown>
        expect(A.hasHeads(doc, t.heads)).toBe(true)
      }
      await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = 'retired' WHERE document_id = $1`, [String(ws.base.documentId)])
      // A retired answer carries the targets too (the tab swaps
      // on that path, after the batch's live sources' forwards).
      expect((await ask())[0]).toEqual({ documentId: String(ws.base.documentId), durable: false, forwarded: false, epochRetired: true, targetHeads: forwarded.targetHeads })
    } finally { f.release(); projector.stop() }
  })

  for (const state of ['retiring', 'pinned'] as const) {
    it(`a ${state.toUpperCase()} source written past its cursor is forwardPending — the triggered pass revives it (back to live) and forwards it`, async () => {
      const ws = await workspace(storageRepo())
      const { projector, currentBase } = await rolled(ws)
      try {
        // The retirement walk moved it on (no late write then)…
        await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = $2, pinned_by = $3 WHERE document_id = $1`,
          [String(ws.base.documentId), state, state === 'pinned' ? 'test' : null])
        // …then Marie's offline session reaches it.
        marieSyncs(ws, (d) => { d.objects.c!.name = `Late into a ${state} C` })
        await ws.repo.flush([ws.base.documentId])
        const ask = () => acknowledgeDurableHeads(ws.repo, db.pool, WS, [
          { documentId: String(ws.base.documentId), heads: [...A.getHeads(ws.base.doc() as A.Doc<unknown>)] },
        ])
        expect((await ask())[0]).toEqual({ documentId: String(ws.base.documentId), durable: true, forwarded: false, forwardPending: true })
        // The pass the answer triggers: forward-only, as the route's.
        const swept = await sweepModelEpochs(WS, {
          repo: ws.repo, db: db.pool, connect: () => db.pool.connect(),
          residentProjectorInstanceId: () => projector.instance(), owns: () => true, isShuttingDown: () => false,
          instanceId: 'cell-a', retire: { retain: 3, periodDays: 30 }, ...TRIGGERED_SWEEP,
        })
        expect(swept).toMatchObject({ outcome: 'swept', forwarded: { outcome: 'ran' } })
        const { rows } = await db.pool.query<{ state: string; pinned_by: string | null }>(
          'SELECT state, pinned_by FROM read_model_model_epoch_docs WHERE document_id = $1', [String(ws.base.documentId)])
        expect(rows[0]).toEqual({ state: 'live', pinned_by: null })
        expect(currentBase.doc()!.objects.c!.name).toBe(`Late into a ${state} C`)
        expect((await ask())[0]).toMatchObject({ documentId: String(ws.base.documentId), durable: true, forwarded: true })
      } finally { projector.stop() }
    })
  }

  it('a RETIRED document is never revived, whatever the route asked', async () => {
    const ws = await workspace(storageRepo())
    const { projector } = await rolled(ws)
    try {
      await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = 'retired', revive_requested_at = now() WHERE document_id = $1`, [String(ws.base.documentId)])
      expect(await reviveRequestedRetiring(db.pool, WS)).toEqual([])
      const { rows } = await db.pool.query<{ state: string; revive_requested_at: Date | null }>(
        'SELECT state, revive_requested_at FROM read_model_model_epoch_docs WHERE document_id = $1', [String(ws.base.documentId)])
      expect(rows[0]).toEqual({ state: 'retired', revive_requested_at: null })
    } finally { projector.stop() }
  })

  it('a mark the route sets BETWEEN the revival and the orphan sweep survives — the next pass revives it', async () => {
    const ws = await workspace(storageRepo())
    const { projector } = await rolled(ws)
    try {
      const id = String(ws.base.documentId)
      await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = 'retiring', revive_requested_at = NULL WHERE document_id = $1`, [id])
      // The pass's statements, with the route's mark committed between them
      // (READ COMMITTED: the second statement sees it).
      let statements = 0
      const interleaved = {
        query: async (sql: string, params?: unknown[]) => {
          const result = await db.pool.query(sql, params)
          statements += 1
          if (statements === 1) await requestLateRetiringRevival(db.pool, WS, [id])
          return result
        },
      }
      expect(await reviveRequestedRetiring(interleaved as never, WS)).toEqual([])
      const marked = await db.pool.query<{ state: string; revive_requested_at: Date | null }>(
        'SELECT state, revive_requested_at FROM read_model_model_epoch_docs WHERE document_id = $1', [id])
      expect(marked.rows[0]!.state).toBe('retiring')
      expect(marked.rows[0]!.revive_requested_at).not.toBeNull()
      expect(await reviveRequestedRetiring(db.pool, WS)).toEqual([id])
      const revived = await db.pool.query<{ state: string; revive_requested_at: Date | null }>(
        'SELECT state, revive_requested_at FROM read_model_model_epoch_docs WHERE document_id = $1', [id])
      expect(revived.rows[0]).toEqual({ state: 'live', revive_requested_at: null })
    } finally { projector.stop() }
  })

  const baseRow = async (ws: World) => (await db.pool.query<{ state: string; revive_requested_at: Date | null }>(
    'SELECT state, revive_requested_at FROM read_model_model_epoch_docs WHERE document_id = $1', [String(ws.base.documentId)])).rows[0]!
  const triggeredSweep = (ws: World, instance: () => string | null) => sweepModelEpochs(WS, {
    repo: ws.repo, db: db.pool, connect: () => db.pool.connect(),
    residentProjectorInstanceId: instance, owns: () => true, isShuttingDown: () => false,
    instanceId: 'cell-a', retire: { retain: 3, periodDays: 30 }, ...TRIGGERED_SWEEP,
  })

  it('a RETIRING document whose cursor COVERS the heads asked is `forwarded: true` — not revived, not even marked', async () => {
    const ws = await workspace(storageRepo())
    const { projector } = await rolled(ws)
    try {
      marieSyncs(ws, (d) => { d.objects.c!.name = 'Forwarded before the walk' })
      await ws.repo.flush([ws.base.documentId])
      const f = await forwarder(ws, projector.instance())
      try { await f.run() } finally { f.release() }
      // Quiet now (heads = cursor), the walk moves it on.
      await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = 'retiring' WHERE document_id = $1`, [String(ws.base.documentId)])
      const [answer] = await acknowledgeDurableHeads(ws.repo, db.pool, WS, [
        { documentId: String(ws.base.documentId), heads: [...A.getHeads(ws.base.doc() as A.Doc<unknown>)] },
      ])
      expect(answer).toMatchObject({ documentId: String(ws.base.documentId), durable: true, forwarded: true })
      expect(answer!.forwardPending).toBeUndefined()
      expect(await baseRow(ws)).toEqual({ state: 'retiring', revive_requested_at: null })
    } finally { projector.stop() }
  })

  it('one request revives ONCE — after the walk moves the document on again, a later pass does not revive it', async () => {
    const ws = await workspace(storageRepo())
    const { projector } = await rolled(ws)
    try {
      await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = 'retiring' WHERE document_id = $1`, [String(ws.base.documentId)])
      marieSyncs(ws, (d) => { d.objects.c!.name = 'Late, once' })
      await ws.repo.flush([ws.base.documentId])
      await acknowledgeDurableHeads(ws.repo, db.pool, WS, [
        { documentId: String(ws.base.documentId), heads: [...A.getHeads(ws.base.doc() as A.Doc<unknown>)] },
      ])
      expect((await baseRow(ws)).revive_requested_at).not.toBeNull()
      await triggeredSweep(ws, () => projector.instance())
      expect(await baseRow(ws)).toEqual({ state: 'live', revive_requested_at: null })
      // The walk moves it on again; the next pass leaves it there.
      await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = 'retiring' WHERE document_id = $1`, [String(ws.base.documentId)])
      await triggeredSweep(ws, () => projector.instance())
      expect((await baseRow(ws)).state).toBe('retiring')
    } finally { projector.stop() }
  })

  it('the revival runs UNDER the pass\'s fence — a pass whose fence holder is stale revives nothing, and the mark waits for the next one', async () => {
    const ws = await workspace(storageRepo())
    const { projector } = await rolled(ws)
    try {
      await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = 'retiring', revive_requested_at = now() WHERE document_id = $1`, [String(ws.base.documentId)])
      // A projector instance that does not hold the fence (a compaction rebuilt under a new one).
      await triggeredSweep(ws, () => 'stale-instance').catch(() => undefined)
      const row = await baseRow(ws)
      expect(row.state).toBe('retiring')
      expect(row.revive_requested_at).not.toBeNull()
      await triggeredSweep(ws, () => projector.instance())
      expect((await baseRow(ws)).state).toBe('live')
    } finally { projector.stop() }
  })

  it('a RETIRING document the server does NOT hold durable at the heads asked is neither forwardPending nor marked', async () => {
    const ws = await workspace(storageRepo())
    const { projector } = await rolled(ws)
    try {
      await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = 'retiring' WHERE document_id = $1`, [String(ws.base.documentId)])
      // Heads the server never received.
      const elsewhere = A.change(A.clone(ws.base.doc() as A.Doc<Shard>), (d) => { d.objects.c!.name = 'Never sent' })
      const [answer] = await acknowledgeDurableHeads(ws.repo, db.pool, WS, [
        { documentId: String(ws.base.documentId), heads: [...A.getHeads(elsewhere)] },
      ])
      expect(answer).toEqual({ documentId: String(ws.base.documentId), durable: false, forwarded: false })
      expect(await baseRow(ws)).toEqual({ state: 'retiring', revive_requested_at: null })
    } finally { projector.stop() }
  })

  it('a forward into the overlay WRITE HEAD (no epoch row) is named in targetHeads, with a hash the server\'s head holds', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentMeta } = await rolled(ws)
    const head = await carlEditsBInTheHead(ws, currentMeta)
    const f = await forwarder(ws, projector.instance())
    try {
      marieSyncs(ws, (d) => { d.objects.b!.name = 'Marie B in the head' })
      await ws.repo.flush([ws.base.documentId])
      const headBefore = A.clone(head.doc()!) as A.Doc<unknown>
      await f.run()
      expect(head.doc()!.objects.b).toMatchObject({ name: 'Marie B in the head' })
      const [answer] = await acknowledgeDurableHeads(ws.repo, db.pool, WS, [
        { documentId: String(ws.base.documentId), heads: [...A.getHeads(ws.base.doc() as A.Doc<unknown>)] },
      ])
      expect(answer).toMatchObject({ forwarded: true })
      const inHead = answer!.targetHeads!.find((t) => t.documentId === String(head.documentId))
      expect(inHead, 'the head the forward wrote into is a target').toBeDefined()
      expect(A.hasHeads(head.doc() as A.Doc<unknown>, inHead!.heads)).toBe(true)
      // A tab's copy WITHOUT the forward does not hold it (what B2 waits for).
      expect(A.hasHeads(headBefore, inHead!.heads)).toBe(false)
    } finally { f.release(); projector.stop() }
  })

  it('EVERY hash since the PREDECESSOR epoch\'s publication per target (a discard recorded late is no "latest"); older writes are not read; the purge keeps what a reader needs', async () => {
    const ins = (id: string, superseded: number | null) => db.pool.query(
      `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role, superseded_epoch)
       VALUES ($1, $2, $3, 0, 'base', $4) ON CONFLICT (document_id) DO NOTHING`, [id, WS.landscapeId, WS.versionId, superseded])
    const write = (journal: string, target: string, hash: string, at: string) => db.pool.query(
      `INSERT INTO read_model_model_epoch_forward_writes (journal_id, target_document_id, landscape_id, version_id, message, change_hash, heads_before, written_at)
       VALUES ($1, $2, $3, $4, 'm', $5, '{}', $6::timestamptz)`, [journal, target, WS.landscapeId, WS.versionId, hash, at])
    await db.pool.query(`INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, published_at)
      VALUES ($1, $2, 0, 'legacy', 'retained', NULL, 'automerge:m0', now() - interval '40 days'),
             ($1, $2, 1, 'full', 'published', 0, 'automerge:m1', now() - interval '20 days')`, [WS.landscapeId, WS.versionId])
    await ins('acc-t', null)
    // Before the PREDECESSOR epoch: a write to the same target, never named.
    await write('j0', 'acc-t', 'h-before-epoch', new Date(Date.now() - 45 * 86_400_000).toISOString())
    // S2 forwarded c2 (descends from c1) BEFORE the operator discarded J1,
    // whose discard records c1 with a LATER written_at.
    await write('j2', 'acc-t', 'c2', new Date(Date.now() - 16 * 86_400_000).toISOString())
    await write('j1-discard', 'acc-t', 'c1', new Date(Date.now() - 60_000).toISOString())
    // The write head: no epoch row, still a target (BL-A).
    await write('j2', 'acc-head', 'h-head', new Date(Date.now() - 60_000).toISOString())
    const targets = await currentEpochForwardTargets(db.pool, WS)
    expect(targets.filter((t) => t.documentId.startsWith('acc-'))).toEqual([
      { documentId: 'acc-head', heads: ['h-head'] },
      { documentId: 'acc-t', heads: ['c1', 'c2'] },
    ])
    // THE PURGE: older than the dedupe window AND than the current epoch's
    // publication goes; inside the epoch (c2, 16 days) or the window stays.
    expect(await purgeForwardWrites(db.pool, WS)).toBe(1)
    const { rows } = await db.pool.query<{ change_hash: string }>(
      `SELECT change_hash FROM read_model_model_epoch_forward_writes WHERE target_document_id LIKE 'acc-%' ORDER BY change_hash`)
    expect(rows.map((r) => r.change_hash)).toEqual(['c1', 'c2', 'h-head'])
  })

  it('a forward into the overlay HEAD (carried across epochs) stays named, and unpurged, after a NEW epoch is published', async () => {
    const write = (journal: string, target: string, hash: string, daysAgo: number) => db.pool.query(
      `INSERT INTO read_model_model_epoch_forward_writes (journal_id, target_document_id, landscape_id, version_id, message, change_hash, heads_before, written_at)
       VALUES ($1, $2, $3, $4, 'm', $5, '{}', now() - ($6::float8 * interval '1 day'))`, [journal, target, WS.landscapeId, WS.versionId, hash, daysAgo])
    await db.pool.query(`INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, published_at)
      VALUES ($1, $2, 0, 'legacy', 'retained', NULL, 'automerge:m0', now() - interval '60 days'),
             ($1, $2, 1, 'full', 'published', 0, 'automerge:m1', now() - interval '30 days')`, [WS.landscapeId, WS.versionId])
    // A tab on E0 wrote late; forwarded into the HEAD while E1 was current.
    await write('jh', 'ac3-head', 'h-forwarded-during-e1', 20)
    const named = async () => (await currentEpochForwardTargets(db.pool, WS)).filter((t) => t.documentId === 'ac3-head')
    expect(await named()).toEqual([{ documentId: 'ac3-head', heads: ['h-forwarded-during-e1'] }])
    // E2 is published before the tab hops (its latch overlapped the roll).
    await db.pool.query(`UPDATE read_model_model_epochs SET state = 'retained' WHERE landscape_id = $1 AND version_id = $2 AND epoch_no = 1`, [WS.landscapeId, WS.versionId])
    await db.pool.query(`INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, published_at)
      VALUES ($1, $2, 2, 'full', 'published', 1, 'automerge:m2', now() - interval '10 days')`, [WS.landscapeId, WS.versionId])
    expect(await named()).toEqual([{ documentId: 'ac3-head', heads: ['h-forwarded-during-e1'] }])
    // The purge keeps it too: older than the window, NOT than E1's publication.
    await write('jo', 'ac3-head', 'h-before-e1', 40)
    expect(await purgeForwardWrites(db.pool, WS)).toBe(1)
    expect(await named()).toEqual([{ documentId: 'ac3-head', heads: ['h-forwarded-during-e1'] }])
  })

  it('the purge keeps the dedupe window; with NO published epoch, the window alone decides', async () => {
    const write = (hash: string, daysAgo: number) => db.pool.query(
      `INSERT INTO read_model_model_epoch_forward_writes (journal_id, target_document_id, landscape_id, version_id, message, change_hash, heads_before, written_at)
       VALUES ($3, 'a5-t', $1, $2, 'm', $3, '{}', now() - ($4::float8 * interval '1 day'))`, [WS.landscapeId, WS.versionId, hash, daysAgo])
    // No epoch row at all (the targets read nothing): past the window, gone.
    await write('h-old', 40)
    expect(await purgeForwardWrites(db.pool, WS)).toBe(1)
    await write('h-old', 40)
    // A published epoch, NOW: a write 3 days old is older than it but inside
    // the 14-day window (the dedupe sweep still reads it) — kept.
    await db.pool.query(`INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, published_at)
      VALUES ($1, $2, 0, 'legacy', 'published', NULL, 'automerge:m0', now())`, [WS.landscapeId, WS.versionId])
    await write('h-recent', 3)
    expect(await purgeForwardWrites(db.pool, WS)).toBe(1)
    const { rows } = await db.pool.query<{ change_hash: string }>(`SELECT change_hash FROM read_model_model_epoch_forward_writes WHERE target_document_id = 'a5-t'`)
    expect(rows.map((r) => r.change_hash)).toEqual(['h-recent'])
  })

  it('a LEGACY current epoch (no predecessor) bounds the purge by ITS publication — a write past the window but after it stays', async () => {
    const write = (hash: string, daysAgo: number) => db.pool.query(
      `INSERT INTO read_model_model_epoch_forward_writes (journal_id, target_document_id, landscape_id, version_id, message, change_hash, heads_before, written_at)
       VALUES ($3, 'sa8-t', $1, $2, 'm', $3, '{}', now() - ($4::float8 * interval '1 day'))`, [WS.landscapeId, WS.versionId, hash, daysAgo])
    await db.pool.query(`INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, published_at)
      VALUES ($1, $2, 0, 'legacy', 'published', NULL, 'automerge:m0', now() - interval '30 days')`, [WS.landscapeId, WS.versionId])
    await write('h-before-legacy', 40)
    await write('h-after-legacy', 20) // past the 14-day window, after the legacy publication: the targets still read it
    expect(await purgeForwardWrites(db.pool, WS)).toBe(1)
    const { rows } = await db.pool.query<{ change_hash: string }>(`SELECT change_hash FROM read_model_model_epoch_forward_writes WHERE target_document_id = 'sa8-t'`)
    expect(rows.map((r) => r.change_hash)).toEqual(['h-after-legacy'])
    expect((await currentEpochForwardTargets(db.pool, WS)).find((t) => t.documentId === 'sa8-t')).toEqual({ documentId: 'sa8-t', heads: ['h-after-legacy'] })
  })

  it('at most FORWARD_TARGET_HASHES_MAX hashes per target, the most recent', async () => {
    await db.pool.query(`INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, published_at)
      VALUES ($1, $2, 1, 'full', 'published', 0, 'automerge:m1', now() - interval '1 day')`, [WS.landscapeId, WS.versionId])
    for (let i = 0; i < 40; i += 1) {
      await db.pool.query(
        `INSERT INTO read_model_model_epoch_forward_writes (journal_id, target_document_id, landscape_id, version_id, message, change_hash, heads_before, written_at)
         VALUES ($1, 'cap-t', $2, $3, 'm', $4, '{}', now() - ($5 || ' seconds')::interval)`,
        [`j${i}`, WS.landscapeId, WS.versionId, `h${String(i).padStart(2, '0')}`, String(100 - i)])
    }
    const [target] = (await currentEpochForwardTargets(db.pool, WS)).filter((t) => t.documentId === 'cap-t')
    expect(target!.heads).toHaveLength(32)
    expect(target!.heads).toContain('h39')
    expect(target!.heads).not.toContain('h00')
  })

  it('the forward targets are NOT capped at 64 documents; superseded, retired and other workspaces are left out; the LATEST write per target', async () => {
    await db.pool.query(`INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, published_at)
      VALUES ($1, $2, 1, 'full', 'published', 0, 'automerge:m1', '2026-11-15T09:00:00Z')`, [WS.landscapeId, WS.versionId])
    const ins = (id: string, superseded: number | null, state = 'live', ws = WS) => db.pool.query(
      `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role, superseded_epoch, state)
       VALUES ($1, $2, $3, 0, 'base', $4, $5) ON CONFLICT (document_id) DO NOTHING`,
      [id, ws.landscapeId, ws.versionId, superseded, state])
    const write = (journal: string, target: string, hash: string, at: string, ws = WS) => db.pool.query(
      `INSERT INTO read_model_model_epoch_forward_writes (journal_id, target_document_id, landscape_id, version_id, message, change_hash, heads_before, written_at)
       VALUES ($1, $2, $3, $4, 'm', $5, '{}', $6::timestamptz)`,
      [journal, target, ws.landscapeId, ws.versionId, hash, at])
    const ids = Array.from({ length: 80 }, (_, i) => `bl1-doc-${String(i).padStart(3, '0')}`)
    for (const id of ids) await ins(id, null)
    await ins('bl1-old', 1)
    await ins('bl1-retired', 1, 'retired')
    const other = { landscapeId: WS.landscapeId, versionId: 'bl1-other-version' }
    await ins('bl1-other', null, 'live', other)
    // A forward to EVERY one of the 80 documents (80 targets: past any 64
    // cap), a second, newer one to the 70th (the latest wins), one to each
    // excluded document.
    for (const [i, id] of ids.entries()) await write('j1', id, `h-${i}`, '2026-11-15T10:00:00Z')
    await write('j2', ids[69]!, 'h-69-new', '2026-11-15T10:00:05Z')
    await write('j1', 'bl1-old', 'h-old', '2026-11-15T10:00:00Z')
    await write('j1', 'bl1-retired', 'h-retired', '2026-11-15T10:00:00Z')
    await write('j1', 'bl1-other', 'h-other', '2026-11-15T10:00:00Z', other)
    const targets = await currentEpochForwardTargets(db.pool, WS)
    const bl1 = targets.filter((t) => t.documentId.startsWith('bl1-'))
    expect(bl1).toHaveLength(80)
    // Every hash of the current epoch, not only the latest.
    expect(bl1).toEqual(ids.map((id, i) => ({ documentId: id, heads: i === 69 ? ['h-69', 'h-69-new'] : [`h-${i}`] })))
  })

  it('a URL an OLD client appends to the current meta\'s frozen text mirror is adopted into the ruling list, once', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentMeta } = await rolled(ws)
    const f = await forwarder(ws, projector.instance())
    try {
      await f.run() // the mirror cursor starts at birth; nothing to adopt
      const overflow = ws.repo.create<Shard>({ objects: { q: { id: 'q', name: 'Old-client shard', type: 'system' } } })
      await overflow.whenReady()
      await ws.repo.flush([overflow.documentId])
      await claim(String(overflow.documentId))
      // A build from before the scalar URL fields: `if (!m.f) m.f = []; m.f.push(url)` on the TEXT field.
      currentMeta.change((m) => { ;(m.objectShardUrls as string[]).push(overflow.url) })
      expect(readMetaUrls(currentMeta.doc(), 'objectShardUrls')).not.toContain(overflow.url) // invisible to new readers
      const report = await f.run()
      expect((report as { mirrorAdopted?: string[] }).mirrorAdopted).toEqual([overflow.url])
      expect(readMetaUrls(currentMeta.doc(), 'objectShardUrls')).toContain(overflow.url)
      const { rows } = await db.pool.query<{ role: string }>('SELECT role FROM read_model_model_epoch_docs WHERE document_id = $1',
        [String(overflow.documentId)])
      expect(rows[0]?.role).toBe('adopted')
      expect(await until(() => roName('q'), (n) => n === 'Old-client shard')).toBe('Old-client shard')
      const again = await f.run()
      expect((again as { mirrorAdopted?: string[] }).mirrorAdopted).toBeUndefined()
    } finally { f.release(); projector.stop() }
  })

  it('D2: a source whose heads ARE its cursor is UNCHANGED — no cursor write; the written one is still forwarded', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    const client = await db.pool.connect()
    const fencedSql: string[] = []
    const fence = fencedOn(client, WS, projector.instance())
    const recording: FencedTransaction = (fn) => fence((tx) => fn({
      query: (sql: string, params?: unknown[]) => { fencedSql.push(sql); return tx.query(sql, params as never) },
    } as never))
    const run = () => forwardModelEpochLateWrites({
      repo: ws.repo, key: WS, db: db.pool, connect: () => db.pool.connect(), fenced: recording,
      instanceId: 'cell-a', mayWrite: () => true,
    }) as Promise<{ outcome: string; sources: Array<{ documentId: string; outcome: string }> }>
    const outcomeOf = (report: { sources: Array<{ documentId: string; outcome: string }> }, id: unknown) =>
      report.sources.find((s) => s.documentId === String(id))?.outcome
    const cursorWrites = () => fencedSql.filter((sql) => /UPDATE read_model_model_epoch_docs\s+SET forward_cursor/.test(sql)).length
    try {
      // The roll's own S8 changes: every source ADVANCES once.
      const first = await run()
      expect(outcomeOf(first, ws.meta.documentId)).toBe('advanced')
      expect(cursorWrites()).toBeGreaterThan(0)
      // Nothing since: every source is UNCHANGED, and no cursor is written.
      fencedSql.length = 0
      const second = await run()
      expect(second.sources.length).toBeGreaterThan(0)
      expect(second.sources.every((s) => s.outcome === 'unchanged')).toBe(true)
      expect(cursorWrites()).toBe(0)
      // A late write on ONE source: that one is forwarded, the other is not read.
      fencedSql.length = 0
      marieSyncs(ws, (d) => { d.objects.c!.name = 'D2 C' })
      const third = await run()
      expect(outcomeOf(third, ws.base.documentId)).toBe('forwarded')
      expect(outcomeOf(third, ws.meta.documentId)).toBe('unchanged')
      expect(currentBase.doc()!.objects.c!.name).toBe('D2 C')
      expect(cursorWrites()).toBe(1)
    } finally { client.release(); projector.stop() }
  })

  it('D2: an UNCHANGED source with a journal open is not skipped — the journal is replayed and closed', async () => {
    const ws = await workspace(storageRepo())
    const { projector } = await rolled(ws)
    const f = await forwarder(ws, projector.instance())
    try {
      await f.run() // every cursor at its source's heads
      const id = String(ws.meta.documentId)
      const cursor = (await cursorOf(id))!.forward_cursor
      expect([...cursor].sort()).toEqual([...A.getHeads(ws.meta.doc() as A.Doc<unknown>)].sort())
      // A journal left open on it (from = to = its cursor: nothing to write).
      await db.pool.query(
        `INSERT INTO read_model_model_epoch_forwards
           (id, landscape_id, version_id, source_document_id, from_heads, to_heads, parts, owner_instance, heartbeat_at)
         VALUES ('00000000-0000-4000-8000-0000000000d2', $1, $2, $3, $4::text[], $4::text[], '[]'::jsonb, 'cell-a', now())`,
        [WS.landscapeId, WS.versionId, id, cursor])
      const report = await f.run() as { sources: Array<{ documentId: string; outcome: string }> }
      expect(report.sources.find((s) => s.documentId === id)?.outcome).toBe('nothing-routed')
      expect(await journals()).toEqual([])
    } finally { f.release(); projector.stop() }
  })

  it('D2: a QUARANTINED journal on a source at its cursor is still a journal — reported `quarantined`, kept, never `unchanged`', async () => {
    const ws = await workspace(storageRepo())
    const { projector } = await rolled(ws)
    const f = await forwarder(ws, projector.instance())
    try {
      await f.run() // every cursor at its source's heads
      const id = String(ws.meta.documentId)
      const cursor = (await cursorOf(id))!.forward_cursor
      expect([...cursor].sort()).toEqual([...A.getHeads(ws.meta.doc() as A.Doc<unknown>)].sort())
      await db.pool.query(
        `INSERT INTO read_model_model_epoch_forwards
           (id, landscape_id, version_id, source_document_id, from_heads, to_heads, parts, owner_instance, heartbeat_at, quarantined_at)
         VALUES ('00000000-0000-4000-8000-0000000000d3', $1, $2, $3, $4::text[], $4::text[], '[]'::jsonb, 'cell-a', now(), now())`,
        [WS.landscapeId, WS.versionId, id, cursor])
      const report = await f.run() as { sources: Array<{ documentId: string; outcome: string }> }
      expect(report.sources.find((s) => s.documentId === id)?.outcome).toBe('quarantined')
      expect(await journals()).toHaveLength(1)
    } finally { f.release(); projector.stop() }
  })

  // The FULL pass goes through
  // `sweepModelEpochs` too, with the options each caller in `index.ts`
  // spreads — the periodic loop's (none), S9's, and the maintenance
  // follow-up's — so a sweep that dropped the maintenance for them is seen.
  it.each([
    ['the periodic sweep', {}],
    ['S9', triggeredSweepOptions({ reset: true })],
    ['the maintenance follow-up', maintenanceFollowUpSweepOptions()],
  ] as const)('D2: a REQUESTED event-driven pass (no maintenance) forwards, but leaves the dedupe sweep and the text mirror to the next full pass — %s', async (_label, fullOptions) => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase, currentMeta } = await rolled(ws)
    // A pass as `index.ts` builds it: the sweep, with these options.
    const sweepPass = (options: Record<string, unknown>) => ({
      run: async () => {
        const swept = await sweepModelEpochs(WS, {
          repo: ws.repo, db: db.pool, connect: () => db.pool.connect(),
          residentProjectorInstanceId: () => projector.instance(), owns: () => true, isShuttingDown: () => false,
          instanceId: 'cell-a', retire: { retain: 3, periodDays: 30 }, ...options,
        })
        expect(swept).toMatchObject({ outcome: 'swept', forwarded: { outcome: 'ran' } })
        return (swept as { forwarded: unknown }).forwarded
      },
      release: () => undefined,
    })
    // The event-driven pass: the triggered options of an ordinary request.
    const lean = sweepPass(triggeredSweepOptions({}))
    const full = sweepPass(fullOptions)
    const dups = () => [...(currentBase.doc()!.objects.c!.tags as string[])].filter((t) => t === 'dup').length
    try {
      await full.run() // the roll's S8 advanced; the mirror cursor recorded
      marieSyncs(ws, (d) => { ;(d.objects.c!.tags as string[]).push('dup') })
      expect(await lean.run()).toMatchObject({ outcome: 'ran', sources: expect.arrayContaining([expect.objectContaining({ outcome: 'forwarded' })]) })
      expect(dups()).toBe(1)
      const { rows } = await db.pool.query<{ message: string }>(
        'SELECT message FROM read_model_model_epoch_forward_writes WHERE target_document_id = $1', [String(currentBase.documentId)])
      currentBase.change((d) => { ;(d.objects.c!.tags as string[]).push('dup') }, { message: rows[0]!.message })
      const overflow = ws.repo.create<Shard>({ objects: { q: { id: 'q', name: 'Old-client shard', type: 'system' } } })
      await overflow.whenReady()
      await ws.repo.flush([overflow.documentId])
      await claim(String(overflow.documentId))
      currentMeta.change((m) => { ;(m.objectShardUrls as string[]).push(overflow.url) })
      // The lean pass: neither compensated nor adopted.
      const leanReport = await lean.run()
      expect(leanReport).toMatchObject({ outcome: 'ran' })
      expect((leanReport as { dedupe?: unknown[] }).dedupe).toBeUndefined()
      expect((leanReport as { mirrorAdopted?: unknown[] }).mirrorAdopted).toBeUndefined()
      expect(dups()).toBe(2)
      expect(readMetaUrls(currentMeta.doc(), 'objectShardUrls')).not.toContain(overflow.url)
      // The next full pass (the periodic sweep, S9, compaction) does both.
      const fullReport = await full.run()
      expect((fullReport as { dedupe?: unknown[] }).dedupe).toHaveLength(1)
      expect((fullReport as { mirrorAdopted?: string[] }).mirrorAdopted).toEqual([overflow.url])
      expect(dups()).toBe(1)
    } finally { lean.release(); full.release(); projector.stop() }
  })

  it('an old client\'s append that lands DURING the adoption\'s flush is adopted by the next pass, not skipped', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentMeta } = await rolled(ws)
    const shard = async (id: string) => {
      const h = ws.repo.create<Shard>({ objects: { [id]: { id, name: id, type: 'system' } } })
      await h.whenReady()
      await ws.repo.flush([h.documentId])
      await claim(String(h.documentId))
      return h
    }
    const first = await shard('q1')
    const second = await shard('q2')
    // The second append arrives while the forwarder awaits the meta's flush.
    let armed = false
    const repo = new Proxy(ws.repo, {
      get(target, prop) {
        if (prop === 'flush') {
          return async (ids?: string[]) => {
            if (armed && ids?.includes(String(currentMeta.documentId))) {
              armed = false
              currentMeta.change((m) => { ;(m.objectShardUrls as string[]).push(second.url) })
            }
            return target.flush(ids as never)
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    })
    const f = await forwarder(ws, projector.instance(), { repo })
    try {
      await f.run()
      currentMeta.change((m) => { ;(m.objectShardUrls as string[]).push(first.url) })
      armed = true
      const report = await f.run()
      expect(armed).toBe(false)
      expect((report as { mirrorAdopted?: string[] }).mirrorAdopted).toEqual([first.url])
      const next = await f.run()
      expect((next as { mirrorAdopted?: string[] }).mirrorAdopted).toEqual([second.url])
      expect(readMetaUrls(currentMeta.doc(), 'objectShardUrls')).toEqual(expect.arrayContaining([first.url, second.url]))
    } finally { f.release(); projector.stop() }
  })

  it('the sweep between passes: no epoch row → one probe; with rows → forwarded under the resident fence, then retirement', async () => {
    const ws = await workspace(storageRepo())
    const sweepDeps = (instance: string | null) => ({
      repo: ws.repo, db: db.pool, connect: () => db.pool.connect(),
      residentProjectorInstanceId: () => instance, owns: () => true, isShuttingDown: () => false,
      instanceId: 'cell-a', retire: { retain: 3, periodDays: 30 },
    })
    expect(await sweepModelEpochs(WS, sweepDeps('x'))).toEqual({ outcome: 'no_epoch_rows' })
    const { projector, currentBase } = await rolled(ws)
    try {
      expect(await sweepModelEpochs(WS, sweepDeps(null))).toEqual({ outcome: 'not_resident' })
      marieSyncs(ws, (d) => { d.objects.c!.name = 'Swept C' })
      const swept = await sweepModelEpochs(WS, sweepDeps(projector.instance()))
      expect(swept).toMatchObject({ outcome: 'swept', forwarded: { outcome: 'ran' }, retired: { retiring: [] } })
      expect(currentBase.doc()!.objects.c!.name).toBe('Swept C')
    } finally { projector.stop() }
  })

  it('the FORWARD-ONLY sweep (the event-driven pass) never retires; the periodic one does', async () => {
    const ws = await workspace(storageRepo())
    const { projector } = await rolled(ws)
    try {
      // retain 0: every superseded document is retirable at once.
      const deps = (forwardOnly: boolean) => ({
        repo: ws.repo, db: db.pool, connect: () => db.pool.connect(),
        residentProjectorInstanceId: () => projector.instance(), owns: () => true, isShuttingDown: () => false,
        instanceId: 'cell-a', retire: { retain: 0, periodDays: 30 }, ...(forwardOnly ? TRIGGERED_SWEEP : {}),
      })
      const stateOf = async () => (await db.pool.query<{ state: string }>(
        'SELECT state FROM read_model_model_epoch_docs WHERE document_id = $1', [String(ws.base.documentId)])).rows[0]!.state
      const triggered = await sweepModelEpochs(WS, deps(true))
      expect(triggered).toMatchObject({ outcome: 'swept', retired: { outcome: 'skipped_forward_only' } })
      expect(await stateOf()).toBe('live')
      // Retirement and the purge
      // have no safe point — each runs MARKED (`unyielding`), and the mark
      // is up for the phase's whole run.
      // Each phase is
      // NAMED by its caller — the text mirror too — and the test requires
      // all three, each marked while it runs (the mark held across it).
      let marked = 0
      const phases: string[] = []
      const unyielding = async <T>(phase: () => Promise<T>, name?: string): Promise<T> => {
        marked += 1
        try {
          const value = await phase()
          phases.push(`${name ?? 'unnamed'}:${marked}`)
          return value
        } finally { marked -= 1 }
      }
      const periodic = await sweepModelEpochs(WS, { ...deps(false), unyielding })
      expect(periodic).toMatchObject({ outcome: 'swept' })
      expect((periodic as { retired: { retiring?: string[] } }).retired.retiring).toContain(String(ws.base.documentId))
      expect(await stateOf()).toBe('retiring')
      expect([...new Set(phases)].sort()).toEqual(['mirror:1', 'purge:1', 'retire:1'])
      expect(marked).toBe(0)
    } finally { projector.stop() }
  })

  it('with a pool of 10, compaction and the sweep never overlap, the sweep fits in 4 connections, and an HTTP query always gets one', async () => {
    const ws = await workspace(storageRepo())
    const { projector } = await rolled(ws)
    const pool10 = guardIdleClientErrors(new pg.Pool({ connectionString: connection, max: 10, options: `-c search_path=${db.schema}`, connectionTimeoutMillis: 2_000 }), 'test:pool10')
    let peak = 0
    const sampler = setInterval(() => { peak = Math.max(peak, pool10.totalCount - pool10.idleCount) }, 1)
    try {
      const exclusion = createProcessExclusion()
      const sweepDeps = {
        repo: ws.repo, db: pool10, connect: () => pool10.connect(),
        residentProjectorInstanceId: () => projector.instance(), owns: () => true, isShuttingDown: () => false,
        instanceId: 'cell-a', retire: { retain: 3, periodDays: 30 }, exclusion,
      }
      // THE SWEEP ALONE: four connections at most — object, connection,
      // model-epoch, one plain query; its fenced transactions ride the
      // object key's client (a fifth, own client was the old shape).
      marieSyncs(ws, (d) => { d.objects.c!.name = 'Pool C' })
      peak = 0
      expect(await sweepModelEpochs(WS, sweepDeps)).toMatchObject({ outcome: 'swept', forwarded: { outcome: 'ran' } })
      expect(peak).toBeLessThanOrEqual(4)
      // BOTH AT ONCE, as the timers can fire: compaction holds the slot, the sweep is skipped.
      expect((await acknowledged()).acknowledged).toBe(true)
      peak = 0
      const pass = exclusion.run(() => runWorkspaceCompaction(WS, { ...passDeps(ws, projector.fleet), db: pool10, connect: () => pool10.connect() }))
      const sweep = sweepModelEpochs(WS, sweepDeps)
      // …while the HTTP path keeps asking the same pool for a connection.
      const probes: Array<Promise<number>> = []
      for (let i = 0; i < 20; i += 1) {
        const started = Date.now()
        probes.push(pool10.query('SELECT 1').then(() => Date.now() - started))
        await new Promise((r) => setTimeout(r, 10))
      }
      const [outcome, swept, waits] = await Promise.all([pass, sweep, Promise.all(probes)])
      expect(swept).toMatchObject({ outcome: 'busy' })
      expect(outcome.result.skippedReason).toBeUndefined()
      expect(Math.max(...waits)).toBeLessThan(2_000) // never the connection timeout an HTTP route would 500 on
      expect(peak).toBeLessThanOrEqual(7)
    } finally {
      clearInterval(sampler)
      await pool10.end()
      projector.stop()
    }
  }, 60_000)

  it('the sweep\'s forwarder runs under BOTH overlay-rotation keys — skipped while one is held, in the registered order otherwise', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    // Every statement of every client the sweep opens, in issue order.
    const recordingConnect = async () => {
      const client = await db.pool.connect()
      const query = client.query.bind(client)
      const release = client.release.bind(client)
      ;(client as { query: unknown }).query = (sql: unknown, params?: unknown[]) => {
        calls.push({ sql: typeof sql === 'string' ? sql : String((sql as { text?: string }).text), params })
        return (query as (...a: unknown[]) => unknown)(sql, params)
      }
      ;(client as { release: unknown }).release = (error?: unknown) => {
        ;(client as { query: unknown }).query = query
        ;(client as { release: unknown }).release = release
        return release(error as never)
      }
      return client
    }
    const sweepDeps = {
      repo: ws.repo, db: db.pool, connect: recordingConnect,
      residentProjectorInstanceId: () => projector.instance(), owns: () => true, isShuttingDown: () => false,
      instanceId: 'cell-a', retire: { retain: 3, periodDays: 30 },
    }
    // A fold or a compaction pass holds the object key.
    let holder: Awaited<ReturnType<typeof db.pool.connect>> | null = await db.pool.connect()
    try {
      marieSyncs(ws, (d) => { d.objects.c!.name = 'Swept under the keys' })
      await holder.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0))', [overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object')])
      const skipped = await sweepModelEpochs(WS, sweepDeps)
      expect(skipped).toMatchObject({ outcome: 'swept', forwarded: { outcome: 'overlay_rotation_lock_contended', kind: 'object', state: 'refused' } })
      expect(currentBase.doc()!.objects.c!.name).toBe('Base C') // nothing forwarded beside the holder
      expect(await journals()).toEqual([])
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object')])
      holder.release() // the test pool is small: the sweep needs every slot
      holder = null
      calls.length = 0
      const swept = await sweepModelEpochs(WS, sweepDeps)
      expect(swept).toMatchObject({ outcome: 'swept', forwarded: { outcome: 'ran' } })
      expect(currentBase.doc()!.objects.c!.name).toBe('Swept under the keys')
      // The lock-order scanners over the real stream: the one registered edge.
      const edges = modelEpochRotationEdges(calls)
      expect(edges.violations).toEqual([])
      // The forwarder's and then retirement's model-epoch hold, both under the rotation keys.
      expect(edges.edges).toEqual([{ direction: 'rotation→model-epoch', form: 'try' }, { direction: 'rotation→model-epoch', form: 'try' }])
      expect(projectionInboundEdges(calls)).toEqual([])
      expect(unknownAdvisoryKeys(calls)).toEqual([])
    } finally { holder?.release(); projector.stop() }
  })

  it('a late edit to an object the current epoch DELETED (shown again by a provisional shard) is not recreated — it becomes an `entity-deleted` override row, a re-apply line for its writer', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    const f = await forwarder(ws, projector.instance())
    try {
      // Paul deletes c in the current epoch; Marie, on the old one, edits it.
      currentBase.change((d) => { delete d.objects.c })
      marieSyncs(ws, (d) => { d.objects.c!.name = 'Marie edits a deleted C' })
      await f.run()
      expect(currentBase.doc()!.objects.c).toBeUndefined() // the current epoch wins
      const rows = await listOverridesForActors(db.pool, WS, ['aa'.repeat(16)])
      expect(rows.map((r) => [r.entityKind, r.entityId, r.path, r.reason, r.currentValueAtForward])).toEqual([
        ['object', 'c', ['objects', 'c'], 'entity-deleted', null],
      ])
      expect(rows[0]!.lateValue).toMatchObject({ id: 'c', name: 'Marie edits a deleted C' })
      // Marie's OTHER tab (another actor) is
      // offered the row once one of her tabs asked with its actor — the
      // user's actors, per workspace; another user is not.
      const otherTab = 'cc'.repeat(16)
      expect(await listOverridesForActors(db.pool, WS, await overrideActorsOfUser(db.pool, WS, 'marie', [otherTab]))).toEqual([])
      expect(await overrideActorsOfUser(db.pool, WS, 'marie', ['aa'.repeat(16)])).toEqual(['aa'.repeat(16), otherTab])
      const mine = await overrideActorsOfUser(db.pool, WS, 'marie', [otherTab])
      expect(mine.sort()).toEqual(['aa'.repeat(16), otherTab].sort())
      expect((await listOverridesForActors(db.pool, WS, mine)).map((r) => r.id)).toEqual(rows.map((r) => r.id))
      expect(await overrideActorsOfUser(db.pool, WS, 'paul', [])).toEqual([])
      expect(await overrideActorsOfUser(db.pool, { ...WS, versionId: 'other' }, 'marie', [])).toEqual([])
    } finally { f.release(); projector.stop() }
  })

  it('a leaf the current epoch WON becomes an override row for the late writer\'s actors only; resolved and reverted by batch id', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    const f = await forwarder(ws, projector.instance())
    try {
      // Paul, current epoch, renames c; Marie, offline on the old one, too.
      currentBase.change((d) => { d.objects.c!.name = 'Paul C' })
      marieSyncs(ws, (d) => { d.objects.c!.name = 'Marie C'; d.objects.c!.type = 'container' })
      await f.run()
      expect(currentBase.doc()!.objects.c).toMatchObject({ name: 'Paul C', type: 'container' }) // the current epoch wins
      const marie = 'aa'.repeat(16)
      const rows = await listOverridesForActors(db.pool, WS, [marie])
      expect(rows.map((r) => [r.entityKind, r.entityId, r.path, r.reason, r.lateValue, r.currentValueAtForward])).toEqual([
        ['object', 'c', ['objects', 'c', 'name'], 'leaf', 'Marie C', 'Paul C'],
      ])
      expect(rows[0]!.currentHeadsAtForward).toHaveLength(1)
      expect(await listOverridesForActors(db.pool, WS, ['bb'.repeat(16)])).toEqual([]) // not Paul's, not anyone else's
      // A replay of the completion inserts nothing twice (deterministic id).
      const batch = '0b4e1f3a-6c1d-4d43-9a2e-5b8f7c6d5e4f'
      expect(await resolveOverrides(db.pool, WS, { batchId: batch, reapplied: [rows[0]!.id], dismissed: [] }, 'marie')).toEqual({ reapplied: 1, dismissed: 0, reverted: 0 })
      expect(await listOverridesForActors(db.pool, WS, [marie])).toEqual([])
      // Resolving the same batch again moves nothing; undo returns the row.
      expect((await resolveOverrides(db.pool, WS, { batchId: batch, reapplied: [rows[0]!.id], dismissed: [] }, 'marie')).reapplied).toBe(0)
      // A revert checks `resolved_by` — another user naming
      // the batch id undoes nothing.
      expect(await resolveOverrides(db.pool, WS, { revert: batch }, 'paul')).toEqual({ reapplied: 0, dismissed: 0, reverted: 0 })
      expect(await listOverridesForActors(db.pool, WS, [marie])).toEqual([])
      expect(await resolveOverrides(db.pool, WS, { revert: batch }, 'marie')).toEqual({ reapplied: 0, dismissed: 0, reverted: 1 })
      expect((await listOverridesForActors(db.pool, WS, [marie])).map((r) => r.id)).toEqual([rows[0]!.id])
      // …and a DISMISSAL carries its batch id, so it can be undone too.
      const dismissBatch = '1c5f2a4b-7d2e-4e54-8b3f-6c9a8d7e6f50'
      expect(await resolveOverrides(db.pool, WS, { batchId: dismissBatch, reapplied: [], dismissed: [rows[0]!.id] }, 'marie')).toEqual({ reapplied: 0, dismissed: 1, reverted: 0 })
      expect(await listOverridesForActors(db.pool, WS, [marie])).toEqual([])
      expect(await resolveOverrides(db.pool, WS, { revert: dismissBatch }, 'marie')).toEqual({ reapplied: 0, dismissed: 0, reverted: 1 })
      expect((await listOverridesForActors(db.pool, WS, [marie])).map((r) => r.id)).toEqual([rows[0]!.id])
      expect(parseResolveRequest({ batchId: 'not-a-uuid', reapplied: [] })).toBeNull()
    } finally { f.release(); projector.stop() }
  })

  it('a late -0 is forwarded as 0 and COUNTED, never silently', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    const log: Array<Record<string, unknown>> = []
    const f = await forwarder(ws, projector.instance(), { log: (e) => log.push(e) })
    try {
      // A scalar put cannot store -0 (it stores int 0); a nested literal
      // stores f64 -0. Marie REPLACES `c.stats` by a literal holding -0: the
      // target keeps its own `stats` map, and the leaf `s` is a scalar put.
      marieSyncs(ws, (d) => { d.objects.c!.stats = { s: -0 } })
      const report = await f.run()
      const source = (report as { sources: Array<{ documentId: string; negativeZeroAsZero?: number }> }).sources
        .find((s) => s.documentId === String(ws.base.documentId))!
      expect(source.negativeZeroAsZero).toBe(1)
      expect(log.find((e) => e.event === 'model_epoch.forward.negative_zero_as_zero')).toMatchObject({ count: 1 })
      expect(Object.is((currentBase.doc()!.objects.c!.stats as { s: number }).s, 0)).toBe(true)
    } finally { f.release(); projector.stop() }
  })

  it('a sweep past its BUDGET, or with a compaction WAITING, stops at the first safe point — nothing forwarded, retirement skipped — and the next sweep finishes', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    const log: Array<Record<string, unknown>> = []
    const sweepDeps = (over: Record<string, unknown> = {}) => ({
      repo: ws.repo, db: db.pool, connect: () => db.pool.connect(),
      residentProjectorInstanceId: () => projector.instance(), owns: () => true, isShuttingDown: () => false,
      instanceId: 'cell-a', retire: { retain: 3, periodDays: 30 }, log: (e: Record<string, unknown>) => log.push(e), ...over,
    })
    try {
      marieSyncs(ws, (d) => { d.objects.c!.name = 'Budget C' })
      // A writes-log row no reader needs (past the
      // window, before every publication) — purged by the periodic sweep
      // even when its forwarder YIELDS; never by the forward-only pass.
      const oldWrite = () => db.pool.query(
        `INSERT INTO read_model_model_epoch_forward_writes (journal_id, target_document_id, landscape_id, version_id, message, change_hash, heads_before, written_at)
         VALUES ('j-old', 'purge-t', $1, $2, 'm', 'h-old', '{}', now() - interval '400 days') ON CONFLICT DO NOTHING`, [WS.landscapeId, WS.versionId])
      await oldWrite()
      expect(await sweepModelEpochs(WS, sweepDeps({ budgetMs: 0, forwardOnly: true }))).not.toHaveProperty('purgedWrites')
      expect(await sweepModelEpochs(WS, sweepDeps({ budgetMs: 0 }))).toMatchObject({
        outcome: 'swept', forwarded: { outcome: 'ran', sources: [], yielded: 'budget' }, retired: { outcome: 'yielded', reason: 'budget' },
        purgedWrites: 1,
      })
      expect(currentBase.doc()!.objects.c!.name).toBe('Base C')
      expect(log.find((e) => e.event === 'model_epoch.forward.yielded')).toMatchObject({ reason: 'budget' })
      // A compaction pass queued on the slot: the sweep yields to it.
      const waitedOn = { ...createProcessExclusion(), waiting: () => 1 }
      expect(await sweepModelEpochs(WS, sweepDeps({ exclusion: waitedOn }))).toMatchObject({
        outcome: 'swept', forwarded: { yielded: 'preempted' }, retired: { outcome: 'yielded', reason: 'preempted' },
      })
      expect(currentBase.doc()!.objects.c!.name).toBe('Base C')
      // The next sweep, within its budget and alone: carried — and the
      // writes log purged.
      await oldWrite()
      expect(await sweepModelEpochs(WS, sweepDeps())).toMatchObject({ outcome: 'swept', forwarded: { outcome: 'ran' }, retired: { retiring: [] }, purgedWrites: 1 })
      expect(currentBase.doc()!.objects.c!.name).toBe('Budget C')
    } finally { projector.stop() }
  })

  it('an URGENT pass with a grace is NOT preempted by a waiter before it — it forwards', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    const sweepDeps = (over: Record<string, unknown> = {}) => ({
      repo: ws.repo, db: db.pool, connect: () => db.pool.connect(),
      residentProjectorInstanceId: () => projector.instance(), owns: () => true, isShuttingDown: () => false,
      instanceId: 'cell-a', retire: { retain: 3, periodDays: 30 }, forwardOnly: true, ...over,
    })
    try {
      marieSyncs(ws, (d) => { d.objects.c!.name = 'Grace C' })
      const waitedOn = { ...createProcessExclusion(), waiting: () => 1 }
      expect(await sweepModelEpochs(WS, sweepDeps({ exclusion: waitedOn, yieldGraceMs: 60_000 }))).toMatchObject({
        outcome: 'swept', forwarded: { outcome: 'ran', sources: expect.arrayContaining([expect.objectContaining({ outcome: 'forwarded' })]) },
      })
      expect(currentBase.doc()!.objects.c!.name).toBe('Grace C')
    } finally { projector.stop() }
  })

  it('the grace ENDS — past it, a waiter preempts the urgent pass at its next safe point, long before its budget', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    // The sweep's clock: its start, then 5 s later at every safe point.
    let started = false
    const now = () => { if (!started) { started = true; return Date.now() } return Date.now() + 5_000 }
    try {
      marieSyncs(ws, (d) => { d.objects.c!.name = 'Grace over C' })
      const waitedOn = { ...createProcessExclusion(), waiting: () => 1 }
      expect(await sweepModelEpochs(WS, {
        repo: ws.repo, db: db.pool, connect: () => db.pool.connect(),
        residentProjectorInstanceId: () => projector.instance(), owns: () => true, isShuttingDown: () => false,
        instanceId: 'cell-a', retire: { retain: 3, periodDays: 30 }, forwardOnly: true,
        exclusion: waitedOn, yieldGraceMs: 2_000, budgetMs: 60_000, now,
      })).toMatchObject({ outcome: 'swept', forwarded: { outcome: 'ran', sources: [], yielded: 'preempted' } })
      expect(currentBase.doc()!.objects.c!.name).toBe('Base C')
    } finally { projector.stop() }
  })

  it('a sweep that WAITED for the slot while a compaction rebuilt the projector forwards under the NEW fence', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    try {
      marieSyncs(ws, (d) => { d.objects.c!.name = 'After rebuild C' })
      const before = projector.instance()
      const exclusion = createProcessExclusion()
      // The compaction: holds the slot until the sweep waits behind it, then
      // detaches the projector and rebuilds the read model (a NEW instance).
      const compaction = exclusion.run(async () => {
        await until(() => exclusion.waiting(), (n) => n >= 1, 10_000)
        projector.stop()
        await projector.start()
        await acknowledged()
      })
      const swept = await sweepModelEpochs(WS, {
        repo: ws.repo, db: db.pool, connect: () => db.pool.connect(),
        residentProjectorInstanceId: () => projector.instance(), owns: () => true, isShuttingDown: () => false,
        instanceId: 'cell-a', retire: { retain: 3, periodDays: 30 }, forwardOnly: true,
        exclusion, exclusionWaitMs: 30_000,
      })
      await compaction
      expect(projector.instance()).not.toBe(before)
      expect(swept).toMatchObject({ outcome: 'swept', forwarded: { outcome: 'ran', sources: expect.arrayContaining([expect.objectContaining({ outcome: 'forwarded' })]) } })
      expect(currentBase.doc()!.objects.c!.name).toBe('After rebuild C')
    } finally { projector.stop() }
  })

  it('a flush that HANGS fails that source at its ceiling — the pass ends, the journal stays, the replay writes once', async () => {
    const ws = await workspace(storageRepo())
    const { projector, currentBase } = await rolled(ws)
    const flush = ws.repo.flush.bind(ws.repo)
    const f = await forwarder(ws, projector.instance(), { flushTimeoutMs: 100 })
    try {
      marieSyncs(ws, (d) => { ;(d.objects.c!.tags as string[]).push('hung') })
      ws.repo.flush = () => new Promise<void>(() => {})
      const started = Date.now()
      const report = await f.run()
      expect(Date.now() - started).toBeLessThan(10_000)
      const source = (report as { sources: Array<{ documentId: string; outcome: string; error?: string }> }).sources
        .find((s) => s.documentId === String(ws.base.documentId))!
      expect(source).toMatchObject({ outcome: 'failed', error: expect.stringContaining('ForwardFlushTimeout') })
      expect(await journals()).toHaveLength(1)
      ws.repo.flush = flush
      await f.run()
      expect(await journals()).toEqual([])
      expect([...(currentBase.doc()!.objects.c!.tags as string[])]).toEqual(['x', 'hung'])
    } finally { ws.repo.flush = flush; f.release(); projector.stop() }
  })

  it('a dedupe sweep that yields RESUMES with the least recently checked row, not the oldest again', async () => {
    const repo = storageRepo()
    const meta = repo.create<Meta>({ groups: {} })
    await meta.whenReady()
    await db.pool.query(
      `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, meta_url, published_at)
       VALUES ($1, $2, 0, 'legacy', 'published', $3, now())`, [WS.landscapeId, WS.versionId, meta.url])
    // Three completed forwards inside the window, oldest first; their targets
    // are gone (the sweep logs and moves on — it still CHECKED them).
    const targets = [0, 1, 2].map(() => generateAutomergeUrl().replace(/^automerge:/, ''))
    for (const [i, target] of targets.entries()) {
      await db.pool.query(
        `INSERT INTO read_model_model_epoch_forward_writes
           (journal_id, target_document_id, landscape_id, version_id, message, change_hash, heads_before, written_at)
         VALUES ($1, $2, $3, $4, 'm', 'h', '{}', now() - ($5::int * interval '1 minute'))`,
        [`j${i}`, target, WS.landscapeId, WS.versionId, 30 - i])
    }
    // One dedupe row per pass, then the budget is spent.
    const onePerPass = () => {
      let calls = 0
      return () => (calls++ >= 1 ? 'budget' as const : null)
    }
    // Every statement run under the write fence, recorded.
    const fencedSql: string[] = []
    const fencedTx: FencedTransaction = (fn) => fn({
      query: (sql: string, params?: unknown[]) => { fencedSql.push(sql); return db.pool.query(sql, params) },
    } as never)
    const run = () => forwardModelEpochLateWrites({
      repo, key: WS, db: db.pool, connect: () => db.pool.connect(), fenced: fencedTx,
      instanceId: 'cell-a', mayWrite: () => true, findTimeoutMs: 200, shouldYield: onePerPass(),
    })
    const checked = async () => (await db.pool.query<{ journal_id: string; checked: boolean }>(
      'SELECT journal_id, dedupe_checked_at IS NOT NULL AS checked FROM read_model_model_epoch_forward_writes ORDER BY journal_id')).rows
    expect(await run()).toMatchObject({ outcome: 'ran', yielded: 'budget' })
    expect(await checked()).toEqual([{ journal_id: 'j0', checked: true }, { journal_id: 'j1', checked: false }, { journal_id: 'j2', checked: false }])
    expect(await run()).toMatchObject({ yielded: 'budget' })
    expect(await checked()).toEqual([{ journal_id: 'j0', checked: true }, { journal_id: 'j1', checked: true }, { journal_id: 'j2', checked: false }])
    // The scheduling stamp is written FENCED, once per pass.
    expect(fencedSql.filter((sql) => sql.includes('dedupe_checked_at'))).toHaveLength(2)
    await repo.shutdown()
  })

  it('sweeps skipped behind ONE long hold of the pool-heavy slot are ALERTED — once per hold, again for the next', async () => {
    await db.pool.query(
      `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, meta_url, published_at)
       VALUES ($1, $2, 0, 'legacy', 'published', 'automerge:m0', now())`, [WS.landscapeId, WS.versionId])
    let t = 0
    const exclusion = createProcessExclusion(() => t)
    const log: Array<Record<string, unknown>> = []
    const sweepDeps = {
      repo: storageRepo(), db: db.pool, connect: () => db.pool.connect(),
      residentProjectorInstanceId: () => 'resident', owns: () => true, isShuttingDown: () => false,
      instanceId: 'cell-a', retire: { retain: 3, periodDays: 30 }, exclusion, now: () => t, starvedAlertMs: 1_000,
      log: (e: Record<string, unknown>) => log.push(e),
    }
    const starved = () => log.filter((e) => e.event === 'model_epoch.sweep.starved')
    let release!: () => void
    const hung = exclusion.run(() => new Promise<void>((resolve) => { release = resolve }))
    t = 500
    expect(await sweepModelEpochs(WS, sweepDeps)).toEqual({ outcome: 'busy', heldForMs: 500 })
    expect(starved()).toEqual([])
    t = 1_500
    expect(await sweepModelEpochs(WS, sweepDeps)).toEqual({ outcome: 'busy', heldForMs: 1_500 })
    expect(await sweepModelEpochs(WS, sweepDeps)).toEqual({ outcome: 'busy', heldForMs: 1_500 })
    expect(starved()).toEqual([expect.objectContaining({ alert: true, heldForMs: 1_500 })])
    release()
    await hung
    // A NEW hold, as long: alerted again.
    const second = exclusion.run(() => new Promise<void>((resolve) => { release = resolve }))
    t = 3_000
    await sweepModelEpochs(WS, sweepDeps)
    expect(starved()).toHaveLength(2)
    release()
    await second
    await sweepDeps.repo.shutdown()
  })

  it('after --adopt-root, a late list DELETE and INSERT on the predecessor meta never replay by identity into the adopted foreign meta', async () => {
    const repo = storageRepo()
    const members = ['a', 'b', 'c']
    const group = (list: string[]) => ({ groups: { g0: { id: 'g0', name: 'G0', members: list } } })
    const predecessor = repo.create<Meta>(group(members))
    const stuckMeta = repo.create<Meta>(group(members))
    // The root's FOREIGN meta (a script's): born with ANOTHER list — an
    // element in front — so element k at its birth is not element k at the cut.
    const foreign = repo.create<Meta>(group(['x', ...members]))
    await Promise.all([predecessor, stuckMeta, foreign].map((h) => h.whenReady()))
    await repo.flush()
    const headsOf = (h: DocHandle<Meta>) => [...A.getHeads(h.doc() as A.Doc<unknown>)]
    const cut = headsOf(predecessor)
    const birth = [A.decodeChange(A.getAllChanges(stuckMeta.doc() as A.Doc<unknown>)[0]!).hash!]
    await db.pool.query(
      `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, meta_url, published_at)
       VALUES ($1, $2, 0, 'legacy', 'published', $3, now())`, [WS.landscapeId, WS.versionId, predecessor.url])
    await db.pool.query(
      `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role)
       VALUES ($1, $2, $3, 0, 'meta')`, [String(predecessor.documentId), WS.landscapeId, WS.versionId])
    await db.pool.query(
      `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, cut_heads)
       VALUES ($1, $2, 1, 'full', 'repointing', 0, $3, $4::jsonb)`,
      [WS.landscapeId, WS.versionId, stuckMeta.url, JSON.stringify({ [predecessor.url]: cut })])
    // `--adopt-root`'s rows, as `resolveStuckRepointing` hands them over.
    await sqlEpochRowStore((fn) => fn(db.pool), WS).adoptRoot({
      stuck: 1, predecessor: 0, epochNo: 2, metaUrl: foreign.url, cutHeads: { [foreign.url]: headsOf(foreign) },
      docs: [
        { url: predecessor.url, role: 'meta', slot: null, createdEpoch: 0, supersededCursor: cut },
        { url: stuckMeta.url, role: 'meta', slot: null, createdEpoch: 1, supersededCursor: birth },
        { url: foreign.url, role: 'meta', slot: null, createdEpoch: 2, supersededCursor: null },
      ],
    })
    const { rows: recorded } = await db.pool.query<{ built_from_cut: boolean }>(
      'SELECT built_from_cut FROM read_model_model_epoch_docs WHERE document_id = $1', [String(foreign.documentId)])
    expect(recorded[0]?.built_from_cut).toBe(false)
    // Marie, late on the predecessor: deletes `b`, appends `m`.
    predecessor.change((m) => {
      const list = ((m.groups as Record<string, { members: string[] }>).g0!).members
      list.deleteAt(1)
      list.push('m')
    })
    await repo.flush()
    const report = await forwardModelEpochLateWrites({
      repo, key: WS, db: db.pool, connect: () => db.pool.connect(), fenced: (fn) => fn(db.pool),
      instanceId: 'cell-a', mayWrite: () => true,
    })
    expect((report as { sources: Array<{ documentId: string; outcome: string }> }).sources
      .find((s) => s.documentId === String(predecessor.documentId))?.outcome).toBe('forwarded')
    // THE NON-ALIGNED PATH: the list is one leaf the current epoch won
    // — nothing deleted by position. Aligned, `a` (element 1 at the foreign
    // meta's birth) would have been deleted instead of `b`.
    const list = ((foreign.doc()!.groups as Record<string, { members: string[] }>).g0!).members
    expect([...list]).toEqual(['x', 'a', 'b', 'c'])
    const { rows: overrides } = await db.pool.query<{ reason: string }>(
      'SELECT reason FROM read_model_model_epoch_overrides WHERE source_doc = $1', [String(predecessor.documentId)])
    expect(overrides.map((r) => r.reason)).toEqual(['leaf'])
    await repo.shutdown()
  })

  it('an ADOPTED overflow shard (slot NULL) is never an aligned target of a superseded adopted source (slot NULL)', async () => {
    const repo = storageRepo()
    const shard = (tags: string[]) => ({ objects: { o: { id: 'o', name: 'O', type: 'system', tags } } })
    const source = repo.create<Shard>(shard(['a', 'b', 'c']))
    // The overflow shard a browser appended to the current epoch, adopted: born
    // holding `o` with ANOTHER list.
    const overflow = repo.create<Shard>(shard(['x', 'a', 'b', 'c']))
    const meta = repo.create<Meta>({ groups: {} })
    await Promise.all([source, overflow, meta].map((h) => h.whenReady()))
    await repo.flush()
    const cut = [...A.getHeads(source.doc() as A.Doc<unknown>)]
    await db.pool.query(
      `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, published_at)
       VALUES ($1, $2, 0, 'legacy', 'retained', NULL, 'automerge:m0', now()),
              ($1, $2, 1, 'meta', 'published', 0, $3, now())`, [WS.landscapeId, WS.versionId, meta.url])
    for (const [id, role, created, superseded, cursor] of [
      [String(source.documentId), 'adopted', 0, 1, cut],
      [String(overflow.documentId), 'adopted', 1, null, null],
      [String(meta.documentId), 'meta', 1, null, null],
    ] as const) {
      await db.pool.query(
        `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role, superseded_epoch, forward_cursor)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[])`, [id, WS.landscapeId, WS.versionId, created, role, superseded, cursor])
    }
    source.change((d) => { (d.objects.o!.tags as string[]).deleteAt(1) })
    await repo.flush()
    await forwardModelEpochLateWrites({
      repo, key: WS, db: db.pool, connect: () => db.pool.connect(), fenced: (fn) => fn(db.pool),
      instanceId: 'cell-a', mayWrite: () => true,
    })
    // Not replayed by position (that would delete `a`): the current epoch wins.
    expect([...(overflow.doc()!.objects.o!.tags as string[])]).toEqual(['x', 'a', 'b', 'c'])
    await repo.shutdown()
  })
})

const sourceOutcome = (report: unknown, ws: World) =>
  (report as { sources: Array<{ documentId: string; outcome: string }> }).sources
    .find((s) => s.documentId === String(ws.base.documentId))?.outcome
