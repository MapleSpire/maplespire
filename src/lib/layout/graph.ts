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

// Shared layout helpers used by BOTH the custom engine path (index.ts) and the
// ELK path (elk/). Kept separate to avoid an index↔elk import cycle.
//
// - buildLayoutGraph: the diagram's object nodes + the *effective* edge set
//   (declared connections among visible nodes, plus connections rolled up to a
//   visible ancestor — mirrors runtime lower-connections).
// - measureLaidOut: score a set of placed boxes + styled edges using the FAITHFUL
//   canvas geometry (so metrics see the same curves the canvas draws).

import type { C4Object, Connection, Diagram, Group, Position, Size } from '../../types'
import type { LayoutEdgeInput, LayoutNodeInput } from './engine'
import {
  connectionGeometry,
  pathPointAt,
  pathTangentAt,
  polylineLength,
  type Box,
  type CubicSeg,
  type EdgeStyle,
  type LineShape,
  type Pt,
} from './geometry'
import {
  computeMetrics,
  groupHeaderBandHeight,
  headerBandRect,
  headerTextWidth,
  labelRect,
  rectsOverlap,
  segmentIntersectsRect,
  type BoundaryBox,
  type EdgeGeom,
  type LayoutMetrics,
  type Rect,
} from './metrics'

/** A per-connection style patch produced by a layout (applied to the model). */
export interface ConnPatch {
  waypoints?: Pt[]
  fromAnchor?: number
  toAnchor?: number
  lockedToAnchors?: boolean
  shape?: LineShape
  /** De-collided label placement (t along path, perpendicular offset) so the canvas
   * draws the label where the layout scored it clear of other labels/nodes. */
  labelPosition?: number
  labelOffset?: number
}

/** A full layout candidate for one diagram (from ELK or the custom engine). */
export interface LayoutSolution {
  /** Strategy id (e.g. 'ortho-ns-down') or 'custom'. */
  source: string
  layouts: Record<string, { position: Position; size: Size }>
  /** real connection id → style patch. */
  connPatches: Record<string, ConnPatch>
  edgeGeoms: EdgeGeom[]
  metrics: LayoutMetrics
}

export interface LayoutContext {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
}

export interface EffectiveEdge extends LayoutEdgeInput {
  /** True when `id` is a real Connection id (so styling can be written back). */
  real: boolean
}

/** A placed + styled edge ready for faithful measurement / rendering. */
export interface LaidEdge {
  id: string
  fromId: string
  toId: string
  real: boolean
  waypoints?: Pt[]
  shape?: LineShape
  fromAnchor?: number
  toAnchor?: number
  lockedToAnchors?: boolean
}

// ── graph complexity + disconnected-field handling ───────────────────────────

/** Structural profile of one diagram's layout graph — computed BEFORE layout so the
 * ELK parameters (and the isolated-node handling) adapt to what they're laying out
 * instead of one-size-fits-all. */
export interface GraphComplexity {
  nodeCount: number
  edgeCount: number
  /** Degree-0 nodes — no effective edge touches them. */
  isolatedCount: number
  /** Connected components among the non-isolated nodes. */
  componentCount: number
  maxDegree: number
  /** Effective edges per CONNECTED node (wiring density). */
  density: number
}

export function analyzeGraphComplexity(nodes: LayoutNodeInput[], edges: LayoutEdgeInput[]): GraphComplexity {
  const degree = new Map<string, number>()
  for (const n of nodes) degree.set(n.id, 0)
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (e.fromId === e.toId || !degree.has(e.fromId) || !degree.has(e.toId)) continue
    degree.set(e.fromId, degree.get(e.fromId)! + 1)
    degree.set(e.toId, degree.get(e.toId)! + 1)
    ;(adj.get(e.fromId) ?? adj.set(e.fromId, []).get(e.fromId)!).push(e.toId)
    ;(adj.get(e.toId) ?? adj.set(e.toId, []).get(e.toId)!).push(e.fromId)
  }
  let isolatedCount = 0
  let maxDegree = 0
  for (const d of degree.values()) {
    if (d === 0) isolatedCount++
    maxDegree = Math.max(maxDegree, d)
  }
  // BFS component count over non-isolated nodes.
  let componentCount = 0
  const seen = new Set<string>()
  for (const n of nodes) {
    if (degree.get(n.id) === 0 || seen.has(n.id)) continue
    componentCount++
    const queue = [n.id]
    seen.add(n.id)
    while (queue.length) {
      const cur = queue.pop()!
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb)
          queue.push(nb)
        }
      }
    }
  }
  const connectedCount = nodes.length - isolatedCount
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    isolatedCount,
    componentCount,
    maxDegree,
    density: connectedCount > 0 ? Math.round((edges.length / connectedCount) * 100) / 100 : 0,
  }
}

