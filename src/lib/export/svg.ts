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

import type { C4Object, Connection, Group } from '../../types'
import type { SkinConfig } from '../../skins/types'
import { storeCapRy, lightenHex } from '../../canvas/engine/objectBox'
import {
  DESCRIPTION_TO_TYPE_BADGE_GAP,
  TYPE_BADGE_BOTTOM_INSET,
  TYPE_BADGE_HEIGHT,
} from '../../canvas/objectContentLayout'
import { legendSize, legendSvgFragment, type LegendModel } from './legend'
import { objectTypeBadgeLabel } from '../objectTypeBadge'
import { objectShortDescription } from '../objectDescription'
import { resolveTechnologyIconPath } from '../technologies/iconPath'

/**
 * Serialise a diagram to a standalone, product-styled SVG. Pure — geometry
 * (layout-projected objects, group boxes, the engine's exact connection curves)
 * and the resolved light/dark skin come in as data, so this runs in tests too.
 * The node face mirrors CanvasEngine.renderObject's layout recipe (icon at
 * y+22, title at y+38, description from y+54, type badge at the bottom).
 */

export interface SvgConnectionGeom {
  id: string
  segments: Array<{ x0: number; y0: number; cp1x: number; cp1y: number; cp2x: number; cp2y: number; x1: number; y1: number }>
  fromEdge: { x: number; y: number }
  toEdge: { x: number; y: number }
  preTip: { x: number; y: number }
  labelAt: { x: number; y: number } | null
}

export interface SvgScene {
  diagramName: string
  objects: C4Object[]
  connections: Connection[]
  groups: Array<{ group: Group; bounds: { x: number; y: number; width: number; height: number } }>
  connectionGeoms: SvgConnectionGeom[]
  skin: SkinConfig
}

/** Text width in px for a font size/weight — injectable so node tests don't need a canvas. */
export type MeasureFn = (text: string, size: number, weight: number) => number

const heuristicMeasure: MeasureFn = (text, size) => text.length * size * 0.55

/** measureText-backed MeasureFn when a 2D canvas exists (the browser path). */
export function canvasMeasure(fontFamily: string): MeasureFn | null {
  if (typeof document === 'undefined') return null
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  return (text, size, weight) => {
    ctx.font = `${weight} ${size}px ${fontFamily}`
    return ctx.measureText(text).width
  }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const n = (v: number) => +v.toFixed(2)

function wrapText(text: string, maxWidth: number, size: number, measure: MeasureFn): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const candidate = cur ? cur + ' ' + w : w
    if (measure(candidate, size, 400) > maxWidth && cur) {
      lines.push(cur)
      cur = w
    } else cur = candidate
  }
  if (cur) lines.push(cur)
  return lines
}

function truncate(text: string, maxWidth: number, size: number, weight: number, measure: MeasureFn): string {
  if (measure(text, size, weight) <= maxWidth) return text
  let t = text
  while (t.length > 1 && measure(t + '…', size, weight) > maxWidth) t = t.slice(0, -1)
  return t + '…'
}

/** The drum outline the canvas draws for store objects (objectBox.buildCylinderPath). */
function cylinderPathD(x: number, y: number, w: number, h: number, capRy: number): string {
  const rx = w / 2
  const topCy = y + capRy
  const botCy = y + h - capRy
  return [
    `M ${n(x)} ${n(topCy)}`,
    `L ${n(x)} ${n(botCy)}`,
    `A ${n(rx)} ${n(capRy)} 0 0 0 ${n(x + w)} ${n(botCy)}`,
    `L ${n(x + w)} ${n(topCy)}`,
    `A ${n(rx)} ${n(capRy)} 0 0 0 ${n(x)} ${n(topCy)}`,
    'Z',
  ].join(' ')
}

/**
 * The catalog asset a node paints, chosen exactly as CanvasEngine.renderObject +
 * renderTechnologyIcon choose it: only a shape with an `icon` shows technology
 * artwork, and the image comes from its `iconAssignment` for the theme. A bare
 * `icon` with no assignment has no artwork (the canvas draws a letter badge).
 */
