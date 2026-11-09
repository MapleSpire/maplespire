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
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { ensureReadModelSchema } from './schema.js'
import { getWorkspaceProjectionFreshness } from './health.js'
import { startReadModelProjector } from './projectorService.js'
import type { OrdinaryHeadRotationConfig } from './ordinaryHeadRotation.js'
import { overlayRotationLockKey } from './overlayRotationLock.js'
import { runWorkspaceCompaction } from './workspaceCompaction.js'
import { ordinaryHeadLateWritesPending } from './ordinaryHeadForwarding.js'
import {
  projectionInboundEdges,
  projectionLockOrderViolations,
  unknownAdvisoryKeys,
  type LockEdgeCall,
} from './lockEdgeScan.js'
import { gcOrphanedDocs } from '../gc.js'
import { serverCreationPlacementFor } from '../rbac/serverCreationPlacement.js'
import type { WorkspaceKey } from './projector.js'
import { ordinaryRotationTelemetry } from './ordinaryRotationTelemetry.js'

/**
 * Phase 3 of ordinary writer-head rotation, END TO END: a Repo over the real
 * PostgreSQL storage adapter (so "durable" means a row in `automerge_storage`,
 * and a second Repo over the same tables is a real cold restart), the real
 * ordinary projector with `AM_ORDINARY_HEAD_ROTATION=on`, a real schema.
 *
 * Nothing here plays the rotator by hand: every rotation is the projector's
 * own, triggered by a head crossing its threshold, and every test carries a
 * witness that it ran — the meta repointed, the rotator's log line, the row
 * (D33). The steps between the rotator's awaits are pinned with fakes in
 * `ordinaryHeadRotator.test.ts`.
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-ohr', versionId: 'v1' }
const LISTED = `${WS.landscapeId}/${WS.versionId}`
/** A timer can fire a millisecond or so early against `Date.now()` deltas
 * under load (QA saw 1 498 and 1 499 against a 1 500 bound): the bound is
 * on the deferral, not on the clock's rounding. */
const TIMER_SLACK_MS = 20

let db: IsolatedSchemaDb

type Entity = { id: string; [field: string]: unknown }
type ObjHead = { objects: Record<string, Entity>; writeBatchIds: string[]; forwardedBatchIds?: string[] }
type Meta = {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrl: string
  editsObjectShardUrls: string[]
  editsConnectionShardUrl: string
  editsConnectionShardUrls: string[]
  groups: Record<string, unknown>
}

const X0 = { id: 'x', name: 'X', type: 'system', f: 'f0', g: 'g0' }

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))

/** A Repo over the real storage adapter; `saved` records every chunk write
 * AFTER it completed, so "durable at instant t" is a synchronous lookup. */
function storageRepo(onSaved?: (documentId: string) => void, saveDebounceRate = 60_000) {
  const adapter = new PostgresStorageAdapter({ db: db.pool })
  const saved = new Set<string>()
  const save = adapter.save.bind(adapter)
  adapter.save = async (key, data) => {
    await save(key, data)
    saved.add(key[0])
    onSaved?.(key[0])
  }
  const repo = new Repo({ storage: adapter, network: [], saveDebounceRate })
  return { repo, saved }
}

interface Workspace {
  repo: Repo
  rootUrl: string
  meta: DocHandle<Meta>
  head: DocHandle<ObjHead>
  base: DocHandle<{ objects: Record<string, Entity> }>
  documentIds: string[]
}

async function workspace(repo: Repo): Promise<Workspace> {
  const base = repo.create<{ objects: Record<string, Entity> }>({ objects: { b: { id: 'b', name: 'B', type: 'system' } } })
  const head = repo.create<ObjHead>({ objects: { x: { ...X0 } }, writeBatchIds: [] })
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
  const registry = repo.create({ diagrams: {} })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
  const handles = [base, head, connHead, meta, registry, root]
  await Promise.all(handles.map((h) => h.whenReady()))
  await repo.flush()
  const documentIds = handles.map((h) => String(h.documentId))
  for (const documentId of documentIds) {
    await db.pool.query(
      'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [documentId, WS.landscapeId, WS.versionId],
    )
  }
  return { repo, rootUrl: root.url, meta, head, base, documentIds }
}

/** The docScope claim, observed: the order it happened in, and the
 * admission row a real claim writes. */
const claims: string[] = []
let restoreRegistration: () => void = () => {}

function on(maxChanges: number, overrides: Partial<OrdinaryHeadRotationConfig> = {}): OrdinaryHeadRotationConfig {
  return { mode: 'on', allowlist: new Set([LISTED]), maxActors: 1_000_000, maxChanges, ...overrides }
}

async function start(ws: Workspace, config: OrdinaryHeadRotationConfig, opts: {
  stillOwned?: () => boolean
  onAttached?: (id: string) => void
  pool?: IsolatedSchemaDb['pool']
} = {}) {
  return startReadModelProjector(
    ws.repo, ws.rootUrl, opts.pool ?? db.pool, WS, undefined, 0, undefined,
    opts.stillOwned, undefined, opts.onAttached, config,
  )
}

/** Structured log lines by event name, every console channel. */
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
    lines,
    events: (event: string) => lines.filter((line) => line.event === event),
    restore: () => { for (const spy of spies) spy.mockRestore() },
  }
}

/** Add changes to the head until `A.stats` reports `target` of them. */
function changeHeadTo(head: DocHandle<ObjHead>, target: number) {
  let index = 0
  while (A.stats(head.doc() as A.Doc<unknown>).numChanges < target) {
    head.change((d) => { d.objects[`n${index}`] = { id: `n${index}`, name: `N${index}`, type: 'system' } })
    index += 1
  }
  expect(A.stats(head.doc() as A.Doc<unknown>).numChanges).toBe(target)
}

const roObject = async (id: string) => (await db.pool.query<{ data: Record<string, unknown> }>(
  'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
  [WS.landscapeId, WS.versionId, id],
)).rows[0]?.data
const roObjectRows = async () => (await db.pool.query<{ id: string; data: unknown }>(
  'SELECT id, data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id',
  [WS.landscapeId, WS.versionId],
)).rows
const retirementRows = async () => (await db.pool.query<{
  document_id: string; retirement_heads: string[] | null; forwarded_heads: string[] | null; status: string
}>(
  `SELECT document_id, retirement_heads, forwarded_heads, status FROM read_model_ordinary_head_retirements
   WHERE landscape_id = $1 AND version_id = $2 ORDER BY created_at`,
  [WS.landscapeId, WS.versionId],
)).rows
const degradedSince = async () => (await db.pool.query<{ degraded_since: unknown }>(
  'SELECT degraded_since FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
  [WS.landscapeId, WS.versionId],
)).rows[0]?.degraded_since ?? null
const currentHead = (ws: Workspace) => ws.meta.doc().editsObjectShardUrl
const docId = (url: string) => url.replace(/^automerge:/, '')

/** The suite's pool with `hook` run before EVERY statement — the pool's own
 * and those of the clients it hands out. The hook may wait or throw. */
