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
  type DocumentId,
  type Repo,
} from '@automerge/automerge-repo'
import { cachedHandles, findReadyDocument } from '../automergeRepoCompat.js'
import type { AutomergeResidencyLeases } from '../automergeResidency.js'
import type { WorkspaceKey } from '../rbac/docScope.js'
import type { Queryable } from '../readModel/types.js'

/** Drop mutable workspace handles retained by a former/standby generation.
 * The root stays resident because it is a transport core document; its child
 * pointers are stable while ModelMeta and overlay shards are mutable. The next
 * access reloads every evicted child from shared durable storage. */
export async function evictWorkspaceDocumentCache(
  repo: Repo,
  db: Queryable,
  workspace: WorkspaceKey,
  /** Optional, but pass it whenever one exists. This is the second eviction
   * path in the process, and components that track document residency —
   * `WorkspaceDocIndex` above all — learn a watcher was orphaned only through
   * these listeners. An eviction nobody announces is one nobody can repair. */
  residency?: Pick<AutomergeResidencyLeases, 'notifyBeforeEvict' | 'forgetAmbientListener'> | null,
): Promise<number> {
  // ONE read of the O(n) getter, then indexed locally. The cache is the
  // required authority here: this key list is what the SQL below filters the
  // durable mapping by, so a document missing from it is a document this
  // failover silently declines to evict.
  const handles = cachedHandles(repo)
  const cachedDocumentIds = Object.keys(handles)
  if (cachedDocumentIds.length === 0) return 0

  // A performance workspace can own tens of thousands of diagrams while a
  // standby normally retains only a handful of handles. Filter the durable
  // mapping by the process-local cache instead of transferring every workspace
  // document id just to discard almost all of them in JavaScript.
  const { rows } = await db.query<{ document_id: string }>(
    `SELECT mapping.document_id
     FROM automerge_document_workspace mapping
     JOIN versions version
       ON version.landscape_id = mapping.landscape_id
      AND version.id = mapping.version_id
     WHERE mapping.landscape_id = $1 AND mapping.version_id = $2
       AND mapping.document_id = ANY($3::text[])
       AND mapping.document_id <> regexp_replace(version.root_url, '^automerge:', '')`,
    [workspace.landscapeId, workspace.versionId, cachedDocumentIds],
  )
  let evicted = 0
  for (const { document_id: documentId } of rows) {
    const handle = handles[documentId as DocumentId]
    if (!handle) continue
    // Ownership admission must not wait for a speculative standby handle to
    // finish its 60s Repo load timeout. It has no authority to persist, and a
    // later load completion is irrelevant once it is detached from the cache.
    // Detaching the persistence listener also prevents DocHandle.unload() from
    // saving A.init() over the durable document (automerge-repo 2.5.6).
    handle.removeAllListeners('heads-changed')
    // Before the handle goes, not after: a listener's whole job is to react
    // while the document it was watching still exists.
    residency?.notifyBeforeEvict(documentId, handle)
    // This path drops the handle without running the census, so the sweep's
    // ambient marker has to go with it.
    residency?.forgetAmbientListener(documentId)
    // Unconditionally — do not branch on `handle.state`: it is `ready` or
    // `deleted` and nothing else (a document that has not received a byte still
    // reads `ready`). Detaching instead of removing would leave the document
    // CACHED but unregistered from the sync layer, invisible to every later
    // `find()`, which is the one state that makes `syncedHandle` lie.
    await repo.removeFromCache(documentId as DocumentId)
    evicted += 1
  }
  return evicted
}

interface RootLike {
  modelUrl?: string
  modelMetaUrl?: string
  registrySummaryOnly?: boolean
}

interface ModelMetaLike {
  editsObjectShardUrl?: string
  editsConnectionShardUrl?: string
}

export interface WorkspaceFailoverPrewarmResult {
  rootUrl: string | null
  documentIds: string[]
  modelKind: 'static-sharded' | 'non-static-deferred' | 'sharded-deferred' | 'monolith-deferred' | 'empty'
}

type ResolveDocument = (url: string) => Promise<unknown>

const documentIdOf = (url: string): string => url.replace(/^automerge:/, '').split('?')[0]

async function mappedWorkspaceDocumentIds(
  db: Queryable,
  workspace: WorkspaceKey,
  urls: string[],
): Promise<Set<string>> {
  const documentIds = [...new Set(urls.map(documentIdOf))]
  if (documentIds.length === 0) return new Set()
  const { rows } = await db.query<{ document_id: string }>(
    `SELECT document_id
     FROM automerge_document_workspace
     WHERE landscape_id = $1 AND version_id = $2
       AND document_id = ANY($3::text[])`,
    [workspace.landscapeId, workspace.versionId, documentIds],
  )
  return new Set(rows.map(({ document_id: documentId }) => documentId))
}

