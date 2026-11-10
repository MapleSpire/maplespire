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

import type { StructSchema } from './reconcile'
import { ENTITY_SCHEMAS, type EntityCollection } from './knownKeys'

/**
 * The declarative registry of Automerge ENTITY FAMILIES (V0-10).
 *
 * A family is one id-keyed collection of entities stored in an Automerge
 * document. Adding one means registering it at every point listed in
 * `docs/entity-family-contract.md`; this registry is what those points either
 * DERIVE from (client code that can import it) or are COMPARED against
 * (server code and SQL, which cannot: `server/` has `rootDir: ./src`).
 *
 * The comparison is executable, not a convention:
 *  - `entityFamilyContract.test.ts` (this directory) covers the client points;
 *  - `server/src/entityFamilyContract.test.ts` covers the server points and
 *    the `ro_*` DDL, importing this file at run time.
 * Each fails when a family declared here is missing from a point that its
 * declaration says it belongs to, and when a point carries a family this
 * registry does not place there. The mutant record for both is in the doc.
 *
 * The declaration ORDER is load-bearing for the derived lists: it reproduces,
 * element for element, the literals those lists replaced (pinned by the
 * contract test), so deriving them changed no iteration order.
 */

/** Which Automerge document carries the family's entities. */
export type EntityFamilyHome =
  /** Sharded: ModelMeta names ordered shard documents (`shards.urlsField`). */
  | 'modelShard'
  /** Inline map on the ModelMeta (the "small collections"). */
  | 'modelMeta'
  /** Id-keyed map on each per-diagram DiagramDoc. */
  | 'diagramDoc'
  /** The diagram registry shards named by the root's `shardUrls`. */
  | 'registryShard'

/** The crash-recovery journal carrier (`entityIntents.ts`) that holds the
 * family's un-flushed edits. */
export type EntityJournalCarrier = 'entity' | 'small' | 'diagram' | 'stub'

/** Shard documents named by ModelMeta for this family. */
export interface EntityFamilyShards {
  /** ModelMeta field: ordered base shard urls. */
  readonly urlsField: 'objectShardUrls' | 'connectionShardUrls' | 'decisionRecordShardUrls'
  /** ModelMeta field: delete tombstones applied over the shards. */
  readonly tombstonesField: 'deletedObjectIds' | 'deletedConnectionIds' | 'deletedDecisionRecordIds'
  /** The client-written edit overlay, or null for a server-written baseline
   * only (decision-record shards are created by the static plane, never by a
   * browser, so no client holds their pointer back: `deferredReferences.ts`). */
  readonly overlay: null | {
    readonly headField: 'editsObjectShardUrl' | 'editsConnectionShardUrl'
    readonly urlsField: 'editsObjectShardUrls' | 'editsConnectionShardUrls'
  }
}

/** Server read-model projection of the family. */
export interface EntityFamilyProjection {
  /** The family's primary `ro_*` table. */
  readonly table: string
  /** Which projector writes it: `extractModelEntities` (projectorService.ts),
   * the decision-record projection (readModel/derivedStats.ts), or the
   * per-diagram flow index (`DIAGRAM_FLOW_INDEX_TABLES`, projector.ts). */
  readonly via: 'modelExtraction' | 'decisionRecordProjection' | 'diagramFlowIndex'
  /** Counted by the independent CRDT oracle `server/src/readModel/crdtInventory.ts`
   * (the divergence detector's coverage witness). `false` is a DECLARED gap,
   * not an oversight: the contract test fails if it is silently closed or
   * silently opened. */
  readonly inventoried: boolean
}

