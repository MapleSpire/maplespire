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
import { describe, expect, it } from 'vitest'
import {
  buildInkGeometry,
  dashFor,
  headFit,
  inkCapGrowth,
  INK_CAP_GROWTH,
  INK_CAP_GROWTH_MAX,
  INK_CAP_REF_WPP,
  INK_CASING_MIN_CSS,
  INK_CORE_MAX_CSS,
  INK_HALO_MAX_CSS,
  INK_RIM_MAX_CSS,
  INK_HEAD_SHEAR_MAX,
  INK_FRAGMENT_DECL,
  headShear,
  inkCapCode,
  linearAlphaFor,
  INK_CORE_MIN_CSS,
  INK_CORE_W,
  INK_RIM_MIN_CSS,
  INK_DARK_ON_LIGHT,
  INK_DASH_MIN_CSS,
  INK_DASHED,
  INK_DIM_OPACITY,
  INK_FRAGMENT_BODY,
  INK_DOTTED,
  INK_FLOOR_F_MIN,
  INK_HALO_OPACITY,
  INK_HEAD_HALF_W,
  INK_HEAD_LEN,
  INK_HEAD_MIN_CSS,
  INK_HEAD_MIN_WIDTH_CSS,
  INK_HEAD_STRETCH_MAX,
  INK_STRIP_GRAZE_MAX,
  inkHeadOnDisc,
  inkRouteToHead,
  inkStartOnDisc,
  INK_HIGHLIGHT_MIN_CSS,
  INK_HIGHLIGHT_MAX_CSS,
  INK_HIGHLIGHT_RIM_MAX_CSS,
  INK_HIGHLIGHT_RIM_MIN_CSS,
  INK_HIGHLIGHT_RIM_W,
  INK_HIGHLIGHT_W,
  INK_HEAD_MAX_CSS,
  INK_HEAD_MAX_WIDTH_CSS,
  INK_FRAGMENT_COLOR,
  INK_PACKET,
  INK_SELECT_HALO,
  INK_VERTEX_DECL,
  inkCloseDistance,
  inkPacketFade,
  inkPacketWeight,
  screenDir,
  stripCasingWidthPx,
  INK_LIGHT_ON_DARK,
  INK_LOWER_W,
  INK_SETS,
  INK_VERTEX_BODY,
  inkHeadTriangle,
  inkSetFor,
  inkStyle,
  patchInkMaterial,
  createInkUniforms,
  stripCoreWidthPx,
  stripFacing,
  stripGraze,
  stripHalfWidth,
  type InkSetId,
} from './inkLine'
import { contrastRatio, resolve3dPalette, colorAlpha } from './palette'
import { TRAY_BASE_CSS, TRAY_VARIANTS } from './lit/boards'
import { studioSkin } from '../skins/studioSkin'
import { studioSkinDark } from '../skins/studioSkinDark'

const base = {
  set: 'darkInk' as InkSetId,
  highlighted: false,
  lower: false,
  perspectiveCss: null,
  highlightCss: '#D97A3D',
  focusDimmed: false,
  previewAlpha: 1,
}

describe('ink set — the board decides, not the appearance', () => {
  // the honey wood as RENDERED (design spec measurement, tp9-final-dpr1,
  // avg #D19B5D) and its paint
  it('the ink reads >= 3:1 on lit honey wood, Clean and Studio 2D strokes do not', () => {
    expect(contrastRatio(INK_DARK_ON_LIGHT.core, '#D19B5D')).toBeGreaterThanOrEqual(4.5)
    // control: the strokes the user rejected or wants back, on the same wood
    expect(contrastRatio('#C9C3BA', '#D19B5D')).toBeLessThan(1.5)
    expect(contrastRatio('#B7B1A8', '#D19B5D')).toBeLessThan(1.5)
  })

  it('every tray variant × appearance picks a set reading >= 3:1 on its base', () => {
    const boards: { name: string; css: string }[] = [
      ...TRAY_VARIANTS.map((v) => ({ name: v, css: TRAY_BASE_CSS[v] })),
      { name: 'paper (light)', css: colorAlpha(resolve3dPalette(studioSkin).floorBg).color },
      { name: 'paper (dark)', css: colorAlpha(resolve3dPalette(studioSkinDark).floorBg).color },
    ]
    for (const b of boards) {
      const pick = inkSetFor(b.css)
      expect(pick.contrast, `${b.name} ${b.css} -> ${pick.id}`).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(INK_SETS[pick.id].core, b.css)).toBeCloseTo(pick.contrast, 9)
    }
  })

  it('a honey-wood tray keeps the dark ink whatever the appearance; a dark board takes the light ink', () => {
    expect(inkSetFor(TRAY_BASE_CSS.wood).id).toBe('darkInk')
    expect(inkSetFor('#242019').id).toBe('lightInk')
    expect(contrastRatio(INK_LIGHT_ON_DARK.core, '#242019')).toBeGreaterThanOrEqual(9)
  })
})

