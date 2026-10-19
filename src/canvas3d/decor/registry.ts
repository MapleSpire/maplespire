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

import type { PropArchetype } from './placement'

/**
 * Built-in decoration packs — the curated lineup. Metadata is EAGER
 * (three-free — the settings UI lists packs without the GL chunk); geometry
 * is resolved by `build.ts` inside the canvas3d chunk. Geometry is procedural
 * per archetype; a GLB mesh could replace it behind the same archetype ids
 * (propIds — and therefore any future per-prop overrides — survive the swap).
 */

export interface DecorPackMeta {
  id: string
  /** i18n key under `view3d.decor.pack.<id>`. */
  nameKey: string
  archetypes: PropArchetype[]
}

/** Canadiana signature props shared between the canadiana pack and the
 * always-on desk set. The host merges both lists, so the id appears twice on
 * the canadiana pack — safe because footprint/scaleJitter stay IDENTICAL
 * across copies (the per-cell hash then gives both copies the exact same
 * pose, the collision pass drops the duplicate, and build.ts dedupes the id
 * into a single InstancedMesh). Only weight/baseCount may differ per copy. */
/** Maquette scale of the desk FAUNA in the city world (placement.ts
 * `cityScale`). The city's walk-ups are 12.5-21.5 units tall and its street
 * walkers 14-16 (backgrounds.ts); at desk scale the moose stood ~40 px beside
 * ~20-25 px houses (view3d quality loop 3, city-wide.png). Prop heights as
 * built (buildDecorMeshes bbox, measured 2026-10-09): beaver 18.2, loon 26.9,
 * moose 64.6, canada-flag 70.5 — so 0.25 makes the beaver ~4.6 and the loon
 * ~6.7, critters on the city apron. The moose and the flag carry their own
 * factors (see their entries). Loop 4: the Blender beaver (beaver.glb) sits
 * UP — 33.1 tall as exported — so 0.25 makes it ~8.3, still under the lowest
 * walk-up (12.5).
 * City scale (backgrounds.ts CITY_SCALE 2.2, 2026-10-10): the city grew
 * round the board — blocks round the plaza 54-66 units, an 8-unit storey,
 * walkers ~9 — and the fauna kept these sizes on purpose: an ~11.6 moose
 * and an ~8.4 beaver now stand about one storey, beside the walkers, i.e.
 * heroic but people-scale, no longer house-sized. */
const CITY_FAUNA_SCALE = 0.25
/** DESK growth of the two wildlife figures, through their scale jitter (the
 * DESK_SET_GROWTH pattern: placement multiplies the footprint and the
 * projected height by the drawn scale, so every spacing and framing test
 * stays honest). View3d quality pass "wildlife", workbench-wide.png: "at the
 * default framing the moose is about 40 px and the beaver about 25 px —
 * brown specks". Measured on the live default framing (1600 x 1000, both
 * side panels open, fit-to-screen; .probes/wildlife, 2026-10-09): the framed
 * desk band projects 63-68 px per 100 units of height anywhere in it — the
 * moose (62.2 tall at scale 1) 42.4 px at scale 1.05, the beaver (34.0)
 * 21.1 px at 0.985. Promotion alone cannot reach the bar (the foreground is
 * barely bigger than the band's back), so the figures grow. The near band's
 * back edge (feet at half the safe height) projects ~0.6 px/unit, and the
 * unit fixture's farther camera 0.57 (placement.test.ts): 80 px then needs
 * a 137-unit GLB moose and 50 px an 85-unit beaver. The jitter narrows to
 * ±4 % / ±5 % so the floor is the size: moose 2.21-2.39 (137-149 units as
 * exported, ~35 cm at 4.1 units/cm), beaver 2.61-2.89 (89-98 units, ~23 cm).
 * The city keeps its maquette sizes: each cityScale divides the growth back
 * out (moose <= 12.1 units, beaver <= 9.1, both under the 12.5 walk-up). */
