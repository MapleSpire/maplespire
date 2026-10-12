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

// Faithful re-implementation of the CanvasEngine connection geometry, so that
// metrics.ts (quality scoring) and svgPreview.ts (vision-QA rendering) see the
// SAME shapes the real canvas draws — anchored/raycast endpoints, cubic Béziers,
// Catmull-Rom for waypointed curves, and arrow trims.
//
// Mirrors src/canvas/engine/CanvasEngine.ts: getAnchorPoint (:3327), getEdgePoint
// (:5317), computeConnectionControlPoints (:3415), buildConnectionSegments (:3462),
// endpoint resolution (:3595-3642). Kept dependency-free.

export interface Pt {
  x: number
  y: number
}
export interface Box {
  x: number
  y: number
  width: number
  height: number
}
export type Face = 'top' | 'bottom' | 'left' | 'right'
export type LineShape = 'curved' | 'straight'

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

export interface EdgeStyle {
  waypoints?: Pt[]
  shape?: LineShape
  fromAnchor?: number
  toAnchor?: number
  lockedToAnchors?: boolean
}

const CORNER_R = 8
const ARROW = 14

// 12 anchors/node: top 0..2, right 3..5, bottom 6..8, left 9..11 at 0.2/0.5/0.8.
const ANCHOR_DEFS: { side: Face; ratio: number }[] = [
  { side: 'top', ratio: 0.2 }, { side: 'top', ratio: 0.5 }, { side: 'top', ratio: 0.8 },
  { side: 'right', ratio: 0.2 }, { side: 'right', ratio: 0.5 }, { side: 'right', ratio: 0.8 },
  { side: 'bottom', ratio: 0.2 }, { side: 'bottom', ratio: 0.5 }, { side: 'bottom', ratio: 0.8 },
  { side: 'left', ratio: 0.2 }, { side: 'left', ratio: 0.5 }, { side: 'left', ratio: 0.8 },
]

export const SIDE_BASE_ANCHOR: Record<Face, number> = { top: 0, right: 3, bottom: 6, left: 9 }
export const SIDE_CENTER_ANCHOR: Record<Face, number> = { top: 1, right: 4, bottom: 7, left: 10 }

