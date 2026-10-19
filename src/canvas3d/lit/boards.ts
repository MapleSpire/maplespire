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
import { PAPER_PITCH, PAPER_TILE_CELLS, type PaperBoardTextures } from './paper'

/**
 * Lit-profile TRAY board surfaces: three procedural looks for the board cap —
 * honey wood veneer with an engraved inlay grid, matte museum-white lacquer,
 * and burnished terracotta clay. CanvasTexture pairs, zero asset bytes, cached
 * by full option key, sharing paper.ts's texture contract exactly:
 *
 * - the board cap samples RAW world-px extrude UVs, so a FIXED repeat maps
 *   one tile onto PAPER_PITCH * PAPER_TILE_CELLS world units on any board
 *   size — the 20-unit grid pitch stays exact;
 * - every drawn feature tiles seamlessly under RepeatWrapping (wrap-drawn
 *   blobs, integer sine periods on grain, edge-symmetric clay vignette);
 * - roughness is grid-INDEPENDENT and shared between showGrid variants:
 *   Scene3D's litFloorGrid toggle swaps only `map`, so both variants of a
 *   look must agree on roughness — sharing the instance makes that
 *   structural instead of coincidental.
 */

export type TrayBoardTextures = PaperBoardTextures

export type TrayVariant = 'wood' | 'museum' | 'clay'
export const TRAY_VARIANTS: readonly TrayVariant[] = ['wood', 'museum', 'clay']
/** Each tray's base paint (the tile's fill before grain, speckle or
 * mottling) — also what the lit ink lines pick their ink set against
 * (inkLine.inkSetFor). */
export const TRAY_BASE_CSS: Record<TrayVariant, string> = {
  wood: '#CB9C5C',
  museum: '#F0F2F2',
  clay: '#9A4E2E',
}

export interface TraySpec {
  /** Grid line color (css) — ignored when showGrid is false. */
  grid: string
  /** Draw the pitch grid? (the board's grid toggle swaps color maps). */
  showGrid: boolean
  /** Draw the 20-unit MINOR lines too (default true)? Scene3D's board at
   * rest wears the majors only and swaps to the full pitch while a card is
   * dragged — view3d quality loop 4 r3 (workbench-wide / city-wide /
   * workbench-labels.png): "an even 20-unit cross-hatch is clearly visible
   * over the whole board wood, behind every card and label", at the 0.14 /
   * 0.08 minor alphas loop 4 had already halved twice. */
  minors?: boolean
}

/** px per grid cell in the tile bitmap — must equal paper.ts's private
 * CELL_PX so the tray grids land on the same world pitch as the paper's. */
const CELL_PX = 64
const TILE_PX = CELL_PX * PAPER_TILE_CELLS

/** Fixed per-variant seeds — same diagram ⇒ identical boards on every client. */
const SEEDS: Record<TrayVariant, number> = {
  wood: 0x77aa11ee,
  museum: 0x4d5e6f01,
  clay: 0xc1a70b21,
}

const pairCache = new Map<string, TrayBoardTextures>()
/** One roughness texture per variant, shared by its showGrid on/off pair. */
const roughCache = new Map<TrayVariant, THREE.CanvasTexture>()

/** Deterministic LCG so every tray is identical across rebuilds. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

function tile(px: number = TILE_PX): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  return { canvas, ctx: canvas.getContext('2d')! }
}

/** Texture params copied verbatim from paper.ts — same cap mesh, same raw
 * world-px extrude UVs, so the FIXED repeat keeps the pitch exact and the
 * cached textures are safely shared across scenes. `span` (world units the
 * tile covers along u, v) defaults to the grid tile; a map carrying no grid
 * may span more — three gives every map its own uv transform (a uniform,
 * the same program). */
function mkTexture(
  c: HTMLCanvasElement,
  srgb: boolean,
  span: { x: number; z: number } = { x: PAPER_PITCH * PAPER_TILE_CELLS, z: PAPER_PITCH * PAPER_TILE_CELLS },
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 16
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.repeat.set(1 / span.x, 1 / span.z)
  return tex
}

/** Draw at the 9 wrap offsets so features crossing a tile edge continue on
 * the opposite side — RepeatWrapping turns any clipped blob into a seam. */
