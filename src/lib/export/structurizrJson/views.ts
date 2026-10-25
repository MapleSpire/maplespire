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
 * `workspace.views` — the only half of a Structurizr workspace that can carry
 * the arrangement a customer made by hand, and therefore the reason this
 * exporter exists at all.
 *
 * Three things decide whether that arrangement survives:
 *
 *  1. **Every member is placed.** `x`/`y` are required by the wire types, and a
 *     member with no `layouts` entry still has to land somewhere — an element
 *     view with no coordinate is read as unplaced and re-laid-out by the
 *     renderer, which is the failure this file exists to prevent.
 *  2. **The scale is the exact reciprocal of the importer's.** `layoutPolicy`
 *     shrinks a view by `scaleFactorFor` on the way in; growing it by anything
 *     else on the way out makes import→export→import a slow zoom instead of a
 *     fixed point. The same function and the same constants are used here, from
 *     the same module, so the two cannot drift apart.
 *  3. **No `automaticLayout`.** It has no declaration in `./types` at all: a view
 *     carrying it is re-laid-out by every reader, discarding the coordinates we
 *     just wrote.
 *
 * Coordinates are top-left on both sides — Structurizr per §6.3 (`maximumX =
 * elementView.getX() + style.getWidth()`), MapleSpire per `CanvasEngine`'s hit
 * test — so nothing here converts between corners and centres.
 *
 * One assumption is worth stating because it is shared with a module this one
 * does not import: the SOURCE box of an element upstream is taken to be
 * `STRUCTURIZR_DEFAULT_ELEMENT_SIZE` (450×300, the box structurizr-ui draws for
 * an element that matched no style, §7.4). That is the same assumption
 * `DEFAULT_LAYOUT_SCALE` is derived from. If the styles emitter ever writes
 * `width`/`height` into an `ElementStyle`, the box upstream stops being 450×300
 * and this scale has to read those numbers instead — otherwise the round trip
 * zooms by exactly the ratio between them.
 */

import type { C4Object, Connection, Diagram, Flow, Group, MessageStep, Position, Size } from '../../../types'
import { scaleFactorFor } from '../../structurizr/json/layoutPolicy'
import { resolveLowerRouting } from '../../diagrams/lowerRouting'
import { ENVIRONMENT_PROPERTY, SOURCE_ID_PROPERTY, SOURCE_INSTANCE_OF_PROPERTY } from '../../structurizr/json/provenance'
import {
  DEFAULT_LAYOUT_SCALE,
  STRUCTURIZR_DEFAULT_ELEMENT_SIZE,
  SYNTHETIC_UNGROUPED_SYSTEM_ENTITY_ID,
  type ExportContext,
  type WireComponentView,
  type WireContainerView,
  type WireDeploymentView,
  type WireDynamicView,
  type WireElementView,
  type WireRelationshipView,
  type WireRouting,
  type WireSystemContextView,
  type WireSystemLandscapeView,
  type WireVertex,
  type WireViewSet,
} from './types'

/**
 * Where a view's top-left shape lands in wire space.
 *
 * It cannot be the origin. `0` is a primitive `int` upstream and is
 * indistinguishable from an absent key (§6.3), so every reader — ours included
 * (T10) — treats `(0,0)` as "nobody placed this". Translating the whole
 * arrangement clear of the origin costs nothing (a reader normalises to its own
 * origin anyway) and it keeps the one shape the customer put top-left.
 */
const WIRE_ORIGIN: Position = { x: 100, y: 100 }

/** Canvas px left around a shape we had to place ourselves. */
const GRID_GAP = 60

/** Per-view: canvas px → the 300-dpi space, for this view's own arrangement. */
export const VIEW_SCALE_PROPERTY = 'maplespire.layoutScale'

/**
 * §6.4's routing, from the two line shapes the canvas draws. `Orthogonal` is
 * unreachable on purpose: the importer reads it as `straight`, so re-emitting it
 * would need a distinction MapleSpire does not store, and guessing it would
 * redraw an edge the customer never touched.
 */
