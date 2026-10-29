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

import type { C4Object, Connection, Diagram, Group, Position } from '../../types'
import {
  PARENT_WRAPPER_MAX_MIN_WIDTH,
  parentWrapperBox,
  parentWrapperHeaderBand,
  type Box,
} from '../../canvas/parentWrapperBox'

/**
 * Expanding a shape IN PLACE: its linked diagram's shapes are drawn inside it,
 * under the parent-wrapper style, without leaving the diagram you are on.
 *
 * ## Why this is a view transform and not a model write
 *
 * Until now "expand" only ever navigated — `ExpandMenu` swaps
 * `currentDiagramId` and the whole canvas changes. The thing that LOOKS like an
 * expanded shape, a `Group` with `parentObjectId`, is a persisted row created
 * once when a detail diagram is created; there is no expanded/collapsed state
 * anywhere in the app.
 *
 * Writing the other diagram's shapes into this one would be the other obvious
 * design and it is the wrong one: it copies composition between diagrams, which
 * is precisely what diagram duplication avoids (see `duplicate.ts`), and it
 * would sync that copy to every peer. So this runs on the way to the ENGINE, after
 * `filterAndMergeDiagramData` and before `setData`, and nothing it produces is
 * persisted. Collapsing is dropping the entry.
 *
 * ## The five rules that make the result renderable
 *
 * 1. **The expanded shape is REPLACED by its wrapper.** A wrapper is the
 *    expanded form of an object, so drawing both would show the same thing
 *    twice. Connections in this diagram that pointed at the object are rewritten
 *    to point at the wrapper, which the engine resolves as an endpoint just as
 *    happily (`getConnectionEndpoint` reads the group map too). Without the
 *    rewrite every line into the shape would vanish.
 * 2. **External-scope shapes are left behind.** An expanded boundary is about
 *    what is INSIDE it; the outside world is already on the diagram you are
 *    looking at.
 * 3. **Shapes already on this diagram are left behind.** Two entries with one id
 *    would collide in the engine's `objectMap`/`objectIndex`, and the second
 *    would silently win.
 * 4. **The pulled shapes are translated** so the WRAPPER's box starts where the
 *    expanded shape did (its top-left corner). They carry the OTHER diagram's
 *    coordinates, which have no relationship to this one's — untranslated, an
 *    expansion lands on top of whatever happens to occupy those coordinates
 *    here. The anchor is the box and not the shapes because the box extends
 *    past them on every side (`parentWrapperBox`): anchoring the shapes put the
 *    border and header over whatever sat just left of and above the host.
 * 5. **Room is made for the block.** The block is its true size (e.g. ~860×460
 *    of containers in place of a 200×100 system), so the rest of the diagram is
 *    pushed out of its way, as inserting columns and rows in a spreadsheet
 *    would: everything whose left edge is at or past the host's right edge moves
 *    right by the extra width, everything whose top edge is at or past the
 *    host's bottom edge moves down by the extra height (both, for a shape below
 *    and to the right). Applied to shapes, positioned groups (a stored box the
 *    cut passes through grows instead, `shiftBox`), connection waypoints and —
 *    through `shiftPoint`, by the caller — comment pins. Every gap between
 *    shapes only grows and the order on each axis is kept, so a displaced shape
 *    never lands on another one, and whatever shape still touches the wrapper
 *    was already touching the host. Nested expansions make room INSIDE their outer
 *    block the same way, before the outer block's size is known, so the outer
 *    block makes room for its final size.
 *
 * ## Writing back through a displaced view
 *
 * The displaced coordinates are the view's, never the model's. EVERY write
 * taken from this canvas — a drag or resize, a waypoint edit, a drop from the
 * palette, a new or moved comment, a group size read off the engine — is in
 * VIEW coordinates, so the caller maps it back (`unshiftPoint`, `unshiftBox`
 * with `result.cuts`) before writing. A shape then stays where it was dropped
 * once the view is recomputed (on the same side of every cut, that is its model
 * position + the drag) — unless it was dropped inside the gap a cut opened,
 * which has no model coordinate of its own and snaps to the cut. Shapes and
 * edges PULLED IN are not this diagram's to place: their edits are dropped.
 *
 * ## Where the other diagram's coordinates come from
 *
 * NOT from the diagram index. A diagram that is not the active one is a STUB
 * there (`metaToStubDiagram`): composition, no `layouts`. Placement lives in
 * that diagram's own DiagramDoc, which nothing has loaded. Planning from the
 * stub drops every shape to its model-level position — and an import leaves
 * those all equal, so the whole block was drawn on one point (2026-10-15: eleven
 * containers at (223,280), only the top one visible). The caller reads the
 * placement and hands it in through `lookup.layouts`.
 */

