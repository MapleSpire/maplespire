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
  ANCHOR_D,
  buildHandleGeometry,
  createHandleMaterial,
  createHandleUniforms,
  discTriangleGap,
  easeOut,
  editHandleVisibility,
  handleHitRadius,
  handleStyle,
  HANDLE_D,
  HANDLE_TOKENS,
  setHandleAnchor,
  setHandleAppearance,
} from './editHandle'
import { contrastRatio } from './palette'
import { createInkUniforms } from './inkLine'

/** `css` at `alpha` over `under`, blended on the sRGB hex values. */
function over(css: string, alpha: number, under: string): string {
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const p = hex(css)
  const q = hex(under)
  const m = p.map((v, i) => Math.round(v * alpha + q[i] * (1 - alpha)))
  return `#${m.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

// the boards as RENDERED (design spec §0, measured on design-ref-selected)
const WOOD = '#D0995A'
const STONE = '#2E2923'

describe('handle look — design-system tokens, 2D parity', () => {
  it('endpoint: a solid coral body in a paper ring; bend: paper body in a coral ring — 10 css px at rest', () => {
    expect(handleStyle('endpoint', false)).toEqual({ body: '#D97A3D', bodyAlpha: 1, ring: '#FFFFFF', diameter: 10, ringW: 2 })
    expect(handleStyle('bend', false)).toEqual({ body: '#FFFFFF', bodyAlpha: 1, ring: '#D97A3D', diameter: 10, ringW: 2 })
    // dark: the brightened coral and stone-1000 paper (never the label plate
    // #161513 the old ring wore — a black ring on the dark board)
    expect(handleStyle('endpoint', true)).toMatchObject({ body: '#E89456', ring: '#F2F0EC' })
    expect(handleStyle('bend', true)).toMatchObject({ body: '#F2F0EC', ring: '#E89456' })
    // the line's own coral wins when given
    expect(handleStyle('endpoint', false, '#123456').body).toBe('#123456')
    // drop anchors: 6 body + 1.5 ring, snapped 10
    expect(handleStyle('anchor', false)).toMatchObject({ bodyAlpha: 0.85, diameter: ANCHOR_D + 3, ringW: 1.5 })
    expect(handleStyle('anchorSnapped', false).diameter).toBe(HANDLE_D)
  })

  it('the silhouette reads >= 3:1 on both boards: the hairline on the wood, the ring on the stone', () => {
    const l = HANDLE_TOKENS.light
    expect(contrastRatio(over(l.hair.css, l.hair.alpha, WOOD), WOOD)).toBeGreaterThanOrEqual(3)
    // control: the design spec's 0.55 does not, nor does the white ring alone
    expect(contrastRatio(over(l.hair.css, 0.55, WOOD), WOOD)).toBeLessThan(3)
    expect(contrastRatio(l.paper, WOOD)).toBeLessThan(3)
    expect(contrastRatio(HANDLE_TOKENS.dark.paper, STONE)).toBeGreaterThanOrEqual(3)
    // the coral body inside its ring: >= 2:1 both appearances (a fill, not
    // the silhouette)
    expect(contrastRatio(l.coral, l.paper)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(HANDLE_TOKENS.dark.coral, HANDLE_TOKENS.dark.paper)).toBeGreaterThanOrEqual(2)
  })

  it('pick radius: drawn radius + 4, never under 9 css px', () => {
    expect(handleHitRadius(10)).toBe(9)
    expect(handleHitRadius(12)).toBe(10)
    expect(handleHitRadius(2)).toBe(9)
  })

  it('--ease-out runs 0 → 1, monotone, front-loaded', () => {
    expect(easeOut(0)).toBeCloseTo(0, 6)
    expect(easeOut(1)).toBeCloseTo(1, 6)
    expect(easeOut(2)).toBeCloseTo(1, 6)
    let prev = -1
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = easeOut(t)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = v
    }
    expect(easeOut(0.3)).toBeGreaterThan(0.6)
  })
})

describe('placement — the knob on the tip, the short-line rules', () => {
  it('a disc clear of / touching / inside a triangle', () => {
    const tri = [
      { x: 0, y: 0 },
      { x: -16, y: 7 },
      { x: -16, y: -7 },
    ]
    expect(discTriangleGap({ x: -16 - 3 - 5, y: 0 }, 5, tri)).toBeCloseTo(3, 9)
    expect(discTriangleGap({ x: -20, y: 0 }, 5, tri)).toBeLessThan(0)
    expect(discTriangleGap({ x: -8, y: 0 }, 5, tri)).toBeLessThan(-5)
  })

  it('short lines: no knob under 18 css px from the source, only the source under 24 px of line', () => {
    expect(editHandleVisibility({ knobToSourcePx: 40, linePx: 80 })).toEqual({ source: true, knob: true })
    expect(editHandleVisibility({ knobToSourcePx: 17.9, linePx: 60 })).toEqual({ source: true, knob: false })
    expect(editHandleVisibility({ knobToSourcePx: 18, linePx: 60 })).toEqual({ source: true, knob: true })
    expect(editHandleVisibility({ knobToSourcePx: null, linePx: 60 })).toEqual({ source: true, knob: false })
    expect(editHandleVisibility({ knobToSourcePx: 30, linePx: 23 })).toEqual({ source: true, knob: false })
  })
})

describe('the billboard geometry and material', () => {
  const handles = [
    { x: 1, y: 0, z: 2, kind: 'endpoint' as const, id: 0, visible: true },
    { x: 5, y: 0, z: 6, kind: 'bend' as const, id: 2, visible: false },
  ]

  it('four vertices per handle on its anchor; a hidden handle is zero-sized', () => {
    const g = buildHandleGeometry(handles, false, '#D97A3D')
    expect(g.getAttribute('position').count).toBe(8)
    expect(g.index!.count).toBe(12)
    const size = g.getAttribute('aSize')
    expect([size.getX(0), size.getY(0), size.getZ(0), size.getW(0)]).toEqual([10, 2, 0, 0])
    expect(size.getX(4)).toBe(0)
    expect(size.getW(4)).toBe(2)
    // re-placed (the target knob, per frame) and shown
    setHandleAnchor(g, 1, 9, 0, 8, 10)
    const p = g.getAttribute('position')
    expect([p.getX(7), p.getZ(7), size.getX(7)]).toEqual([9, 8, 10])
    // the corners span the billboard
    const c = g.getAttribute('aCorner')
    expect([c.getX(0), c.getY(0), c.getX(2), c.getY(2)]).toEqual([-1, -1, 1, 1])
  })

  it('front and x-ray are ONE program (same source), the x-ray only where occluded, at 0.4', () => {
    const ink = createInkUniforms()
    const u = createHandleUniforms()
    const front = createHandleMaterial(ink, u, false)
    const xray = createHandleMaterial(ink, u, true)
    expect(front.vertexShader).toBe(xray.vertexShader)
    expect(front.fragmentShader).toBe(xray.fragmentShader)
    expect(front.depthFunc).toBe(THREE.LessEqualDepth)
    expect(xray.depthFunc).toBe(THREE.GreaterDepth)
    expect(front.uniforms.uOpacity.value).toBe(1)
    expect(xray.uniforms.uOpacity.value).toBe(0.4)
    // the hover / press state is shared (one write lights both passes)
    expect(front.uniforms.uHoverId).toBe(xray.uniforms.uHoverId)
    expect(front.uniforms.uInkViewH).toBe(ink.uInkViewH)
    // sized in css px on screen (a billboard), never in world units
    expect(front.vertexShader).toContain('clip.xy += aCorner * pad * vec2(2.0 / uInkViewW, 2.0 / uInkViewH) * clip.w;')
    expect(front.transparent && !front.depthWrite).toBe(true)
  })

  it('the appearance sets the hairline, shadow, glow and pressed colours', () => {
    const u = createHandleUniforms()
    setHandleAppearance(u, true, '#E89456')
    expect(u.uHair.value.w).toBe(HANDLE_TOKENS.dark.hair.alpha)
    expect(u.uGlow.value.w).toBe(0.28)
    expect(`#${u.uPressCol.value.getHexString()}`).toBe(HANDLE_TOKENS.dark.pressed.toLowerCase())
    setHandleAppearance(u, false, '#D97A3D')
    expect(u.uGlow.value.w).toBe(0.16)
    expect(`#${u.uPressCol.value.getHexString()}`).toBe(HANDLE_TOKENS.light.pressed.toLowerCase())
  })
})
