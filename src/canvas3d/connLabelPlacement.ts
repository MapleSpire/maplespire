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

import { cableYAt, type CableProfile } from './cableProfile'
import { convexOverlap } from './screenClearance'

/**
 * Where a LIT-profile connection label sits relative to its cable (pure math).
 *
 * A lit cable is a 3D tube that dives to its supports and rises into its
 * plugs, so the old rule (plate at `cableYAt(t) + 5.5`) let the tube cut
 * through the text wherever the cable was higher anywhere under the plate
 * than at `t` — the plug shoulders (view3d quality loop screenshots,
 * 2026-10-08, the run.mjs DSL board: 'consumes bus', 'evaluates', 'reads'
 * crossed by their cables). The plate now floats above the HIGHEST cable
 * sample under its whole footprint (± its half-diagonal + its offset, in arc
 * length), by the tube radius + a clearance — so no part of its own tube is
 * above it — and it is opaque, drawn after the cable: the tube runs in under
 * one edge and out the other, the 2D reading.
 *
 * ON THE WIRE, ALWAYS (quality pass "labels" round 2, measured on the live
 * workbench board through the connLabelWireInfo probe, DPR 1: every one of
 * the ten plates sat 41-183 world px from its own cable — 'notifies' 183,
 * 'searches' 180, 'consumes' 178 — and 'notifies' / 'writes' floated ~150 css
 * px up-left of any wire in tp2-final-dpr1/workbench-wide.png). The previous
 * rule put the plate BESIDE its wire, and every later stage was then free to
 * push it farther out: this search's own "a step farther out" distances (up
 * to clearance + 42), the legibility pre-pass's slides out to clearance + 120
 * looking for room to grow, and the screen pass's rings up to 200 px round
 * the wire point. A label 150 px from its wire labels nothing. The plate now
 * sits ON its own path — its centre within `onWireMaxDistance` of the
 * polyline (half its height plus `LABEL_ON_WIRE_SLACK`, at the scale it
 * wears). It may only slide ALONG the wire (nearest the preferred arc
 * position first) and nudge across it by `LABEL_NUDGE` of its half-height;
 * when no stretch of its wire is free it stays on the least covered one and
 * the caller shrinks it toward the readability floor. Every candidate any
 * stage may move a plate to comes from `onWireSpots`.
 *
 * SCREEN overlap, not board overlap (view3d quality loop 2, round 2:
 * city-wide.png / workbench-wide.png): a plate that floats at height L is
 * SEEN where the board point L·tan(polar) farther from the camera is seen.
 * Obstacles are `Occluder`s with a height range, and every candidate is
 * tested in that apparent space at the lift it actually floats at — which
 * also gives a card a FRONT SKIRT (the zone toward the camera where a plate at
 * lift L covers the card's front wall). Text-bearing features (a card's
 * type chip and title, a drum's name tag, labels already placed) are HARD:
 * the least covered spot is the one covering the least of them first.
 */

/** Vertical clearance between the tube top and the plate (world px). */
export const LABEL_CLEARANCE = 1.5
/** How far beyond half its (scaled) height a plate's centre may sit from its
 * own wire, in world px — the on-wire rule's tolerance. The plate floats
 * over the tube (tube radius 2.4-2.9 + LABEL_CLEARANCE + 0.4 above the
 * centreline on the resting run), and that height is most of it. */
export const LABEL_ON_WIRE_SLACK = 6
/** Cross-wire nudges a plate may take, as fractions of its half-height
 * (tried in order, the preferred side first): the wire stays under the
 * plate, at worst along its edge. */
export const LABEL_NUDGES = [2 / 3, 1]
/** The largest of them. */
export const LABEL_NUDGE = Math.max(...LABEL_NUDGES)
/** Arc-position slides, nearest the preferred position first. */
export const LABEL_SLIDES = [0, 0.06, -0.06, 0.12, -0.12, 0.18, -0.18, 0.24, -0.24, 0.3, -0.3, 0.36, -0.36, 0.42, -0.42]
/** A plate never slides closer than this to either plug (normalized arc). */
const T_MIN = 0.1
const T_MAX = 0.9
/** Cap on tan(polar) — the same cap `occluderBox` has always used. */
const MAX_REACH = 2

