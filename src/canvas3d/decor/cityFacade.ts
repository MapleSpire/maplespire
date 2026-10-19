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
 * The CITY FACADE ATLAS — one shared 512-px set of maps (colour, roughness,
 * relief) that dresses every building of the city world, the civic plaza
 * podium under the board and the river, in the SAME program as the desk
 * (MeshStandardMaterial with map + roughnessMap + normalMap + vertex
 * colours — Scene3D's desk material): no shader is linked for it, ever.
 *
 * Why (blind critic, tp2-final-dpr1/city-wide.png): "untextured boxes have
 * no windows or roof detail at mid range". The old window cells were 2-tri
 * planes on near/mid blocks only (~100 triangles a block); the far field had
 * none. A texture costs no triangles, so EVERY block now wears a window grid
 * and floor bands, and the freed triangles fund the roofs.
 *
 * Layout (texel coordinates, v = row from the BOTTOM — a DataTexture is not
 * flipped):
 *
 *   u   0-223  column A: 14 bays × 16 px      ┐ v repeats (wrapT Repeat):
 *   u 224-447  column B: 14 bays × 16 px      ┘ 32 floors × 16 px a period
 *   u 448-479  granite pavers / ashlar (8-px stones, running bond)
 *   u 480-511  plain white (v 0-255), a flag (v 256-271), water (v 288-319),
 *              a gravel roof (v 320-351), plain white above
 *
 *   rows 0-255 (floors 0-15, floor 0 = ground)   rows 256-511
 *   column A: 'plex'  — Montréal brick walk-up   'grey' — greystone
 *   column B: 'office' — ribbon windows          'tower' — curtain wall
 *
 * A wall maps u across a whole number of bays (≤ 14) of its column and v up
 * a whole number of floors from its variant's ground floor, so a facade is
 * one quad whatever its size. Everything that is not a facade samples ONE
 * plain-white texel (FACADE_WHITE_UV): its vertex colour shows verbatim, the
 * relief there is flat and the roughness is the material's own.
 *
 * Values are sRGB albedo MULTIPLIERS of the vertex tone (a wall ~0.86, a
 * flat roof ~0.7, trims and cornices the plain 1.0).
 * Deterministic (own LCG), built once per page in slices (facadeAtlasSteps)
 * so no task ever holds the main thread for it.
 */

export const FACADE_PX = 512
const BAY = 16
const FLOOR = 16
export const FACADE_COL_BAYS = 14
const COL_PX = BAY * FACADE_COL_BAYS // 224
/** One bay / one floor in UV units. */
export const FACADE_BAY_U = BAY / FACADE_PX
export const FACADE_FLOOR_V = FLOOR / FACADE_PX
/** Floors one style holds before v runs into the next style. */
export const FACADE_STYLE_FLOORS = 16

export type FacadeStyle = 'plex' | 'grey' | 'office' | 'tower'
/** Each style's origin: column start (u) and ground-floor row (v). */
export const FACADE_STYLE_ORIGIN: Record<FacadeStyle, { u0: number; v0: number }> = {
  plex: { u0: 0, v0: 0 },
  grey: { u0: 0, v0: 0.5 },
  office: { u0: COL_PX / FACADE_PX, v0: 0 },
  tower: { u0: COL_PX / FACADE_PX, v0: 0.5 },
}
/** Granite pavers: u range of the strip, world units per texel. */
export const PAVE_U0 = (2 * COL_PX) / FACADE_PX
export const PAVE_U1 = (2 * COL_PX + 32) / FACADE_PX
/** The plain-white texel (centre of a 32 × 256 white block, so neither
 * bilinear filtering nor a coarse mip ever reaches a neighbour). */
export const FACADE_WHITE_UV: readonly [number, number] = [(496 + 0.5) / FACADE_PX, (128 + 0.5) / FACADE_PX]
/** The flag: 32 × 16 texels, red | white | red (1 : 2 : 1). At the city's
 * scale it is ~12 × 6 css px, so the leaf would be one or two pixels — it is
 * deliberately NOT drawn here (the official leaf is an owner decision and is
 * never redrawn; the desk flag carries it). */
export const FACADE_FLAG_UV = { u0: 480 / FACADE_PX, u1: 512 / FACADE_PX, v0: 256 / FACADE_PX, v1: 272 / FACADE_PX }
/** The WATER texel (32 × 32 block, v 288-319): white, flat, and glossy —
 * its roughness 0.34 under the city material's 0.88 is the river's old 0.3.
 * So the river joins the city's own mesh: one draw, no material of its own
 * (quality pass "city": that draw paid for the podium's). */
export const FACADE_WATER_UV: readonly [number, number] = [(496 + 0.5) / FACADE_PX, (304 + 0.5) / FACADE_PX]
export const WATER_ROUGHNESS = 0.34
/** The flat-ROOF block (32 × 32, v 320-351): tar-and-gravel grey with a
 * darker rim, the parapet's inner shadow line. A block's top face maps the
 * whole block, so every flat roof steps DOWN from its walls' tone instead of
 * reading as the palest face of a pale carton. */
export const FACADE_ROOF_UV = {
  u0: (480 + 0.5) / FACADE_PX,
  u1: (512 - 0.5) / FACADE_PX,
  v0: (320 + 0.5) / FACADE_PX,
  v1: (352 - 0.5) / FACADE_PX,
}

export interface FacadeAtlasData {
  color: Uint8Array
  rough: Uint8Array
  normal: Uint8Array
}

let atlasData: FacadeAtlasData | null = null
let atlasTex: { map: THREE.DataTexture; roughnessMap: THREE.DataTexture; normalMap: THREE.DataTexture } | null = null

/** Integer hash → [0, 1). */
function h2(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b9)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** One texel: albedo multiplier (sRGB, 0-1), roughness (0-1), relief
 * (tangent-space x/y slope; z is derived). */
interface Texel {
  r: number
  g: number
  b: number
  rough: number
  nx: number
  ny: number
}

const GLASS: [number, number, number] = [0.17, 0.2, 0.25]

function glassTone(t: Texel, bay: number, floor: number, fy: number, salt: number): void {
  const k = h2(bay, floor, salt)
  if (k < 0.12) {
    // a drawn blind / lit room: warm and light — the grid reads lived-in
    t.r = 0.56
    t.g = 0.5
    t.b = 0.4
  } else {
    const lift = (k - 0.12) * 0.14
    t.r = GLASS[0] + lift
    t.g = GLASS[1] + lift
    t.b = GLASS[2] + lift
  }
  // the upper panes catch the sky
  if (fy >= 10) {
    t.r += 0.05
    t.g += 0.06
    t.b += 0.07
  }
  t.rough = 0.3
}

/** Brick walk-up: tall paired sash windows, stone lintel + sill, a door on
 * every third ground bay. */
function plex(t: Texel, bx: number, fy: number, bay: number, floor: number): void {
  const mortar = fy % 3 === 0 ? 0.93 : 1
  const n = 0.97 + h2(bx, fy + floor * 16, bay) * 0.06
  t.r = t.g = t.b = 0.86 * mortar * n
  const door = floor === 0 && bay % 3 === 1
  if (door) {
    if (bx >= 5 && bx <= 10 && fy <= 11) {
      if (bx === 5 || bx === 10 || fy === 11) {
        t.r = t.g = t.b = 0.97
      } else {
        t.r = 0.36
        t.g = 0.24
        t.b = 0.17
        t.rough = 0.6
        if (bx === 6) t.nx = 0.45
        if (bx === 9) t.nx = -0.45
      }
    }
    if (fy === 12 && bx >= 4 && bx <= 11) {
      t.r = t.g = t.b = 1
      t.ny = 0.35
    }
    return
  }
  if (bx >= 5 && bx <= 10 && fy >= 4 && fy <= 12) {
    if (bx === 5 || bx === 10 || fy === 4 || fy === 12) {
      t.r = t.g = t.b = 0.96 // painted sash frame
    } else {
      glassTone(t, bay, floor, fy, 1)
      if (bx === 6) t.nx = 0.45
      if (bx === 9) t.nx = -0.45
      if (fy === 11) t.ny = -0.45
      if (fy === 5) t.ny = 0.45
    }
  } else if ((fy === 13 || fy === 3) && bx >= 4 && bx <= 11) {
    t.r = t.g = t.b = 1 // stone lintel / sill
    t.ny = fy === 3 ? 0.6 : 0.35
  }
}

/** Greystone: smooth limestone, a string course under every floor line,
 * framed windows with a keystone. */
function grey(t: Texel, bx: number, fy: number, bay: number, floor: number): void {
  const n = 0.985 + h2(bx, fy + floor * 16, bay + 7) * 0.03
  t.r = t.g = t.b = 0.9 * n
  if (fy === 15) {
    t.r = t.g = t.b = 0.78
    t.ny = 0.3
    return
  }
  if (floor === 0 && bay % 3 === 1 && bx >= 5 && bx <= 10 && fy <= 11) {
    if (bx === 5 || bx === 10 || fy === 11) t.r = t.g = t.b = 1
    else {
      t.r = 0.32
      t.g = 0.23
      t.b = 0.18
      t.rough = 0.6
    }
    return
  }
  if (bx >= 4 && bx <= 11 && fy >= 4 && fy <= 12) {
    if (bx === 4 || bx === 11 || fy === 4 || fy === 12) {
      t.r = t.g = t.b = 1
    } else {
      glassTone(t, bay, floor, fy, 2)
      if (bx === 5) t.nx = 0.5
      if (bx === 10) t.nx = -0.5
      if (fy === 11) t.ny = -0.5
      if (fy === 5) t.ny = 0.5
    }
  } else if (fy === 13 && bx >= 7 && bx <= 8) {
    t.r = t.g = t.b = 1 // keystone
    t.ny = 0.3
  } else if (fy === 3 && bx >= 3 && bx <= 12) {
    t.r = t.g = t.b = 1
    t.ny = 0.6
  }
}

/** Office: precast spandrel bands under continuous ribbon windows; the
 * ground floor is a shopfront under a dark sign band. */
function office(t: Texel, bx: number, fy: number, bay: number, floor: number): void {
  const n = 0.98 + h2(bx, fy, bay + 13) * 0.04
  t.r = t.g = t.b = 0.88 * n
  if (floor === 0) {
    if (fy >= 12 && fy <= 14) {
      t.r = 0.3
      t.g = 0.28
      t.b = 0.26
      t.ny = fy === 14 ? 0.3 : 0
      return
    }
    if (fy >= 1 && fy <= 11 && bx !== 0) {
      glassTone(t, bay, 0, fy, 3)
      if (bx === 1) t.nx = 0.4
      if (fy === 11) t.ny = -0.4
    }
    return
  }
  if (fy <= 3) {
    t.r = t.g = t.b = 0.74 * n // spandrel
    if (fy === 3) t.ny = 0.35
    return
  }
  if (fy >= 4 && fy <= 13) {
    if (bx === 0 || bx === 8) t.r = t.g = t.b = 0.8 // mullions
    else {
      glassTone(t, bay * 2 + (bx > 8 ? 1 : 0), floor, fy, 4)
      if (fy === 13) t.ny = -0.45
    }
  }
}

/** Curtain wall: glass panels on a mullion/transom grid, each panel its own
 * reflection. */
function tower(t: Texel, bx: number, fy: number, bay: number, floor: number): void {
  if (bx === 0 || fy === 0) {
    t.r = t.g = t.b = bx === 0 && fy === 0 ? 0.7 : 0.76
    t.rough = 0.5
    if (fy === 0) t.ny = 0.25
    return
  }
  const k = h2(bay, floor, 5)
  t.r = 0.2 + k * 0.14
  t.g = 0.25 + k * 0.14
  t.b = 0.31 + k * 0.14
  if (fy >= 11) {
    t.r += 0.04
    t.g += 0.05
    t.b += 0.06
  }
  t.rough = 0.22
}

/** Granite setts in running bond, 8-px stones, 1-px recessed joints. */
function paver(t: Texel, px: number, py: number): void {
  const row = Math.floor(py / 8)
  const sx = px + (row % 2) * 4
  const col = Math.floor(sx / 8)
  const jx = sx % 8
  const jy = py % 8
  if (jx === 0 || jy === 0) {
    t.r = t.g = t.b = 0.66
    t.rough = 1
    if (jy === 0) t.ny = -0.35
    else t.nx = 0.35
    return
  }
  const k = h2(col, row, 11)
  const v = 0.84 + k * 0.14 + h2(px, py, 12) * 0.03
  t.r = v
  t.g = v * 0.99
  t.b = v * 0.97
  t.rough = 0.95
}

/** Tar-and-gravel roof, 32 × 32: speckled grey, a 2-texel darker rim. */
function roof(t: Texel, px: number, py: number): void {
  const rim = Math.min(px, py, 31 - px, 31 - py)
  const g = 0.7 + h2(px, py, 21) * 0.06 - (rim === 0 ? 0.12 : rim === 1 ? 0.06 : 0)
  t.r = g
  t.g = g
  t.b = g * 1.02
  t.rough = 1
}

function flag(t: Texel, px: number): void {
  // 1 : 2 : 1 — the red bars, the white square (no leaf at this scale)
  if (px < 8 || px >= 24) {
    t.r = 0.84
    t.g = 0.11
    t.b = 0.12
  } else {
    t.r = t.g = t.b = 1
  }
  t.rough = 0.8
}

function texel(x: number, y: number, t: Texel): void {
  t.r = t.g = t.b = 1
  t.rough = 1
  t.nx = 0
  t.ny = 0
  if (x >= 480) {
    if (y >= 256 && y < 272) flag(t, x - 480)
    else if (y >= 288 && y < 320) t.rough = WATER_ROUGHNESS
    else if (y >= 320 && y < 352) roof(t, x - 480, y - 320)
    return
  }
  if (x >= 2 * COL_PX) {
    paver(t, x - 2 * COL_PX, y)
    return
  }
  const colB = x >= COL_PX
  const cx = x - (colB ? COL_PX : 0)
  const bay = Math.floor(cx / BAY)
  const bx = cx % BAY
  const upper = y >= 256
  const floor = Math.floor((y % 256) / FLOOR)
  const fy = y % FLOOR
  if (!colB) (upper ? grey : plex)(t, bx, fy, bay, floor)
  else (upper ? tower : office)(t, bx, fy, bay, floor)
}

/** The atlas, built in ROW STRIPS: each `yield` follows 32 rows (~16 k
 * texels). The city's own sliced build drains it first, so picking the City
 * background never spends one long task on it; the result is cached for the
 * page. */
export function* facadeAtlasSteps(): Generator<void, FacadeAtlasData, void> {
  if (atlasData) return atlasData
  const S = FACADE_PX
  const color = new Uint8Array(S * S * 4)
  const rough = new Uint8Array(S * S * 4)
  const normal = new Uint8Array(S * S * 4)
  const t: Texel = { r: 1, g: 1, b: 1, rough: 1, nx: 0, ny: 0 }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      texel(x, y, t)
      const o = (y * S + x) * 4
      color[o] = Math.round(Math.min(1, Math.max(0, t.r)) * 255)
      color[o + 1] = Math.round(Math.min(1, Math.max(0, t.g)) * 255)
      color[o + 2] = Math.round(Math.min(1, Math.max(0, t.b)) * 255)
      color[o + 3] = 255
      const r8 = Math.round(t.rough * 255)
      rough[o] = r8
      rough[o + 1] = r8
      rough[o + 2] = r8
      rough[o + 3] = 255
      const inv = 1 / Math.hypot(t.nx, t.ny, 1)
      normal[o] = Math.round((t.nx * inv * 0.5 + 0.5) * 255)
      normal[o + 1] = Math.round((t.ny * inv * 0.5 + 0.5) * 255)
      normal[o + 2] = Math.round((inv * 0.5 + 0.5) * 255)
      normal[o + 3] = 255
    }
    if (y % 32 === 31) yield
  }
  // a concurrent drain may have finished first — keep ONE copy
  if (!atlasData) atlasData = { color, rough, normal }
  return atlasData
}