export interface EntityFamily<C extends EntityCollection = EntityCollection> {
  /** Singular kind; also the journal kind in `entityIntents.ts`. */
  readonly name: string
  /** Document field holding the id-keyed map. */
  readonly collection: C
  readonly home: EntityFamilyHome
  /** Present in the pre-sharding monolithic ModelDoc (`RootModel`). */
  readonly monolith: boolean
  /** The entity field its map key is taken from. */
  readonly idField: 'id' | 'tagId'
  /** The Zustand model-store slice the family is projected into. */
  readonly storeSlice: 'objects' | 'connections' | 'groups' | 'domains' | 'tags' | 'decisionRecords' | 'comments' | 'flows' | 'diagrams'
  readonly journal: EntityJournalCarrier
  readonly shards: EntityFamilyShards | null
  /** Server draft-diff collection (`server/src/draft/merge.ts` ChangeCollection),
   * or null when drafts do not diff the family. */
  readonly draftCollection: string | null
  readonly projection: EntityFamilyProjection | null
  /** The known-keys schema (V0-08): the reconcile contract of one entity. */
  readonly schema: StructSchema
}

export const ENTITY_FAMILIES = {
  objects: {
    name: 'object',
    collection: 'objects',
    home: 'modelShard',
    monolith: true,
    idField: 'id',
    storeSlice: 'objects',
    journal: 'entity',
    shards: {
      urlsField: 'objectShardUrls',
      tombstonesField: 'deletedObjectIds',
      overlay: { headField: 'editsObjectShardUrl', urlsField: 'editsObjectShardUrls' },
    },
    draftCollection: 'object',
    projection: { table: 'ro_objects', via: 'modelExtraction', inventoried: true },
    schema: ENTITY_SCHEMAS.objects,
  },
  connections: {
    name: 'connection',
    collection: 'connections',
    home: 'modelShard',
    monolith: true,
    idField: 'id',
    storeSlice: 'connections',
    journal: 'entity',
    shards: {
      urlsField: 'connectionShardUrls',
      tombstonesField: 'deletedConnectionIds',
      overlay: { headField: 'editsConnectionShardUrl', urlsField: 'editsConnectionShardUrls' },
    },
    draftCollection: 'connection',
    projection: { table: 'ro_connections', via: 'modelExtraction', inventoried: true },
    schema: ENTITY_SCHEMAS.connections,
  },
  groups: {
    name: 'group',
    collection: 'groups',
    home: 'modelMeta',
    monolith: true,
    idField: 'id',
    storeSlice: 'groups',
    journal: 'small',
    shards: null,
    draftCollection: 'group',
    projection: { table: 'ro_groups', via: 'modelExtraction', inventoried: true },
    schema: ENTITY_SCHEMAS.groups,
  },
  domains: {
    name: 'domain',
    collection: 'domains',
    home: 'modelMeta',
    monolith: true,
    idField: 'id',
    storeSlice: 'domains',
    journal: 'small',
    shards: null,
    draftCollection: 'domain',
    projection: null,
    schema: ENTITY_SCHEMAS.domains,
  },
  tagSnapshots: {
    name: 'tagSnapshot',
    collection: 'tagSnapshots',
    home: 'modelMeta',
    monolith: true,
    idField: 'tagId',
    storeSlice: 'tags',
    journal: 'small',
    shards: null,
    draftCollection: 'tag',
    projection: null,
    schema: ENTITY_SCHEMAS.tagSnapshots,
  },
  decisionRecords: {
    name: 'decisionRecord',
    collection: 'decisionRecords',
    home: 'modelMeta',
    monolith: true,
    idField: 'id',
    storeSlice: 'decisionRecords',
    journal: 'small',
    // The inline map is the editable overlay; very large workspaces add
    // immutable server-written baseline shards under it.
    shards: { urlsField: 'decisionRecordShardUrls', tombstonesField: 'deletedDecisionRecordIds', overlay: null },
    draftCollection: 'decisionRecord',
    projection: { table: 'ro_decision_records', via: 'decisionRecordProjection', inventoried: false },
    schema: ENTITY_SCHEMAS.decisionRecords,
  },
  comments: {
    name: 'comment',
    collection: 'comments',
    home: 'diagramDoc',
    monolith: false,
    idField: 'id',
    storeSlice: 'comments',
    journal: 'diagram',
    shards: null,
    draftCollection: null,
    projection: null,
    schema: ENTITY_SCHEMAS.comments,
  },
  flows: {
    name: 'flow',
    collection: 'flows',
    home: 'diagramDoc',
    monolith: false,
    idField: 'id',
    storeSlice: 'flows',
    journal: 'diagram',
    shards: null,
    draftCollection: 'flow',
    projection: { table: 'ro_flows', via: 'diagramFlowIndex', inventoried: true },
    schema: ENTITY_SCHEMAS.flows,
  },
  diagrams: {
    name: 'diagram',
    collection: 'diagrams',
    home: 'registryShard',
    monolith: false,
    idField: 'id',
    storeSlice: 'diagrams',
    journal: 'stub',
    shards: null,
    draftCollection: 'diagram',
    projection: { table: 'ro_diagrams', via: 'modelExtraction', inventoried: true },
    schema: ENTITY_SCHEMAS.diagrams,
  },
} as const satisfies { readonly [C in EntityCollection]: EntityFamily<C> }

