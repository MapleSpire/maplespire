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
 * The LIT profile's connection line: "Clean, inked" (user round 2026-10-12:
 * "Remet les lignes connections comme le theme Clean … un peu plus
 * visible"). The cable tubes, cones and chevrons are gone; a connection is
 * Clean's flat ribbon on the 2D route with the 2D engine's flat triangular
 * arrowhead, drawn in a warm near-black INK so it reads on the honey-wood
 * board, with a thin cream HALO (casing) that separates it from the grain
 * and the dark card plinths. Coloured lines (the highlight, perspective
 * colours) trade the halo for a thin ink RIM.
 *
 * Why the colours differ from Clean's (design spec measurement, tp9-final-
 * dpr1 PNGs, DPR 1, WCAG relative luminance): the lit honey wood averages
 * #D19B5D (L ≈ 0.38); Clean's stroke #C9C3BA reads 1.40:1 on it, Studio's 2D
 * #B7B1A8 1.15:1 and the coral highlight 1.26:1. The ink #3A362F
 * (--stone-900) reads 4.92:1 on lit wood and 11.7:1 on the cards. The
 * numbers in `inkSetFor`'s test are computed from the hex values below with
 * the WCAG formula (palette.contrastRatio), not measured on pixels.
 *
 * The widths hold a PROJECTED floor in the vertex shader (INK_VERTEX_BODY):
 * the old fixed-world-width lines thinned to hairlines at far and low
 * framings. `stripFacing`, `stripHalfWidth` / `stripCoreWidthPx` and
 * `headFit` are the CPU mirror of that shader math — the
 * probe, the label passes and the screen-space pick use them, and the unit
 * tests pin them — so the GLSL below and these functions change together.
 */

import * as THREE from 'three'
import { contrastRatio } from './palette'

/** The dark ink, for a board whose base is light (honey wood, paper,
 * museum). */
export const INK_DARK_ON_LIGHT = {
  /** --stone-900 */
  core: '#3A362F',
  /** --stone-800 */
  lower: '#56524C',
  /** cream casing */
  halo: '#FBF4E8',
  rim: '#3A362F',
} as const
/** The light ink, for a dark board (Clean's own stroke). */
export const INK_LIGHT_ON_DARK = {
  core: '#C9C3BA',
  lower: '#8C877F',
  halo: '#161513',
  rim: '#161513',
} as const
export type InkSetId = 'darkInk' | 'lightInk'
export const INK_SETS: Record<InkSetId, typeof INK_DARK_ON_LIGHT | typeof INK_LIGHT_ON_DARK> = {
  darkInk: INK_DARK_ON_LIGHT,
  lightInk: INK_LIGHT_ON_DARK,
}

/** The halo's opacity: an edge against the grain that vanishes on cards. */
export const INK_HALO_OPACITY = 0.55
/** A focus-dimmed line (2D and Clean use 0.15, which measured 1.21:1 on the
 * wood — a line that disappears). Its casing goes to 0. The design spec's
 * 0.30 read 1.30-1.34:1 (median) on the wood in the PNG and its dimmed heads
 * nearly vanished (sl-r1-dpr1 workbench-arrows-selected.png, design review
 * round 2). Blending #3A362F (L 0.037) over the lit wood (L 0.38) at `a`
 * predicts 0.43 / ((1 - a)·0.38 + a·0.037 + 0.05): 1.31 at 0.30 (it matches
 * the PNG), 1.50 at 0.42 — the middle of the spec's 1.3-1.8 band
 * (arithmetic; the harness measures it, arrowGates "focus-dimmed"). */
export const INK_DIM_OPACITY = 0.42

/** Core widths, world px at scale 1 (the 2D skin strokes 1.6 / 2.5; Clean
 * 3D draws max(2.2, 1.6 * 1.2) — the normal core is ~18 % heavier). */
export const INK_CORE_W = 2.6
export const INK_LOWER_W = 2.2
/** The highlight core, world px, held in a projected band
 * (INK_HIGHLIGHT_MIN_CSS - INK_HIGHLIGHT_MAX_CSS). The user's "thick flat
 * orange ribbon" (user-ref/selected-line-dark.webp) was 3.4 world + 2 × 0.8
 * world of rim with floors and no ceiling: ~8 css px at the harness fit (0.61
 * world px per css px), 20+ px in the close framings (design spec §0.a,
 * measured with the probe on design-ref-selected). The ceiling fixes that,
 * not the world width: the spec's 3.0 world drew the selected core only
 * 3.0 / 2.6 = 1.15× an unselected one wherever both are between floor and
 * ceiling (wpp 0.87-1.38 at a square view), against its own ">= 1.33× at
 * every pose". 3.5 / 2.6 = 1.35; at the floors 2.5 / 1.75 = 1.43 and at the
 * ceilings 4 / 3 = 1.33 (arithmetic, pinned in inkLine.test). */
export const INK_HIGHLIGHT_W = 3.5
export const INK_PERSPECTIVE_W = 2.6
/** Casing width per side. */
export const INK_HALO_W = 1.0
/** (Tried 0.5 world within [1.0, 1.25] css to let the coral read between
 * thinner rims: read back from the PNG the rim then fell under 3:1 against
 * the core on 4 of 19 samples at the top pose and the selected-line gate went
 * red (sl-ao1 report.json) — the antialiased 1-px edge INK_RIM_MIN_CSS
 * documents. The rim is held at 1.5 css px, the spec band's top.) */
export const INK_HIGHLIGHT_RIM_W = 0.6
export const INK_PERSPECTIVE_RIM_W = 0.7
/** The highlight's projected band (css px): core total in [MIN, MAX], rim per
 * side in [RIM_MIN, RIM_MAX]. The rim's band is deliberately collapsed to
 * 1.5 (the spec's 1.0 floor read under 3:1 in the PNG, see
 * INK_HIGHLIGHT_RIM_W): a selected line at the selected framing totals
 * 4 + 2 × 1.5 = 7 css px plus its halo, not the spec's 6. */
export const INK_HIGHLIGHT_MAX_CSS = 4.0
export const INK_HIGHLIGHT_RIM_MIN_CSS = 1.5
export const INK_HIGHLIGHT_RIM_MAX_CSS = 1.5
/** The UNSELECTED lines' projected CEILINGS (selected spec §2.4 / §3, design
 * review round 2): without them a capped selected line looked thinner than
 * its uncapped neighbours up close, and their heads grew past its 16-px
 * head. They bind only when zoomed in (wpp < 2.6 / 3 ≈ 0.87 world px per css
 * px): at the whole-board fit (wpp ≈ 1.3, workbench-arrows-default) the core
 * draws ~2 css px, the halo ~0.8 per side and the head 11.5 long — under
 * every ceiling, so 1a03e0865's look there is unchanged. */
export const INK_CORE_MAX_CSS = 3.0
export const INK_HALO_MAX_CSS = 1.25
/** Every projected CEILING (core, casing, head, handle) grows with the zoom
 * past the wpp where the core's starts to bind, by (REF / wpp)^GROWTH. Held
 * fixed, a zoomed-in line stayed 3 css px while its cards grew and read
 * "de plus en plus fine (trop fine)" (user, 2026-10-12); grown linearly
 * (the 2D canvas) the selected line was the 20+ px ribbon of
 * user-ref/selected-line-dark.webp. Sub-linear: twice the zoom past REF
 * draws 1.57× the ceiling, at most MAX× (reached ~4.1× past REF: a core of
 * 7.5 css, a selected one of 10, a head of 40). At the fit (wpp ≈ 1.3) it is
 * 1. Arithmetic, not a measurement: the look is judged in the harness shots. */
