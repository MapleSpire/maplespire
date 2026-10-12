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
  buildCityBackground,
  buildDeskLamp,
  buildStudioBackground,
  disposeBackground,
  type BackgroundBuild,
  type MakeMat,
} from './backgrounds'

interface MatCall {
  role: string
  css: string
  opts: Parameters<MakeMat>[2]
}

/** Engine-free MakeMat stand-in: records role requests, returns real
 * materials so side/dispose behavior stays exercised. */
function recordingMakeMat(calls: MatCall[]): MakeMat {
  return (role, css, opts) => {
    calls.push({ role, css, opts })
    return new THREE.MeshStandardMaterial({ color: css, vertexColors: opts?.vertexColors ?? false })
  }
}

function meshesOf(b: BackgroundBuild): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  b.group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh)
  })
  return out
}

function trisOf(meshes: THREE.Mesh[]): number {
  let t = 0
  for (const m of meshes) {
    const g = m.geometry
    t += (g.index ? g.index.count : g.getAttribute('position').count) / 3
  }
  return t
}

/** Order-sensitive position checksum — detects any vertex drift or reorder
 * between two builds (float ops are deterministic, so equality is exact). */
function checksum(geo: THREE.BufferGeometry): number {
  const a = geo.getAttribute('position').array as Float32Array
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * ((i % 977) + 1)
  return s
}

const HOLE = { x: 60, z: -40, w: 900, h: 560 }
const RADIUS = 2300
const BASE_Y = -30

describe('city background (ring around the desk zone)', () => {
  it('stays within the hard budgets: ≤8 draws, ≤60k tris, sits on baseY, no shadows', () => {
    const calls: MatCall[] = []
    const b = buildCityBackground({ hole: HOLE, radius: RADIUS, baseY: BASE_Y, seed: 7, makeMat: recordingMakeMat(calls) })
    const meshes = meshesOf(b)
    expect(meshes.length).toBeGreaterThan(0)
    expect(meshes.length, 'city draw calls').toBeLessThanOrEqual(8)
    expect(b.drawCalls).toBe(meshes.length)
    const tris = trisOf(meshes)
    expect(tris, 'city triangle budget').toBeLessThanOrEqual(60000)
    expect(b.triangles).toBe(tris)
    for (const m of meshes) {
      expect(m.castShadow, `${String(m.userData.bgPart)} must not spike the shadow map`).toBe(false)
      expect(m.receiveShadow).toBe(false)
      m.geometry.computeBoundingBox()
      expect(m.geometry.boundingBox!.min.y, `${String(m.userData.bgPart)} sits on the desk`).toBeGreaterThanOrEqual(
        BASE_Y - 1e-3,
      )
    }
    // landmark presence: the river ribbon is its own (glossier) mesh
    expect(meshes.some((m) => m.userData.bgPart === 'city-river')).toBe(true)
    // the water's baked tone drift only renders when its material opts into
    // vertex colors — without the flag the run reads as one flat band
    const waterCall = calls.find((c) => c.opts?.roughness === 0.3)
    expect(waterCall?.opts?.vertexColors, 'water tone drift needs vertexColors').toBe(true)
    expect(b.lamp).toBeUndefined()
    expect(calls.every((c) => c.role === 'decor')).toBe(true)
    disposeBackground(b)
  })

  it('is deterministic: same seed → same mesh count + identical first-geometry checksum', () => {
    const make = (seed: number) =>
      buildCityBackground({ hole: HOLE, radius: RADIUS, baseY: BASE_Y, seed, makeMat: recordingMakeMat([]) })
    const a = make(1234)
    const b = make(1234)
    const c = make(99)
    const am = meshesOf(a)
    const bm = meshesOf(b)
    expect(bm.length).toBe(am.length)
    expect(checksum(bm[0].geometry)).toBe(checksum(am[0].geometry))
    expect(checksum(meshesOf(c)[0].geometry)).not.toBe(checksum(am[0].geometry))
    disposeBackground(a)
    disposeBackground(b)
    disposeBackground(c)
  })

  it('never intrudes into the hole: no mesh bbox overlaps the rect on both X and Z', () => {
    const b = buildCityBackground({ hole: HOLE, radius: RADIUS, baseY: BASE_Y, seed: 42, makeMat: recordingMakeMat([]) })
    const minX = HOLE.x - HOLE.w / 2
    const maxX = HOLE.x + HOLE.w / 2
    const minZ = HOLE.z - HOLE.h / 2
    const maxZ = HOLE.z + HOLE.h / 2
    for (const m of meshesOf(b)) {
      m.geometry.computeBoundingBox()
      const bb = m.geometry.boundingBox!
      const overlapX = bb.min.x < maxX && bb.max.x > minX
      const overlapZ = bb.min.z < maxZ && bb.max.z > minZ
      expect(overlapX && overlapZ, `${String(m.userData.bgPart)} intrudes into the board zone`).toBe(false)
    }
    disposeBackground(b)
  })
})

