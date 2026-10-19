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
import {
  ARCH_SHARE,
  CITY_DESK_BASE,
  CITY_DESK_CONTRAST,
  CITY_DESK_RELIEF,
  DESK_BOARDS,
  DESK_PLANKS,
  GRAIN_TILE_ACROSS,
  GRAIN_TILE_PX,
  GRAIN_TILE_WORLD,
  PLANK_WIDTH,
  VIGNETTE_PX,
  WOOD_DESK_BASE,
  WOOD_DESK_RELIEF,
  deskBoardLayout,
  deskBoardsGeometry,
  deskRow,
  deskVignetteTexture,
  grainTile,
  vignetteTile,
  woodAlbedoTile,
  workbenchTextures,
} from './wood'

/** World units per texel along (x) and across (y) the grain. */
const AX = GRAIN_TILE_WORLD / GRAIN_TILE_PX
const AY = GRAIN_TILE_ACROSS / GRAIN_TILE_PX
const ROWS = GRAIN_TILE_PX / DESK_PLANKS

/**
 * The desk's repeated GRAIN tile (view3d quality loop 4 r3: "the desk is a
 * flat tan plane with soft streaks and no grain or wear").
 */
describe('workbench grain tile', () => {
  const N = GRAIN_TILE_PX
  const { normal, rough, height, late, pore, fleck, seam } = grainTile()
  const h = (x: number, y: number) => height[((y + N) % N) * N + ((x + N) % N)]

  it('is fine enough for the prop close-ups: ≤ 0.5 world unit per texel on both axes', () => {
    // run.mjs focusProp frames ~0.1 unit per pixel (~0.06 in the
    // foreground): the 0.82-unit texel shipped before 2026-10-09 was
    // magnified 8-14× into the "motion blur" streaks of workbench-beaver/
    // -flag.png; 0.94 along the grain still smeared the foreground pores
    // (tp-wood-1/workbench-beaver.png)
    expect(AX).toBeLessThanOrEqual(0.5)
    expect(AY).toBeLessThanOrEqual(0.5)
    expect(GRAIN_TILE_PX, 'textures stay ≤ 512 px (perf rule)').toBeLessThanOrEqual(512)
  })

  it('the relief is a real normal map: flat on average, pointing out of the desk', () => {
    let sx = 0
    let sy = 0
    let sz = 0
    let bent = 0
    for (let i = 0; i < N * N; i++) {
      sx += normal[i * 4] / 255
      sy += normal[i * 4 + 1] / 255
      sz += normal[i * 4 + 2] / 255
      if (Math.abs(normal[i * 4 + 1] - 128) > 12) bent++
    }
    expect(sx / (N * N), 'x averages to flat').toBeCloseTo(0.5, 1)
    expect(sy / (N * N), 'y averages to flat').toBeCloseTo(0.5, 1)
    expect(sz / (N * N), 'z points out of the surface').toBeGreaterThan(0.9)
    // not a blank map: a visible share of texels carries the grain
    expect(bent / (N * N), 'texels tilted by the grain').toBeGreaterThan(0.1)
  })

  it('the grain runs ALONG the desk (x), like the colour streaks it sits under', () => {
    let along = 0
    let across = 0
    for (let y = 0; y < N; y += 2) {
      for (let x = 0; x < N; x += 2) {
        along += Math.abs(h(x + 1, y) - h(x, y))
        across += Math.abs(h(x, y + 1) - h(x, y))
      }
    }
    expect(across / along, 'relief changes across the grain, not along it').toBeGreaterThan(2)
  })

  it('the grain is FINE, not dunes: latewood lines every few world units (loop4-r3-assets-c)', () => {
    // The first cut summed 9-34-cycle harmonics under one shared wave: on the
    // live desk the relief rolled across the whole surface like sand dunes.
    // Counted here as local maxima down each column of the height field, in
    // world units ACROSS the grain.
    let peaks = 0
    for (let x = 0; x < N; x += 8) {
      for (let y = 0; y < N; y++) if (h(x, y) > h(x, y - 1) && h(x, y) >= h(x, y + 1) && h(x, y) > 0.05) peaks++
    }
    const pitch = (N / (peaks / (N / 8))) * AY
    // measured 2026-10-09: 2.75 by the harmonics tile, 5.57 with the dunes
    // cut's 9-34-cycle harmonics (mutant run, everything else equal); 2.3
    // by the rotary cathedral tile; 1.95 by the plank-sawn tile (rings
    // 1.6-2.4 units, its fibre adding maxima between them)
    expect(pitch, 'mean world units between grain lines').toBeLessThan(4)
  })

  it('tiles without a seam: the wrap edges step no more than the interior does', () => {
    let interior = 0
    for (let y = 1; y < N; y++) for (let x = 0; x < N; x++) interior = Math.max(interior, Math.abs(h(x, y) - h(x, y - 1)))
    let seamY = 0
    for (let x = 0; x < N; x++) seamY = Math.max(seamY, Math.abs(h(x, 0) - h(x, N - 1)))
    expect(seamY, 'the top/bottom seam').toBeLessThanOrEqual(interior * 1.01)
    let interiorX = 0
    for (let y = 0; y < N; y++) for (let x = 1; x < N; x++) interiorX = Math.max(interiorX, Math.abs(h(x, y) - h(x - 1, y)))
    let seamX = 0
    for (let y = 0; y < N; y++) seamX = Math.max(seamX, Math.abs(h(0, y) - h(N - 1, y)))
    expect(seamX, 'the left/right seam').toBeLessThanOrEqual(interiorX * 1.01)
  })

  it('the roughness keeps the satin-to-matte range (G channel, what three samples)', () => {
    let lo = 255
    let hi = 0
    for (let i = 0; i < N * N; i++) {
      lo = Math.min(lo, rough[i * 4 + 1])
      hi = Math.max(hi, rough[i * 4 + 1])
    }
    // the stretched canvas it replaces spanned 222-255 (~0.87-1.0)
    expect(lo / 255, 'satin earlywood').toBeGreaterThan(0.7)
    expect(lo / 255).toBeLessThan(0.9)
    expect(hi / 255, 'matte latewood and pores').toBeGreaterThan(0.95)
  })

  it('the roughness FOLLOWS the grain: matte latewood, glossier ray flecks', () => {
    let late_ = 0
    let nLate = 0
    let early = 0
    let nEarly = 0
    let fl = 0
    let nFl = 0
    for (let i = 0; i < N * N; i++) {
      if (seam[i] || pore[i] > 0.05) continue
      const g = rough[i * 4 + 1]
      if (fleck[i] > 0.5) {
        fl += g
        nFl++
      } else if (fleck[i] > 0.05) continue
      else if (late[i] > 0.8) {
        late_ += g
        nLate++
      } else if (late[i] < 0.05) {
        early += g
        nEarly++
      }
    }
    // measured 2026-10-09: latewood 237, earlywood 212, flecks 196 (of 255); the
    // harmonics tile drew roughness from the height alone, no flecks
    expect(late_ / nLate - early / nEarly, 'latewood rougher than earlywood').toBeGreaterThan(15)
    expect(fl / nFl, 'ray flecks glossier than earlywood').toBeLessThan(early / nEarly - 10)
  })
})