export const MOOSE_DESK_GROWTH = 2.3
export const BEAVER_DESK_GROWTH = 2.75
const BEAVER: PropArchetype = {
  id: 'beaver',
  asset: 'beaver',
  // the rotation-safe plan radius of beaver.glb about its origin: 23.2 as
  // exported (wildlife_assets.py prints it; glbAssets.test.ts gates it). The
  // procedural blob's 20 was already short of its own ~31 reach (tail tip).
  footprint: 24,
  affinity: 'open',
  // E[count] = weight·baseCount·√area — below ~1 most boards show NO beaver
  // at all, which defeats the whole Canadian-workshop signature
  weight: 0.6,
  scaleJitter: [0.95 * BEAVER_DESK_GROWTH, 1.05 * BEAVER_DESK_GROWTH],
  // loop 4 r3 (workbench-wide.png): seen from behind, the flat tail read as
  // a black hole on the desk — the muzzle (+X) turns to the camera
  rotation: 'face-camera-3q',
  baseCount: 2,
  // ONE beaver per desk (view3d quality loop 4 r4, workbench-wide.png:
  // beavers at (668,255), (1010,725) and (995,858) — a repeated animal reads
  // as scatter, not as a dressed desk; the near band shows the one there is)
  maxCount: 1,
  zone: 'desk',
  // the city size is unchanged by the desk growth (~8.4 units)
  cityScale: CITY_FAUNA_SCALE / BEAVER_DESK_GROWTH,
  // 33.1 as exported (glbAssets.test.ts) — the near-band projection. Loop 4
  // r3 lifted the head clear of the shoulders: 34.0 as exported (plan
  // radius 23.1, still inside the 24 footprint)
  height: 34.5,
  // loop 4 r2: "the beaver (about 20 px, at 815,190) is barely visible" —
  // promoted into the framed foreground band (placement.ts nearBand)
  nearBand: true,
}
// ── THE LEAF SUPPLY ────────────────────────────────────────────────────────
// The leaves must BE maples, and they must POPULATE the scene the way the
// trees do. The supply is split by ZONE, and the big blade lives on the BOARD
// for a reason that is a proof, not a preference:
//
//   • a BOARD leaf's clearance is PROVABLE. `placeDecor`'s 'open' rule needs a
//     cell centre >30 from the slab rim, then jitters by (footprint−20)/2 and
//     scales by ≤1.05, so solving 1.05·R ≤ 30 − (R−20)/2 caps the rotation-safe
//     radius at LEAF_BOARD_R_MAX = 25.81. A board blade at that radius NEVER
//     straddles the bevel;
//   • a DESK leaf has no such rule. `score()` admits any desk cell with
//     dOut ≥ 10, jitter can pull that to ~4, and the prop is then drawn at desk
//     level UNDER the slab overhang, where a large blade gets sliced by the
//     board's rim.
//
// So the HERO blade is a board prop at the full 25.81 radius (35 × LEAF_W =
// 44 units) and the desk keeps the SMALLER blades. Tone mixes are per surface
// too (see LEAF_TONE_MIX_BOARD / LEAF_TONE_MIX_DESK in build.ts).
//
// Every entry rides the greenery pack as well as canadiana, so a leafy scene
// carries fallen maples alongside its trees. Footprints are `Math.ceil` of the
// matching build.ts radius — pinned by build.test.ts, so a retune of a blade
// size cannot silently break the rim clearance or the desk collision.
//
// ── LOOP 2 ROUND 2: OFF THE DIAGRAM ─────────────────────────────────────────
// The rounds above banked leaves AGAINST cards and cables on purpose; the
// view3d quality loop reversed that. On the run.mjs board (city-wide.png,
// workbench-wide.png) a red+yellow pair touched Query API's corner — "the
// most saturated thing on the board" — and singles, pairs and drifts sat
// beside Web console, at Ingest, in the cable lane between Alert manager and
// Web console, next to Log store and along the left cable lanes: the report
// counted mini ×2, mini-b, mini-c, pair ×4 and drift ×2 on the paper. Two
// causes: placement tested only a leaf's CENTRE against a 14-px card margin
// (a 25-px blade overlapped the card by 11), and nothing kept leaves off the
// cables at all (the bank sought them). Every board leaf now carries
// `clearance`: its FOOTPRINT keeps this gap to every card, drum pad + name
// tag, cable polyline and label plate, so the paper's leaves live in the
// open margins around the diagram, not inside it.
/** Footprint-edge gap (world px) a board leaf keeps to the diagram — about
 * half a card height on the run.mjs board (cards 120-130 tall). */
export const BOARD_LEAF_CLEARANCE = 60

/** The DESK clump — four blades piled on the workbench beside the flag. */
const MAPLE_LEAF_CLUSTER: PropArchetype = {
  id: 'maple-leaf-cluster',
  asset: 'maple-leaf-cluster',
  // ceil(`mapleClumpLayout('cluster').radius`). The strict desk no-overlap
  // radius IS this radius, so a clump can never pile onto another desk prop.
  // 33 → 37 in view3d quality loop 3 (the blades spread to keep each flag
  // silhouette whole, build.ts LEAF_CLUMPS) — still under the flag's 38.
  footprint: 37,
  affinity: 'open',
  // the top of the jitter is what LEAF_MAX_SPAN is measured against
  scaleJitter: [0.85, 1.05],
  rotation: 'random-y',
  weight: 0.8,
  baseCount: 4,
  // THREE desk clumps is a garnish; more is a lawn. The cap also keeps the desk
  // SHOWCASE promotion (placement.ts) off this archetype: that pass takes the
  // largest-footprint desk archetype and forces it into the W band's INNER
  // ring (dOut ≤ 50), which no wide flat cutout can occupy without half of it
  // disappearing under the slab (bisected by the desk-edge line). Once the
  // organic pass has placed three, the promotion
  // is skipped and the showcase falls back to the props it was designed for
  // (the moose, the pencil), which are TALL and read fine with their feet
  // tucked under the board.
  maxCount: 3,
  zone: 'desk',
  // view3d quality loop 3: a desk cell sits 10 px off the slab, so a
  // 37-radius clump reached ~27 px back UNDER the overhang and one blade drew
  // half-hidden beneath the board (workbench-leaf.png). A desk `clearance`
  // keeps the whole footprint off the slab (placement.ts keepsClear).
  clearance: 0,
  // NO cityScale (none of the desk blades has one): a fallen leaf at maquette
  // scale is a few-px red fleck, the "spatter" view3d quality loop 3 rejected,
  // and at desk scale it was wider than a city building (city-leaf.png). In
  // the city the leaves stay on the BOARD, which is the same scale as the
  // cards they sit beside.
}
/** The DESK singles. Footprint 25 = ceil(`mapleSingleRadius('fall')`) —
 * `placeDecor` multiplies the footprint by the instance scale itself, so the
 * number here is the radius at scale 1. It stays BELOW the flag's 38 and the
 * cluster's 33 on purpose, so the desk showcase promotion's "largest footprint"
 * pick does not change hands. */
