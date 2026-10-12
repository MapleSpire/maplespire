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
 * Theme-driven colors for the connection focus animation
 * (`CanvasEngine.renderConnectionHighlightEffect`). Historically every animation
 * style hard-coded the same blue, so the effect looked identical under every
 * skin. Now each style resolves its color from the active theme:
 *
 *   - the "blue-family" styles (traveling-dot, gradient-flow, lightning, pulse,
 *     sparkle, energy-beam, neon-dash) read `color` (base) + `highlight` (bright
 *     core tint);
 *   - the woven `strands` style reads the `strands` palette.
 *
 * Resolution order (see {@link resolveConnectionAnimation}):
 *   1. an explicit `skin.connectionAnimation` override (community/custom themes),
 *   2. the built-in per-theme palette below (keyed by `skin.id`, shared by a
 *      skin's light + dark variants — same id),
 *   3. the classic-blue default.
 *
 * Everything falls back to the classic blue, so a theme that says nothing keeps
 * today's look.
 */

export interface ConnectionAnimationColors {
  /** Base accent for the blue-family styles. Default `#3B82F6`. */
  color?: string
  /** Bright tint for cores / leading highlights. Default `#93C5FD`. */
  highlight?: string
  /** Palette woven through the `strands` style. Default {@link STRANDS_DEFAULT_COLORS}. */
  strands?: string[]
  /** Colour of the `electric` style's arc. Default `#7DF9FF` (electric cyan). */
  electric?: string
}

export interface ResolvedConnectionAnimation {
  color: string
  highlight: string
  strands: string[]
  electric: string
}

/** The strands palette a theme inherits when it doesn't ship its own. */
export const STRANDS_DEFAULT_COLORS = ['#FF4242', '#7C3AED', '#06B6D4', '#EAB308']

/** The classic-blue look every style used before it became themeable. */
const CLASSIC_BLUE: ResolvedConnectionAnimation = {
  color: '#3B82F6',
  highlight: '#93C5FD',
  strands: STRANDS_DEFAULT_COLORS,
  electric: '#7DF9FF',
}

/*
 * Per-theme palettes for the built-in skins. Each palette is EXPORTED and set as
 * the matching skin's `connectionAnimation`, so the plugin theme itself provides
 * the color that every animation style (traveling-dot, pulse, …, strands) uses —
 * change a theme's palette here and all of its styles re-tint. A skin that ships
 * no `connectionAnimation` (community / custom) inherits the classic blue.
 */

/** Clean — warm stone + clay-coral: coral / amber / terracotta / soft periwinkle,
 *  pulled from the theme's own accent + system-icon hues (the vivid rainbow default
 *  clashes with the calm warm palette). */
export const CLEAN_ANIM: ConnectionAnimationColors = {
  color: '#D97A3D',
  highlight: '#E7B98A',
  strands: ['#D9743C', '#E0A63E', '#CE6A57', '#6F86CF'],
  electric: '#E8944A', // warm electric to match the clay-coral theme
}
/** Slate / Blueprint — cool blues + violets (the theme's accent + app-icon violet). */
export const SLATE_ANIM: ConnectionAnimationColors = {
  color: '#3B82F6',
  highlight: '#C4B5FD',
  strands: ['#3B82F6', '#7C3AED', '#38BDF8', '#A78BFA'],
  electric: '#67E8F9',
}
/** Neon City — the theme's exact neon trio (red / cyan / yellow) + a hot magenta. */
export const CYBERPUNK_ANIM: ConnectionAnimationColors = {
  color: '#00F0FF',
  highlight: '#FCEE0A',
  strands: ['#FF003C', '#00F0FF', '#FCEE0A', '#FF2CF1'],
  electric: '#00F0FF', // the theme's own neon cyan
}
/** 8-Bit Retro — the NES quartet the theme paints its objects with. */
export const EIGHTBIT_ANIM: ConnectionAnimationColors = {
  color: '#0058F8',
  highlight: '#3CBCFC',
  strands: ['#E4000F', '#0058F8', '#00A800', '#F8B800'],
  electric: '#3CBCFC', // NES light blue
}
/** Street Sketch — a monochrome skin, so lean into the graffiti idea with vivid
 *  spray-can colors. */
export const GRAFFITI_ANIM: ConnectionAnimationColors = {
  color: '#FF2E97',
  highlight: '#FDE047',
  strands: ['#FF2E97', '#22D3EE', '#FFD43B', '#7C4DFF'],
  electric: '#39F5C8', // electric spray teal
}

/**
 * Resolve the effective animation colors a skin provides, filling every field from
 * the classic-blue default. The color comes straight from the theme's own
 * `connectionAnimation` (set on the built-in skins above); a theme that provides
 * nothing inherits the blue default.
 */
export function resolveConnectionAnimation(
  skin: { connectionAnimation?: ConnectionAnimationColors },
): ResolvedConnectionAnimation {
  const themed = skin.connectionAnimation
  if (!themed) return CLASSIC_BLUE
  return {
    color: themed.color ?? CLASSIC_BLUE.color,
    highlight: themed.highlight ?? CLASSIC_BLUE.highlight,
    strands: themed.strands && themed.strands.length > 0 ? themed.strands : CLASSIC_BLUE.strands,
    electric: themed.electric ?? CLASSIC_BLUE.electric,
  }
}

export interface StrandsOptions {
  /** Point on the path at global t ∈ [0,1]. */
  pointAt: (t: number) => { x: number; y: number }
  /** Unit tangent on the path at global t ∈ [0,1]. */
  tangentAt: (t: number) => { x: number; y: number }
  /** Palette wound around the rope (cycled if shorter than `count`). */
  colors: string[]
  /** Monotonic timestamp in ms — drives the rotation. */
  timeMs: number
  /** Number of strands wound around the axis. Default 3. */
  count?: number
  /** Radius of the rope — how far strands swing off the axis, in px. Default 8. */
  radius?: number
  /** Full twists of the helix along the whole path. Default 1.6. */
  twist?: number
  /** Rotation speed (radians/ms scale). Default 0.0022. */
  speed?: number
  /** Core line width in px (front strand; back strands thin out). Default 1.8. */
  thickness?: number
  /** Bloom radius at the front crest. Default 10. */
  glow?: number
  /** Polyline resolution along the path. Default 34. */
  samples?: number
  /** Taper exponent — how sharply the rope pinches to a point at both ends. Default 1.2. */
  taper?: number
  /** Static perpendicular fan between strands (adds to the helical swing). Default 0. */
  spread?: number
  /** Overall brightness/energy 0..~1.5 (multiplies stroke alpha via 0.3+intensity).
   *  Omit to leave alphas at full strength. */
  intensity?: number
  /**
   * Additive ('lighter') compositing. On a dark canvas this makes overlaps bloom
   * toward white (the vivid, saturated look); on a light canvas leave it off — the
   * renderer then whitens the front cores instead so they still read as glowing.
   */
  additive?: boolean
  /**
   * Draw a bright central strand running straight along the path — the connection
   * line itself, energized — so the effect *includes* the line the strands wrap,
   * instead of floating beside a separate plain stroke. Default false.
   */
  spine?: boolean
}

/**
 * Rough perceived-luminance test for a `#RRGGBB` / `#RGB` color: true when it's a
 * dark background (so callers can pick additive blending). Non-hex → false.
 */
export function isDarkColor(hex: string): boolean {
  if (typeof hex !== 'string') return false
  let h = hex.trim()
  if (h[0] === '#') h = h.slice(1)
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return false
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  // Rec.601 luma, 0..255. < ~40% reads as a dark surface.
  return (0.299 * r + 0.587 * g + 0.114 * b) < 100
}

/** Blend a `#RRGGBB` toward white by `amt` (0..1); pass-through for anything else. */
function lighten(hex: string, amt: number): string {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16)
    return Math.round(c + (255 - c) * amt).toString(16).padStart(2, '0')
  }
  return `#${ch(1)}${ch(3)}${ch(5)}`
}

