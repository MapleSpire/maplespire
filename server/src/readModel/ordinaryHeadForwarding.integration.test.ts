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

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import pg from 'pg'
import * as A from '@automerge/automerge'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { startReadModelProjector } from './projectorService.js'
import { commitForwardedHeads, recordOrdinaryHeadRetirement } from './ordinaryHeadForwarding.js'
import { collectAutomergeEntityConflicts, wholeEntityConflictIds } from './overlayHistoryProtocol.js'
import {
  ORDINARY_HEAD_ROTATION_OFF,
  type OrdinaryHeadRotationConfig,
} from './ordinaryHeadRotation.js'
import type { WorkspaceKey } from './projector.js'
import { projectionMutexKey } from './projectionAuthority.js'
import { withReadModelProjectionTransaction } from './projectionTransaction.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'

/**
 * Phase 2 of ordinary writer-head rotation, end to end: an in-process Repo,
 * the real ordinary projector, a real PostgreSQL schema. No rotator exists
 * yet, so each test plays the rotator by hand — a fresh current head, a
 * retirement row carrying H_r, ModelMeta repointed — and then plays the
 * offline client: a fork of the retired head taken BEFORE the rotation, edited
 * while "offline", merged back.
 *
 * Every test carries a witness that the path it names ran (D33): the
 * forwarder's own log line, `forwarded_heads` committed, the server's write
 * in the current head, or — for the paths that must NOT forward — the direct
 * projection's row.
 *
 * Isolated in its own schema (`rmohf_test`), DATABASE_URL like the sibling
 * `projectorService.integration.test.ts`; skips without a database.
 */
const WS: WorkspaceKey = { landscapeId: 'ls-ohf', versionId: 'v1' }
const SCHEMA = 'rmohf_test'
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({
    connectionString: URL, max: 4, connectionTimeoutMillis: 4000, options: `-c search_path=${SCHEMA},public`,
  }), 'ordinaryHeadForwarding')
  try {
    const c = await p.connect()
    try {
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
      const { ensureReadModelSchema } = await import('./schema.js')
      await ensureReadModelSchema(c)
    } finally {
      c.release()
    }
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[ordinaryHeadForwarding] no Postgres at ${URL} — skipping`)

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 6000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))

type Entity = { id: string; [field: string]: unknown }
type ObjHead = { objects: Record<string, Entity>; writeBatchIds: string[]; forwardedBatchIds?: string[] }
type ConnHead = { connections: Record<string, Entity>; writeBatchIds: string[]; forwardedBatchIds?: string[] }
type Meta = {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrl: string
  editsObjectShardUrls: string[]
  editsConnectionShardUrl: string
  editsConnectionShardUrls: string[]
  groups: Record<string, unknown>
  deletedObjectIds?: string[]
}

interface Workspace {
  repo: Repo
  rootUrl: string
  meta: DocHandle<Meta>
  retired: DocHandle<ObjHead>
  connHead: DocHandle<ConnHead>
}

const X0 = { id: 'x', name: 'X', f: 'f0', g: 'g0' }

async function workspace(retiredExtra: Partial<ObjHead> = {}): Promise<Workspace> {
  const repo = new Repo({})
  const base = repo.create({ objects: { b: { id: 'b', name: 'B' } } })
  const retired = repo.create<ObjHead>({ objects: { x: { ...X0 } }, writeBatchIds: ['r0'], ...retiredExtra })
  const connHead = repo.create<ConnHead>({
    connections: { c: { id: 'c', fromId: 'x', toId: 'b', label: 'l0', color: 'k0' } },
    writeBatchIds: [],
  })
  const meta = repo.create<Meta>({
    objectShardUrls: [base.url, retired.url],
    connectionShardUrls: [connHead.url],
    editsObjectShardUrl: retired.url,
    editsObjectShardUrls: [retired.url],
    editsConnectionShardUrl: connHead.url,
    editsConnectionShardUrls: [connHead.url],
    groups: {},
  })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
  await Promise.all([base, retired, connHead, meta, root].map((h) => h.whenReady()))
  return { repo, rootUrl: root.url, meta, retired, connHead }
}

type RowKind = 'retired' | 'admitted' | 'none'

/** The rotator, by hand: a durable empty child, then the row with H_r, then
 * the ModelMeta repoint — the order phase 3 must keep. */
async function rotate<T extends ObjHead | ConnHead>(
  ws: Workspace,
  collection: 'object' | 'connection',
  row: RowKind = 'retired',
): Promise<DocHandle<T>> {
  const old = collection === 'object' ? ws.retired : ws.connHead
  const child = ws.repo.create<T>((collection === 'object'
    ? { objects: {}, writeBatchIds: [] }
    : { connections: {}, writeBatchIds: [] }) as T)
  await child.whenReady()
  await ws.repo.flush([child.documentId])
  if (row !== 'none') {
    await recordOrdinaryHeadRetirement(pool!, WS, {
      collection,
      documentId: old.documentId,
      retirementHeads: row === 'retired' ? A.getHeads(old.doc() as A.Doc<unknown>) : null,
      status: row,
    })
  }
  ws.meta.change((m) => {
    if (collection === 'object') {
      m.editsObjectShardUrl = child.url
      m.objectShardUrls.push(child.url)
      m.editsObjectShardUrls.push(child.url)
    } else {
      m.editsConnectionShardUrl = child.url
      m.connectionShardUrls.push(child.url)
      m.editsConnectionShardUrls.push(child.url)
    }
  })
  return child
}

/** A client that was offline across the rotation: its copy of the retired
 * head stops at H_r, it edits that copy, and it reconnects. */
function offlineClient<T>(head: DocHandle<T>) {
  let fork = A.clone(head.doc() as A.Doc<T>)
  return {
    edit(write: (doc: T) => void) { fork = A.change(fork, write) },
    reconnect() { head.update((doc) => A.merge(doc, fork)) },
  }
}

const roObject = async (id: string) => (await pool!.query<{ data: Record<string, unknown> }>(
  'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
  [WS.landscapeId, WS.versionId, id],
)).rows[0]?.data
const roConnection = async (id: string) => (await pool!.query<{ data: Record<string, unknown> }>(
  'SELECT data FROM ro_connections WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
  [WS.landscapeId, WS.versionId, id],
)).rows[0]?.data
const roObjectRows = async () => (await pool!.query<{ id: string; data: unknown }>(
  'SELECT id, data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id',
  [WS.landscapeId, WS.versionId],
)).rows
const ackOf = async (batchId: string) => (await pool!.query<{ status: string; document_id: string }>(
  'SELECT status, document_id FROM read_model_overlay_batch_acks WHERE landscape_id = $1 AND version_id = $2 AND batch_id = $3',
  [WS.landscapeId, WS.versionId, batchId],
)).rows[0]
const forwardedHeadsOf = async (documentId: string) => (await pool!.query<{ forwarded_heads: string[] | null }>(
  `SELECT forwarded_heads FROM read_model_ordinary_head_retirements
   WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
  [WS.landscapeId, WS.versionId, documentId],
)).rows[0]?.forwarded_heads ?? null

