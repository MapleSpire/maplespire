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
  ADRLink,
  ADRStatusEvent,
  C4Object,
  Comment,
  CommentReply,
  Connection,
  DecisionRecord,
  Diagram,
  Domain,
  Flow,
  FlowStep,
  Group,
  LowerConnectionRouting,
  ObjectLink,
  OwnerAssignment,
  OwnerPersonSnapshot,
  Position,
  ShapeIconAssignment,
  Size,
  TagAssignment,
  TagSnapshot,
  TechnologySnapshot,
  TechnologyUsage,
} from '../../types'
import type { SceneDecor3D, SceneDecorPropOverride } from '../../canvas3d/decor/decorSpec'
import { EXACT, listOf, mapOf, structOf, type MapSchema, type StructSchema } from './reconcile'
import type { Checkpoint, DiagramDoc, DiagramMeta, RootModel } from './types'

/**
 * The KNOWN keys of every reconciled collection, for THIS build's schema
 * version (V0-08). `reconcile` deletes a key the target lacks only when it is
 * known here; any other key on a stored entity was written by a newer client
 * and is kept, so an N-1 client editing a document no longer wipes the fields
 * it cannot represent.
 *
 * Derived from the TypeScript types, and checked against them at COMPILE time
 * by `structOf<T>` (reconcile.ts), which demands:
 *  - exactly one entry per key of `T` (all members of a union): a field added
 *    to a type and not listed here fails `tsc -b`, and so does a listed field
 *    the type no longer has;
 *  - for each field, the schema KIND its type requires (`SchemaFor`): an
 *    object field declared `EXACT`, a `Record` declared as a struct, an array
 *    of objects without `listOf`, or a struct of ANOTHER type all fail;
 *  - an explicit, non-index-signature type argument.
 * `knownKeys.test.ts` pins each with `@ts-expect-error`. Every struct here is
 * written against the type it describes (`PLACEMENT` against
 * `Diagram['layouts']`), so a nested struct drifting from its field's type
 * fails at the field that uses it. Adding a field to a type and here is
 * therefore one edit the compiler forces, and it is what makes clearing that
 * field (writing the entity without it) a deletion again.
 *
 * What the compiler does NOT check: that a field kept as a struct/list is the
 * right CHOICE where both are admissible (`EXACT` vs `listOf(EXACT)` for an
 * array of primitives — equivalent at runtime), and anything about fields a
 * future type REMOVES (they become unknown, hence never deleted again).
 *
 * `EXACT` marks a leaf (primitive, array of primitives) or a value whose keys
 * are all data (`Record<string, string>`); `mapOf` an id-keyed map; `listOf`
 * an array whose elements keep their unknown fields only while the index walk
 * pairs the same entity (see `elementSchema` in reconcile.ts).
 */

const POSITION = structOf<Position>({ x: EXACT, y: EXACT })
const SIZE = structOf<Size>({ width: EXACT, height: EXACT })
const PLACEMENT = structOf<NonNullable<Diagram['layouts']>[string]>({ position: POSITION, size: SIZE })

const TECHNOLOGY_SNAPSHOT = structOf<TechnologySnapshot>({
  schemaVersion: EXACT,
  name: EXACT,
  iconLightPath: EXACT,
  iconDarkPath: EXACT,
  recommendedShapeTypes: EXACT,
  defaultRole: EXACT,
})

const TECHNOLOGY_USAGE = structOf<TechnologyUsage>({
  id: EXACT,
  technologyId: EXACT,
  catalogRevision: EXACT,
  usedVersion: EXACT,
  role: EXACT,
  notes: EXACT,
  snapshot: TECHNOLOGY_SNAPSHOT,
})

const ICON_ASSIGNMENT = structOf<ShapeIconAssignment>({
  source: EXACT,
  mode: EXACT,
  displayName: EXACT,
  iconLightPath: EXACT,
  iconDarkPath: EXACT,
  technologyUsageId: EXACT,
  catalogRevision: EXACT,
})

const TAG_ASSIGNMENT = structOf<TagAssignment>({ tagId: EXACT })

const OWNER_PERSON = structOf<OwnerPersonSnapshot>({ id: EXACT, name: EXACT, email: EXACT })

const OWNER_ASSIGNMENT = structOf<OwnerAssignment>({
  id: EXACT,
  kind: EXACT,
  source: EXACT,
  name: EXACT,
  catalogId: EXACT,
  email: EXACT,
  title: EXACT,
  organization: EXACT,
  memberCount: EXACT,
  members: listOf(OWNER_PERSON),
})

const OBJECT_LINK = structOf<ObjectLink>({ url: EXACT, label: EXACT })

