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

import type {
  C4Object,
  Connection,
  Group,
  Domain,
  TagSnapshot,
  DecisionRecord,
  Comment,
  Flow,
  Diagram,
} from '../../types'
import type {
  RootModel,
  DiagramDoc,
  DiagramMeta,
  Checkpoint,
  RegistryShard,
  ModelMeta,
  ObjectShard,
  ConnectionShard,
  DecisionRecordShard,
} from './types'

/**
 * Pure converters between the Automerge document shapes (id-keyed maps) and the
 * array-shaped slices the Zustand model store works with. No Automerge or store
 * imports here — just data mapping — so this is trivially unit-testable and reused
 * by both the read path (doc → store) and the write path (store → doc).
 */

function byId<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {}
  for (const item of items) out[item.id] = item
  return out
}

/** The shared-model slice as the store holds it (arrays). */
export interface ModelSlice {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  domains: Domain[]
  tagSnapshots: TagSnapshot[]
  decisionRecords: DecisionRecord[]
}

// ── Root model ⇄ store arrays ────────────────────────────────────────────────

export function rootModelToSlice(model: RootModel): ModelSlice {
  return {
    objects: Object.values(model.objects),
    connections: Object.values(model.connections),
    groups: Object.values(model.groups),
    domains: Object.values(model.domains),
    tagSnapshots: Object.values(model.tagSnapshots),
    decisionRecords: Object.values(model.decisionRecords),
  }
}

export function sliceToRootModel(slice: ModelSlice): RootModel {
  return {
    objects: byId(slice.objects),
    connections: byId(slice.connections),
    groups: byId(slice.groups),
    domains: byId(slice.domains),
    tagSnapshots: Object.fromEntries(slice.tagSnapshots.map((snapshot) => [snapshot.tagId, snapshot])),
    decisionRecords: byId(slice.decisionRecords),
  }
}

// ── Sharded model ⇄ RootModel ─────────────────────────────────────────────────
// The big collections (objects/connections) live in independently-synced shard
// docs so an edit reconciles only the affected shard; the small collections stay
// inline on the ModelMeta. These pure converters are the spine of correctness:
// merge(split(model)) deep-equals model. No Automerge/store coupling here.

/** Merge every object shard's `objects` map into one id-keyed map (shard order =
 * meta.objectShardUrls order; a later shard wins on the impossible id collision). */
export function mergeObjectShards(shards: readonly ObjectShard[]): Record<string, C4Object> {
  const out: Record<string, C4Object> = {}
  for (const shard of shards) Object.assign(out, shard.objects)
  return out
}

export function mergeConnectionShards(shards: readonly ConnectionShard[]): Record<string, Connection> {
  const out: Record<string, Connection> = {}
  for (const shard of shards) Object.assign(out, shard.connections)
  return out
}

export function mergeDecisionRecordShards(
  shards: readonly DecisionRecordShard[]
): Record<string, DecisionRecord> {
  const out: Record<string, DecisionRecord> = {}
  for (const shard of shards) Object.assign(out, shard.decisionRecords)
  return out
}

/** Reassemble the full {@link RootModel} from a {@link ModelMeta} (inline small
 * collections) + its loaded object/connection shards. Inverse of {@link splitModel}. */
export function modelShardsToRootModel(
  meta: ModelMeta,
  objectShards: readonly ObjectShard[],
  connectionShards: readonly ConnectionShard[],
  decisionRecordShards: readonly DecisionRecordShard[] = [],
): RootModel {
  const decisionRecords = mergeDecisionRecordShards(decisionRecordShards)
  Object.assign(decisionRecords, meta.decisionRecords ?? {})
  for (const id of meta.deletedDecisionRecordIds ?? []) delete decisionRecords[id]
  return {
    objects: mergeObjectShards(objectShards),
    connections: mergeConnectionShards(connectionShards),
    groups: meta.groups ?? {},
    domains: meta.domains ?? {},
    tagSnapshots: meta.tagSnapshots ?? {},
    decisionRecords,
  }
}

