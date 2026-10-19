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
import { cableProfileFor, cableYAt } from './cableProfile'
import {
  LABEL_ELLIPSIS,
  LABEL_MIN_CHARS,
  LABEL_NUDGE,
  LABEL_ON_WIRE_SLACK,
  apparentZone,
  cameraSide,
  distanceToPolyline,
  fitLabel,
  labelAbbreviations,
  litLabelPlacement,
  resolveScreenLabels,
  type ScreenLabel,
  occluderBox,
  onWireMaxDistance,
  onWireSpots,
  wireAnchor,
  type Box,
  type Occluder,
  type Pt,
} from './connLabelPlacement'
import { roomiestSpot, scaleAbout, settleScales } from './labelLegibility'
import { convexGap } from './screenClearance'
import { contrastRatio, ensureContrast } from './palette'

const R = 2.4
const W = 80
const H = 21

/** A straight 300 px wire from `from` along unit `tan`. */
function straight(from: Pt, tan: Pt, len = 300) {
  return (t: number) => ({ pt: { x: from.x + tan.x * len * t, y: from.y + tan.y * len * t }, tan })
}

/** The wire as a polyline (what the distance is measured against). */
function polyline(sample: (t: number) => { pt: Pt }, n = 48): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => sample(i / n).pt)
}