describe('city round-5 regressions (verdict #5 — hero-framing visibility)', () => {
  const SEEDS = [1, 7, 42, 99, 1234]
  const MARGIN = 56 // builder's street margin (private const — mirrored here)

  it('west band keeps BUILT fabric near the margin for every seed (board must not read as an island)', () => {
    // A global lattice origin can leave the west face's first cell column
    // ~257 units out while north's lands ~72, and a 60°-sector guarantee can
    // be satisfied by corner props. The anchored
    // band lattices + face tally must put raised structures (buildings /
    // trees, not just flat paving) within 360 units of the west street.
    for (const seed of SEEDS) {
      const b = buildCityBackground({ hole: HOLE, radius: RADIUS, baseY: BASE_Y, seed, makeMat: recordingMakeMat([]) })
      const west = meshesOf(b).find((m) => m.userData.bgPart === 'city-west')
      expect(west, `seed ${seed}: west band mesh present`).toBeTruthy()
      const pos = west!.geometry.getAttribute('position')
      const marginLine = HOLE.x - HOLE.w / 2 - MARGIN
      let built = 0
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i)
        if (pos.getY(i) >= BASE_Y + 6 && x >= marginLine - 360 && x <= marginLine) built++
      }
      expect(built, `seed ${seed}: raised-structure vertices in the near-west band`).toBeGreaterThanOrEqual(30)
      disposeBackground(b)
    }
  })

  it('a bridge crossing lands inside the default-framing strip above the board', () => {
    // The default iso frame shows ~110 world units of desk past the hole's
    // south edge; a bridge must live inside that strip, horizontally
    // within the hole span — otherwise the river reads bridge-less at the
    // framing users actually get.
    for (const seed of SEEDS) {
      const b = buildCityBackground({ hole: HOLE, radius: RADIUS, baseY: BASE_Y, seed, makeMat: recordingMakeMat([]) })
      const bridges = meshesOf(b).find((m) => m.userData.bgPart === 'city-bridges')
      expect(bridges, `seed ${seed}: bridges mesh present`).toBeTruthy()
      bridges!.geometry.computeBoundingBox()
      const bb = bridges!.geometry.boundingBox!
      const minZ = HOLE.z - HOLE.h / 2
      expect(bb.max.z, `seed ${seed}: a bridge reaches the near strip`).toBeGreaterThanOrEqual(minZ - 240)
      expect(bb.max.z, `seed ${seed}: bridges stay off the board zone`).toBeLessThan(minZ)
      // the near crossing sits just west of center — inside the corner
      // river window the default frame actually shows
      expect(bb.max.x, `seed ${seed}: near bridge reaches the default-frame window`).toBeGreaterThan(
        HOLE.x - HOLE.w * 0.25,
      )
      expect(bb.max.x, `seed ${seed}: near bridge stays inside the hole span`).toBeLessThan(HOLE.x + HOLE.w / 2)
      disposeBackground(b)
    }
  })

  it('mount silhouette is notched: per-spoke radial spread over a 12% floor', () => {
    // The gumdrop read came from high-frequency per-vertex jitter that
    // averages out at frame scale. The polygonal hill's base ring must
    // carry LOW-frequency spread: (max − min) / mean radius ≥ 0.12.
    for (const seed of [7, 99, 1234]) {
      const b = buildCityBackground({ hole: HOLE, radius: RADIUS, baseY: BASE_Y, seed, makeMat: recordingMakeMat([]) })
      const mnt = meshesOf(b).find((m) => m.userData.bgPart === 'city-mount')
      expect(mnt, `seed ${seed}: mount mesh present`).toBeTruthy()
      const pos = mnt!.geometry.getAttribute('position')
      // base ring only (y < BASE_Y + 20): ring 1 starts at 0.3·H ≈ 25.7
      // and the cross/plateau sit far higher, so nothing else pollutes
      const bx: number[] = []
      const bz: number[] = []
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) < BASE_Y + 20) {
          bx.push(pos.getX(i))
          bz.push(pos.getZ(i))
        }
      }
      expect(bx.length, `seed ${seed}: base ring vertices found`).toBeGreaterThan(6)
      const cx = bx.reduce((a, v) => a + v, 0) / bx.length
      const cz = bz.reduce((a, v) => a + v, 0) / bz.length
      let min = Infinity
      let max = -Infinity
      let sum = 0
      for (let i = 0; i < bx.length; i++) {
        const r = Math.hypot(bx[i] - cx, bz[i] - cz)
        min = Math.min(min, r)
        max = Math.max(max, r)
        sum += r
      }
      const spread = (max - min) / (sum / bx.length)
      expect(spread, `seed ${seed}: silhouette radial spread`).toBeGreaterThanOrEqual(0.12)
      disposeBackground(b)
    }
  })

  it('natural generation keeps headroom under the 58k backstop cap (cap must never clip the fabric)', () => {
    // Measured over a 12-seed sweep (3, 5, 7, 11, 13, 18, 21, 33, 55, 99,
    // 123, 777); the natural worst case is SEED 18. Re-measure the sweep when
    // geometry is added — removing geometry only releases triangles.
    // The bar is 57,000, below the 58,000 backstop — the one that would
    // actually clip fabric. `b.triangles` coming back under the bar is the
    // proof it did not clip anything on the way.
    for (const seed of [3, 7, 11, 13, 18, 21, 99]) {
      const b = buildCityBackground({
        hole: { x: 0, z: 0, w: 1200, h: 800 },
        radius: 3300,
        baseY: 0,
        seed,
        makeMat: recordingMakeMat([]),
      })
      expect(b.triangles, `seed ${seed}: natural total clear of the cap`).toBeLessThanOrEqual(57000)
      disposeBackground(b)
    }
  })
})

