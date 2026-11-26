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

import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { startReadModelProjector } from './projectorService.js'
import { roObject } from './queries.js'
import type { WorkspaceKey } from './projector.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

/**
 * T-DIAGDEF-2 (A): a CONTROL document change that lands between the cold
 * build's extraction and the attach of its watcher, on the ORDINARY plane.
 *
 * The manual test's case: a diagram deleted just before a SIGTERM reaches the server
 * only when the client comes back, its socket syncing the registry shard WHILE
 * the restarted server cold-builds the workspace. The extraction read the
 * shard with the diagram; the `change` listener was attached after the delete
 * had been applied; nothing fired, and the `ro_diagrams` row stayed — through
 * reloads, until some later registry edit (measured on the stack: the shard
 * stored at the client's heads, without the diagram; the row still there; the
 * restart's cold build counted it).
 *
 * Object and connection shards already project that gap (their watchers are
 * seeded from the extraction); the registry shards, the root and ModelMeta
 * were attached with no look back. Each case injects its change at the
 * extraction's resolution of the OBJECT shard, which the extraction reads after
 * the registry and ModelMeta, and before any watcher exists.
 */
let WS: WorkspaceKey = { landscapeId: 'gap-ls', versionId: 'gap-v' }
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 4000, options: '-c search_path=rmgap_test,public' }), 'ordinaryAttachGap')
  try {
    const c = await p.connect()
    try {
      await c.query('CREATE SCHEMA IF NOT EXISTS rmgap_test')
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
if (!pool) console.warn(`[ordinary attach gap] no Postgres at ${URL} — skipping`)

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}

type Registry = { diagrams: Record<string, { id: string; name: string; docUrl: string; objectIds: string[] }> }
type Root = { modelMetaUrl: string; modelUrl: string; shardUrls: string[] }
type Meta = { objectShardUrls: string[]; connectionShardUrls: string[]; groups: Record<string, unknown>; deletedObjectIds?: string[] }

/** An ordinary sharded workspace: one object shard, one connection shard, one
 * registry shard with two diagrams. */
async function workspace(repo: Repo) {
  const objects = repo.create({ objects: {
    o1: { id: 'o1', name: 'One', type: 'system' },
    o2: { id: 'o2', name: 'Two', type: 'system' },
  } })
  const connections = repo.create({ connections: {
    c1: { id: 'c1', fromId: 'o1', toId: 'o2', label: 'calls' },
  } })
  const keepDoc = repo.create<DiagramDocLike>({ layouts: {}, comments: {}, flows: {} })
  const goneDoc = repo.create({ layouts: {}, comments: {}, flows: {} })
  const registry = repo.create<Registry>({ diagrams: {
    dKeep: { id: 'dKeep', name: 'Kept', docUrl: keepDoc.url, objectIds: ['o1'] },
    dGone: { id: 'dGone', name: 'Deleted before the stop', docUrl: goneDoc.url, objectIds: ['o2'] },
  } })
  const meta = repo.create<Meta>({ objectShardUrls: [objects.url], connectionShardUrls: [connections.url], groups: {} })
  const root = repo.create<Root>({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
  await Promise.all([objects, connections, keepDoc, goneDoc, registry, meta, root].map((h) => h.whenReady()))
  return { objects, connections, keepDoc, registry, meta, root }
}

type DiagramDocLike = { layouts: Record<string, unknown>; comments: Record<string, unknown>; flows: Record<string, unknown> }

const flowRows = async (diagramId: string): Promise<string[]> => (await pool!.query<{ connection_id: string }>(
  'SELECT connection_id FROM ro_connection_flows WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3',
  [WS.landscapeId, WS.versionId, diagramId],
)).rows.map((row) => row.connection_id)

/** Run `edit` once, when the cold build's extraction first resolves `url`:
 * after the registry and ModelMeta were read, before any watcher exists. */
function inExtractionGap(repo: Repo, url: string, edit: () => void, nth = 1): { fired: () => boolean } {
  const find = repo.find.bind(repo) as Repo['find']
  let fired = false
  let seen = 0
  ;(repo as unknown as { find: Repo['find'] }).find = (async (...args: Parameters<Repo['find']>) => {
    const handle = await find(...args)
    if (!fired && String(args[0]) === url && ++seen === nth) {
      fired = true
      edit()
    }
    return handle
  }) as Repo['find']
  return { fired: () => fired }
}

const diagramIds = async (): Promise<string[]> => (await pool!.query<{ id: string }>(
  'SELECT id FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 ORDER BY id',
  [WS.landscapeId, WS.versionId],
)).rows.map((row) => row.id)

suite('ordinary attach: a control-document change in the extraction gap is projected', () => {
  afterAll(async () => {
    // A stopped projector's pass may still be finishing its transaction.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const c = await pool!.connect()
    try {
      await c.query('DROP SCHEMA IF EXISTS rmgap_test CASCADE')
    } finally {
      c.release()
      await pool!.end()
    }
  })
  // Each case its own workspace: no TRUNCATE racing the previous case's
  // passes, which may still be finishing after its `stop()`.
  let cases = 0
  beforeEach(() => {
    cases += 1
    WS = { landscapeId: `gap-ls-${cases}`, versionId: 'gap-v' }
  })

  it('a registry shard delete: the diagram row leaves', async () => {
    const repo = new Repo({})
    const ws = await workspace(repo)
    const gap = inExtractionGap(repo, ws.objects.url, () => {
      (ws.registry as DocHandle<Registry>).change((d) => { delete d.diagrams.dGone })
    })
    const stop = await startReadModelProjector(repo, ws.root.url, pool!, WS)
    try {
      expect(gap.fired(), 'the edit never ran inside the extraction: the case is VOID').toBe(true)
      expect(await until(diagramIds, (ids) => !ids.includes('dGone'))).toEqual(['dKeep'])
    } finally {
      stop()
    }
  }, 30_000)

  it('a registry shard appended to the root: its diagrams are projected', async () => {
    const repo = new Repo({})
    const ws = await workspace(repo)
    const lateDoc = repo.create({ layouts: {}, comments: {}, flows: {} })
    const late = repo.create<Registry>({ diagrams: {
      dLate: { id: 'dLate', name: 'In a rolled-over shard', docUrl: lateDoc.url, objectIds: [] },
    } })
    await Promise.all([lateDoc, late].map((h) => h.whenReady()))
    const gap = inExtractionGap(repo, ws.objects.url, () => {
      (ws.root as DocHandle<Root>).change((d) => { d.shardUrls.push(late.url) })
    })
    const stop = await startReadModelProjector(repo, ws.root.url, pool!, WS)
    try {
      expect(gap.fired(), 'the edit never ran inside the extraction: the case is VOID').toBe(true)
      expect(await until(diagramIds, (ids) => ids.includes('dLate'))).toEqual(['dGone', 'dKeep', 'dLate'])
    } finally {
      stop()
    }
  }, 30_000)

  it('a ModelMeta tombstone: the object row leaves', async () => {
    const repo = new Repo({})
    const ws = await workspace(repo)
    const gap = inExtractionGap(repo, ws.objects.url, () => {
      (ws.meta as DocHandle<Meta>).change((d) => { d.deletedObjectIds = ['o2'] })
    })
    const stop = await startReadModelProjector(repo, ws.root.url, pool!, WS)
    try {
      expect(gap.fired(), 'the edit never ran inside the extraction: the case is VOID').toBe(true)
      expect(await until(async () => (await roObject(pool!, WS, 'o2')) ?? null, (row) => row === null)).toBeNull()
      expect((await roObject(pool!, WS, 'o1'))?.name).toBe('One')
    } finally {
      stop()
    }
  }, 30_000)

  it('a MONOLITH model change between its extraction and its watcher is projected', async () => {
    const repo = new Repo({})
    const doc = repo.create<DiagramDocLike>({ layouts: {}, comments: {}, flows: {} })
    const model = repo.create<{ objects: Record<string, unknown>; connections: Record<string, unknown>; groups: Record<string, unknown> }>({
      objects: { o1: { id: 'o1', name: 'One', type: 'system' }, o2: { id: 'o2', name: 'Two', type: 'system' } },
      connections: {},
      groups: {},
    })
    const registry = repo.create<Registry>({ diagrams: { dKeep: { id: 'dKeep', name: 'Kept', docUrl: doc.url, objectIds: ['o1'] } } })
    const root = repo.create({ modelUrl: model.url, shardUrls: [registry.url] })
    await Promise.all([doc, model, registry, root].map((h) => h.whenReady()))
    // The extraction resolves (and reads) the model first; the monolith
    // watcher resolves it a second time, then attaches.
    const gap = inExtractionGap(repo, model.url, () => {
      model.change((d) => { delete d.objects.o2 })
    }, 2)
    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      expect(gap.fired(), 'the edit never ran between the extraction and the watcher: VOID').toBe(true)
      expect(await until(async () => (await roObject(pool!, WS, 'o2')) ?? null, (row) => row === null)).toBeNull()
      expect((await roObject(pool!, WS, 'o1'))?.name).toBe('One')
    } finally {
      stop()
    }
  }, 30_000)

  it('a DIAGRAM document change while its first flow pass is in its transaction is projected', async () => {
    // `attachDiagramDoc`: `project()` reads the document, awaits a whole
    // transaction, and only then attaches the watcher. The edit is made the
    // moment that read happens (the next macrotask: the transaction's first
    // round trip to Postgres is still out).
    const repo = new Repo({})
    const ws = await workspace(repo)
    const keepDoc = ws.keepDoc as DocHandle<DiagramDocLike>
    const realDoc = keepDoc.doc.bind(keepDoc)
    let fired = false
    keepDoc.doc = (() => {
      const read = realDoc()
      if (!fired) {
        fired = true
        setTimeout(() => keepDoc.change((d) => {
          d.flows.f1 = { id: 'f1', name: 'Checkout', steps: [{ connectionId: 'c1' }] }
        }), 0)
      }
      return read
    }) as typeof keepDoc.doc
    const stop = await startReadModelProjector(repo, ws.root.url, pool!, WS)
    try {
      expect(await until(() => Promise.resolve(fired), (f) => f), 'the flow pass never read the document: VOID').toBe(true)
      expect(await until(() => flowRows('dKeep'), (rows) => rows.length > 0)).toEqual(['c1'])
    } finally {
      stop()
    }
  }, 30_000)

  it('control: with no change in the gap, the attach projects the registry once', async () => {
    const repo = new Repo({})
    const ws = await workspace(repo)
    const stop = await startReadModelProjector(repo, ws.root.url, pool!, WS)
    try {
      expect(await diagramIds()).toEqual(['dGone', 'dKeep'])
      // No move in the gap, no extra pass (a gap check that always
      // fired would pass every case above): the registry pass publishes a
      // `diagrams` change, the meta pass an `objects` one; neither follows the
      // attach (the diagram documents' first flow passes publish
      // `connections`, gap or not).
      const registryEvents = () => pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM read_model_change_events
          WHERE landscape_id = $1 AND version_id = $2 AND change_kind NOT IN ('reset', 'connections')`,
        [WS.landscapeId, WS.versionId],
      ).then((r) => r.rows[0]!.n)
      // Counted from the START: the cold build publishes `reset`,
      // so any `diagrams`/`objects` event at all is an extra pass.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(await registryEvents()).toBe(0)
      // …and ONE flow pass per diagram document (a diagram-doc gap
      // check that always fired would double every cold build's flow passes).
      const flowPasses = (await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM read_model_change_events
          WHERE landscape_id = $1 AND version_id = $2 AND change_kind = 'connections'`,
        [WS.landscapeId, WS.versionId],
      )).rows[0]!.n
      expect(flowPasses).toBe(2)
      // A later edit still reaches the rows (the watcher is attached).
      ;(ws.registry as DocHandle<Registry>).change((d) => { delete d.diagrams.dGone })
      expect(await until(diagramIds, (ids) => !ids.includes('dGone'))).toEqual(['dKeep'])
    } finally {
      stop()
    }
  }, 30_000)
})
