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

import type { Repo, DocHandle } from '@automerge/automerge-repo'
import { pool } from './db.js'
import { findReadyDocument } from './automergeRepoCompat.js'

/**
 * One-time migration of the legacy flat `entities` table into the Automerge
 * hybrid model. Runs server-side, exactly once, when the shared root document is
 * first created — so it uses the server's already-merged union of every client's
 * data and there is no client-side race.
 *
 *  - shared model entities (object/connection/group/domain/decisionRecord)
 *    → ModelDoc.<collection> (id-keyed maps); legacy Tag rows are deliberately
 *    discarded and the governed catalog seed supplies fresh identities;
 *  - each diagram → its own DiagramDoc (settings + composition + layouts +
 *    its comments/flows) and a DiagramMeta entry in a RegistryShard.
 *
 * Diagrams are distributed across shards; when a shard is full a new shard is
 * created and its URL is appended to root.shardUrls.
 *
 * AM_SHARD_SIZE (env) controls shard capacity (default 200).
 */

const SHARD_SIZE = Number(process.env.AM_SHARD_SIZE ?? 200)

interface EntityRow {
  id: string
  type: string
  data: Record<string, unknown>
}

type Entity = Record<string, unknown> & { id: string }

function mapById(items: Entity[]): Record<string, Entity> {
  const out: Record<string, Entity> = {}
  for (const e of items) out[e.id] = e
  return out
}

export async function migrateEntitiesIntoRoot(
  repo: Repo,
  rootHandle: DocHandle<Record<string, unknown>>,
  modelHandle: DocHandle<Record<string, unknown>>
): Promise<void> {
  const { rows } = await pool.query<EntityRow>('SELECT id, type, data FROM entities')
  if (rows.length === 0) return

  const of = (type: string): Entity[] =>
    rows.filter((r) => r.type === type).map((r) => ({ id: r.id, ...r.data }))

  const objects = of('object')
  const connections = of('connection')
  const groups = of('group')
  const domains = of('domain')
  const decisionRecords = of('decisionRecord')
  const diagrams = of('diagram')
  const comments = of('comment')
  const flows = of('flow')

  // Collect diagram registry entries (id → meta), creating DiagramDocs.
  const allMetas: Array<{
    id: string
    name: unknown
    type: unknown
    docUrl: string
    parentObjectId?: string
    objectIds: string[]
    connectionIds: string[]
    groupIds: string[]
  }> = []
  for (const dg of diagrams) {
    const { id, layouts, ...fields } = dg
    const dgComments = comments.filter((c) => c.diagramId === id)
    const dgFlows = flows.filter((f) => f.diagramId === id)
    const diagramDoc = {
      ...fields,
      layouts: layouts ?? {},
      comments: mapById(dgComments),
      flows: mapById(dgFlows),
      checkpoints: [],
    }
    const handle = repo.create(diagramDoc)
    await handle.whenReady()
    // Carry composition into the shard meta so stubs are accurate without
    // loading the full DiagramDoc. The diagram entity rows store these as arrays.
    const objectIds = Array.isArray(dg.objectIds) ? (dg.objectIds as string[]) : []
    const connectionIds = Array.isArray(dg.connectionIds) ? (dg.connectionIds as string[]) : []
    const groupIds = Array.isArray(dg.groupIds) ? (dg.groupIds as string[]) : []
    const parentObjectId = typeof dg.parentObjectId === 'string' ? dg.parentObjectId : undefined
    allMetas.push({ id, name: dg.name, type: dg.type, docUrl: handle.url, parentObjectId, objectIds, connectionIds, groupIds })
  }

  // Write the C4 model collections into the separate ModelDoc.
  modelHandle.change((m) => {
    const model = m as Record<string, Record<string, Entity>>
    model.objects = mapById(objects)
    model.connections = mapById(connections)
    model.groups = mapById(groups)
    model.domains = mapById(domains)
    model.tagSnapshots = {}
    model.decisionRecords = mapById(decisionRecords)
  })

  // Distribute diagram metas into registry shards, filling each to SHARD_SIZE.
  // The root already has one empty shard at shardUrls[0]; we fill that first,
  // then create additional shards as needed.
  const root = rootHandle.doc() as { shardUrls: string[] } | undefined
  if (!root) throw new Error('Root doc not ready during migration')

  // Find the current last shard handle (already created in ensureRootDoc).
  const existingShardUrl = root.shardUrls[root.shardUrls.length - 1]
  type ShardShape = { diagrams: Record<string, unknown> }
  let currentShardHandle = await findReadyDocument<ShardShape>(repo, existingShardUrl)
  let currentShardCount = Object.keys(currentShardHandle.doc()?.diagrams ?? {}).length

  for (const meta of allMetas) {
    if (currentShardCount >= SHARD_SIZE) {
      // Current shard full — create a new one and append to root.
      const newShard = repo.create<ShardShape>({ diagrams: {} })
      await newShard.whenReady()
      rootHandle.change((r) => {
        const rr = r as { shardUrls: string[] }
        rr.shardUrls.push(newShard.url)
      })
      currentShardHandle = newShard
      currentShardCount = 0
    }
    currentShardHandle.change((s) => {
      const entry: Record<string, unknown> = {
        id: meta.id,
        name: meta.name,
        type: meta.type,
        docUrl: meta.docUrl,
        objectIds: meta.objectIds,
        connectionIds: meta.connectionIds,
        groupIds: meta.groupIds,
      }
      // Only set when present — Automerge maps reject `undefined` values.
      if (meta.parentObjectId !== undefined) entry.parentObjectId = meta.parentObjectId
      s.diagrams[meta.id] = entry
    })
    currentShardCount++
  }

  console.log(
    `Migrated ${rows.length} legacy entities into Automerge: ` +
      `${objects.length} objects, ${diagrams.length} diagrams across ` +
      `${(rootHandle.doc() as { shardUrls: string[] }).shardUrls.length} shard(s) ` +
      `(SHARD_SIZE=${SHARD_SIZE}, model in separate doc)`
  )
}
