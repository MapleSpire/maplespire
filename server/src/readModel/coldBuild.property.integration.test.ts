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

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import pg from 'pg'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import {
  coldBuildReadModel, coldBuildReadModelByDeltas, parameterText, PG_PREPARE_VALUE, syncConnectionFlows,
  type WorkspaceKey,
} from './projector.js'
import { upsertDecisionRecords } from './derivedStats.js'
import { extractModelEntities, fullExtractionIntegrity } from './projectorService.js'
import { digestOfIds, digestSql, parseDigestRow, DIGEST_KINDS, type DigestKind } from './contentDigest.js'
import { READ_MODEL_PROTOCOL_SETTING, READ_MODEL_PROTOCOL_VERSION } from './protocolParticipant.js'
import { randomReadModelCorpus, type ReadModelCorpus } from '../testing/readModelCorpus.js'
import type { ConnectionInput, DiagramInput, GroupInput, ObjectInput } from './types.js'

/**
 * G4-16f C7: the bulk cold build (`coldBuildReadModel`) against the cold build
 * it replaced (`coldBuildReadModelByDeltas`) — every `ro_*` row of the
 * workspace, derived stats included, byte for byte (`to_jsonb(row)::text`,
 * `ro_workspace_stats.updated_at` aside: the transaction's `now()`), on
 * randomized corpora. Plus what the comparison alone cannot see: the derived
 * stats against an oracle computed here from the base rows (a stat both
 * paths dropped would compare equal), the integrity digests against the
 * ids, duplicate ids (dropped, last wins, reported, digested as written),
 * the known divergences of the by-deltas path, and the lock order (no
 * protocol write).
 *
 * Every build is followed by the flow projection (`syncConnectionFlows`, as
 * production runs it after a cold build — the cold build itself writes no
 * flow rows), and each corpus carries decision records (their own
 * projection, kept by the cold build and counted by it).
 *
 * Real PostgreSQL (DATABASE_URL); skips without one. Every test runs in a
 * transaction that is rolled back.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 3000 }), 'cold-build-property')
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
if (!pool) console.warn(`[readModel integration] no Postgres at ${URL} — skipping cold-build property tests`)

const WS: WorkspaceKey = { landscapeId: 'ws-cold-build-property', versionId: 'v1' }

type Build = typeof coldBuildReadModel | typeof coldBuildReadModelByDeltas
type Dump = Record<string, string[]>

suite('cold build: bulk path = by-deltas path (Postgres, txn-isolated)', () => {
  let client: pg.PoolClient
  let tables: string[] = []

  afterAll(async () => {
    await pool!.end()
  })
  beforeEach(async () => {
    client = await pool!.connect()
    await client.query('BEGIN')
    tables = (await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name LIKE 'ro\\_%' ORDER BY table_name`,
    )).rows.map((row) => row.table_name)
  })
  afterEach(async () => {
    await client.query('ROLLBACK')
    client.release()
  })

  /** Every `ro_*` table's rows of the workspace, each as its jsonb text,
   * sorted. */
  const dump = async (): Promise<Dump> => {
    const out: Dump = {}
    for (const table of tables) {
      const { rows } = await client.query<{ r: string }>(
        `SELECT (to_jsonb(t) - 'updated_at')::text AS r FROM ${table} t
         WHERE landscape_id = $1 AND version_id = $2 ORDER BY 1`,
        [WS.landscapeId, WS.versionId],
      )
      out[table] = rows.map((row) => row.r)
    }
    return out
  }
  const parsed = (d: Dump, table: string) => d[table].map((row) => JSON.parse(row) as Record<string, unknown>)
  const byId = (d: Dump, table: string) => new Map(parsed(d, table).map((row) => [row.id, row]))

  /** A cold build, then the flow projection of every diagram's flows. */
  const build = async (path: Build, corpus: ReadModelCorpus, orgId: string | null = 'org-1') => {
    const result = await path(client, WS, orgId, corpus.objects, corpus.connections, corpus.groups, corpus.diagrams)
    for (const { diagramId, flows } of corpus.flows ?? []) {
      await syncConnectionFlows(client, WS, orgId, diagramId, flows, true)
    }
    return result
  }

  /** `ids` ordered by the database's default collation — the order of the
   * `ORDER BY object_id` the preview rule uses (the column has no COLLATE). */
  const databaseOrder = async (ids: readonly string[]): Promise<string[]> =>
    (await client.query<{ ids: string[] }>(
      `SELECT coalesce(array_agg(id ORDER BY id), '{}') AS ids FROM unnest($1::text[]) AS id`, [ids],
    )).rows[0]!.ids

  /** The derived stats recomputed HERE from the base rows of `d`. */
  const expectDerivedStatsHold = async (d: Dump, orgId: string | null) => {
    const objects = parsed(d, 'ro_objects')
    const children = new Map<string, number>()
    for (const object of objects) {
      const parent = object.effective_parent_id as string | null
      if (parent !== null) children.set(parent, (children.get(parent) ?? 0) + 1)
    }
    expect(new Map(parsed(d, 'ro_object_child_stats').map((row) => [row.object_id, row.child_count])), 'child stats').toEqual(children)

    const [stats] = parsed(d, 'ro_workspace_stats')
    expect(stats, 'workspace stats row').toBeDefined()
    expect({
      org_id: stats.org_id,
      object_count: Number(stats.object_count), connection_count: Number(stats.connection_count),
      group_count: Number(stats.group_count), diagram_count: Number(stats.diagram_count),
      root_object_count: Number(stats.root_object_count), decision_record_count: Number(stats.decision_record_count),
    }, 'workspace counts').toEqual({
      // The cold build deleted the row, so COALESCE has nothing to keep:
      // the org is the one passed.
      org_id: orgId,
      object_count: objects.length, connection_count: d.ro_connections.length,
      group_count: d.ro_groups.length, diagram_count: d.ro_diagrams.length,
      root_object_count: objects.filter((object) => object.effective_parent_id === null).length,
      decision_record_count: d.ro_decision_records.length,
    })

    const countBy = (table: string, column: string) => {
      const counts = new Map<string, number>()
      for (const row of parsed(d, table)) counts.set(row[column] as string, (counts.get(row[column] as string) ?? 0) + 1)
      return counts
    }
    const diagramObjects = countBy('ro_diagram_objects', 'diagram_id')
    const diagramGroups = countBy('ro_diagram_groups', 'diagram_id')
    const diagramConnections = countBy('ro_diagram_connections', 'diagram_id')
    const membersOf = new Map<string, string[]>()
    for (const row of parsed(d, 'ro_diagram_objects')) {
      membersOf.set(row.diagram_id as string, [...(membersOf.get(row.diagram_id as string) ?? []), row.object_id as string])
    }
    const objectRows = byId(d, 'ro_objects')
    const summaries = new Map(parsed(d, 'ro_diagram_summaries').map((row) => [row.diagram_id, row]))
    expect([...summaries.keys()].sort(), 'one summary per diagram').toEqual(parsed(d, 'ro_diagrams').map((row) => row.id).sort())
    for (const [id, summary] of summaries) {
      expect([summary.object_count, summary.group_count, summary.connection_count], `summary ${id}`)
        .toEqual([diagramObjects.get(id as string) ?? 0, diagramGroups.get(id as string) ?? 0, diagramConnections.get(id as string) ?? 0])
      // THE PREVIEW RULE: the 12 smallest member ids (database order), and
      // each one's type ('' for a member that is not an object).
      const preview = (await databaseOrder(membersOf.get(id as string) ?? [])).slice(0, 12)
      expect(summary.preview_object_ids, `preview ids ${id}`).toEqual(preview)
      expect(summary.preview_object_types, `preview types ${id}`)
        .toEqual(preview.map((member) => (objectRows.get(member)?.type as string | null | undefined) ?? ''))
    }

    const groupRows = byId(d, 'ro_groups')
    const connectionStats = new Map(parsed(d, 'ro_connection_stats').map((row) => [row.connection_id, row]))
    const memberships = countBy('ro_diagram_connections', 'connection_id')
    const flowsOf = new Map<string, Set<string>>()
    for (const row of parsed(d, 'ro_connection_flows')) {
      const flows = flowsOf.get(row.connection_id as string) ?? new Set<string>()
      flows.add(JSON.stringify([row.diagram_id, row.flow_id]))
      flowsOf.set(row.connection_id as string, flows)
    }
    expect([...connectionStats.keys()].sort(), 'one stat per connection').toEqual(parsed(d, 'ro_connections').map((row) => row.id).sort())
    for (const connection of parsed(d, 'ro_connections')) {
      const stat = connectionStats.get(connection.id)!
      const endpoint = (id: string) => objectRows.get(id)?.name ?? groupRows.get(id)?.name ?? ''
      const endpointType = (id: string) => objectRows.get(id)?.type ?? (groupRows.has(id) ? 'group' : null)
      expect([stat.diagram_count, stat.flow_count, stat.from_name, stat.to_name, stat.from_type, stat.to_type], `stat ${connection.id}`)
        .toEqual([memberships.get(connection.id as string) ?? 0, flowsOf.get(connection.id as string)?.size ?? 0,
          endpoint(connection.from_id as string), endpoint(connection.to_id as string),
          endpointType(connection.from_id as string), endpointType(connection.to_id as string)])
    }
    return { flowCounts: [...connectionStats.values()].map((stat) => stat.flow_count as number) }
  }

  /** The integrity digests (`digestSql`, what a verifier recomputes from the
   * rows) equal `expected` per kind. */
  const expectDigests = async (expected: Record<DigestKind, unknown>) => {
    for (const kind of DIGEST_KINDS) {
      const { rows } = await client.query<{ n: string; x: string }>(digestSql(kind), [WS.landscapeId, WS.versionId])
      expect(parseDigestRow(rows[0]), `${kind} digest`).toEqual(expected[kind])
    }
  }
  const expectDigestsMatchIds = (corpus: ReadModelCorpus) => expectDigests({
    object: digestOfIds(corpus.objects.map((o) => o.id)), connection: digestOfIds(corpus.connections.map((c) => c.id)),
    group: digestOfIds(corpus.groups.map((g) => g.id)), diagram: digestOfIds(corpus.diagrams.map((d) => d.id)),
  })

  const expectPathsAgree = async (corpus: ReadModelCorpus, orgId: string | null = 'org-1') => {
    if (corpus.decisionRecords?.length) await upsertDecisionRecords(client, WS, orgId, corpus.decisionRecords)
    await build(coldBuildReadModel, corpus, orgId)
    const bulk = await dump()
    await build(coldBuildReadModelByDeltas, corpus, orgId)
    const byDeltas = await dump()
    // Table by table, so a failure names the table.
    for (const table of tables) expect(bulk[table], table).toEqual(byDeltas[table])
    // CONTROL: the corpus reached every table it can reach — a comparison
    // of two empty dumps proves nothing.
    expect(byDeltas.ro_objects.length).toBe(corpus.objects.length)
    const derived = await expectDerivedStatsHold(bulk, orgId)
    await expectDigestsMatchIds(corpus)
    // And the bulk path over the by-deltas rows (a rebuild, not a first
    // build): the same rows again.
    await build(coldBuildReadModel, corpus, orgId)
    expect(await dump()).toEqual(byDeltas)
    return { bulk, derived }
  }

  it('randomized corpora: every ro_* row, derived stats and digests identical', async () => {
    const shapes = [
      { objects: 0, connections: 0, groups: 0, diagrams: 0 },
      { objects: 1, connections: 1, groups: 1, diagrams: 1 },
      { objects: 60, connections: 40, groups: 8, diagrams: 6 },
      { objects: 400, connections: 300, groups: 30, diagrams: 25 },
      { objects: 900, connections: 150, groups: 0, diagrams: 0, postingShare: 0.9 },
    ]
    let seed = 1
    const reached = new Set<string>()
    let nonZeroFlowCounts = 0
    let previewsOverTwelve = 0
    for (const shape of shapes) {
      for (let repeat = 0; repeat < 3; repeat++) {
        const corpus = randomReadModelCorpus(seed++, shape)
        const { bulk, derived } = await expectPathsAgree(corpus, seed % 2 ? 'org-1' : null)
        for (const [table, rows] of Object.entries(bulk)) if (rows.length) reached.add(table)
        nonZeroFlowCounts += derived.flowCounts.filter((count) => count > 0).length
        previewsOverTwelve += parsed(bulk, 'ro_diagram_summaries').filter((row) => (row.object_count as number) > 12).length
      }
    }
    // Every ro_* table was exercised by at least one corpus — the flow
    // tables through the flow projection, decision records through theirs.
    expect([...reached].sort()).toEqual(tables)
    // CONTROLS: the oracles above checked something — non-zero flow counts,
    // and previews that had to choose 12 of more members.
    expect(nonZeroFlowCounts).toBeGreaterThan(0)
    expect(previewsOverTwelve).toBeGreaterThan(0)
  }, 120_000)

  it('a corpus spanning several bulk batches: parents and group members in other batches', async () => {
    // > 2 × COLD_BUILD_BATCH objects, so a parent, a child and a member sit
    // in different statements.
    const corpus = randomReadModelCorpus(4242, { objects: 11_000, connections: 500, groups: 60, diagrams: 20 })
    corpus.objects[10_999].parentId = corpus.objects[3].id
    corpus.objects[2].parentId = corpus.objects[10_998].id
    corpus.groups[0].objectIds = [corpus.objects[10_997].id, corpus.objects[1].id]
    await expectPathsAgree(corpus)
  }, 120_000)

  it('BATCH BOUNDARIES: 4 999, 5 000, 5 001, 10 000 and 10 001 objects, and one group of 5 001 members', async () => {
    // `insertObjectRows` and `insertMembershipPairs` loop in COLD_BUILD_BATCH
    // (5 000) rows: a loop that lost its trailing batch would lose ONE row
    // at 5 001 and 10 001 — invisible to an 11 000-row corpus, whose trailing
    // batch is 1 000 rows. `expectPathsAgree` compares every table with the
    // by-deltas path (1 000-row chunks, no boundary at 5 000) and checks the
    // object count against the corpus.
    let seed = 5_000
    for (const objects of [4_999, 5_000, 5_001, 10_000, 10_001]) {
      await client.query('SAVEPOINT boundary')
      const corpus = randomReadModelCorpus(seed++, { objects, connections: 20, groups: 3, diagrams: 2 })
      const { bulk } = await expectPathsAgree(corpus)
      expect(bulk.ro_objects, `${objects} objects`).toHaveLength(objects)
      await client.query('ROLLBACK TO SAVEPOINT boundary')
    }
    // ONE group, every object a member: exactly 5 001 `ro_group_objects`
    // pairs, so the membership loop's trailing batch is one row.
    const corpus = randomReadModelCorpus(seed, { objects: 5_001, connections: 0, groups: 1, diagrams: 0 })
    corpus.groups[0].objectIds = corpus.objects.map((object) => object.id)
    const { bulk } = await expectPathsAgree(corpus)
    expect(bulk.ro_group_objects, 'one group of 5 001 members').toHaveLength(5_001)
    // CONTROL: the ids are distinct, so the pairs are too.
    expect(new Set(corpus.groups[0].objectIds).size).toBe(5_001)
  }, 300_000)

  it('the group-min read is scoped to the workspace: a LOWER group id for the same object in another version or landscape is not seen', async () => {
    // `insertObjectRows` takes `effective_parent_id` from
    // `SELECT min(group_id) … WHERE landscape_id = $1 AND version_id = $2`.
    // Each filter is pinned by one neighbour that differs in that column
    // only, holding a smaller group id for the same object id.
    const neighbours: WorkspaceKey[] = [
      { landscapeId: WS.landscapeId, versionId: 'v-neighbour' },
      { landscapeId: 'ws-cold-build-neighbour', versionId: WS.versionId },
    ]
    for (const [index, neighbour] of neighbours.entries()) {
      await coldBuildReadModel(client, neighbour, null, [{ id: 'o-shared' }], [], [{ id: `g-a${index}`, objectIds: ['o-shared'] }])
    }
    // CONTROL: the neighbours really hold the smaller ids for that object.
    const { rows: neighbourRows } = await client.query<{ group_id: string }>(
      `SELECT group_id FROM ro_group_objects WHERE object_id = 'o-shared'
         AND (landscape_id, version_id) IN (($1, $2), ($3, $4)) ORDER BY group_id`,
      [neighbours[0].landscapeId, neighbours[0].versionId, neighbours[1].landscapeId, neighbours[1].versionId],
    )
    expect(neighbourRows.map((row) => row.group_id)).toEqual(['g-a0', 'g-a1'])
    const corpus: ReadModelCorpus = {
      objects: [{ id: 'o-shared', parentId: 'o-parent' }, { id: 'o-parent' }],
      connections: [],
      groups: [{ id: 'g-m', objectIds: ['o-shared'] }],
      diagrams: [],
    }
    await coldBuildReadModel(client, WS, null, corpus.objects, corpus.connections, corpus.groups, corpus.diagrams)
    expect(byId(await dump(), 'ro_objects').get('o-shared')).toMatchObject({ effective_parent_id: 'g-m', c4_parent_id: 'o-parent' })
  })

  it('values that are not strings convert as node-postgres converts a parameter', async () => {
    // The CRDT is not typed: a name may be a number, a scope an array. The
    // by-deltas path sends each as its own parameter; the bulk path's
    // `parameterText` must reproduce what PostgreSQL then stores — and the
    // parent and membership checks it decides in JS must see the same text.
    const objects: ObjectInput[] = [
      { id: '42', name: 'answer' },
      { id: 'child-of-number', parentId: 42 as unknown as string, name: 7 as unknown as string },
      { id: 'odd', type: true as unknown as string, description: { a: 1 } as unknown as string,
        scope: ['x', 'y "quoted"'] as unknown as string, status: null as unknown as string, domainId: 0 as unknown as string },
      { id: 'dated', name: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) as unknown as string },
      { id: 'grouped-twice', parentId: '42' },
    ]
    const corpus: ReadModelCorpus = {
      objects,
      connections: [{ id: 'c1', fromId: 42 as unknown as string, toId: 'odd', label: 3 as unknown as string }],
      groups: [
        { id: 'g-b', objectIds: [42 as unknown as string, '42', 'grouped-twice'] },
        { id: 'g-a', objectIds: ['grouped-twice', 'grouped-twice'] },
      ],
      diagrams: [{ id: 'd1', objectIds: ['42', 42 as unknown as string, 'odd'], groupIds: ['g-a'], connectionIds: ['c1', 'c1'] }],
    }
    const { bulk } = await expectPathsAgree(corpus)
    // CONTROL: the conversions were really exercised.
    const rows = byId(bulk, 'ro_objects')
    expect(rows.get('child-of-number')).toMatchObject({ parent_id: '42', c4_parent_id: '42', name: '7' })
    expect(rows.get('odd')).toMatchObject({ type: 'true', description: '{"a":1}', scope: '{"x","y \\"quoted\\""}', domain_id: '0' })
    // In two groups: the smaller id wins over the group listed first and
    // over the parent.
    expect(rows.get('grouped-twice')!.effective_parent_id).toBe('g-a')
    expect(parsed(bulk, 'ro_group_objects').filter((row) => row.object_id === 'grouped-twice')).toHaveLength(2)
    expect(parsed(bulk, 'ro_group_objects').filter((row) => row.object_id === '42')).toHaveLength(1)
  })

  it('parameterText is the text a scalar parameter stores — under both Date settings of the pool\'s pg', async () => {
    // The function parameterText calls IS the pool's: the same pg instance
    // (`pg.utils`), the same `defaults` object its Date branch reads.
    const cjs = createRequire(import.meta.url)
    expect(PG_PREPARE_VALUE).toBe((cjs('pg/lib/utils.js') as { prepareValue: unknown }).prepareValue)
    expect(cjs('pg/lib/defaults.js')).toBe(pg.defaults)
    const samples: unknown[] = ['plain', '', 'é \u{1F600}', 12.5, -0, true, { k: [1, 'two'] }, ['a', null, ['n']],
      new Date(Date.UTC(2020, 1, 3)), new Date(Date.UTC(2026, 6, 4, 23, 59, 59, 999)), Buffer.from('bytes'),
      'lone \ud800 surrogate', null, undefined]
    const before = pg.defaults.parseInputDatesAsUTC
    try {
      for (const utc of [false, true]) {
        pg.defaults.parseInputDatesAsUTC = utc
        for (const sample of samples) {
          const { rows } = await client.query<{ t: string | null }>('SELECT $1::text AS t', [sample])
          expect(parameterText(sample), `${String(sample)} (parseInputDatesAsUTC ${utc})`).toBe(rows[0].t)
        }
      }
    } finally {
      pg.defaults.parseInputDatesAsUTC = before
    }
  })

  /** A sharded workspace's documents for `extractModelEntities`, each list
   * in its own document(s), keyed by map keys that are NOT the ids. */
  const workspaceDocs = (layout: {
    objectShards: ObjectInput[][]; connectionShards: ConnectionInput[][]; groups: GroupInput[]; registries: DiagramInput[][]
  }) => {
    const docs: Record<string, unknown> = {}
    const keyed = <T>(prefix: string, list: readonly T[]) => Object.fromEntries(list.map((entity, i) => [`${prefix}-${i}`, entity]))
    layout.objectShards.forEach((list, i) => { docs[`os${i}`] = { objects: keyed(`ok${i}`, list) } })
    layout.connectionShards.forEach((list, i) => { docs[`cs${i}`] = { connections: keyed(`ck${i}`, list) } })
    layout.registries.forEach((list, i) => { docs[`reg${i}`] = { diagrams: keyed(`dk${i}`, list) } })
    docs.meta = {
      objectShardUrls: layout.objectShards.map((_, i) => `os${i}`),
      connectionShardUrls: layout.connectionShards.map((_, i) => `cs${i}`),
      groups: keyed('gk', layout.groups),
    }
    const root = { modelMetaUrl: 'meta', modelUrl: '', shardUrls: layout.registries.map((_, i) => `reg${i}`) }
    return { root, resolve: async (url: string) => docs[url] }
  }

  it('DUPLICATE IDS of every kind, in a batch and across batches: the build succeeds, the LAST wins, each drop is a defect, the digests are the rows\'', async () => {
    for (const { label, objects } of [{ label: 'within one batch', objects: 30 }, { label: 'across bulk batches', objects: 6_000 }]) {
      await client.query('SAVEPOINT duplicates')
      const corpus = randomReadModelCorpus(900 + objects, { objects, connections: 40, groups: 6, diagrams: 4 })
      corpus.objects[3].name = 'FIRST'
      corpus.connections[1].label = 'FIRST'
      corpus.groups[2].name = 'FIRST'
      corpus.diagrams[0].name = 'FIRST'
      // Each second occurrence in a LATER document than its first (a later
      // object shard is past index `objects`, i.e. in the next bulk batch
      // when objects > 5 000), under a different map key.
      const second = {
        object: { ...corpus.objects[3], name: 'SECOND' },
        connection: { ...corpus.connections[1], label: 'SECOND' },
        group: { ...corpus.groups[2], name: 'SECOND', objectIds: ['only-in-second-group'] },
        diagram: { ...corpus.diagrams[0], name: 'SECOND', objectIds: ['only-in-second-diagram'] },
      }
      // And one duplicate inside the FIRST object shard, near its end.
      const lateTwin = { ...corpus.objects[objects - 2], name: 'SECOND' }
      corpus.objects[objects - 2].name = 'FIRST-late'
      const { root, resolve } = workspaceDocs({
        objectShards: [[...corpus.objects, lateTwin], [second.object]],
        connectionShards: [corpus.connections, [second.connection]],
        groups: [...corpus.groups, second.group],
        registries: [corpus.diagrams, [second.diagram]],
      })
      const model = await extractModelEntities(root, resolve)
      // In input order of the DROPPED copy: objects[3] (index 3) before
      // objects[n-2] (index n-2), each kept later in the list.
      expect(model.defects, label).toEqual([
        { kind: 'duplicate-id', source: 'object-shard', url: null, entity: 'object', id: corpus.objects[3].id },
        { kind: 'duplicate-id', source: 'object-shard', url: null, entity: 'object', id: corpus.objects[objects - 2].id },
        { kind: 'duplicate-id', source: 'connection-shard', url: null, entity: 'connection', id: corpus.connections[1].id },
        { kind: 'duplicate-id', source: 'model-meta', url: null, entity: 'group', id: corpus.groups[2].id },
        { kind: 'duplicate-id', source: 'registry-shard', url: null, entity: 'diagram', id: corpus.diagrams[0].id },
      ])
      const result = await coldBuildReadModel(client, WS, 'org-1', model.objects, model.connections, model.groups, model.diagrams)
      expect(result.droppedDuplicates, `${label}: nothing left to drop`).toEqual([])
      const rows = await dump()
      expect(byId(rows, 'ro_objects').get(corpus.objects[3].id)?.name, label).toBe('SECOND')
      expect(byId(rows, 'ro_objects').get(corpus.objects[objects - 2].id)?.name, label).toBe('SECOND')
      expect(rows.ro_objects).toHaveLength(objects)
      expect(byId(rows, 'ro_connections').get(corpus.connections[1].id)?.label, label).toBe('SECOND')
      expect(byId(rows, 'ro_groups').get(corpus.groups[2].id)?.name, label).toBe('SECOND')
      expect((byId(rows, 'ro_diagrams').get(corpus.diagrams[0].id)?.data as { name?: unknown } | undefined)?.name, label).toBe('SECOND')
      // The memberships are the kept copy's only; the dropped one's are not there.
      expect(parsed(rows, 'ro_group_objects').filter((row) => row.group_id === corpus.groups[2].id).map((row) => row.object_id), label)
        .toEqual(['only-in-second-group'])
      expect(parsed(rows, 'ro_diagram_objects').filter((row) => row.diagram_id === corpus.diagrams[0].id).map((row) => row.object_id), label)
        .toEqual(['only-in-second-diagram'])
      // CONTROL: the dropped copies HAD members, so their absence is a fact.
      expect(corpus.groups[2].objectIds?.length ?? 0, label).toBeGreaterThan(0)
      expect(corpus.diagrams[0].objectIds?.length ?? 0, label).toBeGreaterThan(0)
      // The sealed digests are the written rows'.
      const digests = fullExtractionIntegrity(model).digests!
      await expectDigests({ object: digests.object, connection: digests.connection, group: digests.group, diagram: digests.diagram })
      await expectDerivedStatsHold(rows, 'org-1')
      // A direct caller with the RAW lists, in reader order, gets the same
      // rows and the drops back.
      const raw = await coldBuildReadModel(client, WS, 'org-1',
        [...corpus.objects, lateTwin, second.object], [...corpus.connections, second.connection],
        [...corpus.groups, second.group], [...corpus.diagrams, second.diagram])
      expect(raw.droppedDuplicates.map((drop) => [drop.kind, drop.id]), label).toEqual([
        ['object', corpus.objects[3].id], ['object', corpus.objects[objects - 2].id],
        ['connection', corpus.connections[1].id], ['group', corpus.groups[2].id], ['diagram', corpus.diagrams[0].id],
      ])
      expect(await dump(), label).toEqual(rows)
      // And on the de-duplicated lists the by-deltas path agrees.
      await coldBuildReadModelByDeltas(client, WS, 'org-1', model.objects, model.connections, model.groups, model.diagrams)
      expect(await dump(), label).toEqual(rows)
      await client.query('ROLLBACK TO SAVEPOINT duplicates')
    }
  }, 120_000)

  it('KNOWN DIVERGENCE: the by-deltas path, fed raw duplicates, fails in a chunk and keeps the LAST across chunks', async () => {
    const corpus = randomReadModelCorpus(77, { objects: 1_500, connections: 0, groups: 0, diagrams: 0 })
    const id = corpus.objects[3].id
    corpus.objects[3].name = 'FIRST'
    await client.query('SAVEPOINT in_chunk')
    const inChunk = await coldBuildReadModelByDeltas(client, WS, null,
      [...corpus.objects.slice(0, 10), { ...corpus.objects[3], name: 'SECOND' }], [])
      .then(() => null, (error: unknown) => error)
    expect((inChunk as { code?: string } | null)?.code).toBe('21000')
    await client.query('ROLLBACK TO SAVEPOINT in_chunk')
    // Index 3 in chunk 0, its twin at index 1 500 in chunk 1 (1 000 rows each).
    await coldBuildReadModelByDeltas(client, WS, null, [...corpus.objects, { ...corpus.objects[3], name: 'SECOND' }], [])
    expect(byId(await dump(), 'ro_objects').get(id)?.name).toBe('SECOND')
    // The bulk path on the same input: last wins too, and it does not fail
    // on the in-chunk pair.
    await coldBuildReadModel(client, WS, null, [...corpus.objects, { ...corpus.objects[3], name: 'SECOND' }], [])
    expect(byId(await dump(), 'ro_objects').get(id)?.name).toBe('SECOND')
    await coldBuildReadModel(client, WS, null, [...corpus.objects.slice(0, 10), { ...corpus.objects[3], name: 'SECOND' }], [])
    expect(byId(await dump(), 'ro_objects').get(id)?.name).toBe('SECOND')
  }, 60_000)

  it('KNOWN DIVERGENCE: falsy ids (\'\' and 0) — the bulk path derives their levels, the by-deltas path does not', async () => {
    // `refreshEffectiveParents` does `touchedIds.filter(Boolean)`, so a row
    // whose id is '' or 0 is never re-derived by the by-deltas path: it keeps
    // the parent it was inserted with, existing or not, in a group or not.
    // The bulk path computes both levels from their definitions. NOT fixed
    // on the delta path here: it is the live per-shard path, and the same
    // filter sits in three more touched-id reads beside it.
    const corpus = randomReadModelCorpus(31, { objects: 40, connections: 10, groups: 3, diagrams: 2, falsyIds: true })
    await build(coldBuildReadModel, corpus)
    const bulk = await dump()
    const rows = byId(bulk, 'ro_objects')
    expect(rows.get('')).toMatchObject({ parent_id: 'nowhere-empty', c4_parent_id: null, effective_parent_id: 'g-holds-empty' })
    expect(rows.get('0')).toMatchObject({ parent_id: 'nowhere-zero', c4_parent_id: null, effective_parent_id: null })
    expect(rows.get('child-of-empty')).toMatchObject({ c4_parent_id: '', effective_parent_id: '' })
    expect(rows.get('child-of-zero')).toMatchObject({ c4_parent_id: '0', effective_parent_id: '0' })
    await expectDerivedStatsHold(bulk, 'org-1')
    await expectDigestsMatchIds(corpus)

    await build(coldBuildReadModelByDeltas, corpus)
    const byDeltas = byId(await dump(), 'ro_objects')
    // Pinned so a fix of the delta path shows up here and retires this arm.
    expect(byDeltas.get('')).toMatchObject({ c4_parent_id: 'nowhere-empty', effective_parent_id: 'nowhere-empty' })
    expect(byDeltas.get('0')).toMatchObject({ c4_parent_id: 'nowhere-zero', effective_parent_id: 'nowhere-zero' })
    // The children of a falsy id ARE re-derived there (their own id is
    // truthy), and agree.
    expect(byDeltas.get('child-of-empty')).toMatchObject({ c4_parent_id: '', effective_parent_id: '' })
  })

  it('THE LOCK ORDER: the cold build writes no protocol table, so it may precede the fence', async () => {
    // A participant connection (the trigger checks only those) on a
    // workspace that HAS a projection-state row (the trigger checks only
    // those): the shape of a re-attach.
    await client.query(`SELECT set_config('${READ_MODEL_PROTOCOL_SETTING}', $1, true)`, [String(READ_MODEL_PROTOCOL_VERSION)])
    await client.query(
      `INSERT INTO read_model_projection_state (landscape_id, version_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [WS.landscapeId, WS.versionId],
    )
    // CONTROL: in this transaction, an unfenced protocol write IS refused.
    await client.query('SAVEPOINT control')
    await expect(client.query(
      `INSERT INTO read_model_ordinary_head_retirements (landscape_id, version_id, collection, document_id)
       VALUES ($1, $2, 'object', 'control')`, [WS.landscapeId, WS.versionId],
    )).rejects.toThrow(/read-model lock order/)
    await client.query('ROLLBACK TO SAVEPOINT control')

    const statements: string[] = []
    const recording = {
      query: (text: string, params?: unknown[]) => {
        statements.push(text)
        return client.query(text, params)
      },
    }
    const corpus = randomReadModelCorpus(77, { objects: 120, connections: 60, groups: 6, diagrams: 5 })
    await coldBuildReadModel(recording, WS, 'org-1', corpus.objects, corpus.connections, corpus.groups, corpus.diagrams)
    expect(statements.length).toBeGreaterThan(20)
    // Not a protocol table, not the fence row, not an adopt row: nothing but
    // the projected tables (and the planner/transaction statements).
    // Keywords are upper case in this module's SQL, relation names lower.
    const touched = statements.flatMap((text) => [...text.matchAll(/\b(?:INTO|FROM|UPDATE|JOIN|ANALYZE)\s+([a-z_]+)/g)].map((m) => m[1]))
    expect(touched).toEqual(expect.arrayContaining(['ro_objects', 'ro_group_objects', 'ro_object_tags']))
    // The catalogs are READ, by the pending-list merge's index lookup (P3p,
    // `mergeGinPendingLists`: it writes index pages of the `ro_*` GIN indexes
    // and nothing else) and by the P3p guard's ownership check (a SELECT
    // EXISTS over the same GIN indexes, nothing written).
    const catalogs = ['pg_index', 'pg_class', 'pg_am']
    expect(touched.filter((table) => !/^ro_/.test(table) && !['jsonb_to_recordset', 'unnest', 'input', ...catalogs].includes(table)), 'tables touched').toEqual([])
    expect(statements.filter((text) => /\bpg_(index|class|am)\b/.test(text))
      .every((text) => /^\s*SELECT gin_clean_pending_list\(/.test(text) || /^\s*SELECT EXISTS \(SELECT 1 FROM ro_objects WHERE/.test(text)),
    'the catalogs are only read by the pending-list merge and the guard').toBe(true)
  })
})