export const C4_OBJECT_SCHEMA = structOf<C4Object>({
  id: EXACT,
  type: EXACT,
  name: EXACT,
  shortDescription: EXACT,
  description: EXACT,
  technologyUsages: mapOf(TECHNOLOGY_USAGE),
  technologyUsageOrder: EXACT,
  icon: EXACT,
  iconAssignment: ICON_ASSIGNMENT,
  position: POSITION,
  size: SIZE,
  parentId: EXACT,
  domainId: EXACT,
  tagAssignments: mapOf(TAG_ASSIGNMENT),
  tagOrder: EXACT,
  ownerAssignments: mapOf(OWNER_ASSIGNMENT),
  ownerAssignmentOrder: EXACT,
  ownerTeamIds: EXACT,
  teamIds: EXACT,
  links: listOf(OBJECT_LINK),
  scope: EXACT,
  status: EXACT,
  properties: EXACT,
})

export const CONNECTION_SCHEMA = structOf<Connection>({
  id: EXACT,
  fromId: EXACT,
  toId: EXACT,
  label: EXACT,
  description: EXACT,
  technologyUsages: mapOf(TECHNOLOGY_USAGE),
  technologyUsageOrder: EXACT,
  tagAssignments: mapOf(TAG_ASSIGNMENT),
  tagOrder: EXACT,
  ownerAssignments: mapOf(OWNER_ASSIGNMENT),
  ownerAssignmentOrder: EXACT,
  ownerTeamIds: EXACT,
  labelPosition: EXACT,
  labelOffset: EXACT,
  type: EXACT,
  shape: EXACT,
  waypoints: listOf(POSITION),
  fromAnchor: EXACT,
  toAnchor: EXACT,
  lockedToAnchors: EXACT,
  hidden: EXACT,
  showOnFocus: EXACT,
  properties: EXACT,
  kind: EXACT,
  status: EXACT,
  waypoints3d: listOf(POSITION),
  fromAnchor3d: EXACT,
  toAnchor3d: EXACT,
  lockedToAnchors3d: EXACT,
  labelPosition3d: EXACT,
  labelOffset3d: EXACT,
  shape3d: EXACT,
})

export const GROUP_SCHEMA = structOf<Group>({
  id: EXACT,
  name: EXACT,
  technologyUsages: mapOf(TECHNOLOGY_USAGE),
  technologyUsageOrder: EXACT,
  color: EXACT,
  borderColor: EXACT,
  borderWidth: EXACT,
  fillOpacity: EXACT,
  fillTransparent: EXACT,
  icon: EXACT,
  iconAssignment: ICON_ASSIGNMENT,
  objectIds: EXACT,
  position: POSITION,
  size: SIZE,
  autoSize: EXACT,
  domainId: EXACT,
  parentObjectId: EXACT,
  innerWrapperIds: EXACT,
  description: EXACT,
  type: EXACT,
  properties: EXACT,
  tagAssignments: mapOf(TAG_ASSIGNMENT),
  tagOrder: EXACT,
})

export const DOMAIN_SCHEMA = structOf<Domain>({
  id: EXACT,
  name: EXACT,
  description: EXACT,
  parentId: EXACT,
  color: EXACT,
})

export const TAG_SNAPSHOT_SCHEMA = structOf<TagSnapshot>({
  tagId: EXACT,
  value: EXACT,
  color: EXACT,
  groupId: EXACT,
  groupName: EXACT,
  catalogRevision: EXACT,
})

const ADR_LINK = structOf<ADRLink>({ id: EXACT, type: EXACT, label: EXACT, targetId: EXACT, url: EXACT })
const ADR_STATUS_EVENT = structOf<ADRStatusEvent>({ status: EXACT, date: EXACT })

export const DECISION_RECORD_SCHEMA = structOf<DecisionRecord>({
  id: EXACT,
  number: EXACT,
  title: EXACT,
  summary: EXACT,
  status: EXACT,
  author: EXACT,
  ownerId: EXACT,
  createdAt: EXACT,
  updatedAt: EXACT,
  content: EXACT,
  related: listOf(ADR_LINK),
  history: listOf(ADR_STATUS_EVENT),
})

const COMMENT_REPLY = structOf<CommentReply>({
  id: EXACT,
  text: EXACT,
  author: EXACT,
  authorId: EXACT,
  createdAt: EXACT,
})

export const COMMENT_SCHEMA = structOf<Comment>({
  id: EXACT,
  diagramId: EXACT,
  type: EXACT,
  text: EXACT,
  position: POSITION,
  author: EXACT,
  authorId: EXACT,
  createdAt: EXACT,
  resolved: EXACT,
  pinned: EXACT,
  replies: listOf(COMMENT_REPLY),
})

/** Every member of the `FlowStep` union: a step whose `type` changes drops
 * the previous variant's fields because they are all known here. */
const FLOW_STEP = structOf<FlowStep>({
  id: EXACT,
  order: EXACT,
  type: EXACT,
  title: EXACT,
  description: EXACT,
  fromObjectId: EXACT,
  toObjectId: EXACT,
  connectionId: EXACT,
  objectId: EXACT,
})

