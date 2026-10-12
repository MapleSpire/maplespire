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
import {
  sanitizeEnvironment3d,
  sanitizeFloorSpec3d,
  sanitizeLighting3d,
  sanitizeNodeSpec3d,
} from './specs'
import { themeFor3d } from '../plugins/theme3d'
import { cyberpunkSkin } from '../skins/cyberpunkSkin'
import { cyberpunkSkinLight } from '../skins/cyberpunkSkinLight'
import { eightBitSkin } from '../skins/eightBitSkin'
import { eightBitSkinDark } from '../skins/eightBitSkinDark'
import { defaultSkin } from '../skins/defaultSkin'
import { drumFaceColor, nodeWallColors, resolve3dPalette } from './palette'

describe('sanitizeLighting3d (PBR migration — the lit-profile gate)', () => {
  it('drops the whole block on an unknown or missing preset (theme stays unlit)', () => {
    expect(sanitizeLighting3d({ preset: 'noir' })).toBeNull()
    expect(sanitizeLighting3d({ exposure: 1.2 })).toBeNull()
    expect(sanitizeLighting3d('studio')).toBeNull()
    expect(sanitizeLighting3d(null)).toBeNull()
  })

  it('keeps a bare studio preset (engine defaults fill the rest)', () => {
    expect(sanitizeLighting3d({ preset: 'studio' })).toEqual({ preset: 'studio' })
  })

  it('clamps every number, gates every color, drops unknown keys', () => {
    const out = sanitizeLighting3d({
      preset: 'studio',
      exposure: 99,
      toneMapping: 'aces',
      sun: { color: '#FFDDB0', intensity: -3, azimuthDeg: 900, elevationDeg: 1 },
      ambient: { skyColor: 'url(javascript:alert(1))', groundColor: '#C9B8A3', intensity: 5 },
      ibl: { intensity: 9 },
      shadows: { enabled: true, opacity: 2, mapSize: 4096 },
      material: { roughness: 0, metalness: 3, clearcoat: -1 },
      bloom: { strength: 7, threshold: -2 },
      hax: 'nope',
    })!
    expect(out.exposure).toBe(2)
    expect(out.toneMapping).toBe('aces')
    expect(out.sun).toEqual({ color: '#FFDDB0', intensity: 0, azimuthDeg: 180, elevationDeg: 15 })
    expect(out.ambient).toEqual({ groundColor: '#C9B8A3', intensity: 2 }) // injected skyColor dropped
    expect(out.ibl).toEqual({ intensity: 1.5 })
    expect(out.shadows).toEqual({ enabled: true, opacity: 1 }) // 4096 is not in the mapSize enum
    expect(out.material).toEqual({ roughness: 0.05, metalness: 0.5, clearcoat: 0 })
    expect(out.bloom).toEqual({ strength: 1.5, threshold: 0 })
    expect('hax' in out).toBe(false)
  })

  it('rides the declarative environment surface', () => {
    const env = sanitizeEnvironment3d({ lighting: { preset: 'studio', exposure: 1.12 } })!
    expect(env.lighting).toEqual({ preset: 'studio', exposure: 1.12 })
    // an invalid lighting block does not conjure an environment into existence
    expect(sanitizeEnvironment3d({ lighting: { preset: 'nope' } })).toBeNull()
  })
})

