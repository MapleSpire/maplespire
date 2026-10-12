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

// Dependency-free layered (Sugiyama-style) graph layout.
//
// Pipeline: break cycles → assign ranks (longest path) → insert dummy nodes for
// long edges → reduce crossings (barycenter sweeps, keep best) → assign
// coordinates (pack + iterative straightening) → route edges through the dummy
// chain. Orientation (tb/bt/lr/rl) is applied as a final coordinate transform.
//
// Small graphs (tens of nodes) → simple O(n²)/O(e²) passes are fine.

import type { Point } from './metrics'

export type Direction = 'tb' | 'bt' | 'lr' | 'rl'

export interface LayoutNodeInput {
  id: string
  width: number
  height: number
  groupId?: string
}

export interface LayoutEdgeInput {
  id: string
  fromId: string
  toId: string
}

export interface LayoutOptions {
  direction?: Direction
  /** Gap between consecutive ranks (along the rank axis). */
  rankSep?: number
  /** Gap between adjacent nodes within a rank (along the order axis). */
  nodeSep?: number
  marginX?: number
  marginY?: number
  /** Crossing-reduction sweeps. */
  iterations?: number
}

export interface PositionedNode {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface RoutedEdge {
  id: string
  fromId: string
  toId: string
  /** Intermediate bend points only (world coords), source→target order. */
  waypoints: Point[]
}

export interface LayoutResult {
  nodes: Map<string, PositionedNode>
  edges: RoutedEdge[]
}

const DEFAULTS = {
  rankSep: 130,
  nodeSep: 70,
  marginX: 60,
  marginY: 60,
  iterations: 12,
}

interface Internal {
  id: string
  dummy: boolean
  width: number
  height: number
  rank: number
  order: number
  p: number // order-axis coordinate (center)
  groupId?: string
}

export function layoutGraph(
  nodesIn: LayoutNodeInput[],
  edgesIn: LayoutEdgeInput[],
  opts: LayoutOptions = {},
): LayoutResult {
  const direction = opts.direction ?? 'tb'
  const rankSep = opts.rankSep ?? DEFAULTS.rankSep
  const nodeSep = opts.nodeSep ?? DEFAULTS.nodeSep
  const marginX = opts.marginX ?? DEFAULTS.marginX
  const marginY = opts.marginY ?? DEFAULTS.marginY
  const iterations = opts.iterations ?? DEFAULTS.iterations

  const horizontal = direction === 'lr' || direction === 'rl'
  // Along which axis each node's size matters.
  const orderSize = (n: { width: number; height: number }) => (horizontal ? n.height : n.width)
  const rankSize = (n: { width: number; height: number }) => (horizontal ? n.width : n.height)

  if (nodesIn.length === 0) return { nodes: new Map(), edges: [] }

  // Drop self-loops and edges to unknown nodes; dedupe.
  const nodeSet = new Set(nodesIn.map((n) => n.id))
  const seenEdge = new Set<string>()
  const edges = edgesIn.filter((e) => {
    if (e.fromId === e.toId) return false
    if (!nodeSet.has(e.fromId) || !nodeSet.has(e.toId)) return false
    const k = `${e.fromId}\u0000${e.toId}`
    if (seenEdge.has(k)) return false
    seenEdge.add(k)
    return true
  })

  // No edges → grid.
  if (edges.length === 0) {
    return gridLayout(nodesIn, { marginX, marginY, nodeSep, rankSep, horizontal, orderSize, rankSize })
  }

  // ── cycle removal (reverse back edges via DFS) ─────────────────────────────
  const adj = new Map<string, string[]>()
  for (const id of nodeSet) adj.set(id, [])
  for (const e of edges) adj.get(e.fromId)!.push(e.toId)

  const reversed = new Set<string>() // edge key that was reversed
  {
    const state = new Map<string, 0 | 1 | 2>() // 0=unseen,1=onstack,2=done
    for (const id of nodeSet) state.set(id, 0)
    const dfs = (start: string) => {
      // Iterative DFS to avoid deep recursion.
      const stack: Array<{ id: string; i: number }> = [{ id: start, i: 0 }]
      state.set(start, 1)
      while (stack.length) {
        const top = stack[stack.length - 1]
        const neighbors = adj.get(top.id)!
        if (top.i >= neighbors.length) {
          state.set(top.id, 2)
          stack.pop()
          continue
        }
        const next = neighbors[top.i++]
        const st = state.get(next)!
        if (st === 1) {
          reversed.add(`${top.id}\u0000${next}`) // back edge
        } else if (st === 0) {
          state.set(next, 1)
          stack.push({ id: next, i: 0 })
        }
      }
    }
    for (const id of nodeSet) if (state.get(id) === 0) dfs(id)
  }

  // Forward edge list (with original direction recorded for routing).
  interface FEdge { id: string; from: string; to: string; reversed: boolean }
  const fedges: FEdge[] = edges.map((e) => {
    const isRev = reversed.has(`${e.fromId}\u0000${e.toId}`)
    return isRev
      ? { id: e.id, from: e.toId, to: e.fromId, reversed: true }
      : { id: e.id, from: e.fromId, to: e.toId, reversed: false }
  })

  // ── rank assignment (longest path on the DAG) ──────────────────────────────
  const outF = new Map<string, string[]>()
  const inDeg = new Map<string, number>()
  for (const id of nodeSet) {
    outF.set(id, [])
    inDeg.set(id, 0)
  }
  for (const e of fedges) {
    outF.get(e.from)!.push(e.to)
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1)
  }
  const rank = new Map<string, number>()
  {
    // Kahn topological order, then longest-path ranks.
    const q: string[] = []
    const deg = new Map(inDeg)
    for (const id of nodeSet) {
      rank.set(id, 0)
      if (deg.get(id) === 0) q.push(id)
    }
    const topo: string[] = []
    while (q.length) {
      const u = q.shift()!
      topo.push(u)
      for (const v of outF.get(u)!) {
        deg.set(v, deg.get(v)! - 1)
        if (deg.get(v) === 0) q.push(v)
      }
    }
    for (const u of topo) {
      const ru = rank.get(u)!
      for (const v of outF.get(u)!) {
        if (rank.get(v)! < ru + 1) rank.set(v, ru + 1)
      }
    }
  }