export interface InlineExpansion {
  /** The shape being expanded, on the diagram currently being drawn. */
  objectId: string
  /** The diagram whose shapes are pulled in. */
  diagramId: string
}

export interface DiagramContents {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
}

export type SkippedReason =
  /** The target is the diagram we are drawing, or one already expanded here. */
  | 'cycle'
  /** No such diagram, or the shape is not on this diagram. */
  | 'missing'
  /** Nothing left to show once external and already-present shapes are dropped. */
  | 'empty'
  /** The target's placement has not been read yet; the shape stays a shape. */
  | 'pending'

/**
 * One make-room step on the diagram being drawn (rule 5): every coordinate at or
 * past `atX` moved right by `byX`, every one at or past `atY` down by `byY`. In
 * the coordinates as they stood when it was applied, i.e. after the cuts before
 * it.
 */
export interface MakeRoomCut {
  atX: number
  byX: number
  atY: number
  byY: number
}

export interface InlineExpansionResult extends DiagramContents {
  /** Every expansion that produced nothing, and why. Never silent. */
  skipped: Array<{ objectId: string; reason: SkippedReason }>
  /** The make-room steps applied to this diagram's own items, in order. */
  cuts: MakeRoomCut[]
}

type Layouts = NonNullable<Diagram['layouts']>

export interface ExpansionLookup {
  diagram: (id: string) => Diagram | undefined
  object: (id: string) => C4Object | undefined
  connection: (id: string) => Connection | undefined
  /**
   * The target diagram's edges as it draws them: its own AND the derived
   * (`kind: 'lower'`) ones, which are computed for a render and never listed
   * in a diagram's stored `connectionIds` — so the stub misses them, and on a
   * Structurizr import (a relationship declared between components, drawn
   * between their containers) they are most of a container view's edges.
   * `undefined` (or omitted): the stub's `connectionIds`.
   */
  connectionIds?: (diagramId: string) => readonly string[] | undefined
  /**
   * Where the target diagram's members sit, read from that diagram's own
   * document (see the module header for why the stub cannot answer):
   *  - a record — the arrangement the user made over there;
   *  - `null` — it could not be read (offline, document never synced here):
   *    the shapes go on a grid, because the alternative is a pile;
   *  - `undefined` — not read YET: the expansion waits (`'pending'`).
   * Omitted, `target.layouts` is used as given.
   */
  layouts?: (diagramId: string) => Layouts | null | undefined
  /**
   * The narrowest box the engine will draw this wrapper at (its header text is
   * measured on a canvas: `CanvasEngine.inlineWrapperMinWidth`). Omitted, the
   * largest it can be is assumed — more room than needed, never less.
   */
  wrapperMinWidth?: (wrapper: Group) => number
}

/** Stable and derived, so the same expansion yields the same group id twice. */
export function inlineWrapperId(objectId: string): string {
  return `inline-expand:${objectId}`
}

/** Where `point` is drawn once `cuts` are applied (rule 5). */
export function shiftPoint(cuts: readonly MakeRoomCut[], point: Position): Position {
  let { x, y } = point
  for (const cut of cuts) {
    if (x >= cut.atX) x += cut.byX
    if (y >= cut.atY) y += cut.byY
  }
  return { x, y }
}

/**
 * The model coordinate of a point drawn at `point` through `cuts`: the inverse
 * of `shiftPoint`, undone last cut first. A point inside the gap a cut opened
 * has no preimage; it maps to the cut line, which `shiftPoint` draws at the
 * far side of the gap.
 */
