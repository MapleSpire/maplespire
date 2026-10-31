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
  ObjectScope,
} from '../../types'

/**
 * Automerge document shapes for the hybrid model:
 *  - ONE RootDoc per workspace points at the shared C4 model and the registry
 *    of diagrams (both in their own documents).
 *  - ONE DiagramDoc per diagram holds that diagram's view (settings, composition,
 *    layouts, comments, flows) and its history checkpoints.
 *
 * Entity collections are stored as **maps keyed by id**, never arrays: concurrent
 * adds/removes of different entities then merge cleanly, whereas Automerge arrays
 * merge by index and can interleave. The Zustand store keeps using arrays; the
 * projection layer converts between the two.
 */

/** Lightweight per-diagram entry in the root registry — enough to list/route
 * diagrams without loading each (lazy-loaded) DiagramDoc. `name`/`type` are
 * AUTHORITATIVE here (the projection prefers them even when the DiagramDoc
 * wins everything else): renames happen in list views against diagrams whose
 * doc is not loaded, land in the meta only, and no code path copies meta.name
 * into a doc — a doc-wins rule would undo every non-active rename on
 * activation. The active-diagram flush writes both from
 * the same store value in the same pass, so the meta is never staler than the
 * doc for these two fields outside a mid-flush instant.
 * `objectIds`/`connectionIds`/`groupIds` are denormalised composition arrays
 * kept in sync with the DiagramDoc so cross-diagram queries on stubs are
 * accurate without loading every DiagramDoc. */
export interface DiagramMeta {
  id: string
  name: string
  type: Diagram['type']
  /** Automerge URL (`automerge:...`) of this diagram's DiagramDoc. */
  docUrl: string
  /** Denormalised — the object this diagram drills into (C4 expand/zoom parent),
   * if any. Kept on the stub so cross-diagram queries (e.g. getRelatedDiagrams,
   * which powers the expand menu's "Detail" section) resolve without loading the
   * non-active DiagramDoc. */
  parentObjectId?: string
  /** Denormalised composition — ids of objects visible in this diagram. */
  objectIds: string[]
  /** Denormalised composition — ids of connections visible in this diagram. */
  connectionIds: string[]
  /** Denormalised composition — ids of groups visible in this diagram. */
  groupIds: string[]
  /** Denormalised — the diagram's per-object internal/external overrides
   * (`Diagram.objectScopes`; absent when it has none). Copied here so the
   * derived "external in N of M diagrams" usage resolves from layout-less stubs
   * and from `ro_diagrams.data` without loading every DiagramDoc. Kept like the
   * composition: the store is authoritative for the active diagram, the
   * existing meta (minus deleted objects) for every other one. A map that
   * exists is emptied, never deleted: a concurrent put inside it would be lost. */
  objectScopes?: Record<string, ObjectScope>
}

export interface RootModel {
  objects: Record<string, C4Object>
  connections: Record<string, Connection>
  groups: Record<string, Group>
  domains: Record<string, Domain>
  tagSnapshots: Record<string, TagSnapshot>
  decisionRecords: Record<string, DecisionRecord>
}

/** The shared C4 model lives in its own Automerge document (sharded from root).
 * Structurally identical to RootModel — a separate type for clarity. */
export type ModelDoc = RootModel

export interface RootDoc {
  /** URL (`automerge:...`) of the shared ModelDoc. */
  modelUrl: string
  /** Ordered list of registry-shard doc URLs. The full diagram registry is
   * the union of all shards' `diagrams` maps; the root never holds `diagrams`. */
  shardUrls: string[]
  /** URL of the sharded model's {@link ModelMeta} doc, set once the model has
   * been split into object/connection shards. When present, readers prefer it over {@link modelUrl}; when absent the
   * monolithic {@link ModelDoc} at `modelUrl` is authoritative (back-compat). */
  modelMetaUrl?: string
  /**
   * Large server-paged benchmark workspaces materialize their registry in the
   * server read model. Boot-from-server clients then resolve only the requested
   * diagram instead of opening every registry shard and its denormalized
   * composition arrays.
   */
  registrySummaryOnly?: boolean
  /** Total diagram count when {@link registrySummaryOnly} is enabled. */
  diagramCount?: number
  /** A bounded mutable registry shard for diagrams created in a summary-only
   * workspace. Baseline registry shards remain server-owned and unloaded. */
  registryWriteUrl?: string
}

/**
 * Metadata doc for the **sharded** model. The big collections
 * (`objects`, `connections`) move into independently-synced shard docs so an edit
 * reconciles only the affected shard, not the whole model; the small collections
 * stay inline here (reconciling them is cheap). The full {@link RootModel} is the
 * union of this doc's inline collections + every object/connection shard.
 *
 * Mirrors the registry-shard pattern (RootDoc.shardUrls → RegistryShard) but for
 * model entities. Object/connection shards are filled sequentially to
 * `MODEL_SHARD_SIZE` and their URLs appended here (lazy-loaded, like registry
 * shards). Domains/tagSnapshots/groups and ordinary ADR sets stay inline. Very
 * large workspaces may place immutable ADR baselines in
 * `decisionRecordShardUrls`; the inline map remains the editable overlay.
 */
