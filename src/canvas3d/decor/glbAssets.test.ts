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

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { decodeGlbGeometry, decorAsset, registerDecorAsset } from './glbAssets'
import {
  buildDecorMeshes,
  disposeDecorBuild,
  disposeDecorGeometries,
  FLAG,
  FLAG_HEIGHT,
  LEAF_RADIUS,
  mapleClumpBladeGeoms,
  mapleSingleRadius,
} from './build'
import { DECOR_PACKS, DESK_ARCHETYPES } from './registry'
import { buildCityGeometry, disposeCityGeometry, MONT_ROYAL_GLB_R, MONT_ROYAL_LIT_GAIN } from './backgrounds'
import { FACADE_WATER_UV } from './cityFacade'
import type { PlacedProp } from './placement'
import { CAMERA_PRESETS } from '../presets'

/**
 * The Blender-authored decor (scripts/blender/canadiana_assets.py) as it
 * SHIPS: the committed GLB files are decoded from disk and registered exactly
 * like the browser loader does (geometry; node has no image decoder, so the
 * maps are stand-in textures). Every other decor gate in build.test.ts runs
 * the procedural FALLBACK — this file is what keeps the shipped path from
 * being a witness nobody looks at.
 */

const glb = (name: string): THREE.BufferGeometry => {
  const buf = readFileSync(fileURLToPath(new URL(`./assets/${name}.glb`, import.meta.url)))
  return decodeGlbGeometry(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

const trisOf = (g: THREE.BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3

/** The beaver's incisor enamel in COLOR_0 (linear, as stored): a muted
 * orange-AMBER. #C9782F is (0.58, 0.19, 0.03); the fur's brightest tone
 * (belly #A27248) has r 0.36, the gnawed stick g/r ~0.75. The r < 0.72
 * ceiling rejects r3's neon #E3812B (r 0.77) — loop 4 r5's "saturated
 * orange slabs". */
const isIncisor = (r: number, g: number, b: number): boolean =>
  r > 0.45 && r < 0.72 && g / r > 0.24 && g / r < 0.42 && b < 0.05

/** Pack triangle ceiling once the Blender props ship. Measured 2026-10-08,
 * canadiana (the heaviest pack, one of each archetype): 8 260 procedural →
 * 10 667 with the assets — the flag 564 → 2 116 (a cloth banner needs
 * columns to fold; the procedural one was a furled box) and each blade
 * +45 (an interior lattice so it can cup and curl). The per-archetype 3 500
 * cap is unchanged and is the one bounding a single silhouette.
 *
 * Re-measured 2026-10-08 (loop1 critique fixes): 10 667 → 12 176. The flag
 * 2 116 → 2 960 (a 46 x 21 banner grid for deeper folds; at 34 x 16 the hem
 * kinked and the fly edge stair-stepped) and each blade 189 → 224 (fine
 * marginal teeth + vein-crease constraint edges, with a coarser interior
 * lattice paying for part of it), ×19 blades. Still ~1 % of the 190-280k
 * triangles the measured boards draw (view3d-quality sceneStats); the cap
 * keeps ~3 % headroom over the measurement, as the 11 000 did.
 *
 * Re-measured 2026-10-09 (loop 4, the Blender beaver): 12 176 → 13 710. The
 * beaver 1 160 procedural → 2 694 sculpted (a face, incisors, forepaws and a
 * stick, webbed feet, a scaled tail — the blob's "two spheres and a paddle"
 * was the critique). One instance per desk, ~1 % of a measured board; the cap
 * keeps the same ~3 % headroom.
 *
 * Re-measured 2026-10-09 (loop 4 r2, the Blender moose): 13 710 → 15 922.
 * The moose ~690 procedural → 2 900 sculpted (jointed legs, hooves, a head
 * with a muzzle and a bell, two tapered palmate antlers — "a box body on four
 * stick legs with plank antlers" was the critique). At most two per desk;
 * the cap keeps the same ~3 % headroom.
 *
 * Re-measured 2026-10-09 (loop 4 r3, "faceted, lumpy low-poly shading up
 * close"): 15 922 → 20 324 (measured). The beaver 2 694 → 4 916 and the
 * moose 2 900 → 5 080 (wildlife_assets.py prints both): a smooth low mesh
 * decimated to ~3.0-3.2k body triangles (from 1 200 / 1 820) that carries a
 * normal map BAKED from a fine sculpt, glossy corneas with lid rings and
 * catchlights, longer incisors, tapered moose legs. Still ~2 % of the
 * 190-280k triangles a measured board draws; the cap keeps ~3 % headroom.
 *
 * Re-measured 2026-10-09 (loop 4 r4, "the moose antlers are flat cardboard
 * cut-outs"): 20 324 → 21 104. The moose 5 080 → 5 860: the two 236-triangle
 * solidified outlines became a sculpted volume (beam, burr, a dish of
 * blended ellipsoids, 14 conical tines): 1 540 triangles, cones included
 * (wildlife_assets.py prints it), the body trimmed 3 200 → 3 000 to pay for
 * part of it. Still
 * ~2 % of a measured board; the cap keeps the same ~3 % headroom.
 *
 * Re-measured 2026-10-09 (contact pass, "leaves look like decals"): 21 562 →
 * 21 946. Each blade's drawn contact decal gains one ring (3 → 4, for the
 * plateau-then-smoothstep ramp of LEAF_SHADOW_KNEE): +24 flat triangles per
 * blade × 16 blades in the canadiana pack's leaf archetypes. 22 400 keeps ~2 %
 * headroom over the measurement. */
const PACK_TRIS_MAX = 22_400
/** Per-silhouette cap for the two sculpted animals (the generic per-archetype
 * cap stays 3 500): measured 4 916 / 5 080 as shipped (loop 4 r3), at most
 * two of each per desk — the decimate budget the r3 critique asked for
 * ("about 4.5-5k triangles each"), with ~2 % headroom. Loop 4 r4: the moose
 * 5 860 (the volumetric antlers, PACK_TRIS_MAX above) — 6 000 keeps ~2 %.
 * Loop 4 r5 ("lumpy cauliflower palms"): the moose 5 860 → 6 320 measured —
 * the antlers are now two smooth cupped sheets with eight rim tines each,
 * Catmull-Clark smoothed then decimated to 2 000 triangles (1 500 cut each
 * tine to a few facets, moose-antler.png); 6 450 keeps ~2 %. */
const FAUNA_TRIS_MAX = 6_450

function fakePlacement(ids: string[]): PlacedProp[] {
  return ids.map((id, i) => ({
    propId: `${id}:${i}:0`,
    archetypeId: id,
    x: i * 40,
    z: 0,
    rotY: 0,
    scale: 1,
    onPlatform: false,
    onDesk: false,
  }))
}

describe('Blender decor assets (shipped GLBs)', () => {
  const flag = glb('canada-flag')
  const leaf = glb('maple-leaf')
  const beaver = glb('beaver')
  const moose = glb('moose')

  it('the flag GLB is on the FLAG gabarit: hoist pinned on the pole, foot on the ground, top under FLAG_HEIGHT', () => {
    const pos = flag.getAttribute('position')
    const uv = flag.getAttribute('uv')
    expect(flag.getAttribute('normal')).toBeTruthy()
    expect(flag.getAttribute('color'), 'pole/foot colours ride COLOR_0').toBeTruthy()
    let minY = Infinity
    let maxY = -Infinity
    let hoist = 0
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i))
      maxY = Math.max(maxY, pos.getY(i))
      // banner vertices are the ones whose print u is (near) 0: the hoist
      // column. Each must sit ON the pole surface, at sheet depth 0.
      const onSheet = Math.abs(pos.getZ(i)) < 30 && pos.getY(i) > FLAG.SHEET_Y - FLAG.SHEET_H
      if (onSheet && uv.getX(i) < 1e-4 && pos.getX(i) < FLAG.POLE_R + 1) {
        hoist++
        expect(pos.getX(i), 'hoist pinned to the pole surface').toBeCloseTo(FLAG.POLE_R, 3)
        expect(pos.getZ(i), 'hoist in the pole plane').toBeCloseTo(0, 3)
      }
    }
    expect(hoist, 'the hoist column exists (one vertex per banner row)').toBeGreaterThanOrEqual(17)
    expect(minY, 'the foot stands on y = 0').toBeCloseTo(0, 3)
    expect(maxY, 'finial top within the prop height').toBeLessThanOrEqual(FLAG_HEIGHT + 0.5)
    expect(trisOf(flag), 'per-archetype triangle cap').toBeLessThan(3500)
  })

  it('the leaf GLB: apex toward −Z, single two-sided surface with UVs, cheap', () => {
    const pos = leaf.getAttribute('position')
    expect(leaf.getAttribute('uv'), 'detail + vein maps need UVs').toBeTruthy()
    let apex = { z: Infinity, x: 0 }
    for (let i = 0; i < pos.count; i++) if (pos.getZ(i) < apex.z) apex = { z: pos.getZ(i), x: pos.getX(i) }
    expect(Math.abs(apex.x), 'the crown is on the midrib').toBeLessThan(0.01)
    expect(apex.z, 'crown toward −Z (the engine convention)').toBeLessThan(-0.9)
    expect(trisOf(leaf), 'a blade stays well under a clump budget').toBeLessThan(600)
  })

  it('registered, the blades are rebuilt from the asset — every pack still inside its budgets', () => {
    const map = new THREE.Texture()
    const normalMap = new THREE.Texture()
    registerDecorAsset('canada-flag', { geometry: flag, map, normalMap: null, roughness: 0.62 })
    registerDecorAsset('maple-leaf', { geometry: leaf, map, normalMap, roughness: 0.55 })
    const metalRoughMap = new THREE.Texture()
    registerDecorAsset('beaver', { geometry: beaver, map, normalMap, metalRoughMap, metalness: 1, roughness: 0.8 })
    registerDecorAsset('moose', { geometry: moose, map, normalMap, metalRoughMap, metalness: 1, roughness: 0.8 })
    expect(decorAsset('maple-leaf')).not.toBeNull()
    for (const pack of DECOR_PACKS) {
      // the same contract as build.test.ts's budget gate: the PACK's own
      // archetypes, one of each — under PACK_TRIS_MAX once the assets ship
      const ids = [...new Set(pack.archetypes.map((a) => a.id))]
      const build = buildDecorMeshes(pack, fakePlacement(ids), { lit: true })
      let tris = 0
      build.group.traverse((o) => {
        const m = o as THREE.InstancedMesh
        if (!m.isInstancedMesh) return
        const id = String(m.userData.decorArchetype)
        const t = trisOf(m.geometry)
        tris += t
        expect(t, `${pack.id}/${id} triangle cap`).toBeLessThan(id === 'beaver' || id === 'moose' ? FAUNA_TRIS_MAX : 3500)
        const mat = m.material as THREE.MeshStandardMaterial
        if (id.startsWith('maple-leaf')) {
          expect(m.geometry.getAttribute('uv'), `${id} built from the Blender blade`).toBeTruthy()
          expect(mat.map, `${id} wears the detail map`).toBe(map)
          expect(mat.normalMap, `${id} wears the vein relief`).toBe(normalMap)
          expect(mat.side, `${id} single surface lit on both faces`).toBe(THREE.DoubleSide)
          // seated like the die-cut: nothing under the blade's own contact plane
          const pos = m.geometry.getAttribute('position')
          for (let i = 0; i < pos.count; i++) {
            expect(pos.getY(i), `${id} never below its own seat`).toBeGreaterThan(-1e-3)
          }
        }
        if (id === 'canada-flag') {
          expect(mat.map, 'the flag wears the official print').toBe(map)
          expect(m.geometry, 'the flag IS the asset mesh').toBe(flag)
        }
        if (id === 'beaver') {
          expect(m.geometry, 'the beaver IS the Blender sculpt').toBe(beaver)
          expect(mat.map, 'fur clumps + tail scales').toBe(map)
          expect(mat.normalMap, 'fur + scale relief').toBe(normalMap)
          expect(mat.roughnessMap, 'glossy eyes and nose, matte fur').toBe(metalRoughMap)
          expect(mat.vertexColors, 'the countershade rides COLOR_0').toBe(true)
        }
        if (id === 'moose') {
          expect(m.geometry, 'the moose IS the Blender sculpt').toBe(moose)
          expect(mat.map, 'fur + antler grain').toBe(map)
          expect(mat.normalMap, 'fur + antler relief').toBe(normalMap)
          expect(mat.roughnessMap, 'glossy eyes, satin antlers, matte fur').toBe(metalRoughMap)
          expect(mat.vertexColors, 'the countershade rides COLOR_0').toBe(true)
        }
      })
      expect(tris, `${pack.id} pack triangle budget`).toBeLessThan(PACK_TRIS_MAX)
      disposeDecorBuild(build)
    }
    disposeDecorGeometries()
  })

  it('every lone asset blade stays inside mapleSingleRadius — the footprint contract holds', () => {
    // The blade is normalised so its rotation-safe radius (petiole included)
    // is LEAF_RADIUS per unit size; every board/desk footprint is derived from
    // that number. Measured on each single-blade archetype as it ships, about
    // the archetype origin, in the floor plane (before any instance yaw).
    for (const kind of ['fall', 'fallB', 'mini', 'miniB', 'miniC'] as const) {
      const id = { fall: 'maple-leaf-fall', fallB: 'maple-leaf-fall-b', mini: 'maple-leaf-mini', miniB: 'maple-leaf-mini-b', miniC: 'maple-leaf-mini-c' }[kind]
      const pack = DECOR_PACKS.find((p) => p.archetypes.some((a) => a.id === id)) ?? { ...DECOR_PACKS[0], archetypes: DESK_ARCHETYPES }
      const build = buildDecorMeshes({ ...pack, archetypes: [...pack.archetypes, ...DESK_ARCHETYPES].filter((a) => a.id === id).slice(0, 1) }, fakePlacement([id]), { lit: true })
      let blade: THREE.BufferGeometry | null = null
      build.group.traverse((o) => {
        if ((o as THREE.InstancedMesh).isInstancedMesh) blade = (o as THREE.InstancedMesh).geometry
      })
      expect(blade, `${id} builds`).not.toBeNull()
      const g = blade as unknown as THREE.BufferGeometry
      expect(g.getAttribute('uv'), `${id} is the asset blade`).toBeTruthy()
      const pos = g.getAttribute('position')
      const col = g.getAttribute('color')
      let r = 0
      for (let i = 0; i < pos.count; i++) {
        // the contact decal (alpha < 1) is a shadow, offset by design — only
        // the opaque blade vertices are bounded by the footprint radius
        if (col.itemSize === 4 && col.getW(i) < 0.999) continue
        r = Math.max(r, Math.hypot(pos.getX(i), pos.getZ(i)))
      }
      expect(r, `${id} radius ≤ mapleSingleRadius`).toBeLessThanOrEqual(mapleSingleRadius(kind) * 1.02)
      expect(r, `${id} radius uses its budget (normalised, not shrunk)`).toBeGreaterThan(mapleSingleRadius(kind) * 0.8)
      disposeDecorBuild(build)
    }
    expect(LEAF_RADIUS).toBeGreaterThan(0)
    disposeDecorGeometries()
  })

  // ── regressions from the loop1 critique (2026-10-08) ──────────────────────

  it('the shipped leaf maps carry real data: a flat-on-average normal map, a near-white detail map', () => {
    // The first maple-leaf.glb shipped an ALL-BLACK normal map (Blender
    // regenerated the buffer when the image was switched to Non-Color after
    // its pixels were written). Decoded as (−1, −1, −1) in tangent space it
    // tilted every blade's shading normal, and the blades rendered pale
    // lavender/pink or near-black depending on their yaw — the "wrong tones"
    // the critic reported. Geometry-only gates could never see it.
    const images = glbImages('maple-leaf')
    const normal = images.get('maple-leaf-normal')
    const detail = images.get('maple-leaf-detail')
    expect(normal, 'the leaf ships a normal map').toBeTruthy()
    expect(detail, 'the leaf ships a detail map').toBeTruthy()
    const n = meanRgb(normal!)
    expect(n[0], 'normal map x averages to flat (0.5)').toBeCloseTo(0.5, 1)
    expect(n[1], 'normal map y averages to flat (0.5)').toBeCloseTo(0.5, 1)
    expect(n[2], 'normal map z points out of the surface').toBeGreaterThan(0.95)
    const d = meanRgb(detail!)
    expect(Math.min(...d), 'detail map is near-white (it multiplies the tone)').toBeGreaterThan(0.75)
  })

  it('no textured triangle of the leaf has collapsed UVs (the petiole speckle)', () => {
    // The old petiole sampled ONE texel (constant UV). The engine shades the
    // normal map with screen-space derivative tangents, which divide by the
    // UV gradient: a collapsed UV triangle yields a garbage tangent frame and
    // the speckled red/orange needle the critic saw. Every triangle must map
    // to a UV triangle of real area.
    const pos = leaf.getAttribute('position')
    const uv = leaf.getAttribute('uv')
    const idx = leaf.index!
    let worst = Infinity
    for (let t = 0; t < idx.count; t += 3) {
      const [a, b, c] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)]
      const e1 = new THREE.Vector3().fromBufferAttribute(pos, b).sub(new THREE.Vector3().fromBufferAttribute(pos, a))
      const e2 = new THREE.Vector3().fromBufferAttribute(pos, c).sub(new THREE.Vector3().fromBufferAttribute(pos, a))
      const area = e1.cross(e2).length() / 2
      if (area < 1e-9) continue
      const uvArea =
        Math.abs((uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a)) - (uv.getX(c) - uv.getX(a)) * (uv.getY(b) - uv.getY(a))) / 2
      worst = Math.min(worst, uvArea / area)
    }
    expect(worst, 'smallest UV-area / surface-area ratio over the leaf').toBeGreaterThan(1e-4)
  })

  it('the normal map keeps the scale GLTFLoader gave it (derivative tangents flip y)', () => {
    const map = new THREE.Texture()
    const normalMap = new THREE.Texture()
    registerDecorAsset('maple-leaf', { geometry: leaf, map, normalMap, normalScale: new THREE.Vector2(1, -1), roughness: 0.55 })
    const id = 'maple-leaf-mini'
    const pack = DECOR_PACKS.find((p) => p.archetypes.some((a) => a.id === id))!
    const build = buildDecorMeshes({ ...pack, archetypes: pack.archetypes.filter((a) => a.id === id) }, fakePlacement([id]), { lit: true })
    let mat: THREE.MeshStandardMaterial | null = null
    build.group.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) mat = (o as THREE.InstancedMesh).material as THREE.MeshStandardMaterial
    })
    expect(mat, 'the blade builds').not.toBeNull()
    const m = mat as unknown as THREE.MeshStandardMaterial
    expect(m.normalMap).toBe(normalMap)
    expect(m.normalScale.y, 'veins lit from the right side').toBe(-1)
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('a clump keeps every flag-leaf silhouette whole: each blade is ≤15% covered by its neighbours (view3d quality loop 3)', () => {
    // workbench-leaf.png: "four leaves overlap by roughly 30-40%, so no single
    // complete 11-point silhouette is visible". Measured on the SHIPPED blades
    // (the Blender asset registered, `mapleClumpBladeGeoms` posing them as the
    // clump mesh does), as plan-view coverage: what a blade loses under the
    // others is what the eye loses of its outline.
    registerDecorAsset('maple-leaf', { geometry: leaf, map: new THREE.Texture(), normalMap: null, roughness: 0.55 })
    const report: string[] = []
    let worst = 0
    for (const kind of ['pair', 'pairB', 'drift', 'bank', 'cluster'] as const) {
      const blades = mapleClumpBladeGeoms(kind)
      expect(blades[0].getAttribute('uv'), `${kind}: measured on the asset blade`).toBeTruthy()
      const cov = blades.map((g) => planCells(g, 0.25))
      for (let i = 0; i < cov.length; i++) {
        let over = 0
        for (const c of cov[i]) if (cov.some((o, j) => j !== i && o.has(c))) over++
        const frac = over / cov[i].size
        report.push(`${kind}#${i} ${(frac * 100).toFixed(1)}%`)
        worst = Math.max(worst, frac)
      }
      for (const g of blades) g.dispose()
    }
    expect(report.length, 'every blade of every clump measured').toBe(14)
    expect(worst, `share of a blade under its neighbours — ${report.join(', ')}`).toBeLessThanOrEqual(0.15)
    disposeDecorGeometries()
  })

  it('no blade of a clump is pinned by a neighbour\'s stalk: every petiole lies clear of the other blades (view3d quality loop 3 r2)', () => {
    // workbench-leaf.png / city-leaf.png: "the brown leaf's straight dark stem
    // ends inside the salmon leaf's blade and reads as a pin through it". The
    // petiole is the asset's own UV island (PETIOLE_UV, u < 0.04; the blade
    // maps to u >= 0.08), so the shipped mesh splits into stalk and blade
    // without a copy of the Blender script's numbers. Measured in plan, on the
    // blades exactly as the clump mesh poses them.
    registerDecorAsset('maple-leaf', { geometry: leaf, map: new THREE.Texture(), normalMap: null, roughness: 0.55 })
    const STALK_U = 0.045
    const isStalk = (g: THREE.BufferGeometry, v: number) => g.getAttribute('uv').getX(v) < STALK_U
    const hits: string[] = []
    let stalks = 0
    for (const kind of ['pair', 'pairB', 'drift', 'bank', 'cluster'] as const) {
      const blades = mapleClumpBladeGeoms(kind)
      const stalkCells = blades.map((g) => planCells(g, 0.25, (a, b, c) => isStalk(g, a) && isStalk(g, b) && isStalk(g, c)))
      const bladeCells = blades.map((g) => planCells(g, 0.25, (a, b, c) => !isStalk(g, a) && !isStalk(g, b) && !isStalk(g, c)))
      for (let i = 0; i < blades.length; i++) {
        expect(stalkCells[i].size, `${kind}#${i} has a stalk`).toBeGreaterThan(0)
        stalks++
        for (let j = 0; j < blades.length; j++) {
          if (j === i) continue
          let n = 0
          for (const c of stalkCells[i]) if (bladeCells[j].has(c)) n++
          if (n > 0) hits.push(`${kind}#${i} stalk over #${j} (${n} cells)`)
        }
      }
      for (const g of blades) g.dispose()
    }
    expect(stalks, 'every blade of every clump measured').toBe(14)
    expect(hits, 'stalks lying across a neighbouring blade').toEqual([])
    disposeDecorGeometries()
  })

  it('the blade is not a paper cut-out: lobe points and the stalk end lift off the resting plane (loop 3 r2)', () => {
    // workbench-leaf.png: "the four leaves lie perfectly flat, with no visible
    // curl, no lift and no contact shadow under the tips". Asset units: the
    // apex is 1 leaf height from the petiole junction; y is up (glTF).
    const pos = leaf.getAttribute('position')
    let minY = Infinity
    let apex = { z: Infinity, y: 0 }
    let foot = { z: -Infinity, y: 0 }
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i))
      if (pos.getZ(i) < apex.z) apex = { z: pos.getZ(i), y: pos.getY(i) }
      if (pos.getZ(i) > foot.z) foot = { z: pos.getZ(i), y: pos.getY(i) }
    }
    expect(apex.y - minY, 'the crown point stands off the plane the blade rests on').toBeGreaterThan(0.04)
    expect(foot.y - minY, 'the stalk bends up off the desk').toBeGreaterThan(0.03)
  })

  it('the flag hardware wears metal, the cloth does not (view3d quality loop 3 r2: "a grey plastic toy")', () => {
    // The shipped metallic-roughness map, sampled where each part's UVs point.
    const images = glbImages('canada-flag')
    const mr = images.get('canada-flag-mr')
    expect(mr, 'the flag ships a metallic-roughness map').toBeTruthy()
    const pos = flag.getAttribute('position')
    const uv = flag.getAttribute('uv')
    const texel = (x: number, y: number, ch: number): number => {
      const cx = Math.min(mr!.w - 1, Math.max(0, x))
      const cy = Math.min(mr!.h - 1, Math.max(0, y))
      return mr!.data[(cy * mr!.w + cx) * mr!.channels + ch] / 255
    }
    /** BILINEAR, like the GPU's base level: the banner's top hem sits exactly
     * on the strip/print seam, and a nearest-texel read called a half-metal
     * hem cloth (the first r2 export shipped one). glTF v = 0 is the TOP row. */
    const at = (u: number, v: number): [number, number] => {
      const fx = u * mr!.w - 0.5
      const fy = v * mr!.h - 0.5
      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      const tx = fx - x0
      const ty = fy - y0
      const lerp2 = (ch: number) =>
        (texel(x0, y0, ch) * (1 - tx) + texel(x0 + 1, y0, ch) * tx) * (1 - ty) +
        (texel(x0, y0 + 1, ch) * (1 - tx) + texel(x0 + 1, y0 + 1, ch) * tx) * ty
      return [lerp2(1), lerp2(2)] // [roughness, metalness]
    }
    let pole = 0
    let cloth = 0
    for (let i = 0; i < pos.count; i++) {
      const [rough, metal] = at(uv.getX(i), uv.getY(i))
      // (the banner's hoist column also sits ON the pole surface: it is the
      // print's u = 0 edge, never a hardware texel)
      const onPole =
        Math.abs(Math.hypot(pos.getX(i), pos.getZ(i)) - FLAG.POLE_R) < 0.01 &&
        pos.getY(i) > 10 &&
        pos.getY(i) < FLAG.POLE_TOP &&
        uv.getX(i) > 1e-3
      const onFoot = pos.getY(i) > FLAG.RING_H && pos.getY(i) < FLAG.RING_H + FLAG.BASE_H && Math.hypot(pos.getX(i), pos.getZ(i)) > FLAG.RING_R
      const onCloth = pos.getX(i) > FLAG.POLE_R + 4 && pos.getY(i) > FLAG.SHEET_Y - FLAG.SHEET_H
      if (onPole || onFoot) {
        pole++
        expect(metal, `hardware vertex ${i} is metal`).toBeGreaterThan(0.8)
        expect(rough, `hardware vertex ${i} is brushed, not mirror nor chalk`).toBeGreaterThan(0.25)
        expect(rough).toBeLessThan(0.5)
      } else if (onCloth) {
        cloth++
        expect(metal, `cloth vertex ${i} is a dielectric`).toBeLessThan(0.05)
      }
    }
    expect(pole, 'pole + foot vertices found').toBeGreaterThan(40)
    expect(cloth, 'cloth vertices found').toBeGreaterThan(500)
  })

  it('the flag cloth carries REAL folds: several crests across the fly, deepest toward the free edge (loop 3 r2)', () => {
    // workbench-flag.png: "a single broad S along the top edge… the hoist
    // half is a flat plane". Counted on the shipped banner's mid row: the
    // sign changes of the cloth's depth slope along the fly are its folds.
    const pos = flag.getAttribute('position')
    const uv = flag.getAttribute('uv')
    const row: { u: number; z: number }[] = []
    for (let i = 0; i < pos.count; i++) {
      if (pos.getX(i) < FLAG.POLE_R - 0.01 || pos.getY(i) < FLAG.SHEET_Y - FLAG.SHEET_H) continue
      // glTF v of the banner's mid row (print v ∈ [0.0625, 1] after the flip)
      if (Math.abs(uv.getY(i) - (1 - 0.9375 / 2)) > 0.03) continue
      row.push({ u: uv.getX(i), z: pos.getZ(i) })
    }
    row.sort((a, b) => a.u - b.u)
    const uniq = row.filter((p, k) => k === 0 || p.u - row[k - 1].u > 1e-4)
    expect(uniq.length, 'a mid row of the banner').toBeGreaterThan(30)
    let turns = 0
    for (let k = 2; k < uniq.length; k++) {
      const s0 = uniq[k - 1].z - uniq[k - 2].z
      const s1 = uniq[k].z - uniq[k - 1].z
      if (Math.sign(s0) !== Math.sign(s1) && Math.abs(s1 - s0) > 0.05) turns++
    }
    expect(turns, 'crests + troughs along the fly').toBeGreaterThanOrEqual(5)
    const half = (from: number, to: number) => {
      const zs = uniq.filter((p) => p.u >= from && p.u < to).map((p) => p.z)
      return Math.max(...zs) - Math.min(...zs)
    }
    expect(half(0.5, 1.01), 'the fly half folds deeper than the hoist half').toBeGreaterThan(half(0, 0.5))
    expect(half(0.5, 1.01), 'fly folds ~±0.05 of the width deep').toBeGreaterThan(0.06 * FLAG.SHEET_W)
  })

  it('the flag banner carries baked fold shading, not a flat white COLOR_0', () => {
    // critique: "no fold self-shadowing, so the white band is uniformly lit"
    const pos = flag.getAttribute('position')
    const uv = flag.getAttribute('uv')
    const col = flag.getAttribute('color')
    let lo = Infinity
    let hi = -Infinity
    let banner = 0
    for (let i = 0; i < pos.count; i++) {
      // banner = the sheet's print area (pole/foot/finial sample one white texel at v 0.97)
      if (pos.getY(i) < FLAG.SHEET_Y - FLAG.SHEET_H || pos.getX(i) < FLAG.POLE_R + 2 || uv.getY(i) > 0.96) continue
      banner++
      lo = Math.min(lo, col.getX(i))
      hi = Math.max(hi, col.getX(i))
    }
    expect(banner, 'banner vertices found').toBeGreaterThan(500)
    expect(hi, 'open cloth stays unshaded').toBeGreaterThan(0.95)
    expect(hi - lo, 'fold valleys darken the print').toBeGreaterThan(0.15)
  })

  // ── the desk props (view3d quality loop 4: "the desk is empty, its props
  // are 10-20 px specks, the note a white square with a placeholder '!!!'") ─

  // (+ loop 4 r2's near-field anchors: the notebooks 13.7 tall, the plant
  // 74.6 — desk_assets.py prints both; + loop 4 r3's far-band anchors: the
  // pencil cup 82.5, the books 21.3; + loop 4 r4's gap fillers: the open
  // sketchbook 4.7, the blueprint roll 12.4)
  for (const [name, minH, maxH] of [
    ['desk-mug', 40, 48],
    ['desk-note', 0.3, 5],
    ['desk-notebooks', 10, 16],
    ['desk-plant', 65, 80],
    ['desk-pencil-cup', 75, 88],
    ['desk-books', 17, 25],
    ['desk-sketchbook', 3, 7],
    ['desk-blueprint', 10, 15],
  ] as const) {
    it(`${name}.glb sits on the desk inside its registry footprint, UVs never collapsed`, () => {
      const g = glb(name)
      const pos = g.getAttribute('position')
      expect(g.getAttribute('uv')).toBeTruthy()
      expect(g.getAttribute('color'), 'COLOR_0').toBeTruthy()
      let minY = Infinity
      let maxY = -Infinity
      let r = 0
      for (let i = 0; i < pos.count; i++) {
        minY = Math.min(minY, pos.getY(i))
        maxY = Math.max(maxY, pos.getY(i))
        r = Math.max(r, Math.hypot(pos.getX(i), pos.getZ(i)))
      }
      const footprint = DESK_ARCHETYPES.find((a) => a.id === name)!.footprint
      expect(minY, 'seated on y = 0').toBeCloseTo(0, 3)
      expect(maxY).toBeGreaterThan(minH)
      expect(maxY).toBeLessThan(maxH)
      expect(r, 'rotation-safe radius within the footprint').toBeLessThanOrEqual(footprint)
      expect(r, 'the footprint is honest').toBeGreaterThan(footprint * 0.85)
      expect(trisOf(g)).toBeLessThan(1500)
      const uv = g.getAttribute('uv')
      const idx = g.index!
      let worst = Infinity
      for (let t = 0; t < idx.count; t += 3) {
        const [a, b, c] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)]
        const e1 = new THREE.Vector3().fromBufferAttribute(pos, b).sub(new THREE.Vector3().fromBufferAttribute(pos, a))
        const e2 = new THREE.Vector3().fromBufferAttribute(pos, c).sub(new THREE.Vector3().fromBufferAttribute(pos, a))
        const area = e1.cross(e2).length() / 2
        if (area < 1e-6) continue
        const uvArea = Math.abs((uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a)) - (uv.getX(c) - uv.getX(a)) * (uv.getY(b) - uv.getY(a))) / 2
        worst = Math.min(worst, uvArea / area)
      }
      // world-unit triangles on a 0..1 atlas: ~1e-4 by construction; a
      // collapsed island reads 0
      expect(worst, 'smallest UV-area / surface-area ratio').toBeGreaterThan(5e-6)
    })
  }

  it('the index cards are posed text-up for the default camera, whatever yaw the placement drew', () => {
    // loop4-r1-assets4/workbench-desk-note.png: a free yaw left the writing
    // upside down. The card's text-up axis is local −Z (Blender +Y).
    registerDecorAsset('desk-note', { geometry: glb('desk-note'), map: new THREE.Texture(), normalMap: null, roughness: 0.78 })
    const placed: PlacedProp[] = Array.from({ length: 16 }, (_, i) => ({
      propId: `desk-note:${i}:0`,
      archetypeId: 'desk-note',
      x: i * 80,
      z: 0,
      rotY: (i / 16) * Math.PI * 2,
      scale: 1,
      onPlatform: false,
      onDesk: true,
    }))
    const note = DESK_ARCHETYPES.find((a) => a.id === 'desk-note')!
    const build = buildDecorMeshes({ id: 'x', nameKey: 'x', archetypes: [note] }, placed, { lit: true })
    let mesh: THREE.InstancedMesh | null = null
    build.group.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) mesh = o as THREE.InstancedMesh
    })
    const m = mesh as unknown as THREE.InstancedMesh
    expect((m.material as THREE.MeshStandardMaterial).side, 'the curl shows its back').toBe(THREE.DoubleSide)
    const az = (CAMERA_PRESETS.iso.rz * Math.PI) / 180
    const away = new THREE.Vector3(-Math.sin(az), 0, -Math.cos(az))
    const mat = new THREE.Matrix4()
    let worst = 0
    for (let i = 0; i < placed.length; i++) {
      m.getMatrixAt(i, mat)
      const up = new THREE.Vector3(0, 0, -1).transformDirection(mat)
      worst = Math.max(worst, up.angleTo(away))
    }
    expect(worst, 'text-up within the band of the screen-up direction').toBeLessThanOrEqual(0.45 + 1e-6)
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('a FLAT prop\'s contact blob lies directly under it, footprint-sized — never a detached pool (quality pass "layout")', () => {
    // tp-final-dpr1/workbench-desk-note.png: "the desk note close-up has a
    // large detached dark shadow blob beneath/right of it". The blob math is
    // gated here on the SHIPPED cards (and the other flat desk pieces), at
    // every yaw the band and the placement can draw, in the prop's own frame:
    // the quad's centre within 6 % of the mesh's plan half-extent of the
    // mesh's plan centre, and its plan box covering the mesh's by 1-1.5x a
    // side (the LOW row grows 1.22x). Measured 2026-10-10 on the shipped
    // GLBs: offset ≤ 1.6 % (the throw along the key light, 0.06 x a flat
    // prop's 3.5-12.4 unit height), sides exactly 1.22x — the blob is where
    // it should be, so the dark pool in that close-up was not the note's
    // contact shadow (the run harness's close-up is the visual check). A
    // mutant throwing the blob 3 x the height (≤ 2 radii) reads RED.
    const report: string[] = []
    for (const id of ['desk-note', 'desk-sketchbook', 'desk-blueprint'] as const) {
      registerDecorAsset(id, { geometry: glb(id), map: new THREE.Texture(), normalMap: null, roughness: 0.78 })
      const a = DESK_ARCHETYPES.find((x) => x.id === id)!
      for (let k = 0; k < 16; k++) {
        const placed: PlacedProp[] = [{ propId: `${id}:${k}:0`, archetypeId: id, x: 400, z: -300, rotY: (k / 16) * Math.PI * 2, scale: 1, onPlatform: false, onDesk: true }]
        const build = buildDecorMeshes({ id: 'x', nameKey: 'x', archetypes: [a] }, placed, { lit: true, deskLift: -29.7 })
        // both in the PROP's own frame (a world AABB of a turned card pair is
        // not centred on the cards): the mesh's plan box, and the blob quad
        // carried back through the inverse instance matrix
        const prop = new THREE.Box3()
        const blob = new THREE.Box3()
        const v = new THREE.Vector3()
        const m = new THREE.Matrix4()
        let blobPos: THREE.BufferAttribute | null = null
        let footY = Infinity
        let blobY = -Infinity
        build.group.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
          if ((o as THREE.InstancedMesh).isInstancedMesh) {
            ;(o as THREE.InstancedMesh).getMatrixAt(0, m)
            for (let i = 0; i < pos.count; i++) {
              prop.expandByPoint(v.fromBufferAttribute(pos, i))
              footY = Math.min(footY, v.applyMatrix4(m).y)
            }
          } else blobPos = pos
        })
        const inv = m.clone().invert()
        const bp = blobPos as THREE.BufferAttribute | null
        for (let i = 0; bp && i < bp.count; i++) {
          v.fromBufferAttribute(bp, i)
          blobY = Math.max(blobY, v.y)
          v.y = footY // carried back at the foot's height, so the plane maps onto the prop's base
          blob.expandByPoint(v.applyMatrix4(inv))
        }
        const half = Math.max(prop.max.x - prop.min.x, prop.max.z - prop.min.z) / 2
        const off = Math.hypot((blob.min.x + blob.max.x) / 2 - (prop.min.x + prop.max.x) / 2, (blob.min.z + blob.max.z) / 2 - (prop.min.z + prop.max.z) / 2)
        const sx = (blob.max.x - blob.min.x) / (prop.max.x - prop.min.x)
        const sz = (blob.max.z - blob.min.z) / (prop.max.z - prop.min.z)
        if (blob.isEmpty() || off > 0.06 * half || sx < 1 || sz < 1 || sx > 1.5 || sz > 1.5) {
          report.push(`${id} yaw ${k}: offset ${off.toFixed(1)} of ${half.toFixed(1)}, sides ${sx.toFixed(2)} x ${sz.toFixed(2)}`)
        }
        // …and UNDER it: below the prop's lowest point
        if (blobY > footY) report.push(`${id} yaw ${k}: blob at ${blobY.toFixed(2)} over the prop's foot ${footY.toFixed(2)}`)
        disposeDecorBuild(build)
      }
    }
    expect(report).toEqual([])
    disposeDecorGeometries()
  })

  it('the mug wears the OFFICIAL leaf in flag red on BOTH sides, printed crisp, and the note carries ink — not "!!!"', () => {
    const print = glbImages('desk-mug').get('desk-mug-print')!
    const isRed = (x: number, y: number): boolean => {
      const o = (Math.min(print.h - 1, Math.max(0, Math.floor(y))) * print.w + Math.min(print.w - 1, Math.max(0, Math.floor(x)))) * print.channels
      return print.data[o] > 180 && print.data[o + 1] < 80 && print.data[o + 2] < 70
    }
    let red = 0
    for (let y = 0; y < print.h; y++) for (let x = 0; x < print.w; x++) if (isRed(x, y)) red++
    // Quality pass "mug" (critic: "the maple decal is blurry/low-res"): both
    // printed patches now share ONE leaf island of a 512 x 512 map. Measured
    // 2026-10-09 as shipped: 14.0 % of the print is leaf red (the old
    // whole-wall wrap: 4.2 % of 512 x 256, two leaves); 0 without the decal.
    const share = red / (print.w * print.h)
    expect(share, 'the leaf on the print').toBeGreaterThan(0.1)
    expect(share).toBeLessThan(0.2)
    // …and the MESH prints it twice, opposite each other, away from the
    // handle (+X): sample every triangle on a barycentric grid, look the
    // print up (glTF uv: v down, row 0 = top) and keep the red samples
    const g = glb('desk-mug')
    const pos = g.getAttribute('position')
    const uv = g.getAttribute('uv')
    const idx = g.index!
    // the axis: the foot ring is centred on it
    let ax = 0
    let az = 0
    let nFoot = 0
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0.01) continue
      ax += pos.getX(i)
      az += pos.getZ(i)
      nFoot++
    }
    ax /= nFoot
    az /= nFoot
    const sides = { pos: 0, neg: 0 }
    let maxOffAxisX = 0
    let minDensity = Infinity
    const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    const T = [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()]
    const N = 8
    for (let t = 0; t < idx.count; t += 3) {
      for (let k = 0; k < 3; k++) {
        P[k].set(pos.getX(idx.getX(t + k)), pos.getY(idx.getX(t + k)), pos.getZ(idx.getX(t + k)))
        T[k].set(uv.getX(idx.getX(t + k)), uv.getY(idx.getX(t + k)))
      }
      let hits = 0
      for (let i = 0; i <= N; i++) {
        for (let j = 0; i + j <= N; j++) {
          const [a, b] = [i / N, j / N]
          const c = 1 - a - b
          const u = T[0].x * a + T[1].x * b + T[2].x * c
          const v = T[0].y * a + T[1].y * b + T[2].y * c
          if (!isRed(u * print.w, v * print.h)) continue
          hits++
          const x = P[0].x * a + P[1].x * b + P[2].x * c - ax
          const z = P[0].z * a + P[1].z * b + P[2].z * c - az
          if (z > 0) sides.pos++
          else sides.neg++
          maxOffAxisX = Math.max(maxOffAxisX, Math.abs(x))
        }
      }
      if (!hits) continue
      // texels per world unit on a printed triangle (square texels assumed)
      const area = new THREE.Vector3().subVectors(P[1], P[0]).cross(new THREE.Vector3().subVectors(P[2], P[0])).length() / 2
      const uvArea = Math.abs((T[1].x - T[0].x) * (T[2].y - T[0].y) - (T[2].x - T[0].x) * (T[1].y - T[0].y)) / 2
      minDensity = Math.min(minDensity, Math.sqrt((uvArea * print.w * print.h) / area))
    }
    expect(sides.pos, 'a leaf on one side').toBeGreaterThan(100)
    expect(sides.neg, 'a leaf on the other').toBeGreaterThan(100)
    expect(sides.pos / sides.neg, 'the same leaf on both sides').toBeGreaterThan(0.8)
    expect(sides.pos / sides.neg).toBeLessThan(1.25)
    // the patches span 45-135 and 225-315 deg: never on the handle's side
    expect(maxOffAxisX, 'no print toward the handle').toBeLessThan(0.75 * 19)
    // CRISP: measured 15.2 texels per world unit on the print (the old
    // whole-wall wrap, run through this same test: 4.2 — red here; the
    // harness close-up frames the mug at ~18 px per unit)
    expect(minDensity, 'texels per world unit on the printed patch').toBeGreaterThan(12)
    const note = glbImages('desk-note').get('desk-note-print')!
    let inkPx = 0
    for (let i = 0; i < note.w * note.h; i++) {
      const r = note.data[i * note.channels]
      const b = note.data[i * note.channels + 2]
      if (b > r + 40 && r < 120) inkPx++
    }
    // measured 2026-10-09 as shipped: 2.6 % of the card print is blue ink
    expect(inkPx / (note.w * note.h), 'handwriting + sketch in blue ink').toBeGreaterThan(0.015)
  })

  // ── the beaver (view3d quality loop 4: "a two-sphere blob with a paddle:
  // no face, legs, incisors or fur") ───────────────────────────────────────

  it('the beaver GLB sits on the desk inside its footprint, faces +X, and stays a prop-sized mesh', () => {
    const pos = beaver.getAttribute('position')
    expect(beaver.getAttribute('normal')).toBeTruthy()
    expect(beaver.getAttribute('uv'), 'detail + normal maps need UVs').toBeTruthy()
    let minY = Infinity
    let maxY = -Infinity
    let r = 0
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i))
      maxY = Math.max(maxY, pos.getY(i))
      r = Math.max(r, Math.hypot(pos.getX(i), pos.getZ(i)))
    }
    const footprint = DESK_ARCHETYPES.find((a) => a.id === 'beaver')!.footprint
    expect(minY, 'seated on y = 0').toBeCloseTo(0, 3)
    // sitting UP (the iso camera reads a silhouette, not a back): 34.0 tall
    // (loop 4 r3; 33.1 at r1)
    // as exported vs the procedural blob's 18.2
    expect(maxY, 'a sitting beaver, not a lump').toBeGreaterThan(28)
    expect(maxY).toBeLessThan(40)
    expect(r, 'rotation-safe radius within the registry footprint').toBeLessThanOrEqual(footprint)
    expect(r, 'the footprint is honest (not padded)').toBeGreaterThan(footprint * 0.85)
    // facing: the head (top fifth) is forward of the origin, the tail (the
    // rearmost vertex) lies low on the desk behind — the procedural
    // convention, head at +X
    let headX = 0
    let headN = 0
    let rear = { x: Infinity, y: 0 }
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > maxY * 0.8) {
        headX += pos.getX(i)
        headN++
      }
      if (pos.getX(i) < rear.x) rear = { x: pos.getX(i), y: pos.getY(i) }
    }
    expect(headX / headN, 'the head is forward (+X)').toBeGreaterThan(3)
    expect(rear.x, 'the tail reaches back (−X)').toBeLessThan(-15)
    expect(rear.y, 'the tail lies on the desk').toBeLessThan(maxY * 0.25)
    expect(trisOf(beaver), 'a prop, not a hero sculpt (loop 4 r3 budget ~5k)').toBeLessThan(FAUNA_TRIS_MAX)
  })

  it('the beaver carries its face, its orange incisors and a fur countershade in COLOR_0', () => {
    // A blob has ONE colour. The sculpt must carry: near-black (eyes, nose),
    // the incisors' orange, a dark back and a lighter belly/muzzle.
    const col = beaver.getAttribute('color')
    expect(col, 'COLOR_0').toBeTruthy()
    const c = new THREE.Color()
    let nearBlack = 0
    let orange = 0
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < col.count; i++) {
      c.setRGB(col.getX(i), col.getY(i), col.getZ(i)) // linear, as stored
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
      if (lum < 0.012) nearBlack++
      // the incisors: amber enamel (see isIncisor)
      if (isIncisor(c.r, c.g, c.b)) orange++
      // fur = warm brown, red over blue by a margin
      if (c.r > c.b * 2 && c.r > 0.02 && c.r < 0.6) {
        lo = Math.min(lo, lum)
        hi = Math.max(hi, lum)
      }
    }
    expect(nearBlack, 'eyes + nose').toBeGreaterThan(20)
    expect(orange, 'the incisors').toBeGreaterThan(8)
    expect(hi / lo, 'dark back vs light belly (countershade)').toBeGreaterThan(2)
  })

  it('the beaver maps carry real data and no textured triangle has collapsed UVs', () => {
    const images = glbImages('beaver')
    const normal = images.get('beaver-normal')
    const detail = images.get('beaver-detail')
    const mr = images.get('beaver-mr')
    expect(normal && detail && mr, 'normal + detail + metal-rough maps ship').toBeTruthy()
    for (const img of [normal!, detail!, mr!]) expect(img.w, 'small shared textures').toBeLessThanOrEqual(512)
    const n = meanRgb(normal!)
    expect(n[0], 'normal map x averages to flat').toBeCloseTo(0.5, 1)
    expect(n[1], 'normal map y averages to flat').toBeCloseTo(0.5, 1)
    expect(n[2], 'normal map z points out').toBeGreaterThan(0.9)
    expect(Math.min(...meanRgb(detail!)), 'detail map is a near-white multiplier').toBeGreaterThan(0.75)
    // roughness (G) spans glossy eyes/nose to matte fur; metalness (B) is 0
    let gMin = 255
    let gMax = 0
    let bMax = 0
    for (let i = 0; i < mr!.w * mr!.h; i++) {
      gMin = Math.min(gMin, mr!.data[i * mr!.channels + 1])
      gMax = Math.max(gMax, mr!.data[i * mr!.channels + 1])
      bMax = Math.max(bMax, mr!.data[i * mr!.channels + 2])
    }
    expect(gMin / 255, 'glossy eyes and nose').toBeLessThan(0.3)
    expect(gMax / 255, 'matte fur').toBeGreaterThan(0.75)
    expect(bMax, 'a dielectric animal').toBe(0)
    // the leaf's petiole lesson: derivative tangents divide by the UV gradient
    const pos = beaver.getAttribute('position')
    const uv = beaver.getAttribute('uv')
    const idx = beaver.index!
    let worst = Infinity
    for (let t = 0; t < idx.count; t += 3) {
      const [a, b, cc] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)]
      const e1 = new THREE.Vector3().fromBufferAttribute(pos, b).sub(new THREE.Vector3().fromBufferAttribute(pos, a))
      const e2 = new THREE.Vector3().fromBufferAttribute(pos, cc).sub(new THREE.Vector3().fromBufferAttribute(pos, a))
      const area = e1.cross(e2).length() / 2
      if (area < 1e-6) continue
      const uvArea =
        Math.abs((uv.getX(b) - uv.getX(a)) * (uv.getY(cc) - uv.getY(a)) - (uv.getX(cc) - uv.getX(a)) * (uv.getY(b) - uv.getY(a))) / 2
      worst = Math.min(worst, uvArea / area)
    }
    // measured 2026-10-09: 4.7e-5 as shipped (world-unit triangles on a
    // 0..1 atlas, so the scale is ~1e-4 by construction), and exactly 0 on
    // the first export, whose planar-projected incisors had side faces
    // mapped to a UV line. The bar sits a decade under the measurement.
    expect(worst, 'smallest UV-area / surface-area ratio over the beaver').toBeGreaterThan(5e-6)
  })

  // ── loop 4 r3: "the eyes are flat black bumps with no catchlight or lid,
  // the incisors an orange sliver; the moose legs are pipe-thin, of even
  // width, with no knee or hock" (city-beaver.png, workbench-moose.png) ──

  it('both animals carry a white catchlight on each eye (loop 4 r3)', () => {
    // a near-white bead seated on each glossy cornea, toward the key light;
    // nothing else on either animal is that bright (the gnawed stick ends
    // are linear lum ~0.66, the pale antler tips ~0.33)
    for (const [name, g] of [['beaver', beaver], ['moose', moose]] as const) {
      const pos = g.getAttribute('position')
      const col = g.getAttribute('color')
      const sides = new Set<number>()
      let n = 0
      for (let i = 0; i < col.count; i++) {
        if (lumOf(col, i) < 0.9) continue
        n++
        sides.add(Math.sign(pos.getZ(i)))
      }
      expect(n, `${name}: catchlight vertices`).toBeGreaterThan(12)
      expect([...sides].sort(), `${name}: one catchlight per eye, both sides of the head`).toEqual([-1, 1])
    }
  })

  it('the beaver incisors are a short, separated amber pair — not a sliver, not slabs (loop 4 r3, r5)', () => {
    // History of the orange vertices' vertical span: 3.0 on the r2 export
    // (the "orange sliver"), 4.4 on r3 — which loop 4 r5 judged "two long
    // saturated-orange slabs" (workbench-beaver.png). A beaver shows two
    // SHORT, narrow chisel teeth just under the lip: r5 measures 2.0 in all
    // (~1.1 visible under the lip, the rest seated in it), two 0.62-wide
    // teeth with a 0.3 gap, muted amber (#C9782F) instead of #E3812B.
    const pos = beaver.getAttribute('position')
    const col = beaver.getAttribute('color')
    let y0 = Infinity
    let y1 = -Infinity
    let w0 = Infinity
    let w1 = -Infinity
    let gap = Infinity
    for (let i = 0; i < col.count; i++) {
      if (!isIncisor(col.getX(i), col.getY(i), col.getZ(i))) continue
      y0 = Math.min(y0, pos.getY(i))
      y1 = Math.max(y1, pos.getY(i))
      w0 = Math.min(w0, pos.getZ(i))
      w1 = Math.max(w1, pos.getZ(i))
      gap = Math.min(gap, Math.abs(pos.getZ(i)))
    }
    expect(y1 - y0, 'incisor length: readable').toBeGreaterThan(1.4)
    expect(y1 - y0, 'incisor length: short teeth, not slabs').toBeLessThan(3)
    expect(w1 - w0, 'two narrow teeth side by side').toBeGreaterThan(1.2)
    expect(w1 - w0, '…not a plank across the snout').toBeLessThan(2.2)
    expect(w0, 'one tooth each side').toBeLessThan(0)
    expect(w1).toBeGreaterThan(0)
    expect(gap, 'slightly separated: no enamel on the midline').toBeGreaterThan(0.08)
  })

  it('the moose legs taper: a muscled forearm over a slim cannon bone (loop 4 r3)', () => {
    // front legs only (x > 0 after the plan-box re-centre; the muzzle hangs
    // far above): the fore-aft width of each leg at the cannon (y 6-10)
    // against the forearm under the elbow (y 17-21). Measured as exported:
    // the r2 pipes were ~0.7 by construction (a r 1.15 cannon under a r 1.65
    // forearm); r3 measures 1.68 / 3.60 = 0.47
    // Measured on the SURFACE (triangle edges cut by the plane y = h), not
    // on vertices: a straight cannon bone decimates to a few long triangles
    // with no vertex at mid-height at all.
    const pos = moose.getAttribute('position')
    const idx = moose.index!
    for (const side of [-1, 1]) {
      const span = (h: number) => {
        let a = Infinity
        let b = -Infinity
        for (let t = 0; t < idx.count; t += 3) {
          for (let k = 0; k < 3; k++) {
            const p = idx.getX(t + k)
            const q = idx.getX(t + ((k + 1) % 3))
            const yp = pos.getY(p)
            const yq = pos.getY(q)
            if ((yp - h) * (yq - h) > 0 || yp === yq) continue
            const f = (h - yp) / (yq - yp)
            const x = pos.getX(p) + f * (pos.getX(q) - pos.getX(p))
            const z = pos.getZ(p) + f * (pos.getZ(q) - pos.getZ(p))
            if (x <= 0 || Math.sign(z) !== side) continue
            a = Math.min(a, x)
            b = Math.max(b, x)
          }
        }
        return b - a
      }
      const cannon = span(8)
      const forearm = span(19)
      expect(cannon, `side ${side}: a cannon bone`).toBeGreaterThan(1)
      expect(cannon / forearm, `side ${side}: cannon ${cannon.toFixed(2)} vs forearm ${forearm.toFixed(2)}`).toBeLessThan(0.55)
    }
  })

  it('the fauna normal maps ship at 512 px, the detail and finish maps at 256 (loop 4 r3)', () => {
    // The 512-px normal map carries the sculpt BAKED onto the low mesh
    // (wildlife_assets.py asserts the bake wrote texels and saves it beside
    // the previews). What this file can pin is the split: the bake needs the
    // texels, the low-frequency detail / roughness maps do not — keeping
    // those at 256 holds each GLB near 0.5 MB (r2: ~0.26 MB at 256 x 3).
    // (A "bent 16-px block" detector was tried here and dropped: the bake's
    // low-frequency signal is small BY DESIGN — the low mesh follows the
    // sculpt — and it read 3.3 % / 2.1 % of blocks, too close to a stroke
    // field's noise to tell the two apart.)
    for (const name of ['beaver', 'moose']) {
      const images = glbImages(name)
      expect(images.get(`${name}-normal`)!.w, `${name}: the normal map resolution`).toBe(512)
      expect(images.get(`${name}-detail`)!.w, `${name}: the detail map resolution`).toBe(256)
      expect(images.get(`${name}-mr`)!.w, `${name}: the metal-rough map resolution`).toBe(256)
    }
  })

  // ── the moose (view3d quality loop 4 r2: "a blocky toy: box body, box
  // head, four stick legs, flat plank antlers") ─────────────────────────────

  const mooseArch = DECOR_PACKS.flatMap((p) => p.archetypes).find((a) => a.id === 'moose')!
  const lumOf = (col: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number) =>
    0.2126 * col.getX(i) + 0.7152 * col.getY(i) + 0.0722 * col.getZ(i) // linear, as stored

  it('the moose GLB stands on the desk inside its footprint, faces +X, and spreads its antlers wider than its head', () => {
    const pos = moose.getAttribute('position')
    expect(moose.getAttribute('normal')).toBeTruthy()
    expect(moose.getAttribute('uv'), 'detail + normal maps need UVs').toBeTruthy()
    let minY = Infinity
    let maxY = -Infinity
    let r = 0
    let nose = { x: -Infinity, y: 0, z: 0 }
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i))
      maxY = Math.max(maxY, pos.getY(i))
      r = Math.max(r, Math.hypot(pos.getX(i), pos.getZ(i)))
      if (pos.getX(i) > nose.x) nose = { x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) }
    }
    expect(minY, 'standing on y = 0 (hooves cut flat)').toBeCloseTo(0, 3)
    // 64.1 as exported (wildlife_assets.py prints it; 58.1 before loop 4 r4
    // carried the head 2 higher and the antlers as volumes). The registry
    // `height` and the city-scale gate (placement.test.ts) keep the
    // procedural fallback's 64.6, the taller of the two — the GLB must never
    // exceed it
    expect(maxY, 'a standing bull, legs and antlers').toBeGreaterThan(50)
    expect(maxY, 'never taller than the height the city scale was measured on').toBeLessThanOrEqual(mooseArch.height!)
    expect(r, 'rotation-safe radius within the registry footprint').toBeLessThanOrEqual(mooseArch.footprint)
    expect(r, 'the footprint is honest (not padded)').toBeGreaterThan(mooseArch.footprint * 0.85)
    // facing +X: the frontmost point is the drooping MUZZLE on the midline,
    // below the antlers and well off the desk — not an antler tip
    expect(Math.abs(nose.z), 'the nose is on the midline').toBeLessThan(2)
    expect(nose.y, 'the muzzle hangs below the withers').toBeLessThan(maxY * 0.75)
    expect(nose.y, '…and above the knees').toBeGreaterThan(maxY * 0.45)
    // the antlers: the crown (top 15 %) spreads far wider than the muzzle
    let crown = 0
    let crownX = 0
    let crownN = 0
    let muzzle = 0
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > maxY * 0.85) {
        crown = Math.max(crown, Math.abs(pos.getZ(i)))
        crownX += pos.getX(i)
        crownN++
      }
      if (pos.getX(i) > nose.x - 6) muzzle = Math.max(muzzle, Math.abs(pos.getZ(i)))
    }
    expect(crown * 2, `antler span ${(crown * 2).toFixed(1)} vs muzzle width ${(muzzle * 2).toFixed(1)}`).toBeGreaterThan(muzzle * 2 * 4)
    expect(crownX / crownN, 'the antlers ride the head, forward of the middle').toBeGreaterThan(5)
    // four legs: under the belly the plan splits into the four quadrants
    const quad = new Set<string>()
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 10) continue
      quad.add(`${Math.sign(pos.getX(i))}${Math.sign(pos.getZ(i))}`)
    }
    expect([...quad].sort(), 'a leg in each quadrant').toEqual(['-1-1', '-11', '1-1', '11'])
    expect(trisOf(moose), 'a prop, not a hero sculpt (loop 4 r4 budget ~5.8k)').toBeLessThan(FAUNA_TRIS_MAX)
  })

  it('the moose carries dark hooves, pale stockings under a dark coat, and lighter antlers in COLOR_0', () => {
    const pos = moose.getAttribute('position')
    const col = moose.getAttribute('color')
    expect(col, 'COLOR_0').toBeTruthy()
    let maxY = 0
    for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i))
    const band = (lo: number, hi: number, keep: (i: number) => boolean = () => true) => {
      let s = 0
      let n = 0
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) < lo || pos.getY(i) > hi || !keep(i)) continue
        s += lumOf(col, i)
        n++
      }
      expect(n, `vertices in ${lo}..${hi}`).toBeGreaterThan(8)
      return s / n
    }
    // the sole band only: the pale pastern's capsule reaches down to y ≈ 0.6
    const hooves = band(0, 0.5)
    const stockings = band(4, 10)
    const coat = band(26, 40)
    const antlers = band(maxY * 0.88, maxY)
    expect(hooves, 'near-black hooves').toBeLessThan(0.02)
    expect(stockings / coat, 'the pale stockings under the dark coat').toBeGreaterThan(2)
    expect(antlers / coat, 'antler bone reads against the coat').toBeGreaterThan(2)
    // …but stays a mid tone: a pale palm melted into the desk wood (the
    // procedural #B99C71 lesson) — linear luminance of #B59C70 is ~0.33
    expect(antlers, 'never bleached').toBeLessThan(0.3)
  })

  it('the moose maps carry real data and no textured triangle has collapsed UVs', () => {
    const images = glbImages('moose')
    const normal = images.get('moose-normal')
    const detail = images.get('moose-detail')
    const mr = images.get('moose-mr')
    expect(normal && detail && mr, 'normal + detail + metal-rough maps ship').toBeTruthy()
    for (const img of [normal!, detail!, mr!]) expect(img.w, 'small shared textures').toBeLessThanOrEqual(512)
    const n = meanRgb(normal!)
    expect(n[0], 'normal map x averages to flat').toBeCloseTo(0.5, 1)
    expect(n[1], 'normal map y averages to flat').toBeCloseTo(0.5, 1)
    expect(n[2], 'normal map z points out').toBeGreaterThan(0.9)
    expect(Math.min(...meanRgb(detail!)), 'detail map is a near-white multiplier').toBeGreaterThan(0.75)
    let bMax = 0
    let gMin = 255
    for (let i = 0; i < mr!.w * mr!.h; i++) {
      gMin = Math.min(gMin, mr!.data[i * mr!.channels + 1])
      bMax = Math.max(bMax, mr!.data[i * mr!.channels + 2])
    }
    expect(gMin / 255, 'glossy eyes and nostrils').toBeLessThan(0.3)
    expect(bMax, 'a dielectric animal').toBe(0)
    const pos = moose.getAttribute('position')
    const uv = moose.getAttribute('uv')
    const idx = moose.index!
    let worst = Infinity
    for (let t = 0; t < idx.count; t += 3) {
      const [a, b, cc] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)]
      const e1 = new THREE.Vector3().fromBufferAttribute(pos, b).sub(new THREE.Vector3().fromBufferAttribute(pos, a))
      const e2 = new THREE.Vector3().fromBufferAttribute(pos, cc).sub(new THREE.Vector3().fromBufferAttribute(pos, a))
      const area = e1.cross(e2).length() / 2
      if (area < 1e-6) continue
      const uvArea =
        Math.abs((uv.getX(b) - uv.getX(a)) * (uv.getY(cc) - uv.getY(a)) - (uv.getX(cc) - uv.getX(a)) * (uv.getY(b) - uv.getY(a))) / 2
      worst = Math.min(worst, uvArea / area)
    }
    expect(worst, 'smallest UV-area / surface-area ratio over the moose').toBeGreaterThan(5e-6)
  })

  it('the moose antlers are SOLID palms, not cardboard: the dish is at least 0.08 of its width thick (loop 4 r4)', () => {
    // city-moose.png / workbench-moose.png (loop 4 r4): "flat cardboard
    // cut-outs: the near palm lies back along the neck like a wing or a
    // saddle, the far one a flat disc with a sawtooth rim". The r2/r3 palm
    // was a 2-D outline solidified 0.5-1.6 units over a ~19-unit span, so
    // any camera near its plane saw a plank. r4 sculpted each antler as a
    // metaball volume (judged "lumpy cauliflower" in r5); since loop 4 r5
    // wildlife_assets.py builds a smooth cupped lens-thick SHEET (~1/8 of
    // the palm's width thick, rounded to the rim) with rim tines, and
    // asserts its own thickness samples at export; THIS gate reads the
    // shipped mesh. (r5's first sheet, rounded over 1.15 units, measured
    // p10 0.88 over 13.3 — 0.066, red; the shipped one rounds over 0.7.)
    //
    // Per antler (the triangles UV'd into the atlas's antler slot, one side
    // of the midline): the palm's axes by PCA (largest = out along the palm,
    // smallest = its face normal), the faces of the plate (normal within 40°
    // of that axis, centroid in the middle 70 % of the palm on both in-plane
    // axes — the dish, not the beam or the rim tines), and for each a ray
    // from its centroid INTO the mesh to the nearest other antler face that
    // it EXITS through (that face looks along the ray: a through-the-plate
    // pair, not a chord grazing the rounded rim) — the local thickness.
    // Robust minimum: the 10th percentile, over the palm's width along the
    // middle axis. Measured 2026-10-09: the r3 plank 0.063 (red), the r4
    // sculpt 0.109 (p10 1.45, median 1.79 over a 13.3 width).
    const pos = moose.getAttribute('position')
    const uv = moose.getAttribute('uv')
    const idx = moose.index!
    const inSlot = (i: number) => uv.getX(i) > 0.52 - 1e-3 && uv.getX(i) < 0.98 + 1e-3 && uv.getY(i) > 0.02 - 1e-3 && uv.getY(i) < 0.56 + 1e-3
    const V = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, i)
    const report: string[] = []
    for (const side of [-1, 1]) {
      const tris: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = []
      const verts = new Map<number, THREE.Vector3>()
      for (let t = 0; t < idx.count; t += 3) {
        const ids = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)]
        if (!ids.every(inSlot)) continue
        const tri = ids.map(V) as [THREE.Vector3, THREE.Vector3, THREE.Vector3]
        if (Math.sign(tri[0].z + tri[1].z + tri[2].z) !== side) continue
        tris.push(tri)
        ids.forEach((i, k) => verts.set(i, tri[k]))
      }
      expect(tris.length, `side ${side}: antler triangles in the antler slot`).toBeGreaterThan(200)
      const pts = [...verts.values()]
      const mean = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length)
      const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0]
      for (const p of pts) {
        const d = [p.x - mean.x, p.y - mean.y, p.z - mean.z]
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r * 3 + c] += d[r] * d[c]
      }
      const mul = (v: THREE.Vector3) =>
        new THREE.Vector3(
          cov[0] * v.x + cov[1] * v.y + cov[2] * v.z,
          cov[3] * v.x + cov[4] * v.y + cov[5] * v.z,
          cov[6] * v.x + cov[7] * v.y + cov[8] * v.z,
        )
      const power = (start: THREE.Vector3, ortho: THREE.Vector3[]) => {
        let v = start.clone().normalize()
        for (let k = 0; k < 200; k++) {
          v = mul(v)
          for (const o of ortho) v.addScaledVector(o, -v.dot(o))
          v.normalize()
        }
        return v
      }
      const e1 = power(new THREE.Vector3(0.3, 0.2, 1), [])
      const e2 = power(new THREE.Vector3(1, 0.4, 0.1), [e1])
      const e3 = new THREE.Vector3().crossVectors(e1, e2).normalize()
      const span = (e: THREE.Vector3) => {
        let lo = Infinity
        let hi = -Infinity
        for (const p of pts) {
          lo = Math.min(lo, p.dot(e))
          hi = Math.max(hi, p.dot(e))
        }
        return [lo, hi] as const
      }
      const [w0, w1] = span(e2)
      const [l0, l1] = span(e1)
      const width = w1 - w0
      const central = (c: THREE.Vector3) => {
        const a = (c.dot(e1) - l0) / (l1 - l0)
        const b = (c.dot(e2) - w0) / (w1 - w0)
        return a > 0.15 && a < 0.85 && b > 0.15 && b < 0.85
      }
      const faceNormal = ([a, b, c]: [THREE.Vector3, THREE.Vector3, THREE.Vector3]) =>
        new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(b, a), new THREE.Vector3().subVectors(c, a)).normalize()
      // Möller–Trumbore: the nearest hit past `eps` on a face the ray EXITS
      // through (its outward normal looks along the ray)
      const hit = (o: THREE.Vector3, d: THREE.Vector3, skip: number) => {
        let best = Infinity
        const e1v = new THREE.Vector3()
        const e2v = new THREE.Vector3()
        const p = new THREE.Vector3()
        const q = new THREE.Vector3()
        const s = new THREE.Vector3()
        for (let k = 0; k < tris.length; k++) {
          if (k === skip) continue
          const [a, b, c] = tris[k]
          e1v.subVectors(b, a)
          e2v.subVectors(c, a)
          p.crossVectors(d, e2v)
          const det = e1v.dot(p)
          if (Math.abs(det) < 1e-9) continue
          s.subVectors(o, a)
          const u = s.dot(p) / det
          if (u < 0 || u > 1) continue
          q.crossVectors(s, e1v)
          const v = d.dot(q) / det
          if (v < 0 || u + v > 1) continue
          const t = e2v.dot(q) / det
          if (t > 1e-3 && t < best) {
            best = t
            exits = faceNormal(tris[k]).dot(d) > 0.5
          }
        }
        return exits ? best : Infinity
      }
      let exits = false
      const thick: number[] = []
      tris.forEach((tri, k) => {
        const [a, b, c] = tri
        if (new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(b, a), new THREE.Vector3().subVectors(c, a)).lengthSq() < 1e-12) return
        const n = faceNormal(tri)
        if (Math.abs(n.dot(e3)) < Math.cos((40 * Math.PI) / 180)) return
        const centroid = new THREE.Vector3().add(a).add(b).add(c).divideScalar(3)
        if (!central(centroid)) return
        const t = hit(centroid, n.clone().negate(), k)
        if (Number.isFinite(t)) thick.push(t)
      })
      thick.sort((x, y) => x - y)
      expect(thick.length, `side ${side}: plate faces with a far side`).toBeGreaterThan(40)
      const p10 = thick[Math.floor(thick.length * 0.1)]
      const median = thick[Math.floor(thick.length * 0.5)]
      report.push(`side ${side}: p10 ${p10.toFixed(2)} median ${median.toFixed(2)} width ${width.toFixed(1)} ratio ${(p10 / width).toFixed(3)}`)
      expect(p10 / width, report.join('; ')).toBeGreaterThanOrEqual(0.08)
    }
  })
})

