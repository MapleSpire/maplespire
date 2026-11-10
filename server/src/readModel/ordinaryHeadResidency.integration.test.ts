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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { NetworkAdapter, Repo, type AutomergeUrl, type DocHandle, type PeerId } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import { cachedHandles } from '../automergeRepoCompat.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { ensureReadModelSchema } from './schema.js'
import { startReadModelProjector } from './projectorService.js'
import type { OrdinaryHeadRotationConfig } from './ordinaryHeadRotation.js'
import { ordinaryRotationTelemetry } from './ordinaryRotationTelemetry.js'
import { documentContentArrivals } from './ordinaryFoldedArrivals.js'
import { ORDINARY_FOLD_SOURCES_FIELD } from './ordinaryChainFold.js'
import { DOCUMENT_LOAD_CALLERS, DOCUMENT_LOAD_LOG_MS, documentLoadCount } from './documentLoadTelemetry.js'
import type { WorkspaceKey } from './projector.js'

/**
 * What keeps a RETIRED ordinary write head resident on the owning cell, with
 * the real residency leases, a real Repo over PostgreSQL storage, the real
 * projector's own rotations and folds.
 *
 * Why it exists (G4-16b-defer2h, mesures/): on the 2 h fleet soak the cells
 * that own a hot workspace grow 20–30 MiB/h, outside the V8 heap, with the
 * chain fold on or off. Reading the code named two holders; these tests pin
 * what each one does TODAY, so a fix shows up here as a changed assertion:
 *
 * 1. the projector's lease: held on every retired head until that head is
 *    folded or, with the fold off, PARKED (settled and retired for
 *    `AM_ORDINARY_RETIRED_HEAD_PARK_MS`; its late writes are then found in
 *    storage by the arrival poll) — or until the projector stops. Fixed: the
 *    first test below asserted retention until `stop()` before parking;
 * 2. a connected peer bound to the head: eviction refuses a document with an
 *    active peer, and nothing unbinds a peer from a retired head, so a folded
 *    head stays resident as long as any client that synced it stays connected.
 *
 * Characterisation tests: the assertions marked TODAY describe the retention
 * the soak measured, not the behaviour we want.
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-ohres', versionId: 'v1' }
const LISTED = `${WS.landscapeId}/${WS.versionId}`
const THRESHOLD = 4

let db: IsolatedSchemaDb

type Entity = { id: string; [field: string]: unknown }
type ObjHead = { objects: Record<string, Entity>; writeBatchIds: string[] }
type Meta = {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrl: string
  editsObjectShardUrls: string[]
  editsConnectionShardUrl: string
  editsConnectionShardUrls: string[]
  groups: Record<string, unknown>
}

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))

type SentMessage = Parameters<NetworkAdapter['send']>[0]
type PeerMeta = Parameters<NetworkAdapter['connect']>[1]

/** One end of an in-process link between two Repos: a connected peer, as a
 * WebSocket client is to the server, without a socket. Messages are delivered
 * on a later macrotask, as a socket would. */
class LinkedAdapter extends NetworkAdapter {
  other: LinkedAdapter | null = null
  connected = false
  closed = false
  isReady(): boolean { return this.connected }
  whenReady(): Promise<void> { return Promise.resolve() }
  connect(peerId: PeerId, peerMetadata?: PeerMeta): void {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.connected = true
    const other = this.other
    if (other?.connected && other.peerId) {
      this.emit('peer-candidate', { peerId: other.peerId, peerMetadata: other.peerMetadata ?? {} })
      other.emit('peer-candidate', { peerId, peerMetadata: peerMetadata ?? {} })
    }
  }
  send(message: SentMessage): void {
    const other = this.other
    if (this.closed || !other || other.closed) return
    setTimeout(() => { if (!this.closed && !other.closed) other.emit('message', message) }, 0)
  }
  disconnect(): void {
    if (this.closed) return
    this.closed = true
    const other = this.other
    if (other?.peerId) this.emit('peer-disconnected', { peerId: other.peerId })
    if (other && this.peerId) {
      other.closed = true
      other.emit('peer-disconnected', { peerId: this.peerId })
    }
  }
}

function linkedPair(): [LinkedAdapter, LinkedAdapter] {
  const server = new LinkedAdapter()
  const client = new LinkedAdapter()
  server.other = client
  client.other = server
  return [server, client]
}

function storageRepo(network: NetworkAdapter[] = []) {
  return new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network, saveDebounceRate: 60_000 })
}

interface Workspace {
  repo: Repo
  rootUrl: string
  meta: DocHandle<Meta>
  head: DocHandle<ObjHead>
  registry: DocHandle<{ diagrams: Record<string, unknown> }>
}

async function workspace(repo: Repo): Promise<Workspace> {
  const base = repo.create<{ objects: Record<string, Entity> }>({ objects: { b: { id: 'b', name: 'B', type: 'system' } } })
  const head = repo.create<ObjHead>({ objects: {}, writeBatchIds: [] })
  const connHead = repo.create({ connections: {}, writeBatchIds: [] })
  const meta = repo.create<Meta>({
    objectShardUrls: [base.url, head.url],
    connectionShardUrls: [connHead.url],
    editsObjectShardUrl: head.url,
    editsObjectShardUrls: [head.url],
    editsConnectionShardUrl: connHead.url,
    editsConnectionShardUrls: [connHead.url],
    groups: {},
  })
  const registry = repo.create<{ diagrams: Record<string, unknown> }>({ diagrams: {} })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
  const handles = [base, head, connHead, meta, registry, root]
  await Promise.all(handles.map((h) => h.whenReady()))
  await repo.flush()
  for (const handle of handles) {
    await db.pool.query(
      'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [String(handle.documentId), WS.landscapeId, WS.versionId],
    )
  }
  return { repo, rootUrl: root.url, meta, head, registry }
}

function config(fold: boolean, chainAlertLength?: number): OrdinaryHeadRotationConfig {
  return {
    mode: 'on', allowlist: new Set([LISTED]), maxActors: 1_000_000, maxChanges: THRESHOLD,
    ...(fold ? { chainFold: { minChain: 2, budget: 8, retainMs: 86_400_000 } } : {}),
    ...(chainAlertLength === undefined ? {} : { chainAlertLength }),
  }
}

async function start(ws: Workspace, residency: AutomergeResidencyLeases, fold: boolean, chainAlertLength?: number) {
  return startReadModelProjector(
    ws.repo, ws.rootUrl, db.pool, WS, residency, 0, undefined,
    undefined, undefined, undefined, config(fold, chainAlertLength),
  )
}

function logLines() {
  const lines: Array<Record<string, unknown>> = []
  const capture = (...args: unknown[]) => {
    const first = args[0]
    if (typeof first !== 'string' || !first.startsWith('{')) return
    try { lines.push(JSON.parse(first) as Record<string, unknown>) } catch { /* not ours */ }
  }
  const spies = [
    vi.spyOn(console, 'warn').mockImplementation(capture),
    vi.spyOn(console, 'error').mockImplementation(capture),
    vi.spyOn(console, 'log').mockImplementation(capture),
  ]
  return {
    events: (event: string) => lines.filter((line) => line.event === event),
    restore: () => { for (const spy of spies) spy.mockRestore() },
  }
}

const currentHead = (ws: Workspace) => ws.meta.doc()!.editsObjectShardUrl
const docId = (url: string) => url.replace(/^automerge:/, '')
const resident = (repo: Repo, id: string) => Object.prototype.hasOwnProperty.call(cachedHandles(repo), id)
const roObject = async (id: string) => (await db.pool.query<{ data: Record<string, unknown> }>(
  'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
  [WS.landscapeId, WS.versionId, id],
)).rows[0]?.data

/** Fill the CURRENT head until it crosses the threshold and wait for the
 * projector to rotate it. Returns the retired head's document id. */
async function fillAndRotate(ws: Workspace, tag: string): Promise<string> {
  const url = currentHead(ws)
  const head = await ws.repo.find<ObjHead>(url as AutomergeUrl)
  let index = 0
  while (A.stats(head.doc() as A.Doc<unknown>).numChanges < THRESHOLD) {
    head.change((d) => { d.objects[`n${index}`] = { id: `n${index}`, name: `${tag}-${index}`, type: 'system' } })
    index += 1
  }
  const next = await until(() => currentHead(ws), (now) => now !== url, 45_000)
  expect(next).not.toBe(url)
  return docId(url)
}

/** fillAndRotate for the CONNECTION write head. */
async function fillAndRotateConnections(ws: Workspace): Promise<string> {
  const url = ws.meta.doc()!.editsConnectionShardUrl
  const head = await ws.repo.find<{ connections: Record<string, unknown> }>(url as AutomergeUrl)
  let index = 0
  while (A.stats(head.doc() as A.Doc<unknown>).numChanges < THRESHOLD) {
    head.change((d) => { d.connections[`k${index}`] = { id: `k${index}`, fromId: 'b', toId: 'x', label: `k${index}` } })
    index += 1
  }
  const next = await until(() => ws.meta.doc()!.editsConnectionShardUrl, (now) => now !== url, 45_000)
  expect(next).not.toBe(url)
  return docId(url)
}