export const INK_CAP_REF_WPP = 0.87
export const INK_CAP_GROWTH = 0.65
export const INK_CAP_GROWTH_MAX = 2.5
export function inkCapGrowth(wpp: number): number {
  return Math.min(INK_CAP_GROWTH_MAX, Math.pow(Math.max(1, INK_CAP_REF_WPP / Math.max(wpp, 1e-6)), INK_CAP_GROWTH))
}
/** A perspective colour's ink rim: its floor IS its ceiling (1.5). */
export const INK_RIM_MAX_CSS = 1.5
/**
 * The selection HALO: a soft strip under the rim of the ONE selected
 * connection (the 2D `isSelected`), css-sized, fading to 0 over `widthCss`
 * per side (smoothstep). Lines highlighted because their source card is
 * selected have none.
 *  - dark ink (light boards: honey wood, paper): cream, lifting the coral off
 *    the wood, where coral reads 1.26:1 (light #D97A3D) / 1.03:1 (dark
 *    #E89456) — WCAG formula on the hex values and the measured wood #D0995A
 *    (design spec §2.3);
 *  - light ink (dark boards): the core colour itself, the design system's
 *    --shadow-glow language on dark stone.
 * The lit board blends in LINEAR light (the composer's float buffers), CSS
 * in sRGB: a bright colour over a dark one reads much stronger linearly. The
 * spec's 0.30 coral glow read back ~0.49 effective just outside the rim on
 * the dark stone (design review round 2, sel-r1 dark-iso: (138,91,58) on
 * (46,43,40)), a second stroke rather than a glow. linearAlphaFor solves
 * the linear opacity that lands the spec's sRGB 0.30 on its board (#E89456
 * over #2E2923: 0.135, inkLine.test). The cream on the wood drifts less but
 * the same way (0.65 read back 0.55-0.58 at 1.5 css px out of the rim where
 * the spec's falloff gives 0.42, sel-r2-it1): its 0.65 is solved alike over
 * the measured wood #D0995A (0.52). The harness reads both back.
 */
export const INK_SELECT_HALO = {
  darkInk: { css: '#FBF4E8', opacity: 0.52, widthCss: 4 },
  lightInk: { css: null, opacity: 0.135, widthCss: 5 },
} as const

/** The opacity that, blended in LINEAR light, lands where an sRGB (CSS)
 * blend at `srgbAlpha` of `fg` over `bg` would — matched on the channel with
 * the largest swing. */
export function linearAlphaFor(fg: string, bg: string, srgbAlpha: number): number {
  const a = new THREE.Color().setStyle(fg, THREE.SRGBColorSpace)
  const b = new THREE.Color().setStyle(bg, THREE.SRGBColorSpace)
  const sa = a.clone().convertLinearToSRGB()
  const sb = b.clone().convertLinearToSRGB()
  const ch = (['r', 'g', 'b'] as const).reduce((best, k) => (Math.abs(sa[k] - sb[k]) > Math.abs(sa[best] - sb[best]) ? k : best), 'r' as 'r' | 'g' | 'b')
  const target = new THREE.Color(sb[ch] + (sa[ch] - sb[ch]) * srgbAlpha, 0, 0).convertSRGBToLinear().r
  return (target - b[ch]) / (a[ch] - b[ch])
}
/** Projected floors (css px): a core never thinner than this in total… */
export const INK_CORE_MIN_CSS = 1.75
export const INK_HIGHLIGHT_MIN_CSS = 2.5
/** …and a halo never thinner than this per side… */
export const INK_CASING_MIN_CSS = 0.75
/** …and an ink RIM (highlight, perspective colours) never thinner than this
 * per side. The design spec's 0.75 left an antialiased ~1-px edge that read
 * 1.2-1.6:1 against the wood in the PNG — its own ">= 3:1 rim vs wood"
 * acceptance check failed on 21 of 23 samples (sl-r1-arrows report.json,
 * highlightPixels). */
export const INK_RIM_MIN_CSS = 1.5
/** Grazing compensation: a strip's WORLD width grows by 1 / f (f: how square
 * it faces the viewer, stripFacing), at most this much (the design spec's
 * 2.2, f >= 0.45). Round 1 widened up to 4× so the floor would hold at the
 * low pose (f = sin 15° ≈ 0.26), and the near runs there turned into 5-7 px
 * black road stripes (design review round 2, sl-r1-dpr1
 * workbench-arrows-low.png, 'ships' / 'uses'). The far, foreshortened runs
 * are carried by the projected floor instead, which is measured on screen
 * (INK_FLOOR_F_MIN), not by a bigger world width. */
export const INK_STRIP_GRAZE_MAX = 2.2
export const INK_STRIP_GRAZE_F_MIN = 0.45
/** The projected floor divides by the facing, so the core's ON-SCREEN
 * thickness holds INK_CORE_MIN_CSS however the strip is foreshortened, down
 * to this f (the orbit clamps the polar at 78°: f >= sin 12° ≈ 0.21). */
export const INK_FLOOR_F_MIN = 0.2

/** The flat arrowhead: an isosceles triangle, base not notched, `length`
 * along its axis from the tip, `halfWidth` either side (apex ≈ 53°). The 2D
 * engine's is side 14 at ±30° (≈12.1 long, half-width 7); the old Clean 3D
 * triangle was 14 × ±5. The 2D route stops 14 px short of the tip, so a
 * 15-px head overlaps the core by 1 px. */
export const INK_HEAD_LEN = 15
export const INK_HEAD_HALF_W = 7.5
/** A head is never shorter than this on screen (scaled about its tip)… */
export const INK_HEAD_MIN_CSS = 11
/** …and its base never narrower than this. The spec's across stretch
 * (≤ 1.6 on the normal's projected length) left the 'publishes' head an
 * ~8 × 5 px sliver from the low pose (design review round 2): a head seen
 * flat from 15° up loses its width to the foreshortening, not its length. */
export const INK_HEAD_MIN_WIDTH_CSS = 10
/** Neither stretch makes the head longer / wider than this × its floored
 * size (a head seen almost edge-on would otherwise grow without bound). */
export const INK_HEAD_STRETCH_MAX = 3
/** A CAPPED head (the highlight's: headFit `cap`) is never longer than this
 * on screen, nor its base wider than INK_HEAD_MAX_WIDTH_CSS. The selected
 * head measured 110 × 117 css px at the close-target framing
 * (design-ref-selected, arrowheadInfo); the 2D head is ~12 × 14. A capped
 * head may shrink BELOW its 15-world size (s < 1): its tip stays on the
 * target edge and the line's closing vertex follows its base (aEnd.x). */
export const INK_HEAD_MAX_CSS = 16
export const INK_HEAD_MAX_WIDTH_CSS = 14

/** The 2D engine's dash patterns (world px): dashed [6, 4], dotted [2, 3]. */
export const INK_DASHED: readonly [number, number] = [6, 4]
export const INK_DOTTED: readonly [number, number] = [2, 3]
/** A dash period never projects under this (css px): zoomed out, the rhythm
 * lengthens instead of aliasing into a grey line. */
