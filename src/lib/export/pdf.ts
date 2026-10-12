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

import { TYPE_LABEL, type SummaryModel } from './summary'
import i18n from '../i18n'

/**
 * A dependency-free PDF 1.4 writer for the text summary export. Base-14
 * Helvetica (no font embedding), WinAnsi text, real line wrapping and page
 * breaks — small, valid files every PDF reader opens.
 */

export type PdfOrientation = 'portrait' | 'landscape'

/** A pre-encoded raster for embedding: zlib-deflated raw RGB (FlateDecode,
 * lossless — preferred) or JPEG bytes (DCTDecode fallback). */
export interface PdfImage {
  data: Uint8Array
  width: number
  height: number
  filter: 'FlateDecode' | 'DCTDecode'
}

interface Block {
  style: 'h1' | 'meta' | 'h2' | 'h3' | 'p' | 'li' | 'step'
  text: string
  /** Numbered position for `step` blocks. */
  n?: number
}

// Standard Helvetica AFM widths for chars 32..126 (thousandths of the font size).
// prettier-ignore
const HELV_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]

function textWidth(s: string, size: number, bold: boolean): number {
  let w = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    w += c >= 32 && c <= 126 ? HELV_WIDTHS[c - 32] : 556
  }
  return (w / 1000) * size * (bold ? 1.05 : 1)
}

// Unicode → WinAnsi bytes the base fonts can show; everything else degrades to
// a readable ASCII stand-in rather than a broken glyph.
const WINANSI: Record<number, number | string> = {
  0x2018: 145, 0x2019: 146, 0x201c: 147, 0x201d: 148, 0x2022: 149, 0x2013: 150,
  0x2014: 151, 0x2026: 133, 0x2039: 139, 0x203a: 155, 0x0152: 140, 0x0153: 156,
  0x20ac: 128, 0x2122: 153, 0x2192: '->', 0x2190: '<-', 0x2194: '<->',
}

function toWinAnsi(s: string): number[] {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c === 10 || c === 13) continue
    if (c >= 32 && c <= 255) out.push(c)
    else {
      const m = WINANSI[c]
      if (typeof m === 'number') out.push(m)
      else if (typeof m === 'string') for (const r of m) out.push(r.charCodeAt(0))
      else out.push(63) // '?'
    }
  }
  return out
}

function escapePdfBytes(bytes: number[]): string {
  let out = ''
  for (const b of bytes) {
    if (b === 40 || b === 41 || b === 92) out += '\\' + String.fromCharCode(b)
    else if (b >= 32 && b <= 126) out += String.fromCharCode(b)
    else out += '\\' + b.toString(8).padStart(3, '0')
  }
  return out
}

const STYLES: Record<Block['style'], { size: number; bold: boolean; before: number; after: number; gray?: number; indent: number }> = {
  h1: { size: 17, bold: true, before: 0, after: 6, indent: 0 },
  meta: { size: 9, bold: false, before: 0, after: 14, gray: 0.42, indent: 0 },
  h2: { size: 12.5, bold: true, before: 14, after: 5, indent: 0 },
  h3: { size: 10.5, bold: true, before: 9, after: 3, indent: 0 },
  p: { size: 9.5, bold: false, before: 0, after: 3, indent: 0 },
  li: { size: 9.5, bold: false, before: 0, after: 2.5, indent: 14 },
  step: { size: 9.5, bold: false, before: 0, after: 2.5, indent: 14 },
}

function wrap(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const candidate = cur ? cur + ' ' + w : w
    if (textWidth(candidate, size, bold) > maxWidth && cur) {
      lines.push(cur)
      cur = w
    } else cur = candidate
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : ['']
}

function summaryBlocks(m: SummaryModel): Block[] {
  const blocks: Block[] = []
  blocks.push({ style: 'h1', text: m.title })
  blocks.push({
    style: 'meta',
    text: i18n.t('exportEngine.meta.htmlOrPdf', {
      scope: m.scopeLabel,
      objects: m.counts.objects,
      connections: m.counts.connections,
      flows: m.counts.flows,
      date: m.generatedAt.slice(0, 10),
    }),
  })
  if (m.domains.length) {
    blocks.push({ style: 'h2', text: i18n.t('exportEngine.sections.domains') })
    for (const d of m.domains)
      blocks.push({
        style: 'li',
        text: `${d.name} (${i18n.t('exportEngine.objectCount', { count: d.objectCount })})${d.description ? ` — ${d.description}` : ''}`,
      })
  }
  blocks.push({ style: 'h2', text: i18n.t('exportEngine.sections.modelObjects') })
  for (const g of m.objectGroups) {
    blocks.push({ style: 'h3', text: TYPE_LABEL[g.type] })
    for (const o of g.objects) {
      const bits: string[] = []
      if (o.external) bits.push(i18n.t('exportEngine.describe.external'))
      if (o.status !== 'live') bits.push(o.status)
      if (o.technology) bits.push(o.technology)
      if (o.domain) bits.push(i18n.t('exportEngine.describe.domain', { name: o.domain }))
      if (o.tags.length) bits.push(i18n.t('exportEngine.describe.tags', { names: o.tags.join(', ') }))
      blocks.push({
        style: 'li',
        text: `${o.name}${bits.length ? ` (${bits.join(' · ')})` : ''}${o.description ? ` — ${o.description}` : ''}`,
      })
    }
  }
  if (m.connections.length) {
    blocks.push({ style: 'h2', text: i18n.t('exportEngine.sections.connections') })
    for (const c of m.connections)
      blocks.push({
        style: 'li',
        text: `${c.from} → ${c.to}${c.label ? `: ${c.label}` : ''}${c.status !== 'live' ? ` (${c.status})` : ''}`,
      })
  }
  if (m.flows.length) {
    blocks.push({ style: 'h2', text: i18n.t('exportEngine.sections.flows') })
    for (const f of m.flows) {
      blocks.push({ style: 'h3', text: f.diagram ? `${f.name} (${f.diagram})` : f.name })
      f.steps.forEach((s, i) => blocks.push({ style: 'step', text: s, n: i + 1 }))
    }
  }
  if (m.tags.length) {
    blocks.push({ style: 'h2', text: i18n.t('exportEngine.sections.tags') })
    for (const t of m.tags)
      blocks.push({ style: 'li', text: `${t.name} (${i18n.t('exportEngine.objectCount', { count: t.count })})` })
  }
  return blocks
}