const ROUTING_BY_SHAPE: Record<'curved' | 'straight', WireRouting> = {
  curved: 'Curved',
  straight: 'Direct',
}

/** §5.5: what upstream calls a deployment element that names no environment. */
const DEFAULT_ENVIRONMENT = 'Default'

/** A member of a view, with the box the customer sees it drawn in. */
interface PlacedMember {
  object: C4Object
  position: Position
  size: Size
}

/** A view's whole canvas→wire similarity transform. */
interface ViewTransform {
  scale: number
  /** The canvas point that lands on `WIRE_ORIGIN`. */
  canvasOrigin: Position
}

// ── Placement ────────────────────────────────────────────────────────────────

/**
 * Where each member of a diagram sits, in canvas space.
 *
 * `diagram.layouts` is authoritative and the object's own `position` is the
 * fallback the rest of the app uses (`import/fidelity.ts`). `(0,0)` is not one
 * of the answers: it is where a freshly imported object sits before anything has
 * laid it out, so a whole diagram's worth of members would stack there. Those go
 * to the grid instead, which is a placement someone can drag apart rather than a
 * pile they have to discover.
 */
function placeMembers(ctx: ExportContext, diagram: Diagram): PlacedMember[] {
  const layouts = diagram.layouts ?? {}
  const placed: PlacedMember[] = []
  const unplaced: C4Object[] = []

  for (const objectId of diagram.objectIds) {
    const object = ctx.objectById.get(objectId)
    if (!object) continue
    const layout = layouts[objectId]
    if (layout) {
      placed.push({ object, position: layout.position, size: layout.size })
    } else if (object.position.x !== 0 || object.position.y !== 0) {
      placed.push({ object, position: object.position, size: object.size })
    } else {
      unplaced.push(object)
    }
  }

  if (unplaced.length > 0) {
    ctx.warn(
      `${unplaced.length} shape(s) on "${diagram.name}" have no place on that diagram, so they were laid out in a ` +
        `grid below it — Structurizr has no way to say "unplaced", and leaving them on the origin would stack them.`,
    )
    placed.push(...gridPack(unplaced, placed))
  }
  return placed
}

/** Pack what nothing placed into a grid below everything that was placed. */
function gridPack(objects: readonly C4Object[], placed: readonly PlacedMember[]): PlacedMember[] {
  const startX = placed.length > 0 ? Math.min(...placed.map((p) => p.position.x)) : 0
  const startY =
    placed.length > 0 ? Math.max(...placed.map((p) => p.position.y + p.size.height)) + GRID_GAP * 2 : 0
  const columns = Math.max(1, Math.ceil(Math.sqrt(objects.length)))
  const cell = {
    width: Math.max(...objects.map((o) => o.size.width)) + GRID_GAP,
    height: Math.max(...objects.map((o) => o.size.height)) + GRID_GAP,
  }
  return objects.map((object, index) => ({
    object,
    position: {
      x: startX + (index % columns) * cell.width,
      y: startY + Math.floor(index / columns) * cell.height,
    },
    size: object.size,
  }))
}

/**
 * How far apart the shapes have to sit upstream to keep the arrangement.
 *
 * This is `scaleFactorFor` read backwards. The importer takes the MAXIMUM of
 * every (our box / their box) ratio over a view's leaves and multiplies the
 * whole arrangement by it; the exact reciprocal is the only factor that returns
 * the view to where it came from. Anything else — a constant, a per-axis pair —
 * compounds on every round trip, and a customer who exports, re-imports and
 * exports again watches their diagram drift.
 *
 * A caller that named its own `layoutScale` means it, so an explicit option wins
 * over the per-view answer; the derived default is the one this refines.
 */
