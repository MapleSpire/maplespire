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

import { create } from 'zustand'
import { workspaceKvStore } from './kvStore'
import { buildModelIndex, applyModelChanges, diffModelChanges, type ModelIndexChanges, type ModelIndexInput } from './modelIndex'
import { isModelPagingEnabled } from './flag'
import { isServerReadModelEnabled } from './tierFlag'
import type { C4Object, Connection } from '../../types'

/**
 * Bumps after each successful index write so paged consumers re-query once the
 * (async) index is fresh — without it, a consumer that ran before the build
 * finished would show stale-empty. Never bumps in resident mode (the sync is a
 * no-op there), so it costs nothing by default.
 */
export const useModelIndexVersion = create<{ version: number }>(() => ({ version: 0 }))

/** Publish that a bounded read-model backend changed.
 *
 * This is intentionally a tiny revision signal rather than model data. Query
 * consumers use it to revalidate the pages they already hold without pulling a
 * whole workspace into Zustand. It is shared by local Automerge index writes and
 * the durable server change-feed replay so same-cardinality remote edits (for
 * example a rename) are observable too. */
export function notifyModelIndexChanged(change?: ModelIndexChange, source?: ModelIndexChangeSource): void {
  const version = useModelIndexVersion.getState().version + 1
  changeLog.push({ version, change: change ?? null, source })
  if (changeLog.length > CHANGE_LOG_LIMIT) changeLog.shift()
  useModelIndexVersion.setState({ version })
}

/**
 * A server read-model invalidation (the SSE stream) — a revision with no ids,
 * TAGGED, so a consumer that asks the server which ids changed can leave it out
 * of `modelIndexChangesSince`. Its own name rather than a tag argument at the
 * call site: dropping the argument there would silently turn every edit into
 * "anything changed" for those consumers, with every test still green
 * (QA lens, measured).
 */
export function notifyServerInvalidation(): void {
  notifyModelIndexChanged(undefined, 'server-invalidation')
}

/**
 * The entities a revision touched, when its producer knows them. A consumer
 * holding a few entities (an inline expansion) re-reads only when one of
 * THEIRS changed, instead of on every local edit anywhere.
 */
export interface ModelIndexChange {
  objectIds: readonly string[]
  connectionIds: readonly string[]
}

/** A revision that is a server read-model invalidation (the SSE stream). It
 *  names no ids, but a consumer can ask the server which changed
 *  (`changedIdsSince`) and then leave these out of `modelIndexChangesSince`. */
export type ModelIndexChangeSource = 'server-invalidation'

/** `null`: the producer could not say (a server invalidation, a rebuild). */
const changeLog: Array<{ version: number; change: ModelIndexChange | null; source?: ModelIndexChangeSource }> = []
const CHANGE_LOG_LIMIT = 64

/**
 * Everything that changed after revision `version`, up to the current one —
 * or `null` when that cannot be told: some revision in between carried no ids,
 * or the log no longer reaches back (it keeps the last 64), or the version was
 * set without going through `notifyModelIndexChanged`. `null` means "assume
 * anything changed".
 */
export function modelIndexChangesSince(
  version: number,
  options: { skipServerInvalidations?: boolean } = {},
): ModelIndexChange | null {
  const current = useModelIndexVersion.getState().version
  if (current <= version) return { objectIds: [], connectionIds: [] }
  const entries = changeLog.filter((entry) => entry.version > version && entry.version <= current)
  if (entries.length !== current - version) return null
  const objectIds = new Set<string>()
  const connectionIds = new Set<string>()
  for (const { change, source } of entries) {
    if (!change && options.skipServerInvalidations && source === 'server-invalidation') continue
    if (!change) return null
    for (const id of change.objectIds) objectIds.add(id)
    for (const id of change.connectionIds) connectionIds.add(id)
  }
  return { objectIds: [...objectIds], connectionIds: [...connectionIds] }
}

/** Tests: back to revision 0 with an empty change log. */
export function __resetModelIndexVersionForTest(): void {
  changeLog.length = 0
  useModelIndexVersion.setState({ version: 0 })
}

/** The ids a delta touches — what `notifyModelIndexChanged` reports. */
export function changedIds(changes: ModelIndexChanges): ModelIndexChange {
  return {
    objectIds: [
      ...(changes.upsertObjects ?? []).map((o) => o.id),
      ...(changes.removeObjectIds ?? []),
      ...(changes.upsertGroups ?? []).map((g) => g.id),
      ...(changes.removeGroupIds ?? []),
    ],
    connectionIds: [
      ...(changes.addConnections ?? []).map((c) => c.id),
      ...(changes.removeConnections ?? []).map((c) => c.id),
    ],
  }
}

