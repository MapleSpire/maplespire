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
import pg from 'pg'
import { coldBuildReadModel, deleteDiagrams, FLOW_INDEX_VERSION, replaceDiagramFlowIndex, syncConnectionFlows, syncDiagrams, type WorkspaceKey } from './projector.js'
import {
  roObject, roGroup, roLookupMany, roIncoming, roOutgoing,
  roConnectionCount, roDescendants, roRelatedDiagrams, roRelatedDiagramObjectIds, roSearch, roPageObjects, roPageConnections,
  roFilteredObjectTree, roEntityFlows, roEntityDiagrams,
} from './queries.js'
import type { ObjectInput, ConnectionInput, GroupInput, DiagramInput } from './types.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 3000 }), 'queries')
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
if (!pool) console.warn(`[readModel queries] no Postgres at ${URL} — skipping DB tests`)

const o = (id: string, over: Partial<ObjectInput> = {}): ObjectInput => ({ id, name: id, ...over })
const c = (id: string, fromId: string, toId: string, over: Partial<ConnectionInput> = {}): ConnectionInput =>
  ({ id, fromId, toId, ...over })
const g = (id: string, name = id, over: Partial<GroupInput> = {}): GroupInput => ({ id, name, ...over })

const sortedIds = (es: { connection: { id?: unknown } }[]) => es.map((e) => String(e.connection.id)).sort()

// Every read-model row lives under a (landscape_id, version_id) workspace
// key — this suite uses one fixed key throughout (its cross-workspace
// isolation is covered separately by workspaceIsolation.integration.test.ts,
// which projects two workspaces with COLLIDING entity ids and runs every
// function imported below against both).
const WS: WorkspaceKey = { landscapeId: 'ws-test', versionId: 'v1' }