export interface Pt { x: number; y: number }
/** Axis-aligned box on the board plane (top-left + size). */
export interface Box { x: number; y: number; w: number; h: number }

/** The farthest a plate's centre may sit from its own wire (world px), at
 * scale `k`: half its height plus the slack. */
export function onWireMaxDistance(plateH: number, k = 1): number {
  return (plateH * k) / 2 + LABEL_ON_WIRE_SLACK
}

/** Distance (board plane) from `p` to the polyline `line`. */
export function distanceToPolyline(p: Pt, line: readonly Pt[]): number {
  if (line.length === 0) return Infinity
  if (line.length === 1) return Math.hypot(p.x - line[0].x, p.y - line[0].y)
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]
    const b = line[i]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const l2 = abx * abx + aby * aby
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2)) : 0
    best = Math.min(best, Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t))
  }
  return best
}

/** One place a plate may sit on its wire: arc position, signed normal offset
 * (|offset| <= LABEL_NUDGE x half-height), centre. */
export interface WireSpot {
  t: number
  offset: number
  x: number
  y: number
}

/** The largest normal offset a plate of height `plateH` may take. */
export function maxNudge(plateH: number): number {
  return (LABEL_NUDGE * plateH) / 2
}

/**
 * Every spot a plate may take on its own wire, in preference order: arc
 * positions nearest `t` first (clamped off the plugs), and at each one the
 * centre ON the wire, then nudged across it (`side` first). The only
 * candidate list any placement stage draws from — so no stage can move a
 * plate off its wire.
 */
export function onWireSpots(sample: (t: number) => { pt: Pt; tan: Pt }, t: number, plateH: number, side = 1): WireSpot[] {
  const offsets = [0]
  for (const f of LABEL_NUDGES) offsets.push((side * f * plateH) / 2, (-side * f * plateH) / 2)
  const out: WireSpot[] = []
  const seen = new Set<number>()
  for (const slide of LABEL_SLIDES) {
    const at = Math.max(T_MIN, Math.min(T_MAX, t + slide))
    const key = Math.round(at * 1e6)
    if (seen.has(key)) continue
    seen.add(key)
    const { pt, tan } = sample(at)
    for (const offset of offsets) {
      out.push({ t: at, offset, x: pt.x - tan.y * offset, y: pt.y + tan.x * offset })
    }
  }
  return out
}

/** The point a plate grows away from: its wire point, clamped into the
 * plate box — scaling about it keeps the wire under the plate (the centre
 * moves off the wire by at most k x |offset|). */
export function wireAnchor(centre: Pt, plateW: number, plateH: number, wirePt: Pt): Pt {
  return {
    x: Math.min(centre.x + plateW / 2, Math.max(centre.x - plateW / 2, wirePt.x)),
    y: Math.min(centre.y + plateH / 2, Math.max(centre.y - plateH / 2, wirePt.y)),
  }
}

/** A thing on the board with a height range, in the connection layer's local
 * heights (the plate `lift` is in the same frame). */
export interface Occluder {
  /** Board footprint (top-left + size). */
  box: Box
  /** Heights of its lowest and highest point (a flat decal: bottom = top). */
  bottom: number
  top: number
  /** Text-bearing (a card's chip or title, a drum's name tag, another
   * label): the least covered spot covers the least of these first. */
  hard?: boolean
}

export interface LitLabelPlacementInput {
  /** Path point and unit tangent at a normalized arc position. */
  sample: (t: number) => { pt: Pt; tan: Pt }
  /** Normalized arc position of the label. */
  t: number
  /** Stored offset along the normal (already clamped). Only a drag follows
   * it (clamped to the nudge); otherwise only its SIDE is kept, as the side
   * a nudge tries first. */
  offset: number
  plateW: number
  plateH: number
  cableR: number
  profile: CableProfile
  /** Boxes the plate must avoid at its own height (already inflated by the
   * caller; no screen-space shift is applied to these). */
  obstacles?: readonly Box[]
  /** Things with a height: tested where they and the plate are SEEN. */
  occluders?: readonly Occluder[]
  /** Camera polar angle from the zenith (degrees) the occluders are seen
   * at; 0 (default) = top-down, where height shifts nothing. */
  polarDeg?: number
  /** Board-plane unit vector toward the camera (default +y). */
  toward?: Pt
  /** A label-slide gesture is in progress: follow the pointer along the
   * wire (offset clamped to the nudge) — never jump to another spot. */
  dragging?: boolean
}

