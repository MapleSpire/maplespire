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

/**
 * Deterministic decoration placement — a PURE function (no three, no DOM):
 * every client that shares (diagram, pack, density, seed) computes the exact
 * same prop transforms, so decor never syncs anything but the tiny
 * `sceneDecor` setting.
 *
 * STABILITY is the design center: placement decisions hash PER CELL
 * (`archetypeId × cellX × cellZ × seed`), never sequentially — adding one
 * node only re-decides the cells whose blocked/affinity status actually
 * changed; every other prop keeps its exact position, rotation and scale.
 * (A sequential RNG would reshuffle the whole board on any edit.)
 *
 * propId = `archetypeId:cellX:cellZ` — stable across releases, which is what
 * makes the reserved per-prop override map (`SceneDecor3D.props`) possible
 * without a schema change.
 *
 * On top of the per-cell draw sits one deterministic post-pass: the per-node
 * person adjacency guarantee promotes the best-hashed person cell
 * beside any card the organic draw left bare — same hash/jitter/propId
 * recipe, so the whole pipeline stays a pure function of the input.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type PropAffinity = 'near-node' | 'near-connection' | 'edge' | 'corner' | 'open'

export interface PropArchetype {
  /** Stable id ('person-standing') — propIds depend on it. */
  id: string
  /** 'person' opts into the crowd-staging rules (per-node adjacency
   * guarantee, open-scatter clustering + orphan cap). Ids starting with
   * 'person' are treated as people even without this field — the built-in
   * pack convention. */
  kind?: 'person' | 'prop'
  /** GLB asset id inside the pack chunk. */
  asset: string
  /** Collision radius, world px at scale 1. */
  footprint: number
  affinity: PropAffinity
  /** Node types that attract this archetype (near-node only). */
  attractTypes?: string[]
  /** Relative frequency within the pack (probability weight). */
  weight: number
  scaleJitter: [number, number]
  /** 'face-camera-3q': an animal whose face IS the prop (the moose, the
   * beaver — head at the asset's +X). With a `view`, every instance turns its
   * +X muzzle toward the default framing's camera, a seeded 30-50° off it
   * (a three-quarter view: head, eyes and antler palm, never the rump). No
   * view: as 'random-y'. */
  rotation: 'face-nearest-node' | 'random-y' | 'grid' | 'face-camera-3q'
  /** Target count at density 'normal' on a reference-area board. */
  baseCount: number
  /** HARD per-scene instance cap (unique landmarks — a skyline gets ONE CN
   * Tower, ever). Density/area scaling still drives the organic
   * draw, but the cap binds the placed count AFTER that scaling, and every
   * guarantee/promotion pass respects it too. Unset ⇒ only the global
   * MAX_PER_ARCHETYPE draw-sanity ceiling applies. */
  maxCount?: number
  /** Where this prop lives: ON the paper board (default) or on the DESK
   * around it (the workbench annulus — real-world objects at real scale,
   * the pencil-next-to-buildings read). Desk placement
   * only happens when the host passes `deskBand` (lit profile — the
   * workbench plane does not exist unlit). */
  zone?: 'board' | 'desk'
  /** Minimum gap (world px) between the prop's FOOTPRINT (footprint ×
   * scale) and every node rect, connection polyline and avoided box — and
   * its footprint never straddles the slab rim or a group platform rim.
   * Unset: the legacy test, which checks only the prop's CENTRE against a
   * 14-px node margin (a 25-px leaf could overlap a card by 11 px).
   * On a DESK prop it means the footprint stays wholly off the slab (3-px
   * reveal) — never tucked half under the overhang. */
  clearance?: number
  /** DESK props only: the scale this prop takes in the CITY world, on top of
   * its jitter — or unset, and the prop is not placed in the city at all.
   * The city ring is a maquette (2-3 storey walk-ups 12.5-21 units tall,
   * backgrounds.ts), so a desk-scale moose (~60 units with antlers) stood
   * twice as tall as the houses beside it (view3d quality loop 3,
   * city-wide.png). Desk TOOLS (pencil, coil, note, compass…) have no
   * meaningful city scale and stay unset. Since CITY_SCALE (2026-10-10) the
   * blocks round the plaza stand 54-66 units on an 8-unit storey; the
   * scales were kept — a city prop now sits at people / civic scale. */
  cityScale?: number
  /** Overall height (world px at scale 1, base to top). Read by the desk
   * showcase's projection test (`PlacementInput.view`); unset = 2 × the
   * footprint, a conservative stand-in. */
  height?: number
  /** DESK props only: the desk's FOREGROUND COMPANION (view3d quality loop
   * 4: "the near-left desk is bare"). When the host passes `view`, one
   * instance is promoted — MOVED at its cap, like the showcase — into the
   * framed near desk as far across the frame from the showcase as it allows,
   * so the default framing's two near corners each carry a hero piece. Not in
   * the city (a companion without a `cityScale` has no city placement), and
   * nothing changes without a view. */
  companion?: boolean
  /** DESK props only: a NEAR-BAND set piece (view3d quality loop 4 r2: "the
   * beaver is a 20-px speck on the far edge; the lower quadrants are bare
   * desk"). With a `view`, one instance is promoted — MOVED at its cap — into
   * the same framed foreground band as the companion, AFTER it, each piece as
   * far on screen from the foreground pieces already placed (showcase,
   * companion, earlier near-band pieces) as the band allows. Same rules as
   * the companion: whole projected box in the safe rect, strict desk spacing,
   * nothing changes without a view. In the CITY only a piece with a
   * `cityScale` is banded (the moose, the beaver), at that scale and wholly
   * on the bare apron (view3d quality pass "wildlife"). */
  nearBand?: boolean
  /** DESK props only: a FAR-BAND set piece (view3d quality loop 4 r3:
   * "the whole far desk band is bare streaked wood"). The near band's pass
   * and rules, mirrored: with a `view`, one instance is MOVED into the framed
   * desk BEYOND the board — its whole projected box in the safe rect, its
   * foot in the upper FAR_BAND_HIGH of it — as far on screen from the pieces
   * already placed as the band allows. Promoted after every near-band piece;
   * never in the city; nothing changes without a view. */
  farBand?: boolean
  /** FAR-BAND pieces only: a TALL piece whose projected box must not
   * overlap the board on screen — the slab's top and everything standing on
   * it up to BOARD_SCREEN_LIFT (quality pass "cntower",
   * tp-final-dpr1/workbench-wide.png: "the CN Tower … stands at the board's
   * front-left edge, cuts across the Analyst connection"). The far band alone
   * still allowed a foot beside a SIDE corner, where a 124-unit shaft rose
   * across the cards beside it (3 of 24 seeds, placement.test.ts). Nothing
   * changes without a view. */
  clearOfBoard?: boolean
  /** DESK props only: the WORK ZONE the piece belongs to (quality pass
   * "layout", tp-final-dpr1/workbench-wide.png: "props sit evenly spaced
   * around the board perimeter like a border, the left foreground desk is
   * empty while the right edge stacks moose, blueprint, mug and pencil").
   * With a `view` on the workbench, every instance is lifted off the desk
   * and ONE is laid back beside its zone's lead — a coffee corner, a
   * reference stack, a plant by the lamp — instead of wherever the organic
   * draw scattered it. Drawn LAST in the organic pass (it only takes cells
   * nothing older wanted, so the view's lift never strands a hole an older
   * prop was steered around). Never in the city; nothing changes without a
   * view. */
  workZone?: WorkZone
  /** The piece its work zone forms around (one per zone). The coffee lead is
   * the `companion` (the mug), the greenery lead a `farBand` piece (the
   * plant, beside the lamp); a lead with neither is the REFERENCE lead,
   * laid in the near band as far on screen from the coffee corner as the
   * frame allows — so the two near corners each carry a zone. */
  zoneLead?: boolean
}

/** The workbench's work zones (see PropArchetype.workZone). */
export type WorkZone = 'coffee' | 'reference' | 'greenery'

/** The DEFAULT framing of the board, as the viewer gets it: the camera's
 * view-projection matrix (column-major, a THREE.Matrix4's `elements`), the
 * canvas size and the unobstructed rectangle inside it (css px — the canvas
 * minus the floating side panels, tool rail and toolbars), and the world
 * height of the desk plane. Plain numbers, so placement stays a pure
 * function of its input: the host computes the pose (camera.ts) and the
 * safe rect (canvasSafeArea.ts) and hands them in. */
export interface ShowcaseView {
  viewProj: readonly number[]
  viewport: { width: number; height: number }
  safe: Rect
  deskY: number
}

/** The background world around the board (Scene3D.backgroundWorld). */
export type DecorWorld = 'workbench' | 'city' | 'studio' | 'void'

/** Width (world px) of the bare desk apron the CITY world leaves between the
 * slab and its own street margin — the city builder's `hole` is the slab
 * grown by this on every side, and its hole test (backgrounds.test.ts,
 * "never intrudes into the hole") proves nothing is ever built inside it.
 * Shared so the two can never drift: Scene3D sizes the hole with it, and
 * placement keeps every city desk prop's whole footprint inside it.
 *
 * 48 (was 35, view3d quality loop 3 r2): the city flag was a 12 x 10 px
 * speck at its 0.3 maquette scale, and at the civic 0.5 its footprint (the
 * banner's reach, 38 x 0.5 x 1.08 = 20.5) needs 41 + the 2-px reveals of
 * apron — 35 could not hold it, so the flag would simply never land. */
export const CITY_HOLE_APRON = 48

/** Height (world px over the paper) of the diagram a `clearOfBoard` piece's
 * projected box keeps clear of: the datastore drum, the tallest thing on a
 * board (Scene3D DRUM_H = 64; a card is CAMERA_PRESETS.iso.depth = 18). */
export const BOARD_SCREEN_LIFT = 64

export interface PlacementInput {
  archetypes: PropArchetype[]
  density: 'sparse' | 'normal' | 'rich'
  /** uint32 — from SceneDecor3D.seed (or derived from the diagram id). */
  seed: number
  /** Content bounds (world px, top-left + size). */
  bounds: Rect
  /** Resolved floor padding around the bounds. */
  pad: { x: number; y: number }
  /** Grid-fracture inset (eightbit) — keep props off the missing terrain. */
  fractureBand: number
  nodes: { id: string; type: string; rect: Rect }[]
  groups: Rect[]
  /** Routed connection polylines (sampled points, world px). */
  connections: { points: { x: number; y: number }[] }[]
  /** Board boxes no prop may cover — the connection label plates (a maple
   * leaf landing on 'writes' made it unreadable — view3d quality loop
   * city screenshot, 2026-10-08). Optional: omitted = none. */
  avoid?: Rect[]
  /** Width (world px) of the DESK annulus outside the slab where
   * zone:'desk' archetypes may land. Omit to disable desk placement
   * (unlit themes have no workbench plane). */
  deskBand?: number
  /** Background world (default 'workbench'). 'void' has NO desk plane
   * (Scene3D builds it only for world !== 'void'), so desk props are off.
   * 'city' turns the desk annulus into the bare apron inside the city hole:
   * only archetypes with a `cityScale` land there, at that scale, with their
   * whole footprint between the slab and the CITY_HOLE_APRON line — never
   * among the city's buildings (view3d quality loop 3, city-wide.png). */
  world?: DecorWorld
  /** The default framing (see ShowcaseView). When given, the desk showcase
   * is promoted only where its whole projected box lies inside `view.safe`,
   * preferring the foreground; omitted = the legacy W-band window, which was
   * probe-tuned with both side panels CLOSED. */
  view?: ShowcaseView
  /** The desk lamp's foot on the workbench (world px, centre + radius) —
   * Scene3D builds it beside the board's far edge. Every desk prop keeps its
   * whole footprint off it, and the greenery zone gathers beside it.
   * Omitted = no lamp. */
  lamp?: { x: number; z: number; r: number }
}

