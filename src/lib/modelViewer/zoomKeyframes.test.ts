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
import { zoomKeyframes, type ZoomKeyframe, type ZoomUser } from './zoomKeyframes'

const K = 3.4
const FOCAL = { x: 825, y: 501 }
const IDENTITY: ZoomUser = { k: 1, tx: 0, ty: 0 }

interface Fn {
  name: 'translate' | 'scale'
  args: number[]
}

/** Parse the two functions the keyframes use (`translate(Xpx, Ypx)`, `scale(S)`). */
function parse(transform: string): Fn[] {
  return [...transform.matchAll(/(translate|scale)\(([^)]*)\)/g)].map((m) => ({
    name: m[1] as Fn['name'],
    args: m[2].split(',').map((v) => Number.parseFloat(v)),
  }))
}

/** What the browser does with two transform lists: when they match function by
 * function, each pair is interpolated on its own (translate with translate,
 * scale with scale). Anything else falls back to matrix decomposition — which
 * this helper deliberately does not model, so a mismatch fails loudly. */
function sample(from: ZoomKeyframe, to: ZoomKeyframe, a: number) {
  const f = parse(from.transform)
  const t = parse(to.transform)
  expect(f.map((fn) => fn.name)).toEqual(t.map((fn) => fn.name))
  let s = 1
  let e = 0
  let g = 0 // the composite maps x → s·x + e, y → s·y + g (uniform scale only)
  // functions apply right to left: the LAST one acts on the point first
  const lerped = f.map((fn, i) => ({ name: fn.name, args: fn.args.map((v, j) => v + (t[i].args[j] - v) * a) }))
  for (const fn of [...lerped].reverse()) {
    if (fn.name === 'scale') {
      s *= fn.args[0]
      e *= fn.args[0]
      g *= fn.args[0]
    } else {
      e += fn.args[0]
      g += fn.args[1]
    }
  }
  return { s, e, g, opacity: from.opacity + (to.opacity - from.opacity) * a }
}

const FRACTIONS = [0, 0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 0.95, 1]

/** The drill zoom is a pure scale about the opened tile. A keyframe pair whose
 * transform lists differ makes the browser interpolate the translates apart from
 * the scale, and the zoom's pivot slides across the screen: it started at the
 * viewport's top-left corner and travelled to the tile, so the diagram drifted
 * diagonally toward the bottom right before settling (measured 2026-10-20: pivot
 * (99, 60) → (822, 499) for a tile at (825, 501)). */
