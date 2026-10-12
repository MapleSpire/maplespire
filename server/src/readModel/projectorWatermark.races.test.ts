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
import { setImmediate as eventLoopTurn } from 'node:timers/promises'
import * as A from '@automerge/automerge'
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { getWorkspaceProjectionFreshness } from './health.js'
import { prepareDocumentWatermarkProofs, recordProjectedWatermarks, recordSampledDocumentWatermark } from './arrivalWatermark.js'
import { startReadModelProjector, awaitInitialDiagramProbe } from './projectorService.js'

const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const key = { landscapeId: 'watermark-race', versionId: 'v1' }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function database(name: string): Promise<IsolatedSchemaDb> {
  const db = await createIsolatedSchemaDb(connection!, `projector_wm_${name}`)
  try {
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE automerge_storage (
      key TEXT PRIMARY KEY, data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)
    await db.pool.query(`CREATE TABLE automerge_document_workspace (
      document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await db.pool.query(`CREATE TABLE scopes (kind TEXT, landscape_id TEXT, version_id TEXT, org_id TEXT)`)
    return db
  } catch (error) {
    await db.teardown()
    throw error
  }
}

/** Intercept the actual pool AND transaction-client statements. Ordinary
 * methods retain their original receiver, including release and connect. */
function hookedPool(pool: IsolatedSchemaDb['pool'], hook: (sql: unknown, proceed: () => Promise<unknown>, values?: unknown[]) => Promise<unknown>) {
  const wrap = <T extends object>(target: T): T => new Proxy(target, { get(subject, property) {
    if (property === 'query') return (sql: unknown, values?: unknown[]) => hook(sql,
      () => (Reflect.get(subject, 'query', subject) as (sql: unknown, values?: unknown[]) => Promise<unknown>).call(subject, sql, values), values)
    if (property === 'connect') return async () => wrap(await (Reflect.get(subject, 'connect', subject) as () => Promise<object>).call(subject))
    const value = Reflect.get(subject, property, subject)
    return typeof value === 'function' ? value.bind(subject) : value
  } })
  return wrap(pool)
}

suite('ordinary projector arrival watermark races (real PostgreSQL and Repo)', () => {
  it('pure preparation drains a transaction whose arrival was minted before capture without starting another save', async () => {
    const db = await database('pure_preparation_drain')
    const release = deferred(), entered = deferred(), captured = deferred()
    const adapter = new PostgresStorageAdapter({ db: db.pool })
    const repo = new Repo({ storage: adapter, network: [], saveDebounceRate: 0 })
    let armed = false, held = false, commitFinished = false, durableReadObserved = false
    let mintedArrival: string | undefined
    let pending: ReturnType<typeof prepareDocumentWatermarkProofs> | undefined
    // This seam wraps the real adapter body in a real transaction. Its SQL,
    // sequence allocation and write bytes are unchanged; only COMMIT waits.
    const seam = adapter as unknown as { withBoundedClient: (operation: string, fn: (client: Awaited<ReturnType<typeof db.pool.connect>>) => Promise<unknown>) => Promise<unknown> }
    const originalBounded = seam.withBoundedClient.bind(adapter)
    seam.withBoundedClient = async (operation, fn) => {
      if (!armed || held || operation !== 'unfenced-mutation') return originalBounded(operation, fn)
      held = true
      const client = await db.pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn(client)
        mintedArrival = (await client.query('SELECT max(arrival_seq)::text AS arrival FROM automerge_storage')).rows[0].arrival
        entered.resolve()
        await release.promise
        await client.query('COMMIT')
        commitFinished = true
        return result
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }
    try {
      const shard = repo.create({ objects: { x: { id: 'x', name: 'H0' } } })
      await repo.flush()
      armed = true
      shard.change(doc => { doc.objects.x.name = 'H1' })
      const h1 = A.getHeads(shard.doc())
      await entered.promise
      await repo.removeFromCache(shard.documentId)
      const active = await repo.find<{ objects: { x: { name: string } } }>(shard.url)
      expect(active.doc().objects.x.name).toBe('H0')
      const observed = hookedPool(db.pool, async (sql, proceed) => {
        if (typeof sql === 'string' && sql.includes('JOIN automerge_storage AS storage')) {
          durableReadObserved = true
          expect(commitFinished, 'durable SELECT must begin only after the retained write COMMIT finished').toBe(true)
        }
        const result = await proceed()
        if (typeof sql === 'string' && /^\s*SELECT nextval\('automerge_arrival_seq'\)/.test(sql)) captured.resolve()
        return result
      })
      pending = prepareDocumentWatermarkProofs(observed, [{ documentId: shard.documentId, drainPendingSaves: () => {
        return repo.storageSubsystem!.drainDocumentSaves(shard.documentId)
      } }])
      void pending.catch(() => undefined)
      await captured.promise
      await eventLoopTurn()
      release.resolve()
      const prepared = await pending
      expect(durableReadObserved).toBe(true)
      expect(BigInt(mintedArrival!)).toBeLessThan(BigInt(prepared.watermarkPost))
      expect(prepared.durableHeadsById.get(shard.documentId)).toEqual(h1)
      const sampled = A.getHeads(active.doc())
      await recordProjectedWatermarks(db.pool, key, [shard.documentId], '1000000')
      await recordSampledDocumentWatermark(db.pool, key, shard.documentId, sampled, () => A.getHeads(active.doc()), prepared)
      expect((await db.pool.query('SELECT projected_watermark::text AS stamp FROM read_model_document_watermarks WHERE document_id=$1', [shard.documentId])).rows[0].stamp).toBe('0')
    } finally {
      release.resolve()
      if (pending) await pending.catch(() => undefined)
      seam.withBoundedClient = originalBounded
      await repo.shutdown()
      await db.teardown()
    }
  })

  for (const content of ['repair', 'legacy', 'absent'] as const) {
    it(`an explicit refusal overwrites an old high certificate for ${content} content`, async () => {
      const db = await database(`certificate_${content}`)
      const repo = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 0 })
      let stop: (() => void) | undefined
      try {
        const shard = repo.create({ objects: { x: { id: 'x', name: 'H0', type: 'system' } } })
        const meta = repo.create({ groups: {}, objectShardUrls: [shard.url], connectionShardUrls: [] })
        const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [], diagrams: {} })
        await repo.flush()
        await db.pool.query('INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id) VALUES($1,$2,$3)',
          [shard.documentId, key.landscapeId, key.versionId])
        stop = await startReadModelProjector(repo, root.url, db.pool, key, undefined, 0)
        await awaitInitialDiagramProbe(key)
        expect((await getWorkspaceProjectionFreshness(db.pool, key)).absenceProvable).toBe(true)
        const sampled = A.getHeads(shard.doc())
        if (content === 'legacy') await db.pool.query("UPDATE automerge_storage SET arrival_seq=NULL, updated_at='2000-01-01' WHERE split_part(key,'/',1)=$1", [shard.documentId])
        if (content === 'absent') await db.pool.query("DELETE FROM automerge_storage WHERE split_part(key,'/',1)=$1", [shard.documentId])
        const prepared = await prepareDocumentWatermarkProofs(db.pool, [{ documentId: shard.documentId,
          drainPendingSaves: () => repo.storageSubsystem!.drainDocumentSaves(shard.documentId) }])
        await recordProjectedWatermarks(db.pool, key, [shard.documentId], '1000000')
        const stamp = async () => (await db.pool.query('SELECT projected_watermark::text AS stamp FROM read_model_document_watermarks WHERE document_id=$1', [shard.documentId])).rows[0].stamp
        expect(await stamp()).toBe('1000000')
        await recordSampledDocumentWatermark(db.pool, key, shard.documentId, sampled, () => null, prepared)
        expect(await stamp()).toBe('0')
        expect((await getWorkspaceProjectionFreshness(db.pool, key)).absenceProvable).toBe(false)
        if (content === 'repair') {
          await recordSampledDocumentWatermark(db.pool, key, shard.documentId, sampled, () => A.getHeads(shard.doc()), prepared)
          expect(await stamp()).toBe(prepared.watermarkPost)
          expect(BigInt(await stamp())).toBeLessThan(1000000n)
          expect((await getWorkspaceProjectionFreshness(db.pool, key)).absenceProvable).toBe(true)
        }
      } finally {
        stop?.()
        await repo.shutdown()
        await db.teardown()
      }
    })
  }

  it('durable preparation rejects a readable prefix with missing dependencies, then recovers after the missing change arrives', async () => {
    const db = await database('missing_dependencies')
    const repo = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 0 })
    try {
      const shard = repo.create({ objects: { x: { id: 'x', name: 'H0' } } })
      await repo.flush()
      const h0 = shard.doc()
      const h1 = A.change(A.clone(h0), doc => { doc.objects.x.name = 'H1' })
      const h2 = A.change(A.clone(h1), doc => { doc.objects.x.name = 'H2' })
      await db.pool.query('INSERT INTO automerge_storage(key,data) VALUES($1,$2)',
        [`${shard.documentId}/incremental/qa-h2`, Buffer.from(A.saveSince(h2, A.getHeads(h1)))])
      const targets = [{ documentId: shard.documentId, drainPendingSaves: () => repo.storageSubsystem!.drainDocumentSaves(shard.documentId) }]
      await expect(prepareDocumentWatermarkProofs(db.pool, targets)).rejects.toThrow(/incomplete durable document dependencies/)
      await db.pool.query('INSERT INTO automerge_storage(key,data) VALUES($1,$2)',
        [`${shard.documentId}/incremental/qa-h1`, Buffer.from(A.saveSince(h1, A.getHeads(h0)))])
      const prepared = await prepareDocumentWatermarkProofs(db.pool, targets)
      expect(prepared.durableHeadsById.get(shard.documentId)).toEqual(A.getHeads(h2))
    } finally {
      await repo.shutdown()
      await db.teardown()
    }
  })

  it('a transaction completing after stop invalidates an old high certificate when its handle was removed', async () => {
    const db = await database('stopped_transaction')
    const repo = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 0 })
    let stop: (() => void) | undefined
    let armed = false, intervened = false
    try {
      const shard = repo.create({ objects: { x: { id: 'x', name: 'H0', type: 'system' } } })
      const meta = repo.create({ groups: {}, objectShardUrls: [shard.url], connectionShardUrls: [] })
      const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [], diagrams: {} })
      await repo.flush()
      await db.pool.query('INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id) VALUES($1,$2,$3)',
        [shard.documentId, key.landscapeId, key.versionId])
      const instrumented = hookedPool(db.pool, async (sql, proceed) => {
        const result = await proceed()
        if (armed && !intervened && typeof sql === 'string' && sql.includes('INSERT INTO ro_objects')) {
          intervened = true
          stop!()
          await repo.removeFromCache(shard.documentId)
        }
        return result
      })
      stop = await startReadModelProjector(repo, root.url, instrumented, key, undefined, 0)
      await awaitInitialDiagramProbe(key)
      await recordProjectedWatermarks(db.pool, key, [shard.documentId], '1000000')
      armed = true
      shard.change(doc => { doc.objects.x.name = 'H1' })
      await vi.waitFor(async () => {
        expect(intervened).toBe(true)
        expect((await db.pool.query('SELECT data FROM ro_objects')).rows[0].data.name).toBe('H1')
        expect((await db.pool.query('SELECT projected_watermark::text AS stamp FROM read_model_document_watermarks WHERE document_id=$1', [shard.documentId])).rows[0].stamp).toBe('0')
      }, { timeout: 2_000, interval: 10 })
    } finally {
      stop?.()
      await repo.shutdown()
      await db.teardown()
    }
  })

  for (const holdAt of ['before-write', 'before-commit'] as const) {
    it(`an evicted H0 handle cannot certify an older handle H1 save held ${holdAt}`, async () => {
      const db = await database(`evicted_${holdAt.replace('-', '_')}`)
      const entered = deferred(), release = deferred(), coldFlush = deferred()
      let armedId: string | undefined, mintedArrival: string | undefined, firstCapture: string | undefined
      let held = false
      let repo: Repo | undefined
      let stop: (() => void) | undefined
      let starting: Promise<() => void> | undefined
      try {
        const storageDb = new Proxy(db.pool, { get(target, property) {
          if (property === 'connect') return async () => {
            const client = await target.connect()
            return new Proxy(client, { get(subject, operation) {
              if (operation === 'query') return async (sql: unknown, values?: unknown[]) => {
                if (holdAt === 'before-commit' && !held && armedId && typeof sql === 'string'
                  && sql.includes('INSERT INTO automerge_storage') && typeof values?.[0] === 'string'
                  && values[0].startsWith(`${armedId}/`)) {
                  held = true
                  await subject.query('BEGIN')
                  try {
                    const result = await subject.query(sql, values)
                    mintedArrival = (await subject.query("SELECT max(arrival_seq)::text AS arrival FROM automerge_storage WHERE split_part(key,'/',1)=$1", [armedId])).rows[0].arrival
                    entered.resolve()
                    await release.promise
                    await subject.query('COMMIT')
                    return result
                  } catch (error) { await subject.query('ROLLBACK'); throw error }
                }
                return (subject.query as (sql: unknown, values?: unknown[]) => Promise<unknown>)(sql, values)
              }
              const value = Reflect.get(subject, operation, subject)
              return typeof value === 'function' ? value.bind(subject) : value
            } })
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        } })
        const adapter = new PostgresStorageAdapter({ db: storageDb })
        const storage = new Proxy(adapter, { get(target, property) {
          if (property === 'save') return async (storageKey: string[], bytes: Uint8Array) => {
            if (holdAt === 'before-write' && !held && storageKey[0] === armedId) {
              held = true; entered.resolve(); await release.promise
            }
            return target.save(storageKey, bytes)
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        } })
        repo = new Repo({ storage, network: [], saveDebounceRate: 0 })
        const shard = repo.create({ objects: { x: { id: 'x', name: 'H0', type: 'system' } } })
        const meta = repo.create({ groups: {}, objectShardUrls: [shard.url], connectionShardUrls: [] })
        const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [], diagrams: {} })
        await repo.flush()
        await db.pool.query('INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id) VALUES($1,$2,$3)',
          [shard.documentId, key.landscapeId, key.versionId])
        armedId = shard.documentId
        shard.change(doc => { doc.objects.x.name = 'H1' })
        const h1 = A.getHeads(shard.doc())
        await entered.promise
        await repo.removeFromCache(shard.documentId)
        const active = await repo.find<{ objects: { x: { name: string } } }>(shard.url)
        expect(active).not.toBe(shard)
        expect(active.doc().objects.x.name).toBe('H0')
        await recordProjectedWatermarks(db.pool, key, [shard.documentId], '1000000')
        const controlledRepo = new Proxy(repo, { get(target, property) {
          if (property === 'flush') return (ids?: Parameters<Repo['flush']>[0]) => {
            const pending = target.flush(ids)
            coldFlush.resolve()
            return pending
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        } })
        const instrumented = hookedPool(db.pool, async (sql, proceed) => {
          const result = await proceed() as { rows: Array<{ w?: string }> }
          if (firstCapture === undefined && typeof sql === 'string' && /^\s*SELECT nextval\('automerge_arrival_seq'\)/.test(sql)) firstCapture = result.rows[0].w
          return result
        })
        starting = startReadModelProjector(controlledRepo, root.url, instrumented, key, undefined, 0)
        await coldFlush.promise
        release.resolve()
        stop = await starting
        await awaitInitialDiagramProbe(key)
        const chunks = [...await adapter.loadRange([shard.documentId, 'snapshot']), ...await adapter.loadRange([shard.documentId, 'incremental'])]
        const durable = A.load<{ objects: { x: { name: string } } }>(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data!))))
        try {
          expect(durable.objects.x.name).toBe('H1')
          expect(A.getHeads(durable)).toEqual(h1)
        } finally { A.free(durable) }
        expect((await db.pool.query('SELECT data FROM ro_objects')).rows[0].data.name).toBe('H0')
        expect(active.doc().objects.x.name).toBe('H0')
        expect((await db.pool.query('SELECT projected_watermark::text AS stamp FROM read_model_document_watermarks WHERE document_id=$1', [shard.documentId])).rows[0].stamp).toBe('0')
        expect((await getWorkspaceProjectionFreshness(db.pool, key)).absenceProvable).toBe(false)
        // Exercise the single-document recorder too: its runtime getter sees
        // stable H0, so only the independent durable H1 comparison can refuse.
        const prepared = await prepareDocumentWatermarkProofs(db.pool, [{ documentId: shard.documentId,
          drainPendingSaves: () => repo!.storageSubsystem!.drainDocumentSaves(shard.documentId) }])
        await recordProjectedWatermarks(db.pool, key, [shard.documentId], '1000000')
        await recordSampledDocumentWatermark(db.pool, key, shard.documentId, A.getHeads(active.doc()), () => A.getHeads(active.doc()), prepared)
        expect((await db.pool.query('SELECT projected_watermark::text AS stamp FROM read_model_document_watermarks WHERE document_id=$1', [shard.documentId])).rows[0].stamp).toBe('0')
        if (holdAt === 'before-commit') expect(BigInt(mintedArrival!)).toBeLessThan(BigInt(firstCapture!))
      } finally {
        release.resolve()
        if (!stop && starting) stop = await starting.catch(() => undefined)
        stop?.()
        if (repo) await repo.shutdown()
        await db.teardown()
      }
    })
  }

  it('a shared object/connection document must cover every extraction before upgrading its cold stamp', async () => {
    const db = await database('shared_collection_alias')
    const repo = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 0 })
    let stop: (() => void) | undefined
    try {
      const shared = repo.create({ objects: { o: { id: 'o', name: 'H0', type: 'system' } },
        connections: { c: { id: 'c', fromId: 'o', toId: 'other', label: 'link' } } })
      const meta = repo.create({ groups: {}, objectShardUrls: [shared.url], connectionShardUrls: [shared.url] })
      const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [], diagrams: {} })
      await repo.flush()
      await db.pool.query('INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id) VALUES($1,$2,$3)',
        [shared.documentId, key.landscapeId, key.versionId])
      let sharedResolutions = 0
      let movedBetweenCollections = false
      const controlledRepo = new Proxy(repo, { get(target, property) {
        if (property === 'find') return async (...args: Parameters<Repo['find']>) => {
          if (args[0] === shared.url && ++sharedResolutions === 2) {
            // Object extraction already holds immutable H0; connection
            // extraction will receive H1 from the same document identity.
            shared.change(doc => { doc.objects.o.name = 'H1' })
            await repo.flush([shared.documentId])
            movedBetweenCollections = true
          }
          return target.find(...args)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      let coldPre: string | undefined
      const stamps: string[] = []
      let coldClaimed = false
      const controlledPool = hookedPool(db.pool, async (sql, proceed, values) => {
        if (typeof sql === 'string' && sql.includes('write_fence = EXCLUDED.write_fence')) coldClaimed = true
        const result = await proceed() as { rows: Array<{ w?: string }> }
        if (coldPre === undefined && typeof sql === 'string' && /^\s*SELECT nextval\('automerge_arrival_seq'\)/.test(sql)) coldPre = result.rows[0].w
        if (!coldClaimed && typeof sql === 'string' && sql.includes('INSERT INTO read_model_document_watermarks')
          && (values?.[2] as string[] | undefined)?.includes(shared.documentId)) stamps.push(values![3] as string)
        return result
      })
      stop = await startReadModelProjector(controlledRepo, root.url, controlledPool, key, undefined, 0)
      await awaitInitialDiagramProbe(key)
      expect(movedBetweenCollections).toBe(true)
      expect(stamps.length).toBeGreaterThan(0)
      expect(stamps.reduce((a, b) => BigInt(a) > BigInt(b) ? a : b)).toBe('0')
      await vi.waitFor(async () => {
        const row = await db.pool.query('SELECT data FROM ro_objects WHERE landscape_id=$1 AND version_id=$2 AND id=$3', [key.landscapeId, key.versionId, 'o'])
        expect(row.rows[0]?.data.name).toBe('H1')
        // Both collection snapshots belong to this ID. A single collection
        // delta cannot certify the other's extraction or catch-up state.
        expect((await getWorkspaceProjectionFreshness(db.pool, key)).absenceProvable).toBe(false)
      }, { timeout: 2_000, interval: 10 })
    } finally {
      stop?.()
      await repo.shutdown()
      await db.teardown()
    }
  })

  it('a repeated URL cannot certify earlier extraction content using only the last occurrence heads', async () => {
    const db = await database('repeated_url')
    const repo = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 0 })
    let stop: (() => void) | undefined
    try {
      const shared = repo.create({ objects: { x: { id: 'x', name: 'H0', type: 'system' } } })
      const meta = repo.create({ groups: {}, objectShardUrls: [shared.url, shared.url], connectionShardUrls: [] })
      const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [], diagrams: {} })
      await repo.flush()
      await db.pool.query('INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id) VALUES($1,$2,$3)',
        [shared.documentId, key.landscapeId, key.versionId])
      let resolutions = 0
      const controlledRepo = new Proxy(repo, { get(target, property) {
        if (property === 'find') return async (...args: Parameters<Repo['find']>) => {
          if (args[0] === shared.url && ++resolutions === 2) {
            shared.change(doc => { delete doc.objects.x })
            await repo.flush([shared.documentId])
          }
          return target.find(...args)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      let coldPre: string | undefined
      let coldClaimed = false
      const coldStamps: string[] = []
      const controlledPool = hookedPool(db.pool, async (sql, proceed, values) => {
        if (typeof sql === 'string' && sql.includes('write_fence = EXCLUDED.write_fence')) coldClaimed = true
        const result = await proceed() as { rows: Array<{ w?: string }> }
        if (coldPre === undefined && typeof sql === 'string' && /^\s*SELECT nextval\('automerge_arrival_seq'\)/.test(sql)) coldPre = result.rows[0].w
        if (!coldClaimed && typeof sql === 'string' && sql.includes('INSERT INTO read_model_document_watermarks')
          && (values?.[2] as string[] | undefined)?.includes(shared.documentId)) coldStamps.push(values![3] as string)
        return result
      })
      stop = await startReadModelProjector(controlledRepo, root.url, controlledPool, key, undefined, 0)
      await awaitInitialDiagramProbe(key)
      expect(resolutions).toBeGreaterThanOrEqual(2)
      expect(shared.doc().objects).toEqual({})
      // Existing extraction folds the first occurrence into the global rows,
      // while headsByUrl retains only the final occurrence. The witness must
      // decline proof of that mixture; this test does not repair the old fold.
      expect((await db.pool.query('SELECT id FROM ro_objects')).rows).toEqual([{ id: 'x' }])
      expect(coldStamps.length).toBeGreaterThan(0)
      expect(coldStamps.reduce((a, b) => BigInt(a) > BigInt(b) ? a : b)).toBe('0')
      const arrival = await db.pool.query("SELECT max(arrival_seq)::text AS arrival FROM automerge_storage WHERE split_part(key,'/',1)=$1", [shared.documentId])
      expect(BigInt(arrival.rows[0].arrival)).toBeGreaterThan(0n)
      expect((await getWorkspaceProjectionFreshness(db.pool, key)).absenceProvable).toBe(false)
      shared.change(doc => { Object.assign(doc.objects, { y: { id: 'y', name: 'H2', type: 'system' } }) })
      await vi.waitFor(async () => {
        const rows = await db.pool.query('SELECT id FROM ro_objects ORDER BY id')
        expect(rows.rows).toEqual([{ id: 'x' }, { id: 'y' }])
        const freshness = await getWorkspaceProjectionFreshness(db.pool, key)
        expect(freshness.projectedGeneration).toBeGreaterThanOrEqual(3)
        expect(freshness.caughtUp).toBe(true)
        expect(freshness.absenceProvable).toBe(false)
      }, { timeout: 2_000, interval: 10 })
      // Removing the duplicate reference does not repair the phantom x left
      // by the previous extraction in this same projector lifetime.
      meta.change(doc => { doc.objectShardUrls = [shared.url] })
      shared.change(doc => { (doc.objects as Record<string, { name: string }>).y.name = 'H3' })
      await vi.waitFor(async () => {
        const rows = await db.pool.query('SELECT id,data FROM ro_objects ORDER BY id')
        expect(rows.rows.map(row => row.id)).toEqual(['x', 'y'])
        expect(rows.rows[1].data.name).toBe('H3')
        const freshness = await getWorkspaceProjectionFreshness(db.pool, key)
        expect(freshness.caughtUp).toBe(true)
        expect(freshness.absenceProvable).toBe(false)
      }, { timeout: 2_000, interval: 10 })
    } finally {
      stop?.()
      await repo.shutdown()
      await db.teardown()
    }
  })

  it('cold flush waits for an already-running autosave before claiming its arrival watermark', async () => {
    const db = await database('pending_autosave')
    const gate = deferred(), entered = deferred(), projectorFlush = deferred(), secondSaveCompleted = deferred()
    let armedId: string | undefined
    let startedSaves = 0
    let finishedSaves = 0
    let flushSettled = false
    let repo: Repo | undefined
    let stop: (() => void) | undefined
    let starting: Promise<() => void> | undefined
    try {
      const adapter = new PostgresStorageAdapter({ db: db.pool })
      const storage = new Proxy(adapter, { get(target, property) {
        if (property === 'save') return async (storageKey: string[], bytes: Uint8Array) => {
          if (storageKey[0] !== armedId) return target.save(storageKey, bytes)
          const ordinal = ++startedSaves
          if (ordinal === 1) { entered.resolve(); await gate.promise }
          await target.save(storageKey, bytes)
          finishedSaves++
          if (ordinal === 2) secondSaveCompleted.resolve()
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      repo = new Repo({ storage, network: [], saveDebounceRate: 0 })
      const shard = repo.create({ objects: { x: { id: 'x', name: 'H0', type: 'system' } } })
      const meta = repo.create({ groups: {}, objectShardUrls: [shard.url], connectionShardUrls: [] })
      const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [], diagrams: {} })
      await repo.flush()
      await db.pool.query('INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id) VALUES($1,$2,$3)',
        [shard.documentId, key.landscapeId, key.versionId])
      armedId = shard.documentId
      shard.change(doc => { doc.objects.x.name = 'H1' })
      await entered.promise
      const heads = A.getHeads(shard.doc())
      const controlledRepo = new Proxy(repo, { get(target, property) {
        if (property === 'flush') return (ids?: Parameters<Repo['flush']>[0]) => {
          const flushing = target.flush(ids)
          void flushing.then(() => { flushSettled = true }, () => { flushSettled = true })
          projectorFlush.resolve()
          return flushing
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      starting = startReadModelProjector(controlledRepo, root.url, db.pool, key, undefined, 0)
      await projectorFlush.promise
      await secondSaveCompleted.promise
      // Both writes are admitted immediately. Only the second has completed;
      // the explicit flush must also drain the earlier autosave before its
      // caller can claim a watermark. A loop turn drains promise continuations
      // without using a performance deadline as the correctness oracle.
      await eventLoopTurn()
      expect(startedSaves).toBe(2)
      expect(finishedSaves).toBe(1)
      expect(flushSettled).toBe(false)
      gate.resolve()
      stop = await starting
      await awaitInitialDiagramProbe(key)
      expect(finishedSaves).toBe(2)
      expect(A.getHeads(shard.doc())).toEqual(heads)
      expect((await db.pool.query('SELECT data FROM ro_objects')).rows[0].data.name).toBe('H1')
      expect((await getWorkspaceProjectionFreshness(db.pool, key)).absenceProvable).toBe(true)
    } finally {
      gate.resolve()
      if (!stop && starting) stop = await starting.catch(() => undefined)
      stop?.()
      if (repo) await repo.shutdown()
      await db.teardown()
    }
  })

  for (const collection of ['objects', 'connections'] as const) {
    for (const interleave of [false, true]) it(`${collection}: a shard added in-session ${interleave ? 'catches an edit during its initial apply before subscription' : 'certifies its stable initial contents'}`, async () => {
      const db = await database(`${collection}_new_shard_${interleave ? 'race' : 'control'}`)
      const repo = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 0 })
      let stop: (() => void) | undefined
      try {
        const shard = repo.create({
          [collection]: { entity: collection === 'objects'
            ? { id: 'entity', name: 'H1', type: 'system' }
            : { id: 'entity', fromId: 'a', toId: 'b', label: 'H1' } },
          writeBatchIds: ['qa-new-shard-batch'],
        })
        const meta = repo.create({ groups: {}, objectShardUrls: [] as string[], connectionShardUrls: [] as string[] })
        const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [], diagrams: {} })
        await repo.flush()
        let intervened = false
        const instrumented = hookedPool(db.pool, async (sql, proceed) => {
          if (interleave && !intervened && typeof sql === 'string' && sql.includes('INSERT INTO read_model_overlay_batch_acks')) {
            intervened = true
            expect(shard.listenerCount('change')).toBe(0)
            shard.change(doc => {
              if (collection === 'objects') doc[collection].entity.name = 'H2'
              else doc[collection].entity.label = 'H2'
            })
            await repo.flush([shard.documentId])
          }
          return proceed()
        })
        stop = await startReadModelProjector(repo, root.url, instrumented, key, undefined, 0)
        await awaitInitialDiagramProbe(key)
        await db.pool.query('INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id) VALUES($1,$2,$3)',
          [shard.documentId, key.landscapeId, key.versionId])
        meta.change(doc => {
          if (collection === 'objects') doc.objectShardUrls.push(shard.url)
          else doc.connectionShardUrls.push(shard.url)
        })
        await vi.waitFor(async () => {
          expect(intervened).toBe(interleave)
          const rows = await db.pool.query(`SELECT data FROM ro_${collection}`)
          expect(rows.rows[0]?.data[collection === 'objects' ? 'name' : 'label']).toBe(interleave ? 'H2' : 'H1')
          expect(shard.listenerCount('change')).toBe(1)
          expect((await getWorkspaceProjectionFreshness(db.pool, key)).absenceProvable).toBe(true)
        }, { timeout: 2_000, interval: 10 })
      } finally {
        stop?.()
        await repo.shutdown()
        await db.teardown()
      }
    })

    for (const mode of ['stable', 'cold-arrival', 'attach-arrival'] as const) {
      it(`${collection}: ${mode} becomes provable without a future edit`, async () => {
        const db = await database(`${collection}_${mode.replace('-', '_')}`)
        let repo: Repo | undefined
        let stop: (() => void) | undefined
        const saveGate = deferred()
        const saveEntered = deferred()
        let blockedDocument: string | null = null
        let heldSaves = 0
        try {
          const adapter = new PostgresStorageAdapter({ db: db.pool })
          const storage = new Proxy(adapter, { get(target, property) {
            if (property === 'save') return async (storageKey: string[], data: Uint8Array) => {
              if (storageKey[0] === blockedDocument) { heldSaves++; saveEntered.resolve(); await saveGate.promise }
              return target.save(storageKey, data)
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          } })
          repo = new Repo({ storage, network: [], saveDebounceRate: 0 })
          const shard = repo.create({
            [collection]: { entity: collection === 'objects'
              ? { id: 'entity', name: 'H0', type: 'system' }
              : { id: 'entity', fromId: 'a', toId: 'b', label: 'H0' } },
            writeBatchIds: ['qa-attach-batch'],
          })
          const setValue = (value: string) => shard.change(doc => {
            if (collection === 'objects') doc[collection].entity.name = value
            else doc[collection].entity.label = value
          })
          const meta = repo.create({ groups: {}, objectShardUrls: collection === 'objects' ? [shard.url] : [],
            connectionShardUrls: collection === 'connections' ? [shard.url] : [] })
          const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [], diagrams: {} })
          await repo.flush()
          await db.pool.query('INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id) VALUES($1,$2,$3)',
            [shard.documentId, key.landscapeId, key.versionId])
          if (mode === 'cold-arrival') blockedDocument = shard.documentId
          setValue('H1')
          if (mode !== 'cold-arrival') await repo.flush([shard.documentId])
          else await saveEntered.promise
          let coldCapture: string | undefined
          let attachArrived = false
          let headsBeforeAttachArrival: string[] | undefined
          const instrumented = hookedPool(db.pool, async (sql, proceed) => {
            if (mode === 'attach-arrival' && !attachArrived && typeof sql === 'string'
              && sql.includes('INSERT INTO read_model_overlay_batch_acks')) {
              attachArrived = true
              expect(shard.listenerCount('change')).toBe(0)
              headsBeforeAttachArrival = A.getHeads(shard.doc())
              setValue('H2')
              await repo!.flush([shard.documentId])
            }
            const result = await proceed() as { rows: Array<{ w?: string }> }
            if (coldCapture === undefined && typeof sql === 'string' && /^\s*SELECT nextval\('automerge_arrival_seq'\)/.test(sql)) {
              coldCapture = result.rows[0].w
              if (mode === 'cold-arrival') { saveGate.resolve(); await repo!.flush([shard.documentId]) }
            }
            return result
          })
          const controlledRepo = new Proxy(repo, { get(target, property) {
            if (property === 'flush') return (ids?: Parameters<Repo['flush']>[0]) => {
              if (mode === 'cold-arrival') saveGate.resolve()
              return target.flush(ids)
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          } })
          stop = await startReadModelProjector(controlledRepo, root.url, instrumented, key, undefined, 0)
          await awaitInitialDiagramProbe(key)
          if (mode === 'cold-arrival') expect(heldSaves).toBeGreaterThan(0)
          if (mode === 'attach-arrival') {
            expect(attachArrived).toBe(true)
            expect(A.getHeads(shard.doc())).not.toEqual(headsBeforeAttachArrival)
          }
          const expected = mode === 'attach-arrival' ? 'H2' : 'H1'
          await vi.waitFor(async () => {
            const row = await db.pool.query(`SELECT data FROM ro_${collection} WHERE landscape_id=$1 AND version_id=$2 AND id='entity'`, [key.landscapeId, key.versionId])
            expect(row.rows).toHaveLength(1)
            expect(row.rows[0].data[collection === 'objects' ? 'name' : 'label']).toBe(expected)
            const freshness = await getWorkspaceProjectionFreshness(db.pool, key)
            expect(freshness.status).toBe('healthy')
            expect(freshness.caughtUp).toBe(true)
            expect(freshness.absenceProvable).toBe(true)
          }, { timeout: 2_000, interval: 10 })
          expect(shard.listenerCount('change')).toBe(1)
        } finally {
          saveGate.resolve()
          stop?.()
          if (repo) await repo.shutdown()
          await db.teardown()
        }
      })
    }
  }

  for (const interleave of [false, true]) {
    it(`post-capture heads getter ${interleave ? 'rejects an intervening durable arrival' : 'upgrades a stable sample'}`, async () => {
      const db = await database(interleave ? 'post_race' : 'post_control')
      const repo = new Repo({ storage: new PostgresStorageAdapter({ db: db.pool }), network: [], saveDebounceRate: 0 })
      try {
        const handle = repo.create({ objects: { entity: { id: 'entity', name: 'H0' } } })
        await repo.flush()
        const sampled = A.getHeads(handle.doc())
        let captureCompleted = false
        let getterCalls = 0
        let injected = false
        const instrumented = hookedPool(db.pool, async (sql, proceed) => {
          if (typeof sql === 'string' && /^\s*SELECT nextval\('automerge_arrival_seq'\)/.test(sql)) {
            if (interleave && !injected) {
              injected = true
              handle.change(doc => { doc.objects.entity.name = 'unprojected-H1' })
              await repo.flush([handle.documentId])
            }
            const result = await proceed()
            captureCompleted = true
            return result
          }
          return proceed()
        })
        const prepared = await prepareDocumentWatermarkProofs(instrumented, [{ documentId: handle.documentId,
          drainPendingSaves: () => repo.storageSubsystem!.drainDocumentSaves(handle.documentId) }])
        await recordSampledDocumentWatermark(db.pool, key, handle.documentId, sampled, () => {
          getterCalls++
          expect(captureCompleted).toBe(true)
          return A.getHeads(handle.doc())
        }, prepared)
        expect(getterCalls).toBe(1)
        const row = await db.pool.query('SELECT projected_watermark::text FROM read_model_document_watermarks WHERE landscape_id=$1 AND version_id=$2 AND document_id=$3',
          [key.landscapeId, key.versionId, handle.documentId])
        expect(row.rows).toHaveLength(1)
        if (interleave) {
          expect(injected).toBe(true)
          expect(row.rows[0].projected_watermark).toBe('0')
        } else expect(row.rows[0].projected_watermark).toBe(prepared.watermarkPost)
      } finally {
        await repo.shutdown()
        await db.teardown()
      }
    })
  }
})
