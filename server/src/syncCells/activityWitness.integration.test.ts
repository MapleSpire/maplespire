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

import pg from 'pg'
import { generateAutomergeUrl, parseAutomergeUrl } from '@automerge/automerge-repo'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { syncCellDatabasePoolConfig } from '../dbConfig.js'
import { CLAIM_PROTOCOL_VERSION } from '../rbac/documentClaims.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ActivityWitness } from './activityWitness.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const workspace = { landscapeId: 'activity-land', versionId: 'activity-version' }
const mint = () => parseAutomergeUrl(generateAutomergeUrl()).documentId

describe.skipIf(!TEST_DATABASE_URL)('activity SQL and retained PostgreSQL query (T-14b)', () => {
  let db: IsolatedSchemaDb
  let reader: pg.Pool
  const witnesses: ActivityWitness[] = []
  const cleanupErrors: unknown[] = []
  async function releaseBlocker(blocker: pg.PoolClient) {
    let rollbackError: Error | undefined
    try { await blocker.query('ROLLBACK') }
    catch (error) { rollbackError = error as Error; cleanupErrors.push(error) }
    try { blocker.release(rollbackError) } catch (error) { cleanupErrors.push(error) }
  }
  async function stopWitness(value: ActivityWitness) {
    try { await value.stop() } catch (error) { cleanupErrors.push(error) }
  }
  const witness = () => {
    const value = new ActivityWitness(reader, { idleAfterMs: 60_000 })
    witnesses.push(value)
    return value
  }
  async function document(kind = 'snapshot', ageSeconds = 120, key = workspace) {
    const id = mint()
    await db.pool.query('INSERT INTO automerge_document_workspace VALUES ($1,$2,$3)', [id, key.landscapeId, key.versionId])
    await db.pool.query(`INSERT INTO automerge_storage VALUES ($1, statement_timestamp() - $2 * interval '1 second')`,
      [`${id}/${kind}/chunk`, ageSeconds])
    return id
  }
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'activity_witness')
    // Only columns read by this SELECT, with the production key/index shapes.
    // These are fixture rows, not an Automerge boot or a root-coverage walk.
    await db.pool.query(`
      CREATE TABLE versions (id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE workspace_claim_coverage (landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
        covered BOOLEAN NOT NULL, protocol INTEGER NOT NULL, PRIMARY KEY(landscape_id,version_id));
      CREATE TABLE automerge_document_workspace (document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL);
      CREATE INDEX idx_automerge_document_workspace_scope ON automerge_document_workspace(landscape_id,version_id);
      CREATE TABLE automerge_storage (key TEXT PRIMARY KEY, updated_at TIMESTAMPTZ NOT NULL);
      CREATE INDEX idx_automerge_storage_doc_updated ON automerge_storage((split_part(key,'/',1)),updated_at);
    `)
    reader = guardIdleClientErrors(new pg.Pool({
      ...syncCellDatabasePoolConfig({ DATABASE_URL: TEST_DATABASE_URL, DB_CONNECTION_TIMEOUT_MS: '1000' }),
      max: 1, options: `-c search_path=${db.schema}`, application_name: 't14b_activity_reader',
    }), 't14b-activity-test')
  })
  beforeEach(async () => {
    await db.pool.query('TRUNCATE versions, workspace_claim_coverage, automerge_document_workspace, automerge_storage')
    await db.pool.query('INSERT INTO versions VALUES ($1,$2,$3)', [workspace.versionId, workspace.landscapeId, 'active'])
    await db.pool.query('INSERT INTO workspace_claim_coverage VALUES ($1,$2,true,$3)',
      [workspace.landscapeId, workspace.versionId, CLAIM_PROTOCOL_VERSION])
  })
  afterEach(async () => {
    for (const value of witnesses.splice(0)) await stopWitness(value)
    // Vitest keeps the assertion failure and this separate hook failure. A
    // cleanup error must not replace the original error or skip later closes.
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors.splice(0), 'Activity fixture cleanup failed')
  })
  afterAll(async () => {
    const errors: unknown[] = []
    try { await reader?.end() } catch (error) { errors.push(error) }
    try { await db?.teardown() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Activity witness database cleanup failed')
  })

  it('finds quiet content and ignores newer sync-state bookkeeping on the same document', async () => {
    const id = await document()
    await db.pool.query('INSERT INTO automerge_storage VALUES ($1,statement_timestamp())', [`${id}/sync-state/peer`])
    const result = await witness().sample(workspace)
    expect(result).toMatchObject({ kind: 'idle', sampleCount: 1,
      facts: { claimCoverageCurrent: true, admittedDocuments: 1, missingContentDocuments: 0 } })
    expect(result.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.ageMs).toBeGreaterThanOrEqual(0)
  })

  it('sees recent incremental content, and the counter covers two actual reads', async () => {
    const id = await document()
    const value = witness()
    expect(await value.sample(workspace)).toMatchObject({ kind: 'idle', sampleCount: 1 })
    await db.pool.query('INSERT INTO automerge_storage VALUES ($1,statement_timestamp())', [`${id}/incremental/change`])
    expect(await value.sample(workspace)).toMatchObject({ kind: 'active', sampleCount: 2 })
  })

  it.each(['sync-state', 'future-kind'])('does not mistake an old %s-only document for present content', async kind => {
    await document(kind)
    expect(await witness().sample(workspace)).toMatchObject({ kind: 'unknown', reason: 'missing-content',
      facts: { admittedDocuments: 1, missingContentDocuments: 1 } })
  })

  it('treats a recent unknown chunk type as possible activity, never as an idle proof', async () => {
    await document('future-kind', 0)
    expect(await witness().sample(workspace)).toMatchObject({ kind: 'active', facts: { missingContentDocuments: 1 } })
  })

  it('keeps a covered empty inventory unknown and does not borrow another workspace or version', async () => {
    const value = witness()
    expect(await value.sample(workspace)).toMatchObject({ kind: 'unknown', reason: 'no-documents' })
    await document('snapshot', 0, { ...workspace, versionId: 'another-version' })
    await document('snapshot', 0, { ...workspace, landscapeId: 'another-land' })
    expect(await value.sample(workspace)).toMatchObject({ kind: 'unknown', reason: 'no-documents',
      facts: { admittedDocuments: 0 } })
    expect(await value.sample({ ...workspace, landscapeId: 'absent' })).toMatchObject({
      kind: 'unknown', reason: 'workspace-not-active' })
  })

  it('needs a current true coverage marker for idle and accepts the existing newer-protocol convention', async () => {
    await document()
    const value = witness()
    await db.pool.query('UPDATE workspace_claim_coverage SET protocol=$1', [CLAIM_PROTOCOL_VERSION - 1])
    expect(await value.sample(workspace)).toMatchObject({ kind: 'unknown', reason: 'uncovered' })
    await db.pool.query('UPDATE workspace_claim_coverage SET protocol=$1', [CLAIM_PROTOCOL_VERSION + 1])
    expect(await value.sample(workspace)).toMatchObject({ kind: 'idle' })
    await db.pool.query('UPDATE workspace_claim_coverage SET covered=false')
    expect(await value.sample(workspace)).toMatchObject({ kind: 'unknown', reason: 'uncovered' })
    await db.pool.query('DELETE FROM workspace_claim_coverage')
    expect(await value.sample(workspace)).toMatchObject({ kind: 'unknown', reason: 'uncovered' })
  })

  it('refuses idle for an admitted document whose content was removed', async () => {
    const id = await document()
    const value = witness()
    expect(await value.sample(workspace)).toMatchObject({ kind: 'idle' })
    await db.pool.query('DELETE FROM automerge_storage WHERE split_part(key,\'/\',1)=$1', [id])
    expect(await value.sample(workspace)).toMatchObject({ kind: 'unknown', reason: 'missing-content' })
  })

  it('reports a real SQL error as unknown and can observe again after repair', async () => {
    await document()
    const value = witness()
    await db.pool.query('ALTER TABLE automerge_storage RENAME TO unavailable_storage')
    try {
      expect(await value.sample(workspace)).toMatchObject({ kind: 'unknown', reason: 'query-failed', sampleCount: 1 })
    } finally {
      await db.pool.query('ALTER TABLE unavailable_storage RENAME TO automerge_storage')
    }
    expect(await value.sample(workspace)).toMatchObject({ kind: 'idle', sampleCount: 2 })
  })

  it('keeps the shipped server lock timeout effective and returns its failed client', async () => {
    await document()
    const value = witness()
    const blocker = await db.pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE automerge_storage IN ACCESS EXCLUSIVE MODE')
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const visible = value.sample(workspace)
      await expect.poll(async () => (await db.pool.query(`SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE application_name='t14b_activity_reader' AND $1::integer = ANY(pg_blocking_pids(pid))`,
      [blockerPid])).rows[0].n, { timeout: 1_500 }).toBe(1)
      expect(await visible).toMatchObject({ kind: 'unknown', reason: 'query-failed', sampleCount: 1, observedAt: null })
      expect((await db.pool.query(`SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE application_name='t14b_activity_reader' AND $1::integer = ANY(pg_blocking_pids(pid))`,
      [blockerPid])).rows[0].n).toBe(0)
    } finally {
      await releaseBlocker(blocker)
      await stopWitness(value)
    }
    expect((await reader.query('SELECT 23 AS witness')).rows[0].witness).toBe(23)
    expect(reader.waitingCount).toBe(0)
  })

  it('joins a real blocked query after the default verdict timeout, then returns the pool client', async () => {
    await document()
    const value = witness()
    expect(await value.sample(workspace)).toMatchObject({ kind: 'idle', sampleCount: 1 })
    const settings = await reader.query(`SELECT current_setting('statement_timeout') AS statement,
      current_setting('lock_timeout') AS lock`)
    expect(settings.rows[0]).toEqual({ statement: '30s', lock: '2s' })
    // Keep the production pool configuration for every ordinary read; only this
    // single-reader fixture session extends its lock patience to expose the
    // client-side verdict timeout before PostgreSQL cancels its raw statement.
    let blocker: pg.PoolClient | undefined
    let blockerPid: number | undefined
    let blockedPid: number | undefined
    let stopSettled = false
    try {
      await reader.query("SET lock_timeout = '25s'")
      blocker = await db.pool.connect()
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE automerge_storage IN ACCESS EXCLUSIVE MODE')
      blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const visible = value.sample(workspace)
      const findBlocked = async () => (await db.pool.query(`SELECT pid FROM pg_stat_activity
        WHERE application_name='t14b_activity_reader' AND $1::integer = ANY(pg_blocking_pids(pid))`, [blockerPid])).rows
      await expect.poll(async () => {
        const found = await findBlocked()
        blockedPid = found[0]?.pid
        return found.length
      }, { timeout: 5_000 }).toBe(1)
      expect(await visible).toMatchObject({ kind: 'unknown', reason: 'query-timeout', sampleCount: 2, observedAt: null })
      expect(await value.sample({ ...workspace, versionId: 'second' })).toMatchObject({
        kind: 'unknown', reason: 'query-in-flight', sampleCount: 2 })
      const stopping = value.stop().then(() => { stopSettled = true })
      expect((await findBlocked()).map(row => row.pid)).toEqual([blockedPid])
      expect(stopSettled).toBe(false)
      expect(reader.totalCount).toBe(1)
      expect(reader.idleCount).toBe(0)
      expect(reader.waitingCount).toBe(0)
      process.stdout.write(`[activity-witness] blocked-after-timeout ${JSON.stringify({ blockerPid, blockedPid,
        sampleCount: 2, idleClients: reader.idleCount, stopSettled })}\n`)
      await blocker.query('ROLLBACK')
      await stopping
      expect(stopSettled).toBe(true)
      expect(value.snapshot()).toMatchObject({ kind: 'unknown', reason: 'stopped', observedAt: null })
      expect((await reader.query('SELECT 17 AS witness')).rows[0].witness).toBe(17)
      expect(reader.idleCount).toBe(1)
      process.stdout.write(`[activity-witness] returned-after-unlock ${JSON.stringify({ idleClients: reader.idleCount,
        waitingClients: reader.waitingCount, stopSettled, sharedPoolStillUsable: true })}\n`)
    } finally {
      if (blocker) await releaseBlocker(blocker)
      await stopWitness(value)
      try { await reader.query("SET lock_timeout = '2s'") } catch (error) { cleanupErrors.push(error) }
    }
  }, 35_000)
})
