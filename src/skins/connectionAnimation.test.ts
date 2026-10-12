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

import { describe, it, expect } from 'vitest'
import {
  resolveConnectionAnimation,
  hexToRgba,
  drawStrands,
  isDarkColor,
  STRANDS_DEFAULT_COLORS,
} from './connectionAnimation'
import { defaultSkin } from './defaultSkin'
import { slateSkin } from './slateSkin'
import { cyberpunkSkin } from './cyberpunkSkin'
import { eightBitSkin } from './eightBitSkin'
import { graffitiSkin } from './graffitiSkin'

describe('hexToRgba', () => {
  it('expands #RRGGBB', () => {
    expect(hexToRgba('#3B82F6', 0.5)).toBe('rgba(59, 130, 246, 0.5)')
  })

  it('expands short #RGB', () => {
    expect(hexToRgba('#0af', 1)).toBe('rgba(0, 170, 255, 1)')
  })

  it('tolerates a missing leading #', () => {
    expect(hexToRgba('FF0000', 0.25)).toBe('rgba(255, 0, 0, 0.25)')
  })

  it('passes non-hex strings through untouched', () => {
    expect(hexToRgba('rgba(1,2,3,0.4)', 0.9)).toBe('rgba(1,2,3,0.4)')
    expect(hexToRgba('tomato', 0.9)).toBe('tomato')
  })
})

describe('resolveConnectionAnimation', () => {
  it('falls back to the classic blue when a theme provides nothing', () => {
    const r = resolveConnectionAnimation({}) // a community/custom skin with no palette
    expect(r.color).toBe('#3B82F6')
    expect(r.highlight).toBe('#93C5FD')
    expect(r.strands).toEqual(STRANDS_DEFAULT_COLORS)
    expect(r.electric).toBe('#7DF9FF') // electric-cyan default
  })

  it('takes the color straight from the plugin theme, for every built-in skin', () => {
    // The color is PROVIDED BY THE THEME (each skin sets `connectionAnimation`),
    // so it drives every animation style — none is left on the generic blue.
    const cyber = resolveConnectionAnimation(cyberpunkSkin)
    expect(cyber.color).toBe('#00F0FF') // the theme's neon cyan
    expect(cyber.electric).toBe('#00F0FF')

    for (const skin of [defaultSkin, slateSkin, cyberpunkSkin, eightBitSkin, graffitiSkin]) {
      expect(skin.connectionAnimation).toBeDefined()
      const r = resolveConnectionAnimation(skin)
      expect(r.strands).not.toEqual(STRANDS_DEFAULT_COLORS)
      expect(r.electric).not.toBe('#7DF9FF') // each theme adapts the electric colour too
    }
  })

  it('lets a theme override just some fields, filling the rest from the default', () => {
    const r = resolveConnectionAnimation({ connectionAnimation: { color: '#123456' } })
    expect(r.color).toBe('#123456')
    expect(r.highlight).toBe('#93C5FD') // filled from the default
    expect(r.strands).toEqual(STRANDS_DEFAULT_COLORS)
  })

  it('ignores an empty strands array (keeps the default palette)', () => {
    const r = resolveConnectionAnimation({ connectionAnimation: { strands: [] } })
    expect(r.strands).toEqual(STRANDS_DEFAULT_COLORS)
  })
})

describe('isDarkColor', () => {
  it('is true for dark backgrounds, false for light ones', () => {
    expect(isDarkColor('#161513')).toBe(true) // dark-theme canvas
    expect(isDarkColor('#0B0B0F')).toBe(true) // cyberpunk canvas
    expect(isDarkColor('#E7E6E2')).toBe(false) // default warm-stone canvas
    expect(isDarkColor('#FFFFFF')).toBe(false)
  })
  it('is false for non-hex input', () => {
    expect(isDarkColor('rebeccapurple')).toBe(false)
  })
})

/** Minimal recording 2D-context stand-in: captures every stroke's style/width/shadow.
 *  `strokeStyle` may be a gradient (from createLinearGradient); we snapshot it to a
 *  plain, value-comparable object so the determinism test can deep-equal it. */
