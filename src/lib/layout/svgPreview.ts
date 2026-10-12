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

// Render a laid-out diagram to a standalone SVG — used to rasterize PNGs for the
// vision QA loop. It draws from `measureDiagram`'s FAITHFUL edge geometry (the same
// curves + per-diagram routing the metrics score and the canvas would draw) AND it
// mirrors CanvasEngine's group rendering exactly — so what the vision model grades
// matches what the user actually sees on the canvas:
//   • imported groups have autoSize:false (see structurizr/mapper.ts), so the canvas
//     draws the layout's STORED box (diagram.layouts[gid]) verbatim — we render that
//     exact box, so the QA PNG reproduces the real reserved bands;
//   • parent-wrapper (boundary) groups draw a CENTERED identity stack (title → type →
//     description) in the reserved top header band, with a slim footer below the lowest
//     member — exactly as CanvasEngine.groupHeaderBandHeight reserves it;
//   • every connection draws its always-on source-anchor dot (the "dots" users see).

import type { C4Object, Connection, Diagram, Group } from '../../types'
import { measureDiagram, type LayoutContext } from './index'
import { groupHeaderBandHeight, GROUP_FOOTER_PAD, GROUP_STD_PAD_TOP } from './metrics'

const TYPE_STYLE: Record<string, { fill: string; text: string }> = {
  actor: { fill: '#64748B', text: '#FFFFFF' },
  system: { fill: '#1168BD', text: '#FFFFFF' },
  app: { fill: '#438DD5', text: '#FFFFFF' },
  store: { fill: '#8B5CF6', text: '#FFFFFF' },
  component: { fill: '#85BBF0', text: '#0B2545' },
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Rough px width of a string at a given font size (Segoe UI ≈ 0.55em/char average).
// Used only to position overflow markers; the actual <text> never clips so true
// overflow always renders past the box edge regardless of this estimate.
const textWidth = (s: string, size: number) => s.length * size * 0.55

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) {
      if (cur) lines.push(cur)
      cur = w
    } else cur = (cur + ' ' + w).trim()
  }
  if (cur) lines.push(cur)
  return lines.slice(0, 3)
}

/**
 * The box the canvas actually draws for an imported group. Imported groups carry
 * autoSize:false, so CanvasEngine.getGroupBounds returns the explicit position/size
 * — which CanvasView projects from diagram.layouts[gid]. So the faithful box is the
 * stored layout box. Fall back to a member-bbox recompute only if no layout exists.
 */
function groupBounds(
  group: Group,
  stored: { position: { x: number; y: number }; size: { width: number; height: number } } | undefined,
  memberRects: Array<{ x: number; y: number; width: number; height: number }>,
): { x: number; y: number; width: number; height: number } | null {
  if (stored) {
    return { x: stored.position.x, y: stored.position.y, width: stored.size.width, height: stored.size.height }
  }
  if (memberRects.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const m of memberRects) {
    minX = Math.min(minX, m.x)
    minY = Math.min(minY, m.y)
    maxX = Math.max(maxX, m.x + m.width)
    maxY = Math.max(maxY, m.y + m.height)
  }
  const padding = 30
  // Parent wrappers reserve the per-group centered-header band on top + slim footer; standard
  // groups reserve GROUP_STD_PAD_TOP on top (icon + title row) and GROUP_PAD on the other sides.
  // (Mirrors CanvasEngine.getGroupBounds.)
  const topPadding = group.parentObjectId ? groupHeaderBandHeight(group) : GROUP_STD_PAD_TOP
  const bottomPadding = group.parentObjectId ? GROUP_FOOTER_PAD : padding
  return {
    x: minX - padding,
    y: minY - topPadding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + topPadding + bottomPadding,
  }
}