describe('Montréal fabric (user ask: walk-ups)', () => {
  const SEEDS3 = [7, 42, 1234]
  interface CityFabric {
    walkups: number
    cornices: number
    penthouses: number
    roofUnits: number
    stairs: number
  }
  it('walk-up stock: a cornice parapet on EVERY walk-up, all roof treatments present, staircase prisms on the near ring', () => {
    // measured over the 3 seeds: walkups 121–140, penthouses 39–53,
    // roofUnits 27–53, stairs 13–22 — bars keep slack for other boards
    for (const seed of SEEDS3) {
      const b = buildCityBackground({ hole: HOLE, radius: RADIUS, baseY: BASE_Y, seed, makeMat: recordingMakeMat([]) })
      const f = b.group.userData.cityFabric as CityFabric
      expect(f.walkups, `seed ${seed}: walk-up fabric present`).toBeGreaterThanOrEqual(80)
      expect(f.cornices, `seed ${seed}: every walk-up wears its cornice parapet`).toBe(f.walkups)
      expect(f.penthouses, `seed ${seed}: penthouse-box roof treatment present`).toBeGreaterThanOrEqual(10)
      expect(f.roofUnits, `seed ${seed}: rooftop-unit treatment present`).toBeGreaterThanOrEqual(10)
      expect(f.stairs, `seed ${seed}: exterior-staircase prisms on the near ring`).toBeGreaterThanOrEqual(8)
      disposeBackground(b)
    }
  })
})