describe('drill zoom keyframes', () => {
  const cases = [
    ['dive: the level being left', 'in', 'out'],
    ['dive: the level being entered', 'in', 'in'],
    ['ascent: the level being left', 'out', 'out'],
    ['ascent: the level being entered', 'out', 'in'],
  ] as const

  it.each(cases)('%s — both keyframes use the same transform functions in the same order', (_label, dir, layer) => {
    for (const user of [IDENTITY, { k: 2.05, tx: -738, ty: -421 }]) {
      const [from, to] = zoomKeyframes(dir, FOCAL, user, K)[layer]
      expect(parse(from.transform).map((fn) => fn.name)).toEqual(parse(to.transform).map((fn) => fn.name))
    }
  })

  it.each(cases)('%s — the pivot stays on the focal point for the whole zoom', (_label, dir, layer) => {
    const [from, to] = zoomKeyframes(dir, FOCAL, IDENTITY, K)[layer]
    for (const a of FRACTIONS) {
      const { s, e, g } = sample(from, to, a)
      if (Math.abs(1 - s) < 1e-6) continue // no scaling at this instant: no pivot to speak of
      expect(e / (1 - s)).toBeCloseTo(FOCAL.x, 6)
      expect(g / (1 - s)).toBeCloseTo(FOCAL.y, 6)
    }
  })

  it('dive: the left level grows into the tile while the entered level lands at identity', () => {
    const { out, in: entering } = zoomKeyframes('in', FOCAL, IDENTITY, K)
    expect(sample(out[0], out[1], 0)).toMatchObject({ s: 1, opacity: 1 })
    expect(sample(out[0], out[1], 1)).toMatchObject({ s: K, opacity: 0 })
    const start = sample(entering[0], entering[1], 0)
    expect(start.s).toBeCloseTo(1 / K, 9)
    expect(start.opacity).toBe(0)
    const end = sample(entering[0], entering[1], 1)
    expect(end).toMatchObject({ s: 1, opacity: 1 })
    expect(end.e).toBeCloseTo(0, 9)
    expect(end.g).toBeCloseTo(0, 9)
  })

  it('ascent: the left level shrinks into its tile in the parent layout; the entered level lands at identity', () => {
    const { out, in: entering } = zoomKeyframes('out', FOCAL, IDENTITY, K)
    expect(sample(out[0], out[1], 1).s).toBeCloseTo(1 / K, 9)
    expect(sample(entering[0], entering[1], 0).s).toBeCloseTo(K, 9)
    const end = sample(entering[0], entering[1], 1)
    expect(end).toMatchObject({ s: 1, opacity: 1 })
    expect(end.e).toBeCloseTo(0, 9)
  })

  it('composes the user pan/zoom: it starts from what is on screen and the dive lands at identity', () => {
    const user: ZoomUser = { k: 2, tx: -300, ty: -120 }
    const { out, in: entering } = zoomKeyframes('in', FOCAL, user, K)
    // the left level starts exactly where the user left it
    const start = sample(out[0], out[1], 0)
    expect(start.s).toBeCloseTo(user.k, 9)
    expect(start.e).toBeCloseTo(user.tx, 9)
    expect(start.g).toBeCloseTo(user.ty, 9)
    // the entered level blooms out of the opened tile's ON-SCREEN position
    const bloom = sample(entering[0], entering[1], 0)
    const screenTile = { x: user.k * FOCAL.x + user.tx, y: user.k * FOCAL.y + user.ty }
    expect(bloom.e + bloom.s * FOCAL.x).toBeCloseTo(screenTile.x, 6)
    expect(bloom.g + bloom.s * FOCAL.y).toBeCloseTo(screenTile.y, 6)
    // ... and lands at identity
    const end = sample(entering[0], entering[1], 1)
    expect(end).toMatchObject({ s: 1 })
    expect(end.e).toBeCloseTo(0, 9)
    expect(end.g).toBeCloseTo(0, 9)
  })

  it('dive from a user-zoomed view: the left level ends scaled K× more, about the same on-screen tile', () => {
    const user: ZoomUser = { k: 2, tx: -300, ty: -120 }
    const { out } = zoomKeyframes('in', FOCAL, user, K)
    const screenTile = { x: user.k * FOCAL.x + user.tx, y: user.k * FOCAL.y + user.ty }
    for (const a of [0, 0.3, 1]) {
      const { s, e, g } = sample(out[0], out[1], a)
      // the opened tile never moves on screen, whatever the progress
      expect(e + s * FOCAL.x).toBeCloseTo(screenTile.x, 6)
      expect(g + s * FOCAL.y).toBeCloseTo(screenTile.y, 6)
    }
    expect(sample(out[0], out[1], 1).s).toBeCloseTo(user.k * K, 9)
  })

  it('ascent from a user-zoomed view: starts on the user view, ends shrunk 1/K about the focal point with no user term', () => {
    const user: ZoomUser = { k: 2, tx: -300, ty: -120 }
    const { out } = zoomKeyframes('out', FOCAL, user, K)
    const start = sample(out[0], out[1], 0)
    expect(start.s).toBeCloseTo(user.k, 9)
    expect(start.e).toBeCloseTo(user.tx, 9)
    expect(start.g).toBeCloseTo(user.ty, 9)
    const end = sample(out[0], out[1], 1)
    expect(end.s).toBeCloseTo(1 / K, 9)
    expect(end.e / (1 - end.s)).toBeCloseTo(FOCAL.x, 6) // pivot on the focal point, user transform gone
    expect(end.g / (1 - end.s)).toBeCloseTo(FOCAL.y, 6)
  })
})
