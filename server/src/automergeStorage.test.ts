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
import { PostgresStorageAdapter } from './automergeStorage.js'
import { StaleSyncCellWriteError } from './automergeStorage.js'
import { StaleSyncCellWriteError as leafStaleSyncCellWriteError } from './automergeStorageErrors.js'
import { dependencyOutageResponse } from './runtime/dependencyOutageResponse.js'
import { queryOnlyPool } from './testing/queryOnlyPool.js'
import { DOCUMENT_CONTENT_CHUNK_TYPES, documentContentChunkFilter } from './automergeStorage.js'

describe('PostgresStorageAdapter static read-model queue', () => {
  it('reads the fencing counter without pruning retries, querying storage or counting coalesced refusals', async () => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const query = vi.fn(async () => ({
      rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }],
    }))
    const adapter = new PostgresStorageAdapter({ db: queryOnlyPool(query),
      ownership: { fencingToken: () => null }, ownershipUnavailableCoalescingWindowMs: 50 })
    const repo = new Repo({ network: [] })
    const key = [repo.create({}).documentId, 'incremental', 'metrics-retry']
    try {
      expect(adapter.readRejectedMutationCount()).toBe(0)
      await expect(adapter.save(key, new Uint8Array([1]))).rejects.toBeInstanceOf(StaleSyncCellWriteError)
      expect(adapter.readRejectedMutationCount()).toBe(1)
      now = 10
      await expect(adapter.save(key, new Uint8Array([1]))).rejects.toBeInstanceOf(StaleSyncCellWriteError)
      expect(adapter.snapshot()).toMatchObject({ rejectedMutationCount: 1,
        coalescedStaleFenceRetryCount: 1, coalescedStaleFenceRetryCacheSize: 1 })

      // Observe the cache without using snapshot(), which is the mutating reader
      // this metric must avoid. The expired entry is a positive pruning control.
      const retries = Reflect.get(adapter, 'coalescedStaleFenceMutations') as Map<string, unknown>
      expect(retries.size).toBe(1)
      const before = structuredClone([...retries])
      const queryCalls = query.mock.calls.length
      now = 60
      for (let scrape = 0; scrape < 3; scrape++) expect(adapter.readRejectedMutationCount()).toBe(1)
      expect([...retries]).toEqual(before)
      expect(query).toHaveBeenCalledTimes(queryCalls)
      expect(adapter.snapshot().coalescedStaleFenceRetryCacheSize).toBe(0)
      expect(retries.size).toBe(0)
      await expect(adapter.save(key, new Uint8Array([1]))).rejects.toBeInstanceOf(StaleSyncCellWriteError)
      expect(adapter.readRejectedMutationCount()).toBe(2)
    } finally {
      clock.mockRestore()
      await repo.shutdown()
    }
  })

  it('coalesces the exact immutable retry when a handoff advances from fence mismatch to unavailable ownership', async () => {
    let token: string | null = '7'
    let permitMutation = false
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes('WITH document_mapping')) {
        return { rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }] }
      }
      return {
        rows: [{
          mapped: true,
          fence_valid: permitMutation,
          permitted: permitMutation,
        }],
      }
    })
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      ownership: { fencingToken: () => token },
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId
    const key = [documentId, 'incremental', 'handoff-content-hash'] as const

    try {
      await expect(adapter.save([...key], new Uint8Array([1])))
        .rejects.toMatchObject<Partial<StaleSyncCellWriteError>>({
          mutationKind: 'incremental',
          reason: 'fence-mismatch',
        })

      token = null
      await expect(adapter.save([...key], new Uint8Array([1])))
        .rejects.toMatchObject<Partial<StaleSyncCellWriteError>>({
          mutationKind: 'incremental',
          reason: 'ownership-unavailable',
        })

      expect(query).toHaveBeenCalledTimes(3)
      expect(adapter.snapshot()).toMatchObject({
        rejectedMutationCount: 1,
        rejectedMutationIdentityCount: 1,
        repeatedRejectedMutationCount: 0,
        coalescedOwnershipUnavailableCount: 1,
        coalescedOwnershipUnavailableCacheSize: 1,
        rejectedMutationsByKind: { incremental: 1 },
        rejectedMutationsByReason: {
          'fence-mismatch': 1,
          'ownership-unavailable': 0,
        },
      })

      token = '8'
      permitMutation = true
      await adapter.save([...key], new Uint8Array([1]))

      expect(query).toHaveBeenCalledTimes(5)
      expect(adapter.snapshot()).toMatchObject({
        mappedMutationCount: 1,
        rejectedMutationCount: 1,
        coalescedOwnershipUnavailableCount: 1,
        coalescedOwnershipUnavailableCacheSize: 0,
      })
    } finally {
      await repo.shutdown()
    }
  })

  it('coalesces only an exact immutable retry while ownership is unavailable, then writes after reacquisition', async () => {
    let token: string | null = null
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes('WITH document_mapping')) {
        return { rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }] }
      }
      return { rows: [{ mapped: true, fence_valid: true, permitted: true }] }
    })
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      ownership: { fencingToken: () => token },
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId
    const key = [documentId, 'incremental', 'same-content-hash'] as const

    await expect(adapter.save([...key], new Uint8Array([1])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)
    await expect(adapter.save([...key], new Uint8Array([1])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)

    expect(query).toHaveBeenCalledTimes(2)
    expect(adapter.snapshot()).toMatchObject({
      rejectedMutationCount: 1,
      rejectedMutationIdentityCount: 1,
      repeatedRejectedMutationCount: 0,
      coalescedOwnershipUnavailableCount: 1,
      coalescedOwnershipUnavailableCacheSize: 1,
      coalescedOwnershipUnavailableEvictions: 0,
      maxCoalescedOwnershipUnavailablePerMutation: 1,
    })

    token = '8'
    await adapter.save([...key], new Uint8Array([1]))

    expect(query).toHaveBeenCalledTimes(4)
    expect(adapter.snapshot()).toMatchObject({
      mappedMutationCount: 1,
      rejectedMutationCount: 1,
      coalescedOwnershipUnavailableCount: 1,
      coalescedOwnershipUnavailableCacheSize: 0,
    })
    await repo.shutdown()
  })

  it('throws the SAME class object the HTTP mapping matches on — one definition, not two copies', async () => {
    // If `StaleSyncCellWriteError` were re-declared locally in
    // `automergeStorage.ts` instead of re-exporting the leaf, the throwers and
    // every `instanceof` importing from this module would agree CONSISTENTLY,
    // so other tests would stay green — while `dependencyOutageResponse`
    // imports the OTHER class, its `instanceof` answers false, and every fence
    // refusal becomes `500 {"error":"read model query failed"}`.
    //
    // So this arm asserts identity against the error the ADAPTER ACTUALLY THREW,
    // not against one the test constructed (as the mapping suites do).
    const query = vi.fn(async (sql: string) => (
      sql.includes('WITH document_mapping')
        ? { rows: [{ mapped: true, fence_valid: true, permitted: true }] }
        : { rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }] }
    ))
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      ownership: { fencingToken: () => null },
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId

    const thrown = await adapter
      .save([documentId, 'incremental', 'identity-gate'], new Uint8Array([1]))
      .then(() => null, (error: unknown) => error)

    expect(thrown).toBeInstanceOf(leafStaleSyncCellWriteError)
    expect(StaleSyncCellWriteError).toBe(leafStaleSyncCellWriteError)
    // And end to end: the mapping answers a REAL refusal, so the gate covers the
    // identity AND the wiring that depends on it.
    expect(dependencyOutageResponse(thrown)).toMatchObject({
      status: 503,
      body: { code: 'sync-cell-ownership-unavailable' },
    })
    await repo.shutdown()
  })

  it('does not coalesce newer immutable chunks or a repaired workspace mapping', async () => {
    let mapping = { landscape_id: 'retired-landscape', version_id: 'retired-version' }
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes('WITH document_mapping')) return { rows: [mapping] }
      return { rows: [{ mapped: true, fence_valid: true, permitted: true }] }
    })
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      ownership: {
        fencingToken: ({ landscapeId }) => landscapeId === 'active-landscape' ? '11' : null,
      },
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId

    await expect(adapter.save(
      [documentId, 'incremental', 'older-heads'],
      new Uint8Array([1]),
    )).rejects.toBeInstanceOf(StaleSyncCellWriteError)
    await expect(adapter.save(
      [documentId, 'incremental', 'newer-heads'],
      new Uint8Array([2]),
    )).rejects.toBeInstanceOf(StaleSyncCellWriteError)

    expect(adapter.snapshot()).toMatchObject({
      rejectedMutationCount: 2,
      rejectedMutationIdentityCount: 2,
      repeatedRejectedMutationCount: 0,
      coalescedOwnershipUnavailableCount: 0,
    })

    mapping = { landscape_id: 'active-landscape', version_id: 'active-version' }
    await adapter.save(
      [documentId, 'incremental', 'older-heads'],
      new Uint8Array([1]),
    )

    expect(adapter.snapshot()).toMatchObject({ mappedMutationCount: 1 })
    await repo.shutdown()
  })

  it('keeps the unavailable-mutation circuit breaker bounded and reports evictions', async () => {
    const query = vi.fn(async () => ({
      rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }],
    }))
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      ownership: { fencingToken: () => null },
      ownershipUnavailableCoalescingLimit: 2,
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId

    for (const hash of ['chunk-a', 'chunk-b', 'chunk-c']) {
      await expect(adapter.save(
        [documentId, 'incremental', hash],
        new Uint8Array([1]),
      )).rejects.toBeInstanceOf(StaleSyncCellWriteError)
    }

    expect(adapter.snapshot()).toMatchObject({
      rejectedMutationCount: 3,
      coalescedOwnershipUnavailableCount: 0,
      coalescedOwnershipUnavailableCacheSize: 2,
      coalescedOwnershipUnavailableEvictions: 1,
    })
    await repo.shutdown()
  })

  it('expires exact-mutation coalescing so a sustained stale retry remains a hard signal', async () => {
    let now = 0
    const performanceNow = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const query = vi.fn(async () => ({
      rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }],
    }))
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      ownership: { fencingToken: () => null },
      ownershipUnavailableCoalescingWindowMs: 50,
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId
    const key = [documentId, 'incremental', 'sustained-retry'] as const

    try {
      await expect(adapter.save([...key], new Uint8Array([1])))
        .rejects.toBeInstanceOf(StaleSyncCellWriteError)
      now = 10
      await expect(adapter.save([...key], new Uint8Array([1])))
        .rejects.toBeInstanceOf(StaleSyncCellWriteError)
      now = 60
      await expect(adapter.save([...key], new Uint8Array([1])))
        .rejects.toBeInstanceOf(StaleSyncCellWriteError)

      expect(adapter.snapshot()).toMatchObject({
        rejectedMutationCount: 2,
        rejectedMutationIdentityCount: 1,
        repeatedRejectedMutationCount: 1,
        coalescedOwnershipUnavailableCount: 1,
        maxCoalescedOwnershipUnavailablePerMutation: 1,
      })
    } finally {
      performanceNow.mockRestore()
      await repo.shutdown()
    }
  })

  it('classifies an exact storage-mutation retry as repeated without exposing its identifier', async () => {
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes('WITH document_mapping')) {
        return { rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }] }
      }
      return { rows: [{ mapped: true, fence_valid: false, permitted: false }] }
    })
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      ownership: { fencingToken: () => '7' },
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId

    await expect(adapter.save([documentId, 'sync-state', 'peer'], new Uint8Array([1])))
      .rejects.toMatchObject<Partial<StaleSyncCellWriteError>>({
        mutationKind: 'sync-state',
        reason: 'fence-mismatch',
      })
    await expect(adapter.save([documentId, 'sync-state', 'peer'], new Uint8Array([2])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)

    expect(adapter.snapshot()).toMatchObject({
      rejectedMutationCount: 2,
      rejectedDocumentCount: 1,
      rejectedMutationIdentityCount: 1,
      repeatedRejectedMutationCount: 1,
      rejectedMutationsByKind: { 'sync-state': 2 },
      rejectedMutationsByReason: { 'fence-mismatch': 2 },
    })
    await repo.shutdown()
  })

  it('logs each immutable identity once and coalesces an exact fence-mismatch retry', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes('WITH document_mapping')) {
        return { rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }] }
      }
      return { rows: [{ mapped: true, fence_valid: false, permitted: false }] }
    })
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      ownership: { fencingToken: () => '7' },
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId

    try {
      for (const hash of ['chunk-a', 'chunk-a', 'chunk-b']) {
        await expect(adapter.save(
          [documentId, 'incremental', hash],
          new Uint8Array([1]),
        )).rejects.toBeInstanceOf(StaleSyncCellWriteError)
      }

      expect(warnings.mock.calls.map(([entry]) => JSON.parse(String(entry)).repeated))
        .toEqual([false, false])
      expect(adapter.snapshot()).toMatchObject({
        rejectedMutationCount: 2,
        rejectedMutationIdentityCount: 2,
        repeatedRejectedMutationCount: 0,
        coalescedStaleFenceRetryCount: 1,
        coalescedFenceMismatchCount: 1,
        coalescedOwnershipUnavailableCount: 0,
        rejectedMutationsByReason: { 'fence-mismatch': 2 },
      })
    } finally {
      warnings.mockRestore()
      await repo.shutdown()
    }
  })

  it('does not classify distinct chunks of one document as a repeated fencing rejection', async () => {
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes('WITH document_mapping')) {
        return { rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }] }
      }
      return { rows: [{ mapped: true, fence_valid: false, permitted: false }] }
    })
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      ownership: { fencingToken: () => '7' },
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId

    await expect(adapter.save([documentId, 'incremental', 'chunk-a'], new Uint8Array([1])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)
    await expect(adapter.save([documentId, 'incremental', 'chunk-b'], new Uint8Array([2])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)

    expect(adapter.snapshot()).toMatchObject({
      rejectedMutationCount: 2,
      rejectedDocumentCount: 1,
      rejectedMutationIdentityCount: 2,
      repeatedRejectedMutationCount: 0,
      rejectedMutationsByKind: { incremental: 2 },
      rejectedMutationsByReason: { 'fence-mismatch': 2 },
    })
    await repo.shutdown()
  })

  it('bounds the deliberately paused lock-order test transaction', async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params })
        if (sql.includes('FROM automerge_document_workspace')) {
          return { rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }] }
        }
        if (sql.includes('FROM sync_workspace_ownership')) {
          return { rows: [{ fencing_token: '7', released_at: null }] }
        }
        return { rows: [] }
      }),
      on: vi.fn(),
      off: vi.fn(),
      release: vi.fn(),
    }
    const adapter = new PostgresStorageAdapter({
      db: { connect: async () => client } as never,
      ownership: { fencingToken: () => '7' },
      fencedTransactionIdleTimeoutMs: 750,
      afterFenceLocked: async () => undefined,
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId

    await adapter.save([documentId, 'incremental', 'bounded-fence'], new Uint8Array([1]))

    expect(queries[0]?.sql).toBe('BEGIN')
    expect(queries[1]).toEqual({
      sql: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
      params: ['750ms'],
    })
    expect(queries.findIndex(({ sql }) => sql.includes('FROM automerge_document_workspace'))).toBeGreaterThan(1)
    expect(queries.at(-1)?.sql).toBe('COMMIT')
    await repo.shutdown()
  })

  it('uses one non-blocking PostgreSQL statement for a production fenced mutation', async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params })
      if (!sql.includes('WITH document_mapping')) {
        return { rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }] }
      }
      return { rows: [{ mapped: true, fence_valid: true, permitted: true }] }
    })
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      ownership: { fencingToken: () => '7' },
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId

    await adapter.save([documentId, 'incremental', 'atomic-fence'], new Uint8Array([1]))

    expect(queries).toHaveLength(2)
    expect(queries.map(({ sql }) => sql)).not.toContain('BEGIN')
    expect(queries[1]?.sql).not.toContain('FOR SHARE')
    expect(queries[1]?.sql).toContain('mutation_permission AS MATERIALIZED')
    expect(queries[1]?.sql).toContain('INSERT INTO automerge_storage')
    expect(adapter.snapshot()).toMatchObject({ mappedMutationCount: 1, rejectedMutationCount: 0 })
    await repo.shutdown()
  })

  it('resamples ownership when a quarantined document is admitted between lookup and mutation', async () => {
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId
    let mappingReads = 0
    let mutationAttempts = 0
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (!sql.includes('WITH document_mapping')) {
        mappingReads += 1
        return mappingReads === 1
          ? { rows: [] }
          : { rows: [{ landscape_id: 'landscape-1', version_id: 'version-1' }] }
      }
      mutationAttempts += 1
      if (mutationAttempts === 1) {
        expect(params?.slice(0, 4)).toEqual([documentId, null, null, null])
        return { rows: [{ mapped: true, fence_valid: false, permitted: false }] }
      }
      expect(params?.slice(0, 4)).toEqual([
        documentId, '23', 'landscape-1', 'version-1',
      ])
      return { rows: [{ mapped: true, fence_valid: true, permitted: true }] }
    })
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      ownership: { fencingToken: () => '23' },
    })

    await adapter.save([documentId, 'snapshot', 'admission-race'], new Uint8Array([1]))

    expect(query).toHaveBeenCalledTimes(4)
    expect(adapter.snapshot()).toMatchObject({
      mappedMutationCount: 1,
      mappingAdmissionRetryCount: 1,
      rejectedMutationCount: 0,
    })
    await repo.shutdown()
  })

  it('still rejects an admission race when the new workspace is not locally owned', async () => {
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId
    let mappingReads = 0
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes('WITH document_mapping')) {
        mappingReads += 1
        return mappingReads === 1
          ? { rows: [] }
          : { rows: [{ landscape_id: 'foreign-landscape', version_id: 'version-1' }] }
      }
      return { rows: [{ mapped: true, fence_valid: false, permitted: false }] }
    })
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      ownership: { fencingToken: () => null },
    })

    await expect(adapter.save(
      [documentId, 'snapshot', 'foreign-admission-race'],
      new Uint8Array([1]),
    )).rejects.toMatchObject<Partial<StaleSyncCellWriteError>>({
      mutationKind: 'snapshot',
      reason: 'ownership-unavailable',
    })

    expect(query).toHaveBeenCalledTimes(3)
    expect(adapter.snapshot()).toMatchObject({
      mappedMutationCount: 0,
      mappingAdmissionRetryCount: 1,
      rejectedMutationCount: 1,
      rejectedMutationsByReason: { 'ownership-unavailable': 1 },
    })
    await repo.shutdown()
  })

  it('enqueues a revision in the same atomic statement as an Automerge save', async () => {
    const queries: string[] = []
    const query = vi.fn(async (sql: string) => {
        queries.push(sql)
        return { rows: [] }
      })
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      trackStaticReadModel: true,
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId

    await adapter.save([documentId, 'incremental', 'hash'], new Uint8Array([1, 2, 3]))

    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('INSERT INTO automerge_storage')
    expect(queries[0]).toContain('INSERT INTO read_model_static_document_queue')
    expect(queries[0]).not.toContain('BEGIN')
    await repo.shutdown()
  })

  it('does not enqueue sync-state noise', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      trackStaticReadModel: true,
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({}).documentId

    await adapter.save([documentId, 'sync-state', 'peer'], new Uint8Array([1]))

    expect(query.mock.calls.some(([sql]) => String(sql).includes('read_model_static_document_queue'))).toBe(false)
    await repo.shutdown()
  })
})