/**
 * The desk's COLOUR (view3d quality loop 4 r4: "the desk surface is still
 * diagonal motion-blur streaks with no pores, seams or plank structure"),
 * then 2026-10-09 ("the desk wood reads as stretched, smeared streaks like
 * motion blur in every close-up"), then 2026-10-09 again ("plywood
 * wallpaper": tp-final-dpr1/workbench-wide.png — rotary-cut ellipses larger
 * than the moose repeating every ~200 px). Each figure test below names the
 * property, its shipped value and a mutant or earlier tile that fails it.
 */
describe('workbench colour tile', () => {
  const N = GRAIN_TILE_PX
  const tile = grainTile(0x5eed0b0a ^ 0x9e3779b9)
  const rgba = woodAlbedoTile(WOOD_DESK_BASE, tile, 0x5eed0b0a)
  const lumOf = (arr: Uint8Array) => (x: number, y: number) => {
    const o = (((y + N) % N) * N + ((x + N) % N)) * 4
    return 0.2126 * arr[o] + 0.7152 * arr[o + 1] + 0.0722 * arr[o + 2]
  }
  const lum = lumOf(rgba)
  const seamAt = (x: number, y: number) => tile.seam[((y + N) % N) * N + ((x + N) % N)] === 1
  const nearSeam = (x: number, y: number, r = 3) => {
    for (let d = -r; d <= r; d++) if (seamAt(x, y + d)) return true
    return false
  }
  const rowOf = (y: number) => tile.plankOfRow[((y % N) + N) % N]
  const isArchedRow = (y: number) => rowOf(y) % 2 === 1
  /** mean and coefficient of variation of the luminance off the grooves */
  const stats = (l: (x: number, y: number) => number) => {
    let s = 0
    let s2 = 0
    let n = 0
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (nearSeam(x, y)) continue
        const v = l(x, y)
        s += v
        s2 += v * v
        n++
      }
    }
    const mean = s / n
    return { mean, cv: Math.sqrt(s2 / n - mean * mean) / mean }
  }

  it('REPEATS at the grain pitch, from a small tile — a stretched map fails here', () => {
    const t = workbenchTextures()
    expect(t.map.image.width, 'colour tile px').toBe(GRAIN_TILE_PX)
    expect(t.map.image.width).toBeLessThanOrEqual(512)
    expect(t.map.wrapS, 'the colour repeats').toBe(THREE.RepeatWrapping)
    expect(t.map.wrapT).toBe(THREE.RepeatWrapping)
    // one tile spans GRAIN_TILE_WORLD units: under 1 world unit per texel
    // (the stretched 2048 canvas was ~3 on the 6000-unit minimum desk)
    expect(GRAIN_TILE_WORLD / t.map.image.width).toBeLessThan(1)
    // the vignette that forced the stretch rides its own clamped overlay
    const v = deskVignetteTexture()
    expect(v.wrapS).toBe(THREE.ClampToEdgeWrapping)
    expect(v.image.width).toBeLessThanOrEqual(512)
  })

  it('the colour grain runs ALONG the desk: value changes across it, not along it', () => {
    let along = 0
    let across = 0
    for (let y = 0; y < N; y += 2) {
      for (let x = 0; x < N; x += 2) {
        if (seamAt(x, y) || seamAt(x + 1, y) || seamAt(x, y + 1)) continue
        along += Math.abs(lum(x + 1, y) - lum(x, y))
        across += Math.abs(lum(x, y + 1) - lum(x, y))
      }
    }
    // measured 2026-10-09: 11.6 by the harmonics tile; 5.6 by the rotary
    // cathedral tile; 10.0 by the plank-sawn tile (its pores have ends) —
    // a grain, not a speckle (an isotropic noise reads ~1)
    expect(across / along, 'anisotropy of the colour').toBeGreaterThan(2)
  })

  it('dark grain lines every few world units — fine lines, not a smear', () => {
    let lines = 0
    let cols = 0
    for (let x = 3; x < N; x += 16) {
      cols++
      for (let y = 0; y < N; y++) {
        if (seamAt(x, y - 1) || seamAt(x, y) || seamAt(x, y + 1)) continue
        // a local minimum standing at least 4 % under its neighbours 3 rows out
        const c = lum(x, y)
        if (c < lum(x, y - 1) && c <= lum(x, y + 1) && c < 0.96 * Math.max(lum(x, y - 3), lum(x, y + 3))) lines++
      }
    }
    const pitch = (N / (lines / cols)) * AY
    // measured 2026-10-09: 3.5 by the harmonics tile, 2.4 by the rotary
    // cathedral tile, 1.9 by the plank-sawn tile (pores count too). (By the
    // old code's own constants the stretched canvas drew 150 streaks across
    // a ≥6000-unit desk: ≥40 units between lines on average.)
    expect(pitch, 'mean world units between dark grain lines').toBeLessThan(6)
  })

  /** The luminance as the fit framing sees it (~2.5 world units a pixel:
   * a 5 × 5-texel box), and its correlation with itself shifted by (dx, dy)
   * texels, over pairs inside ONE board row, off the grooves. */
  const fit = new Float32Array(N * N)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let a = 0
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) a += lum(x + dx, y + dy)
      fit[y * N + x] = a / 25
    }
  }
  const lagCorr = (dx: number, dy: number) => {
    let sa = 0
    let sb = 0
    let saa = 0
    let sbb = 0
    let sab = 0
    let n = 0
    for (let y = 0; y < N; y++) {
      if (nearSeam(0, y, 4) || nearSeam(0, y + dy, 4) || rowOf(y) !== rowOf(y + dy)) continue
      for (let x = 0; x < N; x++) {
        const a = fit[y * N + x]
        const b = fit[((y + dy) % N) * N + ((x + dx) % N)]
        sa += a
        sb += b
        saa += a * a
        sbb += b * b
        sab += a * b
        n++
      }
    }
    const ma = sa / n
    const mb = sb / n
    return (sab / n - ma * mb) / Math.sqrt((saa / n - ma * ma) * (sbb / n - mb * mb))
  }

  it('STRAIGHT plank-sawn grain at the fit framing: the figure runs the board long and is fine across it', () => {
    // "plywood wallpaper" (tp-final-dpr1/workbench-wide.png): the rotary
    // tile's figure was ellipses ~100-200 units across. On the fit-framing
    // luminance, measured 2026-10-09:
    //   along the grain, 64 units apart: 0.47 plank-sawn, -0.01 rotary
    //   (its arches bend away within a tile);
    //   across the grain, 4 units apart: -0.07 plank-sawn, 0.37 rotary
    //   (its bands ~30+ units wide hold the correlation at 0.3 out to 32).
    const along64 = lagCorr(64 / AX, 0)
    const across4 = lagCorr(0, 4 / AY)
    expect(along64, 'the figure still correlated 64 units down the board').toBeGreaterThan(0.3)
    expect(across4, 'and decorrelated 4 units across it').toBeLessThan(0.2)
  })

  it('cathedrals are RARE and SMALL: only the arched rows fold their rings, in one small flame', () => {
    // A ring line folds (an arch tip) where the ring coordinate falls going
    // across the board. Measured 2026-10-09: 51 % of the rotary tile's
    // texels (every board a cut through its pith); 0 in a plain row by
    // construction; 0.7 % of the plank-sawn tile, all in the two arched rows.
    const folded = new Uint8Array(N * N)
    let fold = 0
    let n = 0
    for (let y = 0; y < N - 1; y++) {
      for (let x = 0; x < N; x++) {
        if (nearSeam(x, y, 2) || nearSeam(x, y + 1, 2)) continue
        n++
        if (tile.ring[(y + 1) * N + x] < tile.ring[y * N + x] - 1e-4) {
          fold++
          folded[y * N + x] = 1
          expect(isArchedRow(y), `fold at (${x}, ${y}) outside an arched row`).toBe(true)
        }
      }
    }
    expect(fold / n, 'share of folded texels').toBeLessThan(0.03)
    for (let b = 0; b < DESK_BOARDS; b++) {
      const r = deskRow(b, true)
      let x0 = N
      let x1 = -1
      let y0 = N
      let y1 = -1
      let cnt = 0
      for (let y = r * ROWS; y < (r + 1) * ROWS; y++) {
        for (let x = 0; x < N; x++) {
          if (!folded[y * N + x]) continue
          cnt++
          x0 = Math.min(x0, x)
          x1 = Math.max(x1, x)
          y0 = Math.min(y0, y)
          y1 = Math.max(y1, y)
        }
      }
      // every arched row carries its cathedral; the folded flame spans
      // well under a board across and under the tile along (measured
      // 2026-10-09: 7 and 9 units across, 53 and 58 along)
      expect(cnt, `board ${b}: an arched row with no arch`).toBeGreaterThan(20)
      expect((y1 - y0 + 1) * AY, `board ${b}: arch height, units`).toBeLessThan(PLANK_WIDTH / 2)
      expect((x1 - x0 + 1) * AX, `board ${b}: arch length, units`).toBeLessThan(100)
    }
  })

  it('an ARCHED row meets its PLAIN twin seamlessly near the tile x wrap (the desk switches there)', () => {
    // deskBoardsGeometry draws a board from its plain row and switches to
    // the arched one for exactly one tile, at integer u. The twins must be
    // texel-identical in colour, roughness and relief within 8 units of the
    // wrap. Measured 2026-10-09: 0 channels differ; RED with the arch lift
    // made a Gaussian along x (mutant: not compact, its tail never reaches
    // zero).
    const { normal: nm, rough: rg } = tile
    let diff = 0
    for (let b = 0; b < DESK_BOARDS; b++) {
      const p = deskRow(b, false) * ROWS
      const a = deskRow(b, true) * ROWS
      for (let y = 0; y < ROWS; y++) {
        for (const x of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, N - 16, N - 12, N - 8, N - 4, N - 2, N - 1]) {
          const ip = ((p + y) * N + x) * 4
          const ia = ((a + y) * N + x) * 4
          for (let c = 0; c < 3; c++) {
            if (rgba[ip + c] !== rgba[ia + c] || nm[ip + c] !== nm[ia + c] || rg[ip + c] !== rg[ia + c]) diff++
          }
        }
      }
    }
    expect(diff, 'texel channels differing between the twins at the wrap').toBe(0)
  })

  it('the colour tiles without a seam along the grain', () => {
    // anything keyed on a term that is not periodic in x would cut a line
    // across every board at the wrap. Measured 2026-10-09: 1.04 by the
    // rotary tile, 1.0 by the plank-sawn tile; 7.3 with the rotary tile's
    // tone keyed on the ring number (mutant)
    let interior = 0
    let wrap = 0
    for (let y = 0; y < N; y++) {
      if (seamAt(0, y)) continue
      let row = 0
      for (let x = 1; x < N; x++) row += Math.abs(lum(x, y) - lum(x - 1, y))
      interior += row / (N - 1)
      wrap += Math.abs(lum(0, y) - lum(N - 1, y))
    }
    expect(wrap / interior, 'the wrap column steps like any other').toBeLessThan(1.5)
  })

  it('a contrasty colour map: the figure is not a low-contrast smear', () => {
    // measured 2026-10-09: coefficient of variation 0.155 by the rotary
    // tile, 0.109 by the harmonics tile (its 17 % ring dip), 0.146 by the
    // plank-sawn tile
    expect(stats(lum).cv).toBeGreaterThan(0.14)
  })

  it(`${DESK_PLANKS} board rows per tile (${DESK_BOARDS} boards, each plain + arched), split by dark grooves`, () => {
    const seamRows: number[] = []
    let darkest = Infinity
    const sum = new Array<number>(DESK_PLANKS).fill(0)
    const cnt = new Array<number>(DESK_PLANKS).fill(0)
    for (let y = 0; y < N; y++) {
      let row = 0
      let rowSeam = 0
      for (let x = 0; x < N; x++) {
        if (seamAt(x, y)) rowSeam++
        else {
          sum[rowOf(y)] += lum(x, y)
          cnt[rowOf(y)]++
        }
        row += lum(x, y)
      }
      if (rowSeam === N) seamRows.push(row / N)
    }
    for (let p = 0; p < DESK_PLANKS; p++) darkest = Math.min(darkest, sum[p] / cnt[p])
    expect(new Set(tile.plankOfRow).size, 'rows in the tile').toBe(DESK_PLANKS)
    // the first and the last texel row of every row block is a groove: any
    // two rows a board can map meet groove to groove
    expect(seamRows.length).toBe(DESK_PLANKS * 2)
    for (let p = 0; p < DESK_PLANKS; p++) {
      expect(seamAt(5, p * ROWS)).toBe(true)
      expect(seamAt(5, (p + 1) * ROWS - 1)).toBe(true)
    }
    for (const s of seamRows) expect(s / darkest, 'a groove is darker than the darkest row').toBeLessThan(0.6)
    // and nothing else is a groove: no butt joints (they read as a floor deck)
    let cut = 0
    for (let i = 0; i < N * N; i++) cut += tile.seam[i]
    expect(cut).toBe(DESK_PLANKS * 2 * N)
  })

  it('pore flecks: dark dashes inside the planks', () => {
    let pores = 0
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (seamAt(x, y)) continue
        // a texel on a pore dash that reads clearly darker than the wood a
        // couple of rows either side of it
        if (tile.pore[y * N + x] > 0.3 && lum(x, y) < 0.85 * Math.max(lum(x, y - 2), lum(x, y + 2))) pores++
      }
    }
    expect(pores / (N * N), 'share of texels that are pore flecks').toBeGreaterThan(0.004)
  })

  it('pores are SHORT dashes along the grain: one texel wide, a few long — never a streak', () => {
    const on = (x: number, y: number) => tile.pore[((y + N) % N) * N + ((x + N) % N)] > 0.3 && !seamAt(x, y)
    let runs = 0
    let runTexels = 0
    let longest = 0
    let stacked = 0
    let texels = 0
    for (let y = 0; y < N; y++) {
      let run = 0
      for (let x = 0; x <= N; x++) {
        if (x < N && on(x, y)) {
          run++
          texels++
          if (on(x, y - 1) || on(x, y + 1)) stacked++
        } else if (run) {
          runs++
          runTexels += run
          longest = Math.max(longest, run)
          run = 0
        }
      }
    }
    const meanLen = (runTexels / runs) * AX
    // measured 2026-10-09: 1.5 world units (0.4 mm) mean, 4.5 longest
    // (plank-sawn tile: 1.54 and 4.0, 8 % stacked);
    // the harmonics tile: 5.2 mean, 18.9 longest (its overlapping dashes
    // merged into streaks)
    expect(meanLen, 'mean dash length, world units').toBeGreaterThan(0.75)
    expect(meanLen).toBeLessThan(3)
    expect(longest * AX, 'longest dash, world units').toBeLessThan(6)
    // a dash is one texel across: few pore texels touch another row's
    expect(stacked / texels, 'pore texels stacked across the grain').toBeLessThan(0.25)
  })

  it('ray flecks: small lighter lenses in the wood', () => {
    let lit = 0
    let n = 0
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x
        if (seamAt(x, y) || tile.fleck[i] < 0.6 || tile.pore[i] > 0.05) continue
        n++
        // against the same row 5 texels either way: past the fleck's
        // 2-4-texel length, on the same ring band
        if (lum(x, y) > 1.03 * 0.5 * (lum(x - 5, y) + lum(x + 5, y))) lit++
      }
    }
    // measured 2026-10-09: 0.5 % of the texels, 96 % of them lighter (plank-
    // sawn tile: 1.0 %, 94 %); 9 %
    // with the fleck tint removed (mutant). The harmonics tile had none.
    expect(n / (N * N), 'share of texels on a fleck').toBeGreaterThan(0.003)
    expect(lit / n, 'flecks reading lighter than the wood beside them').toBeGreaterThan(0.6)
  })

  it('walnut: a value step under the old #C8A67D desk, which matched the board', () => {
    // loop 4 r4 workbench-wide.png: desk (204,161,115) vs board (206,155,98).
    // Measured 2026-10-09: 0.61 of the old base's luminance with the
    // harmonics tile, 0.62 with the rotary tile, 0.64 with the plank-sawn
    // one; the live board reads 32 % over its desk with the board tones
    // (tp2-wood-3, run.mjs boardDesk: 158.9 vs 108.7)
    const { mean } = stats(lum)
    const old = 0.2126 * 0xc8 + 0.7152 * 0xa6 + 0.0722 * 0x7d
    expect(mean / old, 'desk albedo vs the old flat base').toBeLessThan(0.75)
    expect(mean / old, 'still wood, not a black hole').toBeGreaterThan(0.5)
  })

  it('the CITY desk: a pale, quiet board near the city pavement, on the same grain textures', () => {
    // city-moose/city-flag.png (2026-10-09): the walnut under the city
    // animals read as a dark muddy pit, its pores magnified ~20× into
    // streaks (tp-wood-2/city-flag.png at contrast 0.5 and full relief).
    // Measured 2026-10-09: 1.78× the walnut, 1.09× the pavement, cv 0.022
    // (plank-sawn tile: 1.73×, 1.10×, 0.021)
    // against the walnut's 0.155 (0.055 at contrast 0.3, still streaky in
    // tp-wood-3/city-moose.png)
    const city = lumOf(woodAlbedoTile(CITY_DESK_BASE, tile, 0x5eed0b0a, CITY_DESK_CONTRAST))
    const c = stats(city)
    const w = stats(lum)
    const pave = 0.2126 * 0xb7 + 0.7152 * 0xaa + 0.0722 * 0x92 // CITY.apron
    expect(c.mean / w.mean, 'lighter than the walnut').toBeGreaterThan(1.4)
    expect(Math.abs(c.mean / pave - 1), 'a step off the city pavement at most').toBeLessThan(0.15)
    expect(c.cv, 'its figure a whisper of the walnut').toBeLessThan(w.cv * 0.5)
    expect(CITY_DESK_RELIEF, 'near-flat relief').toBeLessThan(WOOD_DESK_RELIEF / 3)
    // the relief + roughness pair is ONE upload shared by both desks
    const wb = workbenchTextures()
    const ct = workbenchTextures(CITY_DESK_BASE, undefined, CITY_DESK_CONTRAST)
    expect(ct.normalMap).toBe(wb.normalMap)
    expect(ct.roughnessMap).toBe(wb.roughnessMap)
    expect(ct.map).not.toBe(wb.map)
  })

  it('the vignette overlay: clear around the board, dark toward the rim, monotonic', () => {
    const S = VIGNETTE_PX
    const a = vignetteTile()
    const alpha = (x: number, y: number) => a[(y * S + x) * 4 + 3] / 255
    expect(alpha(S / 2, S / 2), 'clear at the board').toBe(0)
    expect(alpha(0, 0), 'dark at the rim').toBeGreaterThan(0.5)
    let prev = -1
    for (let x = S / 2; x < S; x++) {
      expect(alpha(x, S / 2)).toBeGreaterThanOrEqual(prev)
      prev = alpha(x, S / 2)
    }
  })
})

