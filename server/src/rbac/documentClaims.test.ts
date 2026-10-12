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
 * The batch claim core, against a capturing fake.
 *
 * Every assertion here pins a discipline documented on `claimWorkspaceDocuments`
 * (documentClaims.ts): sorted batches (anti-40P01), landscape/version
 * derived from the `versions` row (anti-spoof), two statements never a CTE
 * (READ COMMITTED snapshot trap), losers matched by value. The DB-gated twin
 * (`documentClaims.integration.test.ts`) pins the two Postgres guarantees the
 * fake can only imitate.
 */

import { describe, it, expect } from 'vitest'
import { claimWorkspaceDocuments, CLAIM_BATCH_SIZE } from './documentClaims.js'
import type { Queryable } from '../readModel/types.js'

const KEY = { landscapeId: 'L1', versionId: 'V1' }

interface Captured {
  sql: string
  params: unknown[]
}

/** In-memory claims table + versions row, capturing every statement. The
 * INSERT emulation derives from the versions "row" exactly like Postgres: no
 * versions row → zero inserts, whatever the caller passed as literals. */
function fakeDb(opts: {
  versionsRows?: { landscapeId: string; versionId: string }[]
  owned?: Map<string, { landscape: string; version: string }>
} = {}) {
  const versionsRows = opts.versionsRows ?? [KEY].map((k) => ({ landscapeId: k.landscapeId, versionId: k.versionId }))
  const owned = opts.owned ?? new Map<string, { landscape: string; version: string }>()
  const captured: Captured[] = []
  const db: Queryable = {
    query: async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      captured.push({ sql, params })
      if (sql.trim().startsWith('INSERT')) {
        const ids = params[0] as string[]
        const landscape = String(params[1])
        const version = String(params[2])
        // The fake emulates what the STATEMENT says, not what the module is
        // supposed to mean: only a `JOIN versions` derivation gates on the
        // versions row. An implementation using `VALUES($2,$3)` therefore
        // "inserts" here even with no versions row — which is exactly what it
        // would do in Postgres — and the missingVersion assertion catches it.
        const derivesFromVersions = /JOIN\s+versions/i.test(sql)
        const versionExists = versionsRows.some((row) => row.landscapeId === landscape && row.versionId === version)
        const rows: { document_id: string }[] = []
        if (!derivesFromVersions || versionExists) {
          for (const id of ids) {
            if (!owned.has(id)) {
              owned.set(id, { landscape, version })
              rows.push({ document_id: id })
            }
          }
        }
        return { rows: rows as unknown as R[], rowCount: rows.length }
      }
      if (sql.includes('FROM automerge_document_workspace')) {
        const ids = params[0] as string[]
        const rows = ids.filter((id) => owned.has(id)).map((id) => ({
          document_id: id,
          landscape_id: owned.get(id)!.landscape,
          version_id: owned.get(id)!.version,
        }))
        return { rows: rows as unknown as R[], rowCount: rows.length }
      }
      if (sql.includes('FROM versions')) {
        const landscape = String(params[0])
        const version = String(params[1])
        const present = versionsRows.some((row) => row.landscapeId === landscape && row.versionId === version)
        return { rows: (present ? [{ present: true }] : []) as unknown as R[], rowCount: present ? 1 : 0 }
      }
      throw new Error(`unexpected statement: ${sql}`)
    },
  }
  return { db, captured, owned }
}