export interface PlacedProp {
  propId: string
  archetypeId: string
  x: number
  z: number
  rotY: number
  scale: number
  /** Standing ON a group platform (the host lifts the instance by the
   * platform height) vs on the board itself. */
  onPlatform: boolean
  /** Standing on the WORKBENCH outside the slab (the host drops the
   * instance to desk level). */
  onDesk: boolean
}

/** Cell pitch — the board's dot lattice (props visually snap to its rhythm). */
export const DECOR_CELL = 20
/** Per-archetype instance ceiling (draw sanity on huge boards). */
export const MAX_PER_ARCHETYPE = 40
/** Whole-pack ceiling. */
export const MAX_TOTAL = 96
/** Reference board area for baseCount calibration (a ~5-card diagram). */
const REF_AREA = 1100 * 750

const DENSITY_MUL = { sparse: 0.5, normal: 1, rich: 1.8 } as const

// ── work zones + wildlife clearance (quality pass "layout") ──
/** How far past the slab (world px) a work-zone piece may stand. The desk
 * band (150) never reached the default framing's near CORNERS: unprojected
 * on the live 9-card board (tp2-layout probe, safe rect 388-1260 × 62-898),
 * screen (520, 760) lies 265 units off the slab, (650, 880) 305 and
 * (1240, 760) 246 — the "empty left foreground" the critic named was simply
 * out of every desk prop's reach. */
export const ZONE_REACH = 320
/** World gap (footprint to footprint) between a zone piece and its nearest
 * zone mate: snug enough to read as one corner of the desk, never touching. */
export const ZONE_GAP_MIN = 6
export const ZONE_GAP_MAX = 40
/** The near zones' leads stand with their foot in the lower share of the safe
 * rect below this line (when the frame has a legal cell there): the CORNERS.
 * Without it the companion's "far across from the flag" rule left the coffee
 * corner half-way up the right edge, (1185, 580) on the live board (layout
 * probe 2026-10-09, after1.png). */
export const ZONE_CORNER_LOW = 0.62
/** The reference lead's cell must leave room for this many broad mates
 * beside it (placeDecor's roomOf) before the spread toward the far corner
 * wins. */
const ZONE_ROOM_MIN = 4
/** A near-band animal keeps this share of the safe width (screen, centre to
 * centre) from every zone piece, against NEAR_BAND_SEP from the others: with
 * only the loop-4 spacing the moose stood against the coffee corner and the
 * right edge read as a pile again (layout probe 2026-10-09, after1.png). */
export const ZONE_HALO = 0.22
/** A zone piece's projected box may be covered by at most this share by a
 * TALLER zone mate standing nearer the camera (a note half behind the mug is
 * a desk; a note wholly behind it is a hidden prop). */
const ZONE_HIDDEN_MAX = 0.35
/** World gap (footprint to footprint) every WILDLIFE piece (a face-camera
 * animal: the moose, the beaver) keeps to every other desk prop, on top of
 * the strict no-overlap bound. tp-final-dpr1/workbench-moose.png: the moose
 * stood 12 units in front of the rolled blueprint — legal (no footprint
 * overlap), but on screen its hindquarters sat ON the roll and the blueprint
 * close-up was mostly moose body. The gap is a world bound; the screen bound
 * is the wildlife box rule in the framed passes (placeDecor). */
export const WILDLIFE_GAP = 24
/** Wildlife: the animals that turn their face to the camera. */
const isWildlife = (a: PropArchetype | undefined): boolean => a?.rotation === 'face-camera-3q'

// ── crowd staging (critic #5) ──
// People are the storytelling + scale layer, so they get extra rules on top
// of the generic affinity engine:
//  • near-node people use a TIGHT wall band (they tend the machine, not the
//    neighbourhood) and every card is guaranteed one attendant (see the
//    adjacency pass at the end of placeDecor);
//  • 'open' people cluster — near a cable or near each other — and the count
//    of free-floating loners is capped (orphan pins read as noise).
/** Wall band [min,max] (world px) where a person counts as attending a node. */
const PERSON_ADJ_MIN = 14
const PERSON_ADJ_MAX = 45
/** Cable/plug corridor clearance people keep off — matches the
 * near-connection affinity's inner edge (the ribbon + plug zone). */
const CABLE_CLEAR = 10
/** Clearance (world px) props keep around a connection label plate. */
const LABEL_SKIRT = 12
/** 'Open' people within this of a cable or another person are "clustered";
 * farther = free-floating orphan (capped per board). */
const PERSON_CLUSTER_R = 30

/** Pack convention: person archetypes either declare kind:'person' or carry
 * a 'person…' id (the built-in maquette-people pack). */
const isPerson = (a: PropArchetype): boolean => a.kind === 'person' || (a.kind === undefined && a.id.startsWith('person'))

// ── desk visible-sector bias ──
// The desk annulus wraps the whole board, but the DEFAULT framing (iso
// camera, azimuth 40° / polar 55°) only shows one slice of it, so desk
// cells get a deterministic score multiplier by annulus SECTOR relative to
// the board rect. Measured by projecting placements through the default
// camera: down-screen is +x/+z in world, and because the default framing
// FITS the content with almost no bottom margin, the south (+z) band
// projects BELOW the frame (screen y ≈ 800–1100) and the east (+x) band
// lands behind the app's right details panel. The reliably visible desk is
// the up-screen/left slice: the WEST band's northern half, the NW corner and
// the NORTH band (frame top-left). S keeps a shoulder
// weight (it IS visible on flatter/wider boards that leave bottom margin)
// and every hidden sector keeps a nonzero floor so orbiting users still
// find decor everywhere. Pure math on the placement inputs — no camera
// object here; the bias simply MATCHES the app's default framing, the
// framing the vast majority of boards are ever seen at.
/** NW corner + the adjacent band ends — the frame's dressed top-left. */
const DESK_SECTOR_VISIBLE = 1
/** S, SW — below the default crop on tall boards, visible on flat ones. */
const DESK_SECTOR_SHOULDER = 0.3
/** E, NE, SE — behind the right details panel. Nonzero on purpose. */
const DESK_SECTOR_HIDDEN = 0.12
/** Area-weighted mean of the sector multipliers over a typical annulus —
 * folded into the desk acceptance calibration so the bias REDISTRIBUTES
 * props toward the visible slice instead of thinning the desk overall. */
const DESK_SECTOR_MEAN = 0.41

/** Sector multiplier for an annulus cell. ox/oz are the overhang signs
 * relative to the slab rect (−1|0|+1, never both 0 inside the annulus);
 * tx/tz are the cell's normalized position along the slab's width/height
 * (0..1, west→east / north→south). The W and N bands GRADE away from the
 * NW corner — the visible window is anchored there, and the far half of
 * either band slides off the default crop (projection-verified: a W-band
 * prop at the board's south end lands at screen x < 0). */
const deskSectorMul = (ox: number, oz: number, tx: number, tz: number): number => {
  if (ox === 1) return DESK_SECTOR_HIDDEN // E, NE, SE
  if (ox === -1 && oz === -1) return DESK_SECTOR_VISIBLE // NW
  if (ox === -1 && oz === 0) return 1 - 0.6 * tz // W: 1.0 north end → 0.4 south end
  if (oz === -1) return 0.9 - 0.65 * tx // N: 0.9 west end → 0.25 east end
  return DESK_SECTOR_SHOULDER // S, SW
}

/** 32-bit avalanche mix (splitmix-ish) — cheap, deterministic, well spread. */
function mix(a: number, b: number, c: number, d: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0
  h = Math.imul(h ^ b, 0x85ebca6b) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h ^ c, 0xc2b2ae35) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  h = Math.imul(h ^ d, 0x27d4eb2f) >>> 0
  return (h ^ (h >>> 15)) >>> 0
}

