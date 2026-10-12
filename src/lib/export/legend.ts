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

import type { C4Object, C4Type, Connection, Group } from '../../types'
import type { SkinConfig } from '../../skins/types'
import { storeCapRy } from '../../canvas/engine/objectBox'
import type { MeasureFn } from './svg'
import i18n from '../i18n'

/**
 * Image-export legend: explains only what the diagram actually contains —
 * object types, external scope, group/boundary boxes and connection styles.
 * One shared model feeds two renderers: SVG markup (for the SVG export) and
 * a Canvas2D drawer (for the PNG export, where document fonts are available).
 */

export type LegendMode = 'none' | 'separate' | 'embedded'

interface LegendEntry {
  kind: 'type' | 'external' | 'group' | 'boundary' | 'line'
  type?: C4Type
  lineStyle?: Connection['type']
  lower?: boolean
  label: string
}

export interface LegendModel {
  entries: LegendEntry[]
}

// C4 object-type vocabulary — kept in English in both locales, matching the rest of the
// app (type badges, filters, etc. never translate actor/system/app/store/component).
const TYPE_LABEL: Record<C4Type, string> = {
  actor: 'Actor',
  system: 'System',
  app: 'App',
  store: 'Store',
  component: 'Component',
}

/** What this diagram uses, in a stable display order. Reads i18n.t() live (not cached at
 * module scope) so it always reflects the language active at export time. */
export function buildLegendModel(scene: {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
}): LegendModel {
  const lineLabel: Record<NonNullable<Connection['type']>, string> = {
    solid: i18n.t('exportEngine.legend.connection'),
    dashed: i18n.t('exportEngine.legend.dashedConnection'),
    dotted: i18n.t('exportEngine.legend.dottedConnection'),
  }
  const entries: LegendEntry[] = []
  const typeOrder: C4Type[] = ['actor', 'system', 'app', 'store', 'component']
  for (const t of typeOrder) {
    if (scene.objects.some((o) => o.type === t)) entries.push({ kind: 'type', type: t, label: TYPE_LABEL[t] })
  }
  if (scene.objects.some((o) => o.scope === 'external')) entries.push({ kind: 'external', label: i18n.t('exportEngine.legend.external') })
  if (scene.groups.some((g) => g.parentObjectId)) entries.push({ kind: 'boundary', label: i18n.t('exportEngine.legend.boundary') })
  if (scene.groups.some((g) => !g.parentObjectId)) entries.push({ kind: 'group', label: i18n.t('exportEngine.legend.group') })
  const lineOrder: Array<NonNullable<Connection['type']>> = ['solid', 'dashed', 'dotted']
  for (const style of lineOrder) {
    if (scene.connections.some((c) => c.type === style)) entries.push({ kind: 'line', lineStyle: style, label: lineLabel[style] })
  }
  if (scene.connections.some((c) => c.kind === 'lower')) {
    entries.push({ kind: 'line', lineStyle: 'solid', lower: true, label: i18n.t('exportEngine.legend.crossLevelConnection') })
  }
  return { entries }
}

// ── Shared layout ──────────────────────────────────────────────────────────────

const PAD = 16
const ROW_H = 26
const SWATCH_W = 34
const SWATCH_GAP = 10
const TITLE_H = 24
const LABEL_SIZE = 11
const heuristicMeasure: MeasureFn = (text, size) => text.length * size * 0.55

export function legendSize(model: LegendModel, measure: MeasureFn = heuristicMeasure): { width: number; height: number } {
  const labelW = Math.max(60, ...model.entries.map((e) => measure(e.label, LABEL_SIZE, 500)))
  return {
    width: Math.ceil(PAD + SWATCH_W + SWATCH_GAP + labelW + PAD),
    height: PAD + TITLE_H + model.entries.length * ROW_H + PAD - 6,
  }
}