export const INK_DASH_MIN_CSS = 7

/** The ink set for a board base colour: whichever reads the higher contrast
 * against it. The choice follows the BOARD, not the app appearance — a
 * honey-wood tray in the dark appearance keeps the dark ink. */
export function inkSetFor(boardCss: string): { id: InkSetId; contrast: number } {
  const dark = contrastRatio(INK_DARK_ON_LIGHT.core, boardCss)
  const light = contrastRatio(INK_LIGHT_ON_DARK.core, boardCss)
  return dark >= light ? { id: 'darkInk', contrast: dark } : { id: 'lightInk', contrast: light }
}

export interface InkCasing {
  kind: 'halo' | 'rim'
  css: string
  opacity: number
  /** World px per side. */
  width: number
  minCss: number
  /** Projected ceiling per side (css px); 0: none. */
  maxCss: number
}

/** The selection halo (INK_SELECT_HALO), resolved for one line. */
export interface InkSelectHalo {
  css: string
  /** Opacity at the rim's outer edge. */
  opacity: number
  /** Falloff width per side (css px). */
  widthCss: number
}

export interface InkStyle {
  core: string
  /** Core opacity (focus dim, hidden-tag preview). */
  opacity: number
  /** Core width, world px (total). */
  width: number
  /** Projected floor of the core's total width (css px). */
  minCss: number
  /** Projected ceiling of the core's total width (css px); 0: none. */
  maxCss: number
  /** Null: no casing drawn (a dimmed line loses its halo). */
  casing: InkCasing | null
  /** The head wears the projected ceilings (headFit `cap`). */
  headCap: boolean
  /** Directions measured ON SCREEN (screenDir, the perspective term
   * included): the highlight's. The unselected lines keep 1a03e0865's
   * view-space measure. */
  screen: boolean
  /** The single selected connection's soft halo; null otherwise. */
  select: InkSelectHalo | null
}

export interface InkStyleInput {
  set: InkSetId
  highlighted: boolean
  lower: boolean
  /** The tag / technology / status / team colour, verbatim as in 2D. */
  perspectiveCss: string | null
  /** The skin's highlight stroke (#D97A3D light, #E89456 dark). */
  highlightCss: string
  /** Focus mode is on and this line is not highlighted. */
  focusDimmed: boolean
  /** Hidden-tag preview multiplier (1, or 0.4 while revealed). */
  previewAlpha: number
  /** The ONE selected connection (2D isSelected) — a highlighted line that
   * also wears the selection halo. Ignored unless `highlighted`. */
  selected?: boolean
}

/** Colour, width and casing of one connection in one state. */
export function inkStyle(input: InkStyleInput): InkStyle {
  const set = INK_SETS[input.set]
  const alpha = (input.focusDimmed ? INK_DIM_OPACITY : 1) * input.previewAlpha
  const rim = (width: number): InkCasing => ({ kind: 'rim', css: set.rim, opacity: alpha, width, minCss: INK_RIM_MIN_CSS, maxCss: INK_RIM_MAX_CSS })
  const halo: InkCasing | null = input.focusDimmed
    ? null
    : { kind: 'halo', css: set.halo, opacity: INK_HALO_OPACITY * input.previewAlpha, width: INK_HALO_W, minCss: INK_CASING_MIN_CSS, maxCss: INK_HALO_MAX_CSS }
  // the unselected lines: ceilinged (core, halo, head), measured as before
  const plain = { maxCss: INK_CORE_MAX_CSS, headCap: true, screen: false, select: null }
  if (input.highlighted) {
    const sh = INK_SELECT_HALO[input.set]
    return {
      core: input.highlightCss,
      opacity: alpha,
      width: INK_HIGHLIGHT_W,
      minCss: INK_HIGHLIGHT_MIN_CSS,
      maxCss: INK_HIGHLIGHT_MAX_CSS,
      casing: {
        kind: 'rim',
        css: set.rim,
        opacity: alpha,
        width: INK_HIGHLIGHT_RIM_W,
        minCss: INK_HIGHLIGHT_RIM_MIN_CSS,
        maxCss: INK_HIGHLIGHT_RIM_MAX_CSS,
      },
      headCap: true,
      screen: true,
      select: input.selected ? { css: sh.css ?? input.highlightCss, opacity: sh.opacity * alpha, widthCss: sh.widthCss } : null,
    }
  }
  if (input.perspectiveCss) {
    return { core: input.perspectiveCss, opacity: alpha, width: INK_PERSPECTIVE_W, minCss: INK_CORE_MIN_CSS, casing: rim(INK_PERSPECTIVE_RIM_W), ...plain }
  }
  if (input.lower) return { core: set.lower, opacity: alpha, width: INK_LOWER_W, minCss: INK_CORE_MIN_CSS, casing: halo, ...plain }
  return { core: set.core, opacity: alpha, width: INK_CORE_W, minCss: INK_CORE_MIN_CSS, casing: halo, ...plain }
}

// ── the shader math, CPU mirror ──────────────────────────────────────────────

/** How square a strip faces the viewer: its unit in-plane normal's view-space
 * projection (`n`, xy) measured SQUARE to its unit tangent's (`t`, xy) — the
 * line's on-screen thickness per world px across it, up to the perspective
 * divide. The normal's own projected length over-counts on a slanted view:
 * there the projected normal leans along the line, and a core the length
 * measure held at 6.4 css px drew ~3 (ink-debug, 2026-10-12, polar 75). */
export function stripFacing(t: { x: number; y: number }, n: { x: number; y: number }): number {
  const lt = Math.hypot(t.x, t.y)
  return lt > 1e-3 ? Math.abs(n.x * t.y - n.y * t.x) / lt : Math.hypot(n.x, n.y)
}

/** A unit view-space direction `d` at view-space point `p`, as it moves on
 * SCREEN (per world px, in units of that point's wpp): the perspective
 * divide's own term `p.xy · d.z / -p.z` included. Without it a direction
 * with depth in it is mis-measured off the screen's centre — the capped
 * head drew 10-10.6 css px long and 15-17 wide where the ceiling-and-floor
 * math said 11-16 × <= 14 (quick-sel q2, close and low poses). Used for the
 * CAPPED (highlight) lines only: the uncapped ink keeps 1a03e0865's math. */
export function screenDir(d: { x: number; y: number; z: number }, p: { x: number; y: number; z: number }): { x: number; y: number } {
  const k = d.z / Math.max(-p.z, 1e-3)
  return { x: d.x + p.x * k, y: d.y + p.y * k }
}

/** Grazing factor of a strip's world width, facing the viewer by `f`
 * (stripFacing). */
export function stripGraze(f: number): number {
  return Math.min(INK_STRIP_GRAZE_MAX, 1 / Math.max(f, INK_STRIP_GRAZE_F_MIN))
}

/** Half-width (world px) a strip vertex is pushed out by: the core half
 * (its world width times the grazing factor), floored so it PROJECTS to at
 * least `minCss / 2` css px — the floor divides by the facing, down to
 * INK_FLOOR_F_MIN — plus the casing, grown and floored the same way.
 * `wpp`: world px per css px there; `f`: stripFacing. */
