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

// High-level auto-layout. Each diagram is laid out by a PORTFOLIO of ELK
// strategies (org.eclipse.elk.layered with orthogonal/spline routing, network-
// simplex / Brandes-Köpf placement, compound boundary nodes, distributed ports),
// scored by faithful visual metrics; the best candidate wins. A dependency-free
// custom Sugiyama engine is the synchronous fallback. See docs.

import type { Connection, Diagram, Position, Size } from '../../types'
import { layoutGraph, type Direction } from './engine'
import { assignAnchors } from './ports'
import { type Box } from './geometry'
import {
  boundaryBoxes,
  buildLayoutGraph,
  contentBounds,
  groupTextBands,
  measureLaidOut,
  packIsolatedBelow,
  repairRoute,
  snapAlignBoxes,
  splitIsolatedNodes,
  type ConnPatch,
  type LaidEdge,
  type LayoutContext,
  type LayoutSolution,
} from './graph'
import { groupHeaderBandHeight, groupTitleMinWidth, GROUP_FOOTER_PAD, GROUP_SIDE_PAD, GROUP_STD_PAD_TOP, type EdgeGeom, type LayoutMetrics, type Rect } from './metrics'
import { strategiesFor } from './elk/elkConfig'
import { layoutDiagramElk } from './elk/elkLayout'

export type { LayoutMetrics, Rect, EdgeGeom, Point } from './metrics'
export type { LayoutContext, LayoutSolution, ConnPatch } from './graph'
export { computeMetrics } from './metrics'

const GROUP_PAD = GROUP_SIDE_PAD
// Standard (non-parent) groups reserve GROUP_STD_PAD_TOP on top for the icon + title row
// (shared with the canvas + ELK + preview via metrics.ts). Parent-wrapper boundaries instead
// reserve a per-group header band (groupHeaderBandHeight) on top + GROUP_FOOTER_PAD below —
// matching the centered identity stack the canvas renders. See metrics.ts / CanvasEngine.

// Shared with the canvas, the ELK layout and the Structurizr JSON importer via
// metrics.ts — a group box narrower than its title spills the label out.
const titleMinWidth = groupTitleMinWidth

// ── custom (fallback) engine ─────────────────────────────────────────────────

