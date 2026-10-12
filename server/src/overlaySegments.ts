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
  type DocumentId,
  type Repo,
} from '@automerge/automerge-repo'
import { findReadyDocument } from './automergeRepoCompat.js'
import { envNumber } from './envNumber.js'
import { notifyWorkspaceDocumentCreated, type WorkspaceKey } from './rbac/docScope.js'
import type { SealedRepo } from './rbac/sealedRepo.js'
import type { BootstrapScope } from './bootstrapScope.js'
import { OVERLAY_WRITE_HEAD_VERSION } from './modelMeta.js'

export type OverlayCollection = 'objects' | 'connections'
type ShardDoc = Record<string, Record<string, unknown>>
type DocumentTouched = (handle: DocHandle<unknown>) => void

/** Claim-at-write context for the segments this module CREATES. Optional
 * because DB-free unit suites drive these functions without a doc index; the
 * production writers (applyMerge, the AI model ops) always pass it. */
export interface OverlaySegmentClaim {
  workspace: WorkspaceKey
  rootUrl: string
  /**
   * Bootstrap scope of the caller. A new segment is flushed before it is
   * claimed, so without a scope its first save reaches the storage fence with
   * no lease to check. When supplied, the segment is created through the
   * scope: named for the workspace, noted under the forker's lease, and fenced
   * on every save until the claim commits. `applyMerge` supplies it; the
   * sealed `modelOps` caller does not and falls back to `repo.create`.
   */
  scope?: BootstrapScope
}

export interface OverlayMetaLike {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  editsObjectShardUrl?: string
  editsObjectShardUrls?: string[]
  editsConnectionShardUrl?: string
  editsConnectionShardUrls?: string[]
  editsOverlayWriteHeadVersion?: number
  [key: string]: unknown
}

// `AM_OVERLAY_SEGMENT_SIZE` has two floors on the server: 32 for batch writes
// here (`DEFAULT_SEGMENT_SIZE`) and 8 for the projector's head rotation
// (`OVERLAY_SEGMENT_SIZE`), so a value of 16 gives 32 and 16 respectively.
// Blank/invalid values fall back to 32 for both, and values above 4096 are
// clamped. Reconciling the floors would change segment layout.
//
// The browser has a third copy: `bridge.ts` reads `VITE_OVERLAY_SEGMENT_SIZE`
// (a different env var) with its own floor of 8. A mismatch only produces a
// spurious client timeline marker, not a write defect.
//
// Parsed once: two `envNumber` calls on one knob would emit any
// `env.knob_rejected` warning twice.
const PARSED_SEGMENT_SIZE = envNumber('AM_OVERLAY_SEGMENT_SIZE', {
  fallback: 32, minimum: 1, maximum: 4_096, integer: true,
})
const DEFAULT_SEGMENT_SIZE = Math.max(32, PARSED_SEGMENT_SIZE)

/**
 * The floor-8 reading of the same knob — the one the SERVER-SIDE ROTATION
 * decides on. `staticDeltaProjector.maybeRotateOverlayHead` schedules a
 * rotation as soon as the current head's entity count OR its unique write-batch
 * count reaches this, so it is the promise "an overlay write head stays small",
 * and the only number against which a head can be called too big.
 *
 * Exported so the fsck detector (`overlay-head-bounded`) derives its ceiling
 * from this value instead of restating it.
 */
export const OVERLAY_SEGMENT_SIZE = Math.max(8, PARSED_SEGMENT_SIZE)

const fields = (collection: OverlayCollection) => collection === 'objects'
  ? {
      shards: 'objectShardUrls' as const,
      current: 'editsObjectShardUrl' as const,
      segments: 'editsObjectShardUrls' as const,
    }
  : {
      shards: 'connectionShardUrls' as const,
      current: 'editsConnectionShardUrl' as const,
      segments: 'editsConnectionShardUrls' as const,
    }

export function overlaySegmentUrls(meta: OverlayMetaLike | undefined, collection: OverlayCollection): string[] {
  const field = fields(collection)
  const urls = [...(meta?.[field.segments] ?? [])]
    .filter((url): url is string => typeof url === 'string' && isValidAutomergeUrl(url))
  const current = meta?.[field.current]
  if (typeof current === 'string' && isValidAutomergeUrl(current)) {
    const index = urls.indexOf(current)
    if (index >= 0) urls.splice(index, 1)
    urls.push(current)
  }
  return [...new Set(urls)]
}

async function findShard(
  repo: SealedRepo,
  url: string,
  onDocumentTouched?: DocumentTouched,
): Promise<DocHandle<ShardDoc>> {
  const handle = await findReadyDocument<ShardDoc>(repo, url)
  onDocumentTouched?.(handle as DocHandle<unknown>)
  return handle
}

