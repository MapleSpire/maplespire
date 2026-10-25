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

// Distribute connection endpoints across a node's 12 anchor ports so that hubs
// (high-degree nodes) fan their edges across the border instead of all leaving
// from one point ("spray"). Produces fromAnchor/toAnchor indices (0..11) to be
// written with lockedToAnchors:true. Used by the ELK mapping AND the custom
// fallback layout, so both stop spraying.
//
// An endpoint is pinned to a port ONLY when it would otherwise collide:
//
// 1. Every endpoint starts FREE — at its natural raycast point, what the canvas
//    draws unlocked — so a connection runs straight at its target instead of
//    being pinned off-centre and bowed into an S-curve.
// 2. Per node side, each endpoint either stays free or takes one of the side's
//    three ports (0.2/0.5/0.8), ports distinct. The choice is solved exactly
//    (a small DP over the side's endpoints in order) to keep every pair of
//    endpoints at least the hub-cluster tolerance apart (max(8, minNodeSide*0.25)
//    — the tolerance the hubSpread metric counts clusters with — capped just under
//    the side's own port spacing) and in order (no crossing at the border), then
//    to move each endpoint as little as possible,
//    then to pin as few as possible. The greedy rule this replaces pinned a whole
//    side as soon as two of its endpoints touched: one reciprocal pair collapsed
//    four or five well-separated edges onto three ports, two of them shared.
// 3. Parallel connections between the same two nodes (A→B with B→A, or
//    duplicates) always collide at both ends. Each is given a lane — a preferred
//    offset on a consistent side of the A–B centre line — so the pair splits into
//    two parallel lines instead of one braided line. A pair whose raycasts leave
//    a node through two sides near a corner is moved onto the side facing the
//    other node first (see the node loop). Seeded sweep of 1,677 random two-box
//    reciprocal pairs (placementQa.test.ts, "seeded sweep"): like ends within
//    8 px at a node 29 → 0; pairs crossing 1 → 3, all at tight gaps (~40 px)
//    with a large sideways offset, where both curves' near-horizontal middles
//    overlap whatever ports they use.
// 4. A free end aims at the far end's port when that end is pinned (the canvas's
//    rule, see geometry.resolveEndpoints), so pinning one end moves the other.
//    Nodes are solved lowest-degree first (meant to let a pair split on a
//    person's border reach the hub already apart, sparing the hub's scarce ports
//    — no geometry found yet where the order changes the result), and the whole
//    pass repeats until no port changes, so each side is solved against its far
//    ends' final ports.

import { type Box, type Face, anchorPoint, edgePoint, center, SIDE_BASE_ANCHOR } from './geometry'

export interface AnchorAssignment {
  fromAnchor?: number
  toAnchor?: number
}

export interface AnchorEdge {
  id: string
  fromId: string
  toId: string
}

export interface AssignOptions {
  /** When provided (ELK), gives the chosen border side per endpoint. */
  sideOf?: (edgeId: string, end: 'from' | 'to') => Face | undefined
}

/** Lane spacing for parallel connections, as a fraction of the side length. Wide
 * enough that a pair's two preferred points fall nearest two DIFFERENT ports
 * (ports sit 0.3 of the side apart). */
const LANE_FRACTION = 0.6
/** Passes over all nodes, repeated until no port changes: a later node's choice moves
 * the free ends aimed at it, so one pass is not a fixpoint in general (a fixed two
 * passes left colliding sides in a randomized review run on 2026-10-21; no test
 * pins it — a single pass survived the QA lens's mutation run). Capped because
 * nothing proves convergence. */
const MAX_PASSES = 6

interface Endpoint {
  edgeId: string
  end: 'from' | 'to'
  /** Coordinate of the endpoint's natural RAYCAST point along the side axis (x for
   * top/bottom, y for left/right) — where it is drawn when left free. */
  coord: number
  /** Where the endpoint would like to be: the natural point, shifted by its lane
   * when it is one of several connections between the same two nodes. */
  target: number
  /** The far aim along the side axis (orders same-target endpoints so the edge
   * heading further along the axis takes the further position). */
  otherCoord: number
  /** Forced onto a side its raycast does not exit through (`sideOf`): only a port
   * puts it there, so staying free costs a collision. */
  mustPin: boolean
}

/**
 * Choose, for endpoints sorted by preference, free (-1) or a port 0..2 each, ports
 * strictly increasing, minimising: order inversions and collisions (each costs at
 * least half of `penalty`, which dominates), then squared displacement from
 * `target`, then the number of pins. Exact DP over (endpoint, its choice, highest
 * port used).
 *
 * A collision is graded — two ends on one point cost the full penalty, a near miss
 * at the tolerance half — so when collisions cannot all be avoided the widest
 * spacing still wins. Flat costs made "all three ends on one point" tie with "three
 * ports" whenever the ports themselves sat inside the tolerance, and leaving them
 * free won on displacement: a spray, unpinned (review of this rewrite).
 */