  // Isolated nodes (degree 0) → place them in a trailing rank, in a neat row.
  const degree = new Map<string, number>()
  for (const id of nodeSet) degree.set(id, 0)
  for (const e of edges) {
    degree.set(e.fromId, degree.get(e.fromId)! + 1)
    degree.set(e.toId, degree.get(e.toId)! + 1)
  }
  let maxRank = 0
  for (const id of nodeSet) maxRank = Math.max(maxRank, rank.get(id)!)
  const isolated = [...nodeSet].filter((id) => degree.get(id) === 0)
  if (isolated.length > 0) {
    for (const id of isolated) rank.set(id, maxRank + 1)
    maxRank += 1
  }

  // ── build internal node records + dummy chains ─────────────────────────────
  const nodes = new Map<string, Internal>()
  for (const n of nodesIn) {
    nodes.set(n.id, {
      id: n.id,
      dummy: false,
      width: n.width,
      height: n.height,
      rank: rank.get(n.id)!,
      order: 0,
      p: 0,
      groupId: n.groupId,
    })
  }

  let dummyCount = 0
  // chain per edge (node ids source→target in *layout* direction = from→to of FEdge)
  const chains = new Map<string, string[]>()
  const flatEdges: FEdge[] = []
  for (const e of fedges) {
    const r0 = rank.get(e.from)!
    const r1 = rank.get(e.to)!
    if (r1 <= r0) {
      flatEdges.push(e)
      chains.set(e.id, [e.from, e.to])
      continue
    }
    const chain = [e.from]
    for (let r = r0 + 1; r < r1; r++) {
      const did = `__d${++dummyCount}`
      nodes.set(did, { id: did, dummy: true, width: 1, height: 1, rank: r, order: 0, p: 0 })
      chain.push(did)
    }
    chain.push(e.to)
    chains.set(e.id, chain)
  }

