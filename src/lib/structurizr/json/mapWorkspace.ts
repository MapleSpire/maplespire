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
 * Map a parsed Structurizr workspace JSON (`SzWorkspace`) onto MapleSpire's
 * model + diagrams + flows.
 *
 * The one rule that separates this from `../mapper.ts` (the DSL importer):
 * **view membership is read, never derived.** The DSL says `include *` and
 * leaves a renderer to work out what belongs on a view, so the DSL mapper has to
 * synthesise membership from the graph. The JSON states it — element by element,
 * with coordinates — so `buildContext` / `neighborsOf` and friends are
 * deliberately NOT reused here. Re-deriving membership would replace the
 * customer's answer with our guess, and the customer's diagram is the whole
 * product of the migration.
 *
 * The rule bites on what the file SAYS, not on what it omits: a workspace that
 * declares no views at all is a gap to fill, not an answer to overrule, so
 * `synthesiseViews` runs in exactly that case (and says so).
 *
 * Every judgement the two importers share — `SIZE_BY_TYPE`, `DATASTORE_RE`,
 * `isDatastore`, `technologyNames`, `detectScope` — comes from
 * `../conventions.ts` so the same workspace lands identically whichever of its
 * two serialisations the customer exported. Nothing in here may re-implement one.
 */

import type { C4Object, C4Type, Connection, Diagram, Flow, FlowStep, Group, Position, Size, Tag } from '../../../types'
import { objectLink } from '../../objectLinks'
import { seededTechnologyUsages } from '../../technologyUsage'
import { generateId } from '../../utils'
import {
  GROUP_FOOTER_PAD,
  GROUP_SIDE_PAD,
  GROUP_STD_PAD_TOP,
  groupHeaderBandHeight,
  groupTitleMinWidth,
} from '../../layout/metrics'
import type { ImportStats } from '../../import/types'
import { SIZE_BY_TYPE, compareOrder, detectScope, isDatastore, parseTechnologies, technologyNames } from '../conventions'
import { ownerFields, reviveMapleSpireFacts, withTechnologyDetails } from '../maplespireFacts'
import { SOURCE_IDENTIFIER_PROPERTY, importedTag, type LayoutDirection } from '../mapper'
import {
  BOUNDARY_FOR_PROPERTY,
  DEPLOYMENT_GROUPS_PROPERTY,
  DSL_IDENTIFIER_PROPERTY,
  ENVIRONMENT_PROPERTY,
  GROUP_PATH_PROPERTY,
  GROUP_SEPARATOR_PROPERTY,
  INSTANCES_PROPERTY,
  INTERACTION_STYLE_PROPERTY,
  LINKED_RELATIONSHIP_PROPERTY,
  NODE_TECHNOLOGY_PROPERTY,
  PERSPECTIVE_PREFIX,
  SOURCE_ID_PROPERTY,
  SOURCE_INSTANCE_OF_PROPERTY,
  STYLE_PREFIX,
  URL_PROPERTY,
} from './provenance'
import { planViewLayout, projectWirePoint, structurizrSizeFor, type PreservedLayout } from './layoutPolicy'
import {
  collectStyleWarnings,
  resolveElementStyle,
  resolveGroupStyle,
  resolveStyleForElement,
  resolveStyleForRelationship,
  type ResolvedElementStyle,
  type SzColorScheme,
} from './styles'
import type { SzElement, SzElementKind, SzView, SzWorkspace } from './types'

// ── Public shape ─────────────────────────────────────────────────────────────

export interface JsonMapOptions {
  /** Injectable id factory (tests pass a deterministic counter). */
  idFactory?: () => string
  /** Which half of a dual-scheme stylesheet to resolve. Defaults to Light. */
  colorScheme?: SzColorScheme
}

export interface MappedJsonWorkspace {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  tags: Tag[]
  /** Diagrams. Those whose view carried a usable layout ALREADY have `layouts`. */
  diagrams: Diagram[]
  /** Dynamic views, as ordered message flows hung off their own diagram. */
  flows: Flow[]
  /** Per-diagram `autoLayout` direction hint, for the diagrams that need laying out. */
  layoutHints: Record<string, { direction?: LayoutDirection }>
  /** Ids of the diagrams whose coordinates came from the file. Do NOT re-lay-out these. */
  preservedDiagramIds: string[]
  /** Connections drawn on at least one preserved diagram. `waypoints`,
   *  `shape` and `labelPosition` live on the CONNECTION, not on the diagram, so
   *  the layout engine must not touch these: a bend it computes in one
   *  diagram's coordinate space is meaningless in another's, and an edge shared
   *  between a hand-arranged view and an ELK'd one would be drawn on the
   *  hand-arranged one with the other's geometry. Every connection on a
   *  preserved diagram is listed, not only the ones the file routed — an edge
   *  the customer left unrouted still has to be drawn between the boxes THEY
   *  placed. */
  preservedConnectionIds: string[]
  /** How deeply each group nests, for `sizeGroupBoxes` after auto-layout. */
  groupDepths: Record<string, number>
  entryDiagramId: string | null
  /** The workspace's own name, for a caller offering "import into a new landscape". */
  landscapeName?: string
  warnings: string[]
  stats: ImportStats
}

// Every provenance key this file stamps lives in `./provenance.ts` — one
// declaration shared with the exporter that reads them back. They are re-exported
// here because callers have always imported them from this module.
export {
  SOURCE_ID_PROPERTY,
  SOURCE_INSTANCE_OF_PROPERTY,
  STYLE_PREFIX,
  GROUP_PATH_PROPERTY,
  GROUP_SEPARATOR_PROPERTY,
  ENVIRONMENT_PROPERTY,
  INSTANCES_PROPERTY,
  NODE_TECHNOLOGY_PROPERTY,
  URL_PROPERTY,
  BOUNDARY_FOR_PROPERTY,
  INTERACTION_STYLE_PROPERTY,
  LINKED_RELATIONSHIP_PROPERTY,
  DEPLOYMENT_GROUPS_PROPERTY,
  DSL_IDENTIFIER_PROPERTY,
  PERSPECTIVE_PREFIX,
  PERSPECTIVE_DESCRIPTION_SUFFIX,
  PROPERTY_ORIGINAL_SUFFIX,
} from './provenance'

const GROUP_COLORS = ['#DBEAFE', '#F3E8FF', '#DCFCE7', '#FEF3C7', '#FEE2E2', '#E0E7FF', '#CCFBF1', '#FCE7F3']
const BOUNDARY_COLOR = '#F1F5F9'

/**
 * `customElement` has no C4 level at all — it is a free-form box someone drew on
 * a custom view — so it lands on `system`, the type whose shape carries no
 * level-specific promise. `infrastructureNode` (a load balancer, a DNS zone) is
 * a running thing, so it follows the container rules.
 */
function objectTypeFor(
  kind: SzElementKind,
  technology: string | undefined,
  tags: readonly string[],
  resolvedShape: string,
): C4Type {
  switch (kind) {
    case 'person':
      return 'actor'
    case 'softwareSystem':
    case 'softwareSystemInstance':
    case 'customElement':
      return 'system'
    case 'component':
      return 'component'
    default:
      // A `Cylinder` shape is the customer SAYING "this is a data store", which
      // beats guessing from the technology string: `deployment-positioned.json`
      // styles its database instance that way and names the technology "RDS".
      if (resolvedShape === 'Cylinder') return 'store'
      return isDatastore(technology, tags) ? 'store' : 'app'
  }
}