describe('inkStyle — colour, width and casing per state', () => {
  it('normal: the ink core, 2.6 wide, a cream halo at 0.55', () => {
    const s = inkStyle(base)
    expect(s.core).toBe(INK_DARK_ON_LIGHT.core)
    expect(s.width).toBe(INK_CORE_W)
    expect(s.width).toBeGreaterThan(Math.max(2.2, 1.6 * 1.2)) // heavier than Clean 3D's
    expect(s.minCss).toBe(INK_CORE_MIN_CSS)
    expect(s.opacity).toBe(1)
    expect(s.casing).toMatchObject({ kind: 'halo', css: INK_DARK_ON_LIGHT.halo, opacity: INK_HALO_OPACITY, width: 1 })
  })

  it('lower: the lighter ink, 2.2 wide, same halo', () => {
    const s = inkStyle({ ...base, lower: true })
    expect(s.core).toBe(INK_DARK_ON_LIGHT.lower)
    expect(s.width).toBe(INK_LOWER_W)
    expect(s.casing?.kind).toBe('halo')
    expect(contrastRatio(s.core, '#D19B5D')).toBeGreaterThanOrEqual(3)
  })

  it('highlighted: the skin highlight, 3.5 wide, an opaque ink rim (no halo) — both edges >= 3:1 on wood', () => {
    const s = inkStyle({ ...base, highlighted: true, perspectiveCss: '#00AA00' })
    expect(s.core).toBe('#D97A3D')
    expect(s.width).toBe(INK_HIGHLIGHT_W)
    expect(INK_HIGHLIGHT_W).toBe(3.5)
    expect(s.minCss).toBe(INK_HIGHLIGHT_MIN_CSS)
    expect(s.maxCss).toBe(INK_HIGHLIGHT_MAX_CSS)
    expect(s.headCap).toBe(true)
    expect(s.screen).toBe(true)
    expect(s.casing).toMatchObject({
      kind: 'rim',
      css: INK_DARK_ON_LIGHT.rim,
      opacity: 1,
      width: INK_HIGHLIGHT_RIM_W,
      minCss: INK_HIGHLIGHT_RIM_MIN_CSS,
      maxCss: INK_HIGHLIGHT_RIM_MAX_CSS,
    })
    // highlighted because its source card is selected: no selection halo
    expect(s.select).toBeNull()
    // the halo keeps the thinner floor
    expect(inkStyle(base).casing?.minCss).toBe(INK_CASING_MIN_CSS)
    expect(contrastRatio(s.core, s.casing!.css)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(s.casing!.css, '#D19B5D')).toBeGreaterThanOrEqual(3)
    // control: the coral alone on the wood is what disappeared
    expect(contrastRatio(s.core, '#D19B5D')).toBeLessThan(1.5)
  })

  it('a perspective colour is kept verbatim, with a 0.7 ink rim', () => {
    const s = inkStyle({ ...base, perspectiveCss: '#4C8BF5' })
    expect(s.core).toBe('#4C8BF5')
    expect(s.casing).toMatchObject({ kind: 'rim', width: 0.7, opacity: 1, minCss: INK_RIM_MIN_CSS })
  })

  it('the UNSELECTED lines keep their widths and measure, under projected CEILINGS: core 3, halo 1.25, rim 1.5, a capped head', () => {
    for (const input of [base, { ...base, lower: true }, { ...base, perspectiveCss: '#4C8BF5' }, { ...base, focusDimmed: true }, { ...base, set: 'lightInk' as InkSetId }]) {
      const s = inkStyle({ ...input, selected: true })
      expect(s.maxCss, JSON.stringify(input)).toBe(INK_CORE_MAX_CSS)
      expect(s.headCap).toBe(true)
      expect(s.screen).toBe(false)
      expect(s.select).toBeNull()
      if (s.casing) expect(s.casing.maxCss).toBe(s.casing.kind === 'halo' ? INK_HALO_MAX_CSS : INK_RIM_MAX_CSS)
    }
    expect(inkStyle(base).width).toBe(2.6)
    expect(inkCapCode(true, false)).toBe(1)
    expect(inkCapCode(true, true)).toBe(2)
    expect(inkCapCode(false, true)).toBe(0)
  })

  it("at the whole-board fit (wpp ~1.3, workbench-arrows-default) no ceiling binds: 1a03e0865's look there is unchanged", () => {
    // (the first to bind is the head's 14-css base, at wpp < 15 / 14 ≈ 1.07)
    for (const wpp of [1.08, 1.2, 1.32, 2]) {
      for (const f of [1, 0.7, 0.5]) {
        const s = inkStyle(base)
        expect(stripCoreWidthPx(s.width, s.minCss, wpp, f, s.maxCss)).toBeCloseTo(stripCoreWidthPx(s.width, s.minCss, wpp, f), 9)
        const c = s.casing!
        expect(stripCasingWidthPx(c.width, c.minCss, c.maxCss, wpp, f)).toBeCloseTo(stripCasingWidthPx(c.width, c.minCss, 0, wpp, f), 9)
        expect(headFit(wpp, f, f, true)).toEqual(headFit(wpp, f, f))
      }
    }
    // control: up close they bind (the review's inverted hierarchy)
    expect(stripCoreWidthPx(INK_CORE_W, INK_CORE_MIN_CSS, 0.3, 1, INK_CORE_MAX_CSS)).toBeCloseTo(INK_CORE_MAX_CSS * inkCapGrowth(0.3), 9)
    expect(stripCoreWidthPx(INK_CORE_W, INK_CORE_MIN_CSS, 0.3, 1, INK_CORE_MAX_CSS)).toBeLessThan(2.6 / 0.3)
    expect(stripCoreWidthPx(INK_CORE_W, INK_CORE_MIN_CSS, 0.3, 1)).toBeCloseTo(2.6 / 0.3, 9)
  })

  it('the ONE selected line wears the selection halo: cream on a light board, its own coral glow on a dark one', () => {
    const light = inkStyle({ ...base, highlighted: true, selected: true })
    expect(light.select).toEqual({ css: '#FBF4E8', opacity: INK_SELECT_HALO.darkInk.opacity, widthCss: 4 })
    expect(INK_SELECT_HALO.darkInk.opacity).toBeCloseTo(linearAlphaFor('#FBF4E8', '#D0995A', 0.65), 2)
    const dark = inkStyle({ ...base, set: 'lightInk', highlightCss: '#E89456', highlighted: true, selected: true })
    expect(dark.select).toEqual({ css: '#E89456', opacity: INK_SELECT_HALO.lightInk.opacity, widthCss: 5 })
    // the board blends in LINEAR light: the spec's sRGB 0.30 coral glow on
    // the dark stone is 0.135 linear (round 2 drew 0.30 linear: ~0.49
    // effective in the PNG, a second stroke)
    expect(INK_SELECT_HALO.lightInk.opacity).toBeCloseTo(linearAlphaFor('#E89456', '#2E2923', 0.3), 2)
    expect(linearAlphaFor('#E89456', '#2E2923', 0.3)).toBeLessThan(0.2)
    // control: a mid-grey over itself-ish keeps its alpha; full is full
    expect(linearAlphaFor('#E89456', '#2E2923', 1)).toBeCloseTo(1, 4)
    expect(linearAlphaFor('#E89456', '#2E2923', 0)).toBeCloseTo(0, 4)
    expect(INK_SELECT_HALO.darkInk.css).toBe(INK_DARK_ON_LIGHT.halo)
    // the hidden-tag preview multiplies it like the core
    expect(inkStyle({ ...base, highlighted: true, selected: true, previewAlpha: 0.4 }).select?.opacity).toBeCloseTo(INK_SELECT_HALO.darkInk.opacity * 0.4, 9)
    // why a halo on the wood: coral alone reads ~1.0-1.3:1 there (WCAG on
    // the hex values; the measured wood #D0995A)
    expect(contrastRatio('#D97A3D', '#D0995A')).toBeLessThan(1.35)
    expect(contrastRatio('#E89456', '#D0995A')).toBeLessThan(1.1)
    // …and on the dark stone the coral itself reads (measured #2E2923)
    expect(contrastRatio('#E89456', '#2E2923')).toBeGreaterThanOrEqual(4.5)
  })

  it('focus-dimmed: blended over the lit wood it lands mid-band (1.3-1.8:1), not at its floor', () => {
    // linear blend of the ink (L 0.037) over the wood (L 0.38) — the model
    // that predicts the PNG's 1.30-1.34 median at round 1's 0.30
    const lumOf = (css: string) => (contrastRatio(css, '#000000') - 1) * 0.05
    const blended = (a: number) => (1 - a) * lumOf('#D19B5D') + a * lumOf(INK_DARK_ON_LIGHT.core)
    const ratio = (a: number) => (lumOf('#D19B5D') + 0.05) / (blended(a) + 0.05)
    expect(ratio(0.3)).toBeLessThan(1.33)
    expect(ratio(INK_DIM_OPACITY)).toBeGreaterThanOrEqual(1.45)
    expect(ratio(INK_DIM_OPACITY)).toBeLessThanOrEqual(1.6)
  })

  it('focus-dimmed: core dimmed, the halo gone, a rim dimmed alike; the hidden-tag preview multiplies', () => {
    expect(inkStyle({ ...base, focusDimmed: true })).toMatchObject({ opacity: INK_DIM_OPACITY, casing: null })
    const p = inkStyle({ ...base, focusDimmed: true, perspectiveCss: '#4C8BF5' })
    expect(p.opacity).toBe(INK_DIM_OPACITY)
    expect(p.casing?.opacity).toBe(INK_DIM_OPACITY)
    const preview = inkStyle({ ...base, previewAlpha: 0.4 })
    expect(preview.opacity).toBeCloseTo(0.4, 9)
    expect(preview.casing?.opacity).toBeCloseTo(INK_HALO_OPACITY * 0.4, 9)
  })

  it('the dark set: Clean stroke core, dark halo and rim', () => {
    const s = inkStyle({ ...base, set: 'lightInk', highlightCss: '#E89456', highlighted: true })
    expect(s.casing?.css).toBe(INK_LIGHT_ON_DARK.rim)
    expect(inkStyle({ ...base, set: 'lightInk' }).core).toBe('#C9C3BA')
  })
})