/**
 * Split a diagram's nodes into the CONNECTED subgraph (fed to the layered engine)
 * and the ISOLATED field (degree-0 nodes, packed into a grid afterwards). Nodes in
 * `keepIds` (members of any on-diagram group) are never extracted even at degree 0:
 * group boxes are derived from member positions, so pulling a member into the grid
 * would drag its group's box over the field.
 *
 * Why: both engines string degree-0 nodes into one long trailing row, so a diagram
 * with a large unconnected population (e.g. a component gallery) lays out as an
 * unusable ~8:1 sliver. ELK's component packing does NOT fix this — measured on a
 * 60-node/31-edge view, every combination of separateConnectedComponents /
 * model-order / wrapping options still rowed the singletons (aspect 7.5–9). A
 * deterministic aspect-aware grid below the wired content is both readable and
 * perfectly aligned.
 */
export function splitIsolatedNodes(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  keepIds: Set<string>,
): { connected: LayoutNodeInput[]; isolated: LayoutNodeInput[] } {
  const degree = new Map<string, number>()
  for (const n of nodes) degree.set(n.id, 0)
  for (const e of edges) {
    if (e.fromId === e.toId) continue
    if (degree.has(e.fromId)) degree.set(e.fromId, degree.get(e.fromId)! + 1)
    if (degree.has(e.toId)) degree.set(e.toId, degree.get(e.toId)! + 1)
  }
  const connected: LayoutNodeInput[] = []
  const isolated: LayoutNodeInput[] = []
  for (const n of nodes) {
    if (degree.get(n.id) === 0 && !keepIds.has(n.id)) isolated.push(n)
    else connected.push(n)
  }
  return { connected, isolated }
}

/** Union bounding box over any number of box maps (null when all empty). */
export function contentBounds(...maps: Array<Map<string, Box>>): Box | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const m of maps) {
    for (const b of m.values()) {
      x0 = Math.min(x0, b.x)
      y0 = Math.min(y0, b.y)
      x1 = Math.max(x1, b.x + b.width)
      y1 = Math.max(y1, b.y + b.height)
    }
  }
  if (!Number.isFinite(x0)) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// Grid cell gaps for the isolated field (match the root nodeNode spacing feel) and
// the clear corridor between the wired content and the field below it.
const GRID_GAP_X = 40
const GRID_GAP_Y = 40
const ISOLATED_FIELD_GAP = 80
/** The aspect the packed page aims for — same target as `elk.aspectRatio`. */
const TARGET_ASPECT = 1.6

/**
 * Pack the isolated nodes into a uniform-cell grid placed BELOW the laid-out
 * content (`bounds`, or at the origin when there is none), writing their boxes into
 * `out`. The column count is chosen so the OVERALL page (content + gap + grid)
 * lands as close as possible to the 1.6 target aspect — never a one-row sliver.
 * Uniform cells mean every row and column shares exact axes (aligned by
 * construction).
 */
export function packIsolatedBelow(
  isolated: LayoutNodeInput[],
  bounds: Box | null,
  out: Map<string, Box>,
): void {
  if (isolated.length === 0) return
  const cellW = Math.max(...isolated.map((n) => n.width))
  const cellH = Math.max(...isolated.map((n) => n.height))
  const count = isolated.length
  const gridW = (c: number) => c * cellW + (c - 1) * GRID_GAP_X
  const gridH = (c: number) => {
    const rows = Math.ceil(count / c)
    return rows * cellH + (rows - 1) * GRID_GAP_Y
  }
  let cols = 1
  let bestDelta = Infinity
  for (let c = 1; c <= count; c++) {
    const w = bounds ? Math.max(bounds.width, gridW(c)) : gridW(c)
    const h = bounds ? bounds.height + ISOLATED_FIELD_GAP + gridH(c) : gridH(c)
    const delta = Math.abs(w / h - TARGET_ASPECT)
    if (delta < bestDelta - 1e-9) {
      bestDelta = delta
      cols = c
    }
  }
  const x0 = bounds ? bounds.x : 24
  const y0 = (bounds ? bounds.y + bounds.height + ISOLATED_FIELD_GAP : 24)
  isolated.forEach((n, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    out.set(n.id, {
      x: Math.round(x0 + col * (cellW + GRID_GAP_X) + (cellW - n.width) / 2),
      y: Math.round(y0 + row * (cellH + GRID_GAP_Y) + (cellH - n.height) / 2),
      width: n.width,
      height: n.height,
    })
  })
}