/** Synchronous custom layered layout (the ELK fallback). Returns a LayoutSolution. */
export function layoutDiagram(diagram: Diagram, ctx: LayoutContext, direction: Direction = 'tb'): LayoutSolution {
  const objectById = new Map(ctx.objects.map((o) => [o.id, o]))
  const { nodes, edges } = buildLayoutGraph(diagram, objectById, ctx.groups, ctx.connections)

  // Same disconnected-field treatment as the ELK path: degree-0 nodes (except group
  // members) skip the layered engine — which would string them into one trailing row —
  // and grid-pack below the wired content instead.
  const groupedIds = new Set<string>()
  for (const gid of diagram.groupIds) {
    const g = ctx.groups.find((x) => x.id === gid)
    if (g) for (const oid of g.objectIds) groupedIds.add(oid)
  }
  const { connected, isolated } = splitIsolatedNodes(nodes, edges, groupedIds)
  const result = layoutGraph(connected, edges, { direction })

  const objectBoxes = new Map<string, Box>()
  for (const [id, n] of result.nodes) objectBoxes.set(id, { x: Math.round(n.x), y: Math.round(n.y), width: n.width, height: n.height })

  // Snap near-miss rows/columns to shared axes (guarded), then pack the isolated
  // field below everything the diagram draws (incl. group boxes — a wrapper's header
  // band extends past its members, so bounds come from the full pre-layouts).
  const zoneOf = new Map(nodes.map((n) => [n.id, n.groupId ?? '__root']))
  snapAlignBoxes(objectBoxes, (id) => zoneOf.get(id) ?? '__root')
  if (isolated.length > 0) {
    const pre = groupAndObjectLayouts(diagram, ctx, objectBoxes)
    const preBoxes = new Map(Object.entries(pre).map(([id, l]) => [id, { x: l.position.x, y: l.position.y, width: l.size.width, height: l.size.height }]))
    packIsolatedBelow(isolated, contentBounds(preBoxes), objectBoxes)
  }
  const rects: Rect[] = [...objectBoxes].map(([id, b]) => ({ id, ...b }))
  const obstaclesFor = (fromId: string, toId: string) => rects.filter((r) => r.id !== fromId && r.id !== toId)

  // Distribute endpoints across ports (kills hub spray on the fallback too), then
  // route the faithful curved path around third-party nodes.
  const realEdges = edges.filter((e) => e.real)
  const anchors = assignAnchors(objectBoxes, realEdges.map((e) => ({ id: e.id, fromId: e.fromId, toId: e.toId })))

  const labelById = new Map<string, string>()
  for (const c of ctx.connections) if (c.label) labelById.set(c.id, c.label)

  // Boundary boxes (and their title/description soft zones) are needed at ROUTING time
  // so the fallback steers edges clear of group text too — exactly as the ELK path does.
  const layouts = groupAndObjectLayouts(diagram, ctx, objectBoxes)
  const boundaries = boundaryBoxes(diagram, ctx.groups, (id) => layouts[id])
  const softZones = groupTextBands(boundaries)

  const laid: LaidEdge[] = []
  const connPatches: Record<string, ConnPatch> = {}
  for (const e of edges) {
    const fromBox = objectBoxes.get(e.fromId)
    const toBox = objectBoxes.get(e.toId)
    if (!fromBox || !toBox) continue
    if (e.real) {
      const a = anchors.get(e.id)
      const locked = a?.fromAnchor !== undefined || a?.toAnchor !== undefined
      const style = { shape: 'curved' as const, fromAnchor: a?.fromAnchor, toAnchor: a?.toAnchor, lockedToAnchors: locked }
      const wp = repairRoute(fromBox, toBox, style, obstaclesFor(e.fromId, e.toId), softZones)
      laid.push({ id: e.id, fromId: e.fromId, toId: e.toId, real: true, waypoints: wp, shape: 'curved', fromAnchor: a?.fromAnchor, toAnchor: a?.toAnchor, lockedToAnchors: locked })
      connPatches[e.id] = { waypoints: wp.length ? wp : undefined, fromAnchor: a?.fromAnchor, toAnchor: a?.toAnchor, lockedToAnchors: locked, shape: 'curved' }
    } else {
      const wp = repairRoute(fromBox, toBox, { shape: 'curved' }, obstaclesFor(e.fromId, e.toId), softZones)
      laid.push({ id: e.id, fromId: e.fromId, toId: e.toId, real: false, waypoints: wp, shape: 'curved' })
    }
  }

  const { edgeGeoms, metrics, labelPlacements } = measureLaidOut(objectBoxes, laid, labelById, boundaries)
  for (const [id, pl] of labelPlacements) {
    const patch = connPatches[id]
    if (patch) {
      patch.labelPosition = pl.t
      patch.labelOffset = pl.offset
    }
  }
  return { source: 'custom', layouts, connPatches, edgeGeoms, metrics }
}

/** Object layouts + group boundary boxes (bbox of members + padding). */
function groupAndObjectLayouts(
  diagram: Diagram,
  ctx: LayoutContext,
  objectBoxes: Map<string, Box>,
): Record<string, { position: Position; size: Size }> {
  const layouts: Record<string, { position: Position; size: Size }> = {}
  for (const [id, b] of objectBoxes) layouts[id] = { position: { x: b.x, y: b.y }, size: { width: b.width, height: b.height } }
  for (const gid of diagram.groupIds) {
    const g = ctx.groups.find((x) => x.id === gid)
    if (!g) continue
    const members = g.objectIds.map((oid) => objectBoxes.get(oid)).filter(Boolean) as Box[]
    if (members.length === 0) continue
    const minX = Math.min(...members.map((m) => m.x))
    const minY = Math.min(...members.map((m) => m.y))
    const maxX = Math.max(...members.map((m) => m.x + m.width))
    const maxY = Math.max(...members.map((m) => m.y + m.height))
    // Parent wrappers reserve a per-group centered-header band on top (sized exactly to
    // the canvas's identity stack) and a slim footer below; standard groups keep the
    // legacy symmetric reservation. Both kinds floor their width to the title so the
    // label never overflows the box.
    const isParentWrapper = !!g.parentObjectId
    const topPad = isParentWrapper ? groupHeaderBandHeight(g) : GROUP_STD_PAD_TOP
    const bottomPad = isParentWrapper ? GROUP_FOOTER_PAD : GROUP_PAD
    const bboxW = maxX - minX + GROUP_PAD * 2
    const width = Math.max(bboxW, titleMinWidth(g.name, isParentWrapper ? 13 : 11))
    const x = minX - GROUP_PAD - (width - bboxW) / 2
    layouts[gid] = {
      position: { x: Math.round(x), y: Math.round(minY - topPad) },
      size: { width: Math.round(width), height: Math.round(maxY - minY + topPad + bottomPad) },
    }
  }
  return layouts
}

