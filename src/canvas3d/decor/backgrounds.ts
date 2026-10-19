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
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  dressCityMaterial,
  FACADE_FLAG_UV,
  FACADE_ROOF_UV,
  FACADE_WATER_UV,
  FACADE_WHITE_UV,
  facadeAtlasSteps,
  facadeBoxUV,
  flatUV,
  PAVE_U0,
  type FacadeStyle,
} from './cityFacade'
import { decorAsset, type DecorAsset } from './glbAssets'

/**
 * BACKGROUND world library — what exists beyond the desk. Three pure
 * builders (no Scene3D imports; materials arrive through a `MakeMat`
 * callback so the engine keeps material-family ownership):
 *
 * - `buildCityBackground` — ref3's low-poly city as a RING around the desk
 *   zone: margin-anchored block lattices with punched window cells, street
 *   ribbons carrying walker/vehicle street life, tree clusters, and a
 *   Montréal landmark quadrant — Mont-Royal (the Blender maquette
 *   `mont-royal.glb`, montRoyalGeometry; a faceted green mount with a white
 *   cross until it loads or if it fails) and an embanked river with two
 *   piered bridges — all
 *   seated on the UP-SCREEN bearing so the default iso frame
 *   actually shows them. The near-ring and mid-field housing stock reads as
 *   Montréal walk-ups: brick/greystone triplex rows under proud cornice
 *   parapets, with diagonal exterior-staircase prisms on the near ring's
 *   street-facing facades (user ask: "design Montréalais").
 *   Every band tone carries a baked ±24% sun-side value ramp
 *   matched to the key light's −55° azimuth (the meshes are shadowless, so
 *   the dusk falloff must be painted in).
 * - `buildStudioBackground` — a seamless-paper infinity cove: a paper floor
 *   over the whole world (the studio has no wood desk) plus the
 *   quarter-round and tall sweep wall, one lathe — two draws.
 * - `buildDeskLamp` — ref1's brass dome lamp; returns a SpotLight SPEC
 *   (the engine instantiates the actual light).
 *
 * Hard rules: deterministic (seeded LCG — no Math.random/Date.now), merged
 * geometry under hard budgets (city ≤6 draws / ≤60k tris, studio ≤2,
 * lamp ≤3), background meshes never cast NOR receive shadows (shadow-map
 * budget stays with the board; the lamp body is the one hero caster, and
 * the studio's paper floor the one receiver — it stands in for the desk),
 * and the city never intrudes into the board's `hole` rect — parts are
 * partitioned into N/S/E/W frame bands (the river rides the south band)
 * plus bridge/mount landmark meshes, whose merged bounding boxes each clear
 * the hole on at least one axis (testable without unpicking merges).
 *
 * Quality pass "city" (2026-10-10): every city part samples ONE shared
 * facade atlas (cityFacade.ts) in the desk's program — window grids and
 * floor bands on every block, gravel roofs, granite setts, the river's
 * gloss — plus Montréal roofs (water tanks, mansards, pitched roofs),
 * parish churches, City Hall flying the flag, autumn maples, and the civic
 * PODIUM (buildCityPodium) the board stands on.
 */

export interface BackgroundLampSpec {
  position: [number, number, number]
  target: [number, number, number]
  color: string
  /** Candela: with `decay` 2, the irradiance at the target is
   * intensity / |target − position|². */
  intensity: number
  angle: number
  penumbra: number
  /** Physical inverse-square falloff (three's `decay`). */
  decay: number
  /** Cut-off range (world units): three's smooth window brings the light to
   * exactly 0 there, so nothing past it is ever touched. */
  distance: number
}

export interface BackgroundBuild {
  group: THREE.Group
  drawCalls: number
  triangles: number
  lamp?: BackgroundLampSpec
}

/** Material factory the ENGINE injects (maps onto its litSurface roles). */
export type MakeMat = (
  role: 'decor' | 'decorEmissive',
  css: string,
  opts?: {
    vertexColors?: boolean
    emissive?: string
    emissiveIntensity?: number
    metalness?: number
    roughness?: number
  },
) => THREE.Material

/** Deterministic LCG (same recipe as lit/wood.ts) — the same seed must
 * produce an identical scene on every client. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

/** Bake a flat color into a part pre-merge (mirrors decor/build.ts — one
 * vertex-colored material carries the whole multi-tone merge). Every city
 * part also gets the facade atlas's plain-white UV (cityFacade.ts), so its
 * tone shows verbatim through the shared atlas material; a facade re-maps
 * its walls afterwards (facadeBoxUV). */
function tint(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  return flatUV(paint(geo, color))
}

/** A parapet CAP: a slab over the whole roof whose top face is the atlas's
 * gravel-roof block (dark rim = the parapet's inner shadow) and whose sides
 * are the plain trim. The cap is what the camera sees of a flat roof, so a
 * pale cap made every cream walk-up read as a blank carton lid. */
function capBox(w: number, h: number, d: number, color: THREE.Color): THREE.BufferGeometry {
  const g = tint(new THREE.BoxGeometry(w, h, d), color)
  const uv = g.getAttribute('uv') as THREE.BufferAttribute
  const R = FACADE_ROOF_UV
  // +y is box face 2 (vertices 8-11), native corner order (0,1)(1,1)(0,0)(1,0)
  uv.setXY(8, R.u0, R.v1)
  uv.setXY(9, R.u1, R.v1)
  uv.setXY(10, R.u0, R.v0)
  uv.setXY(11, R.u1, R.v0)
  return g
}

/** The colour half of `tint`: the UVs are left as they are. */
function paint(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const count = geo.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geo
}

/** Indexed, FLAT-shaded polyhedron from planar polygons (fan-triangulated,
 * one normal per face, unshared corners) — roofs and spires read as crisp
 * low-poly facets where a 4-segment cylinder would smooth its normals round
 * the corners. Plain-white UV (tint overwrites colour + UV anyway). */