const MAPLE_LEAF_FALL: PropArchetype = {
  id: 'maple-leaf-fall',
  asset: 'maple-leaf-fall',
  footprint: 25,
  affinity: 'open',
  weight: 1,
  scaleJitter: [0.85, 1.05],
  rotation: 'random-y',
  baseCount: 4,
  // 3 → 2 (view3d quality loop 3: fewer, larger leaves — the desk read as
  // red spatter, workbench-wide.png)
  maxCount: 2,
  zone: 'desk',
  clearance: 0, // wholly off the slab, like the cluster
}
/** …and its partner, smaller and in the dark break. */
const MAPLE_LEAF_FALL_B: PropArchetype = {
  ...MAPLE_LEAF_FALL,
  id: 'maple-leaf-fall-b',
  asset: 'maple-leaf-fall-b',
  footprint: 21,
  weight: 0.85,
  baseCount: 3,
  maxCount: 2,
}

const MAPLE_LEAF_DRIFT: PropArchetype = {
  id: 'maple-leaf-drift',
  asset: 'maple-leaf-drift',
  // ceil(radius) — 26 → 32 when loop 3 spread the blades and grew them
  // (build.ts LEAF_CLUMPS)
  footprint: 32,
  affinity: 'open',
  weight: 0.9,
  scaleJitter: [0.85, 1.05],
  rotation: 'random-y',
  // The board entries are calibrated against the TREES: on a 5-card diagram
  // inside one boundary the greenery pack lands ~8 green objects on the paper.
  // Several clumps, never a carpet — the maxCounts are what keep the cards
  // carrying the story.
  //
  // The supply runs CLUMP-FIRST (higher clump caps, lower single caps)
  // because a drift of three reads as fall, and three singles scattered a
  // card apart read as litter.
  baseCount: 6,
  maxCount: 3,
  clearance: BOARD_LEAF_CLEARANCE,
}
/** THE BANK — the clump that collects against an obstacle.
 *
 * Real fallen leaves accumulate against obstacles. Every other leaf entry is
 * 'open', which scores every interior cell the same 0.5 and therefore produces
 * a uniform random field. This one rides 'near-connection': `score()` admits
 * only cells 10-34 px off a cable run, which fills the mid-board band and is a
 * real obstacle for leaves to pile against.
 *
 * The rim clearance stays provable, which is why this affinity is safe for a
 * wide flat cutout while 'near-node' would not be: a connection's own points
 * lie on card boundaries, i.e. at least `pad` (72 px on the short axis) inside
 * the slab, so a near-connection cell is ≥ 72 − 34 = 38 px from the rim, and
 * the prop reaches 25.28 × 1.05 + 3 = 29.5. Gated in build.test.ts against the
 * real placement, not against this comment. */
const MAPLE_LEAF_BANK: PropArchetype = {
  id: 'maple-leaf-bank',
  asset: 'maple-leaf-bank',
  footprint: 32, // ceil(radius), 26 → 32 with the loop-3 spread + bigger blades
  // LOOP 2 ROUND 2: 'edge' (was 'near-connection'). A leaf that SEEKS the
  // 10-34 px cable shoulder is exactly the "smudge in the cable lane between
  // Alert manager and Web console" the critic marked, and `clearance` now
  // forbids that band outright — so the bank collects against the other
  // obstacle the round-5 brief named, the board rim (`keepsClear` keeps its
  // footprint whole on the slab: edge distance ≥ radius + 3).
  affinity: 'edge',
  // The baseCount looks enormous next to its neighbours and is not: `placeDecor`
  // calibrates acceptance as target / (cols·rows·bandFraction), and the
  // near-connection bandFraction is a flat 0.15 of the WHOLE grid — a generous
  // estimate for a busy view and a wild one for a single-ribbon diagram, which
  // puts ~34 cells in the band out of the ~286 the estimate assumes. At
  // baseCount 6 the archetype landed on 9 seeds in 24 (measured). What actually
  // bounds this entry on a cable-rich board is `maxCount`, not the supply.
  weight: 1.2,
  scaleJitter: [0.85, 1.05],
  rotation: 'random-y',
  baseCount: 20,
  // stays 3 in view3d quality loop 3: the board clumps grew (spread + ~13%
  // larger blades), which already thins them — see build.test.ts populate gate
  maxCount: 3,
  clearance: BOARD_LEAF_CLEARANCE,
}
/** The 2-blade PAIR. Loose drifts of 2-4 leaves: the desk cluster is the 4, the drift is the 3, and this is the 2. It
 * also fits cells the 3-blade drift cannot — a smaller footprint gets into the
 * gaps between cards, which is where fallen leaves actually collect. */
