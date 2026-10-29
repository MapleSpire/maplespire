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

import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import { readFileSync } from 'node:fs'
import { coldBuildReadModel, deleteGroups, deleteObjects, syncGroups, upsertObjects, type WorkspaceKey } from './projector.js'
import { roViewerLevel } from './viewerLevel.js'
import {
  objectChangeWithCacheNeighbours,
  roObjectCacheByIds,
  roObjectCachePage,
  roObjectSearchPage,
  roObjectTreeChildren,
  servedObjectRowsChangedBy,
} from './objectExplorer.js'
import { backfillC4ParentIds, ensureReadModelSchema } from './schema.js'
import type { ObjectInput, GroupInput, ConnectionInput } from './types.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 3000 }), 'viewerLevel')
  try {
    const c = await p.connect()
    c.release()
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[viewerLevel] no Postgres at ${URL} — skipping DB tests`)

const WS: WorkspaceKey = { landscapeId: 'ws-viewer-level', versionId: 'v1' }
const EMPTY_WS: WorkspaceKey = { landscapeId: 'ws-viewer-level-empty', versionId: 'v1' }
const o = (id: string, over: Partial<ObjectInput> = {}): ObjectInput => ({ id, name: id, ...over })
const g = (id: string, over: Partial<GroupInput> = {}): GroupInput => ({ id, name: id, ...over })
const ids = (level: { objects: Array<{ object: { id?: unknown } }> }) => level.objects.map((item) => String(item.object.id))

/** The Model Viewer's level query, against the REAL read-model schema. The unit
 * test of this module only reads SQL text and fakes rows, which is how a query
 * that followed the explorer's group tree instead of the C4 hierarchy shipped:
 * an object inside a boundary group vanished from its level, and its parent
 * reported no children, so a drill-down the user could see in the diagrams was
 * impossible in the viewer. */
suite('model viewer level (Postgres integration, txn-isolated)', () => {
  let client: pg.PoolClient
  afterAll(async () => {
    await pool!.end()
  })
  beforeEach(async () => {
    client = await pool!.connect()
    await client.query('BEGIN')
  })
  afterEach(async () => {
    await client.query('ROLLBACK')
    client.release()
  })

  // A container diagram of System1 draws its boundary as a GROUP that contains
  // app1 — while app1's real (C4) parent is the System1 object.
  const build = () =>
    coldBuildReadModel(
      client,
      WS,
      null,
      [
        o('sys', { name: 'System1', type: 'system' }),
        o('actor', { name: 'Actor', type: 'actor' }),
        o('app1', { name: 'app1', type: 'app', parentId: 'sys' }),
        o('app2', { name: 'app2', type: 'app', parentId: 'sys' }),
        o('cmp', { name: 'cmp', type: 'component', parentId: 'app1' }),
      ],
      [],
      [g('boundary', { name: 'System1', objectIds: ['app1'] })],
    )

  it('lists the objects of a level by their C4 parent, groups notwithstanding', async () => {
    await build()
    const root = await roViewerLevel(client, WS, {})
    expect(ids(root)).toEqual(['actor', 'sys']) // by name; the grouped app1 is NOT a root
    expect(root.totalObjects).toBe(2)

    const system = await roViewerLevel(client, WS, { parentId: 'sys' })
    expect(ids(system)).toEqual(['app1', 'app2']) // app1 is in a group and still appears
    expect(system.totalObjects).toBe(2)
    expect(system.ancestors.map((a) => a.id)).toEqual(['sys'])
  })

  it('reports whether a tile expands from its C4 children, not its group membership', async () => {
    await build()
    const root = await roViewerLevel(client, WS, {})
    const count = (id: string) => root.objects.find((item) => item.object.id === id)?.childCount
    // EXISTENCE (0/1), not a count: sys has two children, app1 (grouped) + app2
    expect(count('sys')).toBe(1)
    expect(count('actor')).toBe(0)

    const system = await roViewerLevel(client, WS, { parentId: 'sys' })
    const inner = (id: string) => system.objects.find((item) => item.object.id === id)?.childCount
    expect(inner('app1')).toBe(1) // cmp
    expect(inner('app2')).toBe(0)
  })

  it('a DANGLING parent is a root, counted at the root and absent from the missing id', async () => {
    // `ghost` names a parent that is not in the model (deleted, or never
    // delivered); `orphanInGroup` is also inside a group, which must not matter.
    await coldBuildReadModel(
      client,
      WS,
      null,
      [
        o('sys', { type: 'system' }),
        o('orphan', { parentId: 'ghost' }),
        o('orphanInGroup', { parentId: 'ghost' }),
        o('orphanChild', { parentId: 'orphan' }),
      ],
      [],
      [g('boundary', { objectIds: ['orphanInGroup'] })],
    )
    const root = await roViewerLevel(client, WS, {})
    expect(ids(root)).toEqual(['orphan', 'orphanInGroup', 'sys'].sort())
    expect(root.totalObjects).toBe(3)
    expect(root.objects.find((item) => item.object.id === 'orphan')?.childCount).toBe(1)
    // the filtered total counts both dangling roots, and not orphanChild (a level down)
    const filtered = await roViewerLevel(client, WS, { query: 'orphan' })
    expect(ids(filtered)).toEqual(['orphan', 'orphanInGroup'])
    expect(filtered.totalObjects).toBe(2)

    const ghost = await roViewerLevel(client, WS, { parentId: 'ghost' })
    expect(ghost).toMatchObject({ objects: [], totalObjects: 0 })

    // ... and its own children still hang under it, ancestors stopping at it
    const below = await roViewerLevel(client, WS, { parentId: 'orphan' })
    expect(ids(below)).toEqual(['orphanChild'])
    expect(below.ancestors.map((a) => a.id)).toEqual(['orphan'])
  })

  it('follows the parent through delete, re-create and reparent (the delta path)', async () => {
    await coldBuildReadModel(client, WS, null, [
      o('sys', { type: 'system' }),
      o('other', { type: 'system' }),
      o('app', { parentId: 'sys' }),
    ], [])
    expect(ids(await roViewerLevel(client, WS, { parentId: 'sys' }))).toEqual(['app'])

    // deleting the parent makes the child a root — not an object at no level
    await deleteObjects(client, WS, ['sys'])
    expect(ids(await roViewerLevel(client, WS, {}))).toEqual(['app', 'other'])
    expect((await roViewerLevel(client, WS, {})).totalObjects).toBe(2)

    // re-creating it (an undo, a late shard) takes the child back
    await upsertObjects(client, WS, null, [o('sys', { type: 'system' })])
    expect(ids(await roViewerLevel(client, WS, {}))).toEqual(['other', 'sys'])
    expect(ids(await roViewerLevel(client, WS, { parentId: 'sys' }))).toEqual(['app'])

    // a reparent moves it, and the old parent stops expanding
    await upsertObjects(client, WS, null, [o('app', { parentId: 'other' })])
    expect(ids(await roViewerLevel(client, WS, { parentId: 'other' }))).toEqual(['app'])
    const root = await roViewerLevel(client, WS, {})
    expect(root.objects.find((item) => item.object.id === 'sys')?.childCount).toBe(0)
    expect(root.objects.find((item) => item.object.id === 'other')?.childCount).toBe(1)

    // a reparent onto a parent that does not exist makes it a root
    await upsertObjects(client, WS, null, [o('app', { parentId: 'nowhere' })])
    expect(ids(await roViewerLevel(client, WS, {}))).toEqual(['app', 'other', 'sys'])
  })

  it('a child delivered BEFORE its parent (separate shards) lands under it once the parent arrives', async () => {
    await coldBuildReadModel(client, WS, null, [o('early', { parentId: 'late' })], [])
    expect(ids(await roViewerLevel(client, WS, {}))).toEqual(['early'])
    await upsertObjects(client, WS, null, [o('late', { type: 'system' })])
    expect(ids(await roViewerLevel(client, WS, {}))).toEqual(['late'])
    expect(ids(await roViewerLevel(client, WS, { parentId: 'late' }))).toEqual(['early'])
  })

  it('group membership changes leave the C4 level alone', async () => {
    await build()
    // dissolving the boundary group, then adding a new one, moves nothing
    await deleteGroups(client, WS, ['boundary'])
    expect(ids(await roViewerLevel(client, WS, { parentId: 'sys' }))).toEqual(['app1', 'app2'])
    await syncGroups(client, WS, null, [g('another', { objectIds: ['app2', 'cmp'] })])
    expect(ids(await roViewerLevel(client, WS, { parentId: 'sys' }))).toEqual(['app1', 'app2'])
    expect(ids(await roViewerLevel(client, WS, { parentId: 'app1' }))).toEqual(['cmp'])
  })

  it('walks the ancestors along the C4 chain', async () => {
    await build()
    const component = await roViewerLevel(client, WS, { parentId: 'app1' })
    expect(ids(component)).toEqual(['cmp'])
    expect(component.ancestors.map((a) => a.id)).toEqual(['sys', 'app1']) // root first
  })

  it('answers an EMPTY level with an empty page, not an error', async () => {
    await build()
    // a childless object: the empty-page fallback statement used to receive five
    // bind parameters for a statement that mentions three — PG rejects the Bind
    const leaf = await roViewerLevel(client, WS, { parentId: 'app2' })
    expect(leaf).toMatchObject({ objects: [], connections: [], totalObjects: 0, nextCursor: null })
    expect(leaf.ancestors.map((a) => a.id)).toEqual(['sys', 'app2'])
    // ... and a workspace with no objects at all (a brand-new landscape)
    const brandNew = await roViewerLevel(client, EMPTY_WS, {})
    expect(brandNew).toMatchObject({ objects: [], totalObjects: 0, nextCursor: null })
    // ... and the filtered variants of both
    expect(await roViewerLevel(client, WS, { parentId: 'app2', query: 'zzz' })).toMatchObject({ objects: [], totalObjects: 0 })
    expect(await roViewerLevel(client, EMPTY_WS, { query: 'zzz' })).toMatchObject({ objects: [], totalObjects: 0 })
  })

  it('a group is not a level: its id is not a parent', async () => {
    await build()
    const level = await roViewerLevel(client, WS, { parentId: 'boundary' })
    expect(level.objects).toEqual([])
    expect(level.totalObjects).toBe(0)
  })

  it('filters and pages within a level', async () => {
    await build()
    const filtered = await roViewerLevel(client, WS, { parentId: 'sys', query: 'app2' })
    expect(ids(filtered)).toEqual(['app2'])
    expect(filtered.totalObjects).toBe(1)

    const first = await roViewerLevel(client, WS, { parentId: 'sys', limit: 1 })
    expect(ids(first)).toEqual(['app1'])
    expect(first.totalObjects).toBe(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await roViewerLevel(client, WS, { parentId: 'sys', limit: 1, after: first.nextCursor! })
    expect(ids(second)).toEqual(['app2'])
    expect(second.nextCursor).toBeNull()
  })

  it('pages by NAME, not id: names that sort differently from ids neither repeat nor skip', async () => {
    await coldBuildReadModel(client, WS, null, [
      o('zzz', { name: 'aaa' }),
      o('aaa', { name: 'bbb' }),
      o('mmm', { name: 'ccc' }),
    ], [])
    const first = await roViewerLevel(client, WS, { limit: 1 })
    const second = await roViewerLevel(client, WS, { limit: 1, after: first.nextCursor! })
    const third = await roViewerLevel(client, WS, { limit: 1, after: second.nextCursor! })
    expect([ids(first), ids(second), ids(third)]).toEqual([['zzz'], ['aaa'], ['mmm']])
    expect(third.nextCursor).toBeNull()
  })

  it('terminates on a parent cycle, with a bounded ancestor chain', async () => {
    await coldBuildReadModel(client, WS, null, [o('x', { parentId: 'y' }), o('y', { parentId: 'x' })], [])
    const level = await roViewerLevel(client, WS, { parentId: 'x' })
    expect(level.ancestors.length).toBeLessThanOrEqual(65)
    expect(level.ancestors.length).toBeGreaterThan(0)
  })

  it('draws only the direct, non-self connections whose two ends are both on the level', async () => {
    await coldBuildReadModel(
      client,
      WS,
      null,
      [
        o('sys', { type: 'system' }),
        o('a', { parentId: 'sys' }),
        o('b', { parentId: 'sys' }),
        o('c', { parentId: 'a' }), // one level down
      ],
      [
        { id: 'direct', fromId: 'a', toId: 'b', kind: 'direct' },
        { id: 'rollup', fromId: 'a', toId: 'b', kind: 'lower' }, // per-diagram artifact
        { id: 'self', fromId: 'a', toId: 'a' },
        { id: 'offlevel', fromId: 'a', toId: 'c' }, // c is not on this level
        { id: 'other-end', fromId: 'c', toId: 'b' },
      ],
    )
    const level = await roViewerLevel(client, WS, { parentId: 'sys' })
    expect(level.connections.map((conn) => conn.id)).toEqual(['direct'])
  })

  // The offline read-cache worker asserts these SAME levels from the same file
  // (src/workers/modelReadCache.viewerLevel.test.ts). This half pins the server
  // to them, and pins the explorer parents the worker is fed to what the
  // object cache page really serves.
  describe('parity fixture shared with the offline worker', () => {
    const fixture = JSON.parse(readFileSync(new globalThis.URL('./viewerLevelParity.fixture.json', import.meta.url), 'utf8')) as {
      objects: ObjectInput[]
      groups: GroupInput[]
      connections: ConnectionInput[]
      explorerParents: Record<string, string | null>
      c4Parents: Record<string, string | null>
      levels: Array<{
        parentId: string | null
        objects: Array<{ id: string; expands: boolean }>
        totalObjects: number
        ancestors: string[]
        connections: string[]
      }>
      pages: Array<{ parentId: string | null; limit: number; pages: string[][] }>
    }
    const buildFixture = () => coldBuildReadModel(client, WS, null, fixture.objects, fixture.connections, fixture.groups)

    it('serves the worker the explorer parents the fixture feeds it', async () => {
      await buildFixture()
      const page = await roObjectCachePage(client, WS, {})
      expect(page.nextCursor).toBeNull()
      expect(Object.fromEntries(page.items.map((item) => [item.id, item.parentId]))).toEqual(fixture.explorerParents)
      // ... and the C4 level parent the worker indexes: dangling repaired to
      // null (orphan, and ghost although it is in a group), groups ignored
      expect(Object.fromEntries(page.items.map((item) => [item.id, item.c4ParentId]))).toEqual(fixture.c4Parents)
      // the by-ids endpoint (the change feed's) serves the same field
      const byIds = await roObjectCacheByIds(client, WS, Object.keys(fixture.c4Parents))
      expect(Object.fromEntries(byIds.items.map((item) => [item.id, item.c4ParentId]))).toEqual(fixture.c4Parents)
      // ... and the payload still carries the raw C4 parent (older-feed fallback)
      for (const object of fixture.objects) {
        const item = page.items.find((candidate) => candidate.id === object.id)
        expect((item?.payload as { parentId?: string }).parentId).toBe(object.parentId)
      }
    })

    it('the explorer pages (the browser working set) carry the same c4ParentId', async () => {
      await buildFixture()
      const served: Record<string, string | null> = {}
      const collect = (items: Array<{ id: string; c4ParentId: string | null }>) => {
        for (const item of items) served[item.id] = item.c4ParentId
      }
      collect((await roObjectTreeChildren(client, WS, { limit: 200 })).items)
      for (const parentId of ['boundary', 'zone', 'hub-boundary', 'vault-boundary', 'ghost-zone', 'sys', 'app1', 'hub', 'vault']) {
        collect((await roObjectTreeChildren(client, WS, { parentId, limit: 200 })).items)
      }
      expect(served).toEqual(fixture.c4Parents)
      const search = await roObjectSearchPage(client, WS, { query: 'app', limit: 200 })
      for (const item of search.items) expect(item.c4ParentId).toBe(fixture.c4Parents[item.id])
      expect(search.items.length).toBeGreaterThan(0)
    })

    it('a publisher that names only the ids it wrote is widened to the children the write moves', async () => {
      // The static projector publishes { upsertIds: written, deleteIds } and
      // calls objectChangeWithCacheNeighbours before its write.
      await buildFixture()
      const widened = await objectChangeWithCacheNeighbours(client, WS, { kind: 'objects', upsertIds: [], deleteIds: ['sys'] })
      await deleteObjects(client, WS, ['sys'])
      expect(widened.deleteIds).toEqual(['sys'])
      expect(widened.upsertIds).toEqual(expect.arrayContaining(['app1', 'app2']))
      expect(widened.upsertIds).not.toContain('sys')
      // ... and those ids now serve the moved c4ParentId
      const rows = await roObjectCacheByIds(client, WS, widened.upsertIds)
      expect(rows.items.find((item) => item.id === 'app1')?.c4ParentId).toBeNull()
    })

    it('deleting a parent republishes its children with a root c4ParentId, so an offline cache follows', async () => {
      await buildFixture()
      // app1 is in a group, so its explorer parent stays the group: only the
      // c4 parent moves when sys goes — the field the change feed must carry
      const changes = await servedObjectRowsChangedBy(client, WS, ['sys'], () => deleteObjects(client, WS, ['sys']))
      expect(changes.deleteIds).toEqual(['sys'])
      expect(changes.upsertIds).toEqual(expect.arrayContaining(['app1', 'app2']))
      const rows = await roObjectCacheByIds(client, WS, ['app1', 'app2'])
      expect(Object.fromEntries(rows.items.map((item) => [item.id, [item.parentId, item.c4ParentId]])))
        .toEqual({ app1: ['boundary', null], app2: [null, null] })
      const root = await roViewerLevel(client, WS, {})
      expect(ids(root)).toEqual(expect.arrayContaining(['app1', 'app2']))
    })

    for (const expected of fixture.levels) {
      it(`level ${expected.parentId ?? '(root)'}`, async () => {
        await buildFixture()
        const level = await roViewerLevel(client, WS, { parentId: expected.parentId })
        expect(level.objects.map((item) => ({ id: String(item.object.id), expands: item.childCount > 0 })))
          .toEqual(expected.objects)
        expect(level.totalObjects).toBe(expected.totalObjects)
        expect(level.ancestors.map((a) => a.id)).toEqual(expected.ancestors)
        expect(level.connections.map((conn) => conn.id)).toEqual(expected.connections)
      })
    }

    for (const expected of fixture.pages) {
      it(`pages level ${expected.parentId ?? '(root)'} by ${expected.limit}`, async () => {
        await buildFixture()
        const pages: string[][] = []
        let after: string | null = null
        for (let index = 0; index < expected.pages.length + 1; index += 1) {
          const level = await roViewerLevel(client, WS, { parentId: expected.parentId, limit: expected.limit, after })
          pages.push(ids(level))
          after = level.nextCursor
          if (!after) break
        }
        expect(pages).toEqual(expected.pages)
      })
    }
  })
})

/** The upgrade path: rows written before `c4_parent_id` existed carry NULL in
 * it — every object would read as a root — until the one-time boot migration
 * runs. Own schema, because it drives `ensureReadModelSchema` (DDL) and
 * rewrites rows wholesale. */
suite('c4_parent_id backfill (isolated schema)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb
  const UP: WorkspaceKey = { landscapeId: 'ws-c4-backfill', versionId: 'v1' }
  // A second workspace, so "the migration repairs EVERY workspace" is pinned
  // (a QA mutant scoping it to one survived a single-workspace fixture).
  const UP2: WorkspaceKey = { landscapeId: 'ws-c4-backfill-2', versionId: 'v2' }
  const parentOf = async (key: WorkspaceKey = UP) => Object.fromEntries((await db.pool.query<{ id: string; c4_parent_id: string | null }>(
    `SELECT id, c4_parent_id FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id`,
    [key.landscapeId, key.versionId],
  )).rows.map((row) => [row.id, row.c4_parent_id]))
  // what a pre-column row looks like, plus a stale non-NULL value the backfill
  // must also correct (a dangling parent left pointing at its missing id)
  const regress = (key: WorkspaceKey = UP) => db.pool.query(
    `UPDATE ro_objects SET c4_parent_id = CASE id WHEN 'orphan' THEN 'ghost' ELSE NULL END
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(URL, 'viewer_c4_backfill')
    await ensureReadModelSchema(db.pool)
    for (const key of [UP, UP2]) {
      await coldBuildReadModel(db.pool, key, null, [
        o('sys', { type: 'system' }),
        o('app', { parentId: 'sys' }),
        o('cmp', { parentId: 'app' }),
        o('orphan', { parentId: 'ghost' }),
      ], [], [g('boundary', { objectIds: ['app'] })])
    }
  })
  afterAll(async () => {
    await db?.teardown()
  })

  const expected = { app: 'sys', cmp: 'app', orphan: null, sys: null }

  it('the projector writes it on a fresh schema', async () => {
    expect(await parentOf()).toEqual(expected)
  })

  it('creates the index that serves a level in page order', async () => {
    // Results do not depend on it (a QA mutant dropping it left every other
    // test green); the plan does — the 200 000-object EXPLAIN from
    // server/scripts/measure-viewer-level-c4.ts reads 201 rows of a
    // 6 021-root level off it, and sorts all of them without it.
    const { rows } = await db.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = 'idx_ro_objects_c4_name_c_page'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.indexdef).toContain(
      '(landscape_id, version_id, c4_parent_id, normalized_name COLLATE "C", id COLLATE "C")',
    )
  })

  it('the boot migration repairs pre-column and stale rows, once, atomically, after the baseline', async () => {
    const { schemaMigrations } = await import('../db/schemaMigrations.js')
    const migrations = schemaMigrations(db.pool)
    const entry = migrations.find((migration) => migration.id === '0005-ro-objects-c4-parent')
    expect(entry).toBeDefined()
    // run-once (a 200 000-row pass is not a per-boot cost), in a transaction
    // with its ledger row, and after the baseline that ADDs the column
    expect(entry!.repeatable).toBeFalsy()
    expect(entry!.transactional).not.toBe(false)
    expect(migrations.findIndex((migration) => migration.id === '0001-baseline'))
      .toBeLessThan(migrations.indexOf(entry!))

    await regress(UP)
    await regress(UP2)
    const client = await db.pool.connect()
    try {
      await entry!.run(client)
    } finally {
      client.release()
    }
    expect(await parentOf(UP)).toEqual(expected)
    expect(await parentOf(UP2)).toEqual(expected)
  })

  it('scoped to one workspace (the static per-attach repair), it touches no other', async () => {
    await regress(UP)
    await regress(UP2)
    await backfillC4ParentIds(db.pool, UP)
    expect(await parentOf(UP)).toEqual(expected)
    expect(await parentOf(UP2)).toEqual({ app: null, cmp: null, orphan: 'ghost', sys: null })
    await backfillC4ParentIds(db.pool)
    expect(await parentOf(UP2)).toEqual(expected)
  })

  it('writes ONLY the wrong rows, so a re-run on a consistent table rewrites nothing', async () => {
    const xmin = async () => Object.fromEntries((await db.pool.query<{ id: string; xmin: string }>(
      `SELECT id, xmin::text FROM ro_objects WHERE landscape_id = $1 AND version_id = $2`,
      [UP.landscapeId, UP.versionId],
    )).rows.map((row) => [row.id, row.xmin]))
    await backfillC4ParentIds(db.pool)
    const before = await xmin()
    // one stale row: a dangling parent left pointing at its missing id
    await db.pool.query(
      `UPDATE ro_objects SET c4_parent_id = 'ghost' WHERE landscape_id = $1 AND version_id = $2 AND id = 'orphan'`,
      [UP.landscapeId, UP.versionId],
    )
    await backfillC4ParentIds(db.pool)
    expect(await parentOf()).toEqual(expected)
    const after = await xmin()
    // app/cmp have a live parent, sys none: not one of them was rewritten
    expect({ app: after.app, cmp: after.cmp, sys: after.sys })
      .toEqual({ app: before.app, cmp: before.cmp, sys: before.sys })
    expect(after.orphan).not.toBe(before.orphan)
  })
})