/**
 * Draw the `strands` connection animation: a rope of luminous strands helically
 * wound around the connection path. Each strand orbits the axis (angle grows with
 * distance along the path — the `twist` — and with time — the rotation), so it
 * swings from the front of the rope to the back and around. Segments are painted
 * back-to-front (painter's algorithm on the orbit depth `cos θ`), so a strand
 * passing in front genuinely occludes the ones behind and the over/under weave
 * changes as the rope turns. Depth also drives width, brightness and glow, so the
 * bloom concentrates on whichever crest is nearest the viewer.
 *
 * Extracted from the engine so it can be exercised in isolation (unit tests and a
 * standalone canvas) against any path sampler, not just a live ConnectionGeometry.
 */
export function drawStrands(ctx: CanvasRenderingContext2D, opts: StrandsOptions): void {
  const { pointAt, tangentAt, colors, timeMs } = opts
  if (!colors || colors.length === 0) return
  const TAU = Math.PI * 2
  const COUNT = Math.min(opts.count ?? 3, colors.length)
  const RADIUS = opts.radius ?? 10
  const TWIST = opts.twist ?? 1.6
  const SPEED = opts.speed ?? 0.0022
  const THICKNESS = opts.thickness ?? 2.6
  const GLOW = opts.glow ?? 10
  const SAMPLES = opts.samples ?? 34
  const TAPER = opts.taper ?? 1.2
  const SPREAD = opts.spread ?? 0
  const additive = !!opts.additive
  // intensity → alpha multiplier (matches the demo's 0.3 + intensity). Omitted → 1.
  const alphaMul = opts.intensity != null ? Math.max(0, Math.min(1.5, 0.3 + opts.intensity)) : 1
  // `flow` only feeds a 2π-periodic sin/cos with a unit coefficient, so wrapping it
  // to [0, 2π) is exact and keeps the argument small (timeMs is a Date.now() epoch).
  const flow = (timeMs * SPEED) % TAU

  // Sample every strand as a polyline of points tagged with orbit depth.
  interface Pt { x: number; y: number; depth: number; env: number }
  const strands: { color: string; pts: Pt[]; avgDepth: number }[] = []
  for (let s = 0; s < COUNT; s++) {
    const color = colors[s % colors.length]
    const phase = (s / COUNT) * TAU
    const fan = (s - (COUNT - 1) / 2) * SPREAD * RADIUS   // static perpendicular fan
    const pts: Pt[] = []
    let depthSum = 0
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES
      const p = pointAt(t)
      const tan = tangentAt(t)
      const nx = -tan.y                                 // unit perpendicular
      const ny = tan.x
      const env = Math.pow(Math.sin(t * Math.PI), TAPER) // rope pinches → 0 at ends
      const ang = phase + t * TWIST * TAU - flow
      const lateral = (Math.sin(ang) * RADIUS + fan) * env // swing off the axis + fan
      const depth = Math.cos(ang)                        // +1 front … −1 back
      pts.push({ x: p.x + nx * lateral, y: p.y + ny * lateral, depth, env })
      depthSum += depth
    }
    strands.push({ color, pts, avgDepth: depthSum / pts.length })
  }

  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (additive) ctx.globalCompositeOperation = 'lighter'

  // Trace a polyline as ONE smooth quadratic curve through its midpoints. Being a
  // single continuous stroke (not a chain of short segments), it has no facets and
  // — crucially — no beading where segments would otherwise stack at the joints.
  const trace = (pts: { x: number; y: number }[]) => {
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2)
    }
    const n = pts.length
    ctx.quadraticCurveTo(pts[n - 2].x, pts[n - 2].y, pts[n - 1].x, pts[n - 1].y)
  }
  // A stroke gradient that fades both ends of a strand to transparent along its own
  // direction — an even, soft glow down the whole strand (works for any orientation:
  // vertical, diagonal, curved).
  const fade = (pts: { x: number; y: number }[], color: string, alpha: number) => {
    const a = pts[0], b = pts[pts.length - 1]
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
    g.addColorStop(0, hexToRgba(color, 0))
    g.addColorStop(0.14, hexToRgba(color, alpha))
    g.addColorStop(0.86, hexToRgba(color, alpha))
    g.addColorStop(1, hexToRgba(color, 0))
    return g
  }

  // Spine — the connection line itself, energized, drawn UNDER the weave so the
  // strands wrap it. This is what makes the effect *include* the line.
  if (opts.spine) {
    const sc = colors[0]
    const sp: { x: number; y: number }[] = []
    for (let i = 0; i <= SAMPLES; i++) { const p = pointAt(i / SAMPLES); sp.push({ x: p.x, y: p.y }) }
    trace(sp)
    ctx.shadowColor = sc
    ctx.shadowBlur = GLOW * 1.1
    ctx.strokeStyle = fade(sp, sc, (additive ? 0.34 : 0.44) * alphaMul)
    ctx.lineWidth = THICKNESS * 2.0
    ctx.stroke()
    ctx.shadowBlur = additive ? 0 : GLOW * 0.3
    ctx.strokeStyle = fade(sp, lighten(sc, additive ? 0.6 : 0.35), 0.9 * alphaMul)
    ctx.lineWidth = THICKNESS * 0.85
    ctx.stroke()
  }

  // Strands — each a single continuous stroke, re-stroked in three widths for a
  // soft, even diffuse glow (broad halo → mid → soft core). Layered back-to-front by
  // mean orbit depth so they still cross over/under as the rope turns, with no
  // per-segment seams. On a dark canvas the core whitens and additive blending
  // blooms the overlaps; on a light canvas the hue stays saturated so it reads.
  for (const strand of [...strands].sort((a, b) => a.avgDepth - b.avgDepth)) {
    const front = (strand.avgDepth + 1) / 2
    const dA = 0.5 + 0.5 * front            // front strands a touch brighter
    const col = strand.color
    const coreCol = additive ? lighten(col, 0.5 * front) : col
    trace(strand.pts)
    ctx.shadowColor = col
    ctx.shadowBlur = GLOW * 2.2
    ctx.strokeStyle = fade(strand.pts, col, (additive ? 0.13 : 0.11) * dA * alphaMul)
    ctx.lineWidth = THICKNESS * 5.5
    ctx.stroke()
    ctx.shadowBlur = GLOW * 1.2
    ctx.strokeStyle = fade(strand.pts, col, (additive ? 0.28 : 0.26) * dA * alphaMul)
    ctx.lineWidth = THICKNESS * 2.6
    ctx.stroke()
    ctx.shadowBlur = additive ? GLOW * 0.4 : GLOW * 0.5
    ctx.strokeStyle = fade(strand.pts, coreCol, (additive ? 0.95 : 0.9) * dA * alphaMul)
    ctx.lineWidth = THICKNESS * 1.1
    ctx.stroke()
  }

  ctx.restore()
}

/**
 * `#RGB` / `#RRGGBB` → `rgba(r, g, b, a)`. Non-hex input (already-rgba strings,
 * named colors) is returned unchanged so callers can pass a palette entry blind.
 */
export function hexToRgba(hex: string, alpha: number): string {
  if (typeof hex !== 'string') return `rgba(0, 0, 0, ${alpha})`
  let h = hex.trim()
  if (h[0] === '#') h = h.slice(1)
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return hex
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
