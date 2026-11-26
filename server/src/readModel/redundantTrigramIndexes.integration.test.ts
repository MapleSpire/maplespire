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
 * The two per-column trigram indexes of `ro_objects` (`lower(description)`,
 * `lower(technology)`) are gone, and nothing a search returns changed.
 *
 *  1. RESULT EQUALITY. `roSearch`'s object filter now prefilters on
 *     `search_document` and rechecks the per-column predicate
 *     (`RO_SEARCH_OBJECTS_SQL`). It is run beside the SQL it replaced
 *     (`PREVIOUS_SQL`, copied verbatim from the previous build) over texts chosen to
 *     separate them: case, accents, an empty description or technology (the
 *     columns are NOT NULL; an absent field is ''), `%`, `_`, a backslash,
 *     multi-word queries, and queries that only exist ACROSS a field boundary
 *     in `search_document` — the ones the recheck is there for.
 *  2. THE PLAN on an 85 000-object workspace: the rewritten filter is served by
 *     `idx_ro_objects_search_trgm`, not by a sequential scan.
 *  3. THE MIGRATION drops both indexes where they exist, through the real
 *     runner (non-transactional: CONCURRENTLY is refused in a transaction), is
 *     idempotent, and the baseline no longer re-creates them.
 *  4. THE LOCKS: while the concurrent drop waits for a transaction that holds
 *     a lock on `ro_objects`, other sessions still read and write the table; a
 *     plain `DROP INDEX` in the same position blocks a reader (the control).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { coldBuildReadModel, upsertObjects } from './projector.js'
import { RO_SEARCH_OBJECTS_SQL, roSearch } from './queries.js'
import { dropRedundantObjectTrigramIndexes, ensureReadModelSchema, REDUNDANT_OBJECT_TRIGRAM_INDEXES } from './schema.js'
import { MIGRATION_ADVISORY_LOCK_KEY, runMigrations } from '../db/migrations.js'
import { schemaMigrations } from '../db/schemaMigrations.js'
import { inspectRedundantTrigramIndexes, RedundantIndexDropRetry, redundantIndexRetryMetricSamples } from './redundantIndexDropRetry.js'
import type { ObjectInput } from './types.js'

/** Ticks until a tick ran with the migration key (another file's migrations
 *  may hold it for a moment: CI runs integration files in parallel). */
async function tickUntilKeyFree(target: RedundantIndexDropRetry): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const busy = target.snapshot().attempts.keyBusy
    await target.tick()
    if (target.snapshot().attempts.keyBusy === busy) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('the migration key stayed busy for 10 s')
}

function gauge(target: RedundantIndexDropRetry, index: string, state: 'valid' | 'invalid'): number | undefined {
  return redundantIndexRetryMetricSamples(target)
    .find((sample) => sample.name === 'maplespire_read_model_redundant_trigram_index')!
    .values.find((value) => value.labels?.index === index && value.labels?.state === state)?.value
}

const CONNECTION = process.env.TEST_DATABASE_URL
const suite = CONNECTION ? describe : describe.skip

/** `roSearch`'s object filter as it was before the change. */
const PREVIOUS_SQL = `SELECT data FROM ro_objects
       WHERE landscape_id = $1 AND version_id = $2
         AND (lower(name) LIKE $3 ESCAPE '\\'
          OR lower(technology) LIKE $3 ESCAPE '\\'
          OR lower(description) LIKE $3 ESCAPE '\\')`