describe('city critique #6 (dusk grading + street life)', () => {
  const SUN_X = Math.sin((-55 * Math.PI) / 180)
  const SUN_Z = Math.cos((-55 * Math.PI) / 180)

  it('bakes the sun-side value gradient: mean band tone up-sun > down-sun', () => {
    // The key light rides azimuth −55° (lighting.ts), i.e. the sun stands in
    // the −x/+z quadrant. The city meshes are unlit-by-shadow, so the bands
    // must BAKE the falloff. Pooled over the four band meshes because a
    // single band's composition noise reaches ±23% (measured with the
    // gradient stripped); the pool balances it — west is all up-sun, east
    // all down-sun, north/south carry both. Measured discriminator: with the
    // ±24%/×2.4 ramp the far-field ratio runs 1.58–1.86 over 9 seeds, with a
    // weaker ±15% ramp 1.29–1.40, without any ramp 0.97–1.05 — the 1.45 bar
    // rejects both weaker states cleanly.
    for (const seed of [7, 42, 1234]) {
      const b = buildCityBackground({ hole: HOLE, radius: RADIUS, baseY: BASE_Y, seed, makeMat: recordingMakeMat([]) })
      let upSum = 0
      let upN = 0
      let downSum = 0
      let downN = 0
      for (const m of meshesOf(b)) {
        if (!/^city-(north|south|east|west)$/.test(String(m.userData.bgPart))) continue
        const pos = m.geometry.getAttribute('position')
        const col = m.geometry.getAttribute('color')
        expect(col, 'band tones ride vertex colors').toBeTruthy()
        for (let i = 0; i < pos.count; i++) {
          const u = ((pos.getX(i) - HOLE.x) * SUN_X + (pos.getZ(i) - HOLE.z) * SUN_Z) / RADIUS
          const luma = 0.2126 * col.getX(i) + 0.7152 * col.getY(i) + 0.0722 * col.getZ(i)
          if (u > 0.45) {
            upSum += luma
            upN++
          } else if (u < -0.45) {
            downSum += luma
            downN++
          }
        }
      }
      // both sides must carry real fabric or the mean is meaningless
      expect(upN, `seed ${seed}: up-sun sample size`).toBeGreaterThan(1000)
      expect(downN, `seed ${seed}: down-sun sample size`).toBeGreaterThan(1000)
      expect(upSum / upN, `seed ${seed}: up-sun mean tone exceeds down-sun`).toBeGreaterThan(
        (downSum / downN) * 1.45,
      )
      disposeBackground(b)
    }
  })

  it('scatters street life on the ribbons: walkers + 3–5 vehicles, never inside the hole', () => {
    for (const seed of [1, 42, 1234]) {
      const b = buildCityBackground({ hole: HOLE, radius: RADIUS, baseY: BASE_Y, seed, makeMat: recordingMakeMat([]) })
      const life = b.group.userData.streetLife as {
        people: Array<{ x: number; z: number }>
        vehicles: Array<{ x: number; z: number }>
      }
      expect(life, `seed ${seed}: street-life manifest present`).toBeTruthy()
      expect(life.people.length, `seed ${seed}: walkers on the streets`).toBeGreaterThanOrEqual(6)
      expect(life.vehicles.length, `seed ${seed}: at least 3 vehicles`).toBeGreaterThanOrEqual(3)
      expect(life.vehicles.length, `seed ${seed}: at most 5 vehicles`).toBeLessThanOrEqual(5)
      const minX = HOLE.x - HOLE.w / 2
      const maxX = HOLE.x + HOLE.w / 2
      const minZ = HOLE.z - HOLE.h / 2
      const maxZ = HOLE.z + HOLE.h / 2
      for (const p of [...life.people, ...life.vehicles]) {
        // a 2-unit apron pad: even prop CENTERS hugging the board edge are a
        // bug — footprints must stay on the ribbon, which clears the hole
        const inside = p.x > minX - 2 && p.x < maxX + 2 && p.z > minZ - 2 && p.z < maxZ + 2
        expect(inside, `seed ${seed}: prop at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) intrudes into the hole`).toBe(
          false,
        )
        expect(Math.hypot(p.x - HOLE.x, p.z - HOLE.z), `seed ${seed}: prop inside the ring`).toBeLessThanOrEqual(
          RADIUS,
        )
      }
      disposeBackground(b)
    }
  })

  it('street life lands INSIDE the band the default framing crops (critique #7 sev7)', () => {
    // Counts alone can pass while the pixels show empty streets — a wide
    // scatter parks most props beyond the ~110–160-unit strip the default iso
    // frame shows past the board's west/south (up-screen) edges. So a prop
    // only counts when its full bbox (center ± extent) sits inside the
    // west/south near-band rect the default crop sees.
    // Measured with the forced near-seats + capped scatter: 9–11 near
    // walkers and 2–3 near vehicles over 5 seeds — the 6/1 bars keep slack
    // for unmeasured seeds while any drift back to the far spread fails.
    for (const seed of [1, 7, 42, 99, 1234]) {
      const b = buildCityBackground({ hole: HOLE, radius: RADIUS, baseY: BASE_Y, seed, makeMat: recordingMakeMat([]) })
      const life = b.group.userData.streetLife as {
        people: Array<{ x: number; z: number }>
        vehicles: Array<{ x: number; z: number }>
      }
      const minX = HOLE.x - HOLE.w / 2
      const maxX = HOLE.x + HOLE.w / 2
      const minZ = HOLE.z - HOLE.h / 2
      const maxZ = HOLE.z + HOLE.h / 2
      const inBand = (p: { x: number; z: number }, ext: number): boolean => {
        const west = p.x + ext <= minX && p.x - ext >= minX - 160 && p.z - ext >= minZ - 160 && p.z + ext <= maxZ
        const south = p.z + ext <= minZ && p.z - ext >= minZ - 160 && p.x - ext >= minX - 160 && p.x + ext <= maxX
        return west || south
      }
      // extents mirror the builder's upsized silhouettes: walker ≈ ±4
      // (capsule radius ≤ 2.2 + lane jitter), vehicle ≈ ±15 (length ≤ 28)
      const nearPeople = life.people.filter((p) => inBand(p, 4)).length
      const nearVehicles = life.vehicles.filter((p) => inBand(p, 15)).length
      expect(nearPeople, `seed ${seed}: walkers inside the default-frame band`).toBeGreaterThanOrEqual(6)
      expect(nearVehicles, `seed ${seed}: a vehicle inside the default-frame band`).toBeGreaterThanOrEqual(1)
      disposeBackground(b)
    }
  })
})