/**
 * Snap nearly-aligned boxes onto shared axes: row centres within `threshold` px of
 * each other collapse to their mean (then the same for column centres). Fixes the
 * "shapes are not aligned when they could be" defect — near-miss rows/columns from
 * balanced placement or mixed node heights land on ONE crisp axis.
 *
 * Guard rails: a cluster only snaps when its total spread is within `threshold`
 * (no chain drift), only boxes in the same `zoneOf` partition snap together (a
 * boundary member can't be dragged toward an outside row — zones are the compound
 * id or root), and a whole axis pass is reverted if it introduces any new overlap.
 */
export function snapAlignBoxes(
  boxes: Map<string, Box>,
  zoneOf: (id: string) => string,
  threshold = 10,
): void {
  const overlapCount = (): number => {
    const list = [...boxes.values()]
    let n = 0
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) n++
      }
    }
    return n
  }

  for (const axis of ['y', 'x'] as const) {
    const before = overlapCount()
    const saved = new Map<string, number>()
    const entries = [...boxes.entries()]
      .map(([id, b]) => ({ id, b, c: axis === 'y' ? b.y + b.height / 2 : b.x + b.width / 2, zone: zoneOf(id) }))
      .sort((p, q) => p.c - q.c || (p.id < q.id ? -1 : 1))
    let i = 0
    while (i < entries.length) {
      // Grow a same-zone cluster while the TOTAL spread stays within the threshold.
      let j = i + 1
      while (
        j < entries.length &&
        entries[j].zone === entries[i].zone &&
        entries[j].c - entries[i].c <= threshold
      ) j++
      if (j - i >= 2) {
        const cluster = entries.slice(i, j)
        const mean = Math.round(cluster.reduce((s, e) => s + e.c, 0) / cluster.length)
        for (const e of cluster) {
          if (axis === 'y') {
            saved.set(e.id, e.b.y)
            e.b.y = Math.round(mean - e.b.height / 2)
          } else {
            saved.set(e.id, e.b.x)
            e.b.x = Math.round(mean - e.b.width / 2)
          }
        }
      }
      i = j
    }
    if (saved.size && overlapCount() > before) {
      // The snap collided something — revert this axis pass entirely.
      for (const [id, v] of saved) {
        const b = boxes.get(id)!
        if (axis === 'y') b.y = v
        else b.x = v
      }
    }
  }
}

export function buildLayoutGraph(
  diagram: Diagram,
  objectById: Map<string, C4Object>,
  groups: Group[],
  connections: Connection[],
): { nodes: LayoutNodeInput[]; edges: EffectiveEdge[] } {
  const nodeSet = new Set(diagram.objectIds.filter((id) => objectById.has(id)))

  // Map each object to a boundary/group it belongs to on this diagram (clustering).
  const groupOf = new Map<string, string>()
  for (const gid of diagram.groupIds) {
    const g = groups.find((x) => x.id === gid)
    if (!g) continue
    for (const oid of g.objectIds) {
      if (nodeSet.has(oid) && !groupOf.has(oid)) groupOf.set(oid, gid)
    }
  }

  const nodes: LayoutNodeInput[] = []
  for (const id of nodeSet) {
    const o = objectById.get(id)!
    nodes.push({ id, width: o.size.width, height: o.size.height, groupId: groupOf.get(id) })
  }

  const visible = (objId: string): string | null => {
    let cur: string | undefined = objId
    const guard = new Set<string>()
    while (cur && !nodeSet.has(cur)) {
      if (guard.has(cur)) return null
      guard.add(cur)
      cur = objectById.get(cur)?.parentId
    }
    return cur && nodeSet.has(cur) ? cur : null
  }

  const edges: EffectiveEdge[] = []
  const pairSeen = new Map<string, number>()
  for (const c of connections) {
    const vf = visible(c.fromId)
    const vt = visible(c.toId)
    if (!vf || !vt || vf === vt) continue
    const real = vf === c.fromId && vt === c.toId
    const key = `${vf}→${vt}`
    const existing = pairSeen.get(key)
    if (existing != null) {
      if (real && !edges[existing].real) edges[existing] = { id: c.id, fromId: vf, toId: vt, real: true }
      continue
    }
    pairSeen.set(key, edges.length)
    edges.push({ id: real ? c.id : `implied:${c.id}`, fromId: vf, toId: vt, real })
  }

  return { nodes, edges }
}