export interface LitLabelPlacement {
  /** Plate centre on the board plane. */
  x: number
  y: number
  /** Layer-local height of the plate's underside. */
  lift: number
  /** The arc position and signed normal offset actually used. */
  appliedT: number
  appliedOffset: number
  /** No unobstructed spot exists on the wire: the least covered one is
   * returned (the caller shrinks the plate). Never set while dragging. */
  blocked: boolean
}

/** Board-plane unit vector pointing toward the camera (+y by default: the
 * camera due "south" of its target at azimuth 0). */
const SOUTH: Pt = { x: 0, y: 1 }

/** +1 / -1: the normal side n = (-tan.y, tan.x) that faces `toward`; a wire
 * parallel to `toward` takes the +x side. */
export function cameraSide(tan: Pt, toward: Pt = SOUTH): number {
  const nx = -tan.y
  const ny = tan.x
  const facing = nx * toward.x + ny * toward.y
  return Math.abs(facing) > 1e-6 ? (facing > 0 ? 1 : -1) : (nx >= 0 ? 1 : -1)
}

/** The footprint of a node of `height` grown by the board zone it hides
 * from a camera at `polarDeg` (from zenith) looking from `toward`: a point
 * behind the node within height·tan(polar) is under its silhouette. The
 * swept box is the axis-aligned hull of the footprint and its copy pushed
 * away from the camera (conservative on a diagonal azimuth). */
