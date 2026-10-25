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

import type { Connection, Diagram, Group, LowerConnectionRouting, Position, Size } from '../../types'
import type { KvStore } from '../modelQuery/kvStore'
import { cleanLowerRouting, lowerRoutingFields, withLowerRoutingForSpace } from '../diagrams/lowerRouting'
import { deepEqualPlain, entityIntentTabId } from './entityIntents'
import { adoptSingleKeyLegacyJournal, adoptTabJournalNamespace } from './tabJournalAdoption'
import type { DiagramDoc } from './types'

export type PlacementLayoutSpace = '2d' | '3d'

export interface PendingObjectPlacement {
  id: string
  position: Position
  size: Size
}

export interface PendingGroupPlacement {
  id: string
  position?: Position
  size?: Size
  autoSize?: boolean
}

export interface PendingConnectionPlacement {
  id: string
  data: Partial<Connection>
}

/**
 * The routing of one derived (lower) connection ON THIS DIAGRAM. Unlike a
 * connection record — which targets the model documents — this is
 * diagram-scoped, like an object placement: it is written into the DiagramDoc's
 * `lowerRouting[pair]`, and only the DiagramDoc carries it.
 */
export interface PendingLowerRoutePlacement {
  /** `${fromId}→${toId}`, the key of `Diagram.lowerRouting`. */
  pair: string
  /** ABSOLUTE for the record's space: a field of that space absent here is
   * cleared when the record is applied, so a replay is idempotent. */
  routing: LowerConnectionRouting
}

export interface PlacementIntentBatch {
  objects?: PendingObjectPlacement[]
  groups?: PendingGroupPlacement[]
  connections?: PendingConnectionPlacement[]
  lowerRoutes?: PendingLowerRoutePlacement[]
}

interface PendingRecordBase {
  workspaceKey: string
  diagramId: string
  space: PlacementLayoutSpace
  revision: number
  /** Wall clock at record time: revisions are
   * per-tab counters and incomparable across tabs, so adoption needs a
   * recency tiebreak or the last-adopted tab's geometry wins arbitrarily.
   * Absent on legacy v1 records (treated as oldest). */
  recordedAt?: number
  id: string
}

interface PendingObjectRecord extends PendingRecordBase, PendingObjectPlacement {
  kind: 'object'
}

interface PendingGroupRecord extends PendingRecordBase, PendingGroupPlacement {
  kind: 'group'
}

interface PendingConnectionRecord extends PendingRecordBase, PendingConnectionPlacement {
  kind: 'connection'
}

/** `id` is the pair (the record key needs one); `routing` as in the batch. */
interface PendingLowerRouteRecord extends PendingRecordBase {
  kind: 'lowerRoute'
  routing: LowerConnectionRouting
}

export type SerializedPlacementIntent =
  | PendingObjectRecord
  | PendingGroupRecord
  | PendingConnectionRecord
  | PendingLowerRouteRecord

export interface PlacementIntentSnapshot {
  throughRevision: number
  objects: Array<PendingObjectPlacement & { space: PlacementLayoutSpace }>
  groups: Array<PendingGroupPlacement & { space: PlacementLayoutSpace }>
  connections: Array<PendingConnectionPlacement & { space: PlacementLayoutSpace }>
  lowerRoutes: Array<PendingLowerRoutePlacement & { space: PlacementLayoutSpace }>
}

/** Records whose only carrier is the DiagramDoc (no model document involved):
 * shape placements, pure-geometry group placements and lower routes. */
export function isDiagramDocPlacementRecord(record: SerializedPlacementIntent): boolean {
  return record.kind === 'object'
    || record.kind === 'lowerRoute'
    || (record.kind === 'group' && record.autoSize === undefined)
}

/** A copy of a record, sharing no structure with it. */
function cloneRecord(record: SerializedPlacementIntent): SerializedPlacementIntent {
  if (record.kind === 'object') {
    return { ...record, position: { ...record.position }, size: { ...record.size } }
  }
  if (record.kind === 'group') {
    return { ...record, position: clonePosition(record.position), size: cloneSize(record.size) }
  }
  if (record.kind === 'lowerRoute') {
    return { ...record, routing: cleanLowerRouting(record.routing) }
  }
  return { ...record, data: { ...record.data } }
}

export interface PlacementProjection {
  diagrams: Diagram[]
  groups: Group[]
  connections: Connection[]
}