export const FLOW_SCHEMA = structOf<Flow>({
  id: EXACT,
  name: EXACT,
  diagramId: EXACT,
  steps: listOf(FLOW_STEP),
  domainId: EXACT,
})

export const DIAGRAM_META_SCHEMA = structOf<DiagramMeta>({
  id: EXACT,
  name: EXACT,
  type: EXACT,
  docUrl: EXACT,
  parentObjectId: EXACT,
  objectIds: EXACT,
  connectionIds: EXACT,
  groupIds: EXACT,
  objectScopes: mapOf(EXACT),
})

const CHECKPOINT = structOf<Checkpoint>({ id: EXACT, label: EXACT, heads: EXACT, createdAt: EXACT })

const LOWER_ROUTING = structOf<LowerConnectionRouting>({
  waypoints: listOf(POSITION),
  fromAnchor: EXACT,
  toAnchor: EXACT,
  lockedToAnchors: EXACT,
  labelPosition: EXACT,
  labelOffset: EXACT,
  shape: EXACT,
  waypoints3d: listOf(POSITION),
  fromAnchor3d: EXACT,
  toAnchor3d: EXACT,
  lockedToAnchors3d: EXACT,
  labelPosition3d: EXACT,
  labelOffset3d: EXACT,
  shape3d: EXACT,
})

const SCENE_DECOR_PROP = structOf<SceneDecorPropOverride>({
  skip: EXACT,
  dx: EXACT,
  dz: EXACT,
  rotY: EXACT,
  scale: EXACT,
})

const SCENE_DECOR = structOf<SceneDecor3D>({
  packId: EXACT,
  density: EXACT,
  boardStyle: EXACT,
  background: EXACT,
  seed: EXACT,
  props: mapOf(SCENE_DECOR_PROP),
})

export const DIAGRAM_DOC_SCHEMA = structOf<DiagramDoc>({
  name: EXACT,
  type: EXACT,
  description: EXACT,
  objectIds: EXACT,
  connectionIds: EXACT,
  groupIds: EXACT,
  parentObjectId: EXACT,
  sourceViewKey: EXACT,
  domainId: EXACT,
  connectionHighlightStyle: EXACT,
  connectionAnimationsEnabled: EXACT,
  defaultConnectionShape: EXACT,
  readonly: EXACT,
  skinId: EXACT,
  layouts: mapOf(PLACEMENT),
  layouts3d: mapOf(PLACEMENT),
  lowerRouting: mapOf(LOWER_ROUTING),
  objectScopes: mapOf(EXACT),
  sceneDecor: SCENE_DECOR,
  comments: mapOf(COMMENT_SCHEMA),
  flows: mapOf(FLOW_SCHEMA),
  checkpoints: listOf(CHECKPOINT),
})

/** The per-collection registry: entity schema by the collection's document
 * field name. Each collection itself is an id-keyed map (`mapOf(entity)`). */
export const ENTITY_SCHEMAS = {
  objects: C4_OBJECT_SCHEMA,
  connections: CONNECTION_SCHEMA,
  groups: GROUP_SCHEMA,
  domains: DOMAIN_SCHEMA,
  tagSnapshots: TAG_SNAPSHOT_SCHEMA,
  decisionRecords: DECISION_RECORD_SCHEMA,
  comments: COMMENT_SCHEMA,
  flows: FLOW_SCHEMA,
  diagrams: DIAGRAM_META_SCHEMA,
} as const satisfies Record<string, StructSchema>

export type EntityCollection = keyof typeof ENTITY_SCHEMAS

/** Schema of a whole id-keyed collection map (what `reconcile(doc[field], byIdMap(...))` takes). */
export const COLLECTION_SCHEMAS = {
  objects: mapOf(C4_OBJECT_SCHEMA),
  connections: mapOf(CONNECTION_SCHEMA),
  groups: mapOf(GROUP_SCHEMA),
  domains: mapOf(DOMAIN_SCHEMA),
  tagSnapshots: mapOf(TAG_SNAPSHOT_SCHEMA),
  decisionRecords: mapOf(DECISION_RECORD_SCHEMA),
  comments: mapOf(COMMENT_SCHEMA),
  flows: mapOf(FLOW_SCHEMA),
  diagrams: mapOf(DIAGRAM_META_SCHEMA),
} as const satisfies { readonly [K in EntityCollection]: MapSchema }

/** The monolithic (pre-sharding) ModelDoc. */
export const ROOT_MODEL_SCHEMA = structOf<RootModel>({
  objects: COLLECTION_SCHEMAS.objects,
  connections: COLLECTION_SCHEMAS.connections,
  groups: COLLECTION_SCHEMAS.groups,
  domains: COLLECTION_SCHEMAS.domains,
  tagSnapshots: COLLECTION_SCHEMAS.tagSnapshots,
  decisionRecords: COLLECTION_SCHEMAS.decisionRecords,
})
