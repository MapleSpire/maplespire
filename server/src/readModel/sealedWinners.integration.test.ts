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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { Repo, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { AutomergeResidencyLeases } from '../automergeResidency.js'
import { cachedHandles } from '../automergeRepoCompat.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../rbac/docScope.js'
import { ensureReadModelSchema } from './schema.js'
import {
  awaitSealedProductCacheWrites, enqueueSealedProductCacheWriteForTest, heldSealedValues, startReadModelProjector,
} from './projectorService.js'
import type { OrdinaryHeadRotationConfig } from './ordinaryHeadRotation.js'
import { documentLoadCount } from './documentLoadTelemetry.js'
import type { WorkspaceKey } from './projector.js'
import { SealedWinnerIndex, sealedRankIn } from './sealedWinnerIndex.js'
import {
  SEALED_WINNERS_SQL, readSealedRanks, readSealedValues, readSealedWinners, type SealedWinnerCandidate,
} from './sealedWinners.js'
import { SEALED_PRODUCT_EXTRACTION_VERSION } from './sealedProductCache.js'

/**
 * G4-16f C5: sealed winners computed from SQL over the extract cache, and an
 * in-memory index that holds ids (and the values of products whose extract
 * is not committed yet) only.
 *
 * Part 1 drives `sealedWinners.ts` against a real PostgreSQL and compares it
 * with `SealedWinnerIndex` / `sealedRankIn`, the in-memory definitions it
 * must equal. Part 2 drives the real projector (rotations, folds, parks,
 * residency leases, a Repo over the PostgreSQL storage adapter), with the
 * same fixture as `ordinarySealedProductParking.integration.test.ts` (a test
 * file imports no other, so it is copied).
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-swin', versionId: 'v1' }
const LISTED = `${WS.landscapeId}/${WS.versionId}`
const THRESHOLD = 4
const CEILING = 5

let db: IsolatedSchemaDb

// ---------------------------------------------------------------- part 1

/** A deterministic PRNG (mulberry32), so a red run is reproducible. */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Value = { id: unknown; v: string }

/** Write one product's extract (header + entities), as the writer would. */
async function putExtract(
  key: WorkspaceKey,
  kind: 'object' | 'connection',
  documentId: string,
  entities: Record<string, Value>,
  options: { digest?: string; version?: number; refused?: string | null; entityCount?: number } = {},
) {
  await db.pool.query(
    `INSERT INTO read_model_sealed_product_extracts (landscape_id, version_id, collection, product_document_id,
       rows_digest, heads, max_arrival_seq, extraction_version, entity_count, refused_reason)
     VALUES ($1, $2, $3, $4, $5, ARRAY['h'], 1, $6, $7, $8)`,
    [key.landscapeId, key.versionId, kind, documentId, options.digest ?? `d-${documentId}`,
      options.version ?? SEALED_PRODUCT_EXTRACTION_VERSION, options.entityCount ?? Object.keys(entities).length,
      options.refused ?? null],
  )
  if (!Object.keys(entities).length) return
  await db.pool.query(
    `INSERT INTO read_model_sealed_product_entities (landscape_id, version_id, collection, product_document_id, entity_id, value)
     SELECT $1, $2, $3, $4, entity.key, entity.value FROM jsonb_each($5::jsonb) AS entity`,
    [key.landscapeId, key.versionId, kind, documentId, JSON.stringify(entities)],
  )
}

const candidate = (url: string, entities: Record<string, Value>, digest?: string): SealedWinnerCandidate => ({
  url, documentId: url.replace(/^automerge:/, ''), rowsDigest: digest ?? `d-${url.replace(/^automerge:/, '')}`,
  entityCount: Object.keys(entities).length,
})

/** What the in-memory index says, for the products of `full` the list names,
 * added in `insertion` order with their FULL maps. */
function indexOf(list: readonly string[], full: Record<string, Record<string, Value>>, insertion: readonly string[]) {
  const index = new SealedWinnerIndex<Value>()
  for (const url of insertion) {
    if (!list.includes(url)) continue
    index.add(url, Object.keys(full[url]!), sealedRankIn(list), new Map(), full[url]!)
  }
  return index
}

/** The merge `extractModelEntities` does, as ENTRIES (key order included). */
function mergeEntries(list: readonly string[], read: (url: string) => Record<string, unknown>): Array<[string, unknown]> {
  const out: Record<string, unknown> = {}
  for (const url of list) Object.assign(out, read(url))
  return Object.entries(out)
}

suite('G4-16f C5 — the winners statement against the in-memory index (real PostgreSQL)', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'sealed_winners_sql')
    await ensureReadModelSchema(db.pool)
  })
  afterAll(async () => { await db?.teardown() })
  beforeEach(async () => {
    await db.pool.query('TRUNCATE read_model_sealed_product_extracts, read_model_sealed_product_entities')
  })

  it('the rank SQL equals sealedRankIn (LAST position) on random lists with duplicates, and gives the FIRST position too', async () => {
    const random = prng(7)
    for (let round = 0; round < 40; round += 1) {
      const alphabet = ['A', 'B', 'C', 'D', 'E', 'F']
      const list = Array.from({ length: Math.floor(random() * 12) }, () => alphabet[Math.floor(random() * alphabet.length)]!)
      const ranks = await readSealedRanks(db.pool, list)
      const rank = sealedRankIn(list)
      for (const url of alphabet) {
        if (!list.includes(url)) { expect(ranks.has(url)).toBe(false); continue }
        expect({ url, list, last: ranks.get(url)!.last }).toEqual({ url, list, last: rank(url) })
        expect(ranks.get(url)!.first).toBe(list.indexOf(url))
      }
    }
    // Witness that duplicates were drawn: last differs from first somewhere.
    const dup = await readSealedRanks(db.pool, ['A', 'B', 'A'])
    expect(dup.get('A')).toEqual({ last: 2, first: 0 })
  })

  it('T8/T9 corpora: one id in two products, list order against insertion order, a product listed twice — the winners equal the index', async () => {
    const S1 = { a: { id: 'a', v: 'a@S1' }, b: { id: 'b', v: 'b@S1' }, c: { id: 'c', v: 'c@S1' } }
    const S2 = { a: { id: 'a', v: 'a@S2' }, b: { id: 'b', v: 'b@S2' }, e: { id: 'e', v: 'e@S2' } }
    const S3 = { c: { id: 'c', v: 'c@S3' }, e: { id: 'e', v: 'e@S3' } }
    const full: Record<string, Record<string, Value>> = { 'automerge:S1': S1, 'automerge:S2': S2, 'automerge:S3': S3 }
    for (const [url, entities] of Object.entries(full)) await putExtract(WS, 'object', url.slice('automerge:'.length), entities)
    const cases: Array<{ name: string; list: string[]; expect: Record<string, string[]> }> = [
      // S2 after S1: S2 wins a, b, e; S1 keeps c.
      { name: 'list order', list: ['automerge:S1', 'automerge:U', 'automerge:S2'],
        expect: { 'automerge:S1': ['c'], 'automerge:S2': ['a', 'b', 'e'] } },
      // Reversed: S1 wins a, b, c.
      { name: 'reversed', list: ['automerge:S2', 'automerge:S1'],
        expect: { 'automerge:S1': ['a', 'b', 'c'], 'automerge:S2': ['e'] } },
      // S1 listed twice, its LAST slot after S2: S1 wins a, b, c (rank by
      // the first slot would give a and b to S2).
      { name: 'listed twice', list: ['automerge:S1', 'automerge:S2', 'automerge:U', 'automerge:S1'],
        expect: { 'automerge:S1': ['a', 'b', 'c'], 'automerge:S2': ['e'] } },
      // Three products: S3 last takes c and e.
      { name: 'three', list: ['automerge:S1', 'automerge:S2', 'automerge:S3'],
        expect: { 'automerge:S1': [], 'automerge:S2': ['a', 'b'], 'automerge:S3': ['c', 'e'] } },
    ]
    for (const testCase of cases) {
      const candidates = Object.entries(full).map(([url, entities]) => candidate(url, entities))
      const winners = await readSealedWinners(db.pool, WS, 'object', testCase.list, candidates, { values: true })
      const listed = Object.keys(testCase.expect)
      expect({ name: testCase.name, wonBy: Object.fromEntries(listed.map((url) => [url, winners.wonBy.get(url)])) })
        .toEqual({ name: testCase.name, wonBy: testCase.expect })
      // The in-memory index, built in the OTHER insertion order, agrees.
      for (const insertion of [[...listed], [...listed].reverse()]) {
        const index = indexOf(testCase.list, full, insertion)
        for (const url of listed) expect(winners.wonBy.get(url)).toEqual(index.idsWonBy(url).sort())
        for (const [id, value] of winners.values) {
          const url = listed.find((u) => index.wins(u, id))!
          expect(value).toEqual(index.pinnedValue(url, id))
        }
      }
      expect(winners.refused.size).toBe(0)
      expect(winners.statements).toBe(1)
    }
  })

  it('property: over random corpora, the winners equal the index, and the merge over winners + first-insert placeholders equals the merge over full maps ENTRY FOR ENTRY (key order included)', async () => {
    const random = prng(20261109)
    for (let round = 0; round < 25; round += 1) {
      await db.pool.query('TRUNCATE read_model_sealed_product_extracts, read_model_sealed_product_entities')
      const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', '1', '2']
      const products = Array.from({ length: 2 + Math.floor(random() * 4) }, (_, at) => `automerge:P${round}x${at}`)
      const unsealed = ['automerge:U1', 'automerge:U2']
      const full: Record<string, Record<string, Value>> = {}
      for (const url of [...products, ...unsealed]) {
        const entities: Record<string, Value> = {}
        for (const id of ids) if (random() < 0.45) entities[id] = { id, v: `${id}@${url}` }
        full[url] = entities
      }
      for (const url of products) await putExtract(WS, 'object', url.slice('automerge:'.length), full[url]!)
      const pool = [...products, ...unsealed]
      const list = Array.from({ length: 3 + Math.floor(random() * 8) }, () => pool[Math.floor(random() * pool.length)]!)
      const candidates = products.map((url) => candidate(url, full[url]!))
      const winners = await readSealedWinners(db.pool, WS, 'object', list, candidates, { values: true })
      const idsOnly = await readSealedWinners(db.pool, WS, 'object', list, candidates, { values: false })
      const insertion = [...products].sort(() => random() - 0.5)
      const index = indexOf(list, full, insertion)
      const listedProducts = products.filter((url) => list.includes(url))
      for (const url of listedProducts) {
        expect(winners.wonBy.get(url)).toEqual(index.idsWonBy(url).sort())
        expect(idsOnly.wonBy.get(url)).toEqual(winners.wonBy.get(url))
      }
      // An unlisted product takes no part.
      for (const url of products.filter((u) => !list.includes(u))) expect(winners.wonBy.has(url)).toBe(false)
      // The merge the cold build does with what the statement gives.
      const wonSets = new Map(listedProducts.map((url) => [url, new Set(winners.wonBy.get(url))]))
      const emitted = (url: string): Record<string, unknown> => {
        if (!wonSets.has(url)) return full[url]!
        const out: Record<string, unknown> = {}
        const keys = [...wonSets.get(url)!, ...winners.firstHeldBy.get(url) ?? []].sort()
        for (const id of keys) out[id] = wonSets.get(url)!.has(id) ? winners.values.get(id) : undefined
        return out
      }
      expect({ round, list, merged: mergeEntries(list, emitted) })
        .toEqual({ round, list, merged: mergeEntries(list, (url) => full[url]!) })
    }
  })

  it('only the digests the hit check decided, the current version and no refusal take part; a product whose rows do not number its entity_count is REFUSED and the winners recomputed without it', async () => {
    const P1 = { a: { id: 'a', v: 'a@P1' }, b: { id: 'b', v: 'b@P1' } }
    const P2 = { a: { id: 'a', v: 'a@P2' }, b: { id: 'b', v: 'b@P2' } }
    const P3 = { b: { id: 'b', v: 'b@P3' } }
    await putExtract(WS, 'object', 'P1', P1)
    await putExtract(WS, 'object', 'P2', P2, { digest: 'rewritten' })
    await putExtract(WS, 'object', 'P3', P3, { entityCount: 2 })
    // Another workspace and another collection holding the same ids.
    await putExtract({ landscapeId: 'other', versionId: 'v1' }, 'object', 'P2', { a: { id: 'a', v: 'other' } })
    await putExtract(WS, 'connection', 'P2', { a: { id: 'a', v: 'conn' } })
    const list = ['automerge:P1', 'automerge:P2', 'automerge:P3']
    const winners = await readSealedWinners(db.pool, WS, 'object', list, [
      // P3 as the hit check decides it: its header's entity_count (2).
      candidate('automerge:P1', P1), candidate('automerge:P2', P2), { ...candidate('automerge:P3', P3), entityCount: 2 },
    ], { values: true })
    // P2's header carries another digest than the one decided: 0 rows, refused.
    // P3's rows (1) are not its entity_count (2): refused. P1 then wins all.
    expect([...winners.refused].sort()).toEqual(['automerge:P2', 'automerge:P3'])
    expect(winners.wonBy.get('automerge:P1')).toEqual(['a', 'b'])
    expect(winners.values.get('a')).toEqual({ id: 'a', v: 'a@P1' })
    // The counts are decided inside the statement: one statement, refusals
    // included.
    expect(winners.statements).toBe(1)
    // TOO MANY rows (a header whose entity_count is below its rows) is
    // refused as well.
    await putExtract(WS, 'object', 'P4', { c: { id: 'c', v: 'c@P4' }, d: { id: 'd', v: 'd@P4' } }, { entityCount: 1 })
    const tooMany = await readSealedWinners(db.pool, WS, 'object', ['automerge:P1', 'automerge:P4'], [
      candidate('automerge:P1', P1), { ...candidate('automerge:P4', {}), entityCount: 1 },
    ], { values: true })
    expect([...tooMany.refused]).toEqual(['automerge:P4'])
    expect(tooMany.values.has('c')).toBe(false)
    // A remembered refusal and another version are refused the same way.
    await db.pool.query(`UPDATE read_model_sealed_product_extracts SET refused_reason = 'insert-refused' WHERE product_document_id = 'P1' AND collection = 'object' AND landscape_id = $1`, [WS.landscapeId])
    const refused = await readSealedWinners(db.pool, WS, 'object', list, [candidate('automerge:P1', P1)], { values: false })
    expect([...refused.refused]).toEqual(['automerge:P1'])
    await db.pool.query(`UPDATE read_model_sealed_product_extracts SET refused_reason = NULL, extraction_version = extraction_version + 1 WHERE product_document_id = 'P1' AND landscape_id = $1`, [WS.landscapeId])
    const bumped = await readSealedWinners(db.pool, WS, 'object', list, [candidate('automerge:P1', P1)], { values: false })
    expect([...bumped.refused]).toEqual(['automerge:P1'])
    expect(bumped.wonBy.size).toBe(0)
  })

  it('the same product id under ANOTHER VERSION of the landscape and in the OTHER COLLECTION (same digest) leaks into neither the winners nor the values', async () => {
    const own = { x: { id: 'x', v: 'x@own' } }
    await putExtract(WS, 'object', 'P5', own)
    // Same landscape, version v2; and the connection collection: the SAME
    // digest, so only the version and collection predicates separate them.
    await putExtract({ landscapeId: WS.landscapeId, versionId: 'v2' }, 'object', 'P5', { x: { id: 'x', v: 'x@v2' }, y: { id: 'y', v: 'y@v2' } })
    await putExtract(WS, 'connection', 'P5', { x: { id: 'x', v: 'x@conn' }, z: { id: 'z', v: 'z@conn' } })
    const winners = await readSealedWinners(db.pool, WS, 'object', ['automerge:P5'], [candidate('automerge:P5', own)], { values: true })
    expect(winners.refused.size).toBe(0)
    expect(winners.wonBy.get('automerge:P5')).toEqual(['x'])
    expect(Object.fromEntries(winners.values)).toEqual({ x: { id: 'x', v: 'x@own' } })
    const values = await readSealedValues(db.pool, WS, 'object', [
      { url: 'automerge:P5', documentId: 'P5', rowsDigest: 'd-P5', ids: ['x', 'y', 'z'] },
    ])
    expect(Object.fromEntries(values.get('automerge:P5')!)).toEqual({ x: { id: 'x', v: 'x@own' } })
  })

  it('winners plan: another LANDSCAPE holding the same version, collection and product id takes no part; two products with the SAME digest are both served; values and inner ids come back in code-point key order; no candidate, no statement', async () => {
    const own = { x: { id: 'x', v: 'x@own' }, y: { id: 'y', v: 'y@own' } }
    await putExtract(WS, 'object', 'P6', own)
    // Only the landscape predicate separates these rows from P6's: counted
    // with them, P6 would number 4 rows against an entity_count of 2.
    await putExtract({ landscapeId: 'ls-swin-other', versionId: WS.versionId }, 'object', 'P6',
      { x: { id: 'x', v: 'x@other' }, z: { id: 'z', v: 'z@other' } })
    const isolated = await readSealedWinners(db.pool, WS, 'object', ['automerge:P6'], [candidate('automerge:P6', own)], { values: true })
    expect(isolated.refused.size).toBe(0)
    expect(isolated.wonBy.get('automerge:P6')).toEqual(['x', 'y'])
    expect(isolated.values.get('x')).toEqual({ id: 'x', v: 'x@own' })
    // Identical content, identical digest: each header joins its OWN
    // product only, so neither count is doubled.
    const twin = { t: { id: 't', v: 't' } }
    await putExtract(WS, 'object', 'P7', twin, { digest: 'same' })
    await putExtract(WS, 'object', 'P8', twin, { digest: 'same' })
    const twins = await readSealedWinners(db.pool, WS, 'object', ['automerge:P7', 'automerge:P8'],
      [candidate('automerge:P7', twin, 'same'), candidate('automerge:P8', twin, 'same')], { values: true })
    expect(twins.refused.size).toBe(0)
    expect(Object.fromEntries(twins.wonBy)).toEqual({ 'automerge:P7': [], 'automerge:P8': ['t'] })
    expect(twins.firstHeldBy.get('automerge:P7')).toEqual(['t'])
    // JSONB orders keys by length first ('v' before 'id', 'b' before 'aa');
    // a loaded document orders them by code point.
    const ordered = { k: { id: { b: 1, aa: 2 }, v: 'k' } as unknown as Value }
    await putExtract(WS, 'object', 'P9', ordered)
    const keyed = await readSealedWinners(db.pool, WS, 'object', ['automerge:P9'], [candidate('automerge:P9', ordered)], { values: true })
    expect(JSON.stringify(keyed.values.get('k'))).toBe(JSON.stringify({ id: { aa: 2, b: 1 }, v: 'k' }))
    expect(keyed.innerIds.get('k')).toBe(JSON.stringify({ aa: 2, b: 1 }))
    expect(JSON.stringify(isolated.values.get('x'))).toBe(JSON.stringify({ id: 'x', v: 'x@own' }))
    // No candidate the list names: nothing runs.
    const none = await readSealedWinners(db.pool, WS, 'object', ['automerge:P6'], [candidate('automerge:P9', ordered)], { values: true })
    expect(none.statements).toBe(0)
    expect(none.wonBy.size + none.refused.size).toBe(0)
  })

  it('inner ids: only the winners whose value\'s `id` is not their key are reported, as parameterText converts them', async () => {
    const P1 = {
      plain: { id: 'plain', v: '' }, other: { id: 'b', v: '' }, number: { id: 7, v: '' },
      object: { id: { z: 1, a: 2 }, v: '' }, missing: { v: '' } as unknown as Value, nul: { id: null, v: '' },
    }
    await putExtract(WS, 'object', 'P1', P1)
    const winners = await readSealedWinners(db.pool, WS, 'object', ['automerge:P1'], [candidate('automerge:P1', P1)], { values: false })
    // An object id converts through JSON.stringify with its keys in the
    // order a LOADED document gives them (code-point order), not JSONB's.
    expect(Object.fromEntries(winners.innerIds)).toEqual({
      other: 'b', number: '7', object: JSON.stringify({ a: 2, z: 1 }), missing: null, nul: null,
    })
  })

  it('readSealedValues: values of the asked ids under the asked digest only; an id the extract no longer has is ABSENT', async () => {
    const P1 = { a: { id: 'a', v: 'a@P1' }, b: { id: 'b', v: 'b@P1' } }
    await putExtract(WS, 'object', 'P1', P1)
    const asked = await readSealedValues(db.pool, WS, 'object', [
      { url: 'automerge:P1', documentId: 'P1', rowsDigest: 'd-P1', ids: ['a', 'zz'] },
    ])
    expect(Object.fromEntries(asked.get('automerge:P1')!)).toEqual({ a: { id: 'a', v: 'a@P1' } })
    const stale = await readSealedValues(db.pool, WS, 'object', [
      { url: 'automerge:P1', documentId: 'P1', rowsDigest: 'another', ids: ['a'] },
    ])
    expect(stale.get('automerge:P1')!.size).toBe(0)
    expect((await readSealedValues(db.pool, WS, 'object', [])).size).toBe(0)
  })
})

