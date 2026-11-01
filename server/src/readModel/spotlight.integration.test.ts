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

// Spotlight over a REAL Postgres: the SQL fold agrees with the JS fold (also on
// a C-locale database, where plain lower() does not), stage 1 never drops a
// candidate the shared evaluator would rank, results are bound to their
// workspace, coverage gaps are declared, the cap is reported, and the stored
// schema is built once and never silently replaced. Gated on TEST_DATABASE_URL
// (ci:local provides it); skipped, it proves nothing.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { FOLD_MARK_RANGES, fold } from '../search/spotlight/fold.js'
import { parseSpotlightQuery } from '../search/spotlight/grammar.js'
import type { SpotlightKind } from '../search/spotlight/grammar.js'
import { prepareSpotlightDoc, rankSpotlight } from '../search/spotlight/evaluate.js'
import type { SpotlightDoc } from '../search/spotlight/evaluate.js'
import { coldBuildReadModel, syncConnectionFlows, type WorkspaceKey } from './projector.js'
import { upsertDecisionRecords } from './derivedStats.js'
import { ensureReadModelSchema } from './schema.js'
import { roSpotlight, type SpotlightVocab } from './spotlight.js'
import {
  SPOTLIGHT_FOLD_FN,
  ensureSpotlightSchema,
  spotlightFoldFunctionSql,
  spotlightFoldProbeCorpus,
  spotlightLedgerName,
  spotlightReadiness,
} from './spotlightSql.js'
import type { Queryable } from './types.js'

const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)

const WS: WorkspaceKey = { landscapeId: 'spot-l', versionId: 'v1' }
const OTHER: WorkspaceKey = { landscapeId: 'spot-other', versionId: 'v1' }

const tech = (...names: string[]) => ({
  // A catalog id that does NOT spell the name, so SQL reading the id instead of
  // snapshot.name cannot pass by coincidence (QA lens).
  technologyUsages: Object.fromEntries(names.map((n, i) => [`u-${n}`, { id: `u-${n}`, technologyId: `cat-${i}`, catalogRevision: 1, snapshot: { schemaVersion: 1, name: n } }])),
  technologyUsageOrder: names.map((n) => `u-${n}`),
})
const tags = (...ids: string[]) => ({ tagAssignments: Object.fromEntries(ids.map((id) => [id, { tagId: id }])), tagOrder: ids })

interface Obj { id: string; type: string; name: string; [k: string]: unknown }
const obj = (id: string, type: string, name: string, extra: Record<string, unknown> = {}): Obj => ({
  id, type, name, scope: 'internal', status: 'live', tagAssignments: {}, tagOrder: [], position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, properties: {}, ...extra,
})

