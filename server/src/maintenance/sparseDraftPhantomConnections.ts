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

import {
  isValidAutomergeUrl,
  type DocHandle,
  type Repo,
} from '@automerge/automerge-repo'
import type { Queryable } from '../readModel/types.js'
import { isSparseDraftManifest, type SparseDraftManifest } from '../draft/manifest.js'
import { findReadyDocument } from '../automergeRepoCompat.js'

interface RootLike { modelMetaUrl?: string }
interface MetaLike { deletedConnectionIds?: string[] }
interface DiagramLike { connectionIds?: string[] }

export interface SparseDraftPhantomConnectionRepairResult {
  landscapeId: string
  draftId: string
  auditedTombstones: number
  structurallyProvenIds: string[]
  operatorConfirmedIds: string[]
  repairableIds: string[]
  retainedIds: string[]
  applied: number
}

async function find<T>(repo: Repo, url: string): Promise<DocHandle<T>> {
  if (!isValidAutomergeUrl(url)) throw new Error(`invalid Automerge url: ${url}`)
  const handle = await findReadyDocument<T>(repo, url)
  if (!handle.doc()) throw new Error(`document unavailable: ${url}`)
  return handle
}

/**
 * Restore only connection tombstones that contradict the sparse draft's own
 * durable state: the cloned DiagramDoc still references the connection and the
 * captured three-way-merge base proves that it existed. An intentional delete
 * removes the connection from the DiagramDoc, so it is retained here.
 */
export async function repairSparseDraftPhantomConnections(
  db: Queryable,
  repo: Repo,
  landscapeId: string,
  draftId: string,
  options: {
    apply?: boolean
    expectedRepairCount?: number
    includeCapturedUnreferenced?: boolean
  } = {},
): Promise<SparseDraftPhantomConnectionRepairResult> {
  const { rows } = await db.query<{
    root_url: string
    status: string
    base_manifest: SparseDraftManifest | null
  }>(
    `SELECT root_url, status, base_manifest
     FROM versions
     WHERE landscape_id = $1 AND id = $2 AND kind = 'draft'`,
    [landscapeId, draftId],
  )
  const version = rows[0]
  if (!version || version.status !== 'active' || !isSparseDraftManifest(version.base_manifest)) {
    throw new Error('active sparse draft was not found')
  }

  const root = (await find<RootLike>(repo, version.root_url)).doc()!
  if (!root.modelMetaUrl) throw new Error('sparse draft ModelMeta is unavailable')
  const metaHandle = await find<MetaLike>(repo, root.modelMetaUrl)
  const tombstones = [...new Set(metaHandle.doc()?.deletedConnectionIds ?? [])].sort()

  const referencedIds = new Set<string>()
  for (const entry of Object.values(version.base_manifest.diagramBases)) {
    const diagram = (await find<DiagramLike>(repo, entry.docUrl)).doc()
    for (const id of diagram?.connectionIds ?? []) referencedIds.add(id)
  }
  const { rows: baselineRows } = tombstones.length
    ? await db.query<{ id: string }>(
        `WITH candidate(id) AS (SELECT unnest($4::text[]))
         SELECT candidate.id
         FROM candidate
         WHERE EXISTS (
           SELECT 1 FROM draft_sparse_base_entities captured
           WHERE captured.landscape_id = $1 AND captured.draft_version_id = $2
             AND captured.entity_kind = 'connection' AND captured.existed = TRUE
             AND captured.entity_id = candidate.id
         ) OR EXISTS (
           SELECT 1 FROM ro_connections parent
           WHERE parent.landscape_id = $1 AND parent.version_id = $3
             AND parent.id = candidate.id
         )`,
        [landscapeId, draftId, version.base_manifest.parentVersionId, tombstones],
      )
    : { rows: [] }
  const presentInBaseOrParent = new Set(baselineRows.map((row) => row.id))
  const structurallyProvenIds = tombstones
    .filter((id) => referencedIds.has(id) && presentInBaseOrParent.has(id))
    .sort()
  // Legacy selective-window corruption also tombstoned off-window connections
  // that were not referenced by a cloned DiagramDoc. Restoring those requires
  // an explicit operator assertion that the draft performed layout-only work;
  // capture-at-fork still proves that every restored id existed in its base.
  const operatorConfirmedIds = options.includeCapturedUnreferenced
    ? tombstones.filter((id) => !referencedIds.has(id) && presentInBaseOrParent.has(id)).sort()
    : []
  const repairableIds = [...structurallyProvenIds, ...operatorConfirmedIds].sort()
  const repairable = new Set(repairableIds)
  const retainedIds = tombstones.filter((id) => !repairable.has(id))

  if (options.expectedRepairCount !== undefined
      && repairableIds.length !== options.expectedRepairCount) {
    throw new Error(
      `phantom connection count mismatch: expected ${options.expectedRepairCount}, actual ${repairableIds.length}`,
    )
  }
  if (options.apply && repairableIds.length) {
    metaHandle.change((draft) => {
      draft.deletedConnectionIds = [...new Set(draft.deletedConnectionIds ?? [])]
        .filter((id) => !repairable.has(id))
    })
    await repo.flush([metaHandle.documentId])
  }

  return {
    landscapeId,
    draftId,
    auditedTombstones: tombstones.length,
    structurallyProvenIds,
    operatorConfirmedIds,
    repairableIds,
    retainedIds,
    applied: options.apply ? repairableIds.length : 0,
  }
}
