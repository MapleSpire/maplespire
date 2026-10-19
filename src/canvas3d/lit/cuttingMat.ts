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

/**
 * The architect's CUTTING MAT under the board (workbench world, view3d
 * quality loop 4 r4 — workbench-wide.png: "the desk still reads empty …
 * large empty tan areas"; the critic's fix (a): "a desk blotter or cutting
 * mat under the board that overhangs it by 60-90 units, which frames the
 * slab and breaks the flat tan").
 *
 * A self-healing mat at real scale: slate green, a 5 cm grid (CUT_MAT_TILE
 * world units at 4.1 units/cm) of pale lines aligned on the slab's corner,
 * rounded corners, CUT_MAT_OVERHANG past the slab on every side.
 *
 * It links NO new shader program: its material carries exactly the desk
 * plane's feature set (map + roughnessMap + normalMap, no vertex colours —
 * Scene3D builds both), only the textures differ, and three keys programs on
 * features, not texture identity. The three textures are tiny DataTextures
 * (128 / 64 / 64 px), generated once per page and cached like the wood's.
 */

/** World units past the slab on every side (the critic asked 60-90). */
export const CUT_MAT_OVERHANG = 72
/** One grid tile: 5 cm at 4.1 units/cm. */
export const CUT_MAT_TILE = 20.5
/** Corner radius of the mat (world units). */
export const CUT_MAT_RADIUS = 22
/** Height above the desk plane. Desk props stand 0.3 above it (Scene3D's
 * deskLift), so every prop — the flat leaves and cards included — stays on
 * top; the desk material's polygon offset keeps the 0.12 gap free of
 * z-fighting at far zoom. */
export const CUT_MAT_LIFT = 0.12

export interface CuttingMatTextures {
  map: THREE.DataTexture
  roughnessMap: THREE.DataTexture
  normalMap: THREE.DataTexture
}

let cached: CuttingMatTextures | null = null

/** Deterministic LCG (the wood's recipe) — same seed, same mat. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function dataTexture(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

/** The mat's three maps (cached for the page, like workbenchTextures). */
export function cuttingMatTextures(): CuttingMatTextures {
  if (cached) return cached
  const rnd = lcg(0x6d47c0de)
  // colour: one 5 cm tile — slate green, a pale line on the tile's edges
  // (both axes), a fainter 1 cm tick line at the tile's middle
  const C = 128
  const base = [47, 84, 70]
  const line = [128, 160, 144]
  const color = new Uint8Array(C * C * 4)
  const edge = (t: number) => Math.min(t, C - t) // px from the tile edge
  for (let y = 0; y < C; y++) {
    for (let x = 0; x < C; x++) {
      const dLine = Math.min(edge(x + 0.5), edge(y + 0.5))
      const major = Math.max(0, Math.min(1, 2.2 - dLine)) // ~3.4 px wide, soft
      const dMid = Math.min(Math.abs(x + 0.5 - C / 2), Math.abs(y + 0.5 - C / 2))
      const minor = 0.35 * Math.max(0, Math.min(1, 1.2 - dMid))
      const k = Math.max(major, minor)
      const n = 1 + (rnd() - 0.5) * 0.05 // the vinyl's faint mottling
      const i = (y * C + x) * 4
      for (let c = 0; c < 3; c++) color[i + c] = Math.round(Math.min(255, (base[c] * (1 - k) + line[c] * k) * n))
      color[i + 3] = 255
    }
  }
  // roughness (G) — a matte vinyl, a little satin in the grain — and a fine
  // pebbled relief in the normal map
  const R = 64
  const rough = new Uint8Array(R * R * 4)
  const normal = new Uint8Array(R * R * 4)
  const h = new Float32Array(R * R)
  for (let i = 0; i < R * R; i++) h[i] = rnd()
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const i = y * R + x
      const at = (xx: number, yy: number) => h[((yy + R) % R) * R + ((xx + R) % R)]
      const dx = at(x + 1, y) - at(x - 1, y)
      const dy = at(x, y + 1) - at(x, y - 1)
      const nx = -dx * 0.35
      const ny = dy * 0.35
      const len = Math.hypot(nx, ny, 1)
      normal[i * 4] = Math.round(((nx / len) * 0.5 + 0.5) * 255)
      normal[i * 4 + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255)
      normal[i * 4 + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255)
      normal[i * 4 + 3] = 255
      const g = Math.round((0.78 + 0.1 * h[i]) * 255)
      rough[i * 4] = g
      rough[i * 4 + 1] = g
      rough[i * 4 + 2] = g
      rough[i * 4 + 3] = 255
    }
  }
  cached = { map: dataTexture(color, C, true), roughnessMap: dataTexture(rough, R, false), normalMap: dataTexture(normal, R, false) }
  return cached
}

/** Drop the cached mat textures (paired with disposeWorkbenchTextures). */
export function disposeCuttingMatTextures(): void {
  if (!cached) return
  cached.map.dispose()
  cached.roughnessMap.dispose()
  cached.normalMap.dispose()
  cached = null
}

/** The mat's geometry for a slab (world x/z of its top-left corner and its
 * size): a flat rounded rectangle in the XZ plane at y = 0 (the caller
 * lifts it), normal +Y, grown CUT_MAT_OVERHANG on every side, its UVs in
 * grid tiles counted from the slab's corner (so the grid lines run along
 * the board's edges). */
export function cuttingMatGeometry(slab: { x: number; z: number; w: number; h: number }): THREE.BufferGeometry {
  const o = CUT_MAT_OVERHANG
  const x0 = slab.x - o
  const z0 = slab.z - o
  const x1 = slab.x + slab.w + o
  const z1 = slab.z + slab.h + o
  const r = CUT_MAT_RADIUS
  // the shape lives in (x, −z): rotateX(−π/2) takes its +Z normal to +Y and
  // its y to −z
  const s = new THREE.Shape()
  s.moveTo(x0 + r, -z1)
  s.lineTo(x1 - r, -z1)
  s.quadraticCurveTo(x1, -z1, x1, -z1 + r)
  s.lineTo(x1, -z0 - r)
  s.quadraticCurveTo(x1, -z0, x1 - r, -z0)
  s.lineTo(x0 + r, -z0)
  s.quadraticCurveTo(x0, -z0, x0, -z0 - r)
  s.lineTo(x0, -z1 + r)
  s.quadraticCurveTo(x0, -z1, x0 + r, -z1)
  const geo = new THREE.ShapeGeometry(s, 4)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.getAttribute('position')
  const uv = geo.getAttribute('uv')
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, (pos.getX(i) - slab.x) / CUT_MAT_TILE, (pos.getZ(i) - slab.z) / CUT_MAT_TILE)
  }
  uv.needsUpdate = true
  // white vertex colours: the desk's material takes its board tones as
  // vertex colours (wood.ts deskBoardsGeometry), and the mat keeps sharing
  // its program only with the same feature set
  geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3))
  return geo
}
