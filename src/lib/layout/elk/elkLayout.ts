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

// Lay out one diagram with ELK for a given strategy, and map the result onto the
// app model (object/group rectangles, connection waypoints, distributed anchor
// ports). Boundary groups become ELK compound nodes so members sit inside and
// externals stay outside. Returns a scored LayoutSolution (faithful metrics).

import type { Diagram } from '../../../types'
import { getElk, type ElkNode } from './elkClient'
import { rootOptions, type Strategy } from './elkConfig'
import {
  analyzeGraphComplexity,
  boundaryGroupsOf,
  buildLayoutGraph,
  contentBounds,
  groupTextBands,
  measureLaidOut,
  packIsolatedBelow,
  repairRoute,
  snapAlignBoxes,
  splitIsolatedNodes,
  type LaidEdge,
  type LayoutContext,
  type LayoutSolution,
  type ConnPatch,
} from '../graph'
import { assignAnchors } from '../ports'
import type { Box } from '../geometry'
import { groupHeaderBandHeight, headerTextWidth, GROUP_FOOTER_PAD, GROUP_STD_PAD_TOP, type Rect } from '../metrics'

const GROUP_PAD = 30
// Standard (non-parent) model-level groups reserve GROUP_STD_PAD_TOP on top for the icon +
// title row (shared via metrics.ts with the canvas + custom layout + preview). Parent-wrapper
// boundaries instead reserve a per-group centered-header band on top (groupHeaderBandHeight) +
// GROUP_FOOTER_PAD below, matching the identity stack the canvas renders.

// Interior spacing for boundary compounds. ELK applies its DEFAULT nodeNode (20)
// *inside* compounds — the generous root spacing in elkConfig does NOT propagate
// through INCLUDE_CHILDREN — so members crammed in a boundary crowd at minGap=20
// while root-level nodes breathe at 60+. Setting spacing per-compound lifts the
// interior gap WITHOUT touching the root MULTI_EDGE wrapping cliff (which is what
// regresses crossings when the *root* spacing is bumped — see elkConfig).
//
// Vision-QA swept 30/40/50 × {layers 30/40/60} across the 23 fixtures: 40/40 is the
// optimum — it doubles every crowded interior (minGap 20→40 on the 9 compound
// diagrams) and collapses edge-label overlaps (16→5 total: FSContainers 5→3,
// big-bank Components 4→1, DataverseComponents 3→0, VuesDesFormulairesOracle 2→0)
// with all hard gates still clean (nodeOverlaps/edgeNodeOverlaps/boundary = 0).
// Cost: +3 crossings, all on FSContainers, whose interior reshuffles the moment it
// gets ANY room above 20 (it sits at 4 for every spacing ≥ 30, so the trade is
// fixed, not magnitude-driven); they read as external-actor edges entering the
// boundary and the net is a clear readability gain. Higher than 40 only adds
// crossings (50/60 → 23) for no further label benefit; 30 keeps the crossings but
// loses the label win (labelOv 12). Re-run the QA sweep before changing.
const GROUP_SPACING_NODE = 40
const GROUP_SPACING_LAYERS = 40

// Rough px width of a group title at a given font size (Segoe UI ≈ 0.55em/char).
// Used to give the boundary compound a minimum width so the top-left title (drawn
// with no clipping by the canvas) fits inside the box instead of overflowing.
const titleMinWidth = (name: string, fontSize = 13) =>
  Math.ceil((name?.length ?? 0) * fontSize * 0.55) + 40