/** Which arm of the shared enterprise-boundary rule this element is judged by. */
function scopeLevelFor(kind: SzElementKind): 'person' | 'softwareSystem' | 'containerLevel' {
  if (kind === 'person') return 'person'
  if (kind === 'softwareSystem' || kind === 'softwareSystemInstance' || kind === 'customElement') {
    return 'softwareSystem'
  }
  return 'containerLevel'
}

/** `location` is the JSON's own scope statement; §`detectScope` in
 *  `../conventions.ts` decides how it ranks against the tags. */
function declaredScope(location: string | undefined): 'internal' | 'external' | undefined {
  if (location === 'External') return 'external'
  if (location === 'Internal') return 'internal'
  return undefined
}

function dedupe(values: Iterable<string>): string[] {
  const out: string[] = []
  for (const v of values) if (v && !out.includes(v)) out.push(v)
  return out
}

const DIRECTION_BY_RANK: Record<string, LayoutDirection> = {
  TopBottom: 'tb',
  BottomTop: 'bt',
  LeftRight: 'lr',
  RightLeft: 'rl',
}

/** §6.4's edge routing, onto the two line shapes the canvas draws. `Orthogonal`
 *  is straight SEGMENTS through the stored bends, so it is not `curved`. */
const SHAPE_BY_ROUTING: Record<string, Connection['shape']> = {
  Direct: 'straight',
  Orthogonal: 'straight',
  Curved: 'curved',
}

/** systemLandscape/systemContext → context, container → container, component →
 *  component (a fixed decision). Dynamic and deployment views have no C4 level
 *  of their own, so theirs is read off the elements they actually contain. */
function diagramTypeFor(view: SzView, memberKinds: readonly SzElementKind[]): Diagram['type'] {
  switch (view.kind) {
    case 'systemLandscape':
    case 'systemContext':
      return 'context'
    case 'container':
      return 'container'
    case 'component':
      return 'component'
    case 'deployment':
      // Instances of containers, drawn inside deployment-node boundaries: the
      // container level is the one whose shapes these are.
      return 'container'
    default:
      if (memberKinds.includes('component')) return 'component'
      if (memberKinds.some((k) => k === 'container' || k === 'containerInstance')) return 'container'
      return 'context'
  }
}

// ── Group geometry ───────────────────────────────────────────────────────────

interface Box {
  x: number
  y: number
  width: number
  height: number
}

type LayoutRecord = Record<string, { position: Position; size: Size }>

function boxOf(layout: { position: Position; size: Size }): Box {
  return { x: layout.position.x, y: layout.position.y, width: layout.size.width, height: layout.size.height }
}

function union(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null
  const minX = Math.min(...boxes.map((b) => b.x))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.width))
  const maxY = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** The reservations `src/lib/layout` makes for a group's drawn identity stack.
 *  The constants come from `layout/metrics.ts` — this module has to size a box
 *  the LAYOUT never saw (a preserved view never enters the layout engine), and a
 *  group box that disagrees with the canvas clips its own title. */
function padding(group: Group): { top: number; bottom: number } {
  return group.parentObjectId
    ? { top: groupHeaderBandHeight(group), bottom: GROUP_FOOTER_PAD }
    : { top: GROUP_STD_PAD_TOP, bottom: GROUP_SIDE_PAD }
}

/**
 * Size every group on a diagram so it wraps its members AND every group nested
 * inside it.
 *
 * Nesting is decided by DEPTH first and membership second: a group's children
 * are the deeper groups whose members it also holds. Membership alone is not
 * enough — a deployment node whose only child is another node holds exactly the
 * same instances, so a strict-superset test finds no nesting and both boxes come
 * out identical, which draws one border with two titles stacked on it. Measured
 * on `deployment-positioned.json`, where "Amazon Web Services" contains only
 * "US-East-1", and again on "Amazon RDS" → "MySQL".
 *
 * Deepest first, so a parent always sees its children's final boxes.
 *
 * `mode: 'expand'` only ever GROWS an existing box. The layout engine already
 * produced boxes it scored its winning candidate on, and rewriting them would
 * hand the canvas a layout nothing was measured against; but it sizes each group
 * from its own members alone, so the nesting still has to be put back.
 */
export function sizeGroupBoxes(
  groups: readonly Group[],
  layouts: LayoutRecord,
  mode: 'fresh' | 'expand',
  depths: Readonly<Record<string, number>> = {},
): LayoutRecord {
  const out: LayoutRecord = { ...layouts }
  const depthOf = (id: string) => depths[id] ?? 0
  const ordered = [...groups].sort((a, b) => depthOf(b.id) - depthOf(a.id))
  const memberSets = new Map(ordered.map((g) => [g.id, new Set(g.objectIds)]))

  for (const group of ordered) {
    const mine = memberSets.get(group.id)!
    const boxes: Box[] = []
    for (const oid of group.objectIds) {
      const layout = out[oid]
      if (layout) boxes.push(boxOf(layout))
    }
    for (const other of ordered) {
      if (other.id === group.id) continue
      if (depthOf(other.id) <= depthOf(group.id)) continue
      const theirs = memberSets.get(other.id)!
      if (![...theirs].every((id) => mine.has(id))) continue
      const box = out[other.id]
      if (box) boxes.push(boxOf(box))
    }
    const content = union(boxes)
    if (!content) continue

    const pad = padding(group)
    const wanted: Box = {
      x: content.x - GROUP_SIDE_PAD,
      y: content.y - pad.top,
      width: content.width + GROUP_SIDE_PAD * 2,
      height: content.height + pad.top + pad.bottom,
    }
    const existing = mode === 'expand' ? out[group.id] : undefined
    const merged = existing ? union([boxOf(existing), wanted])! : wanted
    if (!existing) {
      const floor = groupTitleMinWidth(group.name, group.parentObjectId ? 13 : 11)
      if (merged.width < floor) {
        merged.x -= (floor - merged.width) / 2
        merged.width = floor
      }
    }
    out[group.id] = {
      position: { x: Math.round(merged.x), y: Math.round(merged.y) },
      size: { width: Math.round(merged.width), height: Math.round(merged.height) },
    }
  }
  return out
}

/** Grid-pack the shapes a preserved view never placed, below everything it did.
 *  They must not land on the origin: that is where the arrangement starts, so a
 *  stray would sit on top of a shape the customer positioned by hand. */
function packUnplaced(
  ids: readonly string[],
  sizeOf: (id: string) => Size,
  placed: LayoutRecord,
): LayoutRecord {
  if (ids.length === 0) return placed
  const out = { ...placed }
  const content = union(Object.values(placed).map(boxOf))
  const startY = content ? content.y + content.height + 80 : 0
  const startX = content ? content.x : 0
  const columns = Math.max(1, Math.ceil(Math.sqrt(ids.length)))
  const cell = {
    width: Math.max(...ids.map((id) => sizeOf(id).width)) + 60,
    height: Math.max(...ids.map((id) => sizeOf(id).height)) + 60,
  }
  ids.forEach((id, index) => {
    out[id] = {
      position: {
        x: Math.round(startX + (index % columns) * cell.width),
        y: Math.round(startY + Math.floor(index / columns) * cell.height),
      },
      size: sizeOf(id),
    }
  })
  return out
}