/** Plan-view (XZ) coverage of a mesh: the set of `cell`-sized grid cells whose
 * centre lies inside at least one triangle's ground projection. */
function planCells(
  g: THREE.BufferGeometry,
  cell: number,
  keep: (a: number, b: number, c: number) => boolean = () => true,
): Set<number> {
  const pos = g.getAttribute('position')
  const idx = g.index
  const n = idx ? idx.count : pos.count
  const out = new Set<number>()
  const V = (k: number): number => (idx ? idx.getX(k) : k)
  const P = (k: number): [number, number] => {
    const v = V(k)
    return [pos.getX(v) / cell, pos.getZ(v) / cell]
  }
  for (let t = 0; t < n; t += 3) {
    if (!keep(V(t), V(t + 1), V(t + 2))) continue
    const [a, b, c] = [P(t), P(t + 1), P(t + 2)]
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if (Math.abs(den) < 1e-12) continue
    const x0 = Math.floor(Math.min(a[0], b[0], c[0]))
    const x1 = Math.ceil(Math.max(a[0], b[0], c[0]))
    const z0 = Math.floor(Math.min(a[1], b[1], c[1]))
    const z1 = Math.ceil(Math.max(a[1], b[1], c[1]))
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const px = x + 0.5
        const pz = z + 0.5
        const l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[1])) / den
        const l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[1])) / den
        if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) out.add((x + 4096) * 8192 + (z + 4096))
      }
    }
  }
  return out
}

