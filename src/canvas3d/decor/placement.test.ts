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
import { applyPose, fitPoseToPoints, presetPose } from '../camera'
import { CAMERA_PRESETS } from '../presets'
import {
  cameraEyeOf,
  CITY_HOLE_APRON,
  MAX_PER_ARCHETYPE,
  MAX_TOTAL,
  placeDecor,
  type PlacementInput,
  type PropArchetype,
  type ShowcaseView,
  WILDLIFE_GAP,
  ZONE_CORNER_LOW,
  ZONE_GAP_MAX,
  ZONE_GAP_MIN,
  ZONE_REACH,
} from './placement'
import { BEAVER_DESK_GROWTH, BOARD_LEAF_CLEARANCE, DECOR_PACKS, DESK_ARCHETYPES, MOOSE_DESK_GROWTH } from './registry'

const ARCHETYPES: PropArchetype[] = [
  {
    id: 'person-standing',
    asset: 'person-standing',
    footprint: 10,
    affinity: 'near-node',
    weight: 1,
    scaleJitter: [0.9, 1.1],
    rotation: 'face-nearest-node',
    baseCount: 8,
  },
  {
    id: 'tree-round',
    asset: 'tree-round',
    footprint: 14,
    affinity: 'edge',
    weight: 1,
    scaleJitter: [0.8, 1.2],
    rotation: 'random-y',
    baseCount: 10,
  },
  {
    id: 'crate',
    asset: 'crate',
    footprint: 12,
    affinity: 'open',
    weight: 0.6,
    scaleJitter: [1, 1],
    rotation: 'grid',
    baseCount: 6,
  },
]

function input(overrides: Partial<PlacementInput> = {}): PlacementInput {
  return {
    archetypes: ARCHETYPES,
    density: 'normal',
    seed: 0xc0ffee,
    bounds: { x: 0, y: 0, w: 1100, h: 750 },
    pad: { x: 88, y: 72 },
    fractureBand: 0,
    nodes: [
      { id: 'a', type: 'app', rect: { x: 100, y: 100, w: 200, h: 120 } },
      { id: 'b', type: 'store', rect: { x: 620, y: 420, w: 175, h: 100 } },
    ],
    groups: [],
    connections: [{ points: [{ x: 300, y: 160 }, { x: 620, y: 470 }] }],
    ...overrides,
  }
}

describe('placeDecor (deterministic cell-hash placement)', () => {
  it('is exactly reproducible for identical input (golden determinism)', () => {
    const a = placeDecor(input())
    const b = placeDecor(input())
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(5) // a normal board actually gets dressed
  })

  it('changing the seed reshuffles; keeping it does not', () => {
    const base = placeDecor(input())
    const reseeded = placeDecor(input({ seed: 0xdead10c }))
    expect(reseeded).not.toEqual(base)
  })

  it('STABILITY: adding a node only disturbs props near it', () => {
    const before = placeDecor(input())
    const newNode = { id: 'c', type: 'app', rect: { x: 850, y: 150, w: 200, h: 120 } }
    const after = placeDecor(input({ nodes: [...input().nodes, newNode] }))

    const influence = (p: { x: number; z: number }) =>
      p.x > newNode.rect.x - 90 && p.x < newNode.rect.x + newNode.rect.w + 90 &&
      p.z > newNode.rect.y - 90 && p.z < newNode.rect.y + newNode.rect.h + 90

    const afterById = new Map(after.map((p) => [p.propId, p]))
    let surviving = 0
    for (const p of before) {
      if (influence(p)) continue // near the new node: allowed to change
      const twin = afterById.get(p.propId)
      // far props either keep their EXACT pose or (rarely) lose a greedy
      // collision slot to a re-decided neighbour — they must never MOVE
      if (twin) {
        expect(twin).toEqual(p)
        surviving++
      }
    }
    expect(surviving).toBeGreaterThan(before.filter((p) => !influence(p)).length * 0.8)
  })

  it('density is monotone: sparse ⊂ fewer, rich ⊃ more', () => {
    const sparse = placeDecor(input({ density: 'sparse' })).length
    const normal = placeDecor(input({ density: 'normal' })).length
    const rich = placeDecor(input({ density: 'rich' })).length
    expect(sparse).toBeLessThan(normal)
    expect(normal).toBeLessThan(rich)
  })

  it('never places inside a node footprint (+ label margin)', () => {
    const placed = placeDecor(input())
    for (const p of placed) {
      for (const n of input().nodes) {
        const inside =
          p.x > n.rect.x - 14 && p.x < n.rect.x + n.rect.w + 14 &&
          p.z > n.rect.y - 14 && p.z < n.rect.y + n.rect.h + 14
        expect(inside, `${p.propId} clear of node ${n.id}`).toBe(false)
      }
    }
  })

  it('respects prop-vs-prop spacing and the hard caps', () => {
    const placed = placeDecor(input({ density: 'rich', bounds: { x: 0, y: 0, w: 4000, h: 3000 } }))
    expect(placed.length).toBeLessThanOrEqual(MAX_TOTAL)
    const perArch = new Map<string, number>()
    for (const p of placed) perArch.set(p.archetypeId, (perArch.get(p.archetypeId) ?? 0) + 1)
    for (const [id, n] of perArch) expect(n, id).toBeLessThanOrEqual(MAX_PER_ARCHETYPE)
  })

  it('group platforms are walkable: interior dressed + onPlatform flags + rim clear', () => {
    // blocking the whole group rect would starve EVERY affinity on container
    // views (rings/connections/open all live inside the boundary) — only the
    // rim may block
    const g = { x: 40, y: 40, w: 800, h: 540 }
    const placed = placeDecor(input({ groups: [g] }))
    const on = placed.filter((p) => p.onPlatform)
    const off = placed.filter((p) => !p.onPlatform)
    expect(on.length, 'the platform interior gets dressed').toBeGreaterThan(0)
    expect(off.length, 'the paper outside still gets dressed').toBeGreaterThan(0)
    for (const p of placed) {
      const qx = Math.max(g.x - p.x, 0, p.x - (g.x + g.w))
      const qz = Math.max(g.y - p.z, 0, p.z - (g.y + g.h))
      const outside = Math.hypot(qx, qz)
      const rim = outside > 0 ? outside : Math.min(p.x - g.x, g.x + g.w - p.x, p.z - g.y, g.y + g.h - p.z)
      expect(rim, `${p.propId} keeps off the pedestal rim`).toBeGreaterThanOrEqual(11.9)
      expect(p.onPlatform, `${p.propId} onPlatform matches its side`).toBe(outside === 0)
    }
  })

  it('attractTypes does not starve the archetype (band-dilution correction)', () => {
    // one store among five nodes: the near-node band only rings the store,
    // so without the attract-share correction acceptance is diluted ~5x
    // and the pack's identity prop lands at ~2 board-wide
    const rack: PropArchetype = {
      id: 'rack',
      asset: 'rack',
      footprint: 14,
      affinity: 'near-node',
      attractTypes: ['store'],
      weight: 1,
      scaleJitter: [1, 1],
      rotation: 'grid',
      baseCount: 6,
    }
    const nodes = [
      { id: 'a', type: 'app', rect: { x: 80, y: 80, w: 180, h: 100 } },
      { id: 'b', type: 'app', rect: { x: 420, y: 80, w: 180, h: 100 } },
      { id: 'c', type: 'app', rect: { x: 80, y: 420, w: 180, h: 100 } },
      { id: 'd', type: 'app', rect: { x: 420, y: 420, w: 180, h: 100 } },
      { id: 's', type: 'store', rect: { x: 760, y: 250, w: 160, h: 100 } },
    ]
    const placed = placeDecor(input({ archetypes: [rack], nodes, connections: [] }))
    expect(placed.length, 'E[count] tracks baseCount, not baseCount/5').toBeGreaterThanOrEqual(4)
    for (const p of placed) {
      const nx = Math.max(760, Math.min(p.x, 760 + 160))
      const nz = Math.max(250, Math.min(p.z, 250 + 100))
      // band outer edge (70, scored at the CELL CENTER) + in-cell jitter (±3)
      expect(Math.hypot(p.x - nx, p.z - nz), `${p.propId} hugs the store`).toBeLessThanOrEqual(74)
    }
  })

  it('desk zone: props land ONLY in the annulus outside the slab, and only when deskBand is on', () => {
    const pencil: PropArchetype = {
      id: 'desk-pencil',
      asset: 'desk-pencil',
      footprint: 26,
      affinity: 'open',
      weight: 1,
      scaleJitter: [1, 1],
      rotation: 'random-y',
      baseCount: 3,
      zone: 'desk',
    }
    const withDesk = placeDecor(input({ archetypes: [...ARCHETYPES, pencil], deskBand: 150 }))
    const deskProps = withDesk.filter((p) => p.archetypeId === 'desk-pencil')
    expect(deskProps.length, 'the workbench gets dressed').toBeGreaterThan(0)
    const x0 = 0 - 88
    const z0 = 0 - 72
    const x1 = 1100 + 88
    const z1 = 750 + 72
    for (const p of withDesk) {
      const outside = p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1
      if (p.archetypeId === 'desk-pencil') {
        expect(p.onDesk, `${p.propId} flags onDesk`).toBe(true)
        expect(outside, `${p.propId} sits OUTSIDE the slab`).toBe(true)
        const dOut = Math.max(x0 - p.x, p.x - x1, z0 - p.z, p.z - z1)
        expect(dOut, `${p.propId} stays within the band`).toBeLessThanOrEqual(150 + 3)
      } else {
        expect(p.onDesk).toBe(false)
        expect(outside, `${p.propId} board prop stays on the slab`).toBe(false)
      }
    }
    // no deskBand (unlit host: there is no workbench plane) → zero desk props
    const noDesk = placeDecor(input({ archetypes: [...ARCHETYPES, pencil] }))
    expect(noDesk.filter((p) => p.archetypeId === 'desk-pencil')).toEqual([])
  })

  it('returns nothing on a board too small to dress', () => {
    expect(placeDecor(input({ bounds: { x: 0, y: 0, w: 40, h: 30 }, pad: { x: 10, y: 10 } }))).toEqual([])
  })

  it('stays off fractured terrain (grid-fracture inset)', () => {
    const noFracture = placeDecor(input())
    const fractured = placeDecor(input({ fractureBand: 60 }))
    const x0 = 0 - 88 + 60
    const z0 = 0 - 72 + 60
    const x1 = 1100 + 88 - 60
    const z1 = 750 + 72 - 60
    for (const p of fractured) {
      expect(p.x).toBeGreaterThan(x0)
      expect(p.x).toBeLessThan(x1)
      expect(p.z).toBeGreaterThan(z0)
      expect(p.z).toBeLessThan(z1)
    }
    // (no count comparison: the inset shifts the grid origin, so the hash
    // draws differ — the contract is the interior bound above, and both
    // boards still get dressed)
    expect(noFracture.length).toBeGreaterThan(0)
    expect(fractured.length).toBeGreaterThan(0)
  })
})

// ── crowd staging (no bare cards, no orphan pins) ──

/** The built-in maquette-people pack, verbatim (registry.ts values). */
const PEOPLE: PropArchetype[] = [
  { id: 'person-standing', asset: 'person-standing', footprint: 9, affinity: 'near-node', weight: 1, scaleJitter: [0.92, 1.08], rotation: 'face-nearest-node', baseCount: 4 },
  { id: 'person-standing-b', asset: 'person-standing-b', footprint: 9, affinity: 'near-node', weight: 1, scaleJitter: [0.9, 1.06], rotation: 'face-nearest-node', baseCount: 3 },
  { id: 'person-pointing', asset: 'person-pointing', footprint: 9, affinity: 'near-connection', weight: 0.8, scaleJitter: [0.92, 1.08], rotation: 'face-nearest-node', baseCount: 5 },
  { id: 'person-pair', asset: 'person-pair', footprint: 16, affinity: 'open', weight: 0.5, scaleJitter: [0.95, 1.05], rotation: 'random-y', baseCount: 3 },
]

/** A frozen snapshot of the merged canadiana + shared-desk lineup (some
 * values have since drifted from registry.ts — the placement contracts below
 * do not depend on them; the duplicate beaver/maple-leaf-cluster ids are
 * collapsed, as the host merge dedupes them anyway). Exercises the desk
 * visible-sector bias on a realistic desk prop mix. */