// ── Views the file never wrote ───────────────────────────────────────────────

/**
 * A default view set for a workspace that declares NO views.
 *
 * Routine in practice — a `workspace.json` is often the model half of a pair
 * whose views live in a `.dsl` — and without this the whole model imports as
 * zero diagrams, which the modal (rightly) refuses to import at all. The DSL
 * importer has done this since it shipped (`../mapper.ts`); the JSON one has to
 * agree or the same customer's two files behave differently.
 *
 * Only reached when `ws.views` is empty, so it never overrules a stated answer.
 * Elements carry no coordinates here, so every synthesised view auto-lays-out.
 */
function synthesiseViews(ws: SzWorkspace): SzView[] {
  const out: SzView[] = []
  const childrenOf = new Map<string, SzElement[]>()
  for (const el of ws.elements) {
    if (!el.parentId) continue
    const bucket = childrenOf.get(el.parentId)
    if (bucket) bucket.push(el)
    else childrenOf.set(el.parentId, [el])
  }

  const view = (kind: SzView['kind'], key: string, title: string, ids: string[], scopeId?: string): SzView | null => {
    if (ids.length === 0) return null
    const set = new Set(ids)
    return {
      kind,
      key,
      title,
      ...(scopeId ? { scopeId } : {}),
      filterTags: [],
      elements: ids.map((id) => ({ id })),
      relationships: ws.relationships
        .filter((r) => set.has(r.sourceId) && set.has(r.destinationId))
        .map((r) => ({ id: r.id, vertices: [] })),
    }
  }

  /** The elements a drill-down view needs: the children, plus whatever talks to
   *  them from outside. Filling a gap the file left, not overruling it. */
  const withNeighbours = (childIds: string[]): string[] => {
    const inside = new Set(childIds)
    const out2 = [...childIds]
    for (const rel of ws.relationships) {
      const pairs: Array<[string, string]> = [
        [rel.sourceId, rel.destinationId],
        [rel.destinationId, rel.sourceId],
      ]
      for (const [a, b] of pairs) {
        if (!inside.has(a) || inside.has(b)) continue
        const other = ws.elements.find((e) => e.id === b)
        if (!other || other.kind === 'deploymentNode') continue
        if (!out2.includes(b)) out2.push(b)
      }
    }
    return out2
  }

  const landscapeIds = ws.elements
    .filter((e) => !e.parentId && (e.kind === 'person' || e.kind === 'softwareSystem' || e.kind === 'customElement'))
    .map((e) => e.id)
  const landscape = view('systemLandscape', 'SystemLandscape', 'System Landscape', landscapeIds)
  if (landscape) out.push(landscape)

  for (const system of ws.elements.filter((e) => e.kind === 'softwareSystem')) {
    const containers = (childrenOf.get(system.id) ?? []).filter((c) => c.kind === 'container')
    const v = view(
      'container',
      `Containers-${system.id}`,
      `${system.name} — Containers`,
      withNeighbours(containers.map((c) => c.id)),
      system.id,
    )
    if (v) out.push(v)
  }

  for (const container of ws.elements.filter((e) => e.kind === 'container')) {
    const components = (childrenOf.get(container.id) ?? []).filter((c) => c.kind === 'component')
    const v = view(
      'component',
      `Components-${container.id}`,
      `${container.name} — Components`,
      withNeighbours(components.map((c) => c.id)),
      container.id,
    )
    if (v) out.push(v)
  }

  if (out.length === 0) {
    const all = ws.elements.filter((e) => e.kind !== 'deploymentNode').map((e) => e.id)
    const only = view('systemLandscape', 'SystemLandscape', ws.name || 'Imported diagram', all)
    if (only) out.push(only)
  }
  return out
}

// ── The mapping ──────────────────────────────────────────────────────────────

interface MappedElement {
  element: SzElement
  /** The element whose name/technology/description this one displays — itself,
   *  or the container/system it is an instance of. */
  display: SzElement
  objectId?: string
  groupId?: string
}