// ── minimal PNG reader for the embedded textures (8-bit RGB/RGBA, no
// interlace — what Blender's exporter writes) ────────────────────────────

interface Rgb8 {
  w: number
  h: number
  channels: number
  data: Uint8Array
}

function glbImages(name: string): Map<string, Rgb8> {
  const buf = readFileSync(fileURLToPath(new URL(`./assets/${name}.glb`, import.meta.url)))
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as {
    images: { name: string; bufferView: number }[]
    bufferViews: { byteOffset?: number; byteLength: number }[]
  }
  const bin = 20 + jsonLen + 8
  const out = new Map<string, Rgb8>()
  for (const im of json.images) {
    const v = json.bufferViews[im.bufferView]
    out.set(im.name, decodePng(buf.subarray(bin + (v.byteOffset ?? 0), bin + (v.byteOffset ?? 0) + v.byteLength)))
  }
  return out
}

function decodePng(png: Buffer): Rgb8 {
  let o = 8
  let w = 0
  let h = 0
  let channels = 0
  const idat: Buffer[] = []
  while (o < png.length) {
    const len = png.readUInt32BE(o)
    const type = png.subarray(o + 4, o + 8).toString('latin1')
    const body = png.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') {
      w = body.readUInt32BE(0)
      h = body.readUInt32BE(4)
      expect(body[8], 'PNG bit depth').toBe(8)
      expect(body[12], 'PNG interlace').toBe(0)
      channels = { 2: 3, 6: 4 }[body[9]] ?? 0
      expect(channels, 'PNG colour type RGB/RGBA').toBeGreaterThan(0)
    } else if (type === 'IDAT') idat.push(body)
    o += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const data = new Uint8Array(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x]
      const a = x >= channels ? data[y * stride + x - channels] : 0
      const b = y > 0 ? data[(y - 1) * stride + x] : 0
      const c = x >= channels && y > 0 ? data[(y - 1) * stride + x - channels] : 0
      const p = a + b - c
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pr
      data[y * stride + x] = (cur + pred) & 0xff
    }
  }
  return { w, h, channels, data }
}