const DESK_SET: PropArchetype[] = [
  { id: 'moose', asset: 'moose', footprint: 34, affinity: 'open', weight: 0.9, scaleJitter: [0.92, 1.08], rotation: 'random-y', baseCount: 2, zone: 'desk' },
  { id: 'beaver', asset: 'beaver', footprint: 20, affinity: 'open', weight: 0.7, scaleJitter: [0.9, 1.1], rotation: 'random-y', baseCount: 2, zone: 'desk' },
  { id: 'loon', asset: 'loon', footprint: 18, affinity: 'open', weight: 0.6, scaleJitter: [0.9, 1.1], rotation: 'random-y', baseCount: 1, zone: 'desk' },
  { id: 'ranger-hat', asset: 'ranger-hat', footprint: 24, affinity: 'open', weight: 0.6, scaleJitter: [0.9, 1.05], rotation: 'random-y', baseCount: 1, zone: 'desk' },
  { id: 'maple-leaf-cluster', asset: 'maple-leaf-cluster', footprint: 26, affinity: 'open', weight: 0.8, scaleJitter: [0.85, 1.15], rotation: 'random-y', baseCount: 3, zone: 'desk' },
  { id: 'cn-tower', asset: 'cn-tower', footprint: 26, affinity: 'open', weight: 1, scaleJitter: [0.95, 1.05], rotation: 'random-y', baseCount: 1, zone: 'desk' },
  { id: 'compass', asset: 'compass', footprint: 16, affinity: 'open', weight: 0.5, scaleJitter: [0.9, 1.1], rotation: 'random-y', baseCount: 1, zone: 'desk' },
  { id: 'scalpel', asset: 'scalpel', footprint: 24, affinity: 'open', weight: 0.5, scaleJitter: [0.9, 1.1], rotation: 'random-y', baseCount: 1, zone: 'desk' },
  { id: 'desk-pencil', asset: 'desk-pencil', footprint: 30, affinity: 'open', weight: 1, scaleJitter: [0.9, 1.1], rotation: 'random-y', baseCount: 2, zone: 'desk' },
  { id: 'desk-cable-coil', asset: 'desk-cable-coil', footprint: 22, affinity: 'open', weight: 0.9, scaleJitter: [0.85, 1.15], rotation: 'random-y', baseCount: 2, zone: 'desk' },
  { id: 'desk-note', asset: 'desk-note', footprint: 20, affinity: 'open', weight: 0.7, scaleJitter: [0.9, 1.05], rotation: 'random-y', baseCount: 1, zone: 'desk' },
]

/** 5-card fixture (api/web/worker/gw/db). */
const FIVE_NODES = [
  { id: 'api', type: 'app', rect: { x: 80, y: 90, w: 200, h: 120 } },
  { id: 'web', type: 'app', rect: { x: 470, y: 80, w: 200, h: 120 } },
  { id: 'worker', type: 'app', rect: { x: 860, y: 100, w: 190, h: 110 } },
  { id: 'gw', type: 'app', rect: { x: 120, y: 480, w: 190, h: 110 } },
  { id: 'db', type: 'store', rect: { x: 640, y: 470, w: 190, h: 110 } },
]
const FIVE_CONNS = [
  { points: [{ x: 570, y: 200 }, { x: 400, y: 300 }, { x: 215, y: 480 }] },
  { points: [{ x: 280, y: 150 }, { x: 470, y: 140 }] },
  { points: [{ x: 180, y: 210 }, { x: 640, y: 520 }] },
  { points: [{ x: 955, y: 210 }, { x: 830, y: 470 }] },
]

const rectDist = (r: { x: number; y: number; w: number; h: number }, px: number, pz: number): number => {
  const nx = Math.max(r.x, Math.min(px, r.x + r.w))
  const nz = Math.max(r.y, Math.min(pz, r.y + r.h))
  return Math.hypot(px - nx, pz - nz)
}
const connDistTo = (conns: { points: { x: number; y: number }[] }[], px: number, pz: number): number => {
  let best = Infinity
  for (const c of conns) {
    for (let i = 1; i < c.points.length; i++) {
      const a = c.points[i - 1]
      const b = c.points[i]
      const dx = b.x - a.x
      const dz = b.y - a.y
      const len2 = dx * dx + dz * dz || 1
      const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.y) * dz) / len2))
      best = Math.min(best, Math.hypot(px - (a.x + t * dx), pz - (a.y + t * dz)))
    }
  }
  return best
}
const meanNN = (ps: { x: number; z: number }[]): number => {
  let sum = 0
  for (const p of ps) {
    let best = Infinity
    for (const q of ps) {
      if (q !== p) best = Math.min(best, Math.hypot(p.x - q.x, p.z - q.z))
    }
    sum += best
  }
  return sum / ps.length
}

