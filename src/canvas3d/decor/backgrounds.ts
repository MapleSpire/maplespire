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

/**
 * BACKGROUND world library — what exists beyond the desk. Three pure
 * builders (no Scene3D imports; materials arrive through a `MakeMat`
 * callback so the engine keeps material-family ownership):
 *
 * - `buildCityBackground` — ref3's low-poly city as a RING around the desk
 *   zone: margin-anchored block lattices with punched window cells, street
 *   ribbons carrying walker/vehicle street life, tree clusters, and a
 *   Montréal landmark quadrant — a faceted green mount with a white cross
 *   (Mont-Royal cue) and an embanked river with two piered bridges — all
 *   seated on the UP-SCREEN bearing so the default iso frame
 *   actually shows them. The near-ring and mid-field housing stock reads as
 *   Montréal walk-ups: brick/greystone triplex rows under proud cornice
 *   parapets, with diagonal exterior-staircase prisms on the near ring's
 *   street-facing facades (user ask: "design Montréalais").
 *   Every band tone carries a baked ±24% sun-side value ramp
 *   matched to the key light's −55° azimuth (the meshes are shadowless, so
 *   the dusk falloff must be painted in).
 * - `buildStudioBackground` — a seamless-paper infinity cove: floor pie,
 *   quarter-round and tall sweep wall in ONE lathe draw.
 * - `buildDeskLamp` — ref1's brass dome lamp; returns a SpotLight SPEC
 *   (the engine instantiates the actual light).
 *
 * Hard rules: deterministic (seeded LCG — no Math.random/Date.now), merged
 * geometry under hard budgets (city ≤8 draws / ≤60k tris, studio ≤2,
 * lamp ≤3), background meshes never cast NOR receive shadows (shadow-map
 * budget stays with the board; the lamp body is the one hero exception),
 * and the city never intrudes into the board's `hole` rect — parts are
 * partitioned into N/S/E/W frame bands (plus river/bridge/mount landmark
 * meshes) whose merged bounding boxes each clear the hole on at least one
 * axis (testable without unpicking merges).
 */

export interface BackgroundLampSpec {
  position: [number, number, number]
  target: [number, number, number]
  color: string
  intensity: number
  angle: number
  penumbra: number
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
 * vertex-colored material carries the whole multi-tone merge). */
function tint(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
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
}
// darker and less saturated than a sky blue such as '#7FA8C0' — a bright
// saturated band reads as painted vinyl, not water
const RIVER_CSS = '#708EA0'

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