function meanRgb(img: Rgb8): [number, number, number] {
  const s = [0, 0, 0]
  for (let i = 0; i < img.w * img.h; i++) for (let k = 0; k < 3; k++) s[k] += img.data[i * img.channels + k]
  return s.map((v) => v / (img.w * img.h * 255)) as [number, number, number]
}

/**
 * Quality pass "montroyal" (user 2026-10-11: "le décor du mont royal est
 * horrible"): the city's landmark is the Blender maquette
 * (scripts/blender/mont_royal_assets.py), merged into the city's ONE
 * material. backgrounds.test.ts runs the procedural fallback; this is the
 * shipped path.
 */
describe('Mont-Royal maquette (mont-royal.glb in the city ring)', () => {
  const mount = glb('mont-royal')
  /** The landmark budget the task set ("<= ~12k triangles for the whole
   * landmark"); mont_royal_assets.py prints the shipped mesh: 11 920 (montroyal3). */
  const MOUNT_TRIS_MAX = 12_000
  const HOLE = { x: 60, z: -40, w: 900, h: 560 }
  const opts = { hole: HOLE, radius: 2300, baseY: -30, seed: 7 }
  const checksum = (geo: THREE.BufferGeometry): number => {
    const a = geo.getAttribute('position').array as Float32Array
    let s = 0
    for (let i = 0; i < a.length; i++) s += a[i] * ((i % 977) + 1)
    return s
  }

  it('the GLB: under the landmark budget, the city layout (COLOR_0, UV codes), on the street inside its apron', () => {
    expect(trisOf(mount), 'landmark triangle budget').toBeLessThanOrEqual(MOUNT_TRIS_MAX)
    for (const a of ['position', 'normal', 'uv', 'color']) expect(mount.getAttribute(a), a).toBeTruthy()
    const pos = mount.getAttribute('position')
    const uv = mount.getAttribute('uv')
    const col = mount.getAttribute('color')
    let minY = Infinity
    let maxY = -Infinity
    let plan = 0
    const codes = new Map<number, number>()
    let litBright = 0
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i))
      maxY = Math.max(maxY, pos.getY(i))
      plan = Math.max(plan, Math.hypot(pos.getX(i), pos.getZ(i)))
      const code = Math.round(uv.getX(i) * 10) / 10
      codes.set(code, (codes.get(code) ?? 0) + 1)
      if (code === 0.9 && Math.min(col.getX(i), col.getY(i), col.getZ(i)) > 0.6) litBright++
    }
    expect(minY, 'the skirt stands on the street').toBeGreaterThanOrEqual(-1e-3)
    // the city keeps 1.25 r clear round the mount (fillCellBuilt): the
    // maquette's lawn skirt must stay inside it (1.17 R measured, montroyal3)
    expect(plan / MONT_ROYAL_GLB_R, 'plan radius in mount radii').toBeLessThan(1.22)
    // a broad massif with a summit, not a pancake and not a spire: summit
    // 57 + cross 37 over R 100 as shipped (montroyal3 prints height 93.2)
    expect(maxY / MONT_ROYAL_GLB_R).toBeGreaterThan(0.6)
    expect(maxY / MONT_ROYAL_GLB_R).toBeLessThan(1.1)
    // only the three codes, and each one used: plain, water (Beaver Lake),
    // lit (the cross — near-white steel)
    expect([...codes.keys()].sort()).toEqual([0.1, 0.5, 0.9])
    expect(codes.get(0.5)!, 'Beaver Lake on the water code').toBeGreaterThan(10)
    expect(litBright, 'the cross is near-white on the lit code').toBeGreaterThan(500)
  })

  it('registered, it takes the mount\'s seat in ONE city draw without moving a single block', () => {
    const fallback = buildCityGeometry(opts)
    expect(fallback.mount?.source).toBe('procedural')
    registerDecorAsset('mont-royal', { geometry: mount, map: null, normalMap: null, roughness: 0.88 })
    const city = buildCityGeometry(opts)
    expect(city.mount?.source).toBe('glb')
    expect(city.mount).toMatchObject({ x: fallback.mount!.x, z: fallback.mount!.z, r: fallback.mount!.r })
    // the procedural mount still RAN (its LCG draws): every band but the
    // south one (which carried its canopy) is byte-identical, and so is the
    // fabric manifest and the street life
    const byTag = (g: typeof city) => new Map(g.parts.map((p) => [p.tag, p.geometry]))
    const a = byTag(fallback)
    const b = byTag(city)
    for (const tag of ['city-north', 'city-east', 'city-west', 'city-bridges']) {
      if (!a.has(tag)) continue
      expect(checksum(b.get(tag)!), tag).toBe(checksum(a.get(tag)!))
    }
    expect(city.fabric).toEqual(fallback.fabric)
    expect(city.streetLife).toEqual(fallback.streetLife)
    // the south band lost exactly the procedural canopy, nothing else
    expect(trisOf(b.get('city-south')!)).toBeLessThan(trisOf(a.get('city-south')!))
    // the mount part IS the maquette: its triangles, the city's layout
    const m = b.get('city-mount')!
    expect(trisOf(m)).toBe(trisOf(mount))
    for (const k of ['position', 'normal', 'uv', 'color']) expect(m.getAttribute(k).itemSize, k).toBe(k === 'uv' ? 2 : 3)
    // budgets of the whole city with it: ≤ 6 draws, ≤ 60k triangles
    expect(city.parts.length).toBeLessThanOrEqual(6)
    expect(city.parts.reduce((s, p) => s + trisOf(p.geometry), 0)).toBeLessThanOrEqual(60_000)
    // on the street, inside the clearance the city keeps round the mount
    m.computeBoundingBox()
    const box = m.boundingBox!
    expect(box.min.y).toBeGreaterThanOrEqual(opts.baseY - 1e-3)
    const reach = Math.max(
      Math.hypot(box.min.x - city.mount!.x, 0),
      Math.hypot(box.max.x - city.mount!.x, 0),
      Math.abs(box.min.z - city.mount!.z),
      Math.abs(box.max.z - city.mount!.z),
    )
    expect(reach / city.mount!.r, 'plan reach in mount radii').toBeLessThan(1.25)
    // vertex i of the part IS vertex i of the GLB (one part, merged and
    // scaled in place): the lit corners (the cross) wear the albedo gain on
    // top of the city's ±24 % sun grade, every other corner the grade alone,
    // and the lake sits on the atlas's water texel
    const uv = m.getAttribute('uv')
    const col = m.getAttribute('color')
    const srcUv = mount.getAttribute('uv')
    const srcCol = mount.getAttribute('color')
    expect(col.count).toBe(srcCol.count)
    let lit = 0
    let wet = 0
    for (let i = 0; i < col.count; i++) {
      const code = srcUv.getX(i)
      const gain = code > 2 / 3 ? MONT_ROYAL_LIT_GAIN : 1
      const ratio = col.getY(i) / Math.max(1e-6, srcCol.getY(i))
      expect(ratio).toBeGreaterThanOrEqual(gain * 0.76 - 1e-4)
      expect(ratio).toBeLessThanOrEqual(gain * 1.24 + 1e-4)
      if (code > 2 / 3) lit++
      const onWater = Math.abs(uv.getX(i) - FACADE_WATER_UV[0]) < 1e-6 && Math.abs(uv.getY(i) - FACADE_WATER_UV[1]) < 1e-6
      expect(onWater, `corner ${i}: water texel iff the water code`).toBe(code > 1 / 3 && code < 2 / 3)
      if (onWater) wet++
    }
    expect(lit, 'the cross corners').toBeGreaterThan(500)
    expect(wet, 'Beaver Lake on the water texel').toBeGreaterThan(10)
    expect(MONT_ROYAL_LIT_GAIN).toBeGreaterThan(1)
    disposeCityGeometry(fallback)
    disposeCityGeometry(city)
  })
})