const boxOf = (p: { x: number; y: number }): Box => ({ x: p.x - W / 2, y: p.y - H / 2, w: W, h: H })
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('lit connection label placement: ON its own wire', () => {
  // a 300 px run: plugs at 20 / 18 (layer-local), resting at -6
  const profile = cableProfileFor(20, 18, -6, 300)
  const base = { offset: 0, plateW: W, plateH: H, cableR: R, profile }

  it.each([
    ['horizontal wire', { x: 1, y: 0 }],
    ['vertical wire', { x: 0, y: 1 }],
    ['diagonal wire', { x: Math.SQRT1_2, y: Math.SQRT1_2 }],
    ['reverse diagonal', { x: -Math.SQRT1_2, y: Math.SQRT1_2 }],
  ])("sits on a %s, at offset 0 and at the 2D de-collider's ±12", (_label, tan) => {
    const sample = straight({ x: 100, y: 200 }, tan)
    for (const offset of [0, 12, -12]) {
      const placed = litLabelPlacement({ ...base, sample, t: 0.5, offset })
      // free board: the centre is ON the line
      expect(distanceToPolyline(placed, polyline(sample))).toBeLessThan(1e-9)
      expect(placed.appliedT).toBe(0.5)
      expect(placed.blocked).toBe(false)
    }
  })

  it('the tolerance is half the (scaled) plate height plus the slack', () => {
    expect(onWireMaxDistance(H)).toBe(H / 2 + LABEL_ON_WIRE_SLACK)
    expect(onWireMaxDistance(H, 2)).toBe(H + LABEL_ON_WIRE_SLACK)
  })

  it('every candidate any stage may take is on the wire, nearest the preferred position first', () => {
    for (const tan of [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 0.6, y: 0.8 }]) {
      const sample = straight({ x: 0, y: 0 }, tan)
      const line = polyline(sample)
      const spots = onWireSpots(sample, 0.5, H, 1)
      expect(spots.length).toBeGreaterThan(20)
      expect(spots[0]).toMatchObject({ t: 0.5, offset: 0 })
      for (const s of spots) {
        expect(distanceToPolyline(s, line)).toBeLessThanOrEqual((LABEL_NUDGE * H) / 2 + 1e-9)
        expect(s.t).toBeGreaterThanOrEqual(0.1)
        expect(s.t).toBeLessThanOrEqual(0.9)
      }
      // arc positions never move AWAY from 0.5 before a nearer one was tried
      let far = 0
      for (const s of spots) {
        expect(Math.abs(s.t - 0.5)).toBeGreaterThanOrEqual(far - 1e-9)
        far = Math.max(far, Math.abs(s.t - 0.5))
      }
    }
  })

  it('a label being dragged follows the pointer along the wire, its offset clamped to the nudge', () => {
    const sample = straight({ x: 0, y: 0 }, { x: 1, y: 0 })
    const card: Box = { x: 100, y: 0, w: 100, h: 60 }
    const placed = litLabelPlacement({ ...base, sample, t: 0.4, offset: 30, obstacles: [card], dragging: true })
    expect(placed).toMatchObject({ x: 120, appliedT: 0.4 })
    expect(placed.y).toBeCloseTo((LABEL_NUDGE * H) / 2, 9)
    expect(placed.appliedOffset).toBeCloseTo((LABEL_NUDGE * H) / 2, 9)
  })

  it('floats above the tube at its t on the resting run', () => {
    const placed = litLabelPlacement({ ...base, sample: straight({ x: 0, y: 0 }, { x: 1, y: 0 }), t: 0.5 })
    expect(placed.lift).toBeGreaterThanOrEqual(cableYAt(profile, 0.5) + R)
  })

  it('near a plug shoulder, floats above the HIGHEST tube point under its footprint', () => {
    // the regression: t sits on the rest, but the plate footprint reaches
    // the rising shoulder — the old `cableYAt(t) + 5.5` put the tube through
    // the text there
    // (0.25, not the beside-the-wire rule's 0.3: an on-wire plate's
    // footprint reaches its half-diagonal, not that plus a ~17 px offset,
    // so 0.3 no longer reaches the 0.18-long shoulder)
    const t = 0.25
    const placed = litLabelPlacement({ ...base, sample: straight({ x: 0, y: 0 }, { x: 1, y: 0 }), t })
    const reach = Math.hypot(W, H) / 2 + Math.abs(placed.appliedOffset)
    let maxUnder = -Infinity
    for (let i = 0; i <= 200; i++) {
      const s = t - reach / 300 + ((2 * reach) / 300) * (i / 200)
      maxUnder = Math.max(maxUnder, cableYAt(profile, Math.max(0, Math.min(1, s))))
    }
    // 12-sample max of a smootherstep shoulder vs a 200-sample max: within 0.5 px
    expect(placed.lift).toBeGreaterThanOrEqual(maxUnder + R - 0.5)
    expect(placed.lift).toBeGreaterThan(cableYAt(profile, t) + 5.5)
  })

  it('the camera side is the side a nudge tries first; +x for a wire parallel to y', () => {
    // offsets apply along n = (-tan.y, tan.x)
    expect(cameraSide({ x: 1, y: 0 })).toBe(1) // n=(0,1): +y
    expect(cameraSide({ x: -1, y: 0 })).toBe(-1) // n=(0,-1): flip to +y
    expect(cameraSide({ x: 0, y: -1 })).toBe(1) // n=(1,0): +x
    // camera due east (+x): a wire along y nudges toward +x
    expect(cameraSide({ x: 0, y: 1 }, { x: 1, y: 0 })).toBe(-1) // n=(-1,0) → flip
    const sample = straight({ x: 0, y: 0 }, { x: 1, y: 0 })
    // a thin strip ON the wire's far (-y) half at every t: only a nudge clears it
    const strip: Box = { x: -100, y: -12, w: 500, h: 11.5 }
    const placed = litLabelPlacement({ ...base, sample, t: 0.5, obstacles: [strip] })
    expect(placed.y).toBeGreaterThan(0)
    expect(overlaps(boxOf(placed), strip)).toBe(false)
    expect(distanceToPolyline(placed, polyline(sample))).toBeLessThanOrEqual(onWireMaxDistance(H))
  })

  it('slides ALONG the wire when its spot is blocked at t', () => {
    const sample = straight({ x: 0, y: 0 }, { x: 1, y: 0 })
    // a narrow card across the wire at the label's t (x 130..170)
    const card: Box = { x: 130, y: -85, w: 40, h: 170 }
    const placed = litLabelPlacement({ ...base, sample, t: 0.5, obstacles: [card] })
    expect(placed.appliedT).not.toBe(0.5)
    expect(overlaps(boxOf(placed), card)).toBe(false)
    expect(placed.y).toBe(0) // still centred on the wire
  })

  it('the zone a tall node hides grows away from the camera', () => {
    const drum: Box = { x: 0, y: 0, w: 100, h: 100 }
    // camera south (+y) at 55° from zenith: 64 px tall → hides ~91 px north of it
    const hidden = occluderBox(drum, 64, { x: 0, y: 1 }, 55)
    expect(hidden.y).toBeCloseTo(-64 * Math.tan((55 * Math.PI) / 180), 6)
    expect(hidden.y + hidden.h).toBeCloseTo(100, 9)
    expect(hidden.x).toBe(0)
    expect(hidden.w).toBe(100)
    // a wire through that zone: its label slides out of it along the wire
    const sample = straight({ x: -100, y: -40 }, { x: 1, y: 0 })
    const placed = litLabelPlacement({ ...base, sample, t: 0.5, obstacles: [hidden], toward: { x: 0, y: 1 } })
    expect(overlaps(boxOf(placed), hidden)).toBe(false)
    expect(distanceToPolyline(placed, polyline(sample))).toBeLessThanOrEqual(onWireMaxDistance(H))
  })

  it('when every spot is blocked, takes the least covered one — still on the wire', () => {
    const sample = straight({ x: 0, y: 0 }, { x: 1, y: 0 })
    // the near (+y) half of the wire is buried, the far half only grazed
    const near: Box = { x: -1000, y: 0, w: 3000, h: 1000 }
    const farGraze: Box = { x: -1000, y: -1000, w: 3000, h: 985 } // ends at y = -15
    const placed = litLabelPlacement({ ...base, sample, t: 0.5, obstacles: [near, farGraze] })
    expect(placed.blocked).toBe(true)
    expect(placed.y).toBeLessThan(0)
    expect(distanceToPolyline(placed, polyline(sample))).toBeLessThanOrEqual(onWireMaxDistance(H))
  })

  it('falls back to its own spot at t when everything is blocked', () => {
    const sample = straight({ x: 0, y: 0 }, { x: 1, y: 0 })
    const wall: Box = { x: -1000, y: -1000, w: 3000, h: 3000 }
    const placed = litLabelPlacement({ ...base, sample, t: 0.5, obstacles: [wall] })
    expect(placed).toMatchObject({ appliedT: 0.5, appliedOffset: 0, blocked: true, x: 150, y: 0 })
  })
})