  // Rank-adjacent segments (for ordering + crossing counting).
  interface Seg { a: string; b: string; r: number }
  const segments: Seg[] = []
  for (const [, chain] of chains) {
    for (let k = 0; k + 1 < chain.length; k++) {
      const a = nodes.get(chain[k])!
      const b = nodes.get(chain[k + 1])!
      if (b.rank === a.rank + 1) segments.push({ a: chain[k], b: chain[k + 1], r: a.rank })
    }
  }

  // up/down adjacency for barycenters.
  const down = new Map<string, string[]>() // node → neighbors in rank+1
  const up = new Map<string, string[]>() // node → neighbors in rank-1
  for (const id of nodes.keys()) {
    down.set(id, [])
    up.set(id, [])
  }
  for (const s of segments) {
    down.get(s.a)!.push(s.b)
    up.get(s.b)!.push(s.a)
  }

  // layers
  const layers: string[][] = []
  for (let r = 0; r <= maxRank; r++) layers.push([])
  for (const n of nodes.values()) layers[n.rank].push(n.id)

  const setOrders = () => {
    for (const layer of layers) layer.forEach((id, i) => (nodes.get(id)!.order = i))
  }
  setOrders()

  // ── crossing reduction (barycenter sweeps; keep best) ──────────────────────
  const countCrossings = (): number => {
    let total = 0
    for (let r = 0; r < maxRank; r++) {
      const segs = segments.filter((s) => s.r === r)
      const pairs = segs.map((s) => [nodes.get(s.a)!.order, nodes.get(s.b)!.order] as const)
      for (let i = 0; i < pairs.length; i++) {
        for (let j = i + 1; j < pairs.length; j++) {
          const [a1, b1] = pairs[i]
          const [a2, b2] = pairs[j]
          if ((a1 - a2) * (b1 - b2) < 0) total++
        }
      }
    }
    return total
  }

  // Median heuristic (Gansner et al.) — generally beats barycenter for crossings.
  const median = (id: string, useUp: boolean): number => {
    const neigh = useUp ? up.get(id)! : down.get(id)!
    if (neigh.length === 0) return -1 // sentinel: keep current position
    const orders = neigh.map((nb) => nodes.get(nb)!.order).sort((a, b) => a - b)
    const mid = Math.floor(orders.length / 2)
    if (orders.length % 2 === 1) return orders[mid]
    if (orders.length === 2) return (orders[0] + orders[1]) / 2
    const left = orders[mid - 1] - orders[0]
    const right = orders[orders.length - 1] - orders[mid]
    if (left + right === 0) return (orders[mid - 1] + orders[mid]) / 2
    return (orders[mid - 1] * right + orders[mid] * left) / (left + right)
  }

  // Transpose: greedily swap adjacent nodes within a rank while it reduces the
  // total crossing count. Very effective at squeezing out residual crossings.
  const transpose = () => {
    let improved = true
    let guard = 0
    while (improved && guard++ < 6) {
      improved = false
      for (let r = 0; r <= maxRank; r++) {
        const layer = layers[r]
        for (let i = 0; i + 1 < layer.length; i++) {
          const before = countCrossings()
          ;[layer[i], layer[i + 1]] = [layer[i + 1], layer[i]]
          nodes.get(layer[i])!.order = i
          nodes.get(layer[i + 1])!.order = i + 1
          const after = countCrossings()
          if (after < before) {
            improved = true
          } else {
            ;[layer[i], layer[i + 1]] = [layer[i + 1], layer[i]]
            nodes.get(layer[i])!.order = i
            nodes.get(layer[i + 1])!.order = i + 1
          }
        }
      }
    }
  }