function viewScale(ctx: ExportContext, placed: readonly PlacedMember[]): number {
  if (ctx.layoutScale !== DEFAULT_LAYOUT_SCALE) return ctx.layoutScale
  if (placed.length === 0) return ctx.layoutScale
  // A shape the customer dragged BIGGER than the box Structurizr draws does not
  // constrain the spacing — upstream it is drawn at 450×300, i.e. smaller, so it
  // needs LESS room than it occupies here, not more. Leaving it in drags the
  // whole view's scale down to whatever IT needs (the reciprocal is a minimum),
  // and every other shape on the view is then packed closer together than the
  // box a reader will draw for it: four objects on one diagram, one of them
  // 900×600, came out 150px apart while each was drawn 450 wide, so every pair
  // overlapped. Excluding them costs nothing where there are none, which is
  // every view in the fixture corpus — the factor there is unchanged, and it has
  // to be, because it is the exact reciprocal of the importer's and anything
  // else makes import→export→import a slow zoom.
  const constraining = placed.filter(
    (member) =>
      member.size.width <= STRUCTURIZR_DEFAULT_ELEMENT_SIZE.width &&
      member.size.height <= STRUCTURIZR_DEFAULT_ELEMENT_SIZE.height,
  )
  // A view of nothing BUT oversized shapes has no member to measure against, so
  // it takes the landscape-wide default rather than a factor derived from a box
  // that will not be drawn.
  const measured = constraining.length > 0 ? constraining : []
  if (measured.length === 0) return ctx.layoutScale
  return (
    1 /
    scaleFactorFor(
      measured.map((member) => ({ source: STRUCTURIZR_DEFAULT_ELEMENT_SIZE, target: member.size })),
    )
  )
}

function transformFor(ctx: ExportContext, placed: readonly PlacedMember[]): ViewTransform {
  const canvasOrigin: Position =
    placed.length > 0
      ? {
          x: Math.min(...placed.map((member) => member.position.x)),
          y: Math.min(...placed.map((member) => member.position.y)),
        }
      : { x: 0, y: 0 }
  return { scale: viewScale(ctx, placed), canvasOrigin }
}