export function renderDiagramSVG(
  diagram: Diagram,
  objects: C4Object[],
  connections: Connection[],
  groups: Group[],
): string {
  const ctx: LayoutContext = { objects, connections, groups }
  const objById = new Map(objects.map((o) => [o.id, o]))
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const { rects, edges } = measureDiagram(diagram, ctx)
  const rectById = new Map(rects.map((r) => [r.id, r]))

  // Group boxes — the stored layout box the canvas draws verbatim (autoSize:false),
  // so overflow + masking render exactly as on screen.
  const groupBoxById = new Map<string, { x: number; y: number; width: number; height: number }>()
  for (const gid of diagram.groupIds) {
    const g = groupById.get(gid)
    if (!g) continue
    const memberRects = g.objectIds
      .map((id) => rectById.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
    const b = groupBounds(g, diagram.layouts?.[gid], memberRects)
    if (b) groupBoxById.set(gid, b)
  }

  // Bounds (objects + recomputed group boxes).
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const include = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h)
  }
  for (const r of rects) include(r.x, r.y, r.width, r.height)
  for (const b of groupBoxById.values()) include(b.x, b.y, b.width, b.height)
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 200; maxY = 200 }
  // Extra left/right margin so overflowing group titles aren't clipped by the viewport.
  const pad = 48
  const W = Math.round(maxX - minX + pad * 2)
  const H = Math.round(maxY - minY + pad * 2)
  const tx = (x: number) => +(x - minX + pad).toFixed(1)
  const ty = (y: number) => +(y - minY + pad).toFixed(1)

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, system-ui, sans-serif">`)
  parts.push(`<rect width="100%" height="100%" fill="#FFFFFF"/>`)
  parts.push(`<defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3 L0,6 Z" fill="#64748B"/></marker></defs>`)
  parts.push(`<text x="${pad}" y="22" font-size="14" font-weight="600" fill="#0F172A">${esc(diagram.name)} · ${diagram.type}</text>`)

  // Group boxes (drawn first, behind nodes — same z-order as the canvas).
  for (const gid of diagram.groupIds) {
    const b = groupBoxById.get(gid)
    const g = groupById.get(gid)
    if (!b || !g) continue
    const isParentWrapper = !!g.parentObjectId
    const fill = isParentWrapper ? '#EEF2FF' : (g.color || '#F1F5F9')
    parts.push(`<rect x="${tx(b.x)}" y="${ty(b.y)}" width="${Math.round(b.width)}" height="${Math.round(b.height)}" rx="12" fill="${fill}" fill-opacity="${isParentWrapper ? 0.55 : 0.30}" stroke="#94A3B8" stroke-dasharray="${isParentWrapper ? '0' : '6 4'}" stroke-width="1.5"/>`)

    if (isParentWrapper) {
      // Centered identity stack (title → type → description) in the reserved top header
      // band, mirroring CanvasEngine's group header. (No icon row — the QA SVG draws no
      // icons; the canvas shrinks/ellipsizes overflow so we don't mark it here.)
      const cx = tx(b.x + b.width / 2)
      let top = b.y + 24 // HDR_TOP_INSET (world coords)
      parts.push(`<text x="${cx}" y="${ty(top) + 14}" font-size="14" font-weight="600" fill="#334155" text-anchor="middle">${esc(g.name)}</text>`)
      top += 18 // round(14 * 1.25)
      if (g.type) {
        top += 4 // HDR_GAP_TYPE
        parts.push(`<text x="${cx}" y="${ty(top) + 10}" font-size="10" fill="#64748B" text-anchor="middle">${esc(g.type)}</text>`)
        top += 13 // round(10 * 1.3)
      }
      if (g.description) {
        top += 6 // HDR_GAP_DESC
        parts.push(`<text x="${cx}" y="${ty(top) + 12}" font-size="12" fill="#475569" text-anchor="middle">${esc(g.description)}</text>`)
      }
    } else {
      // Model-level group: title top-left, font 11, no description.
      const titleW = textWidth(g.name, 11)
      const overflows = titleW > b.width - 16
      parts.push(`<text x="${tx(b.x) + 12}" y="${ty(b.y) + 16}" font-size="11" font-weight="600" fill="${overflows ? '#DC2626' : '#475569'}">${esc(g.name)}</text>`)
    }
  }

  // Edges (faithful sampled polylines) + arrowheads + labels + source dots.
  for (const e of edges) {
    if (e.points.length < 2) continue
    const dashed = e.id.startsWith('implied:')
    const d = e.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${tx(p.x)} ${ty(p.y)}`).join(' ')
    parts.push(`<path d="${d}" fill="none" stroke="#64748B" stroke-width="1.4"${dashed ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#arrow)"/>`)
    // Source-anchor dot (the canvas always draws this, radius 3.5) — the only edge
    // "dot" visible on an unselected connection. We deliberately do NOT dot the
    // interior polyline points: those are bezier SAMPLES (perSeg≈14 per segment),
    // not real bend points, and the canvas only shows waypoint handles when a
    // connection is selected — drawing them here previously made every straight
    // edge look like it had a dozen needless waypoints.
    const src = e.points[0]
    parts.push(`<circle cx="${tx(src.x)}" cy="${ty(src.y)}" r="3.5" fill="#64748B"/>`)
    if (e.label) {
      // Draw at the de-collided label centre (faithful pathPoint(t)+normal·offset)
      // when `measureDiagram` placed one, else the raw polyline midpoint.
      const c = e.labelAt ?? e.points[Math.floor(e.points.length / 2)]
      const lbl = e.label.length > 26 ? e.label.slice(0, 25) + '…' : e.label
      parts.push(`<text x="${tx(c.x)}" y="${ty(c.y) + 3}" font-size="9" fill="#475569" text-anchor="middle">${esc(lbl)}</text>`)
    }
  }

  // Nodes.
  for (const id of diagram.objectIds) {
    const o = objById.get(id)
    const r = rectById.get(id)
    if (!o || !r) continue
    const style = TYPE_STYLE[o.type] ?? { fill: '#94A3B8', text: '#FFFFFF' }
    parts.push(`<rect x="${tx(r.x)}" y="${ty(r.y)}" width="${r.width}" height="${r.height}" rx="8" fill="${style.fill}" stroke="#0F172A" stroke-opacity="0.15"/>`)
    parts.push(`<text x="${tx(r.x) + r.width / 2}" y="${ty(r.y) + 14}" font-size="9" fill="${style.text}" fill-opacity="0.8" text-anchor="middle">«${o.type}»</text>`)
    const lines = wrap(o.name, Math.floor(r.width / 7))
    const startY = r.height / 2 + 4 - (lines.length - 1) * 7
    lines.forEach((ln, i) => {
      parts.push(`<text x="${tx(r.x) + r.width / 2}" y="${ty(r.y) + startY + i * 13}" font-size="11" font-weight="600" fill="${style.text}" text-anchor="middle">${esc(ln)}</text>`)
    })
  }

  parts.push(`</svg>`)
  return parts.join('\n')
}
