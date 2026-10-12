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
import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'
import { findReadyDocument } from '../automergeRepoCompat.js'
import { createClaimedDocument } from '../rbac/docScope.js'
import { OVERLAY_WRITE_HEAD_VERSION } from '../modelMeta.js'

/**
 * Overlay compaction (the daily background job).
 *
 * Clients write all object/connection edits (new + edited, on- or off-diagram) into ONE
 * persistent, model-level "edits overlay" shard, kept LAST in ModelMeta.{object,
 * connection}ShardUrls so the read model overlays it last-wins. That overlay grows with
 * cumulative edits; compaction folds it back into the base shards (in place) and clears
 * it, resetting the per-session first-edit fetch cost to ~zero.
 *
 * CRDT-safe under concurrent editing (clients keep writing the overlay during the run):
 *   - we snapshot the overlay, fold the snapshot into the base shards, then CONDITIONALLY
 *     clear — deleting an overlay entry ONLY if it still deep-equals the folded snapshot.
 *     An entry edited since the snapshot differs → it is KEPT for the next run (its old
 *     value was folded, but the read model still reads the newer overlay copy last-wins);
 *   - Automerge map put-wins also protects an edit that lands during the clear change.
 * WHAT THAT ARGUMENT COVERS. It quantifies over ONE compactor and N clients: every
 * writer other than the compactor writes the OVERLAY, which is exactly what the
 * snapshot / conditional-clear pair reasons about. No such edit is lost; at worst a
 * concurrently-edited entry is folded next time.
 *
 * WHAT IT DOES NOT COVER — a SECOND COMPACTOR, which writes the BASE shards and so
 * lies outside everything quantified above. This header therefore claims nothing
 * about two concurrent compactions. They cannot overlap, and the two independent
 * exclusions that prevent it are tested in
 * `compactionExclusionToday.integration.test.ts`: an advisory lock per job NAME
 * refuses a second replica outright, and a single-flight latch joins a second
 * in-process caller to the run already in flight.
 *
 * Two concurrent compactions are UNPROVEN, not safe. Anyone removing or
 * replacing either exclusion (e.g. with per-workspace scheduling) must revisit
 * this argument.
 *
 * The Automerge docs are the source of truth and are always left correct. The Postgres
 * read model is reconciled by the caller (it restarts the projector, whose cold build
 * re-derives overlay-last-wins from the compacted shards).
 */

interface RootLike {
  modelMetaUrl?: string
}
interface MetaLike {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  editsObjectShardUrl?: string
  editsObjectShardUrls?: string[]
  editsConnectionShardUrl?: string
  editsConnectionShardUrls?: string[]
  editsOverlayWriteHeadVersion?: number
  deletedObjectIds?: string[]
  deletedConnectionIds?: string[]
}
/** A model shard read/written structurally: collectionKey → (id → entity). */
type ShardDoc = Record<string, Record<string, unknown>>

/** Max objects/connections per base shard when compaction has to place a newly-created
 * id that has no base shard yet. Mirrors the client's VITE_MODEL_SHARD_SIZE default. */
const DEFAULT_SHARD_SIZE = Number(process.env.AM_MODEL_SHARD_SIZE ?? 512)

export interface CompactionResult {
  objectsFolded: number
  connectionsFolded: number
  /** Entries kept (concurrently edited during the run) — folded on a later pass. */
  objectsKept: number
  connectionsKept: number
  /** Tombstoned ids removed from the base shards + overlay this run. */
  objectsDeleted: number
  connectionsDeleted: number
  /** `projection_not_acknowledged` is deliberately ABSENT: `compactOverlay`
   *  never sets it; it lives on `WorkspaceCompactionSkip`, where the caller
   *  that decides it does. */
  skippedReason?: 'static_baseline' | 'ownership_lost_mid_fold'
}

/**
 * Whether this call may WRITE.
 *
 * Required on `CompactionOptions`, with no default, and that is the whole design:
 * `compactOverlay` rewrites base shards and clears the overlay. A new call site
 * that forgets to say which side it is on must not silently get the
 * destructive one — so the type refuses to compile rather than defaulting.
 */
