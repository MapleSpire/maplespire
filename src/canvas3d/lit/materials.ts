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

import * as THREE from 'three'
import { colorAlpha } from '../palette'
import type { Lighting3D } from '../specs'

/**
 * The LIT material family (PBR migration): maps a `surface()` role to a
 * physical recipe under the active theme's sanitized `Lighting3D` block.
 *
 * Ground rules mirrored from the unlit family:
 * - one material INSTANCE per call — several call sites mutate
 *   opacity/transparent after construction (spec opacity, focus dim, accent
 *   alpha), so instances must never be shared;
 * - color/alpha split via `colorAlpha` exactly like `unlit()` — but the color
 *   goes through three's NORMAL working-space conversion (lit themes are
 *   tone-mapped; exact-hex fidelity is deliberately an unlit-only contract);
 * - blend state (`transparent`/`depthWrite`) is FINAL at construction — the
 *   morph fade captures it at registration (`regFloorFade`).
 *
 * Roles that must stay UNLIT even in the lit profile (focus/UI overlays and
 * emissive accents that tone mapping would dull): 'glow', 'selectionRing',
 * 'handle' — they return a MeshBasicMaterial with `toneMapped: false` so the
 * ACES pass leaves their colors alone. 'connInk' (the connection lines,
 * inkLine.ts) too: their contrast was computed on the exact hex values, so
 * neither the lamp nor ACES may move them.
 */

/** Matte-ceramic surfaces: card slabs + walls, drums, floor walls, pads,
 * platforms — the maquette's porcelain read. */
const CERAMIC_ROLES = new Set(['cardCap', 'cardFill', 'cardWall', 'floorWall', 'drum', 'drumLid', 'pad', 'platform'])
/** Flat decals seated into the lit scene: pills, plates, rings, bars. */
const CHROME_ROLES = new Set([
  'chrome',
  'tagPlate',
  'connLabel',
  'floorRing',
  'platformRing',
  'padRing',
  'accentBar',
  'drumBand',
])
/** Focus/UI overlays that stay unlit + un-tone-mapped in the lit profile. */
const UNLIT_ROLES = new Set(['glow', 'selectionRing', 'handle', 'connInk'])

export interface LitSurfaceOpts {
  side?: THREE.Side
  depthWrite?: boolean
}

/** Build the lit material for a role (one fresh instance per call). */
export function litSurface(
  role: string,
  css: string,
  opts: LitSurfaceOpts,
  lighting: Lighting3D,
): THREE.Material {
  const { color, alpha } = colorAlpha(css)
  const blend = {
    transparent: alpha < 1,
    opacity: alpha,
    side: opts.side ?? THREE.FrontSide,
    depthWrite: opts.depthWrite ?? alpha >= 1,
  }

  if (UNLIT_ROLES.has(role)) {
    return new THREE.MeshBasicMaterial({ color, ...blend, toneMapped: false })
  }

  if (CERAMIC_ROLES.has(role)) {
    const m = lighting.material ?? {}
    return new THREE.MeshPhysicalMaterial({
      color,
      ...blend,
      roughness: m.roughness ?? 0.62,
      metalness: m.metalness ?? 0,
      clearcoat: m.clearcoat ?? 0.22,
      clearcoatRoughness: 0.55,
      specularIntensity: 0.5,
      envMapIntensity: 0.45,
    })
  }

  // CHROME_ROLES + any future role: matte standard decal. Decals never WRITE
  // depth — they float millimetres above their backing surface, and the
  // half-res AO pass would otherwise read them as geometry and draw offset
  // ghost halos around pills/labels/plates (same failure as text, see text.ts).
  void CHROME_ROLES
  return new THREE.MeshStandardMaterial({
    color,
    ...blend,
    depthWrite: false,
    roughness: 0.9,
    metalness: 0,
  })
}