/** Split an id-keyed collection into shard maps, filling each to `shardSize` in
 * insertion order (deterministic). Always returns ≥1 shard (an empty one for an
 * empty collection) so there is always a shard to write the next new entity into. */
export function splitIntoShards<T>(coll: Record<string, T>, shardSize: number): Record<string, T>[] {
  if (!Number.isInteger(shardSize) || shardSize < 1) {
    throw new Error(`shardSize must be a positive integer, got ${shardSize}`)
  }
  const ids = Object.keys(coll)
  if (ids.length === 0) return [{}]
  const shards: Record<string, T>[] = []
  for (let i = 0; i < ids.length; i += shardSize) {
    const chunk: Record<string, T> = {}
    const end = Math.min(i + shardSize, ids.length)
    for (let j = i; j < end; j++) chunk[ids[j]] = coll[ids[j]]
    shards.push(chunk)
  }
  return shards
}

/** The shard CONTENTS produced by splitting a monolithic model. The caller (the
 * bridge/migration) creates Automerge docs from these and fills the URL arrays. */
export interface SplitModel {
  /** Inline small collections for the {@link ModelMeta} (URL arrays filled by caller). */
  meta: Omit<ModelMeta, 'objectShardUrls' | 'connectionShardUrls'>
  objectShards: ObjectShard[]
  connectionShards: ConnectionShard[]
}

/** Split a monolithic {@link RootModel} into ModelMeta inline collections +
 * object/connection shard contents. Inverse of {@link modelShardsToRootModel}. */
export function splitModel(model: RootModel, shardSize: number): SplitModel {
  return {
    meta: {
      groups: model.groups,
      domains: model.domains,
      tagSnapshots: model.tagSnapshots,
      decisionRecords: model.decisionRecords,
    },
    objectShards: splitIntoShards(model.objects, shardSize).map((objects) => ({ objects })),
    connectionShards: splitIntoShards(model.connections, shardSize).map((connections) => ({
      connections,
    })),
  }
}

// ── Diagram registry ─────────────────────────────────────────────────────────

/** Merge all shard `diagrams` maps into a flat array of DiagramMeta. */
export function mergeShards(shards: RegistryShard[]): DiagramMeta[] {
  const out: DiagramMeta[] = []
  for (const shard of shards) {
    for (const meta of Object.values(shard.diagrams)) out.push(meta)
  }
  return out
}

/** @deprecated Use mergeShards(shards) instead. Kept for test compatibility. */
export function registryToMetas(shards: RegistryShard[]): DiagramMeta[] {
  return mergeShards(shards)
}

/** A diagram's denormalised composition arrays (the part of {@link DiagramMeta}
 * flushWrite keeps in sync with the DiagramDoc). */
export interface DiagramComposition {
  objectIds: string[]
  connectionIds: string[]
  groupIds: string[]
}

/**
 * Remove deleted-this-session ids from a NON-active diagram's PRESERVED registry
 * composition (boot-from-server). flushWrite keeps a non-active diagram's shard meta
 * verbatim so it never clobbers it with empty arrays — but a DELETE must still be
 * reflected, or the registry keeps a dangling objectId/connectionId after a reload (the
 * diagram's `objectIds.length` then exceeds the objects that actually render, since the
 * server diagram-render excludes the deleted entity). This strips ONLY the tombstoned ids,
 * leaving every surviving id untouched — it can never empty an array it shouldn't. Returns
 * the SAME array references when nothing was removed (the common, no-delete flush), so an
 * unrelated flush stays a no-op reconcile.
 *
 * `deletedGroupIds` is session-scoped where the other two are document tombstones,
 * and deliberately so: a group lives whole inside ModelMeta rather than in an
 * immutable base shard, so deleting one is durable as soon as it flushes and
 * there is nothing for a persisted tombstone to mark. Persisting one would also
 * be a list nothing ever clears — the daily compaction folds `objects` and
 * `connections` only. Without this strip a deleted group would survive a reload
 * in the registry meta of every diagram the store is not authoritative for. */