export function mapWorkspace(ws: SzWorkspace, opts: JsonMapOptions = {}): MappedJsonWorkspace {
  const newId = opts.idFactory ?? generateId
  const colorScheme = opts.colorScheme ?? 'Light'
  const warnings = [...ws.warnings, ...collectStyleWarnings(ws, { colorScheme })]

  const elementById = new Map<string, SzElement>()
  for (const el of ws.elements) if (!elementById.has(el.id)) elementById.set(el.id, el)
  const kindById = new Map<string, SzElementKind>(ws.elements.map((e) => [e.id, e.kind]))
  const relationshipById = new Map(ws.relationships.map((r) => [r.id, r]))

  /**
   * Stamp our own record of the source onto an entity's properties WITHOUT
   * deleting a customer key that happens to collide. The keys we reserve are
   * namespaced, so a collision means the customer really does have a property
   * called `structurizr.id`; theirs is kept under `<key>.original` and named in
   * a warning rather than silently overwritten by the spread order.
   */
  const withProvenance = (
    own: Record<string, string>,
    stamps: Record<string, string | undefined>,
    where: string,
  ): Record<string, string> => {
    const out: Record<string, string> = { ...own }
    for (const [key, value] of Object.entries(stamps)) {
      if (value === undefined || value === '') continue
      const existing = own[key]
      if (existing !== undefined && existing !== value) {
        out[`${key}.original`] = existing
        warnings.push(
          `${where} carries a property named "${key}", which the import needs for its own record of the source; ` +
            `the original value was kept as "${key}.original".`,
        )
      }
      out[key] = value
    }
    return out
  }

  /** §5.3 perspectives, as properties. Two keys per perspective so the value and
   *  its explanation stay separable for an exporter. */
  const perspectiveProperties = (element: SzElement): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const p of element.perspectives) {
      if (p.value) out[`${PERSPECTIVE_PREFIX}${p.name}`] = p.value
      if (p.description) out[`${PERSPECTIVE_PREFIX}${p.name}.description`] = p.description
      if (!p.value && !p.description) out[`${PERSPECTIVE_PREFIX}${p.name}`] = ''
    }
    return out
  }

  /** Only what the STYLESHEET set. The seeded defaults are ours to theme; the
   *  explicit values are the customer's palette and must survive. */
  const styleProperties = (style: ResolvedElementStyle): Record<string, string> => {
    const out: Record<string, string> = {}
    const { background, color, stroke, icon, shape } = style.explicit
    if (background) out[`${STYLE_PREFIX}background`] = background
    if (color) out[`${STYLE_PREFIX}color`] = color
    if (stroke) out[`${STYLE_PREFIX}stroke`] = stroke
    if (icon) out[`${STYLE_PREFIX}icon`] = icon
    if (shape) out[`${STYLE_PREFIX}shape`] = shape
    return out
  }

  // ── tags ───────────────────────────────────────────────────────────────────
  const tagByValue = new Map<string, Tag>()
  const assignTags = (raw: readonly string[]) => {
    const tagOrder: string[] = []
    for (const value of raw) {
      const trimmed = value.trim()
      if (!trimmed) continue
      let tag = tagByValue.get(trimmed)
      if (!tag) {
        tag = importedTag(trimmed)
        tagByValue.set(trimmed, tag)
      }
      if (!tagOrder.includes(tag.tagId)) tagOrder.push(tag.tagId)
    }
    return {
      tagOrder,
      tagAssignments: Object.fromEntries(tagOrder.map((tagId) => [tagId, { tagId }])),
    }
  }

  // ── which deployment nodes are boundaries ──────────────────────────────────
  // A node is a boundary because it is drawn AROUND something. One with nothing
  // under it is drawn by Structurizr as a plain box, so importing it as a
  // boundary loses it entirely — a Group with no members has no geometry, so it
  // vanished from the model AND from a view that had placed it by hand.
  const childrenOf = new Map<string, SzElement[]>()
  for (const el of ws.elements) {
    if (!el.parentId) continue
    const bucket = childrenOf.get(el.parentId)
    if (bucket) bucket.push(el)
    else childrenOf.set(el.parentId, [el])
  }
  const isBoundaryNode = (el: SzElement): boolean =>
    el.kind === 'deploymentNode' && (childrenOf.get(el.id)?.length ?? 0) > 0
  /** Deployment nodes that became shapes — `layoutPolicy` must place them. */
  const drawnAsShape = new Set(
    ws.elements.filter((e) => e.kind === 'deploymentNode' && !isBoundaryNode(e)).map((e) => e.id),
  )

  // ── objects ────────────────────────────────────────────────────────────────
  const mapped = new Map<string, MappedElement>()
  const resolvedStyleById = new Map<string, ResolvedElementStyle>()
  const objects: C4Object[] = []
  /** The box structurizr-ui drew for this element — the SOURCE side of the
   *  layout scale. Not our box: ours is `SIZE_BY_TYPE`. */
  const sourceSize = new Map<string, Size>()

  for (const el of ws.elements) {
    const display = el.instanceOfId ? (elementById.get(el.instanceOfId) ?? el) : el
    // A duplicate id keeps the FIRST element, because that is the one every view
    // row referencing the id will resolve to. Overwriting made the second win
    // the views while both stayed in the model, so the first became an object
    // nothing could ever draw.
    const duplicate = mapped.has(el.id)
    if (duplicate) {
      warnings.push(
        `Two elements share the id "${el.id}" ("${mapped.get(el.id)!.element.name}" and "${el.name}"). ` +
          `Both are in the model, but a view can only mean one of them, so every view that lists "${el.id}" ` +
          `draws the first.`,
      )
    }
    const entry: MappedElement = { element: el, display }
    if (!duplicate) mapped.set(el.id, entry)

    const style = resolveStyleForElement(el, elementById, ws.elementStyles, { colorScheme })
    warnings.push(...style.warnings)
    if (!duplicate) sourceSize.set(el.id, structurizrSizeFor(style))
    // Kept for the boundary pass below, which runs after this loop and has no
    // other way to reach it: a deployment node that becomes a Group here still
    // has a stylesheet entry upstream (`RoundedBox`, `#e6e6e6`), and a Group
    // that records none exports as an unstyled box.
    resolvedStyleById.set(el.id, style)
    if (isBoundaryNode(el)) continue

    // An instance has no name, description or technology of its own — Java
    // @JsonIgnores all three and dereferences the container instead — so an
    // importer that reads them off the instance draws a row of blank boxes.
    const name = el.name || display.name
    if (!name) {
      warnings.push(`Element "${el.id}" (${el.kind}) has no name and nothing to inherit one from.`)
    }
    const technology = el.technology ?? display.technology
    const tags = dedupe([...display.tags, ...el.tags])
    const type = objectTypeFor(el.kind, technology, tags, style.shape)
    const technologies = parseTechnologies(technology)
    // Facts our own exporter parked in `properties` (status, owners, the compact
    // summary, technology notes) go back into their fields — see
    // `maplespireFacts.ts` for why leaving them as properties lost them.
    const revived = reviveMapleSpireFacts(el.properties)
    const id = newId()

    objects.push({
      id,
      type,
      name: name || `(${el.kind} ${el.id})`,
      description: el.description ?? display.description,
      ...(revived.shortDescription ? { shortDescription: revived.shortDescription } : {}),
      ...(technologies.length
        ? { technologyUsages: seededTechnologyUsages(id, withTechnologyDetails(technologies, revived.technologies)) }
        : {}),
      icon: technologies[0]?.name,
      position: { x: 0, y: 0 },
      size: { ...SIZE_BY_TYPE[type] },
      ...assignTags(tags),
      links: [
        ...((el.url ?? display.url) ? [objectLink((el.url ?? display.url)!)] : []),
        ...revived.extraLinks.map((url) => objectLink(url)),
      ],
      scope: detectScope(scopeLevelFor(el.kind), tags, declaredScope(el.location ?? display.location)),
      status: revived.status ?? 'live',
      ...ownerFields(revived.owners),
      properties: withProvenance(
        { ...revived.properties, ...perspectiveProperties(el), ...styleProperties(style) },
        {
          // Exact provenance. Without it nothing downstream — export, re-import,
          // the fidelity harness — can tell two same-named elements apart.
          [SOURCE_ID_PROPERTY]: el.id,
          [SOURCE_IDENTIFIER_PROPERTY]: el.properties[DSL_IDENTIFIER_PROPERTY],
          [SOURCE_INSTANCE_OF_PROPERTY]: el.instanceOfId,
          [ENVIRONMENT_PROPERTY]: el.environment,
          // §5.5 gives `instances` to deployment nodes and withholds it from
          // infrastructure nodes, which makes its PRESENCE the only surviving
          // trace of which kind a CHILDLESS node was — one with children becomes
          // a Group here and keeps its kind that way. `"1"` is the format's own
          // documented default, so stamping it states a fact that was already
          // true; without it "Corporate firewall" leaves as an
          // `infrastructureNode`, which is a different element.
          [INSTANCES_PROPERTY]: el.kind === 'deploymentNode' ? (el.instances ?? '1') : el.instances,
          // §5.5: which replicas Structurizr generates. Parsed with full
          // ancestor inheritance, so dropping it changes deployment semantics
          // on the way back out.
          [DEPLOYMENT_GROUPS_PROPERTY]: el.deploymentGroups.length
            ? el.deploymentGroups.join(', ')
            : undefined,
        },
        `Element "${name || el.id}"`,
      ),
    })
    if (!duplicate) entry.objectId = id
  }

  const objectById = new Map(objects.map((o) => [o.id, o]))
  const objectIdFor = (elementId: string): string | undefined => mapped.get(elementId)?.objectId

  // Parent pointers, but only between elements that BOTH became shapes: an
  // instance's parent is a deployment node, which is a boundary here, and
  // pointing a shape at a group would break every `parentId` walk in the app.
  for (const el of ws.elements) {
    if (!el.parentId) continue
    const child = objectIdFor(el.id)
    const parent = objectIdFor(el.parentId)
    if (child && parent) objectById.get(child)!.parentId = parent
  }

  // ── groups ─────────────────────────────────────────────────────────────────
  const groups: Group[] = []
  let colorIndex = 0
  const nextColor = () => GROUP_COLORS[colorIndex++ % GROUP_COLORS.length]
  /** How deeply nested each group is, so a diagram can list the tightest box
   *  first — see the sort where `groupIds` is assembled. */
  const groupDepth = new Map<string, number>()

  /** §7.4's `Group` / `Group:<name>` pseudo-element. The customer's own colour
   *  for the box, when they set one; our palette when they did not. */
  const groupColors = (...names: string[]): { color: string; borderColor?: string } => {
    for (const name of names) {
      const style = resolveGroupStyle(name, ws.elementStyles, { colorScheme })
      if (style.explicit.background) {
        return {
          color: style.explicit.background,
          ...(style.explicit.stroke ? { borderColor: style.explicit.stroke } : {}),
        }
      }
    }
    return { color: nextColor() }
  }

  // (a) model `group` strings. Split ONLY when the workspace declares a
  // separator: a group legitimately named "Payments/Billing" is one group, and
  // guessing "/" shatters it into two the customer never had (§13.6).
  const separator = ws.groupSeparator
  const groupIdByPath = new Map<string, string>()
  const groupMembers = new Map<string, string[]>()
  for (const el of ws.elements) {
    const raw = el.group?.trim()
    if (!raw) continue
    const objectId = objectIdFor(el.id)
    if (!objectId) continue
    const levels = separator ? raw.split(separator).map((s) => s.trim()).filter(Boolean) : [raw]
    for (let depth = 0; depth < levels.length; depth += 1) {
      // The path, not the name, is the identity: `Payments/Core` and
      // `Billing/Core` are two different groups that happen to share a label.
      const path = JSON.stringify(levels.slice(0, depth + 1))
      let id = groupIdByPath.get(path)
      if (!id) {
        id = newId()
        groupIdByPath.set(path, id)
        groupDepth.set(id, depth + 1)
        groupMembers.set(id, [])
        const pathName = levels.slice(0, depth + 1).join(separator ?? '')
        groups.push({
          id,
          name: levels[depth]!,
          // Structurizr styles a group by its full path first, then by the leaf
          // name — both spellings appear in real stylesheets.
          ...groupColors(pathName, levels[depth]!),
          objectIds: groupMembers.get(id)!,
          autoSize: false,
          tagAssignments: {},
          tagOrder: [],
          // The separator is recorded with the path, not derived from it. A
          // workspace declaring `"structurizr.groupSeparator": "|"` produces a
          // path the exporter cannot tell from a group literally NAMED
          // `Payments|Core`, so without this the export re-emits the path and
          // declares no separator — and every reader, ours included, flattens
          // the customer's hierarchy into one group with no diagnostic (T5).
          properties: {
            [GROUP_PATH_PROPERTY]: pathName,
            ...(separator ? { [GROUP_SEPARATOR_PROPERTY]: separator } : {}),
          },
        })
      }
      const members = groupMembers.get(id)!
      if (!members.includes(objectId)) members.push(objectId)
    }
  }
  const modelGroupIds = new Set(groupIdByPath.values())

  // (b) deployment nodes. Members are every transitive shape underneath, so a
  // node's box wraps its whole subtree — which is what `sizeGroupBoxes` reads
  // the nesting out of.
  const descendantObjectIds = (elementId: string): string[] => {
    const out: string[] = []
    const walk = (id: string) => {
      for (const child of childrenOf.get(id) ?? []) {
        const objectId = objectIdFor(child.id)
        if (objectId) out.push(objectId)
        walk(child.id)
      }
    }
    walk(elementId)
    return out
  }
  const nodeDepth = (el: SzElement): number => {
    let depth = 0
    let cursor = el.parentId
    const guard = new Set<string>([el.id])
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor)
      depth += 1
      cursor = elementById.get(cursor)?.parentId
    }
    return depth
  }
  for (const el of ws.elements) {
    if (!isBoundaryNode(el)) continue
    const members = descendantObjectIds(el.id)
    const id = newId()
    groupDepth.set(id, nodeDepth(el) + 10)
    mapped.get(el.id)!.groupId = id
    const facts = [
      el.description,
      el.technology,
      el.instances && el.instances !== '1' ? `${el.instances} instances` : undefined,
      el.environment ? `Environment: ${el.environment}` : undefined,
    ].filter(Boolean)
    groups.push({
      id,
      name: el.name,
      ...groupColors(el.name),
      objectIds: members,
      // Left off `parentObjectId` deliberately: that field means "this boundary
      // IS a model object drilled into", and a deployment node is not one of our
      // objects at all. The layout's boundary-violation metric only polices
      // parent wrappers, which is the right answer here — a deployment box
      // legitimately contains shapes that are not its own members' children.
      type: 'Deployment node',
      ...(facts.length ? { description: facts.join(' · ') } : {}),
      ...(el.technology ? { technologyUsages: seededTechnologyUsages(id, technologyNames(el.technology)) } : {}),
      autoSize: false,
      ...assignTags(el.tags),
      // A boundary is an ENTITY upstream, with an id of its own. `big-bank-plc`
      // has three nodes called "Apache Tomcat"; without this nothing — export,
      // re-import, the fidelity harness — can tell them apart, and the display
      // string above is not a channel anything can read back.
      properties: withProvenance(
        (() => {
          const style = resolvedStyleById.get(el.id)
          return style ? { ...el.properties, ...styleProperties(style) } : el.properties
        })(),
        {
          [SOURCE_ID_PROPERTY]: el.id,
          [SOURCE_IDENTIFIER_PROPERTY]: el.properties[DSL_IDENTIFIER_PROPERTY],
          [ENVIRONMENT_PROPERTY]: el.environment,
          [INSTANCES_PROPERTY]: el.instances,
          [NODE_TECHNOLOGY_PROPERTY]: el.technology,
          [URL_PROPERTY]: el.url,
          [DEPLOYMENT_GROUPS_PROPERTY]: el.deploymentGroups.length
            ? el.deploymentGroups.join(', ')
            : undefined,
        },
        `Deployment node "${el.name}"`,
      ),
    })
  }

  // ── connections ────────────────────────────────────────────────────────────
  const connections: Connection[] = []
  const connectionById = new Map<string, Connection>()
  const connectionIdByRelationship = new Map<string, string>()
  const unrepresentable: string[] = []
  for (const rel of ws.relationships) {
    const fromId = objectIdFor(rel.sourceId)
    const toId = objectIdFor(rel.destinationId)
    if (!fromId || !toId) {
      const endpointIsNode =
        kindById.get(rel.sourceId) === 'deploymentNode' || kindById.get(rel.destinationId) === 'deploymentNode'
      if (endpointIsNode) {
        // A Connection joins two shapes; a deployment node that wraps something
        // is a boundary here, so "Oracle - Primary replicates data to Oracle -
        // Secondary" has no shape to leave from. Named rather than dropped.
        unrepresentable.push(
          `"${rel.description ?? rel.id}" (${elementById.get(rel.sourceId)?.name ?? rel.sourceId} → ${
            elementById.get(rel.destinationId)?.name ?? rel.destinationId
          })`,
        )
      } else {
        warnings.push(`Relationship "${rel.id}" references an element the model does not declare and was skipped.`)
      }
      continue
    }
    const style = resolveStyleForRelationship(rel, relationshipById, ws.relationshipStyles, { colorScheme })
    warnings.push(...style.warnings)
    const id = newId()
    connectionIdByRelationship.set(rel.id, id)
    const technologies = parseTechnologies(rel.technology)
    const revived = reviveMapleSpireFacts(rel.properties)
    // Our exporter writes `label` + blank line + the connection's Markdown into
    // the one wire field, AND the Markdown alone as `maplespire.description`.
    // Only that property says where the label ends: without it the field is
    // someone else's description and is drawn whole (a Structurizr author's
    // multi-paragraph description is not a label plus documentation), and with
    // it a description that IS the Markdown carried no label at all.
    const wireDescription = rel.description ?? ''
    const documentation = revived.description
    const ourSuffix = documentation === undefined ? undefined : `\n\n${documentation}`
    const drawnLabel =
      documentation === undefined
        ? wireDescription
        : wireDescription.trim() === documentation
          ? ''
          : ourSuffix && wireDescription.endsWith(ourSuffix)
            ? wireDescription.slice(0, -ourSuffix.length).trim()
            : wireDescription
    const connection: Connection = {
      id,
      fromId,
      toId,
      label: drawnLabel || rel.technology || '',
      ...(documentation ? { description: documentation } : {}),
      ...(revived.status ? { status: revived.status } : {}),
      ...ownerFields(revived.owners),
      ...(technologies.length
        ? { technologyUsages: seededTechnologyUsages(id, withTechnologyDetails(technologies, revived.technologies)) }
        : {}),
      // Structurizr's UNSTYLED relationship is dashed, not solid (§7.4). Drawing
      // solid by default mis-renders every workspace that never styled its edges.
      type: style.style === 'Dotted' ? 'dotted' : style.style === 'Solid' ? 'solid' : 'dashed',
      shape: 'curved',
      // NOT `kind: 'lower'`. In this app `lower` does not mean "derived
      // upstream" — it means "a per-diagram roll-up the client recomputes and
      // never persists". `bridge.ts` strips every `lower` connection from the
      // model doc and from each diagram's `connectionIds`, and
      // `syncLowerConnections` prunes any it did not just re-derive. An imported
      // deployment view stamped that way loses ALL of its arrows the moment the
      // canvas opens it, permanently. The derivation is recorded as provenance
      // instead, which is what it actually is.
      ...assignTags(rel.tags),
      properties: withProvenance(
        revived.properties,
        {
          [SOURCE_ID_PROPERTY]: rel.id,
          [SOURCE_IDENTIFIER_PROPERTY]: rel.properties[DSL_IDENTIFIER_PROPERTY],
          [URL_PROPERTY]: rel.url,
          // Synchronous/Asynchronous. `parse.ts` strips it from `tags` because
          // it is a machine-generated default there; without this it is gone.
          [INTERACTION_STYLE_PROPERTY]: rel.interactionStyle,
          [LINKED_RELATIONSHIP_PROPERTY]: rel.linkedRelationshipId,
          ...(style.explicit.color ? { [`${STYLE_PREFIX}color`]: style.explicit.color } : {}),
          ...(style.explicit.thickness !== undefined
            ? { [`${STYLE_PREFIX}thickness`]: String(style.explicit.thickness) }
            : {}),
        },
        `Relationship "${rel.description ?? rel.id}"`,
      ),
    }
    if (Object.keys(connection.properties!).length === 0) delete connection.properties
    connections.push(connection)
    connectionById.set(id, connection)
  }
  if (unrepresentable.length > 0) {
    warnings.push(
      `${unrepresentable.length} relationship(s) run between deployment nodes, which are imported as boundaries ` +
        `rather than shapes, so they could not be drawn: ${unrepresentable.join('; ')}.`,
    )
  }

  // ── views → diagrams ───────────────────────────────────────────────────────
  const diagrams: Diagram[] = []
  const flows: Flow[] = []
  const layoutHints: Record<string, { direction?: LayoutDirection }> = {}
  const preservedDiagramIds: string[] = []
  const preservedConnectionIds = new Set<string>()
  /** Connections whose bends a preserved view has already claimed. Separate from
   *  the set above: being ON a preserved diagram protects an edge from the
   *  layout engine, but only ROUTING it decides whose bends win. */
  const routedConnectionIds = new Set<string>()
  const diagramByViewKey = new Map<string, Diagram>()

  const declaredViews = ws.views
  if (declaredViews.length === 0 && ws.elements.length > 0) {
    warnings.push(
      'The file declares no views, so a default set was generated (one landscape view, one container view per ' +
        'software system and one component view per container). Structurizr keeps views in the workspace, so a ' +
        'file without them is usually the model half of a pair.',
    )
  }
  const views = declaredViews.length > 0 ? declaredViews : synthesiseViews(ws)

  // Structurizr keys are unique PER VIEW TYPE, not globally, so a landscape view
  // and a context view may both be keyed "Dup" in a legal file. `baseViewKey`
  // and the entry selection can then resolve to the wrong one; the first wins,
  // and both are still imported as diagrams.
  const viewByKey = new Map<string, SzView>()
  for (const view of views) {
    if (viewByKey.has(view.key)) {
      warnings.push(
        `Two views share the key "${view.key}" (${viewByKey.get(view.key)!.kind} and ${view.kind}). Both were ` +
          `imported, but anything that refers to a view by key — a filtered view's base, an export — resolves to ` +
          `the first.`,
      )
      continue
    }
    viewByKey.set(view.key, view)
  }

  const viewTitle = (view: SzView) => view.title?.trim() || view.key

  /**
   * A filtered view, resolved into the view it actually draws.
   *
   * The wire gives a filtered view a base key, a mode and some tags, and NOTHING
   * else — no elements, no relationships, no coordinates. Reading its own empty
   * arrays is what imported it as three boxes with no lines, and then re-laid it
   * out even though the base view beside it was hand-arranged. Everything
   * downstream therefore works on the BASE view's rows, filtered.
   */
  const resolveFiltered = (view: SzView): SzView | null => {
    const base = view.baseViewKey ? viewByKey.get(view.baseViewKey) : undefined
    if (!base) {
      warnings.push(
        `Filtered view "${viewTitle(view)}" refers to base view "${view.baseViewKey ?? '(none)'}", which the file does not contain; it was skipped.`,
      )
      return null
    }
    const hasTag = (id: string) => {
      const el = elementById.get(id)
      return el ? el.styleTags.some((t) => view.filterTags.includes(t)) : false
    }
    // §18.3: the wire records the base view, the mode and the tags, and nothing
    // states how they combine. We apply the only reading the fields support —
    // keep (Include) or remove (Exclude) the elements carrying any filter tag —
    // and say so, because the alternative is dropping the customer's view.
    // "Include nothing" is empty, not everything: reading it as everything makes
    // the filter a no-op and the warning a lie about what was drawn.
    const include = view.filterMode === 'Include'
    const elements = base.elements.filter((e) => (include ? hasTag(e.id) : !hasTag(e.id)))
    const kept = new Set(elements.map((e) => e.id))
    warnings.push(
      `Filtered view "${viewTitle(view)}" was rebuilt from "${base.key}" by ${include ? 'keeping' : 'removing'} ` +
        `elements tagged ${view.filterTags.join(', ') || '(nothing)'} — Structurizr does not record how it resolved ` +
        `the filter, so check it.`,
    )
    return {
      // Level, scope, coordinates and rank direction all come from the base: a
      // filtered view IS the base view with rows taken out.
      ...base,
      key: view.key,
      title: view.title ?? base.title,
      description: view.description ?? base.description,
      order: view.order,
      elements,
      relationships: base.relationships.filter((row) => {
        const rel = relationshipById.get(row.id)
        return rel ? kept.has(rel.sourceId) && kept.has(rel.destinationId) : false
      }),
    }
  }

  for (const declared of views) {
    if (declared.kind === 'image') {
      // An image view is a PNG hosted somewhere else; there is no model content
      // to rebuild it from, and the contract does not carry the URL either.
      warnings.push(
        `View "${viewTitle(declared)}" is an image view — it holds a picture, not a model, so no diagram was created for it.`,
      )
      continue
    }
    const view = declared.kind === 'filtered' ? resolveFiltered(declared) : declared
    if (!view) continue

    // The system/container boundary a drill-down view is scoped to. The scope
    // element is drawn AROUND its children, so when the file also LISTS it among
    // the view's own elements (structurizr-ui writes that row once the boundary
    // has been dragged; nl-wallet ships it) it must not become a second shape as
    // well — that put a stray copy of the system in a grid below the diagram,
    // with its real coordinate thrown away.
    const scopeId = view.kind === 'container' || view.kind === 'component' ? view.scopeId : undefined
    const scope = scopeId ? elementById.get(scopeId) : undefined
    const scopeObjectId = scopeId ? objectIdFor(scopeId) : undefined
    const inside = scopeId
      ? view.elements
          .map((m) => elementById.get(m.id))
          .filter((el): el is SzElement => Boolean(el && el.parentId === scopeId))
          .map((el) => objectIdFor(el.id))
          .filter((id): id is string => Boolean(id))
      : []
    // Nothing inside it means there is no boundary to draw, so the scope element
    // is an ordinary shape on this view — and has to be placed like one.
    const scopeIsBoundary = Boolean(scopeId && scope && scopeObjectId && inside.length > 0)

    const objectIds: string[] = []
    const memberKinds: SzElementKind[] = []
    const groupIds: string[] = []
    const seenGroups = new Set<string>()
    for (const member of view.elements) {
      const entry = mapped.get(member.id)
      if (!entry) {
        warnings.push(`View "${viewTitle(view)}" lists element "${member.id}", which the model does not declare.`)
        continue
      }
      memberKinds.push(entry.element.kind)
      if (scopeIsBoundary && member.id === scopeId) continue
      if (entry.objectId) {
        if (!objectIds.includes(entry.objectId)) objectIds.push(entry.objectId)
      } else if (entry.groupId && !seenGroups.has(entry.groupId)) {
        seenGroups.add(entry.groupId)
        groupIds.push(entry.groupId)
      }
    }

    // A model-declared group shows as soon as ONE of its members is on the view
    // — that is what Structurizr draws, and the DSL importer's "at least two"
    // rule exists only because it was guessing membership in the first place.
    // Only MODEL groups are added this way: a deployment boundary belongs to the
    // view that listed its node, and a system boundary to the view it scopes.
    const onDiagram = new Set(objectIds)
    for (const group of groups) {
      if (!modelGroupIds.has(group.id) || seenGroups.has(group.id)) continue
      if (!group.objectIds.some((id) => onDiagram.has(id))) continue
      seenGroups.add(group.id)
      groupIds.push(group.id)
    }

    let parentObjectId: string | undefined
    if (scopeIsBoundary) {
      parentObjectId = scopeObjectId
      const boundaryId = newId()
      groupDepth.set(boundaryId, 0)
      const scopeStyle = resolveStyleForElement(scope!, elementById, ws.elementStyles, { colorScheme })
      groups.push({
        id: boundaryId,
        name: scope!.name,
        color: scopeStyle.explicit.background ?? BOUNDARY_COLOR,
        ...(scopeStyle.explicit.stroke ? { borderColor: scopeStyle.explicit.stroke } : {}),
        objectIds: inside,
        parentObjectId: scopeObjectId,
        type: objectById.get(scopeObjectId!)?.type === 'system' ? 'System' : 'Container',
        description: scope!.description,
        autoSize: false,
        tagAssignments: {},
        tagOrder: [],
        // NOT `structurizr.id`: that key means "this entity IS the element with
        // that wire id", and the element is already here as an object (which
        // `parentObjectId` points at). A drill-down boundary is a per-view
        // rendering of it, so it gets its own key — stamping the shared one made
        // the id ambiguous and downgraded two elements to a name match.
        properties: { [BOUNDARY_FOR_PROPERTY]: scope!.id },
      })
      groupIds.push(boundaryId)
    }

    // Deepest boundary first: the layout engine clusters each shape with the
    // FIRST group on the diagram that claims it, and the tightest box is the one
    // that should own it. A system/container wrapper ranks last — it is the
    // outermost box on any view that has one.
    groupIds.sort((a, b) => (groupDepth.get(b) ?? 0) - (groupDepth.get(a) ?? 0))

    const connectionIds: string[] = []
    const drawnRows = new Map<string, SzView['relationships'][number]>()
    for (const row of view.relationships) {
      const connectionId = connectionIdByRelationship.get(row.id)
      if (!connectionId) continue
      const connection = connectionById.get(connectionId)
      // Both endpoints must be ON the diagram or the canvas draws a line into
      // empty space. A dynamic view repeats one relationship per step (T9), and
      // a diagram can only hold the connection once, hence the dedupe.
      if (!connection || !onDiagram.has(connection.fromId) || !onDiagram.has(connection.toId)) continue
      if (!connectionIds.includes(connectionId)) {
        connectionIds.push(connectionId)
        drawnRows.set(connectionId, row)
      }
    }

    const diagram: Diagram = {
      id: newId(),
      name: viewTitle(view),
      type: diagramTypeFor(view, memberKinds),
      sourceViewKey: view.key,
      ...(view.description ? { description: view.description } : {}),
      ...(parentObjectId ? { parentObjectId } : {}),
      objectIds,
      connectionIds,
      groupIds,
    }

    // ── layout: keep the file's coordinates, or hand the view to auto-layout ──
    // `layoutPolicy` calls a view's scope element a BOUNDARY. That is right for
    // a container/component view that draws one — the system or container in
    // focus is the box around its children — and wrong everywhere else: on a
    // system context view the scope is the central shape, on a dynamic view an
    // ordinary participant, and on a container view whose members are all
    // OUTSIDE the scope there is no boundary at all. A boundary is kept out of
    // `layouts`, so getting this wrong parks a real shape below the diagram.
    const layoutView = scopeIsBoundary ? view : { ...view, scopeId: undefined }
    const plan = planViewLayout(layoutView, kindById, {
      drawnAsShape,
      targetSizeFor: (elementId) => {
        const objectId = objectIdFor(elementId)
        const object = objectId ? objectById.get(objectId) : undefined
        return object ? { ...object.size } : { ...SIZE_BY_TYPE.app }
      },
      sourceSizeFor: (elementId) => sourceSize.get(elementId) ?? { width: 450, height: 300 },
    })
    if (plan.kind === 'preserved') {
      let layouts: LayoutRecord = {}
      for (const [elementId, layout] of Object.entries(plan.layouts)) {
        const objectId = objectIdFor(elementId)
        if (objectId && onDiagram.has(objectId)) layouts[objectId] = layout
      }
      // Everything the file placed nowhere — the leaves `planViewLayout` hands
      // back, plus anything it skipped — still needs an entry: the store and the
      // canvas both read a missing layout as "not on this diagram".
      const unplaced = objectIds.filter((id) => !layouts[id])
      layouts = packUnplaced(unplaced, (id) => ({ ...(objectById.get(id)?.size ?? SIZE_BY_TYPE.app) }), layouts)
      diagram.layouts = sizeGroupBoxes(
        groups.filter((g) => groupIds.includes(g.id)),
        layouts,
        'fresh',
        Object.fromEntries(groupDepth),
      )
      preservedDiagramIds.push(diagram.id)
      for (const connectionId of connectionIds) preservedConnectionIds.add(connectionId)
      applyEdgeRouting(plan, drawnRows, connectionById, routedConnectionIds, viewTitle(view), warnings)
    } else {
      const direction = view.automaticLayout?.rankDirection
        ? DIRECTION_BY_RANK[view.automaticLayout.rankDirection]
        : undefined
      if (direction) layoutHints[diagram.id] = { direction }
    }

    diagrams.push(diagram)
    diagramByViewKey.set(view.key, diagram)

    if (view.kind === 'dynamic') {
      const flow = buildFlow(view, diagram, connectionIdByRelationship, connections, newId, warnings)
      if (flow) flows.push(flow)
    }
  }

  // The customer's palette, on the entity that carries a colour in this app.
  // Structurizr styles ARE keyed by tag, so this is the same statement in the
  // same terms — "everything tagged Queue is red" — and it survives into the
  // chips and the bottom bar instead of being resolved and thrown away.
  for (const [value, tag] of tagByValue) {
    const background = resolveElementStyle([value], ws.elementStyles, { colorScheme }).explicit.background
    if (background) tag.color = background
  }

  // Entry: the landscape view if there is one — it is the map of the whole
  // estate, and its key/name are free-form so only the view KIND identifies it.
  const landscapeKey = views.find((v) => v.kind === 'systemLandscape')?.key
  const entry =
    (landscapeKey ? diagramByViewKey.get(landscapeKey) : undefined) ??
    diagrams.find((d) => d.type === 'context') ??
    diagrams[0] ??
    null

  return {
    objects,
    connections,
    groups,
    tags: [...tagByValue.values()],
    diagrams,
    flows,
    layoutHints,
    preservedDiagramIds,
    preservedConnectionIds: [...preservedConnectionIds],
    groupDepths: Object.fromEntries(groupDepth),
    entryDiagramId: entry?.id ?? null,
    ...(ws.name ? { landscapeName: ws.name } : {}),
    // Style resolution warns per ELEMENT, so one broken style reaches here once
    // per element that carries the tag. The modal renders this as a bullet list.
    warnings: dedupe(warnings),
    stats: {
      objects: objects.length,
      connections: connections.length,
      groups: groups.length,
      diagrams: diagrams.length,
      byLevel: {
        context: diagrams.filter((d) => d.type === 'context').length,
        container: diagrams.filter((d) => d.type === 'container').length,
        component: diagrams.filter((d) => d.type === 'component').length,
      },
    },
  }
}

