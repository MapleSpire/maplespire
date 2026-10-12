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
 * The WORKBENCH the maquette sits on (lit profile): a warm wood desk texture
 * pair. Unlike the paper (a small repeated tile), this is ONE 2048 canvas
 * stretched across the whole desk plane (repeat 1) so a radial VIGNETTE can
 * bake in — the desk darkens away from the board and the maquette owns the
 * light (a tabletop falloff). A flat plane reads as a caramel void at wide
 * framing.
 *
 * Procedural + deterministic (LCG), cached by (base, seed).
 */

const TILE_PX = 2048

export interface WorkbenchTextures {
  map: THREE.CanvasTexture
  roughnessMap: THREE.CanvasTexture
}

const cache = new Map<string, WorkbenchTextures>()

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

export function workbenchTextures(base: string, seed = 0x5eed0b0a): WorkbenchTextures {
  const key = `${base}|${seed}`
  const hit = cache.get(key)
  if (hit) return hit

  const rnd = lcg(seed)

  // ── color map: wood base + long grain streaks + plank seams + vignette ──
  const canvas = document.createElement('canvas')
  canvas.width = TILE_PX
  canvas.height = TILE_PX
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = base
  ctx.fillRect(0, 0, TILE_PX, TILE_PX)

  // long horizontal grain: wavy low-alpha streaks, darker and lighter
  const streaks = 150
  for (let i = 0; i < streaks; i++) {
    const y0 = rnd() * TILE_PX
    const amp = 2 + rnd() * 7
    const wl = 300 + rnd() * 700
    const phase = rnd() * Math.PI * 2
    const width = 1.5 + rnd() * 4.5
    const dark = rnd() < 0.62
    const a = 0.03 + rnd() * 0.055
    ctx.strokeStyle = dark ? `rgba(94,66,40,${a})` : `rgba(238,214,178,${a * 0.85})`
    ctx.lineWidth = width
    ctx.beginPath()
    for (let x = 0; x <= TILE_PX; x += 24) {
      const y = y0 + Math.sin(phase + (x / wl) * Math.PI * 2) * amp
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  // a few plank seams — very subtle scale cue
  const seams = 5
  for (let i = 1; i <= seams; i++) {
    const y = (TILE_PX / (seams + 1)) * i + (rnd() - 0.5) * 60
    ctx.strokeStyle = 'rgba(74,52,32,0.10)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(TILE_PX, y)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(244,226,196,0.05)'
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(0, y + 2)
    ctx.lineTo(TILE_PX, y + 2)
    ctx.stroke()
  }

  // radial vignette centered on the board (the plane is board-centered):
  // clear middle, darker rim — the desk recedes, the maquette owns the
  // light. Radii are fractions of the WHOLE desk plane (≥6000 units), so a
  // ramp starting much past the board would begin outside the default crop:
  // this ramp starts just outside the board footprint (~0.09) and reaches full depth by half the
  // desk, putting a visible gradient inside every framing.
  const g = ctx.createRadialGradient(
    TILE_PX / 2,
    TILE_PX / 2,
    TILE_PX * 0.09,
    TILE_PX / 2,
    TILE_PX / 2,
    TILE_PX * 0.5,
  )
  g.addColorStop(0, 'rgba(46,30,16,0)')
  g.addColorStop(0.5, 'rgba(46,30,16,0.22)')
  g.addColorStop(1, 'rgba(38,24,12,0.55)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, TILE_PX, TILE_PX)

  // ── roughness map: matte base, streak-correlated variation, matter rim ──
  const rCanvas = document.createElement('canvas')
  rCanvas.width = TILE_PX
  rCanvas.height = TILE_PX
  const rCtx = rCanvas.getContext('2d')!
  rCtx.fillStyle = 'rgb(238,238,238)' // ~0.93 of the material roughness
  rCtx.fillRect(0, 0, TILE_PX, TILE_PX)
  const rRnd = lcg(seed ^ 0x9e3779b9)
  for (let i = 0; i < 120; i++) {
    const y0 = rRnd() * TILE_PX
    const v = 222 + Math.floor(rRnd() * 33) // subtle satin bands
    rCtx.strokeStyle = `rgba(${v},${v},${v},0.5)`
    rCtx.lineWidth = 2 + rRnd() * 6
    rCtx.beginPath()
    rCtx.moveTo(0, y0)
    rCtx.lineTo(TILE_PX, y0 + (rRnd() - 0.5) * 30)
    rCtx.stroke()
  }

  const mk = (c: HTMLCanvasElement, srgb: boolean) => {
    const tex = new THREE.CanvasTexture(c)
    // ONE stretch across the plane — no repeat, the vignette must not tile
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 8
    tex.generateMipmaps = true
    tex.minFilter = THREE.LinearMipmapLinearFilter
    return tex
  }
  const out = { map: mk(canvas, true), roughnessMap: mk(rCanvas, false) }
  cache.set(key, out)
  return out
}

/** Drop every cached workbench texture (theme flips / scene dispose). */
export function disposeWorkbenchTextures(): void {
  for (const [, t] of cache) {
    t.map.dispose()
    t.roughnessMap.dispose()
  }
  cache.clear()
}