// ---------------------------------------------------------------- part 2

type Entity = { id: string; [field: string]: unknown }
type ObjHead = { objects: Record<string, Entity>; writeBatchIds: string[] }
type Meta = {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrl: string
  editsObjectShardUrls: string[]
  editsConnectionShardUrl: string
  editsConnectionShardUrls: string[]
  groups: Record<string, unknown>
}

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))

function storageRepo() {
  return new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 60_000 })
}

interface Workspace {
  repo: Repo
  rootUrl: string
  meta: DocHandle<Meta>
  registry: DocHandle<{ diagrams: Record<string, unknown>; touched?: number }>
}

async function workspace(repo: Repo): Promise<Workspace> {
  const base = repo.create<{ objects: Record<string, Entity> }>({ objects: { b: { id: 'b', name: 'B', type: 'system' } } })
  const head = repo.create<ObjHead>({ objects: {}, writeBatchIds: [] })
  const connHead = repo.create({ connections: {}, writeBatchIds: [] })
  const meta = repo.create<Meta>({
    objectShardUrls: [base.url, head.url],
    connectionShardUrls: [connHead.url],
    editsObjectShardUrl: head.url,
    editsObjectShardUrls: [head.url],
    editsConnectionShardUrl: connHead.url,
    editsConnectionShardUrls: [connHead.url],
    groups: {},
  })
  const registry = repo.create<{ diagrams: Record<string, unknown>; touched?: number }>({ diagrams: {} })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
  const handles = [base, head, connHead, meta, registry, root]
  await Promise.all(handles.map((h) => h.whenReady()))
  await repo.flush()
  for (const handle of handles) {
    await db.pool.query(
      'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [String(handle.documentId), WS.landscapeId, WS.versionId],
    )
  }
  return { repo, rootUrl: root.url, meta, registry }
}

