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

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { createEmptyRoot } from '../automergeServer.js'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { findReadyDocument } from '../automergeRepoCompat.js'
import {
  repairMissingDiagramDocuments,
  rebuiltDiagramDoc,
  documentIdsWithContent,
} from '../../scripts/repair-missing-diagram-documents.js'
import { openBootstrapScope } from '../bootstrapScope.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/**
 * The repair, against real Postgres and the real storage adapter, on the shape
 * it exists for: a registry meta whose `docUrl` names a document that holds
 * nothing but a 2-byte `sync-state` marker.
 *
 * The assertion that carries the weight is that the document the registry ends
 * up pointing at HAS CONTENT. That is what fails if the flush is skipped or
 * ordered after the pointer — i.e. it catches the repair committing the very
 * defect it repairs, which is the failure mode this whole class of bug is made
 * of (never publish a pointer before its target is durable).
 */
describe.skipIf(!TEST_DATABASE_URL)('repair missing diagram documents (live Postgres)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb
  let repo: Repo

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'repair_diagram_docs')
    await db.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      PRIMARY KEY (landscape_id, id))`)
    await db.pool.query(`CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    // network: [] — a missing document's find() never settles with an adapter
    // attached and no peer, and missing documents are the subject here.
    repo = new Repo({
      storage: new PostgresStorageAdapter({ db: db.pool }),
      network: [],
      saveDebounceRate: 0,
    })
  })

  afterAll(async () => { await db?.teardown() })

  const documentIdOf = (url: string) => url.replace(/^automerge:/, '').split('?')[0]

  const contentChunks = async (documentId: string): Promise<number> => {
    const { rows } = await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM automerge_storage
        WHERE split_part(key, '/', 1) = $1
          AND split_part(key, '/', 2) IN ('snapshot', 'incremental')`,
      [documentId],
    )
    return Number(rows[0].n)
  }

  /** A workspace with ONE diagram whose document was never durably written —
   * the live shape, reproduced through the real provisioning path. */
  async function provisionWithLostDiagram(landscapeId: string, versionId: string) {
    const { rootUrl } = await createEmptyRoot(repo, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-test' }, { kind: 'unfenced', reason: 'no-forker' }))
    await db.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, $2, $3)`,
      [landscapeId, versionId, rootUrl],
    )
    const root = await findReadyDocument<{ shardUrls?: string[] }>(repo, rootUrl as AutomergeUrl)
    const shardUrl = root.doc()!.shardUrls![0]
    const shard = await findReadyDocument<{ diagrams: Record<string, unknown> }>(
      repo, shardUrl as AutomergeUrl,
    )

    // A real DiagramDoc, created and flushed the way a healthy one is...
    const lost = repo.create<Record<string, unknown>>({
      name: 'VilleObservabilityFlow', type: 'container',
      objectIds: ['o1', 'o2', 'o3', 'o4'], connectionIds: ['c1', 'c2'], groupIds: ['g1'],
      layouts: { o1: { position: { x: 10, y: 20 }, size: { width: 100, height: 60 } } },
      comments: {}, flows: {}, checkpoints: [],
    })
    await repo.flush([lost.documentId])
    // Admitted, as in the real failure: the workspace walk mapped this document
    // long before its content went missing. The repair must LEAVE this row.
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ($1, $2, $3) ON CONFLICT (document_id) DO NOTHING`,
      [lost.documentId, landscapeId, versionId],
    )
    shard.change((doc) => {
      doc.diagrams.bvr26zd = {
        id: 'bvr26zd', name: 'VilleObservabilityFlow', type: 'container', docUrl: lost.url,
        objectIds: ['o1', 'o2', 'o3', 'o4'], connectionIds: ['c1', 'c2'], groupIds: ['g1'],
      }
    })
    await repo.flush([shard.documentId])

    // ...then reduced to exactly what production showed: content gone, one
    // 2-byte sync-state row left behind by a peer that merely TRIED to sync it.
    await db.pool.query(
      `DELETE FROM automerge_storage WHERE split_part(key, '/', 1) = $1`,
      [lost.documentId],
    )
    await db.pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, $2)`,
      [`${lost.documentId}/sync-state/aa38df3e-04d9-41c7-b770-7ecb97d15de5`, Buffer.from([0, 0])],
    )
    return { rootUrl, shardUrl, lostUrl: lost.url, lostId: lost.documentId }
  }

  it('rebuilds the diagram, and the registry ends up pointing at a DURABLE document', async () => {
    const key = { landscapeId: 'L-repair', versionId: 'V1' }
    const { rootUrl, shardUrl, lostUrl, lostId } = await provisionWithLostDiagram(
      key.landscapeId, key.versionId,
    )
    expect(await contentChunks(lostId), 'precondition: the document is empty').toBe(0)

    const outcome = await repairMissingDiagramDocuments(
      db.pool, repo, { ...key, rootUrl }, { dryRun: false },
    )
    expect(outcome.repaired).toHaveLength(1)
    const rebuiltUrl = outcome.repaired[0].to
    expect(rebuiltUrl).not.toBe(lostUrl)

    // The pointer's target is durable.
    expect(await contentChunks(documentIdOf(rebuiltUrl))).toBeGreaterThan(0)

    // ORDER, read off `arrival_seq` — the monotonic sequence the storage table
    // stamps on every row. The content the registry points at must have landed
    // BEFORE the registry row that names it, which is the invariant the whole
    // script exists to honour.
    //
    // Read what this does and does not prove. It fails loudly if a pointer is
    // published while its target has no content at all. It CANNOT by itself
    // prove the `await` ordering: the repo runs with `saveDebounceRate: 0`, so
    // `repo.create()` already persists, and deleting the explicit flush leaves
    // this suite green (verified by mutation — so no, the flush is not covered
    // by a test, it is covered by the ordering of the code and by this comment).
    // The flush earns its place as the only thing that makes the write AWAITED,
    // i.e. crash-safe, and that is not observable from the end state.
    const seq = await db.pool.query<{ key: string; arrival_seq: string }>(
      `SELECT key, arrival_seq FROM automerge_storage
        WHERE (split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) IN ('snapshot', 'incremental'))
           OR split_part(key, '/', 1) = $2
        ORDER BY arrival_seq`,
      [documentIdOf(rebuiltUrl), documentIdOf(shardUrl)],
    )
    const firstContent = seq.rows.find((r) => r.key.startsWith(documentIdOf(rebuiltUrl)))
    const lastShardWrite = [...seq.rows].reverse().find((r) => r.key.startsWith(documentIdOf(shardUrl)))
    expect(firstContent, 'the rebuilt document must have a content row').toBeDefined()
    expect(lastShardWrite, 'the registry shard must have been written').toBeDefined()
    expect(
      Number(firstContent!.arrival_seq),
      'the rebuilt content must land BEFORE the registry row that points at it',
    ).toBeLessThan(Number(lastShardWrite!.arrival_seq))

    // The registry actually moved.
    const shard = await findReadyDocument<{ diagrams: Record<string, { docUrl: string }> }>(
      repo, shardUrl as AutomergeUrl,
    )
    expect(shard.doc()!.diagrams.bvr26zd.docUrl).toBe(rebuiltUrl)

    // Admitted, or the sync gate would refuse the document the client now needs.
    const { rows } = await db.pool.query(
      `SELECT 1 FROM automerge_document_workspace WHERE document_id = $1`,
      [documentIdOf(rebuiltUrl)],
    )
    expect(rows).toHaveLength(1)

    // Composition restored from the meta; layouts honestly empty.
    const rebuilt = await findReadyDocument<Record<string, unknown>>(repo, rebuiltUrl as AutomergeUrl)
    expect(rebuilt.doc()!.objectIds).toEqual(['o1', 'o2', 'o3', 'o4'])
    expect(rebuilt.doc()!.connectionIds).toEqual(['c1', 'c2'])
    expect(rebuilt.doc()!.groupIds).toEqual(['g1'])
    expect(rebuilt.doc()!.layouts).toEqual({})

    // The superseded id keeps its admission on purpose: a browser copy that
    // returns later must still be able to land in storage.
    const superseded = await db.pool.query(
      `SELECT 1 FROM automerge_document_workspace WHERE document_id = $1`,
      [lostId],
    )
    expect(superseded.rows.length, 'the old id must NOT be de-admitted').toBe(1)
  })

  it('--dry-run reports the same plan and writes nothing', async () => {
    const key = { landscapeId: 'L-dry', versionId: 'V1' }
    const { rootUrl, shardUrl, lostUrl } = await provisionWithLostDiagram(
      key.landscapeId, key.versionId,
    )
    const before = await db.pool.query<{ n: string }>('SELECT count(*) AS n FROM automerge_storage')

    const outcome = await repairMissingDiagramDocuments(
      db.pool, repo, { ...key, rootUrl }, { dryRun: true },
    )
    expect(outcome.plan).toHaveLength(1)
    expect(outcome.plan[0].name).toBe('VilleObservabilityFlow')
    expect(outcome.repaired).toHaveLength(0)

    const after = await db.pool.query<{ n: string }>('SELECT count(*) AS n FROM automerge_storage')
    expect(after.rows[0].n, 'a dry run must not write a single row').toBe(before.rows[0].n)
    const shard = await findReadyDocument<{ diagrams: Record<string, { docUrl: string }> }>(
      repo, shardUrl as AutomergeUrl,
    )
    expect(shard.doc()!.diagrams.bvr26zd.docUrl).toBe(lostUrl)
  })

  it('leaves a healthy workspace alone', async () => {
    const landscapeId = 'L-healthy'
    const { rootUrl } = await createEmptyRoot(repo, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-test' }, { kind: 'unfenced', reason: 'no-forker' }))
    await db.pool.query(
      `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1, 'V1', $2)`,
      [landscapeId, rootUrl],
    )
    const outcome = await repairMissingDiagramDocuments(
      db.pool, repo, { landscapeId, versionId: 'V1', rootUrl }, { dryRun: false },
    )
    expect(outcome.repaired).toHaveLength(0)
    expect(outcome.plan).toHaveLength(0)
  })

  it('a sync-state row is not content — the predicate the whole repair rests on', async () => {
    // Stated as its own test because every other assertion here is downstream
    // of it: if this predicate counted sync-state, the repair would find
    // nothing to do on exactly the workspaces that need it.
    const id = `probe${Date.now().toString(36)}`
    await db.pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, $2)`,
      [`${id}/sync-state/peer`, Buffer.from([0, 0])],
    )
    expect(await documentIdsWithContent((sql, params) => db.pool.query(sql, params), [id])).toEqual(new Set())

    await db.pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, $2)`,
      [`${id}/snapshot/abc`, Buffer.from([1, 2, 3])],
    )
    expect(await documentIdsWithContent((sql, params) => db.pool.query(sql, params), [id])).toEqual(new Set([id]))
  })
})

describe('rebuiltDiagramDoc', () => {
  it('never sets a key to undefined — Automerge rejects it', () => {
    const doc = rebuiltDiagramDoc({ name: 'X', type: 'context' })
    expect('parentObjectId' in doc).toBe(false)
    expect(doc.layouts).toEqual({})
    expect(doc.checkpoints).toEqual([])
  })

  it('keeps parentObjectId when the meta carries one', () => {
    expect(rebuiltDiagramDoc({ name: 'X', type: 'component', parentObjectId: 'o9' }).parentObjectId).toBe('o9')
  })

  it('falls back to a valid diagram type rather than trusting the meta', () => {
    expect(rebuiltDiagramDoc({ name: 'X', type: 'nonsense' }).type).toBe('context')
    expect(rebuiltDiagramDoc({ name: 'X', type: 'container' }).type).toBe('container')
  })
})
