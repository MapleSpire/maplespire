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

// Generates the 8-Bit Retro theme's embedded 3D assets into
// src/plugins/official/eightbitAssets.ts — pixel-art equirect skies (day for
// the light variant, night for the dark one) + dithered 16×16 floor tiles,
// all deterministic, dependency-free PNGs well under the manifest caps.
//
//   node scripts/gen-eightbit-assets.mjs
//
// Equirect convention (three.js EquirectangularReflectionMapping): image top
// row = zenith (+Y), the horizon sits at the vertical middle, bottom = nadir.
// The skies are authored at 256×128 and rendered with NearestFilter by the
// pixel-snap path in Scene3D, so every texel reads as a crisp sky "pixel".

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ── minimal RGB PNG encoder ───────────────────────────────────────────────────

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})

function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
  return out
}

/** rows: h×w array of '#RRGGBB' strings → PNG buffer (8-bit RGB, filter 0). */
function encodePng(rows) {
  const h = rows.length
  const w = rows[0].length
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3)
    raw[off] = 0 // filter: None
    for (let x = 0; x < w; x++) {
      const hex = rows[y][x]
      raw[off + 1 + x * 3] = parseInt(hex.slice(1, 3), 16)
      raw[off + 2 + x * 3] = parseInt(hex.slice(3, 5), 16)
      raw[off + 3 + x * 3] = parseInt(hex.slice(5, 7), 16)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const dataUri = (png) => `data:image/png;base64,${png.toString('base64')}`

/** Deterministic LCG so re-running the script is byte-identical. */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

// ── skies (256×128 equirect) ──────────────────────────────────────────────────

const SKY_W = 256
const SKY_H = 128

/** Elevation above the horizon (degrees) for an image row: +90 zenith → -90. */
const elevation = (row) => (0.5 - (row + 0.5) / SKY_H) * 180

function fillBands(rows, bands, ground) {
  for (let y = 0; y < SKY_H; y++) {
    const e = elevation(y)
    const color = e >= 0 ? bands.find(([minElev]) => e >= minElev)[1] : ground.find(([minElev]) => e >= minElev)[1]
    rows.push(Array.from({ length: SKY_W }, () => color))
  }
}

/** Classic stepped pixel cloud: a wide base row, narrower rows above,
 * a shaded underside row below. */
function stampCloud(rows, cx, cy, w, shade) {
  const put = (y, x0, x1, c) => {
    if (y < 0 || y >= SKY_H) return
    for (let x = x0; x <= x1; x++) rows[y][(x + SKY_W) % SKY_W] = c
  }
  const half = Math.floor(w / 2)
  put(cy - 2, cx - half + 4, cx + half - 5, '#F8F8FF')
  put(cy - 1, cx - half + 2, cx + half - 2, '#F8F8FF')
  put(cy, cx - half, cx + half, '#F8F8FF')
  put(cy + 1, cx - half + 1, cx + half - 1, shade)
}

function skyDay() {
  const rows = []
  // Muted slate-blue posterized bands (a calm desaturated sky the voxel
  // scatter pops against), zenith → pale horizon; board-gray ground.
  fillBands(
    rows,
    [
      [60, '#46708C'],
      [40, '#5C8AA6'],
      [25, '#7BA6BC'],
      [12, '#9DC2D2'],
      [0, '#C2DCE6'],
    ],
    [
      [-14, '#C4CDD1'],
      [-90, '#B6C1C6'],
    ],
  )
  // pixel sun with a chunky border (theme yellow), high in the east
  const sunX = 174
  const sunY = Math.round(((90 - 58) / 180) * SKY_H)
  for (let y = -4; y <= 4; y++) {
    for (let x = -3; x <= 3; x++) {
      const edge = Math.abs(y) === 4 || Math.abs(x) === 3
      if (Math.abs(y) === 4 && Math.abs(x) === 3) continue // notched corners
      rows[sunY + y][(sunX + x + SKY_W) % SKY_W] = edge ? '#F8B800' : '#F8D820'
    }
  }
  // blocky clouds in the 18–42° band (deterministic scatter)
  const clouds = [
    [18, 36, 18],
    [58, 44, 14],
    [96, 34, 22],
    [138, 42, 12],
    [168, 35, 16],
    [205, 45, 20],
    [238, 37, 14],
  ]
  for (const [cx, cy, w] of clouds) stampCloud(rows, cx, cy, w, '#B4CEDC')
  return rows
}

function skyNight() {
  const rows = []
  // near-black navy bands with a faint horizon glow; darker ground.
  fillBands(
    rows,
    [
      [55, '#08081A'],
      [30, '#10102A'],
      [12, '#181834'],
      [0, '#22224A'],
    ],
    [
      [-14, '#0A0A12'],
      [-90, '#08080E'],
    ],
  )
  // starfield above the horizon (bright / dim / accent-blue texels)
  const rand = rng(0x8b17)
  for (let i = 0; i < 110; i++) {
    const x = Math.floor(rand() * SKY_W)
    const y = Math.floor(rand() * (SKY_H / 2 - 6))
    const r = rand()
    const c = r < 0.6 ? '#8888A0' : r < 0.9 ? '#F8F8FF' : '#3CBCFC'
    rows[y][x] = c
    if (r >= 0.85) rows[y][(x + 1) % SKY_W] = c // a few 2×1 "bright" stars
  }
  // pixel moon with notched corners + crater texels
  const moonX = 184
  const moonY = Math.round(((90 - 55) / 180) * SKY_H)
  for (let y = -4; y <= 4; y++) {
    for (let x = -3; x <= 3; x++) {
      if (Math.abs(y) === 4 && Math.abs(x) === 3) continue
      rows[moonY + y][(moonX + x + SKY_W) % SKY_W] = '#E8E8F0'
    }
  }
  rows[moonY - 1][moonX - 1] = '#C8C8D8'
  rows[moonY + 2][moonX + 1] = '#C8C8D8'
  rows[moonY][moonX + 2] = '#C8C8D8'
  return rows
}

// ── floor tiles (16×16, one repeat per 20-unit grid cell) ─────────────────────

function floorTile(base, dither, light) {
  const rows = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => base))
  const rand = rng(0xe1a7)
  for (let i = 0; i < 14; i++) {
    const x = Math.floor(rand() * 16)
    const y = Math.floor(rand() * 16)
    rows[y][x] = rand() < 0.75 ? dither : light
  }
  return rows
}