async function createSegment(
  repo: SealedRepo,
  metaHandle: DocHandle<OverlayMetaLike>,
  collection: OverlayCollection,
  onDocumentTouched?: DocumentTouched,
  claim?: OverlaySegmentClaim,
): Promise<DocHandle<ShardDoc>> {
  const field = fields(collection)
  // One of the widenings back to `Repo` listed in `sealedRepo.ts`. An overlay
  // segment must take its residency lease (`onDocumentTouched`) between
  // `whenReady` and `flush` — `Repo.flush` silently skips any id whose handle
  // is not ready — and `createClaimedDocument`'s fixed order has no slot for
  // that. Only `applyMerge` (which holds an unsealed `Repo`) passes
  // `onDocumentTouched`; the sealed `modelOps` caller passes `undefined`.
  // Created through the caller's scope when it has one (see
  // `OverlaySegmentClaim.scope`); synchronous either way.
  const handle = claim?.scope
    ? claim.scope.create<ShardDoc>(repo as Repo, { [collection]: {} } as ShardDoc)
    : (repo as Repo).create<ShardDoc>({ [collection]: {} } as ShardDoc)
  await handle.whenReady()
  onDocumentTouched?.(handle as DocHandle<unknown>)
  await repo.flush([handle.documentId])
  // Order: durable → claimed → only then does ModelMeta learn the URL. A
  // claim failure aborts the write before any pointer exists; the flushed
  // orphan is left for GC rather than published as a dangling reference.
  if (claim) {
    await notifyWorkspaceDocumentCreated({
      ...claim.workspace,
      rootUrl: claim.rootUrl,
      documentId: String(handle.documentId),
    })
  }
  metaHandle.change((meta) => {
    const segments = overlaySegmentUrls(meta, collection)
    if (!segments.includes(handle.url)) segments.push(handle.url)
    meta[field.segments] = segments
    meta[field.current] = handle.url
    meta.editsOverlayWriteHeadVersion = OVERLAY_WRITE_HEAD_VERSION
    const shardUrls = (meta[field.shards] ?? (meta[field.shards] = [])) as string[]
    if (!shardUrls.includes(handle.url)) shardUrls.push(handle.url)
  })
  return handle
}

/** Write a large server-side batch into bounded last-wins segments. */
export async function writeOverlayEntities(
  repo: SealedRepo,
  metaHandle: DocHandle<OverlayMetaLike>,
  collection: OverlayCollection,
  entities: Record<string, unknown>,
  segmentSize = DEFAULT_SEGMENT_SIZE,
  onDocumentTouched?: DocumentTouched,
  claim?: OverlaySegmentClaim,
): Promise<DocumentId[]> {
  const entries = Object.entries(entities)
  if (!entries.length) return []
  const touchedDocumentIds = new Set<DocumentId>()
  const urls = overlaySegmentUrls(metaHandle.doc(), collection)
  let current = urls.length
    ? await findShard(repo, urls.at(-1)!, onDocumentTouched)
    : await createSegment(repo, metaHandle, collection, onDocumentTouched, claim)
  touchedDocumentIds.add(current.documentId)
  let currentIds = new Set(Object.keys(current.doc()?.[collection] ?? {}))
  // Rotate a legacy/full segment before writing, including repeated edits to a
  // single identity, so its Automerge history cannot grow without bound.
  if (currentIds.size >= segmentSize) {
    current = await createSegment(repo, metaHandle, collection, onDocumentTouched, claim)
    touchedDocumentIds.add(current.documentId)
    currentIds = new Set()
  }

  let batch: Record<string, unknown> = {}
  const flush = () => {
    const values = batch
    if (!Object.keys(values).length) return
    current.change((doc) => {
      const target = doc[collection] ?? (doc[collection] = {})
      for (const [id, value] of Object.entries(values)) target[id] = value as Record<string, unknown>
    })
    batch = {}
  }
  for (const [id, value] of entries) {
    if (!currentIds.has(id) && currentIds.size >= segmentSize) {
      flush()
      current = await createSegment(repo, metaHandle, collection, onDocumentTouched, claim)
      touchedDocumentIds.add(current.documentId)
      currentIds = new Set()
    }
    batch[id] = value
    currentIds.add(id)
  }
  flush()
  return [...touchedDocumentIds]
}

/** Remove tombstoned values from every still-referenced segment. */
export async function deleteOverlayEntities(
  repo: SealedRepo,
  metaHandle: DocHandle<OverlayMetaLike>,
  collection: OverlayCollection,
  ids: string[],
  onDocumentTouched?: DocumentTouched,
): Promise<DocumentId[]> {
  if (!ids.length) return []
  const touchedDocumentIds: DocumentId[] = []
  const idSet = new Set(ids)
  for (const url of overlaySegmentUrls(metaHandle.doc(), collection)) {
    const handle = await findShard(repo, url, onDocumentTouched)
    touchedDocumentIds.push(handle.documentId)
    handle.change((doc) => {
      const target = doc[collection]
      if (!target) return
      for (const id of idSet) delete target[id]
    })
  }
  return touchedDocumentIds
}