export function center(b: Box): Pt {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** Border point for one of the 12 anchor indices (mirrors getAnchorPoint). */
export function anchorPoint(b: Box, anchorIndex: number): { x: number; y: number; face: Face } {
  const def = ANCHOR_DEFS[anchorIndex]
  const c = center(b)
  if (!def) return { x: c.x, y: c.y, face: 'top' }
  const left = b.x
  const top = b.y
  const r = CORNER_R
  switch (def.side) {
    case 'top': {
      const edgeLen = Math.max(0, b.width - 2 * r)
      return { x: left + r + def.ratio * edgeLen, y: top, face: 'top' }
    }
    case 'bottom': {
      const edgeLen = Math.max(0, b.width - 2 * r)
      return { x: left + r + def.ratio * edgeLen, y: top + b.height, face: 'bottom' }
    }
    case 'left': {
      const edgeLen = Math.max(0, b.height - 2 * r)
      return { x: left, y: top + r + def.ratio * edgeLen, face: 'left' }
    }
    case 'right': {
      const edgeLen = Math.max(0, b.height - 2 * r)
      return { x: left + b.width, y: top + r + def.ratio * edgeLen, face: 'right' }
    }
  }
}

/** The anchor index (0..11) whose border point is closest to `p` (snap a port). */
export function anchorIndexNearest(b: Box, p: Pt): number {
  let best = SIDE_CENTER_ANCHOR.top
  let bd = Infinity
  for (let i = 0; i < 12; i++) {
    const a = anchorPoint(b, i)
    const d = Math.hypot(a.x - p.x, a.y - p.y)
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}

/** Directional raycast to the border toward `target` (mirrors getEdgePoint core;
 * the ≤8px corner-arc refinement is omitted as negligible for metrics/preview). */
export function edgePoint(b: Box, target: Pt): { x: number; y: number; face: Face } {
  const c = center(b)
  const angle = Math.atan2(target.y - c.y, target.x - c.x)
  const hw = b.width / 2
  const hh = b.height / 2
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const scaleX = Math.abs(hw / dx)
  const scaleY = Math.abs(hh / dy)
  const scale = Math.min(scaleX, scaleY)
  const x = c.x + dx * scale
  const y = c.y + dy * scale
  const face: Face = scaleX < scaleY ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top'
  return { x, y, face }
}

const NORMALS: Record<Face, Pt> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

export function controlPoints(
  fromEdge: { x: number; y: number; face: Face },
  toEdge: { x: number; y: number; face: Face },
  shape: LineShape,
): { cp1x: number; cp1y: number; cp2x: number; cp2y: number } {
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
  const ctrl = Math.min(Math.max(dist * 0.4, 30), 150)
  const fn = NORMALS[fromEdge.face]
  const tn = NORMALS[toEdge.face]
  return {
    cp1x: fromEdge.x + fn.x * ctrl,
    cp1y: fromEdge.y + fn.y * ctrl,
    cp2x: toEdge.x + tn.x * ctrl,
    cp2y: toEdge.y + tn.y * ctrl,
  }
}

export function buildSegments(
  fromEdge: { x: number; y: number; face: Face },
  toEdge: { x: number; y: number; face: Face },
  waypoints: Pt[],
  shape: LineShape,
): CubicSeg[] {
  if (waypoints.length === 0) {
    const cp = controlPoints(fromEdge, toEdge, shape)
    return [{ x0: fromEdge.x, y0: fromEdge.y, ...cp, x1: toEdge.x, y1: toEdge.y }]
  }
  const pts: Pt[] = [{ x: fromEdge.x, y: fromEdge.y }, ...waypoints, { x: toEdge.x, y: toEdge.y }]
  const segs: CubicSeg[] = []
  if (shape === 'straight') {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      segs.push({
        x0: a.x, y0: a.y,
        cp1x: a.x + (b.x - a.x) / 3, cp1y: a.y + (b.y - a.y) / 3,
        cp2x: a.x + ((b.x - a.x) * 2) / 3, cp2y: a.y + ((b.y - a.y) * 2) / 3,
        x1: b.x, y1: b.y,
      })
    }
    return segs
  }
  // Uniform Catmull-Rom → cubic Bézier.
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? pts[i + 1]
    segs.push({
      x0: p1.x, y0: p1.y,
      cp1x: p1.x + (p2.x - p0.x) / 6, cp1y: p1.y + (p2.y - p0.y) / 6,
      cp2x: p2.x - (p3.x - p1.x) / 6, cp2y: p2.y - (p3.y - p1.y) / 6,
      x1: p2.x, y1: p2.y,
    })
  }
  return segs
}

/** Resolve the two endpoints of an edge: anchored when locked, else raycast. */
export function resolveEndpoints(
  fromBox: Box,
  toBox: Box,
  style: EdgeStyle,
): { fromEdge: { x: number; y: number; face: Face }; toEdge: { x: number; y: number; face: Face } } {
  const fromC = center(fromBox)
  const toC = center(toBox)
  const fromEdge =
    style.lockedToAnchors && style.fromAnchor !== undefined
      ? anchorPoint(fromBox, style.fromAnchor)
      : edgePoint(fromBox, toC)
  const toEdge =
    style.lockedToAnchors && style.toAnchor !== undefined
      ? anchorPoint(toBox, style.toAnchor)
      : edgePoint(toBox, fromC)
  return { fromEdge, toEdge }
}

export function cubicAt(seg: CubicSeg, t: number): Pt {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * seg.x0 + b * seg.cp1x + c * seg.cp2x + d * seg.x1,
    y: a * seg.y0 + b * seg.cp1y + c * seg.cp2y + d * seg.y1,
  }
}

