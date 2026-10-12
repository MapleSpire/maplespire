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
 * Per-view layout policy: trust the coordinates in the file, or lay the view out
 * ourselves?
 *
 * Both answers have a catastrophic failure mode. Re-laying-out a hand-arranged
 * view throws away work the customer did by hand; trusting an un-laid-out view
 * imports `big-bank-plc.json` as 67 shapes stacked on the origin. So the
 * decision is made per VIEW, from the coordinates themselves, and never from
 * `automaticLayout`:
 *
 *  - `automaticLayout.applied` was REMOVED in v6.0.0 (§2, T11) and cannot exist
 *    in a current file, so nothing may be built on it.
 *  - The presence of `automaticLayout` does not mean the coordinates are junk
 *    either: `deployment-positioned.json` carries one AND 10/10 real
 *    coordinates. [MEASURED]
 *
 * What the coordinates themselves say (T10, re-measured against the fixtures in
 * `../fixtures/json/`):
 *
 *  | fixture                      | element views | on the origin | verdict   |
 *  | big-bank-plc.json            | 67            | 67            | lay out   |
 *  | groups.json                  | 10            | 10            | lay out   |
 *  | views-without-order.json     | 2             | 2 (x/y absent)| lay out   |
 *  | deployment-positioned.json   | 10            | 0             | preserve  |
 *  | big-real-workspace.json      | 60            | 21            | preserve  |
 *
 * The last row is the one that forbids a naive "any zero means no layout" rule:
 * all 21 zeros are `deploymentNode`s and every positioned element in those same
 * views is an instance. In a laid-out view `(0,0)` is not a position at all — it
 * marks an element whose box is DERIVED from what it contains. So the rule is
 * applied to leaves only, and boundaries at the origin are handed back to the
 * caller to size from their children.
 */

import type { Position, Size } from '../../../types'
import type { SzElementKind, SzElementView, SzView } from './types'

/**
 * The box structurizr-ui draws for an element that matched no style (§7.4).
 * Java leaves `width`/`height` null — these numbers exist only in the renderer,
 * and the renderer is what the customer looked at, so it is what we scale
 * against.
 */
export const STRUCTURIZR_DEFAULT_ELEMENT_SIZE: Size = { width: 450, height: 300 }

/**
 * An element's part in the picture.
 *
 * `boundary` means "this box is drawn around other boxes, so its geometry comes
 * from them" — a deployment node, or the element a view is scoped to when the
 * producer lists it among the view's own elements (nl-wallet does; big-bank does
 * not). Everything else is a leaf and must carry its own coordinate.
 */
export type ElementRole = 'leaf' | 'boundary'

const EMPTY_IDS: ReadonlySet<string> = new Set<string>()

export interface PlacedElement {
  id: string
  role: ElementRole
  /** Wire coordinates, top-left, unscaled. */
  x: number
  y: number
}

export interface ViewPlacements {
  /** Elements whose wire coordinate is a real position (either role). */
  positioned: PlacedElement[]
  /** Boundary elements on the origin: size these from their children, do not move them there. */
  derivedBoundaries: string[]
  /** Leaves with no usable coordinate. The caller must place these itself. */
  unpositioned: string[]
}

/** A style's resolved size inputs — the subset of `SzElementStyle` that decides the box. */
export interface ResolvedStyleSize {
  width?: number
  height?: number
}

function isRealDimension(value: number | undefined): value is number {
  // Sub-pixel and non-finite sizes come from producers that emit `0` or `null`
  // for "unset"; dividing by one of those yields an infinite scale factor.
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
}

/**
 * The box the customer saw for one element, from its resolved `ElementStyle`.
 *
 * `resolveElementStyle` has ALREADY applied the renderer's post-processing —
 * the Person/Robot 400x400 rewrite and the MobileDevice orientation swaps — so
 * a resolved style's `width`/`height` ARE the drawn box, and re-deriving them
 * from the shape name here was a second, divergable copy of `styles.ts` that no
 * production call could ever reach. What is left is the fallback for a caller
 * holding a partial style, or none at all.
 */
export function structurizrSizeFor(style?: ResolvedStyleSize): Size {
  const width = isRealDimension(style?.width) ? style.width : undefined
  const height = isRealDimension(style?.height) ? style.height : undefined
  if (width === undefined && height === undefined) return { ...STRUCTURIZR_DEFAULT_ELEMENT_SIZE }
  return {
    width: width ?? STRUCTURIZR_DEFAULT_ELEMENT_SIZE.width,
    height: height ?? STRUCTURIZR_DEFAULT_ELEMENT_SIZE.height,
  }
}

/**
 * `null` when the element carries no position.
 *
 * `0` is a real number on the wire and Java cannot tell it from absent (§6.3),
 * so `(0,0)` is never read as a position — for a boundary it means "derive me",
 * for a leaf it means "nobody placed me". Reading it literally is what stacks a
 * diagram on the origin.
 */