describe('the shader math (CPU mirror) — widths, head, dashes', () => {
  it('a core never projects under its floor where the line is seen square', () => {
    for (const wpp of [0.2, 0.5, 1, 2, 4]) {
      expect(stripCoreWidthPx(INK_CORE_W, INK_CORE_MIN_CSS, wpp, 1)).toBeGreaterThanOrEqual(INK_CORE_MIN_CSS - 1e-9)
      expect(stripCoreWidthPx(INK_HIGHLIGHT_W, INK_HIGHLIGHT_MIN_CSS, wpp, 1)).toBeGreaterThanOrEqual(INK_HIGHLIGHT_MIN_CSS - 1e-9)
    }
    // up close the world width wins (no upper cap): it scales with the zoom
    expect(stripCoreWidthPx(INK_CORE_W, INK_CORE_MIN_CSS, 0.25, 1)).toBeCloseTo(INK_CORE_W / 0.25, 9)
  })

  it('facing is measured SQUARE to the projected line, not as the projected normal\'s length', () => {
    // seen across the screen from 15 deg up: the normal shrinks to sin 15
    expect(stripFacing({ x: 1, y: 0 }, { x: 0, y: 0.26 })).toBeCloseTo(0.26, 9)
    // a slanted view: the projected normal (6, -2) leans along the line
    // (0.98, 0.21) — the thickness is the square part only (ink-debug)
    const t = { x: 0.98, y: 0.21 }
    const n = { x: 0.6, y: -0.2 }
    expect(stripFacing(t, n)).toBeLessThan(Math.hypot(n.x, n.y) * 0.65)
    expect(stripFacing(t, n)).toBeCloseTo(Math.abs(n.x * t.y - n.y * t.x) / Math.hypot(t.x, t.y), 9)
    // a line pointing at the camera (no projected direction): the normal's length
    expect(stripFacing({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(1)
  })

  it('grazing: the world width grows at most 2.2x (no road stripes up close); the ON-SCREEN floor holds down to the orbit clamp', () => {
    expect(stripGraze(1)).toBe(1)
    expect(stripGraze(0.5)).toBeCloseTo(2, 9)
    expect(stripGraze(0.26)).toBe(INK_STRIP_GRAZE_MAX)
    expect(INK_STRIP_GRAZE_MAX).toBe(2.2)
    // up close at the low pose (polar 75: f ≈ sin 15°), a near run draws its
    // world width × 2.2 — round 1's 4× drew 5-7 px stripes there
    const f15 = Math.sin((15 * Math.PI) / 180)
    const near = 0.5
    expect(stripCoreWidthPx(INK_CORE_W, INK_CORE_MIN_CSS, near, f15)).toBeCloseTo((INK_CORE_W * 2.2 * f15) / near, 9)
    expect(stripCoreWidthPx(INK_CORE_W, INK_CORE_MIN_CSS, near, f15)).toBeLessThan(3.2)
    // far and foreshortened: the projected floor carries it, down to the
    // orbit's 78° clamp (f ≈ sin 12°)
    for (const wpp of [1, 2, 4]) {
      for (const f of [1, 0.5, 0.3, f15, Math.sin((12 * Math.PI) / 180), INK_FLOOR_F_MIN]) {
        expect(stripCoreWidthPx(INK_CORE_W, INK_CORE_MIN_CSS, wpp, f)).toBeGreaterThanOrEqual(INK_CORE_MIN_CSS - 1e-9)
      }
    }
    // control: under INK_FLOOR_F_MIN the floor gives way
    expect(stripCoreWidthPx(INK_CORE_W, INK_CORE_MIN_CSS, 4, 0.1)).toBeLessThan(INK_CORE_MIN_CSS)
    // the casing adds its own grown / floored width per side
    expect(stripHalfWidth(INK_CORE_W, INK_CORE_MIN_CSS, 1, 0.75, 1, 1)).toBeCloseTo(1.3 + 1, 9)
    expect(stripHalfWidth(INK_CORE_W, INK_CORE_MIN_CSS, 1, 0.75, 4, 1)).toBeCloseTo(0.875 * 4 + 0.75 * 4, 9)
    expect(stripHalfWidth(INK_CORE_W, INK_CORE_MIN_CSS, 1, 0.75, 0.25, 0.5)).toBeCloseTo(1.3 * 2 + 1 * 2, 9)
  })

  it('the head is 15 long, ±7.5 wide, its tip on the target point; seen square it is the 2D head', () => {
    const tri = inkHeadTriangle({ x: 100, z: 50, angle: Math.PI / 2, y: 0 })
    expect(tri[0]).toEqual({ x: 100, z: 50 })
    const back = { x: (tri[1].x + tri[2].x) / 2, z: (tri[1].z + tri[2].z) / 2 }
    expect(Math.hypot(back.x - 100, back.z - 50)).toBeCloseTo(INK_HEAD_LEN, 9)
    expect(Math.hypot(tri[1].x - tri[2].x, tri[1].z - tri[2].z)).toBeCloseTo(2 * INK_HEAD_HALF_W, 9)
    // seen square, big enough: no scale, no stretch
    expect(headFit(0.5, 1, 1)).toEqual({ s: 1, along: 1, across: 1 })
    // a stretched triangle keeps its tip
    expect(inkHeadTriangle({ x: 3, z: 4, angle: 1, y: 0 }, 1.4, 2, 3)[0]).toEqual({ x: 3, z: 4 })
  })

  it('a head never projects shorter than 11 css px nor narrower than 10, foreshortened or far, up to the stretch cap', () => {
    for (const wpp of [0.3, 0.733, 1, 2, 5]) {
      // (far away the uniform floor scale already binds, and the stretch
      // cap with it past f = 1/3; the low pose's heads sit at wpp <= 1)
      const fs = wpp <= 1 ? [1, 0.7, 0.5, 0.26] : [1, 0.7, 0.5, 0.34]
      for (const fA of fs) {
        for (const fW of fs) {
          const h = headFit(wpp, fA, fW)
          expect((INK_HEAD_LEN * h.s * h.along * fA) / wpp, `len wpp ${wpp} fA ${fA}`).toBeGreaterThanOrEqual(INK_HEAD_MIN_CSS - 1e-9)
          expect((2 * INK_HEAD_HALF_W * h.s * h.across * fW) / wpp, `width wpp ${wpp} fW ${fW}`).toBeGreaterThanOrEqual(INK_HEAD_MIN_WIDTH_CSS - 1e-9)
          expect(h.along).toBeLessThanOrEqual(INK_HEAD_STRETCH_MAX)
          expect(h.across).toBeLessThanOrEqual(INK_HEAD_STRETCH_MAX)
        }
      }
    }
    // the low pose's 'publishes' head (design review round 2: an ~8 × 5 px
    // sliver): its base, seen from 15° up, is stretched across
    const low = headFit(0.8, 0.95, Math.sin((15 * Math.PI) / 180))
    expect(low.across).toBeGreaterThan(1.6)
    // seen edge-on the stretch stops at its cap
    expect(headFit(1, 0.01, 0.01)).toMatchObject({ along: INK_HEAD_STRETCH_MAX, across: INK_HEAD_STRETCH_MAX })
  })

  it('the highlight is held in a projected BAND: core 2.5-4 css, rim 1.5 per side, at every zoom and down to the orbit clamp', () => {
    const fs = [1, 0.7, 0.5, 0.3, Math.sin((12 * Math.PI) / 180)]
    for (const wpp of [0.05, 0.1, 0.25, 0.42, 0.61, 1, 2, 4]) {
      for (const f of fs) {
        const core = stripCoreWidthPx(INK_HIGHLIGHT_W, INK_HIGHLIGHT_MIN_CSS, wpp, f, INK_HIGHLIGHT_MAX_CSS)
        expect(core, `core wpp ${wpp} f ${f}`).toBeGreaterThanOrEqual(INK_HIGHLIGHT_MIN_CSS - 1e-9)
        expect(core, `core wpp ${wpp} f ${f}`).toBeLessThanOrEqual(INK_HIGHLIGHT_MAX_CSS * inkCapGrowth(wpp) + 1e-9)
        const rim = stripCasingWidthPx(INK_HIGHLIGHT_RIM_W, INK_HIGHLIGHT_RIM_MIN_CSS, INK_HIGHLIGHT_RIM_MAX_CSS, wpp, f)
        expect(rim, `rim wpp ${wpp} f ${f}`).toBeGreaterThanOrEqual(INK_HIGHLIGHT_RIM_MIN_CSS - 1e-9)
        expect(rim, `rim wpp ${wpp} f ${f}`).toBeLessThanOrEqual(INK_HIGHLIGHT_RIM_MAX_CSS * inkCapGrowth(wpp) + 1e-9)
      }
    }
    // the user's framing (~0.42 world px per css px): today's ribbon was 3.4
    // world + 2 × 0.8 rim ≈ 12 css px; now <= 4 + 2 × 1.5
    expect(stripCoreWidthPx(3.4, 2.5, 0.42, 1) + 2 * (0.8 / 0.42)).toBeGreaterThan(11.5)
    expect(stripCoreWidthPx(INK_HIGHLIGHT_W, INK_HIGHLIGHT_MIN_CSS, 0.42, 1, INK_HIGHLIGHT_MAX_CSS)).toBeCloseTo(4 * inkCapGrowth(0.42), 9)
    expect((4 + 2 * 1.5) * inkCapGrowth(0.42)).toBeLessThan(11.5)
    // control: no ceiling, the world width wins up close
    expect(stripCoreWidthPx(INK_HIGHLIGHT_W, INK_HIGHLIGHT_MIN_CSS, 0.1, 1)).toBeCloseTo(35, 9)
    // the unselected core is ceilinged too (3 css)
    expect(stripCoreWidthPx(INK_CORE_W, INK_CORE_MIN_CSS, 0.1, 1, inkStyle(base).maxCss)).toBeCloseTo(3 * INK_CAP_GROWTH_MAX, 9)
    // a casing ceiling caps only a casing that exists
    expect(stripHalfWidth(INK_CORE_W, INK_CORE_MIN_CSS, 0, 0, 0.1, 1, 0, 1.25)).toBeCloseTo(1.3, 9)
  })

  it('the selected core stays >= 1.33x an unselected core at the same spot, at every zoom and facing (spec §2.4)', () => {
    const sel = inkStyle({ ...base, highlighted: true, selected: true })
    const plain = inkStyle(base)
    let worst = Infinity
    for (let wpp = 0.05; wpp <= 4; wpp *= 1.07) {
      for (const f of [1, 0.8, 0.6, 0.45, 0.3, 0.21]) {
        const a = stripCoreWidthPx(sel.width, sel.minCss, wpp, f, sel.maxCss)
        const b = stripCoreWidthPx(plain.width, plain.minCss, wpp, f, plain.maxCss)
        worst = Math.min(worst, a / b)
      }
    }
    expect(worst).toBeGreaterThanOrEqual(4 / 3 - 1e-9)
    // control: the spec's 3.0 world drew only 3.0 / 2.6 = 1.15x between the
    // floors and the ceilings
    expect(stripCoreWidthPx(3.0, sel.minCss, 1, 1, sel.maxCss) / stripCoreWidthPx(plain.width, plain.minCss, 1, 1, plain.maxCss)).toBeLessThan(1.2)
  })

  it('a CAPPED head stays 11-16 css long and <= 14 wide (corner to corner) at every zoom, shrinking below its world size up close', () => {
    for (const wpp of [0.05, 0.1, 0.2, 0.42, 0.61, 1, 1.5, 3]) {
      // (far away the uncapped stretch cap binds past f = 1/3, as for every
      // head — the existing floor test's domain)
      // (0.21: the low pose's axis at the orbit clamp — a SHRUNK head (s < 1,
      // wpp < 15/16) needs more than 3× along there, the stretch it may take
      // back; at s = 1 the shared 3× cap binds as for every head)
      const fs = wpp < 0.9 ? [1, 0.7, 0.4, 0.25, 0.21] : wpp <= 1 ? [1, 0.7, 0.4, 0.25] : [1, 0.7, 0.5, 0.34]
      for (const fA of fs) {
        for (const fW of fs) {
          for (const skew of [1, 1.6]) {
            const nW = Math.min(1, fW * skew)
            const h = headFit(wpp, fA, fW, true, nW)
            const len = (INK_HEAD_LEN * h.s * h.along * fA) / wpp
            const corner = (2 * INK_HEAD_HALF_W * h.s * h.across * Math.max(nW, fW)) / wpp
            const thick = (2 * INK_HEAD_HALF_W * h.s * h.across * fW) / wpp
            const at = `wpp ${wpp} fA ${fA} fW ${fW} nW ${nW}`
            expect(len, at).toBeGreaterThanOrEqual(INK_HEAD_MIN_CSS - 1e-9)
            expect(len, at).toBeLessThanOrEqual(INK_HEAD_MAX_CSS * inkCapGrowth(wpp) + 1e-9)
            // the base's thickness holds its floor (the floor wins); its
            // corners are capped unless the floor needs them further apart
            expect(thick, at).toBeGreaterThanOrEqual(INK_HEAD_MIN_WIDTH_CSS - 1e-9)
            expect(corner, at).toBeLessThanOrEqual(Math.max(INK_HEAD_MAX_WIDTH_CSS * inkCapGrowth(wpp),(INK_HEAD_MIN_WIDTH_CSS * Math.max(nW, fW)) / fW) + 1e-9)
          }
        }
      }
    }
    // up close it shrinks (s < 1): the close-target framing measured 110 px
    expect(headFit(0.1, 1, 1, true).s).toBeCloseTo((16 * INK_CAP_GROWTH_MAX * 0.1) / 15, 9)
    expect((INK_HEAD_LEN * headFit(0.1, 1, 1).s) / 0.1).toBeCloseTo(150, 9)
    // seen square at a mid zoom it is the 2D head's size, base narrower
    const sq = headFit(0.8, 1, 1, true)
    expect((INK_HEAD_LEN * sq.s * sq.along) / 0.8).toBeCloseTo(16 * inkCapGrowth(0.8), 9)
    expect((2 * INK_HEAD_HALF_W * sq.s * sq.across) / 0.8).toBeCloseTo(14 * inkCapGrowth(0.8), 9)
    // the uncapped head is 1a03e0865's
    expect(headFit(0.1, 1, 1)).toEqual({ s: 1, along: 1, across: 1 })
    expect(headFit(0.1, 1, 1, false, 1)).toEqual(headFit(0.1, 1, 1))
    // the review's low-pose head: a base seen from 15° up (fW 0.26) and
    // skewed (corners 4× further apart than its thickness) — the corner
    // ceiling used to win and squeeze it to the line's width
    const low = headFit(0.8, 0.95, 0.26, true, 1.04)
    expect((2 * INK_HEAD_HALF_W * low.s * low.across * 0.26) / 0.8).toBeGreaterThanOrEqual(INK_HEAD_MIN_WIDTH_CSS - 1e-9)
    // …and the shader takes the floor last, like the mirror
    expect(INK_VERTEX_DECL).toContain(`min(stMax, ${INK_HEAD_MIN_WIDTH_CSS}.0 * kW));\n  }`)
    expect(INK_VERTEX_DECL).toContain(`min(stMax, ${INK_HEAD_MIN_CSS}.0 * kA));`)
  })

  it('a highlight head is sheared so its base lies SQUARE to its on-screen axis (headShear)', () => {
    // square view: no shear (the 2D head)
    expect(headShear({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(0)
    // the low pose's measured skew (tip -> base (10.8, 2.4), corners 23 px
    // apart along the line)
    const tV = { x: 0.95, y: 0.21 }
    const nV = { x: 0.9, y: -0.08 }
    const k = headShear(tV, nV)
    const across = { x: nV.x - k * tV.x, y: nV.y - k * tV.y }
    expect(Math.abs(across.x * tV.x + across.y * tV.y)).toBeLessThan(1e-9)
    // its length is the thickness (stripFacing)
    expect(Math.hypot(across.x, across.y)).toBeCloseTo(stripFacing(tV, nV), 9)
    // the triangle: project the plan with [tV nV] in the head's frame
    const h = { x: 0, z: 0, angle: 0, y: 0 }
    const tri = inkHeadTriangle(h, 1, 1, 1, k)
    const scr = (p: { x: number; z: number }) => ({ x: p.x * tV.x + p.z * nV.x, y: p.x * tV.y + p.z * nV.y })
    const [a, b] = [scr(tri[1]), scr(tri[2])]
    expect(Math.abs((a.x - b.x) * tV.x + (a.y - b.y) * tV.y)).toBeLessThan(1e-9)
    // control: unsheared, the corners lie mostly ALONG the axis
    const raw = inkHeadTriangle(h)
    const [ra, rb] = [scr(raw[1]), scr(raw[2])]
    expect(Math.abs((ra.x - rb.x) * tV.x + (ra.y - rb.y) * tV.y) / Math.hypot(tV.x, tV.y)).toBeGreaterThan(10)
    // a line seen end-on: clamped
    expect(headShear({ x: 0.01, y: 0 }, { x: 1, y: 0 })).toBe(INK_HEAD_SHEAR_MAX)
    expect(headShear({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(0)
    // the shader shears the head branch only, by the same clamp
    expect(INK_VERTEX_BODY).toContain('vec2 inkW = inkA * (inkOff.x - inkShear * inkOff.y) + inkP * inkOff.y;')
    expect(INK_VERTEX_BODY).toContain('if (inkScr && tt > 1e-8) inkShear = clamp(dot(nV, tV) / tt')
  })

  it("the closing vertex follows a capped head's base: 13 world px back at full size, scaled when it shrinks", () => {
    expect(inkCloseDistance(1, 1)).toBe(INK_HEAD_LEN - 2)
    expect(inkCloseDistance(2, 1.5)).toBe(INK_HEAD_LEN - 2)
    expect(inkCloseDistance(0.2, 1)).toBeCloseTo(13 * 0.2, 9)
    expect(inkCloseDistance(0.2, 2)).toBeCloseTo(13 * 0.4, 9)
    // the shader does the same (aEnd.x)
    expect(INK_VERTEX_BODY).toContain('inkOff.x = aEnd.x - min(aEnd.x, aEnd.x * hf.x * hf.y);')
  })

  it("screenDir adds the perspective divide's term off the screen centre (capped lines only)", () => {
    const d = { x: 0.6, y: 0.2, z: -0.77 }
    expect(screenDir(d, { x: 0, y: 0, z: -100 })).toEqual({ x: 0.6, y: 0.2 })
    const off = screenDir(d, { x: 40, y: -30, z: -100 })
    expect(off.x).toBeCloseTo(0.6 + 40 * (-0.77 / 100), 9)
    expect(off.y).toBeCloseTo(0.2 - 30 * (-0.77 / 100), 9)
    // the shader applies it only to the highlight (inkCapCode 2)
    expect(INK_VERTEX_BODY).toContain('bool inkScr = aCap.w > 1.5;')
    expect(INK_VERTEX_BODY).toContain('vec2 tV = inkScr ? tV3.xy + inkMv.xy * (tV3.z / max(-inkMv.z, 1e-3)) : tV3.xy;')
  })

  it("the ceilings are in the shader the CPU mirror describes", () => {
    expect(INK_VERTEX_BODY).toContain('if (aCap.x > 0.0) hw = min(hw, aCap.x * capK * fl);')
    expect(INK_VERTEX_BODY).toContain('if (aParam.z > 0.0 && aCap.y > 0.0) inkD = min(inkD, aCap.y * capK * fl);')
    expect(INK_VERTEX_DECL).toContain(`if (cap) s = min(${INK_HEAD_MAX_CSS}.0 * capK * w / ${INK_HEAD_LEN}.0, s);`)
    expect(INK_VERTEX_DECL).toContain(`return min(${INK_CAP_GROWTH_MAX}, pow(max(1.0, ${INK_CAP_REF_WPP} / max(w, 1e-6)), ${INK_CAP_GROWTH}));`)
  })

  it('USER 2026-10-12 "quand on zoom, la ligne devient de plus en plus fine": every ceiling grows with the zoom, sub-linearly, from 1 at the fit', () => {
    // at and beyond the fit nothing changes
    for (const wpp of [0.87, 1, 1.3, 3]) expect(inkCapGrowth(wpp)).toBe(1)
    // zooming in, the drawn width keeps growing (it was flat at 3 css)…
    const plain = inkStyle(base)
    let prev = 0
    for (const wpp of [0.87, 0.6, 0.43, 0.3, 0.21]) {
      const w = stripCoreWidthPx(plain.width, plain.minCss, wpp, 1, plain.maxCss)
      expect(w, `wpp ${wpp}`).toBeGreaterThan(prev + 0.3)
      prev = w
      // …slower than the cards (the world width, the 2D canvas)
      expect(w).toBeLessThanOrEqual(plain.width / wpp + 1e-9)
    }
    // control: the fixed 3-css ceiling the user saw
    expect(stripCoreWidthPx(plain.width, plain.minCss, 0.21, 1, plain.maxCss) / inkCapGrowth(0.21)).toBeCloseTo(3, 9)
    // a capped head grows too
    const len = (wpp: number) => {
      const h = headFit(wpp, 1, 1, true)
      return (INK_HEAD_LEN * h.s * h.along) / wpp
    }
    expect(len(0.3)).toBeGreaterThan(len(0.6) + 3)
    expect(len(0.6)).toBeGreaterThan(16)
  })

  it("the flow bead: a 9-css capsule at 0.95 with an 18-css tail, its body kept 12 css px clear of every handle and the head", () => {
    const wpp = 0.5
    expect(inkPacketWeight(0, wpp)).toBeCloseTo(INK_PACKET.opacity, 9)
    // ahead of the body: nothing; just behind it: the tail's top
    expect(inkPacketWeight(6 * wpp, wpp)).toBe(0)
    expect(inkPacketWeight(-(4.5 + 1) * wpp, wpp)).toBeCloseTo(INK_PACKET.tailOpacity * (1 - 1 / 18), 9)
    expect(inkPacketWeight(-(4.5 + 18) * wpp, wpp)).toBe(0)
    // the fade, from the on-screen clearance of its CENTRE: 0 while its body
    // edge (centre - 4.5) is within 12 css px, whole 8 px further
    expect(inkPacketFade(0)).toBe(0)
    expect(inkPacketFade(4.5 + 12)).toBe(0)
    expect(inkPacketFade(4.5 + 12 + 0.01)).toBeGreaterThan(0)
    expect(inkPacketFade(4.5 + 20)).toBe(1)
    expect(inkPacketFade(200)).toBe(1)
    // the shader takes it as a per-material uniform, not an arc estimate
    expect(INK_FRAGMENT_COLOR).toContain('float bFade = uInkBeadK;')
    expect(INK_FRAGMENT_DECL).toContain('uniform float uInkBeadK;')
    // the shader tints the core only (never a soft band) and brightens the glow
    expect(INK_FRAGMENT_COLOR).toContain('bK * bFade * (1.0 - bSoft)')
    expect(INK_PACKET.cycleMs).toBe(1500)
  })

  it("dashes are the 2D engine's [6, 4] / [2, 3]; a cased dash covers each end; the rhythm lengthens instead of aliasing", () => {
    expect(INK_DASHED).toEqual([6, 4])
    expect(INK_DOTTED).toEqual([2, 3])
    expect(dashFor(INK_DASHED, 0)).toEqual([6, 10, 0])
    expect(dashFor(INK_DASHED, 1)).toEqual([8, 10, 1])
    expect(dashFor(null, 1)).toEqual([0, 0, 0])
    // the fragment lengthens the rhythm to INK_DASH_MIN_CSS on screen from
    // the arc length (not the 24 sample points), and discards the gaps
    expect(INK_FRAGMENT_BODY).toContain(`${INK_DASH_MIN_CSS}.0 * uInkWppTarget / vInkDash.y`)
    expect(INK_FRAGMENT_BODY).toContain('mod(vInkArc / inkScale + vInkDash.z, vInkDash.y) > vInkDash.x')
  })
})

describe('drum ends — the line meets the pad circle, not the bounding rect', () => {
  // the Event bus drum of the harness board: a rect wider than its pad
  const pad = { x: 500, z: 300, r: 59 }
  const dist = (p: { x: number; z: number }) => Math.hypot(p.x - pad.x, p.z - pad.z)

  it('a head stopping short of the pad slides forward along its axis onto the circle', () => {
    // the 2D route ends on the rect's right edge (x 590), 14 px short of it
    const route = [
      { x: 800, y: 300 },
      { x: 700, y: 300 },
      { x: 604, y: 300 },
    ]
    const head = { x: 590, z: 300, angle: Math.PI, y: 0 }
    const out = inkHeadOnDisc(route, head, pad)
    expect(dist(out.head)).toBeCloseTo(pad.r, 9)
    expect(out.head.x).toBeCloseTo(559, 9)
    expect(out.head.angle).toBe(Math.PI)
    expect(out.pts).toEqual(route)
    // closed straight into the moved head: no gap, no curl
    const drawn = inkRouteToHead(out.pts, out.head)
    expect(drawn.at(-1)).toEqual({ x: 559 + INK_HEAD_LEN - 2, y: 300 })
    expect(drawn.slice(0, 3)).toEqual(route)
  })

  it('a head whose axis misses the circle stays where 2D puts it (control)', () => {
    const head = { x: 590, z: 400, angle: Math.PI, y: 0 }
    expect(inkHeadOnDisc([{ x: 700, y: 400 }], head, pad).head).toEqual(head)
  })

  it('a tip inside the pad (a rect smaller than the pad) moves back to where the route enters the circle', () => {
    const route = [
      { x: 700, y: 300 },
      { x: 600, y: 300 },
      { x: 550, y: 300 },
    ]
    const out = inkHeadOnDisc(route, { x: 536, z: 300, angle: Math.PI, y: 0 }, pad)
    expect(dist(out.head)).toBeCloseTo(pad.r, 9)
    expect(out.head.x).toBeCloseTo(559, 9)
    expect(out.pts).toEqual(route.slice(0, 2))
  })

  it('a route leaving a drum starts on the pad circle (+2): extended back, or cut where it leaves', () => {
    const out = inkStartOnDisc([{ x: 590, y: 300 }, { x: 700, y: 300 }], pad)
    expect(out[0].x).toBeCloseTo(561, 9)
    expect(out.slice(1)).toEqual([{ x: 590, y: 300 }, { x: 700, y: 300 }])
    const cut = inkStartOnDisc([{ x: 540, y: 300 }, { x: 555, y: 300 }, { x: 700, y: 300 }], pad)
    expect(cut[0].x).toBeCloseTo(561, 9)
    expect(cut.slice(1)).toEqual([{ x: 700, y: 300 }])
  })
})

describe('geometry and material', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 100, y: 10 },
  ]
  it('one geometry holds the strip and the head; every attribute the shader reads is there', () => {
    const g = buildInkGeometry({ pts, head: { x: 114, z: 12, angle: 0.1, y: 0.9 }, width: 2.6, minCss: 1.75, casing: 1, casingMinCss: 0.75, dash: INK_DASHED })!
    expect(g.getAttribute('position').count).toBe(pts.length * 2 + 3)
    for (const a of ['aDir', 'aLocal', 'aMiter', 'aParam', 'aArc', 'aDash']) expect(g.getAttribute(a), a).toBeDefined()
    // strip vertices carry the cased dash, head vertices are solid
    const dash = g.getAttribute('aDash')
    expect([dash.getX(0), dash.getY(0), dash.getZ(0)]).toEqual([8, 10, 1])
    expect([dash.getX(pts.length * 2), dash.getY(pts.length * 2)]).toEqual([0, 0])
    // the head sits on its tip at its own height
    const pos = g.getAttribute('position')
    expect([pos.getX(pts.length * 2), pos.getY(pts.length * 2), pos.getZ(pts.length * 2)]).toEqual([114, expect.closeTo(0.9, 6), 12])
    expect(g.index!.count).toBe((pts.length - 1) * 6 + 3)
  })

  it('a SOFT geometry (the selection halo): a hard part between two soft bands, its head grown by three bands', () => {
    const head = { x: 114, z: 12, angle: 0.1, y: 0 }
    const g = buildInkGeometry({ pts, head, width: 3, minCss: 2.5, maxCss: 4, casing: 0.5, casingMinCss: 1, casingMaxCss: 1.25, soft: 4, headCap: true, dash: null })!
    expect(g.getAttribute('position').count).toBe(pts.length * 4 + 6)
    // three quads per segment, the head's triangle + three edge quads
    expect(g.index!.count).toBe((pts.length - 1) * 3 * 6 + 3 + 3 * 6)
    const soft = g.getAttribute('aSoft')
    expect([0, 1, 2, 3].map((k) => soft.getX(k))).toEqual([1, 0, 0, 1])
    const h = pts.length * 4
    expect([0, 1, 2, 3, 4, 5].map((k) => soft.getX(h + k))).toEqual([0, 0, 0, 1, 1, 1])
    // every vertex carries the ceilings, the soft width and the head cap
    const cap = g.getAttribute('aCap')
    expect([cap.getX(0), cap.getY(0), cap.getZ(0), cap.getW(0)]).toEqual([2, 1.25, 4, 1])
    // the highlight measures on screen: aCap.w 2
    const scr = buildInkGeometry({ pts, head, width: 3, minCss: 2.5, maxCss: 4, casing: 0, casingMinCss: 0, headCap: true, screen: true, dash: null })!
    expect(scr.getAttribute('aCap').getW(0)).toBe(2)
    // the soft head's outer copy is pushed out along the same miters
    const miter = g.getAttribute('aMiter')
    expect(miter.getX(h + 3)).toBeCloseTo(miter.getX(h), 6)
    // a hard geometry: two vertices per point, aSoft 0 everywhere
    const hard = buildInkGeometry({ pts, head, width: 2.6, minCss: 1.75, casing: 1, casingMinCss: 0.75, dash: null })!
    expect(hard.getAttribute('position').count).toBe(pts.length * 2 + 3)
    expect(Array.from(hard.getAttribute('aSoft').array).every((v) => v === 0)).toBe(true)
    expect(Array.from(hard.getAttribute('aCap').array).every((v) => v === 0)).toBe(true)
  })

  it("the closing vertex is marked only on a capped line's LAST point; the bead's arc total only where a bead is painted", () => {
    const head = { x: 114, z: 12, angle: 0.1, y: 0 }
    const capped = buildInkGeometry({ pts, head, width: 3, minCss: 2.5, maxCss: 4, casing: 0, casingMinCss: 0, headCap: true, bead: true, dash: null })!
    const end = capped.getAttribute('aEnd')
    const last = (pts.length - 1) * 2
    expect([end.getX(last), end.getX(last + 1)]).toEqual([INK_HEAD_LEN - 2, INK_HEAD_LEN - 2])
    for (let k = 0; k < last; k++) expect(end.getX(k)).toBe(0)
    const total = Math.hypot(50, 0) + Math.hypot(50, 10)
    expect(end.getY(0)).toBeCloseTo(total, 4)
    // head vertices: never a bead
    expect(end.getY(pts.length * 2)).toBe(0)
    // uncapped, no bead: nothing marked (1a03e0865's lines draw as before)
    const plain = buildInkGeometry({ pts, head, width: 2.6, minCss: 1.75, casing: 0, casingMinCss: 0, dash: null })!
    expect(Array.from(plain.getAttribute('aEnd').array).every((v) => v === 0)).toBe(true)
  })

  it('a casing head is pushed out by unit miters (each edge moves 1 along its normal)', () => {
    const g = buildInkGeometry({ pts, head: { x: 0, z: 0, angle: 0, y: 0 }, width: 2.6, minCss: 1.75, casing: 1, casingMinCss: 0.75, dash: null })!
    const local = g.getAttribute('aLocal')
    const miter = g.getAttribute('aMiter')
    const h = pts.length * 2
    const v = [0, 1, 2].map((k) => new THREE.Vector2(local.getX(h + k) + miter.getX(h + k), local.getY(h + k) + miter.getY(h + k)))
    // the grown flank stays parallel to the core flank, 1 unit out
    const core = [0, 1, 2].map((k) => new THREE.Vector2(local.getX(h + k), local.getY(h + k)))
    const dist = (p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) => {
      const ab = b.clone().sub(a)
      return Math.abs(ab.x * (p.y - a.y) - ab.y * (p.x - a.x)) / ab.length()
    }
    // (float32 attributes: 5 digits)
    expect(dist(v[0], core[0], core[1])).toBeCloseTo(1, 5)
    expect(dist(v[1], core[0], core[1])).toBeCloseTo(1, 5)
    expect(dist(v[1], core[1], core[2])).toBeCloseTo(1, 5)
    expect(dist(v[2], core[2], core[0])).toBeCloseTo(1, 5)
  })

  it('every ink material compiles to ONE program: a fixed cache key, the shared uniforms', () => {
    const u = createInkUniforms()
    const a = new THREE.MeshBasicMaterial({ color: '#3A362F' })
    const b = new THREE.MeshBasicMaterial({ color: '#FBF4E8' })
    patchInkMaterial(a, u)
    patchInkMaterial(b, u)
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey())
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms
    a.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    expect(shader.uniforms.uInkViewH).toBe(u.uInkViewH)
    expect(shader.vertexShader).toContain('uniform float uInkViewH;')
    expect(shader.vertexShader).toContain(INK_VERTEX_BODY.trim().split('\n')[0])
    expect(shader.fragmentShader).toContain('discard')
    // the soft falloff and the bead sit after the colour is known
    expect(shader.fragmentShader).toContain(`#include <color_fragment>\n${INK_FRAGMENT_COLOR}`)
    expect(shader.uniforms.uInkPhase).toBe(u.uInkPhase)
    expect(a.customProgramCacheKey()).toBe('connInk-5')
  })
})
