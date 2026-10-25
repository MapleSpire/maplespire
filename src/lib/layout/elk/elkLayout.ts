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
  deriveGroupBoxes,
  groupPadding,
  groupTextBands,
  layeringEdges,
  measureLaidOut,
  modelGroupBoundaries,
  nestGroups,
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
import { groupHeaderBandHeight, headerTextWidth, GROUP_STD_PAD_TOP, type BoundaryBox, type Rect } from '../metrics'

// Group padding comes from graph.ts `groupPadding`, shared with the custom engine:
// standard (non-parent) groups reserve GROUP_STD_PAD_TOP on top for the icon + title
// row; parent-wrapper boundaries a per-group centred-header band
// (groupHeaderBandHeight) + GROUP_FOOTER_PAD below, matching what the canvas renders.

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

/**
 * `placements`, shared across one portfolio run, maps a placement (every shape and
 * group box) to the solution already routed and scored for it. Two strategies often
 * place identically — a graph short enough never triggers row wrapping, so a
 * strategy and its `-nowrap` twin agree — and routing + scoring is most of a
 * candidate's cost; the twin reuses the result under its own strategy id. Only on
 * the calling thread: layout workers run one candidate each and pass none, so a
 * twin is routed again there (same result, in parallel).
 */
export async function layoutDiagramElk(
  diagram: Diagram,
  ctx: LayoutContext,
  strategy: Strategy,
  placements?: Map<string, LayoutSolution>,
): Promise<LayoutSolution | null> {
  const objectById = new Map(ctx.objects.map((o) => [o.id, o]))
  const { nodes, edges } = buildLayoutGraph(diagram, objectById, ctx.groups, ctx.connections)
  if (nodes.length === 0) return null

  const nodeSet = new Set(nodes.map((n) => n.id))
  const boundaries = boundaryGroupsOf(diagram, ctx.groups, nodeSet)
  const nesting = nestGroups(diagram, ctx.groups, nodeSet, ctx.groupDepths)

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
  // Per-group header geometry, mirroring the canvas exactly: the reserved top-band
  // height (centered identity stack) and the widest header line (for the masking band).
  const groupHeaderH = new Map(ctx.groups.map((g) => [g.id, groupHeaderBandHeight(g)]))
  const groupHeaderW = new Map(ctx.groups.map((g) => [g.id, headerTextWidth(g.name, g.type, g.description)]))
  const groupById = new Map(ctx.groups.map((g) => [g.id, g]))
  // Every group is a compound — boundaries, model-level groups ("Cloud", "Big Bank
  // plc") and the nodes of a deployment view — NESTED the way their membership nests,
  // so ELK keeps each group's members together and everyone else outside, at every
  // level. Before, only the first group to claim a member became a compound: a
  // non-member was placed inside the others (grouped.dsl's Legacy ERP inside
  // "Cloud"; big-bank DevelopmentDeployment's Mainframe inside "Developer Laptop").
  // A model group that only partly overlaps another cannot be one (a node has one
  // parent) and is laid out as loose nodes, as before. Every box is derived from
  // the members below, not taken from ELK.
  //
  // The title floor and its centring are written in ELK's INTERNAL frame. Layered
  // lays out left-to-right and rotates for DOWN, and a compound's minimum size and
  // content alignment are not rotated back (measured, elk.bundled 0.11.1: under
  // DOWN a minimum of (500,0) returned a 210×500 box, (0,500) a 500×172 one; only
  // V_CENTER centred the child horizontally). Written plainly, the floor reserved
  // HEIGHT, and deriveGroupBoxes then widened the box over its neighbours.
  const down = strategy.direction === 'DOWN'
  const compoundNodes = new Map<string, ElkNode>()
  for (const gid of nesting.ids) {
    if (nesting.loose.has(gid)) continue
    const pad = groupPadding(groupById.get(gid)!)
    compoundNodes.set(gid, {
      id: gid,
      layoutOptions: {
        // top reserves the header (a boundary's centred band, a group's title row) so
        // the highest member — or nested group — can't sit on it; nodeSize.minimum
        // floors the width to the title, centred on the content as deriveGroupBoxes
        // centres it, so the header fits inside a box ELK actually reserved.
        'elk.padding': `[top=${pad.top},left=${pad.side},bottom=${pad.bottom},right=${pad.side}]`,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': down ? `(0,${pad.titleFloor})` : `(${pad.titleFloor},0)`,
        'elk.contentAlignment': down ? '[V_CENTER, H_LEFT]' : '[H_CENTER, V_TOP]',
        // Interior breathing room (members default to nodeNode=20 otherwise).
        'elk.spacing.nodeNode': `${GROUP_SPACING_NODE}`,
        'elk.layered.spacing.nodeNodeBetweenLayers': `${GROUP_SPACING_LAYERS}`,
      },
      children: [],
    })
  }
  const rootChildren: ElkNode[] = []
  const parentChildren = (parentId: string | undefined) =>
    (parentId && compoundNodes.get(parentId)?.children) || rootChildren
  for (const n of connected) {
    parentChildren(nesting.compoundOf.get(n.id)).push({ id: n.id, width: n.width, height: n.height })
  }
  for (const [gid, c] of compoundNodes) parentChildren(nesting.compoundParent.get(gid)).push(c)

  // ── map node positions to world coordinates ─────────────────────────────────
  const objectBoxes = new Map<string, Box>()
  const groupBoxes = new Map<string, Box>()
  if (rootChildren.length > 0) {
    const graph: ElkNode = {
      id: 'root',
      layoutOptions: rootOptions(strategy, complexity),
      children: rootChildren,
      // ELK only PLACES the nodes (edges are re-routed below), so it ranks on the
      // C4 layering edges: people first, reciprocal pairs counted once.
      edges: layeringEdges(edges, (id) => objectById.get(id)?.type === 'actor')
        .map((e) => ({ id: e.id, sources: [e.fromId], targets: [e.toId] })),
    }

    let res: ElkNode
    try {
      const elk = await getElk()
      res = await elk.layout(graph)
    } catch {
      return null
    }

    // ELK PLACES the compounds (which keeps non-members out of them); their boxes
    // are derived from the members below, not taken from ELK.
    const collect = (node: ElkNode, ox: number, oy: number) => {
      for (const child of node.children ?? []) {
        const x = ox + (child.x ?? 0)
        const y = oy + (child.y ?? 0)
        if (compoundNodes.has(child.id)) collect(child, x, y)
        else objectBoxes.set(child.id, { x, y, width: child.width ?? 0, height: child.height ?? 0 })
      }
    }
    collect(res, 0, 0)

    // Snap near-miss rows/columns onto shared axes (guarded, same-zone only) before
    // anything derives from the positions — group bboxes, routing, metrics.
    snapAlignBoxes(objectBoxes, (id) => nesting.compoundOf.get(id) ?? '__root')
  }

  // Whole pixels, then every group box from its members, by the rules the canvas
  // draws it with (graph.ts deriveGroupBoxes), shared with the custom engine.
  // ELK's own compound box is fractional (members 30.5px in, width 245.5) and,
  // rounded apart from its members, came back a pixel off on re-import whenever a
  // strategy with fractional offsets won (roundTrip.test: no-views Containers-2
  // -54,-95 vs -55,-95; big-bank SystemLandscape -54,-23 vs -54,-24).
  for (const b of objectBoxes.values()) {
    b.x = Math.round(b.x)
    b.y = Math.round(b.y)
  }
  // Every group with a member on the diagram gets a box — a one-member model group
  // too. The legacy two-member rule left it out of the result, so the canvas kept
  // drawing its PRE-layout box (imported groups are autoSize:false) around a member
  // that had moved: 12 of 13 deployment nodes on big-bank LiveDeployment.
  for (const [gid, box] of deriveGroupBoxes(nesting, ctx.groups, objectBoxes)) groupBoxes.set(gid, box)

  // The isolated field: a uniform grid below the wired content, sized so the whole
  // page approaches the 1.6 target aspect. Grid boxes join objectBoxes so routing
  // obstacles, persisted layouts and metrics all see them.
  if (isolated.length > 0) {
    packIsolatedBelow(isolated, contentBounds(objectBoxes, groupBoxes), objectBoxes)
  }
  if (objectBoxes.size === 0) return null

  const placementKey = placements
    ? [...objectBoxes, ...groupBoxes]
        .map(([id, b]) => `${id}:${b.x},${b.y},${b.width},${b.height}`)
        .sort()
        .join('|')
    : ''
  const routed = placements?.get(placementKey)
  if (routed) return { ...routed, source: strategy.id }

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
  // as `measureDiagram` does on the persisted state. Deliberately NOT identical to
  // it: candidates are also scored on the MODEL-level groups (modelGroupBoundaries),
  // which measureDiagram leaves out because imported deployment views overlap by
  // design — see that function's note.
  const boundaryDescs: BoundaryBox[] = boundaries
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
  boundaryDescs.push(...modelGroupBoundaries(diagram, ctx.groups, (id) => groupBoxes.get(id)))
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

  const solution: LayoutSolution = { source: strategy.id, layouts, connPatches, edgeGeoms, metrics }
  placements?.set(placementKey, solution)
  return solution
}