export function stripHalfWidth(
  coreWidth: number,
  minCss: number,
  casingWidth: number,
  casingMinCss: number,
  wpp: number,
  f: number,
  /** Projected CEILINGS (css px; 0: none): the core's total, the casing's
   * per side. Divided by the facing like the floors, so what they cap is
   * the ON-SCREEN thickness. */
  maxCss = 0,
  casingMaxCss = 0,
): number {
  const g = stripGraze(f)
  const fl = wpp / Math.max(f, INK_FLOOR_F_MIN)
  const k = inkCapGrowth(wpp)
  let core = Math.max((coreWidth / 2) * g, (minCss / 2) * fl)
  if (maxCss > 0) core = Math.min(core, (maxCss / 2) * k * fl)
  let casing = casingWidth > 0 ? Math.max(casingWidth * g, casingMinCss * fl) : 0
  if (casingWidth > 0 && casingMaxCss > 0) casing = Math.min(casing, casingMaxCss * k * fl)
  return core + casing
}

/** The projected width (css px) of a core of `coreWidth` drawn where `wpp`
 * world px make one css px and the strip faces the viewer by `f`. */
export function stripCoreWidthPx(coreWidth: number, minCss: number, wpp: number, f: number, maxCss = 0): number {
  return (2 * stripHalfWidth(coreWidth, minCss, 0, 0, wpp, f, maxCss) * Math.min(1, f)) / wpp
}

/** The projected width (css px) of one side of a casing — the CPU mirror the
 * probe reports for the highlight's rim. */
export function stripCasingWidthPx(casingWidth: number, casingMinCss: number, casingMaxCss: number, wpp: number, f: number): number {
  const total = stripHalfWidth(0, 0, casingWidth, casingMinCss, wpp, f, 0, casingMaxCss)
  return (total * Math.min(1, f)) / wpp
}

/** How a head is drawn where `wpp` world px make one css px, its axis
 * projects to `fA` (the projected unit axis' length) and its base is seen
 * `fW` square to that axis (stripFacing of the axis and its normal):
 *  - `s`: the uniform scale about the tip that keeps an UNforeshortened head
 *    at INK_HEAD_MIN_CSS (the spec's floor; 1 when the head is big enough);
 *  - `along` / `across`: the stretches that keep the PROJECTED length at
 *    INK_HEAD_MIN_CSS and the projected base at INK_HEAD_MIN_WIDTH_CSS, each
 *    at most INK_HEAD_STRETCH_MAX. Seen square from above both are 1: the
 *    2D head, 2D parity. */
export function headFit(
  wpp: number,
  fA: number,
  fW: number,
  cap = false,
  /** The base normal's whole projected length (>= fW): the base's corner
   * distance on screen, which the width CEILING caps — on a slanted view the
   * base is skewed and its corners lie further apart than its thickness. */
  nW = fW,
): { s: number; along: number; across: number } {
  const w = Math.max(wpp, 1e-6)
  // the ceilings grow with the zoom (inkCapGrowth)
  const k = inkCapGrowth(w)
  const maxLen = INK_HEAD_MAX_CSS * k
  const maxWidth = INK_HEAD_MAX_WIDTH_CSS * k
  // capped: s also stops where the unforeshortened head reaches
  // its length ceiling — below 1 when the camera is close
  const s = cap
    ? Math.min((maxLen * w) / INK_HEAD_LEN, Math.max(1, (INK_HEAD_MIN_CSS * w) / INK_HEAD_LEN))
    : Math.max(1, (INK_HEAD_MIN_CSS * w) / INK_HEAD_LEN)
  // a capped head shrunk below its world size may stretch as far as an
  // uncapped one would in WORLD terms (never past 3 × 15 world px)
  const stretchMax = cap ? INK_HEAD_STRETCH_MAX / Math.min(1, s) : INK_HEAD_STRETCH_MAX
  // the FLOOR wins over the ceiling: the width ceiling is measured corner to
  // corner (nW), the floor square to the axis (fW); on a slanted, skewed
  // view (polar 75, off the screen's centre) the corners lie far apart along
  // the axis while the base is thin across it, and the ceiling applied last
  // squeezed the head to the line's own width — 4-5 px across where the
  // probe's corner distance said 14 (design review round 2,
  // workbench-selected-line-dark-low.png)
  const stretch = (minCss: number, maxCss: number, size: number, f: number, fCeil: number) => {
    const need = (minCss * w) / (size * s * Math.max(f, 1e-3))
    const st = Math.min(stretchMax, Math.max(1, need))
    if (!cap) return st
    return Math.max(Math.min(st, (maxCss * w) / (size * s * Math.max(fCeil, 1e-3))), Math.min(stretchMax, need))
  }
  return {
    s,
    along: stretch(INK_HEAD_MIN_CSS, maxLen, INK_HEAD_LEN, fA, fA),
    across: stretch(INK_HEAD_MIN_WIDTH_CSS, maxWidth, 2 * INK_HEAD_HALF_W, fW, Math.max(nW, fW)),
  }
}

/** Where the line's closing vertex sits, measured back from the tip (world
 * px), for a head drawn at `s` × `along`: INK_HEAD_LEN - 2 at full size (2 px
 * inside the base, inkRouteToHead), scaled with a capped head that shrank
 * below it, so the line still runs into its base. */
export function inkCloseDistance(s: number, along: number): number {
  const full = INK_HEAD_LEN - 2
  return Math.min(full, full * s * along)
}

/** A dash pattern for the core or its casing: `on`, `period`, `shift`
 * (pattern units). A casing segment is on for on + 2·casing and starts
 * `casing` earlier, so every dash end is cased. */
export function dashFor(dash: readonly [number, number] | null, casingWidth: number): [number, number, number] {
  if (!dash) return [0, 0, 0]
  return [dash[0] + 2 * casingWidth, dash[0] + dash[1], casingWidth]
}

// ── geometry ────────────────────────────────────────────────────────────────

/** A flat head: its tip (plan x / z), its axis angle (radians, plan, tip
 * direction — the 2D engine's arrowTip.angle), and its height in the layer. */
export interface InkHead {
  x: number
  z: number
  angle: number
  y: number
}

/** The head's triangle at scale `s` (tip, then the two base corners), plan
 * x / z, before any casing. `along` / `across` stretch it (grazing); `shear`
 * (headShear) slides the base corners along the axis so the base projects
 * SQUARE to the on-screen axis. */
export function inkHeadTriangle(h: InkHead, s = 1, along = 1, across = 1, shear = 0): { x: number; z: number }[] {
  const ax = Math.cos(h.angle)
  const az = Math.sin(h.angle)
  const L = INK_HEAD_LEN * s * along
  const W = INK_HEAD_HALF_W * s * across
  const bx = h.x - ax * L
  const bz = h.z - az * L
  // the across direction: the plan normal minus `shear` of the axis
  const px = -az - shear * ax
  const pz = ax - shear * az
  return [
    { x: h.x, z: h.z },
    { x: bx + px * W, z: bz + pz * W },
    { x: bx - px * W, z: bz - pz * W },
  ]
}

/** The largest base shear a head takes (a line seen nearly end-on). */
export const INK_HEAD_SHEAR_MAX = 3