/**
 * Apply a captured placement batch directly to the active DiagramDoc.
 *
 * Keeping this operation narrow is what prevents a drag from reconciling the
 * 30k-entry registry/model. It also deliberately writes absolute values, so a
 * replay after an interrupted save is idempotent.
 */
export function applyPlacementSnapshotToDiagramDoc(
  doc: DiagramDoc,
  snapshot: PlacementIntentSnapshot,
): void {
  for (const object of snapshot.objects) {
    if (object.space === '3d' && !doc.layouts3d) doc.layouts3d = {}
    if (object.space === '2d' && !doc.layouts) doc.layouts = {}
    // Re-read after initialization: Automerge wraps the inserted map in its
    // change proxy; mutating the raw `{}` returned by `??=` is not recorded.
    const layouts = object.space === '3d' ? doc.layouts3d! : doc.layouts!
    layouts[object.id] = {
      position: { ...object.position },
      size: { ...object.size },
    }
  }
  for (const group of snapshot.groups) {
    if (!group.position || !group.size) continue
    if (group.space === '3d' && !doc.layouts3d) doc.layouts3d = {}
    if (group.space === '2d' && !doc.layouts) doc.layouts = {}
    const layouts = group.space === '3d' ? doc.layouts3d! : doc.layouts!
    layouts[group.id] = {
      position: { ...group.position },
      size: { ...group.size },
    }
  }
  for (const route of snapshot.lowerRoutes) {
    if (!doc.lowerRouting) doc.lowerRouting = {}
    // Re-read after each initialization, for the same proxy reason as above.
    const routes = doc.lowerRouting!
    if (!routes[route.pair]) routes[route.pair] = {}
    const entry = routes[route.pair] as Record<string, unknown>
    const routing = cleanLowerRouting(route.routing) as Record<string, unknown>
    for (const field of lowerRoutingFields(route.space)) {
      if (routing[field] === undefined) {
        if (field in entry) delete entry[field]
      } else {
        entry[field] = routing[field]
      }
    }
  }
}

/** v2 since phase B: per-TAB keys + a registry, adopted at hydration — the
 * v1 single shared key let a clean sibling tab overwrite (or, at zero
 * pending, DELETE) the journal of the tab that still needed it, and the
 * entity journal's own docs named this file as the standing example of the
 * defect. The v1 key is adopted read-once at hydration like a crashed
 * sibling's. */
const STORAGE_PREFIX = 'pending-placement-intents:v2'
const REGISTRY_KEY = `${STORAGE_PREFIX}:tabs`
const tabStorageKey = (tabId: string) => `${STORAGE_PREFIX}:tab:${tabId}`
const LEGACY_V1_KEY = 'pending-placement-intents:v1'
const PERSIST_MAX_WAIT_MS = 500
const persistTimers = new Map<string, {
  store: KvStore
  timer: ReturnType<typeof setTimeout>
  pendingSince: number
}>()

function recordKey(record: Pick<PendingRecordBase, 'diagramId' | 'space' | 'id'> & { kind: string }): string {
  return `${record.diagramId}:${record.space}:${record.kind}:${record.id}`
}

function clonePosition(position: Position | undefined): Position | undefined {
  return position ? { ...position } : undefined
}

function cloneSize(size: Size | undefined): Size | undefined {
  return size ? { ...size } : undefined
}

/** Latest-wins local intent journal. Absolute placements make replay idempotent. */
export class PendingPlacementIntents {
  private revision = 0
  private readonly byWorkspace = new Map<string, Map<string, SerializedPlacementIntent>>()

  /** Ack ceiling for retirements planned NOW: an unconditional
   * MAX_SAFE_INTEGER acknowledgement would also swallow records recorded
   * AFTER the retirement was planned (a same-id recreation being dragged
   * while the witness flush is in flight). */
  get revisionNow(): number {
    return this.revision
  }

