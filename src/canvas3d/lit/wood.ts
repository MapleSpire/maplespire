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

import * as THREE from 'three'

/**
 * The WORKBENCH the maquette sits on (lit profile): a plank-sawn walnut
 * tabletop of long boards.
 *
 * Every map — colour, roughness, relief — is ONE 512-px tile built from one
 * ring field, so the dark latewood in the colour sits exactly on the relief
 * that catches the light. The tile holds DESK_PLANKS board ROWS (a seam
 * groove on each edge): two straight-grain boards, each next to an ARCHED
 * twin (the same board plus one small cathedral). The desk is not a plane
 * with a repeat: deskBoardsGeometry lays it out as boards, each mapping one
 * tile row at its own offset along the grain, mirrored or not, with its own
 * tone in a vertex colour — so the tile never repeats as a lattice.
 *
 * History, each step a critic's quote on a harness shot:
 * - loop 4 r3 ("a flat tan plane with soft streaks"): one 2048 canvas
 *   stretched over a ≥6000-unit plane (~3 units per texel) → a repeated
 *   grain tile; the vignette that forced the stretch is its own overlay
 *   (deskVignetteTexture).
 * - loop 4 r3 ("sand dunes"): coherent warped bands → fine ring harmonics.
 * - 2026-10-09 ("stretched, smeared streaks like motion blur in every
 *   close-up"): six straight sine harmonics at an even pitch, a 0.82-unit
 *   texel magnified ~8× → rings of varied width and tone, an asymmetric
 *   latewood band, pores as short dashes, ray flecks, fibre in short runs,
 *   a 0.5-unit texel.
 * - 2026-10-09 second pass ("plywood wallpaper": tp-final-dpr1/workbench-
 *   wide.png, x 330-650 — rotary-cut ellipses larger than the moose
 *   repeating every ~200 px under a uniform pore speckle): that tile cut
 *   every board through its log's pith, so every board was one big nested
 *   cathedral, and the plane repeated the tile as a lattice. Now the grain
 *   is straight (plank-sawn, rings 1.6-2.4 units ≈ 4-6 mm, streaks of ring
 *   groups across it), a cathedral is a rare small feature placed by the
 *   geometry, and the boards break the tile period (deskBoardsGeometry).
 *
 * Procedural + deterministic (LCG), cached by (base, seed, contrast); the
 * relief + roughness pair is shared by every desk colour.
 */

/** Walnut desk albedo (sRGB). The board (wood tray, ~(206,155,98) rendered)
 * must read a clear value step lighter than the desk around it — run.mjs
 * gate "workbench.wide: board median luminance >= 12% over the desk's",
 * measured 32 % with this base (loop4-r4-scene-a-dpr1). */
export const WOOD_DESK_BASE = '#96714F'

/** The CITY world's desk (the apron its desk props stand on, inside the
 * city's hole): a pale birch model board, the neutral the city's own
 * pavement (#B7AA92, decor/backgrounds.ts CITY.apron) sits on — not the
 * dark walnut, which read as a muddy pit under the city animals
 * (city-moose/city-flag.png, 2026-10-09). A near-plain board: its
 * close-ups are the tightest of all (a 0.25-scale prop ~50 units away,
 * ~20 px per texel), where every pore and band of the grain magnified into
 * a soft streak (tp-wood-2/city-flag.png at contrast 0.5 and full relief;
 * still streaky in tp-wood-3/city-moose.png at 0.3 with the plank tones
 * kept), so its figure — board tones included (deskBoardsGeometry takes the
 * same contrast) — is a whisper and its relief (CITY_DESK_RELIEF, the
 * material's normalScale — a uniform, the program is the desk's) almost
 * flat. */
export const CITY_DESK_BASE = '#CDBD9E'
export const CITY_DESK_CONTRAST = 0.15
export const CITY_DESK_RELIEF = 0.06
/** The walnut desk's normalScale (Scene3D). */
export const WOOD_DESK_RELIEF = 0.3

