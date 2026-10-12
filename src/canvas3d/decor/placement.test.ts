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
import { MAX_PER_ARCHETYPE, MAX_TOTAL, placeDecor, type PlacementInput, type PropArchetype } from './placement'

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