function solveSide(eps: Endpoint[], ports: number[], tol: number, penalty: number): number[] {
  const n = eps.length
  const CH = ports.length + 1 // choice 0 = free, c ≥ 1 = port c-1
  const pos = (i: number, c: number) => (c === 0 ? eps[i].coord : ports[c - 1])
  const local = (i: number, c: number) =>
    (pos(i, c) - eps[i].target) ** 2 + (c === 0 ? (eps[i].mustPin ? penalty : 0) : 1)
  const between = (prev: number, cur: number) => {
    const gap = Math.abs(cur - prev)
    return (cur < prev - 0.5 ? penalty : 0) + (gap < tol ? penalty * (0.5 + (0.5 * (tol - gap)) / tol) : 0)
  }
  // cost[c][m]: best cost of endpoints 0..i with endpoint i choosing c and highest
  // port index used m (0 = none, k = port k-1).
  type Cell = { cost: number; prevC: number; prevM: number }
  const table: Cell[][][] = []
  for (let i = 0; i < n; i++) {
    const layer: Cell[][] = Array.from({ length: CH }, () =>
      Array.from({ length: CH }, () => ({ cost: Infinity, prevC: -1, prevM: -1 })),
    )
    for (let c = 0; c < CH; c++) {
      for (let pm = 0; pm < CH; pm++) {
        if (c > 0 && c <= pm) continue // ports strictly increase
        const m = c > 0 ? c : pm
        if (i === 0) {
          if (pm !== 0) continue
          const cost = local(0, c)
          if (cost < layer[c][m].cost) layer[c][m] = { cost, prevC: -1, prevM: -1 }
          continue
        }
        for (let pc = 0; pc < CH; pc++) {
          const prev = table[i - 1][pc][pm]
          if (!Number.isFinite(prev.cost)) continue
          const cost = prev.cost + local(i, c) + between(pos(i - 1, pc), pos(i, c))
          if (cost < layer[c][m].cost) layer[c][m] = { cost, prevC: pc, prevM: pm }
        }
      }
    }
    table.push(layer)
  }
  let bestC = 0
  let bestM = 0
  for (let c = 0; c < CH; c++) {
    for (let m = 0; m < CH; m++) {
      if (table[n - 1][c][m].cost < table[n - 1][bestC][bestM].cost) {
        bestC = c
        bestM = m
      }
    }
  }
  const choice = new Array<number>(n)
  for (let i = n - 1, c = bestC, m = bestM; i >= 0; i--) {
    choice[i] = c - 1
    const cell = table[i][c][m]
    c = cell.prevC
    m = cell.prevM
  }
  return choice
}