// ── portfolio selection ──────────────────────────────────────────────────────

/** A laid-out result passes the hard "no overlaps / no spaghetti" gates.
 *
 * `labelOverlaps` is deliberately NOT a gate: labels are actively de-collided
 * (`placeLabels`) and otherwise governed by the weighted score (label weight 15 ≪
 * descBand 150). Making it a gate let a label-clean candidate beat a lower-score one
 * REGARDLESS of score — so de-collision could flip selection onto a layout that
 * sacrificed the description band (descBand 0→3) just to clear residual labels. Let
 * the score arbitrate label vs. band vs. bends instead. */
export function passesGates(m: LayoutMetrics): boolean {
  return (
    m.nodeOverlaps === 0 &&
    m.minGap > 0 &&
    m.edgeNodeOverlaps === 0 &&
    m.boundaryViolations === 0 &&
    m.hubSpread >= 0.5 &&
    m.edgeCrossings <= Math.max(1, Math.ceil(m.edgeCount * 0.35))
  )
}

/** Hard, non-negotiable violations: overlapping shapes, edges through shapes, or
 * external nodes trapped inside a system/container boundary box. */
function hardViolations(m: LayoutMetrics): number {
  return m.nodeOverlaps + m.edgeNodeOverlaps + m.boundaryViolations + (m.minGap <= 0 ? 1 : 0)
}

/** Rank: fewest hard violations first, then gate-passers, then lowest score. */
function better(a: LayoutSolution, b: LayoutSolution): LayoutSolution {
  const ha = hardViolations(a.metrics)
  const hb = hardViolations(b.metrics)
  if (ha !== hb) return ha < hb ? a : b
  const pa = passesGates(a.metrics)
  const pb = passesGates(b.metrics)
  if (pa !== pb) return pa ? a : b
  return a.metrics.score <= b.metrics.score ? a : b
}

/** Best layout for one diagram: ELK portfolio + custom fallback, lowest score wins. */
export async function bestLayout(
  diagram: Diagram,
  ctx: LayoutContext,
  hint?: Direction,
): Promise<LayoutSolution> {
  const candidates: LayoutSolution[] = []
  const strategies = strategiesFor(hint)
  const elkResults = await Promise.all(
    strategies.map((s) => layoutDiagramElk(diagram, ctx, s).catch(() => null)),
  )
  for (const r of elkResults) if (r) candidates.push(r)

  // Always include the custom engine as a safety net.
  const custom = layoutDiagram(diagram, ctx, hint ?? 'tb')
  candidates.push(custom)

  return candidates.reduce((best, c) => better(best, c))
}

export interface LayoutReport {
  perDiagram: Record<string, { chosen: string; score: number; passed: boolean; candidates: Array<{ source: string; score: number; passed: boolean }> }>
}

/** Apply a per-connection style patch to a connection (immutably). The layout OWNS
 * the anchor state it scored: an end the patch leaves undefined must be CLEARED, not
 * kept — a stale anchor surviving here gets re-locked and the canvas then draws a
 * different (worse) line than every candidate the portfolio measured, and no later
 * re-layout could ever take the connection off that port. */
