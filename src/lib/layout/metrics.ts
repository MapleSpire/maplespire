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

// Objective layout-quality metrics. These are the gates the auto-layout engine
// is held to (in tests and in the QA loop): no overlapping shapes, no
// connections cutting through unrelated shapes, and as few edge crossings
// ("spaghetti") as possible.

import { polylineLength } from './geometry'

export interface Rect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface EdgeGeom {
  id: string
  fromId: string
  toId: string
  /** Full (faithful) polyline of the drawn edge, border endpoint → border endpoint. */
  points: Point[]
  /** Connection label, if any (for label-overlap detection). */
  label?: string
  /** De-collided label box CENTRE (faithful: pathPoint(t)+normal·offset). When set,
   * the metric scores — and the SVG preview draws — the label here instead of at the
   * raw polyline midpoint. Produced by `placeLabels` so metric == PNG == canvas. */
  labelAt?: Point
}

/** A boundary (system/container) box + the ids of the objects that belong in it. */
export interface BoundaryBox {
  x: number
  y: number
  width: number
  height: number
  memberIds: Set<string>
  /** Height of the reserved TOP header band — the centered identity-stack region
   * (icon → title → type → description) the boundary draws. Equals the top padding the
   * layout reserved for this group ({@link groupHeaderBandHeight}); members sit right
   * below it. The masking metric and the soft-zone router treat an edge/label inside
   * this band as covering the group's header text (the "header masked" defect). */
  headerBandHeight?: number
  /** Px width of the widest centered header line (title/type/description) the group
   * draws. The band is sized to THIS (centered, clamped to the box) rather than full
   * width, so an edge grazing the band's far corners — clear of the text — isn't counted
   * as masking it (and the router isn't forced to detour around the whole top edge). */
  headerTextWidth?: number
}

// --- Parent-wrapper (boundary) header band -----------------------------------
// MIRRORS the band geometry in CanvasEngine.groupHeaderBandHeight — the SOURCE OF
// TRUTH for band geometry (src/canvas/engine/CanvasEngine.ts). A parent-wrapper
// boundary reserves a TOP band for a centered identity stack (icon → title → type →
// description) plus a slim bottom padding (the description moved to the top, so no text
// is drawn below the members anymore). The top band is computed PER GROUP so members
// never overlap it and sparse headers don't waste space. Keep these constants in
// lockstep with the HDR_* / MIN_HEADER_BAND / GROUP_FOOTER_PAD constants in CanvasEngine.
const HDR_MIN_BAND = 46     // floor — parity with the legacy top reservation
const HDR_TOP_INSET = 24    // stack top (clears the corner-affordance hit band)
const HDR_BOTTOM_INSET = 12 // gap between the stack and the first member
const HDR_ICON = 20
const HDR_GAP_ICON = 8
const HDR_TITLE_BASE = 14
const HDR_TYPE = 10
const HDR_GAP_TYPE = 4
const HDR_DESC_BASE = 12
const HDR_GAP_DESC = 6

/** Slim bottom padding a parent-wrapper boundary reserves below its lowest member. The
 * description/type now lives in the top header band, so nothing is drawn here. Mirrors
 * GROUP_FOOTER_PAD in CanvasEngine. */
export const GROUP_FOOTER_PAD = 28

/** Top reservation for a STANDARD (non-parent-wrapper) group — the header band that holds
 * the top-left icon + title row, sized so the row (icon bottom ≈ y+32) clears the first
 * member with a comfortable gap. Single source of truth for the custom + ELK layouts and
 * the SVG preview; MIRRORED by GROUP_STD_HEADER_PAD in CanvasEngine (the live renderer) —
 * keep the two in lockstep. (Sides/bottom stay at the symmetric GROUP_PAD.) */
export const GROUP_STD_PAD_TOP = 52

/** Symmetric side/bottom padding a group box reserves around its members. Third
 *  home for this number until now — the layout engine, the ELK layout and the
 *  Structurizr JSON importer each had their own 30, and a group box that
 *  disagrees with the canvas clips its own title. */
export const GROUP_SIDE_PAD = 30

/** Rough px width of a group title (Segoe UI ~ 0.55em/char) — floors a group box
 *  width so its (never-clipped) title fits. Parent wrappers draw at font 13,
 *  model-level groups at font 11. */
export function groupTitleMinWidth(name: string, fontSize: number): number {
  return Math.ceil((name?.length ?? 0) * fontSize * 0.55) + 40
}