const MAPLE_LEAF_PAIR: PropArchetype = {
  id: 'maple-leaf-pair',
  asset: 'maple-leaf-pair',
  footprint: 30, // ceil(radius), 25 → 30 with the loop-3 spread + bigger blades
  affinity: 'open',
  weight: 0.8,
  scaleJitter: [0.85, 1.05],
  rotation: 'random-y',
  // The pair supply is split across TWO arrangements. One geometry carries
  // one arrangement, so three placements of one pair archetype would be three
  // identical couples at identical relative offset/scale/yaw. Each
  // variant is capped at 2, so the same couple can appear at most twice on a
  // board and never in the same neighbourhood.
  baseCount: 6,
  maxCount: 2,
  clearance: BOARD_LEAF_CLEARANCE,
}
/** The second couple (build.ts `LEAF_CLUMPS.pairB`): a different partner scale,
 * separation, yaw pair and tone pair. */
const MAPLE_LEAF_PAIR_B: PropArchetype = {
  ...MAPLE_LEAF_PAIR,
  id: 'maple-leaf-pair-b',
  asset: 'maple-leaf-pair-b',
  footprint: 30,
  weight: 0.8,
  baseCount: 6,
  maxCount: 2,
}
/** THE HERO BLADE — the biggest leaf the board's provable rim clearance allows
 * (radius 25.4 against the 25.81 ceiling, a 44-unit blade ≈ 45 px at the
 * default framing), on the paper the camera always centres on. */
const MAPLE_LEAF_MINI: PropArchetype = {
  id: 'maple-leaf-mini',
  asset: 'maple-leaf-mini',
  footprint: 26,
  // 'open', not 'edge': the edge band accepts any cell within 44 units of the
  // slab rim, so a leaf that spans 45 units would straddle the board bevel
  // half the time. 'open' hard-requires 30 units of clearance — more
  // than the blade's own half-extent — and it puts the drifted leaf on the
  // paper the camera actually frames instead of on the rim behind the UI.
  affinity: 'open',
  // SINGLES ARE THE MINORITY: a ~3:1 clump-to-single ratio is what makes the
  // same blade count read as wind-banked rather than as litter, so the single
  // caps are 2/1/1. The CAP is what makes singles the minority; the candidate
  // SUPPLY still has
  // to be generous, because MapleSpire's own mark has to land in the default
  // hero framing seed after seed and one capped-at-2 archetype with a thin
  // supply misses ~1 board in 8 (measured)
  weight: 1,
  scaleJitter: [0.85, 1.05],
  rotation: 'random-y',
  baseCount: 8,
  maxCount: 2,
  clearance: BOARD_LEAF_CLEARANCE,
}
/** The B blade — smaller, burnt orange and MUTED (build.ts). Singles are the
 * most numerous leaf on a board and one geometry carries one tone, so the
 * A/B/C split is what keeps them from reading as one stamp. */
const MAPLE_LEAF_MINI_B: PropArchetype = {
  ...MAPLE_LEAF_MINI,
  id: 'maple-leaf-mini-b',
  asset: 'maple-leaf-mini-b',
  footprint: 22,
  weight: 0.7,
  baseCount: 3,
  maxCount: 1,
}
/** The C blade — the PALE AMBER one, and the reason it is a board prop at all:
 * amber is the only tone in the family lighter than walnut, so it is the only
 * one that separates from the board by value rather than by hue. On the beige
 * desk it would be near-isoluminant. */
const MAPLE_LEAF_MINI_C: PropArchetype = {
  ...MAPLE_LEAF_MINI,
  id: 'maple-leaf-mini-c',
  asset: 'maple-leaf-mini-c',
  footprint: 19,
  weight: 0.6,
  baseCount: 2,
  maxCount: 1,
}