  record(
    workspaceKey: string,
    diagramId: string,
    space: PlacementLayoutSpace,
    batch: PlacementIntentBatch,
  ): { revision: number; newKeys: boolean } {
    const revision = ++this.revision
    const now = Date.now()
    let records = this.byWorkspace.get(workspaceKey)
    if (!records) {
      records = new Map()
      this.byWorkspace.set(workspaceKey, records)
    }
    // The leading-edge persistence decision: a key not yet journaled gets an
    // immediate IndexedDB write — otherwise the first record of a drag would
    // exist only in tab memory for up to the debounce window, and a hard kill
    // fires no pagehide. Re-records of already-journaled keys may coalesce.
    let newKeys = false

    for (const object of batch.objects ?? []) {
      const record: PendingObjectRecord = {
        workspaceKey,
        diagramId,
        space,
        revision,
        recordedAt: now,
        kind: 'object',
        id: object.id,
        position: { ...object.position },
        size: { ...object.size },
      }
      const key = recordKey(record)
      if (!records.has(key)) newKeys = true
      records.set(key, record)
    }
    for (const group of batch.groups ?? []) {
      const record: PendingGroupRecord = {
        workspaceKey,
        diagramId,
        space,
        revision,
        recordedAt: now,
        kind: 'group',
        id: group.id,
        position: clonePosition(group.position),
        size: cloneSize(group.size),
        autoSize: group.autoSize,
      }
      const key = recordKey(record)
      if (!records.has(key)) newKeys = true
      records.set(key, record)
    }
    for (const connection of batch.connections ?? []) {
      const record: PendingConnectionRecord = {
        workspaceKey,
        diagramId,
        space,
        revision,
        recordedAt: now,
        kind: 'connection',
        id: connection.id,
        data: { ...connection.data },
      }
      const key = recordKey(record)
      if (!records.has(key)) newKeys = true
      records.set(key, record)
    }
    for (const route of batch.lowerRoutes ?? []) {
      const record: PendingLowerRouteRecord = {
        workspaceKey,
        diagramId,
        space,
        revision,
        recordedAt: now,
        kind: 'lowerRoute',
        id: route.pair,
        routing: cleanLowerRouting(route.routing),
      }
      const key = recordKey(record)
      if (!records.has(key)) newKeys = true
      records.set(key, record)
    }
    return { revision, newKeys }
  }

  hasPending(workspaceKey: string, diagramId?: string): boolean {
    const records = this.byWorkspace.get(workspaceKey)
    if (!records) return false
    if (!diagramId) return records.size > 0
    for (const record of records.values()) if (record.diagramId === diagramId) return true
    return false
  }

  /** For the sync badge, so a hydrated off-active placement is counted and the
   * badge never reads "synced" over a non-empty journal. */
  pendingCount(workspaceKey: string): number {
    return this.byWorkspace.get(workspaceKey)?.size ?? 0
  }

  /** The diagrams holding pending intents — the off-active drain's worklist. */
  pendingDiagramIds(workspaceKey: string): string[] {
    const records = this.byWorkspace.get(workspaceKey)
    if (!records) return []
    const ids = new Set<string>()
    for (const record of records.values()) ids.add(record.diagramId)
    return [...ids]
  }

  clearWorkspace(workspaceKey: string): void {
    this.byWorkspace.delete(workspaceKey)
  }

  snapshot(workspaceKey: string, diagramId: string): PlacementIntentSnapshot | undefined {
    const records = this.recordsFor(workspaceKey, diagramId)
    if (records.length === 0) return undefined
    const objects: Array<PendingObjectPlacement & { space: PlacementLayoutSpace }> = []
    const groups: Array<PendingGroupPlacement & { space: PlacementLayoutSpace }> = []
    const connections: Array<PendingConnectionPlacement & { space: PlacementLayoutSpace }> = []
    const lowerRoutes: Array<PendingLowerRoutePlacement & { space: PlacementLayoutSpace }> = []
    let throughRevision = 0
    for (const record of records) {
      throughRevision = Math.max(throughRevision, record.revision)
      if (record.kind === 'object') {
        objects.push({ id: record.id, position: { ...record.position }, size: { ...record.size }, space: record.space })
      } else if (record.kind === 'group') {
        groups.push({
          id: record.id,
          position: clonePosition(record.position),
          size: cloneSize(record.size),
          autoSize: record.autoSize,
          space: record.space,
        })
      } else if (record.kind === 'lowerRoute') {
        lowerRoutes.push({ pair: record.id, routing: cleanLowerRouting(record.routing), space: record.space })
      } else {
        connections.push({ id: record.id, data: { ...record.data }, space: record.space })
      }
    }
    return { throughRevision, objects, groups, connections, lowerRoutes }
  }

  acknowledge(workspaceKey: string, diagramId: string, throughRevision: number): void {
    this.acknowledgeWhere(workspaceKey, diagramId, throughRevision, () => true)
  }