/** Height of the reserved TOP header band for a parent-wrapper boundary, sized to the
 * present elements at base font (presence + base line heights only — no text
 * measurement, identical to CanvasEngine.groupHeaderBandHeight). This is exactly the
 * top padding the layout must reserve so the rendered centered stack — which only ever
 * shrinks from these base sizes — never overlaps the members. */
export function groupHeaderBandHeight(g: { icon?: string; name?: string; type?: string; description?: string }): number {
  let stack = 0
  if (g.icon) stack += HDR_ICON + HDR_GAP_ICON
  if (g.name?.trim()) stack += Math.round(HDR_TITLE_BASE * 1.25)
  if (g.type?.trim()) stack += HDR_GAP_TYPE + Math.round(HDR_TYPE * 1.3)
  if (g.description?.trim()) stack += HDR_GAP_DESC + Math.round(HDR_DESC_BASE * 1.3)
  if (stack === 0) return HDR_MIN_BAND
  return Math.max(HDR_MIN_BAND, HDR_TOP_INSET + stack + HDR_BOTTOM_INSET)
}

export interface LayoutMetrics {
  nodeCount: number
  edgeCount: number
  /** Pairs of node rectangles that overlap (respecting the min-gap margin). */
  nodeOverlaps: number
  /** Smallest gap between any two node rectangles (negative = overlapping). */
  minGap: number
  /** Pairs of edges (not sharing a node) whose segments cross. */
  edgeCrossings: number
  /** Edge segments that pass through a node rect that is not their endpoint. */
  edgeNodeOverlaps: number
  /** Mean over hubs (degree ≥ HUB_DEGREE) of distinct-attachment fraction (1 = ports
   * fully distributed, low = edges piled at one point → "spray"). 1 when no hubs. */
  hubSpread: number
  /** Label rectangles overlapping other labels or unrelated node rects. */
  labelOverlaps: number
  totalEdgeLength: number
  medianEdgeLength: number
  /** Mean detour ratio − 1 over edges: 0 = every edge a straight shot, higher =
   * bowed / waypointed / S-curved ("connections more complex than they should be").
   * Lets the portfolio prefer the candidate that draws the same edges straighter. */
  bendiness: number
  /** Non-adjacent edge pairs running near-parallel and close (clutter/bundling). */
  nearParallelPairs: number
  /** Max number of boxes closer than CROWD_GAP to any one node (excessive proximity). */
  localDensity: number
  /** Non-member object nodes whose centre falls inside a boundary (system/container)
   * box — or, in the auto-layout's own candidate scoring, a model-level group box. */
  boundaryViolations: number
  /** Non-member object nodes overlapping such a box by at least STRADDLE_MIN on both
   * axes without their centre inside it (half in, half out), plus pairs of such
   * boxes that share no member yet overlap by as much. Soft. */
  groupStraddles: number
  /** Edges or edge-labels routed across a boundary's reserved TOP header band (the
   * centered identity stack — icon/title/type/description — would be masked by the
   * connection). */
  headerBandHits: number
  width: number
  height: number
  area: number
  aspect: number
  /** Single scalar — lower is better. Overlap terms dominate. */
  score: number
}

// Tunables for the soft metrics + score (the QA loop adjusts weights here).
export const METRIC_CONST = {
  HUB_DEGREE: 5,
  PARALLEL_DEG: 12,
  BUNDLE_DIST: 24,
  REF_EDGE_LEN: 300,
  /** Border gap below which two shapes crowd each other. Under every spacing the
   * engines use on purpose (ELK root 60, boundary interiors 40, isolated grid 40,
   * custom 70), so only a genuinely cramped placement counts. */
  CROWD_GAP: 30,
  /** Overlap (px, on both axes) at which a non-member shape straddles a group box. */
  STRADDLE_MIN: 8,
}
const WEIGHTS = {
  nodeOverlap: 1000,
  edgeNodeOverlap: 200,
  boundary: 300,
  // crossing: raised 5→20 after vision QA found edge crossings (not bends) are the
  // dominant "complex connections" signal yet were barely scored. 20 flips the
  // portfolio onto lower-crossing candidates where they exist (FSContainers 4→1,
  // big-bank Containers 1→0; total 24→18 across QA fixtures) with no hard-gate or
  // descBand regression. Measured: 40 changes nothing more (the marginal candidates
  // flip by 20), so 20 is the minimal sufficient weight — don't raise further.
  crossing: 20,
  hub: 40,
  label: 15,
  nearParallel: 3,
  length: 5,
  density: 4,
  aspect: 10,
  bend: 60,
  // headerBand: an edge/label over a boundary's centered TOP header (the masking
  // defect). Cut from the legacy 150 (which was tuned for the OLD *bottom* description
  // band — rarely in an edge's path, so a heavy penalty almost never fired). The top
  // header sits directly above the members where external edges enter, so it's
  // structurally far more exposed; at 150/hit it dominated everything and pushed the
  // portfolio onto high-crossing / heavily-detoured candidates just to shave a hit. 40
  // (2× a crossing) keeps header masking a real, meaningful penalty without distorting
  // selection away from the crossing/bend axes.
  headerBand: 40,
  // straddle: a third of a hard boundary violation — enough that any candidate
  // keeping non-members clear of group boxes wins over one that does not, without
  // ranking a straddle above an edge cut through a shape (200).
  straddle: 100,
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}