function faceted(polys: Array<Array<[number, number, number]>>): THREE.BufferGeometry {
  const pos: number[] = []
  const nrm: number[] = []
  const idx: number[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  for (const poly of polys) {
    const base = pos.length / 3
    a.set(...poly[0])
    b.set(...poly[1]).sub(a)
    c.set(...poly[2]).sub(a)
    const n = b.cross(c).normalize()
    for (const p of poly) {
      pos.push(p[0], p[1], p[2])
      nrm.push(n.x, n.y, n.z)
    }
    for (let i = 1; i < poly.length - 1; i++) idx.push(base, base + i, base + i + 1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setIndex(idx)
  return flatUV(g)
}

/** Gable roof: ridge along the LONGER side, `rise` over the eaves, centred
 * at the origin with its eaves at y 0 (two slopes + two gable ends; the
 * underside is never seen). Counter-clockwise from outside. */
function gableRoof(w: number, d: number, rise: number): THREE.BufferGeometry {
  const alongX = w >= d
  const hx = w / 2
  const hz = d / 2
  if (alongX) {
    return faceted([
      [[-hx, 0, hz], [hx, 0, hz], [hx, rise, 0], [-hx, rise, 0]],
      [[hx, 0, -hz], [-hx, 0, -hz], [-hx, rise, 0], [hx, rise, 0]],
      [[hx, 0, hz], [hx, 0, -hz], [hx, rise, 0]],
      [[-hx, 0, -hz], [-hx, 0, hz], [-hx, rise, 0]],
    ])
  }
  return faceted([
    [[hx, 0, hz], [hx, 0, -hz], [0, rise, -hz], [0, rise, hz]],
    [[-hx, 0, -hz], [-hx, 0, hz], [0, rise, hz], [0, rise, -hz]],
    [[-hx, 0, hz], [hx, 0, hz], [0, rise, hz]],
    [[hx, 0, -hz], [-hx, 0, -hz], [0, rise, -hz]],
  ])
}

/** Hipped frustum: a Second-Empire MANSARD (steep `inset`, flat top) or,
 * with inset = half the short side, a pyramid SPIRE. Eaves at y 0. */
function hipRoof(w: number, d: number, rise: number, inset: number): THREE.BufferGeometry {
  const hx = w / 2
  const hz = d / 2
  const tx = Math.max(0, hx - inset)
  const tz = Math.max(0, hz - inset)
  const polys: Array<Array<[number, number, number]>> = [
    [[-hx, 0, hz], [hx, 0, hz], [tx, rise, tz], [-tx, rise, tz]],
    [[hx, 0, hz], [hx, 0, -hz], [tx, rise, -tz], [tx, rise, tz]],
    [[hx, 0, -hz], [-hx, 0, -hz], [-tx, rise, -tz], [tx, rise, -tz]],
    [[-hx, 0, -hz], [-hx, 0, hz], [-tx, rise, tz], [-tx, rise, -tz]],
  ]
  if (tx > 0.01 && tz > 0.01) polys.push([[-tx, rise, tz], [tx, rise, tz], [tx, rise, -tz], [-tx, rise, -tz]])
  return faceted(polys)
}

/** Position hash in [0, 1) — a deterministic per-site choice that draws
 * NOTHING from the city's LCG, so dressing a block (its facade style, roof,
 * leaf colour) never moves another block. */
function siteHash(x: number, z: number, seed: number, salt: number): number {
  let h =
    Math.imul(Math.round(x * 4) | 0, 0x27d4eb2d) ^
    Math.imul(Math.round(z * 4) | 0, 0x165667b1) ^
    Math.imul(seed | 0, 0x9e3779b9) ^
    Math.imul(salt | 0, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

function triCount(geo: THREE.BufferGeometry): number {
  return (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3
}

function statsOf(group: THREE.Group): { drawCalls: number; triangles: number } {
  let drawCalls = 0
  let triangles = 0
  group.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    drawCalls++
    triangles += triCount(mesh.geometry)
  })
  return { drawCalls, triangles }
}

/** Maquette city palette — warm cream/brick/slate blocks plus a SECOND
 * facade hue family (ochre + sage: one flat swatch per district reads as
 * blank cartons), two greens, and a CONCRETE fabric family. Ground fabric
 * in the desk's own hue (#C8A67D) reads as the bare sand it is meant to
 * cover — fabric only breaks from the desk when its HUE steps to concrete
 * grey, not when its value dips a notch. Pads/apron/streets live a clear
 * hue step off the wood. */
const CITY = {
  cream: new THREE.Color('#E8DCC8'),
  warmWhite: new THREE.Color('#EFE6D4'),
  ochre: new THREE.Color('#C39A5F'),
  brick: new THREE.Color('#B0705A'),
  slate: new THREE.Color('#8B8E99'),
  sage: new THREE.Color('#8C9E8B'),
  roof: new THREE.Color('#6E655B'),
  leafA: new THREE.Color('#8FA97E'),
  leafB: new THREE.Color('#7C9A6C'),
  mount: new THREE.Color('#6F8F60'),
  rock: new THREE.Color('#8A7866'),
  cross: new THREE.Color('#F5F2EA'),
  deck: new THREE.Color('#C9BBA6'),
  trunk: new THREE.Color('#8A6F52'),
  lawn: new THREE.Color('#97A97E'),
  pad: new THREE.Color('#A9A092'),
  plaza: new THREE.Color('#C6BEAB'),
  apron: new THREE.Color('#B7AA92'),
  street: new THREE.Color('#8A7F6C'),
  wet: new THREE.Color('#39434B'),
  skin: new THREE.Color('#D8B48E'),
  // Montréal walk-up stock (user ask "design Montréalais"): warm brick
  // reds/browns + greystone beiges, and the dark painted wrought iron of
  // the exterior staircases
  briqueRed: new THREE.Color('#A45B44'),
  briqueBrown: new THREE.Color('#8E5C43'),
  greystone: new THREE.Color('#BFB49E'),
  greystoneLight: new THREE.Color('#CFC5B0'),
  iron: new THREE.Color('#474B42'),
  // roofs (quality pass "city"): Montréal's oxidised COPPER (civic mansards,
  // the cathedral roofs), dark slate mansards, tin-silver steeples, the
  // timber of a rooftop water tank, and a weathered terracotta for the
  // pitched house roofs
  copper: new THREE.Color('#6E9A87'),
  slateRoof: new THREE.Color('#585E69'),
  tin: new THREE.Color('#C3C7CB'),
  tank: new THREE.Color('#7A5B43'),
  terracotta: new THREE.Color('#985A46'),
  // autumn maples (round crowns only — the cones stay evergreen)
  mapleRed: new THREE.Color('#B5442E'),
  mapleOrange: new THREE.Color('#C9762F'),
  mapleGold: new THREE.Color('#C49B3E'),
  // the civic plaza podium under the board (buildCityPodium)
  granite: new THREE.Color('#C3BDB0'),
  graniteCap: new THREE.Color('#D8D3C8'),
  graniteBase: new THREE.Color('#8E897F'),
  // Round-9 sev7: at #98917F the rigging read as a dark dithered braid — the
  // colour was already below the cream shell, so the thin geometry's coverage
  // dither landed as speckle. Light desaturated steel keeps the same lines
}
// darker and less saturated than a sky blue such as '#7FA8C0' — a bright
// saturated band reads as painted vinyl, not water
const RIVER_CSS = '#708EA0'

/** The city's MAQUETTE UNIT, in world units (TASK "city scale",
 * 2026-10-10). The generator below lays the city out in its own units —
 * the layout every earlier critique tuned, on a ring of radius / K round a
 * hole of size / K — and the merged bands are then magnified K times about
 * the hole's centre at street level, so the hole (and the board in it) keeps
 * its world size while every block, street, bridge and tree grows.
 *
 * Why: at K = 1 the board read as a giant crate in a toy town — a 2-3 storey
 * walk-up (12.5-21.5 units) stood lower than the board's own top (slab 14 +
 * podium 16 = 30 over the street), about the height of the desk flag
 * (tp3-final-dpr1/city-wide.png, city-tag-1.png). At 2.2 a cell, its blocks
 * and its streets are 2.2x wider, the plaza ring's blocks stand 53-65 units
 * (PLAZA_H below) — the board's thickness plus 3-4 storeys of CITY_STOREY —
 * and the city has ~1/K² as many cells, so fewer, bigger buildings. Things
 * that live at PEOPLE scale (walkers, vehicles, trees, window bays, the
 * mount's cross) carry a 1/K factor of their own so they keep a world size
 * coherent with the storey, not K times it. */
export const CITY_SCALE = 2.2
/** World height of one facade storey (the atlas row a wall repeats). Was
 * ~7 on the walk-ups (18.5-21.5 over 3 floors) and 8.5 on the blocks;
 * 8 keeps the window cells near their old size on the taller walls — more
 * floors per building, not stretched windows. */
export const CITY_STOREY = 8
/** World width of the street margin between the city hole and the first
 * blocks (was 56 at K = 1). Holds the podium's flights of steps
 * (PODIUM_STAIR_REACH past the hole edge, 32) plus a street. */
export const CITY_STREET_MARGIN = 81

type Band = 'north' | 'south' | 'east' | 'west'
const BAND_ORDER: Band[] = ['north', 'south', 'east', 'west']

export interface CityBackgroundOpts {
  /** Desk-zone rect the BOARD owns — center (x, z) + full size (w, h) in
   * world units. Nothing is placed inside it (plus a street margin). */
  hole: { x: number; z: number; w: number; h: number }
  /** Outer extent of the ring, measured from the hole's center. Needs
   * comfortable headroom over the hole diagonal or most cells are culled. */
  radius: number
  /** Desk plane elevation — every part sits ON it. */
  baseY: number
  seed: number
  makeMat: MakeMat
}

/** ref3's low-poly city ring: ≤6 draws, ≤60k tris, deterministic. */
export function buildCityBackground(opts: CityBackgroundOpts): BackgroundBuild {
  return assembleCityBackground(buildCityGeometry(opts), opts.makeMat)
}

/** The city's GEOMETRY, material-free: one merged buffer per frame band /
 * landmark, plus the two test-seam manifests. Pure function of the options
 * (seeded LCG), so it can be cached per seed and re-dressed with fresh
 * materials on every rebuild (`assembleCityBackground`). */
export interface CityGeometry {
  parts: Array<{ geometry: THREE.BufferGeometry; tag: string }>
  /** Where the river went (test seam): the part it was merged into and its
   * banks' z span; null when the ring had no room for one. */
  river: { in: string; z0: number; z1: number } | null
  streetLife: { people: Array<{ x: number; z: number }>; vehicles: Array<{ x: number; z: number }> }
  fabric: CityFabric
  /** The Mont-Royal landmark (test seam + probe), WORLD units: its centre on
   * the street, its nominal radius, and which mesh it wears — the Blender
   * maquette (`mont-royal.glb`, quality pass "montroyal") or the procedural
   * fallback. Null when the ring had no room for it. */
  mount: { x: number; z: number; r: number; source: 'glb' | 'procedural' } | null
}

/** Montréal-fabric manifest (test seam): every count is bumped in the same
 * call that pushes its geometry. */
export interface CityFabric {
  walkups: number
  cornices: number
  penthouses: number
  roofUnits: number
  stairs: number
  /** Blocks wearing the facade atlas (every building body). */
  facades: number
  waterTowers: number
  pitched: number
  mansards: number
  churches: number
  /** Civic buildings flying the flag. */
  flags: number
  autumnTrees: number
}

export type CityGeometryOpts = Omit<CityBackgroundOpts, 'makeMat'>

/** Synchronous build — drains every step at once (tests, fallbacks). */
export function buildCityGeometry(opts: CityGeometryOpts): CityGeometry {
  const it = cityGeometrySteps(opts)
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
  }
}

/** The same build TIME-SLICED: each macrotask runs steps until `sliceMs`
 * has elapsed, then yields the thread (MessageChannel — no 4 ms setTimeout
 * clamp, no idle-callback starvation while the page is busy).
 *
 * Measured (scripts/view3d-quality, RTX 4080 dev build, 2026-10-08): the
 * synchronous city build was `floorMs` 59-78 ms of ONE task, the bulk of
 * the 168-195 ms freeze on picking the City background. The steps are the
 * lattice rows and the per-band merges, each a few ms, so no slice holds
 * the main thread for long. Resolves null when `stop()` turns true (a newer
 * rebuild asked for a different city); the partial buffers were never
 * uploaded, so dropping them costs no GPU memory. */
export function buildCityGeometrySliced(
  opts: CityGeometryOpts,
  stop: () => boolean = () => false,
  sliceMs = 6,
): Promise<CityGeometry | null> {
  const it = cityGeometrySteps(opts)
  const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null
  return new Promise<CityGeometry | null>((resolve, reject) => {
    const schedule = (fn: () => void): void => {
      if (channel) {
        channel.port1.onmessage = () => fn()
        channel.port2.postMessage(0)
      } else setTimeout(fn, 0)
    }
    const finish = (value: CityGeometry | null): void => {
      channel?.port1.close()
      resolve(value)
    }
    const slice = (): void => {
      if (stop()) return finish(null)
      const t0 = performance.now()
      try {
        for (;;) {
          const r = it.next()
          if (r.done) return finish(r.value)
          if (performance.now() - t0 >= sliceMs) break
        }
      } catch (err) {
        channel?.port1.close()
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      schedule(slice)
    }
    schedule(slice)
  })
}

/** Dress a city geometry with fresh materials. `sharedGeometry` marks the
 * meshes so the engine's teardown disposes their materials but leaves the
 * (cached) buffers alone. */
export function assembleCityBackground(
  geom: CityGeometry,
  makeMat: MakeMat,
  opts: { sharedGeometry?: boolean } = {},
): BackgroundBuild {
  const group = new THREE.Group()
  // ONE vertex-colored matte material serves every part, the river included
  // (white css so the baked tones show verbatim — litSurface convention;
  // vertexColors is load-bearing: without it the river's baked tone drift
  // silently drops and the run reads as one flat band, round 4 sev5),
  // dressed with the facade atlas: the desk's own feature set, so it links
  // no new program. The river's gloss is its water texel (cityFacade.ts).
  const cityMat = cityMaterial(makeMat)
  for (const part of geom.parts) {
    const mesh = new THREE.Mesh(part.geometry, cityMat)
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.userData.bgPart = part.tag
    if (opts.sharedGeometry) mesh.userData.sharedGeometry = true
    group.add(mesh)
  }
  // street-life manifest — where the walkers/vehicles actually stand. Test
  // seam only (the parts themselves are merged into the band meshes); each
  // entry is pushed in the same call that pushes its geometry.
  group.userData.streetLife = geom.streetLife
  // Montréal-fabric manifest (walk-ups / cornices / roof treatments /
  // staircase prisms) — same test-seam contract.
  group.userData.cityFabric = geom.fabric
  group.userData.cityRiver = geom.river
  group.userData.cityMount = geom.mount
  return { group, ...statsOf(group) }
}

/** The city's shared matte material: vertex colours over the facade atlas.
 *
 * The critic's "washed-out haze" over the up-screen city (tp2-final-dpr1/
 * city-wide.png, top band x 330-1270 y 60-300) is not fog — the scene has
 * none — but pale, featureless blocks. Measured on that band (Rec. 709 luma
 * of the PNG, p90 − p10 / standard deviation): before 60.8-71.8 / 26.4-28.5
 * (tp2-final, tp3-lamp, tp3-labels); with the atlas 78.0-82.4 / 30.7-34.0
 * (tp3-city-iter3/4). Lowering this material's envMapIntensity to 0.55 was
 * tried and measured NOTHING (79.8 / 31.6 at 1.0, tp3-city-env1), so the
 * environment stays at three's default. */
export function cityMaterial(makeMat: MakeMat): THREE.Material {
  const mat = makeMat('decor', '#FFFFFF', { vertexColors: true, roughness: 0.88 })
  dressCityMaterial(mat)
  return mat
}

/** Release a city geometry's buffers (cache eviction / scene dispose). */
export function disposeCityGeometry(geom: CityGeometry): void {
  for (const p of geom.parts) p.geometry.dispose()
}

/** The city build as resumable STEPS (see buildCityGeometrySliced). Every
 * `yield` sits between whole units of work — the LCG stream, the budgets
 * and the output are identical however the steps are scheduled. */
function* cityGeometrySteps(opts: CityGeometryOpts): Generator<void, CityGeometry, void> {
  const { baseY, seed } = opts
  // the layout runs in MAQUETTE units (CITY_SCALE): the hole and the ring
  // shrink by K about the hole's centre, and addMerged magnifies the merged
  // bands back by K about the same point at street level — the hole maps
  // onto itself, so the "never intrudes" partition is untouched
  const K = CITY_SCALE
  const hole = { x: opts.hole.x, z: opts.hole.z, w: opts.hole.w / K, h: opts.hole.h / K }
  const radius = opts.radius / K
  const toWorld = new THREE.Matrix4()
    .makeTranslation(hole.x, baseY, hole.z)
    .multiply(new THREE.Matrix4().makeScale(K, K, K))
    .multiply(new THREE.Matrix4().makeTranslation(-hole.x, -baseY, -hole.z))
  const worldX = (x: number): number => hole.x + (x - hole.x) * K
  const worldZ = (z: number): number => hole.z + (z - hole.z) * K
  /** Storeys a wall of maquette height `h` carries (CITY_STOREY world). */
  const storeys = (h: number): number => Math.max(1, Math.round((h * K) / CITY_STOREY))
  /** People-scale factors, in maquette units: a tree, a walker and a
   * vehicle keep a WORLD size set against the storey (trees 3-5 storeys,
   * walkers ~1, vehicles van/bus-sized) instead of growing K times. */
  const TREE_K = 1.1 / K
  const LIFE_K = 0.7 / K
  const VEH_K = 0.85 / K
  // the shared facade atlas (once per page), in row strips like the rest
  yield* facadeAtlasSteps()
  const rnd = lcg(seed)
  /** Advance the LCG by `n` draws without using them. The old window cells
   * drew one roll per cell; the atlas replaced the cells, and burning the
   * same draws keeps every later block exactly where it stood — the city
   * the earlier measured gates (street life, west fabric, budgets) were
   * tuned on. */
  const burn = (n: number): void => {
    for (let i = 0; i < n; i++) rnd()
  }
  const site = (x: number, z: number, salt: number): number => siteHash(x, z, seed, salt)
  // Critique #6 sev6: the engine's key light rides azimuth −55° / elevation
  // 38° (lighting.ts: position = (cos el·sin az, sin el, cos el·cos az)),
  // i.e. the sun stands in the −x/+z quadrant. The unlit background meshes
  // never receive its shadows, so an evenly-toned city reads lifeless — the
  // bands therefore BAKE a matching low-frequency sun-side value ramp
  // (+24% up-sun, −24% down-sun, applied post-merge in addMerged) so the
  // baked grading agrees with the real shading on the board.
  const sunAz = (-55 * Math.PI) / 180
  const sunX = Math.sin(sunAz)
  const sunZ = Math.cos(sunAz)
  // ONE street's worth of gap between the board zone and the first blocks —
  // enough desk to separate city from tray (style critic sev8: a 24-unit
  // gap crowded the board edge) but no more (AAA round 3 sev6; ref3's
  // blocks run right up to the trays). City scale: CITY_STREET_MARGIN in
  // world units (it holds the podium's flights of steps and a street).
  const margin = CITY_STREET_MARGIN / K
  const hb = {
    minX: hole.x - hole.w / 2,
    maxX: hole.x + hole.w / 2,
    minZ: hole.z - hole.h / 2,
    maxZ: hole.z + hole.h / 2,
  }
  // lattice pitch — hoisted above the landmarks because the quay paving
  // meets the first south lattice row. Taken from the WORLD radius: the
  // maquette cell keeps the pitch (and the cluster archetypes) it had at
  // K = 1, so a world cell — its blocks and the street between them — is
  // K times wider (city scale: "building footprints … ~2-2.5x")
  const step = Math.max(70, opts.radius / 15)
  const half = step / 2 - 12
  const bands: Record<Band, THREE.BufferGeometry[]> = { north: [], south: [], east: [], west: [] }
  let tris = 0
  /** While true, parts are built and DROPPED: the civic cell runs its
   * ordinary cluster for its LCG draws only (see fillCell). */
  let sink = false
  const push = (band: Band, geo: THREE.BufferGeometry): void => {
    if (sink) {
      geo.dispose()
      return
    }
    tris += triCount(geo)
    bands[band].push(geo)
  }
  // Montréal-fabric manifest (test seam, streetLife pattern): every count
  // is bumped in the same call that pushes its geometry, so the numbers
  // can never drift from the meshes.
  const fabric: CityFabric = {
    walkups: 0,
    cornices: 0,
    penthouses: 0,
    roofUnits: 0,
    stairs: 0,
    facades: 0,
    waterTowers: 0,
    pitched: 0,
    mansards: 0,
    churches: 0,
    flags: 0,
    autumnTrees: 0,
  }
  // Frame partition: a part belongs to the first side its FULL footprint
  // clears (hole + margin); null ⇔ the footprint would intrude and the
  // caller must skip it. Each band's merged bbox therefore misses the hole
  // on ≥1 axis — the invariant the hole regression test leans on.
  const bandFor = (minX: number, maxX: number, minZ: number, maxZ: number): Band | null => {
    if (minZ >= hb.maxZ + margin) return 'north'
    if (maxZ <= hb.minZ - margin) return 'south'
    if (minX >= hb.maxX + margin) return 'east'
    if (maxX <= hb.minX - margin) return 'west'
    return null
  }

  const building = (
    band: Band,
    wx: number,
    wz: number,
    bw: number,
    bd: number,
    h: number,
    tone: THREE.Color,
    detail: boolean,
  ): void => {
    // ±6% per-block value jitter — same-tone twins in one cluster read as
    // blank stacked cartons without it; kept below ±8% so the
    // low-frequency sun ramp reads over it
    const shade = tone.clone().multiplyScalar(0.94 + rnd() * 0.12)
    // the facade (quality pass "city": "untextured boxes have no windows or
    // roof detail at mid range"): every block, near or far, wears a window
    // grid + floor bands from the shared atlas at zero triangles — towers a
    // curtain wall, brick blocks the walk-up sash, the pale stock greystone
    // or office ribbons. The old punched cells (2-tri planes, near/mid only)
    // and their string-courses are gone; their LCG draws are burned below.
    const style: FacadeStyle =
      h > 55
        ? 'tower'
        : tone === CITY.brick
          ? 'plex'
          : tone === CITY.slate || tone === CITY.sage
            ? 'office'
            : site(wx, wz, 1) < 0.5
              ? 'grey'
              : 'office'
    const bayW = style === 'tower' ? 5.5 : style === 'office' ? 7.5 : style === 'plex' ? 6 : 6.5
    facadeBlock(band, wx, wz, bw, h, bd, shade, style, bayW, storeys(h))
    if (detail && h >= 8) {
      const floors = Math.min(3, Math.max(1, Math.floor(h / 9)))
      for (const fw of [bw, bw, bd, bd]) burn(Math.min(5, Math.max(3, Math.round(fw / 16))) * floors)
    }
    // slim parapet lip capping the roofline — proud 0.7 above the shell
    // top so no coplanar roof faces fight. Near/mid blocks take the lip
    // unconditionally through `detail`; the FAR field takes it at a 14% roll,
    // because far blocks project to a few px where a statistical mix reads
    // the same and a full rollout would breach the 58k-triangle backstop
    // (measured worst ~56.1k at 14% vs ~57.6k at 36%, seed 18). The backstop
    // test re-measures it. `rnd()` is drawn either way, so the knob never
    // perturbs the LCG stream.
    if (h >= 8 && (detail || rnd() < 0.14)) {
      const lip = capBox(bw + 1.6, 1.1, bd + 1.6, shade.clone().multiplyScalar(0.8))
      lip.translate(wx, baseY + h + 0.15, wz)
      push(band, lip)
    }
    // roofline variation — every block topping out bare reads as flat crates:
    // stepped setback / small dark unit / flat.
    const roofRoll = rnd()
    if (h > 12 && roofRoll < 0.36) {
      const sh = 3.5 + rnd() * 4.5
      // the setback storey wears its block's grid too (one floor of it)
      facadeBlock(band, wx + bw * 0.07, wz - bd * 0.06, bw * 0.66, sh, bd * 0.66, shade.clone().multiplyScalar(0.93), style, bayW, storeys(sh), baseY + h)
    } else if (h > 12 && roofRoll < 0.58) {
      const unit = tint(new THREE.BoxGeometry(bw * 0.3, 3.2, bd * 0.3), CITY.roof)
      unit.translate(wx + bw * 0.18, baseY + h + 1.6, wz - bd * 0.14)
      push(band, unit)
    } else {
      // the bare flat roofs (42 %) take a roof the skyline can read, chosen
      // by site (no LCG draw): a pitched house roof on the low stock, a
      // timber water tank on the mid-rise, a Second-Empire mansard on the
      // pale stone — the "flat crate" tops the critic named
      const k = site(wx, wz, 2)
      if (style !== 'tower' && h < 20 && k < 0.45) {
        const rise = Math.min(bw, bd) * 0.32
        const roof = tint(gableRoof(bw + 1.2, bd + 1.2, rise), (k < 0.2 ? CITY.slateRoof : CITY.terracotta).clone())
        roof.translate(wx, baseY + h + 0.4, wz)
        push(band, roof)
        fabric.pitched++
      } else if (h >= 16 && h < 70 && k < 0.62) {
        waterTower(band, wx - bw * 0.2, wz + bd * 0.18, baseY + h + 0.6, Math.min(bw, bd))
      } else if (style === 'grey' && h < 48 && k < 0.85) {
        mansard(band, wx, wz, bw, bd, baseY + h + 0.6, k < 0.7 ? CITY.slateRoof : CITY.copper)
      }
    }
  }

  /** A block shell wearing the atlas: one box, its walls re-mapped onto
   * `style`'s window grid (cityFacade.ts). `bayW` is the WORLD bay width the
   * style was tuned at; city scale widens it 10 % and converts it to
   * maquette units, so a K-times-wider wall carries more bays (up to the
   * atlas's 14), not K-times-wider windows. */
  function facadeBlock(
    band: Band,
    wx: number,
    wz: number,
    w: number,
    h: number,
    d: number,
    tone: THREE.Color,
    style: FacadeStyle,
    bayW: number,
    floors: number,
    y0 = baseY,
  ): void {
    const body = new THREE.BoxGeometry(w, h, d)
    // reads the box's native UVs; a rooftop storey starts above the ground row
    facadeBoxUV(body, w, d, style, (bayW * 1.1) / K, floors, y0 > baseY ? 1 : 0)
    paint(body, tone)
    body.translate(wx, y0 + h / 2, wz)
    push(band, body)
    fabric.facades++
  }

  /** The Montréal / New-York rooftop water tank: a timber drum under a
   * conical cap on a dark steel stand (33 triangles). `span` scales it to
   * its roof. */
  function waterTower(band: Band, x: number, z: number, y: number, span: number): void {
    const s = Math.min(1.25, Math.max(0.75, span / 34))
    const stand = tint(new THREE.BoxGeometry(5.2 * s, 2.6 * s, 5.2 * s), CITY.iron.clone().multiplyScalar(1.1))
    stand.translate(x, y + 1.3 * s, z)
    push(band, stand)
    const th = 5.6 * s
    const tank = tint(new THREE.CylinderGeometry(3 * s, 3 * s, th, 7, 1, true), CITY.tank.clone())
    tank.translate(x, y + 2.6 * s + th / 2, z)
    push(band, tank)
    const cap = tint(new THREE.ConeGeometry(3.4 * s, 2.6 * s, 7, 1, true), CITY.slateRoof.clone().multiplyScalar(0.85))
    cap.translate(x, y + 2.6 * s + th + 1.3 * s, z)
    push(band, cap)
    fabric.waterTowers++
  }

  /** Second-Empire mansard over the cornice: steep lower slopes (inset 22 %
   * of the short side), flat top — greystone Montréal's roof. */
  function mansard(band: Band, x: number, z: number, w: number, d: number, y: number, tone: THREE.Color): void {
    const rise = Math.min(7, Math.min(w, d) * 0.26)
    const roof = tint(hipRoof(w + 1.4, d + 1.4, rise, Math.min(w, d) * 0.22), tone.clone())
    roof.translate(x, y, z)
    push(band, roof)
    fabric.mansards++
  }

  /** Montréal walk-up (user ask "design Montréalais"): a 2–3 storey flat
   * roof under a proud contrasting CORNICE parapet, tall window cells, a
   * deterministic roof treatment (plain parapet / penthouse box / rooftop
   * unit), and — near ring, street side — the iconic diagonal
   * exterior-staircase prism. `mask` (faces +Z,−Z,+X,−X) blanks the
   * shared side walls of attached plex-row segments. */
  const walkup = (
    band: Band,
    wx: number,
    wz: number,
    w: number,
    d: number,
    h: number,
    tone: THREE.Color,
    detail: boolean,
    o: { mask?: [boolean, boolean, boolean, boolean]; stair?: [number, number] } = {},
  ): void => {
    const shade = tone.clone().multiplyScalar(0.94 + rnd() * 0.12)
    const floors = storeys(h)
    // the walk-up's sash grid comes from the atlas now (brick 'plex', pale
    // stone 'grey'), on every walk-up and every face — a shared plex wall is
    // hidden by its neighbour anyway. The old cells' LCG draws are burned.
    const pale = tone === CITY.greystone || tone === CITY.greystoneLight || tone === CITY.cream
    facadeBlock(band, wx, wz, w, h, d, shade, pale ? 'grey' : 'plex', 5.5, floors)
    fabric.walkups++
    if (detail) {
      // the burn keeps the old cells' draw count (their 2-3 floors), not
      // the atlas storeys — the LCG stream, hence the layout, is unchanged
      const cellFloors = h > 16 ? 3 : 2
      const on = o.mask ?? [true, true, true, true]
      ;[w, w, d, d].forEach((fw, i) => {
        if (on[i]) burn(Math.min(3, Math.max(2, Math.round(fw / 11))) * cellFloors)
      })
    }
    // the CORNICE parapet — every walk-up wears one; light stone lips on
    // brick faces, dark sheet-metal lips on the pale greystones (the
    // contrast is what reads at distance)
    const luma = 0.2126 * shade.r + 0.7152 * shade.g + 0.0722 * shade.b
    const lipTone = luma < 0.42 ? CITY.cream.clone().multiplyScalar(0.98) : CITY.roof.clone().multiplyScalar(1.12)
    const lip = capBox(w + 2.6, 1.6, d + 2.6, lipTone)
    lip.translate(wx, baseY + h + 0.5, wz)
    push(band, lip)
    fabric.cornices++
    const roll = rnd()
    if (roll < 0.3) {
      const ph = 4 + rnd() * 2
      facadeBlock(band, wx - w * 0.1, wz + d * 0.08, w * 0.52, ph, d * 0.52, shade.clone().multiplyScalar(0.95), pale ? 'grey' : 'plex', 5.5, storeys(ph), baseY + h)
      fabric.penthouses++
    } else if (roll < 0.55) {
      const unit = tint(new THREE.BoxGeometry(w * 0.2, 2.4, d * 0.24), CITY.roof)
      unit.translate(wx + w * 0.22, baseY + h + 1.7, wz - d * 0.16)
      push(band, unit)
      fabric.roofUnits++
    } else {
      // the plain parapet roofs: a water tank on some three-storey plexes,
      // a slate mansard on some greystones (by site — no LCG draw)
      const k = site(wx, wz, 3)
      if (h > 16 && k < 0.24) waterTower(band, wx + w * 0.16, wz - d * 0.12, baseY + h + 1.2, Math.min(w, d))
      else if (pale && k < 0.6) mansard(band, wx, wz, w + 1.2, d + 1.2, baseY + h + 1.2, CITY.slateRoof)
    }
    if (o.stair) {
      // the exterior staircase, hinted as ONE diagonal prism climbing the
      // street facade to the first landing — proud of the wall by ~2, well
      // inside the street margin so the hole invariant holds
      const [fnx, fnz] = o.stair
      const fw = fnz !== 0 ? w : d
      const sLen = Math.min(11, fw * 0.55)
      const prism = tint(new THREE.BoxGeometry(sLen, 1.5, 2.4), CITY.iron)
      prism.rotateZ(0.62)
      prism.rotateY(Math.atan2(fnx, fnz))
      const offN = (fnx !== 0 ? w : d) / 2 + 1.7
      const tOff = (rnd() < 0.5 ? -1 : 1) * fw * 0.16
      prism.translate(wx + fnx * offN + fnz * tOff, baseY + 4.2, wz + fnz * offN - fnx * tOff)
      push(band, prism)
      fabric.stairs++
    }
  }

  /** Walk-up facade family: mostly brick reds/browns + greystone beiges,
   * the odd cream corner building. */
  const plexTone = (): THREE.Color => {
    const c = rnd()
    if (c < 0.26) return CITY.brick
    if (c < 0.46) return CITY.briqueRed
    if (c < 0.62) return CITY.briqueBrown
    if (c < 0.78) return CITY.greystone
    if (c < 0.9) return CITY.greystoneLight
    return CITY.cream
  }

  const tree = (
    band: Band,
    wx: number,
    wz: number,
    kind: 'cone' | 'round',
    tone: THREE.Color,
    s: number,
  ): void => {
    // open-ended primitives everywhere a cap is buried (cone bases sit on
    // the ground, trunk caps hide under crowns) — the freed triangles fund
    // the round-5 street/quay/near-ring fabric without touching the cap.
    // City scale: TREE_K keeps a tree 1.1x its K = 1 world size (24-40
    // units, 3-5 storeys), under the plaza ring's 53-65-unit blocks.
    if (kind === 'cone') {
      const h = (22 + s * 14) * TREE_K
      const cone = tint(new THREE.ConeGeometry((7 + s * 5) * TREE_K, h, 7, 1, true), tone)
      cone.translate(wx, baseY + h / 2, wz)
      push(band, cone)
    } else {
      // round tree: short trunk keeps the crown fully ABOVE the desk plane
      // (a ground-sunk sphere would dip below baseY)
      const r = (8 + s * 6) * TREE_K
      const trunkH = r * 0.9
      const trunk = tint(new THREE.CylinderGeometry(1.6 * TREE_K, 2.2 * TREE_K, trunkH, 5, 1, true), CITY.trunk)
      trunk.translate(wx, baseY + trunkH / 2, wz)
      push(band, trunk)
      const crown = tint(new THREE.SphereGeometry(r, 6, 4), autumn(wx, wz, tone))
      crown.translate(wx, baseY + trunkH + r * 0.75, wz)
      push(band, crown)
    }
  }

  /** A round crown is a MAPLE in October more often than not: red, orange or
   * gold, by site (no LCG draw); the rest keep their summer green. */
  function autumn(x: number, z: number, green: THREE.Color): THREE.Color {
    const k = site(x, z, 4)
    if (k >= 0.62) return green
    fabric.autumnTrees++
    const leaf = k < 0.24 ? CITY.mapleRed : k < 0.45 ? CITY.mapleOrange : CITY.mapleGold
    return leaf.clone().multiplyScalar(0.9 + site(x, z, 5) * 0.2)
  }

  // ── fixed landmarks first (they own the LCG head; blocks fill after) ──
  // The iso camera (azimuth 40°) sits in the +X/+Z quadrant, so −X/−Z is
  // the up-screen desk the default frame shows beyond the board.
  const upX = Math.tan((40 * Math.PI) / 180) // up-screen x-per-z slope
  // river: a chord strip across the SOUTH band. The default framing's
  // visible strip ends ~110 units past the hole edge, so the quay is kept
  // at 30 (a wide quay pushes the near bank out of frame) and a SECOND
  // bridge crosses near center, so one crossing sits inside the default
  // frame's strip above the board.
  const quay = 30
  const riverW = 55
  const riverHiZ = hb.minZ - margin - quay
  const riverLoZ = riverHiZ - riverW
  const riverZ = riverHiZ - riverW / 2
  const relRiverFar = hole.z - riverLoZ
  const chordSq = radius * radius - relRiverFar * relRiverFar
  // a 150-unit WORLD chord at least (maquette units: / K)
  const hasRiver = chordSq > (150 / K) ** 2
  const riverChord = hasRiver ? Math.sqrt(chordSq) : 0
  let riverGeo: THREE.BufferGeometry | null = null
  const bridgeParts: THREE.BufferGeometry[] = []
  const bridgeXs: number[] = []
  if (hasRiver) {
    const len = riverChord * 2 * 0.97
    // The water is a displaced open PLANE (a closed box spends triangles on
    // faces the banks hide). Two things keep it visible: (1) streaks live in
    // WORLD wavelengths (210/74 units) with plateau shaping, so distinct
    // light/dark bands survive at frame scale (≥6 L* apart) — a frequency
    // normalized per run-length leaves only a slow gradient in the visible
    // window; (2) long ridges displaced ALONG the run tilt the normals across
    // it, so the key light draws an elongated anisotropic streak instead of
    // one uniform PMREM sheen, and the env intensity is pulled to 0.6 so the
    // baked drift owns the value range.
    const water = new THREE.PlaneGeometry(len, riverW, 64, 8)
    water.rotateX(-Math.PI / 2) // x along the run, z across it
    const wpos = water.getAttribute('position')
    const wphase = rnd() * Math.PI * 2
    const wphase2 = rnd() * Math.PI * 2
    for (let i = 0; i < wpos.count; i++) {
      const x = wpos.getX(i)
      const z = wpos.getZ(i)
      wpos.setY(
        i,
        0.5 * Math.sin(z * ((Math.PI * 2) / 21) + x * 0.006 + wphase) +
          0.22 * Math.sin(x * ((Math.PI * 2) / 240) + wphase2),
      )
    }
    water.computeVertexNormals()
    const wcol = new Float32Array(wpos.count * 3)
    const wbase = new THREE.Color(RIVER_CSS)
    const wc = new THREE.Color()
    for (let i = 0; i < wpos.count; i++) {
      const x = wpos.getX(i)
      const z = wpos.getZ(i)
      const s1r = Math.sin(x * ((Math.PI * 2) / 210) + wphase2 * 1.3)
      const s1 = Math.sign(s1r) * Math.abs(s1r) ** 0.7 // plateau shaping — bands, not a glide
      const s2 = Math.sin(x * ((Math.PI * 2) / 74) + wphase)
      const edge = Math.min(1, Math.max(0, (riverW / 2 - Math.abs(z)) / 9))
      const m = Math.min(1.48, Math.max(0.56, 1.06 + 0.34 * s1 + 0.13 * s2)) * (0.76 + 0.24 * edge)
      wc.copy(wbase).multiplyScalar(m)
      wcol[i * 3] = wc.r
      wcol[i * 3 + 1] = wc.g
      wcol[i * 3 + 2] = wc.b
    }
    water.setAttribute('color', new THREE.BufferAttribute(wcol, 3))
    flatUV(water, FACADE_WATER_UV) // white, flat and glossy: the atlas's water texel
    water.translate(hole.x, baseY + 2.4, riverZ)
    // crisp dark WET LINE hugging each bank base, poking just above the
    // ripple crests — the readable seam that tells the eye where water
    // meets stone
    const riverParts: THREE.BufferGeometry[] = [water]
    for (const ws of [-1, 1]) {
      const wet = tint(new THREE.BoxGeometry(len * 0.99, 1.3, 6.5), CITY.wet)
      wet.translate(hole.x, baseY + 2.7, riverZ + ws * (riverW / 2 - 3.1))
      riverParts.push(wet)
    }
    riverGeo = mergeGeometries(riverParts)
    for (const p of riverParts) p.dispose()
    tris += triCount(riverGeo)
    // bank walls: darker earth edge + a lighter cap highlight on top; the
    // water overlaps INTO each wall (coplanar faces shimmer)
    const bankTone = CITY.deck.clone().multiplyScalar(0.6)
    const bankCap = CITY.deck.clone().multiplyScalar(1.06)
    for (const bs of [-1, 1]) {
      const bz = bs > 0 ? riverHiZ + 1.5 : riverLoZ - 1.5
      const wall = tint(new THREE.BoxGeometry(len, 8, 8), bankTone)
      wall.translate(hole.x, baseY + 4, bz)
      push('south', wall)
      const capStrip = tint(new THREE.BoxGeometry(len, 1.4, 6), bankCap)
      capStrip.translate(hole.x, baseY + 8.15, bz)
      push('south', capStrip)
    }
    // bridges with real extruded decks: side rails, stone abutments on both
    // banks and 3 piers standing in the water (ref3). One on the up-screen
    // bearing for the wide frame, one near center INSIDE the default
    // frame's visible strip (the bridge-in-frame invariant).
    const pushBridge = (g: THREE.BufferGeometry): void => {
      tris += triCount(g)
      bridgeParts.push(g)
    }
    const buildBridge = (bx: number): void => {
      bridgeXs.push(bx)
      const deck = tint(new THREE.BoxGeometry(26, 4.5, riverW + 34), CITY.deck)
      deck.translate(bx, baseY + 12, riverZ)
      pushBridge(deck)
      for (const rs of [-1, 1]) {
        const rail = tint(new THREE.BoxGeometry(2.5, 4.5, riverW + 34), CITY.roof)
        rail.translate(bx + rs * 11, baseY + 16.2, riverZ)
        pushBridge(rail)
      }
      for (const ds of [-1, 1]) {
        const abut = tint(new THREE.BoxGeometry(28, 10, 14), CITY.deck.clone().multiplyScalar(0.85))
        abut.translate(bx, baseY + 5, riverZ + ds * (riverW / 2 + 9))
        pushBridge(abut)
      }
      for (const ps of [-1, 0, 1]) {
        const pier = tint(new THREE.BoxGeometry(9, 10, 9), CITY.deck.clone().multiplyScalar(0.72))
        pier.translate(bx, baseY + 5, riverZ + ps * riverW * 0.28)
        pushBridge(pier)
      }
    }
    buildBridge(hole.x - (hole.z - riverZ) * upX)
    // near crossing sits a hair WEST of center: the default frame's river
    // window is the corner segment ABOVE the board's top-right edge, which
    // maps to world-x west of the hole center — an east-of-center bridge
    // (e.g. +0.18·w) projects past the right frame edge
    buildBridge(hole.x - hole.w * 0.1)
  }

  // green mount + white cross (ref3's Mont-Royal cue) just across the
  // river — MID ring, damped to a tenth of the bearing's x-slope so it
  // composes upper-RIGHT of the bridge like ref3 AND its summit + cross
  // stay under the wide frame-top ray; shrinks once to fit tight rings,
  // skipped when even that can't fit
  let mount: { x: number; z: number; r: number } | null = null
  // City scale (quality pass "montroyal"): the mount was the one landmark
  // left at its K = 1 world size — 0.06 of the ring, a 176-unit radius on
  // the test board, a summit ~80 units over the street beside 53-65-unit
  // plaza blocks and 147-unit rim blocks (tp5-montroyal-m1/city-mont-royal
  // .png: "a cake on a plate"). 0.09 is 1.5x: the maquette's summit stands
  // ~2.5 plaza blocks tall. The smaller radii stay as the tight-ring
  // fallbacks, largest first.
  for (const mr of [radius * 0.09, radius * 0.07, radius * 0.055, radius * 0.045]) {
    let mz = (hasRiver ? riverLoZ - 40 : hb.minZ - margin - 24) - mr
    // spoke multipliers reach 1.22·r — keep even the pushed facets clear
    // of the street margin and inside the ring
    mz = Math.min(mz, hb.minZ - margin - 1.28 * mr)
    // x-damping 0.10, not 0.25: at 0.25 the mount crowds so far WEST that it
    // sits in the very top of the wide frame, leaving under 50 css px of
    // headroom. The shallower damping slides it east/down-screen into the
    // frame proper. (The cut was originally made to buy an Olympic Stadium
    // landmark room beside the mount; that landmark has since been retired,
    // but the damping is kept — it is the mount's OWN framing that wanted it.)
    // 0.10 → 0.22 with the 1.5x city-scale mount (quality pass "montroyal"):
    // at 0.10 the bigger mount's summit and cross sat behind the properties
    // panel at the default framing (tp5-montroyal/city-wide.png); 0.30 put
    // the cross on the frame's top edge (tp5-montroyal-f03); 0.22 shows the
    // cross ~30 css px under the top and left of the panel (tp5-montroyal-f022).
    const mx = hole.x - (hole.z - mz) * upX * 0.22
    // 60 WORLD units of radius at least: at K = 1 an 1800-unit ring made a
    // 108-unit mount; in maquette units the same ring is 1800 / K
    if (mr * K >= 60 && Math.hypot(mx - hole.x, mz - hole.z) + mr * 1.25 <= radius * 0.97) {
      mount = { x: mx, z: mz, r: mr }
      break
    }
  }
  const mountParts: THREE.BufferGeometry[] = []
  const pushMount = (g: THREE.BufferGeometry): void => {
    tris += triCount(g)
    mountParts.push(g)
  }
  // The Blender maquette (quality pass "montroyal"), when it has arrived:
  // the procedural mount below still RUNS — its LCG draws (spokes, face
  // tones, canopy seats) are what every later block's position depends on —
  // but its geometry is dropped and the maquette takes its seat.
  const mountGlb = mount ? decorAsset('mont-royal') : null
  if (mount) {
    const mr = mount.r
    const H = mr * 0.62
    // SILHOUETTE: per-vertex hash jitter on a lathe shell is HIGH-frequency
    // noise whose adjacent silhouette samples move independently, so at
    // ~60 px on screen the outline averages back to a smooth gumdrop no
    // matter the amplitude. Large flat facets need LOW-frequency structure:
    // the mount is a 7-spoke polygonal hill
    // whose spokes ALTERNATE pushed (1.08–1.22·r) and pulled (0.78–0.92·r)
    // radii — a structural ≥16%-of-radius notch between neighbours that no
    // averaging can erase — with flat-shaded faces, one horizontal TERRACE
    // cut at 52% height, an exposed ROCK girdle below the summit cross,
    // and a small summit plateau clearing.
    const SP = 7
    const ang: number[] = []
    const mul: number[] = []
    for (let k = 0; k < SP; k++) {
      ang.push(((k + 0.5 + (rnd() - 0.5) * 0.56) / SP) * Math.PI * 2)
      mul.push(k % 2 ? 0.78 + rnd() * 0.14 : 1.08 + rnd() * 0.14)
    }
    // profile rings: [radius fraction, height fraction] — two rings share
    // y=0.52 to carve the flat terrace annulus into the silhouette
    const RINGS: Array<[number, number]> = [
      [1, 0],
      [0.8, 0.3],
      [0.64, 0.52],
      [0.5, 0.52],
      [0.4, 0.72],
      [0.26, 0.88],
      [0.14, 1],
    ]
    // spoke-radius interpolation + surface height under the faceted shell —
    // hoisted ABOVE the face-color loop so ravine faces
    // (pulled spokes) can darken their lawn, and so the canopy seats on the
    // real slope instead of floating over a ravine
    const tau = Math.PI * 2
    const spokeAt = (th: number): number => {
      let a = ((th % tau) + tau) % tau
      if (a < ang[0]) a += tau
      let k = SP - 1
      for (let i = 0; i < SP; i++) if (ang[i] <= a) k = i
      const a1 = k === SP - 1 ? ang[0] + tau : ang[k + 1]
      const f = a1 === ang[k] ? 0 : (a - ang[k]) / (a1 - ang[k])
      return mul[k] + (mul[(k + 1) % SP] - mul[k]) * f
    }
    const hillY = (dx: number, dz: number): number => {
      const d = Math.hypot(dx, dz)
      if (d < 1e-6) return H
      const rho = d / (mr * spokeAt(Math.atan2(dz, dx)))
      if (rho >= 1) return 0
      for (let i = 0; i < RINGS.length - 1; i++) {
        const [t0, y0] = RINGS[i]
        const [t1, y1] = RINGS[i + 1]
        if (rho <= t0 && rho >= t1) {
          const f = t0 === t1 ? 0 : (t0 - rho) / (t0 - t1)
          return (y0 + (y1 - y0) * f) * H
        }
      }
      return H
    }
    const verts: number[] = []
    for (const [t, yf] of RINGS)
      for (let k = 0; k < SP; k++)
        verts.push(Math.cos(ang[k]) * t * mr * mul[k], yf * H, Math.sin(ang[k]) * t * mr * mul[k])
    const apex = verts.length / 3
    verts.push(0, H, 0)
    const idx: number[] = []
    for (let ri = 0; ri < RINGS.length - 1; ri++)
      for (let k = 0; k < SP; k++) {
        const a = ri * SP + k
        const b = ri * SP + ((k + 1) % SP)
        const c = (ri + 1) * SP + k
        const d = (ri + 1) * SP + ((k + 1) % SP)
        idx.push(a, c, b, b, c, d)
      }
    const topRow = (RINGS.length - 1) * SP
    for (let k = 0; k < SP; k++) idx.push(topRow + k, apex, topRow + ((k + 1) % SP))
    const indexed = new THREE.BufferGeometry()
    indexed.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    indexed.setIndex(idx)
    const hill = indexed.toNonIndexed() // flat shading: unshared verts → per-face normals
    indexed.dispose()
    hill.computeVertexNormals()
    const hpos = hill.getAttribute('position')
    const hnrm = hill.getAttribute('normal')
    const hcol = new Float32Array(hpos.count * 3)
    const ftone = new THREE.Color()
    for (let f = 0; f < hpos.count; f += 3) {
      const avgY = (hpos.getY(f) + hpos.getY(f + 1) + hpos.getY(f + 2)) / 3
      // pulled-spoke ravine factor, computed for EVERY face: applied only to
      // the lawn, the terrace + rock-girdle bands (0.52–0.73·H — the visually
      // dominant annulus at the iso elevation) would paint flat tan over the
      // cuts, and a 0.7 lawn floor alone is too shallow at ~80 px on screen.
      const fcx = (hpos.getX(f) + hpos.getX(f + 1) + hpos.getX(f + 2)) / 3
      const fcz = (hpos.getZ(f) + hpos.getZ(f + 1) + hpos.getZ(f + 2)) / 3
      const rav = Math.min(1, Math.max(0, (1 - spokeAt(Math.atan2(fcz, fcx))) / 0.22))
      if (avgY > H * 0.97) ftone.copy(CITY.leafA).multiplyScalar(1.15) // summit clearing plateau
      else if (Math.abs(avgY - H * 0.52) < H * 0.01 && hnrm.getY(f) > 0.7)
        ftone.copy(CITY.apron).multiplyScalar(0.9) // trodden terrace path
      else if (avgY > H * 0.53 && avgY < H * 0.73)
        ftone.copy(CITY.rock).multiplyScalar(0.9 + rnd() * 0.2) // exposed rock girdle below the cross
      else {
        ftone.copy(CITY.mount).multiplyScalar(0.86 + rnd() * 0.24)
        // the value crease doubles the geometric notch so the silhouette
        // break still reads when the notch itself is edge-on to the camera
        ftone.multiplyScalar(1 - 0.3 * rav)
      }
      // shadowed-cut albedo: every non-summit band drops a further 28% in
      // the ravines (multiplicative, so the addMerged sun grade preserves
      // it) — lawn cuts land ≈0.50×, the tan girdle ≈0.72× its flanks
      if (avgY <= H * 0.97) ftone.multiplyScalar(1 - 0.28 * rav)
      for (let v = 0; v < 3; v++) {
        hcol[(f + v) * 3] = ftone.r
        hcol[(f + v) * 3 + 1] = ftone.g
        hcol[(f + v) * 3 + 2] = ftone.b
      }
    }
    hill.setAttribute('color', new THREE.BufferAttribute(hcol, 3))
    flatUV(hill) // the atlas's plain texel, like every city part
    hill.translate(mount.x, baseY, mount.z)
    pushMount(hill)
    // chunky white cross standing PROUD on the summit plateau — ~6-unit
    // members survive the mid-ring projection as a clear icon. The hill is
    // non-indexed, and mergeGeometries demands matching layouts, so the
    // cross boxes drop their index to align (tint gives both the plain UV).
    // City scale: the mount keeps its K = 1 world size (its radius is a
    // fraction of the ring), so the cross does too — 20 world units at least
    // — on members 1.3x their old 5.5 (they would be K times it)
    const ch = Math.max(20 / K, mr * 0.3)
    const cm = (5.5 * 1.3) / K
    const post = tint(new THREE.BoxGeometry(cm, ch, cm).toNonIndexed(), CITY.cross)
    post.translate(mount.x, baseY + H - 2 / K + ch / 2, mount.z)
    pushMount(post)
    const arms = tint(new THREE.BoxGeometry(ch * 0.55, cm, cm).toNonIndexed(), CITY.cross)
    arms.translate(mount.x, baseY + H - 2 / K + ch * 0.7, mount.z)
    pushMount(arms)
    // with the maquette, the procedural canopy is built for its draws only
    // (the civic cell's `sink` contract): it would stand in the maquette's
    // own forest
    const sinkBefore = sink
    if (mountGlb) sink = true
    // canopy: SMALLER clusters than round 4 (rb ≤ 0.15·r) so the facet
    // planes and notches stay readable; each stands proud with a darker
    // under-rim collar for its own self-shadow edge
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * tau + rnd() * 0.7
      const d = mr * (0.42 + rnd() * 0.3)
      const rb = mr * (0.1 + rnd() * 0.05)
      const bxp = mount.x + Math.cos(a) * d
      const bzp = mount.z + Math.sin(a) * d
      // Mont-Royal in October: some canopy clusters turn
      const blobTone = autumn(bxp, bzp, (i % 2 ? CITY.leafA : CITY.leafB).clone()).multiplyScalar(0.86 + rnd() * 0.26)
      const yy = hillY(bxp - mount.x, bzp - mount.z)
      if (yy < 6 / K) continue // pulled-spoke ravine — no shelf to stand on (6 world)
      const sy = baseY + yy - rb * 0.22
      const collar = tint(
        new THREE.CylinderGeometry(rb * 1.02, rb * 0.78, rb * 0.5, 8, 1, true),
        blobTone.clone().multiplyScalar(0.52),
      )
      collar.translate(bxp, Math.max(baseY + rb * 0.26, sy - rb * 0.18), bzp)
      push('south', collar)
      const crown = tint(new THREE.SphereGeometry(rb, 7, 4, 0, tau, 0, Math.PI / 2), blobTone)
      crown.scale(1, 0.75, 1)
      crown.translate(bxp, sy, bzp)
      push('south', crown)
    }
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * tau + rnd() * 0.6
      const d = mr * (0.55 + rnd() * 0.28)
      const th = (14 + rnd() * 9) * TREE_K
      const cxp = mount.x + Math.cos(a) * d
      const czp = mount.z + Math.sin(a) * d
      const yy = hillY(cxp - mount.x, czp - mount.z)
      if (yy < 4 / K) continue
      const cone = tint(new THREE.ConeGeometry(5.5 * TREE_K, th, 6, 1, true), i % 2 ? CITY.leafA : CITY.leafB)
      cone.translate(cxp, baseY + yy + th / 2 - 3 * TREE_K, czp)
      push('south', cone)
    }
    // up-sun canopy densification: the sun-facing spokes
    // carry DOUBLE tree density in a second, clearly SMALLER size class —
    // understory cones + small crowns under the big clusters — so the mount
    // silhouette breaks into texture instead of reading smooth-cone at the
    // aaa-hero-ref3 wide framing. Ravines stay clear (their dark lawn is
    // the read); ~11 seats ≈ the 11 baseline canopy items, restricted to
    // the ±66° up-sun fan.
    const sunAng = Math.atan2(sunZ, sunX)
    for (let i = 0; i < 11; i++) {
      const a = sunAng + (rnd() - 0.5) * 2.3
      const d = mr * (0.3 + rnd() * 0.45)
      const txp = mount.x + Math.cos(a) * d
      const tzp = mount.z + Math.sin(a) * d
      const yy = hillY(txp - mount.x, tzp - mount.z)
      if (yy < 5 / K) continue
      if (rnd() < 0.45) {
        const th = (8 + rnd() * 6) * TREE_K
        const cone = tint(new THREE.ConeGeometry(3.1 * TREE_K, th, 5, 1, true), i % 2 ? CITY.leafB : CITY.leafA)
        cone.translate(txp, baseY + yy + th / 2 - 1.5 * TREE_K, tzp)
        push('south', cone)
      } else {
        const rb = mr * (0.045 + rnd() * 0.03)
        const crown = tint(
          new THREE.SphereGeometry(rb, 6, 3, 0, tau, 0, Math.PI / 2),
          (i % 2 ? CITY.leafA : CITY.leafB).clone().multiplyScalar(0.8 + rnd() * 0.3),
        )
        crown.scale(1, 0.7, 1)
        crown.translate(txp, baseY + yy - rb * 0.1, tzp)
        push('south', crown)
      }
    }
    sink = sinkBefore
    if (mountGlb) {
      for (const g of mountParts) {
        tris -= triCount(g)
        g.dispose()
      }
      mountParts.length = 0
      pushMount(montRoyalGeometry(mountGlb, mount, baseY))
    }
  }
  yield

  /** PLAZA height (city scale): a walk-up height of the K = 1 range
   * (12.5-21.5) mapped onto 24.6-30 maquette units = 54-66 world — every
   * block facing the board stands at least the board's thickness over the
   * street (slab 14 + podium 16 = 30) plus three CITY_STOREYs (24), the read
   * of a civic place framed by mid-rise blocks instead of a crate among
   * cottages (tp3-final-dpr1/city-wide.png). The order of the range is kept,
   * so the roofline still varies. */
  const plazaH = (h: number): number => 24.6 + (h - 12.5) * 0.6

  // ── near-ring in-fill: the street's far side gets built edge-to-edge ──
  // Walk the hole perimeter and seat LOW props — 1–2-storey shopfronts and
  // single trees — directly across the street. Occupancy is tallied per
  // FACE (60° sectors straddle the hole's corners, so N/S corner props could
  // satisfy a west-facing sector while the west FACE itself stayed empty),
  // with a rotated-sector tally guarding the diagonals.
  const faceCounts = [0, 0, 0, 0] // +Z, −Z, +X, −X
  const sectors = [0, 0, 0, 0, 0, 0] // 60° bins CENTERED on E/NE/../W bearings (+30° twist)
  const sectorOf = (x: number, z: number): number =>
    Math.min(
      5,
      Math.floor(
        (((Math.atan2(z - hole.z, x - hole.x) + Math.PI / 6) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 3),
      ),
    )
  const seatNear = (px: number, pz: number, nx: number, nz: number, force = false): boolean => {
    const roll = rnd()
    if (roll < 0.14 && !force) return false // gaps — a solid picket would read as a fence
    const off = rnd() * 20
    const jitter = (rnd() - 0.5) * 22 // slide along the street
    const tally = (cx: number, cz: number): void => {
      sectors[sectorOf(cx, cz)]++
      faceCounts[nz > 0 ? 0 : nz < 0 ? 1 : nx > 0 ? 2 : 3]++
    }
    if (roll < 0.66) {
      const bw = 20 + rnd() * 20
      const bd = 16 + rnd() * 8
      const cx = px + nx * (off + bw / 2) + nz * jitter
      const cz = pz + nz * (off + bd / 2) + nx * jitter
      const band = bandFor(cx - bw / 2, cx + bw / 2, cz - bd / 2, cz + bd / 2)
      if (!band) return false
      if (hasRiver && cz + bd / 2 > riverLoZ - 6 && cz - bd / 2 < riverHiZ + 2) return false
      if (hasRiver && nz < 0 && bridgeXs.some((bx) => Math.abs(cx - bx) < 38)) return false // keep the bridge heads clear
      if (mount && Math.hypot(cx - mount.x, cz - mount.z) < mount.r * 1.25 + Math.max(bw, bd)) return false
      if (Math.hypot(cx - hole.x, cz - hole.z) + Math.max(bw, bd) > radius) return false
      // Montréal walk-up row: the brick/greystone wardrobe, and mostly a
      // staircase prism on the facade FACING the street/board — the
      // near-ring signature. City scale: the row facing the plaza stands at
      // PLAZA height (the board's thickness plus 3-4 storeys).
      const h = plazaH(rnd() < 0.55 ? 18.5 + rnd() * 3 : 12.5 + rnd() * 2)
      walkup(band, cx, cz, bw, bd, h, plexTone(), true, {
        stair: rnd() < 0.7 ? [-nx, -nz] : undefined,
      })
      tally(cx, cz)
      return true
    }
    const s = rnd() * 0.7
    const r = 14 // conservative footprint half-extent for either tree kind
    const cx = px + nx * (off + r) + nz * jitter
    const cz = pz + nz * (off + r) + nx * jitter
    const band = bandFor(cx - r, cx + r, cz - r, cz + r)
    if (!band) return false
    if (hasRiver && cz + r > riverLoZ - 6 && cz - r < riverHiZ + 2) return false
    if (hasRiver && nz < 0 && bridgeXs.some((bx) => Math.abs(cx - bx) < 38)) return false
    if (mount && Math.hypot(cx - mount.x, cz - mount.z) < mount.r * 1.25 + r) return false
    if (Math.hypot(cx - hole.x, cz - hole.z) + r > radius) return false
    tree(band, cx, cz, rnd() < 0.4 ? 'cone' : 'round', rnd() < 0.5 ? CITY.leafA : CITY.leafB, s)
    tally(cx, cz)
    return true
  }
  const nearStep = 66
  for (let x = hb.minX - margin; x <= hb.maxX + margin; x += nearStep) {
    seatNear(x + rnd() * 30, hb.maxZ + margin, 0, 1)
    seatNear(x + rnd() * 30, hb.minZ - margin, 0, -1)
  }
  for (let z = hb.minZ - margin; z <= hb.maxZ + margin; z += nearStep) {
    seatNear(hb.maxX + margin, z + rnd() * 30, 1, 0)
    seatNear(hb.minX - margin, z + rnd() * 30, -1, 0)
  }
  // face guarantee — 5+ per face, west first (the flank the default framing
  // shows); forced seats skip only the cosmetic gap roll, never the
  // exclusion checks
  const spanX = hole.w + margin * 2
  const spanZ = hole.h + margin * 2
  const faceSeat: Array<(u: number) => boolean> = [
    (u) => seatNear(hb.minX - margin + u * spanX, hb.maxZ + margin, 0, 1, true),
    (u) => seatNear(hb.minX - margin + u * spanX, hb.minZ - margin, 0, -1, true),
    (u) => seatNear(hb.maxX + margin, hb.minZ - margin + u * spanZ, 1, 0, true),
    (u) => seatNear(hb.minX - margin, hb.minZ - margin + u * spanZ, -1, 0, true),
  ]
  for (const f of [3, 1, 0, 2]) for (let tries = 0; faceCounts[f] < 5 && tries < 16; tries++) faceSeat[f](rnd())
  // diagonal top-up: aim a seeded ray through each starving rotated sector
  const exHalf = hole.w / 2 + margin
  // (seatNear's shopfront/tree footprints, offsets and the 66-unit walk
  // are maquette units: K times larger in the world, like the blocks)
  const ezHalf = hole.h / 2 + margin
  for (let s = 0; s < 6; s++) {
    for (let tries = 0; sectors[s] < 3 && tries < 12; tries++) {
      const a = (s - 0.5 + rnd()) * (Math.PI / 3)
      const dx = Math.cos(a)
      const dz = Math.sin(a)
      const tx = exHalf / Math.max(1e-9, Math.abs(dx))
      const tz = ezHalf / Math.max(1e-9, Math.abs(dz))
      const t = Math.min(tx, tz)
      seatNear(
        hole.x + dx * t,
        hole.z + dz * t,
        tx <= tz ? Math.sign(dx) : 0,
        tx <= tz ? 0 : Math.sign(dz),
        true,
      )
    }
  }
  yield

  // ── apron plaza ring + quays: pave the street ring the walk seats onto ──
  // The ring runs from the hole edge (2-unit reveal) to the margin line in
  // the concrete family (not the desk's own hue), so the board sits on a
  // plaza instead of bare sand.
  const paveStrip = (
    pband: Band,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    tone: THREE.Color,
  ): void => {
    if (maxX - minX < 8 || maxZ - minZ < 8) return
    const strip = tint(new THREE.PlaneGeometry(maxX - minX, maxZ - minZ), tone)
    strip.rotateX(-Math.PI / 2)
    strip.translate((minX + maxX) / 2, baseY + 0.45, (minZ + maxZ) / 2)
    push(pband, strip)
  }
  const apronTone = (): THREE.Color => CITY.apron.clone().multiplyScalar(0.97 + rnd() * 0.06)
  paveStrip('north', hb.minX - margin, hb.maxX + margin, hb.maxZ + 2, hb.maxZ + margin, apronTone())
  paveStrip('south', hb.minX - margin, hb.maxX + margin, hb.minZ - margin, hb.minZ - 2, apronTone())
  paveStrip('east', hb.maxX + 2, hb.maxX + margin, hb.minZ - 2, hb.maxZ + 2, apronTone())
  paveStrip('west', hb.minX - margin, hb.minX - 2, hb.minZ - 2, hb.maxZ + 2, apronTone())
  if (hasRiver) {
    // stone quay decks on BOTH banks — the near one carries the shopfront
    // row, the far one bridges the gap to the first south lattice row
    const qx = riverChord * 0.94
    paveStrip('south', hole.x - qx, hole.x + qx, riverHiZ + 5.6, hb.minZ - margin, apronTone())
    paveStrip('south', hole.x - qx, hole.x + qx, hb.minZ - margin - step, riverLoZ - 5.6, apronTone())
  }

  // ── street ribbons: radial roads from the board apron into the clusters ──
  // (round-5 sev8 ask) — planes ABOVE the pads (1.4 vs 0.95) so the ribbon
  // reads continuously across the fabric; two on the west flank the critic
  // framing shows, one east, one north, one south meeting the near bridge.
  // 18 maquette = 40 world (was 24 world): a three-lane avenue against the
  // ~9-unit vans, where 24 x K would have been a 53-unit boulevard
  const streetW = 18
  const streetLen = (want: number): number =>
    Math.max(120, Math.min(want, radius - Math.max(spanX, spanZ) / 2 - 60))
  const streetRects: Array<{ band: Band; minX: number; maxX: number; minZ: number; maxZ: number }> = []
  const streetAt = (sband: Band, minX: number, maxX: number, minZ: number, maxZ: number): void => {
    const s = tint(
      new THREE.PlaneGeometry(maxX - minX, maxZ - minZ),
      CITY.street.clone().multiplyScalar(0.95 + rnd() * 0.1),
    )
    s.rotateX(-Math.PI / 2)
    s.translate((minX + maxX) / 2, baseY + 1.4, (minZ + maxZ) / 2)
    push(sband, s)
    streetRects.push({ band: sband, minX, maxX, minZ, maxZ })
  }
  const wz1 = hole.z - Math.min(76, hole.h * 0.12)
  const wz2 = hole.z + Math.min(148, hole.h * 0.23)
  streetAt('west', hb.minX - margin - streetLen(620), hb.minX - 2, wz1 - streetW / 2, wz1 + streetW / 2)
  streetAt('west', hb.minX - margin - streetLen(430), hb.minX - 2, wz2 - streetW / 2, wz2 + streetW / 2)
  const ez1 = hole.z + Math.min(52, hole.h * 0.08)
  streetAt('east', hb.maxX + 2, hb.maxX + margin + streetLen(430), ez1 - streetW / 2, ez1 + streetW / 2)
  const nx1 = hole.x - Math.min(96, hole.w * 0.1)
  streetAt('north', nx1 - streetW / 2, nx1 + streetW / 2, hb.maxZ + 2, hb.maxZ + margin + streetLen(430))
  const sx1 = hole.x - hole.w * 0.1 // aligned with the near bridge → street runs onto the deck
  if (hasRiver) streetAt('south', sx1 - streetW / 2, sx1 + streetW / 2, riverHiZ + 4, hb.minZ - 2)
  else streetAt('south', sx1 - streetW / 2, sx1 + streetW / 2, hb.minZ - margin - streetLen(430), hb.minZ - 2)

  // boulevard maples round the civic plaza (quality pass "city": greenery
  // where the board meets its city) — one row in the street margin along
  // the two UP-SCREEN edges (west, south), so they frame the board without
  // ever standing between it and the default camera. Crowns (r ≤ 9) end
  // ≥ 5 units off the hole; the radial streets keep their mouths clear.
  // Placed by step + site hash: no LCG draw. City scale: the spacing, the
  // set-back and the jitter keep their WORLD values (70 / 15 / 12; a crown
  // is ≤ 9.8 world at TREE_K, so it still ends ≥ 5 off the hole).
  const boulevard = 70 / K
  for (let z = hb.minZ + 30 / K; z <= hb.maxZ - 30 / K; z += boulevard) {
    if (Math.abs(z - wz1) < 26 / K || Math.abs(z - wz2) < 26 / K) continue
    tree('west', hb.minX - 15 / K, z + ((site(-1, z, 9) - 0.5) * 12) / K, 'round', CITY.leafB, site(-1, z, 10) * 0.15)
  }
  for (let x = hb.minX + 30 / K; x <= hb.maxX - 30 / K; x += boulevard) {
    if (Math.abs(x - sx1) < 28 / K) continue
    tree('south', x + ((site(x, -1, 9) - 0.5) * 12) / K, hb.minZ - 15 / K, 'round', CITY.leafA, site(x, -1, 10) * 0.15)
  }
  yield

  // ── street life (critique #6 sev6): walkers + vehicles ON the ribbons ──
  // Critique #7 sev7 root-caused the round-6 build's INVISIBLE street life:
  // the props were emitted (manifest counts passed vitest) but a walker
  // totalled ~7 world units — ~2.5 css px at the wide framing (~0.35 px per
  // unit) — in city tones knocked toward the street grey, and the rnd·rnd
  // spawn bias still averaged ~0.21·len ≈ 130+ units from the board end,
  // past the ~110-unit strip the default crop shows. Three-part fix:
  // silhouettes DOUBLE to ~14–16 units in a dedicated saturated/dark
  // wardrobe (deep red / navy / forest / plum — nothing the pale streets
  // can absorb), the scatter distance is capped near the board-adjacent
  // end, and every framing-visible ribbon (both west + the south
  // bridge street) gets a GUARANTEED seat within the default crop's strip.
  const streetLife: {
    people: Array<{ x: number; z: number }>
    vehicles: Array<{ x: number; z: number }>
  } = { people: [], vehicles: [] }
  const COAT = ['#8E3B2F', '#33475E', '#3F5D46', '#6E3A52'].map((c) => new THREE.Color(c))
  const PAINT = ['#A63D2E', '#2F5D5A', '#B0812F', '#33475E'].map((c) => new THREE.Color(c))
  const lifeGuard = (x: number, z: number, ext: number): boolean => {
    if (hasRiver && z + ext > riverLoZ - 6 && z - ext < riverHiZ + 6) return false
    if (mount && Math.hypot(x - mount.x, z - mount.z) < mount.r * 1.3 + ext) return false
    return Math.hypot(x - hole.x, z - hole.z) + ext <= radius
  }
  // City scale: a walker is ~8 world units on the street (LIFE_K — one
  // storey, a heroic person like the city moose), a vehicle 19-24 long and
  // ~8 tall (VEH_K: a van or a bus against the 8-unit storey). Both stand
  // on the street ribbon (1.4) by an unscaled 1.5 lift.
  const person = (band: Band, wx: number, wz: number): void => {
    const br = (1.8 + rnd() * 0.4) * LIFE_K
    const len = (4.6 + rnd() * 1.8) * LIFE_K
    const tone = COAT[Math.floor(rnd() * 4)].clone().multiplyScalar(0.88 + rnd() * 0.24)
    const body = tint(new THREE.CapsuleGeometry(br, len, 2, 6), tone)
    body.translate(wx, baseY + 1.5 + br + len / 2, wz)
    push(band, body)
    const hr = br * (1.05 + rnd() * 0.15)
    const head = tint(new THREE.SphereGeometry(hr, 6, 4), CITY.skin.clone().multiplyScalar(0.9 + rnd() * 0.2))
    head.translate(wx, baseY + 1.5 + len + br * 2 + hr * 0.5, wz)
    push(band, head)
    streetLife.people.push({ x: wx, z: wz })
  }
  const vehicle = (band: Band, wx: number, wz: number, alongX: boolean): void => {
    const vl = (22 + rnd() * 6) * VEH_K
    const vw = (10 + rnd() * 2.4) * VEH_K
    const bh = (6 + rnd() * 1.4) * VEH_K
    const tone = PAINT[Math.floor(rnd() * 4)].clone().multiplyScalar(0.88 + rnd() * 0.24)
    const body = tint(new THREE.BoxGeometry(alongX ? vl : vw, bh, alongX ? vw : vl), tone)
    body.translate(wx, baseY + 1.5 + bh / 2, wz)
    push(band, body)
    // "slightly rounded top": a flattened cylinder cabin lying along travel,
    // embedded into the body so only the round crown pokes proud
    const cab = new THREE.CylinderGeometry(vw * 0.4, vw * 0.4, vl * 0.5, 7)
    cab.rotateZ(Math.PI / 2)
    if (!alongX) cab.rotateY(Math.PI / 2)
    cab.scale(1, 0.62, 1)
    tint(cab, tone.clone().multiplyScalar(0.82))
    cab.translate(wx, baseY + 1.5 + bh - 0.6 * VEH_K, wz)
    push(band, cab)
    streetLife.vehicles.push({ x: wx, z: wz })
  }
  const vehWant = 3 + Math.floor(rnd() * 3) // 3–5, deterministic per seed
  let vehPlaced = 0
  const rectGeom = (rect: (typeof streetRects)[number]) => {
    const alongX = rect.maxX - rect.minX >= rect.maxZ - rect.minZ
    const len = alongX ? rect.maxX - rect.minX : rect.maxZ - rect.minZ
    // the board-adjacent end: west streets end high-X, south streets high-Z
    const nearHi = alongX ? rect.band === 'west' : rect.band === 'south'
    // the east and north streets run into the civic podium's flights of
    // steps (buildCityPodium, '+x' / '+z': they reach PODIUM_STAIR_REACH
    // past the hole edge), so their street life starts past the bottom step
    // — a car parked on the stairs, iter4 city-wide.png (world units, hence
    // the / K)
    const lead = nearHi ? 0 : (PODIUM_STAIR_REACH + 8) / K
    const at = (dAlong: number, dAcross: number): [number, number] => {
      const a = nearHi ? (alongX ? rect.maxX : rect.maxZ) - dAlong : (alongX ? rect.minX : rect.minZ) + lead + dAlong
      const c = (alongX ? (rect.minZ + rect.maxZ) / 2 : (rect.minX + rect.maxX) / 2) + dAcross
      return alongX ? [a, c] : [c, a]
    }
    return { alongX, len, at }
  }
  // guaranteed near-board seats FIRST (so the vehicle cap can never starve
  // them): the two west ribbons + the south bridge street are the segments
  // the default framing actually crops — one walker each inside the first
  // ~75 units off the board apron (the south cap stays under the river
  // guard's reach), and one vehicle on the first west ribbon. City scale:
  // the reaches are maquette units, so they shrink to keep each seat inside
  // the ~150 WORLD units of street the default frame crops (west: 2 + 8 +
  // 56 → ≤ 145 world; south: 8 + 36 stays short of the river guard, which
  // sits 66.8 + 6 maquette units off the hole now; the vehicle ≤ 132 world).
  for (const [ri, dMax] of [[0, 56], [1, 56], [4, 36]] as Array<[number, number]>) {
    const rect = streetRects[ri]
    if (!rect) continue
    const { at } = rectGeom(rect)
    const [px, pz] = at(8 + rnd() * dMax, (rnd() < 0.5 ? -1 : 1) * streetW * (0.18 + rnd() * 0.14))
    if (lifeGuard(px, pz, 4)) person(rect.band, px, pz)
  }
  if (streetRects[0]) {
    const { alongX, at } = rectGeom(streetRects[0])
    const [vx, vz] = at(14 + rnd() * 44, (rnd() - 0.5) * streetW * 0.16)
    if (lifeGuard(vx, vz, 15)) {
      vehicle(streetRects[0].band, vx, vz, alongX)
      vehPlaced++
    }
  }
  const seatLife = (rect: (typeof streetRects)[number], withPeople: boolean): void => {
    const { alongX, len, at } = rectGeom(rect)
    if (withPeople) {
      // 2–3 walkers per ribbon, rnd·rnd-biased toward the board end and
      // CAPPED at 240 WORLD units out (critique #7: the uncapped 0.85·len
      // spread parked most walkers beyond the visible strip), hugging a
      // lane edge
      const n = 2 + (rnd() < 0.5 ? 1 : 0)
      for (let i = 0; i < n; i++) {
        const [px, pz] = at(
          6 + rnd() * rnd() * Math.min(len - 12, 240 / K) * 0.85,
          (rnd() < 0.5 ? -1 : 1) * streetW * (0.18 + rnd() * 0.14),
        )
        if (lifeGuard(px, pz, 4)) person(rect.band, px, pz)
      }
    }
    if (vehPlaced < vehWant) {
      const [vx, vz] = at(10 + rnd() * rnd() * Math.min(len - 24, 260 / K) * 0.8, (rnd() - 0.5) * streetW * 0.16)
      if (lifeGuard(vx, vz, 15)) {
        vehicle(rect.band, vx, vz, alongX)
        vehPlaced++
      }
    }
  }
  for (const rect of streetRects) seatLife(rect, true)
  // top-up: the guards almost never reject on a sane board, but 3 vehicles
  // is the contract — retry vehicle-only on rotating ribbons if a seed lost
  // the roll
  for (let tries = 0; vehPlaced < 3 && tries < 8; tries++)
    seatLife(streetRects[tries % streetRects.length], false)
  yield

  // ── block grid: four MARGIN-ANCHORED band lattices ──
  // A single global lattice starting at −radius+step/2 makes whether a
  // face's first column of cells lands against its street margin luck of
  // the modulo (a face can end up with its first column ~257 units out and
  // read as bare sand). Each band's lattice is anchored AT its margin line,
  // so the first ring of pads hugs the street on every face by construction.
  const capTris = 58000 // backstop only — natural totals stay ≳1k under it (regression-tested)
  /** The west lattice cell City Hall stands on (set before that lattice). */
  let civic: { x: number; z: number } | null = null

  /** Parish church on a plaza cell: a greystone nave under a gable roof and
   * a front tower carrying a tin-silver spire. Every footprint keeps
   * |offset| + size/2 ≤ half, so the cell's bandFor verdict bounds it. */
  function church(band: Band, wx: number, wz: number): void {
    const alongX = site(wx, wz, 8) < 0.5
    const nl = half * 1.15
    const nw = Math.min(30, half * 0.5)
    const nh = 15
    const w = alongX ? nl : nw
    const d = alongX ? nw : nl
    // tall church storeys on purpose (11 world on the nave, 12.5 in the
    // tower: lancets and a belfry), where storeys() would make offices
    facadeBlock(band, wx, wz, w, nh, d, CITY.greystone.clone(), 'grey', 7, 3)
    const roof = tint(gableRoof(w + 1.2, d + 1.2, nw * 0.42), CITY.copper.clone().multiplyScalar(0.92))
    roof.translate(wx, baseY + nh, wz)
    push(band, roof)
    // the tower stands at the nave's camera-side end (+x / +z)
    const ts = Math.min(12, nw * 0.62)
    const th = 34
    const tx = wx + (alongX ? nl / 2 - ts / 2 : 0)
    const tz = wz + (alongX ? 0 : nl / 2 - ts / 2)
    facadeBlock(band, tx, tz, ts, th, ts, CITY.greystoneLight.clone(), 'grey', 6, 6)
    const spire = tint(hipRoof(ts + 0.8, ts + 0.8, 26, (ts + 0.8) / 2), CITY.tin.clone())
    spire.translate(tx, baseY + th, tz)
    push(band, spire)
    fabric.churches++
  }

  /** A civic storey is grander than CITY_STOREY: 0.7 as many floors
   * (City Hall's 55-unit block carries 5 at ~11 each, not 7 office rows). */
  const civicStoreys = (h: number): number => Math.max(1, Math.round(storeys(h) * 0.7))

  /** City Hall (Montréal's Hôtel de Ville cue): a greystone block under a
   * copper mansard, a taller central pavilion facing the board (+x) under a
   * copper hip, and the Canadian flag on its roof. */
  function civicHall(band: Band, wx: number, wz: number): void {
    const w = half * 0.9
    const d = half * 1.5
    const h = 25
    facadeBlock(band, wx, wz, w, h, d, CITY.greystoneLight.clone(), 'grey', 6.5, civicStoreys(h))
    const lip = capBox(w + 1.6, 1.2, d + 1.6, CITY.cream.clone())
    lip.translate(wx, baseY + h + 0.2, wz)
    push(band, lip)
    mansard(band, wx, wz, w, d, baseY + h + 0.7, CITY.copper)
    const pw = Math.min(26, d * 0.3)
    const pd = Math.min(18, w * 0.4)
    const ph = h + 10
    const px = wx + w / 2 - pd / 2 + 2
    facadeBlock(band, px, wz, pd, ph, pw, CITY.greystone.clone(), 'grey', 6.5, civicStoreys(ph))
    const cap = tint(hipRoof(pd + 1.4, pw + 1.4, 9, Math.min(pd, pw) * 0.36), CITY.copper.clone().multiplyScalar(1.05))
    cap.translate(px, baseY + ph, wz)
    push(band, cap)
    // the flag: a pole on the pavilion and a two-sided cloth (thin box)
    const poleH = 22
    const top = baseY + ph + 9
    const pole = tint(new THREE.CylinderGeometry(0.55, 0.7, poleH, 5, 1, true), CITY.cross.clone())
    pole.translate(px, top + poleH / 2, wz)
    push(band, pole)
    const fw = 13
    const fh = 6.5
    // white vertex tone: the atlas texels carry the flag's own red and white
    const cloth = tint(new THREE.BoxGeometry(fw, fh, 0.5), new THREE.Color(1, 1, 1))
    // the two broad faces (+z, −z: box faces 4 and 5) show the flag texels
    const uv = cloth.getAttribute('uv') as THREE.BufferAttribute
    const nativeBox = new THREE.BoxGeometry(fw, fh, 0.5)
    const native = nativeBox.getAttribute('uv')
    for (let i = 16; i < 24; i++) {
      uv.setXY(
        i,
        FACADE_FLAG_UV.u0 + native.getX(i) * (FACADE_FLAG_UV.u1 - FACADE_FLAG_UV.u0),
        FACADE_FLAG_UV.v0 + native.getY(i) * (FACADE_FLAG_UV.v1 - FACADE_FLAG_UV.v0),
      )
    }
    nativeBox.dispose()
    cloth.translate(px + fw / 2 + 0.6, top + poleH - fh / 2 - 0.6, wz)
    push(band, cloth)
    fabric.flags++
  }

  /** The CIVIC cell runs its ordinary build into the sink — every LCG draw
   * it would have made is made, so every later cell is exactly the cell it
   * was before City Hall existed — then the manifest and the triangle tally
   * are restored and City Hall stands on a paved square instead. */
  const fillCell = (wx: number, wz: number): void => {
    if (!civic || Math.abs(wx - civic.x) > 1 || Math.abs(wz - civic.z) > 1) {
      fillCellBuilt(wx, wz)
      return
    }
    const saved = { ...fabric }
    const savedTris = tris
    sink = true
    try {
      fillCellBuilt(wx, wz)
    } finally {
      sink = false
    }
    Object.assign(fabric, saved)
    tris = savedTris
    if (Math.hypot(wx - hole.x, wz - hole.z) + half * Math.SQRT2 > radius) return
    const band = bandFor(wx - half, wx + half, wz - half, wz + half)
    if (!band) return
    const pad = tint(new THREE.PlaneGeometry(half * 2, half * 2), CITY.plaza.clone())
    pad.rotateX(-Math.PI / 2)
    pad.translate(wx, baseY + 0.95, wz)
    push(band, pad)
    civicHall(band, wx, wz)
  }
  /** A cell that fillCellBuilt turns into Mont-Royal's park (the same tests,
   * in the same order, bar the triangle cap). */
  const parkCell = (wx: number, wz: number): boolean =>
    !!mount &&
    Math.hypot(wx - hole.x, wz - hole.z) + half * Math.SQRT2 <= radius &&
    bandFor(wx - half, wx + half, wz - half, wz + half) !== null &&
    !(hasRiver && wz + half > riverLoZ - 6 && wz - half < riverHiZ + 6) &&
    Math.hypot(wx - mount.x, wz - mount.z) < mount.r * 1.25 + half
  const fillCellBuilt = (wx: number, wz: number): void => {
    if (tris > capTris) return
    const gx = wx - hole.x
    const gz = wz - hole.z
    if (Math.hypot(gx, gz) + half * Math.SQRT2 > radius) return
    const band = bandFor(wx - half, wx + half, wz - half, wz + half)
    if (!band) return
    if (hasRiver && wz + half > riverLoZ - 6 && wz - half < riverHiZ + 6) return
    if (mount && Math.hypot(wx - mount.x, wz - mount.z) < mount.r * 1.25 + half) {
      // Mont-Royal's park: the cells the mount clears used to show bare desk
      // round its foot (tp3-city-iter4, the beige field beside the mount);
      // they keep a lawn and a few maples off the slopes. Geometry only —
      // returned before the cell's LCG roll, as before.
      // ONE park, not a checkerboard (quality pass "montroyal2": per-cell
      // squares with 3-unit seams and a per-cell tone ran street lines
      // under the mountain's foot, tp5-final-dpr1/city-mont-royal.png):
      // a side shared with another park cell runs on to the shared line
      // (and a hair past it), so the lawn is one piece whose outer edge
      // follows the streets; one tone, the maquette's own lawn tone
      // (mont_royal_assets.py LAWN = CITY.lawn × 0.96).
      const inset = step / 2 - 1.5
      const reach = (dx: number, dz: number): number => (parkCell(wx + dx * step, wz + dz * step) ? step / 2 + 0.25 : inset)
      const x0 = wx - reach(-1, 0)
      const x1 = wx + reach(1, 0)
      const z0 = wz - reach(0, -1)
      // the row on the river: the cell toward it is given up to the water,
      // and the mountain's foot stood on the far quay's bare paving, its
      // lawn skirt spilling onto it (tp6-montroyal2-it1/city-mont-royal.png,
      // a pale halo on the quay; by the seat arithmetic, mz = riverLoZ - 40
      // - r and a 1.18 r skirt, the skirt reaches riverLoZ - 40 + 0.18 r).
      // The park runs on over the quay to a promenade along the bank.
      const riverNext = hasRiver && !parkCell(wx, wz + step) && wz + step + half > riverLoZ - 6 && wz + step - half < riverHiZ + 6
      const z1 = riverNext ? Math.max(wz + inset, riverLoZ - 12) : wz + reach(0, 1)
      const joined = bandFor(x0, x1, z0, z1)
      const mPad = joined ? null : bandFor(wx - inset, wx + inset, wz - inset, wz + inset)
      const r = joined ? { x0, x1, z0, z1 } : mPad ? { x0: wx - inset, x1: wx + inset, z0: wz - inset, z1: wz + inset } : { x0: wx - half, x1: wx + half, z0: wz - half, z1: wz + half }
      const lawn = tint(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), CITY.lawn.clone().multiplyScalar(0.96))
      lawn.rotateX(-Math.PI / 2)
      lawn.translate((r.x0 + r.x1) / 2, baseY + 0.95, (r.z0 + r.z1) / 2)
      push(joined ?? mPad ?? band, lawn)
      // The park's woods (quality pass "montroyal2": with three trees a cell
      // the mountain stood alone on a bare lawn twice its width,
      // tp6-montroyal2-it3/city-mont-royal.png): a jittered lattice of seats
      // over the cell's lawn, taken densely just off the maquette's foot so
      // its woods fray out into the park, thinning to open lawns with a few
      // groves, plus rows of street trees along the park's edge where it
      // meets the city. Site hashes, no LCG draw. Cost, measured by an
      // UNCOMMITTED vitest probe over seeds 1/7/42 and rings 2300-8000 with
      // the GLB registered: the city went from 24.2-26.2k to 30.8-34.5k
      // triangles (backgrounds.test.ts budget 60k), draws unchanged.
      const dir = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ].map(([dx, dz]) => !parkCell(wx + dx * step, wz + dz * step))
      // seats every SEAT units over this cell's own lawn (the river row's
      // run to the promenade included) — per AREA, not per cell: a cell is
      // ~1.6 mount radii across (step is the WORLD radius / 15 in maquette
      // units), so a per-cell lattice left the park bare (the uncommitted
      // probe counted 2-4 park cells a city)
      const SEAT = mount.r * 0.12 // ~15 at the 2-4k-unit rings the gates run
      const nx = Math.max(1, Math.floor((r.x1 - r.x0 - 8) / SEAT))
      const nz = Math.max(1, Math.floor((r.z1 - r.z0 - 8) / SEAT))
      const ox = (r.x0 + r.x1) / 2 - ((nx - 1) * SEAT) / 2
      const oz = (r.z0 + r.z1) / 2 - ((nz - 1) * SEAT) / 2
      for (let gi = 0; gi < nx; gi++) {
        for (let gk = 0; gk < nz; gk++) {
          const sx = ox + gi * SEAT
          const sz = oz + gk * SEAT
          const tx = sx + (site(sx, sz, 12) - 0.5) * SEAT * 0.7
          const tz = sz + (site(sz, sx, 15) - 0.5) * SEAT * 0.7
          // in mount radii; the maquette's farthest lobe stands at 1.10 r
          // and its lawn skirt runs to 1.17 r (mont_royal_assets.py,
          // montroyal3: `foot 71.0-110.0; apron 116.6`), so a seat past
          // 1.12 r is on lawn, never on a wooded slope; the maquette plants
          // its own park trees inside 1.08 r where its foot is nearer
          const d = Math.hypot(tx - mount.x, tz - mount.z) / mount.r
          if (d < 1.12) continue
          const edge = (dir[0] && gi === 0) || (dir[1] && gi === nx - 1) || (dir[2] && gk === 0) || (dir[3] && gk === nz - 1)
          // dense just off the foot, fading out by 1.95 r; groves (a coarse
          // hash per 0.45 r patch) keep some woods out in the lawns; the
          // street-tree rows along the park's edge every other seat
          const fray = 0.85 * (1 - Math.min(1, Math.max(0, (d - 1.4) / 0.55)))
          const patch = mount.r * 0.45
          const grove = site(Math.round(tx / patch), Math.round(tz / patch), 24) < 0.25 ? 0.75 : 0.03
          const p = Math.max(fray, grove, edge && (gi + gk) % 2 === 0 ? 0.9 : 0)
          if (site(tx, tz, 19) >= p) continue
          const cone = site(tz, tx, 21) < 0.3
          tree(band, tx, tz, cone ? 'cone' : 'round', cone ? CITY.leafB : CITY.leafA, site(tx, tz, 18) * 0.8)
        }
      }
      return
    }
    // first two rings of cells around the hole EDGE (not the far radius)
    // get densified (~+40 % block count)
    const edgeDist = Math.hypot(
      Math.max(0, Math.abs(wx - hole.x) - hole.w / 2),
      Math.max(0, Math.abs(wz - hole.z) - hole.h / 2),
    )
    const nearRing = edgeDist < margin + step * 2
    const roll = rnd()
    const plazaP = nearRing ? 0.05 : 0.1
    const parkP = nearRing ? 0.15 : 0.24
    // ground fabric FIRST: every surviving cell lays a flat pad — block
    // cells a concrete plinth, parks a lawn, plazas pale paving — spanning
    // the cell pitch minus a 3-unit reveal, so the desk shows only as
    // hairline panel seams between pads. A pad wider than the checked cell
    // footprint re-runs bandFor and falls back to the cell size when the
    // wider stance would cross a margin line, so the hole invariant holds.
    const padTone = (
      roll < plazaP ? CITY.plaza.clone() : roll < parkP ? CITY.lawn.clone() : CITY.pad.clone()
    ).multiplyScalar(0.96 + rnd() * 0.08)
    const padTry = bandFor(wx - (step / 2 - 1.5), wx + (step / 2 - 1.5), wz - (step / 2 - 1.5), wz + (step / 2 - 1.5))
    const padHalf = padTry ? step / 2 - 1.5 : half
    const pad = tint(new THREE.PlaneGeometry(padHalf * 2, padHalf * 2), padTone)
    pad.rotateX(-Math.PI / 2)
    pad.translate(wx, baseY + 0.95, wz) // proud of the desk — coplanar would shimmer
    push(padTry ?? band, pad)
    if (roll < plazaP) {
      // plaza — no block cluster (keeps the grid from reading as a clone
      // army); a parish church on some (Montréal, "the city of a hundred
      // steeples"), a ring of maples on the rest — by site, no LCG draw
      // 0.7 (was 0.4): city scale left ~1/K² as many cells, so the old
      // odds left 1-8 steeples a city (fixture seeds, measured 2026-10-10)
      if (half > 40 && site(wx, wz, 6) < 0.7) church(band, wx, wz)
      else {
        for (const [sx, sz] of [
          [-1, -1],
          [1, 1],
          [1, -1],
        ]) {
          if (site(wx + sx, wz + sz, 7) < 0.25) continue
          tree(band, wx + sx * half * 0.55, wz + sz * half * 0.55, 'round', CITY.leafA, 0.1)
        }
      }
      return
    }
    if (roll < parkP) {
      // park cell: small tree cluster on its lawn, alternating the greens
      const n = 2 + Math.floor(rnd() * 3)
      for (let i = 0; i < n; i++) {
        const tx = wx + (rnd() - 0.5) * half * 1.2
        const tz = wz + (rnd() - 0.5) * half * 1.2
        tree(band, tx, tz, rnd() < 0.5 ? 'cone' : 'round', i % 2 ? CITY.leafA : CITY.leafB, rnd())
      }
      return
    }
    // built cell: a cluster of blocks — heights rise on a t² ramp toward
    // the rim, and (city scale) the ring facing the board is lifted to
    // PLAZA height so the plaza is framed by blocks taller than the board.
    const t = Math.min(1, Math.hypot(gx, gz) / (radius * 0.75))
    const detail = t < 0.55 // window-strip budget goes where the camera looks
    const pickTone = (): THREE.Color => {
      const c = rnd()
      if (c < 0.24) return CITY.cream
      if (c < 0.4) return CITY.warmWhite
      if (c < 0.56) return CITY.ochre
      if (c < 0.74) return CITY.brick
      if (c < 0.9) return CITY.slate
      return CITY.sage
    }
    // City scale: the far rise (the t² term and the rare towers) is damped
    // to 0.45 so the rim keeps ~1.0-1.3x its K = 1 WORLD height (rim blocks
    // ≤ 147, towers ≤ 275) — K times it would wall the horizon, and the far
    // city must still recede behind the plaza ring
    const pickH = (): number => {
      const h = 10 + rnd() * 12 + t * t * (55 + rnd() * 45) * 0.45
      // rare far-ring towers — never near the board
      return t > 0.5 && rnd() < 0.05 ? h + (60 + rnd() * 70) * 0.45 : h
    }
    /** The plaza lift: the first ring of cells round the hole stands at
     * PLAZA height (plazaH), the second two-thirds of the way there, the
     * rest at their own height. */
    const plazaF = Math.min(1, Math.max(0, (margin + step * 2.5 - edgeDist) / (step * 1.5)))
    const lift = (h: number): number => h + (plazaH(h) - h) * plazaF
    if (half > 40 && (nearRing || t < 0.5)) {
      // Montréal plex row (user ask): 2–3 attached brick/greystone
      // walk-ups sharing side walls under one roofline — flat cornice
      // parapets, per-segment tone variety, shared walls left blank.
      // Every footprint keeps |offset| + size/2 ≤ half so the cell's
      // bandFor verdict still bounds the geometry (hole invariant).
      const alongX2 = rnd() < 0.5
      const rowOff = (rnd() < 0.5 ? -1 : 1) * half * 0.42
      /** One plex row at `off` across the cell: 2-3 segments under one
       * roofline. */
      const plexRow = (at: number): void => {
        const n = 2 + (rnd() < 0.6 ? 1 : 0)
        const rowLen = half * (1.5 + rnd() * 0.35)
        const segW = rowLen / n
        const depth = half * (0.45 + rnd() * 0.15)
        const rowH = lift(rnd() < 0.6 ? 18.5 + rnd() * 3.5 : 12.5 + rnd() * 2.5)
        for (let i = 0; i < n; i++) {
          const off = -rowLen / 2 + segW * (i + 0.5)
          const segH = rowH + (rnd() - 0.5) * 1.6
          const mask: [boolean, boolean, boolean, boolean] = alongX2
            ? [true, true, i === n - 1, i === 0]
            : [i === n - 1, i === 0, true, true]
          walkup(
            band,
            wx + (alongX2 ? off : at),
            wz + (alongX2 ? at : off),
            alongX2 ? segW * 0.94 : depth,
            alongX2 ? depth : segW * 0.94,
            segH,
            plexTone(),
            detail,
            { mask },
          )
        }
      }
      plexRow(rowOff)
      // City scale: a K-times-wider cell with ONE row read as a bar on an
      // empty lot (tp4-cityscale-1/city-wide.png, the plaza ring). A
      // Montréal block is plex rows on BOTH streets with the ruelle (back
      // lane) between — so most plaza-ring cells, and some mid-field ones,
      // get the back row (|0.42| + 0.3 ≤ 1: the hole invariant holds).
      const backRow = rnd() < (plazaF > 0 ? 0.8 : 0.4)
      if (backRow) plexRow(-rowOff)
      // a lone cross-street walk-up keeps the cell from reading as one bar
      else if (rnd() < 0.35) {
        const aw = half * (0.4 + rnd() * 0.18)
        const ax = (rnd() - 0.5) * half * 0.8
        walkup(
          band,
          wx + (alongX2 ? ax : -rowOff),
          wz + (alongX2 ? -rowOff : ax),
          alongX2 ? aw : half * 0.42,
          alongX2 ? half * 0.42 : aw,
          lift(12.5 + rnd() * 4),
          plexTone(),
          detail,
        )
      }
      if (!backRow && nearRing && rnd() < 0.7) {
        // LOW infill annex — a 1-storey shopfront-grade unit at a jittered
        // corner packs the near fabric while its single window row keeps
        // the budget near-flat. |off| + size/2 ≤ 0.75 + 0.25 ≤ 1 keeps the
        // cell's bandFor verdict binding (hole invariant).
        const ox = (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.15)
        const oz = (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.15)
        building(
          band,
          wx + ox * half,
          wz + oz * half,
          (0.3 + rnd() * 0.2) * half,
          (0.3 + rnd() * 0.2) * half,
          9 + rnd() * 6,
          pickTone(),
          detail,
        )
      }
    } else if (half > 40) {
      // four cluster archetypes × mirrored orientation — with per-corner
      // jitter no two neighbours match. Every footprint keeps
      // |offset| + size/2 ≤ half so the cell's bandFor verdict still
      // bounds the geometry (hole invariant).
      const fx = rnd() < 0.5 ? -1 : 1
      const fz = rnd() < 0.5 ? -1 : 1
      const place = (ox: number, oz: number, fw: number, fd: number, hMul = 1): void => {
        building(band, wx + fx * ox * half, wz + fz * oz * half, fw * half, fd * half, pickH() * hMul, pickTone(), detail)
      }
      const layout = rnd()
      if (layout < 0.3) {
        // courtyard quads — per-corner sizes so even the classic varies
        for (const qx of [-1, 1]) {
          for (const qz of [-1, 1]) {
            if (rnd() < 0.15) continue // courtyard gap inside the cluster
            place(qx * 0.5, qz * 0.5, 0.56 + rnd() * 0.3, 0.56 + rnd() * 0.3)
          }
        }
      } else if (layout < 0.55) {
        // twin slabs — two long parallel bars with a street between
        place(0, -0.52, 1.3 + rnd() * 0.4, 0.5 + rnd() * 0.2)
        place(0, 0.5, 1.2 + rnd() * 0.4, 0.48 + rnd() * 0.2)
      } else if (layout < 0.8) {
        // L-block — a bar hugging one edge with a head-quad at its end
        place(0, -0.55, 1.5 + rnd() * 0.3, 0.55 + rnd() * 0.2)
        place(-0.52, 0.28, 0.7 + rnd() * 0.2, 0.9 + rnd() * 0.3)
      } else {
        // tower + low annex — the tall member of the local skyline
        place(0.12, -0.08, 0.95 + rnd() * 0.25, 0.95 + rnd() * 0.25, 1.35)
        place(-0.55, 0.55, 0.55 + rnd() * 0.2, 0.55 + rnd() * 0.2, 0.5)
      }
    } else if (nearRing || t < 0.5) {
      // tight lattice (small boards): a single walk-up carries the
      // Montréal read per cell
      const wwu = half * (0.66 + rnd() * 0.3)
      const dwu = half * (0.66 + rnd() * 0.3)
      walkup(band, wx, wz, wwu, dwu, lift(rnd() < 0.6 ? 18 + rnd() * 3 : 12.5 + rnd() * 2.5), plexTone(), detail)
    } else {
      building(band, wx, wz, half * (0.66 + rnd() * 0.3), half * (0.66 + rnd() * 0.3), pickH(), pickTone(), detail)
    }
  }
  const cols = Math.ceil(radius / step)
  const rowsNS = Math.ceil(radius / step)
  for (let row = 0; row < rowsNS; row++) {
    const wz = hb.maxZ + margin + step / 2 + row * step
    for (let col = -cols; col < cols; col++) fillCell(hole.x + (col + 0.5) * step, wz)
    yield
  }
  for (let row = 0; row < rowsNS; row++) {
    const wz = hb.minZ - margin - step / 2 - row * step
    for (let col = -cols; col < cols; col++) fillCell(hole.x + (col + 0.5) * step, wz)
    yield
  }
  const sideRows = Math.max(1, Math.floor((hole.h + 2 * margin) / step))
  const z0 = hole.z - ((sideRows - 1) / 2) * step
  for (let col = 0; col < cols; col++) {
    const wx = hb.maxX + margin + step / 2 + col * step
    for (let r = 0; r < sideRows; r++) fillCell(wx, z0 + r * step)
    yield
  }
  // City Hall: the first west column, on the row nearest the board's
  // mid-edge — the west flank is the up-screen side the default iso frame
  // shows past the board's top-left edge
  civic = {
    x: hb.minX - margin - step / 2,
    z: z0 + Math.max(0, Math.min(sideRows - 1, Math.round((hole.z - z0) / step))) * step,
  }
  for (let col = 0; col < cols; col++) {
    const wx = hb.minX - margin - step / 2 - col * step
    for (let r = 0; r < sideRows; r++) fillCell(wx, z0 + r * step)
    yield
  }

  const out: CityGeometry['parts'] = []
  /** Which part carries the river (test seam), null without one. */
  let riverIn: string | null = null
  const addMerged = (parts: THREE.BufferGeometry[], tag: string, ungraded?: THREE.BufferGeometry | null): void => {
    if (parts.length === 0) return
    let merged = mergeGeometries(parts)
    for (const p of parts) p.dispose()
    // sun-side value ramp, baked post-merge into every band/bridge/mount
    // vertex tone: ±24% along the sun bearing, reaching full swing by
    // ~0.42·radius (the ×2.4 gain) so the mid-ring the frame actually shows
    // carries the grade, the far rim clamps. A weaker ramp (e.g. ±15%/×1.7)
    // only reaches ~±7% inside the visible band, and the palette noise
    // swallows the grade. A pure function of world position
    // — determinism and the merge partition untouched. The river keeps its
    // own tuned drift and is NOT graded (it never goes through addMerged).
    const gpos = merged.getAttribute('position')
    const gcol = merged.getAttribute('color')
    if (gcol) {
      for (let i = 0; i < gpos.count; i++) {
        const u = ((gpos.getX(i) - hole.x) * sunX + (gpos.getZ(i) - hole.z) * sunZ) / radius
        const f = 1 + 0.24 * Math.max(-1, Math.min(1, u * 2.4))
        gcol.setXYZ(i, gcol.getX(i) * f, gcol.getY(i) * f, gcol.getZ(i) * f)
      }
    }
    // the river joins AFTER the grade (its own tuned drift stays verbatim):
    // it lies wholly south of the hole, so the south band's bbox still
    // clears the hole, and its glossy water texel stands in for the river's
    // old material — one draw fewer (quality pass "city")
    if (ungraded) {
      const both = mergeGeometries([merged, ungraded])
      merged.dispose()
      ungraded.dispose()
      merged = both
      riverIn = tag
    }
    // maquette → world (CITY_SCALE): one uniform scale about the hole's
    // centre at street level, so normals keep their directions, every part
    // stays on baseY and the hole maps onto itself
    merged.applyMatrix4(toWorld)
    // materials are attached by assembleCityBackground (ONE shared matte
    // material for every part)
    out.push({ geometry: merged, tag })
  }
  for (const name of BAND_ORDER) {
    addMerged(bands[name], `city-${name}`, name === 'south' ? riverGeo : null)
    yield
  }
  addMerged(bridgeParts, 'city-bridges')
  addMerged(mountParts, 'city-mount')
  // the test-seam manifests report WORLD positions, like the meshes
  const lifeWorld = {
    people: streetLife.people.map((p) => ({ x: worldX(p.x), z: worldZ(p.z) })),
    vehicles: streetLife.vehicles.map((p) => ({ x: worldX(p.x), z: worldZ(p.z) })),
  }
  return {
    parts: out,
    streetLife: lifeWorld,
    fabric,
    river: riverGeo ? { in: riverIn ?? '', z0: worldZ(riverLoZ), z1: worldZ(riverHiZ) } : null,
    mount: mount ? { x: worldX(mount.x), z: worldZ(mount.z), r: mount.r * K, source: mountGlb ? 'glb' : 'procedural' } : null,
  }
}

/** The Blender maquette's nominal mountain radius (mont_royal_assets.py `R`):
 * the engine maps it onto the mount's radius. The park apron reaches
 * 1.17 R (mont_royal_assets.py prints `apron 116.6`, montroyal3) — inside the 1.25 r
 * the city keeps clear round the mount. */
export const MONT_ROYAL_GLB_R = 100
/** Albedo gain on the maquette's LIT corners (UV code u ≈ 0.9: the cross).
 * The city's program has no emissive feature, and keying one would link a
 * new program after the first frame (backgrounds.test.ts "wears the facade
 * atlas in the DESK program"), so the steel cross reads lit by a brighter
 * vertex tone instead, aimed at the post stack's bloom (lit/post.ts,
 * threshold 0.85 luminance) — no light, no program. Quality pass
 * "montroyal2" (the cross "is not lit"): #F4F1E6 × 1.45 peaked at
 * (255, 241, 212) on the close-up (tp5-final-dpr1/city-mont-royal.png); the
 * warm #FFF1D4 × 2.2 peaks at (255, 255, 236), R and G clipped, with its
 * lattice still drawn (tp6-montroyal2-it7/city-mont-royal.png). Measured as
 * output pixels only; whether the bloom pass itself fires on it is not. */
export const MONT_ROYAL_LIT_GAIN = 2.2
/** The maquette's downtown face (escarpment, belvedere, chalet front; glTF
 * +Z) is yawed toward the iso camera's azimuth (40°, the bearing the
 * landmark quadrant is laid out on). */
export const MONT_ROYAL_YAW = (40 * Math.PI) / 180

/** The Blender Mont-Royal as a CITY part, in maquette units: scaled from its
 * nominal radius onto `at.r`, yawed, seated at `at` on the street. Its UV is
 * a per-corner code (mont_royal_assets.py): u < 1/3 plain → the atlas's
 * white texel, u < 2/3 water → the glossy water texel (Beaver Lake), else
 * lit → white texel with MONT_ROYAL_LIT_GAIN on the vertex tone. Vertex
 * colours are linear, like every city tone. */
export function montRoyalGeometry(
  asset: DecorAsset,
  at: { x: number; z: number; r: number },
  baseY: number,
): THREE.BufferGeometry {
  const src = asset.geometry
  const pos = src.getAttribute('position')
  const nrm = src.getAttribute('normal')
  const uv = src.getAttribute('uv')
  const col = src.getAttribute('color')
  const n = pos.count
  const s = at.r / MONT_ROYAL_GLB_R
  const cy = Math.cos(MONT_ROYAL_YAW)
  const sy = Math.sin(MONT_ROYAL_YAW)
  // the park lawn (1.6 R/100 over the street) must stay proud of the city's
  // lawn pads (0.95 maquette, fillCellBuilt's mount branch) or the two fight;
  // on a small ring the raised part is lifted, the curb's foot stays down
  const lift = Math.max(0, 1.25 - 1.6 * s)
  const P = new Float32Array(n * 3)
  const N = new Float32Array(n * 3)
  const U = new Float32Array(n * 2)
  const C = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i) * s
    const yRaw = pos.getY(i)
    const z = pos.getZ(i) * s
    P[i * 3] = at.x + x * cy + z * sy
    P[i * 3 + 1] = baseY + yRaw * s + (yRaw > 0.05 ? lift : 0)
    P[i * 3 + 2] = at.z - x * sy + z * cy
    if (nrm) {
      const nx = nrm.getX(i)
      const nz = nrm.getZ(i)
      N[i * 3] = nx * cy + nz * sy
      N[i * 3 + 1] = nrm.getY(i)
      N[i * 3 + 2] = -nx * sy + nz * cy
    }
    const code = uv ? uv.getX(i) : 0
    const at2 = code > 2 / 3 || code < 1 / 3 ? FACADE_WHITE_UV : FACADE_WATER_UV
    U[i * 2] = at2[0]
    U[i * 2 + 1] = at2[1]
    const gain = code > 2 / 3 ? MONT_ROYAL_LIT_GAIN : 1
    C[i * 3] = (col ? col.getX(i) : 1) * gain
    C[i * 3 + 1] = (col ? col.getY(i) : 1) * gain
    C[i * 3 + 2] = (col ? col.getZ(i) : 1) * gain
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(P, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2))
  g.setAttribute('color', new THREE.BufferAttribute(C, 3))
  if (src.index) g.setIndex(Array.from(src.index.array as ArrayLike<number>))
  if (!nrm) g.computeVertexNormals()
  return g
}