describe('claimWorkspaceDocuments — the batch claim core', () => {
  it('sorts ids and slices batches of at most 1000', async () => {
    // 1,500 ids handed over in REVERSE order: the capture must show sorted
    // batches (the cross-batch 40P01 guard — unsorted, two concurrent claims
    // over overlapping sets interleave their index locks) sliced at the
    // constant, never one oversized statement.
    const ids = Array.from({ length: 1_500 }, (_v, i) => `doc-${String(i).padStart(5, '0')}`).reverse()
    const { db, captured } = fakeDb()

    const result = await claimWorkspaceDocuments(db, KEY, ids)

    const inserts = captured.filter((c) => c.sql.trim().startsWith('INSERT'))
    expect(inserts.map((c) => (c.params[0] as string[]).length)).toEqual([CLAIM_BATCH_SIZE, 500])
    for (const insert of inserts) {
      const batch = insert.params[0] as string[]
      expect([...batch].sort()).toEqual(batch)
    }
    // And across batches too: batch 2 starts strictly after batch 1 ends.
    const [first, second] = inserts.map((c) => c.params[0] as string[])
    expect(first[first.length - 1]! < second[0]!).toBe(true)
    expect(result.claimed).toHaveLength(1_500)
    expect(result.foreign).toEqual([])
    expect(result.missingVersion).toBe(false)
  })

  it('derives landscape/version from the versions row, never from caller literals', async () => {
    // No versions row for the caller's key: the JOIN matches nothing, ZERO
    // rows insert, and the result says WHY. An implementation inserting from
    // VALUES($2,$3) would "claim" anyway and report missingVersion=false.
    const { db, owned } = fakeDb({ versionsRows: [] })

    const result = await claimWorkspaceDocuments(db, KEY, ['doc-a', 'doc-b'])

    expect(owned.size).toBe(0)
    expect(result.claimed).toEqual([])
    expect(result.foreign).toEqual([])
    expect(result.missingVersion).toBe(true)
  })

  it('reports every foreign winner with its owning workspace', async () => {
    const owned = new Map([
      ['doc-f1', { landscape: 'L2', version: 'V2' }],
      ['doc-f2', { landscape: 'L3', version: 'V3' }],
      ['doc-mine', { landscape: 'L1', version: 'V1' }],
    ])
    const { db } = fakeDb({ owned })

    const result = await claimWorkspaceDocuments(db, KEY, ['doc-f2', 'doc-fresh', 'doc-f1', 'doc-mine'])

    expect(result.claimed).toEqual(['doc-fresh'])
    expect(result.alreadyOurs).toEqual(['doc-mine'])
    // Resolved by VALUE against the winner SELECT, each with its workspace —
    // an implementation that swallows losers (returns only the inserted set) reports
    // `foreign: []` and the caller covers a workspace with holes.
    expect(result.foreign).toEqual([
      { documentId: 'doc-f1', winner: { landscapeId: 'L2', versionId: 'V2' } },
      { documentId: 'doc-f2', winner: { landscapeId: 'L3', versionId: 'V3' } },
    ])
    expect(result.missingVersion).toBe(false)
  })

  it('issues two statements, never one CTE', async () => {
    // The READ COMMITTED trap: fused into one CTE, the
    // SELECT half shares the INSERT's snapshot and cannot see a winner row
    // committed after it — the loser reads as "in neither set". The contract
    // is TWO statements: conflict first, then a fresh-snapshot winner SELECT.
    const owned = new Map([['doc-loser', { landscape: 'L2', version: 'V2' }]])
    const { db, captured } = fakeDb({ owned })

    await claimWorkspaceDocuments(db, KEY, ['doc-loser', 'doc-fresh'])

    expect(captured).toHaveLength(2)
    expect(captured[0]!.sql.trim().startsWith('INSERT')).toBe(true)
    expect(captured[0]!.sql).not.toMatch(/WITH\s/i)
    expect(captured[1]!.sql.trim().startsWith('SELECT')).toBe(true)
    // The winner SELECT asks only about the losers — by value, not position.
    expect(captured[1]!.params[0]).toEqual(['doc-loser'])
  })

  it('a conflicted id whose winner vanished lands in no list and does not read as missingVersion', async () => {
    // claimed-then-GC'd between the two statements: the walk's next sight
    // re-claims it. The versions probe must answer "the row exists", so the
    // caller does not misread a GC race as a bootstrap ordering bug.
    let insertCall = 0
    const db: Queryable = {
      query: async <R extends Record<string, unknown>>(sql: string) => {
        if (sql.trim().startsWith('INSERT')) {
          insertCall += 1
          return { rows: [] as unknown as R[], rowCount: 0 } // conflicted
        }
        if (sql.includes('FROM automerge_document_workspace')) {
          return { rows: [] as unknown as R[], rowCount: 0 } // winner gone
        }
        return { rows: [{ present: true }] as unknown as R[], rowCount: 1 } // versions row exists
      },
    }

    const result = await claimWorkspaceDocuments(db, KEY, ['doc-vanished'])

    expect(insertCall).toBe(1)
    expect(result.claimed).toEqual([])
    expect(result.alreadyOurs).toEqual([])
    expect(result.foreign).toEqual([])
    expect(result.missingVersion).toBe(false)
  })

  it('dedupes intra-batch duplicates: no duplicate row in the INSERT, each id claimed once (U4)', async () => {
    // A batch assembled from several creator sites can carry the same id
    // twice. The module dedupes BEFORE batching: the INSERT never presents a
    // duplicate row to Postgres (DO NOTHING would tolerate it, but `claimed`
    // would double-report and the 21000 class is one DO UPDATE away), and the
    // result lists each id exactly once.
    const { db, captured } = fakeDb()

    const result = await claimWorkspaceDocuments(db, KEY, ['doc-a', 'doc-b', 'doc-a', 'doc-a'])

    const insert = captured.find((c) => c.sql.trim().startsWith('INSERT'))!
    const batch = insert.params[0] as string[]
    expect(new Set(batch).size).toBe(batch.length)
    expect(result.claimed).toEqual(['doc-a', 'doc-b'])
    expect(result.missingVersion).toBe(false)
  })

  it('an empty id list issues zero statements', async () => {
    const { db, captured } = fakeDb()
    const result = await claimWorkspaceDocuments(db, KEY, [])
    expect(captured).toEqual([])
    expect(result).toEqual({ claimed: [], alreadyOurs: [], foreign: [], missingVersion: false })
  })
})
