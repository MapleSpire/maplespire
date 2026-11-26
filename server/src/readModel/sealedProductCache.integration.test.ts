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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as A from '@automerge/automerge'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { dropReadModelSchema, ensureReadModelSchema } from './schema.js'
import { coldBuildReadModel, type WorkspaceKey } from './projector.js'
import {
  SealedProductCacheWriter,
  codePointOrder,
  pruneSealedProductCache,
  readSealedProductCacheHits,
  readSealedProductEntities,
  type SealedProductCacheHit,
} from './sealedProductCache.js'

/**
 * G4-16f C1: the adopt tables and the sealed-product extract cache, against
 * the real schema. Isolated schema, TEST_DATABASE_URL; skips without one.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-spc', versionId: 'v1' }
const OTHER: WorkspaceKey = { landscapeId: 'ls-spc-other', versionId: 'v1' }

let db: IsolatedSchemaDb

const TABLES = [
  'read_model_adopt_watermarks',
  'read_model_adopt_state',
  'read_model_sealed_product_extracts',
  'read_model_sealed_product_entities',
]

async function present(table: string): Promise<boolean> {
  const { rows } = await db.pool.query<{ ok: boolean }>(
    `SELECT to_regclass(current_schema() || '.' || $1) IS NOT NULL AS ok`, [table])
  return rows[0]!.ok
}

async function cacheProduct(key: WorkspaceKey, collection: 'object' | 'connection', product: string, entities: string[]) {
  await db.pool.query(
    `INSERT INTO read_model_sealed_product_extracts (landscape_id, version_id, collection, product_document_id,
       rows_digest, heads, max_arrival_seq, extraction_version, entity_count)
     VALUES ($1, $2, $3, $4, 'digest', ARRAY['h'], 7, 1, $5)`,
    [key.landscapeId, key.versionId, collection, product, entities.length],
  )
  for (const id of entities) {
    await db.pool.query(
      `INSERT INTO read_model_sealed_product_entities (landscape_id, version_id, collection, product_document_id, entity_id, value)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [key.landscapeId, key.versionId, collection, product, id, JSON.stringify({ id })],
    )
  }
}

const headers = async (key: WorkspaceKey = WS) => (await db.pool.query<{ collection: string; product: string }>(
  `SELECT collection, product_document_id AS product FROM read_model_sealed_product_extracts
    WHERE landscape_id = $1 AND version_id = $2 ORDER BY 1, 2`, [key.landscapeId, key.versionId])).rows
const entityRows = async (key: WorkspaceKey = WS) => Number((await db.pool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM read_model_sealed_product_entities WHERE landscape_id = $1 AND version_id = $2`,
  [key.landscapeId, key.versionId])).rows[0]!.n)

suite('G4-16f C1 — adopt tables and the sealed-product extract cache (real schema)', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'sealed_product_cache_c1')
    await ensureReadModelSchema(db.pool)
  })
  afterAll(async () => { await db?.teardown() })
  beforeEach(async () => {
    await db.pool.query(`TRUNCATE read_model_sealed_product_extracts, read_model_sealed_product_entities,
      read_model_adopt_watermarks, read_model_adopt_state, ro_objects`)
  })

  it('ensureReadModelSchema creates the four tables and the entity index; it is idempotent; dropReadModelSchema drops them', async () => {
    for (const table of TABLES) expect(await present(table)).toBe(true)
    expect(await present('idx_read_model_sealed_product_entities_entity')).toBe(true)
    await ensureReadModelSchema(db.pool)
    await cacheProduct(WS, 'object', 'p1', ['a'])
    await dropReadModelSchema(db.pool)
    for (const table of TABLES) expect(await present(table)).toBe(false)
    // Control: the drop ran (a table it always dropped is gone too).
    expect(await present('ro_objects')).toBe(false)
    await ensureReadModelSchema(db.pool)
    for (const table of TABLES) expect(await present(table)).toBe(true)
  })

  it('the constraints: a negative adopt watermark is refused, and an entity row needs its header', async () => {
    await expect(db.pool.query(
      `INSERT INTO read_model_adopt_watermarks (landscape_id, version_id, document_id, adopt_watermark) VALUES ('l', 'v', 'd', -1)`,
    )).rejects.toMatchObject({ code: '23514' })
    await expect(db.pool.query(
      `INSERT INTO read_model_sealed_product_entities (landscape_id, version_id, collection, product_document_id, entity_id, value)
       VALUES ('l', 'v', 'object', 'nohead', 'e', '{}'::jsonb)`,
    )).rejects.toMatchObject({ code: '23503' })
  })

  it('a cold build that rewrites ro_* keeps the cache and the adopt rows (the documents stay the source; the cache survives)', async () => {
    await cacheProduct(WS, 'object', 'p1', ['a', 'b'])
    await db.pool.query(
      `INSERT INTO read_model_adopt_watermarks (landscape_id, version_id, document_id, adopt_watermark) VALUES ($1, $2, 'root', 9)`,
      [WS.landscapeId, WS.versionId])
    await coldBuildReadModel(db.pool, WS, null, [{ id: 'x', name: 'X', type: 'system' } as never], [])
    await coldBuildReadModel(db.pool, WS, null, [{ id: 'y', name: 'Y', type: 'system' } as never], [])
    // Witness: the build DID delete what it rewrites.
    const ids = (await db.pool.query<{ id: string }>(
      'SELECT id FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id', [WS.landscapeId, WS.versionId])).rows
    expect(ids.map((row) => row.id)).toEqual(['y'])
    expect(await headers()).toEqual([{ collection: 'object', product: 'p1' }])
    expect(await entityRows()).toBe(2)
    expect((await db.pool.query('SELECT 1 FROM read_model_adopt_watermarks')).rowCount).toBe(1)
  })

  it('prune deletes the headers (and, by cascade, the entities) of products no longer listed in their collection, and nothing of another workspace', async () => {
    await cacheProduct(WS, 'object', 'listed', ['a'])
    await cacheProduct(WS, 'object', 'gone', ['b', 'c'])
    // Listed, but in the OTHER collection's list: unlisted for its own.
    await cacheProduct(WS, 'connection', 'wrongkind', ['d'])
    await cacheProduct(WS, 'connection', 'conn', ['e'])
    await cacheProduct(OTHER, 'object', 'gone', ['z'])
    const deleted = await pruneSealedProductCache(db.pool, WS, { object: ['listed', 'wrongkind'], connection: ['conn'] })
    expect(deleted).toBe(2)
    expect(await headers()).toEqual([
      { collection: 'connection', product: 'conn' },
      { collection: 'object', product: 'listed' },
    ])
    expect(await entityRows()).toBe(2)
    expect(await headers(OTHER)).toEqual([{ collection: 'object', product: 'gone' }])
    expect(await entityRows(OTHER)).toBe(1)
    // Empty lists prune everything of the workspace (always safe).
    expect(await pruneSealedProductCache(db.pool, WS, { object: [], connection: [] })).toBe(2)
    expect(await entityRows()).toBe(0)
  })
})

// ------------------------------------------------------------- THE READER
// G4-16f C4: `readSealedProductCacheHits` / `readSealedProductEntities`
// against extracts the real writer wrote from documents a real Repo saved
// through the real storage adapter.

let readerDb: IsolatedSchemaDb
let repo: Repo
type Product = { objects: Record<string, Record<string, unknown>> }

async function product(tag: string, n = 6, shape?: (id: string, at: number) => Record<string, unknown>): Promise<DocHandle<Product>> {
  const handle = repo.create<Product>({ objects: {} })
  handle.change((doc) => {
    for (let at = 0; at < n; at += 1) {
      const id = `${tag}-${at}`
      doc.objects[id] = shape ? shape(id, at) : { id, name: `N${at}`, zeta: at, alpha: { list: [at, 'x'], nested: { b: true, a: 1 } } }
    }
  })
  await repo.flush([handle.documentId])
  return handle
}
const task = (handle: DocHandle<Product>) =>
  ({ kind: 'object' as const, documentId: String(handle.documentId), heads: [...A.getHeads(handle.doc() as A.Doc<unknown>)] })
const servedCopy = (handle: DocHandle<Product>) => JSON.parse(JSON.stringify(handle.doc().objects)) as Record<string, unknown>
/** What the projector's copy of a LOADED document is: key order as
 * `Automerge.load` materialises it. */
