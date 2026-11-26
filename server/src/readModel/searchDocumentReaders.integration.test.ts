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

/**
 * The two readers of `search_document` and their trigram index
 * `idx_ro_objects_search_trgm` (kept; an earlier plan dropped it).
 *
 *  1. THE SCHEMA creates the index (the searches under load need it).
 *  2. RESULT IDENTITY, indexed and not, on the prototype's query set
 *     (the prototype's search-diff bench: accents
 *     written and dropped, casing, ligatures, ß, a double space in the data,
 *     every technology representation — legacy `technology`,
 *     `technologies[]`, governed `technologyUsages`, none — shortDescription,
 *     a match across two fields, %, _): through the two production readers
 *     of `search_document`, `roSearch` (every hit, ranked) and
 *     `roObjectSearchPage` (every page, walked by cursor). The indexed pass
 *     runs with `enable_seqscan = off`, and its plan is checked to name the
 *     index; the other with index and bitmap scans off. So the comparison is
 *     not two sequential scans agreeing, and the index changes no result.
 *  3. THE SEMANTICS pinned: what the prototype's variant (a) (readers on
 *     `spot_text`) would have changed.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { coldBuildReadModel } from './projector.js'
import { RO_SEARCH_OBJECTS_SQL, roSearch } from './queries.js'
import { roObjectSearchPage } from './objectExplorer.js'
import { ensureReadModelSchema, warnIfSearchIndexInvalid } from './schema.js'
import type { ObjectInput } from './types.js'

const CONNECTION = process.env.TEST_DATABASE_URL
const suite = CONNECTION ? describe : describe.skip

const WS = { landscapeId: 'ls-search-readers', versionId: 'v1' }
/** Same texts in a second workspace: no reader may leak into it. */
const OTHER = { landscapeId: 'ls-search-readers-other', versionId: 'v1' }

// The prototype's crafted workspace (its search-diff bench, branch proto-cold-wal).
const NAMES = [
  'Système de facturation', 'Gestion des commandes', 'Café Résumé', 'Élève Inscription',
  'Société Générale Connecteur', 'Hôpital Données', 'Données clients', 'Crème brûlée API',
  'Noël Planner', 'Zoë Façade', 'ÉTÉ Batch', 'Garçon Router', 'Ångström Gateway',
  'Straße Mapper', 'Œuvre Catalogue', 'naïve Cache', 'Ægir Store', 'Ørsted Feed',
  'Portail Québec', 'Montréal Billing', 'Réservations Hôtel', 'Paiement Carte',
  'Service  Double  Espace', 'API Passerelle', 'Gestionnaire d’événements',
]
const DESCRIPTIONS = [
  'Traitement des réservations à l’échelle', 'Synchronise les données clients vers le CRM',
  'Expose une API REST publique', 'Calcule la facturation mensuelle 50% plus vite', 'Journalise les événements_métier',
]
const SHORTS = ['Mise à jour quotidienne', 'Temps réel', 'Lecture seule', 'Archivage légal', 'Haute disponibilité']
const TECHS = ['PostgreSQL', 'Kafka', 'Redis', 'Node.js', 'Elasticsearch']

/** Each name in four technology representations (A legacy `technology`,
 *  B `technologies[]`, C governed `technologyUsages`, D none but a
 *  `shortDescription`) and two casings, with a parent chain so the explorer
 *  has child counts to report. */
function crafted(prefix = ''): ObjectInput[] {
  const out: ObjectInput[] = []
  NAMES.forEach((name, n) => {
    const tech = TECHS[n % TECHS.length]!
    const description = DESCRIPTIONS[n % DESCRIPTIONS.length]!
    for (const rep of ['A', 'B', 'C', 'D'] as const) {
      for (const casing of ['as', 'upper'] as const) {
        const id = `${prefix}c-${String(n).padStart(2, '0')}-${rep}-${casing}`
        const object: ObjectInput = {
          id, type: 'container',
          name: casing === 'upper' ? name.toUpperCase() : name,
          description: rep === 'D' ? '' : description,
          ...(n > 0 && rep === 'A' ? { parentId: `${prefix}c-00-A-${casing}` } : {}),
        }
        if (rep === 'A') object.technology = tech
        if (rep === 'B') object.technologies = [{ name: tech }]
        if (rep === 'C') {
          object.technologyUsages = {
            [`u-${id}`]: { id: `u-${id}`, technologyId: `t-${tech.toLowerCase()}`, catalogRevision: 1, snapshot: { name: tech } },
          }
        }
        if (rep === 'D') object.shortDescription = SHORTS[n % SHORTS.length]
        out.push(object)
      }
    }
  })
  return out
}

/** 20 000 objects no query matches (letters k q w x y j h v and digits only),
 *  so that the workspace is large enough for the planner to prefer the
 *  trigram index over the workspace's B-tree in the BEFORE pass. */
