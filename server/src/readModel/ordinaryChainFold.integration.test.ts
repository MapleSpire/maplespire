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
import { Repo, parseAutomergeUrl, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { startReadModelProjector } from './projectorService.js'
import { readOrdinaryHeadRetirement, recordOrdinaryHeadRetirement } from './ordinaryHeadForwarding.js'
import { ORDINARY_HEAD_ROTATION_OFF } from './ordinaryHeadRotation.js'
import { ORDINARY_FOLD_SOURCES_FIELD, recordOrdinaryChainFold } from './ordinaryChainFold.js'
import type { WorkspaceKey } from './projector.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'

/**
 * G4-16b phase 4, step 1: what a RUNNING ordinary projector does when a fold
 * substitutes a merged segment for retired heads in ModelMeta. No fold exists
 * yet, so each test plays it by hand: rotate (row with H_r, repoint), write a
 * NEWER value on the current head, then substitute a merged copy of the
 * retired head in one ModelMeta change.
 *
 * Every success test has a CONTROL that runs the same substitution without
 * the `foldedFromUrls` marker and shows the defect the marker prevents: the
 * merged segment's OLDER value over the newer row.
 *
 * Own schema (`rmocf_test`), DATABASE_URL like the sibling suites; skips
 * without a database.
 */
const WS: WorkspaceKey = { landscapeId: 'ls-ocf', versionId: 'v1' }
const SCHEMA = 'rmocf_test'
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({
    connectionString: URL, max: 4, connectionTimeoutMillis: 4000, options: `-c search_path=${SCHEMA},public`,
  }), 'ordinaryChainFold')
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
if (!pool) console.warn(`[ordinaryChainFold] no Postgres at ${URL} — skipping`)

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 6000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))

type Entity = { id: string; [field: string]: unknown }
type ObjHead = { objects: Record<string, Entity>; writeBatchIds: string[]; foldedFromUrls?: string[] }
type ConnHead = { connections: Record<string, Entity>; writeBatchIds: string[]; foldedFromUrls?: string[] }
type Meta = {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrl: string
  editsObjectShardUrls: string[]
  editsConnectionShardUrl: string
  editsConnectionShardUrls: string[]
  groups: Record<string, unknown>
}

interface Workspace {
  repo: Repo
  rootUrl: string
  meta: DocHandle<Meta>
  objHead: DocHandle<ObjHead>
  connHead: DocHandle<ConnHead>
}

async function workspace(): Promise<Workspace> {
  const repo = new Repo({})
  const base = repo.create({ objects: { b: { id: 'b', name: 'B' } } })
  const objHead = repo.create<ObjHead>({
    objects: { x: { id: 'x', name: 'old' }, y: { id: 'y', name: 'y0' } }, writeBatchIds: [],
  })
  const connHead = repo.create<ConnHead>({
    connections: { c: { id: 'c', fromId: 'x', toId: 'b', label: 'old' } }, writeBatchIds: [],
  })
  const meta = repo.create<Meta>({
    objectShardUrls: [base.url, objHead.url],
    connectionShardUrls: [connHead.url],
    editsObjectShardUrl: objHead.url,
    editsObjectShardUrls: [objHead.url],
    editsConnectionShardUrl: connHead.url,
    editsConnectionShardUrls: [connHead.url],
    groups: {},
  })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
  await Promise.all([base, objHead, connHead, meta, root].map((h) => h.whenReady()))
  return { repo, rootUrl: root.url, meta, objHead, connHead }
}

type Kind = 'object' | 'connection'
/** An overlay head of either collection. */
type Head = DocHandle<ObjHead> | DocHandle<ConnHead>
const fieldOf = (kind: Kind) => kind === 'object' ? 'objects' : 'connections'

/** The rotator by hand (phase 3's order): durable empty child, `retired` row
 * with H_r, one ModelMeta repoint. */