describe('crowd staging (critic #5)', () => {
  it('sev7: at normal density EVERY card gets an attending person in its wall band, facing it', () => {
    // without the adjacency pass, the organic draw alone leaves several cards
    // bare on this fixture. The pass makes attendance structural, so it must
    // hold for ANY seed — spot-check five.
    for (const seed of [0xc0ffee, 0xbeef, 42, 7, 0x1234abcd]) {
      const placed = placeDecor(input({ archetypes: PEOPLE, nodes: FIVE_NODES, connections: FIVE_CONNS, seed }))
      for (const n of FIVE_NODES) {
        const ncx = n.rect.x + n.rect.w / 2
        const ncz = n.rect.y + n.rect.h / 2
        const attending = placed.filter((p) => {
          if (!p.archetypeId.startsWith('person')) return false
          const d = rectDist(n.rect, p.x, p.z)
          if (d < 13.9 || d > 45) return false
          // facing: rotY within 60° of the bearing to this card (pairs are
          // random-rot, so only the face-nearest-node archetypes qualify)
          if (p.archetypeId === 'person-pair') return false
          const want = Math.atan2(ncx - p.x, ncz - p.z)
          const diff = Math.abs(((((want - p.rotY) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
          return diff <= Math.PI / 3
        })
        expect(attending.length, `node ${n.id} @ seed ${seed} has an attendant`).toBeGreaterThanOrEqual(1)
      }
      // the guarantee band never puts a person on a cable ribbon/plug zone:
      // near-node people (organic + promoted) keep the plug corridor clear
      for (const p of placed) {
        if (p.archetypeId !== 'person-standing' && p.archetypeId !== 'person-standing-b') continue
        // cell center is what the engine scores; recover it from the propId
        const [, ix, iz] = p.propId.split(':')
        const cx = 0 - 88 + (Number(ix) + 0.5) * 20
        const cz = 0 - 72 + (Number(iz) + 0.5) * 20
        expect(connDistTo(FIVE_CONNS, cx, cz), `${p.propId} clears the cable corridor`).toBeGreaterThanOrEqual(10)
      }
    }
  })

  it('sev7 does not fire at sparse density (the guarantee is a normal+ contract)', () => {
    const sparse = placeDecor(input({ archetypes: PEOPLE, nodes: FIVE_NODES, connections: FIVE_CONNS, density: 'sparse' }))
    const normal = placeDecor(input({ archetypes: PEOPLE, nodes: FIVE_NODES, connections: FIVE_CONNS }))
    expect(sparse.length).toBeLessThan(normal.length)
  })

  it("sev4: free-floating 'open' people are capped — 2 at normal, rich keeps more (kind:'person' path)", () => {
    // id deliberately does NOT start with 'person': covers the kind field
    const crowdPair: PropArchetype = { id: 'crowd-pair', kind: 'person', asset: 'person-pair', footprint: 16, affinity: 'open', weight: 1, scaleJitter: [0.95, 1.05], rotation: 'random-y', baseCount: 12 }
    const free = (placed: { x: number; z: number }[], conns: typeof FIVE_CONNS) =>
      placed.filter(
        (p) =>
          connDistTo(conns, p.x, p.z) > 30 &&
          !placed.some((q) => q !== p && Math.hypot(p.x - q.x, p.z - q.z) <= 30),
      )
    // no cables at all: clustering can only come from other people
    const normal = placeDecor(input({ archetypes: [crowdPair], connections: [] }))
    const rich = placeDecor(input({ archetypes: [crowdPair], connections: [], density: 'rich' }))
    expect(free(normal, []).length, 'normal caps loners at 2').toBeLessThanOrEqual(2)
    expect(free(rich, []).length, 'rich caps loners at 4').toBeLessThanOrEqual(4)
    expect(free(rich, []).length, 'rich keeps more than normal may').toBeGreaterThan(2)
    // with cables the cap only ever hits loners — clustered people are exempt
    const withConns = placeDecor(input({ archetypes: [crowdPair], nodes: FIVE_NODES, connections: FIVE_CONNS }))
    expect(free(withConns, FIVE_CONNS).length).toBeLessThanOrEqual(2)
  })

  it('sev4: open people cluster on the cable shoulders — mean NN collapses vs the pre-fix engine', () => {
    // without clustering, this fixture + seed gives a uniform scatter
    // (n=6, meanNN≈255 — the 'orphan pins' read); with it, n=7, meanNN≈92 —
    // same crowd size, tight clusters.
    const pairHeavy: PropArchetype = { id: 'person-pair', asset: 'person-pair', footprint: 16, affinity: 'open', weight: 1, scaleJitter: [0.95, 1.05], rotation: 'random-y', baseCount: 12 }
    const placed = placeDecor(input({ archetypes: [pairHeavy], nodes: FIVE_NODES, connections: FIVE_CONNS, seed: 0xc0ffee }))
    expect(placed.length, 'crowd size comparable to pre-fix (6)').toBeGreaterThanOrEqual(4)
    expect(meanNN(placed), 'mean nearest-neighbour distance decreased').toBeLessThan(254.9)
    // and the drop is structural, not a lucky draw: most people sit within
    // the cluster radius of a cable or another person
    const clustered = placed.filter(
      (p) =>
        connDistTo(FIVE_CONNS, p.x, p.z) <= 30 ||
        placed.some((q) => q !== p && Math.hypot(p.x - q.x, p.z - q.z) <= 30),
    )
    expect(clustered.length / placed.length).toBeGreaterThanOrEqual(0.6)
  })

  it('desk visible-sector bias (critique #6): >=70% of desk props land in the DEFAULT-framing sectors', () => {
    // Which slice of the annulus the default framing (iso, azimuth 40°,
    // polar 55°) actually shows was measured by projecting real placements
    // through the real camera pose: the south band
    // falls BELOW the bottom crop (the framing fits the content with no
    // bottom margin), the east band hides behind the right details panel,
    // and the dressed, reliably visible desk is the frame's top-left — the
    // NW corner plus the W and N bands, grading away from that corner.
    // The bias is a pure sector multiplier — no camera input — so the
    // contract is geometric: pooled across seeds, at least 70% of desk
    // placements sit in the favoured NW/W/N sectors, and every seed
    // dresses the frame's LEFT margin (the W band's northern half), so the
    // left third of the frame is never bare.
    const x1 = 1100 + 88
    const z1 = 750 + 72
    const sector = (px: number, pz: number): { ox: number; oz: number } => ({
      ox: px < -88 ? -1 : px > x1 ? 1 : 0,
      oz: pz < -72 ? -1 : pz > z1 ? 1 : 0,
    })
    const favoured = (px: number, pz: number): boolean => {
      const { ox, oz } = sector(px, pz)
      return (ox === -1 && oz <= 0) || (oz === -1 && ox <= 0) // NW, W, N
    }
    let vis = 0
    let total = 0
    for (const seed of [0xc0ffee, 0xbeef, 42, 7, 0x1234abcd]) {
      const desk = placeDecor(input({ archetypes: DESK_SET, deskBand: 150, seed })).filter((p) => p.onDesk)
      expect(desk.length, `seed ${seed} still dresses the desk`).toBeGreaterThanOrEqual(6)
      const leftMargin = desk.filter((p) => {
        const { ox, oz } = sector(p.x, p.z)
        // W band northern half + NW corner = the default frame's left margin
        return ox === -1 && oz <= 0 && (p.z - -72) / 894 <= 0.5
      })
      expect(leftMargin.length, `seed ${seed} dresses the left margin`).toBeGreaterThanOrEqual(1)
      for (const p of desk) {
        total++
        if (favoured(p.x, p.z)) vis++
      }
    }
    expect(total, 'a meaningful pooled sample').toBeGreaterThanOrEqual(40)
    expect(vis / total, '>=70% of desk props face the default camera').toBeGreaterThanOrEqual(0.7)
    // determinism is untouched by the bias
    const a = placeDecor(input({ archetypes: DESK_SET, deskBand: 150 }))
    const b = placeDecor(input({ archetypes: DESK_SET, deskBand: 150 }))
    expect(a).toEqual(b)
  })

  it('desk showcase guarantee (critique #6): the largest desk prop always dresses the showcase window', () => {
    // the sector bias makes the visible top-left LIKELY to carry the
    // pack's showcase piece; the guarantee pass makes it structural — for
    // ANY seed, the largest-footprint desk archetype (canadiana's moose
    // here) has an instance in the showcase window: the W band's inner
    // ring, upper-middle stretch — the one slice where a TALL prop reads
    // whole at the default framing (the N band beheads tall props against
    // the frame top, and the band's south half slides off the left crop).
    // Window cells are scored at the CELL CENTER; the final point adds the
    // in-cell jitter, so the assertion allows the jitter margin (±10). The
    // bounds are the union of the primary tier (above the floating canvas
    // toolbar) and the crowd fallback tier — see the pass in placement.ts.
    const inWindow = (px: number, pz: number, slack: number): boolean => {
      const tz = (pz - -72) / 894
      return (
        px < -88 + slack && -88 - px <= 50 + slack &&
        tz >= 0.25 - slack / 894 && tz <= 0.46 + slack / 894
      )
    }
    for (const seed of [0xc0ffee, 0xbeef, 42, 7, 0x1234abcd, 1, 2, 3, 99, 0xfeed]) {
      const placed = placeDecor(input({ archetypes: DESK_SET, deskBand: 150, seed }))
      const moose = placed.filter((p) => p.archetypeId === 'moose' && p.onDesk)
      expect(
        moose.some((p) => inWindow(p.x, p.z, 10)),
        `seed ${seed}: a moose stands in the default frame's showcase window`,
      ).toBe(true)
    }
    // sparse density keeps the organic-only behaviour (garnish stays light)
    // and no deskBand means no desk at all — the guarantee never fires
    const noBand = placeDecor(input({ archetypes: DESK_SET }))
    expect(noBand.filter((p) => p.onDesk)).toEqual([])
  })

  it('sev8 (critique #7): a CROWDED desk never yields bbox overlap among desk props — the showcase pass relaxes its window, never the spacing', () => {
    // Boosted desk counts + rich density crowd the annulus. A 0.6-relaxed
    // Chebyshev spacing would let desk bodies interpenetrate ~40% of their
    // footprint (a promoted moose merged into a beaver pile reads as
    // physics-failed). Contract: for EVERY pair of
    // desk props, at least one axis clears the full footprint sum
    // (footprint·scale = rotation-safe half-extent ⇒ no bbox overlap). A
    // missing showcase satisfies this trivially — a broken one never does.
    const crowded = DESK_SET.map((a) => ({ ...a, baseCount: a.baseCount * 3 }))
    const byId = new Map(crowded.map((a) => [a.id, a]))
    for (const seed of [0xc0ffee, 0xbeef, 42, 7, 0x1234abcd, 1, 2, 3, 99, 0xfeed]) {
      const desk = placeDecor(input({ archetypes: crowded, deskBand: 150, density: 'rich', seed })).filter((p) => p.onDesk)
      expect(desk.length, `seed ${seed}: the desk is actually crowded`).toBeGreaterThanOrEqual(8)
      for (let i = 0; i < desk.length; i++) {
        for (let j = i + 1; j < desk.length; j++) {
          const p = desk[i]
          const q = desk[j]
          const sep = byId.get(p.archetypeId)!.footprint * p.scale + byId.get(q.archetypeId)!.footprint * q.scale
          const overlaps = Math.abs(p.x - q.x) < sep - 1e-9 && Math.abs(p.z - q.z) < sep - 1e-9
          expect(overlaps, `seed ${seed}: ${p.propId} and ${q.propId} interpenetrate`).toBe(false)
        }
      }
    }
  })

  it('sev7 (critique #7): maxCount is a HARD per-scene cap — rich scaling AND the showcase promotion never duplicate a unique landmark', () => {
    // Density/area scaling can push a unique landmark's expected count past
    // 1 (two identical CN towers one width apart). The tower here is ALSO the largest-footprint desk archetype,
    // so the showcase pass wants to promote one into the window — for the
    // (majority of) seeds where the lone organic tower lands OUTSIDE the
    // window, an uncapped promotion would mint a second tower. Both paths
    // must respect the cap: exactly one tower, every seed.
    const tower: PropArchetype = {
      id: 'cn-tower',
      asset: 'cn-tower',
      footprint: 40,
      affinity: 'open',
      weight: 1,
      scaleJitter: [0.95, 1.05],
      rotation: 'random-y',
      baseCount: 4,
      maxCount: 1,
      zone: 'desk',
    }
    const lineup = [...DESK_SET.filter((a) => a.id !== 'cn-tower'), tower]
    const seeds = [0xc0ffee, 0xbeef, 42, 7, 0x1234abcd, 1, 2, 3, 99, 0xfeed]
    for (const seed of seeds) {
      const towers = placeDecor(input({ archetypes: lineup, deskBand: 150, density: 'rich', seed })).filter(
        (p) => p.archetypeId === 'cn-tower',
      )
      expect(towers.length, `seed ${seed}: exactly one CN tower per scene`).toBe(1)
    }
    // control — without the cap the same rich fixture DOES duplicate, so the
    // contract above is carried by maxCount, not by a lucky draw
    const uncapped = [...DESK_SET.filter((a) => a.id !== 'cn-tower'), { ...tower, maxCount: undefined }]
    const duplicated = seeds.some(
      (seed) =>
        placeDecor(input({ archetypes: uncapped, deskBand: 150, density: 'rich', seed })).filter(
          (p) => p.archetypeId === 'cn-tower',
        ).length > 1,
    )
    expect(duplicated, 'the uncapped rich draw duplicates the landmark').toBe(true)
  })

  it('crowd staging never perturbs non-person props (pose-identity on shared ids)', () => {
    const nonPersons = ARCHETYPES.filter((a) => !a.id.startsWith('person'))
    const solo = placeDecor(input({ archetypes: nonPersons, nodes: FIVE_NODES, connections: FIVE_CONNS }))
    const combined = placeDecor(input({ archetypes: [...PEOPLE, ...nonPersons], nodes: FIVE_NODES, connections: FIVE_CONNS }))
    expect(combined.some((p) => p.archetypeId.startsWith('person')), 'people actually joined').toBe(true)
    const soloById = new Map(solo.map((p) => [p.propId, p]))
    const combinedNP = combined.filter((p) => !p.archetypeId.startsWith('person'))
    expect(combinedNP.length).toBeGreaterThan(0)
    let shared = 0
    for (const p of combinedNP) {
      const twin = soloById.get(p.propId)
      // a non-person prop may (rarely) lose its greedy collision slot to a
      // person, but a prop that PLACES must have the exact same pose the
      // person-free run gives it — per-cell hashing owes us that
      if (twin) {
        expect(twin, p.propId).toEqual(p)
        shared++
      }
    }
    expect(shared).toBeGreaterThanOrEqual(Math.floor(combinedNP.length * 0.8))
  })
})

describe('placeDecor keeps props off connection label plates', () => {
  it('no prop lands on (or within the skirt of) an avoided label box', () => {
    // pick boxes where props land WITHOUT avoidance, so the test cannot pass vacuously
    const free = placeDecor(input()).filter((p) => !p.onDesk)
    expect(free.length).toBeGreaterThan(3)
    const avoid = free.slice(0, 3).map((p) => ({ x: p.x - 30, y: p.z - 10, w: 60, h: 20 }))
    const placed = placeDecor(input({ avoid }))
    expect(placed).not.toEqual(placeDecor(input()))
    for (const p of placed) {
      if (p.onDesk) continue
      for (const r of avoid) {
        const inside = p.x > r.x - 12 && p.x < r.x + r.w + 12 && p.z > r.y - 12 && p.z < r.y + r.h + 12
        expect(inside, `${p.propId} on a label box`).toBe(false)
      }
    }
  })

  it('omitting `avoid` changes nothing (same placement as before the field existed)', () => {
    expect(placeDecor(input({ avoid: [] }))).toEqual(placeDecor(input()))
  })
})

describe('the desk per background world (view3d quality loop 3: giant moose + leaf through a wall in the city)', () => {
  // the host's real lineup on a lit canadiana board: pack + shared desk set
  const canadiana = DECOR_PACKS.find((p) => p.id === 'canadiana')!
  const LINEUP = [...canadiana.archetypes, ...DESK_ARCHETYPES]
  const byId = new Map(LINEUP.map((a) => [a.id, a]))
  const SEEDS = Array.from({ length: 24 }, (_, s) => 0x7100 + s * 7919)
  // slab of the input() fixture: bounds 1100 x 750, pad 88/72, no fracture
  const SX0 = -88
  const SZ0 = -72
  const SX1 = 1100 + 88
  const SZ1 = 750 + 72

  it('city: only the props with a maquette scale land, at that scale, wholly inside the empty city hole', () => {
    let desk = 0
    let flags = 0
    for (const seed of SEEDS) {
      const placed = placeDecor(input({ archetypes: LINEUP, deskBand: 150, world: 'city', seed }))
      for (const p of placed.filter((q) => q.onDesk)) {
        desk++
        const a = byId.get(p.archetypeId)!
        expect(a.cityScale, `${p.propId}: a desk tool / desk leaf has no place in the city`).toBeDefined()
        expect(p.scale, `${p.propId} at maquette scale`).toBeLessThanOrEqual(a.cityScale! * a.scaleJitter[1] + 1e-9)
        const r = a.footprint * p.scale
        // the whole footprint inside the hole the city builder keeps empty…
        expect(p.x - r, p.propId).toBeGreaterThanOrEqual(SX0 - CITY_HOLE_APRON)
        expect(p.x + r, p.propId).toBeLessThanOrEqual(SX1 + CITY_HOLE_APRON)
        expect(p.z - r, p.propId).toBeGreaterThanOrEqual(SZ0 - CITY_HOLE_APRON)
        expect(p.z + r, p.propId).toBeLessThanOrEqual(SZ1 + CITY_HOLE_APRON)
        // …and wholly off the slab
        const offSlab = p.x + r <= SX0 || p.x - r >= SX1 || p.z + r <= SZ0 || p.z - r >= SZ1
        expect(offSlab, `${p.propId} clear of the slab`).toBe(true)
        if (p.archetypeId === 'canada-flag') flags++
      }
    }
    expect(desk, 'the city apron is still dressed').toBeGreaterThan(SEEDS.length)
    // the showcase promotion keeps the flag: it is the largest city-eligible footprint
    expect(flags, 'the city flag shows on (nearly) every board').toBeGreaterThanOrEqual(SEEDS.length * 0.9)
    // the moose stays under the lowest walk-up: 64.6 units as built (registry
    // CITY_FAUNA_SCALE measurement) against the city's 12.5-unit floor (the
    // K = 1 walk-up; since CITY_SCALE the bar keeps the moose people-scale —
    // ~1.5 of the 8-unit storeys — beside the 54-66-unit plaza blocks)
    const moose = byId.get('moose')!
    expect(64.6 * moose.cityScale! * moose.scaleJitter[1]).toBeLessThan(12.5 + 0.1)
  })

  it('control: the SAME lineup on the workbench puts desk-scale tools and leaves far into the annulus', () => {
    // without the world the bug is back: desk props up to 150 px out, at
    // scale ~1 — i.e. where the city's blocks stand (they start 91 px out)
    let farOut = 0
    let tools = 0
    for (const seed of SEEDS) {
      for (const p of placeDecor(input({ archetypes: LINEUP, deskBand: 150, seed })).filter((q) => q.onDesk)) {
        const dOut = Math.max(SX0 - p.x, p.x - SX1, SZ0 - p.z, p.z - SZ1)
        if (dOut + byId.get(p.archetypeId)!.footprint * p.scale > CITY_HOLE_APRON) farOut++
        if (byId.get(p.archetypeId)!.cityScale === undefined) tools++
      }
    }
    expect(farOut).toBeGreaterThan(SEEDS.length)
    expect(tools).toBeGreaterThan(SEEDS.length)
  })

  it('city: a lot handed in through `avoid` under a desk cell is never covered', () => {
    // the finding's own case: a building lot reaching into the apron along
    // the whole W band — the band the sector bias and the showcase window
    // favour, so most seeds put a prop there without it
    const lot = { x: SX0 - CITY_HOLE_APRON - 20, y: SZ0, w: 40, h: 894 }
    let near = 0
    for (const seed of SEEDS) {
      const free = placeDecor(input({ archetypes: LINEUP, deskBand: 150, world: 'city', seed })).filter((p) => p.onDesk)
      const placed = placeDecor(input({ archetypes: LINEUP, deskBand: 150, world: 'city', seed, avoid: [lot] })).filter((p) => p.onDesk)
      const gap = (p: { x: number; z: number }) =>
        Math.hypot(Math.max(lot.x - p.x, 0, p.x - lot.x - lot.w), Math.max(lot.y - p.z, 0, p.z - lot.y - lot.h))
      // not vacuous: without the lot, props DO stand where it is
      if (free.some((p) => gap(p) < byId.get(p.archetypeId)!.footprint * p.scale)) near++
      for (const p of placed) {
        expect(gap(p), `seed ${seed}: ${p.propId} covers the lot`).toBeGreaterThanOrEqual(byId.get(p.archetypeId)!.footprint * p.scale - 1e-9)
      }
    }
    expect(near, 'the lot sits where city props would otherwise stand').toBeGreaterThan(SEEDS.length / 2)
  })

  it('workbench: a desk prop with a clearance (the desk leaves) never reaches back under the slab', () => {
    // workbench-leaf.png (loop 3): one blade of the desk cluster drew half
    // hidden beneath the board's overhang
    const under = (archetypes: PropArchetype[]) => {
      let n = 0
      let leaves = 0
      for (const seed of SEEDS) {
        for (const p of placeDecor(input({ archetypes, deskBand: 150, seed }))) {
          if (!p.onDesk || !p.archetypeId.startsWith('maple-leaf')) continue
          leaves++
          const r = archetypes.find((a) => a.id === p.archetypeId)!.footprint * p.scale
          const dOut = Math.max(SX0 - p.x, p.x - SX1, SZ0 - p.z, p.z - SZ1)
          if (dOut < r + 3 - 1e-9) n++
        }
      }
      return { n, leaves }
    }
    const shipped = under(LINEUP)
    expect(shipped.leaves, 'the desk still carries leaves').toBeGreaterThan(SEEDS.length)
    expect(shipped.n, 'desk leaves wholly off the slab').toBe(0)
    // control: without the clearance the same supply does tuck under the slab
    const legacy = under(LINEUP.map((a) => (a.zone === 'desk' ? { ...a, clearance: undefined } : a)))
    expect(legacy.n).toBeGreaterThan(0)
  })

  describe('the desk flag reads in the DEFAULT framing, side panels open (view3d quality loop 3 r2)', () => {
    // workbench-wide.png: "There is no flag anywhere … the flag is in the W
    // band, which lands under the 326 px 'Formes' side panel or the floating
    // canvas toolbar". The camera is the one fit-to-screen lands on
    // (camera.ts presetPose → fitPoseToPoints, iso preset, every node box
    // inside the canvas minus the chrome); the chrome is the app's default:
    // both side panels open, the tool rail, the top pill, the bottom bar.
    const VP = { width: 1600, height: 1000 }
    const DESK_Y = -(CAMERA_PRESETS.iso.floorD + 16) + 0.3
    // the app's content bounds ARE the node extent (Scene3D.contentBounds),
    // so the fixture's cards span its 1100 x 750 bounds — a fit to two cards
    // in the middle of a bigger slab would frame no desk at all
    const NODES = [
      { id: 'nw', type: 'app', rect: { x: 0, y: 0, w: 200, h: 120 } },
      { id: 'ne', type: 'app', rect: { x: 900, y: 0, w: 200, h: 120 } },
      { id: 'mid', type: 'store', rect: { x: 450, y: 315, w: 200, h: 120 } },
      { id: 'sw', type: 'app', rect: { x: 0, y: 630, w: 200, h: 120 } },
      { id: 'se', type: 'app', rect: { x: 900, y: 630, w: 200, h: 120 } },
    ]
    const CONNS = [{ points: [{ x: 200, y: 60 }, { x: 450, y: 375 }] }, { points: [{ x: 650, y: 375 }, { x: 900, y: 690 }] }]
    const fixture = input({ nodes: NODES, connections: CONNS })
    const corners = fixture.nodes.flatMap((n) => {
      const out: { x: number; y: number; z: number }[] = []
      for (const x of [n.rect.x - 7, n.rect.x + n.rect.w + 7])
        for (const y of [0, CAMERA_PRESETS.iso.depth]) for (const z of [n.rect.y - 7, n.rect.y + n.rect.h + 7]) out.push({ x, y, z })
      return out
    })
    const bounds = { cx: fixture.bounds.x + fixture.bounds.w / 2, cz: fixture.bounds.y + fixture.bounds.h / 2, width: fixture.bounds.w, height: fixture.bounds.h }
    /** The default framing for a given chrome: the fit pose, its THREE
     * camera, the view placement gets, and a box test measured with THREE (an
     * independent path from placement.ts's own matrix arithmetic) — the
     * flag's bounding cylinder, base disc to finial, banner reach included. */
    const frameFor = (insets: { left: number; right: number; top: number; bottom: number }) => {
      const safe = { x: insets.left, y: insets.top, w: VP.width - insets.left - insets.right, h: VP.height - insets.top - insets.bottom }
      const pose = fitPoseToPoints(presetPose('iso', bounds, VP), corners, VP, insets)
      const cam = new THREE.PerspectiveCamera(pose.fov, VP.width / VP.height, 10, 200_000)
      applyPose(cam, pose)
      cam.updateMatrixWorld()
      const view: ShowcaseView = {
        viewProj: [...new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements],
        viewport: VP,
        safe,
        deskY: DESK_Y,
      }
      const box = (p: { x: number; z: number; scale: number }, id = 'canada-flag') => {
        const a = byId.get(id)!
        const r = a.footprint * p.scale
        const v = new THREE.Vector3()
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        for (let k = 0; k < 16; k++) {
          // (placement's own stand-in height when the registry has none)
          for (const y of [DESK_Y, DESK_Y + (a.height ?? 2 * a.footprint) * p.scale]) {
            v.set(p.x + r * Math.cos((k * Math.PI) / 8), y, p.z + r * Math.sin((k * Math.PI) / 8)).project(cam)
            const sx = ((v.x + 1) / 2) * VP.width
            const sy = ((1 - v.y) / 2) * VP.height
            x0 = Math.min(x0, sx)
            x1 = Math.max(x1, sx)
            y0 = Math.min(y0, sy)
            y1 = Math.max(y1, sy)
          }
        }
        return { x0, y0, x1, y1 }
      }
      const inside = (p: { x: number; z: number; scale: number }, id = 'canada-flag') => {
        const b = box(p, id)
        return b.x0 >= safe.x && b.y0 >= safe.y && b.x1 <= safe.x + safe.w && b.y1 <= safe.y + safe.h
      }
      return { view, safe, box, inside, eye: cam.position.clone(), cam }
    }
    // the app's default chrome (both side panels + the tool rail, the top
    // pill, the bottom bar) — and a WIDER left panel, the case the W-band
    // window was blind to (a dragged-open "Formes" list)
    const DEFAULT_CHROME = frameFor({ left: 392, right: 330, top: 66, bottom: 70 })
    const WIDE_LEFT = frameFor({ left: 640, right: 330, top: 66, bottom: 70 })
    const run = (o: Partial<PlacementInput>) =>
      placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: LINEUP, deskBand: 150, ...o }))

    for (const [chrome, frame] of [['default chrome', DEFAULT_CHROME], ['wide left panel', WIDE_LEFT]] as const) {
      for (const world of ['workbench', 'city'] as const) {
        it(`${world}, ${chrome}: the flag stands wholly inside the unobstructed canvas on every seed — and it stays ONE flag`, () => {
          const report: string[] = []
          const heights: number[] = []
          for (const seed of SEEDS) {
            const flags = run({ seed, world, view: frame.view }).filter((p) => p.archetypeId === 'canada-flag')
            expect(flags.length, `seed ${seed}: one desk flag (maxCount 1 — the showcase MOVES it, never mints a second)`).toBe(1)
            const b = frame.box(flags[0])
            heights.push(b.y1 - b.y0)
            if (!frame.inside(flags[0])) report.push(`seed ${seed}: [${[b.x0, b.y0, b.x1, b.y1].map(Math.round).join(', ')}]`)
          }
          expect(report, `flag box outside the safe rect ${JSON.stringify(frame.safe)}`).toEqual([])
          // …and in the FOREGROUND, never framed-but-far (loop3-r2-fix-b
          // city-wide.png: a 17-px flag on the north apron). The scale
          // jitter alone spans 0.92-1.08 (0.85x); 0.7x leaves room for it.
          expect(Math.min(...heights) / Math.max(...heights), `projected heights ${heights.map(Math.round).join(' ')}`).toBeGreaterThan(0.7)
        })
      }
    }

    for (const [chrome, frame] of [['default chrome', DEFAULT_CHROME], ['wide left panel', WIDE_LEFT]] as const) {
      it(`workbench, ${chrome}: the foreground companion (the mug) dresses the OTHER near corner on every seed (view3d quality loop 4)`, () => {
        // workbench-wide.png: "the whole lower third is bare desk … the
        // default iso framing needs a prop cluster in the near-left AND the
        // near-right corners". The flag takes one (the showcase); the mug
        // must take the other half of the frame, whole, in the foreground.
        // A first cut asked only for "the other half" and the live render put
        // the mug a few px across the mid line, beside the flag — so the gate
        // is the SEPARATION, as a share of the unobstructed width. Measured
        // 2026-10-09 on this fixture: 0.44-0.87 over 24 seeds × 2 chromes.
        const report: string[] = []
        const heights: number[] = []
        const seps: number[] = []
        for (const seed of SEEDS) {
          const placed = run({ seed, view: frame.view })
          const mugs = placed.filter((p) => p.archetypeId === 'desk-mug')
          expect(mugs.length, `seed ${seed}: one mug (maxCount 1 — MOVED, never minted)`).toBe(1)
          const flag = placed.find((p) => p.archetypeId === 'canada-flag')!
          const fb = frame.box(flag)
          const mb = frame.box(mugs[0], 'desk-mug')
          heights.push(mb.y1 - mb.y0)
          const s = Math.abs((mb.x0 + mb.x1) / 2 - (fb.x0 + fb.x1) / 2) / frame.safe.w
          seps.push(s)
          // …and NEAR: its foot below the top 40 % of the frame. With a 0.6
          // foreground band, maximising the separation parked the mug by the
          // CN tower at the frame's top-left (loop4-r1-assets3/workbench-wide
          // .png; this gate then reads 5+ seeds red per chrome). At the
          // shipped 0.75 the highest foot measured is 0.49 of the frame
          // (wide left panel: the E band's middle).
          const near = mb.y1 >= frame.safe.y + frame.safe.h * 0.4
          if (!frame.inside(mugs[0], 'desk-mug') || s < 0.4 || !near) report.push(`seed ${seed}: mug [${[mb.x0, mb.y0, mb.x1, mb.y1].map(Math.round).join(', ')}] separation ${s.toFixed(2)} near ${near}`)
          // the strict desk spacing still holds against every desk prop
          for (const p of placed.filter((q) => q.onDesk && q !== mugs[0])) {
            const minD = (byId.get('desk-mug')!.footprint * mugs[0].scale + byId.get(p.archetypeId)!.footprint * p.scale) * 0.999
            expect(Math.abs(p.x - mugs[0].x) >= minD || Math.abs(p.z - mugs[0].z) >= minD, `seed ${seed}: mug clear of ${p.archetypeId}`).toBe(true)
          }
        }
        expect(report, `mug framed, ≥40 % of the frame across from the flag (safe ${JSON.stringify(frame.safe)}); separations ${seps.map((s) => s.toFixed(2)).join(' ')}`).toEqual([])
        expect(Math.min(...heights) / Math.max(...heights), `foreground, never framed-but-far: ${heights.map(Math.round).join(' ')}`).toBeGreaterThan(0.5)
      })
    }

    it('control: without the companion pass the organic mug misses the empty near corner on most seeds', () => {
      // sparse density skips both promotions — the organic draw alone
      let mugs = 0
      let dressed = 0
      for (const seed of [...SEEDS, ...SEEDS.map((s) => s + 1)]) {
        const placed = run({ seed, density: 'sparse' })
        const mug = placed.find((p) => p.archetypeId === 'desk-mug')
        const flag = placed.find((p) => p.archetypeId === 'canada-flag')
        if (!mug || !flag) continue
        mugs++
        const fb = DEFAULT_CHROME.box(flag)
        const mb = DEFAULT_CHROME.box(mug, 'desk-mug')
        const s = Math.abs((mb.x0 + mb.x1) / 2 - (fb.x0 + fb.x1) / 2) / DEFAULT_CHROME.safe.w
        // the gate's own bar (≥ 0.4 across, foot below the top 40 %). The
        // looser 0.3-and-framed bar read 8 of 14 once the work-zone pieces
        // (quality pass "layout") were drawn last and the organic mug moved —
        // measured 2026-10-10; this bar reads 0 of 14
        const near = mb.y1 >= DEFAULT_CHROME.safe.y + DEFAULT_CHROME.safe.h * 0.4
        if (DEFAULT_CHROME.inside(mug, 'desk-mug') && s >= 0.4 && near) dressed++
      }
      expect(mugs, 'the organic draw does place mugs').toBeGreaterThan(4)
      expect(dressed / mugs, `${dressed} of ${mugs} organic mugs already dress the other corner`).toBeLessThan(0.5)
    })

    it('control: where the ORGANIC draw leaves the flag (no showcase pass), it is out of frame on most seeds', () => {
      // The live defect: the flag's maxCount is 1, the organic draw had
      // already spent it out of frame, and the old promotion bailed at the
      // cap. Sparse density skips the showcase pass, so this is the organic
      // draw alone — the placements the relocation exists to move.
      let flags = 0
      let hidden = 0
      for (const seed of [...SEEDS, ...SEEDS.map((s) => s + 1)]) {
        const flag = run({ seed, density: 'sparse' }).find((p) => p.archetypeId === 'canada-flag')
        if (!flag) continue
        flags++
        if (!DEFAULT_CHROME.inside(flag)) hidden++
      }
      // measured 2026-10-09 on this fixture: 6 of 43 organic flags out of
      // frame (14 %) — so the 24-seed gates above, which demand 0, go red if
      // the pass stops moving the flag. (On the live 9-card board the share
      // was worse: the flag stood under the left panel in workbench-wide.png.)
      expect(flags, 'the organic draw does place flags').toBeGreaterThan(6)
      expect(hidden, `${hidden} of ${flags} organic flags out of frame`).toBeGreaterThanOrEqual(3)
    })

    for (const [chrome, frame] of [['default chrome', DEFAULT_CHROME], ['wide left panel', WIDE_LEFT]] as const) {
      it(`workbench, ${chrome}: the near-band set pieces stand framed in the foreground, clear of every desk prop (loop 4 r2)`, () => {
        // workbench-wide.png (loop 4 r2): "the beaver (about 20 px, at
        // 815,190) … the far leaves are barely visible; the lower quadrants
        // are bare desk". Each near-band piece must stand wholly inside the
        // unobstructed canvas with its foot below the top 40 % of it — the
        // mug's own "near" bar — on every seed where the band has room for
        // it. (Quality pass "layout": the notebooks joined the coffee corner
        // and the plant the greenery by the lamp — the zone gates below.)
        const near = LINEUP.filter((a) => a.nearBand)
        expect(new Set(near.map((a) => a.id)), 'the lineup carries the near band').toEqual(new Set(['moose', 'beaver']))
        const report: string[] = []
        let checked = 0
        for (const seed of SEEDS) {
          const placed = run({ seed, view: frame.view })
          for (const id of new Set(near.map((a) => a.id))) {
            const mine = placed.filter((p) => p.archetypeId === id && p.onDesk)
            // the piece is there (moved, or minted when the organic draw had none)
            expect(mine.length, `seed ${seed}: ${id} on the desk`).toBeGreaterThan(0)
            const ok = mine.some((p) => {
              const b = frame.box(p, id)
              // …and wholly OFF the slab: loop4-r2-assets-m2/workbench-wide.png
              // had the moose's hindquarters tucked under the overhang
              const r = byId.get(id)!.footprint * p.scale
              const dOut = Math.max(SX0 - p.x, p.x - SX1, SZ0 - p.z, p.z - SZ1)
              return frame.inside(p, id) && b.y1 >= frame.safe.y + frame.safe.h * 0.4 && dOut >= r + 3 - 1e-9
            })
            checked++
            if (!ok) {
              const b = frame.box(mine[mine.length - 1], id)
              report.push(`seed ${seed}: ${id} [${[b.x0, b.y0, b.x1, b.y1].map(Math.round).join(', ')}]`)
            }
            for (const m of mine) {
              for (const p of placed.filter((q) => q.onDesk && q !== m)) {
                const minD = (byId.get(id)!.footprint * m.scale + byId.get(p.archetypeId)!.footprint * p.scale) * 0.999
                expect(Math.abs(p.x - m.x) >= minD || Math.abs(p.z - m.z) >= minD, `seed ${seed}: ${id} clear of ${p.archetypeId}`).toBe(true)
              }
            }
          }
        }
        expect(checked).toBe(SEEDS.length * 2)
        // measured 2026-10-09 on this fixture: 0 of 96 off the band on both
        // chromes. (The first cut ranked cells by the companion's height ratio
        // and read 22 of 96 on the wide left panel — every one the plant,
        // parked on the empty far edge.) Since quality pass "layout" the band
        // holds the two animals: 0 of 48 off it, 2026-10-10.
        expect(report, 'near-band pieces not framed in the foreground').toEqual([])
      })
    }

    /** Angle (deg) between a prop's +X muzzle, yawed by rotY the way
     * build.ts does it (THREE quaternion about +Y), and the horizontal
     * bearing to the THREE camera — an independent path from placement.ts's
     * matrix solve. */
    const muzzleOff = (p: { x: number; z: number; rotY: number }, eye: THREE.Vector3) => {
      const m = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rotY))
      const to = new THREE.Vector3(eye.x - p.x, 0, eye.z - p.z).normalize()
      return (Math.acos(Math.max(-1, Math.min(1, m.x * to.x + m.z * to.z))) * 180) / Math.PI
    }

    for (const [chrome, frame] of [['default chrome', DEFAULT_CHROME], ['wide left panel', WIDE_LEFT]] as const) {
      for (const world of ['workbench', 'city'] as const) {
        it(`${world}, ${chrome}: the moose and the beaver turn their face to the camera, three-quarter (loop 4 r3)`, () => {
          // workbench-wide.png / workbench-cold.png (loop 4 r3): the beaver
          // showed its back — the flat tail a black hole on the desk — and the
          // moose its rear three-quarter, "brown pawns" with no face. Every
          // instance's muzzle must point within 60° of the camera, and not
          // dead-on (≥ 25°: a three-quarter view shows the antler palm and
          // the profile, a head-on one flattens both).
          const report: string[] = []
          let n = 0
          for (const seed of SEEDS) {
            for (const p of run({ seed, world, view: frame.view })) {
              if (p.archetypeId !== 'moose' && p.archetypeId !== 'beaver') continue
              n++
              const off = muzzleOff(p, frame.eye)
              if (off > 60 || off < 25) report.push(`seed ${seed}: ${p.archetypeId} ${off.toFixed(0)}°`)
            }
          }
          expect(n, 'the fauna is placed').toBeGreaterThan(SEEDS.length)
          expect(report).toEqual([])
        })
      }
    }

    it('control: with a random yaw most of the fauna does not face the camera', () => {
      const legacy = LINEUP.map((a) => (a.rotation === 'face-camera-3q' ? { ...a, rotation: 'random-y' as const } : a))
      expect([...new Set(legacy.filter((a, i) => a !== LINEUP[i]).map((a) => a.id))].sort(), 'the lineup turns exactly the moose and the beaver').toEqual(['beaver', 'moose'])
      let off = 0
      let n = 0
      for (const seed of SEEDS) {
        for (const p of placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: legacy, deskBand: 150, seed, view: DEFAULT_CHROME.view }))) {
          if (p.archetypeId !== 'moose' && p.archetypeId !== 'beaver') continue
          n++
          if (muzzleOff(p, DEFAULT_CHROME.eye) > 60) off++
        }
      }
      // a uniform yaw faces within 60° a third of the time: the gate above
      // (every one) goes red if the final pass stops turning them
      expect(off / n, `${off} of ${n} random-yaw animals face away`).toBeGreaterThan(0.4)
    })

    it('cameraEyeOf recovers the THREE camera position from the view-projection matrix', () => {
      expect(cameraEyeOf(DEFAULT_CHROME.view.viewProj)!.x).toBeCloseTo(DEFAULT_CHROME.eye.x, 3)
      expect(cameraEyeOf(DEFAULT_CHROME.view.viewProj)!.y).toBeCloseTo(DEFAULT_CHROME.eye.y, 3)
      expect(cameraEyeOf(DEFAULT_CHROME.view.viewProj)!.z).toBeCloseTo(DEFAULT_CHROME.eye.z, 3)
    })

    it('control: without the near-band pass the beaver and the moose stand framed-near on a minority of seeds', () => {
      const legacy = LINEUP.map(({ nearBand: _n, ...a }) => a)
      let near = 0
      let total = 0
      for (const seed of SEEDS) {
        const placed = placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: legacy, deskBand: 150, seed, view: DEFAULT_CHROME.view }))
        for (const id of ['beaver', 'moose']) {
          const mine = placed.filter((p) => p.archetypeId === id && p.onDesk)
          if (mine.length === 0) continue
          total++
          if (mine.some((p) => DEFAULT_CHROME.inside(p, id) && DEFAULT_CHROME.box(p, id).y1 >= DEFAULT_CHROME.safe.y + DEFAULT_CHROME.safe.h * 0.4)) near++
        }
      }
      // measured 2026-10-09: 15 of 39 (38 %) — so the gates above, which
      // demand every one, go red if the pass stops moving them
      expect(total, 'the organic draw places the fauna').toBeGreaterThan(SEEDS.length)
      expect(near / total, `${near} of ${total} organic beaver/moose already framed-near`).toBeLessThan(0.5)
    })

    for (const [chrome, frame] of [['default chrome', DEFAULT_CHROME], ['wide left panel', WIDE_LEFT]] as const) {
      it(`workbench, ${chrome}: the far-band anchors dress the desk beyond the board, framed, clear of every desk prop (loop 4 r3)`, () => {
        // workbench-wide.png (loop 4 r3): "the whole far desk band (y 60-250,
        // full width) is bare streaked wood, apart from a 10 px cable coil and
        // a 10 px compass". Each far-band piece (the pencil cup, the books)
        // must stand wholly inside the unobstructed canvas with its foot in
        // the upper 45 % of it, wholly off the slab, and the two must not
        // crowd each other.
        // + quality pass "cntower": the souvenir CN Tower rides the far band
        // (tp-final-dpr1/workbench-wide.png: the old cone stood at the front-
        // left board edge, across the Analyst connection)
        // + quality pass "layout": the plant leads the greenery zone on the
        // far band; the books joined the reference stack and the pencil cup
        // the greenery (the zone gates below)
        const far = LINEUP.filter((a) => a.farBand)
        expect(new Set(far.map((a) => a.id)), 'the lineup carries the far band').toEqual(new Set(['desk-plant', 'cn-tower']))
        const report: string[] = []
        const seps: number[] = []
        for (const seed of SEEDS) {
          const placed = run({ seed, view: frame.view })
          const centres: { x: number; y: number }[] = []
          for (const a of far) {
            const mine = placed.filter((p) => p.archetypeId === a.id && p.onDesk)
            expect(mine.length, `seed ${seed}: ${a.id} on the desk (maxCount 1 — MOVED, never minted past it)`).toBe(1)
            const p = mine[0]
            const b = frame.box(p, a.id)
            const r = a.footprint * p.scale
            const dOut = Math.max(SX0 - p.x, p.x - SX1, SZ0 - p.z, p.z - SZ1)
            if (!frame.inside(p, a.id) || b.y1 > frame.safe.y + frame.safe.h * 0.45 || dOut < r + 3 - 1e-9) {
              report.push(`seed ${seed}: ${a.id} [${[b.x0, b.y0, b.x1, b.y1].map(Math.round).join(', ')}] dOut ${dOut.toFixed(0)}`)
            }
            centres.push({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 })
            for (const q of placed.filter((o) => o.onDesk && o !== p)) {
              const minD = (r + byId.get(q.archetypeId)!.footprint * q.scale) * 0.999
              expect(Math.abs(q.x - p.x) >= minD || Math.abs(q.z - p.z) >= minD, `seed ${seed}: ${a.id} clear of ${q.archetypeId}`).toBe(true)
            }
          }
          for (let i = 0; i < centres.length; i++) {
            for (let j = i + 1; j < centres.length; j++) {
              seps.push(Math.hypot(centres[i].x - centres[j].x, centres[i].y - centres[j].y) / frame.safe.w)
            }
          }
        }
        expect(report, `far-band pieces not framed beyond the board (safe ${JSON.stringify(frame.safe)})`).toEqual([])
        // the two spread apart (NEAR_BAND_SEP is 0.12 of the width, halved
        // once when the band is full)
        expect(Math.min(...seps), `separations ${seps.map((s) => s.toFixed(2)).join(' ')}`).toBeGreaterThanOrEqual(0.06 - 1e-9)
      })
    }

    it('the far-band pieces never displace an older prop: every other pose is the one the lineup had without them (loop 4 r3)', () => {
      // loop4-r3-assets-a: in the plain hash-ordered greedy pass the new
      // pencil cup and books took cells older props had held, the desk flag
      // moved, and its foot landed under the STYLE 3D pill on the live board
      // (the harness's "flag on canvas" gate went red). The far band is drawn
      // last and, with a view, leaves the desk before the showcase chooses.
      const without = LINEUP.filter((a) => !a.farBand)
      // the work-zone pieces (quality pass "layout") are drawn after even the
      // far band, and the greenery gathers round a far-band lead — they may
      // (and do) depend on it, so they leave both sides of the comparison
      const gap = new Set(LINEUP.filter((a) => a.workZone).map((a) => a.id))
      // every far-band id leaves both sides (the CN tower joined the band in
      // quality pass "cntower")
      const farIds = new Set(LINEUP.filter((a) => a.farBand).map((a) => a.id))
      const strip = (ps: ReturnType<typeof placeDecor>) => ps.filter((p) => !farIds.has(p.archetypeId) && !gap.has(p.archetypeId))
      let moved = 0
      for (const seed of SEEDS) {
        for (const view of [undefined, DEFAULT_CHROME.view, WIDE_LEFT.view]) {
          const a = strip(placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: LINEUP, deskBand: 150, seed, view })))
          const b = strip(placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: without, deskBand: 150, seed, view })))
          expect(a, `seed ${seed}, ${view ? 'view' : 'no view'}`).toEqual(b)
          moved++
        }
      }
      expect(moved).toBe(SEEDS.length * 3)
    })

    // ── quality pass "cntower" (tp-final-dpr1/workbench-wide.png): "the CN
    // Tower … stands on the mat at the board's front-left edge, cuts across
    // the Analyst connection"; "the cable coil … half sinks under the board
    // edge". The tower rides the far band, the coil keeps its whole footprint
    // off the slab.
    /** Screen boxes of the cards (their 7-px margin box, paper to card top)
     * and the cables' sample points (on the paper), through the THREE camera. */
    const diagramOnScreen = (frame: ReturnType<typeof frameFor>) => {
      const v = new THREE.Vector3()
      const toScreen = (x: number, y: number, z: number) => {
        v.set(x, y, z).project(frame.cam)
        return { x: ((v.x + 1) / 2) * VP.width, y: ((1 - v.y) / 2) * VP.height }
      }
      const cards = NODES.map((n) => {
        const pts = [n.rect.x - 7, n.rect.x + n.rect.w + 7].flatMap((x) =>
          [0, CAMERA_PRESETS.iso.depth].flatMap((y) => [n.rect.y - 7, n.rect.y + n.rect.h + 7].map((z) => toScreen(x, y, z))),
        )
        return {
          x0: Math.min(...pts.map((p) => p.x)),
          y0: Math.min(...pts.map((p) => p.y)),
          x1: Math.max(...pts.map((p) => p.x)),
          y1: Math.max(...pts.map((p) => p.y)),
        }
      })
      const cable: { x: number; y: number }[] = []
      for (const c of CONNS) {
        for (let i = 1; i < c.points.length; i++) {
          const [a, b] = [c.points[i - 1], c.points[i]]
          for (let t = 0; t <= 1; t += 0.02) cable.push(toScreen(a.x + (b.x - a.x) * t, 0, a.y + (b.y - a.y) * t))
        }
      }
      return { cards, cable }
    }
    const towerOverDiagram = (frame: ReturnType<typeof frameFor>, placed: ReturnType<typeof placeDecor>, id = 'cn-tower') => {
      const { cards, cable } = diagramOnScreen(frame)
      const hits: string[] = []
      for (const p of placed.filter((q) => q.archetypeId === id && q.onDesk)) {
        const b = frame.box(p, id)
        if (cards.some((c) => c.x0 < b.x1 && c.x1 > b.x0 && c.y0 < b.y1 && c.y1 > b.y0)) hits.push(`${p.propId} over a card`)
        if (cable.some((q) => q.x > b.x0 && q.x < b.x1 && q.y > b.y0 && q.y < b.y1)) hits.push(`${p.propId} over a cable`)
      }
      return hits
    }

    for (const [chrome, frame] of [['default chrome', DEFAULT_CHROME], ['wide left panel', WIDE_LEFT]] as const) {
      it(`workbench, ${chrome}: the CN Tower ornament stands beyond the board — wholly off the slab, never over a card or a cable on screen (quality pass "cntower")`, () => {
        const report: string[] = []
        for (const seed of SEEDS) {
          const placed = run({ seed, view: frame.view })
          const towers = placed.filter((p) => p.archetypeId === 'cn-tower')
          expect(towers.length, `seed ${seed}: one tower`).toBe(1)
          const p = towers[0]
          const r = byId.get('cn-tower')!.footprint * p.scale
          const dOut = Math.max(SX0 - p.x, p.x - SX1, SZ0 - p.z, p.z - SZ1)
          if (dOut < r + 3 - 1e-9) report.push(`seed ${seed}: dOut ${dOut.toFixed(1)} < ${(r + 3).toFixed(1)}`)
          report.push(...towerOverDiagram(frame, placed).map((h) => `seed ${seed}: ${h}`))
        }
        expect(report).toEqual([])
      })
    }

    it('control: without clearOfBoard the far band alone stands the tower over a card on some seeds', () => {
      // measured 2026-10-10 on this fixture, default chrome: 3 of 24 seeds
      // (171470, 179389, 211065 — a foot beside the W corner, the shaft
      // across the 'sw' card's box) — so the gate above goes red without it
      const loose = LINEUP.map((a) => (a.id === 'cn-tower' ? { ...a, clearOfBoard: undefined } : a))
      let over = 0
      for (const seed of SEEDS) {
        const placed = placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: loose, deskBand: 150, seed, view: DEFAULT_CHROME.view }))
        if (towerOverDiagram(DEFAULT_CHROME, placed).length > 0) over++
      }
      expect(over, `${over} of ${SEEDS.length} seeds: the tower over a card or a cable`).toBeGreaterThan(0)
    })

    it('the cable coil never sinks under the board: its whole footprint stands off the slab (quality pass "cntower")', () => {
      const coil = byId.get('desk-cable-coil')!
      const report: string[] = []
      let n = 0
      for (const seed of SEEDS) {
        for (const density of ['normal', 'rich'] as const) {
          for (const view of [undefined, DEFAULT_CHROME.view, WIDE_LEFT.view]) {
            for (const p of run({ seed, density, view }).filter((q) => q.archetypeId === 'desk-cable-coil')) {
              n++
              const r = coil.footprint * p.scale
              const dOut = Math.max(SX0 - p.x, p.x - SX1, SZ0 - p.z, p.z - SZ1)
              if (dOut < r + 3 - 1e-9) report.push(`seed ${seed} ${density}: dOut ${dOut.toFixed(1)} < ${(r + 3).toFixed(1)}`)
            }
          }
        }
      }
      expect(n, 'coils placed').toBeGreaterThan(SEEDS.length)
      expect(report).toEqual([])
      // control: without the clearance the organic draw tucks coils under
      // the slab (the desk score keeps only the CENTRE 10 units off it)
      const loose = LINEUP.map((a) => (a.id === 'desk-cable-coil' ? { ...a, clearance: undefined } : a))
      let under = 0
      for (const seed of SEEDS) {
        for (const p of placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: loose, deskBand: 150, seed })).filter(
          (q) => q.archetypeId === 'desk-cable-coil',
        )) {
          const dOut = Math.max(SX0 - p.x, p.x - SX1, SZ0 - p.z, p.z - SZ1)
          if (dOut < coil.footprint * p.scale) under++
        }
      }
      expect(under, 'the unclear coil reaches under the slab').toBeGreaterThan(0)
    })

    it('control: without the far-band pass the far-band pieces dress the far band on a minority of seeds', () => {
      // the organic draw alone: no far band, no zones (the plant leads the
      // greenery, which would otherwise lift it and never lay it back)
      const legacy = LINEUP.map(({ farBand: _f, workZone: _z, zoneLead: _l, ...a }) => a)
      const ids = LINEUP.filter((a) => a.farBand).map((a) => a.id)
      let far = 0
      let total = 0
      for (const seed of SEEDS) {
        const placed = placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: legacy, deskBand: 150, seed, view: DEFAULT_CHROME.view }))
        for (const id of ids) {
          const mine = placed.filter((p) => p.archetypeId === id && p.onDesk)
          total += mine.length
          if (mine.some((p) => DEFAULT_CHROME.inside(p, id) && DEFAULT_CHROME.box(p, id).y1 <= DEFAULT_CHROME.safe.y + DEFAULT_CHROME.safe.h * 0.45)) far++
        }
      }
      // measured 2026-10-10 (quality pass "layout", the CN tower and the
      // plant): the organic draw places 29 of the 48 (seed, piece) slots, 21
      // of them framed in the far band — so the gates above (every slot) go red
      // if the pass stops moving them
      expect(total, 'the organic draw places the anchors').toBeGreaterThan(SEEDS.length / 2)
      expect(far / (SEEDS.length * ids.length), `${far} of ${SEEDS.length * ids.length} (seed, piece) slots dressed`).toBeLessThan(0.5)
    })

    // ── quality pass "layout" (tp-final-dpr1/workbench-wide.png): "the moose
    // stands on the rolled blueprint; props sit evenly spaced around the
    // board perimeter like a border, the left foreground desk is empty while
    // the right edge stacks moose, blueprint, mug and pencil". The desk is laid
    // in WORK ZONES; an animal keeps WILDLIFE_GAP off every desk prop and its
    // projected box off every other desk prop's.
    const deskOut = (p: { x: number; z: number }) => Math.max(SX0 - p.x, p.x - SX1, SZ0 - p.z, p.z - SZ1)
    const radiusOf = (p: { archetypeId: string; scale: number }) => byId.get(p.archetypeId)!.footprint * p.scale
    const zoneIds = (zone: string) => [...new Set(LINEUP.filter((a) => a.workZone === zone).map((a) => a.id))]
    /** Screen boxes of every desk prop, through the THREE camera (the
     * placement's own stand-in height when the registry has none). */
    const deskBoxes = (frame: ReturnType<typeof frameFor>, placed: ReturnType<typeof placeDecor>) =>
      placed
        .filter((p) => p.onDesk)
        .map((p) => {
          const a = byId.get(p.archetypeId)!
          const r = a.footprint * p.scale
          const v = new THREE.Vector3()
          let x0 = Infinity
          let y0 = Infinity
          let x1 = -Infinity
          let y1 = -Infinity
          for (let k = 0; k < 16; k++) {
            for (const y of [DESK_Y, DESK_Y + (a.height ?? 2 * a.footprint) * p.scale]) {
              v.set(p.x + r * Math.cos((k * Math.PI) / 8), y, p.z + r * Math.sin((k * Math.PI) / 8)).project(frame.cam)
              const sx = ((v.x + 1) / 2) * VP.width
              const sy = ((1 - v.y) / 2) * VP.height
              x0 = Math.min(x0, sx)
              x1 = Math.max(x1, sx)
              y0 = Math.min(y0, sy)
              y1 = Math.max(y1, sy)
            }
          }
          return { p, a, x0, y0, x1, y1 }
        })
    /** Animal boxes meeting another desk prop's box: "the moose stands on". */
    const standsOn = (frame: ReturnType<typeof frameFor>, placed: ReturnType<typeof placeDecor>) => {
      const boxes = deskBoxes(frame, placed)
      const hits: string[] = []
      for (const m of boxes.filter((b) => b.a.id === 'moose' || b.a.id === 'beaver')) {
        for (const o of boxes) {
          if (o === m) continue
          if (m.x0 < o.x1 && o.x0 < m.x1 && m.y0 < o.y1 && o.y0 < m.y1) hits.push(`${m.p.archetypeId} on ${o.p.propId}`)
        }
      }
      return hits
    }
    /** The two NEAR corners of the frame each carry a desk GROUP: at least
     * three set pieces (no fallen leaves — litter, not a corner of the desk)
     * with their box centre in the outer 35 % of the safe width and their
     * foot below ZONE_CORNER_LOW. */
    const cornersDressed = (frame: ReturnType<typeof frameFor>, placed: ReturnType<typeof placeDecor>) => {
      const boxes = deskBoxes(frame, placed).filter((b) => !b.a.id.startsWith('maple-leaf'))
      const lowY = frame.safe.y + frame.safe.h * ZONE_CORNER_LOW
      const inCorner = (left: boolean) =>
        boxes.filter((b) => {
          const cx = (b.x0 + b.x1) / 2
          const side = left ? cx <= frame.safe.x + frame.safe.w * 0.35 : cx >= frame.safe.x + frame.safe.w * 0.65
          return side && b.y1 >= lowY
        }).length
      const left = inCorner(true)
      const right = inCorner(false)
      return { left: left >= 3, right: right >= 3, n: [left, right] }
    }

    for (const [chrome, frame] of [['default chrome', DEFAULT_CHROME], ['wide left panel', WIDE_LEFT]] as const) {
      it(`workbench, ${chrome}: the desk gathers in WORK ZONES — coffee and reference in the two near corners, the greenery on the far band (quality pass "layout")`, () => {
        const report: string[] = []
        let members = 0
        for (const seed of SEEDS) {
          const placed = run({ seed, view: frame.view })
          const desk = placed.filter((p) => p.onDesk)
          const leadBox: Record<string, { cx: number; y1: number }> = {}
          for (const zone of ['coffee', 'reference', 'greenery'] as const) {
            const ids = zoneIds(zone)
            const mine = desk.filter((p) => ids.includes(p.archetypeId))
            for (const id of ids) {
              const n = mine.filter((p) => p.archetypeId === id).length
              if (n !== 1) report.push(`seed ${seed}: ${n} × ${id}`)
            }
            for (const p of mine) {
              const a = byId.get(p.archetypeId)!
              const b = frame.box(p, a.id)
              // framed whole, wholly off the slab, within the zone reach
              if (!frame.inside(p, a.id)) report.push(`seed ${seed}: ${p.propId} not framed`)
              if (deskOut(p) < radiusOf(p) + 3 - 1e-9 || deskOut(p) > ZONE_REACH + 1e-9) report.push(`seed ${seed}: ${p.propId} dOut ${deskOut(p).toFixed(0)}`)
              // clear of every desk prop (the strict bound)
              for (const q of desk) {
                if (q === p) continue
                const minD = (radiusOf(p) + radiusOf(q)) * 0.999
                if (Math.abs(p.x - q.x) < minD && Math.abs(p.z - q.z) < minD) report.push(`seed ${seed}: ${p.propId} overlaps ${q.propId}`)
              }
              if (a.zoneLead) {
                leadBox[zone] = { cx: (b.x0 + b.x1) / 2, y1: b.y1 }
                continue
              }
              // a member stands snug beside a zone mate (the widest tier)
              members++
              const gap = Math.min(...mine.filter((q) => q !== p).map((q) => Math.hypot(p.x - q.x, p.z - q.z) - radiusOf(p) - radiusOf(q)))
              if (gap < ZONE_GAP_MIN - 1e-6 || gap > 3 * ZONE_GAP_MAX + 1e-6) report.push(`seed ${seed}: ${p.propId} ${gap.toFixed(0)} units from its zone`)
            }
            // the greenery stands on the far band
            if (zone === 'greenery') {
              for (const p of mine) if (frame.box(p, p.archetypeId).y1 > frame.safe.y + frame.safe.h * 0.45) report.push(`seed ${seed}: ${p.propId} off the far band`)
            }
          }
          // the coffee corner and the reference stack in the TWO near corners:
          // opposite halves of the frame, both feet low
          const c = leadBox.coffee
          const r = leadBox.reference
          const mid = frame.safe.x + frame.safe.w / 2
          if (!c || !r || (c.cx - mid) * (r.cx - mid) >= 0) report.push(`seed ${seed}: zones not on opposite sides ${JSON.stringify({ c, r })}`)
          else if (Math.min(c.y1, r.y1) < frame.safe.y + frame.safe.h * 0.5) report.push(`seed ${seed}: a zone lead off the near band ${JSON.stringify({ c, r })}`)
          // three set pieces a corner at the default chrome; two on the
          // dragged-open panel, whose corner strip is 220 px wide (measured
          // 2026-10-10: [2, 6] / [2, 7] / [2, 6] set pieces on 3 of 24
          // seeds there, the zone's other members just inside the strip)
          const corners = cornersDressed(frame, placed)
          const need = frame === DEFAULT_CHROME ? 3 : 2
          if (Math.min(...corners.n) < need) report.push(`seed ${seed}: near corners ${JSON.stringify(corners)}`)
        }
        expect(members, 'the zones carry their members').toBeGreaterThan(SEEDS.length * 6)
        expect(report).toEqual([])
      })
    }

    it('control: without the zones the two near corners are both dressed on a minority of seeds', () => {
      // the organic draw + the loop-4 bands, the zone flags stripped: the
      // notebooks and the plant back on the near band, the books and the
      // pencil cup on the far band (their pre-"layout" registry)
      const legacy = LINEUP.map(({ workZone: _z, zoneLead: _l, ...a }) =>
        a.id === 'desk-notebooks' || a.id === 'desk-plant'
          ? { ...a, farBand: undefined, nearBand: true }
          : a.id === 'desk-books' || a.id === 'desk-pencil-cup'
            ? { ...a, farBand: true }
            : a,
      )
      let both = 0
      for (const seed of SEEDS) {
        const placed = placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: legacy, deskBand: 150, seed, view: DEFAULT_CHROME.view }))
        const c = cornersDressed(DEFAULT_CHROME, placed)
        if (c.left && c.right) both++
      }
      // measured 2026-10-10: 2 of 24 seeds — so the gate above
      // (every seed, both chromes) goes red without the zones
      expect(both / SEEDS.length, `${both} of ${SEEDS.length} seeds with both near corners dressed`).toBeLessThan(0.5)
    })

    it('no desk prop overlaps another\'s footprint, and an animal keeps WILDLIFE_GAP more — in every world, with and without a view (quality pass "layout")', () => {
      const report: string[] = []
      let pairs = 0
      for (const seed of SEEDS) {
        for (const world of ['workbench', 'city'] as const) {
          for (const density of ['normal', 'rich'] as const) {
            for (const view of [undefined, DEFAULT_CHROME.view, WIDE_LEFT.view]) {
              const desk = run({ seed, world, density, view }).filter((p) => p.onDesk)
              for (let i = 0; i < desk.length; i++) {
                for (let j = i + 1; j < desk.length; j++) {
                  const [p, q] = [desk[i], desk[j]]
                  const wild = [p, q].some((o) => byId.get(o.archetypeId)!.rotation === 'face-camera-3q')
                  const minD = (radiusOf(p) + radiusOf(q) + (wild ? WILDLIFE_GAP : 0)) * 0.999
                  pairs++
                  if (Math.abs(p.x - q.x) < minD && Math.abs(p.z - q.z) < minD) report.push(`seed ${seed} ${world} ${density} ${view ? 'view' : '-'}: ${p.propId} / ${q.propId}`)
                }
              }
            }
          }
        }
      }
      expect(pairs).toBeGreaterThan(SEEDS.length * 100)
      expect(report).toEqual([])
    })

    it('control: without the wildlife gap an animal stands closer to a desk prop than WILDLIFE_GAP on some seeds', () => {
      // the moose and the beaver as plain props (a random yaw: no wildlife
      // rules at all) — tp-final's moose stood 12 units from the blueprint
      const plain = LINEUP.map((a) => (a.rotation === 'face-camera-3q' ? { ...a, rotation: 'random-y' as const } : a))
      let close = 0
      for (const seed of SEEDS) {
        const desk = placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: plain, deskBand: 150, seed, view: DEFAULT_CHROME.view })).filter((p) => p.onDesk)
        for (const m of desk.filter((p) => p.archetypeId === 'moose' || p.archetypeId === 'beaver')) {
          for (const q of desk) {
            if (q === m) continue
            const minD = radiusOf(m) + radiusOf(q) + WILDLIFE_GAP
            if (Math.abs(m.x - q.x) < minD && Math.abs(m.z - q.z) < minD) close++
          }
        }
      }
      // measured 2026-10-10: 21 (animal, prop) pairs over the 24 seeds
      expect(close).toBeGreaterThan(0)
    })

    for (const [chrome, frame] of [['default chrome', DEFAULT_CHROME], ['wide left panel', WIDE_LEFT]] as const) {
      it(`workbench, ${chrome}: an animal never stands on a desk prop ON SCREEN — its projected box meets no other desk prop's (quality pass "layout")`, () => {
        const report: string[] = []
        for (const seed of SEEDS) {
          for (const density of ['normal', 'rich'] as const) {
            report.push(...standsOn(frame, run({ seed, density, view: frame.view })).map((h) => `seed ${seed} ${density}: ${h}`))
          }
        }
        expect(report).toEqual([])
      })
    }

    it('control: as plain props the animals do stand on other desk props on screen', () => {
      const plain = LINEUP.map((a) => (a.rotation === 'face-camera-3q' ? { ...a, rotation: 'random-y' as const } : a))
      let hits = 0
      for (const seed of SEEDS) {
        const placed = placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: plain, deskBand: 150, seed, view: DEFAULT_CHROME.view }))
        if (standsOn(DEFAULT_CHROME, placed).length > 0) hits++
      }
      // measured 2026-10-10: 13 of 24 seeds
      expect(hits, `${hits} of ${SEEDS.length} seeds`).toBeGreaterThan(0)
    })

    it('no view: the work-zone pieces are drawn last, so they never displace an older prop', () => {
      // with a view they are lifted and re-laid in their zones; without one
      // they take only the cells every older prop left
      const zoned = new Set(LINEUP.filter((a) => a.workZone).map((a) => a.id))
      const without = LINEUP.filter((a) => !a.workZone)
      for (const seed of SEEDS) {
        const a = placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: LINEUP, deskBand: 150, seed })).filter((p) => !zoned.has(p.archetypeId))
        const b = placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: without, deskBand: 150, seed }))
        expect(a, `seed ${seed}`).toEqual(b)
      }
    })

    it('the lamp: no desk prop stands on its foot, and the greenery gathers beside it', () => {
      // Scene3D parks the lamp at (0.46 w, −35) off the slab's far edge,
      // scale 0.5 (foot radius 58 × 0.5)
      const lamp = { x: SX0 + (SX1 - SX0) * 0.46, z: SZ0 - 35, r: 29 }
      const report: string[] = []
      const dists: number[] = []
      for (const seed of SEEDS) {
        for (const view of [undefined, DEFAULT_CHROME.view]) {
          const desk = run({ seed, view, lamp }).filter((p) => p.onDesk)
          for (const p of desk) {
            if (Math.hypot(p.x - lamp.x, p.z - lamp.z) < radiusOf(p) + lamp.r) report.push(`seed ${seed}: ${p.propId} on the lamp`)
          }
          const plant = desk.find((p) => p.archetypeId === 'desk-plant')
          if (view && plant) dists.push(Math.hypot(plant.x - lamp.x, plant.z - lamp.z) - radiusOf(plant) - lamp.r)
        }
      }
      expect(report).toEqual([])
      expect(dists.length).toBe(SEEDS.length)
      // beside it: the plant's footprint within 40 units of the foot
      // (measured 2026-10-10: 3-13 over the 24 seeds)
      expect(Math.max(...dists), dists.map((d) => d.toFixed(0)).join(' ')).toBeLessThan(40)
    })

    it('the view changes ONLY the promoted pieces (showcase, companion, bands, work zones): every other prop keeps its exact pose — or leaves from under an animal', () => {
      // loop 4 added the foreground COMPANION (the camp mug), promoted by the
      // same view; loop 4 r2 the NEAR-BAND set pieces, loop 4 r3 the
      // FAR-BAND ones; quality pass "layout" the WORK ZONES (which took over
      // loop 4 r4's gap fillers). They are the only archetypes the view may
      // move. The one other change it may make: an organic desk prop an
      // animal would stand on (its box or its WILDLIFE_GAP) leaves the desk.
      const promoted = new Set(['canada-flag', ...LINEUP.filter((a) => a.companion || a.nearBand || a.farBand || a.workZone).map((a) => a.id)])
      expect(promoted.size, 'the flag, the mug, two animals, two far-band pieces and eleven other zone pieces').toBe(15)
      const view = DEFAULT_CHROME.view
      let dropped = 0
      for (const seed of SEEDS.slice(0, 8)) {
        const strip = (ps: ReturnType<typeof placeDecor>) => ps.filter((p) => !promoted.has(p.archetypeId))
        const withView = placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: LINEUP, deskBand: 150, seed, view }))
        const kept = strip(withView)
        const before = strip(placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: LINEUP, deskBand: 150, seed })))
        // every survivor is exactly where it was, in the same order…
        expect(kept, `seed ${seed}`).toEqual(before.filter((p) => kept.some((q) => q.propId === p.propId)))
        // …and every prop that left stood where an animal now does
        const animals = withView.filter((p) => p.onDesk && (p.archetypeId === 'moose' || p.archetypeId === 'beaver'))
        const boxes = deskBoxes(DEFAULT_CHROME, [...animals, ...before])
        for (const gone of before.filter((p) => !kept.some((q) => q.propId === p.propId))) {
          dropped++
          const g = boxes.find((b) => b.p === gone)!
          const crowded = animals.some((m) => {
            const mb = boxes.find((b) => b.p === m)!
            const minD = radiusOf(m) + radiusOf(gone) + WILDLIFE_GAP
            const onScreen = mb.x0 < g.x1 + 4 && g.x0 < mb.x1 + 4 && mb.y0 < g.y1 + 4 && g.y0 < mb.y1 + 4
            return gone.onDesk && (onScreen || (Math.abs(m.x - gone.x) < minD && Math.abs(m.z - gone.z) < minD))
          })
          expect(crowded, `seed ${seed}: ${gone.propId} left without an animal on it`).toBe(true)
        }
      }
      // measured 2026-10-10: 1 organic prop over the 8 boards — a rare last
      // resort, not a way to clear the desk
      expect(dropped).toBeLessThanOrEqual(4)
    })

    it('ONE of each animal on the desk — never a second moose or beaver (loop 4 r4)', () => {
      // workbench-wide.png (loop 4 r4): a moose at (1240,355) and another at
      // (1160,690), beavers at (668,255), (1010,725) and (995,858) — repeated
      // animals read as scatter. Every desk animal id is held to one instance
      // with and without a view, in both worlds and at every density; with a
      // view the near band still shows the one there is.
      const animals = ['moose', 'beaver', 'loon']
      const over: string[] = []
      let shown = 0
      let runs = 0
      for (const seed of SEEDS) {
        for (const world of ['workbench', 'city'] as const) {
          for (const density of ['sparse', 'normal', 'rich'] as const) {
            for (const view of [undefined, DEFAULT_CHROME.view, WIDE_LEFT.view]) {
              const placed = run({ seed, world, density, view }).filter((p) => p.onDesk)
              runs++
              for (const id of animals) {
                const n = placed.filter((p) => p.archetypeId === id).length
                if (n > 1) over.push(`seed ${seed} ${world} ${density} ${view ? 'view' : 'no view'}: ${n} × ${id}`)
              }
              if (world === 'workbench' && view && density !== 'sparse') {
                if (placed.some((p) => p.archetypeId === 'moose') && placed.some((p) => p.archetypeId === 'beaver')) shown++
              }
            }
          }
        }
      }
      expect(runs).toBe(SEEDS.length * 2 * 3 * 3)
      expect(over, 'a desk animal placed twice').toEqual([])
      // the near band still carries both on every framed workbench board
      expect(shown, 'framed workbench boards showing the moose AND the beaver').toBe(SEEDS.length * 2 * 2)
    })

    /** The projected HEIGHT of a placed prop: its foot and its top (registry
     * `height` × scale) at its centre, through the THREE camera — what the
     * harness's wide-shot gate measures (run.mjs evalWildlifeFrame). */
    const standPx = (frame: ReturnType<typeof frameFor>, p: { x: number; z: number; scale: number }, id: string) => {
      const foot = new THREE.Vector3(p.x, DESK_Y, p.z).project(frame.cam)
      const top = new THREE.Vector3(p.x, DESK_Y + byId.get(id)!.height! * p.scale, p.z).project(frame.cam)
      return ((top.y - foot.y) / 2) * VP.height
    }
    /** Lineup with the wildlife at its pre-pass desk size (the growth divided
     * back out of the jitter, the city scale unchanged) — the control. */
    const ungrown = LINEUP.map((a) =>
      a.id === 'moose' || a.id === 'beaver'
        ? { ...a, scaleJitter: [a.scaleJitter[0] / (a.id === 'moose' ? MOOSE_DESK_GROWTH : BEAVER_DESK_GROWTH), a.scaleJitter[1] / (a.id === 'moose' ? MOOSE_DESK_GROWTH : BEAVER_DESK_GROWTH)] as [number, number] }
        : a,
    )
    const WILDLIFE_PX = { moose: 80, beaver: 50 } as const

    for (const [chrome, frame, bars] of [
      ['default chrome', DEFAULT_CHROME, WILDLIFE_PX],
      // a dragged-open left panel narrows the fit and pulls the camera back
      // (0.38 px/unit here against 0.57 on the default chrome): the bars are
      // the default framing's, so this chrome holds the framing only
      ['wide left panel', WIDE_LEFT, { moose: 0, beaver: 0 }],
    ] as const) {
      it(`workbench, ${chrome}: the moose and the beaver stand framed in the foreground${bars.moose ? ', >= 80 px and >= 50 px tall' : ''} (wildlife pass)`, () => {
        // workbench-wide.png (quality pass "wildlife"): "at the default
        // framing the moose is about 40 px and the beaver about 25 px — brown
        // specks". Each must stand wholly inside the safe rect, its foot in
        // the lower half of it, and project at least its bar (foot to top at
        // its centre). Measured 2026-10-09 on this fixture over 24 seeds:
        // default chrome moose 81.3-90.5 px, beaver 51.1-58.0 px; wide left
        // panel 55.5-61.1 / 35.1-39.6. The live board's nearer camera reads
        // ~10 % more per unit (0.63 against 0.57 — .probes/wildlife), and the
        // harness gates it there on the real GLB heights (run.mjs
        // evalWildlifeFrame).
        const report: string[] = []
        for (const seed of SEEDS) {
          const placed = run({ seed, view: frame.view })
          for (const id of ['moose', 'beaver'] as const) {
            const mine = placed.filter((p) => p.archetypeId === id && p.onDesk)
            expect(mine.length, `seed ${seed}: one ${id}`).toBe(1)
            const p = mine[0]
            const h = standPx(frame, p, id)
            const b = frame.box(p, id)
            if (h < bars[id] || !frame.inside(p, id) || b.y1 < frame.safe.y + frame.safe.h * 0.5) {
              report.push(`seed ${seed}: ${id} ${h.toFixed(1)} px, box [${[b.x0, b.y0, b.x1, b.y1].map(Math.round).join(', ')}]`)
            }
          }
        }
        expect(report).toEqual([])
      })
    }

    it('control: at the pre-pass desk size the same placement leaves the moose and the beaver under their bars', () => {
      const under = { moose: 0, beaver: 0 }
      for (const seed of SEEDS) {
        const placed = placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: ungrown, deskBand: 150, seed, view: DEFAULT_CHROME.view }))
        for (const id of ['moose', 'beaver'] as const) {
          const p = placed.find((q) => q.archetypeId === id && q.onDesk)
          if (p && standPx(DEFAULT_CHROME, p, id) < WILDLIFE_PX[id]) under[id]++
        }
      }
      // measured 2026-10-09: 24 of 24 seeds under the bar for each animal (the
      // promotion alone already frames them in the foreground) — so the gate
      // above goes red if the growth is dropped
      expect(under.moose, 'pre-pass moose under 80 px').toBeGreaterThanOrEqual(20)
      expect(under.beaver, 'pre-pass beaver under 50 px').toBeGreaterThanOrEqual(20)
    })

    it('control: without the city band the city moose and beaver stand outside the framed near apron on most seeds', () => {
      // the organic draw alone (the near-band pass skipped the city before
      // the wildlife pass): the probe's city-wide frame had the moose on the
      // FAR apron at (1049,300) and the beaver under the tool rail
      const legacy = LINEUP.map(({ nearBand: _n, ...a }) => a)
      let near = 0
      let total = 0
      for (const seed of SEEDS) {
        const placed = placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: legacy, deskBand: 150, seed, world: 'city', view: DEFAULT_CHROME.view }))
        for (const id of ['moose', 'beaver']) {
          const p = placed.find((q) => q.archetypeId === id && q.onDesk)
          if (!p) continue
          total++
          if (DEFAULT_CHROME.inside(p, id) && DEFAULT_CHROME.box(p, id).y1 >= DEFAULT_CHROME.safe.y + DEFAULT_CHROME.safe.h * 0.5) near++
        }
      }
      // measured 2026-10-09: 8 of 44 (18 %) — the gates below (every one)
      // go red if the city stops banding them
      expect(total, 'the organic draw places the city fauna').toBeGreaterThan(SEEDS.length)
      expect(near / total, `${near} of ${total} organic city animals already framed-near`).toBeLessThan(0.5)
    })

    for (const [chrome, frame] of [['default chrome', DEFAULT_CHROME], ['wide left panel', WIDE_LEFT]] as const) {
      it(`city, ${chrome}: the moose and the beaver stand framed on the NEAR apron, at maquette size (wildlife pass)`, () => {
        // the city keeps its maquette scale (never a desk-size moose among the
        // walk-ups), so what the pass can buy there is the FRAME: each animal
        // wholly inside the safe rect, its foot in the lower half, on the
        // bare apron. Projected 4.4-6.7 px tall on this fixture's default
        // chrome (3.0-4.6 on the wide left panel), measured 2026-10-09.
        const report: string[] = []
        for (const seed of SEEDS) {
          const placed = run({ seed, world: 'city', view: frame.view })
          for (const id of ['moose', 'beaver'] as const) {
            const mine = placed.filter((p) => p.archetypeId === id && p.onDesk)
            expect(mine.length, `seed ${seed}: one city ${id}`).toBe(1)
            const p = mine[0]
            const a = byId.get(id)!
            // the cityScale rule: never taller than the K = 1 walk-up (12.5;
            // people-scale beside the CITY_SCALE plaza blocks)
            expect(a.height! * p.scale, `seed ${seed}: city ${id} at maquette size`).toBeLessThanOrEqual(12.5 + 0.1)
            const r = a.footprint * p.scale
            const dOut = Math.max(SX0 - p.x, p.x - SX1, SZ0 - p.z, p.z - SZ1)
            expect(dOut + r, `seed ${seed}: city ${id} inside the apron`).toBeLessThanOrEqual(CITY_HOLE_APRON + 1e-9)
            const b = frame.box(p, id)
            if (!frame.inside(p, id) || b.y1 < frame.safe.y + frame.safe.h * 0.5) report.push(`seed ${seed}: ${id} [${[b.x0, b.y0, b.x1, b.y1].map(Math.round).join(', ')}]`)
          }
        }
        expect(report).toEqual([])
      })
    }

    it('control: with the pre-r4 caps (moose 2, beaver uncapped) the desk does carry duplicates', () => {
      // the gate above is not vacuous: under the r3 caps this fixture puts a
      // second moose or beaver on the desk on at least one seed
      const legacy = LINEUP.map((a) =>
        a.id === 'moose' ? { ...a, maxCount: 2 } : a.id === 'beaver' ? { ...a, maxCount: undefined } : a,
      )
      let dup = 0
      for (const seed of SEEDS) {
        for (const density of ['normal', 'rich'] as const) {
          const placed = placeDecor(input({ nodes: NODES, connections: CONNS, archetypes: legacy, deskBand: 150, seed, density })).filter((p) => p.onDesk)
          if (placed.filter((p) => p.archetypeId === 'moose').length > 1 || placed.filter((p) => p.archetypeId === 'beaver').length > 1) dup++
        }
      }
      expect(dup, 'seeds where the legacy caps placed a second moose or beaver').toBeGreaterThan(0)
    })
  })

  it('void: there is no desk plane, so there are no desk props', () => {
    for (const seed of SEEDS.slice(0, 6)) {
      const placed = placeDecor(input({ archetypes: LINEUP, deskBand: 150, world: 'void', seed }))
      expect(placed.filter((p) => p.onDesk)).toEqual([])
      expect(placed.length, 'the board itself is still dressed').toBeGreaterThan(0)
    }
  })

  it('workbench and studio keep the exact pre-world placement (default world = workbench)', () => {
    for (const seed of SEEDS.slice(0, 6)) {
      const legacy = placeDecor(input({ archetypes: LINEUP, deskBand: 150, seed }))
      expect(placeDecor(input({ archetypes: LINEUP, deskBand: 150, seed, world: 'workbench' }))).toEqual(legacy)
      expect(placeDecor(input({ archetypes: LINEUP, deskBand: 150, seed, world: 'studio' }))).toEqual(legacy)
    }
  })
})

