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

export interface TraySpec {
  /** Grid line color (css) — ignored when showGrid is false. */
  grid: string
  /** Draw the pitch grid? (the board's grid toggle swaps color maps). */
  showGrid: boolean
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

function tile(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = TILE_PX
  canvas.height = TILE_PX
  return { canvas, ctx: canvas.getContext('2d')! }
}

/** Texture params copied verbatim from paper.ts — same cap mesh, same raw
 * world-px extrude UVs, so the FIXED repeat keeps the pitch exact and the
 * cached textures are safely shared across scenes. */
function mkTexture(c: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 16
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.repeat.setScalar(1 / (PAPER_PITCH * PAPER_TILE_CELLS))
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
): void {
  ctx.globalAlpha = alpha
  ctx.lineWidth = width
  for (let c = 0; c < PAPER_TILE_CELLS; c++) {
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
): void {
  ctx.strokeStyle = cut
  gridLines(ctx, cutWidth, cutAlpha, cutWidth + 0.8, Math.min(1, cutAlpha + 0.15))
  ctx.strokeStyle = lightCatch
  gridLines(ctx, 1, catchAlpha, 1.2, catchAlpha, 1.4)
}

// ── wood: honey veneer with visible grain figure, engraved desk ──────────────

function paintWoodColor(ctx: CanvasRenderingContext2D, rnd: () => number, spec: TraySpec): void {
  ctx.fillStyle = '#CB9C5C'
  ctx.fillRect(0, 0, TILE_PX, TILE_PX)

  // tight straight grain: many low-amplitude streaks along x — dark latewood
  // clearly outnumbering pale earlywood, alphas high enough to survive
  // mipmap averaging at default zoom (the tan-laminate fix)
  // ~a third of the streaks additionally WANDER on a low-frequency wave
  // (period ≈ a third of the tile, amplitude 2..4px) so the field clusters
  // and crosses itself instead of reading as evenly-spaced printed stripes
  const streaks = 150
  for (let i = 0; i < streaks; i++) {
    const y0 = rnd() * TILE_PX
    const amp = 0.5 + rnd() * 1.8
    const periods = 1 + Math.floor(rnd() * 4)
    const phase = rnd() * Math.PI * 2
    const width = 0.8 + rnd() * 1.8
    const dark = rnd() < 0.62
    const a = 0.09 + rnd() * 0.11
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
    const a = 0.12 + rnd() * 0.1
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
    const a = 0.05 + rnd() * 0.04
    ctx.strokeStyle = `rgba(140,88,42,${a})`
    ctx.lineWidth = 10 + rnd() * 12
    strokeGrainLine(ctx, y0, amp, periods, phase)
  }

  // knot / cathedral figures: two nested-ellipse figures per tile, elongated
  // along the grain — the local event that breaks the streak period (sawn
  // figure clusters around knots); wrap-drawn so an edge-crossing knot
  // continues on the opposite side
  for (let k = 0; k < 2; k++) {
    const kx = rnd() * TILE_PX
    const ky = rnd() * TILE_PX
    const rot = (rnd() - 0.5) * 0.35
    const rings = 4 + Math.floor(rnd() * 3)
    const rx0 = 6 + rnd() * 5
    const grow = 5 + rnd() * 4
    for (let ring = 0; ring < rings; ring++) {
      const rx = rx0 + ring * grow
      const ry = rx * (0.32 + rnd() * 0.1)
      const a = (0.14 - ring * 0.018) * (0.85 + rnd() * 0.3)
      ctx.strokeStyle = `rgba(96,54,26,${a})`
      ctx.lineWidth = 1.4 + rnd() * 1.6
      wrapped((dx, dy) => {
        ctx.beginPath()
        ctx.ellipse(kx + dx, ky + dy, rx, ry, rot, 0, Math.PI * 2)
        ctx.stroke()
      })
    }
    // dark heartwood core
    ctx.fillStyle = 'rgba(70,38,18,0.28)'
    wrapped((dx, dy) => {
      ctx.beginPath()
      ctx.ellipse(kx + dx, ky + dy, rx0 * 0.55, rx0 * 0.3, rot, 0, Math.PI * 2)
      ctx.fill()
    })
  }

  if (spec.showGrid) engravedGrid(ctx, spec.grid, 'rgb(255,230,190)', 1.6, 0.85, 0.5)
}

function paintWoodRough(ctx: CanvasRenderingContext2D, rnd: () => number): void {
  // satin base ~0.59 with 0.37..0.82 streaks along the grain — the key light
  // picks up brushed-sheen bands, an anisotropic-look read
  ctx.fillStyle = 'rgb(150,150,150)'
  ctx.fillRect(0, 0, TILE_PX, TILE_PX)
  // broad sheen bands first: wide smooth/rough alternation so the satin
  // variation survives mipmapping where 1px streaks average away
  for (let i = 0; i < 12; i++) {
    const y0 = rnd() * TILE_PX
    const v = 112 + Math.floor(rnd() * 76)
    ctx.strokeStyle = `rgba(${v},${v},${v},0.3)`
    ctx.lineWidth = 8 + rnd() * 14
    strokeGrainLine(ctx, y0, 1.5 + rnd() * 3, 1 + Math.floor(rnd() * 2), rnd() * Math.PI * 2)
  }
  for (let i = 0; i < 150; i++) {
    const y0 = rnd() * TILE_PX
    const v = 95 + Math.floor(rnd() * 115)
    const a = 0.4 + rnd() * 0.35
    ctx.strokeStyle = `rgba(${v},${v},${v},${a})`
    ctx.lineWidth = 1 + rnd() * 3.5
    strokeGrainLine(ctx, y0, 0.4 + rnd() * 1.4, 1 + Math.floor(rnd() * 3), rnd() * Math.PI * 2)
  }
}

// ── museum: matte cool-white speckled lacquer tray ───────────────────────────

function paintMuseumColor(ctx: CanvasRenderingContext2D, rnd: () => number, spec: TraySpec): void {
  // cool porcelain white — a few points colder than the paper board's warm
  // cream so the two presets separate at a glance
  ctx.fillStyle = '#F0F2F2'
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
    gridLines(ctx, 1.4, 0.7, 2.2, 0.85)
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
  ctx.fillStyle = '#9A4E2E'
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
  // higher cut alpha than on a pale base: the ink sits closer to fired terracotta
  if (spec.showGrid) engravedGrid(ctx, spec.grid, 'rgb(240,198,162)', 1.7, 0.8, 0.45)
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
  const key = `${variant}|${spec.grid}|${spec.showGrid}`
  const hit = pairCache.get(key)
  if (hit) return hit

  const color = tile()
  COLOR_PAINTERS[variant](color.ctx, lcg(SEEDS[variant]), spec)

  // grid-independent roughness, built once per variant (see module doc)
  let rough = roughCache.get(variant)
  if (!rough) {
    const r = tile()
    ROUGH_PAINTERS[variant](r.ctx, lcg(SEEDS[variant] ^ 0x9e3779b9))
    rough = mkTexture(r.canvas, false)
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