type Families = (typeof ENTITY_FAMILIES)[EntityCollection]
type FamiliesWhere<P> = Extract<Families, P>

export type EntityFamilyName = Families['name']
/** Collections of the pre-sharding monolithic ModelDoc (`RootModel`). */
export type MonolithCollection = FamiliesWhere<{ readonly monolith: true }>['collection']
/** Collections carried inline on the ModelMeta. */
export type ModelMetaInlineCollection = FamiliesWhere<{ readonly home: 'modelMeta' }>['collection']
export type DiagramDocCollection = FamiliesWhere<{ readonly home: 'diagramDoc' }>['collection']
export type SmallJournalKind = FamiliesWhere<{ readonly journal: 'small' }>['name']
export type DiagramJournalKind = FamiliesWhere<{ readonly journal: 'diagram' }>['name']
export type EntityJournalKind = FamiliesWhere<{ readonly journal: 'entity' }>['name']
export type EntityStoreSlice = Families['storeSlice']

/** Every family, in declaration order. */
export const ENTITY_FAMILY_LIST: readonly Families[] = Object.values(ENTITY_FAMILIES)

function collectionsWhere<C extends EntityCollection>(keep: (family: Families) => boolean): readonly C[] {
  return Object.freeze(ENTITY_FAMILY_LIST.filter(keep).map((family) => family.collection as C))
}

function namesWhere<N extends EntityFamilyName>(keep: (family: Families) => boolean): readonly N[] {
  return Object.freeze(ENTITY_FAMILY_LIST.filter(keep).map((family) => family.name as N))
}

/** Replaces bridge.ts `MODEL_KEYS`. */
export const MONOLITH_COLLECTIONS = collectionsWhere<MonolithCollection>((family) => family.monolith)
/** Replaces bridge.ts `MODEL_SMALL_KEYS`. */
export const MODEL_META_INLINE_COLLECTIONS = collectionsWhere<ModelMetaInlineCollection>(
  (family) => family.home === 'modelMeta',
)
/** Replaces entityIntents.ts' literal `SMALL_COLLECTION_INTENT_KINDS`. */
export const SMALL_JOURNAL_KINDS = namesWhere<SmallJournalKind>((family) => family.journal === 'small')
/** Replaces entityIntents.ts' literal `DIAGRAM_COLLECTION_INTENT_KINDS`. */
export const DIAGRAM_JOURNAL_KINDS = namesWhere<DiagramJournalKind>((family) => family.journal === 'diagram')
/** Every store slice that carries durable family data (persistentSlices.ts). */
export const ENTITY_STORE_SLICES: readonly EntityStoreSlice[] = Object.freeze(
  ENTITY_FAMILY_LIST.map((family) => family.storeSlice),
)

/** The family a journal kind belongs to. */
export const ENTITY_FAMILY_BY_NAME = Object.freeze(
  Object.fromEntries(ENTITY_FAMILY_LIST.map((family) => [family.name, family])),
) as { readonly [N in EntityFamilyName]: Extract<Families, { readonly name: N }> }

/** The map key of an entity of `family`, or '' when it carries none. Same
 * contract as the per-kind ternary it replaced in bridge.ts: no guard for a
 * non-object value (the journal only ever holds entity snapshots). */
export function entityKeyOf(family: { readonly idField: 'id' | 'tagId' }, value: unknown): string {
  return String((value as Record<string, unknown>)[family.idField] ?? '')
}