function hashStr(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Deterministic auto-placement (see the module doc). */
export function placeDecor(input: PlacementInput): PlacedProp[] {
  const { bounds, pad, fractureBand } = input
  // Slab interior in world px (matches buildFloor's slab math).
  const x0 = bounds.x - pad.x + fractureBand
  const z0 = bounds.y - pad.y + fractureBand
  const w = bounds.w + 2 * pad.x - 2 * fractureBand
  const h = bounds.h + 2 * pad.y - 2 * fractureBand
  if (w < DECOR_CELL * 4 || h < DECOR_CELL * 4) return []

  const cols = Math.floor(w / DECOR_CELL)
  const rows = Math.floor(h / DECOR_CELL)
  const areaMul = Math.sqrt((w * h) / REF_AREA)
  const densityMul = DENSITY_MUL[input.density]

  // ── the desk, per background world ──
  const world: DecorWorld = input.world ?? 'workbench'
  const city = world === 'city'
  /** Effective desk band: no desk plane in the void; the city's desk is only
   * the bare apron inside its hole (CITY_HOLE_APRON). */
  const deskBand = world === 'void' ? 0 : city ? Math.min(input.deskBand ?? 0, CITY_HOLE_APRON) : (input.deskBand ?? 0)
  /** City desk props stand on the apron's CENTRE LINE: the cell lattice is
   * anchored on the slab (desk cells sit 10, 30, 50… out), so a jittered
   * cell centre would leave the 35-px apron for most footprints. The
   * overhanging axis snaps to the line, the other axis keeps the cell's own
   * tangential jitter — still a pure function of (cell, hash). */
  const cityApronSnap = (cx: number, cz: number, jx: number, jz: number): { x: number; z: number } => {
    const mid = CITY_HOLE_APRON / 2
    const x = cx < x0 ? x0 - mid : cx > x0 + w ? x0 + w + mid : cx + jx
    const z = cz < z0 ? z0 - mid : cz > z0 + h ? z0 + h + mid : cz + jz
    return { x, z }
  }
  /** A city desk prop's whole square footprint lies inside the city hole
   * (2-px reveal) and fully off the slab (2-px reveal, so nothing is tucked
   * under the overhang). */
  const cityApronHolds = (x: number, z: number, r: number): boolean => {
    const A = CITY_HOLE_APRON
    const inHole = x - r >= x0 - A + 2 && x + r <= x0 + w + A - 2 && z - r >= z0 - A + 2 && z + r <= z0 + h + A - 2
    const offSlab = x + r <= x0 - 2 || x - r >= x0 + w + 2 || z + r <= z0 - 2 || z - r >= z0 + h + 2
    return inHole && offSlab
  }

  // ── blocking + affinity fields (computed once, queried per cell) ──
  /** Group platforms are WALKABLE (figurines stand on the pedestal, between
   * the shapes) — only the RIM is off limits: a prop straddling the platform
   * edge would half-float. Blocking the whole group rect would starve every
   * affinity on container views (all the near-node rings, connections and
   * open interior live inside the boundary). */
  const GROUP_RIM = 12
  const rimDist = (g: Rect, cx: number, cz: number): number => {
    const qx = Math.max(g.x - cx, 0, cx - (g.x + g.w))
    const qz = Math.max(g.y - cz, 0, cz - (g.y + g.h))
    const outside = Math.hypot(qx, qz)
    if (outside > 0) return outside
    return Math.min(cx - g.x, g.x + g.w - cx, cz - g.y, g.y + g.h - cz)
  }
  const onPlatformAt = (cx: number, cz: number): boolean =>
    input.groups.some((g) => cx > g.x && cx < g.x + g.w && cz > g.y && cz < g.y + g.h)
  const blocked = (cx: number, cz: number): boolean => {
    // margin keeps props out from under cards and their label skirts
    for (const n of input.nodes) {
      if (cx > n.rect.x - 14 && cx < n.rect.x + n.rect.w + 14 && cz > n.rect.y - 14 && cz < n.rect.y + n.rect.h + 14) return true
    }
    for (const g of input.groups) {
      if (rimDist(g, cx, cz) < GROUP_RIM) return true
    }
    // label plates: the cell centre plus a prop-sized skirt
    for (const r of input.avoid ?? []) {
      if (cx > r.x - LABEL_SKIRT && cx < r.x + r.w + LABEL_SKIRT && cz > r.y - LABEL_SKIRT && cz < r.y + r.h + LABEL_SKIRT) return true
    }
    return false
  }
  // Cable distance is the placement hot path: the desk passes (companion,
  // near/far band, gap filler) query it for every candidate cell — measured
  // 112-126 ms self time per decor pick (run.mjs --profile, me-prof). The
  // segments are flattened once, a segment whose bbox is already farther
  // than the best hit is skipped (exact: the bbox gap bounds the segment
  // distance from below), and repeated cells hit a memo.
  const segs: number[] = []
  for (const c of input.connections) {
    const pts = c.points
    for (let i = 1; i < pts.length; i++) segs.push(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y)
  }
  const connMemo = new Map<number, number>()
  const connDist = (cx: number, cz: number): number => {
    // memo only for points on a 1/8-px lattice (cell centres are), so a key
    // never stands for two different points; |coord| * 8 << 5e6 keeps keys apart
    const memo = Number.isInteger(cx * 8) && Number.isInteger(cz * 8)
    const key = cx * 8 * 1e7 + cz * 8
    const hit = memo ? connMemo.get(key) : undefined
    if (hit !== undefined) return hit
    let best = Infinity
    for (let s = 0; s < segs.length; s += 4) {
      const ax = segs[s]
      const az = segs[s + 1]
      const bx = segs[s + 2]
      const bz = segs[s + 3]
      const gx = Math.max(Math.min(ax, bx) - cx, 0, cx - Math.max(ax, bx))
      const gz = Math.max(Math.min(az, bz) - cz, 0, cz - Math.max(az, bz))
      if (gx * gx + gz * gz >= best * best) continue
      const dx = bx - ax
      const dz = bz - az
      const len2 = dx * dx + dz * dz || 1
      const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cz - az) * dz) / len2))
      const px = ax + t * dx
      const pz = az + t * dz
      const d = Math.hypot(cx - px, cz - pz)
      if (d < best) best = d
    }
    if (memo) connMemo.set(key, best)
    return best
  }
  const rectGap = (r: Rect, cx: number, cz: number): number => {
    const qx = Math.max(r.x - cx, 0, cx - (r.x + r.w))
    const qz = Math.max(r.y - cz, 0, cz - (r.y + r.h))
    return qx > 0 || qz > 0 ? Math.hypot(qx, qz) : -Math.min(cx - r.x, r.x + r.w - cx, cz - r.y, r.y + r.h - cz)
  }
  /** A `clearance` archetype's footprint of `radius` at (cx, cz) keeps its
   * gap to every node, label box and cable, and stays whole on the slab
   * and on (or off) a group platform. */
  const keepsClear = (a: PropArchetype, cx: number, cz: number, radius: number): boolean => {
    const need = radius + (a.clearance ?? 0)
    const edgeD = Math.min(cx - x0, cz - z0, x0 + w - cx, z0 + h - cz)
    const desk = (a.zone ?? 'board') === 'desk'
    if (desk) {
      // a DESK prop with a clearance stays wholly OFF the slab: a flat blade
      // whose footprint reached back under the overhang drew half-hidden
      // beneath the board (view3d quality loop 3, workbench-leaf.png). The
      // most negative edge distance is the overhang along the axis the prop
      // is outside on, so clearing it by the radius clears the slab.
      if (-edgeD < radius + 3) return false
      // every card, label box and cable lies INSIDE the slab, so a footprint
      // 3 px off it is already `radius + 3` from all of them: with a
      // clearance of 3 or less the checks below cannot fail (and skipping
      // them is the framed desk passes' hot path)
      if ((a.clearance ?? 0) <= 3) return true
    }
    for (const n of input.nodes) if (rectGap(n.rect, cx, cz) < need) return false
    for (const r of input.avoid ?? []) if (rectGap(r, cx, cz) < need) return false
    if (input.connections.length > 0 && connDist(cx, cz) < need) return false
    if (!desk) {
      if (edgeD < radius + 3) return false
      for (const g of input.groups) if (rimDist(g, cx, cz) < radius + 3) return false
    }
    return true
  }
  /** A desk footprint of `radius` at (x, z) keeps 3 px off the lamp's foot. */
  const lamp = input.lamp
  const offLamp = (x: number, z: number, radius: number): boolean => !lamp || Math.hypot(x - lamp.x, z - lamp.z) >= radius + lamp.r + 3
  const nodeInfo = (cx: number, cz: number, attract?: string[]): { d: number; node: PlacementInput['nodes'][number] | null } => {
    let best = Infinity
    let bestNode: PlacementInput['nodes'][number] | null = null
    for (const n of input.nodes) {
      if (attract && attract.length > 0 && !attract.includes(n.type)) continue
      const nx = Math.max(n.rect.x, Math.min(cx, n.rect.x + n.rect.w))
      const nz = Math.max(n.rect.y, Math.min(cz, n.rect.y + n.rect.h))
      const d = Math.hypot(cx - nx, cz - nz)
      if (d < best) {
        best = d
        bestNode = n
      }
    }
    return { d: best, node: bestNode }
  }

  /** Affinity score 0..1 for a cell center. */
  const score = (a: PropArchetype, cx: number, cz: number): number => {
    const edgeD = Math.min(cx - x0, cz - z0, x0 + w - cx, z0 + h - cz)
    if ((a.zone ?? 'board') === 'desk') {
      // desk props live in the annulus OUTSIDE the slab: [10, deskBand] px
      // past the edge, thinning toward the outer rim — weighted toward the
      // sectors the DEFAULT framing actually shows (see the desk
      // visible-sector bias block above)
      const dOut = -edgeD
      const band = deskBand
      if (dOut < 10 || dOut > band) return 0
      const ox = cx < x0 ? -1 : cx > x0 + w ? 1 : 0
      const oz = cz < z0 ? -1 : cz > z0 + h ? 1 : 0
      const tx = Math.min(1, Math.max(0, (cx - x0) / w))
      const tz = Math.min(1, Math.max(0, (cz - z0) / h))
      const radial = dOut <= band * 0.7 ? 1 : 0.5
      return radial * deskSectorMul(ox, oz, tx, tz)
    }
    if (edgeD < 0) return 0 // board archetypes never leave the slab
    switch (a.affinity) {
      case 'near-node': {
        const { d } = nodeInfo(cx, cz, a.attractTypes)
        if (!Number.isFinite(d)) return 0
        // people stand AT the card wall (in the generic ring they are
        // invisible at hero framing next to the cards), but
        // never on a cable ribbon or its plug corridor — the wall band is
        // exactly where the plugs live
        if (isPerson(a)) {
          if (d < PERSON_ADJ_MIN || d > PERSON_ADJ_MAX) return 0
          if (connDist(cx, cz) < CABLE_CLEAR) return 0
          return 1 - Math.abs(d - 26) / 60
        }
        return d >= 16 && d <= 70 ? 1 - Math.abs(d - 36) / 60 : 0
      }
      case 'near-connection': {
        const d = connDist(cx, cz)
        if (!Number.isFinite(d)) return 0
        return d >= 10 && d <= 34 ? 1 : 0
      }
      case 'edge':
        return edgeD < 44 ? 1 : 0
      case 'corner': {
        const cornerD = Math.min(
          Math.hypot(cx - x0, cz - z0),
          Math.hypot(cx - (x0 + w), cz - z0),
          Math.hypot(cx - x0, cz - (z0 + h)),
          Math.hypot(cx - (x0 + w), cz - (z0 + h)),
        )
        return cornerD < 90 ? 1 : 0
      }
      case 'open': {
        if (edgeD <= 30) return 0
        if (isPerson(a)) {
          // open people prefer the cable SHOULDERS over blank paper (lone
          // figures read as orphan pins) — and never stand on the ribbon/plugs
          const d = connDist(cx, cz)
          if (d < CABLE_CLEAR * 0.8) return 0
          return d <= PERSON_CLUSTER_R ? 0.7 : 0.25
        }
        // 0.5: the open band feeds the FOREGROUND half of the default
        // framing — at 0.35 it starves to ~1-2 props per board and the near
        // half of the paper reads empty
        return 0.5
      }
    }
  }

  // ── per-cell hashing (the stability core) ──
  const candidates: (PlacedProp & { h: number; footprint: number; openPerson: boolean; connNear: boolean })[] = []
  for (const a of input.archetypes) {
    const aHash = hashStr(a.id)
    // calibrate acceptance so E[count] ≈ baseCount·density·√area over the
    // cells this archetype's affinity band actually covers — approximated by
    // a fixed fraction of the grid per affinity kind (exact coverage varies
    // per diagram; the caps keep outliers sane). Person bands are TIGHTER
    // than the generic ones (near-node [14,45] vs [16,70]; open people
    // effectively live on the cable shoulders, not the whole open field) →
    // smaller fractions, else the tighter bands would starve the crowd —
    // same dilution the attractShare correction fixes for typed racks.
    const bandFraction =
      a.affinity === 'open' ? (isPerson(a) ? 0.2 : 0.5)
      : a.affinity === 'edge' ? 0.18
      : a.affinity === 'corner' ? 0.06
      : a.affinity === 'near-node' && isPerson(a) ? 0.09
      : 0.15
    // near-node + attractTypes: the band only rings the MATCHING nodes, so
    // the grid-fraction estimate must shrink by their share — otherwise a
    // one-store-in-five diagram dilutes acceptance ~5x and the pack's
    // identity prop (server-rack) starves
    const attractShare =
      a.affinity === 'near-node' && a.attractTypes && a.attractTypes.length > 0
        ? Math.max(
            1 / Math.max(1, input.nodes.length),
            input.nodes.filter((n) => a.attractTypes!.includes(n.type)).length / Math.max(1, input.nodes.length),
          )
        : 1
    const deskZone = (a.zone ?? 'board') === 'desk'
    const band = deskBand
    if (deskZone && band <= 0) continue
    // the city keeps only the desk props that HAVE a maquette scale
    if (deskZone && city && a.cityScale === undefined) continue
    const worldScale = deskZone && city ? (a.cityScale ?? 1) : 1
    // desk: annulus cell count × 0.8 (radial 1/0.5 scoring) × the sector-mean
    // (visible-sector bias redistributes, so mean score per cell shrank)
    const cellsInBand = deskZone
      ? Math.max(1, (((w + 2 * band) * (h + 2 * band) - w * h) / (DECOR_CELL * DECOR_CELL)) * 0.8 * DESK_SECTOR_MEAN)
      : Math.max(1, cols * rows * bandFraction * attractShare)
    const target = a.baseCount * densityMul * areaMul * a.weight
    const p = Math.min(0.9, target / cellsInBand)
    // desk archetypes iterate an EXTENDED grid over the annulus; board cells
    // keep their exact 0-based indices, so board propIds stay stable
    const ext = deskZone ? Math.ceil((band + 10) / DECOR_CELL) : 0
    for (let ix = -ext; ix < cols + ext; ix++) {
      for (let iz = -ext; iz < rows + ext; iz++) {
        const cx = x0 + (ix + 0.5) * DECOR_CELL
        const cz = z0 + (iz + 0.5) * DECOR_CELL
        const s = score(a, cx, cz)
        if (s <= 0) continue
        // the hash draw first: it is the cheap filter, and the order of two
        // independent rejections does not change which cells survive
        const hCell = mix(input.seed, aHash, ix, iz)
        if (hCell / 0xffffffff >= p * s) continue
        if (blocked(cx, cz)) continue
        // the smallest footprint this archetype can have must already fit
        if (a.clearance !== undefined && !keepsClear(a, cx, cz, a.footprint * a.scaleJitter[0] - DECOR_CELL)) continue
        // further bits drive jitter / rotation / scale — same hash, so a
        // surviving cell keeps its exact pose across unrelated edits
        const hJit = mix(hCell, aHash, iz, ix)
        let jx = (((hJit & 0xff) / 255) - 0.5) * (DECOR_CELL - a.footprint)
        let jz = ((((hJit >>> 8) & 0xff) / 255) - 0.5) * (DECOR_CELL - a.footprint)
        const scale = (a.scaleJitter[0] + (((hJit >>> 16) & 0xff) / 255) * (a.scaleJitter[1] - a.scaleJitter[0])) * worldScale
        if (deskZone && city) {
          const s = cityApronSnap(cx, cz, jx, jz)
          jx = s.x - cx
          jz = s.z - cz
          const r = a.footprint * scale
          if (!cityApronHolds(cx + jx, cz + jz, r)) continue
          // the avoided boxes bind the WHOLE footprint here (a host can hand
          // the city's lots in, and nothing city-side may be covered)
          if ((input.avoid ?? []).some((b) => rectGap(b, cx + jx, cz + jz) < r)) continue
        }
        // the jittered FINAL point must clear the blockers too — a cell whose
        // center is legal can still jitter into a card's label margin
        if (blocked(cx + jx, cz + jz)) continue
        if (a.clearance !== undefined && !keepsClear(a, cx + jx, cz + jz, a.footprint * scale)) continue
        if (deskZone && !offLamp(cx + jx, cz + jz, a.footprint * scale)) continue
        let rotY: number
        if (a.rotation === 'grid') rotY = (((hJit >>> 24) & 0x3) * Math.PI) / 2
        // face-camera-3q draws the random-y bits here; the final pass of
        // placeDecor turns it once the view is known
        else if (a.rotation === 'random-y' || a.rotation === 'face-camera-3q') rotY = (((hJit >>> 24) & 0xff) / 255) * Math.PI * 2
        else {
          const { node } = nodeInfo(cx, cz, a.attractTypes)
          rotY = node
            ? Math.atan2(node.rect.x + node.rect.w / 2 - cx, node.rect.y + node.rect.h / 2 - cz)
            : (((hJit >>> 24) & 0xff) / 255) * Math.PI * 2
        }
        const openPerson = !deskZone && a.affinity === 'open' && isPerson(a)
        candidates.push({
          propId: `${a.id}:${ix}:${iz}`,
          archetypeId: a.id,
          x: cx + jx,
          z: cz + jz,
          rotY,
          scale,
          onPlatform: !deskZone && onPlatformAt(cx + jx, cz + jz),
          onDesk: deskZone,
          h: hCell,
          footprint: a.footprint * scale,
          openPerson,
          connNear: openPerson && connDist(cx + jx, cz + jz) <= PERSON_CLUSTER_R,
        })
      }
    }
  }

  // ── deterministic greedy collision pass + caps ──
  // Order by (hash, propId): stable under edits — a surviving prop never
  // loses its slot to a NEW neighbour unless the new cell hashes lower.
  // FAR-BAND pieces (loop 4 r3) are drawn AFTER every other candidate: in a
  // purely hash-ordered pass the pencil cup and the books took cells the
  // older props had held, which moved the desk flag on the live board
  // (loop4-r3-assets-a: its foot under the STYLE 3D pill). Last, they can
  // only take what nothing else wanted.
  // WORK-ZONE pieces (quality pass "layout") come after even the far band:
  // with a view they are all lifted and re-laid in their zones, so no older
  // prop may have been steered around a cell they are about to leave.
  const archById = new Map(input.archetypes.map((a) => [a.id, a]))
  const farLast = (c: { archetypeId: string }) => {
    const a = archById.get(c.archetypeId)
    return a?.workZone ? 2 : a?.farBand ? 1 : 0
  }
  /** The desk-vs-desk spacing bound (see the greedy pass): the strict
   * no-overlap sum, plus WILDLIFE_GAP when either is an animal. Board pairs
   * keep the relaxed 0.6. */
  const wildIds = new Set(input.archetypes.filter((a) => isWildlife(a)).map((a) => a.id))
  const spacing = (aId: string, aFoot: number, aDesk: boolean, b: PlacedProp & { footprint: number }): number => {
    if (!(aDesk && b.onDesk)) return (aFoot + b.footprint) * 0.6
    return aFoot + b.footprint + (wildIds.has(aId) || wildIds.has(b.archetypeId) ? WILDLIFE_GAP : 0)
  }
  candidates.sort((a, b) => farLast(a) - farLast(b) || a.h - b.h || (a.propId < b.propId ? -1 : 1))
  /** Per-archetype ceiling: the global draw-sanity cap, tightened by the
   * archetype's own hard per-scene cap (density scaling can push a unique
   * landmark's expected count past 1). */
  const capOf = (a: PropArchetype | undefined): number => Math.min(MAX_PER_ARCHETYPE, a?.maxCount ?? Infinity)
  const personIds = new Set(input.archetypes.filter((a) => isPerson(a)).map((a) => a.id))
  // free-floating 'open' people cap (orphan pins): a loner is an
  // open person with no cable AND no already-placed person within
  // PERSON_CLUSTER_R — later candidates near a placed loner count as
  // clustered, so isolated PAIRS (a vignette) cost one slot, not two
  const openPersonFreeCap = input.density === 'rich' ? 4 : 2
  let openPersonFree = 0
  const placed: (PlacedProp & { footprint: number })[] = []
  const perArchetype = new Map<string, number>()
  for (const c of candidates) {
    if (placed.length >= MAX_TOTAL) break
    const n = perArchetype.get(c.archetypeId) ?? 0
    if (n >= capOf(archById.get(c.archetypeId))) continue
    let collides = false
    for (const p of placed) {
      // Desk props are BIG real-world objects at hero framing — any visual
      // interpenetration reads as a physics-failed pile, so desk-vs-desk pairs get the STRICT
      // no-bbox-overlap bound (footprint = rotation-safe half-extent; one
      // axis must clear the full footprint sum). Board garnish keeps the
      // softer 0.6 factor: small props whose meshes undershoot their
      // footprint circle, and the relaxation is what lets clusters read
      // organic instead of gridded. An animal keeps WILDLIFE_GAP more.
      const minD = spacing(c.archetypeId, c.footprint, c.onDesk, p)
      if (Math.abs(c.x - p.x) < minD && Math.abs(c.z - p.z) < minD) {
        collides = true
        break
      }
    }
    if (collides) continue
    if (c.openPerson && !c.connNear) {
      const paired = placed.some((p) => personIds.has(p.archetypeId) && Math.hypot(c.x - p.x, c.z - p.z) <= PERSON_CLUSTER_R)
      if (!paired) {
        if (openPersonFree >= openPersonFreeCap) continue
        openPersonFree++
      }
    }
    placed.push({ propId: c.propId, archetypeId: c.archetypeId, x: c.x, z: c.z, rotY: c.rotY, scale: c.scale, onPlatform: c.onPlatform, onDesk: c.onDesk, footprint: c.footprint })
    perArchetype.set(c.archetypeId, n + 1)
  }

  // ── per-node person adjacency guarantee ──
  // At hero framing the figures ARE the scale cue, so at normal+ density
  // every card (the first 6 — a hero framing shows at most ~6) must have at
  // least one face-rotation person standing in its wall band AND facing it.
  // When the organic hash draw leaves a card bare, promote the best-hashed
  // legal person cell in the band — same mix/jitter/propId recipe as the
  // organic pass, so promotions are deterministic for a given seed and stay
  // stable under unrelated edits. Cells riding a cable corridor
  // (connDist < CABLE_CLEAR — the ribbon + plug zones) stay excluded, like
  // the near-connection affinity's inner edge always has.
  if (input.density !== 'sparse') {
    const facePersons = input.archetypes.filter(
      (a) => isPerson(a) && (a.zone ?? 'board') !== 'desk' && a.rotation === 'face-nearest-node',
    )
    const rectDistTo = (r: Rect, px: number, pz: number): number => {
      const nx = Math.max(r.x, Math.min(px, r.x + r.w))
      const nz = Math.max(r.y, Math.min(pz, r.y + r.h))
      return Math.hypot(px - nx, pz - nz)
    }
    const angleDiff = (p: number, q: number): number =>
      Math.abs(((((p - q) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
    for (const node of facePersons.length > 0 ? input.nodes.slice(0, 6) : []) {
      if (placed.length >= MAX_TOTAL) break
      const ncx = node.rect.x + node.rect.w / 2
      const ncz = node.rect.y + node.rect.h / 2
      const attended = placed.some((p) => {
        if (p.onDesk) return false
        const a = archById.get(p.archetypeId)
        if (!a || !isPerson(a) || a.rotation !== 'face-nearest-node') return false
        const d = rectDistTo(node.rect, p.x, p.z)
        if (d < PERSON_ADJ_MIN - 0.01 || d > PERSON_ADJ_MAX) return false
        return angleDiff(Math.atan2(ncx - p.x, ncz - p.z), p.rotY) <= Math.PI / 3
      })
      if (attended) continue
      const ixA = Math.max(0, Math.floor((node.rect.x - PERSON_ADJ_MAX - x0) / DECOR_CELL))
      const ixB = Math.min(cols - 1, Math.floor((node.rect.x + node.rect.w + PERSON_ADJ_MAX - x0) / DECOR_CELL))
      const izA = Math.max(0, Math.floor((node.rect.y - PERSON_ADJ_MAX - z0) / DECOR_CELL))
      const izB = Math.min(rows - 1, Math.floor((node.rect.y + node.rect.h + PERSON_ADJ_MAX - z0) / DECOR_CELL))
      let best: (PlacedProp & { footprint: number; h: number }) | null = null
      for (const a of facePersons) {
        // the promotion respects the hard per-scene cap too
        if ((perArchetype.get(a.id) ?? 0) >= capOf(a)) continue
        const aHash = hashStr(a.id)
        for (let ix = ixA; ix <= ixB; ix++) {
          for (let iz = izA; iz <= izB; iz++) {
            const cx = x0 + (ix + 0.5) * DECOR_CELL
            const cz = z0 + (iz + 0.5) * DECOR_CELL
            const d = rectDistTo(node.rect, cx, cz)
            if (d < PERSON_ADJ_MIN || d > PERSON_ADJ_MAX) continue
            if (blocked(cx, cz) || connDist(cx, cz) < CABLE_CLEAR) continue
            const hCell = mix(input.seed, aHash, ix, iz)
            const propId = `${a.id}:${ix}:${iz}`
            if (best && (best.h < hCell || (best.h === hCell && best.propId < propId))) continue
            const hJit = mix(hCell, aHash, iz, ix)
            const jx = (((hJit & 0xff) / 255) - 0.5) * (DECOR_CELL - a.footprint)
            const jz = ((((hJit >>> 8) & 0xff) / 255) - 0.5) * (DECOR_CELL - a.footprint)
            const fx = cx + jx
            const fz = cz + jz
            const fd = rectDistTo(node.rect, fx, fz)
            if (fd < PERSON_ADJ_MIN - 0.01 || fd > PERSON_ADJ_MAX) continue
            if (blocked(fx, fz) || connDist(fx, fz) < CABLE_CLEAR) continue
            const scale = a.scaleJitter[0] + (((hJit >>> 16) & 0xff) / 255) * (a.scaleJitter[1] - a.scaleJitter[0])
            const footprint = a.footprint * scale
            let collides = false
            for (const p of placed) {
              const minD = (footprint + p.footprint) * 0.6
              if (Math.abs(fx - p.x) < minD && Math.abs(fz - p.z) < minD) {
                collides = true
                break
              }
            }
            if (collides) continue
            best = {
              propId,
              archetypeId: a.id,
              x: fx,
              z: fz,
              // face THE bare card (organic props face their nearest node)
              rotY: Math.atan2(ncx - cx, ncz - cz),
              scale,
              onPlatform: onPlatformAt(fx, fz),
              onDesk: false,
              footprint,
              h: hCell,
            }
          }
        }
      }
      if (best) {
        const { h: _h, ...prop } = best
        placed.push(prop)
        perArchetype.set(best.archetypeId, (perArchetype.get(best.archetypeId) ?? 0) + 1)
      }
    }
  }

  // ── desk showcase guarantee ──
  // The visible-sector bias makes the default frame's dressed top-left
  // LIKELY to carry the pack's showcase piece, not certain — single-instance
  // archetypes still hash into the far floors roughly one run in ten. At
  // normal+ density, when the desk exists, the LARGEST-footprint desk
  // archetype (canadiana's moose, the shared set's pencil) is guaranteed one
  // instance inside the showcase window: the W band's inner ring,
  // upper-middle stretch. That window is deliberately NARROWER than the
  // favoured sectors: the N band beheads tall props against the frame top /
  // toolbar, the W band's
  // top end grazes it too, and past the band's midpoint the left crop eats
  // the prop — the W mid-north inner ring is the one slice where a TALL
  // showcase piece reads whole at the default framing. Same
  // hash/jitter/propId recipe as the organic pass, so the promotion is
  // deterministic per seed and stable under unrelated edits — the desk twin
  // of the per-node person adjacency guarantee above.
  //
  // VIEW3D QUALITY LOOP 3 r2 — THE WINDOW IS MEASURED, NOT ASSUMED. The W
  // band was tuned with both side panels closed; with the app's default
  // chrome the left panel and the floating tool rail cover exactly that
  // slice, and the desk flag stood there invisible in workbench-wide.png.
  // Two defects, both fixed here:
  //  • when the host passes `view` (the default framing's camera + the
  //    unobstructed canvas rect), a cell qualifies only if the prop's whole
  //    projected box (base disc to top) lies inside the safe rect — the same
  //    projection test the quality loop's `fit` gate runs on the cards — and
  //    the FOREGROUND wins (largest projected size, i.e. the S/E bands at
  //    the iso azimuth, where the flag's sheet faces the camera), the seed
  //    choosing among the near-largest cells;
  //  • a CAPPED showcase (the flag's maxCount is 1) whose organic instance
  //    landed out of frame used to keep it there — the promotion bailed at
  //    the cap. It now MOVES: the out-of-frame instance is dropped once a
  //    legal in-frame cell is found, so the count never exceeds the cap.
  const deskBandW = deskBand
  if (input.density !== 'sparse' && deskBandW > 0) {
    // With a view the FAR-BAND pass (below) places those pieces itself, and
    // the ZONE passes every work-zone piece, so their organic instances leave
    // the desk BEFORE the showcase and the near band choose: neither can be
    // steered by a piece about to move.
    const zoned = input.view !== undefined && !city
    if (zoned) {
      for (let i = placed.length - 1; i >= 0; i--) {
        const a = archById.get(placed[i].archetypeId)
        if (!a?.farBand && !a?.workZone) continue
        perArchetype.set(a.id, (perArchetype.get(a.id) ?? 1) - 1)
        placed.splice(i, 1)
      }
    }
    // Without a view nothing re-lays the zone pieces, but they still leave
    // before the showcase chooses — a piece drawn last must never be what
    // steers it (loop 4 r4's rule for its gap fillers) — and come back
    // afterwards wherever they still fit.
    const liftedZone: (PlacedProp & { footprint: number })[] = []
    if (!zoned) {
      for (let i = placed.length - 1; i >= 0; i--) {
        const a = archById.get(placed[i].archetypeId)
        if (!a?.workZone) continue
        perArchetype.set(a.id, (perArchetype.get(a.id) ?? 1) - 1)
        liftedZone.unshift(placed[i])
        placed.splice(i, 1)
      }
    }
    // a zone piece is never the showcase (the flag keeps the pick —
    // build.test.ts): the sketchbook and the blueprint are broad but flat
    const showcase = input.archetypes
      .filter((a) => (a.zone ?? 'board') === 'desk' && !a.workZone && (!city || a.cityScale !== undefined))
      .sort((a, b) => b.footprint - a.footprint || (a.id < b.id ? -1 : 1))[0]
    const showcaseWorldScale = city ? (showcase?.cityScale ?? 1) : 1
    const view = input.view
    /** The prop's projected screen box at (x, z) — its bounding cylinder
     * (footprint radius, `height` tall) sampled at 8 bearings, base and top —
     * or null when any sample is behind the camera. */
    const projectedBox = (x: number, z: number, scale: number, arch: PropArchetype | undefined = showcase): Rect | null => {
      if (!view || !arch) return null
      const m = view.viewProj
      const r = arch.footprint * scale
      const top = view.deskY + (arch.height ?? 2 * arch.footprint) * scale
      let bx0 = Infinity
      let by0 = Infinity
      let bx1 = -Infinity
      let by1 = -Infinity
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4
        const px = x + r * Math.cos(a)
        const pz = z + r * Math.sin(a)
        for (const py of [view.deskY, top]) {
          const cw = m[3] * px + m[7] * py + m[11] * pz + m[15]
          if (cw <= 1e-6) return null
          const sx = ((((m[0] * px + m[4] * py + m[8] * pz + m[12]) / cw) + 1) / 2) * view.viewport.width
          const sy = ((1 - (m[1] * px + m[5] * py + m[9] * pz + m[13]) / cw) / 2) * view.viewport.height
          bx0 = Math.min(bx0, sx)
          bx1 = Math.max(bx1, sx)
          by0 = Math.min(by0, sy)
          by1 = Math.max(by1, sy)
        }
      }
      return { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 }
    }
    /** Inside the safe rect with a few px to spare. */
    const SAFE_MARGIN = 6
    const framed = (b: Rect | null): b is Rect =>
      b !== null &&
      view !== undefined &&
      b.x >= view.safe.x + SAFE_MARGIN &&
      b.y >= view.safe.y + SAFE_MARGIN &&
      b.x + b.w <= view.safe.x + view.safe.w - SAFE_MARGIN &&
      b.y + b.h <= view.safe.y + view.safe.h - SAFE_MARGIN
    /** The diagram on screen, for `clearOfBoard` pieces (built on first use):
     * each card's box from the paper (y 0, the slab top) to BOARD_SCREEN_LIFT
     * over it, each label plate's box on the paper, and the cables sampled
     * every ~10 units along their polylines. */
    let diagram: { boxes: Rect[]; cable: { x: number; y: number }[] } | null = null
    const overDiagram = (b: Rect): boolean => {
      if (!view) return false
      if (!diagram) {
        const m = view.viewProj
        const toScreen = (px: number, py: number, pz: number): { x: number; y: number } | null => {
          const cw = m[3] * px + m[7] * py + m[11] * pz + m[15]
          if (cw <= 1e-6) return null
          return {
            x: ((((m[0] * px + m[4] * py + m[8] * pz + m[12]) / cw) + 1) / 2) * view.viewport.width,
            y: ((1 - (m[1] * px + m[5] * py + m[9] * pz + m[13]) / cw) / 2) * view.viewport.height,
          }
        }
        const boxOf = (r: Rect, lift: number): Rect | null => {
          let bx0 = Infinity
          let by0 = Infinity
          let bx1 = -Infinity
          let by1 = -Infinity
          for (const px of [r.x, r.x + r.w]) {
            for (const pz of [r.y, r.y + r.h]) {
              for (const py of lift > 0 ? [0, lift] : [0]) {
                const s = toScreen(px, py, pz)
                if (!s) return null
                bx0 = Math.min(bx0, s.x)
                by0 = Math.min(by0, s.y)
                bx1 = Math.max(bx1, s.x)
                by1 = Math.max(by1, s.y)
              }
            }
          }
          return { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 }
        }
        const boxes: Rect[] = []
        for (const n of input.nodes) {
          // the card's drawn body reaches 7 px past its 2D rect (the fit
          // boxes' margin, placement.test's diagramOnScreen): grown by 8, or
          // a tower foot a few px off the rect still rose over the plinth
          // (seed 100199 once the greenery took the lamp's side first)
          const r = n.rect
          const bb = boxOf({ x: r.x - 8, y: r.y - 8, w: r.w + 16, h: r.h + 16 }, BOARD_SCREEN_LIFT)
          if (bb) boxes.push(bb)
        }
        for (const r of input.avoid ?? []) {
          const bb = boxOf(r, 0)
          if (bb) boxes.push(bb)
        }
        const cable: { x: number; y: number }[] = []
        for (let s = 0; s < segs.length; s += 4) {
          const len = Math.hypot(segs[s + 2] - segs[s], segs[s + 3] - segs[s + 1])
          const steps = Math.max(1, Math.ceil(len / 10))
          for (let k = 0; k <= steps; k++) {
            const t = k / steps
            const p = toScreen(segs[s] + (segs[s + 2] - segs[s]) * t, 0, segs[s + 1] + (segs[s + 3] - segs[s + 1]) * t)
            if (p) cable.push(p)
          }
        }
        diagram = { boxes, cable }
      }
      if (diagram.boxes.some((d) => d.x < b.x + b.w && d.x + d.w > b.x && d.y < b.y + b.h && d.y + d.h > b.y)) return true
      return diagram.cable.some((q) => q.x > b.x && q.x < b.x + b.w && q.y > b.y && q.y < b.y + b.h)
    }
    // Two window tiers, projection-scanned on the probe geometry:
    //  • primary  — tz ∈ [.32, .38]: above the floating canvas toolbar
    //    (which parks over the W band at screen ~340-390 × 225-505), below
    //    the top toolbar so a tall prop's head stays whole;
    //  • fallback — tz ∈ [.25, .46]: walked only when NO primary cell is
    //    legal — a partially occluded showcase beats none. Only the WINDOW
    //    ever relaxes (occlusion risk); the spacing rule NEVER does (a
    //    relaxed check lets the promoted piece interpenetrate a pile). If the
    //    fallback tier has no legal cell either, nothing is placed: a
    //    missing showcase beats a broken one.
    const inWindow = (cx: number, cz: number, lo: number, hi: number): boolean => {
      const ox = cx < x0 ? -1 : cx > x0 + w ? 1 : 0
      const oz = cz < z0 ? -1 : cz > z0 + h ? 1 : 0
      if (ox !== -1 || oz !== 0) return false // W band only
      if (x0 - cx > Math.min(50, deskBandW)) return false // inner ring
      const tz = (cz - z0) / h
      return tz >= lo && tz <= hi
    }
    // legacy: an instance in the window satisfies the guarantee. View mode
    // decides AFTER the scan (below): an instance satisfies it only if it is
    // framed AND in the foreground tier — a flag framed but far (the city's
    // north apron, a 17-px speck in loop3-r2-fix-b/city-wide.png) moves.
    const satisfied =
      !view &&
      showcase !== undefined &&
      placed.some((p) => p.onDesk && p.archetypeId === showcase.id && inWindow(p.x, p.z, 0.32, 0.38))
    const count = showcase ? (perArchetype.get(showcase.id) ?? 0) : 0
    const atCap = showcase !== undefined && count >= capOf(showcase)
    // the instance a capped showcase gives up when it moves: its LAST placed
    const movable = atCap ? placed.map((p) => p.archetypeId).lastIndexOf(showcase!.id) : -1
    if (showcase && !satisfied && (atCap ? movable >= 0 : placed.length < MAX_TOTAL)) {
      const aHash = hashStr(showcase.id)
      const ext = Math.ceil((deskBandW + 10) / DECOR_CELL)
      const others = movable >= 0 ? placed.filter((_, i) => i !== movable) : placed
      let best: (PlacedProp & { footprint: number; h: number }) | null = null
      /** view mode: every framed cell with its projected height; the pick
       * happens after the scan (foreground first, then the seed). */
      const framedCells: { cand: PlacedProp & { footprint: number; h: number }; px: number }[] = []
      const tiers: readonly (readonly [number, number])[] = view ? [[0, 1]] : [[0.32, 0.38], [0.25, 0.46]]
      for (const [lo, hi] of tiers) {
        if (best) break // primary tier found a legal cell — no fallback
        for (let ix = -ext; ix < cols + ext; ix++) {
          for (let iz = -ext; iz < rows + ext; iz++) {
            const cx = x0 + (ix + 0.5) * DECOR_CELL
            const cz = z0 + (iz + 0.5) * DECOR_CELL
            if (!view && !inWindow(cx, cz, lo, hi)) continue
            if (score(showcase, cx, cz) <= 0 || blocked(cx, cz)) continue
            const hCell = mix(input.seed, aHash, ix, iz)
            const propId = `${showcase.id}:${ix}:${iz}`
            if (!view && best && (best.h < hCell || (best.h === hCell && best.propId < propId))) continue
            const hJit = mix(hCell, aHash, iz, ix)
            const jx = (((hJit & 0xff) / 255) - 0.5) * (DECOR_CELL - showcase.footprint)
            const jz = ((((hJit >>> 8) & 0xff) / 255) - 0.5) * (DECOR_CELL - showcase.footprint)
            const snapped = city ? cityApronSnap(cx, cz, jx, jz) : { x: cx + jx, z: cz + jz }
            const fx = snapped.x
            const fz = snapped.z
            if (blocked(fx, fz)) continue
            const scale =
              (showcase.scaleJitter[0] + (((hJit >>> 16) & 0xff) / 255) * (showcase.scaleJitter[1] - showcase.scaleJitter[0])) *
              showcaseWorldScale
            const footprint = showcase.footprint * scale
            if (city) {
              if (!cityApronHolds(fx, fz, footprint)) continue
              if ((input.avoid ?? []).some((b) => rectGap(b, fx, fz) < footprint)) continue
            }
            if (!offLamp(fx, fz, footprint)) continue
            let collides = false
            for (const p of others) {
              // NEVER relaxed (critique #7): the promoted piece is a desk
              // prop, so against every already-placed desk prop the strict
              // no-bbox-overlap bound applies — the fallback tier above
              // relaxes the window, not the spacing
              const minD = spacing(showcase.id, footprint, true, p)
              if (Math.abs(fx - p.x) < minD && Math.abs(fz - p.z) < minD) {
                collides = true
                break
              }
            }
            if (collides) continue
            const box = view ? projectedBox(fx, fz, scale) : null
            if (view && !framed(box)) continue
            const cand: PlacedProp & { footprint: number; h: number } = {
              propId,
              archetypeId: showcase.id,
              x: fx,
              z: fz,
              // same pose bits as the organic pass (desk sets are random-y/grid)
              rotY:
                showcase.rotation === 'grid'
                  ? (((hJit >>> 24) & 0x3) * Math.PI) / 2
                  : (((hJit >>> 24) & 0xff) / 255) * Math.PI * 2,
              scale,
              onPlatform: false,
              onDesk: true,
              footprint,
              h: hCell,
            }
            if (view) framedCells.push({ cand, px: box!.h })
            else best = cand
          }
        }
      }
      if (view && framedCells.length > 0) {
        // the foreground: within 80 % of the largest projected height the
        // frame allows, then the lowest hash — varied per seed, never small
        const tallest = Math.max(...framedCells.map((c) => c.px))
        const foreground = (px: number) => px >= tallest * 0.8
        const kept = placed.some((p) => {
          if (!p.onDesk || p.archetypeId !== showcase.id) return false
          const b = projectedBox(p.x, p.z, p.scale)
          return framed(b) && foreground(b.h)
        })
        for (const { cand, px } of kept ? [] : framedCells) {
          if (!foreground(px)) continue
          if (best && (best.h < cand.h || (best.h === cand.h && best.propId < cand.propId))) continue
          best = cand
        }
      }
      if (best) {
        const { h: _h, ...prop } = best
        if (movable >= 0) placed.splice(movable, 1) // MOVE, never mint past the cap
        else perArchetype.set(best.archetypeId, (perArchetype.get(best.archetypeId) ?? 0) + 1)
        placed.push(prop)
      }
    }

    // ── the FRAMED desk passes (view3d quality loop 4 → quality pass "layout") ──
    // Loop 4 laid the desk in BANDS: the foreground COMPANION (the mug) as far
    // across the frame from the showcase as the near desk allows ("the whole
    // lower third is bare desk"); the NEAR-BAND set pieces in the lower half
    // of the frame, each away from the foreground pieces already there (r2:
    // "the beaver is a 20-px speck on the far edge"); the FAR-BAND pieces
    // beyond the board (r3: "the whole far desk band is bare"); and r4's GAP
    // pass laid two broad flat fillers wherever the frame was still bare.
    //
    // QUALITY PASS "layout" (tp-final-dpr1/workbench-wide.png): "props sit
    // evenly spaced around the board perimeter like a border, the left
    // foreground desk is empty while the right edge stacks moose, blueprint,
    // mug and pencil". Every one of those passes spread its pieces APART, so
    // the desk read as a ring of unrelated objects — and the 150-unit desk
    // band could not reach the frame's near corners at all (ZONE_REACH). On
    // the workbench the desk is now arranged in WORK ZONES, in this order:
    //  1. the companion (the mug) opens the COFFEE corner, by the loop-4 rule;
    //  2. the REFERENCE lead (the sketchbook) opens the other near corner: in
    //     the near band, as far on screen from the coffee corner as it allows;
    //  3. each near zone's members gather beside their lead, the broadest
    //     first — within ZONE_GAP_MIN..MAX of a zone mate (relaxed twice),
    //     nearest the lead first, never hidden behind a taller mate, never on
    //     the box of a piece outside the zone (the flag, the other zone);
    //  4. the near band (the moose, the beaver), ZONE_HALO off the zones:
    //     each animal's whole projected box keeps off every framed desk
    //     piece's — tp-final's "moose stands on the rolled blueprint" was a
    //     12-unit WORLD gap the screen closed;
    //  5. the far band (the CN tower; the plant, which leads the GREENERY zone
    //     beside the lamp), then the greenery members.
    // The city keeps the loop-4 bands for the pieces it has (the moose, the
    // beaver); nothing here runs without a view.
    const COMPANION_NEAR = 0.75
    const COMPANION_SPREAD = 0.85
    /** Near band: a piece's base below this share of the safe rect's height… */
    const NEAR_BAND_LOW = 0.5
    /** …and at least this share of its width from every foreground piece. */
    const NEAR_BAND_SEP = 0.12
    /** The deep near band a near piece prefers (its base below this share). */
    const NEAR_BAND_DEEP = 0.62
    /** Far band (loop 4 r3): a piece's foot ABOVE this share of the safe
     * rect's height — the desk the frame shows beyond the board's far edges. */
    const FAR_BAND_HIGH = 0.45
    /** The cheap frame pre-test's slack (css px): a cell whose centre projects
     * farther than this outside the safe rect cannot hold a framed piece once
     * jittered (a jitter is under DECOR_CELL / 2 = 10 units, ~10 px here). */
    const PRETEST_SLACK = 30
    const isDesk = (a: PropArchetype) => (a.zone ?? 'board') === 'desk'
    // the CITY runs the same bands on its apron for the pieces that HAVE a
    // maquette scale (the moose and the beaver — view3d quality pass
    // "wildlife": organically drawn, the city moose stood on the FAR apron,
    // a 6.5-px speck at (1049,300) in the probe's city-wide frame, the beaver
    // a 4.6-px one under the tool rail). Desk tools and the mug have no city
    // scale, so they never land there at all.
    const banded = (a: PropArchetype) => isDesk(a) && (!city || a.cityScale !== undefined)
    /** A banded piece's footprint `r` at (x, z) stands legally: on the
     * workbench wholly off the slab and clear of the diagram (keepsClear's
     * desk rule); in the city wholly on the bare apron (the organic pass's
     * own city test) and off every avoided box. */
    const standsClear = (a: PropArchetype, x: number, z: number, r: number): boolean =>
      city ? cityApronHolds(x, z, r) && !(input.avoid ?? []).some((b) => rectGap(b, x, z) < r) : keepsClear(a, x, z, r)
    type Cand = PlacedProp & { footprint: number; h: number }
    type Cell = { cand: Cand; box: Rect; base: number }
    const centre = (b: Rect) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
    /** Two screen boxes meet — or come within MEET_PAD px: projectedBox
     * samples 8 bearings, so a box can run a few px short of the silhouette
     * a 16-bearing measure finds (placement.test's) */
    const MEET_PAD = 4
    const meet = (a: Rect, b: Rect) =>
      a.x < b.x + b.w + MEET_PAD && b.x < a.x + a.w + MEET_PAD && a.y < b.y + b.h + MEET_PAD && b.y < a.y + a.h + MEET_PAD
    /** Share of `a`'s area that `b` covers. */
    const coverOf = (a: Rect, b: Rect) => {
      const ow = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const oh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      return ow > 0 && oh > 0 ? (ow * oh) / Math.max(1e-9, a.w * a.h) : 0
    }
    /** Every framed desk piece these passes laid, with its screen box. */
    const framedPieces: { p: PlacedProp & { footprint: number }; a: PropArchetype; box: Rect }[] = []
    const showcaseInst = view && showcase ? placed.find((p) => p.onDesk && p.archetypeId === showcase.id) : undefined
    const sBox = showcaseInst ? projectedBox(showcaseInst.x, showcaseInst.z, showcaseInst.scale) : null
    // the showcase is the first piece the next ones keep away from (framed or
    // not: loop 4's foreground list always held it)
    if (showcaseInst && showcase && sBox) framedPieces.push({ p: showcaseInst, a: showcase, box: sBox })
    /** Every legal, framed cell for `a`: the cell lattice over the desk out to
     * `reach` off the slab (the desk band's own score when null), the organic
     * pass's jitter and scale bits, its footprint clear of the lamp and — by
     * the strict desk bound (`spacing`) — of every prop in `others`, its whole
     * projected box inside the safe rect (and off the diagram for a
     * clearOfBoard piece). `offSlab`: the footprint also stands wholly off
     * the slab (standsClear). */
    const scanCells = (
      a: PropArchetype,
      reach: number | null,
      others: (PlacedProp & { footprint: number })[],
      offSlab: boolean,
      /** Optional cheap pre-filter on the cell centre (a zone member only
       * looks near its mates). */
      keep?: (cx: number, cz: number) => boolean,
    ): Cell[] => {
      if (!view) return []
      const m = view.viewProj
      const aHash = hashStr(a.id)
      const ext = Math.ceil(((reach ?? deskBandW) + 10) / DECOR_CELL)
      const worldScale = city ? (a.cityScale ?? 1) : 1
      const cells: Cell[] = []
      const sx0 = view.safe.x - PRETEST_SLACK
      const sy0 = view.safe.y - PRETEST_SLACK
      const sx1 = view.safe.x + view.safe.w + PRETEST_SLACK
      const sy1 = view.safe.y + view.safe.h + PRETEST_SLACK
      // every blocker (a card's 14-px margin, a label's 12-px skirt, a group
      // rim) lies inside the slab: 40 px out, none can reach
      const near = (x: number, z: number) => -Math.min(x - x0, z - z0, x0 + w - x, z0 + h - z) < 40
      for (let ix = -ext; ix < cols + ext; ix++) {
        for (let iz = -ext; iz < rows + ext; iz++) {
          const cx = x0 + (ix + 0.5) * DECOR_CELL
          const cz = z0 + (iz + 0.5) * DECOR_CELL
          if (reach === null) {
            if (score(a, cx, cz) <= 0) continue
          } else {
            const dOut = -Math.min(cx - x0, cz - z0, x0 + w - cx, z0 + h - cz)
            if (dOut < 10 || dOut > reach) continue
          }
          if (keep && !keep(cx, cz)) continue
          // cheap frame pre-test on the cell centre — most of a wide reach
          // lies off the frame, and the full test projects 16 points
          const cw = m[3] * cx + m[7] * view.deskY + m[11] * cz + m[15]
          if (cw <= 1e-6) continue
          const px = ((((m[0] * cx + m[4] * view.deskY + m[8] * cz + m[12]) / cw) + 1) / 2) * view.viewport.width
          const py = ((1 - (m[1] * cx + m[5] * view.deskY + m[9] * cz + m[13]) / cw) / 2) * view.viewport.height
          if (px < sx0 || px > sx1 || py < sy0 || py > sy1) continue
          if (near(cx, cz) && blocked(cx, cz)) continue
          const hCell = mix(input.seed, aHash, ix, iz)
          const hJit = mix(hCell, aHash, iz, ix)
          const jx = (((hJit & 0xff) / 255) - 0.5) * (DECOR_CELL - a.footprint)
          const jz = ((((hJit >>> 8) & 0xff) / 255) - 0.5) * (DECOR_CELL - a.footprint)
          // the city's apron is a centre line (the organic pass's snap)
          const snapped = city ? cityApronSnap(cx, cz, jx, jz) : { x: cx + jx, z: cz + jz }
          const fx = snapped.x
          const fz = snapped.z
          if (near(fx, fz) && blocked(fx, fz)) continue
          if (reach !== null && -Math.min(fx - x0, fz - z0, x0 + w - fx, z0 + h - fz) > reach) continue
          const scale = (a.scaleJitter[0] + (((hJit >>> 16) & 0xff) / 255) * (a.scaleJitter[1] - a.scaleJitter[0])) * worldScale
          const footprint = a.footprint * scale
          let collides = false
          for (const p of others) {
            const minD = spacing(a.id, footprint, true, p)
            if (Math.abs(fx - p.x) < minD && Math.abs(fz - p.z) < minD) {
              collides = true
              break
            }
          }
          if (collides || !offLamp(fx, fz, footprint)) continue
          if (offSlab && !standsClear(a, fx, fz, footprint)) continue
          const box = projectedBox(fx, fz, scale, a)
          if (!framed(box)) continue
          if (a.clearOfBoard && overDiagram(box)) continue
          cells.push({
            cand: {
              propId: `${a.id}:${ix}:${iz}`,
              archetypeId: a.id,
              x: fx,
              z: fz,
              rotY: a.rotation === 'grid' ? (((hJit >>> 24) & 0x3) * Math.PI) / 2 : (((hJit >>> 24) & 0xff) / 255) * Math.PI * 2,
              scale,
              onPlatform: false,
              onDesk: true,
              footprint,
              h: hCell,
            },
            box,
            base: box.y + box.h,
          })
        }
      }
      return cells
    }
    /** The lowest hash wins (propId breaks a tie) — the seed's choice. */
    const byHash = (a: Cand | null, b: Cand) => !a || b.h < a.h || (b.h === a.h && b.propId < a.propId)
    /** Lay `pick` for `a`: MOVE its organic instance when it has one (at its
     * cap, or a banded piece), else mint one under the caps. */
    const lay = (a: PropArchetype, pick: Cand | null, moveOrganic: boolean): boolean => {
      if (!pick) return false
      const n = perArchetype.get(a.id) ?? 0
      const atCap = n >= capOf(a)
      const movable = atCap || (moveOrganic && n > 0) ? placed.map((p) => p.archetypeId).lastIndexOf(a.id) : -1
      if (movable < 0 && (atCap || placed.length >= MAX_TOTAL)) return false
      const { h: _h, ...prop } = pick
      if (movable >= 0) placed.splice(movable, 1)
      else perArchetype.set(a.id, n + 1)
      placed.push(prop)
      return true
    }
    /** Record what now stands framed for `a` (moved, minted or kept). */
    const record = (a: PropArchetype) => {
      for (const p of placed) {
        if (!p.onDesk || p.archetypeId !== a.id || framedPieces.some((f) => f.p === p)) continue
        const b = projectedBox(p.x, p.z, p.scale, a)
        if (!framed(b)) continue
        framedPieces.push({ p, a, box: b })
      }
    }
    const pieces = (pred: (a: PropArchetype) => boolean) => input.archetypes.filter((a, i, all) => pred(a) && banded(a) && all.findIndex((b) => b.id === a.id) === i)

    // ── 1. the COMPANION — loop 4's rule, the coffee corner's lead ──
    // Two cuts failed live first: "the other half of the frame" put the mug a
    // few px across the mid line beside the flag (loop4-r1-assets), and a 0.6
    // band let the separation win at the far edge, by the CN tower
    // (loop4-r1-assets3) — both gated in placement.test.ts.
    const companion = view ? pieces((a) => a.companion === true)[0] : undefined
    if (view && companion) {
      const zone = zoned && companion.workZone !== undefined
      const others = placed.filter((p) => p.archetypeId !== companion.id)
      const awayX = sBox ? sBox.x + sBox.w / 2 : view.safe.x + view.safe.w / 2
      const sep = (b: Rect) => Math.abs(b.x + b.w / 2 - awayX)
      let cells = scanCells(companion, zone ? ZONE_REACH : null, others, city || companion.clearance !== undefined || zone).filter(
        (c) => !zone || !(sBox && meet(c.box, sBox)),
      )
      // a zone lead takes a CORNER when the frame has one free
      const corner = view.safe.y + view.safe.h * ZONE_CORNER_LOW
      if (zone && cells.some((c) => c.base >= corner)) cells = cells.filter((c) => c.base >= corner)
      if (cells.length > 0) {
        const tallest = Math.max(...cells.map((c) => c.box.h))
        const near = cells.filter((c) => c.box.h >= tallest * COMPANION_NEAR)
        const widest = Math.max(...near.map((c) => sep(c.box)))
        const qualifies = (b: Rect) => b.h >= tallest * COMPANION_NEAR && sep(b) >= widest * COMPANION_SPREAD
        const kept = placed.some((p) => {
          if (!p.onDesk || p.archetypeId !== companion.id) return false
          const b = projectedBox(p.x, p.z, p.scale, companion)
          return framed(b) && qualifies(b)
        })
        let pick: Cand | null = null
        for (const { cand, box } of kept ? [] : near) if (qualifies(box) && byHash(pick, cand)) pick = cand
        lay(companion, pick, false)
      }
      record(companion)
    }

    /** Lay one MEMBER of `zone` beside its mates: the legal cells within
     * ZONE_GAP_MIN..MAX (world, footprint to footprint; the max doubles, then
     * triples, when no cell is that snug) of a mate, nearest
     * the lead first (8-unit steps, the seed choosing within one), the box
     * off every framed piece outside the zone and never more than
     * ZONE_HIDDEN_MAX hidden behind (or hiding) a mate. A far-zone member
     * keeps its foot in the far band. */
    const layMember = (a: PropArchetype, zone: WorkZone, far: boolean) => {
      if (!view) return
      const mates = framedPieces.filter((f) => f.a.workZone === zone)
      const lead = mates.find((f) => f.a.zoneLead) ?? mates[0]
      if (!lead) return
      const strangers = framedPieces.filter((f) => f.a.workZone !== zone)
      const high = view.safe.y + view.safe.h * FAR_BAND_HIGH
      const heightOf = (q: PropArchetype, s: number) => (q.height ?? 2 * q.footprint) * s
      // only cells within reach of a mate can qualify (the widest gap tier,
      // the largest scale, the jitter): the scan skips the rest of the desk
      const reachOf = a.footprint * a.scaleJitter[1] + 3 * ZONE_GAP_MAX + DECOR_CELL
      const cells = scanCells(a, ZONE_REACH, placed, true, (cx, cz) => mates.some((f) => Math.hypot(cx - f.p.x, cz - f.p.z) <= f.p.footprint + reachOf))
      for (const gapMax of [ZONE_GAP_MAX, ZONE_GAP_MAX * 2, ZONE_GAP_MAX * 3]) {
        let pick: Cand | null = null
        let pickD = Infinity
        for (const { cand, box, base } of cells) {
          if (far && base > high) continue
          let gap = Infinity
          for (const f of mates) gap = Math.min(gap, Math.hypot(cand.x - f.p.x, cand.z - f.p.z) - cand.footprint - f.p.footprint)
          if (gap < ZONE_GAP_MIN || gap > gapMax) continue
          if (strangers.some((f) => meet(box, f.box))) continue
          const tall = heightOf(a, cand.scale)
          const hidden = mates.some((f) => {
            const fTall = heightOf(f.a, f.p.scale)
            const fBase = f.box.y + f.box.h
            // the taller one standing nearer the camera (lower foot on screen)
            if (fTall > tall && fBase > base) return coverOf(box, f.box) > ZONE_HIDDEN_MAX
            if (tall > fTall && base > fBase) return coverOf(f.box, box) > ZONE_HIDDEN_MAX
            return false
          })
          if (hidden) continue
          const d = Math.round(Math.hypot(cand.x - lead.p.x, cand.z - lead.p.z) / 8)
          if (d < pickD || (d === pickD && byHash(pick, cand))) {
            pick = cand
            pickD = d
          }
        }
        if (lay(a, pick, false)) break
      }
      record(a)
    }

    if (zoned && view) {
      // ── 2. the REFERENCE lead: the other near corner ──
      const coffee = () => framedPieces.filter((f) => f.a.workZone === 'coffee')
      for (const lead of pieces((a) => a.zoneLead === true && !a.companion && !a.farBand && a.workZone !== undefined)) {
        const low = view.safe.y + view.safe.h * NEAR_BAND_LOW
        const away = coffee()
        const sep = (b: Rect) => {
          const c = centre(b)
          const from = away.length > 0 ? away.map((f) => centre(f.box)) : [{ x: view.safe.x + view.safe.w / 2, y: c.y }]
          return Math.min(...from.map((q) => Math.hypot(c.x - q.x, c.y - q.y)))
        }
        let cells = scanCells(lead, ZONE_REACH, placed, true).filter((c) => c.base >= low && !framedPieces.some((f) => meet(c.box, f.box)))
        // the CORNER when the frame has one free (ZONE_CORNER_LOW)
        const corner = view.safe.y + view.safe.h * ZONE_CORNER_LOW
        if (cells.some((c) => c.base >= corner)) cells = cells.filter((c) => c.base >= corner)
        if (cells.length > 0) {
          const widest = Math.max(...cells.map((c) => sep(c.box)))
          /** The room a lead cell leaves its zone: how many other legal
           * lead-sized cells could hold a broad mate beside it — snug, and
           * clear of its box. The farthest corner alone could be a cramped
           * one: seed 76442 of placement.test's fixture left the blueprint
           * 7 legal cells, every one on another piece's box. */
          const roomOf = (c: Cell) => {
            let n = 0
            for (const o of cells) {
              if (o === c) continue
              const g = Math.hypot(o.cand.x - c.cand.x, o.cand.z - c.cand.z) - o.cand.footprint - c.cand.footprint
              if (g >= ZONE_GAP_MIN && g <= 2 * ZONE_GAP_MAX && !meet(o.box, c.box)) n++
            }
            return n
          }
          let pick: Cand | null = null
          let pickRoom = -1
          // as far from the coffee corner as the frame allows, among the
          // cells with ZONE_ROOM_MIN room; the spread widens before the room
          // gives way
          for (const spread of [COMPANION_SPREAD, 0.7, 0.5]) {
            for (const c of cells) {
              if (sep(c.box) < widest * spread) continue
              const room = Math.min(ZONE_ROOM_MIN, roomOf(c))
              if (room > pickRoom || (room === pickRoom && byHash(pick, c.cand))) {
                pick = c.cand
                pickRoom = room
              }
            }
            if (pickRoom >= ZONE_ROOM_MIN) break
          }
          lay(lead, pick, false)
        }
        record(lead)
      }
    }

    // ── 4. the NEAR band, 5. the FAR band ──
    // The foreground is a SCREEN band, not a height ratio: "≥ 0.75 of the
    // tallest projected height" is the companion's test, and for a tall thin
    // piece under a distant camera it covers nearly the whole desk (the
    // plant: 750 of 1 085 legal cells on the wide-left-panel fixture);
    // maximising the gap to the pieces already placed then pushed it to the
    // EMPTY FAR EDGE. So: the base in the lower NEAR_BAND_LOW of the safe
    // rect (the deep NEAR_BAND_DEEP first), at least NEAR_BAND_SEP of its
    // width from every foreground piece and ZONE_HALO from a zone's (halved,
    // then dropped, if the band is that full), the seed choosing. A far-band
    // piece mirrors the test: its foot in the upper FAR_BAND_HIGH; the
    // greenery lead takes the cell nearest the lamp. A WILDLIFE piece's box
    // keeps off every framed desk piece's (and, while the band has room, off
    // every other desk prop's too — else that organic prop leaves); every
    // other piece's box keeps off the wildlife's.
    const wildBoxes = () => framedPieces.filter((f) => isWildlife(f.a)).map((f) => f.box)
    const bandPiece = (piece: PropArchetype, farPiece: boolean) => {
      if (!view) return
      const low = view.safe.y + view.safe.h * NEAR_BAND_LOW
      const high = view.safe.y + view.safe.h * FAR_BAND_HIGH
      const wild = isWildlife(piece)
      const mineIdx = placed.map((p) => p.archetypeId).lastIndexOf(piece.id)
      const others = placed.filter((_, i) => i !== mineIdx)
      // a near-band piece stands WHOLLY off the slab (keepsClear's desk
      // rule): tucked under the overhang, the board's edge sliced the
      // moose's hindquarters off in loop4-r2-assets-m2/workbench-wide.png
      const cells = scanCells(piece, null, others, true)
      /** How well `b` keeps its distance, as a share of what it owes: the
       * screen distance between box centres over NEAR_BAND_SEP of the safe
       * width from every framed piece — ZONE_HALO from a zone's (an animal
       * standing against the coffee corner made the "pile at the right edge"
       * again, layout probe 2026-10-09) — or, with nothing framed yet, from
       * the frame's middle. */
      const sep = (b: Rect) => {
        const c = centre(b)
        if (framedPieces.length === 0) return Math.abs(c.x - (view.safe.x + view.safe.w / 2)) / (NEAR_BAND_SEP * view.safe.w)
        let s = Infinity
        for (const f of framedPieces) {
          const q = centre(f.box)
          s = Math.min(s, Math.hypot(c.x - q.x, c.y - q.y) / ((zoned && f.a.workZone ? ZONE_HALO : NEAR_BAND_SEP) * view.safe.w))
        }
        return s
      }
      const qualifiesAt = (base: number, s: number, minSep: number) => (farPiece ? base <= high : base >= low) && s >= minSep
      /** The screen boxes this piece keeps off: tier 0 adds every other desk
       * prop's (an organic coil or leaf behind an animal), tier 1 only the
       * framed pieces'. */
      const organicBoxes = wild
        ? placed
            .filter((p) => p.onDesk && p.archetypeId !== piece.id && !framedPieces.some((f) => f.p === p))
            .map((p) => projectedBox(p.x, p.z, p.scale, archById.get(p.archetypeId)))
            .filter((b): b is Rect => b !== null)
        : []
      const framedBoxes = framedPieces.map((f) => f.box)
      /** Tier 2 (wildlife only): the organic desk props no longer bind the
       * world spacing either — whichever the animal then crowds leaves the
       * desk below. */
      const framedOnly = () => scanCells(piece, null, others.filter((p) => !p.onDesk || framedPieces.some((f) => f.p === p)), true)
      const tiers: { keepOff: Rect[]; cells: () => Cell[] }[] = wild
        ? [
            { keepOff: [...framedBoxes, ...organicBoxes], cells: () => cells },
            { keepOff: framedBoxes, cells: () => cells },
            { keepOff: framedBoxes, cells: framedOnly },
          ]
        : [{ keepOff: wildBoxes(), cells: () => cells }]
      const lampAt = piece.workZone === 'greenery' && piece.zoneLead === true ? lamp : undefined
      const kept = placed.some((p) => {
        if (!p.onDesk || p.archetypeId !== piece.id) return false
        const b = projectedBox(p.x, p.z, p.scale, piece)
        return (
          framed(b) &&
          !(piece.clearOfBoard && overDiagram(b)) &&
          standsClear(piece, p.x, p.z, piece.footprint * p.scale) &&
          qualifiesAt(b.y + b.h, sep(b), 0.5) &&
          !tiers[0].keepOff.some((o) => meet(b, o))
        )
      })
      let pick: Cand | null = null
      // the separation relaxes twice (the last tier only keeps the boxes
      // apart): with the zones' leads in both near corners, a full band left
      // the moose or the beaver unplaced on a few live-board seeds
      search: for (const { keepOff, cells: tierCells } of kept ? [] : tiers) {
        const scanned = tierCells()
        for (const minSep of [1, 0.5, 0]) {
          // a near piece prefers the DEEP band when it has a free cell there:
          // the nearer the camera, the taller it projects (with the zones laid
          // first, the beaver stood 49.5 px under its 50 px bar on seed 147713
          // of placement.test's fixture)
          for (const deep of farPiece ? [false] : [true, false]) {
            let pickD = Infinity
            for (const { cand, box, base } of scanned) {
              if (!qualifiesAt(base, sep(box), minSep)) continue
              if (deep && base < view.safe.y + view.safe.h * NEAR_BAND_DEEP) continue
              if (keepOff.some((o) => meet(box, o))) continue
              // the greenery lead gathers beside the lamp (10-unit steps)
              const d = lampAt ? Math.round((Math.hypot(cand.x - lampAt.x, cand.z - lampAt.z) - cand.footprint - lampAt.r) / 10) : 0
              if (d < pickD || (d === pickD && byHash(pick, cand))) {
                pick = cand
                pickD = d
              }
            }
            if (pick) break search
          }
        }
      }
      // "into the band INSTEAD of the far edge", not a second copy
      lay(piece, pick, true)
      record(piece)
      if (wild) {
        // an organic desk prop the animal still crowds — its box meets the
        // animal's, or it stands inside the animal's spacing (the band had no
        // cell clear of them all) — leaves the desk: an animal never stands
        // on a prop, and a stray leaf or coil is what gives
        const mine = framedPieces.filter((f) => f.a.id === piece.id)
        for (let i = placed.length - 1; i >= 0; i--) {
          const p = placed[i]
          if (!p.onDesk || p.archetypeId === piece.id || framedPieces.some((f) => f.p === p)) continue
          const b = projectedBox(p.x, p.z, p.scale, archById.get(p.archetypeId))
          const crowds = mine.some((m) => {
            const minD = spacing(piece.id, m.p.footprint, true, p)
            return (b !== null && meet(b, m.box)) || (Math.abs(m.p.x - p.x) < minD && Math.abs(m.p.z - p.z) < minD)
          })
          if (!crowds) continue
          placed.splice(i, 1)
          perArchetype.set(p.archetypeId, (perArchetype.get(p.archetypeId) ?? 1) - 1)
        }
      }
    }
    if (view) {
      // ── the near zones' members, before the animals: a zone gathers where
      // its lead stands, and an animal finds its own room in the band (with
      // the animals first, a lead in a cramped corner had 7 legal cells left
      // and the blueprint none — seed 76442 of placement.test's fixture) ──
      if (zoned) {
        // the broadest first: the small tools fill in round them (placed
        // last, the 54-unit blueprint found no snug cell on 4 of 24 seeds)
        const broadFirst = (a: PropArchetype, b: PropArchetype) => b.footprint - a.footprint || (a.id < b.id ? -1 : 1)
        for (const zone of ['coffee', 'reference'] as const) {
          for (const a of pieces((q) => q.workZone === zone && !q.zoneLead).sort(broadFirst)) layMember(a, zone, false)
        }
      }
      for (const a of pieces((q) => q.nearBand === true && !q.companion)) bandPiece(a, false)

      // the far band: the greenery (its lead, then its members) before the
      // other pieces, or the CN tower could take the lamp's side first
      const farPieces = pieces((q) => q.farBand === true && !q.companion && !q.nearBand)
      for (const a of farPieces.filter((q) => zoned && q.zoneLead)) bandPiece(a, true)
      if (zoned) for (const a of pieces((q) => q.workZone === 'greenery' && !q.zoneLead)) layMember(a, 'greenery', true)
      for (const a of farPieces.filter((q) => !(zoned && q.zoneLead))) bandPiece(a, true)
    }
    // no zones: the lifted zone pieces return wherever they still fit
    for (const g of liftedZone) {
      const n = perArchetype.get(g.archetypeId) ?? 0
      if (n >= capOf(archById.get(g.archetypeId)) || placed.length >= MAX_TOTAL) continue
      const clear = placed.every((p) => {
        const minD = spacing(g.archetypeId, g.footprint, g.onDesk, p)
        return Math.abs(g.x - p.x) >= minD || Math.abs(g.z - p.z) >= minD
      })
      if (!clear) continue
      placed.push(g)
      perArchetype.set(g.archetypeId, n + 1)
    }
  }

  // ── face the camera (view3d quality loop 4 r3) ──
  // workbench-wide.png / workbench-cold.png: the beaver showed its back (its
  // flat tail read as a black hole on the desk) and the moose its rear
  // three-quarter — "brown pawns", no face. The animals' random yaw is
  // replaced, once the default framing is known, by the bearing of the
  // camera from the prop, a seeded 30-50° to one side: the muzzle (+X)
  // points just past the viewer. Rotation only — every position, scale and
  // collision bound (rotation-safe footprints) is unchanged.
  const eye = input.view ? cameraEyeOf(input.view.viewProj) : null
  if (eye) {
    for (const p of placed) {
      if (archById.get(p.archetypeId)?.rotation !== 'face-camera-3q') continue
      p.rotY = faceCameraYaw(p, eye, hashStr(p.propId))
    }
  }

  return placed.map(({ footprint: _f, ...p }) => p)
}

/** The camera's world position from a perspective view-projection matrix
 * (column-major): at the eye, clip x, y and w are all zero (only clip z is
 * not), so it solves rows 0, 1 and 3 of `m` = 0. Null for a degenerate
 * (orthographic) matrix. */
export function cameraEyeOf(m: readonly number[]): { x: number; y: number; z: number } | null {
  // A·p = rhs, A's rows the x, y, w rows of m (Cramer's rule)
  const rows = [0, 1, 3].map((r) => [m[r], m[4 + r], m[8 + r]])
  const rhs = [0, 1, 3].map((r) => -m[12 + r])
  const det3 = (q: number[][]) =>
    q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) -
    q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) +
    q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0])
  const d = det3(rows)
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null
  const solve = (k: number) => det3(rows.map((q, i) => q.map((v, j) => (j === k ? rhs[i] : v)))) / d
  return { x: solve(0), y: solve(1), z: solve(2) }
}

/** Seeded three-quarter offset off the camera bearing (radians). */
export const FACE_CAMERA_MIN = (30 * Math.PI) / 180
export const FACE_CAMERA_MAX = (50 * Math.PI) / 180

/** rotY that turns a prop's +X toward `eye`, then `FACE_CAMERA_MIN..MAX` to
 * the side the hash picks. three's yaw maps local +X to (cos θ, −sin θ) in
 * world (x, z), so +X faces (dx, dz) at θ = atan2(−dz, dx). */
export function faceCameraYaw(p: { x: number; z: number }, eye: { x: number; z: number }, h: number): number {
  const toward = Math.atan2(-(eye.z - p.z), eye.x - p.x)
  const off = FACE_CAMERA_MIN + ((h & 0xff) / 255) * (FACE_CAMERA_MAX - FACE_CAMERA_MIN)
  return toward + ((h >>> 8) & 1 ? off : -off)
}