/**
 * Obstacle-avoiding routing on the FAITHFUL curved geometry: returns intermediate
 * waypoints so the drawn curve between `style`'s endpoints clears every obstacle
 * node (not the two endpoints). Tries the direct curve first, then a single
 * perpendicular bend at growing offsets on both sides.
 */
export function repairRoute(
  fromBox: Box,
  toBox: Box,
  style: EdgeStyle,
  obstacles: Rect[],
  softZones: Rect[] = [],
): Pt[] {
  const shrunk = obstacles
    .map((r) => ({ id: r.id, x: r.x + 2, y: r.y + 2, width: r.width - 4, height: r.height - 4 }))
    .filter((r) => r.width > 0 && r.height > 0)
  const clipCountOf = (pl: Pt[]): number => {
    const hit = new Set<string>()
    for (let k = 0; k + 1 < pl.length; k++) {
      for (const r of shrunk) if (!hit.has(r.id) && segmentIntersectsRect(pl[k], pl[k + 1], r)) hit.add(r.id)
    }
    return hit.size
  }
  // Soft zones (e.g. a boundary's bottom description band) aren't hard obstacles — an
  // edge may pass through them — but a detour that avoids them reads cleaner (the
  // description stays legible). Counted as a tie-breaker AFTER clip-freedom + bounds,
  // BEFORE length, so we never fail to route but prefer routes clear of the text.
  const softHitsOf = (pl: Pt[]): number => {
    let n = 0
    for (const z of softZones) {
      for (let k = 0; k + 1 < pl.length; k++) {
        if (segmentIntersectsRect(pl[k], pl[k + 1], z)) {
          n++
          break
        }
      }
    }
    return n
  }
  const poly = (wps: Pt[]) => connectionGeometry(fromBox, toBox, { ...style, waypoints: wps }).polyline

  const directPoly = poly([])
  // The straight route wins outright only when it clears BOTH hard obstacles AND the
  // soft text zones (group titles / description bands). If it's clip-free but cuts
  // through a group's title or description text, fall through to the candidate search:
  // a gentle detour clear of the text is preferred, and the straight route still
  // competes (added as the empty-waypoint candidate below) so it wins back when no
  // clean detour exists — routing never fails.
  if (clipCountOf(directPoly) === 0 && softHitsOf(directPoly) === 0) return []

  const g0 = connectionGeometry(fromBox, toBox, { ...style, waypoints: [] })
  const a = g0.fromEdge
  const b = g0.toEdge
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const at = (t: number): Pt => ({ x: a.x + dx * t, y: a.y + dy * t })
  const offsets = [40, 70, 100, 140, 190, 250, 320, 400]
  const round = (p: Pt): Pt => ({ x: Math.round(p.x), y: Math.round(p.y) })
  // Per-waypoint penalty (px) added to a candidate's length when ranking clip-free
  // routes: a route with an extra bend must be at least this much shorter to win, so a
  // gentle one-bend detour beats a marginally-shorter two-bend "channel". Kills the
  // "connections more complex than they should be" defect — the layout prefers the
  // straightest route that still clears every obstacle. Tuned: < a typical edge length
  // so it never overrides clearing a real obstacle (clip-freedom is gated first).
  const WAYPOINT_PENALTY = 70

  // Obstacles geometrically RELEVANT to this edge: those near the corridor between
  // its endpoints. A node on the far side of the diagram (e.g. an external sitting
  // bottom-left while this edge runs top-right) must not influence routing — if it
  // did, "route around the whole field" and the content-bounds test would both stretch
  // to enclose it, producing an absurd swoop down/around the distant node. We expand
  // the endpoints' bbox by a margin and keep only obstacles that intersect it.
  const RX0 = Math.min(fromBox.x, toBox.x) - 80
  const RY0 = Math.min(fromBox.y, toBox.y) - 80
  const RX1 = Math.max(fromBox.x + fromBox.width, toBox.x + toBox.width) + 80
  const RY1 = Math.max(fromBox.y + fromBox.height, toBox.y + toBox.height) + 80
  const relevant = obstacles.filter(
    (r) => r.x < RX1 && r.x + r.width > RX0 && r.y < RY1 && r.y + r.height > RY0,
  )

  // Content bounds = bbox of the relevant nodes (+ the two endpoints). A detour whose
  // drawn curve stays within this box (plus a small margin) reads as "routed around the
  // boxes"; one that escapes it is the "edge flies off the canvas and re-enters" defect.
  // We prefer in-bounds routes.
  let bx0 = Math.min(fromBox.x, toBox.x)
  let by0 = Math.min(fromBox.y, toBox.y)
  let bx1 = Math.max(fromBox.x + fromBox.width, toBox.x + toBox.width)
  let by1 = Math.max(fromBox.y + fromBox.height, toBox.y + toBox.height)
  for (const r of relevant) {
    bx0 = Math.min(bx0, r.x)
    by0 = Math.min(by0, r.y)
    bx1 = Math.max(bx1, r.x + r.width)
    by1 = Math.max(by1, r.y + r.height)
  }
  const M = 60
  const polyInBounds = (pl: Pt[]): boolean =>
    pl.every((p) => p.x >= bx0 - M && p.x <= bx1 + M && p.y >= by0 - M && p.y <= by1 + M)

  // The straight route competes too: we only reach here when it grazes a soft text zone
  // (it's clip-free), so it stays the fallback the ranking returns to when no detour
  // clears the text more cleanly at acceptable cost.
  const candidates: Pt[][] = [[]]

  // Which obstacles does the direct curve actually hit? Used both for targeted
  // corner detours and to route around the whole blocking *cluster* (a column of
  // stacked boxes can't be cleared by one perpendicular bend without a huge — often
  // off-canvas — offset; going around the cluster's near edge keeps the route tight).
  const blocking = shrunk.filter((r) => {
    for (let k = 0; k + 1 < directPoly.length; k++) {
      if (segmentIntersectsRect(directPoly[k], directPoly[k + 1], r)) return true
    }
    return false
  })

  // Targeted detours around each blocking node's corners / sides.
  const C = 26
  for (const r of blocking) {
    const L = r.x - C
    const R = r.x + r.width + C
    const T = r.y - C
    const B = r.y + r.height + C
    const tl = { x: L, y: T }
    const tr = { x: R, y: T }
    const bl = { x: L, y: B }
    const br = { x: R, y: B }
    candidates.push([tl], [tr], [bl], [br], [tl, tr], [bl, br], [tl, bl], [tr, br])
  }

  // Route around the whole blocking cluster: hug just past its top/bottom (for a
  // roughly-horizontal edge) or left/right (for a vertical one) so the curve clears
  // every box in the column at once, staying near the content instead of arcing far.
  if (blocking.length) {
    let ox0 = Infinity
    let oy0 = Infinity
    let ox1 = -Infinity
    let oy1 = -Infinity
    for (const r of blocking) {
      ox0 = Math.min(ox0, r.x)
      oy0 = Math.min(oy0, r.y)
      ox1 = Math.max(ox1, r.x + r.width)
      oy1 = Math.max(oy1, r.y + r.height)
    }
    const G = 28
    const topY = oy0 - G
    const botY = oy1 + G
    const leftX = ox0 - G
    const rightX = ox1 + G
    const mid = at(0.5)
    // Two-waypoint "go up/over and back down" (and the vertical analogues).
    candidates.push([{ x: a.x, y: topY }, { x: b.x, y: topY }])
    candidates.push([{ x: a.x, y: botY }, { x: b.x, y: botY }])
    candidates.push([{ x: leftX, y: a.y }, { x: leftX, y: b.y }])
    candidates.push([{ x: rightX, y: a.y }, { x: rightX, y: b.y }])
    // Single-waypoint version (cheaper curve) past each near edge.
    candidates.push([{ x: mid.x, y: topY }], [{ x: mid.x, y: botY }])
    candidates.push([{ x: leftX, y: mid.y }], [{ x: rightX, y: mid.y }])
  }

  // Route around the whole RELEVANT obstacle field (bbox of the near-corridor nodes,
  // not just the boxes the direct line hits). Going around the blocking *subset* often
  // clips a neighbour that wasn't in the subset (dense grids box every node in on all
  // sides), leaving only enormous perpendicular offsets that escape the canvas as the
  // sole clip-free routes. A path that clears the relevant field's near edge is clip-free
  // by construction (nothing relevant lies above the field's top, etc.) and stays in
  // content bounds, so a cross-cluster edge hugs the inside of the drawing instead of
  // arcing off it. Using `relevant` (not all obstacles) keeps the loop from detouring
  // around a distant node. (Only wins when no shorter detour is clean: selection still
  // prefers the shortest in-bounds clip-free route.)
  if (relevant.length) {
    let fx0 = Infinity
    let fy0 = Infinity
    let fx1 = -Infinity
    let fy1 = -Infinity
    for (const r of relevant) {
      fx0 = Math.min(fx0, r.x)
      fy0 = Math.min(fy0, r.y)
      fx1 = Math.max(fx1, r.x + r.width)
      fy1 = Math.max(fy1, r.y + r.height)
    }
    const G = 28
    const fTop = fy0 - G
    const fBot = fy1 + G
    const fLeft = fx0 - G
    const fRight = fx1 + G
    const mid = at(0.5)
    // The riser/descender that leaves `from` (and enters `to`) must rise in a CLEAR
    // corridor — the anchor x often hugs the box's own column (clipping a stacked
    // neighbour), so we also try just past either side of each endpoint box. One of the
    // combinations threads the gap between columns (rise), runs above/below the field,
    // then drops past the grid (descend). Same idea rotated 90° for the L/R detours.
    const xsA = [a.x, fromBox.x - G, fromBox.x + fromBox.width + G]
    const xsB = [b.x, toBox.x - G, toBox.x + toBox.width + G]
    const ysA = [a.y, fromBox.y - G, fromBox.y + fromBox.height + G]
    const ysB = [b.y, toBox.y - G, toBox.y + toBox.height + G]
    for (const xa of xsA) {
      for (const xb of xsB) {
        candidates.push([{ x: xa, y: fTop }, { x: xb, y: fTop }])
        candidates.push([{ x: xa, y: fBot }, { x: xb, y: fBot }])
      }
    }
    for (const ya of ysA) {
      for (const yb of ysB) {
        candidates.push([{ x: fLeft, y: ya }, { x: fLeft, y: yb }])
        candidates.push([{ x: fRight, y: ya }, { x: fRight, y: yb }])
      }
    }
    // Single-waypoint versions (cheaper curve) for the easy cases.
    candidates.push([{ x: mid.x, y: fTop }], [{ x: mid.x, y: fBot }])
    candidates.push([{ x: fLeft, y: mid.y }], [{ x: fRight, y: mid.y }])
  }

  // Single perpendicular bend at several positions.
  for (const t of [0.5, 0.4, 0.6, 0.3, 0.7]) {
    for (const off of offsets) {
      for (const side of [1, -1]) {
        const m = at(t)
        candidates.push([{ x: m.x + nx * off * side, y: m.y + ny * off * side }])
      }
    }
  }
  // Two-bend "channel" detours (shift the middle out and back).
  for (const off of offsets) {
    for (const side of [1, -1]) {
      const p1 = at(0.28)
      const p2 = at(0.72)
      candidates.push([
        { x: p1.x + nx * off * side, y: p1.y + ny * off * side },
        { x: p2.x + nx * off * side, y: p2.y + ny * off * side },
      ])
    }
  }

  // Selection priority:
  //   1. clip-free route that stays IN content bounds, ranked by (softZone hits,
  //      length) — among in-bounds clip-free routes, prefer the one that grazes the
  //      fewest soft zones (group description bands), then the shortest,
  //   2. else shortest clip-free route (better a long detour than cutting a node),
  //   3. else the fewest-clip route.
  // (1) before (2) is what kills the off-canvas arcs: a tight in-bounds detour is
  // preferred even when a marginally shorter route would escape the canvas. The
  // soft-zone tie-break keeps a detour from diving through a group's bottom
  // description band when an equally-good route sits clear of it.
  // `cost` = drawn length + WAYPOINT_PENALTY per bend, so among equally-clean routes a
  // gentle one-bend detour beats a marginally-shorter two-bend channel (defect #1:
  // "connections more complex than they should be"). softHits stays the FIRST key, so
  // adding the penalty never re-opens the description-band masking the soft zones fixed.
  let best: Pt[] = []
  let bestClips = clipCountOf(directPoly)
  let zeroIn: Pt[] | null = null
  let zeroInSoft = Infinity
  let zeroInCost = Infinity
  let zeroAny: Pt[] | null = null
  let zeroAnyCost = Infinity
  for (const c of candidates) {
    const pl = poly(c)
    const n = clipCountOf(pl)
    if (n === 0) {
      const cost = polylineLength(pl) + WAYPOINT_PENALTY * c.length
      if (cost < zeroAnyCost) {
        zeroAnyCost = cost
        zeroAny = c
      }
      if (polyInBounds(pl)) {
        const s = softHitsOf(pl)
        if (s < zeroInSoft || (s === zeroInSoft && cost < zeroInCost)) {
          zeroInSoft = s
          zeroInCost = cost
          zeroIn = c
        }
      }
      continue
    }
    if (n < bestClips) {
      bestClips = n
      best = c
    }
  }
  return (zeroIn ?? zeroAny ?? best).map(round)
}