export function exportIconPath(o: C4Object, theme: 'light' | 'dark'): string | undefined {
  if (!o.icon) return undefined
  return resolveTechnologyIconPath(theme, o.iconAssignment?.iconLightPath, o.iconAssignment?.iconDarkPath)
}

/** Fetch the asset behind each path and return it as a `data:` URI. Inlined
 * because catalog paths are same-origin (`/icons/light/<hash>.png`): an
 * `<image href>` to them resolves against nothing once the file is opened from
 * disk or another site. A path that cannot be fetched is left out — that node
 * keeps its type glyph rather than carrying a broken image. */
export async function inlineExportIcons(
  paths: Iterable<string>,
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(
    [...new Set(paths)].map(async (path) => {
      if (path.startsWith('data:')) {
        out.set(path, path)
        return
      }
      try {
        const res = await fetchFn(path)
        if (!res.ok) return
        const buf = new Uint8Array(await res.arrayBuffer())
        if (buf.length === 0) return
        const type = (res.headers.get('content-type') ?? '').split(';')[0].trim() || guessImageType(path)
        if (!type.startsWith('image/')) return
        out.set(path, `data:${type};base64,${base64(buf)}`)
      } catch {
        // Unreachable asset (offline, CORS): the node keeps its glyph.
      }
    }),
  )
  return out
}