export function unshiftPoint(cuts: readonly MakeRoomCut[], point: Position): Position {
  let { x, y } = point
  for (let index = cuts.length - 1; index >= 0; index--) {
    const cut = cuts[index]
    if (x >= cut.atX + cut.byX) x -= cut.byX
    else if (x >= cut.atX) x = cut.atX
    if (y >= cut.atY + cut.byY) y -= cut.byY
    else if (y >= cut.atY) y = cut.atY
  }
  return { x, y }
}

/**
 * Where a BOX with stored geometry (a manually sized group) is drawn once
 * `cuts` are applied. Its top-left moves as a point does; a box a cut passes
 * THROUGH grows by the cut's width instead of staying behind — a spreadsheet
 * range spanning an inserted column widens — so the members pushed past the
 * cut stay inside it.
 */
export function shiftBox(cuts: readonly MakeRoomCut[], box: Box): Box {
  let { x, y, width, height } = box
  for (const cut of cuts) {
    if (x >= cut.atX) x += cut.byX
    else if (x + width > cut.atX) width += cut.byX
    if (y >= cut.atY) y += cut.byY
    else if (y + height > cut.atY) height += cut.byY
  }
  return { x, y, width, height }
}

/**
 * The model geometry of a box drawn at `box` through `cuts`: the inverse of
 * `shiftBox`, edge by edge (a far edge inside an opened gap maps to the cut).
 */
export function unshiftBox(cuts: readonly MakeRoomCut[], box: Box): Box {
  const topLeft = unshiftPoint(cuts, box)
  let right = box.x + box.width
  let bottom = box.y + box.height
  for (let index = cuts.length - 1; index >= 0; index--) {
    const cut = cuts[index]
    if (right > cut.atX + cut.byX) right -= cut.byX
    else if (right > cut.atX) right = cut.atX
    if (bottom > cut.atY + cut.byY) bottom -= cut.byY
    else if (bottom > cut.atY) bottom = cut.atY
  }
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.max(0, right - topLeft.x),
    height: Math.max(0, bottom - topLeft.y),
  }
}

/**
 * A placement commit the engine reported (drag, resize), mapped into the MODEL
 * frame: positions through `unshiftPoint`, a group carrying a size through
 * `unshiftBox`, and anything in `viewOnly` (shapes and wrappers an expansion
 * pulled in) dropped — those are not this diagram's to place.
 */
export function viewPlacementsToModel<
  O extends { id: string; position: Position },
  G extends { id: string; position?: Position; size?: { width: number; height: number } },
>(
  cuts: readonly MakeRoomCut[],
  viewOnly: ReadonlySet<string>,
  updates: { objects: readonly O[]; groups: readonly G[] },
): { objects: O[]; groups: G[] } {
  return {
    objects: updates.objects
      .filter((update) => !viewOnly.has(update.id))
      .map((update) => (cuts.length === 0 ? update : { ...update, position: unshiftPoint(cuts, update.position) })),
    groups: updates.groups
      .filter((update) => !viewOnly.has(update.id))
      .map((update) => {
        if (cuts.length === 0 || !update.position) return update
        if (!update.size) return { ...update, position: unshiftPoint(cuts, update.position) }
        const box = unshiftBox(cuts, { ...update.position, ...update.size })
        return { ...update, position: { x: box.x, y: box.y }, size: { width: box.width, height: box.height } }
      }),
  }
}

/**
 * Which cuts a placement commit must be undone with.
 *
 * Not always the current ones: while a drag or resize is under the pointer the
 * engine keeps that shape where the pointer put it across any `setData`
 * (`preserveActivePlacementPreview`), so if the view is re-planned mid-gesture —
 * the target's placement read lands, a peer moves the host — the shape is still
 * in the frame the gesture STARTED in, and undoing it with the new cuts would
 * store the difference. Told about every re-plan, this keeps the frame the
 * gesture began under and hands it to THAT gesture's commit. Keyed by the
 * engine's gesture id, so a gesture that ended without a commit (pressed,
 * re-planned, released in place) cannot leak its frame into the next one.
 */
export class GestureCutsLatch {
  private latched: { gesture: number; cuts: MakeRoomCut[] } | null = null

