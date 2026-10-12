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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StorageKey } from '@automerge/automerge-repo'
import { PostgresStorageAdapter, StaleSyncCellWriteError } from './automergeStorage.js'
import { ensureSyncCellOwnershipSchema } from './syncCells/ownership.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from './testing/isolatedSchema.js'
import { queryOnlyPool } from './testing/queryOnlyPool.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const DOCUMENT_ID = 'kE8ZRtuA758kFm9tC39X8SjZpYK'
const WORKSPACE = { landscapeId: 'landscape-fence', versionId: 'version-fence' }

describe.skipIf(!TEST_DATABASE_URL)('PostgresStorageAdapter transactional fencing', () => {
  let db: IsolatedSchemaDb

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'automerge_storage_fence')
    await db.pool.query(`
      CREATE TABLE landscapes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        default_version_id TEXT
      )
    `)
    await db.pool.query(`
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `)
    await db.pool.query('CREATE SEQUENCE automerge_arrival_seq')
    await db.pool.query(`
      CREATE TABLE automerge_storage (
        key TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq')
      )
    `)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [WORKSPACE.landscapeId, 'Fence'])
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url)
       VALUES ($1, $2, 'Main', $3)`,
      [WORKSPACE.versionId, WORKSPACE.landscapeId, `automerge:${DOCUMENT_ID}`],
    )
    await ensureSyncCellOwnershipSchema(db.pool)
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ($1, $2, $3)`,
      [DOCUMENT_ID, WORKSPACE.landscapeId, WORKSPACE.versionId],
    )
  })

  afterAll(async () => {
    await db?.teardown()
  })

  async function setOwner(token: string): Promise<void> {
    await db.pool.query(
      `INSERT INTO sync_workspace_ownership (
         landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, released_at
       ) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 minute', NULL)
       ON CONFLICT (landscape_id, version_id) DO UPDATE SET
         cell_id = EXCLUDED.cell_id,
         fencing_token = EXCLUDED.fencing_token,
         lease_observed_expires_at = EXCLUDED.lease_observed_expires_at,
         released_at = NULL`,
      [WORKSPACE.landscapeId, WORKSPACE.versionId, `cell-${token}`, token],
    )
  }

  it('rejects an old token without changing the stored chunk', async () => {
    await setOwner('1')
    const key: StorageKey = [DOCUMENT_ID, 'snapshot', 'token-test']
    const oldCell = new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: () => '1' },
    })
    await oldCell.save(key, new Uint8Array([1]))

    await setOwner('2')
    await expect(oldCell.save(key, new Uint8Array([9])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)
    expect(Array.from((await oldCell.load(key)) ?? [])).toEqual([1])
    expect(oldCell.snapshot()).toMatchObject({
      mappedMutationCount: 1,
      quarantinedMutationCount: 0,
      rejectedMutationCount: 1,
    })

    const newCell = new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: () => '2' },
    })
    await newCell.save(key, new Uint8Array([2]))
    expect(Array.from((await newCell.load(key)) ?? [])).toEqual([2])
  })

  it('coalesces an exact immutable retry across the fence-mismatch to ownership-unavailable handoff', async () => {
    await setOwner('3')
    let localToken: string | null = '3'
    const adapter = new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: () => localToken },
    })
    const key: StorageKey = [DOCUMENT_ID, 'incremental', 'handoff-transition']

    await setOwner('4')
    await expect(adapter.save(key, new Uint8Array([4])))
      .rejects.toMatchObject({ reason: 'fence-mismatch' })

    localToken = null
    await expect(adapter.save(key, new Uint8Array([4])))
      .rejects.toMatchObject({ reason: 'ownership-unavailable' })

    expect(adapter.snapshot()).toMatchObject({
      rejectedMutationCount: 1,
      rejectedMutationIdentityCount: 1,
      repeatedRejectedMutationCount: 0,
      coalescedStaleFenceRetryCount: 1,
      coalescedFenceMismatchCount: 0,
      coalescedOwnershipUnavailableCount: 1,
      rejectedMutationsByReason: {
        'fence-mismatch': 1,
        'ownership-unavailable': 0,
      },
    })

    localToken = '4'
    await adapter.save(key, new Uint8Array([4]))
    expect(Array.from((await adapter.load(key)) ?? [])).toEqual([4])
    expect(adapter.snapshot()).toMatchObject({
      mappedMutationCount: 1,
      coalescedStaleFenceRetryCacheSize: 0,
    })
  })

  it('serializes token handoff after an already-locked old write', async () => {
    await setOwner('10')
    const key: StorageKey = [DOCUMENT_ID, 'incremental', 'lock-order-test']
    let signalLocked!: () => void
    let releaseWrite!: () => void
    const locked = new Promise<void>((resolve) => { signalLocked = resolve })
    const released = new Promise<void>((resolve) => { releaseWrite = resolve })
    const oldCell = new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: () => '10' },
      afterFenceLocked: async () => {
        signalLocked()
        await released
      },
    })

    const oldWrite = oldCell.save(key, new Uint8Array([10]))
    await locked
    let handoffFinished = false
    const handoff = setOwner('11').then(() => { handoffFinished = true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(handoffFinished).toBe(false)

    releaseWrite()
    await oldWrite
    await handoff
    expect(handoffFinished).toBe(true)
    await expect(oldCell.save(key, new Uint8Array([99])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)
  })

  it('releases an ownership lock when the old cell is paused mid-transaction', async () => {
    await setOwner('12')
    const key: StorageKey = [DOCUMENT_ID, 'incremental', 'paused-cell-lock']
    let signalLocked!: () => void
    const locked = new Promise<void>((resolve) => { signalLocked = resolve })
    const oldCell = new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: () => '12' },
      fencedTransactionIdleTimeoutMs: 250,
      afterFenceLocked: async () => {
        signalLocked()
        await new Promise((resolve) => setTimeout(resolve, 500))
      },
    })

    const abandonedWrite = oldCell.save(key, new Uint8Array([12]))
    await locked
    const handoffStartedAt = performance.now()
    await setOwner('13')
    const handoffElapsedMs = performance.now() - handoffStartedAt

    expect(handoffElapsedMs).toBeLessThan(1_000)
    await expect(abandonedWrite).rejects.toMatchObject({ code: '25P03' })
    expect(await oldCell.load(key)).toBeUndefined()
  })

  it('fences a document-wide removeRange prefix', async () => {
    await setOwner('20')
    const adapter = new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: () => '20' },
    })
    const key: StorageKey = [DOCUMENT_ID, 'snapshot', 'remove-range-test']
    await adapter.save(key, new Uint8Array([20]))
    await setOwner('21')

    await expect(adapter.removeRange([DOCUMENT_ID]))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)
    expect(Array.from((await adapter.load(key)) ?? [])).toEqual([20])
  })

  it('resamples a local snapshot admitted between its lookup and atomic mutation', async () => {
    await setOwner('30')
    const documentId = '22Z5QFpPBmzatBNNeJPUJ7uUgt3S'
    let insertedMapping = false
    const racingDb = {
      query: async (sql: string, params?: unknown[]) => {
        if (
          !insertedMapping
          && !sql.includes('WITH document_mapping')
          && sql.includes('FROM automerge_document_workspace')
        ) {
          const result = await db.pool.query(sql, params)
          expect(result.rows).toEqual([])
          await db.pool.query(
            `INSERT INTO automerge_document_workspace (
               document_id, landscape_id, version_id
             ) VALUES ($1, $2, $3)`,
            [documentId, WORKSPACE.landscapeId, WORKSPACE.versionId],
          )
          insertedMapping = true
          return result
        }
        return db.pool.query(sql, params)
      },
    }
    const adapter = new PostgresStorageAdapter({
      // `queryOnlyPool`, not `racingDb` directly: the adapter borrows a client
      // explicitly, and a double with only `query` models a pool that
      // cannot exist. The interceptor is preserved — every statement still
      // lands on `racingDb.query`, which is this test's whole subject.
      db: queryOnlyPool(racingDb.query as never) as never,
      ownership: { fencingToken: () => '30' },
    })
    const key: StorageKey = [documentId, 'snapshot', 'admission-race']

    await adapter.save(key, new Uint8Array([30]))

    expect(insertedMapping).toBe(true)
    expect(Array.from((await adapter.load(key)) ?? [])).toEqual([30])
    expect(adapter.snapshot()).toMatchObject({
      mappedMutationCount: 1,
      quarantinedMutationCount: 0,
      mappingAdmissionRetryCount: 1,
      rejectedMutationCount: 0,
    })
  })

  it('allows an unregistered local document only as quarantined storage', async () => {
    const adapter = new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: () => null },
    })
    const key: StorageKey = ['2YNbgezwXCLEgckeLSVdvoNqPcGS', 'snapshot', 'unmapped']
    await adapter.save(key, new Uint8Array([7]))
    expect(Array.from((await adapter.load(key)) ?? [])).toEqual([7])
    expect(adapter.snapshot()).toMatchObject({
      mappedMutationCount: 0,
      quarantinedMutationCount: 1,
      rejectedMutationCount: 0,
    })
  })
})