/**
 * The desk as BOARDS (deskBoardLayout / deskBoardsGeometry): the tile
 * repeated on a plane drew the same figure every 256 units both ways —
 * "plywood wallpaper" at the fit framing (tp-final-dpr1/workbench-wide.png,
 * x 330-650). Each board maps its own tile row, offset and mirror, with its
 * own tone.
 */
describe('workbench desk boards', () => {
  const SIZE = 6000
  const seed = 0x5eed0b0a
  const boards = deskBoardLayout(SIZE, seed)
  const geo = deskBoardsGeometry(SIZE, seed)
  const pos = geo.getAttribute('position')
  const uv = geo.getAttribute('uv')
  const col = geo.getAttribute('color')
  const idx = geo.getIndex()!

  it('covers the desk with up-facing quads, like the plane it replaces', () => {
    let area = 0
    for (let t = 0; t < idx.count; t += 3) {
      const [a, b, c] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)]
      const ux = pos.getX(b) - pos.getX(a)
      const uy = pos.getY(b) - pos.getY(a)
      const vx = pos.getX(c) - pos.getX(a)
      const vy = pos.getY(c) - pos.getY(a)
      const z = ux * vy - uy * vx
      expect(z, 'counter-clockwise from +Z (front face up once rotated)').toBeGreaterThan(0)
      area += z / 2
    }
    expect(area / (SIZE * SIZE)).toBeCloseTo(1, 6)
    for (let i = 0; i < pos.count; i++) {
      expect(Math.abs(pos.getX(i))).toBeLessThanOrEqual(SIZE / 2 + 1e-6)
      expect(Math.abs(pos.getY(i))).toBeLessThanOrEqual(SIZE / 2 + 1e-6)
    }
    // one draw, a few thousand vertices (measured 2026-10-09: 3 348)
    expect(pos.count).toBeLessThan(20000)
    expect(geo.getAttribute('normal').getZ(0)).toBe(1)
  })

  it('the UVs carry the world scale and every quad samples ONE tile row', () => {
    for (let q = 0; q < pos.count; q += 4) {
      // quad corners: (xa,y0) (xb,y0) (xa,y1) (xb,y1)
      const dx = pos.getX(q + 1) - pos.getX(q)
      const dy = pos.getY(q + 2) - pos.getY(q)
      expect(Math.abs((uv.getX(q + 1) - uv.getX(q)) / dx) * GRAIN_TILE_WORLD).toBeCloseTo(1, 4)
      expect(Math.abs((uv.getY(q + 2) - uv.getY(q)) / dy) * GRAIN_TILE_ACROSS).toBeCloseTo(1, 4)
      const vLo = Math.min(uv.getY(q), uv.getY(q + 2))
      const vHi = Math.max(uv.getY(q), uv.getY(q + 2))
      const row = Math.floor(vLo * DESK_PLANKS + 1e-9)
      expect(vHi, 'inside its row block').toBeLessThanOrEqual((row + 1) / DESK_PLANKS + 1e-9)
    }
  })

  it('arched tiles are RARE, single and whole: one tile of the arched row, switched at integer u', () => {
    let tiles = 0
    let arched = 0
    for (const b of boards) {
      for (let i = 1; i < b.arched.length; i++) expect(b.arched[i] - b.arched[i - 1], 'never two in a row').toBeGreaterThan(1)
      arched += b.arched.length
      tiles += SIZE / GRAIN_TILE_WORLD
    }
    // measured 2026-10-09: 128 arched tiles of 2 203 (5.8 %)
    expect(arched / tiles).toBeGreaterThan(ARCH_SHARE * 0.5)
    expect(arched / tiles).toBeLessThan(ARCH_SHARE * 1.5)
    // the arched row is drawn inside whole tiles only (a tone knot may
    // split one into two quads), and covers exactly the arched tiles
    let archedLen = 0
    for (let q = 0; q < pos.count; q += 4) {
      const row = Math.floor(Math.min(uv.getY(q), uv.getY(q + 2)) * DESK_PLANKS + 1e-9)
      if (row % 2 === 0) continue
      const ua = Math.min(uv.getX(q), uv.getX(q + 1))
      const ub = Math.max(uv.getX(q), uv.getX(q + 1))
      const n = Math.floor((ua + ub) / 2)
      expect(ua, 'inside one whole tile').toBeGreaterThanOrEqual(n - 1e-4)
      expect(ub, 'inside one whole tile').toBeLessThanOrEqual(n + 1 + 1e-4)
      archedLen += ub - ua
    }
    expect(archedLen).toBeCloseTo(arched, 2)
  })

  it('the board tones: each its own, a clear step from its neighbour, centred on the albedo', () => {
    const t = boards.map((b) => b.tone)
    const mean = t.reduce((s, v) => s + v, 0) / t.length
    // measured 2026-10-09: 0.72-1.27, mean 1.01; no neighbour within 0.06;
    // the city at CITY_DESK_CONTRAST spans 0.083 against the walnut 0.554
    expect(Math.max(...t) / Math.min(...t), 'tone spread').toBeGreaterThan(1.3)
    expect(Math.abs(mean - 1), 'the walnut albedo stays the desk mean').toBeLessThan(0.05)
    let close = 0
    for (let i = 1; i < t.length; i++) if (Math.abs(t[i] - t[i - 1]) < 0.06) close++
    expect(close / t.length, 'neighbours a step apart').toBeLessThan(0.05)
    // and no two neighbours show the same streak sequence
    for (let i = 1; i < boards.length; i++) {
      const same = boards[i].board === boards[i - 1].board && boards[i].mirror === boards[i - 1].mirror
      expect(same, `boards ${i - 1} and ${i}`).toBe(false)
    }
    // the colour attribute is continuous along a board (a drift, never a
    // step mid-board): consecutive quads of one board share their edge
    for (let q = 4; q < pos.count; q += 4) {
      if (pos.getY(q) !== pos.getY(q - 4) || pos.getX(q) !== pos.getX(q - 3)) continue
      for (let c = 0; c < 3; c++) expect(col.getComponent(q, c)).toBeCloseTo(col.getComponent(q - 3, c), 6)
    }
    // the city's birch takes the same contrast: its tones a whisper
    const city = deskBoardLayout(SIZE, seed, CITY_DESK_CONTRAST).map((b) => b.tone)
    expect(Math.max(...city) - Math.min(...city)).toBeLessThan((Math.max(...t) - Math.min(...t)) * 0.3)
  })

  it('no LATTICE: one tile across the desk is no more alike than any other run of boards', () => {
    // The detail tile (no tones: what the lattice was made of), sampled the
    // way the desk maps it at ~2 units a pixel (a 4 × 4-texel box) over a
    // 1024 × 2048-unit patch at the centre, then correlated with itself
    // 1-8 boards across. Measured 2026-10-09 (lags 1, 2, 3, 4 = one tile,
    // 5, 6, 8 boards):
    //   plane with a repeat (the desk before): 0.58 0.32 0.59 1.00 0.58 0.32 1.00
    //   boards:                                0.23 0.43 0.33 0.39 0.35 0.34 0.33
    //   (seeds 1-3: means 0.37-0.43, tile lag within 0.02-0.04 of the rest)
    //   every board mapped alike (mutant: board 0, u0 0, no mirror/flip):
    //   0.99 at the tile lag; the mapping cycling every 4 boards (mutant: a
    //   lattice with the tile's period): the tile lag 0.72 over the rest.
    // The ~0.35 floor is the tile's own limit, kept on the record: two
    // boards × mirror = four streak sequences, so any two boards share one
    // a quarter of the time — at ANY distance, which is what no lattice is.
    const N = GRAIN_TILE_PX
    const tile = grainTile(seed ^ 0x9e3779b9)
    const rgba = woodAlbedoTile(WOOD_DESK_BASE, tile, seed)
    const L = new Float32Array(N * N)
    for (let i = 0; i < N * N; i++) L[i] = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]
    const half = SIZE / 2
    const W = 512
    const H = 1024
    const UPP = 2
    const sample = (u: number, v: number) => {
      const cx = Math.floor(u * N)
      const cy = Math.floor(v * N)
      let a = 0
      for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) a += L[((((cy + dy) % N) + N) % N) * N + ((((cx + dx) % N) + N) % N)]
      return a / 16
    }
    const render = (bs: typeof boards | null) => {
      const out = new Float32Array(W * H)
      for (let py = 0; py < H; py++) {
        const y = (py - H / 2) * UPP + 0.5
        for (let px = 0; px < W; px++) {
          const x = (px - W / 2) * UPP + 0.5
          if (!bs) {
            out[py * W + px] = sample((x + half) / GRAIN_TILE_WORLD, (y + half) / GRAIN_TILE_ACROSS)
            continue
          }
          const b = bs[Math.floor((y + half) / PLANK_WIDTH)]
          const u = b.flip ? b.u0 - (x + half) / GRAIN_TILE_WORLD : b.u0 + (x + half) / GRAIN_TILE_WORLD
          const row = deskRow(b.board, b.arched.includes(Math.floor(u)))
          const fy = (y - b.y0) / GRAIN_TILE_ACROSS
          out[py * W + px] = sample(u, b.mirror ? (row + 1) / DESK_PLANKS - fy : row / DESK_PLANKS + fy)
        }
      }
      return out
    }
    const corr = (l: Float32Array, dy: number) => {
      let sa = 0
      let sb = 0
      let saa = 0
      let sbb = 0
      let sab = 0
      let n = 0
      for (let y = 0; y + dy < H; y++) {
        for (let x = 0; x < W; x++) {
          const a = l[y * W + x]
          const b = l[(y + dy) * W + x]
          sa += a
          sb += b
          saa += a * a
          sbb += b * b
          sab += a * b
          n++
        }
      }
      const ma = sa / n
      const mb = sb / n
      return (sab / n - ma * mb) / Math.sqrt((saa / n - ma * ma) * (sbb / n - mb * mb))
    }
    const board = PLANK_WIDTH / UPP
    const tileLag = GRAIN_TILE_ACROSS / PLANK_WIDTH
    /** [correlation one tile across, mean over the other board lags] */
    const lattice = (l: Float32Array): [number, number] => {
      const others = [1, 2, 3, 5, 6].map((k) => corr(l, k * board))
      return [corr(l, tileLag * board), others.reduce((s, v) => s + v, 0) / others.length]
    }
    const [planeTile, planeRest] = lattice(render(null))
    expect(planeTile, 'the plane: a lattice (control)').toBeGreaterThan(0.95)
    expect(planeTile - planeRest, 'the plane: its tile lag stands out (control)').toBeGreaterThan(0.3)
    const [tileC, rest] = lattice(render(boards))
    expect(tileC - rest, 'the boards: the tile lag does not stand out').toBeLessThan(0.15)
    expect(tileC, 'the boards: one tile across is not the same figure').toBeLessThan(0.6)
  })
})
