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

import { getHistory, view } from '@automerge/automerge'
import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import type { SealedRepo } from '../rbac/sealedRepo.js'
import { findReadyDocument } from '../automergeRepoCompat.js'

/**
 * Materialize a whole workspace root into a normalized, id-keyed snapshot for the
 * Draft 3-way diff — everything `extractModelEntities` omits: domains/tags/decision
 * records AND each diagram's body (composition + layouts + flows).
 *
 * `atHeads` (a doc-url → RAW-HEX-heads map, e.g. a draft's stored base_manifest) reads
 * every doc AT those heads via Automerge `view`, GUARDED by a heads-membership check:
 * `view(doc, unknownHeads)` returns a silent DEGENERATE EMPTY doc, which would make the
 * base look wiped and the diff report the whole model as draft-created. Unknown/absent
 * heads therefore SKIP the doc (a doc not in the map didn't exist at the base) and an
 * unresolved/heads-unknown doc is recorded in `missing` so the differ can fail safe.
 *
 * CRITICAL: heads are raw hex (the manifest stores `getHeads(doc)`). NEVER feed
 * `handle.heads()` (repo-tagged UrlHeads) to core `view`/`getHistory`.
 */

export type RawHeads = string[]
/** doc url → raw-hex heads (a base manifest, flattened). */
export type HeadsMap = Record<string, RawHeads>

export interface DiagramDetail {
  /** Diagram settings (name/type/description/parentObjectId/domainId/skin/etc.) — no composition/layouts/flows/comments/checkpoints. */
  settings: Record<string, unknown>
  objectIds: string[]
  connectionIds: string[]
  groupIds: string[]
  /** Per-entity position/size overrides on THIS diagram (a "move" lands here, not on the object). */
  layouts: Record<string, unknown>
  flows: Record<string, unknown>
}

export interface FullDiagram {
  id: string
  /** Registry stub (denormalised name/type/composition). Always present. */
  meta: Record<string, unknown>
  /** Resolved DiagramDoc body; undefined if the doc was unresolved/heads-unknown. */
  detail?: DiagramDetail
}

export interface MissingDoc {
  url: string
  kind: string
  reason: 'unresolved' | 'heads-unknown'
}

export interface FullModel {
  objects: Record<string, unknown>
  connections: Record<string, unknown>
  groups: Record<string, unknown>
  domains: Record<string, unknown>
  tagSnapshots: Record<string, unknown>
  decisionRecords: Record<string, unknown>
  /** Keyed by diagram id. */
  diagrams: Record<string, FullDiagram>
  /** Docs that couldn't be materialized — the differ turns these into fail-safe conflicts. */
  missing: MissingDoc[]
}

interface RootLike { modelUrl?: string; modelMetaUrl?: string; shardUrls?: string[] }
interface MetaLike {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  decisionRecordShardUrls?: string[]
  deletedObjectIds?: string[]
  deletedConnectionIds?: string[]
  deletedDecisionRecordIds?: string[]
  groups?: Record<string, unknown>
  domains?: Record<string, unknown>
  tagSnapshots?: Record<string, unknown>
  decisionRecords?: Record<string, unknown>
}
interface ModelLike {
  objects?: Record<string, unknown>
  connections?: Record<string, unknown>
  groups?: Record<string, unknown>
  domains?: Record<string, unknown>
  tagSnapshots?: Record<string, unknown>
  decisionRecords?: Record<string, unknown>
}
interface ObjShardLike { objects?: Record<string, unknown> }
interface ConnShardLike { connections?: Record<string, unknown> }
interface DecisionRecordShardLike { decisionRecords?: Record<string, unknown> }
interface RegistryShardLike { diagrams?: Record<string, { docUrl?: string; [k: string]: unknown }> }
interface DiagramDocLike {
  objectIds?: string[]
  connectionIds?: string[]
  groupIds?: string[]
  layouts?: Record<string, unknown>
  flows?: Record<string, unknown>
  comments?: unknown
  checkpoints?: unknown
  [k: string]: unknown
}

/** Deep plain copy — strips Automerge proxies so the result is safe to diff + JSON-serialize. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** Ported from src/lib/automerge/history.ts: every requested head must be a real
 * change hash in this doc's local history, else `view` would return an empty doc. */
function headsKnown(doc: Parameters<typeof getHistory>[0], heads: string[]): boolean {
  if (heads.length === 0) return false
  const known = new Set<string>()
  for (const state of getHistory(doc)) known.add(state.change.hash)
  return heads.every((h) => known.has(h))
}

/**
 * Resolve one doc, optionally viewed at `atHeads`. Returns undefined when the doc
 * should be SKIPPED (not in the base manifest = didn't exist at base). A genuine
 * failure (unresolvable url, or heads not in local history) is recorded in `missing`
 * AND, when `critical`, THROWS: a partial MODEL would make the diff report real
 * entities as deleted/created, far worse than no diff — so model-level docs fail the
 * whole side (mirrors captureRootManifest failing loud). DIAGRAM bodies are not
 * critical: a single unreadable diagram becomes a fail-safe conflict in the diff.
 */
async function materializeDoc<T extends object>(
  repo: SealedRepo,
  url: string,
  atHeads: HeadsMap | undefined,
  missing: MissingDoc[],
  kind: string,
  critical: boolean
): Promise<T | undefined> {
  const fail = (reason: 'unresolved' | 'heads-unknown'): undefined => {
    if (critical) throw new Error(`materializeFullModel: ${kind} ${url} ${reason}`)
    missing.push({ url, kind, reason })
    return undefined
  }
  if (!isValidAutomergeUrl(url)) return fail('unresolved')
  let live: T | undefined
  try {
    const handle = await findReadyDocument(repo, url)
    live = handle.doc() as T
  } catch {
    return fail('unresolved')
  }
  if (!live) return fail('unresolved')
  if (!atHeads) return live
  const want = atHeads[url]
  if (!want) return undefined // not in the base manifest → didn't exist at base → skip (not a failure)
  if (!headsKnown(live as object, want)) return fail('heads-unknown')
  try {
    return view(live as Parameters<typeof view>[0], want) as T
  } catch {
    return fail('heads-unknown')
  }
}

