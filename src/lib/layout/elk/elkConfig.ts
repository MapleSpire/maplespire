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

// ELK strategy portfolio. Each diagram is laid out with the candidate strategies
// that match its direction hint (or all of them when unconstrained); the best by
// metric score wins. Tunables here are what the QA loop adjusts.

import type { LineShape } from '../geometry'
import type { GraphComplexity } from '../graph'

export type ElkDirection = 'DOWN' | 'RIGHT'

export interface Strategy {
  id: string
  direction: ElkDirection
  edgeRouting: 'ORTHOGONAL' | 'SPLINES' | 'POLYLINE'
  nodePlacement: 'NETWORK_SIMPLEX' | 'BRANDES_KOEPF'
  /** Connection shape to stamp on edges this strategy produces. */
  shape: LineShape
  /** MULTI_EDGE row wrapping (default true). See {@link STRATEGIES}. */
  wrapping?: boolean
  /** Let crossing minimisation reorder nodes freely instead of keeping the
   *  model order (default false). See {@link STRATEGIES}. */
  freeOrder?: boolean
}

const WRAPPED: Strategy[] = [
  { id: 'ortho-ns-down', direction: 'DOWN', edgeRouting: 'ORTHOGONAL', nodePlacement: 'NETWORK_SIMPLEX', shape: 'straight' },
  { id: 'ortho-ns-right', direction: 'RIGHT', edgeRouting: 'ORTHOGONAL', nodePlacement: 'NETWORK_SIMPLEX', shape: 'straight' },
  { id: 'spline-bk-down', direction: 'DOWN', edgeRouting: 'SPLINES', nodePlacement: 'BRANDES_KOEPF', shape: 'curved' },
  { id: 'spline-bk-right', direction: 'RIGHT', edgeRouting: 'SPLINES', nodePlacement: 'BRANDES_KOEPF', shape: 'curved' },
]

/**
 * The portfolio: every strategy with AND without row wrapping.
 *
 * Wrapping exists for long chains, which lay out as a one-row sliver without it.
 * On a short graph it does harm: it cuts a three-layer context view (people →
 * system → externals) into chunks and parks the last layer beside the first
 * (measured on the SAOE `FSSystemContext` view: every DOWN candidate came out a
 * 1110×288 strip, SharePoint Online and Agent parked in the top row beside the
 * people). Since the
 * score already penalises slivers, both variants compete and the metric keeps the
 * wrapped one only where it reads better. The unwrapped variants come FIRST: the
 * selection keeps the earlier candidate on a tied score, and a tie means the
 * correction bought nothing (grouped.dsl `Landscape`: 7 vs 7, and only the unwrapped
 * one put End User above the Cloud group).
 *
 * Only the ORTHOGONAL strategies keep a wrapped twin — one per direction, so a
 * hinted `lr` chain still has a wrapped candidate. Measured 2026-10-22 over 48
 * views (every DSL/JSON fixture view plus synthetic 12/20/30-node and branched
 * chains) × {no hint, tb, lr}, replaying bestLayout's selection: dropping the two
 * wrapped SPLINE strategies changed no result, while dropping every wrapped one
 * lost four (saoe AzureObservabilityFlow 21→33, hierarchical System B 2→5, groups
 * SystemLandscape 2→5, the 12-node chain 5→6 — wrapped ortho-ns-down won each).
 * These per-view numbers came from throwaway probes on 2026-10-22, before the
 * group-overlap term joined `groupStraddles`; the replay test named below
 * reproduces the superset comparison, not each delta.
 *
 * Two FREE-ORDER strategies (`freeOrder`: crossing minimisation may reorder
 * nodes instead of keeping the model order) help the dense container views,
 * where the model order fights the sweep — against this same portfolio without
 * them: SAOEPermitContainers 131→109 (4→3 crossings), FSContainers 128→85,
 * big-bank JSON Containers 100→72. Free order
 * is WORSE as the only setting (DataverseComponents 9→11 crossings), so it
 * competes rather than replaces. They take the place of `ortho-ns-right-nowrap`,
 * which never changed a selection. Same views × 3 hint modes: this 7-strategy
 * portfolio picks a result as good as the 8-strategy superset (these 7 plus
 * ortho-ns-right-nowrap) on every one. Against all 12 combinations (each base
 * strategy wrapped, unwrapped and free-order) it loses 3 of 144 selections
 * (total score 4672 vs 4620, 2026-10-22) — the price of 7 runs instead of 12.
 * The portfolio was chosen ON these views; the claim bounds it there and nowhere
 * else. Reproduce: LAYOUT_REPLAY=1 npx vitest run src/lib/layout/portfolioReplay.test.ts
 */
const UNWRAPPED: Strategy[] = WRAPPED.map((s) => ({ ...s, id: `${s.id}-nowrap`, wrapping: false }))
const unwrapped = (id: string): Strategy => UNWRAPPED.find((s) => s.id === id)!
export const STRATEGIES: Strategy[] = [
  ...UNWRAPPED.filter((s) => s.id !== 'ortho-ns-right-nowrap'),
  ...WRAPPED.filter((s) => s.edgeRouting === 'ORTHOGONAL'),
  { ...unwrapped('spline-bk-right-nowrap'), id: 'spline-bk-right-nowrap-free', freeOrder: true },
  { ...unwrapped('ortho-ns-down-nowrap'), id: 'ortho-ns-down-nowrap-free', freeOrder: true },
]

