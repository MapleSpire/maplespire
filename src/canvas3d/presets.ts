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
 * 3D board camera presets — the design system's exact values (originally
 * expressed as CSS 3D transforms in the editor-3d design kit, referred to
 * below as "the kit" / editor3d.css; that kit is not part of this repo).
 *
 * PURE CONSTANTS — this module must stay free of `three` imports so eager code
 * (useAutoLayout, UI chrome) can read preset facts without pulling the lazy
 * WebGL chunk. Everything that imports `three` lives behind `./index.ts`'s
 * dynamic import.
 *
 * Interpretation:
 * - `rx` — the CSS `rotateX` board tilt in degrees. Camera equivalent: polar
 *   angle from zenith = rx (elevation above the board = 90° − rx).
 * - `rz` — the CSS `rotateZ` board yaw in degrees (camera azimuth magnitude;
 *   sign pinned visually against the kit).
 * - `scale` — the kit's stage zoom riding the enter tween.
 * - `depth` — node slab extrusion (world px); `plat` — standard-group platform
 *   lift; `floorD` — floor slab thickness.
 * - `persp` — the CSS `perspective` length in px; fovY = 2·atan(h/(2·persp))
 *   frozen at the reference height below.
 *
 * There is deliberately no `deep` preset (62°/45°): free orbit reaches those
 * angles.
 */

export interface CameraPreset {
  rx: number
  rz: number
  scale: number
  depth: number
  plat: number
  floorD: number
  persp: number
}

export type CameraPresetId = 'tilt' | 'iso'

export const CAMERA_PRESETS: Record<CameraPresetId, CameraPreset> = {
  tilt: { rx: 32, rz: 0, scale: 1.04, depth: 10, plat: 4, floorD: 10, persp: 2200 },
  iso: { rx: 55, rz: 40, scale: 1.13, depth: 18, plat: 6, floorD: 14, persp: 1700 },
}

export const DEFAULT_PRESET: CameraPresetId = 'iso'

/** Reference CSS height (px) at which per-preset fov is frozen so window
 * resizes don't re-compose the shot. */
export const FOV_REFERENCE_HEIGHT = 900

/** The design's 2D↔3D morph timing (editor3d.css `--ed3-dur` / `--ed3-ease`). */
export const CAMERA_TWEEN_MS = 850
/** cubic-bezier(.3,.72,.15,1) — sampled by the tween helper in camera.ts. */
export const CAMERA_TWEEN_BEZIER: readonly [number, number, number, number] = [0.3, 0.72, 0.15, 1]

/** Free-orbit clamps: never under the board, never fully top-down (that's 2D). */
export const POLAR_MIN_DEG = 12
export const POLAR_MAX_DEG = 78

/** Selection pop above the slab top (editor3d.css `+ 14px`). */
export const SELECTED_LIFT = 14
/** Connections ride just above the platforms (editor3d.css `+ 2px`). */
export const CONNECTION_LIFT = 2
