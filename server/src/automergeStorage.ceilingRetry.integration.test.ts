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

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import pg, { type PoolClient } from 'pg'
import { guardIdleClientErrors } from './db/poolErrorGuard.js'
import { Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { PostgresStorageAdapter, StaleSyncCellWriteError, STORAGE_UNSAVED_OWNERSHIP_REFUSAL_GRACE_MS } from './automergeStorage.js'
import { StoragePoolExhaustedError } from './automergeStorageErrors.js'
import { ensureSyncCellOwnershipSchema } from './syncCells/ownership.js'
import { AutomergeResidencyLeases } from './automergeResidency.js'
import { storageWriteCeilingCounts } from './automergeStorageCeiling.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from './testing/isolatedSchema.js'

/**
 * G4-16d round 3: a content save stopped by a ceiling of the storage write
 * pool is COUNTED, LOGGED with its document, RETRIED by the adapter with the
 * same bytes until durable — without any new edit — and the document is not
 * evicted while its delta is only in memory. The ceiling is a REAL one:
 * the write pool runs with a 150 ms `statement_timeout`, and the armed save is
 * replaced by a statement that outlives it, so the error is PostgreSQL's own
 * 57014. TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)

let db: IsolatedSchemaDb
let writePool: pg.Pool

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** The write pool, with its next `failures` content INSERTs for `documentId`
 * turned into a statement that hits the pool's real statement_timeout. */
type Injection = { timeout: true } | { error: Error } | { delayMs: number; error?: Error }
function failingWritePool() {
  let armed: { documentId: string; failures: number } | null = null
  /** key text -> what its next content INSERTs do, in order. */
  const injections = new Map<string, Injection[]>()
  const wrap = (client: PoolClient): PoolClient => new Proxy(client, {
    get(target, prop) {
      if (prop === 'query') {
        return async (...args: unknown[]) => {
          const text = typeof args[0] === 'string' ? args[0] : ''
          const key = (args[1] as unknown[] | undefined)?.find((value) => typeof value === 'string'
            && /\/(incremental|snapshot|sync-state)\//.test(value)) as string | undefined
          if (armed && armed.failures > 0 && text.includes('INSERT INTO automerge_storage') && key?.startsWith(`${armed.documentId}/`)) {
            armed.failures -= 1
            await target.query('SELECT pg_sleep(2)') // throws 57014 at 150 ms
          }
          const queued = key && text.includes('INSERT INTO automerge_storage') ? injections.get(key) : undefined
          const next = queued?.shift()
          if (next && 'timeout' in next) await target.query('SELECT pg_sleep(2)')
          if (next && 'delayMs' in next) await new Promise((resolve) => setTimeout(resolve, next.delayMs))
          if (next && 'error' in next && next.error) throw next.error
          return (target.query as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
  const pool = new Proxy(writePool, {
    get(target, prop) {
      if (prop === 'connect') return async () => wrap(await target.connect())
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  }) as pg.Pool
  return {
    pool,
    arm: (documentId: string, failures: number) => { armed = { documentId, failures } },
    inject: (key: string, ...actions: Injection[]) => { injections.set(key, [...(injections.get(key) ?? []), ...actions]) },
  }
}

const ceilingCount = (code: string) => storageWriteCeilingCounts().find((entry) => entry.code === code)!.count

suite('storage write ceilings — counted, retried until durable, never evicted unsaved', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'automerge_storage_ceiling')
    await db.pool.query('CREATE SEQUENCE automerge_arrival_seq')
    await db.pool.query('CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT)')
    await db.pool.query(`CREATE TABLE versions (id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
      label TEXT NOT NULL, root_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')`)
    await db.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query("INSERT INTO landscapes (id, name) VALUES ('landscape-ceiling', 'Ceiling')")
    await db.pool.query(`INSERT INTO versions (id, landscape_id, label, root_url)
      VALUES ('version-ceiling', 'landscape-ceiling', 'Main', 'automerge:kE8ZRtuA758kFm9tC39X8SjZpYK')`)
    await ensureSyncCellOwnershipSchema(db.pool)
    await db.pool.query(`INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
      VALUES ('kE8ZRtuA758kFm9tC39X8SjZpYK', 'landscape-ceiling', 'version-ceiling')`)
    writePool = guardIdleClientErrors(new pg.Pool({
      connectionString: connection!, max: 4, statement_timeout: 150, options: `-c search_path=${db.schema}`,
    }), 'ceiling-retry:write')
  })
  afterAll(async () => {
    await writePool?.end()
    await db?.teardown()
  })
  beforeEach(async () => { await db.pool.query('TRUNCATE automerge_storage') })

  function setup(delays: number[]) {
    const failing = failingWritePool()
    const adapter = new PostgresStorageAdapter({ db: db.pool, writeDb: failing.pool, ceilingRetryDelaysMs: delays })
    const repo = new Repo({ storage: adapter, network: [], saveDebounceRate: 60_000 })
    const residency = new AutomergeResidencyLeases(repo, {
      snapshot: (ids) => adapter.residencySnapshot(ids),
      forget: (id) => adapter.forgetResidency(id),
      hasUnsavedWrite: (id) => adapter.hasUnsavedWrite(id),
      saveCursor: () => adapter.saveCursor(),
      flushSettled: (id, cursor) => adapter.flushSettled(id, cursor),
    })
    return { failing, adapter, repo, residency }
  }
  /** What storage holds for the document, read by a fresh Repo. */
  async function durable(url: AutomergeUrl): Promise<number | undefined> {
    const reader = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [] })
    try {
      const handle = await reader.find<{ v: number }>(url)
      return handle.doc()?.v
    } finally {
      await reader.shutdown()
    }
  }

  it('one 57014 on a save: counted and logged with the document, then durable WITHOUT any new edit; not evicted meanwhile', async () => {
    const { failing, adapter, repo, residency } = setup([300, 300])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handle = repo.create<{ v: number }>({ v: 1 })
      await repo.flush()
      const id = handle.documentId
      const before = ceilingCount('57014')
      failing.arm(id, 1)
      handle.change((d) => { d.v = 2 })
      await expect(repo.flush([id])).rejects.toMatchObject({ code: '57014' })
      expect(ceilingCount('57014')).toBe(before + 1)
      const lines = errors.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('automerge.storage_write_ceiling'))
      expect(lines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({
        event: 'automerge.storage_write_ceiling', code: '57014', operation: 'save', documentId: id,
      }))
      // Unsaved: the delta is only in memory (an eviction now would be
      // refused, and would flush: 3a below; not asked here, so that only the
      // retry can carry it).
      expect(adapter.hasUnsavedWrite(id)).toBe(true)
      expect(await durable(handle.url)).toBe(1)

      // No edit, no flush: the adapter's retry makes it durable.
      expect(await until(() => durable(handle.url), (v) => v === 2, 10_000)).toBe(2)
      expect(adapter.hasUnsavedWrite(id)).toBe(false)
      expect(warns.mock.calls.map((call) => String(call[0])).some((line) =>
        line.includes('automerge.storage_write_ceiling_recovered') && line.includes(id))).toBe(true)
      expect(await residency.evict(id)).toBe(true)
    } finally {
      errors.mockRestore()
      warns.mockRestore()
      await repo.shutdown().catch(() => undefined)
    }
  }, 30_000)

  it('retries exhausted: logged, the document stays unsaved; the refused eviction flushes it durable', async () => {
    const { failing, adapter, repo, residency } = setup([100, 100])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const handle = repo.create<{ v: number }>({ v: 1 })
      await repo.flush()
      const id = handle.documentId
      const before = ceilingCount('57014')
      failing.arm(id, 3) // the save and both retries
      handle.change((d) => { d.v = 2 })
      await expect(repo.flush([id])).rejects.toMatchObject({ code: '57014' })
      const exhausted = () => errors.mock.calls.some((call) => String(call[0]).includes('automerge.storage_write_ceiling_retry_exhausted'))
      expect(await until(exhausted, (v) => v, 10_000)).toBe(true)
      expect(ceilingCount('57014')).toBe(before + 3)
      expect(adapter.hasUnsavedWrite(id)).toBe(true)
      expect(await durable(handle.url)).toBe(1)
      // Refused, counted — and the flush it starts (the Repo's next save
      // carries everything since its last success) makes it durable.
      expect(await residency.evict(id)).toBe(false)
      expect((await residency.snapshot()).evictionSkippedUnsavedWrite).toBe(1)
      expect(await until(() => adapter.hasUnsavedWrite(id), (v) => !v, 10_000)).toBe(false)
      expect(await durable(handle.url)).toBe(2)
      expect(await residency.evict(id)).toBe(true)
    } finally {
      errors.mockRestore()
      await repo.shutdown().catch(() => undefined)
    }
  }, 30_000)

  // ---- round 4: what clears an unsaved mark, and what must not ----

  const MAPPED = 'kE8ZRtuA758kFm9tC39X8SjZpYK'
  const WORKSPACE = { landscapeId: 'landscape-ceiling', versionId: 'version-ceiling' }
  async function setOwner(token: string): Promise<void> {
    await db.pool.query(
      `INSERT INTO sync_workspace_ownership (
         landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, released_at
       ) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 minute', NULL)
       ON CONFLICT (landscape_id, version_id) DO UPDATE SET
         cell_id = EXCLUDED.cell_id, fencing_token = EXCLUDED.fencing_token,
         lease_observed_expires_at = EXCLUDED.lease_observed_expires_at, released_at = NULL`,
      [WORKSPACE.landscapeId, WORKSPACE.versionId, `cell-${token}`, token],
    )
  }
  /** An adapter of the cell holding token '1', over the injecting write pool. */
  async function fencedCell(delays: number[] = [300], opts: { token?: () => string | null; graceMs?: number } = {}) {
    await setOwner('1')
    const failing = failingWritePool()
    const adapter = new PostgresStorageAdapter({
      db: db.pool, writeDb: failing.pool, ceilingRetryDelaysMs: delays,
      ownership: { fencingToken: opts.token ?? (() => '1') },
      ...(opts.graceMs !== undefined ? { ownershipRefusalGraceMs: opts.graceMs } : {}),
    })
    return { failing, adapter }
  }
  const keyOf = (name: string): [string, string, string] => [MAPPED, 'incremental', name]
  const text = (key: string[]) => key.join('/')
  const stored = async (key: string[]) => (await db.pool.query('SELECT 1 FROM automerge_storage WHERE key = $1', [text(key)])).rowCount
  const poolExhausted = () => new StoragePoolExhaustedError('fenced-mutation', 'queue-timeout', new Error('injected'))

  it('BLOCKER: a failed save (pool exhausted, never retried) stops holding the document once the fence refuses this cell', async () => {
    const { failing, adapter } = await fencedCell()
    const k1 = keyOf('pool-exhausted')
    failing.inject(text(k1), { error: poolExhausted() })
    await expect(adapter.save(k1, new Uint8Array([1]))).rejects.toBeInstanceOf(StoragePoolExhaustedError)
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(true)
    // Ownership moves; the next save of the document is refused by the fence.
    await setOwner('2')
    await expect(adapter.save(keyOf('after-handover'), new Uint8Array([2]))).rejects.toBeInstanceOf(StaleSyncCellWriteError)
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(false)
    adapter.close()
  })

  it('BLOCKER: a removal of the document\'s content clears its unsaved mark', async () => {
    const { failing, adapter } = await fencedCell()
    const k1 = keyOf('then-removed')
    failing.inject(text(k1), { error: poolExhausted() })
    await expect(adapter.save(k1, new Uint8Array([1]))).rejects.toBeInstanceOf(StoragePoolExhaustedError)
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(true)
    await adapter.removeRange([MAPPED, 'snapshot'])
    await adapter.removeRange([MAPPED, 'incremental'])
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(false)
    adapter.close()
  })

  it('1. a removal of the document cancels its pending ceiling retry: the removed chunk is not resurrected', async () => {
    const { failing, adapter } = await fencedCell([400])
    const k1 = keyOf('retry-then-removed')
    failing.inject(text(k1), { error: Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) })
    await expect(adapter.save(k1, new Uint8Array([1]))).rejects.toMatchObject({ code: '57014' })
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(true)
    await adapter.removeRange([MAPPED, 'incremental'])
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(await stored(k1)).toBe(0)
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(false)
    adapter.close()
  })

  it('2a. a LATER save that succeeds covers an earlier failed one: its retry is cancelled', async () => {
    const { failing, adapter } = await fencedCell([400])
    const older = keyOf('older-failed')
    failing.inject(text(older), { error: Object.assign(new Error('timeout'), { code: '57014' }) })
    await expect(adapter.save(older, new Uint8Array([1]))).rejects.toMatchObject({ code: '57014' })
    await adapter.save(keyOf('newer-covering'), new Uint8Array([1, 2]))
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 900))
    // The older retry never ran: no redundant chunk.
    expect(await stored(older)).toBe(0)
    adapter.close()
  })

  it('2b. an OLDER save finishing after a newer failed one does NOT clear the newer mark', async () => {
    const { failing, adapter } = await fencedCell()
    const older = keyOf('older-slow')
    const newer = keyOf('newer-failed')
    failing.inject(text(older), { delayMs: 400 })
    failing.inject(text(newer), { error: poolExhausted() })
    const slow = adapter.save(older, new Uint8Array([1]))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(adapter.save(newer, new Uint8Array([1, 2]))).rejects.toBeInstanceOf(StoragePoolExhaustedError)
    await slow
    expect(await stored(older)).toBe(1)
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(true)
    adapter.close()
  })

  it('3a. a refused eviction FLUSHES the unsaved document: durable without any edit, then evictable', async () => {
    const { failing, adapter, repo, residency } = setup([300])
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handle = repo.create<{ v: number }>({ v: 1 })
      await repo.flush()
      const id = handle.documentId
      // Fail the next content INSERT of this document, whatever its key, with
      // a failure the adapter does not retry (not a ceiling).
      let injected = false
      const fail = poolExhausted()
      const repoAdapter = adapter as unknown as { save: (k: string[], d: Uint8Array) => Promise<void> }
      const save = repoAdapter.save.bind(adapter)
      repoAdapter.save = async (k, d) => {
        if (!injected && k[0] === id && k[1] !== 'sync-state') { injected = true; failing.inject(text(k), { error: fail }) }
        return save(k, d)
      }
      handle.change((d) => { d.v = 2 })
      await expect(repo.flush([id])).rejects.toBeInstanceOf(StoragePoolExhaustedError)
      expect(adapter.hasUnsavedWrite(id)).toBe(true)
      expect(await durable(handle.url)).toBe(1)
      // The idle sweep's eviction: refused, and it asks for a flush.
      expect(await residency.evict(id)).toBe(false)
      expect(await until(() => adapter.hasUnsavedWrite(id), (v) => !v, 10_000)).toBe(false)
      expect(await durable(handle.url)).toBe(2)
      expect(await residency.evict(id)).toBe(true)
    } finally {
      warns.mockRestore()
      adapter.close()
      await repo.shutdown().catch(() => undefined)
    }
  }, 30_000)

  it('3b. a retry that meets a pool refusal backs off and tries again: no "retry exhausted"', async () => {
    const { failing, adapter } = await fencedCell([100, 100])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const k1 = keyOf('ceiling-then-pool')
      failing.inject(text(k1),
        { error: Object.assign(new Error('timeout'), { code: '57014' }) },
        { error: poolExhausted() },
        { error: poolExhausted() })
      await expect(adapter.save(k1, new Uint8Array([7]))).rejects.toMatchObject({ code: '57014' })
      expect(await until(() => stored(k1), (n) => n === 1, 10_000)).toBe(1)
      expect(adapter.hasUnsavedWrite(MAPPED)).toBe(false)
      expect(errors.mock.calls.some((call) => String(call[0]).includes('retry_exhausted'))).toBe(false)
    } finally {
      errors.mockRestore()
      adapter.close()
    }
  }, 30_000)

  // ---- final review: refusal kinds, saves in flight, dropped handles ----

  it('R1. an OWNERSHIP-UNAVAILABLE refusal keeps the mark (a blip), for the grace only; a fence MISMATCH clears it at once', async () => {
    let token: string | null = '1'
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { failing, adapter } = await fencedCell([300], { token: () => token, graceMs: 400 })
    try {
      const k1 = keyOf('blip-failed')
      failing.inject(text(k1), { error: poolExhausted() })
      await expect(adapter.save(k1, new Uint8Array([1]))).rejects.toBeInstanceOf(StoragePoolExhaustedError)
      // Ownership "lost" for one check: fencingToken() answers null.
      token = null
      await expect(adapter.save(keyOf('blip-refused'), new Uint8Array([2]))).rejects.toMatchObject({ reason: 'ownership-unavailable' })
      expect(adapter.hasUnsavedWrite(MAPPED)).toBe(true)
      // Back within the grace: the next save covers it.
      token = '1'
      await adapter.save(keyOf('blip-back'), new Uint8Array([3]))
      expect(adapter.hasUnsavedWrite(MAPPED)).toBe(false)
      // Refused for longer than the grace: released, and said so.
      failing.inject(text(keyOf('long-failed')), { error: poolExhausted() })
      await expect(adapter.save(keyOf('long-failed'), new Uint8Array([4]))).rejects.toBeInstanceOf(StoragePoolExhaustedError)
      token = null
      await expect(adapter.save(keyOf('long-refused'), new Uint8Array([5]))).rejects.toMatchObject({ reason: 'ownership-unavailable' })
      expect(adapter.hasUnsavedWrite(MAPPED)).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(adapter.hasUnsavedWrite(MAPPED)).toBe(false)
      expect(warns.mock.calls.some((call) => String(call[0]).includes('automerge.unsaved_write_released'))).toBe(true)
    } finally {
      warns.mockRestore()
      adapter.close()
    }
  })

  it('R2. a save IN FLIGHT when its document is removed neither marks it nor writes the chunk back by a retry', async () => {
    const { failing, adapter } = await fencedCell([300])
    const k1 = keyOf('in-flight-removed')
    failing.inject(text(k1), { delayMs: 300, error: Object.assign(new Error('timeout'), { code: '57014' }) })
    const inFlight = adapter.save(k1, new Uint8Array([1]))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await adapter.removeRange([MAPPED, 'incremental'])
    await expect(inFlight).rejects.toMatchObject({ code: '57014' })
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(await stored(k1)).toBe(0)
    adapter.close()
  })

  it('R3. a handle DROPPED and re-read (outside eviction): the refused eviction\'s flush finds nothing to save and clears the stale mark', async () => {
    const { failing, adapter, repo, residency } = setup([300])
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handle = repo.create<{ v: number }>({ v: 1 })
      await repo.flush()
      const id = handle.documentId
      let injected = false
      const repoAdapter = adapter as unknown as { save: (k: string[], d: Uint8Array) => Promise<void> }
      const save = repoAdapter.save.bind(adapter)
      repoAdapter.save = async (k, d) => {
        if (!injected && k[0] === id && k[1] !== 'sync-state') { injected = true; failing.inject(text(k), { error: poolExhausted() }) }
        return save(k, d)
      }
      handle.change((d) => { d.v = 2 })
      await expect(repo.flush([id])).rejects.toBeInstanceOf(StoragePoolExhaustedError)
      expect(adapter.hasUnsavedWrite(id)).toBe(true)
      // Dropped the way repoFreshness / a fork's rollback drop a handle, then
      // read back from storage (v=1: the unsaved delta went with the handle).
      handle.removeAllListeners('heads-changed')
      await repo.removeFromCache(id)
      const reread = await repo.find<{ v: number }>(handle.url)
      expect(reread.doc()!.v).toBe(1)
      expect(adapter.hasUnsavedWrite(id)).toBe(true)
      expect(await residency.evict(id)).toBe(false)
      expect(await until(() => adapter.hasUnsavedWrite(id), (v) => !v, 10_000)).toBe(false)
      expect(await residency.evict(id)).toBe(true)
    } finally {
      warns.mockRestore()
      adapter.close()
      await repo.shutdown().catch(() => undefined)
    }
  }, 30_000)

  // ---- QA of a80ac251: the adapter's bookkeeping, one guard per test ----

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const timeoutError = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
  const pendingRetries = (adapter: PostgresStorageAdapter) =>
    (adapter as unknown as { unsaved: Map<string, { retries: Map<string, unknown> }> }).unsaved.get(MAPPED)?.retries.size ?? 0

  it('S07. the ownership-refusal grace defaults to five minutes', async () => {
    expect(STORAGE_UNSAVED_OWNERSHIP_REFUSAL_GRACE_MS).toBe(300_000)
    const adapter = new PostgresStorageAdapter({ db: db.pool })
    expect((adapter as unknown as { ownershipRefusalGraceMs: number }).ownershipRefusalGraceMs).toBe(300_000)
  })

  it('S08. flushSettled clears only marks of saves started at or before its cursor', async () => {
    const { failing, adapter } = await fencedCell()
    failing.inject(text(keyOf('s08-a')), { error: poolExhausted() })
    await expect(adapter.save(keyOf('s08-a'), new Uint8Array([1]))).rejects.toBeInstanceOf(StoragePoolExhaustedError)
    const cursor = adapter.saveCursor()
    failing.inject(text(keyOf('s08-b')), { error: poolExhausted() })
    await expect(adapter.save(keyOf('s08-b'), new Uint8Array([2]))).rejects.toBeInstanceOf(StoragePoolExhaustedError)
    adapter.flushSettled(MAPPED, cursor)
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(true)
    adapter.flushSettled(MAPPED, adapter.saveCursor())
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(false)
    adapter.close()
  })

  it('S10. flushSettled keeps a mark whose retry is pending (its bytes may be the only copy)', async () => {
    const { failing, adapter } = await fencedCell([5_000])
    failing.inject(text(keyOf('s10')), { error: timeoutError() })
    await expect(adapter.save(keyOf('s10'), new Uint8Array([1]))).rejects.toMatchObject({ code: '57014' })
    adapter.flushSettled(MAPPED, adapter.saveCursor())
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(true)
    expect(pendingRetries(adapter)).toBe(1)
    adapter.close()
  })

  it('S11/S12. close() stops pending retries and schedules no new one: no INSERT after it', async () => {
    const { failing, adapter } = await fencedCell([200])
    failing.inject(text(keyOf('s11')), { error: timeoutError() })
    await expect(adapter.save(keyOf('s11'), new Uint8Array([1]))).rejects.toMatchObject({ code: '57014' })
    adapter.close()
    expect(pendingRetries(adapter)).toBe(0)
    failing.inject(text(keyOf('s12')), { error: timeoutError() })
    await expect(adapter.save(keyOf('s12'), new Uint8Array([2]))).rejects.toMatchObject({ code: '57014' })
    expect(pendingRetries(adapter)).toBe(0)
    await sleep(500)
    expect(await stored(keyOf('s11'))).toBe(0)
    expect(await stored(keyOf('s12'))).toBe(0)
  })

  it('S13. remove(key) cancels that key\'s pending retry and its mark', async () => {
    const { failing, adapter } = await fencedCell([300])
    failing.inject(text(keyOf('s13')), { error: timeoutError() })
    await expect(adapter.save(keyOf('s13'), new Uint8Array([1]))).rejects.toMatchObject({ code: '57014' })
    await adapter.remove(keyOf('s13'))
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(false)
    await sleep(600)
    expect(await stored(keyOf('s13'))).toBe(0)
    adapter.close()
  })

  it('S16. a retry refused by the pool backs off at the LAST delay', async () => {
    const { failing, adapter } = await fencedCell([100, 200, 1_500])
    failing.inject(text(keyOf('s16')), { error: timeoutError() }, { error: poolExhausted() })
    await expect(adapter.save(keyOf('s16'), new Uint8Array([1]))).rejects.toMatchObject({ code: '57014' })
    // 100 ms: the pool refuses; the next try is 1 500 ms later, not 200.
    await sleep(800)
    expect(await stored(keyOf('s16'))).toBe(0)
    expect(await until(() => stored(keyOf('s16')), (n) => n === 1, 5_000)).toBe(1)
    adapter.close()
  })

  it('S18. a retry meeting ownership-unavailable stops once the grace releases the document', async () => {
    let token: string | null = '1'
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { failing, adapter } = await fencedCell([100, 100], { token: () => token, graceMs: 300 })
    try {
      failing.inject(text(keyOf('s18')), { error: timeoutError() })
      await expect(adapter.save(keyOf('s18'), new Uint8Array([1]))).rejects.toMatchObject({ code: '57014' })
      token = null
      expect(await until(() => warns.mock.calls.some((call) => String(call[0]).includes('automerge.unsaved_write_released')),
        (v) => v, 5_000)).toBe(true)
      expect(pendingRetries(adapter)).toBe(0)
      await sleep(400)
      expect(pendingRetries(adapter)).toBe(0)
      expect(adapter.hasUnsavedWrite(MAPPED)).toBe(false)
    } finally {
      warns.mockRestore()
      adapter.close()
    }
  })

  it('S19. a failed NON-content mutation (a sync-state save) does not clear the mark', async () => {
    const { failing, adapter } = await fencedCell()
    failing.inject(text(keyOf('s19')), { error: poolExhausted() })
    await expect(adapter.save(keyOf('s19'), new Uint8Array([1]))).rejects.toBeInstanceOf(StoragePoolExhaustedError)
    const syncKey: [string, string, string] = [MAPPED, 'sync-state', 'peer-s19']
    // A sync-state save of the same document that fails: not a content save.
    failing.inject(text(syncKey), { error: poolExhausted() })
    await expect(adapter.save(syncKey, new Uint8Array([9]))).rejects.toBeInstanceOf(StoragePoolExhaustedError)
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(true)
    adapter.close()
  })

  it('S21. a success resets the refusal clock: a later refusal gets a whole grace again', async () => {
    let token: string | null = '1'
    const { failing, adapter } = await fencedCell([300], { token: () => token, graceMs: 600 })
    failing.inject(text(keyOf('s21-a')), { error: poolExhausted() })
    await expect(adapter.save(keyOf('s21-a'), new Uint8Array([1]))).rejects.toBeInstanceOf(StoragePoolExhaustedError)
    token = null
    await expect(adapter.save(keyOf('s21-r1'), new Uint8Array([2]))).rejects.toMatchObject({ reason: 'ownership-unavailable' })
    token = '1'
    await adapter.save(keyOf('s21-ok'), new Uint8Array([3]))
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(false)
    await sleep(300)
    failing.inject(text(keyOf('s21-b')), { error: poolExhausted() })
    await expect(adapter.save(keyOf('s21-b'), new Uint8Array([4]))).rejects.toBeInstanceOf(StoragePoolExhaustedError)
    token = null
    await expect(adapter.save(keyOf('s21-r2'), new Uint8Array([5]))).rejects.toMatchObject({ reason: 'ownership-unavailable' })
    // 650 ms after the FIRST refusal, 350 after this one: still held.
    await sleep(350)
    expect(adapter.hasUnsavedWrite(MAPPED)).toBe(true)
    adapter.close()
  })

  it('S22. the grace runs from the FIRST refusal, not the latest', async () => {
    let token: string | null = '1'
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { failing, adapter } = await fencedCell([300], { token: () => token, graceMs: 600 })
    try {
      failing.inject(text(keyOf('s22')), { error: poolExhausted() })
      await expect(adapter.save(keyOf('s22'), new Uint8Array([1]))).rejects.toBeInstanceOf(StoragePoolExhaustedError)
      token = null
      await expect(adapter.save(keyOf('s22-r1'), new Uint8Array([2]))).rejects.toMatchObject({ reason: 'ownership-unavailable' })
      await sleep(300)
      await expect(adapter.save(keyOf('s22-r2'), new Uint8Array([3]))).rejects.toMatchObject({ reason: 'ownership-unavailable' })
      // 700 ms after the first refusal (400 after the second): released.
      await sleep(400)
      expect(adapter.hasUnsavedWrite(MAPPED)).toBe(false)
    } finally {
      warns.mockRestore()
      adapter.close()
    }
  })
})