function config(): OrdinaryHeadRotationConfig {
  return {
    mode: 'on', allowlist: new Set([LISTED]), maxActors: 1_000_000, maxChanges: THRESHOLD,
    deferral: { quietMs: 0, maxMs: 0 },
    chainFold: { minChain: 2, budget: 2, retainMs: 86_400_000, segmentCeiling: CEILING, windowEntities: 4 * CEILING },
  }
}

function start(repo: Repo, rootUrl: string, residency: AutomergeResidencyLeases, pool: IsolatedSchemaDb['pool'] = db.pool) {
  return startReadModelProjector(repo, rootUrl, pool, WS, residency, 0, undefined, undefined, undefined, undefined, config())
}

/** The test pool, `before` offered each query (pool-level and on a client
 * from `connect()`) BEFORE it runs. (Copied from
 * `ordinarySealedProductParking.integration.test.ts`: a test file imports no
 * other.) */
function poolBeforeQuery(before: (text: string) => void) {
  const wrapQuery = (target: { query: (...a: unknown[]) => unknown }) => async (...args: unknown[]) => {
    const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '')
    before(text)
    return target.query(...args)
  }
  return new Proxy(db.pool, {
    get(target, prop) {
      if (prop === 'query') return wrapQuery(target as never)
      if (prop === 'connect') {
        return async () => {
          const client = await target.connect()
          return new Proxy(client, {
            get(c, p) {
              if (p === 'query') return wrapQuery(c as never)
              const value = Reflect.get(c, p, c) as unknown
              return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(c) : value
            },
          })
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  }) as IsolatedSchemaDb['pool']
}
/** Statements by shape: the winners statement (by identity with the text
 * `readSealedWinners` runs, so a rewrite of it cannot make the count read
 * 0) and the on-demand value read. */
const VALUES_SHAPE = 'AS asked(url, product_document_id, rows_digest, entity_id)'
function countingPool() {
  const counts = { winners: 0, values: 0 }
  const pool = poolBeforeQuery((text) => {
    if (text === SEALED_WINNERS_SQL) counts.winners += 1
    if (text.includes(VALUES_SHAPE)) counts.values += 1
  })
  return { pool, counts }
}

function logLines() {
  const lines: Array<Record<string, unknown>> = []
  const capture = (...args: unknown[]) => {
    const first = args[0]
    if (typeof first !== 'string' || !first.startsWith('{')) return
    try { lines.push(JSON.parse(first) as Record<string, unknown>) } catch { /* not ours */ }
  }
  const spies = [
    vi.spyOn(console, 'warn').mockImplementation(capture),
    vi.spyOn(console, 'error').mockImplementation(capture),
    vi.spyOn(console, 'log').mockImplementation(capture),
  ]
  return {
    events: (event: string) => lines.filter((line) => line.event === event),
    restore: () => { for (const spy of spies) spy.mockRestore() },
  }
}
type Log = ReturnType<typeof logLines>

const currentHead = (ws: Workspace) => ws.meta.doc()!.editsObjectShardUrl
const docId = (url: string) => url.replace(/^automerge:/, '')
const resident = (repo: Repo, id: string) => Object.prototype.hasOwnProperty.call(cachedHandles(repo), id)
const roObject = async (id: string) => (await db.pool.query<{ data: Record<string, unknown> }>(
  'SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
  [WS.landscapeId, WS.versionId, id],
)).rows[0]?.data
const projectionState = async () => (await db.pool.query<{
  degraded_since: unknown; projected_generation: string; last_projection_kind: string | null
  defect_count: number | null; defect_summary: string | null
}>(
  `SELECT degraded_since, projected_generation::text AS projected_generation, last_projection_kind, defect_count, defect_summary
     FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
  [WS.landscapeId, WS.versionId],
)).rows[0]
const rowStatus = async (documentId: string, collection: 'object' | 'connection' = 'object') => (await db.pool.query<{ status: string }>(
  `SELECT status FROM read_model_ordinary_head_retirements
    WHERE landscape_id = $1 AND version_id = $2 AND collection = $4 AND document_id = $3`,
  [WS.landscapeId, WS.versionId, documentId, collection],
)).rows[0]?.status ?? null
const extractCount = async () => Number((await db.pool.query<{ n: number }>(
  'SELECT count(*)::int AS n FROM read_model_sealed_product_extracts WHERE landscape_id = $1 AND refused_reason IS NULL',
  [WS.landscapeId])).rows[0]!.n)

/** Fill the CURRENT head (each `extras` entry under its own MAP KEY first,
 * then entities of unique ids) until it is due, and wait for the rotation.
 * Returns the retired head's document id. */
async function fillAndRotate(
  ws: Workspace, tag: string, extras: Array<[string, Entity]> = [], bulk = 0, kind: 'object' | 'connection' = 'object',
): Promise<string> {
  const headOf = () => kind === 'object' ? currentHead(ws) : ws.meta.doc()!.editsConnectionShardUrl
  const url = headOf()
  const field = kind === 'object' ? 'objects' : 'connections'
  const entity = (id: string): Entity => kind === 'object'
    ? { id, name: id, type: 'system', p: tag }
    : { id, fromId: 'b', toId: 'b', label: id, p: tag }
  const head = await ws.repo.find<Record<string, Record<string, Entity>>>(url as AutomergeUrl)
  for (const [mapKey, value] of extras) head.change((doc) => { doc[field]![mapKey] = { ...value } })
  if (bulk > 0) {
    head.change((doc) => {
      for (let at = 0; at < bulk; at += 1) doc[field]![`${tag}-bulk${at}`] = entity(`${tag}-bulk${at}`)
    })
  }
  let index = 0
  while (A.stats(head.doc() as A.Doc<unknown>).numChanges < THRESHOLD) {
    const id = `${tag}-${index}`
    head.change((doc) => { doc[field]![id] = entity(id) })
    index += 1
  }
  const next = await until(headOf, (now) => now !== url, 45_000)
  expect(next).not.toBe(url)
  return docId(url)
}

const parkedProducts = (log: Log) =>
  [...new Set(log.events('read_model.ordinary_sealed_product_parked').map((line) => docId(String(line.url))))]
const lastPhases = (log: Log) => {
  const lines = log.events('read_model.cold_build_phases')
  return lines[lines.length - 1] as Record<string, number>
}

/** Every ro_* row of the workspace, as text, per table. */
async function roSnapshot(): Promise<Record<string, string[]>> {
  const { rows: tables } = await db.pool.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name LIKE 'ro\\_%' AND column_name = 'landscape_id' ORDER BY 1`)
  const out: Record<string, string[]> = {}
  for (const { name } of tables) {
    const { rows } = await db.pool.query<{ x: string }>(
      `SELECT (to_jsonb(t) - 'updated_at' - 'created_at')::text AS x FROM ${name} t
        WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])
    out[name] = rows.map((row) => row.x).sort()
  }
  return out
}

/** A new process over the same storage, cold-building. */
async function coldStart(rootUrl: string, pool: IsolatedSchemaDb['pool'] = db.pool) {
  const repo2 = storageRepo()
  const residency2 = new AutomergeResidencyLeases(repo2)
  const stop2 = await start(repo2, rootUrl, residency2, pool)
  return { repo2, residency2, stop2 }
}

/** T9's corpus: a retired head sealed by SIZE listed first (never folded, so
 * it stays retired and forwarded), then two sealed products both holding
 * `dup` (p=first in the earlier one, p=second in the later one). Returns the
 * retired head and the parked product ids. */
async function dupCorpus(ws: Workspace, log: Log) {
  const dup = (p: string): Entity => ({ id: 'dup', name: 'dup', type: 'system', p })
  const retired = await fillAndRotate(ws, 'big', [], CEILING + 1)
  await fillAndRotate(ws, 'o0', [['dup', dup('first')]])
  await fillAndRotate(ws, 'o1')
  await until(() => parkedProducts(log), (ids) => ids.length >= 1, 60_000)
  await fillAndRotate(ws, 'o2')
  await fillAndRotate(ws, 'o3', [['dup', dup('second')]])
  const parked = await until(() => parkedProducts(log), (ids) => ids.length >= 2, 60_000)
  expect(parked.length).toBeGreaterThanOrEqual(2)
  expect((await until(() => roObject('dup'), (row) => row?.p === 'second', 15_000))?.p).toBe('second')
  expect(await until(() => rowStatus(retired), (status) => status === 'retired', 10_000)).toBe('retired')
  return { retired, parked }
}

suite('G4-16f C5 — sealed winners from SQL, values on demand (real projector, leases, Repo, PostgreSQL)', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'sealed_winners_projector')
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query(`CREATE TABLE automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query(`CREATE TABLE scopes (kind TEXT, landscape_id TEXT, version_id TEXT, org_id TEXT)`)
  })
  afterAll(async () => { await settle(500); await db?.teardown() })
  let restoreRegistration: () => void = () => {}
  beforeEach(async () => {
    process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '200'
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.pool.query(`TRUNCATE automerge_storage, automerge_document_workspace, ro_objects, ro_connections, ro_groups,
          read_model_projection_state, read_model_change_events, read_model_overlay_batch_acks,
          read_model_overlay_entity_bases, read_model_ordinary_head_retirements, read_model_document_watermarks,
          read_model_ordinary_chain_folds, read_model_adopt_watermarks, read_model_adopt_state,
          read_model_sealed_product_extracts, read_model_sealed_product_entities`)
        break
      } catch (error) {
        if ((error as { code?: string }).code !== '40P01' || attempt >= 5) throw error
        await settle(200)
      }
    }
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async ({ landscapeId, versionId, documentIds }) => {
      for (const documentId of documentIds) {
        await db.pool.query(
          'INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [documentId, landscapeId, versionId],
        )
      }
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
  })
  afterEach(() => {
    restoreRegistration()
    delete process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS
    delete process.env.READ_MODEL_SEALED_CACHE_INTERVAL_MS
  })

  it('V1: after a cold build served from the cache (nothing pinned), a forward\'s base is read from the extracts; an extract DELETED mid-session leaves the base unchanged — the product is reloaded from its document, given back, and its extract rewritten', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const { retired, parked } = await dupCorpus(ws, log)
      await until(async () => { await awaitSealedProductCacheWrites(WS); return extractCount() }, (n) => n >= parked.length, 30_000)
      stopA()
      await ws.repo.flush()
      await settle()
      // The park poll slowed to 10 minutes for B: only the reload
      // itself can give the product's lease back within the test.
      process.env.AM_ORDINARY_FOLD_ARRIVAL_POLL_MS = '600000'
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      expect(lastPhases(log).cacheHits).toBe(parked.length)
      // Served from the extracts: no value held in memory.
      expect(heldSealedValues(WS)).toBe(0)
      // A forward against the products' values, read from SQL.
      const late = await b.repo2.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
      late.change((doc) => { doc.objects.dup = { id: 'dup', name: 'dup', type: 'system', n: 'new' } })
      expect(await until(() => roObject('dup'), (value) => value?.n === 'new', 30_000)).toMatchObject({ n: 'new', p: 'second' })
      expect(log.events('read_model.ordinary_sealed_values_reloaded')).toEqual([])
      const reloadsBefore = documentLoadCount('steady', 'sealed-values')
      // The cache is derived: every extract deleted mid-session.
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts')
      // An id only the LATER product serves, which no forward has written
      // into the current head yet (a held id is merged against the head's
      // own value, never against the products'): `o3-0`, p=o3.
      expect((await roObject('o3-0'))?.p).toBe('o3')
      late.change((doc) => { doc.objects['o3-0'] = { id: 'o3-0', name: 'o3-0', type: 'system', n: 'newer' } })
      // RED on "omit on a miss": the base would lose `p`.
      expect(await until(() => roObject('o3-0'), (value) => value?.n === 'newer', 30_000)).toMatchObject({ n: 'newer', p: 'o3' })
      const reloaded = log.events('read_model.ordinary_sealed_values_reloaded')
      expect(reloaded.length).toBeGreaterThanOrEqual(1)
      expect(documentLoadCount('steady', 'sealed-values')).toBeGreaterThan(reloadsBefore)
      // Given back by the reload itself, within 5 s (the poll is 10 minutes).
      for (const line of reloaded) {
        const id = docId(String(line.url))
        expect(await until(async () => { await b.residency2.drain(); return !b.residency2.isLeased(id) && !resident(b.repo2, id) },
          (gone) => gone, 5_000)).toBe(true)
      }
      // Its extract is rewritten, and the values it pinned leave memory.
      await until(async () => { await awaitSealedProductCacheWrites(WS); return heldSealedValues(WS) }, (n) => n === 0, 30_000)
      expect(heldSealedValues(WS)).toBe(0)
      expect(await extractCount()).toBeGreaterThanOrEqual(reloaded.length)
      expect(log.events('read_model.ordinary_sealed_product_changed')).toEqual([])
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('V2: a product parked mid-session keeps its values in memory until its extract is committed — a forward before the write reads them there, never reloads', async () => {
    // The writer pauses 600 s before its first job: nothing is written here.
    process.env.READ_MODEL_SEALED_CACHE_INTERVAL_MS = '600000'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stop = await start(ws.repo, ws.rootUrl, residency)
    try {
      const { retired } = await dupCorpus(ws, log)
      expect(await extractCount()).toBe(0)
      // RED on "drop values before onWritten".
      expect(heldSealedValues(WS)).toBeGreaterThan(0)
      const reloadsBefore = documentLoadCount('steady', 'sealed-values')
      const late = await ws.repo.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
      late.change((doc) => { doc.objects.dup = { id: 'dup', name: 'dup', type: 'system', n: 'new' } })
      expect(await until(() => roObject('dup'), (value) => value?.n === 'new', 30_000)).toMatchObject({ n: 'new', p: 'second' })
      expect(log.events('read_model.ordinary_sealed_values_reloaded')).toEqual([])
      expect(documentLoadCount('steady', 'sealed-values')).toBe(reloadsBefore)
    } finally {
      stop()
      log.restore()
    }
  }, 300_000)

  it('V3: no value is held once the writer has drained — after mid-session parks, and after a cold build that read every product from its document', async () => {
    process.env.READ_MODEL_SEALED_CACHE_INTERVAL_MS = '1500'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const { retired, parked } = await dupCorpus(ws, log)
      await awaitSealedProductCacheWrites(WS)
      expect(await extractCount()).toBeGreaterThanOrEqual(parked.length)
      expect(heldSealedValues(WS)).toBe(0)
      // Probe #19: the unpinned products read from the extracts onWritten
      // recorded — a forward against them reloads nothing.
      const reloadsBefore = documentLoadCount('steady', 'sealed-values')
      const late = await ws.repo.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
      late.change((doc) => { doc.objects['o3-0'] = { id: 'o3-0', name: 'o3-0', type: 'system', n: 'after-drain' } })
      expect(await until(() => roObject('o3-0'), (value) => value?.n === 'after-drain', 30_000))
        .toMatchObject({ n: 'after-drain', p: 'o3' })
      expect(log.events('read_model.ordinary_sealed_values_reloaded')).toEqual([])
      expect(documentLoadCount('steady', 'sealed-values')).toBe(reloadsBefore)
      stopA()
      await ws.repo.flush()
      await settle()
      // Misses everywhere: every product is read from its document and pinned.
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts')
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      expect(lastPhases(log).cacheMisses).toBe(parked.length)
      // Witness that the counter counts: values held right after the build
      // (the writer pauses 1.5 s before its first job).
      expect(heldSealedValues(WS)).toBeGreaterThan(0)
      await awaitSealedProductCacheWrites(WS)
      expect(await extractCount()).toBeGreaterThanOrEqual(parked.length)
      expect(heldSealedValues(WS)).toBe(0)
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('V4: a duplicate inner id across a product, an UNSEALED segment and a later product — the cache cold build writes the same rows and defects as the document one (merge insertion order kept), and a registry pass reproduces the defects without reading one value', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      // List: base, Q (key k1 -> id X), big (unsealed, key k2 -> id X), P
      // (key k1 -> id X again; P wins k1). The full merge inserts k1 at Q's
      // slot, before k2, so the LAST occurrence of X is k2 (big's).
      const x = (p: string): Entity => ({ id: 'X', name: `x-${p}`, type: 'system', p })
      await fillAndRotate(ws, 'q0', [['k1', x('q')]])
      await fillAndRotate(ws, 'q1')
      await until(() => parkedProducts(log), (ids) => ids.length >= 1, 60_000)
      await fillAndRotate(ws, 'big', [['k2', x('big')]], CEILING + 1)
      await fillAndRotate(ws, 'p0')
      await fillAndRotate(ws, 'p1', [['k1', x('p')]])
      const parked = await until(() => parkedProducts(log), (ids) => ids.length >= 2, 60_000)
      expect(parked.length).toBeGreaterThanOrEqual(2)
      await until(async () => { await awaitSealedProductCacheWrites(WS); return extractCount() }, (n) => n >= parked.length, 30_000)
      stopA()
      await ws.repo.flush()
      await settle()

      // WITH the cache.
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      expect(lastPhases(log).cacheHits).toBe(parked.length)
      expect(lastPhases(log).duplicateIdsDropped).toBeGreaterThanOrEqual(1)
      const withCache = await roSnapshot()
      const withCacheState = await projectionState()
      expect((await roObject('X'))?.p).toBe('big')

      // A registry pass with every entity row gone: a value read would have
      // to reload a product. RED on "registry not skipping".
      await db.pool.query('DELETE FROM read_model_sealed_product_entities')
      const reloadsBefore = documentLoadCount('steady', 'sealed-values')
      const extractBefore = documentLoadCount('steady', 'extract')
      const generationBefore = Number(withCacheState?.projected_generation ?? 0)
      const registry = await b.repo2.find<{ diagrams: Record<string, unknown>; touched?: number }>(ws.registry.url)
      registry.change((doc) => { doc.touched = (doc.touched ?? 0) + 1 })
      const afterRegistry = await until(projectionState,
        (state) => state?.last_projection_kind === 'registry' && Number(state.projected_generation) > generationBefore, 15_000)
      expect(afterRegistry?.last_projection_kind).toBe('registry')
      // The same defects as the cold build (the duplicate X included).
      expect({ count: afterRegistry?.defect_count, summary: afterRegistry?.defect_summary })
        .toEqual({ count: withCacheState?.defect_count, summary: withCacheState?.defect_summary })
      expect(Number(afterRegistry?.defect_count ?? 0)).toBeGreaterThanOrEqual(1)
      expect(documentLoadCount('steady', 'sealed-values')).toBe(reloadsBefore)
      expect(documentLoadCount('steady', 'extract')).toBe(extractBefore)
      expect(log.events('read_model.ordinary_sealed_values_reloaded')).toEqual([])
      for (const id of parked) expect(resident(b.repo2, id)).toBe(false)
      expect(await roSnapshot()).toEqual(withCache)
      stopB()
      stopB = null
      await settle()

      // WITHOUT it: the same rows and the same defects.
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts')
      const c = await coldStart(ws.rootUrl)
      stopB = c.stop2
      expect(lastPhases(log).cacheMisses).toBe(parked.length)
      expect(await roSnapshot()).toEqual(withCache)
      const withoutState = await projectionState()
      expect({ count: withoutState?.defect_count, summary: withoutState?.defect_summary })
        .toEqual({ count: withCacheState?.defect_count, summary: withCacheState?.defect_summary })
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  /** The product whose extract holds `entityId` (one, in these corpora). */
  const productHolding = async (entityId: string, collection: 'object' | 'connection' = 'object') => {
    const { rows } = await db.pool.query<{ id: string }>(
      `SELECT product_document_id AS id FROM read_model_sealed_product_entities
        WHERE landscape_id = $1 AND collection = $2 AND entity_id = $3`, [WS.landscapeId, collection, entityId])
    expect(rows).toHaveLength(1)
    return rows[0]!.id
  }

  it('V5: ONE winners statement at the cold build; a forward asking three ids of two products reads them in ONE value statement, and a product whose extract answers only PART of them is reloaded (never served partially)', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const { retired, parked } = await dupCorpus(ws, log)
      await until(async () => { await awaitSealedProductCacheWrites(WS); return extractCount() }, (n) => n >= parked.length, 30_000)
      stopA()
      await ws.repo.flush()
      await settle()
      const { pool, counts } = countingPool()
      const b = await coldStart(ws.rootUrl, pool)
      stopB = b.stop2
      expect(lastPhases(log).cacheHits).toBe(parked.length)
      // Objects only: no connection product is cached.
      expect(counts.winners).toBe(1)
      const partial = await productHolding('o3-0')
      expect(await productHolding('o1-0')).not.toBe(partial)
      const lost = await db.pool.query(
        `DELETE FROM read_model_sealed_product_entities WHERE landscape_id = $1 AND entity_id = 'o3-0'`, [WS.landscapeId])
      expect(lost.rowCount).toBe(1)
      const valuesBefore = counts.values
      const late = await b.repo2.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
      late.change((doc) => {
        for (const id of ['o1-0', 'o3-0', 'o3-1']) doc.objects[id] = { id, name: id, type: 'system', n: 'batch' }
      })
      // RED on "every -> some": o3-1 answered, o3-0 not — o3-0 would lose `p`.
      for (const [id, p] of [['o1-0', 'o1'], ['o3-0', 'o3'], ['o3-1', 'o3']] as const) {
        expect(await until(() => roObject(id), (value) => value?.n === 'batch', 30_000)).toMatchObject({ n: 'batch', p })
      }
      expect(counts.values - valuesBefore).toBe(1)
      expect(log.events('read_model.ordinary_sealed_values_reloaded').map((line) => docId(String(line.url)))).toEqual([partial])
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('V6: a reload reads the content at the PARKED heads — a write to the document since (through another Repo) is not served', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const { retired, parked } = await dupCorpus(ws, log)
      await until(async () => { await awaitSealedProductCacheWrites(WS); return extractCount() }, (n) => n >= parked.length, 30_000)
      stopA()
      await ws.repo.flush()
      await settle()
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      const product = await productHolding('o3-1')
      const other = storageRepo()
      const handle = await other.find<ObjHead>(`automerge:${product}` as AutomergeUrl)
      handle.change((doc) => { doc.objects['o3-1']!.q = 'after-park' })
      await other.flush([handle.documentId])
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts')
      const late = await b.repo2.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
      late.change((doc) => { doc.objects['o3-1'] = { id: 'o3-1', name: 'o3-1', type: 'system', n: 'v6' } })
      const row = await until(() => roObject('o3-1'), (value) => value?.n === 'v6', 30_000)
      expect(row).toMatchObject({ n: 'v6', p: 'o3' })
      // RED on "view at the current heads".
      expect(row?.q).toBeUndefined()
      expect(log.events('read_model.ordinary_sealed_values_reloaded').map((line) => docId(String(line.url)))).toContain(product)
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('V7: an extract committed for the same document at OTHER heads than the product was parked at leaves its values pinned', async () => {
    process.env.READ_MODEL_SEALED_CACHE_INTERVAL_MS = '3000'
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stop = await start(ws.repo, ws.rootUrl, residency)
    try {
      await fillAndRotate(ws, 'h0')
      await fillAndRotate(ws, 'h1')
      const [product] = await until(() => parkedProducts(log), (ids) => ids.length >= 1, 60_000)
      const url = `automerge:${product}`
      // Parked at H1, its values pinned (the writer pauses 3 s first).
      expect(heldSealedValues(WS, url)).toBeGreaterThan(0)
      // H2: a write through another Repo, durable.
      const other = storageRepo()
      const handle = await other.find<ObjHead>(url as AutomergeUrl)
      handle.change((doc) => { doc.objects['h1-0']!.q = 'h2' })
      await other.flush([handle.documentId])
      const h2 = [...A.getHeads(handle.doc() as A.Doc<unknown>)]
      const headerHeads = async () => (await db.pool.query<{ heads: string[] }>(
        `SELECT heads FROM read_model_sealed_product_extracts WHERE landscape_id = $1 AND product_document_id = $2`,
        [WS.landscapeId, product])).rows[0]?.heads ?? null
      // Queued until the writer takes it (a task already queued for the
      // document is not queued twice), then written at H2.
      const written = await until(async () => {
        expect(enqueueSealedProductCacheWriteForTest(WS, { kind: 'object', documentId: product!, heads: h2 })).toBe(true)
        return headerHeads()
      }, (heads) => JSON.stringify(heads) === JSON.stringify(h2), 40_000)
      expect(written).toEqual(h2)
      // RED on "onWritten ignores the heads": the pins would be gone.
      expect(heldSealedValues(WS, url)).toBeGreaterThan(0)
    } finally {
      stop()
      log.restore()
    }
  }, 300_000)

  it('V8: CONNECTION products — no value held once the writer drained; a forward\'s base from the extracts, and from the document once one extract is deleted (a connection-kind reload)', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    const roConnection = async (id: string) => (await db.pool.query<{ data: Record<string, unknown> }>(
      'SELECT data FROM ro_connections WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
      [WS.landscapeId, WS.versionId, id])).rows[0]?.data
    const parkedConnections = () => [...new Set(log.events('read_model.ordinary_sealed_product_parked')
      .filter((line) => line.kind === 'connection').map((line) => docId(String(line.url))))]
    try {
      const retired = await fillAndRotate(ws, 'cbig', [], CEILING + 1, 'connection')
      await fillAndRotate(ws, 'c0', [], 0, 'connection')
      await fillAndRotate(ws, 'c1', [], 0, 'connection')
      await until(parkedConnections, (ids) => ids.length >= 1, 60_000)
      await fillAndRotate(ws, 'c2', [], 0, 'connection')
      await fillAndRotate(ws, 'c3', [], 0, 'connection')
      const parked = await until(parkedConnections, (ids) => ids.length >= 2, 60_000)
      expect(parked.length).toBeGreaterThanOrEqual(2)
      expect(await until(() => rowStatus(retired, 'connection'), (status) => status === 'retired', 10_000)).toBe('retired')
      await until(async () => { await awaitSealedProductCacheWrites(WS); return extractCount() }, (n) => n >= parked.length, 30_000)
      // Probe #16: nothing held once the writer drained.
      expect(heldSealedValues(WS)).toBe(0)
      stopA()
      await ws.repo.flush()
      await settle()
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      expect(lastPhases(log).cacheHits).toBe(parked.length)
      const late = await b.repo2.find<{ connections: Record<string, Entity> }>(`automerge:${retired}` as AutomergeUrl)
      // From the extracts.
      late.change((doc) => { doc.connections['c3-0'] = { id: 'c3-0', fromId: 'b', toId: 'b', label: 'c3-0', n: 'x' } })
      expect(await until(() => roConnection('c3-0'), (value) => value?.n === 'x', 30_000)).toMatchObject({ n: 'x', p: 'c3' })
      expect(log.events('read_model.ordinary_sealed_values_reloaded')).toEqual([])
      // One connection extract deleted: reloaded from its document.
      const product = await productHolding('c1-0', 'connection')
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts WHERE landscape_id = $1 AND product_document_id = $2',
        [WS.landscapeId, product])
      late.change((doc) => { doc.connections['c1-0'] = { id: 'c1-0', fromId: 'b', toId: 'b', label: 'c1-0', n: 'y' } })
      expect(await until(() => roConnection('c1-0'), (value) => value?.n === 'y', 30_000)).toMatchObject({ n: 'y', p: 'c1' })
      const reloaded = log.events('read_model.ordinary_sealed_values_reloaded')
      expect(reloaded.map((line) => [line.kind, docId(String(line.url))])).toEqual([['connection', product]])
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('V9: a product whose values can be read from nowhere for a DETERMINISTIC reason (extract gone, its storage now holds a document without the parked heads) is degraded ONCE, under its own error code, and never reloaded again by later forwards', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const { retired, parked } = await dupCorpus(ws, log)
      await until(async () => { await awaitSealedProductCacheWrites(WS); return extractCount() }, (n) => n >= parked.length, 30_000)
      stopA()
      await ws.repo.flush()
      await settle()
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      const product = await productHolding('o3-0')
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts')
      // Its rows replaced by an UNRELATED document's: it loads, and its
      // history holds none of the parked heads — the same answer every time.
      // Arrival kept at the old maximum, so the park poll sees no arrival.
      const { rows: [maxRow] } = await db.pool.query<{ max: string }>(
        `SELECT max(arrival_seq)::text AS max FROM automerge_storage WHERE split_part(key, '/', 1) = $1`, [product])
      await db.pool.query(`DELETE FROM automerge_storage WHERE split_part(key, '/', 1) = $1`, [product])
      const foreign = A.save(A.from<{ objects: Record<string, Entity> }>({ objects: { stray: { id: 'stray' } } }))
      await db.pool.query('INSERT INTO automerge_storage (key, data, arrival_seq) VALUES ($1, $2, $3::bigint)',
        [`${product}/snapshot/foreign`, Buffer.from(foreign), maxRow!.max])
      const originalFind = b.repo2.find.bind(b.repo2) as (...args: unknown[]) => unknown
      let finds = 0
      vi.spyOn(b.repo2, 'find').mockImplementation(((...args: unknown[]) => {
        if (String(args[0]).includes(product)) finds += 1
        return originalFind(...args)
      }) as unknown as typeof b.repo2.find)
      const late = await b.repo2.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
      late.change((doc) => { doc.objects['o3-0'] = { id: 'o3-0', name: 'o3-0', type: 'system', n: 'v9' } })
      const lostLines = await until(() => log.events('read_model.ordinary_sealed_values_lost'), (lines) => lines.length >= 1, 60_000)
      expect(lostLines).toHaveLength(1)
      expect(lostLines[0]).toMatchObject({ url: `automerge:${product}`, reason: 'unreadable' })
      expect(await until(async () => (await projectionState())?.degraded_since ?? null, (since) => since !== null, 10_000)).not.toBeNull()
      // Its own degradation, not "fold product changed after it was attached".
      expect(log.events('read_model.ordinary_fold_product_changed')).toEqual([])
      const degraded = (await db.pool.query<{ kind: string | null; code: string | null }>(
        `SELECT degraded_kind AS kind, degraded_error_code AS code FROM read_model_projection_state
          WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId])).rows[0]
      expect(degraded?.kind).toBe('object_shard')
      expect(String(degraded?.code)).not.toMatch(/FOLD_PRODUCT_CHANGED/i)
      expect(finds).toBeGreaterThan(0)
      const findsAtLoss = finds
      // Later forwards needing it: no document load again.
      late.change((doc) => { doc.objects['o3-1'] = { id: 'o3-1', name: 'o3-1', type: 'system', n: 'v9b' } })
      await settle(5_000)
      expect(finds).toBe(findsAtLoss)
      expect(log.events('read_model.ordinary_sealed_values_lost')).toHaveLength(1)
      // Never served partially: the row keeps its earlier value.
      expect((await roObject('o3-0'))?.n).toBeUndefined()
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)

  it('V10: a TRANSIENT resolution failure of a reload is not a loss — the forward fails, retries, and a later reload serves the base; nothing is marked lost and the workspace is not left degraded', async () => {
    const ws = await workspace(storageRepo())
    const residency = new AutomergeResidencyLeases(ws.repo)
    const log = logLines()
    const stopA = await start(ws.repo, ws.rootUrl, residency)
    let stopB: (() => void) | null = null
    try {
      const { retired, parked } = await dupCorpus(ws, log)
      await until(async () => { await awaitSealedProductCacheWrites(WS); return extractCount() }, (n) => n >= parked.length, 30_000)
      stopA()
      await ws.repo.flush()
      await settle()
      const b = await coldStart(ws.rootUrl)
      stopB = b.stop2
      const product = await productHolding('o3-0')
      await db.pool.query('DELETE FROM read_model_sealed_product_extracts')
      // The product's resolution fails while `failing` holds (a stalled
      // storage read, as seen from the projector), then works again.
      const failing = { value: true }
      let failed = 0
      const originalFind = b.repo2.find.bind(b.repo2) as (...args: unknown[]) => unknown
      vi.spyOn(b.repo2, 'find').mockImplementation(((...args: unknown[]) => {
        if (failing.value && String(args[0]).includes(product)) {
          failed += 1
          return Promise.reject(new Error('test: transient storage stall'))
        }
        return originalFind(...args)
      }) as unknown as typeof b.repo2.find)
      const late = await b.repo2.find<ObjHead>(`automerge:${retired}` as AutomergeUrl)
      late.change((doc) => { doc.objects['o3-0'] = { id: 'o3-0', name: 'o3-0', type: 'system', n: 'v10' } })
      // Witness: the reload's resolution DID fail.
      expect(await until(() => failed, (n) => n >= 1, 30_000)).toBeGreaterThanOrEqual(1)
      await settle(3_000)
      expect((await roObject('o3-0'))?.n).toBeUndefined()
      failing.value = false
      // RED on "every resolve failure is a loss": the base would never come.
      expect(await until(() => roObject('o3-0'), (value) => value?.n === 'v10', 90_000)).toMatchObject({ n: 'v10', p: 'o3' })
      expect(log.events('read_model.ordinary_sealed_values_lost')).toEqual([])
      expect(log.events('read_model.ordinary_sealed_values_reloaded').map((line) => docId(String(line.url)))).toContain(product)
      expect(await until(async () => (await projectionState())?.degraded_since ?? null, (since) => since === null, 30_000)).toBeNull()
    } finally {
      stopB?.()
      stopA()
      log.restore()
    }
  }, 300_000)
})