  let bestCrossings = countCrossings()
  let bestOrder = snapshotOrder(layers)
  for (let it = 0; it < iterations; it++) {
    const useUp = it % 2 === 0 // alternate sweep direction
    const order = useUp ? rangeAsc(1, maxRank) : rangeDesc(maxRank - 1, 0)
    for (const r of order) {
      const layer = layers[r]
      const med = new Map<string, number>()
      layer.forEach((id) => med.set(id, median(id, useUp)))
      // Nodes with no neighbors (median = -1) keep their relative position.
      const fixed = new Map<string, number>()
      layer.forEach((id, i) => fixed.set(id, i))
      layer.sort((x, y) => {
        const mx = med.get(x)!
        const my = med.get(y)!
        if (mx < 0 && my < 0) return fixed.get(x)! - fixed.get(y)!
        if (mx < 0) return fixed.get(x)! - my // keep x near its old slot
        if (my < 0) return mx - fixed.get(y)!
        if (Math.abs(mx - my) > 1e-9) return mx - my
        const gx = nodes.get(x)!.groupId ?? ''
        const gy = nodes.get(y)!.groupId ?? ''
        if (gx !== gy) return gx < gy ? -1 : 1
        return fixed.get(x)! - fixed.get(y)!
      })
      layer.forEach((id, i) => (nodes.get(id)!.order = i))
    }
    transpose()
    const c = countCrossings()
    if (c < bestCrossings) {
      bestCrossings = c
      bestOrder = snapshotOrder(layers)
    }
  }
  // Restore best ordering.
  restoreOrder(layers, bestOrder)
  setOrders()

  // ── coordinate assignment (order axis) ─────────────────────────────────────
  // Initial packing per rank.
  for (const layer of layers) {
    let cursor = 0
    for (const id of layer) {
      const n = nodes.get(id)!
      const half = orderSize(n) / 2
      cursor += half
      n.p = cursor
      cursor += half + nodeSep
    }
  }
  // Iterative straightening: pull each node toward the barycenter of its
  // neighbors (both directions), then enforce within-rank min separation.
  const sepBetween = (a: Internal, b: Internal) => orderSize(a) / 2 + orderSize(b) / 2 + nodeSep
  for (let pass = 0; pass < 8; pass++) {
    const useUp = pass % 2 === 0
    const order = useUp ? rangeAsc(0, maxRank) : rangeDesc(maxRank, 0)
    for (const r of order) {
      const layer = layers[r]
      // desired position = average of up+down neighbor p (median-ish via mean)
      for (const id of layer) {
        const n = nodes.get(id)!
        const neigh = [...up.get(id)!, ...down.get(id)!]
        if (neigh.length > 0) {
          let s = 0
          for (const nb of neigh) s += nodes.get(nb)!.p
          n.p = s / neigh.length
        }
      }
      // enforce ordering + separation: left→right then right→left
      for (let i = 1; i < layer.length; i++) {
        const prev = nodes.get(layer[i - 1])!
        const cur = nodes.get(layer[i])!
        const minP = prev.p + sepBetween(prev, cur)
        if (cur.p < minP) cur.p = minP
      }
      for (let i = layer.length - 2; i >= 0; i--) {
        const next = nodes.get(layer[i + 1])!
        const cur = nodes.get(layer[i])!
        const maxP = next.p - sepBetween(cur, next)
        if (cur.p > maxP) cur.p = maxP
      }
    }
  }

  // ── rank axis coordinate ───────────────────────────────────────────────────
  const bandStart: number[] = []
  let acc = 0
  for (let r = 0; r <= maxRank; r++) {
    let band = 0
    for (const id of layers[r]) band = Math.max(band, rankSize(nodes.get(id)!))
    bandStart[r] = acc
    acc += band + rankSep
  }
  const totalRankExtent = acc - rankSep
  const rankCenter = (r: number): number => {
    let band = 0
    for (const id of layers[r]) band = Math.max(band, rankSize(nodes.get(id)!))
    return bandStart[r] + band / 2
  }

