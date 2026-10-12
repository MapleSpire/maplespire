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

import { describe, expect, it, vi } from 'vitest'
import {
  isStaticReadModelWorkspace,
  markStaticReadModelWorkspace,
  registerStaticReadModelDocuments,
  staticReadModelQueryWorkspace,
  staticReadModelQueryWorkspaceIfPresent,
} from './staticWorkspace.js'

const key = { landscapeId: 'landscape-a', versionId: 'version-a' }

describe('static read-model workspaces', () => {
  it('checks a workspace with both key dimensions', async () => {
    const query = vi.fn(async () => ({ rows: [{ present: true }] }))
    await expect(isStaticReadModelWorkspace({ query } as never, key)).resolves.toBe(true)
    expect(query).toHaveBeenCalledWith(expect.stringContaining('read_model_static_workspaces'), [
      key.landscapeId, key.versionId,
    ])
  })

  it('marks the materialized snapshot idempotently', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    await markStaticReadModelWorkspace({ query } as never, key)
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), [
      key.landscapeId, key.versionId, 'performance-seed', null,
    ])
  })

  // ── atomicity ─────────────────────────────────────────────────────────────
  //
  // Four statements, one of which DELETEs the whole allow-list before the next
  // re-inserts it. A reader that lands in between does not see stale data, it
  // sees a static workspace with NO admitted documents — and three separate
  // consumers act on that: `resolveDurable` returns null and the route gate
  // denies every document of the workspace, `isFencedDocument` answers "not
  // fenced" and lets a frozen baseline shard be written (then caches that for
  // `BASELINE_FENCE_TTL_MS`), and the storage enqueue CTEs select nothing so a
  // durable write is never projected. Some production callers run this on a
  // bare Pool.

  /** A Pool the way pg builds one: `connect` and no `release`. The client it
   * hands out has both, which is what a real `PoolClient` looks like and what
   * the shape predicate has to tell apart. */
  function fakePool(failOn?: RegExp) {
    const statements: string[] = []
    const query = vi.fn(async (sql: string) => {
      statements.push(String(sql).trim().split('\n')[0].trim())
      if (failOn?.test(String(sql))) throw new Error('statement failed')
      return { rows: [], rowCount: 0 }
    })
    const client = { query, release: vi.fn() }
    const poolQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    return { client, statements, poolQuery, pool: { query: poolQuery, connect: vi.fn(async () => client) } }
  }

  const shape = (statements: readonly string[]): string[] => statements.map((sql) => {
    if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) return sql
    if (sql.startsWith('SELECT 1 FROM read_model_static_workspaces')) return 'AUTHORITY'
    if (sql.includes('INSERT INTO read_model_static_workspaces')) return 'WORKSPACE'
    if (sql.includes('DELETE FROM read_model_static_documents')) return 'CLEAR'
    if (sql.includes('INSERT INTO read_model_static_documents')) return 'DOCUMENTS'
    if (sql.includes('INSERT INTO automerge_document_workspace')) return 'ASSIGNMENTS'
    return sql
  })

  it('wraps the whole publication in ONE transaction when handed a Pool', async () => {
    const { pool, client, statements, poolQuery } = fakePool()
    await markStaticReadModelWorkspace(pool as never, key, 'performance-seed', [
      { documentId: 'root-doc', kind: 'root' },
    ])
    // The order is asserted as a whole array, not by presence: the CLEAR must
    // sit inside the transaction with the DOCUMENTS that replace it, and a
    // COMMIT that drifted before them would pass a `toContain`.
    //
    // ASSIGNMENTS BEFORE the document rows is a LOCK ORDER, not a style. The
    // promotion's step 3 takes `automerge_document_workspace` first (its
    // write-head claim) and reaches `read_model_static_documents` through this
    // function; a static publish reaches both through
    // `registerStaticReadModelDocuments`. With the documents first, those two
    // transactions would take the pair in opposite orders — ABBA on a
    // re-promotion, where they genuinely overlap and share no mutex.
    expect(shape(statements)).toEqual(['BEGIN', 'WORKSPACE', 'ASSIGNMENTS', 'CLEAR', 'DOCUMENTS', 'COMMIT'])
    // On the CLIENT, never on the pool — statements issued on the pool are
    // outside the transaction and atomic with nothing.
    expect(poolQuery).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('rolls the whole publication back when one statement fails', async () => {
    // The property that matters: the allow-list DELETE does not survive a
    // failure of the INSERT that was going to replace it. Un-transacted, the
    // workspace is left static with an empty allow-list — permanently, because
    // nothing re-derives it.
    const { pool, statements, client } = fakePool(/INSERT INTO read_model_static_documents/)
    await expect(markStaticReadModelWorkspace(pool as never, key, 'performance-seed', [
      { documentId: 'root-doc', kind: 'root' },
    ])).rejects.toThrow('statement failed')
    expect(shape(statements)).toEqual(['BEGIN', 'WORKSPACE', 'ASSIGNMENTS', 'CLEAR', 'DOCUMENTS', 'ROLLBACK'])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('does NOT open a nested transaction on a caller-scoped handle', async () => {
    // The promotion runs this inside its own BEGIN, where the static row, the
    // allow-list and the write-head claim must commit together. A BEGIN here
    // would be a no-op warning at best and a scope error at worst, and a COMMIT
    // would publish the caller's half-finished transaction.
    const statements: string[] = []
    const query = vi.fn(async (sql: string) => {
      statements.push(String(sql).trim().split('\n')[0].trim())
      return { rows: [], rowCount: 0 }
    })
    await markStaticReadModelWorkspace({ query } as never, key, 'performance-seed', [
      { documentId: 'root-doc', kind: 'root' },
    ])
    expect(shape(statements)).toEqual(['WORKSPACE', 'ASSIGNMENTS', 'CLEAR', 'DOCUMENTS'])
  })

  it('registers rotated documents atomically too — the row and its route together', async () => {
    // An allow-list row without its `automerge_document_workspace` assignment
    // is a document `resolveDurable` cannot serve. Some callers run this on a
    // bare pool.
    const { pool, statements } = fakePool()
    await registerStaticReadModelDocuments(pool as never, key, [
      { documentId: 'overlay-1', kind: 'object-overlay' },
    ])
    // AUTHORITY first, then W, then D — the global lock order, and the first of
    // the three is what keeps it. `read_model_static_documents_workspace_fk`
    // makes the DOCUMENTS statement take key share on the workspace row through
    // an AFTER-ROW RI trigger, i.e. at END of statement once the allow-list rows
    // are already locked; without an explicit lock up front this transaction
    // runs D → S and deadlocks against a demotion running S → D. Measured 18/18
    // deadlocks with a mixed batch, 0/18 with this statement.
    expect(shape(statements)).toEqual(['BEGIN', 'AUTHORITY', 'ASSIGNMENTS', 'DOCUMENTS', 'COMMIT'])
  })

  it('maps a sparse draft to its immutable parent query plane', async () => {
    const query = vi.fn(async () => ({ rows: [{ base_version_id: 'parent-v' }] }))
    await expect(staticReadModelQueryWorkspace({ query } as never, key)).resolves.toEqual({
      landscapeId: key.landscapeId,
      versionId: 'parent-v',
    })
  })

  it('returns the static query plane in the same lookup used for presence', async () => {
    const query = vi.fn(async () => ({ rows: [{ base_version_id: null }] }))
    const db = { query } as never
    await expect(staticReadModelQueryWorkspaceIfPresent(db, key)).resolves.toEqual(key)
    await expect(staticReadModelQueryWorkspaceIfPresent(db, key)).resolves.toEqual(key)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('does not negative-cache an ordinary workspace that may become static', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const db = { query } as never
    await expect(staticReadModelQueryWorkspaceIfPresent(db, key)).resolves.toBeUndefined()
    await expect(staticReadModelQueryWorkspaceIfPresent(db, key)).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('replaces the bounded Automerge boot allowlist', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    await markStaticReadModelWorkspace({ query } as never, key, 'performance-seed', [
      { documentId: 'root-doc', kind: 'root' },
      { documentId: 'meta-doc', kind: 'model-meta' },
    ])
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('jsonb_to_recordset'),
      [expect.stringContaining('root-doc'), key.landscapeId, key.versionId],
    )
    const ownershipCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO automerge_document_workspace'))
    expect(ownershipCall).toEqual([
      expect.stringContaining('JOIN versions version'),
      [expect.stringContaining('root-doc'), key.landscapeId, key.versionId],
    ])
  })

  it('durably assigns a lazy DiagramDoc before returning it to selective sync', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    await registerStaticReadModelDocuments({ query } as never, key, [
      { documentId: 'diagram-doc', kind: 'diagram', entityId: 'diagram-1' },
    ])

    // THREE statements, and the order is the lock order: the AUTHORITY row, then
    // the assignment, then the allow-list. What this test is named for is that
    // both writes land before the document is handed to selective sync; the
    // authority lock in front of them is what stops the allow-list INSERT's
    // end-of-statement RI check inverting the order into D → S and deadlocking
    // against a demotion. See `registerStaticReadModelDocumentsInTransaction`.
    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls[0][0]).toContain('FOR KEY SHARE')
    expect(query.mock.calls[0][0]).toContain('read_model_static_workspaces')
    expect(query.mock.calls[1]).toEqual([
      expect.stringContaining('INSERT INTO automerge_document_workspace'),
      [expect.stringContaining('diagram-doc'), key.landscapeId, key.versionId],
    ])
    expect(query.mock.calls[2][0]).toContain('read_model_static_documents')
  })
})