describe('lit label placement is tested where things are SEEN (loop 2 round 2)', () => {
  // the iso preset: camera at 55° from the zenith; in the connection layer's
  // frame (layer at plat 6 + 2) an ungrouped card spans −8 … 10 (depth 18)
  const POLAR = 55
  const toward = { x: 0, y: 1 }
  const K = Math.tan((POLAR * Math.PI) / 180)
  const profile = cableProfileFor(10, 10, -6, 300)
  const base = { offset: 0, plateW: W, plateH: H, cableR: R, profile, toward, polarDeg: POLAR }
  const CARD_BOTTOM = -8
  const CARD_TOP = 10

  it('apparentZone: a card grows a front skirt toward the camera and a hidden zone away from it', () => {
    const card = { box: { x: 0, y: 0, w: 100, h: 100 }, bottom: CARD_BOTTOM, top: CARD_TOP }
    const z = apparentZone(card, 8, toward, POLAR)
    // front skirt: (lift − bottom)·tan toward the camera (+y)
    expect(z.y + z.h).toBeCloseTo(100 + (8 - CARD_BOTTOM) * K, 6)
    // hidden zone: (top − lift)·tan away from it
    expect(z.y).toBeCloseTo(-(CARD_TOP - 8) * K, 6)
    // floated above the top, the whole zone slides toward the camera
    const above = apparentZone(card, CARD_TOP + 1.5, toward, POLAR)
    expect(above.y).toBeCloseTo(1.5 * K, 6)
  })

  it("a plate boxed in between two cards stays on its wire — no float over the card tops ('notifies')", () => {
    // two cards one short wire apart, north and south of it, both extending
    // far along x: the wire has no free board anywhere. The old search
    // floated the plate over the card tops and stepped it out to clearance
    // + 42 px; the caller then slid it up to 200 px away
    const north = { x: -400, y: -150, w: 1100, h: 140 } // ends at y = −10
    const south = { x: -400, y: 10, w: 1100, h: 140 } // starts at y = 10
    const sample = straight({ x: 0, y: 0 }, { x: 1, y: 0 })
    const cards: Occluder[] = [north, south].map((box) => ({ box, bottom: CARD_BOTTOM, top: CARD_TOP }))
    // a chip on the south card's top near its north edge, text: the least
    // covered spot keeps off it first
    const chip: Occluder = { box: { x: 130, y: 12, w: 40, h: 16 }, bottom: CARD_TOP, top: CARD_TOP, hard: true }
    const placed = litLabelPlacement({ ...base, sample, t: 0.5, occluders: [...cards, chip] })
    expect(placed.blocked).toBe(true)
    expect(distanceToPolyline(placed, polyline(sample))).toBeLessThanOrEqual(onWireMaxDistance(H))
    // it floats over its own tube only (no card-top float)
    expect(placed.lift).toBeLessThan(CARD_TOP)
  })

  it('a plate in front of a card stays off its front skirt by sliding along the wire', () => {
    // a card just north of a horizontal wire, over the middle of its run:
    // at t = 0.5 the plate is SEEN on the card's front wall
    const card: Occluder = { box: { x: 100, y: -60, w: 100, h: 48 }, bottom: CARD_BOTTOM, top: CARD_TOP }
    const sample = straight({ x: 0, y: 0 }, { x: 1, y: 0 })
    const at = litLabelPlacement({ ...base, sample, t: 0.5, dragging: true })
    expect(overlaps(boxOf(at), apparentZone(card, at.lift, toward, POLAR)), 'the defect at t').toBe(true)
    const placed = litLabelPlacement({ ...base, sample, t: 0.5, occluders: [card] })
    expect(overlaps(boxOf(placed), apparentZone(card, placed.lift, toward, POLAR))).toBe(false)
    expect(placed.blocked).toBe(false)
    expect(distanceToPolyline(placed, polyline(sample))).toBeLessThanOrEqual(onWireMaxDistance(H))
  })
})