export const DECOR_PACKS: DecorPackMeta[] = [
  {
    id: 'maquette-people',
    nameKey: 'view3d.decor.pack.maquette-people',
    archetypes: [
      {
        id: 'person-standing',
        asset: 'person-standing',
        footprint: 9,
        affinity: 'near-node',
        weight: 1,
        scaleJitter: [0.92, 1.08],
        rotation: 'face-nearest-node',
        // split A/B so the crowd does not read as clones:
        // same silhouette recipe, terracotta vs slate shirt + opposite lean
        baseCount: 4,
      },
      {
        id: 'person-standing-b',
        asset: 'person-standing-b',
        footprint: 9,
        affinity: 'near-node',
        weight: 1,
        scaleJitter: [0.9, 1.06],
        rotation: 'face-nearest-node',
        baseCount: 3,
      },
      {
        id: 'person-pointing',
        asset: 'person-pointing',
        footprint: 9,
        affinity: 'near-connection',
        weight: 0.8,
        scaleJitter: [0.92, 1.08],
        rotation: 'face-nearest-node',
        baseCount: 5,
      },
      {
        id: 'person-pair',
        asset: 'person-pair',
        footprint: 16,
        affinity: 'open',
        weight: 0.5,
        scaleJitter: [0.95, 1.05],
        rotation: 'random-y',
        baseCount: 3,
      },
      {
        // mid-stride toward the node it faces — motion breaks the
        // everyone-stands-at-attention read
        id: 'person-walking',
        asset: 'person-walking',
        footprint: 9,
        affinity: 'open',
        weight: 0.8,
        scaleJitter: [0.92, 1.08],
        rotation: 'face-nearest-node',
        baseCount: 3,
      },
      {
        // hauling a little crate toward the machine it serves
        id: 'person-carrying',
        asset: 'person-carrying',
        footprint: 10,
        affinity: 'near-node',
        weight: 0.7,
        scaleJitter: [0.94, 1.06],
        rotation: 'face-nearest-node',
        baseCount: 2,
      },
    ],
  },
  {
    id: 'datacenter',
    nameKey: 'view3d.decor.pack.datacenter',
    archetypes: [
      {
        id: 'server-rack',
        asset: 'server-rack',
        footprint: 18,
        affinity: 'near-node',
        attractTypes: ['store'],
        weight: 1,
        scaleJitter: [0.95, 1.05],
        // face the drum it serves — 'grid' could turn the blank back to the
        // camera and hide the slots/LED money face
        rotation: 'face-nearest-node',
        baseCount: 4,
      },
      {
        id: 'cable-spool',
        asset: 'cable-spool',
        footprint: 14,
        affinity: 'edge',
        // kept low: the pack must read racks-first, spools second
        weight: 0.6,
        scaleJitter: [0.85, 1.1],
        rotation: 'random-y',
        baseCount: 3,
      },
      {
        id: 'supply-crate',
        asset: 'supply-crate',
        footprint: 13,
        affinity: 'open',
        weight: 0.7,
        scaleJitter: [0.9, 1.15],
        rotation: 'grid',
        baseCount: 5,
      },
    ],
  },
  {
    id: 'greenery',
    nameKey: 'view3d.decor.pack.greenery',
    archetypes: [
      {
        id: 'tree-round',
        asset: 'tree-round',
        footprint: 16,
        affinity: 'corner',
        weight: 1,
        scaleJitter: [0.85, 1.2],
        rotation: 'random-y',
        baseCount: 4,
      },
      {
        id: 'tree-tall',
        asset: 'tree-tall',
        footprint: 12,
        affinity: 'edge',
        weight: 0.9,
        scaleJitter: [0.85, 1.25],
        rotation: 'random-y',
        baseCount: 6,
      },
      {
        id: 'planter-shrub',
        asset: 'planter-shrub',
        footprint: 11,
        affinity: 'open',
        weight: 0.6,
        scaleJitter: [0.9, 1.1],
        rotation: 'grid',
        baseCount: 4,
      },
      // a leafy scene carries fallen maples alongside the trees — lighter counts than canadiana's: here the trees are
      // the subject and the leaves are what fell off them. The HERO board
      // blade rides along at full size: it is the one big enough to read as a
      // leaf rather than as confetti, and a greenery board without it shows
      // the trees at 90 px next to leaves at 30.
      { ...MAPLE_LEAF_MINI, weight: 0.8, baseCount: 5, maxCount: 2 },
      { ...MAPLE_LEAF_MINI_B, weight: 0.5, baseCount: 3, maxCount: 1 },
      { ...MAPLE_LEAF_MINI_C, weight: 0.45, baseCount: 2, maxCount: 1 },
      { ...MAPLE_LEAF_DRIFT, weight: 0.8, baseCount: 5, maxCount: 3 },
      { ...MAPLE_LEAF_PAIR, weight: 0.7, baseCount: 5, maxCount: 2 },
      { ...MAPLE_LEAF_PAIR_B, weight: 0.65, baseCount: 5, maxCount: 2 },
      { ...MAPLE_LEAF_BANK, weight: 1, baseCount: 16, maxCount: 2 },
      { ...MAPLE_LEAF_FALL, weight: 0.8, baseCount: 3, maxCount: 3 },
      { ...MAPLE_LEAF_FALL_B, weight: 0.7, baseCount: 3, maxCount: 2 },
    ],
  },
  {
    // desk dressing: moose/beaver/loon/hats/CN-tower miniatures live on
    // the WOOD around the board; the board itself carries the fallen maples —
    // singles and clumps, the way the greenery pack carries trees
    id: 'canadiana',
    nameKey: 'view3d.decor.pack.canadiana',
    archetypes: [
      // the board leaves — MapleSpire's own mark, on the paper's open
      // margins (see MAPLE_LEAF_DRIFT and the loop-2 block above). The
      // single 'hero blades' (MAPLE_LEAF_MINI/-B/-C) are OFF this board
      // since loop 2 round 2: a lone saturated blade is what the critic read
      // as litter between the cards (mini ×2, mini-b, mini-c counted on the
      // run.mjs board); the canadiana singles live on the desk
      // (MAPLE_LEAF_FALL/-B below), the clumps carry the paper.
      MAPLE_LEAF_DRIFT,
      MAPLE_LEAF_PAIR,
      MAPLE_LEAF_PAIR_B,
      MAPLE_LEAF_BANK,
      {
        id: 'moose',
        asset: 'moose',
        footprint: 34,
        affinity: 'open',
        weight: 0.9,
        // ×MOOSE_DESK_GROWTH: 80+ px at the default framing (see it above)
        scaleJitter: [0.96 * MOOSE_DESK_GROWTH, 1.04 * MOOSE_DESK_GROWTH],
        // loop 4 r3: a rear three-quarter showed only a dark silhouette with
        // a crown — head, eyes and antler palm turn to the camera
        rotation: 'face-camera-3q',
        baseCount: 2,
        // a herd of desk moose does not read (critique #7) — and neither did
        // the pair: loop 4 r4's workbench-wide.png showed one at (1240,355)
        // and its twin at (1160,690), the desk reading as scattered copies.
        // ONE bull, promoted into the near band where it is seen.
        maxCount: 1,
        zone: 'desk',
        // 64.6 units tall as built → 11.6 at 0.18: under the LOWEST walk-up
        // (12.5) — see CITY_FAUNA_SCALE. The desk growth is divided back
        // out, so the city moose keeps that size exactly.
        cityScale: 0.18 / MOOSE_DESK_GROWTH,
        // as built (CITY_FAUNA_SCALE measurement) — the showcase projection.
        // Loop 4 r2: the Blender bull (moose.glb) stood 58.1 — 64.1 since
        // loop 4 r4 (head carried higher, volumetric antlers); 64.6 is the
        // procedural fallback, the taller of the two, so it stays the bound
        // (glbAssets.test.ts gates the GLB under it)
        height: 64.6,
        // loop 4 r2: in the near band, not on the far edge (placement.ts)
        nearBand: true,
      },
      { ...BEAVER, weight: 0.7 },
      {
        id: 'loon',
        asset: 'loon',
        // 22: the loon is ~48 units tail tip to dagger bill — keep the
        // strict desk radius honest
        footprint: 22,
        affinity: 'open',
        weight: 0.6,
        scaleJitter: [0.9, 1.1],
        rotation: 'random-y',
        baseCount: 1,
        // one of each animal (loop 4 r4, same rule as the moose and the
        // beaver): uncapped, the draw put 2-3 loons on the desk on 9 of 24
        // seeds at rich density (placement.test.ts, measured 2026-10-09)
        maxCount: 1,
        zone: 'desk',
        cityScale: CITY_FAUNA_SCALE,
      },
      {
        id: 'ranger-hat',
        asset: 'ranger-hat',
        // loop 4: the brim grows 20 → 28 (×DESK_PROP_GROWTH, build.ts)
        footprint: 34,
        affinity: 'open',
        weight: 0.6,
        scaleJitter: [0.9, 1.05],
        rotation: 'random-y',
        baseCount: 1,
        zone: 'desk',
      },
      // generous on canadiana: the desk's visible-sector bias puts most of the
      // annulus behind the tool rails, so the supply has to be big enough that
      // at least one clump lands in the frame's dressed top-left
      { ...MAPLE_LEAF_CLUSTER, weight: 1, baseCount: 5 },
      { ...MAPLE_LEAF_FALL, weight: 1.1, baseCount: 5 },
      { ...MAPLE_LEAF_FALL_B, weight: 0.9, baseCount: 4 },
      {
        // a souvenir CN Tower on its granite plinth (cn-tower.glb,
        // desk_tools_assets.py: plan radius 13.6 — the plinth — and 123.4
        // tall). Quality pass "cntower", tp-final-dpr1/workbench-wide.png: "an
        // untextured white cone that dominates the frame: tallest object on
        // the set, stands on the mat at the board's front-left edge, cuts
        // across the Analyst connection". The ornament is 0.44 of the old
        // 281-unit cone, and it rides the FAR band: with a view it is moved
        // beyond the board's far edges, where a tall piece rises over bare
        // desk instead of over the cards and cables, wholly off the slab
        // (placement.test.ts gates both).
        id: 'cn-tower',
        asset: 'cn-tower',
        footprint: 14,
        affinity: 'open',
        weight: 1,
        scaleJitter: [0.95, 1.05],
        rotation: 'random-y',
        baseCount: 1,
        // there is exactly ONE CN Tower — twin towers break the landmark read
        maxCount: 1,
        zone: 'desk',
        // CN_TOWER_HEIGHT (build.ts) — the far band's projection test
        height: 124,
        // wholly off the slab in the organic draw too (keepsClear's desk rule)
        clearance: 0,
        farBand: true,
        // …and never rising over a card, a label or a cable on screen: the
        // far band alone still let it stand beside a side corner of the
        // board, its shaft across the cards there (placement.ts)
        clearOfBoard: true,
      },
      {
        id: 'compass',
        asset: 'compass',
        footprint: 16,
        affinity: 'open',
        weight: 0.5,
        scaleJitter: [0.9, 1.1],
        rotation: 'random-y',
        baseCount: 1,
        zone: 'desk',
        // the drafting tools lie with the drawings (quality pass "layout":
        // scattered round the board they read as a border of debris)
        workZone: 'reference',
      },
      {
        id: 'scalpel',
        asset: 'scalpel',
        footprint: 24,
        affinity: 'open',
        weight: 0.5,
        scaleJitter: [0.9, 1.1],
        rotation: 'random-y',
        baseCount: 1,
        zone: 'desk',
        workZone: 'reference',
      },
      {
        // the little desk flag on its weighted base — appended LAST so it
        // never shifts the other props' deterministic placement
        id: 'canada-flag',
        asset: 'canada-flag',
        // 38, not the pole's radius: the banner reaches POLE_R + SHEET_W ≈ 45
        // units out from the mast and the base disc is 15. Two desk props
        // clear each other by `footprint_a + footprint_b`, so a pole-sized
        // footprint lets a leaf clump sit inside the base disc, under the
        // banner. It stays the LARGEST desk footprint on purpose:
        // `placeDecor`'s showcase promotion picks the largest desk footprint,
        // and that pick must not change hands.
        footprint: 38,
        affinity: 'open',
        // E[candidates] = weight·baseCount·… and the cap keeps only the first,
        // so the pair must be generous or the flag no-shows entirely (0.5 × 1
        // yields zero). The desk's greedy collision pass can still lose it on
        // some seeds, so presence is gated at ≥90% of seeds in build.test.ts.
        weight: 1.6,
        scaleJitter: [0.92, 1.08],
        // random-y is SAFE (and preferable): the sheet is a flat 2:1 plane a
        // free yaw would show edge-on about half the time, but build.ts folds
        // the yaw onto FLAG_YAW_BAND — the sheet's normal lands within ±0.5 rad of the
        // camera azimuth whatever the placement drew, so the flag is always
        // broadside and the free draw is spent purely on variety.
        rotation: 'random-y',
        baseCount: 4,
        // one flag reads as a desk flag; a row of them reads as a parade
        maxCount: 1,
        zone: 'desk',
        // the city's flagpole on the apron beside the slab. Loop 3 set 0.3
        // (21.2 units, level with the tallest walk-up) to stop it standing at
        // twice the houses — and loop 3 r2 measured the result as a 12 x 10
        // px speck in city-wide.png, readable only in a 3x crop. 0.5 makes it
        // a CIVIC flagpole: 35 units, ~1.6x the tallest walk-up (a municipal
        // pole is 1.3-1.6x a three-storey block), and the showcase projection
        // now stands it in the foreground apron where it is biggest. It is
        // still the largest city-eligible desk footprint, so the showcase
        // promotion keeps choosing it there too. City scale (backgrounds.ts
        // CITY_SCALE, 2026-10-10): the same 35 units are now 4.4 storeys of
        // CITY_STOREY, ~0.6x the 54-66-unit blocks round the plaza — a
        // municipal pole beside a 6-8-storey block, coherent as it stands
        // (and the apron has no room for more: the 38 x 0.5 x 1.08 = 20.5
        // reach takes 45 of CITY_HOLE_APRON's 48 with the 2-unit reveals).
        cityScale: 0.5,
        // FLAG_HEIGHT (build.ts) — base to finial, the showcase projection
        height: 70.5,
      },
    ],
  },
]