/** The on-canvas bounding box of an edge label centred at `c`. Single source of truth
 * for label sizing — shared by the metric (`labelOverlaps`/`headerBandHits`), the
 * de-collision solver (`placeLabels`), and the SVG preview, so all three agree. */
export function labelRect(id: string, c: Point, label: string): Rect {
  const w = Math.min(label.length * 5.5, 160) + 8
  return { id, x: c.x - w / 2, y: c.y - 8, width: w, height: 16 }
}

/** Px width of the widest centered header line a parent-wrapper boundary draws — title
 * (font 14), type (font 10), or description (font 12), Segoe UI ≈ 0.55em/char, matching
 * the canvas's base header fonts (HDR_TITLE_BASE/HDR_TYPE/HDR_DESC_BASE). Used to size
 * the header band to the ACTUAL centered text. */
export function headerTextWidth(name?: string, type?: string, description?: string): number {
  const nw = name ? name.length * HDR_TITLE_BASE * 0.55 : 0
  const tw = type ? type.length * HDR_TYPE * 0.55 : 0
  const dw = description ? description.length * HDR_DESC_BASE * 0.55 : 0
  return Math.max(nw, tw, dw)
}

/** The centered TOP header band a parent-wrapper boundary draws, as a Rect — or null if
 * it has no header text. Spans the full reserved band ({@link headerBandHeight}) from the
 * box top — the whole region the identity stack occupies and members are kept out of;
 * width = the widest header line (clamped to the box), centered. Single source shared by
 * the metric (`headerBandHits`) and the soft-zone router so they agree on which strip
 * must stay clear of edges/labels (the "header masked" defect). Covering the full
 * reserved band (not just the glyph rows) matches the legacy bottom-band convention and,
 * for the routing soft zone, keeps the custom fallback from detouring hard around an
 * unavoidable central band (which would trade masking for excessive bends/crossings). */
export function headerBandRect(b: BoundaryBox): Rect | null {
  const tw = b.headerTextWidth ?? 0
  if (tw <= 0) return null
  const w = Math.min(tw, b.width)
  const h = b.headerBandHeight ?? HDR_MIN_BAND
  return { id: 'header', x: b.x + (b.width - w) / 2, y: b.y, width: w, height: h }
}

/** Do two rects overlap, treating `gap` as required clear space between them? */
export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  )
}

/** Signed gap between two rects: distance apart, or negative penetration depth. */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width))
  const dy = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height))
  // If overlapping on both axes, gap is negative (max of the two penetrations).
  if (dx < 0 && dy < 0) return Math.max(dx, dy)
  if (dx < 0) return dy
  if (dy < 0) return dx
  return Math.hypot(dx, dy)
}

function orient(a: Point, b: Point, c: Point): number {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y)
  if (Math.abs(v) < 1e-9) return 0
  return v > 0 ? 1 : 2
}

function onSeg(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a.x, b.x) - 1e-9 <= p.x &&
    p.x <= Math.max(a.x, b.x) + 1e-9 &&
    Math.min(a.y, b.y) - 1e-9 <= p.y &&
    p.y <= Math.max(a.y, b.y) + 1e-9
  )
}

