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
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { dropReadModelSchema, ensureReadModelSchema } from './schema.js'
import { awaitInitialDiagramProbe, startReadModelProjector } from './projectorService.js'
import { getWorkspaceProjectionFreshness } from './health.js'

const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)

async function database(name: string) {
  const db = await createIsolatedSchemaDb(connection!, `projector_schema_${name}`)
  try {
    await db.pool.query('CREATE TABLE scopes (kind TEXT, landscape_id TEXT, version_id TEXT, org_id TEXT)')
    return db
  } catch (error) {
    await db.teardown()
    throw error
  }
}

async function prepare(db: IsolatedSchemaDb) {
  await ensureReadModelSchema(db.pool)
  await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
    key TEXT PRIMARY KEY, data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
  await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (
    document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
}

/** The real SQL still runs. Both pool and checked-out clients refuse migration
 * operations, like a runtime role without DDL privileges would. */
function runtimeDatabase(pool: IsolatedSchemaDb['pool']) {
  const statements: string[] = []
  const wrap = <T extends object>(target: T): T => new Proxy(target, { get(subject, property) {
    if (property === 'query') return (sql: string, values?: unknown[]) => {
      statements.push(sql)
      if (/^\s*(CREATE|ALTER|DROP|DO)\b/i.test(sql)) {
        return Promise.reject(new Error('runtime SQL cannot migrate the schema'))
      }
      return (Reflect.get(subject, 'query', subject) as (sql: string, values?: unknown[]) => Promise<unknown>)
        .call(subject, sql, values)
    }
    if (property === 'connect') return async () => wrap(await
      (Reflect.get(subject, 'connect', subject) as () => Promise<object>).call(subject))
    const value = Reflect.get(subject, property, subject)
    return typeof value === 'function' ? value.bind(subject) : value
  } })
  return { db: wrap(pool), statements }
}

async function seed(repo: Repo, db: IsolatedSchemaDb, landscapeId: string) {
  const key = { landscapeId, versionId: 'v1' }
  const shard = repo.create({ objects: { object: { id: 'object', name: landscapeId, type: 'system' } } })
  const meta = repo.create({ groups: {}, objectShardUrls: [shard.url], connectionShardUrls: [] })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [], diagrams: {} })
  await repo.flush()
  await db.pool.query('INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id) VALUES($1,$2,$3)',
    [shard.documentId, landscapeId, key.versionId])
  return { key, root }
}

suite('projector schema lifecycle (real PostgreSQL and Repo)', () => {
  it('builds two durable workspaces while runtime DDL is refused', async () => {
    const db = await database('runtime')
    let repo: Repo | undefined
    const stops: Array<() => void> = []
    try {
      await prepare(db)
      repo = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 0 })
      const runtime = runtimeDatabase(db.pool)
      // A positive control for the SQL observer, outside the measured starts.
      await expect(runtime.db.query('CREATE TABLE forbidden_probe (id int)')).rejects.toThrow('runtime SQL cannot migrate')
      runtime.statements.length = 0
      for (const landscapeId of ['first', 'second']) {
        const { key, root } = await seed(repo, db, landscapeId)
        stops.push(await startReadModelProjector(repo, root.url, runtime.db, key, undefined, 0))
        await awaitInitialDiagramProbe(key)
        expect((await getWorkspaceProjectionFreshness(db.pool, key)).absenceProvable).toBe(true)
        const row = await db.pool.query('SELECT data FROM ro_objects WHERE landscape_id=$1 AND version_id=$2',
          [key.landscapeId, key.versionId])
        expect(row.rows.map(value => value.data.name)).toEqual([landscapeId])
      }
      expect(runtime.statements.some(sql => /INSERT INTO ro_objects/i.test(sql))).toBe(true)
      expect(runtime.statements.filter(sql => /^\s*(CREATE|ALTER|DROP|DO)\b/i.test(sql))).toEqual([])
    } finally {
      for (const stop of stops) stop()
      await repo?.shutdown()
      await db.teardown()
    }
  })

  it('a missing schema rejects before resolving documents and creates no tables', async () => {
    const db = await database('missing')
    const repo = new Repo({ network: [] })
    const root = repo.create({ objects: {}, connections: {}, groups: {}, diagrams: {} })
    const find = vi.spyOn(repo, 'find')
    let stop: (() => void) | undefined
    try {
      const starting = startReadModelProjector(repo, root.url, db.pool,
        { landscapeId: 'missing', versionId: 'v1' }, undefined, 0).then(dispose => { stop = dispose; return dispose })
      await expect(starting).rejects.toMatchObject({ code: '42P01' })
      expect(find).not.toHaveBeenCalled()
      const tables = await db.pool.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [db.schema])
      expect(tables.rows.map(row => row.tablename)).toEqual(['scopes'])
    } finally {
      stop?.()
      find.mockRestore()
      await repo.shutdown()
      await db.teardown()
    }
  })

  it('a reset requires explicit schema preparation again on the same pool', async () => {
    const db = await database('reset')
    let repo: Repo | undefined
    let stop: (() => void) | undefined
    try {
      await prepare(db)
      repo = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 0 })
      const { key, root } = await seed(repo, db, 'reset')
      // No live projector exists while this test resets its own isolated schema.
      await dropReadModelSchema(db.pool)
      const starting = startReadModelProjector(repo, root.url, db.pool, key, undefined, 0)
        .then(dispose => { stop = dispose; return dispose })
      await expect(starting).rejects.toMatchObject({ code: '42P01' })
      await ensureReadModelSchema(db.pool)
      stop = await startReadModelProjector(repo, root.url, db.pool, key, undefined, 0)
      await awaitInitialDiagramProbe(key)
      expect((await getWorkspaceProjectionFreshness(db.pool, key)).absenceProvable).toBe(true)
      expect((await db.pool.query('SELECT count(*)::int AS count FROM ro_objects')).rows[0].count).toBe(1)
    } finally {
      stop?.()
      await repo?.shutdown()
      await db.teardown()
    }
  })
})