export function getDecorPack(packId: string | null | undefined): DecorPackMeta | null {
  // packId is optional on SceneDecor3D — tray/background-only decors have none
  if (!packId) return null
  return DECOR_PACKS.find((p) => p.id === packId) ?? null
}

/**
 * WORKBENCH props — shared by every pack, placed in the desk annulus OUTSIDE
 * the slab (zone 'desk', lit profile only: the wood plane doesn't exist
 * unlit). Real-world objects at real scale next to the miniature buildings —
 * the pencil-beside-the-maquette read.
 */
/** Growth of the FOREGROUND desk set pieces — the companion mug and the
 * near-band notebooks and plant — through their scale jitter (view3d quality
 * loop 4 r4, workbench-wide.png: "the mug, plant, notebooks, books and
 * pencil cup are all 15-40 px … the desk reads as sparse scattered specks").
 * Riding the jitter keeps every collision and framing test honest —
 * placement.ts multiplies the footprint and the projected height by the
 * drawn scale — while the showcase pick (raw footprint) does not change
 * hands. The FAR-band pencil cup and books stay at 1: grown, the books took
 * a cell the flag's no-view promotion wanted (seed 60604, placement.test
 * "the far-band pieces never displace an older prop"). */
export const DESK_SET_GROWTH = 1.35
const grown = (lo: number, hi: number): [number, number] => [lo * DESK_SET_GROWTH, hi * DESK_SET_GROWTH]
export const DESK_ARCHETYPES: PropArchetype[] = [
  {
    id: 'desk-pencil',
    asset: 'desk-pencil',
    footprint: 30,
    affinity: 'open',
    weight: 1,
    scaleJitter: [0.9, 1.1],
    rotation: 'random-y',
    baseCount: 2,
    zone: 'desk',
    // quality pass "layout": with a view, ONE pencil lies by the coffee and
    // the notes (tp-final-dpr1/workbench-wide.png carried four, spaced round
    // the board like a border)
    workZone: 'coffee',
  },
  {
    id: 'desk-cable-coil',
    asset: 'desk-cable-coil',
    // loop 4: grown ×DESK_PROP_GROWTH and centred on its plan box (build.ts);
    // the rotation-safe radius as built is gated in build.test.ts. (The old
    // 22 was a coil-centred radius that ignored the plug's 34-unit reach.)
    // The Blender coil (desk-cable-coil.glb) measures plan radius 34.4.
    footprint: 36,
    affinity: 'open',
    weight: 0.9,
    scaleJitter: [0.85, 1.15],
    rotation: 'random-y',
    baseCount: 2,
    zone: 'desk',
    // quality pass "cntower", tp-final-dpr1/workbench-cable-coil.png: "half
    // sinks under the board edge". The desk score only kept the CENTRE 10
    // units off the slab, so a 36-unit footprint reached 26 under it; with a
    // clearance the whole footprint stands off the slab (keepsClear's desk
    // rule, 3-unit reveal) — placement.test.ts gates it
    clearance: 0,
  },
  {
    id: 'desk-note',
    asset: 'desk-note',
    // loop 4: two 50 x 32 index cards (desk-note.glb) instead of one 34 x 25
    // card — the plan radius as exported is 33.3 (desk_assets.py prints it,
    // glbAssets.test.ts gates it)
    footprint: 34,
    affinity: 'open',
    weight: 0.7,
    scaleJitter: [0.9, 1.05],
    rotation: 'random-y',
    // 1, to leave room for the Canadiana signature on a crowded desk
    baseCount: 1,
    zone: 'desk',
    workZone: 'coffee',
  },
  {
    // loop 4's hero desk object: the enamel camp mug with the official leaf
    // (desk-mug.glb). The desk's FOREGROUND COMPANION — with a view, it is
    // moved into the framed foreground opposite the showcase (placement.ts),
    // so the near-left desk is no longer bare. Plan radius as exported 25.8
    // (handle included; 25.3 before quality pass "mug" re-swept the handle),
    // 44 tall. Quality pass "layout": it LEADS the coffee corner — the
    // notebooks, a note and a pencil gather beside it.
    id: 'desk-mug',
    asset: 'desk-mug',
    footprint: 26,
    affinity: 'open',
    weight: 0.8,
    scaleJitter: grown(0.95, 1.05),
    rotation: 'random-y',
    baseCount: 1,
    // one coffee per desk
    maxCount: 1,
    zone: 'desk',
    height: 44,
    companion: true,
    workZone: 'coffee',
    zoneLead: true,
  },
  // the Canadian-workshop signature rides along on EVERY pack's desk
  // (MapleSpire!): a clump plus a single blade, so the visible desk shows
  // several separate leaves rather than one object.
  MAPLE_LEAF_CLUSTER,
  MAPLE_LEAF_FALL,
  BEAVER,
  // ── loop 4 r2-r4 desk set pieces, appended LAST so the older props'
  // organic draw is untouched; all stay under the flag's 38 footprint or are
  // zone pieces (the showcase pick never changes hands). Loop 4 laid them in
  // bands and gaps — spread apart, they read as a border round the board
  // (quality pass "layout"); with a view they now gather in WORK ZONES
  // (placement.ts): the coffee corner (mug, notebooks, note, pencil), the
  // reference stack (sketchbook, books, blueprint, compass, scalpel) in the
  // other near corner, and the greenery by the lamp (plant, pencil cup).
  {
    // two pocket notebooks + a pen (desk-notebooks.glb, plan radius 32.5)
    id: 'desk-notebooks',
    asset: 'desk-notebooks',
    footprint: 33,
    affinity: 'open',
    weight: 0.8,
    scaleJitter: grown(0.95, 1.05),
    rotation: 'random-y',
    baseCount: 1,
    maxCount: 1,
    zone: 'desk',
    height: 14,
    workZone: 'coffee',
  },
  {
    // a snake plant in a terracotta pot (desk-plant.glb, plan radius 16.2,
    // 74.6 tall) — the tall anchor; leads the greenery beside the lamp, on
    // the far band (a tall piece over bare desk beyond the board)
    id: 'desk-plant',
    asset: 'desk-plant',
    footprint: 17,
    affinity: 'open',
    weight: 0.8,
    scaleJitter: grown(0.95, 1.05),
    rotation: 'random-y',
    baseCount: 1,
    maxCount: 1,
    zone: 'desk',
    height: 75,
    farBand: true,
    workZone: 'greenery',
    zoneLead: true,
  },
  {
    // a walnut pencil cup with five pencils and a steel ruler
    // (desk-pencil-cup.glb, plan radius 18.4, 82.5 tall) — beside the plant
    id: 'desk-pencil-cup',
    asset: 'desk-pencil-cup',
    footprint: 19,
    affinity: 'open',
    weight: 0.8,
    scaleJitter: [0.95, 1.05],
    rotation: 'random-y',
    baseCount: 1,
    maxCount: 1,
    zone: 'desk',
    height: 83,
    workZone: 'greenery',
  },
  {
    // three small hardbacks stacked askew (desk-books.glb, plan radius
    // 36.0, 21.3 tall) — the reference stack's books
    id: 'desk-books',
    asset: 'desk-books',
    footprint: 37,
    affinity: 'open',
    weight: 0.8,
    scaleJitter: [0.95, 1.0],
    rotation: 'random-y',
    baseCount: 1,
    maxCount: 1,
    zone: 'desk',
    height: 22,
    workZone: 'reference',
  },
  {
    // an A6 spiral sketchbook lying open, a pencil across the drawing
    // (desk-sketchbook.glb, plan radius 54.2, 4.7 tall) — LEADS the reference
    // stack, laid in the near corner across the frame from the coffee
    id: 'desk-sketchbook',
    asset: 'desk-sketchbook',
    footprint: 55,
    affinity: 'open',
    weight: 0.8,
    scaleJitter: [0.96, 1.0],
    rotation: 'random-y',
    baseCount: 1,
    maxCount: 1,
    zone: 'desk',
    height: 5,
    workZone: 'reference',
    zoneLead: true,
  },
  {
    // a blueprint half unrolled from its roll, a rubber band round it
    // (desk-blueprint.glb, plan radius 53.0, 12.4 tall)
    id: 'desk-blueprint',
    asset: 'desk-blueprint',
    footprint: 54,
    affinity: 'open',
    weight: 0.8,
    scaleJitter: [0.96, 1.0],
    rotation: 'random-y',
    baseCount: 1,
    maxCount: 1,
    zone: 'desk',
    height: 13,
    workZone: 'reference',
  },
]
