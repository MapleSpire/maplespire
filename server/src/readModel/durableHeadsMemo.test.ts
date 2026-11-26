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

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { DurableHeadsMemo, durableHeadsScopeSql, rowVersionSet, scopeOf, type ScopedRowVersion } from './durableHeadsMemo.js'
import { prepareDocumentWatermarkProofs } from './arrivalWatermark.js'
import { durableHeadsDecoder } from './durableHeadsDecoder.js'
import type { Queryable } from './types.js'

/** Two tables: `<database oid>:<tableoid>`, the shape the SQL produces. */
const ONE = '16384:16390'
const TWO = '16384:24577'
const v = (key: string, arrivalSeq: string | null, octets = 10, scope: string | null = ONE): ScopedRowVersion =>
  ({ key, arrivalSeq, octets, scope })
const a = v('doc/snapshot/a', '1'), b = v('doc/incremental/b', '2'), c = v('doc/incremental/c', '3')
const inTwo = (row: ScopedRowVersion): ScopedRowVersion => ({ ...row, scope: TWO })

afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => { await durableHeadsDecoder.close() })

describe('DurableHeadsMemo', () => {
  it('hits only on the exact set, in any order', () => {
    const memo = new DurableHeadsMemo()
    expect(memo.remember('doc', [a, b], ['h'])).toBe(true)
    expect(memo.lookup('doc', [b, a])).toEqual(['h'])
    expect(memo.hits).toBe(1)
  })

  it('a superset (an added row) misses and evicts the stale entry', () => {
    const memo = new DurableHeadsMemo()
    memo.remember('doc', [a, b], ['h'])
    expect(memo.lookup('doc', [a, b, c])).toBeUndefined()
    expect(memo.size).toBe(0)
    expect(memo.lookup('doc', [a, b])).toBeUndefined()
  })

  it('a superset whose extra row sorts LAST misses (probe P9)', () => {
    const memo = new DurableHeadsMemo()
    memo.remember('doc', [v('doc/incremental/a', '1', 1)], ['h'])
    expect(memo.lookup('doc', [v('doc/incremental/a', '1', 1), v('doc/snapshot/z', '2', 1)])).toBeUndefined()
  })

  it('a subset (a removed row) misses', () => {
    const memo = new DurableHeadsMemo()
    memo.remember('doc', [a, b], ['h'])
    expect(memo.lookup('doc', [a])).toBeUndefined()
  })

  it('the same key at another arrival_seq, or another length, misses', () => {
    const memo = new DurableHeadsMemo()
    memo.remember('doc', [a, b], ['h'])
    expect(memo.lookup('doc', [a, v(b.key, '9')])).toBeUndefined()
    memo.remember('doc', [a, b], ['h'])
    expect(memo.lookup('doc', [a, v(b.key, b.arrivalSeq, 11)])).toBeUndefined()
  })

  it('bigint sequences beyond 2^53 stay distinct (probe P6)', () => {
    const memo = new DurableHeadsMemo()
    memo.remember('doc', [v('doc/snapshot/s', '9007199254740992', 1)], ['h'])
    expect(memo.lookup('doc', [v('doc/snapshot/s', '9007199254740993', 1)])).toBeUndefined()
  })

  it('a NULL arrival_seq is never remembered and never hits', () => {
    const memo = new DurableHeadsMemo()
    expect(rowVersionSet([a, v('doc/incremental/n', null)])).toBeNull()
    expect(memo.remember('doc', [a, v('doc/incremental/n', null)], ['h'])).toBe(false)
    expect(memo.size).toBe(0)
    memo.remember('doc', [a], ['h'])
    expect(memo.lookup('doc', [v(a.key, null, a.octets)])).toBeUndefined()
  })

  it('is per document: another document with the same rows misses', () => {
    const memo = new DurableHeadsMemo()
    memo.remember('doc', [a, b], ['h'])
    expect(memo.lookup('other', [a, b])).toBeUndefined()
    expect(memo.lookup('doc', [a, b])).toEqual(['h'])
  })

  it('is bounded by documents and by remembered row versions, least recently used first', () => {
    const memo = new DurableHeadsMemo(2, 5)
    memo.remember('d1', [a], ['1'])
    memo.remember('d2', [a], ['2'])
    expect(memo.lookup('d1', [a])).toEqual(['1'])
    memo.remember('d3', [a], ['3'])
    expect(memo.size).toBe(2)
    expect(memo.lookup('d2', [a])).toBeUndefined()
    const many = new DurableHeadsMemo(100, 4)
    many.remember('x', [a, b, c], ['x'])
    many.remember('y', [a, b], ['y'])
    expect(many.size).toBe(1)
    expect(many.lookup('y', [a, b])).toEqual(['y'])
    expect(many.remember('z', [a, b, c, v('doc/incremental/d', '4'), v('doc/incremental/e', '5')], ['z'])).toBe(false)
  })

  it('the production default caps hold (probe P5): 10 000 entries, 200 000 row versions', () => {
    const memo = new DurableHeadsMemo()
    for (let i = 0; i < 10_001; i++) memo.remember(`d${i}`, [v(`d${i}/snapshot/s`, '1', 1)], ['h'])
    expect(memo.size).toBe(10_000)
    expect(memo.lookup('d0', [v('d0/snapshot/s', '1', 1)])).toBeUndefined()
    expect(memo.lookup('d10000', [v('d10000/snapshot/s', '1', 1)])).toEqual(['h'])
    const rows = Array.from({ length: 200_001 }, (_, i) => v(`big/incremental/${i}`, String(i), 1))
    expect(new DurableHeadsMemo().remember('big', rows, ['h'])).toBe(false)
    expect(new DurableHeadsMemo().remember('big', rows.slice(1), ['h'])).toBe(true)
  })
})

