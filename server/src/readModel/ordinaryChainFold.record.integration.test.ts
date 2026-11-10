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
import {
  abandonOrdinaryChainFold, ORDINARY_FOLD_MISMATCH, ordinaryFoldRecordRefusal, readOrdinaryChainFold,
  recordOrdinaryChainFold, retiredProductOrdinaryChainFolds, sweepOrdinaryChainFoldRows,
} from './ordinaryChainFold.js'
import { readOrdinaryHeadRetirement, recordOrdinaryHeadRetirement } from './ordinaryHeadForwarding.js'
import { commitOrdinaryHeadRetirement } from './ordinaryHeadRotator.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

/**
 * G4-16b phase 4 step 2: the fold RECORD (`recordOrdinaryChainFold`) and the
 * schema behind it, against PostgreSQL. Most of these began as the QA lens's
 * kill tests: each pins a clause no other test could fail on.
 *
 * Own schema (`rmocf_rec_test`); the unit half needs no database, the rest
 * skips without one (a skipped suite is not a pass).
 */
const WS: WorkspaceKey = { landscapeId: 'ls-ocf-rec', versionId: 'v1' }
const H = (c: string) => c.repeat(64)
const retain = () => new Date(Date.now() + 86_400_000)

describe('recordOrdinaryChainFold input validation (no database)', () => {
  const fakeTx = () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    return { tx: { query } as unknown as Queryable, query }
  }
  it.each([
    ['no sources', { sources: [] as string[] }, /no source/],
    ['a duplicated source', { sources: ['s1', 's1'] }, /named twice/],
    ['the product as its own source', { sources: ['s1', 'P'] }, /its own sources/],
    ['the current head as a source', { sources: ['s1', 'C'] }, /current write head/],
    ['the current head as the product', { product: 'C' }, /current write head/],
    ['a product without heads', { productHeads: [] as string[] }, /no heads/],
    ['a retainUntil in the past', { retainUntil: new Date(Date.now() - 1000) }, /retainUntil/],
    ['an invalid retainUntil', { retainUntil: new Date(Number.NaN) }, /retainUntil/],
  ])('refuses %s without issuing a query', async (_label, override, message) => {
    const { tx, query } = fakeTx()
    const o = override as { sources?: string[]; product?: string; productHeads?: string[]; retainUntil?: Date }
    await expect(recordOrdinaryChainFold(tx, WS, {
      collection: 'object',
      productDocumentId: o.product ?? 'P',
      productHeads: o.productHeads ?? [H('p')],
      currentDocumentId: 'C',
      sources: (o.sources ?? ['s1']).map((documentId) => ({ documentId, forwardedHeads: null })),
      retainUntil: o.retainUntil ?? retain(),
    })).rejects.toThrow(message)
    expect(query).not.toHaveBeenCalled()
  })
})

describe('ordinaryFoldRecordRefusal status check (no database)', () => {
  it('refuses a source whose row names the product but is not FOLDED', () => {
    const record = { collection: 'object' as const, productDocumentId: 'P', sourceDocumentIds: ['s1'] }
    expect(ordinaryFoldRecordRefusal(record, ['s1'], () => ({ status: 'retired', foldedInto: 'P' })))
      .toBe(ORDINARY_FOLD_MISMATCH)
  })
})