/** Boundary groups (system/container) on a diagram, with their on-diagram members. */
export function boundaryGroupsOf(
  diagram: Diagram,
  groups: Group[],
  nodeSet: Set<string>,
): Array<{ id: string; memberIds: string[] }> {
  const out: Array<{ id: string; memberIds: string[] }> = []
  for (const gid of diagram.groupIds) {
    const g = groups.find((x) => x.id === gid)
    if (!g || !g.parentObjectId) continue
    const memberIds = g.objectIds.filter((id) => nodeSet.has(id))
    if (memberIds.length > 0) out.push({ id: gid, memberIds })
  }
  return out
}

/** A faithful, de-collided edge-label placement. */
export interface LabelPlacement {
  /** Box CENTRE (faithful: pathPoint(t) + normal·offset) where the label is drawn. */
  at: Pt
  /** `labelPosition` (t along the path) to persist on the connection. */
  t: number
  /** `labelOffset` (perpendicular, within the canvas ±40 clamp) to persist. */
  offset: number
}

// Candidate (t, offset) placements, ordered default-first then by increasing
// deviation. Offsets stay inside the canvas ±40 clamp. Sliding t spreads the labels
// of near-parallel edges along their own paths (the dominant collision on dense
// hubs); the perpendicular offset nudges a label off a neighbour or off a node.
const LABEL_TS = [0.5, 0.42, 0.58, 0.36, 0.64, 0.3, 0.7, 0.25, 0.75]
const LABEL_OFFSETS = [12, -12, 22, -22, 32, -32]