/** Proper segment intersection (shared endpoints do NOT count as crossings). */
export function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  // Shared endpoint → not a crossing.
  const samePt = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6
  if (samePt(p1, p3) || samePt(p1, p4) || samePt(p2, p3) || samePt(p2, p4)) return false

  const o1 = orient(p1, p2, p3)
  const o2 = orient(p1, p2, p4)
  const o3 = orient(p3, p4, p1)
  const o4 = orient(p3, p4, p2)
  if (o1 !== o2 && o3 !== o4) return true
  if (o1 === 0 && onSeg(p1, p2, p3)) return true
  if (o2 === 0 && onSeg(p1, p2, p4)) return true
  if (o3 === 0 && onSeg(p3, p4, p1)) return true
  if (o4 === 0 && onSeg(p3, p4, p2)) return true
  return false
}

/** Does a segment pass through (intersect the interior/border of) a rect? */
export function segmentIntersectsRect(p1: Point, p2: Point, r: Rect): boolean {
  const inside = (p: Point) =>
    p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
  if (inside(p1) || inside(p2)) return true
  const tl = { x: r.x, y: r.y }
  const tr = { x: r.x + r.width, y: r.y }
  const bl = { x: r.x, y: r.y + r.height }
  const br = { x: r.x + r.width, y: r.y + r.height }
  return (
    segmentsCrossInclusive(p1, p2, tl, tr) ||
    segmentsCrossInclusive(p1, p2, tr, br) ||
    segmentsCrossInclusive(p1, p2, br, bl) ||
    segmentsCrossInclusive(p1, p2, bl, tl)
  )
}

function segmentsCrossInclusive(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o1 = orient(p1, p2, p3)
  const o2 = orient(p1, p2, p4)
  const o3 = orient(p3, p4, p1)
  const o4 = orient(p3, p4, p2)
  if (o1 !== o2 && o3 !== o4) return true
  if (o1 === 0 && onSeg(p1, p2, p3)) return true
  if (o2 === 0 && onSeg(p1, p2, p4)) return true
  if (o3 === 0 && onSeg(p3, p4, p1)) return true
  if (o4 === 0 && onSeg(p3, p4, p2)) return true
  return false
}