describe('#41 — a registry-shard write must reach the projection queue (T2)', () => {
  // The write head is the ONE document a summary workspace appends new diagrams
  // to. It was absent from the queue filter, so an append incremented no
  // revision, and BOTH catch-up paths that consult the queue
  // (`recoverChangedDocuments`, `triggerIfDurablyPending`) were blind to it.
  //
  // WITHOUT THIS, C2 IS A FALSE PASS OF THE WORST KIND: the projection branch is
  // green in its own suite and NOTHING IN PRODUCTION EVER CALLS IT. That is the
  // "added but wired nowhere" shape.
  //
  // The filter is ONE constant used by two statements — the CTE form and the
  // standalone form — and each site still gets its own test below, so the
  // coverage does not depend on that sharing surviving a refactor.

  /** The kinds the queue accepts, read out of a statement the adapter really
   * produced — never out of the source file, which would assert nothing. */
  function queuedKinds(sql: string): string[] {
    const clause = /document\.kind IN \(([^)]*)\)/.exec(sql)
    if (!clause) throw new Error(`no document.kind filter in the statement:\n${sql}`)
    return clause[1].split(',').map((kind) => kind.trim().replace(/^'|'$/g, ''))
  }

  it('site 1/2 — the CTE form, used by every ordinary save', async () => {
    const queries: string[] = []
    const query = vi.fn(async (sql: string) => { queries.push(sql); return { rows: [] } })
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      trackStaticReadModel: true,
    })
    const repo = new Repo({ network: [] })
    const documentId = repo.create({ diagrams: {} }).documentId

    await adapter.save([documentId, 'incremental', 'hash'], new Uint8Array([1, 2, 3]))

    expect(queries).toHaveLength(1)
    expect(queuedKinds(queries[0])).toContain('registry-shard')
    // The kinds that were already there must stay: dropping one would stop the
    // model, the overlays or the diagrams from ever being projected again.
    expect(queuedKinds(queries[0])).toEqual(expect.arrayContaining([
      'model-meta', 'object-overlay', 'connection-overlay', 'diagram',
    ]))
    await repo.shutdown()
  })

  it('site 2/2 — the standalone form, used by the legacy fenced path', async () => {
    // A separate statement in a separate method. It is reached only through the
    // legacy fenced mutation, so it is exercised directly here rather than not
    // at all — the alternative is a site nothing covers.
    const queries: string[] = []
    const client = { query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: [] } }) }
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(vi.fn(async () => ({ rows: [] }))),
      trackStaticReadModel: true,
    })
    const internal = adapter as unknown as {
      enqueueReadModelRevision(client: unknown, documentId: string): Promise<void>
    }

    await internal.enqueueReadModelRevision(client, 'some-document-id')

    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('INSERT INTO read_model_static_document_queue')
    expect(queuedKinds(queries[0])).toContain('registry-shard')
    expect(queuedKinds(queries[0])).toEqual(expect.arrayContaining([
      'model-meta', 'object-overlay', 'connection-overlay', 'diagram',
    ]))
  })

  it('the two sites accept exactly the same kinds', async () => {
    // The invariant behind the defect, stated as an assertion instead of as a
    // hope. Two statements that must agree, compared against each other.
    const queries: string[] = []
    const query = vi.fn(async (sql: string) => { queries.push(sql); return { rows: [] } })
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(query),
      trackStaticReadModel: true,
    })
    const repo = new Repo({ network: [] })
    await adapter.save([repo.create({}).documentId, 'incremental', 'h'], new Uint8Array([1]))
    const client = { query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: [] } }) }
    await (adapter as unknown as {
      enqueueReadModelRevision(client: unknown, documentId: string): Promise<void>
    }).enqueueReadModelRevision(client, 'd')

    expect(queuedKinds(queries[1]).sort()).toEqual(queuedKinds(queries[0]).sort())
    await repo.shutdown()
  })
})

