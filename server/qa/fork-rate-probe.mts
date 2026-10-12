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
 * FORK RATE PROBE. Measures how fast `forkRoot` copies a source graph
 * against a real Postgres storage adapter, named (minted ids, `repo.import`)
 * and legacy (`repo.create`), on the same graph.
 *
 * Why it exists: the minted-orphan reaper's floor must exceed the longest
 * bootstrap that can complete at all — a fork in progress on another replica
 * is protected by the floor alone (mintedOrphanReaper.ts, § the floor). This
 * turns "an hour is far above any fork" from an adjective into a number:
 * documents per second, against the 9-10k document memory wall.
 *
 *   TEST_DATABASE_URL=postgres://... npx tsx qa/fork-rate-probe.mts [docs=1000]
 *
 * Prints one JSON line per arm. Not a test; run it by hand and cite it.
 */
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { Repo, type StorageAdapterInterface } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { forkRoot } from '../src/forkRoot.js'
import { openBootstrapScope } from '../src/bootstrapScope.js'
import { setWorkspaceDocumentsRegistrationForTest } from '../src/rbac/docScope.js'
import { isMintedDocumentId } from '../src/rbac/documentIdMint.js'

const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error('TEST_DATABASE_URL is required')
const docs = Number(process.argv.find((a) => a.startsWith('docs='))?.slice(5) ?? '1000')
const schema = `fork_rate_${randomUUID().slice(0, 8)}`

const pool = new pg.Pool({ connectionString: url })
await pool.query(`CREATE SCHEMA ${schema}`)
await pool.query(`SET search_path TO ${schema}`)
const scoped = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` })
await scoped.query(`CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq`)
await scoped.query(`CREATE TABLE IF NOT EXISTS automerge_storage (
  key TEXT PRIMARY KEY, data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq'))`)

const storage: StorageAdapterInterface = new PostgresStorageAdapter({ db: scoped })
const repo = new Repo({ storage, network: [] })

// Source graph: one object shard, meta, one registry shard listing `docs`
// diagrams, each with its own document — the shape a fork walks.
const objectShard = repo.create({ objects: { o1: { id: 'o1', name: 'Marker' } } })
const meta = repo.create({ objectShardUrls: [objectShard.url], connectionShardUrls: [], groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} })
const diagrams: Record<string, unknown> = {}
for (let i = 0; i < docs; i += 1) {
  const d = repo.create({ name: `D${i}`, type: 'context', objectIds: ['o1'], connectionIds: [], groupIds: [], layouts: {}, comments: {}, flows: {}, checkpoints: [] })
  diagrams[`d${i}`] = { id: `d${i}`, name: `D${i}`, type: 'context', docUrl: d.url, objectIds: ['o1'], connectionIds: [], groupIds: [] }
}
const registry = repo.create({ diagrams })
const root = repo.create({ modelUrl: '', modelMetaUrl: meta.url, shardUrls: [registry.url] })
await repo.flush()

async function arm(name: string, named: boolean): Promise<void> {
  const restore = named
    ? setWorkspaceDocumentsRegistrationForTest(async () => ({ claimed: [], alreadyOurs: [], foreign: [], missingVersion: false }))
    : setWorkspaceDocumentsRegistrationForTest(null)
  const savedSecret = process.env.AUTH_SECRET
  if (named) process.env.AUTH_SECRET = 'fork-rate-probe'
  else delete process.env.AUTH_SECRET
  try {
    const t0 = performance.now()
    const { createdDocumentIds } = await forkRoot(
      repo, root.url,
      openBootstrapScope({ landscapeId: 'L-probe', versionId: `V-${name}` }, { kind: 'unfenced', reason: 'no-forker' }),
    )
    const ms = performance.now() - t0
    const minted = createdDocumentIds.filter((id) => isMintedDocumentId(id)).length
    console.log(JSON.stringify({
      arm: name, sourceDocuments: docs, createdDocuments: createdDocumentIds.length, minted,
      ms: Math.round(ms), documentsPerSecond: Math.round(createdDocumentIds.length / (ms / 1000)),
      hourCoversDocuments: Math.round(createdDocumentIds.length / (ms / 1000) * 3600),
      tenMinutesCoverDocuments: Math.round(createdDocumentIds.length / (ms / 1000) * 600),
    }))
  } finally {
    restore()
    if (savedSecret === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = savedSecret
  }
}

await arm('legacy-warmup', false)
await arm('legacy', false)
await arm('named', true)
await arm('named-again', true)

await scoped.end()
await pool.query(`DROP SCHEMA ${schema} CASCADE`)
await pool.end()