// ── emit ──────────────────────────────────────────────────────────────────────

const assets = {
  'sky-day': skyDay(),
  'sky-night': skyNight(),
  // bases echo the derived floorBg for each variant so the tile reads as a
  // subtle dithered board, not a new surface color
  'floor-day': floorTile('#D4DADD', '#C9D0D4', '#DEE4E7'),
  'floor-night': floorTile('#1F1F26', '#262630', '#17171E'),
}

const NAME = {
  'sky-day': 'SKY_DAY_PNG',
  'sky-night': 'SKY_NIGHT_PNG',
  'floor-day': 'FLOOR_DAY_PNG',
  'floor-night': 'FLOOR_NIGHT_PNG',
}

let out = `// SPDX-License-Identifier: AGPL-3.0-or-later
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
 * 8-Bit Retro embedded 3D assets — GENERATED by scripts/gen-eightbit-assets.mjs
 * (deterministic; re-run the script to regenerate, do not hand-edit).
 *
 * Pixel-art equirect skies (256×128: banded NES-blue day / starfield night,
 * horizon at the vertical middle) + dithered 16×16 floor tiles. All data URIs,
 * gated by the same manifest caps as every theme (assetLimits.ts).
 */

`
let total = 0
for (const [id, rows] of Object.entries(assets)) {
  const png = encodePng(rows)
  total += png.length
  console.log(`${id}: ${png.length} bytes`)
  out += `export const ${NAME[id]} =\n  '${dataUri(png)}'\n\n`
}
console.log(`total: ${total} bytes`)

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, '..', 'src', 'plugins', 'official', 'eightbitAssets.ts')
writeFileSync(target, out)
console.log(`wrote ${target}`)
