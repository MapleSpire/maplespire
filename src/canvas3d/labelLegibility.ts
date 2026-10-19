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

/**
 * Legibility of the board's text at the framing people actually see.
 *
 * VIEW3D QUALITY LOOP 3 r2: at the fit-to-screen framing of a 9-card board
 * (1600 x 1000, both side panels open) the card titles were ~7 px of grey
 * on cream and the connection labels ~5 px — readable only in the zoomed
 * shots, reported in round 1 and unchanged in round 2. The fit is
 * width-bound (the cards already span the unobstructed width at the iso
 * azimuth), so the camera cannot simply move closer: the text has to use
 * the room the card and the cable shoulder actually have.
 *
 *  • CARD TITLES are NOT touched here. A FAR variant (the name in Inter 700,
 *    up to 34 px, filling the face and hiding badge, subtitle and pill at
 *    wide framings) shipped from this module and was rejected by the user
 *    on 2026-10-10 ("régressions sur la police et la taille de la police et
 *    l'icône par rapport à avant"): card and drum faces keep the base
 *    design at every framing.
 *  • CONNECTION LABELS keep their size up close and GROW when the camera is
 *    far — away from the cable they label, until the projected cap height
 *    reaches MIN_CAP_PX or the plate would touch a card, a drum, another
 *    label or a cable it does not already float over (`freeScale` +
 *    `settleScales`, computed at build). A label boxed in by its neighbours
 *    stays small: the room is the limit, measured, not assumed.
 *
 * Pure functions: Scene3D measures, these decide.
 */

/** Inter's cap height per em (capHeight 2048 / unitsPerEm 2816, Inter 3.x). */
export const INTER_CAP_EM = 0.727

/** The projected cap height a board label is held to (css px). 11 px caps
 * are ~15 px text, the smallest body size the app's own chrome uses. */
export const MIN_CAP_PX = 11

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** The scale that lifts a label's projected cap height to `minCapPx`,
 * clamped to [1, kMax] — never shrinks, never past the room it has. */
export function legibleScale(capPx: number, kMax: number, minCapPx = MIN_CAP_PX): number {
  if (!(capPx > 0) || !Number.isFinite(capPx)) return 1
  return Math.max(1, Math.min(kMax, minCapPx / capPx))
}

/** Area of the intersection of two boxes (0 when apart or touching). */
export function overlapArea(a: Rect, b: Rect): number {
  return (
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  )
}

/**
 * Where a growth / placement test finds its obstacles: a plain list
 * (scanned) or an index over one (BoxGrid). `some` visits — once each — a
 * SUPERSET of the obstacles that may overlap `r`, until `visit` returns
 * true, and says whether it did; every caller tests each visited obstacle
 * exactly, so an index changes the cost, never an answer.
 */
export interface ObstacleSource {
  some(r: Rect, visit: (o: Obstacle, i: number) => boolean): boolean
}
export type Obstacles = readonly Obstacle[] | ObstacleSource

function listSource(list: readonly Obstacle[]): ObstacleSource {
  return {
    some: (_r, visit) => {
      for (let i = 0; i < list.length; i++) if (visit(list[i], i)) return true
      return false
    },
  }
}
const sourceOf = (o: Obstacles): ObstacleSource =>
  Array.isArray(o) ? listSource(o as readonly Obstacle[]) : (o as ObstacleSource)

const GRID_CELL = 48
const GRID_SPAN = 32768 // cells per axis either side of 0 the key encodes
const cellOf = (v: number) => Math.floor(v / GRID_CELL)
/** The cell range of `r`, or null when a grid cannot key it (non-finite,
 * past GRID_SPAN cells, or covering more than 4096 cells). */
function cellRange(r: Rect): [number, number, number, number] | null {
  const x0 = cellOf(r.x)
  const x1 = cellOf(r.x + r.w)
  const y0 = cellOf(r.y)
  const y1 = cellOf(r.y + r.h)
  if (!Number.isFinite(x0 + x1 + y0 + y1)) return null
  if (Math.max(Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1)) >= GRID_SPAN) return null
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return null
  return [x0, x1, y0, y1]
}
const cellKey = (cx: number, cy: number) => (cx + GRID_SPAN) * 2 * GRID_SPAN + (cy + GRID_SPAN)