  /** Called on every re-plan, BEFORE the new cuts are adopted. */
  replanned(previousCuts: MakeRoomCut[], activeGesture: number | null): void {
    if (activeGesture === null) this.latched = null
    else if (this.latched?.gesture !== activeGesture) this.latched = { gesture: activeGesture, cuts: previousCuts }
  }

  /** The cuts the commit of `activeGesture` was drawn under; the latch is released. */
  forCommit(currentCuts: MakeRoomCut[], activeGesture: number | null): MakeRoomCut[] {
    const cuts = this.latched && this.latched.gesture === activeGesture ? this.latched.cuts : currentCuts
    this.latched = null
    return cuts
  }
}

/** A connection's edited waypoints in the MODEL frame; `null` when the edge was
 *  pulled in by an expansion and the edit must be dropped. */
export function viewWaypointsToModel(
  cuts: readonly MakeRoomCut[],
  viewOnly: ReadonlySet<string>,
  connectionId: string,
  waypoints: readonly Position[],
): Position[] | null {
  if (viewOnly.has(connectionId)) return null
  return waypoints.map((point) => unshiftPoint(cuts, point))
}

/** Comment pins as DRAWN: moved with everything else past a cut. */
export function modelCommentsToView<C extends { position: Position }>(cuts: readonly MakeRoomCut[], comments: readonly C[]): C[] {
  return cuts.length === 0
    ? [...comments]
    : comments.map((comment) => ({ ...comment, position: shiftPoint(cuts, comment.position) }))
}

/** Space between grid cells when the target's own arrangement is unknown. */
const GRID_GAP = 40

/** A near-square grid, every cell as large as the largest shape: distinct and
 *  non-overlapping by construction. Only for an arrangement we cannot read. */
function gridPlacement(objects: readonly C4Object[]): C4Object[] {
  const columns = Math.ceil(Math.sqrt(objects.length))
  const cellWidth = Math.max(...objects.map((object) => object.size.width)) + GRID_GAP
  const cellHeight = Math.max(...objects.map((object) => object.size.height)) + GRID_GAP
  return objects.map((object, index) => ({
    ...object,
    position: { x: (index % columns) * cellWidth, y: Math.floor(index / columns) * cellHeight },
  }))
}

/** One applied expansion: its shapes, its edges, and the blocks nested in it. */
interface Block {
  expansion: InlineExpansion
  wrapper: Group
  /** Ids in the order the target lists them; a nested host stays in this list. */
  memberIds: string[]
  /** Our own copies: positions are rewritten freely. Hosts are removed once replaced. */
  shapes: C4Object[]
  /** Pulled edges, waypoints copied: they move with the block. */
  connections: Connection[]
  /** Every edge of the target, before we know which ends are drawn. */
  candidates: Connection[]
  /** Whether the target's placement was read (waypoints mean something). */
  placed: boolean
  parent: Block | null
  children: Block[]
  /** The wrapper's box, once laid out. */
  box: Box
}

/** What a make-room step acts on, at one level (the diagram, or one block). */
interface Level {
  shapes: C4Object[]
  blocks: Block[]
  points: Position[]
  groups: Group[]
}

const boxOf = (object: C4Object): Box => ({
  x: object.position.x, y: object.position.y, width: object.size.width, height: object.size.height,
})

function translateBlock(block: Block, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return
  block.box = { ...block.box, x: block.box.x + dx, y: block.box.y + dy }
  for (const shape of block.shapes) {
    shape.position = { x: shape.position.x + dx, y: shape.position.y + dy }
  }
  // In place: a level being laid out holds these very points.
  for (const connection of block.connections) {
    for (const point of connection.waypoints ?? []) {
      point.x += dx
      point.y += dy
    }
  }
  for (const child of block.children) translateBlock(child, dx, dy)
}