describe('DurableHeadsMemo scope (the table the rows were read from)', () => {
  it('the same document and row versions from ANOTHER table miss, and leave the first table\'s entry alone', () => {
    const memo = new DurableHeadsMemo()
    memo.remember('doc', [a, b], ['from-one'])
    expect(memo.lookup('doc', [inTwo(a), inTwo(b)])).toBeUndefined()
    expect(memo.misses).toBe(1)
    expect(memo.lookup('doc', [a, b])).toEqual(['from-one'])
  })

  it('two tables keep one entry each for the same document', () => {
    const memo = new DurableHeadsMemo()
    memo.remember('doc', [a, b], ['from-one'])
    memo.remember('doc', [inTwo(a), inTwo(b)], ['from-two'])
    expect(memo.size).toBe(2)
    expect(memo.lookup('doc', [inTwo(b), inTwo(a)])).toEqual(['from-two'])
    expect(memo.lookup('doc', [b, a])).toEqual(['from-one'])
    // A new decode in one table replaces only that table's entry.
    memo.remember('doc', [inTwo(a)], ['two-again'])
    expect(memo.size).toBe(2)
    expect(memo.lookup('doc', [a, b])).toEqual(['from-one'])
    expect(memo.lookup('doc', [inTwo(a)])).toEqual(['two-again'])
  })

  it('a set whose rows disagree on the table, or one without a valid scope, is never remembered and never hits', () => {
    const memo = new DurableHeadsMemo()
    expect(scopeOf([a, inTwo(b)])).toBeNull()
    expect(memo.remember('doc', [a, inTwo(b)], ['h'])).toBe(false)
    for (const scope of [null, '', 'doc', '16384', '16384:16390 x', ' 16384:16390']) {
      expect(memo.remember('doc', [v(a.key, '1', 10, scope)], ['h'])).toBe(false)
    }
    // A scope-less row versions object (a caller that forgot to select it).
    expect(memo.remember('doc', [{ key: a.key, arrivalSeq: '1', octets: 10 } as ScopedRowVersion], ['h'])).toBe(false)
    expect(memo.size).toBe(0)
    memo.remember('doc', [a, b], ['h'])
    expect(memo.lookup('doc', [a, v(b.key, b.arrivalSeq, b.octets, null)])).toBeUndefined()
    expect(memo.lookup('doc', [a, inTwo(b)])).toBeUndefined()
    expect(memo.lookup('doc', [{ key: a.key, arrivalSeq: a.arrivalSeq, octets: a.octets } as ScopedRowVersion,
      { key: b.key, arrivalSeq: b.arrivalSeq, octets: b.octets } as ScopedRowVersion])).toBeUndefined()
  })

  it('forget drops the document under every scope, and only that document', () => {
    const memo = new DurableHeadsMemo()
    memo.remember('doc', [a], ['1'])
    memo.remember('doc', [inTwo(a)], ['2'])
    memo.remember('other', [v('other/snapshot/s', '1')], ['3'])
    memo.forget('doc')
    expect(memo.size).toBe(1)
    expect(memo.lookup('doc', [a])).toBeUndefined()
    expect(memo.lookup('doc', [inTwo(a)])).toBeUndefined()
    expect(memo.lookup('other', [v('other/snapshot/s', '1')])).toEqual(['3'])
    // A remember without a table to name drops the document everywhere too.
    memo.remember('other', [inTwo(v('other/snapshot/s', '1'))], ['4'])
    memo.remember('other', [v('other/snapshot/s', '1', 10, null)], ['5'])
    expect(memo.size).toBe(0)
  })

  it('the caps are ONE budget across every scope', () => {
    const memo = new DurableHeadsMemo(3, 100)
    for (let table = 0; table < 5; table++) memo.remember('doc', [v('doc/snapshot/s', '1', 1, `1:${table}`)], [String(table)])
    expect(memo.size).toBe(3)
    expect(memo.lookup('doc', [v('doc/snapshot/s', '1', 1, '1:0')])).toBeUndefined()
    expect(memo.lookup('doc', [v('doc/snapshot/s', '1', 1, '1:4')])).toEqual(['4'])
    const rows = new DurableHeadsMemo(100, 4)
    rows.remember('x', [v('x/snapshot/s', '1', 1, '1:1'), v('x/incremental/i', '2', 1, '1:1')], ['x'])
    rows.remember('x', [v('x/snapshot/s', '1', 1, '1:2'), v('x/incremental/i', '2', 1, '1:2')], ['y'])
    rows.remember('x', [v('x/snapshot/s', '1', 1, '1:3')], ['z'])
    expect(rows.size).toBe(2)
    expect(rows.lookup('x', [v('x/snapshot/s', '1', 1, '1:1'), v('x/incremental/i', '2', 1, '1:1')])).toBeUndefined()
    // The bookkeeping survives eviction and forget: clear leaves nothing.
    rows.forget('x')
    expect(rows.size).toBe(0)
    expect(rows.remember('x', [1, 2, 3, 4].map(seq => v(`x/incremental/${seq}`, String(seq), 1, '1:9')), ['w'])).toBe(true)
    expect(rows.size).toBe(1)
  })

  it('the scope SQL names the database and the row\'s own table, never the database alone', () => {
    const sql = durableHeadsScopeSql('storage')
    expect(sql).toContain('storage.tableoid')
    expect(sql).toContain('current_database()')
  })
})