/** The inverse of `layoutPolicy.projectWirePoint`, point for point. */
function toWire(transform: ViewTransform, point: Position): WireVertex {
  return {
    x: Math.round(WIRE_ORIGIN.x + (point.x - transform.canvasOrigin.x) * transform.scale),
    y: Math.round(WIRE_ORIGIN.y + (point.y - transform.canvasOrigin.y) * transform.scale),
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** The deployment nodes drawn on a diagram, as the importer left them: groups. */
function deploymentNodeGroups(ctx: ExportContext, diagram: Diagram): Group[] {
  const out: Group[] = []
  for (const groupId of diagram.groupIds) {
    const group = ctx.groupById.get(groupId)
    if (group && ctx.groupRoleById.get(groupId) === 'deploymentNode') out.push(group)
  }
  return out
}

/**
 * One `elements[]` row per thing drawn on the view.
 *
 * Deployment nodes go out on `(0,0)`, which is not a placement but the wire's
 * word for "this box is derived from what it contains" (§13.3, T10) — the same
 * reading under which the importer sizes them from their children. Inventing a
 * coordinate for one would pin a box upstream computes.
 *
 * A drill-down BOUNDARY group is deliberately not a row: it is a per-view
 * rendering of the element the view is already scoped to, and emitting it as
 * well would put a second copy of that element on the diagram.
 */
function elementRows(
  ctx: ExportContext,
  diagram: Diagram,
  placed: readonly PlacedMember[],
  transform: ViewTransform,
): WireElementView[] {
  const rows: WireElementView[] = deploymentNodeGroups(ctx, diagram).map((group) => ({
    id: ctx.ids.wireId(group),
    x: 0,
    y: 0,
  }))
  for (const member of placed) {
    rows.push({ id: ctx.ids.wireId(member.object), ...toWire(transform, member.position) })
  }
  return rows
}

/**
 * The geometry of one drawn edge: the bends the customer dragged, the line
 * shape, and where along the line the label sits.
 *
 * `waypoints` are stored on the CONNECTION rather than per diagram in this app,
 * so the same bends are drawn on every diagram that shows the edge — which is
 * what the customer sees, and therefore what goes out on each view, through that
 * view's own transform.
 *
 * `routing` is emitted for every edge, not only for the ones that state a shape:
 * absence means "inherit from the style" and the style's own default is `Direct`
 * (§7.4), so silence would straighten every curve on the diagram.
 */
function edgeGeometry(
  diagram: Diagram,
  stored: Connection,
  transform: ViewTransform,
): Pick<WireRelationshipView, 'vertices' | 'routing' | 'position'> {
  // A derived (lower) edge is routed by THIS diagram (`lowerRouting`), not by
  // the shared lower object.
  const connection = resolveLowerRouting(stored, diagram.lowerRouting)
  const waypoints = connection.waypoints ?? []
  const shape = connection.shape ?? diagram.defaultConnectionShape ?? 'curved'
  return {
    ...(waypoints.length > 0 ? { vertices: waypoints.map((point) => toWire(transform, point)) } : {}),
    routing: ROUTING_BY_SHAPE[shape],
    ...(connection.labelPosition !== undefined
      ? // 0–1 here, 0–100 ALONG the line upstream. The setter clamps rather than
        // rejecting, so a value outside the range is a silent move, not an error.
        { position: Math.round(Math.min(1, Math.max(0, connection.labelPosition)) * 100) }
      : {}),
  }
}

/** `relationships[]` for a static or deployment view: which edges are drawn. */
function relationshipRows(
  ctx: ExportContext,
  diagram: Diagram,
  onView: ReadonlySet<string>,
  transform: ViewTransform,
): WireRelationshipView[] {
  const rows: WireRelationshipView[] = []
  for (const connectionId of diagram.connectionIds) {
    const connection = ctx.connectionById.get(connectionId)
    if (!connection) continue
    if (!onView.has(connection.fromId) || !onView.has(connection.toId)) {
      // Upstream a relationship view whose endpoints are not both on the view
      // draws a line into empty space.
      ctx.warn(
        `The connection "${connection.label || connectionId}" is on "${diagram.name}" but one of the shapes it ` +
          `joins is not, so it was left off that view.`,
      )
      continue
    }
    rows.push({ id: ctx.ids.wireId(connection), ...edgeGeometry(diagram, connection, transform) })
  }
  return rows
}

// ── Scope ────────────────────────────────────────────────────────────────────

/**
 * The wire id of the nearest ancestor of a shape that is a system (or a
 * container), walking the hierarchy the context already resolved.
 *
 * Strict ancestors only: a system drawn ON a container view is a neighbour, not
 * the view's scope, and matching it against itself would scope the view to an
 * arbitrary participant.
 */
function ancestorScope(
  ctx: ExportContext,
  objectId: string,
  kind: 'softwareSystem' | 'container',
): string | undefined {
  const seen = new Set<string>([objectId])
  let cursor = ctx.wireParentByObjectId.get(objectId)
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    if (isWireKind(ctx, cursor, kind)) {
      const object = ctx.objectById.get(cursor)
      return object ? ctx.ids.wireId(object) : undefined
    }
    cursor = ctx.wireParentByObjectId.get(cursor)
  }
  return undefined
}

/**
 * Is this object emitted as a `SoftwareSystem` / `Container` — on the wire, not
 * in our own hierarchy?
 *
 * `kindByObjectId` answers the C4 question and still says `container` for a
 * shape the model emitter claimed for the deployment tree. Trusting it alone is
 * how a component view ends up with `containerId` naming a `DeploymentNode`,
 * which `ViewSet.java` casts BEFORE its null check — an unchecked
 * `ClassCastException` rather than a validation message — and how a container
 * view ends up scoped to a wrapper system the model never emitted, which is
 * rule 4 and refuses to open at all.
 */
function isWireKind(ctx: ExportContext, objectId: string, kind: 'softwareSystem' | 'container'): boolean {
  if (ctx.deploymentObjectIds.has(objectId)) return false
  return ctx.kindByObjectId.get(objectId) === kind
}

/** True for a shape the model emitter will nest under the synthetic wrapper —
 *  a container whose walk tops out without meeting a system. An INSTANCE is not
 *  one, however rootless it looks here: it belongs to a deployment node. */
function belongsToWrapper(ctx: ExportContext, objectId: string): boolean {
  const object = ctx.objectById.get(objectId)
  if (!object || object.properties?.[SOURCE_INSTANCE_OF_PROPERTY] !== undefined) return false
  // A shape the model emitter puts in the deployment tree never reaches the
  // wrapper — so naming the wrapper for it produces a `softwareSystemId` that
  // resolves to nothing, and the file does not open (rule 4).
  if (ctx.deploymentObjectIds.has(objectId)) return false
  const seen = new Set<string>([objectId])
  let top = objectId
  let cursor = ctx.wireParentByObjectId.get(objectId)
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    top = cursor
    cursor = ctx.wireParentByObjectId.get(cursor)
  }
  return ctx.kindByObjectId.get(top) === 'container'
}