/** The grain tile: GRAIN_TILE_PX² texels spanning GRAIN_TILE_WORLD units
 * ALONG the grain (u, world x) and GRAIN_TILE_ACROSS units across it (v):
 * 0.5 units per texel. The close-ups (run.mjs focusProp: flag 260, moose
 * ~220, beaver 180 units away at a 29.6° fov) frame ~0.1 unit per pixel,
 * ~0.06 in their foreground: the old 0.82-unit texel was magnified 8-14×
 * into soft streaks (tp-wood-1/workbench-beaver.png with 0.94 along the
 * grain: the foreground pores still smeared). Textures stay ≤ 512 px (perf
 * rule). Seamless along x by construction (every term is periodic in x);
 * across, every row block starts and ends on a groove. */
export const GRAIN_TILE_PX = 512
export const GRAIN_TILE_WORLD = 256
export const GRAIN_TILE_ACROSS = 256

/** Board rows in the tile (they stack in v): at the cutting mat's 4.1
 * units/cm, 256 / 4 = 64 units ≈ 16 cm wide boards. Rows 2b and 2b+1 are
 * board b PLAIN and board b ARCHED (deskRow). */
export const DESK_PLANKS = 4
/** Distinct boards in the tile (each with a plain and an arched row). */
export const DESK_BOARDS = DESK_PLANKS / 2
/** One board's width, world units. */
export const PLANK_WIDTH = GRAIN_TILE_ACROSS / DESK_PLANKS
/** The tile row of board `board` (0..DESK_BOARDS-1), plain or arched. */
export function deskRow(board: number, arched: boolean): number {
  return board * 2 + (arched ? 1 : 0)
}
/** Depth of a seam groove in the height field (latewood peaks at ~0.6,
 * pores dip to ~-1): the deepest feature, so the seam reads as a cut. */
const GROOVE_DEPTH = 1.8
/** Mean ring width (world units): 1.6-2.4 ≈ 4-6 mm, walnut's own growth
 * (the rotary tile drew 3.5-6 and bunched them into ~100-unit arches).
 * Every ring is then 0.55-1.45× that. 3-5 texels a ring: the latewood
 * band stays a texel or two wide, never a sub-texel alias. */
const PITCH_MIN = 1.6
const PITCH_SPAN = 0.8
/** Share of a board's tiles (inside the arch radius) drawn from its
 * ARCHED row: ~1 in 16 — at the fit framing (~3 000 × 2 000 units of desk,
 * ~370 tiles) a couple of dozen small cathedrals scattered over ~30 boards. */
export const ARCH_SHARE = 0.06

export interface WorkbenchTextures {
  /** Colour tile, same tile as the two below. The desk's UVs carry the
   * world scale (deskBoardsGeometry): `repeat` stays (1, 1). */
  map: THREE.DataTexture
  /** Grain tile, shared by every desk colour. */
  roughnessMap: THREE.DataTexture
  /** Grain relief, same tile as the roughness map. */
  normalMap: THREE.DataTexture
}

export interface GrainTile {
  normal: Uint8Array
  rough: Uint8Array
  height: Float32Array
  /** Pore-dash depth per texel (≥ 0) — already subtracted from `height`. */
  pore: Float32Array
  /** 1 where a seam groove is cut (N × N). */
  seam: Uint8Array
  /** The tile row (board, plain/arched) each texel ROW belongs to. */
  plankOfRow: Uint8Array
  /** Growth-ring coordinate (rings counted across the board, continuous):
   * an integer crossing is a ring boundary. */
  ring: Float32Array
  /** Latewood share 0..1 (the dark band before each ring boundary). */
  late: Float32Array
  /** Ray fleck strength 0..1 (lighter, smoother lens flecks). */
  fleck: Float32Array
  /** The colour's DETAIL factor around 1 (ring-group streaks, latewood,
   * pores, flecks, fibre) — woodAlbedoTile multiplies it into the base. */
  shade: Float32Array
}

function smooth01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  return c * c * (3 - 2 * c)
}

/** The grain tile as raw arrays (pure — the test seam).
 *
 * Each board is plank-sawn far from the pith: its rings cross the face as
 * near-STRAIGHT lines along x, every ring its own width, wandering and
 * converging slowly (periodic over the tile). Ring groups carry a slow tone
 * band — the long light/dark streaks a walnut board reads by at a distance.
 * Its ARCHED twin row is the same board, texel for texel, plus ONE small
 * cathedral: a local lift of the ring coordinate steeper than the rings
 * themselves, so a few rings fold into nested pointed loops (~25 units
 * across, ~60-100 long) — and the lift is exactly zero near the tile's x
 * wrap, so a board can switch between its two rows there without a seam.
 *
 * Tangent-space normals (RGBA8, +Y up / OpenGL; slopes per TEXEL — three's
 * derivative frame follows the desk's UVs, mirrored ones included) and a
 * roughness map (RGBA8, G is what three samples): latewood, pores and
 * grooves rougher, ray flecks smoother. */
