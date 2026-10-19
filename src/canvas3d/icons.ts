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
 * Type-glyph textures for the 3D board — the design system's lucide icons
 * (C4Node type tile / drum decal), rasterized once per (icon, color) at high
 * resolution into canvas textures. Icons are inherently images; rasterizing
 * them into mipmapped textures is standard 3D practice (this is NOT the
 * forbidden "draw the whole card in 2D" shortcut — geometry and text stay
 * native).
 *
 * Path data inlined from lucide-react v1.16.0 (ISC — the app already ships it);
 * kept in the icon's 24-unit viewBox and stroked exactly like the DS `Icon`
 * component (strokeWidth 1.7, round caps/joins, no fill).
 */

import * as THREE from 'three'
import type { C4Type, ShapeIconAssignment } from '../types'
import { resolveTechnologyIconPath } from '../lib/technologies/iconPath'
import { catalogIconArtwork, loadIconCatalog, shapeIconArtwork } from '../lib/technologies/shapeIconArtwork'
import { containIconRect } from '../lib/technologies/iconFit'

type IconElement =
  | { k: 'path'; d: string }
  | { k: 'circle'; cx: number; cy: number; r: number }
  | { k: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { k: 'rect'; x: number; y: number; w: number; h: number; rx: number }
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number }