export type CompactionMode = 'preview' | 'apply'

export interface CompactionOptions {
  /** REQUIRED. See `CompactionMode` — there is deliberately no default. */
  mode: CompactionMode
  /** Objects/connections per shard when placing created ids (tests inject a small one). */
  shardSize?: number
  /** Immutable performance baselines must never be destructively rewritten. */
  staticBaseline?: boolean
  /** Claim-at-write: the workspace the rotated heads and overflow shards
   * belong to. Optional for the DB-free unit suites; the production caller
   * (index.ts's daily job) always passes it — a claim throw aborts the
   * compaction before any pointer is published, and the orphan is GC fodder. */
  workspace?: WorkspaceKey
  /**
   * Re-asked immediately before the FIRST write and again before the destructive
   * CLEAR. Returning false aborts with `skippedReason: 'ownership_lost_mid_fold'`.
   *
   * The caller checks ownership and ordinariness ONCE, before the run. Resolving
   * the base shards is an unbounded await in between — every shard is fetched —
   * and two things can change under it: the lease can move to another cell, and
   * the workspace can be PROMOTED to summary, which hands its base shards to
   * `StaticDeltaProjector` while this compactor is still writing them. A check
   * that happens once answers a question about a moment that has passed.
   *
   * The two consultation points are not symmetric, and that asymmetry is why
   * aborting is safe rather than merely early. Folding into the base is
   * idempotent: the overlay still holds the same entries, the read model reads
   * it last-wins, and the next pass folds again. CLEARING the overlay is the
   * destructive half — the only step after which the base is the sole home of
   * the value. Refusing before the second one is what stops a lost lease from
   * becoming a lost edit.
   *
   * WHAT REFUSING DOES NOT PROMISE: it does not leave the meta document in
   * every respect as it would have been. `editsOverlayWriteHeadVersion` is
   * per-META and means BOTH overlay heads are current-protocol, but it is set by
   * the objects pass; a connections pass that then refuses leaves the flag
   * asserting a version over an unrotated connection head. The empty-collection
   * early return can produce the same half-state. No edit is lost by it; a
   * client can be made to materialise a large history.
   */
  stillSafeToWrite?: () => Promise<boolean>
}

export async function compactOverlay(repo: Repo, rootUrl: string, opts: CompactionOptions): Promise<CompactionResult> {
  const shardSize = opts.shardSize ?? DEFAULT_SHARD_SIZE
  const empty: CompactionResult = {
    objectsFolded: 0, connectionsFolded: 0, objectsKept: 0, connectionsKept: 0,
    objectsDeleted: 0, connectionsDeleted: 0,
  }
  if (opts.staticBaseline) return { ...empty, skippedReason: 'static_baseline' }
  const resolve = async <T>(url: string): Promise<DocHandle<T>> => {
    const h = await findReadyDocument<T>(repo, url)
    return h
  }

  const rootHandle = await resolve<RootLike>(rootUrl)
  const root = rootHandle.doc()
  if (!root?.modelMetaUrl || !isValidAutomergeUrl(root.modelMetaUrl)) return empty
  const metaHandle = await resolve<MetaLike>(root.modelMetaUrl)
  if (!metaHandle.doc()) return empty

  const claim = opts.workspace ? { workspace: opts.workspace, rootUrl } : undefined
  const obj = await foldCollection(repo, resolve, metaHandle, 'objects', 'objectShardUrls', 'editsObjectShardUrl', 'editsObjectShardUrls', 'deletedObjectIds', shardSize, opts.mode, claim, opts.stillSafeToWrite)
  // The connections pass is SKIPPED once the objects pass has refused: the
  // predicate said this process may no longer write, and starting a second
  // collection would be writing anyway. Its own guard would catch it, but
  // relying on that would mean resolving every connection shard first, for a
  // pass already known to be refused.
  const conn = obj.aborted
    ? { folded: 0, kept: 0, deleted: 0, aborted: true as const }
    : await foldCollection(repo, resolve, metaHandle, 'connections', 'connectionShardUrls', 'editsConnectionShardUrl', 'editsConnectionShardUrls', 'deletedConnectionIds', shardSize, opts.mode, claim, opts.stillSafeToWrite)
  if (obj.aborted || conn.aborted) {
    return {
      objectsFolded: obj.folded, connectionsFolded: conn.folded,
      objectsKept: obj.kept, connectionsKept: conn.kept,
      objectsDeleted: obj.deleted, connectionsDeleted: conn.deleted,
      skippedReason: 'ownership_lost_mid_fold',
    }
  }
  return {
    objectsFolded: obj.folded,
    connectionsFolded: conn.folded,
    objectsKept: obj.kept,
    connectionsKept: conn.kept,
    objectsDeleted: obj.deleted,
    connectionsDeleted: conn.deleted,
  }
}