/** The atlas data, built synchronously when no sliced build ran first. */
export function facadeAtlasData(): FacadeAtlasData {
  if (atlasData) return atlasData
  const it = facadeAtlasSteps()
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
  }
}

function dataTex(arr: Uint8Array, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(arr, FACADE_PX, FACADE_PX, THREE.RGBAFormat)
  // u stays inside one column (clamped); v climbs floors (repeats)
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.RepeatWrapping
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

/** The three shared maps (one upload per page). */
export function cityFacadeTextures(): { map: THREE.DataTexture; roughnessMap: THREE.DataTexture; normalMap: THREE.DataTexture } {
  if (atlasTex) return atlasTex
  const d = facadeAtlasData()
  atlasTex = { map: dataTex(d.color, true), roughnessMap: dataTex(d.rough, false), normalMap: dataTex(d.normal, false) }
  return atlasTex
}

/** Dress a city material with the atlas: the desk's exact feature set (map +
 * roughness map + normal map; the vertex colours are the caller's), so the
 * city links the program the desk already linked. `relief` is a uniform. */
export function dressCityMaterial(mat: THREE.Material, relief = 0.7): void {
  if (!(mat instanceof THREE.MeshStandardMaterial)) return
  const t = cityFacadeTextures()
  mat.map = t.map
  mat.roughnessMap = t.roughnessMap
  mat.normalMap = t.normalMap
  mat.normalScale.set(relief, relief)
  mat.needsUpdate = true
}

/** Drop the shared maps (scene dispose); the data stays for the next scene. */
export function disposeCityFacadeTextures(): void {
  if (!atlasTex) return
  atlasTex.map.dispose()
  atlasTex.roughnessMap.dispose()
  atlasTex.normalMap.dispose()
  atlasTex = null
}

/** Set every vertex of `geo` to the plain-white texel (or another single
 * texel, e.g. FACADE_WATER_UV). */
export function flatUV(geo: THREE.BufferGeometry, at: readonly [number, number] = FACADE_WHITE_UV): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count
  const uv = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    uv[i * 2] = at[0]
    uv[i * 2 + 1] = at[1]
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return geo
}