/** Rule 5 at one level: push everything past the host's edges out of the way. */
function makeRoom(level: Level, host: Box, size: { width: number; height: number }): MakeRoomCut {
  const cut: MakeRoomCut = {
    atX: host.x + host.width,
    byX: Math.max(0, size.width - host.width),
    atY: host.y + host.height,
    byY: Math.max(0, size.height - host.height),
  }
  if (cut.byX === 0 && cut.byY === 0) return cut
  const shift = (p: Position) => ({ dx: p.x >= cut.atX ? cut.byX : 0, dy: p.y >= cut.atY ? cut.byY : 0 })
  for (const shape of level.shapes) {
    const { dx, dy } = shift(shape.position)
    shape.position = { x: shape.position.x + dx, y: shape.position.y + dy }
  }
  for (const block of level.blocks) {
    const { dx, dy } = shift(block.box)
    translateBlock(block, dx, dy)
  }
  for (const point of level.points) {
    const { dx, dy } = shift(point)
    point.x += dx
    point.y += dy
  }
  for (const group of level.groups) {
    if (!group.position) continue
    const box = shiftBox([cut], {
      x: group.position.x, y: group.position.y,
      width: group.size?.width ?? 0, height: group.size?.height ?? 0,
    })
    group.position = { x: box.x, y: box.y }
    if (group.size) group.size = { width: box.width, height: box.height }
  }
  return cut
}

/**
 * Lay `children` into `level`, each at its host's place, making room for each.
 * In reading order (top to bottom, then left to right): each one's room is made
 * on the coordinates the previous ones left, so the order is a choice, and a
 * stable one is better than the order the store happens to hold the entries in.
 */
function placeChildren(
  level: Level,
  children: readonly Block[],
  layout: (block: Block) => void,
): MakeRoomCut[] {
  const cuts: MakeRoomCut[] = []
  const hostOf = (block: Block) => level.shapes.find((shape) => shape.id === block.expansion.objectId)!
  const ordered = [...children].sort((a, b) => {
    const pa = hostOf(a).position
    const pb = hostOf(b).position
    return pa.y - pb.y || pa.x - pb.x || (a.expansion.objectId < b.expansion.objectId ? -1 : 1)
  })
  for (const child of ordered) {
    // Read now, not before the loop: an earlier sibling's room may have moved it.
    const host = hostOf(child)
    layout(child)
    cuts.push(makeRoom({ ...level, shapes: level.shapes.filter((shape) => shape !== host) }, boxOf(host), child.box))
    translateBlock(child, host.position.x - child.box.x, host.position.y - child.box.y)
    level.shapes.splice(level.shapes.indexOf(host), 1)
    level.blocks.push(child)
  }
  return cuts
}

/**
 * Apply `expansions` to a diagram's already-filtered contents.
 *
 * Expansions NEST: a shape pulled in by one expansion is itself expandable, so
 * each entry is applied once its host is on the canvas, whatever order the
 * entries are listed in. `visited` is what stops A→B→A — a diagram already
 * drawn here (the current one included) is refused as a `'cycle'`.
 *
 * Two phases: which shapes each expansion pulls in (first applied wins a shape
 * two of them would pull), then the geometry, inside out — an inner block's size
 * is needed before its outer block can make room for it, and the outer block's
 * final size before the diagram can.
 */