/** Height of the CITY's civic podium: the board's slab floats this far over
 * the desk (Scene3D: desk at −floorD − 16, slab bottom at −floorD), so the
 * podium fills exactly that gap — the board stands ON it, and the city desk
 * props stand on its top. */
export const CITY_PODIUM_H = 16

export interface CityPodiumOpts {
  /** The board slab's footprint (floor-local, x/z + size). */
  slab: { x: number; z: number; w: number; h: number }
  /** How far the podium reaches past the slab on every side, its base
   * course included (≤ the city hole's apron, so it never meets the city's
   * fabric); only the flights of steps reach farther. */
  reach: number
  /** Desk plane elevation (the street level). */
  baseY: number
  /** Sides that get a flight of steps down to the street ('+x' / '+z' are
   * the default iso camera's sides). Steps reach PODIUM_STAIR_REACH outside. */
  stairs?: Array<'+x' | '-x' | '+z' | '-z'>
}

/** Plan depth of one podium step. City scale: eight risers of 2 on a 4-unit
 * tread (was four of 4 on 5) — against the 8-unit CITY_STOREY and ~8-unit
 * walkers a 4-unit riser was half a storey, a giant's stair. */
export const PODIUM_STEP_RUN = 4
/** Risers in a flight of podium steps. */
export const PODIUM_STEPS = 8
/** How far a flight reaches past the podium's wall face (≈ past the city
 * hole's edge): inside CITY_STREET_MARGIN, where no block is seated. */