/**
 * Materialize the small mutable control chain a transferred workspace will
 * immediately synchronize: root -> ModelMeta -> current object/connection
 * overlays. The ownership coordinator awaits this hook before publishing the
 * lease locally, so a reconnect storm never becomes the operation that cold
 * loads and merges those write heads.
 *
 * Child references are checked against the durable workspace scope before
 * loading. A corrupt/cross-workspace pointer therefore fails admission instead
 * of warming data that this cell is not authorized to serve.
 */
export async function prewarmWorkspaceFailoverDocuments(
  repo: Repo,
  db: Queryable,
  workspace: WorkspaceKey,
  resolveDocument: ResolveDocument = async (url) => {
    const handle = await findReadyDocument(repo, url)
    return handle.doc()
  },
): Promise<WorkspaceFailoverPrewarmResult> {
  // Consult the cheap relational registry first. Opening even a small root can
  // decode years of Automerge history; doing that for every ordinary workspace
  // made partition readiness depend on unrelated cold data.
  const { rows } = await db.query<{ root_url: string }>(
    `SELECT version.root_url
     FROM versions version
     JOIN read_model_static_workspaces static_workspace
       ON static_workspace.landscape_id = version.landscape_id
      AND static_workspace.version_id = version.id
     WHERE version.id = $1 AND version.landscape_id = $2`,
    [workspace.versionId, workspace.landscapeId],
  )
  if (rows.length === 0) {
    return { rootUrl: null, documentIds: [], modelKind: 'non-static-deferred' }
  }
  const rootUrl = rows[0]?.root_url
  if (!rootUrl || !isValidAutomergeUrl(rootUrl)) {
    throw new Error('workspace has no valid root document to prewarm')
  }

  const loaded = [documentIdOf(rootUrl)]
  const root = (await resolveDocument(rootUrl)) as RootLike | undefined
  if (!root) throw new Error('workspace root was unavailable during failover prewarm')

  if (root.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl)) {
    // The static/server-rendered enterprise format has bounded overlay heads.
    // A regular sharded workspace can still carry a large client-side model
    // history, so treating every sharded root as bounded caused unrelated
    // workspaces to introduce >100 ms decode stalls during partition takeover.
    if (root.registrySummaryOnly !== true) {
      return { rootUrl, documentIds: loaded, modelKind: 'sharded-deferred' }
    }
    const metaUrl = root.modelMetaUrl
    const mappedMeta = await mappedWorkspaceDocumentIds(db, workspace, [metaUrl])
    if (!mappedMeta.has(documentIdOf(metaUrl))) {
      throw new Error('workspace ModelMeta is outside its durable document scope')
    }
    const meta = (await resolveDocument(metaUrl)) as ModelMetaLike | undefined
    if (!meta) throw new Error('workspace ModelMeta was unavailable during failover prewarm')
    loaded.push(documentIdOf(metaUrl))

    const writeHeadUrls = [meta.editsObjectShardUrl, meta.editsConnectionShardUrl]
      .filter((url): url is string => typeof url === 'string' && isValidAutomergeUrl(url))
    const mappedHeads = await mappedWorkspaceDocumentIds(db, workspace, writeHeadUrls)
    for (const url of writeHeadUrls) {
      if (!mappedHeads.has(documentIdOf(url))) {
        throw new Error('workspace write head is outside its durable document scope')
      }
    }
    // Sequential resolution deliberately bounds load/Automerge decode work in
    // one event-loop turn during multi-workspace partition admission.
    for (const url of writeHeadUrls) {
      await resolveDocument(url)
      loaded.push(documentIdOf(url))
    }
    return { rootUrl, documentIds: loaded, modelKind: 'static-sharded' }
  }

  // A legacy monolith can be arbitrarily large. Eagerly decoding every cold
  // monolith assigned to a partition made an unrelated hot workspace wait for
  // seconds during takeover. The scalable sharded path above is bounded; keep
  // legacy data on-demand after its per-workspace lease is exposed.
  if (root.modelUrl && isValidAutomergeUrl(root.modelUrl)) {
    return { rootUrl, documentIds: loaded, modelKind: 'monolith-deferred' }
  }

  return { rootUrl, documentIds: loaded, modelKind: 'empty' }
}
