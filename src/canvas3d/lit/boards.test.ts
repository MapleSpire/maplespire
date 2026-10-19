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
  WOOD_ROUGH,
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
      // every map carrying the GRID keeps the 100-unit tile (the pitch is
      // exact). The wood roughness carries no grid: since view3d quality loop
      // 4 it holds the plank layout on its own large repeat — see the next
      // test — because a 100-unit tile repeated its features twice across
      // every 200-wide card (critic: "a brick or tile pattern behind the
      // cards", workbench-labels.png)
      for (const tex of v === 'wood' ? [map] : [map, roughnessMap]) {
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

  it('wood planks: the roughness spans long planks on its own repeat, every texture <= 512 px', () => {
    const { map, roughnessMap } = woodTrayTextures(SPEC)
    expect(WOOD_ROUGH.plankL, 'a plank is at least four 200-wide cards long').toBeGreaterThanOrEqual(800)
    expect(roughnessMap.repeat.x).toBeCloseTo(1 / WOOD_ROUGH.spanX, 12)
    expect(roughnessMap.repeat.y).toBeCloseTo(1 / WOOD_ROUGH.spanZ, 12)
    // fewer repeats per board than the grid tile, along both axes
    expect(roughnessMap.repeat.x).toBeLessThan(map.repeat.x / 4)
    expect(roughnessMap.repeat.y).toBeLessThan(map.repeat.y)
    // the tile holds whole plank rows and whole plank lengths, so the
    // layout closes across RepeatWrapping
    expect(WOOD_ROUGH.spanZ % WOOD_ROUGH.plankW).toBe(0)
    expect(WOOD_ROUGH.spanX % WOOD_ROUGH.plankL).toBe(0)
    expect(roughnessMap.wrapS).toBe(THREE.RepeatWrapping)
    expect(roughnessMap.anisotropy).toBe(16)
    for (const tex of [map, roughnessMap]) {
      const img = tex.image as HTMLCanvasElement
      expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(512)
    }
  })

  it('wood albedo: no knot figures — the periodic mark of the 100-unit tile', () => {
    activeLog = []
    woodTrayTextures({ ...SPEC, showGrid: false })
    // the colour map's only ellipses were the knots; the roughness has none
    expect(activeLog.filter(([m]) => m === 'ellipse')).toHaveLength(0)
    // …and the grain at half its old albedo contrast: the heaviest latewood
    // was 0.22 alpha, now 0.11 (greyscale strokes belong to the roughness)
    const grain = activeLog
      .filter(([m]) => m === 'set:strokeStyle')
      .map(([, c]) => /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(String(c)))
      .filter((m): m is RegExpExecArray => !!m && !(m[1] === m[2] && m[2] === m[3]))
    expect(grain.length).toBeGreaterThan(100)
    for (const m of grain) expect(Number(m[4])).toBeLessThanOrEqual(0.11 + 1e-9)
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

  it('minors:false keeps the 100-unit majors and drops every 20-unit minor (the board at rest, loop 4 r3)', () => {
    // workbench-wide / city-wide / workbench-labels.png (loop 4 r3): "an even
    // 20-unit cross-hatch is clearly visible over the whole board wood".
    // Scene3D's cap wears minors:false at rest and the full pitch while a
    // card is dragged. A vertical grid line starts at moveTo(p, 0); the
    // minors sit at p = c·64 + 0.5 (+ the 1.4 engraving shift), c = 1..4,
    // the major at 1.1 (+ shift).
    const minorX = new Set<number>()
    for (let c = 1; c < 5; c++) for (const s of [0, 1.4]) minorX.add(c * 64 + 0.5 + s)
    const verticals = (log: Call[], xs: (x: number) => boolean) =>
      log.filter(([m, x, y]) => m === 'moveTo' && y === 0 && xs(x as number)).length
    for (const v of TRAY_VARIANTS) {
      activeLog = []
      const rest = FNS[v]({ ...SPEC, minors: false })
      const restLog = activeLog
      activeLog = []
      const drag = FNS[v]({ ...SPEC, minors: true })
      const dragLog = activeLog
      expect(rest.map, `${v}: rest and drag maps differ`).not.toBe(drag.map)
      expect(rest.roughnessMap, `${v}: one roughness for both`).toBe(drag.roughnessMap)
      expect(verticals(restLog, (x) => minorX.has(x)), `${v}: no minor at rest`).toBe(0)
      expect(verticals(dragLog, (x) => minorX.has(x)), `${v}: the minors while dragging`).toBeGreaterThan(0)
      // the majors stay in both
      expect(verticals(restLog, (x) => x === 1.1 || x === 2.5), `${v}: majors at rest`).toBeGreaterThan(0)
    }
    // the default is the full pitch (every pre-r3 caller keeps its map)
    expect(woodTrayTextures(SPEC)).toBe(woodTrayTextures({ ...SPEC, minors: true }))
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
