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
import { Repo } from '@automerge/automerge-repo'
import { startReadModelProjector } from './projectorService.js'
import { documentRetryRegistry } from './documentRetryQueue.js'
import { roObject, roGroup, roConnectionCount } from './queries.js'
import { roObjectCacheByIds } from './objectExplorer.js'
import { roDiagramCacheByIds } from './diagramOffline.js'
import { verifyWorkspaceIntegrity } from './projectionIntegrity.js'
import type { WorkspaceKey } from './projector.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

const WS: WorkspaceKey = { landscapeId: 'ls1', versionId: 'v1' }

/**
 * End-to-end wiring test: an in-process Automerge repo + the live projector →
 * Postgres → query functions. Isolated in its own schema (rmwire_test) so the live
 * async subscription writes don't collide with the txn-isolated suites; skips when
 * no DB is reachable.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  // Dedicated schema so this file's committed writes never touch public ro_* tables.
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 4000, options: '-c search_path=rmwire_test,public' }), 'projectorService')
  try {
    const c = await p.connect()
    try {
      await c.query('CREATE SCHEMA IF NOT EXISTS rmwire_test')
      await ensureReadModelSchemaForTest(c)
    } finally {
      c.release()
    }
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

async function ensureReadModelSchemaForTest(db: pg.PoolClient): Promise<void> {
  const { ensureReadModelSchema } = await import('./schema.js')
  await ensureReadModelSchema(db)
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[readModel wiring] no Postgres at ${URL} — skipping`)

/** Poll a condition (the projector's incremental writes are async, fire-and-forget). */
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}

