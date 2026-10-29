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

/**
 * The contract the Structurizr workspace-JSON exporter is built against: the
 * wire shapes we EMIT, the id allocator, and the one index every emitter reads.
 *
 * Why these types are not `../../structurizr/json/types.ts`: those are the
 * IMPORTER's tolerant input shapes, where everything is optional and `unknown`
 * because five independent producers disagree about nulls and casing. Reading
 * has to accept all of them; writing has to pick exactly one, and a shape whose
 * every field is optional cannot make the compiler enforce "we always emit
 * coordinates" — which is the whole point of this exporter. The DSL export
 * throws layout away by construction (it is a source format and a renderer
 * places the boxes); Structurizr JSON is the only representation that carries
 * x/y per element per view, so `WireElementView.x`/`.y` are REQUIRED here.
 *
 * Field names, wire types, defaults and enum spellings come from
 * `docs/structurizr-json-format.md` (verified against structurizr/structurizr
 * @main, v6.2.2). Nothing from its §2 legacy register is emittable — those keys
 * have no declaration here at all, so re-adding one is a deliberate act.
 */

import type {
  C4Object,
  C4Type,
  Connection,
  Diagram,
  Group,
  Position,
  Size,
  Tag,
} from '../../../types'
import { orderedTagIds } from '../../tags/assignments'
import { EXTERNAL_TAG_RE, INTERNAL_TAG_RE, SIZE_BY_TYPE } from '../../structurizr/conventions'
import {
  ENVIRONMENT_PROPERTY,
  GROUP_PATH_PROPERTY,
  GROUP_SEPARATOR_PROPERTY,
  INSTANCES_PROPERTY,
  SOURCE_ID_PROPERTY,
  SOURCE_INSTANCE_OF_PROPERTY,
} from '../../structurizr/json/mapWorkspace'
import { STRUCTURIZR_DEFAULT_ELEMENT_SIZE } from '../../structurizr/json/layoutPolicy'
import type { ExportBundle } from '../types'

// ── 1. Enumerations (§16 — exact-case Java constant names) ───────────────────
// An unknown enum string reads back as `null` in Structurizr rather than as an
// error (§4.1), so a lower-cased value here is not a failed import: it is a
// plausible-looking diagram with the field silently gone.

export type WireShape =
  | 'Box'
  | 'RoundedBox'
  | 'Circle'
  | 'Ellipse'
  | 'Hexagon'
  | 'Diamond'
  | 'Cylinder'
  | 'Bucket'
  | 'Pipe'
  | 'Person'
  | 'Robot'
  | 'Folder'
  | 'WebBrowser'
  | 'Window'
  | 'Terminal'
  | 'Shell'
  | 'MobileDevicePortrait'
  | 'MobileDeviceLandscape'
  | 'Component'

export type WireBorder = 'Solid' | 'Dashed' | 'Dotted'
/** Note the declaration order differs from `WireBorder`; map by NAME, never ordinal. */
export type WireLineStyle = 'Dashed' | 'Dotted' | 'Solid'
export type WireRouting = 'Direct' | 'Curved' | 'Orthogonal'
export type WireIconPosition = 'Top' | 'Bottom' | 'Left'
export type WireColorScheme = 'Light' | 'Dark'
export type WireInteractionStyle = 'Synchronous' | 'Asynchronous'
export type WireFormat = 'Markdown' | 'AsciiDoc'
export type WireWorkspaceScope = 'Landscape' | 'SoftwareSystem'

// ── 2. Model ─────────────────────────────────────────────────────────────────

/** String→string only. A number or a nested object here is not the format. */
export type WireProperties = Record<string, string>

export interface WirePerspective {
  name: string
  /** Optional since v6.1.0 — do not synthesise one. */
  description?: string
  value?: string
  /** A perspective carrying `url` is DYNAMIC; its value is fetched at render
   *  time. `setUrl("")` throws on read, so never emit an empty string. */
  url?: string
}

/**
 * Nested under its SOURCE element. There is no `model.relationships` (T6), so a
 * relationship is emitted exactly once, on the element whose id is `sourceId`.
 */
export interface WireRelationship {
  /** Same id space as elements — one counter issues both (§4.5), which is why
   *  `ExportIds` allocates for objects, groups and connections together. */
  id: string
  /** Always equal to the id of the element this is nested under. A checksum. */
  sourceId: string
  destinationId: string
  description?: string
  /** Authoritative even on a derived edge (T8) — read it off the edge itself. */
  technology?: string
  /** Comma-separated STRING (T1), defaults first: `Relationship` plus
   *  `Synchronous`/`Asynchronous` when `interactionStyle` is set, and NOTHING at
   *  all on an edge carrying `linkedRelationshipId` (§5.4). */
  tags?: string
  interactionStyle?: WireInteractionStyle
  /** Present means DERIVED, not authored. Emit only when the target edge is
   *  also emitted — a dangling link is a hard read failure in v6.2.2 (rule 16). */
  linkedRelationshipId?: string
  url?: string
  properties?: WireProperties
  perspectives?: WirePerspective[]
}

interface WireElementCommon {
  /** Opaque string. Numeric-looking in practice; never parsed as a number. */
  id: string
  name: string
  description?: string
  /** Comma-separated STRING (T1) with the type defaults FIRST, in declaration
   *  order, then the author's tags. The importer stripped the defaults on the
   *  way in; re-adding them is this exporter's job (§7.1). */
  tags: string
  /** ONE flat string even when nested (T5). If any value contains the nesting
   *  separator, `model.properties["structurizr.groupSeparator"]` must declare
   *  it or every reader flattens the hierarchy. */
  group?: string
  url?: string
  properties?: WireProperties
  perspectives?: WirePerspective[]
  relationships?: WireRelationship[]
}