const loadedCopy = (handle: DocHandle<Product>) => {
  const loaded = A.load<Product>(A.save(handle.doc() as A.Doc<Product>))
  try {
    return JSON.parse(JSON.stringify(loaded.objects)) as Record<string, unknown>
  } finally {
    A.free(loaded)
  }
}
async function writeAndHit(p: DocHandle<Product>): Promise<SealedProductCacheHit | undefined> {
  const writer = new SealedProductCacheWriter({ db: readerDb.pool, key: WS, intervalMs: 10, log: () => {}, warn: () => {} })
  writer.enqueue(task(p))
  await writer.idle()
  expect(writer.stats.written).toBe(1)
  return (await readSealedProductCacheHits(readerDb.pool, WS, { object: [String(p.documentId)], connection: [] })).object.get(String(p.documentId))
}

suite('G4-16f C4 — the extract cache READER (real PostgreSQL, Repo, writer)', () => {
  beforeAll(async () => {
    readerDb = await createIsolatedSchemaDb(connection!, 'sealed_product_cache_reader')
    await ensureReadModelSchema(readerDb.pool)
    await readerDb.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    repo = new Repo({ storage: new PostgresStorageAdapter({ db: readerDb.pool }), network: [], saveDebounceRate: 60_000 })
  })
  afterAll(async () => { await repo?.shutdown(); await readerDb?.teardown() })
  beforeEach(async () => {
    await readerDb.pool.query('TRUNCATE read_model_sealed_product_extracts, read_model_sealed_product_entities')
  })

  it('R1: an entity read is bound to the header digest AND extraction version the hit was decided on', async () => {
    const p = await product('r1')
    const hit = await writeAndHit(p)
    expect(hit).toBeDefined()
    // Control: the matching hit reads the served map.
    expect(await readSealedProductEntities(readerDb.pool, WS, hit!)).toEqual(servedCopy(p))
    // A header rewritten since by another writer (another digest): nothing.
    expect(await readSealedProductEntities(readerDb.pool, WS, { ...hit!, rowsDigest: 'a-digest-the-header-no-longer-has' })).toBeNull()
    // An extract of another extraction version is never read, whatever digest the caller holds.
    await readerDb.pool.query(`UPDATE read_model_sealed_product_extracts SET extraction_version = 999 WHERE product_document_id = $1`, [hit!.documentId])
    expect(await readSealedProductEntities(readerDb.pool, WS, hit!)).toBeNull()
    expect((await readSealedProductCacheHits(readerDb.pool, WS, { object: [hit!.documentId], connection: [] })).object.size).toBe(0)
  }, 60_000)

  it('R9: objects nested in ARRAYS are served in the loaded document\'s key order (JSONB orders keys shorter-first)', async () => {
    const p = await product('r9', 2, (id) => ({ id, rows: [{ b: 1, aa: 2, a: 3, cc: { z: 1, ab: 2, x: 3 } }, [{ z: 1, aa: 2 }]], plain: { b: 1, aa: 2 } }))
    const hit = await writeAndHit(p)
    expect(JSON.stringify(await readSealedProductEntities(readerDb.pool, WS, hit!))).toBe(JSON.stringify(loadedCopy(p)))
  }, 60_000)

  it('R10: private-use keys U+F000..U+F7FF order against astral keys like the loaded document (UTF-8 bytes), not like a surrogate', async () => {
    const p = await product('r10', 1, (id) => ({ id, '\u{F000}': 1, '\u{F7FF}': 2, '\u{1F600}': 3, '\u{FFFD}': 4, '\u{E000}': 5, '\u{D7FF}': 6, '\u{10000}': 7 }))
    const hit = await writeAndHit(p)
    expect(JSON.stringify(await readSealedProductEntities(readerDb.pool, WS, hit!))).toBe(JSON.stringify(loadedCopy(p)))
  }, 60_000)

  it('R2: a sync-state row beside the content rows does not defeat the hit', async () => {
    const p = await product('r2')
    expect(await writeAndHit(p)).toBeDefined()
    await readerDb.pool.query(`INSERT INTO automerge_storage (key, data) VALUES ($1, decode('0102', 'hex'))`, [`${p.documentId}/sync-state/some-peer`])
    const again = await readSealedProductCacheHits(readerDb.pool, WS, { object: [String(p.documentId)], connection: [] })
    expect(again.object.has(String(p.documentId))).toBe(true)
    expect(await readSealedProductEntities(readerDb.pool, WS, again.object.get(String(p.documentId))!)).toEqual(servedCopy(p))
  }, 60_000)

  it('R3: the hit serves the entity map in the order a LOADED document does, byte for byte (nested keys, integer-like keys)', async () => {
    const p = await product('r3', 12, (id, at) => ({ id, zz: at, a: { z: 1, aa: 2, b: { y: 1, x: 2, 10: 'n', 9: 'm' } }, 'é': 1, name: 'n' }))
    const hit = await writeAndHit(p)
    expect(JSON.stringify(await readSealedProductEntities(readerDb.pool, WS, hit!))).toBe(JSON.stringify(loadedCopy(p)))
  }, 60_000)

  it('R4: key order for astral and high-BMP keys: code-point (UTF-8 byte) order, as Automerge.load gives it — not UTF-16', async () => {
    const p = await product('r4', 1, (id) => ({ id, '\u{FF5E}': 1, '\u{1F600}': 2, '\u{E000}': 3, a: 4, '': 5 }))
    const hit = await writeAndHit(p)
    const served = JSON.stringify(loadedCopy(p))
    // Witness that the fixture exercises the difference: UTF-16 order would
    // put the astral key first among the three.
    expect(Object.keys(JSON.parse(served) as Record<string, Record<string, unknown>>)).toHaveLength(1)
    const order = Object.keys((JSON.parse(served) as Record<string, Record<string, unknown>>)['r4-0']!)
    expect(order.indexOf('\u{1F600}')).toBeGreaterThan(order.indexOf('\u{FF5E}'))
    expect(JSON.stringify(await readSealedProductEntities(readerDb.pool, WS, hit!))).toBe(served)
  }, 60_000)

  it('R5: awkward values survive the JSONB round trip exactly', async () => {
    const p = await product('r5', 1, (id) => ({
      id, nul: null, f1: 0.1 + 0.2, tiny: 5e-324, fl: 123456789.12345679,
      uni: 'line sep \u{1F600} é', empty: '', list: [], obj: {}, neg: -1.5e-7, t: true, f: false,
    }))
    const hit = await writeAndHit(p)
    expect(JSON.stringify(await readSealedProductEntities(readerDb.pool, WS, hit!))).toBe(JSON.stringify(loadedCopy(p)))
  }, 60_000)

  it('R6: a hit is decided per workspace and per collection', async () => {
    const p = await product('r6')
    await writeAndHit(p)
    const other = await readSealedProductCacheHits(readerDb.pool, OTHER, { object: [String(p.documentId)], connection: [] })
    expect(other.object.size).toBe(0)
    expect(other.headers).toBe(0)
    const asConnection = await readSealedProductCacheHits(readerDb.pool, WS, { object: [], connection: [String(p.documentId)] })
    expect(asConnection.connection.size).toBe(0)
  }, 60_000)

  it('R8 (characterisation, by design): an entity row edited IN PLACE, its count unchanged, is served as it now reads — nothing checks the values of a derived cache', async () => {
    const p = await product('r8')
    const hit = await writeAndHit(p)
    await readerDb.pool.query(`UPDATE read_model_sealed_product_entities SET value = '{"edited":true}'::jsonb
      WHERE product_document_id = $1 AND entity_id = 'r8-0'`, [String(p.documentId)])
    const again = (await readSealedProductCacheHits(readerDb.pool, WS, { object: [String(p.documentId)], connection: [] }))
      .object.get(String(p.documentId))
    expect(again).toEqual(hit)
    expect((await readSealedProductEntities(readerDb.pool, WS, again!))?.['r8-0']).toEqual({ edited: true })
  }, 60_000)

  it('R7: a remembered refusal over the CURRENT rows is a miss reported in `refused`; over older rows it is neither', async () => {
    const p = await product('r7', 2, (id) => ({ id, name: 'a\u0000b' }))
    const writer = new SealedProductCacheWriter({ db: readerDb.pool, key: WS, intervalMs: 10, log: () => {}, warn: () => {} })
    writer.enqueue(task(p))
    await writer.idle()
    expect(writer.stats.skipped['insert-refused']).toBe(1)
    const read = await readSealedProductCacheHits(readerDb.pool, WS, { object: [String(p.documentId)], connection: [] })
    expect(read.object.size).toBe(0)
    expect([...read.refused.object]).toEqual([String(p.documentId)])
    p.change((doc) => { doc.objects['r7-0']!.name = 'changed' })
    await repo.flush([p.documentId])
    const after = await readSealedProductCacheHits(readerDb.pool, WS, { object: [String(p.documentId)], connection: [] })
    expect(after.object.size).toBe(0)
    expect(after.refused.object.size).toBe(0)
  }, 60_000)
})