/** Captures the forwarder's structured lines without hiding anything else
 * the test needs; read INSIDE the scope that owns the spy. */
function forwardLog() {
  const lines: Array<Record<string, unknown>> = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const first = args[0]
    if (typeof first !== 'string' || !first.startsWith('{')) return
    try {
      const parsed = JSON.parse(first) as Record<string, unknown>
      if (parsed.event === 'read_model.ordinary_head_forwarded') lines.push(parsed)
    } catch { /* not ours */ }
  })
  return { lines, restore: () => spy.mockRestore() }
}

async function start(ws: Workspace, opts: {
  config?: OrdinaryHeadRotationConfig
  stillOwned?: () => boolean
  onFenceLost?: () => void
} = {}) {
  const stop = await startReadModelProjector(
    ws.repo, ws.rootUrl, pool!, WS, undefined, 0, undefined,
    opts.stillOwned, opts.onFenceLost, undefined, opts.config ?? ORDINARY_HEAD_ROTATION_OFF,
  )
  return stop
}

const SHADOW_ALL: OrdinaryHeadRotationConfig = {
  mode: 'shadow', allowlist: 'all', maxActors: 128, maxChanges: 512,
}

suite('ordinary head forwarding (phase 2) — projector + PostgreSQL', () => {
  afterAll(async () => {
    const c = await pool!.connect()
    try {
      await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    } finally {
      c.release()
      await pool!.end()
    }
  })
  /**
   * A stopped projector's pass in flight still COMPLETES (by design, see
   * `runTracked`: only the write fence aborts one), so a test that ends with
   * `stop()` can leave a projection transaction open, or about to open,
   * into the next test. Measured: one was open (INSERT INTO ro_objects, the
   * content digest, ...) at a later beforeEach in every run of this file, on
   * develop as on G4-16. A bare TRUNCATE takes ACCESS EXCLUSIVE on its tables
   * in turn; such a transaction holding one and asking for another is a
   * deadlock (40P01), either side the victim — both were seen in one CI run.
   *
   * So every TRUNCATE here runs in a transaction that FIRST takes the
   * workspace's projection mutex, which every projection transaction takes
   * before it touches a table (`withReadModelProjectionTransaction`): a
   * straggler either holds it, and the TRUNCATE waits holding nothing, or
   * waits for it holding nothing — never the cycle, however late it starts.
   * One that starts after the TRUNCATE is fenced out (`readWriteFence`,
   * `assertReadModelWriteFence`): the beforeEach's TRUNCATE empties the fence
   * row, and the next projector's cold build claims it. This settles the
   * deadlock only; it does not make a stopped projector's late write vanish.
   */
  async function truncateUnderProjectionMutex(tables: string): Promise<void> {
    const client = await pool!.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [projectionMutexKey(WS)])
      await client.query(`TRUNCATE ${tables}`)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
  beforeEach(async () => {
    await truncateUnderProjectionMutex(`ro_objects, ro_connections, ro_groups, read_model_projection_state,
      read_model_change_events, read_model_overlay_batch_acks, read_model_overlay_entity_bases,
      read_model_ordinary_head_retirements, read_model_document_watermarks`)
  })

  it('THE SUITE\'S TRUNCATE: a projection transaction holding one of its tables and asking for another deadlocks a bare TRUNCATE, never the one under the projection mutex', async () => {
    // A straggler projection: the mutex first (as every projection takes it),
    // then a lock on `read_model_change_events`, then — once the TRUNCATE is
    // waiting — a read of `ro_objects`, which that TRUNCATE locked before.
    const straggler = () => withReadModelProjectionTransaction(pool!, WS, 'ordinary', async (tx) => {
      await tx.query('LOCK TABLE read_model_change_events IN ROW EXCLUSIVE MODE')
      await settle(300)
      await tx.query('SELECT count(*) FROM ro_objects')
    })
    const tables = 'ro_objects, ro_connections, read_model_change_events'
    // Control: the bare TRUNCATE, 100 ms into the straggler, deadlocks with it.
    const control = await Promise.allSettled([
      straggler(),
      settle(100).then(() => pool!.query(`TRUNCATE ${tables}`)),
    ])
    expect(control.filter((outcome) => outcome.status === 'rejected')
      .map((outcome) => (outcome as PromiseRejectedResult).reason?.code)).toEqual(['40P01'])
    // The helper, the same way: it waits for the mutex holding nothing, and
    // both complete.
    const outcomes = await Promise.allSettled([
      straggler(),
      settle(100).then(() => truncateUnderProjectionMutex(tables)),
    ])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
  })

  it.each([
    ['off (the default)', ORDINARY_HEAD_ROTATION_OFF],
    ['shadow, every workspace', SHADOW_ALL],
  ])('OFFLINE EDIT SURVIVES under %s: A sets x.f on the retired head after H_r, B sets x.g on the current head — both reach the head and ro_*, and ro_* equals a cold rebuild', async (_label, config) => {
    const ws = await workspace()
    const log = forwardLog()
    let stop = await start(ws, { config })
    try {
      const a = offlineClient(ws.retired)
      const current = await rotate<ObjHead>(ws, 'object')
      // B is online: its first write of x into the new head is the whole
      // entity as it sees it, plus its batch.
      current.change((d) => {
        d.objects.x = { ...X0, g: 'gB' }
        d.writeBatchIds.push('b1')
      })
      await until(() => roObject('x'), (x) => x?.g === 'gB')
      a.edit((d) => {
        d.objects.x.f = 'fA'
        d.writeBatchIds.push('a1')
      })
      a.reconnect()

      const x = await until(() => roObject('x'), (v) => v?.f === 'fA' && v?.g === 'gB')
      expect(x).toMatchObject({ f: 'fA', g: 'gB' })
      expect(current.doc().objects.x).toMatchObject({ f: 'fA', g: 'gB' })
      // The late batch is acknowledged by the CURRENT head's projection.
      expect(current.doc().forwardedBatchIds).toEqual(['a1'])
      expect(await until(() => ackOf('a1'), (ack) => ack?.status === 'projected')).toMatchObject({
        status: 'projected', document_id: current.documentId,
      })
      expect((await ackOf('b1'))?.status).toBe('projected')
      // Witnesses: the forwarder ran and committed exactly up to the retired head.
      expect(await until(() => forwardedHeadsOf(ws.retired.documentId), (h) => h !== null))
        .toEqual([...A.getHeads(ws.retired.doc() as A.Doc<unknown>)].sort())
      expect(log.lines.some((line) => (line.batchIdsAdded as string[]).includes('a1'))).toBe(true)
      // The retired head itself was never written by the server.
      expect(ws.retired.doc().forwardedBatchIds).toBeUndefined()

      await settle()
      const afterDeltas = await roObjectRows()
      const headsBefore = A.getHeads(current.doc() as A.Doc<unknown>)
      stop()
      // Cold rebuild: a new projector, a new cold build of the same documents.
      await truncateUnderProjectionMutex('ro_objects')
      stop = await start(ws, { config })
      await settle()
      expect(await roObjectRows()).toEqual(afterDeltas)
      // ...and its attach-time catch-up forward wrote nothing more.
      expect(A.getHeads(current.doc() as A.Doc<unknown>)).toEqual(headsBefore)
    } finally {
      stop()
      log.restore()
    }
  })

  it('a peer writing a field of the same entity INTO THE CURRENT HEAD concurrently keeps it (per-field forward, never a whole-entity copy)', async () => {
    const ws = await workspace()
    const log = forwardLog()
    const stop = await start(ws)
    try {
      const a = offlineClient(ws.retired)
      const current = await rotate<ObjHead>(ws, 'object')
      current.change((d) => { d.objects.x = { ...X0, g: 'gB' } })
      await until(() => roObject('x'), (x) => x?.g === 'gB')
      // B goes offline holding x as written, and sets x.h in its copy.
      const b = offlineClient(current)
      b.edit((d) => { d.objects.x.h = 'hB' })
      // A's late write is forwarded while B is away.
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      await until(() => current.doc().objects.x?.f, (f) => f === 'fA')
      b.reconnect()
      expect(current.doc().objects.x).toMatchObject({ f: 'fA', g: 'gB', h: 'hB' })
      expect(await until(() => roObject('x'), (x) => x?.h === 'hB' && x?.f === 'fA'))
        .toMatchObject({ f: 'fA', g: 'gB', h: 'hB' })
      expect(log.lines.length).toBeGreaterThan(0)
    } finally {
      stop()
      log.restore()
    }
  })

  it('at a same-field divergence the current head wins in ro_* AND in a cold rebuild — the retired head is not projected directly', async () => {
    const ws = await workspace()
    const log = forwardLog()
    let stop = await start(ws)
    try {
      const a = offlineClient(ws.retired)
      const current = await rotate<ObjHead>(ws, 'object')
      current.change((d) => { d.objects.x = { ...X0, g: 'gB' } })
      await until(() => roObject('x'), (x) => x?.g === 'gB')
      const currentHeads = A.getHeads(current.doc() as A.Doc<unknown>)
      // No batch id: nothing for the forwarder to write into the current head
      // at all, so the only way `gA` could reach ro_* is a direct projection.
      a.edit((d) => { d.objects.x.g = 'gA' })
      a.reconnect()
      expect(await until(() => forwardedHeadsOf(ws.retired.documentId), (h) => h !== null))
        .toEqual([...A.getHeads(ws.retired.doc() as A.Doc<unknown>)].sort())
      await settle()
      expect((await roObject('x'))?.g).toBe('gB')
      expect(A.getHeads(current.doc() as A.Doc<unknown>)).toEqual(currentHeads)
      expect(log.lines.at(-1)?.conflicts).toEqual([{ entityId: 'x', paths: ['g'] }])
      const afterDeltas = await roObjectRows()
      stop()
      await truncateUnderProjectionMutex('ro_objects')
      stop = await start(ws)
      await settle()
      expect(await roObjectRows()).toEqual(afterDeltas)
    } finally {
      stop()
      log.restore()
    }
  })

  it('IDEMPOTENT across a crash between the current head flush and the forwarded_heads commit: no duplicate batch id, no second write', async () => {
    const ws = await workspace()
    const log = forwardLog()
    let stop = await start(ws)
    try {
      const a = offlineClient(ws.retired)
      const current = await rotate<ObjHead>(ws, 'object')
      current.change((d) => { d.objects.x = { ...X0, g: 'gB' } })
      await until(() => roObject('x'), (x) => x?.g === 'gB')
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      await until(() => forwardedHeadsOf(ws.retired.documentId), (h) => h !== null)
      await until(() => ackOf('a1'), (ack) => ack?.status === 'projected')
      await settle()
      stop()
      // The durable state a crash after the flush and before the commit
      // leaves: the current head carries the forward, the row does not.
      await pool!.query(
        'UPDATE read_model_ordinary_head_retirements SET forwarded_heads = NULL WHERE document_id = $1',
        [ws.retired.documentId],
      )
      const headsBefore = A.getHeads(current.doc() as A.Doc<unknown>)
      const linesBefore = log.lines.length
      stop = await start(ws)
      // Witness: the replay ran (the row is committed again, by a new line).
      expect(await until(() => forwardedHeadsOf(ws.retired.documentId), (h) => h !== null))
        .toEqual([...A.getHeads(ws.retired.doc() as A.Doc<unknown>)].sort())
      expect(log.lines.length).toBe(linesBefore + 1)
      expect(log.lines.at(-1)).toMatchObject({ written: 0, batchIdsAdded: [], committed: true })
      expect(current.doc().forwardedBatchIds).toEqual(['a1'])
      expect(A.getHeads(current.doc() as A.Doc<unknown>)).toEqual(headsBefore)
      expect(await roObject('x')).toMatchObject({ f: 'fA', g: 'gB' })
      // The retired head acknowledged nothing at its attach: `a1` still names
      // the head whose projection published it.
      await settle()
      expect(await ackOf('a1')).toEqual({ status: 'projected', document_id: current.documentId })
    } finally {
      stop()
      log.restore()
    }
  })

  it('a late write that arrived while NO projector ran is forwarded at attach, and not acknowledged before its value is published', async () => {
    const ws = await workspace()
    const log = forwardLog()
    let stop = await start(ws)
    let release: () => void = () => {}
    try {
      const a = offlineClient(ws.retired)
      const current = await rotate<ObjHead>(ws, 'object')
      current.change((d) => { d.objects.x = { ...X0, g: 'gB' } })
      await until(() => roObject('x'), (x) => x?.g === 'gB')
      await settle()
      stop()
      // Delivered while the projector is down.
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      // Hold every flush of the current head once the forward has written it,
      // so the window between the attach and the forward's publication stays
      // open long enough to look into.
      let held = 0
      const gate = new Promise<void>((resolve) => { release = resolve })
      const realFlush = ws.repo.flush.bind(ws.repo)
      ws.repo.flush = (async (documentIds?: Parameters<Repo['flush']>[0]) => {
        if (documentIds?.includes(current.documentId) && current.doc().forwardedBatchIds?.includes('a1')) {
          held += 1
          await gate
        }
        return realFlush(documentIds)
      }) as Repo['flush']
      stop = await start(ws)
      // Witness: the catch-up forward ran (it wrote the current head and is
      // waiting in its flush).
      await until(() => held, (n) => n > 0)
      expect(current.doc().objects.x).toMatchObject({ f: 'fA', g: 'gB' })
      await settle()
      // Nothing has published `fA` yet, so nothing may call `a1` projected —
      // in particular not the retired head's own attach.
      expect(await ackOf('a1')).toBeUndefined()
      release()
      expect(await until(() => ackOf('a1'), (ack) => ack !== undefined))
        .toEqual({ status: 'projected', document_id: current.documentId })
      expect(await until(() => roObject('x'), (x) => x?.f === 'fA')).toMatchObject({ f: 'fA', g: 'gB' })
      expect(log.lines.length).toBeGreaterThan(0)
    } finally {
      release()
      stop()
      log.restore()
    }
  })

  it('the same for a CONNECTION head: forwarded at attach, not acknowledged by the retired head itself', async () => {
    const ws = await workspace()
    const log = forwardLog()
    let stop = await start(ws)
    let release: () => void = () => {}
    try {
      const a = offlineClient(ws.connHead)
      const current = await rotate<ConnHead>(ws, 'connection')
      current.change((d) => { d.connections.c = { id: 'c', fromId: 'x', toId: 'b', label: 'l0', color: 'kB' } })
      await until(() => roConnection('c'), (c) => c?.color === 'kB')
      await settle()
      stop()
      a.edit((d) => { d.connections.c.label = 'lA'; d.writeBatchIds.push('ca1') })
      a.reconnect()
      let held = 0
      const gate = new Promise<void>((resolve) => { release = resolve })
      const realFlush = ws.repo.flush.bind(ws.repo)
      ws.repo.flush = (async (documentIds?: Parameters<Repo['flush']>[0]) => {
        if (documentIds?.includes(current.documentId) && current.doc().forwardedBatchIds?.includes('ca1')) {
          held += 1
          await gate
        }
        return realFlush(documentIds)
      }) as Repo['flush']
      stop = await start(ws)
      await until(() => held, (n) => n > 0)
      expect(current.doc().connections.c).toMatchObject({ label: 'lA', color: 'kB' })
      await settle()
      expect(await ackOf('ca1')).toBeUndefined()
      release()
      expect(await until(() => ackOf('ca1'), (ack) => ack !== undefined))
        .toEqual({ status: 'projected', document_id: current.documentId })
      expect(await until(() => roConnection('c'), (c) => c?.label === 'lA')).toMatchObject({ label: 'lA', color: 'kB' })
      expect(log.lines.some((line) => line.collection === 'connection')).toBe(true)
    } finally {
      release()
      stop()
      log.restore()
    }
  })

  it('a retirement read that FAILS at boot fails the boot and releases its residency leases (never read as "no retirements")', async () => {
    const ws = await workspace()
    const residency = new AutomergeResidencyLeases(ws.repo)
    // A COLUMN, not the table: `search_path` falls through to `public`, where
    // the vitest global setup created the same table, so a renamed table is
    // simply found there.
    await pool!.query(`ALTER TABLE ${SCHEMA}.read_model_ordinary_head_retirements RENAME COLUMN status TO status_away`)
    try {
      let outcome: unknown
      try {
        const stop = await startReadModelProjector(ws.repo, ws.rootUrl, pool!, WS, residency, 0)
        stop()
        outcome = 'started'
      } catch (error) {
        outcome = error
      }
      expect(String(outcome)).toMatch(/status/)
      // Witness that the boot got as far as leasing: the cold build ran.
      expect((await pool!.query('SELECT 1 FROM ro_objects WHERE landscape_id = $1 AND id = $2', [WS.landscapeId, 'x'])).rowCount).toBe(1)
      for (const handle of [ws.meta, ws.retired, ws.connHead]) expect(residency.isLeased(handle.documentId)).toBe(false)
    } finally {
      await pool!.query(`ALTER TABLE ${SCHEMA}.read_model_ordinary_head_retirements RENAME COLUMN status_away TO status`)
    }
  })

  it.each<[string, RowKind]>([
    ['no retirement row (a head retired by compaction)', 'none'],
    ['a row still `admitted`, without H_r', 'admitted'],
  ])('a retired head with %s keeps TODAY\'S behaviour: projected and acknowledged directly, nothing forwarded', async (_label, row) => {
    const ws = await workspace()
    const log = forwardLog()
    const stop = await start(ws)
    try {
      const a = offlineClient(ws.retired)
      const current = await rotate<ObjHead>(ws, 'object', row)
      current.change((d) => { d.objects.x = { ...X0, g: 'gB' } })
      await until(() => roObject('x'), (x) => x?.g === 'gB')
      const currentHeads = A.getHeads(current.doc() as A.Doc<unknown>)
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      // The direct projection's witness: the retired head's WHOLE entity wins
      // the row (last shard delta wins), and its batch is acknowledged by it.
      expect(await until(() => roObject('x'), (x) => x?.f === 'fA')).toMatchObject({ f: 'fA', g: 'g0' })
      expect(await until(() => ackOf('a1'), (ack) => ack !== undefined)).toMatchObject({
        status: 'projected', document_id: ws.retired.documentId,
      })
      await settle()
      expect(A.getHeads(current.doc() as A.Doc<unknown>)).toEqual(currentHeads)
      expect(current.doc().forwardedBatchIds).toBeUndefined()
      expect(log.lines).toEqual([])
    } finally {
      stop()
      log.restore()
    }
  })

  it('a forwarder put racing a client\'s first whole-entity write yields a `$` conflict, which the current head\'s healer merges', async () => {
    const ws = await workspace()
    const log = forwardLog()
    const stop = await start(ws)
    try {
      const a = offlineClient(ws.retired)
      const current = await rotate<ObjHead>(ws, 'object')
      // B holds the new, still-empty head and will write x whole into it.
      const b = offlineClient(current)
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      // The forwarder put x (absent from the current head) whole, and it is
      // published before B's write arrives.
      await until(() => roObject('x'), (x) => x?.f === 'fA')
      expect(current.doc().objects.x).toMatchObject({ f: 'fA', g: 'g0' })
      b.edit((d) => {
        d.objects.x = { ...X0, g: 'gB' }
        d.writeBatchIds.push('b1')
      })
      b.reconnect()
      // Witness: the merge really produced a whole-entity conflict.
      expect(wholeEntityConflictIds(collectAutomergeEntityConflicts(
        current.doc().objects as Record<string, unknown>,
      ))).toEqual(['x'])
      const healed = await until(() => roObject('x'), (x) => x?.f === 'fA' && x?.g === 'gB')
      expect(healed).toMatchObject({ f: 'fA', g: 'gB' })
      await until(() => wholeEntityConflictIds(collectAutomergeEntityConflicts(
        current.doc().objects as Record<string, unknown>,
      )).length, (n) => n === 0)
      expect(current.doc().objects.x).toMatchObject({ f: 'fA', g: 'gB' })
      expect(log.lines.length).toBeGreaterThan(0)
    } finally {
      stop()
      log.restore()
    }
  })

  it('OWNERSHIP LOST mid-forward (the write fence taken between the flush and the commit): nothing published, nothing acknowledged, forwarded_heads not moved', async () => {
    const ws = await workspace()
    const log = forwardLog()
    let fenceLost = 0
    const stop = await start(ws, { onFenceLost: () => { fenceLost += 1 } })
    try {
      const a = offlineClient(ws.retired)
      const current = await rotate<ObjHead>(ws, 'object')
      await settle()
      let stolen = 0
      const realFlush = ws.repo.flush.bind(ws.repo)
      ws.repo.flush = (async (documentIds?: Parameters<Repo['flush']>[0]) => {
        const result = await realFlush(documentIds)
        if (!stolen && documentIds?.includes(current.documentId) && current.doc().objects.x) {
          stolen += 1
          await pool!.query(
            `UPDATE read_model_projection_state SET write_fence = 'another-cell'
             WHERE landscape_id = $1 AND version_id = $2`,
            [WS.landscapeId, WS.versionId],
          )
        }
        return result
      }) as Repo['flush']
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      // Witness: the forward reached its flush (the CRDT write is the
      // idempotent half — any owner would make it) and the fence was taken.
      await until(() => stolen, (n) => n === 1)
      expect(current.doc().objects.x).toMatchObject({ f: 'fA' })
      await until(() => fenceLost, (n) => n > 0)
      await settle(500)
      expect(stolen).toBe(1)
      expect(fenceLost).toBeGreaterThan(0)
      expect(await forwardedHeadsOf(ws.retired.documentId)).toBeNull()
      expect(await ackOf('a1')).toBeUndefined()
      expect((await roObject('x'))?.f).toBe('f0')
      expect(log.lines).toEqual([])
    } finally {
      stop()
      log.restore()
    }
  })

  it('a cell that does not own the workspace forwards NOTHING, and forwards everything once it does again', async () => {
    const ws = await workspace()
    const log = forwardLog()
    let owned = true
    const stop = await start(ws, { stillOwned: () => owned })
    try {
      const a = offlineClient(ws.retired)
      const current = await rotate<ObjHead>(ws, 'object')
      await settle()
      const currentHeads = A.getHeads(current.doc() as A.Doc<unknown>)
      owned = false
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      await settle(500)
      expect(A.getHeads(current.doc() as A.Doc<unknown>)).toEqual(currentHeads)
      expect(await forwardedHeadsOf(ws.retired.documentId)).toBeNull()
      // ...and not projected directly either.
      expect((await roObject('x'))?.f).toBe('f0')
      // Witness that the watcher was live all along: ownership back, the next
      // late write carries the first one with it.
      owned = true
      a.edit((d) => { d.objects.x.g = 'gA'; d.writeBatchIds.push('a2') })
      a.reconnect()
      expect(await until(() => roObject('x'), (x) => x?.f === 'fA' && x?.g === 'gA')).toMatchObject({ f: 'fA', g: 'gA' })
      expect(current.doc().forwardedBatchIds).toEqual(['a1', 'a2'])
      expect(log.lines).toHaveLength(1)
    } finally {
      stop()
      log.restore()
    }
  })

  it('a write fence already lost when the late write arrives: the current head is NOT written (authority before the first CRDT write)', async () => {
    const ws = await workspace()
    const log = forwardLog()
    let fenceLost = 0
    const stop = await start(ws, { onFenceLost: () => { fenceLost += 1 } })
    try {
      const a = offlineClient(ws.retired)
      const current = await rotate<ObjHead>(ws, 'object')
      await settle()
      const currentHeads = A.getHeads(current.doc() as A.Doc<unknown>)
      await pool!.query(
        `UPDATE read_model_projection_state SET write_fence = 'another-cell'
         WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId],
      )
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      // Witness: the forward was attempted and refused on the fence.
      await until(() => fenceLost, (n) => n > 0)
      expect(fenceLost).toBeGreaterThan(0)
      await settle()
      expect(A.getHeads(current.doc() as A.Doc<unknown>)).toEqual(currentHeads)
      expect(await forwardedHeadsOf(ws.retired.documentId)).toBeNull()
      expect(log.lines).toEqual([])
    } finally {
      stop()
      log.restore()
    }
  })

  it('commitForwardedHeads is a compare-and-set on the value the forward started from', async () => {
    await recordOrdinaryHeadRetirement(pool!, WS, {
      collection: 'object', documentId: 'R', retirementHeads: ['b', 'a'], status: 'retired',
    })
    // A second record never moves H_r.
    expect(await recordOrdinaryHeadRetirement(pool!, WS, {
      collection: 'object', documentId: 'R', retirementHeads: ['z'], status: 'retired',
    })).toBe(false)
    expect(await commitForwardedHeads(pool!, WS, 'object', 'R', ['stale'], ['c'])).toBe(false)
    expect(await forwardedHeadsOf('R')).toBeNull()
    expect(await commitForwardedHeads(pool!, WS, 'object', 'R', null, ['d', 'c'])).toBe(true)
    expect(await forwardedHeadsOf('R')).toEqual(['c', 'd'])
    expect(await commitForwardedHeads(pool!, WS, 'object', 'R', null, ['e'])).toBe(false)
    expect(await commitForwardedHeads(pool!, WS, 'object', 'R', ['c', 'd'], ['e'])).toBe(true)
    expect(await forwardedHeadsOf('R')).toEqual(['e'])
    const row = (await pool!.query<{ retirement_heads: string[] }>(
      'SELECT retirement_heads FROM read_model_ordinary_head_retirements WHERE document_id = $1', ['R'],
    )).rows[0]
    expect(row.retirement_heads).toEqual(['a', 'b'])
    // A row that is no longer `retired` is never advanced.
    await pool!.query(
      `UPDATE read_model_ordinary_head_retirements SET status = 'admitted', retirement_heads = NULL
       WHERE document_id = 'R'`,
    )
    expect(await commitForwardedHeads(pool!, WS, 'object', 'R', ['e'], ['f'])).toBe(false)
    expect(await forwardedHeadsOf('R')).toEqual(['e'])
    // `retired` without H_r is refused by the table itself.
    await expect(pool!.query(
      `INSERT INTO read_model_ordinary_head_retirements
         (landscape_id, version_id, collection, document_id, status) VALUES ($1, $2, 'object', 'N', 'retired')`,
      [WS.landscapeId, WS.versionId],
    )).rejects.toThrow(/check/i)
  })

  it('forwards a CONNECTION head the same way (the second, duplicated wiring)', async () => {
    const ws = await workspace()
    const log = forwardLog()
    const stop = await start(ws)
    try {
      const a = offlineClient(ws.connHead)
      const current = await rotate<ConnHead>(ws, 'connection')
      current.change((d) => {
        d.connections.c = { id: 'c', fromId: 'x', toId: 'b', label: 'l0', color: 'kB' }
        d.writeBatchIds.push('cb1')
      })
      await until(() => roConnection('c'), (c) => c?.color === 'kB')
      a.edit((d) => { d.connections.c.label = 'lA'; d.writeBatchIds.push('ca1') })
      a.reconnect()
      expect(await until(() => roConnection('c'), (c) => c?.label === 'lA'))
        .toMatchObject({ label: 'lA', color: 'kB' })
      expect(current.doc().forwardedBatchIds).toEqual(['ca1'])
      expect((await until(() => ackOf('ca1'), (ack) => ack !== undefined))?.document_id).toBe(current.documentId)
      expect(log.lines.some((line) => line.collection === 'connection')).toBe(true)
    } finally {
      stop()
      log.restore()
    }
  })

  it('without any retirement row, a head\'s `forwardedBatchIds` are NOT read — the byte-identical guarantee; with one, they are', async () => {
    // `forwardedBatchIds` on an ordinary head exist today only on a workspace
    // demoted from static. Before phase 2 nothing acknowledged them.
    for (const withRow of [false, true]) {
      await truncateUnderProjectionMutex('read_model_overlay_batch_acks, read_model_ordinary_head_retirements, read_model_projection_state')
      const ws = await workspace({ forwardedBatchIds: ['stray'] })
      if (withRow) {
        await recordOrdinaryHeadRetirement(pool!, WS, {
          collection: 'object', documentId: 'unrelated', retirementHeads: ['00'], status: 'retired',
        })
      }
      const stop = await start(ws)
      try {
        // Witness that the attach acknowledgement ran at all: r0.
        await until(() => ackOf('r0'), (ack) => ack !== undefined)
        await settle(200)
        expect((await ackOf('r0'))?.status).toBe('projected')
        expect(await ackOf('stray')).toEqual(withRow
          ? { status: 'projected', document_id: ws.retired.documentId }
          : undefined)
      } finally {
        stop()
      }
    }
  })

  // The projector's `tombstones` wire, per collection. Without these, emptying
  // it or swapping the two id lists left all of the above green (review QA
  // lens, 2026-11-01): a late write to a deleted entity was then copied whole
  // into the current head, resurrecting it there.
  it('a late write to an OBJECT tombstoned in ModelMeta is not resurrected into the current head', async () => {
    const ws = await workspace()
    const log = forwardLog()
    const stop = await start(ws)
    try {
      const a = offlineClient(ws.retired)
      const current = await rotate<ObjHead>(ws, 'object')
      ws.meta.change((m) => { m.deletedObjectIds = ['x'] })
      await settle()
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      // Witness: the forward ran past the late write.
      expect(await until(() => forwardedHeadsOf(ws.retired.documentId), (h) => h !== null))
        .toEqual([...A.getHeads(ws.retired.doc() as A.Doc<unknown>)].sort())
      expect(current.doc().objects.x).toBeUndefined()
    } finally {
      stop()
      log.restore()
    }
  })

  // The plane half of `assertAuthority`. Deleting it left the whole suite
  // green (review QA lens, 2026-11-01): the fence half alone does not refuse a
  // workspace promoted to static while this projector still holds the fence.
  it('a workspace that became STATIC before the late write: the current head is NOT written', async () => {
    const ws = await workspace()
    const log = forwardLog()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = await start(ws)
    try {
      const a = offlineClient(ws.retired)
      const current = await rotate<ObjHead>(ws, 'object')
      await settle()
      const heads = A.getHeads(current.doc() as A.Doc<unknown>)
      await pool!.query(
        `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source) VALUES ($1, $2, 'test')`,
        [WS.landscapeId, WS.versionId],
      )
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      // Witness: the forward was attempted and refused on the plane.
      await until(() => errors.mock.calls.some((call) => /plane lost/.test(String(call[1] ?? call[0]))), (seen) => seen)
      expect(errors.mock.calls.some((call) => /plane lost/.test(String(call[1] ?? call[0])))).toBe(true)
      expect(A.getHeads(current.doc() as A.Doc<unknown>)).toEqual(heads)
      expect(current.doc().objects.x).toBeUndefined()
      expect(await forwardedHeadsOf(ws.retired.documentId)).toBeNull()
      expect(log.lines).toEqual([])
    } finally {
      stop()
      log.restore()
      errors.mockRestore()
      await pool!.query('DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId])
    }
  })

  it('a late write to a CONNECTION tombstoned in ModelMeta is not resurrected into the current head', async () => {
    const ws = await workspace()
    const log = forwardLog()
    const stop = await start(ws)
    try {
      const a = offlineClient(ws.connHead)
      const current = await rotate<ConnHead>(ws, 'connection')
      ws.meta.change((m) => { (m as Meta & { deletedConnectionIds?: string[] }).deletedConnectionIds = ['c'] })
      await settle()
      a.edit((d) => { d.connections.c.label = 'lA'; d.writeBatchIds.push('ca1') })
      a.reconnect()
      expect(await until(() => forwardedHeadsOf(ws.connHead.documentId), (h) => h !== null))
        .toEqual([...A.getHeads(ws.connHead.doc() as A.Doc<unknown>)].sort())
      expect(current.doc().connections.c).toBeUndefined()
    } finally {
      stop()
      log.restore()
    }
  })
})
