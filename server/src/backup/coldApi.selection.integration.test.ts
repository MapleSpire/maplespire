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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo, type Chunk, type StorageAdapter, type StorageKey } from '@automerge/automerge-repo'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { rebuildReadModelDerivedStats } from '../readModel/derivedStats.js'
import { markStaticReadModelWorkspace } from '../readModel/staticWorkspace.js'
import { createTemporaryRestoreDatabase } from './backupRestore.js'
import { deriveColdApiExpectation, runColdApiChecks, type ColdApiExpectation } from './coldApi.js'
import { startColdServer, type ColdServerHandle } from './coldServer.js'

const TEST_DATABASE_URL = process.env.BACKUP_RESTORE_TEST_DATABASE_URL
const SERVER_ROOT = process.cwd()
const EVIDENCE = process.env.BACKUP_QA_EVIDENCE_DIRECTORY

// The fixture publishes its SQL identity only after every referenced document
// has been flushed. The tested server is a separate process with a fresh Repo.
class FixtureStorage implements StorageAdapter {
  constructor(private readonly pool: Pool) {}
  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const result = await this.pool.query<{ data: Buffer }>(
      'SELECT data FROM automerge_storage WHERE key = $1', [key.join('/')],
    )
    return result.rows[0]?.data
  }
  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    await this.pool.query(
      `INSERT INTO automerge_storage (key, data) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data`,
      [key.join('/'), Buffer.from(data)],
    )
  }
  async remove(key: StorageKey): Promise<void> {
    await this.pool.query('DELETE FROM automerge_storage WHERE key = $1', [key.join('/')])
  }
  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    const text = prefix.join('/')
    const result = await this.pool.query<{ key: string; data: Buffer }>(
      `SELECT key, data FROM automerge_storage WHERE key = $1 OR key LIKE $2 || '/%' ORDER BY key`,
      [text, text],
    )
    return result.rows.map((row) => ({ key: row.key.split('/'), data: row.data }))
  }
  async removeRange(prefix: StorageKey): Promise<void> {
    const text = prefix.join('/')
    await this.pool.query(`DELETE FROM automerge_storage WHERE key = $1 OR key LIKE $2 || '/%'`, [text, text])
  }
}

