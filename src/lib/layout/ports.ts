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
// TWO rules decide whether a side's endpoints get pinned to ports at all:
//
// 1. A side with a single edge is left UNassigned (anchor undefined → unlocked) so
//    the routing raycasts a centre-facing endpoint and the connection runs straight
//    at its target instead of being pinned to an off-centre port and bowed into an
//    S-curve.
// 2. A side with k>=2 edges is fanned ONLY when its endpoints actually collide —
//    i.e. some adjacent pair of their natural raycast points sits closer than the
//    hub-cluster tolerance (max(8, minNodeSide*0.25) — the same tolerance the
//    hubSpread metric uses to count distinct attachment clusters, so "fans when the
//    metric would call it spray" and only then). Endpoints that already spread
//    naturally (targets lying in clearly different directions) stay unlocked:
//    pinning them to the 0.2/0.8 ports would MOVE them off their natural lines and
//    bow every edge into an S for no legibility gain. This is the difference
//    between a real hub fanning cleanly and every ordinary 2-edge side looking
//    needlessly complex.

import { type Box, type Face, edgePoint, center, SIDE_BASE_ANCHOR } from './geometry'

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

/** Slot indices (0=near,1=center,2=far) for k endpoints sharing one side. */
export function slotsFor(k: number): number[] {
  if (k <= 0) return []
  if (k === 1) return [1]
  if (k === 2) return [0, 2]
  if (k === 3) return [0, 1, 2]
  // k>=4: spread across the 3 slots as evenly as possible (slots reused).
  return Array.from({ length: k }, (_, i) => Math.round((i / (k - 1)) * 2))
}

interface Endpoint {
  edgeId: string
  end: 'from' | 'to'
  /** Coordinate of the endpoint's natural RAYCAST point along the side axis (x for
   * top/bottom, y for left/right) — what the canvas would draw unlocked. Orders the
   * fan and decides whether the side's endpoints collide at all. */
  coord: number
}

export function assignAnchors(
  rects: Map<string, Box>,
  edges: AnchorEdge[],
  opts: AssignOptions = {},
): Map<string, AnchorAssignment> {
  const result = new Map<string, AnchorAssignment>()
  const buckets = new Map<string, Endpoint[]>() // `${nodeId}|${side}` → endpoints

  // Cluster tolerance, identical to the hubSpread metric's: two attachment points
  // closer than this read as one cluster ("spray"); farther apart they are already
  // visually distinct and need no port pinning.
  let minSide = Infinity
  for (const b of rects.values()) minSide = Math.min(minSide, Math.min(b.width, b.height))
  const tol = Math.max(8, (Number.isFinite(minSide) ? minSide : 60) * 0.25)

  const endpointFor = (
    nodeId: string,
    otherId: string,
    edgeId: string,
    end: 'from' | 'to',
  ): { side: Face; coord: number } | null => {
    const box = rects.get(nodeId)
    const other = rects.get(otherId)
    if (!box || !other) return null
    const ray = edgePoint(box, center(other))
    const side = opts.sideOf?.(edgeId, end) ?? ray.face
    return { side, coord: side === 'top' || side === 'bottom' ? ray.x : ray.y }
  }

  for (const e of edges) {
    if (e.fromId === e.toId) continue
    result.set(e.id, {})
    const from = endpointFor(e.fromId, e.toId, e.id, 'from')
    const to = endpointFor(e.toId, e.fromId, e.id, 'to')
    if (from) {
      const key = `${e.fromId}|${from.side}`
      const list = buckets.get(key) ?? []
      list.push({ edgeId: e.id, end: 'from', coord: from.coord })
      buckets.set(key, list)
    }
    if (to) {
      const key = `${e.toId}|${to.side}`
      const list = buckets.get(key) ?? []
      list.push({ edgeId: e.id, end: 'to', coord: to.coord })
      buckets.set(key, list)
    }
  }

  for (const [key, eps] of buckets) {
    // Single-edge sides stay unlocked (no anchor) so they raycast a centre-facing
    // endpoint and run straight; only fan/distribute when a side is shared.
    if (eps.length < 2) continue
    eps.sort((a, b) => a.coord - b.coord || (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0))
    // Shared side, but the raycast endpoints already spread wider than the cluster
    // tolerance everywhere → leave them unlocked; they separate naturally.
    let collides = false
    for (let i = 1; i < eps.length; i++) {
      if (eps[i].coord - eps[i - 1].coord < tol) {
        collides = true
        break
      }
    }
    if (!collides) continue
    const side = key.split('|')[1] as Face
    const slots = slotsFor(eps.length)
    eps.forEach((ep, i) => {
      const anchorIdx = SIDE_BASE_ANCHOR[side] + slots[i]
      const a = result.get(ep.edgeId)!
      if (ep.end === 'from') a.fromAnchor = anchorIdx
      else a.toAnchor = anchorIdx
    })
  }

  return result
}