function guessImageType(path: string): string {
  const ext = path.split(/[?#]/)[0].split('.').pop()?.toLowerCase()
  return ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
}

function base64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

export function renderExportSvg(
  scene: SvgScene,
  opts?: {
    measure?: MeasureFn
    legend?: LegendModel | null
    /** Which appearance of dual-variant artwork to embed. */
    theme?: 'light' | 'dark'
    /** Icon path → embeddable href (see `inlineExportIcons`). A node whose
     * artwork is absent here draws its type glyph. */
    icons?: ReadonlyMap<string, string>
  },
): string {
  const { skin } = scene
  const fontFamily = skin.renderStyle.fontFamily ?? 'Inter, system-ui, sans-serif'
  const measure = opts?.measure ?? canvasMeasure(fontFamily) ?? heuristicMeasure
  const font = (size: number, weight: number, color: string, anchor: 'middle' | 'start' = 'middle') =>
    `font-family="${esc(fontFamily)}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}"`

  // ── Bounds: objects + group boxes + slack for connection labels ──────────────
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const include = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h)
  }
  for (const o of scene.objects) include(o.position.x, o.position.y, o.size.width, o.size.height)
  for (const g of scene.groups) include(g.bounds.x, g.bounds.y, g.bounds.width, g.bounds.height)
  for (const cg of scene.connectionGeoms) {
    for (const s of cg.segments) {
      include(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0))
    }
    if (cg.labelAt) include(cg.labelAt.x - 60, cg.labelAt.y - 14, 120, 28)
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 400; maxY = 300 }
  const pad = 48
  const W = Math.round(maxX - minX + pad * 2)
  let H = Math.round(maxY - minY + pad * 2)
  const tx = (x: number) => n(x - minX + pad)
  const ty = (y: number) => n(y - minY + pad)

  // Embedded legend sits below the content, bottom-left; the page grows for it.
  const legend = opts?.legend && opts.legend.entries.length ? opts.legend : null
  let legendAt: { x: number; y: number } | null = null
  if (legend) {
    legendAt = { x: 16, y: H - 28 }
    H = legendAt.y + legendSize(legend, measure).height + 16
  }

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(scene.diagramName)}">`,
  )
  parts.push(`<rect width="100%" height="100%" fill="${skin.canvas.bg}"/>`)
  if (legend && legendAt) parts.push(legendSvgFragment(legend, skin, legendAt.x, legendAt.y, measure))

  // ── Technology artwork: each distinct asset embedded once, placed by <use> ──
  // 20×20 with a 4px rounded clip, as renderTechnologyIcon draws it.
  const theme = opts?.theme ?? 'light'
  const iconIds = new Map<string, string>()
  const iconDefs: string[] = []
  for (const o of scene.objects) {
    const path = exportIconPath(o, theme)
    const href = path ? opts?.icons?.get(path) : undefined
    if (!path || !href || iconIds.has(path)) continue
    const id = `ms-icon-${iconIds.size}`
    iconIds.set(path, id)
    iconDefs.push(
      `<image id="${id}" width="20" height="20" preserveAspectRatio="xMidYMid meet" clip-path="url(#ms-icon-clip)" href="${esc(href)}"/>`,
    )
  }
  if (iconDefs.length) {
    parts.push(`<defs><clipPath id="ms-icon-clip"><rect width="20" height="20" rx="4"/></clipPath>${iconDefs.join('')}</defs>`)
  }

  // ── Groups (behind everything, same z-order as the canvas) ──────────────────
  for (const { group, bounds: b } of scene.groups) {
    const isParentWrapper = !!group.parentObjectId
    const fill = isParentWrapper ? skin.groups.parentWrapperFill : (group.color || skin.groups.parentWrapperFill)
    const fillOpacity = isParentWrapper ? 1 : group.fillTransparent ? 0 : group.fillOpacity ?? skin.groups.standardFillAlpha
    const stroke = group.borderColor || group.color || skin.groups.label
    parts.push(
      `<rect x="${tx(b.x)}" y="${ty(b.y)}" width="${n(b.width)}" height="${n(b.height)}" rx="12" fill="${fill}" fill-opacity="${n(fillOpacity)}" stroke="${stroke}" stroke-opacity="${n(skin.groups.standardStrokeAlpha)}" stroke-width="1.5"${isParentWrapper ? '' : ' stroke-dasharray="6 4"'}/>`,
    )
    if (isParentWrapper) {
      // Centered identity stack in the reserved header band (title → type → description).
      const cx = tx(b.x + b.width / 2)
      let top = b.y + 24
      parts.push(`<text x="${cx}" y="${ty(top + 12)}" ${font(14, 600, skin.groups.label)}>${esc(group.name)}</text>`)
      top += 18
      if (group.type) {
        top += 4
        parts.push(`<text x="${cx}" y="${ty(top + 8.5)}" ${font(10, 400, skin.groups.typeLabel)}>${esc(group.type)}</text>`)
        top += 13
      }
      if (group.description) {
        top += 6
        parts.push(`<text x="${cx}" y="${ty(top + 10)}" ${font(12, 400, skin.groups.description)}>${esc(group.description)}</text>`)
      }
    } else {
      parts.push(
        `<text x="${n(tx(b.x) + 12)}" y="${ty(b.y + 26)}" ${font(11, 600, skin.groups.label, 'start')} fill-opacity="${n(skin.groups.labelAlpha)}">${esc(group.name)}</text>`,
      )
    }
  }

  // ── Connections: the engine's exact cubic segments ───────────────────────────
  const connById = new Map(scene.connections.map((c) => [c.id, c]))
  for (const cg of scene.connectionGeoms) {
    const conn = connById.get(cg.id)
    if (!conn || cg.segments.length === 0) continue
    const color = conn.kind === 'lower' ? skin.connections.lower : skin.connections.normal
    const dash = conn.type === 'dashed' ? ' stroke-dasharray="6 4"' : conn.type === 'dotted' ? ' stroke-dasharray="2 3"' : ''
    const first = cg.segments[0]
    const d =
      `M ${tx(first.x0)} ${ty(first.y0)} ` +
      cg.segments.map((s) => `C ${tx(s.cp1x)} ${ty(s.cp1y)} ${tx(s.cp2x)} ${ty(s.cp2y)} ${tx(s.x1)} ${ty(s.y1)}`).join(' ')
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${skin.connections.strokeWidth}"${dash}/>`)

    // Arrowhead oriented by the approach direction (preTip → tip).
    const angle = Math.atan2(cg.toEdge.y - cg.preTip.y, cg.toEdge.x - cg.preTip.x)
    const aLen = 9
    const aHalf = 3.5
    const tipX = cg.toEdge.x, tipY = cg.toEdge.y
    const bx = tipX - aLen * Math.cos(angle), by = tipY - aLen * Math.sin(angle)
    const p1x = bx + aHalf * Math.sin(angle), p1y = by - aHalf * Math.cos(angle)
    const p2x = bx - aHalf * Math.sin(angle), p2y = by + aHalf * Math.cos(angle)
    parts.push(
      `<path d="M ${tx(tipX)} ${ty(tipY)} L ${tx(p1x)} ${ty(p1y)} L ${tx(p2x)} ${ty(p2y)} Z" fill="${color}"/>`,
    )
    // Always-on source-anchor dot.
    parts.push(`<circle cx="${tx(cg.fromEdge.x)}" cy="${ty(cg.fromEdge.y)}" r="3.5" fill="${color}"/>`)

    if (conn.label && cg.labelAt) {
      const lines = conn.label.split('\n')
      const lineH = 12
      const padX = 8, padY = 4
      const textW = Math.max(...lines.map((l) => measure(l, 10, 400)))
      const w = textW + padX * 2
      const h = lines.length * lineH + padY * 2
      const lx = cg.labelAt.x - w / 2
      const lyTop = cg.labelAt.y - h / 2
      parts.push(
        `<rect x="${tx(lx)}" y="${ty(lyTop)}" width="${n(w)}" height="${n(h)}" rx="4" fill="${skin.connections.labelBg}" stroke="${skin.connections.labelStroke}"/>`,
      )
      lines.forEach((line, i) => {
        parts.push(
          `<text x="${tx(cg.labelAt!.x)}" y="${ty(lyTop + padY + lineH / 2 + i * lineH + 3.5)}" ${font(10, 400, skin.connections.labelText)}>${esc(line)}</text>`,
        )
      })
    }
  }

  // ── Nodes (CanvasEngine.renderObject's layout recipe) ────────────────────────
  for (const o of scene.objects) {
    const objSkin = skin.objects[o.type]
    if (!objSkin) continue
    const { x, y } = o.position
    const w = o.size.width, h = o.size.height
    const isExternal = o.scope === 'external'
    const fill = isExternal ? objSkin.fillExternal : objSkin.fill
    const textColor = isExternal ? objSkin.textExternal : objSkin.text
    const alpha = isExternal && !skin.renderStyle.solidExternal ? 0.55 : 1
    const isStore = o.type === 'store'

    parts.push(`<g${alpha < 1 ? ` opacity="${alpha}"` : ''}>`)
    if (isStore) {
      const capRy = storeCapRy(w, h)
      parts.push(
        `<path d="${cylinderPathD(x - minX + pad, y - minY + pad, w, h, capRy)}" fill="${fill}" stroke="${objSkin.stroke}" stroke-width="${objSkin.strokeWidth}"/>`,
      )
      const rx = w / 2
      const lidFill = isExternal ? undefined : lightenHex(objSkin.fill, 0.25)
      if (lidFill) {
        parts.push(
          `<ellipse cx="${tx(x + rx)}" cy="${ty(y + capRy)}" rx="${n(rx)}" ry="${n(capRy)}" fill="${lidFill}"/>`,
        )
      }
      parts.push(
        `<path d="M ${tx(x)} ${ty(y + capRy)} A ${n(rx)} ${n(capRy)} 0 0 0 ${tx(x + w)} ${ty(y + capRy)}" fill="none" stroke="${isExternal ? objSkin.cylinderLineExternal : objSkin.cylinderLine}" stroke-width="1"/>`,
      )
    } else {
      parts.push(
        `<rect x="${tx(x)}" y="${ty(y)}" width="${n(w)}" height="${n(h)}" rx="${objSkin.cornerRadius}" fill="${fill}" stroke="${objSkin.stroke}" stroke-width="${objSkin.strokeWidth}"/>`,
      )
    }

    // Icon: the technology logo when the shape has one (stores included, as on
    // the canvas), else the glyph whose shape carries the type.
    const iconColor = isExternal ? objSkin.iconExternal : objSkin.icon
    const cx = x + w / 2
    const iconY = y + 22
    const artworkPath = exportIconPath(o, theme)
    const iconId = artworkPath ? iconIds.get(artworkPath) : undefined
    if (iconId) {
      // Lifted 1px like the canvas: logos sit visually low against the title.
      parts.push(`<use href="#${iconId}" x="${n(tx(cx) - 10)}" y="${n(ty(iconY - 1) - 10)}"/>`)
    } else if (!isStore) {
      if (o.type === 'actor') {
        parts.push(`<circle cx="${tx(cx)}" cy="${ty(iconY - 4)}" r="5" fill="${iconColor}"/>`)
        parts.push(
          `<path d="M ${tx(cx - 8)} ${ty(iconY + 6)} A 8 8 0 0 1 ${tx(cx + 8)} ${ty(iconY + 6)} Z" fill="${iconColor}"/>`,
        )
      } else {
        const letter = o.type === 'system' ? 'S' : o.type === 'app' ? 'A' : 'C'
        parts.push(`<circle cx="${tx(cx)}" cy="${ty(iconY)}" r="10" fill="${iconColor}"/>`)
        parts.push(`<text x="${tx(cx)}" y="${ty(iconY + 3.5)}" ${font(10, 700, skin.connections.labelBg)}>${letter}</text>`)
      }
    }

    // Title (fitted then truncated, weight 600, top-anchored at y+38).
    const textMaxWidth = w - 16
    const titleBase = skin.renderStyle.titleSize?.base ?? 13
    const titleMin = skin.renderStyle.titleSize?.min ?? 9
    let titleSize = titleBase
    while (titleSize > titleMin && measure(o.name, titleSize, 600) > textMaxWidth) titleSize -= 0.5
    const title = truncate(o.name, textMaxWidth, titleSize, 600, measure)
    parts.push(`<text x="${tx(cx)}" y="${ty(y + 38 + titleSize * 0.8)}" ${font(titleSize, 600, textColor)}>${esc(title)}</text>`)

    // Description — the canvas's vertical fit: try 11px down to 9px until the
    // wrapped block fits above the badge, else truncate to the lines that do.
    const badgeY = y + h - TYPE_BADGE_HEIGHT - TYPE_BADGE_BOTTOM_INSET
    const descriptionTopY = y + 54
    const available = Math.max(0, badgeY - DESCRIPTION_TO_TYPE_BADGE_GAP - descriptionTopY)
    const description = objectShortDescription(o)
    if (description && available >= 9) {
      const descColor = isExternal ? objSkin.descriptionExternal : objSkin.description
      let descSize = 9
      let lines: string[] | null = null
      for (let size = 11; size >= 9; size -= 0.5) {
        const test = wrapText(description, textMaxWidth, size, measure)
        if (test.length * size * 1.15 <= available) {
          descSize = size
          lines = test
          break
        }
      }
      if (!lines) {
        lines = wrapText(description, textMaxWidth, descSize, measure)
        const maxLines = Math.max(1, Math.floor(available / (descSize * 1.15)))
        if (lines.length > maxLines) {
          lines = lines.slice(0, maxLines)
          lines[lines.length - 1] = truncate(lines[lines.length - 1] + '…', textMaxWidth, descSize, 400, measure)
        }
      }
      const lineH = descSize * 1.15
      lines.forEach((line, i) => {
        parts.push(
          `<text x="${tx(cx)}" y="${ty(y + 54 + i * lineH + descSize * 0.8)}" ${font(descSize, 400, descColor)}>${esc(line)}</text>`,
        )
      })
    }

    // Localised shape-type badge, bottom-centered and independent of technology.
    const badgeText = objectTypeBadgeLabel(o.type)
    const badgeW = Math.min(w - 16, measure(badgeText, 9, 500) + 12)
    const badgeX = cx - badgeW / 2
    parts.push(
      `<rect x="${tx(badgeX)}" y="${ty(badgeY)}" width="${n(badgeW)}" height="${TYPE_BADGE_HEIGHT}" rx="4" fill="${objSkin.badgeBg}"/>`,
    )
    parts.push(
      `<text x="${tx(cx)}" y="${ty(badgeY + TYPE_BADGE_HEIGHT / 2 + 3)}" ${font(9, 500, objSkin.badgeText)}>${esc(badgeText)}</text>`,
    )
    parts.push('</g>')
  }

  parts.push('</svg>')
  return parts.join('\n')
}