/** People carry no `documentation` and no `technology`. [MEASURED] 0/28. */
export type WirePerson = WireElementCommon

export interface WireSoftwareSystem extends WireElementCommon {
  /** *** NESTED. There is no `model.containers`. *** */
  containers?: WireContainer[]
}

export interface WireContainer extends WireElementCommon {
  technology?: string
  components?: WireComponent[]
}

export type WireComponent = WireElementCommon & { technology?: string }

export interface WireCustomElement extends WireElementCommon {
  /** Free text, and also the element's terminology label (§5.2). */
  metadata?: string
}

export interface WireInfrastructureNode extends WireElementCommon {
  environment: string
  technology?: string
}

interface WireInstanceCommon {
  /** The instance's OWN element id — deployment views reference THIS, not the
   *  id of the thing being instantiated. */
  id: string
  instanceId: number
  environment: string
  /** Instances get NO `Element` tag: `"Container Instance"` / `"Software System
   *  Instance"` are stored tags the constructor added, and nothing else (§5.5). */
  tags: string
  /** No default. Never materialise `["Default"]` — v6.2.0 removed it, and
   *  synthesising it writes a group into the customer's workspace that current
   *  Structurizr does not have (T27). */
  deploymentGroups?: string[]
  group?: string
  url?: string
  properties?: WireProperties
  perspectives?: WirePerspective[]
  relationships?: WireRelationship[]
  /** *** There is no `name` key. Readers dereference the id below. *** */
}

export type WireContainerInstance = WireInstanceCommon & { containerId: string }
export type WireSoftwareSystemInstance = WireInstanceCommon & { softwareSystemId: string }

export interface WireDeploymentNode extends WireElementCommon {
  environment: string
  technology?: string
  /** A STRING, and legally a range (`"0..5"`, `"1..N"`) — never a number (T15). */
  instances?: string
  /** Inherited by every descendant instance (§5.5), so a value here is not
   *  cosmetic: it decides which relationships Structurizr replicates. */
  deploymentGroups?: string[]
  children?: WireDeploymentNode[]
  infrastructureNodes?: WireInfrastructureNode[]
  containerInstances?: WireContainerInstance[]
  softwareSystemInstances?: WireSoftwareSystemInstance[]
}

export interface WireModel {
  /** Holds `structurizr.groupSeparator`, which MUST be declared whenever any
   *  emitted `group` string is a nested path. */
  properties?: WireProperties
  people?: WirePerson[]
  softwareSystems?: WireSoftwareSystem[]
  customElements?: WireCustomElement[]
  /** TOP-LEVEL nodes only; descendants live in `children[]`. */
  deploymentNodes?: WireDeploymentNode[]
}

// ── 3. Views ─────────────────────────────────────────────────────────────────

/**
 * The reason this feature exists. `x`/`y` are REQUIRED, top-left, in
 * Structurizr's 300-dpi space — not the centre (§6.3): a renderer computes
 * `maximumX = x + style.width`, so emitting centres shifts every element by
 * half a box. There is no width/height here; the box comes from the resolved
 * `ElementStyle`, which is why the styles emitter and the views emitter have to
 * agree on sizes (`STRUCTURIZR_DEFAULT_ELEMENT_SIZE`).
 */
export interface WireElementView {
  id: string
  x: number
  y: number
}

export interface WireVertex {
  x: number
  y: number
}

export interface WireRelationshipView {
  /** NOT unique within a dynamic view — identity is `(id, description, order)` (T9). */
  id: string
  /** Dynamic views: the step number, a STRING (`"1"`, `"1.1"`). */
  order?: string
  description?: string
  /** Dynamic views: the return leg. Never emit one without its request (v6.2.0). */
  response?: boolean
  /** ABSOLUTE canvas coordinates in the same 300-dpi space, in path order. */
  vertices?: WireVertex[]
  routing?: WireRouting
  /** 0–100 ALONG the line for the label — a percentage, not pixels, not an offset. */
  position?: number
}

/**
 * Common to every view we emit.
 *
 * Deliberately absent, and not by oversight:
 *
 * - `automaticLayout` — a view carrying it is re-laid-out by the renderer, which
 *   discards the coordinates we just wrote. Emitting layout is the point of this
 *   exporter, so the key has no declaration and cannot be set by accident.
 * - `name` — computed and read-only upstream (§6.2). `title` is the authored one.
 * - `animations` — MapleSpire has no per-view animation source; flows become
 *   dynamic views, which cannot carry animations anyway (§6.1).
 * - the boundary-visibility flags — `ComponentView` cannot even read back the
 *   spelling it writes (§6.1), both members are deprecated, and we cannot
 *   reproduce the semantics, so we do not assert them.
 */
interface WireViewCommon {
  /** THE identity, unique workspace-wide. Never contains `/` (it becomes `_`). */
  key: string
  /** An explicit `0` reads back as `1`, so absence and zero differ (§6.2). */
  order?: number
  title?: string
  description?: string
  properties?: WireProperties
  elements: WireElementView[]
  relationships?: WireRelationshipView[]
}

export type WireSystemLandscapeView = WireViewCommon
export type WireSystemContextView = WireViewCommon & { softwareSystemId: string }
export type WireContainerView = WireViewCommon & { softwareSystemId: string }
/** Scoped by `containerId` ONLY — a component view has no `softwareSystemId`. */
export type WireComponentView = WireViewCommon & { containerId: string }
/** `elementId` is polymorphic (a system id OR a container id) or absent. */
export type WireDynamicView = WireViewCommon & { elementId?: string }
export type WireDeploymentView = WireViewCommon & {
  softwareSystemId?: string
  environment: string
}

