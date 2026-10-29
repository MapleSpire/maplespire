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

export type C4Type = 'actor' | 'system' | 'app' | 'store' | 'component'
export type ShapeType = C4Type | 'group'
/** Shape kinds a governed technology can recommend. Actors deliberately stay
 * outside this set: selecting any shape-specific technology on an actor is a
 * compatibility warning, not a valid catalog recommendation. */
export type TechnologyShapeType = Exclude<ShapeType, 'actor'>

export interface Domain {
  id: string
  name: string
  description?: string
  parentId?: string
  color?: string
}

export type TechnologyRole =
  | 'primary'
  | 'language'
  | 'runtime'
  | 'framework'
  | 'library'
  | 'database'
  | 'storage'
  | 'messaging'
  | 'protocol'
  | 'platform'
  | 'infrastructure'
  | 'tooling'
  | 'other'

/** Minimal immutable rendering data copied into an Automerge usage. */
export interface TechnologySnapshot {
  schemaVersion: 1
  name: string
  iconLightPath?: string
  iconDarkPath?: string
  /** Catalog guidance copied into Automerge so compatibility feedback remains
   * available when the catalog server is offline. */
  recommendedShapeTypes?: TechnologyShapeType[]
  /** The catalog default at selection time. `TechnologyUsage.role` is the
   * per-object value and can be changed independently by the user. */
  defaultRole?: TechnologyRole
}

/**
 * One governed technology as used by one model object. `technologyId`,
 * `catalogRevision` and `snapshot` identify the selected catalog revision and
 * are replaced as a unit (with a fresh usage id) when that identity changes.
 */
export interface TechnologyUsage {
  id: string
  technologyId: string
  catalogRevision: number
  usedVersion?: string
  role?: TechnologyRole
  notes?: string
  snapshot: TechnologySnapshot
}

export type ShapeIconAssignmentMode = 'automatic' | 'explicit'

/**
 * Stable provenance for the artwork rendered on a shape. Technology-backed
 * artwork keeps the usage id that supplied it, so reordering usages never
 * changes the icon accidentally. Generic artwork deliberately has no
 * technologyUsageId and therefore never creates a TechnologyUsage.
 */
export interface ShapeIconAssignment {
  source: 'technology' | 'generic'
  mode: ShapeIconAssignmentMode
  displayName: string
  iconLightPath?: string
  iconDarkPath?: string
  technologyUsageId?: string
  catalogRevision?: number
}

