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

import { getHeads } from '@automerge/automerge'
import { isValidAutomergeUrl, type Repo } from '@automerge/automerge-repo'
import { findReadyDocument } from '../automergeRepoCompat.js'

/**
 * Server-side capture of a root's per-document Automerge heads — the 3-way-merge
 * BASE for a draft. A draft is a fork of the landscape's default version; we record
 * the PARENT's doc urls + heads at fork time, and the parent docs keep that history,
 * so the base state is later reconstructable via `view(parentDoc, baseHeads)`.
 *
 * Mirrors the client `captureLandscapeManifest` (src/lib/automerge/landscapeVersions.ts)
 * and the `forkRoot` whole-graph walk, but runs on the server with the repo's handles.
 * CRITICAL: heads are read with `getHeads(handle.doc())` (raw hex), NEVER
 * `handle.heads()` (which returns repo-tagged UrlHeads that the Automerge core
 * `view`/`getHistory` reject).
 */

export type DocKind =
  | 'root'
  | 'model'
  | 'modelMeta'
  | 'objectShard'
  | 'connectionShard'
  | 'decisionRecordShard'
  | 'registryShard'
  | 'diagram'

export interface DocHeads {
  url: string
  kind: DocKind
  /** Set for `kind === 'diagram'`. */
  diagramId?: string
  heads: string[]
}

export interface RootManifest {
  schema: 1
  capturedAt: string
  rootUrl: string
  docs: DocHeads[]
}

/**
 * Large static workspaces cannot afford an eager walk/copy of every model shard
 * and DiagramDoc. Their draft instead starts as a bounded overlay and lazily
 * forks a diagram the first time it is opened. The relational read-model keeps
 * the immutable baseline; `diagramBases` records the initial heads of each lazy
 * clone so the ordinary three-way differ can still reconstruct an exact base.
 */
export interface SparseDraftDiagramBase {
  docUrl: string
  heads: string[]
  sourceDocUrl: string
}

export interface SparseDraftManifest {
  schema: 2
  mode: 'sparse-static'
  createdAt: string
  rootUrl: string
  parentVersionId: string
  diagramBases: Record<string, SparseDraftDiagramBase>
}

export type DraftBaseManifest = RootManifest | SparseDraftManifest

export function isSparseDraftManifest(value: unknown): value is SparseDraftManifest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SparseDraftManifest>
  return candidate.schema === 2
    && candidate.mode === 'sparse-static'
    && typeof candidate.rootUrl === 'string'
    && typeof candidate.parentVersionId === 'string'
    && !!candidate.diagramBases
    && typeof candidate.diagramBases === 'object'
}

interface RootLike { modelUrl?: string; modelMetaUrl?: string; shardUrls?: string[] }
interface MetaLike {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  decisionRecordShardUrls?: string[]
}
interface ShardLike { diagrams?: Record<string, { docUrl?: string }> }

async function readDoc<T>(repo: Repo, url: string): Promise<T | undefined> {
  if (!isValidAutomergeUrl(url)) return undefined
  const handle = await findReadyDocument(repo, url)
  return handle.doc() as T
}

/**
 * Walk a root and capture each doc's heads. Fails LOUD if any enumerated doc can't
 * be resolved: a manifest that silently omits a doc would make the base look like it
 * never had that doc, so the later diff would report the whole subtree as draft-created
 * and a merge could flood the live model with duplicates. Refusing to capture is safer
 * than persisting an incomplete base.
 */
export async function captureRootManifest(repo: Repo, rootUrl: string): Promise<RootManifest> {
  const docs: DocHeads[] = []
  const capture = async (url: string, kind: DocKind, diagramId?: string): Promise<unknown> => {
    // A referenced doc that's deleted/never-synced makes `repo.find` reject; a
    // resolvable-but-empty one returns undefined. Either way the base would be
    // incomplete, so fail loud with a single clear message.
    let doc: Record<string, unknown> | undefined
    try {
      doc = await readDoc<Record<string, unknown>>(repo, url)
    } catch {
      doc = undefined
    }
    if (!doc) throw new Error(`Cannot capture base manifest: document unavailable (${kind} ${url})`)
    docs.push({ url, kind, diagramId, heads: getHeads(doc) })
    return doc
  }

  const root = (await capture(rootUrl, 'root')) as RootLike

  if (root.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl)) {
    const meta = (await capture(root.modelMetaUrl, 'modelMeta')) as MetaLike
    for (const u of meta.objectShardUrls ?? []) await capture(u, 'objectShard')
    for (const u of meta.connectionShardUrls ?? []) await capture(u, 'connectionShard')
    for (const u of meta.decisionRecordShardUrls ?? []) await capture(u, 'decisionRecordShard')
  } else if (root.modelUrl && isValidAutomergeUrl(root.modelUrl)) {
    await capture(root.modelUrl, 'model')
  }

  for (const shardUrl of root.shardUrls ?? []) {
    const shard = (await capture(shardUrl, 'registryShard')) as ShardLike
    for (const [id, dmeta] of Object.entries(shard.diagrams ?? {})) {
      if (dmeta.docUrl && isValidAutomergeUrl(dmeta.docUrl)) {
        await capture(dmeta.docUrl, 'diagram', id)
      }
    }
  }

  return { schema: 1, capturedAt: new Date().toISOString(), rootUrl, docs }
}