const OBJECTS: Obj[] = [
  obj('sys-pay', 'system', 'Payments', { shortDescription: 'Card + wallet', description: 'Moves money', ...tech('Go'), ...tags('t-pci'), domainId: 'd-fin' }),
  obj('app-api', 'app', 'Payment API', { ...tech('Node.js'), parentId: 'sys-pay' }),
  obj('app-card', 'app', 'Card payments'),
  obj('app-repay', 'app', 'Repayments'),
  obj('cmp-ledger', 'component', 'Ledger', tech('payments-lib')),
  obj('st-db', 'store', 'Orders database', { description: 'Stores payments history', ...tech('PostgreSQL'), status: 'down' }),
  obj('act-cust', 'actor', 'Customer', { scope: 'external' }),
  obj('app-energy', 'app', 'Énergie tarifs', { description: "Calcule les tarifs d'énergie", ...tech('Python') }),
  obj('app-coeur', 'app', 'Cœur métier'),
  obj('st-cache', 'store', 'Session cache', tags('t-pii')),
  obj('sys-athens', 'system', 'ΑΘΗΝΑ ΟΔΟΣ', { description: 'МОСКВА ŁÓDŹ' }),
  // A stale order entry (a concurrent unassign) is NOT a tag; an assignment
  // missing from the order IS one. Both tiers read tags through orderedTagIds.
  obj('app-stale', 'app', 'Stale tags', { tagOrder: ['t-pii'], tagAssignments: {} }),
  obj('app-unordered', 'app', 'Unordered tags', { tagAssignments: { 't-pci': { tagId: 't-pci' } }, tagOrder: [] }),
  // No status, no scope (QA lens).
  obj('app-bare', 'app', 'Bare service', { status: undefined, scope: undefined }),
  // Orders jsonb's key order (length, then bytes) would NOT reproduce (QA lens).
  obj('app-multi', 'app', 'Multi stack', { ...tech('Zeta', 'Go'), tagAssignments: { 't-pci': { tagId: 't-pci' }, 't-pii': { tagId: 't-pii' } }, tagOrder: ['t-pii', 't-pci'] }),
  // A description longer than the wire keeps (600 characters).
  obj('app-long', 'app', 'Longwinded', { description: `${'word '.repeat(200)}tail` }),
  // QA v2: unordered assignments whose jsonb key order (length first) is not sorted order.
  obj('cmp-zulu', 'component', 'Zulu tagged', { tagAssignments: { 't-z': { tagId: 't-z' }, 't-aa': { tagId: 't-aa' } }, tagOrder: [] }),
]
const GROUPS = [{ id: 'grp-zone', name: 'Payments zone', ...tech('Kubernetes') }]
const CONNECTIONS = [
  { id: 'c1', fromId: 'app-api', toId: 'st-db', label: 'Writes orders', ...tech('SQL'), ...tags('t-pci') },
  { id: 'c2', fromId: 'app-card', toId: 'app-api', label: '', description: 'card flow' },
  { id: 'c3', fromId: 'act-cust', toId: 'grp-zone', label: 'Uses' },
  // QA v2: a connection tagged in its assignments only.
  { id: 'c4', fromId: 'st-cache', toId: 'app-api', label: 'Audits', tagAssignments: { 't-pii': { tagId: 't-pii' } }, tagOrder: [] },
]
// What the read model really receives for a diagram: the registry's DiagramMeta
// stub (bridge.ts buildMeta) — no description, no domain, no flows.
const DIAGRAMS = [
  { id: 'd1', name: 'Checkout flow', type: 'container', objectIds: ['sys-pay', 'app-api', 'st-db', 'app-energy'], connectionIds: ['c1'], groupIds: ['grp-zone'] },
  { id: 'd2', name: 'Énergie overview', type: 'context', objectIds: ['app-energy', 'app-coeur'], connectionIds: [], groupIds: [] },
]
const FLOWS_D2 = [{ id: 'f1', name: 'Pay an order', domainId: 'd-fin', steps: [] }]
const ADRS = [
  { id: 'adr-7', number: 7, title: 'Use Postgres for payments', summary: 'Orders need transactions', content: 'We will use it.', status: 'approved', createdAt: '2026-01-01', updatedAt: '2026-01-02' },
  { id: 'adr-1234', number: 1234, title: 'Retry payments', summary: '', content: '', status: 'in-progress', createdAt: '2026-01-01', updatedAt: '2026-01-03' },
  // QA v2: no usable number, so no ADR label on either tier.
  { id: 'adr-neg', number: -3, title: 'Negative numbered', summary: '', content: '', status: 'approved', createdAt: '2026-01-01', updatedAt: '2026-01-04' },
]
const VOCAB: SpotlightVocab = {
  domains: new Map([['d-fin', 'Finance']]),
  tags: new Map([['t-pci', 'PCI scope'], ['t-pii', 'Personal data'], ['t-z', 'Zulu'], ['t-aa', 'Alpha']]),
}

/** The client's adrLabels() (src/lib/search/spotlightModel.ts), written out again. */
const adrLabelsOf = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? [`ADR-${n}`, `ADR-${String(n).padStart(3, '0')}`] : [])

/** The client's orderedTagIds (src/lib/tags/assignments.ts), written out again. */
function orderedTags(e: Record<string, unknown>): string[] {
  const assigned = Object.keys((e.tagAssignments ?? {}) as object)
  const out = ((e.tagOrder as string[] | undefined) ?? []).filter((id, i, all) => assigned.includes(id) && all.indexOf(id) === i)
  for (const id of [...assigned].sort()) if (!out.includes(id)) out.push(id)
  return out
}

/** The documents the browser's resident tier builds from these same entities
 *  (src/lib/search/spotlightModel.ts), written out independently — minus what
 *  the read model cannot hold (spotlight.ts SPOTLIGHT_FIELD_GAPS). */