export interface Position {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export type OwnerAssignmentKind = 'team' | 'person'
export type OwnerAssignmentSource = 'platform' | 'external'

/** Minimal durable contact snapshot carried by a shape. Platform identities and
 * organization teams keep their stable catalog id while external contacts get a
 * local id, so ownership stays readable and editable while offline. */
export interface OwnerPersonSnapshot {
  id: string
  name: string
  email?: string
}

export interface OwnerAssignment {
  id: string
  kind: OwnerAssignmentKind
  source: OwnerAssignmentSource
  name: string
  /** Organization team id or platform user id when the assignment is governed. */
  catalogId?: string
  email?: string
  title?: string
  organization?: string
  /** Team membership snapshot is intentionally bounded; memberCount records the
   * authoritative total when a very large team is only partially snapshotted. */
  memberCount?: number
  members?: OwnerPersonSnapshot[]
}

/** A durable external reference attached to a model object. Legacy workspaces
 * may still contain plain URL strings, so readers must accept both forms. */
export interface ObjectLink {
  url: string
  label?: string
}

export type ObjectLinkValue = string | ObjectLink

export interface C4Object {
  id: string
  type: C4Type
  name: string
  /** Compact, plain-text summary rendered on the diagram shape (120 chars max in the editor). */
  shortDescription?: string
  /** Unbounded Markdown documentation edited separately from the compact summary. */
  description?: string
  technologyUsages?: Record<string, TechnologyUsage>
  /** Functional order of stable usage ids, persisted in Automerge. */
  technologyUsageOrder?: string[]
  /** Display label retained for compact renderers and exports. */
  icon?: string
  iconAssignment?: ShapeIconAssignment
  position: Position
  size: Size
  parentId?: string
  domainId?: string
  /** Stable governed Tag assignments, keyed by canonical Tag id. */
  tagAssignments: Record<string, TagAssignment>
  /** Functional application order. The first applicable Tag drives connections. */
  tagOrder: string[]
  /** Ordered durable ownership snapshots (organization teams, users or external contacts). */
  ownerAssignments?: Record<string, OwnerAssignment>
  ownerAssignmentOrder?: string[]
  /** Stable organization ownership/association IDs used by governed filters.
   * ownerTeamIds remains the indexed compatibility projection for team assignments. */
  ownerTeamIds?: string[]
  teamIds?: string[]
  links?: ObjectLinkValue[]
  /**
   * DEFAULT scope only. Whether an object is internal or external is decided per
   * diagram — `Diagram.objectScopes` override, then the C4 boundary rule, then
   * this value (`lib/diagrams/objectScope.ts`). Display copies merged for one
   * diagram carry the EFFECTIVE scope here; never write such a copy back.
   */
  scope: ObjectScope
  status: 'live' | 'draft' | 'down' | 'unstable'
  properties: Record<string, string>
}

export type ObjectScope = 'internal' | 'external'

export type ConnectionShape = 'curved' | 'straight'

export interface Connection {
  id: string
  fromId: string
  toId: string
  label?: string
  /** Unbounded Markdown documentation for the relationship. */
  description?: string
  technologyUsages?: Record<string, TechnologyUsage>
  technologyUsageOrder?: string[]
  /** Stable governed Tag assignments, keyed by canonical Tag id. */
  tagAssignments?: Record<string, TagAssignment>
  tagOrder?: string[]
  /** Ordered durable ownership snapshots, matching shape ownership semantics. */
  ownerAssignments?: Record<string, OwnerAssignment>
  ownerAssignmentOrder?: string[]
  ownerTeamIds?: string[]
  labelPosition?: number
  labelOffset?: number
  type: 'solid' | 'dashed' | 'dotted'
  /** Line shape. Defaults to 'curved' when undefined. New connections are stamped with the diagram's `defaultConnectionShape`. */
  shape?: ConnectionShape
  /** Intermediate bend points (world coordinates) the line routes through, in order from source to target. */
  waypoints?: Position[]
  fromAnchor?: number
  toAnchor?: number
  lockedToAnchors?: boolean
  hidden?: 'source' | 'target' | 'both'
  showOnFocus?: boolean
  /**
   * Free-form key/value provenance, mirroring `C4Object.properties`.
   *
   * An edge carries facts a label cannot: the source system's own id for it, an
   * interaction style, a runbook URL, whatever the customer put on it. Without
   * this an importer has nowhere to put them and no exporter can pair an edge
   * back to the row it came from — the same problem `C4Object.properties`
   * already solved for shapes. Optional, and absent when empty, so nothing that
   * predates it changes shape.
   */
  properties?: Record<string, string>
  kind?: 'direct' | 'lower'
  status?: 'live' | 'draft' | 'down' | 'unstable'
  // ── 3D-view routing overrides ─────────────────────────────────────────────
  // The 2D/3D canvas keeps SEPARATE visual adjustments per mode: the model
  // (endpoints, label text, semantic line type, status) is shared, while the
  // routing/placement fields below shadow their 2D twins when the 3D board is
  // active. Read rule: 3D value ?? 2D value; edits made in 3D write ONLY these
  // (see modelStore's fork-on-first-3D-edit). `waypoints3d: []` means
  // "explicitly no bends in 3D" (distinct from unset = inherit 2D).
  waypoints3d?: Position[]
  fromAnchor3d?: number
  toAnchor3d?: number
  lockedToAnchors3d?: boolean
  labelPosition3d?: number
  labelOffset3d?: number
  shape3d?: ConnectionShape
}

/**
 * How ONE diagram routes a derived (`kind: 'lower'`) connection — the same
 * routing fields a Connection carries, 2D and 3D. Held in
 * `Diagram.lowerRouting`, keyed by the lower's endpoint pair; see
 * `src/lib/diagrams/lowerRouting.ts` for why it is not on the lower itself.
 */
export type LowerConnectionRouting = Pick<
  Connection,
  | 'waypoints' | 'fromAnchor' | 'toAnchor' | 'lockedToAnchors' | 'labelPosition' | 'labelOffset' | 'shape'
  | 'waypoints3d' | 'fromAnchor3d' | 'toAnchor3d' | 'lockedToAnchors3d' | 'labelPosition3d' | 'labelOffset3d' | 'shape3d'
>

export interface Diagram {
  id: string
  name: string
  type: 'context' | 'container' | 'component'
  description?: string
  objectIds: string[]
  connectionIds: string[]
  groupIds: string[]
  parentObjectId?: string
  /** The view key this diagram was imported under (Structurizr `container x "Key"`).
   *  Kept so an export re-emits the SAME key: Structurizr deep links and
   *  `filtered <baseKey>` references point at it, and a key that churns on every
   *  round trip makes a checked-in .dsl undiffable. */
  sourceViewKey?: string
  domainId?: string
  connectionHighlightStyle?: ConnectionHighlightStyle
  connectionAnimationsEnabled?: boolean
  /** Default line shape for connections that don't set their own `shape`. Defaults to 'curved'. */
  defaultConnectionShape?: ConnectionShape
  readonly?: boolean
  skinId?: string
  layouts?: Record<string, { position: Position; size: Size }>
  /**
   * The 3D board's separate placement layer (objects AND groups, like `layouts`).
   * Absent until the first edit made in 3D mode forks the diagram (see
   * modelStore.ensureFork3d): before that the 3D view live-mirrors `layouts`;
   * after, each mode is adjusted independently. Elements added post-fork resolve
   * per-element (3D ?? 2D) until adjusted in 3D. "Align 3D with 2D" deletes it.
   */
  layouts3d?: Record<string, { position: Position; size: Size }>
  /**
   * Routing of this diagram's derived (`kind: 'lower'`) connections, keyed by
   * endpoint pair `${fromId}→${toId}`. A lower is re-derived (and its object
   * replaced) on every projection and is never persisted, so its routing lives
   * here, beside `layouts`, and is merged onto it when the diagram is drawn
   * (`resolveLowerRouting`). An entry is ABSOLUTE: a field it lacks is cleared.
   */
  lowerRouting?: Record<string, LowerConnectionRouting>
  /**
   * Per-diagram internal/external overrides, keyed by object id. Absent entry =
   * resolve from the C4 boundary rule, then the object's default scope (see
   * `lib/diagrams/objectScope.ts`). Lives only in the DiagramDoc, like `layouts`.
   */
  objectScopes?: Record<string, ObjectScope>
  /**
   * Scene decoration (3D board): curated prop pack + density + board style,
   * placed deterministically from the seed — shared with the team exactly
   * like `skinId`. Sanitized shape: `canvas3d/decor/decorSpec` (three-free).
   */
  sceneDecor?: import('../canvas3d/decor/decorSpec').SceneDecor3D
}

export type FlowStepType = 'introduction' | 'message' | 'process' | 'information' | 'conclusion'

export interface FlowStepBase {
  id: string
  order: number
  type: FlowStepType
  title: string
  description?: string
}

export interface IntroductionStep extends FlowStepBase {
  type: 'introduction'
}

export interface MessageStep extends FlowStepBase {
  type: 'message'
  fromObjectId: string
  toObjectId: string
  connectionId: string
}

export interface ProcessStep extends FlowStepBase {
  type: 'process'
  objectId: string
}

export interface InformationStep extends FlowStepBase {
  type: 'information'
}

export interface ConclusionStep extends FlowStepBase {
  type: 'conclusion'
}

export type FlowStep = IntroductionStep | MessageStep | ProcessStep | InformationStep | ConclusionStep

export interface Flow {
  id: string
  name: string
  diagramId: string
  steps: FlowStep[]
  domainId?: string
}

export type CommentType = 'question' | 'inaccuracy' | 'idea'

export interface CommentReply {
  id: string
  text: string
  /** Display label captured at write time; never compared against an identity.
   *  Legacy entries hold the literal 'You' (see lib/comments/authorship.ts). */
  author: string
  /** Stable `AuthUser.id` of the writer. Absent on legacy and identity-less
   *  (AUTH off) entries. */
  authorId?: string
  createdAt: string
}

export interface Comment {
  id: string
  diagramId: string
  type: CommentType
  text: string
  position: Position
  /** Display label captured at write time; never compared against an identity.
   *  Legacy entries hold the literal 'You' (see lib/comments/authorship.ts). */
  author: string
  /** Stable `AuthUser.id` of the writer. Absent on legacy and identity-less
   *  (AUTH off) entries. */
  authorId?: string
  createdAt: string
  resolved: boolean
  pinned: boolean
  replies: CommentReply[]
}

export interface TagAssignment {
  tagId: string
}

/**
 * Sanitized workspace fallback for rendering governed Tags before the central
 * catalog/cache is available. It is never authoritative for identity, tenant
 * ownership, authorization, or lifecycle.
 */
export interface TagSnapshot {
  tagId: string
  value: string
  color: string
  groupId: string
  groupName: string
  catalogRevision: number
}

/** UI/export view name for a sanitized Tag snapshot; not a catalog entity. */
export type Tag = TagSnapshot

export type ConnectionHighlightStyle =
  | 'none'
  | 'traveling-dot'
  | 'gradient-flow'
  | 'lightning'
  | 'pulse'
  | 'sparkle'
  | 'energy-beam'
  | 'neon-dash'
  | 'strands'
  | 'electric'

export interface SelectedItem {
  id: string
  type: 'object' | 'group' | 'connection'
}

export interface Group {
  id: string
  name: string
  /** Governed technologies can also describe a diagram group. */
  technologyUsages?: Record<string, TechnologyUsage>
  /** Functional order of stable usage ids, persisted in Automerge. */
  technologyUsageOrder?: string[]
  /** Background / fill color. */
  color: string
  /** Separate border color; falls back to `color` when unset. */
  borderColor?: string
  /** Border line width in px; defaults to the theme's natural width when unset. */
  borderWidth?: number
  /** Fill alpha 0..1; defaults to the skin's `groups.standardFillAlpha`. */
  fillOpacity?: number
  /** When true the background is not drawn (border only). */
  fillTransparent?: boolean
  icon?: string
  iconAssignment?: ShapeIconAssignment
  objectIds: string[]
  position?: Position
  size?: Size
  autoSize?: boolean
  domainId?: string
  parentObjectId?: string
  /**
   * VIEW-ONLY, never persisted: the parent wrappers drawn inside this one, set
   * only by the inline-expansion planner (`expandInline.ts`) on the wrappers it
   * hands the engine. The engine draws this box around theirs, not just around
   * the shapes, so a nested header band cannot poke through the outer border.
   */
  innerWrapperIds?: string[]
  description?: string
  type?: string
  /**
   * Free-form key/value provenance, mirroring `C4Object.properties`.
   *
   * A boundary imported from another tool is an entity there, with an id and
   * fields of its own (a deployment node's environment, instance count and
   * URL). Flattening them into `description` makes three same-named nodes
   * indistinguishable and un-round-trippable. Optional and absent when empty.
   */
  properties?: Record<string, string>
  /** Stable governed Tag assignments, keyed by canonical Tag id. */
  tagAssignments: Record<string, TagAssignment>
  /** Functional application order, persisted in Automerge. */
  tagOrder: string[]
}

export type ADRStatus = 'in-progress' | 'approved' | 'rejected'

export type ADRLinkType = 'url' | 'adr' | 'diagram' | 'draft'

export interface ADRLink {
  id: string
  type: ADRLinkType
  label: string
  targetId?: string
  url?: string
}

/** A single status transition in a decision record's life — drives the timeline. */
export interface ADRStatusEvent {
  status: ADRStatus
  date: string
}

export interface DecisionRecord {
  id: string
  number: number
  title: string
  summary: string
  status: ADRStatus
  /** Human display label for the creator. Historically this was a *translated*
   *  constant ("You" / "Vous"), so it can never be compared against an identity —
   *  that is what `ownerId` is for. */
  author: string
  /** Stable `AuthUser.id` of the creator, when one was known at creation.
   *  Optional: every pre-existing and seeded record has none, and the read-model
   *  row validator would reject them if it were required. A record without an
   *  owner is deletable by nobody, which is the safe default. */
  ownerId?: string
  createdAt: string
  updatedAt: string
  content: string
  related: ADRLink[]
  /** Status history (newest appended last). Older records may omit it — the
   *  timeline derives a minimal one from createdAt/updatedAt + status in that case. */
  history?: ADRStatusEvent[]
}