  /** Selective acknowledgement (phase B): the off-active drain writes ONLY
   * object/pure-geometry-group records into the DiagramDoc — connection and
   * autoSize records target the model documents and must survive it. */
  acknowledgeWhere(
    workspaceKey: string,
    diagramId: string,
    throughRevision: number,
    include: (record: SerializedPlacementIntent) => boolean,
  ): void {
    const records = this.byWorkspace.get(workspaceKey)
    if (!records) return
    for (const [key, record] of records) {
      if (record.diagramId === diagramId && record.revision <= throughRevision && include(record)) {
        records.delete(key)
      }
    }
    if (records.size === 0) this.byWorkspace.delete(workspaceKey)
  }

  overlayProjection(
    workspaceKey: string,
    diagramId: string,
    projection: PlacementProjection,
  ): PlacementProjection {
    const records = this.recordsFor(workspaceKey, diagramId)
    if (records.length === 0) return projection

    let diagrams = projection.diagrams
    let groups = projection.groups
    let connections = projection.connections
    const diagram = diagrams.find((candidate) => candidate.id === diagramId)
    if (diagram) {
      const nextDiagram: Diagram = { ...diagram }
      let layouts = diagram.layouts
      let layouts3d = diagram.layouts3d
      let lowerRouting = diagram.lowerRouting
      for (const record of records) {
        if (record.kind === 'lowerRoute') {
          lowerRouting = {
            ...(lowerRouting ?? {}),
            [record.id]: withLowerRoutingForSpace(lowerRouting?.[record.id], record.routing, record.space),
          }
          continue
        }
        if (record.kind !== 'object' && record.kind !== 'group') continue
        const source = record.space === '3d' ? layouts3d : layouts
        const existing = source?.[record.id]
        const position = record.position ?? existing?.position
        const size = record.size ?? existing?.size
        if (!position || !size) continue
        const next = { position: { ...position }, size: { ...size } }
        if (record.space === '3d') layouts3d = { ...(layouts3d ?? {}), [record.id]: next }
        else layouts = { ...(layouts ?? {}), [record.id]: next }
      }
      nextDiagram.layouts = layouts
      if (layouts3d !== undefined) nextDiagram.layouts3d = layouts3d
      if (lowerRouting !== undefined) nextDiagram.lowerRouting = lowerRouting
      diagrams = diagrams.map((candidate) => candidate.id === diagramId ? nextDiagram : candidate)
    }

    const groupRecords = new Map(records.filter((record): record is PendingGroupRecord => record.kind === 'group').map((record) => [record.id, record]))
    if (groupRecords.size > 0) {
      groups = groups.map((group) => {
        const record = groupRecords.get(group.id)
        if (!record) return group
        return {
          ...group,
          ...(record.position ? { position: { ...record.position } } : {}),
          ...(record.size ? { size: { ...record.size } } : {}),
          ...(record.autoSize !== undefined ? { autoSize: record.autoSize } : {}),
        }
      })
    }

    const connectionRecords = new Map(records.filter((record): record is PendingConnectionRecord => record.kind === 'connection').map((record) => [record.id, record]))
    if (connectionRecords.size > 0) {
      connections = connections.map((connection) => {
        const record = connectionRecords.get(connection.id)
        return record ? { ...connection, ...record.data } : connection
      })
    }
    return { diagrams, groups, connections }
  }

  serialize(workspaceKey: string): SerializedPlacementIntent[] {
    return [...(this.byWorkspace.get(workspaceKey)?.values() ?? [])].map(cloneRecord)
  }

  hydrate(workspaceKey: string, serialized: readonly SerializedPlacementIntent[] | undefined): void {
    if (!serialized?.length) return
    let records = this.byWorkspace.get(workspaceKey)
    if (!records) {
      records = new Map()
      this.byWorkspace.set(workspaceKey, records)
    }
    for (const source of serialized) {
      if (source.workspaceKey !== workspaceKey) continue
      // Cross-tab recency: revisions from different tabs are incomparable
      // counters, so a key collision is decided by wall clock first, revision
      // as the same-tab tiebreak — otherwise the LAST-ADOPTED tab's geometry
      // would win regardless of age.
      // Legacy v1 records carry no recordedAt and rank oldest.
      const existing = records.get(recordKey(source))
      if (existing) {
        const sourceAt = source.recordedAt ?? 0
        const existingAt = existing.recordedAt ?? 0
        const newer = sourceAt !== existingAt
          ? sourceAt > existingAt
          : source.revision > existing.revision
        if (!newer) continue
      }
      const record = cloneRecord(source)
      records.set(recordKey(record), record)
      this.revision = Math.max(this.revision, record.revision)
    }
  }