describe.skipIf(!TEST_DATABASE_URL)('cold API selection with physical projections and a real cold server', () => {
  let target: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let pool: Pool
  let assets: string
  let child: ColdServerHandle | undefined

  beforeAll(async () => {
    target = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    assets = await mkdtemp(join(tmpdir(), 'maplespire-cold-selection-'))
    child = await startColdServer({ databaseUrl: target.url, serverRoot: SERVER_ROOT, assetDirectory: assets, bootTimeoutMs: 180_000 })
    await child.stop()
    child = undefined
    pool = guardIdleClientErrors(new Pool({ connectionString: target.url, max: 2 }), 'coldApi-selection-fixture')
  }, 240_000)

  beforeEach(async () => {
    // This is a newly created, suite-owned database, never the URL supplied by
    // the caller. No child process remains while fixtures are replaced.
    expect(child).toBeUndefined()
    await pool.query(`TRUNCATE ro_objects, ro_connections, ro_diagrams,
      ro_connection_stats, ro_diagram_summaries, ro_workspace_stats,
      read_model_static_workspaces, landscapes, automerge_storage, automerge_meta CASCADE`)
  })
  afterEach(async () => {
    await child?.stop()
    child = undefined
  }, 30_000)
  afterAll(async () => {
    await child?.stop()
    await pool?.end()
    await target?.drop()
    if (assets) await rm(assets, { recursive: true, force: true })
  }, 120_000)

  async function identity(landscape: string, version: string, root = '', status = 'active', kind = 'version'): Promise<void> {
    await pool.query(`INSERT INTO landscapes (id, name, default_version_id) VALUES ($1, $1, $2) ON CONFLICT DO NOTHING`, [landscape, version])
    await pool.query(`INSERT INTO versions (id, landscape_id, label, root_url, status, kind) VALUES ($1, $2, $1, $3, $4, $5)`, [version, landscape, root, status, kind])
  }
  async function projection(landscape: string, version: string, count: number, prefix: string): Promise<void> {
    await pool.query(
      `INSERT INTO ro_objects (landscape_id, version_id, id, type, name, data)
       SELECT $1, $2, $4 || '-o' || g, 'system', $4 || '-o' || g,
         jsonb_build_object('id', $4 || '-o' || g, 'name', $4 || '-o' || g, 'type', 'system')
       FROM generate_series(1, $3::integer) AS g`, [landscape, version, count, prefix],
    )
    await pool.query(
      `INSERT INTO ro_connections (landscape_id, version_id, id, from_id, to_id, data)
       VALUES ($1, $2, $3, $4, $5, jsonb_build_object('id', $3::text, 'fromId', $4::text, 'toId', $5::text))`,
      [landscape, version, `${prefix}-c1`, `${prefix}-o1`, `${prefix}-o2`],
    )
    await pool.query(
      `INSERT INTO ro_diagrams (landscape_id, version_id, id, data) VALUES ($1, $2, $3, jsonb_build_object('id', $3::text, 'name', $3::text, 'type', 'context'))`,
      [landscape, version, `${prefix}-d1`],
    )
  }
  async function durableOrdinary(): Promise<string> {
    const repo = new Repo({ network: [], storage: new FixtureStorage(pool), saveDebounceRate: 0 })
    try {
      const diagram = repo.create({ layouts: {}, comments: {}, flows: {} })
      const objects = repo.create({ objects: {
        'good-o1': { id: 'good-o1', name: 'good-o1', type: 'system' },
        'good-o2': { id: 'good-o2', name: 'good-o2', type: 'system' },
        'good-o3': { id: 'good-o3', name: 'good-o3', type: 'system' },
      } })
      const connections = repo.create({ connections: { 'good-c1': { id: 'good-c1', fromId: 'good-o1', toId: 'good-o2' } } })
      const registry = repo.create({ diagrams: { 'good-d1': { id: 'good-d1', name: 'good-d1', type: 'context', docUrl: diagram.url } } })
      const meta = repo.create({ objectShardUrls: [objects.url], connectionShardUrls: [connections.url], groups: {} })
      const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
      const documents = [diagram, objects, connections, registry, meta, root]
      await Promise.all(documents.map((handle) => handle.whenReady()))
      await repo.flush(documents.map((handle) => handle.documentId))
      await identity('qa-good', 'qa-good-main', root.url)
      for (const document of documents) {
        await pool.query(`INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, 'qa-good', 'qa-good-main')`, [document.documentId])
      }
      await projection('qa-good', 'qa-good-main', 3, 'good')
      return root.url
    } finally {
      await repo.shutdown()
    }
  }
  async function snapshotExcluded(): Promise<unknown> {
    const result = await pool.query(`SELECT * FROM (SELECT 'object' AS kind, to_jsonb(o) AS row FROM ro_objects o WHERE landscape_id <> 'qa-good'
      UNION ALL SELECT 'connection', to_jsonb(c) FROM ro_connections c WHERE landscape_id <> 'qa-good'
      UNION ALL SELECT 'diagram', to_jsonb(d) FROM ro_diagrams d WHERE landscape_id <> 'qa-good'
      ) snapshot ORDER BY kind, row::text`)
    return result.rows
  }
  async function exercise(name: string, expectation: ColdApiExpectation | null, deadlineMs = 30_000) {
    const responses: Array<{ path: string; status: number; body: string }> = []
    let outcome: Awaited<ReturnType<typeof runColdApiChecks>> | undefined
    const startedAt = new Date().toISOString()
    try {
      child = await startColdServer({ databaseUrl: target.url, serverRoot: SERVER_ROOT, assetDirectory: assets, bootTimeoutMs: 180_000 })
      outcome = await runColdApiChecks({ baseUrl: child.baseUrl, expectation, deadlineMs,
        fetchImpl: async (url, init) => {
          const response = await fetch(url, init)
          const parsed = new URL(url)
          responses.push({ path: parsed.pathname + parsed.search, status: response.status, body: await response.clone().text() })
          return response
        },
      })
      return { outcome, responses }
    } finally {
      if (EVIDENCE) {
        await mkdir(EVIDENCE, { recursive: true })
        await writeFile(join(EVIDENCE, `${name}.json`), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(),
          sourceSha256: createHash('sha256').update(await readFile(join(SERVER_ROOT, 'src/backup/coldApi.ts'))).digest('hex'),
          entrypoint: child?.entrypoint, expectation, outcome, responses, serverOutput: child?.output(),
        }, null, 2) + '\n')
      }
    }
  }
  function expectRealPages(responses: Array<{ path: string; status: number; body: string }>, version: string, prefix: string): void {
    for (const path of ['/api/model/page-objects', '/api/model/connections/page', '/api/model/dependencies/page', '/api/model/diagrams/page']) {
      const hits = responses.filter((response) => response.path.startsWith(`${path}?`) && response.status === 200)
      expect(hits, `${path} must have been requested successfully`).toHaveLength(1)
      expect(new URL(hits[0]!.path, 'http://fixture.invalid').searchParams.get('versionId')).toBe(version)
      const body = hits[0]!.body
      if (path.endsWith('page-objects')) expect(JSON.parse(body).objects.map((object: { id: string }) => object.id)).toContain(`${prefix}-o1`)
      else if (path.includes('connections')) expect(body).toContain(`${prefix}-c1`)
      else if (path.includes('dependencies')) expect(body).toContain(`${prefix}-o2`)
      else expect(body).toContain(`${prefix}-d1`)
    }
  }

  it('cold-loads a durable active workspace while preserving larger orphan, inactive and mismatched groups', async () => {
    await durableOrdinary()
    await projection('qa-deleted-land', 'qa-deleted-main', 17, 'orphan')
    await identity('qa-existing-land', 'qa-inactive-main', '', 'archived')
    await projection('qa-existing-land', 'qa-inactive-main', 19, 'inactive')
    await projection('qa-existing-land', 'qa-missing-version', 13, 'missing')
    await projection('qa-existing-land', 'qa-good-main', 23, 'wrong-pair')
    const before = await snapshotExcluded()
    const expectation = await deriveColdApiExpectation(pool)
    expect(expectation?.workspace).toMatchObject({ landscapeId: 'qa-good', versionId: 'qa-good-main', queryVersionId: 'qa-good-main', objects: 3, connections: 1, diagrams: 1, dependencyFocusId: 'good-o1' })
    expect(expectation?.selection).toMatchObject({ projectionGroups: 5, projectionObjects: 75, eligibleProjectionGroups: 1, eligibleProjectionObjects: 3, candidateWorkspaces: 1, excludedProjectionGroups: 4, excludedProjectionObjects: 72, exclusionsTruncated: false })
    expect(expectation!.selection.excluded.map((row) => [row.versionId, row.reason])).toEqual([
      ['qa-good-main', 'missing_version'], ['qa-inactive-main', 'inactive_version'],
      ['qa-deleted-main', 'missing_landscape'], ['qa-missing-version', 'missing_version'],
    ])
    const { outcome, responses } = await exercise('ordinary-with-exclusions', expectation)
    expect(outcome.outcome).toBe('passed')
    expect(outcome.checks).toHaveLength(7)
    expect(outcome.checks.every((check) => check.ok)).toBe(true)
    expect(outcome.selection).toEqual(expectation!.selection)
    expectRealPages(responses, 'qa-good-main', 'good')
    expect(await snapshotExcluded()).toEqual(before)
  }, 240_000)

  it('keeps a broken active workspace eligible and reports four red APIs beside green health', async () => {
    await durableOrdinary()
    await identity('qa-broken', 'qa-broken-main')
    await projection('qa-broken', 'qa-broken-main', 7, 'broken')
    const expectation = await deriveColdApiExpectation(pool)
    expect(expectation?.workspace).toMatchObject({ versionId: 'qa-broken-main', objects: 7, dependencyFocusId: 'broken-o1' })
    const { outcome, responses } = await exercise('broken-active', expectation, 8_000)
    const byName = new Map(outcome.checks.map((check) => [check.name, check]))
    expect(byName.get('health')?.ok).toBe(true)
    expect(byName.get('ready')?.ok).toBe(true)
    expect(outcome.outcome).toBe('failed')
    for (const name of ['model-objects', 'model-connections', 'dependencies', 'diagram-list']) {
      expect(byName.get(name)?.ok).toBe(false)
      expect(byName.get(name)?.detail).toContain('"reason":"workspace_root_unresolved"')
    }
    expect(new Set(responses.filter((r) => r.status === 503 && r.path.startsWith('/api/model/')).map((r) => r.path.split('?')[0])).size).toBe(4)
  }, 240_000)

  it('reads a distinct inactive static baseline through an active nondefault draft with one-hop routing', async () => {
    const root = await durableOrdinary()
    await identity('qa-static', 'qa-static-base', '', 'archived')
    await identity('qa-static', 'qa-static-a', root, 'active', 'draft')
    await identity('qa-static', 'qa-static-z', root, 'active', 'draft')
    await identity('qa-static', 'qa-static-decoy', '', 'discarded')
    await projection('qa-static', 'qa-static-base', 5, 'base')
    await projection('qa-static', 'qa-static-a', 2, 'own')
    await projection('qa-static', 'qa-static-decoy', 29, 'decoy')
    // Static projections include the derived stats/list tables: no ordinary
    // projector attaches to populate them when a sparse draft reads this base.
    await rebuildReadModelDerivedStats(pool, { landscapeId: 'qa-static', versionId: 'qa-static-base' }, null)
    for (const versionId of ['qa-static-a', 'qa-static-z']) {
      await markStaticReadModelWorkspace(pool, { landscapeId: 'qa-static', versionId }, 'cold-selection-fixture', [], 'qa-static-base')
    }
    // A second mapping on the physical baseline must not be followed: HTTP
    // resolves one hop, and the busiest decoy remains ineligible.
    await markStaticReadModelWorkspace(pool, { landscapeId: 'qa-static', versionId: 'qa-static-base' }, 'cold-selection-fixture', [], 'qa-static-decoy')
    const before = await snapshotExcluded()
    const expectation = await deriveColdApiExpectation(pool)
    expect(expectation?.workspace).toMatchObject({ landscapeId: 'qa-static', versionId: 'qa-static-a', queryVersionId: 'qa-static-base', objects: 5, connections: 1, diagrams: 1, dependencyFocusId: 'base-o1' })
    expect(expectation?.selection).toMatchObject({ projectionGroups: 4, projectionObjects: 39, eligibleProjectionGroups: 2, eligibleProjectionObjects: 8, candidateWorkspaces: 3, excludedProjectionGroups: 2, excludedProjectionObjects: 31 })
    expect(expectation!.selection.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ versionId: 'qa-static-a', reason: 'redirected_projection' })]))
    const { outcome, responses } = await exercise('static-one-hop', expectation)
    expect(outcome.outcome).toBe('passed')
    expectRealPages(responses, 'qa-static-a', 'base')
    expect(await snapshotExcluded()).toEqual(before)
  }, 240_000)

  it('audits all excluded groups and fails instead of passing or skipping on healthy infrastructure', async () => {
    await projection('qa-deleted-land', 'qa-deleted-main', 17, 'orphan')
    await identity('qa-inactive', 'qa-inactive-main', '', 'merged')
    await projection('qa-inactive', 'qa-inactive-main', 23, 'inactive')
    const expectation = await deriveColdApiExpectation(pool)
    expect(expectation?.workspace).toBeNull()
    expect(expectation?.selection).toMatchObject({ projectionGroups: 2, projectionObjects: 40, eligibleProjectionGroups: 0, candidateWorkspaces: 0, excludedProjectionGroups: 2, excludedProjectionObjects: 40, selected: null })
    const { outcome } = await exercise('all-excluded', expectation)
    expect(outcome.checks.filter((check) => ['health', 'ready'].includes(check.name)).every((check) => check.ok)).toBe(true)
    expect(outcome.outcome).toBe('failed')
    expect(outcome.selection).toEqual(expectation!.selection)
    expect(outcome.checks).toContainEqual(expect.objectContaining({ name: 'workspace', ok: false }))
  }, 240_000)

  it('keeps full exclusion totals when the detailed sample is capped', async () => {
    await pool.query(`INSERT INTO ro_objects (landscape_id, version_id, id, data)
      SELECT 'qa-orphan-' || g, 'qa-orphan-main-' || g, 'o', '{}'::jsonb FROM generate_series(1, 31) AS g`)
    const expectation = await deriveColdApiExpectation(pool)
    expect(expectation?.workspace).toBeNull()
    expect(expectation?.selection).toMatchObject({ projectionGroups: 31, projectionObjects: 31, excludedProjectionGroups: 31, excludedProjectionObjects: 31, exclusionsTruncated: true })
    expect(expectation!.selection.excluded).toHaveLength(25)
  })

  it('distinguishes an empty projection census from an unavailable table', async () => {
    const empty = await deriveColdApiExpectation(pool)
    expect(empty?.workspace).toBeNull()
    expect(empty?.selection).toMatchObject({ projectionGroups: 0, projectionObjects: 0, excludedProjectionGroups: 0 })
    await pool.query('ALTER TABLE ro_objects RENAME TO qa_absent_ro_objects')
    try {
      expect(await deriveColdApiExpectation(pool)).toBeNull()
    } finally {
      await pool.query('ALTER TABLE qa_absent_ro_objects RENAME TO ro_objects')
    }
  })

  it('orders active populations numerically and breaks equal counts by workspace identity', async () => {
    await identity('qa-eleven', 'qa-eleven-main')
    await identity('qa-nine', 'qa-nine-main')
    await projection('qa-eleven', 'qa-eleven-main', 11, 'eleven')
    await projection('qa-nine', 'qa-nine-main', 9, 'nine')
    expect((await deriveColdApiExpectation(pool))?.workspace).toMatchObject({ landscapeId: 'qa-eleven', objects: 11 })
    await identity('qa-aaa-tie', 'qa-tie-z')
    await identity('qa-aaa-tie', 'qa-tie-a')
    await projection('qa-aaa-tie', 'qa-tie-z', 11, 'tie-z')
    await projection('qa-aaa-tie', 'qa-tie-a', 11, 'tie-a')
    expect((await deriveColdApiExpectation(pool))?.workspace).toMatchObject({ landscapeId: 'qa-aaa-tie', versionId: 'qa-tie-a', objects: 11 })
  })

  it('propagates a real SQL failure instead of inventing an empty successful census', async () => {
    await identity('qa-sql-error', 'qa-sql-error-main')
    await projection('qa-sql-error', 'qa-sql-error-main', 3, 'sql-error')
    await pool.query('ALTER TABLE ro_connections RENAME TO qa_absent_ro_connections')
    try {
      await expect(deriveColdApiExpectation(pool)).rejects.toMatchObject({ code: '42P01' })
    } finally {
      await pool.query('ALTER TABLE qa_absent_ro_connections RENAME TO ro_connections')
    }
  })
})