/**
 * Deterministic edge-label de-collision. For each labelled edge it picks the
 * (labelPosition, labelOffset) whose faithful label box (centre = pathPoint(t) +
 * normal·offset) least collides with already-placed labels, with nodes, and with the
 * `avoid` zones (boundary description bands), preferring the canvas default (0.5, 12).
 *
 * Run at the single `measureLaidOut` chokepoint so the metric, the SVG preview, and
 * the connection patches written to the model all see the SAME label positions —
 * pixels == numbers == canvas. Order-independent: edges are processed sorted by id.
 */
export function placeLabels(
  items: Array<{ id: string; segments: CubicSeg[]; label: string }>,
  nodeRects: Rect[],
  avoid: Rect[] = [],
): Map<string, LabelPlacement> {
  const out = new Map<string, LabelPlacement>()
  const placed: Rect[] = []
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const it of sorted) {
    if (it.segments.length === 0 || !it.label) continue
    let bestPl: LabelPlacement | null = null
    let bestPenalty = Infinity
    let bestDev = Infinity
    for (let ti = 0; ti < LABEL_TS.length; ti++) {
      const t = LABEL_TS[ti]
      const pt = pathPointAt(it.segments, t)
      const tan = pathTangentAt(it.segments, t)
      const nx = -tan.y
      const ny = tan.x
      for (let oi = 0; oi < LABEL_OFFSETS.length; oi++) {
        const off = LABEL_OFFSETS[oi]
        const c = { x: pt.x + nx * off, y: pt.y + ny * off }
        const box = labelRect(it.id, c, it.label)
        let penalty = 0
        for (const p of placed) if (rectsOverlap(box, p)) penalty += 100
        for (const r of nodeRects) if (rectsOverlap(box, r)) penalty += 40
        for (const z of avoid) if (rectsOverlap(box, z)) penalty += 25
        const dev = ti + oi
        if (penalty < bestPenalty || (penalty === bestPenalty && dev < bestDev)) {
          bestPenalty = penalty
          bestDev = dev
          bestPl = { at: c, t, offset: off }
        }
      }
    }
    if (bestPl) {
      out.set(it.id, bestPl)
      placed.push(labelRect(it.id, bestPl.at, it.label))
    }
  }
  return out
}

