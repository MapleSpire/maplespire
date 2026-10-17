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
 * Server-side workspace seed (authorized dev utility). Builds the Automerge document
 * tree DIRECTLY via the server's Repo + PostgresStorageAdapter — no browser, no WS sync
 * (which doesn't reliably persist a bulk seed under boot-from-server). Run with the sync
 * server STOPPED and after `wipe-all.mjs`; then start the server so its read-model
 * projector cold-builds `ro_*` from the seeded root.
 *
 * Topology (matches the client/bridge exactly — see src/lib/automerge/types.ts):
 *   Root        { modelUrl:'', modelMetaUrl, shardUrls:[registry…] }
 *   ModelMeta   buildModelMeta(…) — base shards with the overlay write heads last,
 *                 groups, domains, tagSnapshots, decisionRecords — plus
 *                 deletedObjectIds:[], deletedConnectionIds:[]
 *   Overlay heads    { objects|connections: {}, writeHeadVersion }  (empty)
 *   ObjectShard      { objects:    Record<id, C4Object> }     (≤ MODEL_SHARD_SIZE)
 *   ConnectionShard  { connections:Record<id, Connection> }   (≤ MODEL_SHARD_SIZE)
 *   RegistryShard    { diagrams:   Record<id, DiagramMeta> }  (≤ SHARD_SIZE)
 *   DiagramDoc       Omit<Diagram,'id'> & { comments, flows, checkpoints }
 *
 * Usage:  cd server && npx tsx scripts/seed-workspace.ts [rich|real]
 */
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { pool } from '../src/db.js'
import { copyRootShape } from '../src/rootShape.js'
import { buildModelMeta, OVERLAY_WRITE_HEAD_VERSION } from '../src/modelMeta.js'
import { generateRichWorkspace, type RichWorkspace } from '../../src/lib/devSeed/richWorkspace.ts'
import { generateRealWorkspace } from '../../src/lib/devSeed/realWorkspace.ts'

const MODEL_SHARD_SIZE = Number(process.env.AM_MODEL_SHARD_SIZE ?? 512)
const SHARD_SIZE = Number(process.env.AM_SHARD_SIZE ?? 200)

const byId = <T extends { id: string }>(arr: T[]): Record<string, T> =>
  Object.fromEntries(arr.map((e) => [e.id, e]))

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function main(): Promise<void> {
  // 'real'  (default) — small, fast, recognizable workspace for the E2E suite.
  // 'heavy'           — real architectures + a large bulk (5k objects / 30k connections / hubs)
  //                     for PERFORMANCE testing.
  // 'rich'            — the raw generateRichWorkspace (legacy stress dataset).
  const kind = process.argv[2] ?? 'real'
  const ws: RichWorkspace =
    kind === 'rich'
      ? generateRichWorkspace({ objects: 5000 })
      : kind === 'heavy'
        ? generateRealWorkspace({ heavy: true })
        : generateRealWorkspace()

  const repo = new Repo({ storage: new PostgresStorageAdapter() })

  // ── model shards (objects + connections), sharded like the boot stack ──────────
  const objectShardUrls = chunk(ws.objects, MODEL_SHARD_SIZE).map(
    (slice) => repo.create({ objects: byId(slice) }).url
  )
  const connectionShardUrls = chunk(ws.connections, MODEL_SHARD_SIZE).map(
    (slice) => repo.create({ connections: byId(slice) }).url
  )
  // At least one empty shard so the topology is well-formed even if a collection is empty.
  if (objectShardUrls.length === 0) objectShardUrls.push(repo.create({ objects: {} }).url)
  if (connectionShardUrls.length === 0) connectionShardUrls.push(repo.create({ connections: {} }).url)

  // The empty overlay write heads every edit is written into. Without them the
  // client's write-head boot guard (`planBfsWriteMode`) refuses boot-from-server
  // and boots RESIDENT — online and offline — so a "boot" e2e run against this
  // seed silently exercised the resident app (measured 2026-10-16:
  // `boot-from-server refused (no overlay write heads and no overlay content)`).
  const objectWriteHead = repo.create({ objects: {}, writeHeadVersion: OVERLAY_WRITE_HEAD_VERSION }).url
  const connectionWriteHead = repo.create({ connections: {}, writeHeadVersion: OVERLAY_WRITE_HEAD_VERSION }).url

  // Through `buildModelMeta`, never a literal: the literal this replaces had no
  // write heads AND spelled the tag map `tags` keyed by a nonexistent `id`,
  // so the client (which reads `tagSnapshots`, keyed by `tagId`) saw no tags.
  const metaHandle = repo.create({
    ...buildModelMeta({
      objectShardUrls,
      connectionShardUrls,
      objectWriteHead,
      connectionWriteHead,
      groups: byId(ws.groups),
      domains: byId(ws.domains),
      tagSnapshots: Object.fromEntries(ws.tags.map((tag) => [tag.tagId, tag])),
      decisionRecords: byId(ws.decisionRecords),
    }),
    deletedObjectIds: [],
    deletedConnectionIds: [],
  })

  // ── per-diagram docs + registry stubs (denormalised composition on the stub) ────
  const commentsByDiagram = new Map<string, RichWorkspace['comments']>()
  for (const c of ws.comments) {
    const list = commentsByDiagram.get(c.diagramId) ?? []
    list.push(c)
    commentsByDiagram.set(c.diagramId, list)
  }
  const flowsByDiagram = new Map<string, RichWorkspace['flows']>()
  for (const f of ws.flows) {
    const list = flowsByDiagram.get(f.diagramId) ?? []
    list.push(f)
    flowsByDiagram.set(f.diagramId, list)
  }

  const metas = ws.diagrams.map((d) => {
    const { id, ...rest } = d
    const docUrl = repo.create({
      ...rest,
      comments: byId(commentsByDiagram.get(id) ?? []),
      flows: byId(flowsByDiagram.get(id) ?? []),
      checkpoints: [],
    }).url
    return {
      id,
      name: d.name,
      type: d.type,
      docUrl,
      ...(d.parentObjectId ? { parentObjectId: d.parentObjectId } : {}),
      objectIds: d.objectIds,
      connectionIds: d.connectionIds,
      groupIds: d.groupIds,
    }
  })

  const registryShardUrls = (metas.length ? chunk(metas, SHARD_SIZE) : [[]]).map(
    (slice) => repo.create({ diagrams: byId(slice) }).url
  )

  // ── root — through the ONE root-shape mapper (src/rootShape.ts) ────────────────
  const rootHandle = repo.create(copyRootShape(undefined, {
    modelUrl: '',
    modelMetaUrl: metaHandle.url,
    shardUrls: registryShardUrls,
  }))

  await repo.flush()

  await pool.query(
    `INSERT INTO automerge_meta (key, value) VALUES ('root_url', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [rootHandle.url]
  )

  console.log(
    `[seed] ${kind}: ${ws.objects.length} objects (${objectShardUrls.length} shards), ` +
      `${ws.connections.length} connections (${connectionShardUrls.length} shards), ` +
      `${ws.groups.length} groups, ${ws.diagrams.length} diagrams (${registryShardUrls.length} registry shards), ` +
      `${ws.comments.length} comments, ${ws.flows.length} flows, ${ws.decisionRecords.length} ADRs`
  )
  console.log('[seed] root =', rootHandle.url, '— restart the server to cold-build ro_*')
  await pool.end()
}

main().catch((e) => {
  console.error('[seed] failed:', e)
  process.exit(1)
})
