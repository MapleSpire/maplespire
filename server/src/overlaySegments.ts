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
import { noteServerCreationPlacement } from './rbac/serverCreationPlacement.js'
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
  /**
   * The creator is the workspace's OWNER writing into its own workspace (the
   * ordinary projector's head rotation, `ordinaryHeadRotator.ts`): take the
   * owner-tier placement note `createClaimedDocument` takes, in the same
   * synchronous frame as the mint, so the segment's first save reaches the
   * storage fence with this workspace's lease to check. Ignored with `scope`.
   * Off for the existing callers, whose behaviour this does not change.
   */
  ownerPlacement?: boolean
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

/**
 * At most this much of a segment's entities (their JSON) per change when a
 * segment is created WITH content (`createClaimedOverlaySegment`, a fold
 * product). Measured on the Mac (automerge 3.2.6, a fold of 8 fleet-shaped
 * heads: 80 entities, 130 KB of JSON, strings as text): one creating change
 * of all of them 45–50 ms (`Automerge.from` alone), ~96 ms as the one task
 * the fold ran; 16 KiB through `DocHandle.change` (10 entities) 22 ms for
 * the first change, 7–14 after; 8 KiB (5 entities) 14 ms for the first,
 * 4–9 after. The PC under the profiler runs about 1.7× slower.
 */
export const OVERLAY_CONTENT_CHUNK_BYTES = 8_192

/** `entities` cut into runs of at most `budget` bytes of JSON each, in
 * insertion order; an entity larger than the budget is a run of its own.
 * Pure. */
export function overlayContentChunks(
  entities: Record<string, unknown>,
  budget = OVERLAY_CONTENT_CHUNK_BYTES,
): Array<Array<[string, unknown]>> {
  const chunks: Array<Array<[string, unknown]>> = []
  let chunk: Array<[string, unknown]> = []
  let bytes = 0
  for (const entry of Object.entries(entities)) {
    const size = (JSON.stringify(entry[1]) ?? '').length + entry[0].length
    if (chunk.length && bytes + size > budget) {
      chunks.push(chunk)
      chunk = []
      bytes = 0
    }
    chunk.push(entry)
    bytes += size
  }
  if (chunk.length) chunks.push(chunk)
  return chunks
}

/** A segment build stopped by its `proceed` (see
 * {@link createClaimedOverlaySegment}): `documentId` names the unclaimed,
 * unnamed document it leaves, for the caller to give its lease back. */
export class OverlaySegmentAbortedError extends Error {
  constructor(readonly documentId: string) {
    super(`overlay segment ${documentId}: build stopped before its claim`)
    this.name = 'OverlaySegmentAbortedError'
  }
}

/**
 * The first half of {@link createSegment}: an EMPTY overlay segment, made
 * durable, then claimed for its workspace — and NOT yet named by anything.
 * Exported for a caller that has its own steps to take between the claim and
 * the ModelMeta change ({@link publishOverlaySegment}): the ordinary head
 * rotator records the retirement of the head it replaces in between
 * (`ordinaryHeadRotator.ts`). A failure here leaves at worst a flushed,
 * unreferenced orphan for GC; nothing points at it.
 */