export function expandDiagramsInline(
  base: DiagramContents,
  currentDiagramId: string | null,
  expansions: readonly InlineExpansion[],
  lookup: ExpansionLookup,
): InlineExpansionResult {
  if (expansions.length === 0) {
    return { ...base, skipped: [], cuts: [] }
  }

  const skipped: InlineExpansionResult['skipped'] = []
  const visited = new Set<string>(currentDiagramId ? [currentDiagramId] : [])
  const presentObjectIds = new Set(base.objects.map((object) => object.id))
  const presentConnectionIds = new Set(base.connections.map((connection) => connection.id))
  /** Every shape drawn so far and the block it is in (`null`: the diagram itself). */
  const drawnIn = new Map<string, Block | null>(base.objects.map((object) => [object.id, null]))
  /** objectId -> the block that replaced it. */
  const replacedBy = new Map<string, Block>()
  /** Applied blocks, in the order they were applied (the draw order). */
  const applied: Block[] = []
  const roots: Block[] = []

  // ── Phase 1: what each expansion pulls in ─────────────────────────────────
  const resolve = (expansion: InlineExpansion, host: C4Object, parent: Block | null): void => {
    const target = lookup.diagram(expansion.diagramId)
    if (!target) {
      skipped.push({ objectId: expansion.objectId, reason: 'missing' })
      return
    }
    if (visited.has(expansion.diagramId)) {
      skipped.push({ objectId: expansion.objectId, reason: 'cycle' })
      return
    }
    const layouts = lookup.layouts ? lookup.layouts(expansion.diagramId) : target.layouts
    if (layouts === undefined && lookup.layouts) {
      skipped.push({ objectId: expansion.objectId, reason: 'pending' })
      return
    }

    const pulled = target.objectIds
      .map((id) => lookup.object(id))
      .filter((object): object is C4Object => !!object)
      .filter((object) => object.scope !== 'external')
      .filter((object) => !presentObjectIds.has(object.id))
    if (pulled.length === 0) {
      skipped.push({ objectId: expansion.objectId, reason: 'empty' })
      return
    }
    visited.add(expansion.diagramId)

    // The other diagram's own relative arrangement. `layouts` is the
    // per-diagram override, and it is the position the user actually arranged
    // over there. Our own copies: the geometry phase rewrites them in place.
    const placed = (layouts === null
      ? gridPlacement(pulled)
      : pulled.map((object) => {
        const layout = layouts?.[object.id]
        return layout ? { ...object, position: layout.position, size: layout.size } : object
      })
    ).map((object) => ({ ...object, position: { ...object.position }, size: { ...object.size } }))

    // The target's relationships, sorted out once every block is resolved (the
    // edge post-pass below): which of their ends are drawn depends on the other
    // expansions too. The membership is the caller's when it has one — under
    // boot-from-server the stub's `connectionIds` never lists the derived
    // (lower) edges, and on an import those are most of a container view's edges.
    const candidates: Connection[] = []
    for (const connectionId of lookup.connectionIds?.(expansion.diagramId) ?? target.connectionIds) {
      const connection = lookup.connection(connectionId)
      if (connection) candidates.push(connection)
    }

    const block: Block = {
      expansion,
      wrapper: {
        id: inlineWrapperId(host.id),
        // What makes the renderer draw this in the expanded-shape style. See
        // `renderGroup`'s `isParentWrapper`.
        parentObjectId: host.id,
        name: host.name,
        description: host.shortDescription,
        type: host.type.charAt(0).toUpperCase() + host.type.slice(1),
        icon: host.icon,
        iconAssignment: host.iconAssignment,
        color: '#EFEDE9',
        objectIds: [],
        tagAssignments: {},
        tagOrder: [],
      } as Group,
      memberIds: placed.map((object) => object.id),
      shapes: placed,
      connections: [],
      candidates,
      placed: layouts !== null,
      parent,
      children: [],
      box: { x: 0, y: 0, width: 0, height: 0 },
    }
    for (const object of placed) {
      presentObjectIds.add(object.id)
      drawnIn.set(object.id, block)
    }
    replacedBy.set(host.id, block)
    applied.push(block)
    if (parent) parent.children.push(block)
    else roots.push(block)
  }

  // Each pass applies every entry whose host is on the canvas by now; a nested
  // entry waits for the pass after the one that pulled its host in. Stops when a
  // pass places nothing, so it terminates however the entries are ordered.
  let waiting = [...expansions]
  for (let progressed = true; progressed && waiting.length > 0;) {
    progressed = false
    const stillWaiting: InlineExpansion[] = []
    for (const expansion of waiting) {
      const parent = drawnIn.get(expansion.objectId)
      const host = replacedBy.has(expansion.objectId) || parent === undefined
        ? undefined
        : (parent ? parent.shapes : base.objects).find((object) => object.id === expansion.objectId)
      if (!host) {
        stillWaiting.push(expansion)
        continue
      }
      resolve(expansion, host, parent ?? null)
      progressed = true
    }
    waiting = stillWaiting
  }
  for (const expansion of waiting) {
    skipped.push({ objectId: expansion.objectId, reason: 'missing' })
  }

  /** `id` is drawn inside `block`, at any depth. */
  const inside = (id: string, block: Block): boolean => {
    for (let at = drawnIn.get(id) ?? null; at; at = at.parent) if (at === block) return true
    return false
  }
  /** `id` is `end`, or is drawn inside the block `end` was expanded into. */
  const standsFor = (id: string, end: string): boolean => {
    const block = replacedBy.get(end)
    return id === end || (!!block && inside(id, block))
  }

  // ── The edges each block draws ────────────────────────────────────────────
  // A target edge comes when one end is in THIS block and the other is drawn
  // anywhere — in the block, in another block, or on the diagram itself
  // (Payment Service -> Stripe, Stripe being on the context diagram). Leaving
  // out the outward ones drew an expanded boundary whose contents connect to
  // nothing. An end not drawn here leaves its edge behind. Applied order: the
  // first block to draw an edge keeps it.
  //
  // Roll-ups are matched by their two ends, not their id: the store held them
  // under generated ids until 2026-10-22, while a render names the same pair
  // `lower:<from>→<to>` — one id-only dedupe drew every roll-up twice (architect
  // and reviewer lenses, 2026-10-16). Both sides now use that id; matching by
  // the pair stays correct and does not depend on it.
  const lowerPair = (connection: Connection) => `${connection.fromId}→${connection.toId}`
  const presentLowerPairs = new Set(base.connections.filter((c) => c.kind === 'lower').map(lowerPair))
  for (const block of applied) {
    for (const connection of block.candidates) {
      if (presentConnectionIds.has(connection.id)) continue
      if (connection.kind === 'lower' && presentLowerPairs.has(lowerPair(connection))) continue
      const fromHere = drawnIn.get(connection.fromId) === block
      const toHere = drawnIn.get(connection.toId) === block
      if (!fromHere && !toHere) continue
      if (!drawnIn.has(connection.fromId) || !drawnIn.has(connection.toId)) continue
      // An edge between a host and what is drawn inside its own wrapper would
      // be a line from the wrapper's contents to the wrapper.
      if (standsFor(connection.toId, connection.fromId) || standsFor(connection.fromId, connection.toId)) continue
      presentConnectionIds.add(connection.id)
      if (connection.kind === 'lower') presentLowerPairs.add(lowerPair(connection))
      const { waypoints, ...rest } = connection
      // Waypoints are in the target's frame and move with the block: they mean
      // something only for an edge wholly inside it, over a placement read
      // from the target (over a grid they do not).
      block.connections.push(
        waypoints && fromHere && toHere && block.placed ? { ...rest, waypoints: waypoints.map((p) => ({ ...p })) } : rest,
      )
    }
  }

  if (applied.length === 0) {
    return { ...base, skipped, cuts: [] }
  }

  /** A block's ids with each nested host swapped for what replaced it —
   *  recursively, so an outer wrapper encloses a nested block rather than a
   *  vanished shape. */
  const resolveMembers = (ids: readonly string[]): string[] =>
    ids.flatMap((id) => {
      const inner = replacedBy.get(id)
      return inner ? resolveMembers(inner.memberIds) : [id]
    })

  // ── Phase 2: the geometry, inside out ─────────────────────────────────────
  /** Lay a block out in its own frame and set its box: room made for its
   *  nested blocks first, then its wrapper drawn around everything in it. */
  const layoutBlock = (block: Block): void => {
    const level: Level = {
      shapes: block.shapes,
      blocks: [],
      points: block.connections.flatMap((connection) => connection.waypoints ?? []),
      groups: [],
    }
    placeChildren(level, block.children, layoutBlock)
    block.wrapper = {
      ...block.wrapper,
      objectIds: resolveMembers(block.memberIds),
      ...(block.children.length > 0 ? { innerWrapperIds: block.children.map((child) => child.wrapper.id) } : {}),
    }
    const minWidth = lookup.wrapperMinWidth?.(block.wrapper) ?? PARENT_WRAPPER_MAX_MIN_WIDTH
    // The same box the engine will draw (`computeGroupBounds`), from the same
    // contents: its shapes and the boxes of the wrappers nested in it.
    block.box = parentWrapperBox(
      [...level.shapes.map(boxOf), ...level.blocks.map((child) => child.box)],
      parentWrapperHeaderBand(block.wrapper),
      minWidth,
    )!
  }

  // Our own copies of the diagram's items: the cuts rewrite them in place.
  const baseLevel: Level = {
    shapes: base.objects.map((object) => ({ ...object, position: { ...object.position } })),
    blocks: [],
    points: [],
    groups: base.groups.map((group) => ({ ...group })),
  }
  const baseConnections = base.connections.map((connection) => {
    if (!connection.waypoints) return connection
    const waypoints = connection.waypoints.map((p) => ({ ...p }))
    baseLevel.points.push(...waypoints)
    return { ...connection, waypoints }
  })
  const cuts = placeChildren(baseLevel, roots, layoutBlock)

  const rewrite = (connection: Connection): Connection => {
    const from = replacedBy.get(connection.fromId)
    const to = replacedBy.get(connection.toId)
    if (!from && !to) return connection
    return {
      ...connection,
      fromId: from ? from.wrapper.id : connection.fromId,
      toId: to ? to.wrapper.id : connection.toId,
    }
  }
  // A roll-up onto an expanded shape is KEPT, on its wrapper, even when the
  // block draws a finer edge between the same two ends: a roll-up may summarise
  // several relationships, some through members the target view leaves out, and
  // the edges drawn cannot prove they cover all of it (architect and reviewer
  // lenses, 2026-10-16 — dropping it lost Customer -> Web Portal when Web Portal
  // was not on the containers view).
  return {
    // The host shapes are gone: their wrapper IS them, expanded.
    objects: [...baseLevel.shapes, ...applied.flatMap((block) => block.shapes)],
    connections: [...baseConnections, ...applied.flatMap((block) => block.connections)].map(rewrite),
    // A persisted group's membership is not this view transform's to rewrite;
    // only its position moves, with everything else past the cut.
    groups: [...baseLevel.groups, ...applied.map((block) => block.wrapper)],
    skipped,
    cuts,
  }
}