/** The diagram's own scope first — it is what the customer drilled into. */
function viewScope(
  ctx: ExportContext,
  diagram: Diagram,
  kind: 'softwareSystem' | 'container',
): string | undefined {
  const parentId = diagram.parentObjectId
  if (parentId !== undefined && isWireKind(ctx, parentId, kind)) {
    const parent = ctx.objectById.get(parentId)
    if (parent) return ctx.ids.wireId(parent)
  }
  for (const objectId of diagram.objectIds) {
    const scope = ancestorScope(ctx, objectId, kind)
    if (scope !== undefined) return scope
  }
  if (kind === 'softwareSystem' && diagram.objectIds.some((id) => belongsToWrapper(ctx, id))) {
    // Nothing above these shapes is a system because there is none: they are the
    // orphans the model emitter nests under the synthetic wrapper, and the
    // wrapper is a real element on the wire, so it is a real scope. The shared
    // constant, so the two emitters cannot mint one wrapper each.
    return ctx.ids.wireId({ id: SYNTHETIC_UNGROUPED_SYSTEM_ENTITY_ID })
  }
  return undefined
}

/**
 * The system a deployment view is scoped to — the one whose containers these
 * instances are instances OF.
 *
 * An instance has no parent among the shapes (its parent is a deployment node,
 * which is a group here), so walking the hierarchy from it reaches nothing and
 * would land on the synthetic wrapper. `structurizr.instanceOf` is the channel
 * the importer kept for exactly this question; without it the view comes back
 * scoped to a system that has nothing to do with it.
 */
function deploymentScope(
  ctx: ExportContext,
  byWireId: ReadonlyMap<string, C4Object>,
  diagram: Diagram,
): string | undefined {
  for (const objectId of diagram.objectIds) {
    const instanceOf = ctx.objectById.get(objectId)?.properties?.[SOURCE_INSTANCE_OF_PROPERTY]
    const instantiated = instanceOf !== undefined ? byWireId.get(instanceOf) : undefined
    if (!instantiated) continue
    const scope = isWireKind(ctx, instantiated.id, 'softwareSystem')
      ? ctx.ids.wireId(instantiated)
      : ancestorScope(ctx, instantiated.id, 'softwareSystem')
    if (scope !== undefined) return scope
  }
  // `softwareSystemId` is optional on a deployment view, and an absent scope
  // shows every instance in the environment — which is the truth here. Naming
  // the wrapper instead would scope the view to a system the customer's estate
  // does not contain.
  return undefined
}

/** Objects by the wire id they were imported with — the only way to resolve a
 *  provenance pointer (`structurizr.instanceOf`) back to a shape. */
function indexByWireId(ctx: ExportContext): Map<string, C4Object> {
  const out = new Map<string, C4Object>()
  for (const object of ctx.bundle.objects) {
    const carried = object.properties?.[SOURCE_ID_PROPERTY]?.trim()
    if (carried && !out.has(carried)) out.set(carried, object)
  }
  return out
}