function wireCoordinate(element: SzElementView): Position | null {
  const x = typeof element.x === 'number' && Number.isFinite(element.x) ? element.x : 0
  const y = typeof element.y === 'number' && Number.isFinite(element.y) ? element.y : 0
  if (x === 0 && y === 0) return null
  return { x, y }
}

export function elementRole(
  view: SzView,
  elementId: string,
  kindById: ReadonlyMap<string, SzElementKind>,
  drawnAsShape: ReadonlySet<string> = EMPTY_IDS,
): ElementRole {
  // A deployment node is a container box, even when the view happens to list
  // none of its children: in structurizr-ui it is drawn as a boundary, and its
  // stored coordinate (when it has one) is that boundary's top-left, not a
  // shape's. `drawnAsShape` is the caller's escape hatch for the one case where
  // that is false — a node with NOTHING under it wraps nothing, so it is a plain
  // box and its coordinate is a shape's. An id missing from `kindById` is a
  // dangling reference (§4.4) — call it a leaf, because claiming boundary would
  // silently drop it from the layout.
  if (drawnAsShape.has(elementId)) return 'leaf'
  if (kindById.get(elementId) === 'deploymentNode') return 'boundary'
  if (view.scopeId !== undefined && elementId === view.scopeId) return 'boundary'
  return 'leaf'
}

/** Split a view's elements into "carries a position", "derive from children" and "we must place it". */
export function positionedElements(
  view: SzView,
  kindById: ReadonlyMap<string, SzElementKind>,
  drawnAsShape: ReadonlySet<string> = EMPTY_IDS,
): ViewPlacements {
  const positioned: PlacedElement[] = []
  const derivedBoundaries: string[] = []
  const unpositioned: string[] = []
  for (const element of view.elements) {
    const role = elementRole(view, element.id, kindById, drawnAsShape)
    const at = wireCoordinate(element)
    if (at) positioned.push({ id: element.id, role, x: at.x, y: at.y })
    else if (role === 'boundary') derivedBoundaries.push(element.id)
    else unpositioned.push(element.id)
  }
  return { positioned, derivedBoundaries, unpositioned }
}

/**
 * The discriminator: does this view carry a layout worth preserving?
 *
 * Judged on LEAVES only, by strict majority. Two failure modes bound the choice:
 * "all leaves must be positioned" re-lays-out a whole hand-arranged view because
 * one shape was left on the origin, and "any positioned element counts" stacks
 * 29 shapes on the origin because one stray was dragged. A majority answers both,
 * and because `planViewLayout` reports the leftovers rather than dumping them at
 * the origin, being wrong at the margin costs a few shapes, not the diagram.
 *
 * A view whose elements are ALL boundaries (a deployment view of bare nodes) has
 * no leaves to count, so it falls back to "did anything carry a coordinate".
 */
export function viewHasSavedLayout(
  view: SzView,
  kindById: ReadonlyMap<string, SzElementKind>,
  drawnAsShape: ReadonlySet<string> = EMPTY_IDS,
): boolean {
  const { positioned, unpositioned } = positionedElements(view, kindById, drawnAsShape)
  const positionedLeaves = positioned.filter((p) => p.role === 'leaf').length
  const leaves = positionedLeaves + unpositioned.length
  if (leaves === 0) return positioned.length > 0
  return positionedLeaves * 2 > leaves
}

/**
 * One uniform scale for a whole view: how far apart our boxes must sit to keep
 * the arrangement the customer had.
 *
 * Structurizr's renderer draws an unstyled element 450x300; ours is ~185x100
 * (`SIZE_BY_TYPE`, `../mapper.ts`). Copying x/y verbatim therefore leaves gaps
 * ~2.4x wider than the shapes and the diagram reads as scattered. A single
 * factor — a similarity transform — is what preserves the arrangement exactly:
 * per-axis factors would keep rows and columns but shear every diagonal
 * alignment, and per-element factors would destroy alignment outright.
 *
 * The factor is the MAXIMUM of every (ours / theirs) ratio, over both axes and
 * every element. Taking the max means each element's scaled slot is at least as
 * big as the box we will draw in it, on both axes, so nothing that was not
 * overlapping can start to overlap. The cost is that one oddly small styled
 * element spreads the whole view out — sprawl, which zoom-to-fit undoes, is
 * chosen deliberately over overlap, which the customer has to fix by hand.
 */
export function scaleFactorFor(pairs: Iterable<{ source: Size; target: Size }>): number {
  let scale = 0
  for (const { source, target } of pairs) {
    if (isRealDimension(source.width) && isRealDimension(target.width)) {
      scale = Math.max(scale, target.width / source.width)
    }
    if (isRealDimension(source.height) && isRealDimension(target.height)) {
      scale = Math.max(scale, target.height / source.height)
    }
  }
  // Nothing measurable (an empty view, or sizes we could not read): copy the
  // coordinates through unchanged rather than collapsing them onto each other.
  return scale > 0 && Number.isFinite(scale) ? scale : 1
}