/**
 * How far a head's base corners slide along its axis (per unit across) so
 * the base projects SQUARE to the axis on screen: `(nV · tV) / |tV|²` for
 * the projected axis `tV` and normal `nV`, clamped. A flat triangle on the
 * board seen grazing and off the screen's centre projects its base almost
 * ALONG the line — the low pose's selected head drew tip (429, 432), corners
 * (451, 432) / (428, 437): a 10-px-thick sliver lying on the line, "no wider
 * than the line" (design review round 2, workbench-selected-line-dark-low).
 * Sheared, the base stays on the board and its corners lie across the line
 * on screen, so the floored thickness IS the base width. Seen square (top
 * view) the shear is 0: the 2D head.
 */
export function headShear(tV: { x: number; y: number }, nV: { x: number; y: number }): number {
  const tt = tV.x * tV.x + tV.y * tV.y
  if (tt < 1e-8) return 0
  const k = (nV.x * tV.x + nV.y * tV.y) / tt
  return Math.max(-INK_HEAD_SHEAR_MAX, Math.min(INK_HEAD_SHEAR_MAX, k))
}

/**
 * The route's samples as the ink line draws them: cut where the route enters
 * its head and closed by a point on the head's axis 2 px inside its base.
 * The 2D route stops 14 px short of the tip but keeps its last control
 * point: when that point lies within those 14 px the curve runs past its
 * own end and hooks back to it (the cable build met the same hook,
 * connectionPath / tp6-arrows2-dbg4). A faint 1.6-px grey line hid it; the
 * inked one drew a curl beside its head and a cream sliver of halo between
 * line and head (sl-r1-arrows workbench-arrows-top.png, 'uses' into Web
 * console). The route itself is untouched up to the head.
 */
export function inkRouteToHead(pts: readonly { x: number; y: number }[], head: InkHead): { x: number; y: number }[] {
  const ux = Math.cos(head.angle)
  const uz = Math.sin(head.angle)
  const inHead = (p: { x: number; y: number }) => {
    const along = (p.x - head.x) * ux + (p.y - head.z) * uz
    const across = -(p.x - head.x) * uz + (p.y - head.z) * ux
    return along >= -INK_HEAD_LEN + 1 && Math.abs(across) <= INK_HEAD_HALF_W
  }
  let cut = pts.length
  for (let i = 1; i < pts.length; i++) {
    if (inHead(pts[i])) {
      cut = i
      break
    }
  }
  const kept = pts.slice(0, cut)
  kept.push({ x: head.x - ux * (INK_HEAD_LEN - 2), y: head.z - uz * (INK_HEAD_LEN - 2) })
  return kept
}

/** A round node's footprint on the board (plan x / z, radius): a drum's pad. */
export interface InkDisc {
  x: number
  z: number
  r: number
}

/** First t >= 0 at which the ray p + t·u meets the circle `d`, or null. */
function rayDisc(px: number, pz: number, ux: number, uz: number, d: InkDisc): number | null {
  const ox = px - d.x
  const oz = pz - d.z
  const b = ox * ux + oz * uz
  const c = ox * ox + oz * oz - d.r * d.r
  const disc = b * b - c
  if (disc < 0) return null
  const t = -b - Math.sqrt(disc)
  return t >= 0 ? t : null
}

/** Where segment a→b crosses the circle `d` going in (a outside, b inside). */
function enterDisc(a: { x: number; y: number }, b: { x: number; y: number }, d: InkDisc): { x: number; y: number } {
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const ux = (b.x - a.x) / l
  const uz = (b.y - a.y) / l
  const t = rayDisc(a.x, a.y, ux, uz, d) ?? 0
  return { x: a.x + ux * Math.min(t, l), y: a.y + uz * Math.min(t, l) }
}

/**
 * A head pointing at a DRUM, moved onto the drum's pad circle. The 2D route
 * ends on the drum's bounding rect; the 3D drum is a circle in that rect, so
 * the head stopped in empty wood 20-25 css px short of the pad and pointed at
 * nothing (design review round 2, sl-r1-dpr1 workbench-arrows-default.png,
 * 'publishes' into the Event bus drum). The route is kept up to that point:
 *  - a tip outside the circle slides forward along its own axis until it
 *    meets the circle (inkRouteToHead then closes the line straight into
 *    it); a ray that misses the circle leaves the head where 2D puts it;
 *  - a tip inside the circle (a rect smaller than the pad) moves back along
 *    the route to where it enters the circle, the route cut there.
 */
export function inkHeadOnDisc(
  pts: readonly { x: number; y: number }[],
  head: InkHead,
  d: InkDisc,
): { pts: { x: number; y: number }[]; head: InkHead } {
  const ux = Math.cos(head.angle)
  const uz = Math.sin(head.angle)
  if (Math.hypot(head.x - d.x, head.z - d.z) > d.r) {
    const t = rayDisc(head.x, head.z, ux, uz, d)
    if (t === null) return { pts: [...pts], head }
    return { pts: [...pts], head: { ...head, x: head.x + ux * t, z: head.z + uz * t } }
  }
  const route = [...pts, { x: head.x, y: head.z }]
  for (let i = route.length - 2; i >= 0; i--) {
    const a = route[i]
    if (Math.hypot(a.x - d.x, a.y - d.z) <= d.r) continue
    const p = enterDisc(a, route[i + 1], d)
    const angle = Math.atan2(route[i + 1].y - a.y, route[i + 1].x - a.x)
    return { pts: route.slice(0, i + 1), head: { ...head, x: p.x, z: p.y, angle } }
  }
  return { pts: [...pts], head }
}

/** A route LEAVING a drum, started on the pad circle grown by `gap` (the 2D
 * route starts 4 px off the drum's bounding rect: in 3D, in empty wood). A
 * start outside the circle is extended back along its first leg; one inside
 * it is cut where the route leaves the circle. */
export function inkStartOnDisc(pts: readonly { x: number; y: number }[], d: InkDisc, gap = 2): { x: number; y: number }[] {
  if (pts.length < 2) return [...pts]
  const g: InkDisc = { ...d, r: d.r + gap }
  const p0 = pts[0]
  if (Math.hypot(p0.x - g.x, p0.y - g.z) > g.r) {
    const l = Math.hypot(p0.x - pts[1].x, p0.y - pts[1].y) || 1
    const ux = (p0.x - pts[1].x) / l
    const uz = (p0.y - pts[1].y) / l
    const t = rayDisc(p0.x, p0.y, ux, uz, g)
    return t === null || t < 1e-6 ? [...pts] : [{ x: p0.x + ux * t, y: p0.y + uz * t }, ...pts]
  }
  for (let i = 1; i < pts.length; i++) {
    if (Math.hypot(pts[i].x - g.x, pts[i].y - g.z) <= g.r) continue
    return [enterDisc(pts[i], pts[i - 1], g), ...pts.slice(i)]
  }
  return [...pts]
}

/** Unit miter offsets (head frame: along the axis toward the tip, across)
 * that push the triangle's vertices out by 1 along every edge normal. */
function headMiters(): [number, number][] {
  const v: [number, number][] = [
    [0, 0],
    [-INK_HEAD_LEN, INK_HEAD_HALF_W],
    [-INK_HEAD_LEN, -INK_HEAD_HALF_W],
  ]
  const out: [number, number][] = []
  for (let i = 0; i < 3; i++) {
    const p = v[(i + 2) % 3]
    const c = v[i]
    const n = v[(i + 1) % 3]
    const normal = (a: [number, number], b: [number, number]): [number, number] => {
      // outward for this counter-clockwise order
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const l = Math.hypot(dx, dy) || 1
      return [dy / l, -dx / l]
    }
    const n1 = normal(p, c)
    const n2 = normal(c, n)
    const k = 1 + n1[0] * n2[0] + n1[1] * n2[1]
    out.push([(n1[0] + n2[0]) / k, (n1[1] + n2[1]) / k])
  }
  return out
}
const HEAD_MITERS = headMiters()

