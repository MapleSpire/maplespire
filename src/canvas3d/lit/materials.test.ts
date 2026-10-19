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
import * as THREE from 'three'
import { litSurface } from './materials'
import type { Lighting3D } from '../specs'

const L: Lighting3D = { preset: 'studio' }

describe('litSurface (lit material family contracts)', () => {
  // USER BUG: depth-written floating quads become offset ghost halos under
  // the half-res AO pass (ghosted text/labels, worst when zoomed out).
  it('DECALS never write depth (AO ghost regression)', () => {
    for (const role of ['chrome', 'tagPlate', 'connLabel', 'floorRing', 'platformRing', 'padRing', 'accentBar', 'drumBand']) {
      const m = litSurface(role, '#F1EFEB', {}, L)
      expect(m.depthWrite, `${role} must not write depth`).toBe(false)
    }
  })

  it('REAL geometry keeps writing depth (bodies occlude, AO shades them)', () => {
    for (const role of ['cardCap', 'cardFill', 'cardWall', 'floorWall', 'drum', 'drumLid', 'pad', 'platform']) {
      const m = litSurface(role, '#FFFFFF', {}, L)
      expect(m.depthWrite, `${role} writes depth`).toBe(true)
    }
  })

  it('focus/UI overlays and the connection ink stay unlit and un-tone-mapped (hex-stable under ACES)', () => {
    for (const role of ['glow', 'selectionRing', 'handle', 'connInk']) {
      const m = litSurface(role, '#00F0FF', {}, L)
      expect(m).toBeInstanceOf(THREE.MeshBasicMaterial)
      expect(m.toneMapped).toBe(false)
    }
  })

  it('ceramic family responds to the sanitized material block', () => {
    const m = litSurface('cardCap', '#FFFFFF', {}, { preset: 'studio', material: { roughness: 0.4, clearcoat: 0.5 } }) as THREE.MeshPhysicalMaterial
    expect(m).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    expect(m.roughness).toBeCloseTo(0.4)
    expect(m.clearcoat).toBeCloseTo(0.5)
  })
})