export function assignAnchors(
  rects: Map<string, Box>,
  edges: AnchorEdge[],
  opts: AssignOptions = {},
): Map<string, AnchorAssignment> {
  const result = new Map<string, AnchorAssignment>()

  // Cluster tolerance, identical to the hubSpread metric's: two attachment points
  // closer than this read as one cluster ("spray"); farther apart they are already
  // visually distinct and need no port pinning.
  let minSide = Infinity
  for (const b of rects.values()) minSide = Math.min(minSide, Math.min(b.width, b.height))
  const tol = Math.max(8, (Number.isFinite(minSide) ? minSide : 60) * 0.25)

  // Lanes for parallel connections: edges sharing an unordered node pair, centred
  // on 0 (−0.5/+0.5 for a pair), in edge-id order. The lane normal is taken on the
  // canonical (lower id → higher id) centre line so both ends agree on the side.
  const pairMembers = new Map<string, string[]>()
  for (const e of edges) {
    if (e.fromId === e.toId) continue
    const k = e.fromId < e.toId ? `${e.fromId}|${e.toId}` : `${e.toId}|${e.fromId}`
    const list = pairMembers.get(k) ?? []
    list.push(e.id)
    pairMembers.set(k, list)
  }
  const laneOf = new Map<string, number>()
  for (const ids of pairMembers.values()) {
    if (ids.length < 2) continue
    const sorted = [...ids].sort()
    sorted.forEach((id, i) => laneOf.set(id, i - (sorted.length - 1) / 2))
  }

  const byId = new Map(edges.map((e) => [e.id, e]))
  const incident = new Map<string, Array<{ edgeId: string; end: 'from' | 'to' }>>()
  for (const e of edges) {
    if (e.fromId === e.toId || !rects.has(e.fromId) || !rects.has(e.toId)) continue
    result.set(e.id, {})
    for (const [nodeId, end] of [[e.fromId, 'from'], [e.toId, 'to']] as const) {
      const list = incident.get(nodeId) ?? []
      list.push({ edgeId: e.id, end })
      incident.set(nodeId, list)
    }
  }

  // Where a FREE end is drawn: the raycast toward the far end's port when that end
  // is pinned, else toward the far centre — the canvas's own endpoint rule.
  const endpointFor = (
    nodeId: string,
    edgeId: string,
    end: 'from' | 'to',
    forcedSide?: Face,
  ): { side: Face; endpoint: Endpoint; point: { x: number; y: number }; otherId: string } => {
    const e = byId.get(edgeId)!
    const otherId = end === 'from' ? e.toId : e.fromId
    const box = rects.get(nodeId)!
    const other = rects.get(otherId)!
    const assigned = result.get(edgeId)!
    const farAnchor = end === 'from' ? assigned.toAnchor : assigned.fromAnchor
    const aim = farAnchor !== undefined ? anchorPoint(other, farAnchor) : center(other)
    const ray = edgePoint(box, aim)
    // A side the caller names wins over the corner rule's choice.
    const side = opts.sideOf?.(edgeId, end) ?? forcedSide ?? ray.face
    const alongX = side === 'top' || side === 'bottom'
    const coord = alongX ? ray.x : ray.y
    let target = coord
    const lane = laneOf.get(edgeId)
    if (lane) {
      const [lo, hi] = nodeId < otherId ? [box, other] : [other, box]
      const a = center(lo)
      const b = center(hi)
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
      const nAxis = alongX ? -(b.y - a.y) / len : (b.x - a.x) / len
      target = coord + lane * LANE_FRACTION * (alongX ? box.width : box.height) * nAxis
    }
    return {
      side,
      endpoint: { edgeId, end, coord, target, otherCoord: alongX ? aim.x : aim.y, mustPin: side !== ray.face },
      point: { x: ray.x, y: ray.y },
      otherId,
    }
  }

  const setAnchor = (edgeId: string, end: 'from' | 'to', anchor: number | undefined) => {
    const a = result.get(edgeId)!
    if (end === 'from') a.fromAnchor = anchor
    else a.toAnchor = anchor
  }

  // Lowest-degree nodes first, hubs last: see rule 4 above.
  const nodeOrder = [...incident.keys()].sort(
    (a, b) => incident.get(a)!.length - incident.get(b)!.length || (a < b ? -1 : a > b ? 1 : 0),
  )
  const signature = () => [...result].map(([id, a]) => `${id}:${a.fromAnchor ?? '-'}/${a.toAnchor ?? '-'}`).join('|')
  let previous = ''
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    for (const nodeId of nodeOrder) {
      // Re-solve this node from scratch against the far ends' current state.
      for (const { edgeId, end } of incident.get(nodeId)!) setAnchor(edgeId, end, undefined)
      const box = rects.get(nodeId)!
      const placed = incident.get(nodeId)!.map(({ edgeId, end }) => endpointFor(nodeId, edgeId, end))
      // Parallel connections whose raycasts leave through two DIFFERENT sides near
      // a corner: each side, solved alone, sees no collision, and the pair braids
      // at the corner (29 of 1,677 random two-box pairs in the seeded sweep,
      // placementQa.test.ts). Only then are they moved onto the side facing the
      // other node, where the side solve separates them — forcing EVERY pair there
      // pinned ends that sat fine and made tight pairs cross instead (crossings
      // 1 → 11 in the same sweep).
      const groups = new Map<string, number[]>()
      placed.forEach((p, i) => {
        if (!laneOf.has(p.endpoint.edgeId)) return
        const list = groups.get(p.otherId) ?? []
        list.push(i)
        groups.set(p.otherId, list)
      })
      for (const [otherId, members] of groups) {
        if (members.length < 2 || new Set(members.map((i) => placed[i].side)).size < 2) continue
        const close = members.some((i, a) => members.slice(a + 1).some((j) =>
          Math.hypot(placed[i].point.x - placed[j].point.x, placed[i].point.y - placed[j].point.y) < tol))
        if (!close) continue
        const facing = edgePoint(box, center(rects.get(otherId)!)).face
        for (const i of members) placed[i] = endpointFor(nodeId, placed[i].endpoint.edgeId, placed[i].endpoint.end, facing)
      }
      const sides = new Map<Face, Endpoint[]>()
      for (const { side, endpoint } of placed) {
        const list = sides.get(side) ?? []
        list.push(endpoint)
        sides.set(side, list)
      }
      for (const [side, eps] of sides) {
        // A lone endpoint never collides: it stays free and raycasts straight.
        if (eps.length < 2) continue
        const alongX = side === 'top' || side === 'bottom'
        const ports = [0, 1, 2].map((s) => {
          const p = anchorPoint(box, SIDE_BASE_ANCHOR[side] + s)
          return alongX ? p.x : p.y
        })
        const sideLen = alongX ? box.width : box.height
        // The diagram-wide tolerance can exceed this side's own port spacing (a
        // 90px side spaces its ports 22.2px apart against a 22.5px tolerance), and
        // then the ports would "collide" with each other and pinning could never
        // win. Cap it just under the spacing: distinct ports are always apart.
        const sideTol = Math.min(tol, 0.95 * (ports[1] - ports[0]))
        const sorted = [...eps].sort(
          (a, b) => a.target - b.target || a.otherCoord - b.otherCoord || (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0),
        )
        const choice = solveSide(sorted, ports, sideTol, 4 * sideLen * sideLen)
        sorted.forEach((ep, i) => {
          if (choice[i] >= 0) setAnchor(ep.edgeId, ep.end, SIDE_BASE_ANCHOR[side] + choice[i])
        })
      }
    }
    const now = signature()
    if (now === previous) break
    previous = now
  }
  return result
}