suite('read-model queries (Postgres integration, txn-isolated)', () => {
  let client: pg.PoolClient
  // Schema is ensured once by vitest globalSetup (avoids concurrent-CREATE races).
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
  const build = (
    objects: ObjectInput[],
    connections: ConnectionInput[] = [],
    groups: GroupInput[] = [],
    diagrams: DiagramInput[] = []
  ) => coldBuildReadModel(client, WS, null, objects, connections, groups, diagrams)

  it('adjacency: incoming/outgoing exclude self-loops and resolve the peer endpoint', async () => {
    await build(
      [o('A'), o('B'), o('C')],
      [c('c1', 'B', 'A'), c('c2', 'A', 'C', { kind: 'direct' }), c('c3', 'A', 'A'), c('c4', 'G1', 'A')],
      [g('G1')]
    )
    const inc = await roIncoming(client, WS, 'A')
    expect(sortedIds(inc)).toEqual(['c1', 'c4'])
    expect(inc.map((e) => e.peerId).sort()).toEqual(['B', 'G1'])
    const out = await roOutgoing(client, WS, 'A')
    expect(sortedIds(out)).toEqual(['c2'])
    expect(out[0].peerId).toBe('C')
    // self-loop c3 in neither fan
    expect(inc.some((e) => e.connection.id === 'c3')).toBe(false)
    expect(out.some((e) => e.connection.id === 'c3')).toBe(false)
  })

  it('connectionCount counts a self-loop once', async () => {
    await build(
      [o('A'), o('B'), o('C')],
      [c('c1', 'B', 'A'), c('c2', 'A', 'C'), c('c3', 'A', 'A'), c('c4', 'G1', 'A')],
      [g('G1')]
    )
    expect(await roConnectionCount(client, WS, 'A')).toBe(4) // c1,c2,c3,c4
    expect(await roConnectionCount(client, WS, 'G1')).toBe(1)
    expect(await roConnectionCount(client, WS, 'missing')).toBe(0)
  })

  it('technology/status/tag/team facets agree and retain only the ancestor chain', async () => {
    const usage = (id: string) => ({
      id: `usage-${id}`, technologyId: id, catalogRevision: 1,
      snapshot: { name: id },
    })
    await build([
      o('sys', { type: 'system' }),
      o('app', { type: 'app', parentId: 'sys' }),
      o('cmp', {
        type: 'component', parentId: 'app', status: 'live',
        tagAssignments: { front: { tagId: 'front' } }, tagOrder: ['front'],
        ownerTeamIds: ['team-ui'], technologyUsages: { angular: usage('angular') },
      }),
      o('db', {
        type: 'store', parentId: 'sys', status: 'live',
        tagAssignments: { data: { tagId: 'data' } }, tagOrder: ['data'],
        ownerTeamIds: ['team-data'], technologyUsages: { postgres: usage('postgres') },
      }),
    ])
    const result = await roFilteredObjectTree(client, WS, {
      technologyIds: ['angular', 'react'], statuses: ['live'], tagIds: ['front', 'critical'],
      teamIds: ['team-ui', 'team-other'],
    })
    expect(result.objects.map((object) => object.id)).toEqual(['sys', 'app', 'cmp'])
    expect(result.matchedIds).toEqual(['cmp'])
    expect(result.groups).toEqual([])
    expect(result.matchedGroupIds).toEqual([])
  })

  it('treats legacy and canonical technology IDs as one filter identity', async () => {
    const canonicalId = 'rm-canonical-technology'
    const legacyId = 'rm-legacy-technology'
    await client.query(
      `INSERT INTO technology_identities
         (id, scope, lifecycle_status, latest_revision, current_revision, created_by)
       VALUES ($1, 'public', 'active', 1, NULL, 'read-model-test'),
              ($2, 'public', 'active', 1, NULL, 'read-model-test')`,
      [canonicalId, legacyId],
    )
    await client.query(
      'UPDATE technology_identities SET lifecycle_status = \'merged\', canonical_technology_id = $1 WHERE id = $2',
      [canonicalId, legacyId],
    )
    await client.query(
      `INSERT INTO technology_redirects (source_technology_id, target_technology_id, created_by)
       VALUES ($1, $2, 'read-model-test')`,
      [legacyId, canonicalId],
    )
    const usage = (technologyId: string) => ({
      id: `usage-${technologyId}`, technologyId, catalogRevision: 1,
      snapshot: { name: technologyId },
    })
    await build([
      o('legacy-object', { technologyUsages: { legacy: usage(legacyId) } }),
      o('canonical-object', { technologyUsages: { canonical: usage(canonicalId) } }),
    ])

    const byCanonical = await roFilteredObjectTree(client, WS, { technologyIds: [canonicalId] })
    expect(byCanonical.matchedIds.sort()).toEqual(['canonical-object', 'legacy-object'])
    const byLegacy = await roFilteredObjectTree(client, WS, { technologyIds: [legacyId] })
    expect(byLegacy.matchedIds.sort()).toEqual(['canonical-object', 'legacy-object'])
  })

  it('filters technology-bearing groups through the normalized covering index', async () => {
    const usage = {
      id: 'usage-terraform', technologyId: 'terraform', catalogRevision: 2,
      role: 'infrastructure',
      snapshot: { name: 'Terraform', recommendedShapeTypes: ['group'], defaultRole: 'infrastructure' },
    }
    await build(
      [o('app')],
      [],
      [g('platform', 'Platform', { technologyUsages: { terraform: usage } })],
    )

    const result = await roFilteredObjectTree(client, WS, { technologyIds: ['terraform'] })
    expect(result.objects).toEqual([])
    expect(result.groups.map((group) => group.id)).toEqual(['platform'])
    expect(result.matchedGroupIds).toEqual(['platform'])

    await client.query('SET LOCAL enable_seqscan = off')
    const explain = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF)
       WITH matching_technology_groups AS MATERIALIZED (
         SELECT DISTINCT t.group_id
         FROM unnest($3::text[]) selected(technology_id)
         JOIN ro_group_technologies t
           ON t.landscape_id = $1 AND t.version_id = $2
          AND t.technology_id = selected.technology_id
       )
       SELECT g.id FROM matching_technology_groups mtg
       JOIN ro_groups g ON g.id = mtg.group_id
         AND g.landscape_id = $1 AND g.version_id = $2`,
      [WS.landscapeId, WS.versionId, ['terraform']],
    )
    const plan = explain.rows.map((row) => row['QUERY PLAN']).join('\n')
    expect(plan).toContain('Index Scan using idx_ro_group_technologies_')
    expect(plan).not.toContain('Seq Scan on ro_group_technologies')
  })

  it('object/group/lookupMany resolve entities (objects win on collision)', async () => {
    await build([o('A', { type: 'app' })], [], [g('G1', 'Group One')])
    expect((await roObject(client, WS, 'A'))?.type).toBe('app')
    expect(await roObject(client, WS, 'missing')).toBeUndefined()
    expect((await roGroup(client, WS, 'G1'))?.name).toBe('Group One')
    const m = await roLookupMany(client, WS, ['A', 'G1', 'missing'])
    expect(m.get('A')?.name).toBe('A')
    expect(m.get('G1')?.name).toBe('Group One')
    expect(m.has('missing')).toBe(false)
  })

  it('descendants: transitive children, excludes self', async () => {
    await build(
      [o('A'), o('B', { parentId: 'A' }), o('C', { parentId: 'B' }), o('D', { parentId: 'A' }), o('X')],
      [],
      []
    )
    expect((await roDescendants(client, WS, 'A')).sort()).toEqual(['B', 'C', 'D'])
    expect((await roDescendants(client, WS, 'B')).sort()).toEqual(['C'])
    expect(await roDescendants(client, WS, 'X')).toEqual([])
  })

  it('search: name(4) > technology(3) > description(2) > connection label(1), then text/id tie-break', async () => {
    await build(
      [
        o('o-name', { name: 'Payment Service' }),
        o('o-tech', { name: 'Gateway', technology: 'payment-sdk' }),
        o('o-desc', { name: 'Ledger', description: 'stores payment records' }),
        o('o-none', { name: 'Unrelated' }),
        o('o-a', { name: 'Alpha payment' }),
        o('o-b', { name: 'Beta payment' }),
      ],
      [c('c-lbl', 'o-name', 'o-tech', { label: 'payment flow' })],
      []
    )
    const hits = await roSearch(client, WS, 'payment')
    // score order: name(4) {Alpha payment, Beta payment, Payment Service} > tech(3) Gateway
    // > desc(2) Ledger > conn(1). Within score 4, sortKey asc: "alpha…","beta…","payment service".
    expect(hits.map((h) => (h.type === 'object' ? h.object.name : `conn:${h.connection.label}`))).toEqual([
      'Alpha payment',
      'Beta payment',
      'Payment Service',
      'Gateway',
      'Ledger',
      'conn:payment flow',
    ])
    const conn = hits.find((h) => h.type === 'connection')
    expect(conn && conn.type === 'connection' && conn.fromName).toBe('Payment Service')
  })

  it('relatedDiagrams: reference > detail > parent precedence + current exclusion', async () => {
    const objs = [o('A'), o('B'), o('C'), o('D', { parentId: 'A' })]
    const dia = (id: string, objectIds: string[], over: Partial<DiagramInput> = {}): DiagramInput =>
      ({ id, name: id, type: 'container', objectIds, connectionIds: [], groupIds: [], ...over })
    const diagrams = [
      dia('dgRoot', ['A', 'B'], { type: 'context' }),
      dia('dgDetailA', ['C'], { parentObjectId: 'A' }),
      dia('dgContainsD', ['D'], { parentObjectId: 'A' }),
    ]
    await build(objs, [], [], diagrams)
    const rel = (r: { detail: { id?: unknown }[]; reference: { id?: unknown }[]; parent: { id?: unknown }[] }) => ({
      detail: r.detail.map((d) => String(d.id)).sort(),
      reference: r.reference.map((d) => String(d.id)).sort(),
      parent: r.parent.map((d) => String(d.id)).sort(),
    })
    // A: contained by dgRoot (reference); is the parent of dgDetailA + dgContainsD (detail).
    expect(rel(await roRelatedDiagrams(client, WS, 'A', null))).toEqual({ detail: ['dgContainsD', 'dgDetailA'], reference: ['dgRoot'], parent: [] })
    // D: contained by dgContainsD (reference, wins over parent dpo:A); parent = dgDetailA.
    expect(rel(await roRelatedDiagrams(client, WS, 'D', null))).toEqual({ detail: [], reference: ['dgContainsD'], parent: ['dgDetailA'] })
    expect((await roRelatedDiagrams(client, WS, 'A', 'dgRoot')).reference).toEqual([]) // active diagram excluded
    expect(await roRelatedDiagramObjectIds(client, WS, ['A', 'B', 'D', 'missing'], 'dgRoot'))
      .toEqual(['A', 'D'])
    expect(await roRelatedDiagrams(client, WS, 'missing', null)).toEqual({
      detail: [], reference: [], parent: [],
      totals: { detail: 0, reference: 0, parent: 0 },
      limit: 50,
      truncated: false,
    })
  })

  it('entityFlows: whole-model object flows, complete only once every holding diagram is indexed', async () => {
    const dia = (id: string, objectIds: string[], connectionIds: string[] = []): DiagramInput =>
      ({ id, name: id, type: 'container', objectIds, connectionIds, groupIds: [] })
    // A is on dgOne AND dgTwo; B only on dgOne. c1 = A→B on dgOne AND dgTwo.
    await build([o('A'), o('B')], [c('c1', 'A', 'B')], [], [dia('dgOne', ['A', 'B'], ['c1']), dia('dgTwo', ['A'], ['c1'])])
    const ids = (r: { flows: Array<{ diagramId: string; id: string }> }) => r.flows.map((f) => `${f.diagramId}/${f.id}`)

    // Nothing indexed yet (the cold-build window): unknown, never "0, exact" — for objects AND connections.
    expect(await roEntityFlows(client, WS, 'object', 'A')).toEqual({ flows: [], total: 0, complete: false })
    expect(await roEntityFlows(client, WS, 'connection', 'c1')).toEqual({ flows: [], total: 0, complete: false })

    await syncConnectionFlows(client, WS, null, 'dgOne', [
      { id: 'checkout', name: 'Checkout', steps: [{ type: 'message', fromObjectId: 'A', toObjectId: 'B', connectionId: 'c1' }] },
      { id: 'audit', name: 'Audit', steps: [{ type: 'process', objectId: 'B' }, { type: 'introduction' }] },
    ], true)
    // dgTwo still unindexed → a floor, for the object and for the connection.
    expect(await roEntityFlows(client, WS, 'object', 'A')).toMatchObject({ total: 1, complete: false })
    expect(await roEntityFlows(client, WS, 'connection', 'c1')).toMatchObject({ total: 1, complete: false })
    // B is only on dgOne, which is indexed → exact; process + message receiver both count.
    const b = await roEntityFlows(client, WS, 'object', 'B')
    expect(b).toMatchObject({ total: 2, complete: true })
    expect(b.flows.map((f) => f.name)).toEqual(['Audit', 'Checkout'])
    // Excluding the open diagram drops its hits AND its coverage requirement.
    expect(await roEntityFlows(client, WS, 'object', 'A', { excludeDiagramId: 'dgTwo' }))
      .toMatchObject({ total: 1, complete: true })
    expect(await roEntityFlows(client, WS, 'object', 'B', { excludeDiagramId: 'dgOne' }))
      .toEqual({ flows: [], total: 0, complete: true })

    await syncConnectionFlows(client, WS, null, 'dgTwo', [
      { id: 'refund', name: 'Refund', steps: [{ type: 'process', objectId: 'A' }] },
    ], true)
    const a = await roEntityFlows(client, WS, 'object', 'A')
    expect(a).toMatchObject({ total: 2, complete: true })
    expect(ids(a)).toEqual(['dgOne/checkout', 'dgTwo/refund'])
    expect(await roEntityFlows(client, WS, 'object', 'A', { limit: 1 })).toMatchObject({ total: 2, complete: true })
    expect((await roEntityFlows(client, WS, 'object', 'A', { limit: 1 })).flows).toHaveLength(1)
    // Connections read ro_connection_flows (the Connections table's source).
    expect(await roEntityFlows(client, WS, 'connection', 'c1'))
      .toEqual({ flows: [{ id: 'checkout', diagramId: 'dgOne', name: 'Checkout' }], total: 1, complete: true })

    // A projection that could not read a flows MAP must not certify: rows AND witness go.
    await syncConnectionFlows(client, WS, null, 'dgTwo', [], false)
    expect(await roEntityFlows(client, WS, 'object', 'A')).toMatchObject({ total: 1, complete: false })

    // Re-projecting a diagram REPLACES its rows (and keeps it covered).
    await syncConnectionFlows(client, WS, null, 'dgOne', [], true)
    expect(await roEntityFlows(client, WS, 'object', 'B')).toEqual({ flows: [], total: 0, complete: true })

    // Deleting a diagram drops its rows AND its coverage witness.
    await syncConnectionFlows(client, WS, null, 'dgTwo', [{ id: 'refund', name: 'Refund', steps: [{ type: 'process', objectId: 'A' }] }], true)
    await deleteDiagrams(client, WS, ['dgTwo'])
    expect(await roEntityFlows(client, WS, 'object', 'A')).toEqual({ flows: [], total: 0, complete: true })
    const witness = await client.query(
      `SELECT diagram_id FROM ro_diagram_flow_index WHERE landscape_id = $1 AND version_id = $2 ORDER BY diagram_id`,
      [WS.landscapeId, WS.versionId],
    )
    expect(witness.rows.map((r) => r.diagram_id)).toEqual(['dgOne'])
  })

  it('entityFlows: postings for a diagram that no longer exists are not counted', async () => {
    const dia = (id: string, objectIds: string[]): DiagramInput =>
      ({ id, name: id, type: 'container', objectIds, connectionIds: [], groupIds: [] })
    await build([o('A')], [], [], [dia('dgReal', ['A'])])
    await syncConnectionFlows(client, WS, null, 'dgReal', [{ id: 'f1', name: 'One', steps: [{ type: 'process', objectId: 'A' }] }], true)
    // A late, coalesced flow projection for a diagram the registry already dropped.
    await replaceDiagramFlowIndex(client, WS, null, 'dgGhost', [{ id: 'f9', name: 'Ghost', steps: [{ type: 'process', objectId: 'A' }] }])
    expect(await roEntityFlows(client, WS, 'object', 'A')).toMatchObject({ total: 1, complete: true })
  })

  it('entityFlows: a witness from an older index version does not count as coverage', async () => {
    const dia = (id: string, objectIds: string[]): DiagramInput =>
      ({ id, name: id, type: 'container', objectIds, connectionIds: [], groupIds: [] })
    await build([o('A')], [], [], [dia('dgOld', ['A'])])
    await syncConnectionFlows(client, WS, null, 'dgOld', [{ id: 'f1', name: 'One', steps: [{ type: 'process', objectId: 'A' }] }], true)
    expect((await roEntityFlows(client, WS, 'object', 'A')).complete).toBe(true)
    await client.query(
      `UPDATE ro_diagram_flow_index SET index_version = $3 WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId, FLOW_INDEX_VERSION - 1],
    )
    expect((await roEntityFlows(client, WS, 'object', 'A')).complete).toBe(false)
  })

  it('entityFlows: a hostile flow name (NUL, lone surrogate) cannot fail the flow projection', async () => {
    const dia = (id: string, objectIds: string[]): DiagramInput =>
      ({ id, name: id, type: 'container', objectIds, connectionIds: [], groupIds: [] })
    await build([o('A')], [], [], [dia('dgOne', ['A'])])
    await syncConnectionFlows(client, WS, null, 'dgOne', [
      { id: 'f1', name: 'Cut \uD83D emoji\u0000', steps: [{ type: 'process', objectId: 'A' }] },
      { id: 'f2', name: 42, steps: [{ type: 'process', objectId: 'A' }] },
    ], true)
    const a = await roEntityFlows(client, WS, 'object', 'A')
    expect(a).toMatchObject({ total: 2, complete: true })
    expect(a.flows.map((f) => f.id).sort()).toEqual(['f1', 'f2'])
    expect(a.flows.find((f) => f.id === 'f2')?.name).toBe('')
  })

  it('entityFlows: a registry sync and a cold build drop the flow index of what they remove', async () => {
    const dia = (id: string, objectIds: string[]): DiagramInput =>
      ({ id, name: id, type: 'container', objectIds, connectionIds: [], groupIds: [] })
    await build([o('A')], [], [], [dia('dgKeep', ['A']), dia('dgGone', ['A'])])
    await syncConnectionFlows(client, WS, null, 'dgKeep', [{ id: 'f1', name: 'One', steps: [{ type: 'process', objectId: 'A' }] }], true)
    await syncConnectionFlows(client, WS, null, 'dgGone', [{ id: 'f2', name: 'Two', steps: [{ type: 'process', objectId: 'A' }] }], true)
    expect((await roEntityFlows(client, WS, 'object', 'A')).total).toBe(2)

    await syncDiagrams(client, WS, null, [dia('dgKeep', ['A'])])
    expect(await roEntityFlows(client, WS, 'object', 'A')).toMatchObject({ total: 1, complete: true })

    await build([o('A')], [], [], [dia('dgKeep', ['A'])])
    // Rebuilt from scratch: the diagram is back, its flows are not projected yet.
    expect(await roEntityFlows(client, WS, 'object', 'A')).toEqual({ flows: [], total: 0, complete: false })
  })

  it('entityDiagrams: groups and connections answered from the read model, name-sorted and bounded', async () => {
    const dia = (id: string, name: string, over: Partial<DiagramInput>): DiagramInput =>
      ({ id, name, type: 'container', objectIds: [], connectionIds: [], groupIds: [], ...over })
    await build([o('A'), o('B')], [c('c1', 'A', 'B')], [g('G1')], [
      dia('d1', 'Zeta', { groupIds: ['G1'], connectionIds: ['c1'] }),
      dia('d2', 'alpha', { groupIds: ['G1'] }),
      dia('d3', 'Mid', { connectionIds: [] }),
    ])
    const group = await roEntityDiagrams(client, WS, 'group', 'G1')
    expect(group.total).toBe(2)
    expect(group.diagrams.map((d) => d.id)).toEqual(['d2', 'd1'])
    expect(await roEntityDiagrams(client, WS, 'group', 'G1', { limit: 1 })).toMatchObject({ total: 2 })
    expect((await roEntityDiagrams(client, WS, 'connection', 'c1')).diagrams.map((d) => d.id)).toEqual(['d1'])
    expect(await roEntityDiagrams(client, WS, 'connection', 'nope')).toEqual({ diagrams: [], total: 0 })
  })

  it('relatedDiagrams: bounds a large fan-out and searches beyond the first page', async () => {
    const diagrams = Array.from({ length: 120 }, (_, index): DiagramInput => {
      const suffix = String(index).padStart(3, '0')
      return {
        id: `fan-${suffix}`,
        name: `Shared architecture ${suffix}`,
        type: 'container',
        objectIds: ['shared'],
        connectionIds: [],
        groupIds: [],
      }
    })
    await build([o('shared')], [], [], diagrams)

    const bounded = await roRelatedDiagrams(client, WS, 'shared', null, { limit: 25 })
    expect(bounded.reference).toHaveLength(25)
    expect(bounded.totals).toEqual({ detail: 0, reference: 120, parent: 0 })
    expect(bounded.limit).toBe(25)
    expect(bounded.truncated).toBe(true)

    const tail = await roRelatedDiagrams(client, WS, 'shared', null, { query: '119', limit: 25 })
    expect(tail.reference.map((diagram) => diagram.id)).toEqual(['fan-119'])
    expect(tail.totals.reference).toBe(1)
    expect(tail.truncated).toBe(false)
  })

  it('search: finds objects by technologies[] (denormalized column + scoring)', async () => {
    await build(
      [
        o('o-arr', { name: 'Stream processor', technologies: [{ name: 'Kafka' }, { name: 'Flink' }] }),
        o('o-sing', { name: 'Cache', technology: 'Redis' }),
        o('o-none', { name: 'Plain' }),
      ],
      [],
      []
    )
    const hits = await roSearch(client, WS, 'kafka')
    expect(hits.map((h) => (h.type === 'object' ? h.object.id : ''))).toEqual(['o-arr'])
    expect((await roSearch(client, WS, 'flink')).length).toBe(1)
    expect((await roSearch(client, WS, 'redis')).length).toBe(1) // deprecated singular still works
  })

  it('search: under min chars returns nothing; limit is honored', async () => {
    await build([o('o1', { name: 'aaa' }), o('o2', { name: 'aaa2' }), o('o3', { name: 'aaa3' })], [], [])
    expect(await roSearch(client, WS, 'aa')).toEqual([]) // < 3 chars
    expect((await roSearch(client, WS, 'aaa', 2)).length).toBe(2)
  })

  it('paging: keyset by id with a stable cursor', async () => {
    const objs = Array.from({ length: 5 }, (_, i) => o('o' + i))
    await build(objs, [c('c0', 'o0', 'o1'), c('c1', 'o1', 'o2'), c('c2', 'o2', 'o3')], [])
    const p1 = await roPageObjects(client, WS, { limit: 2 })
    expect(p1.objects.map((x) => x.id)).toEqual(['o0', 'o1'])
    expect(p1.nextCursor).toBe('o1')
    const p2 = await roPageObjects(client, WS, { limit: 2, after: p1.nextCursor })
    expect(p2.objects.map((x) => x.id)).toEqual(['o2', 'o3'])
    const p3 = await roPageObjects(client, WS, { limit: 2, after: p2.nextCursor })
    expect(p3.objects.map((x) => x.id)).toEqual(['o4'])
    expect(p3.nextCursor).toBeNull()

    const cp = await roPageConnections(client, WS, { limit: 2 })
    expect(cp.connections.map((x) => x.id)).toEqual(['c0', 'c1'])
    expect(cp.nextCursor).toBe('c1')
  })
})