function filler(): ObjectInput[] {
  const letters = 'kqwxyjhv'
  const word = (n: number) => Array.from({ length: 6 }, (_, k) => letters[(n * 7 + k * 13 + (n >> k)) % letters.length]).join('')
  return Array.from({ length: 20_000 }, (_, n) => ({
    id: `f-${n}`, type: 'component',
    name: `${word(n)} ${n}`,
    description: `${word(n + 1)} ${word(n + 2)} ${word(n + 3)} ${n % 97}`,
    technology: word(n + 4),
  }))
}

/** The prototype's queries that target the crafted workspace, plus LIKE's specials. */
const QUERIES = [
  'facturation', 'FACTURATION', 'Système', 'systeme', 'café', 'cafe', 'ÉLÈVE', 'eleve', 'données',
  'oeuvre', 'œuvre', 'strasse', 'straße', 'ørsted', 'montreal', 'montréal', 'service double', 'service  double',
  'événements', 'postgresql', 'KAFKA', 'redis', 'node.js', 'quotidienne', 'temps réel', 'réservations', 'api rest',
  'facturation postgresql', 'gestion commandes', '50%', 'événements_métier', 'e_m', 'zz', 'ap', 'api', 'zzz-none',
]

suite('search_document readers: the trigram index changes no result', () => {
  let db: IsolatedSchemaDb

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(CONNECTION!, 'ro_search_readers')
    await ensureReadModelSchema(db.pool)
    await coldBuildReadModel(db.pool, WS, null, [...crafted(), ...filler()], [])
    await coldBuildReadModel(db.pool, OTHER, null, crafted('other-'), [])
    await db.pool.query('ANALYZE ro_objects')
  }, 120_000)

  afterAll(async () => {
    await db?.teardown()
  })

  const indexNames = async () => (await db.pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'ro_objects' ORDER BY 1`,
  )).rows.map((row) => row.indexname)

  /** Every hit and every explorer page, for every query, read on ONE client. */
  const readAll = async (client: pg.PoolClient) => {
    const out: Record<string, { search: string[]; explorer: string[][]; total: number }> = {}
    for (const q of QUERIES) {
      const hits = await roSearch(client, WS, q, 100_000)
      const search = hits.map((hit) => (hit.type === 'object'
        ? `o:${String((hit.object as { id: unknown }).id)}`
        : `c:${String((hit.connection as { id: unknown }).id)}`))
      const explorer: string[][] = []
      let total = -1
      let after: string | null = null
      for (let page = 0; page < 50; page++) {
        const result = await roObjectSearchPage(client, WS, { query: q, after, limit: 7 })
        total = result.total
        explorer.push(result.items.map((item) => `${item.kind}:${item.id}:${item.childCount}`))
        if (!result.nextCursor) break
        after = result.nextCursor
      }
      out[q] = { search, explorer, total }
    }
    return out
  }

  const withClient = async <T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await db.pool.connect()
    try {
      return await work(client)
    } finally {
      await client.query('RESET ALL').catch(() => undefined)
      client.release()
    }
  }

  it('the schema creates the index', async () => {
    await ensureReadModelSchema(db.pool)
    const names = await indexNames()
    expect(names).toContain('idx_ro_objects_search_trgm')
    expect(names).toContain('idx_ro_objects_name_trgm')
    expect(names).toContain('idx_ro_objects_spot_trgm')
  })

  it('the object explorer\'s search_document statement can use the index', async () => {
    // The index is kept for BOTH readers: a predicate rewritten so the
    // index cannot serve it (same results, e.g. `(o.search_document || '')`)
    // passed every other test. The explorer's own statement, captured from
    // its call, must be servable by the index.
    await withClient(async (client) => {
      const seen: Array<{ text: string; values?: unknown[] }> = []
      const recording = {
        query: ((text: string, values?: unknown[]) => { seen.push({ text, values }); return client.query(text, values) }),
      } as unknown as pg.PoolClient
      await roObjectSearchPage(recording, WS, { query: 'facturation', limit: 7 })
      const statements = seen.filter((s) => /search_document LIKE/.test(s.text))
      expect(statements.length).toBeGreaterThan(0)
      await client.query('SET enable_seqscan = off')
      for (const statement of statements) {
        const { rows } = await client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${statement.text}`, statement.values)
        expect(JSON.stringify(rows[0]!['QUERY PLAN']), statement.text.slice(0, 200)).toContain('"Index Name":"idx_ro_objects_search_trgm"')
      }
    })
  })

  it('the indexed read and the unindexed read return the same, for every query and both readers', async () => {
    const before = await withClient(async (client) => {
      await client.query('SET enable_seqscan = off')
      // Not vacuous: the BEFORE read is the indexed one.
      const { rows } = await client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${RO_SEARCH_OBJECTS_SQL}`, [WS.landscapeId, WS.versionId, '%facturation%'],
      )
      expect(JSON.stringify(rows[0]!['QUERY PLAN'])).toContain('"Index Name":"idx_ro_objects_search_trgm"')
      return readAll(client)
    })
    // Not vacuous either: the set separates the representations and matches.
    expect(before['postgresql']!.search.length).toBeGreaterThanOrEqual(10)
    expect(before['facturation']!.explorer.flat().length).toBeGreaterThanOrEqual(8)
    expect(before['zzz-none']!.search).toEqual([])
    // The SEMANTICS pinned, not only their sameness: what the prototype's
    // variant (a) (readers on spot_text) changed. A technology-only match
    // (legacy `technology`, `technologies[]`) is found by both readers; the
    // governed technologyUsages and an accent dropped are not (search_document
    // has neither the snapshot names nor a fold).
    const explorerIds = (q: string) => before[q]!.explorer.flat().map((row) => row.split(':')[1])
    for (const id of ['c-00-A-as', 'c-00-B-as', 'c-00-A-upper', 'c-00-B-upper']) {
      expect(explorerIds('postgresql'), id).toContain(id)
      expect(before['postgresql']!.search, id).toContain(`o:${id}`)
    }
    expect(explorerIds('postgresql')).not.toContain('c-00-C-as')
    // LIKE's specials are LITERAL for the explorer too (an ESCAPE character
    // other than the one likeLiteral writes used to pass every test).
    const literally = (text: string) => crafted().filter((o) =>
      `${o.name} ${o.description ?? ''}`.toLowerCase().includes(text)).map((o) => o.id).sort()
    expect(literally('50%').length).toBeGreaterThan(0)
    expect([...explorerIds('50%')].sort()).toEqual(literally('50%'))
    expect([...explorerIds('événements_métier')].sort()).toEqual(literally('événements_métier'))
    expect(explorerIds('e_m')).toEqual([])
    expect(explorerIds('systeme')).toEqual([])
    expect(explorerIds('quotidienne')).toEqual([])
    expect(Object.values(before).every((side) => side.search.every((id) => !id.includes('other-')))).toBe(true)

    // The same reads with the index out of the planner's reach.
    const unindexed = await withClient(async (client) => {
      await client.query('SET enable_bitmapscan = off')
      await client.query('SET enable_indexscan = off')
      const { rows } = await client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${RO_SEARCH_OBJECTS_SQL}`, [WS.landscapeId, WS.versionId, '%facturation%'],
      )
      expect(JSON.stringify(rows[0]!['QUERY PLAN'])).not.toContain('idx_ro_objects_search_trgm')
      return readAll(client)
    })
    const plain = await withClient(readAll)
    for (const q of QUERIES) {
      expect(unindexed[q], JSON.stringify(q)).toEqual(before[q])
      expect(plain[q], JSON.stringify(q)).toEqual(before[q])
    }
  })

  it('the baseline reports an INVALID search index loudly; REINDEX CONCURRENTLY repairs it (a database 0007 went through)', async () => {
    // The state an interrupted 0007 drop left: DROP INDEX CONCURRENTLY marks
    // the index invalid, then gives up behind an older transaction.
    const holder = await db.pool.connect()
    const dropper = await db.pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT 1 FROM ro_objects LIMIT 1')
      await dropper.query(`SET lock_timeout = '300ms'`)
      await expect(dropper.query('DROP INDEX CONCURRENTLY idx_ro_objects_search_trgm')).rejects.toMatchObject({ code: '55P03' })
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await dropper.query('RESET lock_timeout').catch(() => undefined)
      holder.release()
      dropper.release()
    }
    const state = async () => (await db.pool.query<{ valid: boolean }>(
      `SELECT (x.indisvalid AND x.indisready) AS valid FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
        WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = 'idx_ro_objects_search_trgm'`,
    )).rows[0]?.valid
    expect(await state()).toBe(false)
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { errors.push(String(line)) })
    try {
      // `CREATE INDEX IF NOT EXISTS` keeps the INVALID index: the baseline says so.
      await ensureReadModelSchema(db.pool)
    } finally {
      spy.mockRestore()
    }
    expect(await state()).toBe(false)
    const events = errors.filter((line) => line.includes('read_model.search_index_invalid'))
    expect(events.length).toBe(1)
    expect(JSON.parse(events[0]!)).toMatchObject({ index: 'idx_ro_objects_search_trgm' })
    // The documented remedy (docs/schema-migrations.md), then a quiet baseline.
    await db.pool.query('REINDEX INDEX CONCURRENTLY idx_ro_objects_search_trgm')
    expect(await state()).toBe(true)
    const again: string[] = []
    expect(await warnIfSearchIndexInvalid(db.pool, (line) => again.push(line))).toBe(false)
    expect(again).toEqual([])
  })
})