/** Lay blocks onto pages and serialise the PDF. With `image`, the diagram
 * raster is drawn full-width right after the meta line. */
export function buildSummaryPdf(m: SummaryModel, orientation: PdfOrientation, image?: PdfImage | null): Uint8Array {
  const [pageW, pageH] = orientation === 'landscape' ? [792, 612] : [612, 792]
  const margin = 56
  const maxWidth = pageW - margin * 2

  // Per-page content streams.
  const pages: string[] = []
  let ops: string[] = []
  let y = pageH - margin

  const flushPage = () => {
    pages.push(ops.join('\n'))
    ops = []
    y = pageH - margin
  }

  /** Draw the diagram scaled to the text column, capped to ~60% of page height. */
  const emitImage = (img: PdfImage) => {
    const maxH = pageH * 0.6
    const s = Math.min(maxWidth / img.width, maxH / img.height)
    const w = img.width * s
    const h = img.height * s
    if (y - h < margin && ops.length) flushPage()
    y -= h
    ops.push(`q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${margin} ${y.toFixed(1)} cm /Im1 Do Q`)
    y -= 14
  }

  for (const b of summaryBlocks(m)) {
    const st = STYLES[b.style]
    const lineH = st.size * 1.38
    const bulletPrefix = b.style === 'li' ? '•  ' : b.style === 'step' ? `${b.n}.  ` : ''
    const lines = wrap(b.text, st.size, st.bold, maxWidth - st.indent - textWidth(bulletPrefix, st.size, false))
    const blockH = st.before + lines.length * lineH
    if (y - blockH < margin && ops.length) flushPage()
    y -= st.before
    lines.forEach((line, i) => {
      y -= lineH
      if (y < margin - lineH) return
      const gray = st.gray ?? 0
      const text = i === 0 ? bulletPrefix + line : line
      const x = margin + st.indent + (i > 0 ? textWidth(bulletPrefix, st.size, false) : 0)
      ops.push(
        `BT /${st.bold ? 'F2' : 'F1'} ${st.size} Tf ${gray ? `${gray} ${gray} ${gray} rg` : '0.12 0.11 0.11 rg'} 1 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)} Tm (${escapePdfBytes(toWinAnsi(text))}) Tj ET`,
      )
    })
    y -= st.after
    if (b.style === 'meta' && image) emitImage(image)
  }
  if (ops.length || pages.length === 0) flushPage()

  // Object graph: 1 catalog, 2 pages tree, 3 F1, 4 F2, [5 image], then per
  // page: page obj + stream obj.
  const objects: string[] = []
  const firstPageId = image ? 6 : 5
  const pageObjIds = pages.map((_, i) => firstPageId + i * 2)
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`)
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj`)
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj`)
  objects.push(`4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj`)
  if (image) {
    let bytes = ''
    for (let i = 0; i < image.data.length; i++) bytes += String.fromCharCode(image.data[i])
    objects.push(
      `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${image.filter} /Length ${image.data.length} >>\nstream\n${bytes}\nendstream\nendobj`,
    )
  }
  const resources = `<< /Font << /F1 3 0 R /F2 4 0 R >>${image ? ' /XObject << /Im1 5 0 R >>' : ''} >>`
  pages.forEach((content, i) => {
    const pageId = firstPageId + i * 2
    const streamId = pageId + 1
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources ${resources} /Contents ${streamId} 0 R >>\nendobj`,
    )
    objects.push(`${streamId} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj`)
  })

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const obj of objects) {
    offsets.push(pdf.length)
    pdf += obj + '\n'
  }
  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += `${off.toString().padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  // Latin-1 serialise: every char is already ≤ 255 (WinAnsi-encoded above).
  const bytes = new Uint8Array(pdf.length)
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff
  return bytes
}
