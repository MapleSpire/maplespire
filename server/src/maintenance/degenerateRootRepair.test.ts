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

import { Repo, generateAutomergeUrl, type AutomergeUrl } from '@automerge/automerge-repo'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildDegenerateRootRepairPlan,
  isStructurallyHealthyRoot,
  publishRotatedRoot,
  repairDegenerateRoots,
  type DegenerateRootAudit,
} from './degenerateRootRepair.js'
import { ROOT_SHAPE_FIELDS } from '../rootShape.js'

const url = (id: string) => `automerge:${id}` as AutomergeUrl

describe('degenerate root repair planning', () => {
  it('rejects empty roots and accepts a sparse root with a valid meta and registry', () => {
    expect(isStructurallyHealthyRoot({})).toBe(false)
    expect(isStructurallyHealthyRoot({ modelUrl: '', shardUrls: [] })).toBe(false)
    expect(isStructurallyHealthyRoot({
      modelUrl: '',
      modelMetaUrl: url('3Xb7FRNfh1SUKHLrgbJADtWN75zk'),
      shardUrls: [url('2dAXDzyxSuQwSs9Qe7dPT8C34Q3A')],
    })).toBe(true)
    expect(isStructurallyHealthyRoot({
      modelMetaUrl: url('3Xb7FRNfh1SUKHLrgbJADtWN75zk'),
      shardUrls: [url('2dAXDzyxSuQwSs9Qe7dPT8C34Q3A')],
      registrySummaryOnly: true,
    })).toBe(false)
  })

  it('reconstructs pointers only when the mapped graph is complete and unambiguous', () => {
    const root = url('TZmtdi8zC33kWVUGNMqhBXS3A1o')
    const model = url('2NfEPRV1awVEULnJRWDBSPaxZd4e')
    const meta = url('4PEGVNPywgd47har7UezSo36zco1')
    const registry = url('2SYiG2XrfrJcpXKAUHPmxomFJ4PW')
    const object = url('3MJ3jrPsz3KfL8HeBNRy6c5MNy8u')
    const diagram = url('3UdY6JLP7ptBZTTsZKYFJZwQzjVd')
    const plan = buildDegenerateRootRepairPlan(root, [
      { url: root, value: {} },
      { url: model, value: { objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} } },
      { url: meta, value: { objectShardUrls: [object], connectionShardUrls: [] } },
      { url: registry, value: { diagrams: { one: { docUrl: diagram } } } },
      { url: object, value: { objects: {} } },
      { url: diagram, value: { objectIds: [], connectionIds: [] } },
    ])
    expect(plan).toEqual({
      rootUrl: root,
      modelUrl: model,
      modelMetaUrl: meta,
      shardUrls: [registry],
      registryWriteUrl: null,
      issues: [],
    })
  })

  it('refuses ambiguous or incompletely mapped children', () => {
    const root = url('TZmtdi8zC33kWVUGNMqhBXS3A1o')
    const missing = url('342d6xQHAMipWsvAPCRrZKqEKnMh')
    const plan = buildDegenerateRootRepairPlan(root, [
      { url: root, value: {} },
      { url: url('4PEGVNPywgd47har7UezSo36zco1'), value: { objectShardUrls: [missing], connectionShardUrls: [] } },
      { url: url('2SYiG2XrfrJcpXKAUHPmxomFJ4PW'), value: { diagrams: {} } },
    ])
    expect(plan.issues).toEqual([
      'legacy-model-cardinality:0',
      'referenced-document-not-mapped:1',
    ])
  })

  it('uses durable manifest kinds to recover a sparse draft with empty control documents', () => {
    const root = url('3Gv8m8A7Ym5MCv71jGAXvfXZ47RC')
    const meta = url('3Xb7FRNfh1SUKHLrgbJADtWN75zk')
    const registry = url('2dAXDzyxSuQwSs9Qe7dPT8C34Q3A')
    const objectOverlay = url('3Bs9SNEVhXR7gSiaykp5Sz8db7fx')
    const plan = buildDegenerateRootRepairPlan(root, [
      { url: root, value: {}, kind: 'root' },
      { url: meta, value: { objectShardUrls: [objectOverlay], connectionShardUrls: [] }, kind: 'model-meta' },
      { url: registry, value: {}, kind: 'registry-shard' },
      { url: objectOverlay, value: {}, kind: 'object-overlay' },
    ], { allowMissingLegacyModel: true, registrySummaryOnly: true })

    expect(plan).toEqual({
      rootUrl: root,
      modelUrl: '',
      modelMetaUrl: meta,
      shardUrls: [registry],
      registryWriteUrl: registry,
      issues: [],
    })
  })

  it('refuses to guess between multiple non-empty summary registry write heads', () => {
    const root = url('3Gv8m8A7Ym5MCv71jGAXvfXZ47RC')
    const meta = url('3Xb7FRNfh1SUKHLrgbJADtWN75zk')
    const first = url('2dAXDzyxSuQwSs9Qe7dPT8C34Q3A')
    const second = url('4dAXDzyxSuQwSs9Qe7dPT8C34Q3B')
    const plan = buildDegenerateRootRepairPlan(root, [
      { url: root, value: {}, kind: 'root' },
      { url: meta, value: { objectShardUrls: [], connectionShardUrls: [] }, kind: 'model-meta' },
      { url: first, value: { diagrams: { one: {} } }, kind: 'registry-shard' },
      { url: second, value: { diagrams: { two: {} } }, kind: 'registry-shard' },
    ], { allowMissingLegacyModel: true, registrySummaryOnly: true })

    expect(plan.registryWriteUrl).toBeNull()
    expect(plan.issues).toContain('registry-write-head-cardinality:0')
  })

  it('plans a fresh root when the mapped root itself is unavailable but its graph is complete', async () => {
    const root = url('TZmtdi8zC33kWVUGNMqhBXS3A1o')
    const model = url('2NfEPRV1awVEULnJRWDBSPaxZd4e')
    const meta = url('4PEGVNPywgd47har7UezSo36zco1')
    const registry = url('2SYiG2XrfrJcpXKAUHPmxomFJ4PW')
    const object = url('3MJ3jrPsz3KfL8HeBNRy6c5MNy8u')
    const diagram = url('3UdY6JLP7ptBZTTsZKYFJZwQzjVd')
    const documents = new Map<AutomergeUrl, Record<string, unknown>>([
      [model, { objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} }],
      [meta, { objectShardUrls: [object], connectionShardUrls: [] }],
      [registry, { diagrams: { one: { docUrl: diagram } } }],
      [object, { objects: {} }],
      [diagram, { objectIds: [], connectionIds: [] }],
    ])
    let query = 0
    const db = {
      query: async () => {
        query += 1
        if (query === 1) return {
          rows: [{
            landscape_id: 'landscape', id: 'version', label: 'Main', root_url: root,
            parent_version_id: null, base_manifest: null, static_source: null,
            parent_diagram_count: 0,
          }],
          rowCount: 1,
        }
        return {
          rows: [root, model, meta, registry, object, diagram].map((documentUrl) => ({
            document_id: documentUrl.replace('automerge:', ''),
            kind: null,
          })),
          rowCount: 6,
        }
      },
    }
    const repo = {
      // Unavailability comes from `find`, which is where production produces it.
      // Never model it by throwing from `whenReady()`: that method returns a
      // forever promise for a non-ready handle and never rejects, so such a
      // fixture would test a failure mode the real repo cannot signal.
      find: async (documentUrl: AutomergeUrl) => {
        if (documentUrl === root) throw new Error(`Document ${documentUrl} is unavailable`)
        return { state: 'ready', doc: () => documents.get(documentUrl) }
      },
    }

    const result = await repairDegenerateRoots(db as never, repo as never)

    expect(result).toMatchObject({ reportOnly: true, safeToApply: true, repaired: 0 })
    expect(result.workspaces).toHaveLength(1)
    expect(result.workspaces[0]).toMatchObject({
      rootUrl: root,
      modelUrl: model,
      modelMetaUrl: meta,
      shardUrls: [registry],
      issues: [],
    })
  })
})