/** The DDL the previous build's baseline ran: what an existing database still has. */
const PREVIOUS_INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS idx_ro_objects_desc_trgm ON ro_objects USING gin (lower(description) public.gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_ro_objects_tech_trgm ON ro_objects USING gin (lower(technology) public.gin_trgm_ops)`,
]

/** `likePattern` in queries.ts, applied to the query as `roSearch` lowers it. */
const like = (q: string) => `%${q.trim().toLowerCase().replace(/([%_\\])/g, '\\$1')}%`

const WS = { landscapeId: 'ls-trgm', versionId: 'v1' }
/** A second workspace holding the same texts: neither query may leak into it. */
const OTHER = { landscapeId: 'ls-trgm-other', versionId: 'v1' }

const o = (id: string, over: Partial<ObjectInput>): ObjectInput => ({ id, type: 'app', ...over })

const CORPUS: ObjectInput[] = [
  o('gateway', { name: 'Gateway', description: 'Ledger of every payment', technology: 'Kafka' }),
  o('ledger', { name: 'Ledger', description: 'Books 50% of the trades', technology: 'Postgres' }),
  o('upper', { name: 'PAYMENT SERVICE', description: 'Takes CARDS', technologies: [{ name: 'Java' }, { name: 'Spring Boot' }] }),
  o('accents', { name: 'École Centrale', description: 'Café crème, déjà vu', technology: 'Élixir' }),
  o('greek', { name: 'ΟΔΟΣ', description: 'Σίσυφος', technology: 'ΣΣ' }),
  o('no-desc', { name: 'Lonely', technology: 'Redis' }),
  o('no-tech', { name: 'Untooled', description: 'Plain text only' }),
  o('nothing', { name: 'Bare' }),
  o('empty-name', { description: 'nameless thing', technology: 'Go' }),
  o('percent', { name: '100% uptime', description: 'a_b and a%b and c:\\temp\\x', technology: 'C++' }),
  o('underscore', { name: 'snake_case_name', description: 'axb aXb', technology: 'Python_3' }),
  o('backslash', { name: 'Path \\ server', description: 'C:\\Program Files', technology: '\\\\share' }),
  o('multi', { name: 'Order Service', description: 'Order   service with spaces', technology: 'Node JS' }),
  o('tech-only', { name: 'Thing', description: 'Does stuff', technology: 'Elasticsearch' }),
  o('desc-only', { name: 'Widget', description: 'Indexes with elasticsearch', technology: 'Rust' }),
  o('legacy-both', { name: 'Both', technology: 'Redis', technologies: [{ name: 'Flink' }] }),
]

/**
 * Each query, and why it is here. The comment says which column (or which
 * boundary) is supposed to make it match; the equality assertion is what
 * checks it, `minPrevious` is what keeps that assertion from being vacuous.
 */
const QUERIES: Array<{ q: string; minPrevious: number }> = [
  { q: 'gateway', minPrevious: 1 }, // name
  { q: 'GATEWAY', minPrevious: 1 }, // case
  { q: 'ledger', minPrevious: 2 }, // name of one, description of another
  { q: 'kafka', minPrevious: 1 }, // technology only
  { q: 'spring boot', minPrevious: 1 }, // `technologies[]`, multi-word
  { q: 'payment service', minPrevious: 1 }, // multi-word, upper-case source
  { q: 'école', minPrevious: 1 }, // accent
  { q: 'ÉCOLE', minPrevious: 1 }, // accent + case
  { q: 'crème', minPrevious: 1 },
  { q: 'creme', minPrevious: 0 }, // no unaccent anywhere: matches nothing, on both sides
  { q: 'σίσυφος', minPrevious: 1 },
  { q: 'οδοσ', minPrevious: 1 },
  { q: '50%', minPrevious: 1 }, // a literal %
  { q: '100%', minPrevious: 1 },
  { q: 'a%b', minPrevious: 1 },
  { q: 'a_b', minPrevious: 1 }, // a literal _, NOT `axb`
  { q: 'snake_case', minPrevious: 1 },
  { q: 'python_3', minPrevious: 1 },
  { q: 'c:\\temp', minPrevious: 1 }, // a backslash
  { q: '\\\\share', minPrevious: 1 },
  { q: 'path \\ server', minPrevious: 1 },
  { q: 'elasticsearch', minPrevious: 2 }, // technology of one, description of another
  { q: 'redis', minPrevious: 2 },
  { q: 'flink', minPrevious: 1 },
  { q: 'nameless', minPrevious: 1 },
  { q: 'order   service', minPrevious: 1 }, // the run of spaces is in the description
  { q: 'plain text', minPrevious: 1 },
  // ACROSS A BOUNDARY: each of these is in `search_document` and in no column.
  { q: 'gateway ledger', minPrevious: 0 }, // name → description
  { q: 'payment kafka', minPrevious: 0 }, // description → technology
  { q: 'lonely  redis', minPrevious: 0 }, // name → '' description → technology
  { q: 'untooled plain', minPrevious: 0 },
  { q: 'bare  ', minPrevious: 1 }, // trimmed to 'bare'
  { q: 'service takes', minPrevious: 0 },
  { q: 'zzz', minPrevious: 0 },
]

/** The queries that match `search_document` and nothing else: what makes the recheck observable. */
const ACROSS_A_BOUNDARY = ['gateway ledger', 'payment kafka', 'lonely  redis', 'untooled plain', 'service takes']

suite('ro_objects without the per-column description/technology trigram indexes', () => {
  let db: IsolatedSchemaDb

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(CONNECTION!, 'ro_trgm_redundant')
    await ensureReadModelSchema(db.pool)
    await coldBuildReadModel(db.pool, WS, null, CORPUS, [])
    await coldBuildReadModel(db.pool, OTHER, null, CORPUS.map((object) => ({ ...object, id: `other-${object.id}` })), [])
  })

  afterAll(async () => {
    await db?.teardown()
  })

  const ordered = async (sql: string, q: string, key = WS) => (await db.pool.query<{ id: string; data: unknown }>(
    `SELECT data->>'id' AS id, data FROM (${sql}) AS result ORDER BY data->>'id' COLLATE "C"`,
    [key.landscapeId, key.versionId, like(q)],
  )).rows

  const indexNames = async () => (await db.pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'ro_objects' ORDER BY 1`,
  )).rows.map((row) => row.indexname)

  /** pg_index flags of the 0006 indexes still present, by name. */
  const indexStates = async () => (await db.pool.query<{ relname: string; indisvalid: boolean; indisready: boolean }>(
    `SELECT c.relname, x.indisvalid, x.indisready FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
      WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ANY($1::text[]) ORDER BY 1`,
    [[...REDUNDANT_OBJECT_TRIGRAM_INDEXES]],
  )).rows

  /** `dropRedundantObjectTrigramIndexes` takes ONE connection, as the migration runner hands it. */
  const dropOnOwnClient = async (options: Parameters<typeof dropRedundantObjectTrigramIndexes>[1] = { log: () => {} }) => {
    const client = await db.pool.connect()
    try {
      return await dropRedundantObjectTrigramIndexes(client, options)
    } finally {
      client.release()
    }
  }

  describe('result equality, previous SQL against the rewrite, on the same rows', () => {
    it('returns the same ordered rows for every query', async () => {
      for (const { q, minPrevious } of QUERIES) {
        const previous = await ordered(PREVIOUS_SQL, q)
        expect(previous.length, `previous SQL for ${JSON.stringify(q)}`).toBeGreaterThanOrEqual(minPrevious)
        expect(await ordered(RO_SEARCH_OBJECTS_SQL, q), JSON.stringify(q)).toEqual(previous)
        expect(previous.every((row) => !row.id.startsWith('other-')), `workspace leak for ${JSON.stringify(q)}`).toBe(true)
      }
    })

    it('the boundary queries match search_document alone, so the recheck is what rejects them', async () => {
      // The control for the test above: without it, "both return nothing" for
      // these queries would pass even if search_document did not span fields.
      for (const q of ACROSS_A_BOUNDARY) {
        const prefilterOnly = await ordered(
          `SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND search_document LIKE $3 ESCAPE '\\'`,
          q,
        )
        expect(prefilterOnly.length, `search_document alone for ${JSON.stringify(q)}`).toBeGreaterThan(0)
        expect(await ordered(RO_SEARCH_OBJECTS_SQL, q), JSON.stringify(q)).toEqual([])
      }
    })

    it('stays equal after a delta rewrites the texts (the generated column follows every write path)', async () => {
      await upsertObjects(db.pool, WS, null, [
        o('gateway', { name: 'Gateway v2', description: 'Routes to the ledger', technology: 'Envoy' }),
        o('fresh', { name: 'Fresh Kafka Consumer', description: '', technology: '' }),
      ])
      for (const q of ['gateway', 'ledger', 'kafka', 'envoy', 'gateway v2 routes', 'consumer  ']) {
        expect(await ordered(RO_SEARCH_OBJECTS_SQL, q), JSON.stringify(q)).toEqual(await ordered(PREVIOUS_SQL, q))
      }
      expect((await ordered(RO_SEARCH_OBJECTS_SQL, 'envoy')).map((row) => row.id)).toEqual(['gateway'])
    })

    it('roSearch, end to end, ranks the same hits as before', async () => {
      // Pinned literally (as the existing ranking test does) so a change in
      // the SQL that the Node ranking would hide still has a witness here.
      const hits = await roSearch(db.pool, WS, 'elasticsearch')
      expect(hits.map((hit) => (hit.type === 'object' ? hit.object.id : ''))).toEqual(['tech-only', 'desc-only'])
    })

    it('rests on NOT NULL columns: a NULL would drop a row from search_document but not from the column predicate', async () => {
      const { rows } = await db.pool.query<{ attname: string; attnotnull: boolean }>(
        `SELECT attname, attnotnull FROM pg_attribute
          WHERE attrelid = 'ro_objects'::regclass AND attname IN ('name', 'description', 'technology')
          ORDER BY attname`,
      )
      expect(rows).toEqual([
        { attname: 'description', attnotnull: true },
        { attname: 'name', attnotnull: true },
        { attname: 'technology', attnotnull: true },
      ])
      const { rows: generated } = await db.pool.query<{ expression: string }>(
        `SELECT pg_get_expr(d.adbin, d.adrelid) AS expression
           FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
          WHERE d.adrelid = 'ro_objects'::regclass AND a.attname = 'search_document'`,
      )
      expect(generated[0]?.expression).toBe(`lower(((((name || ' '::text) || description) || ' '::text) || technology))`)
    })
  })

  describe('the migration', () => {
    const entry = () => schemaMigrations(db.pool).find((migration) => migration.id === '0006-ro-objects-drop-redundant-trgm')

    it('the baseline does not create them', async () => {
      await ensureReadModelSchema(db.pool)
      const names = await indexNames()
      for (const index of REDUNDANT_OBJECT_TRIGRAM_INDEXES) expect(names).not.toContain(index)
      expect(names).toContain('idx_ro_objects_search_trgm')
      expect(names).toContain('idx_ro_objects_name_trgm')
    })

    it('is declared non-transactional, repeatable, and after the baseline', () => {
      const migrations = schemaMigrations(db.pool)
      const drop = migrations.findIndex((migration) => migration.id === '0006-ro-objects-drop-redundant-trgm')
      expect(drop).toBeGreaterThan(-1)
      expect(migrations[drop]!.transactional).toBe(false)
      expect(migrations[drop]!.repeatable).toBe(true)
      expect(migrations.findIndex((migration) => migration.id === '0001-baseline')).toBe(0)
      expect(drop).toBeGreaterThan(0)
    })

    it('drops them on a database that has them, through the runner, and a re-run is a no-op', async () => {
      for (const ddl of PREVIOUS_INDEX_DDL) await db.pool.query(ddl)
      expect(await indexNames()).toEqual(expect.arrayContaining([...REDUNDANT_OBJECT_TRIGRAM_INDEXES]))

      const first = await runMigrations(db.pool, [entry()!], { log: () => {} })
      expect(first.repeated).toEqual(['0006-ro-objects-drop-redundant-trgm'])
      let names = await indexNames()
      for (const index of REDUNDANT_OBJECT_TRIGRAM_INDEXES) expect(names).not.toContain(index)

      const second = await runMigrations(db.pool, [entry()!], { log: () => {} })
      expect(second.repeated).toEqual(['0006-ro-objects-drop-redundant-trgm'])
      // A boot of this build: the baseline, then the entry.
      await ensureReadModelSchema(db.pool)
      names = await indexNames()
      for (const index of REDUNDANT_OBJECT_TRIGRAM_INDEXES) expect(names).not.toContain(index)
      expect(names).toContain('idx_ro_objects_search_trgm')
    })

    it('drops one an OLDER build re-created after it had run (repeatable, not run-once)', async () => {
      await runMigrations(db.pool, [entry()!], { log: () => {} })
      for (const ddl of PREVIOUS_INDEX_DDL) await db.pool.query(ddl)
      await runMigrations(db.pool, [entry()!], { log: () => {} })
      const names = await indexNames()
      for (const index of REDUNDANT_OBJECT_TRIGRAM_INDEXES) expect(names).not.toContain(index)
    })
  })

  describe('the locks of the concurrent drop', () => {
    /** Resolve once `pid` is waiting on a heavyweight lock. */
    const waitUntilBlocked = async (pid: number) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const { rows } = await db.pool.query<{ wait_event_type: string | null }>(
          `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid],
        )
        if (rows[0]?.wait_event_type === 'Lock') return
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`backend ${pid} never waited on a lock`)
    }

    const withHolder = async (work: (holder: pg.PoolClient, dropper: pg.PoolClient, dropperPid: number) => Promise<void>) => {
      const holder = await db.pool.connect()
      const dropper = await db.pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query(`SELECT 1 FROM ro_objects LIMIT 1`)
        const { rows } = await dropper.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        await work(holder, dropper, rows[0]!.pid)
      } finally {
        await holder.query('ROLLBACK').catch(() => {})
        holder.release()
        dropper.release()
      }
    }

    /** A read and a write of `ro_objects`, each refused after 1 s of lock wait. */
    const readAndWrite = async () => {
      const probe = await db.pool.connect()
      try {
        await probe.query('BEGIN')
        await probe.query(`SET LOCAL lock_timeout = '1000ms'`)
        await probe.query(`SELECT count(*) FROM ro_objects WHERE landscape_id = $1`, [WS.landscapeId])
        await probe.query(
          `INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES ('ls-lock-probe', 'v1', 'p', '{}')
           ON CONFLICT DO NOTHING`,
        )
        await probe.query('ROLLBACK')
        return 'ran'
      } catch (error) {
        await probe.query('ROLLBACK').catch(() => {})
        return (error as { code?: string }).code ?? 'error'
      } finally {
        probe.release()
      }
    }

    it('while it waits for an older transaction, other sessions still read and write ro_objects', async () => {
      for (const ddl of PREVIOUS_INDEX_DDL) await db.pool.query(ddl)
      await withHolder(async (holder, dropper, dropperPid) => {
        const drop = dropper.query(`DROP INDEX CONCURRENTLY IF EXISTS ${REDUNDANT_OBJECT_TRIGRAM_INDEXES[0]}`)
        await waitUntilBlocked(dropperPid)
        expect(await readAndWrite()).toBe('ran')
        await holder.query('COMMIT')
        await drop
      })
      expect(await indexNames()).not.toContain(REDUNDANT_OBJECT_TRIGRAM_INDEXES[0])
    })

    it('behind a transaction that outlasts its bound, it DEFERS (no throw, no hang) and restores the session lock_timeout', async () => {
      for (const ddl of PREVIOUS_INDEX_DDL) await db.pool.query(ddl)
      const lines: string[] = []
      await withHolder(async (_holder, dropper) => {
        await dropper.query(`SET lock_timeout = '7s'`)
        const started = Date.now()
        const { deferred } = await dropRedundantObjectTrigramIndexes(dropper, { attempts: 2, retryMs: 50, log: (line) => lines.push(line) })
        // Two indexes × two attempts × at most 500 ms each, plus one pause:
        // far below the 7 s the session would otherwise have waited per lock.
        expect(Date.now() - started).toBeLessThan(4_000)
        expect(deferred).toEqual([...REDUNDANT_OBJECT_TRIGRAM_INDEXES])
        expect((await dropper.query<{ v: string }>(`SELECT current_setting('lock_timeout') AS v`)).rows[0]!.v).toBe('7s')
        await dropper.query('RESET lock_timeout')
      })
      expect(lines.map((line) => JSON.parse(line).event)).toEqual([
        'read_model.redundant_trigram_drop_deferred', 'read_model.redundant_trigram_drop_deferred',
      ])
      // Left in place AND INVALID (the first step of the concurrent drop
      // committed: still maintained, used by no plan, absent from a pg_dump),
      // cleared by the next run.
      expect(await indexNames()).toEqual(expect.arrayContaining([...REDUNDANT_OBJECT_TRIGRAM_INDEXES]))
      expect(await indexStates()).toEqual([...REDUNDANT_OBJECT_TRIGRAM_INDEXES].sort().map((relname) => ({ relname, indisvalid: false, indisready: true })))
      expect((await dropOnOwnClient()).deferred).toEqual([])
      const names = await indexNames()
      for (const index of REDUNDANT_OBJECT_TRIGRAM_INDEXES) expect(names).not.toContain(index)
    })

    it('a cold build\'s bounded ANALYZE inside its write transaction is never the deadlock victim', async () => {
      // The cold build's shape (`analyzeWithinCeiling`): it has written
      // ro_objects, then ANALYZEs it under a 15 s lock_timeout. Issued 1.5 s
      // after the drop began waiting — past `deadlock_timeout` (1 s by
      // default), so an UNBOUNDED drop would have had its deadlock check
      // already and the ANALYZE's check would abort the ANALYZE (40P01,
      // measured by qa/g416f-trgm-drop-probe.mts). The bound gives up first.
      for (const ddl of PREVIOUS_INDEX_DDL) await db.pool.query(ddl)
      const { rows: [setting] } = await db.pool.query<{ ms: string }>(`SELECT setting AS ms FROM pg_settings WHERE name = 'deadlock_timeout'`)
      expect(Number(setting!.ms)).toBeLessThan(1_500)
      await withHolder(async (holder, dropper, dropperPid) => {
        await holder.query(
          `INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES ('ls-analyze-probe', 'v1', 'a', '{}')`,
        )
        const drop = dropRedundantObjectTrigramIndexes(dropper, { attempts: 1, log: () => {} })
        await waitUntilBlocked(dropperPid)
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        await holder.query(`SET LOCAL lock_timeout = '15000ms'`)
        await expect(holder.query('ANALYZE ro_objects')).resolves.toBeDefined()
        await holder.query('ROLLBACK')
        expect((await drop).deferred.length).toBeGreaterThan(0)
      })
      await dropOnOwnClient()
    })

    /**
     * The drop's own connection, wrapped: records every statement and, when
     * `inject` returns a SQLSTATE for a DROP (its 1-based ordinal), fails that
     * statement with it WITHOUT sending it. Everything else reaches the server.
     */
    const instrumented = (client: pg.PoolClient, inject: (dropNumber: number) => string | undefined = () => undefined) => {
      const calls: Array<{ text: string; values: unknown }> = []
      let drops = 0
      const wrapper = {
        query: (text: string, values?: unknown) => {
          calls.push({ text, values })
          if (text.startsWith('DROP INDEX')) {
            const code = inject(++drops)
            if (code) return Promise.reject(Object.assign(new Error(`injected ${code}`), { code }))
          }
          return client.query(text, values as unknown[])
        },
      }
      return { client: wrapper as unknown as pg.PoolClient, calls, dropStatements: () => calls.filter((call) => call.text.startsWith('DROP INDEX')) }
    }

    const withDropClient = async (work: (client: pg.PoolClient) => Promise<void>) => {
      const client = await db.pool.connect()
      try {
        await work(client)
      } finally {
        client.release()
      }
    }

    it('#8 the bound stays strictly below a deadlock_timeout set lower than the 500 ms cap', async () => {
      for (const ddl of PREVIOUS_INDEX_DDL) await db.pool.query(ddl)
      const lines: string[] = []
      await withHolder(async (_holder, dropper) => {
        try {
          await dropper.query(`SET deadlock_timeout = '200ms'`)
          const started = Date.now()
          const { deferred } = await dropRedundantObjectTrigramIndexes(dropper, { attempts: 1, log: (line) => lines.push(line) })
          expect(deferred).toEqual([...REDUNDANT_OBJECT_TRIGRAM_INDEXES])
          // Two waits of at most ~100 ms each; a 500 ms bound would take 1 s+.
          expect(Date.now() - started).toBeLessThan(800)
        } finally {
          await dropper.query('RESET deadlock_timeout')
        }
      })
      const logged = lines.map((line) => JSON.parse(line) as { lockWaitMs: number })
      expect(logged).toHaveLength(2)
      for (const entry of logged) {
        expect(entry.lockWaitMs).toBeLessThan(200)
        expect(entry.lockWaitMs).toBe(100)
      }
      await dropOnOwnClient()
    })

    it('#9 with no options it makes 3 attempts per index, pausing about 1 s between them', async () => {
      const lines: string[] = []
      await withDropClient(async (raw) => {
        const spy = instrumented(raw, () => '55P03')
        const started = Date.now()
        const { deferred } = await dropRedundantObjectTrigramIndexes(spy.client, { log: (line) => lines.push(line) })
        const elapsed = Date.now() - started
        expect(deferred).toEqual([...REDUNDANT_OBJECT_TRIGRAM_INDEXES])
        expect(spy.dropStatements()).toHaveLength(6)
        // Two pauses per index, two indexes: 4 000 ms of the 1 000 ms default.
        expect(elapsed).toBeGreaterThanOrEqual(3_900)
        expect(elapsed).toBeLessThan(8_000)
      })
      expect(lines.map((line) => (JSON.parse(line) as { attempts: number }).attempts)).toEqual([3, 3])
    }, 20_000)

    it('#10 a deadlock victim (40P01) is deferred, not thrown', async () => {
      const lines: string[] = []
      await withDropClient(async (raw) => {
        const spy = instrumented(raw, () => '40P01')
        const { deferred } = await dropRedundantObjectTrigramIndexes(spy.client, { attempts: 2, retryMs: 5, log: (line) => lines.push(line) })
        expect(deferred).toEqual([...REDUNDANT_OBJECT_TRIGRAM_INDEXES])
        expect(spy.dropStatements()).toHaveLength(4)
      })
      expect(lines.map((line) => (JSON.parse(line) as { sqlstate: string }).sqlstate)).toEqual(['40P01', '40P01'])
    })

    it('#10 a 40P01 on the first try is retried, and the drop then succeeds', async () => {
      for (const ddl of PREVIOUS_INDEX_DDL) await db.pool.query(ddl)
      await withDropClient(async (raw) => {
        const spy = instrumented(raw, (n) => (n === 1 ? '40P01' : undefined))
        const { deferred } = await dropRedundantObjectTrigramIndexes(spy.client, { attempts: 2, retryMs: 5, log: () => {} })
        expect(deferred).toEqual([])
        expect(spy.dropStatements()).toHaveLength(3)
      })
      const names = await indexNames()
      for (const index of REDUNDANT_OBJECT_TRIGRAM_INDEXES) expect(names).not.toContain(index)
    })

    it('#11 makes exactly `attempts` tries per index, and says so in the log line', async () => {
      for (const [attempts, statements] of [[1, 2], [2, 4], [4, 8]] as const) {
        const lines: string[] = []
        await withDropClient(async (raw) => {
          const spy = instrumented(raw, () => '55P03')
          await dropRedundantObjectTrigramIndexes(spy.client, { attempts, retryMs: 1, log: (line) => lines.push(line) })
          expect(spy.dropStatements(), `attempts ${attempts}`).toHaveLength(statements)
        })
        expect(lines.map((line) => (JSON.parse(line) as { attempts: number }).attempts)).toEqual([attempts, attempts])
      }
    })

    it('#12 on a database that already lacks the indexes, the drop succeeds (IF EXISTS)', async () => {
      await dropOnOwnClient()
      const names = await indexNames()
      for (const index of REDUNDANT_OBJECT_TRIGRAM_INDEXES) expect(names).not.toContain(index)
      await withDropClient(async (raw) => {
        const spy = instrumented(raw)
        await expect(dropRedundantObjectTrigramIndexes(spy.client, { log: () => {} })).resolves.toEqual({ deferred: [] })
        expect(spy.dropStatements()).toHaveLength(2)
        for (const statement of spy.dropStatements()) expect(statement.text).toContain('IF EXISTS')
      })
    })

    it('the BACKGROUND retry: a deferred drop left INVALID is reported, re-deferred while held, then dropped', async () => {
      for (const ddl of PREVIOUS_INDEX_DDL) await db.pool.query(ddl)
      const retry = new RedundantIndexDropRetry(db.pool, { log: () => {} })
      await withHolder(async (_holder, dropper) => {
        expect((await dropRedundantObjectTrigramIndexes(dropper, { attempts: 1, log: () => {} })).deferred)
          .toEqual([...REDUNDANT_OBJECT_TRIGRAM_INDEXES])
        const states = await inspectRedundantTrigramIndexes(db.pool)
        for (const index of REDUNDANT_OBJECT_TRIGRAM_INDEXES) expect(states[index], index).toBe('invalid')
        // A tick while the holder is still open defers again, never throws.
        await tickUntilKeyFree(retry)
        for (const index of REDUNDANT_OBJECT_TRIGRAM_INDEXES) {
          expect(retry.snapshot().states[index], index).toBe('invalid')
          expect(gauge(retry, index, 'invalid'), index).toBe(1)
        }
        expect(retry.snapshot().attempts.deferred).toBeGreaterThanOrEqual(2)
        // A deferral is not a drop.
        expect(retry.snapshot().attempts.dropped).toBe(0)
      })
      // Holder gone: the background retry (not a boot) drops them.
      await tickUntilKeyFree(retry)
      const names = await indexNames()
      for (const index of REDUNDANT_OBJECT_TRIGRAM_INDEXES) {
        expect(names).not.toContain(index)
        expect(retry.snapshot().states[index], index).toBe('absent')
        expect(gauge(retry, index, 'invalid'), index).toBe(0)
        expect(gauge(retry, index, 'valid'), index).toBe(0)
      }
      // Exactly the two that were present, counted once each.
      expect(retry.snapshot().attempts.dropped).toBe(2)
    })

    it('the BACKGROUND retry: a VALID leftover is reported, waits for a held migration key, then is dropped', async () => {
      for (const ddl of PREVIOUS_INDEX_DDL) await db.pool.query(ddl)
      const retry = new RedundantIndexDropRetry(db.pool, { log: () => {} })
      const keeper = await db.pool.connect()
      try {
        await keeper.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY])
        await retry.tick()
        expect(retry.snapshot().attempts.keyBusy).toBe(1)
        for (const index of REDUNDANT_OBJECT_TRIGRAM_INDEXES) {
          expect(retry.snapshot().states[index], index).toBe('valid')
          expect(gauge(retry, index, 'valid'), index).toBe(1)
        }
        expect(await indexNames()).toEqual(expect.arrayContaining([...REDUNDANT_OBJECT_TRIGRAM_INDEXES]))
      } finally {
        await keeper.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY])
        keeper.release()
      }
      await tickUntilKeyFree(retry)
      const names = await indexNames()
      for (const index of REDUNDANT_OBJECT_TRIGRAM_INDEXES) {
        expect(names).not.toContain(index)
        expect(gauge(retry, index, 'valid'), index).toBe(0)
      }
      // The search_document index is NOT on the retry's list (it is kept).
      expect(names).toContain('idx_ro_objects_search_trgm')
      expect(Object.keys(retry.snapshot().states).sort()).toEqual([...REDUNDANT_OBJECT_TRIGRAM_INDEXES].sort())
    })

    it('anything but a lock wait is thrown, not deferred', async () => {
      const client = await db.pool.connect()
      try {
        await client.query('BEGIN')
        await expect(dropRedundantObjectTrigramIndexes(client, { log: () => {} })).rejects.toMatchObject({ code: '25001' })
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    })

    it('control: a plain DROP INDEX in the same position blocks a reader', async () => {
      for (const ddl of PREVIOUS_INDEX_DDL) await db.pool.query(ddl)
      await withHolder(async (holder, dropper, dropperPid) => {
        const drop = dropper.query(`DROP INDEX IF EXISTS ${REDUNDANT_OBJECT_TRIGRAM_INDEXES[0]}`)
        await waitUntilBlocked(dropperPid)
        expect(await readAndWrite()).toBe('55P03')
        await holder.query('COMMIT')
        await drop
      })
      await runMigrations(db.pool, [schemaMigrations(db.pool).find((m) => m.id === '0006-ro-objects-drop-redundant-trgm')!], { log: () => {} })
    })
  })
})

/**
 * The plan, on a workspace the size of the measured corpus. Its own schema, so
 * the 85 000 rows do not slow the equality suite's statements.
 */
suite('the rewritten search filter on an 85 000-object workspace', () => {
  let db: IsolatedSchemaDb
  const BIG = { landscapeId: 'ls-trgm-big', versionId: 'v1' }

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(CONNECTION!, 'ro_trgm_plan')
    await ensureReadModelSchema(db.pool)
    // Generated in SQL: deterministic syllable words, lengths near the
    // measured corpus (name ~26, description ~143, technology ~70 chars).
    await db.pool.query(`
      WITH syllables AS (
        SELECT ARRAY['ka','lo','mi','ne','po','ru','sa','ti','vo','ze','bra','cle','dri','fro','glu',
                     'pla','qua','sto','tre','wix','yul','zan','mor','pex','dun','hal','jor','lek','nim','orb']::text[] AS s
      ), words AS (
        SELECT i, k, (SELECT s[1 + (abs(hashint4(i * 131 + k)) % 30)] || s[1 + (abs(hashint4(i * 137 + k * 7)) % 30)]
                         || s[1 + (abs(hashint4(i * 139 + k * 11)) % 30)] FROM syllables) AS word
          FROM generate_series(1, 85000) AS i, generate_series(1, 27) AS k
      ), texts AS (
        SELECT i,
               string_agg(word, ' ' ORDER BY k) FILTER (WHERE k <= 3) AS name,
               string_agg(word, ' ' ORDER BY k) FILTER (WHERE k BETWEEN 4 AND 19) AS description,
               string_agg(word, ' ' ORDER BY k) FILTER (WHERE k >= 20) AS technology
          FROM words GROUP BY i
      )
      INSERT INTO ro_objects (landscape_id, version_id, id, type, name, description, technology, data)
      SELECT $1, $2, 'obj-' || i, 'app', name, description, technology,
             jsonb_build_object('id', 'obj-' || i, 'name', name, 'description', description, 'technology', technology)
        FROM texts`, [BIG.landscapeId, BIG.versionId])
    // ANALYZE samples 300 × statistics_target rows: at the default target
    // (100) that is 30 000 of the 85 000, a random sample, and one run of
    // `ci-local --static` on 2026-11-10 planned 'zanmor' as a Seq Scan
    // (estimate 268 rows) while the same tree's `ci:local` run planned the
    // index. A target of 1000 samples all 85 000 rows, so the statistics —
    // and the plan this test asserts — no longer depend on the sample.
    const analyzer = await db.pool.connect()
    try {
      await analyzer.query('SET default_statistics_target = 1000')
      await analyzer.query('ANALYZE ro_objects')
    } finally {
      await analyzer.query('RESET default_statistics_target').catch(() => undefined)
      analyzer.release()
    }
  }, 180_000)

  afterAll(async () => {
    await db?.teardown()
  })

  const plan = async (q: string) => {
    const { rows } = await db.pool.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON) ${RO_SEARCH_OBJECTS_SQL}`, [BIG.landscapeId, BIG.versionId, like(q)],
    )
    return JSON.stringify(rows[0]!['QUERY PLAN'])
  }

  it('is served by idx_ro_objects_search_trgm, with no sequential scan', async () => {
    const { rows: [sizes] } = await db.pool.query<{ objects: number; name: number; description: number; technology: number }>(
      `SELECT count(*)::int AS objects, avg(length(name))::int AS name, avg(length(description))::int AS description,
              avg(length(technology))::int AS technology FROM ro_objects`,
    )
    expect(sizes!.objects).toBe(85_000)
    // Near the measured corpus (26 / 143 / 70): a plan on much shorter texts
    // would say little about that one.
    expect(sizes!.name).toBeGreaterThanOrEqual(20)
    expect(sizes!.name).toBeLessThanOrEqual(32)
    expect(sizes!.description).toBeGreaterThanOrEqual(120)
    expect(sizes!.description).toBeLessThanOrEqual(170)
    expect(sizes!.technology).toBeGreaterThanOrEqual(55)
    expect(sizes!.technology).toBeLessThanOrEqual(85)
    // A word, a substring spanning two syllables, and a substring spanning
    // two words; each matches some rows, so the plan is not for an empty set.
    for (const q of ['kaloru', 'zanmor', 'ka lo']) {
      const { rowCount } = await db.pool.query(RO_SEARCH_OBJECTS_SQL, [BIG.landscapeId, BIG.versionId, like(q)])
      expect(rowCount, q).toBeGreaterThan(0)
      const text = await plan(q)
      expect(text, q).toContain('"Index Name":"idx_ro_objects_search_trgm"')
      expect(text, q).not.toContain('Seq Scan')
    }
  })
})
