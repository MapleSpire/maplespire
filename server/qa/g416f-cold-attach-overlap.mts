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

/**
 * G4-16f cold-attach reductions:
 * the cold build's DECODE + ROW WRITES at an object count the aged-corpus
 * harness cannot reach in reasonable time (119 000 objects, ~3 years at the
 * rate of the day-250 corpus), serial or overlapped (P4, a streamed cold
 * build that overlapped decode and row writes).
 *
 *   cd server
 *   G416F_PG_URL=… npx tsx qa/g416f-cold-attach-overlap.mts --database <snapshot copy> \
 *     --manifest <dir>/<label>.manifest.json --objects 119000 \
 *     --mode serial|stream --samples 3 --out <json>
 *
 * On a COPY of an aged snapshot (its read model built; nothing else written):
 *  - the DECODE is real: the bytes of the snapshot's ModelMeta-listed object
 *    shards, assembled as the patched `StorageSubsystem.loadDoc` does
 *    (snapshot chunks then incremental) and read from storage per shard
 *    inside the timer (`--storage-read off`: fetched once, untimed), then
 *    `A.load` + a read of every entity of the `objects` map per shard, one
 *    shard at a time on this thread with a yield between two
 *    (`resolveCooperatively`), as the cold build reads them. To stand
 *    for `--objects`, the shard list is decoded `objects / corpus objects`
 *    times over (a decode of ~3.3 corpora for 119 000), each pass a
 *    "virtual" shard list;
 *  - the ROWS are the corpus's objects as `ro_objects.data` holds them,
 *    extended to `--objects` by copies with fresh ids (`<id>~<k>`) and their
 *    hex tokens redrawn at the same lengths (as an earlier throwaway
 *    row-write prototype did),
 *    prepared untimed and split evenly over the virtual shards;
 *  - `serial`: every virtual shard decoded, then ONE `coldBuildReadModel`
 *    (the cold build before P4); `stream`: inside one transaction,
 *    `StreamedColdBuild.open`, each virtual shard decoded then its slice
 *    handed to `objects()`, then `finish` (P4). `stream` needs a tree that
 *    has `StreamedColdBuild`; P4 was removed since, so in this tree only
 *    `serial` runs and `stream` stops with a message.
 * Per sample: every ro_* table TRUNCATEd and a CHECKPOINT (every first page
 * touch is a full-page image: the conservative case), then the timed build;
 * wall ms, decode ms (the sum of the shard decodes), stream wait ms,
 * WAL bytes (insert LSN before and after) and requested checkpoints.
 * No connections, groups or diagrams (the corpus has almost none).
 */
import pg from 'pg'
import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import * as A from '@automerge/automerge'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { withMetaUrlView } from '../src/modelMetaUrls.js'
import { coldBuildReadModel, type WorkspaceKey } from '../src/readModel/projector.js'
import type { ObjectInput } from '../src/readModel/types.js'
import { roundedRowWriteTimings, type RowWriteTimings } from '../src/readModel/rowWriteTimings.js'

const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string): string => {
  const at = argv.indexOf(`--${name}`)
  const value = at >= 0 ? argv[at + 1] : fallback
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}
const manifest = JSON.parse(readFileSync(flag('manifest'), 'utf8')) as {
  workspace: { landscapeId: string; versionId: string; schema: string; rootUrl: string }
}
const ADMIN_URL = process.env.G416F_PG_URL
if (!ADMIN_URL) throw new Error('G416F_PG_URL is required')
const url = new URL(ADMIN_URL)
url.pathname = `/${flag('database')}`
const pool = new pg.Pool({ connectionString: url.toString(), max: 4, options: `-c search_path=${manifest.workspace.schema}` })
const KEY: WorkspaceKey = { landscapeId: manifest.workspace.landscapeId, versionId: manifest.workspace.versionId }
const mode = flag('mode')
if (mode !== 'serial' && mode !== 'stream') throw new Error('--mode serial|stream')
const docIdOf = (u: string) => u.replace(/^automerge:/, '').split('?')[0]!