export async function createClaimedOverlaySegment(
  repo: SealedRepo,
  collection: OverlayCollection,
  onDocumentTouched?: DocumentTouched,
  claim?: OverlaySegmentClaim,
  /** The segment's content at birth (an ordinary chain fold's product and
   * its `foldedFromUrls`, `ordinaryChainFoldWriter.ts`): the extra top-level
   * fields in its creating change, the collection's entities in the changes
   * after it, `OVERLAY_CONTENT_CHUNK_BYTES` of them each, one macrotask
   * apiece (`overlayContentChunks`), every one before the flush. Absent: an
   * empty segment, in one creating change, as before. `proceed`, asked
   * before every chunk and before the claim: false stops the build there
   * (no further change, no claim) with {@link OverlaySegmentAbortedError} —
   * a projector stopped mid-build. `beforeClaim`, awaited after the flush
   * and before the claim: whatever it throws stops the build there, unclaimed
   * (the fold's write-fence check). */
  content?: {
    entities?: Record<string, unknown>
    fields?: Record<string, unknown>
    proceed?: () => boolean
    beforeClaim?: () => Promise<void>
  },
): Promise<DocHandle<ShardDoc>> {
  // One of the widenings back to `Repo` listed in `sealedRepo.ts`. An overlay
  // segment must take its residency lease (`onDocumentTouched`) between
  // `whenReady` and `flush` — `Repo.flush` silently skips any id whose handle
  // is not ready — and `createClaimedDocument`'s fixed order has no slot for
  // that. Only `applyMerge` (which holds an unsealed `Repo`) passes
  // `onDocumentTouched`; the sealed `modelOps` caller passes `undefined`.
  // Created through the caller's scope when it has one (see
  // `OverlaySegmentClaim.scope`); synchronous either way.
  // `writeBatchIds` from birth: every writer pushes its batch id there, and two
  // writers creating the list lazily on a fresh head hide one batch id (see
  // `buildModelMeta`'s tombstone lists, the same loss).
  const initial = {
    ...content?.fields, [collection]: {}, writeBatchIds: [],
  } as unknown as ShardDoc
  const handle = claim?.scope
    ? claim.scope.create<ShardDoc>(repo as Repo, initial)
    : (repo as Repo).create<ShardDoc>(initial)
  // Synchronous, before any await — see `OverlaySegmentClaim.ownerPlacement`
  // and `createClaimedDocument` for why one await here would let the first
  // save land unfenced.
  if (claim?.ownerPlacement && !claim.scope) {
    noteServerCreationPlacement(String(handle.documentId), claim.workspace)
  }
  await handle.whenReady()
  onDocumentTouched?.(handle as DocHandle<unknown>)
  // The entities, a bounded change per macrotask (G4-16, M3): one creating
  // change holding a whole fold product was ONE synchronous wasm call
  // (`Automerge.from` plus its patches), 45–80 ms for 80 fleet-shaped
  // entities, on the owner cell's event loop. Nothing names this document
  // before the flush and the claim below, so no reader sees it part-built;
  // a crash mid-way leaves an unnamed orphan, as a crash before the flush
  // always could. Last wins within the map, as in one change: ids are
  // distinct keys. A TIMER, not `setImmediate`: called from an I/O callback,
  // the first `setImmediate` runs in the same loop iteration, before any
  // timer, and the first chunk would join the work before it in one block.
  const proceedOrAbort = () => {
    if (content?.proceed && !content.proceed()) throw new OverlaySegmentAbortedError(String(handle.documentId))
  }
  for (const chunk of overlayContentChunks(content?.entities ?? {})) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    proceedOrAbort()
    handle.change((doc) => {
      const map = doc[collection]!
      for (const [id, value] of chunk) map[id] = value as Record<string, unknown>
    })
  }
  await repo.flush([handle.documentId])
  proceedOrAbort()
  await content?.beforeClaim?.()
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
  return handle
}

/**
 * The second half of {@link createSegment}: ONE ModelMeta change that makes
 * `url` the current write head of `collection`, appended to the segment list
 * and to the shard list (so it is overlaid last and stays reachable for GC).
 * The caller owns the precondition — `url` durable and claimed — which is
 * what {@link createClaimedOverlaySegment} establishes.
 */
export function publishOverlaySegment(
  metaHandle: Pick<DocHandle<OverlayMetaLike>, 'change'>,
  collection: OverlayCollection,
  url: string,
): void {
  const field = fields(collection)
  metaHandle.change((meta) => {
    const segments = overlaySegmentUrls(meta, collection)
    if (!segments.includes(url)) segments.push(url)
    meta[field.segments] = segments
    meta[field.current] = url
    meta.editsOverlayWriteHeadVersion = OVERLAY_WRITE_HEAD_VERSION
    // Assign, then RE-READ: `meta[f] ?? (meta[f] = [])` yields the plain `[]`,
    // not the document's list, and the push into it is lost.
    if (!meta[field.shards]) meta[field.shards] = []
    const shardUrls = meta[field.shards] as string[]
    if (!shardUrls.includes(url)) shardUrls.push(url)
  })
}

async function createSegment(
  repo: SealedRepo,
  metaHandle: DocHandle<OverlayMetaLike>,
  collection: OverlayCollection,
  onDocumentTouched?: DocumentTouched,
  claim?: OverlaySegmentClaim,
): Promise<DocHandle<ShardDoc>> {
  const handle = await createClaimedOverlaySegment(repo, collection, onDocumentTouched, claim)
  publishOverlaySegment(metaHandle, collection, handle.url)
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
      if (!doc[collection]) doc[collection] = {}
      const target = doc[collection]
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