export const PODIUM_STAIR_REACH = PODIUM_STEPS * PODIUM_STEP_RUN

/** The CIVIC PODIUM the board stands on in the city world (quality pass
 * "city": "the board sits on bare beige ground with no plinth or transition
 * … floats like a giant crate"). A Montréal place in granite: setts on the
 * top (the facade atlas's paver strip, laid ACROSS each edge strip, so the
 * stones run to the coping), ashlar walls, a proud light coping and a dark
 * base course, and flights of steps down to the street on the camera's
 * sides. One merged, flat-shaded geometry in the city material's layout
 * (position, normal, uv, colour) — one draw, no new program. */
export function buildCityPodium(opts: CityPodiumOpts): THREE.BufferGeometry {
  const { slab, reach, baseY } = opts
  const H = CITY_PODIUM_H
  const top = baseY + H
  // the wall face; the base course and the coping stand 1.5 / 1.2 past it,
  // so `reach` bounds the whole podium (the stairs apart)
  const face = reach - 1.5
  const o = { x0: slab.x - face, x1: slab.x + slab.w + face, z0: slab.z - face, z1: slab.z + slab.h + face }
  // the paving runs this far UNDER the slab, covering the ground the slab's
  // rounded corners leave open
  const under = 34
  const ins = { x0: slab.x + under, x1: slab.x + slab.w - under, z0: slab.z + under, z1: slab.z + slab.h - under }
  const parts: THREE.BufferGeometry[] = []
  /** Texels per world unit on the top (12-unit setts) and on the walls
   * (4-unit ashlar courses). */
  const TOP_K = 1 / 1.5
  const WALL_K = 2
  const quad = (
    p: Array<[number, number, number]>,
    uv: Array<[number, number]>,
    tone: THREE.Color,
  ): void => {
    const g = faceted([p])
    const a = g.getAttribute('uv') as THREE.BufferAttribute
    uv.forEach(([u, v], i) => a.setXY(i, u, v))
    const c = new Float32Array(p.length * 3)
    for (let i = 0; i < p.length; i++) {
      c[i * 3] = tone.r
      c[i * 3 + 1] = tone.g
      c[i * 3 + 2] = tone.b
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3))
    parts.push(g)
  }
  /** Paver UV: `across` world units in from the edge → u (32 texels of
   * setts, then the plain strip, which only the slab ever covers);
   * `along` → v (repeats). */
  const pu = (across: number): number => PAVE_U0 + (across * TOP_K) / 512
  const pv = (along: number): number => (along * TOP_K) / 512
  const pave = CITY.granite
  // top: four edge strips (north/south full width, east/west between)
  quad(
    [[o.x0, top, o.z1], [o.x1, top, o.z1], [o.x1, top, ins.z1], [o.x0, top, ins.z1]],
    [[pu(0), pv(o.x0)], [pu(0), pv(o.x1)], [pu(o.z1 - ins.z1), pv(o.x1)], [pu(o.z1 - ins.z1), pv(o.x0)]],
    pave,
  )
  quad(
    [[o.x0, top, ins.z0], [o.x1, top, ins.z0], [o.x1, top, o.z0], [o.x0, top, o.z0]],
    [[pu(ins.z0 - o.z0), pv(o.x0)], [pu(ins.z0 - o.z0), pv(o.x1)], [pu(0), pv(o.x1)], [pu(0), pv(o.x0)]],
    pave,
  )
  quad(
    [[ins.x1, top, ins.z1], [o.x1, top, ins.z1], [o.x1, top, ins.z0], [ins.x1, top, ins.z0]],
    [[pu(o.x1 - ins.x1), pv(ins.z1)], [pu(0), pv(ins.z1)], [pu(0), pv(ins.z0)], [pu(o.x1 - ins.x1), pv(ins.z0)]],
    pave,
  )
  quad(
    [[o.x0, top, ins.z1], [ins.x0, top, ins.z1], [ins.x0, top, ins.z0], [o.x0, top, ins.z0]],
    [[pu(0), pv(ins.z1)], [pu(ins.x0 - o.x0), pv(ins.z1)], [pu(ins.x0 - o.x0), pv(ins.z0)], [pu(0), pv(ins.z0)]],
    pave,
  )
  // walls: ashlar from the base course to the coping
  const wallLo = baseY + 3
  const wallHi = top - 2
  const wu = (y: number): number => PAVE_U0 + ((y - wallLo) * WALL_K) / 512
  const wv = (s: number): number => (s * WALL_K) / 512
  const wallTone = CITY.granite.clone().multiplyScalar(0.94)
  const wall = (ax: number, az: number, bx: number, bz: number): void => {
    const len = Math.hypot(bx - ax, bz - az)
    quad(
      [[ax, wallLo, az], [bx, wallLo, bz], [bx, wallHi, bz], [ax, wallHi, az]],
      [[wu(wallLo), wv(0)], [wu(wallLo), wv(len)], [wu(wallHi), wv(len)], [wu(wallHi), wv(0)]],
      wallTone,
    )
  }
  // counter-clockwise seen from outside
  wall(o.x0, o.z1, o.x1, o.z1)
  wall(o.x1, o.z0, o.x0, o.z0)
  wall(o.x1, o.z1, o.x1, o.z0)
  wall(o.x0, o.z0, o.x0, o.z1)
  const box = (cx: number, cy: number, cz: number, w: number, h: number, d: number, tone: THREE.Color): void => {
    const g = tint(new THREE.BoxGeometry(w, h, d), tone)
    g.translate(cx, cy, cz)
    parts.push(g)
  }
  // coping: a light band, proud of the wall by 1.2 and of the paving by 0.15
  const cw = 4
  const cx0 = o.x0 - 1.2
  const cx1 = o.x1 + 1.2
  const cz0 = o.z0 - 1.2
  const cz1 = o.z1 + 1.2
  const cy = top - 1 + 0.075
  box((cx0 + cx1) / 2, cy, cz1 - cw / 2, cx1 - cx0, 2.15, cw, CITY.graniteCap)
  box((cx0 + cx1) / 2, cy, cz0 + cw / 2, cx1 - cx0, 2.15, cw, CITY.graniteCap)
  box(cx1 - cw / 2, cy, (cz0 + cz1) / 2, cw, 2.15, cz1 - cz0 - 2 * cw, CITY.graniteCap)
  box(cx0 + cw / 2, cy, (cz0 + cz1) / 2, cw, 2.15, cz1 - cz0 - 2 * cw, CITY.graniteCap)
  // base course: a darker plinth band at the foot, 1.5 proud
  const bx0 = o.x0 - 1.5
  const bx1 = o.x1 + 1.5
  const bz0 = o.z0 - 1.5
  const bz1 = o.z1 + 1.5
  const by = baseY + 1.5
  box((bx0 + bx1) / 2, by, bz1 - 2, bx1 - bx0, 3, 4, CITY.graniteBase)
  box((bx0 + bx1) / 2, by, bz0 + 2, bx1 - bx0, 3, 4, CITY.graniteBase)
  box(bx1 - 2, by, (bz0 + bz1) / 2, 4, 3, bz1 - bz0 - 8, CITY.graniteBase)
  box(bx0 + 2, by, (bz0 + bz1) / 2, 4, 3, bz1 - bz0 - 8, CITY.graniteBase)
  // flights of steps: PODIUM_STEPS risers of H / PODIUM_STEPS, each tread
  // PODIUM_STEP_RUN deep, a third of the side wide, centred
  const N = PODIUM_STEPS
  for (const side of opts.stairs ?? []) {
    const alongX = side === '+z' || side === '-z'
    const sgn = side[0] === '+' ? 1 : -1
    const span = (alongX ? o.x1 - o.x0 : o.z1 - o.z0) / 3
    const mid = alongX ? (o.x0 + o.x1) / 2 : (o.z0 + o.z1) / 2
    const edge = alongX ? (sgn > 0 ? o.z1 : o.z0) : sgn > 0 ? o.x1 : o.x0
    for (let k = 0; k < N; k++) {
      const rise = (H / N) * (k + 1)
      const run = PODIUM_STEP_RUN * (N - k)
      const c = edge + (sgn * run) / 2
      const tone = CITY.graniteCap.clone().multiplyScalar(0.97 - k * (0.06 / N))
      if (alongX) box(mid, baseY + rise / 2, c, span, rise, run, tone)
      else box(c, baseY + rise / 2, mid, run, rise, span, tone)
    }
  }
  const merged = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  return merged
}