/**
 * The content-chunk filter, which decides whether a document "has content" for
 * BOTH runnable presence checks — `workspaceFsck.ts`'s `document-present` and
 * `scripts/verify-retained-documents.ts`.
 *
 * One shared definition, so the two checks cannot disagree on the
 * unknown-kind default, and so no check runs with no filter at all.
 */
describe('documentContentChunkFilter', () => {
  it('renders the exact SQL both presence checks embed', () => {
    // LITERALS, not `DOCUMENT_CONTENT_CHUNK_TYPES.join(...)`. A test that builds
    // its expectation from the constant under test agrees with whatever that
    // constant is given — including an empty array, which would render
    // `IN ()`, a syntax error that only a live database would catch.
    expect(documentContentChunkFilter()).toBe(
      "split_part(key, '/', 2) IN ('snapshot', 'incremental')",
    )
    expect(documentContentChunkFilter('storage.key')).toBe(
      "split_part(storage.key, '/', 2) IN ('snapshot', 'incremental')",
    )
  })

  it('excludes sync-state, which is the whole point', () => {
    // The 2-byte peer-bookkeeping row automerge-repo writes the first time a
    // peer merely TRIES to sync — including a document whose bytes were never
    // stored. Under a bare `split_part(key,'/',1) = id` it reads as presence.
    expect(DOCUMENT_CONTENT_CHUNK_TYPES).not.toContain('sync-state')
  })

  it('excludes an UNKNOWN kind, so a new one lands where a human sees it', () => {
    // The property that decides the SPELLING, and the only one on which the two
    // candidate predicates differ: with a `<> 'sync-state'` filter a document
    // whose only row is an unrecognised chunk kind is EXEMPT — silently counted
    // as content, no finding — while this form flags it. Today's data cannot
    // tell the two apart, so only this assertion does.
    //
    // Asserted as `not.toContain` on a kind that does not exist rather than as
    // a length check: a length check passes if someone swaps a member out.
    expect(DOCUMENT_CONTENT_CHUNK_TYPES).not.toContain('some-new-kind')
    expect([...DOCUMENT_CONTENT_CHUNK_TYPES].sort()).toEqual(['incremental', 'snapshot'])
  })
})