export interface WireViewSet {
  systemLandscapeViews?: WireSystemLandscapeView[]
  systemContextViews?: WireSystemContextView[]
  containerViews?: WireContainerView[]
  componentViews?: WireComponentView[]
  dynamicViews?: WireDynamicView[]
  deploymentViews?: WireDeploymentView[]
}

// ── 4. Styles and view configuration ─────────────────────────────────────────

/** On a STYLE, `metadata` and `description` are booleans (show/hide); on a model
 *  item, `description` is a string and `metadata` is free text (T13). */
export interface WireElementStyle {
  tag: string
  shape?: WireShape
  /** `#rrggbb`, lowercase, EXACTLY seven characters. `#fff` aborts a Java read
   *  outright (§7.7), so a short hex is not a cosmetic slip. */
  background?: string
  color?: string
  stroke?: string
  strokeWidth?: number
  width?: number
  height?: number
  fontSize?: number
  border?: WireBorder
  /** Percentage 0–100, never a 0–1 fraction (a fraction silently becomes 0). */
  opacity?: number
  icon?: string
  iconPosition?: WireIconPosition
  metadata?: boolean
  description?: boolean
  /** Absent means the style applies to BOTH schemes. */
  colorScheme?: WireColorScheme
  properties?: WireProperties
}

export interface WireRelationshipStyle {
  tag: string
  thickness?: number
  color?: string
  fontSize?: number
  /** Width of the LABEL, not of the line. */
  width?: number
  dashed?: boolean
  /** Authoritative; `dashed` is consulted only when nothing set this (§7.6/5). */
  style?: WireLineStyle
  routing?: WireRouting
  position?: number
  opacity?: number
  metadata?: boolean
  description?: boolean
  colorScheme?: WireColorScheme
  properties?: WireProperties
}

export interface WireStyles {
  elements?: WireElementStyle[]
  relationships?: WireRelationshipStyle[]
}

export interface WireViewConfiguration {
  /** Styles live HERE, never under the workspace-level `configuration` (T14). */
  styles?: WireStyles
  /** Always the plural key; `theme` is a read-only legacy alias. */
  themes?: string[]
  /** A view KEY. */
  defaultView?: string
  lastSavedView?: string
  properties?: WireProperties
}

export interface WireViews extends WireViewSet {
  configuration?: WireViewConfiguration
}

// ── 5. Documentation ─────────────────────────────────────────────────────────

export interface WireSection {
  content: string
  format: WireFormat
  order: number
  /** Write-only constant `""` upstream: the getter is hardcoded and there is no
   *  field, so a real title here is discarded by Structurizr's own reader. */
  title: string
  filename?: string
  /** Round-trips intact and is never validated — the only element association
   *  the format offers for documentation. */
  elementId?: string
}

export interface WireDecisionLink {
  /** A DECISION id, not an element id. */
  id: string
  description?: string
}

export interface WireDecision {
  /** Arbitrary user-supplied string, not from the element id counter. */
  id: string
  title: string
  /** `yyyy-MM-dd'T'HH:mm:ss'Z'`. */
  date: string
  /** FREE-FORM string, not an enum, despite the conventional five values. */
  status: string
  content?: string
  format?: WireFormat
  elementId?: string
  links?: WireDecisionLink[]
}

export interface WireDocumentation {
  sections?: WireSection[]
  decisions?: WireDecision[]
}

// ── 6. The workspace envelope ────────────────────────────────────────────────

export interface WireWorkspaceConfiguration {
  scope?: WireWorkspaceScope
}

export interface WireWorkspace {
  /** A NUMBER (Java long) — the one id in the document that is not a string.
   *  Structurizr Lite overwrites it from the directory name, so it is not
   *  identity; it exists because readers expect the key. */
  id: number
  name: string
  description?: string
  version?: string
  lastModifiedDate?: string
  /** Provenance. Ours names MapleSpire so a customer can tell who wrote a file. */
  lastModifiedAgent?: string
  properties?: WireProperties
  configuration?: WireWorkspaceConfiguration
  model: WireModel
  views: WireViews
  documentation?: WireDocumentation
}

// ── 7. `ExportIds` — the one place a collision can happen ────────────────────

/**
 * Anything that gets a wire id: a `C4Object`, a `Connection` or a `Group`.
 * Structured as a duck type rather than a union so the emitters can pass their
 * own synthetic entities (the wrapper system an orphan container needs) through
 * the same allocator, which is the only way those ids stay collision-free too.
 */
export interface WireIdBearer {
  id: string
  properties?: Record<string, string>
}

/** A carried wire id that had to be re-minted, and what it was replaced with. */
export interface ReMintedWireId {
  entityId: string
  carried: string
  minted: string
}

export interface ExportIds {
  /**
   * The wire id for one MapleSpire entity: its `properties['structurizr.id']`
   * when it carries one nothing else has claimed, otherwise a freshly minted
   * one. Stable — the same entity always gets the same answer.
   */
  wireId(entity: WireIdBearer): string
  /** The id already allocated to an entity, without allocating one. */
  peekWireId(entityId: string): string | undefined
  /**
   * The view key for one diagram: its `sourceViewKey` when it has one,
   * otherwise a slug of its name. Unique workspace-wide, compared
   * case-insensitively because Structurizr's own `View.compareTo` is — two keys
   * differing only in case and sharing an `order` silently lose one to a
   * `TreeSet` before any validation runs (§4.3).
   */
  viewKey(diagram: Pick<Diagram, 'id' | 'name' | 'sourceViewKey'>): string
  /** Diagnostics for the export report: duplicated provenance, not a crash. */
  readonly reMinted: readonly ReMintedWireId[]
}

/** Structurizr replaces `/` in a view key with `_`; do it ourselves so the key
 *  we emit is the key we later reference from `defaultView`. */
const VIEW_KEY_UNSAFE = /[^A-Za-z0-9_-]+/g