  // ── map (p, rankCenter) → (cx, cy) per direction ───────────────────────────
  const center = (n: Internal): Point => {
    const rc = rankCenter(n.rank)
    switch (direction) {
      case 'tb':
        return { x: n.p, y: rc }
      case 'bt':
        return { x: n.p, y: totalRankExtent - rc }
      case 'lr':
        return { x: rc, y: n.p }
      case 'rl':
        return { x: totalRankExtent - rc, y: n.p }
    }
  }

  // Compute centers, then normalize to margins.
  const centers = new Map<string, Point>()
  let minX = Infinity
  let minY = Infinity
  for (const n of nodes.values()) {
    const c = center(n)
    centers.set(n.id, c)
    minX = Math.min(minX, c.x - n.width / 2)
    minY = Math.min(minY, c.y - n.height / 2)
  }
  const dx = marginX - minX
  const dy = marginY - minY

  const out = new Map<string, PositionedNode>()
  for (const n of nodes.values()) {
    if (n.dummy) continue
    const c = centers.get(n.id)!
    out.set(n.id, {
      id: n.id,
      x: c.x + dx - n.width / 2,
      y: c.y + dy - n.height / 2,
      width: n.width,
      height: n.height,
    })
  }

  // ── routing ────────────────────────────────────────────────────────────────
  const routed: RoutedEdge[] = []
  for (const e of fedges) {
    const chain = chains.get(e.id)!
    // chain is from→to in layout direction; restore original direction for output.
    const ordered = e.reversed ? [...chain].reverse() : chain
    const pts = ordered.map((id) => {
      const c = centers.get(id)!
      return { x: c.x + dx, y: c.y + dy }
    })
    // waypoints = intermediate dummy points only (exclude the two endpoints).
    const waypoints = pts.slice(1, -1)
    routed.push({ id: e.id, fromId: e.reversed ? e.to : e.from, toId: e.reversed ? e.from : e.to, waypoints })
  }

  return { nodes: out, edges: routed }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function snapshotOrder(layers: string[][]): string[][] {
  return layers.map((l) => [...l])
}
function restoreOrder(layers: string[][], snap: string[][]): void {
  for (let r = 0; r < layers.length; r++) layers[r] = snap[r]
  // Mutate in place: callers keep the same array reference for `layers`.
}
function rangeAsc(a: number, b: number): number[] {
  const out: number[] = []
  for (let i = a; i <= b; i++) out.push(i)
  return out
}
function rangeDesc(a: number, b: number): number[] {
  const out: number[] = []
  for (let i = a; i >= b; i--) out.push(i)
  return out
}

function gridLayout(
  nodesIn: LayoutNodeInput[],
  ctx: {
    marginX: number
    marginY: number
    nodeSep: number
    rankSep: number
    horizontal: boolean
    orderSize: (n: { width: number; height: number }) => number
    rankSize: (n: { width: number; height: number }) => number
  },
): LayoutResult {
  const out = new Map<string, PositionedNode>()
  const count = nodesIn.length
  const cellW = Math.max(...nodesIn.map((n) => n.width)) + ctx.nodeSep
  const cellH = Math.max(...nodesIn.map((n) => n.height)) + ctx.rankSep
  // Choose a column count that keeps the overall grid close to square *in pixels*
  // (cells are wider than tall, so a naive sqrt count over-stretches horizontally
  // — e.g. 2 nodes side-by-side gives a 4.7 aspect). Pick the column count whose
  // resulting width/height aspect is closest to 1.
  let cols = 1
  let bestAspect = Infinity
  for (let c = 1; c <= count; c++) {
    const rows = Math.ceil(count / c)
    const w = c * cellW
    const h = rows * cellH
    const aspect = Math.max(w / h, h / w)
    if (aspect < bestAspect - 1e-9) {
      bestAspect = aspect
      cols = c
    }
  }
  nodesIn.forEach((n, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    out.set(n.id, {
      id: n.id,
      x: ctx.marginX + col * cellW + (cellW - ctx.nodeSep - n.width) / 2,
      y: ctx.marginY + row * cellH + (cellH - ctx.rankSep - n.height) / 2,
      width: n.width,
      height: n.height,
    })
  })
  return { nodes: out, edges: [] }
}