export interface StudioBackgroundOpts {
  /** Scale reference — the engine passes max(5000, 5·board max dim). The
   * sweep itself stands at radius/2.5 so both its arc ends and its top edge
   * stay OUTSIDE the default iso framing at every board size. */
  radius: number
  baseY: number
  makeMat: MakeMat
}

/** The cyclorama's paper grade (see buildStudioBackground's note on why it
 * runs radially, then up the wall): `rho` is the distance from the lathe
 * axis, `y` the height over the floor, `pieEnd` the cove foot's radius. */
function studioPaperTone(rho: number, y: number, pieEnd: number, coveR: number, out: THREE.Color): THREE.Color {
  const radial = Math.max(0, rho / pieEnd - 0.55) / 0.45 // 0 to mid-pie, 1 at the cove foot
  const rise = Math.min(1, Math.max(0, y) / (coveR * 1.5))
  const u = Math.min(1, radial * 0.55 + rise * 0.45)
  const s = u * u * (3 - 2 * u)
  if (s < 0.25) out.lerpColors(STUDIO_FLOOR_TONE, STUDIO_WALL_TONE, s / 0.25)
  else if (s < 0.6) out.lerpColors(STUDIO_WALL_TONE, STUDIO_MID_TONE, (s - 0.25) / 0.35)
  else out.lerpColors(STUDIO_MID_TONE, STUDIO_TOP_TONE, (s - 0.6) / 0.4)
  return out
}
const STUDIO_FLOOR_TONE = new THREE.Color('#DCD6C6') // neutral paper — still a clear step off the board
const STUDIO_WALL_TONE = new THREE.Color('#C4BDAA') // cove zone visibly under the floor = the horizon step
const STUDIO_MID_TONE = new THREE.Color('#A19B8D')
const STUDIO_TOP_TONE = new THREE.Color('#767C8A') // cool grey up high = the horizon-curve read