/**
 * The environment a deployment diagram belongs to, from the provenance the
 * importer left on the nodes it created (and on the instances, which carry one
 * each). `undefined` means this is not a deployment diagram at all.
 */
function deploymentEnvironment(ctx: ExportContext, diagram: Diagram): string | undefined {
  const nodes = deploymentNodeGroups(ctx, diagram)
  const members = diagram.objectIds
    .map((objectId) => ctx.objectById.get(objectId))
    .filter((object): object is C4Object => object !== undefined)
  const environments = [...nodes, ...members]
    .map((entity) => entity.properties?.[ENVIRONMENT_PROPERTY]?.trim())
    .filter((environment): environment is string => Boolean(environment))
  // A childless deployment node was imported as a shape rather than a group, so
  // a deployment view can carry no node groups at all and still be one.
  if (nodes.length === 0 && environments.length === 0) return undefined

  const distinct = [...new Set(environments)]
  if (distinct.length > 1) {
    ctx.warn(
      `"${diagram.name}" mixes deployment environments (${distinct.join(', ')}); a Structurizr deployment view ` +
        `belongs to one, so it was exported as "${distinct[0]}".`,
    )
  }
  return distinct[0] ?? DEFAULT_ENVIRONMENT
}

// ── Dynamic views ────────────────────────────────────────────────────────────

function isMessageStep(step: Flow['steps'][number]): step is MessageStep {
  return step.type === 'message'
}

/**
 * One dynamic view per flow, because a flow IS an ordered interaction and a
 * dynamic view is where Structurizr keeps one.
 *
 * The diagram the flow hangs off is NOT also emitted as a static view. A dynamic
 * view re-imports as a diagram plus a flow, so emitting both would produce two
 * diagrams on the next import, then four — a round trip that grows the model is
 * not a round trip. The first flow therefore keeps the diagram's own view key,
 * which is the key the dynamic view was imported under.
 */
function dynamicViewsFor(
  ctx: ExportContext,
  diagram: Diagram,
  elements: readonly WireElementView[],
  onView: ReadonlySet<string>,
  transform: ViewTransform,
): WireDynamicView[] {
  const flows = ctx.bundle.flowsByDiagram[diagram.id] ?? []
  const built: Array<{ flow: Flow; relationships: WireRelationshipView[] }> = []
  for (const flow of flows) {
    const relationships = stepRows(ctx, diagram, flow, onView, transform)
    if (relationships.length > 0) built.push({ flow, relationships })
  }
  if (built.length === 0) return []

  const stepped = new Set(built.flatMap((entry) => entry.relationships.map((row) => row.id)))
  const undrawn = diagram.connectionIds.filter((connectionId) => {
    const connection = ctx.connectionById.get(connectionId)
    return connection !== undefined && !stepped.has(ctx.ids.wireId(connection))
  })
  if (undrawn.length > 0) {
    ctx.warn(
      `"${diagram.name}" carries a flow, so it was exported as a dynamic view — which shows only the connections ` +
        `its steps use. ${undrawn.length} other connection(s) on that diagram are not on it.`,
    )
  }
  if (built.length > 1) {
    ctx.warn(
      `"${diagram.name}" carries ${built.length} flows; each became its own dynamic view, so the same shapes appear ` +
        `on ${built.length} views upstream.`,
    )
  }

  // A dynamic view's scope is polymorphic (a system id OR a container id) and
  // the wire does not say which, so it is only stated when the diagram itself
  // was drilled into something.
  const parentId = diagram.parentObjectId
  const parent = parentId !== undefined ? ctx.objectById.get(parentId) : undefined
  const elementId =
    parent && parentId !== undefined && (isWireKind(ctx, parentId, 'softwareSystem') || isWireKind(ctx, parentId, 'container'))
      ? ctx.ids.wireId(parent)
      : undefined

  return built.map(({ flow, relationships }, index) => {
    if (index === 0 && flow.name !== diagram.name) {
      ctx.warn(
        `The diagram "${diagram.name}" is exported as the dynamic view of the flow "${flow.name}", which upstream ` +
          `carries one title; the flow's name was used.`,
      )
    }
    return {
      key: index === 0 ? ctx.ids.viewKey(diagram) : ctx.ids.viewKey({ id: flow.id, name: flow.name }),
      title: flow.name,
      ...(diagram.description ? { description: diagram.description } : {}),
      properties: { [VIEW_SCALE_PROPERTY]: String(transform.scale) },
      ...(elementId !== undefined ? { elementId } : {}),
      elements: [...elements],
      relationships,
    }
  })
}