describe('3D theme spec sanitizers (plan §8 — community-safe by construction)', () => {
  it('environment: keeps valid colors/gradients, clamps fog, drops garbage', () => {
    const env = sanitizeEnvironment3d({
      background: { top: '#14141F', bottom: '#040407' },
      fog: { color: '#0B0B0F', density: 99 }, // hostile density
      shading: { wallMix: 100, drumContrast: -5 },
      hax: 'url(javascript:alert(1))',
    })!
    expect(env.background).toEqual({ top: '#14141F', bottom: '#040407' })
    expect(env.fog!.density).toBeLessThanOrEqual(0.0025) // clamped, not trusted
    expect(env.shading).toEqual({ wallMix: 1.8, drumContrast: 0 })
    expect('hax' in env).toBe(false)
    // unsafe background color → dropped entirely
    expect(sanitizeEnvironment3d({ background: 'url(evil)' })).toBeNull()
    expect(sanitizeEnvironment3d(undefined)).toBeNull()
  })

  it('node spec: clamps dims/motion, gates colors, drops unknown keys', () => {
    const spec = sanitizeNodeSpec3d({
      materials: { top: '#FCEE0A', opacity: 0.01, evil: 'expression(x)' },
      depthScale: 50,
      cornerRadius: -3,
      edgeGlow: { color: '#00F0FF', width: 100 },
      spin: { speed: 100000 },
      bob: { amp: 99, speed: 99 },
      geometry: 'gltf', // not in this slice — must be dropped, not crash
    })!
    expect(spec.materials).toEqual({ top: '#FCEE0A', opacity: 0.35 })
    expect(spec.depthScale).toBe(3)
    expect(spec.cornerRadius).toBe(0)
    expect(spec.edgeGlow).toEqual({ color: '#00F0FF', width: 4 })
    expect(spec.spin).toEqual({ speed: 90 })
    expect(spec.bob).toEqual({ amp: 6, speed: 2 })
    expect('geometry' in spec).toBe(false)
    // edge glow with an unsafe color vanishes
    expect(sanitizeNodeSpec3d({ eGlow: 1 })).toBeNull()
    expect(sanitizeNodeSpec3d({ edgeGlow: { color: 'javascript:x' } })).toBeNull()
  })

  it('floor spec: enum-gated modes, clamped pads', () => {
    const fs = sanitizeFloorSpec3d({
      mode: 'none',
      grid: 'diagonal', // unknown enum → dropped
      gridColor: '#2A4A55',
      pad: { x: 1, y: 9999 },
      shadow: false,
    })!
    expect(fs.mode).toBe('none')
    expect('grid' in fs).toBe(false)
    expect(fs.gridColor).toBe('#2A4A55')
    expect(fs.pad).toEqual({ x: 24, y: 200 })
    expect(fs.shadow).toBe(false)
  })

  it('floor scatter: gated colors, clamped density — hostile values never reach the GPU', () => {
    const fs = sanitizeFloorSpec3d({
      scatter: {
        colors: ['#44C52C', 'url(evil)', '#0058F8', 'javascript:x'],
        pattern: 'grid-fracture',
        count: 100000,
        size: -3,
        spread: 9999,
        rise: 9999,
        interactive: true,
      },
    })!
    expect(fs.scatter!.colors).toEqual(['#44C52C', '#0058F8']) // unsafe dropped
    expect(fs.scatter!.pattern).toBe('grid-fracture')
    expect(fs.scatter!.count).toBe(120)
    expect(fs.scatter!.size).toBe(3)
    expect(fs.scatter!.spread).toBe(220)
    expect(fs.scatter!.rise).toBe(100)
    expect(fs.scatter!.interactive).toBe(true)
    // no valid color → the whole scatter drops
    expect(sanitizeFloorSpec3d({ scatter: { colors: ['expression(x)'] } })).toBeNull()
    // color list capped at 6
    const many = sanitizeFloorSpec3d({ scatter: { colors: Array.from({ length: 9 }, () => '#FFFFFF') } })!
    expect(many.scatter!.colors).toHaveLength(6)
    const unknownPattern = sanitizeFloorSpec3d({ scatter: { colors: ['#FFFFFF'], pattern: 'triangles' } })!
    expect(unknownPattern.scatter!.pattern).toBeUndefined()
  })
})