function applyPatch(c: Connection, patch: ConnPatch): Connection {
  const next: Connection = { ...c }
  if (patch.waypoints && patch.waypoints.length) next.waypoints = patch.waypoints
  else delete next.waypoints
  if (patch.lockedToAnchors && (patch.fromAnchor !== undefined || patch.toAnchor !== undefined)) {
    next.lockedToAnchors = true
    if (patch.fromAnchor !== undefined) next.fromAnchor = patch.fromAnchor
    else delete next.fromAnchor
    if (patch.toAnchor !== undefined) next.toAnchor = patch.toAnchor
    else delete next.toAnchor
  } else {
    next.lockedToAnchors = false
    delete next.fromAnchor
    delete next.toAnchor
  }
  if (patch.shape) next.shape = patch.shape
  if (patch.labelPosition !== undefined) next.labelPosition = patch.labelPosition
  if (patch.labelOffset !== undefined) next.labelOffset = patch.labelOffset
  return next
}

/**
 * Lay out every diagram in a mapped workspace (async — ELK). Returns new diagram
 * + connection arrays (immutable): diagrams gain `layouts`, connections gain
 * waypoints/anchors/shape, plus a report of what was chosen.
 */
export async function applyAutoLayout(
  diagrams: Diagram[],
  ctx: LayoutContext,
  layoutHints: Record<string, { direction?: Direction }> = {},
): Promise<{ diagrams: Diagram[]; connections: Connection[]; report: LayoutReport }> {
  const patchByConn: Record<string, ConnPatch> = {}
  const report: LayoutReport = { perDiagram: {} }
  const outDiagrams: Diagram[] = []
  for (const d of diagrams) {
    const sol = await bestLayout(d, ctx, layoutHints[d.id]?.direction)
    Object.assign(patchByConn, sol.connPatches)
    report.perDiagram[d.id] = {
      chosen: sol.source,
      score: sol.metrics.score,
      passed: passesGates(sol.metrics),
      candidates: [{ source: sol.source, score: sol.metrics.score, passed: passesGates(sol.metrics) }],
    }
    outDiagrams.push({ ...d, layouts: sol.layouts })
  }
  const outConnections = ctx.connections.map((c) => (patchByConn[c.id] ? applyPatch(c, patchByConn[c.id]) : c))
  return { diagrams: outDiagrams, connections: outConnections, report }
}

// ── 3D board profile ─────────────────────────────────────────────────────────
// The tilted view foreshortens Y by cos(rx) and lifts card faces/standee drums
// above their footprints, so a 2D-tuned layout reads cramped and occluded on the
// board. The ROOT ELK spacing values sit on a tuned cliff (see elkConfig.ts) and
// MUST NOT be inflated — instead the 3D profile POST-STRETCHES the winning
// solution vertically: same topology, same crossings, same wrapping; projected
// through the camera the spacing reads exactly like the 2D layout plus headroom.

/** Vertical stretch for a board tilted by `rxDeg`: 1/cos restores the 2D visual
 * rhythm after foreshortening; ×1.15 adds clearance for lifted faces/drums. */
export function iso3dVerticalStretch(rxDeg: number): number {
  const c = Math.cos((rxDeg * Math.PI) / 180)
  return c > 0.05 ? 1.15 / c : 1.15 / 0.05
}

/** Stretch a layout solution vertically by `k` (in place on copies): object/group
 * tops scale as y' = y·k; GROUP heights scale too (they span rows — the slack
 * to their members provably grows); object sizes stay. Waypoints ride along. */
export function stretchSolutionVertically(
  layouts: Record<string, { position: Position; size: Size }>,
  connPatches: Record<string, ConnPatch>,
  k: number,
  groupIds: ReadonlySet<string>,
): { layouts: Record<string, { position: Position; size: Size }>; connPatches: Record<string, ConnPatch> } {
  if (k === 1) return { layouts, connPatches }
  const outLayouts: Record<string, { position: Position; size: Size }> = {}
  for (const [id, l] of Object.entries(layouts)) {
    const isGroup = groupIds.has(id)
    outLayouts[id] = {
      position: { x: l.position.x, y: Math.round(l.position.y * k) },
      size: isGroup
        ? { width: l.size.width, height: Math.round(l.size.height * k) }
        : { ...l.size },
    }
  }
  const outPatches: Record<string, ConnPatch> = {}
  for (const [id, p] of Object.entries(connPatches)) {
    outPatches[id] = {
      ...p,
      waypoints: p.waypoints?.map((w) => ({ x: w.x, y: Math.round(w.y * k) })),
    }
  }
  return { layouts: outLayouts, connPatches: outPatches }
}

