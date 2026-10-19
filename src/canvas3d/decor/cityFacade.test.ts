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

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  FACADE_BAY_U,
  FACADE_FLAG_UV,
  FACADE_FLOOR_V,
  FACADE_PX,
  FACADE_ROOF_UV,
  FACADE_STYLE_ORIGIN,
  FACADE_WATER_UV,
  FACADE_WHITE_UV,
  facadeAtlasData,
  facadeBoxUV,
  WATER_ROUGHNESS,
  type FacadeStyle,
} from './cityFacade'

const S = FACADE_PX
const at = (arr: Uint8Array, x: number, y: number, c = 0): number => arr[(y * S + x) * 4 + c]
const luma = (arr: Uint8Array, x: number, y: number): number =>
  (0.2126 * at(arr, x, y, 0) + 0.7152 * at(arr, x, y, 1) + 0.0722 * at(arr, x, y, 2)) / 255

describe('city facade atlas', () => {
  it('the plain texel is white, flat and fully rough on a 5 × 5 neighbourhood (filtering never reaches a feature)', () => {
    const d = facadeAtlasData()
    const cx = Math.floor(FACADE_WHITE_UV[0] * S)
    const cy = Math.floor(FACADE_WHITE_UV[1] * S)
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        expect([at(d.color, cx + dx, cy + dy, 0), at(d.color, cx + dx, cy + dy, 1), at(d.color, cx + dx, cy + dy, 2)]).toEqual([255, 255, 255])
        expect(at(d.rough, cx + dx, cy + dy, 1)).toBe(255)
        expect([at(d.normal, cx + dx, cy + dy, 0), at(d.normal, cx + dx, cy + dy, 1)]).toEqual([128, 128])
      }
    }
  })

  it('the water texel is white and glossy; the roof block is a darker gravel with a darker rim', () => {
    const d = facadeAtlasData()
    const wx = Math.floor(FACADE_WATER_UV[0] * S)
    const wy = Math.floor(FACADE_WATER_UV[1] * S)
    expect(at(d.color, wx, wy, 0)).toBe(255)
    expect(at(d.rough, wx, wy, 1)).toBe(Math.round(WATER_ROUGHNESS * 255))
    const rx0 = Math.floor(FACADE_ROOF_UV.u0 * S)
    const ry0 = Math.floor(FACADE_ROOF_UV.v0 * S)
    const inner = luma(d.color, rx0 + 16, ry0 + 16)
    const rim = luma(d.color, rx0, ry0 + 16)
    expect(inner, 'a flat roof steps down from its walls').toBeLessThan(0.8)
    expect(rim, 'the parapet shadow line').toBeLessThan(inner)
  })

  it('every facade style is a window grid: dark glass covers a real share of a bay, never the whole of it', () => {
    // measured on this atlas (upper floors, texels under 0.45 luma): plex
    // 0.099, grey 0.152, office 0.484, tower 0.879 — the bars reject a blank
    // wall (0) and a black sheet (1) and keep each style's character apart
    const d = facadeAtlasData()
    const share: Record<FacadeStyle, number> = { plex: 0, grey: 0, office: 0, tower: 0 }
    for (const style of Object.keys(FACADE_STYLE_ORIGIN) as FacadeStyle[]) {
      const { u0, v0 } = FACADE_STYLE_ORIGIN[style]
      let dark = 0
      let n = 0
      // the upper floors (1-15) of the style's 14 bays
      for (let y = Math.round(v0 * S) + 16; y < Math.round(v0 * S) + 256; y++) {
        for (let x = Math.round(u0 * S); x < Math.round(u0 * S) + 224; x++) {
          n++
          if (luma(d.color, x, y) < 0.45) dark++
        }
      }
      share[style] = dark / n
    }
    expect(share.plex).toBeGreaterThan(0.06)
    expect(share.plex).toBeLessThan(0.4)
    expect(share.grey).toBeGreaterThan(0.08)
    expect(share.grey).toBeLessThan(0.4)
    expect(share.office).toBeGreaterThan(0.3)
    expect(share.tower).toBeGreaterThan(share.office)
    expect(share.tower).toBeLessThan(0.95)
  })

  it('the flag is red | white | red (1 : 2 : 1) — and carries no leaf of its own drawing', () => {
    const d = facadeAtlasData()
    const x0 = Math.round(FACADE_FLAG_UV.u0 * S)
    const y0 = Math.round(FACADE_FLAG_UV.v0 * S)
    const red = (x: number, y: number): boolean => at(d.color, x, y, 0) > 190 && at(d.color, x, y, 1) < 60
    for (let y = y0; y < y0 + 16; y++) {
      for (let x = x0; x < x0 + 32; x++) {
        const bar = x - x0 < 8 || x - x0 >= 24
        // the white square is plain: the official leaf is never redrawn
        // (owner decision) — at ~6 css px it would be one or two pixels
        expect(red(x, y), `(${x - x0}, ${y - y0})`).toBe(bar)
      }
    }
  })

  it('facadeBoxUV: walls span whole bays and floors of their style; the roof maps the roof block, the floor the plain texel', () => {
    const box = new THREE.BoxGeometry(33, 25, 18)
    facadeBoxUV(box, 33, 18, 'grey', 5.5, 3)
    const uv = box.getAttribute('uv')
    const { u0, v0 } = FACADE_STYLE_ORIGIN.grey
    // face +z (vertices 16-19) is 33 wide → 6 bays; 3 floors
    const us = [16, 17, 18, 19].map((i) => uv.getX(i))
    const vs = [16, 17, 18, 19].map((i) => uv.getY(i))
    expect(Math.min(...us)).toBeCloseTo(u0, 6)
    expect(Math.max(...us)).toBeCloseTo(u0 + 6 * FACADE_BAY_U, 6)
    expect(Math.min(...vs)).toBeCloseTo(v0, 6)
    expect(Math.max(...vs)).toBeCloseTo(v0 + 3 * FACADE_FLOOR_V, 6)
    // face +x (vertices 0-3) is 18 deep → 3 bays
    expect(Math.max(...[0, 1, 2, 3].map((i) => uv.getX(i)))).toBeCloseTo(u0 + 3 * FACADE_BAY_U, 6)
    for (const i of [8, 9, 10, 11]) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(FACADE_ROOF_UV.u0 - 1e-9)
      expect(uv.getX(i)).toBeLessThanOrEqual(FACADE_ROOF_UV.u1 + 1e-9)
      expect(uv.getY(i)).toBeGreaterThanOrEqual(FACADE_ROOF_UV.v0 - 1e-9)
      expect(uv.getY(i)).toBeLessThanOrEqual(FACADE_ROOF_UV.v1 + 1e-9)
    }
    for (const i of [12, 13, 14, 15]) expect([uv.getX(i), uv.getY(i)]).toEqual([...FACADE_WHITE_UV])
    // a rooftop storey starts above the ground-floor row (no shopfront)
    const top = new THREE.BoxGeometry(20, 5, 20)
    facadeBoxUV(top, 20, 20, 'office', 7.5, 1, 1)
    expect(Math.min(...[16, 17, 18, 19].map((i) => top.getAttribute('uv').getY(i)))).toBeCloseTo(
      FACADE_STYLE_ORIGIN.office.v0 + FACADE_FLOOR_V,
      6,
    )
    box.dispose()
    top.dispose()
  })
})