/**
 * Quality pass "labels" round 2 — the regression. On the live workbench
 * board (connLabelWireInfo probe, DPR 1, before this change) every one of
 * the ten plates sat 41-183 world px from its own cable, 'notifies' 183 and
 * 'writes' 68 (~150 css px up-left of any wire in
 * tp2-final-dpr1/workbench-wide.png). This replays the pipeline Scene3D runs
 * — placement, the legibility pre-pass's slide to room it can grow into
 * (roomiestSpot over the candidate list), the pairwise settle, growth about
 * the anchor — on two wires shaped like those, and measures every plate as
 * drawn against its OWN polyline.
 */
describe('every plate, as drawn at the scale it wears, sits on its own wire (tp2: notifies / writes)', () => {
  const profile = cableProfileFor(10, 10, -6, 300)
  const KWANT = 2
  const KCAP = 2.2

  interface Wire {
    name: string
    sample: (t: number) => { pt: Pt; tan: Pt }
    w: number
  }
  // 'writes': a long run boxed in along its whole length by a column of
  // cards just off both sides — room to grow only far off the wire
  // 'notifies': a short run between two cards
  const wires: Wire[] = [
    { name: 'writes', sample: straight({ x: 0, y: 0 }, { x: 0, y: 1 }, 400), w: 56 },
    { name: 'notifies', sample: straight({ x: 300, y: 100 }, { x: 0, y: 1 }, 40), w: 64 },
  ]
  const nodes: Box[] = [
    // writes: cards hugging the wire 34 px either side, all along it
    { x: -150, y: -20, w: 116, h: 440 },
    { x: 34, y: -20, w: 116, h: 440 },
    // notifies: the cards it joins (north and south of its 40 px run)
    { x: 200, y: 0, w: 200, h: 100 },
    { x: 200, y: 140, w: 200, h: 100 },
  ]
  const wireBoxes = (except: string): Box[] =>
    wires
      .filter((w) => w.name !== except)
      .flatMap((w) => polyline(w.sample, 12).map((p) => ({ x: p.x - 3, y: p.y - 3, w: 6, h: 6 })))

  it('placement + slide-to-room + settle + growth keep every centre within half its height + slack', () => {
    const drawn = wires.map((wire) => {
      const placed = litLabelPlacement({ sample: wire.sample, t: 0.5, offset: 12, plateW: wire.w, plateH: H, cableR: R, profile, obstacles: nodes })
      const obstacles = [...nodes, ...wireBoxes(wire.name)]
      // the pre-pass: the placed spot first, then every candidate spot
      const spots = [{ t: placed.appliedT, offset: placed.appliedOffset, x: placed.x, y: placed.y }, ...onWireSpots(wire.sample, 0.5, H, 1)].map((s) => {
        const box = { x: s.x - wire.w / 2, y: s.y - H / 2, w: wire.w, h: H }
        return { box, anchor: wireAnchor(s, wire.w, H, wire.sample(s.t).pt) }
      })
      const best = roomiestSpot(spots, obstacles, KCAP, KWANT)
      const pick = spots[best?.index ?? 0]
      return { wire, box: pick.box, anchor: pick.anchor, k: best?.k ?? 1 }
    })
    const ks = settleScales(
      drawn.map((d) => d.box),
      drawn.map((d) => d.k),
      drawn.map((d) => d.anchor),
    )
    drawn.forEach((d, i) => {
      // the screen pass's floor: a label shrunk to it still wears >= 1.4
      const k = Math.max(ks[i], 1.4)
      const g = scaleAbout(d.box, k, d.anchor)
      const centre = { x: g.x + g.w / 2, y: g.y + g.h / 2 }
      const dist = distanceToPolyline(centre, polyline(d.wire.sample))
      expect(dist, `${d.wire.name}: ${dist.toFixed(1)} px from its wire at k ${k.toFixed(2)}`).toBeLessThanOrEqual(onWireMaxDistance(H, k))
    })
  })
})

