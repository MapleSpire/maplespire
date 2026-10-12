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
  buildDecorMeshes,
  disposeDecorBuild,
  disposeDecorGeometries,
  FLAG,
  FLAG_EMBLEM_OUTLINE,
  FLAG_HEIGHT,
  FLAG_YAW_BAND,
  furlZ,
  EMBLEM_H,
  EMBLEM_W,
  LEAF_BOARD_R_MAX,
  LEAF_CLUMP_YAWS,
  LEAF_CURL_FRAC,
  LEAF_H,
  LEAF_MAX_SPAN,
  LEAF_RADIUS,
  LEAF_THICK_FRAC,
  LEAF_W,
  FLAG_RED,
  LEAF_BLADES,
  LEAF_CLUMP_AIR,
  LEAF_CLUMP_SEP,
  LEAF_CLUMP_YAW_MIN,
  LEAF_DARK_SHARE_MAX,
  LEAF_DARK_TONE,
  LEAF_HUE_JITTER_MAX,
  LEAF_MUTED_SHARE,
  LEAF_PALETTE,
  LEAF_SHADOW_ALPHA,
  LEAF_SHADOW_PER_HEIGHT,
  LEAF_SHADOW_R,
  LEAF_SURFACE,
  LEAF_TONE_MIX,
  LEAF_READ_AXIS,
  LEAF_SCATTER,
  LEAF_ROLL_MAX,
  LEAF_ROLL_CLUMP_MAX,
  LEAF_SHADOW_OFFSET,
  LEAF_SURFACE_L,
  LEAF_YAW_FORBID,
  LEAF_CLUMP_YAW_DEV_MAX,
  FLAG_EMBLEM_FRAC,
  depthAxisOffset,
  leafTone,
  mapleClumpFence,
  mapleClumpYawDev,
  mapleSingleRadius,
  mapleSingleSpan,
  scatterPoseOf,
  scatterYaw,
  mapleClumpLayout,
  MAPLE_LEAF_OUTLINE,
  SILHOUETTE_IDS,
  type LeafClumpKind,
  type LeafToneName,
} from './build'
import { CAMERA_PRESETS } from '../presets'
import { DECOR_PACKS, DESK_ARCHETYPES } from './registry'
import { DECOR_CELL, placeDecor, type PlacementInput, type PlacedProp } from './placement'

