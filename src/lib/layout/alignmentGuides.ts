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

export interface GuideRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export type GuideAxis = 'x' | 'y'

export type SmartGuide =
  | {
    kind: 'alignment'
    axis: GuideAxis
    value: number
    from: number
    to: number
  }
  | {
    kind: 'spacing'
    axis: GuideAxis
    start: number
    end: number
    cross: number
    distance: number
  }

export interface SmartGuideResult {
  dx: number
  dy: number
  snappedX: boolean
  snappedY: boolean
  guides: SmartGuide[]
}

type Anchor = 'start' | 'center' | 'end'

interface AxisRect {
  id: string
  start: number
  end: number
  center: number
  crossStart: number
  crossEnd: number
  crossCenter: number
}

interface AxisCandidate {
  delta: number
  priority: number
  guides: SmartGuide[]
}

const EPSILON = 0.001

function axisRect(rect: GuideRect, axis: GuideAxis): AxisRect {
  if (axis === 'x') {
    return {
      id: rect.id,
      start: rect.x,
      end: rect.x + rect.width,
      center: rect.x + rect.width / 2,
      crossStart: rect.y,
      crossEnd: rect.y + rect.height,
      crossCenter: rect.y + rect.height / 2,
    }
  }
  return {
    id: rect.id,
    start: rect.y,
    end: rect.y + rect.height,
    center: rect.y + rect.height / 2,
    crossStart: rect.x,
    crossEnd: rect.x + rect.width,
    crossCenter: rect.x + rect.width / 2,
  }
}

function anchorValue(rect: AxisRect, anchor: Anchor): number {
  return anchor === 'start' ? rect.start : anchor === 'center' ? rect.center : rect.end
}

function overlapsCross(a: AxisRect, b: AxisRect): boolean {
  return Math.min(a.crossEnd, b.crossEnd) - Math.max(a.crossStart, b.crossStart) > EPSILON
}

function alignmentCandidate(
  moving: AxisRect,
  stationary: AxisRect[],
  axis: GuideAxis,
  tolerance: number,
): AxisCandidate | null {
  let best: { delta: number; anchor: Anchor } | null = null
  const anchors: Anchor[] = ['start', 'center', 'end']
  for (const target of stationary) {
    for (const anchor of anchors) {
      const delta = anchorValue(target, anchor) - anchorValue(moving, anchor)
      if (Math.abs(delta) > tolerance) continue
      if (!best || Math.abs(delta) < Math.abs(best.delta) - EPSILON) best = { delta, anchor }
      else if (best && Math.abs(Math.abs(delta) - Math.abs(best.delta)) <= EPSILON && anchor === 'center') {
        best = { delta, anchor }
      }
    }
  }
  if (!best) return null

  const corrected = {
    ...moving,
    start: moving.start + best.delta,
    end: moving.end + best.delta,
    center: moving.center + best.delta,
  }
  const value = anchorValue(corrected, best.anchor)
  const matches = stationary.filter((target) => Math.abs(anchorValue(target, best!.anchor) - value) <= EPSILON)
  const from = Math.min(corrected.crossStart, ...matches.map((target) => target.crossStart))
  const to = Math.max(corrected.crossEnd, ...matches.map((target) => target.crossEnd))
  return {
    delta: best.delta,
    priority: 0,
    guides: [{ kind: 'alignment', axis, value, from, to }],
  }
}

function spacingSegment(
  axis: GuideAxis,
  start: number,
  end: number,
  cross: number,
): SmartGuide {
  return { kind: 'spacing', axis, start, end, cross, distance: Math.max(0, end - start) }
}