/** Fold one overlay collection (objects OR connections) into its base shards, apply delete
 * tombstones (remove from base shards + overlay, then clear the tombstone list), and clear
 * the folded overlay entries. `collKey` is the in-doc map key; `urlsField`/`overlayField`/
 * `tombstoneField` are the ModelMeta fields. */
async function foldCollection(
  repo: Repo,
  resolve: <T>(url: string) => Promise<DocHandle<T>>,
  metaHandle: DocHandle<MetaLike>,
  collKey: 'objects' | 'connections',
  urlsField: 'objectShardUrls' | 'connectionShardUrls',
  overlayField: 'editsObjectShardUrl' | 'editsConnectionShardUrl',
  overlayUrlsField: 'editsObjectShardUrls' | 'editsConnectionShardUrls',
  tombstoneField: 'deletedObjectIds' | 'deletedConnectionIds',
  shardSize: number,
  mode: CompactionMode,
  claim?: { workspace: WorkspaceKey; rootUrl: string },
  stillSafeToWrite?: () => Promise<boolean>,
): Promise<{ folded: number; kept: number; deleted: number; aborted?: true }> {
  const none = { folded: 0, kept: 0, deleted: 0 }
  const meta = metaHandle.doc()

  // Delete tombstones to apply this run (ids the client deleted but couldn't remove from
  // their base shard). A pure delete creates NO overlay, so tombstones must be handled even
  // when there is no overlay shard. Exclude tombstoned ids from the fold below.
  const tombstones = (meta?.[tombstoneField] ?? []).filter((id): id is string => typeof id === 'string')
  const tombSet = new Set(tombstones)

  // Resolve every bounded overlay segment oldest → newest. Legacy workspaces
  // expose only the singular current pointer and remain fully compatible.
  const overlayUrl = meta?.[overlayField]
  const overlayUrls = [...new Set([
    ...(meta?.[overlayUrlsField] ?? []),
    ...(overlayUrl ? [overlayUrl] : []),
  ].filter((url): url is string => typeof url === 'string' && isValidAutomergeUrl(url)))]
  // The singular pointer is the current writer and must be overlaid last.
  if (overlayUrl && overlayUrls.includes(overlayUrl)) {
    overlayUrls.splice(overlayUrls.indexOf(overlayUrl), 1)
    overlayUrls.push(overlayUrl)
  }
  const overlayHandles = await Promise.all(overlayUrls.map((url) => resolve<ShardDoc>(url)))
  const segmentSnapshots = overlayHandles.map((handle) => ({ ...(handle.doc()?.[collKey] ?? {}) }))
  const snapshot: Record<string, unknown> = {}
  for (const segment of segmentSnapshots) Object.assign(snapshot, segment)
  for (const id of tombSet) delete snapshot[id]
  const ids = Object.keys(snapshot)
  if (ids.length === 0 && tombstones.length === 0) return none

  // Load the base shards (every model shard EXCEPT all overlay segments) — needed for both
  // folding and applying tombstone deletes.
  const overlaySet = new Set(overlayUrls)
  const baseUrls = (meta?.[urlsField] ?? []).filter((u) => !overlaySet.has(u) && isValidAutomergeUrl(u))
  const baseHandles = await Promise.all(baseUrls.map((u) => resolve<ShardDoc>(u)))

  // id → base-shard index (an existing object lives in exactly one base shard).
  const idToShard = new Map<string, number>()
  baseHandles.forEach((h, i) => {
    for (const id of Object.keys(h.doc()?.[collKey] ?? {})) idToShard.set(id, i)
  })

  // Partition overlay ids: EDITS of existing objects (fold in place) vs CREATED objects
  // (no base shard yet — need placement).
  const existingByShard = new Map<number, string[]>()
  const created: string[] = []
  for (const id of ids) {
    const idx = idToShard.get(id)
    if (idx === undefined) created.push(id)
    else {
      const arr = existingByShard.get(idx)
      if (arr) arr.push(id)
      else existingByShard.set(idx, [id])
    }
  }

  // PREVIEW STOPS HERE — after everything has been READ and partitioned, and
  // before the first `.change()` below, which is the first byte this function
  // would write. Everything above resolves documents and builds maps; nothing
  // above mutates. That is the property `compaction.preview.test.ts` pins by
  // spying on `.change()` across every base, overlay and meta handle and
  // asserting the count is exactly zero.
  //
  // The counts are what an apply WOULD produce on this same state: `kept` is
  // non-zero only when an entry was edited between the snapshot and the clear,
  // which cannot happen when no clear runs — so a preview predicts `kept: 0` and
  // the fold count it predicts. `compaction.preview.test.ts` checks that
  // equality so a preview cannot drift from what it forecasts.
  if (mode === 'preview') {
    return { folded: ids.length, kept: 0, deleted: tombstones.length }
  }

  // OWNERSHIP GUARD, first consultation — the last instant before this function writes
  // anything. Everything above was reads, and resolving the base shards is an
  // unbounded await during which the lease can move and the workspace can be
  // promoted to summary. See `CompactionOptions.stillSafeToWrite`.
  if (stillSafeToWrite && !(await stillSafeToWrite())) {
    return { folded: 0, kept: 0, deleted: 0, aborted: true }
  }

  // Fold edits in place — the overlay entry is the authoritative current value, so a
  // full replace is correct (and structurally merges into the CRDT shard).
  for (const [idx, shardIds] of existingByShard) {
    baseHandles[idx].change((s) => {
      const coll = s[collKey] ?? (s[collKey] = {})
      for (const id of shardIds) coll[id] = snapshot[id] as Record<string, unknown>
    })
  }

  // Place created ids: fill base shards that have room, then create new shards for the
  // overflow, splicing their urls BEFORE the overlay url so the overlay stays LAST.
  if (created.length) {
    const counts = baseHandles.map((h) => Object.keys(h.doc()?.[collKey] ?? {}).length)
    let ci = 0
    for (let i = 0; i < baseHandles.length && ci < created.length; i++) {
      const room = shardSize - counts[i]
      if (room <= 0) continue
      const take = created.slice(ci, ci + room)
      baseHandles[i].change((s) => {
        const coll = s[collKey] ?? (s[collKey] = {})
        for (const id of take) coll[id] = snapshot[id] as Record<string, unknown>
      })
      ci += take.length
    }
    while (ci < created.length) {
      const take = created.slice(ci, ci + shardSize)
      // The child must be durable BEFORE any durable document points at it
      // (createEmptyRoot's rule, same as `nextHead` below) — a crash between
      // the meta save and the shard save would otherwise leave a pointer to a
      // document that never reached storage, and a cold client's find() on it
      // never settles. It must also be CLAIMED before then, which is why the
      // filled value is built upfront and handed to the wrapper (created ->
      // flushed -> claimed -> only then the meta splice below).
      const filled = {
        [collKey]: Object.fromEntries(take.map((id) => [id, snapshot[id] as Record<string, unknown>])),
      } as ShardDoc
      const newHandle = claim
        ? await createClaimedDocument<ShardDoc>(repo, claim.workspace, claim.rootUrl, filled)
        : await (async () => {
            const handle = repo.create<ShardDoc>(filled)
            await handle.whenReady()
            await repo.flush([handle.documentId])
            return handle
          })()
      metaHandle.change((m) => {
        const urls = (m[urlsField] ?? (m[urlsField] = [])) as string[]
        const oIdx = urls.findIndex((url) => overlaySet.has(url))
        if (oIdx >= 0) urls.splice(oIdx, 0, newHandle.url)
        else urls.push(newHandle.url)
      })
      ci += take.length
    }
  }

  // Apply delete tombstones: remove each tombstoned id from its base shard + the overlay,
  // then remove ONLY the applied ids from the tombstone list (splice by value so a
  // concurrently-appended tombstone isn't clobbered).
  let deleted = 0
  if (tombstones.length) {
    const delByShard = new Map<number, string[]>()
    for (const id of tombstones) {
      const idx = idToShard.get(id)
      if (idx === undefined) continue
      const arr = delByShard.get(idx)
      if (arr) arr.push(id)
      else delByShard.set(idx, [id])
    }
    for (const [idx, delIds] of delByShard) {
      baseHandles[idx].change((s) => {
        const coll = s[collKey]
        if (coll) for (const id of delIds) delete coll[id]
      })
    }
    for (const overlayHandle of overlayHandles) {
      overlayHandle.change((s) => {
        const coll = s[collKey]
        if (coll) for (const id of tombstones) delete coll[id]
      })
    }
    metaHandle.change((m) => {
      const arr = m[tombstoneField]
      if (!arr) return
      for (let i = arr.length - 1; i >= 0; i--) if (tombSet.has(arr[i])) arr.splice(i, 1)
    })
    deleted = tombstones.length
  }

  // The folded values must be durable in their NEW home before the overlay
  // copies are cleared — the POINTER half of this rule is enforced at shard
  // creation above; this is the VALUE half. A crash that persists the cleared
  // overlay but not the folded base shards would lose the entity from both
  // homes. (The delete path needs no such fence: an unsaved base deletion
  // comes back with an unsaved meta tombstone splice, so the next run
  // re-applies it.)
  await repo.flush([
    ...baseHandles.map((handle) => handle.documentId),
    metaHandle.documentId,
  ])

  // Conditional clear of folded entries: delete an overlay entry ONLY if it's unchanged
  // since the snapshot (compared deep). A concurrent edit makes the current value differ →
  // keep it (folded next run; the read model reads it last-wins meanwhile). put-wins covers
  // an edit landing during this very change.
  // OWNERSHIP GUARD, second consultation — before the DESTRUCTIVE half. Everything
  // above is idempotent: the base now holds the folded values, the overlay still
  // holds them too, and the read model reads the overlay last-wins, so a pass
  // that stops here has changed nothing a reader can observe and the next pass
  // redoes it. Past this point the base becomes the sole home of the value, so a
  // lease that moved during the fold must not be allowed to clear.
  if (stillSafeToWrite && !(await stillSafeToWrite())) {
    // The counts are what ACTUALLY happened, not zeroes. By this line the fold
    // has been applied to the base shards, created ids have been placed, the
    // tombstones have been applied to base + overlay + meta, and ALL of it has
    // been flushed. Reporting `folded: 0` alongside a non-zero `deleted` would
    // be one object making two contradictory claims about a single pass — and it
    // reaches an operator through `POST /api/model/compact`. `kept: 0` is
    // accurate: `keptIds` is populated by the clear, which did not run.
    //
    // Read WITH `skippedReason: 'ownership_lost_mid_fold'`, `folded` here means
    // "folded into the base, and still present in the overlay" — the safe,
    // idempotent half. The next pass folds them again.
    return { folded: ids.length, kept: 0, deleted, aborted: true }
  }

  const keptIds = new Set<string>()
  if (ids.length) {
    overlayHandles.forEach((overlayHandle, segmentIndex) => overlayHandle.change((s) => {
      const coll = (s[collKey] ?? (s[collKey] = {})) as Record<string, unknown>
      for (const [id, captured] of Object.entries(segmentSnapshots[segmentIndex])) {
        if (tombSet.has(id)) continue
        const cur = coll[id]
        if (cur === undefined) continue
        if (JSON.stringify(cur) === JSON.stringify(captured)) delete coll[id]
        else keptIds.add(id)
      }
    }))
  }
  // Never leave the singular pointer on a cleared document with a large CRDT
  // history. New clients resolve only this fresh bounded head; historical URLs
  // remain referenced so stale/offline clients can finish syncing safely.
  // The fresh head is claimed before ModelMeta points at it.
  const nextHeadValue = { [collKey]: {}, writeHeadVersion: 1 } as ShardDoc
  const nextHead = claim
    ? await createClaimedDocument<ShardDoc>(repo, claim.workspace, claim.rootUrl, nextHeadValue)
    : await (async () => {
        const handle = repo.create<ShardDoc>(nextHeadValue)
        await handle.whenReady()
        await repo.flush([handle.documentId])
        return handle
      })()
  metaHandle.change((m) => {
    const segments = [...new Set([...(m[overlayUrlsField] ?? []), nextHead.url])]
    m[overlayUrlsField] = segments
    m[overlayField] = nextHead.url
    const shardUrls = (m[urlsField] ?? (m[urlsField] = [])) as string[]
    if (!shardUrls.includes(nextHead.url)) shardUrls.push(nextHead.url)
    // NOT the same number as `nextHeadValue`'s `writeHeadVersion` above,
    // despite both reading `1`: that one is a per-document lifecycle marker,
    // this one is the meta's protocol version the client compares against.
    // They are free to diverge.
    //
    // The projector does not promote this head to 2: `rotateOverlayHead`
    // promotes only the child IT mints, so a head created here stays at 1 —
    // and since `maybeRotateOverlayHead`'s gate is `>= 2`, a compaction head is
    // scheduled for rotation immediately and REPLACED rather than promoted.
    m.editsOverlayWriteHeadVersion = OVERLAY_WRITE_HEAD_VERSION
  })

  return { folded: ids.length - keptIds.size, kept: keptIds.size, deleted }
}