/**
 * An empty per-diagram scope map is the same as none. Diagram writers create
 * `objectScopes: {}` eagerly (so no two peers create it concurrently), and a
 * diagram that has never been written since has no key: without this, a draft
 * would report a settings change for every such diagram.
 */
export function withoutEmptyObjectScopes(settings: Record<string, unknown>): Record<string, unknown> {
  const scopes = settings.objectScopes
  if (scopes && typeof scopes === 'object' && !Array.isArray(scopes) && Object.keys(scopes).length === 0) {
    const { objectScopes: _empty, ...rest } = settings
    return rest
  }
  return settings
}

/** Partition a DiagramDoc into its diff dimensions (drops comments + checkpoints). */
function splitDiagramDoc(doc: DiagramDocLike): DiagramDetail {
  const { objectIds, connectionIds, groupIds, layouts, flows, comments, checkpoints, ...settings } = doc
  void comments
  void checkpoints
  return {
    settings: withoutEmptyObjectScopes(settings as Record<string, unknown>),
    objectIds: objectIds ?? [],
    connectionIds: connectionIds ?? [],
    groupIds: groupIds ?? [],
    layouts: layouts ?? {},
    flows: flows ?? {},
  }
}

export async function materializeFullModel(
  repo: SealedRepo,
  rootUrl: string,
  atHeads?: HeadsMap
): Promise<FullModel> {
  const missing: MissingDoc[] = []
  const empty = (): FullModel => ({
    objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    diagrams: {}, missing,
  })

  const root = await materializeDoc<RootLike & object>(repo, rootUrl, atHeads, missing, 'root', true)
  if (!root) throw new Error(`materializeFullModel: root unavailable (${rootUrl})`)

  const model = empty()

  // --- Model collections (sharded ModelMeta + shards, or monolithic ModelDoc) ---
  // These are CRITICAL: a missing model doc throws (a partial model corrupts the diff).
  if (root.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl)) {
    const meta = await materializeDoc<MetaLike & object>(repo, root.modelMetaUrl, atHeads, missing, 'modelMeta', true)
    if (meta) {
      Object.assign(model.groups, meta.groups ?? {})
      Object.assign(model.domains, meta.domains ?? {})
      Object.assign(model.tagSnapshots, meta.tagSnapshots ?? {})
      // Object/connection shards — last-wins (the edits overlay is appended last), then
      // honour delete tombstones (mirrors projectorService.extractModelEntities).
      for (const u of meta.objectShardUrls ?? []) {
        const s = await materializeDoc<ObjShardLike & object>(repo, u, atHeads, missing, 'objectShard', true)
        if (s?.objects) Object.assign(model.objects, s.objects)
      }
      for (const u of meta.connectionShardUrls ?? []) {
        const s = await materializeDoc<ConnShardLike & object>(repo, u, atHeads, missing, 'connectionShard', true)
        if (s?.connections) Object.assign(model.connections, s.connections)
      }
      for (const u of meta.decisionRecordShardUrls ?? []) {
        const s = await materializeDoc<DecisionRecordShardLike & object>(
          repo, u, atHeads, missing, 'decisionRecordShard', true,
        )
        if (s?.decisionRecords) Object.assign(model.decisionRecords, s.decisionRecords)
      }
      Object.assign(model.decisionRecords, meta.decisionRecords ?? {})
      for (const id of meta.deletedObjectIds ?? []) delete model.objects[id]
      for (const id of meta.deletedConnectionIds ?? []) delete model.connections[id]
      for (const id of meta.deletedDecisionRecordIds ?? []) delete model.decisionRecords[id]
    }
  } else if (root.modelUrl && isValidAutomergeUrl(root.modelUrl)) {
    const m = await materializeDoc<ModelLike & object>(repo, root.modelUrl, atHeads, missing, 'model', true)
    if (m) {
      Object.assign(model.objects, m.objects ?? {})
      Object.assign(model.connections, m.connections ?? {})
      Object.assign(model.groups, m.groups ?? {})
      Object.assign(model.domains, m.domains ?? {})
      Object.assign(model.tagSnapshots, m.tagSnapshots ?? {})
      Object.assign(model.decisionRecords, m.decisionRecords ?? {})
    }
  }

  // --- Registry shards (CRITICAL) → diagrams (+ each DiagramDoc body, fail-safe) ---
  for (const shardUrl of root.shardUrls ?? []) {
    const shard = await materializeDoc<RegistryShardLike & object>(repo, shardUrl, atHeads, missing, 'registryShard', true)
    if (!shard?.diagrams) continue
    for (const [id, dmeta] of Object.entries(shard.diagrams)) {
      const full: FullDiagram = { id, meta: dmeta as Record<string, unknown> }
      // A diagram body is NOT critical — an unreadable one becomes a fail-safe conflict.
      const doc = dmeta.docUrl
        ? await materializeDoc<DiagramDocLike & object>(repo, dmeta.docUrl, atHeads, missing, 'diagram', false)
        : undefined
      if (doc) full.detail = splitDiagramDoc(doc)
      model.diagrams[id] = full
    }
  }

  // One deep clone strips any remaining Automerge proxies → safe to diff + JSON-serialize.
  return plain(model)
}