function fakePlacement(archetypeIds: string[]): PlacedProp[] {
  return archetypeIds.map((id, i) => ({
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

const CLUMP_KIND: Record<string, LeafClumpKind> = {
  'maple-leaf-cluster': 'cluster',
  'maple-leaf-drift': 'drift',
  'maple-leaf-pair': 'pair',
  'maple-leaf-pair-b': 'pairB',
  'maple-leaf-bank': 'bank',
}
const clumpKind = (id: string): LeafClumpKind | null => CLUMP_KIND[id] ?? null

function trisOf(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3
}

function meshesOf(build: ReturnType<typeof buildDecorMeshes>): THREE.InstancedMesh[] {
  const meshes: THREE.InstancedMesh[] = []
  build.group.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) meshes.push(o as THREE.InstancedMesh)
  })
  return meshes
}

describe('decor pack budgets (draw calls, triangles, tinting)', () => {
  // The PACK ceiling is 9000; the per-archetype cap (3500, the one that bounds
  // a single silhouette's complexity) is separate and the biggest leaf
  // archetype is 1272. Canadiana carries a FIFTH board-leaf archetype
  // (`maple-leaf-pair-b`, ~640 tris) because one geometry can only hold one
  // arrangement, and a single pair archetype placed three times is three
  // identical couples — a visibly cloned motif. The draw-call rule is still
  // exactly one InstancedMesh per archetype.
  it('every pack: ONE draw per archetype, ≤3500 tris each, ≤9k per pack', () => {
    for (const pack of DECOR_PACKS) {
      const uniqueIds = new Set(pack.archetypes.map((a) => a.id))
      const placed = fakePlacement([...uniqueIds])
      const build = buildDecorMeshes(pack, placed, { lit: true })
      const meshes = meshesOf(build)
      expect(meshes.length, `${pack.id} builds every archetype exactly once`).toBe(uniqueIds.size)
      let tris = 0
      for (const m of meshes) {
        const t = trisOf(m.geometry)
        expect(t, `${pack.id}/${String(m.userData.decorArchetype)} triangle cap`).toBeLessThan(3500)
        tris += t
        // multi-tone models carry baked vertex colors (the single material
        // per archetype stays — colors ride the geometry)
        expect(m.geometry.getAttribute('color'), `${pack.id} vertex colors`).toBeTruthy()
        // lit props cast — EXCEPT the leaf family, which carries a drawn
        // contact shadow instead (a 0.4-unit-thick blade
        // contributes nothing under the sun's 1.5-unit normalBias, and its
        // decal must never be rasterised into the shadow map)
        const leaf = String(m.userData.decorArchetype).startsWith('maple-leaf')
        expect(m.castShadow, `${String(m.userData.decorArchetype)} shadow policy`).toBe(!leaf)
      }
      expect(tris, `${pack.id} pack triangle budget`).toBeLessThan(9000)
      disposeDecorBuild(build)
    }
    disposeDecorGeometries()
  })

  it('every registered archetype has a silhouette, and the full catalog builds', () => {
    const registered = new Set<string>()
    for (const pack of DECOR_PACKS) for (const a of pack.archetypes) registered.add(a.id)
    for (const a of DESK_ARCHETYPES) registered.add(a.id)
    for (const id of registered) {
      expect(SILHOUETTE_IDS, `${id} has geometry`).toContain(id)
    }
    // build the whole catalog (incl. walking/carrying poses + canadiana):
    // one InstancedMesh per id, each under the per-archetype triangle cap
    const catalog = {
      id: 'catalog',
      nameKey: 'x',
      archetypes: SILHOUETTE_IDS.map((id) => ({
        id,
        asset: id,
        footprint: 10,
        affinity: 'open' as const,
        weight: 1,
        scaleJitter: [1, 1] as [number, number],
        rotation: 'grid' as const,
        baseCount: 1,
      })),
    }
    const build = buildDecorMeshes(catalog, fakePlacement([...SILHOUETTE_IDS]), { lit: true })
    const meshes = meshesOf(build)
    expect(meshes.length, 'every silhouette id builds').toBe(SILHOUETTE_IDS.length)
    expect(new Set(meshes.map((m) => m.userData.decorArchetype as string)).size).toBe(SILHOUETTE_IDS.length)
    for (const m of meshes) {
      expect(trisOf(m.geometry), `${String(m.userData.decorArchetype)} triangle cap`).toBeLessThan(3500)
    }
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('canadiana + shared desk merge: duplicate ids collapse to ONE draw each', () => {
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    // the host merges pack + desk archetypes — beaver and maple-leaf-cluster
    // appear in BOTH lists (the shared Canadian-workshop signature)
    const merged = [...canadiana.archetypes, ...DESK_ARCHETYPES]
    const uniqueIds = new Set(merged.map((a) => a.id))
    expect(merged.length, 'the merge really contains duplicate ids').toBeGreaterThan(uniqueIds.size)
    const build = buildDecorMeshes({ ...canadiana, archetypes: merged }, fakePlacement([...uniqueIds]), { lit: true })
    const seen = meshesOf(build).map((m) => m.userData.decorArchetype as string)
    expect(seen.length, 'one draw per unique archetype').toBe(uniqueIds.size)
    expect(new Set(seen).size, 'no archetype builds twice').toBe(seen.length)
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('determinism: two placement+build rounds produce an identical scene', () => {
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    const merged = [...canadiana.archetypes, ...DESK_ARCHETYPES]
    const input: PlacementInput = {
      archetypes: merged,
      density: 'normal',
      seed: 0xbeaf,
      bounds: { x: 0, y: 0, w: 1100, h: 750 },
      pad: { x: 88, y: 72 },
      fractureBand: 0,
      nodes: [
        { id: 'a', type: 'app', rect: { x: 100, y: 100, w: 200, h: 120 } },
        { id: 'b', type: 'store', rect: { x: 620, y: 420, w: 175, h: 100 } },
      ],
      groups: [],
      connections: [{ points: [{ x: 300, y: 160 }, { x: 620, y: 470 }] }],
      deskBand: 150,
    }
    const round = () => {
      const placed = placeDecor(input)
      const build = buildDecorMeshes({ ...canadiana, archetypes: merged }, placed, { lit: true, deskLift: -30 })
      const snapshot = meshesOf(build)
        .map((m) => {
          const pos = m.geometry.getAttribute('position')
          let sum = 0
          for (let i = 0; i < pos.array.length; i++) sum += (pos.array as Float32Array)[i]
          return {
            id: m.userData.decorArchetype as string,
            count: m.count,
            matrices: Array.from(m.instanceMatrix.array),
            vertexCount: pos.count,
            positionSum: Math.round(sum * 1000) / 1000,
          }
        })
        .sort((a, b) => (a.id < b.id ? -1 : 1))
      disposeDecorBuild(build)
      disposeDecorGeometries() // force full geometry regeneration next round
      return { placed, snapshot }
    }
    const a = round()
    const b = round()
    expect(b.placed).toEqual(a.placed)
    expect(b.snapshot).toEqual(a.snapshot)
    expect(a.placed.length).toBeGreaterThan(0)
  })

  it('platform props lift by platformLift (walkable pedestals)', () => {
    const pack = DECOR_PACKS[0]
    const a = pack.archetypes[0].id
    const placed: PlacedProp[] = [
      { propId: `${a}:0:0`, archetypeId: a, x: 0, z: 0, rotY: 0, scale: 1, onPlatform: false, onDesk: false },
      { propId: `${a}:1:0`, archetypeId: a, x: 40, z: 0, rotY: 0, scale: 1, onPlatform: true, onDesk: false },
    ]
    const build = buildDecorMeshes(pack, placed, { lit: true, platformLift: 6 })
    let mesh: THREE.InstancedMesh | null = null
    build.group.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh && o.userData.decorArchetype === a) mesh = o as THREE.InstancedMesh
    })
    expect(mesh).not.toBeNull()
    const m = new THREE.Matrix4()
    mesh!.getMatrixAt(0, m)
    expect(m.elements[13], 'board prop stays at ground level').toBeCloseTo(0, 5)
    mesh!.getMatrixAt(1, m)
    expect(m.elements[13], 'platform prop lifts by plat').toBeCloseTo(6, 5)
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('the shared desk set builds ≤6 draws under 4k tris; deskLift drops props to the bench', () => {
    const deskPack = { id: 'desk-set', nameKey: 'x', archetypes: DESK_ARCHETYPES }
    const placed: PlacedProp[] = DESK_ARCHETYPES.map((a, i) => ({
      propId: `${a.id}:0:${i}`,
      archetypeId: a.id,
      x: i * 60,
      z: 0,
      rotY: 0,
      scale: 1,
      onPlatform: false,
      onDesk: true,
    }))
    const build = buildDecorMeshes(deskPack, placed, { lit: true, deskLift: -30 })
    const meshes = meshesOf(build)
    // pencil + coil + note + the Canadiana signature (leaf clump, the big
    // single blade beside it, and the beaver)
    expect(meshes.length).toBe(6)
    let tris = 0
    const m = new THREE.Matrix4()
    for (const mesh of meshes) {
      tris += trisOf(mesh.geometry)
      mesh.getMatrixAt(0, m)
      expect(m.elements[13], `${mesh.userData.decorArchetype} sits at bench level`).toBeLessThan(-20)
    }
    expect(tris, 'desk set triangle budget').toBeLessThan(4000)
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('loon reads waterfowl: horizontal two-tone body resting ON the desk (critique #7)', () => {
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    const build = buildDecorMeshes(canadiana, fakePlacement(['loon']), { lit: true })
    const meshes = meshesOf(build)
    expect(meshes.length).toBe(1)
    const geo = meshes[0].geometry
    geo.computeBoundingBox()
    const size = new THREE.Vector3()
    geo.boundingBox!.getSize(size)
    // waterfowl posture: clearly longer (tail→bill) than tall — never the
    // upright knob/ring silhouette
    expect(size.x, 'body is horizontal').toBeGreaterThan(size.y)
    // hull rests on the desk plane (groundOffset closes the last gap)
    expect(geo.boundingBox!.min.y).toBeGreaterThan(-1)
    expect(geo.boundingBox!.min.y).toBeLessThan(1)
    // two-tone: charcoal body AND white chest/collar vertices must both
    // exist (thresholds hold in both sRGB and linear working spaces)
    const colors = geo.getAttribute('color')
    let dark = 0
    let light = 0
    for (let i = 0; i < colors.count; i++) {
      const r = colors.getX(i)
      const g = colors.getY(i)
      const b = colors.getZ(i)
      if (Math.max(r, g, b) < 0.2) dark++
      if (Math.min(r, g, b) > 0.35) light++
    }
    expect(dark, 'charcoal body vertices').toBeGreaterThan(0)
    expect(light, 'white chest/collar vertices').toBeGreaterThan(0)
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  // ── the maple leaf is a REAL maple, and it populates the scene ──────────

  // ── the outline, measured as a polygon ───────────────────────────────────
  // Radii are quoted from the AUTHORING origin
  // (0, 0), normalised by the central apex's own radius. That makes "the apex
  // is at r = 1.0" true by construction and every other number a fraction of
  // it, which is the only frame in which "sinuses cut to 0.40-0.45r" and "no
  // tooth deeper than 0.10r" mean anything.
  const OUT = MAPLE_LEAF_OUTLINE
  const N = OUT.length
  const APEX = OUT.reduce((b, p) => (p[1] > b[1] ? p : b), OUT[0])
  const RA = Math.hypot(APEX[0], APEX[1])
  const rOf = ([x, y]: readonly [number, number]): number => Math.hypot(x, y) / RA
  const signedArea = (P: readonly (readonly [number, number])[]): number =>
    P.reduce((s, p, i) => {
      const q = P[(i + 1) % P.length]
      return s + (p[0] * q[1] - q[0] * p[1])
    }, 0) / 2
  const orient = Math.sign(signedArea(OUT))
  /** > 0 at a POINT (convex corner), < 0 inside a notch (reflex) */
  const turnAt = (i: number): number => {
    const a = OUT[(i - 1 + N) % N]
    const b = OUT[i]
    const c = OUT[(i + 1) % N]
    return ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) * orient
  }
  const isPoint = (i: number): boolean => turnAt(i) > 1e-12
  const distToSeg = (p: readonly number[], a: readonly number[], b: readonly number[]): number => {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const L = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L))
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
  }
  /** Every NOTCH: a maximal run of reflex vertices between two points, with its
   * own depth measured against the chord that spans it. This is the measurement
   * that separates a SINUS from a TOOTH — a starburst outline, whose cuts are
   * all the same size, has no such distinction. */
  interface Notch {
    floor: readonly [number, number]
    /** cut depth, as a fraction of the apex radius */
    cut: number
  }
  const NOTCHES: Notch[] = (() => {
    const out: Notch[] = []
    let i = 0
    while (i < N) {
      if (isPoint(i)) {
        i++
        continue
      }
      let j = i
      while (j < N && !isPoint(j)) j++
      const a = OUT[(i - 1 + N) % N]
      const b = OUT[j % N]
      let cut = 0
      let floor = OUT[i]
      for (let k = i; k < j; k++) {
        const d = distToSeg(OUT[k], a, b)
        if (d > cut) {
          cut = d
          floor = OUT[k]
        }
      }
      out.push({ floor, cut: cut / RA })
      i = j
    }
    return out
  })()
  /** The blade's own notches — the stem junction (whose floor sits BELOW the
   * blade) is a different animal and is gated separately. */
  const BLADE_NOTCHES = NOTCHES.filter((n) => n.floor[1] > 0)
  const SINUSES = BLADE_NOTCHES.filter((n) => n.cut > 0.15)
  const TEETH = BLADE_NOTCHES.filter((n) => n.cut <= 0.15)
  /** the polygon's horizontal chord at a given y */
  const chordAt = (y: number): number => {
    const xs: number[] = []
    for (let i = 0; i < N; i++) {
      const a = OUT[i]
      const b = OUT[(i + 1) % N]
      if ((a[1] - y) * (b[1] - y) > 0 || a[1] === b[1]) continue
      xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]))
    }
    return xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs)
  }

  it('the blade is a MAPLE, not a starburst: five unequal lobes, four sinuses, capped teeth', () => {
    // An outline whose points are all roughly the same length off a small hub
    // reads as "thin spikes, no body, no stem" — a starburst. What reads as a
    // maple at any size is a broad central lobe, two lateral lobes, two basal
    // lobes and an explicit stem.
    //
    // A maple is not a count of points. It is a HIERARCHY, and every clause
    // below measures one rung of it against the shipped array.

    // (a) FIVE LOBES, separated by FOUR sinuses. A "sinus" is defined by its cut
    //     depth against the chord that spans it, not by eyeballing a coordinate,
    //     so a future retune cannot quietly promote a tooth.
    expect(SINUSES.length, 'four sinuses ⇒ five lobes').toBe(4)
    // …and they are the two structural cuts, mirrored
    for (const s of SINUSES) {
      expect(
        SINUSES.some((t) => Math.abs(t.floor[0] + s.floor[0]) < 1e-9 && Math.abs(t.floor[1] - s.floor[1]) < 1e-9),
        `sinus ${s.floor[0]},${s.floor[1]} is mirrored`,
      ).toBe(true)
    }

    // (b) SINUS FLOORS AT 0.40-0.45r — deep enough to cut the lobes apart,
    //     shallow enough to leave a body between them. Shipped: 0.430 / 0.405.
    for (const s of SINUSES) {
      const r = rOf(s.floor)
      expect(r, `sinus floor at r=${r.toFixed(3)}`).toBeGreaterThanOrEqual(0.4)
      expect(r, `sinus floor at r=${r.toFixed(3)}`).toBeLessThanOrEqual(0.45)
    }

    // (c) THE LOBE RADII ARE UNEQUAL — that IS the hierarchy. Central 1.000,
    //     lateral 0.850, basal 0.600: three distinct tiers, each separated by
    //     more than the deepest tooth, so no tooth can be mistaken for a lobe.
    const halfPoints = [...Array(N).keys()].filter((i) => isPoint(i) && OUT[i][0] >= 0)
    const central = rOf(APEX)
    const lateral = Math.max(...halfPoints.filter((i) => OUT[i][1] > 0.45 && OUT[i][0] > 0.3).map((i) => rOf(OUT[i])))
    const basal = Math.max(...halfPoints.filter((i) => OUT[i][1] <= 0.1 && OUT[i][0] > 0.3).map((i) => rOf(OUT[i])))
    expect(central, 'the central lobe defines r = 1').toBeCloseTo(1, 9)
    expect(lateral, `lateral lobe r=${lateral.toFixed(3)}`).toBeGreaterThan(0.75)
    expect(lateral, 'the lateral lobe never rivals the central one').toBeLessThan(0.92)
    expect(basal, `basal lobe r=${basal.toFixed(3)}`).toBeGreaterThan(0.5)
    expect(basal, 'the basal lobe stays the small one').toBeLessThan(0.7)
    expect(lateral - basal, 'lateral and basal are separate tiers').toBeGreaterThan(0.15)

    // (d) THE BODY. The single vertex that turns a spike into a lobe: the
    //     central lobe's full width at its own mid-height (between the sinus
    //     floor beside it and the apex) is 0.479 of the apex radius. The
    //     floor is 0.45; a starburst blade measures ~0.18 there.
    const sinusY = Math.max(...SINUSES.map((s) => s.floor[1]))
    const midY = (sinusY + APEX[1]) / 2
    const body = chordAt(midY) / RA
    expect(body, `central lobe body ${body.toFixed(3)}r at mid-height`).toBeGreaterThanOrEqual(0.45)

    // (e) TEETH ARE CAPPED, AND THERE ARE AT MOST TWO PER LOBE. The deepest
    //     tooth is 0.095r against the shallowest sinus at 0.191r — so nothing on
    //     the outline can be mistaken for the cut that separates two lobes.
    expect(TEETH.length, 'at most two teeth per lobe, mirrored').toBeLessThanOrEqual(10)
    for (const t of TEETH) expect(t.cut, `tooth cut ${t.cut.toFixed(3)}r`).toBeLessThanOrEqual(0.1)
    expect(
      Math.min(...SINUSES.map((s) => s.cut)) / Math.max(...TEETH.map((t) => t.cut)),
      'sinus:tooth ratio',
    ).toBeGreaterThan(1.8)

    // (f) THE STEM — a QUAD, 0.15r long and 0.05r wide, and actually there. A
    //     stem tapered to a point disappears at every delivered size; real
    //     maple die-cuts all have one.
    const stemNotch = NOTCHES.filter((n) => n.floor[1] <= 0)
    expect(stemNotch.length, 'the blade↔stem junction, mirrored').toBe(2)
    const junctionY = stemNotch[0].floor[1]
    const footY = Math.min(...OUT.map((p) => p[1]))
    const stemLen = (junctionY - footY) / RA
    expect(stemLen, `stem length ${stemLen.toFixed(3)}r`).toBeGreaterThan(0.12)
    expect(stemLen, 'a stem, not a tail').toBeLessThan(0.19)
    const stemW = chordAt((junctionY + footY) / 2) / RA
    expect(stemW, `stem width ${stemW.toFixed(3)}r`).toBeGreaterThan(0.03)
    expect(stemW, 'slender enough to stay a stem').toBeLessThan(0.08)
    // …and it is a QUAD: the same width at both ends of its free length
    expect(chordAt(footY + (junctionY - footY) * 0.1) / RA - stemW, 'constant width').toBeCloseTo(0, 6)

    // (g) VERTEX BUDGET. The hierarchy is the read, and 36-42 vertices is what
    //     it costs; ~22 vertices loses the lobes.
    expect(N, 'boundary vertices').toBeGreaterThanOrEqual(36)
    expect(N, 'boundary vertices').toBeLessThanOrEqual(42)

    // (h) MIRRORED, so the two sides can never drift apart
    for (const [x, y] of OUT) {
      expect(OUT.some((q) => Math.abs(q[0] + x) < 1e-9 && Math.abs(q[1] - y) < 1e-9), `mirror of ${x},${y}`).toBe(true)
    }

    // (i) SIMPLE — no self-intersection is reachable by tuning a coordinate
    const segInt = (a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): boolean => {
      const cr = (p: readonly number[], q: readonly number[], r: readonly number[]) =>
        (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
      return Math.sign(cr(a, b, c)) !== Math.sign(cr(a, b, d)) && Math.sign(cr(c, d, a)) !== Math.sign(cr(c, d, b))
    }
    for (let i = 0; i < N; i++) {
      for (let j = i + 2; j < N; j++) {
        if (i === 0 && j === N - 1) continue
        expect(segInt(OUT[i], OUT[(i + 1) % N], OUT[j], OUT[(j + 1) % N]), `edge ${i} × edge ${j}`).toBe(false)
      }
    }

    // (j) THE ANTI-NOISE GATE. Every boundary edge is a large fraction of the
    //     blade radius, so no feature on the silhouette can be sub-pixel at any
    //     framing this scene uses. Shipped: 6.5% of the rotation-safe radius —
    //     three times the 2% floor the anti-noise law draws.
    const MID_Y = (Math.max(...OUT.map((p) => p[1])) + Math.min(...OUT.map((p) => p[1]))) / 2
    const R_ROT = Math.max(...OUT.map(([x, y]) => Math.hypot(x, y - MID_Y)))
    let shortest = Infinity
    for (let i = 0; i < N; i++) {
      const q = OUT[(i + 1) % N]
      shortest = Math.min(shortest, Math.hypot(q[0] - OUT[i][0], q[1] - OUT[i][1]))
    }
    expect(shortest / R_ROT, `shortest edge ${((shortest / R_ROT) * 100).toFixed(1)}% of the radius`).toBeGreaterThan(0.04)

    // (k) BROAD LOBES, measured as SOLIDITY — the blade's area over its convex
    //     hull's. A claw of narrow fingers radiating from a small hub cannot
    //     reach 0.58; the shipped blade is 0.641.
    const pts = [...OUT].sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const cr = (o: readonly number[], a: readonly number[], b: readonly number[]) =>
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    const lower: (readonly [number, number])[] = []
    for (const p of pts) {
      while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
      lower.push(p)
    }
    const upper: (readonly [number, number])[] = []
    for (const p of [...pts].reverse()) {
      while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
      upper.push(p)
    }
    const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)]
    const solidity = Math.abs(signedArea(OUT)) / Math.abs(signedArea(hull))
    expect(solidity, `solidity ${solidity.toFixed(3)}`).toBeGreaterThan(0.58)

    // (l) NEAR-SQUARE, the reference's own proportion.
    expect(LEAF_W / LEAF_H, 'plan aspect').toBeGreaterThan(0.9)
    expect(LEAF_W / LEAF_H, 'plan aspect').toBeLessThan(1.12)
  })

  it('the FLAG EMBLEM is its own THREE-lobe stencil — legible at 16 px (round 4 #4)', () => {
    // The emblem must not reuse the polygon the litter extrudes: at its
    // delivered ~13 px that outline has zero lobe articulation and reads as a
    // heart or butterfly smear. An eleven-point outline with six teeth at
    // 13 px IS the stipple the anti-noise law forbids.
    const EM = FLAG_EMBLEM_OUTLINE
    expect(EM, 'the emblem is NOT the blade').not.toBe(MAPLE_LEAF_OUTLINE)
    const M = EM.length
    const eApex = EM.reduce((b, p) => (p[1] > b[1] ? p : b), EM[0])
    const eRA = Math.hypot(eApex[0], eApex[1])
    const eArea = signedArea(EM)
    const eOrient = Math.sign(eArea)
    const eTurn = (i: number): number => {
      const a = EM[(i - 1 + M) % M]
      const b = EM[i]
      const c = EM[(i + 1) % M]
      return ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) * eOrient
    }
    const eReflex = [...Array(M).keys()].filter((i) => eTurn(i) < -1e-12)

    // (a) FOUR cuts and no more: the two SINUSES that make three lobes, and the
    //     two STEM SHOULDERS. Nothing else on the outline may be concave —
    //     no teeth, no rounded floors, no second notch anywhere. (A stem
    //     junction is two reflex corners by definition.)
    expect(eReflex.length, 'two sinuses + two stem shoulders, nothing else').toBe(4)
    expect(M, 'three points, a torso and a stem — 17 vertices').toBeLessThanOrEqual(17)
    // …and every one of the added vertices is on the silhouette's MASS, not a
    // repeated edge: the longest-to-shortest edge ratio stays inside 12, i.e.
    // there is no run of tiny segments pleating a margin (the anti-noise law).
    const edges = EM.map((p, i) => Math.hypot(p[0] - EM[(i + 1) % M][0], p[1] - EM[(i + 1) % M][1]))
    expect(Math.max(...edges) / Math.min(...edges), 'no pleated margin').toBeLessThan(12)

    // (b) SINUSES AT 0.35r — measured on the reflex
    //     vertices ABOVE the foot (the stem shoulders are the other two)
    const sinuses = eReflex.filter((i) => EM[i][1] > 0)
    expect(sinuses.length, 'two sinuses ⇒ three lobes').toBe(2)
    for (const i of sinuses) {
      const r = Math.hypot(EM[i][0], EM[i][1]) / eRA
      expect(r, `emblem sinus at r=${r.toFixed(3)}`).toBeCloseTo(0.35, 2)
    }
    // …and the NECK between them is wide enough to be a body. A floor at
    // x ≈ 0.14 pinches the shape to 0.28 of the apex radius exactly where the
    // lateral lobes attach — a "narrow waist" that reads as a fleur-de-lis.
    const neck = 2 * Math.abs(EM[sinuses[0]][0])
    expect(neck / eRA, `neck is ${(neck / eRA).toFixed(2)} of the apex radius`).toBeGreaterThan(0.4)

    // (c) THE CENTRAL SPIKE DOMINATES. Three points at nearly one height read
    //     as a trident; the Canada leaf is one tall point with two shoulders.
    //     Measured against the sinus line, which is where a lobe starts.
    const lateral = EM.reduce((b, p) => (p[0] > b[0] ? p : b), EM[0])
    const sinusY = EM[sinuses[0]][1]
    const rise = (p: readonly number[]) => p[1] - sinusY
    expect(rise(eApex) / rise(lateral), 'the central spike over the lateral').toBeGreaterThan(2)

    // (d) THERE IS A STEM, and it is a constant-width quad on the BOTTOM
    //     silhouette. The interior-stipple rule does not apply to an EXTERIOR
    //     feature: a 1-2 px tick under
    //     a shape still reads as "this hangs from something", and it is the one
    //     cue that separates a maple from a fleur-de-lis.
    const foot = Math.min(...EM.map((p) => p[1]))
    const stem = EM.filter((p) => p[1] < 0)
    expect(foot / eRA, 'the stem hangs below the foot').toBeLessThan(-0.2)
    const stemW = 2 * Math.min(...stem.map((p) => Math.abs(p[0])))
    expect(stemW, 'the stem is narrow…').toBeLessThan(0.16)
    expect(stemW / Math.abs(foot), '…but not a hair').toBeGreaterThan(0.3)

    // (d) SOLIDITY well above the blade's: fewer, fatter lobes is the whole
    //     point of a separate stencil
    const ePts = [...EM].sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const ecr = (o: readonly number[], a: readonly number[], b: readonly number[]) =>
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    const eLo: (readonly [number, number])[] = []
    for (const p of ePts) {
      while (eLo.length >= 2 && ecr(eLo[eLo.length - 2], eLo[eLo.length - 1], p) <= 0) eLo.pop()
      eLo.push(p)
    }
    const eUp: (readonly [number, number])[] = []
    for (const p of [...ePts].reverse()) {
      while (eUp.length >= 2 && ecr(eUp[eUp.length - 2], eUp[eUp.length - 1], p) <= 0) eUp.pop()
      eUp.push(p)
    }
    const eSolidity = Math.abs(eArea) / Math.abs(signedArea([...eLo.slice(0, -1), ...eUp.slice(0, -1)]))
    expect(eSolidity, `emblem solidity ${eSolidity.toFixed(3)}`).toBeGreaterThan(0.6)

    // (e) …and it is MIRRORED like the blade
    for (const [x, y] of EM) {
      expect(EM.some((q) => Math.abs(q[0] + x) < 1e-9 && Math.abs(q[1] - y) < 1e-9), `mirror of ${x},${y}`).toBe(true)
    }
  })
  it('NO interior stipple: the vein network is gone, the ramp is a single vertical break', () => {
    // Vein inlays (pale stripes, ΔL ≈ 35 against the blade, ~3 px wide on a
    // 30-55 px prop) do not read as veins at that size — a stripe splits the
    // lobe, and a five-lobe blade delivers nine fingers. Instead, a per-blade
    // VERTICAL ramp: a monotone function of ONE coordinate, so it has no spatial
    // frequency to alias with and cannot touch the outline.
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    const build = buildDecorMeshes(canadiana, fakePlacement(['maple-leaf-mini']), { lit: true })
    const geo = meshesOf(build)[0].geometry
    const pos = geo.getAttribute('position')
    const nrm = geo.getAttribute('normal')
    const col = geo.getAttribute('color')

    // the LID vertices — the face the ramp paints. The contact decal is also
    // a +Y face, so it is excluded by its alpha (blades are opaque).
    const lid: { z: number; c: THREE.Color }[] = []
    for (let i = 0; i < nrm.count; i++) {
      if (nrm.getY(i) < 0.8 || col.getW(i) < 0.99) continue
      lid.push({ z: pos.getZ(i), c: new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)) })
    }
    expect(lid.length, 'the lid has vertices').toBeGreaterThan(15)
    // the blade lies with its crown toward −Z (mapleLeafGeom rotates the shape
    // plane down), so the ramp runs along −Z: darkest at +Z (the petiole).
    const zs = lid.map((v) => v.z)
    const z0 = Math.max(...zs)
    const z1 = Math.min(...zs)
    const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
    const base = lid.reduce((b, v) => (v.z > b.z ? v : b))
    const tip = lid.reduce((b, v) => (v.z < b.z ? v : b))

    // (a) THE RAMP IS A FUNCTION OF ONE COORDINATE. Bucket the lid by its
    //     position along the crown axis: inside a bucket every vertex must be
    //     the same colour. A vein inlay is exactly a disagreement here — it puts
    //     two very different values at the same height on the blade.
    const buckets = new Map<number, THREE.Color[]>()
    for (const v of lid) {
      // k = 0 at the PETIOLE (max z), rising toward the apex
      const k = Math.round(((z0 - v.z) / (z0 - z1)) * 24)
      buckets.set(k, [...(buckets.get(k) ?? []), v.c])
    }
    expect(buckets.size, 'the ramp spans the blade').toBeGreaterThan(10)
    for (const [k, cs] of buckets) {
      const l = cs.map(lum)
      expect(Math.max(...l) - Math.min(...l), `row ${k} is ONE value`).toBeLessThan(0.01)
    }

    // (b) IT IS MONOTONE — deep at the petiole, bright at the apex, nothing in
    //     between brighter than the tip. No inlay can hide inside a monotone
    //     ramp.
    // (the LIE tilts the blade about X, so world z is the crown axis plus a
    // small term in the die-cut's own thickness — 5e-3 is that term's size, not
    // slack for a second value)
    const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, cs]) => lum(cs[0]))
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i], `row ${i} rises toward the apex`).toBeGreaterThanOrEqual(rows[i - 1] - 5e-3)
    }

    // (c) …and the break is BIG enough to see: "base crimson → tip vermilion"
    //     is a real colour break, not a half-stop.
    // (vertex colours live in the WORKING/linear space, so this ratio is the
    // linear one: the authored 1.63× of sRGB lightness arrives as ≈2.97×)
    const ratio = lum(tip.c) / lum(base.c)
    expect(ratio, `base→tip luminance ${ratio.toFixed(2)}× (linear)`).toBeGreaterThan(1.9)
    expect(ratio, 'still one leaf, not two').toBeLessThan(3.4)
    // …and it never lightens past the point where a blade stops being a red
    // shape (the salmon veins were ΔL ≈ 35 of L*; this is a warm tone ramp)
    expect(lum(tip.c), 'no near-white value anywhere on the blade').toBeLessThan(0.42)
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('leaves are READABLE, and the BOARD carries the hero blade (round 4 #5a)', () => {
    // The BOARD, not the desk, carries the biggest blade, because only ONE of
    // the two zones has a clearance proof:
    //
    //   • BOARD. `placeDecor`'s 'open' rule caps a board prop's rotation-safe
    //     radius at LEAF_BOARD_R_MAX = 25.81 (cell centre >30 from the rim,
    //     jitter (footprint−20)/2, scale ≤1.05). At that radius a blade NEVER
    //     straddles the bevel — the gate below re-derives it end to end;
    //   • DESK. `score()` admits any desk cell with dOut ≥ 10, jitter pulls that
    //     to ~4, and the prop then draws at desk level UNDER the slab overhang.
    //     A big (~61-unit) desk blade straddles the rim or hangs off the top
    //     edge. There is no registry number that makes a big desk blade safe,
    //     so the big blade lives on the board and the desk keeps the small
    //     ones.
    //
    // PX/UNIT: measured on a default-framing hero render — board-level props
    // render at ≈1.05 px per world unit at the default framing and the wide
    // framing pulls back 1.9×.
    const PX_PER_UNIT = 1.05
    const WIDE_PULLBACK = 1.9
    const JITTER_TOP = 1.05

    const all = [...DECOR_PACKS.flatMap((p) => p.archetypes), ...DESK_ARCHETYPES]
    const leafArch = all.filter((a) => a.id.startsWith('maple-leaf'))
    expect(new Set(leafArch.map((a) => a.id)).size, 'the leaf family').toBeGreaterThanOrEqual(9)

    // (a) THE HERO BLADE is a BOARD single, at the largest radius the rim proof
    //     allows, and it reads at both framings.
    const heroPx = mapleSingleSpan('mini') * JITTER_TOP * PX_PER_UNIT
    expect(heroPx, `the hero blade spans ${heroPx.toFixed(0)} px in the default hero`).toBeGreaterThan(42)
    expect(heroPx / WIDE_PULLBACK, 'the hero blade in the wide framing').toBeGreaterThan(24)
    expect(mapleSingleRadius('mini') / LEAF_BOARD_R_MAX, 'the hero uses the rim budget').toBeGreaterThan(0.95)
    // …and the DESK blades are strictly smaller than it, so the zone that can
    // clip is also the zone with the least to lose
    for (const kind of ['fall', 'fallB'] as const) {
      expect(mapleSingleRadius(kind), `${kind} stays under the board hero`).toBeLessThan(mapleSingleRadius('mini'))
      expect(mapleSingleSpan(kind) * JITTER_TOP, `${kind} is life size`).toBeLessThanOrEqual(LEAF_MAX_SPAN)
    }

    // (b) EVERY board leaf obeys the rim rule, and its registry footprint is
    //     exactly ceil(radius) — the two cannot drift.
    const radiusOf = (id: string): number => {
      const clump = clumpKind(id)
      if (clump) return mapleClumpLayout(clump).radius
      const single: Record<string, 'fall' | 'fallB' | 'mini' | 'miniB' | 'miniC'> = {
        'maple-leaf-fall': 'fall',
        'maple-leaf-fall-b': 'fallB',
        'maple-leaf-mini': 'mini',
        'maple-leaf-mini-b': 'miniB',
        'maple-leaf-mini-c': 'miniC',
      }
      return mapleSingleRadius(single[id])
    }
    for (const a of leafArch) {
      const r = radiusOf(a.id)
      // `placeDecor` multiplies the footprint by the instance scale itself, so
      // the registry number is the radius at scale 1, rounded up
      expect(a.footprint, `${a.id} footprint tracks its radius ${r.toFixed(2)}`).toBe(Math.ceil(r))
      if ((a.zone ?? 'board') === 'board') {
        expect(r, `${a.id} radius ${r.toFixed(2)} ≤ LEAF_BOARD_R_MAX`).toBeLessThanOrEqual(LEAF_BOARD_R_MAX)
        // the placement rule this is derived FROM, re-checked end to end
        expect(r * JITTER_TOP, `${a.id} clears the slab rim after jitter`).toBeLessThanOrEqual(
          30 - (a.footprint - DECOR_CELL) / 2,
        )
      }
      // every blade in every archetype stays life size
      const spans =
        clumpKind(a.id) !== null
          ? mapleClumpLayout(clumpKind(a.id)!).blades.map((b) => Math.max(LEAF_W, LEAF_H) * b.size)
          : []
      for (const s of spans) expect(s * JITTER_TOP, `${a.id} blade span`).toBeLessThanOrEqual(LEAF_MAX_SPAN)
    }

    // (c) the desk showcase promotion takes the LARGEST desk footprint and
    //     forces it into the inner ring, where a wide flat cutout would be
    //     bisected by the desk-edge line. No leaf archetype may hold that pick.
    const desk = all.filter((a) => a.zone === 'desk')
    const largest = desk.reduce((b, a) => (a.footprint > b.footprint ? a : b))
    expect(largest.id.startsWith('maple-leaf'), 'no flat cutout is the desk showcase').toBe(false)
  })

  it('a clump is a PILE of legible leaves: separated, yawed apart, never coplanar', () => {
    // The failures to avoid: a clump that fuses into an amorphous orange crab
    // shape with no individual leaf legible, and a gold leaf coplanar with a
    // red one whose lobes read THROUGH the blade.
    // Three invariants, all authored into LEAF_CLUMPS and all measured here.
    const kinds: LeafClumpKind[] = ['pair', 'pairB', 'drift', 'cluster', 'bank']
    for (const kind of kinds) {
      const { blades, radius } = mapleClumpLayout(kind)
      expect(blades.length, `${kind} is a drift of 2-4`).toBeGreaterThanOrEqual(2)
      expect(blades.length, `${kind} is a drift of 2-4`).toBeLessThanOrEqual(4)
      // Every row's roll stays inside the clump budget, because a
      // rolled blade lifts an edge toward the blade stacked above it and
      // `stepOf` has to buy that lift back out of the stack (the singles, which
      // stack against nothing, get the full LEAF_ROLL_MAX)
      for (const b of blades) {
        expect(Math.abs(b.roll), `${kind} clump roll`).toBeLessThanOrEqual(LEAF_ROLL_CLUMP_MAX + 1e-9)
      }

      for (let i = 0; i < blades.length; i++) {
        for (let j = i + 1; j < blades.length; j++) {
          const a = blades[i]
          const b = blades[j]
          // (a) CENTRE-TO-CENTRE. Two die-cuts closer than 0.55 of their mean
          //     diameter fuse into one blob at delivered size.
          const d = Math.hypot(a.cx - b.cx, a.cz - b.cz)
          const meanDiameter = a.r + b.r
          expect(d, `${kind} ${i}×${j} centres ${d.toFixed(1)} vs ${(LEAF_CLUMP_SEP * meanDiameter).toFixed(1)}`)
            .toBeGreaterThanOrEqual(LEAF_CLUMP_SEP * meanDiameter)
          // …but they DO overlap: fallen leaves lie on one another
          expect(d, `${kind} ${i}×${j} still a clump`).toBeLessThan(a.r + b.r)
          // (b) YAW DELTA — an overlap must read as two leaves crossing, not as
          //     one thicker leaf.
          const raw = Math.abs(a.yaw - b.yaw) % (Math.PI * 2)
          const dYaw = Math.min(raw, Math.PI * 2 - raw)
          expect(dYaw, `${kind} ${i}×${j} yaw delta ${dYaw.toFixed(2)}`).toBeGreaterThanOrEqual(LEAF_CLUMP_YAW_MIN)
        }
      }
      // (c) THE AIR GAP. The die-cut is 1.5% of the blade radius thick
      //     (0.4 units on a board blade), which makes the TIP CURL the taller of
      //     the two reliefs — so the stack step is thickness + half the curl,
      //     and each blade still clears the one below by LEAF_CLUMP_AIR of that
      //     step. A pure-thickness step would now let an upper blade's flat
      //     centre sink through a lower blade's raised lobe.
      for (let i = 1; i < blades.length; i++) {
        const gap = blades[i].seat - blades[i - 1].seat
        const prev = blades[i - 1]
        const t = LEAF_THICK_FRAC * prev.size
        expect(gap / t, `${kind} blade ${i} clears blade ${i - 1}`).toBeGreaterThan(1 + LEAF_CLUMP_AIR - 1e-6)
        // …and it clears the lower blade's ROLLED edge too: the
        // roll lifts one side of a die-cut by |sin roll| × |x|, so the step has
        // to cover that lift where the blades actually overlap, with
        // LEAF_CLUMP_AIR still on top of it
        const rolled = Math.abs(Math.sin(prev.roll)) * (LEAF_W / 4) * prev.size
        expect(gap, `${kind} blade ${i} clears blade ${i - 1}'s rolled edge`).toBeGreaterThan(
          (t + 0.5 * LEAF_CURL_FRAC * LEAF_RADIUS * prev.size + rolled) * (1 + LEAF_CLUMP_AIR) - 1e-6,
        )
      }
      // …and the clump's radius is what the registry quotes
      expect(radius, `${kind} radius`).toBeGreaterThan(0)
    }

    // and the BUILT clump really is a pile: slice it by height and every blade
    // must occupy its own band with air above it
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    const build = buildDecorMeshes(canadiana, fakePlacement(['maple-leaf-cluster']), { lit: true })
    const geo = meshesOf(build)[0].geometry
    const pos = geo.getAttribute('position')
    const ys: number[] = []
    for (let i = 0; i < pos.count; i++) ys.push(pos.getY(i))
    const layout = mapleClumpLayout('cluster')
    // the LOWEST vertex is now the contact decal, which seats DECAL_CLEAR (0.3)
    // above the city paving clearance the desk props respect
    expect(Math.min(...ys), 'the clump seats on the paving clearance').toBeCloseTo(2.0, 5)
    // four distinct plate bands, in the authored order
    const seats = layout.blades.map((b) => b.seat)
    for (let i = 1; i < seats.length; i++) {
      expect(seats[i], 'blades stack strictly upward').toBeGreaterThan(seats[i - 1])
    }
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('the autumn break is allocated BY SURFACE: amber on walnut, never on beige (round 4 #3)', () => {
    // A single global mix leaves every blade on the walnut the same saturated
    // crimson while the amber and tan instances sit on the BEIGE backdrop,
    // near-isoluminant with the wall — the tone variety spent where it cannot
    // be seen. A palette is a property of a leaf ON something, so the mix is
    // chosen by the archetype's SURFACE.
    const names = Object.keys(LEAF_PALETTE) as LeafToneName[]
    const hslOf = (hex: string) => {
      const c = new THREE.Color(hex)
      const o = { h: 0, s: 0, l: 0 }
      c.getHSL(o)
      return o
    }
    expect([...names].sort(), 'crimson, burnt orange, pale amber, dark brown').toEqual(
      ['amber', 'ochre', 'scarlet', 'vermillion'],
    )
    for (const surface of ['board', 'desk'] as const) {
      expect(
        Object.values(LEAF_TONE_MIX[surface]).reduce((a, b) => a + b, 0),
        `${surface} mix is a distribution`,
      ).toBeCloseTo(1, 6)
    }
    // BOTH surfaces carry all FOUR breaks. A desk mix of only
    // `{scarlet, ochre}` reads as near-black-brown specks on a beige bench.
    // Deleting a hue is the wrong instrument for an isoluminance problem; a
    // VALUE bias is the right one.
    for (const surface of ['board', 'desk'] as const) {
      expect(Object.keys(LEAF_TONE_MIX[surface]).sort(), `${surface} carries all four breaks`).toEqual(
        ['amber', 'ochre', 'scarlet', 'vermillion'],
      )
    }
    expect(LEAF_TONE_MIX.board.amber, 'amber is the tone that pops on walnut').toBeGreaterThan(0.1)
    // …and the desk's amber is the SAME hue, darkened, so it separates from the
    // bench by VALUE instead of sitting on top of it. Measured in sRGB, the
    // space the palette is authored in and the space "a value break" names —
    // THREE holds the WORKING/linear values, which would answer a different
    // question (and puts the two ambers equidistant from the bench, one above
    // and one below, which is precisely the distinction being made here).
    const rgb = (hex: string): [number, number, number] => {
      const n = parseInt(hex.slice(1), 16)
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
    }
    const luma = (hex: string): number => {
      const [r, g, b] = rgb(hex)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    /** sRGB hue in degrees — the space the palette is authored in. */
    const hueOf = (hex: string): number => {
      const [r, g, b] = rgb(hex)
      const mx = Math.max(r, g, b)
      const d = mx - Math.min(r, g, b)
      if (d === 0) return 0
      const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : mx === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6
      return h * 360
    }
    const BENCH = luma('#C8A87A')
    const boardAmber = leafTone('amber', 'gate', false, 'board')
    const deskAmber = leafTone('amber', 'gate', false, 'desk')
    expect(LEAF_SURFACE_L.desk.amber, 'the desk darkens amber').toBeLessThan(0.85)
    expect(Math.abs(hueOf(boardAmber.tip) - hueOf(deskAmber.tip)), 'same hue, both surfaces').toBeLessThan(2)
    // the blade's LIGHTEST end is the one that has to clear the bench, because
    // it is the value the eye latches onto on a light surface
    const vBoard = luma(boardAmber.tip) / BENCH
    const vDesk = luma(deskAmber.tip) / BENCH
    expect(vBoard, `board amber is ${vBoard.toFixed(2)}× the bench — isoluminant, hence the round-4 deletion`)
      .toBeGreaterThan(1.05)
    expect(vDesk, `desk amber is ${vDesk.toFixed(2)}× the bench`).toBeLessThan(0.8)
    // …and it is still a LEAF colour, not a brown: warm hue, real saturation
    expect(hslOf(deskAmber.tip).s, 'the darkened amber keeps its chroma').toBeGreaterThan(0.5)
    // …and after the bias the four desk breaks are still four: no two of them
    // may collapse into each other because one was moved
    const deskTones = names.map((n) => leafTone(n, 'gate', false, 'desk').tip)
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const dh = Math.abs(hueOf(deskTones[i]) - hueOf(deskTones[j]))
        const dl = Math.abs(luma(deskTones[i]) - luma(deskTones[j]))
        expect(dh > 10 || dl > 0.05, `desk ${names[i]} vs ${names[j]}: Δh ${dh.toFixed(1)}° Δv ${dl.toFixed(3)}`).toBe(
          true,
        )
      }
    }
    // …and the MUTED ochre is not mud: stacking sat × 0.60 on lightness × 0.92
    // turns the desk's dark break from "a leaf at a later stage of drying"
    // into a speck of dirt
    const mutedOchreS = hslOf(leafTone('ochre', 'gate', true, 'desk').base).s
    const plainOchreS = hslOf(leafTone('ochre', 'gate', false, 'desk').base).s
    expect(mutedOchreS / plainOchreS, 'muted ochre keeps its warmth').toBeGreaterThan(0.7)
    expect(mutedOchreS / plainOchreS, '…and is still visibly muted').toBeLessThan(0.95)

    const hsl = hslOf
    // (a) the four breaks are actually DISTINCT — a categorical break has to be
    //     legible as a category, so no two palette entries may sit within 0.05
    //     of luminance AND 12° of hue of each other
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = hsl(LEAF_PALETTE[names[i]])
        const b = hsl(LEAF_PALETTE[names[j]])
        const dh = Math.abs(a.h - b.h) * 360
        const dl = Math.abs(a.l - b.l)
        expect(
          dh > 12 || dl > 0.05,
          `${names[i]} vs ${names[j]}: Δhue ${dh.toFixed(1)}° Δlum ${dl.toFixed(3)}`,
        ).toBe(true)
      }
    }
    // …and PALE AMBER is genuinely the light one: it has to beat walnut by
    // value, not by hue, or it is just another warm blob on warm wood
    const WALNUT_L = hsl('#A9793F').l
    expect(hsl(LEAF_PALETTE.amber).l, 'amber is lighter than walnut').toBeGreaterThan(WALNUT_L + 0.05)
    expect(hsl(LEAF_PALETTE.ochre).l, 'ochre is the dark brown').toBeLessThan(WALNUT_L - 0.05)

    // (b) EVERY archetype's blades are declared, every declared tone is one of
    //     the four, and every declared tone is legal ON ITS OWN SURFACE
    const all = [...DECOR_PACKS.flatMap((p) => p.archetypes), ...DESK_ARCHETYPES]
    const leafArch = [...new Map(all.filter((a) => a.id.startsWith('maple-leaf')).map((a) => [a.id, a])).values()]
    for (const a of leafArch) {
      expect(LEAF_BLADES[a.id], `${a.id} declares its blades`).toBeTruthy()
      const surface = LEAF_SURFACE[a.id]
      expect(surface, `${a.id} declares its surface`).toBe(a.zone ?? 'board')
      for (const b of LEAF_BLADES[a.id]) {
        expect(names).toContain(b.tone)
        expect(LEAF_TONE_MIX[surface][b.tone], `${a.id} blade ${b.tone} is legal on ${surface}`).toBeGreaterThan(0)
      }
    }
    expect(Object.keys(LEAF_BLADES).sort(), 'no orphan blade declaration').toEqual(leafArch.map((a) => a.id).sort())

    // (c) THE MIX, PER SURFACE, weighted by how many blades each archetype can
    //     actually put on the scene (its supply ceiling). This is the number
    //     that decides what the eye sees.
    const supply: Record<string, number> = {}
    for (const a of leafArch) supply[a.id] = a.maxCount ?? a.baseCount
    let muted = 0
    let blades = 0
    for (const surface of ['board', 'desk'] as const) {
      const tally: Record<string, number> = {}
      let total = 0
      for (const a of leafArch) {
        if (LEAF_SURFACE[a.id] !== surface) continue
        for (const b of LEAF_BLADES[a.id]) {
          tally[b.tone] = (tally[b.tone] ?? 0) + supply[a.id]
          total += supply[a.id]
          blades += supply[a.id]
          if (b.muted) muted += supply[a.id]
        }
      }
      expect(total, `${surface} carries leaves at all`).toBeGreaterThan(0)
      for (const [n, target] of Object.entries(LEAF_TONE_MIX[surface])) {
        const share = (tally[n] ?? 0) / total
        expect(share, `${surface}/${n} ${(share * 100).toFixed(1)}% vs target ${((target as number) * 100).toFixed(0)}%`)
          .toBeGreaterThan((target as number) - 0.07)
        expect(share, `${surface}/${n} ${(share * 100).toFixed(1)}%`).toBeLessThan((target as number) + 0.07)
      }
      // no break may own the surface (80% of one red reads as a monotone)
      expect(Math.max(...Object.values(tally)) / total, `${surface}: no averaged monotone`).toBeLessThan(0.6)
      // …and the dark break stays a SEASONING on BOTH surfaces (a desk share
      // as high as 45% reads as near-black specks on beige)
      const dark = (tally[LEAF_DARK_TONE] ?? 0) / total
      expect(dark, `${surface} dark share ${(dark * 100).toFixed(0)}%`).toBeLessThanOrEqual(LEAF_DARK_SHARE_MAX)
    }

    // (d) SATURATION varies too, not just hue: about one blade in four is a
    //     desaturated, browned variant, so a drift is not a swatch strip.
    const mutedShare = muted / blades
    expect(mutedShare, `muted share ${(mutedShare * 100).toFixed(0)}%`).toBeGreaterThan(LEAF_MUTED_SHARE - 0.1)
    expect(mutedShare, `muted share ${(mutedShare * 100).toFixed(0)}%`).toBeLessThan(LEAF_MUTED_SHARE + 0.1)
    // …and the flag is not decorative: a SHIPPED muted blade really is less
    // saturated than the same tone unmuted, measured on the built clump rather
    // than on the function (the plain/muted pair do not both live inside one
    // clump)
    const allBlades = (['pair', 'pairB', 'drift', 'cluster', 'bank'] as LeafClumpKind[]).flatMap(
      (k) => mapleClumpLayout(k).blades,
    )
    const mutedBlade = allBlades.find((b) => b.muted)!
    expect(mutedBlade, 'a muted blade ships').toBeTruthy()
    const plainSame = leafTone(mutedBlade.toneName, 'gate', false)
    expect(hsl(mutedBlade.tone.base).s, 'the muted blade is desaturated').toBeLessThan(hsl(plainSame.base).s * 0.95)

    // (e) HUE JITTER stays under the cap, so the break stays categorical.
    const byName = new Map<LeafToneName, number[]>()
    for (const kind of ['pair', 'pairB', 'drift', 'bank'] as LeafClumpKind[]) {
      for (const b of mapleClumpLayout(kind).blades) {
        if (b.muted) continue // the muted variant is a deliberate hue push
        const h = hsl(b.tone.base).h * 360
        byName.set(b.toneName, [...(byName.get(b.toneName) ?? []), h])
      }
    }
    for (const [n, hs] of byName) {
      if (hs.length < 2) continue
      // CIRCULAR distance — scarlet sits at hue ≈ 1°, so a −4° jitter lands at
      // 357° and a linear spread would read as 356°
      let spread = 0
      for (const a of hs) {
        for (const b of hs) {
          const d = Math.abs(a - b) % 360
          spread = Math.max(spread, Math.min(d, 360 - d))
        }
      }
      expect(spread, `${n} hue spread ${spread.toFixed(1)}°`).toBeLessThanOrEqual(2 * LEAF_HUE_JITTER_MAX + 1e-6)
    }

    // (f) …and a built clump really does carry several tones — one geometry,
    //     several vertex-colour populations (the contact decal is α < 1 and is
    //     excluded, being black by construction)
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    const build = buildDecorMeshes(canadiana, fakePlacement(['maple-leaf-cluster']), { lit: true })
    const col = meshesOf(build)[0].geometry.getAttribute('color')
    expect(col.itemSize, 'RGBA vertex colours carry the contact shadow').toBe(4)
    const hues = new Set<string>()
    for (let i = 0; i < col.count; i++) {
      if (col.getW(i) < 0.99) continue
      const o = { h: 0, s: 0, l: 0 }
      new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)).getHSL(o)
      if (o.l > 0.05) hues.add((Math.round(o.h * 360) / 4).toFixed(0))
    }
    expect(hues.size, 'the clump is several tones, not one').toBeGreaterThanOrEqual(3)
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('every leaf is GROUNDED by a drawn contact shadow (round 4 #2)', () => {
    // Without a contact shadow, leaves read as decals printed on the wood
    // grain, while the cards, the moose and the cup show grounding AO. The
    // shadow pass cannot provide one: the sun's
    // `normalBias = 1.5` world units means a receiver samples the shadow map 1.5
    // units above itself, and a 0.4-unit-thick blade lying on a board is simply
    // not between that sample point and the sun. No seat height fixes it without
    // making the leaf hover.
    //
    // So the shadow is DRAWN into the archetype geometry: still ONE InstancedMesh
    // per archetype, still deterministic, and it survives every LOD because it is
    // geometry rather than a shadow-map sample.
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    const build = buildDecorMeshes(canadiana, fakePlacement(['maple-leaf-mini', 'maple-leaf-cluster']), { lit: true })
    const meshes = meshesOf(build)
    expect(meshes.length, 'still one draw per archetype').toBe(2)

    for (const mesh of meshes) {
      const id = String(mesh.userData.decorArchetype)
      const geo = mesh.geometry
      const col = geo.getAttribute('color')
      const pos = geo.getAttribute('position')
      expect(col.itemSize, `${id} carries RGBA`).toBe(4)

      // (a) THE MATERIAL CONTRACT. Alpha only blends on a transparent material,
      //     and depthWrite MUST be off or the decal's α = 0 rim punches
      //     invisible holes in whatever is drawn behind it.
      const mat = mesh.material as THREE.MeshStandardMaterial
      expect(mat.transparent, `${id} blends its decal`).toBe(true)
      expect(mat.depthWrite, `${id} does not write depth`).toBe(false)
      expect(mat.vertexColors, `${id} reads the attribute`).toBe(true)
      // …and it no longer casts: a hard silhouette of the decal DISC is exactly
      // what a drawn contact shadow must not be doubled by
      expect(mesh.castShadow, `${id} leaves the shadow map`).toBe(false)
      expect(mesh.receiveShadow, `${id} still receives`).toBe(true)

      // (b) THE DECAL EXISTS, is BLACK, and its alpha ramps to zero at the rim.
      const decal: { x: number; y: number; z: number; a: number }[] = []
      let opaque = 0
      for (let i = 0; i < col.count; i++) {
        const a = col.getW(i)
        if (a > 0.99) {
          opaque++
          continue
        }
        expect(col.getX(i) + col.getY(i) + col.getZ(i), `${id} decal vertex is black`).toBeLessThan(1e-6)
        decal.push({ x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i), a })
      }
      expect(opaque, `${id} blade vertices are opaque`).toBeGreaterThan(100)
      expect(decal.length, `${id} has a decal`).toBeGreaterThan(30)
      const maxA = Math.max(...decal.map((d) => d.a))
      expect(maxA, `${id} centre alpha`).toBeCloseTo(LEAF_SHADOW_ALPHA, 5)
      expect(Math.min(...decal.map((d) => d.a)), `${id} rim alpha reaches zero`).toBeCloseTo(0, 6)

      // (c) IT LIES ON THE SURFACE, UNDER THE BLADE, and under the sun's
      //     normalBias line so it can never be rasterised into the shadow map.
      const decalY = decal.map((d) => d.y)
      const spread = Math.max(...decalY) - Math.min(...decalY)
      expect(spread, `${id} decal is flat`).toBeLessThan(1e-6)
      expect(Math.min(...decalY), `${id} decal is the lowest thing in the prop`).toBeCloseTo(
        Math.min(...Array.from({ length: pos.count }, (_, i) => pos.getY(i))),
        6,
      )
      const bladeMinY = Math.min(
        ...Array.from({ length: pos.count }, (_, i) => (col.getW(i) > 0.99 ? pos.getY(i) : Infinity)),
      )
      expect(bladeMinY - decalY[0], `${id} the blade sits above its own shadow`).toBeGreaterThan(0.5)
      const surfaceY = LEAF_SURFACE[id] === 'desk' ? 1.7 : 0
      expect(decalY[0] - surfaceY, `${id} decal clearance`).toBeGreaterThan(0)
      expect(decalY[0] - surfaceY, `${id} decal stays under the 1.5 normalBias line`).toBeLessThan(1.5)

      // (d) IT IS OFFSET ALONG THE KEY-LIGHT VECTOR — a contact shadow that sits
      //     dead under its caster is the decal look this replaces. The sun is at
      //     azimuth −55°, elevation 38° (lit/lighting.ts), so the offset runs
      //     +X / −Z, and its magnitude is the blade's own height over tan(38°).
      const cx = decal.reduce((s, d) => s + d.x, 0) / decal.length
      const cz = decal.reduce((s, d) => s + d.z, 0) / decal.length
      const bladeCx =
        Array.from({ length: pos.count }, (_, i) => (col.getW(i) > 0.99 ? pos.getX(i) : 0)).reduce((a, b) => a + b, 0) /
        opaque
      const bladeCz =
        Array.from({ length: pos.count }, (_, i) => (col.getW(i) > 0.99 ? pos.getZ(i) : 0)).reduce((a, b) => a + b, 0) /
        opaque
      expect(cx - bladeCx, `${id} shadow leans away from the sun in X`).toBeGreaterThan(0.2)
      expect(cz - bladeCz, `${id} shadow leans away from the sun in Z`).toBeLessThan(-0.1)
      expect(LEAF_SHADOW_PER_HEIGHT[0], 'key-light offset, X').toBeGreaterThan(0)
      expect(LEAF_SHADOW_PER_HEIGHT[1], 'key-light offset, Z').toBeLessThan(0)
      // AND IT IS FAR ENOUGH OUT TO BE SEEN. An offset of only h / tan(38°)
      // leaves the SINGLES ungrounded: a lone blade's mean height is ~1.4
      // units, and a 1.8-unit slide under a 29-unit opaque disc is
      // concentric, i.e. invisible. LEAF_SHADOW_OFFSET slides it a further 0.35
      // of the blade's own radius along the sun azimuth — 2-3 px at delivered
      // size, enough to read as contact, too little to be a second silhouette.
      const clumpB = mapleClumpLayout('cluster').blades
      const bladeR0 =
        id === 'maple-leaf-cluster'
          ? clumpB.reduce((s, b) => s + b.r, 0) / clumpB.length
          : mapleSingleRadius('mini')
      const slide = Math.hypot(cx - bladeCx, cz - bladeCz)
      expect(slide / bladeR0, `${id} shadow slides ${(slide / bladeR0).toFixed(2)} R`).toBeGreaterThan(
        LEAF_SHADOW_OFFSET * 0.6,
      )
      expect(slide / bladeR0, `${id} …and never becomes a second silhouette`).toBeLessThan(0.9)

      // (e) IT IS BIGGER THAN THE BLADE — 1.15× the rotation-safe radius, which
      //     is what makes it read as a soft pool rather than a printed copy.
      expect(LEAF_SHADOW_R, 'decal radius factor').toBeGreaterThan(1.05)
      const decalR = Math.max(...decal.map((d) => Math.hypot(d.x - cx, d.z - cz)))
      const bladeR =
        id === 'maple-leaf-cluster' ? mapleClumpLayout('cluster').blades[0].r : mapleSingleRadius('mini')
      expect(decalR, `${id} decal radius ${decalR.toFixed(1)} vs blade ${bladeR.toFixed(1)}`).toBeGreaterThan(bladeR)
    }
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })
  it('the FLAG wears the same maple, on a foot that reads and a pole that lands', () => {
    // Three separate properties, one gate.
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    const build = buildDecorMeshes(canadiana, fakePlacement(['canada-flag']), { lit: true })
    const geo = meshesOf(build)[0].geometry
    const pos = geo.getAttribute('position')
    const col = geo.getAttribute('color')

    // (a) THE EMBLEM IS ITS OWN THREE-LOBE STENCIL — the blade's
    //     eleven points are unreadable at the ~16 px the glyph is delivered at.
    //     The stencil's own shape is gated above; this measures how it lands.
    expect(FLAG_EMBLEM_OUTLINE).not.toBe(MAPLE_LEAF_OUTLINE)
    //     …at FLAG_EMBLEM_FRAC of the white field's HEIGHT (sizing off the
    //     field's WIDTH puts the crown on the top hem with a gap under the
    //     foot), centred, with a real white margin on all four sides. Measured
    //     on the built prop: the red emblem vertices standing PROUD of the
    //     sheet's front face.
    // the emblem is the only RED part that stands clear of the cloth's own
    // ±SHEET_T/2 slab (the steel clips also stand proud, hence the colour test)
    const RED_C = new THREE.Color(FLAG_RED)
    const proud: { x: number; y: number }[] = []
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i) - furlZ(pos.getX(i))
      const isRed = Math.abs(col.getX(i) - RED_C.r) < 0.02 && col.getY(i) < 0.3
      if (isRed && Math.abs(z) > FLAG.SHEET_T / 2 + 0.1) proud.push({ x: pos.getX(i), y: pos.getY(i) })
    }
    expect(proud.length, 'the emblem stands proud of the cloth').toBeGreaterThan(20)
    const cx = FLAG.POLE_R + FLAG.SHEET_W / 2
    const eW = Math.max(...proud.map((p) => p.x)) - Math.min(...proud.map((p) => p.x))
    const eH = Math.max(...proud.map((p) => p.y)) - Math.min(...proud.map((p) => p.y))
    const band = FLAG.SHEET_W / 2
    expect(eH / FLAG.SHEET_H, `emblem is ${((eH / FLAG.SHEET_H) * 100).toFixed(0)}% of the field height`).toBeCloseTo(
      FLAG_EMBLEM_FRAC,
      2,
    )
    // centred in both axes — and because the outline carries a STEM, the
    // bbox centre it is centred on is the whole glyph's centre, so the stem
    // occupies what would otherwise be a gap under the foot
    expect((Math.max(...proud.map((p) => p.x)) + Math.min(...proud.map((p) => p.x))) / 2).toBeCloseTo(cx, 1)
    expect((Math.max(...proud.map((p) => p.y)) + Math.min(...proud.map((p) => p.y))) / 2).toBeCloseTo(FLAG.SHEET_Y, 1)
    // a real white margin all round — the thing 0.5 was protecting
    expect((band - eW) / 2, 'side margin').toBeGreaterThan(3)
    expect((FLAG.SHEET_H - eH) / 2, 'top/bottom margin').toBeGreaterThan(3)
    // …and the glyph is still BIG: the emblem is the one element in the scene
    // whose whole job is to be recognised, so it may not shrink below 55% of
    // the band's width while it is being re-centred
    expect(eW / band, `emblem is ${((eW / band) * 100).toFixed(0)}% of the white band`).toBeGreaterThan(0.55)

    // (b) 1:2:1 RED-WHITE-RED. Sample the sheet's front face across its width.
    const RED = RED_C
    let redSpan = 0
    let whiteSpan = 0
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i) - furlZ(pos.getX(i))
      if (Math.abs(z + FLAG.SHEET_T / 2) > 0.05) continue
      if (Math.abs(pos.getY(i) - FLAG.SHEET_Y) > FLAG.SHEET_H / 2 + 0.01) continue
      const isRed = Math.abs(col.getX(i) - RED.r) < 0.02 && col.getY(i) < 0.3
      const u = Math.abs(pos.getX(i) - cx)
      if (isRed) redSpan = Math.max(redSpan, u)
      else whiteSpan = Math.max(whiteSpan, u)
    }
    expect(redSpan, 'the red bands reach the fly and the hoist').toBeCloseTo(FLAG.SHEET_W / 2, 1)
    expect(whiteSpan, 'the white square is exactly half the sheet').toBeCloseTo(FLAG.SHEET_W / 4, 1)

    // (c) THE FOOT. A base plate wide enough to be a foot, tinted AGAINST the
    //     workbench rather than with it (a #C0A886 disc on a #C8A87A bench is
    //     present in the geometry, absent on the screen), and a
    //     pole that terminates ON the plane it stands on: no vertex below zero,
    //     and the whole prop lifted clear of the city background's paving
    //     planes (+0.45 / +0.95 / +1.4).
    geo.computeBoundingBox()
    expect(geo.boundingBox!.min.y, 'the prop is authored standing on y = 0').toBeCloseTo(0, 5)
    // …and the INSTANCE lifts it clear of the city background's paving planes
    // (+0.45 / +0.95 / +1.4 above the desk); otherwise its lower end appears to
    // pass below the desk surface
    const im = new THREE.Matrix4()
    meshesOf(build)[0].getMatrixAt(0, im)
    expect(im.elements[13], 'the foot clears every paving plane').toBeGreaterThanOrEqual(1.4)
    const foot = { r: 0, lum: 1 }
    const bench = new THREE.Color('#C8A87A')
    const benchLum = 0.2126 * bench.r + 0.7152 * bench.g + 0.0722 * bench.b
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 3.5) continue
      foot.r = Math.max(foot.r, Math.hypot(pos.getX(i), pos.getZ(i)))
      foot.lum = Math.min(foot.lum, 0.2126 * col.getX(i) + 0.7152 * col.getY(i) + 0.0722 * col.getZ(i))
    }
    expect(foot.r, 'a foot, not a wire in a hole').toBeGreaterThan(6 * FLAG.POLE_R)
    expect(Math.abs(foot.lum - benchLum) / benchLum, 'the foot reads against the bench').toBeGreaterThan(0.25)
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('the tips CURL, and the lid still renders as ONE surface — no pinwheel (round 4 #1 holds)', () => {
    // Cupping the blade and re-running computeVertexNormals fails: the lid is
    // a triangle FAN over a concave polygon, so every fan triangle picks up
    // its own normal and the flat face renders as value wedges radiating to
    // each lobe tip. Forbidding deformation entirely makes the leaves read as
    // decals. The curl is instead built under a rule that makes the pinwheel
    // UNREACHABLE: the lift,
    // and therefore the normal, is a function of RADIUS ONLY, so two fan
    // triangles at the same radius get the same normal by construction. This
    // gate measures exactly that, straight off the built blade.
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    const build = buildDecorMeshes(canadiana, fakePlacement(['maple-leaf-mini']), { lit: true })
    const geo = meshesOf(build)[0].geometry
    const pos = geo.getAttribute('position')
    const nrm = geo.getAttribute('normal')
    // THE BLADE'S OWN FRAME. Every blade's crown is lifted by LEAF_LIE, a
    // rigid rotation applied AFTER the curl, so world +Y is no longer the
    // blade's plane normal and world XZ is no longer the frame the curl was
    // authored in. Recover both: the flattest lid normal (the innermost lid
    // vertex, which the curl never touches) IS the plane normal, and rotating
    // it back onto +Y undoes the lie and the roll exactly — a rigid rotation
    // cannot change any distance, so the recovered radii are the curl's own.
    // (The blade is one die-cut and every lid vertex belongs to it.)
    // (the CONTACT DECAL is also a +Y face and sits nearer the prop's own axis
    // than any lid vertex, so it would win the `centre` pick outright — it is
    // excluded by its alpha, blades being opaque)
    const colA = geo.getAttribute('color')
    const raw: { n: THREE.Vector3; p: THREE.Vector3 }[] = []
    for (let i = 0; i < nrm.count; i++) {
      if (Math.abs(nrm.getY(i)) < 0.8 || colA.getW(i) < 0.99) continue
      raw.push({
        n: new THREE.Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i)),
        p: new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)),
      })
    }
    const centre = raw.reduce((best, t) => (t.p.x ** 2 + t.p.z ** 2 < best.p.x ** 2 + best.p.z ** 2 ? t : best))
    const planeN = centre.n.clone().multiplyScalar(Math.sign(centre.n.y) || 1)
    // (LEAF_LIE is a small 1.5°: leaves lie "nearly flat on the surface", and
    // the "not a decal" job is done by a drawn contact shadow. What this line
    // still guards is that a lie EXISTS,
    // so the frame recovery below is exercising the code path it was written
    // for, and that it is SMALL enough to be a lie rather than a stand-up.)
    // …and the plane normal decomposes exactly, because the die-cut is built by
    // rotateZ(roll) then rotateX(lie): n = (−sin roll, cos roll·cos lie,
    // cos roll·sin lie). The ROLL reaches ±0.20 rad while the LIE stays small,
    // and the two have to be gated separately — a big crown lift reads as a
    // "claw", whereas a roll tips
    // one half of the blade toward the camera with the other half still on the
    // deck, which is exactly what breaks coplanarity without standing the leaf
    // up. Measuring only the combined angle cannot tell them apart.
    const rollAngle = Math.asin(Math.min(1, Math.max(-1, -planeN.x)))
    const lieAngle = Math.atan2(planeN.z, planeN.y)
    expect(lieAngle, 'the blade is canted by LEAF_LIE').toBeGreaterThan(0.02)
    expect(lieAngle * (180 / Math.PI), 'the CROWN stays nearly flat on the surface').toBeLessThan(6)
    expect(Math.abs(rollAngle), 'the blade is rolled about its own stem→crown axis').toBeGreaterThan(0.1)
    expect(Math.abs(rollAngle), 'the roll stays inside the budget').toBeLessThanOrEqual(LEAF_ROLL_MAX + 1e-6)
    // …and the whole plane still never approaches a stand-up
    expect(planeN.angleTo(new THREE.Vector3(0, 1, 0)) * (180 / Math.PI), 'never on edge').toBeLessThan(14)
    const unlie = new THREE.Quaternion().setFromUnitVectors(planeN, new THREE.Vector3(0, 1, 0))
    // …about a point ON the blade's axis. Which point on the axis does not
    // matter for the ROTATION, but it does for the recovered radii, and the
    // exact one is not readable off the finished geometry: the seating
    // translation is folded into the vertices. So the un-lie is done about the
    // top-lid plane's axis point and the residual — a constant XZ offset of
    // (lid height above the true origin) × sin(LEAF_LIE) ≈ 0.4 units — is
    // solved for below, from the normals themselves.
    const pivot = new THREE.Vector3(
      0,
      centre.p.y + (planeN.x * centre.p.x + planeN.z * centre.p.z) / planeN.y,
      0,
    )
    const top: { r: number; n: THREE.Vector3; p: THREE.Vector3 }[] = []
    const bottom: { r: number; n: THREE.Vector3; p: THREE.Vector3 }[] = []
    for (const t of raw) {
      const n = t.n.clone().applyQuaternion(unlie)
      const p = t.p.clone().sub(pivot).applyQuaternion(unlie)
      if (Math.abs(n.y) < 0.9) continue
      const rec = { r: Math.hypot(p.x, p.z), n, p }
      if (n.y > 0) top.push(rec)
      else bottom.push(rec)
    }
    expect(top.length, 'the top lid has vertices').toBeGreaterThan(10)
    expect(bottom.length, 'the two lids are congruent').toBe(top.length)
    const up = new THREE.Vector3(0, 1, 0)
    const tilt = (t: { n: THREE.Vector3 }) => Math.acos(Math.min(1, Math.max(-1, t.n.dot(up))))

    // THE AXIS, solved from the normals. `curlLeafTips` tips every lid normal
    // straight DOWNHILL — its horizontal component points at the blade's axis,
    // by construction. So every curled vertex contributes a LINE through the
    // axis, and the axis is the least-squares intersection of those lines
    // (2×2 normal equations on the perpendicular residuals). This is also why
    // it is a better pinwheel probe than a bucket: a fan artefact makes the
    // normals point per-triangle instead of radially, and the lines then have
    // no common intersection at all.
    let a11 = 0
    let a12 = 0
    let a22 = 0
    let b1 = 0
    let b2 = 0
    const lines: { p: THREE.Vector3; ux: number; uz: number }[] = []
    for (const t of top) {
      const hx = t.n.x
      const hz = t.n.z
      const h = Math.hypot(hx, hz)
      if (h < 1e-3) continue // dead-flat centre: no direction to contribute
      // unit perpendicular to the normal's horizontal direction
      const ux = -hz / h
      const uz = hx / h
      const s = ux * t.p.x + uz * t.p.z
      a11 += ux * ux
      a12 += ux * uz
      a22 += uz * uz
      b1 += ux * s
      b2 += uz * s
      lines.push({ p: t.p, ux, uz })
    }
    expect(lines.length, 'the curl gives the normals a direction').toBeGreaterThan(8)
    const det = a11 * a22 - a12 * a12
    expect(Math.abs(det), 'the lines really do span the plane').toBeGreaterThan(1e-6)
    const axisX = (b1 * a22 - b2 * a12) / det
    const axisZ = (a11 * b2 - a12 * b1) / det
    // …and they all pass through it: the residual is the pinwheel measure
    for (const l of lines) {
      const resid = Math.abs(l.ux * (axisX - l.p.x) + l.uz * (axisZ - l.p.z))
      expect(resid, 'every lid normal points at ONE axis').toBeLessThan(0.05)
    }
    for (const t of [...top, ...bottom]) t.r = Math.hypot(t.p.x - axisX, t.p.z - axisZ)
    const R = Math.max(...top.map((t) => t.r))

    // (a) the inner half of the blade is DEAD FLAT — a leaf LIES on the
    //     surface; only its tips lift
    // (1e-3: normals live in a Float32Array and acos is ill-conditioned at
    // dot ≈ 1, so the quantization floor is ~3e-4 rad — 0.02°)
    for (const t of top) {
      if (t.r / R < 0.5) expect(tilt(t), 'the blade centre stays flat').toBeLessThan(1e-3)
    }
    // (b) the tips really do lift — a curl that does not curl is a decal. The
    //     amplitude is 4% of the blade RADIUS (~9% is too much), which lands
    //     the steepest lid slope at
    //     0.18 rad ≈ 10°: enough that two overlapping blades separate by
    //     SHADING instead of by a black seam, small enough that "nearly flat on
    //     the surface with a slight curl at the tips" is still true.
    expect(LEAF_CURL_FRAC, 'the curl is 4% of the blade radius').toBeCloseTo(0.04, 6)
    expect(Math.max(...top.map(tilt)), 'the tips curl').toBeGreaterThan(0.12)
    // (c) …but never so far that the lid stops reading as one surface. Measured
    //     against the BLADE'S plane, not world up: the rigid lie moves the
    //     whole lid together and so cannot break it, only the curl can.
    expect(Math.max(...top.map(tilt)), 'the lid still shades as a lid').toBeLessThan(0.28)
    // (d) THE PINWHEEL GATE: tilt is a function of radius alone. Bucket the
    //     lid by radius; inside a bucket every vertex must agree. A fan
    //     artefact is exactly a disagreement here.
    const buckets = new Map<number, number[]>()
    for (const t of top) {
      const k = Math.round((t.r / R) * 40)
      buckets.set(k, [...(buckets.get(k) ?? []), tilt(t)])
    }
    expect(buckets.size, 'the lid spans many radii').toBeGreaterThan(8)
    for (const [k, vals] of buckets) {
      expect(Math.max(...vals) - Math.min(...vals), `radius bucket ${k} shades as one value`).toBeLessThan(0.02)
    }
    // …and it rises monotonically outward (no ripples). 1e-6, not 1e-9: the
    // normals are Float32 and the un-lie rotation above is a float quaternion,
    // so equal values arrive a few 1e-8 apart.
    const means = [...buckets.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([, v]) => v.reduce((s, q) => s + q, 0) / v.length)
    for (let i = 1; i < means.length; i++) {
      expect(means[i], `curl rises outward at bucket ${i}`).toBeGreaterThanOrEqual(means[i - 1] - 1e-6)
    }

    // (e) the curl is a RIGID VERTICAL SHEAR, so the die-cut keeps its exact
    //     thickness everywhere — and that thickness is a leaf's, not a foam
    //     board's
    geo.computeBoundingBox()
    const width = geo.boundingBox!.getSize(new THREE.Vector3()).x
    const gaps: number[] = []
    for (const t of top) {
      let best = bottom[0]
      let bd = Infinity
      for (const b of bottom) {
        const d = Math.hypot(t.p.x - b.p.x, t.p.z - b.p.z)
        if (d < bd) {
          bd = d
          best = b
        }
      }
      gaps.push(t.p.clone().sub(best.p).dot(up))
    }
    expect(Math.max(...gaps) - Math.min(...gaps), 'the shear preserves thickness').toBeLessThan(1e-3)
    // THICKNESS is measured against the blade's own RADIUS, not the geometry's
    // bounding box — the box now includes the contact decal, which is 1.15× the
    // blade and offset along the key light. 1.5% of the radius: at ~7% the
    // wall reads as a black seam between overlapping blades.
    const bladeR = mapleSingleRadius('mini')
    expect(gaps[0] / bladeR, 'leaf thickness').toBeCloseTo(0.015, 4)
    expect(width, 'the decal widens the prop past the blade').toBeGreaterThan(2 * bladeR)
    // the WALL follows the outline: 37 boundary segments at their own azimuths,
    // so a horizontal-normal census finds many distinct directions. A blade
    // whose wall collapsed to a couple of normals would be an extruded blob.
    const lateral = new Set<string>()
    for (let i = 0; i < nrm.count; i++) {
      if (Math.abs(nrm.getY(i)) < 0.3) lateral.add(`${nrm.getX(i).toFixed(2)}|${nrm.getZ(i).toFixed(2)}`)
    }
    expect(lateral.size, 'the wall follows all 37 boundary segments').toBeGreaterThan(20)
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('the leaves scatter like FALLEN LITTER: full-circle yaw, tilted, re-seated (round 7 #1)', () => {
    // Folding every leaf onto a narrow yaw band (so the camera's ground-plane
    // squash always lands on the stem→crown axis) is defensible arithmetic,
    // but it makes all leaves point the same screen direction at zero tilt —
    // the loudest procedural-scatter tell there is. What must hold is: the yaw really walks the whole circle, no angle is
    // unreachable, every blade is tilted OUT of the ground plane, about one in
    // six is propped steeply, and none of it costs the contact with the desk.
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!

    // AWAY FROM THE DEPTH AXIS. Along LEAF_READ_AXIS — the camera's own depth
    // axis — a ground-plane die-cut is compressed by sin(35°) ALONG its
    // stem→apex axis and the five lobes project onto one another: a ~90×30 px
    // smear with zero lobe articulation. The mapping is a FENCE plus a lean
    // away from that axis.

    // (a) THE FENCE. No `u` anywhere in [0,1) may produce an apex azimuth
    //     within LEAF_YAW_FORBID of the depth axis (or its opposite — the
    //     squash is an axis, so `depthAxisOffset` folds modulo π).
    const N = 512
    const seq = Array.from({ length: N }, (_, i) => scatterYaw(i / N, LEAF_SCATTER.bias))
    for (const y of seq) {
      expect(depthAxisOffset(y), `yaw ${y.toFixed(3)} clears the depth axis`).toBeGreaterThanOrEqual(
        LEAF_YAW_FORBID - 1e-9,
      )
    }
    expect(LEAF_YAW_FORBID * (180 / Math.PI), 'the fence is the critic’s 25°').toBeCloseTo(25, 6)
    // …and it is a fence, not a band: the allowed set is TWO 130° arcs, i.e.
    // 72% of the circle still reachable, which keeps the "every apex points
    // the same screen direction" tell dead.
    const reach = new Set(seq.map((y) => Math.floor((((y % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 18))))
    expect(reach.size / 36, 'the allowed set is ~72% of the circle').toBeGreaterThan(0.65)

    // (b) MONOTONIC INSIDE EACH ARC, so no angle in the allowed set is
    //     unreachable — a lean is not a second fence
    for (const [lo, hi] of [[0, N / 2], [N / 2, N]] as const) {
      for (let i = lo + 1; i < hi; i++) expect(seq[i], `yaw rises at ${i}`).toBeGreaterThan(seq[i - 1])
      expect(seq[hi - 1] - seq[lo], 'the arc really is ~130° wide').toBeGreaterThan(Math.PI - 2 * LEAF_YAW_FORBID - 0.02)
    }
    expect(LEAF_SCATTER.bias, 'the bias is a lean, not a lock').toBeLessThan(0.6)
    // …and the peak is BROADSIDE now: the arc centre, 90° off the depth axis,
    // where a fallen blade shows the camera its full width
    expect(depthAxisOffset(scatterYaw(0.25, LEAF_SCATTER.bias)), 'the density peak is broadside').toBeCloseTo(
      Math.PI / 2,
      6,
    )
    const broad = seq.filter((y) => depthAxisOffset(y) > Math.PI / 4).length
    expect(broad / N, 'most blades are nearer broadside than the fence').toBeGreaterThan(0.6)
    // …and the whole pose is a PURE function of the placement's propId, which
    // is what keeps a scene bit-identical run to run (the determinism gate
    // above builds twice and compares every matrix)
    expect(scatterPoseOf('maple-leaf-mini:3:7', LEAF_SCATTER)).toEqual(scatterPoseOf('maple-leaf-mini:3:7', LEAF_SCATTER))
    expect(scatterPoseOf('maple-leaf-mini:3:7', LEAF_SCATTER).yaw, 'neighbouring cells get their own pose').not.toBe(
      scatterPoseOf('maple-leaf-mini:3:8', LEAF_SCATTER).yaw,
    )

    // (c) THE FENCE HOLDS PER BLADE, not merely per instance. A clump's blades
    //     carry baked in-clump yaw offsets on top of the instance yaw, so the
    //     archetype widens its own fence by the largest deviation its rows take
    //     from the two anchors {0, π} (`mapleClumpFence`). Checked end to end:
    //     every clump kind, every row, over the whole `u` range.
    for (const kind of ['pair', 'pairB', 'drift', 'cluster', 'bank'] as LeafClumpKind[]) {
      expect(mapleClumpYawDev(kind), `${kind} rows stay near {0, π}`).toBeLessThanOrEqual(LEAF_CLUMP_YAW_DEV_MAX)
      const fence = mapleClumpFence(kind)
      for (const b of mapleClumpLayout(kind).blades) {
        for (let i = 0; i < 128; i++) {
          const yaw = scatterYaw(i / 128, LEAF_SCATTER.bias, fence) + b.yaw
          expect(depthAxisOffset(yaw), `${kind} blade at u=${(i / 128).toFixed(2)}`).toBeGreaterThanOrEqual(
            LEAF_YAW_FORBID - 1e-9,
          )
        }
      }
    }

    // (b) the SHIPPED instances, straight off the built matrices
    const placed: PlacedProp[] = Array.from({ length: 60 }, (_, i) => ({
      propId: `maple-leaf-cluster:${i}:0`,
      archetypeId: 'maple-leaf-cluster',
      x: i * 200,
      z: 0,
      rotY: (i / 60) * Math.PI * 2,
      scale: 1,
      onPlatform: false,
      onDesk: true,
    }))
    const build = buildDecorMeshes(canadiana, placed, { lit: true, deskLift: 0 })
    const mesh = meshesOf(build)[0]
    const src = mesh.geometry
    src.computeBoundingBox()
    const baseMinY = src.boundingBox!.min.y
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const t = new THREE.Vector3()
    const s = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    const octants = new Set<number>()
    const tilts: number[] = []
    const cants: number[] = []
    let propped = 0
    let worstSeat = Infinity
    let worstHover = 0
    const vpos = src.getAttribute('position')
    const v = new THREE.Vector3()
    for (let i = 0; i < placed.length; i++) {
      mesh.getMatrixAt(i, m)
      m.decompose(t, q, s)
      // the blade's plane normal is local +Y carried by the instance rotation:
      // its TILT off world up is the out-of-plane rocking, and its azimuth
      // combined with the yaw tells which way the leaf faces
      const n = up.clone().applyQuaternion(q)
      const tilt = n.angleTo(up)
      tilts.push(tilt)
      // "propped" is the steep tail (LEAF_SCATTER.propTilt starts at 2°), and
      // the threshold sits between the two ranges. The whole scale is small:
      // 16-26° tilts read as blades standing on edge, and leaves must lie
      // "nearly flat".
      if (tilt > (2.1 * Math.PI) / 180) propped++
      // …and it cants TOWARD the viewer, never away: the tilt scales the
      // blade's face by sin(35° ± t), so the wrong sign turns a foreshortened
      // blade into a red sliver. The arc is wide (±43°) so neighbours never
      // lean alike, but it never crosses into leaning away.
      const cant = Math.atan2(n.x, n.z)
      const off = Math.abs(((cant - LEAF_READ_AXIS + Math.PI) % (Math.PI * 2)) - Math.PI)
      expect(off, `instance ${i} shows its face to the camera`).toBeLessThanOrEqual(LEAF_SCATTER.cantArc + 1e-6)
      cants.push(off * Math.sign(cant - LEAF_READ_AXIS))
      const yaw = Math.atan2(m.elements[8], m.elements[10])
      octants.add(Math.floor((((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)))
      // …and the SHIPPED instance yaw clears the depth axis by the archetype's
      // own (clump-widened) fence — this is the smear gate, measured on the
      // instance matrix rather than on the mapping
      expect(depthAxisOffset(yaw), `instance ${i} clears the depth axis`).toBeGreaterThanOrEqual(
        mapleClumpFence('cluster') - 1e-6,
      )
      // …and it still SITS on the desk: lowest vertex at the same height the
      // untilted archetype seats at, never below it and never hovering
      let minY = Infinity
      for (let k = 0; k < vpos.count; k++) {
        const y = v.fromBufferAttribute(vpos, k).applyQuaternion(q).y
        if (y < minY) minY = y
      }
      const contact = t.y + minY * s.y
      worstSeat = Math.min(worstSeat, contact - baseMinY)
      worstHover = Math.max(worstHover, contact - baseMinY)
    }
    // NEARLY THE WHOLE CIRCLE — the fence closes two 50° arcs, so two of the
    // eight octants are only a third reachable AND sit at the thin end of the
    // density lean; six full octants is the honest claim.
    expect(octants.size, 'the yaw walks nearly the whole circle').toBeGreaterThanOrEqual(6)
    // EVERY blade is tilted out of the ground plane — but only just: 1-2°,
    // with a 2-3.5° propped tail. That is what keeps the blades NEARLY FLAT
    // and it is also what makes the merged
    // contact decal possible: at 26° a decal of radius 29 swings ±13 units out
    // of the surface and reads as a floating ellipse; at 2° it swings ±1.0.
    expect(Math.min(...tilts) * (180 / Math.PI), 'no blade lies dead flat').toBeGreaterThan(0.8)
    expect(Math.max(...tilts) * (180 / Math.PI), 'and none stands on edge').toBeLessThan(4)
    // …and about one in six is PROPPED, as if leaning on a neighbour
    expect(propped / placed.length, `propped share ${propped}/${placed.length}`).toBeGreaterThan(0.05)
    expect(propped / placed.length).toBeLessThan(0.3)
    // …and the cant really spends its arc — a single stamped lean would be as
    // bad as a single stamped yaw
    expect(Math.max(...cants) - Math.min(...cants), 'the cant is an arc, not one angle').toBeGreaterThan(
      LEAF_SCATTER.cantArc,
    )
    // THE RE-SEAT: the tilt never sinks a blade into the surface, and never
    // leaves one hovering either — the lift is the exact drop of the lowest
    // vertex, not a bounding-radius estimate.
    expect(worstSeat, 'no tilted blade sinks below its contact plane').toBeGreaterThanOrEqual(0)
    expect(worstHover, 'no tilted blade hovers').toBeLessThan(0.2)
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('a clump is a DRIFT, not one stamp turned N times (round 7 #1)', () => {
    // "the dark+gold pair repeats 3× at identical relative offset/scale/yaw in
    // that same crop". Two answers, both structural:
    //  1. inside a clump the blades now walk the whole circle relative to each
    //     other, so a drift is 2-4 different leaves and not one leaf copied;
    //  2. the pair ships as TWO independent arrangements, so the same couple
    //     cannot appear three times on one board.
    const KINDS: LeafClumpKind[] = ['pair', 'pairB', 'drift', 'cluster']
    const spreadOf = (k: LeafClumpKind): number => {
      const ys = mapleClumpLayout(k).blades.map((b) => b.yaw)
      let worst = 0
      for (const a of ys) {
        for (const b of ys) {
          const d = Math.abs(((a - b + Math.PI) % (Math.PI * 2)) - Math.PI)
          worst = Math.max(worst, d)
        }
      }
      return worst
    }
    for (const k of KINDS) {
      expect(spreadOf(k) * (180 / Math.PI), `${k} blades point different ways`).toBeGreaterThan(60)
    }
    // the two pair variants are genuinely different couples: partner scale,
    // separation and both yaws
    const a = mapleClumpLayout('pair')
    const b = mapleClumpLayout('pairB')
    const ratio = (l: typeof a): number => Math.min(...l.blades.map((x) => x.size)) / Math.max(...l.blades.map((x) => x.size))
    expect(Math.abs(ratio(a) - ratio(b)), 'different partner scale').toBeGreaterThan(0.15)
    for (const l of [a, b]) {
      expect(ratio(l), 'the partner is 0.55-0.85 of the lead blade').toBeGreaterThan(0.55)
      expect(ratio(l)).toBeLessThan(0.85)
    }
    const sep = (l: typeof a): number =>
      Math.hypot(l.blades[0].cx - l.blades[1].cx, l.blades[0].cz - l.blades[1].cz) / l.blades[0].r
    for (const l of [a, b]) {
      expect(sep(l), 'the partner sits 0.6-1.4 leaf radii away').toBeGreaterThan(0.6)
      expect(sep(l)).toBeLessThan(1.4)
    }
    expect(Math.abs(sep(a) - sep(b)), 'different separation').toBeGreaterThan(0.15)
    expect(new Set([...a.blades, ...b.blades].map((x) => x.toneName)).size, 'four breaks across the two pairs').toBe(4)
    // …and the registry ships them as separate archetypes, each capped low
    // enough that neither couple can repeat three times on one board
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    for (const id of ['maple-leaf-pair', 'maple-leaf-pair-b']) {
      const arch = canadiana.archetypes.find((x) => x.id === id)!
      expect(arch.maxCount, `${id} cannot repeat three times`).toBeLessThanOrEqual(2)
    }
    // …and the in-clump offsets really do walk the circle (a ±0.18 wobble
    // reads as one stamp repeated)
    expect(Math.max(...LEAF_CLUMP_YAWS.map(Math.abs)), 'in-clump yaws walk the circle').toBeGreaterThan(1.5)
  })

  it('the leaves POPULATE the board the way the trees do (round 5, user ask #2)', () => {
    // Maple leaves should be visible on the scene the way trees are. The
    // TREES are the benchmark, so the gate is a comparison against them on
    // the same board — not a number pulled out of the air. The fixture is a
    // realistic diagram shape: five cards inside one group boundary. Both
    // block cells, which can starve the count on a real diagram while a bare
    // synthetic board looks fine.
    const nodes = [
      { id: 'api', type: 'container', rect: { x: 60, y: 420, w: 210, h: 130 } },
      { id: 'web', type: 'container', rect: { x: 330, y: 250, w: 210, h: 130 } },
      { id: 'worker', type: 'container', rect: { x: 330, y: 40, w: 210, h: 130 } },
      { id: 'gw', type: 'container', rect: { x: 620, y: 120, w: 210, h: 130 } },
      { id: 'db', type: 'store', rect: { x: 620, y: 400, w: 210, h: 130 } },
    ]
    const scene = (archetypes: PlacementInput['archetypes'], seed: number): PlacedProp[] =>
      placeDecor({
        archetypes,
        density: 'normal',
        seed,
        bounds: { x: 0, y: 0, w: 890, h: 580 },
        pad: { x: 88, y: 72 },
        fractureBand: 0,
        nodes,
        groups: [{ x: 20, y: 0, w: 850, h: 580 }],
        connections: [{ points: [{ x: 435, y: 380 }, { x: 165, y: 420 }] }],
        deskBand: 150,
      })
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    const greenery = DECOR_PACKS.find((p) => p.id === 'greenery')!
    const isBoardLeaf = (p: PlacedProp) => !p.onDesk && p.archetypeId.startsWith('maple-leaf')
    const isTree = (p: PlacedProp) =>
      !p.onDesk && (p.archetypeId.startsWith('tree') || p.archetypeId === 'planter-shrub')

    const CLUMP_IDS = ['maple-leaf-drift', 'maple-leaf-pair', 'maple-leaf-pair-b', 'maple-leaf-bank']
    const isClump = (p: PlacedProp) => CLUMP_IDS.includes(p.archetypeId)

    const SEEDS = 24
    let leaves = 0
    let blades = 0
    let trees = 0
    let clumps = 0
    let singles = 0
    let bare = 0
    let noClump = 0
    let greenLeafSeeds = 0
    let greenClumpSeeds = 0
    let deskClumpSeeds = 0
    let heroSeeds = 0
    let bigSeeds = 0
    let bankSeeds = 0
    let fourClumpSeeds = 0
    let tenBladeSeeds = 0
    let worstRim = Infinity
    const bladeCount: Record<string, number> = {
      'maple-leaf-mini': 1,
      'maple-leaf-mini-b': 1,
      'maple-leaf-mini-c': 1,
      'maple-leaf-pair': mapleClumpLayout('pair').blades.length,
      'maple-leaf-pair-b': mapleClumpLayout('pairB').blades.length,
      'maple-leaf-drift': mapleClumpLayout('drift').blades.length,
      'maple-leaf-bank': mapleClumpLayout('bank').blades.length,
    }
    const radiusOfId = (id: string): number => {
      const k = clumpKind(id)
      if (k) return mapleClumpLayout(k).radius
      const single: Record<string, 'mini' | 'miniB' | 'miniC'> = {
        'maple-leaf-mini': 'mini',
        'maple-leaf-mini-b': 'miniB',
        'maple-leaf-mini-c': 'miniC',
      }
      return mapleSingleRadius(single[id])
    }
    for (let s = 0; s < SEEDS; s++) {
      const seed = 0x51000 + s * 7919
      const c = scene([...canadiana.archetypes, ...DESK_ARCHETYPES], seed)
      const g = scene([...greenery.archetypes, ...DESK_ARCHETYPES], seed)
      const boardLeaves = c.filter(isBoardLeaf)
      leaves += boardLeaves.length
      const seedBlades = boardLeaves.reduce((n, p) => n + (bladeCount[p.archetypeId] ?? 1), 0)
      blades += seedBlades
      const seedClumps = c.filter(isClump).length
      clumps += seedClumps
      singles += boardLeaves.length - seedClumps
      trees += g.filter(isTree).length
      if (boardLeaves.length === 0) bare++
      if (!c.some(isClump)) noClump++
      if (seedClumps >= 4) fourClumpSeeds++
      if (seedBlades >= 10) tenBladeSeeds++
      if (c.some((p) => p.archetypeId === 'maple-leaf-bank')) bankSeeds++
      // The BANK rides 'near-connection', which is the one leaf
      // affinity without the 'open' band's own 30-px rim proof. So the rim
      // clearance is measured on the real placement instead of asserted: a
      // connection's points lie on card boundaries, i.e. ≥ pad inside the slab,
      // so a near-connection cell is ≥ pad − 34 from the rim.
      for (const p of boardLeaves) {
        const edgeD = Math.min(p.x + 88, p.z + 72, 890 + 88 - p.x, 580 + 72 - p.z)
        worstRim = Math.min(worstRim, edgeD - radiusOfId(p.archetypeId) * p.scale)
      }
      if (g.some(isBoardLeaf)) greenLeafSeeds++
      if (g.some(isClump)) greenClumpSeeds++
      if (c.some((p) => p.onDesk && p.archetypeId === 'maple-leaf-cluster')) deskClumpSeeds++
      // The HERO blade lives on the board, so "leaves you can actually see"
      // is a board question: at least one instance of the
      // full-size blade, and at least two leaves whose own radius is within
      // 20% of the rim budget (i.e. big, not confetti).
      if (c.some((p) => p.archetypeId === 'maple-leaf-mini')) heroSeeds++
      if (boardLeaves.filter((p) => p.archetypeId === 'maple-leaf-mini' || p.archetypeId === 'maple-leaf-drift').length >= 2)
        bigSeeds++
    }
    // as many leaf objects on the paper as the greenery pack lands trees…
    expect(
      leaves / SEEDS,
      `board leaves ${(leaves / SEEDS).toFixed(2)} vs trees ${(trees / SEEDS).toFixed(2)}`,
    ).toBeGreaterThanOrEqual(0.8 * (trees / SEEDS))
    // …but never a carpet (the cards still have to carry the story)
    expect(leaves / SEEDS, 'garnish, not a lawn').toBeLessThan(2 * (trees / SEEDS))
    // …and counted in BLADES (a clump is 2-4 leaves), the paper really is
    // populated the way the trees populate it
    expect(blades / SEEDS, `blades ${(blades / SEEDS).toFixed(2)}`).toBeGreaterThan(trees / SEEDS)
    // …at least TWO clumps per board on average — "loose drifts of 2-4
    // leaves, SEVERAL drifts" — and never a board that is singles only
    expect(clumps / SEEDS, 'several drifts, not only singles').toBeGreaterThanOrEqual(2)
    expect(noClump, 'every seed puts at least one drift on the paper').toBe(0)

    // ── THE SUPPLY IS CLUMP-FIRST ───────────────────────────────────────────
    // A handful of leaves in the frame, a bare mid-board band and trees
    // outnumbering leaves do not read as fall. Singles stay the minority: a
    // ~3:1 clump-to-single ratio is what reads as fall rather than litter.
    //
    // The default framing shows most, not all, of the paper, so the board-wide
    // numbers are gated above the framing targets rather than at them.
    expect(blades / SEEDS, `${(blades / SEEDS).toFixed(1)} blades/board vs the ≥10 in frame`).toBeGreaterThanOrEqual(14)
    expect(clumps / SEEDS, `${(clumps / SEEDS).toFixed(1)} clumps/board vs the ≥4 in frame`).toBeGreaterThanOrEqual(5.5)
    expect(tenBladeSeeds / SEEDS, 'every board carries ≥10 blades').toBeGreaterThanOrEqual(0.95)
    expect(fourClumpSeeds / SEEDS, 'every board carries ≥4 drifts').toBeGreaterThanOrEqual(0.9)
    // …with the singles a genuine minority
    expect(clumps / Math.max(1, singles), `clump:single = ${(clumps / singles).toFixed(1)}:1`).toBeGreaterThan(2)
    // …and the mid-board band gets its own archetype: the BANK collects in a
    // cable's 10-34 px shoulder, which is exactly the mid-board band that
    // otherwise stays bare, and it is the only leaf that banks against an
    // obstacle at all
    expect(bankSeeds / SEEDS, 'leaves bank against a cable run').toBeGreaterThanOrEqual(0.8)
    // …without ever straddling the slab bevel (the affinity that buys the
    // banking is the one without the 'open' rim proof — so it is measured)
    expect(worstRim, `worst rim clearance ${worstRim.toFixed(1)} px`).toBeGreaterThan(0)
    // …and never a board with no leaf at all: MapleSpire's own mark has to be
    // in the default hero framing, seed after seed
    expect(bare, 'every seed puts leaves on the paper').toBe(0)
    // the desk drift is there too, seed after seed
    expect(deskClumpSeeds / SEEDS, 'a leaf drift on the desk').toBeGreaterThanOrEqual(0.9)
    // …and a LEAFY scene carries them alongside the trees — singles AND drifts
    expect(greenLeafSeeds / SEEDS, 'greenery carries maples too').toBeGreaterThanOrEqual(0.9)
    expect(greenClumpSeeds / SEEDS, 'greenery carries leaf drifts too').toBeGreaterThanOrEqual(0.7)
    // …and the READABLE ones are in the default framing, seed after seed: the
    // hero blade is a board prop precisely so this is a claim
    // about the paper the camera centres on, not about the desk annulus.
    expect(heroSeeds / SEEDS, 'the hero blade lands every seed').toBeGreaterThanOrEqual(0.9)
    expect(bigSeeds / SEEDS, 'at least two BIG leaves per board').toBeGreaterThanOrEqual(0.8)
  })

  it('a canadiana desk shows BOTH the flag and a leaf drift, seed after seed (round 4 #6)', () => {
    // "a single red leaf … alone in an empty floor quadrant, no companion leaf
    // and no flag nearby". The drift is a clump by construction, but a clump
    // with no flag on the desk is still the wrong picture, and the flag is
    // capped at one — so its candidate supply has to be generous enough that
    // the greedy collision pass lands it on almost every seed.
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    const merged = [...canadiana.archetypes, ...DESK_ARCHETYPES]
    let flags = 0
    let drifts = 0
    const SEEDS = 24
    for (let s = 0; s < SEEDS; s++) {
      const placed = placeDecor({
        archetypes: merged,
        density: 'normal',
        seed: 0x51000 + s * 7919,
        bounds: { x: 0, y: 0, w: 1100, h: 750 },
        pad: { x: 88, y: 72 },
        fractureBand: 0,
        nodes: [
          { id: 'a', type: 'app', rect: { x: 100, y: 100, w: 200, h: 120 } },
          { id: 'b', type: 'store', rect: { x: 620, y: 420, w: 175, h: 100 } },
        ],
        groups: [],
        connections: [{ points: [{ x: 300, y: 160 }, { x: 620, y: 470 }] }],
        deskBand: 150,
      })
      if (placed.some((p) => p.archetypeId === 'canada-flag')) flags++
      if (placed.some((p) => p.archetypeId === 'maple-leaf-cluster')) drifts++
    }
    expect(drifts / SEEDS, 'a leaf drift on the desk').toBeGreaterThanOrEqual(0.9)
    expect(flags / SEEDS, `the desk flag beside it ${flags}/${SEEDS}`).toBeGreaterThanOrEqual(0.9)
  })

  it('the canada-flag hoist is PINNED and VERTICAL, and the cloth furls (round 4 #3)', () => {
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    expect(SILHOUETTE_IDS, 'flag has geometry').toContain('canada-flag')
    expect(canadiana.archetypes.find((a) => a.id === 'canada-flag')?.maxCount, 'one flag, not a parade').toBe(1)
    const build = buildDecorMeshes(canadiana, fakePlacement(['canada-flag']), { lit: true })
    const meshes = meshesOf(build)
    expect(meshes.length).toBe(1)
    const geo = meshes[0].geometry
    expect(trisOf(geo), 'flag triangle cap').toBeLessThan(3500)
    geo.computeBoundingBox()
    const size = new THREE.Vector3()
    geo.boundingBox!.getSize(size)
    // a flag on a pole: clearly taller than it is wide, standing ON the desk
    expect(size.y, 'pole height').toBeGreaterThan(60)
    expect(size.y).toBeGreaterThan(size.x)
    expect(geo.boundingBox!.max.y, 'FLAG_HEIGHT is honest').toBeCloseTo(FLAG_HEIGHT, 5)
    expect(geo.boundingBox!.min.y, 'base rests on the desk').toBeGreaterThan(-0.5)
    expect(geo.boundingBox!.min.y).toBeLessThan(0.5)
    // the sheet hoists to ONE side of the pole (the reference's desk flag)
    expect(geo.boundingBox!.max.x, 'sheet flies clear of the pole').toBeGreaterThan(35)

    const pos = geo.getAttribute('position')
    const colors = geo.getAttribute('color')
    // undo the furl to measure the cloth in its own flat frame: the sheet's
    // faces sit at ±SHEET_T/2 there, the proud emblem past them
    const flatZ = (i: number) => pos.getZ(i) - furlZ(pos.getX(i))
    // …and only cloth colours count: the pole/finial/clips also cross z = 0
    const isCloth = (i: number) => {
      const r = colors.getX(i)
      const g = colors.getY(i)
      const b = colors.getZ(i)
      return (r > 0.3 && g < 0.15 && b < 0.15) || Math.min(r, g, b) > 0.55
    }
    const isSheet = (i: number) =>
      pos.getY(i) > 20 && isCloth(i) && Math.abs(flatZ(i)) <= FLAG.SHEET_T / 2 + 1e-6
    let sheetMinX = Infinity
    let sheetMaxX = -Infinity
    let sheetMinY = Infinity
    let sheetMaxY = -Infinity
    let whiteMinX = Infinity
    let whiteMaxX = -Infinity
    let red = 0
    let white = 0
    for (let i = 0; i < pos.count; i++) {
      const r = colors.getX(i)
      const g = colors.getY(i)
      const b = colors.getZ(i)
      if (r > 0.3 && g < 0.15 && b < 0.15) red++
      if (Math.min(r, g, b) > 0.55) white++
      if (!isSheet(i)) continue
      const isWhite = Math.min(r, g, b) > 0.55
      const isRed = r > 0.3 && g < 0.15 && b < 0.15
      if (!isWhite && !isRed) continue
      sheetMinX = Math.min(sheetMinX, pos.getX(i))
      sheetMaxX = Math.max(sheetMaxX, pos.getX(i))
      sheetMinY = Math.min(sheetMinY, pos.getY(i))
      sheetMaxY = Math.max(sheetMaxY, pos.getY(i))
      if (isWhite) {
        whiteMinX = Math.min(whiteMinX, pos.getX(i))
        whiteMaxX = Math.max(whiteMaxX, pos.getX(i))
      }
    }
    expect(red, 'red bands + centre leaf').toBeGreaterThan(0)
    expect(white, 'white square').toBeGreaterThan(0)
    const sheetW = sheetMaxX - sheetMinX
    expect(sheetW / (sheetMaxY - sheetMinY), 'the sheet is 2:1').toBeCloseTo(2, 1)
    expect((whiteMinX - sheetMinX) / sheetW, 'hoist band ends at 0.25').toBeCloseTo(0.25, 2)
    expect((whiteMaxX - sheetMinX) / sheetW, 'fly band starts at 0.75').toBeCloseTo(0.75, 2)
    expect((whiteMaxX - whiteMinX) / sheetW, 'white square holds half the sheet').toBeGreaterThan(0.48)
    expect((whiteMaxX - whiteMinX) / sheetW).toBeLessThan(0.52)

    // ── the hoist edge is SNAPPED to the pole surface ──
    expect(sheetMinX, 'hoist edge pinned to the pole surface').toBeCloseTo(FLAG.POLE_R, 6)
    // …and it is VERTICAL: every vertex on that edge shares one x, and the
    // edge spans the sheet's full height. (The prop is authored axis-aligned
    // and the instance transform is a pure world-Y rotation — see the next
    // test — so a vertical hoist here is a vertical hoist on screen.)
    const hoist: number[] = []
    for (let i = 0; i < pos.count; i++) {
      if (isSheet(i) && Math.abs(pos.getX(i) - FLAG.POLE_R) < 1e-6) hoist.push(pos.getY(i))
    }
    expect(hoist.length, 'the hoist edge exists').toBeGreaterThan(3)
    expect(Math.max(...hoist) - Math.min(...hoist), 'hoist spans the sheet height').toBeCloseTo(
      FLAG.SHEET_H,
      5,
    )
    // ── FURL, not lean — zero at the hoist, ~6% at the fly ──
    expect(furlZ(FLAG.POLE_R), 'no displacement at the hoist').toBeCloseTo(0, 9)
    let maxFurl = 0
    for (let t = 0; t <= 1; t += 0.01) maxFurl = Math.max(maxFurl, Math.abs(furlZ(FLAG.POLE_R + t * FLAG.SHEET_W)))
    expect(maxFurl / FLAG.SHEET_W, 'the cloth curves ~6% of its width').toBeGreaterThan(0.04)
    expect(maxFurl / FLAG.SHEET_W).toBeLessThan(0.08)
    // the furl also has to be MONOTONE in amplitude out of the hoist, or the
    // cloth reads as a crease instead of a curl
    expect(Math.abs(furlZ(FLAG.POLE_R + 0.25 * FLAG.SHEET_W))).toBeLessThan(
      Math.abs(furlZ(FLAG.POLE_R + FLAG.SHEET_W)),
    )

    // ── the emblem is its OWN three-lobe stencil, centred ──
    let leafMinX = Infinity
    let leafMaxX = -Infinity
    let leafMinY = Infinity
    let leafMaxY = -Infinity
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < 20 || Math.abs(flatZ(i)) <= FLAG.SHEET_T / 2 + 1e-6 || pos.getX(i) < 10) continue
      leafMinX = Math.min(leafMinX, pos.getX(i))
      leafMaxX = Math.max(leafMaxX, pos.getX(i))
      leafMinY = Math.min(leafMinY, pos.getY(i))
      leafMaxY = Math.max(leafMaxY, pos.getY(i))
    }
    const band = whiteMaxX - whiteMinX
    // The emblem is scaled from the white field's HEIGHT, which is
    // what "fills the square" means, and its own proportion is the STENCIL's,
    // not the blade's. The width then follows, and has to keep a real margin.
    expect((leafMaxY - leafMinY) / (sheetMaxY - sheetMinY), 'emblem height vs the field').toBeCloseTo(
      FLAG_EMBLEM_FRAC,
      2,
    )
    expect((leafMaxX - leafMinX) / band, 'emblem width vs the white band').toBeGreaterThan(0.55)
    expect((leafMaxX - leafMinX) / band, 'emblem width vs the white band').toBeLessThan(0.85)
    expect((leafMaxY - leafMinY) / (leafMaxX - leafMinX), 'the emblem is the 3-lobe stencil').toBeCloseTo(
      EMBLEM_H / EMBLEM_W,
      2,
    )
    expect((leafMinX + leafMaxX) / 2, 'emblem centred on the white band').toBeCloseTo(
      (whiteMinX + whiteMaxX) / 2,
      1,
    )
    expect((leafMinY + leafMaxY) / 2, 'emblem centred on the sheet height').toBeCloseTo(
      (sheetMinY + sheetMaxY) / 2,
      0,
    )
    // The emblem HAS a stem — the one cue that separates the
    // Canada leaf from a fleur-de-lis, and it survives because it lives on the
    // BOTTOM SILHOUETTE rather than inside the glyph. What sits at the foot is
    // therefore a narrow quad straddling the midrib, not a flat base.
    const foot: number[] = []
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < 20 || Math.abs(flatZ(i)) <= FLAG.SHEET_T / 2 + 1e-6 || pos.getX(i) < 10) continue
      if (pos.getY(i) < leafMinY + 1e-6) foot.push(pos.getX(i))
    }
    expect(foot.length, 'the emblem has a stem foot').toBeGreaterThan(1)
    expect((Math.min(...foot) + Math.max(...foot)) / 2, 'the stem straddles the midrib').toBeCloseTo(
      (leafMinX + leafMaxX) / 2,
      5,
    )
    const stemFrac = (Math.max(...foot) - Math.min(...foot)) / (leafMaxX - leafMinX)
    expect(stemFrac, `a stem, not a flat base (${(stemFrac * 100).toFixed(0)}% of the glyph width)`).toBeLessThan(0.2)
    expect(stemFrac, '…and not a hair either').toBeGreaterThan(0.04)
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('the flag sheet carries NO shear — pure world-Y yaw, folded broadside (round 4 #3a/#3c)', () => {
    const iso = CAMERA_PRESETS.iso
    const az = (iso.rz * Math.PI) / 180
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    const placed: PlacedProp[] = Array.from({ length: 16 }, (_, i) => ({
      propId: `canada-flag:${i}:0`,
      archetypeId: 'canada-flag',
      x: i * 200,
      z: 0,
      rotY: (i / 16) * Math.PI * 2,
      scale: 1,
      onPlatform: false,
      onDesk: true,
    }))
    const build = buildDecorMeshes(canadiana, placed, { lit: true, deskLift: -30 })
    const mesh = meshesOf(build)[0]
    const m = new THREE.Matrix4()
    const yaws = new Set<number>()
    for (let i = 0; i < placed.length; i++) {
      mesh.getMatrixAt(i, m)
      const e = m.elements
      // a pure rotation about world Y: the matrix' Y column is (0, s, 0) and
      // its X/Z columns have no Y component. Any shear/skew shows up here.
      expect(e[4], `instance ${i} no X-shear into Y`).toBeCloseTo(0, 10)
      expect(e[6], `instance ${i} no Z-shear into Y`).toBeCloseTo(0, 10)
      expect(e[1], `instance ${i} Y stays out of X`).toBeCloseTo(0, 10)
      expect(e[9], `instance ${i} Y stays out of Z`).toBeCloseTo(0, 10)
      expect(e[5], `instance ${i} vertical scale`).toBeCloseTo(1, 10)
      const yaw = Math.atan2(e[8], e[10])
      yaws.add(Math.round(yaw * 1e6))
      // …and the sheet's normal (local +Z after the yaw) points back at the
      // camera within the band, so the flag is never edge-on
      let off = yaw - az
      while (off > Math.PI) off -= Math.PI * 2
      while (off < -Math.PI) off += Math.PI * 2
      expect(Math.abs(off), `instance ${i} sheet stays broadside`).toBeLessThanOrEqual(
        FLAG_YAW_BAND.spread + 1e-9,
      )
    }
    expect(yaws.size, 'the band keeps per-instance variety').toBe(placed.length)
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })

  it('landmark caps: ONE cn-tower, at most a moose pair (critique #7)', () => {
    const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
    expect(canadiana.archetypes.find((a) => a.id === 'cn-tower')?.maxCount).toBe(1)
    expect(canadiana.archetypes.find((a) => a.id === 'moose')?.maxCount).toBe(2)
  })

  it('unlit builds stay unlit + un-tone-mapped (decor works on every theme)', () => {
    const pack = DECOR_PACKS[0]
    const build = buildDecorMeshes(pack, fakePlacement([pack.archetypes[0].id]), { lit: false })
    build.group.traverse((o) => {
      const mesh = o as THREE.InstancedMesh
      if (!mesh.isInstancedMesh) return
      expect((mesh.material as THREE.Material).type).toBe('MeshBasicMaterial')
      expect((mesh.material as THREE.Material).toneMapped).toBe(false)
      expect(mesh.castShadow).toBe(false)
    })
    disposeDecorBuild(build)
    disposeDecorGeometries()
  })
})