describe('publishRotatedRoot — summary contract fields (D2)', () => {
  const baseAudit = (over: Partial<DegenerateRootAudit>): DegenerateRootAudit => ({
    rootUrl: url('TZmtdi8zC33kWVUGNMqhBXS3A1o'),
    modelUrl: '',
    modelMetaUrl: url('3Xb7FRNfh1SUKHLrgbJADtWN75zk'),
    shardUrls: [url('2SYiG2XrfrJcpXKAUHPmxomFJ4PW'), url('2dAXDzyxSuQwSs9Qe7dPT8C34Q3A')],
    registryWriteUrl: url('2dAXDzyxSuQwSs9Qe7dPT8C34Q3A'),
    issues: [],
    landscapeId: 'land',
    versionId: 'v',
    label: 'Main',
    mappedDocuments: 4,
    ...over,
  })

  async function publishedRoot(repo: Repo, rootUrl: AutomergeUrl): Promise<Record<string, unknown>> {
    const handle = await repo.find(rootUrl)
    await handle.whenReady()
    return handle.doc() as Record<string, unknown>
  }

  it('rotation of a NON-sparse static root keeps the summary fields', async () => {
    // The guard must match the PLAN's (`static_source !== null`), not
    // `workspace.sparseDraft`: with the latter, a rotated performance/promoted
    // root loses `registrySummaryOnly` + `diagramCount` and silently falls back
    // to the ordinary contract — the hybrid the fsck `summary-static-coherence`
    // check reports as degraded.
    const repo = new Repo({ network: [] })
    const rotation = await publishRotatedRoot(repo, baseAudit({
      staticWorkspace: { diagramCount: 3000 },
    }))

    const root = await publishedRoot(repo, rotation.newRootUrl)
    expect(root.registrySummaryOnly, 'summary flag must survive the rotation').toBe(true)
    expect(root.diagramCount).toBe(3000)
    // Non-sparse rotation keeps its shard urls (only sparse drafts rotate
    // their control plane), so the write head is carried through unchanged.
    expect(root.registryWriteUrl).toBe(url('2dAXDzyxSuQwSs9Qe7dPT8C34Q3A'))
    // Summary without being anyone's draft: no base pointers appear.
    expect(root).not.toHaveProperty('sparseDraftBaseVersionId')
    expect(root).not.toHaveProperty('sparseDraftBaseRootUrl')
    // The published root is structurally healthy and inside the closed list.
    expect(isStructurallyHealthyRoot(root)).toBe(true)
    const foreign = Object.keys(root).filter((key) => !(ROOT_SHAPE_FIELDS as readonly string[]).includes(key))
    expect(foreign).toEqual([])
  })

  it('rotation of an ORDINARY root gains no summary field', async () => {
    const repo = new Repo({ network: [] })
    const rotation = await publishRotatedRoot(repo, baseAudit({
      modelUrl: url('2NfEPRV1awVEULnJRWDBSPaxZd4e'),
      registryWriteUrl: null,
    }))

    const root = await publishedRoot(repo, rotation.newRootUrl)
    expect(root).not.toHaveProperty('registrySummaryOnly')
    expect(root).not.toHaveProperty('diagramCount')
    expect(root).not.toHaveProperty('registryWriteUrl')
  })

  it('rotation of a sparse draft keeps flag, count AND base pointers, write head remapped to the fresh registry', async () => {
    const repo = new Repo({ network: [] })
    // The sparse branch materialises the control plane, so these must be real.
    const meta = repo.create<Record<string, unknown>>({ objectShardUrls: [], connectionShardUrls: [] })
    const registry = repo.create<Record<string, unknown>>({ diagrams: {} })
    await Promise.all([meta.whenReady(), registry.whenReady()])

    const rotation = await publishRotatedRoot(repo, baseAudit({
      modelMetaUrl: meta.url,
      shardUrls: [registry.url],
      registryWriteUrl: registry.url,
      staticWorkspace: { diagramCount: 88 },
      sparseDraft: { parentVersionId: 'parent-v', parentRootUrl: 'automerge:parent-root', diagramCount: 88 },
    }))

    const root = await publishedRoot(repo, rotation.newRootUrl)
    expect(root.registrySummaryOnly).toBe(true)
    expect(root.diagramCount).toBe(88)
    expect(root.sparseDraftBaseVersionId).toBe('parent-v')
    expect(root.sparseDraftBaseRootUrl).toBe('automerge:parent-root')
    // Sparse rotation isolates the control plane: the write head must point at
    // the FRESH registry, never the retired one.
    const rotatedShards = root.shardUrls as string[]
    expect(rotatedShards).toHaveLength(1)
    expect(rotatedShards[0]).not.toBe(registry.url)
    expect(root.registryWriteUrl).toBe(rotatedShards[0])
  })
})

