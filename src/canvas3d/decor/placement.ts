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
  rotation: 'face-nearest-node' | 'random-y' | 'grid'
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
}

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
  /** Width (world px) of the DESK annulus outside the slab where
   * zone:'desk' archetypes may land. Omit to disable desk placement
   * (unlit themes have no workbench plane). */
  deskBand?: number
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

// ── crowd staging ──
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
    return false
  }
  const connDist = (cx: number, cz: number): number => {
    let best = Infinity
    for (const c of input.connections) {
      const pts = c.points
      for (let i = 1; i < pts.length; i++) {
        const ax = pts[i - 1].x
        const az = pts[i - 1].y
        const bx = pts[i].x
        const bz = pts[i].y
        const dx = bx - ax
        const dz = bz - az
        const len2 = dx * dx + dz * dz || 1
        const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cz - az) * dz) / len2))
        const px = ax + t * dx
        const pz = az + t * dz
        const d = Math.hypot(cx - px, cz - pz)
        if (d < best) best = d
      }
    }
    return best
  }
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
      const band = input.deskBand ?? 0
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
    const band = input.deskBand ?? 0
    if (deskZone && band <= 0) continue
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
        if (s <= 0 || blocked(cx, cz)) continue
        const hCell = mix(input.seed, aHash, ix, iz)
        if (hCell / 0xffffffff >= p * s) continue
        // further bits drive jitter / rotation / scale — same hash, so a
        // surviving cell keeps its exact pose across unrelated edits
        const hJit = mix(hCell, aHash, iz, ix)
        const jx = (((hJit & 0xff) / 255) - 0.5) * (DECOR_CELL - a.footprint)
        const jz = ((((hJit >>> 8) & 0xff) / 255) - 0.5) * (DECOR_CELL - a.footprint)
        // the jittered FINAL point must clear the blockers too — a cell whose
        // center is legal can still jitter into a card's label margin
        if (blocked(cx + jx, cz + jz)) continue
        const scale = a.scaleJitter[0] + (((hJit >>> 16) & 0xff) / 255) * (a.scaleJitter[1] - a.scaleJitter[0])
        let rotY: number
        if (a.rotation === 'grid') rotY = (((hJit >>> 24) & 0x3) * Math.PI) / 2
        else if (a.rotation === 'random-y') rotY = (((hJit >>> 24) & 0xff) / 255) * Math.PI * 2
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
  candidates.sort((a, b) => a.h - b.h || (a.propId < b.propId ? -1 : 1))
  const archById = new Map(input.archetypes.map((a) => [a.id, a]))
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
      // organic instead of gridded.
      const minD = (c.footprint + p.footprint) * (c.onDesk && p.onDesk ? 1 : 0.6)
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
  const deskBandW = input.deskBand ?? 0
  if (input.density !== 'sparse' && deskBandW > 0 && placed.length < MAX_TOTAL) {
    const showcase = input.archetypes
      .filter((a) => (a.zone ?? 'board') === 'desk')
      .sort((a, b) => b.footprint - a.footprint || (a.id < b.id ? -1 : 1))[0]
    // Two window tiers, from projecting the default framing:
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
    const satisfied =
      showcase !== undefined &&
      placed.some((p) => p.onDesk && p.archetypeId === showcase.id && inWindow(p.x, p.z, 0.32, 0.38))
    if (showcase && !satisfied && (perArchetype.get(showcase.id) ?? 0) < capOf(showcase)) {
      const aHash = hashStr(showcase.id)
      const ext = Math.ceil((deskBandW + 10) / DECOR_CELL)
      let best: (PlacedProp & { footprint: number; h: number }) | null = null
      for (const [lo, hi] of [[0.32, 0.38], [0.25, 0.46]] as const) {
        if (best) break // primary tier found a legal cell — no fallback
        for (let ix = -ext; ix < cols + ext; ix++) {
          for (let iz = -ext; iz < rows + ext; iz++) {
            const cx = x0 + (ix + 0.5) * DECOR_CELL
            const cz = z0 + (iz + 0.5) * DECOR_CELL
            if (!inWindow(cx, cz, lo, hi)) continue
            if (score(showcase, cx, cz) <= 0 || blocked(cx, cz)) continue
            const hCell = mix(input.seed, aHash, ix, iz)
            const propId = `${showcase.id}:${ix}:${iz}`
            if (best && (best.h < hCell || (best.h === hCell && best.propId < propId))) continue
            const hJit = mix(hCell, aHash, iz, ix)
            const jx = (((hJit & 0xff) / 255) - 0.5) * (DECOR_CELL - showcase.footprint)
            const jz = ((((hJit >>> 8) & 0xff) / 255) - 0.5) * (DECOR_CELL - showcase.footprint)
            const fx = cx + jx
            const fz = cz + jz
            if (blocked(fx, fz)) continue
            const scale = showcase.scaleJitter[0] + (((hJit >>> 16) & 0xff) / 255) * (showcase.scaleJitter[1] - showcase.scaleJitter[0])
            const footprint = showcase.footprint * scale
            let collides = false
            for (const p of placed) {
              // NEVER relaxed: the promoted piece is a desk
              // prop, so against every already-placed desk prop the strict
              // no-bbox-overlap bound applies — the fallback tier above
              // relaxes the window, not the spacing
              const minD = (footprint + p.footprint) * (p.onDesk ? 1 : 0.6)
              if (Math.abs(fx - p.x) < minD && Math.abs(fz - p.z) < minD) {
                collides = true
                break
              }
            }
            if (collides) continue
            best = {
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

  return placed.map(({ footprint: _f, ...p }) => p)
}