const SCHEMA = 'rmocf_rec_test'
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'
async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({
    connectionString: URL, max: 4, connectionTimeoutMillis: 4000, options: `-c search_path=${SCHEMA},public`,
  }), 'ordinaryChainFoldRecord')
  try {
    const c = await p.connect()
    try {
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
      const { ensureReadModelSchema } = await import('./schema.js')
      await ensureReadModelSchema(c)
      // The sweep's pending-arrival probe reads storage: OUR table, ahead of
      // `public` on the search path, so the test never writes the shared one.
      await c.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.automerge_storage (
        key TEXT PRIMARY KEY, data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        arrival_seq BIGINT)`)
    } finally { c.release() }
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}
const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[ordinaryChainFold.record] no Postgres at ${URL} — skipping`)

async function inTx<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool!.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
const retire = (documentId: string, heads = [H('a')]) => recordOrdinaryHeadRetirement(pool!, WS, {
  collection: 'object', documentId, retirementHeads: heads, status: 'retired',
})
const foldArgs = (product: string, sources: Array<{ documentId: string; forwardedHeads: string[] | null }>) => ({
  collection: 'object' as const, productDocumentId: product, productHeads: [H('p')], currentDocumentId: 'CURRENT',
  sources, retainUntil: retain(),
})
const fold = (product: string, sources: Array<{ documentId: string; forwardedHeads: string[] | null }>) =>
  inTx((tx) => recordOrdinaryChainFold(tx, WS, foldArgs(product, sources)))
const status = async (id: string) => {
  const row = await readOrdinaryHeadRetirement(pool!, WS, 'object', id)
  return row && { status: row.status, foldedInto: row.foldedInto }
}

// File level: both suites below share the pool.
afterAll(async () => {
  if (!pool) return
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await pool.end()
})

suite('the fold record (PostgreSQL)', () => {
  beforeEach(async () => {
    await pool!.query('TRUNCATE read_model_ordinary_head_retirements, read_model_ordinary_chain_folds')
  })

  it('records: every source FOLDED into the product, the product RETIRED with its heads as H_r, and the fold row', async () => {
    await retire('s1')
    await retire('s2')
    expect(await fold('P', [
      { documentId: 's1', forwardedHeads: null }, { documentId: 's2', forwardedHeads: null },
    ])).toBe('recorded')
    expect(await status('s1')).toEqual({ status: 'folded', foldedInto: 'P' })
    expect(await status('s2')).toEqual({ status: 'folded', foldedInto: 'P' })
    const product = await readOrdinaryHeadRetirement(pool!, WS, 'object', 'P')
    expect(product).toMatchObject({ status: 'retired', retirementHeads: [H('p')], forwardedHeads: null, foldedInto: null })
    expect((await readOrdinaryChainFold(pool!, WS, 'object', 'P'))?.sourceDocumentIds).toEqual(['s1', 's2'])
  })

  it('a PRODUCT is itself a fold source later: the chain of folds is not a dead end', async () => {
    await retire('s1')
    await fold('P1', [{ documentId: 's1', forwardedHeads: null }])
    await retire('s2')
    expect(await fold('P2', [
      { documentId: 'P1', forwardedHeads: null }, { documentId: 's2', forwardedHeads: null },
    ])).toBe('recorded')
    expect(await status('P1')).toEqual({ status: 'folded', foldedInto: 'P2' })
    expect(await status('s1')).toEqual({ status: 'folded', foldedInto: 'P1' })
  })

  it('a RETRY of a committed fold (same product, same sources) is already-recorded and writes nothing', async () => {
    await retire('s1')
    await fold('P', [{ documentId: 's1', forwardedHeads: null }])
    expect(await fold('P', [{ documentId: 's1', forwardedHeads: null }])).toBe('already-recorded')
    expect(await status('s1')).toEqual({ status: 'folded', foldedInto: 'P' })
  })

  it('refuses OUTSIDE a transaction (a pool, autocommit): the savepoint throws before any write', async () => {
    await retire('s1')
    await expect(recordOrdinaryChainFold(pool!, WS, foldArgs('P', [{ documentId: 's1', forwardedHeads: null }])))
      .rejects.toThrow(/SAVEPOINT/)
    expect(await status('s1')).toEqual({ status: 'retired', foldedInto: null })
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P')).toBeUndefined()
  })

  it('a conflict leaves the CALLER\'s transaction usable: the savepoint is rolled back, not the transaction', async () => {
    await retire('s1')
    await pool!.query(
      `UPDATE read_model_ordinary_head_retirements SET forwarded_heads = $3::text[]
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = 's1'`,
      [WS.landscapeId, WS.versionId, [H('f')]],
    )
    await inTx(async (tx) => {
      await expect(recordOrdinaryChainFold(tx, WS, foldArgs('P', [{ documentId: 's1', forwardedHeads: null }])))
        .rejects.toMatchObject({ name: 'OrdinaryChainFoldConflictError', conflicting: ['s1'] })
      // Still usable: a statement after the conflict runs.
      await tx.query('SELECT 1')
    })
  })

  it('the schema migration is GUARDED: a second run neither drops nor re-adds the two CHECKs', async () => {
    const oids = async () => (await pool!.query<{ conname: string; oid: string }>(
      `SELECT conname, oid::text AS oid FROM pg_constraint
       WHERE conrelid = to_regclass(current_schema() || '.read_model_ordinary_head_retirements')
         AND conname IN ('read_model_ordinary_head_retirements_status_check',
                         'read_model_ordinary_head_retirements_folded_check')
       ORDER BY conname`,
    )).rows
    const before = await oids()
    expect(before).toHaveLength(2)
    const client = await pool!.connect()
    try {
      const { ensureReadModelSchema } = await import('./schema.js')
      await ensureReadModelSchema(client)
    } finally {
      client.release()
    }
    expect(await oids()).toEqual(before)
  })

  it('G4-16e origin: the rotator writes rotation, a fold product fold-product; an older schema is backfilled ONCE from the fold records', async () => {
    const origins = async () => Object.fromEntries((await pool!.query<{ document_id: string; origin: string | null }>(
      `SELECT document_id, origin FROM read_model_ordinary_head_retirements WHERE landscape_id = $1 ORDER BY document_id`,
      [WS.landscapeId],
    )).rows.map((row) => [row.document_id, row.origin]))
    const ensure = async () => {
      const client = await pool!.connect()
      try {
        const { ensureReadModelSchema } = await import('./schema.js')
        await ensureReadModelSchema(client)
      } finally { client.release() }
    }
    await inTx((tx) => commitOrdinaryHeadRetirement(tx, WS, 'object', 'r1', [H('r')]))
    await retire('s1')
    await fold('P', [{ documentId: 's1', forwardedHeads: null }])
    // The test helper writes no origin, as a row older than the column has none.
    expect(await origins()).toEqual({ P: 'fold-product', r1: 'rotation', s1: null })
    // An older schema: no column. The migration adds it and names the
    // recorded product; what it cannot know stays NULL (counted as a rotation).
    await pool!.query('ALTER TABLE read_model_ordinary_head_retirements DROP COLUMN origin')
    await ensure()
    expect(await origins()).toEqual({ P: 'fold-product', r1: null, s1: null })
    // GUARDED: with the column present, a boot does not backfill again.
    await pool!.query(`UPDATE read_model_ordinary_head_retirements SET origin = NULL WHERE document_id = 'P'`)
    await ensure()
    expect(await origins()).toEqual({ P: null, r1: null, s1: null })
    // And the rotator's re-retirement upsert (step 7's crash) labels its row.
    await inTx((tx) => commitOrdinaryHeadRetirement(tx, WS, 'object', 'r1', [H('q')]))
    expect((await origins()).r1).toBe('rotation')
  })

  it('the schema refuses a FOLDED row without H_r (a folded head must still be able to forward)', async () => {
    await expect(pool!.query(
      `INSERT INTO read_model_ordinary_head_retirements
         (landscape_id, version_id, collection, document_id, retirement_heads, status, folded_into, retain_until)
       VALUES ($1, $2, 'object', 'doc-check', NULL, 'folded', 'p', now())`,
      [WS.landscapeId, WS.versionId],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it.each([
    ['retired with folded_into only', `'retired', 'p', NULL`],
    ['retired with retain_until only', `'retired', NULL, now()`],
  ])('the schema refuses a row %s', async (_label, values) => {
    await expect(pool!.query(
      `INSERT INTO read_model_ordinary_head_retirements
         (landscape_id, version_id, collection, document_id, retirement_heads, status, folded_into, retain_until)
       VALUES ($1, $2, 'object', 'doc-check', ARRAY['a'], ${values})`,
      [WS.landscapeId, WS.versionId],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it.each([
    ['an unknown collection', `'diagram', 'p', ARRAY['s']`, '23514'],
    ['no sources', `'object', 'p', ARRAY[]::text[]`, '23514'],
  ])('the folds table refuses %s', async (_label, values, code) => {
    await expect(pool!.query(
      `INSERT INTO read_model_ordinary_chain_folds (landscape_id, version_id, collection, product_document_id, source_document_ids)
       VALUES ($1, $2, ${values})`,
      [WS.landscapeId, WS.versionId],
    )).rejects.toMatchObject({ code })
  })

  it('the folds table holds ONE row per product: a second fold into the same product with other sources is refused', async () => {
    await retire('s1')
    await retire('s2')
    await fold('P', [{ documentId: 's1', forwardedHeads: null }])
    await expect(fold('P', [{ documentId: 's2', forwardedHeads: null }]))
      .rejects.toMatchObject({ name: 'OrdinaryChainFoldConflictError' })
    await expect(pool!.query(
      `INSERT INTO read_model_ordinary_chain_folds (landscape_id, version_id, collection, product_document_id, source_document_ids)
       VALUES ($1, $2, 'object', 'P', ARRAY['s2'])`,
      [WS.landscapeId, WS.versionId],
    )).rejects.toMatchObject({ code: '23505' })
    expect(await status('s2')).toEqual({ status: 'retired', foldedInto: null })
    expect((await readOrdinaryChainFold(pool!, WS, 'object', 'P'))?.sourceDocumentIds).toEqual(['s1'])
  })

  it('a source already FOLDED cannot be folded again into another product', async () => {
    await retire('s1')
    await fold('P1', [{ documentId: 's1', forwardedHeads: null }])
    await expect(fold('P2', [{ documentId: 's1', forwardedHeads: null }]))
      .rejects.toMatchObject({ name: 'OrdinaryChainFoldConflictError', conflicting: ['s1'] })
    expect(await status('s1')).toEqual({ status: 'folded', foldedInto: 'P1' })
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P2')).toBeUndefined()
    expect(await readOrdinaryHeadRetirement(pool!, WS, 'object', 'P2')).toBeUndefined()
  })

  it('an ADMITTED row (never retired) is not a fold source', async () => {
    await recordOrdinaryHeadRetirement(pool!, WS, {
      collection: 'object', documentId: 's1', retirementHeads: [H('a')], status: 'admitted',
    })
    await expect(fold('P', [{ documentId: 's1', forwardedHeads: null }]))
      .rejects.toMatchObject({ name: 'OrdinaryChainFoldConflictError' })
    expect(await status('s1')).toEqual({ status: 'admitted', foldedInto: null })
  })

  it('a product that already has a retirement row is refused, and nothing moves', async () => {
    await retire('s1')
    await retire('P')
    await expect(fold('P', [{ documentId: 's1', forwardedHeads: null }]))
      .rejects.toMatchObject({ name: 'OrdinaryChainFoldConflictError', conflicting: ['P'] })
    expect(await status('s1')).toEqual({ status: 'retired', foldedInto: null })
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P')).toBeUndefined()
  })

  it('the CAS compares forwarded_heads as a SET: the heads read in any order match the stored (sorted) row', async () => {
    await retire('s1')
    await pool!.query(
      `UPDATE read_model_ordinary_head_retirements SET forwarded_heads = $3::text[]
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = 's1'`,
      [WS.landscapeId, WS.versionId, [H('b'), H('c')]],
    )
    await fold('P', [{ documentId: 's1', forwardedHeads: [H('c'), H('b')] }])
    expect(await status('s1')).toEqual({ status: 'folded', foldedInto: 'P' })
  })

  it('ONE stale source among several fails the whole fold, names it, and leaves every source retired', async () => {
    await retire('s1')
    await retire('s2')
    await pool!.query(
      `UPDATE read_model_ordinary_head_retirements SET forwarded_heads = $3::text[]
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = 's2'`,
      [WS.landscapeId, WS.versionId, [H('f')]],
    )
    await expect(fold('P', [
      { documentId: 's1', forwardedHeads: null },
      { documentId: 's2', forwardedHeads: null },
    ])).rejects.toMatchObject({ name: 'OrdinaryChainFoldConflictError', conflicting: ['s2'] })
    expect(await status('s1')).toEqual({ status: 'retired', foldedInto: null })
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P')).toBeUndefined()
  })

  it('the ROTATOR never re-retires a FOLDED head: its upsert refuses and the row stays folded', async () => {
    await retire('s1')
    await fold('P', [{ documentId: 's1', forwardedHeads: null }])
    await expect(inTx((tx) => commitOrdinaryHeadRetirement(tx, WS, 'object', 's1', [H('z')])))
      .rejects.toThrow(/is folded; it cannot be retired again/)
    expect(await status('s1')).toEqual({ status: 'folded', foldedInto: 'P' })
    // A retired (not folded) head is still re-retired as before.
    await inTx((tx) => commitOrdinaryHeadRetirement(tx, WS, 'object', 'P', [H('z')]))
    expect(await readOrdinaryHeadRetirement(pool!, WS, 'object', 'P')).toMatchObject({ status: 'retired', retirementHeads: [H('z')] })
  })
})

/**
 * Phase 4 step 5: undoing a fold recorded and never published
 * (`abandonOrdinaryChainFold`) and sweeping the rows nothing reads any more
 * (`sweepOrdinaryChainFoldRows`).
 */
suite('abandon and sweep (PostgreSQL)', () => {
  beforeEach(async () => {
    await pool!.query('TRUNCATE read_model_ordinary_head_retirements, read_model_ordinary_chain_folds, automerge_storage')
  })
  const abandon = (product: string) =>
    inTx((tx) => abandonOrdinaryChainFold(tx, WS, { collection: 'object', productDocumentId: product }))
  const sweep = (limit?: number) => inTx((tx) => sweepOrdinaryChainFoldRows(tx, WS, 'object', limit))
  /** Retention over, and (for a product) folded long enough ago. */
  const expire = (ids: string[]) => pool!.query(
    `UPDATE read_model_ordinary_head_retirements
        SET retain_until = now() - interval '1 second', updated_at = now() - interval '1 hour'
     WHERE landscape_id = $1 AND version_id = $2 AND document_id = ANY($3::text[])`,
    [WS.landscapeId, WS.versionId, ids],
  )
  /** Folded long enough ago, retention untouched. */
  const age = (ids: string[]) => pool!.query(
    `UPDATE read_model_ordinary_head_retirements SET updated_at = now() - interval '1 hour'
     WHERE landscape_id = $1 AND version_id = $2 AND document_id = ANY($3::text[])`,
    [WS.landscapeId, WS.versionId, ids],
  )
  const ids = async () => (await pool!.query<{ document_id: string }>(
    `SELECT document_id FROM read_model_ordinary_head_retirements
     WHERE landscape_id = $1 AND version_id = $2 ORDER BY document_id`, [WS.landscapeId, WS.versionId],
  )).rows.map((row) => row.document_id)
  /** s1, s2 -> P1; P1, s3 -> P2 (P2 listed, P1 folded). */
  const chain = async () => {
    await retire('s1')
    await retire('s2')
    await fold('P1', [{ documentId: 's1', forwardedHeads: null }, { documentId: 's2', forwardedHeads: null }])
    await retire('s3')
    await fold('P2', [{ documentId: 'P1', forwardedHeads: null }, { documentId: 's3', forwardedHeads: null }])
  }
  const refusalOf = async (product: string, marker: string[]) => {
    const record = await readOrdinaryChainFold(pool!, WS, 'object', product)
    const rows = new Map<string, { status: string; foldedInto: string | null }>()
    for (const id of marker) {
      const row = await readOrdinaryHeadRetirement(pool!, WS, 'object', id)
      if (row) rows.set(id, row)
    }
    return ordinaryFoldRecordRefusal(record, marker, (id) => rows.get(id))
  }

  it('abandon: the sources go back to RETIRED (heads kept), the product\'s row and record are gone', async () => {
    await retire('s1', [H('a')])
    await retire('s2', [H('b')])
    await pool!.query(
      `UPDATE read_model_ordinary_head_retirements SET forwarded_heads = $3::text[]
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = 's2'`,
      [WS.landscapeId, WS.versionId, [H('f')]],
    )
    await fold('P', [{ documentId: 's2', forwardedHeads: [H('f')] }, { documentId: 's1', forwardedHeads: null }])
    await pool!.query(
      `UPDATE read_model_ordinary_head_retirements SET arrival_watermark = 7
       WHERE landscape_id = $1 AND version_id = $2 AND document_id = 's1'`, [WS.landscapeId, WS.versionId],
    )
    expect(await abandon('P')).toEqual({ outcome: 'abandoned', reverted: ['s1', 's2'] })
    expect(await readOrdinaryHeadRetirement(pool!, WS, 'object', 's1')).toMatchObject({
      status: 'retired', foldedInto: null, retirementHeads: [H('a')], forwardedHeads: null,
    })
    expect(await readOrdinaryHeadRetirement(pool!, WS, 'object', 's2')).toMatchObject({
      status: 'retired', foldedInto: null, retirementHeads: [H('b')], forwardedHeads: [H('f')],
    })
    const { rows } = await pool!.query<{ retain_until: Date | null; arrival_watermark: string | null }>(
      `SELECT retain_until, arrival_watermark FROM read_model_ordinary_head_retirements
       WHERE landscape_id = $1 AND version_id = $2 AND document_id IN ('s1', 's2')`, [WS.landscapeId, WS.versionId],
    )
    expect(rows).toEqual([{ retain_until: null, arrival_watermark: null }, { retain_until: null, arrival_watermark: null }])
    expect(await readOrdinaryHeadRetirement(pool!, WS, 'object', 'P')).toBeUndefined()
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P')).toBeUndefined()
    // Foldable again, into another product.
    expect(await fold('Q', [{ documentId: 's1', forwardedHeads: null }, { documentId: 's2', forwardedHeads: [H('f')] }]))
      .toBe('recorded')
  })

  it('abandon of a product folded again (published) is NOT-PENDING and moves nothing', async () => {
    await chain()
    expect(await abandon('P1')).toEqual({ outcome: 'not-pending' })
    expect(await status('P1')).toEqual({ status: 'folded', foldedInto: 'P2' })
    expect(await status('s1')).toEqual({ status: 'folded', foldedInto: 'P1' })
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P1')).toBeTruthy()
  })

  it('abandon of a product with a row but no record is NOT-PENDING: the row survives (savepoint rolled back)', async () => {
    await retire('P')
    expect(await abandon('P')).toEqual({ outcome: 'not-pending' })
    expect(await status('P')).toEqual({ status: 'retired', foldedInto: null })
  })

  it('abandon refuses OUTSIDE a transaction', async () => {
    await retire('s1')
    await fold('P', [{ documentId: 's1', forwardedHeads: null }])
    await expect(abandonOrdinaryChainFold(pool!, WS, { collection: 'object', productDocumentId: 'P' }))
      .rejects.toThrow(/SAVEPOINT/)
    expect(await status('s1')).toEqual({ status: 'folded', foldedInto: 'P' })
  })

  it('sweep: an expired source of a FOLDED product goes, with the product\'s record; the listed product still vouches', async () => {
    await chain()
    await expire(['s1', 's2', 'P1', 's3'])
    expect(await sweep()).toEqual({ rows: 2, records: 1 })
    expect(await ids()).toEqual(['P1', 'P2', 's3'])
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P1')).toBeUndefined()
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P2')).toBeTruthy()
    // A cold build still accepts P2: its sources' rows are untouched.
    expect(await refusalOf('P2', ['P1', 's3'])).toBeNull()
    expect(await sweep()).toEqual({ rows: 0, records: 0 })
  })

  it('sweep keeps an UNEXPIRED source, and an expired source of a product still listed (RETIRED)', async () => {
    await chain()
    await expire(['P1', 's3'])
    expect(await sweep()).toEqual({ rows: 0, records: 0 })
    expect(await ids()).toEqual(['P1', 'P2', 's1', 's2', 's3'])
    expect(await refusalOf('P2', ['P1', 's3'])).toBeNull()
    expect(await refusalOf('P1', ['s1', 's2'])).toBeNull()
  })

  it('sweep keeps an expired source whose head holds an arrival above its watermark (a late write not carried yet), and takes it once the watermark has moved', async () => {
    await chain()
    await expire(['s1', 's2', 'P1', 's3'])
    const setWatermark = (id: string, watermark: number) => pool!.query(
      `UPDATE read_model_ordinary_head_retirements SET arrival_watermark = $4
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [WS.landscapeId, WS.versionId, id, watermark],
    )
    await setWatermark('s1', 10)
    await setWatermark('s2', 10)
    // s1: a content chunk above its watermark. s2: only at it, and a sync
    // state above it (never an arrival).
    await pool!.query(
      `INSERT INTO automerge_storage (key, data, arrival_seq) VALUES
       ('s1/incremental/a', '\\x01', 11), ('s2/incremental/a', '\\x01', 10), ('s2/sync-state/peer', '\\x01', 99)`,
    )
    expect(await sweep()).toEqual({ rows: 1, records: 0 })
    expect(await ids()).toEqual(['P1', 'P2', 's1', 's3'])
    // Carried: the watermark reaches the arrival, and the next pass takes it.
    await setWatermark('s1', 11)
    expect(await sweep()).toEqual({ rows: 1, records: 1 })
    expect(await ids()).toEqual(['P1', 'P2', 's3'])
  })

  it('sweep keeps a row named in `keep` (owed a handover re-check, G4-16d), whatever else holds, and takes it once it is not', async () => {
    await chain()
    await expire(['s1', 's2', 'P1', 's3'])
    expect(await inTx((tx) => sweepOrdinaryChainFoldRows(tx, WS, 'object', undefined, ['s1'])))
      .toEqual({ rows: 1, records: 0 })
    expect(await ids()).toEqual(['P1', 'P2', 's1', 's3'])
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P1')).toBeTruthy()
    expect(await sweep()).toEqual({ rows: 1, records: 1 })
    expect(await ids()).toEqual(['P1', 'P2', 's3'])
  })

  it('sweep waits until the product was folded GRACE ago: an attach that just saw it listed still vouches', async () => {
    await chain()
    await pool!.query(
      `UPDATE read_model_ordinary_head_retirements SET retain_until = now() - interval '1 second'
       WHERE landscape_id = $1 AND version_id = $2 AND document_id IN ('s1', 's2')`, [WS.landscapeId, WS.versionId],
    )
    expect(await sweep()).toEqual({ rows: 0, records: 0 })
    expect(await refusalOf('P1', ['s1', 's2'])).toBeNull()
    await age(['P1'])
    expect(await sweep()).toEqual({ rows: 2, records: 1 })
  })

  it('a BACKLOG (a product and its sources all expired at once) leaves no record behind', async () => {
    await chain()
    await retire('s4')
    await fold('P3', [{ documentId: 'P2', forwardedHeads: null }, { documentId: 's4', forwardedHeads: null }])
    await expire(['s1', 's2', 'P1', 's3', 'P2'])
    // s1, s2 (into P1) and P1, s3 (into P2) go in one statement; P1's row is
    // then absent, which must not strand its record.
    expect(await sweep()).toEqual({ rows: 4, records: 2 })
    expect(await ids()).toEqual(['P2', 'P3', 's4'])
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P1')).toBeUndefined()
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P2')).toBeUndefined()
    expect(await refusalOf('P3', ['P2', 's4'])).toBeNull()
  })

  it('the sweep never deletes the record of a RETIRED product (listed, or pending for the writer)', async () => {
    await retire('s1')
    await fold('P', [{ documentId: 's1', forwardedHeads: null }])
    await expire(['s1'])
    await age(['P'])
    expect(await sweep()).toEqual({ rows: 0, records: 0 })
    expect(await status('s1')).toEqual({ status: 'folded', foldedInto: 'P' })
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P')).toBeTruthy()
  })

  it('retiredProductOrdinaryChainFolds lists the records whose product is still RETIRED, newest first, with an age', async () => {
    await chain()
    await retire('s9')
    await fold('Q', [{ documentId: 's9', forwardedHeads: null }])
    await pool!.query(
      `UPDATE read_model_ordinary_chain_folds SET created_at = now() - interval '2 hours'
       WHERE landscape_id = $1 AND version_id = $2 AND product_document_id = 'P2'`, [WS.landscapeId, WS.versionId],
    )
    const found = await retiredProductOrdinaryChainFolds(pool!, WS, 'object')
    expect(found.map((record) => record.productDocumentId)).toEqual(['Q', 'P2'])
    expect(found[1]!.sourceDocumentIds).toEqual(['P1', 's3'])
    expect(found[1]!.ageMs).toBeGreaterThanOrEqual(7_200_000)
    expect(found[1]!.ageMs).toBeLessThan(7_300_000)
    expect(found[0]!.ageMs).toBeLessThan(60_000)
    expect(await retiredProductOrdinaryChainFolds(pool!, WS, 'connection')).toEqual([])
  })

  it('sweep is bounded: a record goes only once every row folded into its product has', async () => {
    await chain()
    await expire(['s1', 's2'])
    await age(['P1'])
    expect(await sweep(1)).toEqual({ rows: 1, records: 0 })
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P1')).toBeTruthy()
    expect(await sweep(1)).toEqual({ rows: 1, records: 1 })
    expect(await ids()).toEqual(['P1', 'P2', 's3'])
  })

  it('sweep touches only its own collection and workspace', async () => {
    await chain()
    await expire(['s1', 's2'])
    await age(['P1'])
    expect(await inTx((tx) => sweepOrdinaryChainFoldRows(tx, WS, 'connection'))).toEqual({ rows: 0, records: 0 })
    expect(await inTx((tx) => sweepOrdinaryChainFoldRows(tx, { ...WS, versionId: 'other' }, 'object')))
      .toEqual({ rows: 0, records: 0 })
    expect(await ids()).toEqual(['P1', 'P2', 's1', 's2', 's3'])
  })

  // The QA lens's kill tests (phase 4 step 5), each pinning a clause the
  // tests above could not fail on.

  const OTHER_VERSION: WorkspaceKey = { ...WS, versionId: 'v-other' }
  type Scope = { key: WorkspaceKey; collection: 'object' | 'connection' }
  const SCOPES: Array<[string, Scope]> = [
    ['another version of the landscape', { key: OTHER_VERSION, collection: 'object' }],
    ['another collection of the workspace', { key: WS, collection: 'connection' }],
  ]
  const retireIn = (scope: Scope, documentId: string) => recordOrdinaryHeadRetirement(pool!, scope.key, {
    collection: scope.collection, documentId, retirementHeads: [H('a')], status: 'retired',
  })
  const foldIn = (scope: Scope, product: string, sources: string[]) => inTx((tx) => recordOrdinaryChainFold(tx, scope.key, {
    ...foldArgs(product, sources.map((documentId) => ({ documentId, forwardedHeads: null }))),
    collection: scope.collection,
  }))
  const statusIn = async (scope: Scope, id: string) => {
    const row = await readOrdinaryHeadRetirement(pool!, scope.key, scope.collection, id)
    return row && { status: row.status, foldedInto: row.foldedInto }
  }
  /** Every folded row, in every scope: retention over, folded long enough ago. */
  const expireAll = () => pool!.query(
    `UPDATE read_model_ordinary_head_retirements
        SET retain_until = now() - interval '1 second', updated_at = now() - interval '1 hour'
      WHERE status = 'folded'`)
  /** s1, s2 -> P1; P1, s3 -> P2, in any scope. */
  const chainIn = async (scope: Scope) => {
    await retireIn(scope, 's1')
    await retireIn(scope, 's2')
    await foldIn(scope, 'P1', ['s1', 's2'])
    await retireIn(scope, 's3')
    await foldIn(scope, 'P2', ['P1', 's3'])
  }

  // The product DELETE, the record DELETE and the revert UPDATE each keep
  // their version and collection: the same ids in another scope are another fold.
  it.each(SCOPES)('abandon touches nothing in %s holding the same ids', async (_label, other) => {
    const here: Scope = { key: WS, collection: 'object' }
    for (const scope of [here, other]) {
      await retireIn(scope, 's1')
      await foldIn(scope, 'P', ['s1'])
    }
    expect(await abandon('P')).toEqual({ outcome: 'abandoned', reverted: ['s1'] })
    expect(await statusIn(here, 's1')).toEqual({ status: 'retired', foldedInto: null })
    expect(await statusIn(other, 's1')).toEqual({ status: 'folded', foldedInto: 'P' })
    expect(await statusIn(other, 'P')).toEqual({ status: 'retired', foldedInto: null })
    expect(await readOrdinaryChainFold(pool!, other.key, other.collection, 'P')).toBeTruthy()
  })

  // `reverted` is sorted, not RETURNING's physical order.
  it('abandon reports the reverted sources SORTED, whatever order the rows are stored in', async () => {
    for (const id of ['s9', 's5', 's1']) await retire(id)
    await fold('P', ['s9', 's5', 's1'].map((documentId) => ({ documentId, forwardedHeads: null })))
    // A sequential scan returns the rows in their physical (update) order: s9,
    // s5, s1. An index scan would hand them over sorted and hide the fault.
    expect(await inTx(async (tx) => {
      await tx.query('SET LOCAL enable_indexscan = off; SET LOCAL enable_bitmapscan = off; SET LOCAL enable_indexonlyscan = off')
      return abandonOrdinaryChainFold(tx, WS, { collection: 'object', productDocumentId: 'P' })
    })).toEqual({ outcome: 'abandoned', reverted: ['s1', 's5', 's9'] })
  })

  // A statement failing inside the abandon leaves the CALLER's transaction
  // usable and nothing half-undone (product row and record deleted, sources
  // still folded).
  it('a statement failing inside abandon rolls back to its savepoint: the caller\'s transaction stays usable', async () => {
    await retire('s1')
    await fold('P', [{ documentId: 's1', forwardedHeads: null }])
    const after = await inTx(async (tx) => {
      const failing: Queryable = {
        query: ((text: string, values?: unknown[]) => /SET status = 'retired', folded_into = NULL/.test(text)
          ? tx.query('SELECT 1 / 0')
          : tx.query(text, values)) as Queryable['query'],
      }
      await expect(abandonOrdinaryChainFold(failing, WS, { collection: 'object', productDocumentId: 'P' }))
        .rejects.toThrow(/division by zero/)
      return (await tx.query<{ n: number }>('SELECT 1 AS n')).rows[0]!.n
    })
    expect(after).toBe(1)
    expect(await status('s1')).toEqual({ status: 'folded', foldedInto: 'P' })
    expect(await status('P')).toEqual({ status: 'retired', foldedInto: null })
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P')).toBeTruthy()
  })

  // Both sweep DELETEs keep their outer scoping, and the records' NOT EXISTS
  // its collection: a source folded into a same-id product elsewhere does not
  // keep this record.
  it.each(SCOPES)('sweep deletes nothing in %s holding the same ids, and still sweeps its own', async (_label, other) => {
    await chainIn({ key: WS, collection: 'object' })
    // Elsewhere: s1 -> P1 with P1 still listed (`retired`): nothing there may go.
    await retireIn(other, 's1')
    await foldIn(other, 'P1', ['s1'])
    await expireAll()
    expect(await sweep()).toEqual({ rows: 2, records: 1 })
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P1')).toBeUndefined()
    expect(await statusIn(other, 's1')).toEqual({ status: 'folded', foldedInto: 'P1' })
    expect(await readOrdinaryChainFold(pool!, other.key, other.collection, 'P1')).toBeTruthy()
  })

  // The rows JOIN keeps product.version_id and product.collection: a same-id
  // product FOLDED elsewhere says nothing of this scope's, still listed.
  it.each(SCOPES)('sweep keeps a source whose product is listed here, although a same-id product is folded in %s', async (_label, other) => {
    await retire('s1')
    await fold('P1', [{ documentId: 's1', forwardedHeads: null }])
    await chainIn(other)
    await expireAll()
    expect(await sweep()).toEqual({ rows: 0, records: 0 })
    expect(await status('s1')).toEqual({ status: 'folded', foldedInto: 'P1' })
    expect(await refusalOf('P1', ['s1'])).toBeNull()
  })

  // Under the limit the OLDEST expiry goes first, so a backlog drains in the
  // order it became sweepable.
  it('a bounded sweep takes the OLDEST expiry first', async () => {
    await chain()
    await age(['P1'])
    await pool!.query(
      `UPDATE read_model_ordinary_head_retirements SET retain_until = now() - CASE document_id
         WHEN 's1' THEN interval '1 second' WHEN 's2' THEN interval '2 days' END
       WHERE landscape_id = $1 AND version_id = $2 AND document_id IN ('s1', 's2')`, [WS.landscapeId, WS.versionId])
    expect(await sweep(1)).toEqual({ rows: 1, records: 0 })
    expect(await ids()).toEqual(['P1', 'P2', 's1', 's3'])
  })

  // A product's own row can go in the SAME sweep as its sources (P1 folded
  // into P2, P2 into P3, everything past retain_until: a writer that did not
  // run for longer than P1 -> P2 took). Its record then names no row, and a
  // records DELETE needing the product's row `folded` would keep it for ever.
  it('sweep leaves no record behind when a product\'s own row goes in the same sweep as its sources', async () => {
    await chain()
    await retire('s4')
    await fold('P3', [{ documentId: 'P2', forwardedHeads: null }, { documentId: 's4', forwardedHeads: null }])
    await expireAll()
    expect(await sweep()).toEqual({ rows: 4, records: 2 })
    expect(await ids()).toEqual(['P2', 'P3', 's4'])
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P1')).toBeUndefined()
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P2')).toBeUndefined()
    expect(await readOrdinaryChainFold(pool!, WS, 'object', 'P3')).toBeTruthy()
  })
})