describe('board leaves keep off the diagram (view3d quality loop 2, round 2)', () => {
  // the critic's board shape: cards close together, a store, cables between
  // them and two label plates — "a red+yellow pair touches Query API's corner"
  const nodes = [
    { id: 'web', type: 'app', rect: { x: 100, y: 80, w: 220, h: 120 } },
    { id: 'api', type: 'app', rect: { x: 400, y: 80, w: 220, h: 120 } },
    { id: 'alert', type: 'app', rect: { x: 100, y: 300, w: 220, h: 120 } },
    { id: 'logs', type: 'store', rect: { x: 700, y: 300, w: 160, h: 150 } },
  ]
  const connections = [
    { points: [{ x: 320, y: 140 }, { x: 400, y: 140 }] },
    { points: [{ x: 210, y: 200 }, { x: 210, y: 300 }] },
    { points: [{ x: 620, y: 160 }, { x: 700, y: 360 }] },
  ]
  const avoid = [
    { x: 330, y: 150, w: 60, h: 21 },
    { x: 220, y: 240, w: 70, h: 21 },
  ]
  const rectGap = (r: { x: number; y: number; w: number; h: number }, x: number, z: number) =>
    Math.hypot(Math.max(r.x - x, 0, x - r.x - r.w), Math.max(r.y - z, 0, z - r.y - r.h))
  const segGap = (pts: { x: number; y: number }[], x: number, z: number) => {
    let best = Infinity
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const dx = b.x - a.x
      const dz = b.y - a.y
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.y) * dz) / (dx * dx + dz * dz || 1)))
      best = Math.min(best, Math.hypot(x - a.x - t * dx, z - a.y - t * dz))
    }
    return best
  }
  const leaves = DECOR_PACKS.find((p) => p.id === 'canadiana')!.archetypes.filter(
    (a) => a.id.startsWith('maple-leaf') && (a.zone ?? 'board') === 'board',
  )
  /** Smallest gap between any board leaf's footprint and the diagram, over seeds. */
  const worstGap = (archetypes: PropArchetype[]) => {
    let worst = Infinity
    let count = 0
    for (let s = 0; s < 24; s++) {
      for (const p of placeDecor(input({ archetypes, seed: 0x51000 + s * 7919, nodes, connections, avoid }))) {
        if (p.onDesk || !p.archetypeId.startsWith('maple-leaf')) continue
        count++
        const r = archetypes.find((a) => a.id === p.archetypeId)!.footprint * p.scale
        for (const n of nodes) worst = Math.min(worst, rectGap(n.rect, p.x, p.z) - r)
        for (const c of connections) worst = Math.min(worst, segGap(c.points, p.x, p.z) - r)
        for (const b of avoid) worst = Math.min(worst, rectGap(b, p.x, p.z) - r)
      }
    }
    return { worst, count }
  }

  it('every board leaf archetype carries the clearance', () => {
    expect(leaves.length).toBeGreaterThan(0)
    for (const a of leaves) expect(a.clearance, a.id).toBe(BOARD_LEAF_CLEARANCE)
    // and the lone hero blades are off the canadiana paper
    expect(leaves.some((a) => a.id.startsWith('maple-leaf-mini'))).toBe(false)
  })

  it('no leaf footprint comes within BOARD_LEAF_CLEARANCE of a card, a cable or a label', () => {
    const { worst, count } = worstGap(leaves)
    expect(count, 'leaves still land on the paper').toBeGreaterThan(24)
    expect(worst).toBeGreaterThanOrEqual(BOARD_LEAF_CLEARANCE - 1e-6)
  })

  it('control: without the clearance the same supply DOES land against the diagram', () => {
    const legacy = leaves.map(({ clearance: _c, ...a }) => a)
    expect(worstGap(legacy).worst).toBeLessThan(10)
  })
})