/** Remap a BoxGeometry's (1-segment) native UVs onto the atlas: the four
 * walls get `style`'s window grid — a whole number of bays across each face
 * (`bayW` world units a bay, at most FACADE_COL_BAYS) and `floors` up — the
 * roof the gravel-roof block and the floor the plain-white texel. Three's
 * box lays its faces out
 * +x, −x, +y, −y, +z, −z, four vertices each, with native u running left to
 * right as seen from outside and v bottom to top. */
export function facadeBoxUV(
  box: THREE.BufferGeometry,
  w: number,
  d: number,
  style: FacadeStyle,
  bayW: number,
  floors: number,
  /** First floor shown at the foot (1 = start above the ground-floor row —
   * a rooftop storey has no shopfront or door). */
  startFloor = 0,
): void {
  const uv = box.getAttribute('uv') as THREE.BufferAttribute
  const o = FACADE_STYLE_ORIGIN[style]
  const u0 = o.u0
  const fl = Math.max(1, Math.min(FACADE_STYLE_FLOORS - startFloor, Math.round(floors)))
  const v0 = o.v0 + startFloor * FACADE_FLOOR_V
  const R = FACADE_ROOF_UV
  for (let face = 0; face < 6; face++) {
    const fw = face < 2 ? d : w
    const bays = Math.max(1, Math.min(FACADE_COL_BAYS, Math.round(fw / bayW)))
    for (let k = 0; k < 4; k++) {
      const i = face * 4 + k
      if (face === 2) uv.setXY(i, R.u0 + uv.getX(i) * (R.u1 - R.u0), R.v0 + uv.getY(i) * (R.v1 - R.v0))
      else if (face === 3) uv.setXY(i, FACADE_WHITE_UV[0], FACADE_WHITE_UV[1])
      else uv.setXY(i, u0 + uv.getX(i) * bays * FACADE_BAY_U, v0 + uv.getY(i) * fl * FACADE_FLOOR_V)
    }
  }
  uv.needsUpdate = true
}