// ── Hand-routed edges ────────────────────────────────────────────────────────

/**
 * Put a preserved view's edge routing onto its connections.
 *
 * `vertices` are the bends the customer dragged, in the SAME wire coordinate
 * space as the shapes, so they go through the view's transform or the line
 * detaches from the boxes it joins. `routing` picks the line shape and
 * `position` is the label's place along it (0-100 on the wire, a fraction here).
 *
 * These three fields live on the CONNECTION, not on the diagram, so an edge
 * drawn on two views can only carry one routing. The first preserved view that
 * routes it wins and a disagreement is named — silently taking the last would
 * redraw a diagram the customer never touched.
 */
function applyEdgeRouting(
  plan: PreservedLayout,
  rows: ReadonlyMap<string, SzView['relationships'][number]>,
  connectionById: ReadonlyMap<string, Connection>,
  claimed: Set<string>,
  viewName: string,
  warnings: string[],
): void {
  for (const [connectionId, row] of rows) {
    const connection = connectionById.get(connectionId)
    if (!connection) continue
    const routed = row.vertices.length > 0 || row.routing !== undefined || row.position !== undefined
    if (!routed) continue
    if (claimed.has(connectionId)) {
      warnings.push(
        `View "${viewName}" routes the connection "${connection.label || connectionId}" differently from an ` +
          `earlier view that also draws it. Bends and label placement belong to the connection, not to one ` +
          `diagram, so the first view's routing was kept.`,
      )
      continue
    }
    claimed.add(connectionId)
    if (row.vertices.length > 0) {
      connection.waypoints = row.vertices.map((v) => projectWirePoint(plan, v))
    }
    const shape = row.routing ? SHAPE_BY_ROUTING[row.routing] : undefined
    if (shape) connection.shape = shape
    else if (row.vertices.length > 0) connection.shape = 'straight'
    if (row.position !== undefined) {
      connection.labelPosition = Math.min(1, Math.max(0, row.position / 100))
    }
  }
}