function recordingCtx() {
  const strokes: { style: unknown; width: number; shadowColor: unknown; shadowBlur: number }[] = []
  const ctx = {
    strokeStyle: '' as unknown,
    lineWidth: 0,
    shadowColor: '' as unknown,
    shadowBlur: 0,
    lineCap: '',
    lineJoin: '',
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
      return { grad: [x0, y0, x1, y1] as number[], stops: [] as [number, string][], addColorStop(o: number, c: string) { this.stops.push([o, c]) } }
    },
    stroke() {
      const s = this.strokeStyle as { grad?: number[]; stops?: [number, string][] } | string
      const style = s && typeof s === 'object' && s.stops
        ? { grad: s.grad, stops: s.stops.map((x) => x.slice()) }
        : s
      strokes.push({ style, width: this.lineWidth, shadowColor: this.shadowColor, shadowBlur: this.shadowBlur })
    },
  }
  return { ctx, strokes }
}

describe('drawStrands', () => {
  // A straight horizontal path: tangent is +x everywhere, so strands swing purely
  // vertically around the axis — easy to reason about.
  const straight = {
    pointAt: (t: number) => ({ x: t * 200, y: 100 }),
    tangentAt: () => ({ x: 1, y: 0 }),
  }

  it('renders three continuous passes per strand, colored from the palette', () => {
    const { ctx, strokes } = recordingCtx()
    const palette = ['#FF4242', '#7C3AED', '#06B6D4', '#EAB308']
    drawStrands(ctx as unknown as CanvasRenderingContext2D, {
      ...straight,
      colors: palette,
      timeMs: 1000,
      count: 3,
      samples: 24,
    })

    // Each strand is one continuous stroke re-stroked 3× (halo → mid → core) — no
    // per-segment beading. 3 strands × 3 = 9 strokes.
    expect(strokes).toHaveLength(9)
    // Every stroke tags its shadow with the raw strand color, so the shadow colors
    // are exactly the first `count` palette entries — each strand keeps its own hue.
    const shadowColors = new Set(strokes.map((s) => s.shadowColor))
    expect(shadowColors).toEqual(new Set(palette.slice(0, 3)))
    // The halo pass is far wider than the core pass.
    expect(strokes[0].width).toBeGreaterThan(strokes[2].width)
  })

  it('adds spine passes when spine is set', () => {
    const { ctx, strokes } = recordingCtx()
    drawStrands(ctx as unknown as CanvasRenderingContext2D, {
      ...straight, colors: ['#FF4242', '#06B6D4'], timeMs: 0, count: 2, samples: 16, spine: true,
    })
    // 2 spine passes + 2 strands × 3 = 8.
    expect(strokes).toHaveLength(8)
  })

  it('never winds more strands than palette colors', () => {
    const { ctx, strokes } = recordingCtx()
    drawStrands(ctx as unknown as CanvasRenderingContext2D, {
      ...straight,
      colors: ['#FF4242'],
      timeMs: 0,
      count: 3, // asks for 3 but only 1 color available
      samples: 16,
    })
    expect(strokes).toHaveLength(3) // 1 strand × 3 passes
    expect(new Set(strokes.map((s) => s.shadowColor))).toEqual(new Set(['#FF4242']))
  })

  it('draws nothing when the palette is empty', () => {
    const { ctx, strokes } = recordingCtx()
    drawStrands(ctx as unknown as CanvasRenderingContext2D, { ...straight, colors: [], timeMs: 0 })
    expect(strokes).toHaveLength(0)
  })

  it('is deterministic (no Math.random / Date.now inside)', () => {
    const a = recordingCtx()
    const b = recordingCtx()
    const opts = { ...straight, colors: STRANDS_DEFAULT_COLORS, timeMs: 12345, samples: 20, spine: true }
    drawStrands(a.ctx as unknown as CanvasRenderingContext2D, opts)
    drawStrands(b.ctx as unknown as CanvasRenderingContext2D, opts)
    expect(a.strokes).toEqual(b.strokes)
  })
})
