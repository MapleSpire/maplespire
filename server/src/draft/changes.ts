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

import type { SealedRepo } from '../rbac/sealedRepo.js'
import { pool } from '../db.js'
import { materializeFullModel, type HeadsMap, type FullModel } from './materialize.js'
import { diffModels, type DiffResult, type DraftChange } from './merge.js'
import { isSparseDraftManifest, type DraftBaseManifest, type RootManifest } from './manifest.js'
import { materializeSparseDraftModels } from './sparse.js'

const MODEL_COLLECTIONS = new Set(['object', 'connection', 'group', 'domain', 'tag', 'decisionRecord'])

/**
 * Simplify the diff FOR DISPLAY (the merge still applies the full changeset — applyMerge
 * re-diffs). Drops layout created/deleted rows that are implied by an object/group
 * create/delete (the user sees those as one change), relabels remaining layout + connection
 * rows to friendly entity names instead of raw ids, and recomputes the counts to match.
 */
export function presentForDisplay(diff: DiffResult, theirs: FullModel, ours: FullModel): DiffResult {
  const nameOf = (id: string): string | undefined => {
    const o = (theirs.objects[id] ?? ours.objects[id]) as { name?: string } | undefined
    const g = (theirs.groups[id] ?? ours.groups[id]) as { name?: string } | undefined
    return o?.name ?? g?.name
  }
  // An object/group created or deleted implies its diagram layout was too — redundant to show.
  const impliedLayout = new Set<string>()
  for (const c of diff.changes) {
    if ((c.collection === 'object' || c.collection === 'group') && (c.kind === 'created' || c.kind === 'deleted')) {
      impliedLayout.add(`${c.id}:${c.kind}`)
    }
  }
  const changes: DraftChange[] = []
  for (const c of diff.changes) {
    if (c.collection === 'layout') {
      if (impliedLayout.has(`${c.id}:${c.kind}`)) continue // redundant with the object/group row
      changes.push({ ...c, label: nameOf(c.id) ?? c.label }) // a move — show the entity name
      continue
    }
    if (c.collection === 'connection') {
      const conn = (theirs.connections[c.id] ?? ours.connections[c.id]) as { label?: string; fromId?: string; toId?: string } | undefined
      if (conn && !conn.label && conn.fromId && conn.toId) {
        changes.push({ ...c, label: `${nameOf(conn.fromId) ?? conn.fromId} → ${nameOf(conn.toId) ?? conn.toId}` })
        continue
      }
    }
    changes.push(c)
  }
  const touched = new Set<string>()
  for (const c of changes) {
    if (c.collection === 'diagram') touched.add(c.id)
    else if (c.diagramId) touched.add(c.diagramId)
  }
  return {
    changes,
    conflicts: diff.conflicts,
    counts: {
      model: changes.filter((c) => MODEL_COLLECTIONS.has(c.collection)).length,
      diagrams: touched.size,
      conflicts: diff.conflicts.length,
    },
  }
}

/**
 * Compute a draft's changes: the 3-way diff of the draft against its parent.
 *   base   = parent @ fork  (the stored base_manifest, materialized at those heads)
 *   ours   = parent @ now   (the live default version, possibly advanced since the fork)
 *   theirs = draft  @ now
 *
 * Returns null when the draft (or its base/parent) can't be resolved; throws (→ 500)
 * if a model-level doc is unreadable, since a partial model would yield a wrong diff.
 */
export async function computeDraftChanges(
  repo: SealedRepo,
  landscapeId: string,
  draftId: string
): Promise<DiffResult | null> {
  const { rows } = await pool.query<{ root_url: string; parent_version_id: string | null; base_manifest: DraftBaseManifest | null }>(
    `SELECT root_url, parent_version_id, base_manifest
     FROM versions WHERE id = $1 AND landscape_id = $2 AND kind = 'draft'`,
    [draftId, landscapeId]
  )
  if (rows.length === 0) return null
  const { root_url: draftRootUrl, parent_version_id: parentVersionId, base_manifest: baseManifest } = rows[0]
  if (!baseManifest || !parentVersionId) return null // a draft with no captured base can't be diffed

  const { rows: prow } = await pool.query<{ root_url: string }>(
    'SELECT root_url FROM versions WHERE id = $1',
    [parentVersionId]
  )
  const parentRootUrl = prow[0]?.root_url
  if (!parentRootUrl) return null

  if (isSparseDraftManifest(baseManifest)) {
    const { base, ours, theirs } = await materializeSparseDraftModels(
      repo,
      pool,
      landscapeId,
      draftId,
      draftRootUrl,
      parentVersionId,
      baseManifest,
    )
    return presentForDisplay(diffModels(base, ours, theirs), theirs, ours)
  }

  const atHeads: HeadsMap = {}
  for (const d of (baseManifest as RootManifest).docs) atHeads[d.url] = d.heads

  const base = await materializeFullModel(repo, baseManifest.rootUrl, atHeads)
  const ours = await materializeFullModel(repo, parentRootUrl)
  const theirs = await materializeFullModel(repo, draftRootUrl)
  return presentForDisplay(diffModels(base, ours, theirs), theirs, ours)
}