export function occluderBox(footprint: Box, height: number, toward: Pt, polarDeg: number): Box {
  const reach = height * Math.min(2, Math.tan((Math.max(0, polarDeg) * Math.PI) / 180))
  const dx = -toward.x * reach
  const dy = -toward.y * reach
  const x0 = Math.min(footprint.x, footprint.x + dx)
  const y0 = Math.min(footprint.y, footprint.y + dy)
  const x1 = Math.max(footprint.x + footprint.w, footprint.x + footprint.w + dx)
  const y1 = Math.max(footprint.y + footprint.h, footprint.y + footprint.h + dy)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Area of the intersection of two boxes (0 when they do not overlap). */
export function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** The board box a plate floating at `lift` must stay out of to be clear of
 * `o` ON SCREEN. A point at height y is seen where the board point
 * y·tan(polar) farther from the camera is seen, so the plate box P (at
 * `lift`) and the occluder overlap on screen iff P overlaps the occluder's
 * footprint shifted TOWARD the camera by (lift − y)·tan(polar), for every y
 * in [bottom, top] — the hull of the two extreme shifts. Below the top the
 * zone grows toward the camera by lift·tan (the card's front skirt) and away
 * from it by (top − lift)·tan (the zone the card hides behind it). An
 * orthographic approximation of the preset view; `MAX_REACH` caps tan. */
export function apparentZone(o: Occluder, lift: number, toward: Pt, polarDeg: number): Box {
  const k = Math.min(MAX_REACH, Math.tan((Math.max(0, polarDeg) * Math.PI) / 180))
  const s0 = (lift - o.bottom) * k
  const s1 = (lift - o.top) * k
  const x0 = o.box.x + Math.min(toward.x * s0, toward.x * s1)
  const x1 = o.box.x + o.box.w + Math.max(toward.x * s0, toward.x * s1)
  const y0 = o.box.y + Math.min(toward.y * s0, toward.y * s1)
  const y1 = o.box.y + o.box.h + Math.max(toward.y * s0, toward.y * s1)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

interface Cover {
  /** Area of HARD (text-bearing) features covered. */
  hard: number
  /** Area of everything else covered (summed per obstacle — overlapping
   * obstacles count twice, which only makes a crowded spot look worse). */
  soft: number
}

const better = (a: Cover, b: Cover): boolean =>
  a.hard < b.hard - 1e-6 || (Math.abs(a.hard - b.hard) <= 1e-6 && a.soft < b.soft - 1e-6)

export function litLabelPlacement(input: LitLabelPlacementInput): LitLabelPlacement {
  const { sample, plateW, plateH, cableR, profile } = input
  const toward = input.toward ?? SOUTH
  const polar = input.polarDeg ?? 0
  // footprint in arc length: everything of the cable that can pass under
  // the plate lies within its half-diagonal (+ its offset) of its centre
  const liftAt = (t: number, offset: number): number => {
    const reach = Math.hypot(plateW, plateH) / 2 + Math.abs(offset)
    const dt = reach / Math.max(profile.total, 1)
    const SAMPLES = 12
    let maxY = cableYAt(profile, t)
    for (let i = 0; i <= SAMPLES; i++) {
      const s = Math.max(0, Math.min(1, t - dt + (2 * dt * i) / SAMPLES))
      maxY = Math.max(maxY, cableYAt(profile, s))
    }
    return maxY + cableR + LABEL_CLEARANCE
  }
  const result = (c: WireSpot, blocked: boolean): LitLabelPlacement => ({
    x: c.x,
    y: c.y,
    lift: liftAt(c.t, c.offset),
    appliedT: c.t,
    appliedOffset: c.offset,
    blocked,
  })

  if (input.dragging) {
    const nudge = maxNudge(plateH)
    const offset = Math.max(-nudge, Math.min(nudge, input.offset))
    const { pt, tan } = sample(input.t)
    return result({ t: input.t, offset, x: pt.x - tan.y * offset, y: pt.y + tan.x * offset }, false)
  }

  const side = input.offset !== 0 ? Math.sign(input.offset) : cameraSide(sample(input.t).tan, toward)
  const candidates = onWireSpots(sample, input.t, plateH, side)
  const boxOf = (c: WireSpot): Box => ({ x: c.x - plateW / 2, y: c.y - plateH / 2, w: plateW, h: plateH })

  // broad phase: only what can reach the candidates' region at any lift
  let rx0 = Infinity
  let ry0 = Infinity
  let rx1 = -Infinity
  let ry1 = -Infinity
  for (const c of candidates) {
    rx0 = Math.min(rx0, c.x - plateW / 2)
    ry0 = Math.min(ry0, c.y - plateH / 2)
    rx1 = Math.max(rx1, c.x + plateW / 2)
    ry1 = Math.max(ry1, c.y + plateH / 2)
  }
  const region: Box = { x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 }
  let cableMin = Infinity
  let cableMax = -Infinity
  for (let i = 0; i <= 32; i++) {
    const y = cableYAt(profile, i / 32)
    cableMin = Math.min(cableMin, y)
    cableMax = Math.max(cableMax, y)
  }
  const liftBound = Math.max(Math.abs(cableMin + cableR + LABEL_CLEARANCE), Math.abs(cableMax + cableR + LABEL_CLEARANCE))
  const k = Math.min(MAX_REACH, Math.tan((Math.max(0, polar) * Math.PI) / 180))
  const occluders = (input.occluders ?? []).filter((o) => {
    const s = (liftBound + Math.max(Math.abs(o.bottom), Math.abs(o.top))) * k + 1
    return overlapArea(region, { x: o.box.x - s, y: o.box.y - s, w: o.box.w + 2 * s, h: o.box.h + 2 * s }) > 0
  })
  const obstacles = (input.obstacles ?? []).filter((o) => overlapArea(region, o) > 0)
  const cover = (box: Box, lift: number): Cover => {
    let hard = 0
    let soft = 0
    for (const o of occluders) {
      const a = overlapArea(box, apparentZone(o, lift, toward, polar))
      if (a > 0) {
        if (o.hard) hard += a
        else soft += a
      }
    }
    for (const o of obstacles) soft += overlapArea(box, o)
    return { hard, soft }
  }

  // the first free spot on the wire; else the least covered (the earliest
  // on a tie) — never a spot off the wire
  let best: { c: WireSpot; cov: Cover } | null = null
  for (const c of candidates) {
    const cov = cover(boxOf(c), liftAt(c.t, c.offset))
    if (cov.hard === 0 && cov.soft === 0) return result(c, false)
    if (!best || better(cov, best.cov)) best = { c, cov }
  }
  return result(best!.c, true)
}

// ── crowded wires: abbreviate, else hide ────────────────────────────────────
//
// QUALITY PASS "labels", TASK 2 (user-approved decision, 2026-10-10). Six of
// the ten wires on the run.mjs board are short hops between adjacent cards
// ('queries' 40 world px, 'notifies' 40, 'consumes' 46, 'reads' 61,
// 'evaluates' 84) or run wholly behind a drum ('searches' behind Log store).
// The on-wire rule leaves them no free spot at the readable floor, and the
// old fallback drew them anyway, half-hidden: through the live camera at the
// wide framing 'queries' sat 10.2 px into Query API, 'searches' 15.9 px into
// it and 14.1 px into the Log store drum, 'notifies' 10.8 px into Rollup
// worker (tp4-cards-3/report.json, labelScreen.overlaps; 'searc' cut by Log
// store in tp3-final-dpr1/city-wide.png). A label that has no free on-wire
// spot is now ABBREVIATED (a prefix + an ellipsis, never fewer than
// LABEL_MIN_CHARS visible characters) or else HIDDEN at that framing; it is
// re-decided whenever the camera settles, so zoom brings it back, and the
// connection's hover / selection shows it whole (Scene3D).

/** The fewest characters an abbreviated label keeps (before its ellipsis). */
export const LABEL_MIN_CHARS = 4
export const LABEL_ELLIPSIS = '…'

/**
 * Everything a label may show, longest first: the full text, then its
 * prefixes (trailing spaces trimmed) + an ellipsis, one character shorter
 * each, down to `minChars` visible characters. A prefix that would not be
 * shorter than the full text (a label of `minChars` + 1 characters or less)
 * is not offered: the full label is then the only choice.
 */
export function labelAbbreviations(text: string, minChars = LABEL_MIN_CHARS): string[] {
  const chars = Array.from(text)
  const out = [text]
  const seen = new Set(out)
  for (let n = chars.length - 1; n >= minChars; n--) {
    const prefix = chars.slice(0, n).join('').trimEnd()
    if (Array.from(prefix).length < minChars) break
    const shown = prefix + LABEL_ELLIPSIS
    // +1 for the ellipsis: only a strictly shorter reading is an abbreviation
    if (Array.from(prefix).length + 1 >= chars.length || seen.has(shown)) continue
    seen.add(shown)
    out.push(shown)
  }
  return out
}

/** What a label shows at a framing. */
export type LabelShow =
  | { state: 'full'; text: string }
  | { state: 'abbreviated'; text: string }
  | { state: 'hidden'; text: null }

/** The longest of `labelAbbreviations(text)` that `fits`, else hidden. */
export function fitLabel(text: string, fits: (shown: string) => boolean, minChars = LABEL_MIN_CHARS): LabelShow {
  for (const shown of labelAbbreviations(text, minChars)) {
    if (fits(shown)) return shown === text ? { state: 'full', text } : { state: 'abbreviated', text: shown }
  }
  return { state: 'hidden', text: null }
}

type ScreenPt = { x: number; y: number }

/** One label on screen: its full text, how many on-wire spots it may take
 * (spot 0 = where it sits; the rest in preference order — onWireSpots), and
 * the convex hull its plate covers at spot `spot` when it shows `shown` (the
 * caller projects the plate as it would be drawn, at the scale it wears). */
export interface ScreenLabel {
  id: string
  text: string
  /** Hovered or selected: shown whole where it sits, whatever it covers (the
   * way a hidden or abbreviated label stays discoverable). */
  forced?: boolean
  spots: number
  hullFor: (shown: string, spot: number) => readonly ScreenPt[]
}

/** What a label shows, and at which of its spots (0 when hidden). */
export type ScreenLabelShow = LabelShow & { spot: number }

const boundsOf = (h: readonly ScreenPt[]) => {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of h) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  return { x0, y0, x1, y1 }
}

/**
 * What every label shows at one framing, and where on its wire: the longest
 * reading (whole first, then `labelAbbreviations`) whose plate, at the
 * EARLIEST of its spots (where it sits first, then the rest of its wire in
 * preference order), clears every obstacle hull (cards, drums, drum tags —
 * on screen) and every plate already drawn by `gap` px; else it is hidden.
 * Forced labels are decided first and shown whole where they sit; then the
 * labels whose FULL plate clears the obstacles where they sit (they keep
 * their room), then the rest — each group in input order. No unforced plate
 * it returns overlaps an obstacle or another returned plate.
 *
 * Measured (tp4-labels, first run, DPR 1): deciding only where a label sat
 * left all six crowded labels hidden at the 2x close-up too — 'queries'
 * (63-px plate) can never fit the spot it was parked on, which was the least
 * covered spot at the WIDE framing. Zoom gives room somewhere else on the
 * wire, so every spot is asked.
 *
 * `cues` (fifth arrow iteration): the silhouettes of the direction cues
 * already standing — every wire's HEAD, fixed at its target wall — are
 * obstacles like the nodes: a label slides along its wire, abbreviates or
 * hides round them, never under or through one. The cue pass and the label
 * pass had not known about each other: through the live camera a head stood
 * 22.8-36.5 px into 'reads', 13.5-23.8 px into 'searches', 25.4-33.8 px
 * into 'consumes' and 29.8 px into 'queries' (tp9-arrows5-base2
 * report.json, evalCueClash: 12 head-over-plate overlaps in 4 of 8 shots;
 * 're' left of 'reads' in tp8-final-dpr1 workbench-arrows-az90.png). The
 * chevrons come after the labels and keep clear of them in turn
 * (chevronPoses `screen`).
 */
export function resolveScreenLabels(
  labels: readonly ScreenLabel[],
  nodeObstacles: readonly (readonly ScreenPt[])[],
  gap: number,
  minChars = LABEL_MIN_CHARS,
  cues: readonly (readonly ScreenPt[])[] = [],
): Map<string, ScreenLabelShow> {
  const obstacles = cues.length > 0 ? [...nodeObstacles, ...cues] : nodeObstacles
  const obstacleBoxes = obstacles.map(boundsOf)
  const apart = (a: ReturnType<typeof boundsOf>, b: ReturnType<typeof boundsOf>) =>
    a.x0 - b.x1 >= gap || b.x0 - a.x1 >= gap || a.y0 - b.y1 >= gap || b.y0 - a.y1 >= gap
  const clearOf = (h: readonly ScreenPt[], hulls: readonly (readonly ScreenPt[])[], boxes: readonly ReturnType<typeof boundsOf>[]) => {
    const b = boundsOf(h)
    return hulls.every((o, i) => apart(b, boxes[i]) || !convexOverlap(h, o, gap))
  }
  const rank = labels.map((l, i) => ({
    l,
    i,
    group: l.forced ? 0 : clearOf(l.hullFor(l.text, 0), obstacles, obstacleBoxes) ? 1 : 2,
  }))
  rank.sort((a, b) => a.group - b.group || a.i - b.i)
  const drawn: (readonly ScreenPt[])[] = []
  const drawnBoxes: ReturnType<typeof boundsOf>[] = []
  const out = new Map<string, ScreenLabelShow>()
  for (const { l } of rank) {
    let spot = 0
    const show: LabelShow = l.forced
      ? { state: 'full', text: l.text }
      : fitLabel(
          l.text,
          (shown) => {
            for (let s = 0; s < Math.max(1, l.spots); s++) {
              const h = l.hullFor(shown, s)
              if (clearOf(h, obstacles, obstacleBoxes) && clearOf(h, drawn, drawnBoxes)) {
                spot = s
                return true
              }
            }
            return false
          },
          minChars,
        )
    if (show.text === null) spot = 0
    out.set(l.id, { ...show, spot })
    if (show.text !== null) {
      const h = l.hullFor(show.text, spot)
      drawn.push(h)
      drawnBoxes.push(boundsOf(h))
    }
  }
  return out
}