/**
 * A flow's message steps as `relationships[]` rows.
 *
 * `order` is a STRING and it is the row's identity together with the id
 * (`RelationshipView.compareTo` is `id + "/" + order`), so two steps on one edge
 * must not share one — the reference reader's `TreeSet` would keep one and drop
 * the other before any validation fired. Numbering by emitted row guarantees it
 * and matches what the importer does with the numbers it reads.
 *
 * `response: true` says the step walks its edge BACKWARDS, and since v6.2.0 a
 * response cannot be emitted without the request it answers — so a backwards
 * step that is the first mention of its edge goes out as an ordinary step.
 */
function stepRows(
  ctx: ExportContext,
  diagram: Diagram,
  flow: Flow,
  onView: ReadonlySet<string>,
  transform: ViewTransform,
): WireRelationshipView[] {
  const skipped = flow.steps.filter((step) => !isMessageStep(step)).length
  if (skipped > 0) {
    ctx.warn(
      `${skipped} step(s) of the flow "${flow.name}" are notes rather than messages; a Structurizr dynamic view is ` +
        `made of relationships only, so they were left out.`,
    )
  }

  const messages = flow.steps
    .filter(isMessageStep)
    .map((step, index) => ({ step, index }))
    .sort((a, b) => a.step.order - b.step.order || a.index - b.index)

  const rows: WireRelationshipView[] = []
  const requested = new Set<string>()
  const routed = new Set<string>()
  for (const { step } of messages) {
    const connection = ctx.connectionById.get(step.connectionId)
    if (!connection) continue
    if (!onView.has(connection.fromId) || !onView.has(connection.toId)) continue
    const id = ctx.ids.wireId(connection)
    const backwards = step.fromObjectId === connection.toId && step.toObjectId === connection.fromId
    const response = backwards && requested.has(id)
    if (backwards && !response) {
      // A dynamic view row is drawn source → destination, always. An ordinary
      // row for a step that runs the other way is not a degraded export of that
      // step, it is a DIFFERENT interaction: a reader draws the customer's
      // "API answers User" as "User calls API". `response: true` is the only way
      // to say backwards and v6.2.0 refuses one without its request, so the step
      // is left out and named. Losing a step is recoverable; a diagram that
      // states the opposite of what the customer drew is not.
      ctx.warn(
        `Step "${step.title}" of the flow "${flow.name}" runs against its connection, but nothing in the flow uses ` +
          `that connection forwards first. A Structurizr dynamic view draws every step along its relationship, and ` +
          `refuses a response without its request, so the step was left off rather than drawn pointing the other way.`,
      )
      continue
    }
    if (!response) requested.add(id)
    // The bends belong to the edge, not to a step, so they go out once — and
    // never on a response leg, whose path runs the other way.
    const geometry = response || routed.has(id) ? {} : edgeGeometry(diagram, connection, transform)
    if (!response) routed.add(id)
    rows.push({
      id,
      order: String(rows.length + 1),
      ...(step.title ? { description: step.title } : {}),
      ...(response ? { response: true } : {}),
      ...geometry,
    })
  }
  return rows
}

// ── The view set ─────────────────────────────────────────────────────────────

