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
 * Connection path math for the 3D board — a pure port of the 2D engine's
 * routing (CanvasEngine.getConnectionGeometry and friends) so both views draw
 * the SAME paths for the same data: 12-anchor table, edge-point fallback,
 * face-normal control points, Catmull-Rom through waypoints, arrow-trimmed
 * ends. Works entirely in 2D world coordinates; the scene lays the result flat
 * on the board.
 */

import type { Connection, ConnectionShape, Position } from '../types'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Face = 'top' | 'bottom' | 'left' | 'right'

export interface EdgePoint {
  x: number
  y: number
  face: Face
}

export interface CubicSeg {
  x0: number
  y0: number
  cp1x: number
  cp1y: number
  cp2x: number
  cp2y: number
  x1: number
  y1: number
}

export interface PathGeometry {
  segments: CubicSeg[]
  fromEdge: EdgePoint
  toEdge: EdgePoint
  /** Arrow tip (the untrimmed target edge point) + its incoming angle. */
  arrowTip: { x: number; y: number; angle: number }
}

/** CanvasEngine.anchorDefs — 12 anchors, 3 per side, corner radius 8 inset. */
const ANCHOR_DEFS: { side: Face; ratio: number }[] = [
  { side: 'top', ratio: 0.2 },
  { side: 'top', ratio: 0.5 },
  { side: 'top', ratio: 0.8 },
  { side: 'right', ratio: 0.2 },
  { side: 'right', ratio: 0.5 },
  { side: 'right', ratio: 0.8 },
  { side: 'bottom', ratio: 0.2 },
  { side: 'bottom', ratio: 0.5 },
  { side: 'bottom', ratio: 0.8 },
  { side: 'left', ratio: 0.2 },
  { side: 'left', ratio: 0.5 },
  { side: 'left', ratio: 0.8 },
]

export function anchorPoint(rect: Rect, anchorIndex: number): EdgePoint {
  const def = ANCHOR_DEFS[anchorIndex]
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  if (!def) return { x: cx, y: cy, face: 'top' }
  const r = 8
  switch (def.side) {
    case 'top':
      return { x: rect.x + r + def.ratio * Math.max(0, rect.w - 2 * r), y: rect.y, face: 'top' }
    case 'bottom':
      return { x: rect.x + r + def.ratio * Math.max(0, rect.w - 2 * r), y: rect.y + rect.h, face: 'bottom' }
    case 'left':
      return { x: rect.x, y: rect.y + r + def.ratio * Math.max(0, rect.h - 2 * r), face: 'left' }
    case 'right':
      return { x: rect.x + rect.w, y: rect.y + r + def.ratio * Math.max(0, rect.h - 2 * r), face: 'right' }
  }
}

/** Unanchored endpoint: where the line toward `(tx, ty)` exits the rect. */
export function edgePoint(rect: Rect, tx: number, ty: number): EdgePoint {
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  const dx = tx - cx
  const dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: rect.y, face: 'top' }
  const sx = dx !== 0 ? rect.w / 2 / Math.abs(dx) : Infinity
  const sy = dy !== 0 ? rect.h / 2 / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  const x = cx + dx * s
  const y = cy + dy * s
  const face: Face = sx < sy ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top'
  return { x, y, face }
}

const FACE_NORMALS: Record<Face, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

/** CanvasEngine.computeConnectionControlPoints. */
function controlPoints(fromEdge: EdgePoint, toEdge: EdgePoint, shape: ConnectionShape) {
  if (shape === 'straight') {
    const dx = toEdge.x - fromEdge.x
    const dy = toEdge.y - fromEdge.y
    return {
      cp1x: fromEdge.x + dx / 3,
      cp1y: fromEdge.y + dy / 3,
      cp2x: fromEdge.x + (dx * 2) / 3,
      cp2y: fromEdge.y + (dy * 2) / 3,
    }
  }
  const dist = Math.hypot(toEdge.x - fromEdge.x, toEdge.y - fromEdge.y)
  const controlDist = Math.min(Math.max(dist * 0.4, 30), 150)
  const fn = FACE_NORMALS[fromEdge.face]
  const tn = FACE_NORMALS[toEdge.face]
  return {
    cp1x: fromEdge.x + fn.x * controlDist,
    cp1y: fromEdge.y + fn.y * controlDist,
    cp2x: toEdge.x + tn.x * controlDist,
    cp2y: toEdge.y + tn.y * controlDist,
  }
}