/**
 * Faithful measurement: build the real canvas geometry for each edge, place its label
 * (de-collided), and score it. `objectBoxes` are the object rectangles (the only ones
 * counted for node overlap); edges carry their styling (waypoints/anchors/shape).
 *
 * Returns `labelPlacements` (real edge id → {t, offset}) so the ELK / custom layout
 * paths can persist the de-collided label positions onto the connections — the SVG
 * preview and the canvas then draw labels exactly where the metric scored them.
 */
export function measureLaidOut(
  objectBoxes: Map<string, Box>,
  edges: LaidEdge[],
  labelById: Map<string, string>,
  boundaries: BoundaryBox[] = [],
): { rects: Rect[]; edgeGeoms: EdgeGeom[]; metrics: LayoutMetrics; labelPlacements: Map<string, LabelPlacement> } {
  const rects: Rect[] = []
  for (const [id, b] of objectBoxes) rects.push({ id, x: b.x, y: b.y, width: b.width, height: b.height })

  const edgeGeoms: EdgeGeom[] = []
  const labelItems: Array<{ id: string; segments: CubicSeg[]; label: string }> = []
  for (const e of edges) {
    const fromBox = objectBoxes.get(e.fromId)
    const toBox = objectBoxes.get(e.toId)
    if (!fromBox || !toBox) continue
    const geom = connectionGeometry(fromBox, toBox, {
      waypoints: e.waypoints,
      shape: e.shape,
      fromAnchor: e.fromAnchor,
      toAnchor: e.toAnchor,
      lockedToAnchors: e.lockedToAnchors,
    })
    const label = e.real ? labelById.get(e.id) : undefined
    edgeGeoms.push({ id: e.id, fromId: e.fromId, toId: e.toId, points: geom.polyline, label })
    if (label) labelItems.push({ id: e.id, segments: geom.segments, label })
  }

  const labelPlacements = placeLabels(labelItems, rects, groupTextBands(boundaries))
  for (const g of edgeGeoms) {
    const pl = labelPlacements.get(g.id)
    if (pl) g.labelAt = pl.at
  }

  return { rects, edgeGeoms, metrics: computeMetrics(rects, edgeGeoms, 0, boundaries), labelPlacements }
}