/** How far the studio's paper floor reaches, in sweep radii — past the
 * walnut desk it replaces (deskSize / 2 = 1.5 sweep radii at every board
 * size), so the floor's rim is no nearer the board than the desk's was. */
export const STUDIO_FLOOR_REACH = 1.6

/** The studio's seamless paper FLOOR: one flat disc over the whole world
 * (the cyclorama only walls 270°; the camera's own quadrant is floor), its
 * rings dense where the grade moves. Normals +Y, triangles counter-clockwise
 * seen from above (front faces up). The colour is the sweep's own grade
 * with the radius clamped at the cove foot: under the wall it is hidden,
 * and in the open quadrant the floor keeps the cove foot's tone out to the
 * rim, so floor and cove meet with no step. */
function studioFloorGeometry(pieEnd: number, coveR: number, reach: number): THREE.BufferGeometry {
  // a ring every 5 % of the cove radius across the grade (0.55 → 1): the
  // vertex colours interpolate linearly between rings, so sparse rings
  // would facet the light pool into visible bands
  const fractions = [0, 0.25, 0.45, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1]
  const radii = fractions.map((f) => f * pieEnd)
  // beyond the cove foot the tone is constant: two rings carry it out
  radii.push((pieEnd + reach) / 2, reach)
  const S = 128
  const pos = new Float32Array(radii.length * (S + 1) * 3)
  const nor = new Float32Array(radii.length * (S + 1) * 3)
  const col = new Float32Array(radii.length * (S + 1) * 3)
  const c = new THREE.Color()
  let v = 0
  for (const rho of radii) {
    studioPaperTone(Math.min(rho, pieEnd), 0, pieEnd, coveR, c)
    for (let s = 0; s <= S; s++) {
      const a = (s / S) * Math.PI * 2
      pos[v * 3] = Math.cos(a) * rho
      pos[v * 3 + 2] = Math.sin(a) * rho
      nor[v * 3 + 1] = 1
      col[v * 3] = c.r
      col[v * 3 + 1] = c.g
      col[v * 3 + 2] = c.b
      v++
    }
  }
  const index: number[] = []
  for (let ri = 0; ri < radii.length - 1; ri++) {
    for (let s = 0; s < S; s++) {
      const a = ri * (S + 1) + s
      const b = a + 1
      const cc = a + S + 1
      const d = cc + 1
      if (radii[ri] > 0) index.push(a, b, cc) // the centre ring is one point
      index.push(b, d, cc)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setIndex(index)
  return geo
}

/** Studio cyclorama — a real infinity-cove sweep: seamless paper floor →
 * quarter-round cove → tall wall, TWO draws. An infinity cove only
 * sells while its edges are never seen (style critic sev6: the old radius/6
 * band showed its top edge and BOTH arc ends inside the frame and read as a
 * band-shell prop standing on the desk). The wall rises 2.4·r (1.25·r left
 * the far floor visible over the top edge at the wide framing). The 270°
 * arc keeps both arc ends out of the crop sideways while the +X/+Z camera
 * quadrant stays open — small boards put the camera INSIDE the cove, which
 * reads even better.
 *
 * THE STUDIO HAS NO DESK (user 2026-10-12: "l'arrière plan studio a un
 * problème avec la texture qui reste avec du bois"). The engine used to lay
 * the walnut desk under every lit world and the sweep only covered it with
 * a paper pie inside its 270° arc — so the camera's own open quadrant, the
 * whole foreground of studio-wide.png, was walnut boards. The floor is now
 * the sweep's paper over the WHOLE world (studioFloorGeometry: a flat disc
 * out to STUDIO_FLOOR_REACH·r, the same grade, the cove foot's tone past
 * it), at baseY itself — the level the desk props and the board's ground
 * shadow are placed for. It is the one background mesh that RECEIVES
 * shadows: it is the desk of this world, and the desk received the key
 * light's (props', board's) shadows. It recedes by a polygon offset, so
 * the cove rising from its rim never z-fights it. */
export function buildStudioBackground(opts: StudioBackgroundOpts): BackgroundBuild {
  const { radius, baseY, makeMat } = opts
  const r = radius / 2.5
  const coveR = r * 0.18 // lazy quarter-round — a tight cove reads as a cut
  const height = r * 2.4
  // arc centered past −Z by the iso preset's 40° azimuth (the default
  // camera's up-screen direction); ±135° of span walls the whole frame
  // while the +X/+Z quadrant the camera rides in stays open, and the far
  // end skims the board's east flank low under the slab lip (deskY sits
  // 16 under the slab bottom, so the sweep emerges well past the board)
  const arcCenter = Math.PI + (40 * Math.PI) / 180
  const arcSpan = Math.PI * 1.5
  // the sweep starts at the cove foot: the floor disc below is the floor
  const profile: THREE.Vector2[] = []
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2)
    profile.push(new THREE.Vector2(r - coveR + coveR * Math.sin(a), coveR - coveR * Math.cos(a)))
  }
  // dense wall rows — 4 sparse rows lerped the shading in visible arcs
  for (const f of [0.08, 0.18, 0.3, 0.44, 0.6, 0.79, 1]) {
    profile.push(new THREE.Vector2(r, coveR + (height - coveR) * f))
  }
  const geo = new THREE.LatheGeometry(profile, 96, arcCenter - arcSpan / 2, arcSpan)
  const pos = geo.getAttribute('position')
  const colors = new Float32Array(pos.count * 3)
  const c = new THREE.Color()
  // The grade runs along the PROFILE PATH — radially across the pie, then
  // up the cove/wall — NOT by height alone. Why: the iso camera sits at a
  // steep ~55° elevation, so nearly everything of the sweep the frame can
  // see is the FLAT pie at grazing incidence; the cove and wall compress
  // into the topmost rows. A height-anchored ramp therefore paints the
  // whole visible band in the flat floor stop and the backdrop reads as a
  // featureless beige void. Radial falloff = the classic photo-cyc light
  // pool: bright around the subject, darkening toward the cove, coolest up
  // the wall — and it puts a real horizon curve inside the frame at every
  // framing. One smoothstep keeps it kink-free. The stops sit well below
  // white: the studio key + IBL run the sweep hot, and near-white stops
  // clip to one flat field.
  const pieEnd = r - coveR
  for (let i = 0; i < pos.count; i++) {
    studioPaperTone(Math.hypot(pos.getX(i), pos.getZ(i)), pos.getY(i), pieEnd, coveR, c)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.translate(0, baseY, 0)
  // ambient IBL washed the baked grade toward one flat field (AAA round 4
  // sev4) — the env nudge (with the darker stops above) lets the vertex
  // gradient own the value range instead of clipping at the ACES shoulder.
  // Floor and sweep share every knob, so the paper shades alike across the
  // cove foot (the sweep alone is two-sided: outside on far orbits).
  const paper = (): THREE.Material => {
    const m = makeMat('decor', '#FFFFFF', { vertexColors: true, roughness: 0.95 })
    if (m instanceof THREE.MeshStandardMaterial) m.envMapIntensity = 0.7
    return m
  }
  const mat = paper()
  mat.side = THREE.DoubleSide
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.userData.bgPart = 'studio-sweep'

  const floorGeo = studioFloorGeometry(pieEnd, coveR, r * STUDIO_FLOOR_REACH)
  floorGeo.translate(0, baseY, 0)
  const floorMat = paper()
  floorMat.polygonOffset = true
  floorMat.polygonOffsetFactor = 1
  floorMat.polygonOffsetUnits = 4
  const floor = new THREE.Mesh(floorGeo, floorMat)
  floor.castShadow = false
  floor.receiveShadow = true
  floor.renderOrder = -12 // with the desk it replaces: under the board's SDF shadow (-11)
  floor.userData.bgPart = 'studio-floor'

  const group = new THREE.Group()
  group.add(floor, mesh)
  return { group, ...statsOf(group) }
}

export interface DeskLampOpts {
  /** Base-disc position ON the desk plane (world). */
  position: [number, number, number]
  /** Where the shade and the spot spec aim (world) — the spot of desk the
   * lamp lights, not the board (see the spot spec below). */
  boardCenter: [number, number, number]
  /** Uniform group scale (default 1 ≈ 250 units tall). The spot spec rides
   * the SAME factor so the pool still pours from inside the shade. */
  scale?: number
  makeMat: MakeMat
}

/** A cylinder of radius `r` from `a` to `b` (indexed, like every part). */
function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, segs = 12): THREE.BufferGeometry {
  const d = b.clone().sub(a)
  const g = new THREE.CylinderGeometry(r, r, d.length(), segs, 1, false)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()))
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return g
}