/**
 * A uniform grid over an obstacle list, for a pass that asks it many times:
 * the label pass tests every candidate spot of every label against ~1200
 * card zones and wire samples, and the scan made overlapArea its top self
 * cost on the 67-connection board 0ob3fum (48 ms self, connect-freeze
 * profile 2026-10-11). Built once; `list` must not change after.
 */
export class BoxGrid implements ObstacleSource {
  private readonly cells = new Map<number, number[]>()
  /** boxes the grid cannot key (cellRange null): visited by every query */
  private readonly always: number[] = []
  private readonly seen: Uint32Array
  private stamp = 0
  readonly list: readonly Obstacle[]
  constructor(list: readonly Obstacle[]) {
    this.list = list
    this.seen = new Uint32Array(list.length)
    for (let i = 0; i < list.length; i++) {
      const c = cellRange(list[i])
      if (!c) {
        this.always.push(i)
        continue
      }
      for (let cx = c[0]; cx <= c[1]; cx++) {
        for (let cy = c[2]; cy <= c[3]; cy++) {
          const k = cellKey(cx, cy)
          const cell = this.cells.get(k)
          if (cell) cell.push(i)
          else this.cells.set(k, [i])
        }
      }
    }
  }

  some(r: Rect, visit: (o: Obstacle, i: number) => boolean): boolean {
    const c = cellRange(r)
    if (!c) {
      for (let i = 0; i < this.list.length; i++) if (visit(this.list[i], i)) return true
      return false
    }
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0)
      this.stamp = 1
    }
    const stamp = this.stamp
    for (const i of this.always) {
      this.seen[i] = stamp
      if (visit(this.list[i], i)) return true
    }
    for (let cx = c[0]; cx <= c[1]; cx++) {
      for (let cy = c[2]; cy <= c[3]; cy++) {
        const cell = this.cells.get(cellKey(cx, cy))
        if (!cell) continue
        for (const i of cell) {
          if (this.seen[i] === stamp) continue
          this.seen[i] = stamp
          if (visit(this.list[i], i)) return true
        }
      }
    }
    return false
  }
}

/** The obstacles of every source, as one. */
export function unionSource(...sources: Obstacles[]): ObstacleSource {
  const all = sources.map(sourceOf)
  return { some: (r, visit) => all.some((s) => s.some(r, visit)) }
}

/** `source` without the obstacles `drop` names (by their index in it). */
export function exceptSource(source: ObstacleSource, drop: (i: number) => boolean): ObstacleSource {
  return { some: (r, visit) => source.some(r, (o, i) => !drop(i) && visit(o, i)) }
}

/** True when `box` overlaps any obstacle by more than `eps` (area) —
 * `obstacles.some((o) => overlapArea(box, o) > eps)`. */
export function overlapsAny(box: Rect, obstacles: Obstacles, eps = 1e-6): boolean {
  return sourceOf(obstacles).some(box, (o) => overlapArea(box, o) > eps)
}

/** A point a box grows away from (default: its centre). */
export interface Anchor {
  x: number
  y: number
}

/** `box` scaled by `k` about `anchor` (default: its own centre). A label
 * beside its cable anchors on the side FACING the cable, so it grows away
 * from the wire it labels instead of onto it. */
export function scaleAbout(box: Rect, k: number, anchor?: Anchor): Rect {
  const ax = anchor?.x ?? box.x + box.w / 2
  const ay = anchor?.y ?? box.y + box.h / 2
  return { x: ax + (box.x - ax) * k, y: ay + (box.y - ay) * k, w: box.w * k, h: box.h * k }
}

/** An obstacle to a growing label. `strict`: the label may never cover MORE
 * of it than it does at its own size (a body that hides what is behind it on
 * screen — a drum). Otherwise one the label already overlaps at k = 1 is no
 * limit at all: the placement floated the label over that card top or cable
 * with a lift, and growing over the same surface is not a new collision. */
export interface Obstacle extends Rect {
  strict?: boolean
}

/**
 * The largest k in [1, kCap] (on a `step` grid) for which `box`, scaled
 * about `anchor`, collides with no obstacle under the rules above.
 * (loop3-r2-fix-f: 'reads', already grazing the Log store drum's screen
 * shadow, grew x1.6 into it while every overlapped obstacle was ignored;
 * fix-g: holding EVERY obstacle to its k = 1 overlap froze 6 of 10 labels,
 * grazing their own cable.) Returns 1 when even the first step collides.
 */
