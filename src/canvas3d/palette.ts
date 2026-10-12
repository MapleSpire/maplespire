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
 * 3D board colors — CSS `color-mix` equivalents + the resolved palette.
 *
 * The design's depth cues are PRE-MIXED colors (editor3d.css mixes toward the
 * warm stone poles), not dynamic lights — so the WebGL scene uses unlit
 * materials fed by these exact mixes and renders the token hex as that hex.
 *
 * `skin.three` overrides win; everything else derives from the active skin so
 * every theme (including dark ones) gets a coherent board with zero 3D config.
 * Derivation rules are kept identical to the axonometric spike's
 * `resolve3dPalette` so the two implementations agree on the default look.
 */

import type { SkinConfig, SkinThreeConfig } from '../skins/types'
import { FALLBACK_TECH_COLORS } from '../canvas/bottomBarColors'

// Warm-stone poles the design mixes walls/shadows from (stone-600 / stone-700).
const STONE_DARK = '#57534E'
const STONE_DARKER = '#44403C'

// ── color math (color-mix equivalent) ────────────────────────────────────────

export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

export function parseColor(value: string): RGBA | null {
  const v = value.trim()
  if (v.startsWith('#')) {
    const hex = v.slice(1)
    const n = (s: string) => parseInt(s, 16)
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = hex.split('').map((c) => n(c + c))
      return { r, g, b, a: hex.length === 4 ? a / 255 : 1 }
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: n(hex.slice(0, 2)),
        g: n(hex.slice(2, 4)),
        b: n(hex.slice(4, 6)),
        a: hex.length === 8 ? n(hex.slice(6, 8)) / 255 : 1,
      }
    }
    return null
  }
  const m = v.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i)
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
    return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a }
  }
  return null
}