export interface InkGeometryInput {
  /** Centreline samples (plan x / y = world z), the route as Clean draws it. */
  pts: readonly { x: number; y: number }[]
  head: InkHead | null
  /** Core width (world px, total) and its projected floor (css px). */
  width: number
  minCss: number
  /** Casing per side (0: the core itself). */
  casing: number
  casingMinCss: number
  /** Dash [on, gap] (world px) or null. Heads are always solid. */
  dash: readonly [number, number] | null
  /** Projected ceilings (css px; 0 or absent: none): the core's total, the
   * casing's per side. */
  maxCss?: number
  casingMaxCss?: number
  /** A SOFT outer band (css px per side, 0 / absent: none): the strip and the
   * head grow by it, the fragment fading it to 0 across it (the selection
   * halo, INK_SELECT_HALO). */
  soft?: number
  /** The head wears the projected ceilings (headFit `cap`), and the strip's
   * LAST point is the closing vertex inkRouteToHead added: it follows the
   * head's base when a capped head shrinks below its world size. */
  headCap?: boolean
  /** Measure the directions ON SCREEN (InkStyle.screen); meaningful with
   * `headCap` only. */
  screen?: boolean
  /** Paint the flow BEAD (INK_FRAGMENT_COLOR) along this strip. */
  bead?: boolean
}

/** aCap.w: 0 uncapped, 1 capped (view-space measure), 2 capped + screen
 * measure (the highlight). */
export function inkCapCode(headCap: boolean | undefined, screen: boolean | undefined): number {
  return headCap ? (screen ? 2 : 1) : 0
}

/**
 * One connection's core OR casing as a single geometry (line and head
 * merged). Every vertex sits on its ANCHOR (a centreline point, or the
 * head's tip) and carries what the vertex shader needs to push it out:
 *   aDir   the frame's axis (unit, plan): the strip's tangent, the head's
 *          tip direction;
 *   aLocal the offset in that frame at scale 1 (strip: 0, ±half core;
 *          head: the vertex relative to the tip);
 *   aMiter the unit casing offset in that frame;
 *   aParam kind (0 strip, 1 head), core min half (css px), casing width
 *          (world px per side), casing min (css px);
 *   aArc   arc length from the source (dashes);
 *   aDash  [on, period, shift] (period 0: solid);
 *   aCap   core ceiling half (css), casing ceiling per side (css), soft band
 *          per side (css), head capped and how it measures (inkCapCode);
 *   aSoft  0 on the hard part, 1 on a soft band's outer edge;
 *   aEnd   the closing vertex's distance back from the tip (world px, 0 for
 *          every other vertex), the bead's arc total (0: no bead).
 * The geometry's own positions are degenerate (zero-width): a raycast cannot
 * see it — Scene3D picks the lines on screen (inkLineAt).
 */
export function buildInkGeometry(input: InkGeometryInput): THREE.BufferGeometry | null {
  const { pts, head } = input
  const pos: number[] = []
  const dir: number[] = []
  const local: number[] = []
  const miter: number[] = []
  const param: number[] = []
  const arcs: number[] = []
  const dashes: number[] = []
  const caps: number[] = []
  const softs: number[] = []
  const ends: number[] = []
  const index: number[] = []
  const strokeDash = dashFor(input.dash, input.casing)
  const hw = input.width / 2
  const minHalf = input.minCss / 2
  const soft = input.soft ?? 0
  const headCap = input.headCap ? 1 : 0
  const cap = [(input.maxCss ?? 0) / 2, input.casingMaxCss ?? 0, soft, inkCapCode(input.headCap, input.screen)]
  // [outer +, (inner +, inner -,) outer -]: a soft strip carries its hard
  // part between two soft bands
  const sides: [number, number][] = soft > 0 ? [[1, 1], [1, 0], [-1, 0], [-1, 1]] : [[1, 0], [-1, 0]]
  const nS = sides.length
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  const beadTotal = input.bead && total > 0 ? total : 0
  if (pts.length >= 2) {
    let arc = 0
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)]
      const next = pts[Math.min(pts.length - 1, i + 1)]
      if (i > 0) arc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
      let tx = next.x - prev.x
      let tz = next.y - prev.y
      const l = Math.hypot(tx, tz) || 1
      tx /= l
      tz /= l
      const closing = headCap && head && i === pts.length - 1 ? INK_HEAD_LEN - 2 : 0
      for (const [side, outer] of sides) {
        pos.push(pts[i].x, 0, pts[i].y)
        dir.push(tx, tz)
        local.push(0, side * hw)
        miter.push(0, side)
        param.push(0, minHalf, input.casing, input.casingMinCss)
        arcs.push(arc)
        dashes.push(...strokeDash)
        caps.push(...cap)
        softs.push(outer)
        ends.push(closing, beadTotal)
      }
      if (i > 0) {
        const b = (i - 1) * nS
        const c = i * nS
        for (let k = 0; k < nS - 1; k++) index.push(b + k, b + k + 1, c + k, b + k + 1, c + k + 1, c + k)
      }
    }
  }
  if (head) {
    const base = pos.length / 3
    const ax = Math.cos(head.angle)
    const az = Math.sin(head.angle)
    const corners: [number, number][] = [
      [0, 0],
      [-INK_HEAD_LEN, INK_HEAD_HALF_W],
      [-INK_HEAD_LEN, -INK_HEAD_HALF_W],
    ]
    const cased = input.casing > 0 || soft > 0
    for (const outer of soft > 0 ? [0, 1] : [0]) {
      corners.forEach((c, k) => {
        pos.push(head.x, head.y, head.z)
        dir.push(ax, az)
        local.push(c[0], c[1])
        miter.push(cased ? HEAD_MITERS[k][0] : 0, cased ? HEAD_MITERS[k][1] : 0)
        param.push(1, 0, input.casing, input.casingMinCss)
        arcs.push(0)
        dashes.push(0, 0, 0)
        caps.push(...cap)
        softs.push(outer)
        ends.push(0, 0)
      })
    }
    index.push(base, base + 1, base + 2)
    // a soft head: three bands between the hard triangle and its grown copy
    if (soft > 0) for (let k = 0; k < 3; k++) {
      const k1 = (k + 1) % 3
      index.push(base + k, base + k1, base + 3 + k, base + k1, base + 3 + k1, base + 3 + k)
    }
  }
  if (index.length === 0) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 2))
  geo.setAttribute('aLocal', new THREE.Float32BufferAttribute(local, 2))
  geo.setAttribute('aMiter', new THREE.Float32BufferAttribute(miter, 2))
  geo.setAttribute('aParam', new THREE.Float32BufferAttribute(param, 4))
  geo.setAttribute('aArc', new THREE.Float32BufferAttribute(arcs, 1))
  geo.setAttribute('aDash', new THREE.Float32BufferAttribute(dashes, 3))
  geo.setAttribute('aCap', new THREE.Float32BufferAttribute(caps, 4))
  geo.setAttribute('aSoft', new THREE.Float32BufferAttribute(softs, 1))
  geo.setAttribute('aEnd', new THREE.Float32BufferAttribute(ends, 2))
  geo.setIndex(index)
  // the shader pushes vertices out by a few px (more where the floor binds):
  // a sphere round the anchors alone would cull a line at the screen edge
  geo.computeBoundingSphere()
  if (geo.boundingSphere) geo.boundingSphere.radius += 32 + 8 * soft
  return geo
}