describe('studio cyclorama', () => {
  it('is one vertex-graded sweep: ≤2 draws, rises from baseY, no shadows', () => {
    const calls: MatCall[] = []
    const b = buildStudioBackground({ radius: 3000, baseY: BASE_Y, makeMat: recordingMakeMat(calls) })
    const meshes = meshesOf(b)
    expect(meshes.length, 'studio draw calls').toBeLessThanOrEqual(2)
    expect(b.drawCalls).toBe(meshes.length)
    const geo = meshes[0].geometry
    const colors = geo.getAttribute('color')
    expect(colors, 'gradient rides vertex colors').toBeTruthy()
    // the warm gradient actually varies bottom → top
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < colors.count; i++) {
      min = Math.min(min, colors.getX(i))
      max = Math.max(max, colors.getX(i))
    }
    expect(max - min).toBeGreaterThan(0.05)
    geo.computeBoundingBox()
    // grounded on the desk but proud by a hair — a coplanar floor lip
    // would z-fight the wood plane
    expect(geo.boundingBox!.min.y).toBeGreaterThanOrEqual(BASE_Y)
    expect(geo.boundingBox!.min.y).toBeLessThanOrEqual(BASE_Y + 2)
    expect(meshes[0].castShadow).toBe(false)
    expect(meshes[0].receiveShadow).toBe(false)
    expect(b.lamp).toBeUndefined()
    disposeBackground(b)
  })
})