export interface ProjectionAcknowledgement {
  /** `projector_attached` and `projected >= observed`. */
  readonly acknowledged: boolean
  /**
   * WHICH projector instance published that acknowledgement, or `null` when the
   * row does not say.
   *
   * The caller must compare it to the instance it believes is resident. A row
   * can read `attached = true` with `projected >= observed` and have been
   * written by a projector on ANOTHER cell — after a failover, before this cell's
   * own projector has caught up. Reading only the two numbers turns another
   * cell's progress into this cell's permission to clear the overlay, and
   * clearing is the step after which the base is the value's only home.
   */
  readonly projectorInstanceId: string | null
}

/** Compaction may clear overlay entries only after PostgreSQL has published the
 * same observed generation, AND only when the projector that published it is the
 * one this cell has resident. Otherwise an operational read model could miss an
 * edit during the stop/rebuild window.
 *
 * Named for what it reads rather than `isX`: it answers two questions, and a
 * boolean name for a two-part answer is how the second part gets dropped. */
export async function readProjectionAcknowledgement(
  db: Queryable,
  key: WorkspaceKey,
): Promise<ProjectionAcknowledgement> {
  const { rows } = await db.query<{
    observed_generation: string | number
    projected_generation: string | number
    projector_attached: boolean
    projector_instance_id: string | null
  }>(
    `SELECT observed_generation, projected_generation, projector_attached, projector_instance_id
     FROM read_model_projection_state
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  const row = rows[0]
  return {
    acknowledged: row?.projector_attached === true
      && Number(row.projected_generation) >= Number(row.observed_generation),
    projectorInstanceId: row?.projector_instance_id ?? null,
  }
}