export function freeScale(box: Rect, obstacles: Obstacles, kCap: number, anchor?: Anchor, step = 0.05): number {
  // only what the LARGEST box reaches can bind (every grown box, and the
  // box itself, lies inside it — the anchor is on or in the box): the same
  // answer, without testing every card and wire sample on the board at each
  // step (roomiestSpot calls this for hundreds of candidate spots)
  const reach = scaleAbout(box, Math.max(1, kCap), anchor)
  const near: Obstacle[] = []
  sourceOf(obstacles).some(reach, (o) => {
    if (overlapArea(reach, o) > 0) near.push(o)
    return false
  })
  const own = near.map((o) => overlapArea(box, o))
  const live = near.map((o, i) => o.strict === true || own[i] === 0)
  let k = 1
  // integer steps: an accumulated `next += step` drifts past exact contact
  for (let n = 1; 1 + n * step <= kCap + 1e-9; n++) {
    const next = 1 + n * step
    const grown = scaleAbout(box, next, anchor)
    if (near.some((o, i) => live[i] && overlapArea(grown, o) > own[i] + 1e-6)) break
    k = next
  }
  return k
}

/** A place a label could sit: its box at its own size and the point it
 * grows away from. */
export interface GrowthSpot {
  box: Rect
  anchor?: Anchor
}

/**
 * Where along its wire a label has the room to grow to `kWant`.
 *
 * VIEW3D QUALITY LOOP 4 r1 (report.json legibility.labels, both
 * backgrounds): growth frozen at the spot the placement chose kept 7 of 10
 * labels at k <= 1.45 — 4.7-7.2 px caps at the fit framing, 'consumes'
 * pinned at k = 1 between the Event bus drum and the Rollup worker — while
 * the same wire had free board a few tenths of its length away. The
 * caller lists candidate spots in preference order (the placed spot first,
 * then slides along the path); a spot whose box already touches an
 * obstacle at its own size is skipped (`freeScale` would ignore what it
 * already covers). Returns the first spot that reaches `kWant`, else the
 * roomiest (the earliest on a tie), else null when no spot is clean.
 */
export function roomiestSpot(
  spots: readonly GrowthSpot[],
  obstacles: Obstacles,
  kCap: number,
  kWant: number,
  step = 0.05,
): { index: number; k: number } | null {
  const source = sourceOf(obstacles)
  let best: { index: number; k: number } | null = null
  for (let i = 0; i < spots.length; i++) {
    const { box, anchor } = spots[i]
    if (overlapsAny(box, source)) continue
    const k = freeScale(box, source, kCap, anchor, step)
    if (k >= kWant - 1e-9) return { index: i, k }
    if (!best || k > best.k + 1e-9) best = { index: i, k }
  }
  return best
}

/**
 * Settle a set of boxes that all want to grow: each starts at its own free
 * scale, and any pair that would then overlap shrinks its larger member
 * until the pair clears (or both are back at 1). Deterministic: pairs are
 * resolved in index order, repeated until nothing moves.
 */
export function settleScales(
  boxes: readonly Rect[],
  ks: readonly number[],
  anchors: readonly (Anchor | undefined)[] = [],
  step = 0.05,
): number[] {
  const out = [...ks]
  const at = (i: number) => scaleAbout(boxes[i], out[i], anchors[i])
  const area = overlapArea
  for (let pass = 0; pass < 64; pass++) {
    let moved = false
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        // growth must not ADD overlap: a pair placed touching or overlapping
        // at their own size keeps exactly that much (measured: 'writes' grew
        // x2.04 across 'notifies' in loop3-r2-fix-d/workbench-wide.png when
        // pairs overlapping at k = 1 were skipped instead)
        const own = area(boxes[i], boxes[j])
        while (area(at(i), at(j)) > own + 1e-6 && (out[i] > 1 || out[j] > 1)) {
          if (out[i] >= out[j]) out[i] = Math.max(1, out[i] - step)
          else out[j] = Math.max(1, out[j] - step)
          moved = true
        }
      }
    }
    if (!moved) break
  }
  return out
}