function expectedDocs(): SpotlightDoc[] {
  const techOf = (e: Record<string, unknown>) => {
    const usages = (e.technologyUsages ?? {}) as Record<string, { snapshot: { name: string } }>
    const order = (e.technologyUsageOrder ?? []) as string[]
    return order.map((id) => usages[id]?.snapshot.name).filter(Boolean)
  }
  const tagsOf = (e: Record<string, unknown>) => orderedTags(e).map((id) => VOCAB.tags.get(id)).filter((v): v is string => !!v)
  const diagramsWith = (field: 'objectIds' | 'connectionIds' | 'groupIds', id: string) =>
    DIAGRAMS.filter((d) => (d[field] as string[]).includes(id)).map((d) => d.name)
  const nameOf = (id: string) => OBJECTS.find((o) => o.id === id)?.name ?? GROUPS.find((g) => g.id === id)?.name ?? ''
  return [
    ...OBJECTS.map((o): SpotlightDoc => ({
      kind: o.type as SpotlightKind, id: o.id, name: o.name,
      description: [o.shortDescription, o.description].filter(Boolean).join('\n'),
      tech: techOf(o), tags: tagsOf(o), status: o.status as string, scope: o.scope as 'internal',
      domain: o.domainId ? VOCAB.domains.get(o.domainId as string) : undefined, diagrams: diagramsWith('objectIds', o.id),
    })),
    ...GROUPS.map((g): SpotlightDoc => ({ kind: 'group', id: g.id, name: g.name, tech: techOf(g), diagrams: diagramsWith('groupIds', g.id) })),
    ...CONNECTIONS.map((c): SpotlightDoc => ({
      kind: 'connection', id: c.id, name: c.label, description: c.description, tech: techOf(c), tags: tagsOf(c),
      diagrams: diagramsWith('connectionIds', c.id), from: nameOf(c.fromId), to: nameOf(c.toId),
    })),
    ...DIAGRAMS.map((d): SpotlightDoc => ({ kind: 'diagram', id: d.id, name: d.name })),
    ...FLOWS_D2.map((f): SpotlightDoc => ({ kind: 'flow', id: f.id, name: f.name, diagrams: ['Énergie overview'] })),
    ...ADRS.map((r): SpotlightDoc => ({
      kind: 'adr', id: r.id, name: r.title, alt: adrLabelsOf(r.number),
      description: [r.summary, r.content].filter(Boolean).join('\n'), status: r.status,
    })),
  ]
}

const QUERIES = [
  'payments', 'pay', 'pa', 'p', 'energie', 'ÉNERGIE', 'coeur', 'métier', 'kind:app', 'kind:object -kind:actor',
  'tech:post', 'tech:go', 'tech:pa', 'tag:pci', 'tag:personal', 'domain:fin', 'in:checkout', 'in:"energie overview"',
  'from:payment', 'to:zone', 'to:orders', 'status:down', 'scope:external', 'has:tech', 'adr-007', 'adr-1234', 'adr', '7',
  'payments -api', 'ledger OR customer', '"orders database"', 'desc:history', 'desc:mo', 'name:pay', 'card', 'writes',
  'kind:connection', 'kind:flow', 'pay an', 'kind:adr status:approved', 'nothing-matches', 'kind:group tech:kub',
  '-kind:app -kind:store -kind:connection', 'flow', 'wallet', "tarifs d'energie",
  // A phrase spanning two fields ("Payments" + "Card + wallet") is in the SQL
  // superset but in no single field: negating the superset would drop Payments.
  '"payments card"', 'kind:system -"payments card"', 'payments -"payments card"',
  // Non-Latin capitals fold through ICU, final sigma included.
  'αθηνα', 'οδος', 'москва', 'lodz', 'tags',
  // QA lens additions, and the OR groups that used to 500 (a dropped group kept its parameters).
  'personal', '-status:down', '-scope:external', 'transactions', '"we will"', 'tech:zeta', 'tail',
  'ledger OR has:tech', 'payments OR -api', 'ledger OR -status:down', 'has:tag OR kind:actor',
]

/** The fields the evaluator reads, folded: equal means the server built the
 *  same document the resident tier would, tech and tag order included. */
function preparedFields(doc: SpotlightDoc) {
  const p = prepareSpotlightDoc(doc)
  return { name: p.name, tech: p.tech, tag: p.tag, status: p.status, scope: p.scope, domain: p.domain, in: p.in, from: p.from, to: p.to }
}

type Shape = { topHit: string | null; sections: Array<{ kind: string; total: number; hits: string[] }> }

const shapeOfServer = (r: Awaited<ReturnType<typeof roSpotlight>>): Shape => ({
  topHit: r.topHit ? `${r.topHit.kind}:${r.topHit.id}` : null,
  sections: r.sections.map((s) => ({ kind: s.kind, total: s.total, hits: s.hits.map((h) => `${h.doc.id}=${h.score}`) })),
})

function shapeOfCore(q: string, perKind: number): Shape {
  const r = rankSpotlight(parseSpotlightQuery(q), expectedDocs().map((d) => prepareSpotlightDoc(d)), perKind)
  return {
    topHit: r.topHit ? `${r.topHit.doc.kind}:${r.topHit.doc.id}` : null,
    sections: r.sections.map((s) => ({ kind: s.kind, total: s.total, hits: s.hits.map((h) => `${h.doc.id}=${h.score}`) })),
  }
}

/** A Queryable that records every statement it forwards. */
function recording(db: Queryable): Queryable & { statements: string[] } {
  const statements: string[] = []
  return {
    statements,
    query: (sql: string, params?: unknown[]) => {
      statements.push(sql)
      return db.query(sql, params)
    },
  } as Queryable & { statements: string[] }
}