export function rgbaStr(c: RGBA, alphaMul = 1): string {
  const a = Math.max(0, Math.min(1, c.a * alphaMul))
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+a.toFixed(3)})`
}

/** Mix `a` toward `b` by t (0 → a, 1 → b) in sRGB — the CSS `color-mix(in srgb)`
 * the kit uses. Falls back gracefully on unparseable input. */
export function mixColors(a: string, b: string, t: number): string {
  const ca = parseColor(a)
  const cb = parseColor(b)
  if (!ca || !cb) return t < 0.5 ? a : b
  return rgbaStr({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
    a: ca.a + (cb.a - ca.a) * t,
  })
}

export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color)
  if (!c) return color
  return rgbaStr({ ...c, a: alpha })
}

export function isDark(color: string): boolean {
  const c = parseColor(color)
  if (!c) return false
  return (c.r * 299 + c.g * 587 + c.b * 114) / 1000 < 128
}

/** Split a css color into an opaque color string + alpha (three materials take
 * color and opacity separately). */
export function colorAlpha(css: string): { color: string; alpha: number } {
  const c = parseColor(css)
  if (!c) return { color: css, alpha: 1 }
  return { color: rgbaStr({ ...c, a: 1 }), alpha: c.a }
}

// ── palette ──────────────────────────────────────────────────────────────────

/** All 3D colors resolved to concrete strings: `skin.three` overrides win, the
 * rest derives from the existing skin so EVERY theme gets a coherent board for
 * free (dark themes derive dark boards — skins are already appearance-resolved). */
export interface Palette3d {
  wallFrontOverride: string | null
  wallSideOverride: string | null
  wallSelected: string
  wallMixPole: string
  floorBg: string
  floorGrid: string
  floorBorder: string
  floorInsetRing: string
  floorWallFront: string
  floorWallSide: string
  shadowColor: string
  platformFill: string
  platformStroke: string
  padFill: string
  padBorder: string
  tagBg: string
  tagText: string
  standeeLight: string
  standeeDark: string
  dark: boolean
}

const paletteCache = new WeakMap<SkinConfig, Palette3d>()

export function resolve3dPalette(skin: SkinConfig): Palette3d {
  const cached = paletteCache.get(skin)
  if (cached) return cached
  const three: SkinThreeConfig = skin.three ?? {}
  const dark = isDark(skin.canvas.bg)
  const surface = skin.connections.labelBg // closest "surface" the skin exposes
  const fgPole = dark ? '#F5F5F4' : STONE_DARKER

  const floorBg = three.floorBg ?? mixColors(skin.canvas.bg, dark ? '#FFFFFF' : STONE_DARK, dark ? 0.07 : 0.06)
  const palette: Palette3d = {
    wallFrontOverride: three.wallFront ?? null,
    wallSideOverride: three.wallSide ?? null,
    wallSelected: three.wallSelected ?? skin.selection.stroke,
    wallMixPole: dark ? '#0C0A09' : STONE_DARK,
    floorBg,
    floorGrid: three.floorGrid ?? mixColors(skin.canvas.grid, fgPole, 0.25),
    floorBorder: three.floorBorder ?? mixColors(floorBg, fgPole, dark ? 0.22 : 0.18),
    floorInsetRing: withAlpha(mixColors(floorBg, '#FFFFFF', 0.5), dark ? 0.06 : 0.35),
    floorWallFront: mixColors(skin.canvas.bg, dark ? '#000000' : STONE_DARKER, 0.45),
    floorWallSide: mixColors(skin.canvas.bg, dark ? '#000000' : STONE_DARKER, 0.32),
    shadowColor: three.shadowColor ?? (dark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(30, 24, 16, 0.32)'),
    platformFill: three.platformFill ?? withAlpha(mixColors(surface, floorBg, 0.4), dark ? 0.5 : 0.55),
    platformStroke: three.platformStroke ?? mixColors(floorBg, fgPole, dark ? 0.3 : 0.24),
    padFill: three.padFill ?? withAlpha(surface, dark ? 0.6 : 0.72),
    padBorder: three.padBorder ?? mixColors(floorBg, fgPole, dark ? 0.28 : 0.22),
    tagBg: three.tagBg ?? surface,
    tagText: three.tagText ?? skin.connections.labelText,
    standeeLight: three.standeeLight ?? mixColors(surface, STONE_DARK, dark ? 0.25 : 0.02),
    standeeDark: three.standeeDark ?? mixColors(surface, dark ? '#000000' : STONE_DARK, dark ? 0.55 : 0.42),
    dark,
  }
  paletteCache.set(skin, palette)
  return palette
}

/** Wall colors for one node: theme override, else derived from the node's fill —
 * the kit's `color-mix(surface 55%/70%, stone-600)` generalized to any skin.
 * `mixScale` is the environment's wallMix shading modifier (1 = kit look,
 * clamped upstream so the mix strengths stay inside [0, 0.9]). */
export function nodeWallColors(
  palette: Palette3d,
  fill: string,
  selected: boolean,
  mixScale = 1,
): { front: string; side: string } {
  let front = palette.wallFrontOverride ?? mixColors(fill, palette.wallMixPole, Math.min(0.9, 0.48 * mixScale))
  let side = palette.wallSideOverride ?? mixColors(fill, palette.wallMixPole, Math.min(0.9, 0.34 * mixScale))
  if (selected) {
    front = mixColors(front, palette.wallSelected, 0.32)
    side = mixColors(side, palette.wallSelected, 0.24)
  }
  return { front, side }
}

/** The kit's drum face shading law: brightness factor for a face at angle θ
 * (degrees around the drum, decal side = 120°): p = 58% light + 40%·cos-falloff.
 * Returns the mixed face color between the palette's standee poles.
 * `contrast` is the environment's drumContrast modifier (1 = kit law). */
export function drumFaceColor(palette: Palette3d, thetaDeg: number, contrast = 1): string {
  const b = Math.max(0, Math.cos(((thetaDeg - 120) * Math.PI) / 180))
  const p = Math.max(0, Math.min(1, (58 + 40 * contrast * b) / 100))
  return mixColors(palette.standeeDark, palette.standeeLight, p)
}

// ── tech colors (pills / bars / drum lids) ───────────────────────────────────

/** Resolve a technology's accent color: skin map → brand fallback → null.
 * (Fallbacks come from the shared bottom-bar module — one source of truth.) */
export function techColor(skin: SkinConfig, techName: string | undefined): string | null {
  if (!techName) return null
  return skin.bottomBar.technology[techName] ?? FALLBACK_TECH_COLORS[techName] ?? null
}

/** Readable text color on a (possibly vivid) pill background. */
export function readableOn(bg: string, darkText: string, lightText: string): string {
  return isDark(bg) ? lightText : darkText
}