/**
 * A boundary group's text region, as a soft routing zone: its reserved TOP header band
 * (the centered identity stack — icon/title/type/description).
 *
 * The header band mirrors the band `metrics.ts` scores in `headerBandHits` (the shared
 * {@link headerBandRect}: a strip spanning the reserved top band height, sized to the
 * ACTUAL widest centered header line). Passed to {@link repairRoute} (and `placeLabels`)
 * as a soft zone so a route/label prefers to stay clear of the group's header text when
 * an equally clean alternative exists, without ever failing to route.
 */
export function groupTextBands(boundaries: BoundaryBox[]): Rect[] {
  const out: Rect[] = []
  for (const b of boundaries) {
    const header = headerBandRect(b)
    if (header) out.push(header)
  }
  return out
}

/** Build BoundaryBox descriptors for a diagram's system/container boundary groups. The
 * reserved top-band height + widest header line are derived from the group exactly as
 * the canvas/layout do, so the masking band the metric checks is the space the box
 * actually reserves for the centered header. */
export function boundaryBoxes(
  diagram: Diagram,
  groups: Group[],
  layoutOf: (id: string) => { position: { x: number; y: number }; size: { width: number; height: number } } | undefined,
): BoundaryBox[] {
  const out: BoundaryBox[] = []
  for (const gid of diagram.groupIds) {
    const g = groups.find((x) => x.id === gid)
    if (!g || !g.parentObjectId) continue
    const l = layoutOf(gid)
    if (!l) continue
    out.push({
      x: l.position.x,
      y: l.position.y,
      width: l.size.width,
      height: l.size.height,
      memberIds: new Set(g.objectIds),
      headerBandHeight: groupHeaderBandHeight(g),
      headerTextWidth: headerTextWidth(g.name, g.type, g.description),
    })
  }
  return out
}