/** Equal gaps when the moving rect sits between its nearest neighbours. */
function betweenSpacingCandidate(
  moving: AxisRect,
  stationary: AxisRect[],
  axis: GuideAxis,
  tolerance: number,
): AxisCandidate | null {
  const aligned = stationary.filter((target) => overlapsCross(moving, target))
  const left = aligned
    .filter((target) => target.end <= moving.start + tolerance)
    .sort((a, b) => b.end - a.end)[0]
  const right = aligned
    .filter((target) => target.start >= moving.end - tolerance)
    .sort((a, b) => a.start - b.start)[0]
  if (!left || !right) return null

  const leftGap = moving.start - left.end
  const rightGap = right.start - moving.end
  const delta = (rightGap - leftGap) / 2
  const equalGap = leftGap + delta
  if (equalGap < 0 || Math.abs(delta) > tolerance) return null
  const cross = moving.crossCenter
  return {
    delta,
    priority: 1,
    guides: [
      spacingSegment(axis, left.end, moving.start + delta, cross),
      spacingSegment(axis, moving.end + delta, right.start, cross),
    ],
  }
}

/** Match the gap of the two preceding or following shapes in a row/column. */
function repeatedSpacingCandidate(
  moving: AxisRect,
  stationary: AxisRect[],
  axis: GuideAxis,
  tolerance: number,
): AxisCandidate | null {
  const aligned = stationary.filter((target) => overlapsCross(moving, target))
  const options: AxisCandidate[] = []

  for (const near of aligned) {
    if (near.end <= moving.start + tolerance) {
      const previous = aligned
        .filter((target) => target.id !== near.id && target.end <= near.start + EPSILON && overlapsCross(near, target))
        .sort((a, b) => b.end - a.end)[0]
      if (previous) {
        const existingGap = near.start - previous.end
        const proposedGap = moving.start - near.end
        const delta = existingGap - proposedGap
        if (existingGap >= 0 && Math.abs(delta) <= tolerance) {
          const cross = moving.crossCenter
          options.push({
            delta,
            priority: 2,
            guides: [
              spacingSegment(axis, previous.end, near.start, cross),
              spacingSegment(axis, near.end, moving.start + delta, cross),
            ],
          })
        }
      }
    }

    if (near.start >= moving.end - tolerance) {
      const following = aligned
        .filter((target) => target.id !== near.id && target.start >= near.end - EPSILON && overlapsCross(near, target))
        .sort((a, b) => a.start - b.start)[0]
      if (following) {
        const existingGap = following.start - near.end
        const proposedGap = near.start - moving.end
        const delta = proposedGap - existingGap
        if (existingGap >= 0 && Math.abs(delta) <= tolerance) {
          const cross = moving.crossCenter
          options.push({
            delta,
            priority: 2,
            guides: [
              spacingSegment(axis, moving.end + delta, near.start, cross),
              spacingSegment(axis, near.end, following.start, cross),
            ],
          })
        }
      }
    }
  }

  return options.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0] ?? null
}

function bestAxisCandidate(
  moving: GuideRect,
  stationary: GuideRect[],
  axis: GuideAxis,
  tolerance: number,
): AxisCandidate | null {
  const movingAxis = axisRect(moving, axis)
  const stationaryAxis = stationary.map((rect) => axisRect(rect, axis))
  const options = [
    alignmentCandidate(movingAxis, stationaryAxis, axis, tolerance),
    betweenSpacingCandidate(movingAxis, stationaryAxis, axis, tolerance),
    repeatedSpacingCandidate(movingAxis, stationaryAxis, axis, tolerance),
  ].filter((candidate): candidate is AxisCandidate => candidate !== null)
  return options.sort((a, b) => {
    const delta = Math.abs(a.delta) - Math.abs(b.delta)
    return Math.abs(delta) > EPSILON ? delta : a.priority - b.priority
  })[0] ?? null
}

export function calculateSmartGuides(
  moving: GuideRect,
  stationary: GuideRect[],
  tolerance: number,
): SmartGuideResult {
  const safeTolerance = Math.max(0, tolerance)
  const x = bestAxisCandidate(moving, stationary, 'x', safeTolerance)
  const y = bestAxisCandidate(moving, stationary, 'y', safeTolerance)
  return {
    dx: x?.delta ?? 0,
    dy: y?.delta ?? 0,
    snappedX: x !== null,
    snappedY: y !== null,
    guides: [...(x?.guides ?? []), ...(y?.guides ?? [])],
  }
}

export function unionGuideRects(rects: GuideRect[], id = 'selection'): GuideRect | null {
  if (rects.length === 0) return null
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { id, x: left, y: top, width: right - left, height: bottom - top }
}
