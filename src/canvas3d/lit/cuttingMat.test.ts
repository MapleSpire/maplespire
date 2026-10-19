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
  CUT_MAT_LIFT,
  CUT_MAT_OVERHANG,
  CUT_MAT_TILE,
  cuttingMatGeometry,
  cuttingMatTextures,
  disposeCuttingMatTextures,
} from './cuttingMat'

describe('the cutting mat under the board (view3d quality loop 4 r4)', () => {
  const slab = { x: 40, z: 40, w: 1300, h: 900 }

  it('frames the slab: a flat rounded rectangle CUT_MAT_OVERHANG past it on every side, in the 60-90 the critique asked', () => {
    // workbench-wide.png (loop 4 r4): "a leather/felt desk blotter or
    // cutting mat under the board that overhangs it by 60-90 units"
    expect(CUT_MAT_OVERHANG).toBeGreaterThanOrEqual(60)
    expect(CUT_MAT_OVERHANG).toBeLessThanOrEqual(90)
    const g = cuttingMatGeometry(slab)
    g.computeBoundingBox()
    const bb = g.boundingBox!
    expect(bb.min.x).toBeCloseTo(slab.x - CUT_MAT_OVERHANG, 3)
    expect(bb.max.x).toBeCloseTo(slab.x + slab.w + CUT_MAT_OVERHANG, 3)
    expect(bb.min.z).toBeCloseTo(slab.z - CUT_MAT_OVERHANG, 3)
    expect(bb.max.z).toBeCloseTo(slab.z + slab.h + CUT_MAT_OVERHANG, 3)
    expect(bb.max.y - bb.min.y, 'flat').toBeLessThan(1e-6)
    // lit from above: every normal +Y, and the faces wind to match
    const n = g.getAttribute('normal')
    for (let i = 0; i < n.count; i++) expect(n.getY(i)).toBeCloseTo(1, 5)
    const pos = g.getAttribute('position')
    const idx = g.index!
    for (let t = 0; t < idx.count; t += 3) {
      const [a, b, c] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)].map((i) => new THREE.Vector3().fromBufferAttribute(pos, i))
      const face = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a))
      if (face.lengthSq() > 1e-9) expect(face.y, 'front face up').toBeGreaterThan(0)
    }
    // a handful of triangles: the mat costs nothing
    expect(idx.count / 3).toBeLessThan(80)
    g.dispose()
  })

  it('its grid runs along the board: UVs count 5 cm tiles from the slab corner', () => {
    const g = cuttingMatGeometry(slab)
    const pos = g.getAttribute('position')
    const uv = g.getAttribute('uv')
    for (let i = 0; i < pos.count; i++) {
      expect(uv.getX(i)).toBeCloseTo((pos.getX(i) - slab.x) / CUT_MAT_TILE, 5)
      expect(uv.getY(i)).toBeCloseTo((pos.getZ(i) - slab.z) / CUT_MAT_TILE, 5)
    }
    // 5 cm at the desk's 4.1 units/cm
    expect(CUT_MAT_TILE).toBeCloseTo(5 * 4.1, 5)
    g.dispose()
  })

  it('rides above the desk plane but under every desk prop (Scene3D lifts desk props 0.3)', () => {
    expect(CUT_MAT_LIFT).toBeGreaterThan(0)
    expect(CUT_MAT_LIFT).toBeLessThan(0.3)
  })

  it('small shared textures: a slate-green sRGB grid tile, linear roughness and relief, cached once a page', () => {
    const t = cuttingMatTextures()
    expect(cuttingMatTextures(), 'cached').toBe(t)
    for (const tex of [t.map, t.roughnessMap, t.normalMap]) {
      const { width, height } = tex.image as { width: number; height: number }
      expect(width).toBeLessThanOrEqual(512)
      expect(width & (width - 1), 'power of two (mipmaps)').toBe(0)
      expect(height).toBe(width)
      expect(tex.wrapS).toBe(THREE.RepeatWrapping)
    }
    expect(t.map.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(t.normalMap.colorSpace).not.toBe(THREE.SRGBColorSpace)
    // the tile's centre texel is the mat's slate green; its edge the pale line
    const img = t.map.image as { width: number; data: Uint8Array }
    const at = (x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3))
    const [r, g, b] = at(img.width / 4, img.width / 4)
    expect(g, 'green').toBeGreaterThan(r + 20)
    expect(g).toBeGreaterThan(b)
    expect(g, 'dark: it frames the pale slab').toBeLessThan(110)
    const line = at(0, img.width / 4)
    expect(line[1], 'the grid line is lighter').toBeGreaterThan(g + 30)
    // normal map: flat on average (z up), roughness matte
    const nrm = t.normalMap.image as { width: number; data: Uint8Array }
    let z = 0
    for (let i = 0; i < nrm.width * nrm.width; i++) z += nrm.data[i * 4 + 2]
    expect(z / (nrm.width * nrm.width) / 255).toBeGreaterThan(0.9)
    disposeCuttingMatTextures()
    expect(cuttingMatTextures(), 'disposed, then rebuilt').not.toBe(t)
    disposeCuttingMatTextures()
  })
})
