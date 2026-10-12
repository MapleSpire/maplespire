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

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { PAPER_PITCH, PAPER_TILE_CELLS } from './paper'
import {
  TRAY_VARIANTS,
  clayTrayTextures,
  disposeBoardTextures,
  museumTrayTextures,
  trayTexturesFor,
  woodTrayTextures,
  type TraySpec,
  type TrayVariant,
} from './boards'

// jsdom has no rasterizer (the optional `canvas` npm package is not
// installed), so pixel sampling is impossible here — the house pattern
// (CanvasEngine.gesture.test.ts) mocks getContext instead. We mock it with a
// RECORDING stub: every method call and style assignment lands in a log, so
// determinism is asserted at the draw-command level (the full LCG stream and
// all geometry pass through it) rather than at the pixel level.

type Call = [string, ...unknown[]]

let activeLog: Call[]
let contextSpy: ReturnType<typeof vi.spyOn>

function makeStubCtx(log: Call[]): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {}
  for (const m of ['fillRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'ellipse']) {
    target[m] = (...a: unknown[]) => {
      log.push([m, ...a])
    }
  }
  target.createRadialGradient = (...a: unknown[]) => {
    log.push(['createRadialGradient', ...a])
    return {
      addColorStop: (offset: number, color: string) => {
        log.push(['addColorStop', offset, color])
      },
    }
  }
  // unknown methods stay undefined on purpose: a new ctx call in boards.ts
  // must extend this stub, not silently no-op
  return new Proxy(target, {
    set(t, prop, value) {
      // gradients are fresh objects every run — their CONTENT is already in
      // the log via createRadialGradient/addColorStop, so record a token
      log.push([`set:${String(prop)}`, typeof value === 'object' ? '<gradient>' : value])
      t[prop as string] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

const SPEC: TraySpec = { grid: '#3A2A18', showGrid: true }

const FNS: Record<TrayVariant, (spec: TraySpec) => ReturnType<typeof woodTrayTextures>> = {
  wood: woodTrayTextures,
  museum: museumTrayTextures,
  clay: clayTrayTextures,
}

beforeEach(() => {
  activeLog = []
  contextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => makeStubCtx(activeLog) as never)
  disposeBoardTextures() // module-level cache must not leak across tests
})

afterEach(() => {
  disposeBoardTextures()
  contextSpy.mockRestore()
})

describe('tray board textures (lit board-surface contracts)', () => {
  it('exports the tray variant union', () => {
    expect(TRAY_VARIANTS).toEqual(['wood', 'museum', 'clay'])
  })

  it('caches by full option key: same options → same pair instance', () => {
    for (const v of TRAY_VARIANTS) {
      const a = FNS[v](SPEC)
      const b = FNS[v]({ ...SPEC })
      expect(b, `${v} pair identity`).toBe(a)
      expect(b.map).toBe(a.map)
      expect(b.roughnessMap).toBe(a.roughnessMap)
      // the dispatcher hits the same cache as the named function
      expect(trayTexturesFor(v, { ...SPEC })).toBe(a)
    }
  })

  it('grid color participates in the cache key', () => {
    const a = woodTrayTextures(SPEC)
    const b = woodTrayTextures({ ...SPEC, grid: '#101010' })
    expect(b).not.toBe(a)
    expect(b.map).not.toBe(a.map)
  })

  it('showGrid on/off differ in color map but SHARE the roughness instance', () => {
    // Scene3D's litFloorGrid toggle swaps only mat.map — roughness must be
    // identical between the two variants, which sharing makes structural
    for (const v of TRAY_VARIANTS) {
      const on = FNS[v]({ ...SPEC, showGrid: true })
      const off = FNS[v]({ ...SPEC, showGrid: false })
      expect(off, `${v} on/off pairs differ`).not.toBe(on)
      expect(off.map, `${v} on/off maps differ`).not.toBe(on.map)
      expect(off.roughnessMap, `${v} shared roughness`).toBe(on.roughnessMap)
    }
  })

  it('variants are distinct texture instances under identical options', () => {
    const maps = TRAY_VARIANTS.map((v) => FNS[v](SPEC).map)
    expect(new Set(maps).size).toBe(TRAY_VARIANTS.length)
  })

  it('honours the paper.ts texture contract (raw world-px extrude UVs)', () => {
    const fixedRepeat = 1 / (PAPER_PITCH * PAPER_TILE_CELLS)
    for (const v of TRAY_VARIANTS) {
      const { map, roughnessMap } = FNS[v](SPEC)
      for (const tex of [map, roughnessMap]) {
        expect(tex.repeat.x, `${v} fixed repeat x`).toBeCloseTo(fixedRepeat, 10)
        expect(tex.repeat.y, `${v} fixed repeat y`).toBeCloseTo(fixedRepeat, 10)
        expect(tex.wrapS).toBe(THREE.RepeatWrapping)
        expect(tex.wrapT).toBe(THREE.RepeatWrapping)
        expect(tex.anisotropy).toBe(16)
        expect(tex.generateMipmaps).toBe(true)
        expect(tex.minFilter).toBe(THREE.LinearMipmapLinearFilter)
        const img = tex.image as HTMLCanvasElement
        expect(img.width, `${v} tile px`).toBe(PAPER_TILE_CELLS * 64)
        expect(img.height).toBe(PAPER_TILE_CELLS * 64)
      }
      expect(map.colorSpace, `${v} color map is sRGB`).toBe(THREE.SRGBColorSpace)
      expect(roughnessMap.colorSpace, `${v} roughness stays linear`).toBe(THREE.NoColorSpace)
    }
  })

  it('is deterministic: regeneration replays the exact draw-command stream', () => {
    for (const v of TRAY_VARIANTS) {
      activeLog = []
      FNS[v](SPEC)
      const first = activeLog
      expect(first.length, `${v} draws something`).toBeGreaterThan(100)

      disposeBoardTextures() // force a full rebuild — no cache short-circuit
      activeLog = []
      FNS[v](SPEC)
      expect(activeLog, `${v} identical stream`).toEqual(first)
    }
  })

  it('showGrid=false skips the grid pass entirely', () => {
    activeLog = []
    museumTrayTextures({ ...SPEC, showGrid: false })
    const strokes = activeLog.filter(([m]) => m === 'set:strokeStyle')
    // museum's only strokeStyle uses are the grid pass (color map) and the
    // polishing streaks (roughness map) — with the grid off, every remaining
    // stroke color must be a greyscale rgba (roughness), never the grid css
    expect(strokes.length).toBeGreaterThan(0)
    for (const [, color] of strokes) expect(color).not.toBe(SPEC.grid)
  })

  it('dispose drops the cache and disposes the GPU textures', () => {
    const pair = clayTrayTextures(SPEC)
    const mapSpy = vi.spyOn(pair.map, 'dispose')
    const roughSpy = vi.spyOn(pair.roughnessMap, 'dispose')
    disposeBoardTextures()
    expect(mapSpy).toHaveBeenCalledTimes(1)
    expect(roughSpy).toHaveBeenCalledTimes(1)
    const fresh = clayTrayTextures(SPEC)
    expect(fresh).not.toBe(pair)
    expect(fresh.map).not.toBe(pair.map)
  })
})