describe('label contrast floor', () => {
  it('lifts the studio label grey to AA on its plate', () => {
    expect(contrastRatio('#8C877F', '#E7E6E2')).toBeLessThan(4.5)
    const fixed = ensureContrast('#8C877F', '#E7E6E2', 4.5)
    expect(contrastRatio(fixed, '#E7E6E2')).toBeGreaterThanOrEqual(4.5)
  })

  it('lifts the studio card subtitle grey to AA on the white card', () => {
    expect(contrastRatio('#9A958C', '#FFFFFF')).toBeLessThan(4.5)
    const fixed = ensureContrast('#9A958C', '#FFFFFF', 4.5)
    expect(contrastRatio(fixed, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
  })

  it('leaves an already-readable color unchanged (made opaque)', () => {
    expect(ensureContrast('#1E1D1B', '#FFFFFF', 4.5)).toBe('rgba(30, 29, 27, 1)')
  })

  it('lightens on a dark plate', () => {
    const fixed = ensureContrast('#3A3732', '#161513', 4.5)
    expect(contrastRatio(fixed, '#161513')).toBeGreaterThanOrEqual(4.5)
  })

  it('composites a translucent foreground before measuring', () => {
    expect(contrastRatio('rgba(0,0,0,0.2)', '#FFFFFF')).toBeLessThan(contrastRatio('#000000', '#FFFFFF'))
  })
})

describe('crowded wires: a label with no free spot is abbreviated, else hidden (TASK 2)', () => {
  /** A plate on screen: 7 px per character + 14 px of padding, 20 px tall,
   * centred at (cx, cy) — the shape Scene3D projects. */
  const plate = (cx: number, cy: number) => (shown: string) => {
    const w = Array.from(shown).length * 7 + 14
    return [
      { x: cx - w / 2, y: cy - 10 },
      { x: cx + w / 2, y: cy - 10 },
      { x: cx + w / 2, y: cy + 10 },
      { x: cx - w / 2, y: cy + 10 },
    ]
  }
  const rect = (x0: number, y0: number, x1: number, y1: number) => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
  const xRange = (h: readonly { x: number }[]) => [Math.min(...h.map((p) => p.x)), Math.max(...h.map((p) => p.x))]
  const GAP = 2.5

  it('offers the full text, then ellipsized prefixes down to the minimum, longest first', () => {
    expect(LABEL_MIN_CHARS).toBe(4)
    const a = labelAbbreviations('searches')
    expect(a[0]).toBe('searches')
    // 'searche…' is as long as the label itself: not an abbreviation
    expect(a).toEqual(['searches',`search${LABEL_ELLIPSIS}`, `searc${LABEL_ELLIPSIS}`, `sear${LABEL_ELLIPSIS}`])
    for (const s of a.slice(1)) expect(Array.from(s.slice(0, -1)).length).toBeGreaterThanOrEqual(LABEL_MIN_CHARS)
    // too short to abbreviate
    expect(labelAbbreviations('uses')).toEqual(['uses'])
    expect(labelAbbreviations('reads')).toEqual(['reads'])
    // trailing spaces are not kept before the ellipsis
    expect(labelAbbreviations('read all logs')).toContain(`read${LABEL_ELLIPSIS}`)
    expect(labelAbbreviations('read all logs')).not.toContain(`read ${LABEL_ELLIPSIS}`)
  })

  it('fitLabel keeps the longest reading that fits, else hides', () => {
    expect(fitLabel('evaluates', () => true)).toEqual({ state: 'full', text: 'evaluates' })
    expect(fitLabel('evaluates', (s) => s.length <= 6)).toEqual({ state: 'abbreviated', text: `evalu${LABEL_ELLIPSIS}` })
    expect(fitLabel('evaluates', (s) => s.length <= 4)).toEqual({ state: 'hidden', text: null })
  })

  it('draws a label whole when its plate is clear', () => {
    const labels: ScreenLabel[] = [{ id: 'a', text: 'queries', spots: 1, hullFor: plate(100, 100) }]
    const card = rect(200, 0, 300, 200)
    expect(resolveScreenLabels(labels, [card], GAP).get('a')).toMatchObject({ state: 'full', text: 'queries' })
  })

  it("abbreviates a label boxed in between two cards (the 40-px 'queries' hop) — and never past them", () => {
    // full 'queries' is 63 px wide: centred at 100 it spans 68.5-131.5
    const left = rect(0, 0, 70, 200)
    const right = rect(130, 0, 300, 200)
    const show = resolveScreenLabels([{ id: 'q', text: 'queries', spots: 1, hullFor: plate(100, 100) }], [left, right], GAP).get('q')!
    expect(show.state).toBe('abbreviated')
    expect(show.text).toBe(`quer${LABEL_ELLIPSIS}`)
    const [x0, x1] = xRange(plate(100, 100)(show.text!))
    expect(x0).toBeGreaterThanOrEqual(70 + GAP)
    expect(x1).toBeLessThanOrEqual(130 - GAP)
  })

  it('hides a label when not even the shortest abbreviation is clear (searches behind the drum)', () => {
    const drum = rect(80, 80, 120, 120)
    const show = resolveScreenLabels([{ id: 's', text: 'searches', spots: 1, hullFor: plate(100, 100) }], [drum], GAP).get('s')
    expect(show).toMatchObject({ state: 'hidden', text: null })
  })

  it('never draws two plates over each other: the one whose full plate is clear of the nodes keeps its room', () => {
    // 'a' (first in input order) crowds a card; 'b' is clear of every node
    // and sits where 'a' would reach
    const card = rect(0, 0, 80, 200)
    const labels: ScreenLabel[] = [
      { id: 'a', text: 'consumes', spots: 1, hullFor: plate(110, 100) },
      { id: 'b', text: 'notifies', spots: 1, hullFor: plate(180, 100) },
    ]
    const out = resolveScreenLabels(labels, [card], GAP)
    expect(out.get('b')).toMatchObject({ state: 'full', text: 'notifies' })
    const a = out.get('a')!
    expect(a).toMatchObject({ state: 'abbreviated', text: `cons${LABEL_ELLIPSIS}` })
    if (a.text !== null) {
      const [ax0, ax1] = xRange(plate(110, 100)(a.text))
      const [bx0] = xRange(plate(180, 100)('notifies'))
      expect(ax0).toBeGreaterThanOrEqual(80 + GAP)
      expect(ax1).toBeLessThanOrEqual(bx0 - GAP)
    }
  })

  it('a hovered or selected label is shown whole (discoverable), and the others make room for it', () => {
    const drum = rect(80, 80, 120, 120)
    const labels: ScreenLabel[] = [
      { id: 'n', text: 'notifies', spots: 1, hullFor: plate(160, 100) },
      { id: 's', text: 'searches', forced: true, spots: 1, hullFor: plate(100, 100) },
    ]
    const out = resolveScreenLabels(labels, [drum], GAP)
    expect(out.get('s')).toMatchObject({ state: 'full', text: 'searches' })
    // 'notifies' would have been whole without the forced plate beside it
    expect(resolveScreenLabels([labels[0]], [drum], GAP).get('n')!.state).toBe('full')
    expect(out.get('n')!.state).not.toBe('full')
  })

  it('a label crowded where it sits takes the first spot on its wire with room, whole before abbreviated (zoom gives room elsewhere)', () => {
    // spot 0 (where it sits) is over a card; spot 1 has room for 'quer…'
    // only; spot 2 has room for the whole label
    const card = rect(70, 70, 130, 130)
    const spots = [plate(100, 100), plate(200, 100), plate(400, 100)]
    const narrow = [rect(150, 0, 170, 200), rect(230, 0, 250, 200)]
    const l: ScreenLabel = { id: 'q', text: 'queries', spots: 3, hullFor: (shown, s) => spots[s](shown) }
    expect(resolveScreenLabels([l], [card, ...narrow], GAP).get('q')).toEqual({ state: 'full', text: 'queries', spot: 2 })
    // without the roomy spot: the abbreviation, at spot 1
    const two: ScreenLabel = { ...l, spots: 2 }
    expect(resolveScreenLabels([two], [card, ...narrow], GAP).get('q')).toEqual({ state: 'abbreviated', text: `quer${LABEL_ELLIPSIS}`, spot: 1 })
    // a forced label stays where it sits, whole
    expect(resolveScreenLabels([{ ...l, forced: true }], [card, ...narrow], GAP).get('q')).toEqual({ state: 'full', text: 'queries', spot: 0 })
  })

  it('every unforced plate it returns is clear of every obstacle and every other plate (randomized)', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const words = ['queries', 'notifies', 'consumes', 'reads', 'evaluates', 'searches', 'uses', 'writes', 'ships', 'publishes']
    for (let trial = 0; trial < 40; trial++) {
      const nodes = Array.from({ length: 6 }, () => {
        const x = rnd() * 600
        const y = rnd() * 400
        return rect(x, y, x + 60 + rnd() * 120, y + 40 + rnd() * 80)
      })
      const labels: ScreenLabel[] = words.map((text, i) => {
        const at = Array.from({ length: 3 }, () => plate(rnd() * 600, rnd() * 400))
        return { id: String(i), text, spots: at.length, hullFor: (shown: string, s: number) => at[s](shown) }
      })
      const out = resolveScreenLabels(labels, nodes, GAP)
      const drawn = labels.flatMap((l) => {
        const s = out.get(l.id)!
        return s.text === null ? [] : [l.hullFor(s.text, s.spot)]
      })
      const sep = (a: readonly { x: number; y: number }[], b: readonly { x: number; y: number }[]) => {
        const [ax0, ax1] = xRange(a)
        const [bx0, bx1] = xRange(b)
        const ay = [Math.min(...a.map((p) => p.y)), Math.max(...a.map((p) => p.y))]
        const by = [Math.min(...b.map((p) => p.y)), Math.max(...b.map((p) => p.y))]
        return ax0 - bx1 >= GAP - 1e-9 || bx0 - ax1 >= GAP - 1e-9 || ay[0] - by[1] >= GAP - 1e-9 || by[0] - ay[1] >= GAP - 1e-9
      }
      for (let i = 0; i < drawn.length; i++) {
        for (const n of nodes) expect(sep(drawn[i], n)).toBe(true)
        for (let j = i + 1; j < drawn.length; j++) expect(sep(drawn[i], drawn[j])).toBe(true)
      }
      for (const l of labels) {
        const s = out.get(l.id)!
        if (s.state === 'abbreviated') expect(Array.from(s.text).length - 1).toBeGreaterThanOrEqual(LABEL_MIN_CHARS)
      }
    }
  })

  // fifth arrow iteration: the cue pass and the label pass did not know about
  // each other — a head stood through 'reads' ('re' left of it,
  // tp8-final-dpr1 workbench-arrows-az90.png; 12 head-over-plate overlaps in
  // 4 of 8 shots, tp9-arrows5-base2 evalCueClash)
  /** A cone seen from the side on screen: its base edge at x0, its point at x1. */
  const cone = (x0: number, x1: number, cy: number, half = 12) => [
    { x: x0, y: cy - half },
    { x: x1, y: cy },
    { x: x0, y: cy + half },
  ]

  it('a head is an obstacle: a label it would cut takes the next spot on its wire, whole', () => {
    const spots = [plate(100, 100), plate(260, 100)]
    const l: ScreenLabel = { id: 'r', text: 'reads', spots: 2, hullFor: (shown, s) => spots[s](shown) }
    const head = cone(95, 135, 100)
    // without the heads it stays where it sits, cut through
    expect(resolveScreenLabels([l], [], GAP).get('r')).toEqual({ state: 'full', text: 'reads', spot: 0 })
    const out = resolveScreenLabels([l], [], GAP, undefined, [head])
    expect(out.get('r')).toEqual({ state: 'full', text: 'reads', spot: 1 })
    expect(convexGap(spots[1]('reads'), head)).toBeGreaterThanOrEqual(GAP)
  })

  it('beside a head with no free spot on its wire a label abbreviates, else hides — never drawn over the head', () => {
    // 'queries' is 63 px wide centred at 100 (68.5-131.5): a head whose base
    // edge stands at 128 leaves room for 'quer…' only
    const l: ScreenLabel = { id: 'q', text: 'queries', spots: 1, hullFor: plate(100, 100) }
    const out = resolveScreenLabels([l], [], GAP, undefined, [cone(128, 170, 100)])
    expect(out.get('q')).toEqual({ state: 'abbreviated', text: `quer${LABEL_ELLIPSIS}`, spot: 0 })
    const covered = resolveScreenLabels([l], [], GAP, undefined, [cone(80, 120, 100, 20)])
    expect(covered.get('q')).toMatchObject({ state: 'hidden', text: null })
    // the hovered / selected connection still shows its label whole
    expect(resolveScreenLabels([{ ...l, forced: true }], [], GAP, undefined, [cone(80, 120, 100, 20)]).get('q')).toMatchObject({ state: 'full' })
  })
})
