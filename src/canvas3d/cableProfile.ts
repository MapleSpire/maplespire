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
 * Vertical profile of a connection under its label (pure math — no three).
 *
 * The lit board draws its connections as flat ink lines since 2026-10-12
 * (inkLine.ts): Scene3D now hands connLabelPlacement a LEVEL profile
 * (`cableProfileFor(0, 0, 0, total)`). The shaped profile below is what the
 * retired cable tubes followed; connLabelPlacement still reads any profile
 * (its tests exercise the shaped one), so the math stays with it.
 *
 * The reference maquette's cables PLUG into the slab walls and LIE on
 * whatever the shapes stand on: they leave the wall horizontally at plug
 * height, ease down onto a resting run just above the support (board or
 * group platform — NOT the world floor), hold, and rise into the far plug.
 * Heights here are layer-local (the conn layer rides at plat+CONNECTION_LIFT),
 * so values are routinely negative.
 */
export interface CableProfile {
  /** Plug height at t=0 (source wall), layer-local. */
  yFrom: number
  /** Plug height at t=1 (target wall), layer-local. */
  yTo: number
  /** Resting height of the mid-run, layer-local. */
  yRest: number
  /** Arc length of the routed span (world px). */
  total: number
}

function smootherstep01(x: number): number {
  const t = Math.max(0, Math.min(1, x))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * Build the profile. `yRest` is the physical floor of the run (support top +
 * cable radius + clearance); SHORT spans never dive that deep — a patch cable
 * between adjacent slabs droops gently instead of V-diving to the desk — so
 * the rest height is clamped to at most `total * 0.12` below the lower plug.
 */
export function cableProfileFor(yFrom: number, yTo: number, yRest: number, total: number): CableProfile {
  const rest = Math.min(Math.min(yFrom, yTo), Math.max(yRest, Math.min(yFrom, yTo) - total * 0.12))
  return { yFrom, yTo, yRest: rest, total }
}

/** Shoulder fraction: the descent from plug to rest spans ~55 px of arc,
 * capped so the two shoulders never overlap. */
function shoulderFraction(total: number): number {
  return Math.min(0.42, 55 / Math.max(total, 1))
}

/** Cable height at normalized arc position t ∈ [0, 1] (layer-local). */
export function cableYAt(p: CableProfile, t: number): number {
  const s = shoulderFraction(p.total)
  if (t < s) return p.yFrom + (p.yRest - p.yFrom) * smootherstep01(t / s)
  if (t > 1 - s) return p.yTo + (p.yRest - p.yTo) * smootherstep01((1 - t) / s)
  return p.yRest
}