/** CanvasEngine.buildConnectionSegments (single curve / straight polyline /
 * Catmull-Rom spline through waypoints). */
function buildSegments(
  fromEdge: EdgePoint,
  toEdge: EdgePoint,
  waypoints: Position[],
  shape: ConnectionShape,
): CubicSeg[] {
  if (waypoints.length === 0) {
    const cp = controlPoints(fromEdge, toEdge, shape)
    return [{ x0: fromEdge.x, y0: fromEdge.y, ...cp, x1: toEdge.x, y1: toEdge.y }]
  }
  const pts: Position[] = [{ x: fromEdge.x, y: fromEdge.y }, ...waypoints, { x: toEdge.x, y: toEdge.y }]
  const segs: CubicSeg[] = []
  if (shape === 'straight') {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      segs.push({
        x0: a.x,
        y0: a.y,
        cp1x: a.x + (b.x - a.x) / 3,
        cp1y: a.y + (b.y - a.y) / 3,
        cp2x: a.x + ((b.x - a.x) * 2) / 3,
        cp2y: a.y + ((b.y - a.y) * 2) / 3,
        x1: b.x,
        y1: b.y,
      })
    }
    return segs
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? pts[i + 1]
    segs.push({
      x0: p1.x,
      y0: p1.y,
      cp1x: p1.x + (p2.x - p0.x) / 6,
      cp1y: p1.y + (p2.y - p0.y) / 6,
      cp2x: p2.x - (p3.x - p1.x) / 6,
      cp2y: p2.y - (p3.y - p1.y) / 6,
      x1: p2.x,
      y1: p2.y,
    })
  }
  return segs
}

/**
 * Full path for a (3D-resolved) connection between two shape rects. Mirrors the
 * engine: anchored ends use the locked anchors, free ends aim at the other
 * shape's center; the drawn path is trimmed 4px at the source and 14px (the
 * arrow) at the target.
 */
export function connectionPath(conn: Connection, fromRect: Rect, toRect: Rect): PathGeometry {
  const locked = conn.lockedToAnchors === true
  const fromEdge =
    locked && conn.fromAnchor !== undefined
      ? anchorPoint(fromRect, conn.fromAnchor)
      : edgePoint(fromRect, toRect.x + toRect.w / 2, toRect.y + toRect.h / 2)
  const toEdge =
    locked && conn.toAnchor !== undefined
      ? anchorPoint(toRect, conn.toAnchor)
      : edgePoint(toRect, fromRect.x + fromRect.w / 2, fromRect.y + fromRect.h / 2)

  return pathFromEdges(fromEdge, toEdge, conn.waypoints ?? [], conn.shape ?? 'curved')
}

/** The route between two edge points (the 2D engine's segments, its ends
 * set back for the flat arrowhead). */
function pathFromEdges(fromEdge: EdgePoint, toEdge: EdgePoint, waypoints: Position[], shape: ConnectionShape): PathGeometry {
  const segments = buildSegments(fromEdge, toEdge, waypoints, shape)
  const first = segments[0]
  const last = segments[segments.length - 1]
  const arrowSize = 14
  const fromAngle = Math.atan2(first.y0 - first.cp1y, first.x0 - first.cp1x)
  const toAngle = Math.atan2(last.y1 - last.cp2y, last.x1 - last.cp2x)
  const arrowTip = { x: toEdge.x, y: toEdge.y, angle: toAngle }
  first.x0 = fromEdge.x - 4 * Math.cos(fromAngle)
  first.y0 = fromEdge.y - 4 * Math.sin(fromAngle)
  last.x1 = toEdge.x - arrowSize * Math.cos(toAngle)
  last.y1 = toEdge.y - arrowSize * Math.sin(toAngle)

  return { segments, fromEdge, toEdge, arrowTip }
}

function bezierPoint(s: CubicSeg, t: number): { x: number; y: number } {
  const u = 1 - t
  return {
    x: u ** 3 * s.x0 + 3 * u * u * t * s.cp1x + 3 * u * t * t * s.cp2x + t ** 3 * s.x1,
    y: u ** 3 * s.y0 + 3 * u * u * t * s.cp1y + 3 * u * t * t * s.cp2y + t ** 3 * s.y1,
  }
}

/** Sample the whole path into a polyline (N points per segment). */
export function samplePath(geom: PathGeometry, perSegment = 24): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = []
  for (let i = 0; i < geom.segments.length; i++) {
    const s = geom.segments[i]
    const start = i === 0 ? 0 : 1
    for (let j = start; j <= perSegment; j++) {
      pts.push(bezierPoint(s, j / perSegment))
    }
  }
  return pts
}