/**
 * Keeps the persisted IndexedDB index in sync with the model. Called by the
 * Automerge bridge after every projection. A no-op when paging is disabled, so it
 * costs nothing in the default (resident) mode. Writes are serialized to avoid
 * interleaving, and failures are logged rather than thrown (the index is a cache,
 * never the source of truth).
 */
let prev: ModelIndexInput | null = null
let chain: Promise<void> = Promise.resolve()

export function syncModelIndex(next: ModelIndexInput): void {
  // Maintain the index under paging OR the premium server tier (which delegates
  // relatedDiagrams to it + uses it as the offline cache).
  if (!isModelPagingEnabled() && !isServerReadModelEnabled()) return
  // Resolved ONCE per call (not inside the chained closure) so a sync queued just
  // before a workspace switch still targets the workspace it was queued for, rather
  // than whatever becomes active by the time the chain runs.
  const store = workspaceKvStore()
  chain = chain.then(async () => {
    try {
      // A first build touches everything: no ids.
      let change: ModelIndexChange | undefined
      if (!prev) await buildModelIndex(store, next)
      else {
        const delta = diffModelChanges(prev, next)
        await applyModelChanges(store, delta)
        change = changedIds(delta)
      }
      prev = next
      notifyModelIndexChanged(change)
    } catch (err) {
      console.warn('model index sync failed:', err)
    }
  })
}

/** Reset the in-memory diff baseline (e.g. on bridge teardown / restart). */
export function resetModelIndexSync(): void {
  prev = null
}

/**
 * Incrementally fold OFF-WINDOW edits/deletes into the persisted index.
 *
 * Under boot-from-server `syncModelIndex` is skipped: the bridge only knows the active-
 * diagram window, and feeding that would window the whole index (deleting off-window
 * entries). So an edit to an entity OUTSIDE the active diagram (rename a shape on the
 * Dependencies page, add a tag, edit a connection from the Model Connections table) never
 * reaches the index that `pagedModelQuery` reads — the seam then hands callers the STALE
 * pre-edit record and the edit looks reverted. The bridge owns the authoritative edited
 * entities + tombstones; apply just those, diffing against the index's CURRENT records so
 * token/adjacency entries update correctly. No-op unless an index backend is active.
 * Serialized on the same `chain` as syncModelIndex so writes never interleave.
 */
export function applyOffWindowEditsToIndex(
  objects: C4Object[],
  connections: Connection[],
  deletedObjectIds: string[],
  deletedConnectionIds: string[]
): void {
  if (!isModelPagingEnabled() && !isServerReadModelEnabled()) return
  if (!objects.length && !connections.length && !deletedObjectIds.length && !deletedConnectionIds.length) return
  const store = workspaceKvStore()
  chain = chain.then(async () => {
    try {
      const objIds = [...objects.map((o) => o.id), ...deletedObjectIds]
      const connIds = [...connections.map((c) => c.id), ...deletedConnectionIds]
      const [baseObj, baseConn] = await Promise.all([
        objIds.length ? store.getMany<C4Object>(objIds.map((id) => 'o:' + id)) : Promise.resolve([]),
        connIds.length ? store.getMany<Connection>(connIds.map((id) => 'c:' + id)) : Promise.resolve([]),
      ])
      // The index's current records are the diff baseline (prev); the edited entities are
      // `next`. Deleted ids are in `prev` (if present) but not `next`, so the diff removes
      // them. groups stay empty — they're fully resident, so their index entries are
      // maintained by the regular store-fed sync, not here.
      const prevModel: ModelIndexInput = {
        objects: baseObj.filter((o): o is C4Object => !!o),
        connections: baseConn.filter((c): c is Connection => !!c),
        groups: [],
      }
      const delObj = new Set(deletedObjectIds)
      const delConn = new Set(deletedConnectionIds)
      const nextModel: ModelIndexInput = {
        objects: objects.filter((o) => !delObj.has(o.id)),
        connections: connections.filter((c) => !delConn.has(c.id)),
        groups: [],
      }
      await applyModelChanges(store, diffModelChanges(prevModel, nextModel))
      notifyModelIndexChanged({ objectIds: objIds, connectionIds: connIds })
    } catch (err) {
      console.warn('off-window index edit failed:', err)
    }
  })
}