/** First derivative (tangent vector) of a cubic Bézier at t (un-normalised). */
export function cubicTangentAt(seg: CubicSeg, t: number): Pt {
  const mt = 1 - t
  const a = 3 * mt * mt
  const b = 6 * mt * t
  const c = 3 * t * t
  return {
    x: a * (seg.cp1x - seg.x0) + b * (seg.cp2x - seg.cp1x) + c * (seg.x1 - seg.cp2x),
    y: a * (seg.cp1y - seg.y0) + b * (seg.cp2y - seg.cp1y) + c * (seg.y1 - seg.cp2y),
  }
}

// Map a path-global t∈[0,1] to (segment index, local t). Mirrors CanvasEngine's
// getPathPoint/getPathTangent: t is distributed UNIFORMLY ACROSS SEGMENTS (not by arc
// length), so for an n-segment path segment i owns t∈[i/n,(i+1)/n].
function segmentAt(segments: CubicSeg[], t: number): { seg: CubicSeg; lt: number } {
  const n = segments.length
  const scaled = Math.max(0, Math.min(1, t)) * n
  const i = Math.min(n - 1, Math.floor(scaled))
  return { seg: segments[i], lt: scaled - i }
}

/** Point on the full path at global t (faithful to CanvasEngine getPathPoint). */
export function pathPointAt(segments: CubicSeg[], t: number): Pt {
  if (segments.length === 0) return { x: 0, y: 0 }
  const { seg, lt } = segmentAt(segments, t)
  return cubicAt(seg, lt)
}

/** Unit tangent on the full path at global t (faithful to CanvasEngine getPathTangent). */
export function pathTangentAt(segments: CubicSeg[], t: number): Pt {
  if (segments.length === 0) return { x: 1, y: 0 }
  const { seg, lt } = segmentAt(segments, t)
  const tan = cubicTangentAt(seg, lt)
  const len = Math.hypot(tan.x, tan.y) || 1
  return { x: tan.x / len, y: tan.y / len }
}

/** Sample the whole path into a polyline (for metrics + svg `d`). */
export function samplePath(segments: CubicSeg[], perSeg = 14): Pt[] {
  const out: Pt[] = []
  segments.forEach((seg, si) => {
    const start = si === 0 ? 0 : 1
    for (let k = start; k <= perSeg; k++) out.push(cubicAt(seg, k / perSeg))
  })
  return out
}

export function polylineLength(pts: Pt[]): number {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return len
}

/** Full faithful geometry of one connection: segments, sampled polyline, endpoints. */
export function connectionGeometry(
  fromBox: Box,
  toBox: Box,
  style: EdgeStyle,
): { segments: CubicSeg[]; polyline: Pt[]; fromEdge: { x: number; y: number; face: Face }; toEdge: { x: number; y: number; face: Face } } {
  const { fromEdge, toEdge } = resolveEndpoints(fromBox, toBox, style)
  const segments = buildSegments(fromEdge, toEdge, style.waypoints ?? [], style.shape ?? 'curved')
  return { segments, polyline: samplePath(segments), fromEdge, toEdge }
}

/** Point a short distance back from the target edge, for arrowhead placement. */
export function arrowBase(toEdge: Pt, prev: Pt): Pt {
  const ang = Math.atan2(toEdge.y - prev.y, toEdge.x - prev.x)
  return { x: toEdge.x - ARROW * Math.cos(ang), y: toEdge.y - ARROW * Math.sin(ang) }
}

/** Build an SVG path `d` for cubic segments. */
export function segmentsToPathD(segments: CubicSeg[]): string {
  if (segments.length === 0) return ''
  let d = `M ${segments[0].x0.toFixed(1)} ${segments[0].y0.toFixed(1)}`
  for (const s of segments) {
    d += ` C ${s.cp1x.toFixed(1)} ${s.cp1y.toFixed(1)}, ${s.cp2x.toFixed(1)} ${s.cp2y.toFixed(1)}, ${s.x1.toFixed(1)} ${s.y1.toFixed(1)}`
  }
  return d
}