/**
 * Allocate wire ids against a fixed set of entities.
 *
 * Every carried id in `entities` is reserved BEFORE anything is minted. Minting
 * lazily and hoping the counter stays clear of the carried ids is the bug this
 * seam exists to prevent: element and relationship ids share one id space
 * upstream (§4.5) and a duplicate is not an error there — the `TreeSet` keeps
 * the incumbent and drops the other silently (§4.3), so a collision costs the
 * customer an element or an edge with no message anywhere.
 */
export function createExportIds(entities: Iterable<WireIdBearer>): ExportIds {
  const assigned = new Map<string, string>()
  const takenBy = new Map<string, string>()
  const reMinted: ReMintedWireId[] = []
  const reserved = new Set<string>()
  for (const entity of entities) {
    const carried = carriedWireId(entity)
    if (carried) reserved.add(carried)
  }

  let counter = 0
  const mint = (): string => {
    for (;;) {
      counter += 1
      const candidate = String(counter)
      if (!reserved.has(candidate) && !takenBy.has(candidate)) return candidate
    }
  }

  const claim = (entityId: string, wire: string): string => {
    assigned.set(entityId, wire)
    takenBy.set(wire, entityId)
    return wire
  }

  const viewKeys = new Map<string, string>()
  const usedKeys = new Set<string>()

  return {
    wireId(entity) {
      const existing = assigned.get(entity.id)
      if (existing !== undefined) return existing
      const carried = carriedWireId(entity)
      if (carried === undefined) return claim(entity.id, mint())
      const owner = takenBy.get(carried)
      if (owner === undefined) return claim(entity.id, carried)
      // Two entities carrying one wire id is what duplicating an imported shape
      // in MapleSpire produces — `properties` are copied verbatim, provenance
      // included. The first asker keeps it; the copy is a new element upstream
      // and needs an id of its own.
      const minted = claim(entity.id, mint())
      reMinted.push({ entityId: entity.id, carried, minted })
      return minted
    },
    peekWireId(entityId) {
      return assigned.get(entityId)
    },
    viewKey(diagram) {
      const existing = viewKeys.get(diagram.id)
      if (existing !== undefined) return existing
      const base =
        diagram.sourceViewKey?.trim().replace(/\//g, '_') ||
        diagram.name.trim().replace(VIEW_KEY_UNSAFE, '-').replace(/^-+|-+$/g, '') ||
        'view'
      let key = base
      for (let i = 2; usedKeys.has(key.toLowerCase()); i += 1) key = `${base}-${i}`
      usedKeys.add(key.toLowerCase())
      viewKeys.set(diagram.id, key)
      return key
    },
    get reMinted() {
      return reMinted
    },
  }
}

/** `properties['structurizr.id']`, or nothing when it is absent or blank. */
function carriedWireId(entity: WireIdBearer): string | undefined {
  const raw = entity.properties?.[SOURCE_ID_PROPERTY]
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

// ── 8. The emitters' shared context ──────────────────────────────────────────

/** What a MapleSpire object becomes on the wire, AFTER the nesting rules. */
export type WireElementKind = 'person' | 'softwareSystem' | 'container' | 'component'

/**
 * What a MapleSpire object becomes when it belongs to the DEPLOYMENT graph
 * instead of the static one.
 *
 * This is deliberately a second map rather than four more members of
 * `WireElementKind`: `kindByObjectId` answers "which C4 level is this", which
 * the styles emitter still needs for a deployed container, and widening it would
 * have made every `=== 'container'` test in the tree silently wrong. What the
 * views emitter needs is the other question — "is this element in the static
 * tree at all" — and that is `deploymentObjectIds`.
 */
export type WireDeploymentKind =
  | 'deploymentNode'
  | 'infrastructureNode'
  | 'containerInstance'
  | 'softwareSystemInstance'

/**
 * §5.2's default-tag table, plus §5.4's for relationships and §5.5's for
 * instances. `parse.ts` strips these on the way in, so re-adding them is the
 * export's job — without them Structurizr's own stylesheet, which keys on
 * `Element` / `Person` / `Container`, matches nothing and the customer's
 * workspace re-opens as undifferentiated boxes.
 *
 * The two instance rows carry no `Element`: `getDefaultTags()` on an instance is
 * empty and `Container Instance` is a *stored* tag its constructor added, which
 * is the only reason it is on the wire at all (§5.5).
 */
export const WIRE_DEFAULT_TAGS = {
  person: ['Element', 'Person'],
  softwareSystem: ['Element', 'Software System'],
  container: ['Element', 'Container'],
  component: ['Element', 'Component'],
  deploymentNode: ['Element', 'Deployment Node'],
  infrastructureNode: ['Element', 'Infrastructure Node'],
  containerInstance: ['Container Instance'],
  softwareSystemInstance: ['Software System Instance'],
} satisfies Record<WireElementKind | WireDeploymentKind, readonly string[]>

/** Every tag string in `WIRE_DEFAULT_TAGS`, plus `Relationship`: the names the
 *  FORMAT owns. A style keyed on one of these is a statement about a whole
 *  element kind, so a customer tag that merely happens to be spelled the same
 *  cannot be allowed to mint one. */
export const RESERVED_WIRE_TAGS: ReadonlySet<string> = new Set<string>([
  ...Object.values(WIRE_DEFAULT_TAGS).flat(),
  'Relationship',
  'Synchronous',
  'Asynchronous',
])

/**
 * What a MapleSpire group becomes. The three are mutually exclusive and only
 * one of them is a `model.*[].group` string:
 *
 * - `deploymentNode` — a group the JSON importer created for a deployment node
 *   (it carries `structurizr.id` and `type: 'Deployment node'`). Inverts back
 *   into `model.deploymentNodes[]`.
 * - `boundary` — the per-view box drawn around a drill-down scope. It is a
 *   RENDERING of an element already emitted as a shape (`parentObjectId` points
 *   at it, `structurizr.boundaryFor` names the wire id), so emitting it again
 *   as anything would duplicate the element.
 * - `model` — an ordinary group, which becomes the `group` string on each of
 *   its members.
 */
export type WireGroupRole = 'model' | 'deploymentNode' | 'boundary'

export interface StructurizrJsonExportOptions {
  /** Workspace id. Not identity (Structurizr Lite overwrites it); `1` is what
   *  DSL/local files carry. */
  workspaceId?: number
  /** Origin for stored icon paths (`/icons/light/<hash>.png`) — without it the
   *  emitted `icon` styles point at a path no other renderer can fetch. */
  iconOrigin?: string
  /** Which half of a dual-scheme palette our single set of colours describes.
   *  Nothing in the format states which scheme a style block means (§18.4), so
   *  the caller says. */
  colorScheme?: WireColorScheme
  /** Canvas px → Structurizr's 300-dpi space. Our 160-wide box is 450/160 ≈ 2.8× smaller
   *  than the box Structurizr draws for an unstyled element, so an unscaled
   *  export overlaps every shape it just placed. */
  layoutScale?: number
  /** `lastModifiedDate`. Injectable so a snapshot test is not time-dependent. */
  now?: string
}

/**
 * The gap between the box we draw and the box Structurizr draws for an element
 * that matched no style — the inverse of the scale `layoutPolicy` computes on
 * import. Derived from the two constants rather than typed as a magic number so
 * it moves if either side's sizes do.
 */
export const DEFAULT_LAYOUT_SCALE =
  STRUCTURIZR_DEFAULT_ELEMENT_SIZE.width / SIZE_BY_TYPE.app.width

export const DEFAULT_GROUP_SEPARATOR = '/'

/**
 * The entity id of the wrapper system that orphaned containers need — a
 * container is not legal at the top of the model, and dropping one loses a
 * shape the customer drew. It goes through `ExportIds` like everything else so
 * its wire id cannot collide, and both the model and the views emitter must use
 * THIS constant rather than minting a second wrapper each.
 */
export const SYNTHETIC_UNGROUPED_SYSTEM_ENTITY_ID = 'structurizr-export:ungrouped'

/** Its NAME and description, shared with the DSL exporter. Both formats hard-
 *  coded these separately, so two exports of one landscape could disagree about
 *  what the customer's leftover containers were wrapped in — and a customer who
 *  takes both files then holds two different systems. */
export const SYNTHETIC_UNGROUPED_SYSTEM_NAME = 'Ungrouped'
export const SYNTHETIC_UNGROUPED_SYSTEM_DESCRIPTION = 'Added on export: containers without a parent system.'

export interface ExportContext {
  readonly bundle: ExportBundle
  readonly ids: ExportIds
  readonly colorScheme: WireColorScheme
  readonly layoutScale: number
  readonly iconOrigin?: string
  readonly workspaceId: number
  readonly now: string

  readonly objectById: ReadonlyMap<string, C4Object>
  readonly connectionById: ReadonlyMap<string, Connection>
  readonly groupById: ReadonlyMap<string, Group>
  readonly diagramById: ReadonlyMap<string, Diagram>
  readonly tagById: ReadonlyMap<string, Tag>

  /** Objects with no emitted parent, in bundle order. */
  readonly rootObjectIds: readonly string[]
  /** Children of one object, in bundle order — already re-homed, so a child
   *  here is a child on the wire. */
  childObjectIds(objectId: string): readonly string[]
  /** The wire kind, after the nesting rules below. */
  readonly kindByObjectId: ReadonlyMap<string, WireElementKind>
  /** The object id this element is emitted UNDER, which is not always
   *  `parentId`: a component parented to another component flattens onto the
   *  nearest container, and a person never nests at all. */
  readonly wireParentByObjectId: ReadonlyMap<string, string>
  /** Containers/components with no software-system ancestor. They belong under
   *  `SYNTHETIC_UNGROUPED_SYSTEM_ENTITY_ID`. */
  readonly orphanObjectIds: readonly string[]

  /**
   * Objects the model emitter puts in `model.deploymentNodes[]` rather than in
   * the static tree.
   *
   * This lives here, and not as a local of `buildWireModel`, because the views
   * emitter has to make the SAME call: `kindByObjectId` still says `container`
   * for a deployed shape, so a views emitter that cannot see this claim scopes a
   * component view to a `DeploymentNode` (an unchecked `ClassCastException` in
   * `ViewSet.hydrate`, §4.3) or names a wrapper system the model never emitted
   * (rule 4 — the file does not open at all).
   */
  readonly deploymentObjectIds: ReadonlySet<string>
  /** What each of those becomes. Empty for everything in the static tree. */
  readonly deploymentKindByObjectId: ReadonlyMap<string, WireDeploymentKind>
  /** An instance's object id → the object it instantiates, resolved through
   *  `structurizr.instanceOf`. The only channel there is: an instance's parent
   *  is a deployment node, which is a Group here and not a shape at all. */
  readonly instantiatedByObjectId: ReadonlyMap<string, string>
  /** The type default tags an object will carry on the wire, in order — the one
   *  reading the model emitter writes and the styles emitter simulates. */
  wireDefaultTagsFor(objectId: string): readonly string[]

  readonly groupRoleById: ReadonlyMap<string, WireGroupRole>
  /** The `group` string for an object, already joined with `groupSeparator`. */
  readonly groupPathByObjectId: ReadonlyMap<string, string>
  readonly groupSeparator: string

  /** Author tag VALUES for an entity, in application order. Type defaults are
   *  not in here; they are the wire's, and the model emitter prepends them. */
  tagValues(entity: { tagAssignments?: Record<string, { tagId: string }>; tagOrder?: string[] }): string[]

  warn(message: string): void
  readonly warnings: readonly string[]
}

/**
 * Nest a flat set of groups by MEMBERSHIP: a group's parent is the tightest
 * other group whose members include all of its own.
 *
 * The strict-superset test everybody reaches for first finds no nesting at all,
 * because a group whose only child is another group holds exactly the same
 * members. The tie-break on equal membership is DECLARATION ORDER — for imported
 * groups that is the import's own walk order (`mapWorkspace` builds them while
 * iterating `ws.elements`, which `parse.ts` fills by pre-order DFS, so the
 * earlier group is the ancestor), and for groups drawn in MapleSpire it is the
 * order the customer created them in, which is the same answer.
 *
 * Shared by the deployment-node tree (`model.ts`) and by model groups here,
 * because those two were the same algorithm written twice and only one of them
 * had it.
 */
export function nestGroupsByMembership<T extends { id: string }>(
  groups: readonly T[],
  membersOf: (group: T) => ReadonlySet<string>,
  compatible: (child: T, parent: T) => boolean = () => true,
): Map<string, string> {
  const index = new Map(groups.map((group, at) => [group.id, at]))
  const parentOf = new Map<string, string>()
  for (const group of groups) {
    const mine = membersOf(group)
    if (mine.size === 0) continue
    let best: T | undefined
    for (const other of groups) {
      if (other.id === group.id) continue
      if (!compatible(group, other)) continue
      const theirs = membersOf(other)
      if (theirs.size < mine.size) continue
      if ([...mine].some((id) => !theirs.has(id))) continue
      if (theirs.size === mine.size && index.get(other.id)! > index.get(group.id)!) continue
      if (best === undefined) {
        best = other
        continue
      }
      const bestSize = membersOf(best).size
      if (theirs.size < bestSize) best = other
      else if (theirs.size === bestSize && index.get(other.id)! > index.get(best.id)!) best = other
    }
    if (best !== undefined) parentOf.set(group.id, best.id)
  }
  return parentOf
}

/** Depth in a parent map, seeded before recursing so a cycle resolves to a
 *  finite number instead of blowing the stack. */
export function depthsIn(ids: readonly string[], parentOf: ReadonlyMap<string, string>): Map<string, number> {
  const depths = new Map<string, number>()
  const depthOf = (id: string): number => {
    const known = depths.get(id)
    if (known !== undefined) return known
    depths.set(id, 0)
    const parent = parentOf.get(id)
    const depth = parent === undefined ? 0 : depthOf(parent) + 1
    depths.set(id, depth)
    return depth
  }
  for (const id of ids) depthOf(id)
  return depths
}

// ── MapleSpire facts the format has no field for ─────────────────────────────

/**
 * Everything first-class in MapleSpire that Structurizr's model has nowhere to
 * put. It goes out as `properties`, which is the one channel the format offers
 * for facts it does not model — round-tripped intact by every reader, visible in
 * Structurizr's own UI, and re-read by our importer as ordinary properties.
 *
 * The alternative was a warning saying the data was dropped, which is not a
 * mitigation: a customer whose estate is organised by domain, or whose shapes
 * carry an owning team, does not get that back from a sentence in a dialog.
 */
// The keys live with the importer that reads them back; see that module's header.
export {
  CONNECTION_DESCRIPTION_PROPERTY,
  CONNECTION_KIND_PROPERTY,
  DOMAIN_ID_PROPERTY,
  DOMAIN_PROPERTY,
  EXTRA_LINKS_PROPERTY,
  MAPLESPIRE_DERIVED_PROPERTY_KEYS,
  OWNERS_PROPERTY,
  OWNER_TEAMS_PROPERTY,
  SHORT_DESCRIPTION_PROPERTY,
  SKIN_PROPERTY,
  STATUS_PROPERTY,
  TEAMS_PROPERTY,
} from '../../structurizr/maplespireFacts'

/** The scope tag `detectScope` reads back on the way in. There is no other
 *  channel: `location` is in §2's legacy register and has no declaration here. */
export function scopeTagsFor(
  object: Pick<C4Object, 'scope'>,
  kind: WireElementKind,
  author: readonly string[],
): string[] {
  if (kind === 'softwareSystem' && object.scope === 'external' && !author.some((t) => EXTERNAL_TAG_RE.test(t))) {
    return ['External']
  }
  if (kind === 'person' && object.scope === 'internal' && !author.some((t) => INTERNAL_TAG_RE.test(t))) {
    return ['Internal']
  }
  return []
}

/** Which wire kind a C4 type wants, ignoring where it sits. */
function preferredKind(type: C4Type): WireElementKind {
  switch (type) {
    case 'actor':
      return 'person'
    case 'system':
      return 'softwareSystem'
    case 'component':
      return 'component'
    default:
      return 'container'
  }
}

/**
 * Build the index every emitter reads, once.
 *
 * The hierarchy pass is the reason this is shared rather than three private
 * copies: the model emitter nests by it, the views emitter picks a view type
 * and a scope id by it, and the styles emitter sizes shapes by it. Three
 * independent readings of "what is this element on the wire" is three chances
 * for a container view to be scoped to something the model emitted as a
 * component.
 *
 * The nesting rules, and why each is what it is:
 *  - an actor is always a top-level `person`; the wire has no nesting for people;
 *  - a child of a software system is a `container`, a child of a container is a
 *    `component` — the only nesting the format has;
 *  - a nested software system therefore demotes to a container rather than
 *    being re-homed to the top: keeping the customer's hierarchy is worth more
 *    than keeping its C4 level, and re-homing silently breaks the drill-down
 *    view that pointed at it;
 *  - components do not nest, so a component under a component is flattened onto
 *    the nearest container;
 *  - a container/component with no system above it is an ORPHAN and needs the
 *    synthetic wrapper — the top level of the model holds only people, systems
 *    and deployment nodes.
 */
export function buildExportContext(
  bundle: ExportBundle,
  options: StructurizrJsonExportOptions = {},
): ExportContext {
  const warnings: string[] = []
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message)
  }

  const objectById = new Map(bundle.objects.map((o) => [o.id, o]))
  const connectionById = new Map(bundle.connections.map((c) => [c.id, c]))
  const groupById = new Map(bundle.groups.map((g) => [g.id, g]))
  const diagramById = new Map(bundle.diagrams.map((d) => [d.id, d]))
  const tagById = new Map(bundle.tags.map((t) => [t.tagId, t]))

  const ids = createExportIds([...bundle.objects, ...bundle.connections, ...bundle.groups])

  // ── hierarchy ──────────────────────────────────────────────────────────────
  const childrenOf = new Map<string | undefined, C4Object[]>()
  for (const object of bundle.objects) {
    const parentKey = object.parentId && objectById.has(object.parentId) ? object.parentId : undefined
    const siblings = childrenOf.get(parentKey) ?? []
    siblings.push(object)
    childrenOf.set(parentKey, siblings)
  }

  const kindByObjectId = new Map<string, WireElementKind>()
  const wireParentByObjectId = new Map<string, string>()
  const wireChildren = new Map<string, string[]>()
  const rootObjectIds: string[] = []
  const orphanObjectIds: string[] = []

  const attach = (objectId: string, parentObjectId: string | undefined) => {
    if (parentObjectId === undefined) {
      rootObjectIds.push(objectId)
      return
    }
    wireParentByObjectId.set(objectId, parentObjectId)
    const siblings = wireChildren.get(parentObjectId) ?? []
    siblings.push(objectId)
    wireChildren.set(parentObjectId, siblings)
  }

  const walk = (object: C4Object, parentId: string | undefined): void => {
    const parentKind = parentId ? kindByObjectId.get(parentId) : undefined
    const wants = preferredKind(object.type)
    let kind: WireElementKind
    let emittedParent: string | undefined

    if (wants === 'person') {
      if (parentId) warn(`"${object.name}" is a person inside another shape; people cannot nest on the wire, so it was emitted at the top level.`)
      kind = 'person'
      emittedParent = undefined
    } else if (parentKind === 'softwareSystem') {
      if (wants === 'softwareSystem') warn(`"${object.name}" is a software system inside another one; it was emitted as a container so its place in the hierarchy survives.`)
      kind = 'container'
      emittedParent = parentId
    } else if (parentKind === 'container') {
      kind = 'component'
      emittedParent = parentId
    } else if (parentKind === 'component') {
      // Components do not nest. The nearest container is the deepest legal home.
      warn(`"${object.name}" sits inside a component, which cannot contain anything on the wire; it was emitted alongside its parent instead.`)
      kind = 'component'
      emittedParent = wireParentByObjectId.get(parentId!)
    } else {
      // No emitted parent (a root, or the child of a person).
      kind = wants === 'softwareSystem' ? 'softwareSystem' : 'container'
      emittedParent = undefined
      if (kind === 'container') orphanObjectIds.push(object.id)
    }

    kindByObjectId.set(object.id, kind)
    attach(object.id, emittedParent)
    for (const child of childrenOf.get(object.id) ?? []) walk(child, object.id)
  }
  for (const root of childrenOf.get(undefined) ?? []) walk(root, undefined)

  // ── groups ─────────────────────────────────────────────────────────────────
  const groupRoleById = new Map<string, WireGroupRole>()
  for (const group of bundle.groups) {
    const role: WireGroupRole =
      group.properties?.['structurizr.boundaryFor'] !== undefined || group.parentObjectId !== undefined
        ? 'boundary'
        : group.type === 'Deployment node' || group.properties?.['structurizr.environment'] !== undefined
          ? 'deploymentNode'
          : 'model'
    groupRoleById.set(group.id, role)
  }

  // The separator the workspace this landscape came from actually declared. It
  // is recorded on the groups the import split, so a `|`-separated workspace
  // leaves as a `|`-separated workspace instead of as one flat group named
  // `Payments|Core` — which is what a hardcoded `/` produced (T5, §13.6).
  const separator =
    bundle.groups
      .map((group) => group.properties?.[GROUP_SEPARATOR_PROPERTY]?.trim())
      .find((value): value is string => Boolean(value)) ?? DEFAULT_GROUP_SEPARATOR

  const modelGroups = bundle.groups.filter((group) => groupRoleById.get(group.id) === 'model')
  const memberSets = new Map(modelGroups.map((group) => [group.id, new Set(group.objectIds)]))
  // A group drawn in MapleSpire carries no path — only its own name — so a shape
  // inside three nested groups must not leave with ONE `group` string picked by
  // whichever name happens to be longest. The nesting is in the membership, and
  // the deployment tree next door already reads it out of exactly that.
  const groupParentOf = nestGroupsByMembership(modelGroups, (group) => memberSets.get(group.id)!)
  const groupDepths = depthsIn(
    modelGroups.map((group) => group.id),
    groupParentOf,
  )
  const groupPathById = new Map<string, string>()
  const pathOf = (group: Group): string => {
    const known = groupPathById.get(group.id)
    if (known !== undefined) return known
    // The importer recorded the FULL nested path here and it is authoritative:
    // it is the string the customer's own file carried.
    const carried = group.properties?.[GROUP_PATH_PROPERTY]?.trim()
    const own = group.name.trim()
    groupPathById.set(group.id, carried || own)
    if (carried) return carried
    const parentId = groupParentOf.get(group.id)
    const parent = parentId === undefined ? undefined : groupById.get(parentId)
    const path = parent === undefined || !own ? own : `${pathOf(parent)}${separator}${own}`
    groupPathById.set(group.id, path)
    return path
  }

  const groupPathByObjectId = new Map<string, string>()
  const groupDepthByObjectId = new Map<string, number>()
  for (const group of modelGroups) {
    const path = pathOf(group)
    if (!path) continue
    const depth = groupDepths.get(group.id) ?? 0
    for (const objectId of group.objectIds) {
      const current = groupPathByObjectId.get(objectId)
      // An element carries exactly one `group` on the wire. When it is in two,
      // the deepest is the most specific statement about it, and the shallower
      // one is usually its own ancestor.
      const currentDepth = groupDepthByObjectId.get(objectId)
      if (current === undefined || depth > currentDepth! || (depth === currentDepth! && path.length > current.length)) {
        groupPathByObjectId.set(objectId, path)
        groupDepthByObjectId.set(objectId, depth)
      }
      if (current !== undefined && !path.startsWith(current) && !current.startsWith(path)) {
        warn(`"${objectById.get(objectId)?.name ?? objectId}" belongs to more than one group ("${current}", "${path}"); Structurizr allows one, so the deepest was kept.`)
      }
    }
  }

  // ── the deployment graph ───────────────────────────────────────────────────
  // Membership of a deployment-node group is the structural signal; the two
  // provenance stamps catch an element whose node was deleted in MapleSpire. An
  // object with an emitted static parent is excluded whatever it carries —
  // pulling a container out of its system to satisfy a stray property would
  // silently empty the system it belongs to.
  const deploymentObjectIds = new Set<string>()
  const ownedByNodeGroup = new Set<string>()
  const claimDeployment = (objectId: string) => {
    if (!objectById.has(objectId)) return
    if (wireParentByObjectId.has(objectId)) return
    deploymentObjectIds.add(objectId)
  }
  for (const group of bundle.groups) {
    if (groupRoleById.get(group.id) !== 'deploymentNode') continue
    for (const objectId of group.objectIds) {
      claimDeployment(objectId)
      if (deploymentObjectIds.has(objectId)) ownedByNodeGroup.add(objectId)
    }
  }
  for (const object of bundle.objects) {
    // Guarded although the type says required, because the failure mode is the
    // whole export throwing rather than one field going missing.
    const properties = object.properties ?? {}
    if (properties[SOURCE_INSTANCE_OF_PROPERTY] || properties[ENVIRONMENT_PROPERTY]) claimDeployment(object.id)
  }

  const objectByCarriedId = new Map<string, C4Object>()
  for (const object of bundle.objects) {
    const carried = object.properties?.[SOURCE_ID_PROPERTY]?.trim()
    if (carried && !objectByCarriedId.has(carried)) objectByCarriedId.set(carried, object)
  }

  const deploymentKindByObjectId = new Map<string, WireDeploymentKind>()
  const instantiatedByObjectId = new Map<string, string>()
  for (const objectId of deploymentObjectIds) {
    const object = objectById.get(objectId)!
    const instanceOf = object.properties?.[SOURCE_INSTANCE_OF_PROPERTY]?.trim()
    if (instanceOf) {
      const target = objectByCarriedId.get(instanceOf)
      if (target !== undefined) instantiatedByObjectId.set(objectId, target.id)
      // A dangling `instanceOf` becomes an infrastructure node so the deployment
      // view keeps its box — the same compromise `emitInstance` makes.
      deploymentKindByObjectId.set(
        objectId,
        target === undefined
          ? 'infrastructureNode'
          : kindByObjectId.get(target.id) === 'softwareSystem'
            ? 'softwareSystemInstance'
            : 'containerInstance',
      )
      continue
    }
    // §5.5 gives `instances` to deployment nodes and withholds it from
    // infrastructure nodes, so it is the only surviving trace of which kind a
    // childless node was. An element no node group owns has to go out as a node
    // whatever it carries: a node is the only thing legal at the top of
    // `model.deploymentNodes`.
    const hasInstances = Boolean(object.properties?.[INSTANCES_PROPERTY]?.trim())
    deploymentKindByObjectId.set(
      objectId,
      hasInstances || !ownedByNodeGroup.has(objectId) ? 'deploymentNode' : 'infrastructureNode',
    )
  }

  const wireDefaultTagsFor = (objectId: string): readonly string[] => {
    const deploymentKind = deploymentKindByObjectId.get(objectId)
    if (deploymentKind !== undefined) return WIRE_DEFAULT_TAGS[deploymentKind]
    return WIRE_DEFAULT_TAGS[kindByObjectId.get(objectId) ?? 'container']
  }

  return {
    bundle,
    ids,
    colorScheme: options.colorScheme ?? 'Light',
    layoutScale: options.layoutScale ?? DEFAULT_LAYOUT_SCALE,
    ...(options.iconOrigin ? { iconOrigin: options.iconOrigin } : {}),
    workspaceId: options.workspaceId ?? 1,
    now: options.now ?? bundle.generatedAt,
    objectById,
    connectionById,
    groupById,
    diagramById,
    tagById,
    rootObjectIds,
    childObjectIds: (objectId: string) => wireChildren.get(objectId) ?? [],
    kindByObjectId,
    wireParentByObjectId,
    orphanObjectIds,
    deploymentObjectIds,
    deploymentKindByObjectId,
    instantiatedByObjectId,
    wireDefaultTagsFor,
    groupRoleById,
    groupPathByObjectId,
    groupSeparator: separator,
    tagValues: (entity) => orderedTagIds(entity).map((tagId) => tagById.get(tagId)?.value ?? tagId),
    warn,
    warnings,
  }
}

/** Re-exported so the emitters size and place against ONE pair of numbers. */
export type { Position, Size }
export { STRUCTURIZR_DEFAULT_ELEMENT_SIZE }