/** A hinge knuckle at `c`: a short drum across the lamp's plane (local X). */
function knuckle(c: THREE.Vector3, r: number, len: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, 14, 1, false)
  g.rotateZ(Math.PI / 2)
  g.translate(c.x, c.y, c.z)
  return g
}

// brushed-brass tones, baked per part into the one vertex-coloured body
const LAMP_BASE = new THREE.Color('#7E5F30') // the weighted foot: darker, aged
const LAMP_BRASS = new THREE.Color('#B48C4E') // stem, arm, the shade's outside
const LAMP_POLISH = new THREE.Color('#D9B877') // the handled parts: rolled rim, knuckles

/** ref1's brass dome desk lamp (~250 units tall at scale 1). ≤3 draws.
 * Returns the SpotLight SPEC only; the engine instantiates the light.
 *
 * Loop 4 r5 (workbench-wide.png: "a glossy gold Christmas bauble"): the
 * dome was a SPHERE cap at metalness 0.9 / roughness 0.35 — a mirror ball
 * whose one blown highlight was all that read, on an S-tube. It is now a
 * banker's dome lamp: a weighted stepped round foot, a straight stem, a
 * hinge knuckle, a straight arm and a yoke knuckle (the jointed read), and
 * a LATHED dome — a shallow crown flaring to a skirt — finished by a
 * thick ROLLED rim, with the lit inner shell visible under it. Brushed
 * brass: roughness 0.42 (a soft sheen, not a mirror), metalness 0.85, and
 * three baked tones (aged foot, brass, polished rim / knuckles). Still 2
 * draws and the same spot spec (no light-count change — Scene3D's program
 * cache keys on it). */