describe('prepareDocumentWatermarkProofs with a memo', () => {
  function revisions() {
    const h0 = A.from({ n: 0 })
    const h1 = A.change(A.clone(h0), doc => { doc.n = 1 })
    return { snapshot: A.save(h0), increment: A.saveSince(h1, A.getHeads(h0)), heads1: A.getHeads(h1) }
  }
  type Meta = { document_id: string; key: string; arrival_seq: string | null; octets: number; durable_scope: string | null }
  type Data = { document_id: string; key: string; arrival_seq: string | null; durable_scope: string | null; data: Uint8Array }
  function database(meta: Meta[], data: Data[]) {
    const statements: string[] = []
    const query = async (sql: string) => {
      statements.push(sql)
      if (sql.includes('nextval')) return { rows: [{ w: '100' }] }
      if (sql.includes('octet_length')) return { rows: meta }
      return { rows: data }
    }
    return { db: { query } as unknown as Queryable, statements }
  }
  const target = (documentId: string) => ({ documentId, drainPendingSaves: async () => {} })
  function rowsIn(scope: string) {
    const f = revisions()
    const rows: Data[] = [
      { document_id: 'a', key: 'a/snapshot/s', arrival_seq: '1', durable_scope: scope, data: f.snapshot },
      { document_id: 'a', key: 'a/incremental/i', arrival_seq: '2', durable_scope: scope, data: f.increment },
    ]
    const meta: Meta[] = rows.map(({ data, ...row }) => ({ ...row, octets: data.byteLength }))
    return { f, rows, meta }
  }

  it('a hit skips the data read and the decoder; a miss reads, decodes and remembers', async () => {
    const { f, rows, meta } = rowsIn(ONE)
    const memo = new DurableHeadsMemo()
    const decode = vi.spyOn(durableHeadsDecoder, 'decode')
    const miss = database(meta, rows)
    expect((await prepareDocumentWatermarkProofs(miss.db, [target('a')], memo)).durableHeadsById.get('a')).toEqual(f.heads1)
    expect(miss.statements).toHaveLength(3)
    expect(decode).toHaveBeenCalledTimes(1)
    expect(memo.size).toBe(1)
    const hit = database(meta, rows)
    expect((await prepareDocumentWatermarkProofs(hit.db, [target('a')], memo)).durableHeadsById.get('a')).toEqual(f.heads1)
    expect(hit.statements).toHaveLength(2)
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('both statements select the scope of the row they read', async () => {
    const { rows, meta } = rowsIn(ONE)
    const { db, statements } = database(meta, rows)
    await prepareDocumentWatermarkProofs(db, [target('a')], new DurableHeadsMemo())
    const reads = statements.filter(sql => sql.includes('automerge_storage'))
    expect(reads).toHaveLength(2)
    for (const sql of reads) expect(sql).toContain(`${durableHeadsScopeSql('storage')} AS durable_scope`)
  })

  it('the same row versions read from ANOTHER table decode again (unit form of probe P8)', async () => {
    const one = rowsIn(ONE)
    const memo = new DurableHeadsMemo()
    memo.remember('a', one.meta.map(row => ({ key: row.key, arrivalSeq: row.arrival_seq, octets: row.octets, scope: ONE })), ['not-these-heads'])
    const two = rowsIn(TWO)
    const decode = vi.spyOn(durableHeadsDecoder, 'decode')
    const prepared = await prepareDocumentWatermarkProofs(database(two.meta, two.rows).db, [target('a')], memo)
    expect(prepared.durableHeadsById.get('a')).toEqual(two.f.heads1)
    expect(decode).toHaveBeenCalledTimes(1)
    expect(memo.size).toBe(2)
  })

  it('a document with no content rows stays absent and is forgotten', async () => {
    const memo = new DurableHeadsMemo()
    memo.remember('a', [v('a/snapshot/s', '1')], ['h'])
    const { db } = database([], [])
    const prepared = await prepareDocumentWatermarkProofs(db, [target('a')], memo)
    expect(prepared.durableHeadsById.has('a')).toBe(false)
    expect(memo.size).toBe(0)
  })
})

describe('DurableHeadsMemo bookkeeping', () => {
  const versionsOf = (scope: string, seq = '1'): ScopedRowVersion[] => [{ key: 'd/snapshot/a', arrivalSeq: seq, octets: 3, scope }]
  const internal = (memo: DurableHeadsMemo) =>
    memo as unknown as { keysByDocument: Map<string, Set<string>>; entries: Map<string, unknown> }

  it('releases the per-document key index with its last entry (eviction, a stale lookup, forget)', () => {
    const memo = new DurableHeadsMemo(2, 100)
    memo.remember('d', versionsOf('1:1'), ['h'])
    memo.remember('e', versionsOf('1:1'), ['h'])
    // Evicted by the document cap.
    memo.remember('f', versionsOf('1:1'), ['h'])
    expect(internal(memo).entries.size).toBe(2)
    expect(internal(memo).keysByDocument.has('d')).toBe(false)
    // A stale lookup drops its entry.
    expect(memo.lookup('e', versionsOf('1:1', '2'))).toBeUndefined()
    expect(internal(memo).keysByDocument.has('e')).toBe(false)
    memo.forget('f')
    expect(internal(memo).keysByDocument.size).toBe(0)
    expect(internal(memo).entries.size).toBe(0)
  })
})