  private recordsFor(workspaceKey: string, diagramId: string): SerializedPlacementIntent[] {
    const records = this.byWorkspace.get(workspaceKey)
    return records ? [...records.values()].filter((record) => record.diagramId === diagramId) : []
  }
}

export const pendingPlacementIntents = new PendingPlacementIntents()

export async function hydratePlacementIntents(
  store: KvStore,
  workspaceKey: string,
): Promise<void> {
  // Our own namespace first (a reload's previous key is adopted through the
  // registry like any crashed sibling's), then the legacy v1 single key.
  await adoptTabJournalNamespace<SerializedPlacementIntent>({
    store,
    registryKey: REGISTRY_KEY,
    keyOfTab: tabStorageKey,
    ownTabId: entityIntentTabId,
    includeSelf: true,
    hydrate: (entries) => pendingPlacementIntents.hydrate(workspaceKey, entries),
    rehome: () => persistPlacementIntents(store, workspaceKey),
    contentEquals: deepEqualPlain,
  })
  await adoptSingleKeyLegacyJournal<SerializedPlacementIntent>({
    store,
    legacyKey: LEGACY_V1_KEY,
    hydrate: (entries) => pendingPlacementIntents.hydrate(workspaceKey, entries),
    rehome: () => persistPlacementIntents(store, workspaceKey),
    contentEquals: deepEqualPlain,
  })
}

export async function persistPlacementIntents(
  store: KvStore,
  workspaceKey: string,
): Promise<void> {
  const serialized = pendingPlacementIntents.serialize(workspaceKey)
  // Own tab key only, registry mutations atomic — with one shared key and a
  // plain set/del of THIS tab's serialization, a clean sibling tab would erase
  // another tab's journal from disk entirely.
  if (serialized.length > 0) {
    await store.set(tabStorageKey(entityIntentTabId), serialized)
    await store.update<string[]>(REGISTRY_KEY, (tabs) =>
      tabs?.includes(entityIntentTabId) ? tabs : [...(tabs ?? []), entityIntentTabId])
  } else {
    await store.del(tabStorageKey(entityIntentTabId))
    await store.update<string[]>(REGISTRY_KEY, (tabs) =>
      (tabs ?? []).filter((tabId) => tabId !== entityIntentTabId))
  }
}

/** Persist NOW — the leading edge for a key not yet journaled (a hard kill
 * fires no pagehide, so the debounce alone is not enough). */
export function persistPlacementIntentsNow(store: KvStore, workspaceKey: string): void {
  const pending = persistTimers.get(workspaceKey)
  if (pending) clearTimeout(pending.timer)
  persistTimers.delete(workspaceKey)
  void persistPlacementIntents(store, workspaceKey).catch((error) => {
    console.warn('pending placement persistence failed', error)
  })
}

/** Coalesce rapid 3D pointer updates into one small IndexedDB latest-state write. */
export function schedulePersistPlacementIntents(
  store: KvStore,
  workspaceKey: string,
  delayMs = 50,
): void {
  const pending = persistTimers.get(workspaceKey)
  if (pending) clearTimeout(pending.timer)
  const now = Date.now()
  const pendingSince = pending?.pendingSince ?? now
  const maxWaitRemaining = Math.max(0, PERSIST_MAX_WAIT_MS - (now - pendingSince))
  const timer = setTimeout(() => {
    persistTimers.delete(workspaceKey)
    void persistPlacementIntents(store, workspaceKey).catch((error) => {
      console.warn('pending placement persistence failed', error)
    })
  }, Math.min(delayMs, maxWaitRemaining))
  persistTimers.set(workspaceKey, { store, timer, pendingSince })
}

export async function flushPlacementIntentPersistence(
  store: KvStore,
  workspaceKey: string,
): Promise<void> {
  const pending = persistTimers.get(workspaceKey)
  if (pending) clearTimeout(pending.timer)
  persistTimers.delete(workspaceKey)
  await persistPlacementIntents(store, workspaceKey)
}