export function buildWireViewSet(ctx: ExportContext): WireViewSet {
  const systemLandscapeViews: WireSystemLandscapeView[] = []
  const systemContextViews: WireSystemContextView[] = []
  const containerViews: WireContainerView[] = []
  const componentViews: WireComponentView[] = []
  const dynamicViews: WireDynamicView[] = []
  const deploymentViews: WireDeploymentView[] = []
  const byWireId = indexByWireId(ctx)

  for (const diagram of ctx.bundle.diagrams) {
    const placed = placeMembers(ctx, diagram)
    const transform = transformFor(ctx, placed)
    const elements = elementRows(ctx, diagram, placed, transform)
    const onView = new Set(placed.map((member) => member.object.id))

    const dynamic = dynamicViewsFor(ctx, diagram, elements, onView, transform)
    if (dynamic.length > 0) {
      dynamicViews.push(...dynamic)
      continue
    }

    const common = {
      key: ctx.ids.viewKey(diagram),
      title: diagram.name,
      ...(diagram.description ? { description: diagram.description } : {}),
      // The scale THIS view was written with. `views.configuration` carries the
      // default, which differs from the per-view answer on any view whose
      // biggest shape is not an application — so the one number a support
      // engineer is told to read to make sense of the coordinates was a number
      // no view had used.
      properties: { [VIEW_SCALE_PROPERTY]: String(transform.scale) },
      elements,
      relationships: relationshipRows(ctx, diagram, onView, transform),
    }

    const environment = deploymentEnvironment(ctx, diagram)
    if (environment !== undefined) {
      const softwareSystemId = deploymentScope(ctx, byWireId, diagram)
      deploymentViews.push({
        ...common,
        ...(softwareSystemId !== undefined ? { softwareSystemId } : {}),
        environment,
      })
      continue
    }

    if (diagram.type === 'component') {
      const containerId = viewScope(ctx, diagram, 'container')
      if (containerId !== undefined) {
        componentViews.push({ ...common, containerId })
        continue
      }
    }
    if (diagram.type === 'container' || diagram.type === 'component') {
      const softwareSystemId = viewScope(ctx, diagram, 'softwareSystem')
      if (softwareSystemId !== undefined) {
        if (diagram.type === 'component') {
          ctx.warn(
            `"${diagram.name}" is a component diagram, but nothing on it sits inside a container, so it was ` +
              `exported as a container view — a component view is scoped by a container id and cannot be written ` +
              `without one.`,
          )
        }
        containerViews.push({ ...common, softwareSystemId })
        continue
      }
      ctx.warn(
        `"${diagram.name}" is a ${diagram.type} diagram, but nothing on it belongs to a software system, so it was ` +
          `exported as a landscape view — Structurizr rejects a ${diagram.type} view with no scope.`,
      )
      systemLandscapeViews.push(common)
      continue
    }

    // A context diagram drilled into one system is a system context view; one
    // that is nobody's context is the landscape. Never guessed from the members:
    // on a context view every shape is a neighbour of the scope, so picking one
    // of them would scope the view to an arbitrary participant.
    const scope = diagram.parentObjectId
    const scopeObject = scope !== undefined ? ctx.objectById.get(scope) : undefined
    if (scopeObject && scope !== undefined && isWireKind(ctx, scope, 'softwareSystem')) {
      systemContextViews.push({ ...common, softwareSystemId: ctx.ids.wireId(scopeObject) })
    } else {
      systemLandscapeViews.push(common)
    }
  }

  // Only the collections that have something in them: Structurizr's own writer
  // sets NON_EMPTY, so an empty array is never on the wire.
  return {
    ...(systemLandscapeViews.length > 0 ? { systemLandscapeViews } : {}),
    ...(systemContextViews.length > 0 ? { systemContextViews } : {}),
    ...(containerViews.length > 0 ? { containerViews } : {}),
    ...(componentViews.length > 0 ? { componentViews } : {}),
    ...(dynamicViews.length > 0 ? { dynamicViews } : {}),
    ...(deploymentViews.length > 0 ? { deploymentViews } : {}),
  }
}