/** Plan radius of the desk lamp's weighted foot at scale 1 (the lathe's
 * widest ring below) — decor placement keeps every desk prop off it. */
export const DESK_LAMP_FOOT_R = 58
/** Plan distance (scale 1) from the foot's axis to the shade's centre, along
 * the aim bearing, and the shade's plan radius (dome skirt + rolled rim):
 * the dome hangs over the desk there, so decor placement keeps props from
 * standing under it (a pencil cup poked up INTO the dome, lamp pass probe). */
export const DESK_LAMP_SHADE_REACH = 162
export const DESK_LAMP_SHADE_R = 87
/** Height of the shade's centre over the foot at scale 1. */
export const DESK_LAMP_SHADE_Y = 165

/** Irradiance the lamp puts on its aim point (three units; the studio sun
 * gives ~1.3 on a horizontal) — a warm pool, never a clip. */
export const LAMP_POOL_E = 3
/** Cone half-angle (rad). With penumbra 1 three's cone factor is a
 * smoothstep from cos(angle) to 1, so it fades from the axis: half at
 * 0.59 rad off-axis, 0 at 0.85 — no edge anywhere. */
export const LAMP_CONE = 0.85
/** Range cut-off in throws (lamp → aim point): beyond it the light is 0. */
export const LAMP_RANGE_THROWS = 2.6

export function buildDeskLamp(opts: DeskLampOpts): BackgroundBuild {
  const { position, boardCenter, makeMat } = opts
  const scale = opts.scale ?? 1
  const [px, py, pz] = position
  const yaw = Math.atan2(boardCenter[0] - px, boardCenter[2] - pz) // local +Z faces the aim
  // in the group's LOCAL (unscaled) units, like shadeC below: the world offset
  // unscaled — at scale 0.5 the dome otherwise aimed at a point twice as near
  // as the light's target (shade and pool disagreed)
  const localBoard = new THREE.Vector3(boardCenter[0] - px, boardCenter[1] - py, boardCenter[2] - pz)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw)
    .divideScalar(scale)

  const brass: THREE.BufferGeometry[] = []
  // the weighted foot: a low stepped disc with a bevelled edge and a boss
  const foot = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(56, 0),
      new THREE.Vector2(DESK_LAMP_FOOT_R, 2),
      new THREE.Vector2(DESK_LAMP_FOOT_R, 9),
      new THREE.Vector2(54, 13),
      new THREE.Vector2(44, 15),
      new THREE.Vector2(40, 18),
      new THREE.Vector2(22, 20),
      new THREE.Vector2(16, 24),
      new THREE.Vector2(15, 30),
      new THREE.Vector2(0, 30),
    ],
    32,
  )
  brass.push(tint(foot, LAMP_BASE))

  // the pose keeps round 4's framing (AAA round 4 sev6: a tall mast hung the
  // dome out of the default crop): the shade sits at the same (0, 165, 162),
  // hung low over the desk from an elbow under the old 240 crest.
  const shadeC = new THREE.Vector3(0, DESK_LAMP_SHADE_Y, DESK_LAMP_SHADE_REACH)
  const aim = localBoard.clone().sub(shadeC).normalize()
  // dome opening faces −Y at construction; tilt it onto the aim line
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), aim)
  const orient = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    g.applyQuaternion(q)
    g.translate(shadeC.x, shadeC.y, shadeC.z)
    return g
  }
  // the dome profile (r, y), opening at y = 0: a rounded crown flaring into
  // a skirt — a dome shade, not a ball (and, at 58 deep with a flat crown,
  // not a serving cloche either: the first r5 cut read as one in the
  // workbench-wide crop)
  const shadeR = 80
  const domeH = 68
  const dome = [
    [0, domeH],
    [14, domeH - 1.5],
    [28, domeH - 6],
    [40, domeH - 13],
    [50, domeH - 22],
    [58, 35],
    [64, 24],
    [69, 13],
    [74, 5],
    [shadeR, 0],
  ].map(([r, y]) => new THREE.Vector2(r, y))
  // lathed rim → crown (y rising), so the faces wind OUTWARD like the foot's
  brass.push(tint(orient(new THREE.LatheGeometry([...dome].reverse(), 40)), LAMP_BRASS))
  // the rolled rim: a fat bead round the opening
  const rim = new THREE.TorusGeometry(shadeR + 1, 5.5, 10, 40)
  rim.rotateX(Math.PI / 2)
  brass.push(tint(orient(rim), LAMP_POLISH))

  // the yoke on the crown, its knuckle, the arm down to the elbow knuckle,
  // and the stem down into the foot
  const crown = new THREE.Vector3(0, domeH, 0).applyQuaternion(q).add(shadeC)
  const yoke = crown.clone().addScaledVector(aim, -14)
  const elbow = new THREE.Vector3(0, 150, -4)
  const stemFoot = new THREE.Vector3(0, 26, 0)
  brass.push(tint(strut(crown.clone().addScaledVector(aim, 2), yoke, 7), LAMP_BRASS))
  brass.push(tint(knuckle(yoke, 9, 22), LAMP_POLISH))
  brass.push(tint(strut(yoke, elbow, 6), LAMP_BRASS))
  brass.push(tint(knuckle(elbow, 10, 24), LAMP_POLISH))
  brass.push(tint(strut(stemFoot, elbow, 7), LAMP_BRASS))
  brass.push(tint(knuckle(stemFoot.clone().setY(30), 9, 20), LAMP_POLISH))

  const group = new THREE.Group()
  group.rotation.y = yaw
  group.position.set(px, py, pz)
  group.scale.setScalar(scale)

  const brassGeo = mergeGeometries(brass)
  for (const g of brass) g.dispose()
  const body = new THREE.Mesh(
    brassGeo,
    makeMat('decor', '#FFFFFF', { vertexColors: true, metalness: 0.85, roughness: 0.42 }),
  )
  // the lamp is a HERO prop: unlike the rest of the background it may cast
  body.castShadow = true
  body.receiveShadow = false
  // the dome is ONE open lathe sheet: three's default shadow side for a
  // FrontSide material is the back face, so sun rays that crossed the dome's
  // top and left through its opening hit no back face and cast nothing —
  // the lamp threw a hollow ring-and-stick outline on the desk (lamp pass
  // probe, 2026-10-10). Both faces cast; only the cull state of the shared
  // depth program changes, no new program.
  body.material.shadowSide = THREE.DoubleSide
  body.userData.bgPart = 'lamp-brass'
  group.add(body)

  // the lit inside: the dome profile pulled ~3 in, so it lines the shell
  // and shows under the rolled rim
  const innerProfile = dome.map((p) => new THREE.Vector2(Math.max(0, p.x - 3), p.y - 2.5))
  const inner = orient(new THREE.LatheGeometry(innerProfile, 32))
  // 1.2, not 2.2: at 2.2 the inside of the dome fed the bloom pass a halo
  // that joined the spot's pool into one hot smear (view3d quality loop 4,
  // workbench-wide.png); the shell still reads lit, and still blooms a little
  const innerMat = makeMat('decorEmissive', '#FFE9C4', {
    emissive: '#FFD9A0',
    emissiveIntensity: 1.2,
    roughness: 0.6,
  })
  // both faces: the lathe's winding is not the camera's business — the
  // outside of this shell is hidden inside the brass dome anyway
  innerMat.side = THREE.DoubleSide
  const glow = new THREE.Mesh(inner, innerMat)
  glow.castShadow = false
  glow.receiveShadow = false
  glow.userData.bgPart = 'lamp-glow'
  group.add(glow)

  // spot spec: a warm pool poured from just inside the shade opening —
  // scaled with the group so the light origin stays inside the shade
  const opening = shadeC.clone().addScaledVector(aim, 30).multiplyScalar(scale)
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const lightAt: [number, number, number] = [
    px + opening.x * cos + opening.z * sin,
    py + opening.y,
    pz - opening.x * sin + opening.z * cos,
  ]
  // A real desk lamp, not a stage spot (lamp pass 2026-10-10, critic twice:
  // "a circular spotlight pool on the cards", "a bright warm hot spot just
  // right of Event bus"). The old spec was decay 0 — no falloff at all — so
  // a cone poured from 39 units over the board reached every surface inside
  // it at full strength, across half the slab: switching it off changed
  // 11 533 px of the labels close-up, and the board's hottest cell beside
  // Event bus read +8.5 % over the board median against +3.1 % without it
  // (.probes/lamp). Now: inverse-square decay, an intensity set by the
  // irradiance wanted ON the target (LAMP_POOL_E — a warm pool on the dark
  // desk wood, a little over the sun's ~1.3 on a horizontal), a cone whose penumbra runs
  // edge to axis (no rim anywhere) and a hard range cut-off a few throws out,
  // so the light is exactly 0 long before the nearest card.
  const throwLen = Math.hypot(boardCenter[0] - lightAt[0], boardCenter[1] - lightAt[1], boardCenter[2] - lightAt[2])
  const lamp: BackgroundLampSpec = {
    position: lightAt,
    target: [boardCenter[0], boardCenter[1], boardCenter[2]],
    color: '#FFD9A0',
    intensity: LAMP_POOL_E * throwLen * throwLen,
    angle: LAMP_CONE,
    penumbra: 1,
    decay: 2,
    distance: throwLen * LAMP_RANGE_THROWS,
  }
  return { group, ...statsOf(group), lamp }
}

/** Dispose a background build: every geometry + every (deduped) material. */
export function disposeBackground(b: BackgroundBuild): void {
  const mats = new Set<THREE.Material>()
  b.group.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry.dispose()
    const m = mesh.material
    for (const mat of Array.isArray(m) ? m : [m]) mats.add(mat)
  })
  for (const m of mats) m.dispose()
}