/**
 * Pick the candidate strategies for a diagram given an optional direction hint.
 *
 * The hint expresses a *preference*, not a hard constraint: a linear flow forced
 * into its hinted direction can produce an extreme sliver (e.g. a one-row "lr"
 * flow at 8:1). So we return the hinted-direction strategies FIRST but keep the
 * perpendicular ones as fallbacks — the metric scorer (which penalises extreme
 * aspect ratios) then keeps the hinted layout when it reads well and falls back
 * to a squarer perpendicular layout only when the hinted one is a thin strip.
 */
export function strategiesFor(hint?: 'tb' | 'bt' | 'lr' | 'rl'): Strategy[] {
  if (hint === 'tb' || hint === 'bt') {
    const primary = STRATEGIES.filter((s) => s.direction === 'DOWN')
    const fallback = STRATEGIES.filter((s) => s.direction === 'RIGHT')
    return [...primary, ...fallback]
  }
  if (hint === 'lr' || hint === 'rl') {
    const primary = STRATEGIES.filter((s) => s.direction === 'RIGHT')
    const fallback = STRATEGIES.filter((s) => s.direction === 'DOWN')
    return [...primary, ...fallback]
  }
  return STRATEGIES
}

/** Crossing-minimisation effort, scaled to the graph being laid out. Import /
 * auto-layout is one-shot (never interactive dragging), so SMALL graphs afford a
 * deeper LAYER_SWEEP — they're the diagrams users stare at the most and extra
 * sweeps only cost microseconds there — while BIG component views cap the effort
 * so a 100+-node layout stays sub-second. 40 (the historical tuning) is the
 * mid-band and the no-analysis default. */
export function thoroughnessFor(complexity?: GraphComplexity): number {
  if (!complexity) return 40
  if (complexity.nodeCount <= 30) return 60
  if (complexity.nodeCount <= 80) return 40
  return 25
}

/** Root-level ELK layout options for a strategy, tuned to the graph's complexity
 * profile when one is provided (see {@link thoroughnessFor}). */
export function rootOptions(s: Strategy, complexity?: GraphComplexity): Record<string, string> {
  const opts: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.direction': s.direction,
    'elk.edgeRouting': s.edgeRouting,
    'elk.layered.nodePlacement.strategy': s.nodePlacement,
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    // High effort on crossing minimisation (default 7) — import is one-shot.
    'elk.layered.thoroughness': String(thoroughnessFor(complexity)),
    'elk.layered.nodePlacement.favorStraightEdges': 'true',
    // Aim for a balanced landscape canvas (~16:10) instead of letting the layered
    // algorithm produce extreme portrait/slivers; combined with edge wrapping this
    // breaks long single-row flows into multiple rows so no diagram is a thin strip.
    'elk.aspectRatio': '1.6',
    'elk.layered.wrapping.strategy': 'MULTI_EDGE',
    'elk.layered.wrapping.correctionFactor': '1.4',
    'elk.layered.wrapping.additionalEdgeSpacing': '20',
    // Spread the edges of high-degree hubs so they fan across the border instead of
    // all leaving from one point ("spray").
    'elk.layered.highDegreeNodes.treatment': 'true',
    // Spacing — generous so diagrams read "aerated" and edge labels have room to
    // sit between layers without colliding with neighbours.
    //
    // IMPORTANT: these ROOT values are a tuned local optimum — do NOT bump them to add
    // breathing room. With MULTI_EDGE wrapping (aspectRatio 1.6, correctionFactor
    // 1.4) the layout sits on a cliff w.r.t. spacing: within-layer spacing (nodeNode/
    // edgeNode) changes a row's natural width, flipping where rows wrap and reshuffling
    // crossings on dense hubs (vision QA: nodeNode 60→clean, 68→26 crossings on
    // DataverseComponents); and between-layer spacing (nodeNodeBetweenLayers) at 110
    // pushed an edge through a node on VuesDesFormulairesOracle. Every ROOT axis tested
    // regressed some diagram, so leave the root values at the floor.
    //
    // Interior crowding INSIDE boundary compounds is a separate problem with a separate
    // lever: ELK applies its default nodeNode=20 inside compounds (the root values do
    // NOT propagate through INCLUDE_CHILDREN), so members crammed in a boundary read
    // tight while root-level nodes breathe. That is fixed per-compound in elkLayout.ts
    // (GROUP_SPACING_NODE/LAYERS) — which does NOT touch the root wrapping cliff — not
    // by these globals.
    'elk.spacing.nodeNode': '60',
    'elk.layered.spacing.nodeNodeBetweenLayers': '90',
    'elk.spacing.edgeNode': '32',
    'elk.spacing.edgeEdge': '24',
    'elk.layered.spacing.edgeNodeBetweenLayers': '28',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
    'elk.spacing.componentComponent': '80',
    'elk.padding': '[top=24,left=24,bottom=24,right=24]',
    // Determinism.
    'elk.randomSeed': '1',
  }
  if (s.wrapping === false) {
    delete opts['elk.layered.wrapping.strategy']
    delete opts['elk.layered.wrapping.correctionFactor']
    delete opts['elk.layered.wrapping.additionalEdgeSpacing']
  }
  if (s.freeOrder) opts['elk.layered.considerModelOrder.strategy'] = 'NONE'
  return opts
}