describe('repairDegenerateRoots — apply mode plumbs the static row into the rotated root (D2)', () => {
  it('rotates a degenerate PERFORMANCE root back to a summary root with its own diagram count', async () => {
    const repo = new Repo({ network: [] })
    const model = repo.create<Record<string, unknown>>({
      objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    })
    const meta = repo.create<Record<string, unknown>>({ objectShardUrls: [], connectionShardUrls: [] })
    const registry = repo.create<Record<string, unknown>>({ diagrams: {} })
    await Promise.all([model.whenReady(), meta.whenReady(), registry.whenReady()])
    // The degenerate root itself is unavailable — a real find() rejection.
    const rootUrl = url('TZmtdi8zC33kWVUGNMqhBXS3A1o')

    const sql: string[] = []
    const db = {
      query: async (text: string) => {
        sql.push(text)
        if (text.includes('FROM versions')) {
          return {
            rows: [{
              landscape_id: 'landscape', id: 'version', label: 'Perf', root_url: rootUrl,
              parent_version_id: null, base_manifest: null,
              // The static row exists WITHOUT being a sparse draft — the D2
              // configuration. The count must come from the workspace's OWN
              // ro_diagrams, not the (empty) parent's.
              static_source: 'performance',
              parent_diagram_count: 0,
              own_diagram_count: 17,
            }],
            rowCount: 1,
          }
        }
        if (text.includes('WITH candidate')) {
          return {
            rows: [rootUrl, model.url, meta.url, registry.url].map((documentUrl) => ({
              document_id: documentUrl.replace('automerge:', ''),
              kind: documentUrl === rootUrl ? 'root'
                : documentUrl === meta.url ? 'model-meta'
                  : documentUrl === registry.url ? 'registry-shard' : null,
            })),
            rowCount: 4,
          }
        }
        // INSERTs, the versions CAS and the retirement DELETEs.
        return { rows: [], rowCount: 1 }
      },
      // A STUB LOCK, and it is a stub on purpose — this arm is about the
      // ROTATION PLAN and its whole database is a switch on SQL text, so a real
      // advisory lock has nothing here to exclude. It grants, witnesses itself
      // held and unlocks cleanly, which is the shape `withLifecycleApplyLock`
      // needs to get out of the way.
      //
      // The lock's own behaviour on this door is NOT tested here and must not
      // be read as tested: the live-Postgres arm at the bottom of this file
      // ("REFUSES a rotation while a neighbour holds the workspace key") drives
      // it against a real neighbour on a real connection.
      connect: async () => ({
        query: async (text: string) => {
          // RECORDED INTO THE SAME `sql` ARRAY as the pool's. The rotation's
          // statements moved onto the locked session, and an assertion looking
          // only at the pool's log would report "the CAS never ran" for a
          // rotation that ran perfectly — which is exactly how this arm first
          // went red.
          sql.push(text)
          if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true, pid: 1 }], rowCount: 1 }
          if (text.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true, pid: 1 }], rowCount: 1 }
          if (text.includes('pg_locks')) return { rows: [{ held: true }], rowCount: 1 }
          // The rotation's own SQL runs on the LOCKED SESSION, not the pool —
          // a durability fix, see the block comment at the critical section.
          // `rowCount: 1` because the `versions` CAS asserts exactly one row
          // and would otherwise throw "degenerate root CAS failed", which is
          // how this stub first went red when the statements moved.
          return { rows: [], rowCount: 1 }
        },
        release: () => undefined,
      }),
    }

    const result = await repairDegenerateRoots(db as never, repo as never, { apply: true })

    expect(result.safeToApply).toBe(true)
    expect(result.repaired).toBe(1)
    expect(result.workspaces[0].staticWorkspace).toEqual({ diagramCount: 17 })
    expect(result.workspaces[0].sparseDraft).toBeUndefined()

    const rotated = await repo.find(result.rotations[0].newRootUrl)
    await rotated.whenReady()
    const root = rotated.doc() as Record<string, unknown>
    expect(root.registrySummaryOnly).toBe(true)
    expect(root.diagramCount).toBe(17)
    expect(root.registryWriteUrl).toBe(registry.url)
    expect(isStructurallyHealthyRoot(root)).toBe(true)
    // The CAS on versions.root_url really ran.
    expect(sql.some((text) => text.includes('UPDATE versions SET root_url'))).toBe(true)
  })
})

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/**
 * S5b — the sparse rotation END TO END against live Postgres. The unit tests
 * above hand `staticWorkspace`/`sparseDraft` to publishRotatedRoot (or fake the
 * SQL), so none of them executes the REAL join + the sparse-draft diagramCount
 * choice (`parent_diagram_count` vs `own_diagram_count`) against the actual
 * schema. Here the `read_model_static_workspaces` row is written by the same
 * `markStaticReadModelWorkspace` createDraft uses, the counts come from real
 * `ro_diagrams` rows, and the discriminator is parent=3 vs own=1: the mutant
 * "diagramCount always = own" publishes 1 and falls.
 */