/** Point at global t∈[0,1] (segments weighted equally, like the engine). */
export function pathPoint(geom: PathGeometry, t: number): { x: number; y: number } {
  const n = geom.segments.length
  const scaled = Math.max(0, Math.min(1, t)) * n
  const i = Math.min(n - 1, Math.floor(scaled))
  return bezierPoint(geom.segments[i], scaled - i)
}

// ── edit-gesture math (ports of the engine's label/waypoint/anchor helpers) ──

/** Normalized tangent at global t (CanvasEngine.getPathTangent). */
export function pathTangent(geom: PathGeometry, t: number): { x: number; y: number } {
  const n = geom.segments.length
  const scaled = Math.max(0, Math.min(1, t)) * n
  const i = Math.min(n - 1, Math.floor(scaled))
  const lt = scaled - i
  const s = geom.segments[i]
  const u = 1 - lt
  let dx = 3 * u * u * (s.cp1x - s.x0) + 6 * u * lt * (s.cp2x - s.cp1x) + 3 * lt * lt * (s.x1 - s.cp2x)
  let dy = 3 * u * u * (s.cp1y - s.y0) + 6 * u * lt * (s.cp2y - s.cp1y) + 3 * lt * lt * (s.y1 - s.cp2y)
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) {
    dx = s.x1 - s.x0
    dy = s.y1 - s.y0
    const l2 = Math.hypot(dx, dy) || 1
    return { x: dx / l2, y: dy / l2 }
  }
  return { x: dx / len, y: dy / len }
}

/** Nearest global t∈[0,1] on the whole path to a point (engine parity: 40
 * samples per segment — the label-drag projection). */
export function nearestTOnPath(geom: PathGeometry, px: number, py: number): number {
  const n = geom.segments.length
  const stepsPer = 40
  let bestT = 0.5
  let bestDist = Infinity
  for (let i = 0; i < n; i++) {
    const s = geom.segments[i]
    for (let j = 0; j <= stepsPer; j++) {
      const lt = j / stepsPer
      const pt = bezierPoint(s, lt)
      const d = (pt.x - px) ** 2 + (pt.y - py) ** 2
      if (d < bestDist) {
        bestDist = d
        bestT = (i + lt) / n
      }
    }
  }
  return bestT
}

/** Index of the segment closest to a point — the waypoint INSERTION index
 * (CanvasEngine.findSegmentIndexAt). */
export function nearestSegmentIndex(geom: PathGeometry, px: number, py: number): number {
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < geom.segments.length; i++) {
    const s = geom.segments[i]
    for (let j = 0; j <= 24; j++) {
      const pt = bezierPoint(s, j / 24)
      const d = (pt.x - px) ** 2 + (pt.y - py) ** 2
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
  }
  return bestIdx
}

/** Dashed endpoint-drag preview polyline: one cubic leaving the fixed edge
 * along its face normal, arriving at the cursor along the chord (the engine's
 * renderConnectionDragPreview shape). */
export function endpointDragPreview(fixed: EdgePoint, cursor: Position, perSegment = 24): Position[] {
  const dist = Math.hypot(cursor.x - fixed.x, cursor.y - fixed.y)
  const cd = Math.min(Math.max(dist * 0.4, 30), 150)
  const fn = FACE_NORMALS[fixed.face]
  const ux = (fixed.x - cursor.x) / (dist || 1)
  const uy = (fixed.y - cursor.y) / (dist || 1)
  const seg: CubicSeg = {
    x0: fixed.x,
    y0: fixed.y,
    cp1x: fixed.x + fn.x * cd,
    cp1y: fixed.y + fn.y * cd,
    cp2x: cursor.x + ux * cd,
    cp2y: cursor.y + uy * cd,
    x1: cursor.x,
    y1: cursor.y,
  }
  const pts: Position[] = []
  for (let j = 0; j <= perSegment; j++) pts.push(bezierPoint(seg, j / perSegment))
  return pts
}

/** Nearest of the 12 anchors on a rect to a world point (engine
 * findNearestAnchor — the endpoint-drop snap). */
export function nearestAnchorIndex(rect: Rect, x: number, y: number): number {
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < ANCHOR_DEFS.length; i++) {
    const pt = anchorPoint(rect, i)
    const d = Math.hypot(x - pt.x, y - pt.y)
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return bestIdx
}

export const ANCHOR_COUNT = ANCHOR_DEFS.length