async function rotate(
  ws: Workspace,
  kind: Kind,
  /** H_r to record instead of the head's real heads. */
  retirementHeads?: string[],
): Promise<Head> {
  const old = kind === 'object' ? ws.objHead : ws.connHead
  const child = ws.repo.create({ [fieldOf(kind)]: {}, writeBatchIds: [] }) as unknown as Head
  await child.whenReady()
  await ws.repo.flush([child.documentId])
  await recordOrdinaryHeadRetirement(pool!, WS, {
    collection: kind,
    documentId: old.documentId,
    retirementHeads: retirementHeads ?? A.getHeads(old.doc() as A.Doc<unknown>),
    status: 'retired',
  })
  ws.meta.change((m) => {
    if (kind === 'object') {
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

/** The fold by hand: a durable copy of `sources`' entities (later wins),
 * marked or not, substituted at the first source's slot in ONE change. */
async function substitute(
  ws: Workspace,
  kind: Kind,
  sources: Array<Head>,
  opts: { marked?: boolean; markedSources?: string[]; record?: boolean } = {},
): Promise<Head> {
  const field = fieldOf(kind)
  const merged: Record<string, Entity> = {}
  for (const source of sources) {
    Object.assign(merged, JSON.parse(JSON.stringify((source.doc() as Record<string, unknown>)[field] ?? {})))
  }
  const content: Record<string, unknown> = { [field]: merged, writeBatchIds: [] }
  if (opts.marked ?? true) content[ORDINARY_FOLD_SOURCES_FIELD] = opts.markedSources ?? sources.map((s) => s.url)
  const product = ws.repo.create(content) as unknown as Head
  await product.whenReady()
  await ws.repo.flush([product.documentId])
  if (opts.record ?? (opts.marked ?? true)) await recordFold(ws, kind, product, sources)
  const gone = new Set<string>(sources.map((s) => s.url))
  const replace = (list: string[]) => {
    const at = list.findIndex((url) => gone.has(url))
    for (let i = list.length - 1; i >= 0; i--) if (gone.has(list[i])) list.splice(i, 1)
    list.splice(at, 0, product.url)
  }
  ws.meta.change((m) => {
    if (kind === 'object') { replace(m.objectShardUrls); replace(m.editsObjectShardUrls) }
    else { replace(m.connectionShardUrls); replace(m.editsConnectionShardUrls) }
  })
  return product
}

/** The fold's server-side record, as phase 4.3 will write it: in ONE
 * transaction, every source `retired` -> `folded` at the forward state read
 * now, then the product's row. */
async function recordFold(
  ws: Workspace, kind: Kind, product: DocHandle<unknown>, sources: Array<DocHandle<unknown>>,
) {
  const meta = ws.meta.doc() as Meta
  const currentUrl = (kind === 'object' ? meta.editsObjectShardUrl : meta.editsConnectionShardUrl) as AutomergeUrl
  const client = await pool!.connect()
  try {
    await client.query('BEGIN')
    await recordOrdinaryChainFold(client, WS, {
      collection: kind,
      productDocumentId: product.documentId,
      productHeads: A.getHeads(product.doc() as A.Doc<unknown>),
      currentDocumentId: parseAutomergeUrl(currentUrl).documentId,
      sources: await Promise.all(sources.map(async (source) => ({
        documentId: source.documentId,
        forwardedHeads: (await readOrdinaryHeadRetirement(pool!, WS, kind, source.documentId))?.forwardedHeads ?? null,
      }))),
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

const roRow = async (kind: Kind, id: string) => (await pool!.query<{ data: Record<string, unknown> }>(
  `SELECT data FROM ${kind === 'object' ? 'ro_objects' : 'ro_connections'}
   WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
  [WS.landscapeId, WS.versionId, id],
)).rows[0]?.data
const degradation = async () => (await pool!.query<{ degraded_since: Date | null; degraded_kind: string | null }>(
  'SELECT degraded_since, degraded_kind FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
  [WS.landscapeId, WS.versionId],
)).rows[0]

function detachLog() {
  const lines: Array<Record<string, unknown>> = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const first = args[0]
    if (typeof first !== 'string' || !first.startsWith('{')) return
    try {
      const parsed = JSON.parse(first) as Record<string, unknown>
      if (parsed.event === 'read_model.ordinary_fold_source_detached') lines.push(parsed)
    } catch { /* not ours */ }
  })
  return { lines, restore: () => spy.mockRestore() }
}

async function start(ws: Workspace, residency?: AutomergeResidencyLeases) {
  return startReadModelProjector(
    ws.repo, ws.rootUrl, pool!, WS, residency, 0, undefined,
    undefined, undefined, undefined, ORDINARY_HEAD_ROTATION_OFF,
  )
}

/** Rotate `kind`, then write the NEWER value of the probe entity on the new
 * current head and wait until ro_* serves it. */
async function rotatedWithNewerValue(ws: Workspace, kind: Kind) {
  const retired = kind === 'object' ? ws.objHead : ws.connHead
  const current = await rotate(ws, kind)
  if (kind === 'object') {
    (current as DocHandle<ObjHead>).change((d) => { d.objects.x = { id: 'x', name: 'new' } })
    await until(() => roRow('object', 'x'), (v) => v?.name === 'new')
    expect((await roRow('object', 'x'))?.name).toBe('new')
  } else {
    (current as DocHandle<ConnHead>).change((d) => {
      d.connections.c = { id: 'c', fromId: 'x', toId: 'b', label: 'new' }
    })
    await until(() => roRow('connection', 'c'), (v) => v?.label === 'new')
    expect((await roRow('connection', 'c'))?.label).toBe('new')
  }
  return { retired, current }
}

const probe = { object: { id: 'x', field: 'name' }, connection: { id: 'c', field: 'label' } } as const

suite('ordinary chain fold, projector side (G4-16b phase 4 step 1) — projector + PostgreSQL', () => {
  afterAll(async () => {
    const c = await pool!.connect()
    try {
      await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    } finally {
      c.release()
      await pool!.end()
    }
  })
  beforeEach(async () => {
    await pool!.query(`TRUNCATE ro_objects, ro_connections, ro_groups, read_model_projection_state,
      read_model_change_events, read_model_overlay_batch_acks, read_model_overlay_entity_bases,
      read_model_ordinary_head_retirements, read_model_document_watermarks, read_model_ordinary_chain_folds`)
  })

  it.each(['object', 'connection'] as const)(
    'a MARKED %s fold product is attached without publishing: the newer row stays, the source is detached and its lease released',
    async (kind) => {
      const ws = await workspace()
      const residency = new AutomergeResidencyLeases(ws.repo)
      const log = detachLog()
      const stop = await start(ws, residency)
      try {
        const { retired } = await rotatedWithNewerValue(ws, kind)
        expect(residency.isLeased(retired.documentId)).toBe(true)
        const product = await substitute(ws, kind, [retired])
        await until(() => log.lines.length, (n) => n > 0)
        await settle()
        const { id, field } = probe[kind]
        expect((await roRow(kind, id))?.[field]).toBe('new')
        expect(log.lines).toEqual([expect.objectContaining({ kind, url: retired.url })])
        await residency.drain()
        expect(residency.isLeased(retired.documentId)).toBe(false)
        expect(residency.isLeased(product.documentId)).toBe(true)
        expect((await degradation())?.degraded_since ?? null).toBeNull()
      } finally {
        stop()
        log.restore()
      }
    },
  )

  it.each(['object', 'connection'] as const)(
    'a CHANGE to an attached %s fold product is refused: degraded, nothing projected, the newer row stays',
    async (kind) => {
      const ws = await workspace()
      const log = detachLog()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const stop = await start(ws)
      try {
        const { retired } = await rotatedWithNewerValue(ws, kind)
        const product = await substitute(ws, kind, [retired])
        await until(() => log.lines.length, (n) => n > 0)
        await settle()
        expect((await degradation())?.degraded_since ?? null).toBeNull()
        // Any projection of a non-current segment rewrites its WHOLE entity
        // set, so projecting this change would also put the probe entity back
        // to the product's older value.
        if (kind === 'object') {
          (product as DocHandle<ObjHead>).change((d) => { d.objects.y = { id: 'y', name: 'y1' } })
        } else {
          (product as DocHandle<ConnHead>).change((d) => {
            d.connections.d = { id: 'd', fromId: 'b', toId: 'x', label: 'd1' }
          })
        }
        const state = await until(degradation, (s) => Boolean(s?.degraded_since))
        expect(state?.degraded_since).not.toBeNull()
        await settle()
        const { id, field } = probe[kind]
        expect((await roRow(kind, id))?.[field]).toBe('new')
        if (kind === 'object') expect((await roRow('object', 'y'))?.name).toBe('y0')
        else expect(await roRow('connection', 'd')).toBeUndefined()
        expect(errors.mock.calls.some((call) => call.some((arg) =>
          String(arg instanceof Error ? arg.message : arg).includes('ordinary-fold-product-changed')))).toBe(true)
      } finally {
        stop()
        errors.mockRestore()
        log.restore()
      }
    },
  )

  it('a source that is NOT SETTLED (a forward it owes has not committed) is refused: degraded, nothing detached', async () => {
    const ws = await workspace()
    const log = detachLog()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stop = await start(ws)
    try {
      // The row names an H_r the head does not hold (`unknown-heads`): the
      // forward is refused for good, so the head's live heads never equal
      // what the row says was carried.
      const retired = ws.objHead
      await rotate(ws, 'object', ['0'.repeat(64)])
      await settle()
      await substitute(ws, 'object', [retired])
      await until(() => errors.mock.calls.length, () => errors.mock.calls.some((call) => call.some((arg) =>
        String(arg instanceof Error ? arg.message : arg).includes('ordinary-fold-sources-not-settled'))))
      expect(errors.mock.calls.some((call) => call.some((arg) =>
        String(arg instanceof Error ? arg.message : arg).includes('ordinary-fold-sources-not-settled')))).toBe(true)
      expect((await until(degradation, (state) => Boolean(state?.degraded_since)))?.degraded_since).not.toBeNull()
      expect(log.lines).toEqual([])
    } finally {
      stop()
      errors.mockRestore()
      warns.mockRestore()
      log.restore()
    }
  })

  it('a source that is the CURRENT write head is never detached, even when a product names it and ModelMeta unlists it', async () => {
    const ws = await workspace()
    const log = detachLog()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = await start(ws)
    try {
      const { current } = await rotatedWithNewerValue(ws, 'object')
      await substitute(ws, 'object', [current], { record: false })
      const state = await until(degradation, (s) => Boolean(s?.degraded_since))
      expect(state?.degraded_since).not.toBeNull()
      expect(log.lines).toEqual([])
      // Still projected: a write on the current head reaches its row.
      ;(current as DocHandle<ObjHead>).change((d) => { d.objects.x = { id: 'x', name: 'newer' } })
      expect((await until(() => roRow('object', 'x'), (v) => v?.name === 'newer'))?.name).toBe('newer')
    } finally {
      stop()
      errors.mockRestore()
      log.restore()
    }
  })

  it.each(['object', 'connection'] as const)(
    'CONTROL: the same %s substitution WITHOUT the marker is applied, and the older value regresses the newer row',
    async (kind) => {
      const ws = await workspace()
      const log = detachLog()
      const stop = await start(ws)
      try {
        const { retired } = await rotatedWithNewerValue(ws, kind)
        await substitute(ws, kind, [retired], { marked: false })
        const { id, field } = probe[kind]
        expect((await until(() => roRow(kind, id), (v) => v?.[field] === 'old'))?.[field]).toBe('old')
        expect(log.lines).toEqual([])
      } finally {
        stop()
        log.restore()
      }
    },
  )

  it('a source no longer listed is NOT re-projected: a late write on it changes no row (phase 4.4 owns it)', async () => {
    const ws = await workspace()
    const log = detachLog()
    const stop = await start(ws)
    try {
      const { retired } = await rotatedWithNewerValue(ws, 'object')
      await substitute(ws, 'object', [retired])
      await until(() => log.lines.length, (n) => n > 0)
      ;(retired as DocHandle<ObjHead>).change((d) => { d.objects.z = { id: 'z', name: 'late' } })
      await settle(800)
      expect(await roRow('object', 'z')).toBeUndefined()
    } finally {
      stop()
      log.restore()
    }
  })

  it('a product naming a source this projector does not watch is REFUSED: degraded, nothing applied, nothing detached', async () => {
    const ws = await workspace()
    const log = detachLog()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = await start(ws)
    try {
      const { retired } = await rotatedWithNewerValue(ws, 'object')
      const stranger = ws.repo.create({ objects: {}, writeBatchIds: [] })
      await stranger.whenReady()
      await substitute(ws, 'object', [retired], { markedSources: [retired.url, stranger.url] })
      const state = await until(degradation, (s) => Boolean(s?.degraded_since))
      expect(state?.degraded_since).not.toBeNull()
      expect(errors.mock.calls.some((call) => call.some((arg) =>
        String(arg instanceof Error ? arg.message : arg).includes('ordinary-fold-sources-not-watched')))).toBe(true)
      await settle()
      expect((await roRow('object', 'x'))?.name).toBe('new')
      expect(log.lines).toEqual([])
    } finally {
      stop()
      errors.mockRestore()
      log.restore()
    }
  })

  it('a product that is the CURRENT head is refused: degraded, its content not skipped silently', async () => {
    const ws = await workspace()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = await start(ws)
    try {
      await rotatedWithNewerValue(ws, 'object')
      const bogus = ws.repo.create<ObjHead>({
        objects: { w: { id: 'w', name: 'w0' } }, writeBatchIds: [], foldedFromUrls: [ws.objHead.url],
      })
      await bogus.whenReady()
      ws.meta.change((m) => {
        m.editsObjectShardUrl = bogus.url
        m.objectShardUrls.push(bogus.url)
        m.editsObjectShardUrls.push(bogus.url)
      })
      const state = await until(degradation, (s) => Boolean(s?.degraded_since))
      expect(state?.degraded_since).not.toBeNull()
      expect(errors.mock.calls.some((call) => call.some((arg) =>
        String(arg instanceof Error ? arg.message : arg).includes('is the current write head')))).toBe(true)
    } finally {
      stop()
      errors.mockRestore()
    }
  })

  it('a cold build after the fold extracts the product, never the unlisted source, and serves the newer value', async () => {
    const ws = await workspace()
    const log = detachLog()
    let stop = await start(ws)
    try {
      const { retired } = await rotatedWithNewerValue(ws, 'object')
      await substitute(ws, 'object', [retired])
      await until(() => log.lines.length, (n) => n > 0)
      stop()
      ;(retired as DocHandle<ObjHead>).change((d) => { d.objects.z = { id: 'z', name: 'late' } })
      stop = await start(ws)
      await settle()
      expect((await roRow('object', 'x'))?.name).toBe('new')
      expect((await roRow('object', 'y'))?.name).toBe('y0')
      expect(await roRow('object', 'z')).toBeUndefined()
      // The product carries a `retired` row (step 2, so a later fold can take
      // it), which the boot reads: it must not run it as a forwarded head.
      expect((await degradation())?.degraded_since ?? null).toBeNull()
    } finally {
      stop()
      log.restore()
    }
  })

  // ---- step 2: the server-side record is the authority ---------------------

  it('an UNRECORDED product (marker, no fold row) is refused: degraded, nothing detached, the newer row stays', async () => {
    const ws = await workspace()
    const log = detachLog()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = await start(ws)
    try {
      const { retired } = await rotatedWithNewerValue(ws, 'object')
      await substitute(ws, 'object', [retired], { record: false })
      await until(() => errors.mock.calls.length, () => errors.mock.calls.some((call) => call.some((arg) =>
        String(arg instanceof Error ? arg.message : arg).includes('ordinary-fold-unrecorded'))))
      expect(errors.mock.calls.some((call) => call.some((arg) =>
        String(arg instanceof Error ? arg.message : arg).includes('ordinary-fold-unrecorded')))).toBe(true)
      expect((await until(degradation, (state) => Boolean(state?.degraded_since)))?.degraded_since).not.toBeNull()
      await settle()
      expect((await roRow('object', 'x'))?.name).toBe('new')
      expect(log.lines).toEqual([])
    } finally {
      stop()
      errors.mockRestore()
      log.restore()
    }
  })

  it('a product whose fold row its sources are NOT folded into is refused as a MISMATCH', async () => {
    const ws = await workspace()
    const log = detachLog()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = await start(ws)
    try {
      const { retired } = await rotatedWithNewerValue(ws, 'object')
      // The source is folded into ANOTHER product; this product's row claims it.
      const other = ws.repo.create({ objects: {}, writeBatchIds: [] })
      await other.whenReady()
      await recordFold(ws, 'object', other, [retired])
      const product = await substitute(ws, 'object', [retired], { record: false })
      await pool!.query(
        `INSERT INTO read_model_ordinary_chain_folds (landscape_id, version_id, collection, product_document_id, source_document_ids)
         VALUES ($1, $2, 'object', $3, $4::text[])`,
        [WS.landscapeId, WS.versionId, product.documentId, [retired.documentId]],
      )
      await until(() => errors.mock.calls.length, () => errors.mock.calls.some((call) => call.some((arg) =>
        String(arg instanceof Error ? arg.message : arg).includes('ordinary-fold-mismatch'))))
      expect(errors.mock.calls.some((call) => call.some((arg) =>
        String(arg instanceof Error ? arg.message : arg).includes('ordinary-fold-mismatch')))).toBe(true)
      await settle()
      expect(log.lines).toEqual([])
      expect((await roRow('object', 'x'))?.name).toBe('new')
    } finally {
      stop()
      errors.mockRestore()
      log.restore()
    }
  })

  it('recording a fold is a CAS on forwarded_heads: a forward committed since the read conflicts, and the rollback leaves nothing', async () => {
    const ws = await workspace()
    const retired = ws.objHead
    await recordOrdinaryHeadRetirement(pool!, WS, {
      collection: 'object', documentId: retired.documentId,
      retirementHeads: A.getHeads(retired.doc() as A.Doc<unknown>), status: 'retired',
    })
    // A forward commits after the fold read `forwarded_heads` (null).
    await pool!.query(
      `UPDATE read_model_ordinary_head_retirements SET forwarded_heads = $3::text[]
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = $4`,
      [WS.landscapeId, WS.versionId, ['f'.repeat(64)], retired.documentId],
    )
    const client = await pool!.connect()
    try {
      await client.query('BEGIN')
      await expect(recordOrdinaryChainFold(client, WS, {
        collection: 'object', productDocumentId: 'product-doc', productHeads: ['p'.repeat(64)],
        currentDocumentId: 'current-doc',
        sources: [{ documentId: retired.documentId, forwardedHeads: null }],
        retainUntil: new Date(Date.now() + 1000),
      })).rejects.toMatchObject({ name: 'OrdinaryChainFoldConflictError' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    expect((await readOrdinaryHeadRetirement(pool!, WS, 'object', retired.documentId))?.status).toBe('retired')
    expect((await pool!.query(
      'SELECT 1 FROM read_model_ordinary_chain_folds WHERE landscape_id = $1 AND version_id = $2',
      [WS.landscapeId, WS.versionId],
    )).rowCount).toBe(0)
  })

  it.each([
    ['folded without folded_into', `'folded', NULL, now()`],
    ['folded without retain_until', `'folded', 'p', NULL`],
    ['retired WITH folded_into', `'retired', 'p', now()`],
  ])('the schema refuses a retirement row %s', async (_label, values) => {
    await expect(pool!.query(
      `INSERT INTO read_model_ordinary_head_retirements
         (landscape_id, version_id, collection, document_id, retirement_heads, status, folded_into, retain_until)
       VALUES ($1, $2, 'object', 'doc-check', ARRAY['a'], ${values})`,
      [WS.landscapeId, WS.versionId],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('a FOLDED source still listed (the fold crashed before its ModelMeta change) keeps forwarding a late write', async () => {
    const ws = await workspace()
    const stop = await start(ws)
    try {
      const { retired } = await rotatedWithNewerValue(ws, 'object')
      const product = ws.repo.create({ objects: {}, writeBatchIds: [] })
      await product.whenReady()
      await recordFold(ws, 'object', product, [retired])
      expect((await readOrdinaryHeadRetirement(pool!, WS, 'object', retired.documentId))?.status).toBe('folded')
      ;(retired as DocHandle<ObjHead>).change((d) => { d.objects.z = { id: 'z', name: 'late' } })
      expect((await until(() => roRow('object', 'z'), (v) => v?.name === 'late'))?.name).toBe('late')
      const row = await readOrdinaryHeadRetirement(pool!, WS, 'object', retired.documentId)
      expect(row?.status).toBe('folded')
      expect(row?.forwardedHeads).toEqual([...A.getHeads(retired.doc() as A.Doc<unknown>)].sort())
    } finally {
      stop()
    }
  })

  // ---- QA kill tests (second battery) -------------------------------------
  const errorMentions = (errors: { mock: { calls: unknown[][] } }, text: string) => errors.mock.calls.some((call) =>
    call.some((arg) => String(arg instanceof Error ? arg.message : arg).includes(text)))

  it('QA R1c: a CONNECTION product that is the current CONNECTION head is refused', async () => {
    const ws = await workspace()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = await start(ws)
    try {
      await rotatedWithNewerValue(ws, 'connection')
      const bogus = ws.repo.create<ConnHead>({
        connections: { w: { id: 'w', fromId: 'x', toId: 'b', label: 'w0' } },
        writeBatchIds: [], foldedFromUrls: [ws.connHead.url],
      })
      await bogus.whenReady()
      ws.meta.change((m) => {
        m.editsConnectionShardUrl = bogus.url
        m.connectionShardUrls.push(bogus.url)
        m.editsConnectionShardUrls.push(bogus.url)
      })
      const state = await until(degradation, (s) => Boolean(s?.degraded_since))
      expect(state?.degraded_since).not.toBeNull()
      expect(errorMentions(errors, 'is the current write head')).toBe(true)
    } finally {
      stop()
      errors.mockRestore()
    }
  })

  it('QA R2c: a CONNECTION product naming a watched OBJECT shard is refused — sources are checked per collection', async () => {
    const ws = await workspace()
    const log = detachLog()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = await start(ws)
    try {
      const { retired } = await rotatedWithNewerValue(ws, 'connection')
      await substitute(ws, 'connection', [retired], { markedSources: [retired.url, ws.objHead.url] })
      const state = await until(degradation, (s) => Boolean(s?.degraded_since))
      expect(state?.degraded_since).not.toBeNull()
      expect(errorMentions(errors, 'ordinary-fold-sources-not-watched')).toBe(true)
      await settle()
      expect(log.lines).toEqual([])
    } finally {
      stop()
      errors.mockRestore()
      log.restore()
    }
  })

  it('QA R3: a MARKED product whose objects field is not a map is refused, and its source is NOT detached', async () => {
    const ws = await workspace()
    const log = detachLog()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stop = await start(ws)
    try {
      const { retired } = await rotatedWithNewerValue(ws, 'object')
      const product = ws.repo.create({ objects: 'not-a-map', writeBatchIds: [], [ORDINARY_FOLD_SOURCES_FIELD]: [retired.url] })
      await product.whenReady()
      await ws.repo.flush([product.documentId])
      await recordFold(ws, 'object', product, [retired])
      ws.meta.change((m) => {
        for (const list of [m.objectShardUrls, m.editsObjectShardUrls]) list.splice(list.indexOf(retired.url), 1, product.url)
      })
      const state = await until(degradation, (s) => Boolean(s?.degraded_since))
      expect(state?.degraded_since).not.toBeNull()
      expect(errorMentions(errors, `fold product ${product.url}`)).toBe(true)
      await settle()
      expect(log.lines).toEqual([])
    } finally {
      stop()
      errors.mockRestore()
      warns.mockRestore()
      log.restore()
    }
  })

  it('QA D2: a source is detached ONCE — a later ModelMeta change does not detach it again', async () => {
    const ws = await workspace()
    const log = detachLog()
    const stop = await start(ws)
    try {
      const { retired } = await rotatedWithNewerValue(ws, 'object')
      await substitute(ws, 'object', [retired])
      await until(() => log.lines.length, (n) => n > 0)
      // Any later ModelMeta change runs the attach pass again: append a shard.
      const extra = ws.repo.create<ObjHead>({ objects: { q: { id: 'q', name: 'q0' } }, writeBatchIds: [] })
      await extra.whenReady()
      ws.meta.change((m) => { m.objectShardUrls.push(extra.url) })
      expect((await until(() => roRow('object', 'q'), (v) => v?.name === 'q0'))?.name).toBe('q0')
      await settle()
      expect(log.lines).toHaveLength(1)
    } finally {
      stop()
      log.restore()
    }
  })

  it('QA L1/L2/D11: a detached NON-forwarded source listed again (a stale ModelMeta write) is never re-attached over newer rows', async () => {
    const ws = await workspace()
    const log = detachLog()
    const stop = await start(ws)
    try {
      // A segment that was never a write head: re-attaching it would APPLY it
      // whole (a retired head would only forward, which hides the defect).
      const side = ws.repo.create<ObjHead>({ objects: { s: { id: 's', name: 's-old' } }, writeBatchIds: [] })
      await side.whenReady()
      await ws.repo.flush([side.documentId])
      ws.meta.change((m) => { m.objectShardUrls.splice(0, 0, side.url) })
      await until(() => roRow('object', 's'), (v) => v?.name === 's-old')
      ws.objHead.change((d) => { d.objects.s = { id: 's', name: 's-new' } })
      expect((await until(() => roRow('object', 's'), (v) => v?.name === 's-new'))?.name).toBe('s-new')
      await recordOrdinaryHeadRetirement(pool!, WS, {
        collection: 'object', documentId: side.documentId,
        retirementHeads: A.getHeads(side.doc() as A.Doc<unknown>), status: 'retired',
      })
      const product = ws.repo.create<ObjHead>({
        objects: { s: { id: 's', name: 's-old' } }, writeBatchIds: [], foldedFromUrls: [side.url],
      })
      await product.whenReady()
      await ws.repo.flush([product.documentId])
      await recordFold(ws, 'object', product, [side])
      ws.meta.change((m) => { m.objectShardUrls.splice(m.objectShardUrls.indexOf(side.url), 1, product.url) })
      await until(() => log.lines.length, (n) => n > 0)
      expect(log.lines).toEqual([expect.objectContaining({ url: side.url })])
      ws.meta.change((m) => { m.objectShardUrls.push(side.url) })
      await settle(800)
      expect((await roRow('object', 's'))?.name).toBe('s-new')
    } finally {
      stop()
      log.restore()
    }
  })

  it('QA O2: stop() stops every shard watcher — a write after stop changes no row', async () => {
    const ws = await workspace()
    const stop = await start(ws)
    expect((await until(() => roRow('object', 'x'), (v) => v?.name === 'old'))?.name).toBe('old')
    stop()
    ws.objHead.change((d) => { d.objects.x = { id: 'x', name: 'after-stop' } })
    await settle(800)
    expect((await roRow('object', 'x'))?.name).toBe('old')
  })

  // QA2 U1 — append inside the main suite of ordinaryChainFold.integration.test.ts
  // (uses its helpers). A RECORDED fold whose source is the current write head
  // again (a stale ModelMeta write moved the pointer back) is never settled.
  it('QA2 U1: a recorded fold whose source is the CURRENT write head is refused as not settled', async () => {
    const ws = await workspace()
    const log = detachLog()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stop = await start(ws)
    try {
      const { retired } = await rotatedWithNewerValue(ws, 'object')
      const product = ws.repo.create<ObjHead>({
        objects: JSON.parse(JSON.stringify((retired.doc() as ObjHead).objects)),
        writeBatchIds: [], foldedFromUrls: [retired.url],
      })
      await product.whenReady()
      await ws.repo.flush([product.documentId])
      await recordFold(ws, 'object', product, [retired])
      ws.meta.change((m) => {
        m.editsObjectShardUrl = retired.url
        m.objectShardUrls.push(product.url)
      })
      await until(() => errorMentions(errors, 'ordinary-fold-sources-not-settled'), Boolean)
      expect(errorMentions(errors, `ordinary-fold-sources-not-settled: ${product.url} replaces ${retired.url}`)).toBe(true)
      expect((await until(degradation, (state) => Boolean(state?.degraded_since)))?.degraded_since).not.toBeNull()
      expect(log.lines).toEqual([])
    } finally {
      stop()
      errors.mockRestore()
      warns.mockRestore()
      log.restore()
    }
  })
})