/** Optimize a single existing diagram (the on-canvas "Auto-layout" button).
 * `opts.space: '3d'` applies the board profile (vertical stretch for the given
 * camera tilt) to the winning solution — the 2D layout path is untouched. */
export async function optimizeDiagram(
  diagram: Diagram,
  ctx: LayoutContext,
  hint?: Direction,
  opts?: { space?: '2d' | '3d'; cameraRx?: number },
): Promise<{ layouts: Record<string, { position: Position; size: Size }>; connPatches: Record<string, ConnPatch> }> {
  const sol = await bestLayout(diagram, ctx, hint)
  if (opts?.space === '3d') {
    const k = iso3dVerticalStretch(opts.cameraRx ?? 55)
    return stretchSolutionVertically(sol.layouts, sol.connPatches, k, new Set(diagram.groupIds))
  }
  return { layouts: sol.layouts, connPatches: sol.connPatches }
}

// ── measurement of persisted state (faithful) ───────────────────────────────

/** Measure a laid-out diagram from its persisted `layouts` + connection styles. */
export function measureDiagram(
  diagram: Diagram,
  ctx: LayoutContext,
): { rects: Rect[]; edges: EdgeGeom[]; metrics: LayoutMetrics } {
  const objectById = new Map(ctx.objects.map((o) => [o.id, o]))
  const { edges } = buildLayoutGraph(diagram, objectById, ctx.groups, ctx.connections)

  const objectBoxes = new Map<string, Box>()
  for (const id of diagram.objectIds) {
    const o = objectById.get(id)
    if (!o) continue
    const layout = diagram.layouts?.[id]
    const pos = layout?.position ?? o.position
    const size = layout?.size ?? o.size
    objectBoxes.set(id, { x: pos.x, y: pos.y, width: size.width, height: size.height })
  }
  const rects: Rect[] = [...objectBoxes].map(([id, b]) => ({ id, ...b }))
  const obstaclesFor = (fromId: string, toId: string) => rects.filter((r) => r.id !== fromId && r.id !== toId)

  const labelById = new Map<string, string>()
  for (const c of ctx.connections) if (c.label) labelById.set(c.id, c.label)

  // Measure THIS diagram's achievable routing from its node positions — not the
  // shared connection's persisted waypoints, which (for an edge shown on several
  // diagrams) may carry another diagram's routing. Mirrors the layout routing.
  const boundaries = boundaryBoxes(diagram, ctx.groups, (id) => diagram.layouts?.[id])
  const softZones = groupTextBands(boundaries)
  const realEdges = edges.filter((e) => e.real)
  const anchors = assignAnchors(objectBoxes, realEdges.map((e) => ({ id: e.id, fromId: e.fromId, toId: e.toId })))
  const laid: LaidEdge[] = edges.map((e) => {
    const fb = objectBoxes.get(e.fromId)
    const tb = objectBoxes.get(e.toId)
    if (!fb || !tb) return { id: e.id, fromId: e.fromId, toId: e.toId, real: e.real, waypoints: [], shape: 'curved' as const }
    if (e.real) {
      const a = anchors.get(e.id)
      const locked = a?.fromAnchor !== undefined || a?.toAnchor !== undefined
      const style = { shape: 'curved' as const, fromAnchor: a?.fromAnchor, toAnchor: a?.toAnchor, lockedToAnchors: locked }
      const wp = repairRoute(fb, tb, style, obstaclesFor(e.fromId, e.toId), softZones)
      return { id: e.id, fromId: e.fromId, toId: e.toId, real: true, waypoints: wp, ...style }
    }
    const wp = repairRoute(fb, tb, { shape: 'curved' }, obstaclesFor(e.fromId, e.toId), softZones)
    return { id: e.id, fromId: e.fromId, toId: e.toId, real: false, waypoints: wp, shape: 'curved' as const }
  })

  const { edgeGeoms, metrics } = measureLaidOut(objectBoxes, laid, labelById, boundaries)
  return { rects, edges: edgeGeoms, metrics }
}