describe.skipIf(!TEST_DATABASE_URL)('repairDegenerateRoots — sparse-draft rotation end to end (live Postgres)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'degenerate_sparse_rotation')
    const { ensureReadModelSchema } = await import('../readModel/schema.js')
    await ensureReadModelSchema(db.pool)
    // Minimal shapes of the two non-read-model tables the repair touches (no
    // FKs — the suite owns every row it reads; real DDL in db.ts/docScope).
    await db.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      id TEXT NOT NULL, landscape_id TEXT NOT NULL, label TEXT NOT NULL,
      root_url TEXT NOT NULL, parent_version_id TEXT, base_manifest JSONB,
      kind TEXT NOT NULL DEFAULT 'version', status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY (landscape_id, id))`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
  })

  afterAll(async () => { await db?.teardown() })

  it('a REAL sparse-draft static row rotates to a root whose diagramCount is the PARENT\'s, not its own', async () => {
    const landscapeId = 'L-sparse-rotation'
    const parentVersionId = 'V-parent'
    const draftVersionId = 'V-draft'
    // network: [] on purpose — the degenerate draft root must FAIL to resolve
    // (a real find() rejection), not hang.
    const repo = new Repo({ network: [] })
    const meta = repo.create<Record<string, unknown>>({ objectShardUrls: [], connectionShardUrls: [] })
    const registry = repo.create<Record<string, unknown>>({ diagrams: {} })
    await Promise.all([meta.whenReady(), registry.whenReady()])
    const parentRootUrl = generateAutomergeUrl()
    const draftRootUrl = generateAutomergeUrl() // resolvable nowhere → degenerate
    const documentIdOf = (url: string) => url.replace(/^automerge:/, '')

    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)`,
      [parentVersionId, landscapeId, parentRootUrl],
    )
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url, parent_version_id, kind, base_manifest)
       VALUES ($1, $2, 'Sparse draft', $3, $4, 'draft', $5)`,
      [draftVersionId, landscapeId, draftRootUrl, parentVersionId, JSON.stringify({
        schema: 2, mode: 'sparse-static', createdAt: new Date().toISOString(),
        rootUrl: parentRootUrl, parentVersionId, diagramBases: {},
      })],
    )
    // The discriminator: the parent's read model carries 3 diagrams, the
    // draft's own carries 1. A sparse draft's baseline lives in the PARENT's
    // read model, so the rotated root must publish 3.
    for (const id of ['pd1', 'pd2', 'pd3']) {
      await db.pool.query(
        `INSERT INTO ro_diagrams (landscape_id, version_id, id, data) VALUES ($1, $2, $3, '{}'::jsonb)`,
        [landscapeId, parentVersionId, id],
      )
    }
    await db.pool.query(
      `INSERT INTO ro_diagrams (landscape_id, version_id, id, data) VALUES ($1, $2, 'own1', '{}'::jsonb)`,
      [landscapeId, draftVersionId],
    )
    // The REAL static row + allow-list, via the same writer createDraft uses.
    const { markStaticReadModelWorkspace } = await import('../readModel/staticWorkspace.js')
    await markStaticReadModelWorkspace(db.pool, { landscapeId, versionId: draftVersionId }, 'sparse-draft', [
      { documentId: documentIdOf(draftRootUrl), kind: 'root' },
      { documentId: documentIdOf(meta.url), kind: 'model-meta' },
      { documentId: documentIdOf(registry.url), kind: 'registry-shard' },
    ], parentVersionId)

    const result = await repairDegenerateRoots(db.pool, repo, {
      apply: true,
      workspace: { landscapeId, versionId: draftVersionId },
    })

    expect(result.safeToApply).toBe(true)
    expect(result.repaired).toBe(1)
    // The audit derived BOTH summaries from the live rows — parent count, twice.
    expect(result.workspaces[0].staticWorkspace).toEqual({ diagramCount: 3 })
    expect(result.workspaces[0].sparseDraft).toMatchObject({
      parentVersionId,
      parentRootUrl,
      diagramCount: 3,
    })

    const rotated = await repo.find(result.rotations[0].newRootUrl)
    await rotated.whenReady()
    const root = rotated.doc() as Record<string, unknown>
    expect(root.registrySummaryOnly).toBe(true)
    expect(root.diagramCount, 'a sparse draft publishes its PARENT\'s count').toBe(3)
    expect(root.sparseDraftBaseVersionId).toBe(parentVersionId)
    expect(root.sparseDraftBaseRootUrl).toBe(parentRootUrl)
    expect(isStructurallyHealthyRoot(root)).toBe(true)

    // The CAS really repointed the draft's versions row at the fresh root.
    const { rows } = await db.pool.query<{ root_url: string }>(
      `SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2`,
      [landscapeId, draftVersionId],
    )
    expect(rows[0].root_url).toBe(result.rotations[0].newRootUrl)
  })

  it('REFUSES a rotation while a neighbour holds the workspace key — the FIFTH door (T-34)', async () => {
    // `repairDegenerateRoots` is the ONLY writer of `versions.root_url`, and is
    // reached from an ordinary request: without the lock, a rotation landing
    // between the reference-integrity re-read and its writes reproduces the
    // harm that re-read exists to prevent. The lock costs nothing on the hot
    // path: the HEALTH CHECK returns before this function on every healthy
    // workspace.
    // The SAME fixture shape as the arm above, which is the one known to
    // produce a safe plan — a plain version reports `safeToApply: false` and
    // returns before the lock is ever asked for, a green arm about nothing.
    const landscapeId = 'L-degenerate-lock'
    const parentVersionId = 'parent'
    const versionId = 'draft'
    const repo = new Repo({ network: [] })
    const meta = repo.create<Record<string, unknown>>({ objectShardUrls: [], connectionShardUrls: [] })
    const registry = repo.create<Record<string, unknown>>({ diagrams: {} })
    await Promise.all([meta.whenReady(), registry.whenReady()])
    const parentRootUrl = generateAutomergeUrl()
    const degenerateRootUrl = generateAutomergeUrl() // resolvable nowhere
    const documentIdOf = (url: string) => url.replace(/^automerge:/, '')

    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)`,
      [parentVersionId, landscapeId, parentRootUrl],
    )
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url, parent_version_id, kind, base_manifest)
       VALUES ($1, $2, 'Sparse draft', $3, $4, 'draft', $5)`,
      [versionId, landscapeId, degenerateRootUrl, parentVersionId, JSON.stringify({
        schema: 2, mode: 'sparse-static', createdAt: '2026-01-01T00:00:00.000Z',
        rootUrl: parentRootUrl, parentVersionId, diagramBases: {},
      })],
    )
    await db.pool.query(
      `INSERT INTO ro_diagrams (landscape_id, version_id, id, data) VALUES ($1, $2, 'pd1', '{}'::jsonb)`,
      [landscapeId, parentVersionId],
    )
    const { markStaticReadModelWorkspace } = await import('../readModel/staticWorkspace.js')
    await markStaticReadModelWorkspace(db.pool, { landscapeId, versionId }, 'sparse-draft', [
      { documentId: documentIdOf(degenerateRootUrl), kind: 'root' },
      { documentId: documentIdOf(meta.url), kind: 'model-meta' },
      { documentId: documentIdOf(registry.url), kind: 'registry-shard' },
    ], parentVersionId)

    // A neighbouring lifecycle door, on its own session. The key text is
    // recomputed here rather than imported: it is the wire format of an
    // exclusion between processes, and a test that calls `lifecycleLockKey`
    // cannot notice `lifecycleLockKey` changing.
    const keyOf = (lid: string, vid: string): number => {
      const text = `promote-summary:${lid}:${vid}`
      let hash = 0x811c9dc5
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
      }
      return hash | 0
    }
    // A DRY RUN FIRST, so the audit's own handles are already resident and the
    // count below moves only for a PUBLICATION. Measured: without it the
    // baseline was 2 and the refused call left 3 — the extra handle is the
    // audit resolving the degenerate root, not a rotation.
    await repairDegenerateRoots(db.pool, repo, { workspace: { landscapeId, versionId } })
    const neighbour = await db.pool.connect()
    const documentsBeforeRefusal = Object.keys(repo.handles).length
    let refusedResult: Awaited<ReturnType<typeof repairDegenerateRoots>>
    try {
      const { rows } = await neighbour.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS locked', [0x5359, keyOf(landscapeId, versionId)],
      )
      // LIVENESS. Without it the refusal below could be a refusal for any other
      // reason and this arm would still be green.
      expect(rows[0].locked).toBe(true)
      refusedResult = await repairDegenerateRoots(db.pool, repo, {
        apply: true, workspace: { landscapeId, versionId },
      })
    } finally {
      await neighbour.query('SELECT pg_advisory_unlock($1, $2)', [0x5359, keyOf(landscapeId, versionId)])
      neighbour.release()
    }

    // THE LOCK COVERS THE PUBLICATION, not only the CAS. Asserting `root_url`
    // unchanged would hold even with `publishRotatedRoot` hoisted out of the
    // critical section; the documents would not: a refusal that had already
    // published a fresh root, ModelMeta and registries would leave CRDTs nothing
    // will ever point at. Counting resident documents pins that.
    expect(Object.keys(repo.handles).length).toBe(documentsBeforeRefusal)

    // The plan was FINE — this is a refusal, not an unsafe plan, and the two
    // send an operator to completely different places.
    expect(refusedResult.safeToApply).toBe(true)
    expect(refusedResult.refused).toEqual([{ landscapeId, versionId }])
    expect(refusedResult.rotations).toEqual([])
    expect(refusedResult.repaired).toBe(0)
    // Nothing was published: the column every other door samples is untouched.
    const stillDegenerate = await db.pool.query<{ root_url: string }>(
      `SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2`, [landscapeId, versionId],
    )
    expect(stillDegenerate.rows[0].root_url).toBe(degenerateRootUrl)

    // THE CONTROL, and it is the half that makes the refusal mean something:
    // the identical call on the identical fixture rotates once the key is free.
    const allowed = await repairDegenerateRoots(db.pool, repo, {
      apply: true, workspace: { landscapeId, versionId },
    })
    expect(allowed.refused).toEqual([])
    expect(allowed.repaired).toBe(1)
    const rotated = await db.pool.query<{ root_url: string }>(
      `SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2`, [landscapeId, versionId],
    )
    expect(rotated.rows[0].root_url).toBe(allowed.rotations[0].newRootUrl)
    expect(rotated.rows[0].root_url).not.toBe(degenerateRootUrl)
  })
})