function wrapped(draw: (dx: number, dy: number) => void): void {
  for (const dx of [-TILE_PX, 0, TILE_PX]) {
    for (const dy of [-TILE_PX, 0, TILE_PX]) draw(dx, dy)
  }
}

/** One grain streak along x, drawn at y and y±TILE so widths crossing the
 * top/bottom edge wrap; INTEGER `periods` keeps y(0) === y(TILE_PX), so the
 * left/right seam is exact by construction. The optional second sine is a
 * LOW-frequency wander (INTEGER `wavePeriods`, so the seam still closes):
 * with it, a streak drifts across its neighbours instead of running as a
 * printed parallel stripe — sawn grain wavers, laminate doesn't. */
function strokeGrainLine(
  ctx: CanvasRenderingContext2D,
  y0: number,
  amp: number,
  periods: number,
  phase: number,
  wave = 0,
  wavePeriods = 3,
  wavePhase = 0,
): void {
  for (const dy of [-TILE_PX, 0, TILE_PX]) {
    ctx.beginPath()
    for (let x = 0; x <= TILE_PX; x += 8) {
      const y =
        y0 +
        dy +
        Math.sin(phase + (x / TILE_PX) * periods * Math.PI * 2) * amp +
        Math.sin(wavePhase + (x / TILE_PX) * wavePeriods * Math.PI * 2) * wave
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
}

/** Pitch grid with paper.ts's exact geometry: minors at every CELL_PX plus
 * one heavier major per tile (= 100 world units); `shift` offsets the whole
 * pass for engraving highlights. Widths ≥1.4 on the visible pass — mipmapping
 * eats fainter hairlines fast (paper.ts's hard-won calibration). */
function gridLines(
  ctx: CanvasRenderingContext2D,
  width: number,
  alpha: number,
  majorWidth: number,
  majorAlpha: number,
  shift = 0,
  minors = true,
): void {
  ctx.globalAlpha = alpha
  ctx.lineWidth = width
  // c = 0 is the major's own line (drawn again, heavier, below)
  for (let c = minors ? 0 : PAPER_TILE_CELLS; c < PAPER_TILE_CELLS; c++) {
    const p = c * CELL_PX + 0.5 + shift
    ctx.beginPath()
    ctx.moveTo(p, 0)
    ctx.lineTo(p, TILE_PX)
    ctx.moveTo(0, p)
    ctx.lineTo(TILE_PX, p)
    ctx.stroke()
  }
  ctx.globalAlpha = majorAlpha
  ctx.lineWidth = majorWidth
  ctx.beginPath()
  ctx.moveTo(1.1 + shift, 0)
  ctx.lineTo(1.1 + shift, TILE_PX)
  ctx.moveTo(0, 1.1 + shift)
  ctx.lineTo(TILE_PX, 1.1 + shift)
  ctx.stroke()
  ctx.globalAlpha = 1
}

/** Engraved grid: dark cut line + a 1px light catch offset below/right —
 * light comes from the top-left, so the offset reads as the far wall of a
 * carved groove catching the key, not as printed ink. */
function engravedGrid(
  ctx: CanvasRenderingContext2D,
  cut: string,
  lightCatch: string,
  cutWidth: number,
  cutAlpha: number,
  catchAlpha: number,
  minors = true,
): void {
  ctx.strokeStyle = cut
  gridLines(ctx, cutWidth, cutAlpha, cutWidth + 0.8, Math.min(1, cutAlpha + 0.15), 0, minors)
  ctx.strokeStyle = lightCatch
  gridLines(ctx, 1, catchAlpha, 1.2, catchAlpha, 1.4, minors)
}

// ── wood: honey veneer with visible grain figure, engraved desk ──────────────

/** VIEW3D QUALITY LOOP 4 (critic, workbench-labels / workbench-cold /
 * workbench-wide.png): the wood cap read as "dense short dash and stagger
 * marks every 10-20 px — a brick or tile pattern behind the cards", and as a
 * fine grid across the whole plateau at the overview distance. Its colour
 * tile repeats every 100 world units (the grid pitch contract), so every
 * feature in it — the grain wiggles, the two knots, the heavy latewood —
 * repeated twice across each 200-wide card. The colour map now carries the
 * grain at HALF its old albedo contrast and no knots (a knot every ~70 units
 * was the strongest periodic mark); the PLANKS — long, few, staggered — live
 * in the roughness map on its own large repeat (WOOD_ROUGH), where the key
 * light picks them out as satin variation instead of printed stripes. */
const WOOD_GRAIN_CONTRAST = 0.5

/** The wood roughness tile: 512 px square stretched over 1600 x 640 world
 * units — long along the grain (x, 0.32 px/unit: grain and plank ends are
 * smooth along it) and finer across (z, 0.8 px/unit: the seams between
 * planks). Planks are 80 units wide (8 rows a tile) and 800 long — four
 * 200-wide cards — with each row's end seams staggered at random. */
export const WOOD_ROUGH = { px: 512, spanX: 1600, spanZ: 640, plankW: 80, plankL: 800 } as const

function paintWoodColor(ctx: CanvasRenderingContext2D, rnd: () => number, spec: TraySpec): void {
  ctx.fillStyle = TRAY_BASE_CSS.wood
  ctx.fillRect(0, 0, TILE_PX, TILE_PX)

  // tight straight grain: many low-amplitude streaks along x — dark latewood
  // clearly outnumbering pale earlywood, alphas high enough to survive
  // mipmap averaging at default zoom (the tan-laminate fix)
  // ~a third of the streaks additionally WANDER on a low-frequency wave
  // (period ≈ a third of the tile, amplitude 2..4px) so the field clusters
  // and crosses itself instead of reading as evenly-spaced printed stripes.
  // VIEW3D QUALITY LOOP 3: at 0.09..0.20 alpha this family read as "dense
  // vertical grain striations" at the same pitch as the connection tubes, and
  // the pale 'evaluates'/'uses' line lost its contrast across it
  // (workbench-labels.png). It now runs at 0.035..0.08 — a texture under the
  // figure, not a stripe field — and the heavy latewood + sheen bands below
  // carry the grain read at framing distance. Same rnd() draws, same count, so
  // the rest of the tile keeps its exact layout.
  const streaks = 150
  for (let i = 0; i < streaks; i++) {
    const y0 = rnd() * TILE_PX
    const amp = 0.5 + rnd() * 1.8
    const periods = 1 + Math.floor(rnd() * 4)
    const phase = rnd() * Math.PI * 2
    const width = 0.8 + rnd() * 1.8
    const dark = rnd() < 0.62
    const a = (0.035 + rnd() * 0.045) * WOOD_GRAIN_CONTRAST
    const wave = rnd() < 0.34 ? 2 + rnd() * 2 : 0
    const wavePeriods = 2 + Math.floor(rnd() * 2)
    const wavePhase = rnd() * Math.PI * 2
    ctx.strokeStyle = dark ? `rgba(104,62,30,${a})` : `rgba(250,228,188,${a * 0.75})`
    ctx.lineWidth = width
    strokeGrainLine(ctx, y0, amp, periods, phase, wave, wavePeriods, wavePhase)
  }

  // sparse heavy latewood: bolder dark figure lines that still read as real
  // grain at wide zoom — these carry the wander most,
  // being the lines the eye actually follows at framing distance
  for (let i = 0; i < 24; i++) {
    const y0 = rnd() * TILE_PX
    const amp = 1 + rnd() * 2.6
    const periods = 1 + Math.floor(rnd() * 3)
    const phase = rnd() * Math.PI * 2
    const a = (0.12 + rnd() * 0.1) * WOOD_GRAIN_CONTRAST
    const wave = rnd() < 0.38 ? 2.2 + rnd() * 1.8 : 0
    const wavePeriods = 2 + Math.floor(rnd() * 2)
    const wavePhase = rnd() * Math.PI * 2
    ctx.strokeStyle = `rgba(86,50,24,${a})`
    ctx.lineWidth = 2.2 + rnd() * 2.6
    strokeGrainLine(ctx, y0, amp, periods, phase, wave, wavePeriods, wavePhase)
  }

  // figure: wide faint bands with longer waves — veneer sheen variation
  // without turning the tray into the workbench's plank wood
  for (let i = 0; i < 9; i++) {
    const y0 = rnd() * TILE_PX
    const amp = 2.5 + rnd() * 4.5
    const periods = 1 + Math.floor(rnd() * 2)
    const phase = rnd() * Math.PI * 2
    const a = (0.05 + rnd() * 0.04) * WOOD_GRAIN_CONTRAST
    ctx.strokeStyle = `rgba(140,88,42,${a})`
    ctx.lineWidth = 10 + rnd() * 12
    strokeGrainLine(ctx, y0, amp, periods, phase)
  }

  // no knots: two cathedral figures per 100-unit tile printed a knot every
  // ~70 world units across the whole cap — the periodic mark the loop-4
  // critic read as a tile pattern (see WOOD_GRAIN_CONTRAST)

  // the engraved grid at about a THIRD of its old strength (cut 0.85 → 0.3,
  // light catch 0.5 → 0.17): at full strength the cap read as "a parquet of
  // square tiles, each carrying its own grain block" (view3d quality loop 3,
  // workbench-flag.png / workbench-labels.png) and the cut lines competed with
  // the connection tubes. It stays a carved pitch you can find, not a lattice
  // you see first; the slab itself already gives the board its scale.
  //
  // VIEW3D QUALITY LOOP 4: with the grain halved, the 20-unit MINOR lines
  // became the pattern itself — "a fine grid texture across the whole
  // plateau" at the overview (seen by eye in loop4-scene-fix1/
  // workbench-cold.png). Minors drop to half again (cut 0.3 → 0.14, catch 0.17 →
  // 0.08); the 100-unit majors keep their weight (0.45 → 0.4), so the pitch
  // still reads as five-cell squares up close and recedes in the overview.
  //
  // LOOP 4 r3: still read as "an even 20-unit cross-hatch over the whole
  // board" — the minors are drawn only on the DRAG variant (spec.minors,
  // Scene3D swaps maps while a card moves), so at rest the cap is plain
  // wood under the 100-unit majors.
  if (spec.showGrid) {
    const minors = spec.minors !== false
    ctx.strokeStyle = spec.grid
    gridLines(ctx, 1.6, 0.14, 2.4, 0.4, 0, minors)
    ctx.strokeStyle = 'rgb(255,230,190)'
    gridLines(ctx, 1, 0.08, 1.2, 0.17, 1.4, minors)
  }
}

/** The wood roughness tile (WOOD_ROUGH): satin planks, each its own sheen,
 * long seams between the rows and staggered end seams — the plank layout,
 * read by the key light rather than printed in the albedo. Drawn on its own
 * 512 canvas; x runs along the grain. */
function paintWoodRough(ctx: CanvasRenderingContext2D, rnd: () => number): void {
  const { px, spanX, spanZ, plankW, plankL } = WOOD_ROUGH
  const sx = px / spanX // canvas px per world unit along the grain
  const sz = px / spanZ // …and across it
  const rowH = plankW * sz
  const plankPx = plankL * sx
  // satin base ~0.59 (the old tile's), each plank 0.50..0.67 around it
  ctx.fillStyle = 'rgb(150,150,150)'
  ctx.fillRect(0, 0, px, px)
  const rows = Math.round(spanZ / plankW)
  for (let r = 0; r < rows; r++) {
    const y = r * rowH
    // where this row's end seams fall: a random stagger, one seam per plank
    const offset = rnd() * plankPx
    const ends: number[] = []
    for (let x = offset; x < px; x += plankPx) ends.push(x)
    // plank bodies, end to next end; the last one wraps across the tile's
    // x edge, drawn again one tile to the left so RepeatWrapping closes it
    for (let i = 0; i < ends.length; i++) {
      const v = 128 + Math.floor(rnd() * 44)
      ctx.fillStyle = `rgb(${v},${v},${v})`
      const x0 = ends[i]
      const x1 = i + 1 < ends.length ? ends[i + 1] : ends[0] + px
      for (const dx of [0, -px]) ctx.fillRect(x0 + dx, y, x1 - x0, rowH)
    }
    // the long seam under the row: a rough (matte) 1.5-px groove
    ctx.fillStyle = 'rgba(232,232,232,0.85)'
    ctx.fillRect(0, y, px, 1.5)
    // end seams: one matte line across the row at each plank end
    for (const x of ends) ctx.fillRect(x, y, 1, rowH)
    // a few sheen streaks along each row — glossier and rougher, low
    // alpha: grain catching the key, never a printed stripe
    for (let s = 0; s < 6; s++) {
      const v = 105 + Math.floor(rnd() * 110)
      ctx.strokeStyle = `rgba(${v},${v},${v},${0.12 + rnd() * 0.12})`
      ctx.lineWidth = 1 + rnd() * 3
      const yy = y + 3 + rnd() * (rowH - 6)
      ctx.beginPath()
      ctx.moveTo(0, yy)
      ctx.lineTo(px, yy) // level: the x seam must close
      ctx.stroke()
    }
  }
}

// ── museum: matte cool-white speckled lacquer tray ───────────────────────────

function paintMuseumColor(ctx: CanvasRenderingContext2D, rnd: () => number, spec: TraySpec): void {
  // cool porcelain white — a few points colder than the paper board's warm
  // cream so the two presets separate at a glance
  ctx.fillStyle = TRAY_BASE_CSS.museum
  ctx.fillRect(0, 0, TILE_PX, TILE_PX)

  // micro speckle — denser and higher per-fleck contrast than paper tooth so
  // the lacquer fleck survives mipmap averaging at default framing
  for (let i = 0; i < 3200; i++) {
    const x = rnd() * TILE_PX
    const y = rnd() * TILE_PX
    const a = 0.045 + rnd() * 0.075
    ctx.fillStyle = rnd() < 0.55 ? `rgba(84,90,98,${a})` : `rgba(255,255,255,${a})`
    ctx.fillRect(x, y, 1 + rnd() * 1.6, 1 + rnd() * 1.6)
  }

  // terrazzo chips — sized for SCREEN-space legibility at the default iso
  // framing, not texture-space subtlety: 3..7px at alpha 0.15..0.28 is what
  // survives the mipmap chain at wide zoom (a speckled composite, not blank
  // plaster); wrap-drawn so an edge chip continues
  for (let i = 0; i < 260; i++) {
    const x = rnd() * TILE_PX
    const y = rnd() * TILE_PX
    const a = 0.15 + rnd() * 0.13
    const w = 3 + rnd() * 4
    const h = 3 + rnd() * 4
    ctx.fillStyle = rnd() < 0.7 ? `rgba(98,104,112,${a})` : `rgba(148,140,124,${a})`
    wrapped((dx, dy) => ctx.fillRect(x + dx, y + dy, w, h))
  }

  // ~2% near-black flecks: the dark anchor points that make the composite
  // read as terrazzo at framing distance rather than warm paper
  for (let i = 0; i < 56; i++) {
    const x = rnd() * TILE_PX
    const y = rnd() * TILE_PX
    const a = 0.2 + rnd() * 0.12
    ctx.fillStyle = `rgba(44,46,52,${a})`
    ctx.fillRect(x, y, 2 + rnd() * 2.5, 2 + rnd() * 2.5)
  }

  // very low-contrast blotches: soft radial blobs (premultiplied gradient
  // falloff, no ctx.filter — jsdom-safe and deterministic), wrap-drawn
  for (let i = 0; i < 26; i++) {
    const bx = rnd() * TILE_PX
    const by = rnd() * TILE_PX
    const r = 16 + rnd() * 30
    const a = 0.015 + rnd() * 0.022
    const warm = rnd() < 0.6
    const c = warm ? '198,200,196' : '255,254,250'
    wrapped((dx, dy) => {
      const g = ctx.createRadialGradient(bx + dx, by + dy, 0, bx + dx, by + dy, r)
      g.addColorStop(0, `rgba(${c},${a})`)
      g.addColorStop(1, `rgba(${c},0)`)
      ctx.fillStyle = g
      ctx.fillRect(bx + dx - r, by + dy - r, r * 2, r * 2)
    })
  }

  // hairline grid: plain ink pass — lacquer is silkscreened, not carved
  if (spec.showGrid) {
    ctx.strokeStyle = spec.grid
    gridLines(ctx, 1.4, 0.7, 2.2, 0.85, 0, spec.minors !== false)
  }
}

function paintMuseumRough(ctx: CanvasRenderingContext2D, rnd: () => number): void {
  // matte band 0.5..0.65 — never glossy, never paper-rough
  ctx.fillStyle = 'rgb(148,148,148)'
  ctx.fillRect(0, 0, TILE_PX, TILE_PX)
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * TILE_PX
    const y = rnd() * TILE_PX
    const v = 128 + Math.floor(rnd() * 39)
    ctx.fillStyle = `rgb(${v},${v},${v})`
    ctx.fillRect(x, y, 1 + rnd(), 1 + rnd())
  }
  // faint polishing streaks: long shallow strokes, wrap-drawn for the seam
  for (let i = 0; i < 46; i++) {
    const x0 = rnd() * TILE_PX
    const y0 = rnd() * TILE_PX
    const len = 60 + rnd() * 150
    const slope = (rnd() - 0.5) * 0.24
    const v = 130 + Math.floor(rnd() * 22)
    ctx.strokeStyle = `rgba(${v},${v},${v},0.35)`
    ctx.lineWidth = 1 + rnd() * 2
    wrapped((dx, dy) => {
      ctx.beginPath()
      ctx.moveTo(x0 + dx, y0 + dy)
      ctx.lineTo(x0 + dx + len, y0 + dy + len * slope)
      ctx.stroke()
    })
  }
}

// ── clay: burnished terracotta ───────────────────────────────────────────────

function paintClayColor(ctx: CanvasRenderingContext2D, rnd: () => number, spec: TraySpec): void {
  // burnished terracotta — the apron's fired tone, not plaster salmon. The
  // warm key + hemi + ACES lift raises this roughly two value steps on
  // screen, so the paint must sit well BELOW the apron target (#B0603D
  // still rendered pale salmon; this deeper, more saturated base lands
  // within reach of the apron after the lift)
  ctx.fillStyle = TRAY_BASE_CSS.clay
  ctx.fillRect(0, 0, TILE_PX, TILE_PX)

  // kiln mottling: soft warm blobs both ways around the base — alphas ~1.5x
  // the first tune so the variation still breaks the field after the lift
  for (let i = 0; i < 34; i++) {
    const bx = rnd() * TILE_PX
    const by = rnd() * TILE_PX
    const r = 12 + rnd() * 26
    const darker = rnd() < 0.55
    const a = darker ? 0.07 + rnd() * 0.06 : 0.045 + rnd() * 0.04
    const c = darker ? '116,56,28' : '224,148,100'
    wrapped((dx, dy) => {
      const g = ctx.createRadialGradient(bx + dx, by + dy, 0, bx + dx, by + dy, r)
      g.addColorStop(0, `rgba(${c},${a})`)
      g.addColorStop(1, `rgba(${c},0)`)
      ctx.fillStyle = g
      ctx.fillRect(bx + dx - r, by + dy - r, r * 2, r * 2)
    })
  }

  // sponge mottle: dense small dark dabs, low per-dab contrast — the fired
  // surface read (plaster is even; terracotta is not)
  for (let i = 0; i < 90; i++) {
    const bx = rnd() * TILE_PX
    const by = rnd() * TILE_PX
    const r = 4 + rnd() * 9
    const a = 0.05 + rnd() * 0.05
    wrapped((dx, dy) => {
      const g = ctx.createRadialGradient(bx + dx, by + dy, 0, bx + dx, by + dy, r)
      g.addColorStop(0, `rgba(118,54,28,${a})`)
      g.addColorStop(1, 'rgba(118,54,28,0)')
      ctx.fillStyle = g
      ctx.fillRect(bx + dx - r, by + dy - r, r * 2, r * 2)
    })
  }

  // fine grog speckle
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * TILE_PX
    const y = rnd() * TILE_PX
    const a = 0.02 + rnd() * 0.04
    ctx.fillStyle = rnd() < 0.5 ? `rgba(70,32,16,${a})` : `rgba(240,186,142,${a})`
    ctx.fillRect(x, y, 1 + rnd() * 1.3, 1 + rnd() * 1.3)
  }

  // per-tile rim vignette — edge-SYMMETRIC so it tiles seamlessly: repeated,
  // it reads as a soft kiln-shadow web at the 100-unit major pitch, never as
  // a seam (an off-center vignette would break RepeatWrapping)
  const g = ctx.createRadialGradient(
    TILE_PX / 2,
    TILE_PX / 2,
    TILE_PX * 0.3,
    TILE_PX / 2,
    TILE_PX / 2,
    TILE_PX * 0.72,
  )
  g.addColorStop(0, 'rgba(96,46,24,0)')
  g.addColorStop(0.6, 'rgba(96,46,24,0.045)')
  g.addColorStop(1, 'rgba(96,46,24,0.11)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, TILE_PX, TILE_PX)

  // embossed grid: darker line + light catch, same engraving read as wood —
  // cut alpha up vs the old pale base: the ink sits closer to fired terracotta
  if (spec.showGrid) engravedGrid(ctx, spec.grid, 'rgb(240,198,162)', 1.7, 0.8, 0.45, spec.minors !== false)
}

function paintClayRough(ctx: CanvasRenderingContext2D, rnd: () => number): void {
  // burnished: mid base with fingerprint-scale gloss/matte smudges — the
  // polish reads handworked, not uniform
  ctx.fillStyle = 'rgb(168,168,168)'
  ctx.fillRect(0, 0, TILE_PX, TILE_PX)
  for (let i = 0; i < 240; i++) {
    const bx = rnd() * TILE_PX
    const by = rnd() * TILE_PX
    const rx = 3 + rnd() * 8
    const ry = rx * (0.45 + rnd() * 0.55)
    const rot = rnd() * Math.PI
    const v = 120 + Math.floor(rnd() * 80)
    ctx.fillStyle = `rgba(${v},${v},${v},0.32)`
    wrapped((dx, dy) => {
      ctx.beginPath()
      ctx.ellipse(bx + dx, by + dy, rx, ry, rot, 0, Math.PI * 2)
      ctx.fill()
    })
  }
}

// ── build + public surface ───────────────────────────────────────────────────

type ColorPainter = (ctx: CanvasRenderingContext2D, rnd: () => number, spec: TraySpec) => void
type RoughPainter = (ctx: CanvasRenderingContext2D, rnd: () => number) => void

const COLOR_PAINTERS: Record<TrayVariant, ColorPainter> = {
  wood: paintWoodColor,
  museum: paintMuseumColor,
  clay: paintClayColor,
}
const ROUGH_PAINTERS: Record<TrayVariant, RoughPainter> = {
  wood: paintWoodRough,
  museum: paintMuseumRough,
  clay: paintClayRough,
}

function build(variant: TrayVariant, spec: TraySpec): TrayBoardTextures {
  // minors only matter with the grid on: the off maps stay one instance
  const key = `${variant}|${spec.grid}|${spec.showGrid}|${spec.showGrid && spec.minors !== false}`
  const hit = pairCache.get(key)
  if (hit) return hit

  const color = tile()
  COLOR_PAINTERS[variant](color.ctx, lcg(SEEDS[variant]), spec)

  // grid-independent roughness, built once per variant (see module doc)
  let rough = roughCache.get(variant)
  if (!rough) {
    // the wood planks span far more than the 100-unit grid tile (WOOD_ROUGH)
    const plank = variant === 'wood'
    const r = tile(plank ? WOOD_ROUGH.px : TILE_PX)
    ROUGH_PAINTERS[variant](r.ctx, lcg(SEEDS[variant] ^ 0x9e3779b9))
    rough = plank
      ? mkTexture(r.canvas, false, { x: WOOD_ROUGH.spanX, z: WOOD_ROUGH.spanZ })
      : mkTexture(r.canvas, false)
    roughCache.set(variant, rough)
  }

  const out: TrayBoardTextures = { map: mkTexture(color.canvas, true), roughnessMap: rough }
  pairCache.set(key, out)
  return out
}

export function woodTrayTextures(spec: TraySpec): TrayBoardTextures {
  return build('wood', spec)
}

export function museumTrayTextures(spec: TraySpec): TrayBoardTextures {
  return build('museum', spec)
}

export function clayTrayTextures(spec: TraySpec): TrayBoardTextures {
  return build('clay', spec)
}

/** Variant-keyed dispatcher — buildFloor picks by the board-surface setting. */
export function trayTexturesFor(variant: TrayVariant, spec: TraySpec): TrayBoardTextures {
  return build(variant, spec)
}

/** Drop every cached tray texture (theme flips / scene dispose). */
export function disposeBoardTextures(): void {
  for (const [, t] of pairCache) t.map.dispose()
  for (const [, t] of roughCache) t.dispose()
  pairCache.clear()
  roughCache.clear()
}
