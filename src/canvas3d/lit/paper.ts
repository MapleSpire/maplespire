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

/**
 * The lit board's "drafting paper" surface (Studio flagship): a tileable
 * CanvasTexture pair — warm paper base with graph-grid hairlines for the color
 * map, and a subtle tooth-noise roughness map so the key light reads as paper,
 * not plastic. Procedural on purpose: zero asset bytes, crisp at any board
 * size, and regenerated per palette (cached by key).
 *
 * The tile spans TILE_CELLS grid cells at the engine's 20-unit dot pitch; the
 * caller sets `repeat` so world-space pitch stays exact:
 *   repeat = slabSize / (PITCH * TILE_CELLS)
 */

export const PAPER_PITCH = 20
export const PAPER_TILE_CELLS = 5
/** px per grid cell in the tile bitmap (crisp hairlines at DPR 2). */
const CELL_PX = 64
const TILE_PX = CELL_PX * PAPER_TILE_CELLS

export interface PaperBoardTextures {
  map: THREE.CanvasTexture
  roughnessMap: THREE.CanvasTexture
}

interface PaperSpec {
  /** Paper base color (css). */
  base: string
  /** Hairline grid color (css) — ignored when showGrid is false. */
  grid: string
  /** Draw the graph grid? (the board's grid toggle swaps textures). */
  showGrid: boolean
  /** Deterministic seed for the tooth noise. */
  seed?: number
}

const cache = new Map<string, PaperBoardTextures>()

/** Deterministic LCG so the paper tooth is identical across rebuilds. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

export function paperBoardTextures(spec: PaperSpec): PaperBoardTextures {
  const key = `${spec.base}|${spec.grid}|${spec.showGrid}|${spec.seed ?? 1}`
  const hit = cache.get(key)
  if (hit) return hit

  const rnd = lcg(spec.seed ?? 0x9e3779b9)

  // ── color map: paper base + tooth speckle + graph hairlines ──
  const canvas = document.createElement('canvas')
  canvas.width = TILE_PX
  canvas.height = TILE_PX
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = spec.base
  ctx.fillRect(0, 0, TILE_PX, TILE_PX)

  // paper tooth: sparse, very low-contrast speckle (both lighter and darker)
  const speckles = 2600
  for (let i = 0; i < speckles; i++) {
    const x = rnd() * TILE_PX
    const y = rnd() * TILE_PX
    const a = 0.015 + rnd() * 0.03
    ctx.fillStyle = rnd() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`
    ctx.fillRect(x, y, 1 + rnd() * 1.4, 1 + rnd() * 1.4)
  }

  if (spec.showGrid) {
    ctx.strokeStyle = spec.grid
    // minor hairlines at every cell — strong enough to read as drafting
    // paper at the design framing (mipmapping eats faint 1px lines fast)
    ctx.globalAlpha = 0.9
    ctx.lineWidth = 1.8
    for (let c = 0; c < PAPER_TILE_CELLS; c++) {
      const p = c * CELL_PX + 0.5
      ctx.beginPath()
      ctx.moveTo(p, 0)
      ctx.lineTo(p, TILE_PX)
      ctx.moveTo(0, p)
      ctx.lineTo(TILE_PX, p)
      ctx.stroke()
    }
    // one major line per tile (every PAPER_TILE_CELLS cells = 100 world units)
    ctx.globalAlpha = 1
    ctx.lineWidth = 2.6
    ctx.beginPath()
    ctx.moveTo(1.1, 0)
    ctx.lineTo(1.1, TILE_PX)
    ctx.moveTo(0, 1.1)
    ctx.lineTo(TILE_PX, 1.1)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // ── roughness map: high-frequency tooth around a matte base ──
  const rCanvas = document.createElement('canvas')
  rCanvas.width = TILE_PX
  rCanvas.height = TILE_PX
  const rCtx = rCanvas.getContext('2d')!
  // base roughness ~0.9 encoded as luminance
  rCtx.fillStyle = 'rgb(230,230,230)'
  rCtx.fillRect(0, 0, TILE_PX, TILE_PX)
  const grains = 4200
  for (let i = 0; i < grains; i++) {
    const x = rnd() * TILE_PX
    const y = rnd() * TILE_PX
    const v = 205 + Math.floor(rnd() * 50) // 0.80..1.0 roughness band
    rCtx.fillStyle = `rgb(${v},${v},${v})`
    rCtx.fillRect(x, y, 1 + rnd(), 1 + rnd())
  }

  const mk = (c: HTMLCanvasElement, srgb: boolean) => {
    const tex = new THREE.CanvasTexture(c)
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 16
    tex.generateMipmaps = true
    tex.minFilter = THREE.LinearMipmapLinearFilter
    // ExtrudeGeometry UVs are raw shape coordinates (world px) — a FIXED
    // repeat maps one tile onto exactly PITCH*TILE_CELLS world units on any
    // board size, so the cached textures are safely shared across scenes.
    tex.repeat.setScalar(1 / (PAPER_PITCH * PAPER_TILE_CELLS))
    return tex
  }
  const out = { map: mk(canvas, true), roughnessMap: mk(rCanvas, false) }
  cache.set(key, out)
  return out
}

/** Drop every cached paper texture (theme flips / scene dispose). */
export function disposePaperTextures(): void {
  for (const [, t] of cache) {
    t.map.dispose()
    t.roughnessMap.dispose()
  }
  cache.clear()
}