describe('themeFor3d (official plugin → sanitized Theme3dSource)', () => {
  it('default skin has no 3D surface (pure derived palette)', () => {
    expect(themeFor3d(defaultSkin)).toBeNull()
  })

  it('cyberpunk: environment + edge-glow cards + spinning drums', () => {
    const t = themeFor3d(cyberpunkSkin)!
    expect(t.environment?.background).toEqual({ top: '#14141F', bottom: '#040407' })
    expect(t.environment?.shading?.wallMix).toBeCloseTo(1.25, 6)
    const card = t.objectSpec({
      id: 'a', type: 'app', name: 'API', fill: '#101014',
      selected: false, external: false, zBase: 0, zTop: 8,
    })!
    expect(card.edgeGlow).toEqual({ color: '#00F0FF', width: 1.6 })
    expect(card.spin).toBeUndefined()
    const store = t.objectSpec({
      id: 'db', type: 'store', name: 'DB', fill: '#101014',
      selected: true, external: false, zBase: 0, zTop: 64,
    })!
    expect(store.edgeGlow!.color).toBe('#FCEE0A') // selected = yellow rim
    expect(store.spin).toEqual({ speed: 10 })
    expect(t.floorSpec({ bounds: { x: 0, y: 0, w: 100, h: 100 }, dark: true })?.gridColor).toBe('#2A4A55')
  })

  it('cyberpunk LIGHT variant: own environment + techwear accents (per-appearance pack)', () => {
    const t = themeFor3d(cyberpunkSkinLight)!
    expect(t.environment?.background).toEqual({ top: '#F4FAFC', bottom: '#D3E7EC' })
    const card = t.objectSpec({
      id: 'a', type: 'app', name: 'API', fill: '#FFFFFF',
      selected: false, external: false, zBase: 0, zTop: 8,
    })!
    expect(card.edgeGlow!.color).toBe('#16C0E0') // cyan idle rim, not the night neon
    const sel = t.objectSpec({
      id: 'a', type: 'app', name: 'API', fill: '#FFFFFF',
      selected: true, external: false, zBase: 0, zTop: 8,
    })!
    expect(sel.edgeGlow!.color).toBe('#FF1B6D') // magenta action accent
  })

  it('eightbit: pixel-snap flows through as the free-inheritance capability', () => {
    const t = themeFor3d(eightBitSkin)!
    expect(t.pixelSnap).toBeGreaterThan(0)
  })

  it('eightbit: voxel cards — sharp corners, chunky depth, posterized block walls', () => {
    const t = themeFor3d(eightBitSkin)!
    const card = t.objectSpec({
      id: 'a', type: 'app', name: 'x', fill: '#FFFFFF',
      selected: false, external: false, zBase: 0, zTop: 8,
    })!
    expect(card.cornerRadius).toBe(0)
    expect(card.depthScale).toBe(2)
    // walls are posterized (32-step channels) darker takes on the fill
    const channels = (css: string) => css.match(/\d+/g)!.map(Number)
    for (const wall of [card.materials!.wallFront!, card.materials!.wallSide!]) {
      const rgb = channels(wall)
      expect(rgb.every((v) => v % 32 === 0)).toBe(true)
      expect(rgb.every((v) => v < 255)).toBe(true) // darker than the white fill
    }
    // side face darker than front (block shading law)
    expect(channels(card.materials!.wallSide!)[0]).toBeLessThan(channels(card.materials!.wallFront!)[0])
    // selection tints the walls toward the NES red (red channel dominates more)
    const sel = t.objectSpec({
      id: 'a', type: 'app', name: 'x', fill: '#FFFFFF',
      selected: true, external: false, zBase: 0, zTop: 8,
    })!
    const [r, g] = channels(sel.materials!.wallFront!)
    expect(r).toBeGreaterThan(g)
  })

  it('eightbit: pixel skies + floor tiles land as gated assets per appearance', () => {
    const light = themeFor3d(eightBitSkin)!
    expect(light.environment?.background).toEqual({ asset: 'sky-day' })
    expect(light.environment?.floorTexture).toBe('floor-day')
    // the manifest passes the caps gate (embedded data URIs, tiny PNGs)
    expect(light.assets).toBeTruthy()
    for (const id of ['sky-day', 'sky-night', 'floor-day', 'floor-night']) {
      expect(light.assets![id]?.kind).toBe('texture')
      expect(light.assets![id]?.dataUri.startsWith('data:image/png;base64,')).toBe(true)
    }
    const dark = themeFor3d(eightBitSkinDark)!
    expect(dark.environment?.background).toEqual({ asset: 'sky-night' })
    expect(dark.environment?.floorTexture).toBe('floor-night')
    // sharp-cornered board slab + a flat, theme-adapted grid fracture
    const floor = light.floorSpec({ bounds: { x: 0, y: 0, w: 100, h: 100 }, dark: false })!
    expect(floor.cornerRadius).toBe(0)
    expect(floor.edge).toBe('flat')
    expect(floor.scatter!.colors).toContain('#A8B4BA')
    expect(floor.scatter!.pattern).toBe('grid-fracture')
    expect(floor.scatter!.count).toBe(120)
    expect(floor.scatter!.interactive).toBe(true)
  })
})

describe('custom-body + asset spec sanitizers (plan §8.4)', () => {
  it('geometry travels only with a valid asset id, scale clamped', () => {
    expect(sanitizeNodeSpec3d({ geometry: 'gltf', asset: 'pin', scale: 99 })).toEqual({
      geometry: 'gltf',
      asset: 'pin',
      scale: 3,
    })
    expect(sanitizeNodeSpec3d({ geometry: 'billboard', asset: 'beacon' })).toEqual({
      geometry: 'billboard',
      asset: 'beacon',
    })
    // no asset / bad asset id / unknown geometry -> the whole body request drops
    expect(sanitizeNodeSpec3d({ geometry: 'gltf' })).toBeNull()
    expect(sanitizeNodeSpec3d({ geometry: 'gltf', asset: '../escape' })).toBeNull()
    expect(sanitizeNodeSpec3d({ geometry: 'mesh', asset: 'pin' })).toBeNull()
  })

  it('environment floorTexture + equirect background pass by asset id only', () => {
    expect(sanitizeEnvironment3d({ floorTexture: 'paper' })).toEqual({ floorTexture: 'paper' })
    expect(sanitizeEnvironment3d({ floorTexture: 'no spaces!' })).toBeNull()
    expect(sanitizeEnvironment3d({ background: { asset: 'sky' } })).toEqual({ background: { asset: 'sky' } })
    expect(sanitizeEnvironment3d({ background: { asset: 'https://x' } })).toBeNull()
  })
})

describe('environment shading modifiers (palette level)', () => {
  const palette = resolve3dPalette(defaultSkin)

  it('wallMix scales the wall color-mix strength', () => {
    const kit = nodeWallColors(palette, '#FFFFFF', false)
    const strong = nodeWallColors(palette, '#FFFFFF', false, 1.8)
    const weak = nodeWallColors(palette, '#FFFFFF', false, 0.25)
    expect(strong.front).not.toBe(kit.front)
    expect(weak.front).not.toBe(kit.front)
    expect(nodeWallColors(palette, '#FFFFFF', false, 1)).toEqual(kit) // 1 = kit look
  })

  it('drumContrast 0 flattens the cos-law to a uniform drum', () => {
    expect(drumFaceColor(palette, 120, 0)).toBe(drumFaceColor(palette, 300, 0))
    // kit law unchanged at contrast 1
    expect(drumFaceColor(palette, 120, 1)).toBe(drumFaceColor(palette, 120))
  })
})