/** lucide v1.16.0 icon nodes (subset the C4 palette uses). */
const ICONS: Record<string, IconElement[]> = {
  // actor
  user: [
    { k: 'path', d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' },
    { k: 'circle', cx: 12, cy: 7, r: 4 },
  ],
  // system
  monitor: [
    { k: 'rect', x: 2, y: 3, w: 20, h: 14, rx: 2 },
    { k: 'line', x1: 8, y1: 21, x2: 16, y2: 21 },
    { k: 'line', x1: 12, y1: 17, x2: 12, y2: 21 },
  ],
  // app
  box: [
    { k: 'path', d: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z' },
    { k: 'path', d: 'm3.3 7 8.7 5 8.7-5' },
    { k: 'path', d: 'M12 22V12' },
  ],
  // store
  database: [
    { k: 'ellipse', cx: 12, cy: 5, rx: 9, ry: 3 },
    { k: 'path', d: 'M3 5V19A9 3 0 0 0 21 19V5' },
    { k: 'path', d: 'M3 12A9 3 0 0 0 21 12' },
  ],
  // component
  puzzle: [
    { k: 'path', d: 'M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z' },
  ],
  // expand affordance (Model Viewer drill — the 2D tile's Expand button)
  expand: [
    { k: 'path', d: 'm15 15 6 6' },
    { k: 'path', d: 'm15 9 6-6' },
    { k: 'path', d: 'M21 16v5h-5' },
    { k: 'path', d: 'M21 8V3h-5' },
    { k: 'path', d: 'M3 16v5h5' },
    { k: 'path', d: 'm3 21 6-6' },
    { k: 'path', d: 'M3 8V3h5' },
    { k: 'path', d: 'M9 9 3 3' },
  ],
  // group
  layers: [
    { k: 'path', d: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z' },
    { k: 'path', d: 'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12' },
    { k: 'path', d: 'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17' },
  ],
}

/** DS TYPE_ICON map (C4Node.jsx). */
export const TYPE_GLYPH: Record<C4Type, keyof typeof ICONS> = {
  actor: 'user',
  system: 'monitor',
  app: 'box',
  store: 'database',
  component: 'puzzle',
} as Record<C4Type, keyof typeof ICONS>

const TEXTURE_SCALE = 8 // 24-unit viewBox × 8 = 192px texture: crisp at tile size

const textureCache = new Map<string, THREE.CanvasTexture>()

/** Rasterize a lucide glyph in `color` → mipmapped CanvasTexture (cached). */
export function iconTexture(name: string, color: string): THREE.CanvasTexture | null {
  const icon = ICONS[name]
  if (!icon) return null
  const key = `${name}|${color}`
  const cached = textureCache.get(key)
  if (cached) return cached

  const size = 24 * TEXTURE_SCALE
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(TEXTURE_SCALE, TEXTURE_SCALE)
  ctx.strokeStyle = color
  ctx.lineWidth = 1.7
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const el of icon) {
    ctx.beginPath()
    switch (el.k) {
      case 'path':
        ctx.stroke(new Path2D(el.d))
        continue
      case 'circle':
        ctx.arc(el.cx, el.cy, el.r, 0, Math.PI * 2)
        break
      case 'ellipse':
        ctx.ellipse(el.cx, el.cy, el.rx, el.ry, 0, 0, Math.PI * 2)
        break
      case 'rect': {
        ctx.roundRect(el.x, el.y, el.w, el.h, el.rx)
        break
      }
      case 'line':
        ctx.moveTo(el.x1, el.y1)
        ctx.lineTo(el.x2, el.y2)
        break
    }
    ctx.stroke()
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  textureCache.set(key, tex)
  return tex
}

// ── technology icons (obj.icon / group.icon — the 2D renderTechnologyIcon) ──

const TECH_TEX_SIZE = 128

const techTextureCache = new Map<string, THREE.CanvasTexture>()

/**
 * Texture for a technology icon by registry name — the 3D twin of the 2D
 * engine's renderTechnologyIcon: starts as the generated badge (rounded bg +
 * abbr, the offline/broken-image look), then repaints itself with the actual
 * logo (rounded-clipped, like the 2D 4px-radius clip) when the image loads.
 * `onReady` fires after the swap so the scene can request a render.
 * Artwork follows the 2D rule (shapeIconArtwork): the iconAssignment, else
 * the catalog entry named by a bare `icon`.
 */
export function techIconTexture(
  shape: { icon?: string; iconAssignment?: ShapeIconAssignment },
  onReady?: () => void,
  resolvedTheme: 'light' | 'dark' = 'light',
): THREE.CanvasTexture | null {
  const iconName = shape.iconAssignment?.displayName ?? shape.icon ?? ''
  const artwork = shapeIconArtwork(shape)
  const iconLightPath = artwork?.iconLightPath
  const iconDarkPath = artwork?.iconDarkPath
  const config = {
    bg: '#6B665E',
    text: '#FFFFFF',
    abbr: iconName.length <= 2 ? iconName.toUpperCase() : iconName.slice(0, 1).toUpperCase(),
  }
  if (!iconName) return null
  const cacheKey = `${resolvedTheme}:${iconName}:${iconLightPath ?? ''}:${iconDarkPath ?? ''}`
  const cached = techTextureCache.get(cacheKey)
  if (cached) return cached

  const size = TECH_TEX_SIZE
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // fallback badge (2D: bg rounded r5@20px, bold abbr)
  ctx.fillStyle = config.bg
  ctx.beginPath()
  ctx.roundRect(0, 0, size, size, size * 0.25)
  ctx.fill()
  ctx.fillStyle = config.text
  ctx.font = `700 ${config.abbr.length > 1 ? size * 0.4 : size * 0.5}px Inter, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(config.abbr, size / 2, size / 2 + size * 0.02)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  techTextureCache.set(cacheKey, tex)

  const paint = (url: string) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      ctx.clearRect(0, 0, size, size)
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(0, 0, size, size, size * 0.2) // the 2D 4px@20px clip, scaled
      ctx.clip()
      // Aspect-fit, as the 2D renderTechnologyIcon: never stretch a wide logo.
      const fit = containIconRect(img.naturalWidth, img.naturalHeight, 0, 0, size)
      ctx.drawImage(img, fit.x, fit.y, fit.width, fit.height)
      ctx.restore()
      tex.needsUpdate = true
      onReady?.()
    }
    img.src = url // onerror: the badge stays — 2D behaves the same
  }
  const url = resolveTechnologyIconPath(resolvedTheme, artwork?.iconLightPath, artwork?.iconDarkPath)
  if (url) {
    paint(url)
  } else if (!shape.iconAssignment) {
    // A bare catalog name whose catalog chunk has not loaded yet: repaint this
    // same texture once it has (a name truly absent keeps its letter badge).
    void loadIconCatalog().then(() => {
      const resolved = catalogIconArtwork(iconName)
      const late = resolveTechnologyIconPath(resolvedTheme, resolved?.iconLightPath, resolved?.iconDarkPath)
      if (late) paint(late)
    }, () => {})
  }
  return tex
}

/** Dispose every cached icon texture (scene teardown). */
export function disposeIconTextures(): void {
  for (const tex of textureCache.values()) tex.dispose()
  textureCache.clear()
  for (const tex of techTextureCache.values()) tex.dispose()
  techTextureCache.clear()
}