export function stripDeletedFromComposition(
  composition: DiagramComposition,
  deletedObjectIds: ReadonlySet<string>,
  deletedConnectionIds: ReadonlySet<string>,
  deletedGroupIds: ReadonlySet<string> = EMPTY_IDS
): DiagramComposition {
  return {
    objectIds: omitIds(composition.objectIds, deletedObjectIds),
    connectionIds: omitIds(composition.connectionIds, deletedConnectionIds),
    groupIds: omitIds(composition.groupIds, deletedGroupIds),
  }
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>()

/** Filter `remove` out of `ids`, returning the SAME reference when no id was present. */
function omitIds(ids: string[], remove: ReadonlySet<string>): string[] {
  if (remove.size === 0 || ids.length === 0) return ids
  for (const id of ids) if (remove.has(id)) return ids.filter((x) => !remove.has(x))
  return ids
}

/** A placeholder `Diagram` for a registry entry whose DiagramDoc isn't loaded yet
 * (lazy load). Carries enough for the diagram list; composition is populated
 * from the denormalised meta so cross-diagram queries are accurate without
 * loading each DiagramDoc. Full layout fills in once the doc opens. */
export function metaToStubDiagram(meta: DiagramMeta): Diagram {
  const stub: Diagram = {
    id: meta.id,
    name: meta.name,
    type: meta.type,
    objectIds: meta.objectIds ?? [],
    connectionIds: meta.connectionIds ?? [],
    groupIds: meta.groupIds ?? [],
  }
  // Preserve the drill-down parent so getRelatedDiagrams can match this stub to
  // the object it details even while another diagram is the active one.
  if (meta.parentObjectId !== undefined) stub.parentObjectId = meta.parentObjectId
  return stub
}

// ── DiagramDoc ⇄ store (Diagram + its comments/flows) ─────────────────────────

export function diagramDocToDiagram(id: string, doc: DiagramDoc): Diagram {
  // Strip the diagram-scoped collections + history; the rest IS the Diagram body.
  const { comments: _c, flows: _f, checkpoints: _ck, ...fields } = doc
  return { id, ...fields }
}

/** Resolve one registry entry for the resident diagram list. A server summary is
 * only a boot fallback: once the active DiagramDoc is hydrated it is the
 * authoritative source for layout/composition, including edits that have not
 * yet been folded into the read model.
 *
 * EXCEPT `name`/`type`: those come from the REGISTRY META even when
 * the doc wins. Renames happen in list views against diagrams whose doc is
 * not loaded — they land in the meta only, and no code path ever copies
 * meta.name into a doc — so letting the stale doc win on activation silently
 * UNDID every non-active rename. The meta is never staler than the doc for
 * these two fields outside a mid-flush instant: every active-diagram flush
 * writes both from the same store value in the same pass. */
export function resolveDiagramProjection(
  meta: DiagramMeta,
  activeDiagramId: string | null,
  activeDoc: DiagramDoc | undefined,
  summaryDiagram?: Diagram,
): Diagram {
  if (meta.id === activeDiagramId && activeDoc) {
    return { ...diagramDocToDiagram(meta.id, activeDoc), name: meta.name, type: meta.type }
  }
  return summaryDiagram ?? metaToStubDiagram(meta)
}

export function diagramDocComments(doc: DiagramDoc): Comment[] {
  return Object.values(doc.comments ?? {})
}

export function diagramDocFlows(doc: DiagramDoc): Flow[] {
  return Object.values(doc.flows ?? {})
}

export function diagramToDiagramDoc(
  diagram: Diagram,
  comments: readonly Comment[],
  flows: readonly Flow[],
  checkpoints: readonly Checkpoint[] = []
): DiagramDoc {
  const { id: _id, layouts, ...fields } = diagram
  return {
    ...fields,
    layouts: layouts ?? {},
    comments: byId(comments),
    flows: byId(flows),
    checkpoints: [...checkpoints],
  }
}