// ── the shader ──────────────────────────────────────────────────────────────

/** Uniforms every ink material shares (one object per scene): the canvas
 * height in css px and the world px per css px at the orbit target (dash
 * rhythm). Updated per frame; a uniform change never re-links. */
export interface InkUniforms {
  uInkViewH: THREE.IUniform<number>
  /** Canvas width, css px (the edit handles' billboards). */
  uInkViewW: THREE.IUniform<number>
  uInkWppTarget: THREE.IUniform<number>
  /** The flow bead's phase in [0, 1) (INK_PACKET_CYCLE_MS), < 0: no bead. */
  uInkPhase: THREE.IUniform<number>
}

export function createInkUniforms(): InkUniforms {
  return { uInkViewH: { value: 1000 }, uInkViewW: { value: 1600 }, uInkWppTarget: { value: 1 }, uInkPhase: { value: -1 } }
}

/**
 * The flow BEAD ('Point mobile' on a lit ink line, selected spec §5): painted
 * INSIDE the core by its fragment shader, so it inherits the core's width,
 * floor, ceiling, foreshortening and draw order — it can never read as a
 * handle or an oval (the old board-decal packet, a white r4 disc ringed in
 * ink with a 9-world glow, was the "white oval midpoint handle" of the
 * user's screenshot). Lengths in css px, converted with uInkWppTarget.
 */
export const INK_PACKET = {
  cycleMs: 1500,
  /** Body length along the line, and its colour / opacity. */
  lenCss: 9,
  css: '#FFF6EA',
  opacity: 0.95,
  /** Tail behind it: a mix from `tailOpacity` down to the core colour. */
  tailCss: 18,
  tailOpacity: 0.7,
  /** The bead's body stays this far (css px, on screen) from every handle,
   * the head and the line's start: its opacity is 0 nearer, whole from
   * `clearCss + fadeCss` on (inkPacketFade). Measured on screen per frame by
   * the CPU (Scene3D.updateInkBeads), not in arc units: an arc fade in css
   * at the orbit target's scale let the bead reach the knob at the low pose,
   * where the far end draws ~2× smaller than the target. */
  clearCss: 12,
  fadeCss: 8,
  /** Dark boards: the halo brightens ×1.5 (0.30 → 0.45) within this of the
   * bead. */
  glintCss: 8,
} as const

/** The bead's opacity weight at arc distance `d` (world px; + ahead of its
 * centre) — the CPU mirror of INK_FRAGMENT_COLOR, before the fade. */
export function inkPacketWeight(d: number, wpp: number): number {
  const half = (INK_PACKET.lenCss / 2) * wpp
  const aa = 0.75 * wpp
  const body = 1 - smooth(half - aa, half + aa, Math.abs(d))
  const tail = d < 0 ? Math.min(1, Math.max(0, 1 + (d + half) / (INK_PACKET.tailCss * wpp))) : 0
  return Math.max(INK_PACKET.opacity * body, INK_PACKET.tailOpacity * tail)
}

/** The bead's opacity for a centre `clearancePx` css px (on screen) from the
 * nearest handle edge, head or line start: 0 while its body (half
 * INK_PACKET.lenCss) is within INK_PACKET.clearCss of it, 1 from fadeCss
 * further on. */