export async function layoutDiagramElk(
  diagram: Diagram,
  ctx: LayoutContext,
  strategy: Strategy,
): Promise<LayoutSolution | null> {
  const objectById = new Map(ctx.objects.map((o) => [o.id, o]))
  const { nodes, edges } = buildLayoutGraph(diagram, objectById, ctx.groups, ctx.connections)
  if (nodes.length === 0) return null

  const nodeSet = new Set(nodes.map((n) => n.id))
  const boundaries = boundaryGroupsOf(diagram, ctx.groups, nodeSet)
  const boundaryOf = new Map<string, string>()
  for (const b of boundaries) for (const m of b.memberIds) if (!boundaryOf.has(m)) boundaryOf.set(m, b.id)

  // Degree-0 nodes leave the ELK graph and get grid-packed below the wired content
  // instead (ELK strings them into an ~8:1 one-row sliver; its component packing
  // can't be optioned out of that — see splitIsolatedNodes). Members of any
  // on-diagram group are exempt: their group's box derives from member positions.
  const groupedIds = new Set<string>()
  for (const gid of diagram.groupIds) {
    const g = ctx.groups.find((x) => x.id === gid)
    if (g) for (const oid of g.objectIds) groupedIds.add(oid)
  }
  const complexity = analyzeGraphComplexity(nodes, edges)
  const { connected, isolated } = splitIsolatedNodes(nodes, edges, groupedIds)

  // Build the ELK graph.
  const groupName = new Map(ctx.groups.map((g) => [g.id, g.name]))
  // Per-group header geometry, mirroring the canvas exactly: the reserved top-band
  // height (centered identity stack) and the widest header line (for the masking band).
  const groupHeaderH = new Map(ctx.groups.map((g) => [g.id, groupHeaderBandHeight(g)]))
  const groupHeaderW = new Map(ctx.groups.map((g) => [g.id, headerTextWidth(g.name, g.type, g.description)]))
  const compoundNodes = new Map<string, ElkNode>()
  for (const b of boundaries) {
    // top reserves the per-group centered-header band so the lowest member can't sit on
    // it; bottom is the slim footer (no text there now). nodeSize.minimum floors the
    // compound width to the title width so the header fits inside the box.
    const minW = titleMinWidth(groupName.get(b.id) ?? '')
    const topPad = groupHeaderH.get(b.id) ?? GROUP_STD_PAD_TOP
    compoundNodes.set(b.id, {
      id: b.id,
      layoutOptions: {
        'elk.padding': `[top=${topPad},left=${GROUP_PAD},bottom=${GROUP_FOOTER_PAD},right=${GROUP_PAD}]`,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${minW},0)`,
        // Interior breathing room (members default to nodeNode=20 otherwise).
        'elk.spacing.nodeNode': `${GROUP_SPACING_NODE}`,
        'elk.layered.spacing.nodeNodeBetweenLayers': `${GROUP_SPACING_LAYERS}`,
      },
      children: [],
    })
  }
  const rootChildren: ElkNode[] = []
  for (const n of connected) {
    const elkNode: ElkNode = { id: n.id, width: n.width, height: n.height }
    const bId = boundaryOf.get(n.id)
    if (bId && compoundNodes.has(bId)) compoundNodes.get(bId)!.children!.push(elkNode)
    else rootChildren.push(elkNode)
  }
  for (const c of compoundNodes.values()) rootChildren.push(c)

  // ── map node positions to world coordinates ─────────────────────────────────
  const objectBoxes = new Map<string, Box>()
  const groupBoxes = new Map<string, Box>()
  if (rootChildren.length > 0) {
    const graph: ElkNode = {
      id: 'root',
      layoutOptions: rootOptions(strategy, complexity),
      children: rootChildren,
      edges: edges.map((e) => ({ id: e.id, sources: [e.fromId], targets: [e.toId] })),
    }

    let res: ElkNode
    try {
      const elk = await getElk()
      res = await elk.layout(graph)
    } catch {
      return null
    }

    const collect = (node: ElkNode, ox: number, oy: number) => {
      for (const child of node.children ?? []) {
        const x = ox + (child.x ?? 0)
        const y = oy + (child.y ?? 0)
        if (compoundNodes.has(child.id)) {
          groupBoxes.set(child.id, { x, y, width: child.width ?? 0, height: child.height ?? 0 })
          collect(child, x, y)
        } else {
          objectBoxes.set(child.id, { x, y, width: child.width ?? 0, height: child.height ?? 0 })
        }
      }
    }
    collect(res, 0, 0)

    // Snap near-miss rows/columns onto shared axes (guarded, same-zone only) before
    // anything derives from the positions — group bboxes, routing, metrics.
    snapAlignBoxes(objectBoxes, (id) => boundaryOf.get(id) ?? '__root')
  }

  // The isolated field: a uniform grid below the wired content, sized so the whole
  // page approaches the 1.6 target aspect. Grid boxes join objectBoxes so routing
  // obstacles, persisted layouts and metrics all see them.
  if (isolated.length > 0) {
    packIsolatedBelow(isolated, contentBounds(objectBoxes, groupBoxes), objectBoxes)
  }
  if (objectBoxes.size === 0) return null

  // Model-level groups (no parentObjectId): bbox of members + padding.
  for (const gid of diagram.groupIds) {
    if (groupBoxes.has(gid)) continue
    const g = ctx.groups.find((x) => x.id === gid)
    if (!g || g.parentObjectId) continue
    const members = g.objectIds.map((id) => objectBoxes.get(id)).filter(Boolean) as Box[]
    if (members.length < 2) continue
    const minX = Math.min(...members.map((m) => m.x))
    const minY = Math.min(...members.map((m) => m.y))
    const maxX = Math.max(...members.map((m) => m.x + m.width))
    const maxY = Math.max(...members.map((m) => m.y + m.height))
    // Floor the width to the title (font 11) so the top-left label fits; widen
    // symmetrically around the member bbox so the box stays centred on its content.
    // These are standard (non-parent) groups — legacy symmetric reservation, unchanged.
    const bboxW = maxX - minX + GROUP_PAD * 2
    const width = Math.max(bboxW, titleMinWidth(g.name, 11))
    const x = minX - GROUP_PAD - (width - bboxW) / 2
    groupBoxes.set(gid, {
      x,
      y: minY - GROUP_STD_PAD_TOP,
      width,
      height: maxY - minY + GROUP_STD_PAD_TOP + GROUP_PAD,
    })
  }

  // ── edges: curved, with faithful obstacle-avoidance routing ─────────────────
  // ELK gives the (excellent) node placement + boundaries; we draw curved edges
  // the canvas can reproduce exactly and route them around third-party nodes.
  const labelById = new Map<string, string>()
  for (const c of ctx.connections) if (c.label) labelById.set(c.id, c.label)

  const allRects: Rect[] = [...objectBoxes].map(([id, b]) => ({ id, ...b }))
  const obstaclesFor = (fromId: string, toId: string) => allRects.filter((r) => r.id !== fromId && r.id !== toId)

  // Distribute endpoints across the 12 anchor ports BEFORE routing — exactly like
  // the custom engine and measureDiagram do. This (a) fans hub edges across the
  // border instead of spraying from one point, and (b) makes the geometry we score
  // here identical to what the canvas/measureDiagram later re-derives from the same
  // positions, so the candidate ELK chooses is the candidate the canvas draws.
  const realEdges = edges.filter((e) => e.real)
  const anchors = assignAnchors(
    objectBoxes,
    realEdges.map((e) => ({ id: e.id, fromId: e.fromId, toId: e.toId })),
  )

  // Boundary descriptors (with their reserved top header bands) — computed BEFORE
  // routing so the soft zones can steer detours clear of the group's centered header,
  // exactly as `measureDiagram` does on the persisted state.
  const boundaryDescs = boundaries
    .map((b) => {
      const box = groupBoxes.get(b.id)
      return box
        ? {
            ...box,
            memberIds: new Set(b.memberIds),
            headerBandHeight: groupHeaderH.get(b.id) ?? GROUP_STD_PAD_TOP,
            headerTextWidth: groupHeaderW.get(b.id) ?? 0,
          }
        : null
    })
    .filter((b): b is NonNullable<typeof b> => b !== null)
  const softZones = groupTextBands(boundaryDescs)

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
      laid.push({ id: e.id, fromId: e.fromId, toId: e.toId, real: true, waypoints: wp, ...style })
      connPatches[e.id] = { waypoints: wp.length ? wp : undefined, fromAnchor: a?.fromAnchor, toAnchor: a?.toAnchor, lockedToAnchors: locked, shape: 'curved' }
    } else {
      const wp = repairRoute(fromBox, toBox, { shape: 'curved' }, obstaclesFor(e.fromId, e.toId), softZones)
      laid.push({ id: e.id, fromId: e.fromId, toId: e.toId, real: false, waypoints: wp, shape: 'curved' })
    }
  }

  const { edgeGeoms, metrics, labelPlacements } = measureLaidOut(objectBoxes, laid, labelById, boundaryDescs)
  // Persist the de-collided label positions onto the connections so the canvas draws
  // each label exactly where the metric scored it (clear of other labels/nodes).
  for (const [id, pl] of labelPlacements) {
    const patch = connPatches[id]
    if (patch) {
      patch.labelPosition = pl.t
      patch.labelOffset = pl.offset
    }
  }

  const layouts: LayoutSolution['layouts'] = {}
  for (const [id, b] of objectBoxes) {
    layouts[id] = { position: { x: Math.round(b.x), y: Math.round(b.y) }, size: { width: b.width, height: b.height } }
  }
  for (const [id, b] of groupBoxes) {
    layouts[id] = {
      position: { x: Math.round(b.x), y: Math.round(b.y) },
      size: { width: Math.round(b.width), height: Math.round(b.height) },
    }
  }

  return { source: strategy.id, layouts, connPatches, edgeGeoms, metrics }
}
