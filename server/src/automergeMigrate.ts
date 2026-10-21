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

/** A diagram to place: its DiagramDoc, and its registry entry minus `docUrl`. */
export interface WorkspaceDiagram {
  meta: {
    id: string
    name: unknown
    type: unknown
    parentObjectId?: string
    objectIds: string[]
    connectionIds: string[]
    groupIds: string[]
  }
  doc: Record<string, unknown>
}

/**
 * Write a model and its diagrams into a root that is NOT YET PUBLISHED: one
 * DiagramDoc per diagram, the ModelDoc's collections, then the registry entries
 * (filling the root's last shard to SHARD_SIZE, appending shards beyond it).
 *
 * Content before pointers, but the order is not what makes this safe: the
 * caller publishes the root only after `repo.flush()`, so no client can reach
 * any of these documents until all of them are durable. Never call this on a
 * root a client may already hold.
 */
export async function writeWorkspaceContent(
  repo: Repo,
  rootHandle: DocHandle<Record<string, unknown>>,
  modelHandle: DocHandle<Record<string, unknown>>,
  model: Record<string, Record<string, unknown>>,
  diagrams: readonly WorkspaceDiagram[],
): Promise<void> {
  const placed: Array<WorkspaceDiagram['meta'] & { docUrl: string }> = []
  for (const diagram of diagrams) {
    const handle = repo.create(diagram.doc)
    await handle.whenReady()
    placed.push({ ...diagram.meta, docUrl: handle.url })
  }

  modelHandle.change((m) => {
    const target = m as Record<string, Record<string, unknown>>
    for (const [collection, entries] of Object.entries(model)) target[collection] = entries
  })

  const root = rootHandle.doc() as { shardUrls: string[] } | undefined
  if (!root) throw new Error('Root doc not ready while writing workspace content')

  // Find the current last shard handle (already created by the caller).
  const existingShardUrl = root.shardUrls[root.shardUrls.length - 1]
  type ShardShape = { diagrams: Record<string, unknown> }
  let currentShardHandle = await findReadyDocument<ShardShape>(repo, existingShardUrl)
  let currentShardCount = Object.keys(currentShardHandle.doc()?.diagrams ?? {}).length

  for (const meta of placed) {
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
}

export async function migrateEntitiesIntoRoot(
  repo: Repo,
  rootHandle: DocHandle<Record<string, unknown>>,
  modelHandle: DocHandle<Record<string, unknown>>
): Promise<boolean> {
  const { rows } = await pool.query<EntityRow>('SELECT id, type, data FROM entities')
  if (rows.length === 0) return false

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

  const placed: WorkspaceDiagram[] = diagrams.map((dg) => {
    const { id, layouts, ...fields } = dg
    // Carry composition into the shard meta so stubs are accurate without
    // loading the full DiagramDoc. The diagram entity rows store these as arrays.
    const parentObjectId = typeof dg.parentObjectId === 'string' ? dg.parentObjectId : undefined
    return {
      meta: {
        id,
        name: dg.name,
        type: dg.type,
        ...(parentObjectId !== undefined ? { parentObjectId } : {}),
        objectIds: Array.isArray(dg.objectIds) ? (dg.objectIds as string[]) : [],
        connectionIds: Array.isArray(dg.connectionIds) ? (dg.connectionIds as string[]) : [],
        groupIds: Array.isArray(dg.groupIds) ? (dg.groupIds as string[]) : [],
      },
      doc: {
        ...fields,
        layouts: layouts ?? {},
        comments: mapById(comments.filter((c) => c.diagramId === id)),
        flows: mapById(flows.filter((f) => f.diagramId === id)),
        checkpoints: [],
      },
    }
  })

  await writeWorkspaceContent(repo, rootHandle, modelHandle, {
    objects: mapById(objects),
    connections: mapById(connections),
    groups: mapById(groups),
    domains: mapById(domains),
    tagSnapshots: {},
    decisionRecords: mapById(decisionRecords),
  }, placed)

  console.log(
    `Migrated ${rows.length} legacy entities into Automerge: ` +
      `${objects.length} objects, ${diagrams.length} diagrams across ` +
      `${(rootHandle.doc() as { shardUrls: string[] }).shardUrls.length} shard(s) ` +
      `(SHARD_SIZE=${SHARD_SIZE}, model in separate doc)`
  )
  return true
}