async function binaryOf(adapter: PostgresStorageAdapter, documentId: string): Promise<Uint8Array> {
  const parts = [...await adapter.loadRange([documentId, 'snapshot']), ...await adapter.loadRange([documentId, 'incremental'])]
    .map((chunk) => chunk.data).filter((d): d is Uint8Array => d !== undefined)
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

const redraw = (s: unknown) => typeof s === 'string'
  ? s.replace(/[0-9a-f]{8,}/g, (m) => randomBytes(Math.ceil(m.length / 2)).toString('hex').slice(0, m.length))
  : s

/** One shard's decode as the cold build pays it: load, then every entity read. */
function decode(binary: Uint8Array): number {
  const doc = A.load<{ objects?: Record<string, Record<string, unknown>> }>(binary)
  let fields = 0
  for (const entity of Object.values(doc.objects ?? {})) fields += Object.keys(entity).length
  A.free(doc)
  return fields
}

async function main() {
  const adapter = new PostgresStorageAdapter({ db: pool })
  // The ModelMeta the snapshot's ROOT points at (an epoch roll gives the
  // workspace a new one, so not the manifest's first).
  const root = A.load<{ modelMetaUrl?: string }>(await binaryOf(adapter, docIdOf(manifest.workspace.rootUrl)))
  const metaUrl = root.modelMetaUrl
  A.free(root)
  if (!metaUrl) throw new Error('the snapshot root has no modelMetaUrl')
  const metaRaw = A.load<Record<string, unknown>>(await binaryOf(adapter, docIdOf(metaUrl)))
  const meta = withMetaUrlView(metaRaw as never) as unknown as { objectShardUrls: string[] }
  const shardIds = [...new Set(meta.objectShardUrls.map(docIdOf))]
  A.free(metaRaw)
  const shards: Uint8Array[] = []
  for (const id of shardIds) shards.push(await binaryOf(adapter, id))
  /** The shard's bytes read from storage AGAIN, as `repo.find` reads them
   * (async: the event loop runs during it, as in the cold build), unless
   * `--storage-read off`. */
  const storageRead = flag('storage-read', 'on') === 'on'
  const readShard = async (v: number): Promise<Uint8Array> =>
    storageRead ? binaryOf(adapter, shardIds[v % shardIds.length]!) : shards[v % shards.length]!

  const { rows } = await pool.query<{ data: ObjectInput }>(
    `SELECT data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 ORDER BY id COLLATE "C"`, [KEY.landscapeId, KEY.versionId])
  const base = rows.map((row) => row.data)
  const target = Number(flag('objects'))
  const objects: ObjectInput[] = []
  for (let k = 0; objects.length < target; k++) {
    for (const o of base) {
      if (objects.length >= target) break
      if (k === 0) { objects.push(o); continue }
      const c = structuredClone(o)
      c.id = `${String(o.id)}~${k}`
      c.name = redraw(c.name) as string
      c.description = redraw(c.description) as string
      c.technology = redraw(c.technology) as string
      if (Array.isArray(c.technologies)) c.technologies = c.technologies.map((t) => ({ ...t, name: redraw(t.name) as string }))
      for (const field of ['scope', 'status', 'domainId'] as const) if (typeof c[field] === 'string') c[field] = redraw(c[field]) as string
      objects.push(c)
    }
  }
  const passes = target / base.length
  const virtualShards = Math.max(1, Math.round(shards.length * passes))
  const per = Math.ceil(objects.length / virtualShards)
  const slices = Array.from({ length: virtualShards }, (_, v) => objects.slice(v * per, (v + 1) * per))

  const { rows: tables } = await pool.query<{ t: string }>(
    `SELECT tablename AS t FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'ro\\_%' ORDER BY 1`)
  const { rows: indexes } = await pool.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_index x ON x.indexrelid = c.oid JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_am am ON am.oid = c.relam WHERE t.relname = 'ro_objects' AND am.amname = 'gin' ORDER BY 1`)
  const out: Record<string, unknown> = {
    mode, objects: objects.length, corpusObjects: base.length, shards: shards.length, virtualShards,
    shardBytes: shards.reduce((s, b) => s + b.length, 0), roObjectsGinIndexes: indexes.map((row) => row.name),
    settings: (await pool.query(`SELECT name, setting, unit FROM pg_settings WHERE name IN
      ('max_wal_size', 'shared_buffers', 'gin_pending_list_limit', 'maintenance_work_mem', 'wal_compression', 'full_page_writes')
      ORDER BY name`)).rows,
    samples: [] as unknown[],
  }
  const stat = async () => (await pool.query<{ lsn: string; req: string }>(
    `SELECT pg_current_wal_insert_lsn()::text AS lsn, (SELECT checkpoints_req FROM pg_stat_bgwriter)::text AS req`)).rows[0]!
  // Warm the wasm and the JIT on one shard, untimed.
  decode(shards[0]!)
  for (let sample = 1; sample <= Number(flag('samples', '3')); sample++) {
    await pool.query(`TRUNCATE ${tables.map((r) => r.t).join(', ')}`)
    await pool.query('CHECKPOINT')
    const timings: RowWriteTimings = {}
    let decodeMs = 0
    let waitMs = 0
    /** One shard as the cold build reads it: the yield between two shards
     * (`resolveCooperatively`), the storage read, the decode. */
    const decodeShard = async (v: number) => {
      const startedAt = performance.now()
      if (v > 0) await new Promise((resolve) => setImmediate(resolve))
      decode(await readShard(v))
      decodeMs += performance.now() - startedAt
    }
    const before = await stat()
    const startedAt = performance.now()
    let writesAfterDecodeMs = 0
    if (mode === 'serial') {
      for (let v = 0; v < virtualShards; v++) await decodeShard(v)
      const writesAt = performance.now()
      await coldBuildReadModel(pool, KEY, null, objects, [], [], [], { timings })
      writesAfterDecodeMs = performance.now() - writesAt
    } else {
      const { StreamedColdBuild } = await import('../src/readModel/projector.js') as unknown as {
        StreamedColdBuild: {
          open(tx: pg.PoolClient, key: WorkspaceKey, orgId: string | null, groups: [], options: { timings: RowWriteTimings }): Promise<{
            objects(entries: readonly ObjectInput[]): Promise<void>
            finish(o: ObjectInput[], c: [], g: [], d: []): Promise<unknown>
            abandon(): Promise<void>
          }>
        } | undefined
      }
      if (!StreamedColdBuild) throw new Error('--mode stream: this tree has no StreamedColdBuild (P4 was removed)')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const build = await StreamedColdBuild.open(client, KEY, null, [], { timings })
        for (let v = 0; v < virtualShards; v++) {
          await decodeShard(v)
          const waitAt = performance.now()
          await build.objects(slices[v]!)
          waitMs += performance.now() - waitAt
        }
        const writesAt = performance.now()
        await build.finish(objects, [], [], [])
        writesAfterDecodeMs = performance.now() - writesAt
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }
    const ms = performance.now() - startedAt
    const after = await stat()
    const wal = Number((await pool.query<{ d: string }>(`SELECT pg_wal_lsn_diff($2, $1)::bigint AS d`, [before.lsn, after.lsn])).rows[0]!.d)
    const { rows: count } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ro_objects WHERE landscape_id = $1 AND version_id = $2`, [KEY.landscapeId, KEY.versionId])
    const line = {
      sample, ms: Math.round(ms), decodeMs: Math.round(decodeMs), streamWaitMs: Math.round(waitMs),
      writesAfterDecodeMs: Math.round(writesAfterDecodeMs), walMB: Math.round(wal / 2 ** 20 * 10) / 10,
      checkpointsReq: Number(after.req) - Number(before.req), rows: count[0]!.n, timings: roundedRowWriteTimings(timings),
    }
    console.log(JSON.stringify(line))
    ;(out.samples as unknown[]).push(line)
  }
  writeFileSync(flag('out'), `${JSON.stringify(out, null, 1)}\n`)
  await pool.end()
}
await main()