export function grainTile(seed = 0x6a41): GrainTile {
  const N = GRAIN_TILE_PX
  const ax = GRAIN_TILE_WORLD / N
  const ay = GRAIN_TILE_ACROSS / N
  const ROWS = N / DESK_PLANKS
  const TAU = Math.PI * 2
  const rnd = lcg(seed)
  const plankOfRow = new Uint8Array(N)
  for (let y = 0; y < N; y++) plankOfRow[y] = Math.floor(y / ROWS)
  // latewood profile over the ring fraction: earlywood, a gradual darkening
  // into the latewood band, then the ABRUPT ring boundary (the next spring's
  // earlywood starts at once) — the asymmetry is what reads as wood
  const LUT = 256
  const lateLut = new Float32Array(LUT)
  for (let i = 0; i < LUT; i++) {
    const f = i / LUT
    lateLut[i] = f < 0.55 ? 0 : f < 0.82 ? smooth01((f - 0.55) / 0.27) : f < 0.94 ? 1 : (1 - f) / 0.06
  }
  // fibre: value noise in short runs along x (FIB cells), independent per
  // row — the fine streaking of the vessels, broken every few units
  const FIB = 16
  const NC = N / FIB
  const fibW = new Float32Array(FIB)
  for (let i = 0; i < FIB; i++) fibW[i] = smooth01(i / FIB)

  const ring = new Float32Array(N * N)
  const late = new Float32Array(N * N)
  const fibre = new Float32Array(N * N)
  const tone = new Float32Array(N * N)
  const pore = new Float32Array(N * N)
  const fleck = new Float32Array(N * N)
  const W = new Float32Array(N)
  const V = new Float32Array(N)
  const env = new Float32Array(N)
  const STEP = 0.05
  for (let b = 0; b < DESK_BOARDS; b++) {
    const yP = deskRow(b, false) * ROWS
    const yA = deskRow(b, true) * ROWS
    const cy = yP + ROWS / 2
    const half = (ROWS / 2) * ay
    const pitch = PITCH_MIN + rnd() * PITCH_SPAN
    // the slow wander of the lines (≤ ~1 ring over the tile) and their slow
    // convergence (±4 % of their spacing), both periodic in x
    const a1 = 0.6 + rnd() * 0.8
    const a2 = 0.15 + rnd() * 0.3
    const p1 = rnd() * TAU
    const p2 = rnd() * TAU
    const cv = (rnd() - 0.5) * 0.08
    const p3 = rnd() * TAU
    for (let x = 0; x < N; x++) {
      W[x] = a1 * Math.sin((TAU * x) / N + p1) + a2 * Math.sin((2 * TAU * x) / N + p2)
      V[x] = cv * Math.sin((TAU * x) / N + p3)
    }
    // the ring coordinate across the board: every ring its own width
    const off = half + 8
    const sMax = 2 * half + 20
    const rl = new Float32Array(Math.ceil(sMax / STEP) + 2)
    let B = 0
    let k = 0
    let w = pitch * (0.55 + 0.9 * rnd())
    for (let j = 0; j < rl.length; j++) {
      const s = j * STEP
      while (s > B + w) {
        B += w
        k++
        w = pitch * (0.55 + 0.9 * rnd())
      }
      rl[j] = k + (s - B) / w
    }
    const last = rl.length - 1
    // every ring its own tone (±5 %) on two slow bands over the ring number:
    // groups of 2-4 and 5-12 rings — the streaks (3-30 units wide) that
    // carry the figure at the fit framing, where single rings mip away
    const rings = k + 2
    const ringTone = new Float32Array(rings)
    const P1 = 5 + rnd() * 7
    const P2 = 2 + rnd() * 2
    const f1 = rnd() * TAU
    const f2 = rnd() * TAU
    for (let i = 0; i < rings; i++) {
      ringTone[i] = (1 + (rnd() - 0.5) * 0.1) * (1 + 0.07 * Math.sin((TAU * i) / P1 + f1) + 0.04 * Math.sin((TAU * i) / P2 + f2))
    }
    // the cathedral of the ARCHED row: one lift of the ring coordinate,
    // Gaussian across (σ units), compact along x — a short rise on its tip
    // side, a long tail — and a little steeper than the rings (fold ratio
    // 1.1-1.35): the few rings it lifts past their neighbours close into
    // nested pointed flames, the rest only bow. Zero within ≥ 16 units of
    // the tile's x wrap (deskBoardsGeometry switches rows there). (A
    // 12-20-unit tip, 45-75 tail and fold 1.25-1.7 drew round KNOTS, not
    // arches — first preview of this design.)
    const sig = 5 + rnd() * 3
    const fold = 1.1 + rnd() * 0.25
    const lift = (fold * sig * Math.sqrt(Math.E)) / pitch
    const dir = rnd() < 0.5 ? 1 : -1
    const tip = 22 + rnd() * 14
    const tail = 110 + rnd() * 50
    const xs = 52 + rnd() * 20
    const x0 = dir > 0 ? xs : GRAIN_TILE_WORLD - xs
    const yc = (rnd() - 0.5) * half * 0.6
    for (let x = 0; x < N; x++) {
      const dx = ((x + 0.5) * ax - x0) * dir
      const q = dx < 0 ? dx / tip : dx / tail
      env[x] = Math.abs(q) < 1 ? (1 - q * q) ** 3 : 0
    }
    const fibLat = new Float32Array(NC)
    const inv = 1 / STEP
    for (let y = 0; y < ROWS; y++) {
      const Y = (yP + y + 0.5 - cy) * ay
      const ga = lift * Math.exp(-((Y - yc) * (Y - yc)) / (2 * sig * sig))
      for (let c = 0; c < NC; c++) fibLat[c] = rnd() * 2 - 1
      const rowP = (yP + y) * N
      const rowA = (yA + y) * N
      for (let x = 0; x < N; x++) {
        const s = Y * (1 + V[x]) - W[x] + off
        const jj = (s * inv) | 0
        const t = rl[jj < 0 ? 0 : jj > last ? last : jj]
        const c = (x / FIB) | 0
        const fw = fibW[x - c * FIB]
        const fb = fibLat[c] * (1 - fw) + fibLat[c + 1 === NC ? 0 : c + 1] * fw
        // the plain row…
        const ti = t | 0
        const i = rowP + x
        ring[i] = t
        late[i] = lateLut[((t - ti) * LUT) | 0]
        tone[i] = ringTone[ti < rings ? ti : rings - 1]
        fibre[i] = fb
        // …and its arched twin: the same texel unless the cathedral lifts it
        const j = rowA + x
        const ta = t + ga * env[x]
        const tai = ta | 0
        ring[j] = ta
        late[j] = lateLut[((ta - tai) * LUT) | 0]
        tone[j] = ringTone[tai < rings ? tai : rings - 1]
        fibre[j] = fb
      }
    }
    // pores: short dashes along the grain (1 texel ≈ 0.12 mm across, 2-6
    // along), sparser in the latewood (walnut is semi-ring-porous); flecks:
    // tiny lens-shaped rays a shade lighter and glossier. Drawn on the PLAIN
    // row and copied into its arched twin (the two must meet seamlessly).
    for (let n = 0; n < 1000; n++) {
      const cx = Math.floor(rnd() * N)
      const y = Math.floor(rnd() * ROWS)
      const len = 2 + Math.floor(rnd() * 5)
      const depth = 0.55 + rnd() * 0.45
      if (late[(yP + y) * N + cx] > 0.5 && rnd() < 0.6) continue
      for (let d = 0; d < len; d++) {
        const v = depth * Math.sin((Math.PI * (d + 0.5)) / len)
        for (const yy of [yP + y, yA + y]) {
          const idx = yy * N + ((cx + d) % N)
          if (v > pore[idx]) pore[idx] = v
        }
      }
    }
    for (let n = 0; n < 750; n++) {
      const cx = Math.floor(rnd() * N)
      const y = Math.floor(rnd() * ROWS)
      const len = 2 + Math.floor(rnd() * 3)
      const s = 0.5 + rnd() * 0.5
      for (let d = 0; d < len; d++) {
        const v = s * Math.sin((Math.PI * (d + 0.5)) / len)
        for (const yy of [yP + y, yA + y]) {
          const idx = yy * N + ((cx + d) % N)
          if (v > fleck[idx]) fleck[idx] = v
        }
      }
    }
  }
  // the grooves, cut LAST (a pore never fills a seam): the first and last
  // texel row of every board row (~1 unit across with the next board's, a
  // 2.4 mm joint) — any two rows meet groove to groove, in the tile and on
  // the desk
  const seam = new Uint8Array(N * N)
  for (let p = 0; p < DESK_PLANKS; p++) {
    for (const y of [p * ROWS, (p + 1) * ROWS - 1]) {
      for (let x = 0; x < N; x++) seam[y * N + x] = 1
    }
  }
  const height = new Float32Array(N * N)
  const shade = new Float32Array(N * N)
  for (let i = 0; i < N * N; i++) {
    if (seam[i]) {
      height[i] = -GROOVE_DEPTH
      shade[i] = 1
      continue
    }
    const lw = late[i]
    const po = pore[i]
    const fl = fleck[i]
    const fb = fibre[i]
    height[i] = 0.6 * lw + 0.14 * fb - po
    shade[i] = tone[i] * (1 - 0.24 * lw) * (1 - 0.45 * po) * (1 + 0.1 * fl) * (1 + 0.07 * fb)
  }
  const normal = new Uint8Array(N * N * 4)
  const rough = new Uint8Array(N * N * 4)
  const S = 0.6
  for (let y = 0; y < N; y++) {
    const up = ((y + 1) % N) * N
    const dn = ((y - 1 + N) % N) * N
    const row = y * N
    for (let x = 0; x < N; x++) {
      const xr = x + 1 === N ? 0 : x + 1
      const xl = x === 0 ? N - 1 : x - 1
      const dx = (height[row + xr] - height[row + xl]) * 0.5
      // texture rows go DOWN in v here (DataTexture row 0 = v 0, flipY off),
      // so +y in the array IS +v: n.y = -dh/dv
      const dy = (height[up + x] - height[dn + x]) * 0.5
      let nx = -dx * S
      let ny = -dy * S
      const len = Math.sqrt(nx * nx + ny * ny + 1)
      nx /= len
      ny /= len
      const nz = 1 / len
      const i = row + x
      const o = i * 4
      normal[o] = Math.round((nx * 0.5 + 0.5) * 255)
      normal[o + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      normal[o + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      normal[o + 3] = 255
      // roughness (G): satin earlywood ~0.83, latewood and pores matte,
      // the ray flecks glossier, the grooves fully matte (× roughness 1)
      const r = seam[i] ? 255 : Math.round(Math.min(255, Math.max(180, 212 + 26 * late[i] + 40 * pore[i] - 34 * fleck[i])))
      rough[o] = r
      rough[o + 1] = r
      rough[o + 2] = r
      rough[o + 3] = 255
    }
  }
  return { normal, rough, height, pore, seam, plankOfRow, ring, late, fleck, shade }
}

/** What the colour pass needs of a grain tile (kept by the cache: a second
 * desk colour then costs one cheap pass, not a second ring field). */
type AlbedoInput = Pick<GrainTile, 'shade' | 'late' | 'seam' | 'plankOfRow'>

/** The colour tile (RGBA8 sRGB, GRAIN_TILE_PX², pure — the test seam), from
 * the SAME grain tile as the relief: the tile's detail (ring-group streaks,
 * latewood, pores, flecks) scaled by `contrast`, latewood a touch cooler
 * (walnut's chocolate lines), dark grooves with a catch-light on their
 * lower lip. No per-board tone and no slow wave along x: a board's tone is
 * its vertex colour (deskBoardsGeometry), and anything slow along x would
 * repeat every tile down each board. `seed` is kept for the cache key. */
export function woodAlbedoTile(base: string, tile: AlbedoInput, _seed: number, contrast = 1): Uint8Array {
  const N = GRAIN_TILE_PX
  // THREE.Color stores working-space (linear) components; the tile is an
  // sRGB texture, so it is filled with the css (sRGB) values
  const srgb = { r: 0, g: 0, b: 0 }
  new THREE.Color(base).getRGB(srgb, THREE.SRGBColorSpace)
  const b = [srgb.r * 255, srgb.g * 255, srgb.b * 255]
  const groove = 1 - 0.58 * Math.max(0.4, contrast)
  const out = new Uint8Array(N * N * 4)
  const { shade, late, seam, plankOfRow } = tile
  for (let y = 0; y < N; y++) {
    // the groove's lower lip catches the key light (a chamfer), one texel
    // (a row block's first row is its groove, so the lip is the next one)
    const lip = plankOfRow[(y - 1 + N) % N] !== plankOfRow[(y - 2 + N) % N] ? 1.07 : 1
    for (let x = 0; x < N; x++) {
      const i = y * N + x
      let k = lip
      let cool = 0
      if (seam[i]) k *= groove
      else {
        k *= 1 + contrast * (shade[i] - 1)
        cool = 0.05 * contrast * late[i]
      }
      const o = i * 4
      out[o] = Math.round(Math.min(255, b[0] * k * (1 - cool)))
      out[o + 1] = Math.round(Math.min(255, b[1] * k * (1 - cool * 0.6)))
      out[o + 2] = Math.round(Math.min(255, b[2] * k))
      out[o + 3] = 255
    }
  }
  return out
}

/** One board of the desk (deskBoardLayout — pure, the test seam). */
export interface DeskBoard {
  /** Local y extent (the plane's y; the desk is rotated to lie in x/z). */
  y0: number
  y1: number
  /** The tile board it maps (0..DESK_BOARDS-1). */
  board: number
  /** Mapped upside-down across the grain (v reversed). */
  mirror: boolean
  /** Mapped back-to-front along the grain (u reversed). */
  flip: boolean
  /** u at the desk's left edge (x = -size/2). */
  u0: number
  /** The board's tone (linear factor around 1), before its drift. */
  tone: number
  /** The tile indices (integer u) drawn from the ARCHED row. */
  arched: number[]
  /** Linear RGB factor knots along x: [x, r, g, b] — the board's tone,
   * drifting slowly along its length. */
  knots: [number, number, number, number][]
}

/** Desk boards, laid out across a size × size desk centred on 0 (pure).
 *
 * The tile repeats as a LATTICE on a plane: every 256 units both ways the
 * same figure (the "plywood wallpaper" of tp-final-dpr1/workbench-wide.png).
 * Here each board picks one of the tile's boards, a random offset along the
 * grain, a mirror across and along, and its own tone (its neighbour always
 * a clear step off) — and draws its arched row for ONE tile, rarely, at
 * random (within `archRadius` of the centre: the camera never frames
 * further). Along a board the plain row still repeats every tile, but it is
 * straight grain (translation-invariant along x but for pores and a slow
 * wander), and its tone drifts through knots ~700-1300 units apart. */
export function deskBoardLayout(size: number, seed = 0x5eed0b0a, contrast = 1, archRadius = 4000): DeskBoard[] {
  const rnd = lcg(seed ^ 0x2c1b3d)
  const half = size / 2
  const T = GRAIN_TILE_WORLD
  const out: DeskBoard[] = []
  let prevKey = -1
  let prevTone = 1
  for (let y0 = -half; y0 < half - 1e-6; y0 += PLANK_WIDTH) {
    const y1 = Math.min(half, y0 + PLANK_WIDTH)
    // a different (board, mirror) from the neighbour: no two adjacent boards
    // show the same streak sequence
    const board = Math.min(DESK_BOARDS - 1, Math.floor(rnd() * DESK_BOARDS))
    let mirror = rnd() < 0.5
    if (board * 2 + (mirror ? 1 : 0) === prevKey) mirror = !mirror
    prevKey = board * 2 + (mirror ? 1 : 0)
    const flip = rnd() < 0.5
    const u0 = rnd()
    // tone: linear factor ~0.78-1.22 (× contrast), a clear step off the
    // neighbour so the seam reads at the fit framing even where the groove
    // has mipped away; a red/yellow lean
    let tone = 1
    for (let tries = 0; tries < 8; tries++) {
      tone = 1 + (rnd() + rnd() + rnd() - 1.5) * 0.26 * contrast
      if (Math.abs(tone - prevTone) >= 0.06 * contrast) break
    }
    prevTone = tone
    const warm = (rnd() - 0.5) * 0.08 * contrast
    const colour = (t: number): [number, number, number] => [t * (1 + warm), t, t * (1 - 1.5 * warm)]
    // arched tiles: integer u fully on the desk and inside the arch radius,
    // ARCH_SHARE of them, never two in a row
    const arched: number[] = []
    const inY = Math.abs((y0 + y1) / 2) < archRadius
    const uAt = (x: number) => (flip ? u0 - (x + half) / T : u0 + (x + half) / T)
    if (inY) {
      const uA = uAt(-Math.min(half, archRadius))
      const uB = uAt(Math.min(half, archRadius))
      const lo = Math.ceil(Math.min(uA, uB))
      const hi = Math.floor(Math.max(uA, uB)) - 1
      for (let n = lo; n <= hi; n++) {
        if (rnd() < ARCH_SHARE && arched[arched.length - 1] !== n - 1) arched.push(n)
      }
    }
    // tone knots along the board: ±4 % (× contrast) every ~700-1300 units
    // inside the arch radius, one at each desk edge
    const knots: [number, number, number, number][] = []
    knots.push([-half, ...colour(tone * (1 + (rnd() - 0.5) * 0.08 * contrast))])
    const kx0 = Math.max(-half, -archRadius)
    const kx1 = Math.min(half, archRadius)
    for (let x = kx0 + 700 + rnd() * 600; x < kx1 - 300; x += 700 + rnd() * 600) {
      knots.push([x, ...colour(tone * (1 + (rnd() - 0.5) * 0.08 * contrast))])
    }
    knots.push([half, ...colour(tone * (1 + (rnd() - 0.5) * 0.08 * contrast))])
    out.push({ y0, y1, board, mirror, flip, u0, tone, arched, knots })
  }
  return out
}

/** The desk plane as boards (pure; replaces a PlaneGeometry of the same
 * size: the XY plane, +Z normal, centred on 0): one quad per run of a
 * board between its tone knots and arched tiles — UVs in tile units (the
 * textures' repeat stays 1), a `color` attribute carrying the board tone.
 * Contiguous quads share their edge's x, so no crack; boards meet on
 * their grooves. */
export function deskBoardsGeometry(size: number, seed = 0x5eed0b0a, contrast = 1): THREE.BufferGeometry {
  const half = size / 2
  const T = GRAIN_TILE_WORLD
  const A = GRAIN_TILE_ACROSS
  const pos: number[] = []
  const uv: number[] = []
  const col: number[] = []
  const idx: number[] = []
  for (const bd of deskBoardLayout(size, seed, contrast)) {
    const uAt = (x: number) => (bd.flip ? bd.u0 - (x + half) / T : bd.u0 + (x + half) / T)
    const xAt = (u: number) => (bd.flip ? (bd.u0 - u) * T - half : (u - bd.u0) * T - half)
    // the quad breaks: desk edges, every tone knot, both ends of each
    // arched tile
    const xs = new Set<number>(bd.knots.map((k) => k[0]))
    const archedX: [number, number][] = []
    for (const n of bd.arched) {
      const xa = xAt(n)
      const xb = xAt(n + 1)
      const lo = Math.min(xa, xb)
      const hi = Math.max(xa, xb)
      xs.add(lo)
      xs.add(hi)
      archedX.push([lo, hi])
    }
    const breaks = [...xs].filter((x) => x >= -half && x <= half).sort((a, b) => a - b)
    const colourAt = (x: number): [number, number, number] => {
      const k = bd.knots
      let j = 0
      while (j + 2 < k.length && x > k[j + 1][0]) j++
      const t = Math.min(1, Math.max(0, (x - k[j][0]) / (k[j + 1][0] - k[j][0])))
      return [k[j][1] + (k[j + 1][1] - k[j][1]) * t, k[j][2] + (k[j + 1][2] - k[j][2]) * t, k[j][3] + (k[j + 1][3] - k[j][3]) * t]
    }
    for (let q = 0; q + 1 < breaks.length; q++) {
      const xa = breaks[q]
      const xb = breaks[q + 1]
      if (xb - xa < 1e-6) continue
      const mid = (xa + xb) / 2
      const isArched = archedX.some(([lo, hi]) => mid > lo && mid < hi)
      const row = deskRow(bd.board, isArched)
      // v across: the row block [row/4, (row+1)/4], reversed when mirrored;
      // a board clipped by the desk edge keeps its near groove
      const vLo = row / DESK_PLANKS
      const vHi = vLo + (bd.y1 - bd.y0) / A
      const v0 = bd.mirror ? (row + 1) / DESK_PLANKS : vLo
      const v1 = bd.mirror ? (row + 1) / DESK_PLANKS - (bd.y1 - bd.y0) / A : vHi
      const base = pos.length / 3
      for (const [x, y, v] of [
        [xa, bd.y0, v0],
        [xb, bd.y0, v0],
        [xa, bd.y1, v1],
        [xb, bd.y1, v1],
      ]) {
        pos.push(x, y, 0)
        uv.push(uAt(x), v)
        col.push(...colourAt(x))
      }
      // counter-clockwise seen from +Z (the PlaneGeometry it replaces)
      idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  const nrm = new Float32Array(pos.length)
  for (let i = 2; i < nrm.length; i += 3) nrm[i] = 1
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setIndex(idx)
  return geo
}

/** Size of the vignette overlay texture — low frequency, so small. */
export const VIGNETTE_PX = 256

/** The desk VIGNETTE as an RGBA8 sRGB array (pure — the test seam): a
 * dark walnut colour whose ALPHA ramps from 0 just outside the board to
 * 0.55 at the plane's rim — the same ramp the stretched colour map used to
 * bake in (style review round 3, AAA round 3 sev10), now drawn as an overlay
 * (Scene3D) so the colour tile can repeat. Radii are fractions of the WHOLE
 * desk plane (≥6000 units). */
export function vignetteTile(size = VIGNETTE_PX): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  const stop = (r: number): number => {
    // 0 → 0.09: clear; 0.09 → 0.295: 0 → 0.22; 0.295 → 0.5: 0.22 → 0.55
    if (r <= 0.09) return 0
    if (r <= 0.295) return (0.22 * (r - 0.09)) / 0.205
    if (r <= 0.5) return 0.22 + (0.33 * (r - 0.295)) / 0.205
    return 0.55
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5)
      const o = (y * size + x) * 4
      out[o] = 38
      out[o + 1] = 24
      out[o + 2] = 12
      out[o + 3] = Math.round(stop(r) * 255)
    }
  }
  return out
}

/** The grain (relief + roughness) is shared by every desk colour; each
 * colour is its own small pass over the kept AlbedoInput. */
interface GrainEntry {
  input: AlbedoInput
  roughnessMap: THREE.DataTexture
  normalMap: THREE.DataTexture
}
const grainCache = new Map<number, GrainEntry>()
const cache = new Map<string, WorkbenchTextures>()
let vignetteCache: THREE.DataTexture | null = null

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

function repeated(arr: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(arr, size, size, THREE.RGBAFormat)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

export function workbenchTextures(base: string = WOOD_DESK_BASE, seed = 0x5eed0b0a, contrast = 1): WorkbenchTextures {
  const key = `${base}|${seed}|${contrast}`
  const hit = cache.get(key)
  if (hit) return hit
  let grain = grainCache.get(seed)
  if (!grain) {
    const tile = grainTile(seed ^ 0x9e3779b9)
    grain = {
      input: { shade: tile.shade, late: tile.late, seam: tile.seam, plankOfRow: tile.plankOfRow },
      roughnessMap: repeated(tile.rough, GRAIN_TILE_PX, false),
      normalMap: repeated(tile.normal, GRAIN_TILE_PX, false),
    }
    grainCache.set(seed, grain)
  }
  const out = {
    map: repeated(woodAlbedoTile(base, grain.input, seed, contrast), GRAIN_TILE_PX, true),
    roughnessMap: grain.roughnessMap,
    normalMap: grain.normalMap,
  }
  cache.set(key, out)
  return out
}

/** The desk vignette overlay's texture (one per page, ONE stretch — clamp,
 * never repeated: the vignette must not tile). */
export function deskVignetteTexture(): THREE.DataTexture {
  if (vignetteCache) return vignetteCache
  const tex = new THREE.DataTexture(vignetteTile(), VIGNETTE_PX, VIGNETTE_PX, THREE.RGBAFormat)
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  vignetteCache = tex
  return tex
}

/** Drop every cached workbench texture (theme flips / scene dispose). */
export function disposeWorkbenchTextures(): void {
  for (const [, t] of cache) t.map.dispose()
  cache.clear()
  for (const [, g] of grainCache) {
    g.roughnessMap.dispose()
    g.normalMap.dispose()
  }
  grainCache.clear()
  vignetteCache?.dispose()
  vignetteCache = null
}