export function inkPacketFade(clearancePx: number): number {
  const body = clearancePx - INK_PACKET.lenCss / 2
  return smooth(INK_PACKET.clearCss, INK_PACKET.clearCss + INK_PACKET.fadeCss, body)
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

const f = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`)
const beadLinear = new THREE.Color(INK_PACKET.css)
const vec3Of = (c: THREE.Color) => `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`

/** Declarations + the push-out, spliced over `#include <begin_vertex>`. */
export const INK_VERTEX_DECL = /* glsl */ `
attribute vec2 aDir;
attribute vec2 aLocal;
attribute vec2 aMiter;
attribute vec4 aParam;
attribute float aArc;
attribute vec3 aDash;
attribute vec4 aCap;
attribute float aSoft;
attribute vec2 aEnd;
uniform float uInkViewH;
varying float vInkArc;
varying vec3 vInkDash;
varying float vInkSoft;
varying float vInkBead;
// inkLine.inkCapGrowth
float inkCapK(float w) {
  return min(${f(INK_CAP_GROWTH_MAX)}, pow(max(1.0, ${f(INK_CAP_REF_WPP)} / max(w, 1e-6)), ${f(INK_CAP_GROWTH)}));
}
// inkLine.headFit: (s, along, across)
vec3 inkHeadFit(float w, float fA, float fW, float nW, bool cap) {
  float capK = inkCapK(w);
  float s = max(1.0, ${f(INK_HEAD_MIN_CSS)} * w / ${f(INK_HEAD_LEN)});
  if (cap) s = min(${f(INK_HEAD_MAX_CSS)} * capK * w / ${f(INK_HEAD_LEN)}, s);
  float stMax = cap ? ${f(INK_HEAD_STRETCH_MAX)} / min(1.0, s) : ${f(INK_HEAD_STRETCH_MAX)};
  float kA = w / (${f(INK_HEAD_LEN)} * s * max(fA, 1e-3));
  float kW = w / (${f(2 * INK_HEAD_HALF_W)} * s * max(fW, 1e-3));
  float gl = min(stMax, max(1.0, ${f(INK_HEAD_MIN_CSS)} * kA));
  float gc = min(stMax, max(1.0, ${f(INK_HEAD_MIN_WIDTH_CSS)} * kW));
  if (cap) {
    // the floor wins over the ceiling (inkLine.headFit)
    gl = max(min(gl, ${f(INK_HEAD_MAX_CSS)} * capK * kA), min(stMax, ${f(INK_HEAD_MIN_CSS)} * kA));
    gc = max(min(gc, ${f(INK_HEAD_MAX_WIDTH_CSS)} * capK * w /(${f(2 * INK_HEAD_HALF_W)} * s * max(max(nW, fW), 1e-3))), min(stMax, ${f(INK_HEAD_MIN_WIDTH_CSS)} * kW));
  }
  return vec3(s, gl, gc);
}
`
export const INK_VERTEX_BODY = /* glsl */ `
#include <begin_vertex>
{
  vec4 inkMv = modelViewMatrix * vec4(position, 1.0);
  float inkWpp = (isOrthographic ? 2.0 : 2.0 * max(-inkMv.z, 1e-3)) / (projectionMatrix[1][1] * uInkViewH);
  vec2 inkA = aDir;
  vec2 inkP = vec2(-inkA.y, inkA.x);
  vec3 tV3 = (modelViewMatrix * vec4(inkA.x, 0.0, inkA.y, 0.0)).xyz;
  vec3 nV3 = (modelViewMatrix * vec4(inkP.x, 0.0, inkP.y, 0.0)).xyz;
  bool inkCap = aCap.w > 0.5;
  bool inkScr = aCap.w > 1.5;
  // the highlight measures its directions on SCREEN, the perspective
  // divide's term included (inkLine.screenDir, inkCapCode 2)
  vec2 tV = inkScr ? tV3.xy + inkMv.xy * (tV3.z / max(-inkMv.z, 1e-3)) : tV3.xy;
  vec2 nV = inkScr ? nV3.xy + inkMv.xy * (nV3.z / max(-inkMv.z, 1e-3)) : nV3.xy;
  float fA = length(tV);
  // the on-screen THICKNESS across the axis: the normal's projection square
  // to the projected axis (inkLine.stripFacing)
  float fS = fA > 1e-3 ? abs(nV.x * tV.y - nV.y * tV.x) / fA : length(nV);
  // a soft band's outer edge (the selection halo), css px
  float inkSoft = aSoft * aCap.z;
  vec2 inkOff;
  // a highlight head's base shear (inkLine.headShear), 0 on a strip
  float inkShear = 0.0;
  if (aParam.x < 0.5) {
    // strip (inkLine.stripHalfWidth): world width grown by the capped
    // grazing factor, floored — and, for the highlight, CEILINGED — ON
    // SCREEN (both divide by the facing)
    float g = min(${f(INK_STRIP_GRAZE_MAX)}, 1.0 / max(fS, ${f(INK_STRIP_GRAZE_F_MIN)}));
    float fl = inkWpp / max(fS, ${f(INK_FLOOR_F_MIN)});
    float capK = inkCapK(inkWpp);
    float hw = max(abs(aLocal.y) * g, aParam.y * fl);
    if (aCap.x > 0.0) hw = min(hw, aCap.x * capK * fl);
    float inkD = aParam.z > 0.0 ? max(aParam.z * g, aParam.w * fl) : 0.0;
    if (aParam.z > 0.0 && aCap.y > 0.0) inkD = min(inkD, aCap.y * capK * fl);
    inkOff = vec2(0.0, sign(aMiter.y) * (hw + inkD + inkSoft * fl));
    // the closing vertex follows a capped head's base (inkCloseDistance)
    if (aEnd.x > 0.0 && inkCap) {
      vec3 hf = inkHeadFit(inkWpp, fA, fS, length(nV), true);
      inkOff.x = aEnd.x - min(aEnd.x, aEnd.x * hf.x * hf.y);
    }
  } else {
    // head (inkLine.headFit)
    float inkD = aParam.z > 0.0 ? max(aParam.z, aParam.w * inkWpp) : 0.0;
    if (aParam.z > 0.0 && aCap.y > 0.0) inkD = min(inkD, aCap.y * inkCapK(inkWpp) * inkWpp);
    float tt = dot(tV, tV);
    if (inkScr && tt > 1e-8) inkShear = clamp(dot(nV, tV) / tt, ${f(-INK_HEAD_SHEAR_MAX)}, ${f(INK_HEAD_SHEAR_MAX)});
    vec3 hf = inkHeadFit(inkWpp, fA, fS, length(nV - inkShear * tV), inkCap);
    inkOff = vec2(aLocal.x * hf.x * hf.y, aLocal.y * hf.x * hf.z) + aMiter * (inkD + inkSoft * inkWpp);
  }
  vec2 inkW = inkA * (inkOff.x - inkShear * inkOff.y) + inkP * inkOff.y;
  transformed.x += inkW.x;
  transformed.z += inkW.y;
  vInkArc = aArc;
  vInkDash = aDash;
  vInkSoft = aSoft;
  vInkBead = aEnd.y;
}
`
export const INK_FRAGMENT_DECL = /* glsl */ `
uniform float uInkWppTarget;
uniform float uInkPhase;
uniform float uInkBeadK;
varying float vInkArc;
varying vec3 vInkDash;
varying float vInkSoft;
varying float vInkBead;
`
export const INK_FRAGMENT_BODY = /* glsl */ `
  if (vInkDash.y > 0.0) {
    float inkScale = max(1.0, ${f(INK_DASH_MIN_CSS)} * uInkWppTarget / vInkDash.y);
    if (mod(vInkArc / inkScale + vInkDash.z, vInkDash.y) > vInkDash.x) discard;
  }
`
/** After `#include <color_fragment>`: the soft band's falloff and the flow
 * bead (inkPacketWeight / inkPacketFade are its CPU mirror). */
export const INK_FRAGMENT_COLOR = /* glsl */ `
  diffuseColor.a *= 1.0 - smoothstep(0.0, 1.0, vInkSoft);
  if (vInkBead > 0.0 && uInkPhase >= 0.0) {
    float bw = uInkWppTarget;
    float bPos = uInkPhase * vInkBead;
    // its clearance fade, measured on screen per frame (inkPacketFade)
    float bFade = uInkBeadK;
    float bd = vInkArc - bPos;
    float bHalf = ${f(INK_PACKET.lenCss / 2)} * bw;
    float bBody = 1.0 - smoothstep(bHalf - 0.75 * bw, bHalf + 0.75 * bw, abs(bd));
    float bTail = bd < 0.0 ? clamp(1.0 + (bd + bHalf) / (${f(INK_PACKET.tailCss)} * bw), 0.0, 1.0) : 0.0;
    float bK = max(${f(INK_PACKET.opacity)} * bBody, ${f(INK_PACKET.tailOpacity)} * bTail);
    // the bead's colour inside the core only (a soft band is never tinted:
    // the bead stays the core's width) …
    float bSoft = step(0.001, vInkSoft);
    diffuseColor.rgb = mix(diffuseColor.rgb, ${vec3Of(beadLinear)}, bK * bFade * (1.0 - bSoft));
    // … and a soft band (the dark board's coral glow) brightens round it
    diffuseColor.a *= 1.0 + 0.5 * bFade * (1.0 - smoothstep(0.0, ${f(INK_PACKET.glintCss)} * bw, abs(bd))) * bSoft;
  }
`

/** A material's own bead fade (uInkBeadK): one per ink material, the program
 * shared (a uniform's value is not part of the program key). */
export function inkBeadUniform(mat: THREE.Material): THREE.IUniform<number> {
  const u = mat.userData.inkBeadK as THREE.IUniform<number> | undefined
  if (u) return u
  const made = { value: 0 }
  mat.userData.inkBeadK = made
  return made
}

/** Patch a MeshBasicMaterial into an ink material (one program for every
 * ink material: the cache key is fixed, the uniforms shared — but the bead
 * fade, uInkBeadK, which is the material's own). */
export function patchInkMaterial(mat: THREE.MeshBasicMaterial, uniforms: InkUniforms): void {
  const beadK = inkBeadUniform(mat)
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uInkViewH = uniforms.uInkViewH
    shader.uniforms.uInkWppTarget = uniforms.uInkWppTarget
    shader.uniforms.uInkPhase = uniforms.uInkPhase
    shader.uniforms.uInkBeadK = beadK
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${INK_VERTEX_DECL}\nvoid main() {`)
      .replace('#include <begin_vertex>', INK_VERTEX_BODY)
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${INK_FRAGMENT_DECL}\nvoid main() {\n${INK_FRAGMENT_BODY}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${INK_FRAGMENT_COLOR}`)
  }
  mat.customProgramCacheKey = () => 'connInk-5'
}