export interface ModelMeta {
  /** Immutable base entities live in the server read model; this document then
   * carries only bounded editable overlays and control state. */
  staticBaseline?: boolean
  /** Ordered object-shard doc URLs. The full object map = union of all shards. */
  objectShardUrls: string[]
  /** Ordered connection-shard doc URLs. */
  connectionShardUrls: string[]
  /** Optional immutable ADR baseline shards; `decisionRecords` overlays them. */
  decisionRecordShardUrls?: string[]
  /** Number of records in the immutable ADR baseline. */
  decisionRecordCount?: number
  /** Maximum records per immutable ADR shard. */
  decisionRecordShardSize?: number
  /**
   * URL of the PERSISTENT, model-level "edits overlay" object shard — the offline-first
   * write target under boot-from-server. Created ONCE and reused across
   * sessions (never a new shard per session), so there is no shard proliferation and no
   * server fetch race. It is also kept as the LAST entry in {@link objectShardUrls} so
   * the read model overlays it last-wins (an edited existing object shadows its original).
   * The daily compaction job folds it back into the base shards and clears it (keeping
   * any concurrently-edited entries).
   *
   * Present on every SERVER-authored ModelMeta (`buildModelMeta` requires it; the
   * client never mints heads). Still optional in this type only because DAMAGED
   * legacy documents without it exist and readers must handle them: absence
   * means "workspace needs `repair:overlay-heads`", never "not created yet".
   */
  editsObjectShardUrl?: string
  /** Ordered bounded overlay segments, oldest → newest. The singular field
   * above remains the current writable segment for compatibility. */
  editsObjectShardUrls?: string[]
  /** URL of the persistent "edits overlay" connection shard — companion to
   * {@link editsObjectShardUrl} (kept last in {@link connectionShardUrls}). */
  editsConnectionShardUrl?: string
  /** Ordered bounded connection overlay segments, oldest → newest. */
  editsConnectionShardUrls?: string[]
  /** Bounded write-head protocol version. Missing means the current legacy
   * overlay may contain an arbitrarily large Automerge history and must be
   * rotated without browser materialization. */
  editsOverlayWriteHeadVersion?: number
  /**
   * Delete tombstones (boot-from-server). When the client DELETEs an object whose data
   * lives in a base shard it can't load, it cannot remove it from that shard directly, so
   * it records the id here. The server read model EXCLUDES + DELETEs these ids, and the
   * daily compaction removes them from the base shards (and the overlay) then clears this
   * list. Append-only / union semantics so concurrent deletes from multiple clients merge.
   */
  deletedObjectIds?: string[]
  /** Connection delete tombstones — companion to {@link deletedObjectIds}. */
  deletedConnectionIds?: string[]
  /** ADR tombstones for ids that still exist in immutable baseline shards. */
  deletedDecisionRecordIds?: string[]
  /**
   * DIAGRAM delete tombstones — the summary-only registry's counterpart to
   * {@link deletedObjectIds}. On a summary workspace the registry is
   * server-owned and its baseline shards are frozen, so a client deleting a
   * diagram it did not create this session has nowhere else to say so: the
   * registry write pass is empty by design and `writeSummaryLocalRegistry`
   * walks only session-created ids. The id is recorded here instead; the static
   * delta projector deletes the `ro_*` rows and the client filters its own
   * registry window on it. Append-only / union semantics, exactly like the
   * object and connection lists.
   *
   * NEVER derived from the absence of an id in the resident window — the window
   * is a bounded slice of a registry that can hold tens of thousands
   * (`diagramTombstonePlan.ts`). Written ONLY under `registrySummaryOnly`: an
   * ordinary workspace removes the entry from its own registry shard.
   */
  deletedDiagramIds?: string[]
  groups: Record<string, Group>
  domains: Record<string, Domain>
  tagSnapshots: Record<string, TagSnapshot>
  decisionRecords: Record<string, DecisionRecord>
}

/** One shard of the object collection — up to MODEL_SHARD_SIZE objects, id-keyed.
 * The full object map is the union of every shard's `objects`. */
export interface ObjectShard {
  objects: Record<string, C4Object>
  /** Non-empty sentinel required for a storage-restored empty head to sync remotely. */
  writeHeadVersion?: number
  /** Durable bound on change batches in this write head. */
  writeBatchIds?: string[]
}

/** One shard of the connection collection — up to MODEL_SHARD_SIZE connections. */
export interface ConnectionShard {
  connections: Record<string, Connection>
  /** Non-empty sentinel required for a storage-restored empty head to sync remotely. */
  writeHeadVersion?: number
  /** Durable bound on change batches in this write head. */
  writeBatchIds?: string[]
}

/** One immutable baseline shard of decision records. */
export interface DecisionRecordShard {
  decisionRecords: Record<string, DecisionRecord>
}

/** One shard of the diagram registry. Each shard holds up to SHARD_SIZE
 * DiagramMeta entries. The full registry = union of all shards. */
export interface RegistryShard {
  diagrams: Record<string, DiagramMeta>
}

/** A named restore point on a diagram's history. `heads` are Automerge head
 * hashes captured at checkpoint time; restoring reconciles the doc back to the
 * materialised state at those heads. */
export interface Checkpoint {
  id: string
  label: string
  heads: string[]
  createdAt: string
}

/**
 * A diagram's view document. It is the diagram's authoritative settings
 * (everything on `Diagram` except its `id`, which is the registry key) plus the
 * diagram-scoped entities (`comments`, `flows` — keyed by id) and history.
 */
export type DiagramDoc = Omit<Diagram, 'id'> & {
  comments: Record<string, Comment>
  flows: Record<string, Flow>
  checkpoints: Checkpoint[]
}

export function emptyRootDoc(): RootDoc {
  return {
    modelUrl: '',
    shardUrls: [],
  }
}
