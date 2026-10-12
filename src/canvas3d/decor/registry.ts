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
const BEAVER: PropArchetype = {
  id: 'beaver',
  asset: 'beaver',
  footprint: 20,
  affinity: 'open',
  // E[count] = weight·baseCount·√area — below ~1 most boards show NO beaver
  // at all, which defeats the whole Canadian-workshop signature
  weight: 0.6,
  scaleJitter: [0.9, 1.1],
  rotation: 'random-y',
  baseCount: 2,
  zone: 'desk',
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

/** The DESK clump — four blades piled on the workbench beside the flag. */
const MAPLE_LEAF_CLUSTER: PropArchetype = {
  id: 'maple-leaf-cluster',
  asset: 'maple-leaf-cluster',
  // ceil(`mapleClumpLayout('cluster').radius`). The strict desk no-overlap
  // radius IS this radius, so a clump can never pile onto another desk prop.
  footprint: 33,
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
  maxCount: 3,
  zone: 'desk',
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
  footprint: 26,
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
  footprint: 26,
  affinity: 'near-connection',
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
  maxCount: 3,
}
/** The 2-blade PAIR. Loose drifts of 2-4 leaves: the desk cluster is the 4, the drift is the 3, and this is the 2. It
 * also fits cells the 3-blade drift cannot — a smaller footprint gets into the
 * gaps between cards, which is where fallen leaves actually collect. */
const MAPLE_LEAF_PAIR: PropArchetype = {
  id: 'maple-leaf-pair',
  asset: 'maple-leaf-pair',
  footprint: 25,
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
}
/** The second couple (build.ts `LEAF_CLUMPS.pairB`): a different partner scale,
 * separation, yaw pair and tone pair. */
const MAPLE_LEAF_PAIR_B: PropArchetype = {
  ...MAPLE_LEAF_PAIR,
  id: 'maple-leaf-pair-b',
  asset: 'maple-leaf-pair-b',
  footprint: 25,
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
      // the board leaves — MapleSpire's own mark, on the paper the camera
      // always frames (see MAPLE_LEAF_MINI / MAPLE_LEAF_DRIFT above)
      MAPLE_LEAF_MINI,
      MAPLE_LEAF_MINI_B,
      MAPLE_LEAF_MINI_C,
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
        scaleJitter: [0.92, 1.08],
        rotation: 'random-y',
        baseCount: 2,
        // a pair reads fine; a herd of desk moose does not
        maxCount: 2,
        zone: 'desk',
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
        zone: 'desk',
      },
      {
        id: 'ranger-hat',
        asset: 'ranger-hat',
        footprint: 24,
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
        // one slender landmark looming past the board edge
        id: 'cn-tower',
        asset: 'cn-tower',
        footprint: 26,
        affinity: 'open',
        weight: 1,
        scaleJitter: [0.95, 1.05],
        rotation: 'random-y',
        baseCount: 1,
        // there is exactly ONE CN Tower — twin towers break the landmark read
        maxCount: 1,
        zone: 'desk',
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
  },
  {
    id: 'desk-cable-coil',
    asset: 'desk-cable-coil',
    footprint: 22,
    affinity: 'open',
    weight: 0.9,
    scaleJitter: [0.85, 1.15],
    rotation: 'random-y',
    baseCount: 2,
    zone: 'desk',
  },
  {
    id: 'desk-note',
    asset: 'desk-note',
    footprint: 20,
    affinity: 'open',
    weight: 0.7,
    scaleJitter: [0.9, 1.05],
    rotation: 'random-y',
    // 1, to leave room for the Canadiana signature on a crowded desk
    baseCount: 1,
    zone: 'desk',
  },
  // the Canadian-workshop signature rides along on EVERY pack's desk
  // (MapleSpire!): a clump plus a single blade, so the visible desk shows
  // several separate leaves rather than one object.
  MAPLE_LEAF_CLUSTER,
  MAPLE_LEAF_FALL,
  BEAVER,
]