/**
 * The entries that collapsing `objectId` leaves without a host — the
 * expansions NESTED inside it, at any depth.
 *
 * They are dropped with it rather than kept. Kept, each one was reported
 * `'missing'` on every render, its target was still loaded and watched for
 * nothing, and re-expanding the outer shape silently reopened a tree the user
 * had just closed.
 *
 * Reachability is by COMPOSITION (`membersOf`, the diagram index's stubs carry
 * it), not by what was drawn: the planner pulls a subset of a target's members,
 * so this keeps an entry whenever its host COULD still be on the canvas. It
 * errs towards keeping, never towards dropping something visible — which is
 * also why an UNKNOWN membership (a target the index has no stub for, e.g.
 * offline and cold) drops nothing beyond the collapsed entry: any host could
 * be sitting in the unknown target, including one inside the collapsed entry
 * too, so no orphan can be proven. The leftovers go once the index knows
 * (`unreachableExpansions`, which the canvas re-runs on every index change).
 */
export function expansionsOrphanedByCollapse(
  objectId: string,
  expansions: Readonly<Record<string, string>>,
  baseObjectIds: Iterable<string>,
  membersOf: (diagramId: string) => readonly string[] | undefined,
): string[] {
  const { [objectId]: _collapsed, ...remaining } = expansions
  return unreachableExpansions(remaining, baseObjectIds, membersOf)
}

/**
 * The entries whose host can no longer be on the canvas — by any route, not
 * only a collapse: the host deleted, removed from this diagram, or removed from
 * the target that pulled it in. Same rules as `expansionsOrphanedByCollapse`:
 * reachability by composition, and nothing when a membership is unknown.
 */
export function unreachableExpansions(
  expansions: Readonly<Record<string, string>>,
  baseObjectIds: Iterable<string>,
  membersOf: (diagramId: string) => readonly string[] | undefined,
): string[] {
  const remaining = Object.entries(expansions)
  const reachable = new Set(baseObjectIds)
  const applied = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const [host, diagramId] of remaining) {
      if (applied.has(host) || !reachable.has(host)) continue
      const members = membersOf(diagramId)
      if (!members) return []
      applied.add(host)
      grew = true
      for (const member of members) reachable.add(member)
    }
  }
  return remaining.filter(([host]) => !applied.has(host)).map(([host]) => host)
}