// ── SVG renderer ───────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The legend as an SVG fragment positioned at (x, y). Standalone export wraps it. */
export function legendSvgFragment(
  model: LegendModel,
  skin: SkinConfig,
  x: number,
  y: number,
  measure: MeasureFn = heuristicMeasure,
): string {
  const { width, height } = legendSize(model, measure)
  const fontFamily = skin.renderStyle.fontFamily ?? 'Inter, system-ui, sans-serif'
  const label = skin.groups.label
  const parts: string[] = []
  const text = (tx: number, ty: number, t: string, size: number, weight: number, color: string, anchor = 'start') =>
    parts.push(
      `<text x="${tx}" y="${ty}" font-family="${esc(fontFamily)}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(t)}</text>`,
    )

  parts.push(`<g>`)
  parts.push(
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="${skin.connections.labelBg}" stroke="${skin.connections.labelStroke}" stroke-width="1"/>`,
  )
  text(x + PAD, y + PAD + 8, i18n.t('exportEngine.legend.title'), 10, 600, skin.groups.typeLabel)

  model.entries.forEach((e, i) => {
    const rowY = y + PAD + TITLE_H + i * ROW_H
    const cy = rowY + ROW_H / 2 - 3
    const sx = x + PAD
    if (e.kind === 'type' && e.type) {
      const os = skin.objects[e.type]
      const w = SWATCH_W
      const h = 16
      if (e.type === 'store') {
        const capRy = storeCapRy(w, h)
        const rx = w / 2
        parts.push(
          `<path d="M ${sx} ${cy - h / 2 + capRy} L ${sx} ${cy + h / 2 - capRy} A ${rx} ${capRy} 0 0 0 ${sx + w} ${cy + h / 2 - capRy} L ${sx + w} ${cy - h / 2 + capRy} A ${rx} ${capRy} 0 0 0 ${sx} ${cy - h / 2 + capRy} Z" fill="${os.fill}" stroke="${os.stroke}" stroke-width="1"/>`,
        )
      } else {
        parts.push(
          `<rect x="${sx}" y="${cy - h / 2}" width="${w}" height="${h}" rx="5" fill="${os.fill}" stroke="${os.stroke}" stroke-width="1"/>`,
        )
        parts.push(`<circle cx="${sx + w / 2}" cy="${cy}" r="4.5" fill="${os.icon}"/>`)
      }
    } else if (e.kind === 'external') {
      const os = skin.objects.system
      parts.push(
        `<rect x="${sx}" y="${cy - 8}" width="${SWATCH_W}" height="16" rx="5" fill="${os.fillExternal}" stroke="${os.stroke}" stroke-width="1"${skin.renderStyle.solidExternal ? '' : ' opacity="0.55"'}/>`,
      )
    } else if (e.kind === 'boundary') {
      parts.push(
        `<rect x="${sx}" y="${cy - 8}" width="${SWATCH_W}" height="16" rx="5" fill="${skin.groups.parentWrapperFill}" stroke="${label}" stroke-opacity="${skin.groups.standardStrokeAlpha}" stroke-width="1.2"/>`,
      )
    } else if (e.kind === 'group') {
      parts.push(
        `<rect x="${sx}" y="${cy - 8}" width="${SWATCH_W}" height="16" rx="5" fill="none" stroke="${label}" stroke-opacity="${skin.groups.standardStrokeAlpha}" stroke-width="1.2" stroke-dasharray="4 3"/>`,
      )
    } else if (e.kind === 'line') {
      const color = e.lower ? skin.connections.lower : skin.connections.normal
      const dash = e.lineStyle === 'dashed' ? ' stroke-dasharray="6 4"' : e.lineStyle === 'dotted' ? ' stroke-dasharray="2 3"' : ''
      parts.push(
        `<path d="M ${sx} ${cy} L ${sx + SWATCH_W - 7} ${cy}" fill="none" stroke="${color}" stroke-width="${skin.connections.strokeWidth}"${dash}/>`,
      )
      parts.push(
        `<path d="M ${sx + SWATCH_W} ${cy} L ${sx + SWATCH_W - 7} ${cy - 3.5} L ${sx + SWATCH_W - 7} ${cy + 3.5} Z" fill="${color}"/>`,
      )
    }
    text(sx + SWATCH_W + SWATCH_GAP, cy + 3.5, e.label, LABEL_SIZE, 500, skin.connections.labelText)
  })
  parts.push(`</g>`)
  return parts.join('\n')
}

/** Standalone legend SVG document (the "separate file" mode). */
export function renderLegendSvg(model: LegendModel, skin: SkinConfig, measure: MeasureFn = heuristicMeasure): string {
  const { width, height } = legendSize(model, measure)
  const pad = 12
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width + pad * 2}" height="${height + pad * 2}" viewBox="0 0 ${width + pad * 2} ${height + pad * 2}" role="img" aria-label="${i18n.t('exportEngine.legend.title')}">`,
    `<rect width="100%" height="100%" fill="${skin.canvas.bg}"/>`,
    legendSvgFragment(model, skin, pad, pad, measure),
    `</svg>`,
  ].join('\n')
}

// ── Canvas renderer (PNG path — document fonts are available here) ────────────