/** ref3's low-poly city ring: ≤8 draws, ≤60k tris, deterministic. */
export function buildCityBackground(opts: CityBackgroundOpts): BackgroundBuild {
  const { hole, radius, baseY, seed, makeMat } = opts
  const rnd = lcg(seed)
  // The engine's key light rides azimuth −55° / elevation
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
  // enough desk to separate city from tray (a 24-unit gap crowds the board
  // edge) but no more (ref3's blocks run right up to the trays).
  const margin = 56
  const hb = {
    minX: hole.x - hole.w / 2,
    maxX: hole.x + hole.w / 2,
    minZ: hole.z - hole.h / 2,
    maxZ: hole.z + hole.h / 2,
  }
  // lattice pitch — hoisted above the landmarks because the quay paving
  // meets the first south lattice row
  const step = Math.max(70, radius / 15)
  const half = step / 2 - 12
  const bands: Record<Band, THREE.BufferGeometry[]> = { north: [], south: [], east: [], west: [] }
  let tris = 0
  const push = (band: Band, geo: THREE.BufferGeometry): void => {
    tris += triCount(geo)
    bands[band].push(geo)
  }
  // Montréal-fabric manifest (test seam, streetLife pattern): every count
  // is bumped in the same call that pushes its geometry, so the numbers
  // can never drift from the meshes.
  const fabric = {
    walkups: 0,
    cornices: 0,
    penthouses: 0,
    roofUnits: 0,
    stairs: 0,
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
    const body = tint(new THREE.BoxGeometry(bw, h, bd), shade)
    body.translate(wx, baseY + h / 2, wz)
    push(band, body)
    // punched window cells: each face gets 3–5 darker-than-facade cells per
    // floor with clear gaps between them, on ALL four faces so orbits never
    // meet a blank back. 2-tri planes a hair proud of the shell. Near/mid
    // rings only: far blocks are a few px on screen and don't earn the
    // cells. Gate at h ≥ 8 so the LOW near ring gets them too.
    if (detail && h >= 8) {
      const winTone = shade.clone().multiplyScalar(0.42)
      const floors = Math.min(3, Math.max(1, Math.floor(h / 9)))
      const faces = [
        { nx: 0, nz: 1, w: bw, rotY: 0 },
        { nx: 0, nz: -1, w: bw, rotY: Math.PI },
        { nx: 1, nz: 0, w: bd, rotY: Math.PI / 2 },
        { nx: -1, nz: 0, w: bd, rotY: -Math.PI / 2 },
      ]
      for (const f of faces) {
        const k = Math.min(5, Math.max(3, Math.round(f.w / 16)))
        const span = f.w * 0.84
        const cw = (span / k) * 0.6
        for (let fl = 1; fl <= floors; fl++) {
          const y = baseY + (h / (floors + 1)) * fl
          for (let i = 0; i < k; i++) {
            if (rnd() < 0.12) continue // a few dark rooms keep the grid organic
            const off = -span / 2 + (span / k) * (i + 0.5)
            const cell = tint(new THREE.PlaneGeometry(cw, 2.8), winTone)
            cell.rotateY(f.rotY)
            cell.translate(
              wx + f.nx * (bw / 2 + 0.35) + (f.nz !== 0 ? off : 0),
              y,
              wz + f.nz * (bd / 2 + 0.35) + (f.nx !== 0 ? off : 0),
            )
            push(band, cell)
          }
        }
      }
      // slim string-courses BETWEEN the window rows — thinned to a hairline
      // (fat proud strips read as laminate)
      const stripTone = shade.clone().multiplyScalar(0.7)
      for (let fl = 1; fl < floors; fl++) {
        const strip = tint(new THREE.BoxGeometry(bw + 0.5, 0.55, bd + 0.5), stripTone)
        strip.translate(wx, baseY + (h / (floors + 1)) * (fl + 0.5), wz)
        push(band, strip)
      }
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
      const lip = tint(new THREE.BoxGeometry(bw + 1.6, 1.1, bd + 1.6), shade.clone().multiplyScalar(0.8))
      lip.translate(wx, baseY + h + 0.15, wz)
      push(band, lip)
    }
    // roofline variation — every block topping out bare reads as flat crates:
    // stepped setback / small dark unit / flat.
    const roofRoll = rnd()
    if (h > 12 && roofRoll < 0.36) {
      const sh = 3.5 + rnd() * 4.5
      const setback = tint(new THREE.BoxGeometry(bw * 0.66, sh, bd * 0.66), shade.clone().multiplyScalar(0.93))
      setback.translate(wx + bw * 0.07, baseY + h + sh / 2, wz - bd * 0.06)
      push(band, setback)
    } else if (h > 12 && roofRoll < 0.58) {
      const unit = tint(new THREE.BoxGeometry(bw * 0.3, 3.2, bd * 0.3), CITY.roof)
      unit.translate(wx + bw * 0.18, baseY + h + 1.6, wz - bd * 0.14)
      push(band, unit)
    }
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
    const body = tint(new THREE.BoxGeometry(w, h, d), shade)
    body.translate(wx, baseY + h / 2, wz)
    push(band, body)
    fabric.walkups++
    const floors = h > 16 ? 3 : 2
    if (detail) {
      const winTone = shade.clone().multiplyScalar(0.4)
      const faces = [
        { nx: 0, nz: 1, fw: w, on: o.mask?.[0] ?? true, rotY: 0 },
        { nx: 0, nz: -1, fw: w, on: o.mask?.[1] ?? true, rotY: Math.PI },
        { nx: 1, nz: 0, fw: d, on: o.mask?.[2] ?? true, rotY: Math.PI / 2 },
        { nx: -1, nz: 0, fw: d, on: o.mask?.[3] ?? true, rotY: -Math.PI / 2 },
      ]
      for (const f of faces) {
        if (!f.on) continue // shared plex wall — no windows
        // 2–3 tall openings per floor — the real triplex rhythm (and the
        // budget rebalance that keeps the 58k backstop from engaging)
        const k = Math.min(3, Math.max(2, Math.round(f.fw / 11)))
        const span = f.fw * 0.78
        const cw = (span / k) * 0.52
        for (let fl = 1; fl <= floors; fl++) {
          const y = baseY + (h * (fl - 0.42)) / floors
          for (let i = 0; i < k; i++) {
            if (rnd() < 0.1) continue
            const off = -span / 2 + (span / k) * (i + 0.5)
            // TALL cells (3.4 high vs the generic 2.8) — the vertical
            // Montréal sash-window proportion
            const cell = tint(new THREE.PlaneGeometry(cw, 3.4), winTone)
            cell.rotateY(f.rotY)
            cell.translate(
              wx + f.nx * (w / 2 + 0.35) + (f.nz !== 0 ? off : 0),
              y,
              wz + f.nz * (d / 2 + 0.35) + (f.nx !== 0 ? off : 0),
            )
            push(band, cell)
          }
        }
      }
    }
    // the CORNICE parapet — every walk-up wears one; light stone lips on
    // brick faces, dark sheet-metal lips on the pale greystones (the
    // contrast is what reads at distance)
    const luma = 0.2126 * shade.r + 0.7152 * shade.g + 0.0722 * shade.b
    const lipTone = luma < 0.42 ? CITY.cream.clone().multiplyScalar(0.98) : CITY.roof.clone().multiplyScalar(1.12)
    const lip = tint(new THREE.BoxGeometry(w + 2.6, 1.6, d + 2.6), lipTone)
    lip.translate(wx, baseY + h + 0.5, wz)
    push(band, lip)
    fabric.cornices++
    const roll = rnd()
    if (roll < 0.3) {
      const ph = 4 + rnd() * 2
      const pent = tint(new THREE.BoxGeometry(w * 0.52, ph, d * 0.52), shade.clone().multiplyScalar(0.95))
      pent.translate(wx - w * 0.1, baseY + h + ph / 2, wz + d * 0.08)
      push(band, pent)
      fabric.penthouses++
    } else if (roll < 0.55) {
      const unit = tint(new THREE.BoxGeometry(w * 0.2, 2.4, d * 0.24), CITY.roof)
      unit.translate(wx + w * 0.22, baseY + h + 1.7, wz - d * 0.16)
      push(band, unit)
      fabric.roofUnits++
    }
    if (o.stair) {
      // the exterior staircase, hinted as ONE diagonal prism climbing the
      // street facade to the first landing — proud of the wall by ~2, well
      // inside the 56-unit street margin so the hole invariant holds
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
    // the street/quay/near-ring fabric without touching the triangle cap
    if (kind === 'cone') {
      const h = 22 + s * 14
      const cone = tint(new THREE.ConeGeometry(7 + s * 5, h, 7, 1, true), tone)
      cone.translate(wx, baseY + h / 2, wz)
      push(band, cone)
    } else {
      // round tree: short trunk keeps the crown fully ABOVE the desk plane
      // (a ground-sunk sphere would dip below baseY)
      const r = 8 + s * 6
      const trunkH = r * 0.9
      const trunk = tint(new THREE.CylinderGeometry(1.6, 2.2, trunkH, 5, 1, true), CITY.trunk)
      trunk.translate(wx, baseY + trunkH / 2, wz)
      push(band, trunk)
      const crown = tint(new THREE.SphereGeometry(r, 6, 4), tone)
      crown.translate(wx, baseY + trunkH + r * 0.75, wz)
      push(band, crown)
    }
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
  const hasRiver = chordSq > 150 * 150
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
  for (const mr of [radius * 0.06, radius * 0.045]) {
    let mz = (hasRiver ? riverLoZ - 40 : hb.minZ - margin - 24) - mr
    // spoke multipliers reach 1.22·r — keep even the pushed facets clear
    // of the street margin and inside the ring
    mz = Math.min(mz, hb.minZ - margin - 1.28 * mr)
    // x-damping 0.10, not 0.25: at 0.25 the mount crowds so far WEST that it
    // sits in the very top of the wide frame, leaving under 50 css px of
    // headroom. The shallower damping slides it east/down-screen into the
    // frame proper.
    const mx = hole.x - (hole.z - mz) * upX * 0.1
    if (mr >= 60 && Math.hypot(mx - hole.x, mz - hole.z) + mr * 1.25 <= radius * 0.97) {
      mount = { x: mx, z: mz, r: mr }
      break
    }
  }
  const mountParts: THREE.BufferGeometry[] = []
  const pushMount = (g: THREE.BufferGeometry): void => {
    tris += triCount(g)
    mountParts.push(g)
  }
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
    hill.translate(mount.x, baseY, mount.z)
    pushMount(hill)
    // chunky white cross standing PROUD on the summit plateau — ~6-unit
    // members survive the mid-ring projection as a clear icon. The hill is
    // non-indexed with no uv, and mergeGeometries demands matching layouts,
    // so the cross boxes drop their index + uv to align.
    const ch = Math.max(20, mr * 0.3)
    const post = tint(new THREE.BoxGeometry(5.5, ch, 5.5).toNonIndexed(), CITY.cross)
    post.deleteAttribute('uv')
    post.translate(mount.x, baseY + H - 2 + ch / 2, mount.z)
    pushMount(post)
    const arms = tint(new THREE.BoxGeometry(ch * 0.55, 5.5, 5.5).toNonIndexed(), CITY.cross)
    arms.deleteAttribute('uv')
    arms.translate(mount.x, baseY + H - 2 + ch * 0.7, mount.z)
    pushMount(arms)
    // canopy: SMALL clusters (rb ≤ 0.15·r) so the facet
    // planes and notches stay readable; each stands proud with a darker
    // under-rim collar for its own self-shadow edge
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * tau + rnd() * 0.7
      const d = mr * (0.42 + rnd() * 0.3)
      const rb = mr * (0.1 + rnd() * 0.05)
      const blobTone = (i % 2 ? CITY.leafA : CITY.leafB).clone().multiplyScalar(0.86 + rnd() * 0.26)
      const bxp = mount.x + Math.cos(a) * d
      const bzp = mount.z + Math.sin(a) * d
      const yy = hillY(bxp - mount.x, bzp - mount.z)
      if (yy < 6) continue // pulled-spoke ravine — no shelf to stand on
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
      const th = 14 + rnd() * 9
      const cxp = mount.x + Math.cos(a) * d
      const czp = mount.z + Math.sin(a) * d
      const yy = hillY(cxp - mount.x, czp - mount.z)
      if (yy < 4) continue
      const cone = tint(new THREE.ConeGeometry(5.5, th, 6, 1, true), i % 2 ? CITY.leafA : CITY.leafB)
      cone.translate(cxp, baseY + yy + th / 2 - 3, czp)
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
      if (yy < 5) continue
      if (rnd() < 0.45) {
        const th = 8 + rnd() * 6
        const cone = tint(new THREE.ConeGeometry(3.1, th, 5, 1, true), i % 2 ? CITY.leafB : CITY.leafA)
        cone.translate(txp, baseY + yy + th / 2 - 1.5, tzp)
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
  }

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
      // Montréal walk-up row: 2–3 storey proportions (triplex scale), the
      // brick/greystone wardrobe, and mostly a staircase prism on the
      // facade FACING the street/board — the near-ring signature.
      const h = rnd() < 0.55 ? 18.5 + rnd() * 3 : 12.5 + rnd() * 2
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
  // — planes ABOVE the pads (1.4 vs 0.95) so the ribbon reads continuously
  // across the fabric; two on the west flank the default framing shows, one
  // east, one north, one south meeting the near bridge.
  const streetW = 24
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

  // ── street life: walkers + vehicles ON the ribbons ──
  // Visibility is the constraint, not the count: at the wide framing
  // (~0.35 css px per unit) a ~7-unit walker in city tones is ~2.5 px and
  // vanishes into the street grey, and an uncapped spawn spread lands most
  // props past the ~110-unit strip the default crop shows. So silhouettes
  // are ~14–16 units in a dedicated saturated/dark wardrobe (deep red /
  // navy / forest / plum — nothing the pale streets can absorb), the
  // scatter distance is capped near the board-adjacent end, and every
  // framing-visible ribbon (both west + the south bridge street) gets a
  // GUARANTEED seat within the default crop's strip.
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
  const person = (band: Band, wx: number, wz: number): void => {
    const br = 1.8 + rnd() * 0.4
    const len = 4.6 + rnd() * 1.8
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
    const vl = 22 + rnd() * 6
    const vw = 10 + rnd() * 2.4
    const bh = 6 + rnd() * 1.4
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
    cab.translate(wx, baseY + 1.5 + bh - 0.6, wz)
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
    const at = (dAlong: number, dAcross: number): [number, number] => {
      const a = nearHi ? (alongX ? rect.maxX : rect.maxZ) - dAlong : (alongX ? rect.minX : rect.minZ) + dAlong
      const c = (alongX ? (rect.minZ + rect.maxZ) / 2 : (rect.minX + rect.maxX) / 2) + dAcross
      return alongX ? [a, c] : [c, a]
    }
    return { alongX, len, at }
  }
  // guaranteed near-board seats FIRST (so the vehicle cap can never starve
  // them): the two west ribbons + the south bridge street are the segments
  // the default framing actually crops — one walker each inside the first
  // ~75 units off the board apron (the south cap stays under the river
  // guard's reach), and one vehicle on the first west ribbon.
  for (const [ri, dMax] of [[0, 70], [1, 70], [4, 55]] as Array<[number, number]>) {
    const rect = streetRects[ri]
    if (!rect) continue
    const { at } = rectGeom(rect)
    const [px, pz] = at(8 + rnd() * dMax, (rnd() < 0.5 ? -1 : 1) * streetW * (0.18 + rnd() * 0.14))
    if (lifeGuard(px, pz, 4)) person(rect.band, px, pz)
  }
  if (streetRects[0]) {
    const { alongX, at } = rectGeom(streetRects[0])
    const [vx, vz] = at(18 + rnd() * 70, (rnd() - 0.5) * streetW * 0.16)
    if (lifeGuard(vx, vz, 15)) {
      vehicle(streetRects[0].band, vx, vz, alongX)
      vehPlaced++
    }
  }
  const seatLife = (rect: (typeof streetRects)[number], withPeople: boolean): void => {
    const { alongX, len, at } = rectGeom(rect)
    if (withPeople) {
      // 2–3 walkers per ribbon, rnd·rnd-biased toward the board end and
      // CAPPED at 240 units out (an uncapped 0.85·len spread parks most
      // walkers beyond the visible strip), hugging a lane edge
      const n = 2 + (rnd() < 0.5 ? 1 : 0)
      for (let i = 0; i < n; i++) {
        const [px, pz] = at(
          6 + rnd() * rnd() * Math.min(len - 12, 240) * 0.85,
          (rnd() < 0.5 ? -1 : 1) * streetW * (0.18 + rnd() * 0.14),
        )
        if (lifeGuard(px, pz, 4)) person(rect.band, px, pz)
      }
    }
    if (vehPlaced < vehWant) {
      const [vx, vz] = at(10 + rnd() * rnd() * Math.min(len - 24, 260) * 0.8, (rnd() - 0.5) * streetW * 0.16)
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

  // ── block grid: four MARGIN-ANCHORED band lattices ──
  // A single global lattice starting at −radius+step/2 makes whether a
  // face's first column of cells lands against its street margin luck of
  // the modulo (a face can end up with its first column ~257 units out and
  // read as bare sand). Each band's lattice is anchored AT its margin line,
  // so the first ring of pads hugs the street on every face by construction.
  const capTris = 58000 // backstop only — natural totals stay ≳1k under it (regression-tested)
  const fillCell = (wx: number, wz: number): void => {
    if (tris > capTris) return
    const gx = wx - hole.x
    const gz = wz - hole.z
    if (Math.hypot(gx, gz) + half * Math.SQRT2 > radius) return
    const band = bandFor(wx - half, wx + half, wz - half, wz + half)
    if (!band) return
    if (hasRiver && wz + half > riverLoZ - 6 && wz - half < riverHiZ + 6) return
    if (mount && Math.hypot(wx - mount.x, wz - mount.z) < mount.r * 1.25 + half) return
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
    if (roll < plazaP) return // plaza — pad only, keeps the grid from reading as a clone army
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
    // built cell: a cluster of SMALL blocks — heights ease DOWN toward the
    // board on a t² ramp so the near ring stays below tray-top and the
    // skyline frames the diagram.
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
    const pickH = (): number => {
      const h = 10 + rnd() * 12 + t * t * (55 + rnd() * 45)
      // rare far-ring towers — never near the board
      return t > 0.5 && rnd() < 0.05 ? h + 60 + rnd() * 70 : h
    }
    if (half > 40 && (nearRing || t < 0.5)) {
      // Montréal plex row (user ask): 2–3 attached brick/greystone
      // walk-ups sharing side walls under one roofline — flat cornice
      // parapets, per-segment tone variety, shared walls left blank.
      // Every footprint keeps |offset| + size/2 ≤ half so the cell's
      // bandFor verdict still bounds the geometry (hole invariant).
      const alongX2 = rnd() < 0.5
      const n = 2 + (rnd() < 0.6 ? 1 : 0)
      const rowLen = half * (1.5 + rnd() * 0.35)
      const segW = rowLen / n
      const depth = half * (0.45 + rnd() * 0.15)
      const rowOff = (rnd() < 0.5 ? -1 : 1) * half * 0.42
      const rowH = rnd() < 0.6 ? 18.5 + rnd() * 3.5 : 12.5 + rnd() * 2.5
      for (let i = 0; i < n; i++) {
        const off = -rowLen / 2 + segW * (i + 0.5)
        const segH = rowH + (rnd() - 0.5) * 1.6
        const mask: [boolean, boolean, boolean, boolean] = alongX2
          ? [true, true, i === n - 1, i === 0]
          : [i === n - 1, i === 0, true, true]
        walkup(
          band,
          wx + (alongX2 ? off : rowOff),
          wz + (alongX2 ? rowOff : off),
          alongX2 ? segW * 0.94 : depth,
          alongX2 ? depth : segW * 0.94,
          segH,
          plexTone(),
          detail,
          { mask },
        )
      }
      // a lone cross-street walk-up keeps the cell from reading as one bar
      if (rnd() < 0.35) {
        const aw = half * (0.4 + rnd() * 0.18)
        const ax = (rnd() - 0.5) * half * 0.8
        walkup(
          band,
          wx + (alongX2 ? ax : -rowOff),
          wz + (alongX2 ? -rowOff : ax),
          alongX2 ? aw : half * 0.42,
          alongX2 ? half * 0.42 : aw,
          12.5 + rnd() * 4,
          plexTone(),
          detail,
        )
      }
      if (nearRing && rnd() < 0.7) {
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
      walkup(band, wx, wz, wwu, dwu, rnd() < 0.6 ? 18 + rnd() * 3 : 12.5 + rnd() * 2.5, plexTone(), detail)
    } else {
      building(band, wx, wz, half * (0.66 + rnd() * 0.3), half * (0.66 + rnd() * 0.3), pickH(), pickTone(), detail)
    }
  }
  const cols = Math.ceil(radius / step)
  const rowsNS = Math.ceil(radius / step)
  for (let row = 0; row < rowsNS; row++) {
    const wz = hb.maxZ + margin + step / 2 + row * step
    for (let col = -cols; col < cols; col++) fillCell(hole.x + (col + 0.5) * step, wz)
  }
  for (let row = 0; row < rowsNS; row++) {
    const wz = hb.minZ - margin - step / 2 - row * step
    for (let col = -cols; col < cols; col++) fillCell(hole.x + (col + 0.5) * step, wz)
  }
  const sideRows = Math.max(1, Math.floor((hole.h + 2 * margin) / step))
  const z0 = hole.z - ((sideRows - 1) / 2) * step
  for (let col = 0; col < cols; col++) {
    const wx = hb.maxX + margin + step / 2 + col * step
    for (let r = 0; r < sideRows; r++) fillCell(wx, z0 + r * step)
  }
  for (let col = 0; col < cols; col++) {
    const wx = hb.minX - margin - step / 2 - col * step
    for (let r = 0; r < sideRows; r++) fillCell(wx, z0 + r * step)
  }

  const group = new THREE.Group()
  // ONE vertex-colored matte material serves every band (white css so the
  // baked tones show verbatim — litSurface convention)
  const cityMat = makeMat('decor', '#FFFFFF', { vertexColors: true, roughness: 0.88 })
  const addMerged = (parts: THREE.BufferGeometry[], tag: string): void => {
    if (parts.length === 0) return
    const merged = mergeGeometries(parts)
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
    const mesh = new THREE.Mesh(merged, cityMat)
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.userData.bgPart = tag
    group.add(mesh)
  }
  for (const name of BAND_ORDER) addMerged(bands[name], `city-${name}`)
  addMerged(bridgeParts, 'city-bridges')
  addMerged(mountParts, 'city-mount')
  if (riverGeo) {
    // vertexColors is the load-bearing flag here: without it the baked tone
    // drift silently drops and the run reads as one flat band — the base
    // tone is baked into the drift, so the css is white
    const waterMat = makeMat('decor', '#FFFFFF', { vertexColors: true, roughness: 0.3 })
    // the PMREM env sheen flattens the drift — let the baked streaks own the
    // value range (same move as the studio sweep)
    if (waterMat instanceof THREE.MeshStandardMaterial) waterMat.envMapIntensity = 0.6
    const water = new THREE.Mesh(riverGeo, waterMat)
    water.castShadow = false
    water.receiveShadow = false
    water.userData.bgPart = 'city-river'
    group.add(water)
  }
  // street-life manifest — where the walkers/vehicles actually stand. Test
  // seam only (the parts themselves are merged into the band meshes); each
  // entry is pushed in the same call that pushes its geometry.
  group.userData.streetLife = streetLife
  // Montréal-fabric manifest (walk-ups / cornices / roof treatments /
  // staircase prisms) — same test-seam contract.
  group.userData.cityFabric = fabric
  return { group, ...statsOf(group) }
}

export interface StudioBackgroundOpts {
  /** Scale reference — the engine passes max(5000, 5·board max dim). The
   * sweep itself stands at radius/2.5 so both its arc ends and its top edge
   * stay OUTSIDE the default iso framing at every board size. */
  radius: number
  baseY: number
  makeMat: MakeMat
}

/** Studio cyclorama — a real infinity-cove sweep: seamless paper floor →
 * quarter-round cove → tall wall, ONE lathe draw. An infinity cove only
 * sells while its edges are never seen (a radius/6 band shows its top edge
 * and BOTH arc ends inside the frame and reads as a band-shell prop standing
 * on the desk). The sweep carries its OWN paper floor from its axis out to
 * the cove, so the wood desk visibly ENDS where the sweep begins instead of
 * streaking on to the horizon, and the wall rises 2.4·r (1.25·r leaves the
 * far desk visible over the top edge at the wide framing — the mode reads as
 * endless desk). The 270° arc keeps both arc ends
 * out of the crop sideways while the +X/+Z camera quadrant stays open —
 * small boards put the camera INSIDE the cove, which reads even better.
 * Cool paper tones step a clear notch away from the desk wood. */
export function buildStudioBackground(opts: StudioBackgroundOpts): BackgroundBuild {
  const { radius, baseY, makeMat } = opts
  const r = radius / 2.5
  const coveR = r * 0.18 // lazy quarter-round — a tight cove reads as a cut
  const lipW = r * 0.05
  const height = r * 2.4
  // arc centered past −Z by the iso preset's 40° azimuth (the default
  // camera's up-screen direction); ±135° of span walls the whole frame
  // while the +X/+Z quadrant the camera rides in stays open, and the far
  // end skims the board's east flank low under the slab lip (deskY sits
  // 16 under the slab bottom, so the sweep emerges well past the board)
  const arcCenter = Math.PI + (40 * Math.PI) / 180
  const arcSpan = Math.PI * 1.5
  // paper floor pie first: from the lathe axis out to the cove foot, so
  // the cove is a MATERIAL break (pale seamless paper), not a continuation
  // of the wood — the interior wood otherwise ran right up to the wall base
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2((r - coveR - lipW) * 0.55, 0),
    new THREE.Vector2(r - coveR - lipW, 0),
  ]
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
  const floorTone = new THREE.Color('#DCD6C6') // neutral paper — still a clear step off the wood
  const wallTone = new THREE.Color('#C4BDAA') // cove zone visibly under the floor = the horizon step
  const midTone = new THREE.Color('#A19B8D')
  const topTone = new THREE.Color('#767C8A') // cool grey up high = the horizon-curve read
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
    const rho = Math.hypot(pos.getX(i), pos.getZ(i))
    const radial = Math.max(0, rho / pieEnd - 0.55) / 0.45 // 0 to mid-pie, 1 at the cove foot
    const rise = Math.min(1, Math.max(0, pos.getY(i)) / (coveR * 1.5))
    const u = Math.min(1, radial * 0.55 + rise * 0.45)
    const s = u * u * (3 - 2 * u)
    if (s < 0.25) c.lerpColors(floorTone, wallTone, s / 0.25)
    else if (s < 0.6) c.lerpColors(wallTone, midTone, (s - 0.25) / 0.35)
    else c.lerpColors(midTone, topTone, (s - 0.6) / 0.4)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  // proud of the desk plane by a hair — a coplanar floor lip would z-fight
  geo.translate(0, baseY + 0.9, 0)
  const mat = makeMat('decor', '#FFFFFF', { vertexColors: true, roughness: 0.95 })
  mat.side = THREE.DoubleSide // inside at default framing, outside on far orbits
  // ambient IBL washes the baked grade toward one flat field — the env
  // nudge (with the darker stops above) lets the vertex
  // gradient own the value range instead of clipping at the ACES shoulder
  if (mat instanceof THREE.MeshStandardMaterial) mat.envMapIntensity = 0.7
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.userData.bgPart = 'studio-sweep'
  const group = new THREE.Group()
  group.add(mesh)
  return { group, ...statsOf(group) }
}

export interface DeskLampOpts {
  /** Base-disc position ON the desk plane (world). */
  position: [number, number, number]
  /** Where the shade and the spot spec aim (world). */
  boardCenter: [number, number, number]
  /** Uniform group scale (default 1 ≈ 250 units tall). The spot spec rides
   * the SAME factor so the pool still pours from inside the shade. */
  scale?: number
  makeMat: MakeMat
}

/** ref1's brass dome desk lamp (~250 units tall at scale 1). ≤3 draws.
 * Returns the SpotLight SPEC only; the engine instantiates the light. */
export function buildDeskLamp(opts: DeskLampOpts): BackgroundBuild {
  const { position, boardCenter, makeMat } = opts
  const scale = opts.scale ?? 1
  const [px, py, pz] = position
  const yaw = Math.atan2(boardCenter[0] - px, boardCenter[2] - pz) // local +Z faces the board
  const localBoard = new THREE.Vector3(boardCenter[0] - px, boardCenter[1] - py, boardCenter[2] - pz)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw)

  const brass: THREE.BufferGeometry[] = []
  const base = new THREE.CylinderGeometry(44, 54, 12, 28)
  base.translate(0, 6, 0)
  brass.push(base)
  const collar = new THREE.CylinderGeometry(11, 16, 10, 16)
  collar.translate(0, 15, 0)
  brass.push(collar)
  // arm: an S over the desk, leaning toward the board (+Z local). Hunched
  // LOW on purpose: a tall straight mast (apex ~292) hangs the dome ~160 css
  // px above its base at the default iso framing — a band the top toolbar +
  // board edge leave no room for, so the dome exits the frame. The gooseneck
  // crests at 240 and drops the shade to 165, leaning 162 over the desk —
  // ref1's low-hung banker pose — so the dome head reads inside the crop.
  const curve = new THREE.CubicBezierCurve3(
    new THREE.Vector3(0, 12, 0),
    new THREE.Vector3(0, 155, -30),
    new THREE.Vector3(0, 240, 30),
    new THREE.Vector3(0, 178, 148),
  )
  brass.push(new THREE.TubeGeometry(curve, 24, 7, 10, false))

  const shadeC = new THREE.Vector3(0, 165, 162)
  const aim = localBoard.clone().sub(shadeC).normalize()
  // dome opening faces −Y at construction; tilt it onto the aim line
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), aim)
  const shadeR = 82
  const lip = Math.PI * 0.56 // past the equator — the reference's deep bell
  const orient = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    g.applyQuaternion(q)
    g.translate(shadeC.x, shadeC.y, shadeC.z)
    return g
  }
  brass.push(orient(new THREE.SphereGeometry(shadeR, 26, 13, 0, Math.PI * 2, 0, lip)))
  const rim = new THREE.TorusGeometry(shadeR * Math.sin(lip), 3.5, 8, 28)
  rim.rotateX(Math.PI / 2)
  rim.translate(0, shadeR * Math.cos(lip), 0)
  brass.push(orient(rim))
  const finial = new THREE.SphereGeometry(11, 14, 10)
  finial.translate(0, shadeR + 4, 0)
  brass.push(orient(finial))

  const group = new THREE.Group()
  group.rotation.y = yaw
  group.position.set(px, py, pz)
  group.scale.setScalar(scale)

  const brassGeo = mergeGeometries(brass)
  for (const g of brass) g.dispose()
  const body = new THREE.Mesh(brassGeo, makeMat('decor', '#B98A45', { metalness: 0.9, roughness: 0.35 }))
  // the lamp is a HERO prop: unlike the rest of the background it may cast
  body.castShadow = true
  body.receiveShadow = false
  body.userData.bgPart = 'lamp-brass'
  group.add(body)

  const inner = orient(new THREE.SphereGeometry(shadeR - 5, 22, 11, 0, Math.PI * 2, 0, lip * 0.96))
  const innerMat = makeMat('decorEmissive', '#FFE9C4', {
    emissive: '#FFD9A0',
    emissiveIntensity: 2.2,
    roughness: 0.6,
  })
  innerMat.side = THREE.BackSide // only the glowing INSIDE of the dome shows
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
  const lamp: BackgroundLampSpec = {
    position: [px + opening.x * cos + opening.z * sin, py + opening.y, pz - opening.x * sin + opening.z * cos],
    target: [boardCenter[0], boardCenter[1], boardCenter[2]],
    color: '#FFD9A0',
    intensity: 2.4,
    angle: 0.5,
    penumbra: 0.6,
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