suite('Spotlight over Postgres', () => {
  let db: IsolatedSchemaDb
  let client: pg.PoolClient

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'spotlight_search')
    await ensureReadModelSchema(db.pool)
  })
  afterAll(async () => { await db?.teardown() })
  beforeEach(async () => {
    client = await db.pool.connect()
    await client.query('BEGIN')
  })
  afterEach(async () => {
    await client.query('ROLLBACK')
    client.release()
  })

  async function seed(key: WorkspaceKey = WS, { staticWorkspace = true } = {}) {
    await coldBuildReadModel(client, key, null, OBJECTS, CONNECTIONS, GROUPS, DIAGRAMS)
    await syncConnectionFlows(client, key, null, 'd2', FLOWS_D2, true)
    await upsertDecisionRecords(client, key, null, ADRS)
    if (staticWorkspace) {
      await client.query(`INSERT INTO read_model_static_workspaces (landscape_id, version_id, source) VALUES ($1, $2, 'test')`,
        [key.landscapeId, key.versionId])
    }
  }

  it('folds in SQL exactly as in JS, over Latin, Greek, Cyrillic, ligatures, wide forms, whitespace and mixed text', async () => {
    const corpus: string[] = [...spotlightFoldProbeCorpus()]
    for (let c = 0x00a0; c <= 0x024f; c++) corpus.push(`x${String.fromCharCode(c)}Y`)
    corpus.push(
      'Café  Œuvre', 'ÉNERGIE verte', 'Straße', 'ẞ', 'Cœur', 'ﬁle', 'ＡＰＩ',
      'İstanbul', 'Café', 'a᷀b⃐c︠d', ' tab\there\nline nbsp em　ideo﻿bom ',
      'Αθήνα Москва', 'हिन्दी', 'k8s OrderSvc',
      '  leading', 'trailing  ', '', 'ALL CAPS', 'Việt Nam', 'ΟΔΟΣ οδος',
    )
    // Both ends of every removed mark block, and one past the end (QA lens).
    for (const [from, to] of FOLD_MARK_RANGES) for (const c of [from, to, to + 1]) corpus.push(`a${String.fromCodePoint(c)}b`)
    const { rows } = await client.query<{ i: number; folded: string }>(
      `SELECT i::int, ${SPOTLIGHT_FOLD_FN}(t) AS folded FROM unnest($1::text[]) WITH ORDINALITY AS u(t, i)`,
      [corpus],
    )
    // An empty answer has no mismatches: count the rows first (QA lens).
    expect(rows).toHaveLength(corpus.length)
    const mismatches = rows
      .map((r) => ({ input: corpus[r.i - 1], sql: r.folded, js: fold(corpus[r.i - 1]) }))
      .filter((m) => m.sql !== m.js)
      .map((m) => `${JSON.stringify(m.input)}: sql=${JSON.stringify(m.sql)} js=${JSON.stringify(m.js)}`)
    expect(mismatches).toEqual([])
  })

  /** Every query, two page sizes: same ids, scores, order and totals as the
   *  shared evaluator, AND every returned document built field for field as
   *  the resident tier would build it. A query that throws is a difference. */
  async function differencesFromCore(key: WorkspaceKey = WS): Promise<{ differences: string[]; docsCompared: number }> {
    const expected = new Map(expectedDocs().map((d) => [`${d.kind}:${d.id}`, JSON.stringify(preparedFields(d))]))
    const differences: string[] = []
    let docsCompared = 0
    for (const q of QUERIES) {
      for (const perKind of [3, 50]) {
        await client.query('SAVEPOINT q')
        let result: Awaited<ReturnType<typeof roSpotlight>>
        try {
          result = await roSpotlight(client, key, q, { perKind, vocab: VOCAB })
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT q')
          differences.push(`${q} (perKind ${perKind}) THREW ${(error as Error).message}`)
          continue
        }
        const server = shapeOfServer(result)
        const core = shapeOfCore(q, perKind)
        if (JSON.stringify(server) !== JSON.stringify(core)) {
          differences.push(`${q} (perKind ${perKind})\n  server ${JSON.stringify(server)}\n  core   ${JSON.stringify(core)}`)
        }
        for (const s of result.sections) {
          for (const h of s.hits) {
            const { extra: _extra, ...doc } = h.doc
            const got = JSON.stringify(preparedFields(doc))
            docsCompared++
            if (got !== expected.get(`${doc.kind}:${doc.id}`)) {
              differences.push(`${q}: doc ${doc.id}\n  server ${got}\n  core   ${expected.get(`${doc.kind}:${doc.id}`)}`)
            }
          }
        }
      }
    }
    return { differences, docsCompared }
  }

  it('ranks exactly as the shared evaluator does on the same entities, for every query', async () => {
    await seed()
    const { differences, docsCompared } = await differencesFromCore()
    expect(differences).toEqual([])
    // Not a vacuous comparison: the seed answers, ADRs and Greek included.
    expect(docsCompared).toBeGreaterThan(100)
    expect(shapeOfCore('payments', 3).sections.length).toBeGreaterThan(4)
    expect(shapeOfCore('οδος', 3).topHit).toBe('system:sys-athens')
    expect(shapeOfCore('adr-007', 3).topHit).toBe('adr:adr-7')
  })

  it('builds every document from its own workspace when a fork holds the same ids', async () => {
    // Forks of one landscape share entity ids. One seeded before, one after, so
    // a lookup missing its version binding loses whichever way rows come back.
    const fork = (versionId: string) => ({ landscapeId: WS.landscapeId, versionId })
    const forkObjects = OBJECTS.map((o) => ({ ...o, name: `Fork ${o.name}` }))
    const forkGroups = GROUPS.map((g) => ({ ...g, name: `Fork ${g.name}` }))
    const forkDiagrams = DIAGRAMS.map((d) => ({ ...d, name: `Fork ${d.name}` }))
    const seedFork = async (key: WorkspaceKey) => {
      await coldBuildReadModel(client, key, null, forkObjects, CONNECTIONS, forkGroups, forkDiagrams)
      await syncConnectionFlows(client, key, null, 'd2', FLOWS_D2, true)
    }
    await seedFork(fork('v0'))
    await seed()
    await seedFork(fork('v2'))
    const { differences, docsCompared } = await differencesFromCore()
    expect(differences).toEqual([])
    expect(docsCompared).toBeGreaterThan(100)
  })

  it('pushes the text down and keeps the likeliest hits under the cap', async () => {
    await seed()
    const ids = (r: Awaited<ReturnType<typeof roSpotlight>>) => r.sections.flatMap((s) => s.hits.map((h) => h.doc.id)).sort()
    // Stage 1 filters: one object matches, so a cap of one is not reached.
    const ledger = await roSpotlight(client, WS, 'ledger', { perKind: 5, vocab: VOCAB, candidateCap: 1 })
    expect(ids(ledger)).toEqual(['cmp-ledger'])
    expect(ledger.sections.every((s) => !s.totalCapped)).toBe(true)
    // The exact name and the word-start match survive a cap of two, not name order.
    const pay = await roSpotlight(client, WS, 'payments', { kinds: ['system', 'app', 'store', 'component', 'actor'], perKind: 5, vocab: VOCAB, candidateCap: 2 })
    expect(ids(pay)).toEqual(['app-card', 'sys-pay'])
    expect(pay.topHit).toEqual({ kind: 'system', id: 'sys-pay' })
    // Exactly cap rows is not capped.
    const apps = await roSpotlight(client, WS, 'kind:app', { perKind: 50, vocab: VOCAB, candidateCap: 10 })
    expect(apps.sections.find((s) => s.kind === 'app')).toMatchObject({ total: 10, totalCapped: false })
    // A capped family marks EVERY kind it returned as a lower bound.
    const objects = await roSpotlight(client, WS, 'kind:object', { perKind: 50, vocab: VOCAB, candidateCap: 4 })
    expect(objects.sections.map((s) => [s.kind, s.totalCapped])).toEqual([['app', true], ['actor', true]])
  })

  it('returns the display extras of a diagram and an ADR, and trims long descriptions for the wire', async () => {
    await seed()
    const d = (await roSpotlight(client, WS, 'checkout flow', { kinds: ['diagram'], perKind: 5, vocab: VOCAB })).sections[0].hits[0].doc
    expect(d.extra).toMatchObject({ type: 'container', objectCount: 4, connectionCount: 1 })
    const a = (await roSpotlight(client, WS, 'adr-7', { kinds: ['adr'], perKind: 5, vocab: VOCAB })).sections[0].hits[0].doc
    expect(a.extra).toMatchObject({ number: 7, summary: 'Orders need transactions' })
    // Ranked on the whole text ("tail" is past 600), sent trimmed.
    const long = (await roSpotlight(client, WS, 'tail', { perKind: 5, vocab: VOCAB })).sections[0].hits[0].doc
    expect(long.id).toBe('app-long')
    expect(long.description).toHaveLength(600)
    // How many diagrams place it: the wire caps the NAMES at 12, the count is whole.
    const energy = (await roSpotlight(client, WS, 'energie tarifs', { kinds: ['app'], perKind: 5, vocab: VOCAB })).sections[0].hits[0].doc
    expect(energy).toMatchObject({ id: 'app-energy', extra: { diagramCount: 2 } })
    const zone = (await roSpotlight(client, WS, 'payments zone', { kinds: ['group'], perKind: 5, vocab: VOCAB })).sections[0].hits[0].doc
    expect(zone).toMatchObject({ id: 'grp-zone', extra: { diagramCount: 1 } })
    const writes = (await roSpotlight(client, WS, 'writes orders', { kinds: ['connection'], perKind: 5, vocab: VOCAB })).sections[0].hits[0].doc
    expect(writes).toMatchObject({ id: 'c1', extra: { diagramCount: 1 } })
  })

  it('counts every placing diagram past the twelve names the wire keeps (QA)', async () => {
    const key: WorkspaceKey = { landscapeId: 'spot-count', versionId: 'v1' }
    const objects = [obj('o-many', 'system', 'Manyplaced'), obj('o-two', 'app', 'Twoplaced'), obj('o-end', 'app', 'Endpoint')]
    const groups = [{ id: 'g-two', name: 'Twozone' }]
    const connections = [{ id: 'c-two', fromId: 'o-two', toId: 'o-end', label: 'Twolink' }]
    const diagrams = Array.from({ length: 13 }, (_, i) => ({
      id: `dm${i}`, name: `Diagram ${String(i).padStart(2, '0')}`, type: 'context',
      objectIds: i < 2 ? ['o-many', 'o-two', 'o-end'] : ['o-many'],
      connectionIds: i < 2 ? ['c-two'] : [],
      groupIds: i < 2 ? ['g-two'] : [],
    }))
    await coldBuildReadModel(client, key, null, objects, connections, groups, diagrams)
    const first = async (q: string, kind: 'system' | 'app' | 'group' | 'connection') =>
      (await roSpotlight(client, key, q, { kinds: [kind], perKind: 5, vocab: VOCAB })).sections[0].hits[0].doc
    const many = await first('manyplaced', 'system')
    expect(many.diagrams).toHaveLength(12)
    expect(many.extra.diagramCount).toBe(13)
    expect((await first('twoplaced', 'app')).extra.diagramCount).toBe(2)
    expect((await first('twozone', 'group')).extra.diagramCount).toBe(2)
    expect((await first('twolink', 'connection')).extra.diagramCount).toBe(2)
  })

  it('passes a diagram domain through as an extra when the read model holds one (QA v2)', async () => {
    await coldBuildReadModel(client, WS, null, OBJECTS, CONNECTIONS, GROUPS, [{ ...DIAGRAMS[0], domainId: 'd-fin' }])
    const d = (await roSpotlight(client, WS, 'checkout', { kinds: ['diagram'], perKind: 5, vocab: VOCAB })).sections[0].hits[0].doc
    expect(d.extra.domainId).toBe('d-fin')
  })

  it('reads tags as orderedTagIds does: a stale order entry is not a tag', async () => {
    await seed()
    const ids = async (q: string) => (await roSpotlight(client, WS, q, { perKind: 50, vocab: VOCAB })).sections.flatMap((s) => s.hits.map((h) => h.doc.id))
    // app-stale lists t-pii only in its order: not tagged. app-unordered holds
    // t-pci only in its assignments: tagged.
    expect((await ids('tag:personal')).sort()).toEqual(['app-multi', 'c4', 'st-cache'])
    expect(await ids('tag:personal')).not.toContain('app-stale')
    expect((await ids('tag:pci')).sort()).toEqual(['app-multi', 'app-unordered', 'c1', 'sys-pay'])
  })

  it('declares what the read model cannot answer', async () => {
    await seed(WS, { staticWorkspace: false })
    // Another workspace being static says nothing about this one (QA v2).
    await client.query(`INSERT INTO read_model_static_workspaces (landscape_id, version_id, source) VALUES ($1, $2, 'test')`,
      [OTHER.landscapeId, OTHER.versionId])
    const r = await roSpotlight(client, WS, 'payments', { perKind: 5, vocab: VOCAB })
    expect(r.coverage).toEqual({ unavailableKinds: ['adr'], fieldGaps: { diagram: ['desc', 'domain'], flow: ['domain'] } })
    expect(r.sections.map((s) => s.kind)).not.toContain('adr')
  })

  it('narrows to the requested kinds', async () => {
    await seed()
    const r = await roSpotlight(client, WS, 'payments', { kinds: ['diagram', 'adr'], perKind: 5, vocab: VOCAB })
    expect(r.sections.map((s) => s.kind)).toEqual(['adr'])
  })

  it('never answers from another workspace', async () => {
    await seed()
    await coldBuildReadModel(client, OTHER, null, [obj('secret', 'system', 'Payments secret')], [], [], [])
    const mine = await roSpotlight(client, WS, 'secret', { perKind: 5, vocab: VOCAB })
    expect(mine.sections).toEqual([])
    const theirs = await roSpotlight(client, OTHER, 'payments', { perKind: 5, vocab: VOCAB })
    expect(theirs.sections.flatMap((s) => s.hits.map((h) => h.doc.id))).toEqual(['secret'])
  })

  it('reports a capped family as a lower bound, keeping name order for a filters-only query', async () => {
    await seed()
    const r = await roSpotlight(client, WS, 'kind:app', { perKind: 50, vocab: VOCAB, candidateCap: 2 })
    const apps = r.sections.find((s) => s.kind === 'app')!
    expect(apps.totalCapped).toBe(true)
    expect(apps.total).toBe(2)
    // Folded name order: bare service, card payments, coeur metier, energie tarifs, ...
    expect(apps.hits.map((h) => h.doc.id)).toEqual(['app-bare', 'app-card'])
    const full = await roSpotlight(client, WS, 'kind:app', { perKind: 50, vocab: VOCAB })
    expect(full.sections.find((s) => s.kind === 'app')).toMatchObject({ total: 10, totalCapped: false })
  })

  it('returns what the client needs to show an entity it does not hold', async () => {
    await seed()
    const r = await roSpotlight(client, WS, 'payment api', { perKind: 5, vocab: VOCAB })
    const api = r.sections.find((s) => s.kind === 'app')!.hits[0].doc
    expect(api).toMatchObject({ id: 'app-api', name: 'Payment API', tech: ['Node.js'], diagrams: ['Checkout flow'], extra: { parentName: 'Payments' } })
    const conn = (await roSpotlight(client, WS, 'card flow', { perKind: 5, vocab: VOCAB })).sections.find((s) => s.kind === 'connection')!.hits[0].doc
    expect(conn).toMatchObject({ id: 'c2', from: 'Card payments', to: 'Payment API', extra: { fromId: 'app-card', toId: 'app-api' } })
  })

  it('stops between families once aborted', async () => {
    await seed()
    const controller = new AbortController()
    controller.abort()
    await expect(roSpotlight(client, WS, 'payments', { perKind: 5, vocab: VOCAB, signal: controller.signal })).rejects.toThrow(/aborted/)
  })

  describe('the stored schema', () => {
    it('is built once, recorded, and ready', async () => {
      const { rows } = await client.query<{ name: string }>(`SELECT name FROM read_model_schema_migrations WHERE name LIKE 'spotlight:%'`)
      expect(rows.map((r) => r.name)).toEqual([spotlightLedgerName('icu')])
      expect(await spotlightReadiness(client)).toEqual({ ready: true })
    })

    it('takes no ACCESS EXCLUSIVE lock on a later boot: no ALTER once the columns exist', async () => {
      const rec = recording(client)
      await ensureSpotlightSchema(rec)
      expect(rec.statements.filter((s) => /^\s*ALTER TABLE/i.test(s))).toEqual([])
    })

    it('re-adds exactly the missing columns, one ALTER per table, judged in its own schema only (QA v2)', async () => {
      // A decoy schema whose ro_objects HAS the columns must not count.
      await client.query(`CREATE SCHEMA spot_decoy`)
      await client.query(`CREATE TABLE spot_decoy.ro_objects (spot_name text, spot_text text)`)
      await client.query(`ALTER TABLE ro_objects DROP COLUMN spot_name, DROP COLUMN spot_text`)
      await client.query(`ALTER TABLE ro_connections DROP COLUMN spot_text`)
      const rec = recording(client)
      await ensureSpotlightSchema(rec)
      const alters = rec.statements.filter((s) => /^\s*ALTER TABLE/i.test(s))
      expect(alters).toHaveLength(2)
      expect(alters[0]).toMatch(/^ALTER TABLE ro_objects ADD COLUMN spot_name .*, ADD COLUMN spot_text /s)
      expect(alters[1]).toMatch(/^ALTER TABLE ro_connections ADD COLUMN spot_text /)
      expect(alters[1]).not.toContain('spot_name')
    })

    // Regression (QA lens v2): the server labelled a 2.5-numbered record ADR-2
    // because the write path floors `adr_number`; the client labels it nothing.
    it('gives a fractional ADR number no label, as the client does', async () => {
      await upsertDecisionRecords(client, WS, null, [{ ...ADRS[0], id: 'adr-frac', number: 2.5, title: 'Fractional numbered' }])
      await client.query(`INSERT INTO read_model_static_workspaces (landscape_id, version_id, source) VALUES ($1, $2, 'test')`, [WS.landscapeId, WS.versionId])
      const r = await roSpotlight(client, WS, 'adr-2', { kinds: ['adr'], perKind: 5, vocab: VOCAB })
      expect(r.sections.flatMap((s) => s.hits.map((h) => h.doc.id))).not.toContain('adr-frac')
    })

    it('leaves a database built with another fingerprint untouched, and refuses to answer on it', async () => {
      await client.query(`INSERT INTO read_model_schema_migrations (name) VALUES ('spotlight:icu:0000')`)
      const rec = recording(client)
      await ensureSpotlightSchema(rec)
      expect(rec.statements.filter((s) => /CREATE|ALTER|INSERT/i.test(s))).toEqual([])
      expect(await spotlightReadiness(client)).toMatchObject({ ready: false, reason: 'drift' })
    })

    it('is "not built" before ensureSpotlightSchema ran', async () => {
      await client.query(`DELETE FROM read_model_schema_migrations WHERE name LIKE 'spotlight:%'`)
      expect(await spotlightReadiness(client)).toMatchObject({ ready: false, reason: 'not-built' })
    })
  })
})