suite('ordinary head residency (G4-16b-defer2h memory) — real leases, real Repo, PostgreSQL', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'ordinary_head_residency')
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
          read_model_ordinary_chain_folds`)
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
          [documentId, landscapeId, versionId],
        )
      }
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
  })
  afterEach(() => { restoreRegistration() })

  it('fold OFF, no peer: a retired head is parked once settled — released and evicted while the projector runs — and a late write before or after the park is still forwarded', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS = '300'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stop = await start(ws, residency, false)
    let stopped = false
    // Whether each new head was ALREADY leased when ModelMeta published it,
    // read synchronously in the publishing change: the projector's watcher
    // only resolves (and leases) it later, so this is the rotation's own
    // lease (`touchRotatedChild`), not the watcher's.
    const leasedAtPublish = new Map<string, boolean>()
    const onMeta = () => {
      const id = docId(ws.meta.doc()!.editsObjectShardUrl)
      if (!leasedAtPublish.has(id)) leasedAtPublish.set(id, residency.isLeased(id))
    }
    onMeta()
    ws.meta.on('change', onMeta)
    const forwardedWithCreate = (id: string) => log.events('read_model.ordinary_head_forwarded')
      .filter((line) => line.retired === id && Number(line.created) > 0)
    const parkedIds = () => new Set(log.events('read_model.ordinary_retired_head_parked').map((line) => docId(String(line.url))))
    // The poll's FOLDED-head question, with the fold off and no folded row:
    // never asked (only the parked one is).
    const querySpy = vi.spyOn(db.pool, 'query')
    const foldedQueries = () => querySpy.mock.calls
      .filter((call) => typeof call[0] === 'string' && call[0].includes('CROSS JOIN LATERAL')
        && call[0].includes("r.status = 'folded'")).length
    const rowOf = (id: string) => db.pool.query<{ forwarded_heads: string[] | null }>(
      `SELECT forwarded_heads FROM read_model_ordinary_head_retirements
        WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' AND document_id = $3`,
      [WS.landscapeId, WS.versionId, id],
    )
    const setForwardedHeads = (id: string, heads: string[] | null) => db.pool.query(
      `UPDATE read_model_ordinary_head_retirements SET forwarded_heads = $4::text[]
        WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' AND document_id = $3`,
      [WS.landscapeId, WS.versionId, id, heads],
    )
    const refused = (id: string) => log.events('read_model.ordinary_head_forward_refused')
      .filter((line) => line.retired === id && line.reason === 'unknown-heads').length
    const write = async (id: string, key: string) => {
      const handle = await ws.repo.find<ObjHead>(`automerge:${id}` as AutomergeUrl)
      handle.change((d) => { d.objects[key] = { id: key, name: key, type: 'system' } })
      return handle
    }
    try {
      const retired: string[] = []
      retired.push(await fillAndRotate(ws, 'h0'))
      // A late write into the head just retired, while its watcher still
      // holds it — a client that has not seen the repoint yet.
      const justRetired = await ws.repo.find<ObjHead>(`automerge:${retired[0]}` as AutomergeUrl)
      justRetired.change((d) => { d.objects['late-pre'] = { id: 'late-pre', name: 'before park', type: 'system' } })
      // An entity that only the NEXT head (retired[1] once rotated) will ever
      // hold: read from that head's parked snapshot by a forward below.
      const h1 = await ws.repo.find<ObjHead>(currentHead(ws) as AutomergeUrl)
      h1.change((d) => { d.objects.X = { id: 'X', name: 'only in h1', type: 'system', tech: 'keep' } })
      for (const tag of ['h1', 'h2']) retired.push(await fillAndRotate(ws, tag))
      // A head that is DEGRADED owes a forward and is not parked. Its first
      // late write is refused (the row names heads it does not hold); only a
      // forward that succeeds lifts that, and only then may it park.
      const savedR2 = (await rowOf(retired[2]!)).rows[0]!.forwarded_heads
      await setForwardedHeads(retired[2]!, ['0'.repeat(64)])
      await write(retired[2]!, 'late-degraded')
      expect(await until(() => refused(retired[2]!), (n) => n >= 1, 15_000)).toBeGreaterThanOrEqual(1)
      await settle(1_200) // four park sweeps
      expect(parkedIds().has(retired[2]!)).toBe(false)
      await setForwardedHeads(retired[2]!, savedR2)
      await write(retired[2]!, 'late-fix')
      expect(await until(() => roObject('late-degraded'), (v) => v !== undefined, 15_000)).toMatchObject({ name: 'late-degraded' })
      // Witness: three rotations, by the projector (its log line follows the
      // repoint `fillAndRotate` waits for).
      expect(await until(() => log.events('read_model.ordinary_head_rotated').length, (n) => n >= 3)).toBe(3)
      expect(ws.meta.doc()!.editsObjectShardUrls).toHaveLength(4)
      const rotatedChildren = [...retired.slice(1), docId(currentHead(ws))]
      for (const id of rotatedChildren) expect(leasedAtPublish.get(id)).toBe(true)

      // Every retired head is PARKED while the projector runs: lease given
      // back and — no peer — evicted. Still listed: the fold is off.
      const parked = await until(parkedIds, (ids) => retired.every((id) => ids.has(id)), 30_000)
      for (const id of retired) expect(parked.has(id)).toBe(true)
      for (const id of retired) {
        const gone = await until(async () => { await residency.drain(); return !resident(ws.repo, id) }, (v) => v, 15_000)
        expect(gone).toBe(true)
        expect(residency.isLeased(id)).toBe(false)
        expect(ws.meta.doc()!.objectShardUrls).toContain(`automerge:${id}`)
      }
      // The late write before the park was forwarded (by the watcher, before
      // the park could start: a head owing a forward is not parked).
      expect(forwardedWithCreate(retired[0]!).length).toBeGreaterThanOrEqual(1)
      expect(await until(() => roObject('late-pre'), (v) => v !== undefined, 15_000)).toMatchObject({ name: 'before park' })
      // Control: the current head is never parked, and stays leased and resident.
      const current = docId(currentHead(ws))
      expect(parked.has(current)).toBe(false)
      expect(residency.isLeased(current)).toBe(true)
      expect(await residency.evict(current)).toBe(false)
      expect(resident(ws.repo, current)).toBe(true)

      // From here, who takes a lease on, or loads, a parked head? Only the
      // poll, for the one head it forwards (retired[0] below).
      const acquired: string[] = []
      const acquireSpy = vi.spyOn(residency, 'acquire')
      acquireSpy.mockImplementation(function (this: AutomergeResidencyLeases, ...args) {
        acquired.push(String(args[0].documentId))
        return AutomergeResidencyLeases.prototype.acquire.apply(this, args)
      })
      const found: string[] = []
      const findSpy = vi.spyOn(ws.repo, 'find')
      const realFind = Repo.prototype.find
      findSpy.mockImplementation(function (this: Repo, ...args: Parameters<Repo['find']>) {
        found.push(docId(String(args[0])))
        return realFind.apply(this, args)
      } as Repo['find'])
      // A late write AFTER the park, as a stale client's sync delivers it: the
      // Repo loads the evicted head, applies the change and saves it. No
      // watcher sees it; the arrival poll finds it in storage and forwards it.
      // `X` is created here and lives otherwise only in retired[1]: the
      // forward merges against what the OTHER segments serve for it (later
      // wins), which for a parked retired[1] is its snapshot — without it, `tech`
      // would be lost.
      const forwardsBefore = forwardedWithCreate(retired[0]!).length
      // Its FIRST forward is refused (the row names heads the document does
      // not hold): a forward that did not happen must not move the watermark,
      // or the arrival it was carrying is never looked at again.
      const savedForwardedHeads = (await rowOf(retired[0]!)).rows[0]!.forwarded_heads
      await setForwardedHeads(retired[0]!, ['0'.repeat(64)])
      const stale = await ws.repo.find<ObjHead>(`automerge:${retired[0]}` as AutomergeUrl)
      stale.change((d) => {
        d.objects['late-post'] = { id: 'late-post', name: 'after park', type: 'system' }
        d.objects.X = { id: 'X', label: 'late' }
      })
      await ws.repo.flush([stale.documentId])
      const testFinds = found.length
      expect(await until(() => refused(retired[0]!), (n) => n >= 1, 15_000)).toBeGreaterThanOrEqual(1)
      await setForwardedHeads(retired[0]!, savedForwardedHeads)
      expect(await until(() => roObject('late-post'), (v) => v !== undefined, 30_000)).toMatchObject({ name: 'after park' })
      expect(forwardedWithCreate(retired[0]!).length).toBeGreaterThan(forwardsBefore)
      expect(await until(() => roObject('X'), (v) => v?.label === 'late', 15_000))
        .toMatchObject({ name: 'only in h1', tech: 'keep', label: 'late' })
      // The poll gave its lease back — once the stamp its forward left was
      // consumed, so the head's arrival watermark is certified, not 0 — and
      // the forward's read of the other segments loaded none of them.
      const free = await until(async () => { await residency.drain(); return !residency.isLeased(retired[0]!) }, (v) => v, 15_000)
      expect(free).toBe(true)
      const projectedWatermark = (await db.pool.query<{ projected_watermark: string }>(
        `SELECT projected_watermark::text FROM read_model_document_watermarks
          WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
        [WS.landscapeId, WS.versionId, retired[0]],
      )).rows[0]?.projected_watermark
      expect(projectedWatermark).toBeDefined()
      expect(projectedWatermark).not.toBe('0')
      for (const id of retired) {
        expect(residency.isLeased(id)).toBe(false)
        expect(await until(async () => { await residency.drain(); return !resident(ws.repo, id) }, (v) => v, 15_000)).toBe(true)
      }
      expect(found.slice(testFinds).filter((id) => id === retired[1] || id === retired[2])).toEqual([])
      // Once forwarded, the arrival is covered: later polls (every 200 ms)
      // do not load and forward the head again.
      const reForwards = acquired.filter((id) => id === retired[0]).length
      const reFinds = found.filter((id) => id === retired[0]).length
      await settle(1_200)
      expect(acquired.filter((id) => id === retired[0]).length).toBe(reForwards)
      expect(found.filter((id) => id === retired[0]).length).toBe(reFinds)
      // A registry edit re-extracts the WHOLE model, every listed segment
      // read: no parked head is loaded or leased, and no defect is recorded
      // (each snapshot carries its entity map).
      const findsBeforeRegistry = found.length
      const diagramDoc = ws.repo.create({ layouts: {}, comments: {}, flows: {} })
      await diagramDoc.whenReady()
      await ws.repo.flush([diagramDoc.documentId])
      await db.pool.query(
        'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [String(diagramDoc.documentId), WS.landscapeId, WS.versionId],
      )
      ws.registry.change((d) => { d.diagrams.d1 = { id: 'd1', name: 'D', docUrl: diagramDoc.url } })
      const diagramRows = await until(async () => (await db.pool.query(
        'SELECT id FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId],
      )).rows.length, (n) => n >= 1, 30_000)
      expect(diagramRows).toBe(1)
      await settle(300)
      await residency.drain()
      for (const id of retired) {
        expect(residency.isLeased(id)).toBe(false)
        expect(resident(ws.repo, id)).toBe(false)
      }
      expect(found.slice(findsBeforeRegistry).filter((id) => retired.includes(id))).toEqual([])
      const state = (await db.pool.query<{ defect_count: number | null }>(
        'SELECT defect_count FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId],
      )).rows[0]
      expect(state?.defect_count).toBe(0)
      // Not merely given back by the next poll: never taken. (The poll does
      // give back a lease it finds on a parked head; this pins the reads.)
      acquireSpy.mockRestore()
      findSpy.mockRestore()
      expect(acquired.filter((id) => id === retired[1] || id === retired[2])).toEqual([])
      expect(acquired.filter((id) => id === retired[0]).length).toBeGreaterThanOrEqual(1)
      expect(residency.hasActivePeers(retired[0]!)).toBe(false)
      // The poll ran (it forwarded above) and never asked the folded question.
      expect(log.events('read_model.ordinary_parked_head_arrival_failed')).toHaveLength(0)
      expect(foldedQueries()).toBe(0)

      stop()
      stopped = true
      await settle(300)
      await residency.drain()
      for (const id of retired) {
        expect(residency.isLeased(id)).toBe(false)
        expect(resident(ws.repo, id)).toBe(false)
      }
    } finally {
      querySpy.mockRestore()
      ws.meta.off('change', onMeta)
      if (!stopped) stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
      delete process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS
    }
  }, 180_000)

  it('fold OFF: a parked head whose stamp a target pass has TAKEN is not released until that pass commits', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS = '300'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stop = await start(ws, residency, false)
    const storage = ws.repo.storageSubsystem!
    const realDrain = storage.drainDocumentSaves.bind(storage)
    const drainSpy = vi.spyOn(storage, 'drainDocumentSaves')
    let open: () => void = () => {}
    try {
      const retiredId = await fillAndRotate(ws, 'h0')
      await until(() => log.events('read_model.ordinary_retired_head_parked').map((line) => docId(String(line.url))),
        (ids) => ids.includes(retiredId), 30_000)
      expect(await until(async () => { await residency.drain(); return !resident(ws.repo, retiredId) }, (v) => v, 15_000)).toBe(true)
      // The target's pass drains the RETIRED head's saves only when it took
      // that head's stamp (`prepareShardWatermarks`): hold it there, in flight.
      const gate = new Promise<void>((resolve) => { open = resolve })
      let held = 0
      drainSpy.mockImplementation(async (documentId) => {
        // The projector's own drain (`prepareShardWatermarks`), not the Repo's
        // save path, which drains through the same method.
        if (String(documentId) === retiredId && new Error().stack?.includes('drainPendingSaves')) {
          held += 1
          await gate
        }
        return realDrain(documentId)
      })
      const stale = await ws.repo.find<ObjHead>(`automerge:${retiredId}` as AutomergeUrl)
      stale.change((d) => { d.objects.late = { id: 'late', name: 'late', type: 'system' } })
      await ws.repo.flush([stale.documentId])
      expect(await until(() => held, (n) => n >= 1, 15_000)).toBeGreaterThanOrEqual(1)
      // Several poll ticks with the pass parked on the gate: the head stays
      // leased (its handle is what that pass certifies against).
      await settle(1_000)
      expect(residency.isLeased(retiredId)).toBe(true)
      expect(resident(ws.repo, retiredId)).toBe(true)
      open()
      expect(await until(() => roObject('late'), (v) => v !== undefined, 15_000)).toMatchObject({ name: 'late' })
      const watermark = await until(async () => (await db.pool.query<{ projected_watermark: string }>(
        `SELECT projected_watermark::text FROM read_model_document_watermarks
          WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
        [WS.landscapeId, WS.versionId, retiredId],
      )).rows[0]?.projected_watermark, (v) => v !== undefined, 15_000)
      expect(watermark).not.toBe('0')
      // Then released.
      expect(await until(async () => { await residency.drain(); return !residency.isLeased(retiredId) }, (v) => v, 15_000)).toBe(true)
    } finally {
      open()
      drainSpy.mockRestore()
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
      delete process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS
    }
  }, 180_000)

  it('fold OFF: a stop() while the arrival poll is loading a parked head leaves no lease behind', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS = '300'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stop = await start(ws, residency, false)
    let stopped = false
    const findSpy = vi.spyOn(ws.repo, 'find')
    try {
      const retiredId = await fillAndRotate(ws, 'h0')
      await until(() => log.events('read_model.ordinary_retired_head_parked').map((line) => docId(String(line.url))),
        (ids) => ids.includes(retiredId), 30_000)
      expect(await until(async () => { await residency.drain(); return !resident(ws.repo, retiredId) }, (v) => v, 15_000)).toBe(true)
      // The projector's next load of the parked head stops it, mid-load: what
      // `stop()` releases has been released before that load's lease is taken.
      const realFind = Repo.prototype.find
      let ours = false
      let stoppedDuringLoad = false
      findSpy.mockImplementation(function (this: Repo, ...args: Parameters<Repo['find']>) {
        if (!ours && !stopped && docId(String(args[0])) === retiredId) {
          stop()
          stopped = true
          stoppedDuringLoad = true
        }
        return realFind.apply(this, args)
      } as Repo['find'])
      ours = true
      const stale = await ws.repo.find<ObjHead>(`automerge:${retiredId}` as AutomergeUrl)
      ours = false
      stale.change((d) => { d.objects.late = { id: 'late', name: 'late', type: 'system' } })
      await ws.repo.flush([stale.documentId])
      expect(await until(() => stoppedDuringLoad, (v) => v, 15_000)).toBe(true)
      await settle(600)
      await residency.drain()
      expect(residency.isLeased(retiredId)).toBe(false)
      // The test's own handle is cached and unleased: evictable.
      if (resident(ws.repo, retiredId)) expect(await residency.evict(retiredId)).toBe(true)
      expect(log.events('read_model.ordinary_retired_head_unparked')).toHaveLength(0)
    } finally {
      findSpy.mockRestore()
      if (!stopped) stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
      delete process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS
    }
  }, 180_000)

  it('G4-16e, fold OFF: the stats counters follow real rotations — count, chain, parked heads, rows, current head — and the chain alert fires once on the crossing', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS = '300'
    ordinaryRotationTelemetry.resetForTest()
    const ws = await workspace(storageRepo())
    // A base connection shard, so the connection READ ORDER (2) and its
    // OVERLAY list (1) differ: a kind that read the wrong list would show.
    const connBase = ws.repo.create({ connections: {} })
    await connBase.whenReady()
    await ws.repo.flush([connBase.documentId])
    await db.pool.query(
      'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [String(connBase.documentId), WS.landscapeId, WS.versionId],
    )
    ws.meta.change((d) => { d.connectionShardUrls.unshift(connBase.url) })
    await ws.repo.flush([ws.meta.documentId])
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const alertLength = 2
    const stop = await start(ws, residency, false, alertLength)
    let stopped = false
    const entry = (kind: 'object' | 'connection') => ordinaryRotationTelemetry.snapshot(config(false, alertLength))
      .entries.find((e) => e.workspace === LISTED && e.collection === kind)
    const alerts = () => log.events('read_model.ordinary_chain_length_alert')
    try {
      // Attached, nothing rotated: both kinds listed, one segment each.
      expect(entry('object')).toMatchObject({ resident: true, rotations: 0, overlayChain: 1, listedShards: 2, parkedHeads: 0, retiredRows: 0, chainAlert: false })
      expect(entry('connection')).toMatchObject({ resident: true, rotations: 0, overlayChain: 1, listedShards: 2, chainAlert: false })
      await fillAndRotate(ws, 'h0')
      // Two segments: AT the threshold, not over it.
      expect(await until(() => entry('object')?.rotations, (n) => n === 1)).toBe(1)
      expect(entry('object')).toMatchObject({ overlayChain: 2, chainAlert: false })
      expect(alerts()).toHaveLength(0)
      for (const tag of ['h1', 'h2']) await fillAndRotate(ws, tag)
      expect(await until(() => entry('object')?.rotations, (n) => n === 3)).toBe(3)
      // One line, on the crossing (3 > 2), not a second at 4.
      expect(alerts()).toEqual([expect.objectContaining({
        workspace: LISTED, kind: 'object', overlay: 3, threshold: alertLength, chainFold: 'off',
      })])
      // The rows come from the projector's retirement cache, which the
      // repoint RELOADS asynchronously (`freshRetirements`): the rotation
      // counter can lead it by one read. Waited for, then asserted whole
      // (failed once in a --static run: retiredRows 2 just after rotations 3).
      expect(await until(() => entry('object')?.retiredRows, (n) => n === 3)).toBe(3)
      expect(entry('object')).toMatchObject({
        overlayChain: 4, listedShards: 5, retiredRows: 3, foldedRows: 0, chainAlert: true,
        // The head was due on its changes (maxActors is a million here).
        rotationsByTrigger: { actors: 0, changes: 3, both: 0, unknown: 0 },
      })
      // The DURABLE rate, from the rows' created_at (reloaded on the repoint).
      expect(await until(() => entry('object')?.rotationsLast24h, (n) => n === 3)).toBe(3)
      expect(entry('object')).toMatchObject({ rotationsLast7d: 3, rotationsLast30d: 3 })
      expect(ordinaryRotationTelemetry.snapshot(config(false, alertLength)).chainAlerts).toBe(1)
      // The connection kind never rotated: counted apart.
      expect(entry('connection')).toMatchObject({ rotations: 0, overlayChain: 1, chainAlert: false })
      // Parked once settled, counted by kind.
      expect(await until(() => entry('object')?.parkedHeads, (n) => n === 3, 30_000)).toBe(3)
      expect(entry('connection')?.parkedHeads).toBe(0)
      // The current head's counts are the observer's last read of THAT head.
      const head = await ws.repo.find<ObjHead>(currentHead(ws) as AutomergeUrl)
      head.change((d) => { d.objects.c1 = { id: 'c1', name: 'C1', type: 'system' } })
      const counts = await until(() => entry('object')?.currentHead, (c) => (c?.changes ?? 0) >= 1, 15_000)
      expect(counts).toEqual(expect.objectContaining({ actors: A.stats(head.doc() as A.Doc<unknown>).numActors }))
      expect(counts!.changes).toBeLessThanOrEqual(A.stats(head.doc() as A.Doc<unknown>).numChanges)
      // A CONNECTION rotation: counted, listed and observed as its own kind.
      await fillAndRotateConnections(ws)
      expect(await until(() => entry('connection')?.rotations, (n) => n === 1)).toBe(1)
      // The same asynchronous cache reload as for the object kind above: the
      // rotation counter can lead the rows by one read (seen: retiredRows 0,
      // 2 runs in 38). Waited for, then asserted whole.
      expect(await until(() => entry('connection')?.retiredRows, (n) => n === 1)).toBe(1)
      const metaNow = ws.meta.doc()!
      expect(entry('connection')).toMatchObject({
        rotationsByTrigger: { changes: 1 }, overlayChain: 2,
        listedShards: metaNow.connectionShardUrls.length, retiredRows: 1, chainAlert: false,
      })
      expect(metaNow.connectionShardUrls).toHaveLength(3)
      expect(await until(() => entry('connection')?.rotationsLast24h, (n) => n === 1)).toBe(1)
      const connHead = await ws.repo.find<{ connections: Record<string, unknown> }>(metaNow.editsConnectionShardUrl as AutomergeUrl)
      connHead.change((d) => { d.connections.k1 = { id: 'k1', fromId: 'b', toId: 'x', label: 'k1' } })
      const connStats = () => A.stats(connHead.doc() as A.Doc<unknown>)
      const connCounts = await until(() => entry('connection')?.currentHead,
        (c) => c?.changes === connStats().numChanges, 15_000)
      expect(connCounts).toEqual({ actors: connStats().numActors, changes: connStats().numChanges })
      // The object entry did not move.
      expect(entry('object')).toMatchObject({ rotations: 3, overlayChain: 4, retiredRows: 3 })
      // The stats route's whole body is JSON.
      expect(() => JSON.stringify(ordinaryRotationTelemetry.snapshot(config(false, alertLength)))).not.toThrow()
      stop()
      stopped = true
      // A stopped projector's live-only fields go; the chain, the rows and the
      // alert stay as last known (the fold is off: the chain only grows), and
      // this process's count stays.
      expect(entry('object')).toMatchObject({
        resident: false, rotations: 3, overlayChain: 4, listedShards: 5, retiredRows: 3, rotationsLast24h: 3,
        parkedHeads: null, currentHead: null, chainAlert: true,
      })
      expect(ordinaryRotationTelemetry.snapshot(config(false, alertLength)).chainAlerts).toBe(1)
    } finally {
      if (!stopped) stop()
      log.restore()
      ordinaryRotationTelemetry.resetForTest()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
      delete process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS
    }
  }, 180_000)

  it('fold ON, no peer: a folded head is released and leaves the cache while the projector runs', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    ordinaryRotationTelemetry.resetForTest()
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    // A threshold the chain passes before the first fold: with the fold on,
    // never an alert (G4-16e).
    const stop = await start(ws, residency, true, 1)
    try {
      const retired = [await fillAndRotate(ws, 'h0'), await fillAndRotate(ws, 'h1')]
      const foldEntry = await until(() => ordinaryRotationTelemetry.snapshot(config(true, 1)).entries
        .find((e) => e.workspace === LISTED && e.collection === 'object'), (e) => e?.rotations === 2)
      expect(foldEntry).toMatchObject({ rotations: 2, chainAlert: false })
      expect(log.events('read_model.ordinary_chain_length_alert')).toHaveLength(0)
      const folds = await until(() => log.events('read_model.ordinary_chain_folded'), (lines) => lines.length >= 1, 60_000)
      expect(folds.length).toBeGreaterThanOrEqual(1)
      const sources = new Set(folds.flatMap((line) => line.sources as string[]))
      for (const id of retired) expect(sources.has(id)).toBe(true)
      const detached = await until(() => log.events('read_model.ordinary_fold_source_detached'), (lines) => lines.length >= retired.length, 60_000)
      expect(new Set(detached.map((line) => docId(String(line.url))))).toEqual(new Set(retired))
      // The detach released the lease (and set the watermark, so the poll
      // does not load it again: G4-16 M3 below); wait for the last eviction.
      for (const id of retired) {
        const gone = await until(async () => { await residency.drain(); return !resident(ws.repo, id) }, (v) => v, 15_000)
        expect(gone).toBe(true)
      }
      // Control: the current head is still resident and leased.
      expect(resident(ws.repo, docId(currentHead(ws)))).toBe(true)
      expect(await residency.evict(docId(currentHead(ws)))).toBe(false)
      // G4-16e: the durable rate counts ROTATIONS, not fold products. A fold
      // gives its product a `retired` row; one more rotation (a pointer move,
      // so the projector reloads its rows) brings that row into the cache.
      await fillAndRotate(ws, 'h2')
      const byOrigin = async () => Object.fromEntries((await db.pool.query<{ origin: string | null; n: string }>(
        `SELECT origin, count(*)::text AS n FROM read_model_ordinary_head_retirements
          WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' AND status IN ('retired', 'folded')
          GROUP BY origin`, [WS.landscapeId, WS.versionId],
      )).rows.map((row) => [String(row.origin), Number(row.n)]))
      const origins = await until(byOrigin, (o) => o.rotation === 3)
      expect(origins.rotation).toBe(3)
      expect(origins['fold-product']).toBeGreaterThanOrEqual(1)
      expect(origins.null).toBeUndefined()
      // N = 3 rotations + M >= 1 folds: the count is N.
      const durable = await until(() => ordinaryRotationTelemetry.snapshot(config(true, 1)).entries
        .find((e) => e.workspace === LISTED && e.collection === 'object'), (e) => (e?.retiredRows ?? 0) + (e?.foldedRows ?? 0) > 3)
      expect(durable).toMatchObject({ rotationsLast24h: 3, rotationsLast7d: 3, rotationsLast30d: 3, rotations: 3 })
    } finally {
      stop()
      log.restore()
      ordinaryRotationTelemetry.resetForTest()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  // ---- G4-16 M3: the poll never reloads a source the detach just evicted ----

  const degradedSince = async () => (await db.pool.query<{ degraded_since: unknown }>(
    'SELECT degraded_since FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
    [WS.landscapeId, WS.versionId],
  )).rows[0]?.degraded_since ?? null
  const watermarkOf = async (documentId: string) => (await db.pool.query<{ w: string | null }>(
    `SELECT arrival_watermark::text AS w FROM read_model_ordinary_head_retirements
      WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
    [WS.landscapeId, WS.versionId, documentId],
  )).rows[0]?.w ?? null
  /** caller -> the steady-phase load count (process-wide: compared as deltas). */
  const steadyLoads = () => Object.fromEntries(DOCUMENT_LOAD_CALLERS.map((caller) => [caller, documentLoadCount('steady', caller)]))
  /** Every storage read of a document's chunks (`StorageSubsystem.loadDoc`
   * issues `loadRange` per document): a load from storage, by anyone. */
  function storageLoads() {
    const original = PostgresStorageAdapter.prototype.loadRange
    const ids: string[] = []
    const spy = vi.spyOn(PostgresStorageAdapter.prototype, 'loadRange').mockImplementation(
      function (this: PostgresStorageAdapter, prefix) {
        ids.push(String(prefix[0]))
        return original.call(this, prefix)
      })
    return { of: (wanted: readonly string[]) => ids.filter((id) => wanted.includes(id)), restore: () => spy.mockRestore() }
  }
  /** The test pool, with the folded-arrival poll's query HELD after it ran
   * (its rows read) until `release` says so: a poll whose read predates a
   * commit made meanwhile. */
  function pollHoldingPool(hold: (rows: Array<{ document_id: string; watermark: string | null }>) => Promise<void>) {
    return new Proxy(db.pool, {
      get(target, prop) {
        if (prop === 'query') {
          return async (...args: unknown[]) => {
            const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '')
            const result = await (target.query as (...a: unknown[]) => Promise<{ rows: unknown[] }>)(...args)
            if (text.includes('CROSS JOIN LATERAL') && text.includes('arrival_watermark')) {
              await hold(result.rows as Array<{ document_id: string; watermark: string | null }>)
            }
            return result
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as IsolatedSchemaDb['pool']
  }

  it('G4-16 M3, fold ON, no peer: the detach sets each source\'s watermark, the poll never reloads the evicted sources, and a late write is still carried', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const loads = storageLoads()
    const stop = await start(ws, residency, true)
    const steadyBefore = steadyLoads()
    try {
      const retired = [await fillAndRotate(ws, 'h0'), await fillAndRotate(ws, 'h1')]
      const detached = await until(() => log.events('read_model.ordinary_fold_source_detached'), (lines) => lines.length >= 2, 60_000)
      expect(new Set(detached.map((line) => docId(String(line.url))))).toEqual(new Set(retired))
      // Each detach set the watermark to the head's highest content arrival.
      const arrivals = await documentContentArrivals(db.pool, retired)
      for (const line of detached) {
        const id = docId(String(line.url))
        expect(line.watermark).not.toBeNull()
        expect(line.watermark).toBe(arrivals.get(id))
        expect(await watermarkOf(id)).toBe(line.watermark)
      }
      for (const id of retired) {
        expect(await until(async () => { await residency.drain(); return !resident(ws.repo, id) }, (v) => v, 15_000)).toBe(true)
      }
      // Several poll periods: no folded source was read back from storage.
      await settle(1_500)
      expect(loads.of(retired)).toEqual([])
      expect(log.events('read_model.document_loaded')).toEqual([])
      // Not one non-resident load by the projector since its attach, on any
      // path — the fold resolved its resident sources and product many times:
      // a resident resolution is never counted.
      expect(steadyLoads()).toEqual(steadyBefore)

      // A late write to a folded, evicted head (a client's sync loads it):
      // above the watermark, so the poll still forwards it to its row.
      const late = await ws.repo.find<ObjHead>(`automerge:${retired[0]}` as AutomergeUrl)
      // Witness: the spy sees a load (`loadDoc` reads two ranges per document).
      expect(new Set(loads.of(retired))).toEqual(new Set([retired[0]]))
      late.change((d) => { d.objects.late = { id: 'late', name: 'carried', type: 'system' } })
      await ws.repo.flush([late.documentId])
      expect((await until(() => roObject('late'), (row) => row?.name === 'carried', 15_000))?.name).toBe('carried')
      const after = await until(() => watermarkOf(retired[0]!), (w) => w !== null && BigInt(w) > BigInt(arrivals.get(retired[0]!)!))
      expect(BigInt(after!)).toBeGreaterThan(BigInt(arrivals.get(retired[0]!)!))
    } finally {
      stop()
      loads.restore()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  it('G4-16 M3: a poll that read a source\'s row BEFORE its detach committed the watermark does not reload it either', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const loads = storageLoads()
    let held = 0
    // A poll that read a NULL watermark (a folded row whose detach had not
    // committed yet) returns only once that detach is logged: it then
    // iterates rows older than the commit.
    const pool = pollHoldingPool(async (rows) => {
      const stale = rows.filter((row) => row.watermark === null).map((row) => row.document_id)
      if (!stale.length) return
      held += 1
      await until(() => {
        const done = new Set(log.events('read_model.ordinary_fold_source_detached').map((line) => docId(String(line.url))))
        return stale.every((id) => done.has(id))
      }, (v) => v, 30_000)
    })
    // The detach's first flush of `slowFor`, once ModelMeta no longer lists
    // it, waits three poll periods: the poll timer (running since the first
    // fold) reads the recorded rows, still NULL, meanwhile.
    let slowFor: string | null = null
    const listed = (id: string) => ws.meta.doc()!.objectShardUrls.some((url) => docId(url) === id)
    const originalFlush = ws.repo.flush.bind(ws.repo)
    const flushSpy = vi.spyOn(ws.repo, 'flush').mockImplementation(async (ids) => {
      if (slowFor && (ids ?? []).map(String).includes(slowFor) && !listed(slowFor)) {
        slowFor = null
        await settle(700)
      }
      return originalFlush(ids)
    })
    const stop = await startReadModelProjector(
      ws.repo, ws.rootUrl, pool, WS, residency, 0, undefined,
      undefined, undefined, undefined, config(true),
    )
    try {
      // First fold: starts the poll timer.
      await fillAndRotate(ws, 'h0')
      await fillAndRotate(ws, 'h1')
      await until(() => log.events('read_model.ordinary_fold_source_detached').length, (n) => n >= 2, 60_000)
      const firstProduct = String(log.events('read_model.ordinary_chain_folded')[0]!.product)
      expect(held).toBe(0) // witness: no stale read so far
      // Second fold: the first product and h2, its detach slowed.
      const h2 = await fillAndRotate(ws, 'h2')
      slowFor = h2
      await until(() => log.events('read_model.ordinary_fold_source_detached').length, (n) => n >= 4, 60_000)
      const second = [firstProduct, h2]
      expect(new Set(log.events('read_model.ordinary_fold_source_detached').slice(2).map((line) => docId(String(line.url)))))
        .toEqual(new Set(second))
      for (const id of second) {
        expect(await until(async () => { await residency.drain(); return !resident(ws.repo, id) }, (v) => v, 15_000)).toBe(true)
      }
      await settle(1_500)
      // Witness: a poll read the second fold's rows before its detach committed.
      expect(slowFor).toBeNull()
      expect(held).toBeGreaterThanOrEqual(1)
      expect(loads.of(second)).toEqual([])
      for (const id of second) expect(await watermarkOf(id)).not.toBeNull()
    } finally {
      stop()
      flushSpy.mockRestore()
      loads.restore()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  // ---- G4-16 M3 (QA): writes that reach a fold source WHILE its detach runs ----

  /** The test pool, every pool-level query offered to `after` once it ran. */
  function poolAfterQuery(after: (text: string, rows: unknown[]) => Promise<void>) {
    return new Proxy(db.pool, {
      get(target, prop) {
        if (prop === 'query') {
          return async (...args: unknown[]) => {
            const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '')
            const result = await (target.query as (...a: unknown[]) => Promise<{ rows: unknown[] }>)(...args)
            await after(text, result.rows)
            return result
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as IsolatedSchemaDb['pool']
  }

  /** Fold two retired heads with a write injected into the FIRST source whose
   * detach starts (its first flush after ModelMeta unlisted it):
   *  - `before-first-flush`: a change in the handle before the detach's first
   *    flush, never forwarded by any watcher (the source is unwatched): the
   *    heads are not settled, so no watermark may be set;
   *  - `after-sample-saved`: after the heads were sampled and the settled check
   *    answered, one change reaches the handle and is saved (its chunk is the
   *    head's LAST: no later chunk drags it into a forward);
   *  - `after-sample-unsaved`: the same, but the change is not saved at all
   *    (only the detach's last flush saves it);
   *  - `cas-refused`: the row's watermark is moved off NULL first, so the
   *    detach's CAS is refused. */
  async function foldWithInjection(
    mode: 'before-first-flush' | 'after-sample-saved' | 'after-sample-unsaved' | 'cas-refused' | 'fence-lost' | 'unsaved-after-failed-read',
    check: (run: { mine: Record<string, unknown>; other: Record<string, unknown>; fenceLost: () => number; failedLines: () => unknown[]; carried: (name: string) => Promise<Record<string, unknown> | undefined> }) => Promise<void>,
  ) {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const seen = new Set<string>()
    const remember = () => { for (const url of ws.meta.doc()!.objectShardUrls) seen.add(docId(url)) }
    remember()
    ws.meta.on('change', remember)
    const unlisted = (id: string) => seen.has(id) && !ws.meta.doc()!.objectShardUrls.some((url) => docId(url) === id)
    let target: string | null = null
    let injected = false
    let fenceLost = 0
    let failedRead = false
    const write = async (id: string, name: string) => {
      const handle = await ws.repo.find<ObjHead>(`automerge:${id}` as AutomergeUrl)
      handle.change((d) => { d.objects[name] = { id: name, name, type: 'system' } })
      return handle
    }
    const originalFlush = ws.repo.flush.bind(ws.repo)
    const flushSpy = vi.spyOn(ws.repo, 'flush').mockImplementation(async (ids) => {
      const hit = target === null ? (ids ?? []).map(String).find(unlisted) : undefined
      if (hit && mode === 'unsaved-after-failed-read') {
        target = hit
        const flushed = await originalFlush(ids)
        await write(hit, 'x-late')
        injected = true
        return flushed
      }
      if (hit) {
        target = hit
        if (mode === 'before-first-flush') { await write(hit, 'x-pre'); injected = true }
        if (mode === 'fence-lost') {
          await db.pool.query(
            `UPDATE read_model_projection_state SET write_fence = 'someone-else' WHERE landscape_id = $1 AND version_id = $2`,
            [WS.landscapeId, WS.versionId])
          injected = true
        }
        if (mode === 'cas-refused') {
          await db.pool.query(
            `UPDATE read_model_ordinary_head_retirements SET arrival_watermark = 1
              WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`, [WS.landscapeId, WS.versionId, hit])
          injected = true
        }
      }
      return originalFlush(ids)
    })
    const pool = poolAfterQuery(async (text) => {
      if (mode === 'unsaved-after-failed-read' && target && !failedRead && text.includes('AS d(id)')) {
        failedRead = true
        throw new Error('injected arrivals read failure')
      }
      if (!mode.startsWith('after-sample') || !target || injected) return
      if (!text.includes('read_model_ordinary_head_retirements') || text.includes('CROSS JOIN LATERAL') || !/^\s*SELECT/i.test(text)) return
      injected = true
      const handle = await write(target, mode === 'after-sample-saved' ? 'x-saved' : 'x-unsaved')
      if (mode === 'after-sample-saved') await originalFlush([handle.documentId])
    })
    const stop = await startReadModelProjector(
      ws.repo, ws.rootUrl, pool, WS, residency, 0, undefined,
      undefined, () => { fenceLost += 1 }, undefined, config(true),
    )
    try {
      await fillAndRotate(ws, 'h0')
      await fillAndRotate(ws, 'h1')
      const detached = await until(() => log.events('read_model.ordinary_fold_source_detached'), (lines) => lines.length >= 2, 60_000)
      expect(detached).toHaveLength(2)
      expect(target).not.toBeNull()
      expect(injected).toBe(true)
      const mine = detached.find((line) => docId(String(line.url)) === target)!
      const other = detached.find((line) => docId(String(line.url)) !== target)!
      await check({ mine, other, fenceLost: () => fenceLost, failedLines: () => log.events('read_model.ordinary_fold_source_watermark_failed'), carried: (name) => until(() => roObject(name), (row) => row?.name === name, 20_000) })
    } finally {
      stop()
      flushSpy.mockRestore()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }

  it('G4-16 M3 (QA): a change in a source\'s handle before the detach\'s first flush leaves its heads unsettled: no watermark, and the change is still carried', async () => {
    await foldWithInjection('before-first-flush', async (run) => {
      expect(run.mine.watermark).toBeNull()
      expect(run.other.watermark).not.toBeNull()
      expect((await run.carried('x-pre'))?.name).toBe('x-pre')
    })
  }, 180_000)

  it('G4-16 M3 (QA): a change that reaches a source after its heads were sampled and is saved at once (its chunk is above S) is carried', async () => {
    await foldWithInjection('after-sample-saved', async (run) => {
      expect(run.mine.watermark).not.toBeNull()
      expect((await run.carried('x-saved'))?.name).toBe('x-saved')
    })
  }, 180_000)

  it('G4-16 M3 (QA): a change that reaches a source after its heads were sampled and is only in its handle is saved by the last flush and carried', async () => {
    await foldWithInjection('after-sample-unsaved', async (run) => {
      expect(run.mine.watermark).not.toBeNull()
      expect((await run.carried('x-unsaved'))?.name).toBe('x-unsaved')
    })
  }, 180_000)

  it('G4-16 M3 (QA): a refused CAS reports no watermark (and the poll carries the source as before)', async () => {
    await foldWithInjection('cas-refused', async (run) => {
      expect(run.mine.watermark).toBeNull()
    })
  }, 180_000)

  it('G4-16 M3 (QA): the batch\'s watermark read FAILS after the first flush while a change reaches a source: the last flush (in a finally) still saves it, and it is carried', async () => {
    await foldWithInjection('unsaved-after-failed-read', async (run) => {
      // The batch got no watermark at all: the throw came before the commit.
      expect(run.mine.watermark).toBeNull()
      expect(run.other.watermark).toBeNull()
      expect(run.failedLines().length).toBeGreaterThanOrEqual(1)
      expect((await run.carried('x-late'))?.name).toBe('x-late')
    })
  }, 180_000)

  it('G4-16 M3 (QA): a write fence lost under the detach\'s watermark batch is reported as a lost fence (not a warning), and the sources are still detached without watermark', async () => {
    await foldWithInjection('fence-lost', async (run) => {
      expect(run.mine.watermark).toBeNull()
      expect(run.other.watermark).toBeNull()
      expect(await until(() => run.fenceLost(), (n) => n >= 1, 15_000)).toBeGreaterThanOrEqual(1)
      // A lost fence is the authority's business, not a warning about the watermark.
      expect(run.failedLines()).toEqual([])
    })
  }, 180_000)

  it('G4-16 M3 review: a throw mid-way through a detach batch still finishes every source it took — lease back, out of the detaching set — and a late write to an earlier one still reaches its row', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stop = await start(ws, residency, true)
    const listed = (id: string) => ws.meta.doc()!.objectShardUrls.some((url) => docId(url) === id)
    try {
      const h0 = await fillAndRotate(ws, 'h0')
      // The SECOND source's watcher stop throws, once it is unlisted (the
      // detach's own stop): the batch throws after taking both sources.
      const h1 = docId(currentHead(ws))
      const h1Handle = await ws.repo.find<ObjHead>(currentHead(ws) as AutomergeUrl)
      const h0Handle = await ws.repo.find<ObjHead>(`automerge:${h0}` as AutomergeUrl)
      const originalOff = h1Handle.off.bind(h1Handle) as (...args: unknown[]) => unknown
      let thrown = 0
      const offSpy = vi.spyOn(h1Handle, 'off').mockImplementation(((...args: unknown[]) => {
        if (args[0] === 'change' && thrown === 0 && !listed(h1)) {
          thrown += 1
          // The earlier source, already stopped, gets a write only its handle
          // holds (saves are debounced for a minute here): only the batch's
          // flush, before the eviction, keeps it.
          h0Handle.change((d) => { d.objects.atThrow = { id: 'atThrow', name: 'at the throw', type: 'system' } })
          throw new Error('injected watcher stop failure')
        }
        return originalOff(...args)
      }) as unknown as typeof h1Handle.off)
      try {
        expect(await fillAndRotate(ws, 'h1')).toBe(h1)
        const detached = await until(() => log.events('read_model.ordinary_fold_source_detached'), (lines) => lines.length >= 2, 30_000)
        expect(thrown).toBe(1) // witness: the batch did throw
        expect(new Set(detached.map((line) => docId(String(line.url))))).toEqual(new Set([h0, h1]))
        // No watermark: the throw came before the batch could set any.
        for (const line of detached) expect(line.watermark).toBeNull()
      } finally {
        offSpy.mockRestore()
      }
      // Both leases given back: the sources leave the cache.
      for (const id of [h0, h1]) {
        expect(await until(async () => { await residency.drain(); return !resident(ws.repo, id) }, (v) => v, 15_000)).toBe(true)
      }
      // A late write to the EARLIER source, through another Repo: the poll
      // (not skipping it as detaching) loads it and forwards it.
      const other = storageRepo()
      const late = await other.find<ObjHead>(`automerge:${h0}` as AutomergeUrl)
      late.change((d) => { d.objects.afterThrow = { id: 'afterThrow', name: 'after the throw', type: 'system' } })
      await other.flush([late.documentId])
      expect((await until(() => roObject('afterThrow'), (row) => row?.name === 'after the throw', 20_000))?.name)
        .toBe('after the throw')
      expect((await until(() => roObject('atThrow'), (row) => row?.name === 'at the throw', 20_000))?.name).toBe('at the throw')
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  /** The test pool, `before` offered each query (pool-level and on a client
   * from `connect()`) and its parameters BEFORE it runs: it may hold or throw. */
  function poolBeforeQuery(before: (text: string, params: unknown[] | undefined) => Promise<void> | void) {
    const wrapQuery = (target: { query: (...a: unknown[]) => unknown }) => async (...args: unknown[]) => {
      const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '')
      await before(text, args[1] as unknown[] | undefined)
      return target.query(...args)
    }
    return new Proxy(db.pool, {
      get(target, prop) {
        if (prop === 'query') return wrapQuery(target as never)
        if (prop === 'connect') {
          return async () => {
            const client = await target.connect()
            return new Proxy(client, {
              get(c, p) {
                if (p === 'query') return wrapQuery(c as never)
                const value = Reflect.get(c, p, c) as unknown
                return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(c) : value
              },
            })
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as IsolatedSchemaDb['pool']
  }

  it('G4-16 M3 review: a pass IN FLIGHT on an earlier source when the detach batch throws is awaited before its lease goes, and the unsaved write it carries is not lost', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const listed = (id: string) => ws.meta.doc()!.objectShardUrls.some((url) => docId(url) === id)
    let thrown = 0
    // The earlier source's forward pass reads its row fresh; that read waits
    // until the batch has thrown, so the pass is parked across the throw.
    let holdFor: string | null = null
    let failCommitFor: string | null = null
    let held = 0
    const pool = poolBeforeQuery(async (text, params) => {
      // The parked pass then FAILS its commit: a failure that must land
      // before its source is cleared, never after (re-degrading a detached head).
      if (failCommitFor && text.includes('SET forwarded_heads = $6::text[]') && params?.[3] === failCommitFor) {
        failCommitFor = null
        throw new Error('injected forward commit failure')
      }
      if (!holdFor || !text.includes('FROM read_model_ordinary_head_retirements') || !text.includes('AND document_id = $4')
        || params?.[3] !== holdFor) return
      holdFor = null
      held += 1
      // While the pass is parked (its snapshot taken): a second write only the
      // handle holds — not in this pass, never saved unless a flush saves it.
      lateHandle?.change((d) => { d.objects.parked = { id: 'parked', name: 'while parked', type: 'system' } })
      await until(() => thrown, (n) => n >= 1, 30_000)
      await settle(300)
    })
    let lateHandle: DocHandle<ObjHead> | null = null
    const stop = await startReadModelProjector(
      ws.repo, ws.rootUrl, pool, WS, residency, 0, undefined,
      undefined, undefined, undefined, config(true),
    )
    const spies: Array<{ mockRestore: () => void }> = []
    try {
      const h0 = await fillAndRotate(ws, 'h0')
      const h1 = docId(currentHead(ws))
      const h1Handle = await ws.repo.find<ObjHead>(currentHead(ws) as AutomergeUrl)
      const originalOff = h1Handle.off.bind(h1Handle) as (...args: unknown[]) => unknown
      spies.push(vi.spyOn(h1Handle, 'off').mockImplementation(((...args: unknown[]) => {
        if (args[0] === 'change' && thrown === 0 && !listed(h1)) {
          thrown += 1
          throw new Error('injected watcher stop failure')
        }
        return originalOff(...args)
      }) as unknown as typeof h1Handle.off))
      // The product's SECOND resolution is its watcher's, after the settle
      // check: the earlier source then gets an unsaved write its own watcher
      // starts forwarding (saves are debounced for a minute here).
      let productUrl: string | null = null
      let productFinds = 0
      const originalCreate = ws.repo.create.bind(ws.repo) as (...args: unknown[]) => DocHandle<unknown>
      spies.push(vi.spyOn(ws.repo, 'create').mockImplementation(((...args: unknown[]) => {
        const handle = originalCreate(...args)
        const init = args[0] as Record<string, unknown> | undefined
        if (init && typeof init === 'object' && ORDINARY_FOLD_SOURCES_FIELD in init) productUrl = handle.url
        return handle
      }) as unknown as typeof ws.repo.create))
      const h0Handle = await ws.repo.find<ObjHead>(`automerge:${h0}` as AutomergeUrl)
      lateHandle = h0Handle as DocHandle<ObjHead>
      const originalFind = ws.repo.find.bind(ws.repo) as (...args: unknown[]) => unknown
      spies.push(vi.spyOn(ws.repo, 'find').mockImplementation(((...args: unknown[]) => {
        if (productUrl && String(args[0]) === productUrl && ++productFinds === 2) {
          holdFor = h0
          failCommitFor = h0
          h0Handle.change((d) => { d.objects.inFlight = { id: 'inFlight', name: 'in flight', type: 'system' } })
        }
        return originalFind(...args)
      }) as unknown as typeof ws.repo.find))
      expect(await fillAndRotate(ws, 'h1')).toBe(h1)
      const detached = await until(() => log.events('read_model.ordinary_fold_source_detached'), (lines) => lines.length >= 2, 30_000)
      expect(new Set(detached.map((line) => docId(String(line.url))))).toEqual(new Set([h0, h1]))
      // Witnesses: the batch threw, and the earlier source's pass was in flight.
      expect(thrown).toBe(1)
      expect(held).toBe(1)
      expect((await until(() => roObject('inFlight'), (row) => row?.name === 'in flight', 20_000))?.name).toBe('in flight')
      // Saved by the detach's flush before the eviction, found by the poll.
      expect((await until(() => roObject('parked'), (row) => row?.name === 'while parked', 20_000))?.name).toBe('while parked')
      // The parked pass finished BEFORE its source was cleared and evicted: it
      // refused nothing on the way out.
      await settle(500)
      expect(log.events('read_model.ordinary_head_forward_refused')).toEqual([])
      // The failed commit degraded the head while it was still watched; the
      // detach cleared that once the pass was done, so nothing stays degraded.
      expect(await until(degradedSince, (since) => since === null, 15_000)).toBeNull()
      for (const id of [h0, h1]) {
        expect(await until(async () => { await residency.drain(); return !resident(ws.repo, id) }, (v) => v, 15_000)).toBe(true)
      }
    } finally {
      for (const spy of spies.reverse()) spy.mockRestore()
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  it('G4-16 M3 review: a fold pass that throws after its product exists and before its record commits gives the product\'s lease back, and the retry folds', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    let failed = 0
    const pool = poolBeforeQuery((text) => {
      if (failed === 0 && text.includes('INSERT INTO read_model_ordinary_chain_folds')) {
        failed += 1
        throw new Error('injected record failure')
      }
    })
    const products: string[] = []
    const originalCreate = ws.repo.create.bind(ws.repo) as (...args: unknown[]) => DocHandle<unknown>
    const createSpy = vi.spyOn(ws.repo, 'create').mockImplementation(((...args: unknown[]) => {
      const handle = originalCreate(...args)
      const init = args[0] as Record<string, unknown> | undefined
      if (init && typeof init === 'object' && ORDINARY_FOLD_SOURCES_FIELD in init) products.push(String(handle.documentId))
      return handle
    }) as unknown as typeof ws.repo.create)
    const stop = await startReadModelProjector(
      ws.repo, ws.rootUrl, pool, WS, residency, 0, undefined,
      undefined, undefined, undefined, config(true),
    )
    try {
      await fillAndRotate(ws, 'h0')
      await fillAndRotate(ws, 'h1')
      const folds = await until(() => log.events('read_model.ordinary_chain_folded'), (lines) => lines.length >= 1, 60_000)
      expect(failed).toBe(1) // witness: the first record threw
      expect(log.events('read_model.ordinary_chain_fold_failed').length).toBeGreaterThanOrEqual(1)
      expect(products.length).toBeGreaterThanOrEqual(2)
      // The orphan of the failed pass: no lease, so it leaves the cache.
      expect(await until(() => residency.isLeased(products[0]!), (leased) => !leased, 15_000)).toBe(false)
      // The product the retry recorded keeps its lease (attached, watched).
      expect(folds[0]!.product).toBe(products[products.length - 1])
      expect(residency.isLeased(products[products.length - 1]!)).toBe(true)
    } finally {
      stop()
      createSpy.mockRestore()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  /** A fold pass failing around its record's COMMIT, by `at`:
   *  - `commit`: the COMMIT itself throws — nothing is recorded, the product is
   *    an orphan: its lease goes at once;
   *  - `after-commit`: the first `stillOwned()` after the COMMIT throws — the
   *    record is durable, the next pass publishes the product: its lease stays
   *    until then. */
  async function foldFailingAroundCommit(at: 'commit' | 'after-commit') {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    let recordSeen = false
    let failed = 0
    let throwOnOwned = false
    const products: string[] = []
    const pool = poolBeforeQuery((text) => {
      if (text.includes('INSERT INTO read_model_ordinary_chain_folds')) recordSeen = true
      if (at === 'commit' && recordSeen && failed === 0 && text.trim() === 'COMMIT') {
        failed += 1
        throw new Error('injected COMMIT failure')
      }
      // Armed as the record's COMMIT starts: the first `stillOwned()` after it
      // (the pass's own, a few microtasks after the COMMIT resolves) throws.
      if (at === 'after-commit' && recordSeen && failed === 0 && text.trim() === 'COMMIT') throwOnOwned = true
    })
    const stillOwned = () => {
      if (throwOnOwned && failed === 0) {
        throwOnOwned = false
        failed += 1
        throw new Error('injected failure after the COMMIT')
      }
      return true
    }
    const originalCreate = ws.repo.create.bind(ws.repo) as (...args: unknown[]) => DocHandle<unknown>
    const createSpy = vi.spyOn(ws.repo, 'create').mockImplementation(((...args: unknown[]) => {
      const handle = originalCreate(...args)
      const init = args[0] as Record<string, unknown> | undefined
      if (init && typeof init === 'object' && ORDINARY_FOLD_SOURCES_FIELD in init) products.push(String(handle.documentId))
      return handle
    }) as unknown as typeof ws.repo.create)
    const stop = await startReadModelProjector(
      ws.repo, ws.rootUrl, pool, WS, residency, 0, undefined,
      stillOwned, undefined, undefined, config(true),
    )
    try {
      await fillAndRotate(ws, 'h0')
      await fillAndRotate(ws, 'h1')
      await until(() => log.events('read_model.ordinary_chain_fold_failed'), (lines) => lines.length >= 1, 60_000)
      const leasedAtFailure = residency.isLeased(products[0]!)
      expect(failed).toBe(1) // witness
      return { leasedAtFailure, products, folded: () => log.events('read_model.ordinary_chain_folded') }
    } finally {
      stop()
      createSpy.mockRestore()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }

  it('G4-16 M3 (QA): a fold pass whose COMMIT throws leaves an orphan product: its lease goes', async () => {
    const run = await foldFailingAroundCommit('commit')
    // Sampled the moment the failure was logged: the orphan is not leased.
    expect(run.leasedAtFailure).toBe(false)
  }, 180_000)

  it('G4-16 M3 (QA): a fold pass that throws AFTER its record committed keeps the product\'s lease (the next pass publishes it)', async () => {
    const run = await foldFailingAroundCommit('after-commit')
    expect(run.leasedAtFailure).toBe(true)
  }, 180_000)

  it('G4-16 M3 review: a fold pass that finds stillOwned() false (a renewal flicker) is RETRIED, and folds once it reads true again', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    let owned = true
    // Once armed, the next overlay-rotation lock taken (the fold's: the
    // rotations are done) reads ownership false for 300 ms: the writer's
    // check right after the lock answers `not-owner`.
    let armed = false
    const pool = poolBeforeQuery((text) => {
      if (!armed || !text.includes('pg_try_advisory_lock')) return
      armed = false
      owned = false
      setTimeout(() => { owned = true }, 300)
    })
    const stop = await startReadModelProjector(
      ws.repo, ws.rootUrl, pool, WS, residency, 0, undefined,
      () => owned, undefined, undefined,
      { ...config(true), chainFold: { minChain: 3, budget: 8, retainMs: 86_400_000 } },
    )
    try {
      await fillAndRotate(ws, 'h0')
      await fillAndRotate(ws, 'h1')
      await fillAndRotate(ws, 'h2')
      // The third rotation is done (MIN 3): the next lock is the fold's.
      armed = true
      const passes = () => log.events('read_model.ordinary_chain_fold_pass').filter((line) => line.kind === 'object')
      // Witness: a pass was refused as not-owner.
      expect(await until(() => passes().some((line) => line.outcome === 'not-owner'), (v) => v, 15_000)).toBe(true)
      const refusedAt = Date.now()
      // Retried from a FRESH attempt count (1 s; the deferrals behind the
      // rotations had already reached 30 s), and it folds: no further rotation.
      expect(await until(() => log.events('read_model.ordinary_chain_folded').length, (n) => n >= 1, 15_000))
        .toBeGreaterThanOrEqual(1)
      expect(Date.now() - refusedAt).toBeLessThan(10_000)
    } finally {
      owned = true
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  /** The fold product's build, disturbed as soon as the product exists, by
   * `mode`:
   *  - `flicker`: `stillOwned()` reads false from the product's creation
   *    until its claim (a lease-renewal flip: process-local, not the
   *    database's answer) — the build must NOT stop for it;
   *  - `fence`: the write fence moves to another instance — nothing may be
   *    claimed or listed, and the unnamed product's lease goes at once;
   *  - `stop`: `stop()` — nothing may be claimed or listed. */
  async function foldBuildDisturbed(mode: 'flicker' | 'fence' | 'stop') {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    let owned = true
    let productId: string | null = null
    let fenceMoved: Promise<unknown> = Promise.resolve()
    let stopFn: () => void = () => {}
    const originalCreate = ws.repo.create.bind(ws.repo) as (...args: unknown[]) => DocHandle<unknown>
    const createSpy = vi.spyOn(ws.repo, 'create').mockImplementation(((...args: unknown[]) => {
      const handle = originalCreate(...args)
      const init = args[0] as Record<string, unknown> | undefined
      if (init && typeof init === 'object' && ORDINARY_FOLD_SOURCES_FIELD in init) {
        productId = String(handle.documentId)
        if (mode === 'flicker') owned = false
        if (mode === 'fence') {
          fenceMoved = db.pool.query(
            `UPDATE read_model_projection_state SET write_fence = 'someone-else' WHERE landscape_id = $1 AND version_id = $2`,
            [WS.landscapeId, WS.versionId])
        }
        if (mode === 'stop') setTimeout(() => stopFn(), 0)
      }
      return handle
    }) as unknown as typeof ws.repo.create)
    // The claim ends the flicker: ownership reads true again from there on.
    const restoreClaim = setWorkspaceDocumentsRegistrationForTest(async ({ landscapeId, versionId, documentIds }) => {
      if (productId && documentIds.includes(productId)) owned = true
      for (const documentId of documentIds) {
        await db.pool.query(
          'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [documentId, landscapeId, versionId])
      }
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
    let fenceLost = 0
    const stop = await startReadModelProjector(
      ws.repo, ws.rootUrl, db.pool, WS, residency, 0, undefined,
      () => owned, () => { fenceLost += 1 }, undefined, config(true),
    )
    stopFn = stop
    const claimedRows = async () => (await db.pool.query(
      'SELECT 1 FROM automerge_document_workspace WHERE document_id = $1', [productId])).rowCount
    const listed = () => ws.meta.doc()!.objectShardUrls.map(docId).includes(productId!)
    try {
      await fillAndRotate(ws, 'h0')
      await fillAndRotate(ws, 'h1')
      expect(await until(() => productId, (id) => id !== null, 60_000)).not.toBeNull()
      if (mode === 'flicker') {
        // Not aborted: the fold completes once ownership is back.
        expect(await until(listed, (v) => v, 30_000)).toBe(true)
        expect(await claimedRows()).toBe(1)
        // The fold's log line follows the listing by a few awaits: waited for.
        expect(await until(() => log.events('read_model.ordinary_chain_folded').map((line) => line.product), (products) => products.includes(productId))).toContain(productId)
        return
      }
      await fenceMoved
      if (mode === 'fence') {
        // The build stopped at its claim: its unnamed document gives its lease
        // back (the projector still runs: no `releaseOwner` did it).
        expect(await until(() => residency.isLeased(productId!), (leased) => !leased, 15_000)).toBe(false)
        expect(await until(() => fenceLost, (n) => n >= 1, 15_000)).toBeGreaterThanOrEqual(1)
      }
      await settle(1_500)
      expect(await claimedRows()).toBe(0)
      // Nothing names it: ModelMeta still lists the sources, not the product.
      expect(listed()).toBe(false)
    } finally {
      owned = true
      stop()
      createSpy.mockRestore()
      restoreClaim()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }

  it('G4-16 M3 (QA): a stillOwned() flicker while the fold product is being built does NOT stop it: the fold completes once ownership is back', async () => {
    await foldBuildDisturbed('flicker')
  }, 180_000)

  it('G4-16 M3 (QA): the write fence lost while the fold product is being built: no claim, no listing, and the unnamed product gives its lease back', async () => {
    await foldBuildDisturbed('fence')
  }, 180_000)

  it('G4-16 M3 (QA): a stop() while the fold product is being built: the build stops before the claim', async () => {
    await foldBuildDisturbed('stop')
  }, 180_000)

  it('G4-16 M3 (QA): a load the poll has to make for a folded source is counted under its caller (and logged only when slow)', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stop = await start(ws, residency, true)
    try {
      const retired = [await fillAndRotate(ws, 'h0'), await fillAndRotate(ws, 'h1')]
      await until(() => log.events('read_model.ordinary_fold_source_detached'), (lines) => lines.length >= 2, 60_000)
      for (const id of retired) {
        expect(await until(async () => { await residency.drain(); return !resident(ws.repo, id) }, (v) => v, 15_000)).toBe(true)
      }
      const before = steadyLoads()
      // A write through ANOTHER Repo on the same storage: this one has to load the head.
      const other = storageRepo()
      const late = await other.find<ObjHead>(`automerge:${retired[0]}` as AutomergeUrl)
      late.change((d) => { d.objects.far = { id: 'far', name: 'far', type: 'system' } })
      await other.flush([late.documentId])
      expect((await until(() => roObject('far'), (row) => row?.name === 'far', 15_000))?.name).toBe('far')
      const after = await until(steadyLoads, (counts) => counts['folded-arrival'] === before['folded-arrival']! + 1, 15_000)
      // Exactly one load, by the folded-arrival poll, and none by another path.
      expect(after).toEqual({ ...before, 'folded-arrival': before['folded-arrival']! + 1 })
      // Logged one by one only at DOCUMENT_LOAD_LOG_MS or more, with its caller.
      for (const line of log.events('read_model.document_loaded')) {
        expect(line).toMatchObject({ caller: 'folded-arrival', documentId: retired[0], workspace: LISTED })
        expect(Number(line.ms)).toBeGreaterThanOrEqual(DOCUMENT_LOAD_LOG_MS)
      }
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)

  it('G4-16 M3 (QA M19b), fold OFF: a parked head is parked from its resident handle (no load), and a late write to it once evicted is counted under parked-arrival', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS = '300'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stop = await start(ws, residency, false)
    const before = steadyLoads()
    try {
      const retired = await fillAndRotate(ws, 'h0')
      await until(() => log.events('read_model.ordinary_retired_head_parked').some((line) => docId(String(line.url)) === retired),
        (v) => v, 15_000)
      expect(await until(async () => { await residency.drain(); return !resident(ws.repo, retired) }, (v) => v, 15_000)).toBe(true)
      // The park read its own watched, resident head: nothing loaded.
      expect(steadyLoads()).toEqual(before)
      const other = storageRepo()
      const late = await other.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
      late.change((d) => { d.objects.parkedLate = { id: 'parkedLate', name: 'parked late', type: 'system' } })
      await other.flush([late.documentId])
      expect((await until(() => roObject('parkedLate'), (row) => row?.name === 'parked late', 15_000))?.name).toBe('parked late')
      const after = await until(steadyLoads, (counts) => counts['parked-arrival'] === before['parked-arrival']! + 1, 15_000)
      expect(after).toEqual({ ...before, 'parked-arrival': before['parked-arrival']! + 1 })
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
      delete process.env.AM_ORDINARY_RETIRED_HEAD_PARK_MS
    }
  }, 180_000)

  it('G4-16 M3 (QA): a cold start counts the loads of its own attach as attach loads, summed in one line; none as steady', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const seeded = await workspace(storageRepo())
    await seeded.repo.flush()
    const cold = { ...seeded, repo: storageRepo() }
    const residency = new AutomergeResidencyLeases(cold.repo)
    const log = logLines()
    const attachLoads = () => DOCUMENT_LOAD_CALLERS.reduce((n, caller) => n + documentLoadCount('attach', caller), 0)
    const attachBefore = attachLoads()
    const steadyBefore = steadyLoads()
    const stop = await start(cold, residency, true)
    try {
      await settle(600)
      expect(log.events('read_model.document_loaded')).toEqual([])
      expect(steadyLoads()).toEqual(steadyBefore)
      // The cold Repo held nothing: root, ModelMeta, the shards and the
      // registry were all read from storage, during the attach.
      const counted = attachLoads() - attachBefore
      expect(counted).toBeGreaterThanOrEqual(5)
      const summary = log.events('read_model.attach_document_loads')
      expect(summary).toHaveLength(1)
      expect(summary[0]).toMatchObject({ workspace: LISTED, loads: counted })
    } finally {
      stop()
      log.restore()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 60_000)

  it('fold ON, a connected peer that synced the heads: TODAY the folded heads stay resident until that peer disconnects', async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    const [serverSide, clientSide] = linkedPair()
    const ws = await workspace(storageRepo([serverSide]))
    const client = new Repo({ network: [clientSide] })
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stop = await start(ws, residency, true)
    try {
      await until(() => ws.repo.peers.length, (n) => n === 1)
      expect(ws.repo.peers).toHaveLength(1)
      // The client opens the head it will write into, as an editor does.
      const synced = async (url: string) => {
        const handle = await client.find(url as AutomergeUrl)
        await handle.whenReady()
        await until(() => residency.hasActivePeers(docId(url)), (v) => v)
      }
      await synced(currentHead(ws))
      const first = await fillAndRotate(ws, 'h0')
      await synced(currentHead(ws))
      const second = await fillAndRotate(ws, 'h1')
      const retired = [first, second]
      for (const id of retired) expect(residency.hasActivePeers(id)).toBe(true)

      const folds = await until(() => log.events('read_model.ordinary_chain_folded'), (lines) => lines.length >= 1, 60_000)
      const sources = new Set(folds.flatMap((line) => line.sources as string[]))
      for (const id of retired) expect(sources.has(id)).toBe(true)
      const detached = await until(() => log.events('read_model.ordinary_fold_source_detached'), (lines) => lines.length >= retired.length, 60_000)
      expect(new Set(detached.map((line) => docId(String(line.url))))).toEqual(new Set(retired))
      // Long enough for the arrival poll's own load-and-release to pass.
      await settle(1_500)
      await residency.drain()
      // TODAY: the fold gave the lease back, the eviction it started was
      // refused for the bound peer, and nothing retries it.
      for (const id of retired) expect(resident(ws.repo, id)).toBe(true)
      expect((await residency.snapshot()).evictionSkippedActivePeer).toBeGreaterThanOrEqual(retired.length)
      for (const id of retired) expect(await residency.evict(id)).toBe(false)

      // The peer goes away: the same eviction now succeeds. What reclaims the
      // head in production is the idle sweep that next considers it.
      clientSide.disconnect()
      await until(() => ws.repo.peers.length, (n) => n === 0)
      for (const id of retired) {
        expect(residency.hasActivePeers(id)).toBe(false)
        expect(await residency.evict(id)).toBe(true)
        expect(resident(ws.repo, id)).toBe(false)
      }
    } finally {
      stop()
      log.restore()
      clientSide.disconnect()
      client.shutdown?.()
      delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    }
  }, 180_000)
})