// ── Dynamic views → flows ────────────────────────────────────────────────────

function buildFlow(
  view: SzView,
  diagram: Diagram,
  connectionIdByRelationship: ReadonlyMap<string, string>,
  connections: readonly Connection[],
  newId: () => string,
  warnings: string[],
): Flow | null {
  const rows = view.relationships.map((row, index) => ({ row, index }))
  if (rows.length === 0) return null

  // `order` is optional on the wire (views-without-order.json is the proof), and
  // a producer that omits it has still written the steps in sequence — so file
  // order is the fallback, never a re-sort into id order.
  const ordered = rows.some(({ row }) => row.order !== undefined)
  if (!ordered) {
    warnings.push(
      `Dynamic view "${view.title?.trim() || view.key}" gives its steps no order; they were kept in file order.`,
    )
  }
  const sorted = [...rows].sort((a, b) => {
    const ao = a.row.order
    const bo = b.row.order
    // A step with no order among steps that have one cannot be placed; keeping
    // it in file order at least keeps it in the flow instead of losing it.
    if (ao === undefined && bo === undefined) return a.index - b.index
    if (ao === undefined) return 1
    if (bo === undefined) return -1
    const byOrder = compareOrder(ao, bo)
    return byOrder !== 0 ? byOrder : a.index - b.index
  })

  const connectionById = new Map(connections.map((c) => [c.id, c]))
  const steps: FlowStep[] = []
  for (const { row } of sorted) {
    const connectionId = connectionIdByRelationship.get(row.id)
    const connection = connectionId ? connectionById.get(connectionId) : undefined
    if (!connection) continue
    if (!diagram.connectionIds.includes(connection.id)) continue
    // `response: true` means the step walks the SAME relationship backwards —
    // the reply leg of a request/response pair. Reusing the edge with the
    // endpoints swapped is what makes the two legs one arrow on the diagram.
    const backwards = row.response === true
    steps.push({
      id: newId(),
      order: steps.length + 1,
      type: 'message',
      title: row.description ?? connection.label ?? '',
      fromObjectId: backwards ? connection.toId : connection.fromId,
      toObjectId: backwards ? connection.fromId : connection.toId,
      connectionId: connection.id,
    })
  }
  if (steps.length === 0) return null
  return {
    id: newId(),
    name: view.title?.trim() || view.key,
    diagramId: diagram.id,
    steps,
  }
}