export interface LayoutPlanOptions {
  /** Our box for an element — `SIZE_BY_TYPE` in `../mapper.ts`, via the caller's kind mapping. */
  targetSizeFor: (elementId: string) => Size
  /** The element's resolved `ElementStyle` box. Defaults to the renderer's 450x300 seed. */
  sourceSizeFor?: (elementId: string) => Size
  /** Where the preserved arrangement's top-left lands. Pure translation; defaults to (0,0). */
  origin?: Position
  /** Elements the caller draws as a plain shape even though `kindById` calls
   *  them a boundary — see `elementRole`. */
  drawnAsShape?: ReadonlySet<string>
}

export interface PreservedLayout {
  kind: 'preserved'
  scale: number
  /** The wire coordinate that lands on `origin`. Together with `scale` this is
   *  the whole similarity transform, and anything else read off the same view in
   *  WIRE space — an edge's hand-placed vertices, above all — has to go through
   *  it too, or the line detaches from the shapes it joins. */
  sourceOrigin: Position
  origin: Position
  /** Leaves only — a boundary's size is its children's business, so we never invent one. */
  layouts: Record<string, { position: Position; size: Size }>
  /** Leaves the file never placed. The caller must place them around the preserved ones. */
  unpositionedIds: string[]
}

export type ViewLayoutPlan = { kind: 'auto'; reason: string } | PreservedLayout

/** Put a point stored in WIRE coordinates through a preserved view's transform. */
export function projectWirePoint(plan: PreservedLayout, point: Position): Position {
  return {
    x: Math.round(plan.origin.x + (point.x - plan.sourceOrigin.x) * plan.scale),
    y: Math.round(plan.origin.y + (point.y - plan.sourceOrigin.y) * plan.scale),
  }
}

/**
 * Turn one view's wire coordinates into MapleSpire `layouts`, or say that the
 * view has to be laid out from scratch.
 *
 * Both formats store the TOP-LEFT corner — Structurizr per §6.3 (`maximumX =
 * elementView.getX() + style.getWidth()`), MapleSpire per `CanvasEngine`'s hit
 * test (`x >= obj.position.x && x <= obj.position.x + obj.size.width`) — so
 * there is no centre/corner conversion to do. If either side ever moves to
 * centres, every shape here shifts by half a box.
 */
export function planViewLayout(
  view: SzView,
  kindById: ReadonlyMap<string, SzElementKind>,
  options: LayoutPlanOptions,
): ViewLayoutPlan {
  const drawnAsShape = options.drawnAsShape ?? EMPTY_IDS
  const placements = positionedElements(view, kindById, drawnAsShape)
  if (view.elements.length === 0) {
    return { kind: 'auto', reason: 'the view has no elements' }
  }
  if (!viewHasSavedLayout(view, kindById, drawnAsShape)) {
    const onOrigin = placements.unpositioned.length + placements.derivedBoundaries.length
    return {
      kind: 'auto',
      reason: `${onOrigin} of ${view.elements.length} elements sit on the origin, so no layout was ever computed`,
    }
  }

  const sourceSizeFor = options.sourceSizeFor ?? (() => ({ ...STRUCTURIZR_DEFAULT_ELEMENT_SIZE }))
  // Boundaries are excluded from the scale: their drawn box wraps their children
  // and bears no relation to the shape size we would compare it against. A view
  // that is nothing but boundaries has to use them anyway.
  const leafIds = [
    ...placements.positioned.filter((p) => p.role === 'leaf').map((p) => p.id),
    ...placements.unpositioned,
  ]
  const measured = leafIds.length > 0 ? leafIds : view.elements.map((e) => e.id)
  const scale = scaleFactorFor(
    measured.map((id) => ({ source: sourceSizeFor(id), target: options.targetSizeFor(id) })),
  )

  // Translate the arrangement to `origin` from the top-left of what was actually
  // placed. Boundaries on the origin are excluded: their zero is a marker, and
  // letting it pin the minimum would drag the whole diagram right and down.
  const originX = options.origin?.x ?? 0
  const originY = options.origin?.y ?? 0
  const minX = Math.min(...placements.positioned.map((p) => p.x))
  const minY = Math.min(...placements.positioned.map((p) => p.y))
  const project = (p: PlacedElement): Position => ({
    x: Math.round(originX + (p.x - minX) * scale),
    y: Math.round(originY + (p.y - minY) * scale),
  })

  const layouts: Record<string, { position: Position; size: Size }> = {}
  for (const placed of placements.positioned) {
    // A boundary's box is derived from what it contains (§13.3), so its own
    // stored top-left is deliberately not turned into a layout here.
    if (placed.role === 'boundary') continue
    layouts[placed.id] = { position: project(placed), size: options.targetSizeFor(placed.id) }
  }

  return {
    kind: 'preserved',
    scale,
    sourceOrigin: { x: minX, y: minY },
    origin: { x: originX, y: originY },
    layouts,
    unpositionedIds: placements.unpositioned,
  }
}
