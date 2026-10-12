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
import { isValidAutomergeUrl, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { repo, getRootHandle, getRegistryShardHandles, findModelMetaHandle, prepareDocumentRequest } from './repo'
import { restoreDocToHeads } from './history'
import { mergeShards } from './projection'
import { currentWorkspaceRef, type WorkspaceRef } from './workspace'
import { isBootFromServerActive } from './bridge'
import type { ModelMeta, RegistryShard } from './types'

/**
 * Landscape VERSIONS — a version is a head-manifest over a workspace's Automerge
 * documents (the generalisation of the per-diagram `Checkpoint{heads}` primitive
 * to the whole landscape). Capturing reads each doc's heads; restoring rolls each
 * doc back to its captured heads via `restoreDocToHeads` (write-past-as-new-change,
 * itself undoable). The "current" version is just the live heads — only NAMED
 * versions are persisted (server-side, as an opaque JSONB manifest).
 *
 * This module is deliberately DECOUPLED from the bridge: it enumerates the doc
 * graph straight from the root (mirroring the server read-model projector and the
 * share whole-landscape snapshot), so capture/restore work without reaching into
 * the bridge's module state. The bridge's existing change listeners re-project the
 * model + active diagram automatically after a restore.
 */

export type WorkspaceDocKind =
  | 'model'
  | 'modelMeta'
  | 'objectShard'
  | 'connectionShard'
  | 'decisionRecordShard'
  | 'registryShard'
  | 'diagram'

export interface WorkspaceDocRef {
  url: string
  kind: WorkspaceDocKind
  /** Set for `kind === 'diagram'`. */
  diagramId?: string
}

export interface VersionDocHeads extends WorkspaceDocRef {
  heads: string[]
}

/** The persisted shape of a named version's content (stored opaquely server-side). */
export interface VersionManifest {
  schema: 1
  capturedAt: string
  landscapeId: string
  versionId: string
  docs: VersionDocHeads[]
}

type AnyDocHandle = DocHandle<Record<string, unknown>>

async function ready(url: string): Promise<AnyDocHandle | null> {
  if (!isValidAutomergeUrl(url)) return null
  try {
    prepareDocumentRequest(url, 'version-operation')
    const handle = await repo.find<Record<string, unknown>>(url as AutomergeUrl)
    await handle.whenReady()
    return handle
  } catch (err) {
    console.error('[versions] could not resolve doc', url, err)
    return null
  }
}

/**
 * Enumerate every document that makes up a workspace, from the root: the model
 * (monolith, or sharded = modelMeta + object/connection shards), the registry
 * shards, and every diagram doc. Mirrors `extractModelEntities` on the server and
 * `buildShareSnapshot`'s whole-landscape walk on the client.
 */
export async function enumerateWorkspaceDocs(
  ref: WorkspaceRef = currentWorkspaceRef()
): Promise<WorkspaceDocRef[]> {
  const rootHandle = await getRootHandle(ref)
  const root = rootHandle.doc()
  if (!root) return []
  const refs: WorkspaceDocRef[] = []

  // Model: prefer the sharded model (modelMeta + shards); fall back to monolith.
  if (root.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl)) {
    refs.push({ url: root.modelMetaUrl, kind: 'modelMeta' })
    const metaHandle = await findModelMetaHandle(root.modelMetaUrl).catch(() => null)
    const meta = metaHandle?.doc() as ModelMeta | undefined
    for (const u of meta?.objectShardUrls ?? []) refs.push({ url: u, kind: 'objectShard' })
    for (const u of meta?.connectionShardUrls ?? []) refs.push({ url: u, kind: 'connectionShard' })
    for (const u of meta?.decisionRecordShardUrls ?? []) refs.push({ url: u, kind: 'decisionRecordShard' })
  } else if (root.modelUrl && isValidAutomergeUrl(root.modelUrl)) {
    refs.push({ url: root.modelUrl, kind: 'model' })
  }

  // Registry shards + the diagram docs they reference.
  const shardHandles = await getRegistryShardHandles(ref)
  for (const h of shardHandles) refs.push({ url: h.url, kind: 'registryShard' })
  const metas = mergeShards(
    shardHandles.map((h) => (h.doc() as RegistryShard | undefined) ?? { diagrams: {} })
  )
  for (const m of metas) {
    if (m.docUrl && isValidAutomergeUrl(m.docUrl)) {
      refs.push({ url: m.docUrl, kind: 'diagram', diagramId: m.id })
    }
  }
  return refs
}

/**
 * Capture the current heads of every workspace doc into a manifest. Read-only
 * (no writes), so it is always safe; the cost is loading any not-yet-resident
 * diagram docs (an explicit, occasional action).
 */
export async function captureLandscapeManifest(
  ref: WorkspaceRef = currentWorkspaceRef()
): Promise<VersionManifest> {
  const refs = await enumerateWorkspaceDocs(ref)
  // Fail LOUD if any enumerated doc can't be resolved: a manifest that silently
  // omits a doc would, on restore, leave that doc at its current (newer) state —
  // a corrupt mixed-version landscape. Better to refuse to capture than to persist
  // an incomplete "version" that looks complete.
  const docs = await Promise.all(
    refs.map(async (r): Promise<VersionDocHeads> => {
      const handle = await ready(r.url)
      const doc = handle?.doc()
      if (!doc) {
        throw new Error(`Cannot capture version: document unavailable (${r.kind} ${r.url})`)
      }
      return { ...r, heads: getHeads(doc) }
    })
  )
  return {
    schema: 1,
    capturedAt: new Date().toISOString(),
    landscapeId: ref.landscapeId,
    versionId: ref.versionId,
    docs,
  }
}

export interface RestoreResult {
  restored: number
  failed: number
}

/**
 * Restore the workspace to a captured manifest: roll every doc in the manifest
 * back to its captured heads (write-past-as-new-change, undoable). The bridge's
 * listeners re-project the model + active diagram afterwards; non-active diagrams
 * are restored in storage and re-project when next opened. Docs created AFTER the
 * version are left as orphans (the restored registry no longer references them),
 * which is correct for an exact restore.
 */
export async function restoreLandscapeManifest(manifest: VersionManifest): Promise<RestoreResult> {
  // Boot-from-server projects the canvas from the SERVER read-model render and
  // routes edits through an in-memory overlay (not the resident shards). A local
  // restore of the shards wouldn't show up there and would be re-clobbered by the
  // next overlay flush — so it is not supported in that mode yet.
  // Checked against the RESOLVED per-workspace mode (not the raw flag): a monolith
  // workspace boots classic even with the flag on, and restore works fine there.
  if (isBootFromServerActive()) {
    throw new Error('Restoring a version is not supported in boot-from-server mode yet.')
  }
  let restored = 0
  let failed = 0
  for (const d of manifest.docs) {
    const handle = await ready(d.url)
    if (handle && restoreDocToHeads(handle, d.heads)) restored++
    else failed++
  }
  return { restored, failed }
}