suite('read-model projector wiring (in-process Automerge → Postgres)', () => {
  afterAll(async () => {
    const c = await pool!.connect()
    try {
      await c.query('DROP SCHEMA IF EXISTS rmwire_test CASCADE')
    } finally {
      c.release()
      await pool!.end()
    }
  })
  beforeEach(async () => {
    // The change feed too: the generation restarts with the state row, so a
    // previous test's events would otherwise read as this test's.
    await pool!.query('TRUNCATE ro_objects, ro_connections, ro_groups, read_model_projection_state, read_model_change_events')
  })

  type ObjectsEvent = { generation: number; upsertIds: string[]; deleteIds: string[] }
  const projectedGeneration = async (): Promise<number> => Number((await pool!.query<{ g: number }>(
    `SELECT projected_generation::int AS g FROM read_model_projection_state
     WHERE landscape_id = $1 AND version_id = $2`,
    [WS.landscapeId, WS.versionId],
  )).rows[0]?.g ?? 0)
  const objectsEventsAfter = async (generation: number): Promise<ObjectsEvent[]> => (await pool!.query<{
    generation: number; payload: { upsertIds: string[]; deleteIds: string[] }
  }>(
    `SELECT generation::int, payload FROM read_model_change_events
     WHERE landscape_id = $1 AND version_id = $2 AND generation > $3 AND change_kind = 'objects'
     ORDER BY generation`,
    [WS.landscapeId, WS.versionId, generation],
  )).rows.map((row) => ({
    generation: row.generation,
    upsertIds: [...row.payload.upsertIds].sort(),
    deleteIds: [...row.payload.deleteIds].sort(),
  }))
  /** Run one edit and return the objects events it produced — waiting for the
   *  first, then for the projection to be caught up, so a SECOND event from the
   *  same edit would be seen rather than raced. */
  const objectsEventsOf = async (edit: () => void): Promise<ObjectsEvent[]> => {
    const baseline = await projectedGeneration()
    edit()
    await until(() => objectsEventsAfter(baseline), (events) => events.length > 0)
    await until(
      async () => (await pool!.query<{ observed: number; projected: number }>(
        `SELECT observed_generation::int AS observed, projected_generation::int AS projected
         FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId],
      )).rows[0],
      (value) => value.observed === value.projected,
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    return objectsEventsAfter(baseline)
  }

  it('lists in the objects feed only the ids whose served row changed, and every one of them', async () => {
    // Measured 2026-10-15 before this fix: renaming ONE object listed every
    // object of its shard, so every consumer filtering on the feed's ids — an
    // inline expansion, the offline cache's by-ids re-fetch — re-read for an
    // edit that was not theirs.
    const repo = new Repo({})
    const objects: Record<string, unknown> = {}
    // o0..o7 only: o8 and o9 are CREATED below, so the multi arm tests a new
    // id on the delta path rather than a replacement.
    for (let index = 0; index < 8; index += 1) objects[`o${index}`] = { id: `o${index}`, name: `N${index}` }
    objects.o1 = { id: 'o1', name: 'N1', parentId: 'o0' }
    const os0 = repo.create({ objects })
    // A second shard carrying `x` too — a base shard and an overlay head both
    // hold an entity after a fold. The last shard written wins the ROW, which
    // is what makes a per-shard snapshot diff unsound here.
    // And `p`, a parent living in another shard than the child added below: it
    // is a candidate only because it is named as a parent.
    const os1 = repo.create({ objects: { x: { id: 'x', name: 'overlay' }, p: { id: 'p', name: 'P' } } })
    const cs0 = repo.create({ connections: {} })
    const meta = repo.create({ objectShardUrls: [os0.url, os1.url], connectionShardUrls: [cs0.url], groups: {} })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([os0, os1, cs0, meta, root].map((h) => h.whenReady()))
    type Shard = { objects: Record<string, { id: string; name: string; parentId?: string; description?: string }> }

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      // One rename → one id.
      const rename = await objectsEventsOf(() => os0.change((d: Shard) => { d.objects.o3.name = 'renamed' }))
      expect((await roObject(pool!, WS, 'o3'))?.name).toBe('renamed')
      expect(rename).toEqual([{ generation: expect.any(Number), upsertIds: ['o3'], deleteIds: [] }])

      // A real multi-object change in ONE pass still lists all of it: two
      // renames, new children (whose parents' served child_count moves, so the
      // parents are listed although their own entities did not change — `p`
      // from another shard), a delete.
      const multi = await objectsEventsOf(() => os0.change((d: Shard) => {
        d.objects.o2.name = 'two'
        d.objects.o5.name = 'five'
        d.objects.o9 = { id: 'o9', name: 'child', parentId: 'o0' }
        d.objects.o8 = { id: 'o8', name: 'N8', parentId: 'p' }
        delete d.objects.o4
      }))
      expect(multi).toEqual([{
        generation: expect.any(Number), upsertIds: ['o0', 'o2', 'o5', 'o8', 'o9', 'p'], deleteIds: ['o4'],
      }])
      // A field that lives only in `data` (no column of its own), edited while
      // o8 sits under the cross-shard `p`: exactly o7 — not `p` again, whose
      // row did not move.
      const described = await objectsEventsOf(() => os0.change((d: Shard) => { d.objects.o7.description = 'd' }))
      expect(described).toEqual([{ generation: expect.any(Number), upsertIds: ['o7'], deleteIds: [] }])
      // And the child LEAVING moves the other parent's count back.
      const moved = await objectsEventsOf(() => os0.change((d: Shard) => { delete d.objects.o8.parentId }))
      expect(moved).toEqual([{ generation: expect.any(Number), upsertIds: ['o8', 'p'], deleteIds: [] }])
      // A deleted parent moves its children's served parent (effective parent
      // → root) without touching their `data`. o0 then dangles as a parent
      // named by o1/o9 — a candidate with no row on either side, never listed.
      const orphaned = await objectsEventsOf(() => os0.change((d: Shard) => { delete d.objects.o0 }))
      expect(orphaned).toEqual([{ generation: expect.any(Number), upsertIds: ['o1', 'o9'], deleteIds: ['o0'] }])

      // A shared id whose row another shard last wrote: os0 now writes `x`
      // (unchanged in os0's own eyes) over os1's value, so the served row
      // changes and the feed must say so. A diff against os0's previous
      // snapshot would not list `x`, and a cache would keep `overlay`.
      await objectsEventsOf(() => os0.change((d: Shard) => { d.objects.x = { id: 'x', name: 'base' } }))
      await objectsEventsOf(() => os1.change((d: Shard) => { d.objects.x.name = 'overlay2' }))
      // "Listed iff its served row changed" — NOT which shard should win: the
      // ordinary path's last-shard-written-wins is its own (pre-existing)
      // question, and this arm must not pin an answer to it.
      const servedX = async () => JSON.stringify((await roObjectCacheByIds(pool!, WS, ['x'])).items)
      const xBefore = await servedX()
      const shared = await objectsEventsOf(() => os0.change((d: Shard) => { d.objects.o6.name = 'six' }))
      const xMoved = (await servedX()) !== xBefore
      // Today it does move; if precedence is ever fixed this arm keeps its
      // meaning and only the vacuity guard below needs a new fixture.
      expect(xMoved, 'fixture no longer moves the shared row; the arm would be vacuous').toBe(true)
      expect(shared).toEqual([{ generation: expect.any(Number), upsertIds: ['o6', 'x'], deleteIds: [] }])

      // A shard attached after boot goes through the initial apply, the other
      // writer of this feed: its new rows, and the parent they land under.
      const os2 = repo.create({ objects: { n1: { id: 'n1', name: 'new' }, n2: { id: 'n2', name: 'new', parentId: 'p' } } })
      await os2.whenReady()
      const attached = await objectsEventsOf(() => meta.change((d: { objectShardUrls: string[] }) => {
        d.objectShardUrls.push(os2.url)
      }))
      // Two generations: the metadata pass itself, which moved no served row
      // (it used to publish reset/all here), then the attach.
      expect(attached).toEqual([
        { generation: expect.any(Number), upsertIds: [], deleteIds: [] },
        { generation: expect.any(Number), upsertIds: ['n1', 'n2', 'p'], deleteIds: [] },
      ])

      // A parent deleted from ITS shard re-roots a child living in ANOTHER one:
      // `n2`'s served parent moves although no shard naming `n2` changed. The
      // old whole-shard listing never named it either; it only got refreshed by
      // luck on os2's next edit, which a precise feed no longer provides.
      expect((await roObjectCacheByIds(pool!, WS, ['n2'])).items[0]?.parentId).toBe('p')
      const xBeforeReRoot = await servedX()
      const reRooted = await objectsEventsOf(() => os1.change((d: Shard) => { delete d.objects.p }))
      expect((await roObjectCacheByIds(pool!, WS, ['n2'])).items[0]?.parentId).toBeNull()
      // os1 also re-writes its own `x` over the row os0 last wrote — the shared
      // row moves again, so it is listed again (same rule as the shared arm).
      expect(await servedX(), 'x must have moved for it to be expected below').not.toBe(xBeforeReRoot)
      expect(reRooted).toEqual([{ generation: expect.any(Number), upsertIds: ['n2', 'x'], deleteIds: ['p'] }])

      // Past the by-ids endpoint's 500: a model shard holds up to 512, and the
      // digest must see every one of them, the last included.
      const big: Record<string, unknown> = {}
      for (let index = 0; index < 520; index += 1) {
        const id = `b${String(index).padStart(3, '0')}`
        big[id] = { id, name: id }
      }
      const os3 = repo.create({ objects: big })
      await os3.whenReady()
      const bigAttached = await objectsEventsOf(() => meta.change((d: { objectShardUrls: string[] }) => {
        d.objectShardUrls.push(os3.url)
      }))
      // [0] is the metadata pass, which moved nothing; [1] the attach.
      expect(bigAttached.map((event) => event.upsertIds.length)).toEqual([0, 520])
      const lastRenamed = await objectsEventsOf(() => os3.change((d: Shard) => { d.objects.b519.name = 'last' }))
      expect(lastRenamed).toEqual([{ generation: expect.any(Number), upsertIds: ['b519'], deleteIds: [] }])
    } finally {
      stop()
    }
  }, 60_000)

  it('publishes what each pass moved — connections, groups, tombstones, flows, registry — and no blanket reset', async () => {
    // Measured 2026-10-16 before this: a connection-label edit listed every
    // connection of its shard, and the metadata (a Structurizr system rename
    // renames its boundary group), flow (EVERY change of a diagram document,
    // a drag included) and registry passes each published reset/all — which
    // makes an inline expansion re-read and an offline copy re-download.
    type Stored = { kind: string; payload: Record<string, unknown> }
    // Order within a list is not part of the contract.
    const sortedIds = (value: unknown): unknown => Array.isArray(value)
      ? [...value].sort()
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([field, inner]) => [field, sortedIds(inner)]))
        : value
    const eventsAfter = async (generation: number): Promise<Stored[]> => (await pool!.query<{
      change_kind: string; payload: Record<string, unknown>
    }>(
      `SELECT change_kind, payload FROM read_model_change_events
       WHERE landscape_id = $1 AND version_id = $2 AND generation > $3 ORDER BY generation`,
      [WS.landscapeId, WS.versionId, generation],
    )).rows.map((row) => ({ kind: row.change_kind, payload: sortedIds(row.payload) as Record<string, unknown> }))
    const eventsOf = async (edit: () => void): Promise<Stored[]> => {
      const baseline = await projectedGeneration()
      edit()
      await until(() => eventsAfter(baseline), (events) => events.length > 0)
      await until(
        async () => (await pool!.query<{ observed: number; projected: number }>(
          `SELECT observed_generation::int AS observed, projected_generation::int AS projected
           FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
          [WS.landscapeId, WS.versionId],
        )).rows[0],
        (value) => value.observed === value.projected,
      )
      await new Promise((resolve) => setTimeout(resolve, 150))
      return eventsAfter(baseline)
    }
    const ids = (upsertIds: string[], deleteIds: string[] = []) => ({ upsertIds, deleteIds })

    const repo = new Repo({})
    // `a` sits under `p` structurally, but its group takes precedence: `p` is
    // nobody's effective parent until `a` leaves the group.
    const os0 = repo.create({ objects: {
      a: { id: 'a', name: 'A', parentId: 'p' }, b: { id: 'b', name: 'B' }, p: { id: 'p', name: 'P' },
    } })
    const cs0 = repo.create({ connections: {
      c0: { id: 'c0', fromId: 'a', toId: 'b', label: 'L' }, c1: { id: 'c1', fromId: 'b', toId: 'a', label: 'M' },
    } })
    const doc1 = repo.create({ layouts: {}, comments: {}, flows: { f1: { id: 'f1', steps: [{ connectionId: 'c0' }] } } })
    const registry = repo.create({ diagrams: { d1: {
      id: 'd1', name: 'D', docUrl: doc1.url, objectIds: ['a', 'b'], connectionIds: ['c0'],
    } } })
    const meta = repo.create({
      objectShardUrls: [os0.url], connectionShardUrls: [cs0.url],
      groups: { g1: { id: 'g1', name: 'G', objectIds: ['a'] } },
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([os0, cs0, doc1, registry, meta, root].map((h) => h.whenReady()))
    type Meta = {
      groups: Record<string, { id: string; name: string; objectIds: string[] }>
      deletedObjectIds?: string[]; deletedConnectionIds?: string[]
    }
    type Doc = { layouts: Record<string, unknown>; flows: Record<string, { id: string; steps: { connectionId: string }[] }> }
    type Registry = { diagrams: Record<string, { name: string; connectionIds: string[] }> }

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      // The diagram document attaches AFTER boot returns, and its first flow
      // projection is a generation of its own (c0's flow_count 0 -> 1): let it
      // land before any arm takes its baseline.
      await until(async () => (await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ro_connection_flows WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId],
      )).rows[0]!.n, (n) => n === 1)
      await until(
        async () => (await pool!.query<{ observed: number; projected: number }>(
          `SELECT observed_generation::int AS observed, projected_generation::int AS projected
           FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
          [WS.landscapeId, WS.versionId],
        )).rows[0],
        (value) => value.observed === value.projected,
      )
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Connection shard: one label, one id.
      expect(await eventsOf(() => cs0.change((d: { connections: Record<string, { label: string }> }) => {
        d.connections.c0.label = 'L2'
      }))).toEqual([{ kind: 'connections', payload: ids(['c0']) }])

      // ModelMeta, a group renamed: the group, and nothing else.
      expect(await eventsOf(() => meta.change((d: Meta) => { d.groups.g1.name = 'G2' })))
        .toEqual([{ kind: 'objects', payload: ids(['g1']) }])
      // A member joins: its served parent becomes the group, the group's count moves.
      expect(await eventsOf(() => meta.change((d: Meta) => { d.groups.g1.objectIds.push('b') })))
        .toEqual([{ kind: 'objects', payload: ids(['b', 'g1']) }])
      // A member LEAVES: it falls back to its structural parent, whose count
      // rises — a parent that was nobody's effective parent before the write.
      expect(await eventsOf(() => meta.change((d: Meta) => { d.groups.g1.objectIds.splice(0, 1) })))
        .toEqual([{ kind: 'objects', payload: ids(['a', 'g1', 'p']) }])

      // The diagram document, layout only: the flow pass runs and moves nothing.
      expect(await eventsOf(() => doc1.change((d: Doc) => { d.layouts.a = { x: 1, y: 2 } })))
        .toEqual([{ kind: 'connections', payload: ids([]) }])
      // A flow now walks c1: its served flow_count moves, c0's does not.
      expect(await eventsOf(() => doc1.change((d: Doc) => {
        d.flows.f2 = { id: 'f2', steps: [{ connectionId: 'c1' }] }
      }))).toEqual([{ kind: 'connections', payload: ids(['c1']) }])

      // The registry, c1 added to d1: its manifest and c1's diagram_count. Two
      // kinds, so stored as reset/all — what an older reader rebuilds from —
      // carrying the exact lists a current one applies.
      expect(await eventsOf(() => registry.change((d: Registry) => { d.diagrams.d1.connectionIds.push('c1') })))
        .toEqual([{ kind: 'reset', payload: { scope: 'all', exact: { diagrams: ids(['d1']), connections: ids(['c1']) } } }])
      // The registry, a rename: a manifest is references only — nothing served moved.
      expect(await eventsOf(() => registry.change((d: Registry) => { d.diagrams.d1.name = 'D2' })))
        .toEqual([{ kind: 'objects', payload: ids([]) }])

      // Tombstones, both families at once: b's row goes (and g1's count with
      // it), c0's row goes — and d1's manifest, which listed both.
      expect(await eventsOf(() => meta.change((d: Meta) => {
        d.deletedObjectIds = ['b']
        d.deletedConnectionIds = ['c0']
      }))).toEqual([{ kind: 'reset', payload: { scope: 'all', exact: {
        objects: ids(['g1'], ['b']), connections: ids([], ['c0']), diagrams: ids(['d1']),
      } } }])

      // Shard deletes move manifests too: c1 leaves its shard (d1 lists it),
      // then `a` leaves its shard (d1 lists it; `p` loses its only child).
      // The shard pass also re-writes c0, which the tombstone above deleted
      // but which is still IN this shard: its row comes back, and the feed
      // says so (the tombstone/shard precedence is not this change's to settle).
      expect(await eventsOf(() => cs0.change((d: { connections: Record<string, unknown> }) => {
        delete d.connections.c1
      }))).toEqual([{ kind: 'reset', payload: { scope: 'all', exact: {
        connections: ids(['c0'], ['c1']), diagrams: ids(['d1']),
      } } }])
      // Same for b: tombstoned above, still in os0, so this os0 pass brings it back.
      expect(await eventsOf(() => os0.change((d: { objects: Record<string, unknown> }) => {
        delete d.objects.a
      }))).toEqual([{ kind: 'reset', payload: { scope: 'all', exact: {
        objects: ids(['b', 'p'], ['a']), diagrams: ids(['d1']),
      } } }])
    } finally {
      stop()
    }
  }, 60_000)

  it('names the side each candidate list exists for: deletes, removals, leavers, new and gone rows', async () => {
    // Lifted from the QA lens battery (2026-10-16): each arm below killed a
    // mutant that dropped ONE source of candidates and left every other test
    // green — the BEFORE side of a flow, previous members, previous groups,
    // registry ids before AND after, a manifest's groupIds, flow_count alone.
    type Stored = { kind: string; payload: Record<string, unknown> }
    const sortedIds = (value: unknown): unknown => Array.isArray(value)
      ? [...value].sort()
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([field, inner]) => [field, sortedIds(inner)]))
        : value
    const eventsAfter = async (generation: number): Promise<Stored[]> => (await pool!.query<{
      change_kind: string; payload: Record<string, unknown>
    }>(
      `SELECT change_kind, payload FROM read_model_change_events
       WHERE landscape_id = $1 AND version_id = $2 AND generation > $3 ORDER BY generation`,
      [WS.landscapeId, WS.versionId, generation],
    )).rows.map((row) => ({ kind: row.change_kind, payload: sortedIds(row.payload) as Record<string, unknown> }))
    const settle = async () => {
      await until(
        async () => (await pool!.query<{ observed: number; projected: number }>(
          `SELECT observed_generation::int AS observed, projected_generation::int AS projected
           FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
          [WS.landscapeId, WS.versionId],
        )).rows[0],
        (value) => value.observed === value.projected,
      )
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const eventsOf = async (edit: () => void, minEvents = 1): Promise<Stored[]> => {
      const baseline = await projectedGeneration()
      edit()
      await until(() => eventsAfter(baseline), (events) => events.length >= minEvents, 8000)
      await settle()
      return eventsAfter(baseline)
    }
    const ids = (upsertIds: string[], deleteIds: string[] = []) => ({ upsertIds, deleteIds })

    const repo = new Repo({})
    const os0 = repo.create({ objects: {
      a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' }, x: { id: 'x', name: 'X' },
    } })
    const cs0 = repo.create({ connections: {
      c0: { id: 'c0', fromId: 'a', toId: 'b', label: 'L' },
      c1: { id: 'c1', fromId: 'b', toId: 'a', label: 'M' },
      c5: { id: 'c5', fromId: 'a', toId: 'x', label: 'N' },
      c7: { id: 'c7', fromId: 'a', toId: 'b', label: 'O' },
    } })
    const doc1 = repo.create({ layouts: {}, comments: {}, flows: {
      f1: { id: 'f1', steps: [{ connectionId: 'c0' }] }, f2: { id: 'f2', steps: [{ connectionId: 'c1' }] },
    } })
    // dX's flow walks c5, which is in NO diagram's connectionIds: c5's
    // diagram_count is 0 throughout, only its flow_count can move.
    const docX = repo.create({ layouts: {}, comments: {}, flows: { fx: { id: 'fx', steps: [{ connectionId: 'c5' }] } } })
    // dY walks c5 too: removing dX moves c5's flow_count 2 -> 1, never to absent.
    const docY = repo.create({ layouts: {}, comments: {}, flows: { fy: { id: 'fy', steps: [{ connectionId: 'c5' }] } } })
    const registry = repo.create({ diagrams: {
      d1: { id: 'd1', name: 'D', docUrl: doc1.url, objectIds: ['a', 'b'], connectionIds: ['c0', 'c1'] },
      dX: { id: 'dX', name: 'DX', docUrl: docX.url, objectIds: ['a'], connectionIds: [] },
      dY: { id: 'dY', name: 'DY', docUrl: docY.url, objectIds: ['a'], connectionIds: [] },
    } })
    const meta = repo.create({
      objectShardUrls: [os0.url], connectionShardUrls: [cs0.url],
      groups: { g1: { id: 'g1', name: 'G', objectIds: ['a', 'b'] } },
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([os0, cs0, doc1, docX, docY, registry, meta, root].map((h) => h.whenReady()))
    type Meta = {
      groups: Record<string, { id: string; name: string; objectIds: string[] }>
      deletedObjectIds?: string[]; deletedConnectionIds?: string[]
      connectionShardUrls: string[]
    }
    type Doc = { flows: Record<string, unknown> }
    type Registry = { diagrams: Record<string, Record<string, unknown>> }

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      await until(async () => (await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ro_connection_flows WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId],
      )).rows[0]!.n, (n) => n === 4, 8000)
      await settle()

      // D9: a connection deleted from its shard.
      expect(await eventsOf(() => cs0.change((d: { connections: Record<string, unknown> }) => {
        delete d.connections.c7
      }))).toEqual([{ kind: 'connections', payload: ids([], ['c7']) }])

      // D8: a flow removed — only the BEFORE side names c0.
      expect(await eventsOf(() => doc1.change((d: Doc) => { delete d.flows.f1 })))
        .toEqual([{ kind: 'connections', payload: ids(['c0']) }])

      // D4b: a member LEAVES a group — only the previous membership names b.
      expect(await eventsOf(() => meta.change((d: Meta) => { d.groups.g1.objectIds.splice(1, 1) })))
        .toEqual([{ kind: 'objects', payload: ids(['b', 'g1']) }])

      // D5: a tombstoned object in no group, with no parent, no children.
      expect(await eventsOf(() => meta.change((d: Meta) => { d.deletedObjectIds = ['x'] })))
        .toEqual([{ kind: 'objects', payload: ids([], ['x']) }])

      // D7: a NEW empty group — only the current groups name it.
      expect(await eventsOf(() => meta.change((d: Meta) => { d.groups.g2 = { id: 'g2', name: 'G2', objectIds: [] } })))
        .toEqual([{ kind: 'objects', payload: ids(['g2']) }])

      // D4a: an empty group DELETED — only the previous groups name it.
      expect(await eventsOf(() => meta.change((d: Meta) => { delete d.groups.g2 })))
        .toEqual([{ kind: 'objects', payload: ids([], ['g2']) }])

      // D1 + D3: a diagram removed from the registry: its manifest goes, and
      // c5's flow_count (its only moving column) drops.
      expect(await eventsOf(() => registry.change((d: Registry) => { delete d.diagrams.dX })))
        .toEqual([{ kind: 'reset', payload: { scope: 'all', exact: { diagrams: ids([], ['dX']), connections: ids(['c5']) } } }])

      // D2: a diagram ADDED to the registry.
      expect(await eventsOf(() => registry.change((d: Registry) => {
        d.diagrams.d3 = { id: 'd3', name: 'D3', objectIds: ['a'], connectionIds: ['c0'] }
      }))).toEqual([{ kind: 'reset', payload: { scope: 'all', exact: { diagrams: ids(['d3']), connections: ids(['c0']) } } }])

      // D13: a manifest's groupIds move.
      expect(await eventsOf(() => registry.change((d: Registry) => { d.diagrams.d1.groupIds = ['g1'] })))
        .toEqual([{ kind: 'reset', payload: { scope: 'all', exact: { diagrams: ids(['d1']) } } }])

      // D14: the by-ids endpoint serves what the digest digested.
      const served = await roDiagramCacheByIds(pool!, WS, ['d1', 'd3', 'dX'])
      expect(served.items).toEqual([
        { diagramId: 'd1', objectIds: ['a', 'b'], connectionIds: ['c0', 'c1'], groupIds: ['g1'] },
        { diagramId: 'd3', objectIds: ['a'], connectionIds: ['c0'], groupIds: [] },
      ])

      // D10: a connection shard ATTACHED: the metadata pass (nothing served
      // moved), then the attach naming its new connection.
      const cs1 = repo.create({ connections: { c9: { id: 'c9', fromId: 'a', toId: 'b', label: 'Z' } } })
      await cs1.whenReady()
      expect(await eventsOf(() => meta.change((d: Meta) => { d.connectionShardUrls.push(cs1.url) }), 2))
        .toEqual([{ kind: 'objects', payload: ids([]) }, { kind: 'connections', payload: ids(['c9']) }])
    } finally {
      stop()
    }
  }, 90_000)

  it('seals a digest a REAL cold build can be verified against, and detects a row removed behind its back', async () => {
    // The seam nothing else covers. The unit tests drive the projector with a
    // fake database, and the integrity suite drives a real database with a fake
    // projector; only here do a real Automerge repo, the real projector and a
    // real PostgreSQL meet, which is the combination the guarantee is claimed on.
    const repo = new Repo({})
    const os0 = repo.create({ objects: { o0: { id: 'o0', name: 'A' }, o1: { id: 'o1', name: 'B' } } })
    const cs0 = repo.create({ connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o1' } } })
    const meta = repo.create({
      objectShardUrls: [os0.url], connectionShardUrls: [cs0.url], groups: { g1: { id: 'g1', name: 'G' } },
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([os0, cs0, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      const sealed = await verifyWorkspaceIntegrity(pool!, WS)
      expect(sealed.outcome).toBe('verified')
      expect(sealed.defectCount).toBe(0)
      expect(sealed.verdicts.filter((verdict) => verdict.outcome === 'match')).toHaveLength(4)

      // A row disappears without the projector's knowledge — a partial commit, a
      // stray DELETE, a restore that lost rows. No CRDT comparison sees this
      // without re-deriving both sides; one aggregate does.
      await pool!.query(
        'DELETE FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
        [WS.landscapeId, WS.versionId, 'o1'],
      )
      const broken = await verifyWorkspaceIntegrity(pool!, WS)
      expect(broken.outcome).toBe('mismatch')
      const objectVerdict = broken.verdicts.find((verdict) => verdict.kind === 'object')
      expect(objectVerdict?.expected?.n).toBe(2)
      expect(objectVerdict?.actual?.n).toBe(1)

      // And once the projector advances, the sealed digest is honestly reported
      // as un-comparable rather than as a match or as corruption.
      os0.change((doc: { objects: Record<string, unknown> }) => {
        doc.objects['o9'] = { id: 'o9', name: 'Z' }
      })
      await until(() => roObject(pool!, WS, 'o9'), (value) => !!value)
      const moved = await until(
        () => verifyWorkspaceIntegrity(pool!, WS),
        (report) => report.verdicts.find((verdict) => verdict.kind === 'object')?.outcome === 'not-verifiable',
      )
      expect(moved.verdicts.find((verdict) => verdict.kind === 'object')?.outcome).toBe('not-verifiable')
      expect(moved.outcome).not.toBe('mismatch')
      // The other half of the carry-forward contract, and the half that makes it
      // honest: an object-shard delta invalidates ONLY `object`. If it also
      // dragged the kinds it never touched to `not-verifiable`, one edit anywhere
      // would blind the whole feature.
      for (const kind of ['connection', 'group', 'diagram'] as const) {
        expect(moved.verdicts.find((verdict) => verdict.kind === kind)?.outcome, kind).toBe('match')
      }
    } finally {
      stop()
    }
  }, 30_000)

  it('is still verifiable after boot on a workspace that HAS diagram documents', async () => {
    // `reconcileDiagramDocs` runs at the end of every boot and projects one
    // `registry` generation per resolvable diagram document
    // (syncConnectionFlows). Every projection bumps the generation, so a
    // projection that neither re-seals nor carries the digests forward leaves
    // all four kinds dated to a generation the read model has already left —
    // once per diagram, before `startReadModelProjector` even returns.
    //
    // A fixture whose diagrams have no `docUrl` never attaches one and never
    // sees this, hence the diagram documents here.
    const repo = new Repo({})
    const diagramDoc = repo.create({ layouts: {}, comments: {}, flows: {} })
    const os0 = repo.create({ objects: { o0: { id: 'o0', name: 'A' } } })
    const registry = repo.create({
      diagrams: { d1: { id: 'd1', name: 'D', type: 'context', docUrl: diagramDoc.url } },
    })
    const meta = repo.create({ objectShardUrls: [os0.url], connectionShardUrls: [], groups: {} })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([diagramDoc, os0, registry, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      const report = await verifyWorkspaceIntegrity(pool!, WS)
      expect(report.outcome).toBe('verified')
      // Every kind, not just the ones the flow projection happened to leave
      // alone: syncConnectionFlows writes only ro_connection_flows.
      expect(report.verdicts.filter((verdict) => verdict.outcome === 'match')).toHaveLength(4)
    } finally {
      stop()
    }
  }, 30_000)

  it('never re-dates a seal that had ALREADY gone stale, even from an honest carry-forward', async () => {
    // The carry-forward mechanism's trap:
    //
    //   g=N   cold build seals object {n:1}
    //   g=N+1 an object-shard delta adds an id and correctly declines to re-seal
    //   g=N+2 an unrelated GROUP edit truthfully reports it touched no objects
    //
    // Carrying the object seal forward at g=N+2 re-dates the g=N digest onto rows
    // that have since gained an id, and a HEALTHY read model reports corruption.
    // `not-verifiable` is honest; a false `mismatch` reads as data loss and is
    // strictly worse than silence.
    const repo = new Repo({})
    const os0 = repo.create({ objects: { o0: { id: 'o0', name: 'A' } } })
    const meta = repo.create({
      objectShardUrls: [os0.url], connectionShardUrls: [], groups: { g1: { id: 'g1', name: 'G' } },
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([os0, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      expect((await verifyWorkspaceIntegrity(pool!, WS)).outcome).toBe('verified')

      os0.change((doc: { objects: Record<string, unknown> }) => {
        doc.objects['o1'] = { id: 'o1', name: 'B' }
      })
      await until(() => roObject(pool!, WS, 'o1'), (value) => !!value)
      const afterObjectEdit = await until(
        () => verifyWorkspaceIntegrity(pool!, WS),
        (report) => report.verdicts.find((v) => v.kind === 'object')?.outcome === 'not-verifiable',
      )
      expect(afterObjectEdit.outcome).not.toBe('mismatch')

      meta.change((doc: { groups: Record<string, unknown> }) => {
        doc.groups['g2'] = { id: 'g2', name: 'H' }
      })
      await until(() => roGroup(pool!, WS, 'g2'), (value) => !!value)
      // Give the metadata projection room to publish, then assert on the steady
      // state: the object seal must still be honest about being un-comparable.
      await new Promise((resolve) => setTimeout(resolve, 300))
      const afterGroupEdit = await verifyWorkspaceIntegrity(pool!, WS)
      expect(afterGroupEdit.verdicts.find((v) => v.kind === 'object')?.outcome).toBe('not-verifiable')
      expect(afterGroupEdit.outcome).not.toBe('mismatch')
      // …while the group seal, which WAS re-sealed by that same projection, is
      // comparable again. Both halves matter: one without the other is either a
      // false alarm or a dead feature.
      expect(afterGroupEdit.verdicts.find((v) => v.kind === 'group')?.outcome).toBe('match')
    } finally {
      stop()
    }
  }, 30_000)

  it('refuses to wipe a diagram\'s flows when its document resolves with no flows map', async () => {
    // `syncConnectionFlows` DELETEs every row for the diagram before
    // re-inserting, so an uninitialised diagram document could erase its flows
    // and report success — the same tolerance defect as the shard deltas, on a
    // path where empty documents occur in practice. ro_connection_flows carries
    // no digest, so nothing else would notice.
    const repo = new Repo({})
    const good = repo.create({
      layouts: {}, comments: {}, flows: { f1: { id: 'f1', steps: [{ connectionId: 'c0' }] } },
    })
    const registry = repo.create({ diagrams: { d1: { id: 'd1', name: 'D', docUrl: good.url } } })
    const meta = repo.create({ objectShardUrls: [], connectionShardUrls: [], groups: {} })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([good, registry, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      const rows = async () => (await pool!.query<{ count: string }>(
        'SELECT count(*) AS count FROM ro_connection_flows WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId],
      )).rows[0]!.count
      const projected = await until(rows, (count) => count === '1')
      expect(projected).toBe('1')

      // The document loses its flows map entirely — an uninitialised document,
      // not a user deleting every flow.
      good.change((doc: Record<string, unknown>) => { delete doc.flows })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await rows()).toBe('1')
    } finally {
      stop()
    }
  }, 30_000)

  it('records a defect for a shard document that resolves with no objects map', async () => {
    // `repo.create({})` reproduces the real-world condition — a document that is
    // perfectly resolvable and carries nothing — without needing a corrupted
    // storage row.
    const repo = new Repo({})
    const empty = repo.create({})
    const meta = repo.create({ objectShardUrls: [empty.url], connectionShardUrls: [], groups: {} })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([empty, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      const report = await verifyWorkspaceIntegrity(pool!, WS)
      expect(report.defectCount).toBe(1)
      expect(report.defectSummary).toContain('object-shard/document-uninitialised')
      // The read model is still internally consistent — it holds exactly what
      // was readable. Completeness and consistency are separate claims, and this
      // is precisely why the defect count cannot be derived from a comparison.
      expect(report.outcome).toBe('verified')
    } finally {
      stop()
    }
  }, 30_000)

  it('cold-builds a sharded model and then projects per-shard changes incrementally', async () => {
    const repo = new Repo({})
    const os0 = repo.create({ objects: { o0: { id: 'o0', name: 'A' }, o1: { id: 'o1', name: 'B' } } })
    const os1 = repo.create({ objects: { o2: { id: 'o2', name: 'C' } } })
    const cs0 = repo.create({ connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o1' } } })
    const meta = repo.create({ objectShardUrls: [os0.url, os1.url], connectionShardUrls: [cs0.url], groups: { g1: { id: 'g1', name: 'G' } } })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([os0, os1, cs0, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      const coldHealth = await pool!.query(
        `SELECT observed_generation::int, projected_generation::int, projector_attached
         FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId]
      )
      expect(coldHealth.rows).toEqual([{ observed_generation: 1, projected_generation: 1, projector_attached: true }])

      // Cold build landed all entities.
      expect((await roObject(pool!, WS, 'o0'))?.name).toBe('A')
      expect((await roObject(pool!, WS, 'o2'))?.name).toBe('C')
      expect((await roGroup(pool!, WS, 'g1'))?.name).toBe('G')
      expect(await roConnectionCount(pool!, WS, 'o0')).toBe(1)

      // A REAL run records arrival watermarks — for exactly the entity shard
      // documents and NOTHING else: root/meta/registry have no re-stamping
      // path, so stamping them once would turn any later write into a
      // PERMANENT exact refusal.
      const watermarks = await pool!.query<{ document_id: string }>(
        `SELECT document_id FROM read_model_document_watermarks
         WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId],
      )
      const stamped = new Set(watermarks.rows.map((row) => row.document_id))
      // The workspace key is shared across this suite's tests, so assert
      // MEMBERSHIP for this test's documents rather than the exact set.
      for (const handle of [os0, os1, cs0]) {
        expect(stamped.has(handle.documentId), `entity shard ${handle.documentId} must be stamped`).toBe(true)
      }
      for (const handle of [root, meta]) {
        expect(stamped.has(handle.documentId), 'root/meta must NOT be stamped (C2)').toBe(false)
      }

      // Add an object to shard os1 → incremental upsert.
      const flush = vi.spyOn(repo, 'flush')
      os1.change((d: { objects: Record<string, unknown> }) => {
        d.objects['o3'] = { id: 'o3', name: 'D' }
      })
      const o3 = await until(() => roObject(pool!, WS, 'o3'), (v) => !!v)
      expect(o3?.name).toBe('D')
      expect(flush).toHaveBeenCalledWith([os1.documentId])
      const caughtUp = await until(
        async () => (await pool!.query<{ observed: number; projected: number }>(
          `SELECT observed_generation::int AS observed, projected_generation::int AS projected
           FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
          [WS.landscapeId, WS.versionId]
        )).rows[0],
        (value) => value.observed >= 2 && value.observed === value.projected
      )
      expect(caughtUp.observed).toBe(caughtUp.projected)

      // Remove o1 from shard os0 → incremental delete.
      os0.change((d: { objects: Record<string, unknown> }) => {
        delete d.objects['o1']
      })
      const gone = await until(() => roObject(pool!, WS, 'o1'), (v) => v === undefined)
      expect(gone).toBeUndefined()

      // Add a connection shard member → adjacency reflects it.
      cs0.change((d: { connections: Record<string, unknown> }) => {
        d.connections['c1'] = { id: 'c1', fromId: 'o2', toId: 'o0' }
      })
      const deg = await until(() => roConnectionCount(pool!, WS, 'o0'), (v) => v === 2)
      expect(deg).toBe(2)
    } finally {
      stop()
      const detached = await until(
        async () => (await pool!.query<{ attached: boolean }>(
          `SELECT projector_attached AS attached FROM read_model_projection_state
           WHERE landscape_id = $1 AND version_id = $2`,
          [WS.landscapeId, WS.versionId]
        )).rows[0],
        (value) => value?.attached === false
      )
      expect(detached.attached).toBe(false)
    }
  })

  it('cold-builds a monolithic model (no shards)', async () => {
    const repo = new Repo({})
    const model = repo.create({
      objects: { o0: { id: 'o0', name: 'Mono' } },
      connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o0' } },
      groups: { g1: { id: 'g1', name: 'MG' } },
    })
    const root = repo.create({ modelUrl: model.url, shardUrls: [] })
    await Promise.all([model, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      expect((await roObject(pool!, WS, 'o0'))?.name).toBe('Mono')
      expect((await roGroup(pool!, WS, 'g1'))?.name).toBe('MG')
      expect(await roConnectionCount(pool!, WS, 'o0')).toBe(1) // self-loop once
    } finally {
      stop()
    }
  })

  it('keeps the read model available when a legacy diagram document is missing', async () => {
    const repo = new Repo({})
    const unavailableRepo = new Repo({})
    const unavailableDiagram = unavailableRepo.create({ flows: {} })
    const objectShard = repo.create({ objects: { o0: { id: 'o0', name: 'Still available' } } })
    const connectionShard = repo.create({ connections: {} })
    const meta = repo.create({
      objectShardUrls: [objectShard.url],
      connectionShardUrls: [connectionShard.url],
      groups: {},
    })
    const registry = repo.create({
      diagrams: {
        dMissing: {
          id: 'dMissing',
          name: 'Legacy diagram',
          docUrl: unavailableDiagram.url,
          objectIds: ['o0'],
        },
      },
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([objectShard, connectionShard, meta, registry, root].map((handle) => handle.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      expect((await roObject(pool!, WS, 'o0'))?.name).toBe('Still available')
      const projectedDiagram = await pool!.query<{ id: string }>(
        `SELECT id FROM ro_diagrams
         WHERE landscape_id = $1 AND version_id = $2 AND id = 'dMissing'`,
        [WS.landscapeId, WS.versionId],
      )
      expect(projectedDiagram.rows).toEqual([{ id: 'dMissing' }])

      // The missing leaf costs ONE queue entry and ONE shared wake timer for
      // the workspace — never a timer and an unbounded retry loop of its own.
      expect(documentRetryRegistry.snapshot()).toMatchObject({
        queues: 1,
        pendingDepth: 1,
        activeTimers: 1,
      })
      // A document that simply has not arrived is not a degradation: the rows
      // that exist are complete and consistent.
      const health = await pool!.query<{ degraded_since: Date | null }>(
        `SELECT degraded_since FROM read_model_projection_state
         WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId],
      )
      expect(health.rows[0]?.degraded_since ?? null).toBeNull()
    } finally {
      stop()
    }
    // Detaching the projector cancels every pending retry.
    expect(documentRetryRegistry.snapshot()).toMatchObject({ queues: 0, pendingDepth: 0, activeTimers: 0 })
  }, 30_000)
})
