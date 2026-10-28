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
 * Keyframes of the Model Viewer's drill-down zoom (two layers sharing one focal
 * point: the opened tile's centre, in the viewport's coordinates).
 *
 * THE INVARIANT: within each layer, both keyframes spell their transform with
 * the SAME functions in the SAME order. The browser interpolates two transform
 * lists function by function; when the lists differ it pairs each leftover
 * function against an identity instead. A "scale about the focal point" written
 * as `translate(f) scale(s) translate(-f)` then has its two translates and its
 * scale interpolated independently, and the zoom's PIVOT slides across the
 * screen — measured: from the viewport's top-left corner to the tile over the
 * first half of the zoom, so the whole diagram drifted diagonally toward the
 * bottom right before it settled on the tile. With matching lists the pivot is
 * constant and the zoom is a pure scale about the tile, as in the design kit
 * (`mv-grid.jsx`: one `transform-origin` at the focal point, `scale` only).
 *
 * The user's own pan/zoom (`user`) is composed in front so a drill started while
 * zoomed animates from what is on screen and lands at identity.
 */

export interface ZoomPoint {
  x: number
  y: number
}

export interface ZoomUser {
  k: number
  tx: number
  ty: number
}

// A type alias, not an interface: only an alias is assignable to the DOM's
// `Keyframe` (which has a string index signature).
export type ZoomKeyframe = { transform: string; opacity: number }

export interface ZoomKeyframes {
  /** The level being left. */
  out: ZoomKeyframe[]
  /** The level being entered. */
  in: ZoomKeyframe[]
}

const px = (n: number) => `${n}px`
const translate = (x: number, y: number) => `translate(${px(x)}, ${px(y)})`
/** Scale by `s` about the point `f`, as exactly three functions. */
const about = (f: ZoomPoint, s: number) => `${translate(f.x, f.y)} scale(${s}) ${translate(-f.x, -f.y)}`

export function zoomKeyframes(
  dir: 'in' | 'out',
  focal: ZoomPoint,
  user: ZoomUser,
  zoomK: number,
): ZoomKeyframes {
  const userM = `${translate(user.tx, user.ty)} scale(${user.k})`
  const identityM = `${translate(0, 0)} scale(1)`
  if (dir === 'in') {
    // The opened tile's on-screen position (user transform applied): the new
    // level blooms out of it.
    const tile: ZoomPoint = { x: user.k * focal.x + user.tx, y: user.k * focal.y + user.ty }
    return {
      out: [
        // dive: the current level scales up INTO the opened tile, on top of
        // whatever pan/zoom the user had
        { transform: `${userM} ${about(focal, 1)}`, opacity: 1 },
        { transform: `${userM} ${about(focal, zoomK)}`, opacity: 0 },
      ],
      in: [
        { transform: `${translate(tile.x, tile.y)} scale(${1 / zoomK}) ${translate(-focal.x, -focal.y)}`, opacity: 0 },
        { transform: `${translate(focal.x, focal.y)} scale(1) ${translate(-focal.x, -focal.y)}`, opacity: 1 },
      ],
    }
  }
  return {
    out: [
      // ascend: the current level shrinks into its tile in the PARENT layout —
      // the end state drops the user transform so it converges where the
      // incoming (identity) layer draws that tile
      { transform: `${userM} ${about(focal, 1)}`, opacity: 1 },
      { transform: `${identityM} ${about(focal, 1 / zoomK)}`, opacity: 0 },
    ],
    in: [
      { transform: about(focal, zoomK), opacity: 0 },
      { transform: about(focal, 1), opacity: 1 },
    ],
  }
}