/** Draw the legend card onto a 2D context at (x, y) in CSS pixels. */
export function drawLegendCanvas(
  ctx: CanvasRenderingContext2D,
  model: LegendModel,
  skin: SkinConfig,
  x: number,
  y: number,
): { width: number; height: number } {
  const fontFamily = skin.renderStyle.fontFamily ?? 'Inter, system-ui, sans-serif'
  const measure: MeasureFn = (t, size, weight) => {
    ctx.font = `${weight} ${size}px ${fontFamily}`
    return ctx.measureText(t).width
  }
  const { width, height } = legendSize(model, measure)

  const roundRect = (rx: number, ry: number, w: number, h: number, r: number) => {
    ctx.beginPath()
    ctx.roundRect(rx, ry, w, h, r)
  }

  roundRect(x, y, width, height, 10)
  ctx.fillStyle = skin.connections.labelBg
  ctx.fill()
  ctx.strokeStyle = skin.connections.labelStroke
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `600 10px ${fontFamily}`
  ctx.fillStyle = skin.groups.typeLabel
  ctx.fillText(i18n.t('exportEngine.legend.title'), x + PAD, y + PAD + 8)

  model.entries.forEach((e, i) => {
    const rowY = y + PAD + TITLE_H + i * ROW_H
    const cy = rowY + ROW_H / 2 - 3
    const sx = x + PAD
    ctx.setLineDash([])
    if (e.kind === 'type' && e.type) {
      const os = skin.objects[e.type]
      const h = 16
      if (e.type === 'store') {
        const capRy = storeCapRy(SWATCH_W, h)
        const rx = SWATCH_W / 2
        ctx.beginPath()
        ctx.moveTo(sx, cy - h / 2 + capRy)
        ctx.lineTo(sx, cy + h / 2 - capRy)
        ctx.ellipse(sx + rx, cy + h / 2 - capRy, rx, capRy, 0, Math.PI, 0, true)
        ctx.lineTo(sx + SWATCH_W, cy - h / 2 + capRy)
        ctx.ellipse(sx + rx, cy - h / 2 + capRy, rx, capRy, 0, 0, Math.PI, true)
        ctx.closePath()
      } else {
        roundRect(sx, cy - h / 2, SWATCH_W, h, 5)
      }
      ctx.fillStyle = os.fill
      ctx.fill()
      ctx.strokeStyle = os.stroke
      ctx.stroke()
      if (e.type !== 'store') {
        ctx.beginPath()
        ctx.arc(sx + SWATCH_W / 2, cy, 4.5, 0, Math.PI * 2)
        ctx.fillStyle = os.icon
        ctx.fill()
      }
    } else if (e.kind === 'external') {
      const os = skin.objects.system
      ctx.globalAlpha = skin.renderStyle.solidExternal ? 1 : 0.55
      roundRect(sx, cy - 8, SWATCH_W, 16, 5)
      ctx.fillStyle = os.fillExternal
      ctx.fill()
      ctx.strokeStyle = os.stroke
      ctx.stroke()
      ctx.globalAlpha = 1
    } else if (e.kind === 'boundary' || e.kind === 'group') {
      if (e.kind === 'group') ctx.setLineDash([4, 3])
      roundRect(sx, cy - 8, SWATCH_W, 16, 5)
      if (e.kind === 'boundary') {
        ctx.fillStyle = skin.groups.parentWrapperFill
        ctx.fill()
      }
      ctx.globalAlpha = skin.groups.standardStrokeAlpha
      ctx.strokeStyle = skin.groups.label
      ctx.lineWidth = 1.2
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.setLineDash([])
      ctx.lineWidth = 1
    } else if (e.kind === 'line') {
      const color = e.lower ? skin.connections.lower : skin.connections.normal
      if (e.lineStyle === 'dashed') ctx.setLineDash([6, 4])
      else if (e.lineStyle === 'dotted') ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(sx, cy)
      ctx.lineTo(sx + SWATCH_W - 7, cy)
      ctx.strokeStyle = color
      ctx.lineWidth = skin.connections.strokeWidth
      ctx.stroke()
      ctx.setLineDash([])
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(sx + SWATCH_W, cy)
      ctx.lineTo(sx + SWATCH_W - 7, cy - 3.5)
      ctx.lineTo(sx + SWATCH_W - 7, cy + 3.5)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
    }
    ctx.font = `500 ${LABEL_SIZE}px ${fontFamily}`
    ctx.fillStyle = skin.connections.labelText
    ctx.fillText(e.label, sx + SWATCH_W + SWATCH_GAP, cy + 3.5)
  })

  return { width, height }
}