describe('G4-16f — codePointOrder (no database)', () => {
  it('orders like the UTF-8 bytes of the keys, astral above the high BMP, unlike the default sort', () => {
    const keys = ['\u{1F600}', '\u{E000}', '\u{FF5E}', 'b', 'a', '', 'ab', '\u{10000}', '\u{D7FF}']
    const bytes = [...keys].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)))
    expect([...keys].sort(codePointOrder)).toEqual(bytes)
    // The default sort differs on exactly this fixture (the witness).
    expect([...keys].sort()).not.toEqual(bytes)
  })

  it('equals the UTF-8 byte order over EVERY pair drawn from the encoding boundaries (exhaustive on a boundary alphabet)', () => {
    const alphabet = ['', 'a', '\u{7F}', '\u{80}', '\u{7FF}', '\u{800}', '\u{D7FF}', '\u{E000}', '\u{E001}', '\u{F000}', '\u{F7FF}',
      '\u{F800}', '\u{FFFD}', '\u{FFFF}', '\u{10000}', '\u{1F600}', '\u{10FFFF}']
    for (const x of alphabet) for (const y of alphabet) {
      expect(Math.sign(codePointOrder(x, y)), JSON.stringify([x, y])).toBe(Math.sign(Buffer.compare(Buffer.from(x), Buffer.from(y))))
    }
  })
})