function hookPool(hook: (sql: string) => Promise<void> | void): IsolatedSchemaDb['pool'] {
  const wrap = (subject: { query: (...args: unknown[]) => unknown }) => async (sql: unknown, values?: unknown[]) => {
    if (typeof sql === 'string') await hook(sql)
    return subject.query(sql, values)
  }
  return new Proxy(db.pool, {
    get(target, property) {
      if (property === 'query') return wrap(target as never)
      if (property === 'connect') {
        return async () => {
          const client = await target.connect()
          return new Proxy(client, {
            get(subject, name) {
              if (name === 'query') return wrap(subject as never)
              const value = Reflect.get(subject, name, subject)
              return typeof value === 'function' ? value.bind(subject) : value
            },
          })
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** A client that was offline across the rotation. */
function offlineClient<T>(handle: DocHandle<T>) {
  let fork = A.clone(handle.doc() as A.Doc<T>)
  return {
    edit(write: (doc: T) => void) { fork = A.change(fork, write) },
    reconnect() { handle.update((doc) => A.merge(doc, fork)) },
  }
}

suite('ordinary head rotation (phase 3) — real storage, real projector, real PostgreSQL', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'ordinary_head_rotator')
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
  // A pass still in flight when a test stops its projector must not meet an
  // ended pool.
  afterAll(async () => { await settle(500); await db?.teardown() })
  beforeEach(async () => {
    // Retried on 40P01: a pass of the previous test's (stopped) projector can
    // still be committing, and TRUNCATE's ACCESS EXCLUSIVE over eleven tables
    // then deadlocks with it — measured twice in about twenty runs of this file
    // alongside the promotion suite, both times in this statement (40P01),
    // never in a test body.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.pool.query(`TRUNCATE automerge_storage, automerge_document_workspace, ro_objects, ro_connections, ro_groups,
          read_model_projection_state, read_model_change_events, read_model_overlay_batch_acks,
          read_model_overlay_entity_bases, read_model_ordinary_head_retirements, read_model_document_watermarks`)
        break
      } catch (error) {
        if ((error as { code?: string }).code !== '40P01' || attempt >= 5) throw error
        await settle(200)
      }
    }
    claims.length = 0
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async ({ landscapeId, versionId, documentIds }) => {
      for (const documentId of documentIds) {
        claims.push(documentId)
        await db.pool.query(
          'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [documentId, landscapeId, versionId],
        )
      }
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
  })
  afterEach(() => { restoreRegistration() })

  it('rotates exactly at the threshold — not one change before — and the child is DURABLE and CLAIMED the instant ModelMeta names it', async () => {
    const { repo, saved } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const base = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges
    const threshold = base + 4
    // What was true at the instant the pointer moved, read synchronously
    // inside the change event that moved it.
    const atRepoint: Array<{ child: string; durable: boolean; claimed: boolean }> = []
    ws.meta.on('change', ({ doc }) => {
      const url = (doc as Meta).editsObjectShardUrl
      if (url && url !== ws.head.url && !atRepoint.some((entry) => entry.child === docId(url))) {
        atRepoint.push({ child: docId(url), durable: saved.has(docId(url)), claimed: claims.includes(docId(url)) })
      }
    })
    const stop = await start(ws, on(threshold))
    try {
      // threshold - 1: due is `>=`, so this must NOT rotate.
      changeHeadTo(ws.head, threshold - 1)
      await until(() => roObject(`n${threshold - 2 - base}`), (row) => row !== undefined)
      await settle(600)
      expect(currentHead(ws)).toBe(ws.head.url)
      expect(await retirementRows()).toEqual([])
      expect(log.events('read_model.ordinary_head_rotated')).toEqual([])

      changeHeadTo(ws.head, threshold)
      const child = await until(() => currentHead(ws), (url) => url !== ws.head.url)
      // Witnesses that the rotation ran, and ran once.
      expect(child).not.toBe(ws.head.url)
      // The log line follows the ModelMeta flush.
      await until(() => log.events('read_model.ordinary_head_rotated'), (lines) => lines.length > 0)
      await settle(300)
      expect(log.events('read_model.ordinary_head_rotated')).toHaveLength(1)
      expect(atRepoint).toEqual([{ child: docId(child), durable: true, claimed: true }])

      const meta = ws.meta.doc()
      expect(meta.editsObjectShardUrls).toEqual([ws.head.url, child])
      expect(meta.objectShardUrls).toEqual([ws.base.url, ws.head.url, child])
      // The row, with H_r: heads of the retired head it holds, and only ones
      // the projector had published (the change that crossed is in it only if
      // its pass published before the rotator read).
      const rows = await retirementRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ document_id: String(ws.head.documentId), status: 'retired', forwarded_heads: null })
      expect(A.hasHeads(ws.head.doc() as A.Doc<unknown>, rows[0].retirement_heads!)).toBe(true)

      // Retired heads stay reachable for GC: report-only, every stored
      // document old enough to sweep, nothing of the workspace proposed.
      await repo.flush()
      const stored = [...ws.documentIds, docId(child)]
      const report = await gcOrphanedDocs(repo, {
        db: { query: async (sql: string) => {
          if (sql.includes('FROM versions')) return { rows: [{ root_url: ws.rootUrl }] }
          if (sql.includes("'.read_model_static_workspaces'")) return { rows: [{ present: false }] }
          if (sql.includes('FROM automerge_storage')) {
            return { rows: [...stored, 'unreferenced-orphan'].map((doc) => ({ doc, updated_at: new Date(0) })) }
          }
          return { rows: [] }
        } } as never,
        minimumAgeMs: 0, reportOnly: true, includeCandidateDocumentIds: true, now: new Date(),
      })
      expect(report.aborted).toBe(false)
      expect(report.candidateDocumentIds).toEqual(['unreferenced-orphan'])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('OFFLINE EDIT SURVIVES a real rotation: A offline sets x.f on the old head, B sets x.g on the new one — both in ro_*, in the documents, and after a cold restart; and the retired head\'s watermark is certified only once ro_* holds the edit', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    // Records, inside the transaction that certifies the retired head, whether
    // that transaction's own rows already carry A's edit.
    await db.pool.query('CREATE TABLE IF NOT EXISTS wm_log (watermark BIGINT, has_edit BOOLEAN)')
    await db.pool.query('TRUNCATE wm_log')
    await db.pool.query(`CREATE OR REPLACE FUNCTION wm_witness() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.document_id = '${String(ws.head.documentId)}' AND NEW.projected_watermark > 0 THEN
          INSERT INTO wm_log SELECT NEW.projected_watermark, EXISTS (
            SELECT 1 FROM ro_objects WHERE id = 'x' AND data->>'f' = 'fA');
        END IF;
        RETURN NEW;
      END $$`)
    await db.pool.query('DROP TRIGGER IF EXISTS wm_witness ON read_model_document_watermarks')
    await db.pool.query(`CREATE TRIGGER wm_witness AFTER INSERT OR UPDATE ON read_model_document_watermarks
      FOR EACH ROW EXECUTE FUNCTION wm_witness()`)
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 2
    // Holds the TARGET's first projection after the late write before it
    // reaches its transaction, so the forward commits while ro_* still lacks
    // the edit: a certificate written at that commit would say so.
    let holdNextPrepare = false
    let releaseHold!: () => void
    const hold = new Promise<void>((resolve) => { releaseHold = resolve })
    const hooked = hookPool(async (sql) => {
      if (holdNextPrepare && sql.includes("nextval('automerge_arrival_seq')")) {
        holdNextPrepare = false
        await hold
      }
    })
    let stop = await start(ws, on(threshold), { pool: hooked })
    const repos: Repo[] = [repo]
    try {
      const a = offlineClient(ws.head)
      changeHeadTo(ws.head, threshold)
      const childUrl = await until(() => currentHead(ws), (url) => url !== ws.head.url)
      expect(childUrl).not.toBe(ws.head.url)
      const child = await repo.find<ObjHead>(childUrl as never)
      // B is online: its first write of x into the new head is the whole
      // entity as it sees it — the shape `bridge.ts` writes for an absent id.
      child.change((d) => {
        d.objects.x = { ...X0, g: 'gB' }
        d.writeBatchIds.push('b1')
      })
      await until(() => roObject('x'), (x) => x?.g === 'gB')
      await db.pool.query('TRUNCATE wm_log')
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      holdNextPrepare = true
      a.reconnect()
      // The forward commits while the target's projection is held…
      await until(async () => (await db.pool.query<{ forwarded_heads: string[] | null }>(
        'SELECT forwarded_heads FROM read_model_ordinary_head_retirements WHERE document_id = $1',
        [String(ws.head.documentId)])).rows[0]?.forwarded_heads, (heads) => Boolean(heads))
      await settle(400)
      expect(holdNextPrepare, 'the hold must have caught a projection').toBe(false)
      expect((await roObject('x'))?.f, 'premise: ro_* lacks the edit while the hold is on').not.toBe('fA')
      releaseHold()

      expect(await until(() => roObject('x'), (x) => x?.f === 'fA' && x?.g === 'gB')).toMatchObject({ f: 'fA', g: 'gB' })
      expect(child.doc().objects.x).toMatchObject({ f: 'fA', g: 'gB' })
      expect(log.events('read_model.ordinary_head_forwarded').length).toBeGreaterThan(0)

      // THE WATERMARK. Certified (absence provable again without a cold
      // build) — and never before ro_* carried the edit.
      const freshness = await until(() => getWorkspaceProjectionFreshness(db.pool, WS), (f) => f.absenceProvable)
      expect(freshness.absenceProvable).toBe(true)
      const witnessed = (await db.pool.query<{ has_edit: boolean }>('SELECT has_edit FROM wm_log')).rows
      expect(witnessed.length).toBeGreaterThan(0)
      expect(witnessed.every((row) => row.has_edit)).toBe(true)

      // COLD RESTART: a second process over the same storage.
      await settle()
      const afterDeltas = await roObjectRows()
      await repo.flush()
      stop()
      const { repo: repo2 } = storageRepo()
      repos.push(repo2)
      await db.pool.query('TRUNCATE ro_objects')
      stop = await start({ ...ws, repo: repo2 }, on(threshold))
      await settle(800)
      expect(await roObjectRows()).toEqual(afterDeltas)
      expect(await roObject('x')).toMatchObject({ f: 'fA', g: 'gB' })
    } finally {
      releaseHold()
      stop()
      log.restore()
      await db.pool.query('DROP TRIGGER IF EXISTS wm_witness ON read_model_document_watermarks')
      for (const r of repos) await r.shutdown()
    }
  })

  it('H_r is what was PUBLISHED, not the live head: a change sampled by no direct pass before the repoint is forwarded, not lost', async () => {
    // The phase-1 review's point, driven: the live document (and `A.stats`) is
    // ahead of what the projector published. Arranged deterministically:
    //  - the crossing change publishes and asks for the rotation;
    //  - while the child is being claimed, c1 lands on the head and its direct
    //    pass is held INSIDE its transaction until ModelMeta is repointed;
    //  - c2 lands while c1's pass is held — after c1's sample — so only a pass
    //    that runs AFTER the repoint can carry it, and that pass forwards from
    //    H_r. An H_r taken from the live head would already contain c2, and
    //    c2 would reach no projection at all until a cold build.
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let repointed!: () => void
    const repoint = new Promise<void>((resolve) => { repointed = resolve })
    ws.meta.on('change', ({ doc }) => { if ((doc as Meta).editsObjectShardUrl !== ws.head.url) repointed() })
    let holdArmed = false
    let held!: () => void
    const heldInside = new Promise<void>((resolve) => { held = resolve })
    const hooked = new Proxy(db.pool, {
      get(target, property) {
        if (property === 'connect') {
          return async () => {
            const client = await target.connect()
            return new Proxy(client, {
              get(subject, name) {
                if (name === 'query') {
                  return async (sql: unknown, values?: unknown[]) => {
                    if (holdArmed && typeof sql === 'string' && sql.includes('INSERT INTO ro_objects')) {
                      holdArmed = false
                      held()
                      await repoint
                    }
                    return (subject.query as (s: unknown, v?: unknown[]) => Promise<unknown>).call(subject, sql, values)
                  }
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
    })
    restoreRegistration()
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async ({ documentIds }) => {
      claims.push(...documentIds)
      holdArmed = true
      ws.head.change((d) => { d.objects.x.f = 'c1' })
      await heldInside
      ws.head.change((d) => { d.objects.x.g = 'c2' })
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
    // Far enough above the child's own few changes that the child is not
    // rotated in turn before it is read.
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 5
    const stop = await start(ws, on(threshold), { pool: hooked as unknown as IsolatedSchemaDb['pool'] })
    try {
      changeHeadTo(ws.head, threshold)
      await until(() => currentHead(ws), (url) => url !== ws.head.url)
      expect(currentHead(ws)).not.toBe(ws.head.url)
      // Witness that the arrangement happened: both changes are in the head.
      expect(ws.head.doc().objects.x).toMatchObject({ f: 'c1', g: 'c2' })
      const [row] = await retirementRows()
      expect(A.hasHeads(ws.head.doc() as A.Doc<unknown>, row.retirement_heads!)).toBe(true)
      expect(row.retirement_heads).not.toEqual([...A.getHeads(ws.head.doc() as A.Doc<unknown>)].sort())
      // c2 reaches ro_* — through the forward into the new head.
      expect(await until(() => roObject('x'), (x) => x?.g === 'c2', 10_000)).toMatchObject({ f: 'c1', g: 'c2' })
      const child = await repo.find<ObjHead>(currentHead(ws) as never)
      expect(child.doc().objects.x).toMatchObject({ g: 'c2' })
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a change published DIRECTLY after H_r was read and before the repoint is still carried into the new head', async () => {
    // Between the rotator's read of H_r and its repoint the head is still
    // current, so a write there is projected directly — and is after H_r.
    // Unless a forward runs, the new head never learns it, and the first
    // write of that entity into the new head (a whole entity, from a view
    // that may predate it) hides it. The rotator asks the retired head to
    // forward as soon as it has repointed; no later write is needed.
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let armed = true
    const hooked = hookPool(async (sql) => {
      if (armed && sql.startsWith('BEGIN; SET LOCAL lock_timeout')) {
        armed = false
        ws.head.change((d) => { d.objects.x.f = 'between' })
        await until(() => roObject('x'), (x) => x?.f === 'between')
      }
    })
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 5
    const stop = await start(ws, on(threshold), { pool: hooked })
    try {
      changeHeadTo(ws.head, threshold)
      const childUrl = await until(() => currentHead(ws), (url) => url !== ws.head.url)
      expect(childUrl).not.toBe(ws.head.url)
      expect(armed, 'the hold must have run').toBe(false)
      // Witness of the forward the rotation asked for.
      await until(async () => (await retirementRows())[0]?.forwarded_heads, (heads) => Boolean(heads))
      const child = await repo.find<ObjHead>(childUrl as never)
      // B writes as the bridge does: field by field into a head that holds
      // the entity, whole (from its own, older view) into one that does not.
      child.change((d) => {
        if (d.objects.x) d.objects.x.g = 'gB'
        else d.objects.x = { ...X0, g: 'gB' }
      })
      expect(await until(() => roObject('x'), (x) => x?.g === 'gB')).toMatchObject({ f: 'between', g: 'gB' })
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a head already past its threshold when the projector attaches is rotated with no new write', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 2
    changeHeadTo(ws.head, threshold + 1)
    await repo.flush()
    const stop = await start(ws, on(threshold))
    try {
      const child = await until(() => currentHead(ws), (url) => url !== ws.head.url)
      expect(child).not.toBe(ws.head.url)
      expect(await retirementRows()).toHaveLength(1)
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a target projection that FAILS after taking a retired head\'s certificate gives it back to the next one', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let failRows = false
    const hooked = hookPool((sql) => {
      if (failRows && sql.includes('INSERT INTO ro_objects')) throw new Error('injected ro_objects failure')
    })
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 5
    const stop = await start(ws, on(threshold), { pool: hooked })
    try {
      const a = offlineClient(ws.head)
      changeHeadTo(ws.head, threshold)
      const childUrl = await until(() => currentHead(ws), (url) => url !== ws.head.url)
      const child = await repo.find<ObjHead>(childUrl as never)
      child.change((d) => { d.objects.x = { ...X0, g: 'gB' } })
      await until(() => roObject('x'), (x) => x?.g === 'gB')
      failRows = true
      a.edit((d) => { d.objects.x.f = 'fA' })
      a.reconnect()
      await until(async () => (await retirementRows())[0]?.forwarded_heads,
        (heads) => JSON.stringify(heads) === JSON.stringify([...A.getHeads(ws.head.doc() as A.Doc<unknown>)].sort()))
      await settle(600)
      // Premise: every projection of the target since the forward failed.
      expect((await roObject('x'))?.f).not.toBe('fA')
      failRows = false
      child.change((d) => { d.objects.x.h = 'later' })
      expect(await until(() => roObject('x'), (x) => x?.h === 'later')).toMatchObject({ f: 'fA', h: 'later' })
      expect((await until(() => getWorkspaceProjectionFreshness(db.pool, WS), (f) => f.absenceProvable)).absenceProvable)
        .toBe(true)
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a lease lost while the child is flushed: no row, no repoint — and the head goes on being projected directly', async () => {
    let owned = true
    // The first save of a document the fixture did not create is the child's
    // flush: the lease moves under it.
    let known: Set<string> | null = null
    const { repo } = storageRepo((documentId) => { if (known && !known.has(documentId)) owned = false })
    const ws = await workspace(repo)
    known = new Set(ws.documentIds)
    const log = logLines()
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    const stop = await start(ws, on(threshold), { stillOwned: () => owned })
    try {
      changeHeadTo(ws.head, threshold)
      // Witness that the rotation got as far as the child: an unknown
      // document reached storage and flipped the lease.
      await until(() => owned, (value) => value === false)
      expect(owned).toBe(false)
      await settle(600)
      expect(currentHead(ws)).toBe(ws.head.url)
      expect(await retirementRows()).toEqual([])
      expect(log.events('read_model.ordinary_head_rotated')).toEqual([])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('the rotation lock held by another session is a REFUSAL, retried until it is free', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const holder = await db.pool.connect()
    const lockKey = overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object')
    await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey])
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    // G4-16e: a refused rotation is not a rotation in the stats either.
    ordinaryRotationTelemetry.resetForTest()
    const counted = () => ordinaryRotationTelemetry.snapshot(on(threshold)).entries
      .find((entry) => entry.workspace === LISTED && entry.collection === 'object')
    const stop = await start(ws, on(threshold))
    try {
      changeHeadTo(ws.head, threshold)
      const contended = await until(() => log.events('read_model.overlay_rotation_lock_contended'), (lines) => lines.length > 0)
      expect(contended[0]).toMatchObject({ path: 'rotate', kind: 'object', state: 'refused' })
      expect(currentHead(ws)).toBe(ws.head.url)
      expect(await retirementRows()).toEqual([])
      expect(counted()).toMatchObject({ rotations: 0, lastRotatedAt: null })
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
      // No further write: the retry alone rotates.
      const child = await until(() => currentHead(ws), (url) => url !== ws.head.url, 10_000)
      expect(child).not.toBe(ws.head.url)
      expect(await retirementRows()).toHaveLength(1)
      // Exactly one: the refusal added nothing, the retry added one.
      expect(await until(() => counted()?.rotations, (n) => n === 1)).toBe(1)
      await settle(300)
      expect(counted()).toMatchObject({ rotations: 1, rotationsByTrigger: { changes: 1, unknown: 0 } })
      expect(counted()?.lastRotatedAt).not.toBeNull()
    } finally {
      ordinaryRotationTelemetry.resetForTest()
      holder.release()
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a row left naming the CURRENT head (a crash between the row and the repoint) is harmless, and the next rotation recovers it', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const staleHeads = A.getHeads(ws.head.doc() as A.Doc<unknown>)
    await db.pool.query(
      `INSERT INTO read_model_ordinary_head_retirements
         (landscape_id, version_id, collection, document_id, retirement_heads, forwarded_heads, status)
       VALUES ($1, $2, 'object', $3, $4::text[], $4::text[], 'retired')`,
      [WS.landscapeId, WS.versionId, String(ws.head.documentId), staleHeads],
    )
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 3
    const stop = await start(ws, on(threshold))
    try {
      // Harmless: the head is current, so it is projected directly.
      ws.head.change((d) => { d.objects.x.name = 'X-direct' })
      expect(await until(() => roObject('x'), (x) => x?.name === 'X-direct')).toMatchObject({ name: 'X-direct' })
      expect(log.events('read_model.ordinary_head_forwarded')).toEqual([])
      // …and compaction's pending check does not count it: it is the CURRENT
      // head. The same head, NOT current, with heads past its row, would be.
      const live = A.getHeads(ws.head.doc() as A.Doc<unknown>)
      const segment = { documentId: String(ws.head.documentId), heads: live }
      expect(await ordinaryHeadLateWritesPending(db.pool, WS, 'object', [{ ...segment, current: true }])).toEqual([])
      expect(await ordinaryHeadLateWritesPending(db.pool, WS, 'object', [{ ...segment, current: false }]))
        .toEqual([String(ws.head.documentId)])
      // Recovered: crossing the threshold rotates, overwriting H_r and
      // restarting forwarding from it.
      changeHeadTo(ws.head, threshold)
      await until(() => currentHead(ws), (url) => url !== ws.head.url)
      expect(currentHead(ws)).not.toBe(ws.head.url)
      const [row] = await retirementRows()
      expect(row.retirement_heads).not.toEqual([...staleHeads].sort())
      expect(A.hasHeads(ws.head.doc() as A.Doc<unknown>, row.retirement_heads!)).toBe(true)
      // `forwarded_heads` was reset by the rotation (the stale row had it AT
      // the stale heads, which would have re-forwarded nothing after them)...
      expect(row.forwarded_heads).toBeNull()
      // ...and a late write on the retired head is forwarded from the NEW H_r.
      ws.head.change((d) => { d.objects.x.late = 'L' })
      const forwarded = await until(async () => (await retirementRows())[0].forwarded_heads,
        (heads) => JSON.stringify(heads) === JSON.stringify([...A.getHeads(ws.head.doc() as A.Doc<unknown>)].sort()))
      expect(forwarded).toEqual([...A.getHeads(ws.head.doc() as A.Doc<unknown>)].sort())
      expect(await until(() => roObject('x'), (x) => x?.late === 'L')).toMatchObject({ late: 'L', name: 'X-direct' })
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('shadow, on the same crossing, writes nothing: no row, no child, no repoint', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    const stop = await start(ws, on(threshold, { mode: 'shadow' }))
    try {
      changeHeadTo(ws.head, threshold)
      // Witness that the crossing was seen.
      await until(() => log.events('read_model.ordinary_head_rotation_due'), (lines) => lines.length > 0)
      expect(log.events('read_model.ordinary_head_rotation_due')[0]).toMatchObject({ mode: 'shadow' })
      await settle(600)
      expect(currentHead(ws)).toBe(ws.head.url)
      expect(await retirementRows()).toEqual([])
      expect(claims).toEqual([])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a FAILED forward is retried without any new write, and degrades the workspace until it lands', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let failures = 1
    const hooked = new Proxy(db.pool, {
      get(target, property) {
        if (property === 'connect') {
          return async () => {
            const client = await target.connect()
            return new Proxy(client, {
              get(subject, name) {
                if (name === 'query') {
                  return (sql: unknown, values?: unknown[]) => {
                    if (failures > 0 && typeof sql === 'string' && sql.includes('SET forwarded_heads')) {
                      failures -= 1
                      return Promise.reject(new Error('injected forward commit failure'))
                    }
                    return (subject.query as (s: unknown, v?: unknown[]) => Promise<unknown>).call(subject, sql, values)
                  }
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
    })
    // Far enough above the child's own few changes that the child is not
    // rotated in turn before it is read.
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 5
    const stop = await start(ws, on(threshold), { pool: hooked as unknown as IsolatedSchemaDb['pool'] })
    try {
      const a = offlineClient(ws.head)
      changeHeadTo(ws.head, threshold)
      await until(() => currentHead(ws), (url) => url !== ws.head.url)
      // The forward the rotation asks for may already have consumed the
      // injected failure; arm it again for the late write's own forward.
      await until(async () => (await retirementRows())[0]?.forwarded_heads, (heads) => Boolean(heads))
      failures = 1
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      // Visible: the workspace is degraded by the failed forward.
      const degraded = await until(async () => (await db.pool.query<{ degraded_since: unknown }>(
        'SELECT degraded_since FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId])).rows[0]?.degraded_since, (value) => Boolean(value))
      expect(degraded).toBeTruthy()
      expect(failures).toBe(0)
      // Retried with no further write on the retired head, and the edit lands.
      expect(await until(() => roObject('x'), (x) => x?.f === 'fA', 10_000)).toMatchObject({ f: 'fA' })
      const forwarded = await until(async () => (await retirementRows())[0].forwarded_heads,
        (heads) => JSON.stringify(heads) === JSON.stringify([...A.getHeads(ws.head.doc() as A.Doc<unknown>)].sort()))
      expect(forwarded).toEqual([...A.getHeads(ws.head.doc() as A.Doc<unknown>)].sort())
      // ...and the degradation is lifted.
      expect(await until(async () => (await db.pool.query<{ degraded_since: unknown }>(
        'SELECT degraded_since FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId])).rows[0]?.degraded_since, (value) => value === null)).toBeNull()
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('LOCK ORDER: the rotator never asks for the projection mutex while it holds overlay-rotation (gates A8 and G5, on the real statement stream)', async () => {
    // Phase-3 review (architect): the ordinary rotator is a NEW session-lock
    // holder of the `overlay-rotation:` key, uncovered by the detectors that
    // pin the static plane's holders (`lockEdgeScan.ts`). Fed here with what
    // a real rotation issues.
    //
    // A8 is about a PATH (the cycle can close through a pool slot, invisible
    // to Postgres), so its input is every statement issued while
    // `rotateOrdinaryHead` is on the (async) stack, whatever client carries
    // it. G5 is about a TRANSACTION, so its input is per connection.
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    type Call = { connection: number; sql: string; params: readonly unknown[]; rotator: boolean }
    const calls: Call[] = []
    let connections = 0
    const record = (connection: number, sql: unknown, params?: unknown[]) => {
      if (typeof sql !== 'string') return
      const limit = Error.stackTraceLimit
      Error.stackTraceLimit = 200
      const stack = new Error().stack ?? ''
      Error.stackTraceLimit = limit
      calls.push({ connection, sql, params: params ?? [], rotator: stack.includes('rotateOrdinaryHead') })
    }
    const recorded = new Proxy(db.pool, {
      get(target, property) {
        if (property === 'query') {
          return (sql: unknown, values?: unknown[]) => {
            record(0, sql, values)
            return (target.query as (s: unknown, v?: unknown[]) => Promise<unknown>).call(target, sql, values)
          }
        }
        if (property === 'connect') {
          return async () => {
            const client = await target.connect()
            const connection = ++connections
            return new Proxy(client, {
              get(subject, name) {
                if (name === 'query') {
                  return (sql: unknown, values?: unknown[]) => {
                    record(connection, sql, values)
                    return (subject.query as (s: unknown, v?: unknown[]) => Promise<unknown>).call(subject, sql, values)
                  }
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
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 5
    const stop = await start(ws, on(threshold), { pool: recorded })
    try {
      const a = offlineClient(ws.head)
      changeHeadTo(ws.head, threshold)
      await until(() => currentHead(ws), (url) => url !== ws.head.url)
      // Logged after the ModelMeta flush, i.e. after the repoint: polled.
      expect(await until(() => log.events('read_model.ordinary_head_rotated').length, (n) => n === 1)).toBe(1)
      // A forward too, so the stream holds the projector's own mutex takes.
      a.edit((d) => { d.objects.x.f = 'fA' })
      a.reconnect()
      expect(await until(() => roObject('x'), (x) => x?.f === 'fA')).toMatchObject({ f: 'fA' })
      await settle(300)
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
    const tuple = (call: Call) => [call.sql, call.params] as const
    const rotatorCalls = calls.filter((call) => call.rotator)
    // LIVENESS WITNESSES — the run is void without them. The rotator's stream
    // holds its session lock, its row transaction and its release; the
    // whole stream holds the projection mutex.
    expect(rotatorCalls.some((call) => call.sql.includes('pg_try_advisory_lock(')
      && String(call.params[0]).startsWith('overlay-rotation:'))).toBe(true)
    expect(rotatorCalls.some((call) => call.sql.includes('INSERT INTO read_model_ordinary_head_retirements'))).toBe(true)
    expect(rotatorCalls.some((call) => call.sql.includes('pg_advisory_unlock('))).toBe(true)
    expect(calls.some((call) => call.sql.includes('pg_advisory_xact_lock(')
      && String(call.params[0]).startsWith('read-model-projection:'))).toBe(true)
    // The row transaction runs on the LOCK's client.
    const lockConnection = rotatorCalls.find((call) => call.sql.includes('pg_try_advisory_lock('))!.connection
    expect(rotatorCalls.find((call) => call.sql.includes('INSERT INTO read_model_ordinary_head_retirements'))!.connection)
      .toBe(lockConnection)

    // A8, over the rotator's path.
    expect(projectionLockOrderViolations(rotatorCalls.map(tuple))).toEqual([])
    // G5, per connection: nothing is acquired inside a projection transaction.
    const byConnection = new Map<number, LockEdgeCall[]>()
    for (const call of calls) {
      if (call.connection === 0) continue
      byConnection.set(call.connection, [...(byConnection.get(call.connection) ?? []), { sql: call.sql, params: call.params }])
    }
    for (const stream of byConnection.values()) expect(projectionInboundEdges(stream)).toEqual([])
    expect(unknownAdvisoryKeys(calls.map((call) => ({ sql: call.sql, params: call.params })))).toEqual([])
  }, 30_000)

  it('a transient retirements-LOAD failure on a NON-forwarded shard is retried, and leaves no degradation behind', async () => {
    // Phase-3 review (reviewer, measured): `freshRetirements()` sat inside the
    // try whose catch degraded the shard; for the BASE shard the retry then
    // returned at `!isForwardedHead`, `forwardRecovered` never ran, and
    // `degraded_since` stuck until a restart — flag OFF, after any pointer
    // move (a compaction's included).
    //
    // The pointer moves here to a shard ALREADY listed and watched, so the
    // move attaches nothing: a NEW shard's attach also reads the rows, and an
    // attach that fails is a different, older mechanism (left unwatched and
    // degraded until the next ModelMeta change re-attempts it).
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const spare = repo.create<ObjHead>({ objects: {}, writeBatchIds: [] })
    await spare.whenReady()
    await repo.flush([spare.documentId])
    await db.pool.query(
      'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3)',
      [String(spare.documentId), WS.landscapeId, WS.versionId],
    )
    ws.meta.change((d) => { d.objectShardUrls.push(spare.url); d.editsObjectShardUrls.push(spare.url) })
    await repo.flush([ws.meta.documentId])
    const log = logLines()
    let failLoads = false
    let injected = 0
    const hooked = hookPool((sql) => {
      // The WHOLE-workspace load only (`loadOrdinaryHeadRetirements`), not the
      // forwarder's own per-row read.
      if (failLoads && sql.includes('FROM read_model_ordinary_head_retirements')
        && sql.includes('SELECT collection') && !sql.includes('collection = $3')) {
        injected += 1
        throw new Error('injected retirements load failure')
      }
    })
    const stop = await start(ws, on(1_000_000, { mode: 'off' }), { pool: hooked })
    try {
      // Control: healthy, and the base shard projected.
      expect(await until(degradedSince, (value) => value === null)).toBeNull()
      expect(await until(() => roObject('b'), (b) => b?.name === 'B')).toMatchObject({ name: 'B' })
      failLoads = true
      // The pointer moves (no rotation: the flag is off) ...
      ws.meta.change((d) => { d.editsObjectShardUrl = spare.url })
      // ... and a base-shard edit's pass meets the moved pointer while the
      // load fails.
      ws.base.change((d) => { d.objects.b.name = 'B2' })
      await until(() => injected, (n) => n >= 1, 4000)
      expect(injected).toBeGreaterThanOrEqual(1)
      failLoads = false
      // The retry alone — no further write — publishes the base edit...
      expect(await until(() => roObject('b'), (b) => b?.name === 'B2', 10_000)).toMatchObject({ name: 'B2' })
      // ...and nothing is left degraded.
      expect(await until(degradedSince, (value) => value === null, 6_000)).toBeNull()
      expect(log.events('read_model.ordinary_head_rotated')).toEqual([])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  }, 40_000)

  it('a rotated CHILD whose attach fails transiently is re-attached on a backoff, with no further ModelMeta change', async () => {
    // The attach of a NEW shard also reads the retirement rows
    // (`freshRetirements`). A failed attach used to leave the shard unwatched
    // and degraded until the next ModelMeta change — and after a rotation the
    // new shard is the CURRENT head, so every edit to it stayed out of ro_*.
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let failLoads = false
    let injected = 0
    const hooked = hookPool((sql) => {
      if (failLoads && sql.includes('FROM read_model_ordinary_head_retirements')
        && sql.includes('SELECT collection') && !sql.includes('collection = $3')) {
        injected += 1
        throw new Error('injected retirements load failure')
      }
    })
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 5
    const stop = await start(ws, on(threshold), { pool: hooked })
    try {
      expect(await until(degradedSince, (value) => value === null)).toBeNull() // control
      failLoads = true
      changeHeadTo(ws.head, threshold)
      const childUrl = await until(() => currentHead(ws), (url) => url !== ws.head.url)
      expect(childUrl).not.toBe(ws.head.url)
      // Witness: the child's attach failed — the only path that still
      // degrades on this read.
      expect(await until(degradedSince, (value) => Boolean(value))).toBeTruthy()
      expect(injected).toBeGreaterThan(0)
      failLoads = false
      // An edit to the CURRENT head, and no ModelMeta change after it.
      const metaHeads = A.getHeads(ws.meta.doc() as A.Doc<unknown>)
      const child = await repo.find<ObjHead>(childUrl as never)
      child.change((d) => { d.objects.y = { id: 'y', name: 'Y', type: 'system' } })
      expect(await until(() => roObject('y'), (y) => y !== undefined, 10_000)).toMatchObject({ name: 'Y' })
      expect(A.getHeads(ws.meta.doc() as A.Doc<unknown>)).toEqual(metaHeads)
      expect(await until(degradedSince, (value) => value === null, 6_000)).toBeNull()
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  }, 30_000)

  it('a forward refused as NOT-RETIRED on its retry does not lift the degradation of the forward that failed', async () => {
    // Phase-3 review: `forwardRecovered` ran on every non-throwing outcome, so a
    // retry answering `not-retired` (or `not-owner`) — a forward that never
    // happened — cleared the degradation while the late write stayed unseen.
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let failCommits = 0
    let rowReadsAfterDemotion = 0
    let demoted = false
    const hooked = hookPool((sql) => {
      if (demoted && sql.includes('collection = $3') && sql.includes('FROM read_model_ordinary_head_retirements')) {
        rowReadsAfterDemotion += 1
      }
      if (failCommits > 0 && sql.includes('SET forwarded_heads')) {
        failCommits -= 1
        throw new Error('injected forward commit failure')
      }
    })
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 5
    const stop = await start(ws, on(threshold), { pool: hooked })
    try {
      const a = offlineClient(ws.head)
      changeHeadTo(ws.head, threshold)
      await until(() => currentHead(ws), (url) => url !== ws.head.url)
      const forwardedBefore = await until(async () => (await retirementRows())[0]?.forwarded_heads, (heads) => Boolean(heads))
      expect(await until(degradedSince, (value) => value === null)).toBeNull() // control
      failCommits = 1
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      expect(await until(degradedSince, (value) => Boolean(value))).toBeTruthy()
      // The row stops asking for forwarding before the 1 s retry runs.
      await db.pool.query(
        `UPDATE read_model_ordinary_head_retirements SET status = 'admitted'
          WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
      demoted = true
      // Witness that the retry RAN and read the row (answering not-retired).
      await until(() => rowReadsAfterDemotion, (n) => n > 0, 8_000)
      expect(rowReadsAfterDemotion).toBeGreaterThan(0)
      await settle(600)
      // The forward never COMMITTED (`forwarded_heads` did not move past the
      // late write), so the workspace stays degraded.
      expect((await retirementRows())[0]?.forwarded_heads).toEqual(forwardedBefore)
      expect(await degradedSince()).toBeTruthy()
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  }, 30_000)

  it('a forward that met a PROJECTION-MUTEX timeout is retried and never degrades the workspace', async () => {
    // Phase-3 review (architect): every other path treats a mutex timeout as
    // "another writer holds it, try again" and persists nothing (runTracked,
    // the document paths); a cold build holds the mutex 7-9 s against a 5 s
    // ceiling. The forwarder degraded on it.
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let timeouts = 0
    const hooked = hookPool((sql) => {
      if (timeouts > 0 && sql.includes('SET forwarded_heads')) {
        timeouts -= 1
        throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
      }
    })
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 5
    const stop = await start(ws, on(threshold), { pool: hooked })
    let sampling = true
    const samples: unknown[] = []
    const sampler = (async () => {
      while (sampling) {
        samples.push(await degradedSince())
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
    })()
    try {
      const a = offlineClient(ws.head)
      changeHeadTo(ws.head, threshold)
      await until(() => currentHead(ws), (url) => url !== ws.head.url)
      await until(async () => (await retirementRows())[0]?.forwarded_heads, (heads) => Boolean(heads))
      timeouts = 1
      a.edit((d) => { d.objects.x.f = 'fA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      // Retried with no further write, and the edit lands.
      expect(await until(() => roObject('x'), (x) => x?.f === 'fA', 10_000)).toMatchObject({ f: 'fA' })
      expect(timeouts).toBe(0) // anti-void: the timeout was met
      await settle(300)
      sampling = false
      await sampler
      expect(samples.length).toBeGreaterThan(20)
      expect(samples.filter(Boolean)).toEqual([])
    } finally {
      sampling = false
      await sampler
      stop()
      log.restore()
      await repo.shutdown()
    }
  }, 30_000)

  it('compaction REFUSES while a retired head holds an un-forwarded late write, writes nothing — and folds it once forwarded', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    let instance: string | null = null
    let stop: (() => void) | null = await start(ws, on(threshold), { onAttached: (id) => { instance = id } })
    let lateWriteOnRelease: (() => void) | null = null
    const fleet = {
      isResident: () => stop !== null,
      ensure: async () => {
        if (!stop) stop = await start(ws, on(threshold), { onAttached: (id) => { instance = id } })
        return true
      },
      release: () => {
        stop?.()
        stop = null
        // The late write lands while no projector is attached — after the
        // pass detached it, before the fold reads the segments.
        lateWriteOnRelease?.()
        lateWriteOnRelease = null
      },
      residentProjectorInstanceId: () => instance,
    }
    try {
      const a = offlineClient(ws.head)
      changeHeadTo(ws.head, threshold)
      const childUrl = await until(() => currentHead(ws), (url) => url !== ws.head.url)
      const child = await repo.find<ObjHead>(childUrl as never)
      child.change((d) => { d.objects.x = { ...X0, g: 'gB' } })
      await until(() => roObject('x'), (x) => x?.g === 'gB')
      await until(async () => (await retirementRows())[0]?.forwarded_heads, (heads) => Boolean(heads))
      await settle()
      a.edit((d) => { d.objects.x.f = 'fA' })
      lateWriteOnRelease = () => a.reconnect()
      const headsBefore = {
        base: A.getHeads(ws.base.doc() as A.Doc<unknown>),
        child: A.getHeads(child.doc() as A.Doc<unknown>),
      }
      const deps = {
        repo, rootUrl: ws.rootUrl, db: db.pool, fleet,
        ownership: { owns: () => true }, isShuttingDown: () => false,
        log: () => {}, warn: () => {},
      }
      const refused = await runWorkspaceCompaction(WS, deps)
      expect(refused.result.skippedReason).toBe('retired_head_forward_pending')
      // Witness that the late write was in the snapshot it refused over.
      expect((ws.head.doc().objects.x as Entity).f).toBe('fA')
      expect(A.getHeads(ws.base.doc() as A.Doc<unknown>)).toEqual(headsBefore.base)
      expect(refused.reattach).toBe('reattached')
      // The re-attach forwards it.
      expect(await until(() => roObject('x'), (x) => x?.f === 'fA' && x?.g === 'gB')).toMatchObject({ f: 'fA', g: 'gB' })
      await until(async () => (await retirementRows())[0]?.forwarded_heads,
        (heads) => JSON.stringify(heads) === JSON.stringify([...A.getHeads(ws.head.doc() as A.Doc<unknown>)].sort()))
      await settle()
      // Now it folds, and the fold keeps both edits.
      const folded = await runWorkspaceCompaction(WS, deps)
      expect(folded.result.skippedReason).toBeUndefined()
      expect(folded.result.objectsFolded).toBeGreaterThan(0)
      expect(ws.base.doc().objects.x).toMatchObject({ f: 'fA', g: 'gB' })
      expect(await until(() => roObject('x'), (x) => x?.f === 'fA' && x?.g === 'gB')).toMatchObject({ f: 'fA', g: 'gB' })
      expect(log.events('compaction.refused')).toHaveLength(1)
    } finally {
      stop?.()
      log.restore()
      await repo.shutdown()
    }
  })

  // ─────────────── ported from the phase-3 QA lens (its surviving mutants) ───────────────
  type ConnHead = { connections: Record<string, Entity>; writeBatchIds: string[] }
  const C0 = { id: 'c', fromId: 'b', toId: 'x', label: 'L0' }
  const connHeadOf = async (ws: Workspace) =>
    ws.repo.find<ConnHead>(ws.meta.doc().editsConnectionShardUrl as never)
  function changeConnHeadTo(head: DocHandle<ConnHead>, target: number) {
    let index = 0
    while (A.stats(head.doc() as A.Doc<unknown>).numChanges < target) {
      head.change((d) => { d.connections[`k${index}`] = { id: `k${index}`, fromId: 'b', toId: 'x', label: `K${index}` } })
      index += 1
    }
    expect(A.stats(head.doc() as A.Doc<unknown>).numChanges).toBe(target)
  }
  const roConnection = async (id: string) => (await db.pool.query<{ data: Record<string, unknown> }>(
    'SELECT data FROM ro_connections WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
    [WS.landscapeId, WS.versionId, id],
  )).rows[0]?.data
  const rowsByCollection = async () => (await db.pool.query<{ collection: string; document_id: string }>(
    `SELECT collection, document_id FROM read_model_ordinary_head_retirements
     WHERE landscape_id = $1 AND version_id = $2 ORDER BY created_at`,
    [WS.landscapeId, WS.versionId],
  )).rows

  it('a CONNECTION head crossing its threshold is rotated — the connection pointer moves, the object pointer does not (P21, P22)', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const conn = await connHeadOf(ws)
    const threshold = Math.max(
      A.stats(conn.doc() as A.Doc<unknown>).numChanges, A.stats(ws.head.doc() as A.Doc<unknown>).numChanges) + 3
    const stop = await start(ws, on(threshold))
    try {
      changeConnHeadTo(conn, threshold)
      const child = await until(() => ws.meta.doc().editsConnectionShardUrl, (url) => url !== conn.url)
      expect(child).not.toBe(conn.url)
      const meta = ws.meta.doc()
      expect(meta.editsObjectShardUrl).toBe(ws.head.url)
      expect(meta.editsObjectShardUrls).toEqual([ws.head.url])
      expect(meta.objectShardUrls).toEqual([ws.base.url, ws.head.url])
      expect(meta.editsConnectionShardUrls).toEqual([conn.url, child])
      expect(meta.connectionShardUrls).toEqual([conn.url, child])
      expect(await rowsByCollection()).toEqual([{ collection: 'connection', document_id: String(conn.documentId) }])
      const childDoc = await repo.find<ConnHead>(child as never)
      expect(childDoc.doc().connections).toEqual({})
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a CONNECTION head already past its threshold at attach is rotated with no new write (P23)', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const conn = await connHeadOf(ws)
    const threshold = Math.max(
      A.stats(conn.doc() as A.Doc<unknown>).numChanges, A.stats(ws.head.doc() as A.Doc<unknown>).numChanges) + 2
    changeConnHeadTo(conn, threshold + 1)
    await repo.flush()
    const stop = await start(ws, on(threshold))
    try {
      const child = await until(() => ws.meta.doc().editsConnectionShardUrl, (url) => url !== conn.url)
      expect(child).not.toBe(conn.url)
      expect(await rowsByCollection()).toEqual([{ collection: 'connection', document_id: String(conn.documentId) }])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('an offline CONNECTION edit on the retired head is forwarded, and the retired head\'s watermark is certified (P29)', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const conn = await connHeadOf(ws)
    conn.change((d) => { d.connections.c = { ...C0 } })
    const threshold = Math.max(
      A.stats(conn.doc() as A.Doc<unknown>).numChanges, A.stats(ws.head.doc() as A.Doc<unknown>).numChanges) + 5
    const stop = await start(ws, on(threshold))
    try {
      await until(() => roConnection('c'), (c) => c !== undefined)
      const a = offlineClient(conn)
      changeConnHeadTo(conn, threshold)
      const childUrl = await until(() => ws.meta.doc().editsConnectionShardUrl, (url) => url !== conn.url)
      expect(childUrl).not.toBe(conn.url)
      const child = await repo.find<ConnHead>(childUrl as never)
      child.change((d) => { d.connections.c = { ...C0, label: 'LB' } })
      await until(() => roConnection('c'), (c) => c?.label === 'LB')
      // Premise: every shard certified before the late write.
      expect((await until(() => getWorkspaceProjectionFreshness(db.pool, WS), (f) => f.absenceProvable)).absenceProvable)
        .toBe(true)
      a.edit((d) => { d.connections.c.note = 'nA'; d.writeBatchIds.push('a1') })
      a.reconnect()
      expect(await until(() => roConnection('c'), (c) => c?.note === 'nA' && c?.label === 'LB'))
        .toMatchObject({ note: 'nA', label: 'LB' })
      expect(log.events('read_model.ordinary_head_forwarded').length).toBeGreaterThan(0)
      expect((await until(() => getWorkspaceProjectionFreshness(db.pool, WS), (f) => f.absenceProvable)).absenceProvable)
        .toBe(true)
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a CONNECTION target projection that FAILS after taking a retired head\'s certificate gives it back (P26)', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let failRows = false
    const hooked = hookPool((sql) => {
      if (failRows && sql.includes('INSERT INTO ro_connections')) throw new Error('injected ro_connections failure')
    })
    const conn = await connHeadOf(ws)
    conn.change((d) => { d.connections.c = { ...C0 } })
    const threshold = Math.max(
      A.stats(conn.doc() as A.Doc<unknown>).numChanges, A.stats(ws.head.doc() as A.Doc<unknown>).numChanges) + 5
    const stop = await start(ws, on(threshold), { pool: hooked })
    try {
      await until(() => roConnection('c'), (c) => c !== undefined)
      const a = offlineClient(conn)
      changeConnHeadTo(conn, threshold)
      const childUrl = await until(() => ws.meta.doc().editsConnectionShardUrl, (url) => url !== conn.url)
      const child = await repo.find<ConnHead>(childUrl as never)
      child.change((d) => { d.connections.c = { ...C0, label: 'LB' } })
      await until(() => roConnection('c'), (c) => c?.label === 'LB')
      failRows = true
      a.edit((d) => { d.connections.c.note = 'nA' })
      a.reconnect()
      const retiredRow = async () => (await db.pool.query<{ forwarded_heads: string[] | null }>(
        'SELECT forwarded_heads FROM read_model_ordinary_head_retirements WHERE document_id = $1',
        [String(conn.documentId)])).rows[0]?.forwarded_heads
      await until(retiredRow,
        (heads) => JSON.stringify(heads) === JSON.stringify([...A.getHeads(conn.doc() as A.Doc<unknown>)].sort()))
      await settle(600)
      expect((await roConnection('c'))?.note, 'premise: every target projection since the forward failed').not.toBe('nA')
      failRows = false
      child.change((d) => { d.connections.c.later = 'later' })
      expect(await until(() => roConnection('c'), (c) => c?.later === 'later')).toMatchObject({ note: 'nA', later: 'later' })
      expect((await until(() => getWorkspaceProjectionFreshness(db.pool, WS), (f) => f.absenceProvable)).absenceProvable)
        .toBe(true)
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('the write fence lost before the rotator starts: no child is minted, and the loss is REPORTED (P09, P10)', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let fenceReadsAfterUnlock = 0
    let counting = false
    const hooked = hookPool((sql) => {
      if (counting && sql.includes('SELECT write_fence FROM read_model_projection_state') && !sql.includes('FOR UPDATE')) {
        fenceReadsAfterUnlock += 1
      }
    })
    const holder = await db.pool.connect()
    const lockKey = overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object')
    await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey])
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    let fenceLost = 0
    const stop = await startReadModelProjector(
      ws.repo, ws.rootUrl, hooked, WS, undefined, 0, undefined,
      undefined, () => { fenceLost += 1 }, undefined, on(threshold),
    )
    try {
      changeHeadTo(ws.head, threshold)
      await until(() => log.events('read_model.overlay_rotation_lock_contended'), (lines) => lines.length > 0)
      expect(log.events('read_model.overlay_rotation_lock_contended').length).toBeGreaterThan(0)
      // The fence moves to another projector while the rotation waits for its retry.
      await db.pool.query(
        'UPDATE read_model_projection_state SET write_fence = $3 WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId, 'intruder'])
      counting = true
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
      await until(() => fenceLost, (n) => n > 0, 4_000)
      await settle(300)
      expect(fenceReadsAfterUnlock, 'witness: the retried rotation read the fence').toBeGreaterThan(0)
      expect(claims, 'a projector without the fence minted and claimed a child').toEqual([])
      // The loss is REPORTED (the fleet recycles on it), once.
      expect(fenceLost).toBe(1)
      expect(currentHead(ws)).toBe(ws.head.url)
      expect(await retirementRows()).toEqual([])
    } finally {
      holder.release()
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('the workspace turned STATIC before the rotator starts: no child is minted (P11)', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let planeReadsAfterUnlock = 0
    let counting = false
    const hooked = hookPool((sql) => {
      if (counting && sql.includes('FROM read_model_static_workspaces')) planeReadsAfterUnlock += 1
    })
    const holder = await db.pool.connect()
    const lockKey = overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object')
    await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey])
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    const stop = await start(ws, on(threshold), { pool: hooked })
    try {
      changeHeadTo(ws.head, threshold)
      await until(() => log.events('read_model.overlay_rotation_lock_contended'), (lines) => lines.length > 0)
      expect(log.events('read_model.overlay_rotation_lock_contended').length).toBeGreaterThan(0)
      await db.pool.query(
        `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source) VALUES ($1, $2, 'qa3')`,
        [WS.landscapeId, WS.versionId])
      counting = true
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
      await settle(2_500)
      expect(planeReadsAfterUnlock, 'witness: the retried rotation read the plane').toBeGreaterThan(0)
      expect(claims, 'a projector on the wrong plane minted and claimed a child').toEqual([])
      expect(currentHead(ws)).toBe(ws.head.url)
      expect(await retirementRows()).toEqual([])
    } finally {
      holder.release()
      stop()
      log.restore()
      await db.pool.query('DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId])
      await repo.shutdown()
    }
  })

  it('the write fence lost just before the row transaction: no row, no repoint (P12)', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let fired = false
    const hooked = hookPool(async (sql) => {
      if (!fired && claims.length > 0 && sql.startsWith('BEGIN; SET LOCAL lock_timeout')) {
        fired = true
        await db.pool.query(
          'UPDATE read_model_projection_state SET write_fence = $3 WHERE landscape_id = $1 AND version_id = $2',
          [WS.landscapeId, WS.versionId, 'intruder'])
      }
    })
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    const stop = await start(ws, on(threshold), { pool: hooked })
    try {
      changeHeadTo(ws.head, threshold)
      await until(() => fired, (value) => value)
      expect(fired, 'witness: the rotator reached its row transaction').toBe(true)
      await settle(1_000)
      expect(currentHead(ws)).toBe(ws.head.url)
      expect(await retirementRows()).toEqual([])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('the workspace turned STATIC just before the row transaction: no row, no repoint (P13)', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let fired = false
    const hooked = hookPool(async (sql) => {
      if (!fired && claims.length > 0 && sql.startsWith('BEGIN; SET LOCAL lock_timeout')) {
        fired = true
        await db.pool.query(
          `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source) VALUES ($1, $2, 'qa3')`,
          [WS.landscapeId, WS.versionId])
      }
    })
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    const stop = await start(ws, on(threshold), { pool: hooked })
    try {
      changeHeadTo(ws.head, threshold)
      await until(() => fired, (value) => value)
      expect(fired, 'witness: the rotator reached its row transaction').toBe(true)
      await settle(1_000)
      expect(currentHead(ws)).toBe(ws.head.url)
      expect(await retirementRows()).toEqual([])
    } finally {
      stop()
      log.restore()
      await db.pool.query('DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId])
      await repo.shutdown()
    }
  })

  it('the projector STOPPED while the child is being claimed: no row, no repoint (P14)', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let stopRef: (() => void) | null = null
    let stoppedInClaim = false
    restoreRegistration()
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async ({ landscapeId, versionId, documentIds }) => {
      claims.push(...documentIds)
      for (const documentId of documentIds) {
        await db.pool.query(
          'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [documentId, landscapeId, versionId])
      }
      stopRef?.()
      stoppedInClaim = true
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    const stop = await start(ws, on(threshold))
    stopRef = stop
    try {
      changeHeadTo(ws.head, threshold)
      await until(() => stoppedInClaim, (value) => value)
      expect(stoppedInClaim, 'witness: the rotation reached the claim').toBe(true)
      await settle(1_000)
      expect(currentHead(ws)).toBe(ws.head.url)
      expect(await retirementRows()).toEqual([])
      expect(log.events('read_model.ordinary_head_rotated')).toEqual([])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('the rotated child carries the OWNER placement note at its claim (P16)', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const atClaim: Array<{ id: string; placement: unknown }> = []
    restoreRegistration()
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async ({ landscapeId, versionId, documentIds }) => {
      for (const documentId of documentIds) {
        atClaim.push({ id: documentId, placement: serverCreationPlacementFor(documentId) })
        claims.push(documentId)
        await db.pool.query(
          'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [documentId, landscapeId, versionId])
      }
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    const stop = await start(ws, on(threshold))
    try {
      changeHeadTo(ws.head, threshold)
      const child = await until(() => currentHead(ws), (url) => url !== ws.head.url)
      expect(child).not.toBe(ws.head.url)
      expect(atClaim).toEqual([{ id: docId(child), placement: WS }])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a head attached AFTER boot (initial apply) that is already due is rotated with no write to it (P19)', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 4
    const stop = await start(ws, on(threshold))
    try {
      await until(() => roObject('x'), (x) => x !== undefined)
      // A head written elsewhere, already past the threshold, becomes current.
      const late = repo.create<ObjHead>({ objects: {}, writeBatchIds: [] })
      changeHeadTo(late, threshold + 1)
      await repo.flush()
      await db.pool.query(
        'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [String(late.documentId), WS.landscapeId, WS.versionId])
      ws.meta.change((m) => {
        m.editsObjectShardUrls.push(late.url)
        m.objectShardUrls.push(late.url)
        m.editsObjectShardUrl = late.url
      })
      await until(() => roObject('n0'), (row) => row !== undefined)
      const child = await until(() => currentHead(ws), (url) => url !== late.url && url !== ws.head.url, 10_000)
      expect(child).not.toBe(late.url)
      expect((await retirementRows()).map((row) => row.document_id)).toEqual([String(late.documentId)])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('the row transaction\'s lock_timeout BOUNDS the wait on a held state row: refused, then retried (R13)', async () => {
    // Behavioural, not an SQL-string anchor: another session holds
    // `read_model_projection_state` FOR UPDATE from the instant the rotator
    // opens its row transaction. The fence assert inside it must give up at
    // STATIC_PLANE_LOCK_WAIT_MS (5 s) — while the session lock and the pooled
    // client are held — rather than wait as long as the holder likes.
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const holder = await db.pool.connect()
    let holding = false
    let heldAt = 0
    const hooked = hookPool(async (sql) => {
      if (!holding && sql.startsWith('BEGIN; SET LOCAL lock_timeout')) {
        holding = true
        await holder.query('BEGIN')
        await holder.query(
          'SELECT 1 FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2 FOR UPDATE',
          [WS.landscapeId, WS.versionId])
        heldAt = Date.now()
      }
    })
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    const stop = await start(ws, on(threshold), { pool: hooked })
    try {
      changeHeadTo(ws.head, threshold)
      const failed = await until(() => log.events('read_model.ordinary_head_rotation_failed'), (lines) => lines.length > 0, 9_000)
      // Gave up while the row was STILL held, within the ceiling plus slack.
      expect(failed.length).toBe(1)
      expect(String(failed[0]!.error)).toMatch(/lock timeout/)
      expect(Date.now() - heldAt).toBeLessThan(8_000)
      expect(currentHead(ws)).toBe(ws.head.url)
      await holder.query('COMMIT')
      // Retried once the row is free.
      expect(await until(() => currentHead(ws), (url) => url !== ws.head.url, 10_000)).not.toBe(ws.head.url)
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      holder.release()
      stop()
      log.restore()
      await repo.shutdown()
    }
  }, 30_000)

  it('a TRANSIENT rotation failure is retried with no new write (P08)', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    let failures = 1
    const hooked = hookPool((sql) => {
      if (failures > 0 && sql.includes('INSERT INTO read_model_ordinary_head_retirements')) {
        failures -= 1
        throw new Error('injected retirement insert failure')
      }
    })
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    const stop = await start(ws, on(threshold), { pool: hooked })
    try {
      changeHeadTo(ws.head, threshold)
      await until(() => log.events('read_model.ordinary_head_rotation_failed'), (lines) => lines.length > 0)
      expect(log.events('read_model.ordinary_head_rotation_failed')).toHaveLength(1)
      expect(failures).toBe(0)
      const child = await until(() => currentHead(ws), (url) => url !== ws.head.url, 10_000)
      expect(child).not.toBe(ws.head.url)
      expect(await retirementRows()).toHaveLength(1)
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a row naming heads the retired document lacks (unknown-heads) DEGRADES the workspace, and nothing lifts it (P36, P37)', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    // The head is retired by hand: a fresh current head, the old one still listed.
    const current = repo.create<ObjHead>({ objects: {}, writeBatchIds: [] })
    await current.whenReady()
    ws.meta.change((m) => {
      m.editsObjectShardUrls.push(current.url)
      m.objectShardUrls.push(current.url)
      m.editsObjectShardUrl = current.url
    })
    await repo.flush()
    await db.pool.query(
      'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [String(current.documentId), WS.landscapeId, WS.versionId])
    await db.pool.query(
      `INSERT INTO read_model_ordinary_head_retirements
         (landscape_id, version_id, collection, document_id, retirement_heads, status)
       VALUES ($1, $2, 'object', $3, $4::text[], 'retired')`,
      [WS.landscapeId, WS.versionId, String(ws.head.documentId), ['f'.repeat(64)]])
    const stop = await start(ws, on(1_000_000))
    try {
      // A late write on the retired head asks for a forward.
      ws.head.change((d) => { d.objects.x.late = 'L' })
      await until(() => log.events('read_model.ordinary_head_forward_refused'), (lines) => lines.length > 0)
      expect(log.events('read_model.ordinary_head_forward_refused')[0]).toMatchObject({ reason: 'unknown-heads' })
      expect(await until(degradedSince, (value) => Boolean(value))).toBeTruthy()
      await settle(600)
      expect(await degradedSince()).toBeTruthy()
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  // ---- the rotation's quiet window (requestRotation, projectorService.ts) ----
  // One write every 150 ms, the way a burst of writers keeps a due head busy.
  const burst = async (ws: Workspace, ms: number, onEach?: () => void) => {
    const end = Date.now() + ms
    let index = 0
    while (Date.now() < end) {
      ws.head.change((d) => { d.objects[`burst${index}`] = { id: `burst${index}`, name: 'B', type: 'system' } })
      index += 1
      onEach?.()
      await settle(150)
    }
  }

  it('a head that turns due mid-burst is rotated only once its writes have been quiet for the window', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 2
    const stop = await start(ws, on(threshold, { deferral: { quietMs: 800, maxMs: 60_000 } }))
    try {
      // Due after the first two writes; the burst goes on for 2 s past that.
      let movedDuringBurst = false
      await burst(ws, 2_000, () => { if (currentHead(ws) !== ws.head.url) movedDuringBurst = true })
      const burstEnded = Date.now()
      expect(movedDuringBurst).toBe(false)
      expect(currentHead(ws)).toBe(ws.head.url)
      await until(() => currentHead(ws), (url) => url !== ws.head.url)
      const deferred = await until(() => log.events('read_model.ordinary_head_rotation_deferred'), (lines) => lines.length > 0)
      expect(deferred).toHaveLength(1)
      expect(deferred[0]).toMatchObject({ kind: 'object', url: ws.head.url, cause: 'quiet' })
      // Re-armed by the burst's passes, and fired after it.
      expect(deferred[0].resets as number).toBeGreaterThanOrEqual(3)
      expect(deferred[0].waitedMs as number).toBeGreaterThanOrEqual(1_500 - TIMER_SLACK_MS)
      expect(Date.now() - burstEnded).toBeGreaterThanOrEqual(600)
      await until(() => log.events('read_model.ordinary_head_rotated'), (lines) => lines.length === 1)
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a head written without pause is still rotated once the cap has passed', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 2
    const stop = await start(ws, on(threshold, { deferral: { quietMs: 1_000, maxMs: 1_500 } }))
    try {
      // Never 1 s quiet: only the cap can rotate it, and while the writes go on.
      let movedDuringBurst = false
      await burst(ws, 5_000, () => { if (currentHead(ws) !== ws.head.url) movedDuringBurst = true })
      expect(movedDuringBurst).toBe(true)
      // The child turns due two writes later and is capped in turn: only the first head's line is read.
      const deferred = log.events('read_model.ordinary_head_rotation_deferred').filter((line) => line.url === ws.head.url)
      expect(deferred).toHaveLength(1)
      expect(deferred[0]).toMatchObject({ cause: 'max-wait' })
      expect(deferred[0].waitedMs as number).toBeGreaterThanOrEqual(1_500 - TIMER_SLACK_MS)
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('quietMs 0 rotates as soon as the head is due, with no deferral', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 2
    const stop = await start(ws, on(threshold, { deferral: { quietMs: 0, maxMs: 0 } }))
    try {
      let movedDuringBurst = false
      await burst(ws, 2_000, () => { if (currentHead(ws) !== ws.head.url) movedDuringBurst = true })
      expect(movedDuringBurst).toBe(true)
      expect(log.events('read_model.ordinary_head_rotation_deferred')).toEqual([])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a deferred rotation does not outlive its projector', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 2
    const stop = await start(ws, on(threshold, { deferral: { quietMs: 1_000, maxMs: 60_000 } }))
    try {
      await burst(ws, 600)
      await until(() => log.events('read_model.ordinary_head_rotation_due'), (lines) => lines.length > 0)
      stop()
      await settle(1_800)
      expect(currentHead(ws)).toBe(ws.head.url)
      expect(log.events('read_model.ordinary_head_rotation_deferred')).toEqual([])
      expect(await retirementRows()).toEqual([])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  // ---- the quiet window, from the QA lens's surviving mutants ----
  it('a refused rotation\'s backoff retry goes straight to the rotator: it is not deferred a second time', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const holder = await db.pool.connect()
    const lockKey = overlayRotationLockKey(WS.landscapeId, WS.versionId, 'object')
    await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey])
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    const stop = await start(ws, on(threshold, { deferral: { quietMs: 500, maxMs: 60_000 } }))
    try {
      changeHeadTo(ws.head, threshold)
      const contended = await until(() => log.events('read_model.overlay_rotation_lock_contended'), (lines) => lines.length > 0)
      expect(contended[0]).toMatchObject({ path: 'rotate', kind: 'object', state: 'refused' })
      // A write while the backoff waits: the rotation is already asked for, nothing is deferred.
      ws.head.change((d) => { d.objects.during = { id: 'during', name: 'D', type: 'system' } })
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
      await until(() => currentHead(ws), (url) => url !== ws.head.url, 10_000)
      expect(currentHead(ws)).not.toBe(ws.head.url)
      // One deferral, before the first attempt; the retry (1 s backoff) is not re-deferred.
      expect(log.events('read_model.ordinary_head_rotation_deferred').filter((line) => line.url === ws.head.url)).toHaveLength(1)
    } finally {
      holder.release()
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('an object and a connection head deferred in the same burst are each rotated: one kind\'s deferral does not cancel the other\'s', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const conn = await connHeadOf(ws)
    const threshold = Math.max(
      A.stats(conn.doc() as A.Doc<unknown>).numChanges, A.stats(ws.head.doc() as A.Doc<unknown>).numChanges) + 2
    const stop = await start(ws, on(threshold, { deferral: { quietMs: 800, maxMs: 60_000 } }))
    try {
      // Both writers interleaved, one write each every 150 ms, past both thresholds.
      const end = Date.now() + 2_000
      let index = 0
      while (Date.now() < end) {
        ws.head.change((d) => { d.objects[`burst${index}`] = { id: `burst${index}`, name: 'B', type: 'system' } })
        conn.change((d) => { d.connections[`kb${index}`] = { id: `kb${index}`, fromId: 'b', toId: 'x', label: 'K' } })
        index += 1
        await settle(150)
      }
      await until(() => [currentHead(ws), ws.meta.doc().editsConnectionShardUrl],
        ([object, connection]) => object !== ws.head.url && connection !== conn.url)
      expect(currentHead(ws)).not.toBe(ws.head.url)
      expect(ws.meta.doc().editsConnectionShardUrl).not.toBe(conn.url)
      const deferred = log.events('read_model.ordinary_head_rotation_deferred')
      expect(deferred.filter((line) => line.url === ws.head.url)).toMatchObject([{ kind: 'object', cause: 'quiet' }])
      expect(deferred.filter((line) => line.url === conn.url)).toMatchObject([{ kind: 'connection', cause: 'quiet' }])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a lease lost while the rotation is deferred: the deferral fires nothing', async () => {
    let owned = true
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    const stop = await start(ws, on(threshold, { deferral: { quietMs: 500, maxMs: 60_000 } }), { stillOwned: () => owned })
    try {
      changeHeadTo(ws.head, threshold)
      await until(() => log.events('read_model.ordinary_head_rotation_due'), (lines) => lines.length > 0)
      owned = false
      await settle(1_200)
      expect(log.events('read_model.ordinary_head_rotation_deferred')).toEqual([])
      expect(currentHead(ws)).toBe(ws.head.url)
      expect(await retirementRows()).toEqual([])
      expect(claims).toEqual([])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('a negative quietMs is no deferral either', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    const stop = await start(ws, on(threshold, { deferral: { quietMs: -1, maxMs: 0 } }))
    try {
      changeHeadTo(ws.head, threshold)
      await until(() => currentHead(ws), (url) => url !== ws.head.url)
      expect(currentHead(ws)).not.toBe(ws.head.url)
      expect(log.events('read_model.ordinary_head_rotation_deferred')).toEqual([])
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })

  it('shadow defers nothing: no deferral line for a rotation it will not make', async () => {
    const { repo } = storageRepo()
    const ws = await workspace(repo)
    const log = logLines()
    const threshold = A.stats(ws.head.doc() as A.Doc<unknown>).numChanges + 1
    const stop = await start(ws, on(threshold, { mode: 'shadow', deferral: { quietMs: 300, maxMs: 60_000 } }))
    try {
      changeHeadTo(ws.head, threshold)
      await until(() => log.events('read_model.ordinary_head_rotation_due'), (lines) => lines.length > 0)
      await settle(900)
      expect(log.events('read_model.ordinary_head_rotation_deferred')).toEqual([])
      expect(currentHead(ws)).toBe(ws.head.url)
    } finally {
      stop()
      log.restore()
      await repo.shutdown()
    }
  })
})
