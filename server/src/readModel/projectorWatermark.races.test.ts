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
import { absenceProofMetricSamples, getWorkspaceProjectionFreshness, resetAbsenceProofForTest } from './health.js'
import { markStaticEntryWatermarks, prepareDocumentWatermarkProofs, recordProjectedWatermarks, recordSampledDocumentWatermark } from './arrivalWatermark.js'
import { durabilityWitnessPayload } from './queries.js'
import { startReadModelProjector, awaitInitialDiagramProbe, awaitAdoptStamps } from './projectorService.js'

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

  /**
   * T-SUM-2c, the defect as measured on a stack: on
   * the ordinary plane, the Repo's save of the ModelMeta revision a metadata
   * pass had just projected landed 1-3 ms AFTER that pass's
   * `last_projected_at`. ModelMeta has no `read_model_document_watermarks`
   * row there, so the clause fell to its timestamp, and refused until the
   * next pass of any kind — on a quiet workspace, until somebody wrote. Built
   * here by holding that save until the pass has committed. The deferred
   * adopt stamp of the pass then certifies the revision (durable = sampled =
   * live), and that certificate is what must cover it, with no further write
   * and no further pass. The stale detector reads the same input, so its
   * grace is shortened to show it is not the next thing to refuse.
   */
  it('T-SUM-2c: a ModelMeta revision saved after the pass that projected it is provable without a future edit, and an arrival no pass projected is not', async () => {
    const db = await database('control_saved_after_pass')
    const saveGate = deferred(), saveEntered = deferred()
    let blockedDocument: string | null = null
    let repo: Repo | undefined
    let stop: (() => void) | undefined
    const grace = process.env.READ_MODEL_STALE_GRACE_MS
    process.env.READ_MODEL_STALE_GRACE_MS = '200'
    try {
      const adapter = new PostgresStorageAdapter({ db: db.pool })
      const storage = new Proxy(adapter, { get(target, property) {
        if (property === 'save') return async (storageKey: string[], data: Uint8Array) => {
          if (storageKey[0] === blockedDocument) { saveEntered.resolve(); await saveGate.promise }
          return target.save(storageKey, data)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      repo = new Repo({ storage, network: [], saveDebounceRate: 0 })
      const shard = repo.create({ objects: { x: { id: 'x', name: 'X', type: 'system' } } })
      const meta = repo.create({ groups: {} as Record<string, { id: string; name: string; objectIds: string[] }>,
        objectShardUrls: [shard.url], connectionShardUrls: [] as string[] })
      const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [], diagrams: {} })
      await repo.flush()
      for (const handle of [shard, meta, root]) {
        await db.pool.query('INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id) VALUES($1,$2,$3)',
          [handle.documentId, key.landscapeId, key.versionId])
      }
      stop = await startReadModelProjector(repo, root.url, db.pool, key, undefined, 0)
      await awaitInitialDiagramProbe(key)
      await awaitAdoptStamps(key)
      const state = async () => (await db.pool.query<{ generation: string; kind: string; projected_at: Date }>(
        `SELECT projected_generation::text AS generation, last_projection_kind AS kind, last_projected_at AS projected_at
           FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`, [key.landscapeId, key.versionId])).rows[0]
      await vi.waitFor(async () => expect((await getWorkspaceProjectionFreshness(db.pool, key)).absenceProvable).toBe(true),
        { timeout: 2_000, interval: 10 })

      // ModelMeta moves; its save is held until the pass projecting it committed.
      blockedDocument = meta.documentId
      meta.change((doc) => { doc.groups.g = { id: 'g', name: 'G', objectIds: [] } })
      await saveEntered.promise
      await vi.waitFor(async () => {
        expect((await db.pool.query(`SELECT id FROM ro_groups WHERE landscape_id = $1 AND version_id = $2`,
          [key.landscapeId, key.versionId])).rows.map((row) => row.id)).toEqual(['g'])
        expect((await state()).kind).toBe('metadata')
      }, { timeout: 2_000, interval: 10 })
      const pass = await state()
      blockedDocument = null
      saveGate.resolve()
      // The construction, checked: ModelMeta's newest write is now AFTER the
      // pass that projected it, and above any certificate it had.
      await vi.waitFor(async () => {
        const { rows } = await db.pool.query<{ after: boolean }>(
          `SELECT max(updated_at) > $2::timestamptz AS after FROM automerge_storage
            WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) <> 'sync-state'`,
          [meta.documentId, pass.projected_at])
        expect(rows[0].after).toBe(true)
      }, { timeout: 2_000, interval: 10 })
      await awaitAdoptStamps(key)
      // Past the (shortened) stale grace, with no write and no pass.
      await new Promise((resolve) => setTimeout(resolve, 400))
      await vi.waitFor(async () => {
        const freshness = await getWorkspaceProjectionFreshness(db.pool, key)
        expect(freshness.status).toBe('healthy')
        expect(freshness.arrivalRefusals).toEqual({ zero: 0, exact: 0, fallback: 0, sample: [] })
        expect(freshness.absenceProvable).toBe(true)
      }, { timeout: 3_000, interval: 25 })
      // Nothing moved the timestamp either: the lift is the adopt certificate's.
      const after = await state()
      expect(after.generation, 'no pass ran after the metadata pass').toBe(pass.generation)
      expect(after.projected_at.getTime(), 'last_projected_at did not move').toBe(pass.projected_at.getTime())

      // An arrival NO pass projected (a raw chunk behind the Repo's back) is
      // above the adopt certificate and after the last pass: refused, named.
      await db.pool.query(`INSERT INTO automerge_storage (key, data) VALUES ($1, $2)`,
        [`${meta.documentId}/incremental/t-sum-2c-unprojected`, Buffer.from([1, 2, 3])])
      const refused = await getWorkspaceProjectionFreshness(db.pool, key)
      expect(refused.absenceProvable).toBe(false)
      expect(refused.arrivalRefusals?.fallback).toBe(1)
      expect(refused.arrivalRefusals?.sample).toEqual([expect.stringMatching(new RegExp(`^${meta.documentId}:fallback:\\d+$`))])
    } finally {
      if (grace === undefined) delete process.env.READ_MODEL_STALE_GRACE_MS
      else process.env.READ_MODEL_STALE_GRACE_MS = grace
      saveGate.resolve()
      stop?.()
      if (repo) await repo.shutdown()
      await db.teardown()
    }
  })

  /**
   * T-SUM-2c, the COLD BUILD half (the scheduling after a cold build had no
   * test). A compaction's re-attach is a cold build. Built here: a
   * ModelMeta revision whose save is still held when the cold build samples
   * it, and the cold build's adopt preparation failing (its flush throws
   * once), so the build stamps ModelMeta 0. The held save then lands AFTER
   * the build's `last_projected_at`, so the timestamp refuses it, and no
   * pass follows (the change fired before any watcher existed). Only the
   * deferred stamp the cold build schedules can certify that revision.
   */
  it('T-SUM-2c: a control document the cold build could not certify is certified by the stamp it schedules, with no pass', async () => {
    const db = await database('control_cold_build_uncertified')
    const saveGate = deferred(), saveEntered = deferred()
    let blockedDocument: string | null = null
    let repo: Repo | undefined
    let stop: (() => void) | undefined
    let injected = 0
    try {
      const adapter = new PostgresStorageAdapter({ db: db.pool })
      const storage = new Proxy(adapter, { get(target, property) {
        if (property === 'save') return async (storageKey: string[], data: Uint8Array) => {
          if (storageKey[0] === blockedDocument) { saveEntered.resolve(); await saveGate.promise }
          return target.save(storageKey, data)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      repo = new Repo({ storage, network: [], saveDebounceRate: 0 })
      const shard = repo.create({ objects: { x: { id: 'x', name: 'X', type: 'system' } } })
      const meta = repo.create({ groups: {} as Record<string, { id: string; name: string; objectIds: string[] }>,
        objectShardUrls: [shard.url], connectionShardUrls: [] as string[] })
      const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [], diagrams: {} })
      await repo.flush()
      for (const handle of [shard, meta, root]) {
        await db.pool.query('INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id) VALUES($1,$2,$3)',
          [handle.documentId, key.landscapeId, key.versionId])
      }
      // A ModelMeta revision whose save is held, before any projector exists.
      blockedDocument = meta.documentId
      meta.change((doc) => { doc.groups.g = { id: 'g', name: 'G', objectIds: [] } })
      await saveEntered.promise
      // The cold build's ADOPT preparation flushes the control documents
      // first: that flush throws once (`prepareAdoptWatermarks` then stamps
      // every control document 0). Any other flush passes through.
      const controlledRepo = new Proxy(repo, { get(target, property) {
        if (property === 'flush') return (ids?: Parameters<Repo['flush']>[0]) => {
          if (injected === 0 && ids?.includes(meta.documentId)) {
            injected += 1
            return Promise.reject(new Error('T-SUM-2c: injected adopt-preparation failure'))
          }
          return target.flush(ids)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      stop = await startReadModelProjector(controlledRepo, root.url, db.pool, key, undefined, 0)
      await awaitInitialDiagramProbe(key)
      const state = async () => (await db.pool.query<{ generation: string; projected_at: Date }>(
        `SELECT projected_generation::text AS generation, last_projected_at AS projected_at
           FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`, [key.landscapeId, key.versionId])).rows[0]
      const adoptOf = async (id: string) => (await db.pool.query<{ w: string }>(
        `SELECT adopt_watermark::text AS w FROM read_model_adopt_watermarks WHERE document_id = $1`, [id])).rows[0]?.w ?? null
      // The construction, checked: the failure was injected, the build left
      // ModelMeta at 0, and its group is in the rows (the build sampled it).
      expect(injected).toBe(1)
      expect(await adoptOf(meta.documentId)).toBe('0')
      expect((await db.pool.query(`SELECT id FROM ro_groups`)).rows.map((row) => row.id)).toEqual(['g'])
      const built = await state()
      blockedDocument = null
      saveGate.resolve()
      await vi.waitFor(async () => {
        const { rows } = await db.pool.query<{ after: boolean }>(
          `SELECT max(updated_at) > $2::timestamptz AS after FROM automerge_storage
            WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) <> 'sync-state'`,
          [meta.documentId, built.projected_at])
        expect(rows[0].after, 'the held ModelMeta save landed after the cold build').toBe(true)
      }, { timeout: 2_000, interval: 10 })
      await awaitAdoptStamps(key)
      await vi.waitFor(async () => {
        const freshness = await getWorkspaceProjectionFreshness(db.pool, key)
        expect(freshness.arrivalRefusals, 'nothing refuses the proof').toEqual({ zero: 0, exact: 0, fallback: 0, sample: [] })
        expect(freshness.absenceProvable).toBe(true)
        expect(Number(await adoptOf(meta.documentId)), 'the scheduled stamp certified ModelMeta').toBeGreaterThan(0)
      }, { timeout: 3_000, interval: 25 })
      const after = await state()
      expect(after.generation, 'no pass ran after the cold build').toBe(built.generation)
      expect(after.projected_at.getTime(), 'last_projected_at did not move').toBe(built.projected_at.getTime())
    } finally {
      saveGate.resolve()
      stop?.()
      if (repo) await repo.shutdown()
      await db.teardown()
    }
  })

  it('T-SUM-2c: the adopt branch never lifts an explicit refusal or an exact certificate below the arrival, and reads an adopt 0 as no evidence', async () => {
    const db = await database('control_adopt_branch_order')
    try {
      await db.pool.query(`INSERT INTO read_model_projection_state
          (landscape_id, version_id, observed_generation, projected_generation, last_projected_at, projector_attached)
        VALUES ($1, $2, 1, 1, now() - interval '1 hour', true)`, [key.landscapeId, key.versionId])
      await db.pool.query('INSERT INTO automerge_document_workspace(document_id,landscape_id,version_id) VALUES($1,$2,$3)',
        ['doc', key.landscapeId, key.versionId])
      // One arrival, AFTER the last completed projection: the timestamp
      // refuses. Far from 0, so "below it" is a positive certificate.
      await db.pool.query(`SELECT setval('automerge_arrival_seq', 100)`)
      const { rows } = await db.pool.query<{ seq: string }>(
        `INSERT INTO automerge_storage (key, data) VALUES ('doc/incremental/a', '\\x01') RETURNING arrival_seq::text AS seq`)
      const seq = BigInt(rows[0].seq)
      const set = async (watermark: string | null, adopt: string | null) => {
        await db.pool.query('DELETE FROM read_model_document_watermarks')
        await db.pool.query('DELETE FROM read_model_adopt_watermarks')
        if (watermark !== null) await db.pool.query(`INSERT INTO read_model_document_watermarks (landscape_id, version_id, document_id, projected_watermark)
          VALUES ($1, $2, 'doc', $3)`, [key.landscapeId, key.versionId, watermark])
        if (adopt !== null) await db.pool.query(`INSERT INTO read_model_adopt_watermarks (landscape_id, version_id, document_id, adopt_watermark)
          VALUES ($1, $2, 'doc', $3)`, [key.landscapeId, key.versionId, adopt])
        return getWorkspaceProjectionFreshness(db.pool, key)
      }
      const covering = String(seq + 5n)
      const below = String(seq - 1n)
      expect((await set(null, null)).arrivalRefusals?.fallback, 'the control: no certificate, the timestamp refuses').toBe(1)
      expect((await set(null, covering)).absenceProvable, 'an adopt certificate covering the arrival').toBe(true)
      expect((await set(null, below)).arrivalRefusals?.fallback, 'an adopt certificate below the arrival: the timestamp decides').toBe(1)
      expect((await set(null, '0')).arrivalRefusals?.fallback, 'an adopt 0 is no evidence: the timestamp decides').toBe(1)
      expect((await set('0', covering)).arrivalRefusals?.zero, 'an explicit refusal wins over any adopt certificate').toBe(1)
      expect((await set(below, covering)).arrivalRefusals?.exact, 'an exact certificate below the arrival wins too').toBe(1)
      expect((await set(covering, null)).absenceProvable, 'the exact branch, unchanged').toBe(true)
      expect((await set(below, covering)).arrivalRefusals?.sample, 'the sample names the refusing branch')
        .toEqual([`doc:exact:${rows[0].seq}`])

      // The stale detector leaves out ONLY what a certificate covers: past a
      // (shortened) grace, a refused document still reads stale.
      const grace = process.env.READ_MODEL_STALE_GRACE_MS
      process.env.READ_MODEL_STALE_GRACE_MS = '1'
      try {
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect((await set(below, covering)).status, 'exact certificate below the arrival').toBe('stale')
        expect((await set('0', covering)).status, 'explicit refusal').toBe('stale')
        expect((await set(null, null)).status, 'no certificate at all').toBe('stale')
        expect((await set(null, covering)).status, 'covered by the adopt certificate').toBe('healthy')
        expect((await set(covering, null)).status, 'covered by the exact certificate').toBe('healthy')
      } finally {
        if (grace === undefined) delete process.env.READ_MODEL_STALE_GRACE_MS
        else process.env.READ_MODEL_STALE_GRACE_MS = grace
      }

      // The witness itself counts a caught-up refusal (`noteAbsenceProof`).
      resetAbsenceProofForTest()
      await set(null, null)
      await durabilityWitnessPayload(db.pool, key, ['x'], [])
      const counted = absenceProofMetricSamples().find((metric) => metric.name === 'maplespire_read_model_absence_unprovable_total')!
      expect(counted.values.find((value) => value.labels?.branch === 'fallback')?.value).toBe(1)

      // The static entry mark (promotion) turns an adopt-only coverage into an
      // exact certificate at the newest arrival, and nothing else.
      for (const [adopt, stamped] of [[below, null], ['0', null], [covering, rows[0].seq]] as const) {
        await set(null, adopt)
        const client = await db.pool.connect()
        try {
          await client.query('BEGIN')
          await client.query(`INSERT INTO read_model_static_workspaces (landscape_id, version_id, source) VALUES ($1, $2, 'test')`,
            [key.landscapeId, key.versionId])
          await client.query(`INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)
            VALUES ($1, $2, 'doc', 'model-meta')`, [key.landscapeId, key.versionId])
          await markStaticEntryWatermarks(client, key)
          const mark = await client.query<{ w: string }>(
            `SELECT projected_watermark::text AS w FROM read_model_document_watermarks WHERE document_id = 'doc'`)
          expect(mark.rows[0]?.w ?? null, `adopt ${adopt}`).toBe(stamped)
        } finally {
          await client.query('ROLLBACK')
          client.release()
        }
      }
    } finally {
      resetAbsenceProofForTest()
      await db.teardown()
    }
  })
})