// A database whose LC_CTYPE is C (this repo's embedded dev clusters): plain
// lower() folds ASCII only. The ICU fold must still equal the JS fold there, and
// the readiness probe must catch a fold that does not.
suite('Spotlight fold on a C-locale database', () => {
  const name = 'spotlight_c_locale_test'
  let admin: pg.Client
  let c: pg.Client

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: connection })
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS ${name}`)
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`)
    const url = new URL(connection!)
    url.pathname = `/${name}`
    c = new pg.Client({ connectionString: url.toString() })
    await c.connect()
    await c.query(`CREATE TABLE read_model_schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
  })
  afterAll(async () => {
    await c?.end()
    await admin?.query(`DROP DATABASE IF EXISTS ${name}`)
    await admin?.end()
  })

  it('really is a database where lower() folds ASCII only', async () => {
    const { rows } = await c.query<{ l: string }>(`SELECT lower('ΟΔΟΣ Ł') AS l`)
    expect(rows[0].l).toBe('ΟΔΟΣ Ł')
  })

  it('folds through ICU exactly as JS does', async () => {
    await c.query(spotlightFoldFunctionSql('icu'))
    await c.query(`INSERT INTO read_model_schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [spotlightLedgerName('icu')])
    expect(await spotlightReadiness(c)).toEqual({ ready: true })
  })

  it('catches a fold that lowercases through the ctype, and refuses to answer', async () => {
    await c.query(spotlightFoldFunctionSql('ctype'))
    const verdict = await spotlightReadiness(c)
    expect(verdict).toMatchObject({ ready: false, reason: 'fold-mismatch' })
  })

  it('catches a fold wrong in only one script: the probe covers Latin, Greek and Cyrillic (QA v2)', async () => {
    await c.query(spotlightFoldFunctionSql('icu').replace(SPOTLIGHT_FOLD_FN, 'qa_fold_base'))
    for (const [from, to] of [['ŋ', 'n'], ['σ', 's'], ['ж', 'z']]) {
      await c.query(`CREATE OR REPLACE FUNCTION ${SPOTLIGHT_FOLD_FN}(t text) RETURNS text LANGUAGE sql IMMUTABLE STRICT
        AS $f$ SELECT replace(qa_fold_base(t), '${from}', '${to}') $f$`)
      expect(await spotlightReadiness(c), from).toMatchObject({ ready: false, reason: 'fold-mismatch' })
    }
    // The control: the unbroken fold is ready.
    await c.query(`CREATE OR REPLACE FUNCTION ${SPOTLIGHT_FOLD_FN}(t text) RETURNS text LANGUAGE sql IMMUTABLE STRICT
      AS $f$ SELECT qa_fold_base(t) $f$`)
    expect(await spotlightReadiness(c)).toEqual({ ready: true })
  })
})

// A database that cannot normalize (SQL_ASCII): no Spotlight schema at all, and
// readiness says why (QA v2).
suite('Spotlight on a non-UTF8 database', () => {
  const name = 'spotlight_ascii_qa_test'
  let admin: pg.Client
  let c: pg.Client

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: connection })
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS ${name}`)
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C'`)
    const url = new URL(connection!)
    url.pathname = `/${name}`
    c = new pg.Client({ connectionString: url.toString() })
    await c.connect()
    await c.query(`CREATE TABLE read_model_schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
  })
  afterAll(async () => {
    await c?.end()
    await admin?.query(`DROP DATABASE IF EXISTS ${name}`)
    await admin?.end()
  })

  it('builds nothing and reports the encoding', async () => {
    await ensureSpotlightSchema(c)
    const { rows } = await c.query<{ fn: string | null }>(`SELECT to_regproc('${SPOTLIGHT_FOLD_FN}')::text AS fn`)
    expect(rows[0].fn).toBeNull()
    expect(await spotlightReadiness(c)).toEqual({ ready: false, reason: 'encoding' })
  })
})