describe('brass desk lamp', () => {
  it('builds ≤3 draws, requests brass + emissive roles, aims its spot spec at the board', () => {
    const calls: MatCall[] = []
    const boardCenter: [number, number, number] = [0, 0, 0]
    const b = buildDeskLamp({ position: [900, BASE_Y, 700], boardCenter, makeMat: recordingMakeMat(calls) })
    const meshes = meshesOf(b)
    expect(meshes.length, 'lamp draw calls').toBeLessThanOrEqual(3)
    expect(b.drawCalls).toBe(meshes.length)
    // brass body: high metalness, satin roughness; inner dome: emissive role
    const brassCall = calls.find((c) => c.role === 'decor')
    expect(brassCall?.opts?.metalness).toBeGreaterThanOrEqual(0.8)
    expect(brassCall?.opts?.roughness).toBeLessThanOrEqual(0.5)
    expect(calls.some((c) => c.role === 'decorEmissive')).toBe(true)
    // the hero prop may cast — exactly the brass body, never the glow shell
    expect(meshes.filter((m) => m.castShadow).map((m) => m.userData.bgPart)).toEqual(['lamp-brass'])
    const lamp = b.lamp!
    expect(lamp).toBeTruthy()
    expect(lamp.target).toEqual(boardCenter)
    expect(lamp.angle).toBeCloseTo(0.5, 5)
    expect(lamp.penumbra).toBeCloseTo(0.6, 5)
    expect(lamp.color).toBe('#FFD9A0')
    // the spec sits up in the shade, pouring toward the board: its horizontal
    // bearing matches the base → board bearing
    expect(lamp.position[1]).toBeGreaterThan(BASE_Y + 100)
    const toBoard = new THREE.Vector2(boardCenter[0] - 900, boardCenter[2] - 700).normalize()
    const fromSpec = new THREE.Vector2(
      lamp.target[0] - lamp.position[0],
      lamp.target[2] - lamp.position[2],
    ).normalize()
    expect(toBoard.dot(fromSpec)).toBeGreaterThan(0.9)
    disposeBackground(b)
  })
})

describe('disposeBackground', () => {
  it('disposes every geometry and material exactly once', () => {
    const city = buildCityBackground({
      hole: { x: 0, z: 0, w: 260, h: 180 },
      radius: 700,
      baseY: 0,
      seed: 5,
      makeMat: recordingMakeMat([]),
    })
    const lamp = buildDeskLamp({ position: [300, 0, 260], boardCenter: [0, 40, 0], makeMat: recordingMakeMat([]) })
    for (const build of [city, lamp]) {
      let geoDisposed = 0
      let matDisposed = 0
      const geos = new Set<THREE.BufferGeometry>()
      const mats = new Set<THREE.Material>()
      build.group.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        geos.add(mesh.geometry)
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mats.add(m)
      })
      expect(geos.size).toBeGreaterThan(0)
      for (const g of geos) g.addEventListener('dispose', () => geoDisposed++)
      for (const m of mats) m.addEventListener('dispose', () => matDisposed++)
      disposeBackground(build)
      expect(geoDisposed, 'every geometry disposed').toBe(geos.size)
      expect(matDisposed, 'every material disposed').toBe(mats.size)
    }
  })
})