export function computeMetrics(rects: Rect[], edges: EdgeGeom[], gap = 0, boundaries: BoundaryBox[] = []): LayoutMetrics {
  let nodeOverlaps = 0
  let minGap = Infinity
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const g = rectGap(rects[i], rects[j])
      if (g < minGap) minGap = g
      if (rectsOverlap(rects[i], rects[j], gap)) nodeOverlaps++
    }
  }
  if (!Number.isFinite(minGap)) minGap = 0

  // Edge crossings: compare every segment of every pair of edges.
  let edgeCrossings = 0
  const segsOf = (e: EdgeGeom): Array<[Point, Point]> => {
    const out: Array<[Point, Point]> = []
    for (let k = 0; k + 1 < e.points.length; k++) out.push([e.points[k], e.points[k + 1]])
    return out
  }
  const allSegs = edges.map(segsOf)
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      // Edges that share a node can legitimately meet at that node.
      const shareNode =
        edges[i].fromId === edges[j].fromId ||
        edges[i].fromId === edges[j].toId ||
        edges[i].toId === edges[j].fromId ||
        edges[i].toId === edges[j].toId
      let crossed = false
      for (const [a, b] of allSegs[i]) {
        for (const [c, d] of allSegs[j]) {
          if (segmentsCross(a, b, c, d)) {
            crossed = true
            break
          }
        }
        if (crossed) break
      }
      if (crossed && !shareNode) edgeCrossings++
    }
  }

  // Edges cutting through unrelated node rects.
  let edgeNodeOverlaps = 0
  for (const e of edges) {
    for (const r of rects) {
      if (r.id === e.fromId || r.id === e.toId) continue
      // Shrink the rect slightly so an edge grazing the border isn't a hit.
      const shrunk: Rect = { id: r.id, x: r.x + 2, y: r.y + 2, width: r.width - 4, height: r.height - 4 }
      if (shrunk.width <= 0 || shrunk.height <= 0) continue
      let hit = false
      for (let k = 0; k + 1 < e.points.length; k++) {
        if (segmentIntersectsRect(e.points[k], e.points[k + 1], shrunk)) {
          hit = true
          break
        }
      }
      if (hit) edgeNodeOverlaps++
    }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  const width = rects.length ? maxX - minX : 0
  const height = rects.length ? maxY - minY : 0
  const aspect = height > 0 ? Math.round((width / height) * 100) / 100 : 0

  // ── soft / visual-quality metrics ──────────────────────────────────────────
  const minSide = rects.length ? Math.min(...rects.map((r) => Math.min(r.width, r.height))) : 60

  // Edge lengths (on the faithful polyline).
  const lengths = edges.map((e) => polylineLength(e.points))
  const totalEdgeLength = Math.round(lengths.reduce((s, l) => s + l, 0))
  const medianEdgeLength = Math.round(median(lengths))

  // Bendiness: mean (polylineLength / straight-line distance) − 1 over edges with a
  // meaningful span. A straight shot ≈ 0; a bowed S-curve or a detoured route > 0.
  const detours: number[] = []
  for (let i = 0; i < edges.length; i++) {
    const pts = edges[i].points
    if (pts.length < 2) continue
    const straight = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y)
    if (straight < 1) continue
    detours.push(Math.max(0, lengths[i] / straight - 1))
  }
  const bendiness = detours.length ? round2(detours.reduce((s, d) => s + d, 0) / detours.length) : 0

  // Hub attachment dispersion: per node, how spread out are its edge endpoints.
  const attach = new Map<string, Point[]>()
  const pushAttach = (id: string, p: Point) => {
    const l = attach.get(id) ?? []
    l.push(p)
    attach.set(id, l)
  }
  for (const e of edges) {
    if (e.points.length < 2) continue
    pushAttach(e.fromId, e.points[0])
    pushAttach(e.toId, e.points[e.points.length - 1])
  }
  const tol = Math.max(8, minSide * 0.25)
  const hubFractions: number[] = []
  for (const [, pts] of attach) {
    if (pts.length < METRIC_CONST.HUB_DEGREE) continue
    // Count distinct attachment clusters within `tol`.
    const clusters: Point[] = []
    for (const p of pts) {
      if (!clusters.some((c) => Math.hypot(c.x - p.x, c.y - p.y) <= tol)) clusters.push(p)
    }
    hubFractions.push(clusters.length / pts.length)
  }
  const hubSpread = hubFractions.length ? round2(hubFractions.reduce((s, f) => s + f, 0) / hubFractions.length) : 1

  // Label overlaps: label rect at the (de-collided) label centre when `placeLabels`
  // has run, else the raw polyline midpoint.
  const labelRects: Rect[] = []
  for (const e of edges) {
    if (!e.label || e.points.length === 0) continue
    const c = e.labelAt ?? e.points[Math.floor(e.points.length / 2)]
    labelRects.push(labelRect(e.id, c, e.label))
  }
  let labelOverlaps = 0
  for (let i = 0; i < labelRects.length; i++) {
    for (let j = i + 1; j < labelRects.length; j++) {
      if (rectsOverlap(labelRects[i], labelRects[j])) labelOverlaps++
    }
    for (const r of rects) {
      if (rectsOverlap(labelRects[i], r)) {
        labelOverlaps++
        break
      }
    }
  }

  // Near-parallel + close edge pairs (clutter/bundling).
  let nearParallelPairs = 0
  const dirs = edges.map((e) => {
    const a = e.points[0]
    const b = e.points[e.points.length - 1]
    return { ang: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
  })
  const thresh = (METRIC_CONST.PARALLEL_DEG * Math.PI) / 180
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const share =
        edges[i].fromId === edges[j].fromId || edges[i].fromId === edges[j].toId ||
        edges[i].toId === edges[j].fromId || edges[i].toId === edges[j].toId
      if (share) continue
      let da = Math.abs(dirs[i].ang - dirs[j].ang) % Math.PI
      if (da > Math.PI / 2) da = Math.PI - da
      if (da < thresh && Math.hypot(dirs[i].mx - dirs[j].mx, dirs[i].my - dirs[j].my) < METRIC_CONST.BUNDLE_DIST) {
        nearParallelPairs++
      }
    }
  }

  // Local density: the most boxes crowding any one node — border-to-border gap under
  // CROWD_GAP. Measured on GAPS, not centres: a centre radius (220px, until
  // 2026-10-21) counted ELK's ordinary 60px spacing between 150px-wide shapes
  // (centres ~210px apart) as crowding while the custom engine's 70px spacing
  // (~220px) escaped it, so a normally spaced ELK candidate paid 8–12 points the
  // custom engine never did — enough to hand the SAOE `FSSystemContext` view to the
  // custom engine's off-centre hub and long diagonals (score 11 vs 17).
  let localDensity = 0
  for (let i = 0; i < rects.length; i++) {
    let count = 0
    for (let j = 0; j < rects.length; j++) {
      if (i !== j && rectGap(rects[i], rects[j]) < METRIC_CONST.CROWD_GAP) count++
    }
    localDensity = Math.max(localDensity, count)
  }

  // Boundary violations: a non-member object node whose centre falls inside a
  // boundary/group box (it should sit OUTSIDE the box). A non-member that only
  // STRADDLES the box edge is counted separately (groupStraddles, soft): it reads as
  // half a member — grouped.dsl's Legacy ERP sat half inside "Cloud" — but a few
  // pixels of overlap in a hand-placed layout is not worth failing the hard gate.
  let boundaryViolations = 0
  let groupStraddles = 0
  for (const b of boundaries) {
    for (const r of rects) {
      if (b.memberIds.has(r.id)) continue
      const cx = r.x + r.width / 2
      const cy = r.y + r.height / 2
      if (cx > b.x && cx < b.x + b.width && cy > b.y && cy < b.y + b.height) {
        boundaryViolations++
        continue
      }
      const ox = Math.min(r.x + r.width, b.x + b.width) - Math.max(r.x, b.x)
      const oy = Math.min(r.y + r.height, b.y + b.height) - Math.max(r.y, b.y)
      if (ox >= METRIC_CONST.STRADDLE_MIN && oy >= METRIC_CONST.STRADDLE_MIN) groupStraddles++
    }
  }
  // Two group boxes that share no member must not overlap either: each box then
  // draws over the other's title and members. Object rects alone cannot see it —
  // a box widened to its title can cover a neighbouring group's empty margin.
  for (let i = 0; i < boundaries.length; i++) {
    for (let j = i + 1; j < boundaries.length; j++) {
      const a = boundaries[i]
      const b = boundaries[j]
      let shared = false
      for (const m of a.memberIds) if (b.memberIds.has(m)) { shared = true; break }
      if (shared) continue
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
      if (ox >= METRIC_CONST.STRADDLE_MIN && oy >= METRIC_CONST.STRADDLE_MIN) groupStraddles++
    }
  }

  // Header-band collisions: an edge polyline or an edge label that lands over the
  // group's centered TOP header (icon/title/type/description) would mask it. The band is
  // sized to the ACTUAL text width (centered), so an edge entering the group's top-left/
  // right corner — clear of the text — isn't penalized (only genuine masking is).
  let headerBandHits = 0
  for (const b of boundaries) {
    const band = headerBandRect(b)
    if (!band) continue
    for (const lr of labelRects) {
      if (rectsOverlap(lr, band)) headerBandHits++
    }
    for (const e of edges) {
      for (let k = 0; k + 1 < e.points.length; k++) {
        if (segmentIntersectsRect(e.points[k], e.points[k + 1], band)) {
          headerBandHits++
          break
        }
      }
    }
  }

  // Aspect penalty: 0 in [0.5, 2], grows outside.
  const aspectPenalty = aspect === 0 ? 0 : aspect > 2 ? aspect - 2 : aspect < 0.5 ? 0.5 - aspect : 0

  const score = Math.round(
    nodeOverlaps * WEIGHTS.nodeOverlap +
      edgeNodeOverlaps * WEIGHTS.edgeNodeOverlap +
      boundaryViolations * WEIGHTS.boundary +
      edgeCrossings * WEIGHTS.crossing +
      (1 - hubSpread) * WEIGHTS.hub +
      labelOverlaps * WEIGHTS.label +
      nearParallelPairs * WEIGHTS.nearParallel +
      (medianEdgeLength / METRIC_CONST.REF_EDGE_LEN) * WEIGHTS.length +
      localDensity * WEIGHTS.density +
      aspectPenalty * WEIGHTS.aspect +
      bendiness * WEIGHTS.bend +
      headerBandHits * WEIGHTS.headerBand +
      groupStraddles * WEIGHTS.straddle,
  )

  return {
    nodeCount: rects.length,
    edgeCount: edges.length,
    nodeOverlaps,
    minGap: Math.round(minGap),
    edgeCrossings,
    edgeNodeOverlaps,
    hubSpread,
    labelOverlaps,
    totalEdgeLength,
    medianEdgeLength,
    bendiness,
    nearParallelPairs,
    localDensity,
    boundaryViolations,
    groupStraddles,
    headerBandHits,
    width: Math.round(width),
    height: Math.round(height),
    area: Math.round(width * height),
    aspect,
    score,
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function round2(x: number): number {
  return Math.round(x * 100) / 100
}
